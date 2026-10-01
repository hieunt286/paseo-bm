import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { createEventBus, type EventBusDeps } from "../plugin/server/event-bus";
import { toolsStaleSince } from "../plugin/server/agent-tools";
import { REVIEW_BUDGET } from "../plugin/server/review-budget";
import {
  IDLE_UNFINISHED_MS,
  STALL_PASS_MS,
  createStallWatcher,
  stallReasonsOf,
  type StallWatcher,
  type StallWatcherDeps,
} from "../plugin/server/stall-watcher";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { reconstructTraces, type AgentFacts, type ReconstructedTrace } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import { alertKeyOf } from "../plugin/shared/alerts";
import { flagsOf } from "../plugin/shared/orchestrator-rules";
import { ruleInputOf } from "../plugin/server/request-trace";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, agent, at, msg, report, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";
import { makeDecision } from "./helpers/decisions";
import { createDecisionStore } from "../plugin/server/decision-store";
import { answerDecision } from "../plugin/shared/decisions";

/**
 * The stall pass (Orchestrator design §6, §12; autonomy design §A.8): the two
 * reasons on fixtures; one `request-stalled` Inbox alert per stalled request
 * of every project, raised once, cleared and raised again; a `request.stalled`
 * event only for a project with a class above `owner` in the policy, through
 * the event bus, as a batched `BM-EVENTS` message to the Orchestrator and
 * never to anybody else; every
 * request of a Manager watched (the 2026-09-28 regression); the timer always
 * on. A fake Paseo SDK, a private notice queue and a temporary data folder
 * named by `PASEO_BM_HOME` — never the real HOME or a daemon.
 */

const REQUEST_ID = "req-20260926T100020Z";
const ORCHESTRATOR = "agent-orchestrator";
const USER_TEXT = "Add a PDF export button to the invoice screen.\nKeep the date format.";

/** A time on 2026-09-26 as a Date. */
const when = (minute: number, second = 0) => new Date(at(minute, second));

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The user's request, handed to a Worker; the Worker's turn ends at 10:03. */
function handedOver(requestId = REQUEST_ID): TraceRecord[] {
  return [
    turn({
      at: at(0, 40),
      turnId: "m-1",
      requestId,
      startedAt: at(0, 20),
      endedAt: at(0, 40),
      sent: [msg(MANAGER, at(0, 20), USER_TEXT, "user")],
      received: [msg(MANAGER, at(0, 35), "I handed this to the Beads Worker.")],
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(3),
      turnId: "w-1",
      requestId,
      parentAgentId: MANAGER,
      startedAt: at(0, 45),
      endedAt: at(3),
      sent: [msg(WORKER, at(0, 45), `Request ${requestId}: ${USER_TEXT}`, "agent")],
    }),
  ];
}

/** The Manager turn that relays one Worker report; `endedAt` defaults to 10 seconds after the report. */
function relayed(phase: "received" | "blocked" | "finished", reportAt: string, extra: { endedAt?: string; turnId?: string; unparsed?: string[] } = {}) {
  return turn({
    at: extra.endedAt ?? reportAt,
    turnId: extra.turnId ?? `m-${phase}`,
    requestId: REQUEST_ID,
    startedAt: reportAt,
    endedAt: extra.endedAt ?? reportAt,
    sent: [msg(MANAGER, reportAt, `BM-REPORT\nrequestId: ${REQUEST_ID}\nphase: ${phase}\ntier: Medium`, "agent")],
    reports: [
      report({
        agentId: WORKER,
        at: reportAt,
        requestId: REQUEST_ID,
        phase,
        tier: "Medium",
        unparsedFields: extra.unparsed ?? [],
        ...(phase === "finished" ? { blockers: "none", buildAndTests: "npm test: 7 passed" } : {}),
        ...(phase === "blocked" ? { blockers: "Q1: which date format?" } : {}),
      }),
    ],
  });
}

