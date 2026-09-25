import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyBeadStats,
  handleBeadsStats,
  handleTracesDelete,
  fallbackCountsOf,
  incidentsIn,
  readTraceContext,
  requireLocation,
  workspaceDirectory,
  type DashboardPaseo,
} from "../plugin/server/dashboard-rpc";
import { appendRecord, clearTraceStoreCache, readRecords } from "../plugin/server/trace-store";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { TRACE_STORE_SCHEMA_VERSION, type FallbackIncident, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-208 / WP-210: the Dashboard RPC handlers, against a fake Paseo SDK and a
 * fake install home. No daemon, no real HOME.
 */

const WS = "wks_1";
let home: string;
let workspace: string;

function fakePaseo(overrides: { entries?: Array<Record<string, unknown>>; plugins?: Record<string, unknown> } = {}): DashboardPaseo {
  return {
    agents: { list: vi.fn(async () => ({ entries: [] })) },
    workspaces: {
      list: vi.fn(async () => ({
        entries: overrides.entries ?? [{ id: WS, directory: workspace, name: "repo" }],
      })),
    },
    config: {
      get: vi.fn(async () => ({
        config: {
          plugins: overrides.plugins ?? { "paseo-bm": { source: "directory", path: join(home, "plugin", "0.2.0") } },
        },
      })),
    },
  };
}

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-rpc-"));
  workspace = join(home, "repo");
  mkdirSync(join(workspace, ".beads"), { recursive: true });
  writeFileSync(join(home, "install.json"), JSON.stringify({ schemaVersion: 1 }));
  clearTraceStoreCache();
  clearBeadsCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("requireLocation", () => {
  it("resolves the trace store from the registered plugin path", async () => {
    const location = await requireLocation(fakePaseo());
    expect(location.tracesDir).toBe(join(home, "traces"));
  });

  it("fails with a coded error when the store cannot be resolved", async () => {
    // `homedir` is injected at an empty directory so this test cannot pass or
    // fail because of a real paseo-bm installation on the machine running it.
    await expect(
      requireLocation(fakePaseo({ plugins: {} }), { homedir: () => join(home, "empty-home") }),
    ).rejects.toThrow(/E_TRACE_STORE_UNWRITABLE/);
  });
});

describe("workspaceDirectory", () => {
  it("finds the directory by workspace id", async () => {
    expect(await workspaceDirectory(fakePaseo(), WS)).toBe(workspace);
  });

  it("reads a nested workspace entry and the cwd fallback", async () => {
    const nested = fakePaseo({ entries: [{ workspace: { id: WS, cwd: "/from/cwd" } }] });
    expect(await workspaceDirectory(nested, WS)).toBe("/from/cwd");
  });

  it("never reads a worktree's beads from the main checkout", async () => {
    const worktree = fakePaseo({
      entries: [
        { id: WS, kind: "worktree", directory: "/repo/.worktrees/feature", projectRootPath: "/repo" },
        { id: "wks_2", kind: "worktree", projectRootPath: "/repo" },
        { id: "wks_3", workspaceKind: "local_checkout", workspaceDirectory: "/other" },
      ],
    });
    expect(await workspaceDirectory(worktree, WS)).toBe("/repo/.worktrees/feature");
    // No directory of its own: unknown, not the main checkout's beads.
    expect(await workspaceDirectory(worktree, "wks_2")).toBeNull();
    expect(await workspaceDirectory(worktree, "wks_3")).toBe("/other");
  });

  it("returns null for an unknown workspace or a failing list", async () => {
    expect(await workspaceDirectory(fakePaseo({ entries: [] }), WS)).toBeNull();
    const failing: DashboardPaseo = {
      agents: { list: async () => ({ entries: [] }) },
      workspaces: {
        list: async () => {
          throw new Error("no daemon");
        },
      },
      config: fakePaseo().config,
    };
    expect(await workspaceDirectory(failing, WS)).toBeNull();
  });
});

describe("beads.stats handler", () => {
  it("returns the counts of the workspace's bead store", async () => {
    writeFileSync(
      join(workspace, ".beads", "issues.jsonl"),
      [
        JSON.stringify({ id: "bm-1", status: "open", issue_type: "task", dependencies: [] }),
        JSON.stringify({ id: "bm-2", status: "closed", issue_type: "task", dependencies: [] }),
      ].join("\n") + "\n",
    );
    clearBeadsCache();
    const { stats } = await handleBeadsStats({ workspaceId: WS }, fakePaseo());
    expect(stats).toMatchObject({ total: 2, open: 1, closed: 1, ready: 1, present: true });
  });

  it("reports an empty store, not an error, for a workspace Paseo no longer lists", async () => {
    const { stats } = await handleBeadsStats({ workspaceId: "wks_gone" }, fakePaseo());
    expect(stats.present).toBe(false);
    expect(stats.source).toContain("not listed by Paseo");
    expect(emptyBeadStats("x").total).toBe(0);
  });

  it("reports an empty store for a workspace with no .beads directory", async () => {
    rmSync(join(workspace, ".beads"), { recursive: true, force: true });
    clearBeadsCache();
    const { stats } = await handleBeadsStats({ workspaceId: WS }, fakePaseo());
    expect(stats.present).toBe(false);
  });
});

describe("traces.delete handler", () => {
  it("previews without deleting, then deletes and reports the new store size", async () => {
    const location = { tracesDir: join(home, "traces") };
    const ask = (requestId: string, at: string) =>
      record({
        agentId: "agent-manager",
        role: "manager",
        turnId: `m-${requestId}`,
        requestId,
        at,
        sent: [{ agentId: null, at, text: `please do ${requestId}`, truncated: false }],
      });
    await appendRecord(location, ask("req-A", "2026-09-16T09:59:00.000Z"));
    await appendRecord(location, record());
    await appendRecord(location, ask("req-B", "2026-09-16T10:30:00.000Z"));
    await appendRecord(location, record({ turnId: "turn-2", requestId: "req-B", at: "2026-09-16T10:31:00.000Z" }));
    clearTraceStoreCache();

    // The id the Dashboard row carries (`req:<requestId>`), not the store key.
    // WP-214 acceptance: the old test used the store key, so the button that
    // sends the row id matched nothing and deleted nothing, unnoticed.
    const preview = await handleTracesDelete(
      { workspaceId: WS, scope: { traceId: "req:req-A" }, dryRun: true },
      fakePaseo(),
    );
    expect(preview.deleted.traces).toBe(1);
    expect(readRecords(location, WS).records).toHaveLength(4);

    const done = await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" } }, fakePaseo());
    expect(done.deleted).toEqual(preview.deleted);
    // Both of req-A's records go — the Manager turn and the Worker turn — and
    // req-B's two stay.
    expect(readRecords(location, WS).records.map((entry) => entry.requestId)).toEqual(["req-B", "req-B"]);
    expect(done.store.workspaceBytes).toBeGreaterThan(0);
  });

  it("counts the requests in scope that still have a running agent (REQ-054e)", async () => {
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, record({ agentId: "agent-manager", role: "manager", turnId: "m-A", sent: [{ agentId: null, at: "2026-09-16T09:59:00.000Z", text: "do A", truncated: false }] }));
    await appendRecord(location, record({ agentId: "agent-manager", role: "manager", turnId: "m-B", requestId: "req-B", at: "2026-09-16T10:30:00.000Z", sent: [{ agentId: null, at: "2026-09-16T10:30:00.000Z", text: "do B", truncated: false }] }));
    clearTraceStoreCache();
    const paseo = fakePaseo();
    paseo.agents.list = vi.fn(async ({ filter }) => ({
      entries:
        filter.labels === undefined || filter.labels["bm.role"] === "worker"
          ? [{ id: "agent-running", workspaceId: WS, status: "running", labels: { "bm.role": "worker", "bm.requestId": "req-B" } }]
          : [],
    }));
    const all = await handleTracesDelete({ workspaceId: WS, scope: { allOfWorkspace: true }, dryRun: true }, paseo);
    expect(all.deleted.running).toBe(1);
    const onlyA = await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" }, dryRun: true }, paseo);
    expect(onlyA.deleted.running).toBe(0);
  });

  it("refuses a trace id the Dashboard would not show", async () => {
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, record());
    clearTraceStoreCache();
    await expect(
      handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-missing" } }, fakePaseo()),
    ).rejects.toThrow(/E_TRACE_NOT_FOUND/);
  });

  it("surfaces the coded error for an invalid workspace id", async () => {
    await expect(
      handleTracesDelete({ workspaceId: "../escape", scope: { allOfWorkspace: true } }, fakePaseo()),
    ).rejects.toThrow(/E_TRACE_STORE_UNWRITABLE/);
  });
});

