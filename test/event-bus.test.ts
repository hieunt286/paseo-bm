import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import {
  EVENTS_BATCH,
  WAKE_ACT_TOOLS,
  actsNoted,
  compactCrossedEventOf,
  createEventBus,
  decisionOpenedEventsOf,
  eventKeyOf,
  eventLineOf,
  eventScopeOf,
  eventsMessageOf,
  finishedRequestKeysOf,
  handoffCrossedEventOf,
  isInEventScope,
  isWakeAct,
  missionReviewEventsOf,
  missionSignalEventsOf,
  missionsOfEvent,
  outsideCharterOf,
  requestFinishedEventsOf,
  reviewMarksOf,
  wakesGovernor,
  workLeftOf,
  type BmEvent,
  type EventBus,
  type WorkerSignalEvent,
} from "../plugin/server/event-bus";
import type { GovernorFigure } from "../plugin/server/governor-figures";
import type { GovernorOutcome } from "../plugin/server/governor-store";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { missionCardOf } from "../plugin/server/mission-tools";
import { WORKER_SIGNALS } from "../plugin/shared/orchestrator";
import { createAdviceStore } from "../plugin/server/advice-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { EVENTS_NOTICE_MARKER, isPluginNotice, noticeMarkerOf } from "../plugin/server/notices";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { unverifiedFinishesOf } from "../plugin/server/request-trace";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { alertKeyOf } from "../plugin/shared/alerts";
import { EMPTY_AUTONOMY_POLICY, projectsAboveOwner, type AutonomyPolicy } from "../plugin/shared/autonomy";
import type { Decision, DecisionClass } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";
import { MANAGER, WORKER, at, report, turn } from "./fixtures/orchestrator-traces";
import type { Evidence } from "../plugin/shared/contracts";

/**
 * The event bus to the Orchestrator (autonomy design §A.8, REQ-115 b;
 * missions design §9.7, §9.1): typed events with dedupe keys and lines; only
 * the governor's `mission.*` events and a `danger` signal wake the
 * Orchestrator, every other event is retired as a wake while its builder and
 * the advice count stay; at most one wake per mission per 15 minutes, danger
 * excepted; every event pending at the Orchestrator's idle moment delivered
 * as ONE `BM-EVENTS` message through the notice queue's batch kind; an event
 * dropped when its subject settled before delivery; each wake recorded with
 * its event types and whether its turn acted (M-26). A fake Paseo SDK, a
 * private notice queue and a temporary data folder — never the real HOME or a
 * daemon.
 */

const WS = "wks_1";
const OTHER_WS = "wks_2";
const ORCHESTRATOR = "agent-orchestrator";
const REQUEST = "req-20260929T073348Z";

let root: string;
let home: string;
let clock: Date;
let queue: NoticeQueue;

/** The current Orchestrator and one Manager; `onSend` sees each message as it goes out. */
function daemon(withOrchestrator = true, onSend: (text: string) => void = () => {}) {
  return fakePaseo({
    agents: [
      { id: MANAGER, provider: "bm-manager", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" }, createdAt: clock.toISOString() },
      ...(withOrchestrator
        ? [
            {
              id: ORCHESTRATOR,
              provider: "bm-orchestrator/claude-opus-5-5",
              status: "idle",
              workspaceId: "wks-own",
              labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
              createdAt: clock.toISOString(),
            },
          ]
        : []),
    ],
    onSend: ({ text }) => onSend(text),
  });
}

function bus(): EventBus {
  return createEventBus({ home: () => home, queue, now: () => clock, log: () => {} });
}

/** Puts a project in the events' scope: one class above `owner` in the policy. */
const inScope = (workspaceId = WS, mode: "shadow" | "delegate" = "shadow") =>
  createAutonomyStore(home).set({ workspaceId, class: "scope", mode, confirmed: true }, clock.toISOString());
/**
 * The owner delegates a class of the project to the Orchestrator (design §B.5):
 * its questions ask the Orchestrator to decide, and the project is in the scope.
 * `question(n)` is `reversible-technical`.
 */
const delegateToOrchestrator = (workspaceId = WS, decisionClass: DecisionClass = "reversible-technical") =>
  createAutonomyStore(home).set({ workspaceId, class: decisionClass, mode: "delegate", confirmed: true }, clock.toISOString());
const decisions = () => createDecisionStore(home, { log: () => {} });
const alerts = () => createAlertStore(home, { now: () => clock });
const orchestratorIdle = async (fake: ReturnType<typeof daemon>) => {
  fake.byId(ORCHESTRATOR)!.status = "idle";
  await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, fake.paseo);
};
/** A Worker question the Orchestrator could settle: no option needs the owner's confirmation. */
const LOCAL_OPTIONS: Decision["options"] = [
  { key: "a", label: "Commit on the branch", recommended: true, effects: ["commit"] },
  { key: "b", label: "Hold", recommended: false, effects: ["none"] },
];
const question = (n: number, over: Partial<Decision> = {}) =>
  makeDecision({ id: `q:${REQUEST}:Q${n}`, workspaceId: WS, requestId: REQUEST, options: LOCAL_OPTIONS, ...over });
const wakes = () => createOrchestratorStore(home, { now: () => clock }).readWakes();

/** A danger signal of Worker `n` of a project, its alert raised: it wakes the Orchestrator (missions design §9.7). */
function danger(n: number, workspaceId = WS): WorkerSignalEvent & { alertKey: string } {
  const workerId = `${WORKER}-${n}`;
  const raised = alerts().raise({ workspaceId, kind: "danger", subject: workerId });
  return { type: "worker.signal", workspaceId, workerId, requestKey: REQUEST, signal: "danger", turnStart: "T0", alertKey: raised.alert.key, since: raised.alert.since, interruptUntil: null };
}

const MISSION = "mis-0123456789";
const OTHER_MISSION = "mis-abcdef0123";
/** An open mission with its Main, in the data folder. */
function openMission(missionId = MISSION, repos = [WS], code = "PAY"): void {
  const created = createMissionStore(home, { newId: () => missionId, env: {} }).create({ code, name: code, goal: "Ship it", repos, createdBy: "owner", mainId: "main-1" });
  if (!created.ok) throw new Error(created.reasons.join("; "));
}
const STALLED: GovernorFigure = { family: "stuck", id: "stalled", value: 1, threshold: 1, op: ">=", crossed: true, detail: REQUEST };
/** A recomputation whose `stuck` family came due for step 3. */
const replanDue = (missionId = MISSION): GovernorOutcome => ({ missionId, figures: [STALLED], actions: [{ family: "stuck", action: "replan-due", commandId: null, reason: null }] });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-event-bus-"));
  home = join(root, "data");
  clock = new Date("2026-09-29T08:00:00.000Z");
  queue = createNoticeQueue({ log: () => {} });
  clearDecisionStoreCache();
});

