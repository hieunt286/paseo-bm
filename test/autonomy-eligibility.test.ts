import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_UNMET,
  ELIGIBLE_MIN_AGREEMENT,
  ELIGIBLE_MIN_DECISIONS,
  ELIGIBLE_MIN_SPAN_DAYS,
  EMPTY_AUTONOMY_POLICY,
  autonomyPolicyOf,
  autonomyPolicySchema,
  demotedAtOf,
  eligibility,
  eligibilitySpanMs,
  modeOf,
  policyOfProject,
  withCell,
  withDemotion,
  withProjectReset,
} from "../plugin/shared/autonomy";
import { agreementLedger, type AgreementCell } from "../plugin/shared/autonomy-ledger";
import { DECISION_CLASSES, HARD_OWNER_CLASSES, type Decision, type DecisionClass } from "../plugin/shared/decisions";
import { DECISION_REQUEST, DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * Promotion eligibility (autonomy design §B.4, §B.9; PRD REQ-123 a, Q-105):
 * the pure `eligibility` of one agreement cell at each threshold's boundary,
 * the order of its reasons, and the demotion window — after a demotion only
 * the owner's answers given since count (`agreementLedger`'s `demotions`,
 * kept in the policy by `withDemotion`).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = new Date(T0 + 30 * DAY);

/** A cell that just earns Delegate?: 18 of 20 (90 %), exactly 14 days, no reversal. */
function cell(overrides: Partial<AgreementCell> = {}): AgreementCell {
  return {
    workspaceId: DECISION_WS,
    class: "scope",
    predictor: "recommended",
    count: 20,
    agreed: 18,
    unread: 0,
    firstAt: iso(T0),
    lastAt: iso(T0 + 14 * DAY),
    reversals: 0,
    reversalsByKind: { "re-asked": 0, overridden: 0, reopened: 0 },
    ...overrides,
  };
}

const unmetOf = (value: AgreementCell, now = NOW) => {
  const result = eligibility(value, now);
  return result.eligible ? null : result.unmet;
};

describe("eligibility (§B.4): each threshold at its boundary", () => {
  it("names the thresholds as constants: 90 %, 20 decisions, 14 days", () => {
    expect([ELIGIBLE_MIN_AGREEMENT, ELIGIBLE_MIN_DECISIONS, ELIGIBLE_MIN_SPAN_DAYS]).toEqual([0.9, 20, 14]);
    expect(ELIGIBILITY_UNMET).toEqual(["owner-only", "agreement", "count", "span", "reversal"]);
    expect(eligibility(cell(), NOW)).toEqual({ eligible: true });
  });

  it("agreement: 90 % is enough, 89.9 % is not", () => {
    expect(unmetOf(cell({ count: 1000, agreed: 900 }))).toBeNull();
    expect(unmetOf(cell({ count: 1000, agreed: 899 }))).toBe("agreement");
    expect(unmetOf(cell({ count: 20, agreed: 18 }))).toBeNull();
    expect(unmetOf(cell({ count: 20, agreed: 17 }))).toBe("agreement");
    expect(unmetOf(cell({ count: 30, agreed: 27 }))).toBeNull();
  });

  it("count: 20 decisions are enough, 19 are not, even all agreed", () => {
    expect(unmetOf(cell({ count: 20, agreed: 20 }))).toBeNull();
    expect(unmetOf(cell({ count: 19, agreed: 19 }))).toBe("count");
  });

  it("span: 14 days are enough, 13 days 23 hours are not; a last answer after now does not lengthen it", () => {
    expect(unmetOf(cell({ lastAt: iso(T0 + 14 * DAY) }))).toBeNull();
    expect(unmetOf(cell({ lastAt: iso(T0 + 14 * DAY - HOUR) }))).toBe("span");
    expect(eligibilitySpanMs(cell({ lastAt: iso(T0 + 14 * DAY - HOUR) }), NOW)).toBe(14 * DAY - HOUR);
    // A clock that ran ahead: the last answer is read no later than now.
    expect(unmetOf(cell({ lastAt: iso(T0 + 20 * DAY) }), new Date(T0 + 14 * DAY - HOUR))).toBe("span");
    expect(unmetOf(cell({ lastAt: iso(T0 + 20 * DAY) }), new Date(T0 + 14 * DAY))).toBeNull();
    // Times that do not read are no span.
    expect(unmetOf(cell({ firstAt: "yesterday" }))).toBe("span");
    expect(eligibilitySpanMs(cell({ firstAt: null, lastAt: null }), NOW)).toBe(0);
  });

  it("reversal: none is required; one is enough to refuse", () => {
    expect(unmetOf(cell({ reversals: 0 }))).toBeNull();
    expect(unmetOf(cell({ reversals: 1, reversalsByKind: { "re-asked": 1, overridden: 0, reopened: 0 } }))).toBe("reversal");
  });

  it("a release, data, security or cost cell is never eligible, whatever its figures", () => {
    for (const decisionClass of HARD_OWNER_CLASSES) {
      expect(unmetOf(cell({ class: decisionClass, count: 100, agreed: 100, lastAt: iso(T0 + 29 * DAY) }))).toBe("owner-only");
    }
    const delegable = DECISION_CLASSES.filter((decisionClass) => !HARD_OWNER_CLASSES.includes(decisionClass));
    for (const decisionClass of delegable) expect(unmetOf(cell({ class: decisionClass }))).toBeNull();
  });

  it("gives the first unmet reason, in order: agreement, count, span, reversal", () => {
    const reversed = { reversals: 1, reversalsByKind: { "re-asked": 0, overridden: 1, reopened: 0 } };
    expect(unmetOf(cell({ count: 5, agreed: 3, lastAt: iso(T0), ...reversed }))).toBe("agreement");
    expect(unmetOf(cell({ count: 0, agreed: 0, firstAt: null, lastAt: null }))).toBe("agreement");
    expect(unmetOf(cell({ count: 5, agreed: 5, lastAt: iso(T0), ...reversed }))).toBe("count");
    expect(unmetOf(cell({ lastAt: iso(T0), ...reversed }))).toBe("span");
    expect(unmetOf(cell(reversed))).toBe("reversal");
  });
});