describe("review calls of a Reviewer that replaced a stopped one (delta 20260921 §4.5.1)", () => {
  const incident: FallbackIncident = {
    id: "fb-00000000000b",
    role: "reviewer",
    workspaceId: WS,
    requestId: "req-A",
    agentId: "agent-rev-1",
    agentProvider: "bm-reviewer/gpt-5",
    agentModel: "gpt-5",
    parentId: "agent-worker",
    managerId: "agent-manager",
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: null,
    candidate: null,
    status: "switched",
    detectedAt: "2026-09-16T10:15:00.000Z",
    decidedAt: "2026-09-16T10:16:00.000Z",
    waitUntil: null,
    replacementId: "agent-rev-2",
    error: null,
  };

  it("counts the resend once, like the BM-BUDGET check, and as before without a usable incidents file", async () => {
    const location = { tracesDir: join(home, "traces") };
    const said = (at: string, text: string) => [{ agentId: null, at, text, truncated: false }];
    await appendRecord(location, record({ agentId: "agent-manager", role: "manager", turnId: "m-A", at: "2026-09-16T10:00:00.000Z", sent: said("2026-09-16T10:00:00.000Z", "do A") }));
    // agent-rev-1 got one review call and stopped on its plan; agent-rev-2 got the same message again.
    for (const [agentId, at] of [["agent-rev-1", "2026-09-16T10:10:00.000Z"], ["agent-rev-2", "2026-09-16T10:20:00.000Z"]] as const) {
      await appendRecord(location, record({ agentId, role: "reviewer", turnId: `r-${agentId}`, parentAgentId: "agent-worker", at, sent: said(at, "Review batch b1 of req-A.") }));
    }
    clearTraceStoreCache();
    const labels = (role: string) => ({ "bm.role": role, "bm.requestId": "req-A", "paseo.parent-agent-id": role === "worker" ? "agent-manager" : "agent-worker" });
    const paseo = fakePaseo();
    paseo.agents.list = vi.fn(async () => ({
      entries: [
        { id: "agent-worker", workspaceId: WS, status: "idle", labels: labels("worker") },
        { id: "agent-rev-1", workspaceId: WS, status: "idle", labels: labels("reviewer") },
        { id: "agent-rev-2", workspaceId: WS, status: "idle", labels: labels("reviewer") },
      ],
    }));
    const reviewCalls = async () =>
      (await readTraceContext({ workspaceId: WS }, paseo)).traces.find((trace) => trace.requestId === "req-A")?.reviewCalls;

    expect(await reviewCalls()).toBe(2);
    writeFileSync(join(home, "role-fallback-state.json"), JSON.stringify({ version: 1, incidents: [incident] }));
    expect(await reviewCalls()).toBe(1);
    writeFileSync(join(home, "role-fallback-state.json"), "{ not json");
    expect(await reviewCalls()).toBe(2);
  });
});