afterEach(() => {
  queue.clear();
  vi.restoreAllMocks();
  clearDecisionStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("events: types, keys, lines (design §A.8)", () => {
  const stalled: BmEvent = {
    type: "request.stalled",
    workspaceId: WS,
    requestKey: REQUEST,
    managerId: MANAGER,
    reason: "idle-unfinished",
    alertKey: alertKeyOf("request-stalled", WS, REQUEST),
    since: "2026-09-29T08:00:00.000Z",
  };

  it("has the four types of the design, one dedupe key each", () => {
    expect(eventKeyOf({ type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: WORKER, asks: "decision" })).toBe(
      `decision.opened:q:${REQUEST}:Q1`,
    );
    expect(eventKeyOf({ type: "request.finished", workspaceId: WS, requestId: REQUEST, managerId: MANAGER, at: "T1" })).toBe(`request.finished:${WS}:${REQUEST}@T1`);
    expect(eventKeyOf(stalled)).toBe(`request.stalled:${WS}:${REQUEST}@2026-09-29T08:00:00.000Z`);
    const signal: BmEvent = { type: "worker.signal", workspaceId: WS, workerId: WORKER, requestKey: REQUEST, signal: "failing", turnStart: "T0", alertKey: null, since: "T5" };
    expect(eventKeyOf(signal)).toBe(`worker.signal:${WS}:${WORKER}:failing@T0`);
    expect(eventKeyOf({ ...signal, signal: "danger", alertKey: "danger:x", since: "T6" })).toBe(`worker.signal:${WS}:${WORKER}:danger@T6`);
  });

  it("writes one short line per event with the ids to look up, and one BM-EVENTS message for them", () => {
    expect(eventLineOf(stalled)).toBe(
      `- request.stalled idle-unfinished — project ${WS}, request ${REQUEST}, Manager ${MANAGER}, since 2026-09-29T08:00:00.000Z. Look with bm_request.`,
    );
    const message = eventsMessageOf([eventLineOf(stalled), "- x"]);
    expect(message.split("\n")[0]).toBe(EVENTS_NOTICE_MARKER);
    expect(message.split("\n")).toHaveLength(4);
    expect(message).toContain("2 events");
    expect(EVENTS_BATCH.compose(["- x"])).toContain("1 event,");
    // A plugin notice: never the owner's words, nor the owner's approval.
    expect(isPluginNotice(message)).toBe(true);
    expect(noticeMarkerOf(message)).toBe("BM-EVENTS");
  });

  it("takes decision.opened from new decisions the policy asks the Orchestrator about, and request.finished from a Manager's finished reports", () => {
    const delegated: AutonomyPolicy = {
      projects: {
        [WS]: {
          "reversible-technical": { mode: "delegate", at: "T" },
          environment: { mode: "delegate", at: "T" },
        },
      },
      challenger: {},
    };
    // An open Worker question and a fallback incident of a class delegated to the Orchestrator; a settled one and its own decision never.
    const incident = makeDecision({ id: "f:fb-1", workspaceId: WS, requestId: null, askedBy: { role: "plugin", agentId: null }, options: LOCAL_OPTIONS });
    expect(decisionOpenedEventsOf([question(1), question(2, { status: "answered" }), makeDecision({ id: "o:1", options: LOCAL_OPTIONS }), incident], delegated)).toEqual([
      { type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: "agent-worker", asks: "decision" },
      { type: "decision.opened", workspaceId: WS, requestId: null, decisionId: "f:fb-1", askedBy: null, asks: "decision" },
    ]);
    // Nothing delegated and no challenger (a new install): no decision wakes the Orchestrator.
    expect(decisionOpenedEventsOf([question(1), incident])).toEqual([]);
    const record = turn({
      workspaceId: WS,
      requestId: REQUEST,
      reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] }), report({ at: at(6), requestId: null, phase: "blocked" })],
    });
    expect(requestFinishedEventsOf(record)).toEqual([{ type: "request.finished", workspaceId: WS, requestId: REQUEST, managerId: MANAGER, at: at(5) }]);
    // A Worker's own record raises it too (design §7.17.8 i), told to its Manager; a Reviewer's never.
    expect(requestFinishedEventsOf({ ...record, agentId: WORKER, role: "worker", parentAgentId: MANAGER })).toEqual([
      { type: "request.finished", workspaceId: WS, requestId: REQUEST, managerId: MANAGER, at: at(5) },
    ]);
    expect(requestFinishedEventsOf({ ...record, role: "reviewer" })).toEqual([]);
    expect(requestFinishedEventsOf(undefined)).toEqual([]);
  });

  it("wakes only for a judgement: release, data, security and cost wait for the owner (X-4), even with every other class delegated to the Orchestrator", () => {
    const delegated: AutonomyPolicy = {
      projects: { [WS]: Object.fromEntries(
          (["reversible-technical", "scope", "preference", "environment", "dependency"] as const).map((c) => [c, { mode: "delegate" as const, at: "T" }]),
        ) },
      challenger: { [WS]: true },
    };
    // The default fixture asks about push and publish: the owner's alone.
    expect(decisionOpenedEventsOf([makeDecision({ id: `q:${REQUEST}:Q9`, workspaceId: WS, requestId: REQUEST })], delegated)).toEqual([]);
    const oneRelease = question(3, { options: [...LOCAL_OPTIONS, { key: "c", label: "Deploy", recommended: false, effects: ["deploy"] }] });
    expect(decisionOpenedEventsOf([oneRelease], delegated)).toEqual([]);
    expect(decisionOpenedEventsOf([question(4)], delegated).map((event) => event.decisionId)).toEqual([`q:${REQUEST}:Q4`]);
  });

  it("wakes on a finished request only when its report shows work left", () => {
    const finished = (over: Parameters<typeof report>[0] = {}) => report({ at: at(5), requestId: REQUEST, phase: "finished", ...over });
    // A clean finish, however it is written: nothing to judge.
    for (const clean of [
      finished(),
      finished({ reviewFindingsOpen: "none", blockers: "None.", buildAndTests: "npm test passed, lint clean" }),
      finished({ reviewFindingsOpen: "0", blockers: "-" }),
      // Written by real Workers in the S1/S7 live check (2026-09-29).
      finished({ blockers: "none. Suggestion (not done): add a test for the default", buildAndTests: "npm test (node --test): 1 pass, 0 fail" }),
      finished({ buildAndTests: "npm test: 2 tests, 2 pass, 0 fail, exit 0. Committed; git push origin main, exit 0" }),
      finished({ buildAndTests: "tests passed, failures: 0, no errors" }),
    ]) {
      expect(workLeftOf(clean)).toBe(false);
      expect(requestFinishedEventsOf(turn({ workspaceId: WS, requestId: REQUEST, reports: [clean] }))).toEqual([]);
    }
    expect(workLeftOf(finished({ beadsReady: ["bd-2"] }))).toBe(true);
    expect(workLeftOf(finished({ reviewFindingsOpen: "2 minor" }))).toBe(true);
    expect(workLeftOf(finished({ blockers: "needs the staging key" }))).toBe(true);
    expect(workLeftOf(finished({ buildAndTests: "2 tests failed" }))).toBe(true);
    expect(workLeftOf(finished({ buildAndTests: "npm test: 3 pass, 1 fail" }))).toBe(true);
    expect(workLeftOf(finished({ blockers: "nobody answered the key question" }))).toBe(true);
  });
});

