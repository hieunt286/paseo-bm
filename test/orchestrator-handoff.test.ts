import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBindingStore, type AgentBinder, type BindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { COMMAND_LIMIT_PER_REQUEST, HANDOFF_OFF_MESSAGE, commandsSentFor, sendCommand } from "../plugin/server/command-send";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { outboxBlocksOf } from "../plugin/server/collector";
import type { OutboxRecord } from "../plugin/server/outbox";
import { originOf } from "../plugin/shared/message-origin";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import {
  HANDOFF_BRIEF_MAX_CHARS,
  HANDOFF_FROM_LABEL,
  NOTE_SEND_MS,
  PEER_RULES,
  REPLACED_BY_LABEL,
  briefClosingOf,
  createHandoffRunner,
  handoffBriefOf,
  handoffCommandOf,
  handoffInfoOf,
  handoffSafePointIn,
  noteIn,
  noteRequestOf,
  peerBlockOf,
  replacedNoticeOf,
  type HandoffRunner,
} from "../plugin/server/handoff";
import {
  CREATING_WAIT_MS,
  HANDOFFS_DIR_NAME,
  HANDOFF_SAFE_POINT_WAIT_MS,
  MANAGER_WAIT_MS,
  NOTE_WAIT_MS,
  SUCCESSOR_WAIT_MS,
  createHandoffStore,
  endedHandoff,
  type HandoffEntry,
} from "../plugin/server/handoff-store";
import { MAINTENANCE_WAIT_MS } from "../plugin/shared/interventions";
import { createInterventionStore } from "../plugin/server/intervention-store";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import type { CliResult } from "../plugin/server/paseo-cli";
import { checkRolePairing } from "../plugin/server/role-pairing";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { parseReports } from "../plugin/shared/bm-report";
import type { Evidence, TraceRecord, Usage } from "../plugin/shared/contracts";
import { requestFinishOf } from "../plugin/shared/evidence";
import { HANDOFF_BRIEF_MARKER, holdsHandoffBrief } from "../plugin/shared/handoff";
import { HANDOFF_NOTICE_MARKER, REPLACED_NOTICE_MARKER, isPluginNotice } from "../plugin/shared/notices";
import { COORDINATION_HANDOFF_AUTHORITY, MAX_COMMAND_BODY_CHARS, parseCommandBlock } from "../plugin/shared/orchestrator-command";
import { answerDecision } from "../plugin/shared/decisions";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeCreateRequest, type FakePaseo, type FakePaseoOptions } from "./helpers/fake-paseo";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, msg, report, turn } from "./fixtures/orchestrator-traces";
import { bindAgent } from "./helpers/bindings";

/**
 * Handoff through the Manager (missions design §9.5; autonomy design §G.6;
 * PRD REQ-135, REQ-195; change-008 C3; bead `7gxw.11`): a Worker's turn
 * crossing its request's threshold starts it, and every rule that starts
 * nothing writes nothing; the whole sequence with the one fake of `test/helpers/fake-paseo.ts`
 * — the note asked at the Worker's idle moment after a safe point, the brief
 * built, masked and bounded, the `BM-COMMAND` to the Manager, the successor the
 * Manager creates labelled `bm.handoffFrom`, the outgoing Worker labelled
 * `bm.replacedBy` and never archived, the request id kept, no pairing alert —
 * the owner's switch, the note's bound, and the successor held to proving its
 * checks again. A temporary data folder and a private notice queue — never
 * the real HOME or a daemon.
 */

const REQUEST = "req-20260930T100000Z";
const ORCHESTRATOR = "agent-orchestrator";
const SECRET = "tok-handoff-secret-42";
const T0 = Date.parse("2026-09-30T11:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let root: string;
let home: string;
let clock: Date;
let queue: NoticeQueue;
let logs: string[];
let labelled: Array<{ id: string; labels: Record<string, string> }>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-handoff-"));
  home = join(root, "data");
  clock = new Date(T0 + 30 * MIN);
  queue = createNoticeQueue({ log: () => {} });
  logs = [];
  labelled = [];
  clearTraceStoreCache();
  clearDecisionStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  clearDecisionStoreCache();
  clearRequestRegistryCache();
  rmSync(root, { recursive: true, force: true });
});

const location = () => ({ tracesDir: join(home, "traces") });
const handoffs = () => createHandoffStore(home, { now: () => clock });
const interventions = () => createInterventionStore(home).list();

/** A Claude turn's usage: `read` tokens read in the turn (input + cached). */
const usageOf = (read: number): Usage => ({
  inputTokens: 1_000,
  cachedInputTokens: read - 1_000,
  outputTokens: 2_000,
  costUsd: null,
  costBasis: "unavailable",
  model: "claude-opus-5",
  pricesUpdatedAt: null,
});

/** A successful command of the turn (its status says so, as the collector records it). */
const ran = (command: string, when: string, agentId = WORKER): Evidence => ({ kind: "shell", detail: command, agentId, at: when, status: "completed", exitCode: 0 });

/** One recorded turn of `agentId` of the request, ending `minute` minutes after T0. */
function workerTurn(minute: number, over: Partial<TraceRecord> = {}, agentId = WORKER): TraceRecord {
  return turn({
    workspaceId: WORKSPACE_ID,
    agentId,
    role: "worker",
    requestId: REQUEST,
    parentAgentId: MANAGER,
    turnId: `${agentId}-${minute}`,
    at: iso(T0 + minute * MIN),
    startedAt: iso(T0 + (minute - 1) * MIN),
    endedAt: iso(T0 + minute * MIN),
    usage: usageOf(1_000_000),
    runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: null, provider: "bm-worker" },
    ...over,
  });
}

/** The owner's request in the Manager's turn, and the Worker's heavy turn that closed a bead: its safe point. */
function heavyRequest(requestText = "Fix the invoice date format; call the API with --token abc123 to check it."): TraceRecord[] {
  return [
    turn({
      workspaceId: WORKSPACE_ID,
      agentId: MANAGER,
      role: "manager",
      requestId: REQUEST,
      turnId: "m-1",
      at: iso(T0 + MIN),
      endedAt: iso(T0 + MIN),
      sent: [msg(MANAGER, iso(T0), requestText, "user")],
    }),
    workerTurn(10, {
      usage: usageOf(160_000_000),
      evidence: [ran(`br close bm-d1 --reason "date format proved"`, iso(T0 + 9 * MIN))],
      reports: [
        report({
          agentId: MANAGER,
          at: iso(T0 + 10 * MIN),
          requestId: REQUEST,
          phase: "beads-done",
          tier: "Large",
          filesChanged: ["src/invoice/date.ts", "docs/plans/invoice-plan.md"],
          beadsCreated: ["bm-d1", "bm-d2"],
          beadsClosed: ["bm-d1"],
          beadsReady: ["bm-d2"],
          buildAndTests: "`npm test` pass",
          decided: ["dd/mm/yyyy — the owner's locale"],
        }),
      ],
    }),
  ];
}

async function store(...records: TraceRecord[]): Promise<void> {
  for (const record of records) await appendRecord(location(), record);
}

/** The daemon: an Orchestrator, a Manager, its Worker of the request and the Worker's Reviewer. */
function daemon(
  options: { worker?: string; manager?: string; workerLabels?: Record<string, string>; workerArchived?: boolean; managerArchived?: boolean; extra?: Partial<FakePaseoOptions> } = {},
): FakePaseo<unknown> {
  return fakePaseo({
    ...options.extra,
    agents: [
      {
        id: ORCHESTRATOR,
        provider: "bm-orchestrator/claude-opus-5-5",
        status: "idle",
        workspaceId: "wks-own",
        labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
        createdAt: iso(T0),
      },
      {
        id: MANAGER,
        provider: "bm-manager",
        status: options.manager ?? "idle",
        workspaceId: WORKSPACE_ID,
        labels: { "bm.role": "manager" },
        createdAt: iso(T0),
        archivedAt: options.managerArchived === true ? iso(T0) : null,
      },
      {
        id: WORKER,
        provider: "bm-worker",
        status: options.worker ?? "idle",
        workspaceId: WORKSPACE_ID,
        labels: options.workerLabels ?? { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER },
        createdAt: iso(T0),
        archivedAt: options.workerArchived === true ? iso(T0) : null,
      },
      {
        id: REVIEWER,
        provider: "bm-reviewer",
        status: "idle",
        workspaceId: WORKSPACE_ID,
        labels: { "bm.role": "reviewer", "bm.requestId": REQUEST, "paseo.parent-agent-id": WORKER },
        createdAt: iso(T0),
      },
    ],
    workspaces: [{ id: WORKSPACE_ID, directory: "/work/invoice-app" }],
    timelines: { [WORKER]: [{ item: { type: "user_message", text: `Request ${REQUEST}: fix the invoice date format; call the API with --token abc123 to check it.` }, timestamp: iso(T0 + 2 * MIN) }] },
  });
}

