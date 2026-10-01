/**
 * The decision store (autonomy design §A.4, ADR-017):
 * `<data folder>/decisions/<workspaceId>.json` = `{ version: 1, entries }`.
 *
 * The one module that reads and writes that folder. The containment rules are
 * every store's (`data-files.ts` `createJsonFileStore`, code review 2026-09-30
 * §3.1): the folder is created `0700` only by a write, never by a read; files
 * are `0600` and replaced atomically (temp file, then rename); a symlink
 * anywhere below the data folder is refused (`E_TRACE_STORE_UNWRITABLE`, as a
 * failed write).
 *
 * **No lock, on purpose, as in `orchestrator-store.ts`:** every operation here
 * is synchronous and the plugin server is one thread, so a read-modify-write
 * of one workspace's file cannot interleave with another. Keep it that way —
 * an `await` inside a mutation would need `withWorkspaceLock`.
 *
 * Reads never repair a file. A missing or corrupt file reads as empty; an entry
 * that does not validate is skipped on its own and dropped by the next write. A
 * file whose `version` is newer than this build reads as empty and is never
 * written: a newer paseo-bm owns it, and a write throws `E_DECISION_WRITE_FAILED`.
 *
 * Open decisions are never evicted; of the settled ones the 500 newest (by
 * `settledAt`) are kept per workspace. Reads across workspaces go through a
 * per-file cache keyed by mtime and size, refreshed by every write from here.
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DashboardError, type DashboardErrorCode } from "../shared/contracts";
import {
  decisionSchema,
  isSettledStatus,
  supersedeDecision,
  type Decision,
  type DecisionStatus,
  type TransitionRefusal,
  type TransitionResult,
} from "../shared/decisions";
import { assertNoSymlink, capBy, createJsonFileStore, type JsonFileStore } from "./data-files";
import { WORKSPACE_ID_PATTERN, assertWorkspaceId } from "./trace-store";
import { timeOrZero } from "../shared/time";

/** The folder inside the data folder; cleanup deletes it whole. */
export const DECISIONS_DIR_NAME = "decisions";
/** The file format this build reads and writes. */
export const DECISIONS_FILE_VERSION = 1;
/** Settled decisions kept per workspace; open ones are never evicted (§A.4). */
export const DECISION_SETTLED_LIMIT = 500;

export interface DecisionStoreDeps {
  /** Where a skipped file is reported; `console.warn` by default. */
  log?: (message: string) => void;
}

/** What a list reads: one workspace's or every workspace's decisions, optionally only some. */
export interface DecisionFilter {
  workspaceId?: string;
  requestId?: string;
  statuses?: readonly DecisionStatus[];
}

export interface WorkspaceDecisions {
  entries: Decision[];
  /** Entries that did not validate and were skipped. */
  skipped: number;
}

export interface OpenDecisionResult {
  /** The decision as stored: the new one, or the one already stored under that id. */
  decision: Decision;
  /** False when a decision with this id was already stored (materialising the same turn twice). */
  created: boolean;
  /** The unsettled decision named by `supersedes` that this one replaced, now `superseded`; else null. */
  superseded: Decision | null;
}

export type DecisionMutation =
  | { status: "updated"; decision: Decision; previous: Decision }
  | { status: "not-found" }
  /** The transition refused; nothing was written. */
  | { status: "refused"; decision: Decision; refusal: TransitionRefusal; message: string };

export interface DecisionStore {
  /** `<data folder>/decisions`. */
  readonly dir: string;
  /** Workspace ids that have a decisions file, sorted. */
  workspaceIds(): string[];
  /** One workspace's decisions in file order. */
  read(workspaceId: string): WorkspaceDecisions;
  /** Decisions of one workspace or of all of them, in file order per workspace. */
  list(filter?: DecisionFilter): Decision[];
  /** The decision with this id; every workspace is searched unless one is named. */
  get(id: string, workspaceId?: string): Decision | null;
  /**
   * Stores a new decision, idempotently by id: an id already stored returns
   * the stored decision unchanged (`created: false`). With `supersedes`
   * naming an unsettled decision of the same workspace, that one becomes
   * `superseded` in the same write. Throws on a decision that does not validate.
   */
  open(decision: Decision): OpenDecisionResult;
  /** Applies a pure transition to one decision and writes the result; a refusal writes nothing. */
  transition(id: string, step: (decision: Decision) => TransitionResult, workspaceId?: string): DecisionMutation;
  /**
   * Deletes the **settled** decisions of these requests (their traces were
   * deleted, §A.4); open ones stay. Returns how many went.
   */
  deleteSettled(workspaceId: string, requestIds: readonly string[]): number;
}

