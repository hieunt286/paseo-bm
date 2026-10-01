import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createCompactionStore } from "../plugin/server/compaction-store";
import { createHandoffStore } from "../plugin/server/handoff-store";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import {
  EVENTS_BATCH,
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
  requestFinishedEventsOf,
  workLeftOf,
  type BmEvent,
  type EventBus,
} from "../plugin/server/event-bus";
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
import { answerDecision, type Decision, type DecisionClass } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";
import { MANAGER, WORKER, at, report, turn } from "./fixtures/orchestrator-traces";
import type { Evidence } from "../plugin/shared/contracts";

/**
 * The event bus to the Orchestrator (autonomy design §A.8, REQ-115 b): typed
 * events with dedupe keys; `request.finished`, `request.stalled` and
 * `worker.signal` only for a project with a class above `owner` in the
 * policy, `decision.opened` by the policy per cell — a decision delegated to
 * the Orchestrator, or a prediction where the challenger is on (design §B.5,
 * §B.9; change-007 C1); every event
 * pending at the Orchestrator's idle moment delivered as ONE `BM-EVENTS`
 * message through the notice queue's batch kind; an event dropped when its
 * subject settled before delivery; nothing ever sent to the owner or another
 * agent; and a synthetic day of events that leaves at most 20 % of the
 * Orchestrator's wakes without a pending actionable event. A fake Paseo SDK, a
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
    expect(requestFinishedEventsOf({ ...record, role: "worker" })).toEqual([]);
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

describe("publishing to the Orchestrator", () => {
  it("N events pending at the Orchestrator's idle moment → one BM-EVENTS message", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    for (let n = 1; n <= 4; n += 1) decisions().open(question(n));
    await events.turnRecorded(undefined, [question(1), question(2)], fake.paseo);
    await events.turnRecorded(
      turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] }),
      [question(3), question(4)],
      fake.paseo,
    );
    expect(fake.sends).toEqual([]);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    const lines = fake.sends[0]!.text.split("\n");
    expect(lines[0]).toBe("BM-EVENTS");
    expect(lines.slice(2).map((line) => line.split(" — ")[0])).toEqual([
      "- decision.opened",
      "- decision.opened",
      "- decision.opened",
      "- decision.opened",
      "- request.finished",
    ]);
    expect(queue.pending(ORCHESTRATOR)).toEqual([]);
  });

  it("drops an event whose subject settled before delivery: an answered decision, a cleared alert", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    decisions().open(question(1));
    decisions().open(question(2));
    const stall = alerts().raise({ workspaceId: WS, kind: "request-stalled", subject: REQUEST });
    await events.turnRecorded(undefined, [question(1), question(2)], fake.paseo);
    await events.publish(
      [{ type: "request.stalled", workspaceId: WS, requestKey: REQUEST, managerId: MANAGER, reason: "idle-unfinished", alertKey: stall.alert.key, since: stall.alert.since }],
      fake.paseo,
    );
    // The owner answers Q1 in the Inbox and the Worker runs again, before the Orchestrator is idle.
    decisions().transition(`q:${REQUEST}:Q1`, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: clock.toISOString() }), WS);
    alerts().clear(stall.alert.key);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([expect.stringContaining(`decision q:${REQUEST}:Q2`)]);

    // Everything settled: no message at all.
    fake.byId(ORCHESTRATOR)!.status = "running";
    decisions().open(question(3));
    await events.turnRecorded(undefined, [question(3)], fake.paseo);
    decisions().transition(`q:${REQUEST}:Q3`, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: clock.toISOString() }), WS);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("drops a Worker signal that holds for the turn once that turn ended", async () => {
    inScope();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const signal: BmEvent = { type: "worker.signal", workspaceId: WS, workerId: WORKER, requestKey: REQUEST, signal: "failing", turnStart: "T0", alertKey: null, since: "T1" };
    await events.publish([signal], fake.paseo);
    expect(events.isSignalOpen(eventKeyOf(signal))).toBe(true);
    events.workerTurnEnded(WORKER);
    expect(events.isSignalOpen(eventKeyOf(signal))).toBe(false);
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
  });

  it("publishes each key once", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    const events = bus();
    decisions().open(question(1));
    expect((await events.turnRecorded(undefined, [question(1)], fake.paseo)).published).toHaveLength(1);
    await orchestratorIdle(fake);
    expect(await events.turnRecorded(undefined, [question(1)], fake.paseo)).toMatchObject({ status: "none", skipped: [`decision.opened:q:${REQUEST}:Q1`] });
    expect(fake.sends).toHaveLength(1);
  });

  it("without an Orchestrator, or before a Paseo handle, nothing is queued and nothing is created", async () => {
    delegateToOrchestrator();
    const fake = daemon(false);
    const events = bus();
    decisions().open(question(1));
    expect(await events.turnRecorded(undefined, [question(1)])).toMatchObject({ status: "no-paseo" });
    expect(await events.turnRecorded(undefined, [question(2)], fake.paseo)).toMatchObject({ status: "no-orchestrator" });
    expect(fake.sends).toEqual([]);
  });

  it("never messages the owner or another agent: every send goes to the Orchestrator", async () => {
    inScope();
    const fake = daemon();
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(
      turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] }),
      [question(1)],
      fake.paseo,
    );
    await events.publish(
      [{ type: "worker.signal", workspaceId: WS, workerId: WORKER, requestKey: REQUEST, signal: "heavy", turnStart: "T0", alertKey: null, since: "T1" }],
      fake.paseo,
    );
    await orchestratorIdle(fake);
    expect(fake.sends.length).toBeGreaterThan(0);
    expect(new Set(fake.sends.map((sent) => sent.id))).toEqual(new Set([ORCHESTRATOR]));
  });
});

describe("the policy's scope (design §A.8 Scope, §B.2; change-007 C1)", () => {
  const THIRD_WS = "wks_3";
  const NONE_WS = "wks_4";
  const finished = (workspaceId: string): BmEvent => ({ type: "request.finished", workspaceId, requestId: REQUEST, managerId: MANAGER, at: at(5) });
  const stalled = (workspaceId: string): BmEvent => {
    const raised = alerts().raise({ workspaceId, kind: "request-stalled", subject: REQUEST });
    return { type: "request.stalled", workspaceId, requestKey: REQUEST, managerId: MANAGER, reason: "idle-unfinished", alertKey: raised.alert.key, since: raised.alert.since };
  };
  const signal = (workspaceId: string): BmEvent => ({ type: "worker.signal", workspaceId, workerId: WORKER, requestKey: REQUEST, signal: "heavy", turnStart: "T0", alertKey: null, since: "T1" });

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

  it("request.finished, request.stalled and worker.signal reach the Orchestrator for a project with a shadow or delegate cell, never for an all-owner one", async () => {
    inScope(WS, "shadow");
    inScope(OTHER_WS, "delegate");
    // Cells set back to owner are all-owner too.
    createAutonomyStore(home).set({ workspaceId: THIRD_WS, class: "scope", mode: "owner" }, clock.toISOString());
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const all = [WS, OTHER_WS, THIRD_WS, NONE_WS].flatMap((workspaceId) => [finished(workspaceId), stalled(workspaceId), signal(workspaceId)]);
    const keysOf = (workspaceIds: string[]) => all.filter((event) => workspaceIds.includes(event.workspaceId)).map(eventKeyOf);
    expect(await events.publish(all, fake.paseo)).toEqual({ status: "done", published: keysOf([WS, OTHER_WS]), skipped: keysOf([THIRD_WS, NONE_WS]) });
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    const lines = fake.sends[0]!.text.split("\n").slice(2);
    expect(lines).toHaveLength(6);
    expect(lines.filter((line) => line.includes(THIRD_WS) || line.includes(NONE_WS))).toEqual([]);
  });

  it("an all-owner project's events queue nothing and look for no Orchestrator", async () => {
    const fake = daemon();
    const events = bus();
    expect(await events.publish([finished(WS), stalled(WS), signal(WS)], fake.paseo)).toMatchObject({ status: "none", published: [] });
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();
    expect(fake.sends).toEqual([]);
  });

  it("drops a scoped event whose project fell back to all-owner before delivery: no message, no wake", async () => {
    inScope();
    inScope(OTHER_WS);
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const pending = [finished(WS), stalled(WS), signal(WS), finished(OTHER_WS)];
    expect((await events.publish(pending, fake.paseo)).published).toEqual(pending.map(eventKeyOf));
    // The owner returns every class of one project to owner, and sets the other's one cell back to owner.
    createAutonomyStore(home).reset(WS);
    createAutonomyStore(home).set({ workspaceId: OTHER_WS, class: "scope", mode: "owner" }, clock.toISOString());
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
    expect(createOrchestratorStore(home, { now: () => clock }).readWakes()).toEqual([]);
  });

  it("decision.opened follows its per-cell rule, not the policy's scope: a project in the scope does not make a question an event, a delegation to the Orchestrator does", async () => {
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    // In the scope by a shadow cell of another class, the challenger off: the question (reversible-technical, owner) wakes nobody; the finished step does.
    inScope();
    decisions().open(question(1));
    const record = turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] });
    expect(await events.turnRecorded(record, [question(1)], fake.paseo)).toEqual({ status: "done", published: [`request.finished:${WS}:${REQUEST}@${at(5)}`], skipped: [] });
    // The owner delegates reversible-technical to the Orchestrator: the next question asks it to decide.
    delegateToOrchestrator();
    decisions().open(question(2));
    expect((await events.turnRecorded(undefined, [question(2)], fake.paseo)).published).toEqual([`decision.opened:q:${REQUEST}:Q2`]);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2).map((line) => line.split(" — ")[0])).toEqual(["- request.finished", "- decision.opened"]);
    expect(isInEventScope({ type: "decision.opened", workspaceId: NONE_WS, requestId: null, decisionId: "q:x", askedBy: null, asks: "prediction" }, new Set())).toBe(true);
    // A question with an option only the owner may take wakes nobody, in the scope and delegated or not (X-4).
    const release = makeDecision({ id: `q:${REQUEST}:Q9`, workspaceId: WS, requestId: REQUEST });
    decisions().open(release);
    expect(await events.turnRecorded(undefined, [release], fake.paseo)).toMatchObject({ status: "none", published: [] });
  });
});

describe("the challenger's predictions (design §B.3, §B.9; change-007 C1)", () => {
  const OPENED_WITH_PREDICTIONS = { prediction: { recommended: { optionKey: "a" }, orchestrator: null } } satisfies Partial<Decision>;
  /** A Worker question opened by this build: its recommended prediction recorded, none of the Orchestrator's yet. */
  const predictable = (n: number, over: Partial<Decision> = {}) => question(n, { ...OPENED_WITH_PREDICTIONS, ...over });
  const challenger = (enabled: boolean, workspaceId = WS) => createAutonomyStore(home).setChallenger({ workspaceId, enabled });
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

  it("a project whose cells are all owner, with the challenger on, gets the prediction event: the policy scope does not hold it back", async () => {
    challenger(true);
    expect(eventScopeOf(home)).toEqual(new Set());
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    decisions().open(predictable(1));
    // A finished step of the same all-owner project is still out of the scope.
    const record = turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] });
    expect(await events.turnRecorded(record, [predictable(1)], fake.paseo)).toEqual({
      status: "done",
      published: [`decision.opened:q:${REQUEST}:Q1`],
      skipped: [`request.finished:${WS}:${REQUEST}@${at(5)}`],
    });
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([expect.stringContaining("with bm_predict, with your reason in one line. The owner sees it as your proposal")]);
    expect(events.wakeEventsOf(ORCHESTRATOR)).toEqual([expect.objectContaining({ decisionId: `q:${REQUEST}:Q1`, asks: "prediction" })]);
  });

  it("with the challenger off, a delegable question of an owner or shadow cell wakes nobody: no message, no wake", async () => {
    inScope();
    createAutonomyStore(home).set({ workspaceId: WS, class: "reversible-technical", mode: "shadow" }, clock.toISOString());
    const fake = daemon();
    const events = bus();
    decisions().open(predictable(1));
    expect(await events.turnRecorded(undefined, [predictable(1)], fake.paseo)).toMatchObject({ status: "none", published: [] });
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();
    expect(fake.sends).toEqual([]);
    expect(createOrchestratorStore(home, { now: () => clock }).readWakes()).toEqual([]);
  });

  it("drops a prediction that may no longer be made before delivery: challenger turned off, cell delegated, predicted already, or answered", async () => {
    challenger(true);
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    for (let n = 1; n <= 5; n += 1) decisions().open(predictable(n, n === 2 ? { class: "scope" } : {}));
    expect((await events.turnRecorded(undefined, [1, 2, 3, 4, 5].map((n) => predictable(n, n === 2 ? { class: "scope" } : {})), fake.paseo)).published).toHaveLength(5);
    // Before the Orchestrator is idle: the owner delegates scope, answers Q3; the Orchestrator predicted Q4 already.
    createAutonomyStore(home).set({ workspaceId: WS, class: "scope", mode: "delegate", confirmed: true }, clock.toISOString());
    decisions().transition(`q:${REQUEST}:Q3`, (current) => answerDecision(current, { via: "inbox", optionKey: "a", at: clock.toISOString() }), WS);
    decisions().transition(`q:${REQUEST}:Q4`, (current) => ({ ok: true, decision: { ...current, prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "a", reason: "r", at: clock.toISOString() } } } }), WS);
    await orchestratorIdle(fake);
    expect(fake.sends[0]!.text.split("\n").slice(2).map((line) => /decision (\S+),/.exec(line)?.[1])).toEqual([`q:${REQUEST}:Q1`, `q:${REQUEST}:Q5`]);

    // The challenger turned off before delivery: nothing is sent at all, and no wake is recorded for it.
    fake.byId(ORCHESTRATOR)!.status = "running";
    decisions().open(predictable(6));
    await events.turnRecorded(undefined, [predictable(6)], fake.paseo);
    challenger(false);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
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

  it("drops a decision asked of the Orchestrator once it may no longer be decided before delivery: answered, the cell set back, or reset", async () => {
    delegateToOrchestrator();
    delegateToOrchestrator(WS, "scope");
    delegateToOrchestrator(WS, "preference");
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const opened = [question(1), question(2), question(3, { class: "scope" }), question(4, { class: "preference" })];
    for (const decision of opened) decisions().open(decision);
    expect((await events.turnRecorded(undefined, opened, fake.paseo)).published).toHaveLength(4);
    // Before the Orchestrator is idle: the owner answers Q2, sets scope back to shadow and preference to owner.
    decisions().transition(`q:${REQUEST}:Q2`, (current) => answerDecision(current, { via: "inbox", optionKey: "a", at: clock.toISOString() }), WS);
    createAutonomyStore(home).set({ workspaceId: WS, class: "scope", mode: "shadow" }, clock.toISOString());
    createAutonomyStore(home).set({ workspaceId: WS, class: "preference", mode: "owner" }, clock.toISOString());
    await orchestratorIdle(fake);
    expect(fake.sends[0]!.text.split("\n").slice(2).map((line) => /decision (\S+),/.exec(line)?.[1])).toEqual([`q:${REQUEST}:Q1`]);

    // The owner returns every class to owner before delivery: nothing is sent, and no wake is recorded for it.
    fake.byId(ORCHESTRATOR)!.status = "running";
    decisions().open(question(5));
    await events.turnRecorded(undefined, [question(5)], fake.paseo);
    createAutonomyStore(home).reset(WS);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("a decision that waits for bm_decide and gets none stays open in the Inbox for the owner: nothing times out into an answer", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(undefined, [question(1)], fake.paseo);
    expect(fake.sends).toHaveLength(1);
    // The Orchestrator's turn ends without bm_decide; a day passes, and the Orchestrator ends more turns.
    clock = new Date(clock.getTime() + 60_000);
    await orchestratorIdle(fake);
    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    await orchestratorIdle(fake);
    expect(decisions().get(`q:${REQUEST}:Q1`, WS)).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(decisions().list({ statuses: ["open"] }).map((decision) => decision.id)).toEqual([`q:${REQUEST}:Q1`]);
    // Told once: the same decision is not told again.
    expect(await events.turnRecorded(undefined, [question(1)], fake.paseo)).toMatchObject({ status: "none" });
    expect(fake.sends).toHaveLength(1);
  });

  it("decisionsOpened: a fallback incident's decision opened outside a turn follows the same rule", async () => {
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const incident = makeDecision({ id: "f:fb-1", workspaceId: WS, requestId: null, askedBy: { role: "plugin", agentId: null }, options: LOCAL_OPTIONS, ...OPENED_WITH_PREDICTIONS });
    decisions().open(incident);
    // Nothing delegated and no challenger: nothing.
    expect(await events.decisionsOpened([incident], fake.paseo)).toMatchObject({ status: "none", published: [] });
    delegateToOrchestrator(WS, "environment");
    expect(await events.decisionsOpened([incident], fake.paseo)).toMatchObject({ status: "done", published: ["decision.opened:f:fb-1"] });
    await orchestratorIdle(fake);
    expect(fake.sends[0]!.text.split("\n").slice(2)).toEqual([expect.stringMatching(/^- decision\.opened — project wks_1, request none, decision f:fb-1\. A decision is asked: .* bm_decide /)]);
    expect(events.wakeEventsOf(ORCHESTRATOR)).toEqual([expect.objectContaining({ decisionId: "f:fb-1", asks: "decision" })]);
  });
});

