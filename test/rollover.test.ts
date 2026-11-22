import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createQuestionDecisionDelivery, soleWorkerOfRequest } from "../plugin/server/decision-delivery";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { batchesAwaitingVerdict, createDeliveringTools } from "../plugin/server/deliver-tools";
import { createHandoffStore } from "../plugin/server/handoff-store";
import { clearRequestIndexCache } from "../plugin/server/mission-roster";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { clearRequestRegistryCache, createRequestRegistry, noteReviewResult } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { rolloverCrossingOf, rolloverFiguresOf, rolloverTurnRecorded, rolloverWaitedOf } from "../plugin/server/rollover";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { answerDecision } from "../plugin/shared/decisions";
import { MAINTENANCE_WAIT_MS } from "../plugin/shared/interventions";
import { report, turn } from "./fixtures/orchestrator-traces";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { WORKER_CALLER } from "./helpers/bindings";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeAgent, type FakeCreateRequest } from "./helpers/fake-paseo";

/**
 * Size rollover (delivery line design §2.6, §2.7): one `BM-ROLLOVER soft` per
 * request at a figure, `BM-ROLLOVER now` at `ceilingFactor` × one; a
 * `finished` with `remaining` after either opens a size continuation, which
 * the Main's delivery names; at the hard figure the request's questions and
 * links carry over. Temporary data folders and the one fake daemon only.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const T0 = new Date("2026-10-03T12:00:00.000Z");
const BRIEF = [`BM-BRIEF worker requestId: ${REQ}`, "The owner's request, verbatim:", "> Export the orders.", ">", "> As CSV.", "", `requestId: ${REQ}`].join("\n");

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearBeadsCache();
  clearJsonFileCache();
  forgetModes();
  removeDataFolders();
});

function setup() {
  const home = dataFolder();
  const repo = join(dirname(home), "repo");
  mkdirSync(join(repo, ".beads"), { recursive: true });
  const store: BindingStore = createBindingStore(home);
  const worker: FakeAgent = { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, cwd: repo, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } };
  const fake = fakePaseo({
    agents: [{ id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, cwd: repo, labels: { "bm.role": "manager" } }, worker],
    workspaces: [{ id: WS, directory: repo }],
    timelines: { [WORKER]: [{ item: { type: "user_message", text: BRIEF } }] },
    config: {
      agentProfiles: [{ id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" }],
      providers: { "bm-worker": { extends: "claude" }, "bm-manager": { extends: "claude" } },
      mcp: { injectIntoAgents: true },
    },
    created: (request: FakeCreateRequest) => {
      applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "claude");
      return {};
    },
  });
  const logs: string[] = [];
  let n = 0;
  const queue = createNoticeQueue({ log: () => {} });
  const tools = createDeliveringTools({
    paseo: () => fake.paseo,
    home: () => home,
    log: (line) => logs.push(line),
    now: () => T0,
    queue,
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    binder: () => binderOf(ROLE_URL, store, (line) => logs.push(line)),
  });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
  const finish = (input: Record<string, unknown> = {}) =>
    tools.worker.call("bm_report", { requestId: REQ, phase: "finished", tier: { level: "Medium" }, buildAndTests: "`npm test` pass", ...input }, WORKER_CALLER);
  const asked = (level: "soft" | "now") => createRequestRegistry(home).noteRolloverAsked(WS, REQ, { level, figure: level === "soft" ? "10 turns" : "20 turns", at: T0.toISOString() });
  return { home, repo, fake, logs, queue, tools, finish, asked };
}

describe("the rollover figures and notices (delivery line design §2.6)", () => {
  it("counts beads closed in the request's reports, its Worker turns and its tokens; soft at a figure, now at ceilingFactor × one, nothing while off", () => {
    const records = [
      turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t1", reports: [report({ requestId: REQ, beadsClosed: ["bd-1", "bd-2"] })] }),
      turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t2", reports: [report({ requestId: REQ, beadsClosed: ["bd-2", "bd-3"] })] }),
      turn({ workspaceId: WS, agentId: "agent-reviewer", role: "reviewer", requestId: REQ, turnId: "t3" }),
      turn({ workspaceId: WS, agentId: "agent-other", role: "worker", requestId: "req-20261003T110000Z", turnId: "t4" }),
    ];
    expect(rolloverFiguresOf(records, REQ)).toEqual({ beads: 3, turns: 2, tokens: 0, context: null });
    const settings = DEFAULT_COORDINATION_SETTINGS;
    expect(rolloverCrossingOf({ beads: 14, turns: 39, tokens: 49_000_000, context: 179_999 }, settings)).toBeNull();
    expect(rolloverCrossingOf({ beads: 15, turns: 0, tokens: 0, context: null }, settings)).toEqual({ level: "soft", figure: "15 beads closed" });
    expect(rolloverCrossingOf({ beads: 16, turns: 80, tokens: 0, context: null }, settings)).toEqual({ level: "now", figure: "80 turns" });
    expect(rolloverCrossingOf({ beads: 0, turns: 0, tokens: 100_400_000, context: null }, settings)).toEqual({ level: "now", figure: "100M tokens read" });
    expect(rolloverCrossingOf({ beads: 99, turns: 99, tokens: 0, context: 900_000 }, { rollover: { ...settings.rollover, enabled: false } })).toBeNull();
  });

  it("ADR-036 §17.3: the judged turn's own context is a figure — soft at rollover.contextTokens (180k), now at ceilingFactor × it; never a sum over turns", () => {
    const usage = (contextUsed?: number) => ({ inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, costUsd: null, costBasis: "unavailable" as const, model: "claude-opus-5", pricesUpdatedAt: null, ...(contextUsed === undefined ? {} : { contextUsed }) });
    const t1 = turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t1", usage: usage(200_000) });
    const t2 = turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: "t2", usage: usage(180_000) });
    // Two turns at 200k and 180k: the second turn's context is 180k, not 380k.
    expect(rolloverFiguresOf([t1, t2], REQ, t2).context).toBe(180_000);
    expect(rolloverFiguresOf([t1, t2], REQ, turn({ usage: usage() })).context).toBeNull();
    const settings = DEFAULT_COORDINATION_SETTINGS;
    expect(settings.rollover.contextTokens).toBe(180_000);
    const at = (context: number) => rolloverCrossingOf({ beads: 0, turns: 0, tokens: 0, context }, settings);
    expect(at(179_999)).toBeNull();
    expect(at(180_000)).toEqual({ level: "soft", figure: "context 180k" });
    expect(at(192_400)).toEqual({ level: "soft", figure: "context 192k" });
    expect(at(359_999)).toEqual({ level: "soft", figure: "context 360k" });
    expect(at(360_000)).toEqual({ level: "now", figure: "context 360k" });
    expect(rolloverCrossingOf({ beads: 0, turns: 0, tokens: 0, context: 300_000 }, { rollover: { ...settings.rollover, contextTokens: 100_000, ceilingFactor: 3 } })).toEqual({ level: "now", figure: "context 300k" });
  });

  it("at a recorded Worker turn, BM-ROLLOVER soft at 180k context and now at 360k (ADR-036 §17.3)", async () => {
    const { home } = setup();
    const sent: string[] = [];
    const queue = { enqueue: async (_to: string, _kind: string, text: string) => (sent.push(text), "sent" as const) };
    const location = { tracesDir: join(home, "traces") };
    const turnAt = async (i: number, contextUsed: number) => {
      const record = turn({
        workspaceId: WS,
        agentId: WORKER,
        role: "worker",
        requestId: REQ,
        turnId: `t${i}`,
        at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z`,
        usage: { inputTokens: 10, cachedInputTokens: contextUsed, outputTokens: 10, costUsd: null, costBasis: "unavailable", model: "claude-opus-5", pricesUpdatedAt: null, contextUsed },
      });
      await appendRecord(location, record);
      return rolloverTurnRecorded(home, record, null, { queue, now: () => T0 });
    };
    expect(await turnAt(1, 170_000)).toBeNull();
    expect(await turnAt(2, 192_000)).toBe("soft");
    expect(await turnAt(3, 300_000)).toBeNull();
    expect(await turnAt(4, 370_000)).toBe("now");
    expect(sent.map((text) => text.split("\n").slice(0, 2).join(" | "))).toEqual([
      `BM-ROLLOVER soft | From the paseo-bm plugin, not the owner: request ${REQ} reached context 192k.`,
      `BM-ROLLOVER now | From the paseo-bm plugin, not the owner: request ${REQ} reached context 370k.`,
    ]);
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toEqual({ level: "now", figure: "context 370k", at: T0.toISOString(), workerId: WORKER });
  });

  describe("a batch a BM-ROLLOVER now carries on with no verdict yet (ADR-046)", () => {
    const REVIEWER = "agent-reviewer";
    const BLOCKING = { severity: "blocking", location: "src/a.ts:3", reason: "Off by one.", suggestedFix: "Use <=." };
    const reviewerCaller = { agentId: REVIEWER, role: "reviewer" as const, workspaceId: WS, requestId: REQ, parentId: WORKER, batchId: "b1" };
    const review = (requestId = REQ) => ({ requestId, batchId: "b1", reviewKind: "first", checked: "src/a.ts; npm test pass", notChecked: "none", findings: [BLOCKING] });

    const moved = async () => {
      const context = setup();
      createRequestRegistry(context.home).addReviewCall(WS, REQ, "b1", { callId: "call-b1", kind: "create", reviewerId: REVIEWER, at: new Date(T0.getTime() - 60_000).toISOString() }, "Review src/a.ts");
      context.asked("now");
      expect((await context.finish({ remaining: ["the rest"] })).ok).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      const nextId = createRequestRegistry(context.home).get(WS, REQ)!.continuedBy!;
      const workerId = createRequestRegistry(context.home).get(WS, nextId)!.workerIds.at(-1)!;
      return { ...context, nextId, workerId };
    };

    it("is copied to the continuation, its newest call awaited, and its brief says the verdict is coming", async () => {
      const { home, fake, nextId } = await moved();
      const next = createRequestRegistry(home).get(WS, nextId)!;
      expect(next.reviews.batches).toHaveLength(1);
      expect(next.reviews.batches[0]).toMatchObject({ batchId: "b1", adoptedFrom: REQ, results: [] });
      expect(next.reviews.batches[0]!.calls.map((call) => [call.callId, call.adopted, call.awaited])).toEqual([["call-b1", true, true]]);
      expect(fake.creates.at(-1)!.options.prompt).toContain("review batches with a verdict on its way: b1: it comes to you");
      expect(batchesAwaitingVerdict(next, createOutbox(home, { now: () => T0 }).list(WS), T0)).toEqual(["b1"]);
    });

    it("a verdict that lands after the batch moved is stored on the carried batch and reaches the continuation's Worker", async () => {
      const { home, fake, tools, nextId, workerId } = await moved();
      const answer = await tools.reviewer.call("bm_review", review(), reviewerCaller);
      expect(answer.ok).toBe(true);
      const registry = createRequestRegistry(home);
      for (const id of [REQ, nextId]) {
        expect(registry.get(WS, id)!.reviews.batches[0]!.results).toMatchObject([{ verdict: "changes-required", blocking: 1 }]);
      }
      const [record] = createOutbox(home, { now: () => T0 }).list(WS).filter((entry) => entry.kind === "review");
      expect(record).toMatchObject({ requestId: REQ, batchId: "b1", to: workerId, state: "delivered" });
      expect(fake.sends.filter((entry) => entry.id === workerId && entry.text.includes("verdict: changes-required"))).toHaveLength(1);
      expect(fake.sends.filter((entry) => entry.id === WORKER)).toEqual([]);
      expect(batchesAwaitingVerdict(registry.get(WS, nextId), createOutbox(home, { now: () => T0 }).list(WS), T0)).toEqual([]);
    });

    it("a no-verdict of it settles the copy too, and a chain of two continuations stores it on each", async () => {
      const { home, tools, nextId } = await moved();
      const registry = createRequestRegistry(home);
      const lastId = "req-20261003T130000Z";
      registry.register(WS, lastId, { source: "tool", managerId: MANAGER, workerId: "agent-last" });
      registry.adoptReviewBatches(WS, lastId, registry.get(WS, nextId)!.reviews.batches, nextId);
      registry.noteContinuedBy(WS, nextId, lastId, { reason: "size", figure: "20 turns", at: T0.toISOString() });
      expect((await tools.reviewer.call("bm_review", review(), reviewerCaller)).ok).toBe(true);
      for (const id of [REQ, nextId, lastId]) expect(createRequestRegistry(home).get(WS, id)!.reviews.batches[0]!.results).toHaveLength(1);
    });

    it("a batch the continuation opened itself under the same id takes no result of the predecessor's Reviewer", () => {
      const { home } = setup();
      const registry = createRequestRegistry(home);
      const nextId = "req-20261003T130000Z";
      registry.register(WS, nextId, { source: "tool", managerId: MANAGER, workerId: "agent-next" });
      registry.addReviewCall(WS, nextId, "b1", { callId: "call-own", kind: "create", reviewerId: "agent-own", at: T0.toISOString() }, "Its own batch");
      registry.addReviewCall(WS, REQ, "b1", { callId: "call-b1", kind: "create", reviewerId: REVIEWER, at: T0.toISOString() }, "Review src/a.ts");
      registry.noteContinuedBy(WS, REQ, nextId, { reason: "size", figure: "20 turns", at: T0.toISOString() });
      noteReviewResult(home, WS, { id: "out-1", kind: "no-verdict", requestId: REQ, batchId: "b1", from: REVIEWER, createdAt: T0.toISOString(), text: "" });
      expect(registry.get(WS, REQ)!.reviews.batches[0]!.results).toHaveLength(1);
      expect(registry.get(WS, nextId)!.reviews.batches[0]!.results).toHaveLength(0);
    });

    it("a batch answered before the finish goes on as any open batch, not awaited", async () => {
      const context = setup();
      const registry = createRequestRegistry(context.home);
      registry.addReviewCall(WS, REQ, "b1", { callId: "call-b1", kind: "create", reviewerId: REVIEWER, at: new Date(T0.getTime() - 60_000).toISOString() }, "Review src/a.ts");
      expect((await context.tools.reviewer.call("bm_review", review(), reviewerCaller)).ok).toBe(true);
      context.asked("now");
      expect((await context.finish({ remaining: ["the rest"] })).ok).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      const nextId = createRequestRegistry(context.home).get(WS, REQ)!.continuedBy!;
      expect(createRequestRegistry(context.home).get(WS, nextId)!.reviews.batches[0]!.calls.map((call) => call.awaited)).toEqual([undefined]);
    });
  });

  describe("BM-ROLLOVER now goes to the request's current Worker, whatever its reviews (ADR-046)", () => {
    const REVIEWER = "agent-reviewer";
    const SUCCESSOR = "agent-successor";
    const running = (home: string) => {
      const sent: Array<[string, string]> = [];
      const queue = { enqueue: async (to: string, _kind: string, text: string) => (sent.push([to, text.split("\n")[0]!]), "sent" as const) };
      const location = { tracesDir: join(home, "traces") };
      let i = 0;
      const turnAt = async (contextUsed: number, agentId = WORKER) => {
        i += 1;
        const record = turn({
          workspaceId: WS,
          agentId,
          role: "worker",
          requestId: REQ,
          turnId: `t${i}`,
          at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z`,
          usage: { inputTokens: 10, cachedInputTokens: contextUsed, outputTokens: 10, costUsd: null, costBasis: "unavailable", model: "claude-opus-5", pricesUpdatedAt: null, contextUsed },
        });
        await appendRecord(location, record);
        return rolloverTurnRecorded(home, record, null, { queue, now: () => T0 });
      };
      return { sent, turnAt };
    };

    it("is sent while a review has no verdict, and finished with remaining is then accepted", async () => {
      const { home, finish } = setup();
      createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "call-b1", kind: "create", reviewerId: REVIEWER, at: new Date(T0.getTime() - 60_000).toISOString() }, "Review src/a.ts");
      const { sent, turnAt } = running(home);
      expect(await turnAt(400_000)).toBe("now");
      expect(sent).toEqual([[WORKER, "BM-ROLLOVER now"]]);
      expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toEqual({ level: "now", figure: "context 400k", at: T0.toISOString(), workerId: WORKER });
      expect((await finish({ remaining: ["the rest"] })).ok).toBe(true);
    });

    it("a finished without remaining, or after only the soft notice, still waits for the verdict", async () => {
      const { home, finish, asked } = setup();
      createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "call-b1", kind: "create", reviewerId: REVIEWER, at: new Date(T0.getTime() - 60_000).toISOString() }, "Review src/a.ts");
      asked("soft");
      expect((await finish({ remaining: ["the rest"] })).text).toContain("a review of batch b1 has no verdict yet");
      asked("now");
      expect((await finish()).text).toContain("a review of batch b1 has no verdict yet");
    });

    it("is asked once per Worker: a later Worker of the request hears it too, though context is measured per turn and its own is low", async () => {
      const { home } = setup();
      const { sent, turnAt } = running(home);
      expect(await turnAt(400_000)).toBe("now");
      expect(await turnAt(400_000)).toBeNull();
      createRequestRegistry(home).addWorker(WS, REQ, SUCCESSOR);
      // The successor's own context is below even the soft figure: the request was asked `now`, so it is asked again, in the stored words.
      expect(await turnAt(50_000, SUCCESSOR)).toBe("now");
      expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toEqual({ level: "now", figure: "context 400k", at: T0.toISOString(), workerId: SUCCESSOR });
      expect(await turnAt(400_000, SUCCESSOR)).toBeNull();
      expect(await turnAt(50_000, SUCCESSOR)).toBeNull();
      expect(await turnAt(400_000)).toBeNull();
      expect(sent).toEqual([[WORKER, "BM-ROLLOVER now"], [SUCCESSOR, "BM-ROLLOVER now"]]);
    });

    it("a stored now from an older build, which names no Worker, is not asked again", async () => {
      const { home, asked } = setup();
      asked("now");
      const { sent, turnAt } = running(home);
      expect(await turnAt(400_000)).toBeNull();
      expect(sent).toEqual([]);
    });

    it("is not sent to a Worker whose handoff has asked for its note; its successor is asked", async () => {
      const { home } = setup();
      const store = createHandoffStore(home);
      const entry = store.add({ workspaceId: WS, requestId: REQ, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "It grew past the threshold." });
      const { sent, turnAt } = running(home);
      store.update(entry.id, (current) => ({ ...current, state: "noting", noteAskedAt: T0.toISOString() }));
      expect(await turnAt(400_000)).toBeNull();
      expect(sent).toEqual([]);
      expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toBeUndefined();
      createRequestRegistry(home).addWorker(WS, REQ, SUCCESSOR);
      expect(await turnAt(400_000, SUCCESSOR)).toBe("now");
      expect(sent).toEqual([[SUCCESSOR, "BM-ROLLOVER now"]]);
    });
  });

  it("queues one BM-ROLLOVER soft per request, then BM-ROLLOVER now at twice the figure, to the request's newest Worker", async () => {
    const { home } = setup();
    createCoordinationStore(home).set({ key: "rollover.turns", value: 10 });
    const sent: Array<{ to: string; kind: string; text: string; first: boolean }> = [];
    const queue = {
      enqueue: async (to: string, kind: string, text: string, _paseo?: unknown, _callbacks?: unknown, options?: { first?: boolean }) => (
        sent.push({ to, kind, text, first: options?.first === true }), "sent" as const
      ),
    };
    const location = { tracesDir: join(home, "traces") };
    const turnAt = async (i: number) => {
      const record = turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: `t${i}`, at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z` });
      await appendRecord(location, record);
      return rolloverTurnRecorded(home, record, null, { queue, now: () => T0 });
    };
    const levels: Array<string | null> = [];
    for (let i = 1; i <= 21; i += 1) levels.push(await turnAt(i));
    expect(levels.filter((level) => level !== null)).toEqual(["soft", "now"]);
    expect(levels.indexOf("soft")).toBe(9);
    expect(levels.indexOf("now")).toBe(19);
    // Design §6.6: the hard notice goes ahead of what is queued for the Worker; the soft one in its turn.
    expect(sent.map((entry) => [entry.to, entry.kind, entry.first])).toEqual([
      [WORKER, "BM-ROLLOVER", false],
      [WORKER, "BM-ROLLOVER", true],
    ]);
    expect(sent[0]!.text.split("\n")).toEqual([
      "BM-ROLLOVER soft",
      `From the paseo-bm plugin, not the owner: request ${REQ} reached 10 turns.`,
      "Finish the bead in progress, review as your tier says, and report `finished` with `remaining`; paseo-bm opens the continuation.",
    ]);
    expect(sent[1]!.text.split("\n")).toEqual([
      "BM-ROLLOVER now",
      `From the paseo-bm plugin, not the owner: request ${REQ} reached 20 turns.`,
      "Report `finished` with `remaining` at the end of this turn; put the work in progress in `remaining`.",
    ]);
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toEqual({ level: "now", figure: "20 turns", at: T0.toISOString(), workerId: WORKER });
    // A Reviewer's turn, and an older Worker of the request, are never asked.
    expect(await rolloverTurnRecorded(home, turn({ workspaceId: WS, agentId: "agent-reviewer", role: "reviewer", requestId: REQ }), null, { queue })).toBeNull();
  });
});

describe("the time ceiling: a soft notice that waited 30 minutes becomes BM-ROLLOVER now (delivery line design §6.6, ADR-051 decision 2)", () => {
  const MIN = 60_000;
  const SUCCESSOR = "agent-successor";
  const WAITED = `From the paseo-bm plugin, not the owner: request ${REQ} reached 10 turns, then 30 minutes without rolling over.`;
  const after = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

  /** The request was asked `BM-ROLLOVER soft` at T0 (`asked("soft")`, 10 turns); each turn is the Worker's, below every figure unless `contextUsed` says otherwise. */
  const waiting = () => {
    const context = setup();
    context.asked("soft");
    const sent: Array<{ to: string; text: string; first: boolean }> = [];
    const queue = {
      enqueue: async (to: string, _kind: string, text: string, _paseo?: unknown, _callbacks?: unknown, options?: { first?: boolean }) => (
        sent.push({ to, text, first: options?.first === true }), "sent" as const
      ),
    };
    const location = { tracesDir: join(context.home, "traces") };
    let i = 0;
    const turnAt = async (minutes: number, agentId = WORKER, contextUsed?: number) => {
      i += 1;
      const record = turn({
        workspaceId: WS,
        agentId,
        role: "worker",
        requestId: REQ,
        turnId: `t${i}`,
        at: after(minutes).toISOString(),
        ...(contextUsed === undefined ? {} : { usage: { inputTokens: 10, cachedInputTokens: contextUsed, outputTokens: 10, costUsd: null, costBasis: "unavailable" as const, model: "claude-opus-5", pricesUpdatedAt: null, contextUsed } }),
      });
      await appendRecord(location, record);
      return rolloverTurnRecorded(context.home, record, null, { queue, now: () => after(minutes) });
    };
    const askedNow = () => createRequestRegistry(context.home).get(WS, REQ)?.rolloverAsked;
    return { ...context, sent, turnAt, askedNow };
  };

  it("waits 30 minutes: a soft asked 29 minutes ago stays soft; at 30 one BM-ROLLOVER now goes first to the current Worker, once", async () => {
    expect(MAINTENANCE_WAIT_MS.rollover).toBe(30 * MIN);
    const { sent, turnAt, askedNow } = waiting();
    expect(await turnAt(29)).toBeNull();
    expect(askedNow()).toEqual({ level: "soft", figure: "10 turns", at: T0.toISOString() });
    expect(await turnAt(30)).toBe("now");
    expect(await turnAt(31)).toBeNull();
    expect(await turnAt(90)).toBeNull();
    expect(sent.map((entry) => [entry.to, entry.first, ...entry.text.split("\n").slice(0, 2)])).toEqual([[WORKER, true, "BM-ROLLOVER now", WAITED]]);
    expect(askedNow()).toEqual({ level: "now", figure: "10 turns, then 30 minutes without rolling over", at: after(30).toISOString(), workerId: WORKER });
  });

  it("a later Worker of the request is asked again, once, in the same words; the Worker already asked and an older Worker never", async () => {
    const { home, sent, turnAt, askedNow } = waiting();
    expect(await turnAt(30)).toBe("now");
    expect(await turnAt(35)).toBeNull();
    createRequestRegistry(home).addWorker(WS, REQ, SUCCESSOR);
    expect(await turnAt(40)).toBeNull();
    expect(await turnAt(41, SUCCESSOR)).toBe("now");
    expect(await turnAt(42, SUCCESSOR)).toBeNull();
    expect(sent.map((entry) => [entry.to, entry.first, entry.text.split("\n")[1]])).toEqual([[WORKER, true, WAITED], [SUCCESSOR, true, WAITED]]);
    expect(askedNow()).toEqual({ level: "now", figure: "10 turns, then 30 minutes without rolling over", at: after(41).toISOString(), workerId: SUCCESSOR });
  });

  it("the figure ceiling still works, in its own words, before the wait or after it", async () => {
    const early = waiting();
    expect(await early.turnAt(10, WORKER, 400_000)).toBe("now");
    expect(early.sent.map((entry) => entry.text.split("\n")[1])).toEqual([`From the paseo-bm plugin, not the owner: request ${REQ} reached context 400k.`]);
    const late = waiting();
    expect(await late.turnAt(45, WORKER, 400_000)).toBe("now");
    expect(late.askedNow()).toMatchObject({ level: "now", figure: "context 400k", workerId: WORKER });
    expect(late.sent).toHaveLength(1);
  });

  it("a finished request, a continued one, a Worker whose handoff is under way, and rollover turned off get none", async () => {
    const finished = waiting();
    createRequestRegistry(finished.home).noteReport(WS, REQ, { tier: "Medium", phase: "finished", at: after(20).toISOString() });
    expect(await finished.turnAt(30)).toBeNull();

    const continued = waiting();
    createRequestRegistry(continued.home).noteContinuedBy(WS, REQ, "req-20261003T130000Z", { reason: "size", figure: "10 turns", at: after(20).toISOString() });
    expect(await continued.turnAt(30)).toBeNull();

    const handingOff = waiting();
    const store = createHandoffStore(handingOff.home);
    const entry = store.add({ workspaceId: WS, requestId: REQ, workerId: WORKER, managerId: MANAGER, interventionId: null, reason: "It grew past the threshold." });
    store.update(entry.id, (current) => ({ ...current, state: "noting", noteAskedAt: after(25).toISOString() }));
    expect(await handingOff.turnAt(30)).toBeNull();
    expect(handingOff.askedNow()?.level).toBe("soft");

    const off = waiting();
    createCoordinationStore(off.home).set({ key: "rollover.enabled", value: false });
    expect(await off.turnAt(30)).toBeNull();

    for (const context of [finished, continued, handingOff, off]) expect(context.sent).toEqual([]);
  });

  it("rolloverWaitedOf is the rule, pure", () => {
    const soft = { level: "soft" as const, figure: "15 beads closed", at: T0.toISOString() };
    const open = { finishedAt: null, rolloverAsked: soft };
    expect(rolloverWaitedOf(open, after(29))).toBeNull();
    expect(rolloverWaitedOf(open, after(30))).toEqual({ level: "now", figure: "15 beads closed, then 30 minutes without rolling over" });
    expect(rolloverWaitedOf({ finishedAt: null }, after(90))).toBeNull();
    expect(rolloverWaitedOf({ ...open, finishedAt: after(10).toISOString() }, after(90))).toBeNull();
    expect(rolloverWaitedOf({ ...open, continuedBy: "req-20261003T130000Z" }, after(90))).toBeNull();
    // A `now` already asked is not the time ceiling's: the turn's pass asks it again of a later Worker itself (ADR-046).
    expect(rolloverWaitedOf({ finishedAt: null, rolloverAsked: { level: "now", figure: "20 turns", at: T0.toISOString(), workerId: WORKER } }, after(90))).toBeNull();
    expect(rolloverWaitedOf({ finishedAt: null, rolloverAsked: { level: "now", figure: "15 beads closed, then 30 minutes without rolling over", at: T0.toISOString(), workerId: WORKER } }, after(90))).toBeNull();
  });
});

