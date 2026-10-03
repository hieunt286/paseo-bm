import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_CALLER_MESSAGE, PENDING_TTL_MS, clearBindingCache, createBindingStore, type BindingStore, type ToolCaller } from "../plugin/server/agent-bindings";
import { settleCreatedAgent } from "../plugin/server/creation-settle";
import { answer, binderOf, withAgentTools } from "../plugin/server/agent-tools";
import { NO_DATA_FOLDER_MESSAGE } from "../plugin/server/create-worker";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import { AGENT_TOOLS_OFF_TOOL_MESSAGE } from "../plugin/server/manager";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { workspaceTracesOf } from "../plugin/server/request-trace";
import {
  NO_REPORT_YET_MESSAGE,
  REVIEW_NOT_BOUND_MESSAGE,
  applyReviewBudgetGrants,
  budgetRefusalOf,
  clearPluginReviewers,
  createReviewTools,
  isPluginReviewer,
  rereviewLineOf,
  ruleReviewGrantOf,
} from "../plugin/server/review-tools";
import { flagsOf } from "../plugin/shared/orchestrator-rules";
import type { RuleReviewGrant } from "../plugin/shared/rule-input";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { reviewCallCountOf } from "../plugin/server/traces";
import { toolFacesFor } from "../plugin/shared/bm-tools";
import { decideRefusalOf, type AutonomyPolicy } from "../plugin/shared/autonomy";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { parseDelivery, reviewCallIdOf, reviewerBriefLineOf } from "../plugin/shared/notices";
import { originOf } from "../plugin/shared/message-origin";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeCreateRequest } from "./helpers/fake-paseo";
import { msg, turn } from "./fixtures/orchestrator-traces";

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
const roots: string[] = [];

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearPluginReviewers();
  forgetModes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-review-tools-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

const WORKER_CALLER: ToolCaller = { agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQ, parentId: MANAGER, batchId: null, creationTools: true };

