/**
 * `install --prune` — Technical Design §3.1, §3.2 (`versions[]`, `backups[]`),
 * §4.2, §8; ADR-002 decision 7; Design Q-016.
 *
 * The owner decided to keep every payload version and every backup. Removing
 * any of them is therefore only ever an explicit user request, and this module
 * is the only code that does it. Even then, one backup always stays (owner
 * decision 2026-09-15): the newest backup that holds the Paseo config copy
 * (`paseo-config.json`, written by `src/paseo/config.ts`), so
 * `uninstall --restore-backups` can still restore it. Older config backups and
 * payload backups are pruned as usual. It follows the same split as install:
 *
 * - {@link planPrune} **only reads**. It decides what would be removed and what
 *   is kept, and says why, as report `Action`s. Without `--prune` it does not
 *   even look at the disk and returns an empty plan.
 * - {@link applyPrune} **does not decide**. It carries out the plan, re-checks
 *   each file just before removing it, and then updates `install.json`.
 *
 * Safety rules, in the order they are applied:
 *
 * 1. Only what the record names is a candidate: a `versions[].dir` directly
 *    under `plugin/`, a `backups[].dir` directly under `backups/`. A record
 *    entry pointing anywhere else is kept and reported, never followed.
 *    Anything on disk that the record does not list is left alone and reported
 *    as `unrecorded`.
 * 2. Never the version in use: the `active` version, the version whose
 *    directory is `paseo.pluginDir` (what Paseo loads), and any version the
 *    caller names in `keepVersions` (the one this install run just wrote). When
 *    the record has no such anchor at all, no version is removed — it cannot be
 *    told which one Paseo uses.
 * 3. Inside an old version, only files whose bytes still match `files[]` are
 *    removed. A user-modified file, an unrecorded file, a symlink or any other
 *    special entry stays (ADR-002 decision 7), and so does the version's
 *    `versions[]` entry — otherwise the next install would treat the directory
 *    as a partial payload and wipe what the user kept.
 * 4. The newest config backup stays whole: among the recorded backups that
 *    hold a regular `paseo-config.json` (checked with `lstat`, no symlink
 *    followed), the one with the latest `at` — the larger directory name on a
 *    tie — is kept with reason `latest-config-backup`.
 * 5. Symlinks are never followed. Every path goes through `FsOps.resolvePath`
 *    (inside the install home, no symlink segment); a backup that contains a
 *    symlink or special file is kept whole.
 * 6. Removal is file by file (`unlink`) and directories go with `rmdir`, which
 *    refuses a non-empty directory. Nothing is removed recursively, so a file
 *    that appeared after the preview cannot be swept away with its directory.
 */

import type { Dirent } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { posix, resolve } from "node:path";
import type { Action, ActionSummary, FileAction } from "../action.js";
import { summarizeActions } from "../action.js";
import type { NodeFsApi } from "../fs-guard.js";
import { canonicalPath, nodeFs } from "../fs-guard.js";
import type { FsOps } from "../fsops.js";
import { installHomeLabel } from "../ownership.js";
import { CONFIG_BACKUP_NAME } from "../paseo/config.js";
import { PathGuardError } from "../paths-guard.js";
import type { BackupRecord, FileRecord, InstallRecord, VersionRecord } from "../record.js";
import { toIsoUtc, writeRecord } from "../record.js";

/** Why something is removed (`delete` actions) or kept (`keep` actions). */
export type PruneReason =
  /** An inactive payload version whose files are all still paseo-bm's bytes. */
  | "old-version"
  /** A recorded backup directory. Removing it cannot be undone. */
  | "backup"
  /** The record lists a directory that is no longer on disk; only the entry goes. */
  | "missing-on-disk"
  | "active-version"
  /** `paseo.pluginDir` points at this version's directory. */
  | "registered-with-paseo"
  /** Named by the caller, e.g. the version this install run wrote. */
  | "current-install"
  /** The caller asked to keep this backup, e.g. the one this run took. */
  | "current-backup"
  /**
   * The newest backup holding the Paseo config copy. Always kept so
   * `uninstall --restore-backups` can still restore it.
   */
  | "latest-config-backup"
  /** No version is active or registered, so none can safely be called old. */
  | "no-active-version"
  /** The record entry does not point directly under `plugin/` or `backups/`. */
  | "unexpected-location"
  | "not-a-directory"
  | "symlink"
  | "not-a-regular-file"
  | "user-modified"
  /** On disk, but not in `install.json`: not provably paseo-bm's. */
  | "unrecorded"
  /** The file changed between the preview and the removal. */
  | "changed-since-preview";

