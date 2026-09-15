/**
 * The one module allowed to change `<paseo home>/config.json` (ADR-004,
 * ADR-006, Design §3.4, §9.3).
 *
 * This is the only place paseo-bm writes into a file that belongs to another
 * product, so it carries its own evidence and its own undo. Five rules hold the
 * whole story together:
 *
 * 1. **Read–modify–write, never replace.** The file is parsed, only the keys
 *    listed in Design §3.4 are touched, and everything else — including key
 *    order — comes back out exactly as it went in. `daemon.agentProfiles` is an
 *    array, so it is merged entry by entry: entries whose `id` starts with
 *    `bm-` are added or replaced in place, every other entry keeps its position
 *    and its content. Replacing the whole array is the paseo-room defect this
 *    module exists to avoid (ADR-006 decision 5).
 * 2. **Backup first.** The file is copied to
 *    `<install home>/backups/<stamp>/paseo-config.json` before anything is
 *    written, and that copy is what a failed reload is rolled back to.
 * 3. **Per-key previous state, not a boolean flag.** `{ present, value }` of
 *    `daemon.mcp.injectIntoAgents` is reported back so the install record can
 *    keep it: "the key was absent" is a different state from "the key was
 *    `false`" (ADR-006 decision 8). Uninstall restores *that key*, never the
 *    whole backup file, because a full restore would throw away every unrelated
 *    configuration change made since the install.
 * 4. **Concurrent-write detection.** The Paseo app can write this file while its
 *    Settings screen is open. The bytes on disk are compared with the bytes that
 *    were parsed immediately before the write; a mismatch means re-read and
 *    retry **exactly once**, and a second mismatch stops with
 *    `E_CONFIG_CONCURRENT_WRITE`, leaving the other process's file in place.
 * 5. **Reload, never restart.** Changes are picked up with
 *    `paseo daemon reload`. `paseo daemon restart` and `paseo daemon stop` can
 *    kill a running agent and are never called from anywhere in paseo-bm.
 *
 * Formatting: the file is re-serialised with the indentation detected in the
 * original, so a config written by Paseo comes back byte-for-byte apart from
 * the keys that changed. ADR-004 accepts whitespace normalisation as the price
 * of editing JSON structurally; nothing is written at all when there is no
 * logical change to make, so a re-run never reformats anything.
 */

import type { NodeFsApi } from "../fs-guard.js";
import { nodeFs } from "../fs-guard.js";
import type { ErrorCode } from "../errors.js";
import { diagnostic } from "../errors.js";
import type { FsOps } from "../fsops.js";
import { FILE_MODE, backupStamp, createFsOps, sha256 } from "../fsops.js";
import { installPaths, paseoConfigFile } from "../layout.js";
import type { McpInjectPrevious, McpInjectRecord } from "../record.js";
import type { DaemonReload, PaseoAdapter } from "./adapter.js";

/** Prefix every key paseo-bm owns inside Paseo's config carries (ADR-006). */
export const BM_PREFIX = "bm-";

/** Name the Paseo config takes inside a backup directory (Design §3.1). */
export const CONFIG_BACKUP_NAME = "paseo-config.json";

/** Root-level plugin switch (Design §3.4, REQ-006). */
export const PLUGINS_ENABLED_PATH = "pluginsEnabled";

/** The global agent-tool switch (Design §3.4, ADR-006 decision 3). */
export const MCP_INJECT_PATH = "daemon.mcp.injectIntoAgents";

/** The array of agent profiles; merged entry by entry, never replaced. */
export const AGENT_PROFILES_PATH = "daemon.agentProfiles";

/** The derived-provider map; only `bm-*` members are ever touched. */
export const PROVIDERS_PATH = "agents.providers";

/** One write, then one retry after a concurrent change. ADR-004 decision 8. */
export const MAX_WRITE_ATTEMPTS = 2;

/** Indentation used when the existing file gives no hint. */
export const DEFAULT_INDENT = "  ";

