import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agreementLedger, agreementRateOf, type AgreementCell } from "../plugin/shared/autonomy-ledger";
import { autonomyLedgerRpc } from "../plugin/shared/contracts";
import {
  answerDecision,
  confirmDecision,
  decisionSchema,
  markNeedsConfirmation,
  recordReversal,
  type Decision,
  type DecisionOption,
  type DecisionPrediction,
  type ReversalKind,
  type TransitionResult,
} from "../plugin/shared/decisions";
import { handleAutonomyLedger, registerAutonomyLedgerRpcs, type AutonomyLedgerRpcDeps } from "../plugin/server/autonomy-ledger-rpc";
import { DECISIONS_DIR_NAME, clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { decisionSummaryOf } from "../plugin/server/decision-tools";
import { DECISION_REQUEST, DECISION_WS, makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";

/**
 * The agreement ledger (autonomy design §B.3, ADR-018; PRD REQ-122 a):
 * derived from the decision records, per project × class × predictor. The
 * pure module first, then `autonomy.ledger` against a temporary data folder
 * named by `PASEO_BM_HOME`. Never the real HOME.
 */

const OTHER_WS = "wks_2";
/** Noon UTC on 2026-09-(1 + n). */
const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n, 12)).toISOString();

/** Three options that declare no effect, so the class stays the one given; `a` is recommended. */
const OPTIONS: DecisionOption[] = [
  { key: "a", label: "Keep the list in the users table", recommended: true, effects: ["none"] },
  { key: "b", label: "A new table", recommended: false, effects: ["none"] },
  { key: "c", label: "Hold", recommended: false, effects: ["none"] },
];
const RECOMMENDED: DecisionPrediction = { recommended: { optionKey: "a" }, orchestrator: null };
const CHALLENGER_REASON = "The owner held the last two scope questions until the review.";

function ok(result: TransitionResult): Decision {
  if (!result.ok) throw new Error(`refused: ${result.refusal} — ${result.message}`);
  return decisionSchema.parse(result.decision);
}

let serial = 0;

/** An open decision of class `scope` with the recommended prediction, unless told otherwise. */
function asked(overrides: Partial<Decision> = {}): Decision {
  serial += 1;
  const requestId = overrides.requestId === undefined ? DECISION_REQUEST : overrides.requestId;
  return makeDecision({ id: `q:${requestId}:Q${serial}`, class: "scope", options: OPTIONS, prediction: RECOMMENDED, ...overrides });
}

/** The owner's answer, in the Inbox. */
function ownerAnswer(decision: Decision, answer: { optionKey: string } | { words: string }, at: string): Decision {
  return ok(answerDecision(decision, { via: "inbox", at, ...answer }));
}

function reversed(decision: Decision, ...reversals: Array<[ReversalKind, string]>): Decision {
  return reversals.reduce((current, [kind, ref]) => ok(recordReversal(current, { kind, at: current.answer!.at, ref })), decision);
}

const cellOf = (overrides: Partial<AgreementCell>): AgreementCell => ({
  workspaceId: DECISION_WS,
  class: "scope",
  predictor: "recommended",
  count: 0,
  agreed: 0,
  unread: 0,
  firstAt: null,
  lastAt: null,
  reversals: 0,
  reversalsByKind: { "re-asked": 0, overridden: 0, reopened: 0 },
  ...overrides,
});

beforeEach(() => {
  serial = 0;
});

