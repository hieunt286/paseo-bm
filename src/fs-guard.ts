/**
 * The write scope guard (Design §7 "Phạm vi ghi của trình cài đặt", §10 layer
 * "Bất biến an toàn", ADR-003 decision 1).
 *
 * paseo-bm may create, change or delete exactly two things on the machine:
 *
 * 1. anything under `<install home>/**` — it owns that directory outright, and
 * 2. `<paseo home>/config.json` — the one file it edits in Paseo's home.
 *
 * Everything else is somebody else's: the skills directories belong to the
 * `skills` CLI (ADR-003), the agent config directories belong to their agents,
 * `$HOME` belongs to the user. M-4 targets **zero** violations, so this module
 * exists to make a violation impossible to commit silently:
 *
 * - `NodeFsApi` is the *injectable* filesystem seam. Code that writes takes one
 *   instead of importing `node:fs/promises` directly, so a test can hand it a
 *   guarded implementation.
 * - `createWriteGuard` wraps any `NodeFsApi` and, before every write, checks the
 *   target against the scope. Out-of-scope writes are recorded and — in the
 *   default `block` mode — refused before they touch the disk.
 *
 * The scope check is deliberately paranoid about symlinks: a path is allowed
 * only when **both** its lexical form and its canonical (`realpath`ed) form
 * land inside the scope, so `<install home>/link -> /etc` cannot be used to
 * write to `/etc/passwd` while looking local.
 *
 * This module knows nothing about Vitest. The test-side helper that turns the
 * guard on for a whole process — including code that still calls `node:fs`
 * directly, such as `lock.ts` — lives in `test/helpers/write-scope.ts` and is
 * built on top of the types here.
 */

import type { Stats } from "node:fs";
import * as nodeFsModule from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as nodeFsPromises from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { isWithinRoot } from "./paths-guard.js";

/** Kind of write, coarse enough to read in a failure report. */
export type FsWriteKind =
  | "write-file"
  | "append-file"
  | "open-write"
  | "write-stream"
  | "make-dir"
  | "make-temp-dir"
  | "remove"
  | "rename"
  | "copy"
  | "symlink"
  | "hard-link"
  | "chmod"
  | "chown"
  | "truncate"
  | "times";

/** One filesystem write that the guard saw. */
export interface FsWrite {
  readonly kind: FsWriteKind;
  /** The function that was called, e.g. `fs.writeFileSync`. */
  readonly call: string;
  /** Resolved target path, as the caller spelled it. */
  readonly path: string;
  /** The same path with every existing segment resolved through symlinks. */
  readonly canonicalPath: string;
  /** False when the path is outside the write scope. */
  readonly allowed: boolean;
  /** True when the guard refused the operation instead of forwarding it. */
  readonly blocked: boolean;
}

/**
 * The area paseo-bm is allowed to write to. Both the path as configured and its
 * canonical form are kept, because an install home under `os.tmpdir()` on macOS
 * is reached through the `/var` -> `/private/var` symlink.
 */
export interface WriteScope {
  /** The install home, as configured. */
  readonly installHome: string;
  /** `<paseo home>/config.json`, when a Paseo home was given. */
  readonly paseoConfigFile: string | undefined;
  /** Directories that may be written to, lexical and canonical forms. */
  readonly roots: readonly string[];
  /** Individual files that may be written to, lexical and canonical forms. */
  readonly files: readonly string[];
}

export interface WriteScopeInput {
  /** `<install home>` — everything under it is ours (ADR-002). */
  installHome: string;
  /** `<paseo home>`; only `config.json` inside it becomes writable. */
  paseoHome?: string | undefined;
  /** Extra directories to allow. Use sparingly and say why at the call site. */
  allowRoots?: readonly string[];
  /** Extra single files to allow. */
  allowFiles?: readonly string[];
}

/** What the guard does when a write lands outside the scope. */
export type WriteGuardMode =
  /** Record it, refuse it, and throw `WriteScopeError`. The default. */
  | "block"
  /** Record it and let it through, so a whole run can be inspected at the end. */
  | "record";