/** A second request of the same Manager, asked at 10:10 and handed to a second Worker whose turn ends at 10:12. */
const REQUEST_2 = "req-20260926T101020Z";
const WORKER_2 = "agent-worker-2";
const USER_TEXT_2 = "Rename the exported PDF file.";

function secondRequest(): TraceRecord[] {
  return [
    turn({
      at: at(10, 40),
      turnId: "m-2",
      requestId: REQUEST_2,
      startedAt: at(10, 20),
      endedAt: at(10, 40),
      sent: [msg(MANAGER, at(10, 20), USER_TEXT_2, "user")],
      received: [msg(MANAGER, at(10, 35), "I handed this to the Beads Worker.")],
    }),
    turn({
      agentId: WORKER_2,
      role: "worker",
      at: at(12),
      turnId: "w2-1",
      requestId: REQUEST_2,
      parentAgentId: MANAGER,
      startedAt: at(10, 45),
      endedAt: at(12),
      sent: [msg(WORKER_2, at(10, 45), `Request ${REQUEST_2}: ${USER_TEXT_2}`, "agent")],
    }),
  ];
}

function agentsWith(status: { manager?: string; worker?: string; reviewer?: string } = {}): AgentFacts[] {
  const agents = [
    agent({ id: MANAGER, role: "manager", status: status.manager ?? "idle", title: "Invoice Manager" }),
    agent({ id: WORKER, role: "worker", status: status.worker ?? "idle", parentAgentId: MANAGER, createdAt: at(0, 30), requestIdLabel: REQUEST_ID }),
  ];
  if (status.reviewer !== undefined) {
    agents.push(agent({ id: REVIEWER, role: "reviewer", status: status.reviewer, parentAgentId: WORKER, createdAt: at(2), requestIdLabel: REQUEST_ID }));
  }
  return agents;
}

function traceOf(records: TraceRecord[], agents: AgentFacts[]): { trace: ReconstructedTrace; facts: Map<string, AgentFacts> } {
  const trace = reconstructTraces({ records, agents }).find((candidate) => candidate.managerAgentId !== null);
  if (trace === undefined) throw new Error("no trace");
  return { trace, facts: new Map(agents.map((entry) => [entry.id, entry])) };
}

/** The reasons `stallReasonsOf` sees at `now`, with the flags the server would compute. */
function reasonsAt(records: TraceRecord[], agents: AgentFacts[], now: Date) {
  const { trace, facts } = traceOf(records, agents);
  const flags = flagsOf(ruleInputOf(trace), { reviewBudget: REVIEW_BUDGET });
  return stallReasonsOf(trace, facts, flags, now);
}

// ── Why a request stalls (pure) ──────────────────────────────────────────────

