/**
 * Trace store primitives: the one writable-path resolver and the one lock
 * (WP-203, Dashboard Design §3.8).
 *
 * Everything that mutates `<install home>/traces` goes through this module:
 * the append here, and deletion and reassignment in `trace-store-rewrite.ts`,
 * which is built on the primitives below. That is not a style preference — it
 * is the containment boundary. A caller that builds a path itself bypasses the
 * symlink check, and a caller that writes without the lock can interleave with
 * a delete and lose a record.
 *
 * Two mechanisms, and the reason each exists:
 *
 * 1. **No-follow path guard.** Checking that a resolved path starts with the
 *    store directory is NOT enough: if `traces/<workspaceId>` is a symlink to
 *    somewhere else, the prefix still matches and the write lands outside the
 *    store. So every existing component from the install home down is `lstat`ed
 *    and any symlink is refused, and the final open uses `O_NOFOLLOW`. The
 *    walk, the modes, the `O_NOFOLLOW` opens and the atomic rewrite are
 *    `data-files.ts`'s, shared by every store in the data folder (code review
 *    2026-09-30 §3.1); this module applies them with its own code,
 *    `E_TRACE_STORE_UNWRITABLE`.
 * 2. **In-process mutex keyed by workspace id.** The collector and every RPC
 *    handler run in the same forked plugin-server worker, so a file lock would
 *    be pointless ceremony; one async mutex per workspace is exactly enough.
 *    Reads deliberately do not take it — the store is one record per line, so a
 *    reader can tolerate a half-written trailing line (it is skipped).
 *
 * The only other process that can touch the store is the `paseo-bm` CLI during
 * uninstall, and that is handled by ordering rather than locking: uninstall
 * stops the plugin (`paseo plugin remove`) before it touches `traces/`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DashboardError,
  TRACE_STORE_SCHEMA_VERSION,
  traceRecordSchema,
  traceStoreMetaSchema,
  traceWorkspaceMetaSchema,
  type StoreSize,
  type TraceMessage,
  type TraceRecord,
  type TraceStoreMeta,
  type TraceWorkspaceMeta,
  type WorkspaceState,
  type DashboardErrorCode,
} from "../shared/contracts";
import {
  DATA_DIR_MODE,
  DATA_FILE_MODE,
  appendToFile,
  assertNoSymlink,
  makeDataDir,
  writeFileAtomically,
} from "./data-files";

/** Workspace ids are used as directory names, so they are restricted (design §3.8). */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** How long a mutation waits for the workspace lock before giving up (design §3.8). */
export const LOCK_WAIT_TIMEOUT_MS = 5_000;

/** Directory and file modes of the store (REQ-048c): the data folder's (`data-files.ts`). */
export const STORE_DIR_MODE = DATA_DIR_MODE;
export const STORE_FILE_MODE = DATA_FILE_MODE;

/** The code of every failure to write the store (design §3.8). */
const UNWRITABLE: DashboardErrorCode = "E_TRACE_STORE_UNWRITABLE";

/** A failure to write the store, with its code (design §3.8). */
export function unwritable(detail: string, cause?: unknown): DashboardError {
  return new DashboardError(UNWRITABLE, detail, cause ? { cause } : undefined);
}

/** The data folder `tracesDir` sits in (design §5.1): the root of every symlink check. */
export function dataFolderOf(tracesDir: string): string {
  return dirname(resolve(tracesDir));
}

/**
 * Rejects a workspace id that cannot be used as a directory name.
 *
 * `.` and `..` match the character class but would escape or alias the store,
 * so they are excluded explicitly.
 */
export function assertWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw unwritable(`workspace id is not usable as a store directory: ${JSON.stringify(workspaceId)}`);
  }
  if (workspaceId === "." || workspaceId === "..") {
    throw unwritable(`workspace id is not usable as a store directory: ${JSON.stringify(workspaceId)}`);
  }
}

/**
 * Refuses any symlink from `root` (included) down to `target`, without
 * following one: `data-files.ts` `assertNoSymlink` with this store's code.
 * Components that do not exist yet are fine: nothing below them exists either.
 */