export class WriteScopeError extends Error {
  readonly reason = "outside-write-scope" as const;
  /** The write that was refused. */
  readonly write: FsWrite;

  constructor(message: string, write: FsWrite) {
    super(message);
    this.name = "WriteScopeError";
    this.write = write;
  }

  /** The refused path, for callers that do not want to reach into `write`. */
  get path(): string {
    return this.write.path;
  }
}

/**
 * The filesystem seam. Narrow on purpose: every function here is one paseo-bm
 * actually uses, so a fake or a guard only has to implement what is real.
 */
export interface NodeFsApi {
  /** Read-only, never guarded. */
  realpathSync(path: string): string;
  /** Read-only, never guarded. */
  lstat(path: string): Promise<Stats>;
  /** Read-only, never guarded. */
  readFile(path: string): Promise<Buffer>;
  chmod(path: string, mode: number): Promise<void>;
  /** `recursive: false` fails with `EEXIST` instead of merging into an existing directory. */
  mkdir(path: string, options: { recursive?: boolean; mode?: number }): Promise<string | undefined>;
  /** Guarded when `flags` asks for write access. */
  open(path: string, flags: string, mode?: number): Promise<FileHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
}

/**
 * The real filesystem. Every method delegates through the module namespace at
 * call time rather than capturing the function up front, so a test that patches
 * `node:fs` for the whole process still sees writes made through this object.
 */
export const nodeFs: NodeFsApi = {
  realpathSync: (path) => nodeFsModule.realpathSync(path),
  lstat: (path) => nodeFsPromises.lstat(path),
  readFile: (path) => nodeFsPromises.readFile(path),
  chmod: (path, mode) => nodeFsPromises.chmod(path, mode),
  mkdir: (path, options) => nodeFsPromises.mkdir(path, options),
  open: (path, flags, mode) => nodeFsPromises.open(path, flags, mode),
  rename: (from, to) => nodeFsPromises.rename(from, to),
  rm: (path, options) => nodeFsPromises.rm(path, options),
  symlink: (target, path) => nodeFsPromises.symlink(target, path),
  unlink: (path) => nodeFsPromises.unlink(path),
  writeFile: (path, data, options) => nodeFsPromises.writeFile(path, data, options),
  copyFile: (source, destination) => nodeFsPromises.copyFile(source, destination),
};

/**
 * Resolves a path through symlinks without requiring it to exist yet: the
 * deepest existing ancestor is `realpath`ed and the missing segments are
 * appended. `<install home>/plugin/0.1.0` is a legitimate target long before it
 * exists, so "does not exist" must not mean "cannot be checked".
 */
export function canonicalPath(input: string, fs: Pick<NodeFsApi, "realpathSync"> = nodeFs): string {
  const resolved = resolve(input);
  const pending: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return pending.length === 0 ? real : resolve(real, pending.join(sep));
    } catch (error) {
      if (!isErrnoCode(error, "ENOENT")) {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        // Nothing on this path exists; the lexical form is the best we have.
        return resolved;
      }
      pending.unshift(basename(current));
      current = parent;
    }
  }
}

/** Builds the scope: the install home, plus `config.json` in Paseo's home. */
export function createWriteScope(
  input: WriteScopeInput,
  fs: Pick<NodeFsApi, "realpathSync"> = nodeFs,
): WriteScope {
  const installHome = resolve(input.installHome);
  const paseoConfigFile =
    input.paseoHome === undefined ? undefined : resolve(input.paseoHome, "config.json");

  const roots = bothForms([installHome, ...(input.allowRoots ?? [])], fs);
  const files = bothForms(
    [...(paseoConfigFile === undefined ? [] : [paseoConfigFile]), ...(input.allowFiles ?? [])],
    fs,
  );

  return { installHome, paseoConfigFile, roots, files };
}