describe("stallReasonsOf (autonomy design §A.8)", () => {
  it("idle-unfinished: the last report is neither finished nor blocked and nothing happened for 5 minutes", () => {
    const records = [...handedOver(), relayed("received", at(1, 10))];
    // The last activity is the Worker's turn end at 10:03.
    expect(reasonsAt(records, agentsWith(), new Date(when(3).getTime() + IDLE_UNFINISHED_MS - 1000))).toEqual([]);
    expect(reasonsAt(records, agentsWith(), new Date(when(3).getTime() + IDLE_UNFINISHED_MS))).toEqual([{ reason: "idle-unfinished", since: at(3) }]);
  });

  it("idle-unfinished also holds for a Worker that never reported", () => {
    expect(reasonsAt(handedOver(), agentsWith(), when(30))).toEqual([{ reason: "idle-unfinished", since: at(3) }]);
  });

  it("a request waiting on the owner is not stalled: its question waits in the Inbox (waiting-user is gone)", () => {
    const records = [...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))];
    // The decision store could not be read: a blocked report counts as waiting, as before.
    expect(reasonsAt(records, agentsWith(), when(59))).toEqual([]);
  });

  it("waiting on the owner is read from the decision store, never from the report (ADR-024)", () => {
    const blocked = [...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))];
    const working = [...handedOver(), relayed("received", at(1, 10))];
    const reasons = (records: TraceRecord[], waitsOnOwner: boolean) => {
      const { trace, facts } = traceOf(records, agentsWith());
      return stallReasonsOf(trace, facts, flagsOf(ruleInputOf(trace), { reviewBudget: REVIEW_BUDGET }), when(59), waitsOnOwner).map((entry) => entry.reason);
    };
    // Blocked, but every question answered (or asked only in chat words): nobody the Inbox shows is asked — a stall.
    expect(reasons(blocked, false)).toEqual(["idle-unfinished"]);
    expect(reasons(blocked, true)).toEqual([]);
    // Not blocked, but an unsettled decision of the request: it waits on the owner.
    expect(reasons(working, true)).toEqual([]);
    expect(reasons(working, false)).toEqual(["idle-unfinished"]);
  });

  it("a malformed report alone is no stall any more", () => {
    const records = [...handedOver(), relayed("received", at(1, 10), { unparsed: ["tier"] })];
    expect(reasonsAt(records, agentsWith(), when(4))).toEqual([]);
    expect(reasonsAt(records, agentsWith(), when(9)).map((entry) => entry.reason)).toEqual(["idle-unfinished"]);
  });

  it("review-over-budget: review.over-budget is raised and the last report is not finished", () => {
    const reviewCall = (minute: number) =>
      turn({
        agentId: REVIEWER,
        role: "reviewer",
        at: at(minute, 30),
        turnId: `r-${minute}`,
        requestId: REQUEST_ID,
        parentAgentId: WORKER,
        startedAt: at(minute),
        endedAt: at(minute, 30),
        sent: [msg(REVIEWER, at(minute), `Review batch b1 of ${REQUEST_ID}, stage implementation, round ${minute}.`, "agent")],
        received: [msg(REVIEWER, at(minute, 30), `BM-REVIEW\nrequestId: ${REQUEST_ID}\nbatchId: b1\nverdict: changes-requested`)],
      });
    const records = [...handedOver(), relayed("received", at(1, 10)), reviewCall(4), reviewCall(5), reviewCall(6)];
    const agents = agentsWith({ reviewer: "idle" });
    const { trace, facts } = traceOf(records, agents);
    expect(trace.reviewCalls).toBeGreaterThan(REVIEW_BUDGET.Medium);
    const flags = flagsOf(ruleInputOf(trace), { reviewBudget: REVIEW_BUDGET });
    expect(stallReasonsOf(trace, facts, flags, when(6, 40)).map((entry) => entry.reason)).toEqual(["review-over-budget"]);
    expect(stallReasonsOf(trace, facts, flags, when(12)).map((entry) => entry.reason)).toEqual(["idle-unfinished", "review-over-budget"]);
  });

  it("a healthy running request raises none, even hours later: its Worker or Reviewer runs", () => {
    const records = [...handedOver(), relayed("received", at(1, 10))];
    expect(reasonsAt(records, agentsWith({ worker: "running" }), when(59))).toEqual([]);
    expect(reasonsAt(records, agentsWith({ reviewer: "running" }), when(59))).toEqual([]);
  });

  it("a running Manager does not mask a stall: it is shared by every request of its workspace", () => {
    const idle = [...handedOver(), relayed("received", at(1, 10))];
    expect(reasonsAt(idle, agentsWith({ manager: "running" }), when(20))).toEqual([{ reason: "idle-unfinished", since: at(3) }]);
  });

  it("a finished request, and a request the Manager answered itself, raise none", () => {
    const finished = [...handedOver(), relayed("received", at(1, 10)), relayed("finished", at(5))];
    expect(reasonsAt(finished, agentsWith(), when(59))).toEqual([]);
    const answered = [handedOver()[0]!];
    expect(reasonsAt(answered, [agent({ id: MANAGER, role: "manager" })], when(59))).toEqual([]);
  });
});

// ── The watcher ─────────────────────────────────────────────────────────────

interface FakeAgent {
  id: string;
  provider: string;
  status: string;
  workspaceId: string;
  labels: Record<string, string>;
  title?: string;
  createdAt?: string;
  archivedAt?: string | null;
}

