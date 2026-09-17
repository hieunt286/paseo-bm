import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  appendRecord,
  clearTraceStoreCache,
  deleteTraces,
  planDeletion,
  readRecords,
  traceKeyOf,
  withWorkspaceLock,
  type TraceStoreLocation,
} from "../plugin/server/trace-store";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-210 part 1: deletion.
 *
 * This is the only irreversible operation in the feature, so the tests are
 * built around three properties: the preview equals the deletion, an invalid or
 * escaping path changes nothing on disk, and nothing outside
 * `<install home>/traces/` is ever touched.
 */

let home: string;
let workspaceFixture: string;
let location: TraceStoreLocation;
const WS = "wks_1";

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: WS,
    agentId: "agent-worker",
    role: "worker",
    turnId: "turn-1",
    requestId: "req-A",
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-16T10:00:00.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

/** Everything under a root, as path -> content|dir marker, for snapshot diffs. */
function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) out.set(key, "symlink");
      else if (entry.isDirectory()) {
        out.set(key, "dir");
        walk(path);
      } else out.set(key, `${statSync(path).mode & 0o777}:${readFileSync(path, "utf8")}`);
    }
  };
  walk(root);
  return out;
}

function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [key, value] of after) if (before.get(key) !== value) changed.push(key);
  for (const key of before.keys()) if (!after.has(key)) changed.push(key);
  return changed.sort();
}

