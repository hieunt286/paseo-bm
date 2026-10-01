import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { createCompactionStore } from "../plugin/server/compaction-store";
import { createHandoffStore, type HandoffEntry } from "../plugin/server/handoff-store";
import { guardCoordination } from "../plugin/server/coordination-guard";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createEventBus, type BmEvent, type RequestStalledEvent, type WorkerSignalEvent } from "../plugin/server/event-bus";
import {
  INTERVENTIONS_FILE,
  INTERVENTION_CHECK_INTERVAL_MS,
  INTERVENTION_LOG_LIMIT,
  checkInterventions,
  createInterventionCheck,
  createInterventionStore,
  interventionOfCommand,
  interventionOfDecision,
  outcomeOf,
  recordIntervention,
  type CommandFacts,
  type InterventionInput,
} from "../plugin/server/intervention-store";
import type { BatchItem, NoticeBatch } from "../plugin/server/notice-queue";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { ORCHESTRATOR_DIR_NAME } from "../plugin/server/orchestrator-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { alertKeyOf } from "../plugin/shared/alerts";
import { DashboardError, type TraceRecord } from "../plugin/shared/contracts";
import { answerDecision, withdrawDecision, type DecisionDelivery } from "../plugin/shared/decisions";
import {
  EXPECTED_OUTCOME_OF,
  INTERVENTION_KINDS,
  INTERVENTION_WINDOW_MS,
  reportChecksOf,
  type InterventionKind,
} from "../plugin/shared/interventions";
import { makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";
import { MANAGER, WORKER, WORKSPACE_ID, report, turn } from "./fixtures/orchestrator-traces";

/**
 * The coordination intervention log (autonomy design §G.3, REQ-127):
 * `<data>/orchestrator/interventions.json` with the store rules of the alerts
 * store; which event a command answers; and the outcome check, one kind at a
 * time — met, missed and unknown — from synthetic decision, alert and trace
 * stores in a temporary data folder, never the real HOME or a daemon.
 */

const REQUEST = "req-20260926T100000Z";
const QID = `q:${REQUEST}:Q1`;
const ORCHESTRATOR = "agent-orchestrator";
const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const MIN = 60_000;

let root: string;
let home: string;
let ids: number;

const iso = (ms: number) => new Date(ms).toISOString();
const file = () => join(home, ORCHESTRATOR_DIR_NAME, INTERVENTIONS_FILE);
const modeOf = (path: string) => statSync(path).mode & 0o777;
const store = (at = T0) => createInterventionStore(home, { now: () => new Date(at), newId: () => `i-${++ids}` });
const check = (at: number) => checkInterventions(home, { now: () => new Date(at), log: () => {} });
const only = () => store().list()[0]!;
const location = () => ({ tracesDir: join(home, "traces") });

const input = (kind: InterventionKind, overrides: Partial<InterventionInput> = {}): InterventionInput => ({
  kind,
  workspaceId: WORKSPACE_ID,
  requestId: REQUEST,
  targetAgentId: WORKER,
  trigger: "orchestrator",
  ...overrides,
});

async function records(...list: TraceRecord[]): Promise<void> {
  for (const record of list) await appendRecord(location(), record);
}

/** A Worker turn from `start` to `end` (minutes after T0). */
const workerTurn = (start: number, end: number, overrides: Partial<TraceRecord> = {}): TraceRecord =>
  turn({
    agentId: WORKER,
    role: "worker",
    requestId: REQUEST,
    turnId: `w-${start}`,
    at: iso(T0 + end * MIN),
    startedAt: iso(T0 + start * MIN),
    endedAt: iso(T0 + end * MIN),
    ...overrides,
  });

/** A Manager turn at `minute` that carries the Worker's report. */
const reportTurn = (minute: number, buildAndTests: string | null): TraceRecord =>
  turn({
    agentId: MANAGER,
    requestId: REQUEST,
    turnId: `m-${minute}`,
    at: iso(T0 + minute * MIN),
    startedAt: iso(T0 + minute * MIN),
    endedAt: iso(T0 + minute * MIN),
    reports: [report({ at: iso(T0 + minute * MIN), requestId: REQUEST, phase: "finished", buildAndTests })],
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-intervention-store-"));
  home = join(root, "data");
  ids = 0;
  clearTraceStoreCache();
  clearDecisionStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  clearDecisionStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("the log file (design §G.3, the alerts store's rules)", () => {
  it("creates nothing on a read, then a 0700 folder and a 0600 file on the first write, replaced atomically; cleanup deletes it", () => {
    expect(store().list()).toEqual([]);
    expect(existsSync(home)).toBe(false);
    store().record(input("answer", { decisionId: QID }));
    store().record(input("stop"));
    expect(modeOf(join(home, ORCHESTRATOR_DIR_NAME))).toBe(0o700);
    expect(modeOf(file())).toBe(0o600);
    // No temporary file is left beside it.
    expect(readdirSync(join(home, ORCHESTRATOR_DIR_NAME))).toEqual([INTERVENTIONS_FILE]);
    expect(CLEANUP_DELETES).toContain(ORCHESTRATOR_DIR_NAME);
  });

  it("records ids, times and enums only: the kind's expected outcome and window, pending, at now", () => {
    const entry = store().record(input("unblock", { trigger: "request.stalled", alertKey: alertKeyOf("request-stalled", WORKSPACE_ID, REQUEST) }));
    expect(entry).toEqual({
      id: "i-1",
      kind: "unblock",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      targetAgentId: WORKER,
      trigger: "request.stalled",
      expected: "stall-clears",
      windowMs: 15 * MIN,
      at: iso(T0),
      outcome: "pending",
      checkedAt: null,
      alertKey: `request-stalled:${WORKSPACE_ID}:${REQUEST}`,
    });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ version: 1, entries: [entry] });
  });

  it("names the seven kinds with their expected outcome and window", () => {
    expect(INTERVENTION_KINDS).toEqual(["answer", "unblock", "correct", "stop", "compact", "handoff", "advice"]);
    expect(INTERVENTION_WINDOW_MS).toEqual({
      answer: 10 * MIN,
      unblock: 15 * MIN,
      correct: 60 * MIN,
      stop: 2 * MIN,
      compact: 60 * MIN,
      handoff: 60 * MIN,
      advice: 7 * 24 * 60 * MIN,
    });
    expect(Object.keys(EXPECTED_OUTCOME_OF)).toEqual([...INTERVENTION_KINDS]);
  });

  it(`keeps the newest ${INTERVENTION_LOG_LIMIT} entries`, () => {
    const seed = store().record(input("stop"));
    writeFileSync(file(), JSON.stringify({ version: 1, entries: Array.from({ length: INTERVENTION_LOG_LIMIT }, (_, n) => ({ ...seed, id: `old-${n}` })) }));
    store().record(input("answer", { decisionId: QID }));
    const kept = store().list();
    expect(kept).toHaveLength(INTERVENTION_LOG_LIMIT);
    expect(kept[0]!.id).toBe("old-1");
    expect(kept.at(-1)).toMatchObject({ kind: "answer" });
  });

  it("skips an entry that does not validate on its own, drops it at the next write, and reads a corrupt file as empty", () => {
    const good = store().record(input("stop"));
    writeFileSync(file(), JSON.stringify({ version: 1, entries: [good, { ...good, id: "bad", kind: "boom" }, { ...good, id: "text", command: undefined, outcome: "done" }, "x"] }));
    expect(store().list().map((entry) => entry.id)).toEqual([good.id]);
    store().record(input("stop"));
    expect((JSON.parse(readFileSync(file(), "utf8")) as { entries: unknown[] }).entries).toHaveLength(2);
    writeFileSync(file(), "{not json");
    expect(store().list()).toEqual([]);
  });

  it("reads a file from a newer paseo-bm as empty and never writes it; recording then costs one log line", () => {
    mkdirSync(join(home, ORCHESTRATOR_DIR_NAME), { recursive: true });
    const newer = JSON.stringify({ version: 2, entries: [] });
    writeFileSync(file(), newer);
    expect(store().list()).toEqual([]);
    expect(() => store().record(input("stop"))).toThrow(/newer paseo-bm/);
    const log = vi.fn();
    expect(recordIntervention(home, input("stop"), { log })).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[paseo-bm\] could not record the stop intervention: .*newer paseo-bm/));
    expect(readFileSync(file(), "utf8")).toBe(newer);
  });

  it("refuses a newer file with a coded error, whatever else it holds; a settle that changes nothing writes nothing (code review 2026-09-30 §3.1)", () => {
    mkdirSync(join(home, ORCHESTRATOR_DIR_NAME), { recursive: true });
    // No entries array at all: the version alone decides.
    const newer = JSON.stringify({ version: 2 });
    writeFileSync(file(), newer);
    let thrown: unknown = null;
    try {
      store().record(input("stop"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DashboardError);
    expect((thrown as DashboardError).code).toBe("E_TRACE_STORE_UNWRITABLE");
    expect(store().settle([{ id: "i-1", outcome: "met" }])).toEqual([]);
    expect(readFileSync(file(), "utf8")).toBe(newer);
  });

  it("refuses a symlinked orchestrator folder", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, join(home, ORCHESTRATOR_DIR_NAME));
    expect(() => store().list()).toThrow();
    expect(() => store().record(input("stop"))).toThrow();
    expect(recordIntervention(home, input("stop"), { log: () => {} })).toBeNull();
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("recordIntervention records nothing without a data folder or an intervention", () => {
    expect(recordIntervention(null, input("stop"))).toBeNull();
    expect(recordIntervention(home, null)).toBeNull();
    expect(existsSync(home)).toBe(false);
  });
});

describe("which event a command answers (design §G.3)", () => {
  const stalled: RequestStalledEvent = {
    type: "request.stalled",
    workspaceId: WORKSPACE_ID,
    requestKey: REQUEST,
    managerId: MANAGER,
    reason: "idle-unfinished",
    alertKey: alertKeyOf("request-stalled", WORKSPACE_ID, REQUEST),
    since: iso(T0 - 5 * MIN),
  };
  const signal = (kind: WorkerSignalEvent["signal"], alertKey: string | null): WorkerSignalEvent => ({
    type: "worker.signal",
    workspaceId: WORKSPACE_ID,
    workerId: WORKER,
    requestKey: REQUEST,
    signal: kind,
    turnStart: iso(T0 - 10 * MIN),
    alertKey,
    since: iso(T0 - 2 * MIN),
  });
  const toWorker: CommandFacts = { workspaceId: WORKSPACE_ID, requestId: REQUEST, to: "worker", targetAgentId: WORKER, interrupt: false, ownerAsked: false };
  const toManager: CommandFacts = { ...toWorker, to: "manager", targetAgentId: MANAGER };

  it("a request.stalled of the command's request: an unblock, with the stall's alert", () => {
    expect(interventionOfCommand(toManager, [stalled])).toEqual({
      kind: "unblock",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      targetAgentId: MANAGER,
      trigger: "request.stalled",
      alertKey: stalled.alertKey,
    });
    // Another request, or another project, is not this command's event.
    expect(interventionOfCommand({ ...toManager, requestId: "req-20260926T110000Z" }, [stalled])).toBeNull();
    expect(interventionOfCommand(toManager, [{ ...stalled, workspaceId: "wks_other" }])).toBeNull();
  });

  it("a worker.signal of the Worker it went to: a correction, with the signal and its alert when it has one", () => {
    const stuck = signal("stuck", alertKeyOf("stuck", WORKSPACE_ID, WORKER));
    expect(interventionOfCommand(toWorker, [stuck])).toMatchObject({ kind: "correct", trigger: "worker.signal", signal: "stuck", alertKey: stuck.alertKey, targetAgentId: WORKER });
    expect(interventionOfCommand(toWorker, [signal("failing", null)])).toEqual({
      kind: "correct",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      targetAgentId: WORKER,
      trigger: "worker.signal",
      signal: "failing",
    });
    // The Manager is not the Worker the signal is about; another Worker neither.
    expect(interventionOfCommand(toManager, [stuck])).toBeNull();
    expect(interventionOfCommand({ ...toWorker, targetAgentId: "agent-worker-2" }, [stuck])).toBeNull();
  });

  it("an interrupt is a stop, whatever the events", () => {
    const danger = signal("danger", alertKeyOf("danger", WORKSPACE_ID, WORKER));
    expect(interventionOfCommand({ ...toWorker, interrupt: true }, [danger, stalled])).toMatchObject({ kind: "stop", trigger: "worker.signal", signal: "danger" });
    expect(interventionOfCommand({ ...toWorker, interrupt: true, ownerAsked: true }, [])).toMatchObject({ kind: "stop", trigger: "owner" });
    expect(interventionOfCommand({ ...toWorker, interrupt: true }, [])).toMatchObject({ kind: "stop", trigger: "orchestrator" });
  });

  it("no event of its wake: a correction on the owner's word in the chat, else not logged", () => {
    expect(interventionOfCommand({ ...toManager, ownerAsked: true }, [])).toEqual({
      kind: "correct",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      targetAgentId: MANAGER,
      trigger: "owner",
    });
    expect(interventionOfCommand(toManager, [])).toBeNull();
    const opened: BmEvent = { type: "decision.opened", workspaceId: WORKSPACE_ID, requestId: REQUEST, decisionId: QID, askedBy: WORKER, asks: "decision" };
    expect(interventionOfCommand(toManager, [opened])).toBeNull();
  });

  it("carries the command's id onto the entry (commandId, the commands store's id); an entry of an older build without one still reads", () => {
    const facts: CommandFacts = { ...toManager, commandId: "cmd-1" };
    expect(interventionOfCommand(facts, [stalled])).toMatchObject({ kind: "unblock", commandId: "cmd-1" });
    expect(interventionOfCommand({ ...facts, to: "worker", targetAgentId: WORKER, interrupt: true }, [])).toMatchObject({ kind: "stop", commandId: "cmd-1" });
    expect(interventionOfCommand({ ...facts, ownerAsked: true }, [])).toMatchObject({ kind: "correct", trigger: "owner", commandId: "cmd-1" });
    expect(interventionOfCommand(facts, [])).toBeNull();

    const older = store().record(input("stop"));
    const entry = store().record(interventionOfCommand(facts, [stalled])!);
    expect(entry).toMatchObject({ id: "i-2", kind: "unblock", commandId: "cmd-1" });
    expect(older).not.toHaveProperty("commandId");
    expect(store().list()).toEqual([older, entry]);
  });

  it("a bm_decide answer targets the Worker that asked; its trigger is the decision.opened the wake carried, else the Orchestrator's own look", () => {
    const decision = makeDecision({ id: QID, workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "worker", agentId: WORKER } });
    const opened: BmEvent = { type: "decision.opened", workspaceId: WORKSPACE_ID, requestId: REQUEST, decisionId: QID, askedBy: WORKER, asks: "decision" };
    expect(interventionOfDecision(decision, [opened])).toEqual({
      kind: "answer",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      targetAgentId: WORKER,
      trigger: "decision.opened",
      decisionId: QID,
    });
    expect(interventionOfDecision(decision, [{ ...opened, decisionId: `q:${REQUEST}:Q2` }]).trigger).toBe("orchestrator");
  });
});