/** A current Orchestrator: created with this plugin's instructions (design §3.3). */
const orchestratorAgent = (extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id: ORCHESTRATOR,
  provider: "bm-orchestrator/claude-opus-5-5",
  status: "idle",
  workspaceId: "wks-own",
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
  createdAt: at(0),
  ...extra,
});

function fakeAgentsFor(status: { manager?: string; worker?: string } = {}): FakeAgent[] {
  return [
    { id: MANAGER, provider: "bm-manager", status: status.manager ?? "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" }, title: "Invoice Manager", createdAt: at(0) },
    {
      id: WORKER,
      provider: "bm-worker",
      status: status.worker ?? "idle",
      workspaceId: WORKSPACE_ID,
      labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER, "bm.requestId": REQUEST_ID },
      createdAt: at(0, 30),
    },
  ];
}

/**
 * The shared fake SDK: `send` records and starts a turn; replacing an outdated
 * Orchestrator (orchestrator-agent.ts) opens its own workspace and creates one
 * agent. The stall pass never reads a timeline: the tests check `refetches`.
 */
function daemonWith(initial: FakeAgent[]) {
  return fakePaseo({
    agents: initial,
    workspaces: [{ id: WORKSPACE_ID, name: "invoice-app", directory: "/work/invoice-app" }],
    config: {
      providers: { "bm-orchestrator": { extends: "claude", label: "Beads Orchestrator" } },
      agentProfiles: [{ id: "bm-orchestrator", name: "Beads Orchestrator", provider: "bm-orchestrator", model: "claude-opus-5-5" }],
    },
    providers: {
      available: ["claude"],
      modes: () => [{ id: "default", label: "Default", colorTier: "safe" }, { id: "auto", label: "Auto", colorTier: "moderate" }],
    },
    created: (_request, { n }) => ({ id: `agent-orchestrator-new-${n}`, createdAt: at(30) }),
  });
}

/** The second Worker, on the daemon. */
const secondWorker = (status: string): FakeAgent => ({
  id: WORKER_2,
  provider: "bm-worker",
  status,
  workspaceId: WORKSPACE_ID,
  labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER, "bm.requestId": REQUEST_2 },
  createdAt: at(10, 30),
});

let root: string;
let home: string;
let queue: NoticeQueue;
let clock: Date;
let deps: StallWatcherDeps;
let watchers: StallWatcher[];

const location = () => ({ tracesDir: join(home, "traces") });
const alerts = () => createAlertStore(home, { now: () => clock });
const alertOf = (requestId = REQUEST_ID, workspaceId = WORKSPACE_ID) => alertKeyOf("request-stalled", workspaceId, requestId);
/** Puts a project in the events' scope: one class above `owner` in the policy. */
const inScope = (workspaceId = WORKSPACE_ID, mode: "shadow" | "delegate" = "shadow") =>
  createAutonomyStore(home).set({ workspaceId, class: "scope", mode, confirmed: true }, clock.toISOString());

async function seed(records: TraceRecord[]): Promise<void> {
  for (const record of records) await appendRecord(location(), record);
  writeWorkspaceMeta(location(), WORKSPACE_ID, { lastKnownName: "invoice-app", lastKnownDirectory: "/work/invoice-app", lastSeenAt: records.at(-1)!.endedAt });
  clearTraceStoreCache();
}

/** A watcher whose bus delivers through the test's private queue. */
function watcher(extra: StallWatcherDeps & Pick<EventBusDeps, "isToolsStale"> = {}): StallWatcher {
  const merged = { ...deps, ...extra };
  const bus = createEventBus({ ...merged, queue });
  const created = createStallWatcher({ ...merged, bus });
  watchers.push(created);
  return created;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-stall-watcher-"));
  home = join(root, "data");
  queue = createNoticeQueue({ log: () => {} });
  clock = when(20);
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => clock, log: () => {}, redactEnv: {} };
  watchers = [];
  clearTraceStoreCache();
});

