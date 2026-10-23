import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  IDLE_UNFINISHED_MS,
  PEER_SILENT_MS,
  PEER_UNANSWERED_MS,
  STALL_PASS_MS,
  createStallWatcher,
  peerCeilingOf,
  progressSinceOf,
  stallReasonsOf,
  unansweredOf,
  type StallWatcher,
  type StallWatcherDeps,
} from "../plugin/server/stall-watcher";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { reconstructTraces, type AgentFacts, type ReconstructedTrace } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import { alertKeyOf } from "../plugin/shared/alerts";
import { flagsOf } from "../plugin/shared/orchestrator-rules";
import { PEER_WAIT_SLACK_MS, ruleInputOf, waitedLinksOf, waitingSinceOf } from "../plugin/server/request-trace";
import { createPeerLinkStore, type PeerLink } from "../plugin/server/peer-links";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, agent, at, factsWith, msg, report, shell, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";
import { makeDecision } from "./helpers/decisions";
import { createDecisionStore } from "../plugin/server/decision-store";
import { answerDecision } from "../plugin/shared/decisions";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { REQUESTS_DIR_NAME, clearRequestRegistryCache, type RegisteredRequest } from "../plugin/server/request-registry";
import type { SettledWait } from "../plugin/server/waits";
import { structuralWaitOf, type StructuralWaitFacts } from "../plugin/shared/structural-wait";
import type { Waiting } from "../plugin/shared/waits";

