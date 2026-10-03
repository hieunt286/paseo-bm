import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_CALLER_MESSAGE, type ToolCaller } from "../plugin/server/agent-bindings";
import { BUILDER_SEND_LINES, answer, answerWithServerTools, withAgentTools } from "../plugin/server/agent-tools";
import { createAlertStore } from "../plugin/server/alert-store";
import { clearStartMarks, currentTurnStartOf, noteTurnStart, relayRequestIdOf } from "../plugin/server/collector";
import { NO_DATA_FOLDER_MESSAGE } from "../plugin/server/create-worker";
import { clearMaterialiserMemory, materialiseTurn } from "../plugin/server/decision-materialiser";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import {
  DELIVERY_NOT_BOUND_MESSAGE,
  NO_PASEO_DELIVERY_MESSAGE,
  QUESTIONS_NOT_BOUND_MESSAGE,
  TELL_NOT_BOUND_MESSAGE,
  batchesAwaitingVerdict,
  createDeliveringTools,
  type DeliveringToolDeps,
} from "../plugin/server/deliver-tools";
import { noteIn } from "../plugin/server/handoff";
import { offToolAlertOf } from "../plugin/server/off-tool-reviewer";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { OUTBOX_DIR_NAME, OUTBOX_SETTLED_MS, createOutbox } from "../plugin/server/outbox";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { clearProposedAnswers, proposedAnswersOf } from "../plugin/server/proposed-answers";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { checkBlocks } from "../plugin/shared/bm-format";
import { parseReports } from "../plugin/shared/bm-report";
import { toolFacesFor } from "../plugin/shared/bm-tools";
import type { Decision } from "../plugin/shared/decisions";
import { parseDelivery } from "../plugin/shared/notices";
import { originOf } from "../plugin/shared/message-origin";
import { msg, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The bound agents' delivering tools (design §16.6, §16.7; ADR-027 decisions
 * 4 and 9): bm_report, bm_questions, bm_review, bm_answers and bm_tell_worker
 * — bound and unbound, every refusal, and what each stores and sends.
 * Temporary data folders, the shared fake Paseo and a notice queue of the
 * test's own.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const OTHER_REQ = "req-20261003T110000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const REVIEWER = "agent-reviewer";
const T0 = new Date("2026-10-03T10:05:00.000Z");
const roots: string[] = [];