afterEach(() => {
  for (const entry of watchers) entry.stop();
  queue.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("the pass: one Inbox alert per stalled request, of every project", () => {
  it("raises the alert once, for an all-owner project and without an Orchestrator, and messages nobody", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);

    const first = await stalls.pass();
    expect(first).toMatchObject({ status: "done", raised: [alertOf()], cleared: [], events: [] });
    expect(alerts().list({ open: true })).toEqual([
      { key: alertOf(), workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: REQUEST_ID, since: when(20).toISOString(), clearedAt: null, detail: "idle-unfinished" },
    ]);
    // Later passes see the same stall: nothing raised again.
    clock = when(40);
    expect(await stalls.pass()).toMatchObject({ raised: [], cleared: [] });
    expect(fake.sends).toEqual([]);
    expect(fake.creates).toEqual([]);
    // No timeline read, ever.
    expect(fake.refetches).toEqual([]);
  });

  it("a healthy running request, or one waiting on the owner, raises nothing", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const fake = daemonWith([...fakeAgentsFor({ worker: "running" }), orchestratorAgent()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });

    await seed([relayed("blocked", at(4))]);
    // The Worker's question is open in the decision store: it waits in the Inbox.
    const question = makeDecision({ workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, askedAt: at(4) });
    createDecisionStore(home).open(question);
    fake.byId(WORKER)!.status = "idle";
    clock = when(59);
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });
    expect(alerts().list()).toEqual([]);

    // Answered, and the Worker never went on: blocked on nothing — the stall the field met on 2026-10-01.
    createDecisionStore(home).transition(question.id, (decision) => answerDecision(decision, { optionKey: "c", via: "inbox", at: at(58) }), WORKSPACE_ID);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()] });
  });

  it("clears the alert when an agent runs, and raises it afresh once it holds again", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);

    expect((await stalls.pass()).raised).toEqual([alertOf()]);
    fake.byId(WORKER)!.status = "running";
    clock = when(21);
    expect(await stalls.pass()).toMatchObject({ raised: [], cleared: [alertOf()] });
    expect(alerts().list({ open: true })).toEqual([]);

    fake.byId(WORKER)!.status = "idle";
    clock = when(22);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()] });
    expect(alerts().list({ open: true })).toMatchObject([{ since: when(22).toISOString(), clearedAt: null }]);
  });

  it("clears the alert when a new report arrives, and when the request leaves the 24-hour window", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    await stalls.pass();
    await seed([relayed("finished", at(20, 30))]);
    clock = when(21);
    expect(await stalls.pass()).toMatchObject({ raised: [], cleared: [alertOf()] });

    // A fresh stall, then the window moves past it.
    await seed([relayed("received", at(21, 10))]);
    clock = when(30);
    expect((await stalls.pass()).raised).toEqual([alertOf()]);
    clock = new Date(when(21).getTime() + 24 * 3_600_000 + 60_000);
    expect(await stalls.pass()).toMatchObject({ raised: [], cleared: [alertOf()] });
  });

  // Bead 7gxw.12 (autonomy design §G.7): the pass reads the owner's review budget per tier, 2 / 2 / 4 by default.
  it("judges review-over-budget by the owner's review budget in Settings → Coordination", async () => {
    const reviewCall = (minute: number) =>
      turn({
        agentId: REVIEWER,
        role: "reviewer",
        at: at(minute, 30),
        turnId: `r-${minute}`,
        requestId: REQUEST_ID,
        parentAgentId: WORKER,
        startedAt: at(minute),
        endedAt: at(minute, 30),
        sent: [msg(REVIEWER, at(minute), `Review batch b1 of ${REQUEST_ID}, stage implementation, round ${minute}.`, "agent")],
        received: [msg(REVIEWER, at(minute, 30), `BM-REVIEW\nrequestId: ${REQUEST_ID}\nbatchId: b1\nverdict: changes-required`)],
      });
    // A Medium request with three review calls, its agents idle, a minute after the last: over 2, within 3.
    await seed([...handedOver(), relayed("received", at(1, 10)), reviewCall(4), reviewCall(5), reviewCall(6)]);
    const reviewer: FakeAgent = {
      id: REVIEWER,
      provider: "bm-reviewer",
      status: "idle",
      workspaceId: WORKSPACE_ID,
      labels: { "bm.role": "reviewer", "paseo.parent-agent-id": WORKER, "bm.requestId": REQUEST_ID },
      createdAt: at(4),
    };
    const fake = daemonWith([...fakeAgentsFor(), reviewer]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    clock = when(7, 30);
    createCoordinationStore(home).set({ key: "review.mediumBudget", value: 3 });
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });
    createCoordinationStore(home).set({ key: "review.mediumBudget", value: 2 });
    expect((await stalls.pass()).raised).toEqual([alertOf()]);
    expect(alerts().list({ open: true })).toMatchObject([{ detail: "review-over-budget" }]);
  });

  it("does nothing before a Paseo handle arrives", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const stalls = watcher();
    expect(await stalls.pass()).toMatchObject({ status: "no-paseo" });
    stalls.usePaseo({ not: "a handle" });
    expect(await stalls.pass()).toMatchObject({ status: "no-paseo" });
    expect(alerts().list()).toEqual([]);
  });
});