/**
 * The stall pass (Orchestrator design §6, §12; autonomy design §A.8): the two
 * reasons on fixtures; one `request-stalled` Inbox alert per stalled request
 * of every project, raised once, cleared only on progress and raised again; a `request.stalled`
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
function relayed(phase: "received" | "blocked" | "finished" | "stopped", reportAt: string, extra: { endedAt?: string; turnId?: string; unparsed?: string[] } = {}) {
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
  const flags = flagsOf(ruleInputOf(trace), factsWith());
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
      return stallReasonsOf(trace, facts, flagsOf(ruleInputOf(trace), factsWith()), when(59), waitsOnOwner).map((entry) => entry.reason);
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
    // Three calls of one batch, past a cap of 2 (review.callsPerBatch 2: delivery line design §5.3).
    expect(trace.reviewCalls).toBe(3);
    expect(flagsOf(ruleInputOf(trace), factsWith())).toEqual([]);
    const flags = flagsOf(ruleInputOf(trace), factsWith({ review: { callsPerBatch: 2 } }));
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

  it("keeps the alert while an agent only runs: a blocked request woken again and again no longer flips; a report clears it (delivery line design §8.4)", async () => {
    // Blocked on nothing the Inbox holds: it stalls.
    await seed([...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))]);
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    expect((await stalls.pass()).raised).toEqual([alertOf()]);

    // Woken every other minute for 20 minutes: each wake-up runs a turn that reports nothing.
    for (let minute = 21; minute <= 40; minute += 1) {
      const running = minute % 2 === 1;
      fake.byId(WORKER)!.status = running ? "running" : "idle";
      if (!running) {
        await seed([turn({ agentId: WORKER, role: "worker", turnId: `w-wake-${minute}`, requestId: REQUEST_ID, parentAgentId: MANAGER, startedAt: at(minute - 1), endedAt: at(minute - 1, 50), at: at(minute - 1, 50) })]);
      }
      clock = when(minute);
      expect(await stalls.pass(), `minute ${minute}`).toMatchObject({ raised: [], cleared: [] });
    }
    expect(alerts().list()).toMatchObject([{ key: alertOf(), since: when(20).toISOString(), clearedAt: null }]);

    // A report is progress: the alert clears, and is raised afresh once it holds again.
    await seed([relayed("received", at(40, 30), { turnId: "m-progress" })]);
    clock = when(41);
    expect(await stalls.pass()).toMatchObject({ raised: [], cleared: [alertOf()] });
    clock = when(46);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()] });
    expect(alerts().list({ open: true })).toMatchObject([{ since: when(46).toISOString(), clearedAt: null }]);
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

  // Delivery line design §5.3: the pass reads the owner's review.callsPerBatch for the request's cap (3 by default).
  it("judges review-over-budget by the request's review cap, from the owner's review.callsPerBatch in Settings → Coordination", async () => {
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
    // A Medium request with three review calls of one batch, its agents idle, a minute after the last: within a cap of 3, over 2.
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
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });
    createCoordinationStore(home).set({ key: "review.callsPerBatch", value: 2 });
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

describe("request.stalled: built for a project in the policy's scope, retired as a wake (missions design §9.1)", () => {
  it("builds the event once but tells the Orchestrator nothing: the stall stays an Inbox alert", async () => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope();
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);

    const first = await stalls.pass();
    expect(first.raised).toEqual([alertOf()]);
    expect(first.events).toEqual([
      { type: "request.stalled", workspaceId: WORKSPACE_ID, requestKey: REQUEST_ID, managerId: MANAGER, reason: "idle-unfinished", alertKey: alertOf(), since: when(20).toISOString() },
    ]);
    expect(fake.sends).toEqual([]);
    expect(queue.pending(ORCHESTRATOR)).toEqual([]);
    clock = when(40);
    expect((await stalls.pass()).events).toEqual([]);
    expect(fake.sends).toEqual([]);
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
  ] as Array<[string, Partial<FakeAgent>, StallWatcherDeps]>)("an Orchestrator that is %s is not replaced for a stall: nothing wakes it", async (_case, extra, extraDeps) => {
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    inScope(WORKSPACE_ID, "delegate");
    const fake = daemonWith([...fakeAgentsFor(), orchestratorAgent(extra)]);
    const stalls = watcher(extraDeps);
    stalls.usePaseo(fake.paseo);

    expect(await stalls.pass()).toMatchObject({ raised: [alertOf()], events: [expect.objectContaining({ type: "request.stalled", workspaceId: WORKSPACE_ID })] });
    expect(fake.creates).toEqual([]);
    expect(fake.sends).toEqual([]);
    expect(fake.byId(ORCHESTRATOR)?.archivedAt).toBeUndefined();
  });
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

// ── Waiting on another project (design §7.17.5) ─────────────────────────────

const PEER_WS = "wks_backend";
const PEER_REQUEST = "req-20260926T090000Z";
const PEER_WORKER = "agent-backend-worker";

/** A link `REQUEST_ID` asked of the backend project, as the store keeps it. */
function peerLink(overrides: Partial<PeerLink> = {}): PeerLink {
  return {
    linkId: "peer-000000000001",
    createdAt: at(2),
    kind: "work",
    from: { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, agentId: WORKER, role: "worker" },
    to: { workspaceId: PEER_WS, managerId: "agent-backend-manager", requestId: PEER_REQUEST, workerId: PEER_WORKER },
    chain: { workspaces: [WORKSPACE_ID], depth: 1 },
    waitingSince: at(4),
    text: "Add the /export endpoint.",
    state: "taken",
    takenAt: at(3),
    answeredAt: null,
    closedAt: null,
    closedBy: null,
    messages: [],
    ...overrides,
  };
}

const answerer = (minute: number): PeerLink["messages"][number] => ({
  recordId: "out-000000000001",
  workspaceId: PEER_WS,
  side: "answerer",
  agentId: PEER_WORKER,
  at: at(minute),
  kind: "peer-message",
  phase: null,
  gist: "On it.",
});

