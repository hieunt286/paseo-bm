import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPluginNotice } from "../plugin/shared/notices";
import {
  answersKindOf,
  answersMessageOf,
  createQuestionDecisionDelivery,
  soleWorkerOfRequest,
  type QuestionDeliveryDeps,
} from "../plugin/server/decision-delivery";
import { materialiseTurn } from "../plugin/server/decision-materialiser";
import { handleDecisionsAnswer, settledByKind } from "../plugin/server/decision-rpc";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { parseAnswers } from "../plugin/shared/bm-questions";
import { answerDecision, confirmDecision, markNeedsConfirmation, type AnswerVia, type Decision } from "../plugin/shared/decisions";
import { msg, turn } from "./fixtures/orchestrator-traces";

/**
 * Delivering the owner's answers to the Worker that asked (autonomy design
 * §A.6, owner decision DQ-2): one `BM-ANSWERS` block per request through the
 * notice queue, at the Worker's next idle moment, recorded on each decision.
 * Temporary data folder, a private queue and a fake Paseo only.
 */

const WORKSPACE = "wks_1";
const REQUEST = "req-20260929T073348Z";
const WORKER = "wrk-1";
const NOW = new Date("2026-09-29T08:00:00.000Z");

let root: string;
let home: string;
let logs: string[];

type Agent = { status: string; archivedAt?: string | null };

/** A fake Paseo: `refresh()` answers the scripted status; a `send()` starts a turn (the agent becomes `running`). */
function world(initial: Record<string, Agent> = { [WORKER]: { status: "idle" } }) {
  const agents = new Map(Object.entries(initial).map(([id, agent]) => [id, { ...agent }]));
  const sends: Array<{ id: string; text: string }> = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents.get(id);
          return agent === undefined ? null : { agent: { ...agent } };
        },
        send: async (text: string) => {
          sends.push({ id, text });
          agents.set(id, { ...agents.get(id)!, status: "running" });
        },
      }),
    },
  };
  const set = (id: string, change: Partial<Agent>) => agents.set(id, { ...agents.get(id)!, ...change });
  const queue = createNoticeQueue({ log: (message) => logs.push(message) });
  /** The Worker's turn ends: it goes idle and the queue delivers. */
  const turnEnds = async (id = WORKER) => {
    set(id, { status: "idle" });
    await queue.turnEnded({ agent: { id } }, paseo);
  };
  return { paseo, sends, set, queue, turnEnds };
}

const store = () => createDecisionStore(home);
const idOf = (n: number) => `q:${REQUEST}:Q${n}`;
const get = (n: number) => store().get(idOf(n), WORKSPACE)!;

