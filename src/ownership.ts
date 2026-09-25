/**
 * Ownership classification — Technical Design §5.3, ADR-002 decisions 1 and 4.
 *
 * Every destination paseo-bm may write to is put into exactly one of five
 * states by comparing three things: the install record (`files[]`, the single
 * source of truth about ownership), the bytes actually on disk, and the bytes
 * the current payload wants to put there.
 *
 * | state           | condition                                          | default |
 * |-----------------|----------------------------------------------------|---------|
 * | `unchanged`     | recorded, disk hash == recorded hash == payload     | skip    |
 * | `outdated`      | recorded, disk hash == recorded hash != payload     | update  |
 * | `user-modified` | recorded, disk hash != recorded hash                | ask     |
 * | `conflict`      | on disk, not recorded                               | report  |
 * | `missing`       | nothing on disk                                     | create  |
 *
 * Three properties are worth stating because the rest of the installer leans
 * on them:
 *
 * 1. **Hash only.** Never mtime, never size. Both are destroyed by a copy, a
 *    `git checkout` or a package extraction, and neither says anything about
 *    content. A sha256 comparison is the only evidence used here.
 * 2. **Nothing is written.** This module reads. It is what lets `install` and
 *    `install --apply` share one code path: the preview is the classification,
 *    and the applier acts on it (Design §9, REQ-009).
 * 3. **The real reach of the three conflicting states is small.** An upgrade
 *    always copies into `plugin/<new version>/`, so on the upgrade path every
 *    destination is `missing` and nothing can be in the way. `outdated`,
 *    `user-modified` and `conflict` only happen when the *same* version is
 *    installed again, when a file inside the active version directory is
 *    repaired, or for `install.json` itself (ADR-002 decision 4). There is
 *    deliberately no keep/overwrite flow for upgrades — it would be dead code.
 *
 * A note on `missing`: the §5.3 table words it as "recorded but gone from
 * disk", yet the same section's scope note says every destination on the
 * upgrade path — which is recorded nowhere yet — is `missing` too, and the
 * §4.4 example carries `{"kind": "create", "reason": "missing"}` for exactly
 * such a file. So "nothing is on disk" is the condition, and
 * {@link Ownership.recorded} tells the two apart when a caller cares.
 */

import { FILE_MODE } from "./fsops.js";
import type { FsOps } from "./fsops.js";
import type { NodeFsApi } from "./fs-guard.js";
import { nodeFs } from "./fs-guard.js";
import type { ActionLocation, FileAction, FileStatusReason } from "./action.js";
import { FILE_STATUS_REASONS } from "./action.js";
import type { FileRecord, InstallRecord } from "./record.js";
import { resolveRecordedPath } from "./record.js";

/**
 * The five states of Design §5.3. Identical to the file reasons an `Action`
 * carries, on purpose: a classification turns into a report line without a
 * second vocabulary in between.
 */
export type OwnershipStatus = FileStatusReason;

/** The five states, in the order of the §5.3 table. */
export const OWNERSHIP_STATUSES: readonly OwnershipStatus[] = FILE_STATUS_REASONS;

/**
 * Reason string for the one case that is not a §5.3 state: content is already
 * correct but the permission bits are not. `src/fsops.ts` already calls that
 * outcome `mode-changed`; the same word is reused rather than invented again.
 */
export const MODE_CHANGED_REASON = "mode-changed";

/** What is at a path right now. `sha256` is the only evidence used. */
export interface DiskState {
  /** False when nothing is at the path at all. */
  readonly present: boolean;
  /** False for a directory, a symlink, a socket — anything not a regular file. */
  readonly isFile: boolean;
  /** Lowercase hex sha256 of the bytes on disk; `undefined` when unreadable. */
  readonly sha256: string | undefined;
  /** Permission bits on disk, masked to `0o7777`; `undefined` when absent. */
  readonly mode: number | undefined;
}

/** Nothing is there. */
export const ABSENT: DiskState = { present: false, isFile: false, sha256: undefined, mode: undefined };

/** One destination to classify. */
export interface OwnershipTarget {
  /** Path relative to the install home, spelled exactly as `files[]` spells it. */
  readonly path: string;
  /**
   * sha256 of the bytes the payload wants at this path. `undefined` means the
   * caller is only asking "is this still ours" (uninstall, `doctor`), and then
   * a recorded file that matches its record is `unchanged`.
   */
  readonly expectedSha256?: string | undefined;
  /** Mode paseo-bm intends this file to have. Defaults to `FILE_MODE` (0600). */
  readonly expectedMode?: number | undefined;
  /**
   * Baseline to compare against, overriding the `files[]` lookup. This exists
   * for `install.json`, which is a destination paseo-bm owns but which the
   * record cannot list inside itself (Design §5.3, "or `install.json` itself").
   */
  readonly recorded?: FileRecord | undefined;
  /** Report location; defaults to `install-home`. */
  readonly location?: ActionLocation | undefined;
  /** Report label; defaults to `installHome/<path>` (Design §4.4). */
  readonly label?: string | undefined;
}

