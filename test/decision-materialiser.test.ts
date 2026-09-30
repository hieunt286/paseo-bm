import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerInputOf,
  clearMaterialiserMemory,
  createDecisionMaterialiser,
  materialiseTurn,
  normalisedQuestion,
  workerOfRequest,
  type MaterialiserDeps,
} from "../plugin/server/decision-materialiser";
import { DECISIONS_DIR_NAME, clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { GRANT_TTL_MS, confirmDecision, type Decision } from "../plugin/shared/decisions";
import type { TraceRecord } from "../plugin/shared/contracts";
import { MANAGER, WORKER, WORKSPACE_ID, at, msg, turn } from "./fixtures/orchestrator-traces";

/**
 * The decision materialiser (autonomy design §A.5 a–c) against a temporary
 * data folder, with records built as the collector writes them. Never the
 * real HOME.
 */

const REQUEST = "req-20260929T073348Z";
const OTHER_REQUEST = "req-20260929T090000Z";
const PASEO = { tag: "paseo-handle" };
const NOW = "2026-09-26T11:00:00.000Z";

let root: string;
let home: string;
let logs: string[];
let settled: Array<{ decisions: Decision[]; paseo: unknown }>;

const store = () => createDecisionStore(home);
const idOf = (qn: string, requestId = REQUEST) => `q:${requestId}:${qn}`;
const get = (qn: string, requestId = REQUEST) => store().get(idOf(qn, requestId), WORKSPACE_ID);
const fileBytes = () => {
  const path = join(home, DECISIONS_DIR_NAME, `${WORKSPACE_ID}.json`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

function deps(overrides: Partial<MaterialiserDeps> = {}): MaterialiserDeps {
  return {
    home,
    paseo: PASEO,
    now: () => new Date(NOW),
    log: (message) => logs.push(message),
    onSettled: (decisions, context) => {
      settled.push({ decisions, paseo: context.paseo });
    },
    workerOf: async () => WORKER,
    ...overrides,
  };
}

/** A Worker's blocked report with its questions, as the Manager receives it. */
function report(questions: string, requestId = REQUEST): string {
  return [
    "BM-REPORT",
    `requestId: ${requestId}`,
    "phase: blocked",
    "tier: Medium",
    "blockers: see BM-QUESTIONS",
    "",
    "BM-QUESTIONS",
    `requestId: ${requestId}`,
    questions,
  ].join("\n");
}

const ROUND_ONE = [
  "Q1: Push both backends to origin/dev? [subject: push-backends]",
  "- a: Push contract only (recommended) [effects: push]",
  "- b: Push both, manifest by hand [effects: push, publish]",
  "- c: Hold",
  "Q2: Which database for the tests?",
  "- a: SQLite (recommended)",
  "- b: Postgres [effects: dependency-install]",
].join("\n");

const managerTurn = (overrides: Partial<TraceRecord>): TraceRecord =>
  turn({ agentId: MANAGER, role: "manager", workspaceId: WORKSPACE_ID, endedAt: at(5), ...overrides });
const workerTurn = (overrides: Partial<TraceRecord>): TraceRecord =>
  turn({ agentId: WORKER, role: "worker", workspaceId: WORKSPACE_ID, parentAgentId: MANAGER, requestId: REQUEST, endedAt: at(9), ...overrides });

/** The Manager turn that received the Worker's first round. */
const askedTurn = (questions = ROUND_ONE, when = at(2)) => managerTurn({ sent: [msg(MANAGER, when, report(questions), "agent")] });

async function ask(questions = ROUND_ONE, when = at(2)) {
  return materialiseTurn(askedTurn(questions, when), deps());
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-decision-materialiser-"));
  home = join(root, "data");
  logs = [];
  settled = [];
  clearDecisionStoreCache();
  clearMaterialiserMemory();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("opening at a Manager's turn end (§A.5 a)", () => {
  it("opens q:<requestId>:<Qn> for each question a Worker's report carries", async () => {
    const outcome = await ask();
    expect(outcome.role).toBe("manager");
    expect(outcome.opened.map((decision) => decision.id)).toEqual([idOf("Q1"), idOf("Q2")]);
    expect(get("Q1")).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: at(2),
      round: 1,
      question: "Push both backends to origin/dev?",
      subject: "push-backends",
      status: "open",
      supersedes: null,
      options: [
        { key: "a", label: "Push contract only", recommended: true, effects: ["push"] },
        { key: "b", label: "Push both, manifest by hand", recommended: false, effects: ["push", "publish"] },
        { key: "c", label: "Hold", recommended: false, effects: [] },
      ],
    });
    expect(get("Q2")).toMatchObject({ subject: null, round: 1, status: "open" });
    expect(settled).toEqual([]);
  });

  it("changes nothing when the same turn is recorded twice (Paseo reuses turn ids)", async () => {
    await ask();
    const before = fileBytes();
    const again = await ask();
    expect(again.opened).toEqual([]);
    expect(again.superseded).toEqual([]);
    expect(fileBytes()).toBe(before);
  });

  it("opens nothing from the owner's own message, even one that quotes a block", async () => {
    const outcome = await materialiseTurn(managerTurn({ sent: [msg(MANAGER, at(2), report(ROUND_ONE), "user")] }), deps());
    expect(outcome.opened).toEqual([]);
    expect(fileBytes()).toBeNull();
  });

  it("reads a BM-QUESTIONS block without its own requestId from the report above it", async () => {
    const text = ["BM-REPORT", `requestId: ${REQUEST}`, "phase: blocked", "", "BM-QUESTIONS", "Q1: Go on?", "- a: Yes", "- b: No"].join("\n");
    await materialiseTurn(managerTurn({ sent: [msg(MANAGER, at(2), text, "agent")] }), deps());
    expect(get("Q1")?.question).toBe("Go on?");
  });

  it("leaves askedBy's agent null when the Worker is not known", async () => {
    await materialiseTurn(askedTurn(), deps({ workerOf: async () => null }));
    expect(get("Q1")?.askedBy).toEqual({ role: "worker", agentId: null });
  });

  it("looks the Worker up once per request, only when something is new", async () => {
    const workerOf = vi.fn(async () => WORKER);
    await materialiseTurn(askedTurn(), deps({ workerOf }));
    await materialiseTurn(askedTurn(), deps({ workerOf }));
    expect(workerOf).toHaveBeenCalledTimes(1);
    expect(workerOf).toHaveBeenCalledWith({ requestId: REQUEST, workspaceId: WORKSPACE_ID, managerId: MANAGER }, PASEO);
  });

  it("puts a later block in the next round", async () => {
    await ask();
    await ask("Q3: Keep the old endpoint?\n- a: Yes\n- b: No", at(4));
    expect(get("Q3")).toMatchObject({ round: 2, askedAt: at(4) });
  });

  it("ignores a Reviewer's turn", async () => {
    const outcome = await materialiseTurn(turn({ role: "reviewer", workspaceId: WORKSPACE_ID, sent: [msg(MANAGER, at(2), report(ROUND_ONE), "agent")] }), deps());
    expect(outcome.role).toBeNull();
    expect(fileBytes()).toBeNull();
  });
});

describe("supersession (§A.3 rules)", () => {
  it("a question tagged [supersedes: Qn] replaces that question", async () => {
    await ask();
    const outcome = await ask("Q3: Push only the contract backend? [supersedes: Q1]\n- a: Yes\n- b: No", at(4));
    expect(outcome.superseded.map((decision) => decision.id)).toEqual([idOf("Q1")]);
    expect(get("Q1")).toMatchObject({ status: "superseded", supersededBy: idOf("Q3"), settledAt: at(4) });
    expect(get("Q3")).toMatchObject({ status: "open", supersedes: idOf("Q1") });
    expect(get("Q2")?.status).toBe("open");
  });

  it("a question with the same normalised text as an open one replaces it", async () => {
    await ask();
    await ask("Q4: which DATABASE for the tests\n- a: SQLite\n- b: Postgres", at(4));
    expect(get("Q2")).toMatchObject({ status: "superseded", supersededBy: idOf("Q4") });
    expect(get("Q4")?.supersedes).toBe(idOf("Q2"));
  });

  it("an answered question is never replaced by the same text", async () => {
    await ask();
    store().transition(idOf("Q2"), (decision) => ({ ok: true, decision: { ...decision, status: "answered", settledAt: at(3), answer: { by: "owner", via: "inbox", optionKey: "a", words: null, at: at(3) } } }), WORKSPACE_ID);
    await ask("Q4: Which database for the tests?\n- a: SQLite", at(4));
    expect(get("Q2")?.status).toBe("answered");
    expect(get("Q4")).toMatchObject({ status: "open", supersedes: null });
  });

  it("a tag naming a question that was never stored links nothing", async () => {
    await ask("Q5: Rename the table? [supersedes: Q4]\n- a: Yes");
    expect(get("Q5")).toMatchObject({ status: "open", supersedes: null });
  });
});

describe("settling through the Manager (§A.5 b)", () => {
  const answers = (lines: string[], requestId = REQUEST) => ["Here is what goes to the Worker:", "", "BM-ANSWERS", `requestId: ${requestId}`, ...lines].join("\n");

  it("settles the questions the Manager's BM-ANSWERS names after the owner's typed message", async () => {
    await ask();
    const outcome = await materialiseTurn(
      managerTurn({
        sent: [msg(MANAGER, at(6), "Push the contract only, and use Postgres because the prod DB is Postgres.", "user")],
        received: [msg(MANAGER, at(7), answers(["Q1: a — Push contract only", "Q2: other — Postgres, prod runs Postgres"]))],
      }),
      deps(),
    );
    expect(outcome.answered.map((decision) => decision.id)).toEqual([idOf("Q1"), idOf("Q2")]);
    expect(get("Q1")).toMatchObject({
      status: "answered",
      settledAt: at(6),
      answer: { by: "owner", via: "chat-manager", optionKey: "a", words: null, at: at(6) },
      grant: { effects: ["push"], expiresAt: new Date(Date.parse(at(6)) + GRANT_TTL_MS).toISOString(), usedAt: null },
    });
    expect(get("Q2")?.answer).toMatchObject({ via: "chat-manager", optionKey: null, words: "Postgres, prod runs Postgres" });
    expect(settled).toEqual([{ decisions: outcome.answered, paseo: PASEO }]);
  });

  it("settles nothing when the Manager's block comes without the owner's typed message", async () => {
    await ask();
    const before = fileBytes();
    const outcome = await materialiseTurn(
      managerTurn({
        sent: [msg(MANAGER, at(6), "BM-COMMAND\nfrom: orchestrator\n…", "agent")],
        received: [msg(MANAGER, at(7), answers(["Q1: a — Push contract only"]))],
      }),
      deps(),
    );
    expect(outcome.answered).toEqual([]);
    expect(get("Q1")?.status).toBe("open");
    expect(fileBytes()).toBe(before);
    expect(settled).toEqual([]);
  });

  it("reads a block streamed across several replies", async () => {
    await ask();
    // Cut inside the marker: neither reply holds a block on its own.
    const whole = answers(["Q1: a — Push contract only"]);
    const cut = whole.indexOf("BM-ANS") + "BM-ANS".length;
    const [head, tail] = [whole.slice(0, cut), whole.slice(cut)];
    await materialiseTurn(
      managerTurn({ sent: [msg(MANAGER, at(6), "a for Q1", "user")], received: [msg(MANAGER, at(7), head), msg(MANAGER, at(7), tail)] }),
      deps(),
    );
    expect(get("Q1")?.answer?.optionKey).toBe("a");
  });

  it("answering the same turn twice changes nothing and hands nothing over again", async () => {
    await ask();
    const record = managerTurn({ sent: [msg(MANAGER, at(6), "a", "user")], received: [msg(MANAGER, at(7), answers(["Q1: a — Push contract only"]))] });
    await materialiseTurn(record, deps());
    const before = fileBytes();
    const again = await materialiseTurn(record, deps());
    expect(again.answered).toEqual([]);
    expect(fileBytes()).toBe(before);
    expect(settled).toHaveLength(1);
  });

  it("skips a question that was never opened and a settled one", async () => {
    await ask("Q9: Go on? [supersedes: Q1]\n- a: Yes");
    const outcome = await materialiseTurn(
      managerTurn({ sent: [msg(MANAGER, at(6), "yes", "user")], received: [msg(MANAGER, at(7), answers(["Q8: a — Yes", "Q9: a — Yes"]))] }),
      deps(),
    );
    expect(outcome.answered.map((decision) => decision.id)).toEqual([idOf("Q9")]);
  });

  it("a failing settlement hook is logged, never thrown", async () => {
    await ask();
    const outcome = await materialiseTurn(
      managerTurn({ sent: [msg(MANAGER, at(6), "a", "user")], received: [msg(MANAGER, at(7), answers(["Q1: a — Push contract only"]))] }),
      deps({
        onSettled: () => {
          throw new Error("delivery boom");
        },
      }),
    );
    expect(outcome.answered).toHaveLength(1);
    expect(get("Q1")?.status).toBe("answered");
    expect(logs.some((line) => line.includes("delivery boom"))).toBe(true);
  });
});

describe("answers in a Worker's chat (§A.5 c)", () => {
  const cardAnswer = (lines: string[]) => [`Reply from the user about \`${REQUEST}\`:`, "", "BM-ANSWERS", `requestId: ${REQUEST}`, ...lines].join("\n");

  it("an owner-typed BM-ANSWERS settles the named questions via chat-worker", async () => {
    await ask();
    const outcome = await materialiseTurn(workerTurn({ sent: [msg(WORKER, at(8), cardAnswer(["Q2: b — Postgres"]), "user")] }), deps());
    expect(outcome.role).toBe("worker");
    expect(outcome.answered.map((decision) => decision.id)).toEqual([idOf("Q2")]);
    expect(get("Q2")).toMatchObject({ status: "answered", answer: { via: "chat-worker", optionKey: "b", at: at(8) }, grant: { effects: ["dependency-install"] } });
    // The block names only Q2: Q1 stays open, not needs-confirmation.
    expect(get("Q1")?.status).toBe("open");
    expect(settled.map((entry) => entry.decisions.map((decision) => decision.id))).toEqual([[idOf("Q2")]]);
  });

  it("an answer relayed by an agent settles nothing", async () => {
    await ask();
    const outcome = await materialiseTurn(workerTurn({ sent: [msg(WORKER, at(8), `Continue ${REQUEST}.\n\n${cardAnswer(["Q2: b — Postgres"])}`, "agent")] }), deps());
    expect(outcome.answered).toEqual([]);
    expect(outcome.marked).toEqual([]);
    expect(get("Q2")?.status).toBe("open");
  });

  it("other owner text marks the request's open questions needs-confirmation", async () => {
    await ask();
    await materialiseTurn(workerTurn({ sent: [msg(WORKER, at(8), cardAnswer(["Q2: a — SQLite"]), "user")] }), deps());
    const outcome = await materialiseTurn(workerTurn({ sent: [msg(WORKER, at(9), "Just push the contract, leave the other one.", "user")] }), deps());
    expect(outcome.marked.map((decision) => decision.id)).toEqual([idOf("Q1")]);
    expect(get("Q1")).toMatchObject({ status: "needs-confirmation", needsConfirmation: { via: "chat-worker", at: at(9) } });
    expect(get("Q2")?.status).toBe("answered");
    expect(outcome.answered).toEqual([]);
  });

  it("marks nothing of another request, and nothing without a request", async () => {
    await ask();
    await materialiseTurn(workerTurn({ requestId: OTHER_REQUEST, sent: [msg(WORKER, at(8), "go on", "user")] }), deps());
    await materialiseTurn(workerTurn({ requestId: null, sent: [msg(WORKER, at(8), "go on", "user")] }), deps());
    expect(get("Q1")?.status).toBe("open");
  });

  it("the same owner message never marks a question again after the owner kept it open", async () => {
    await ask();
    const record = workerTurn({ sent: [msg(WORKER, at(9), "push the contract", "user")] });
    await materialiseTurn(record, deps());
    store().transition(idOf("Q1"), (decision) => confirmDecision(decision, { answered: false, at: at(10) }), WORKSPACE_ID);
    const before = fileBytes();
    const again = await materialiseTurn(record, deps());
    expect(again.marked).toEqual([]);
    expect(get("Q1")?.status).toBe("open");
    expect(fileBytes()).toBe(before);
  });

  it("a plugin notice or an agent's message marks nothing", async () => {
    await ask();
    await materialiseTurn(workerTurn({ sent: [msg(WORKER, at(9), "BM-TOOLS the tools changed", "agent"), msg(WORKER, at(9), "carry on")] }), deps());
    expect(get("Q1")?.status).toBe("open");
  });
});

describe("pure readers", () => {
  const decision = { options: [{ key: "a", label: "A", recommended: false, effects: [] }, { key: "b", label: "B", recommended: false, effects: [] }] };

  it("reads an option letter only when the decision has that option", () => {
    expect(answerInputOf(decision, "a — Push contract only")).toEqual({ optionKey: "a" });
    expect(answerInputOf(decision, "(b) Postgres")).toEqual({ optionKey: "b" });
    expect(answerInputOf(decision, "B")).toEqual({ optionKey: "b" });
    expect(answerInputOf(decision, "c — something")).toEqual({ words: "c — something" });
    expect(answerInputOf(decision, "a lot of care, please")).toEqual({ words: "a lot of care, please" });
    expect(answerInputOf(decision, "b-tree index is fine")).toEqual({ words: "b-tree index is fine" });
  });

  it("reads other — words as the owner's words", () => {
    expect(answerInputOf(decision, "other — Postgres")).toEqual({ words: "Postgres" });
    expect(answerInputOf(decision, "otherwise keep it")).toEqual({ words: "otherwise keep it" });
    expect(answerInputOf(decision, "other —")).toBeNull();
    expect(answerInputOf(decision, "  ")).toBeNull();
  });

  it("normalises question text for comparison", () => {
    expect(normalisedQuestion("Which  DATABASE, for the tests?")).toBe(normalisedQuestion("which database for the tests"));
  });
});

describe("wiring", () => {
  it("the onRecorded step materialises the record under the trace store's data folder", async () => {
    const step = createDecisionMaterialiser({ now: () => new Date(NOW), log: () => {}, workerOf: async () => WORKER });
    const outcome = await step({} as never, { location: { tracesDir: join(home, "traces") }, paseo: PASEO, record: askedTurn() });
    expect(outcome?.opened).toHaveLength(2);
    expect(get("Q1")?.status).toBe("open");
  });

  it("does nothing without a record", async () => {
    const step = createDecisionMaterialiser();
    expect(await step({} as never, { location: { tracesDir: join(home, "traces") }, paseo: PASEO })).toBeNull();
  });

  it("the default Worker lookup finds the live Worker labelled with the request", async () => {
    const snapshot = (id: string, extra: Record<string, unknown> = {}, labels: Record<string, string> = {}) => ({
      id,
      provider: "bm-worker",
      status: "idle",
      archivedAt: null,
      workspaceId: WORKSPACE_ID,
      ...extra,
      labels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER, ...labels },
    });
    const paseoWith = (entries: unknown[]) => ({ agents: { list: async () => ({ entries }) } });
    const input = { requestId: REQUEST, workspaceId: WORKSPACE_ID, managerId: MANAGER };
    expect(await workerOfRequest(input, paseoWith([snapshot("w1"), snapshot("w0", { archivedAt: at(1) })]))).toBe("w1");
    expect(await workerOfRequest(input, paseoWith([snapshot("w1"), snapshot("w2", {}, { "bm.replacedBy": "w3" })]))).toBe("w1");
    expect(await workerOfRequest(input, paseoWith([snapshot("w1"), snapshot("w2")]))).toBeNull();
    expect(await workerOfRequest(input, undefined)).toBeNull();
  });
});