/** Read-only git as the brief runs it: a branch and a diff stat. */
const git = async (args: readonly string[]) => ({ stdout: args.includes("rev-parse") ? "feature/invoice-date\n" : " 3 files changed, 40 insertions(+), 5 deletions(-)\n" });

function runnerOf(binder?: () => AgentBinder): HandoffRunner {
  return createHandoffRunner({
    ...(binder === undefined ? {} : { binder }),
    home: () => home,
    now: () => clock,
    queue,
    log: (line) => logs.push(line),
    redactEnv: { PASEO_PASSWORD: SECRET },
    git,
    setLabels: async (id: string, labels: Record<string, string>): Promise<CliResult> => {
      labelled.push({ id, labels });
      return { ok: true };
    },
  });
}

/**
 * A Worker's stored turn handed to the runner as the collector's `onRecorded`
 * does — by default the heavy turn of `heavyRequest`, which closed a bead:
 * crossing the threshold, it starts the handoff (missions design §9.5).
 */
async function start(fake: FakePaseo<unknown>, runner: HandoffRunner = runnerOf(), record: TraceRecord = heavyRequest()[1]!): Promise<HandoffRunner> {
  await runner.turnRecorded({ agent: { id: record.agentId }, timeline: [] }, record, fake.paseo);
  return runner;
}

/** The reason a crossing at 160M tokens keeps, and its command's `why:`. */
const CROSSED = "its request read 160,000,000 tokens (threshold 150,000,000)";

describe("the start: a Worker's turn crossing its request's threshold, else nothing written (missions design §9.5, autonomy design §G.6)", () => {
  const nothingWritten = () => {
    expect(existsSync(join(home, HANDOFFS_DIR_NAME))).toBe(false);
    expect(interventions()).toEqual([]);
  };

  it("starts nothing when handoff is off", async () => {
    createCoordinationStore(home).set({ key: "handoff.enabled", value: false });
    await store(...heavyRequest());
    const fake = daemon();
    await start(fake);
    nothingWritten();
    expect(fake.sends).toEqual([]);
  });

  it("starts nothing for a turn of no request, a Reviewer's or a Manager's turn, or a Worker already handed over", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    const runner = runnerOf();
    await start(fake, runner, workerTurn(11, { requestId: null }));
    await start(fake, runner, workerTurn(11, { agentId: REVIEWER, role: "reviewer", parentAgentId: WORKER }));
    await start(fake, runner, turn({ workspaceId: WORKSPACE_ID, agentId: MANAGER, role: "manager", requestId: REQUEST, endedAt: iso(T0 + 11 * MIN), at: iso(T0 + 11 * MIN), usage: usageOf(160_000_000) }));
    nothingWritten();
    // The Worker a done handoff replaced: its turns start nothing, whatever its request read since.
    const done = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "" });
    handoffs().update(done.id, (entry) => ({ ...entry, state: "done", successorId: "agent-next", successorAt: iso(T0 + 5 * MIN), endedAt: iso(T0 + 5 * MIN) }));
    await start(fake, runner);
    expect(handoffs().list()).toHaveLength(1);
    expect(interventions()).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it("starts nothing when its request is finished, or it has no live Manager", async () => {
    await store(...heavyRequest());
    await start(daemon({ managerArchived: true }));
    nothingWritten();
    await store(workerTurn(12, { reports: [report({ agentId: MANAGER, at: iso(T0 + 12 * MIN), requestId: REQUEST, phase: "finished" })] }));
    await start(daemon());
    nothingWritten();
  });

  it("starts nothing below its threshold, since it started and since its last handoff", async () => {
    const fake = daemon();
    await store(workerTurn(10, { usage: usageOf(40_000_000) }));
    await start(fake, runnerOf(), workerTurn(10, { usage: usageOf(40_000_000) }));
    nothingWritten();
    // A handoff done at minute 20: only the turns after it count again.
    await store(workerTurn(11, { usage: usageOf(160_000_000) }), workerTurn(25, { usage: usageOf(5_000_000) }, "agent-successor"));
    const done = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: "agent-before", managerId: MANAGER, interventionId: null, reason: "" });
    handoffs().update(done.id, (entry) => ({ ...entry, state: "done", successorId: WORKER, successorAt: iso(T0 + 20 * MIN), endedAt: iso(T0 + 20 * MIN) }));
    await start(fake, runnerOf(), workerTurn(25, { usage: usageOf(5_000_000) }, "agent-successor"));
    expect(handoffs().list()).toHaveLength(1);
    expect(interventions()).toEqual([]);
  });

  it("starts one while a handoff of the request is pending, none at handoff.maxPerRequest, and none at the loop guard", async () => {
    createCoordinationStore(home).set({ key: "handoff.maxPerRequest", value: 1 });
    await store(...heavyRequest());
    const fake = daemon({ worker: "running" });
    const runner = runnerOf();
    await start(fake, runner);
    const written = { handoffs: handoffs().list(), interventions: interventions() };
    expect(written.handoffs).toMatchObject([{ workerId: WORKER, managerId: MANAGER, reason: CROSSED }]);
    await start(fake, runner);
    expect(handoffs().list()).toEqual(written.handoffs);
    // It completed: one handoff so far, the owner's limit of 1.
    handoffs().update(written.handoffs[0]!.id, (entry) => ({ ...entry, state: "done", successorId: "agent-next", successorAt: clock.toISOString(), endedAt: clock.toISOString() }));
    const done = handoffs().list();
    await store(workerTurn(40, { usage: usageOf(160_000_000) }, "agent-next"));
    await start(fake, runner, workerTurn(40, { usage: usageOf(160_000_000) }, "agent-next"));
    expect(handoffs().list()).toEqual(done);
    expect(interventions()).toEqual(written.interventions);
    // The loop guard: 12 commands for the request in 24 hours.
    createCoordinationStore(home).set({ key: "handoff.maxPerRequest", value: 5 });
    const orchestrator = createOrchestratorStore(home, { now: () => clock });
    for (let n = 0; n < COMMAND_LIMIT_PER_REQUEST; n += 1) {
      orchestrator.appendCommand({ id: `c${n}`, workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, situation: "s", command: "c", reason: "r", sentText: "BM-COMMAND", outcome: "sent" });
    }
    await start(fake, runner, workerTurn(40, { usage: usageOf(160_000_000) }, "agent-next"));
    expect(handoffs().list()).toEqual(done);
    expect(fake.sends).toEqual([]);
  });
});

