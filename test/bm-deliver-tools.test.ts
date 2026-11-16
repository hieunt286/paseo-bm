import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING_CALLER_MESSAGE, PENDING_TTL_MS, createBindingStore } from "../plugin/server/agent-bindings";
import { BUILDER_SEND_LINES, answer, answerWithServerTools, withAgentTools } from "../plugin/server/agent-tools";
import { createAlertStore } from "../plugin/server/alert-store";
import { clearStartMarks, currentTurnStartOf, noteTurnStart, relayRequestIdOf } from "../plugin/server/collector";
import { clearMaterialiserMemory, materialiseTurn } from "../plugin/server/decision-materialiser";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import {
  DELIVERY_NOT_BOUND_MESSAGE,
  NO_PASEO_DELIVERY_MESSAGE,
  QUESTIONS_NOT_BOUND_MESSAGE,
  TELL_NOT_BOUND_MESSAGE,
  batchesAwaitingVerdict,
  createDeliveringTools,
  type DeliveringToolDeps,
  newWorkRefusalOf,
} from "../plugin/server/deliver-tools";
import { noteIn, peerBlockOf } from "../plugin/server/handoff";
import { CUT_NOTE_LINE, clearSeenTurns, createInterruptionWatch } from "../plugin/server/interruption-watch";
import { applyLine, heldRequestsOf, proposeLine, startHeldRequests } from "../plugin/server/held-requests";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { createMissionRoster, noteRosterReport } from "../plugin/server/mission-roster";
import { createMissionStore, type Placement } from "../plugin/server/mission-store";
import { PEER_RULES, createPeerLinkStore } from "../plugin/server/peer-links";
import { peerReplyText } from "../plugin/server/peer-tools";
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
import { fakePaseo, type FakeTimeline } from "./helpers/fake-paseo";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { MANAGER_CALLER, REVIEWER_CALLER, WORKER_CALLER, bindAgent } from "./helpers/bindings";
import type { TraceRecord } from "../plugin/shared/contracts";
import { mergeGit } from "../plugin/server/lane-merge";
import type { GitRunner } from "../plugin/server/repo-tool";
import type * as MissionRosterModule from "../plugin/server/mission-roster";
import type * as RequestRegistryModule from "../plugin/server/request-registry";

/**
 * The bound agents' delivering tools (design §16.6, §16.7; ADR-027 decisions
 * 4 and 9): bm_report, bm_questions, bm_review, bm_answers and bm_tell_worker
 * — bound and unbound, every refusal, and what each stores and sends.
 * Temporary data folders, the shared fake Paseo and a notice queue of the
 * test's own.
 */

const gateWatch = vi.hoisted(() => ({ roster: null as null | ((requestId: string, phase: string) => void), failNote: false }));
vi.mock("../plugin/server/mission-roster", async (importOriginal) => {
  const actual = await importOriginal<typeof MissionRosterModule>();
  return {
    ...actual,
    noteRosterReport: (...args: Parameters<typeof actual.noteRosterReport>) => {
      gateWatch.roster?.(args[1], args[2]);
      return actual.noteRosterReport(...args);
    },
  };
});
vi.mock("../plugin/server/request-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof RequestRegistryModule>();
  return {
    ...actual,
    createRequestRegistry: (...args: Parameters<typeof actual.createRequestRegistry>) => {
      const registry = actual.createRequestRegistry(...args);
      return gateWatch.failNote ? { ...registry, noteFinishGate: () => { throw new Error("disk full"); } } : registry;
    },
  };
});

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const OTHER_REQ = "req-20261003T110000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const REVIEWER = "agent-reviewer";
const T0 = new Date("2026-10-03T10:05:00.000Z");

afterEach(() => {
  gateWatch.roster = null;
  gateWatch.failNote = false;
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearProposedAnswers();
  clearMaterialiserMemory();
  clearStartMarks();
  clearJsonFileCache();
  clearSeenTurns();
  removeDataFolders();
});


type Agent = { id: string; provider: string; status: string; workspaceId: string; labels: Record<string, string> };
const AGENTS: Agent[] = [
  { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } },
  { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
  { id: REVIEWER, provider: "bm-reviewer/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1" } },
];

function setup(options: { home?: string; agents?: Agent[]; paseo?: boolean; turnStart?: string | null; timelines?: Record<string, FakeTimeline>; config?: Record<string, unknown>; git?: GitRunner } = {}) {
  const home = options.home ?? dataFolder();
  const fake = fakePaseo({ agents: options.agents ?? AGENTS, ...(options.timelines === undefined ? {} : { timelines: options.timelines }), ...(options.config === undefined ? {} : { config: options.config }) });
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
    ...(options.git === undefined ? {} : { git: options.git }),
  };
  const tools = createDeliveringTools(deps);
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { home, fake, queue, logs, opened, tools, tick, stopsAsked };
}

/** The request as bm_create_worker registers it: its Manager, its Worker. */
function register(home: string, requestId = REQ, managerId = MANAGER): void {
  createRequestRegistry(home, { backfill: () => [] }).register(WS, requestId, { source: "tool", managerId, workerId: WORKER });
}