/** One path left in place, relative to the install home. */
export interface PruneKept {
  readonly path: string;
  readonly reason: PruneReason;
}

/**
 * - `delete` — every entry is removable; the directory and its record entry go.
 * - `partial` — some files go, the directory and its record entry stay.
 * - `forget` — the directory is already gone; only the record entry goes.
 * - `keep` — nothing is touched.
 */
export type PruneDecision = "delete" | "partial" | "forget" | "keep";

export interface PruneVersionPlan {
  readonly version: string;
  /** As recorded, relative to the install home. */
  readonly dir: string;
  readonly decision: PruneDecision;
  /** For `keep`, why the whole version is kept; otherwise what is removed. */
  readonly reason: PruneReason;
  /** Recorded files whose bytes matched `files[]` at preview time. */
  readonly deleteFiles: readonly FileRecord[];
  /** Directories to try to remove afterwards, deepest first, the version dir last. */
  readonly dirs: readonly string[];
  /** Entries inside the directory that stay. */
  readonly kept: readonly PruneKept[];
}

export interface PruneBackupPlan {
  readonly dir: string;
  readonly at: string;
  /** The backup's own recorded reason, for the preview. */
  readonly backupReason: string;
  readonly decision: Exclude<PruneDecision, "partial">;
  readonly reason: PruneReason;
  /** Every file that would be lost, relative to the install home. */
  readonly deleteFiles: readonly string[];
  readonly dirs: readonly string[];
  readonly kept: readonly PruneKept[];
}

export interface PrunePlan {
  /** False when `--prune` was not given: the plan is empty and nothing was read. */
  readonly requested: boolean;
  /** `updatedAt` of the record the plan was built from; `null` without a record. */
  readonly recordUpdatedAt: string | null;
  readonly versions: readonly PruneVersionPlan[];
  readonly backups: readonly PruneBackupPlan[];
  /** Entries under `plugin/` and `backups/` the record does not list. Never touched. */
  readonly unrecorded: readonly string[];
  /** The same plan as report actions, for the preview. */
  readonly actions: readonly Action[];
  readonly summary: ActionSummary;
}

export interface PlanPruneInput {
  /** The `--prune` flag. Without it nothing is planned and nothing is read. */
  readonly prune: boolean;
  readonly record: InstallRecord | undefined;
  /** Bound to the install home; every path is resolved through it. */
  readonly fsops: FsOps;
  /** Filesystem seam for `lstat`; defaults to the real filesystem. */
  readonly fs?: NodeFsApi | undefined;
  /** Version names never to remove, e.g. the version this run installs. */
  readonly keepVersions?: readonly string[] | undefined;
  /** Backup dirs (as recorded) never to remove, e.g. the one this run took. */
  readonly keepBackups?: readonly string[] | undefined;
}

export type PruneErrorReason = "record-changed";

/** A refusal raised before anything is removed. */
export class PruneError extends Error {
  readonly reason: PruneErrorReason;

  constructor(reason: PruneErrorReason, message: string) {
    super(message);
    this.name = "PruneError";
    this.reason = reason;
  }
}

/** Builds the prune plan. Reads only. */
export async function planPrune(input: PlanPruneInput): Promise<PrunePlan> {
  const { record, fsops } = input;
  if (!input.prune || record === undefined) {
    return finish({ requested: input.prune, recordUpdatedAt: record?.updatedAt ?? null, versions: [], backups: [], unrecorded: [] });
  }
  const fs = input.fs ?? nodeFs;

  const versions = await planVersions(record, fsops, fs, new Set(input.keepVersions ?? []));
  const backups = await planBackups(record, fsops, fs, new Set((input.keepBackups ?? []).map(normalizeDir)));
  const unrecorded = [
    ...(await listUnrecorded(fsops, "plugin", new Set(record.versions.map((v) => normalizeDir(v.dir))))),
    ...(await listUnrecorded(fsops, "backups", new Set(record.backups.map((b) => normalizeDir(b.dir))))),
  ];

  return finish({ requested: true, recordUpdatedAt: record.updatedAt, versions, backups, unrecorded });
}

