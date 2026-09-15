/**
 * Process lock for the install home (Design §3.1, §8).
 *
 * Two `paseo-bm` runs writing the same install home at the same time could
 * interleave the ownership record and the payload directories. The lock removes
 * that class of failure for the price of one small file: `.lock` inside the
 * install home, holding the pid that took it and when.
 *
 * Only `install` and `uninstall` take the lock. `doctor` reads and never
 * writes, so it must not take it — see `withLock` callers.
 *
 * Three behaviours matter and each is tested:
 *
 * 1. A second run whose holder is **really alive** is refused with `E_LOCKED`.
 * 2. A lock left behind by a **dead** process is reclaimed silently, because a
 *    crashed run must not brick the install home until a human deletes a file.
 * 3. The lock is released on **every** exit path — normal return, thrown error,
 *    `SIGINT`/`SIGTERM` — via `try/finally` plus signal handlers that are
 *    unregistered again the moment the lock is released.
 *
 * Nothing here imports the shared filesystem helpers: the lock is a single
 * small file and needs `node:fs` only, which keeps it usable from the earliest
 * point of a run, before anything else is set up.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { diagnostic } from "./errors.js";
import type { ErrorCode } from "./errors.js";

/** Contents of `.lock`. Written as JSON so a human can read who holds it. */
export interface LockRecord {
  /** Process id of the run holding the lock. */
  readonly pid: number;
  /** ISO-8601 UTC timestamp of when the lock was taken. */
  readonly acquiredAt: string;
  /**
   * Host that took the lock. A pid is only meaningful on its own machine, so a
   * record from another host can never be probed for liveness.
   */
  readonly hostname: string;
  /** The command that took the lock, for the refusal message. */
  readonly command?: string;
}

/** Why a lock could not be taken. */
export type LockRefusalReason =
  /** The recorded pid answers a liveness probe on this host. */
  | "holder-alive"
  /** The record comes from another host, so liveness cannot be established. */
  | "foreign-host"
  /** Repeated attempts kept losing the race to another process. */
  | "contended";

/**
 * A refusal to take the lock. Always carries `E_LOCKED`: the registry owns the
 * user-facing wording, this class adds the specifics of the holder.
 */
export class LockError extends Error {
  readonly code: ErrorCode = "E_LOCKED";
  readonly reason: LockRefusalReason;
  /** Absolute path of the lock file. */
  readonly path: string;
  /** What the lock file said, when it could be read and parsed. */
  readonly holder: LockRecord | undefined;
  /** Registry remediation, so a renderer does not have to look it up again. */
  readonly remediation: string;

  constructor(reason: LockRefusalReason, message: string, path: string, holder?: LockRecord) {
    super(message);
    this.name = "LockError";
    this.reason = reason;
    this.path = path;
    this.holder = holder;
    this.remediation = diagnostic("E_LOCKED").remediation;
  }
}

/** Minimal slice of `process` the lock needs, so tests never touch the real one. */
export interface ProcessHooks {
  readonly pid: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(pid: number, signal?: string | number): unknown;
}

export interface AcquireLockOptions {
  /** Pid written into the record. Defaults to `hooks.pid`. */
  pid?: number;
  /** Host written into the record. Defaults to `os.hostname()`. */
  host?: string;
  /** Command name recorded for the refusal message, e.g. `install`. */
  command?: string;
  /** Clock, injectable so the timestamp is deterministic in tests. */
  now?: () => Date;
  /** Liveness probe. Defaults to {@link isProcessAlive}. */
  isAlive?: (pid: number) => boolean;
  /** `process`, or a stand-in. Defaults to the real one. */
  hooks?: ProcessHooks;
  /**
   * Register `SIGINT`/`SIGTERM`/`exit` handlers that release the lock. On by
   * default; the handlers are removed by `release()`, so they cannot outlive
   * the lock or leak between tests.
   */
  handleSignals?: boolean;
  /** How many times to retry after losing a reclaim race. */
  maxAttempts?: number;
}