describe("the event bus keeps a wake's events until its turn ends (design §G.3)", () => {
  it("wakeEventsOf gives the running wake's events, and none once that turn ended", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "scope", mode: "shadow", confirmed: true }, iso(T0));
    const orchestrator = {
      id: ORCHESTRATOR,
      provider: "bm-orchestrator/claude-opus-5-5",
      status: "idle",
      workspaceId: "wks-own",
      labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
      createdAt: iso(T0),
    };
    const paseo = { agents: { list: vi.fn(async () => ({ entries: [{ agent: orchestrator }] })), ref: vi.fn(() => ({})) } };
    const batches: Array<{ batch: NoticeBatch; keys: string[] }> = [];
    const queue = {
      enqueueBatch: vi.fn(async (_target: string, batch: NoticeBatch, items: readonly BatchItem[]) => {
        batches.push({ batch, keys: items.map((item) => item.key) });
        return items.map(() => "sent" as const);
      }),
    };
    const bus = createEventBus({ home: () => home, queue, now: () => new Date(T0), log: () => {} });
    const stall: RequestStalledEvent = {
      type: "request.stalled",
      workspaceId: WORKSPACE_ID,
      requestKey: REQUEST,
      managerId: MANAGER,
      reason: "idle-unfinished",
      alertKey: alertKeyOf("request-stalled", WORKSPACE_ID, REQUEST),
      since: iso(T0),
    };

    expect((await bus.publish([stall], paseo)).status).toBe("done");
    // Queued, not yet delivered: no wake.
    expect(bus.wakeEventsOf(ORCHESTRATOR)).toEqual([]);
    batches[0]!.batch.onSent!(ORCHESTRATOR, batches[0]!.keys);
    expect(bus.wakeEventsOf(ORCHESTRATOR)).toEqual([stall]);
    expect(bus.wakeEventsOf("agent-other")).toEqual([]);
    await batches[0]!.batch.onTurnEnded!(ORCHESTRATOR, undefined);
    expect(bus.wakeEventsOf(ORCHESTRATOR)).toEqual([]);
  });
});