export interface ApplyPruneInput {
  readonly plan: PrunePlan;
  /** The record the plan was built from. */
  readonly record: InstallRecord | undefined;
  readonly fsops: FsOps;
  readonly fs?: NodeFsApi | undefined;
  readonly now?: Date | undefined;
}

export interface ApplyPruneResult {
  /** Files removed, relative to the install home. */
  readonly removedFiles: readonly string[];
  /** Directories removed, relative to the install home. */
  readonly removedDirs: readonly string[];
  /** `versions[]` entries dropped from the record. */
  readonly removedVersions: readonly VersionRecord[];
  /** `backups[]` entries dropped from the record. */
  readonly removedBackups: readonly BackupRecord[];
  /** Everything that stayed, including files that changed since the preview. */
  readonly kept: readonly PruneKept[];
  readonly record: InstallRecord | undefined;
  readonly recordWritten: boolean;
}

/** Carries out a prune plan. Without `--prune` it does nothing at all. */
export async function applyPrune(input: ApplyPruneInput): Promise<ApplyPruneResult> {
  const { plan, record, fsops } = input;
  const empty: ApplyPruneResult = {
    removedFiles: [],
    removedDirs: [],
    removedVersions: [],
    removedBackups: [],
    kept: [],
    record,
    recordWritten: false,
  };
  if (!plan.requested || record === undefined) {
    return empty;
  }
  if (plan.recordUpdatedAt !== record.updatedAt) {
    throw new PruneError(
      "record-changed",
      "install.json changed after the prune preview was made; nothing was removed. Run the command again.",
    );
  }
  const fs = input.fs ?? nodeFs;
  const now = input.now ?? new Date();

  const removedFiles: string[] = [];
  const removedDirs: string[] = [];
  const kept: PruneKept[] = [];
  const goneVersionDirs = new Set<string>();
  const goneBackupDirs = new Set<string>();

  for (const version of plan.versions) {
    kept.push(...version.kept);
    if (version.decision === "keep") {
      continue;
    }
    for (const file of version.deleteFiles) {
      const outcome = await removeFile(fsops, fs, file.path, file.sha256);
      if (outcome === "removed") {
        removedFiles.push(file.path);
      } else {
        kept.push({ path: file.path, reason: outcome });
      }
    }
    removedDirs.push(...(await removeEmptyDirs(fsops, version.dirs)));
    if ((await entryType(fsops, fs, version.dir)) === "missing") {
      goneVersionDirs.add(normalizeDir(version.dir));
    }
  }

  for (const backup of plan.backups) {
    kept.push(...backup.kept);
    if (backup.decision === "keep") {
      continue;
    }
    for (const path of backup.deleteFiles) {
      const outcome = await removeFile(fsops, fs, path, undefined);
      if (outcome === "removed") {
        removedFiles.push(path);
      } else {
        kept.push({ path, reason: outcome });
      }
    }
    removedDirs.push(...(await removeEmptyDirs(fsops, backup.dirs)));
    if ((await entryType(fsops, fs, backup.dir)) === "missing") {
      goneBackupDirs.add(normalizeDir(backup.dir));
    }
  }

  const removedFileSet = new Set(removedFiles);
  const underGoneVersion = (path: string): boolean =>
    [...goneVersionDirs].some((dir) => path.startsWith(`${dir}/`));
  const files = record.files.filter((file) => !removedFileSet.has(file.path) && !underGoneVersion(file.path));
  const removedVersions = record.versions.filter((v) => goneVersionDirs.has(normalizeDir(v.dir)) && !v.active);
  const versions = record.versions.filter((v) => !removedVersions.includes(v));
  const removedBackups = record.backups.filter((b) => goneBackupDirs.has(normalizeDir(b.dir)));
  const backups = record.backups.filter((b) => !removedBackups.includes(b));

  const changed =
    files.length !== record.files.length ||
    versions.length !== record.versions.length ||
    backups.length !== record.backups.length;
  if (!changed) {
    return { ...empty, removedFiles, removedDirs, kept };
  }

  const next: InstallRecord = { ...record, updatedAt: toIsoUtc(now), files, versions, backups };
  await writeRecord(fsops, next);
  return { removedFiles, removedDirs, removedVersions, removedBackups, kept, record: next, recordWritten: true };
}

// ---------------------------------------------------------------------------
// Planning