export function assertNoSymlinkOnPath(root: string, target: string): void {
  assertNoSymlink(root, target, UNWRITABLE);
}

/**
 * Turns store-relative segments into an absolute path, applying every rule of
 * design §3.8 in order: id shape, prefix containment, then no-follow.
 *
 * `tracesDir` comes from WP-202's resolver; this module never guesses it.
 */
export function storePath(tracesDir: string, workspaceId: string, ...segments: string[]): string {
  if (!isAbsolute(tracesDir)) {
    throw unwritable(`trace store directory must be absolute: ${tracesDir}`);
  }
  assertWorkspaceId(workspaceId);
  for (const segment of segments) {
    if (segment.includes("/") || segment.includes("\\") || segment === "" || segment === "." || segment === "..") {
      throw unwritable(`unsafe trace store path segment: ${JSON.stringify(segment)}`);
    }
  }

  const root = resolve(tracesDir);
  const target = resolve(join(root, workspaceId, ...segments));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw unwritable(`path escapes the trace store: ${target}`);
  }
  assertNoSymlink(dataFolderOf(tracesDir), target, UNWRITABLE);
  return target;
}

/**
 * Creates a store directory with mode 0700, checking for symlinks before and
 * after (`data-files.ts` `makeDataDir`). The second check closes the window
 * where a component appears between the check and the `mkdir`.
 */
export function ensureStoreDir(tracesDir: string, directory: string): void {
  makeDataDir(dataFolderOf(tracesDir), directory, UNWRITABLE);
}

/**
 * Thrown when a mutation could not get the workspace lock in time.
 *
 * A distinct class so the collector can tell "busy" from "broken": on this one
 * it drops the turn and logs a line, because a trace is never worth stalling an
 * agent for (REQ-053c).
 */
export class TraceStoreLockTimeout extends DashboardError {
  constructor(workspaceId: string, timeoutMs: number) {
    super(
      "E_TRACE_STORE_UNWRITABLE",
      `timed out after ${timeoutMs} ms waiting for the trace store lock of workspace ${workspaceId}`,
    );
    this.name = "TraceStoreLockTimeout";
  }
}

/** One promise chain per workspace id. Empty between mutations. */
const lockTails = new Map<string, Promise<unknown>>();

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Runs `fn` with the workspace's mutation lock held.
 *
 * Mutations of the same workspace never interleave; different workspaces are
 * independent. A waiter that times out releases its slot, so the queue keeps
 * moving and the lock is never left held.
 */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  fn: () => T | Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  assertWorkspaceId(workspaceId);
  const timeoutMs = options.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;

  const previous = lockTails.get(workspaceId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => {
    release = resolveHeld;
  });
  const tail = settled(previous).then(() => held);
  lockTails.set(workspaceId, tail);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveWait, rejectWait) => {
      let finished = false;
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        rejectWait(new TraceStoreLockTimeout(workspaceId, timeoutMs));
      }, timeoutMs);
      void settled(previous).then(() => {
        if (finished) return;
        finished = true;
        resolveWait();
      });
    });
  } catch (error) {
    // Never acquired: hand the slot to the next waiter so the queue drains.
    release();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  try {
    return await fn();
  } finally {
    release();
    // Drop the entry when nobody queued behind us, so the map cannot grow
    // once for every workspace the machine has ever seen.
    if (lockTails.get(workspaceId) === tail) lockTails.delete(workspaceId);
  }
}

/** Number of workspaces with a live lock chain. Test-only observability. */
export function activeLockCount(): number {
  return lockTails.size;
}

// ---------------------------------------------------------------------------
// Store operations (WP-203 part 2, Dashboard Design §3.2, §3.3, §3.4, §3.6).
//
// Built only on the primitives above: no other path construction, no other
// mutation path. Append is the normal write; the rewrites — deletion and
// reassignment, which WP-210 owns — are in `trace-store-rewrite.ts`.
// ---------------------------------------------------------------------------

/** Longest single message text kept in a record (design §3.3). */
export const MAX_MESSAGE_CHARS = 8 * 1024;

