import { describe, expect, it } from "vitest";
import {
  EMPTY_AUTONOMY_POLICY,
  autonomyPolicyOf,
  autonomyPolicySchema,
  demotedAtOf,
  modeOf,
  policyOfProject,
  withCell,
  withDemotion,
  withProjectReset,
} from "../plugin/shared/autonomy";
import { agreementLedger } from "../plugin/shared/autonomy-ledger";
import type { Decision, DecisionClass } from "../plugin/shared/decisions";
import { DECISION_REQUEST, DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * The demotion window (autonomy design §B.4, §B.9): after a demotion only the
 * owner's answers given since count in the agreement ledger
 * (`agreementLedger`'s `demotions`, kept in the policy by `withDemotion`).
 * The figures are information; no threshold gates a delegation (ADR-023).
 */

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

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
  const answers = Array.from({ length: 20 }, (_, index) => ownerAnswer(index + 1, T0 + index * DAY));
  const scopeCell = (decisions: readonly Decision[], demotions?: Record<string, Partial<Record<DecisionClass, string>>>) =>
    agreementLedger(decisions, demotions === undefined ? {} : { demotions }).cells.find((entry) => entry.class === "scope" && entry.predictor === "recommended");

  it("counts every answer without a demotion, and none given before one", () => {
    const whole = scopeCell(answers)!;
    expect(whole).toMatchObject({ count: 20, agreed: 20 });

    const demotedAt = iso(T0 + 20 * DAY);
    expect(scopeCell(answers, { [DECISION_WS]: { scope: demotedAt } })).toBeUndefined();
    // Two answers since the demotion: those two only.
    const since = [...answers, ownerAnswer(21, T0 + 21 * DAY), ownerAnswer(22, T0 + 22 * DAY, "b")];
    const counted = scopeCell(since, { [DECISION_WS]: { scope: demotedAt } })!;
    expect(counted).toMatchObject({ count: 2, agreed: 1, firstAt: iso(T0 + 21 * DAY), lastAt: iso(T0 + 22 * DAY) });
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
    const ledger = agreementLedger([...answers, ...other, byPolicy], { demotions: { [DECISION_WS]: { scope: iso(T0 + 30 * DAY) }, wks_other: { preference: iso(T0 + 30 * DAY) } } });
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
