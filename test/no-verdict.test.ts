import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { createBudgetTold } from "../plugin/server/budget-told";
import { registerFallbackDetection } from "../plugin/server/fallback-state";
import { checkNoVerdict, noVerdictTextOf } from "../plugin/server/no-verdict";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { checkReviewBudget, type BudgetOverrun, type BudgetPaseo } from "../plugin/server/review-budget";
import { NO_VERDICT_SENTENCE, parseDelivery, reviewerBriefLineOf } from "../plugin/shared/notices";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Wake-ups and a missing verdict (design §16.10; ADR-027 decision 11, spike S2
 * passed), on recorded turn sequences: a plugin-created Worker's turn end
 * sends its Manager nothing; a bound Reviewer's turn that ends without a
 * verdict sends its Worker one `no-verdict` delivery per review call, after
 * the fallback detection ran; a canceled turn, or one with a fallback
 * incident, sends none.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const REVIEWER = "agent-reviewer";
const CALL_1 = "out-000000000a01";
const CALL_2 = "out-000000000a02";
const T0 = new Date("2026-10-03T10:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-no-verdict-"));
  roots.push(root);
  const home = join(root, ".paseo-bm");
  mkdirSync(home);
  return home;
}

/** A binding the plugin issued and the hook attached, bound to `agentId`. */
function bind(store: BindingStore, agentId: string, input: { role: "reviewer" | "worker"; requestId: string; parentId: string; batchId?: string | null }): void {
  const { token, tokenSha256 } = store.issue({ ...input, workspaceId: WS });
  store.attach(token, input.role);
  store.settle(tokenSha256, agentId);
}

const iso = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString();

function setup() {
  const home = dataFolder();
  const store = createBindingStore(home);
  bind(store, WORKER, { role: "worker", requestId: REQ, parentId: MANAGER });
  bind(store, REVIEWER, { role: "reviewer", requestId: REQ, parentId: WORKER, batchId: "b1" });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  registry.register(WS, REQ, { source: "tool", managerId: MANAGER, workerId: WORKER });
  registry.addReviewCall(WS, REQ, "b1", { callId: CALL_1, kind: "create", reviewerId: "", at: iso(0) }, "Review batch b1.");
  registry.noteReviewer(WS, REQ, "b1", REVIEWER, CALL_1);
  const fake = fakePaseo({
    agents: [
      { id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "manager" } },
      { id: WORKER, provider: "bm-worker/claude-opus-5", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER } },
      { id: REVIEWER, provider: "bm-reviewer/gpt-5.6", status: "idle", workspaceId: WS, labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "paseo.parent-agent-id": WORKER } },
    ],
  });
  const queue = createNoticeQueue({ log: () => {} });
  let clock = new Date(T0.getTime() + 5 * 60_000);
  let n = 0;
  const check = (event: unknown, classified = false) =>
    checkNoVerdict(event as never, {
      home,
      paseo: fake.paseo,
      bindings: store,
      classified,
      now: () => clock,
      log: () => {},
      queue,
      outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    });
  const tick = (minutes = 1) => {
    clock = new Date(clock.getTime() + minutes * 60_000);
  };
  return { home, store, fake, check, tick, registry, clock: () => clock };
}

/** A turn end of `agentId`, its timeline starting with `prompt`. */
const ended = (agentId: string, provider: string, kind: string, prompt: string | null = null, extra: Record<string, unknown> = {}) => ({
  agent: { id: agentId, provider, workspaceId: WS, parentAgentId: null, cwd: "/repo", title: null },
  turnId: "t",
  outcome: { kind, ...extra },
  timeline: prompt === null ? [] : [{ type: "user_message", text: prompt }, { type: "assistant_message", text: "Looking at it." }],
});
const reviewerTurn = (kind = "completed", prompt: string | null = `${reviewerBriefLineOf(REQ, "b1", CALL_1)}\nReview batch b1.`, extra: Record<string, unknown> = {}) =>
  ended(REVIEWER, "bm-reviewer/gpt-5.6", kind, prompt, extra);

const noVerdicts = (home: string) => createOutbox(home).list(WS).filter((record) => record.kind === "no-verdict");

