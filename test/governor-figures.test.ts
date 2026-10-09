import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOVERNOR_FIGURES,
  governorFiguresOf,
  lastCriterionChangeOf,
  liveWorkersOf,
  readGovernorSnapshot,
  type GovernorFigure,
  type GovernorRequestFacts,
  type GovernorSnapshot,
} from "../plugin/server/governor-figures";
import { createAlertStore } from "../plugin/server/alert-store";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore, type Mission } from "../plugin/server/mission-store";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { appendRecord } from "../plugin/server/trace-store";
import { DEFAULT_COORDINATION_SETTINGS, GOVERNOR_BOUNDS } from "../plugin/shared/coordination";
import type { TraceRecord } from "../plugin/shared/contracts";
import { file, report, turn } from "./fixtures/orchestrator-traces";

/**
 * The governor's figures (missions design §9.2): each family computed from a
 * fixture snapshot, against the design's default thresholds; then the
 * snapshot as the stores of a temporary data folder give it.
 */

const NOW = "2026-10-09T12:00:00.000Z";
const hoursAgo = (hours: number): string => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();
const SETTINGS = DEFAULT_COORDINATION_SETTINGS.governor;

const MISSION: Mission = {
  missionId: "mis-0123456789",
  code: "PAY",
  name: "Payments",
  state: "open",
  createdAt: hoursAgo(48),
  closedAt: null,
  createdBy: "owner",
  parentMissionId: null,
  splitReason: null,
  legacyWorkspaceId: null,
  mainId: "main-1",
  mainHistory: [{ agentId: "main-1", from: hoursAgo(48), to: null, reason: "created" }],
  charter: {
    goal: "Ship card payments",
    repos: ["repo-a", "repo-b"],
    nonGoals: [],
    doneCriteria: [{ id: "D1", text: "a card payment goes through", status: "open", at: null, evidence: null }],
    budget: null,
    confirmedAt: hoursAgo(40),
  },
  plan: { text: "", updatedAt: null },
  contracts: [],
};

const mission = (charter: Partial<Mission["charter"]> = {}): Mission => ({ ...MISSION, charter: { ...MISSION.charter, ...charter } });

function request(requestId: string, over: Partial<GovernorRequestFacts> = {}): GovernorRequestFacts {
  return { requestId, workspaceId: "repo-a", rosterState: "active", workerIds: [], finishedAt: null, tier: null, reviewCalls: 0, reviewGranted: 0, reviewExempt: 0, ...over };
}

function snapshot(over: Partial<GovernorSnapshot> = {}): GovernorSnapshot {
  return {
    now: NOW,
    mission: MISSION,
    requests: [],
    liveWorkers: [],
    records: [],
    directories: { "repo-a": "/work/repo-a", "repo-b": "/work/repo-b" },
    mainTurnEnds: [],
    decisions: [],
    dropped: [],
    alerts: [],
    links: [],
    reviewBudget: { Small: 2, Medium: 2, Large: 4 },
    ...over,
  };
}

