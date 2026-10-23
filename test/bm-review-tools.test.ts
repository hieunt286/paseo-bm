import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PENDING_CALLER_MESSAGE, PENDING_TTL_MS, clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { settleCreatedAgent } from "../plugin/server/creation-settle";
import { answer, binderOf, withAgentTools } from "../plugin/server/agent-tools";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE } from "../plugin/server/manager";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { workspaceTracesOf } from "../plugin/server/request-trace";
import {
  CONVERGENCE_STOP_TAIL,
  NO_REPORT_YET_MESSAGE,
  REVIEW_NOT_BOUND_MESSAGE,
  applyReviewCapAnswer,
  batchResultsOf,
  convergenceRefusalOf,
  createReviewTools,
  milestoneRefusalOf,
  overCapAfterOne,
  blockingFindingsOf,
  previousFindingsOf,
  rereviewBriefOf,
  reviewCapRefusalOf,
  reviewCapSpentOf,
  reviewCapStateOf,
  reviewerBriefOf,
  ruleReviewGrantOf,
  stagesRefusalOf,
} from "../plugin/server/review-tools";
import { overrunOf } from "../plugin/server/review-budget";
import { createDecisionStore } from "../plugin/server/decision-store";
import { resolveAtOpen } from "../plugin/server/policy-resolve";
import { REVIEW_CAP_SUBJECT, whyIneligible } from "../plugin/shared/question-subjects";
import { flagsOf } from "../plugin/shared/orchestrator-rules";
import type { RuleReviewGrant } from "../plugin/shared/rule-input";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { reviewCallsOf, type ReconstructedTrace } from "../plugin/server/traces";
import { reviewMilestoneOf, toolFacesFor } from "../plugin/shared/bm-tools";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { reviewCallIdOf, reviewerBriefLineOf } from "../plugin/shared/notices";
import { originOf } from "../plugin/shared/message-origin";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeCreateRequest } from "./helpers/fake-paseo";
import { msg, turn } from "./fixtures/orchestrator-traces";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { WORKER_CALLER } from "./helpers/bindings";

/**
 * The enforced review budget (design §16.6, §16.8; ADR-027 decisions 2 and
 * 10): bm_create_reviewer and bm_rereview for a bound Worker, the one counter
 * they share with the Dashboard, every refusal, and the review-budget grant.
 * Temporary data folders, the shared fake daemon and a notice queue of the
 * test's own.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const FOLDER = "/work/invoice-app";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const T0 = new Date("2026-10-03T10:05:00.000Z");

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  forgetModes();
  removeDataFolders();
});


interface DaemonOptions {
  toolsOff?: boolean;
  profile?: boolean;
  refuse?: string;
  /** Paseo refuses this creation with the error returned (null: it creates the agent). */
  refuseNow?: () => string | null;
  /** Paseo answers with this error after the hook kept the token (null: it creates the agent). */
  refuseAfterHook?: () => string | null;
  store?: BindingStore;
  onSend?: (message: { id: string; text: string }) => void;
}

