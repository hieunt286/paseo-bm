/**
 * Test harness for the write-scope invariant (Design §10, milestone M-4).
 *
 * `src/fs-guard.ts` owns the policy — what paseo-bm may write. This file is the
 * test side of it and adds the thing a policy alone cannot give: it catches
 * writes that never went through the injectable seam. It does that by patching
 * the write functions of `node:fs` and `node:fs/promises` for the duration of a
 * test and syncing the patched values into the builtin ESM namespaces, so
 * modules that imported `writeFileSync` directly — `src/lock.ts` does, on
 * purpose — are covered too.
 *
 * Usage in a command's test suite:
 *
 * ```ts
 * const scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome] });
 * try {
 *   await runInstall(...);
 *   scope.assertNoViolations();
 * } finally {
 *   scope.restore();
 * }
 * ```
 *
 * `watch` is what keeps the harness quiet: only writes under those roots are
 * judged, so Vitest writing its own caches somewhere else is not mistaken for a
 * product bug. It defaults to the parent directories of the install home and
 * the Paseo home, which in an integration test is the fake `$HOME` — exactly
 * the area where a stray write would matter, skills directories included.
 *
 * The guard defaults to `block`: an out-of-scope write is refused *before* it
 * reaches the disk and the violation is recorded either way, so a test can
 * never damage a real directory just by being wrong.
 */

import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FsWrite, FsWriteKind, NodeFsApi, WriteGuard, WriteGuardMode, WriteScope, WriteScopeInput } from "../../src/fs-guard.js";
import { WriteScopeError, createWriteGuard, isWriteFlags } from "../../src/fs-guard.js";
import type { FsOps } from "../../src/fsops.js";
import { createFsOps } from "../../src/fsops.js";

export interface WriteScopeOptions extends WriteScopeInput {
  /**
   * Roots the process-wide patch inspects. Writes outside all of them are
   * ignored. Defaults to the parents of the install home and the Paseo home.
   */
  watch?: readonly string[];
  /** `block` (default) refuses the write; `record` lets it happen. */
  mode?: WriteGuardMode;
  /**
   * Patch `node:fs` for the whole process. Default true. Turn it off to guard
   * only the code that takes an injected `NodeFsApi`.
   */
  patchNodeFs?: boolean;
}

export interface WriteScopeHarness {
  readonly scope: WriteScope;
  readonly guard: WriteGuard;
  /** Guarded filesystem to inject, e.g. `createFsOps({ root, fs: scope.fs })`. */
  readonly fs: NodeFsApi;
  /** Every write seen, in order. */
  readonly writes: readonly FsWrite[];
  /** The ones outside the scope. */
  readonly violations: readonly FsWrite[];
  /** Distinct paths written to. */
  paths(): string[];
  /** An `FsOps` bound to the install home and the guarded filesystem. */
  fsops(root?: string): FsOps;
  /** Throws a report naming every out-of-scope write. */
  assertNoViolations(): void;
  /** Forgets what has been recorded, keeping the patch in place. */
  reset(): void;
  /** Puts `node:fs` back. Safe to call twice. */
  restore(): void;
}

/** Turns the guard on. The caller is responsible for calling `restore()`. */
export function startWriteScope(options: WriteScopeOptions): WriteScopeHarness {
  const guard = createWriteGuard({
    scope: {
      installHome: options.installHome,
      paseoHome: options.paseoHome,
      allowRoots: options.allowRoots,
      allowFiles: options.allowFiles,
    },
    mode: options.mode ?? "block",
  });

  const watch = (
    options.watch ?? [
      dirname(resolve(options.installHome)),
      ...(options.paseoHome === undefined ? [] : [dirname(resolve(options.paseoHome))]),
    ]
  ).map((root) => resolve(root));

  const restorePatch =
    options.patchNodeFs === false ? () => undefined : patchNodeFs(guard, watch);

  return {
    scope: guard.scope,
    guard,
    fs: guard.fs,
    get writes() {
      return guard.writes;
    },
    get violations() {
      return guard.violations;
    },
    paths: () => guard.paths(),
    fsops: (root?: string) => createFsOps({ root: root ?? options.installHome, fs: guard.fs }),
    assertNoViolations: () => {
      guard.assertNoViolations();
    },
    reset: () => {
      guard.reset();
    },
    restore: restorePatch,
  };
}

/** `startWriteScope` with the `restore()` already taken care of. */
export async function withWriteScope<T>(
  options: WriteScopeOptions,
  run: (scope: WriteScopeHarness) => T | Promise<T>,
): Promise<T> {
  const scope = startWriteScope(options);
  try {
    const result = await run(scope);
    scope.assertNoViolations();
    return result;
  } finally {
    scope.restore();
  }
}

type AnyFn = (...args: unknown[]) => unknown;

interface WriteSpec {
  /** Base name; the sync variant is `${name}Sync`. */
  readonly name: string;
  readonly kind: FsWriteKind;
  /** Argument positions holding a path that is about to change. */
  readonly paths: readonly number[];
  /** Argument holding `open` flags; the call only counts when they write. */
  readonly flagsArg?: number;
}

/**
 * Every way `node:fs` can change something on disk that paseo-bm could
 * plausibly reach for. Reads are deliberately absent: this guard is about the
 * write scope, and `doctor` has to be free to read.
 */