/** A held lock. `release()` is idempotent and safe to call from `finally`. */
export interface LockHandle {
  /** Absolute path of the lock file. */
  readonly path: string;
  /** What was written into it. */
  readonly record: LockRecord;
  /** True once the lock file has been removed (or found to be someone else's). */
  readonly released: boolean;
  /** True when this run took over a lock left by a dead process. */
  readonly reclaimed: boolean;
  release(): void;
}

/** Name of the lock file inside the install home (Design §3.1). */
const LOCK_FILE_NAME = ".lock";

/** Signals that must not leave a lock file behind. */
const CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Lock file permissions: only the owner may read or write it. */
const LOCK_FILE_MODE = 0o600;

/** Install home permissions, per Design §3.1. */
const LOCK_DIR_MODE = 0o700;

/**
 * Is `pid` a live process?
 *
 * `kill(pid, 0)` performs the permission and existence checks of a signal
 * without delivering one — the portable POSIX liveness probe, identical on
 * macOS and Linux. Three outcomes matter:
 *
 * - no error: the process exists and we may signal it → alive;
 * - `EPERM`: it exists but belongs to another user → alive (this is the case
 *   that a naive `try { kill } catch { dead }` gets wrong);
 * - `ESRCH`: no such process → dead.
 *
 * Anything else is unexpected; we answer "alive" so an unknown error can never
 * make us steal a lock that may still be held.
 */
export function isProcessAlive(pid: number, hooks: ProcessHooks = process): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    hooks.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM: alive, owned by somebody else. Unknown: assume alive.
    return true;
  }
}

/** Parses a lock file. Returns `undefined` for missing, unreadable or malformed content. */
export function readLockRecord(lockFile: string): LockRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockFile, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Partial<Record<keyof LockRecord, unknown>>;
  const pid = candidate.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return {
    pid,
    acquiredAt: typeof candidate.acquiredAt === "string" ? candidate.acquiredAt : "",
    hostname: typeof candidate.hostname === "string" ? candidate.hostname : "",
    ...(typeof candidate.command === "string" ? { command: candidate.command } : {}),
  };
}