/** A parsed `config.json`. Deliberately untyped past the root: it is not ours. */
export type PaseoConfig = Record<string, unknown>;

/** Anything JSON can hold. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One `daemon.agentProfiles[]` entry. Only the `id` has a meaning here. */
export interface AgentProfileEntry {
  readonly id: string;
  readonly [key: string]: unknown;
}

/**
 * The state of a single boolean key. `present` answers "did the key exist at
 * all"; `value` is `null` when it did not, and also when it held something that
 * is not a boolean — the install record has nowhere to put a foreign value.
 */
export interface KeyState {
  readonly present: boolean;
  readonly value: boolean | null;
  /** Exactly what was found, for diagnostics. `undefined` when absent. */
  readonly raw: unknown;
}

export type ConfigErrorReason =
  /** `config.json` is not there — the caller ran before preflight passed. */
  | "config-missing"
  /** The file could not be read. */
  | "config-unreadable"
  /** The file is not valid JSON. */
  | "config-invalid-json"
  /** A key on the way to a target is not the shape it has to be. */
  | "unexpected-shape"
  /** A programming error: an edit named a key that is not ours to touch. */
  | "not-ours"
  /** Someone else wrote the file; the single retry hit the same conflict. */
  | "concurrent-write"
  /** `paseo daemon reload` failed; the backup has been put back. */
  | "reload-failed"
  /** The reload reported success but the change is not in effect. */
  | "reload-not-applied";

/**
 * A refusal or failure from this module. Only `concurrent-write` has a
 * registry code; the rest are shaped by whichever command is running, exactly
 * like `FsOpsError` and `PathGuardError`.
 */
export class ConfigMutationError extends Error {
  readonly reason: ConfigErrorReason;
  readonly code: ErrorCode | undefined;
  readonly remediation: string | undefined;
  /** The config file the failure was about. */
  readonly path: string | undefined;
  /** The config key involved, e.g. `daemon.agentProfiles[bm-worker]`. */
  readonly field: string | undefined;
  /** True when the backup was put back before the error was raised. */
  readonly restoredFromBackup: boolean;
  /** The backup that exists for this run, when one was taken. */
  readonly backupPath: string | undefined;

  constructor(details: {
    reason: ConfigErrorReason;
    message: string;
    code?: ErrorCode;
    remediation?: string;
    path?: string | undefined;
    field?: string | undefined;
    restoredFromBackup?: boolean;
    backupPath?: string | undefined;
    cause?: unknown;
  }) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ConfigMutationError";
    this.reason = details.reason;
    this.code = details.code;
    this.remediation = details.remediation;
    this.path = details.path;
    this.field = details.field;
    this.restoredFromBackup = details.restoredFromBackup ?? false;
    this.backupPath = details.backupPath;
  }
}

/** True when `value` is a {@link ConfigMutationError}. */
export function isConfigMutationError(value: unknown): value is ConfigMutationError {
  return value instanceof ConfigMutationError;
}

/** `config.json` as it was at one moment, with everything needed to write it back. */
export interface ConfigSnapshot {
  readonly path: string;
  /** The exact bytes read, as UTF-8. */
  readonly text: string;
  /** sha256 of those bytes — the concurrent-write detector's reference. */
  readonly sha256: string;
  readonly config: PaseoConfig;
  /** Indentation detected in the file, reused when writing it back. */
  readonly indent: string;
  readonly trailingNewline: boolean;
  /** Permission bits found on disk; the write keeps them. */
  readonly mode: number;
}

/** What to do with the global MCP switch. */
export type McpInjectEdit =
  /** Install: put the switch in a known state. */
  | { readonly action: "set"; readonly value: boolean }
  /**
   * Uninstall: put the key back exactly as `previous` describes it, but only
   * while it still holds `expect` — the value paseo-bm itself wrote. Anything
   * else means the user changed it afterwards and it is left alone
   * (ADR-006 decision 8).
   */
  | { readonly action: "restore"; readonly previous: McpInjectPrevious; readonly expect: boolean };