describe("a missing verdict (design §16.10)", () => {
  it("a bound Reviewer's completed turn without a review record sends its Worker exactly one no-verdict delivery", async () => {
    const { home, fake, check } = setup();
    expect(await check(reviewerTurn())).toBe("sent");
    const [record] = noVerdicts(home);
    expect(record).toMatchObject({ kind: "no-verdict", requestId: REQ, batchId: "b1", from: REVIEWER, to: WORKER, state: "delivered" });
    expect(record!.text).toBe(noVerdictTextOf({ requestId: REQ, batchId: "b1", reviewerId: REVIEWER }));
    expect(record!.text.split("\n")).toEqual([`requestId: ${REQ}`, "batchId: b1", `reviewer: ${REVIEWER}`, NO_VERDICT_SENTENCE]);
    expect(fake.sends).toEqual([{ id: WORKER, text: `BM-DELIVERY no-verdict ${record!.id}\n${record!.text}` }]);
    expect(parseDelivery(fake.sends[0]!.text)?.kind).toBe("no-verdict");

    // At most once per review call: the same call ending again sends nothing.
    expect(await check(reviewerTurn())).toBe("already-sent");
    expect(noVerdicts(home)).toHaveLength(1);
  });

  it("a second review call of the same batch that also ends without a verdict sends a second one", async () => {
    const { home, check, tick, registry, clock } = setup();
    expect(await check(reviewerTurn())).toBe("sent");
    tick();
    // The Worker's bm_rereview: its call carries the delivery's record id.
    registry.addReviewCall(WS, REQ, "b1", { callId: CALL_2, kind: "rereview", reviewerId: REVIEWER, at: clock().toISOString() });
    tick();
    expect(await check(reviewerTurn("completed", `BM-DELIVERY message ${CALL_2}\nRe-review batch b1: check only that the previous blocking findings are fixed and the fixes broke nothing.`))).toBe("sent");
    expect(noVerdicts(home)).toHaveLength(2);
    expect(await check(reviewerTurn("completed", `BM-DELIVERY message ${CALL_2}\nRe-review batch b1.`))).toBe("already-sent");
  });

  it("a review record since the call means a verdict came: nothing is sent", async () => {
    const { home, fake, check } = setup();
    createOutbox(home, { now: () => new Date(T0.getTime() + 2 * 60_000) }).add(WS, { kind: "review", requestId: REQ, batchId: "b1", from: REVIEWER, to: WORKER, text: "BM-REVIEW\nverdict: pass" });
    expect(await check(reviewerTurn())).toBe("verdict");
    expect(fake.sends).toEqual([]);
  });

  it("a failed turn with no fallback incident sends one; a canceled turn, or one the fallback classified, sends none", async () => {
    const canceled = setup();
    expect(await canceled.check(reviewerTurn("canceled"))).toBe("outcome");
    expect(await canceled.check(reviewerTurn("failed", undefined, { error: { message: "You've hit your usage limit." } }), true)).toBe("fallback");
    expect(noVerdicts(canceled.home)).toEqual([]);
    expect(canceled.fake.sends).toEqual([]);
    expect(await canceled.check(reviewerTurn("failed", undefined, { error: { message: "tool crashed" } }))).toBe("sent");
    expect(noVerdicts(canceled.home)).toHaveLength(1);
  });

  it("an unbound Reviewer keeps today's path: Paseo wakes its creator, the plugin sends nothing", async () => {
    const { fake, check } = setup();
    expect(await check(ended("agent-hand-reviewer", "bm-reviewer/gpt-5.6", "completed"))).toBe("not-bound-reviewer");
    expect(fake.sends).toEqual([]);
  });

  it("runs after the fallback detection of the same turn, told whether it classified the turn", async () => {
    const home = dataFolder();
    const handlers: Array<(event: unknown, context: unknown) => Promise<void>> = [];
    const host = { on: vi.fn((_name: string, handler: (event: unknown, context: unknown) => Promise<void>) => (handlers.push(handler), () => {})) };
    const seen: Array<{ classified: boolean }> = [];
    registerFallbackDetection(host as never, {
      log: () => {},
      home: () => home,
      afterDetection: async (_event, context) => {
        seen.push({ classified: context.classified });
      },
    });
    const paseo = fakePaseo({ agents: [{ id: REVIEWER, provider: "bm-reviewer/gpt-5.6", workspaceId: WS, labels: { "bm.role": "reviewer", "paseo.parent-agent-id": WORKER } }] }).paseo;
    await handlers[0]!(reviewerTurn("completed"), { paseo });
    await handlers[0]!(reviewerTurn("failed", null, { error: { message: "You've hit your usage limit. Your limit resets at 3pm." } }), { paseo });
    // Not a paseo-bm agent: nothing at all.
    await handlers[0]!(ended("x", "claude", "completed"), { paseo });
    expect(seen).toEqual([{ classified: false }, { classified: true }]);
  });
});