describe("progressSinceOf (pure, delivery line design §8.4)", () => {
  it("a report, a review result or a bead closed after the alert is progress; a turn that only ran is none", () => {
    const since = at(20);
    const ran = turn({ agentId: WORKER, role: "worker", turnId: "w-ran", endedAt: at(25), evidence: [{ ...shell("npm test", at(24)), status: "completed" }] });
    const quiet = { records: [ran], reports: [report({ at: at(10) })], reviews: [] };
    expect(progressSinceOf(quiet, since)).toBe(false);
    expect(progressSinceOf({ ...quiet, reports: [report({ at: at(21) })] }, since)).toBe(true);

    const review = { agentId: REVIEWER, at: at(22), batchId: "b1", verdict: "pass", blockingCount: 0 };
    expect(progressSinceOf({ ...quiet, reviews: [review] }, since)).toBe(true);
    expect(progressSinceOf({ ...quiet, reviews: [{ ...review, verdict: null }] }, since)).toBe(false);
    expect(progressSinceOf({ ...quiet, reviews: [{ ...review, at: at(19) }] }, since)).toBe(false);

    const closing = (status: string, endedAt: string) =>
      turn({ agentId: WORKER, role: "worker", turnId: `w-close-${status}`, endedAt, evidence: [{ ...shell("br close bm-1 --reason 'tests pass'", endedAt), status }] });
    expect(progressSinceOf({ ...quiet, records: [ran, closing("completed", at(26))] }, since)).toBe(true);
    // A failed close, or one before the alert, is none.
    expect(progressSinceOf({ ...quiet, records: [ran, closing("failed", at(26))] }, since)).toBe(false);
    expect(progressSinceOf({ ...quiet, records: [closing("completed", at(19))] }, since)).toBe(false);
  });
});

describe("the peer wait (pure, design §7.17.5)", () => {
  const blocked = () => traceOf([...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))], agentsWith()).trace;

  it("a blocked request waits on the live links it asked whose wait is from that report; waitingSinceOf counts it", () => {
    const trace = blocked();
    expect(waitedLinksOf(trace, WORKSPACE_ID, [peerLink()]).map((link) => link.linkId)).toEqual(["peer-000000000001"]);
    // bm_report notes the wait a moment before its record is stored.
    expect(waitedLinksOf(trace, WORKSPACE_ID, [peerLink({ waitingSince: new Date(when(4).getTime() - PEER_WAIT_SLACK_MS).toISOString() })])).toHaveLength(1);
    // An older wait, no wait, a link no longer live, another request's or another workspace's: no peer wait.
    expect(waitedLinksOf(trace, WORKSPACE_ID, [peerLink({ waitingSince: at(2) })])).toEqual([]);
    expect(waitedLinksOf(trace, WORKSPACE_ID, [peerLink({ waitingSince: null })])).toEqual([]);
    expect(waitedLinksOf(trace, WORKSPACE_ID, [peerLink({ state: "answered" }), peerLink({ state: "closed" })])).toEqual([]);
    expect(waitedLinksOf(trace, WORKSPACE_ID, [peerLink({ from: { ...peerLink().from, requestId: REQUEST_2 } })])).toEqual([]);
    expect(waitedLinksOf(trace, "wks_other", [peerLink()])).toEqual([]);
    // Not blocked: no wait.
    const working = traceOf([...handedOver(), relayed("received", at(1, 10))], agentsWith()).trace;
    expect(waitedLinksOf(working, WORKSPACE_ID, [peerLink()])).toEqual([]);
    expect(waitingSinceOf(trace)).toBe(at(4));
  });

  it("stallReasonsOf: a blocked request waiting on a peer is no idle-unfinished, even with its questions answered", () => {
    const { trace, facts } = traceOf([...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))], agentsWith());
    const flags = flagsOf(ruleInputOf(trace), factsWith());
    expect(stallReasonsOf(trace, facts, flags, when(59), false, true)).toEqual([]);
    expect(stallReasonsOf(trace, facts, flags, when(59), false, false).map((entry) => entry.reason)).toEqual(["idle-unfinished"]);
  });

  it("the ceiling: taken with no live agent of the answering request, or 2 hours without a word from the answering side", () => {
    expect(peerCeilingOf(peerLink(), when(59), () => true)).toBeNull();
    expect(peerCeilingOf(peerLink(), when(59), () => false)).toBe(
      `peer-000000000001: taken by request ${PEER_REQUEST} of project ${PEER_WS}, which has no live agent`,
    );
    const twoHours = new Date(when(4).getTime() + PEER_SILENT_MS);
    expect(peerCeilingOf(peerLink(), new Date(twoHours.getTime() - 1000), () => true)).toBeNull();
    expect(peerCeilingOf(peerLink(), twoHours, () => true)).toBe(`peer-000000000001: no word from project ${PEER_WS} for 2 hours`);
    // An open link waited on is only silent: nobody took it yet.
    expect(peerCeilingOf(peerLink({ state: "open" }), twoHours, () => false)).toMatch(/for 2 hours$/);
    // A word from the answering side restarts the clock; one from the asker does not.
    expect(peerCeilingOf(peerLink({ messages: [answerer(30)] }), twoHours, () => true)).toBeNull();
    expect(peerCeilingOf(peerLink({ messages: [{ ...answerer(30), side: "asker" }] }), twoHours, () => true)).not.toBeNull();
  });

  it("unansweredOf: open for 10 minutes with no word from the answering side; taken, answered on, or younger is fine", () => {
    const open = peerLink({ state: "open", waitingSince: null, to: { ...peerLink().to, requestId: null, workerId: null } });
    const tenMinutes = new Date(when(2).getTime() + PEER_UNANSWERED_MS);
    expect(unansweredOf(open, new Date(tenMinutes.getTime() - 1000))).toBeNull();
    expect(unansweredOf(open, tenMinutes)).toBe(`peer-000000000001: project ${PEER_WS} has not taken it for 10 minutes`);
    expect(unansweredOf({ ...open, state: "taken" }, tenMinutes)).toBeNull();
    expect(unansweredOf({ ...open, messages: [answerer(5)] }, tenMinutes)).toBeNull();
  });
});