/**
 * The closed set of changes this module can make. It is declarative on purpose:
 * a caller cannot hand in an arbitrary mutation, so "paseo-bm touches nothing
 * else" is enforced by the shape of the API and not by review.
 */
export interface ConfigEdit {
  readonly pluginsEnabled?: boolean;
  readonly mcpInject?: McpInjectEdit;
  /** `agents.providers.<id>`; every id must start with `bm-`. */
  readonly providers?: Readonly<Record<string, JsonValue>>;
  readonly removeProviders?: readonly string[];
  /** `daemon.agentProfiles[]` entries; every `id` must start with `bm-`. */
  readonly profiles?: readonly AgentProfileEntry[];
  readonly removeProfiles?: readonly string[];
}

export interface ConfigEditResult {
  /** A new config object; the input is never mutated. */
  readonly config: PaseoConfig;
  /** Keys that actually changed value, e.g. `daemon.agentProfiles[bm-worker]`. */
  readonly changedPaths: readonly string[];
  /** Keys the edit asked for but deliberately did not touch. */
  readonly skippedPaths: readonly string[];
}

export interface ApplyConfigEditOptions {
  /** Paseo's home, as reported by `paseo daemon status` (ADR-004 decision 2). */
  readonly paseoHome: string;
  /** paseo-bm's install home; the backup goes under it. */
  readonly installHome: string;
  readonly edit: ConfigEdit;
  /** Only `daemonReload` is used — there is no restart anywhere in paseo-bm. */
  readonly adapter: Pick<PaseoAdapter, "daemonReload">;
  /** Filesystem seam; tests inject the guarded one (Design §10, M-4). */
  readonly fs?: NodeFsApi;
  /** Backup directory. Defaults to `<install home>/backups/<stamp>/`. */
  readonly backupDir?: string;
  /** Clock for the default backup stamp. */
  readonly now?: Date;
}

/** How the run convinced itself the daemon really took the change. */
export type ReloadVerification =
  /** `appliedPaths` covered every key that changed. */
  | "applied-paths"
  /** `appliedPaths` did not, so the file was read back instead (ADR-004 §4.3). */
  | "re-read"
  /** Nothing changed, so nothing had to be reloaded. */
  | "not-needed";

export interface ApplyConfigEditResult {
  readonly path: string;
  /** The backup taken before the write, or `undefined` when none was needed. */
  readonly backupPath: string | undefined;
  /** State of the keys paseo-bm claims, as they were just before the write. */
  readonly before: {
    readonly pluginsEnabled: KeyState;
    readonly mcpInject: McpInjectPrevious;
  };
  readonly changedPaths: readonly string[];
  readonly skippedPaths: readonly string[];
  /** True when bytes were actually replaced. */
  readonly written: boolean;
  /** 1 normally, 2 when a concurrent write forced the single retry. */
  readonly attempts: number;
  /** The reload result, when a reload was needed. */
  readonly reload: DaemonReload | undefined;
  readonly verification: ReloadVerification;
}

/**
 * Reads `config.json` and everything needed to write it back unchanged.
 *
 * @throws ConfigMutationError when the file is missing, unreadable, not JSON,
 * or not a JSON object.
 */
export async function readConfigSnapshot(
  file: string,
  fs: NodeFsApi = nodeFs,
): Promise<ConfigSnapshot> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(file);
  } catch (error) {
    const missing = isErrnoCode(error, "ENOENT");
    throw new ConfigMutationError({
      reason: missing ? "config-missing" : "config-unreadable",
      message: missing
        ? `Paseo's config file is not there: ${file}. Nothing was written.`
        : `Paseo's config file could not be read: ${file}. Nothing was written.`,
      path: file,
      cause: error,
    });
  }

  const text = buffer.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigMutationError({
      reason: "config-invalid-json",
      message: `Paseo's config file is not valid JSON: ${file}. Nothing was written.`,
      path: file,
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigMutationError({
      reason: "unexpected-shape",
      message: `Paseo's config file does not hold a JSON object: ${file}. Nothing was written.`,
      path: file,
    });
  }

  let mode = FILE_MODE;
  try {
    mode = (await fs.lstat(file)).mode & 0o7777;
  } catch {
    // The read above succeeded, so a failing lstat is not worth failing over;
    // the write falls back to the restrictive default.
  }

  return {
    path: file,
    text,
    sha256: sha256(buffer),
    config: parsed,
    indent: detectIndent(text),
    trailingNewline: text.endsWith("\n"),
    mode,
  };
}

