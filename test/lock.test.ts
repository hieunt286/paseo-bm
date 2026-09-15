import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { installPaths } from "../src/layout.js";
import {
  LockError,
  acquireLock,
  isProcessAlive,
  readLockRecord,
  withLock,
  withLockSync,
} from "../src/lock.js";
import type { LockRecord, ProcessHooks } from "../src/lock.js";

/**
 * Temporary install homes and live child processes created by a test. Both are
 * torn down after every test: nothing here may touch the real `$HOME`, and a
 * leaked child would keep a pid alive for later tests.
 */
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-bm-lock-"));
  tempDirs.push(dir);
  return dir;
}

/** A real, running process of this user — the only honest way to test "holder is alive". */
function spawnLiveChild(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

/**
 * A pid that certainly does not exist. Rather than trusting "a big number is
 * free", every candidate is probed first, so the test cannot become flaky if
 * the machine happens to be using one of them.
 */
function findDeadPid(): number {
  for (let pid = 4_194_301; pid > 3_900_000; pid -= 7919) {
    if (!isProcessAlive(pid)) return pid;
  }
  throw new Error("no unused pid found to test lock reclaim with");
}

/** Records handler registration so signal behaviour is testable without touching `process`. */
class FakeHooks implements ProcessHooks {
  readonly pid: number;
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly killed: { pid: number; signal: string | number | undefined }[] = [];
  aliveAnswer = true;

  constructor(pid = 4242) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): unknown {
    const existing = this.listeners.get(event) ?? [];
    const index = existing.indexOf(listener);
    if (index >= 0) existing.splice(index, 1);
    if (existing.length === 0) this.listeners.delete(event);
    else this.listeners.set(event, existing);
    return this;
  }

  kill(pid: number, signal?: string | number): unknown {
    this.killed.push({ pid, signal });
    if (signal === 0 && !this.aliveAnswer) {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }
    return true;
  }

  emit(event: string): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as () => void)();
    }
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, list) => total + list.length, 0);
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) await killAndWait(child);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lock file", () => {
  it("writes pid, timestamp and host into .lock at the path the layout defines", () => {
    const home = tempHome();
    const lock = acquireLock(home, { command: "install", handleSignals: false });

    expect(lock.path).toBe(installPaths(home).lockFile);
    expect(existsSync(lock.path)).toBe(true);

    const record = JSON.parse(readFileSync(lock.path, "utf8")) as LockRecord;
    expect(record.pid).toBe(process.pid);
    expect(record.hostname).toBe(hostname());
    expect(record.command).toBe("install");
    expect(new Date(record.acquiredAt).toISOString()).toBe(record.acquiredAt);
    expect(statSync(lock.path).mode & 0o777).toBe(0o600);

    lock.release();
    expect(existsSync(lock.path)).toBe(false);
    expect(lock.released).toBe(true);
  });

  it("creates the install home if it does not exist yet, and accepts the .lock path directly", () => {
    const home = join(tempHome(), "nested", "home");
    const lock = acquireLock(join(home, ".lock"), { handleSignals: false });
    expect(lock.path).toBe(installPaths(home).lockFile);
    expect(statSync(home).isDirectory()).toBe(true);
    lock.release();
  });

  it("ignores a lock file that is not readable JSON", () => {
    const home = tempHome();
    writeFileSync(join(home, ".lock"), "not json at all");
    expect(readLockRecord(join(home, ".lock"))).toBeUndefined();
  });
});

describe("a second run while the holder is alive", () => {
  it("is refused with E_LOCKED and a message naming the holder", () => {
    const home = tempHome();
    const child = spawnLiveChild();
    expect(child.pid).toBeTypeOf("number");
    const holderPid = child.pid as number;

    // The lock is taken on behalf of a genuinely running process; liveness is
    // then probed for real, with no stubbing of `isProcessAlive`.
    const held = acquireLock(home, { pid: holderPid, command: "install", handleSignals: false });
    expect(isProcessAlive(holderPid)).toBe(true);

    const attempt = (): unknown => acquireLock(home, { command: "uninstall", handleSignals: false });

    expect(attempt).toThrow(LockError);
    let captured: LockError | undefined;
    try {
      attempt();
    } catch (error) {
      captured = error as LockError;
    }

    expect(captured?.code).toBe("E_LOCKED");
    expect(captured?.reason).toBe("holder-alive");
    expect(captured?.path).toBe(held.path);
    expect(captured?.holder?.pid).toBe(holderPid);
    expect(captured?.message).toContain(`pid ${holderPid}`);
    expect(captured?.message).toContain("still running");
    expect(captured?.message).toContain("paseo-bm install");
    expect(captured?.message).toContain(held.path);
    // The remediation from the registry is part of what the user sees.
    expect(captured?.message).toContain("Wait for the other run to finish");
    expect(captured?.remediation).toContain("doctor");

    // A refused run must not have disturbed the holder's lock file.
    expect(readLockRecord(held.path)?.pid).toBe(holderPid);
  });

  it("refuses a lock taken on another machine, because a foreign pid cannot be probed", () => {
    const home = tempHome();
    acquireLock(home, { pid: 1234, host: "some-other-box", handleSignals: false });

    try {
      acquireLock(home, { handleSignals: false });
      expect.unreachable("expected the foreign-host lock to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(LockError);
      expect((error as LockError).reason).toBe("foreign-host");
      expect((error as LockError).code).toBe("E_LOCKED");
      expect((error as LockError).message).toContain("some-other-box");
    }
  });
});

describe("a lock left by a dead process", () => {
  it("is reclaimed when the recorded pid does not exist", () => {
    const home = tempHome();
    const deadPid = findDeadPid();
    expect(isProcessAlive(deadPid)).toBe(false);

    const stale = acquireLock(home, { pid: deadPid, command: "install", handleSignals: false });
    expect(readLockRecord(stale.path)?.pid).toBe(deadPid);

    const taken = acquireLock(home, { command: "install", handleSignals: false });
    expect(taken.reclaimed).toBe(true);
    expect(readLockRecord(taken.path)?.pid).toBe(process.pid);
    taken.release();
  });

  it("is reclaimed after a real process that held it is killed", async () => {
    const home = tempHome();
    const child = spawnLiveChild();
    const holderPid = child.pid as number;
    acquireLock(home, { pid: holderPid, command: "install", handleSignals: false });

    // While it lives, the lock holds.
    expect(() => acquireLock(home, { handleSignals: false })).toThrow(LockError);

    await killAndWait(child);
    expect(isProcessAlive(holderPid)).toBe(false);

    const taken = acquireLock(home, { handleSignals: false });
    expect(taken.reclaimed).toBe(true);
    expect(readLockRecord(taken.path)?.pid).toBe(process.pid);
    taken.release();
  });

  it("is reclaimed when the lock file names no owner we can respect", () => {
    const home = tempHome();
    writeFileSync(join(home, ".lock"), "{ truncated by a crash");

    const taken = acquireLock(home, { handleSignals: false });
    expect(taken.reclaimed).toBe(true);
    expect(readLockRecord(taken.path)?.pid).toBe(process.pid);
    taken.release();
  });
});

describe("liveness probe", () => {
  it("treats EPERM as alive and ESRCH as dead", () => {
    const hooks = new FakeHooks();
    hooks.aliveAnswer = false;
    expect(isProcessAlive(999, hooks)).toBe(false);

    const eperm: ProcessHooks = {
      pid: 7,
      on: () => undefined,
      off: () => undefined,
      kill: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    };
    // A process owned by another user exists; a naive catch-all would call it dead.
    expect(isProcessAlive(999, eperm)).toBe(true);
  });

  it("answers for real processes: this one is alive, pid 1 exists, a nonsense pid does not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(1)).toBe(true); // launchd / init: EPERM for a normal user, still alive
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(findDeadPid())).toBe(false);
  });
});