describe("the outcome check, one kind at a time (design §G.3)", () => {
  const decisions = () => createDecisionStore(home, { log: () => {} });
  const alerts = (at: number) => createAlertStore(home, { now: () => new Date(at) });
  const question = () => makeDecision({ id: QID, workspaceId: WORKSPACE_ID, requestId: REQUEST, askedBy: { role: "worker", agentId: WORKER }, askedAt: iso(T0 - 5 * MIN) });
  /** The Worker's question, answered at T0 by the Orchestrator, then delivered as `delivery` says. */
  function answered(delivery: DecisionDelivery | null): void {
    decisions().open(question());
    decisions().transition(QID, (d) => storedOrchestratorAnswer(d, { optionKey: "c", reason: "Hold is safe.", at: iso(T0) }), WORKSPACE_ID);
    if (delivery !== null) decisions().transition(QID, (d) => ({ ok: true, decision: { ...d, delivery } }), WORKSPACE_ID);
  }
  const delivered = (outcome: DecisionDelivery["outcome"], minute: number): DecisionDelivery => ({
    to: WORKER,
    kind: `answers:${REQUEST}`,
    at: iso(T0 + minute * MIN),
    outcome,
  });

  describe("answer: the Worker resumes within 10 minutes", () => {
    beforeEach(() => {
      store().record(input("answer", { trigger: "decision.opened", decisionId: QID }));
    });

    it("met: the answer was sent to it", () => {
      answered(delivered("sent", 1));
      expect(check(T0 + 2 * MIN)).toEqual([expect.objectContaining({ id: "i-1", outcome: "met", checkedAt: iso(T0 + 2 * MIN) })]);
    });

    it("met: a turn of the Worker started within the window, whatever the delivery says", async () => {
      answered(null);
      await records(workerTurn(-20, -1), workerTurn(4, 30));
      expect(check(T0 + 31 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("pending while the window runs; missed once it is over with the answer still queued, or sent late", () => {
      answered(delivered("queued", 0));
      expect(check(T0 + 5 * MIN)).toEqual([]);
      expect(only().outcome).toBe("pending");
      expect(check(T0 + 11 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("missed: the answer reached it after the window", () => {
      answered(delivered("sent", 12));
      expect(check(T0 + 13 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("unknown: nothing was delivered and no turn of the Worker is recorded, or the decision is gone", async () => {
      answered(null);
      expect(check(T0 + 11 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
      store().record(input("answer", { decisionId: `q:${REQUEST}:Q9` }));
      expect(check(T0 + 30 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
    });
  });

  describe("unblock: the stall alert clears within 15 minutes", () => {
    const key = alertKeyOf("request-stalled", WORKSPACE_ID, REQUEST);
    beforeEach(() => {
      alerts(T0 - 5 * MIN).raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: REQUEST });
      store().record(input("unblock", { targetAgentId: MANAGER, trigger: "request.stalled", alertKey: key }));
    });

    it("met: cleared within the window", () => {
      alerts(T0 + 4 * MIN).clear(key);
      expect(check(T0 + 5 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("met: cleared, then raised afresh, within the window", () => {
      alerts(T0 + 3 * MIN).clear(key);
      alerts(T0 + 10 * MIN).raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: REQUEST });
      expect(check(T0 + 11 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("pending while it holds within the window; missed while it still holds after it, or once it cleared late", () => {
      expect(check(T0 + 10 * MIN)).toEqual([]);
      expect(check(T0 + 16 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
      store().record(input("unblock", { alertKey: key }));
      alerts(T0 + 20 * MIN).clear(key);
      expect(check(T0 + 21 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("unknown: the alert is not in the store, or was raised afresh after the window with no sign of when the first cleared", () => {
      store().record(input("unblock", { alertKey: alertKeyOf("request-stalled", WORKSPACE_ID, "req-gone") }));
      alerts(T0 + 30 * MIN).clear(key);
      alerts(T0 + 40 * MIN).raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: REQUEST });
      // The first entry's alert cleared at 30 minutes (after its window), and is open again: the store keeps only the new one.
      expect(check(T0 + 41 * MIN).map((entry) => [entry.id, entry.outcome])).toEqual([
        ["i-1", "unknown"],
        ["i-2", "unknown"],
      ]);
    });
  });

  describe("correct: the signal clears, or the next report's checks pass", () => {
    const stuck = alertKeyOf("stuck", WORKSPACE_ID, WORKER);

    it("met: the signal's alert cleared within the window", () => {
      alerts(T0 - 2 * MIN).raise({ workspaceId: WORKSPACE_ID, kind: "stuck", subject: WORKER });
      store().record(input("correct", { trigger: "worker.signal", signal: "stuck", alertKey: stuck }));
      alerts(T0 + 10 * MIN).clear(stuck);
      expect(check(T0 + 11 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("met: the request's next report says its checks pass", async () => {
      store().record(input("correct", { trigger: "worker.signal", signal: "failing" }));
      await records(reportTurn(-3, "npm test: 3 failed"), reportTurn(20, "npm test: 42 passed, 0 failed"));
      expect(check(T0 + 21 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("missed: a signal without an alert, whose next report still fails", async () => {
      store().record(input("correct", { trigger: "worker.signal", signal: "failing" }));
      await records(reportTurn(20, "npm test: 2 failed"));
      expect(check(T0 + 21 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("missed: the signal's alert still holds when the window ends, and the report did not show passing checks", async () => {
      alerts(T0 - 2 * MIN).raise({ workspaceId: WORKSPACE_ID, kind: "stuck", subject: WORKER });
      store().record(input("correct", { trigger: "worker.signal", signal: "stuck", alertKey: stuck }));
      await records(reportTurn(20, "not run"));
      // The alert may still clear: an alert signal waits for the window's end.
      expect(check(T0 + 30 * MIN)).toEqual([]);
      expect(check(T0 + 62 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("unknown: no report within the window for a signal without an alert, a report that names no check, or no request", async () => {
      store().record(input("correct", { trigger: "worker.signal", signal: "heavy" }));
      expect(check(T0 + 30 * MIN)).toEqual([]);
      expect(check(T0 + 62 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
      store().record(input("correct", { trigger: "worker.signal", signal: "outside" }));
      await records(reportTurn(70, "not run"));
      expect(check(T0 + 71 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
      store().record(input("correct", { requestId: null, targetAgentId: MANAGER, trigger: "owner" }));
      expect(check(T0 + 62 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
    });
  });

  describe("stop: the turn the interrupt started ends within 2 minutes", () => {
    beforeEach(() => {
      store().record(input("stop", { trigger: "worker.signal", signal: "danger" }));
    });

    it("met: the Worker's turn from the interrupt ended within the window; the replaced one does not count", async () => {
      await records(workerTurn(-10, 0.1), workerTurn(0.2, 1.5));
      expect(check(T0 + 2 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("missed: that turn ran past the window, or no turn of the Worker ended by the window's end", async () => {
      await records(workerTurn(0.2, 6));
      expect(check(T0 + 7 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
      // Another Worker, with no turn recorded: pending in the window, missed once it is over.
      store().record(input("stop", { targetAgentId: "agent-worker-2" }));
      expect(check(T0 + 2 * MIN)).toEqual([]);
      expect(check(T0 + 3 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("unknown: no Worker was named", () => {
      store().record(input("stop", { targetAgentId: null }));
      expect(check(T0 + 60_000)).toEqual([]);
      expect(check(T0 + 4 * MIN).map((entry) => [entry.id, entry.outcome])).toEqual([
        ["i-1", "missed"],
        ["i-2", "unknown"],
      ]);
    });
  });

  describe("advice: the owner answers the advice decision within 7 days", () => {
    const OID = "o:advice-1";
    const advice = () =>
      makeDecision({
        id: OID,
        workspaceId: WORKSPACE_ID,
        requestId: null,
        round: null,
        askedBy: { role: "orchestrator", agentId: ORCHESTRATOR },
        askedAt: iso(T0),
        subject: "review-budget",
        options: [
          { key: "a", label: "Raise the budget", recommended: true, effects: ["none"] },
          { key: "b", label: "Keep it", recommended: false, effects: ["none"] },
        ],
      });
    beforeEach(() => {
      decisions().open(advice());
      store().record(input("advice", { requestId: null, targetAgentId: null, trigger: "advice.due", decisionId: OID }));
    });

    it("met: answered within the window", () => {
      decisions().transition(OID, (d) => answerDecision(d, { via: "inbox", optionKey: "a", at: iso(T0 + 24 * 60 * MIN) }), WORKSPACE_ID);
      expect(check(T0 + 25 * 60 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
    });

    it("missed: still open after the window, or withdrawn without an answer", () => {
      expect(check(T0 + 24 * 60 * MIN)).toEqual([]);
      expect(check(T0 + 8 * 24 * 60 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
      decisions().open({ ...advice(), id: "o:advice-2" });
      store().record(input("advice", { decisionId: "o:advice-2" }));
      decisions().transition("o:advice-2", (d) => withdrawDecision(d, { at: iso(T0 + MIN) }), WORKSPACE_ID);
      expect(check(T0 + 2 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
    });

    it("unknown: the decision is gone", () => {
      store().record(input("advice", { decisionId: "o:gone" }));
      expect(check(T0 + 8 * 24 * 60 * MIN).map((entry) => [entry.id, entry.outcome])).toEqual([
        ["i-1", "missed"],
        ["i-2", "unknown"],
      ]);
    });
  });

  it("compact and handoff are checked from Phase 3: pending in their window, unknown after it", () => {
    store().record(input("compact"));
    store().record(input("handoff"));
    expect(check(T0 + 30 * MIN)).toEqual([]);
    expect(check(T0 + 62 * MIN).map((entry) => [entry.kind, entry.outcome])).toEqual([
      ["compact", "unknown"],
      ["handoff", "unknown"],
    ]);
  });

  it("a settled entry keeps its outcome and time; a check with nothing pending writes nothing", () => {
    store().record(input("stop", { targetAgentId: null }));
    const [settled] = check(T0 + 4 * MIN);
    expect(settled).toMatchObject({ outcome: "unknown", checkedAt: iso(T0 + 4 * MIN) });
    const bytes = readFileSync(file(), "utf8");
    expect(check(T0 + 60 * MIN)).toEqual([]);
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    expect(outcomeOf(only(), {}, T0 + 60 * MIN)).toBe("unknown");
  });
});

describe("reportChecksOf", () => {
  it("reads pass, fail, or nothing named", () => {
    expect(reportChecksOf("npm test: 42 passed")).toBe("pass");
    expect(reportChecksOf("npm run verify green; 0 failed, no errors")).toBe("pass");
    expect(reportChecksOf("npm test: 2 failed")).toBe("fail");
    // node:test's summary order, a clean run (Phase 2 live check 2026-09-30): the count after the word.
    expect(reportChecksOf("node --test (tests 3, pass 3, fail 0)")).toBe("pass");
    expect(reportChecksOf("tests 12, errors 0, took 0.4s")).toBe("pass");
    expect(reportChecksOf("node --test (tests 3, pass 2, fail 1)")).toBe("fail");
    expect(reportChecksOf("fail 0.5 of the time")).toBe("fail");
    expect(reportChecksOf("typecheck red")).toBe("fail");
    for (const nothing of [null, "", "not run", "`not run`", "none", "n/a", "skipped", "no tests", "- "]) expect(reportChecksOf(nothing)).toBeNull();
    // buildAndTests keeps its backticks: a named check is not "nothing ran".
    expect(reportChecksOf("`npm test` pass")).toBe("pass");
  });
});

describe("the throttled pass at turn ends (like the outdated-agents pass)", () => {
  it("checks at most once per interval, in the data folder, and never throws", () => {
    store().record(input("stop", { targetAgentId: null }));
    let clock = T0 + 4 * MIN;
    const log = vi.fn();
    const pass = createInterventionCheck({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => clock, log });
    expect(pass.run().map((entry) => entry.outcome)).toEqual(["unknown"]);
    store().record(input("stop", { targetAgentId: null }));
    clock += INTERVENTION_CHECK_INTERVAL_MS - 1;
    expect(pass.run()).toEqual([]);
    expect(store().list().map((entry) => entry.outcome)).toEqual(["unknown", "pending"]);
    clock += 1;
    expect(pass.run().map((entry) => entry.outcome)).toEqual(["unknown"]);

    rmSync(join(home, ORCHESTRATOR_DIR_NAME), { recursive: true });
    symlinkSync(root, join(home, ORCHESTRATOR_DIR_NAME));
    clock += INTERVENTION_CHECK_INTERVAL_MS;
    expect(pass.run()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[paseo-bm\] could not check the outcomes of the Orchestrator's interventions: /));
  });
});

describe("compact: tokens per turn over the next three turns at most 60 % of the three before (design §G.3, §G.5; bead 7gxw.10)", () => {
  /** A Claude Worker turn that read `read` tokens (the whole turn's). */
  const reading = (read: number): Partial<TraceRecord> => ({
    usage: { inputTokens: 1_000, cachedInputTokens: read - 1_000, outputTokens: 500, costUsd: null, costBasis: "unavailable", model: "claude-opus-5", pricesUpdatedAt: null },
    runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: null, provider: "bm-worker" },
  });
  const turnReading = (end: number, read: number) => workerTurn(end - 1, end, reading(read));
  /** The compaction's own turn: 0 tokens (its figure understates), a completed compaction item. */
  const compactionTurn = (end: number) =>
    workerTurn(end - 1, end, {
      ...reading(1_000),
      usage: { ...reading(1_000).usage!, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      evidence: [{ kind: "compaction", detail: "manual", agentId: WORKER, at: iso(T0 + end * MIN), trigger: "manual", preTokens: null }],
    });
  const before = () => [turnReading(-30, 6_000_000), turnReading(-20, 6_000_000), turnReading(-10, 6_000_000)];
  /** The compaction of intervention i-1, its /compact sent `sentMinute` after T0 (null: never sent), in `state`. */
  const compaction = (sentMinute: number | null, state: "waiting" | "compacting" | "done" | "dropped" = "done") => {
    const compactions = createCompactionStore(home, { now: () => new Date(T0), newId: () => "c-1" });
    compactions.add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: "i-1", reason: "" });
    compactions.update("c-1", (current) => ({ ...current, state, sentAt: sentMinute === null ? null : iso(T0 + sentMinute * MIN) }));
  };

  it("met: its next three measured turns read at most 60 % of the three before; its own turn is never one of them", async () => {
    store().record(input("compact"));
    compaction(1);
    await records(...before(), compactionTurn(2), turnReading(5, 2_000_000), turnReading(8, 2_000_000));
    expect(check(T0 + 9 * MIN)).toEqual([]);
    await records(turnReading(11, 2_000_000));
    expect(check(T0 + 12 * MIN).map((entry) => [entry.kind, entry.outcome])).toEqual([["compact", "met"]]);
  });

  it("missed: more than 60 % — the compaction's own 0 tokens would have hidden it", async () => {
    store().record(input("compact"));
    compaction(1);
    await records(...before(), compactionTurn(2), turnReading(5, 5_000_000), turnReading(8, 5_000_000), turnReading(11, 5_000_000));
    expect(check(T0 + 12 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
  });

  it("the window runs from its /compact, at most an hour: once over, the turns it holds are judged; none is unknown", async () => {
    store().record(input("compact"));
    compaction(50);
    await records(...before(), compactionTurn(51), turnReading(55, 1_000_000), turnReading(115, 1_000_000));
    // An hour after the entry, but not after the /compact: still pending.
    expect(check(T0 + 70 * MIN)).toEqual([]);
    // The window (50 → 110 min) is over: the one turn inside it is judged; the one after it is not.
    expect(check(T0 + 112 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);
  });

  it("unknown: the compaction never went out (dropped, or waiting past its bound), or no turn before or after it to compare", async () => {
    store().record(input("compact"));
    compaction(null, "dropped");
    expect(check(T0 + 5 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);

    rmSync(home, { recursive: true, force: true });
    ids = 0;
    store().record(input("compact"));
    compaction(null, "waiting");
    expect(check(T0 + 30 * MIN)).toEqual([]);
    expect(check(T0 + 62 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);

    rmSync(home, { recursive: true, force: true });
    ids = 0;
    clearTraceStoreCache();
    store().record(input("compact"));
    compaction(1);
    await records(compactionTurn(2), turnReading(5, 1_000_000));
    expect(check(T0 + 63 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
  });

  it("A-12's guard can fire now: ten compactions that missed switch compaction off (design §G.7, coordination-guard.ts)", async () => {
    for (let n = 0; n < 10; n += 1) store().record(input("compact"));
    await records(...before(), turnReading(5, 6_000_000), turnReading(8, 6_000_000), turnReading(11, 6_000_000));
    expect(check(T0 + 12 * MIN).map((entry) => entry.outcome)).toEqual(Array.from({ length: 10 }, () => "missed"));
    expect(guardCoordination(home, { now: () => new Date(T0 + 12 * MIN), log: () => {} })).toEqual(["compact"]);
    expect(createCoordinationStore(home).read().compact.enabled).toBe(false);
  });
});

describe("handoff: the successor's tokens per turn at most 50 % of the predecessor's last three, and a report from it, within an hour (design §G.3, §G.6; bead 7gxw.11)", () => {
  const SUCCESSOR = "agent-successor";
  /** A Claude turn of `agentId` that read `read` tokens (the whole turn's). */
  const reading = (agentId: string, end: number, read: number, overrides: Partial<TraceRecord> = {}) =>
    workerTurn(end - 1, end, {
      agentId,
      turnId: `${agentId}-${end}`,
      usage: { inputTokens: 1_000, cachedInputTokens: read - 1_000, outputTokens: 500, costUsd: null, costBasis: "unavailable", model: "claude-opus-5", pricesUpdatedAt: null },
      runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: null, provider: "bm-worker" },
      ...overrides,
    });
  const before = () => [reading(WORKER, -30, 6_000_000), reading(WORKER, -20, 6_000_000), reading(WORKER, -10, 6_000_000)];
  /** The successor's report of the request at `minute`. */
  const reported = (minute: number, phase: "received" | "blocked" | "finished" = "received") =>
    turn({ agentId: MANAGER, requestId: REQUEST, turnId: `m-${minute}`, at: iso(T0 + minute * MIN), endedAt: iso(T0 + minute * MIN), reports: [report({ agentId: MANAGER, requestId: REQUEST, at: iso(T0 + minute * MIN), phase })] });
  /** The handoff of intervention i-1; its successor appeared `minute` after T0 (null: none yet), in `state`. */
  const handoff = (minute: number | null, state: HandoffEntry["state"] = minute === null ? "commanded" : "done") => {
    const handoffs = createHandoffStore(home, { now: () => new Date(T0), newId: () => "h-1" });
    handoffs.add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: "i-1", reason: "" });
    handoffs.update("h-1", (current) => ({
      ...current,
      state,
      commandSentAt: state === "waiting" ? null : iso(T0),
      successorId: minute === null ? null : SUCCESSOR,
      successorAt: minute === null ? null : iso(T0 + minute * MIN),
      ending: state === "failed" ? "no-successor" : null,
    }));
  };

  it("met: its first three measured turns read at most half of the predecessor's last three, and it reported", async () => {
    store().record(input("handoff"));
    handoff(2);
    await records(...before(), reading(SUCCESSOR, 5, 2_000_000), reported(6), reading(SUCCESSOR, 8, 2_000_000));
    expect(check(T0 + 9 * MIN)).toEqual([]);
    await records(reading(SUCCESSOR, 11, 2_000_000));
    expect(check(T0 + 12 * MIN).map((entry) => [entry.kind, entry.outcome])).toEqual([["handoff", "met"]]);
  });

  it("missed: more than half at once; or within it, but no report except blocked by the window's end", async () => {
    store().record(input("handoff"));
    handoff(2);
    await records(...before(), reading(SUCCESSOR, 5, 4_000_000), reading(SUCCESSOR, 8, 4_000_000), reading(SUCCESSOR, 11, 4_000_000));
    expect(check(T0 + 12 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);

    rmSync(home, { recursive: true, force: true });
    ids = 0;
    clearTraceStoreCache();
    store().record(input("handoff"));
    handoff(2);
    await records(...before(), reading(SUCCESSOR, 5, 1_000_000), reported(6, "blocked"), reading(SUCCESSOR, 8, 1_000_000), reading(SUCCESSOR, 11, 1_000_000));
    // Its tokens are down, but no progress yet: it waits for a report until the window ends.
    expect(check(T0 + 12 * MIN)).toEqual([]);
    expect(check(T0 + 64 * MIN).map((entry) => entry.outcome)).toEqual(["missed"]);
  });

  it("the window runs from the successor's creation: pending while the sequence runs, unknown when it ended without a successor or no turn compares", async () => {
    store().record(input("handoff"));
    handoff(null);
    // Its command went out; the successor is not there yet: pending, even past an hour from the entry while within its bounds.
    expect(check(T0 + 20 * MIN)).toEqual([]);
    expect(check(T0 + 31 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);

    rmSync(home, { recursive: true, force: true });
    ids = 0;
    clearTraceStoreCache();
    store().record(input("handoff"));
    handoff(null, "dropped");
    expect(check(T0 + 5 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);

    rmSync(home, { recursive: true, force: true });
    ids = 0;
    clearTraceStoreCache();
    store().record(input("handoff"));
    handoff(40);
    await records(...before(), reported(45), reading(SUCCESSOR, 50, 1_000_000));
    // An hour from the entry but not from the successor: still pending; after its window, its one turn is judged.
    expect(check(T0 + 70 * MIN)).toEqual([]);
    expect(check(T0 + 102 * MIN).map((entry) => entry.outcome)).toEqual(["met"]);

    rmSync(home, { recursive: true, force: true });
    ids = 0;
    clearTraceStoreCache();
    store().record(input("handoff"));
    handoff(2);
    await records(reported(6));
    expect(check(T0 + 64 * MIN).map((entry) => entry.outcome)).toEqual(["unknown"]);
  });

  it("A-12's guard can fire now: ten handoffs that missed switch handoff off (design §G.7, coordination-guard.ts)", async () => {
    for (let n = 0; n < 10; n += 1) store().record(input("handoff"));
    const handoffs = createHandoffStore(home, { now: () => new Date(T0) });
    for (const entry of store().list()) {
      const added = handoffs.add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: entry.id, reason: "" });
      handoffs.update(added.id, (current) => ({ ...current, state: "done", commandSentAt: iso(T0), successorId: SUCCESSOR, successorAt: iso(T0 + 2 * MIN) }));
    }
    await records(...before(), reading(SUCCESSOR, 5, 6_000_000), reading(SUCCESSOR, 8, 6_000_000), reading(SUCCESSOR, 11, 6_000_000));
    expect(check(T0 + 12 * MIN).map((entry) => entry.outcome)).toEqual(Array.from({ length: 10 }, () => "missed"));
    expect(guardCoordination(home, { now: () => new Date(T0 + 12 * MIN), log: () => {} })).toEqual(["handoff"]);
    expect(createCoordinationStore(home).read().handoff.enabled).toBe(false);
  });
});
