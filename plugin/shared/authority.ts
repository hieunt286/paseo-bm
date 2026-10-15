/**
 * The authority resolver (mission runtime design §4.1, ADR-033 decision 3,
 * REQ-204): one pure function names who decides a decision — code, the
 * mission's Main, the Orchestrator or the owner. It is the only place these
 * rules live; the materialiser (code acts at open), `bm_answer_worker`,
 * `bm_decide`, the mission state and the owner's views ask it.
 *
 * Rules, the first that holds:
 * 1. `ownerOnly`; `o:`, `r:`, `h:`; an `m:` decision; an option carrying a
 *    prepared change → the owner.
 * 2. `f:` whose class the project delegates → the Orchestrator.
 * 3. `q:` with subject `review-budget`, `cost` delegated by the repo cell or
 *    the request's mission (`answer-effects`), and its recommended option's
 *    grant within the code cap → code.
 * 4. `q:` of a request of a mission, its class delegated by the repo cell or
 *    the mission cell, and — for a review grant — some option within the
 *    Main cap → the Main.
 * 5. `q:` of a request of a mission whose repo cell is `shadow` → the owner,
 *    the Main recommending (`recommend: true`).
 * 6. Anything else → the owner.
 *
 * The owner may answer any open decision at any time (§4.2); a decider other
 * than the owner never hides the owner's card.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { missionAnswerCellOf, type AutonomyMode, type MissionClass } from "./autonomy";
import { REVIEW_BUDGET_SUBJECT, carriesPreparedChange, decisionClassOf, decisionKindOf, type Decision, type DecisionClass, type ReviewGrant } from "./decisions";

export const DECIDERS = ["code", "main", "orchestrator", "owner"] as const;
export type Decider = (typeof DECIDERS)[number];

export { REVIEW_BUDGET_SUBJECT };

/** What is left of a request's review grants for code and for the Main (design §4.3). */
export interface ReviewCaps {
  /** Further review calls code may still grant on this request. */
  codeLeft: number;
  /** Further review calls the Main may still grant on this request. */
  mainLeft: number;
}

/** What the resolver reads besides the decision. Every function is pure for the call. */
export interface AuthorityFacts {
  /** The repo cell of a class in a workspace (`modeOf` over the owner's policy). */
  modeOf(workspaceId: string, decisionClass: DecisionClass): AutonomyMode;
  /** The mission of a request, or null. */
  missionOf(requestId: string | null): string | null;
  /** Whether a mission's level delegates a cell. */
  missionDelegates(missionId: string, cell: MissionClass): boolean;
  /** A request's review caps; null when unknown (then no review grant is within a cap). */
  reviewCaps(workspaceId: string, requestId: string | null): ReviewCaps | null;
}

export type AuthorityRule = "owner-only" | "owner-kind" | "prepared-change" | "orchestrator-incident" | "review-budget-code" | "delegated-main" | "shadow-main" | "owner";

export interface DeciderOf {
  decider: Decider;
  rule: AuthorityRule;
  /** Rule 5: the Main recommends, the owner decides. */
  recommend: boolean;
  /** Why, in one line, for the owner's views and refusals. */
  why: string;
}

/** The decision fields the resolver reads. */
export type AuthorityDecision = Pick<Decision, "id" | "workspaceId" | "requestId" | "options" | "class" | "subject" | "ownerOnly">;

/** True for an `m:` mission decision id (kept here so `shared/` needs no server module). */
export function isMissionDecisionIdShape(id: string): boolean {
  return /^m:mis-[0-9a-f]{10}:[1-9]\d{0,5}$/.test(id);
}

/** Whether `grant` fits within `left` further calls: `{ calls: n }` when n ≤ left, `{ untilClean }` when any is left (design §4.3). */
export function grantWithin(grant: ReviewGrant | undefined, left: number): boolean {
  if (grant === undefined) return true;
  return "calls" in grant ? grant.calls <= left : left > 0;
}

const owner = (rule: AuthorityRule, why: string): DeciderOf => ({ decider: "owner", rule, recommend: false, why });

/** Who decides `decision` (design §4.1). Pure. */
export function deciderOf(decision: AuthorityDecision, facts: AuthorityFacts): DeciderOf {
  if (decision.ownerOnly === true) return owner("owner-only", "a fact only the owner knows");
  if (isMissionDecisionIdShape(decision.id)) return owner("owner-kind", "a mission card or the Main's question: the owner's");
  const kind = decisionKindOf(decision.id);
  if (kind === "orchestrator" || kind === "override" || kind === "held" || kind === null) return owner("owner-kind", "the owner's by its kind");
  if (carriesPreparedChange(decision)) return owner("prepared-change", "an option changes settings or the mission: the owner's");
  const decisionClass = decisionClassOf(decision);
  const repoMode = facts.modeOf(decision.workspaceId, decisionClass);
  if (kind === "fallback") {
    return repoMode === "delegate"
      ? { decider: "orchestrator", rule: "orchestrator-incident", recommend: false, why: `${decisionClass} is delegated: the Orchestrator decides the incident` }
      : owner("owner", `${decisionClass} is not delegated in this project`);
  }
  // A Worker's question (q:).
  const missionId = facts.missionOf(decision.requestId);
  const cell = missionAnswerCellOf(decisionClass);
  const delegated = repoMode === "delegate" || (missionId !== null && facts.missionDelegates(missionId, cell));
  if (decision.subject === REVIEW_BUDGET_SUBJECT) {
    const caps = facts.reviewCaps(decision.workspaceId, decision.requestId);
    const costDelegated = facts.modeOf(decision.workspaceId, "cost") === "delegate" || (missionId !== null && facts.missionDelegates(missionId, "answer-effects"));
    const recommended = decision.options.find((option) => option.recommended);
    if (costDelegated && caps !== null && recommended !== undefined && grantWithin(recommended.grant, caps.codeLeft)) {
      return { decider: "code", rule: "review-budget-code", recommend: false, why: "a review budget within what the owner delegated: paseo-bm decides it" };
    }
    if (missionId !== null && costDelegated && caps !== null && decision.options.some((option) => option.grant === undefined || grantWithin(option.grant, caps.mainLeft))) {
      return { decider: "main", rule: "delegated-main", recommend: false, why: "a review budget within the Main's share of the delegation" };
    }
    return owner("owner", "a review budget beyond what the owner delegated");
  }
  if (missionId !== null && delegated) return { decider: "main", rule: "delegated-main", recommend: false, why: `${decisionClass} is delegated: the mission's Main decides` };
  if (missionId !== null && repoMode === "shadow") return { decider: "owner", rule: "shadow-main", recommend: true, why: `${decisionClass} is shadowed: the Main recommends, the owner decides` };
  return owner("owner", `${decisionClass} is not delegated`);
}
