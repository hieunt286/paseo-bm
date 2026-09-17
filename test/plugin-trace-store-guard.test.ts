import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCK_WAIT_TIMEOUT_MS,
  STORE_DIR_MODE,
  STORE_FILE_MODE,
  TraceStoreLockTimeout,
  activeLockCount,
  assertNoSymlinkOnPath,
  assertWorkspaceId,
  closeQuietly,
  createStoreTempFile,
  ensureStoreDir,
  openStoreFileForAppend,
  storePath,
  withWorkspaceLock,
} from "../plugin/server/trace-store";
import { DashboardError } from "../plugin/shared/contracts";

/**
 * WP-203: the trace store's containment boundary and its lock.
 *
 * These run against a real temporary filesystem on purpose — a symlink attack
 * cannot be demonstrated against a fake fs, and the whole point of this bead is
 * that a symlinked component never lets a write escape `traces/`.
 */

let home: string;
let tracesDir: string;
let outside: string;

const WS = "wks_1";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-store-"));
  tracesDir = join(home, "traces");
  outside = join(home, "outside");
  mkdirSync(tracesDir, { recursive: true, mode: STORE_DIR_MODE });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("workspace id validation", () => {
  it.each(["wks_1", "a", "A.b-c_1", "x".repeat(128)])("accepts %o", (id) => {
    expect(() => assertWorkspaceId(id)).not.toThrow();
  });

  it.each([".", "..", "", "x".repeat(129), "has/slash", "has\\slash", "has space", "héllo", "a\0b"])(
    "rejects %o",
    (id) => {
      expect(() => assertWorkspaceId(id)).toThrow(/E_TRACE_STORE_UNWRITABLE/);
    },
  );
});

describe("storePath containment", () => {
  it("builds a path inside the store", () => {
    expect(storePath(tracesDir, WS, "events-202609.jsonl")).toBe(
      join(tracesDir, WS, "events-202609.jsonl"),
    );
  });

  it("rejects traversal in a segment", () => {
    for (const bad of ["..", ".", "", "a/b", "a\\b"]) {
      expect(() => storePath(tracesDir, WS, bad)).toThrow(/E_TRACE_STORE_UNWRITABLE/);
    }
  });

  it("rejects a relative store directory", () => {
    expect(() => storePath("traces", WS, "events.jsonl")).toThrow(/must be absolute/);
  });
});