describe("agreement per project × class × predictor", () => {
  it("counts the owner's answers and those that chose the predicted option, with the first and last answer time", () => {
    const decisions = [
      ownerAnswer(asked(), { optionKey: "a" }, day(0)),
      ownerAnswer(asked(), { optionKey: "b" }, day(5)),
      ownerAnswer(asked(), { optionKey: "a" }, day(2)),
      ownerAnswer(asked({ class: "preference" }), { optionKey: "a" }, day(1)),
      ownerAnswer(asked({ workspaceId: OTHER_WS }), { optionKey: "c" }, day(3)),
    ];
    const { cells, delegated } = agreementLedger(decisions);
    expect(cells).toEqual([
      cellOf({ count: 3, agreed: 2, firstAt: day(0), lastAt: day(5) }),
      cellOf({ class: "preference", count: 1, agreed: 1, firstAt: day(1), lastAt: day(1) }),
      cellOf({ workspaceId: OTHER_WS, count: 1, agreed: 0, firstAt: day(3), lastAt: day(3) }),
    ]);
    expect(delegated).toEqual([]);
    expect(agreementRateOf(cells[0]!)).toBeCloseTo(2 / 3);
  });

  it("counts an answer in the owner's own words, which never agrees — not even one naming the option", () => {
    const decisions = [ownerAnswer(asked(), { words: "a" }, day(0)), ownerAnswer(asked(), { words: "Keep the list in the users table" }, day(1))];
    expect(agreementLedger(decisions).cells).toEqual([cellOf({ count: 2, agreed: 0, firstAt: day(0), lastAt: day(1) })]);
  });

  it("a decision with no recommended option has no recommended prediction, and one opened before predictions is in no cell", () => {
    const none = ownerAnswer(asked({ options: OPTIONS.map((option) => ({ ...option, recommended: false })), prediction: { recommended: null, orchestrator: null } }), { optionKey: "a" }, day(0));
    const before: Decision = asked();
    delete before.prediction;
    const older = ownerAnswer(before, { optionKey: "a" }, day(1));
    expect(older).not.toHaveProperty("prediction");
    expect(agreementLedger([none, older])).toEqual({ cells: [], delegated: [] });
  });

  it("splits cells by predictor: each is judged against its own prediction", () => {
    const challenged = { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: CHALLENGER_REASON, at: day(0) } };
    const decisions = [
      ownerAnswer(asked({ prediction: challenged }), { optionKey: "b" }, day(0)),
      ownerAnswer(asked({ prediction: challenged }), { optionKey: "b" }, day(1)),
      // The challenger was off for this one: only the recommended cell has it.
      ownerAnswer(asked(), { optionKey: "a" }, day(2)),
    ];
    expect(agreementLedger(decisions).cells).toEqual([
      cellOf({ predictor: "recommended", count: 3, agreed: 1, firstAt: day(0), lastAt: day(2) }),
      cellOf({ predictor: "orchestrator", count: 2, agreed: 2, firstAt: day(0), lastAt: day(1) }),
    ]);
  });

  it("counts each reversed decision once, and once per kind however often that kind recurs", () => {
    const decisions = [
      reversed(ownerAnswer(asked(), { optionKey: "a" }, day(0)), ["re-asked", "q:x:Q7"], ["re-asked", "q:x:Q9"], ["reopened", "bm-3"]),
      reversed(ownerAnswer(asked(), { optionKey: "a" }, day(1)), ["overridden", "r:5b1e"]),
      reversed(ownerAnswer(asked(), { optionKey: "a" }, day(2)), ["reopened", "bm-4"], ["reopened", "bm-5"]),
      ownerAnswer(asked(), { optionKey: "a" }, day(3)),
    ];
    expect(agreementLedger(decisions).cells).toEqual([
      cellOf({ count: 4, agreed: 4, firstAt: day(0), lastAt: day(3), reversals: 3, reversalsByKind: { "re-asked": 1, overridden: 1, reopened: 2 } }),
    ]);
  });

  it("a chat answer the owner confirmed, never read, is unread: in neither count nor agreed", () => {
    const waiting = ok(markNeedsConfirmation(asked(), { via: "chat-worker", at: day(0) }));
    const confirmed = reversed(ok(confirmDecision(waiting, { answered: true, at: day(0) })), ["re-asked", "q:x:Q8"]);
    expect(agreementLedger([confirmed]).cells).toEqual([cellOf({ unread: 1, reversals: 1, reversalsByKind: { "re-asked": 1, overridden: 0, reopened: 0 } })]);
  });

  it("reads only answered decisions: an open, superseded, withdrawn or expired decision is in no figure", () => {
    const open = asked({ prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "c", reason: CHALLENGER_REASON, at: day(0) } } });
    const others = (["superseded", "withdrawn", "expired"] as const).map((status) =>
      asked({ status, settledAt: day(1), ...(status === "superseded" ? { supersededBy: `q:${DECISION_REQUEST}:Q99` } : {}) }),
    );
    expect(agreementLedger([open, ...others])).toEqual({ cells: [], delegated: [] });
  });

  it("keeps one project, or the answers given since a time", () => {
    const decisions = [ownerAnswer(asked(), { optionKey: "a" }, day(0)), ownerAnswer(asked(), { optionKey: "b" }, day(4)), ownerAnswer(asked({ workspaceId: OTHER_WS }), { optionKey: "a" }, day(4))];
    expect(agreementLedger(decisions, { workspaceId: OTHER_WS }).cells).toEqual([cellOf({ workspaceId: OTHER_WS, count: 1, agreed: 1, firstAt: day(4), lastAt: day(4) })]);
    expect(agreementLedger(decisions, { workspaceId: DECISION_WS, since: day(3) }).cells).toEqual([cellOf({ count: 1, agreed: 0, firstAt: day(4), lastAt: day(4) })]);
    expect(agreementRateOf(cellOf({}))).toBeNull();
  });
});