describe("the governor's wakes (missions design §9.7, §9.1)", () => {
  it("only the governor's events and a danger signal wake the Orchestrator; every other event is retired as a wake", async () => {
    inScope();
    delegateToOrchestrator();
    createAutonomyStore(home).setChallenger({ workspaceId: WS, enabled: true });
    const fake = daemon();
    const events = bus();
    const stall = alerts().raise({ workspaceId: WS, kind: "request-stalled", subject: REQUEST });
    const retired: BmEvent[] = [
      { type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: WORKER, asks: "decision" },
      { type: "request.finished", workspaceId: WS, requestId: REQUEST, managerId: MANAGER, at: at(5), unverified: true },
      { type: "request.stalled", workspaceId: WS, requestKey: REQUEST, managerId: MANAGER, reason: "idle-unfinished", alertKey: stall.alert.key, since: stall.alert.since },
      { type: "advice.due", workspaceId: WS, finished: 5, at: at(5) },
      { type: "threshold.crossed", workspaceId: WS, requestId: REQUEST, agentId: WORKER, role: "worker", kind: "compact", figure: "tokensPerTurn", value: 6, threshold: 5, at: at(5), cycle: 0 },
      {
        type: "writers.observed",
        workspaceId: WS,
        file: "src/a.js",
        writers: [
          { agentId: WORKER, role: "worker", requestId: REQUEST, startedAt: at(0) },
          { agentId: "agent-worker-2", role: "worker", requestId: null, startedAt: at(1) },
        ],
        alertKey: alertKeyOf("writers-observed", WS, "src/a.js"),
        at: at(2),
      },
      ...WORKER_SIGNALS.filter((signal) => signal !== "danger").map(
        (signal): BmEvent => ({ type: "worker.signal", workspaceId: WS, workerId: WORKER, requestKey: REQUEST, signal, turnStart: "T0", alertKey: null, since: "T1" }),
      ),
    ];
    expect(retired.filter(wakesGovernor)).toEqual([]);
    expect(await events.publish(retired, fake.paseo)).toEqual({ status: "none", published: [], skipped: retired.map(eventKeyOf) });
    // A recorded turn with a delegated question and work left, and a fallback incident: nothing either.
    decisions().open(question(1));
    const record = turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] });
    expect(await events.turnRecorded(record, [question(1)], fake.paseo, () => true)).toMatchObject({ status: "none", published: [] });
    const incident = makeDecision({ id: "f:fb-1", workspaceId: WS, requestId: null, askedBy: { role: "plugin", agentId: null }, options: LOCAL_OPTIONS });
    expect(await events.decisionsOpened([incident], fake.paseo)).toMatchObject({ status: "none", published: [] });
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();
    expect(fake.sends).toEqual([]);
    expect(wakes()).toEqual([]);
  });

  it("a danger signal wakes it at once, for a project in the policy's scope, until its alert is cleared", async () => {
    inScope();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const first = danger(1);
    expect(wakesGovernor(first)).toBe(true);
    expect(missionsOfEvent(first)).toEqual([]);
    expect(await events.publish([first], fake.paseo)).toEqual({ status: "done", published: [eventKeyOf(first)], skipped: [] });
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([expect.stringMatching(/^- worker\.signal danger — project wks_1, Worker agent-worker-1,/)]);
    // Out of the scope: nothing, and no Orchestrator is looked for.
    expect(await events.publish([danger(2, OTHER_WS)], fake.paseo)).toMatchObject({ status: "none", published: [] });
    // Its alert cleared before the Orchestrator is idle: dropped.
    fake.byId(ORCHESTRATOR)!.status = "running";
    const cleared = danger(3);
    await events.publish([cleared], fake.paseo);
    alerts().clear((cleared as { alertKey: string }).alertKey);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("mission.signal: a family due for step 3 wakes it with its crossed figures; dropped when the family reset before delivery", async () => {
    openMission();
    const fake = daemon();
    const events = bus();
    const outcome = replanDue();
    expect(missionSignalEventsOf(outcome, clock)).toEqual([{ type: "mission.signal", missionId: MISSION, family: "stuck", figures: [STALLED], step: 3, at: clock.toISOString() }]);
    // Code's own steps raise nothing.
    const codeSteps: GovernorOutcome = {
      missionId: MISSION,
      figures: [STALLED],
      actions: (["record", "nudge", "nudge-failed", "reset"] as const).map((action) => ({ family: "stuck", action, commandId: null, reason: null })),
    };
    expect(missionSignalEventsOf(codeSteps, clock)).toEqual([]);
    const [signal] = missionSignalEventsOf(outcome, clock);
    expect(isInEventScope(signal!, new Set())).toBe(true);
    expect(missionsOfEvent(signal!)).toEqual([MISSION]);
    expect(await events.governed([outcome], fake.paseo)).toEqual({ status: "done", published: [`mission.signal:${MISSION}:stuck@${clock.toISOString()}`], skipped: [] });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([
      `- mission.signal stuck — mission ${MISSION}, step 3: the Main was nudged and these still hold after the window: stalled 1 (threshold ≥ 1; ${REQUEST}). Read the mission with bm_missions and send its Main bm_govern with step "replan"; on real risk, ask the owner with bm_ask_owner or stop a Worker with bm_direct_worker.`,
    ]);

    // The next climb, 16 minutes on: the family resets before the Orchestrator is idle.
    clock = new Date(clock.getTime() + 16 * 60_000);
    expect((await events.governed([replanDue()], fake.paseo)).published).toHaveLength(1);
    clock = new Date(clock.getTime() + 60_000);
    await events.governed([{ missionId: MISSION, figures: [], actions: [{ family: "stuck", action: "reset", commandId: null, reason: null }] }], fake.paseo);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("mission.review: every 10 finished requests, and at 50 % and 100 % of a budget, passed between two recomputations of this run", async () => {
    const budget = (id: "requestsBudget" | "daysBudget", value: number): GovernorFigure => ({ family: "budget", id, value, threshold: 100, op: ">=", crossed: value >= 100, detail: null });
    expect(reviewMarksOf(9, [STALLED])).toEqual({ finished: 0, budgets: {} });
    expect(reviewMarksOf(23, [budget("requestsBudget", 55), budget("daysBudget", 100)])).toEqual({ finished: 2, budgets: { requestsBudget: 1, daysBudget: 2 } });
    const now = reviewMarksOf(10, [budget("requestsBudget", 120), budget("daysBudget", 40)]);
    // A mark the run found passed is not a new one.
    expect(missionReviewEventsOf(MISSION, undefined, now, 10, [budget("requestsBudget", 120)])).toEqual([]);
    expect(missionReviewEventsOf(MISSION, { finished: 0, budgets: {} }, now, 10, [budget("requestsBudget", 120), budget("daysBudget", 40)])).toEqual([
      { type: "mission.review", missionId: MISSION, reason: "finished-10", value: 10, figure: null },
      { type: "mission.review", missionId: MISSION, reason: "budget-100", value: 120, figure: "requestsBudget" },
    ]);
    expect(missionReviewEventsOf(MISSION, { finished: 1, budgets: { requestsBudget: 1 } }, reviewMarksOf(19, [budget("requestsBudget", 99)]), 19, [budget("requestsBudget", 99)])).toEqual([]);

    openMission();
    const fake = daemon();
    const events = bus();
    const roster = createMissionRoster(home, { env: {} });
    const ids = Array.from({ length: 10 }, (_, n) => `req-20261009T10${String(n).padStart(2, "0")}00Z`);
    for (const requestId of ids) roster.add(MISSION, { requestId, workspaceId: WS, topic: "t", workerId: null });
    for (const requestId of ids.slice(0, 9)) roster.setState(MISSION, requestId, "finished");
    const recomputed = (value: number): GovernorOutcome => ({ missionId: MISSION, figures: [budget("requestsBudget", value)], actions: [] });
    expect(await events.governed([recomputed(40)], fake.paseo)).toMatchObject({ status: "none", published: [] });
    roster.setState(MISSION, ids[9]!, "finished");
    expect(await events.governed([recomputed(50)], fake.paseo)).toEqual({
      status: "done",
      published: [`mission.review:${MISSION}:finished-10:10`, `mission.review:${MISSION}:budget-50:requestsBudget`],
      skipped: [],
    });
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([
      `- mission.review finished-10 — mission ${MISSION}, 10 requests finished. Read it with bm_missions against its charter; act with bm_govern or bm_ask_owner where it drifted, else keep a note with bm_note.`,
      `- mission.review budget-50 — mission ${MISSION}, requestsBudget at 50 %. Read it with bm_missions against its charter; act with bm_govern or bm_ask_owner where it drifted, else keep a note with bm_note.`,
    ]);
    // Still at 50 %: nothing new.
    await orchestratorIdle(fake);
    clock = new Date(clock.getTime() + 16 * 60_000);
    expect(await events.governed([recomputed(70)], fake.paseo)).toMatchObject({ status: "none", published: [] });
  });

  it("mission.scope: an active request outside the charter that the Main may not add and has not asked for wakes it after the window", async () => {
    const THIRD_WS = "wks_3";
    openMission(MISSION, [WS]);
    const roster = createMissionRoster(home, { env: {} });
    roster.add(MISSION, { requestId: REQUEST, workspaceId: OTHER_WS, topic: "t", workerId: null });
    const mission = () => createMissionStore(home).get(MISSION)!;
    const outside: BmEvent = { type: "mission.scope", missionId: MISSION, workspaceId: OTHER_WS, requestId: REQUEST, linkId: null };
    expect(outsideCharterOf(home, mission())).toEqual([outside]);
    // The Main may add it itself: nothing for the governor.
    createMissionAutonomyStore(home).setCell(MISSION, "scope-repo", "delegate");
    expect(outsideCharterOf(home, mission())).toEqual([]);
    createMissionAutonomyStore(home).setCell(MISSION, "scope-repo", "owner");

    const fake = daemon();
    const events = bus();
    const pass = () => events.governed([{ missionId: MISSION, figures: [], actions: [] }], fake.paseo);
    expect(await pass()).toMatchObject({ status: "none" });
    clock = new Date(clock.getTime() + 29 * 60_000);
    expect(await pass()).toMatchObject({ status: "none" });
    clock = new Date(clock.getTime() + 60_000);
    expect(await pass()).toEqual({ status: "done", published: [`mission.scope:${MISSION}:${OTHER_WS}:${REQUEST}`], skipped: [] });
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([
      `- mission.scope — mission ${MISSION}, project ${OTHER_WS} is outside its charter (request ${REQUEST}); its Main may not add the repo and has not asked the owner. Read the mission with bm_missions; tell its Main with bm_govern, or ask the owner with bm_ask_owner.`,
    ]);
    await orchestratorIdle(fake);

    // Another repo; the Main asks the owner to add it before the Orchestrator is idle: dropped.
    const second = "req-20261009T110000Z";
    roster.add(MISSION, { requestId: second, workspaceId: THIRD_WS, topic: "t", workerId: null });
    clock = new Date(clock.getTime() + 16 * 60_000);
    await pass();
    clock = new Date(clock.getTime() + 30 * 60_000);
    fake.byId(ORCHESTRATOR)!.status = "running";
    expect((await pass()).published).toEqual([`mission.scope:${MISSION}:${THIRD_WS}:${second}`]);
    const decisionStore = createMissionDecisionStore(home);
    decisionStore.open(missionCardOf(mission(), { addRepos: [THIRD_WS] }, { id: decisionStore.nextId(MISSION), mainId: "main-1", at: clock.toISOString() }));
    expect(outsideCharterOf(home, mission())).toEqual([outside]);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("mission.conflict: always wakes it, with both missions; dropped once one of them closed", async () => {
    openMission(MISSION, [WS], "PAY");
    openMission(OTHER_MISSION, [WS], "SHIP");
    const conflict = (area: string): BmEvent => ({ type: "mission.conflict", missions: [OTHER_MISSION, MISSION], workspaceId: WS, area, evidence: "both wrote src/pay/card.ts in the last 7 days" });
    expect(eventKeyOf(conflict("src/pay/"))).toBe(`mission.conflict:${MISSION}+${OTHER_MISSION}:${WS}:src/pay/`);
    expect(missionsOfEvent(conflict("src/pay/"))).toEqual([OTHER_MISSION, MISSION]);
    expect(isInEventScope(conflict("src/pay/"), new Set())).toBe(true);
    const fake = daemon();
    const events = bus();
    expect((await events.publish([conflict("src/pay/")], fake.paseo)).published).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([
      `- mission.conflict — missions ${OTHER_MISSION} and ${MISSION}, project ${WS}, area src/pay/: both wrote src/pay/card.ts in the last 7 days. Read both with bm_missions and give the area one owner with bm_arbitrate.`,
    ]);
    await orchestratorIdle(fake);
    clock = new Date(clock.getTime() + 16 * 60_000);
    fake.byId(ORCHESTRATOR)!.status = "running";
    expect((await events.publish([conflict("src/ship/")], fake.paseo)).published).toHaveLength(1);
    const closed = createMissionStore(home, { env: {} }).update(OTHER_MISSION, (current) => ({ ...current, state: "closed", closedAt: clock.toISOString() }));
    expect(closed.ok).toBe(true);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("at most one wake per mission per 15 minutes, danger excepted: a held event goes with the first publish after the window", async () => {
    inScope();
    openMission(MISSION, [WS], "PAY");
    openMission(OTHER_MISSION, [WS], "SHIP");
    const fake = daemon();
    const events = bus();
    const start = clock.getTime();
    const minute = (m: number) => (clock = new Date(start + m * 60_000));
    const lines = (n: number) => fake.sends[n]!.text.split("\n").slice(2).map((line) => line.split(" — ")[0]);

    // Two families of one mission at once: one wake.
    const both: GovernorOutcome = { ...replanDue(), actions: [...replanDue().actions, { family: "drift", action: "replan-due", commandId: null, reason: null }] };
    expect((await events.governed([both], fake.paseo)).published).toHaveLength(2);
    expect(lines(0)).toEqual(["- mission.signal stuck", "- mission.signal drift"]);
    await orchestratorIdle(fake);

    // Five minutes on: the same mission waits; another mission and a danger signal do not.
    minute(5);
    const held = { ...replanDue(), actions: [{ family: "drift" as const, action: "replan-due" as const, commandId: null, reason: null }] };
    const result = await events.governed([held, replanDue(OTHER_MISSION)], fake.paseo);
    expect(result).toEqual({ status: "done", published: [`mission.signal:${OTHER_MISSION}:stuck@${clock.toISOString()}`], skipped: [`mission.signal:${MISSION}:drift@${clock.toISOString()}`] });
    await orchestratorIdle(fake);
    expect((await events.publish([danger(1)], fake.paseo)).published).toHaveLength(1);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(3);

    minute(14);
    expect(await events.governed([], fake.paseo)).toMatchObject({ status: "none", published: [] });
    minute(15);
    expect(await events.governed([], fake.paseo)).toMatchObject({ status: "done", published: [`mission.signal:${MISSION}:drift@${new Date(start + 5 * 60_000).toISOString()}`] });
    expect(fake.sends).toHaveLength(4);
    expect(lines(3)).toEqual(["- mission.signal drift"]);
  });
});

describe("the policy's scope (design §A.8 Scope, §B.2; change-007 C1)", () => {
  const THIRD_WS = "wks_3";
  const NONE_WS = "wks_4";

  it("projectsAboveOwner: the projects with a shadow or delegate cell; owner cells, stored or absent, and the challenger alone are not", () => {
    const policy: AutonomyPolicy = {
      projects: {
        [WS]: { scope: { mode: "shadow", at: "T" } },
        [OTHER_WS]: { preference: { mode: "owner", at: "T" }, "reversible-technical": { mode: "delegate", at: "T" } },
        [THIRD_WS]: { scope: { mode: "owner", at: "T" }, environment: { mode: "owner", at: "T" } },
        // Any class may be delegated (ADR-025): a delegated release cell puts the project in the scope.
        [NONE_WS]: { release: { mode: "delegate", at: "T" } },
      },
      challenger: { [THIRD_WS]: true },
    };
    expect([...projectsAboveOwner(policy)].sort()).toEqual([WS, OTHER_WS, NONE_WS].sort());
    expect(projectsAboveOwner(EMPTY_AUTONOMY_POLICY)).toEqual(new Set());
  });

  it("eventScopeOf reads the policy file; one that cannot be read is the empty scope, with one log line", () => {
    expect(eventScopeOf(home)).toEqual(new Set());
    inScope(OTHER_WS);
    expect(eventScopeOf(home)).toEqual(new Set([OTHER_WS]));
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(join(home, "autonomy"), { recursive: true });
    symlinkSync(elsewhere, join(home, "autonomy"));
    const log = vi.fn();
    expect(eventScopeOf(home, log)).toEqual(new Set());
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("the challenger's predictions (design §B.3, §B.9; change-007 C1)", () => {
  const OPENED_WITH_PREDICTIONS = { prediction: { recommended: { optionKey: "a" }, orchestrator: null } } satisfies Partial<Decision>;
  /** A Worker question opened by this build: its recommended prediction recorded, none of the Orchestrator's yet. */
  const predictable = (n: number, over: Partial<Decision> = {}) => question(n, { ...OPENED_WITH_PREDICTIONS, ...over });
  const policy = (over: Partial<AutonomyPolicy> = {}): AutonomyPolicy => ({ projects: {}, challenger: { [WS]: true }, ...over });
  const asks = (events: BmEvent[]) => events.map((event) => (event.type === "decision.opened" ? event.asks : event.type));

  it("asks for a prediction for an owner or shadow cell of any class with the challenger on, and its line names bm_predict", () => {
    // Every cell owner (nothing stored), the challenger on.
    const [owner] = decisionOpenedEventsOf([predictable(1)], policy());
    expect(owner).toEqual({ type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: "agent-worker", asks: "prediction" });
    expect(eventLineOf(owner!)).toBe(
      `- decision.opened — project ${WS}, request ${REQUEST}, decision q:${REQUEST}:Q1, asked by Worker agent-worker. A prediction is asked: read it with bm_decisions and give the option you expect the owner to choose with bm_predict, with your reason in one line. The owner sees it as your proposal and decides: answer nothing.`,
    );
    // Same type and dedupe key as every decision.opened.
    expect(eventKeyOf(owner!)).toBe(`decision.opened:q:${REQUEST}:Q1`);
    const shadow = policy({ projects: { [WS]: { scope: { mode: "shadow", at: "T" } } } });
    expect(asks(decisionOpenedEventsOf([predictable(2, { class: "scope" })], shadow))).toEqual(["prediction"]);
    // A fallback incident is predicted too (the Orchestrator did not ask it); its own decision never is.
    const incident = makeDecision({ id: "f:fb-1", workspaceId: WS, requestId: null, askedBy: { role: "plugin", agentId: null }, options: LOCAL_OPTIONS, ...OPENED_WITH_PREDICTIONS });
    const own = makeDecision({ id: "o:1", workspaceId: WS, options: LOCAL_OPTIONS, ...OPENED_WITH_PREDICTIONS });
    expect(asks(decisionOpenedEventsOf([incident, own], policy()))).toEqual(["prediction"]);
  });

  it("asks none with the challenger off, for a delegate cell, or for a decision opened before predictions; a release, data, security or cost class is predicted too (ADR-025)", () => {
    // The challenger off (the default, DQ-4), or on for another project: an owner or shadow cell wakes nobody.
    const shadowOff = policy({ projects: { [WS]: { "reversible-technical": { mode: "shadow", at: "T" } } }, challenger: {} });
    for (const off of [EMPTY_AUTONOMY_POLICY, policy({ challenger: { [WS]: false } }), policy({ challenger: { [OTHER_WS]: true } }), shadowOff]) {
      expect(decisionOpenedEventsOf([predictable(1)], off)).toEqual([]);
    }
    // A delegate cell is decided by the Orchestrator, not predicted.
    const delegated = policy({ projects: { [WS]: { "reversible-technical": { mode: "delegate", at: "T" } } } });
    expect(asks(decisionOpenedEventsOf([predictable(1)], delegated))).toEqual(["decision"]);
    // Release, data, security, cost: predicted like any class with the challenger on, by an option's effect or the proposed class.
    const release = predictable(3, { options: [...LOCAL_OPTIONS, { key: "c", label: "Deploy", recommended: false, effects: ["deploy"] }] });
    expect(asks(decisionOpenedEventsOf([release], policy()))).toEqual(["prediction"]);
    for (const decisionClass of ["release", "data", "security", "cost"] as const) {
      expect(asks(decisionOpenedEventsOf([predictable(4, { class: decisionClass })], policy())), decisionClass).toEqual(["prediction"]);
      expect(decisionOpenedEventsOf([predictable(4, { class: decisionClass })], EMPTY_AUTONOMY_POLICY), decisionClass).toEqual([]);
    }
    // A settled decision, one the Orchestrator predicted already, one opened before predictions: none.
    expect(decisionOpenedEventsOf([predictable(5, { status: "withdrawn", settledAt: at(1) })], policy())).toEqual([]);
    const predicted = predictable(6, { prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: "r", at: at(1) } } });
    expect(decisionOpenedEventsOf([predicted, question(7)], policy())).toEqual([]);
  });
});

describe("the delegation to the Orchestrator (design §B.5, §B.9; bead t9lm.11)", () => {
  const OPENED_WITH_PREDICTIONS = { prediction: { recommended: { optionKey: "a" }, orchestrator: null } } satisfies Partial<Decision>;
  const predictable = (n: number, over: Partial<Decision> = {}) => question(n, { ...OPENED_WITH_PREDICTIONS, ...over });
  const asks = (events: BmEvent[]) => events.map((event) => (event.type === "decision.opened" ? event.asks : event.type));
  const cellPolicy = (cell: AutonomyPolicy["projects"][string][DecisionClass] | null, challenger: boolean): AutonomyPolicy => ({
    projects: cell === null ? {} : { [WS]: { "reversible-technical": cell } },
    challenger: { [WS]: challenger },
  });

  it("a delegate cell whose predictor is the Orchestrator raises decision.opened asking bm_decide, for a Worker's question and a fallback incident", () => {
    const delegated = cellPolicy({ mode: "delegate", at: "T" }, false);
    const [opened] = decisionOpenedEventsOf([predictable(1)], delegated);
    expect(opened).toEqual({ type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: "agent-worker", asks: "decision" });
    expect(eventLineOf(opened!)).toBe(
      `- decision.opened — project ${WS}, request ${REQUEST}, decision q:${REQUEST}:Q1, asked by Worker agent-worker. A decision is asked: the owner's policy delegates its class to you. Read it with bm_decisions and choose the option the owner would, with bm_decide and your reason in one line.`,
    );
    expect(eventKeyOf(opened!)).toBe(`decision.opened:q:${REQUEST}:Q1`);
    // A fallback incident is environment: asked when that class is delegated to the Orchestrator.
    const incident = makeDecision({ id: "f:fb-1", workspaceId: WS, requestId: null, askedBy: { role: "plugin", agentId: null }, options: LOCAL_OPTIONS });
    expect(decisionOpenedEventsOf([incident], delegated)).toEqual([]);
    const environment: AutonomyPolicy = { projects: { [WS]: { environment: { mode: "delegate", at: "T" } } }, challenger: {} };
    expect(asks(decisionOpenedEventsOf([incident], environment))).toEqual(["decision"]);
    // Its own decision is the owner's whatever the cell.
    expect(decisionOpenedEventsOf([makeDecision({ id: "o:1", workspaceId: WS, options: LOCAL_OPTIONS })], delegated)).toEqual([]);
  });

  it("per cell: delegate asks bm_decide; owner or shadow asks bm_predict with the challenger on and nothing with it off", () => {
    const cases: Array<[string, AutonomyPolicy["projects"][string][DecisionClass] | null, boolean, string[]]> = [
      ["delegate, challenger off", { mode: "delegate", at: "T" }, false, ["decision"]],
      ["delegate, challenger on", { mode: "delegate", at: "T" }, true, ["decision"]],
      ["owner (absent), challenger on", null, true, ["prediction"]],
      ["owner (set), challenger on", { mode: "owner", at: "T" }, true, ["prediction"]],
      ["shadow, challenger on", { mode: "shadow", at: "T" }, true, ["prediction"]],
      ["owner (absent), challenger off", null, false, []],
      ["owner (set), challenger off", { mode: "owner", at: "T" }, false, []],
      ["shadow, challenger off", { mode: "shadow", at: "T" }, false, []],
    ];
    for (const [name, cell, challenger, expected] of cases) {
      expect(asks(decisionOpenedEventsOf([predictable(1)], cellPolicy(cell, challenger))), name).toEqual(expected);
    }
  });

  it("a release, data, security or cost class delegated (Full auto, ADR-025) asks bm_decide like any class", async () => {
    mkdirSync(join(home, "autonomy"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, "autonomy", "policy.json"),
      JSON.stringify({
        version: 1,
        projects: { [WS]: Object.fromEntries(["release", "data", "security", "cost", "reversible-technical"].map((c) => [c, { mode: "delegate", at: "T" }])) },
        challenger: { [WS]: true },
      }),
    );
    const policy = createAutonomyStore(home).read();
    const risky = [
      ...(["release", "data", "security", "cost"] as const).map((decisionClass, index) => predictable(10 + index, { class: decisionClass })),
      // Proposed as reversible-technical, but an option migrates: data.
      predictable(20, { options: [...LOCAL_OPTIONS, { key: "c", label: "Add a table", recommended: false, effects: ["migration"] }] }),
    ];
    expect(asks(decisionOpenedEventsOf(risky, policy))).toEqual(["decision", "decision", "decision", "decision", "decision"]);
  });
});

describe("each wake recorded for A-7 (evaluation design §4) and M-26 (missions design §9.7)", () => {
  it("a delivered BM-EVENTS message is one wake: the Orchestrator, the time, its projects, events and their types, no text", async () => {
    inScope();
    inScope(OTHER_WS);
    openMission();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    await events.publish([danger(1), danger(2, OTHER_WS), ...missionSignalEventsOf(replanDue(), clock)], fake.paseo);
    // Queued, not yet sent: no wake.
    expect(wakes()).toEqual([]);
    clock = new Date(clock.getTime() + 60_000);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(wakes()).toEqual([
      { orchestratorId: ORCHESTRATOR, at: clock.toISOString(), endedAt: null, workspaceIds: [WS, OTHER_WS].sort(), events: 3, eventTypes: ["mission.signal", "worker.signal"] },
    ]);
    expect(events.wakeEventsOf(ORCHESTRATOR).map((event) => event.type)).toEqual(["worker.signal", "worker.signal", "mission.signal"]);
  });

  it("a batch whose every event settled is no wake", async () => {
    inScope();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const signal = danger(1);
    await events.publish([signal], fake.paseo);
    alerts().clear((signal as { alertKey: string }).alertKey);
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
    expect(wakes()).toEqual([]);
  });

  it("its turn end records whether it acted: an act tool called with success marks it; a read, a refusal or a direction other than stop does not", async () => {
    inScope();
    const fake = daemon();
    const events = bus();
    const call = vi.fn<(name: string, input: unknown) => Promise<{ ok: boolean; text: string }>>(async (name) => ({ ok: name !== "bm_arbitrate", text: "" }));
    const tools = actsNoted({ faces: [], call }, events);
    expect(Object.keys(tools)).toEqual(["faces", "call"]);

    await events.publish([danger(1)], fake.paseo);
    await tools.call("bm_missions", {});
    await tools.call("bm_arbitrate", {});
    await tools.call("bm_direct_worker", { intent: "redirect" });
    await orchestratorIdle(fake);
    await events.publish([danger(2)], fake.paseo);
    await tools.call("bm_direct_worker", { intent: "stop", interrupt: true });
    await orchestratorIdle(fake);
    await events.publish([danger(3)], fake.paseo);
    await tools.call("bm_note", { text: "nothing to do" });
    await orchestratorIdle(fake);
    expect(call).toHaveBeenCalledTimes(5);
    expect(wakes().map((wake) => [wake.eventTypes, wake.acted])).toEqual([
      [["worker.signal"], false],
      [["worker.signal"], true],
      [["worker.signal"], true],
    ]);
    // Outside a wake, an act marks nothing.
    await tools.call("bm_govern", {});
    expect(wakes().map((wake) => wake.acted)).toEqual([false, true, true]);
    for (const name of WAKE_ACT_TOOLS.filter((tool) => tool !== "bm_direct_worker")) expect(isWakeAct(name, {}), name).toBe(true);
    expect(isWakeAct("bm_direct_worker", { intent: "stop" })).toBe(true);
    expect(isWakeAct("bm_direct_worker", {})).toBe(false);
    for (const name of ["bm_missions", "bm_request", "bm_decisions", "bm_reply"]) expect(isWakeAct(name, {}), name).toBe(false);
  });

  it("the Orchestrator turn that closes a wake records its tokens on the wake (change-007 C6)", async () => {
    inScope();
    const fake = daemon();
    // The snapshot the Orchestrator's refetch returns at its turn end (Claude, measured 2026-09-30).
    const lastUsage = { inputTokens: 9, cachedInputTokens: 41_200, outputTokens: 350, totalCostUsd: 1.27, contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 44_000 };
    const refetch = vi.fn(async () => ({ entries: [], agent: { id: ORCHESTRATOR, lastUsage } }));
    const paseo = { agents: { ...fake.paseo.agents, ref: (id: string) => ({ ...fake.paseo.agents.ref(id), timeline: { refetch } }) } };
    const events = bus();
    await events.publish([danger(1)], paseo);
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).not.toHaveProperty("usage");
    expect(wakes()[0]).not.toHaveProperty("acted");
    // Another agent's turn end reads nothing.
    await queue.turnEnded({ agent: { id: MANAGER } }, paseo);
    expect(refetch).not.toHaveBeenCalled();

    clock = new Date(clock.getTime() + 45_000);
    fake.byId(ORCHESTRATOR)!.status = "idle";
    await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, paseo);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith({ direction: "tail", limit: 1 });
    // This turn's input, cached and output tokens only: no cost (a session total), no context.
    expect(wakes()).toEqual([
      {
        orchestratorId: ORCHESTRATOR,
        at: expect.any(String),
        endedAt: clock.toISOString(),
        workspaceIds: [WS],
        events: 1,
        eventTypes: ["worker.signal"],
        usage: { inputTokens: 9, cachedInputTokens: 41_200, outputTokens: 350 },
        acted: false,
      },
    ]);
    // The owner talking to it later: no open wake, nothing read or written.
    await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, paseo);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a wake whose closing turn's snapshot cannot be read still ends, with its tokens unknown", async () => {
    inScope();
    const fake = daemon();
    const events = bus();
    await events.publish([danger(1)], fake.paseo);
    const failing = {
      agents: {
        ...fake.paseo.agents,
        ref: (id: string) => ({
          ...fake.paseo.agents.ref(id),
          timeline: {
            refetch: async () => {
              throw new Error("timeline gone");
            },
          },
        }),
      },
    };
    fake.byId(ORCHESTRATOR)!.status = "idle";
    await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, failing);
    expect(wakes()[0]).toMatchObject({ endedAt: clock.toISOString(), usage: null });
    // A handle without a timeline (as the other tests' fake): the same.
    await events.publish([danger(2)], fake.paseo);
    await orchestratorIdle(fake);
    expect(wakes()[1]).toMatchObject({ endedAt: clock.toISOString(), usage: null });
  });

  it("the Orchestrator's next turn end ends its oldest open wake, before the next batch goes; another agent's turn end does not", async () => {
    inScope();
    const fake = daemon();
    const events = bus();
    await events.publish([danger(1)], fake.paseo);
    expect(wakes()).toHaveLength(1);
    // A second event waits for the Orchestrator's running turn.
    await events.publish([danger(2)], fake.paseo);
    expect(fake.sends).toHaveLength(1);
    clock = new Date(clock.getTime() + 30_000);
    await queue.turnEnded({ agent: { id: MANAGER } }, fake.paseo);
    expect(wakes()[0]!.endedAt).toBeNull();
    const endedAt = clock.toISOString();
    await orchestratorIdle(fake);
    // The first wake ended at this turn end, and the same turn end delivered the second.
    expect(fake.sends).toHaveLength(2);
    expect(wakes().map((wake) => [wake.endedAt, wake.events])).toEqual([
      [endedAt, 1],
      [null, 1],
    ]);
    clock = new Date(clock.getTime() + 30_000);
    await orchestratorIdle(fake);
    expect(wakes()[1]!.endedAt).toBe(clock.toISOString());
    // No wake left open: a later turn end (the owner talking to it) writes nothing.
    const before = JSON.stringify(wakes());
    clock = new Date(clock.getTime() + 30_000);
    await orchestratorIdle(fake);
    expect(JSON.stringify(wakes())).toBe(before);
  });
});

describe("advice.due: after every N finished requests of a project (design §G.4, §G.7; bead t9lm.25)", () => {
  /** A Manager turn that recorded the Worker's `finished` report of `requestId`, clean (no work left: no request.finished). */
  const finishedTurn = (requestId: string, minute: number, over: Partial<Parameters<typeof turn>[0]> = {}) =>
    turn({ workspaceId: WS, requestId, reports: [report({ at: at(minute), requestId, phase: "finished", buildAndTests: "npm test passed" })], ...over });
  const cadence = (value: number) => createCoordinationStore(home).set({ key: "advice.everyFinished", value });
  const request = (n: number) => `req-20260929T0${String(n).padStart(5, "0")}Z`;

  it("has its own key and line: the project, the count, bm_findings and bm_ask_owner; it is not held back by the policy's scope", () => {
    const event: BmEvent = { type: "advice.due", workspaceId: WS, finished: 5, at: at(9) };
    expect(eventKeyOf(event)).toBe(`advice.due:${WS}@${at(9)}`);
    expect(eventLineOf(event)).toBe(
      `- advice.due — project ${WS}, 5 requests finished since the last advice. Read its figures with bm_findings; for each finding worth acting on, ask the owner with bm_ask_owner, one option carrying the prepared change. With none worth it, keep a note with bm_note.`,
    );
    // Every project gets its advice: an all-owner project included (the empty scope).
    expect(isInEventScope(event, new Set())).toBe(true);
  });

  it("counts one key per finished request of a Manager's or a Worker's turn; a Reviewer's turn, a blocked report or no report counts nothing", () => {
    const record = turn({
      workspaceId: WS,
      requestId: null,
      reports: [
        report({ at: at(5), requestId: request(1), phase: "finished" }),
        report({ at: at(7), requestId: request(1), phase: "finished" }),
        report({ at: at(6), requestId: request(2), phase: "finished" }),
        report({ at: at(8), requestId: request(3), phase: "blocked" }),
      ],
    });
    expect(finishedRequestKeysOf(record)).toEqual({ workspaceId: WS, keys: [request(1), request(2)], at: at(7) });
    expect(finishedRequestKeysOf({ ...record, agentId: WORKER, role: "worker" })).toEqual({ workspaceId: WS, keys: [request(1), request(2)], at: at(7) });
    expect(finishedRequestKeysOf({ ...record, role: "reviewer" })).toBeNull();
    expect(finishedRequestKeysOf(turn({ workspaceId: WS }))).toBeNull();
    expect(finishedRequestKeysOf(undefined)).toBeNull();
  });

  it("none with N = 0: nothing is counted, nothing written, nothing sent", async () => {
    cadence(0);
    const fake = daemon();
    const events = bus();
    for (let n = 1; n <= 12; n += 1) await events.turnRecorded(finishedTurn(request(n), n), [], fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(createAdviceStore(home).read()).toEqual({});
  });

  it("a count that cannot be written costs one log line and no event", async () => {
    cadence(1);
    mkdirSync(join(home, "orchestrator"), { recursive: true });
    writeFileSync(join(home, "orchestrator", "advice.json"), JSON.stringify({ version: 2, entries: {} }));
    const lines: string[] = [];
    const fake = daemon();
    const events = createEventBus({ home: () => home, queue, now: () => clock, log: (line) => lines.push(line) });
    expect(await events.turnRecorded(finishedTurn(request(1), 1), [], fake.paseo)).toMatchObject({ status: "none" });
    expect(fake.sends).toEqual([]);
    expect(lines.join("\n")).toContain("could not count the finished requests toward the advice");
  });
});

describe("a finished-unverified request is built as work left (design §C.3, §A.8; bead 7gxw.4; retired as a wake, missions design §9.1)", () => {
  const traces = () => ({ tracesDir: join(root, "traces") });
  /** No live agent: the request is rebuilt from its records alone. */
  const noAgents = { agents: { list: async () => ({ entries: [] }) }, workspaces: { list: async () => ({ entries: [] }) } };
  const edit = (minute: number): Evidence => ({ kind: "file", detail: "src/invoice.ts", agentId: WORKER, at: at(minute) });
  const run = (command: string, minute: number, status?: string): Evidence => ({ kind: "shell", detail: command, agentId: WORKER, at: at(minute), ...(status === undefined ? {} : { status }) });
  /** A clean finish (nothing else left) naming `npm test`, as the Manager received it. */
  const cleanFinish = (over: Parameters<typeof report>[0] = {}) =>
    report({ agentId: MANAGER, at: at(5), requestId: REQUEST, phase: "finished", filesChanged: ["src/invoice.ts"], buildAndTests: "`npm test` pass", ...over });
  const managerTurn = (finished = cleanFinish()) => turn({ workspaceId: WS, requestId: REQUEST, at: at(6), endedAt: at(6), reports: [finished] });

  /** The request's Worker turn and the Manager turn with its finish, written as the collector writes them; the Manager's record comes back. */
  async function recorded(evidence: Evidence[], finished = cleanFinish()) {
    await appendRecord(traces(), turn({ agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQUEST, at: at(4), endedAt: at(4), evidence }));
    const record = managerTurn(finished);
    await appendRecord(traces(), record);
    return record;
  }

  beforeEach(() => clearTraceStoreCache());
  afterEach(() => clearTraceStoreCache());

  it("an unverified finish with nothing else left is published with unverified: true, and its line says so; the key is unchanged", () => {
    const record = managerTurn();
    const [event] = requestFinishedEventsOf(record, () => true);
    expect(event).toEqual({ type: "request.finished", workspaceId: WS, requestId: REQUEST, managerId: MANAGER, at: at(5), unverified: true });
    expect(eventKeyOf(event!)).toBe(`request.finished:${WS}:${REQUEST}@${at(5)}`);
    expect(eventKeyOf(event!)).toBe(eventKeyOf({ ...event!, unverified: undefined }));
    expect(eventLineOf(event!)).toBe(
      `- request.finished — project ${WS}, request ${REQUEST}, Manager ${MANAGER}, at ${at(5)}: finished — unverified, its code changed and not every check it names was seen to pass. Check it with bm_request; a commit or release on the owner's policy waits for the owner.`,
    );
    // A detected finish with nothing left: nothing, as in Phase 1.
    expect(requestFinishedEventsOf(record, () => false)).toEqual([]);
    expect(requestFinishedEventsOf(record)).toEqual([]);
    // Work left and unverified: one event, which says both.
    expect(requestFinishedEventsOf(managerTurn(cleanFinish({ beadsReady: ["bd-2"] })), () => true)).toEqual([expect.objectContaining({ unverified: true })]);
    // A Manager's or a Worker's record, never a Reviewer's; only a finished report.
    expect(requestFinishedEventsOf({ ...record, role: "reviewer" }, () => true)).toEqual([]);
    expect(requestFinishedEventsOf(managerTurn(cleanFinish({ phase: "bead-implemented" })), () => true)).toEqual([]);
  });

  it("reads a Worker's own finish against its request's records too (design §7.17.8 i)", async () => {
    await appendRecord(traces(), turn({ workspaceId: WS, requestId: REQUEST, at: at(1), endedAt: at(1) }));
    await appendRecord(traces(), turn({ agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQUEST, at: at(4), endedAt: at(4), evidence: [edit(2)] }));
    const own = turn({ agentId: WORKER, role: "worker", parentAgentId: MANAGER, workspaceId: WS, requestId: REQUEST, at: at(6), endedAt: at(6), reports: [cleanFinish({ agentId: WORKER, recordId: "rec-1" })] });
    await appendRecord(traces(), own);
    const isUnverified = await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, own);
    expect(requestFinishedEventsOf(own, isUnverified)).toEqual([expect.objectContaining({ requestId: REQUEST, managerId: MANAGER, unverified: true })]);
  });

  it("reads the request's records: code changed and npm test never ran → unverified; run and passed after the edit → not", async () => {
    const unverifiedRecord = await recorded([edit(2), run("npm test", 1, "completed")]);
    const isUnverified = await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, unverifiedRecord);
    expect(isUnverified(unverifiedRecord.reports[0]!)).toBe(true);
    expect(requestFinishedEventsOf(unverifiedRecord, isUnverified)).toEqual([expect.objectContaining({ requestId: REQUEST, unverified: true })]);

    clearTraceStoreCache();
    rmSync(traces().tracesDir, { recursive: true, force: true });
    const detectedRecord = await recorded([edit(2), run("npm test", 3, "completed")]);
    const detected = await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, detectedRecord);
    expect(detected(detectedRecord.reports[0]!)).toBe(false);
    expect(requestFinishedEventsOf(detectedRecord, detected)).toEqual([]);
  });

  it("a finish with no code changed, or a request not checked (recorded before shell entries had a status), publishes nothing for it", async () => {
    // No file named, none edited: never finished-unverified, whatever the checks.
    const noCode = await recorded([], cleanFinish({ filesChanged: [], buildAndTests: "npm test passed" }));
    const noCodeTest = await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, noCode);
    expect(requestFinishedEventsOf(noCode, noCodeTest)).toEqual([]);

    clearTraceStoreCache();
    rmSync(traces().tracesDir, { recursive: true, force: true });
    // Not checked: shell entries, none with a status. Shown and published as before.
    const old = await recorded([edit(2), run("npm test", 3)]);
    const oldTest = await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, old);
    expect(requestFinishedEventsOf(old, oldTest)).toEqual([]);
  });

  it("reads nothing for a Reviewer's turn, or one without a finish, and a store it cannot read changes nothing", async () => {
    const reviewer = turn({ agentId: "agent-reviewer", role: "reviewer", workspaceId: WS, requestId: REQUEST, reports: [cleanFinish()] });
    expect((await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, reviewer))(reviewer.reports[0]!)).toBe(false);
    const worker = turn({ agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQUEST });
    expect((await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, worker))(cleanFinish())).toBe(false);
    expect((await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home }, undefined))(cleanFinish())).toBe(false);
    // A rebuild that fails: one log line, nothing unverified (the events are as before).
    const lines: string[] = [];
    const failing = { filter: () => { throw new Error("agents unreadable"); } } as never;
    const record = managerTurn();
    const broken = await unverifiedFinishesOf({ location: traces(), paseo: noAgents, home, allAgents: failing, log: (line) => lines.push(line) }, record);
    expect(broken(record.reports[0]!)).toBe(false);
    expect(lines).toEqual([`[paseo-bm] could not check the finish of ${MANAGER}'s turn: agents unreadable`]);
  });
});

