/**
 * The authority resolver (mission runtime design §4.1, ADR-033 decision 3,
 * REQ-204): one pure function names who decides a decision — the mission's
 * Main, the Orchestrator or the owner. It is the only place these rules live;
 * `bm_answer_worker`, `bm_decide`, the mission state and the owner's views
 * ask it.
 *
 * Rules, the first that holds:
 * 1. `ownerOnly`; `o:`, `r:`, `h:`; an `m:` decision; an option carrying a
 *    prepared change → the owner.
 * 2. `f:` whose class the project delegates → the Orchestrator, unless
 *    `unverifiedFinishRefusalOf` refuses every acting option → the owner.
 * 3. `q:` of a request of a mission, its class delegated by the repo cell →
 *    the Main; delegated by the mission cell only → the Main when one option
 *    settles it with no effect, else the owner, the Main recommending
 *    (`mission-effects`).
 * 4. `q:` of a request of a mission whose repo cell is `shadow` → the owner,
 *    the Main recommending (`recommend: true`).
 * 5. Anything else → the owner.
 *
 * A decider other than the owner is named only if one option it may choose
 * settles the question without leaving a held effect for the owner (delivery
 * line design §7.1): the Main's answer covers no effect (`grantCoverOf`
 * counts the owner's answers only), the repo cell's policy does.
 *
 * The review-budget rules are retired (delivery line design §5.6): past its
 * review cap a request gets one `review-cap` decision, `ownerOnly` (rule 1).
 *
 * The owner may answer any open decision at any time (§4.2); a decider other
 * than the owner never hides the owner's card.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { missionAnswerCellOf, unverifiedFinishRefusalOf, type AutonomyMode, type MissionClass } from "./autonomy";
import { carriesPreparedChange, decisionClassOf, decisionKindOf, type Decision, type DecisionClass, type DecisionOption } from "./decisions";

/** `code` is no rule's any more (delivery line design §5.6); kept so stored mission states still parse. */
export const DECIDERS = ["code", "main", "orchestrator", "owner"] as const;
export type Decider = (typeof DECIDERS)[number];

/** What the resolver reads besides the decision. Every function is pure for the call. */
export interface AuthorityFacts {
  /** The repo cell of a class in a workspace (`modeOf` over the owner's policy). */
  modeOf(workspaceId: string, decisionClass: DecisionClass): AutonomyMode;
  /** The mission of a request, or null. */
  missionOf(requestId: string | null): string | null;
  /** Whether a mission's level delegates a cell. */
  missionDelegates(missionId: string, cell: MissionClass): boolean;
  /** Whether a request stands finished-unverified (autonomy design §C.6); absent reads as not. */
  finishedUnverified?(requestId: string | null): boolean;
}

export type AuthorityRule = "owner-only" | "owner-kind" | "prepared-change" | "orchestrator-incident" | "delegated-main" | "mission-effects" | "shadow-main" | "owner";

export interface DeciderOf {
  decider: Decider;
  rule: AuthorityRule;
  /** Rules 3 (`mission-effects`) and 4: the Main recommends, the owner decides. */
  recommend: boolean;
  /** Why, in one line, for the owner's views and refusals. */
  why: string;
  /** Rule 3 by the mission cell only: the Main may choose only an option that settles without effect (§7.1). */
  withoutEffects?: true;
}

/** The decision fields the resolver reads. */
export type AuthorityDecision = Pick<Decision, "id" | "workspaceId" | "requestId" | "options" | "class" | "subject" | "ownerOnly">;

/** True for an `m:` mission decision id (kept here so `shared/` needs no server module). */
export function isMissionDecisionIdShape(id: string): boolean {
  return /^m:mis-[0-9a-f]{10}:[1-9]\d{0,5}$/.test(id);
}

const owner = (rule: AuthorityRule, why: string): DeciderOf => ({ decider: "owner", rule, recommend: false, why });

/**
 * Whether choosing `option` leaves no effect to hold (delivery line design
 * §7.1): it declares none, and a command it carries approves none. Pure.
 */
export function settlesWithoutEffect(option: Pick<DecisionOption, "effects" | "action">): boolean {
  return heldEffectsOf(option).length === 0;
}

/** The effects choosing `option` leaves to hold: those it declares and those a command it carries approves, `none` left out. Pure. */
export function heldEffectsOf(option: Pick<DecisionOption, "effects" | "action">): string[] {
  const approved = option.action?.kind === "command" ? option.action.effects : [];
  return [...new Set([...option.effects, ...approved])].filter((effect) => effect !== "none");
}

/** True when the decision has an acting option and the unverified-finish rule refuses every one (§7.1, case 2). */
function everyActingOptionRefused(decision: AuthorityDecision, facts: AuthorityFacts): boolean {
  if (facts.finishedUnverified?.(decision.requestId) !== true) return false;
  const acting = decision.options.filter((option) => option.action !== undefined || !option.effects.every((effect) => effect === "none"));
  return acting.length > 0 && acting.every((option) => unverifiedFinishRefusalOf(decision, option.key, true) !== null);
}

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
    if (repoMode !== "delegate") return owner("owner", `${decisionClass} is not delegated in this project`);
    // Delivery line design §7.1, case 2: no option the Orchestrator may choose would act.
    if (everyActingOptionRefused(decision, facts)) return owner("owner", "its request finished unverified: every acting option is the owner's");
    return { decider: "orchestrator", rule: "orchestrator-incident", recommend: false, why: `${decisionClass} is delegated: the Orchestrator decides the incident` };
  }
  // A Worker's question (q:).
  const missionId = facts.missionOf(decision.requestId);
  const cell = missionAnswerCellOf(decisionClass);
  const delegatedMain = { decider: "main", rule: "delegated-main", recommend: false, why: `${decisionClass} is delegated: the mission's Main decides` } as const;
  if (missionId !== null && repoMode === "delegate") return delegatedMain;
  if (missionId !== null && facts.missionDelegates(missionId, cell)) {
    // Delivery line design §7.1, case 1: the mission's delegation covers no effect, so the Main settles only an option with none.
    if (decision.options.some(settlesWithoutEffect)) return { ...delegatedMain, withoutEffects: true };
    return { decider: "owner", rule: "mission-effects", recommend: true, why: `every option of this ${decisionClass} question leaves an effect only the owner's answer covers: the Main recommends, the owner decides` };
  }
  if (missionId !== null && repoMode === "shadow") return { decider: "owner", rule: "shadow-main", recommend: true, why: `${decisionClass} is shadowed: the Main recommends, the owner decides` };
  return owner("owner", `${decisionClass} is not delegated`);
}