describe("the whole sequence (design §G.6) with the one fake daemon", () => {
  it("asks the idle Worker for its note after a safe point, builds the brief, commands the Manager, and links the successor it creates", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    // The heavy turn that closed a bead ends: the handoff starts by itself, logged as one, and the note is asked at once.
    const runner = await start(fake);
    expect(fake.sends).toEqual([{ id: WORKER, text: noteRequestOf({ requestId: REQUEST }) }]);
    expect(isPluginNotice(fake.sends[0]!.text)).toBe(true);
    const [asked] = handoffs().list();
    expect(asked).toMatchObject({ workerId: WORKER, managerId: MANAGER, requestId: REQUEST, state: "noting", noteAskedAt: clock.toISOString(), reason: CROSSED });
    expect(interventions()).toMatchObject([{ id: asked!.interventionId, kind: "handoff", targetAgentId: WORKER, requestId: REQUEST, trigger: "threshold.crossed", expected: "successor-progresses" }]);
    // No model asked for it: nothing reached the Orchestrator.
    expect(fake.sends.filter((sent) => sent.id === ORCHESTRATOR)).toEqual([]);

    // The note turn: the Worker posts bm_report's block with its handoffNote in its own chat.
    clock = new Date(T0 + 32 * MIN);
    const posted = `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large (changed: no)\nfilesChanged: src/invoice/date.ts\nbeadsCreated: none\nbeadsUpdated: none\nbeadsClosed: bm-d1\nbeadsReady: bm-d2\nreviewFindingsOpen: none\nbuildAndTests: \`npm test\` pass\nskillsUsed: none\ndecided: none\nblockers: none\nhandoffNote: Parsing is done in date.ts; next, bm-d2 formats the PDF. Beware --secret hunter2 in the fixture.`;
    const noteTurn = workerTurn(32, { startedAt: iso(T0 + 31 * MIN), reports: parseReports(posted, { agentId: WORKER, at: iso(T0 + 32 * MIN) }) });
    fake.byId(WORKER)!.status = "idle";
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, noteTurn, fake.paseo);

    // The command: to the Manager only, intent handoff on coordination:handoff, the brief in its body.
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER]);
    const block = parseCommandBlock(fake.sends[1]!.text)!;
    expect(block).toMatchObject({ from: "orchestrator", to: "manager", requestId: REQUEST, intent: "handoff", authority: COORDINATION_HANDOFF_AUTHORITY, effects: [], approved: [], why: CROSSED });
    expect(block.limits).toEqual(["no-commit-push-deploy", "no-real-data"]);
    expect(block.body).toContain(`${HANDOFF_FROM_LABEL} = ${WORKER}`);
    const [briefed] = handoffs().list();
    expect(briefed).toMatchObject({ state: "commanded", note: "Parsing is done in date.ts; next, bm-d2 formats the PDF. Beware --secret [redacted] in the fixture." });
    const brief = briefed!.brief!;
    expect(block.body.endsWith(brief)).toBe(true);
    expect(brief.length).toBeLessThanOrEqual(HANDOFF_BRIEF_MAX_CHARS);
    expect(brief.split("\n")[0]).toBe(`${HANDOFF_BRIEF_MARKER} ${briefed!.id}`);
    for (const line of [
      `requestId: ${REQUEST}`,
      `managerAgentId: ${MANAGER}`,
      `replaces: ${WORKER}`,
      "request: Fix the invoice date format; call the API with --token [redacted] to check it.",
      "decided: dd/mm/yyyy — the owner's locale",
      "planAndDocs: docs/plans/invoice-plan.md",
      "beadsClosed: bm-d1",
      "beadsReady: bm-d2",
      "checks: `npm test` pass",
      "branch: feature/invoice-date",
      "diffStat: 3 files changed, 40 insertions(+), 5 deletions(-)",
      "note: Parsing is done in date.ts; next, bm-d2 formats the PDF. Beware --secret [redacted] in the fixture.",
    ]) {
      expect(brief, line).toContain(line);
    }
    expect(brief).toContain("Nothing counts as done until you prove it again");
    expect(brief).not.toContain("abc123");
    expect(brief).not.toContain("hunter2");
    // Counted by the loop guard: the command is in the commands store.
    expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ id: briefed!.commandId, managerId: MANAGER, requestId: REQUEST }]);
    expect(commandsSentFor(createOrchestratorStore(home).listCommands(), WORKSPACE_ID, REQUEST, clock)).toBe(1);

    // The Manager creates the successor as its handoff rule says: bm.handoffFrom among its labels, the brief as its first message.
    const created = await fake.api.workspaces.ref(WORKSPACE_ID).agents.create({
      config: { provider: "bm-worker/claude-opus-5" },
      parent: MANAGER,
      labels: { "bm.role": "worker", "bm.requestId": REQUEST, [HANDOFF_FROM_LABEL]: WORKER },
      prompt: brief,
    });
    clock = new Date(T0 + 34 * MIN);
    const done = await runner.agentCreated({ id: created.id, provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo);
    expect(done).toMatchObject({ state: "done", successorId: created.id, successorAt: clock.toISOString(), requestId: REQUEST });
    // The outgoing Worker is labelled replaced through the CLI, never archived; the request keeps its id.
    expect(labelled).toEqual([{ id: WORKER, labels: { [REPLACED_BY_LABEL]: created.id } }]);
    expect(fake.archives).toEqual([]);
    expect(fake.byId(created.id)!.labels).toMatchObject({ "bm.requestId": REQUEST });
    // Created by the Worker's Manager: the pairing holds, no alert.
    const alerts: unknown[] = [];
    expect(await checkRolePairing({ id: created.id, provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo as never, { raiseAlert: (mismatch) => void alerts.push(mismatch) })).toBe("paired");
    expect(alerts).toEqual([]);
    // The plugin itself tells the outgoing Worker, by a plugin notice (live check F4); nothing else was sent, and it created no agent.
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER, WORKER]);
    const told = fake.sends[2]!.text;
    expect(told).toBe(replacedNoticeOf({ requestId: REQUEST }, created.id));
    expect(told.split("\n")[0]).toBe(REPLACED_NOTICE_MARKER);
    expect(isPluginNotice(told)).toBe(true);
    expect(told).toContain(`handed over to Worker ${created.id}`);
    expect(told).toContain("send no report, and end this turn");
    expect(fake.creates).toHaveLength(1);
  });

  it("a successor the label names but another agent created, or of another request, completes nothing", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    const runner = await start(fake);
    const [entry] = handoffs().list();
    handoffs().update(entry!.id, (current) => ({ ...current, state: "commanded", commandSentAt: clock.toISOString(), brief: "b" }));
    const stranger = await fake.api.workspaces.ref(WORKSPACE_ID).agents.create({ config: { provider: "bm-worker" }, parent: REVIEWER, labels: { [HANDOFF_FROM_LABEL]: WORKER } });
    expect(await runner.agentCreated({ id: stranger.id, provider: "bm-worker", parentAgentId: REVIEWER, workspaceId: WORKSPACE_ID }, fake.paseo)).toBeNull();
    const other = await fake.api.workspaces.ref(WORKSPACE_ID).agents.create({ config: { provider: "bm-worker" }, parent: MANAGER, labels: { [HANDOFF_FROM_LABEL]: WORKER, "bm.requestId": "req-20260930T120000Z" } });
    expect(await runner.agentCreated({ id: other.id, provider: "bm-worker", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo)).toBeNull();
    expect(handoffs().list()[0]).toMatchObject({ state: "commanded", successorId: null });
    expect(labelled).toEqual([]);
    // Nor is the outgoing Worker told anything.
    expect(fake.sends.filter((sent) => sent.id === WORKER && sent.text.startsWith(REPLACED_NOTICE_MARKER))).toEqual([]);
  });

  it("a running Worker waits; a turn without a safe point asks nothing; its next safe turn does", async () => {
    await store(workerTurn(10, { usage: usageOf(160_000_000) }));
    const fake = daemon({ worker: "running" });
    // The crossing turn closed no bead: the handoff starts and waits for a safe point.
    const runner = await start(fake, runnerOf(), workerTurn(10, { usage: usageOf(160_000_000) }));
    expect(handoffs().list()).toMatchObject([{ state: "waiting", noteAskedAt: null }]);
    expect(fake.sends).toEqual([]);
    fake.byId(WORKER)!.status = "idle";
    // A turn that only worked on: no safe point, nothing asked.
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(35), fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(handoffs().list()[0]).toMatchObject({ state: "waiting" });
    // A turn that sent beads-done to its Manager: the note request goes.
    const sentReport = { type: "tool_call", name: "mcp__paseo__send_agent_prompt", detail: { input: { agentId: MANAGER, prompt: `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large` } } };
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [{ type: "user_message", text: "Continue." }, sentReport] }, workerTurn(40), fake.paseo);
    expect(fake.sends.map((sent) => sent.text.split("\n")[0])).toEqual([HANDOFF_NOTICE_MARKER]);
    expect(handoffs().list()[0]).toMatchObject({ state: "noting" });
  });

  it("goes on without the note: its note turn carried none, or 10 minutes passed at any recorded turn; a busy Manager waits", async () => {
    await store(...heavyRequest());
    const fake = daemon({ manager: "running" });
    const runner = await start(fake);
    // Ten minutes and a second on, another agent's turn ends: the brief is built without a note; the Manager is busy, so it waits.
    clock = new Date(T0 + 30 * MIN + NOTE_WAIT_MS + 1_000);
    await runner.turnRecorded({ agent: { id: REVIEWER }, timeline: [] }, turn({ agentId: REVIEWER, role: "reviewer", endedAt: clock.toISOString(), at: clock.toISOString() }), fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "briefed", note: null });
    expect(handoffs().list()[0]!.brief).toContain("note: none — the outgoing Worker wrote no note");
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
    // The Manager's turn ends and it is idle: the command goes.
    fake.byId(MANAGER)!.status = "idle";
    await runner.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, turn({ agentId: MANAGER, endedAt: clock.toISOString(), at: clock.toISOString() }), fake.paseo);
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER]);
    expect(handoffs().list()[0]).toMatchObject({ state: "commanded" });
  });

  it("a turn that began before the note request is not its answer: the handoff keeps waiting for the note", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    const runner = await start(fake);
    // A turn of the Worker that started ten minutes before the request went out and ends now.
    clock = new Date(T0 + 31 * MIN);
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(31, { startedAt: iso(T0 + 20 * MIN) }), fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "noting", brief: null });
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
  });

  it("a canceled note turn without the note is no answer: the handoff keeps waiting for the note until its bound", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    const runner = await start(fake);
    clock = new Date(T0 + 32 * MIN);
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(32, { startedAt: iso(T0 + 31 * MIN), outcome: "canceled" }), fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "noting", brief: null });
    // Its next turn carries the note.
    clock = new Date(T0 + 34 * MIN);
    const posted = `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large\nhandoffNote: Next: bm-d2.`;
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(34, { startedAt: iso(T0 + 33 * MIN), reports: parseReports(posted, { agentId: WORKER, at: iso(T0 + 34 * MIN) }) }), fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "commanded", note: "Next: bm-d2." });
  });

  it("the owner's switch stops it at once: a pending handoff ends at its next step, and the send refuses a handoff while off", async () => {
    await store(...heavyRequest());
    const fake = daemon({ worker: "running" });
    // Started at its crossing turn; the note request is held while the Worker runs.
    const runner = await start(fake);
    expect(handoffs().list()[0]).toMatchObject({ state: "waiting" });
    createCoordinationStore(home).set({ key: "handoff.enabled", value: false });
    fake.byId(WORKER)!.status = "idle";
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, heavyRequest()[1]!, fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "dropped", ending: "off" });
    expect(fake.sends).toEqual([]);
    // The send pipeline itself: coordination:handoff is refused while handoff is off, and nothing is recorded.
    const entry = handoffs().list()[0]!;
    const refused = await sendCommand({
      home,
      now: clock,
      paseo: fake.paseo as never,
      workspaceId: WORKSPACE_ID,
      command: handoffCommandOf(entry, `${HANDOFF_BRIEF_MARKER} ${entry.id}\nrequestId: ${REQUEST}`),
      targetId: MANAGER,
      copyTo: null,
      backstop: false,
      loopGuard: "refuse",
      intervention: null,
      queue,
    });
    expect(refused).toEqual({ ok: false, stage: "check", reason: HANDOFF_OFF_MESSAGE });
    expect(createOrchestratorStore(home).listCommands()).toEqual([]);
  });

  it("ends a handoff past its bounds: no safe point in an hour, a Manager busy for 30 minutes, no successor in 30 minutes", async () => {
    const entry = (over: Partial<HandoffEntry>) => {
      const added = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: `req-2026093${Object.keys(over).length}T100000Z`, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "" });
      return handoffs().update(added.id, (current) => ({ ...current, ...over }))!;
    };
    const waiting = entry({});
    const briefed = entry({ state: "briefed", noteAskedAt: clock.toISOString(), briefAt: clock.toISOString(), brief: "b" });
    const commanded = entry({ state: "commanded", noteAskedAt: clock.toISOString(), briefAt: clock.toISOString(), brief: "b", commandId: "c", commandSentAt: clock.toISOString() });
    clock = new Date(clock.getTime() + Math.max(MANAGER_WAIT_MS, SUCCESSOR_WAIT_MS) + 1_000);
    const byId = (a: readonly unknown[], b: readonly unknown[]) => String(a[0]).localeCompare(String(b[0]));
    expect(handoffs().expire().map((ended) => [ended.id, ended.state, ended.ending]).sort(byId)).toEqual(
      [
        [briefed.id, "dropped", "manager-busy"],
        [commanded.id, "failed", "no-successor"],
      ].sort(byId),
    );
    clock = new Date(clock.getTime() + 60 * MIN);
    expect(handoffs().expire().map((ended) => [ended.id, ended.state, ended.ending])).toEqual([[waiting.id, "dropped", "no-safe-point"]]);
  });
});