function serialise(record: LockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Creates the lock file, failing if it already exists.
 *
 * `wx` is `O_CREAT | O_EXCL`, so the existence check and the creation are one
 * atomic step: two processes racing here cannot both succeed. The content is
 * flushed with `fsync` before the handle is closed, so a crash cannot leave an
 * empty lock file that looks malformed to the next run.
 */
function createExclusive(lockFile: string, record: LockRecord): boolean {
  let fd: number;
  try {
    fd = openSync(lockFile, "wx", LOCK_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    writeSync(fd, serialise(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

function describeHolder(record: LockRecord | undefined): string {
  if (record === undefined) {
    return "another run";
  }
  const parts = [`pid ${record.pid}`];
  if (record.command !== undefined && record.command.length > 0) {
    parts.push(`running \`paseo-bm ${record.command}\``);
  }
  if (record.hostname.length > 0) {
    parts.push(`on ${record.hostname}`);
  }
  if (record.acquiredAt.length > 0) {
    parts.push(`since ${record.acquiredAt}`);
  }
  return parts.join(", ");
}

function refusal(reason: LockRefusalReason, lockFile: string, record: LockRecord | undefined): LockError {
  const registry = diagnostic("E_LOCKED");
  const detail =
    reason === "foreign-host"
      ? `The lock at ${lockFile} was taken by ${describeHolder(record)}, and a pid from another machine cannot be checked from here.`
      : reason === "contended"
        ? `The lock at ${lockFile} kept being re-taken by another run while paseo-bm was trying to acquire it.`
        : `The lock at ${lockFile} is held by ${describeHolder(record)}, and that process is still running.`;
  return new LockError(reason, `${registry.message} ${detail} ${registry.remediation}`, lockFile, record);
}

/**
 * Takes the lock on an install home.
 *
 * `target` may be the install home itself or the `.lock` path inside it; both
 * are accepted so a caller holding an `InstallPaths` does not have to unwrap it.
 */
export function acquireLock(target: string, options: AcquireLockOptions = {}): LockHandle {
  const lockFile = toLockFile(target);
  const hooks = options.hooks ?? process;
  const isAlive = options.isAlive ?? ((pid: number) => isProcessAlive(pid, hooks));
  const host = options.host ?? hostname();
  const now = options.now ?? (() => new Date());
  const maxAttempts = options.maxAttempts ?? 3;

  mkdirSync(dirname(lockFile), { recursive: true, mode: LOCK_DIR_MODE });

  let reclaimed = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const record: LockRecord = {
      pid: options.pid ?? hooks.pid,
      acquiredAt: now().toISOString(),
      hostname: host,
      ...(options.command === undefined ? {} : { command: options.command }),
    };

    if (createExclusive(lockFile, record)) {
      return createHandle(lockFile, record, reclaimed, hooks, options.handleSignals !== false);
    }

    // Somebody got there first. Decide whether that somebody still exists.
    const existing = readLockRecord(lockFile);

    if (existing !== undefined && existing.hostname.length > 0 && existing.hostname !== host) {
      throw refusal("foreign-host", lockFile, existing);
    }
    if (existing !== undefined && existing.pid !== record.pid && isAlive(existing.pid)) {
      throw refusal("holder-alive", lockFile, existing);
    }

    // Either the file is unreadable/malformed (it names no owner we can respect),
    // it names this very process, or it names a process that has died. All three
    // are reclaimable: remove it and race for the lock again.
    try {
      unlinkSync(lockFile);
      reclaimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw refusal("contended", lockFile, readLockRecord(lockFile));
}

/** Accepts either the install home or the `.lock` path inside it. */
function toLockFile(target: string): string {
  const resolved = resolve(target);
  return basename(resolved) === LOCK_FILE_NAME ? resolved : resolve(resolved, LOCK_FILE_NAME);
}

function createHandle(
  lockFile: string,
  record: LockRecord,
  reclaimed: boolean,
  hooks: ProcessHooks,
  handleSignals: boolean,
): LockHandle {
  let released = false;
  const registered: { event: string; listener: (...args: unknown[]) => void }[] = [];

  function unregister(): void {
    for (const { event, listener } of registered.splice(0)) {
      hooks.off(event, listener);
    }
  }

  /**
   * Removes the lock file, but only while it is still ours. If the record on
   * disk names a different pid or a different moment, another run has legally
   * reclaimed it and deleting it would hand the install home to a third run.
   */
  function removeIfOurs(): void {
    const onDisk = readLockRecord(lockFile);
    if (onDisk !== undefined && (onDisk.pid !== record.pid || onDisk.acquiredAt !== record.acquiredAt)) {
      return;
    }
    try {
      unlinkSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  function release(): void {
    if (released) {
      return;
    }
    released = true;
    unregister();
    removeIfOurs();
  }

  if (handleSignals) {
    // `exit` is the last-resort net: it fires after an uncaught exception too,
    // and only synchronous work is allowed there, which `release` is.
    const onExit = (): void => {
      release();
    };
    hooks.on("exit", onExit);
    registered.push({ event: "exit", listener: onExit });

    for (const signal of CLEANUP_SIGNALS) {
      const onSignal = (): void => {
        release();
        // Adding a listener suppressed the default action, so re-raise the
        // signal on a now-unhandled process to keep the usual 128+n exit code.
        try {
          hooks.kill(hooks.pid, signal);
        } catch {
          // The process is already going away; nothing left to do.
        }
      };
      hooks.on(signal, onSignal);
      registered.push({ event: signal, listener: onSignal });
    }
  }

  return {
    path: lockFile,
    record,
    reclaimed,
    get released() {
      return released;
    },
    release,
  };
}

/**
 * Runs `fn` while holding the lock and releases it on every exit path.
 *
 * This is the form every caller should use: the `finally` makes "release the
 * lock even when the work throws" impossible to forget, which is the part of a
 * lock that is normally got wrong.
 */
export async function withLock<T>(
  target: string,
  fn: (lock: LockHandle) => Promise<T> | T,
  options: AcquireLockOptions = {},
): Promise<T> {
  const lock = acquireLock(target, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}

/** Synchronous twin of {@link withLock}, for callers that do no async work. */
export function withLockSync<T>(
  target: string,
  fn: (lock: LockHandle) => T,
  options: AcquireLockOptions = {},
): T {
  const lock = acquireLock(target, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}