const WRITE_SPECS: readonly WriteSpec[] = [
  { name: "writeFile", kind: "write-file", paths: [0] },
  { name: "appendFile", kind: "append-file", paths: [0] },
  { name: "mkdir", kind: "make-dir", paths: [0] },
  { name: "mkdtemp", kind: "make-temp-dir", paths: [0] },
  { name: "rm", kind: "remove", paths: [0] },
  { name: "rmdir", kind: "remove", paths: [0] },
  { name: "unlink", kind: "remove", paths: [0] },
  { name: "rename", kind: "rename", paths: [0, 1] },
  { name: "copyFile", kind: "copy", paths: [1] },
  { name: "cp", kind: "copy", paths: [1] },
  { name: "link", kind: "hard-link", paths: [1] },
  { name: "symlink", kind: "symlink", paths: [1] },
  { name: "chmod", kind: "chmod", paths: [0] },
  { name: "lchmod", kind: "chmod", paths: [0] },
  { name: "chown", kind: "chown", paths: [0] },
  { name: "lchown", kind: "chown", paths: [0] },
  { name: "truncate", kind: "truncate", paths: [0] },
  { name: "utimes", kind: "times", paths: [0] },
  { name: "lutimes", kind: "times", paths: [0] },
  { name: "open", kind: "open-write", paths: [0], flagsArg: 1 },
];

/** Writes that only exist under one name, on the callback namespace. */
const EXTRA_SPECS: readonly WriteSpec[] = [
  { name: "createWriteStream", kind: "write-stream", paths: [0] },
];

/**
 * The CommonJS view of the builtins. An ESM namespace object is frozen, so the
 * functions have to be replaced on the CJS exports and then published into the
 * ESM namespaces with `syncBuiltinESMExports()` — the API Node provides for
 * exactly this.
 */
const requireBuiltin = createRequire(import.meta.url);

function patchNodeFs(guard: WriteGuard, watch: readonly string[]): () => void {
  const fsHolder = requireBuiltin("node:fs") as Record<string, AnyFn | undefined>;
  const fspHolder = requireBuiltin("node:fs/promises") as Record<string, AnyFn | undefined>;
  const undo: (() => void)[] = [];

  const install = (
    holder: Record<string, AnyFn | undefined>,
    key: string,
    spec: WriteSpec,
    call: string,
    async: boolean,
  ): void => {
    const original = holder[key];
    if (typeof original !== "function") {
      // Not every function exists on every platform (`lchmod` is macOS-only).
      return;
    }
    holder[key] = function patched(this: unknown, ...args: unknown[]): unknown {
      const refusal = inspect(guard, watch, spec, call, args);
      if (refusal !== undefined) {
        // Promise-returning variants reject instead of throwing synchronously,
        // so `.catch()` callers behave the way they would with a real EACCES.
        if (async) {
          return Promise.reject(refusal);
        }
        throw refusal;
      }
      return original.apply(this, args);
    };
    undo.push(() => {
      holder[key] = original;
    });
  };

  for (const spec of WRITE_SPECS) {
    install(fsHolder, spec.name, spec, `fs.${spec.name}`, false);
    install(fsHolder, `${spec.name}Sync`, spec, `fs.${spec.name}Sync`, false);
    install(fspHolder, spec.name, spec, `fs.promises.${spec.name}`, true);
  }
  for (const spec of EXTRA_SPECS) {
    install(fsHolder, spec.name, spec, `fs.${spec.name}`, false);
  }

  // Makes the patched values visible to `import { writeFileSync } from "node:fs"`.
  syncBuiltinESMExports();

  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    for (const step of undo) {
      step();
    }
    syncBuiltinESMExports();
  };
}

/**
 * Judges one intercepted call. Returns the error to raise when the write must
 * be refused, `undefined` when the call may proceed. Either way, anything
 * inside a watched root is recorded on the guard.
 */
function inspect(
  guard: WriteGuard,
  watch: readonly string[],
  spec: WriteSpec,
  call: string,
  args: readonly unknown[],
): Error | undefined {
  if (spec.flagsArg !== undefined && !isWriteFlags(flagsOf(args[spec.flagsArg]))) {
    return undefined;
  }

  for (const index of spec.paths) {
    const target = toPath(args[index]);
    if (target === undefined || !isWatched(watch, target)) {
      continue;
    }
    try {
      guard.check(spec.kind, call, target);
    } catch (error) {
      if (error instanceof WriteScopeError) {
        return error;
      }
      throw error;
    }
  }
  return undefined;
}

function isWatched(watch: readonly string[], target: string): boolean {
  if (watch.length === 0) {
    return true;
  }
  return watch.some((root) => target === root || target.startsWith(`${root}/`));
}

function flagsOf(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

/** `node:fs` accepts strings, Buffers, `file:` URLs and file descriptors. */
function toPath(value: unknown): string | undefined {
  if (typeof value === "string") {
    return resolve(value);
  }
  if (value instanceof URL) {
    return value.protocol === "file:" ? resolve(fileURLToPath(value)) : undefined;
  }
  if (Buffer.isBuffer(value)) {
    return resolve(value.toString("utf8"));
  }
  // A file descriptor: the path was already judged when it was opened.
  return undefined;
}
