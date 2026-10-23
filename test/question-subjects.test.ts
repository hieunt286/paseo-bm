import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRECEDENT_UI_IDLE, precedentOfferView, precedentSuggestionView } from "../plugin/client/chat-card-precedent";
import { DECISION_UI_IDLE } from "../plugin/client/chat-card-decision";
import { handlePrecedentsList, handlePrecedentsSave, type AutonomyRpcDeps } from "../plugin/server/autonomy-rpc";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { resolveByPrecedent } from "../plugin/server/precedent-resolve";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { DashboardError, precedentsListRpc } from "../plugin/shared/contracts";
import { LEGACY_REVIEW_BUDGET_SUBJECT, answerDecision, type Decision, type DecisionOption } from "../plugin/shared/decisions";
import { checkPrecedentSaveInput, listedPrecedentOf, precedentResolutionOf, whyNotPrecedent, type Precedent } from "../plugin/shared/precedents";
import { preparedChangeCheckOf } from "../plugin/shared/prepared-changes";
import { CODE_SUBJECTS, INTEGRATION_SUBJECT, REVIEW_CAP_SUBJECT, codeSubjectAskRefusal, isCodeSubject, precedentEligibility, whyIneligible } from "../plugin/shared/question-subjects";
import { DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * One registry of precedent-eligible subjects (delivery line design §7.4;
 * ADR-035 decision 6; REQ-213 c): the card, the save RPC, Settings, the
 * prepared `precedent.save`, the resolver and `precedents.list` agree for an
 * eligible and for each code subject, with the same why. A temporary data
 * folder only; never the real HOME.
 */

const NOW = new Date("2026-10-20T10:00:00.000Z");
const ELIGIBLE = "test-db";
const CODE = [REVIEW_CAP_SUBJECT, LEGACY_REVIEW_BUDGET_SUBJECT] as const;

const OPTIONS: DecisionOption[] = [
  { key: "a", label: "Yes", recommended: true, effects: ["none"] },
  { key: "b", label: "No", recommended: false, effects: ["none"] },
];

let root: string;
let home: string;
let deps: AutonomyRpcDeps;
let ids: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-question-subjects-"));
  home = join(root, "data");
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: () => undefined };
  ids = 0;
  clearDecisionStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const question = (subject: string, overrides: Partial<Decision> = {}): Decision =>
  makeDecision({ subject, class: "scope", question: "Carry on?", options: OPTIONS, ...overrides });

function answered(decision: Decision): Decision {
  const result = answerDecision(decision, { via: "inbox", optionKey: "a", at: NOW.toISOString() });
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

/** A precedent stored as an older build might have stored it: the store writes what it is given. */
function stored(subject: string): Precedent {
  return createPrecedentStore(home, { newId: () => `id-${++ids}` }).save(
    { scope: DECISION_WS, subject, text: "Yes", sourceDecisionId: null, expiresInDays: 30 },
    new Date(NOW.getTime() - 60_000),
  ).precedent;
}

function refusalOf(run: () => unknown): { code: string; message: string } | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof DashboardError)) throw error;
    return { code: error.code, message: error.message };
  }
}

describe("the registry", () => {
  it("names review-cap and integration (asked by paseo-bm) and the retired review-budget, none answered by a precedent", () => {
    expect(CODE_SUBJECTS).toEqual({
      "review-cap": { precedent: false, askedBy: "plugin" },
      "review-budget": { precedent: false, askedBy: "retired" },
      integration: { precedent: false, askedBy: "plugin", when: "once per mission and repository" },
    });
    // Delivery line design §4.3: the owner's integration card is never a precedent's.
    expect(isCodeSubject(INTEGRATION_SUBJECT)).toBe(true);
    expect(whyIneligible(INTEGRATION_SUBJECT)).toBe('"integration" is a question paseo-bm asks you itself, once per mission and repository; no precedent answers it');
    expect(codeSubjectAskRefusal(INTEGRATION_SUBJECT)).toBe('subject "integration" is a question paseo-bm itself asks the owner; nothing was stored');
    expect(isCodeSubject(REVIEW_CAP_SUBJECT)).toBe(true);
    expect(isCodeSubject(LEGACY_REVIEW_BUDGET_SUBJECT)).toBe(true);
    expect(isCodeSubject(ELIGIBLE)).toBe(false);
    expect(isCodeSubject("constructor")).toBe(false);
    expect(isCodeSubject(null)).toBe(false);
    expect(whyIneligible(REVIEW_CAP_SUBJECT)).toBe('"review-cap" is a question paseo-bm asks you itself, each time; no precedent answers it');
    expect(whyIneligible(LEGACY_REVIEW_BUDGET_SUBJECT)).toBe('"review-budget" is a retired question; no precedent answers it');
  });

  it("is eligible for an ordinary subject, and ineligible by flag: no subject, override, held, prepared change, ownerOnly", () => {
    expect(precedentEligibility(ELIGIBLE)).toEqual({ eligible: true });
    expect(precedentEligibility(ELIGIBLE, question(ELIGIBLE))).toEqual({ eligible: true });
    expect(precedentEligibility(null)).toMatchObject({ eligible: false });
    expect(whyIneligible(null, question(ELIGIBLE))).toMatch(/has no subject/);
    expect(whyIneligible(ELIGIBLE, question(ELIGIBLE, { id: "r:override-1" }))).toMatch(/corrects an answer given for you/);
    expect(whyIneligible(ELIGIBLE, question(ELIGIBLE, { id: "h:req-20260929T073348Z:1" }))).toMatch(/permission request the action boundary held/);
    expect(whyIneligible(ELIGIBLE, question(ELIGIBLE, { ownerOnly: true }))).toMatch(/a fact only you know/);
    const prepared = question(ELIGIBLE, {
      options: [{ key: "a", label: "Save it", recommended: true, effects: ["none"], action: { kind: "precedent.save", scope: "all", subject: "date-format", text: "ISO" } }],
    });
    expect(whyIneligible(ELIGIBLE, prepared)).toMatch(/is about your settings/);
    // The subject is judged first: a code subject gives one why with or without the decision's flags.
    expect(whyIneligible(REVIEW_CAP_SUBJECT, question(REVIEW_CAP_SUBJECT, { ownerOnly: true }))).toBe(whyIneligible(REVIEW_CAP_SUBJECT));
  });

  it("gives bm_ask_owner a refusal for a code subject only", () => {
    expect(codeSubjectAskRefusal(REVIEW_CAP_SUBJECT)).toBe('subject "review-cap" is a question paseo-bm itself asks the owner; nothing was stored');
    expect(codeSubjectAskRefusal(LEGACY_REVIEW_BUDGET_SUBJECT)).toBe('subject "review-budget" is retired; name what you ask with another subject; nothing was stored');
    expect(codeSubjectAskRefusal(ELIGIBLE)).toBeNull();
    expect(codeSubjectAskRefusal(null)).toBeNull();
  });
});