/** One classified destination. */
export interface Ownership {
  /** The target's path, relative to the install home. */
  readonly path: string;
  /** Absolute path that was inspected. */
  readonly absolutePath: string;
  /** The §4.4 label, e.g. `installHome/plugin/0.1.0/roles/worker.md`. */
  readonly target: string;
  readonly location: ActionLocation;
  readonly status: OwnershipStatus;
  /** The `files[]` entry this was compared against; `undefined` when unowned. */
  readonly recorded: FileRecord | undefined;
  readonly disk: DiskState;
  readonly expectedSha256: string | undefined;
  readonly expectedMode: number;
  /** True when the bytes on disk are already the bytes the payload wants. */
  readonly contentMatchesExpected: boolean;
  /** True when the permission bits on disk are already the intended ones. */
  readonly modeMatchesExpected: boolean;
  /** One extra sentence for the human report; `null` when there is nothing to add. */
  readonly detail: string | null;
}

/** Input of the pure classifier: one target, its record entry, its disk state. */
export interface ClassifyInput {
  readonly target: OwnershipTarget;
  /** The `files[]` entry, already looked up. `target.recorded` wins over it. */
  readonly recorded?: FileRecord | undefined;
  readonly disk: DiskState;
  /** Absolute path that was inspected; defaults to the target's own path. */
  readonly absolutePath?: string | undefined;
}

/** `installHome/plugin/0.1.0/roles/worker.md` — the §4.4 way to name a target. */
export function installHomeLabel(relativePath: string): string {
  return `installHome/${relativePath.split(/[\\/]/).filter((part) => part.length > 0).join("/")}`;
}

/** The `files[]` entry for a path, or `undefined` when paseo-bm does not own it. */
export function findRecordedFile(record: InstallRecord | undefined, path: string): FileRecord | undefined {
  return record?.files.find((file) => file.path === path);
}

/**
 * The whole of Design §5.3, as one pure function.
 *
 * The order of the tests is the meaning of the table. "Nothing on disk" comes
 * first because there is then nothing to be in the way and nothing to lose;
 * "not ours" comes next, because an unrecorded file is never overwritten
 * whatever it contains; only then does the hash decide between the three
 * states that need a record to exist.
 */
export function classifyOwnership(input: ClassifyInput): Ownership {
  const { target, disk } = input;
  const recorded = target.recorded ?? input.recorded;
  const expectedMode = target.expectedMode ?? FILE_MODE;
  const expectedSha256 = target.expectedSha256;

  const contentMatchesExpected = expectedSha256 !== undefined && disk.sha256 === expectedSha256;
  const modeMatchesExpected = disk.mode !== undefined && (disk.mode & 0o7777) === expectedMode;

  const base = {
    path: target.path,
    absolutePath: input.absolutePath ?? target.path,
    target: target.label ?? installHomeLabel(target.path),
    location: target.location ?? ("install-home" as ActionLocation),
    recorded,
    disk,
    expectedSha256,
    expectedMode,
    contentMatchesExpected,
    modeMatchesExpected,
  };

  if (!disk.present) {
    return {
      ...base,
      status: "missing",
      detail:
        recorded === undefined
          ? "not installed yet"
          : "recorded as installed but no longer on disk",
    };
  }

  if (!disk.isFile) {
    return {
      ...base,
      status: "conflict",
      detail: "something that is not a regular file is in the way",
    };
  }

  if (recorded === undefined) {
    return { ...base, status: "conflict", detail: "present on disk but not recorded as ours" };
  }

  if (disk.sha256 !== recorded.sha256) {
    return {
      ...base,
      status: "user-modified",
      detail: contentMatchesExpected
        ? "edited since it was installed; the edit happens to match the new payload"
        : "edited since it was installed",
    };
  }

  if (expectedSha256 !== undefined && expectedSha256 !== recorded.sha256) {
    return { ...base, status: "outdated", detail: "installed by an older payload" };
  }

  return {
    ...base,
    status: "unchanged",
    detail: modeMatchesExpected || expectedSha256 === undefined ? null : "permissions differ from the intended ones",
  };
}

/** How to read what is at a path. Reading only — this module never writes. */
export interface DiskReader {
  /** Inspects one absolute path. Absence is a value, never an exception. */
  read(absolutePath: string): Promise<DiskState>;
}

export interface DiskReaderOptions {
  /** Supplies the hash; `FsOps.hashFile` is reused rather than re-implemented. */
  readonly fsops: FsOps;
  /** The filesystem seam, for the `lstat` that gives the mode. */
  readonly fs?: NodeFsApi;
}

/**
 * A reader built on the fs helper. `hashFile` already returns `undefined` for
 * a path that is not there, and `lstat` — not `stat` — is what decides
 * `isFile`, so a symlink pointing at one of our own files is still reported as
 * something that is in the way.
 */