describe("threshold.crossed (compact): a Manager's or a Worker's turn over its compaction threshold (design §G.5, §G.7; change-008 C1; bead 7gxw.10)", () => {
  const CLAUDE = "claude-opus-5";
  /** A Worker's Claude turn that read 6.1M tokens: over the Worker's 5.7M. */
  const crossing = (minute: number, over: Partial<Parameters<typeof turn>[0]> = {}) =>
    turn({
      workspaceId: WS,
      agentId: WORKER,
      role: "worker",
      requestId: REQUEST,
      turnId: `w-${minute}`,
      at: at(minute),
      endedAt: at(minute),
      usage: { inputTokens: 100_000, cachedInputTokens: 6_000_000, outputTokens: 1_000, costUsd: null, costBasis: "unavailable", model: CLAUDE, pricesUpdatedAt: null },
      runtime: { model: CLAUDE, thinkingOptionId: null, modeId: null, provider: "bm-worker" },
      ...over,
    });
  const compactedTurn = (minute: number) =>
    crossing(minute, { evidence: [{ kind: "compaction", detail: "manual", agentId: WORKER, at: at(minute), trigger: "manual", preTokens: null } as Evidence] });
  const settings = DEFAULT_COORDINATION_SETTINGS;

  it("has its own key per agent cycle and a line naming bm_compact; every project gets it, whatever the policy's scope", () => {
    const event = compactCrossedEventOf(crossing(5), settings, { compactions: 0, pending: false })!;
    expect(event).toEqual({
      type: "threshold.crossed",
      workspaceId: WS,
      requestId: REQUEST,
      agentId: WORKER,
      role: "worker",
      kind: "compact",
      figure: "tokensPerTurn",
      value: 6_100_000,
      threshold: 5_700_000,
      at: at(5),
      cycle: 0,
    });
    expect(eventKeyOf(event)).toBe(`threshold.crossed:compact:${WORKER}#0`);
    expect(eventKeyOf({ ...event, cycle: 1 })).toBe(`threshold.crossed:compact:${WORKER}#1`);
    expect(eventLineOf(event)).toBe(
      `- threshold.crossed compact — project ${WS}, Worker ${WORKER}, request ${REQUEST}, at ${at(5)}: it read 6,100,000 tokens in one turn (threshold 5,700,000). If a compaction is worth it, request it with bm_compact; the plugin runs it at that agent's next safe point. Otherwise keep a note with bm_note.`,
    );
    expect(isInEventScope(event, new Set())).toBe(true);
  });

  it("judges a Codex or OpenCode turn by its context share; none below it, for a turn with a compaction, a Reviewer, an unknown provider, compaction off, at compact.maxPerAgent or with one pending", () => {
    const codex = (share: number, role: "manager" | "worker" = "manager") =>
      crossing(6, {
        agentId: role === "manager" ? MANAGER : WORKER,
        role,
        requestId: role === "manager" ? null : REQUEST,
        usage: { inputTokens: 150_000, cachedInputTokens: 20_000, outputTokens: 500, costUsd: null, costBasis: "unavailable", model: "gpt-5.6-luna", pricesUpdatedAt: null, contextUsed: Math.round(share * 258_400), contextMax: 258_400 },
        runtime: { model: "gpt-5.6-luna", thinkingOptionId: null, modeId: null, provider: "bm-manager" },
      });
    expect(compactCrossedEventOf(codex(0.6), settings, { compactions: 1, pending: false })).toMatchObject({
      agentId: MANAGER,
      role: "manager",
      requestId: null,
      figure: "contextShare",
      threshold: 0.5,
      cycle: 1,
    });
    // Its 150,000 tokens are the last call's: never compared with a per-turn threshold.
    expect(compactCrossedEventOf(codex(0.3), settings, { compactions: 0, pending: false })).toBeNull();
    expect(eventLineOf(compactCrossedEventOf(codex(0.6), settings, { compactions: 0, pending: false })!)).toContain("its context filled 60 % of its window (threshold 50 %)");
    const none = { compactions: 0, pending: false };
    expect(compactCrossedEventOf(compactedTurn(5), settings, none)).toBeNull();
    expect(compactCrossedEventOf(crossing(5, { role: "reviewer" }), settings, none)).toBeNull();
    expect(compactCrossedEventOf(crossing(5, { runtime: null, usage: { ...crossing(5).usage!, model: "mystery-1" } }), settings, none)).toBeNull();
    expect(compactCrossedEventOf(crossing(5), { compact: { ...settings.compact, enabled: false } }, none)).toBeNull();
    expect(compactCrossedEventOf(crossing(5), settings, { compactions: 2, pending: false })).toBeNull();
    expect(compactCrossedEventOf(crossing(5), settings, { compactions: 0, pending: true })).toBeNull();
    expect(compactCrossedEventOf(null, settings, none)).toBeNull();
  });
});