async function planVersions(
  record: InstallRecord,
  fsops: FsOps,
  fs: NodeFsApi,
  keepVersions: ReadonlySet<string>,
): Promise<PruneVersionPlan[]> {
  const pluginDirs = pluginDirCandidates(record, fs);
  const isRegistered = (dir: string): boolean =>
    [resolve(record.installHome, dir), resolve(fsops.root, dir)].some((candidate) => pluginDirs.has(candidate));

  // A directory is protected when any entry naming it is protected.
  const protectedDirs = new Map<string, PruneReason>();
  for (const version of record.versions) {
    const dir = normalizeDir(version.dir);
    const reason: PruneReason | undefined = version.active
      ? "active-version"
      : isRegistered(dir)
        ? "registered-with-paseo"
        : keepVersions.has(version.version)
          ? "current-install"
          : undefined;
    if (reason !== undefined && !protectedDirs.has(dir)) {
      protectedDirs.set(dir, reason);
    }
  }
  for (const name of keepVersions) {
    const dir = posix.join("plugin", name);
    if (!protectedDirs.has(dir)) {
      protectedDirs.set(dir, "current-install");
    }
  }
  const anchored = record.versions.some((v) => v.active || isRegistered(normalizeDir(v.dir)));

  const recorded = new Map(record.files.map((file) => [file.path, file]));
  const plans: PruneVersionPlan[] = [];
  const seen = new Set<string>();

  for (const version of record.versions) {
    const dir = normalizeDir(version.dir);
    const keep = (reason: PruneReason): PruneVersionPlan => ({
      version: version.version,
      dir: version.dir,
      decision: "keep",
      reason,
      deleteFiles: [],
      dirs: [],
      kept: [],
    });

    if (!isDirectChild(dir, "plugin")) {
      plans.push(keep("unexpected-location"));
      continue;
    }
    const guard = protectedDirs.get(dir);
    if (guard !== undefined) {
      plans.push(keep(guard));
      continue;
    }
    if (!anchored) {
      plans.push(keep("no-active-version"));
      continue;
    }
    if (seen.has(dir)) {
      // A duplicate entry for a directory already planned: it leaves with it.
      plans.push({ ...keep("old-version"), decision: "forget" });
      continue;
    }
    seen.add(dir);

    const type = await entryType(fsops, fs, dir);
    if (type === "missing") {
      plans.push({ ...keep("missing-on-disk"), decision: "forget" });
      continue;
    }
    if (type !== "directory") {
      plans.push(keep(type === "symlink" ? "symlink" : "not-a-directory"));
      continue;
    }

    const walked = await walk(fsops, dir);
    const deleteFiles: FileRecord[] = [];
    const kept: PruneKept[] = [...walked.odd];
    for (const path of walked.files) {
      const entry = recorded.get(path);
      if (entry === undefined) {
        kept.push({ path, reason: "unrecorded" });
      } else if ((await fsops.hashFile(fsops.resolvePath(path))) === entry.sha256) {
        deleteFiles.push(entry);
      } else {
        kept.push({ path, reason: "user-modified" });
      }
    }

    if (kept.length === 0) {
      plans.push({ version: version.version, dir: version.dir, decision: "delete", reason: "old-version", deleteFiles, dirs: walked.dirs, kept });
    } else if (deleteFiles.length > 0) {
      plans.push({ version: version.version, dir: version.dir, decision: "partial", reason: "old-version", deleteFiles, dirs: walked.dirs, kept });
    } else {
      plans.push({ ...keep(kept[0]!.reason), kept });
    }
  }
  return plans;
}