function daemon(options: DaemonOptions = {}) {
  return fakePaseo({
    agents: [
      { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, cwd: FOLDER, labels: { "bm.role": "manager" } },
      { id: WORKER, provider: "bm-worker/claude-opus-5", status: "running", workspaceId: WS, cwd: FOLDER, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
    ],
    workspaces: [{ id: WS, directory: FOLDER }],
    config: {
      agentProfiles: options.profile === false ? [] : [{ id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6" }],
      providers: { "bm-reviewer": { extends: "codex" }, "bm-worker": { extends: "claude" } },
      mcp: { injectIntoAgents: options.toolsOff !== true },
    },
    providers: { modes: { "bm-reviewer": [{ id: "auto", colorTier: "safe" }, { id: "full-access", colorTier: "dangerous" }] } },
    created: (request: FakeCreateRequest) => {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      const now = options.refuseNow?.() ?? null;
      if (now !== null) throw new Error(now);
      if (options.store !== undefined) {
        applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: options.store }, "codex");
      }
      const late = options.refuseAfterHook?.() ?? null;
      if (late !== null) throw new Error(late);
      return {};
    },
    ...(options.onSend === undefined ? {} : { onSend: options.onSend }),
  });
}

/** A request as bm_create_worker and the Worker's received report leave it: registered, with its tier. */
function register(home: string, tier: "Small" | "Medium" | "Large" | null = "Small"): void {
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
  if (tier !== null) registry.noteReport(WS, REQ, { tier, phase: "received", at: T0.toISOString() });
}

function setup(options: DaemonOptions & { tier?: "Small" | "Medium" | "Large" | null; paseo?: boolean } = {}) {
  const home = dataFolder();
  const store = createBindingStore(home);
  const fake = daemon({ ...options, store });
  register(home, options.tier === undefined ? "Small" : options.tier);
  const queue = createNoticeQueue({ log: () => {} });
  const logs: string[] = [];
  /** The decisions the tools opened, as the event bus receives them. */
  const opened: Decision[] = [];
  let clock = T0;
  let n = 0;
  const tools = createReviewTools({
    onOpened: (decisions) => void opened.push(...decisions),
    binder: () => binderOf(ROLE_URL, store, (line) => logs.push(line)),
    paseo: () => (options.paseo === false ? null : fake.paseo),
    home: () => home,
    log: (line) => logs.push(line),
    now: () => clock,
    queue,
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
  });
  const tick = (ms = 60_000) => {
    clock = new Date(clock.getTime() + ms);
  };
  const location = { tracesDir: join(home, "traces") };
  /** The Dashboard's count: the request's trace as `workspaceTracesOf` rebuilds it for `traces.list`. */
  const dashboard = async (): Promise<number | null> => {
    const { traces } = await workspaceTracesOf({ location, paseo: fake.paseo as never, home }, WS);
    return traces.find((trace) => trace.requestId === REQ)?.reviewCalls ?? null;
  };
  /** One recorded turn of an agent, at the clock. */
  const record = async (agentId: string, role: "manager" | "worker" | "reviewer", text: string | null, extra: Record<string, unknown> = {}) => {
    const at = clock.toISOString();
    await appendRecord(location, turn({ agentId, role, workspaceId: WS, requestId: REQ, at, endedAt: at, turnId: `t-${at}`, sent: text === null ? [] : [msg(agentId, at, text, "agent")], ...extra }));
  };
  /**
   * The verdict of batch `batchId` reaching its Worker, at the clock, as
   * bm_review records it on the batch (delivery line design §5.2): `pass` at
   * no blocking finding, else `changes-required`; null is a no-verdict.
   */
  let results = 0;
  const verdict = (batchId: string, blocking: number | null, verdict = blocking === null ? "no-verdict" : blocking === 0 ? "pass" : "changes-required") => {
    results += 1;
    const recordId = `out-r${results.toString(16).padStart(11, "0")}`;
    expect(createRequestRegistry(home).addReviewResult(WS, REQ, batchId, { at: clock.toISOString(), recordId, verdict, blocking })).toBe("added");
    // The Reviewer is idle again once it answered.
    for (const agent of fake.agents) if (agent.labels?.["bm.batchId"] === batchId) agent.status = "idle";
  };
  return { home, store, fake, queue, logs, tools, tick, dashboard, record, location, verdict, opened, clock: () => clock };
}

const INPUT = { batchId: "b1", stages: ["implementation"], scope: "src/date.ts and its test, commit abc123.", checks: "npm test: 412 passed." };
const parsed = (result: { ok: boolean; text: string }) => JSON.parse(result.text) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// The lists.
// ---------------------------------------------------------------------------

describe("the bound Worker's list (design §16.6)", () => {
  it("lists and pre-approves bm_create_reviewer and bm_rereview after bm_questions; an unbound Worker never lists them", () => {
    const names = ["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_peers", "bm_ask_project", "bm_peer_reply", "bm_memory", "bm_reply"];
    expect(toolFacesFor("worker", true).map((face) => face.name)).toEqual(names);
    expect(toolFacesFor("worker").map((face) => face.name)).toEqual(["bm_report", "bm_reply"]);
    const empty: { toolPolicy?: { preapproved?: Array<{ tool: string }> } } = {};
    expect(withAgentTools(empty, "worker", "http://127.0.0.1:1/mcp/worker/x", true)?.toolPolicy?.preapproved?.map((grant) => grant.tool)).toEqual(names);
    expect(answer("worker", { jsonrpc: "2.0", id: 1, method: "tools/list" })).toMatchObject({ result: { tools: [{ name: "bm_report" }, { name: "bm_reply" }] } });
  });
});

// ---------------------------------------------------------------------------
// bm_create_reviewer.
// ---------------------------------------------------------------------------

describe("bm_create_reviewer (design §16.6)", () => {
  it("creates the batch's Reviewer — labels, parent, mode, a bound token — with its BM-BRIEF prompt, and records the call before it creates", async () => {
    const { home, store, fake, tools } = setup();
    const result = await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect(result.ok).toBe(true);
    expect(parsed(result)).toEqual({ reviewerId: "created-1", batchId: "b1", reviewCalls: "1 of 3" });

    const { options } = fake.creates[0]!;
    expect(options).toMatchObject({
      config: { provider: "bm-reviewer/gpt-5.6", modeId: "auto" },
      cwd: FOLDER,
      parent: WORKER,
      labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "bm.version": PLUGIN_VERSION },
    });
    const prompt = options.prompt!;
    expect(prompt.split("\n")[0]).toBe(reviewerBriefLineOf(REQ, "b1", "out-000000000001"));
    expect(prompt).toContain("stages: implementation");
    expect(prompt).toContain("src/date.ts and its test, commit abc123.");
    expect(prompt).toContain("npm test: 412 passed.");
    expect(reviewCallIdOf(prompt)).toBe("out-000000000001");
    expect(originOf({ text: prompt, clientMessageId: "sdk" })).not.toBe("user");

    // The binding: a Reviewer of the same request and batch, under its Worker, with the tools of ship point C.
    expect(store.bindingOfAgent("created-1")).toMatchObject({ role: "reviewer", state: "bound", requestId: REQ, batchId: "b1", parentId: WORKER });
    // The registry: the batch, its brief, its one call — the Reviewer named on it, so it is the plugin's own.
    const batch = createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!;
    expect(batch).toMatchObject({ batchId: "b1", reviewerIds: ["created-1"], calls: [{ callId: "out-000000000001", kind: "create", reviewerId: "created-1" }] });
    expect(prompt.endsWith(batch.brief)).toBe(true);
    expect(batch.brief).not.toMatch(/criteria/i);
  });

  it("refuses an unbound caller, a pending binding, no Paseo, agent tools off, no report yet — creating nothing", async () => {
    const off = setup({ toolsOff: true });
    // The agent's own line (tell the owner, stop), never the fallback Switch's wording.
    expect(await off.tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).toEqual({ ok: false, text: AGENT_TOOLS_OFF_TOOL_MESSAGE });
    expect(AGENT_TOOLS_OFF_TOOL_MESSAGE).toMatch(/^paseo-bm cannot create agents while Paseo's agent tools are off; .*Tell the owner in one line and stop\.$/);
    expect(off.fake.creates).toEqual([]);

    const { tools, fake, home } = setup();
    expect(await tools.call("bm_create_reviewer", INPUT, null)).toEqual({ ok: false, text: REVIEW_NOT_BOUND_MESSAGE });
    expect(await tools.call("bm_create_reviewer", INPUT, { ...WORKER_CALLER, role: "manager" })).toEqual({ ok: false, text: REVIEW_NOT_BOUND_MESSAGE });
    expect(await tools.call("bm_create_reviewer", INPUT, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect((await setup({ paseo: false }).tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(false);
    const fresh = setup({ tier: null });
    expect(await fresh.tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).toEqual({ ok: false, text: NO_REPORT_YET_MESSAGE });
    expect(fresh.fake.creates).toEqual([]);
    // An implementation review without its checks, and a stage named twice.
    const bad = await tools.call("bm_create_reviewer", { ...INPUT, checks: undefined, stages: ["implementation", "implementation"] }, WORKER_CALLER);
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("input.checks");
    expect(bad.text).toContain("input.stages");
    expect(fake.creates).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toEqual([]);
  });

  it("refuses a batch that already has a Reviewer: use bm_rereview", async () => {
    const { tools, fake } = setup();
    expect((await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(true);
    const again = await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect(again.ok).toBe(false);
    expect(again.text).toContain("use bm_rereview");
    expect(fake.creates).toHaveLength(1);
  });

  it("a creation Paseo refuses removes its call: the batch is free again and nothing was counted", async () => {
    const { tools, fake, home, store } = setup({ refuse: "cannot inherit mode" });
    const result = await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect(result).toEqual({ ok: false, text: "Paseo refused to create the Reviewer: cannot inherit mode. Nothing was created." });
    expect(fake.creates).toHaveLength(1);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it("Paseo's error after the hook kept the token: the call is kept for agent.created, which names its Reviewer; the token never reaches the Worker", async () => {
    let late: string | null = `socket hang up at ${ROLE_URL("reviewer")}/${"e".repeat(64)}`;
    const { tools, home, store, logs } = setup({ refuseAfterHook: () => late });
    const result = await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect(result.ok).toBe(false);
    expect(result.text).toBe(
      `Paseo answered with an error after it may have created the Reviewer: socket hang up at ${ROLE_URL("reviewer")}/…. If the Reviewer appears, its review reaches you as usual; if not, batch b1 is free again in 10 minutes, or open a new batch.`,
    );
    expect(logs.join("\n")).not.toContain("e".repeat(64));
    // The call stays, with no Reviewer yet; the binding stays pending (attached).
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toMatchObject([{ batchId: "b1", reviewerIds: [], calls: [{ callId: "out-000000000001", kind: "create", reviewerId: "" }] }]);
    expect(store.list()).toMatchObject([{ role: "reviewer", state: "pending", batchId: "b1", parentId: WORKER }]);
    // Meanwhile the batch is neither free nor re-reviewable.
    late = null;
    expect((await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).text).toContain("The Reviewer of batch b1 is still being created");
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER)).text).toContain("The Reviewer of batch b1 is still being created");

    // agent.created of the Reviewer Paseo did create: its binding is bound and the registry names it.
    const seen = fakePaseo({ agents: [{ id: "rev-late", provider: "bm-reviewer/gpt-5.6", workspaceId: WS, labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "paseo.parent-agent-id": WORKER } }] });
    await settleCreatedAgent({ id: "rev-late", provider: "bm-reviewer/gpt-5.6", parentAgentId: WORKER, workspaceId: WS }, seen.paseo, { home, bindings: store, log: () => {} });
    expect(store.bindingOfAgent("rev-late")).toMatchObject({ state: "bound", role: "reviewer", batchId: "b1" });
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]).toMatchObject({ reviewerIds: ["rev-late"], calls: [{ callId: "out-000000000001", reviewerId: "rev-late" }] });
  });

  it("a create call still without a Reviewer after the pending time is cleared: the batch is free again", async () => {
    let late: string | null = "socket hang up";
    const { tools, home, fake, tick } = setup({ refuseAfterHook: () => late });
    expect((await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(false);
    late = null;
    tick(PENDING_TTL_MS + 1_000);
    // bm_rereview of that batch: cleared, so there is no batch to re-review.
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER)).text).toContain("knows no batch b1");
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toEqual([]);
    // And bm_create_reviewer opens it again, once.
    const again = await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect(again.ok).toBe(true);
    expect(fake.creates).toHaveLength(2);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toMatchObject([{ batchId: "b1", reviewerIds: [parsed(again)["reviewerId"]], calls: [{ kind: "create" }] }]);
  });

  it("no bm-reviewer profile: refused, nothing created", async () => {
    const { tools, fake } = setup({ profile: false });
    const result = await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('no "bm-reviewer" profile');
    expect(fake.creates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bm_rereview.
// ---------------------------------------------------------------------------

describe("bm_rereview (design §16.6; delivery line design §17.2)", () => {
  it("creates a fresh Reviewer for the batch with the re-review brief, records the call before it creates, and leaves the earlier Reviewer idle", async () => {
    const { tools, fake, home, store, verdict } = setup({ tier: "Medium" });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    verdict("b1", 1);
    const result = await tools.call("bm_rereview", { batchId: "b1", fixed: "F1: the date now uses the owner's locale." }, WORKER_CALLER);
    expect(parsed(result)).toEqual({ reviewerId: "created-2", reviewCalls: "2 of 3" });
    // Nothing is sent to the first Reviewer, and no outbox record is made: the brief is the new Reviewer's first prompt.
    expect(fake.sends).toEqual([]);
    expect(createOutbox(home).list(WS)).toEqual([]);
    expect(fake.byId("created-1")).toMatchObject({ status: "idle" });
    expect(fake.byId("created-1")!.archivedAt ?? null).toBeNull();
    const { options } = fake.creates[1]!;
    expect(options).toMatchObject({
      config: { provider: "bm-reviewer/gpt-5.6", modeId: "auto" },
      cwd: FOLDER,
      parent: WORKER,
      labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "bm.version": PLUGIN_VERSION },
    });
    const prompt = options.prompt!;
    expect(prompt.split("\n")[0]).toBe(reviewerBriefLineOf(REQ, "b1", "out-000000000002"));
    expect(reviewCallIdOf(prompt)).toBe("out-000000000002");
    // The folder has no git: the brief falls back to the Worker's account.
    expect(prompt.split("\n").slice(1)).toEqual(
      rereviewBriefOf({ requestId: REQ, batchId: "b1", findings: previousFindingsOf([{ at: "", recordId: "out-r00000000001", verdict: "changes-required", blocking: 1 }], []), fixed: "F1: the date now uses the owner's locale.", fixes: null }).split("\n"),
    );
    expect(store.bindingOfAgent("created-2")).toMatchObject({ role: "reviewer", state: "bound", requestId: REQ, batchId: "b1", parentId: WORKER });
    const batch = createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!;
    expect(batch.reviewerIds).toEqual(["created-1", "created-2"]);
    expect(batch.calls.map((call) => [call.kind, call.callId, call.reviewerId, call.tree])).toEqual([
      ["create", "out-000000000001", "created-1", undefined],
      ["rereview", "out-000000000002", "created-2", undefined],
    ]);
    expect(batch.milestone).toBe("finished");
  });

  it("refuses an unknown batch, a re-review before the last one's verdict, a pending binding and agent tools off — creating nothing; an archived earlier Reviewer is no reason to refuse", async () => {
    const { tools, fake, tick, verdict } = setup({ tier: "Large" });
    const unknown = await tools.call("bm_rereview", { batchId: "b7", fixed: "x" }, WORKER_CALLER);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("knows no batch b7");
    expect(await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });

    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    // No verdict yet on the first review: nothing to re-review.
    expect(await tools.call("bm_rereview", { batchId: "b1", fixed: "too early" }, WORKER_CALLER)).toEqual({
      ok: false,
      text: "Batch b1 has no verdict on its last review yet: wait for it to reach you. Nothing was sent.",
    });
    verdict("b1", 2);
    tick();
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "first fix" }, WORKER_CALLER)).ok).toBe(true);
    tick();
    // The re-review has no verdict yet either.
    const second = await tools.call("bm_rereview", { batchId: "b1", fixed: "second fix" }, WORKER_CALLER);
    expect(second.ok).toBe(false);
    expect(second.text).toContain("has no verdict on its last review yet");
    expect(fake.creates).toHaveLength(2);

    await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER);
    fake.byId("created-3")!.archivedAt = T0.toISOString();
    verdict("b2", 1);
    tick();
    const archived = await tools.call("bm_rereview", { batchId: "b2", fixed: "x" }, WORKER_CALLER);
    expect(parsed(archived)).toMatchObject({ reviewerId: "created-4" });
    expect(fake.sends).toEqual([]);

    const off = setup({ toolsOff: true, tier: "Large" });
    expect(await off.tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER)).toEqual({ ok: false, text: AGENT_TOOLS_OFF_TOOL_MESSAGE });
  });

  it("a creation Paseo refuses removes its call: it was not counted", async () => {
    let refuse: string | null = null;
    const { tools, home, verdict } = setup({ tier: "Large", refuseNow: () => refuse });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    verdict("b1", 1);
    refuse = "cannot inherit mode";
    const result = await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER);
    expect(result).toEqual({ ok: false, text: "Paseo refused to create the Reviewer: cannot inherit mode. Nothing was created." });
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.calls.map((call) => call.kind)).toEqual(["create"]);
    // The next re-review is the second call, not the third.
    refuse = null;
    expect(parsed(await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER))["reviewCalls"]).toBe("2 of 3");
  });

  it("Paseo's error after the hook kept the token: the re-review's call is kept and agent.created names its Reviewer; one still empty after the pending time is cleared and not counted", async () => {
    let late: string | null = null;
    const { tools, home, store, verdict, tick } = setup({ tier: "Large", refuseAfterHook: () => late });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    verdict("b1", 2);
    tick();
    late = "socket hang up";
    const result = await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER);
    expect(result).toEqual({
      ok: false,
      text: "Paseo answered with an error after it may have created the Reviewer: socket hang up. If the Reviewer appears, its review reaches you as usual; if not, ask for the re-review of batch b1 again in 10 minutes, or open a new batch.",
    });
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.calls).toMatchObject([{ kind: "create" }, { kind: "rereview", callId: "out-000000000002", reviewerId: "" }]);
    const seen = fakePaseo({ agents: [{ id: "rev-late", provider: "bm-reviewer/gpt-5.6", workspaceId: WS, labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "paseo.parent-agent-id": WORKER } }] });
    await settleCreatedAgent({ id: "rev-late", provider: "bm-reviewer/gpt-5.6", parentAgentId: WORKER, workspaceId: WS }, seen.paseo, { home, bindings: store, log: () => {} });
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]).toMatchObject({ reviewerIds: ["created-1", "rev-late"], calls: [{ kind: "create" }, { kind: "rereview", reviewerId: "rev-late" }] });

    // A second such call whose Reviewer never appears is cleared after the pending time.
    verdict("b1", 1);
    tick();
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "y" }, WORKER_CALLER)).ok).toBe(false);
    late = null;
    tick(PENDING_TTL_MS + 1_000);
    const again = await tools.call("bm_rereview", { batchId: "b1", fixed: "y" }, WORKER_CALLER);
    expect(again.ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.calls.map((call) => call.kind)).toEqual(["create", "rereview", "rereview"]);
  });

  it("the previous blocking findings, verbatim from the batch's stored review record; a no-verdict is passed over", () => {
    const review = [
      "BM-REVIEW",
      `requestId: ${REQ}`,
      "batchId: b1",
      "reviewKind: first",
      "verdict: changes-required",
      "checked: src/date.ts",
      "findings:",
      "- severity: blocking",
      "  location: src/date.ts:12",
      "  reason: The locale is ignored.",
      "  suggestedFix: Pass the owner's locale.",
      "- severity: non-blocking",
      "  location: src/date.ts:30",
      "  reason: A long name.",
      "  suggestedFix: Shorten it.",
      "- severity: blocking",
      "  location: test/date.test.ts:4",
      "  reason: No test for the locale.",
      "  suggestedFix: Add one.",
      "notChecked: none",
    ].join("\n");
    const blocking = [
      "- severity: blocking\n  location: src/date.ts:12\n  reason: The locale is ignored.\n  suggestedFix: Pass the owner's locale.",
      "- severity: blocking\n  location: test/date.test.ts:4\n  reason: No test for the locale.\n  suggestedFix: Add one.",
    ];
    expect(blockingFindingsOf(review)).toEqual(blocking);
    const results = [
      { at: "1", recordId: "out-review00001", verdict: "changes-required", blocking: 2 },
      { at: "2", recordId: "out-noverdict01", verdict: "no-verdict", blocking: null },
    ];
    const records = [{ id: "out-review00001", kind: "review" as const, text: review }];
    expect(previousFindingsOf(results, records)).toBe(blocking.join("\n"));
    // A review that lists none as items is quoted whole; a record no longer stored is said so.
    expect(previousFindingsOf(results, [{ id: "out-review00001", kind: "review" as const, text: "BM-REVIEW\nverdict: changes-required\nblocking: 1\n" }])).toBe("BM-REVIEW\nverdict: changes-required\nblocking: 1");
    expect(previousFindingsOf(results, [])).toBe("(the review out-review00001 is no longer stored: the Worker's account below names the findings)");
  });
});