export function createDiskReader(options: DiskReaderOptions): DiskReader {
  const fs = options.fs ?? nodeFs;
  return {
    async read(absolutePath: string): Promise<DiskState> {
      let mode: number;
      let isFile: boolean;
      try {
        const stats = await fs.lstat(absolutePath);
        mode = stats.mode & 0o7777;
        isFile = stats.isFile();
      } catch (error) {
        if (isErrnoCode(error, "ENOENT") || isErrnoCode(error, "ENOTDIR")) {
          return ABSENT;
        }
        throw error;
      }
      if (!isFile) {
        return { present: true, isFile: false, sha256: undefined, mode };
      }
      return { present: true, isFile: true, sha256: await options.fsops.hashFile(absolutePath), mode };
    },
  };
}

export interface InspectOwnershipInput {
  /** The install home every target path is relative to. */
  readonly installHome: string;
  /** The record; `undefined` on a first install, where nothing is owned yet. */
  readonly record?: InstallRecord | undefined;
  readonly targets: readonly OwnershipTarget[];
  readonly reader: DiskReader;
}

/**
 * Classifies a list of destinations. This is the only asynchronous part: it
 * reads the disk once per target and then applies the pure classifier.
 */
export async function inspectOwnership(input: InspectOwnershipInput): Promise<readonly Ownership[]> {
  const result: Ownership[] = [];
  for (const target of input.targets) {
    const absolutePath = resolveRecordedPath(input.installHome, target.path);
    result.push(
      classifyOwnership({
        target,
        recorded: findRecordedFile(input.record, target.path),
        disk: await input.reader.read(absolutePath),
        absolutePath,
      }),
    );
  }
  return result;
}

/** Options of the default-action mapping — the third column of Design §5.3. */
export interface DefaultActionOptions {
  /**
   * `--force`: overwrite a `user-modified` file. A backup is always taken
   * first, which is the applier's job, not this function's (Design §4.2).
   */
  readonly force?: boolean;
}

/**
 * The default action for a classification, straight from the Design §5.3 table.
 *
 * The one row the table does not have is a file whose content is already right
 * but whose permission bits are not. That is an `update` with the reason
 * `mode-changed`, not a `skip`: a `chmod` changes the user's machine and so it
 * has to appear in the preview instead of happening quietly. It does not cost
 * the "same version again produces zero actions" promise of Design §9, because a run
 * that wrote those files wrote them `0600` in the first place, so there is no
 * drift to fix.
 *
 * `user-modified` maps to the `conflict` kind (exit code 5) and not to a
 * decision: asking the question belongs to the command flow, not here.
 */
export function defaultInstallAction(ownership: Ownership, options: DefaultActionOptions = {}): FileAction {
  const common = { target: ownership.target, location: ownership.location };
  const detail = ownership.detail ?? undefined;

  switch (ownership.status) {
    case "missing":
      return { ...common, kind: "create", reason: "missing", ...(detail === undefined ? {} : { detail }) };

    case "outdated":
      return { ...common, kind: "update", reason: "outdated", ...(detail === undefined ? {} : { detail }) };

    case "conflict":
      return { ...common, kind: "conflict", reason: "conflict", ...(detail === undefined ? {} : { detail }) };

    case "user-modified":
      return options.force === true
        ? {
            ...common,
            kind: "update",
            reason: "user-modified",
            detail: "overwritten because --force was given; the previous file is backed up first",
          }
        : { ...common, kind: "conflict", reason: "user-modified", ...(detail === undefined ? {} : { detail }) };

    case "unchanged":
      if (ownership.expectedSha256 !== undefined && !ownership.modeMatchesExpected) {
        return {
          ...common,
          kind: "update",
          reason: MODE_CHANGED_REASON,
          detail: `permissions are ${formatMode(ownership.disk.mode)}, paseo-bm writes ${formatMode(ownership.expectedMode)}`,
        };
      }
      return { ...common, kind: "skip", reason: "unchanged" };
  }
}

/** Counts per state, plus the one question a caller actually asks. */
export interface OwnershipSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<OwnershipStatus, number>>;
  /** True when at least one destination needs a human decision (§4.3, code 5). */
  readonly needsDecision: boolean;
}

export function summarizeOwnership(entries: readonly Ownership[]): OwnershipSummary {
  const byStatus: Record<OwnershipStatus, number> = {
    unchanged: 0,
    outdated: 0,
    "user-modified": 0,
    conflict: 0,
    missing: 0,
  };
  for (const entry of entries) {
    byStatus[entry.status] += 1;
  }
  return {
    total: entries.length,
    byStatus,
    needsDecision: byStatus["user-modified"] + byStatus.conflict > 0,
  };
}

/** `0600`, the way a permission mismatch is written in a report. */
function formatMode(mode: number | undefined): string {
  return mode === undefined ? "unknown" : `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
