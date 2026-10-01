import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_TOUCHED_BEAD,
  answerInputOf,
  citedDecisionIds,
  clearMaterialiserMemory,
  createDecisionMaterialiser,
  materialiseTurn,
  normalisedQuestion,
  reopensOf,
  workerOfRequest,
  type MaterialiserDeps,
} from "../plugin/server/decision-materialiser";
import { DECISIONS_DIR_NAME, clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, handleDecisionsList } from "../plugin/server/decision-rpc";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { decideRefusalOf, predictionRefusalOf, type AutonomyPolicy } from "../plugin/shared/autonomy";
import { GRANT_TTL_MS, answerDecision, confirmDecision, markNeedsConfirmation, type Decision } from "../plugin/shared/decisions";
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

describe("classes (autonomy design §B.1)", () => {
  it("stores the class its effects imply when the Worker proposes none", async () => {
    await ask();
    expect(get("Q1")?.class).toBe("release");
    expect(get("Q2")?.class).toBe("dependency");
    await ask("Q3: Rename the helper?\n- a: Yes (recommended) [effects: commit]\n- b: No", at(4));
    expect(get("Q3")?.class).toBe("reversible-technical");
  });

  it("stores the Worker's proposal when it is the riskier, and raises it to the effects' class when not", async () => {
    await ask(
      [
        "Q1: Ship the auth change? [subject: auth] [class: security]",
        "- a: Push it (recommended) [effects: push]",
        "- b: Hold",
        "Q2: Push the fix now? [class: reversible-technical]",
        "- a: Push (recommended) [effects: push]",
        "- b: Hold [effects: none]",
        "Q3: Which wording? [class: preference]",
        "- a: Short (recommended)",
        "- b: Long",
      ].join("\n"),
    );
    expect(get("Q1")?.class).toBe("security");
    // Negative: reversible-technical on an option that pushes is a release.
    expect(get("Q2")?.class).toBe("release");
    expect(get("Q3")?.class).toBe("preference");
  });

  it("changes nothing when the same turn is read again, whatever class the block names then", async () => {
    await ask("Q1: Which wording? [class: preference]\n- a: Short (recommended)\n- b: Long");
    const before = fileBytes();
    const again = await ask("Q1: Which wording? [class: security]\n- a: Short (recommended)\n- b: Long");
    expect(again.opened).toEqual([]);
    expect(fileBytes()).toBe(before);
    expect(get("Q1")?.class).toBe("preference");
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

describe("expiry at a finished report (§A.3)", () => {
  /** A Worker's finished report, as the Manager receives it. */
  const finished = (requestId = REQUEST) =>
    ["BM-REPORT", `requestId: ${requestId}`, "phase: finished", "tier: Medium", "buildAndTests: npm test: pass", "blockers: none"].join("\n");
  const finishedTurn = (when = at(6), requestId = REQUEST) => managerTurn({ sent: [msg(MANAGER, when, finished(requestId), "agent")] });
  const rpc = () => ({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => new Date(NOW) });

  it("expires the request's unsettled q: decisions and nothing else", async () => {
    await ask();
    await ask("Q3: Rename the table?\n- a: Yes (recommended)\n- b: No", at(3));
    await materialiseTurn(managerTurn({ sent: [msg(MANAGER, at(3), report("Q1: Which port?\n- a: 8080 (recommended)", OTHER_REQUEST), "agent")] }), deps());
    store().transition(idOf("Q2"), (decision) => answerDecision(decision, { via: "inbox", optionKey: "a", at: at(4) }), WORKSPACE_ID);
    store().transition(idOf("Q3"), (decision) => markNeedsConfirmation(decision, { via: "chat-worker", at: at(4) }), WORKSPACE_ID);
    const base = get("Q1")!;
    store().open({ ...base, id: "o:ask-1", askedBy: { role: "orchestrator", agentId: null }, round: null, subject: null });
    store().open({ ...base, id: "f:fb-1", askedBy: { role: "plugin", agentId: null }, round: null, subject: null });
    const answered = get("Q2");

    const outcome = await materialiseTurn(finishedTurn(at(6)), deps());

    expect(outcome.expired.map((decision) => decision.id)).toEqual([idOf("Q1"), idOf("Q3")]);
    expect(get("Q1")).toMatchObject({ status: "expired", settledAt: at(6), needsConfirmation: null, answer: null, grant: null, delivery: null });
    expect(get("Q3")).toMatchObject({ status: "expired", settledAt: at(6), needsConfirmation: null });
    // Settled already, another request, the Orchestrator's own and a fallback incident: untouched.
    expect(get("Q2")).toEqual(answered);
    expect(get("Q1", OTHER_REQUEST)?.status).toBe("open");
    expect(store().get("o:ask-1", WORKSPACE_ID)?.status).toBe("open");
    expect(store().get("f:fb-1", WORKSPACE_ID)?.status).toBe("open");
    expect(outcome.answered).toEqual([]);
    expect(settled).toEqual([]);
  });

  it("an answer after expiry is refused, and the Inbox no longer lists them", async () => {
    await ask();
    const inbox = () => handleDecisionsList({ scope: "inbox", workspaceId: WORKSPACE_ID }, rpc()).decisions.map((decision) => decision.id).sort();
    expect(inbox()).toEqual([idOf("Q1"), idOf("Q2")]);
    await materialiseTurn(finishedTurn(), deps());
    expect(inbox()).toEqual([]);

    const before = fileBytes();
    await expect(handleDecisionsAnswer({ id: idOf("Q1"), optionKey: "c" }, PASEO, rpc())).rejects.toThrow(
      `E_DECISION_SETTLED: decision ${idOf("Q1")} is expired; it can no longer be answered`,
    );
    await expect(handleDecisionsAnswer({ id: idOf("Q2"), words: "SQLite" }, PASEO, rpc())).rejects.toThrow("E_DECISION_SETTLED");
    expect(fileBytes()).toBe(before);
    // Still stored and readable, so the card can say why.
    expect(handleDecisionsList({ scope: "request", workspaceId: WORKSPACE_ID, requestId: REQUEST }, rpc()).decisions.map((decision) => decision.status)).toEqual([
      "expired",
      "expired",
    ]);
  });

  it("bm_decide and bm_predict refuse an expired question as any settled one (their rules)", async () => {
    await ask();
    // Q2 is `dependency` by its effects: delegated to the Orchestrator, or predicted with the challenger on.
    const delegated: AutonomyPolicy = { projects: { [WORKSPACE_ID]: { dependency: { mode: "delegate", predictor: "orchestrator", at: NOW } } }, challenger: {} };
    const challenger: AutonomyPolicy = { projects: {}, challenger: { [WORKSPACE_ID]: true } };
    expect(decideRefusalOf(delegated, get("Q2")!)).toBeNull();
    expect(predictionRefusalOf(challenger, get("Q2")!)).toBeNull();
    await materialiseTurn(finishedTurn(), deps());
    expect(decideRefusalOf(delegated, get("Q2")!)).toBe(`decision ${idOf("Q2")} is expired; it can no longer be answered`);
    expect(predictionRefusalOf(challenger, get("Q2")!)).toBe(`decision ${idOf("Q2")} is expired; only an open decision is predicted`);
  });

  it("a question asked after the report stays open, and reading the turn again changes nothing", async () => {
    await ask();
    const done = finishedTurn(at(4));
    await materialiseTurn(done, deps());
    // The owner sent the Worker on, and it asks again.
    await ask("Q3: Keep the old endpoint?\n- a: Yes (recommended)\n- b: No", at(6));
    const before = fileBytes();
    const again = await materialiseTurn(done, deps());
    expect(again.expired).toEqual([]);
    expect(get("Q3")?.status).toBe("open");
    expect(fileBytes()).toBe(before);
  });

  it("the owner's answer in the same turn stands, and a question opened and finished in one turn is handed on expired", async () => {
    const outcome = await materialiseTurn(
      managerTurn({
        sent: [msg(MANAGER, at(2), report(ROUND_ONE), "agent"), msg(MANAGER, at(3), finished(), "agent"), msg(MANAGER, at(4), "Push the contract only.", "user")],
        received: [msg(MANAGER, at(5), ["BM-ANSWERS", `requestId: ${REQUEST}`, "Q1: a — Push contract only"].join("\n"))],
      }),
      deps(),
    );
    expect(get("Q1")).toMatchObject({ status: "answered", answer: { via: "chat-manager", optionKey: "a" } });
    expect(outcome.expired.map((decision) => decision.id)).toEqual([idOf("Q2")]);
    // As stored: no event asks the Orchestrator about a question that expired.
    expect(outcome.opened.map((decision) => [decision.id, decision.status])).toEqual([
      [idOf("Q1"), "open"],
      [idOf("Q2"), "expired"],
    ]);
    expect(settled.map((entry) => entry.decisions.map((decision) => decision.id))).toEqual([[idOf("Q1")]]);
  });

  it("expires nothing on a report that is not the Worker's finished one for that request", async () => {
    await ask();
    const before = fileBytes();
    const records = [
      // The owner's typed text, a plugin notice, no request, another phase, another request.
      managerTurn({ sent: [msg(MANAGER, at(6), finished(), "user")] }),
      managerTurn({ sent: [msg(MANAGER, at(6), `BM-COMMAND\nfrom: orchestrator\n${finished()}`, "agent")] }),
      managerTurn({ sent: [msg(MANAGER, at(6), finished().replace(`requestId: ${REQUEST}\n`, ""), "agent")] }),
      managerTurn({ sent: [msg(MANAGER, at(6), finished().replace("phase: finished", "phase: beads-done"), "agent")] }),
      finishedTurn(at(6), OTHER_REQUEST),
      // The Manager's own reply, and a Worker's own turn.
      managerTurn({ received: [msg(MANAGER, at(6), finished())] }),
      workerTurn({ received: [msg(WORKER, at(6), finished())] }),
    ];
    for (const record of records) expect((await materialiseTurn(record, deps())).expired).toEqual([]);
    expect([get("Q1")?.status, get("Q2")?.status]).toEqual(["open", "open"]);
    expect(fileBytes()).toBe(before);
  });
});

describe("predictions and reversals (autonomy design §B.3)", () => {
  /** The owner answers a question with an option, in the Inbox, at `when`. */
  const answer = (qn: string, optionKey: string, when: string) =>
    store().transition(idOf(qn), (decision) => answerDecision(decision, { via: "inbox", optionKey, at: when }), WORKSPACE_ID);
  /** A Worker turn that ran one shell command at `when`, as the collector records it. */
  const ranTurn = (command: string, when = at(10)) => workerTurn({ endedAt: when, evidence: [{ kind: "shell", detail: command, agentId: WORKER, at: when }] });

  it("records the recommended option as the prediction when a question opens, and none without one", async () => {
    await ask();
    expect(get("Q1")?.prediction).toEqual({ recommended: { optionKey: "a" }, orchestrator: null });
    expect(get("Q2")?.prediction).toEqual({ recommended: { optionKey: "a" }, orchestrator: null });
    await ask("Q3: Rename the table? [subject: table-name]\n- a: Yes\n- b: No", at(3));
    expect(get("Q3")?.prediction).toEqual({ recommended: null, orchestrator: null });
  });

  it("a re-ask with the same subject after the answer reverses it (kind 1); before the answer it is supersession only", async () => {
    await ask();
    // Still open: the re-ask supersedes Q1, which is no reversal.
    const early = await ask("Q3: Push which backends? [subject: push-backends] [supersedes: Q1]\n- a: Contract only (recommended) [effects: push]\n- b: Hold", at(3));
    expect(get("Q1")).toMatchObject({ status: "superseded", supersededBy: idOf("Q3") });
    expect(get("Q1")).not.toHaveProperty("reversals");
    expect(early.reversed).toEqual([]);

    expect(answer("Q3", "a", at(4)).status).toBe("updated");
    const reask = "Q4: Push the manifest as well? [subject: push-backends]\n- a: Yes [effects: push]\n- b: No";
    const later = await ask(reask, at(5));
    expect(get("Q3")?.reversals).toEqual([{ kind: "re-asked", at: at(5), ref: idOf("Q4") }]);
    expect(later.reversed.map((decision) => decision.id)).toEqual([idOf("Q3")]);
    // The superseded Q1 was never answered: nothing to reverse.
    expect(get("Q1")).not.toHaveProperty("reversals");

    // Reading the same turn again records nothing more; another subject reverses nothing.
    const before = fileBytes();
    expect((await ask(reask, at(5))).reversed).toEqual([]);
    expect(fileBytes()).toBe(before);
    await ask("Q5: Name the branch? [subject: branch-name]\n- a: dev", at(6));
    expect(get("Q3")?.reversals).toHaveLength(1);
  });

  it("a br reopen whose reason cites q:<req>:Q2 reverses that answered decision (kind 3); a reopen citing nothing records nothing", async () => {
    await ask();
    answer("Q2", "a", at(4));
    const before = fileBytes();
    // A review finding, the baseline's noise: no reason, or one that cites no decision.
    for (const command of ["br reopen bm-12", `br reopen bm-12 --reason "blocking review finding: the migration test is missing"`]) {
      expect((await materialiseTurn(ranTurn(command), deps())).reversed).toEqual([]);
    }
    expect(fileBytes()).toBe(before);

    const cited = await materialiseTurn(ranTurn(`br reopen bm-12 --reason "the owner reversed q:${REQUEST}:Q2: Postgres after all"`), deps());
    expect(get("Q2")?.reversals).toEqual([{ kind: "reopened", at: at(10), ref: "bm-12" }]);
    expect(cited.reversed.map((decision) => decision.id)).toEqual([idOf("Q2")]);
    // The same record read again (Paseo reuses turn ids) records nothing more.
    const once = fileBytes();
    expect((await materialiseTurn(ranTurn(`br reopen bm-12 --reason "the owner reversed q:${REQUEST}:Q2: Postgres after all"`), deps())).reversed).toEqual([]);
    expect(fileBytes()).toBe(once);
  });

  it("a bare Qn cites the Worker's request; an open decision, or a reopen before the answer, is not reversed", async () => {
    await ask();
    answer("Q2", "b", at(4));
    await materialiseTurn(ranTurn("cd /work/invoice-app && br reopen bm-7 bm-8 -r 'Q2 changed: SQLite' && br update bm-7 --status in_progress", at(11)), deps());
    expect(get("Q2")?.reversals).toEqual([
      { kind: "reopened", at: at(11), ref: "bm-7" },
      { kind: "reopened", at: at(11), ref: "bm-8" },
    ]);
    // Q1 is still open: there is no answer to reverse.
    await materialiseTurn(ranTurn(`br reopen bm-9 --reason "Q1 changed"`, at(12)), deps());
    expect(get("Q1")?.status).toBe("open");
    expect(get("Q1")).not.toHaveProperty("reversals");
    // A reopen timed before the answer did not reverse it.
    answer("Q1", "a", at(20));
    await materialiseTurn(ranTurn(`br reopen --reason "Q1 changed"`, at(13)), deps());
    expect(get("Q1")).not.toHaveProperty("reversals");
    // Naming no bead reopens the last touched one.
    await materialiseTurn(ranTurn(`br reopen --reason "Q1 changed"`, at(21)), deps());
    expect(get("Q1")?.reversals).toEqual([{ kind: "reopened", at: at(21), ref: LAST_TOUCHED_BEAD }]);
  });

  it("reads the br reopen calls of a shell command, with their beads and reason", () => {
    expect(reopensOf(`br reopen bm-1 --reason "Q2 changed"`)).toEqual([{ beads: ["bm-1"], reason: "Q2 changed" }]);
    expect(reopensOf("br --no-db reopen bm-1 bm-2 -r 'it was q:req-1:Q2' --json")).toEqual([{ beads: ["bm-1", "bm-2"], reason: "it was q:req-1:Q2" }]);
    expect(reopensOf("br reopen --reason=late --actor me bm-3; br reopen bm-4")).toEqual([
      { beads: ["bm-3"], reason: "late" },
      { beads: ["bm-4"], reason: null },
    ]);
    expect(reopensOf(`br close bm-1 --reason "Q2"`)).toEqual([]);
    expect(reopensOf(`br reopen bm-1 --reason "say \\"Q2\\" again" | tail -1`)).toEqual([{ beads: ["bm-1"], reason: 'say "Q2" again' }]);
  });

  it("finds the decisions a reason cites: ids, and a bare Qn of the request it names or of the Worker's", () => {
    expect(citedDecisionIds(`reverses q:${REQUEST}:Q2 and o:3f2a-9c`, null)).toEqual([idOf("Q2"), "o:3f2a-9c"]);
    expect(citedDecisionIds("Q2 changed", REQUEST)).toEqual([idOf("Q2")]);
    expect(citedDecisionIds(`Q3 of ${OTHER_REQUEST}`, REQUEST)).toEqual([idOf("Q3", OTHER_REQUEST)]);
    expect(citedDecisionIds("Q2 changed", null)).toEqual([]);
    expect(citedDecisionIds("blocking review finding, see FAQ1 and SEQ2", REQUEST)).toEqual([]);
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

describe("owner precedents (autonomy design §B.6)", () => {
  let precedentIds = 0;
  const precedents = () => createPrecedentStore(home, { newId: () => `b${++precedentIds}` });
  const savePrecedent = (subject: string, text: string) =>
    precedents().save({ scope: WORKSPACE_ID, subject, text, sourceDecisionId: null, expiresInDays: 30 }, new Date(NOW)).precedent;
  const ON_SUBJECTS = [
    "Q1: Push both backends to origin/dev? [subject: push-backends]",
    "- a: Push contract only (recommended) [effects: push]",
    "- c: Hold",
    "Q2: Which database for the tests? [subject: test-db]",
    "- a: SQLite (recommended)",
    "- b: Postgres [effects: dependency-install]",
  ].join("\n");

  it("answers a question on an active precedent's subject at open and hands it to onSettled; a release question stays the owner's", async () => {
    const database = savePrecedent("test-db", "SQLite");
    savePrecedent("push-backends", "Hold");
    const outcome = await ask(ON_SUBJECTS);
    expect(outcome.opened.map((decision) => [decision.id, decision.status])).toEqual([
      [idOf("Q1"), "open"],
      [idOf("Q2"), "answered"],
    ]);
    expect(get("Q2")).toMatchObject({ status: "answered", answer: { by: "precedent", via: "inbox", optionKey: "a", precedentId: database.id, at: NOW } });
    expect(outcome.answered.map((decision) => decision.id)).toEqual([idOf("Q2")]);
    expect(settled.map((entry) => entry.decisions.map((decision) => decision.id))).toEqual([[idOf("Q2")]]);
    // Release: kept open, nothing delivered for it.
    expect(get("Q1")).toMatchObject({ status: "open", answer: null });
  });

  it("leaves a subject a precedent already answered in the request to the owner when it is asked again", async () => {
    savePrecedent("test-db", "SQLite");
    await ask(ON_SUBJECTS);
    settled = [];
    // Asked in a later turn, after the precedent's answer.
    const later = "2026-09-26T11:05:00.000Z";
    const again = await ask(["Q3: Which database, really? [subject: test-db]", "- a: SQLite (recommended)", "- b: Postgres"].join("\n"), later);
    expect(again.opened.map((decision) => decision.id)).toEqual([idOf("Q3")]);
    expect(get("Q3")).toMatchObject({ status: "open", answer: null });
    expect(settled).toEqual([]);
    // Asked again after its answer: that answer is reversed, as any re-ask (§B.3).
    expect(get("Q2")?.reversals).toEqual([{ kind: "re-asked", at: later, ref: idOf("Q3") }]);
  });

  it("an owner's answer in the Worker's chat that differs from the precedent supersedes it", async () => {
    await ask(ON_SUBJECTS);
    // Saved after the question opened, so it did not answer it.
    const database = savePrecedent("test-db", "SQLite");
    const reply = ["BM-ANSWERS", `requestId: ${REQUEST}`, "Q2: b — Postgres"].join("\n");
    await materialiseTurn(workerTurn({ sent: [msg(WORKER, at(8), reply, "user")] }), deps());
    expect(get("Q2")?.answer).toMatchObject({ by: "owner", optionKey: "b" });
    expect(precedents().get(database.id)?.supersededBy).toBe(idOf("Q2"));
  });

  it("the owner's policy (autonomy design §B.5): a delegated class of the recommended predictor is answered at open and handed to onSettled; the precedent still comes first", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "dependency", mode: "delegate", confirmed: true, predictor: "recommended" }, NOW);
    const outcome = await ask(ON_SUBJECTS);
    expect(outcome.opened.map((decision) => [decision.id, decision.status])).toEqual([
      [idOf("Q1"), "open"],
      [idOf("Q2"), "answered"],
    ]);
    expect(get("Q2")?.answer).toMatchObject({ by: "policy", via: "inbox", optionKey: "a", class: "dependency", predictor: "recommended", at: NOW });
    expect(settled.map((entry) => entry.decisions.map((decision) => decision.id))).toEqual([[idOf("Q2")]]);

    // Another request: the owner's precedent on the subject answers, not the recommended option.
    const database = savePrecedent("test-db", "Postgres");
    const other = await materialiseTurn(managerTurn({ sent: [msg(MANAGER, at(3), report(ON_SUBJECTS, OTHER_REQUEST), "agent")] }), deps());
    expect(other.answered.map((decision) => decision.id)).toEqual([idOf("Q2", OTHER_REQUEST)]);
    expect(get("Q2", OTHER_REQUEST)?.answer).toMatchObject({ by: "precedent", optionKey: "b", precedentId: database.id });
  });
});
