/**
 * The one way paseo-bm is allowed to write to disk (ADR-002, Design §9).
 *
 * Three properties carry the whole interruption-safety story, because ADR-002
 * deliberately has no transaction journal and no global rollback:
 *
 * 1. **Atomic per file.** Content goes to a temporary file *in the destination
 *    directory*, is `fsync`ed, and only then `rename`d over the target. Same
 *    directory is not a style choice: `rename` is only atomic within one
 *    filesystem. Anything that fails before the `rename` leaves the previous
 *    file byte-for-byte intact and removes the temporary file.
 * 2. **Never remove then re-write.** That is the paseo-room weakness ADR-002
 *    exists to eliminate; there is no code path here that unlinks a target.
 * 3. **Only write when the bytes differ.** The sha256 is compared first, so a
 *    re-run of the same version does not touch the file at all — this is what
 *    makes the installer idempotent (REQ-009).
 *
 * Permissions follow ADR-002 decision 8: directories `0700`, files `0600`.
 *
 * Every write goes through the path guard with a *canonical* root: the install
 * home is `realpath`ed once when the helper is created. Without that, a root
 * under `os.tmpdir()` on macOS (`/var` -> `/private/var`) would be rejected by
 * the symlink check for a symlink that is the operating system's, not ours.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { NodeFsApi } from "./fs-guard.js";
import { atomicTempPath, canonicalPath, nodeFs } from "./fs-guard.js";
import { PathGuardError, assertSafeWritePath, isWithinRoot } from "./paths-guard.js";

/** Mode every directory paseo-bm creates gets (ADR-002 decision 8). */
export const DIR_MODE = 0o700;

/** Mode every file paseo-bm writes gets (ADR-002 decision 8). */
export const FILE_MODE = 0o600;

/** Why an fs operation was refused before it touched anything. */
export type FsOpsErrorReason = "target-not-a-file" | "backup-source-outside-base";

/**
 * A refusal raised by this module. Like `PathGuardError` these reasons are
 * internal: the diagnostic registry in Design §4.4 has no code for them, so the
 * calling command maps them onto whichever code fits its own contract.
 */
export class FsOpsError extends Error {
  readonly reason: FsOpsErrorReason;
  /** The path the operation was about, already resolved. */
  readonly path: string;

  constructor(reason: FsOpsErrorReason, message: string, path: string) {
    super(message);
    this.name = "FsOpsError";
    this.reason = reason;
    this.path = path;
  }
}

/** What a write did. `unchanged` and `mode-changed` never replace bytes. */
export type WriteOutcome = "created" | "updated" | "unchanged" | "mode-changed";

export interface WriteResult {
  /** The resolved target path. */
  readonly path: string;
  /** sha256 of the content that is on disk now, lowercase hex. */
  readonly sha256: string;
  /** Permission bits on disk now. */
  readonly mode: number;
  readonly outcome: WriteOutcome;
  /** True only when a temporary file was renamed over the target. */
  readonly rewritten: boolean;
}

export interface WriteOptions {
  /** Defaults to `FILE_MODE`. */
  mode?: number;
}

export interface BackupOptions {
  /** This backup run's directory, e.g. `<install home>/backups/<stamp>/`. */
  backupDir: string;
  /**
   * Base the source path is made relative to, so the backup keeps the same
   * relative path (ADR-002 decision 5). Defaults to the install home.
   */
  relativeTo?: string;
  /**
   * Explicit relative destination inside `backupDir`, for sources that do not
   * live under `relativeTo` — Paseo's `config.json` is backed up as
   * `paseo-config.json` (Design §5.1).
   */
  as?: string;
}

export interface FsOpsOptions {
  /** The install home. Everything this helper writes stays inside it. */
  root: string;
  /**
   * The filesystem seam (`src/fs-guard.ts`). Defaults to the real filesystem;
   * tests inject a guarded one so an out-of-scope write fails the test instead
   * of reaching the disk (Design §11, M-4).
   */
  fs?: NodeFsApi;
}