describe("the pass: a request waiting on another project (design §7.17.5)", () => {
  const backendWorker = (): FakeAgent => ({
    id: PEER_WORKER,
    provider: "bm-worker",
    status: "idle",
    workspaceId: PEER_WS,
    labels: { "bm.role": "worker", "bm.requestId": PEER_REQUEST },
    createdAt: at(3),
  });
  const links = () => createPeerLinkStore(home, { now: () => clock, newId: () => "peer-000000000001", env: {} });
  const peerAlertOf = (requestId = REQUEST_ID) => alertKeyOf("peer-unanswered", WORKSPACE_ID, requestId);

  /** `REQUEST_ID` asks the backend at `clock`; `taken`: the backend's request took it. */
  function ask(taken: boolean): string {
    const made = links().createLink({
      kind: "work",
      from: { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, agentId: WORKER, role: "worker" },
      to: { workspaceId: PEER_WS, managerId: "agent-backend-manager" },
      text: "Add the /export endpoint.",
    });
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    if (taken) links().takeLink(made.link.linkId, { workspaceId: PEER_WS, requestId: PEER_REQUEST, workerId: PEER_WORKER });
    return made.link.linkId;
  }

  async function waiting(): Promise<{ fake: ReturnType<typeof daemonWith>; stalls: StallWatcher; linkId: string }> {
    clock = when(2);
    const linkId = ask(true);
    await seed([...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))]);
    links().setWaiting(WORKSPACE_ID, REQUEST_ID, [linkId], at(4));
    const fake = daemonWith([...fakeAgentsFor(), backendWorker()]);
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    return { fake, stalls, linkId };
  }

  it("raises nothing while the answering request has a live agent; stalls and raises peer-unanswered once none is left", async () => {
    const { fake, stalls, linkId } = await waiting();
    clock = when(59);
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });
    expect(alerts().list()).toEqual([]);

    fake.byId(PEER_WORKER)!.archivedAt = at(58);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf(), peerAlertOf()], cleared: [] });
    expect(alerts().list({ open: true }).find((alert) => alert.kind === "peer-unanswered")).toMatchObject({
      workspaceId: WORKSPACE_ID,
      subject: REQUEST_ID,
      detail: `${linkId}: taken by request ${PEER_REQUEST} of project ${PEER_WS}, which has no live agent`,
    });

    // Closed by the asker: no wait any more, and nothing left unanswered.
    links().closeLink(linkId, "asker");
    expect((await stalls.pass()).cleared).toEqual([peerAlertOf()]);
    expect(alerts().list({ open: true }).map((alert) => alert.kind)).toEqual(["request-stalled"]);
  });

  it("after 2 hours without a word from the answering side the request stalls; a word clears both alerts", async () => {
    const { stalls, linkId } = await waiting();
    clock = new Date(when(4).getTime() + PEER_SILENT_MS);
    expect(await stalls.pass()).toMatchObject({ raised: [alertOf(), peerAlertOf()] });
    expect(alerts().list({ open: true }).find((alert) => alert.kind === "peer-unanswered")?.detail).toBe(`${linkId}: no word from project ${PEER_WS} for 2 hours`);

    links().appendMessage(linkId, { recordId: "out-000000000001", workspaceId: PEER_WS, side: "answerer", agentId: PEER_WORKER, kind: "peer-message", text: "Half done." });
    expect((await stalls.pass()).cleared.sort()).toEqual([alertOf(), peerAlertOf()].sort());
    expect(alerts().list({ open: true })).toEqual([]);
  });

  it("an ask nobody took for 10 minutes raises peer-unanswered, cleared when it is taken", async () => {
    clock = when(20);
    const linkId = ask(false);
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    clock = new Date(when(20).getTime() + PEER_UNANSWERED_MS - 1000);
    expect((await stalls.pass()).raised).toEqual([]);
    clock = new Date(when(20).getTime() + PEER_UNANSWERED_MS);
    expect((await stalls.pass()).raised).toEqual([peerAlertOf()]);
    expect(alerts().list({ open: true })).toMatchObject([{ kind: "peer-unanswered", detail: `${linkId}: project ${PEER_WS} has not taken it for 10 minutes` }]);
    // Later passes: raised once.
    expect((await stalls.pass()).raised).toEqual([]);

    links().takeLink(linkId, { workspaceId: PEER_WS, requestId: PEER_REQUEST, workerId: PEER_WORKER });
    expect((await stalls.pass()).cleared).toEqual([peerAlertOf()]);
    expect(fake.sends).toEqual([]);
  });

  it.each(["finished", "stopped"] as const)("an asking request whose newest report is %s raises no peer-unanswered, and clears the one it had", async (phase) => {
    clock = when(2);
    const linkId = ask(false);
    await seed([...handedOver(), relayed("received", at(1, 10))]);
    const fake = daemonWith(fakeAgentsFor());
    const stalls = watcher();
    stalls.usePaseo(fake.paseo);
    clock = new Date(when(2).getTime() + PEER_UNANSWERED_MS);
    expect((await stalls.pass()).raised).toContain(peerAlertOf());

    await seed([relayed(phase, at(11, 30))]);
    expect((await stalls.pass()).cleared).toContain(peerAlertOf());
    expect(alerts().list({ open: true }).map((alert) => alert.kind)).not.toContain("peer-unanswered");
    // Later passes raise it no more; the pass never changes the link.
    expect((await stalls.pass()).raised).toEqual([]);
    expect(links().get(linkId)!.state).toBe("open");
  });
});

