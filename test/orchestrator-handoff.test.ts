import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBindingStore, type AgentBinder, type BindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { COMMAND_LIMIT_PER_REQUEST, HANDOFF_OFF_MESSAGE, commandsSentFor, sendCommand } from "../plugin/server/command-send";
import { WORKER_TITLE } from "../plugin/server/create-worker";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { outboxBlocksOf } from "../plugin/server/collector";
import type { OutboxRecord } from "../plugin/server/outbox";
import { originOf } from "../plugin/shared/message-origin";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import {
  HANDOFF_BRIEF_MAX_CHARS,
  HANDOFF_FROM_LABEL,
  REPLACED_BY_LABEL,
  createHandoffRunner,
  handoffBriefOf,
  handoffCommandOf,
  handoffInfoOf,
  handoffSafePointIn,
  noteIn,
  noteRequestOf,
  replacedNoticeOf,
  type HandoffRunner,
} from "../plugin/server/handoff";
import { CREATING_WAIT_MS, HANDOFFS_DIR_NAME, MANAGER_WAIT_MS, NOTE_WAIT_MS, SUCCESSOR_WAIT_MS, createHandoffStore, type HandoffEntry } from "../plugin/server/handoff-store";
import { createInterventionStore } from "../plugin/server/intervention-store";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createOrchestratorTools, type OrchestratorTools } from "../plugin/server/orchestrator-tools";
import type { CliResult } from "../plugin/server/paseo-cli";
import { checkRolePairing } from "../plugin/server/role-pairing";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { parseReports } from "../plugin/shared/bm-report";
import type { Evidence, TraceRecord, Usage } from "../plugin/shared/contracts";
import { requestFinishOf } from "../plugin/shared/evidence";
import { HANDOFF_BRIEF_MARKER, holdsHandoffBrief } from "../plugin/shared/handoff";
import { HANDOFF_NOTICE_MARKER, REPLACED_NOTICE_MARKER, isPluginNotice } from "../plugin/shared/notices";
import { COORDINATION_HANDOFF_AUTHORITY, parseCommandBlock } from "../plugin/shared/orchestrator-command";
import { fakePaseo, type FakeCreateRequest, type FakePaseo, type FakePaseoOptions } from "./helpers/fake-paseo";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, msg, report, turn } from "./fixtures/orchestrator-traces";
import { bindAgent } from "./helpers/bindings";