export interface FsOps {
  /** The install home, resolved and `realpath`ed once. */
  readonly root: string;
  /** Resolves against the root and refuses anything that escapes it. */
  resolvePath(...segments: readonly string[]): string;
  /** Creates `target` and any missing parent inside the root, mode `0700`. */
  ensureDir(target: string, mode?: number): Promise<string>;
  /** Sets permission bits on an existing path inside the root. */
  chmodPath(target: string, mode: number): Promise<void>;
  /** sha256 of a file, or `undefined` when it does not exist. */
  hashFile(target: string): Promise<string | undefined>;
  /** Writes atomically, and only when the bytes actually differ. */
  writeFileAtomic(target: string, data: string | Uint8Array, options?: WriteOptions): Promise<WriteResult>;
  /** Copies a file into a backup directory, or `undefined` if it is not there. */
  backupFile(source: string, options: BackupOptions): Promise<string | undefined>;
}

/** sha256 of in-memory content, lowercase hex. */
export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(toBuffer(data)).digest("hex");
}

/**
 * The `<timestamp>` segment of a backup directory, e.g. `20260915T101500Z`
 * (Design §5.1). Second resolution, UTC, safe as a directory name.
 */
export function backupStamp(at: Date = new Date()): string {
  return `${at.toISOString().split(".")[0]!.replace(/[-:]/g, "")}Z`;
}

/**
 * Resolves a root through symlinks without requiring it to exist yet: the
 * deepest existing ancestor is `realpath`ed and the not-yet-created segments
 * are appended. Called once per helper so the symlink guard only ever inspects
 * segments below the root (see the module comment).
 */
export function canonicalRoot(input: string, fs: NodeFsApi = nodeFs): string {
  return canonicalPath(input, fs);
}

/** Creates the fs helper bound to one install home. */
export function createFsOps(options: FsOpsOptions): FsOps {
  const fs = options.fs ?? nodeFs;
  const root = canonicalRoot(options.root, fs);
  const declaredRoot = resolve(options.root);

  /**
   * Callers build their paths from the install home as it was configured, which
   * may still travel through a symlink (`/var/...` instead of `/private/var/...`
   * on macOS). Anything under that declared root is the same location as the
   * canonical root, so it is rebased instead of being refused. Paths elsewhere
   * are left alone and fall to the guard.
   */
  const rebase = (candidate: string): string => {
    if (declaredRoot === root || !isWithinRoot(declaredRoot, candidate)) {
      return candidate;
    }
    const rest = relative(declaredRoot, candidate);
    return rest.length === 0 ? root : resolve(root, rest);
  };

  const resolvePath = (...segments: readonly string[]): string =>
    assertSafeWritePath(root, rebase(resolve(root, ...segments)));

  const ensureDir = async (target: string, mode: number = DIR_MODE): Promise<string> => {
    const resolved = resolvePath(target);
    // An existing directory needs nothing. Skipping `mkdir` keeps a write of a
    // single allowed file (Paseo's `config.json`) from issuing a `mkdir -p` on
    // a directory paseo-bm does not own. A symlink still goes through `mkdir`.
    if ((await lstatOrUndefined(fs, resolved))?.isDirectory() === true) {
      return resolved;
    }
    // `mkdir` applies the umask, so the created directories are chmod'ed back
    // to exactly `mode` afterwards.
    const created = await fs.mkdir(resolved, { recursive: true, mode });
    if (created !== undefined) {
      for (const dir of pathsFrom(created, resolved)) {
        await fs.chmod(dir, mode);
      }
    }
    return resolved;
  };

  const hashFile = async (target: string): Promise<string | undefined> => {
    const resolved = rebase(resolve(target));
    const content = await readFileOrUndefined(fs, resolved);
    return content === undefined ? undefined : sha256(content);
  };

  const writeFileAtomic = async (
    target: string,
    data: string | Uint8Array,
    writeOptions: WriteOptions = {},
  ): Promise<WriteResult> => {
    const resolved = resolvePath(target);
    const mode = writeOptions.mode ?? FILE_MODE;
    const content = toBuffer(data);
    const digest = sha256(content);

    const existing = await lstatOrUndefined(fs, resolved);
    if (existing !== undefined && !existing.isFile()) {
      throw new FsOpsError(
        "target-not-a-file",
        `Refusing to write over something that is not a regular file: ${resolved}`,
        resolved,
      );
    }

    if (existing !== undefined) {
      const current = await readFileOrUndefined(fs, resolved);
      if (current !== undefined && sha256(current) === digest) {
        // Identical content: do not touch the file at all (ADR-002 decision 3).
        const currentMode = existing.mode & 0o7777;
        if (currentMode === mode) {
          return { path: resolved, sha256: digest, mode: currentMode, outcome: "unchanged", rewritten: false };
        }
        // `chmod` fixes the permissions without rewriting content or mtime.
        await fs.chmod(resolved, mode);
        return { path: resolved, sha256: digest, mode, outcome: "mode-changed", rewritten: false };
      }
    }

    await ensureDir(dirname(resolved));
    await writeThroughTemp(fs, resolved, content, mode);

    return {
      path: resolved,
      sha256: digest,
      mode,
      outcome: existing === undefined ? "created" : "updated",
      rewritten: true,
    };
  };

  const backupFile = async (source: string, backupOptions: BackupOptions): Promise<string | undefined> => {
    const resolvedSource = rebase(resolve(source));
    const backupDir = resolvePath(backupOptions.backupDir);
    const base = rebase(resolve(backupOptions.relativeTo ?? root));

    let relativeDestination = backupOptions.as;
    if (relativeDestination === undefined) {
      if (!isWithinRoot(base, resolvedSource)) {
        throw new FsOpsError(
          "backup-source-outside-base",
          `Cannot derive a backup path for ${resolvedSource}: it is not inside ${base}. Pass \`as\` for it.`,
          resolvedSource,
        );
      }
      relativeDestination = relative(base, resolvedSource);
    }

    const destination = resolve(backupDir, relativeDestination);
    if (!isWithinRoot(backupDir, destination) || destination === backupDir) {
      throw new PathGuardError(
        "outside-root",
        `Path escapes its allowed root: ${destination} is not inside ${backupDir}`,
        destination,
        backupDir,
      );
    }

    const content = await readFileOrUndefined(fs, resolvedSource);
    if (content === undefined) {
      // Nothing to back up. Callers treat this as "there was no previous file".
      return undefined;
    }

    await ensureDir(dirname(destination));
    const result = await writeFileAtomic(destination, content);
    return result.path;
  };

  return {
    root,
    resolvePath,
    ensureDir,
    chmodPath: async (target, mode) => {
      await fs.chmod(resolvePath(target), mode);
    },
    hashFile,
    writeFileAtomic,
    backupFile,
  };
}