describe("threshold.crossed (handoff): a Worker's request over its handoff threshold (design §G.6, §G.7; change-008 C1; bead 7gxw.11)", () => {
  /** A model no provider claims: the turn is never judged for compaction, so only the handoff kind shows here. */
  const CLAUDE = "mystery-1";
  /** A Worker's turn of the request that read `read` tokens. */
  const workerTurn = (minute: number, read: number, over: Partial<Parameters<typeof turn>[0]> = {}) =>
    turn({
      workspaceId: WS,
      agentId: WORKER,
      role: "worker",
      requestId: REQUEST,
      turnId: `w-${minute}`,
      at: at(minute),
      endedAt: at(minute),
      usage: { inputTokens: 1_000, cachedInputTokens: read - 1_000, outputTokens: 1_000, costUsd: null, costBasis: "unavailable", model: CLAUDE, pricesUpdatedAt: null },
      runtime: { model: CLAUDE, thinkingOptionId: null, modeId: null, provider: "bm-worker" },
      ...over,
    });
  const request = { tokensRead: 160_000_000, handoffs: 0, pending: false, finished: false };
  const settings = DEFAULT_COORDINATION_SETTINGS;

  beforeEach(() => clearTraceStoreCache());
  afterEach(() => clearTraceStoreCache());

  it("has its own key per request cycle and a line naming bm_handoff; every project gets it, whatever the policy's scope", () => {
    const event = handoffCrossedEventOf(workerTurn(5, 1_000_000), settings, request)!;
    expect(event).toEqual({
      type: "threshold.crossed",
      workspaceId: WS,
      requestId: REQUEST,
      agentId: WORKER,
      role: "worker",
      kind: "handoff",
      figure: "requestTokens",
      value: 160_000_000,
      threshold: 150_000_000,
      at: at(5),
      cycle: 0,
    });
    expect(eventKeyOf(event)).toBe(`threshold.crossed:handoff:${REQUEST}#0`);
    expect(eventKeyOf({ ...event, agentId: "agent-successor", cycle: 1 })).toBe(`threshold.crossed:handoff:${REQUEST}#1`);
    expect(eventLineOf(event)).toBe(
      `- threshold.crossed handoff — project ${WS}, Worker ${WORKER}, request ${REQUEST}, at ${at(5)}: its request read 160,000,000 tokens (threshold 150,000,000). If a handoff to a new Worker is worth it, request it with bm_handoff; the plugin hands it over at that Worker's next safe point. Otherwise keep a note with bm_note.`,
    );
    expect(isInEventScope(event, new Set())).toBe(true);
  });

  it("none below the threshold, for a Manager's turn or one with no request, with handoff off, a finished request, one pending, or at handoff.maxPerRequest", () => {
    const worker = workerTurn(5, 1_000_000);
    expect(handoffCrossedEventOf(worker, settings, { ...request, tokensRead: 149_999_999 })).toBeNull();
    expect(handoffCrossedEventOf(worker, settings, { ...request, tokensRead: null })).toBeNull();
    expect(handoffCrossedEventOf({ ...worker, role: "manager" }, settings, request)).toBeNull();
    expect(handoffCrossedEventOf({ ...worker, requestId: null }, settings, request)).toBeNull();
    expect(handoffCrossedEventOf(worker, { handoff: { ...settings.handoff, enabled: false } }, request)).toBeNull();
    expect(handoffCrossedEventOf(worker, settings, { ...request, finished: true })).toBeNull();
    expect(handoffCrossedEventOf(worker, settings, { ...request, pending: true })).toBeNull();
    expect(handoffCrossedEventOf(worker, settings, { ...request, handoffs: 2 })).toBeNull();
    expect(handoffCrossedEventOf(worker, settings, { ...request, handoffs: 1 })).toMatchObject({ cycle: 1 });
    expect(handoffCrossedEventOf(null, settings, request)).toBeNull();
  });
});