describe("symlink refusal at every level", () => {
  it("refuses a symlinked traces/ directory", () => {
    rmSync(tracesDir, { recursive: true, force: true });
    symlinkSync(outside, tracesDir);
    expect(() => storePath(tracesDir, WS, "events-202609.jsonl")).toThrow(
      /refusing to use a symlinked path/,
    );
  });

  it("refuses a symlinked workspace directory and leaves its target untouched", () => {
    const target = join(outside, "stolen");
    mkdirSync(target);
    const canary = join(target, "canary.txt");
    writeFileSync(canary, "original");
    symlinkSync(target, join(tracesDir, WS));

    expect(() => storePath(tracesDir, WS, "events-202609.jsonl")).toThrow(
      /refusing to use a symlinked path/,
    );
    expect(() => ensureStoreDir(tracesDir, join(tracesDir, WS))).toThrow(
      /refusing to use a symlinked path/,
    );
    expect(readFileSync(canary, "utf8")).toBe("original");
  });

  it("refuses a symlinked monthly file and leaves its target byte-identical", () => {
    mkdirSync(join(tracesDir, WS), { recursive: true, mode: STORE_DIR_MODE });
    const target = join(outside, "victim.jsonl");
    writeFileSync(target, "original\n");
    const link = join(tracesDir, WS, "events-202609.jsonl");
    symlinkSync(target, link);

    expect(() => storePath(tracesDir, WS, "events-202609.jsonl")).toThrow(
      /refusing to use a symlinked path/,
    );
    // Even if a caller reached open() with a stale path, O_NOFOLLOW refuses it.
    expect(() => openStoreFileForAppend(link)).toThrow(/E_TRACE_STORE_UNWRITABLE/);
    expect(readFileSync(target, "utf8")).toBe("original\n");
  });

  it("refuses a symlinked temporary file instead of reusing it", () => {
    mkdirSync(join(tracesDir, WS), { recursive: true, mode: STORE_DIR_MODE });
    const target = join(outside, "temp-victim");
    writeFileSync(target, "original");
    const tempPath = join(tracesDir, WS, "events-202609.jsonl.tmp");
    symlinkSync(target, tempPath);

    expect(() => createStoreTempFile(tempPath)).toThrow(/E_TRACE_STORE_UNWRITABLE/);
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("allows a path whose deeper components do not exist yet", () => {
    expect(() => assertNoSymlinkOnPath(home, join(tracesDir, "brand-new", "events.jsonl"))).not.toThrow();
  });
});

describe("modes", () => {
  it("creates directories 0700 and files 0600", () => {
    const dir = join(tracesDir, WS);
    ensureStoreDir(tracesDir, dir);
    expect(statSync(dir).mode & 0o777).toBe(STORE_DIR_MODE);

    const file = storePath(tracesDir, WS, "events-202609.jsonl");
    const fd = openStoreFileForAppend(file);
    closeQuietly(fd);
    expect(statSync(file).mode & 0o777).toBe(STORE_FILE_MODE);
  });

  it("fails an exclusive temporary file that already exists", () => {
    const dir = join(tracesDir, WS);
    ensureStoreDir(tracesDir, dir);
    const tempPath = join(dir, "events.jsonl.tmp");
    closeQuietly(createStoreTempFile(tempPath));
    expect(() => createStoreTempFile(tempPath)).toThrow(/E_TRACE_STORE_UNWRITABLE/);
  });
});

describe("workspace mutex", () => {
  it("serialises mutations of the same workspace", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      const gate = new Promise<void>((resolveGate) => {
        releaseFirst = resolveGate;
      });
      void withWorkspaceLock(WS, async () => {
        order.push("first:start");
        resolveStarted();
        await gate;
        order.push("first:end");
      });
    });

    await firstStarted;
    const second = withWorkspaceLock(WS, () => {
      order.push("second");
    });

    // The second holder must not have run while the first still holds the lock.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("lets different workspaces run independently", async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => {
      releaseA = r;
    });
    const a = withWorkspaceLock("wks_a", async () => {
      order.push("a:start");
      await gate;
      order.push("a:end");
    });
    await new Promise((r) => setTimeout(r, 5));
    await withWorkspaceLock("wks_b", () => {
      order.push("b");
    });
    expect(order).toEqual(["a:start", "b"]);
    releaseA();
    await a;
  });

  it("times out with a distinguishable error and keeps the queue moving", async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = withWorkspaceLock(WS, async () => {
      await gate;
      return "first";
    });

    await new Promise((r) => setTimeout(r, 5));
    const timedOut = withWorkspaceLock(WS, () => "never", { timeoutMs: 10 });
    await expect(timedOut).rejects.toBeInstanceOf(TraceStoreLockTimeout);
    await expect(timedOut).rejects.toThrow(/E_TRACE_STORE_UNWRITABLE/);

    releaseFirst();
    await expect(first).resolves.toBe("first");

    // The lock is not left held: a later mutation still runs.
    await expect(withWorkspaceLock(WS, () => "after", { timeoutMs: 50 })).resolves.toBe("after");
  });

  it("releases the lock when the body throws, and forgets idle workspaces", async () => {
    await expect(
      withWorkspaceLock(WS, () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    await expect(withWorkspaceLock(WS, () => "next")).resolves.toBe("next");
    expect(activeLockCount()).toBe(0);
  });

  it("uses the designed default wait", () => {
    expect(LOCK_WAIT_TIMEOUT_MS).toBe(5_000);
  });

  it("validates the workspace id before taking the lock", async () => {
    await expect(withWorkspaceLock("../escape", () => "x")).rejects.toBeInstanceOf(DashboardError);
  });
});