async function seed(): Promise<void> {
  await appendRecord(location, record({ at: "2026-08-10T10:00:00.000Z", requestId: "req-old", turnId: "t-old" }));
  await appendRecord(location, record({ at: "2026-09-10T10:00:00.000Z", requestId: "req-A", turnId: "t-a1" }));
  await appendRecord(location, record({ at: "2026-09-11T10:00:00.000Z", requestId: "req-A", turnId: "t-a2" }));
  await appendRecord(location, record({ at: "2026-09-12T10:00:00.000Z", requestId: "req-B", turnId: "t-b1" }));
  clearTraceStoreCache();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-del-"));
  location = { tracesDir: join(home, "traces") };
  workspaceFixture = join(home, "workspace");
  mkdirSync(join(workspaceFixture, ".beads"), { recursive: true });
  writeFileSync(join(workspaceFixture, ".beads", "issues.jsonl"), '{"id":"bm-x","status":"open"}\n');
  writeFileSync(join(home, "install.json"), JSON.stringify({ schemaVersion: 1 }));
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("dry run equals the deletion", () => {
  it("reports the same traces and bytes it will remove, for all three scopes", async () => {
    for (const scope of [
      { traceId: "req-A" },
      { before: "2026-09-01T00:00:00.000Z" },
      { allOfWorkspace: true as const },
    ]) {
      rmSync(location.tracesDir, { recursive: true, force: true });
      clearTraceStoreCache();
      await seed();

      const planned = await deleteTraces(location, WS, scope as never, { dryRun: true });
      const before = snapshot(home);
      const done = await deleteTraces(location, WS, scope as never);
      expect(done.traces).toBe(planned.traces);
      expect(done.bytes).toBe(planned.bytes);
      // A dry run must not have touched anything: the snapshot was taken after it.
      expect(planned.traces).toBeGreaterThan(0);
      expect(diff(before, snapshot(home)).every((path) => path.startsWith("traces"))).toBe(true);
    }
  });

  it("changes nothing on disk during a dry run", async () => {
    await seed();
    const before = snapshot(home);
    const planned = await deleteTraces(location, WS, { allOfWorkspace: true }, { dryRun: true });
    expect(planned.traces).toBe(3);
    expect(diff(before, snapshot(home))).toEqual([]);
  });
});

describe("the three scopes", () => {
  it("deletes one trace and keeps the others in the same month", async () => {
    await seed();
    const outcome = await deleteTraces(location, WS, { traceId: "req-A" });
    expect(outcome.traces).toBe(1);

    const left = readRecords(location, WS).records;
    expect(left.map(traceKeyOf)).toEqual(["req-old", "req-B"]);
    expect(existsSync(join(location.tracesDir, WS, "events-202609.jsonl"))).toBe(true);
  });

  it("deletes everything older than a moment and removes the emptied month file", async () => {
    await seed();
    const outcome = await deleteTraces(location, WS, { before: "2026-09-01T00:00:00.000Z" });
    expect(outcome.traces).toBe(1);
    expect(existsSync(join(location.tracesDir, WS, "events-202608.jsonl"))).toBe(false);
    expect(readRecords(location, WS).records.map(traceKeyOf)).toEqual(["req-A", "req-A", "req-B"]);
  });

  it("deletes a whole workspace directory but leaves other workspaces and store metadata", async () => {
    await seed();
    await appendRecord(location, record({ workspaceId: "wks_2", requestId: "req-other", turnId: "t-o" }));

    const outcome = await deleteTraces(location, WS, { allOfWorkspace: true });
    expect(outcome.traces).toBe(3);
    expect(existsSync(join(location.tracesDir, WS))).toBe(false);
    expect(existsSync(join(location.tracesDir, "wks_2"))).toBe(true);
    expect(existsSync(join(location.tracesDir, "meta.json"))).toBe(true);
    expect(readRecords(location, "wks_2").records).toHaveLength(1);
  });

  it("keeps a line it cannot parse rather than discarding data nobody asked to lose", async () => {
    await seed();
    const path = join(location.tracesDir, WS, "events-202609.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{not json\n`);
    clearTraceStoreCache();

    await deleteTraces(location, WS, { traceId: "req-A" });
    expect(readFileSync(path, "utf8")).toContain("{not json");
  });
});

describe("containment", () => {
  it.each([".", "..", "../escape", "has/slash", ""])(
    "refuses workspace id %o without touching the disk",
    async (workspaceId) => {
      await seed();
      const before = snapshot(home);
      await expect(deleteTraces(location, workspaceId, { allOfWorkspace: true })).rejects.toThrow(
        /E_TRACE_STORE_UNWRITABLE/,
      );
      expect(diff(before, snapshot(home))).toEqual([]);
    },
  );

  it("refuses a symlinked workspace directory and leaves the target intact", async () => {
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");
    mkdirSync(location.tracesDir, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(location.tracesDir, "wks_link"));

    await expect(deleteTraces(location, "wks_link", { allOfWorkspace: true })).rejects.toThrow(
      /refusing to use a symlinked path/,
    );
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("touches nothing outside the trace store", async () => {
    await seed();
    const before = snapshot(home);
    await deleteTraces(location, WS, { allOfWorkspace: true });
    const changed = diff(before, snapshot(home));
    expect(changed.length).toBeGreaterThan(0);
    for (const path of changed) expect(path.startsWith("traces")).toBe(true);
    // The workspace fixture and the install profile are untouched.
    expect(readFileSync(join(workspaceFixture, ".beads", "issues.jsonl"), "utf8")).toContain("bm-x");
    expect(readFileSync(join(home, "install.json"), "utf8")).toContain("schemaVersion");
  });

  it("refuses to delete from a store written by a newer paseo-bm", async () => {
    await seed();
    writeFileSync(
      join(location.tracesDir, "meta.json"),
      JSON.stringify({ schemaVersion: TRACE_STORE_SCHEMA_VERSION + 1, createdAt: "x", updatedAt: "y" }),
    );
    clearTraceStoreCache();
    await expect(deleteTraces(location, WS, { allOfWorkspace: true })).rejects.toThrow(
      /E_TRACE_STORE_SCHEMA_TOO_NEW/,
    );
    expect(existsSync(join(location.tracesDir, WS))).toBe(true);
  });
});

describe("deletion serialised with an append", () => {
  it("neither loses nor duplicates a record when an append races a delete", async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });

    // A holder stands in for work already inside the lock.
    const holder = withWorkspaceLock(WS, async () => {
      await gate;
    });
    await new Promise((r) => setTimeout(r, 5));

    const deletion = deleteTraces(location, WS, { traceId: "req-A" });
    const appended = appendRecord(location, record({ at: "2026-09-13T10:00:00.000Z", requestId: "req-C", turnId: "t-c" }));

    release();
    await holder;
    await deletion;
    await appended;

    clearTraceStoreCache();
    const keys = readRecords(location, WS).records.map(traceKeyOf);
    // req-A is gone; every other trace survives exactly once.
    expect(keys.filter((key) => key === "req-A")).toEqual([]);
    expect(keys.filter((key) => key === "req-C")).toHaveLength(1);
    expect(keys.filter((key) => key === "req-B")).toHaveLength(1);
    expect(keys.filter((key) => key === "req-old")).toHaveLength(1);
  });
});

describe("no automatic deletion path", () => {
  it("is never called by a hook, timer or retention rule in the plugin", () => {
    const sources = [
      readFileSync("plugin/server/collector.ts", "utf8"),
      readFileSync("plugin/index.server.ts", "utf8"),
      readFileSync("plugin/server/trace-store.ts", "utf8"),
    ].join("\n");
    // The only mention of deleteTraces in the payload is its own definition.
    expect(sources.match(/deleteTraces/g) ?? []).toHaveLength(1);
    expect(sources).not.toMatch(/setInterval|setTimeout\([^)]*delete/i);
    expect(planDeletion).toBeTypeOf("function");
  });
});