// ── Waits by structure (delivery line design §6.5) ──────────────────────────

const waitOn = (items: Array<Pick<Waiting["items"][number], "kind" | "id">>, wakeOn: Waiting["wakeOn"] = "all"): Waiting => ({
  since: at(4),
  reportRecordId: "out-000000000001",
  wakeOn,
  items: items.map((item) => ({ ...item, settled: false })),
});

describe("structuralWaitOf (pure, delivery line design §6.5)", () => {
  const facts = (over: Partial<StructuralWaitFacts> = {}): StructuralWaitFacts => ({
    now: at(30),
    pendingMs: 10 * 60_000,
    question: (id) => (id === "q:open" ? "open" : id === "q:answered" ? "closed" : null),
    request: (id) =>
      id === REQUEST_2
        ? { headId: REQUEST_2, state: "active", workers: 1, liveWorker: true }
        : id === "req-20260926T090000Z"
          ? { headId: "req-20260926T095000Z", state: "active", workers: 1, liveWorker: false }
          : null,
    link: (id) => (id === "peer-live" ? { state: "taken", closedBy: null, ceiling: null } : null),
    isRunning: () => false,
    ...over,
  });
  const batch = (callAt: string, results: Array<{ at: string }> | undefined = undefined) => ({
    batchId: "b1",
    reviewerIds: [REVIEWER],
    calls: [{ at: callAt, reviewerId: REVIEWER }],
    ...(results === undefined ? {} : { results }),
  });

  it("holds while every unsettled item is live: an open question, a running Reviewer or a young call, an active request with a live Worker, a link under its ceiling", () => {
    const waiting = waitOn([
      { kind: "question", id: "q:open" },
      { kind: "request", id: REQUEST_2 },
      { kind: "link", id: "peer-live" },
      { kind: "batch", id: "b1" },
    ]);
    // The call is 5 minutes old: within the pending window.
    expect(structuralWaitOf({ waiting, reviews: { batches: [batch(at(25))] } }, facts())).toMatchObject({ holds: true, dead: [] });
    // An hour-old call whose Reviewer runs.
    expect(structuralWaitOf({ waiting, reviews: { batches: [batch(at(0))] } }, facts({ isRunning: (id) => id === REVIEWER })).holds).toBe(true);
    // A settled item is not judged; a wait that is met holds nothing.
    const met = { ...waiting, wakeOn: "any" as const, items: waiting.items.map((item, i) => (i === 0 ? { ...item, settled: true } : item)) };
    expect(structuralWaitOf({ waiting: met, reviews: { batches: [batch(at(25))] } }, facts())).toMatchObject({ holds: false, dead: [] });
  });

  it("each dead item kind carries its fact; an unknown item, or none at all, holds nothing", () => {
    const dead = (item: Pick<Waiting["items"][number], "kind" | "id">, over: Partial<StructuralWaitFacts> = {}, batches = [batch(at(0))]) =>
      structuralWaitOf({ waiting: waitOn([item]), reviews: { batches } }, facts(over));
    expect(dead({ kind: "batch", id: "b1" })).toMatchObject({ holds: false, dead: [{ item: { id: "b1" }, fact: "b1 got no verdict: no Reviewer of it is running" }] });
    // A verdict since the call: settled without a fact (its hook missed it).
    expect(dead({ kind: "batch", id: "b1" }, {}, [batch(at(0), [{ at: at(1) }])]).dead).toEqual([{ item: expect.objectContaining({ id: "b1" }) }]);
    expect(dead({ kind: "request", id: REQUEST_2 }, { request: () => ({ headId: REQUEST_2, state: "stopped", workers: 1, liveWorker: true }) }).dead[0]!.fact).toBe(`${REQUEST_2} stopped`);
    expect(dead({ kind: "request", id: REQUEST_2 }, { request: () => ({ headId: "req-20260926T110000Z", state: "finished", workers: 1, liveWorker: false }) }).dead[0]!.fact).toBe(
      `${REQUEST_2} finished as req-20260926T110000Z`,
    );
    expect(dead({ kind: "request", id: "req-20260926T090000Z" }).dead[0]!.fact).toBe("req-20260926T090000Z has no live Worker left (as req-20260926T095000Z)");
    expect(dead({ kind: "link", id: "peer-a" }, { link: () => ({ state: "taken", closedBy: null, ceiling: "peer-a: no word from project wks_backend for 2 hours" }) }).dead[0]!.fact).toBe(
      "peer-a: no word from project wks_backend for 2 hours",
    );
    expect(dead({ kind: "link", id: "peer-a" }, { link: () => ({ state: "closed", closedBy: "answerer", ceiling: null }) }).dead[0]!.fact).toBe("peer-a closed by the answering side");
    expect(dead({ kind: "question", id: "q:answered" }).dead).toEqual([{ item: expect.objectContaining({ id: "q:answered" }) }]);

    // Unknown: neither live nor dead.
    for (const item of [{ kind: "question", id: "q:gone" }, { kind: "request", id: "req-20260926T000000Z" }, { kind: "link", id: "peer-gone" }, { kind: "batch", id: "b9" }] as const) {
      expect(dead(item)).toMatchObject({ holds: false, dead: [] });
    }
    // A request no Worker took yet is not dead.
    expect(dead({ kind: "request", id: REQUEST_2 }, { request: () => ({ headId: REQUEST_2, state: "active", workers: 0, liveWorker: false }) })).toMatchObject({ holds: false, dead: [] });
    expect(structuralWaitOf({}, facts())).toEqual({ items: [], holds: false, dead: [] });
    expect(structuralWaitOf({ waiting: waitOn([]) }, facts())).toEqual({ items: [], holds: false, dead: [] });
  });

  it("stallReasonsOf: a blocked request whose wait holds by structure is no idle-unfinished, even with no question open", () => {
    const { trace, facts: agents } = traceOf([...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))], agentsWith());
    const flags = flagsOf(ruleInputOf(trace), factsWith());
    expect(stallReasonsOf(trace, agents, flags, when(59), false, false, true)).toEqual([]);
    expect(stallReasonsOf(trace, agents, flags, when(59), false, false, false).map((entry) => entry.reason)).toEqual(["idle-unfinished"]);
  });
});

