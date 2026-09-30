import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import {
  EVENTS_BATCH,
  EVENT_TYPES,
  createEventBus,
  decisionOpenedEventsOf,
  eventKeyOf,
  eventLineOf,
  eventsMessageOf,
  requestFinishedEventsOf,
  workLeftOf,
  type BmEvent,
  type EventBus,
} from "../plugin/server/event-bus";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { EVENTS_NOTICE_MARKER, isPluginNotice, noticeMarkerOf } from "../plugin/server/notices";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { alertKeyOf } from "../plugin/shared/alerts";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";
import { MANAGER, WORKER, at, report, turn } from "./fixtures/orchestrator-traces";

/**
 * The event bus to the Orchestrator (autonomy design §A.8, REQ-115 b): typed
 * events with dedupe keys; Autopilot projects only; every event pending at the
 * Orchestrator's idle moment delivered as ONE `BM-EVENTS` message through the
 * notice queue's batch kind; an event dropped when its subject settled before
 * delivery; nothing ever sent to the owner or another agent; and a synthetic
 * day of events that leaves at most 20 % of the Orchestrator's wakes without
 * a pending actionable event. A fake Paseo SDK, a private notice queue and a
 * temporary data folder — never the real HOME or a daemon.
 */

const WS = "wks_1";
const OTHER_WS = "wks_2";
const ORCHESTRATOR = "agent-orchestrator";
const REQUEST = "req-20260929T073348Z";

interface FakeAgent {
  id: string;
  provider: string;
  status: string;
  workspaceId: string;
  labels: Record<string, string>;
  createdAt: string;
}

let root: string;
let home: string;
let clock: Date;
let queue: NoticeQueue;

/** The current Orchestrator and one Manager; `onSend` sees each message as it goes out. */
function fakePaseo(withOrchestrator = true, onSend: (text: string) => void = () => {}) {
  const agents: FakeAgent[] = [
    { id: MANAGER, provider: "bm-manager", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" }, createdAt: clock.toISOString() },
  ];
  if (withOrchestrator) {
    agents.push({
      id: ORCHESTRATOR,
      provider: "bm-orchestrator/claude-opus-5-5",
      status: "idle",
      workspaceId: "wks-own",
      labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
      createdAt: clock.toISOString(),
    });
  }
  const sends: Array<{ id: string; text: string; at: string }> = [];
  const byId = (id: string) => agents.find((entry) => entry.id === id);
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((agent) => ({ agent: { ...agent } })) })),
      ref: vi.fn((id: string) => ({
        refresh: async () => {
          const found = byId(id);
          return { agent: found === undefined ? null : { id, status: found.status, archivedAt: null } };
        },
        send: async (text: string) => {
          onSend(text);
          sends.push({ id, text, at: clock.toISOString() });
          const found = byId(id);
          if (found !== undefined) found.status = "running";
        },
      })),
    },
  };
  return { paseo, sends, byId };
}

function bus(): EventBus {
  return createEventBus({ home: () => home, queue, now: () => clock, log: () => {} });
}