function question(n: number): Decision {
  return {
    id: idOf(n),
    workspaceId: WORKSPACE,
    requestId: REQUEST,
    askedBy: { role: "worker", agentId: WORKER },
    askedAt: "2026-09-29T07:40:00.000Z",
    round: 1,
    question: `Question ${n}?`,
    subject: null,
    options: [
      { key: "a", label: `Option A of ${n}`, recommended: true, effects: [] },
      { key: "b", label: `Option B of ${n}`, recommended: false, effects: [] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
  };
}

/** Stores the owner's answer and returns the settled decision, as the RPC or the materialiser would. */
function answer(n: number, input: { optionKey?: string; words?: string; via?: AnswerVia } = { optionKey: "a" }): Decision {
  const mutation = store().transition(
    idOf(n),
    (current) =>
      answerDecision(current, {
        via: input.via ?? "inbox",
        optionKey: input.optionKey ?? null,
        words: input.words ?? null,
        at: "2026-09-29T07:50:00.000Z",
      }),
    WORKSPACE,
  );
  if (mutation.status !== "updated") throw new Error(`not answered: ${mutation.status}`);
  return mutation.decision;
}

function delivery(queue: NoticeQueue, overrides: Partial<QuestionDeliveryDeps> = {}) {
  return createQuestionDecisionDelivery({
    home: () => home,
    now: () => NOW,
    log: (message) => logs.push(message),
    queue,
    workerOf: async () => WORKER,
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-decision-delivery-"));
  home = join(root, "data");
  logs = [];
  clearDecisionStoreCache();
  for (const n of [1, 2, 3]) store().open(question(n));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the message", () => {
  it("is a plugin notice, so the trace never counts the delivery as the owner's typing", () => {
    expect(isPluginNotice(answersMessageOf(REQUEST, [answer(1, { optionKey: "a" })]))).toBe(true);
    expect(isPluginNotice("BM-DELIVERYX")).toBe(false);
  });

  it("is the BM-DELIVERY line, Continue <requestId>. and one BM-ANSWERS block in question order, options and own words", () => {
    const text = answersMessageOf(REQUEST, [answer(3, { words: "Keep the old name\nfor now" }), answer(1)]);
    expect(text).toBe(
      ["BM-DELIVERY answers", `Continue ${REQUEST}.`, "", "BM-ANSWERS", `requestId: ${REQUEST}`, "Q1: a — Option A of 1", "Q3: other — Keep the old name for now"].join("\n"),
    );
    expect(parseAnswers(text)).toEqual({ requestId: REQUEST, answers: [{ id: "Q1", text: "a — Option A of 1" }, { id: "Q3", text: "other — Keep the old name for now" }] });
  });

  it("cites an owner precedent that answered a question, above the block (autonomy design §B.6)", () => {
    const byPrecedent = (n: number, input: { optionKey?: string; words?: string }) =>
      store().transition(
        idOf(n),
        (current) =>
          answerDecision(
            { ...current, subject: "test-db" },
            { by: "precedent", precedentId: "p:9f2c", via: "inbox", optionKey: input.optionKey ?? null, words: input.words ?? null, at: "2026-09-29T07:50:00.000Z" },
          ),
        WORKSPACE,
      );
    byPrecedent(2, { words: "SQLite, always" });
    const text = answersMessageOf(REQUEST, [get(2), answer(1)]);
    expect(text).toBe(
      [
        "BM-DELIVERY answers",
        `Continue ${REQUEST}.`,
        `Q2 was answered by the owner's precedent p:9f2c on "test-db": it is the owner's standing answer.`,
        "",
        "BM-ANSWERS",
        `requestId: ${REQUEST}`,
        "Q1: a — Option A of 1",
        "Q2: other — SQLite, always",
      ].join("\n"),
    );
    // The block reads as before: the citation is outside it.
    expect(parseAnswers(text)).toEqual({ requestId: REQUEST, answers: [{ id: "Q1", text: "a — Option A of 1" }, { id: "Q2", text: "other — SQLite, always" }] });
    expect(isPluginNotice(text)).toBe(true);
  });

  it("delivers the policy's answer (autonomy design §B.5) exactly as an owner answer: same block, same Worker, nothing cited", async () => {
    const byPolicy = store().transition(
      idOf(2),
      (current) => answerDecision(current, { by: "policy", via: "inbox", optionKey: "a", class: "scope", at: "2026-09-29T07:50:00.000Z" }),
      WORKSPACE,
    );
    if (byPolicy.status !== "updated") throw new Error(`not answered: ${byPolicy.status}`);
    const owners = answer(1);
    const text = answersMessageOf(REQUEST, [byPolicy.decision, owners]);
    expect(text).toBe(["BM-DELIVERY answers", `Continue ${REQUEST}.`, "", "BM-ANSWERS", `requestId: ${REQUEST}`, "Q1: a — Option A of 1", "Q2: a — Option A of 2"].join("\n"));
    expect(text).not.toMatch(/policy|precedent/);
    const w = world();
    await delivery(w.queue).onSettled([byPolicy.decision], { paseo: w.paseo });
    expect(w.sends).toEqual([{ id: WORKER, text }]);
    expect(get(2).delivery).toEqual({ to: WORKER, kind: answersKindOf(REQUEST), at: NOW.toISOString(), outcome: "sent" });
  });
});

describe("delivering at the Worker's next idle moment", () => {
  it("sends one answer at once to an idle Worker and records it sent", async () => {
    const w = world();
    await delivery(w.queue).onSettled([answer(1)], { paseo: w.paseo });
    expect(w.sends).toEqual([{ id: WORKER, text: answersMessageOf(REQUEST, [get(1)]) }]);
    expect(get(1).delivery).toEqual({ to: WORKER, kind: answersKindOf(REQUEST), at: NOW.toISOString(), outcome: "sent" });
    // Open questions stay open and are not in the block.
    expect(get(2).status).toBe("open");
    expect(w.sends[0]!.text).not.toContain("Q2");
  });

  it("never sends into a running turn: it queues, and the Worker's turn end delivers", async () => {
    const w = world({ [WORKER]: { status: "running" } });
    await delivery(w.queue).onSettled([answer(1)], { paseo: w.paseo });
    expect(w.sends).toEqual([]);
    expect(get(1).delivery).toMatchObject({ to: WORKER, outcome: "queued" });
    expect(w.queue.pending(WORKER).map((notice) => notice.kind)).toEqual([answersKindOf(REQUEST)]);
    await w.turnEnds();
    expect(w.sends.map((send) => send.text)).toEqual([answersMessageOf(REQUEST, [get(1)])]);
  });

  it("two answers before the Worker is idle go as one block holding both; the newer block replaced the older", async () => {
    const w = world({ [WORKER]: { status: "running" } });
    const deliver = delivery(w.queue);
    await deliver.onSettled([answer(1)], { paseo: w.paseo });
    await deliver.onSettled([answer(2, { words: "Use Postgres" })], { paseo: w.paseo });
    expect(w.queue.pending(WORKER)).toHaveLength(1);
    await w.turnEnds();
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.text).toBe(
      ["BM-DELIVERY answers", `Continue ${REQUEST}.`, "", "BM-ANSWERS", `requestId: ${REQUEST}`, "Q1: a — Option A of 1", "Q2: other — Use Postgres"].join("\n"),
    );
    expect([get(1).delivery?.outcome, get(2).delivery?.outcome]).toEqual(["queued", "queued"]);
  });

  it("an answer after a block went out carries only what is still undelivered", async () => {
    const w = world();
    const deliver = delivery(w.queue);
    await deliver.onSettled([answer(1)], { paseo: w.paseo });
    // The Worker is now running on the first block.
    await deliver.onSettled([answer(2)], { paseo: w.paseo });
    await w.turnEnds();
    expect(w.sends).toHaveLength(2);
    expect(parseAnswers(w.sends[1]!.text)?.answers.map((entry) => entry.id)).toEqual(["Q2"]);
  });

  it("a queued block the queue has sent is recorded sent at the next settlement, and not sent again", async () => {
    const w = world({ [WORKER]: { status: "running" } });
    const deliver = delivery(w.queue);
    await deliver.onSettled([answer(1)], { paseo: w.paseo });
    await w.turnEnds();
    expect(w.sends).toHaveLength(1);
    w.set(WORKER, { status: "running" });
    await deliver.onSettled([answer(2)], { paseo: w.paseo });
    expect(get(1).delivery?.outcome).toBe("sent");
    await w.turnEnds();
    expect(parseAnswers(w.sends[1]!.text)?.answers.map((entry) => entry.id)).toEqual(["Q2"]);
  });

  it("a Worker's turn record that shows the block arrived marks those queued answers sent", async () => {
    const w = world({ [WORKER]: { status: "running" } });
    const deliver = delivery(w.queue);
    await deliver.onSettled([answer(1)], { paseo: w.paseo });
    await w.turnEnds();
    const record = turn({ agentId: WORKER, role: "worker", workspaceId: WORKSPACE, requestId: REQUEST, sent: [msg(WORKER, "2026-09-29T08:01:00.000Z", w.sends[0]!.text, "user")] });
    await deliver.afterTurn(record, { paseo: w.paseo });
    expect(get(1).delivery).toMatchObject({ outcome: "sent", at: "2026-09-29T08:01:00.000Z" });
  });

  it("an answer given in the Worker's own chat is not sent again, and never joins a block", async () => {
    const w = world();
    await delivery(w.queue).onSettled([answer(1, { optionKey: "b", via: "chat-worker" })], { paseo: w.paseo });
    expect(w.sends).toEqual([]);
    expect(get(1).delivery).toMatchObject({ to: WORKER, outcome: "sent", at: "2026-09-29T07:50:00.000Z" });
  });

  it("a confirmed chat answer (no option, no words) sends nothing", async () => {
    const w = world();
    store().transition(idOf(1), (current) => markNeedsConfirmation(current, { via: "chat-worker", at: "2026-09-29T07:45:00.000Z" }), WORKSPACE);
    const mutation = store().transition(idOf(1), (current) => confirmDecision(current, { answered: true, at: "2026-09-29T07:50:00.000Z" }), WORKSPACE);
    await delivery(w.queue).onSettled([mutation.status === "updated" ? mutation.decision : get(1)], { paseo: w.paseo });
    expect(w.sends).toEqual([]);
    expect(get(1).delivery?.outcome).toBe("sent");
  });

  it("each answer is delivered once: a second settlement of the same decision sends nothing", async () => {
    const w = world();
    const deliver = delivery(w.queue);
    const settled = answer(1);
    await deliver.onSettled([settled], { paseo: w.paseo });
    await w.turnEnds();
    await deliver.onSettled([settled], { paseo: w.paseo });
    expect(w.sends).toHaveLength(1);
  });
});

describe("a question that expired (autonomy design §A.3)", () => {
  it("is never delivered: the request's finished report expires the open ones, and only the answered one goes", async () => {
    const w = world();
    const deliver = delivery(w.queue);
    // Q1 answered but not handed over yet; Q2 and Q3 open when the Worker finishes.
    answer(1);
    const finished = ["BM-REPORT", `requestId: ${REQUEST}`, "phase: finished", "tier: Small", "blockers: none"].join("\n");
    const record = turn({ agentId: "mgr-1", role: "manager", workspaceId: WORKSPACE, sent: [msg("mgr-1", "2026-09-29T07:55:00.000Z", finished, "agent")] });
    await materialiseTurn(record, { home, paseo: w.paseo, now: () => NOW, log: (message) => logs.push(message), onSettled: settledByKind({ question: deliver.onSettled }), afterTurn: deliver.afterTurn });
    expect([get(2).status, get(3).status]).toEqual(["expired", "expired"]);
    expect(w.sends).toHaveLength(1);
    expect(parseAnswers(w.sends[0]!.text)?.answers.map((entry) => entry.id)).toEqual(["Q1"]);

    // Handed to the delivery, after a reload, or answered late: an expired question sends nothing and records nothing.
    await deliver.onSettled([get(2), get(3)], { paseo: w.paseo });
    const after = world();
    await delivery(after.queue).afterTurn(record, { paseo: after.paseo });
    await expect(handleDecisionsAnswer({ id: idOf(2), optionKey: "a" }, w.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled: settledByKind({ question: deliver.onSettled }) })).rejects.toThrow(
      "E_DECISION_SETTLED",
    );
    expect(w.sends).toHaveLength(1);
    expect(after.sends).toEqual([]);
    expect([get(2).delivery, get(3).delivery]).toEqual([null, null]);
  });
});

describe("a Worker that cannot be reached", () => {
  it("no single live Worker: recorded failed, nothing sent", async () => {
    const w = world();
    await delivery(w.queue, { workerOf: async () => null }).onSettled([answer(1)], { paseo: w.paseo });
    expect(w.sends).toEqual([]);
    expect(get(1).delivery).toEqual({ to: WORKER, kind: answersKindOf(REQUEST), at: NOW.toISOString(), outcome: "failed" });
    expect(logs.join("\n")).toContain("has no single live Worker");
  });

  it("an archived or gone Worker: the queue drops it, recorded failed, and a failed answer is not retried", async () => {
    const w = world({ [WORKER]: { status: "idle", archivedAt: "2026-09-29T07:55:00.000Z" } });
    const deliver = delivery(w.queue);
    await deliver.onSettled([answer(1)], { paseo: w.paseo });
    expect(w.sends).toEqual([]);
    expect(get(1).delivery?.outcome).toBe("failed");
    w.set(WORKER, { archivedAt: null });
    await deliver.onSettled([answer(2)], { paseo: w.paseo });
    expect(parseAnswers(w.sends[0]!.text)?.answers.map((entry) => entry.id)).toEqual(["Q2"]);
  });

  it("without a Paseo handle the answer stays undelivered for a later look", async () => {
    const w = world();
    await delivery(w.queue).onSettled([answer(1)], { paseo: undefined });
    expect(get(1).delivery).toBeNull();
  });

  it("finds the request's sole live Worker by its labels, never a guess between two", async () => {
    const snapshot = (id: string, labels: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
      id,
      provider: "bm-worker",
      status: "idle",
      archivedAt: null,
      workspaceId: WORKSPACE,
      ...extra,
      labels: { "bm.role": "worker", "bm.requestId": REQUEST, ...labels },
    });
    const paseoWith = (entries: unknown[]) => ({ agents: { list: async () => ({ entries }), ref: () => ({}) } }) as never;
    const input = { workspaceId: WORKSPACE, requestId: REQUEST, home };
    expect(await soleWorkerOfRequest(input, paseoWith([snapshot("w1"), snapshot("w0", {}, { archivedAt: "2026-09-29T07:00:00.000Z" })]))).toBe("w1");
    expect(await soleWorkerOfRequest(input, paseoWith([snapshot("w1"), snapshot("w2", { "bm.replacedBy": "w3" })]))).toBe("w1");
    expect(await soleWorkerOfRequest(input, paseoWith([snapshot("w1"), snapshot("w2")]))).toBeNull();
    expect(await soleWorkerOfRequest(input, paseoWith([snapshot("w1", {}, { workspaceId: "other" })]))).toBeNull();
  });
});