/**
 * temp -> fsync -> rename, with the temp file in the destination directory.
 *
 * Any failure before the `rename` removes the temp file and rethrows, so the
 * destination directory never keeps a half-written file and the previous
 * version of the target is untouched.
 */
async function writeThroughTemp(
  fs: NodeFsApi,
  target: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  const directory = dirname(target);
  const temp = atomicTempPath(target, process.pid, randomBytes(6).toString("hex"));

  let handle: FileHandle | undefined;
  try {
    // `wx` never reuses an existing file, so a stale temp can't be picked up.
    handle = await fs.open(temp, "wx", mode);
    await handle.writeFile(content);
    // The umask can strip bits from the mode given to `open`.
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, target);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }

  await syncDirectory(fs, directory);
}

/**
 * Flushes the directory entry so the rename itself survives a crash. Not every
 * platform or filesystem allows it; a refusal here does not make the write any
 * less atomic, so it is ignored.
 */
async function syncDirectory(fs: NodeFsApi, directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

/** Every directory from `from` down to `to`, inclusive. */
function pathsFrom(from: string, to: string): string[] {
  const rest = relative(from, to);
  const segments = rest.length === 0 ? [] : rest.split(sep).filter((segment) => segment.length > 0);
  const result = [from];
  let current = from;
  for (const segment of segments) {
    current = resolve(current, segment);
    result.push(current);
  }
  return result;
}

function toBuffer(data: string | Uint8Array): Buffer {
  return typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
}

async function readFileOrUndefined(fs: NodeFsApi, target: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function lstatOrUndefined(fs: NodeFsApi, target: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