describe("the maintenance ceiling (delivery line design §6.6)", () => {
  const firstLines = (fake: FakePaseo<unknown>) => fake.sends.map((sent) => sent.text.split("\n")[0]);
  /** A delivery queued for the Worker while it runs; then it is idle. */
  async function queuedItem(fake: FakePaseo<unknown>): Promise<void> {
    await queue.enqueue(WORKER, "BM-DELIVERY:a", "BM-DELIVERY a", fake.paseo as never);
    fake.byId(WORKER)!.status = "idle";
  }

  it("at twice its threshold the note is asked at that turn end with no safe point and an item queued, ahead of it; the item goes after", async () => {
    // 310M: over twice the 150M threshold, in a turn that closed nothing.
    const heavy = workerTurn(10, { usage: usageOf(310_000_000) });
    await store(heavy);
    const fake = daemon({ worker: "running" });
    await queuedItem(fake);
    await start(fake, runnerOf(), heavy);
    expect(firstLines(fake)).toEqual([HANDOFF_NOTICE_MARKER]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual(["BM-DELIVERY:a"]);
    expect(handoffs().list()).toMatchObject([{ state: "noting" }]);
    fake.byId(WORKER)!.status = "idle";
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(firstLines(fake)).toEqual([HANDOFF_NOTICE_MARKER, "BM-DELIVERY a"]);
  });

  it("queued at its ceiling behind a notice sent at that turn end, the note request still goes at the next turn end, past NOTE_SEND_MS", async () => {
    const heavy = workerTurn(10, { usage: usageOf(310_000_000) });
    await store(heavy);
    // The queue ran first at this turn end and started another turn: the Worker reads running.
    const fake = daemon({ worker: "running" });
    await start(fake, runnerOf(), heavy);
    expect(fake.sends).toEqual([]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual([`${HANDOFF_NOTICE_MARKER}:${handoffs().list()[0]!.id}`]);
    clock = new Date(clock.getTime() + NOTE_SEND_MS + 2 * MIN);
    fake.byId(WORKER)!.status = "idle";
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(firstLines(fake)).toEqual([HANDOFF_NOTICE_MARKER]);
    expect(handoffs().list()).toMatchObject([{ state: "noting" }]);
  });

  it("below it, a safe point with an item queued still waits", async () => {
    await store(...heavyRequest());
    const fake = daemon({ worker: "running" });
    await queuedItem(fake);
    // 160M and a closed bead: a safe point, but something is queued for the Worker.
    await start(fake);
    expect(fake.sends).toEqual([]);
    expect(handoffs().list()).toMatchObject([{ state: "waiting" }]);
  });

  it("waiting 30 minutes, half its window, the note is asked at the Worker's next turn end without a safe point, ahead of what is queued", async () => {
    expect(MAINTENANCE_WAIT_MS.handoff).toBe(30 * MIN);
    expect(MAINTENANCE_WAIT_MS.handoff).toBe(HANDOFF_SAFE_POINT_WAIT_MS / 2);
    await store(workerTurn(10, { usage: usageOf(160_000_000) }));
    const fake = daemon({ worker: "running" });
    const runner = await start(fake, runnerOf(), workerTurn(10, { usage: usageOf(160_000_000) }));
    await queuedItem(fake);
    clock = new Date(T0 + 59 * MIN);
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(59), fake.paseo);
    expect(fake.sends).toEqual([]);
    clock = new Date(T0 + 60 * MIN);
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(60), fake.paseo);
    expect(firstLines(fake)).toEqual([HANDOFF_NOTICE_MARKER]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual(["BM-DELIVERY:a"]);
  });

  it("a Worker waiting by structure is at a safe point: its note is asked though its turn closed nothing", async () => {
    const registry = createRequestRegistry(home, { backfill: () => [] });
    registry.register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MANAGER, workerId: WORKER });
    registry.setWaiting(WORKSPACE_ID, REQUEST, { since: clock.toISOString(), reportRecordId: "out-0000000000ff", wakeOn: "all", items: [{ kind: "batch", id: "b1", settled: false }] });
    await store(workerTurn(10, { usage: usageOf(160_000_000) }));
    const fake = daemon();
    await start(fake, runnerOf(), workerTurn(10, { usage: usageOf(160_000_000) }));
    expect(firstLines(fake)).toEqual([HANDOFF_NOTICE_MARKER]);
    expect(handoffs().list()).toMatchObject([{ state: "noting" }]);
  });

  it("a no-safe-point drop counts toward handoff.maxPerRequest: the handoff re-arms at most that many times", async () => {
    const heavy = workerTurn(10, { usage: usageOf(160_000_000) });
    await store(heavy);
    const fake = daemon({ worker: "running" });
    const dropAll = () => {
      for (const entry of handoffs().list()) {
        if (entry.state === "waiting") handoffs().update(entry.id, (current) => endedHandoff(current, "no-safe-point", clock.toISOString()));
      }
    };
    // The first try, dropped with no safe point: one of the owner's two.
    await start(fake, runnerOf(), heavy);
    dropAll();
    // It re-arms once.
    clock = new Date(clock.getTime() + MIN);
    await start(fake, runnerOf(), heavy);
    expect(handoffs().list().map((entry) => entry.state)).toEqual(["dropped", "waiting"]);
    dropAll();
    const written = { handoffs: handoffs().list(), interventions: interventions() };
    // Two drops: none more.
    clock = new Date(clock.getTime() + MIN);
    await start(fake, runnerOf(), heavy);
    expect(handoffs().list()).toEqual(written.handoffs);
    expect(interventions()).toEqual(written.interventions);
    // At the owner's 3, a third try.
    createCoordinationStore(home).set({ key: "handoff.maxPerRequest", value: 3 });
    await start(fake, runnerOf(), heavy);
    expect(handoffs().list().map((entry) => entry.state)).toEqual(["dropped", "dropped", "waiting"]);
  });
});

