import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOVERNOR_FIGURES,
  countsForDrift,
  governorFiguresOf,
  lastCriterionChangeOf,
  liveWorkersOf,
  readGovernorSnapshot,
  unconvergedTimesOf,
  type GovernorFigure,
  type GovernorRequestFacts,
  type GovernorSnapshot,
} from "../plugin/server/governor-figures";
import { createAlertStore } from "../plugin/server/alert-store";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createOutbox } from "../plugin/server/outbox";
import { createMissionStore, type Mission } from "../plugin/server/mission-store";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { appendRecord } from "../plugin/server/trace-store";
import { DEFAULT_COORDINATION_SETTINGS, GOVERNOR_BOUNDS } from "../plugin/shared/coordination";
import { GOVERNOR_FIGURE_IDS, storedFigureIdOf } from "../plugin/shared/governor-figures";
import type { TraceRecord } from "../plugin/shared/contracts";
import type { Waiting } from "../plugin/shared/waits";
import { file, report, turn } from "./fixtures/orchestrator-traces";
import { fakeLineGit } from "./helpers/line-git";
import { clearLineCache, refreshLines, type PlacementFacts } from "../plugin/server/line-watch";

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
  return { requestId, workspaceId: "repo-a", rosterState: "active", workerIds: [], finishedAt: null, tier: null, reviewCalls: 0, reviewGranted: 0, reviewMilestones: 0, ...over };
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
    review: { callsPerBatch: 3 },
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
      // The line's figures (delivery line design §4.9).
      uncommittedHours: 4,
      unpushedHours: 24,
      ciRedMinutes: 30,
      behindCommits: 50,
      budgetPercent: 100,
      windowMinutes: 30,
      windowTurns: 5,
      // The command pools (delivery line design §8.1).
      quotaCodeNudge: 6,
      quotaReplan: 3,
      quotaArbitrate: 4,
      quotaOther: 4,
    });
    for (const [name, bounds] of Object.entries(GOVERNOR_BOUNDS)) expect(bounds.default, name).toBe(SETTINGS[name as keyof typeof SETTINGS]);
  });

  it("an empty mission crosses nothing, and has budget figures only for its budget's fields", () => {
    // With integration.ci off, the default (ADR-036, §17.1), there is no ciRed; on, every figure.
    const figures = figuresOf();
    expect(figures.map((entry) => entry.id)).toEqual(Object.keys(GOVERNOR_FIGURES).filter((id) => !id.endsWith("Budget") && id !== "ciRed"));
    expect(figures.filter((entry) => entry.crossed)).toEqual([]);
    const withCi = figuresOf({ ci: "on" });
    expect(withCi.map((entry) => entry.id)).toEqual(Object.keys(GOVERNOR_FIGURES).filter((id) => !id.endsWith("Budget")));
    expect(withCi.filter((entry) => entry.crossed)).toEqual([]);
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

  it("counts requests whose review cap is reached even for a new milestone batch, their grants included; no call is exempt (delivery line design §5.3, §5.6)", () => {
    const reached = [
      request("req-20261009T100000Z", { tier: "Small", reviewCalls: 3, reviewMilestones: 1 }),
      request("req-20261009T110000Z", { tier: "Large", reviewCalls: 12, reviewMilestones: 4 }),
    ];
    expect(figureOf(figuresOf({ requests: reached }), "reviewCapReached")).toMatchObject({ value: 2, threshold: SETTINGS.reviewExhausted, op: ">=", crossed: true });
    // A Large request of two batches at 6 calls may still open a third (a cap of 9): not reached.
    expect(figureOf(figuresOf({ requests: [request("req-20261009T110000Z", { tier: "Large", reviewCalls: 6, reviewMilestones: 2 })] }), "reviewCapReached").value).toBe(0);
    const granted = [
      reached[0]!,
      { ...reached[1]!, reviewGranted: 1 },
      // Medium at 6 of 6: reached; an untilClean grant no longer leaves calls out.
      request("req-20261009T120000Z", { tier: "Medium", reviewCalls: 6, reviewMilestones: 2 }),
    ];
    expect(figureOf(figuresOf({ requests: granted }), "reviewCapReached").value).toBe(2);
    // The cap follows the owner's review.callsPerBatch.
    expect(figureOf(figuresOf({ requests: reached, review: { callsPerBatch: 4 } }), "reviewCapReached").value).toBe(0);
  });

  it("counts the batches the convergence rule stopped in the last 24 h (delivery line design §5.2, §5.6)", () => {
    const requests = [
      request("req-20261009T100000Z", { unconvergedAt: [hoursAgo(1), hoursAgo(23)] }),
      request("req-20261009T110000Z", { unconvergedAt: [hoursAgo(25)] }),
      request("req-20261009T120000Z"),
    ];
    expect(figureOf(figuresOf({ requests }), "unconvergedBatches")).toMatchObject({ family: "overengineering", value: 2, threshold: SETTINGS.reviewExhausted, op: ">=", crossed: true });
    expect(figureOf(figuresOf({ requests: requests.slice(1) }), "unconvergedBatches")).toMatchObject({ value: 0, crossed: false });
  });

  it("a batch is unconverged when the rule refuses its next re-review for its counts: re-reviews spent, or blocking not falling", () => {
    const call = (n: number, kind: "create" | "rereview") => ({ callId: `c${n}`, kind, reviewerId: "rev-1", at: hoursAgo(10 - n) });
    const result = (n: number, verdict: string, blocking: number | null) => ({ at: hoursAgo(9.5 - n), recordId: `r${n}`, verdict, blocking });
    const batch = (batchId: string, results: ReturnType<typeof result>[]) => ({
      batchId,
      reviewerIds: ["rev-1"],
      brief: "",
      calls: results.map((_, n) => call(n, n === 0 ? "create" : "rereview")),
      results,
    });
    const reviews = {
      batches: [
        batch("b1", [result(0, "pass", 0)]),
        batch("b2", [result(0, "changes-required", 3), result(1, "changes-required", 3), result(2, "changes-required", 3)]),
        batch("b3", [result(0, "changes-required", 4), result(1, "changes-required", 3), result(2, "changes-required", 2), result(3, "changes-required", 1)]),
        batch("b4", [result(0, "changes-required", 2)]),
      ],
      grants: [],
    };
    expect(unconvergedTimesOf({ reviews }, [], 3)).toEqual([hoursAgo(7.5), hoursAgo(6.5)]);
    expect(unconvergedTimesOf({ reviews }, [], 4)).toEqual([hoursAgo(7.5)]);
    // A batch an older build opened has no results: its reviews are read from the trace by batch id.
    const older = { batches: [{ batchId: "b9", reviewerIds: ["rev-1"], brief: "", calls: [call(0, "create"), call(1, "rereview"), call(2, "rereview")] }], grants: [] };
    const traced = (n: number, blockingCount: number) => ({ agentId: "rev-1", at: hoursAgo(9.5 - n), batchId: "b9", verdict: "changes-required", blockingCount });
    expect(unconvergedTimesOf({ reviews: older }, [traced(0, 2), traced(1, 1), traced(2, 1)], 3)).toEqual([hoursAgo(7.5)]);
    expect(unconvergedTimesOf({ reviews: older }, [], 3)).toEqual([]);
  });

  it("reads a figure id an older build stored by its new name", () => {
    expect(storedFigureIdOf("reviewBudgetExhausted")).toBe("reviewCapReached");
    expect(storedFigureIdOf("tierRaised")).toBe("tierRaised");
    expect(storedFigureIdOf("toString")).toBe("toString");
    expect(GOVERNOR_FIGURE_IDS).not.toContain("reviewBudgetExhausted");
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
  it("counts the Mains' turns since a done criterion was last met, else since the charter was confirmed", () => {
    const turns = (n: number, hours: number) => Array.from({ length: n }, () => hoursAgo(hours));
    expect(lastCriterionChangeOf(MISSION)).toBe(MISSION.charter.confirmedAt);
    expect(figureOf(figuresOf({ mainTurnEnds: [...turns(41, 10), ...turns(5, 45)] }), "mainTurnsSinceCriterion")).toMatchObject({ value: 41, threshold: 40, crossed: true });
    const met = mission({ doneCriteria: [{ id: "D1", text: "a card payment goes through", status: "met", at: hoursAgo(5), evidence: "test run" }] });
    expect(lastCriterionChangeOf(met)).toBe(hoursAgo(5));
    const open = [request("req-20261009T050000Z")];
    expect(figureOf(figuresOf({ mission: met, requests: open, mainTurnEnds: [...turns(41, 10), ...turns(3, 1)] }), "mainTurnsSinceCriterion")).toMatchObject({ value: 3, crossed: false });
  });

  it("resets only on a criterion met with evidence (metAt); back to open, or a status sent again, moves nothing (delivery line design §8.4)", () => {
    const criterion = (over: Partial<Mission["charter"]["doneCriteria"][number]>) => ({ id: "D1", text: "a card payment goes through", status: "open" as const, at: null, evidence: null, ...over });
    // Met with evidence at 20 h, moved back to open at 2 h: the reset stays at 20 h.
    expect(lastCriterionChangeOf(mission({ doneCriteria: [criterion({ status: "open", at: hoursAgo(2), evidence: "test run", metAt: hoursAgo(20) })] }))).toBe(hoursAgo(20));
    // Met at 20 h, its status sent again at 1 h: `at` moved, `metAt` did not.
    expect(lastCriterionChangeOf(mission({ doneCriteria: [criterion({ status: "met", at: hoursAgo(1), evidence: "test run", metAt: hoursAgo(20) })] }))).toBe(hoursAgo(20));
    // An older entry has no metAt: its `at` while met, nothing once it is open again.
    expect(lastCriterionChangeOf(mission({ doneCriteria: [criterion({ status: "met", at: hoursAgo(5), evidence: "test run" })] }))).toBe(hoursAgo(5));
    expect(lastCriterionChangeOf(mission({ doneCriteria: [criterion({ status: "open", at: hoursAgo(2) })] }))).toBe(MISSION.charter.confirmedAt);
    // The newest met wins.
    expect(lastCriterionChangeOf(mission({ doneCriteria: [criterion({ metAt: hoursAgo(20) }), criterion({ id: "D2", status: "met", at: hoursAgo(3), evidence: "e", metAt: hoursAgo(3) })] }))).toBe(hoursAgo(3));
  });

  it("counts only the Main turns the owner or a report started: the plugin's wake-ups are no drift (delivery line design §8.4)", () => {
    const turns = (n: number, hours: number) => Array.from({ length: n }, () => hoursAgo(hours));
    // 300 turns, 30 of them owner- or report-started: under the threshold of 40.
    const all = turns(300, 10);
    expect(figureOf(figuresOf({ mainTurnEnds: all, driftTurnEnds: turns(30, 10) }), "mainTurnsSinceCriterion")).toMatchObject({ value: 30, crossed: false });
    expect(figureOf(figuresOf({ mainTurnEnds: all, driftTurnEnds: turns(41, 10) }), "mainTurnsSinceCriterion")).toMatchObject({ value: 41, crossed: true });
    // A snapshot without the split counts every turn, as before.
    expect(figureOf(figuresOf({ mainTurnEnds: all }), "mainTurnsSinceCriterion").value).toBe(300);
    // Records written before `trigger` count; owner and report count; plugin and agent do not.
    expect([undefined, null, "owner", "report", "plugin", "agent"].map((trigger) => countsForDrift({ trigger: trigger as TraceRecord["trigger"] }))).toEqual([true, false, true, true, false, false]);
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
    // Delivery line design §2.7: a chain counts once, finished at its head or not.
    const [a, b, c] = ["req-20261009T010000Z", "req-20261009T020000Z", "req-20261009T030000Z"];
    const chain = [request(a, { finishedAt: hoursAgo(3), continuedBy: b }), request(b, { finishedAt: hoursAgo(2), continuedBy: c }), request(c, { finishedAt: hoursAgo(1) })];
    expect(figureOf(figuresOf({ requests: chain }), "finishedSinceCriterion").value).toBe(1);
    expect(figureOf(figuresOf({ requests: [chain[0]!, request(b)] }), "finishedSinceCriterion").value).toBe(1);
  });

  it("counts requests and links in repos outside the charter; none while it names no repo", () => {
    const outside = { requests: [request("req-20261009T100000Z", { workspaceId: "repo-c" })], links: [{ linkId: "peer-000000000001", toWorkspaceId: "repo-d" }] };
    expect(figureOf(figuresOf(outside), "outsideCharter")).toMatchObject({ value: 2, crossed: true, detail: "repo-c, repo-d" });
    expect(figureOf(figuresOf({ ...outside, mission: mission({ repos: [] }) }), "outsideCharter").value).toBe(0);
    expect(figureOf(figuresOf({ requests: [request("req-20261009T100000Z", { workspaceId: "repo-b" })] }), "outsideCharter").crossed).toBe(false);
  });

  it("reads a request in a placement as its repo (delivery line design §3.1)", () => {
    const placed = { requests: [request("req-20261009T100000Z", { workspaceId: "wt-place-a" })], links: [{ linkId: "peer-000000000001", toWorkspaceId: "wt-place-c" }] };
    expect(figureOf(figuresOf(placed), "outsideCharter")).toMatchObject({ value: 2, detail: "wt-place-a, wt-place-c" });
    expect(figureOf(figuresOf({ ...placed, repoKeys: { "wt-place-a": "repo-a", "wt-place-c": "repo-c" } }), "outsideCharter")).toMatchObject({ value: 1, detail: "repo-c" });
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

  it("leaves out of stalled a request waiting on active work of the mission, and a stopped one (mission runtime design §6.3)", () => {
    const [A, B, C, D, E] = ["req-20261009T100000Z", "req-20261009T110000Z", "req-20261009T120000Z", "req-20261009T130000Z", "req-20261009T140000Z"];
    const stalled = [A, B, C, D, E].map((subject) => ({ kind: "request-stalled" as const, subject }));
    const requests = [
      // Waits on B's Worker, which still works: waiting, not stalled.
      request(A, { lastPhase: "blocked", waitingOn: "Main's signal that w-b finished G14", workerIds: ["w-a"] }),
      request(B, { lastPhase: "implementing", workerIds: ["w-b"] }),
      // Waits on D, which is finished: stalled.
      request(C, { lastPhase: "blocked", waitingOn: `the Worker of ${D}`, workerIds: ["w-c"] }),
      request(D, { rosterState: "finished", lastPhase: "finished", workerIds: ["w-d"] }),
      // Stopped by its report while the roster still says active: not stalled.
      request(E, { lastPhase: "stopped", workerIds: ["w-e"] }),
    ];
    expect(figureOf(figuresOf({ requests, alerts: stalled }), "stalled")).toMatchObject({ value: 3, detail: [B, C, D].join(", ") });
    // A wait on the owner names nothing: still stalled.
    expect(figureOf(figuresOf({ requests: [request(A, { lastPhase: "blocked", waitingOn: null })], alerts: [stalled[0]!] }), "stalled").value).toBe(1);
  });

  it("reads a structured wait first: out of stalled while every unsettled item is live (delivery line design §6.5)", () => {
    const [A, B, C] = ["req-20261009T100000Z", "req-20261009T110000Z", "req-20261009T120000Z"];
    const waiting = (items: Array<Pick<Waiting["items"][number], "kind" | "id">>): Waiting => ({
      since: hoursAgo(1),
      reportRecordId: "out-000000000001",
      wakeOn: "all",
      items: items.map((item) => ({ ...item, settled: false })),
    });
    const alerts = [{ kind: "request-stalled" as const, subject: A }];
    const stalledWith = (a: Partial<GovernorRequestFacts>, over: Partial<GovernorSnapshot> = {}) =>
      figureOf(
        figuresOf({
          requests: [request(A, { lastPhase: "blocked", workerIds: ["w-a"], ...a }), request(B, { lastPhase: "implementing", workerIds: ["w-b"] }), request(C, { rosterState: "finished", lastPhase: "finished", workerIds: ["w-c"] })],
          liveWorkers: [{ agentId: "w-b", workspaceId: "repo-a" }],
          alerts,
          ...over,
        }),
        "stalled",
      ).value;

    // An active request with a live Worker, an open question, a live link, a batch whose Reviewer runs: waiting.
    expect(stalledWith({ waiting: waiting([{ kind: "request", id: B }]) })).toBe(0);
    expect(stalledWith({ waiting: waiting([{ kind: "question", id: `q:${A}:1` }]) }, { decisions: [question(A, 1, null)] })).toBe(0);
    expect(stalledWith({ waiting: waiting([{ kind: "link", id: "peer-000000000001" }]) }, { links: [{ linkId: "peer-000000000001", toWorkspaceId: "repo-b" }] })).toBe(0);
    const reviewBatches = [{ batchId: "b1", reviewerIds: ["rev-1"], calls: [{ at: hoursAgo(2), reviewerId: "rev-1" }] }];
    expect(stalledWith({ waiting: waiting([{ kind: "batch", id: "b1" }]), reviewBatches }, { runningAgents: ["rev-1"] })).toBe(0);
    // A continued request is read at the head of its chain.
    expect(stalledWith({ waiting: waiting([{ kind: "request", id: C }]) }, { requests: [request(A, { lastPhase: "blocked", workerIds: ["w-a"], waiting: waiting([{ kind: "request", id: C }]) }), request(C, { finishedAt: hoursAgo(3), continuedBy: B }), request(B, { workerIds: ["w-b"] })] })).toBe(0);

    // Delivery line design §2.7: a continued request is never stalled; its continuation carries the work.
    expect(stalledWith({ lastPhase: "implementing", continuedBy: B })).toBe(0);

    // A dead item, or one the snapshot does not know: stalled.
    expect(stalledWith({ waiting: waiting([{ kind: "request", id: C }]) })).toBe(1);
    expect(stalledWith({ waiting: waiting([{ kind: "question", id: `q:${A}:1` }]) }, { decisions: [question(A, 1, null, "answered")] })).toBe(1);
    expect(stalledWith({ waiting: waiting([{ kind: "batch", id: "b1" }]), reviewBatches })).toBe(1);
    expect(stalledWith({ waiting: waiting([{ kind: "link", id: "peer-000000000001" }]) })).toBe(1);
    expect(stalledWith({ waiting: waiting([{ kind: "request", id: "req-20261009T000000Z" }]) })).toBe(1);
    // The structure is read before the text: the regex would have counted B as active work.
    expect(stalledWith({ waitingOn: `the Worker of ${B}`, waiting: waiting([{ kind: "request", id: C }]) })).toBe(1);
    // An older report, with no items, is read by the regex.
    expect(stalledWith({ waitingOn: `the Worker of ${B}` })).toBe(0);
    expect(stalledWith({ waitingOn: `the Worker of ${B}`, waiting: waiting([]) })).toBe(0);
    expect(stalledWith({ waitingOn: `the Worker of ${C}` })).toBe(1);
  });
});

describe("the line (delivery line design §4.9)", () => {
  const line = (over: Partial<PlacementFacts> = {}): PlacementFacts => ({
    repo: "repo-a",
    name: null,
    workspaceId: "wt-a",
    branch: "m/PAY/repo-a",
    target: "develop",
    state: "ready",
    dirty: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: null,
    pushed: null,
    mr: null,
    ci: null,
    grant: null,
    readAt: NOW,
    firstAheadAt: null,
    ciSince: null,
    ...over,
  });
  const R = "req-20261009T100000Z";

  it("uncommittedHours: a dirty worktree with no live Worker, from its last finished request", () => {
    const finished = [request(R, { workspaceId: "wt-a", rosterState: "finished", finishedAt: hoursAgo(5), workerIds: ["w1"] }), request("req-20261009T090000Z", { workspaceId: "wt-a", rosterState: "finished", finishedAt: hoursAgo(9) })];
    const dirty = { requests: finished, placements: [line({ dirty: true })] };
    expect(figureOf(figuresOf(dirty), "uncommittedHours")).toMatchObject({ family: "mess", value: 5, threshold: 4, op: ">=", crossed: true, detail: "repo-a" });
    // A live Worker in it, a clean tree, or no finished request yet: nothing.
    expect(figureOf(figuresOf({ ...dirty, liveWorkers: [{ agentId: "w1", workspaceId: "wt-a" }] }), "uncommittedHours")).toMatchObject({ value: 0, crossed: false });
    expect(figureOf(figuresOf({ ...dirty, placements: [line({ dirty: false })] }), "uncommittedHours").crossed).toBe(false);
    expect(figureOf(figuresOf({ requests: [request(R, { workspaceId: "wt-a" })], placements: [line({ dirty: true })] }), "uncommittedHours").crossed).toBe(false);
    expect(figureOf(figuresOf({ requests: [request(R, { workspaceId: "wt-a", finishedAt: hoursAgo(3) })], placements: [line({ dirty: true })] }), "uncommittedHours")).toMatchObject({ value: 3, crossed: false });
  });

  it("unpushedNoMr: ahead with no merge request, from the oldest commit it is ahead with", () => {
    const ahead = line({ ahead: 3, firstAheadAt: hoursAgo(30) });
    expect(figureOf(figuresOf({ placements: [ahead] }), "unpushedNoMr")).toMatchObject({ family: "stuck", value: 30, threshold: 24, crossed: true, detail: "repo-a" });
    expect(figureOf(figuresOf({ placements: [{ ...ahead, firstAheadAt: hoursAgo(2) }] }), "unpushedNoMr")).toMatchObject({ value: 2, crossed: false });
    expect(figureOf(figuresOf({ placements: [{ ...ahead, mr: { url: "https://gitlab.example/mr/1", state: null, mergeable: null } }] }), "unpushedNoMr").crossed).toBe(false);
    expect(figureOf(figuresOf({ placements: [{ ...ahead, ahead: 0 }] }), "unpushedNoMr").crossed).toBe(false);
  });

  it("ciRed (integration.ci on): CI red for 30 minutes; mrConflicting: a merge request not mergeable", () => {
    const mr = { url: "https://github.example/pr/1", state: "open", mergeable: false };
    const red = line({ ahead: 1, mr, ci: "failure", ciSince: hoursAgo(1) });
    const figures = figuresOf({ ci: "on", placements: [red, line({ repo: "repo-b", workspaceId: "wt-b", ci: "failure", ciSince: hoursAgo(0.25) })] });
    expect(figureOf(figures, "ciRed")).toMatchObject({ family: "stuck", value: 60, threshold: 30, crossed: true, detail: "repo-a" });
    expect(figureOf(figures, "mrConflicting")).toMatchObject({ family: "stuck", value: 1, threshold: 1, crossed: true, detail: "repo-a" });
    expect(figureOf(figuresOf({ ci: "on", placements: [{ ...red, ci: "success", ciSince: null, mr: { ...mr, mergeable: true } }] }), "ciRed").crossed).toBe(false);
    expect(figureOf(figuresOf({ ci: "on", placements: [{ ...red, mr: { ...mr, mergeable: null } }] }), "mrConflicting").crossed).toBe(false);
  });

  it("integration.ci off (the default, ADR-036 §17.1): no ciRed is computed, even on a line red for hours", () => {
    const red = line({ ahead: 1, ci: "failure", ciSince: hoursAgo(5) });
    for (const ci of ["off", undefined] as const) {
      const figures = figuresOf({ ...(ci === undefined ? {} : { ci }), placements: [red] });
      expect(figures.map((entry) => entry.id)).not.toContain("ciRed");
      expect(figures.filter((entry) => entry.crossed).map((entry) => entry.id)).toEqual([]);
    }
  });

  it("behindIntegration: the most commits a branch is behind; an archived placement counts for nothing", () => {
    const figures = figuresOf({ placements: [line({ behind: 12 }), line({ repo: "repo-b", workspaceId: "wt-b", behind: 61 })] });
    expect(figureOf(figures, "behindIntegration")).toMatchObject({ family: "drift", value: 61, threshold: 50, crossed: true, detail: "repo-b" });
    const archived = figuresOf({ placements: [line({ state: "archived", behind: 80, dirty: true, ci: "failure", ciSince: hoursAgo(2) })] });
    expect(archived.filter((entry) => entry.crossed)).toEqual([]);
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
    // Its newest report, read for the stalled exclusions (mission runtime design §6.3).
    createOutbox(home).add("repo-a", { kind: "report", requestId: R, from: "w1", to: "main-1", text: `BM-REPORT\nrequestId: ${R}\nphase: blocked\nblockers: waiting for: req-20261009T110000Z to finish` });
    const alerts = createAlertStore(home);
    alerts.raise({ workspaceId: "repo-a", kind: "request-stalled", subject: R, detail: "idle-unfinished" });
    alerts.raise({ workspaceId: "repo-a", kind: "request-stalled", subject: "req-20261009T110000Z", detail: "idle-unfinished" });

    const read = readGovernorSnapshot(home, created.mission, {
      now: new Date(NOW),
      agents: [{ workspaceId: "repo-a", facts: { id: "w1", status: "running", archived: false } }],
      settings: DEFAULT_COORDINATION_SETTINGS,
    });
    expect(read.requests).toEqual([request(R, { workerIds: ["w1"], lastPhase: "blocked", waitingOn: "req-20261009T110000Z to finish", unconvergedAt: [] })]);
    expect(read.liveWorkers).toEqual([{ agentId: "w1", workspaceId: "repo-a" }]);
    expect(read.records.map((record) => record.agentId)).toEqual(["w1"]);
    expect(read.alerts.map((alert) => alert.subject)).toEqual([R]);
    expect(read.review).toMatchObject({ callsPerBatch: 3 });
    expect(figureOf(governorFiguresOf(read, SETTINGS), "stalled").crossed).toBe(true);
  });

  it("reads each request's structured wait, its batches and chain, and the running agents (delivery line design §6.5)", () => {
    const R = "req-20261009T100000Z";
    const NEXT = "req-20261009T110000Z";
    const created = createMissionStore(home, { newId: () => "mis-0123456789", env: {} }).create({ code: "PAY", name: "Payments", goal: "Ship", repos: ["repo-a"], createdBy: "owner", mainId: "main-1" });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    createMissionRoster(home, { env: {} }).add("mis-0123456789", { requestId: R, workspaceId: "repo-a", topic: "cards", workerId: "w1" });
    const registry = createRequestRegistry(home, { backfill: () => [] });
    registry.register("repo-a", R, { source: "tool", managerId: "main-1", workerId: "w1" });
    const waiting: Waiting = { since: hoursAgo(1), reportRecordId: "out-000000000001", wakeOn: "all", items: [{ kind: "request", id: NEXT, settled: false }] };
    registry.setWaiting("repo-a", R, waiting);

    const read = readGovernorSnapshot(home, created.mission, {
      now: new Date(NOW),
      agents: [
        { workspaceId: "repo-a", facts: { id: "w1", status: "idle", archived: false } },
        { workspaceId: "repo-a", facts: { id: "rev-1", status: "running", archived: false } },
      ],
      settings: DEFAULT_COORDINATION_SETTINGS,
    });
    expect(read.requests[0]).toMatchObject({ requestId: R, waiting, reviewBatches: [] });
    expect(read.requests[0]!.continuedBy).toBeUndefined();
    expect(read.runningAgents).toEqual(["rev-1"]);
  });

  it("reads each repo's line as the 60-second pass last read it, and the newest report's git fields; no git of its own (delivery line design §4.9)", async () => {
    clearLineCache();
    const R = "req-20261009T100000Z";
    const created = createMissionStore(home, { newId: () => "mis-0123456789", env: {} }).create({ code: "PAY", name: "Payments", goal: "Ship", repos: ["repo-a"], createdBy: "owner", mainId: "main-1" });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    const placement = { repo: "repo-a", workspaceId: "wt-a", directory: "/w/pay", branch: "m/PAY/repo-a", target: "develop", base: "origin/develop", worktreeSlug: "m-pay-repo-a", state: "ready" as const, requestKey: "bm-place-1", createdAt: hoursAgo(40), deps: { cloned: [], at: null, note: null }, integration: null };
    const updated = createMissionStore(home, { env: {} }).update("mis-0123456789", (mission) => ({ ...mission, placements: [placement] }));
    if (!updated.ok) throw new Error(updated.reasons.join("; "));
    createMissionRoster(home, { env: {} }).add("mis-0123456789", { requestId: R, workspaceId: "wt-a", topic: "cards", workerId: "w1" });
    createOutbox(home, { now: () => new Date(hoursAgo(2)) }).add("wt-a", { kind: "report", requestId: R, from: "w1", to: "main-1", text: `BM-REPORT\nrequestId: ${R}\nphase: finished\nbranch: m/PAY/repo-a\ncommit: abcdef1\npushed: yes\nmr: https://gitlab.example/mr/7\nci: failure` });
    const { git, calls } = fakeLineGit({ "/w/pay": { counts: "55\t2", status: " M a.ts", lastCommitAt: hoursAgo(3), head: "abcdef1234567", branch: "m/PAY/repo-a", aheadOfOrigin: "0", aheadLog: `${hoursAgo(3)}\n${hoursAgo(6)}` } });
    await refreshLines(home, { now: () => new Date(NOW), git });
    const seen = calls.length;
    const withCi = { ...DEFAULT_COORDINATION_SETTINGS, integration: { ci: "on" as const } };
    const read = readGovernorSnapshot(home, updated.mission, { now: new Date(NOW), agents: [], settings: withCi });
    expect(calls.length).toBe(seen);
    expect(read.ci).toBe("on");
    expect(read.placements).toEqual([
      expect.objectContaining({ repo: "repo-a", workspaceId: "wt-a", dirty: true, ahead: 2, behind: 55, pushed: true, mr: { url: "https://gitlab.example/mr/7", state: null, mergeable: null }, ci: "failure", ciSince: hoursAgo(2), firstAheadAt: hoursAgo(6), readAt: NOW }),
    ]);
    const figures = governorFiguresOf(read, SETTINGS);
    expect(figureOf(figures, "ciRed")).toMatchObject({ value: 120, crossed: true });
    expect(figureOf(figures, "behindIntegration")).toMatchObject({ value: 55, crossed: true });
    // ADR-036 (§17.1): with integration.ci off, the default, the report's ci is not read and no ciRed is computed.
    const off = readGovernorSnapshot(home, updated.mission, { now: new Date(NOW), agents: [], settings: DEFAULT_COORDINATION_SETTINGS });
    expect(off.ci).toBe("off");
    expect(off.placements).toEqual([expect.objectContaining({ repo: "repo-a", mr: { url: "https://gitlab.example/mr/7", state: null, mergeable: null }, ci: null, ciSince: null })]);
    const offFigures = governorFiguresOf(off, SETTINGS);
    expect(offFigures.map((entry) => entry.id)).not.toContain("ciRed");
    expect(figureOf(offFigures, "behindIntegration")).toMatchObject({ value: 55, crossed: true });
    clearLineCache();
  });

  it("splits the Mains' turns by what started them: drift reads those of the owner, a report, or a record without trigger (delivery line design §8.4)", async () => {
    const created = createMissionStore(home, { newId: () => "mis-0123456789", env: {} }).create({ code: "PAY", name: "Payments", goal: "Ship", repos: ["repo-a"], createdBy: "owner", mainId: "main-1" });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    const location = { tracesDir: join(home, "traces") };
    const triggers = ["owner", "report", "plugin", "agent", null, undefined] as const;
    for (const [i, trigger] of triggers.entries()) {
      const ended = hoursAgo(10 - i);
      await appendRecord(location, turn({ workspaceId: "wks-mission", agentId: "main-1", turnId: `m-${i}`, at: ended, startedAt: ended, endedAt: ended, ...(trigger === undefined ? {} : { trigger }) }));
    }
    const read = readGovernorSnapshot(home, { ...created.mission, workspaceId: "wks-mission" }, { now: new Date(NOW), agents: [], settings: DEFAULT_COORDINATION_SETTINGS });
    expect(read.mainTurnEnds).toHaveLength(6);
    expect(read.driftTurnEnds).toEqual([hoursAgo(10), hoursAgo(9), hoursAgo(5)]);
  });
});