const autopilotOn = (workspaceId = WS) => createOrchestratorStore(home, { now: () => clock }).setAutopilot(workspaceId, true, "tab");
const decisions = () => createDecisionStore(home, { log: () => {} });
const alerts = () => createAlertStore(home, { now: () => clock });
const orchestratorIdle = async (fake: ReturnType<typeof fakePaseo>) => {
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
    expect(EVENT_TYPES).toEqual(["decision.opened", "request.finished", "request.stalled", "worker.signal"]);
    expect(eventKeyOf({ type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: WORKER })).toBe(
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
    expect(EVENTS_BATCH.compose(["- x"])).toContain("1 event ");
    // A plugin notice: never the owner's words, nor the owner's approval.
    expect(isPluginNotice(message)).toBe(true);
    expect(noticeMarkerOf(message)).toBe("BM-EVENTS");
  });

  it("the retired notices are gone: BM-STALL and BM-EVENT are no plugin notices any more", () => {
    expect(isPluginNotice("BM-STALL idle-unfinished")).toBe(false);
    expect(isPluginNotice("BM-EVENT question")).toBe(false);
    expect(noticeMarkerOf("BM-EVENT worker-signal stuck")).toBeNull();
  });

  it("takes decision.opened from new Worker questions only, and request.finished from a Manager's finished reports", () => {
    expect(decisionOpenedEventsOf([question(1), question(2, { status: "answered" }), makeDecision({ id: "o:1" }), makeDecision({ id: "f:1" })])).toEqual([
      { type: "decision.opened", workspaceId: WS, requestId: REQUEST, decisionId: `q:${REQUEST}:Q1`, askedBy: "agent-worker" },
    ]);
    const record = turn({
      workspaceId: WS,
      requestId: REQUEST,
      reports: [report({ at: at(5), requestId: REQUEST, phase: "finished", beadsReady: ["bd-1"] }), report({ at: at(6), requestId: null, phase: "blocked" })],
    });
    expect(requestFinishedEventsOf(record)).toEqual([{ type: "request.finished", workspaceId: WS, requestId: REQUEST, managerId: MANAGER, at: at(5) }]);
    expect(requestFinishedEventsOf({ ...record, role: "worker" })).toEqual([]);
    expect(requestFinishedEventsOf(undefined)).toEqual([]);
  });

  it("wakes only for a judgement: a question with an option that needs the owner's confirmation waits for the owner (X-4)", () => {
    // The default fixture asks about push and publish: the owner's alone.
    expect(decisionOpenedEventsOf([makeDecision({ id: `q:${REQUEST}:Q9`, workspaceId: WS, requestId: REQUEST })])).toEqual([]);
    const oneRelease = question(3, { options: [...LOCAL_OPTIONS, { key: "c", label: "Deploy", recommended: false, effects: ["deploy"] }] });
    expect(decisionOpenedEventsOf([oneRelease])).toEqual([]);
    expect(decisionOpenedEventsOf([question(4)]).map((event) => event.decisionId)).toEqual([`q:${REQUEST}:Q4`]);
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
    autopilotOn();
    const fake = fakePaseo();
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
    autopilotOn();
    const fake = fakePaseo();
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
    autopilotOn();
    const fake = fakePaseo();
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

  it("publishes only for a project with Autopilot on, and drops an event whose project left Autopilot before delivery", async () => {
    autopilotOn();
    const fake = fakePaseo();
    const events = bus();
    decisions().open(question(1, { workspaceId: OTHER_WS }));
    expect(await events.turnRecorded(undefined, [question(1, { workspaceId: OTHER_WS })], fake.paseo)).toMatchObject({ status: "none", published: [] });
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();

    fake.byId(ORCHESTRATOR)!.status = "running";
    decisions().open(question(2));
    expect(await events.turnRecorded(undefined, [question(2)], fake.paseo)).toMatchObject({ status: "done", published: [`decision.opened:q:${REQUEST}:Q2`] });
    createOrchestratorStore(home, { now: () => clock }).setAutopilot(WS, false);
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
  });

  it("publishes each key once", async () => {
    autopilotOn();
    const fake = fakePaseo();
    const events = bus();
    decisions().open(question(1));
    expect((await events.turnRecorded(undefined, [question(1)], fake.paseo)).published).toHaveLength(1);
    await orchestratorIdle(fake);
    expect(await events.turnRecorded(undefined, [question(1)], fake.paseo)).toMatchObject({ status: "none", skipped: [`decision.opened:q:${REQUEST}:Q1`] });
    expect(fake.sends).toHaveLength(1);
  });

  it("without an Orchestrator, or before a Paseo handle, nothing is queued and nothing is created", async () => {
    autopilotOn();
    const fake = fakePaseo(false);
    const events = bus();
    decisions().open(question(1));
    expect(await events.turnRecorded(undefined, [question(1)])).toMatchObject({ status: "no-paseo" });
    expect(await events.turnRecorded(undefined, [question(2)], fake.paseo)).toMatchObject({ status: "no-orchestrator" });
    expect(fake.sends).toEqual([]);
  });

  it("never messages the owner or another agent: every send goes to the Orchestrator", async () => {
    autopilotOn();
    const fake = fakePaseo();
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

describe("each wake recorded for A-7 (evaluation design §4)", () => {
  const wakes = () => createOrchestratorStore(home, { now: () => clock }).readWakes();

  it("a delivered BM-EVENTS message is one wake: the Orchestrator, the time, its projects and events, no text", async () => {
    autopilotOn();
    autopilotOn(OTHER_WS);
    const fake = fakePaseo();
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
    autopilotOn();
    const fake = fakePaseo();
    fake.byId(ORCHESTRATOR)!.status = "running";
    const events = bus();
    decisions().open(question(1));
    await events.turnRecorded(undefined, [question(1)], fake.paseo);
    decisions().transition(`q:${REQUEST}:Q1`, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: clock.toISOString() }));
    await orchestratorIdle(fake);
    expect(fake.sends).toEqual([]);
    expect(wakes()).toEqual([]);
  });

  it("the Orchestrator's next turn end ends its oldest open wake, before the next batch goes; another agent's turn end does not", async () => {
    autopilotOn();
    const fake = fakePaseo();
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
    autopilotOn();
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
      return line.startsWith("- request.finished");
    };
    /** Each wake: a message sent, and whether any event in it was still pending when it went out. */
    const wakes: boolean[] = [];
    const fake = fakePaseo(true, (text) => wakes.push(text.split("\n").filter((line) => line.startsWith("- ")).some(pending)));
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