const REPORT = { requestId: REQ, phase: "received", tier: { level: "Medium" }, buildAndTests: "not run" };
const PROOF = { kind: "ran", what: "opened the invoices page", showed: "it lists the invoices" };
/** What a Medium or Large `received` outside a step restates (ADR-045 decision 7). */
const RESTATED = { goal: "The invoices page lists every invoice.", acceptance: ["The page lists the invoices", "An empty list reads as empty"] };
const restatedAt = (phase: string) => (phase === "received" ? RESTATED : {});

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
    expect(toolFacesFor("worker", true).map((face) => face.name)).toEqual(["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_peers", "bm_ask_project", "bm_peer_reply", "bm_memory", "bm_reply"]);
    expect(toolFacesFor("reviewer", true).map((face) => face.name)).toEqual(["bm_review"]);
    expect(toolFacesFor("manager", true).map((face) => face.name)).toEqual(["bm_create_worker", "bm_tell_worker", "bm_answers", "bm_peers", "bm_peer_reply", "bm_mission", "bm_mission_start", "bm_mission_update", "bm_answer_worker", "bm_answer_fallback", "bm_hold_cancel", "bm_hold_release", "bm_split_mission", "bm_owner_question", "bm_memory", "bm_repo", "bm_link_workers", "bm_ask_mission", "bm_decisions"]);
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
    expect(tools("worker")).toEqual(["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_peers", "bm_ask_project", "bm_peer_reply", "bm_memory", "bm_reply"]);
    expect(tools("reviewer")).toEqual(["bm_review"]);
    expect(tools("manager")).toEqual(["bm_create_worker", "bm_tell_worker", "bm_answers", "bm_peers", "bm_peer_reply", "bm_mission", "bm_mission_start", "bm_mission_update", "bm_answer_worker", "bm_answer_fallback", "bm_hold_cancel", "bm_hold_release", "bm_split_mission", "bm_owner_question", "bm_memory", "bm_repo", "bm_link_workers", "bm_ask_mission", "bm_decisions"]);
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
    const result = await tools.worker.call("bm_report", { ...REPORT, ...RESTATED, filesChanged: ["src/a.ts"] }, WORKER_CALLER);
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
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "stopped" }, WORKER_CALLER)).ok).toBe(true);
    expect(stopsAsked).toEqual([{ workerId: WORKER, workspaceId: WS }]);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(stopsAsked).toHaveLength(1);
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
    expect(batchesAwaitingVerdict(createRequestRegistry(home).get(WS, REQ), createOutbox(home).list(WS), at(2_000))).toEqual([]);
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

  it("finished is not held by a create call whose Reviewer never appeared once the pending time is over (K2)", async () => {
    const { home, tools, tick } = setup();
    register(home);
    // Paseo failed the creation after the hook kept the token: the call stays empty, no Reviewer comes.
    expect(createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "call-1", kind: "create", reviewerId: "", at: T0.toISOString() }, "Review src/a.ts")).toBe("added");
    const finished = { ...REPORT, phase: "finished" };
    tick(1_000);
    expect(await tools.worker.call("bm_report", finished, WORKER_CALLER)).toEqual({
      ok: false,
      text: "a review of batch b1 has no verdict yet: wait for its delivery, then report finished\nNothing was stored or sent.",
    });
    tick(PENDING_TTL_MS);
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

  it("an adopted batch's inherited calls wait for no verdict, down a chain of continuations; a re-review of its own does (ADR-045 decision 10)", () => {
    const home = dataFolder();
    register(home);
    const registry = createRequestRegistry(home);
    const inherited = { batchId: "b1", reviewerIds: [REVIEWER], brief: "Review", results: [{ at: T0.toISOString(), recordId: "out-old", verdict: "changes-required", blocking: 2 }], calls: [{ callId: "call-1", kind: "create" as const, reviewerId: REVIEWER, at: new Date(T0.getTime() - 1_000).toISOString() }] };
    // Copied from a request that had copied it too: the verdict's record names neither this request nor adoptedFrom.
    expect(registry.adoptReviewBatches(WS, REQ, [inherited], OTHER_REQ)).toBe(1);
    expect(batchesAwaitingVerdict(registry.get(WS, REQ), [], T0)).toEqual([]);
    // A batch id it holds already is left as it is: the copy counts for nothing.
    expect(registry.adoptReviewBatches(WS, REQ, [{ ...inherited, brief: "Other" }], OTHER_REQ)).toBe(0);
    expect(registry.get(WS, REQ)!.reviews.batches[0]!.brief).toBe("Review");

    const rereview = new Date(T0.getTime() + 1_000);
    expect(registry.addReviewCall(WS, REQ, "b1", { callId: "call-2", kind: "rereview", reviewerId: REVIEWER, at: rereview.toISOString() })).toBe("added");
    const outbox = createOutbox(home, { now: () => new Date(rereview.getTime() + 1_000) });
    expect(batchesAwaitingVerdict(registry.get(WS, REQ), outbox.list(WS), rereview)).toEqual(["b1"]);
    outbox.settle(WS, outbox.add(WS, { kind: "review", requestId: REQ, batchId: "b1", from: REVIEWER, to: WORKER, text: "BM-REVIEW" }).id, "delivered");
    expect(batchesAwaitingVerdict(registry.get(WS, REQ), outbox.list(WS), rereview)).toEqual([]);
  });

  it("the continuation's finished is not refused for a batch it adopted (ADR-045 decision 10)", async () => {
    const { home, tools } = setup();
    register(home);
    createRequestRegistry(home).adoptReviewBatches(
      WS,
      REQ,
      [{ batchId: "b1", reviewerIds: [REVIEWER], brief: "Review", results: [{ at: T0.toISOString(), recordId: "out-old", verdict: "changes-required", blocking: 2 }], calls: [{ callId: "call-1", kind: "create", reviewerId: REVIEWER, at: T0.toISOString() }] }],
      OTHER_REQ,
    );
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
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

  it("refuses a pending binding, no Paseo handle, and a caller that is not bound", async () => {
    expect(await setup().tools.worker.call("bm_report", REPORT, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    const offline = setup({ paseo: false });
    expect(await offline.tools.worker.call("bm_report", REPORT, WORKER_CALLER)).toEqual({ ok: false, text: NO_PASEO_DELIVERY_MESSAGE });
    expect(existsSync(join(offline.home, OUTBOX_DIR_NAME))).toBe(false);
    for (const caller of [null, { ...WORKER_CALLER, role: "reviewer" as const }]) {
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

  it("beads-done starts no Main turn (ADR-045 decision 14): stored as a note, never enqueued, answering delivery no-turn; the registry and roster record it", async () => {
    const { home, fake, queue, tools } = setup();
    // A hand-path request: its roster entry follows every report, so the entry below shows the report reached it.
    createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "agent-typed", managerId: MANAGER, workerId: WORKER });
    const MID = "mis-0123456789";
    const made = createMissionStore(home, { newId: () => MID, env: {} }).create({ code: "PAS", name: "Site", goal: "g", repos: [WS], createdBy: "owner", mainId: MANAGER });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    createMissionRoster(home, { env: {} }).add(MID, { requestId: REQ, workspaceId: WS, topic: "work", workerId: WORKER });
    noteRosterReport(home, REQ, "stopped");

    const result = await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done", tier: { level: "Large" } }, WORKER_CALLER);
    expect(parsed(result)).toEqual({ recordId: "out-000000000001", delivery: "no-turn" });
    expect(fake.sends).toEqual([]);
    expect(queue.pending(MANAGER)).toEqual([]);
    expect(createOutbox(home).list(WS)).toMatchObject([{ kind: "report", to: MANAGER, state: "delivered", reason: "no-turn" }]);
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ tier: "Large", finishedAt: null });
    expect(createMissionRoster(home, { env: {} }).list(MID).find((entry) => entry.requestId === REQ)?.state).toBe("active");

    // The Main reads it at the head of its next delivery.
    expect(parsed(await tools.worker.call("bm_report", { ...REPORT, phase: "blocked", waitingFor: "the schema" }, WORKER_CALLER))).toMatchObject({ delivery: "sent" });
    expect(fake.sends[0]!.text.split("\n")[1]).toMatch(/^noted: report out-000000000001 from agent-worker: /);
  });

  it("beads-done is addressed to the mission's current Main when the Worker's creator was replaced", async () => {
    const { home, fake, tools } = setup({ agents: [...AGENTS, { id: "main-now", provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } }] });
    register(home);
    const MID = "mis-0123456789";
    const missions = createMissionStore(home, { newId: () => MID, env: {} });
    const made = missions.create({ code: "PAS", name: "Site", goal: "g", repos: [WS], createdBy: "owner", mainId: MANAGER });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    createMissionRoster(home, { env: {} }).add(MID, { requestId: REQ, workspaceId: WS, topic: "work", workerId: WORKER });
    missions.setMain(MID, "main-now", "replaced");
    expect(parsed(await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done" }, WORKER_CALLER))).toMatchObject({ delivery: "no-turn" });
    expect(createOutbox(home).list(WS)[0]).toMatchObject({ to: "main-now", reason: "no-turn" });
    expect(fake.sends).toEqual([]);
  });

  it.each(["received", "blocked", "finished", "stopped"])("a %s report is delivered as before", async (phase) => {
    const { home, fake, tools } = setup();
    register(home);
    const result = await tools.worker.call("bm_report", { ...REPORT, ...restatedAt(phase), phase, ...(phase === "blocked" ? { waitingFor: "the schema" } : {}) }, WORKER_CALLER);
    expect(parsed(result)).toMatchObject({ delivery: "sent" });
    expect(createOutbox(home).list(WS)[0]).toMatchObject({ state: "delivered", reason: null });
    expect(fake.sends.map((send) => send.id)).toEqual([MANAGER]);
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
      expect((await tools.worker.call("bm_report", { ...REPORT, ...RESTATED }, WORKER_CALLER)).ok).toBe(true);
      expect(createAlertStore(home).list({ open: true }).map((alert) => alert.subject).sort()).toEqual(["rev-1", "rev-2"]);
      expect((await tools.worker.call("bm_report", { ...REPORT, ...restatedAt(phase), phase }, WORKER_CALLER)).ok, phase).toBe(true);
      expect(createAlertStore(home).list({ open: true }).map((alert) => alert.subject), phase).toEqual(["rev-2"]);
    }
  });

  it("a mission request's roster state follows its reports, and a finished bound request is final: a later report is refused (delivery line design §2.3)", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const roster = createMissionRoster(home);
    roster.add("mis-0123456789", { requestId: REQ, workspaceId: WS, topic: "Export", workerId: WORKER });
    const state = () => createMissionRoster(home).get("mis-0123456789", REQ)?.state;
    expect((await tools.worker.call("bm_report", { ...REPORT, ...RESTATED }, WORKER_CALLER)).ok).toBe(true);
    expect(state()).toBe("active");
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(state()).toBe("finished");
    const finishedAt = createRequestRegistry(home).get(WS, REQ)!.finishedAt;
    expect(finishedAt).toBe(T0.toISOString());
    const records = createOutbox(home).list(WS).length;
    const sends = fake.sends.length;
    for (const phase of ["received", "blocked", "finished", "stopped"]) {
      const late = await tools.worker.call("bm_report", { ...REPORT, ...restatedAt(phase), phase, ...(phase === "blocked" ? { waitingFor: "x" } : {}) }, WORKER_CALLER);
      expect(late, phase).toEqual({ ok: false, text: `Request ${REQ} is finished; ask your Main. Nothing was stored or sent.` });
    }
    expect(state()).toBe("finished");
    expect(createRequestRegistry(home).get(WS, REQ)!.finishedAt).toBe(finishedAt);
    expect(createOutbox(home).list(WS)).toHaveLength(records);
    expect(fake.sends).toHaveLength(sends);
  });

  it("a later report on a finished bound request names the request its work goes on as (delivery line design §2.3)", async () => {
    const { home, tools } = setup();
    register(home);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    // A continuation (WP-7.2) sets continuedBy on the predecessor.
    const file = join(home, "requests", `${WS}.json`);
    const body = JSON.parse(readFileSync(file, "utf8")) as { requests: Array<Record<string, unknown>> };
    body.requests[0]!["continuedBy"] = OTHER_REQ;
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    clearRequestRegistryCache();
    expect(await tools.worker.call("bm_report", REPORT, WORKER_CALLER)).toEqual({ ok: false, text: `Request ${REQ} is finished; its work goes on as ${OTHER_REQ}. Nothing was stored or sent.` });
  });

  it("the hand path keeps today's reopening: a request registered agent-typed is active again after finished, and its finishedAt cleared", async () => {
    const { home, tools } = setup();
    createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "agent-typed", managerId: MANAGER, workerId: WORKER });
    createMissionRoster(home).add("mis-0123456789", { requestId: REQ, workspaceId: WS, topic: "Export", workerId: WORKER });
    const state = () => createMissionRoster(home).get("mis-0123456789", REQ)?.state;
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(state()).toBe("finished");
    expect((await tools.worker.call("bm_report", { ...REPORT, ...RESTATED }, WORKER_CALLER)).ok).toBe(true);
    expect(state()).toBe("active");
    expect(createRequestRegistry(home).get(WS, REQ)!.finishedAt).toBeNull();
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "stopped" }, WORKER_CALLER)).ok).toBe(true);
    expect(state()).toBe("stopped");
  });

  it("a request of no mission: a finished report writes no roster", async () => {
    const { home, tools } = setup();
    register(home);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(existsSync(join(home, "missions"))).toBe(false);
  });

  it("an unbound Worker still gets the builder and its send line, the phase stopped included", async () => {
    const { tools } = setup();
    const reply = await answerWithServerTools("worker", call("bm_report", { ...REPORT, phase: "stopped" }), tools.worker, null);
    const content = (reply as { result: { content: Array<{ text: string }> } }).result.content;
    expect(content[0]!.text).toMatch(/^BM-REPORT\nrequestId: req-20261003T100000Z\nphase: stopped\n/);
    expect(content[1]!.text).toBe(BUILDER_SEND_LINES["bm_report"]);
    // A bound one reaches the delivering tool.
    const bound = await answerWithServerTools("worker", call("bm_report", { ...REPORT, requestId: OTHER_REQ }), tools.worker, WORKER_CALLER);
    expect((bound as { result: { isError?: boolean } }).result.isError).toBe(true);
  });
});