describe("the demotion window (§B.4, §B.9): after a demotion, only answers given since count", () => {
  const OPTIONS = [
    { key: "a", label: "Yes", recommended: true, effects: [] },
    { key: "b", label: "No", recommended: false, effects: [] },
  ];

  /** The owner's answer to question `n` at `at`: agreeing with the recommended option unless `optionKey` says otherwise. */
  function ownerAnswer(n: number, at: number, optionKey = "a", decisionClass: DecisionClass = "scope"): Decision {
    return makeDecision({
      id: `q:${DECISION_REQUEST}:Q${n}`,
      class: decisionClass,
      options: OPTIONS,
      subject: null,
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
      status: "answered",
      settledAt: iso(at),
      answer: { by: "owner", via: "inbox", optionKey, words: null, at: iso(at) },
    });
  }

  /** 20 agreeing answers, one a day from T0. */
  const earned = Array.from({ length: 20 }, (_, index) => ownerAnswer(index + 1, T0 + index * DAY));
  const scopeCell = (decisions: readonly Decision[], demotions?: Record<string, Partial<Record<DecisionClass, string>>>) =>
    agreementLedger(decisions, demotions === undefined ? {} : { demotions }).cells.find((entry) => entry.class === "scope" && entry.predictor === "recommended");

  it("counts every answer without a demotion, and none given before one", () => {
    const whole = scopeCell(earned)!;
    expect(whole).toMatchObject({ count: 20, agreed: 20 });
    expect(eligibility(whole, NOW)).toEqual({ eligible: true });

    const demotedAt = iso(T0 + 20 * DAY);
    expect(scopeCell(earned, { [DECISION_WS]: { scope: demotedAt } })).toBeUndefined();
    // Two answers since the demotion: those two only.
    const since = [...earned, ownerAnswer(21, T0 + 21 * DAY), ownerAnswer(22, T0 + 22 * DAY, "b")];
    const counted = scopeCell(since, { [DECISION_WS]: { scope: demotedAt } })!;
    expect(counted).toMatchObject({ count: 2, agreed: 1, firstAt: iso(T0 + 21 * DAY), lastAt: iso(T0 + 22 * DAY) });
    expect(eligibility(counted, NOW)).toEqual({ eligible: false, unmet: "agreement" });
    // An answer at the demotion's own time counts; one a millisecond before does not.
    expect(scopeCell([ownerAnswer(30, Date.parse(demotedAt))], { [DECISION_WS]: { scope: demotedAt } })?.count).toBe(1);
    expect(scopeCell([ownerAnswer(30, Date.parse(demotedAt) - 1)], { [DECISION_WS]: { scope: demotedAt } })).toBeUndefined();
  });

  it("narrows only the demoted class of the demoted project, and never the delegated figures", () => {
    const other = Array.from({ length: 3 }, (_, index) => ownerAnswer(40 + index, T0 + index * DAY, "a", "preference"));
    const byPolicy = makeDecision({
      id: `q:${DECISION_REQUEST}:Q50`,
      class: "scope",
      options: OPTIONS,
      status: "answered",
      settledAt: iso(T0),
      answer: { by: "policy", via: "inbox", optionKey: "a", words: null, at: iso(T0), class: "scope", predictor: "recommended" },
    });
    const ledger = agreementLedger([...earned, ...other, byPolicy], { demotions: { [DECISION_WS]: { scope: iso(T0 + 30 * DAY) }, wks_other: { preference: iso(T0 + 30 * DAY) } } });
    expect(ledger.cells.map((entry) => [entry.class, entry.count])).toEqual([["preference", 3]]);
    expect(ledger.delegated.map((entry) => [entry.class, entry.count])).toEqual([["scope", 1]]);
  });

  it("the policy keeps each class's last demotion: a demotion sets shadow and the time, a set or a reset keeps the time", () => {
    const delegated = withCell(EMPTY_AUTONOMY_POLICY, DECISION_WS, "scope", { mode: "delegate", predictor: "recommended", at: iso(T0) });
    const demoted = withDemotion(delegated, DECISION_WS, "scope", iso(T0 + DAY));
    expect(demoted.projects[DECISION_WS]?.scope).toEqual({ mode: "shadow", at: iso(T0 + DAY) });
    expect(demotedAtOf(demoted, DECISION_WS, "scope")).toBe(iso(T0 + DAY));
    expect(demotedAtOf(demoted, DECISION_WS, "preference")).toBeNull();
    expect(demotedAtOf(demoted, "wks_other", "scope")).toBeNull();
    // A later demotion replaces the time; the owner's change of the cell and a reset keep it.
    const again = withDemotion(withCell(demoted, DECISION_WS, "scope", { mode: "delegate", predictor: "orchestrator", at: iso(T0 + 2 * DAY) }), DECISION_WS, "scope", iso(T0 + 3 * DAY));
    expect(demotedAtOf(again, DECISION_WS, "scope")).toBe(iso(T0 + 3 * DAY));
    expect(demotedAtOf(withCell(again, DECISION_WS, "scope", { mode: "owner", at: iso(T0 + 4 * DAY) }), DECISION_WS, "scope")).toBe(iso(T0 + 3 * DAY));
    const reset = withProjectReset(again, DECISION_WS);
    expect(modeOf(reset, DECISION_WS, "scope")).toBe("owner");
    expect(demotedAtOf(reset, DECISION_WS, "scope")).toBe(iso(T0 + 3 * DAY));
    // The RPC shape takes it, and one project's view carries its own only.
    expect(autonomyPolicySchema.parse(again)).toEqual(again);
    expect(policyOfProject(again, DECISION_WS).demotions).toEqual({ [DECISION_WS]: { scope: iso(T0 + 3 * DAY) } });
    expect(policyOfProject(again, "wks_other")).not.toHaveProperty("demotions");
  });

  it("reads each demotion of a file on its own: a hard-owner class, a time that does not read, a bad project are skipped", () => {
    // Parsed from text, as the store reads it, so `__proto__` is an own key.
    const body: unknown = JSON.parse(
      JSON.stringify({
        version: 1,
        projects: {},
        challenger: {},
        demotions: { [DECISION_WS]: { scope: iso(T0), release: iso(T0), preference: "soon", style: iso(T0) }, wks_empty: { scope: 7 } },
      }).replace('"wks_empty"', `"__proto__":{"scope":"${iso(T0)}"},"wks_empty"`),
    );
    const policy = autonomyPolicyOf(body);
    expect(policy.demotions).toEqual({ [DECISION_WS]: { scope: iso(T0) } });
    // A file with no demotion reads without the key, as before.
    expect(autonomyPolicyOf({ version: 1, projects: {}, challenger: {} })).toEqual(EMPTY_AUTONOMY_POLICY);
  });
});