/** Reads one dotted boolean key without creating anything on the way. */
export function readBooleanKey(config: PaseoConfig, path: string): KeyState {
  const { parents, leaf } = splitPath(path);
  const parent = findParent(config, parents);
  if (parent === undefined || !Object.prototype.hasOwnProperty.call(parent, leaf)) {
    return { present: false, value: null, raw: undefined };
  }
  const raw = parent[leaf];
  return { present: true, value: typeof raw === "boolean" ? raw : null, raw };
}

/** `{ present, value }` of `daemon.mcp.injectIntoAgents` (ADR-006 decision 8). */
export function readMcpInject(config: PaseoConfig): McpInjectPrevious {
  const state = readBooleanKey(config, MCP_INJECT_PATH);
  return { present: state.present, value: state.value };
}

/** `pluginsEnabled`; absent means off (ADR-004). */
export function readPluginsEnabled(config: PaseoConfig): KeyState {
  return readBooleanKey(config, PLUGINS_ENABLED_PATH);
}

/** Every `daemon.agentProfiles[].id`, in file order. Read-only orientation. */
export function agentProfileIds(config: PaseoConfig): string[] {
  const { parents, leaf } = splitPath(AGENT_PROFILES_PATH);
  const parent = findParent(config, parents);
  const list = parent?.[leaf];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((entry) =>
    isPlainObject(entry) && typeof entry["id"] === "string" ? [entry["id"]] : [],
  );
}

/** The `bm-*` profile ids currently registered. */
export function bmProfileIds(config: PaseoConfig): string[] {
  return agentProfileIds(config).filter(isOurs);
}

/** The `bm-*` provider ids currently registered. */
export function bmProviderIds(config: PaseoConfig): string[] {
  const { parents, leaf } = splitPath(PROVIDERS_PATH);
  const parent = findParent(config, parents);
  const providers = parent?.[leaf];
  return isPlainObject(providers) ? Object.keys(providers).filter(isOurs) : [];
}

/**
 * Applies an edit to a parsed config and reports what actually changed.
 *
 * Pure: the input object is cloned, so a caller can compare before and after.
 * Exported because the merge rules — above all "never replace the profiles
 * array" — are the part worth testing on their own.
 */
export function editConfig(config: PaseoConfig, edit: ConfigEdit): ConfigEditResult {
  assertOnlyOurKeys(edit);

  const next = structuredClone(config) as PaseoConfig;
  const changedPaths: string[] = [];
  const skippedPaths: string[] = [];

  if (edit.pluginsEnabled !== undefined) {
    if (setBooleanKey(next, PLUGINS_ENABLED_PATH, edit.pluginsEnabled)) {
      changedPaths.push(PLUGINS_ENABLED_PATH);
    }
  }

  if (edit.mcpInject !== undefined) {
    applyMcpInject(next, edit.mcpInject, changedPaths, skippedPaths);
  }

  applyProviders(next, edit, changedPaths);
  applyProfiles(next, edit, changedPaths);

  return { config: next, changedPaths, skippedPaths };
}

/**
 * Serialises a config the way {@link applyConfigEdit} writes it: the original
 * indentation, and the original trailing newline.
 */
export function serialiseConfig(config: PaseoConfig, snapshot: Pick<ConfigSnapshot, "indent" | "trailingNewline">): string {
  return `${JSON.stringify(config, null, snapshot.indent)}${snapshot.trailingNewline ? "\n" : ""}`;
}