describe("each wake recorded for A-7 (evaluation design §4)", () => {
  const wakes = () => createOrchestratorStore(home, { now: () => clock }).readWakes();

  it("a delivered BM-EVENTS message is one wake: the Orchestrator, the time, its projects and events, no text", async () => {
    delegateToOrchestrator();
    delegateToOrchestrator(OTHER_WS);
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    decisions().open(question(1));
    decisions().open(question(2, { id: `q:${REQUEST}:Q2`, workspaceId: OTHER_WS }));
    await events.turnRecorded(undefined, [question(1), question(2, { workspaceId: OTHER_WS })], fake.paseo);
    // Queued, not yet sent: no wake.
    expect(wakes()).toEqual([]);
    clock = new Date(clock.getTime() + 60_000);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(wakes()).toEqual([{ orchestratorId: ORCHESTRATOR, at: clock.toISOString(), endedAt: null, workspaceIds: [WS, OTHER_WS].sort(), events: 2 }]);
  });

  it("a batch whose every event settled is no wake", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(undefined, [question(1)], fake.paseo);
    decisions().transition(`q:${REQUEST}:Q1`, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: clock.toISOString() }));
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
    expect(wakes()).toEqual([]);
  });

  it("the Orchestrator turn that closes a wake records its tokens on the wake (change-007 C6)", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    // The snapshot the Orchestrator's refetch returns at its turn end (Claude, measured 2026-09-30).
    const lastUsage = { inputTokens: 9, cachedInputTokens: 41_200, outputTokens: 350, totalCostUsd: 1.27, contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 44_000 };
    const refetch = vi.fn(async () => ({ entries: [], agent: { id: ORCHESTRATOR, lastUsage } }));
    const paseo = { agents: { ...fake.paseo.agents, ref: (id: string) => ({ ...fake.paseo.agents.ref(id), timeline: { refetch } }) } };
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(undefined, [question(1)], paseo);
    expect(wakes()).toHaveLength(1);
    expect(wakes()[0]).not.toHaveProperty("usage");
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
      { orchestratorId: ORCHESTRATOR, at: expect.any(String), endedAt: clock.toISOString(), workspaceIds: [WS], events: 1, usage: { inputTokens: 9, cachedInputTokens: 41_200, outputTokens: 350 } },
    ]);
    // The owner talking to it later: no open wake, nothing read or written.
    await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, paseo);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a wake whose closing turn's snapshot cannot be read still ends, with its tokens unknown", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(undefined, [question(1)], fake.paseo);
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
    decisions().open(question(2));
    await events.turnRecorded(undefined, [question(2)], fake.paseo);
    await orchestratorIdle(fake);
    expect(wakes()[1]).toMatchObject({ endedAt: clock.toISOString(), usage: null });
  });

  it("the Orchestrator's next turn end ends its oldest open wake, before the next batch goes; another agent's turn end does not", async () => {
    delegateToOrchestrator();
    const fake = daemon();
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(undefined, [question(1)], fake.paseo);
    expect(wakes()).toHaveLength(1);
    // A second event waits for the Orchestrator's running turn.
    decisions().open(question(2));
    await events.turnRecorded(undefined, [question(2)], fake.paseo);
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

describe("a synthetic day of events (design §A.8 exit: at most 20 % of wakes with no pending actionable event)", () => {
  it("batches a busy day into few wakes, none of them without a pending event", async () => {
    delegateToOrchestrator();
    const events = bus();
    /** Workers whose failing turn is still going. */
    const failingTurns = new Set<string>();
    /** True while the event a line names still needs the Orchestrator, judged by the day's own model. */
    const pending = (line: string): boolean => {
      const decision = /decision (q:[^,\s]+)/.exec(line)?.[1];
      if (decision !== undefined) return ["open", "needs-confirmation"].includes(decisions().get(decision, WS)?.status ?? "");
      const stalled = /request\.stalled \S+ — project \S+, request ([^,\s]+)/.exec(line)?.[1];
      if (stalled !== undefined) return alerts().isOpen(alertKeyOf("request-stalled", WS, stalled));
      const worker = /worker\.signal failing — project \S+, Worker ([^,\s]+)/.exec(line)?.[1];
      if (worker !== undefined) return failingTurns.has(worker);
      // A judgement wake (design §G.4): advice is always something to look at.
      return line.startsWith("- request.finished") || line.startsWith("- advice.due");
    };
    /** Each wake: a message sent, and whether any event in it was still pending when it went out. */
    const wakes: boolean[] = [];
    const fake = daemon(true, (text) => wakes.push(text.split("\n").filter((line) => line.startsWith("- ")).some(pending)));
    const start = clock.getTime();
    const plan = new Map<number, Array<() => Promise<unknown> | unknown>>();
    const on = (m: number, step: () => Promise<unknown> | unknown) => plan.set(m, [...(plan.get(m) ?? []), step]);
    let published = 0;
    const count = async (result: Promise<{ published: string[] }>) => {
      published += (await result).published.length;
    };

    // Every 20 minutes a Worker asks — every 2 minutes in the busy hours 09:00–11:00 —; the owner answers two of three within 4 minutes, in the Inbox.
    for (let m = 5, n = 1; m < 24 * 60; m += m >= 60 && m < 180 ? 2 : 20, n += 1) {
      const decision = question(n);
      on(m, () => {
        decisions().open(decision);
        return count(events.turnRecorded(undefined, [decision], fake.paseo));
      });
      if (n % 3 !== 0) on(m + 4, () => decisions().transition(decision.id, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: clock.toISOString() }), WS));
    }
    // Every 90 minutes a step finishes.
    for (let m = 45; m < 24 * 60; m += 90) {
      on(m, () =>
        count(events.turnRecorded(turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: clock.toISOString(), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] }), [], fake.paseo)),
      );
    }
    // Every 2 hours a request stalls; half of the stalls end by themselves 3 minutes later.
    for (let m = 60, k = 0; m < 24 * 60; m += 120, k += 1) {
      const subject = `req-stall-${k}`;
      on(m, () => {
        const raised = alerts().raise({ workspaceId: WS, kind: "request-stalled", subject });
        return count(
          events.publish(
            [{ type: "request.stalled", workspaceId: WS, requestKey: subject, managerId: MANAGER, reason: "idle-unfinished", alertKey: raised.alert.key, since: raised.alert.since }],
            fake.paseo,
          ),
        );
      });
      if (k % 2 === 0) on(m + 3, () => alerts().clear(alertKeyOf("request-stalled", WS, subject)));
    }
    // Every 3 hours a Worker keeps failing; its turn ends 5 minutes later.
    for (let m = 100, k = 0; m < 24 * 60; m += 180, k += 1) {
      const worker = `${WORKER}-${k}`;
      on(m, () => {
        failingTurns.add(worker);
        return count(
          events.publish(
            [{ type: "worker.signal", workspaceId: WS, workerId: worker, requestKey: REQUEST, signal: "failing", turnStart: clock.toISOString(), alertKey: null, since: clock.toISOString() }],
            fake.paseo,
          ),
        );
      });
      on(m + 5, () => {
        failingTurns.delete(worker);
        events.workerTurnEnded(worker);
      });
    }

    // The Orchestrator works 6 minutes on each message it gets.
    let busyUntil = Number.POSITIVE_INFINITY;
    for (let m = 0; m < 24 * 60; m += 1) {
      clock = new Date(start + m * 60_000);
      const sent = fake.sends.length;
      for (const step of plan.get(m) ?? []) await step();
      if (fake.byId(ORCHESTRATOR)!.status === "running" && m >= busyUntil) await orchestratorIdle(fake);
      if (fake.sends.length > sent) busyUntil = m + 6;
    }

    const idle = wakes.filter((actionable) => !actionable).length;
    expect(published).toBeGreaterThan(90);
    expect(wakes).toHaveLength(fake.sends.length);
    // Batching and dropping: fewer wakes than events, and at most 20 % of them without a pending event.
    expect(wakes.length).toBeLessThan(published);
    expect(idle / wakes.length).toBeLessThanOrEqual(0.2);
    for (const message of fake.sends) expect(message.text.split("\n").filter((line) => line.startsWith("- ")).length).toBeGreaterThan(0);
  });
});