describe("BM-ROLLOVER soft and the gate at the send (delivery line design §6.4)", () => {
  it("queued while the Worker ran, it is held when that turn reported blocked, forgotten, and asked again once the Worker waits on nothing", async () => {
    const { home } = setup();
    createCoordinationStore(home).set({ key: "rollover.turns", value: 10 });
    const fake = fakePaseo({ agents: [{ id: WORKER, provider: "bm-worker/claude-opus-5", status: "running", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ } }] });
    const queue = createNoticeQueue({ log: () => {} });
    const turnOf = (i: number) => turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, turnId: `t${i}`, at: `2026-10-03T10:${String(i).padStart(2, "0")}:00.000Z` });
    for (let i = 1; i <= 10; i += 1) await appendRecord({ tracesDir: join(home, "traces") }, turnOf(i));
    const record = turnOf(10);
    expect(await rolloverTurnRecorded(home, record, fake.paseo, { queue, now: () => T0 })).toBe("soft");
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked?.level).toBe("soft");
    // The running turn reports `blocked` on Q1.
    createRequestRegistry(home).setWaiting(WS, REQ, { since: T0.toISOString(), reportRecordId: "out-0000000000ff", wakeOn: "all", items: [{ kind: "question", id: `q:${REQ}:Q1`, settled: false }] });
    fake.byId(WORKER)!.status = "idle";
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)?.rolloverAsked).toBeUndefined();
    // Still waiting: not asked; once the wait is gone, asked again.
    expect(await rolloverTurnRecorded(home, record, fake.paseo, { queue, now: () => T0 })).toBeNull();
    createRequestRegistry(home).setWaiting(WS, REQ, null);
    expect(await rolloverTurnRecorded(home, record, fake.paseo, { queue, now: () => T0 })).toBe("soft");
    expect(fake.sends.map((send) => send.text.split("\n")[0])).toEqual(["BM-ROLLOVER soft"]);
  });
});