/**
 * The whole write path: backup, read–modify–write with concurrent-write
 * detection, `paseo daemon reload`, verification, and rollback to the backup
 * when the daemon does not take the change (Design §9.3).
 *
 * Nothing is written when the edit would not change a value, so running an
 * install twice leaves the file untouched.
 */
export async function applyConfigEdit(options: ApplyConfigEditOptions): Promise<ApplyConfigEditResult> {
  const fs = options.fs ?? nodeFs;
  const file = paseoConfigFile(options.paseoHome);
  // Two helpers, two roots: backups belong to the install home, and the only
  // file reachable under Paseo's home is `config.json` itself.
  const installOps: FsOps = createFsOps({ root: options.installHome, fs });
  const paseoOps: FsOps = createFsOps({ root: options.paseoHome, fs });
  const backupDir =
    options.backupDir ?? installPaths(options.installHome).backupDir(backupStamp(options.now ?? new Date()));

  let source = await readConfigSnapshot(file, fs);
  // Taken before the first write and reused by the rollback, so a failed
  // reload always has something to go back to.
  const backupPath = await installOps.backupFile(file, { backupDir, as: CONFIG_BACKUP_NAME });

  let attempts = 0;
  let written = false;
  let edited = editConfig(source.config, options.edit);

  while (attempts < MAX_WRITE_ATTEMPTS) {
    attempts += 1;
    edited = editConfig(source.config, options.edit);

    if (edited.changedPaths.length === 0) {
      // Already in the desired state: do not rewrite, do not reformat, do not
      // reload. This is what makes a re-run a no-op (REQ-009).
      break;
    }

    // The concurrency window: compare what is on disk now with what was parsed.
    const currentSha = await readSha(file, fs);
    if (currentSha !== source.sha256) {
      if (attempts >= MAX_WRITE_ATTEMPTS) {
        const entry = diagnostic("E_CONFIG_CONCURRENT_WRITE");
        throw new ConfigMutationError({
          reason: "concurrent-write",
          code: entry.code,
          remediation: entry.remediation,
          message: `${entry.message} File: ${file}. The other process's version was kept.`,
          path: file,
          backupPath,
        });
      }
      source = await readConfigSnapshot(file, fs);
      continue;
    }

    await paseoOps.writeFileAtomic(file, serialiseConfig(edited.config, source), { mode: source.mode });
    written = true;
    break;
  }

  const before = {
    pluginsEnabled: readPluginsEnabled(source.config),
    mcpInject: readMcpInject(source.config),
  };

  if (!written) {
    return {
      path: file,
      backupPath,
      before,
      changedPaths: edited.changedPaths,
      skippedPaths: edited.skippedPaths,
      written: false,
      attempts,
      reload: undefined,
      verification: "not-needed",
    };
  }

  const reload = await reloadOrRollback(options.adapter, { file, fs, paseoOps, backupPath, source });
  const verification = await verifyApplied({
    file,
    fs,
    reload,
    edit: options.edit,
    changedPaths: edited.changedPaths,
  });

  if (verification === undefined) {
    const restored = await rollback({ file, fs, paseoOps, backupPath, source });
    await reloadQuietly(options.adapter);
    throw new ConfigMutationError({
      reason: "reload-not-applied",
      message:
        `Paseo reloaded but ${file} is not in the state paseo-bm wrote ` +
        `(${edited.changedPaths.join(", ")}). The backup was put back.`,
      path: file,
      restoredFromBackup: restored,
      backupPath,
    });
  }

  return {
    path: file,
    backupPath,
    before,
    changedPaths: edited.changedPaths,
    skippedPaths: edited.skippedPaths,
    written: true,
    attempts,
    reload,
    verification,
  };
}

/**
 * The `paseo.mcpInject` half of the install record: who set the switch, and
 * what it looked like beforehand (ADR-006 decision 8).
 */
export function mcpInjectRecordFrom(result: Pick<ApplyConfigEditResult, "before" | "changedPaths">): McpInjectRecord {
  return {
    setByUs: result.changedPaths.includes(MCP_INJECT_PATH),
    previous: result.before.mcpInject,
  };
}