describe("writers.observed: two agents wrote one file in overlapping turns (design §F.1, §F.3; bead i8fc.1)", () => {
  const OTHER_WORKER = "agent-worker-2";
  const observed = (alertKey: string, workspaceId = WS, file = "src/math.js"): BmEvent => ({
    type: "writers.observed",
    workspaceId,
    file,
    writers: [
      { agentId: WORKER, role: "worker", requestId: REQUEST, startedAt: at(0) },
      { agentId: OTHER_WORKER, role: "worker", requestId: null, startedAt: at(5) },
    ],
    alertKey,
    at: at(15),
  });

  it("has its own key per file and turn pair, and a line with the file, both agents and what to do", () => {
    const event = observed(alertKeyOf("writers-observed", WS, "src/math.js"));
    expect(eventKeyOf(event)).toBe(`writers.observed:${WS}:src/math.js:${WORKER}@${at(0)}+${OTHER_WORKER}@${at(5)}`);
    expect(eventLineOf(event)).toBe(
      `- writers.observed — project ${WS}, file src/math.js: Worker ${WORKER} (request ${REQUEST}) and Worker ${OTHER_WORKER} (request not known) wrote it in overlapping turns, at ${at(15)}. Check the file with bm_repo; if one change may have undone the other, tell that request's Manager with bm_send_command. Otherwise keep a note with bm_note.`,
    );
    // Scoped like request.stalled and worker.signal: only a project with a class above owner.
    expect(isInEventScope(event, new Set([WS]))).toBe(true);
    expect(isInEventScope(event, new Set([OTHER_WS]))).toBe(false);
  });
});