describe("a finished with remaining after a rollover notice opens a size continuation (delivery line design §2.4 item 2, §2.6, §2.7)", () => {
  it("at the soft figure: the root's request verbatim and Remaining, the brief's remaining line, the Main's continued line; questions expire as on any finish", async () => {
    const { home, fake, finish, asked } = setup();
    asked("soft");
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ}:Q2`, workspaceId: WS, requestId: REQ, question: "Which locale?" }));

    const answer = await finish({ beadsClosed: ["bd-1"], remaining: ["bd-3: the CSV export", "b1 finding: rename the column"] });
    expect(answer.ok, answer.text).toBe(true);

    const registry = createRequestRegistry(home);
    const next = registry.get(WS, REQ)!.continuedBy!;
    expect(registry.get(WS, REQ)).toMatchObject({ rollover: { reason: "size", figure: "10 turns", at: T0.toISOString() } });
    expect(registry.get(WS, REQ)!.finishedAt).not.toBeNull();
    expect(registry.get(WS, next)).toMatchObject({ continuationOf: REQ, chainRootId: REQ, workerIds: ["created-1"], finishedAt: null });

    const lines = fake.creates[0]!.options.prompt!.split("\n");
    expect(lines.slice(0, 10)).toEqual([
      `BM-BRIEF worker requestId: ${next}`,
      "The owner's request, verbatim:",
      "> Export the orders.",
      ">",
      "> As CSV.",
      ">",
      "> Remaining:",
      "> - bd-3: the CSV export",
      "> - b1 finding: rename the column",
      "",
    ]);
    expect(lines).toContain(`continues: ${REQ} (size: 10 turns)`);
    expect(lines).toContain(`${REQ} last reported: finished at ${T0.toISOString()}`);
    expect(lines).toContain("remaining: bd-3: the CSV export; b1 finding: rename the column");

    // §2.7: the Main's delivery of the finished report names the continuation, before the block.
    const delivered = fake.sends.filter((send) => send.id === MANAGER);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text.split("\n").slice(0, 3)).toEqual(["BM-DELIVERY report out-000000000001", `continued: ${next} by Worker created-1 (size: 10 turns)`, "BM-REPORT"]);
    // At the soft figure the Worker settled its questions itself: what is left expires as on any finish.
    expect(createDecisionStore(home).get(`q:${REQ}:Q2`, WS)?.status).not.toBe("open");
  });

  it("at the hard figure: the open question stays, its answer reaches the continuation's Worker, and the request's live links move to it", async () => {
    const { home, fake, finish, asked, queue } = setup();
    asked("now");
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ}:Q2`, workspaceId: WS, requestId: REQ, question: "Which locale?", options: [{ key: "a", label: "en", recommended: true, effects: ["none"] }, { key: "b", label: "de", recommended: false, effects: ["none"] }] }));
    const links = createPeerLinkStore(home);
    const taken = links.createLink({ kind: "question", from: { workspaceId: "wks_other", requestId: "req-20261003T090000Z", agentId: "agent-other", role: "worker" }, to: { workspaceId: WS, managerId: MANAGER, requestId: REQ, workerId: WORKER }, text: "What format?" });
    const mine = links.createLink({ kind: "question", from: { workspaceId: WS, requestId: REQ, agentId: WORKER, role: "worker" }, to: { workspaceId: "wks_third", managerId: "agent-third-manager" }, text: "Which schema?" });
    if (!taken.ok || !mine.ok) throw new Error("links not created");

    // No forPeer: the link it answers carries over instead of getting a reply.
    const answer = await finish({ remaining: ["bd-4: the totals, half done"] });
    expect(answer.ok, answer.text).toBe(true);
    const next = createRequestRegistry(home).get(WS, REQ)!.continuedBy!;

    expect(createDecisionStore(home).get(`q:${REQ}:Q2`, WS)?.status).toBe("open");
    expect(createPeerLinkStore(home).get(taken.link.linkId)).toMatchObject({ state: "taken", to: { requestId: next, workerId: "created-1" }, messages: [] });
    expect(createPeerLinkStore(home).get(mine.link.linkId)).toMatchObject({ state: "open", from: { requestId: next, agentId: "created-1" } });
    expect(await soleWorkerOfRequest({ workspaceId: WS, requestId: REQ, home }, fake.paseo as unknown as DashboardPaseo)).toBe("created-1");

    // The owner answers q:A:Q2: the answers go to B's Worker.
    createDecisionStore(home).transition(`q:${REQ}:Q2`, (current) => answerDecision(current, { via: "inbox", optionKey: "b", words: null, at: T0.toISOString() }), WS);
    await createQuestionDecisionDelivery({ home: () => home, now: () => T0, log: () => {}, queue }).resume(fake.paseo);
    const toNext = fake.sends.filter((send) => send.id === "created-1");
    expect(toNext).toHaveLength(1);
    expect(toNext[0]!.text).toContain("Q2: b — de");
  });

  it("a finished with remaining but no rollover notice opens nothing; remaining is only for finished", async () => {
    const { home, fake, finish } = setup();
    const received = await finish({ phase: "received", remaining: ["bd-3"] });
    expect(received.ok).toBe(false);
    expect(received.text).toContain("input.remaining: only a finished report lists what remains; leave it out");
    expect((await finish({ remaining: ["bd-3"] })).ok).toBe(true);
    expect(createRequestRegistry(home).get(WS, REQ)!.continuedBy).toBeUndefined();
    expect(fake.creates).toEqual([]);
  });

  it("at the soft figure a finished with a verdict in flight is still refused, and nothing opens (at now it carries the batch on, ADR-046)", async () => {
    const { home, fake, finish, asked } = setup();
    asked("soft");
    createRequestRegistry(home).addReviewCall(WS, REQ, "b1", { callId: "call-1", kind: "create", reviewerId: "agent-reviewer", at: T0.toISOString() }, "Review the export.");
    const answer = await finish({ remaining: ["bd-3"] });
    expect(answer).toEqual({ ok: false, text: "a review of batch b1 has no verdict yet: wait for its delivery, then report finished\nNothing was stored or sent." });
    expect(fake.creates).toEqual([]);
    expect(createRequestRegistry(home).get(WS, REQ)!.finishedAt).toBeNull();
  });
});