describe("after a plugin reload", () => {
  it("re-enqueues settled-but-undelivered answers once, a block per request", async () => {
    // Before the reload: Q1 was queued (the queue is gone now), Q2 was never handed over, Q3 went out.
    const before = world({ [WORKER]: { status: "running" } });
    await delivery(before.queue).onSettled([answer(1)], { paseo: before.paseo });
    answer(2, { words: "Use Postgres" });
    answer(3);
    store().transition(idOf(3), (current) => ({ ok: true, decision: { ...current, delivery: { to: WORKER, kind: answersKindOf(REQUEST), at: NOW.toISOString(), outcome: "sent" } } }), WORKSPACE);
    expect(get(1).delivery?.outcome).toBe("queued");

    const after = world();
    const deliver = delivery(after.queue);
    const record = turn({ agentId: "mgr-1", role: "manager", workspaceId: WORKSPACE, requestId: REQUEST });
    await deliver.afterTurn(record, { paseo: after.paseo });
    expect(after.sends).toHaveLength(1);
    expect(parseAnswers(after.sends[0]!.text)?.answers.map((entry) => entry.id)).toEqual(["Q1", "Q2"]);
    expect([get(1).delivery?.outcome, get(2).delivery?.outcome, get(3).delivery?.outcome]).toEqual(["sent", "sent", "sent"]);

    // Once per run.
    await after.turnEnds();
    await deliver.afterTurn(record, { paseo: after.paseo });
    expect(after.sends).toHaveLength(1);
  });

  it("the arrival in the Worker's record is noted before resuming, so a block that went out is not sent twice", async () => {
    const before = world({ [WORKER]: { status: "running" } });
    await delivery(before.queue).onSettled([answer(1)], { paseo: before.paseo });
    await before.turnEnds();
    const arrived = before.sends[0]!.text;

    const after = world();
    const record = turn({ agentId: WORKER, role: "worker", workspaceId: WORKSPACE, requestId: REQUEST, sent: [msg(WORKER, "2026-09-29T08:01:00.000Z", arrived, "user")] });
    await delivery(after.queue).afterTurn(record, { paseo: after.paseo });
    expect(after.sends).toEqual([]);
    expect(get(1).delivery?.outcome).toBe("sent");
  });
});