/* ------------------------------------------------------------------ edits */

function applyMcpInject(
  config: PaseoConfig,
  edit: McpInjectEdit,
  changedPaths: string[],
  skippedPaths: string[],
): void {
  if (edit.action === "set") {
    if (setBooleanKey(config, MCP_INJECT_PATH, edit.value)) {
      changedPaths.push(MCP_INJECT_PATH);
    }
    return;
  }

  const current = readBooleanKey(config, MCP_INJECT_PATH);
  if (!current.present || current.value !== edit.expect) {
    // Somebody changed the switch after paseo-bm set it. Leave it alone.
    skippedPaths.push(MCP_INJECT_PATH);
    return;
  }

  if (!edit.previous.present) {
    if (deleteKey(config, MCP_INJECT_PATH)) {
      changedPaths.push(MCP_INJECT_PATH);
    }
    return;
  }

  if (typeof edit.previous.value !== "boolean") {
    // The key existed but held something the record cannot describe, so there
    // is nothing faithful to restore.
    skippedPaths.push(MCP_INJECT_PATH);
    return;
  }

  if (setBooleanKey(config, MCP_INJECT_PATH, edit.previous.value)) {
    changedPaths.push(MCP_INJECT_PATH);
  }
}

function applyProviders(config: PaseoConfig, edit: ConfigEdit, changedPaths: string[]): void {
  const entries = Object.entries(edit.providers ?? {});
  const removals = edit.removeProviders ?? [];
  if (entries.length === 0 && removals.length === 0) {
    return;
  }

  const { parents, leaf } = splitPath(PROVIDERS_PATH);
  if (entries.length === 0) {
    const parent = findParent(config, parents);
    const existing = parent?.[leaf];
    if (parent === undefined || !isPlainObject(existing)) {
      return;
    }
    for (const id of removals) {
      if (Object.prototype.hasOwnProperty.call(existing, id)) {
        delete existing[id];
        changedPaths.push(`${PROVIDERS_PATH}.${id}`);
      }
    }
    return;
  }

  const parent = ensureParent(config, parents, PROVIDERS_PATH);
  const existing = parent[leaf];
  if (existing !== undefined && !isPlainObject(existing)) {
    throw shapeError(PROVIDERS_PATH, "a JSON object", existing);
  }
  const providers: Record<string, unknown> = isPlainObject(existing) ? existing : {};
  parent[leaf] = providers;

  for (const [id, value] of entries) {
    if (!deepEqual(providers[id], value)) {
      providers[id] = structuredClone(value);
      changedPaths.push(`${PROVIDERS_PATH}.${id}`);
    }
  }
  for (const id of removals) {
    if (Object.prototype.hasOwnProperty.call(providers, id)) {
      delete providers[id];
      changedPaths.push(`${PROVIDERS_PATH}.${id}`);
    }
  }
}

/**
 * Merges `daemon.agentProfiles` entry by entry.
 *
 * The array is copied, `bm-*` entries are replaced **at their existing index**
 * or appended at the end, and every other entry is carried over as the very
 * same value. That is the whole point: a profile the user or paseo-room added
 * keeps its position and its content down to the byte.
 */
function applyProfiles(config: PaseoConfig, edit: ConfigEdit, changedPaths: string[]): void {
  const additions = edit.profiles ?? [];
  const removals = edit.removeProfiles ?? [];
  if (additions.length === 0 && removals.length === 0) {
    return;
  }

  const { parents, leaf } = splitPath(AGENT_PROFILES_PATH);
  const lookup = findParent(config, parents);
  const found = lookup?.[leaf];
  if (found !== undefined && !Array.isArray(found)) {
    throw shapeError(AGENT_PROFILES_PATH, "an array", found);
  }
  if (found === undefined && additions.length === 0) {
    return;
  }

  const list: unknown[] = Array.isArray(found) ? [...found] : [];
  let changed = false;

  for (const profile of additions) {
    const index = list.findIndex((entry) => isPlainObject(entry) && entry["id"] === profile.id);
    if (index === -1) {
      list.push(structuredClone(profile));
      changed = true;
      changedPaths.push(profileField(profile.id));
      continue;
    }
    if (!deepEqual(list[index], profile)) {
      list[index] = structuredClone(profile);
      changed = true;
      changedPaths.push(profileField(profile.id));
    }
  }

  for (const id of removals) {
    const index = list.findIndex((entry) => isPlainObject(entry) && entry["id"] === id);
    if (index !== -1) {
      list.splice(index, 1);
      changed = true;
      changedPaths.push(profileField(id));
    }
  }

  if (changed) {
    const parent = ensureParent(config, parents, AGENT_PROFILES_PATH);
    parent[leaf] = list;
  }
}

