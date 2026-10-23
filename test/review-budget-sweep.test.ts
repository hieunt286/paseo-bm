import { afterEach, describe, expect, it } from "vitest";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { REVIEW_BUDGET_RETIRED, createReviewBudgetSweep, withdrawalTextOf, withdrawnKindOf } from "../plugin/server/review-budget-sweep";
import { answerDecision, markNeedsConfirmation, type Decision } from "../plugin/shared/decisions";
import { isPluginNotice } from "../plugin/shared/notices";
import { DECISION_REQUEST, DECISION_WS, makeDecision } from "./helpers/decisions";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * The upgrade sweep of the retired review-budget question (delivery line
 * design §5.6): at the first handle of a run, open review-budget questions
 * are withdrawn once and their Worker told; a second start does nothing.
 */

const NOW = new Date("2026-10-20T08:00:00.000Z");
const OTHER_REQUEST = "req-20260929T090000Z";
const PASEO = { agents: { list: async () => ({ entries: [] }), ref: () => ({}) } };

afterEach(() => {
  clearDecisionStoreCache();
  removeDataFolders();
});

const budget = (n: number, over: Partial<Decision> = {}): Decision =>
  makeDecision({
    id: `q:${over.requestId ?? DECISION_REQUEST}:Q${n}`,
    subject: "review-budget",
    class: "cost",
    question: "Review budget reached: allow more review calls?",
    options: [
      { key: "a", label: "Two more calls", recommended: true, effects: ["none"], grant: { calls: 2 } },
      { key: "b", label: "Until b2 is clean", recommended: false, effects: ["none"], grant: { untilClean: "b2" } },
    ],
    ...over,
  });

function setup(workers: Record<string, string | null> = { [DECISION_REQUEST]: "agent-worker", [OTHER_REQUEST]: "agent-worker-2" }) {
  const home = dataFolder("bm-sweep-");
  const store = createDecisionStore(home);
  const sent: Array<{ to: string; kind: string; text: string }> = [];
  const logs: string[] = [];
  const sweep = () =>
    createReviewBudgetSweep({
      home: () => home,
      now: () => NOW,
      log: (message) => logs.push(message),
      queue: { enqueue: async (to, kind, text) => (sent.push({ to, kind, text }), "sent") },
      workerOf: async ({ requestId }) => workers[requestId] ?? null,
    });
  return { home, store, sent, logs, sweep };
}

describe("the review-budget upgrade sweep (delivery line design §5.6)", () => {
  it("withdraws every open review-budget question once, tells each request's Worker in one message, and leaves the rest alone", async () => {
    const { store, sent, logs, sweep } = setup();
    store.open(budget(1));
    store.open(budget(2));
    store.transition(`q:${DECISION_REQUEST}:Q2`, (current) => markNeedsConfirmation(current, { via: "chat-worker", at: NOW.toISOString() }), DECISION_WS);
    store.open(budget(1, { requestId: OTHER_REQUEST }));
    // Answered before the upgrade: it stands. Another subject: untouched.
    const answered = budget(3);
    store.open(answered);
    store.transition(answered.id, (current) => answerDecision(current, { via: "inbox", optionKey: "a", at: NOW.toISOString() }), DECISION_WS);
    store.open(makeDecision({ id: `q:${DECISION_REQUEST}:Q4` }));

    const withdrawn = await sweep().run(PASEO);
    expect(withdrawn.sort()).toEqual([`q:${DECISION_REQUEST}:Q1`, `q:${DECISION_REQUEST}:Q2`, `q:${OTHER_REQUEST}:Q1`].sort());
    const status = (id: string) => store.get(id, DECISION_WS)?.status;
    expect([status(`q:${DECISION_REQUEST}:Q1`), status(`q:${DECISION_REQUEST}:Q2`), status(`q:${OTHER_REQUEST}:Q1`)]).toEqual(["withdrawn", "withdrawn", "withdrawn"]);
    expect(store.get(`q:${DECISION_REQUEST}:Q1`, DECISION_WS)).toMatchObject({ settledAt: NOW.toISOString(), answer: null, grant: null });
    expect(status(answered.id)).toBe("answered");
    expect(status(`q:${DECISION_REQUEST}:Q4`)).toBe("open");

    // One message per request, to its Worker, under its own kind; recorded on each decision.
    expect(sent).toEqual([
      { to: "agent-worker", kind: withdrawnKindOf(DECISION_REQUEST), text: withdrawalTextOf(DECISION_REQUEST, [{ id: `q:${DECISION_REQUEST}:Q1` }, { id: `q:${DECISION_REQUEST}:Q2` }]) },
      { to: "agent-worker-2", kind: withdrawnKindOf(OTHER_REQUEST), text: withdrawalTextOf(OTHER_REQUEST, [{ id: `q:${OTHER_REQUEST}:Q1` }]) },
    ]);
    expect(store.get(`q:${DECISION_REQUEST}:Q2`, DECISION_WS)?.delivery).toEqual({ to: "agent-worker", kind: `withdrawn:${DECISION_REQUEST}`, at: NOW.toISOString(), outcome: "sent" });
    expect(logs.some((line) => line.includes(REVIEW_BUDGET_RETIRED))).toBe(true);
  });

  it("is idempotent: a second start withdraws and sends nothing", async () => {
    const { store, sent, sweep } = setup();
    store.open(budget(1));
    expect(await sweep().run(PASEO)).toEqual([`q:${DECISION_REQUEST}:Q1`]);
    expect(await sweep().run(PASEO)).toEqual([]);
    expect(sent).toHaveLength(1);
    // Within one run it runs once, whatever the handles that come.
    const once = sweep();
    store.open(budget(2));
    expect(await once.run(PASEO)).toEqual([`q:${DECISION_REQUEST}:Q2`]);
    store.open(budget(3));
    expect(await once.run(PASEO)).toEqual([]);
  });

  it("waits for a usable Paseo handle, and records a failed delivery when the request has no single live Worker", async () => {
    const { store, sent, sweep } = setup({});
    store.open(budget(1));
    const run = sweep();
    expect(await run.run(undefined)).toEqual([]);
    expect(store.get(`q:${DECISION_REQUEST}:Q1`, DECISION_WS)?.status).toBe("open");
    expect(await run.run(PASEO)).toEqual([`q:${DECISION_REQUEST}:Q1`]);
    expect(sent).toEqual([]);
    expect(store.get(`q:${DECISION_REQUEST}:Q1`, DECISION_WS)?.delivery).toMatchObject({ to: "agent-worker", outcome: "failed" });
  });

  it("says why in the design's words, as a plugin delivery the Worker reads as settled", () => {
    const text = withdrawalTextOf(DECISION_REQUEST, [{ id: `q:${DECISION_REQUEST}:Q3` }]);
    expect(REVIEW_BUDGET_RETIRED).toBe("review budgets are retired: paseo-bm asks once, at the request's review cap");
    expect(text).toBe(`BM-DELIVERY answers\nContinue ${DECISION_REQUEST}.\nQ3 is withdrawn: ${REVIEW_BUDGET_RETIRED}. Do not wait for it.`);
    expect(isPluginNotice(text)).toBe(true);
  });
});