describe("every save and apply path agrees (delivery line design §7.4)", () => {
  const facts = () => ({ workspaceId: DECISION_WS, policy: { projects: {}, challenger: {} }, settings: DEFAULT_COORDINATION_SETTINGS, precedents: [] });

  it("an eligible subject: offered on the card, saved by the RPC, Settings and a prepared change, and applied", () => {
    const decision = answered(question(ELIGIBLE));
    expect(whyNotPrecedent(decision)).toBeNull();
    expect(precedentOfferView(decision, PRECEDENT_UI_IDLE)?.offer).not.toBeNull();
    expect(checkPrecedentSaveInput({ scope: "all", subject: ELIGIBLE, text: "Yes" })).toHaveProperty("input");
    expect(preparedChangeCheckOf({ kind: "precedent.save", scope: "all", subject: ELIGIBLE, text: "Yes" }, facts())).toEqual({ ok: true });

    createDecisionStore(home).open(question(ELIGIBLE, { id: "q:req-20260929T073348Z:Q9" }));
    createDecisionStore(home).transition("q:req-20260929T073348Z:Q9", () => ({ ok: true, decision: { ...decision, id: "q:req-20260929T073348Z:Q9" } }), DECISION_WS);
    expect(handlePrecedentsSave({ decisionId: "q:req-20260929T073348Z:Q9", scope: DECISION_WS }, deps).precedent.subject).toBe(ELIGIBLE);
    expect(handlePrecedentsSave({ scope: "all", subject: ELIGIBLE, text: "Yes" }, deps).precedent.subject).toBe(ELIGIBLE);

    const opened = createDecisionStore(home).open(question(ELIGIBLE)).decision;
    expect(resolveByPrecedent(opened, { home, now: NOW })).toMatchObject({ resolved: true, decision: { status: "answered", answer: { by: "precedent", optionKey: "a" } } });
    const listed = handlePrecedentsList({}, deps).precedents;
    expect(listed.length).toBeGreaterThan(0);
    for (const precedent of listed) expect(precedent).not.toHaveProperty("inert");
  });

  for (const subject of CODE) {
    it(`"${subject}": refused everywhere with the same why, never applied, and listed inert`, () => {
      const why = whyIneligible(subject)!;
      const refusal = `${why}; nothing was saved`;

      // The card and its RPC.
      const decision = answered(question(subject));
      expect(whyNotPrecedent(decision)).toBe(why);
      expect(precedentOfferView(decision, PRECEDENT_UI_IDLE)).toBeNull();
      createDecisionStore(home).open(question(subject));
      createDecisionStore(home).transition(decision.id, () => ({ ok: true, decision }), DECISION_WS);
      expect(refusalOf(() => handlePrecedentsSave({ decisionId: decision.id, scope: DECISION_WS }, deps))).toEqual({ code: "E_PRECEDENT_INVALID", message: `E_PRECEDENT_INVALID: ${refusal}` });

      // Settings.
      expect(checkPrecedentSaveInput({ scope: "all", subject, text: "Yes" })).toEqual({ refusal: { code: "E_PRECEDENT_INVALID", detail: refusal } });
      expect(refusalOf(() => handlePrecedentsSave({ scope: "all", subject, text: "Yes" }, deps))).toEqual({ code: "E_PRECEDENT_INVALID", message: `E_PRECEDENT_INVALID: ${refusal}` });

      // The prepared change, when asked and when applied.
      expect(preparedChangeCheckOf({ kind: "precedent.save", scope: "all", subject, text: "Yes" }, facts())).toEqual({ refusal });
      expect(createPrecedentStore(home).read()).toEqual([]);

      // A precedent stored before this build stays, answers nothing, suggests nothing, and is listed inert.
      const old = stored(subject);
      const opened = question(subject, { id: "q:req-20260929T073348Z:Q2" });
      expect(precedentResolutionOf(opened, [old], NOW)).toBeNull();
      const stillOpen = createDecisionStore(home).open(opened).decision;
      expect(resolveByPrecedent(stillOpen, { home, now: NOW })).toMatchObject({ resolved: false, precedent: null, decision: { status: "open" } });
      expect(precedentSuggestionView(stillOpen, [old], DECISION_UI_IDLE, NOW)).toBeNull();
      const listed = precedentsListRpc.output.parse(handlePrecedentsList({ workspaceId: DECISION_WS }, deps));
      expect(listed.precedents).toEqual([{ ...old, inert: why }]);
      expect(listedPrecedentOf(old)).toEqual({ ...old, inert: why });
      expect(createPrecedentStore(home).read()).toEqual([old]);
    });
  }
});