/**
 * True when `target` may be written to.
 *
 * Both the lexical and the canonical form have to be inside the scope: the
 * first stops `../` escapes, the second stops a symlink inside the install home
 * from pointing the write somewhere else entirely.
 */
export function isWriteAllowed(
  scope: WriteScope,
  target: string,
  fs: Pick<NodeFsApi, "realpathSync"> = nodeFs,
): boolean {
  const resolved = resolve(target);
  return inScope(scope, resolved) && inScope(scope, canonicalPath(resolved, fs));
}

/** One line naming everything the scope allows, for failure messages. */
export function describeWriteScope(scope: WriteScope): string {
  const parts = [`${scope.installHome}${sep}**`];
  if (scope.paseoConfigFile !== undefined) {
    parts.push(scope.paseoConfigFile);
  }
  return parts.join(", ");
}

export interface WriteGuard {
  readonly scope: WriteScope;
  readonly mode: WriteGuardMode;
  /** Every write the guard saw, in order. */
  readonly writes: readonly FsWrite[];
  /** The subset that was outside the scope. */
  readonly violations: readonly FsWrite[];
  /** Guarded filesystem — inject this wherever a `NodeFsApi` is taken. */
  readonly fs: NodeFsApi;
  /** Distinct paths written to, in the order they were first seen. */
  paths(): string[];
  /**
   * Checks one write against the scope and records it. Returns true when the
   * caller may go ahead; throws `WriteScopeError` in `block` mode when not.
   * Public so a process-wide interceptor can reuse the same bookkeeping.
   */
  check(kind: FsWriteKind, call: string, target: string): boolean;
  /** Forgets everything recorded so far. */
  reset(): void;
  /** Throws with a full report when anything landed outside the scope. */
  assertNoViolations(): void;
}

export interface WriteGuardInput {
  /** The scope, or the input to build one from. */
  scope: WriteScope | WriteScopeInput;
  /** The filesystem to forward allowed writes to. Defaults to the real one. */
  fs?: NodeFsApi;
  /** Defaults to `block`. */
  mode?: WriteGuardMode;
}

/** Creates a guard and the guarded filesystem that goes with it. */
export function createWriteGuard(input: WriteGuardInput): WriteGuard {
  const base = input.fs ?? nodeFs;
  const mode = input.mode ?? "block";
  const scope = isWriteScope(input.scope) ? input.scope : createWriteScope(input.scope, base);
  const writes: FsWrite[] = [];
  const violations: FsWrite[] = [];

  const check = (kind: FsWriteKind, call: string, target: string): boolean => {
    const resolved = resolve(target);
    const canonical = canonicalPath(resolved, base);
    const allowed = inScope(scope, resolved) && inScope(scope, canonical);
    const blocked = !allowed && mode === "block";
    const write: FsWrite = { kind, call, path: resolved, canonicalPath: canonical, allowed, blocked };

    writes.push(write);
    if (allowed) {
      return true;
    }

    violations.push(write);
    if (blocked) {
      throw new WriteScopeError(
        `Refusing a write outside the paseo-bm write scope: ${call} (${kind}) on ${resolved}. ` +
          `Allowed: ${describeWriteScope(scope)}`,
        write,
      );
    }
    return true;
  };

  const guardedFs: NodeFsApi = {
    realpathSync: (path) => base.realpathSync(path),
    lstat: (path) => base.lstat(path),
    readFile: (path) => base.readFile(path),
    chmod: async (path, fileMode) => {
      check("chmod", "fs.promises.chmod", path);
      await base.chmod(path, fileMode);
    },
    mkdir: async (path, options) => {
      check("make-dir", "fs.promises.mkdir", path);
      return base.mkdir(path, options);
    },
    open: async (path, flags, fileMode) => {
      if (isWriteFlags(flags)) {
        check("open-write", "fs.promises.open", path);
      }
      return base.open(path, flags, fileMode);
    },
    rename: async (from, to) => {
      // Both ends change: the source disappears and the target appears.
      check("rename", "fs.promises.rename", from);
      check("rename", "fs.promises.rename", to);
      await base.rename(from, to);
    },
    rm: async (path, options) => {
      check("remove", "fs.promises.rm", path);
      await base.rm(path, options);
    },
    symlink: async (target, path) => {
      // The link itself is the write; its target is just a string.
      check("symlink", "fs.promises.symlink", path);
      await base.symlink(target, path);
    },
    unlink: async (path) => {
      check("remove", "fs.promises.unlink", path);
      await base.unlink(path);
    },
    writeFile: async (path, data, options) => {
      check("write-file", "fs.promises.writeFile", path);
      await base.writeFile(path, data, options);
    },
    copyFile: async (source, destination) => {
      check("copy", "fs.promises.copyFile", destination);
      await base.copyFile(source, destination);
    },
  };

  return {
    scope,
    mode,
    writes,
    violations,
    fs: guardedFs,
    paths: () => [...new Set(writes.map((write) => write.path))],
    check,
    reset: () => {
      writes.length = 0;
      violations.length = 0;
    },
    assertNoViolations: () => {
      if (violations.length === 0) {
        return;
      }
      throw new WriteScopeError(formatViolations(scope, violations), violations[0]!);
    },
  };
}