describe("wiring", () => {
  it("decisions.answer through settledByKind delivers the question at once", async () => {
    const w = world();
    const onSettled = settledByKind({ question: delivery(w.queue).onSettled });
    await handleDecisionsAnswer({ id: idOf(1), optionKey: "b" }, w.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled });
    expect(w.sends.map((send) => send.text)).toEqual([answersMessageOf(REQUEST, [get(1)])]);
    expect(get(1).delivery?.outcome).toBe("sent");
  });

  it("an answer read from the Manager's turn is delivered through the materialiser's onSettled", async () => {
    const w = world();
    const deliver = delivery(w.queue);
    const block = ["BM-ANSWERS", `requestId: ${REQUEST}`, "Q2: b — Option B of 2"].join("\n");
    const record = turn({
      agentId: "mgr-1",
      role: "manager",
      workspaceId: WORKSPACE,
      sent: [msg("mgr-1", "2026-09-29T07:58:00.000Z", "Q2 b please", "user")],
      received: [msg("mgr-1", "2026-09-29T07:59:00.000Z", block)],
    });
    await materialiseTurn(record, { home, paseo: w.paseo, now: () => NOW, log: (message) => logs.push(message), onSettled: settledByKind({ question: deliver.onSettled }), afterTurn: deliver.afterTurn });
    expect(get(2)).toMatchObject({ status: "answered", answer: { via: "chat-manager", optionKey: "b" }, delivery: { to: WORKER, outcome: "sent" } });
    expect(w.sends).toHaveLength(1);
  });
});