describe("a bound Manager: the plugin creates the successor, the Manager is informed only (design §16.9)", () => {
  const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;

  /** The Manager's binding as `manager.ensure` leaves it: issued, attached, bound. */
  function bindManager(bindings: BindingStore): void {
    bindAgent(bindings, MANAGER, { role: "manager", workspaceId: WORKSPACE_ID });
  }

  /** The daemon with a bm-worker profile on Claude; each creation runs the hook's part that keeps the token URL. */
  function boundDaemon(
    bindings: BindingStore,
    hooks: {
      created?: (request: FakeCreateRequest) => void;
      onSend?: (message: { id: string; text: string }) => void;
      /** Runs after the hook kept the token URL: it may hold the creation, or throw as Paseo's late error. */
      afterHook?: () => Promise<void>;
    } = {},
  ): FakePaseo<unknown> {
    const created = hooks.created ?? (() => {});
    return daemon({
      extra: {
        ...(hooks.onSend === undefined ? {} : { onSend: hooks.onSend }),
        config: { agentProfiles: [{ id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" }], providers: { "bm-worker": { extends: "claude" } }, mcp: { injectIntoAgents: true } },
        providers: { modes: { "bm-worker": [{ id: "default", colorTier: "safe" }, { id: "bypassPermissions", colorTier: "dangerous" }] } },
        created: async (request) => {
          created(request);
          applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings }, "claude");
          await hooks.afterHook?.();
          return {};
        },
      },
    });
  }

  /** The note turn of the outgoing Worker, at minute 32: the turn that builds the brief and creates the successor. */
  function noteTurn(): TraceRecord {
    const posted = `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large (changed: no)\nfilesChanged: src/invoice/date.ts\nbeadsCreated: none\nbeadsUpdated: none\nbeadsClosed: bm-d1\nbeadsReady: bm-d2\nreviewFindingsOpen: none\nbuildAndTests: \`npm test\` pass\nskillsUsed: none\ndecided: none\nblockers: none\nhandoffNote: Parsing is done; next, bm-d2.`;
    return workerTurn(32, { startedAt: iso(T0 + 31 * MIN), reports: parseReports(posted, { agentId: WORKER, at: iso(T0 + 32 * MIN) }) });
  }

  /** The successor as Paseo lists it once created: labelled bm.handoffFrom, under the Manager. */
  const SUCCESSOR = "agent-successor";
  const successorAgent = () => ({
    id: SUCCESSOR,
    provider: "bm-worker/claude-opus-5",
    status: "idle",
    workspaceId: WORKSPACE_ID,
    labels: { "bm.role": "worker", "bm.requestId": REQUEST, [HANDOFF_FROM_LABEL]: WORKER, "paseo.parent-agent-id": MANAGER },
    createdAt: iso(T0 + 33 * MIN),
    archivedAt: null,
  });

  /**
   * Run 1 accepts the handoff, builds the brief and starts creating the successor, then is cut (a reload):
   * its creation never returns. Returns the daemon and run 2's runner, which knows nothing of run 1.
   */
  async function cutMidCreation(): Promise<{ fake: FakePaseo<unknown>; next: HandoffRunner }> {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    createRequestRegistry(home).register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MANAGER, workerId: WORKER });
    let entered!: () => void;
    const inCreation = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // The creation reaches Paseo, which creates the agent, and never answers this run.
    const fake = boundDaemon(bindings, {
      afterHook: () => {
        entered();
        return new Promise<void>(() => {});
      },
    });
    const first = await start(fake, runnerOf(() => binderOf(ROLE_URL, bindings, () => {})));
    clock = new Date(T0 + 32 * MIN);
    fake.byId(WORKER)!.status = "idle";
    void first.turnRecorded({ agent: { id: WORKER }, timeline: [] }, noteTurn(), fake.paseo);
    await inCreation;
    expect(handoffs().list()[0]).toMatchObject({ state: "creating", creatingAt: clock.toISOString(), successorId: null });
    return { fake, next: runnerOf(() => binderOf(ROLE_URL, bindings, () => {})) };
  }

  /** The handoff accepted, the note asked, and the note turn recorded: the step where the successor is made. */
  async function upToTheBrief(fake: FakePaseo<unknown>, runner: HandoffRunner, between: () => void = () => {}): Promise<void> {
    await start(fake, runner);
    between();
    clock = new Date(T0 + 32 * MIN);
    const posted = `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large (changed: no)\nfilesChanged: src/invoice/date.ts\nbeadsCreated: none\nbeadsUpdated: none\nbeadsClosed: bm-d1\nbeadsReady: bm-d2\nreviewFindingsOpen: none\nbuildAndTests: \`npm test\` pass\nskillsUsed: none\ndecided: none\nblockers: none\nhandoffNote: Parsing is done; next, bm-d2.`;
    fake.byId(WORKER)!.status = "idle";
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(32, { startedAt: iso(T0 + 31 * MIN), reports: parseReports(posted, { agentId: WORKER, at: iso(T0 + 32 * MIN) }) }), fake.paseo);
  }

  it("from the stored brief to a bound successor: labels, token, BM-BRIEF line, workerIds, BM-REPLACED, and an informational command the loop guard counts", async () => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    // The request as bm_create_worker registered it: the bound Manager is its managerId.
    createRequestRegistry(home).register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MANAGER, workerId: WORKER });
    const fake = boundDaemon(bindings);
    const runner = runnerOf(() => binderOf(ROLE_URL, bindings, (line) => logs.push(line)));
    await upToTheBrief(fake, runner);

    // The plugin created the successor itself, once.
    expect(fake.creates).toHaveLength(1);
    const [entry] = handoffs().list();
    const successorId = entry!.successorId!;
    expect(successorId).toBe("created-1");
    const { options } = fake.creates[0]!;
    expect(options).toMatchObject({
      config: { provider: "bm-worker/claude-opus-5", modeId: "bypassPermissions" },
      cwd: "/work/invoice-app",
      parent: MANAGER,
      title: "Fix the invoice date format; call the API with --token [redacted] to ch…",
      labels: { "bm.role": "worker", "bm.requestId": REQUEST, "bm.version": PLUGIN_VERSION, [HANDOFF_FROM_LABEL]: WORKER },
    });
    const prompt = options.prompt!;
    expect(prompt.split("\n").slice(0, 2)).toEqual([`BM-BRIEF worker requestId: ${REQUEST}`, `${HANDOFF_BRIEF_MARKER} ${entry!.id}`]);
    expect(prompt).toBe(`BM-BRIEF worker requestId: ${REQUEST}\n${entry!.brief}`);
    expect(originOf({ text: prompt, clientMessageId: "m-1" })).toBe("plugin-prompt");
    // A bound token.
    expect(bindings.bindingOfAgent(successorId)).toMatchObject({ role: "worker", state: "bound", requestId: REQUEST, parentId: MANAGER });

    // The request keeps its id and its Manager; the successor is its newest Worker.
    expect(createRequestRegistry(home).get(WORKSPACE_ID, REQUEST)).toMatchObject({ managerId: MANAGER, workerIds: [WORKER, successorId] });

    // The note request, the Manager's information, then the outgoing Worker's BM-REPLACED.
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER, WORKER]);
    const block = parseCommandBlock(fake.sends[1]!.text)!;
    expect(block).toMatchObject({ from: "orchestrator", to: "manager", requestId: REQUEST, intent: "handoff", authority: COORDINATION_HANDOFF_AUTHORITY, effects: [], approved: [] });
    expect(block.body).toBe(handoffInfoOf(entry!, successorId));
    expect(block.body).toContain(`from Worker ${WORKER} to Worker ${successorId}`);
    expect(block.body).toContain("Nothing is asked of you");
    expect(block.body).not.toContain("create_agent");
    expect(block.body).not.toContain(HANDOFF_BRIEF_MARKER);
    expect(fake.sends[2]!.text).toBe(replacedNoticeOf({ requestId: REQUEST }, successorId));
    // Counted by the loop guard.
    expect(commandsSentFor(createOrchestratorStore(home).listCommands(), WORKSPACE_ID, REQUEST, clock)).toBe(1);
    expect(entry).toMatchObject({ state: "done", ending: null, commandId: createOrchestratorStore(home).listCommands()[0]!.id });
    expect(labelled).toEqual([{ id: WORKER, labels: { [REPLACED_BY_LABEL]: successorId } }]);
    expect(fake.archives).toEqual([]);

    // Its agent.created completes nothing more, and says nothing.
    expect(await runner.agentCreated({ id: successorId, provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo)).toBeNull();
    expect(logs.join("\n")).not.toMatch(/no handoff of that Worker/);
    expect(fake.sends).toHaveLength(3);
    expect(labelled).toHaveLength(1);
    // Created under the Worker's Manager: the pairing holds.
    expect(await checkRolePairing({ id: successorId, provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo as never, { raiseAlert: () => {} })).toBe("paired");
  });

  it("an agent.created that arrives while the plugin is still finishing the handoff completes nothing", async () => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    let early: Promise<unknown> | null = null;
    let runner: HandoffRunner | null = null;
    // The successor exists and the Manager is being told: the event comes now, before the handoff is marked done.
    const fake: FakePaseo<unknown> = boundDaemon(bindings, {
      onSend: ({ id }) => {
        if (id === MANAGER && early === null) early = runner!.agentCreated({ id: "created-1", provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo);
      },
    });
    runner = runnerOf(() => binderOf(ROLE_URL, bindings, () => {}));
    await upToTheBrief(fake, runner);
    expect(await early).toBeNull();
    expect(handoffs().list()[0]).toMatchObject({ state: "done", successorId: "created-1" });
    expect(labelled).toHaveLength(1);
    expect(logs.join("\n")).not.toMatch(/no handoff of that Worker/);
  });

  it("two turn ends at once create exactly one successor: the first claims the brief (briefed → creating), the second finds it claimed", async () => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    createRequestRegistry(home).register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MANAGER, workerId: WORKER });
    const fake = boundDaemon(bindings);
    const runner = await start(fake, runnerOf(() => binderOf(ROLE_URL, bindings, () => {})));
    clock = new Date(T0 + 32 * MIN);
    fake.byId(WORKER)!.status = "idle";
    // The same turn end delivered twice, concurrently (and a third while the creation runs).
    await Promise.all([
      runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, noteTurn(), fake.paseo),
      runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, noteTurn(), fake.paseo),
      runner.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, null, fake.paseo),
    ]);
    expect(fake.creates).toHaveLength(1);
    expect(handoffs().list()).toMatchObject([{ state: "done", successorId: "created-1" }]);
    expect(createRequestRegistry(home).get(WORKSPACE_ID, REQUEST)!.workerIds).toEqual([WORKER, "created-1"]);
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER, WORKER]);
    expect(labelled).toHaveLength(1);
  });

  it("a reload during the creation: the next run completes it from Paseo's agent list, with no second successor", async () => {
    const { fake, next } = await cutMidCreation();
    // Paseo did create it; run 1 never heard back.
    fake.agents.push(successorAgent());
    clock = new Date(T0 + 34 * MIN);
    await next.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, null, fake.paseo);
    expect(fake.creates).toHaveLength(1);
    expect(handoffs().list()[0]).toMatchObject({ state: "done", successorId: SUCCESSOR, ending: null });
    expect(createRequestRegistry(home).get(WORKSPACE_ID, REQUEST)).toMatchObject({ managerId: MANAGER, workerIds: [WORKER, SUCCESSOR] });
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER, WORKER]);
    expect(parseCommandBlock(fake.sends[1]!.text)!.body).toBe(handoffInfoOf(handoffs().list()[0]!, SUCCESSOR));
    expect(labelled).toEqual([{ id: WORKER, labels: { [REPLACED_BY_LABEL]: SUCCESSOR } }]);
    // A later turn end does nothing more.
    await next.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, null, fake.paseo);
    expect(fake.creates).toHaveLength(1);
    expect(fake.sends).toHaveLength(3);
  });

  it("a reload during the creation: the successor's agent.created in the next run completes it", async () => {
    const { fake, next } = await cutMidCreation();
    fake.agents.push(successorAgent());
    const done = await next.agentCreated({ id: SUCCESSOR, provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo);
    expect(done).toMatchObject({ state: "done", successorId: SUCCESSOR });
    expect(fake.creates).toHaveLength(1);
    expect(createRequestRegistry(home).get(WORKSPACE_ID, REQUEST)!.workerIds).toEqual([WORKER, SUCCESSOR]);
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER, WORKER]);
  });

  it("a reload during the creation and no successor ever appears: it ends dropped, no-successor, and nothing is created again", async () => {
    const { fake, next } = await cutMidCreation();
    const lookups = () => fake.lists.filter((options) => options.filter?.labels?.[HANDOFF_FROM_LABEL] === WORKER).length;
    clock = new Date(clock.getTime() + CREATING_WAIT_MS - 1_000);
    await next.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, null, fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "creating" });
    // Looked up in Paseo once per run: a later successor completes it at its own agent.created.
    expect(lookups()).toBe(1);
    clock = new Date(clock.getTime() + 2_000);
    await next.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, null, fake.paseo);
    expect(lookups()).toBe(1);
    expect(handoffs().list()[0]).toMatchObject({ state: "dropped", ending: "no-successor", successorId: null });
    expect(fake.creates).toHaveLength(1);
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
  });

  it("Paseo errs after the hook kept the token: the handoff stays creating, and the successor's agent.created completes it", async () => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    createRequestRegistry(home).register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MANAGER, workerId: WORKER });
    const fake = boundDaemon(bindings, {
      afterHook: async () => {
        throw new Error("socket hang up");
      },
    });
    const runner = runnerOf(() => binderOf(ROLE_URL, bindings, () => {}));
    await upToTheBrief(fake, runner);
    expect(handoffs().list()[0]).toMatchObject({ state: "creating", successorId: null });
    expect(logs.join("\n")).toContain("waiting for it to appear");
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
    // The binding stays pending, for agent.created to settle (creation-settle.ts).
    expect(bindings.list().filter((binding) => binding.role === "worker")).toMatchObject([{ state: "pending", requestId: REQUEST, parentId: MANAGER }]);
    fake.agents.push(successorAgent());
    expect(await runner.agentCreated({ id: SUCCESSOR, provider: "bm-worker/claude-opus-5", parentAgentId: MANAGER, workspaceId: WORKSPACE_ID }, fake.paseo)).toMatchObject({ state: "done", successorId: SUCCESSOR });
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER, WORKER]);
  });

  it("refused before anything is created: at the loop guard, and when Paseo refuses the successor", async () => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    const fake = boundDaemon(bindings);
    // Twelve commands for the request went out after the handoff was accepted.
    await upToTheBrief(fake, runnerOf(() => binderOf(ROLE_URL, bindings, () => {})), () => {
      const orchestrator = createOrchestratorStore(home, { now: () => clock });
      for (let n = 0; n < COMMAND_LIMIT_PER_REQUEST; n += 1) {
        orchestrator.appendCommand({ id: `c${n}`, workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, situation: "s", command: "c", reason: "r", sentText: "BM-COMMAND", outcome: "sent" });
      }
    });
    expect(fake.creates).toEqual([]);
    expect(handoffs().list()[0]).toMatchObject({ state: "dropped", ending: "loop-guard", successorId: null });
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
    expect(labelled).toEqual([]);
  });

  it("Paseo refuses the successor: the handoff ends refused, and nothing is sent or labelled", async () => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    bindManager(bindings);
    const fake = boundDaemon(bindings, {
      created: () => {
        throw new Error("Provider 'bm-worker' is not available");
      },
    });
    await upToTheBrief(fake, runnerOf(() => binderOf(ROLE_URL, bindings, () => {})));
    expect(handoffs().list()[0]).toMatchObject({ state: "dropped", ending: "refused", successorId: null });
    expect(logs.join("\n")).toContain("created no successor: Paseo refused to create it: Provider 'bm-worker' is not available");
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
    expect(labelled).toEqual([]);
    // The binding the plugin issued for it is gone; only the Manager's stays.
    expect(bindings.list().map((binding) => binding.agentId)).toEqual([MANAGER]);
  });

  it.each([
    ["an unbound Manager", false],
    ["a Manager whose binding was revoked", true],
  ] as const)("%s keeps today's flow: it is commanded to create the successor itself", async (_what, revoked) => {
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    if (revoked) {
      bindManager(bindings);
      bindings.revokeAgent(MANAGER);
    }
    const fake = boundDaemon(bindings);
    await upToTheBrief(fake, runnerOf(() => binderOf(ROLE_URL, bindings, () => {})));
    expect(fake.creates).toEqual([]);
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER]);
    expect(parseCommandBlock(fake.sends[1]!.text)!.body).toContain(`${HANDOFF_FROM_LABEL} = ${WORKER}`);
    expect(handoffs().list()[0]).toMatchObject({ state: "commanded", successorId: null });
  });

  it("a request of a mission: the successor is created in the request's repo under the mission's current Main and joins the roster (missions design §9.5)", async () => {
    const MAIN = "agent-main";
    await store(...heavyRequest());
    const bindings = createBindingStore(home);
    const created = createMissionStore(home).create({ code: "INV", name: "Invoices", goal: "", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MAIN });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    const missionId = created.mission.missionId;
    bindAgent(bindings, MAIN, { role: "manager", workspaceId: "wks-home", missionId });
    createMissionRoster(home).add(missionId, { requestId: REQUEST, workspaceId: WORKSPACE_ID, topic: "Invoice dates", workerId: WORKER });
    // The Main was replaced since the Worker was created: its parent label still names the old one, the registry the current one.
    createRequestRegistry(home).register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MAIN, workerId: WORKER });
    createRequestRegistry(home).reassignManager(WORKSPACE_ID, REQUEST, MAIN);
    const fake = boundDaemon(bindings);
    fake.agents.push({ id: MAIN, provider: "bm-manager", status: "idle", workspaceId: "wks-home", labels: { "bm.role": "manager", "bm.missionId": missionId }, createdAt: iso(T0), archivedAt: null });
    await upToTheBrief(fake, runnerOf(() => binderOf(ROLE_URL, bindings, () => {})));

    const [entry] = handoffs().list();
    expect(entry).toMatchObject({ managerId: MAIN, missionId, state: "done", successorId: "created-1" });
    // Created through the repo's workspace, under the Main, with no cwd of its own (Paseo places it in the repo).
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]!.options).toMatchObject({ parent: MAIN, labels: { "bm.requestId": REQUEST, [HANDOFF_FROM_LABEL]: WORKER } });
    expect(fake.creates[0]!.options.cwd).toBeUndefined();
    expect(bindings.bindingOfAgent("created-1")).toMatchObject({ role: "worker", state: "bound", parentId: MAIN, missionId });
    expect(createMissionRoster(home).get(missionId, REQUEST)).toMatchObject({ workerIds: [WORKER, "created-1"], state: "active" });
    expect(createRequestRegistry(home).get(WORKSPACE_ID, REQUEST)).toMatchObject({ managerId: MAIN, workerIds: [WORKER, "created-1"] });
    // The Main is told in one notice — the informational command — and the outgoing Worker gets its BM-REPLACED.
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MAIN, WORKER]);
    expect(parseCommandBlock(fake.sends[1]!.text)!.body).toBe(handoffInfoOf(entry!, "created-1"));
    expect(createMissionStore(home).get(missionId)).toMatchObject({ mainId: MAIN, state: "open" });
  });
});