/**
 * Handoff through the Manager (autonomy design §G.6; PRD REQ-135; change-008
 * C3; bead `7gxw.11`): `bm_handoff`'s refusals, one per rule, each writing
 * nothing; the whole sequence with the one fake of `test/helpers/fake-paseo.ts`
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

function toolsOf(fake: FakePaseo<unknown>, runner: HandoffRunner = runnerOf()): OrchestratorTools {
  const tools = createOrchestratorTools({
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    now: () => clock,
    redactEnv: { PASEO_PASSWORD: SECRET },
    handoff: runner,
    queue,
    log: (line) => logs.push(line),
  });
  tools.usePaseo(fake.paseo);
  return tools;
}

const handoff = (tools: OrchestratorTools, workerId = WORKER, reason = "Its request read 160M tokens.") => tools.call("bm_handoff", { workerId, reason });

describe("bm_handoff refuses, writing nothing (design §G.6 The tool)", () => {
  const nothingWritten = () => {
    expect(existsSync(join(home, HANDOFFS_DIR_NAME))).toBe(false);
    expect(interventions()).toEqual([]);
  };

  it("when handoff is off", async () => {
    createCoordinationStore(home).set({ key: "handoff.enabled", value: false });
    await store(...heavyRequest());
    const fake = daemon();
    expect(await handoff(toolsOf(fake))).toEqual({ ok: false, text: "Refused: handoff is off in the owner's Settings → Coordination; only the owner turns it on." });
    nothingWritten();
    expect(fake.sends).toEqual([]);
  });

  it("when the target is not the live Worker of an unfinished request", async () => {
    await store(...heavyRequest());
    const tools = toolsOf(daemon());
    expect((await handoff(tools, REVIEWER)).text).toBe(`Refused: ${REVIEWER} is not a paseo-bm Worker; use a Worker's id from bm_request or bm_projects.`);
    expect((await handoff(tools, MANAGER)).text).toBe(`Refused: ${MANAGER} is not a paseo-bm Worker; use a Worker's id from bm_request or bm_projects.`);
    expect((await handoff(toolsOf(daemon({ workerArchived: true })))).text).toBe(`Refused: Worker ${WORKER} is archived; nothing is handed over from it.`);
    expect((await handoff(toolsOf(daemon({ workerLabels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER } })))).text).toBe(
      `Refused: Worker ${WORKER} carries no request (bm.requestId); only the Worker of a request is handed over.`,
    );
    const replaced = daemon({ workerLabels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER, [REPLACED_BY_LABEL]: "agent-next" } });
    expect((await handoff(toolsOf(replaced))).text).toBe(`Refused: Worker ${WORKER} was already replaced by agent-next; hand over its successor instead.`);
    nothingWritten();
  });

  it("when its request is finished, or it has no live Manager to create the successor", async () => {
    await store(...heavyRequest());
    expect((await handoff(toolsOf(daemon({ managerArchived: true })))).text).toBe(`Refused: Worker ${WORKER} has no live Manager in its project to create its successor.`);
    await store(workerTurn(12, { reports: [report({ agentId: MANAGER, at: iso(T0 + 12 * MIN), requestId: REQUEST, phase: "finished" })] }));
    expect((await handoff(toolsOf(daemon()))).text).toBe(`Refused: request ${REQUEST} is finished; only an unfinished request is handed over.`);
    nothingWritten();
  });

  it("below its threshold, since it started and since its last handoff", async () => {
    await store(workerTurn(10, { usage: usageOf(40_000_000) }));
    const tools = toolsOf(daemon());
    expect((await handoff(tools)).text).toBe(`Refused: request ${REQUEST} is below its threshold: since it started it read 40,000,000 tokens (threshold 150,000,000).`);
    nothingWritten();
    // A handoff done at minute 20: only the turns after it count again.
    await store(workerTurn(11, { usage: usageOf(160_000_000) }), workerTurn(25, { usage: usageOf(5_000_000) }, "agent-successor"));
    const done = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: "agent-before", managerId: MANAGER, interventionId: null, reason: "" });
    handoffs().update(done.id, (entry) => ({ ...entry, state: "done", successorId: WORKER, successorAt: iso(T0 + 20 * MIN), endedAt: iso(T0 + 20 * MIN) }));
    expect((await handoff(tools)).text).toBe(
      `Refused: request ${REQUEST} is below its threshold: since its last handoff (${iso(T0 + 20 * MIN)}) it read 5,000,000 tokens (threshold 150,000,000).`,
    );
    expect(interventions()).toEqual([]);
  });

  it("while a handoff of the request is pending, at handoff.maxPerRequest, and at the loop guard", async () => {
    createCoordinationStore(home).set({ key: "handoff.maxPerRequest", value: 1 });
    await store(...heavyRequest());
    const fake = daemon({ worker: "running" });
    const tools = toolsOf(fake);
    expect((await handoff(tools)).ok).toBe(true);
    const written = { handoffs: handoffs().list(), interventions: interventions() };
    expect((await handoff(tools)).text).toBe(`Refused: a handoff of request ${REQUEST} is already pending, requested at ${clock.toISOString()}.`);
    // It completed: one handoff so far, the owner's limit of 1.
    handoffs().update(written.handoffs[0]!.id, (entry) => ({ ...entry, state: "done", successorId: "agent-next", successorAt: clock.toISOString(), endedAt: clock.toISOString() }));
    expect((await handoff(tools)).text).toBe(`Refused: request ${REQUEST} was handed over 1 times, the owner's limit per request (handoff.maxPerRequest).`);
    expect(interventions()).toEqual(written.interventions);
    // The loop guard: 12 commands for the request in 24 hours.
    createCoordinationStore(home).set({ key: "handoff.maxPerRequest", value: 5 });
    await store(workerTurn(40, { usage: usageOf(160_000_000) }));
    const orchestrator = createOrchestratorStore(home, { now: () => clock });
    for (let n = 0; n < COMMAND_LIMIT_PER_REQUEST; n += 1) {
      orchestrator.appendCommand({ id: `c${n}`, workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, situation: "s", command: "c", reason: "r", sentText: "BM-COMMAND", outcome: "sent" });
    }
    expect((await handoff(tools)).text).toBe(`Refused: the commands for request ${REQUEST} reached the loop guard; ask the owner with bm_ask_owner.`);
    expect(fake.sends).toEqual([]);
  });
});

describe("the whole sequence (design §G.6) with the one fake daemon", () => {
  it("asks the idle Worker for its note after a safe point, builds the brief, commands the Manager, and links the successor it creates", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    const runner = runnerOf();
    const tools = toolsOf(fake, runner);

    // Accepted: logged as a handoff, the note asked at once (the Worker is idle after closing a bead).
    const accepted = await handoff(tools);
    expect(accepted).toMatchObject({ ok: true, text: expect.stringContaining(`Worker ${WORKER} was idle after a safe point: it was asked for its handoff note now.`) });
    expect(accepted.text).toContain(`Handoff ${handoffs().list()[0]!.id} of request ${REQUEST} accepted: its request read 160,000,000 tokens since it started (threshold 150,000,000).`);
    expect(fake.sends).toEqual([{ id: WORKER, text: noteRequestOf({ requestId: REQUEST }) }]);
    expect(isPluginNotice(fake.sends[0]!.text)).toBe(true);
    const [asked] = handoffs().list();
    expect(asked).toMatchObject({ workerId: WORKER, managerId: MANAGER, requestId: REQUEST, state: "noting", noteAskedAt: clock.toISOString(), reason: "Its request read 160M tokens." });
    expect(interventions()).toMatchObject([{ id: asked!.interventionId, kind: "handoff", targetAgentId: WORKER, requestId: REQUEST, trigger: "orchestrator", expected: "successor-progresses" }]);

    // The note turn: the Worker posts bm_report's block with its handoffNote in its own chat.
    clock = new Date(T0 + 32 * MIN);
    const posted = `BM-REPORT\nrequestId: ${REQUEST}\nphase: beads-done\ntier: Large (changed: no)\nfilesChanged: src/invoice/date.ts\nbeadsCreated: none\nbeadsUpdated: none\nbeadsClosed: bm-d1\nbeadsReady: bm-d2\nreviewFindingsOpen: none\nbuildAndTests: \`npm test\` pass\nskillsUsed: none\ndecided: none\nblockers: none\nhandoffNote: Parsing is done in date.ts; next, bm-d2 formats the PDF. Beware --secret hunter2 in the fixture.`;
    const noteTurn = workerTurn(32, { startedAt: iso(T0 + 31 * MIN), reports: parseReports(posted, { agentId: WORKER, at: iso(T0 + 32 * MIN) }) });
    fake.byId(WORKER)!.status = "idle";
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, noteTurn, fake.paseo);

    // The command: to the Manager only, intent handoff on coordination:handoff, the brief in its body.
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER, MANAGER]);
    const block = parseCommandBlock(fake.sends[1]!.text)!;
    expect(block).toMatchObject({ from: "orchestrator", to: "manager", requestId: REQUEST, intent: "handoff", authority: COORDINATION_HANDOFF_AUTHORITY, effects: [], approved: [], why: "Its request read 160M tokens." });
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
    const runner = runnerOf();
    await handoff(toolsOf(fake, runner));
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
    const runner = runnerOf();
    const accepted = await handoff(toolsOf(fake, runner));
    expect(accepted.text).toContain(`It waits for Worker ${WORKER}'s next safe point (a bead closed, beads-done or a review verdict) and idle moment`);
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
    const runner = runnerOf();
    await handoff(toolsOf(fake, runner));
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
    const runner = runnerOf();
    await handoff(toolsOf(fake, runner));
    // A turn of the Worker that started ten minutes before the request went out and ends now.
    clock = new Date(T0 + 31 * MIN);
    await runner.turnRecorded({ agent: { id: WORKER }, timeline: [] }, workerTurn(31, { startedAt: iso(T0 + 20 * MIN) }), fake.paseo);
    expect(handoffs().list()[0]).toMatchObject({ state: "noting", brief: null });
    expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
  });

  it("the owner's switch stops it at once: a pending handoff ends at its next step, and the send refuses a handoff while off", async () => {
    await store(...heavyRequest());
    const fake = daemon({ worker: "running" });
    const runner = runnerOf();
    await handoff(toolsOf(fake, runner));
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
      grantOf: null,
      approved: [],
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
    const first = runnerOf(() => binderOf(ROLE_URL, bindings, () => {}));
    await handoff(toolsOf(fake, first));
    clock = new Date(T0 + 32 * MIN);
    fake.byId(WORKER)!.status = "idle";
    void first.turnRecorded({ agent: { id: WORKER }, timeline: [] }, noteTurn(), fake.paseo);
    await inCreation;
    expect(handoffs().list()[0]).toMatchObject({ state: "creating", creatingAt: clock.toISOString(), successorId: null });
    return { fake, next: runnerOf(() => binderOf(ROLE_URL, bindings, () => {})) };
  }

  /** The handoff accepted, the note asked, and the note turn recorded: the step where the successor is made. */
  async function upToTheBrief(fake: FakePaseo<unknown>, runner: HandoffRunner, between: () => void = () => {}): Promise<void> {
    await handoff(toolsOf(fake, runner));
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
      title: WORKER_TITLE,
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
    const runner = runnerOf(() => binderOf(ROLE_URL, bindings, () => {}));
    await handoff(toolsOf(fake, runner));
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
    expect((await handoff(toolsOf(fake))).ok).toBe(true);
    expect(fake.sends).toEqual([{ id: WORKER, text: noteRequestOf({ requestId: REQUEST }, { bound: true }) }]);
  });

  it("an unbound Worker is asked to post the block", async () => {
    await store(...heavyRequest());
    const fake = daemon();
    expect((await handoff(toolsOf(fake))).ok).toBe(true);
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

  it("the brief is bounded: a long note is cut first, and the closing paragraph always stays", async () => {
    await store(...heavyRequest("x ".repeat(3_000)));
    const added = handoffs().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "r" });
    const entry = { ...added, note: "n".repeat(1_500) };
    const brief = await handoffBriefOf(entry, { paseo: daemon().paseo, location: location(), git });
    expect(brief.length).toBeLessThanOrEqual(HANDOFF_BRIEF_MAX_CHARS);
    expect(brief).toContain("Send `received` to `managerAgentId` now.");
    expect(holdsHandoffBrief(brief)).toBe(true);
    // It fits the command's body beside the Manager's instructions.
    expect(parseCommandBlock(`BM-COMMAND\nfrom: orchestrator\nvia: chat\nto: manager\nrequestId: ${REQUEST}\nre: x\nintent: handoff\neffects: none\nauthority: coordination:handoff\napproved: none\n\n${handoffCommandOf(entry, brief).body}`)).not.toBeNull();
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