describe("release on every exit path", () => {
  it("releases the lock when the work throws", async () => {
    const home = tempHome();
    const lockFile = installPaths(home).lockFile;
    const boom = new Error("write failed half way through");

    let seenInside: string | undefined;
    await expect(
      withLock(
        home,
        (lock) => {
          seenInside = lock.path;
          expect(existsSync(lock.path)).toBe(true);
          throw boom;
        },
        { handleSignals: false },
      ),
    ).rejects.toBe(boom);

    expect(seenInside).toBe(lockFile);
    expect(existsSync(lockFile)).toBe(false);

    // And the install home is usable again straight away.
    const next = acquireLock(home, { handleSignals: false });
    expect(next.reclaimed).toBe(false);
    next.release();
  });

  it("releases the lock when synchronous work throws, and on the happy path", () => {
    const home = tempHome();
    const lockFile = installPaths(home).lockFile;

    expect(() =>
      withLockSync(home, () => {
        throw new Error("sync failure");
      }, { handleSignals: false }),
    ).toThrow("sync failure");
    expect(existsSync(lockFile)).toBe(false);

    expect(withLockSync(home, () => "done", { handleSignals: false })).toBe("done");
    expect(existsSync(lockFile)).toBe(false);
  });

  it("releases the lock on SIGINT and re-raises the signal", () => {
    const home = tempHome();
    const hooks = new FakeHooks();
    const lock = acquireLock(home, { hooks, isAlive: () => false });

    expect([...hooks.listeners.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM", "exit"]);
    expect(existsSync(lock.path)).toBe(true);

    hooks.emit("SIGINT");

    expect(existsSync(lock.path)).toBe(false);
    expect(lock.released).toBe(true);
    // Handlers are gone, so the re-raised signal gets its default behaviour.
    expect(hooks.listenerCount).toBe(0);
    expect(hooks.killed).toContainEqual({ pid: hooks.pid, signal: "SIGINT" });
  });

  it("releases the lock from the exit handler", () => {
    const home = tempHome();
    const hooks = new FakeHooks();
    const lock = acquireLock(home, { hooks, isAlive: () => false });

    hooks.emit("exit");

    expect(existsSync(lock.path)).toBe(false);
    expect(hooks.listenerCount).toBe(0);
  });

  it("does not leak signal handlers on the real process", async () => {
    const home = tempHome();
    const before = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGHUP: process.listenerCount("SIGHUP"),
      exit: process.listenerCount("exit"),
    };

    await withLock(home, (lock) => {
      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
      expect(existsSync(lock.path)).toBe(true);
    });

    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
    expect(process.listenerCount("exit")).toBe(before.exit);

    // Even when the body throws.
    await expect(
      withLock(home, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
    expect(process.listenerCount("exit")).toBe(before.exit);
  });

  it("is idempotent and never deletes a lock another run has reclaimed", () => {
    const home = tempHome();
    const lock = acquireLock(home, { handleSignals: false });

    // Simulate a third run legitimately taking over after a reclaim.
    const foreign: LockRecord = {
      pid: process.pid,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      hostname: hostname(),
    };
    writeFileSync(lock.path, JSON.stringify(foreign));

    lock.release();
    expect(existsSync(lock.path)).toBe(true);
    expect(readLockRecord(lock.path)?.acquiredAt).toBe(foreign.acquiredAt);

    // Releasing twice is harmless.
    lock.release();
    expect(existsSync(lock.path)).toBe(true);
  });
});