describe("the note request follows the outgoing Worker's binding (design §16.7)", () => {
  /** The Worker's binding as `bm_create_worker` leaves it: issued, attached, bound. */
  function bindWorker(): void {
    bindAgent(createBindingStore(home), WORKER, { role: "worker", workspaceId: WORKSPACE_ID, requestId: REQUEST, parentId: MANAGER });
  }

  it("a bound Worker is asked to call bm_report, which stores and delivers the note", async () => {
    await store(...heavyRequest());
    bindWorker();
    const fake = daemon();
    await start(fake);
    expect(fake.sends).toEqual([{ id: WORKER, text: noteRequestOf({ requestId: REQUEST }, { bound: true }) }]);
  });

  it("an unbound Worker is asked to post the block", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    await start(fake);
    expect(fake.sends).toEqual([{ id: WORKER, text: noteRequestOf({ requestId: REQUEST }) }]);
  });
});

describe("the pieces", () => {
  it("a safe point: a bead closed with evidence, beads-done or bead-implemented, or a review verdict of its own Reviewer since its turn before", () => {
    expect(handoffSafePointIn(workerTurn(10, { evidence: [ran("br close bm-d1 --reason ok", iso(T0))] }))).toBe(true);
    // A close that failed, or only looked, is none.
    expect(handoffSafePointIn(workerTurn(10, { evidence: [{ ...ran("br close bm-d1", iso(T0)), status: "failed", exitCode: 1 }] }))).toBe(false);
    expect(handoffSafePointIn(workerTurn(10, { evidence: [ran("br close --help", iso(T0))] }))).toBe(false);
    expect(handoffSafePointIn(workerTurn(10, { reports: [report({ phase: "bead-implemented", requestId: REQUEST })] }))).toBe(true);
    expect(handoffSafePointIn(workerTurn(10, { reports: [report({ phase: "blocked", requestId: REQUEST })] }))).toBe(false);
    const before = workerTurn(10);
    const now = workerTurn(20);
    const verdict = turn({ agentId: REVIEWER, role: "reviewer", parentAgentId: WORKER, endedAt: iso(T0 + 15 * MIN), at: iso(T0 + 15 * MIN), reviews: [{ agentId: REVIEWER, at: iso(T0 + 15 * MIN), batchId: "b2", verdict: "pass", blockingCount: 0 }] });
    expect(handoffSafePointIn(now, [], [before, verdict, now])).toBe(true);
    // A verdict before its turn before was already handled then.
    expect(handoffSafePointIn(now, [], [workerTurn(16), verdict, now])).toBe(false);
  });

  it("the note: handoffNote of a report of the request, posted or sent; none otherwise", () => {
    const withNote = workerTurn(10, { reports: [report({ requestId: REQUEST, phase: "beads-done", handoffNote: "Next: bm-d2." })] });
    expect(noteIn(withNote, [], REQUEST)).toBe("Next: bm-d2.");
    expect(noteIn(workerTurn(10, { reports: [report({ requestId: REQUEST })] }), [], REQUEST)).toBeNull();
    expect(noteIn(withNote, [], "req-20260930T120000Z")).toBeNull();
    expect(noteRequestOf({ requestId: REQUEST })).toMatch(/^BM-HANDOFF\n/);
    expect(noteRequestOf({ requestId: REQUEST })).toContain("call bm_report for req-20260930T100000Z with the phase and facts of your last report and handoffNote");
  });

  it("the note request: an unbound Worker posts the block; a bound one lets bm_report store and deliver it", () => {
    const unbound = noteRequestOf({ requestId: REQUEST });
    expect(unbound).toBe(noteRequestOf({ requestId: REQUEST }, { bound: false }));
    expect(unbound).toContain("— and post the block it returns as your reply here; do not send it to your Manager.");
    const bound = noteRequestOf({ requestId: REQUEST }, { bound: true });
    expect(bound.split("\n")[0]).toBe(HANDOFF_NOTICE_MARKER);
    expect(isPluginNotice(bound)).toBe(true);
    expect(bound).toContain(
      `Write your handoff note now: call bm_report for ${REQUEST} with the phase and facts of your last report and handoffNote — what you tried and what is next, at most 1,500 characters. The tool stores the note and delivers the report; send nothing else.`,
    );
    expect(bound).not.toMatch(/post the block|do not send it to your Manager/);
    expect(bound.split("\n").at(-1)).toBe(unbound.split("\n").at(-1));
  });

  it("the note is found in each path: posted in the chat, sent with send_agent_prompt (unbound), or stored by bm_report (bound)", () => {
    const block = `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large (changed: no)\nfilesChanged: none\nbeadsCreated: none\nbeadsUpdated: none\nbeadsClosed: bm-d1\nbeadsReady: bm-d2\nreviewFindingsOpen: none\nbuildAndTests: not run\nskillsUsed: none\ndecided: none\nblockers: none\nhandoffNote: Next: bm-d2.`;
    const at = iso(T0 + 32 * MIN);
    // Unbound, posted: the collector parses the chat into the turn's reports.
    expect(noteIn(workerTurn(32, { reports: parseReports(block, { agentId: WORKER, at }) }), [], REQUEST)).toBe("Next: bm-d2.");
    // Unbound, sent to the Manager by hand: read from the turn's send_agent_prompt call.
    const sentItems = [{ type: "tool_call", name: "mcp__paseo__send_agent_prompt", detail: { input: { agentId: MANAGER, prompt: block } } }];
    expect(noteIn(workerTurn(32), sentItems, REQUEST)).toBe("Next: bm-d2.");
    // Bound: bm_report wrote an outbox record, which the collector puts in the Worker's turn record.
    const stored: OutboxRecord = { id: "out-000000000001", kind: "report", requestId: REQUEST, batchId: null, from: WORKER, to: MANAGER, text: block, createdAt: at, state: "delivered", outcomeAt: at, reason: null };
    const { reports } = outboxBlocksOf([stored], WORKER);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.recordId).toBe(stored.id);
    expect(noteIn(workerTurn(32, { reports }), [], REQUEST)).toBe("Next: bm-d2.");
    // Its bm_report tool call in the timeline is no block: the record is the one source, read once.
    const toolItems = [{ type: "tool_call", name: "mcp__paseo-bm__bm_report", detail: { input: { requestId: REQUEST, phase: "beads-done", handoffNote: "Next: bm-d2." } } }];
    expect(noteIn(workerTurn(32, { reports }), toolItems, REQUEST)).toBe("Next: bm-d2.");
  });

  it("the brief is bounded: the lists shrink before the note, nothing is cut mid-word, and the closing paragraph always stays", async () => {
    await store(...heavyRequest(Array.from({ length: 900 }, (_, n) => `w${String(n).padStart(4, "0")}`).join(" ")));
    const added = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "r" });
    const note = Array.from({ length: 300 }, (_, n) => `n${String(n).padStart(3, "0")}`).join(" ");
    const entry = { ...added, note };
    const brief = await handoffBriefOf(entry, { paseo: daemon().paseo, location: location(), git });
    expect(brief.length).toBeLessThanOrEqual(HANDOFF_BRIEF_MAX_CHARS);
    expect(brief).toContain(`note: ${note}`);
    expect(brief.match(/\bw\d+/g)!.every((word) => word.length === 5)).toBe(true);
    expect(brief).toMatch(/^request: w0000 .* w\d{4}…$/m);
    expect(brief.endsWith(briefClosingOf(WORKER))).toBe(true);
    expect(holdsHandoffBrief(brief)).toBe(true);
    // It fits the command's body beside the Manager's instructions.
    expect(parseCommandBlock(`BM-COMMAND\nfrom: orchestrator\nvia: chat\nto: manager\nrequestId: ${REQUEST}\nre: x\nintent: handoff\neffects: none\nauthority: coordination:handoff\napproved: none\n\n${handoffCommandOf(entry, brief).body}`)).not.toBeNull();
  });

  it("the command bounds an over-long brief at a word's end and keeps its closing paragraph", () => {
    const entry = { id: "h1", requestId: REQUEST, workerId: WORKER, reason: "r" };
    const closing = briefClosingOf(WORKER);
    const body = handoffCommandOf(entry, `${HANDOFF_BRIEF_MARKER} h1\nrequest: ${"word ".repeat(1_500)}\n\n${closing}`).body;
    expect(body.length).toBeLessThanOrEqual(MAX_COMMAND_BODY_CHARS);
    expect(body.endsWith(`word\n…\n\n${closing}`)).toBe(true);
  });
});