describe("bm_report in a mission's placement (delivery line design §4.4, §4.6)", () => {
  const BRANCH = "m/ABC/fe";
  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const gitIn = (repo: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
      cwd: repo,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: "pipe",
      encoding: "utf8",
    }).trim();

  /** A worktree on the mission branch with one commit, and WS as that mission's placement of it. Returns the commit's sha. */
  function placed(home: string): { repo: string; sha: string } {
    const repo = join(home, "..", "repo");
    mkdirSync(repo);
    gitIn(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.ts"), "a\n");
    gitIn(repo, "add", "a.ts");
    gitIn(repo, "commit", "-q", "-m", "a");
    gitIn(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    gitIn(repo, "checkout", "-q", "-b", BRANCH);
    writeFileSync(join(repo, "b.ts"), "b\n");
    gitIn(repo, "add", "b.ts");
    gitIn(repo, "commit", "-q", "-m", "b");
    const placement: Placement = {
      repo: "wks_repo",
      workspaceId: WS,
      directory: repo,
      branch: BRANCH,
      target: "main",
      base: "origin/main",
      worktreeSlug: "m-abc-fe",
      state: "ready",
      requestKey: "bm-place-x",
      createdAt: T0.toISOString(),
      deps: { cloned: [], at: null, note: null },
      integration: null,
    };
    const store = createMissionStore(home, { now: () => T0 });
    const made = store.create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: ["wks_repo"], createdBy: "owner", mainId: MANAGER });
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    const updated = store.update(made.mission.missionId, (mission) => ({ ...mission, placements: [placement] }));
    if (!updated.ok) throw new Error(updated.reasons.join("\n"));
    return { repo, sha: gitIn(repo, "rev-parse", "HEAD") };
  }
  const FINISHED = { ...REPORT, phase: "finished", filesChanged: ["b.ts"], runtimeProof: PROOF };

  it.skipIf(!hasGit)("finished with changed files and no commit is refused, naming the branch; nothing is stored or sent", async () => {
    const { home, fake, tools } = setup();
    register(home);
    placed(home);
    expect(await tools.worker.call("bm_report", FINISHED, WORKER_CALLER)).toEqual({
      ok: false,
      text: `The call was refused. Fix these and call bm_report again:\n- input.integration.commit: commit on ${BRANCH} and report its sha`,
    });
    expect(createOutbox(home).list(WS)).toEqual([]);
    expect(fake.sends).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)?.finishedAt).toBeNull();
    // Another phase, or finished with no file changed, is not held for a commit.
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done", filesChanged: ["b.ts"] }, WORKER_CALLER)).ok).toBe(true);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(home).list(WS).at(-1)!.text).not.toMatch(/^finished, /m);
  });

  it.skipIf(!hasGit)("a committed finish: the delivery says so, from read-only git", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const { sha } = placed(home);
    const result = await tools.worker.call("bm_report", { ...FINISHED, integration: { branch: BRANCH, commit: sha, pushed: false } }, WORKER_CALLER);
    expect(result.ok).toBe(true);
    const [record] = createOutbox(home).list(WS);
    expect(record!.text).toContain(`\npushed: no\n\nfinished, committed on ${BRANCH}.\n\nfinish gate not passed: `);
    expect(checkBlocks(record!.text).flatMap((block) => block.issues)).toEqual([]);
    expect(parseReports(record!.text, { agentId: WORKER, at: "" })[0]?.integration).toEqual({ branch: BRANCH, commit: sha, pushed: false });
    expect(fake.sends[0]!.text).toContain(`finished, committed on ${BRANCH}.`);
  });

  it.skipIf(!hasGit)("integration.ci off, the default (ADR-036 §17.1): verified is a check detected in the Worker's own turns; the report's ci is ignored; on restores CI", async () => {
    const shell = (status: string, at: string) => ({ item: { type: "tool_call", callId: "c1", name: "Bash", status, error: null, detail: { type: "shell", command: "npm test" } }, timestamp: at });
    const turns = (repo: string) => [
      { item: { type: "tool_call", callId: "e1", name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: join(repo, "b.ts") } }, timestamp: "2026-10-23T10:01:00.000Z" },
      shell("running", "2026-10-23T10:02:00.000Z"),
      shell("completed", "2026-10-23T10:03:00.000Z"),
    ];
    const finish = (sha: string) => ({ ...FINISHED, buildAndTests: "`npm test` passed", integration: { branch: BRANCH, commit: sha, pushed: true, mr: "https://gitlab.example/mr/7", ci: "failure" } });
    for (const ci of ["off", "on"] as const) {
      const home = dataFolder();
      const { repo, sha } = placed(home);
      const run = setup({ home, timelines: { [WORKER]: turns(repo) } });
      register(home);
      if (ci === "on") createCoordinationStore(home).set({ key: "integration.ci", value: "on" });
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(run.fake.sends[0]!.text, ci).toContain(`${ci === "off" ? `\n\nfinished, committed on ${BRANCH}; verified.` : `\n\nfinished, committed on ${BRANCH}; CI red.`}\n\nfinish gate not passed: `);
    }
    // Off, with no detected check (none run after the last edit): committed, with no CI words.
    const home = dataFolder();
    const { repo, sha } = placed(home);
    const run = setup({ home, timelines: { [WORKER]: turns(repo).slice(1).concat([{ ...turns(repo)[0]!, timestamp: "2026-10-23T10:04:00.000Z" }]) } });
    register(home);
    expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
    expect(run.fake.sends[0]!.text).toContain(`\n\nfinished, committed on ${BRANCH}.\n\nfinish gate not passed: `);
  });

  it.skipIf(!hasGit)("a dirty tree, or a sha not on the branch: the Main's delivery reads finished, uncommitted", async () => {
    const dirty = setup();
    register(dirty.home);
    const { repo, sha } = placed(dirty.home);
    writeFileSync(join(repo, "c.ts"), "c\n");
    expect((await dirty.tools.worker.call("bm_report", { ...FINISHED, integration: { branch: BRANCH, commit: sha, pushed: false } }, WORKER_CALLER)).ok).toBe(true);
    expect(dirty.fake.sends[0]!.text).toMatch(/\n\nfinished, uncommitted: the worktree has changes not committed\.\n\nfinish gate not passed: /);

    const other = setup();
    register(other.home);
    placed(other.home);
    const result = await other.tools.worker.call("bm_report", { ...FINISHED, integration: { branch: BRANCH, commit: "abcdef1", pushed: true, ci: "failure" } }, WORKER_CALLER);
    expect(result.ok).toBe(true);
    expect(other.fake.sends[0]!.text).toContain(`\n\nfinished, uncommitted: abcdef1 is not in the history of ${BRANCH}.\n\nfinish gate not passed: `);
  });

  describe("the local merge (ADR-045 decision 4)", () => {
    beforeEach(() => {
      vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });
    const shellEntry = { item: { type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test" } }, timestamp: "2026-10-23T10:03:00.000Z" };
    function recording(): { git: GitRunner; calls: string[][] } {
      const calls: string[][] = [];
      return { calls, git: (args, options) => (calls.push([...args]), mergeGit(args, options)) };
    }
    const WRITES = ["merge", "update-ref", "push", "tag", "reset", "branch", "rebase", "fetch"];
    const writesOf = (calls: readonly string[][]) => calls.filter((args) => WRITES.includes(args[0]!)).map((args) => args[0]);
    /** A placed mission whose Worker ran `npm test`, with the owner's grant unless told otherwise. */
    function granted(options: { grant?: boolean } = {}) {
      const home = dataFolder();
      const { repo, sha } = placed(home);
      const spy = recording();
      const run = setup({ home, timelines: { [WORKER]: [shellEntry] }, git: spy.git });
      register(home);
      const missionId = createMissionStore(home).list()[0]!.missionId;
      if (options.grant !== false) {
        createMissionStore(home).update(missionId, (mission) => ({ ...mission, placements: mission.placements!.map((placement) => ({ ...placement, localMerge: { state: "granted" as const, decisionId: "m:x:1", grantedAt: T0.toISOString(), revokedAt: null, target: "main" } })) }));
      }
      const finish = (commit: string) => ({ ...FINISHED, tier: { level: "Small" }, buildAndTests: "`npm test` passed", integration: { branch: BRANCH, commit, pushed: false } });
      return { home, repo, sha, spy, run, missionId, finish };
    }
    const journalOf = (home: string, missionId: string) => createMissionStore(home).journal(missionId, 20).map((line) => line.text);

    it.skipIf(!hasGit)("a passed gate under the grant moves a target not checked out to the reported commit; nothing is pushed", async () => {
      const { home, repo, sha, spy, run, missionId, finish } = granted();
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(repo, "rev-parse", "main")).toBe(sha);
      expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toEqual({ passed: true, reasons: [], at: T0.toISOString(), commit: sha });
      expect(writesOf(spy.calls)).toEqual(["update-ref"]);
      expect(journalOf(home, missionId)).toContain(`main moved forward to ${sha} by fast-forward.`);
      expect(run.fake.sends[0]!.text).not.toContain("finish gate not passed");
    });

    it.skipIf(!hasGit)("a commit reported with no file named must pass the gate first: one off the mission branch leaves the target where it is", async () => {
      const { home, repo, spy, run, finish } = granted();
      const before = gitIn(repo, "rev-parse", "main");
      gitIn(repo, "checkout", "-q", "-b", "side", before);
      writeFileSync(join(repo, "side.ts"), "side\n");
      gitIn(repo, "add", "side.ts");
      gitIn(repo, "commit", "-q", "-m", "side");
      const outside = gitIn(repo, "rev-parse", "HEAD");
      gitIn(repo, "checkout", "-q", BRANCH);
      expect((await run.tools.worker.call("bm_report", { ...finish(outside), filesChanged: [] }, WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(repo, "rev-parse", "main")).toBe(before);
      expect(writesOf(spy.calls)).toEqual([]);
      expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toEqual({ passed: false, reasons: [`the changed files are not committed: ${outside} is not in the history of ${BRANCH}`], at: T0.toISOString(), commit: outside });
    });

    it.skipIf(!hasGit)("a target checked out in a worktree moves by fast-forward there", async () => {
      const { home, repo, sha, spy, run, finish } = granted();
      const other = join(home, "..", "main-tree");
      gitIn(repo, "worktree", "add", "-q", other, "main");
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(other, "rev-parse", "HEAD")).toBe(sha);
      expect(writesOf(spy.calls)).toEqual(["merge"]);
      expect(createRequestRegistry(home).get(WS, REQ)?.finishGate?.passed).toBe(true);
    });

    it.skipIf(!hasGit)("a diverged target stays: the stored result is a failure with the reason, on the delivery and the journal", async () => {
      const { home, repo, sha, spy, run, missionId, finish } = granted();
      const other = join(home, "..", "main-tree");
      gitIn(repo, "worktree", "add", "-q", other, "main");
      writeFileSync(join(other, "own.ts"), "own\n");
      gitIn(other, "add", "own.ts");
      gitIn(other, "commit", "-q", "-m", "owner's own");
      const before = gitIn(other, "rev-parse", "HEAD");
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(repo, "rev-parse", "main")).toBe(before);
      const reason = `the local merge into main was refused: main and ${sha} have diverged, so it is not a fast-forward`;
      expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toEqual({ passed: false, reasons: [reason], at: T0.toISOString(), commit: sha });
      expect(run.fake.sends[0]!.text.endsWith(`\n\nfinish gate not passed: ${reason}`)).toBe(true);
      expect(journalOf(home, missionId)).toContain(`The local merge of ${sha} into main changed nothing: main and ${sha} have diverged, so it is not a fast-forward.`);
      expect(writesOf(spy.calls)).toEqual([]);
    });

    it.skipIf(!hasGit)("a file the merge would overwrite stays: the target unchanged, the gate failed, the file named", async () => {
      const { home, repo, sha, run, finish } = granted();
      const other = join(home, "..", "main-tree");
      gitIn(repo, "worktree", "add", "-q", other, "main");
      writeFileSync(join(other, "b.ts"), "not the mission's\n");
      const before = gitIn(other, "rev-parse", "HEAD");
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(other, "rev-parse", "HEAD")).toBe(before);
      expect(readFileSync(join(other, "b.ts"), "utf8")).toBe("not the mission's\n");
      expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toMatchObject({ passed: false, reasons: ["the local merge into main was refused: uncommitted changes in main's worktree would be overwritten: b.ts"] });
    });

    it.skipIf(!hasGit)("a refused merge is in the stored result before the roster entry turns finished", async () => {
      const { home, repo, sha, run, finish } = granted();
      const other = join(home, "..", "main-tree");
      gitIn(repo, "worktree", "add", "-q", other, "main");
      writeFileSync(join(other, "b.ts"), "dirty\n");
      const seen: unknown[] = [];
      gateWatch.roster = (requestId, phase) => seen.push([phase, createRequestRegistry(home).get(WS, requestId)?.finishGate?.passed]);
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(seen).toEqual([["finished", false]]);
    });

    it.skipIf(!hasGit)("without the grant, or with a failed gate, git writes nothing", async () => {
      const without = granted({ grant: false });
      expect((await without.run.tools.worker.call("bm_report", without.finish(without.sha), WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(without.repo, "rev-parse", "main")).not.toBe(without.sha);
      expect(writesOf(without.spy.calls)).toEqual([]);

      const failed = granted();
      expect((await failed.run.tools.worker.call("bm_report", { ...failed.finish(failed.sha), buildAndTests: "not run" }, WORKER_CALLER)).ok).toBe(true);
      expect(createRequestRegistry(failed.home).get(WS, REQ)?.finishGate?.passed).toBe(false);
      expect(gitIn(failed.repo, "rev-parse", "main")).not.toBe(failed.sha);
      expect(writesOf(failed.spy.calls)).toEqual([]);
    });

    it.skipIf(!hasGit)("a no-file continuation that passes moves the target to its chain's newest reported commit, never the branch head", async () => {
      const { home, repo, sha, run, finish } = granted({ grant: true });
      // The predecessor finished with its commit; the branch then moved on.
      expect((await run.tools.worker.call("bm_report", finish(sha), WORKER_CALLER)).ok).toBe(true);
      expect(gitIn(repo, "rev-parse", "main")).toBe(sha);
      writeFileSync(join(repo, "later.ts"), "later\n");
      gitIn(repo, "add", "later.ts");
      gitIn(repo, "commit", "-q", "-m", "later");
      const head = gitIn(repo, "rev-parse", "HEAD");
      gitIn(repo, "update-ref", "refs/heads/main", gitIn(repo, "rev-parse", "HEAD~1~1"));
      const next = createRequestRegistry(home, { backfill: () => [], now: () => new Date(T0.getTime() + 60_000) }).generate(WS, { managerId: MANAGER, continuationOf: REQ, chainRootId: REQ }).requestId;
      createRequestRegistry(home).addWorker(WS, next, WORKER);
      const result = await run.tools.worker.call("bm_report", { ...REPORT, requestId: next, phase: "finished", tier: { level: "Small" } }, { ...WORKER_CALLER, requestId: next });
      expect(result.ok).toBe(true);
      expect(createRequestRegistry(home).get(WS, next)?.finishGate).toEqual({ passed: true, reasons: [], at: T0.toISOString(), commit: sha });
      expect(gitIn(repo, "rev-parse", "main")).toBe(sha);
      expect(gitIn(repo, "rev-parse", "main")).not.toBe(head);
    });
  });

  it.skipIf(!hasGit)("the local-merge card opens once, at the first finished that passes its gate with a commit", async () => {
    const shell = { item: { type: "tool_call", callId: "c1", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "npm test" } }, timestamp: "2026-10-23T10:03:00.000Z" };
    const home = dataFolder();
    const { sha } = placed(home);
    const run = setup({ home, timelines: { [WORKER]: [shell] } });
    register(home);
    const finish = { ...FINISHED, tier: { level: "Small" }, buildAndTests: "`npm test` passed", integration: { branch: BRANCH, commit: sha, pushed: false } };
    const missionId = createMissionStore(home).list()[0]!.missionId;
    expect((await run.tools.worker.call("bm_report", finish, WORKER_CALLER)).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)?.finishGate?.passed).toBe(true);
    const asks = () => createMissionDecisionStore(home).list(missionId).filter((decision) => decision.subject === "local-merge");
    expect(asks().map((decision) => [decision.requestId, decision.ownerOnly])).toEqual([[REQ, true]]);
    // A later passing finish asks nothing more.
    register(home, OTHER_REQ);
    expect((await run.tools.worker.call("bm_report", { ...finish, requestId: OTHER_REQ }, { ...WORKER_CALLER, requestId: OTHER_REQ })).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, OTHER_REQ)?.finishGate?.passed).toBe(true);
    expect(asks()).toHaveLength(1);
  });

  it.skipIf(!hasGit)("a finished whose gate failed opens no local-merge card; the push card still opens", async () => {
    const { home, tools } = setup();
    register(home);
    const { sha } = placed(home);
    const missionId = createMissionStore(home).list()[0]!.missionId;
    expect((await tools.worker.call("bm_report", { ...FINISHED, integration: { branch: BRANCH, commit: sha, pushed: false } }, WORKER_CALLER)).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)?.finishGate?.passed).toBe(false);
    expect(createMissionDecisionStore(home).list(missionId).map((decision) => decision.subject)).toEqual(["integration"]);
  });

  it.skipIf(!hasGit)("the finish gate: stored on every finished; the delivery names why it failed", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const { sha } = placed(home);
    expect((await tools.worker.call("bm_report", { ...FINISHED, integration: { branch: BRANCH, commit: sha, pushed: false } }, WORKER_CALLER)).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toEqual({
      passed: false,
      reasons: ["the changed files have no wave or finished review", "no report of the chain names its checks"],
      at: T0.toISOString(),
      commit: sha,
    });
    expect(fake.sends[0]!.text.endsWith("\n\nfinish gate not passed: the changed files have no wave or finished review; no report of the chain names its checks")).toBe(true);
  });
});