describe("answers not given by the owner", () => {
  it("a by: orchestrator answer (change-004) is in neither the agreement nor the delegated figures (change-007 C4)", () => {
    const decided = ok(storedOrchestratorAnswer(asked(), { optionKey: "a", reason: "The list already lives there.", at: day(0) }));
    expect(decided.prediction).toEqual(RECOMMENDED);
    expect(agreementLedger([reversed(decided, ["reopened", "bm-1"])])).toEqual({ cells: [], delegated: [] });
  });

  it("counts the decisions the policy or a precedent answered apart, with their overrides and reversals", () => {
    // A recommended answer is one an older build stored (ADR-025): a new policy answer is the Orchestrator's.
    const policy = (at: string, predictor: "recommended" | "orchestrator" = "recommended") => {
      const answered = ok(answerDecision(asked(), { by: "policy", via: "autopilot", optionKey: "a", reason: "recommended option, class delegated", class: "scope", at }));
      return predictor === "recommended" ? { ...answered, answer: { ...answered.answer!, predictor } } : answered;
    };
    const precedent = (at: string) => ok(answerDecision(asked(), { by: "precedent", via: "inbox", words: "Keep lists in existing tables.", precedentId: "p-1", at }));
    const decisions = [
      policy(day(1)),
      reversed(policy(day(2)), ["overridden", "r:0a1b"], ["reopened", "bm-2"]),
      reversed(policy(day(3)), ["reopened", "bm-3"]),
      policy(day(4), "orchestrator"),
      reversed(precedent(day(5)), ["overridden", "r:0a1c"]),
    ];
    const { cells, delegated } = agreementLedger(decisions);
    // Delegated answers never count as the owner's agreement.
    expect(cells).toEqual([]);
    const none = { "re-asked": 0, overridden: 0, reopened: 0 };
    expect(delegated).toEqual([
      { workspaceId: DECISION_WS, class: "scope", by: "policy", predictor: "recommended", count: 3, overridden: 1, reversals: 2, reversalsByKind: { ...none, overridden: 1, reopened: 2 }, firstAt: day(1), lastAt: day(3) },
      { workspaceId: DECISION_WS, class: "scope", by: "policy", predictor: "orchestrator", count: 1, overridden: 0, reversals: 0, reversalsByKind: none, firstAt: day(4), lastAt: day(4) },
      { workspaceId: DECISION_WS, class: "scope", by: "precedent", predictor: null, count: 1, overridden: 1, reversals: 1, reversalsByKind: { ...none, overridden: 1 }, firstAt: day(5), lastAt: day(5) },
    ]);
  });
});