/** Longest whole record kept; a record over this has its texts shrunk, never dropped. */
export const MAX_RECORD_CHARS = 32 * 1024;

/** Marker appended to any text the store had to cut. */
export const TRUNCATION_MARKER = "...[truncated]";

/** Name of the monthly file a timestamp belongs to (design §3.2). */
export function monthlyFileName(at: string): string {
  const date = new Date(at);
  const stamp = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const year = stamp.getUTCFullYear().toString().padStart(4, "0");
  const month = (stamp.getUTCMonth() + 1).toString().padStart(2, "0");
  return `events-${year}${month}.jsonl`;
}

/** Cuts a text to the cap and says so, instead of silently shortening it. */
export function capText(
  text: string,
  limit: number = MAX_MESSAGE_CHARS,
): { text: string; truncated: boolean } {
  if (typeof text !== "string") return { text: "", truncated: false };
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}${TRUNCATION_MARKER}`, truncated: true };
}

function capMessages(messages: readonly TraceMessage[], limit = MAX_MESSAGE_CHARS): TraceMessage[] {
  return messages.map((message) => {
    const capped = capText(message.text, limit);
    return { ...message, text: capped.text, truncated: message.truncated || capped.truncated };
  });
}

/**
 * Applies the design's text caps before a record is written.
 *
 * Over the record cap it shrinks message bodies rather than dropping messages:
 * losing a message loses a timestamp and a data point, while losing some text
 * only loses detail the UI already truncates.
 */
export function capRecord(record: TraceRecord): TraceRecord {
  const capped: TraceRecord = {
    ...record,
    sent: capMessages(record.sent),
    received: capMessages(record.received),
  };
  if (JSON.stringify(capped).length <= MAX_RECORD_CHARS) return capped;
  return { ...capped, sent: capMessages(capped.sent, 512), received: capMessages(capped.received, 512) };
}

export interface TraceStoreLocation {
  /** `<data folder>/traces`, from `resolveDataHome` (design §5.1). */
  tracesDir: string;
}

/** What a read returned, plus what it had to skip. */
export interface ReadRecordsResult {
  records: TraceRecord[];
  skippedLines: number;
  notices: string[];
  /** True when the store holds a schema this build only partly understands. */
  limitedRead: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  records: TraceRecord[];
  skippedLines: number;
}

/** Per-file read cache keyed by absolute path, invalidated by mtime+size (design §3.4). */
const readCache = new Map<string, CacheEntry>();

/** Drops the read cache. Used by tests and after a destructive operation. */
export function clearTraceStoreCache(): void {
  readCache.clear();
}

/** Drops one file's cached read: after that file was rewritten or removed. */
export function forgetCachedFile(path: string): void {
  readCache.delete(path);
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Reads `<traces>/meta.json`, creating nothing.
 *
 * A store whose `schemaVersion` is higher than this build understands is
 * readable but must never be written (design §3.2): a newer paseo-bm owns that
 * directory, and rewriting its records would destroy data this build cannot
 * even represent.
 */
export function readStoreMeta(location: TraceStoreLocation): {
  meta: TraceStoreMeta | null;
  tooNew: boolean;
} {
  const path = join(resolve(location.tracesDir), "meta.json");
  const parsed = readJsonFile(path);
  if (parsed === null) return { meta: null, tooNew: false };
  const result = traceStoreMetaSchema.safeParse(parsed);
  if (!result.success) return { meta: null, tooNew: false };
  return { meta: result.data, tooNew: result.data.schemaVersion > TRACE_STORE_SCHEMA_VERSION };
}

/** Throws when the store belongs to a newer paseo-bm (design §3.2). */
export function assertWritableSchema(location: TraceStoreLocation): void {
  const { meta, tooNew } = readStoreMeta(location);
  if (tooNew && meta !== null) {
    throw new DashboardError(
      "E_TRACE_STORE_SCHEMA_TOO_NEW",
      `the trace store at ${location.tracesDir} uses schemaVersion ${meta.schemaVersion}, newer than this plugin understands (${TRACE_STORE_SCHEMA_VERSION}); reading only`,
    );
  }
}

/**
 * Temp-then-rename write, used for both `meta.json` files and later rewrites
 * (`data-files.ts` `writeFileAtomically`, rooted at the data folder).
 */
export function writeStoreFileAtomically(
  location: TraceStoreLocation,
  path: string,
  body: string,
): void {
  writeFileAtomically(dataFolderOf(location.tracesDir), path, body, UNWRITABLE);
}

/** Creates the store skeleton and stamps the schema version. Idempotent. */
export function ensureStore(location: TraceStoreLocation): void {
  const root = resolve(location.tracesDir);
  ensureStoreDir(location.tracesDir, root);
  const { meta, tooNew } = readStoreMeta(location);
  if (tooNew) return;
  if (meta === null) {
    const now = new Date().toISOString();
    const body = JSON.stringify({
      schemaVersion: TRACE_STORE_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    });
    writeStoreFileAtomically(location, join(root, "meta.json"), `${body}\n`);
  }
}

/**
 * Records the workspace's last known name and path, so a workspace that later
 * disappears from Paseo is still recognisable to a person (REQ-057a).
 *
 * Only writes when something changed: this runs on every collected turn.
 */
export function writeWorkspaceMeta(
  location: TraceStoreLocation,
  workspaceId: string,
  meta: TraceWorkspaceMeta,
): void {
  const path = storePath(location.tracesDir, workspaceId, "meta.json");
  ensureStoreDir(location.tracesDir, dirname(path));
  const existing = traceWorkspaceMetaSchema.safeParse(readJsonFile(path));
  // Skip only when the file already says exactly this. The earlier guard
  // compared the name and directory alone, so `lastSeenAt` froze at the first
  // turn: after the WP-214 acceptance run it read 06:42 for a workspace that
  // stayed busy until 07:35. A field called `lastSeenAt` has to mean it, and
  // this write is one small atomic file beside an append that already happens
  // on every turn.
  if (
    existing.success &&
    existing.data.lastKnownName === meta.lastKnownName &&
    existing.data.lastKnownDirectory === meta.lastKnownDirectory &&
    existing.data.lastSeenAt === meta.lastSeenAt
  ) {
    return;
  }
  writeStoreFileAtomically(location, path, `${JSON.stringify(meta)}\n`);
}

/** Reads a workspace's `meta.json`, or null when it has none. */
export function readWorkspaceMeta(
  location: TraceStoreLocation,
  workspaceId: string,
): TraceWorkspaceMeta | null {
  const path = storePath(location.tracesDir, workspaceId, "meta.json");
  const parsed = traceWorkspaceMetaSchema.safeParse(readJsonFile(path));
  return parsed.success ? parsed.data : null;
}

/**
 * Appends one record, under the workspace lock.
 *
 * One `write` of one newline-terminated line, then `fsync`: a reader that meets
 * a half-written final line (process killed mid-write) skips exactly that line
 * and keeps every completed line before it.
 */
export async function appendRecord(
  location: TraceStoreLocation,
  record: TraceRecord,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const line = `${JSON.stringify(capRecord(record))}\n`;
  await withWorkspaceLock(
    record.workspaceId,
    () => {
      assertWritableSchema(location);
      ensureStore(location);
      const path = storePath(location.tracesDir, record.workspaceId, monthlyFileName(record.at));
      ensureStoreDir(location.tracesDir, dirname(path));
      appendToFile(path, line, UNWRITABLE);
      readCache.delete(path);
    },
    options,
  );
}

/** Monthly files of a workspace, newest first (design §3.4). */
export function monthlyFiles(location: TraceStoreLocation, workspaceId: string): string[] {
  const dir = dirname(storePath(location.tracesDir, workspaceId, "meta.json"));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^events-\d{6}\.jsonl$/.test(name))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

function readMonthlyFile(path: string): { records: TraceRecord[]; skippedLines: number } {
  let stats: { mtimeMs: number; size: number };
  try {
    const stat = statSync(path);
    stats = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { records: [], skippedLines: 0 };
  }
  const cached = readCache.get(path);
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return { records: cached.records, skippedLines: cached.skippedLines };
  }

  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { records: [], skippedLines: 0 };
  }

  const records: TraceRecord[] = [];
  let skippedLines = 0;
  const lines = body.split("\n");
  for (const [index, line] of lines.entries()) {
    // A trailing newline leaves a final "" that is not a record. A blank line
    // anywhere else, or a line that will not parse, is counted as skipped.
    if (line === "") {
      if (index !== lines.length - 1) skippedLines += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skippedLines += 1;
      continue;
    }
    const result = traceRecordSchema.safeParse(parsed);
    if (!result.success) {
      skippedLines += 1;
      continue;
    }
    records.push(result.data);
  }

  readCache.set(path, { ...stats, records, skippedLines });
  return { records, skippedLines };
}

/**
 * Fingerprint of what a turn actually said: the text of `sent` then `received`,
 * in order. `null` when the record carries no message at all.
 *
 * Content, not time, because a rewrite must fingerprint the same. The collector
 * stamps every message with the WRITE time whenever its `refetch` fails
 * (`collector.ts` `buildRecord`: `endedAt = now()`), so two writes of one turn
 * can carry different times while carrying the same words — delta 20260917d §4
 * B, which is why the first draft of this key was rejected.
 */
function turnFingerprint(record: TraceRecord): string | null {
  const messages = [...record.sent, ...record.received];
  if (messages.length === 0) return null;
  // Length-prefixed so two messages cannot be re-split into a different pair.
  const joined = messages.map((message) => `${message.text.length}:${message.text}`).join("");
  return createHash("sha1").update(joined).digest("hex").slice(0, 16);
}

/**
 * Keeps one record per `(agentId, turnId, turn fingerprint)`: the one with the
 * latest `at`.
 *
 * The collector hook can run again after a plugin reload, so the same turn can
 * legitimately be written twice; the store tolerates that rather than trying to
 * prevent it (design §3.3). The fingerprint is there because Paseo REUSES turn
 * ids inside one agent (delta 20260917d §5: `foreground-turn-1…3` twice in one
 * Manager, eight minutes apart). Keyed on `(agentId, turnId)` alone, the reader
 * dropped the owner's opening question and a Worker turn of 12,476 output
 * tokens. Records with no turn id cannot be keyed and are all kept.
 */
export function dedupeRecords(records: readonly TraceRecord[]): TraceRecord[] {
  const best = new Map<string, TraceRecord>();
  const keyless: TraceRecord[] = [];
  for (const record of records) {
    if (record.turnId === null) {
      keyless.push(record);
      continue;
    }
    const fingerprint = turnFingerprint(record);
    const key = `${record.agentId}::${record.turnId}::${fingerprint ?? ""}`;
    const current = best.get(key);
    if (current === undefined || record.at >= current.at) best.set(key, record);
  }
  return [...best.values(), ...keyless].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Reads a workspace's records newest-file-first, stopping once `maxRecords` is
 * reached. Takes no lock: line-oriented data plus the skip rule above make a
 * concurrent append harmless.
 */
export function readRecords(
  location: TraceStoreLocation,
  workspaceId: string,
  options: { maxRecords?: number } = {},
): ReadRecordsResult {
  const { meta, tooNew } = readStoreMeta(location);
  const notices: string[] = [];
  if (tooNew && meta !== null) {
    notices.push(
      `Trace store schemaVersion ${meta.schemaVersion} is newer than this plugin understands (${TRACE_STORE_SCHEMA_VERSION}); showing what could be read and writing nothing.`,
    );
  }

  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
  const collected: TraceRecord[] = [];
  let skippedLines = 0;
  for (const path of monthlyFiles(location, workspaceId)) {
    const page = readMonthlyFile(path);
    skippedLines += page.skippedLines;
    collected.push(...page.records);
    if (collected.length >= maxRecords) break;
  }
  if (skippedLines > 0) {
    notices.push(`Skipped ${skippedLines} unreadable line(s) in the trace store.`);
  }
  return { records: dedupeRecords(collected), skippedLines, notices, limitedRead: tooNew };
}

/**
 * Byte size of the store, measured with `stat` only (design §3.6). It never
 * reads content: the client shows bytes, and counts come from the delete
 * preview, which counts exactly what it would delete.
 */
export function measureStore(location: TraceStoreLocation, workspaceId?: string): StoreSize {
  const root = resolve(location.tracesDir);
  let bytes = 0;
  let workspaceBytes = 0;

  let workspaceDirs: string[] = [];
  try {
    workspaceDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    workspaceDirs = [];
  }

  for (const id of workspaceDirs) {
    const dir = join(root, id);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      let size = 0;
      try {
        size = statSync(join(dir, name)).size;
      } catch {
        continue;
      }
      bytes += size;
      if (id === workspaceId) workspaceBytes += size;
    }
  }

  try {
    bytes += statSync(join(root, "meta.json")).size;
  } catch {
    // No store metadata yet: nothing to add.
  }

  return { bytes, workspaceBytes };
}

/**
 * How many traces a set of records makes, for every user-facing count.
 *
 * Requests, not turns. Keying an unlabelled record by its turn id made one
 * request look like six in the WP-214 acceptance run, and later made a
 * five-request workspace read "102 traces" in the reassign confirmation. An
 * agent that never reports a request id is counted once, by agent; a Manager
 * turn without an id belongs to a request and adds nothing.
 */
export function countTraces(records: readonly TraceRecord[]): number {
  const requestIds = new Set(records.map((record) => record.requestId).filter((id): id is string => id !== null));
  const agentsWithRequest = new Set(
    records.filter((record) => record.requestId !== null).map((record) => record.agentId),
  );
  const orphanAgents = new Set(
    records
      .filter((record) => record.requestId === null && record.role !== "manager" && !agentsWithRequest.has(record.agentId))
      .map((record) => record.agentId),
  );
  return requestIds.size + orphanAgents.size;
}

/** Identity of one stored record, used to delete exactly what a trace shows. */
export function recordKeyOf(record: TraceRecord): string {
  return `${record.agentId}|${record.turnId ?? ""}|${record.at}`;
}
// ---------------------------------------------------------------------------
// Workspace classification (WP-210, Dashboard Design §3.7).
//
// A workspace the user removed from Paseo must not take its history with it,
// and it must not be guessed back onto a new workspace either. So the store
// reports what it sees, and only a user action moves anything (REQ-057f;
// reassignment is in `trace-store-rewrite.ts`).
// ---------------------------------------------------------------------------

/** Workspace ids that have a directory in the store. */
export function storedWorkspaceIds(location: TraceStoreLocation): string[] {
  try {
    return readdirSync(resolve(location.tracesDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => WORKSPACE_ID_PATTERN.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** What Paseo currently says about a workspace, as far as the store can tell. */
export interface WorkspaceClassification {
  workspaceId: string;
  state: WorkspaceState;
  lastKnownName: string | null;
  lastKnownDirectory: string | null;
}

/**
 * Sorts stored workspaces into live / archived / orphaned.
 *
 * `listed === null` means the workspace list could not be read; everything is
 * then `unknown`. Turning one failed call into "this workspace is gone" would
 * tell the user their history is orphaned every time the daemon hiccups
 * (REQ-057a).
 */
export function classifyWorkspaces(
  location: TraceStoreLocation,
  listed: ReadonlyArray<{ id: string; archived: boolean }> | null,
): WorkspaceClassification[] {
  const byId = new Map(listed?.map((entry) => [entry.id, entry]) ?? []);
  return storedWorkspaceIds(location).map((workspaceId) => {
    const meta = readWorkspaceMeta(location, workspaceId);
    const entry = byId.get(workspaceId);
    const state: WorkspaceState =
      listed === null
        ? "unknown"
        : entry === undefined
          ? "orphaned"
          : entry.archived
            ? "archived"
            : "live";
    return {
      workspaceId,
      state,
      lastKnownName: meta?.lastKnownName ?? null,
      lastKnownDirectory: meta?.lastKnownDirectory ?? null,
    };
  });
}