describe("the brief keeps the newest facts and the open questions (design §7.17.8 h)", () => {
  /** Question `Qn` of the request, open or answered with option c. */
  function question(n: number, open: boolean): void {
    const decision = makeDecision({ id: `q:${REQUEST}:Q${n}`, workspaceId: WORKSPACE_ID, requestId: REQUEST, question: `Question number ${n} about the plan?` });
    createDecisionStore(home).open(decision);
    if (open) return;
    const result = answerDecision(decision, { via: "inbox", optionKey: "c", words: null, at: iso(T0 + n * MIN) });
    if (!result.ok) throw new Error(result.message);
    createDecisionStore(home).transition(result.decision.id, () => ({ ok: true, decision: result.decision }), WORKSPACE_ID);
  }

  it("fixed short facts first, then the lists; the newest beads kept with +n earlier; open questions first, newest answered, +n earlier; the reason labelled with its time", async () => {
    const beads = Array.from({ length: 40 }, (_, n) => `esm-independence-vfz.${n + 1}`);
    await store(
      ...heavyRequest(),
      workerTurn(20, { reports: [report({ agentId: WORKER, at: iso(T0 + 20 * MIN), requestId: REQUEST, phase: "bead-implemented", beadsClosed: beads, beadsCreated: beads })] }),
    );
    for (let n = 1; n <= 30; n += 1) question(n, n === 9 || n === 10 || n === 11);
    const added = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "Past 151M tokens after M1-M2, still M3-M5." });
    const entry = { ...added, note: "M3 and M4 are done; M5 is next." };
    const brief = await handoffBriefOf(entry, { paseo: daemon().paseo, location: location(), git, now: () => new Date(T0 + 50 * MIN) });
    const lines = brief.split("\n");
    const labels = lines.map((line) => /^[\w.+-]+:/.exec(line)?.[0] ?? line.slice(0, 4));
    expect(brief.length).toBeLessThanOrEqual(HANDOFF_BRIEF_MAX_CHARS);
    expect(labels.slice(0, 12)).toEqual(["BM-H", "role:", "requestId:", "managerAgentId:", "replaces:", "lastReport:", "tier:", "reviewCalls:", "branch:", "diffStat:", "note:", "reason:"]);
    expect(brief).toContain(`lastReport: bead-implemented at ${iso(T0 + 20 * MIN)} (30 min before this brief)`);
    expect(brief).toContain(`reason: (at ${added.requestedAt}; the facts above are newer) Past 151M tokens after M1-M2, still M3-M5.`);
    expect(brief).toContain("note: M3 and M4 are done; M5 is next.");
    const closed = lines.find((line) => line.startsWith("beadsClosed: "))!;
    expect(closed).toMatch(/^beadsClosed: \+\d+ earlier, .*esm-independence-vfz\.39, esm-independence-vfz\.40$/);
    expect(closed).not.toContain("vfz.1,");
    const asked = lines.slice(lines.indexOf("questions:") + 1).filter((line) => line.startsWith("- Q") || line.startsWith("+"));
    expect(asked.slice(0, 3).map((line) => line.split(":")[0])).toEqual(["- Q9", "- Q10", "- Q11"]);
    expect(asked.slice(0, 3).every((line) => line.endsWith(" → open"))).toBe(true);
    expect(asked[3]!.startsWith("- Q30: ")).toBe(true);
    expect(asked.at(-1)).toMatch(/^\+\d+ earlier \(bm_decisions\)$/);
    expect(brief.endsWith(briefClosingOf(WORKER))).toBe(true);
  });

  it("open questions are always kept, every one, even when the answered ones all give way", async () => {
    await store(...heavyRequest());
    for (let n = 1; n <= 12; n += 1) question(n, n <= 8);
    const added = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "r" });
    const brief = await handoffBriefOf({ ...added, note: "x ".repeat(750) }, { paseo: daemon().paseo, location: location(), git });
    expect(brief.length).toBeLessThanOrEqual(HANDOFF_BRIEF_MAX_CHARS);
    for (let n = 1; n <= 8; n += 1) expect(brief).toMatch(new RegExp(`^- Q${n}: .* → open$`, "m"));
  });

  it("a request carrying a peer link keeps its peer: and peerAsk: block and both rules in the successor's brief", async () => {
    const block = [`peer: lnk-1 from project "frontend" (wks-front), request req-20261001T000000Z`, "peerAsk:", "> Add GET /invoices/:id/pdf, please.", "> We need it by Friday."];
    await store(...heavyRequest(), workerTurn(5, { sent: [msg(WORKER, iso(T0 + 4 * MIN), [`BM-BRIEF worker requestId: ${REQUEST}`, "role: worker", `requestId: ${REQUEST}`, `managerAgentId: ${MANAGER}`, ...block, "request: Serve the PDF endpoint."].join("\n"))] }));
    const added = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "r" });
    const brief = await handoffBriefOf(added, { paseo: daemon().paseo, location: location(), git });
    expect(brief).toContain([`managerAgentId: ${MANAGER}`, ...block, ...PEER_RULES, `replaces: ${WORKER}`].join("\n"));
    // A successor's successor: the block is read again from the handoff brief, the rules once.
    expect(peerBlockOf([brief])).toEqual([...block, ...PEER_RULES]);
    expect(peerBlockOf(["request: no link here"])).toEqual([]);
  });
});