describe("bm_report and the finish gate (ADR-045 decision 2)", () => {
  it("a passing finished says nothing of the gate; other phases store none", async () => {
    const { home, fake, tools } = setup();
    register(home);
    expect((await tools.worker.call("bm_report", { ...REPORT, ...RESTATED }, WORKER_CALLER)).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toBeUndefined();
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toEqual({ passed: true, reasons: [], at: T0.toISOString(), commit: null });
    expect(fake.sends.map((send) => send.text).join("\n")).not.toContain("finish gate");
  });

  it("the result is stored before the roster entry turns finished", async () => {
    const { home, tools } = setup();
    register(home);
    const seen: unknown[] = [];
    gateWatch.roster = (requestId, phase) => seen.push([requestId, phase, createRequestRegistry(home).get(WS, requestId)?.finishGate?.passed]);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(seen).toEqual([[REQ, "finished", true]]);
  });

  it("a failed write leaves no result; the report still goes", async () => {
    const { home, logs, tools } = setup();
    register(home);
    gateWatch.failNote = true;
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    gateWatch.failNote = false;
    expect(createRequestRegistry(home).get(WS, REQ)?.finishGate).toBeUndefined();
    expect(createRequestRegistry(home).get(WS, REQ)?.finishedAt).toBe(T0.toISOString());
    expect(logs.join("\n")).toContain(`could not note the finish gate of request ${REQ}`);
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

  it("a review-cap or review-budget question is refused, opening nothing (delivery line design §5.4, §5.6)", async () => {
    const { home, tools } = setup();
    register(home);
    for (const subject of ["review-cap", "review-budget"]) {
      const result = await tools.worker.call("bm_questions", { questions: [QUESTION({ text: "More review calls?", subject, class: "cost" })] }, WORKER_CALLER);
      expect(result.ok, subject).toBe(false);
      expect(result.text).toContain("input.questions[0].subject: ");
    }
    expect(createDecisionStore(home).list({ workspaceId: WS })).toEqual([]);
  });

  it("refuses the whole call on any invalid question, opening nothing", async () => {
    const { home, tools } = setup();
    register(home);
    const cases: Array<[unknown, string]> = [
      [{ questions: [QUESTION(), QUESTION({ options: [{ key: "a", text: "x", effects: ["none"] }, { key: "b", text: "y", effects: ["none"] }] })] }, "input.questions[1].options: exactly one option is recommended (found 0)"],
      [{ questions: [QUESTION({ options: [{ key: "a", text: "x", effects: ["none"], recommended: true }, { key: "b", text: "y", effects: ["none"], recommended: true }] })] }, "exactly one option is recommended (found 2)"],
      // Delivery line design §5.6: no Worker question grants review calls.
      [{ questions: [QUESTION({ options: [{ key: "a", text: "x", effects: ["none"], recommended: true, grant: { calls: 2 } }, { key: "b", text: "y", effects: ["none"] }] })] }, "input.questions[0].options[0].grant: is not a field of this tool"],
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

  it("refuses an unbound or pending caller", async () => {
    expect(await setup().tools.worker.call("bm_questions", { questions: [QUESTION()] }, null)).toEqual({ ok: false, text: QUESTIONS_NOT_BOUND_MESSAGE });
    expect(await setup().tools.worker.call("bm_questions", { questions: [QUESTION()] }, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
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

  it("records the review's verdict and blocking count on its batch before its Worker is woken (delivery line design §5.2)", async () => {
    const { home, tools } = setup();
    register(home);
    createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "out-00000000000a", kind: "create", reviewerId: REVIEWER, at: T0.toISOString() }, "brief", "finished");
    const blocking = (location: string) => ({ severity: "blocking", location, reason: "Off by one.", suggestedFix: "Use <=." });
    const result = await tools.reviewer.call("bm_review", { ...REVIEW, findings: [blocking("src/a.ts:3"), blocking("src/b.ts:9"), { ...blocking("src/c.ts:1"), severity: "non-blocking" }] }, REVIEWER_CALLER);
    expect(result.ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.results).toEqual([
      { at: T0.toISOString(), recordId: parsed(result)["recordId"], verdict: "changes-required", blocking: 2 },
    ]);
    // A request the registry does not hold: delivered all the same.
    expect((await setup().tools.reviewer.call("bm_review", REVIEW, REVIEWER_CALLER)).ok).toBe(true);
  });

  it("after a handoff, delivers the verdict of a batch the replaced Worker opened to the request's current Worker (delivery line design §6.4)", async () => {
    const SUCCESSOR = "agent-worker-successor";
    const replaced = AGENTS.map((agent) => (agent.id === WORKER ? { ...agent, labels: { ...agent.labels, "bm.replacedBy": SUCCESSOR } } : agent));
    const agents = [...replaced, { id: SUCCESSOR, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "bm.handoffFrom": WORKER } }];
    const { home, fake, tools } = setup({ agents });
    register(home);
    createRequestRegistry(home).addWorker(WS, REQ, SUCCESSOR);
    // The successor waits on b1; the replaced Worker is no longer the request's, so nothing gates it — or is held for it.
    createRequestRegistry(home).setWaiting(WS, REQ, { since: T0.toISOString(), reportRecordId: "out-0000000000ff", wakeOn: "all", items: [{ kind: "batch", id: "b1", settled: false }] });
    const result = await tools.reviewer.call("bm_review", REVIEW, REVIEWER_CALLER);
    expect(parsed(result)).toEqual({ recordId: "out-000000000001", delivery: "sent" });
    expect(createOutbox(home).list(WS)[0]).toMatchObject({ kind: "review", batchId: "b1", to: SUCCESSOR, state: "delivered" });
    expect(fake.sends.map((send) => send.id)).toEqual([SUCCESSOR]);
    // Its wait settled and was released with it.
    expect(createRequestRegistry(home).get(WS, REQ)?.waiting).toBeUndefined();
  });

  it("keeps the Reviewer's parent when the request has no single live Worker to send to instead", async () => {
    const OTHER_WORKER = "agent-worker-2";
    const agents = [...AGENTS, { id: OTHER_WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ } }];
    const { home, tools } = setup({ agents });
    register(home);
    createRequestRegistry(home).addWorker(WS, REQ, OTHER_WORKER);
    expect((await tools.reviewer.call("bm_review", REVIEW, REVIEWER_CALLER)).ok).toBe(true);
    expect(createOutbox(home).list(WS)[0]).toMatchObject({ kind: "review", to: WORKER });
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

  it("a Main's request in another repo: checked and proposed there, settled there at its turn's end (missions design §6)", async () => {
    const MAIN = "agent-main";
    const BACK = "wks_back";
    const HOME_WS = "wks_home";
    const context = setup();
    const { home, tools } = context;
    createRequestRegistry(home, { backfill: () => [] }).register(BACK, REQ, { source: "tool", managerId: MAIN, workerId: WORKER });
    createMissionRoster(home).add("mis-0123456789", { requestId: REQ, workspaceId: BACK, topic: "Orders API", workerId: WORKER });
    await tools.worker.call("bm_questions", { questions: [QUESTION()] }, { ...WORKER_CALLER, workspaceId: BACK, parentId: MAIN });
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, BACK)?.status).toBe("open");
    const caller = { ...MANAGER_CALLER, agentId: MAIN, workspaceId: HOME_WS, missionId: "mis-0123456789" };
    expect(parsed(await tools.manager.call("bm_answers", ANSWERS, caller))).toEqual({ proposed: ["Q1"] });
    expect(proposedAnswersOf(MAIN, START)).toEqual([{ workspaceId: BACK, requestId: REQ, answers: [{ id: "Q1", text: "a — Push contract only" }] }]);
    const record = turn({ agentId: MAIN, role: "manager", workspaceId: HOME_WS, startedAt: START, endedAt: new Date(T0.getTime() + 60_000).toISOString(), sent: [msg(MAIN, new Date(T0.getTime() + 10_000).toISOString(), "a", "user")] });
    await materialise(home, record);
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, BACK)).toMatchObject({ status: "answered", answer: { by: "owner", via: "chat-manager", optionKey: "a" } });
    expect(createDecisionStore(home).list({ workspaceId: HOME_WS })).toEqual([]);
  });

  it("a Worker's ownerOnly question is stored so; the Manager's bm_answers refuses it, proposing nothing (missions design §5)", async () => {
    const context = setup();
    register(context.home);
    await context.tools.worker.call("bm_questions", { questions: [QUESTION({ ownerOnly: true, subject: "npm-login", text: "Is npm logged in?" })] }, WORKER_CALLER);
    expect(createDecisionStore(context.home).get(`q:${REQ}:Q1`, WS)).toMatchObject({ status: "open", ownerOnly: true });
    const result = await context.tools.manager.call("bm_answers", ANSWERS, MANAGER_CALLER);
    expect(result.ok).toBe(false);
    expect(result.text).toContain(`input.answers[0]: q:${REQ}:Q1 asks a fact only the owner knows (ownerOnly)`);
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
  const TELL = { requestId: REQ, text: "Use dd/mm/yyyy.\nEverywhere.", source: "owner message, 10:04", about: "current" };

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
    await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "Go on.", about: "current" }, MANAGER_CALLER);
    expect(fake.sends[1]!.text.split("\n").slice(1)).toEqual([`Continue ${REQ}.`, "Go on."]);
  });

  it("now: true steers the owner's words into the running Claude Worker's turn: delivery steered, the record steeredAt (delivery line design §19.5)", async () => {
    const running = { ...AGENTS[1]!, status: "running", activeTurn: { turnId: "turn-1", startedAt: new Date(T0.getTime() - 47 * 60_000).toISOString() } } as Agent;
    const { home, fake, tools } = setup({ agents: [AGENTS[0]!, running], config: { providers: { "bm-worker": { extends: "claude" } } } });
    register(home);
    expect(parsed(await tools.manager.call("bm_tell_worker", { ...TELL, now: true }, MANAGER_CALLER))).toEqual({ workerId: WORKER, delivery: "steered" });
    const send = fake.paseo.agents.ref(WORKER).send as unknown as { mock: { calls: unknown[][] } };
    expect(send.mock.calls).toHaveLength(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ activeTurnBehavior: "steer" });
    const [record] = createOutbox(home).list(WS);
    expect(record).toMatchObject({ kind: "message", atOnce: true, state: "delivered", steeredAt: T0.toISOString() });
    // Without now: true it waits for the turn end, as before, and says how long that turn has run (§19.4).
    expect(parsed(await tools.manager.call("bm_tell_worker", TELL, MANAGER_CALLER))).toEqual({ workerId: WORKER, delivery: "queued", turnMinutes: 47 });
    expect(send.mock.calls).toHaveLength(1);
  });

  it("a request still at work takes only words about its own work: about is required, and new work is refused toward its own Worker (delivery line design §19.12)", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const missing = await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "CLIENT_CONTRACT on /admin/ops/catalog." }, MANAGER_CALLER);
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain(`input.about: request ${REQ} is still at work: "current" when these words correct, stop or answer its own work; "new" for any other work, which gets its own Worker`);
    const fresh = await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "CLIENT_CONTRACT on /admin/ops/catalog.", about: "new", now: true }, MANAGER_CALLER);
    expect(fresh).toEqual({ ok: false, text: newWorkRefusalOf(REQ, null) });
    expect(fresh.text).toBe(`New work never goes into request ${REQ}, which is still at work: give it its own Worker with bm_create_worker (after: ["${REQ}"] if it needs this request first). Nothing was sent.`);
    const inMission = newWorkRefusalOf(REQ, "mis-0000000001");
    expect(inMission).toContain("next: true for new work");
    expect(inMission).toContain(`after: ["${REQ}"] when it needs that request's result`);
    expect(inMission).toContain("parallel only with the owner's explicit word quoted");
    expect(inMission).not.toContain("lane:");
    expect(fake.sends).toHaveLength(0);
    expect(createOutbox(home).list(WS)).toEqual([]);
  });

  it("a replaced Worker resolves to its successor", async () => {
    const successor: Agent = { id: "agent-worker-2", provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "bm.handoffFrom": WORKER } };
    const replaced: Agent = { ...AGENTS[1]!, labels: { ...AGENTS[1]!.labels, "bm.replacedBy": successor.id } };
    const { home, fake, tools } = setup({ agents: [AGENTS[0]!, replaced, successor] });
    register(home);
    expect(parsed(await tools.manager.call("bm_tell_worker", TELL, MANAGER_CALLER))).toEqual({ workerId: successor.id, delivery: "sent" });
    expect(fake.sends.map((send) => send.id)).toEqual([successor.id]);
  });

  it("a Main's request in another repo: found through the request index, its Worker reached there, the message kept in that repo's outbox (missions design §4)", async () => {
    const MAIN = "agent-main";
    const BACK = "wks_back";
    const worker: Agent = { id: "agent-back-worker", provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: BACK, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MAIN } };
    const main: Agent = { id: MAIN, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: "wks_home", labels: { "bm.role": "manager" } };
    const { home, fake, tools } = setup({ agents: [main, worker] });
    createRequestRegistry(home, { backfill: () => [] }).register(BACK, REQ, { source: "tool", managerId: MAIN, workerId: worker.id });
    createMissionRoster(home).add("mis-0123456789", { requestId: REQ, workspaceId: BACK, topic: "Orders API", workerId: worker.id });
    const caller = { ...MANAGER_CALLER, agentId: MAIN, workspaceId: "wks_home", missionId: "mis-0123456789" };
    expect(parsed(await tools.manager.call("bm_tell_worker", TELL, caller))).toEqual({ workerId: worker.id, delivery: "sent" });
    expect(fake.sends.map((send) => send.id)).toEqual([worker.id]);
    expect(createOutbox(home).list(BACK)).toMatchObject([{ kind: "message", requestId: REQ, from: MAIN, to: worker.id }]);
    expect(createOutbox(home).list("wks_home")).toEqual([]);
    // Still only the request's Manager: another Main is refused.
    expect((await tools.manager.call("bm_tell_worker", TELL, { ...caller, agentId: "agent-other-main" })).text).toBe(
      `request ${REQ} is not one of yours: another Manager created its Worker. Nothing was sent.`,
    );
  });

  it("refs (delivery line design §9.1): each unknown id is one refusal line and nothing is sent; known ids go on a refs: line after the words", async () => {
    const MAIN = "agent-main";
    const MISSION = "mis-0123456789";
    const BACK = "wks_back";
    const worker: Agent = { id: "agent-back-worker", provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: BACK, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MAIN } };
    const main: Agent = { id: MAIN, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: "wks_home", labels: { "bm.role": "manager" } };
    const { home, fake, tools } = setup({ agents: [main, worker] });
    const made = createMissionStore(home, { newId: () => MISSION, env: {} }).create({ code: "ORD", name: "Orders", goal: "Sell", repos: [BACK], createdBy: "owner", mainId: MAIN });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    createMissionStore(home).update(MISSION, (mission) => ({
      ...mission,
      contracts: [{ id: "C1", title: "Orders API", providerRepo: BACK, consumerRepos: [], text: "GET /orders", version: 2, updatedAt: "2026-10-03T10:00:00.000Z", source: "PRD", status: "proposed" as const }],
    }));
    createRequestRegistry(home, { backfill: () => [] }).register(BACK, REQ, { source: "tool", managerId: MAIN, workerId: worker.id });
    createMissionRoster(home).add(MISSION, { requestId: REQ, workspaceId: BACK, topic: "Orders API", workerId: worker.id });
    const caller = { ...MANAGER_CALLER, agentId: MAIN, workspaceId: "wks_home", missionId: MISSION };
    expect((await tools.manager.call("bm_tell_worker", { ...TELL, refs: { contracts: ["C1@v3", "C2@v1"], records: ["out-0000000000aa"], decisions: [`m:${MISSION}:9`] } }, caller)).text).toBe(
      [
        "refs.contracts: unknown contract C1@v3; bm_mission lists the contracts and their versions",
        "refs.contracts: unknown contract C2@v1; bm_mission lists the contracts and their versions",
        "refs.records: unknown record out-0000000000aa",
        `refs.decisions: unknown decision m:${MISSION}:9`,
        "Nothing was sent.",
      ].join("\n"),
    );
    expect((await tools.manager.call("bm_tell_worker", { ...TELL, refs: { contracts: ["C1"] } }, caller)).text).toContain("input.refs.contracts[0]");
    expect(fake.sends).toEqual([]);
    expect(parsed(await tools.manager.call("bm_tell_worker", { ...TELL, refs: { contracts: ["C1@v2", "C1@v1"] } }, caller))).toEqual({ workerId: worker.id, delivery: "sent" });
    const [record] = createOutbox(home).list(BACK);
    expect(fake.sends).toEqual([
      { id: worker.id, text: [`BM-DELIVERY message ${record!.id}`, `Continue ${REQ}.`, "Use dd/mm/yyyy.", "Everywhere.", "refs: C1@v2, C1@v1", "source: owner message, 10:04"].join("\n") },
    ]);
    // A record the outbox holds is a known ref.
    fake.byId(worker.id)!.status = "idle";
    expect(parsed(await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "As said.", about: "current", refs: { records: [record!.id] } }, caller))).toMatchObject({ delivery: "sent" });
    expect(fake.sends[1]!.text.split("\n").slice(1)).toEqual([`Continue ${REQ}.`, "As said.", `refs: ${record!.id}`]);
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

