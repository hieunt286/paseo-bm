import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRecord,
  classifyWorkspaces,
  clearTraceStoreCache,
  monthlyFileName,
  reassignWorkspace,
  readRecords,
  readWorkspaceMeta,
  storedWorkspaceIds,
  traceKeyOf,
  writeWorkspaceMeta,
  type TraceStoreLocation,
} from "../plugin/server/trace-store";
import { handleTracesReassign, listedWorkspaces, type DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-210 part 2: workspace classification and reassignment.
 *
 * Two rules carry the risk here: a failed `workspaces.list()` must never
 * orphan anything, and a merge that is interrupted must not duplicate records.
 */

let home: string;
let location: TraceStoreLocation;
const FROM = "wks_old";
const TO = "wks_new";

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: FROM,
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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-reassign-"));
  location = { tracesDir: join(home, "traces") };
  writeFileSync(join(home, "install.json"), JSON.stringify({ schemaVersion: 1 }));
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("classification", () => {
  beforeEach(async () => {
    await appendRecord(location, record({ workspaceId: FROM }));
    await appendRecord(location, record({ workspaceId: "wks_live", requestId: "req-live" }));
    await appendRecord(location, record({ workspaceId: "wks_arch", requestId: "req-arch" }));
    writeWorkspaceMeta(location, FROM, {
      lastKnownName: "old-repo",
      lastKnownDirectory: "/repos/old-repo",
      lastSeenAt: "2026-09-16T10:00:00.000Z",
    });
    clearTraceStoreCache();
  });

  it("lists stored workspace ids", () => {
    expect(storedWorkspaceIds(location)).toEqual(["wks_arch", "wks_live", FROM]);
  });

  it("marks live, archived and orphaned workspaces", () => {
    const classified = classifyWorkspaces(location, [
      { id: "wks_live", archived: false },
      { id: "wks_arch", archived: true },
    ]);
    const byId = new Map(classified.map((entry) => [entry.workspaceId, entry]));
    expect(byId.get("wks_live")?.state).toBe("live");
    expect(byId.get("wks_arch")?.state).toBe("archived");
    expect(byId.get(FROM)?.state).toBe("orphaned");
    expect(byId.get(FROM)?.lastKnownName).toBe("old-repo");
    expect(byId.get(FROM)?.lastKnownDirectory).toBe("/repos/old-repo");
  });

  it("marks everything unknown when the workspace list could not be read", () => {
    const classified = classifyWorkspaces(location, null);
    expect(classified.every((entry) => entry.state === "unknown")).toBe(true);
  });

  it("handles a workspace with no metadata", () => {
    const classified = classifyWorkspaces(location, []);
    const live = classified.find((entry) => entry.workspaceId === "wks_live");
    expect(live).toMatchObject({ state: "orphaned", lastKnownName: null, lastKnownDirectory: null });
  });
});

describe("reassignment", () => {
  it("renames the directory when the destination has nothing", async () => {
    await appendRecord(location, record());
    await appendRecord(location, record({ turnId: "turn-2", requestId: "req-B" }));
    clearTraceStoreCache();

    const outcome = await reassignWorkspace(location, FROM, TO, { destinationExists: true });
    expect(outcome.traces).toBe(2);
    expect(existsSync(join(location.tracesDir, FROM))).toBe(false);
    const moved = readRecords(location, TO).records;
    expect(moved.map(traceKeyOf).sort()).toEqual(["req-A", "req-B"]);
    // The historical workspaceId inside each record is untouched.
    expect(moved.every((entry) => entry.workspaceId === FROM)).toBe(true);
  });

  it("merges into an existing destination with dedupe, keeping the destination metadata", async () => {
    await appendRecord(location, record());
    await appendRecord(location, record({ workspaceId: TO, requestId: "req-dest", turnId: "turn-d" }));
    // The same turn recorded twice, once per side: dedupe must keep one.
    const shared = record({ requestId: "req-shared", turnId: "turn-shared" });
    await appendRecord(location, shared);
    await appendRecord(location, { ...shared, workspaceId: TO });
    writeWorkspaceMeta(location, TO, {
      lastKnownName: "new-repo",
      lastKnownDirectory: "/repos/new-repo",
      lastSeenAt: "2026-09-16T10:00:00.000Z",
    });
    clearTraceStoreCache();

    await reassignWorkspace(location, FROM, TO, { destinationExists: true });
    const keys = readRecords(location, TO).records.map(traceKeyOf);
    expect(keys.filter((key) => key === "req-shared")).toHaveLength(1);
    expect(keys).toContain("req-A");
    expect(keys).toContain("req-dest");
    expect(existsSync(join(location.tracesDir, FROM))).toBe(false);
    expect(readWorkspaceMeta(location, TO)?.lastKnownName).toBe("new-repo");
  });

  it("keeps lines it cannot read on either side of a merge", async () => {
    await appendRecord(location, record());
    await appendRecord(location, record({ workspaceId: TO, requestId: "req-dest", turnId: "turn-d" }));
    const month = monthlyFileName("2026-09-16T10:00:00.000Z");
    appendFileSync(join(location.tracesDir, FROM, month), "{from a newer version\n");
    appendFileSync(join(location.tracesDir, TO, month), "{also unreadable\n");
    clearTraceStoreCache();

    await reassignWorkspace(location, FROM, TO, { destinationExists: true });
    const body = readFileSync(join(location.tracesDir, TO, month), "utf8");
    expect(body).toContain("{from a newer version");
    expect(body).toContain("{also unreadable");
    expect(readRecords(location, TO).records).toHaveLength(2);
  });

  it("reports the same counts in a dry run and changes nothing", async () => {
    await appendRecord(location, record());
    clearTraceStoreCache();
    const planned = await reassignWorkspace(location, FROM, TO, { dryRun: true, destinationExists: true });
    expect(planned.traces).toBe(1);
    expect(existsSync(join(location.tracesDir, FROM))).toBe(true);
    const done = await reassignWorkspace(location, FROM, TO, { destinationExists: true });
    expect(done).toEqual(planned);
  });

  it("refuses from == to and a destination Paseo does not list", async () => {
    await appendRecord(location, record());
    await expect(reassignWorkspace(location, FROM, FROM)).rejects.toThrow(/E_TRACE_REASSIGN_INVALID/);
    await expect(
      reassignWorkspace(location, FROM, TO, { destinationExists: false }),
    ).rejects.toThrow(/E_TRACE_REASSIGN_INVALID/);
    expect(existsSync(join(location.tracesDir, FROM))).toBe(true);
  });

  it("refuses an invalid or escaping workspace id", async () => {
    for (const bad of ["..", "has/slash", ""]) {
      await expect(reassignWorkspace(location, bad, TO)).rejects.toThrow(/E_TRACE_STORE_UNWRITABLE/);
      await expect(reassignWorkspace(location, FROM, bad)).rejects.toThrow(/E_TRACE_STORE_UNWRITABLE/);
    }
  });

  it("refuses a symlinked source or destination and leaves the target intact", async () => {
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");
    mkdirSync(location.tracesDir, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(location.tracesDir, "wks_link"));

    await expect(
      reassignWorkspace(location, "wks_link", TO, { destinationExists: true }),
    ).rejects.toThrow(/refusing to use a symlinked path/);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("keep me");
  });

  it("does not duplicate records when the merge is run twice (interruption safety)", async () => {
    await appendRecord(location, record());
    await appendRecord(location, record({ workspaceId: TO, requestId: "req-dest", turnId: "turn-d" }));
    clearTraceStoreCache();

    await reassignWorkspace(location, FROM, TO, { destinationExists: true });
    // Re-running finds an empty source: the outcome is zero and nothing changes.
    const second = await reassignWorkspace(location, FROM, TO, { destinationExists: true });
    expect(second.traces).toBe(0);
    const keys = readRecords(location, TO).records.map(traceKeyOf);
    expect(keys.filter((key) => key === "req-A")).toHaveLength(1);
  });
});

describe("reassign handler", () => {
  function fakePaseo(entries: Array<Record<string, unknown>>): DashboardPaseo {
    return {
      agents: { list: vi.fn(async () => ({ entries: [] })) },
      workspaces: { list: vi.fn(async () => ({ entries })) },
      config: {
        get: vi.fn(async () => ({
          config: { plugins: { "paseo-bm": { source: "directory", path: join(home, "plugin", "0.2.0") } } },
        })),
      },
    };
  }

  it("moves traces onto a workspace Paseo lists and reports the new size", async () => {
    await appendRecord(location, record());
    clearTraceStoreCache();
    const result = await handleTracesReassign(
      { fromWorkspaceId: FROM, toWorkspaceId: TO },
      fakePaseo([{ id: TO, directory: "/repos/new" }]),
    );
    expect(result.moved.traces).toBe(1);
    expect(result.store.workspaceBytes).toBeGreaterThan(0);
  });

  it("refuses a destination that is not listed", async () => {
    await appendRecord(location, record());
    clearTraceStoreCache();
    await expect(
      handleTracesReassign({ fromWorkspaceId: FROM, toWorkspaceId: TO }, fakePaseo([{ id: "other" }])),
    ).rejects.toThrow(/E_TRACE_REASSIGN_INVALID/);
  });

  it("reads archived state from archivingAt and reports null on a failing list", async () => {
    const listed = await listedWorkspaces(fakePaseo([{ id: TO, archivingAt: "2026-09-16T00:00:00.000Z" }]));
    expect(listed).toEqual([{ id: TO, archived: true, directory: null }]);

    const failing: DashboardPaseo = {
      agents: { list: async () => ({ entries: [] }) },
      workspaces: {
        list: async () => {
          throw new Error("no daemon");
        },
      },
      config: fakePaseo([]).config,
    };
    expect(await listedWorkspaces(failing)).toBeNull();
  });
});