function profileField(id: string): string {
  return `${AGENT_PROFILES_PATH}[${id}]`;
}

/** Rejects any edit that names something outside paseo-bm's `bm-` prefix. */
function assertOnlyOurKeys(edit: ConfigEdit): void {
  const ids = [
    ...Object.keys(edit.providers ?? {}),
    ...(edit.removeProviders ?? []),
    ...(edit.profiles ?? []).map((profile) => profile.id),
    ...(edit.removeProfiles ?? []),
  ];
  for (const id of ids) {
    if (!isOurs(id)) {
      throw new ConfigMutationError({
        reason: "not-ours",
        message:
          `Refusing to touch "${id}" in Paseo's config: paseo-bm only ever writes ` +
          `entries whose id starts with "${BM_PREFIX}" (ADR-006 decision 5).`,
        field: id,
      });
    }
  }
}

function isOurs(id: string): boolean {
  return id.startsWith(BM_PREFIX);
}

/* --------------------------------------------------------- reload + undo */

interface RollbackContext {
  readonly file: string;
  readonly fs: NodeFsApi;
  readonly paseoOps: FsOps;
  readonly backupPath: string | undefined;
  readonly source: ConfigSnapshot;
}

async function reloadOrRollback(
  adapter: Pick<PaseoAdapter, "daemonReload">,
  context: RollbackContext,
): Promise<DaemonReload> {
  try {
    return await adapter.daemonReload();
  } catch (error) {
    // The daemon refused the new config: put the file back and reload again so
    // the daemon is left running the configuration it accepted (Design §9.3).
    const restored = await rollback(context);
    await reloadQuietly(adapter);
    throw new ConfigMutationError({
      reason: "reload-failed",
      message: `Paseo refused to reload after ${context.file} was changed. The backup was put back.`,
      path: context.file,
      restoredFromBackup: restored,
      backupPath: context.backupPath,
      cause: error,
    });
  }
}

/**
 * Puts the pre-write bytes back.
 *
 * This is the *only* full-file restore in paseo-bm, and it is correct here
 * because it runs seconds after the write it is undoing. Uninstall must never
 * use it: by then the file has a life of its own and only the recorded keys may
 * be touched (ADR-006 decision 8).
 */
async function rollback(context: RollbackContext): Promise<boolean> {
  const content =
    context.backupPath === undefined
      ? Buffer.from(context.source.text, "utf8")
      : await context.fs.readFile(context.backupPath);
  await context.paseoOps.writeFileAtomic(context.file, content, { mode: context.source.mode });
  return true;
}

/** A reload whose failure must not replace the error already being reported. */
async function reloadQuietly(adapter: Pick<PaseoAdapter, "daemonReload">): Promise<void> {
  try {
    await adapter.daemonReload();
  } catch {
    // Nothing to add: the caller is already throwing about the first failure.
  }
}

interface VerifyInput {
  readonly file: string;
  readonly fs: NodeFsApi;
  readonly reload: DaemonReload;
  readonly edit: ConfigEdit;
  readonly changedPaths: readonly string[];
}

/**
 * ADR-004 decision 4.3: every changed key should show up in `appliedPaths`.
 * When it does not — the daemon is allowed to report nothing — the file is read
 * back and the values are checked instead. `undefined` means neither held.
 */