describe("the advice count stays, with no wake (design §G.4, §7.17.8 i; REQ-183 i; missions design §9.1)", () => {
  const cadence = (value: number) => createCoordinationStore(home).set({ key: "advice.everyFinished", value });
  /** A finish with work left, as a Worker's record holds it: stored by `bm_report` (with its record id), or the Worker's own block the plugin relays. */
  const finish = (over: Parameters<typeof report>[0] = {}) =>
    report({ agentId: WORKER, at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"], ...over });
  const workerTurn = (finished = finish()) =>
    turn({ agentId: WORKER, role: "worker", parentAgentId: MANAGER, workspaceId: WS, requestId: REQUEST, at: at(6), endedAt: at(6), reports: [finished] });
  /** The same report as a Manager's record holds it: sent to it by hand, read at its own time. */
  const managerTurn = () => turn({ workspaceId: WS, requestId: REQUEST, at: at(8), endedAt: at(8), reports: [finish({ agentId: MANAGER, at: at(7) })] });
  const request = (n: number) => `req-20260929T0${String(n).padStart(5, "0")}Z`;

  it("after N finished requests the count starts again, and the Orchestrator is not woken: advice.due is retired as a wake", async () => {
    cadence(3);
    inScope();
    const fake = daemon();
    const events = bus();
    for (const n of [1, 2, 3]) {
      const record = turn({ workspaceId: WS, requestId: request(n), reports: [report({ at: at(n), requestId: request(n), phase: "finished", beadsReady: ["bd-1"] })] });
      expect(await events.turnRecorded(record, [], fake.paseo), `request ${n}`).toMatchObject({ status: "none", published: [] });
    }
    expect(createAdviceStore(home).read()[WS]).toEqual({ counted: [], at: at(3), dueAt: at(3) });
    // The default cadence is 5, with no Settings file.
    rmSync(home, { recursive: true, force: true });
    for (const n of [1, 2, 3, 4]) await events.turnRecorded(turn({ workspaceId: WS, requestId: request(n), reports: [report({ at: at(n), requestId: request(n), phase: "finished" })] }), [], fake.paseo);
    expect(createAdviceStore(home).read()[WS]).toMatchObject({ counted: [1, 2, 3, 4].map(request), dueAt: null });
    expect(fake.sends).toEqual([]);
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();
  });

  it.each([
    ["a bound Worker's bm_report", finish({ recordId: "rec-1" })],
    ["an unbound Worker's relayed block", finish()],
  ])("%s: one advice count, and no duplicate with a Manager-record finish of the same request, in either order", async (_, finished) => {
    cadence(2);
    const fake = daemon();
    const events = bus();
    expect(await events.turnRecorded(workerTurn(finished), [], fake.paseo)).toMatchObject({ status: "none", published: [] });
    await events.turnRecorded(managerTurn(), [], fake.paseo);
    expect(createAdviceStore(home).read()[WS]).toMatchObject({ counted: [REQUEST], dueAt: null });

    const reverse = bus();
    rmSync(home, { recursive: true, force: true });
    cadence(2);
    await reverse.turnRecorded(managerTurn(), [], fake.paseo);
    await reverse.turnRecorded(workerTurn(finished), [], fake.paseo);
    await reverse.turnRecorded(managerTurn(), [], fake.paseo);
    expect(createAdviceStore(home).read()[WS]).toMatchObject({ counted: [REQUEST], dueAt: null });
    expect(fake.sends).toEqual([]);
  });
});

describe("mission.split: a Main's split suggestion wakes the governor (missions design §9.6, §9.7)", () => {
  /** A `split-suggested` journal line of `missionId`, as `bm_split_mission` writes it, and its event. */
  function suggest(code: string, missionId = MISSION): BmEvent {
    const split = { code, name: `New ${code}`, goal: "Refunds end to end.", repos: [WS], requestIds: [REQUEST], reason: "Refunds are their own goal." };
    const line = createMissionStore(home, { now: () => clock, env: {} }).appendJournal(missionId, { kind: "split-suggested", by: "main", text: `suggested ${code}`, ref: "main-1", split });
    return { type: "mission.split", missionId, ...split, at: line.at };
  }

  it("is a mission event keyed per mission and code, with a line that names the mission, the code and name, and what to do", () => {
    openMission();
    const event = suggest("REF");
    expect(wakesGovernor(event)).toBe(true);
    expect(missionsOfEvent(event)).toEqual([MISSION]);
    expect(isInEventScope(event, new Set())).toBe(true);
    expect(eventKeyOf(event)).toBe(`mission.split:${MISSION}:REF`);
    expect(eventKeyOf({ ...event, at: "later", name: "Other" } as BmEvent)).toBe(`mission.split:${MISSION}:REF`);
    expect(eventLineOf(event)).toBe(
      `- mission.split — mission ${MISSION}: its Main, on the owner's yes, suggests the new mission REF "New REF" (repos ${WS}; requests ${REQUEST}): Refunds are their own goal. Read it with bm_missions (its splitSuggestions) and decide: bm_create_main with its fields, or tell the Main why not with bm_govern.`,
    );
  });

  it("wakes the Orchestrator; dropped before delivery once a mission took the code or the source mission closed", async () => {
    openMission(MISSION, [WS], "PAY");
    const fake = daemon();
    const events = bus();
    const first = suggest("REF");
    expect(await events.publish([first], fake.paseo)).toEqual({ status: "done", published: [`mission.split:${MISSION}:REF`], skipped: [] });
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([eventLineOf(first)]);
    await orchestratorIdle(fake);

    // Past the mission's window, the Orchestrator busy: a mission that took the code settles it.
    clock = new Date(clock.getTime() + 16 * 60_000);
    fake.byId(ORCHESTRATOR)!.status = "running";
    const second = suggest("CARD");
    expect((await events.publish([second], fake.paseo)).published).toEqual([`mission.split:${MISSION}:CARD`]);
    openMission(OTHER_MISSION, [WS], "CARD");
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);

    // And the source mission closing settles a third.
    clock = new Date(clock.getTime() + 16 * 60_000);
    fake.byId(ORCHESTRATOR)!.status = "running";
    expect((await events.publish([suggest("GIFT")], fake.paseo)).published).toEqual([`mission.split:${MISSION}:GIFT`]);
    expect(createMissionStore(home, { env: {} }).update(MISSION, (current) => ({ ...current, state: "closed", closedAt: clock.toISOString() })).ok).toBe(true);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("follows the 15-minute mission window: a second suggestion within it is held and goes with the first publish after it", async () => {
    openMission(MISSION, [WS], "PAY");
    const fake = daemon();
    const events = bus();
    const start = clock.getTime();
    expect((await events.publish([suggest("REF")], fake.paseo)).published).toHaveLength(1);
    await orchestratorIdle(fake);
    clock = new Date(start + 5 * 60_000);
    expect(await events.publish([suggest("CARD")], fake.paseo)).toEqual({ status: "none", published: [], skipped: [`mission.split:${MISSION}:CARD`] });
    clock = new Date(start + 15 * 60_000);
    expect(await events.governed([], fake.paseo)).toMatchObject({ status: "done", published: [`mission.split:${MISSION}:CARD`] });
    expect(fake.sends).toHaveLength(2);
    expect(fake.sends[1]!.text.split("\n").slice(2).map((line) => line.split(" — ")[0])).toEqual(["- mission.split"]);
  });
});