afterEach(() => {
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearProposedAnswers();
  clearMaterialiserMemory();
  clearStartMarks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-deliver-tools-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

const WORKER_CALLER: ToolCaller = { agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER, batchId: null, creationTools: true };
const REVIEWER_CALLER: ToolCaller = { agentId: REVIEWER, role: "reviewer", workspaceId: WS, requestId: REQ, parentId: WORKER, batchId: "b1", creationTools: true };
const MANAGER_CALLER: ToolCaller = { agentId: MANAGER, role: "manager", workspaceId: WS, requestId: null, parentId: null, batchId: null, creationTools: true };

type Agent = { id: string; provider: string; status: string; workspaceId: string; labels: Record<string, string> };
const AGENTS: Agent[] = [
  { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } },
  { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
  { id: REVIEWER, provider: "bm-reviewer/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1" } },
];

function setup(options: { home?: string | null; agents?: Agent[]; paseo?: boolean; turnStart?: string | null } = {}) {
  const home = options.home === undefined ? dataFolder() : options.home;
  const fake = fakePaseo({ agents: options.agents ?? AGENTS });
  const queue = createNoticeQueue({ log: () => {} });
  const logs: string[] = [];
  const opened: Decision[][] = [];
  const stopsAsked: Array<{ workerId: string; workspaceId: string }> = [];
  let clock = T0;
  let n = 0;
  const deps: DeliveringToolDeps = {
    paseo: () => (options.paseo === false ? null : fake.paseo),
    home: () => home,
    log: (line) => logs.push(line),
    now: () => clock,
    queue,
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    onOpened: (decisions) => {
      opened.push([...decisions]);
    },
    turnStartOf: () => (options.turnStart === undefined ? T0.toISOString() : options.turnStart),
    stopReviewers: async (_paseo, workerId, workspaceId) => {
      stopsAsked.push({ workerId, workspaceId });
    },
  };
  const tools = createDeliveringTools(deps);
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { home: home!, fake, queue, logs, opened, tools, tick, stopsAsked };
}

/** The request as bm_create_worker registers it: its Manager, its Worker. */
function register(home: string, requestId = REQ, managerId = MANAGER): void {
  createRequestRegistry(home, { backfill: () => [] }).register(WS, requestId, { source: "tool", managerId, workerId: WORKER });
}

const REPORT = { requestId: REQ, phase: "received", tier: { level: "Medium" }, buildAndTests: "not run" };

const QUESTION = (over: Record<string, unknown> = {}) => ({
  text: "Push both backends to origin/dev?",
  subject: "push-backends",
  class: "release",
  options: [
    { key: "a", text: "Push contract only", effects: ["push"], recommended: true },
    { key: "b", text: "Hold", effects: ["none"] },
  ],
  ...over,
});

const parsed = (answer: { ok: boolean; text: string }) => JSON.parse(answer.text) as Record<string, unknown>;
const call = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

// ---------------------------------------------------------------------------
// The lists (design §16.6).
// ---------------------------------------------------------------------------

describe("the bound lists (design §16.6)", () => {
  it("a bound Worker, Reviewer and Manager list their delivering tools; unbound agents keep today's lists", () => {
    expect(toolFacesFor("worker", true).map((face) => face.name)).toEqual(["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_reply"]);
    expect(toolFacesFor("reviewer", true).map((face) => face.name)).toEqual(["bm_review"]);
    expect(toolFacesFor("manager", true).map((face) => face.name)).toEqual(["bm_create_worker", "bm_tell_worker", "bm_answers", "bm_decisions"]);
    expect(toolFacesFor("worker").map((face) => face.name)).toEqual(["bm_report", "bm_reply"]);
    expect(toolFacesFor("reviewer").map((face) => face.name)).toEqual(["bm_review"]);
    expect(toolFacesFor("manager").map((face) => face.name)).toEqual(["bm_answers", "bm_decisions"]);
    // The bound bm_report takes no questions and waits with waitingOn / waitingFor.
    const bound = toolFacesFor("worker", true)[0]!.inputSchema.properties!;
    expect(Object.keys(bound)).not.toContain("questions");
    expect(Object.keys(bound)).toEqual(expect.arrayContaining(["waitingOn", "waitingFor"]));
    expect(toolFacesFor("worker")[0]!.inputSchema.properties!["phase"]!.enum).toContain("stopped");
  });

  it("the hook pre-approves exactly the bound list", () => {
    const empty: { toolPolicy?: { preapproved?: Array<{ tool: string }> } } = {};
    const tools = (role: "worker" | "reviewer" | "manager") => withAgentTools(empty, role, "http://127.0.0.1:1/mcp/x", true)?.toolPolicy?.preapproved?.map((grant) => grant.tool);
    expect(tools("worker")).toEqual(["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_reply"]);
    expect(tools("reviewer")).toEqual(["bm_review"]);
    expect(tools("manager")).toEqual(["bm_create_worker", "bm_tell_worker", "bm_answers", "bm_decisions"]);
    expect(answer("reviewer", { jsonrpc: "2.0", id: 1, method: "tools/list" }, true)).toMatchObject({ result: { tools: [{ name: "bm_review" }] } });
  });
});

// ---------------------------------------------------------------------------
// bm_report.
// ---------------------------------------------------------------------------

describe("bm_report for a bound Worker (design §16.6)", () => {
  it("builds, stores a report record, delivers it to its Manager with the marker line, and notes tier and finishedAt", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const result = await tools.worker.call("bm_report", { ...REPORT, filesChanged: ["src/a.ts"] }, WORKER_CALLER);
    expect(result.ok).toBe(true);
    expect(parsed(result)).toEqual({ recordId: "out-000000000001", delivery: "sent" });
    const [record] = createOutbox(home).list(WS);
    expect(record).toMatchObject({ kind: "report", requestId: REQ, from: WORKER, to: MANAGER, state: "delivered" });
    expect(checkBlocks(record!.text).flatMap((block) => block.issues)).toEqual([]);
    expect(fake.sends).toEqual([{ id: MANAGER, text: `BM-DELIVERY report ${record!.id}\n${record!.text}` }]);
    expect(originOf({ text: fake.sends[0]!.text, clientMessageId: "sdk" })).toBe("plugin-notice");
    expect(parseDelivery(fake.sends[0]!.text)?.kind).toBe("report");
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ tier: "Medium", finishedAt: null });
  });

  it("a stopped report stops the Worker's running Reviewers (design §7.9); finished does not", async () => {
    const { home, tools, stopsAsked } = setup();
    register(home);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(stopsAsked).toEqual([]);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "stopped" }, WORKER_CALLER)).ok).toBe(true);
    expect(stopsAsked).toEqual([{ workerId: WORKER, workspaceId: WS }]);
  });

  it("finished waits for every review call's verdict to reach the Worker; stopped and blocked never wait (acceptance finding F3)", async () => {
    const { home, fake, tools, tick } = setup();
    register(home);
    const at = (ms: number) => new Date(T0.getTime() + ms);
    const registry = createRequestRegistry(home);
    expect(registry.addReviewCall(WS, REQ, "b1", { callId: "call-1", kind: "create", reviewerId: REVIEWER, at: T0.toISOString() }, "Review src/a.ts")).toBe("added");
    tick(1_000);
    const finished = { ...REPORT, phase: "finished" };
    const waiting = { ok: false, text: "a review of batch b1 has no verdict yet: wait for its delivery, then report finished\nNothing was stored or sent." };
    expect(await tools.worker.call("bm_report", finished, WORKER_CALLER)).toEqual(waiting);
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
    expect(fake.sends).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ tier: null, finishedAt: null });
    for (const other of [{ ...REPORT, phase: "blocked", waitingFor: "the verdict of b1" }, { ...REPORT, phase: "stopped" }]) {
      expect((await tools.worker.call("bm_report", other, WORKER_CALLER)).ok, other.phase).toBe(true);
    }
    // A verdict stored but still on its way (the Worker is busy) has not reached it.
    const outbox = createOutbox(home, { now: () => at(2_000) });
    const verdict = outbox.add(WS, { kind: "review", requestId: REQ, batchId: "b1", from: REVIEWER, to: WORKER, text: "BM-REVIEW" });
    expect(await tools.worker.call("bm_report", finished, WORKER_CALLER)).toEqual(waiting);
    outbox.settle(WS, verdict.id, "delivered");
    expect((await tools.worker.call("bm_report", finished, WORKER_CALLER)).ok).toBe(true);
    // A re-review is a new call: the verdict before it does not answer it; a no-verdict delivery settles it.
    tick(10_000);
    expect(registry.addReviewCall(WS, REQ, "b1", { callId: "call-2", kind: "rereview", reviewerId: REVIEWER, at: at(11_000).toISOString() })).toBe("added");
    expect(registry.addReviewCall(WS, REQ, "b2", { callId: "call-3", kind: "create", reviewerId: "agent-reviewer-2", at: at(11_000).toISOString() }, "Review src/b.ts")).toBe("added");
    expect(await tools.worker.call("bm_report", finished, WORKER_CALLER)).toEqual({
      ok: false,
      text: "a review of batch b1 has no verdict yet: wait for its delivery, then report finished\na review of batch b2 has no verdict yet: wait for its delivery, then report finished\nNothing was stored or sent.",
    });
    const late = createOutbox(home, { now: () => at(12_000) });
    late.settle(WS, late.add(WS, { kind: "no-verdict", requestId: REQ, batchId: "b1", from: REVIEWER, to: WORKER, text: "no verdict" }).id, "delivered");
    late.settle(WS, late.add(WS, { kind: "review", requestId: REQ, batchId: "b2", from: "agent-reviewer-2", to: WORKER, text: "BM-REVIEW" }).id, "dropped", "gone");
    expect((await tools.worker.call("bm_report", finished, WORKER_CALLER)).ok).toBe(true);
  });

  it("batchesAwaitingVerdict: another request's or batch's record settles nothing; a call older than the outbox keeps settled records counts as settled", () => {
    const home = dataFolder();
    register(home);
    const registry = createRequestRegistry(home);
    registry.addReviewCall(WS, REQ, "b1", { callId: "call-1", kind: "create", reviewerId: REVIEWER, at: T0.toISOString() }, "Review");
    const outbox = createOutbox(home, { now: () => new Date(T0.getTime() + 1_000) });
    for (const init of [
      { requestId: OTHER_REQ, batchId: "b1" },
      { requestId: REQ, batchId: "b2" },
    ]) {
      outbox.settle(WS, outbox.add(WS, { kind: "review", ...init, from: REVIEWER, to: WORKER, text: "BM-REVIEW" }).id, "delivered");
    }
    const request = registry.get(WS, REQ);
    expect(batchesAwaitingVerdict(request, outbox.list(WS), T0)).toEqual(["b1"]);
    expect(batchesAwaitingVerdict(request, outbox.list(WS), new Date(T0.getTime() + OUTBOX_SETTLED_MS + 1))).toEqual([]);
    expect(batchesAwaitingVerdict(null, [], T0)).toEqual([]);
  });

  it("finished expires the request's earlier unsettled questions and records finishedAt; stopped expires nothing", async () => {
    const { home, tools, tick } = setup();
    register(home);
    const asked = await tools.worker.call("bm_questions", { questions: [QUESTION()] }, WORKER_CALLER);
    expect(asked.ok).toBe(true);
    tick(60_000);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "stopped" }, WORKER_CALLER)).ok).toBe(true);
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("open");
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ finishedAt: null });
    tick(60_000);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished", tier: { level: "Large", changedFrom: "Medium", reason: "two services" } }, WORKER_CALLER)).ok).toBe(true);
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("expired");
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ tier: "Large", finishedAt: new Date(T0.getTime() + 120_000).toISOString() });
  });

  it("blocked waits on open questions of its request (waitingOn) or on another request (waitingFor), written into blockers", async () => {
    const { home, tools } = setup();
    register(home);
    const [q1] = parsed(await tools.worker.call("bm_questions", { questions: [QUESTION()] }, WORKER_CALLER)) as unknown as Array<{ decisionId: string }>;
    const result = await tools.worker.call(
      "bm_report",
      { ...REPORT, phase: "blocked", waitingOn: [q1!.decisionId], waitingFor: "request req-20261003T090000Z (Worker agent-w2) to merge the schema", suggestions: ["add a CSV test"] },
      WORKER_CALLER,
    );
    expect(result.ok).toBe(true);
    const [record] = createOutbox(home).list(WS);
    expect(record!.text).toContain(
      "blockers: waiting on the owner: Q1. waiting for: request req-20261003T090000Z (Worker agent-w2) to merge the schema. Suggestion (not done): add a CSV test",
    );
    expect(record!.text).not.toContain("BM-QUESTIONS");
    // The format check and the card take it as a valid blocked report.
    expect(checkBlocks(record!.text).flatMap((block) => block.issues)).toEqual([]);
    const waitingForOnly = await tools.worker.call("bm_report", { ...REPORT, phase: "blocked", waitingFor: "request req-20261003T090000Z" }, WORKER_CALLER);
    expect(waitingForOnly.ok).toBe(true);
  });

  it("refuses blocked without waitingOn or waitingFor, a question that is not open or not its request's, waits outside blocked, and questions", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const refusals = [
      [{ ...REPORT, phase: "blocked" }, "input.waitingOn: a blocked report names what it waits on"],
      [{ ...REPORT, phase: "blocked", waitingOn: [`q:${REQ}:Q7`] }, `input.waitingOn: q:${REQ}:Q7 is not an open question of ${REQ}`],
      [{ ...REPORT, phase: "blocked", waitingOn: [`q:${OTHER_REQ}:Q1`] }, `input.waitingOn[0]: q:${OTHER_REQ}:Q1 is not a question of ${REQ}`],
      [{ ...REPORT, waitingFor: "x" }, "input.waitingFor: only a blocked report waits"],
      [{ ...REPORT, phase: "blocked", questions: [{ id: "Q1", text: "?", options: [{ text: "a", recommended: true }, { text: "b" }] }] }, "input.questions: is not a field of this tool"],
    ] as const;
    for (const [input, line] of refusals) {
      const result = await tools.worker.call("bm_report", input, WORKER_CALLER);
      expect(result.ok, line).toBe(false);
      expect(result.text).toMatch(/^The call was refused\. Fix these and call bm_report again:/);
      expect(result.text).toContain(line);
    }
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
    expect(fake.sends).toEqual([]);
  });

  it("refuses an input requestId other than the binding's, naming both, and stores and sends nothing", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const result = await tools.worker.call("bm_report", { ...REPORT, requestId: OTHER_REQ }, WORKER_CALLER);
    expect(result).toEqual({ ok: false, text: `requestId ${OTHER_REQ} is not yours: paseo-bm created you for request ${REQ}. Use ${REQ}. Nothing was stored or sent.` });
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
    expect(fake.sends).toEqual([]);
  });

  it("refuses a pending binding, no data folder, no Paseo handle, and a caller that is not bound", async () => {
    expect(await setup().tools.worker.call("bm_report", REPORT, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect(await setup({ home: null }).tools.worker.call("bm_report", REPORT, WORKER_CALLER)).toEqual({ ok: false, text: NO_DATA_FOLDER_MESSAGE });
    const offline = setup({ paseo: false });
    expect(await offline.tools.worker.call("bm_report", REPORT, WORKER_CALLER)).toEqual({ ok: false, text: NO_PASEO_DELIVERY_MESSAGE });
    expect(existsSync(join(offline.home, OUTBOX_DIR_NAME))).toBe(false);
    for (const caller of [null, { ...WORKER_CALLER, creationTools: undefined }, { ...WORKER_CALLER, role: "reviewer" as const }]) {
      expect(await setup().tools.worker.call("bm_report", REPORT, caller)).toEqual({ ok: false, text: DELIVERY_NOT_BOUND_MESSAGE });
    }
  });

  it("keeps a handoffNote on the record, where handoff.ts reads it", async () => {
    const { home, tools } = setup();
    register(home);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done", handoffNote: "Tried the cache; next, the CSV export." }, WORKER_CALLER)).ok).toBe(true);
    const [record] = createOutbox(home).list(WS);
    const reports = parseReports(record!.text, { agentId: WORKER, at: record!.createdAt }).map((report) => ({ ...report, recordId: record!.id }));
    expect(noteIn(turn({ agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQ, reports }), [], REQ)).toBe("Tried the cache; next, the CSV export.");
  });

  it("finished or stopped clears the request's delivery-dropped alert", async () => {
    const { home, tools } = setup();
    register(home);
    const alerts = createAlertStore(home);
    alerts.raise({ workspaceId: WS, kind: "delivery-dropped", subject: REQ, detail: "The report out-x was not delivered." });
    alerts.raise({ workspaceId: WS, kind: "delivery-dropped", subject: OTHER_REQ, detail: "The report out-y was not delivered." });
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "stopped" }, WORKER_CALLER)).ok).toBe(true);
    expect(createAlertStore(home).list({ open: true }).map((alert) => alert.subject)).toEqual([OTHER_REQ]);
  });

  it("finished or stopped clears the request's off-tool-reviewer alerts (design §16.8); received clears nothing", async () => {
    for (const phase of ["finished", "stopped"] as const) {
      const { home, tools } = setup();
      register(home);
      const alerts = createAlertStore(home);
      alerts.raise(offToolAlertOf({ reviewerId: "rev-1", workerId: WORKER, workspaceId: WS, requestId: REQ }));
      alerts.raise(offToolAlertOf({ reviewerId: "rev-2", workerId: "agent-other-worker", workspaceId: WS, requestId: OTHER_REQ }));
      expect((await tools.worker.call("bm_report", REPORT, WORKER_CALLER)).ok).toBe(true);
      expect(createAlertStore(home).list({ open: true }).map((alert) => alert.subject).sort()).toEqual(["rev-1", "rev-2"]);
      expect((await tools.worker.call("bm_report", { ...REPORT, phase }, WORKER_CALLER)).ok, phase).toBe(true);
      expect(createAlertStore(home).list({ open: true }).map((alert) => alert.subject), phase).toEqual(["rev-2"]);
    }
  });

  it("an unbound Worker still gets the builder and its send line, the phase stopped included", async () => {
    const { tools } = setup();
    const reply = await answerWithServerTools("worker", call("bm_report", { ...REPORT, phase: "stopped" }), tools.worker, null);
    const content = (reply as { result: { content: Array<{ text: string }> } }).result.content;
    expect(content[0]!.text).toMatch(/^BM-REPORT\nrequestId: req-20261003T100000Z\nphase: stopped\n/);
    expect(content[1]!.text).toBe(BUILDER_SEND_LINES["bm_report"]);
    // A Worker bound before ship point C is unbound for these tools too.
    const before = await answerWithServerTools("worker", call("bm_report", REPORT), tools.worker, { ...WORKER_CALLER, creationTools: undefined });
    expect((before as { result: { content: unknown[] } }).result.content).toHaveLength(2);
    // A bound one reaches the delivering tool.
    const bound = await answerWithServerTools("worker", call("bm_report", { ...REPORT, requestId: OTHER_REQ }), tools.worker, WORKER_CALLER);
    expect((bound as { result: { isError?: boolean } }).result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bm_questions.
// ---------------------------------------------------------------------------

describe("bm_questions for a bound Worker (design §16.6)", () => {
  it("opens each question through the shared open path, numbered after the request's highest Qn, asked by the caller", async () => {
    const { home, tools, opened } = setup();
    register(home);
    const store = createDecisionStore(home);
    // Q3 exists already (an earlier round).
    const first = parsed(await tools.worker.call("bm_questions", { questions: [QUESTION(), QUESTION({ text: "Which database?", subject: "test-db", class: "dependency" })] }, WORKER_CALLER));
    expect(first).toEqual([
      { qn: "Q1", decisionId: `q:${REQ}:Q1`, state: "open" },
      { qn: "Q2", decisionId: `q:${REQ}:Q2`, state: "open" },
    ]);
    const q1 = store.get(`q:${REQ}:Q1`, WS)!;
    expect(q1).toMatchObject({
      requestId: REQ,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: T0.toISOString(),
      round: 1,
      subject: "push-backends",
      class: "release",
      status: "open",
      options: [
        { key: "a", label: "Push contract only", recommended: true, effects: ["push"] },
        { key: "b", label: "Hold", recommended: false, effects: ["none"] },
      ],
      prediction: { recommended: { optionKey: "a" } },
    });
    // The delegation events see what opened (decision.opened, autonomy design §B.5).
    expect(opened.map((batch) => batch.map((decision) => decision.id))).toEqual([[`q:${REQ}:Q1`, `q:${REQ}:Q2`]]);
    // The next call goes on from Q2, in a new round, and supersedes by its tag.
    const next = parsed(await tools.worker.call("bm_questions", { questions: [QUESTION({ text: "Push only the contract now?", supersedes: "Q1" })] }, WORKER_CALLER)) as unknown as Array<{ qn: string }>;
    expect(next.map((entry) => entry.qn)).toEqual(["Q3"]);
    expect(store.get(`q:${REQ}:Q3`, WS)).toMatchObject({ round: 2, supersedes: `q:${REQ}:Q1` });
    expect(store.get(`q:${REQ}:Q1`, WS)?.status).toBe("superseded");
  });

  it("a question a precedent answers at once comes back answered, its delivery recorded as reaching the Worker", async () => {
    const { home, tools } = setup();
    register(home);
    createPrecedentStore(home).save({ scope: WS, subject: "push-backends", text: "Push contract only", sourceDecisionId: null, expiresInDays: 30 }, T0);
    const [result] = parsed(await tools.worker.call("bm_questions", { questions: [QUESTION()] }, WORKER_CALLER)) as unknown as Array<Record<string, unknown>>;
    expect(result).toEqual({ qn: "Q1", decisionId: `q:${REQ}:Q1`, state: "answered", answer: "a — Push contract only" });
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)).toMatchObject({ status: "answered", answer: { by: "precedent", optionKey: "a" }, delivery: { to: WORKER, outcome: "sent" } });
  });

  it("a review-budget question keeps its grants and is never answered by a precedent", async () => {
    const { home, tools } = setup();
    register(home);
    createPrecedentStore(home).save({ scope: WS, subject: "review-budget", text: "Two more calls", sourceDecisionId: null, expiresInDays: 30 }, T0);
    const question = QUESTION({
      text: "Review budget reached: allow more review calls?",
      subject: "review-budget",
      class: "cost",
      options: [
        { key: "a", text: "Two more calls", effects: ["none"], recommended: true, grant: { calls: 2 } },
        { key: "b", text: "Until batch b2 is clean", effects: ["none"], grant: { untilClean: "b2" } },
        { key: "c", text: "No more reviews", effects: ["none"] },
      ],
    });
    const [result] = parsed(await tools.worker.call("bm_questions", { questions: [question] }, WORKER_CALLER)) as unknown as Array<Record<string, unknown>>;
    expect(result).toMatchObject({ state: "open" });
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.options.map((option) => option.grant ?? null)).toEqual([{ calls: 2 }, { untilClean: "b2" }, null]);
  });

  it("refuses the whole call on any invalid question, opening nothing", async () => {
    const { home, tools } = setup();
    register(home);
    const cases: Array<[unknown, string]> = [
      [{ questions: [QUESTION(), QUESTION({ options: [{ key: "a", text: "x", effects: ["none"] }, { key: "b", text: "y", effects: ["none"] }] })] }, "input.questions[1].options: exactly one option is recommended (found 0)"],
      [{ questions: [QUESTION({ options: [{ key: "a", text: "x", effects: ["none"], recommended: true }, { key: "b", text: "y", effects: ["none"], recommended: true }] })] }, "exactly one option is recommended (found 2)"],
      [{ questions: [QUESTION({ options: [{ key: "a", text: "x", effects: ["none"], recommended: true, grant: { calls: 2 } }, { key: "b", text: "y", effects: ["none"] }] })] }, 'input.questions[0].options[0].grant: only a question of subject "review-budget" grants'],
      [{ questions: [QUESTION({ subject: "review-budget", options: [{ key: "a", text: "x", effects: ["none"], recommended: true, grant: { calls: 2, untilClean: "b1" } }, { key: "b", text: "y", effects: ["none"] }] })] }, "give exactly one of calls or untilClean"],
      // Acceptance finding F1: without a grant on any option, the owner's yes would grant nothing.
      [
        { questions: [QUESTION({ subject: "review-budget", class: "cost", options: [{ key: "a", text: "Two more calls", effects: ["none"], recommended: true }, { key: "b", text: "No", effects: ["none"] }] })] },
        'input.questions[0].options: a "review-budget" question gives at least one option a grant',
      ],
      [{ questions: [QUESTION({ options: [{ key: "b", text: "x", effects: ["none"], recommended: true }, { key: "c", text: "y", effects: ["none"] }] })] }, "input.questions[0].options[0].key: must be a"],
      [{ questions: [QUESTION({ supersedes: "Q9" })] }, `input.questions[0].supersedes: Q9 is not a question of ${REQ}`],
      [{ questions: [QUESTION({ class: undefined })] }, "input.questions[0].class: is required"],
      [{ questions: [] }, "input.questions: needs at least 1 item(s)"],
    ];
    for (const [input, line] of cases) {
      const result = await tools.worker.call("bm_questions", input, WORKER_CALLER);
      expect(result.ok, line).toBe(false);
      expect(result.text).toContain(line);
    }
    expect(createDecisionStore(home).list({ workspaceId: WS })).toEqual([]);
  });

  it("refuses an unbound or pending caller and a missing data folder", async () => {
    expect(await setup().tools.worker.call("bm_questions", { questions: [QUESTION()] }, null)).toEqual({ ok: false, text: QUESTIONS_NOT_BOUND_MESSAGE });
    expect(await setup().tools.worker.call("bm_questions", { questions: [QUESTION()] }, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect(await setup({ home: null }).tools.worker.call("bm_questions", { questions: [QUESTION()] }, WORKER_CALLER)).toEqual({ ok: false, text: NO_DATA_FOLDER_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// bm_review.
// ---------------------------------------------------------------------------

describe("bm_review for a bound Reviewer (design §16.6)", () => {
  const REVIEW = { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "src/a.ts; npm test pass", notChecked: "none" };

  it("stores a review record for its batch and delivers it to its Worker", async () => {
    const { home, fake, tools } = setup();
    const result = await tools.reviewer.call("bm_review", { ...REVIEW, findings: [{ severity: "blocking", location: "src/a.ts:3", reason: "Off by one.", suggestedFix: "Use <=." }] }, REVIEWER_CALLER);
    expect(parsed(result)).toEqual({ recordId: "out-000000000001", delivery: "sent" });
    const [record] = createOutbox(home).list(WS);
    expect(record).toMatchObject({ kind: "review", requestId: REQ, batchId: "b1", from: REVIEWER, to: WORKER, state: "delivered" });
    expect(record!.text).toContain("verdict: changes-required");
    expect(fake.sends.map((send) => send.id)).toEqual([WORKER]);
    expect(parseDelivery(fake.sends[0]!.text)?.kind).toBe("review");
  });

  it("refuses another request or batch than the binding's, naming both, and stores and sends nothing", async () => {
    const { home, fake, tools } = setup();
    expect((await tools.reviewer.call("bm_review", { ...REVIEW, requestId: OTHER_REQ }, REVIEWER_CALLER)).text).toBe(
      `requestId ${OTHER_REQ} is not yours: paseo-bm created you for request ${REQ}. Use ${REQ}. Nothing was stored or sent.`,
    );
    expect((await tools.reviewer.call("bm_review", { ...REVIEW, batchId: "b2" }, REVIEWER_CALLER)).text).toBe("batchId b2 is not yours: paseo-bm created you for batch b1. Use b1. Nothing was stored or sent.");
    expect((await tools.reviewer.call("bm_review", { ...REVIEW, checked: "" }, REVIEWER_CALLER)).text).toContain("input.checked: must not be empty");
    expect(await tools.reviewer.call("bm_review", REVIEW, { ...REVIEWER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
    expect(fake.sends).toEqual([]);
    expect(await setup({ home: null }).tools.reviewer.call("bm_review", REVIEW, REVIEWER_CALLER)).toEqual({ ok: false, text: NO_DATA_FOLDER_MESSAGE });
  });

  it("an unbound Reviewer still gets the builder and its send line", async () => {
    const { tools } = setup();
    const reply = await answerWithServerTools("reviewer", call("bm_review", REVIEW), tools.reviewer, null);
    const content = (reply as { result: { content: Array<{ text: string }> } }).result.content;
    expect(content[0]!.text).toMatch(/^BM-REVIEW\n/);
    expect(content[1]!.text).toBe(BUILDER_SEND_LINES["bm_review"]);
  });
});

// ---------------------------------------------------------------------------
// bm_answers.
// ---------------------------------------------------------------------------

describe("bm_answers for a bound Manager: proposed, settled only with the owner's own message (design §16.6)", () => {
  const START = T0.toISOString();
  const managerTurn = (sent: ReturnType<typeof msg>[]) =>
    turn({ agentId: MANAGER, role: "manager", workspaceId: WS, startedAt: START, endedAt: new Date(T0.getTime() + 60_000).toISOString(), sent });
  const ANSWERS = { requestId: REQ, answers: [{ id: "Q1", option: "a", optionText: "Push contract only" }] };

  async function asked() {
    const context = setup();
    register(context.home);
    await context.tools.worker.call("bm_questions", { questions: [QUESTION(), QUESTION({ text: "Which database?", subject: "test-db" })] }, WORKER_CALLER);
    return context;
  }
  const materialise = (home: string, record: ReturnType<typeof managerTurn>, settled: Decision[][] = []) =>
    materialiseTurn(record, { home, paseo: {}, now: () => T0, log: () => {}, onSettled: (decisions) => void settled.push([...decisions]), workerOf: async () => WORKER });

  it("records the answers as proposed for the Manager's turn, and settles them at its end when the turn holds the owner's message", async () => {
    const { home, tools } = await asked();
    const result = await tools.manager.call("bm_answers", { requestId: REQ, answers: [ANSWERS.answers[0], { id: "Q2", other: "SQLite, as in CI" }] }, MANAGER_CALLER);
    expect(parsed(result)).toEqual({ proposed: ["Q1", "Q2"] });
    expect(proposedAnswersOf(MANAGER, START)).toHaveLength(1);
    // Nothing is settled during the turn.
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("open");
    const settled: Decision[][] = [];
    await materialise(home, managerTurn([msg(MANAGER, new Date(T0.getTime() + 10_000).toISOString(), "a for Q1, SQLite for Q2", "user")]), settled);
    const store = createDecisionStore(home);
    expect(store.get(`q:${REQ}:Q1`, WS)).toMatchObject({ status: "answered", answer: { by: "owner", via: "chat-manager", optionKey: "a" } });
    expect(store.get(`q:${REQ}:Q2`, WS)).toMatchObject({ status: "answered", answer: { via: "chat-manager", words: "SQLite, as in CI" } });
    expect(settled.flat().map((decision) => decision.id)).toEqual([`q:${REQ}:Q1`, `q:${REQ}:Q2`]);
    expect(proposedAnswersOf(MANAGER, START)).toEqual([]);
  });

  it("never settles without the owner's typed message in the same turn: a relayed agent message or a plugin notice does not count", async () => {
    const { home, tools } = await asked();
    expect((await tools.manager.call("bm_answers", ANSWERS, MANAGER_CALLER)).ok).toBe(true);
    const relayed = msg(MANAGER, new Date(T0.getTime() + 10_000).toISOString(), "Q1: a", "agent");
    const notice = msg(MANAGER, new Date(T0.getTime() + 20_000).toISOString(), `BM-DELIVERY report out-000000000009\nBM-REPORT\nrequestId: ${REQ}`, "agent");
    await materialise(home, managerTurn([relayed, notice]));
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("open");
    // The proposal is gone: a later turn with the owner's message does not settle it either.
    await materialise(home, { ...managerTurn([msg(MANAGER, new Date(T0.getTime() + 90_000).toISOString(), "hello", "user")]), startedAt: new Date(T0.getTime() + 80_000).toISOString() });
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("open");
  });

  it("a reload during the turn loses the proposals", async () => {
    const { home, tools } = await asked();
    expect((await tools.manager.call("bm_answers", ANSWERS, MANAGER_CALLER)).ok).toBe(true);
    clearProposedAnswers();
    await materialise(home, managerTurn([msg(MANAGER, new Date(T0.getTime() + 10_000).toISOString(), "a", "user")]));
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("open");
  });

  it("refuses a Qn that is not open, a request of another Manager or none, a turn it cannot tie them to, and records nothing", async () => {
    const { home, tools } = await asked();
    register(home, OTHER_REQ, "agent-other-manager");
    const cases: Array<[unknown, string]> = [
      [{ requestId: REQ, answers: [{ id: "Q9", option: "a", optionText: "x" }] }, `Q9 is not an open question of ${REQ}`],
      [{ requestId: REQ, answers: [{ id: "Q1", option: "c", optionText: "x" }] }, "input.answers[0].option: Q1 has no option c"],
      [{ requestId: OTHER_REQ, answers: [{ id: "Q1", option: "a", optionText: "x" }] }, `request ${OTHER_REQ} is not one of yours`],
      [{ requestId: "req-20261003T120000Z", answers: [{ id: "Q1", option: "a", optionText: "x" }] }, "paseo-bm knows no request req-20261003T120000Z"],
    ];
    for (const [input, line] of cases) {
      const result = await tools.manager.call("bm_answers", input, MANAGER_CALLER);
      expect(result.ok, line).toBe(false);
      expect(result.text).toContain(line);
    }
    const noStart = setup({ home, turnStart: null });
    expect((await noStart.tools.manager.call("bm_answers", ANSWERS, MANAGER_CALLER)).text).toMatch(/cannot tie these answers to your current turn/);
    expect(proposedAnswersOf(MANAGER, START)).toEqual([]);
  });

  it("an unbound Manager still gets the builder and its send line", async () => {
    const { tools } = setup();
    const reply = await answerWithServerTools("manager", call("bm_answers", ANSWERS), tools.manager, null);
    const content = (reply as { result: { content: Array<{ text: string }> } }).result.content;
    expect(content[0]!.text).toBe(`BM-ANSWERS\nrequestId: ${REQ}\nQ1: a — Push contract only`);
    expect(content[1]!.text).toBe(BUILDER_SEND_LINES["bm_answers"]);
  });

  it("the turn start comes from the collector's start mark", () => {
    noteTurnStart({ agent: { id: MANAGER, provider: "bm-manager/claude-opus-5" }, turnId: "t-1" } as never, () => T0);
    expect(currentTurnStartOf(MANAGER)).toBe(T0.toISOString());
    expect(currentTurnStartOf(WORKER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bm_tell_worker.
// ---------------------------------------------------------------------------

describe("bm_tell_worker for a bound Manager (design §16.6)", () => {
  const TELL = { requestId: REQ, text: "Use dd/mm/yyyy.\nEverywhere.", source: "owner message, 10:04" };

  it("delivers the marker line, Continue <requestId>., the text and source to the request's sole live Worker", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const result = await tools.manager.call("bm_tell_worker", TELL, MANAGER_CALLER);
    expect(parsed(result)).toEqual({ workerId: WORKER, delivery: "sent" });
    const [record] = createOutbox(home).list(WS);
    expect(record).toMatchObject({ kind: "message", requestId: REQ, from: MANAGER, to: WORKER, state: "delivered" });
    expect(fake.sends).toEqual([
      { id: WORKER, text: [`BM-DELIVERY message ${record!.id}`, `Continue ${REQ}.`, "Use dd/mm/yyyy.", "Everywhere.", "source: owner message, 10:04"].join("\n") },
    ]);
    // Without a source, no source line (the Worker idle again).
    fake.byId(WORKER)!.status = "idle";
    await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "Go on." }, MANAGER_CALLER);
    expect(fake.sends[1]!.text.split("\n").slice(1)).toEqual([`Continue ${REQ}.`, "Go on."]);
  });

  it("a replaced Worker resolves to its successor", async () => {
    const successor: Agent = { id: "agent-worker-2", provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "bm.handoffFrom": WORKER } };
    const replaced: Agent = { ...AGENTS[1]!, labels: { ...AGENTS[1]!.labels, "bm.replacedBy": successor.id } };
    const { home, fake, tools } = setup({ agents: [AGENTS[0]!, replaced, successor] });
    register(home);
    expect(parsed(await tools.manager.call("bm_tell_worker", TELL, MANAGER_CALLER))).toEqual({ workerId: successor.id, delivery: "sent" });
    expect(fake.sends.map((send) => send.id)).toEqual([successor.id]);
  });

  it("refuses an unknown request, another Manager's, no live Worker, and an unbound caller, sending nothing", async () => {
    const { home, fake, tools } = setup({ agents: [AGENTS[0]!] });
    register(home);
    register(home, OTHER_REQ, "agent-other-manager");
    expect((await tools.manager.call("bm_tell_worker", { ...TELL, requestId: "req-20261003T120000Z" }, MANAGER_CALLER)).text).toBe(
      "paseo-bm knows no request req-20261003T120000Z in this workspace; use the requestId bm_create_worker gave you. Nothing was sent.",
    );
    expect((await tools.manager.call("bm_tell_worker", { ...TELL, requestId: OTHER_REQ }, MANAGER_CALLER)).text).toBe(
      `request ${OTHER_REQ} is not one of yours: another Manager created its Worker. Nothing was sent.`,
    );
    expect((await tools.manager.call("bm_tell_worker", TELL, MANAGER_CALLER)).text).toBe(`request ${REQ} has no single live Worker to tell; tell the owner in one line. Nothing was sent.`);
    expect((await tools.manager.call("bm_tell_worker", { ...TELL, text: "x".repeat(8_001) }, MANAGER_CALLER)).text).toContain("input.text: must be at most 8000 characters");
    expect(await tools.manager.call("bm_tell_worker", TELL, null)).toEqual({ ok: false, text: TELL_NOT_BOUND_MESSAGE });
    expect(await tools.manager.call("bm_tell_worker", TELL, { ...MANAGER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect(fake.sends).toEqual([]);
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
  });

  it("relayRequestIdOf still finds the request: in the Manager's bm_tell_worker call, and the delivery keeps Continue <requestId>.", () => {
    for (const name of ["mcp__paseo-bm__bm_tell_worker", "paseo-bm.bm_tell_worker", "bm_tell_worker"]) {
      expect(relayRequestIdOf({ type: "tool_call", name, detail: { input: { requestId: REQ, text: "x" } } } as never)).toBe(REQ);
    }
    expect(relayRequestIdOf({ type: "tool_call", name: "mcp__paseo-bm__bm_tell_worker", detail: { input: { requestId: "nope" } } } as never)).toBeNull();
    expect(relayRequestIdOf({ type: "tool_call", name: "mcp__paseo__send_agent_prompt", detail: { input: { prompt: `Continue ${REQ}.\nGo on.` } } } as never)).toBe(REQ);
  });
});