/**
 * Provider-plan incidents as errors of a request (delta 20260925 §3.4).
 *
 * An incident is a turn that died on the provider's plan, so it belongs in the
 * error count — but only when the turn itself still reported `completed`. An
 * incident with `signal: "failed"` came from a turn whose record says `failed`,
 * and `errorsOf` already counts that one.
 */
describe("fallback incidents that count as errors", () => {
  const base: FallbackIncident = {
    id: "fb-00000000000c",
    role: "worker",
    workspaceId: WS,
    requestId: "req-A",
    agentId: "agent-worker",
    agentProvider: "bm-worker/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: "agent-manager",
    managerId: "agent-manager",
    class: "L1",
    signal: "completed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: null,
    candidate: null,
    status: "pending",
    detectedAt: "2026-09-25T10:15:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
  };
  const of = (...overrides: Array<Partial<FallbackIncident>>) =>
    fallbackCountsOf(
      overrides.map((override, index) => ({ ...base, id: `fb-00000000${String(index).padStart(4, "0")}`, ...override })),
      WS,
    );

  it("counts one per request, whatever became of the incident", () => {
    expect([...of({}, { requestId: "req-B" }, { requestId: "req-B", status: "switched" }, { status: "dismissed" })]).toEqual([
      ["req-A", 2],
      ["req-B", 2],
    ]);
  });

  it("leaves out a turn that already failed, another workspace, and a Manager's own incident", () => {
    expect([...of({ signal: "failed" })]).toEqual([]);
    expect([...of({ workspaceId: "wks_other" })]).toEqual([]);
    expect([...of({ requestId: null, role: "manager" })]).toEqual([]);
  });

  it("reads the incidents file once and survives it being missing or broken", async () => {
    expect(incidentsIn(null)).toEqual([]);
    expect(incidentsIn(home)).toEqual([]);
    writeFileSync(join(home, "role-fallback-state.json"), JSON.stringify({ version: 1, incidents: [base] }));
    expect(incidentsIn(home).map((entry) => entry.id)).toEqual([base.id]);
    writeFileSync(join(home, "role-fallback-state.json"), "{ not json");
    expect(incidentsIn(home)).toEqual([]);
  });

  it("hands the count to the rows of the request it belongs to", async () => {
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, record({ requestId: "req-A", agentId: "agent-manager", role: "manager" }));
    clearTraceStoreCache();
    writeFileSync(join(home, "role-fallback-state.json"), JSON.stringify({ version: 1, incidents: [base] }));
    const context = await readTraceContext({ workspaceId: WS }, fakePaseo());
    expect(context.fallbackCounts.get("req-A")).toBe(1);
    expect(context.fallbackCounts.get("req-B")).toBeUndefined();
  });
});