/** The report `assertNoViolations` fails with. Exported so tests can match it. */
export function formatViolations(scope: WriteScope, violations: readonly FsWrite[]): string {
  const lines = violations.map(
    (write) =>
      `  - ${write.call} (${write.kind}) -> ${write.path}` +
      (write.canonicalPath === write.path ? "" : ` [real: ${write.canonicalPath}]`),
  );
  return (
    `${violations.length} filesystem write(s) landed outside the paseo-bm write scope.\n` +
    `${lines.join("\n")}\n` +
    `Allowed: ${describeWriteScope(scope)}`
  );
}

/** True when an `open`/`openSync` flags argument asks for write access. */
export function isWriteFlags(flags: string | number | undefined): boolean {
  if (flags === undefined) {
    // `open` defaults to "r".
    return false;
  }
  if (typeof flags === "number") {
    // O_WRONLY (1) and O_RDWR (2) are the low two bits of the access mode.
    return (flags & 0o3) !== 0 || (flags & nodeFsModule.constants.O_CREAT) !== 0;
  }
  return /[waxs+]/.test(flags.replace(/^r/, ""));
}

/**
 * The temporary file an atomic write of `target` goes through (Design §8:
 * temp → fsync → rename, in the destination directory). `src/fsops.ts` names
 * its temp files with this, so the guard below can recognise them.
 */
export function atomicTempPath(target: string, pid: number, token: string): string {
  return resolve(dirname(target), `.${basename(target)}.${pid}.${token}.tmp`);
}

/**
 * True when `candidate` is an atomic-write temp file of `file`. An allowed
 * single file (Paseo's `config.json`) cannot be written atomically without its
 * sibling temp file, so that sibling belongs to the scope too — and nothing else
 * in the directory does.
 */
export function isAtomicTempOf(file: string, candidate: string): boolean {
  if (dirname(candidate) !== dirname(file)) {
    return false;
  }
  const name = basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${name}\\.\\d+\\.[0-9a-f]+\\.tmp$`).test(basename(candidate));
}

function inScope(scope: WriteScope, resolved: string): boolean {
  return (
    scope.roots.some((root) => isWithinRoot(root, resolved)) ||
    scope.files.some((file) => file === resolved || isAtomicTempOf(file, resolved))
  );
}

function bothForms(paths: readonly string[], fs: Pick<NodeFsApi, "realpathSync">): string[] {
  const forms = new Set<string>();
  for (const path of paths) {
    const resolved = resolve(path);
    forms.add(resolved);
    forms.add(canonicalPath(resolved, fs));
  }
  return [...forms];
}

function isWriteScope(value: WriteScope | WriteScopeInput): value is WriteScope {
  return Array.isArray((value as WriteScope).roots);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