describe("the pass: a Worker waiting by structure (delivery line design §6.5)", () => {
  const BACKEND_REQUEST = "req-20260926T090000Z";

  function writeRegistry(requests: Array<Partial<RegisteredRequest> & { requestId: string }>): void {
    mkdirSync(join(home, REQUESTS_DIR_NAME), { recursive: true, mode: 0o700 });
    const full = requests.map((request) => ({
      workspaceId: WORKSPACE_ID,
      createdAt: at(0),
      source: "tool",
      managerId: MANAGER,
      workerIds: [],
      tier: null,
      finishedAt: null,
      reviews: { batches: [], grants: [] },
      ...request,
    }));
    writeFileSync(join(home, REQUESTS_DIR_NAME, `${WORKSPACE_ID}.json`), JSON.stringify({ schemaVersion: 1, requests: full }), { mode: 0o600 });
    clearRequestRegistryCache();
  }

  /** `REQUEST_ID`, blocked at 10:04 on `items`, its Worker idle; the second request's Worker on the daemon too. */
  async function waitingOn(items: Array<Pick<Waiting["items"][number], "kind" | "id">>, extra: Partial<RegisteredRequest> = {}) {
    await seed([...handedOver(), relayed("received", at(1, 10)), relayed("blocked", at(4))]);
    writeRegistry([
      { requestId: REQUEST_ID, workerIds: [WORKER], waiting: waitOn(items), ...extra },
      { requestId: REQUEST_2, workerIds: [WORKER_2] },
    ]);
    inScope();
    const fake = daemonWith([...fakeAgentsFor(), secondWorker("idle"), orchestratorAgent()]);
    const wake = vi.fn<(settled: SettledWait[]) => void>();
    const stalls = watcher({ onWaitsSettled: (settled) => wake(settled) });
    stalls.usePaseo(fake.paseo);
    return { fake, stalls, wake };
  }

  it("live items: no idle-unfinished, no event, no re-wake, however long it waits", async () => {
    const { fake, stalls, wake } = await waitingOn([{ kind: "request", id: REQUEST_2 }]);
    clock = when(59);
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });
    clock = new Date(when(59).getTime() + 3_600_000);
    expect(await stalls.pass()).toEqual({ status: "done", raised: [], cleared: [], events: [] });
    expect(alerts().list()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(fake.sends).toEqual([]);
  });

  it("an open alert clears once the request waits by structure on live items", async () => {
    const { stalls } = await waitingOn([{ kind: "request", id: REQUEST_2 }]);
    alerts().raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: REQUEST_ID, detail: "idle-unfinished" });
    clock = when(59);
    expect((await stalls.pass()).cleared).toEqual([alertOf()]);
  });

  it("the awaited request loses its last live Worker: the item settles with its fact and wakes the Worker once", async () => {
    const { fake, stalls, wake } = await waitingOn([{ kind: "request", id: REQUEST_2 }]);
    clock = when(59);
    await stalls.pass();
    fake.byId(WORKER_2)!.archivedAt = at(58);
    const settled = await stalls.pass();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toMatchObject([
      { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, met: true, waiting: { items: [{ kind: "request", id: REQUEST_2, settled: true, fact: `${REQUEST_2} has no live Worker left` }] } },
    ]);
    // Nothing holds it any more: idle, it stalls as any other request until the release wakes it.
    expect(settled.raised).toEqual([alertOf()]);
    await stalls.pass();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "an awaited request stopped",
      [{ kind: "request" as const, id: REQUEST_2 }],
      {},
      () => {
        const roster = createMissionRoster(home, { env: {} });
        roster.add("mis-0123456789", { requestId: REQUEST_2, workspaceId: WORKSPACE_ID, topic: "rename", workerId: WORKER_2 });
        roster.setState("mis-0123456789", REQUEST_2, "stopped");
      },
      `${REQUEST_2} stopped`,
    ],
    [
      "a Reviewer gone with no verdict",
      [{ kind: "batch" as const, id: "b1" }],
      { reviews: { batches: [{ batchId: "b1", reviewerIds: [REVIEWER], brief: "", calls: [{ callId: "call-1", kind: "create" as const, reviewerId: REVIEWER, at: at(5) }] }], grants: [] } },
      () => {},
      "b1 got no verdict: no Reviewer of it is running",
    ],
    [
      "a link past its ceiling",
      [{ kind: "link" as const, id: "peer-000000000001" }],
      {},
      () => {
        const links = createPeerLinkStore(home, { now: () => when(2), newId: () => "peer-000000000001", env: {} });
        const made = links.createLink({
          kind: "work",
          from: { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, agentId: WORKER, role: "worker" },
          to: { workspaceId: PEER_WS, managerId: "agent-backend-manager" },
          text: "Add the /export endpoint.",
        });
        if (!made.ok) throw new Error(made.reasons.join("\n"));
        links.takeLink(made.link.linkId, { workspaceId: PEER_WS, requestId: BACKEND_REQUEST, workerId: PEER_WORKER });
      },
      `peer-000000000001: taken by request ${BACKEND_REQUEST} of project ${PEER_WS}, which has no live agent`,
    ],
  ])("%s settles as a fact and wakes the Worker once", async (_name, items, extra, arrange, fact) => {
    arrange();
    const { stalls, wake } = await waitingOn(items, extra);
    clock = when(59);
    await stalls.pass();
    await stalls.pass();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toMatchObject([{ requestId: REQUEST_ID, met: true, waiting: { items: [{ ...items[0], settled: true, fact }] } }]);
  });

  it("a review call within the pending window keeps the batch live", async () => {
    const reviews = { batches: [{ batchId: "b1", reviewerIds: [REVIEWER], brief: "", calls: [{ callId: "call-1", kind: "create" as const, reviewerId: REVIEWER, at: at(55) }] }], grants: [] };
    const { stalls, wake } = await waitingOn([{ kind: "batch", id: "b1" }], { reviews });
    clock = when(59);
    expect(await stalls.pass()).toMatchObject({ raised: [], events: [] });
    expect(wake).not.toHaveBeenCalled();
  });
});