async function planBackups(
  record: InstallRecord,
  fsops: FsOps,
  fs: NodeFsApi,
  keepBackups: ReadonlySet<string>,
): Promise<PruneBackupPlan[]> {
  const plans: PruneBackupPlan[] = [];
  const seen = new Set<string>();
  const latestConfig = await latestConfigBackupDir(record, fsops, fs);

  for (const backup of record.backups) {
    const dir = normalizeDir(backup.dir);
    const keep = (reason: PruneReason, kept: readonly PruneKept[] = []): PruneBackupPlan => ({
      dir: backup.dir,
      at: backup.at,
      backupReason: backup.reason,
      decision: "keep",
      reason,
      deleteFiles: [],
      dirs: [],
      kept,
    });

    if (!isDirectChild(dir, "backups")) {
      plans.push(keep("unexpected-location"));
      continue;
    }
    if (keepBackups.has(dir)) {
      plans.push(keep("current-backup"));
      continue;
    }
    if (dir === latestConfig) {
      // Every entry naming this directory keeps it, duplicates included.
      plans.push(keep("latest-config-backup"));
      continue;
    }
    if (seen.has(dir)) {
      plans.push({ ...keep("backup"), decision: "forget" });
      continue;
    }
    seen.add(dir);

    const type = await entryType(fsops, fs, dir);
    if (type === "missing") {
      plans.push({ ...keep("missing-on-disk"), decision: "forget" });
      continue;
    }
    if (type !== "directory") {
      plans.push(keep(type === "symlink" ? "symlink" : "not-a-directory"));
      continue;
    }
    const walked = await walk(fsops, dir);
    if (walked.odd.length > 0) {
      // A backup is only ever regular files; anything else means it is not
      // what paseo-bm wrote, so the whole backup stays.
      plans.push(keep(walked.odd[0]!.reason, walked.odd));
      continue;
    }
    plans.push({
      dir: backup.dir,
      at: backup.at,
      backupReason: backup.reason,
      decision: "delete",
      reason: "backup",
      deleteFiles: walked.files,
      dirs: walked.dirs,
      kept: [],
    });
  }
  return plans;
}

/**
 * The recorded backup directory holding the newest Paseo config copy: a regular
 * `<dir>/paseo-config.json`, reached without a symlink. Newest by `at`; on a tie
 * (or an unparseable `at`), the larger directory name wins. `undefined` when no
 * recorded backup holds one.
 */
async function latestConfigBackupDir(record: InstallRecord, fsops: FsOps, fs: NodeFsApi): Promise<string | undefined> {
  let best: { dir: string; at: number } | undefined;
  const holdsConfig = new Map<string, boolean>();
  for (const backup of record.backups) {
    const dir = normalizeDir(backup.dir);
    if (!isDirectChild(dir, "backups")) {
      continue;
    }
    if (!holdsConfig.has(dir)) {
      holdsConfig.set(dir, (await entryType(fsops, fs, posix.join(dir, CONFIG_BACKUP_NAME))) === "file");
    }
    if (holdsConfig.get(dir) !== true) {
      continue;
    }
    const parsed = Date.parse(backup.at);
    const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (best === undefined || at > best.at || (at === best.at && dir > best.dir)) {
      best = { dir, at };
    }
  }
  return best?.dir;
}

/** Entries directly under `plugin/` or `backups/` that the record does not name. */
async function listUnrecorded(fsops: FsOps, parent: string, known: ReadonlySet<string>): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(fsops.resolvePath(parent), { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || error instanceof PathGuardError) {
      return [];
    }
    throw error;
  }
  return entries
    .map((entry) => posix.join(parent, entry.name))
    .filter((path) => !known.has(path))
    .sort();
}

interface Walked {
  /** Regular files, relative to the install home, sorted. */
  readonly files: string[];
  /** Directories, deepest first, the starting directory last. */
  readonly dirs: string[];
  /** Symlinks and special files. Never followed. */
  readonly odd: PruneKept[];
}

async function walk(fsops: FsOps, start: string): Promise<Walked> {
  const files: string[] = [];
  const dirs: string[] = [];
  const odd: PruneKept[] = [];

  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(fsops.resolvePath(dir), { withFileTypes: true });
    for (const entry of entries) {
      const path = posix.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        odd.push({ path, reason: "symlink" });
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        odd.push({ path, reason: "not-a-regular-file" });
      }
    }
    dirs.push(dir);
  };

  await visit(start);
  files.sort();
  odd.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, dirs, odd };
}

function finish(plan: Omit<PrunePlan, "actions" | "summary">): PrunePlan {
  const actions = pruneActions(plan);
  return { ...plan, actions, summary: summarizeActions(actions) };
}

