/**
 * The install applier — Technical Design §2.1, §3.1–§3.3, §8, §9.1; ADR-001,
 * ADR-002.
 *
 * "The planner does not write, the applier does not decide." This module takes
 * the `InstallPlan` the user previewed and carries out exactly the actions in
 * it that belong to the install home:
 *
 * - `create` / `update` of a payload file → copied from the package payload
 *   into `plugin/<version>/` with `writeFileAtomic` (temp → fsync → rename,
 *   0600, directories 0700). An `update` that overwrites a file the user edited
 *   (`--force` on `user-modified`) is backed up first into
 *   `backups/<stamp>/<same relative path>` (ADR-002 decision 5).
 * - `skip` / `conflict` → nothing.
 * - `install.json` → written last, and only if the plan says so.
 * - Anything outside the install home (`paseo-config`, `paseo-daemon`,
 *   `agent-skills`) → **not performed**, returned as `deferred` for the command
 *   flow and the registration/config steps to handle.
 *
 * Mandatory order (bead rule): every payload file is written **before** any of
 * them is hashed for `files[]`, and the hashes recorded are the hashes of the
 * bytes read back from disk — so the record can only ever describe what is
 * really there.
 *
 * Side-by-side install (§8, ADR-002 decision 7): a new version lands in a new
 * directory, old version directories are never touched, and `files[]` /
 * `versions[]` keep the entries of every installed version. Nothing installed
 * is ever removed here; only `--prune` may do that. The single exception is
 * garbage from an interrupted run: a directory under `plugin/` that is not in
 * `versions[]` (see {@link removePartialPayloadDirs}).
 */

import { readdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import type { Action } from "../../action.js";
import { isWritingAction } from "../../action.js";
import type { NodeFsApi } from "../../fs-guard.js";
import { nodeFs } from "../../fs-guard.js";
import type { FsOps, WriteOutcome } from "../../fsops.js";
import { DIR_MODE, FILE_MODE, backupStamp, sha256 } from "../../fsops.js";
import { installHomeLabel } from "../../ownership.js";
import type { BackupRecord, FileRecord, InstallRecord, VersionRecord } from "../../record.js";
import { createRecord, toIsoUtc, writeRecord } from "../../record.js";
import type { PayloadManifest } from "./manifest.js";
import type { InstallPlan, PayloadFile } from "./planner.js";
import { RECORD_RELATIVE_PATH, payloadDestination } from "./planner.js";

/**
 * `update` reasons that overwrite bytes the record does not vouch for, and so
 * need a backup first. `outdated` (our own, unmodified bytes) and
 * `mode-changed` (a chmod) do not.
 */
export const BACKUP_BEFORE_OVERWRITE_REASONS: readonly string[] = ["user-modified", "conflict"];

export type ApplyErrorReason =
  /** The plan was not built from this payload manifest. */
  | "plan-payload-mismatch"
  /** An install-home action kind an install plan never contains. */
  | "unsupported-action"
  /** A payload source file no longer has the hash the plan was built with. */
  | "source-changed"
  /** A written file does not read back with the expected hash. */
  | "hash-mismatch"
  /** No record exists and no Paseo home was given to create one. */
  | "missing-paseo-home";

/**
 * A refusal raised by the applier. Like `FsOpsError` these reasons are
 * internal; the command flow maps them onto the diagnostic registry.
 */
export class ApplyError extends Error {
  readonly reason: ApplyErrorReason;
  readonly target: string | undefined;

  constructor(reason: ApplyErrorReason, message: string, target?: string) {
    super(message);
    this.name = "ApplyError";
    this.reason = reason;
    this.target = target;
  }
}

export interface ApplyInstallInput {
  /** The plan exactly as `planInstall` returned it (and as it was previewed). */
  readonly plan: InstallPlan;
  /** The manifest the plan was built from; `root` is where bytes are copied from. */
  readonly payload: PayloadManifest;
  /** The record the plan was built from; `undefined` on a fresh install. */
  readonly record: InstallRecord | undefined;
  /** The install home, as configured (same value given to the planner). */
  readonly installHome: string;
  /** Required when `record` is undefined: `paseo.home` of the new record. */
  readonly paseoHome?: string | undefined;
  /** Bound to the install home; every write goes through it. */
  readonly fsops: FsOps;
  /** Filesystem seam for the non-`FsOps` operations (lstat, readFile, rm). */
  readonly fs?: NodeFsApi | undefined;
  /** Clock; tests pass a fixed instant. */
  readonly now?: Date | undefined;
}

export interface AppliedAction {
  readonly action: Action;
  readonly outcome: WriteOutcome;
  /** Absolute path of the backup taken before this write, if any. */
  readonly backup?: string;
}

export interface ApplyInstallResult {
  /** Actions carried out, in plan order. */
  readonly applied: readonly AppliedAction[];
  /** `skip` / `conflict` actions, left alone. */
  readonly untouched: readonly Action[];
  /** Actions outside the install home; not performed here. */
  readonly deferred: readonly Action[];
  /** The backup directory entry added to `backups[]` by this run, if any. */
  readonly backup: BackupRecord | null;
  /** Partial payload directories removed, relative to the install home. */
  readonly removedPartialDirs: readonly string[];
  /** The record as it is on disk after this run. */
  readonly record: InstallRecord;
  readonly recordWritten: boolean;
}

interface PayloadStep {
  readonly action: Action;
  readonly file: PayloadFile;
  /** Relative to the install home, e.g. `plugin/0.1.0/roles/worker.md`. */
  readonly destination: string;
}

interface SortedActions {
  readonly payload: readonly PayloadStep[];
  readonly record: Action;
  readonly deferred: readonly Action[];
}

/** True when an action overwrites bytes that must be backed up first. */
export function needsBackup(action: Action): boolean {
  return action.kind === "update" && BACKUP_BEFORE_OVERWRITE_REASONS.includes(action.reason);
}

/** Carries out the install-home part of a plan. */
export async function applyInstall(input: ApplyInstallInput): Promise<ApplyInstallResult> {
  const { plan, payload, record, fsops } = input;
  const fs = input.fs ?? nodeFs;
  const now = input.now ?? new Date();
  const installHome = resolve(input.installHome);

  // Everything that can be refused is refused before the first write.
  const sorted = sortActions(plan, payload);
  if (record === undefined && input.paseoHome === undefined) {
    throw new ApplyError("missing-paseo-home", "A Paseo home is required to create a new install record");
  }

  const removedPartialDirs = await removePartialPayloadDirs({
    installHome,
    record,
    fsops,
    fs,
    keep: [plan.version],
  });

  const applied: AppliedAction[] = [];
  const untouched: Action[] = [];
  const backupReasons = new Set<string>();
  let backupDir: string | undefined;

  /**
   * This run's backup directory, created on first use. An existing backup
   * directory is never written into: when `backups/<stamp>` is taken (two runs
   * within one second) the first free `<stamp>-2`, `<stamp>-3`, … is used, and
   * the directory is created non-recursively so a concurrent creator makes
   * `mkdir` fail with `EEXIST` instead of merging.
   */
  const allocateBackupDir = async (): Promise<string> => {
    if (backupDir !== undefined) {
      return backupDir;
    }
    const stamp = backupStamp(now);
    await fsops.ensureDir(resolve(installHome, "backups"));
    for (let attempt = 1; ; attempt += 1) {
      const candidate = posix.join("backups", attempt === 1 ? stamp : `${stamp}-${attempt}`);
      const absolute = fsops.resolvePath(resolve(installHome), candidate);
      if (await pathExists(fs, absolute)) {
        continue;
      }
      try {
        await fs.mkdir(absolute, { recursive: false, mode: DIR_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
      await fs.chmod(absolute, DIR_MODE);
      backupDir = candidate;
      return candidate;
    }
  };

  const backupBefore = async (action: Action, relativePath: string): Promise<string | undefined> => {
    if (!needsBackup(action)) {
      return undefined;
    }
    const source = resolve(installHome, relativePath);
    if (!(await pathExists(fs, fsops.resolvePath(source)))) {
      return undefined;
    }
    const dir = await allocateBackupDir();
    const taken = await fsops.backupFile(source, {
      backupDir: resolve(installHome, dir),
      relativeTo: installHome,
    });
    if (taken !== undefined) {
      backupReasons.add(action.reason);
    }
    return taken;
  };

  // 1. Produce every payload file.
  for (const step of sorted.payload) {
    if (!isWritingAction(step.action)) {
      untouched.push(step.action);
      continue;
    }
    const bytes = await fs.readFile(join(payload.root, ...step.file.path.split("/")));
    if (sha256(bytes) !== step.file.sha256) {
      throw new ApplyError(
        "source-changed",
        `The payload file ${step.file.path} changed after the plan was made; nothing further was written`,
        step.action.target,
      );
    }
    const backup = await backupBefore(step.action, step.destination);
    const written = await fsops.writeFileAtomic(resolve(installHome, step.destination), bytes, {
      mode: step.file.mode ?? FILE_MODE,
    });
    applied.push({ action: step.action, outcome: written.outcome, ...(backup === undefined ? {} : { backup }) });
  }

  // 2. Only now hash what is on disk, for `files[]`.
  const recorded = new Map<string, FileRecord>();
  for (const step of sorted.payload) {
    if (step.action.kind === "conflict") {
      // Not ours: it stays out of the record.
      continue;
    }
    const absolute = fsops.resolvePath(step.destination);
    const digest = await fsops.hashFile(absolute);
    if (digest !== step.file.sha256) {
      throw new ApplyError(
        "hash-mismatch",
        `${step.destination} does not hold the planned payload bytes; the install record was not written`,
        step.action.target,
      );
    }
    const stats = await fs.lstat(absolute);
    recorded.set(step.destination, { path: step.destination, sha256: digest, mode: stats.mode & 0o7777 });
  }

  // 3. The record.
  const recordBackup = isWritingAction(sorted.record)
    ? await backupBefore(sorted.record, RECORD_RELATIVE_PATH)
    : undefined;

  const backup: BackupRecord | null =
    backupReasons.size === 0 || backupDir === undefined
      ? null
      : { at: toIsoUtc(now), dir: backupDir, reason: [...backupReasons].join(",") };

  const base =
    record ??
    createRecord({ version: plan.version, installHome, paseo: { home: input.paseoHome as string }, at: now });
  const next: InstallRecord = {
    ...base,
    version: plan.version,
    updatedAt: toIsoUtc(now),
    installHome,
    files: mergeFiles(base.files, recorded),
    versions: mergeVersions(base.versions, plan, now),
    backups: backup === null ? base.backups : [...base.backups, backup],
  };

  let recordWritten = false;
  let finalRecord = record ?? next;
  if (isWritingAction(sorted.record)) {
    const written = await writeRecord(fsops, next);
    applied.push({
      action: sorted.record,
      outcome: written.outcome,
      ...(recordBackup === undefined ? {} : { backup: recordBackup }),
    });
    recordWritten = true;
    finalRecord = next;
  } else {
    untouched.push(sorted.record);
  }

  return {
    applied,
    untouched,
    deferred: sorted.deferred,
    backup,
    removedPartialDirs,
    record: finalRecord,
    recordWritten,
  };
}

export interface PartialPayloadInput {
  readonly installHome: string;
  /** Without a record nothing is provably ours, so nothing is partial (ADR-002). */
  readonly record: InstallRecord | undefined;
  readonly fsops: FsOps;
  readonly fs?: NodeFsApi | undefined;
  /** Version directory names never to treat as partial. */
  readonly keep?: readonly string[] | undefined;
}

/**
 * Directories directly under `plugin/` that are not in `versions[]` — what an
 * interrupted run leaves behind (ADR-002 consequences, Design §8). Reads only.
 * Returned relative to the install home, e.g. `plugin/0.2.0`.
 */
export async function findPartialPayloadDirs(input: PartialPayloadInput): Promise<string[]> {
  if (input.record === undefined) {
    return [];
  }
  const pluginRoot = input.fsops.resolvePath(resolve(input.installHome), "plugin");
  let entries;
  try {
    entries = await readdir(pluginRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const known = new Set<string>();
  for (const version of input.record.versions) {
    known.add(posix.normalize(version.dir));
    known.add(posix.join("plugin", version.version));
  }
  const keep = new Set(input.keep ?? []);

  return entries
    .filter((entry) => entry.isDirectory() && !keep.has(entry.name))
    .map((entry) => posix.join("plugin", entry.name))
    .filter((dir) => !known.has(dir))
    .sort();
}

/** Removes what {@link findPartialPayloadDirs} finds. Returns what was removed. */
export async function removePartialPayloadDirs(input: PartialPayloadInput): Promise<string[]> {
  const fs = input.fs ?? nodeFs;
  const partial = await findPartialPayloadDirs(input);
  for (const dir of partial) {
    await fs.rm(input.fsops.resolvePath(resolve(input.installHome), dir), { recursive: true, force: true });
  }
  return partial;
}

function sortActions(plan: InstallPlan, payload: PayloadManifest): SortedActions {
  const recordTarget = installHomeLabel(RECORD_RELATIVE_PATH);
  const expected = new Map(plan.ownership.map((entry) => [entry.path, entry.expectedSha256]));
  const byTarget = new Map<string, { file: PayloadFile; destination: string }>();

  for (const file of payload.files) {
    const destination = payloadDestination(plan.version, file.path);
    const target = installHomeLabel(destination);
    if (byTarget.has(target) || expected.get(destination) !== file.sha256) {
      throw mismatch(`the plan does not describe payload file ${file.path} as it is in the manifest`, target);
    }
    byTarget.set(target, { file, destination });
  }

  const steps: PayloadStep[] = [];
  const deferred: Action[] = [];
  let recordAction: Action | undefined;

  for (const action of plan.actions) {
    if (action.location !== "install-home") {
      deferred.push(action);
      continue;
    }
    if (action.kind === "delete" || action.kind === "keep" || action.kind === "config") {
      throw new ApplyError(
        "unsupported-action",
        `An install plan cannot ${action.kind} ${action.target}`,
        action.target,
      );
    }
    if (action.target === recordTarget) {
      if (recordAction !== undefined) {
        throw mismatch("the plan lists install.json twice", action.target);
      }
      recordAction = action;
      continue;
    }
    const entry = byTarget.get(action.target);
    if (entry === undefined || steps.some((step) => step.action.target === action.target)) {
      throw mismatch(`the plan acts on ${action.target}, which is not one payload file`, action.target);
    }
    steps.push({ action, ...entry });
  }

  if (steps.length !== byTarget.size) {
    throw mismatch("the plan has no action for some payload files");
  }
  if (recordAction === undefined) {
    throw mismatch("the plan has no action for install.json");
  }
  return { payload: steps, record: recordAction, deferred };
}

function mismatch(message: string, target?: string): ApplyError {
  return new ApplyError("plan-payload-mismatch", `Refusing to apply: ${message}`, target);
}

/** Entries of every other version are kept as they are; this run's are replaced or appended. */
function mergeFiles(existing: readonly FileRecord[], updates: ReadonlyMap<string, FileRecord>): FileRecord[] {
  const replaced = new Set<string>();
  const merged = existing.map((file) => {
    const update = updates.get(file.path);
    if (update === undefined) {
      return file;
    }
    replaced.add(file.path);
    return update;
  });
  for (const [path, update] of updates) {
    if (!replaced.has(path)) {
      merged.push(update);
    }
  }
  return merged;
}

/**
 * All versions are kept. A new one is appended with `active: false`: it only
 * becomes active once Paseo has it registered, which is not this step's job.
 */
function mergeVersions(existing: readonly VersionRecord[], plan: InstallPlan, now: Date): VersionRecord[] {
  if (existing.some((version) => version.version === plan.version)) {
    return [...existing];
  }
  return [...existing, { version: plan.version, dir: plan.versionDir, installedAt: toIsoUtc(now), active: false }];
}

async function pathExists(fs: NodeFsApi, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