describe("request.stalled: an event for the Orchestrator of a project in the policy's scope only", () => {
  it("publishes the event once, as one BM-EVENTS message to the Orchestrator and nobody else", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope();
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);

    const first = await stalls.pass();
    expect(first.events).toEqual([
      { type: "request.stalled", workspaceId: WORKSPACE_ID, requestKey: REQUEST_ID, managerId: MANAGER, reason: "idle-unfinished", alertKey: alertOf(), since: when(20).toISOString() },
    ]);
    expect(fake.sends).toEqual([
      {
        id: ORCHESTRATOR,
        text: [
          "BM-EVENTS",
          "From the paseo-bm plugin, not the owner: 1 event, oldest first. Look before you act; when nothing needs doing, do nothing.",
          `- request.stalled idle-unfinished — project ${WORKSPACE_ID}, request ${REQUEST_ID}, Manager ${MANAGER}, since ${when(20).toISOString()}. Look with bm_request.`,
        ].join("\n"),
      },
    ]);
    clock = when(40);
    expect((await stalls.pass()).events).toEqual([]);
    expect(fake.sends).toHaveLength(1);
  });

  it("an all-owner project gets its alert and no event, whatever the other projects' cells", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope("wks_other");
    // A cell set back to owner leaves the project all-owner.
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "scope", mode: "owner" }, clock.toISOString());
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()], events: [] });
    expect(fake.sends).toEqual([]);
  });

  it("a project with a delegated class gets the event as well", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope(WORKSPACE_ID, "delegate");
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()], events: [expect.objectContaining({ type: "request.stalled", workspaceId: WORKSPACE_ID })] });
    expect(fake.sends.map((sent) => sent.id)).toEqual([ORCHESTRATOR]);
  });

  it("drops the event when the stall ends before the Orchestrator is idle", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope();
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent({ status: "running" })]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    expect((await stalls.pass()).events).toHaveLength(1);
    expect(queue.pending(ORCHESTRATOR)).toHaveLength(1);

    // The Worker runs again: the alert is cleared, so the queued event is settled.
    fake.byId(WORKER)!.status = "running";
    clock = when(21);
    expect((await stalls.pass()).cleared).toEqual([alertOf()]);
    fake.byId(ORCHESTRATOR)!.status = "idle";
    await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(queue.pending(ORCHESTRATOR)).toEqual([]);
  });

  it("without an Orchestrator only the alert is kept; one opened later is not told about it", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope();
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    expect((await stalls.pass()).raised).toEqual([alertOf()]);
    fake.agents.push({ ...orchestratorAgent() });
    clock = when(25);
    await stalls.pass();
    expect(fake.sends).toEqual([]);
    // No Orchestrator is ever created for an event.
    expect(fake.creates).toEqual([]);
  });

  it.each([
    ["outdated (created before its instructions were labelled)", { labels: { "bm.role": "orchestrator", "bm.orchestrator": "main" } }, {}],
    ["tools-stale (created before the endpoint's secret)", {}, { isToolsStale: toolsStaleSince(new Date(at(0, 30))) }],
  ] as Array<[string, Partial<FakeAgent>, StallWatcherDeps]>)(
    "an Orchestrator that is %s is replaced once, and the new one gets the events; the old one is left alone",
    async (_case, extra, extraDeps) => {
      await seed([...handedOver(), relayed("received", at(1, 10))]);
      inScope();
      const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent(extra)]);
      const stalls = watcher(extraDeps);
      stalls.usePaseo(fake.paseo);

      expect((await stalls.pass()).events).toHaveLength(1);
      expect(fake.creates).toHaveLength(1);
      expect(fake.creates[0]!.options.labels).toMatchObject({ "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH });
      expect(fake.sends.map((sent) => [sent.id, sent.text.split("\n")[0]])).toEqual([["agent-orchestrator-new-1", "BM-EVENTS"]]);
      expect(fake.byId(ORCHESTRATOR)?.archivedAt).toBeUndefined();
    },
  );
});

