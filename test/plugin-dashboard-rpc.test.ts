import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyBeadStats,
  handleBeadsStats,
  handleTracesDelete,
  readTraceContext,
  requireLocation,
} from "../plugin/server/dashboard-rpc";
import { fallbackCountsOf, incidentsIn } from "../plugin/server/fallback-state";
import { workspaceDirectory, type DashboardPaseo } from "../plugin/server/paseo-directory";
import { appendRecord, clearTraceStoreCache, readRecords } from "../plugin/server/trace-store";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { ORCHESTRATOR_DIR_NAME, RETIRED_ASSESSMENTS_DIR_NAME } from "../plugin/server/orchestrator-store";
import { createDecisionStore } from "../plugin/server/decision-store";
import { withdrawDecision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";
import { TRACE_STORE_SCHEMA_VERSION, type FallbackIncident, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-208 / WP-210: the Dashboard RPC handlers, against a fake Paseo SDK and a
 * temporary data folder. No daemon, no real HOME.
 *
 * From 0.4.0 the trace store is found with `resolveDataHome` (design §5.1), so
 * the folder is named by `PASEO_BM_HOME` rather than by the plugin path in the
 * fake Paseo configuration — which is also why no `install.json` is written
 * any more: nothing reads one.
 */

const WS = "wks_1";
let home: string;
let workspace: string;

/** A line of the workflow assessments an earlier build kept, quoting a request (autonomy design §B.9). */
const EARLIER_ASSESSMENT = `${JSON.stringify({ v: 1, assessmentId: "asm-A", requestId: "req-A", traceId: "req:req-A", status: "done", result: { findings: ["please do req-A"] } })}\n`;
const assessmentsFile = (workspaceId: string) => join(home, ORCHESTRATOR_DIR_NAME, RETIRED_ASSESSMENTS_DIR_NAME, `${workspaceId}.jsonl`);
function earlierAssessments(workspaceId: string): void {
  mkdirSync(join(home, ORCHESTRATOR_DIR_NAME, RETIRED_ASSESSMENTS_DIR_NAME), { recursive: true });
  writeFileSync(assessmentsFile(workspaceId), EARLIER_ASSESSMENT);
}

/** The shared fake SDK: these workspace entries (the one at `workspace` by default) and these agents. */
function daemonWith(options: { entries?: Array<Record<string, unknown>>; agents?: Array<Record<string, unknown> & { id: string }> } = {}): DashboardPaseo {
  return fakePaseo<DashboardPaseo>({ workspaces: options.entries ?? [{ id: WS, directory: workspace, name: "repo" }], agents: options.agents ?? [] }).paseo;
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
  process.env["PASEO_BM_HOME"] = home;
  clearTraceStoreCache();
  clearBeadsCache();
});

afterEach(() => {
  delete process.env["PASEO_BM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

describe("requireLocation", () => {
  it("resolves the trace store inside the data folder, with no install.json", async () => {
    const location = await requireLocation(daemonWith());
    expect(location.tracesDir).toBe(join(home, "traces"));
  });

  it("fails E_DATA_HOME_UNAVAILABLE when the data folder cannot be used (code review 2026-09-30 §3.2)", async () => {
    process.env["PASEO_BM_HOME"] = "relative/bm";
    await expect(requireLocation(daemonWith())).rejects.toThrow(/^E_DATA_HOME_UNAVAILABLE: cannot open the trace store: paseo-bm cannot use its data folder/);
  });
});

describe("workspaceDirectory", () => {
  it("finds the directory by workspace id", async () => {
    expect(await workspaceDirectory(daemonWith(), WS)).toBe(workspace);
  });

  it("reads a nested workspace entry and the cwd fallback", async () => {
    const nested = daemonWith({ entries: [{ workspace: { id: WS, cwd: "/from/cwd" } }] });
    expect(await workspaceDirectory(nested, WS)).toBe("/from/cwd");
  });

  it("never reads a worktree's beads from the main checkout", async () => {
    const worktree = daemonWith({
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
    expect(await workspaceDirectory(daemonWith({ entries: [] }), WS)).toBeNull();
    const failing = fakePaseo<DashboardPaseo>();
    failing.api.workspaces.list.mockRejectedValue(new Error("no daemon"));
    expect(await workspaceDirectory(failing.paseo, WS)).toBeNull();
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
    const { stats } = await handleBeadsStats({ workspaceId: WS }, daemonWith());
    expect(stats).toMatchObject({ total: 2, open: 1, closed: 1, ready: 1, present: true });
  });

  it("reports an empty store, not an error, for a workspace Paseo no longer lists", async () => {
    const { stats } = await handleBeadsStats({ workspaceId: "wks_gone" }, daemonWith());
    expect(stats.present).toBe(false);
    expect(stats.source).toContain("not listed by Paseo");
    expect(emptyBeadStats("x").total).toBe(0);
  });

  it("reports an empty store for a workspace with no .beads directory", async () => {
    rmSync(join(workspace, ".beads"), { recursive: true, force: true });
    clearBeadsCache();
    const { stats } = await handleBeadsStats({ workspaceId: WS }, daemonWith());
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
      daemonWith(),
    );
    expect(preview.deleted.traces).toBe(1);
    expect(readRecords(location, WS).records).toHaveLength(4);

    const done = await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" } }, daemonWith());
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
    const paseo = daemonWith({ agents: [{ id: "agent-running", workspaceId: WS, status: "running", labels: { "bm.role": "worker", "bm.requestId": "req-B" } }] });
    const all = await handleTracesDelete({ workspaceId: WS, scope: { allOfWorkspace: true }, dryRun: true }, paseo);
    expect(all.deleted.running).toBe(1);
    const onlyA = await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" }, dryRun: true }, paseo);
    expect(onlyA.deleted.running).toBe(0);
  });

  // Orchestrator design §5.3, REQ-075 e; autonomy design §B.9: the workflow
  // assessment is retired, but an earlier build's file may quote the project's
  // requests, so it goes whole when any of their traces is deleted.
  it("deletes the project's retired assessments file with a real delete, none on a preview or a cutoff that reaches nothing, and no other project's", async () => {
    const location = { tracesDir: join(home, "traces") };
    const ask = (requestId: string, at: string) =>
      record({ agentId: "agent-manager", role: "manager", turnId: `m-${requestId}`, requestId, at, sent: [{ agentId: null, at, text: `please do ${requestId}`, truncated: false }] });
    await appendRecord(location, ask("req-A", "2026-09-16T09:59:00.000Z"));
    await appendRecord(location, ask("req-B", "2026-09-16T10:30:00.000Z"));
    clearTraceStoreCache();
    for (const workspaceId of [WS, "wks_2"]) earlierAssessments(workspaceId);

    await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" }, dryRun: true }, daemonWith());
    expect(existsSync(assessmentsFile(WS))).toBe(true);
    await handleTracesDelete({ workspaceId: WS, scope: { before: "2026-01-01T00:00:00.000Z" } }, daemonWith());
    expect(existsSync(assessmentsFile(WS))).toBe(true);

    await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" } }, daemonWith());
    expect(existsSync(assessmentsFile(WS))).toBe(false);
    // Another project's file stays, and so does req-B's trace.
    expect(readFileSync(assessmentsFile("wks_2"), "utf8")).toBe(EARLIER_ASSESSMENT);
    expect(readRecords(location, WS).records.map((entry) => entry.requestId)).toEqual(["req-B"]);
    // Deleting again with the file gone is no error.
    await handleTracesDelete({ workspaceId: WS, scope: { allOfWorkspace: true } }, daemonWith());
    expect(readRecords(location, WS).records).toEqual([]);
  });

  // Autonomy design §A.4: deleting a request's traces deletes its settled
  // decisions; an open one stays for the owner to answer.
  it("deletes the settled decisions of the deleted requests, and none on a preview", async () => {
    const location = { tracesDir: join(home, "traces") };
    const ask = (requestId: string, at: string) =>
      record({ agentId: "agent-manager", role: "manager", turnId: `m-${requestId}`, requestId, at, sent: [{ agentId: null, at, text: `do ${requestId}`, truncated: false }] });
    await appendRecord(location, ask("req-A", "2026-09-16T09:59:00.000Z"));
    await appendRecord(location, ask("req-B", "2026-09-16T10:30:00.000Z"));
    clearTraceStoreCache();
    const decisions = createDecisionStore(home);
    const at = "2026-09-16T12:00:00.000Z";
    decisions.open(makeDecision({ workspaceId: WS, id: "q:req-A:Q1", requestId: "req-A" }));
    decisions.open(makeDecision({ workspaceId: WS, id: "q:req-A:Q2", requestId: "req-A" }));
    decisions.open(makeDecision({ workspaceId: WS, id: "q:req-B:Q1", requestId: "req-B" }));
    decisions.transition("q:req-A:Q1", (d) => withdrawDecision(d, { at }));
    decisions.transition("q:req-B:Q1", (d) => withdrawDecision(d, { at }));
    const ids = () => decisions.list({ workspaceId: WS }).map((entry) => entry.id);

    await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" }, dryRun: true }, daemonWith());
    expect(ids()).toEqual(["q:req-A:Q1", "q:req-A:Q2", "q:req-B:Q1"]);

    await handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" } }, daemonWith());
    expect(ids()).toEqual(["q:req-A:Q2", "q:req-B:Q1"]);
  });

  it("keeps the retired assessments file when the trace store refuses the delete", async () => {
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, record({ agentId: "agent-manager", role: "manager", turnId: "m-A", sent: [{ agentId: null, at: "2026-09-16T10:00:00.000Z", text: "do A", truncated: false }] }));
    writeFileSync(join(location.tracesDir, "meta.json"), JSON.stringify({ schemaVersion: TRACE_STORE_SCHEMA_VERSION + 1, createdAt: "x", updatedAt: "y" }));
    clearTraceStoreCache();
    earlierAssessments(WS);

    await expect(handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-A" } }, daemonWith())).rejects.toThrow(/E_TRACE_STORE_SCHEMA_TOO_NEW/);

    expect(readFileSync(assessmentsFile(WS), "utf8")).toBe(EARLIER_ASSESSMENT);
  });

  it("refuses a trace id the Dashboard would not show", async () => {
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, record());
    clearTraceStoreCache();
    await expect(
      handleTracesDelete({ workspaceId: WS, scope: { traceId: "req:req-missing" } }, daemonWith()),
    ).rejects.toThrow(/E_TRACE_NOT_FOUND/);
  });

  it("surfaces the coded error for an invalid workspace id", async () => {
    await expect(
      handleTracesDelete({ workspaceId: "../escape", scope: { allOfWorkspace: true } }, daemonWith()),
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
    const paseo = daemonWith({
      agents: [
        { id: "agent-worker", workspaceId: WS, status: "idle", labels: labels("worker") },
        { id: "agent-rev-1", workspaceId: WS, status: "idle", labels: labels("reviewer") },
        { id: "agent-rev-2", workspaceId: WS, status: "idle", labels: labels("reviewer") },
      ],
    });
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
    const context = await readTraceContext({ workspaceId: WS }, daemonWith());
    expect(context.fallbackCounts.get("req-A")).toBe(1);
    expect(context.fallbackCounts.get("req-B")).toBeUndefined();
  });
});