describe("the successor proves again (design §G.6 step 5, detected evidence §C.2)", () => {
  const edit = (path: string, when: string, agentId: string): Evidence => ({ kind: "file", detail: path, agentId, at: when });
  const finished = (buildAndTests: string) => report({ agentId: MANAGER, at: iso(T0 + 50 * MIN), requestId: REQUEST, phase: "finished", filesChanged: ["src/invoice/date.ts"], buildAndTests });
  const predecessor = workerTurn(10, { evidence: [edit("src/invoice/date.ts", iso(T0 + 8 * MIN), WORKER), ran("npm test", iso(T0 + 9 * MIN))] });
  const successorFirst = (evidence: Evidence[]) =>
    workerTurn(40, { startedAt: iso(T0 + 30 * MIN), sent: [msg("agent-successor", iso(T0 + 30 * MIN), `${HANDOFF_BRIEF_MARKER} h1\nrequestId: ${REQUEST}\nreplaces: ${WORKER}`, "agent")], evidence }, "agent-successor");

  it("a successor's finished report without a check it ran itself is finished-unverified, even when the Worker it replaced ran it after the last edit", () => {
    const finish = requestFinishOf({ reports: [finished("`npm test` pass")], records: [predecessor, successorFirst([])], workspaceDirectory: null });
    expect(finish).toMatchObject({ checks: "self-reported", unverified: true });
    expect(finish!.named).toEqual([{ check: "npm test", label: "self-reported" }]);
  });

  it("its own run after the handoff is detected; the same records without the handoff read the predecessor's run", () => {
    const own = requestFinishOf({ reports: [finished("`npm test` pass")], records: [predecessor, successorFirst([ran("npm test", iso(T0 + 35 * MIN), "agent-successor")])], workspaceDirectory: null });
    expect(own).toMatchObject({ checks: "detected", unverified: false });
    expect(requestFinishOf({ reports: [finished("`npm test` pass")], records: [predecessor], workspaceDirectory: null })).toMatchObject({ checks: "detected", unverified: false });
  });

  it("a successor the plugin knows by its label is held to its own checks even when its first message lacks the brief's marker (Phase 3 live check F2)", () => {
    const unmarked = (evidence: Evidence[], minute = 40) =>
      workerTurn(minute, { startedAt: iso(T0 + (minute - 10) * MIN), sent: [msg("agent-successor", iso(T0 + (minute - 10) * MIN), `requestId: ${REQUEST}\nrequest: fix the date`, "agent")], evidence }, "agent-successor");
    const successors = new Set(["agent-successor"]);
    // Without the label the marker-less first turn is not a handoff: the predecessor's run counts.
    expect(requestFinishOf({ reports: [finished("`npm test` pass")], records: [predecessor, unmarked([])], workspaceDirectory: null })).toMatchObject({ checks: "detected" });
    const known = requestFinishOf({ reports: [finished("`npm test` pass")], records: [predecessor, unmarked([])], workspaceDirectory: null, handoffSuccessors: successors });
    expect(known).toMatchObject({ checks: "self-reported", unverified: true });
    // Its own run counts, in its first turn or a later one; only its first turn is the handoff.
    const own = requestFinishOf({ reports: [finished("`npm test` pass")], records: [predecessor, unmarked([]), unmarked([ran("npm test", iso(T0 + 44 * MIN), "agent-successor")], 45)], workspaceDirectory: null, handoffSuccessors: successors });
    expect(own).toMatchObject({ checks: "detected", unverified: false });
  });
});