const figuresOf = (over: Partial<GovernorSnapshot> = {}) => governorFiguresOf(snapshot(over), SETTINGS);
const figureOf = (figures: readonly GovernorFigure[], id: keyof typeof GOVERNOR_FIGURES): GovernorFigure => {
  const found = figures.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no figure ${id}`);
  return found;
};

/** A Worker's turn in `workspaceId` that wrote `paths`, ending `hours` ago. */
const wrote = (agentId: string, paths: readonly string[], hours = 1, workspaceId = "repo-a"): TraceRecord =>
  turn({ workspaceId, agentId, role: "worker", endedAt: hoursAgo(hours), at: hoursAgo(hours), evidence: paths.map((path) => file(path, hoursAgo(hours), agentId)) });

const question = (requestId: string, n: number, subject: string | null, status: "open" | "answered" = "open", askedAt = hoursAgo(1)) => ({
  id: `q:${requestId}:${n}`,
  requestId,
  subject,
  askedAt,
  status,
});

describe("the defaults are the design's table (§9.2)", () => {
  it("holds each threshold and the ladder's window", () => {
    expect(SETTINGS).toEqual({
      writersPerFile: 2,
      workersPerRepo: 3,
      reAsks: 2,
      dropped: 1,
      processDocsPerCriterion: 3,
      beadsPerRequest: 15,
      tierRaised: 2,
      reviewExhausted: 2,
      openApprovals: 8,
      mainTurnsSinceCriterion: 40,
      finishedSinceCriterion: 6,
      outsideCharter: 1,
      cardAgeHours: 24,
      budgetPercent: 100,
      windowMinutes: 30,
      windowTurns: 5,
    });
    for (const [name, bounds] of Object.entries(GOVERNOR_BOUNDS)) expect(bounds.default, name).toBe(SETTINGS[name as keyof typeof SETTINGS]);
  });

  it("an empty mission crosses nothing, and has budget figures only for its budget's fields", () => {
    const figures = figuresOf();
    expect(figures.map((entry) => entry.id)).toEqual(Object.keys(GOVERNOR_FIGURES).filter((id) => !id.endsWith("Budget")));
    expect(figures.filter((entry) => entry.crossed)).toEqual([]);
    const budgeted = governorFiguresOf(snapshot({ mission: mission({ budget: { requests: 4, workers: null, reviewCalls: 0, days: null } }) }), SETTINGS);
    expect(budgeted.filter((entry) => entry.family === "budget").map((entry) => entry.id)).toEqual(["requestsBudget"]);
  });
});

describe("mess", () => {
  it("counts live Workers writing one file in 24 hours, absolute and relative paths alike", () => {
    const live = [
      { agentId: "w1", workspaceId: "repo-a" },
      { agentId: "w2", workspaceId: "repo-a" },
    ];
    const crossed = figureOf(figuresOf({ liveWorkers: live, records: [wrote("w1", ["/work/repo-a/src/pay.ts"]), wrote("w2", ["src/pay.ts"])] }), "writersOnOneFile");
    expect(crossed).toMatchObject({ family: "mess", value: 2, threshold: 2, op: ">=", crossed: true, detail: "repo-a: src/pay.ts" });
    // A Worker that is not live, or a write older than 24 hours, does not count.
    expect(figureOf(figuresOf({ liveWorkers: live.slice(0, 1), records: [wrote("w1", ["src/pay.ts"]), wrote("w2", ["src/pay.ts"])] }), "writersOnOneFile").value).toBe(1);
    expect(figureOf(figuresOf({ liveWorkers: live, records: [wrote("w1", ["src/pay.ts"]), wrote("w2", ["src/pay.ts"], 25)] }), "writersOnOneFile").crossed).toBe(false);
  });

  it("counts live Workers with an open request in one repo: more than 3, or more than the charter's Worker budget when lower", () => {
    const workers = (n: number) => Array.from({ length: n }, (_, i) => ({ agentId: `w${i}`, workspaceId: "repo-a" }));
    const atWork = (n: number, state: GovernorRequestFacts["rosterState"] = "active") =>
      Array.from({ length: n }, (_, i) => request(`req-20261009T10000${i}Z`, { rosterState: state, workerIds: [`w${i}`] }));
    expect(figureOf(figuresOf({ liveWorkers: workers(3), requests: atWork(3) }), "workersInOneRepo")).toMatchObject({ value: 3, threshold: 3, op: ">", crossed: false });
    expect(figureOf(figuresOf({ liveWorkers: workers(4), requests: atWork(4) }), "workersInOneRepo")).toMatchObject({ value: 4, crossed: true, detail: "repo-a" });
    const budget = { requests: null, workers: 2, reviewCalls: null, days: null };
    expect(figureOf(figuresOf({ mission: mission({ budget }), liveWorkers: workers(3), requests: atWork(3) }), "workersInOneRepo")).toMatchObject({ threshold: 2, crossed: true });
    // A Worker whose request finished or stopped, left idle for its Main to reuse, is no sprawl (the 2026-10-09 acceptance run).
    const done = [...atWork(2), request("req-20261009T100009Z", { rosterState: "finished", workerIds: ["w2"] }), request("req-20261009T100008Z", { rosterState: "stopped", workerIds: ["w3"] })];
    expect(figureOf(figuresOf({ liveWorkers: workers(4), requests: done }), "workersInOneRepo")).toMatchObject({ value: 2, crossed: false });
  });

  it("counts re-asks of one subject in one request", () => {
    const R = "req-20261009T100000Z";
    expect(figureOf(figuresOf({ decisions: [question(R, 1, "db"), question(R, 2, "db", "answered"), question(R, 3, "db")] }), "reAsks")).toMatchObject({
      value: 2,
      crossed: true,
      detail: `${R}: db`,
    });
    expect(figureOf(figuresOf({ decisions: [question(R, 1, "db"), question(R, 2, "api"), question("req-20261009T110000Z", 1, "db")] }), "reAsks").value).toBe(0);
  });

  it("counts the mission's dropped deliveries of the last 24 hours", () => {
    expect(figureOf(figuresOf({ dropped: [{ id: "out-1", outcomeAt: hoursAgo(2) }] }), "dropped")).toMatchObject({ value: 1, crossed: true });
    expect(figureOf(figuresOf({ dropped: [{ id: "out-1", outcomeAt: hoursAgo(30) }] }), "dropped").crossed).toBe(false);
  });
});

describe("overengineering", () => {
  it("counts process documents per done criterion not dropped", () => {
    const docs = wrote("w1", ["docs/plans/a.md", "docs/plans/b.md", "docs/adr/ADR-1.md", "/work/repo-a/docs/plans/c.md", "docs/design/x.md"]);
    expect(figureOf(figuresOf({ records: [docs] }), "processDocsPerCriterion")).toMatchObject({ value: 4, threshold: 3, op: ">", crossed: true });
    const two = mission({ doneCriteria: [...MISSION.charter.doneCriteria, { id: "D2", text: "refunds", status: "open", at: null, evidence: null }] });
    expect(figureOf(figuresOf({ mission: two, records: [docs] }), "processDocsPerCriterion")).toMatchObject({ value: 2, crossed: false });
    const dropped = mission({ doneCriteria: [...MISSION.charter.doneCriteria, { id: "D2", text: "refunds", status: "dropped", at: null, evidence: null }] });
    expect(figureOf(figuresOf({ mission: dropped, records: [docs] }), "processDocsPerCriterion").value).toBe(4);
  });

  it("counts beads created per finished request", () => {
    const R = "req-20261009T100000Z";
    const beads = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `bd-${from + i}`);
    const records = [
      turn({ workspaceId: "repo-a", agentId: "w1", role: "worker", requestId: R, reports: [report({ requestId: R, phase: "bead-implemented", beadsCreated: beads(0, 10) })] }),
      turn({ workspaceId: "repo-a", agentId: "w1", role: "worker", requestId: R, reports: [report({ requestId: R, phase: "finished", at: hoursAgo(1), beadsCreated: beads(5, 16) })] }),
    ];
    expect(figureOf(figuresOf({ records, requests: [request(R, { finishedAt: hoursAgo(1) })] }), "beadsPerFinishedRequest")).toMatchObject({ value: 16, threshold: 15, crossed: true });
    // An unfinished request is not counted.
    expect(figureOf(figuresOf({ records, requests: [request(R)] }), "beadsPerFinishedRequest").value).toBe(0);
  });

  it("counts requests whose tier rose after received", () => {
    const raised = (requestId: string, tiers: ReadonlyArray<["received" | "bead-implemented", "Small" | "Medium" | "Large"]>): TraceRecord =>
      turn({ workspaceId: "repo-a", agentId: "w1", role: "worker", requestId, reports: tiers.map(([phase, tier], i) => report({ requestId, phase, tier, at: hoursAgo(5 - i) })) });
    const records = [
      raised("req-20261009T100000Z", [["received", "Small"], ["bead-implemented", "Medium"]]),
      raised("req-20261009T110000Z", [["received", "Medium"], ["bead-implemented", "Large"]]),
      raised("req-20261009T120000Z", [["received", "Large"], ["bead-implemented", "Medium"]]),
    ];
    const requests = ["req-20261009T100000Z", "req-20261009T110000Z", "req-20261009T120000Z"].map((id) => request(id));
    expect(figureOf(figuresOf({ records, requests }), "tierRaised")).toMatchObject({ value: 2, crossed: true });
    expect(figureOf(figuresOf({ records: records.slice(0, 1), requests }), "tierRaised").crossed).toBe(false);
  });

  it("counts requests whose review budget is exhausted, their grants and exempt calls included", () => {
    const exhausted = [request("req-20261009T100000Z", { tier: "Small", reviewCalls: 2 }), request("req-20261009T110000Z", { tier: "Large", reviewCalls: 4 })];
    expect(figureOf(figuresOf({ requests: exhausted }), "reviewBudgetExhausted")).toMatchObject({ value: 2, crossed: true });
    const granted = [exhausted[0]!, { ...exhausted[1]!, reviewGranted: 1 }, request("req-20261009T120000Z", { tier: "Medium", reviewCalls: 3, reviewExempt: 2 })];
    expect(figureOf(figuresOf({ requests: granted }), "reviewBudgetExhausted").value).toBe(1);
  });

  it("counts open approvals: more than 8 open q:, o: and m: cards", () => {
    const R = "req-20261009T100000Z";
    const open = [
      ...Array.from({ length: 6 }, (_, i) => question(R, i + 1, null)),
      { id: "o:repo-a:1", requestId: R, subject: null, askedAt: hoursAgo(1), status: "open" as const },
      { id: "m:mis-0123456789:1", requestId: null, subject: null, askedAt: hoursAgo(1), status: "open" as const },
    ];
    expect(figureOf(figuresOf({ decisions: open }), "openApprovals")).toMatchObject({ value: 8, crossed: false });
    expect(figureOf(figuresOf({ decisions: [...open, question(R, 9, null)] }), "openApprovals")).toMatchObject({ value: 9, crossed: true });
    expect(figureOf(figuresOf({ decisions: [...open, question(R, 9, null, "answered")] }), "openApprovals").value).toBe(8);
  });
});

describe("drift", () => {
  it("counts the Mains' turns since a done criterion last changed state, else since the charter was confirmed", () => {
    const turns = (n: number, hours: number) => Array.from({ length: n }, () => hoursAgo(hours));
    expect(lastCriterionChangeOf(MISSION)).toBe(MISSION.charter.confirmedAt);
    expect(figureOf(figuresOf({ mainTurnEnds: [...turns(41, 10), ...turns(5, 45)] }), "mainTurnsSinceCriterion")).toMatchObject({ value: 41, threshold: 40, crossed: true });
    const met = mission({ doneCriteria: [{ id: "D1", text: "a card payment goes through", status: "met", at: hoursAgo(5), evidence: "test run" }] });
    expect(lastCriterionChangeOf(met)).toBe(hoursAgo(5));
    const open = [request("req-20261009T050000Z")];
    expect(figureOf(figuresOf({ mission: met, requests: open, mainTurnEnds: [...turns(41, 10), ...turns(3, 1)] }), "mainTurnsSinceCriterion")).toMatchObject({ value: 3, crossed: false });
  });

  it("counts no turns while every done criterion is settled and no request is open: the Main only answers the owner", () => {
    const turns = (n: number, hours: number) => Array.from({ length: n }, () => hoursAgo(hours));
    const settled = mission({
      doneCriteria: [
        { id: "D1", text: "a card payment goes through", status: "met", at: hoursAgo(5), evidence: "test run" },
        { id: "D2", text: "refunds", status: "dropped", at: hoursAgo(5), evidence: null },
      ],
    });
    const finished = [request("req-20261009T050000Z", { rosterState: "finished", finishedAt: hoursAgo(6) })];
    expect(figureOf(figuresOf({ mission: settled, requests: finished, mainTurnEnds: turns(50, 1) }), "mainTurnsSinceCriterion")).toMatchObject({ value: 0, crossed: false });
    // An open request, or no done criteria at all, and the turns count again.
    expect(figureOf(figuresOf({ mission: settled, requests: [request("req-20261009T050000Z")], mainTurnEnds: turns(50, 1) }), "mainTurnsSinceCriterion").crossed).toBe(true);
    expect(figureOf(figuresOf({ mission: mission({ doneCriteria: [] }), mainTurnEnds: turns(50, 1) }), "mainTurnsSinceCriterion").crossed).toBe(true);
  });

  it("counts requests finished since then", () => {
    const finished = Array.from({ length: 7 }, (_, i) => request(`req-20261009T0${i}0000Z`, { finishedAt: hoursAgo(2) }));
    expect(figureOf(figuresOf({ requests: finished }), "finishedSinceCriterion")).toMatchObject({ value: 7, crossed: true });
    expect(figureOf(figuresOf({ requests: finished.map((entry) => ({ ...entry, finishedAt: hoursAgo(41) })) }), "finishedSinceCriterion").value).toBe(0);
  });

  it("counts requests and links in repos outside the charter; none while it names no repo", () => {
    const outside = { requests: [request("req-20261009T100000Z", { workspaceId: "repo-c" })], links: [{ linkId: "peer-000000000001", toWorkspaceId: "repo-d" }] };
    expect(figureOf(figuresOf(outside), "outsideCharter")).toMatchObject({ value: 2, crossed: true, detail: "repo-c, repo-d" });
    expect(figureOf(figuresOf({ ...outside, mission: mission({ repos: [] }) }), "outsideCharter").value).toBe(0);
    expect(figureOf(figuresOf({ requests: [request("req-20261009T100000Z", { workspaceId: "repo-b" })] }), "outsideCharter").crossed).toBe(false);
  });
});

describe("stuck", () => {
  it("counts each stall, each unanswered link and each card older than 24 hours", () => {
    const R = "req-20261009T100000Z";
    const figures = figuresOf({
      alerts: [
        { kind: "request-stalled", subject: R },
        { kind: "peer-unanswered", subject: R },
      ],
      decisions: [question(R, 1, null, "open", hoursAgo(25)), question(R, 2, null, "open", hoursAgo(23)), question(R, 3, null, "answered", hoursAgo(30))],
    });
    expect(figureOf(figures, "stalled")).toMatchObject({ family: "stuck", value: 1, threshold: 1, crossed: true, detail: R });
    expect(figureOf(figures, "unansweredLinks")).toMatchObject({ value: 1, crossed: true });
    expect(figureOf(figures, "oldCards")).toMatchObject({ value: 1, crossed: true, detail: `q:${R}:1` });
  });
});

describe("budget", () => {
  it("reads each budget field as a percent used, crossing at 100%", () => {
    const budget = { requests: 2, workers: 4, reviewCalls: 10, days: 4 };
    const requests = [request("req-20261009T100000Z", { workerIds: ["w1", "w2"], reviewCalls: 3 }), request("req-20261009T110000Z", { workerIds: ["w2"], reviewCalls: 2 })];
    const figures = figuresOf({ mission: mission({ budget }), requests });
    expect(figureOf(figures, "requestsBudget")).toMatchObject({ value: 100, threshold: 100, crossed: true, detail: "2 of 2" });
    expect(figureOf(figures, "workersBudget")).toMatchObject({ value: 50, crossed: false });
    expect(figureOf(figures, "reviewCallsBudget")).toMatchObject({ value: 50, crossed: false });
    // 40 hours since the charter was confirmed, of 4 days.
    expect(figureOf(figures, "daysBudget")).toMatchObject({ value: 41, crossed: false });
  });
});

describe("liveWorkersOf", () => {
  it("keeps the mission's Workers that are not archived, closed or replaced, in their request's repo", () => {
    const requests = [request("req-20261009T100000Z", { workerIds: ["w1", "w2", "w3", "w4"] })];
    const agent = (id: string, over: Partial<{ status: string; archived: boolean; replacedBy: string | null }> = {}) => ({
      workspaceId: "repo-a",
      facts: { id, status: "idle", archived: false, replacedBy: null, ...over },
    });
    expect(liveWorkersOf([agent("w1"), agent("w2", { archived: true }), agent("w3", { status: "closed" }), agent("w4", { replacedBy: "w5" }), agent("other")], requests)).toEqual([
      { agentId: "w1", workspaceId: "repo-a" },
    ]);
  });
});

describe("readGovernorSnapshot: what the stores of a data folder give", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-governor-figures-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads the roster, the registry, the traces and the open alerts of the mission's requests only", async () => {
    const R = "req-20261009T100000Z";
    const created = createMissionStore(home, { newId: () => "mis-0123456789", env: {} }).create({ code: "PAY", name: "Payments", goal: "Ship", repos: ["repo-a"], createdBy: "owner", mainId: "main-1" });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    createMissionRoster(home, { env: {} }).add("mis-0123456789", { requestId: R, workspaceId: "repo-a", topic: "cards", workerId: "w1" });
    createRequestRegistry(home, { backfill: () => [] }).register("repo-a", R, { source: "tool", managerId: "main-1", workerId: "w1" });
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, wrote("w1", ["src/pay.ts"], 1));
    await appendRecord(location, wrote("w-other", ["src/pay.ts"], 1));
    const alerts = createAlertStore(home);
    alerts.raise({ workspaceId: "repo-a", kind: "request-stalled", subject: R, detail: "idle-unfinished" });
    alerts.raise({ workspaceId: "repo-a", kind: "request-stalled", subject: "req-20261009T110000Z", detail: "idle-unfinished" });

    const read = readGovernorSnapshot(home, created.mission, {
      now: new Date(NOW),
      agents: [{ workspaceId: "repo-a", facts: { id: "w1", status: "running", archived: false } }],
      settings: DEFAULT_COORDINATION_SETTINGS,
    });
    expect(read.requests).toEqual([request(R, { workerIds: ["w1"] })]);
    expect(read.liveWorkers).toEqual([{ agentId: "w1", workspaceId: "repo-a" }]);
    expect(read.records.map((record) => record.agentId)).toEqual(["w1"]);
    expect(read.alerts.map((alert) => alert.subject)).toEqual([R]);
    expect(read.reviewBudget).toEqual({ Small: 2, Medium: 2, Large: 4 });
    expect(figureOf(governorFiguresOf(read, SETTINGS), "stalled").crossed).toBe(true);
  });
});