// ---------------------------------------------------------------------------
// Milestone batches and convergence (delivery line design §5.1, §5.2, §5.5).
// ---------------------------------------------------------------------------

describe("milestone batches (delivery line design §5.1)", () => {
  const PLAN = { batchId: "b1", stages: ["plan", "beads"], scope: "docs/plans/x.md and its bead graph." };

  it("derives the milestone when none is given, stores it on the batch, and names it and since in the brief", async () => {
    expect(reviewMilestoneOf({ stages: ["plan"] })).toBe("plan");
    expect(reviewMilestoneOf({ stages: ["beads", "documents"] })).toBe("plan");
    expect(reviewMilestoneOf({ stages: ["implementation"] })).toBe("finished");
    expect(reviewMilestoneOf({ stages: ["documents"] })).toBe("finished");
    expect(reviewMilestoneOf({ stages: ["implementation"], milestone: "wave" })).toBe("wave");

    const { tools, home, fake } = setup({ tier: "Large" });
    expect((await tools.call("bm_create_reviewer", PLAN, WORKER_CALLER)).ok).toBe(true);
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2", milestone: "wave", since: "abc123" }, WORKER_CALLER)).ok).toBe(true);
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER)).ok).toBe(true);
    const batches = createRequestRegistry(home).get(WS, REQ)!.reviews.batches;
    expect(batches.map((batch) => [batch.batchId, batch.milestone, batch.results])).toEqual([
      ["b1", "plan", []],
      ["b2", "wave", []],
      ["b3", "finished", []],
    ]);
    const brief = batches[1]!.brief.split("\n");
    expect(brief.slice(0, 4)).toEqual([`Review batch b2 of request ${REQ}.`, "milestone: wave", "stages: implementation", "since: abc123"]);
    expect(fake.creates[1]!.options.prompt!.endsWith(batches[1]!.brief)).toBe(true);
    expect(batches[2]!.brief).not.toContain("since:");
    // An older caller's brief, without either, is unchanged.
    expect(reviewerBriefOf({ requestId: REQ, batchId: "b1", stages: ["implementation"], scope: "x" }).split("\n").slice(0, 2)).toEqual([`Review batch b1 of request ${REQ}.`, "stages: implementation"]);
  });

  it("refuses a plan batch below Large, derived or named, creating nothing", async () => {
    for (const tier of ["Small", "Medium"] as const) {
      const { tools, fake, home } = setup({ tier });
      // Named with plan stages: an implementation batch named plan is refused for its stages first (below).
      for (const input of [PLAN, { ...PLAN, milestone: "plan" }]) {
        expect(await tools.call("bm_create_reviewer", input, WORKER_CALLER)).toEqual({ ok: false, text: "Only a Large request reviews its plan; nothing was created." });
      }
      expect(fake.creates).toEqual([]);
      expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toEqual([]);
      // Its implementation batches are not plan batches.
      expect((await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(true);
    }
  });

  it("refuses a second plan batch after one passed; one that has not passed may be followed by another", async () => {
    const { tools, fake, verdict } = setup({ tier: "Large" });
    expect((await tools.call("bm_create_reviewer", PLAN, WORKER_CALLER)).ok).toBe(true);
    verdict("b1", 2);
    expect((await tools.call("bm_create_reviewer", { ...PLAN, batchId: "b2" }, WORKER_CALLER)).ok).toBe(true);
    verdict("b2", 0);
    expect(await tools.call("bm_create_reviewer", { ...PLAN, batchId: "b3" }, WORKER_CALLER)).toEqual({
      ok: false,
      text: "Plan batch b2 passed, and a request reviews its plan once: open a wave or finished batch instead. Nothing was created.",
    });
    expect(fake.creates).toHaveLength(2);
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3", milestone: "wave" }, WORKER_CALLER)).ok).toBe(true);
  });

  it("milestoneRefusalOf: a wave or finished batch is never refused for its milestone", () => {
    const passedPlan = [{ batchId: "b1", milestone: "plan" as const, results: [{ at: T0.toISOString(), recordId: "out-1", verdict: "pass", blocking: 0 }] }];
    expect(milestoneRefusalOf("wave", "Small", passedPlan, [])).toBeNull();
    expect(milestoneRefusalOf("finished", "Large", passedPlan, [])).toBeNull();
    expect(milestoneRefusalOf("plan", "Large", passedPlan, [])).toContain("Plan batch b1 passed");
    expect(milestoneRefusalOf("plan", "Large", [{ ...passedPlan[0]!, milestone: undefined }], [])).toBeNull();
  });

  it("refuses a named milestone its stages contradict, creating nothing; a milestone left out is derived and never does", async () => {
    const { tools, fake, home } = setup({ tier: "Large" });
    expect(await tools.call("bm_create_reviewer", { ...INPUT, milestone: "plan" }, WORKER_CALLER)).toEqual({
      ok: false,
      text: "A plan batch reviews plan or beads, never implementation: the stages implementation do not fit it; nothing was created.",
    });
    expect(await tools.call("bm_create_reviewer", { ...PLAN, milestone: "wave" }, WORKER_CALLER)).toEqual({
      ok: false,
      text: "A wave batch reviews implementation, never plan or beads: the stages plan, beads do not fit it; nothing was created.",
    });
    expect(fake.creates).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches).toEqual([]);
    expect(stagesRefusalOf({ stages: ["plan", "implementation"], milestone: "plan" })).toContain("never implementation");
    expect(stagesRefusalOf({ stages: ["implementation", "beads"], milestone: "finished" })).toContain("never plan or beads");
    expect(stagesRefusalOf({ stages: ["documents"], milestone: "plan" })).toContain("plan or beads");
    for (const fits of [
      { stages: ["plan", "documents"], milestone: "plan" },
      { stages: ["beads"], milestone: "plan" },
      { stages: ["implementation", "documents"], milestone: "finished" },
      { stages: ["implementation"], milestone: "wave" },
      { stages: ["implementation"] },
      { stages: ["documents"] },
    ] as const) {
      expect(stagesRefusalOf({ stages: [...fits.stages], ...("milestone" in fits ? { milestone: fits.milestone } : {}) }), JSON.stringify(fits)).toBeNull();
    }
  });
});