/**
 * One workspace's file, `{ version: 1, entries }`. `skipped` counts the entries
 * `parse` dropped; it is never written, because the cap rebuilds the body as
 * `{ entries }`.
 */
type DecisionsFile = { entries: Decision[]; skipped?: number };

/** A symlink on the way, and every failure to write a file: the code this store has always had. */
const UNWRITABLE: DashboardErrorCode = "E_TRACE_STORE_UNWRITABLE";

interface CachedFile {
  mtimeMs: number;
  size: number;
  value: WorkspaceDecisions;
}

/** Per-file read cache, keyed by absolute path, invalidated by mtime and size. */
const readCache = new Map<string, CachedFile>();

/** Test-only: forgets every cached read. */
export function clearDecisionStoreCache(): void {
  readCache.clear();
}

/** `<home>/decisions`. */
export function decisionsDirOf(home: string): string {
  return join(home, DECISIONS_DIR_NAME);
}

function isWorkspaceId(name: string): boolean {
  return WORKSPACE_ID_PATTERN.test(name) && name !== "." && name !== "..";
}

/**
 * Keeps every unsettled decision and the `DECISION_SETTLED_LIMIT` newest
 * settled ones (by `settledAt`; a tie keeps the later in the file), in file order.
 */
export function capDecisions(entries: readonly Decision[]): Decision[] {
  const settled = entries.flatMap((entry, index) => (isSettledStatus(entry.status) ? [index] : []));
  const kept = new Set(capBy(settled, DECISION_SETTLED_LIMIT, (index) => timeOrZero(entries[index]!.settledAt)));
  return entries.filter((entry, index) => !isSettledStatus(entry.status) || kept.has(index));
}

function writeFailed(detail: string, cause?: unknown): DashboardError {
  return new DashboardError("E_DECISION_WRITE_FAILED", detail, cause === undefined ? undefined : { cause });
}

/**
 * The store rooted at the data folder `home` (from `resolveDataHome`).
 * Creating it touches nothing on disk.
 */