async function verifyApplied(input: VerifyInput): Promise<ReloadVerification | undefined> {
  const expected = expectedReloadPaths(input.changedPaths);
  const applied = input.reload.appliedPaths.map(normalisePath);
  if (expected.length > 0 && expected.every((path) => applied.some((one) => covers(one, path)))) {
    return "applied-paths";
  }

  const snapshot = await readConfigSnapshot(input.file, input.fs);
  const again = editConfig(snapshot.config, input.edit);
  return again.changedPaths.length === 0 ? "re-read" : undefined;
}

/** `daemon.agentProfiles[bm-worker]` is reported by Paseo as `daemon.agentProfiles`. */
function expectedReloadPaths(changedPaths: readonly string[]): string[] {
  return [...new Set(changedPaths.map(normalisePath))];
}

function normalisePath(path: string): string {
  const bracket = path.indexOf("[");
  return bracket === -1 ? path : path.slice(0, bracket);
}

/** A reported path covers a key when it is the key or an ancestor of it. */
function covers(applied: string, expected: string): boolean {
  return applied === expected || expected.startsWith(`${applied}.`);
}

/* ------------------------------------------------------------- JSON tools */

async function readSha(file: string, fs: NodeFsApi): Promise<string | undefined> {
  try {
    return sha256(await fs.readFile(file));
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function splitPath(path: string): { parents: string[]; leaf: string } {
  const segments = path.split(".");
  const leaf = segments[segments.length - 1] ?? path;
  return { parents: segments.slice(0, -1), leaf };
}

/** Walks a dotted path without creating anything. */
function findParent(config: PaseoConfig, parents: readonly string[]): Record<string, unknown> | undefined {
  let node: Record<string, unknown> = config;
  for (const segment of parents) {
    const next = node[segment];
    if (!isPlainObject(next)) {
      return undefined;
    }
    node = next;
  }
  return node;
}

/** Walks a dotted path, creating the missing objects on the way. */
function ensureParent(
  config: PaseoConfig,
  parents: readonly string[],
  path: string,
): Record<string, unknown> {
  let node: Record<string, unknown> = config;
  for (const segment of parents) {
    const next = node[segment];
    if (next === undefined || next === null) {
      const fresh: Record<string, unknown> = {};
      node[segment] = fresh;
      node = fresh;
      continue;
    }
    if (!isPlainObject(next)) {
      throw shapeError(path, "a JSON object", next);
    }
    node = next;
  }
  return node;
}

function setBooleanKey(config: PaseoConfig, path: string, value: boolean): boolean {
  const { parents, leaf } = splitPath(path);
  const parent = ensureParent(config, parents, path);
  if (parent[leaf] === value) {
    return false;
  }
  parent[leaf] = value;
  return true;
}

/**
 * Removes one leaf key. Any object created on the way to it is left behind
 * rather than pruned: an empty `daemon.mcp` is inert, and deleting containers
 * paseo-bm does not own is exactly the kind of tidying ADR-004 forbids.
 */
function deleteKey(config: PaseoConfig, path: string): boolean {
  const { parents, leaf } = splitPath(path);
  const parent = findParent(config, parents);
  if (parent === undefined || !Object.prototype.hasOwnProperty.call(parent, leaf)) {
    return false;
  }
  delete parent[leaf];
  return true;
}

function shapeError(path: string, expected: string, found: unknown): ConfigMutationError {
  return new ConfigMutationError({
    reason: "unexpected-shape",
    message: `Paseo's config has "${path}" as ${describe(found)}, but paseo-bm needs ${expected} there. Nothing was written.`,
    field: path,
  });
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality, key order ignored — "no change" must not depend on it. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) {
      return false;
    }
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]),
    );
  }
  return false;
}

/**
 * The indentation of the first nested key. Paseo writes two spaces; anything
 * else is honoured so the file keeps looking the way its owner wrote it.
 */
function detectIndent(text: string): string {
  const match = /\n([ \t]+)"/.exec(text);
  return match?.[1] ?? DEFAULT_INDENT;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