interface DaemonOptions {
  toolsOff?: boolean;
  profile?: boolean;
  refuse?: string;
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

function setup(options: DaemonOptions & { home?: string | null; tier?: "Small" | "Medium" | "Large" | null; paseo?: boolean } = {}) {
  const home = options.home === undefined ? dataFolder() : options.home;
  const store = home === null ? null : createBindingStore(home);
  const fake = daemon({ ...options, ...(store === null ? {} : { store }) });
  if (home !== null) register(home, options.tier === undefined ? "Small" : options.tier);
  const queue = createNoticeQueue({ log: () => {} });
  const logs: string[] = [];
  let clock = T0;
  let n = 0;
  const tools = createReviewTools({
    binder: () => (store === null ? null : binderOf(ROLE_URL, store, (line) => logs.push(line))),
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
  const location = { tracesDir: join(home ?? "/nowhere", "traces") };
  /** The Dashboard's count: the request's trace as `workspaceTracesOf` rebuilds it for `traces.list`. */
  const dashboard = async (): Promise<number | null> => {
    const { traces } = await workspaceTracesOf({ location, paseo: fake.paseo as never, home: home! }, WS);
    return traces.find((trace) => trace.requestId === REQ)?.reviewCalls ?? null;
  };
  /** One recorded turn of an agent, at the clock. */
  const record = async (agentId: string, role: "manager" | "worker" | "reviewer", text: string | null, extra: Record<string, unknown> = {}) => {
    const at = clock.toISOString();
    await appendRecord(location, turn({ agentId, role, workspaceId: WS, requestId: REQ, at, endedAt: at, turnId: `t-${at}`, sent: text === null ? [] : [msg(agentId, at, text, "agent")], ...extra }));
  };
  return { home: home!, store: store!, fake, queue, logs, tools, tick, dashboard, record, location };
}

const INPUT = { batchId: "b1", stages: ["implementation"], scope: "src/date.ts and its test, commit abc123.", checks: "npm test: 412 passed." };
const parsed = (result: { ok: boolean; text: string }) => JSON.parse(result.text) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// The lists.
// ---------------------------------------------------------------------------

describe("the bound Worker's list (design §16.6)", () => {
  it("lists and pre-approves bm_create_reviewer and bm_rereview after bm_questions; an unbound Worker never lists them", () => {
    const names = ["bm_report", "bm_questions", "bm_create_reviewer", "bm_rereview", "bm_reply"];
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
    expect(parsed(result)).toEqual({ reviewerId: "created-1", batchId: "b1", reviewCalls: "1 of 2" });

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
    expect(store.bindingOfAgent("created-1")).toMatchObject({ role: "reviewer", state: "bound", requestId: REQ, batchId: "b1", parentId: WORKER, creationTools: true });
    expect(isPluginReviewer("created-1")).toBe(true);
    // The registry: the batch, its brief, its one call.
    const batch = createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!;
    expect(batch).toMatchObject({ batchId: "b1", reviewerIds: ["created-1"], calls: [{ callId: "out-000000000001", kind: "create", reviewerId: "created-1" }] });
    expect(prompt.endsWith(batch.brief)).toBe(true);
    expect(batch.brief).not.toMatch(/criteria/i);
  });

  it("refuses an unbound caller, a pending binding, no data folder, no Paseo, agent tools off, no report yet — creating nothing", async () => {
    const off = setup({ toolsOff: true });
    // The agent's own line (tell the owner, stop), never the fallback Switch's wording.
    expect(await off.tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).toEqual({ ok: false, text: AGENT_TOOLS_OFF_TOOL_MESSAGE });
    expect(AGENT_TOOLS_OFF_TOOL_MESSAGE).toMatch(/^paseo-bm cannot create agents while Paseo's agent tools are off; .*Tell the owner in one line and stop\.$/);
    expect(off.fake.creates).toEqual([]);

    const { tools, fake, home } = setup();
    expect(await tools.call("bm_create_reviewer", INPUT, null)).toEqual({ ok: false, text: REVIEW_NOT_BOUND_MESSAGE });
    expect(await tools.call("bm_create_reviewer", INPUT, { ...WORKER_CALLER, creationTools: false })).toEqual({ ok: false, text: REVIEW_NOT_BOUND_MESSAGE });
    expect(await tools.call("bm_create_reviewer", INPUT, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });
    expect(await setup({ home: null }).tools.call("bm_create_reviewer", INPUT, WORKER_CALLER)).toEqual({ ok: false, text: NO_DATA_FOLDER_MESSAGE });
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
    clearPluginReviewers();
    const seen = fakePaseo({ agents: [{ id: "rev-late", provider: "bm-reviewer/gpt-5.6", workspaceId: WS, labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "paseo.parent-agent-id": WORKER } }] });
    const settled = await settleCreatedAgent({ id: "rev-late", provider: "bm-reviewer/gpt-5.6", parentAgentId: WORKER, workspaceId: WS }, seen.paseo, { home, bindings: store, log: () => {} });
    expect(settled).toMatchObject({ own: true, repairedCallId: "out-000000000001" });
    expect(store.bindingOfAgent("rev-late")).toMatchObject({ state: "bound", role: "reviewer", batchId: "b1" });
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]).toMatchObject({ reviewerIds: ["rev-late"], calls: [{ callId: "out-000000000001", reviewerId: "rev-late" }] });
    expect(isPluginReviewer("rev-late")).toBe(true);
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

describe("bm_rereview (design §16.6)", () => {
  it("delivers the re-review to the batch's Reviewer with its marker line and records the call under the record's id", async () => {
    const { tools, fake, home } = setup({ tier: "Medium" });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    const result = await tools.call("bm_rereview", { batchId: "b1", fixed: "F1: the date now uses the owner's locale." }, WORKER_CALLER);
    expect(parsed(result)).toEqual({ reviewerId: "created-1", delivery: "sent", reviewCalls: "2 of 2" });
    const [record] = createOutbox(home).list(WS);
    expect(record).toMatchObject({ kind: "message", requestId: REQ, batchId: "b1", from: WORKER, to: "created-1", state: "delivered" });
    expect(fake.sends).toEqual([{ id: "created-1", text: `BM-DELIVERY message ${record!.id}\n${rereviewLineOf("b1")}\nF1: the date now uses the owner's locale.` }]);
    expect(parseDelivery(fake.sends[0]!.text)?.kind).toBe("message");
    expect(reviewCallIdOf(fake.sends[0]!.text)).toBe(record!.id);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.calls.map((call) => [call.kind, call.callId, call.reviewerId])).toEqual([
      ["create", "out-000000000001", "created-1"],
      ["rereview", record!.id, "created-1"],
    ]);
  });

  it("refuses an unknown batch, an archived Reviewer, a second re-review, and a pending binding — sending nothing", async () => {
    const { tools, fake, tick } = setup({ tier: "Large" });
    const unknown = await tools.call("bm_rereview", { batchId: "b7", fixed: "x" }, WORKER_CALLER);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("knows no batch b7");
    expect(await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, { ...WORKER_CALLER, agentId: null })).toEqual({ ok: false, text: PENDING_CALLER_MESSAGE });

    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "first fix" }, WORKER_CALLER)).ok).toBe(true);
    fake.byId("created-1")!.status = "idle";
    tick();
    const second = await tools.call("bm_rereview", { batchId: "b1", fixed: "second fix" }, WORKER_CALLER);
    expect(second.ok).toBe(false);
    expect(second.text).toContain("has had its one re-review");

    await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER);
    fake.byId("created-2")!.archivedAt = T0.toISOString();
    const archived = await tools.call("bm_rereview", { batchId: "b2", fixed: "x" }, WORKER_CALLER);
    expect(archived.ok).toBe(false);
    expect(archived.text).toContain("is archived: create a new batch");
    expect(fake.sends).toHaveLength(1);
  });

  it("a send that fails removes its call: it was not counted", async () => {
    const { tools, home } = setup({
      tier: "Large",
      onSend: ({ id }) => {
        if (id === "created-1") throw new Error("socket closed");
      },
    });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    const result = await tools.call("bm_rereview", { batchId: "b1", fixed: "x" }, WORKER_CALLER);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("it was not counted");
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.batches[0]!.calls.map((call) => call.kind)).toEqual(["create"]);
  });
});