describe("convergence: bm_rereview asks no one while blocking findings fall (delivery line design §5.2)", () => {
  /** A batch b1 of a Large request with its first verdict, `blocking` findings. */
  async function opened(blocking: number | null, options: { maxRereviews?: number } = {}) {
    const context = setup({ tier: "Large" });
    if (options.maxRereviews !== undefined) createCoordinationStore(context.home).set({ key: "review.maxRereviews", value: options.maxRereviews });
    // A cap that never stops these cases (6 calls in one batch): the cap is not under test here.
    createCoordinationStore(context.home).set({ key: "review.callsPerBatch", value: 6 });
    expect((await context.tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(true);
    context.verdict("b1", blocking);
    context.tick();
    const rereview = async (fixed = "fixed") => {
      const result = await context.tools.call("bm_rereview", { batchId: "b1", fixed }, WORKER_CALLER);
      context.tick();
      return result;
    };
    return { ...context, rereview };
  }

  it("a pass refuses: nothing to re-review", async () => {
    const { rereview, fake } = await opened(0);
    expect(await rereview()).toEqual({ ok: false, text: "Batch b1 passed: nothing to re-review. Nothing was sent." });
    expect(fake.creates).toHaveLength(1);
  });

  it("the first re-review needs no fall; from the second on, 3 → 2 goes and 3 → 3 stops, asking nobody", async () => {
    const { rereview, verdict, fake, home } = await opened(3);
    expect((await rereview()).ok).toBe(true);
    verdict("b1", 2);
    expect((await rereview()).ok).toBe(true);
    verdict("b1", 2);
    expect(await rereview()).toEqual({ ok: false, text: `Batch b1 stopped converging (blocking 2 → 2). ${CONVERGENCE_STOP_TAIL}` });
    expect(CONVERGENCE_STOP_TAIL).toBe(
      "Fix what you can and open the next milestone batch, or send `finished` with the open blocking findings in `reviewFindingsOpen`. Nothing was sent.",
    );
    // Two re-reviews, each a fresh Reviewer.
    expect(fake.creates).toHaveLength(3);
    // No question was opened.
    expect(createOutbox(home).list(WS)).toEqual([]);
    expect(createDecisionStore(home).list({ workspaceId: WS })).toEqual([]);
  });

  it("3 → 3 on the first re-review's verdict stops the second", async () => {
    const { rereview, verdict } = await opened(3);
    expect((await rereview()).ok).toBe(true);
    verdict("b1", 3);
    expect((await rereview()).text).toBe(`Batch b1 stopped converging (blocking 3 → 3). ${CONVERGENCE_STOP_TAIL}`);
  });

  it("an unknown count never counts as lower: a no-verdict may be asked once more, but stops the rule after it", async () => {
    // A first review without a verdict: the Worker asks once more (NO_VERDICT_SENTENCE).
    const first = await opened(null);
    expect((await first.rereview()).ok).toBe(true);
    // With no verdict to check fixes against, the fresh Reviewer gets the batch's own brief.
    expect(first.fake.creates[1]!.options.prompt!.endsWith(createRequestRegistry(first.home).get(WS, REQ)!.reviews.batches[0]!.brief)).toBe(true);
    // A re-review without a verdict: unknown, never lower.
    const { rereview, verdict } = await opened(3);
    expect((await rereview()).ok).toBe(true);
    verdict("b1", null);
    expect((await rereview()).text).toBe(`Batch b1 stopped converging (blocking 3 → unknown). ${CONVERGENCE_STOP_TAIL}`);
  });

  it("the K-th re-review is the last: review.maxRereviews, 3 by default, 1 to 6", async () => {
    const { rereview, verdict, fake } = await opened(5);
    for (const blocking of [4, 3, 2]) {
      expect((await rereview()).ok).toBe(true);
      verdict("b1", blocking);
    }
    expect(await rereview()).toEqual({ ok: false, text: `Batch b1 had its 3 re-reviews. ${CONVERGENCE_STOP_TAIL}` });
    expect(fake.creates).toHaveLength(4);

    const one = await opened(5, { maxRereviews: 1 });
    expect((await one.rereview()).ok).toBe(true);
    one.verdict("b1", 1);
    expect((await one.rereview()).text).toBe(`Batch b1 had its 1 re-review. ${CONVERGENCE_STOP_TAIL}`);
  });

  it("convergenceRefusalOf, pure: the order of the conditions", () => {
    const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();
    const call = (kind: "create" | "rereview", minutes: number) => ({ callId: `out-${kind}${minutes}`, kind, reviewerId: "rev-1", at: at(minutes) });
    const result = (minutes: number, blocking: number | null, verdict = blocking === 0 ? "pass" : "changes-required") => ({ at: at(minutes), recordId: `out-r${minutes}`, verdict, blocking });
    const refusal = (results: ReturnType<typeof result>[], calls: ReturnType<typeof call>[], maxRereviews = 3) => convergenceRefusalOf({ batchId: "b2", results, calls, maxRereviews });
    expect(refusal([], [call("create", 0)])).toContain("has no verdict on its last review yet");
    expect(refusal([result(1, 3)], [call("create", 0)])).toBeNull();
    expect(refusal([result(1, 0)], [call("create", 0)])).toBe("Batch b2 passed: nothing to re-review. Nothing was sent.");
    expect(refusal([result(1, 3)], [call("create", 0), call("rereview", 2)])).toContain("has no verdict on its last review yet");
    expect(refusal([result(1, 3), result(3, 2)], [call("create", 0), call("rereview", 2)])).toBeNull();
    expect(refusal([result(1, 3), result(3, 4)], [call("create", 0), call("rereview", 2)])).toContain("stopped converging (blocking 3 → 4)");
    expect(refusal([result(1, null), result(3, 2)], [call("create", 0), call("rereview", 2)])).toContain("stopped converging (blocking unknown → 2)");
    expect(refusal([result(1, 3), result(3, 2)], [call("create", 0), call("rereview", 2)], 1)).toBe(`Batch b2 had its 1 re-review. ${CONVERGENCE_STOP_TAIL}`);
    // A pass refuses before the count does.
    expect(refusal([result(1, 3), result(3, 0)], [call("create", 0), call("rereview", 2)], 1)).toContain("passed");
  });

  it("without a snapshot (no git), the brief falls back to the Worker's since and fixed", async () => {
    const { tools, fake, verdict } = setup({ tier: "Medium" });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    verdict("b1", 1);
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "F1 fixed.", since: "def456" }, WORKER_CALLER)).ok).toBe(true);
    expect(fake.creates[1]!.options.prompt!.split("\n").slice(1)).toEqual([
      `Re-review batch b1 of request ${REQ}: a fresh Reviewer checks only the fixes.`,
      "Previous blocking findings (verbatim):",
      "(the review out-r00000000001 is no longer stored: the Worker's account below names the findings)",
      "Fixes — paseo-bm has no snapshot of the last review to compare, so the Worker's account stands for the diff:",
      "The diff: git diff def456",
      "How the Worker fixed them, and the checks it ran: F1 fixed.",
      `requestId: ${REQ}`,
      "batchId: b1",
    ]);
    expect(rereviewBriefOf({ requestId: REQ, batchId: "b1", findings: "-", fixed: "x", fixes: null })).toContain("The diff: the Worker named no commit; read the files the findings and the fixes name.");
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "x", since: "two words" }, WORKER_CALLER)).text).toContain("input.since");
  });

  it("an older batch, opened without results, reads its counts from the trace's reviews", async () => {
    const { tools, home, tick, record, fake, clock } = setup({ tier: "Large" });
    await record(MANAGER, "manager", "Fix the invoice date format.");
    await record(WORKER, "worker", null, { parentAgentId: MANAGER });
    tick();
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    // As an older build left it: no milestone, no results.
    const file = join(home, "requests", `${WS}.json`);
    const body = JSON.parse(readFileSync(file, "utf8")) as { requests: Array<{ reviews: { batches: Array<Record<string, unknown>> } }> };
    for (const batch of body.requests[0]!.reviews.batches) {
      delete batch["results"];
      delete batch["milestone"];
    }
    writeFileSync(file, JSON.stringify(body));
    clearRequestRegistryCache();
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.results).toBeUndefined();
    // Its result is never written to it: the trace stays its one source.
    expect(createRequestRegistry(home).addReviewResult(WS, REQ, "b1", { at: T0.toISOString(), recordId: "out-x", verdict: "pass", blocking: 0 })).toBe("older-batch");

    /** The Reviewer's recorded turn with its BM-REVIEW of b1, at the clock: the trace's review. */
    const reviewed = async (blocking: number) => {
      tick();
      await record("created-1", "reviewer", null, {
        parentAgentId: WORKER,
        reviews: [{ agentId: "created-1", at: clock().toISOString(), batchId: "b1", verdict: "changes-required", blockingCount: blocking }],
      });
      fake.byId("created-1")!.status = "idle";
      tick();
    };
    await reviewed(3);
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "fixed" }, WORKER_CALLER)).ok).toBe(true);
    await reviewed(3);
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "fixed again" }, WORKER_CALLER)).text).toBe(`Batch b1 stopped converging (blocking 3 → 3). ${CONVERGENCE_STOP_TAIL}`);

    const traceReviews = [
      { agentId: "created-1", at: "2026-10-03T10:20:00.000Z", batchId: "b1", verdict: "changes-required", blockingCount: 2 },
      { agentId: "created-1", at: "2026-10-03T10:10:00.000Z", batchId: "b1", verdict: "changes-required", blockingCount: 3 },
      { agentId: "created-1", at: "2026-10-03T10:15:00.000Z", batchId: "b2", verdict: "pass", blockingCount: 0 },
    ];
    expect(batchResultsOf({ batchId: "b1" }, traceReviews).map((entry) => entry.blocking)).toEqual([3, 2]);
    expect(batchResultsOf({ batchId: "b1", results: [] }, traceReviews)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The one counter and the refusal (design §16.8).
// ---------------------------------------------------------------------------

describe("one counter: the tools enforce with the number the Dashboard shows (design §16.8)", () => {
  it("tool calls, their BM-BRIEF and BM-DELIVERY messages counted once, a hand-sent message as an off-tool call; the same number in the tool answer and the Dashboard", async () => {
    const { tools, fake, tick, dashboard, record, verdict } = setup({ tier: "Small" });
    // The Manager's turn opens the request's row; its Worker's turn follows.
    await record(MANAGER, "manager", "Fix the invoice date format.");
    await record(WORKER, "worker", null, { parentAgentId: MANAGER });
    expect(await dashboard()).toBeNull();

    tick();
    const created = parsed(await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER));
    expect(created["reviewCalls"]).toBe("1 of 3");
    expect(await dashboard()).toBe(1);
    // The Reviewer's turn, with its BM-BRIEF prompt: the same call as its tool record.
    tick();
    await record("created-1", "reviewer", fake.creates[0]!.options.prompt!, { parentAgentId: WORKER });
    expect(await dashboard()).toBe(1);

    tick();
    verdict("b1", 1);
    const rereview = parsed(await tools.call("bm_rereview", { batchId: "b1", fixed: "fixed F1" }, WORKER_CALLER));
    expect(rereview["reviewCalls"]).toBe("2 of 3");
    expect(await dashboard()).toBe(2);
    // The fresh Reviewer's turn, with its BM-BRIEF prompt: the same call as its tool record.
    tick();
    await record("created-2", "reviewer", fake.creates.at(-1)!.options.prompt!, { parentAgentId: WORKER });
    expect(await dashboard()).toBe(2);

    // A message the Worker sent its Reviewer by hand: an off-tool call, counted.
    tick();
    await record("created-1", "reviewer", "Also look at src/pdf.ts, please.", { parentAgentId: WORKER });
    expect(await dashboard()).toBe(3);

    // The cap is reached, by the same count (a Small request: 3 calls, however many batches): refused word for word,
    // nothing created or sent.
    tick();
    const creates = fake.creates.length;
    const sends = fake.sends.length;
    const refusal = await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER);
    expect(refusal).toEqual({ ok: false, text: reviewCapRefusalOf({ requestId: REQ, calls: 3, cap: 3, tier: "Small", milestones: 2, qn: "Q1" }) });
    expect(refusal.text).toBe(
      `Review cap reached for ${REQ}: 3 of 3 calls (Small, 2 milestone batches). paseo-bm asked the owner as Q1. Send \`blocked\` with \`waitingOn: [q:${REQ}:Q1]\`. Nothing was created or sent.`,
    );
    expect(fake.creates).toHaveLength(creates);
    expect(fake.sends).toHaveLength(sends);
    expect(await dashboard()).toBe(3);
  });

  it("reviewCallsOf: the union of tool records and the activity stream, counted once by id", () => {
    const reviewer = "rev-1";
    const records = [
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:00:00.000Z", `${reviewerBriefLineOf(REQ, "b1", "out-aaaaaaaaaaaa")}\nReview batch b1.`)] }),
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:10:00.000Z", "BM-DELIVERY message out-bbbbbbbbbbbb\nRe-review batch b1.")] }),
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:20:00.000Z", "Check src/pdf.ts too.")] }),
      // A stop notice and another delivery kind are no calls.
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:30:00.000Z", "BM-FORMAT your block broke its template.")] }),
    ];
    const tool = [{ callId: "out-aaaaaaaaaaaa" }, { callId: "out-bbbbbbbbbbbb" }, { callId: "out-cccccccccccc" }];
    // Three tool calls, two of them seen by id, and one hand-sent message.
    expect(reviewCallsOf([reviewer], records, [], tool)).toBe(4);
    expect(reviewCallsOf([reviewer], records)).toBe(3);
    // Tool records alone are a count, not "unknown".
    expect(reviewCallsOf(["rev-unrecorded"], [], [], tool)).toBe(3);
    expect(reviewCallsOf(["rev-unrecorded"], [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The grant (design §16.8).
// ---------------------------------------------------------------------------

/** A stored review-budget question of the request, as an older build opened it: a grant on each option but the last. */
function budgetQuestion(grantA: { calls: number } | { untilClean: string }, id = `q:${REQ}:Q1`): Decision {
  return makeDecision({
    id,
    workspaceId: WS,
    requestId: REQ,
    subject: "review-budget",
    class: "cost",
    question: "Review budget reached: allow more review calls?",
    options: [
      { key: "a", label: "More reviews", recommended: true, effects: ["none"], grant: grantA },
      { key: "b", label: "No more reviews", recommended: false, effects: ["none"] },
    ],
  });
}

function answered(decision: Decision, optionKey: string): Decision {
  const result = answerDecision(decision, { via: "inbox", optionKey, at: T0.toISOString() });
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

/** The `review.over-budget` state of a request (Small: a cap of 3, review.callsPerBatch's default) with `calls` review calls and the grant, if any. */
function overBudgetState(calls: number, reviewGrant?: RuleReviewGrant, tier: "Small" | "Medium" | "Large" = "Small"): string | undefined {
  const input = { traceId: `req:${REQ}`, requestId: REQ, tier, reviewCalls: calls, inbound: [], ...(reviewGrant === undefined ? {} : { reviewGrant }) };
  return flagsOf(input, { review: { callsPerBatch: 3 } }).find((flag) => flag.rule === "review.over-budget")?.state;
}

describe("older review-budget grants (design §16.8; delivery line design §5.6)", () => {
  it("an older stored { calls: n } grant still lets exactly n more through, read the same by the rule", async () => {
    const { tools, home, fake } = setup({ tier: "Small" });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER);
    await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER);
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b4" }, WORKER_CALLER)).text).toContain("3 of 3 calls");

    // What an older build wrote for an answered review-budget question: read, never written any more.
    expect(createRequestRegistry(home).addGrant(WS, REQ, { decisionId: `q:${REQ}:Q8`, calls: 2, untilCleanBatch: null })).toBe("added");

    expect(parsed(await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b4" }, WORKER_CALLER))["reviewCalls"]).toBe("4 of 5");
    expect(parsed(await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b5" }, WORKER_CALLER))["reviewCalls"]).toBe("5 of 5");
    // Past it again: the review-cap question opened at the first hit is still open, so it is named again.
    const over = await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b6" }, WORKER_CALLER);
    expect(over.text).toBe(reviewCapRefusalOf({ requestId: REQ, calls: 5, cap: 5, tier: "Small", milestones: 6, qn: "Q1" }));
    expect(fake.creates).toHaveLength(5);

    // The Orchestrator's review.over-budget rule reads the same ceiling: 5 calls of a granted Small request are not flagged.
    const grant = ruleReviewGrantOf(createRequestRegistry(home).get(WS, REQ)!);
    expect(grant).toEqual({ calls: 2, milestones: 5 });
    expect(overBudgetState(5, grant)).toBeUndefined();
    expect(overBudgetState(5)).toBe("raised");
    expect(overBudgetState(6, grant)).toBe("raised");
  });

  it("an older untilClean grant exempts no call: the cap refuses at it, and the rule counts every call", async () => {
    const { tools, home, tick, verdict } = setup({ tier: "Small" });
    // A Small cap of 2 (review.callsPerBatch 2), so the third call is past it.
    createCoordinationStore(home).set({ key: "review.callsPerBatch", value: 2 });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    verdict("b1", 3);
    tick();
    await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 1" }, WORKER_CALLER);
    verdict("b1", 2);
    tick();
    createRequestRegistry(home).addGrant(WS, REQ, { decisionId: `q:${REQ}:Q1`, calls: null, untilCleanBatch: "b1" });
    // Converging, but past the Small cap of 2: the untilClean grant lets nothing through.
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 2" }, WORKER_CALLER)).text).toContain("Review cap reached");
    expect(ruleReviewGrantOf(createRequestRegistry(home).get(WS, REQ)!)).toEqual({ calls: 0, milestones: 1 });
    expect(overBudgetState(4, ruleReviewGrantOf(createRequestRegistry(home).get(WS, REQ)!))).toBe("raised");
  });

  it("an answered review-budget question grants nothing, whoever answered it; applyReviewCapAnswer acts on review-cap answers only", () => {
    const home = dataFolder();
    register(home, "Small");
    const owner = answered(budgetQuestion({ calls: 2 }), "a");
    expect(applyReviewCapAnswer([owner, answered(budgetQuestion({ untilClean: "b1" }, `q:${REQ}:Q2`), "a")], { home })).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants).toEqual([]);
    const cap = { ...owner, subject: REVIEW_CAP_SUBJECT, ownerOnly: true };
    expect(applyReviewCapAnswer([cap], { home })).toEqual([owner.id]);
  });
});

// ---------------------------------------------------------------------------
// Past the cap: one owner-only decision per request (delivery line design §5.4).
// ---------------------------------------------------------------------------

describe("past the cap: one owner-only review-cap decision per request (delivery line design §5.4)", () => {
  /** A Small request (cap 3) with batch b1 reviewed and re-reviewed, and b2 created: its 3 calls. */
  async function atCap(options: { stopped?: boolean } = {}) {
    const context = setup({ tier: "Small" });
    const { tools, verdict, tick } = context;
    expect((await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).ok).toBe(true);
    verdict("b1", 3);
    tick();
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 1" }, WORKER_CALLER)).ok).toBe(true);
    verdict("b1", options.stopped === true ? 3 : 2);
    tick();
    expect(parsed(await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER))["reviewCalls"]).toBe("3 of 3");
    verdict("b2", 1);
    tick();
    return context;
  }
  const decisionOf = (home: string, qn = "Q1") => createDecisionStore(home).get(`q:${REQ}:${qn}`, WS);

  it("at the cap the tool opens q:<requestId>:Qn — subject review-cap, class cost, ownerOnly, options a/b/c — then refuses, creating and sending nothing", async () => {
    const { tools, home, fake, opened } = await atCap();
    const creates = fake.creates.length;
    const sends = fake.sends.length;
    const refusal = await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER);
    expect(refusal).toEqual({
      ok: false,
      text: `Review cap reached for ${REQ}: 3 of 3 calls (Small, 2 milestone batches). paseo-bm asked the owner as Q1. Send \`blocked\` with \`waitingOn: [q:${REQ}:Q1]\`. Nothing was created or sent.`,
    });
    expect(fake.creates).toHaveLength(creates);
    expect(fake.sends).toHaveLength(sends);
    const decision = decisionOf(home)!;
    expect(decision).toMatchObject({
      id: `q:${REQ}:Q1`,
      requestId: REQ,
      askedBy: { role: "worker", agentId: WORKER },
      subject: REVIEW_CAP_SUBJECT,
      class: "cost",
      ownerOnly: true,
      status: "open",
      question: `Request ${REQ} reached its review cap: 3 of 3 calls (Small, 2 milestone batches). How should it go on?`,
    });
    expect(decision.options.map((option) => [option.key, option.label, option.recommended, option.grant ?? null])).toEqual([
      ["a", "Allow one more round of batches (+3 calls)", true, { calls: 3 }],
      ["b", "Finish as it stands, open blocking findings listed", false, null],
      ["c", "Stop this request", false, null],
    ]);
    // The event bus hears of it, as of a question bm_questions opened.
    expect(opened.map((entry) => entry.id)).toEqual([`q:${REQ}:Q1`]);
  });

  it("b is recommended when the last batch stopped converging", async () => {
    const { tools, home } = await atCap({ stopped: true });
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER)).text).toContain("paseo-bm asked the owner as Q1");
    // b2's one review is no re-review: it did not stop. b1 is not the last batch, so a stays recommended.
    expect(decisionOf(home)!.options.map((option) => option.recommended)).toEqual([true, false, false]);

    // A cap of 2: b1 stops converging (3 → 3) and is the last batch when b2 is asked for.
    const small = setup({ tier: "Small" });
    createCoordinationStore(small.home).set({ key: "review.callsPerBatch", value: 2 });
    await small.tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    small.verdict("b1", 3);
    small.tick();
    await small.tools.call("bm_rereview", { batchId: "b1", fixed: "fix 1" }, WORKER_CALLER);
    small.verdict("b1", 3);
    small.tick();
    expect((await small.tools.call("bm_rereview", { batchId: "b1", fixed: "fix 2" }, WORKER_CALLER)).text).toContain("stopped converging (blocking 3 → 3)");
    expect((await small.tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER)).text).toBe(
      reviewCapRefusalOf({ requestId: REQ, calls: 2, cap: 2, tier: "Small", milestones: 2, qn: "Q1" }),
    );
    expect(decisionOf(small.home)!.options.map((option) => [option.key, option.recommended, option.grant ?? null])).toEqual([
      ["a", false, { calls: 2 }],
      ["b", true, null],
      ["c", false, null],
    ]);
  });

  it("is numbered after the request's highest Qn", async () => {
    const { tools, home } = await atCap();
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ}:Q4`, workspaceId: WS, requestId: REQ }));
    expect((await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER)).text).toContain(`waitingOn: [q:${REQ}:Q5]`);
    expect(decisionOf(home, "Q5")).toMatchObject({ subject: REVIEW_CAP_SUBJECT, ownerOnly: true });
  });

  it("once per request: a hit while it is open names it again; after the owner's answer a hit opens nothing and refuses as spent", async () => {
    const { tools, home, tick, verdict, opened } = await atCap();
    await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER);
    // Asked again while open: the same question, nothing new.
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER)).text).toBe(
      reviewCapRefusalOf({ requestId: REQ, calls: 3, cap: 3, tier: "Small", milestones: 3, qn: "Q1" }),
    );
    expect(createDecisionStore(home).list({ workspaceId: WS, requestId: REQ }).map((entry) => entry.id)).toEqual([`q:${REQ}:Q1`]);

    // The owner chooses a: three more calls, in the existing grant format.
    const answer = answerDecision(decisionOf(home)!, { via: "inbox", optionKey: "a", at: T0.toISOString() });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(applyReviewCapAnswer([answer.decision], { home })).toEqual([`q:${REQ}:Q1`]);
    // Once per decision.
    expect(applyReviewCapAnswer([answer.decision], { home })).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants).toEqual([{ decisionId: `q:${REQ}:Q1`, calls: 3, untilCleanBatch: null }]);
    createDecisionStore(home).transition(answer.decision.id, () => ({ ok: true, decision: answer.decision }), WS);

    expect(parsed(await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER))["reviewCalls"]).toBe("4 of 6");
    verdict("b2", 0);
    tick();
    expect(parsed(await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER))["reviewCalls"]).toBe("5 of 6");
    verdict("b3", 2);
    tick();
    expect(parsed(await tools.call("bm_rereview", { batchId: "b3", fixed: "fix" }, WORKER_CALLER))["reviewCalls"]).toBe("6 of 6");
    verdict("b3", 1);
    tick();
    // The second hit: no second decision; refused with the spent text.
    const spent = await tools.call("bm_rereview", { batchId: "b3", fixed: "fix again" }, WORKER_CALLER);
    expect(spent).toEqual({ ok: false, text: reviewCapSpentOf("Q1") });
    expect(spent.text).toBe("The request's review cap is spent and the owner answered Q1; send `finished` with the open blocking findings. Nothing was created or sent.");
    expect(createDecisionStore(home).list({ workspaceId: WS, requestId: REQ }).map((entry) => entry.id)).toEqual([`q:${REQ}:Q1`]);
    expect(opened).toHaveLength(1);
  });

  it("an answer that grants nothing (b, c) leaves the ceiling where it was: the next hit refuses as spent", async () => {
    const { tools, home } = await atCap();
    await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER);
    const answer = answerDecision(decisionOf(home)!, { via: "chat-worker", optionKey: "b", at: T0.toISOString() });
    if (!answer.ok) throw new Error(answer.message);
    expect(applyReviewCapAnswer([answer.decision], { home })).toEqual([]);
    createDecisionStore(home).transition(answer.decision.id, () => ({ ok: true, decision: answer.decision }), WS);
    expect((await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER)).text).toBe(reviewCapSpentOf("Q1"));
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants).toEqual([]);
  });

  it("only the owner answers it: the Main, the policy, a Manager's chat and a precedent are refused, and grant nothing", async () => {
    const { tools, home } = await atCap();
    await tools.call("bm_rereview", { batchId: "b2", fixed: "fix F1" }, WORKER_CALLER);
    const decision = decisionOf(home)!;
    const at = T0.toISOString();
    for (const [input, who] of [
      [{ via: "main", by: "main", optionKey: "a", at }, "the Main"],
      [{ via: "inbox", by: "policy", optionKey: "a", at, class: "cost", reason: "cost is delegated" }, "the policy"],
      [{ via: "chat-manager", optionKey: "a", at }, "a Manager's chat"],
      [{ via: "inbox", by: "precedent", optionKey: "a", at }, "a precedent"],
    ] as const) {
      const result = answerDecision(decision, input as Parameters<typeof answerDecision>[1]);
      expect(result.ok, who).toBe(false);
    }
    // A precedent never stands for the subject, and none answers the decision as it opens.
    expect(whyIneligible(REVIEW_CAP_SUBJECT)).toContain("no precedent answers it");
    expect(resolveAtOpen(decision, { home, now: T0, log: () => {}, store: createDecisionStore(home) }).answered).toBeNull();
    // Should an answer by anyone else ever be stored, it grants nothing.
    for (const by of ["policy", "main", "precedent", "orchestrator"] as const) {
      const forged: Decision = { ...decision, status: "answered", answer: { by, via: "inbox", optionKey: "a", words: null, at, class: "cost", reason: "x" } as never };
      expect(applyReviewCapAnswer([forged], { home }), by).toEqual([]);
    }
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants).toEqual([]);
    expect(decisionOf(home)!.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// One ceiling (design §16.8): the tools, the rule and the Manager's notice.
// ---------------------------------------------------------------------------

describe("one ceiling: the review tools, the Orchestrator's rule and the Manager's notice agree (design §16.8)", () => {
  /** `n` tool calls of batch `batchId` in the registry: a create, then re-reviews. */
  function callsOf(home: string, batchId: string, n: number): void {
    const registry = createRequestRegistry(home);
    for (let i = 0; i < n; i += 1) {
      const callId = `out-${batchId}${String(i).padStart(10, "0")}`;
      registry.addReviewCall(WS, REQ, batchId, { callId, kind: i === 0 ? "create" : "rereview", reviewerId: `rev-${batchId}`, at: T0.toISOString() }, "brief");
    }
  }

  /** The request's trace as the notice reads it: only what `overrunOf` looks at. */
  const traceWith = (reviewCalls: number, tier: string) => ({ requestId: REQ, tier, reviewCalls, managerAgentId: MANAGER }) as unknown as ReconstructedTrace;

  /**
   * What each check says now, and of one more call of `batchId`: the tools'
   * refusal of it, and the rule and the notice on the count after it (a new
   * batch counts as one more milestone batch).
   */
  async function verdicts(home: string, paseo: unknown, batchId: string) {
    const request = createRequestRegistry(home).get(WS, REQ)!;
    const state = (await reviewCapStateOf({ home, paseo, log: () => {} }, request))!;
    const grant = ruleReviewGrantOf(request);
    expect(grant).toEqual({ calls: state.granted, milestones: request.reviews.batches.length });
    const milestones = grant.milestones + (request.reviews.batches.some((batch) => batch.batchId === batchId) ? 0 : 1);
    const after = { calls: grant.calls, milestones };
    const review = { callsPerBatch: state.callsPerBatch };
    return {
      calls: state.calls,
      now: { rule: overBudgetState(state.calls, grant, state.tier) === "raised", notice: overrunOf(traceWith(state.calls, state.tier), review, grant) !== null },
      next: {
        tool: overCapAfterOne(state, milestones),
        rule: overBudgetState(state.calls + 1, after, state.tier) === "raised",
        notice: overrunOf(traceWith(state.calls + 1, state.tier), review, after) !== null,
      },
    };
  }

  it("granted calls: within at the raised ceiling; the call past it is refused, flagged and noticed alike", async () => {
    const { home, fake } = setup({ tier: "Small" });
    callsOf(home, "b1", 3);
    callsOf(home, "b2", 2);
    createRequestRegistry(home).addGrant(WS, REQ, { decisionId: `q:${REQ}:Q1`, calls: 2, untilCleanBatch: null });
    expect(await verdicts(home, fake.paseo, "b3")).toEqual({ calls: 5, now: { rule: false, notice: false }, next: { tool: true, rule: true, notice: true } });
    expect(await verdicts(home, fake.paseo, "b2")).toEqual({ calls: 5, now: { rule: false, notice: false }, next: { tool: true, rule: true, notice: true } });
  });

  it("milestone batches: a Large request's cap grows with its batches up to four, for all three", async () => {
    const { home, fake } = setup({ tier: "Large" });
    callsOf(home, "b1", 3);
    callsOf(home, "b2", 3);
    // 6 calls in two batches: a re-review of b2 is past 6; a third batch raises the cap to 9.
    expect(await verdicts(home, fake.paseo, "b2")).toEqual({ calls: 6, now: { rule: false, notice: false }, next: { tool: true, rule: true, notice: true } });
    expect(await verdicts(home, fake.paseo, "b3")).toEqual({ calls: 6, now: { rule: false, notice: false }, next: { tool: false, rule: false, notice: false } });
    callsOf(home, "b3", 3);
    callsOf(home, "b4", 3);
    // 12 calls in four batches: the cap stops at 12, even for a fifth batch.
    expect(await verdicts(home, fake.paseo, "b5")).toEqual({ calls: 12, now: { rule: false, notice: false }, next: { tool: true, rule: true, notice: true } });
  });

  it("an older untilClean grant: no call is left out by any of the three, for its own batch or another (delivery line design §5.6)", async () => {
    const { home, fake } = setup({ tier: "Small" });
    callsOf(home, "b1", 4);
    createRequestRegistry(home).addGrant(WS, REQ, { decisionId: `q:${REQ}:Q1`, calls: null, untilCleanBatch: "b1" });
    const past = { calls: 4, now: { rule: true, notice: true }, next: { tool: true, rule: true, notice: true } };
    expect(await verdicts(home, fake.paseo, "b1")).toEqual(past);
    expect(await verdicts(home, fake.paseo, "b2")).toEqual(past);
  });
});