// ---------------------------------------------------------------------------
// Peer links (design §7.17.3, §7.17.4, §7.17.8 g).
// ---------------------------------------------------------------------------

describe("peer links through bm_report and bm_tell_worker (design §7.17.3)", () => {
  const FRONT = "wks_front";
  const REQ_FRONT = "req-20261003T090000Z";
  const ANSWERED = "peer-0000000000a1";
  const ASKED = "peer-0000000000b1";
  const ASKER: Agent = { id: "wrk-front", provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: FRONT, labels: { "bm.role": "worker", "bm.requestId": REQ_FRONT } };
  const PEER_AGENTS = [...AGENTS, ASKER];

  /** A link another project asked of this one; `take` gives it to REQ. */
  const askOfUs = (home: string, linkId = ANSWERED, take = true) => {
    const links = createPeerLinkStore(home, { newId: () => linkId, now: () => T0 });
    links.createLink({ kind: "work", from: { workspaceId: FRONT, requestId: REQ_FRONT, agentId: ASKER.id, role: "worker" }, to: { workspaceId: WS, managerId: MANAGER }, text: "Add GET /api/orders." });
    if (take) links.takeLink(linkId, { workspaceId: WS, requestId: REQ, workerId: WORKER });
  };
  /** A link REQ asked of another project. */
  const askedByUs = (home: string, linkId = ASKED) =>
    createPeerLinkStore(home, { newId: () => linkId, now: () => T0 }).createLink({
      kind: "question",
      from: { workspaceId: WS, requestId: REQ, agentId: WORKER, role: "worker" },
      to: { workspaceId: "wks_back", managerId: "mgr-back" },
      text: "Which date format does the API take?",
    });
  const link = (home: string, id: string) => createPeerLinkStore(home).get(id)!;

  it("finished of a request that carries a link needs forPeer; with it the reply is stored pending in this outbox and delivered to the asker after the report", async () => {
    const { home, fake, tools } = setup({ agents: PEER_AGENTS });
    register(home);
    askOfUs(home);
    const finished = { ...REPORT, phase: "finished" };
    const refusal = await tools.worker.call("bm_report", finished, WORKER_CALLER);
    expect(refusal).toEqual({
      ok: false,
      text: `The call was refused. Fix these and call bm_report again:\n- input.forPeer: request ${REQ} answers link ${ANSWERED}: write what that project needs to know`,
    });
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);

    expect(parsed(await tools.worker.call("bm_report", { ...finished, forPeer: "GET /api/orders is live.\nShape: { id, total }." }, WORKER_CALLER))).toEqual({ recordId: "out-000000000001", delivery: "sent" });
    const [report, reply] = createOutbox(home).list(WS);
    expect(report).toMatchObject({ kind: "report", to: MANAGER });
    // The block never carries forPeer: it goes to the other project only.
    expect(report!.text).not.toContain("GET /api/orders");
    const text = peerReplyText({ linkId: ANSWERED, title: WS, workspaceId: WS, requestId: REQ, phase: "finished", body: "GET /api/orders is live.\nShape: { id, total }." });
    expect(reply).toMatchObject({ id: "out-000000000002", kind: "peer-reply", requestId: REQ, from: WORKER, to: ASKER.id, text });
    await vi.waitFor(() => expect(fake.sends.map((send) => send.id)).toEqual([MANAGER, ASKER.id]));
    expect(fake.sends[1]!.text).toBe(`BM-DELIVERY peer-reply out-000000000002\n${text}`);
    await vi.waitFor(() => expect(createOutbox(home).list(WS)[1]!.state).toBe("delivered"));
    expect(link(home, ANSWERED)).toMatchObject({ state: "answered", answeredAt: T0.toISOString() });
    expect(link(home, ANSWERED).messages).toMatchObject([{ recordId: "out-000000000002", workspaceId: WS, side: "answerer", agentId: WORKER, kind: "peer-reply", phase: "finished" }]);

    // A later finished is refused (delivery line design §2.3): nothing more is announced; the link stays answered.
    fake.byId(MANAGER)!.status = "idle";
    fake.byId(ASKER.id)!.status = "idle";
    expect((await tools.worker.call("bm_report", { ...finished, forPeer: "Also GET /api/orders/:id." }, WORKER_CALLER)).ok).toBe(false);
    expect(fake.sends.map((send) => send.id)).toEqual([MANAGER, ASKER.id]);
    expect(link(home, ANSWERED).state).toBe("answered");
    expect(link(home, ANSWERED).messages.map((message) => message.phase)).toEqual(["finished"]);
  });

  it("a finished reply answers its link only once delivered: queued for a running asker the link stays taken; one dropped leaves it taken", async () => {
    const { home, fake, queue, tools } = setup({ agents: [...AGENTS, { ...ASKER, status: "running" }] });
    register(home);
    askOfUs(home);
    const finished = { ...REPORT, phase: "finished", forPeer: "GET /api/orders is live." };
    expect((await tools.worker.call("bm_report", finished, WORKER_CALLER)).ok).toBe(true);
    await vi.waitFor(() => expect(queue.pending(ASKER.id)).toHaveLength(1));
    expect(createOutbox(home).list(WS)[1]).toMatchObject({ kind: "peer-reply", state: "pending" });
    expect(link(home, ANSWERED)).toMatchObject({ state: "taken", answeredAt: null });
    fake.byId(ASKER.id)!.status = "idle";
    await queue.turnEnded({ agent: { id: ASKER.id, workspaceId: FRONT, parentAgentId: null, provider: ASKER.provider, cwd: "/repo", title: null }, turnId: "t", outcome: { kind: "completed" }, timeline: [] }, fake.paseo);
    await vi.waitFor(() => expect(createOutbox(home).list(WS)[1]!.state).toBe("delivered"));
    expect(link(home, ANSWERED)).toMatchObject({ state: "answered", answeredAt: T0.toISOString() });

    // No live agent on the asking side: the reply is dropped and the link stays taken.
    const gone = setup();
    register(gone.home);
    askOfUs(gone.home);
    expect((await gone.tools.worker.call("bm_report", finished, WORKER_CALLER)).ok).toBe(true);
    await vi.waitFor(() => expect(createOutbox(gone.home).list(WS)[1]).toMatchObject({ kind: "peer-reply", state: "dropped", reason: "no live agent is left on the link's other side" }));
    expect(link(gone.home, ANSWERED).state).toBe("taken");
  });

  it("finished closes, by the asker, each link the request asked that nobody took yet; a taken one stays, and other phases close nothing", async () => {
    const { home, fake, tools } = setup({ agents: PEER_AGENTS });
    register(home);
    askedByUs(home);
    const TAKEN = "peer-0000000000b2";
    askedByUs(home, TAKEN);
    createPeerLinkStore(home).takeLink(TAKEN, { workspaceId: "wks_back", requestId: "req-20261003T120000Z", workerId: "wrk-back" });
    for (const phase of ["received", "beads-done", "stopped"]) {
      fake.byId(MANAGER)!.status = "idle";
      expect((await tools.worker.call("bm_report", { ...REPORT, ...restatedAt(phase), phase }, WORKER_CALLER)).ok).toBe(true);
    }
    expect(link(home, ASKED).state).toBe("open");
    fake.byId(MANAGER)!.status = "idle";
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "finished" }, WORKER_CALLER)).ok).toBe(true);
    expect(link(home, ASKED)).toMatchObject({ state: "closed", closedBy: "asker", closedAt: T0.toISOString() });
    expect(link(home, TAKEN).state).toBe("taken");
  });

  it("blocked and stopped reply with the report's blockers line (and forPeer when given); received and beads-done reply nothing", async () => {
    const { home, fake, tools } = setup({ agents: PEER_AGENTS });
    register(home);
    askOfUs(home);
    askedByUs(home);
    for (const phase of ["received", "beads-done"]) expect((await tools.worker.call("bm_report", { ...REPORT, ...restatedAt(phase), phase }, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(home).list(WS).filter((record) => record.kind === "peer-reply")).toEqual([]);
    fake.byId(MANAGER)!.status = "idle";
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "blocked", waitingOnPeers: [ASKED] }, WORKER_CALLER)).ok).toBe(true);
    fake.byId(MANAGER)!.status = "idle";
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "stopped", forPeer: "Stopped by the owner." }, WORKER_CALLER)).ok).toBe(true);
    const replies = createOutbox(home).list(WS).filter((record) => record.kind === "peer-reply");
    expect(replies.map((record) => record.text)).toEqual([
      peerReplyText({ linkId: ANSWERED, title: WS, workspaceId: WS, requestId: REQ, phase: "blocked", body: `blockers: waiting on project: wks_back (${ASKED})` }),
      peerReplyText({ linkId: ANSWERED, title: WS, workspaceId: WS, requestId: REQ, phase: "stopped", body: "blockers: none\nStopped by the owner." }),
    ]);
    expect(link(home, ANSWERED).state).toBe("taken");
  });

  it("waitingOnPeers: blocked only, live links this request asked; it sets waitingSince and every report clears it", async () => {
    const { home, fake, tools, tick } = setup({ agents: PEER_AGENTS });
    register(home);
    askedByUs(home);
    askOfUs(home, "peer-0000000000c1", false);
    const blocked = { ...REPORT, phase: "blocked", waitingOnPeers: [ASKED] };
    expect((await tools.worker.call("bm_report", blocked, WORKER_CALLER)).ok).toBe(true);
    const [record] = createOutbox(home).list(WS);
    expect(record!.text).toContain(`blockers: waiting on project: wks_back (${ASKED})`);
    expect(checkBlocks(record!.text).flatMap((block) => block.issues)).toEqual([]);
    expect(link(home, ASKED).waitingSince).toBe(T0.toISOString());
    tick(60_000);
    fake.byId(MANAGER)!.status = "idle";
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done" }, WORKER_CALLER)).ok).toBe(true);
    expect(link(home, ASKED).waitingSince).toBeNull();

    // Refused: outside blocked; a link it did not ask, an unknown one, a closed one.
    createPeerLinkStore(home, { newId: () => "peer-0000000000d1" }).createLink({ kind: "work", from: { workspaceId: WS, requestId: REQ, agentId: WORKER, role: "worker" }, to: { workspaceId: "wks_back", managerId: null }, text: "x" });
    createPeerLinkStore(home).closeLink("peer-0000000000d1", "asker");
    const before = createOutbox(home).list(WS).length;
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "beads-done", waitingOnPeers: [ASKED] }, WORKER_CALLER)).text).toContain("- input.waitingOnPeers: only a blocked report waits; leave it out");
    const wrong = await tools.worker.call("bm_report", { ...blocked, waitingOnPeers: ["peer-0000000000c1", "peer-0000000000e1", "peer-0000000000d1"] }, WORKER_CALLER);
    expect(wrong.text.split("\n").slice(1)).toEqual([
      "- input.waitingOnPeers: peer-0000000000c1 is not a live link your request asked; leave it out",
      "- input.waitingOnPeers: peer-0000000000e1 is not a live link your request asked; leave it out",
      "- input.waitingOnPeers: peer-0000000000d1 is not a live link your request asked; leave it out",
    ]);
    expect((await tools.worker.call("bm_report", { ...REPORT, phase: "blocked" }, WORKER_CALLER)).text).toContain("waitingOnPeers (links you asked)");
    expect(createOutbox(home).list(WS)).toHaveLength(before);
  });

  it("a stopped report sent in the first turn after a Paseo cut carries the note line; after an owner's message, or with no cut, it does not (§7.17.8 g)", async () => {
    const cutAt = Date.parse("2026-10-03T10:04:00.000Z");
    let clock = cutAt + 1_000;
    const watch = createInterruptionWatch({ now: () => clock, setTimer: () => undefined });
    const canceled = { agentId: WORKER, role: "worker", outcome: "canceled", startedAt: "2026-10-03T10:00:00.000Z", endedAt: new Date(cutAt).toISOString(), sent: [] } as unknown as TraceRecord;
    const stopped = { ...REPORT, phase: "stopped" };

    // No cut seen: no note, and the timeline is never read.
    const plain = setup();
    register(plain.home);
    expect((await plain.tools.worker.call("bm_report", stopped, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(plain.home).list(WS)[0]!.text).not.toContain(CUT_NOTE_LINE);

    // Paseo cut the turn to deliver another agent's message: the stop is not the owner's.
    watch.turnRecorded(canceled, undefined);
    watch.turnStarted(WORKER);
    const cut = setup();
    register(cut.home);
    cut.fake.setTimeline(WORKER, [{ item: { type: "user_message", text: "Reviewer agent-reviewer finished." }, timestamp: "2026-10-03T10:04:01.000Z" }]);
    expect((await cut.tools.worker.call("bm_report", stopped, WORKER_CALLER)).ok).toBe(true);
    const [record] = createOutbox(cut.home).list(WS);
    expect(record!.text.endsWith(`\n\n${CUT_NOTE_LINE}`)).toBe(true);
    expect(CUT_NOTE_LINE).toBe("note: the turn before this report was cut by a message delivery, not by the owner");
    expect(cut.fake.sends[0]!.text).toContain(CUT_NOTE_LINE);
    expect(parseReports(record!.text, { agentId: WORKER, at: T0.toISOString() })[0]).toMatchObject({ phase: "stopped" });
    // Only a stopped report carries it.
    cut.fake.byId(MANAGER)!.status = "idle";
    expect((await cut.tools.worker.call("bm_report", { ...REPORT, phase: "beads-done" }, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(cut.home).list(WS)[1]!.text).not.toContain(CUT_NOTE_LINE);

    // The owner typed the message that started the turn: their stop.
    const owner = setup();
    register(owner.home);
    owner.fake.setTimeline(WORKER, [{ item: { type: "user_message", text: "Stop here.", clientMessageId: "m-1" }, timestamp: "2026-10-03T10:04:01.000Z" }]);
    expect((await owner.tools.worker.call("bm_report", stopped, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(owner.home).list(WS)[0]!.text).not.toContain(CUT_NOTE_LINE);

    // A later turn, long after the cut, is not the first after it.
    clock = cutAt + 120_000;
    watch.turnStarted(WORKER);
    const later = setup();
    register(later.home);
    later.fake.setTimeline(WORKER, [{ item: { type: "user_message", text: "Reviewer agent-reviewer finished." }, timestamp: "2026-10-03T10:06:00.000Z" }]);
    expect((await later.tools.worker.call("bm_report", stopped, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(later.home).list(WS)[0]!.text).not.toContain(CUT_NOTE_LINE);
  });

  it("bm_tell_worker with peerLink attaches an open link to a bound Worker's request and carries the peer: block and rules", async () => {
    const { home, fake, tools } = setup();
    register(home);
    askOfUs(home, ANSWERED, false);
    bindAgent(createBindingStore(home), WORKER, { role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER });
    const result = await tools.manager.call("bm_tell_worker", { requestId: REQ, text: "The frontend needs this too.", peerLink: ANSWERED, about: "current" }, MANAGER_CALLER);
    expect(parsed(result)).toEqual({ workerId: WORKER, delivery: "sent" });
    const block = [`peer: ${ANSWERED} from project "${FRONT}" (${FRONT}), request ${REQ_FRONT}`, "peerAsk:", "> Add GET /api/orders."];
    const [record] = createOutbox(home).list(WS);
    expect(fake.sends[0]!.text).toBe([`BM-DELIVERY message ${record!.id}`, `Continue ${REQ}.`, "The frontend needs this too.", ...block, "", ...PEER_RULES].join("\n"));
    expect(peerBlockOf([record!.text])).toEqual([...block, ...PEER_RULES]);
    expect(link(home, ANSWERED)).toMatchObject({ state: "taken", to: { requestId: REQ, workerId: WORKER, managerId: MANAGER } });
  });

  it("bm_tell_worker refuses a link that is not open or not this project's, and an unbound Worker, sending nothing", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const tell = { requestId: REQ, text: "Take this on.", peerLink: ANSWERED, about: "current" };
    const notOpen = `link ${ANSWERED} is not an open ask of this project (bm_peers lists them). Nothing was sent.`;
    expect(await tools.manager.call("bm_tell_worker", tell, MANAGER_CALLER)).toEqual({ ok: false, text: notOpen });
    askOfUs(home, ANSWERED, false);
    // The Worker has no binding: it could not answer the link.
    expect(await tools.manager.call("bm_tell_worker", tell, MANAGER_CALLER)).toEqual({
      ok: false,
      text: `a Worker without paseo-bm's tools could neither report forPeer nor answer link ${ANSWERED}; answer it with bm_peer_reply. Nothing was sent.`,
    });
    createPeerLinkStore(home).closeLink(ANSWERED, "answerer");
    bindAgent(createBindingStore(home), WORKER, { role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER });
    expect(await tools.manager.call("bm_tell_worker", tell, MANAGER_CALLER)).toEqual({ ok: false, text: notOpen });
    createPeerLinkStore(home, { newId: () => "peer-0000000000f1" }).createLink({ kind: "work", from: { workspaceId: FRONT, requestId: REQ_FRONT, agentId: ASKER.id, role: "worker" }, to: { workspaceId: "wks_back", managerId: null }, text: "x" });
    expect((await tools.manager.call("bm_tell_worker", { ...tell, peerLink: "peer-0000000000f1" }, MANAGER_CALLER)).text).toBe(notOpen.replace(ANSWERED, "peer-0000000000f1"));
    expect(fake.sends).toEqual([]);
    expect(existsSync(join(home, OUTBOX_DIR_NAME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A supervised line (ADR-045 decision 2).
// ---------------------------------------------------------------------------

describe("a line costs the Main no turn until a stop or its end (ADR-045 decision 2)", () => {
  const STEPS = ["req-20261003T120000Z", "req-20261003T130000Z", "req-20261003T140000Z"];
  const STEP = (n: number) => ({ title: `Step ${n}`, request: `Do step ${n}.`, acceptance: [`Step ${n} works`] });

  function line(requests = STEPS) {
    const world = setup();
    const { home, fake, tools } = world;
    const made = createMissionStore(home).create({ code: "SHOP", name: "Shop", goal: "Orders.", repos: [WS], createdBy: "owner", mainId: MANAGER });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const missionId = made.mission.missionId;
    const proposed = proposeLine(home, missionId, { lineId: "line-1", by: MANAGER, steps: requests.map((_id, index) => STEP(index + 1)) }, T0);
    if (!proposed.ok) throw new Error(proposed.reason);
    applyLine(home, missionId, "line-1");
    let started = 0;
    const open = (requestId: string) => {
      createRequestRegistry(home, { backfill: () => [] }).register(WS, requestId, { source: "tool", managerId: MANAGER, workerId: WORKER });
      createMissionRoster(home).add(missionId, { requestId, workspaceId: WS, topic: "step", workerId: WORKER });
    };
    /** A continuation of `of`, as `openContinuation` leaves it. */
    const continueWith = (of: string): string => {
      const registry = createRequestRegistry(home, { backfill: () => [] });
      const { requestId } = registry.generate(WS, { managerId: MANAGER, missionId, continuationOf: of, chainRootId: of });
      registry.addWorker(WS, requestId, WORKER);
      createMissionRoster(home).add(missionId, { requestId, workspaceId: WS, topic: "step", workerId: WORKER, continuationOf: of });
      registry.noteContinuedBy(WS, of, requestId, { reason: "follow-up", figure: "a follow-up after finished", at: T0.toISOString() });
      return requestId;
    };
    /** The pass's notices to the Main: each is one turn it costs. */
    const notices: string[] = [];
    const noticeQueue = {
      enqueue: async () => "sent" as const,
      enqueueBatch: async (_target: string, _batch: unknown, items: Array<{ line: string }>) => {
        notices.push(...items.map((item) => item.line));
        return items.map(() => "sent" as const);
      },
    };
    const pass = () =>
      startHeldRequests(home, {
        create: async () => {
          const requestId = requests[started]!;
          started += 1;
          open(requestId);
          return { ok: true, text: JSON.stringify({ requestId, workerId: WORKER }) };
        },
        queue: noticeQueue as never,
        paseo: fake.paseo as never,
        now: () => T0,
        log: () => {},
      });
    const finished = (requestId: string, extra: Record<string, unknown> = {}) => tools.worker.call("bm_report", { ...REPORT, requestId, phase: "finished", forNextStep: { summary: "What the step did." }, ...extra }, { ...WORKER_CALLER, requestId });
    const finishedBare = (requestId: string, extra: Record<string, unknown> = {}) => tools.worker.call("bm_report", { ...REPORT, requestId, phase: "finished", ...extra }, { ...WORKER_CALLER, requestId });
    return { ...world, missionId, entries: proposed.entries, notices, pass, continueWith, finished, finishedBare };
  }
  const sent = (fake: { sends: Array<{ text: string }> }) => fake.sends.map((entry) => entry.text);
  /** A file change no placement holds: the gate fails on it. */
  const FAILING = { filesChanged: ["src/a.ts"], runtimeProof: PROOF };

  it("a healthy three-step line costs no turn until the last finished, which opens with the notes and says the line is complete", async () => {
    const { home, fake, missionId, notices, pass, finished } = line();
    await pass();
    for (const [index, requestId] of STEPS.entries()) {
      expect(heldRequestsOf(home, missionId)[index]).toMatchObject({ state: "started", startedAs: requestId });
      expect(fake.sends).toHaveLength(0);
      expect(notices).toEqual([]);
      const answer = await finished(requestId);
      expect(parsed(answer).delivery).toBe(index === 2 ? "sent" : "no-turn");
      // The registry, roster and journal record each step as before.
      expect(createRequestRegistry(home, { backfill: () => [] }).get(WS, requestId)).toMatchObject({ finishGate: { passed: true } });
      expect(createMissionRoster(home).get(missionId, requestId)?.state).toBe("finished");
      expect(createMissionStore(home).journal(missionId).some((entry) => entry.text.startsWith(`${requestId} finished`))).toBe(true);
      await pass();
    }
    expect(fake.sends).toHaveLength(1);
    const [delivery] = sent(fake);
    expect(delivery).toContain("line complete: step 3 of 3");
    expect(delivery).toContain(`noted: report`);
    expect(delivery).toContain("noted: message");
    expect(delivery).toContain("Step 2 of 3");
  });

  it("the owner's switch off: a step's finished starts a Main turn as before, and beads-done stays a note", async () => {
    const { home, fake, tools, pass, finished } = line();
    createCoordinationStore(home).set({ key: "line.supervised", value: false });
    await pass();
    expect(parsed(await tools.worker.call("bm_report", { ...REPORT, requestId: STEPS[0]!, phase: "beads-done" }, { ...WORKER_CALLER, requestId: STEPS[0]! })).delivery).toBe("no-turn");
    expect(fake.sends).toHaveLength(0);
    expect(parsed(await finished(STEPS[0]!))).toMatchObject({ delivery: "sent" });
    expect(fake.sends).toHaveLength(1);
    // The gate is still recorded with the switch off.
    expect(createRequestRegistry(home, { backfill: () => [] }).get(WS, STEPS[0]!)).toMatchObject({ finishGate: { passed: true } });
  });

  it("a failed middle step costs exactly one Main turn, the stop notice, opened by the notes; its report is a note", async () => {
    const { home, fake, missionId, entries, notices, pass, finished } = line();
    await pass();
    expect(parsed(await finished(STEPS[0]!))).toMatchObject({ delivery: "no-turn" });
    await pass();
    expect(parsed(await finished(STEPS[1]!, FAILING))).toMatchObject({ delivery: "no-turn" });
    expect(createRequestRegistry(home, { backfill: () => [] }).get(WS, STEPS[1]!)?.finishGate?.passed).toBe(false);
    for (let n = 0; n < 4; n += 1) await pass();
    expect(heldRequestsOf(home, missionId).find((entry) => entry.holdId === entries[2]!.holdId)!.state).toBe("waiting-stopped");
    expect(fake.sends).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("noted: report");
    expect(notices[0]).toContain("did not pass its finish gate");
    expect(notices[0]).toContain("bm_hold_release");
  });

  it("a continuation that fails again gets its own notice, so the Main is never left silent while the line stays stopped", async () => {
    const { fake, tick, missionId, entries, home, notices, pass, continueWith, finished } = line(STEPS.slice(0, 2));
    await pass();
    await finished(STEPS[0]!, FAILING);
    await pass();
    expect(notices).toHaveLength(1);

    const again = continueWith(STEPS[0]!);
    await pass();
    expect(heldRequestsOf(home, missionId).find((entry) => entry.holdId === entries[1]!.holdId)!.state).toBe("held");
    expect(notices).toHaveLength(1);
    tick(60_000);
    expect(parsed(await finished(again, FAILING))).toMatchObject({ delivery: "no-turn" });
    await pass();
    await pass();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain(`waits for ${again}`);
    expect(fake.sends).toHaveLength(0);
  });

  it("a last step whose gate failed is delivered with its failure and without line complete", async () => {
    const { fake, missionId, home, pass, finished } = line(STEPS.slice(0, 1));
    await pass();
    const answer = await finished(STEPS[0]!, FAILING);
    expect(parsed(answer).delivery).toBe("sent");
    expect(createMissionRoster(home).get(missionId, STEPS[0]!)?.state).toBe("finished");
    expect(sent(fake)[0]).toContain("finish gate");
    expect(sent(fake)[0]).not.toContain("line complete");
  });

  it("a step with a next step is refused without forNextStep, in one line and writing nothing; it is stored, masked and with its branch", async () => {
    const { home, fake, pass, finished, finishedBare } = line(STEPS.slice(0, 2));
    await pass();
    const refusal = await finishedBare(STEPS[0]!);
    expect(refusal.ok).toBe(false);
    expect(refusal.text).toBe("The call was refused. Fix these and call bm_report again:\n- input.forNextStep: step 1 of 2 has a next step: write what its Worker needs (summary, and contract or remaining when there are any)");
    expect(createRequestRegistry(home, { backfill: () => [] }).get(WS, STEPS[0]!)?.finishGate).toBeUndefined();
    expect(fake.sends).toHaveLength(0);

    expect((await finished(STEPS[0]!, { forNextStep: { summary: "Built the API.", contract: "GET /orders", remaining: "Pagination." } })).ok).toBe(true);
    expect(createRequestRegistry(home, { backfill: () => [] }).get(WS, STEPS[0]!)?.forNextStep).toEqual({ summary: "Built the API.", contract: "GET /orders", remaining: "Pagination." });
  });

  it("the last step and a size finish need no forNextStep; only finished may carry it", async () => {
    const last = line(STEPS.slice(0, 1));
    await last.pass();
    expect((await last.finishedBare(STEPS[0]!)).ok).toBe(true);

    const { home, pass, finishedBare, tools } = line(STEPS.slice(0, 2));
    await pass();
    createRequestRegistry(home, { backfill: () => [] }).noteRolloverAsked(WS, STEPS[0]!, { level: "soft", figure: "context 180k", at: T0.toISOString() });
    expect((await finishedBare(STEPS[0]!, { remaining: ["Finish the API."] })).ok).toBe(true);

    const early = await tools.worker.call("bm_report", { ...REPORT, requestId: STEPS[1], phase: "received", forNextStep: { summary: "Too early." } }, { ...WORKER_CALLER, requestId: STEPS[1]! });
    expect(early.text).toContain("input.forNextStep: only a finished report says what the next step needs; leave it out");
  });

  it("a blocked step is delivered as usual", async () => {
    const { fake, pass, tools } = line(STEPS.slice(0, 2));
    await pass();
    const blocked = await tools.worker.call("bm_report", { ...REPORT, requestId: STEPS[0], phase: "blocked", waitingFor: "the owner's call on the API" }, { ...WORKER_CALLER, requestId: STEPS[0]! });
    expect(parsed(blocked).delivery).toBe("sent");
    expect(fake.sends).toHaveLength(1);
  });
});

describe("the runtime proof of a finished (ADR-045 decision 6)", () => {
  const CODE = { ...REPORT, phase: "finished", filesChanged: ["src/a.ts", "docs/a.md"] };
  const REFUSAL = "input.runtimeProof: a Medium or Large finished that changed code says what you ran for real and what it showed, or kind could-not-run and why";

  it("refuses a code-changing Medium or Large finished without it, in one line, storing nothing", async () => {
    for (const level of ["Medium", "Large"]) {
      const { home, fake, tools } = setup();
      register(home);
      const refused = await tools.worker.call("bm_report", { ...CODE, tier: { level } }, WORKER_CALLER);
      expect(refused.ok).toBe(false);
      expect(refused.text.split("\n").filter((entry) => entry.startsWith("- "))).toEqual([`- ${REFUSAL}`]);
      expect(createOutbox(home).list(WS)).toEqual([]);
      expect(fake.sends).toEqual([]);
      expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ finishedAt: null });
    }
  });

  it("does not refuse a docs-only change, a Small tier or a size finish, and asks nothing of a report before finished", async () => {
    const done = async (over: Record<string, unknown>, asked?: "soft" | "now") => {
      const { home, tools } = setup();
      register(home);
      if (asked !== undefined) createRequestRegistry(home).noteRolloverAsked(WS, REQ, { level: asked, figure: "10 turns", at: T0.toISOString() });
      return (await tools.worker.call("bm_report", { ...CODE, ...over }, WORKER_CALLER)).ok;
    };
    expect(await done({ filesChanged: ["docs/a.md", "plan/b.mdx", "README.md"] })).toBe(true);
    expect(await done({ filesChanged: [] })).toBe(true);
    expect(await done({ tier: { level: "Small" } })).toBe(true);
    expect(await done({ remaining: ["bm-1: the rest"] }, "soft")).toBe(true);
    // `remaining` with no rollover notice is no size finish.
    expect(await done({ remaining: ["bm-1: the rest"] })).toBe(false);
    expect(await done({ phase: "blocked", waitingFor: "the API" })).toBe(true);
    const { home, tools } = setup();
    register(home);
    expect((await tools.worker.call("bm_report", { ...REPORT, runtimeProof: PROOF }, WORKER_CALLER)).text).toContain("input.runtimeProof: only a finished report carries a runtime proof; leave it out");
  });

  it("delivers ran and could-not-run, one line each, and notes it on the registry", async () => {
    const ran = setup();
    register(ran.home);
    expect((await ran.tools.worker.call("bm_report", { ...CODE, runtimeProof: PROOF }, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(ran.home).list(WS)[0]!.text).toContain("\nruntimeProof: ran — opened the invoices page; showed: it lists the invoices\n");
    expect(createRequestRegistry(ran.home).get(WS, REQ)?.proof).toEqual({ ...PROOF, at: T0.toISOString() });

    const flagged = setup();
    register(flagged.home);
    const blocked = { kind: "could-not-run", what: "the page needs a login this workspace does not have" };
    expect((await flagged.tools.worker.call("bm_report", { ...CODE, runtimeProof: blocked }, WORKER_CALLER)).ok).toBe(true);
    expect(createOutbox(flagged.home).list(WS)[0]!.text).toContain("\nruntimeProof: could not run — the page needs a login this workspace does not have\n");
    expect(createRequestRegistry(flagged.home).get(WS, REQ)?.proof).toEqual({ ...blocked, at: T0.toISOString() });
  });

  it("masks secret-shaped text in the delivery and on the registry", async () => {
    const { home, fake, tools } = setup();
    register(home);
    const secret = "s3cr3t-value";
    expect((await tools.worker.call("bm_report", { ...CODE, runtimeProof: { kind: "ran", what: `called the API with --token ${secret}`, showed: `200 for --password=${secret}` } }, WORKER_CALLER)).ok).toBe(true);
    const proof = createRequestRegistry(home).get(WS, REQ)?.proof;
    for (const stored of [createOutbox(home).list(WS)[0]!.text, fake.sends[0]!.text, proof!.what, proof!.showed!]) expect(stored).not.toContain(secret);
    expect(proof!.what).toContain("called the API with");
  });
});

describe("the goal restated at received (ADR-045 decision 7)", () => {
  const REFUSAL = "- input.goal: a Medium or Large received outside a step restates the goal and its acceptance (goal and acceptance), so your Main can compare them with what the owner asked";
  const received = async (over: Record<string, unknown>, world = setup()) => {
    register(world.home);
    return { ...world, answer: await world.tools.worker.call("bm_report", { ...REPORT, ...over }, WORKER_CALLER) };
  };
  /** A Paseo-free step: the request the plugin started for step `n` of a two-step line. */
  function asStep(home: string) {
    const made = createMissionStore(home).create({ code: "STP", name: "Steps", goal: "Ship.", repos: [WS], createdBy: "owner", mainId: MANAGER });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const missionId = made.mission.missionId;
    const proposed = proposeLine(home, missionId, { lineId: "line-1", by: MANAGER, steps: [{ title: "One", request: "One.", acceptance: ["Done"] }, { title: "Two", request: "Two.", acceptance: ["Done"] }] }, T0);
    if (!proposed.ok) throw new Error(proposed.reason);
    applyLine(home, missionId, "line-1");
    return { missionId };
  }
  const startStep = async (home: string, missionId: string) => {
    createMissionRoster(home).add(missionId, { requestId: REQ, workspaceId: WS, topic: "One", workerId: WORKER });
    await startHeldRequests(home, { create: async () => ({ ok: true, text: JSON.stringify({ requestId: REQ, workerId: WORKER }) }), queue: { enqueue: async () => "sent", enqueueBatch: async (_target: string, _batch: unknown, items: unknown[]) => items.map(() => "sent") } as never, log: () => {} });
  };

  it("refuses a Medium or Large received outside a step that lacks either, in one line, storing nothing", async () => {
    for (const level of ["Medium", "Large"]) {
      for (const given of [{}, { goal: RESTATED.goal }, { acceptance: RESTATED.acceptance }]) {
        const { home, fake, answer } = await received({ tier: { level }, ...given });
        expect(answer.ok).toBe(false);
        expect(answer.text.split("\n").filter((entry) => entry.startsWith("- "))).toEqual([REFUSAL]);
        expect(createOutbox(home).list(WS)).toEqual([]);
        expect(fake.sends).toEqual([]);
      }
    }
  });

  it("delivers with both lines shown, as a turn of the Main, and takes them on no other phase", async () => {
    const { home, fake, answer } = await received(RESTATED);
    expect(parsed(answer).delivery).toBe("sent");
    const delivered = fake.sends[0]!.text;
    expect(delivered.split("\n")).toContain("goal: The invoices page lists every invoice.");
    expect(delivered.split("\n")).toContain("acceptance: The page lists the invoices; An empty list reads as empty");
    expect(checkBlocks(createOutbox(home).list(WS)[0]!.text).flatMap((block) => block.issues)).toEqual([]);
    const wrong = setup();
    register(wrong.home);
    expect((await wrong.tools.worker.call("bm_report", { ...REPORT, phase: "blocked", waitingFor: "x", ...RESTATED }, WORKER_CALLER)).text).toContain("input.goal: only a received report restates the goal; leave it out");
  });

  it("a Small request needs neither: its received starts no Main turn, leaves a note, and the registry and the roster record it", async () => {
    const world = setup();
    const { missionId } = asStep(world.home);
    createMissionRoster(world.home).add(missionId, { requestId: REQ, workspaceId: WS, topic: "Small", workerId: WORKER });
    const { home, fake, answer } = await received({ tier: { level: "Small" } }, world);
    expect(parsed(answer).delivery).toBe("no-turn");
    expect(fake.sends).toEqual([]);
    expect(createOutbox(home).list(WS)[0]).toMatchObject({ kind: "report", from: WORKER, state: "delivered", reason: "no-turn" });
    expect(createRequestRegistry(home).get(WS, REQ)).toMatchObject({ tier: "Small", finishedAt: null });
    expect(createMissionRoster(home).get(missionId, REQ)).toMatchObject({ state: "active" });
  });

  it("the owner's switch off: a Small received and a step's received start a Main turn as before; beads-done stays a note", async () => {
    const small = setup();
    createCoordinationStore(small.home).set({ key: "line.supervised", value: false });
    expect(parsed((await received({ tier: { level: "Small" } }, small)).answer).delivery).toBe("sent");
    expect(small.fake.sends).toHaveLength(1);

    const world = setup();
    register(world.home);
    const { missionId } = asStep(world.home);
    await startStep(world.home, missionId);
    createCoordinationStore(world.home).set({ key: "line.supervised", value: false });
    expect(parsed(await world.tools.worker.call("bm_report", { ...REPORT, tier: { level: "Large" } }, WORKER_CALLER)).delivery).toBe("sent");
    expect(world.fake.sends).toHaveLength(1);
    expect(parsed(await world.tools.worker.call("bm_report", { ...REPORT, phase: "beads-done", tier: { level: "Large" } }, WORKER_CALLER)).delivery).toBe("no-turn");
    expect(world.fake.sends).toHaveLength(1);
  });

  it("a step's received needs neither at any tier: no Main turn, a note, recorded", async () => {
    const world = setup();
    register(world.home);
    const { missionId } = asStep(world.home);
    await startStep(world.home, missionId);
    expect(heldRequestsOf(world.home, missionId)[0]).toMatchObject({ state: "started", startedAs: REQ });
    const answer = await world.tools.worker.call("bm_report", { ...REPORT, tier: { level: "Large" } }, WORKER_CALLER);
    expect(parsed(answer).delivery).toBe("no-turn");
    expect(world.fake.sends).toEqual([]);
    const note = createOutbox(world.home).list(WS).find((record) => record.kind === "report");
    expect(note).toMatchObject({ from: WORKER, state: "delivered", reason: "no-turn" });
    expect(createRequestRegistry(world.home).get(WS, REQ)).toMatchObject({ tier: "Large" });
    expect(createMissionRoster(world.home).get(missionId, REQ)).toMatchObject({ state: "active" });
  });

  it("a tier raised after a Small received is reported at finished as usual", async () => {
    const world = setup();
    register(world.home);
    await world.tools.worker.call("bm_report", { ...REPORT, tier: { level: "Small" } }, WORKER_CALLER);
    expect(world.fake.sends).toEqual([]);
    const finished = await world.tools.worker.call("bm_report", { ...REPORT, phase: "finished", tier: { level: "Medium", changedFrom: "Small", reason: "the format is consumed" }, filesChanged: ["docs/a.md"] }, WORKER_CALLER);
    expect(parsed(finished).delivery).toBe("sent");
    expect(world.fake.sends[0]!.text).toContain("tier: Medium (changed: from Small, the format is consumed)");
    expect(createRequestRegistry(world.home).get(WS, REQ)).toMatchObject({ tier: "Medium" });
  });
});