// ---------------------------------------------------------------------------
// The one counter and the refusal (design §16.8).
// ---------------------------------------------------------------------------

describe("one counter: the tools enforce with the number the Dashboard shows (design §16.8)", () => {
  it("tool calls, their BM-BRIEF and BM-DELIVERY messages counted once, a hand-sent message as an off-tool call; the same number in the tool answer and the Dashboard", async () => {
    const { tools, fake, tick, dashboard, record } = setup({ tier: "Small" });
    // The Manager's turn opens the request's row; its Worker's turn follows.
    await record(MANAGER, "manager", "Fix the invoice date format.");
    await record(WORKER, "worker", null, { parentAgentId: MANAGER });
    expect(await dashboard()).toBeNull();

    tick();
    const created = parsed(await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER));
    expect(created["reviewCalls"]).toBe("1 of 2");
    expect(await dashboard()).toBe(1);
    // The Reviewer's turn, with its BM-BRIEF prompt: the same call as its tool record.
    tick();
    await record("created-1", "reviewer", fake.creates[0]!.options.prompt!, { parentAgentId: WORKER });
    expect(await dashboard()).toBe(1);

    tick();
    fake.byId("created-1")!.status = "idle";
    const rereview = parsed(await tools.call("bm_rereview", { batchId: "b1", fixed: "fixed F1" }, WORKER_CALLER));
    expect(rereview["reviewCalls"]).toBe("2 of 2");
    expect(await dashboard()).toBe(2);
    tick();
    await record("created-1", "reviewer", fake.sends.at(-1)!.text, { parentAgentId: WORKER });
    expect(await dashboard()).toBe(2);

    // A message the Worker sent its Reviewer by hand: an off-tool call, counted.
    tick();
    await record("created-1", "reviewer", "Also look at src/pdf.ts, please.", { parentAgentId: WORKER });
    expect(await dashboard()).toBe(3);

    // The budget is reached, by the same count: refused word for word, nothing created or sent.
    tick();
    const creates = fake.creates.length;
    const sends = fake.sends.length;
    const refusal = await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER);
    expect(refusal).toEqual({ ok: false, text: budgetRefusalOf({ requestId: REQ, calls: 3, budget: 2, tier: "Small", batchId: "b2" }) });
    expect(refusal.text).toBe(
      [
        `Review budget reached for ${REQ}: 3 of 2 review calls (Small).`,
        'Ask the owner with bm_questions: subject "review-budget", class "cost", options that grant more',
        '(grant { calls: n } or { untilClean: "b2" }) and one that does not, then report blocked.',
        "Nothing was created or sent.",
      ].join("\n"),
    );
    expect(fake.creates).toHaveLength(creates);
    expect(fake.sends).toHaveLength(sends);
    expect(await dashboard()).toBe(3);
  });

  it("reviewCallCountOf: the union, counted once by id, with the off-tool calls apart", () => {
    const reviewer = "rev-1";
    const records = [
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:00:00.000Z", `${reviewerBriefLineOf(REQ, "b1", "out-aaaaaaaaaaaa")}\nReview batch b1.`)] }),
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:10:00.000Z", "BM-DELIVERY message out-bbbbbbbbbbbb\nRe-review batch b1.")] }),
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:20:00.000Z", "Check src/pdf.ts too.")] }),
      // A stop notice and another delivery kind are no calls.
      turn({ agentId: reviewer, role: "reviewer", sent: [msg(reviewer, "2026-10-03T10:30:00.000Z", "BM-FORMAT your block broke its template.")] }),
    ];
    const tool = [{ callId: "out-aaaaaaaaaaaa" }, { callId: "out-bbbbbbbbbbbb" }, { callId: "out-cccccccccccc" }];
    expect(reviewCallCountOf([reviewer], records, [], tool)).toEqual({ calls: 4, toolCalls: 3, offTool: 1 });
    expect(reviewCallCountOf([reviewer], records)).toEqual({ calls: 3, toolCalls: 0, offTool: 3 });
    // Tool records alone are a count, not "unknown".
    expect(reviewCallCountOf(["rev-unrecorded"], [], [], tool)?.calls).toBe(3);
    expect(reviewCallCountOf(["rev-unrecorded"], [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The grant (design §16.8).
// ---------------------------------------------------------------------------

/** A stored review-budget question of the request, with a grant on each option but the last. */
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

function answered(decision: Decision, optionKey: string, by: "owner" | "policy" = "owner"): Decision {
  const result = answerDecision(decision, { via: "inbox", optionKey, at: T0.toISOString(), ...(by === "policy" ? { by: "policy", class: "cost", reason: "within the owner's cost delegation" } : {}) });
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

/** The `review.over-budget` state of a Small request (budget 2) with `calls` review calls and the grant, if any. */
function overBudgetState(calls: number, reviewGrant?: RuleReviewGrant): string | undefined {
  const input = { traceId: `req:${REQ}`, requestId: REQ, tier: "Small" as const, reviewCalls: calls, inbound: [], ...(reviewGrant === undefined ? {} : { reviewGrant }) };
  return flagsOf(input, { reviewBudget: { Small: 2, Medium: 2, Large: 4 } }).find((flag) => flag.rule === "review.over-budget")?.state;
}

describe("the review-budget grant (design §16.8)", () => {
  it("an owner's grant of N calls lets exactly N more through; an option without a grant grants nothing", async () => {
    const { tools, home, fake } = setup({ tier: "Small" });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER);
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER)).text).toContain("2 of 2 review calls");

    expect(applyReviewBudgetGrants([answered(budgetQuestion({ calls: 2 }, `q:${REQ}:Q9`), "b")], { home })).toEqual([]);
    expect(applyReviewBudgetGrants([answered(budgetQuestion({ calls: 2 }), "a")], { home })).toEqual([`q:${REQ}:Q1`]);
    // Once per decision.
    expect(applyReviewBudgetGrants([answered(budgetQuestion({ calls: 2 }), "a")], { home })).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants).toEqual([{ decisionId: `q:${REQ}:Q1`, calls: 2, untilCleanBatch: null }]);

    expect(parsed(await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b3" }, WORKER_CALLER))["reviewCalls"]).toBe("3 of 4");
    expect(parsed(await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b4" }, WORKER_CALLER))["reviewCalls"]).toBe("4 of 4");
    const over = await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b5" }, WORKER_CALLER);
    expect(over.text).toBe(budgetRefusalOf({ requestId: REQ, calls: 4, budget: 4, tier: "Small", batchId: "b5" }));
    expect(fake.creates).toHaveLength(4);

    // The Orchestrator's review.over-budget rule reads the same ceiling: 4 calls of a granted Small request are not flagged.
    const grant = ruleReviewGrantOf(home, createRequestRegistry(home).get(WS, REQ)!, null);
    expect(grant).toEqual({ calls: 2, untilClean: false });
    expect(overBudgetState(4, grant)).toBeUndefined();
    expect(overBudgetState(4)).toBe("raised");
    expect(overBudgetState(5, grant)).toBe("raised");
  });

  it("a delegated cost policy answers the grant; a precedent's answer never grants", () => {
    const home = dataFolder();
    register(home, "Small");
    const question = budgetQuestion({ calls: 1 });
    const policy: AutonomyPolicy = { projects: { [WS]: { cost: { mode: "delegate", at: T0.toISOString() } } }, challenger: {} };
    // The policy may decide it (bm_decide), and its answer grants as the owner's would.
    expect(decideRefusalOf(policy, question)).toBeNull();
    expect(applyReviewBudgetGrants([answered(question, "a", "policy")], { home })).toEqual([question.id]);
    const byPrecedent = { ...answered(budgetQuestion({ calls: 3 }, `q:${REQ}:Q2`), "a"), answer: { ...answered(budgetQuestion({ calls: 3 }, `q:${REQ}:Q2`), "a").answer!, by: "precedent" as const } };
    expect(applyReviewBudgetGrants([byPrecedent], { home })).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants.map((grant) => grant.calls)).toEqual([1]);
  });

  it("the owner's policy grants at most { calls: 2 }: a larger or untilClean option is never its choice, and such an answer grants nothing", () => {
    const home = dataFolder();
    register(home, "Small");
    const policy: AutonomyPolicy = { projects: { [WS]: { cost: { mode: "delegate", at: T0.toISOString() } } }, challenger: {} };
    // Within the cap: the policy may choose it.
    expect(decideRefusalOf(policy, budgetQuestion({ calls: 2 }), { optionKey: "a", finishedUnverified: false })).toBeNull();
    // Over the cap, or until clean: refused, the question waits for the owner; its no-grant option stays the policy's.
    for (const grant of [{ calls: 3 }, { untilClean: "b1" }]) {
      const question = budgetQuestion(grant);
      expect(decideRefusalOf(policy, question, { optionKey: "a", finishedUnverified: false })).toMatch(/grants more review calls than the owner's policy may .*leave decision .* to the owner/);
      expect(decideRefusalOf(policy, question, { optionKey: "b", finishedUnverified: false })).toBeNull();
    }
    // Should a policy answer ever carry one, it grants nothing; the owner's own answer grants it.
    expect(applyReviewBudgetGrants([answered(budgetQuestion({ calls: 3 }), "a", "policy")], { home })).toEqual([]);
    expect(applyReviewBudgetGrants([answered(budgetQuestion({ untilClean: "b1" }, `q:${REQ}:Q2`), "a", "policy")], { home })).toEqual([]);
    expect(applyReviewBudgetGrants([answered(budgetQuestion({ calls: 3 }, `q:${REQ}:Q3`), "a")], { home })).toEqual([`q:${REQ}:Q3`]);
    expect(createRequestRegistry(home).get(WS, REQ)!.reviews.grants.map((grant) => grant.calls)).toEqual([3]);
  });

  it("an untilClean grant: its calls are counted but not refused, its one-re-review limit lifted, until the batch passes", async () => {
    const { tools, home, fake, tick } = setup({ tier: "Small" });
    await tools.call("bm_create_reviewer", INPUT, WORKER_CALLER);
    tick();
    await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 1" }, WORKER_CALLER);
    fake.byId("created-1")!.status = "idle";
    tick();
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 2" }, WORKER_CALLER)).text).toContain("has had its one re-review");

    applyReviewBudgetGrants([answered(budgetQuestion({ untilClean: "b1" }), "a")], { home });
    const third = parsed(await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 2" }, WORKER_CALLER));
    expect(third["reviewCalls"]).toBe("3 of 2");
    fake.byId("created-1")!.status = "idle";
    tick();
    expect(parsed(await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 3" }, WORKER_CALLER))["reviewCalls"]).toBe("4 of 2");
    // Another batch is not covered.
    expect((await tools.call("bm_create_reviewer", { ...INPUT, batchId: "b2" }, WORKER_CALLER)).text).toContain("Review budget reached");

    // A live untilClean grant: the rule does not flag its 4 calls either.
    expect(ruleReviewGrantOf(home, createRequestRegistry(home).get(WS, REQ)!, null)).toEqual({ calls: 0, untilClean: true });
    expect(overBudgetState(4, ruleReviewGrantOf(home, createRequestRegistry(home).get(WS, REQ)!, null))).toBeUndefined();

    // b1 passes: the grant ends.
    createOutbox(home).add(WS, { kind: "review", requestId: REQ, batchId: "b1", from: "created-1", to: WORKER, text: "BM-REVIEW\nrequestId: " + REQ + "\nbatchId: b1\nverdict: pass\n" });
    expect(ruleReviewGrantOf(home, createRequestRegistry(home).get(WS, REQ)!, null)).toEqual({ calls: 0, untilClean: false });
    fake.byId("created-1")!.status = "idle";
    tick();
    expect((await tools.call("bm_rereview", { batchId: "b1", fixed: "fix 4" }, WORKER_CALLER)).text).toContain("has had its one re-review");
  });
});
