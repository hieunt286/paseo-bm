/**
 * The one registry of question subjects that code owns, and whether a
 * precedent may stand for a subject (delivery line design §7.4; ADR-035
 * decision 6; REQ-213 c).
 *
 * `CODE_SUBJECTS` names the subjects paseo-bm asks itself (`plugin`) or that
 * no longer open (`retired`); no precedent answers either. `precedentEligibility`
 * also covers what is ineligible by flag: an `ownerOnly` fact, a decision
 * carrying a prepared change of the owner's settings, and the decision kinds
 * no precedent answers (an override, a held permission request).
 *
 * Every path that saves or applies a precedent asks this one function and
 * refuses with the `why` it gives, so a precedent is never saved on a subject
 * code never answers by precedent:
 * - `whyNotPrecedent` (`shared/precedents.ts`): the card's Save as precedent
 *   and `precedents.save` with a decision;
 * - `checkPrecedentSaveInput`: Settings, and the prepared `precedent.save`
 *   (`shared/prepared-changes.ts`);
 * - `precedentResolutionOf` and `server/precedent-resolve.ts`: applying;
 * - `bm_ask_owner` (`server/orchestrator-decide-tools.ts`), which refuses a
 *   `CODE_SUBJECTS` subject (`codeSubjectAskRefusal`).
 * A stored precedent on an ineligible subject stays; `precedents.list` marks
 * it `inert` with the same `why`.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { carriesPreparedChange, decisionKindOf, type Decision } from "./decisions";

/** The subject of the one owner decision a request gets past its review cap (delivery line design §5.4). */
export const REVIEW_CAP_SUBJECT = "review-cap";
/** The subject of the owner's one integration card per mission and repo (delivery line design §4.3). */
export const INTEGRATION_SUBJECT = "integration";

/**
 * The subjects code owns. `askedBy: "plugin"`: paseo-bm opens the question
 * itself; `"retired"`: a legacy subject that may still be stored but no
 * longer opens. `precedent: false`: no precedent answers it.
 */
export const CODE_SUBJECTS = {
  "review-cap": { precedent: false, askedBy: "plugin" },
  "review-budget": { precedent: false, askedBy: "retired" },
  integration: { precedent: false, askedBy: "plugin", when: "once per mission and repository" },
} as const;

export type CodeSubject = keyof typeof CODE_SUBJECTS;

export type PrecedentEligibility = { eligible: true } | { eligible: false; why: string };

/** True for a subject in `CODE_SUBJECTS`. */
export function isCodeSubject(subject: string | null | undefined): subject is CodeSubject {
  return typeof subject === "string" && Object.prototype.hasOwnProperty.call(CODE_SUBJECTS, subject);
}

/** Why no precedent stands for a code subject, the same sentence wherever it is refused. */
function codeSubjectWhy(subject: CodeSubject): string {
  const entry: { askedBy: string; when?: string } = CODE_SUBJECTS[subject];
  return entry.askedBy === "plugin"
    ? `"${subject}" is a question paseo-bm asks you itself, ${entry.when ?? "each time"}; no precedent answers it`
    : `"${subject}" is a retired question; no precedent answers it`;
}

const ineligible = (why: string): PrecedentEligibility => ({ eligible: false, why });

/**
 * Whether a precedent may stand for `subject`, and — with `decision` — answer
 * or be saved from that decision. The subject is judged first, so a code
 * subject gives the same `why` with or without a decision. Pure.
 */
export function precedentEligibility(
  subject: string | null,
  decision?: Pick<Decision, "id" | "ownerOnly" | "options">,
): PrecedentEligibility {
  if (subject === null) {
    return ineligible(decision === undefined ? "a precedent needs a subject, so a later question can match it" : `decision ${decision.id} has no subject, so no later question could match it`);
  }
  if (isCodeSubject(subject)) return ineligible(codeSubjectWhy(subject));
  if (decision === undefined) return { eligible: true };
  const kind = decisionKindOf(decision.id);
  // Autonomy design §B.7: an override corrects what a precedent or the policy answered; none answers it.
  if (kind === "override") return ineligible(`decision ${decision.id} corrects an answer given for you; no precedent answers a correction`);
  // Autonomy design §D.2: a held request is allowed by the owner only, one at a time.
  if (kind === "held") return ineligible(`decision ${decision.id} is a permission request the action boundary held; only you allow each one`);
  // Autonomy design §G.4: a change of your settings, not an answer to stand for a subject.
  if (carriesPreparedChange(decision)) return ineligible(`decision ${decision.id} is about your settings; it is not an answer that stands for later questions`);
  // Missions design §5: a fact only the owner knows is asked of them each time.
  if (decision.ownerOnly === true) return ineligible(`decision ${decision.id} asks a fact only you know; only you answer it, each time`);
  return { eligible: true };
}

/** The `why` of an ineligible subject or decision; null when a precedent may stand for it. */
export function whyIneligible(subject: string | null, decision?: Pick<Decision, "id" | "ownerOnly" | "options">): string | null {
  const eligibility = precedentEligibility(subject, decision);
  return eligibility.eligible ? null : eligibility.why;
}

/**
 * Why `bm_ask_owner` refuses a subject (delivery line design §7.4): a
 * `CODE_SUBJECTS` subject is paseo-bm's own, or retired. Null for any other.
 */
export function codeSubjectAskRefusal(subject: string | null): string | null {
  if (!isCodeSubject(subject)) return null;
  return CODE_SUBJECTS[subject].askedBy === "plugin"
    ? `subject "${subject}" is a question paseo-bm itself asks the owner; nothing was stored`
    : `subject "${subject}" is retired; name what you ask with another subject; nothing was stored`;
}