describe("autonomy.ledger (the read-only RPC)", () => {
  let root: string;
  let home: string;
  let deps: AutonomyLedgerRpcDeps;
  const open = (decision: Decision) => createDecisionStore(home).open(decision);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bm-autonomy-ledger-"));
    home = join(root, "data");
    deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, log: () => {} };
    clearDecisionStoreCache();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("derives the cells of every project or of one from the store, numbers and times only", () => {
    const challenged = { recommended: { optionKey: "a" }, orchestrator: { optionKey: "c", reason: CHALLENGER_REASON, at: day(0) } };
    open(ownerAnswer(asked({ prediction: challenged }), { optionKey: "a" }, day(1)));
    open(ownerAnswer(asked({ workspaceId: OTHER_WS }), { optionKey: "b" }, day(2)));
    // Still open: its prediction is never in any figure, nor anywhere in the answer.
    open(asked({ prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: "Unsettled: not for the owner yet.", at: day(3) } } }));

    const all = handleAutonomyLedger({}, deps);
    expect(autonomyLedgerRpc.output.parse(all)).toEqual(all);
    expect(all.cells.map((cell) => [cell.workspaceId, cell.predictor, cell.count, cell.agreed])).toEqual([
      [DECISION_WS, "recommended", 1, 1],
      [DECISION_WS, "orchestrator", 1, 0],
      [OTHER_WS, "recommended", 1, 0],
    ]);
    const text = JSON.stringify(all);
    for (const leak of ["Unsettled: not for the owner yet.", CHALLENGER_REASON, OPTIONS[0]!.label, "optionKey", "prediction"]) expect(text).not.toContain(leak);

    expect(handleAutonomyLedger({ workspaceId: OTHER_WS }, deps).cells.map((cell) => cell.workspaceId)).toEqual([OTHER_WS]);
    expect(handleAutonomyLedger({ workspaceId: "wks_none" }, deps)).toEqual({ cells: [], delegated: [] });
  });

  it("reads as none without a usable data folder, and registers one handler", () => {
    expect(handleAutonomyLedger({}, { ...deps, env: { PASEO_BM_HOME: "relative/path" } })).toEqual({ cells: [], delegated: [] });
    expect(handleAutonomyLedger({}, deps)).toEqual({ cells: [], delegated: [] });

    const handle = vi.fn();
    registerAutonomyLedgerRpcs({ handle } as unknown as Parameters<typeof registerAutonomyLedgerRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["autonomy.ledger"]);
  });

  it("answers a decisions folder it cannot read E_DATA_HOME_UNAVAILABLE, never a write code (code review 2026-09-30 §3.2)", () => {
    mkdirSync(join(root, "elsewhere"));
    mkdirSync(home);
    symlinkSync(join(root, "elsewhere"), join(home, DECISIONS_DIR_NAME));
    expect(() => handleAutonomyLedger({}, deps)).toThrow(/^E_DATA_HOME_UNAVAILABLE: cannot read the decisions: refusing to use a symlinked path/);
    expect(() => handleAutonomyLedger({ workspaceId: OTHER_WS }, deps)).toThrow(/^E_DATA_HOME_UNAVAILABLE: /);
  });
});

describe("bm_decisions never hands out a prediction", () => {
  it("an open decision's summary carries neither the challenger's prediction nor its reason", () => {
    const open = asked({ prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "c", reason: CHALLENGER_REASON, at: day(0) } } });
    for (const grant of [true, false]) {
      const summary = decisionSummaryOf(open, {}, { grant });
      expect(summary).not.toHaveProperty("prediction");
      expect(JSON.stringify(summary)).not.toContain(CHALLENGER_REASON);
    }
  });
});