describe("every request of a Manager is watched, and the shared Manager is left out (regression of 2026-09-28)", () => {
  it("a stalled request of a Manager that has a newer, running request is still raised; both stall on their own", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10)), ...secondRequest()]);
    const fake = daemonWith([...fakeAgentsFor({ manager: "running" }), secondWorker("running")]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);

    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()], cleared: [] });
    fake.byId(WORKER_2)!.status = "idle";
    fake.byId(MANAGER)!.status = "idle";
    clock = when(21);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf(REQUEST_2)], cleared: [] });
    expect(alerts().list({ open: true }).map((alert) => alert.subject)).toEqual([REQUEST_ID, REQUEST_2]);
  });
});

describe("the timer: always on (the Watch switch is gone)", () => {
  it("start() sets one unref'd pass a minute; stop() ends it and nothing more runs", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const fake = daemonWith(fakeAgentsFor());
    vi.useFakeTimers({ now: when(20) });
    const stalls = watcher({ now: undefined });
    stalls.usePaseo(fake.paseo);
    stalls.start();
    stalls.start();
    expect(vi.getTimerCount()).toBe(1);
    expect(stalls.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(STALL_PASS_MS - 1);
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.paseo.agents.list).toHaveBeenCalledTimes(1);

    stalls.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(stalls.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * STALL_PASS_MS);
    expect(fake.paseo.agents.list).toHaveBeenCalledTimes(1);
  });

  it("a pass under way when the timer stops writes and publishes nothing more", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope();
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    stalls.start();
    const list = fake.paseo.agents.list.getMockImplementation()!;
    fake.paseo.agents.list.mockImplementationOnce(async (options) => {
      stalls.stop();
      return list(options);
    });
    expect(await stalls.pass()).toMatchObject({ status: "off" });
    expect(fake.sends).toEqual([]);
    expect(alerts().list()).toEqual([]);
  });
});

describe("workerTurnEnded", () => {
  it("clears the Worker's alerts, and only a Beads Worker's", () => {
    const store = alerts();
    store.raise({ workspaceId: WORKSPACE_ID, kind: "stuck", subject: WORKER });
    store.raise({ workspaceId: WORKSPACE_ID, kind: "danger", subject: WORKER });
    store.raise({ workspaceId: WORKSPACE_ID, kind: "permission-waiting", subject: WORKER_2 });
    const stalls = watcher();
    expect(stalls.workerTurnEnded({ id: WORKER, provider: "bm-manager" })).toEqual([]);
    expect(stalls.workerTurnEnded({ id: WORKER, provider: "bm-worker" }).sort()).toEqual(
      [alertKeyOf("danger", WORKSPACE_ID, WORKER), alertKeyOf("stuck", WORKSPACE_ID, WORKER)].sort(),
    );
    expect(alerts().list({ open: true }).map((alert) => alert.subject)).toEqual([WORKER_2]);
  });
});