describe("a plugin-created Reviewer that ended up unbound (design §16.10)", () => {
  const PI_REVIEWER = "agent-pi-reviewer";
  const CALL_3 = "out-000000000b01";

  /** The batch b2 a bound Worker opened with bm_create_reviewer; its Reviewer is on Pi, so it has no token. */
  function unboundSetup() {
    const base = setup();
    base.registry.addReviewCall(WS, REQ, "b2", { callId: CALL_3, kind: "create", reviewerId: "", at: iso(1) }, "Review batch b2.");
    base.registry.noteReviewer(WS, REQ, "b2", PI_REVIEWER, CALL_3);
    return base;
  }

  const piTurn = (reply: string, prompt = `${reviewerBriefLineOf(REQ, "b2", CALL_3)}\nReview batch b2.`) => ({
    agent: { id: PI_REVIEWER, provider: "bm-reviewer-fallback-1/pi-model", workspaceId: WS, parentAgentId: WORKER, cwd: "/repo", title: null },
    turnId: "t",
    outcome: { kind: "completed" },
    timeline: [
      { type: "user_message", text: prompt },
      { type: "assistant_message", text: "I read the diff.\n\nBM-REVIEW\nrequestId: " },
      { type: "assistant_message", text: `${REQ}\nbatchId: b2\nverdict: changes-requested\n- severity: blocking — the date parser drops the time zone` },
    ],
  });

  it("its final BM-REVIEW is stored and delivered to its Worker as a review record, once per review call", async () => {
    const { home, fake, check } = unboundSetup();
    expect(await check(piTurn(""))).toBe("review-delivered");
    const reviews = createOutbox(home).list(WS).filter((record) => record.kind === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ kind: "review", requestId: REQ, batchId: "b2", from: PI_REVIEWER, to: WORKER, state: "delivered" });
    expect(reviews[0]!.text).toBe(`BM-REVIEW\nrequestId: ${REQ}\nbatchId: b2\nverdict: changes-requested\n- severity: blocking — the date parser drops the time zone`);
    expect(fake.sends).toEqual([{ id: WORKER, text: `BM-DELIVERY review ${reviews[0]!.id}\n${reviews[0]!.text}` }]);
    expect(noVerdicts(home)).toEqual([]);
    // The same call ending again: its verdict is there, nothing more is sent.
    expect(await check(piTurn(""))).toBe("verdict");
    expect(fake.sends).toHaveLength(1);
  });

  it("a turn without a BM-REVIEW gets the no-verdict record, as a bound Reviewer's does", async () => {
    const { home, fake, check } = unboundSetup();
    const turnWithout = { ...piTurn(""), timeline: [{ type: "user_message", text: `${reviewerBriefLineOf(REQ, "b2", CALL_3)}\nReview batch b2.` }, { type: "assistant_message", text: "I could not finish." }] };
    expect(await check(turnWithout)).toBe("sent");
    expect(noVerdicts(home)).toMatchObject([{ requestId: REQ, batchId: "b2", from: PI_REVIEWER, to: WORKER }]);
    expect(fake.sends.map((sent) => parseDelivery(sent.text)?.kind)).toEqual(["no-verdict"]);
    expect(await check(turnWithout)).toBe("already-sent");
  });

  it("a Reviewer no batch names (a hand-made one) is still left to Paseo's own wake", async () => {
    const { check, fake } = unboundSetup();
    expect(await check({ ...piTurn(""), agent: { ...piTurn("").agent, id: "agent-other-reviewer" } })).toBe("not-bound-reviewer");
    expect(fake.sends).toEqual([]);
  });
});

describe("wake-ups (design §16.10)", () => {
  it("a plugin-created Worker's turn end without a report sends its Manager nothing", async () => {
    const { home, fake, check } = setup();
    const workerTurn = ended(WORKER, "bm-worker/claude-opus-5", "completed", "BM-BRIEF worker requestId: " + REQ);
    // The missing-verdict check is a Reviewer's only.
    expect(await check(workerTurn)).toBe("not-bound-reviewer");
    // The review budget is within: no BM-BUDGET either.
    const pending = new Map<string, BudgetOverrun>();
    const outcome = await checkReviewBudget(workerTurn as never, {
      location: { tracesDir: join(home, "traces") },
      paseo: fake.paseo as unknown as BudgetPaseo,
      told: createBudgetTold(() => {}),
      pending,
    });
    expect(outcome).toBe("within");
    expect(fake.sends).toEqual([]);
    expect(createOutbox(home).list(WS)).toEqual([]);
  });
});