/** The plan as report actions: every removed backup file is listed, since that loss is final. */
function pruneActions(plan: Omit<PrunePlan, "actions" | "summary">): FileAction[] {
  const actions: FileAction[] = [];
  const action = (kind: "delete" | "keep", path: string, reason: PruneReason, detail?: string): void => {
    actions.push({
      kind,
      location: "install-home",
      target: installHomeLabel(path),
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  for (const version of plan.versions) {
    switch (version.decision) {
      case "delete":
        action("delete", version.dir, "old-version", `payload ${version.version}, ${version.deleteFiles.length} file(s); reinstall with npx to get it back`);
        break;
      case "partial":
        for (const file of version.deleteFiles) {
          action("delete", file.path, "old-version", `payload ${version.version}`);
        }
        action("keep", version.dir, version.kept[0]!.reason, "the directory stays because it holds files paseo-bm will not remove");
        break;
      case "forget":
        action("delete", version.dir, version.reason, "already gone from disk; only the install.json entry is removed");
        break;
      case "keep":
        action("keep", version.dir, version.reason);
        break;
    }
    for (const entry of version.kept) {
      action("keep", entry.path, entry.reason);
    }
  }

  for (const backup of plan.backups) {
    const origin = `backup taken ${backup.at} (${backup.backupReason})`;
    switch (backup.decision) {
      case "delete":
        for (const path of backup.deleteFiles) {
          action("delete", path, "backup", `cannot be undone: part of the ${origin}`);
        }
        action("delete", backup.dir, "backup", `cannot be undone: the ${origin}`);
        break;
      case "forget":
        action("delete", backup.dir, backup.reason, "already gone from disk; only the install.json entry is removed");
        break;
      case "keep":
        action(
          "keep",
          backup.dir,
          backup.reason,
          backup.reason === "latest-config-backup"
            ? `${origin}; the newest copy of the Paseo config, kept so uninstall --restore-backups can still restore it`
            : origin,
        );
        break;
    }
    for (const entry of backup.kept) {
      action("keep", entry.path, entry.reason);
    }
  }

  for (const path of plan.unrecorded) {
    action("keep", path, "unrecorded", "not listed in install.json; left untouched");
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Applying

type RemoveOutcome = "removed" | Extract<PruneReason, "changed-since-preview" | "symlink">;

/**
 * Removes one file, after checking again that it is a regular file reached
 * without a symlink and, for payload files, that its bytes still match the
 * record. A file already gone counts as removed.
 */
async function removeFile(
  fsops: FsOps,
  fs: NodeFsApi,
  path: string,
  expectedSha256: string | undefined,
): Promise<RemoveOutcome> {
  let absolute: string;
  try {
    absolute = fsops.resolvePath(path);
  } catch (error) {
    if (error instanceof PathGuardError) {
      return "symlink";
    }
    throw error;
  }
  const type = await entryType(fsops, fs, path);
  if (type === "missing") {
    return "removed";
  }
  if (type !== "file") {
    return "changed-since-preview";
  }
  if (expectedSha256 !== undefined && (await fsops.hashFile(absolute)) !== expectedSha256) {
    return "changed-since-preview";
  }
  await fs.unlink(absolute);
  return "removed";
}

/** `rmdir` each directory, deepest first. A non-empty or missing one is left. */
async function removeEmptyDirs(fsops: FsOps, dirs: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of dirs) {
    try {
      await rmdir(fsops.resolvePath(dir));
      removed.push(dir);
    } catch (error) {
      if (
        isErrno(error, "ENOTEMPTY") ||
        isErrno(error, "EEXIST") ||
        isErrno(error, "ENOENT") ||
        isErrno(error, "ENOTDIR") ||
        error instanceof PathGuardError
      ) {
        continue;
      }
      throw error;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Helpers

type EntryType = "missing" | "file" | "directory" | "symlink" | "other";

/** What is at a recorded path, without following a symlink anywhere on the way. */
async function entryType(fsops: FsOps, fs: NodeFsApi, path: string): Promise<EntryType> {
  let absolute: string;
  try {
    absolute = fsops.resolvePath(path);
  } catch (error) {
    if (error instanceof PathGuardError && error.reason === "symlink-in-path") {
      return "symlink";
    }
    throw error;
  }
  try {
    const stats = await fs.lstat(absolute);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return "other";
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      return "missing";
    }
    throw error;
  }
}

/** `paseo.pluginDir`, as given and resolved through symlinks. */
function pluginDirCandidates(record: InstallRecord, fs: NodeFsApi): Set<string> {
  const pluginDir = record.paseo.pluginDir;
  if (pluginDir === null) {
    return new Set();
  }
  return new Set([resolve(pluginDir), canonicalPath(pluginDir, fs)]);
}

function normalizeDir(dir: string): string {
  return posix.normalize(dir).replace(/\/+$/, "");
}

/** True for `parent/<one segment>` and nothing else. */
function isDirectChild(dir: string, parent: string): boolean {
  const parts = dir.split("/");
  return parts.length === 2 && parts[0] === parent && parts[1] !== undefined && parts[1] !== "" && parts[1] !== "." && parts[1] !== "..";
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