export function createDecisionStore(home: string, deps: DecisionStoreDeps = {}): DecisionStore {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const dir = decisionsDirOf(home);

  const fileOf = (workspaceId: string): JsonFileStore<DecisionsFile> => {
    assertWorkspaceId(workspaceId);
    return createJsonFileStore<DecisionsFile>({
      home,
      dir: DECISIONS_DIR_NAME,
      file: `${workspaceId}.json`,
      version: DECISIONS_FILE_VERSION,
      parse: (body) => {
        const raw = Array.isArray(body["entries"]) ? (body["entries"] as unknown[]) : [];
        const entries: Decision[] = [];
        for (const entry of raw) {
          const valid = decisionSchema.safeParse(entry);
          // An entry filed under another workspace is as unusable as a broken one.
          if (valid.success && valid.data.workspaceId === workspaceId) entries.push(valid.data);
        }
        return { entries, skipped: raw.length - entries.length };
      },
      empty: () => ({ entries: [], skipped: 0 }),
      cap: ({ entries }) => ({ entries: capDecisions(entries) }),
      codes: { unwritable: UNWRITABLE, tooNew: "E_DECISION_WRITE_FAILED" },
    });
  };

  /** Reads one file through the cache; a symlink on the way throws before anything is read. */
  const readFile = (workspaceId: string): WorkspaceDecisions => {
    const file = fileOf(workspaceId);
    const path = file.path;
    // Before the `stat`, so a cached read refuses a symlink as a fresh one does.
    assertNoSymlink(home, path, UNWRITABLE);
    let mtimeMs: number;
    let size: number;
    try {
      const stat = statSync(path);
      mtimeMs = stat.mtimeMs;
      size = stat.size;
    } catch {
      readCache.delete(path);
      return { entries: [], skipped: 0 };
    }
    const cached = readCache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value;

    const { entries, skipped = 0 } = file.read();
    const value = { entries, skipped };
    readCache.set(path, { mtimeMs, size, value });
    return value;
  };

  /** Writes one file (refused on a newer one), capped, and keeps the cache in step. */
  const write = (workspaceId: string, entries: readonly Decision[]): void => {
    const file = fileOf(workspaceId);
    const { entries: kept } = file.write({ entries: [...entries] });
    try {
      const stat = statSync(file.path);
      readCache.set(file.path, { mtimeMs: stat.mtimeMs, size: stat.size, value: { entries: kept, skipped: 0 } });
    } catch {
      readCache.delete(file.path);
    }
  };

  const workspaceIds = (): string[] => {
    assertNoSymlink(home, dir, UNWRITABLE);
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -".json".length))
        .filter(isWorkspaceId)
        .sort();
    } catch {
      return [];
    }
  };

  /** One workspace's decisions for a cross-workspace read; a file that cannot be read safely is skipped and logged. */
  const readForList = (workspaceId: string): Decision[] => {
    try {
      return readFile(workspaceId).entries;
    } catch (error) {
      const path = join(dir, `${workspaceId}.json`);
      let symlink = false;
      try {
        symlink = lstatSync(path).isSymbolicLink();
      } catch {
        // Nothing to add: the error below says what went wrong.
      }
      log(`[paseo-bm] skipped the decisions of ${workspaceId}${symlink ? " (a symlink)" : ""}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  const findIn = (id: string, workspaceId?: string): { workspaceId: string; entries: Decision[]; index: number } | null => {
    const candidates = workspaceId === undefined ? workspaceIds() : [workspaceId];
    for (const candidate of candidates) {
      const entries = workspaceId === undefined ? readForList(candidate) : readFile(candidate).entries;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index >= 0) return { workspaceId: candidate, entries: [...entries], index };
    }
    return null;
  };

  return {
    dir,
    workspaceIds,

    read(workspaceId) {
      const { entries, skipped } = readFile(workspaceId);
      return { entries: [...entries], skipped };
    },

    list(filter = {}) {
      const ids = filter.workspaceId === undefined ? workspaceIds() : [filter.workspaceId];
      const statuses = filter.statuses === undefined ? null : new Set(filter.statuses);
      return ids.flatMap((workspaceId) =>
        (filter.workspaceId === undefined ? readForList(workspaceId) : readFile(workspaceId).entries).filter(
          (entry) =>
            (filter.requestId === undefined || entry.requestId === filter.requestId) &&
            (statuses === null || statuses.has(entry.status)),
        ),
      );
    },

    get(id, workspaceId) {
      const found = findIn(id, workspaceId);
      return found === null ? null : found.entries[found.index]!;
    },

    open(input) {
      const decision = decisionSchema.parse(input);
      const entries = [...readFile(decision.workspaceId).entries];
      const existing = entries.find((entry) => entry.id === decision.id);
      if (existing !== undefined) return { decision: existing, created: false, superseded: null };

      let superseded: Decision | null = null;
      if (decision.supersedes !== null) {
        const index = entries.findIndex((entry) => entry.id === decision.supersedes);
        const older = index >= 0 ? entries[index]! : null;
        if (older !== null) {
          const moved = supersedeDecision(older, { by: decision.id, at: decision.askedAt });
          if (moved.ok) {
            entries[index] = moved.decision;
            superseded = moved.decision;
          }
        }
      }
      entries.push(decision);
      write(decision.workspaceId, entries);
      return { decision, created: true, superseded };
    },

    transition(id, step, workspaceId) {
      const found = findIn(id, workspaceId);
      if (found === null) return { status: "not-found" };
      const previous = found.entries[found.index]!;
      const result = step(previous);
      if (!result.ok) return { status: "refused", decision: previous, refusal: result.refusal, message: result.message };
      const next = decisionSchema.parse(result.decision);
      if (next.id !== previous.id || next.workspaceId !== previous.workspaceId) {
        throw writeFailed(`a transition may not change the id or the workspace of decision ${id}`);
      }
      found.entries[found.index] = next;
      write(found.workspaceId, found.entries);
      return { status: "updated", decision: next, previous };
    },

    deleteSettled(workspaceId, requestIds) {
      const named = new Set(requestIds);
      if (named.size === 0) return 0;
      const entries = readFile(workspaceId).entries;
      const kept = entries.filter(
        (entry) => !(entry.requestId !== null && named.has(entry.requestId) && isSettledStatus(entry.status)),
      );
      const removed = entries.length - kept.length;
      if (removed > 0) write(workspaceId, kept);
      return removed;
    },
  };
}