describe("advice.due: after every N finished requests of a project (design §G.4, §G.7; bead t9lm.25)", () => {
  /** A Manager turn that recorded the Worker's `finished` report of `requestId`, clean (no work left: no request.finished). */
  const finishedTurn = (requestId: string, minute: number, over: Partial<Parameters<typeof turn>[0]> = {}) =>
    turn({ workspaceId: WS, requestId, reports: [report({ at: at(minute), requestId, phase: "finished", buildAndTests: "npm test passed" })], ...over });
  const cadence = (value: number) => createCoordinationStore(home).set({ key: "advice.everyFinished", value });
  const request = (n: number) => `req-20260929T0${String(n).padStart(5, "0")}Z`;
  const adviceLines = (fake: ReturnType<typeof daemon>) =>
    fake.sends.flatMap((sent) => sent.text.split("\n").filter((line) => line.startsWith("- advice.due")));

  it("has its own key and line: the project, the count, bm_findings and bm_ask_owner; it is not held back by the policy's scope", () => {
    const event: BmEvent = { type: "advice.due", workspaceId: WS, finished: 5, at: at(9) };
    expect(eventKeyOf(event)).toBe(`advice.due:${WS}@${at(9)}`);
    expect(eventLineOf(event)).toBe(
      `- advice.due — project ${WS}, 5 requests finished since the last advice. Read its figures with bm_findings; for each finding worth acting on, ask the owner with bm_ask_owner, one option carrying the prepared change. With none worth it, keep a note with bm_note.`,
    );
    // Every project gets its advice: an all-owner project included (the empty scope).
    expect(isInEventScope(event, new Set())).toBe(true);
  });

  it("counts one key per finished request of a Manager turn; a Worker's turn, a blocked report or no report counts nothing", () => {
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
    expect(finishedRequestKeysOf({ ...record, role: "worker" })).toBeNull();
    expect(finishedRequestKeysOf(turn({ workspaceId: WS }))).toBeNull();
    expect(finishedRequestKeysOf(undefined)).toBeNull();
  });

  it("after N finished requests of an all-owner project, one advice.due reaches the Orchestrator, and the count starts again", async () => {
    cadence(3);
    const fake = daemon();
    const events = bus();
    for (const n of [1, 2]) expect(await events.turnRecorded(finishedTurn(request(n), n), [], fake.paseo)).toMatchObject({ status: "none" });
    expect(fake.sends).toEqual([]);
    expect(createAdviceStore(home).read()[WS]).toMatchObject({ counted: [request(1), request(2)], dueAt: null });

    const third = await events.turnRecorded(finishedTurn(request(3), 3), [], fake.paseo);
    expect(third).toMatchObject({ status: "done", published: [`advice.due:${WS}@${at(3)}`] });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.id).toBe(ORCHESTRATOR);
    expect(adviceLines(fake)).toEqual([expect.stringContaining(`- advice.due — project ${WS}, 3 requests finished since the last advice.`)]);
    // Reset in the same write: nothing counted, and when it was due.
    expect(createAdviceStore(home).read()[WS]).toEqual({ counted: [], at: at(3), dueAt: at(3) });
    // One wake of the Orchestrator, recorded for A-7 like any other.
    expect(createOrchestratorStore(home, { now: () => clock }).readWakes()).toMatchObject([{ workspaceIds: [WS], events: 1 }]);
  });

  it("once per count: a request finishing again, or the same turn recorded again, counts once; the next advice needs N more", async () => {
    cadence(2);
    const fake = daemon();
    const events = bus();
    await events.turnRecorded(finishedTurn(request(1), 1), [], fake.paseo);
    // The same request finishes again, and the same turn is read again (reused turn ids): still one.
    await events.turnRecorded(finishedTurn(request(1), 2), [], fake.paseo);
    await events.turnRecorded(finishedTurn(request(1), 1), [], fake.paseo);
    expect(fake.sends).toEqual([]);
    await events.turnRecorded(finishedTurn(request(2), 3), [], fake.paseo);
    expect(adviceLines(fake)).toHaveLength(1);
    // The Orchestrator is idle again; the next count starts from zero (a request of the last cycle counts anew).
    await orchestratorIdle(fake);
    await events.turnRecorded(finishedTurn(request(2), 4), [], fake.paseo);
    expect(adviceLines(fake)).toHaveLength(1);
    await events.turnRecorded(finishedTurn(request(3), 5), [], fake.paseo);
    expect(adviceLines(fake)).toHaveLength(2);
    expect(adviceLines(fake)[1]).toContain("2 requests finished since the last advice");
  });

  it("none with N = 0: nothing is counted, nothing written, nothing sent", async () => {
    cadence(0);
    const fake = daemon();
    const events = bus();
    for (let n = 1; n <= 12; n += 1) await events.turnRecorded(finishedTurn(request(n), n), [], fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(createAdviceStore(home).read()).toEqual({});
  });

  it("the default cadence is 5, with no Settings file", async () => {
    const fake = daemon();
    const events = bus();
    for (let n = 1; n <= 4; n += 1) await events.turnRecorded(finishedTurn(request(n), n), [], fake.paseo);
    expect(adviceLines(fake)).toEqual([]);
    await events.turnRecorded(finishedTurn(request(5), 5), [], fake.paseo);
    expect(adviceLines(fake)).toEqual([expect.stringContaining("5 requests finished since the last advice")]);
  });

  it("is dropped at delivery once the owner turned advice off, and batched with the turn's other events otherwise", async () => {
    cadence(1);
    delegateToOrchestrator();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    // A finished request with work left in a project in the scope: request.finished and advice.due in one message.
    decisions().open(question(1));
    const withWork = turn({ workspaceId: WS, requestId: REQUEST, reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] })] });
    await events.turnRecorded(withWork, [question(1)], fake.paseo);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text.split("\n").slice(2).map((line) => line.split(" — ")[0])).toEqual(["- decision.opened", "- request.finished", "- advice.due"]);

    // Queued while the Orchestrator runs, then advice turned off before its idle moment: nothing goes.
    fake.byId(ORCHESTRATOR)!.status = "running";
    await events.turnRecorded(finishedTurn(request(7), 7), [], fake.paseo);
    cadence(0);
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
  });

  it("without an Orchestrator the count still starts again: one advice per count, never a backlog", async () => {
    cadence(2);
    const fake = daemon(false);
    const events = bus();
    await events.turnRecorded(finishedTurn(request(1), 1), [], fake.paseo);
    expect(await events.turnRecorded(finishedTurn(request(2), 2), [], fake.paseo)).toMatchObject({ status: "no-orchestrator" });
    expect(createAdviceStore(home).read()[WS]).toMatchObject({ counted: [], dueAt: at(2) });
    expect(fake.sends).toEqual([]);
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

describe("a finished-unverified request wakes the Orchestrator as work left (design §C.3, §A.8; bead 7gxw.4)", () => {
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
    // Only a Manager's record, only a finished report.
    expect(requestFinishedEventsOf({ ...record, role: "worker" }, () => true)).toEqual([]);
    expect(requestFinishedEventsOf(managerTurn(cleanFinish({ phase: "bead-implemented" })), () => true)).toEqual([]);
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

  it("reads nothing for a Worker's turn, or a Manager's without a finish, and a store it cannot read changes nothing", async () => {
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

  it("through the bus: an unverified finish of a project in the scope reaches the Orchestrator in one BM-EVENTS line", async () => {
    inScope();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const record = managerTurn();
    expect(await events.turnRecorded(record, [], fake.paseo, () => true)).toEqual({ status: "done", published: [`request.finished:${WS}:${REQUEST}@${at(5)}`], skipped: [] });
    // The same report again (a reload replaying the turn): the dedupe key holds.
    expect(await events.turnRecorded(record, [], fake.paseo, () => true)).toMatchObject({ status: "none", published: [] });
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.text).toContain("finished — unverified");
    // Verified and clean: no wake at all.
    expect(await bus().turnRecorded(managerTurn(cleanFinish({ at: at(7) })), [], fake.paseo, () => false)).toMatchObject({ status: "none", published: [] });
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
  const thresholdLines = (fake: ReturnType<typeof daemon>) => fake.sends.flatMap((sent) => sent.text.split("\n").filter((line) => line.startsWith("- threshold.crossed")));
  const compactions = () => createCompactionStore(home, { now: () => clock });
  /** One compaction of the Worker whose /compact went out: its cycle moves on by one. */
  const sentCompaction = () => {
    const added = compactions().add({ workspaceId: WS, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: "" });
    compactions().update(added.id, (current) => ({ ...current, state: "done", sentAt: clock.toISOString(), endedAt: clock.toISOString() }));
  };
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

  it("one per cycle: a second crossing turn of the same cycle wakes nobody; after its compaction, the next crossing is a new cycle", async () => {
    const fake = daemon();
    const events = bus();
    expect(await events.turnRecorded(crossing(5), [], fake.paseo)).toMatchObject({ status: "done", published: [`threshold.crossed:compact:${WORKER}#0`] });
    expect(await events.turnRecorded(crossing(6), [], fake.paseo)).toMatchObject({ status: "none", skipped: [`threshold.crossed:compact:${WORKER}#0`] });
    expect(thresholdLines(fake)).toHaveLength(1);
    // Its compaction: the /compact went out, and the compaction's own turn raises nothing (its figure understates).
    sentCompaction();
    expect(await events.turnRecorded(compactedTurn(7), [], fake.paseo)).toMatchObject({ status: "none" });
    await orchestratorIdle(fake);
    expect(await events.turnRecorded(crossing(8), [], fake.paseo)).toMatchObject({ status: "done", published: [`threshold.crossed:compact:${WORKER}#1`] });
    expect(thresholdLines(fake)).toHaveLength(2);
    // One Orchestrator wake each, recorded for A-7 like any other.
    expect(createOrchestratorStore(home, { now: () => clock }).readWakes()).toMatchObject([{ workspaceIds: [WS], events: 1 }, { workspaceIds: [WS], events: 1 }]);
  });

  it("none while compaction is off, at compact.maxPerAgent, or while a compaction of it is pending", async () => {
    const fake = daemon();
    createCoordinationStore(home).set({ key: "compact.enabled", value: false });
    expect(await bus().turnRecorded(crossing(5), [], fake.paseo)).toMatchObject({ status: "none", published: [] });
    createCoordinationStore(home).set({ key: "compact.enabled", value: true });
    createCoordinationStore(home).set({ key: "compact.maxPerAgent", value: 1 });
    sentCompaction();
    expect(await bus().turnRecorded(crossing(6), [], fake.paseo)).toMatchObject({ status: "none", published: [] });
    createCoordinationStore(home).set({ key: "compact.maxPerAgent", value: 2 });
    compactions().add({ workspaceId: WS, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: "" });
    expect(await bus().turnRecorded(crossing(7), [], fake.paseo)).toMatchObject({ status: "none", published: [] });
    expect(fake.sends).toEqual([]);
  });

  it("is dropped at delivery once the agent compacted, a compaction of it was requested, or compaction was turned off", async () => {
    const cases: Array<[string, (events: EventBus, fake: ReturnType<typeof daemon>) => Promise<unknown> | void]> = [
      ["the agent compacted", (events, fake) => events.turnRecorded(compactedTurn(9), [], fake.paseo)],
      ["a compaction was requested", () => void compactions().add({ workspaceId: WS, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: "" })],
      ["compaction was turned off", () => void createCoordinationStore(home).set({ key: "compact.enabled", value: false })],
    ];
    for (const [label, meanwhile] of cases) {
      rmSync(home, { recursive: true, force: true });
      const fake = daemon();
      fake.byId(ORCHESTRATOR)!.status = "running";
      const events = bus();
      expect(await events.turnRecorded(crossing(5), [], fake.paseo), label).toMatchObject({ status: "done", published: [`threshold.crossed:compact:${WORKER}#0`] });
      await meanwhile(events, fake);
      await orchestratorIdle(fake);
      expect(fake.sends, label).toEqual([]);
    }
    // Nothing happened meanwhile: it goes.
    rmSync(home, { recursive: true, force: true });
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    await events.turnRecorded(crossing(5), [], fake.paseo);
    await orchestratorIdle(fake);
    expect(thresholdLines(fake)).toHaveLength(1);
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
  /** The collector writes a turn before its onRecorded: the bus reads the request's tokens from the store. */
  const recorded = async (record: ReturnType<typeof turn>) => {
    await appendRecord({ tracesDir: join(home, "traces") }, record);
    return record;
  };
  const handoffLines = (fake: ReturnType<typeof daemon>) => fake.sends.flatMap((sent) => sent.text.split("\n").filter((line) => line.startsWith("- threshold.crossed handoff")));
  const handoffs = () => createHandoffStore(home, { now: () => clock });
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

  it("one per cycle, from the request's tokens in the store; after a handoff only the turns since count", async () => {
    const fake = daemon();
    const events = bus();
    expect(await events.turnRecorded(await recorded(workerTurn(5, 100_000_000)), [], fake.paseo)).toMatchObject({ status: "none" });
    expect(await events.turnRecorded(await recorded(workerTurn(6, 60_000_000)), [], fake.paseo)).toMatchObject({ status: "done", published: [`threshold.crossed:handoff:${REQUEST}#0`] });
    expect(await events.turnRecorded(await recorded(workerTurn(7, 1_000_000)), [], fake.paseo)).toMatchObject({ status: "none", skipped: [`threshold.crossed:handoff:${REQUEST}#0`] });
    expect(handoffLines(fake)).toHaveLength(1);
    // Handed over at minute 8: the successor's turns count from there.
    const done = handoffs().add({ workspaceId: WS, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "" });
    handoffs().update(done.id, (entry) => ({ ...entry, state: "done", successorId: "agent-successor", successorAt: at(8), endedAt: at(8) }));
    await orchestratorIdle(fake);
    const successor = (minute: number, read: number) => workerTurn(minute, read, { agentId: "agent-successor", turnId: `s-${minute}` });
    expect(await events.turnRecorded(await recorded(successor(9, 100_000_000)), [], fake.paseo)).toMatchObject({ status: "none" });
    expect(await events.turnRecorded(await recorded(successor(10, 60_000_000)), [], fake.paseo)).toMatchObject({ status: "done", published: [`threshold.crossed:handoff:${REQUEST}#1`] });
    expect(handoffLines(fake)).toHaveLength(2);
  });

  it("is dropped at delivery once handoff was turned off, a handoff of the request was requested, or the request finished", async () => {
    const cases: Array<[string, () => Promise<unknown> | void]> = [
      ["handoff was turned off", () => void createCoordinationStore(home).set({ key: "handoff.enabled", value: false })],
      ["a handoff was requested", () => void handoffs().add({ workspaceId: WS, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "" })],
      ["the request finished", () => recorded(workerTurn(9, 1_000, { reports: [report({ requestId: REQUEST, at: at(9), phase: "finished" })] }))],
    ];
    for (const [label, meanwhile] of cases) {
      rmSync(home, { recursive: true, force: true });
      clearTraceStoreCache();
      const fake = daemon();
      fake.byId(ORCHESTRATOR)!.status = "running";
      const events = bus();
      expect(await events.turnRecorded(await recorded(workerTurn(5, 160_000_000)), [], fake.paseo), label).toMatchObject({ status: "done", published: [`threshold.crossed:handoff:${REQUEST}#0`] });
      await meanwhile();
      await orchestratorIdle(fake);
      expect(handoffLines(fake), label).toEqual([]);
    }
    // Nothing happened meanwhile: it goes.
    rmSync(home, { recursive: true, force: true });
    clearTraceStoreCache();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    await events.turnRecorded(await recorded(workerTurn(5, 160_000_000)), [], fake.paseo);
    await orchestratorIdle(fake);
    expect(handoffLines(fake)).toHaveLength(1);
  });
});

describe("writers.observed: two agents wrote one file in overlapping turns (design §F.1, §F.3; bead i8fc.1)", () => {
  const OTHER_WORKER = "agent-worker-2";
  const raiseFile = (workspaceId = WS, file = "src/math.js") => alerts().raise({ workspaceId, kind: "writers-observed", subject: file, detail: `${file}: two Workers` });
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

  it("is published once and delivered in the BM-EVENTS batch of the Orchestrator's idle moment", async () => {
    inScope();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    decisions().open(question(1));
    delegateToOrchestrator();
    const event = observed(raiseFile().alert.key);
    await events.turnRecorded(undefined, [question(1)], fake.paseo);
    expect(await events.publish([event], fake.paseo)).toEqual({ status: "done", published: [eventKeyOf(event)], skipped: [] });
    expect(await events.publish([event], fake.paseo)).toEqual({ status: "none", published: [], skipped: [eventKeyOf(event)] });
    await orchestratorIdle(fake);
    expect(fake.sends).toHaveLength(1);
    const lines = fake.sends[0]!.text.split("\n");
    expect(lines[0]).toBe("BM-EVENTS");
    expect(lines.slice(2).map((line) => line.split(" — ")[0])).toEqual(["- decision.opened", "- writers.observed"]);
  });

  it("is dropped when settled before delivery: its file's alert cleared (the later request finished), or its project left the scope", async () => {
    inScope();
    const fake = daemon();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    const raised = raiseFile();
    await events.publish([observed(raised.alert.key)], fake.paseo);
    alerts().clear(raised.alert.key);
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);

    fake.byId(ORCHESTRATOR)!.status = "running";
    const again = raiseFile(WS, "src/other.js");
    await events.publish([observed(again.alert.key, WS, "src/other.js")], fake.paseo);
    createAutonomyStore(home).reset(WS);
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
  });

  it("an all-owner project's collision stays an Inbox alert only: nothing is queued", async () => {
    const fake = daemon();
    const raised = raiseFile();
    expect(await bus().publish([observed(raised.alert.key)], fake.paseo)).toMatchObject({ status: "none", published: [] });
    expect(fake.sends).toEqual([]);
    expect(alerts().isOpen(raised.alert.key)).toBe(true);
  });
});
