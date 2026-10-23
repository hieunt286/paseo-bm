/**
 * M-39 and M-41 (missions PRD; delivery line design §13): what the owner's
 * cards were about, read from the stored decisions alone — the workspaces'
 * `decisions/` and the missions' `m:` decisions.
 *
 * - **A card** is a stored decision no agent answered: its `answer` is null
 *   (open, withdrawn, superseded, expired) or the owner's. An answer by the
 *   policy, a precedent, a Main or the Orchestrator never reached the owner.
 *   An override (`r:`) is the owner's own act, not a card. A card counts as
 *   A-4's decisions do: its request is in the window, else it was asked in it.
 * - **M-39** (delivery line design §5.4, §5.6): the cards about review per
 *   request — subject `review-cap` (the one question at the cap) or the
 *   retired `review-budget` (asked below the cap).
 * - **M-41** (§7.2, §8.3): the cards that are not product decisions, each in
 *   one kind: `review` (M-39's subjects); `duplicate`, an `m:` asking what a
 *   Worker's `q:` of one of its mission's requests already asked — the same
 *   text as the materialiser compares it (`sameQuestionText`), or an equal
 *   subject — while that `q:` was open; `governorProcess`, an Orchestrator's
 *   `o:` of a process class with no goal change or split. The ladder step an
 *   `o:` was asked at is not stored, so every process-class `o:` counts, not
 *   only those below step 4.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { z } from "zod";
import { decisionClassOf, decisionKindOf, decisionSchema, LEGACY_REVIEW_BUDGET_SUBJECT, type Decision, type DecisionClass } from "../decisions";
import { isMissionActionKind } from "../mission-change";
import { REVIEW_CAP_SUBJECT } from "../question-subjects";
import { timeOrNull } from "../time";
import { decisionInScope } from "./delegation";
import { compareText, ratio } from "./helpers";
import type { EvalScope, EvalStores } from "./scope";
import type { EvalInput, EvalMetrics, EvalUnknowns } from "./types";

/** `m:<missionId>:<n>`, as `server/mission-decisions.ts` stores it. */
const MISSION_DECISION_ID = /^m:(mis-[0-9a-f]{10}):([1-9]\d{0,5})$/;
const missionDecisionIdSchema = z.string().regex(MISSION_DECISION_ID);

/** A stored `m:` decision: the decision schema, its ids of the `m:` shape (as `server/mission-decisions.ts`'s). */
const missionDecisionSchema = decisionSchema.safeExtend({
  id: missionDecisionIdSchema,
  supersedes: missionDecisionIdSchema.nullable(),
  supersededBy: missionDecisionIdSchema.nullable(),
});

/** The subjects of the owner's questions about review (M-39). */
const REVIEW_SUBJECTS: readonly string[] = [REVIEW_CAP_SUBJECT, LEGACY_REVIEW_BUDGET_SUBJECT];

/** The classes of an ask about how a mission runs, gated to ladder step 4 (`server/orchestrator-decide-tools.ts` `PROCESS_CLASSES`). */
const PROCESS_CLASSES: readonly DecisionClass[] = ["scope", "preference", "reversible-technical"];
/** A subject naming a goal change or a split, which the step-4 gate lets through (as `orchestrator-decide-tools.ts`'s). */
const GOAL_OR_SPLIT_SUBJECT = /(^|-)(goal|split)(-|$)/;

/** Question text as the materialiser compares it (`server/decision-materialiser.ts` `normalisedQuestion`). */
function normalisedQuestion(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whether two questions ask the same thing by their text (`sameQuestionText`): normalised equal and not empty. */
export function sameQuestionText(a: string, b: string): boolean {
  const text = normalisedQuestion(a);
  return text !== "" && text === normalisedQuestion(b);
}

/** The stored `m:` decisions, validated and in a total order; a bad one is counted. */
export function missionDecisionsOf(input: Pick<EvalInput, "missionDecisions">, unknowns: EvalUnknowns): Decision[] {
  const decisions: Decision[] = [];
  for (const raw of input.missionDecisions ?? []) {
    const parsed = missionDecisionSchema.safeParse(raw);
    if (parsed.success) decisions.push(parsed.data);
    else unknowns.invalidMissionDecisions += 1;
  }
  return decisions.sort((a, b) => compareText(a.askedAt, b.askedAt) || compareText(a.id, b.id));
}

/** True when the decision was a card the owner saw: no agent answered it, and it is not an override. */
export function isOwnerCard(decision: Pick<Decision, "id" | "answer">): boolean {
  if (decisionKindOf(decision.id) === "override") return false;
  return decision.answer === null || decision.answer.by === "owner";
}

const isReviewCard = (decision: Pick<Decision, "subject">): boolean => decision.subject !== null && REVIEW_SUBJECTS.includes(decision.subject);

/** The cards in scope of both stores, each once. */
function cardsOf(scope: EvalScope, stores: EvalStores, missionDecisions: readonly Decision[]): Decision[] {
  const seen = new Set<string>();
  const cards: Decision[] = [];
  for (const decision of [...stores.decisions, ...missionDecisions]) {
    const place = `${decision.workspaceId}\u0000${decision.id}`;
    if (seen.has(place) || !isOwnerCard(decision) || !decisionInScope(scope, decision)) continue;
    seen.add(place);
    cards.push(decision);
  }
  return cards;
}

/** M-39 over the cards in scope. */
export function m39Of(scope: EvalScope, stores: EvalStores, missionDecisions: readonly Decision[], decisionsIncluded: boolean): EvalMetrics["m39"] {
  const cards = cardsOf(scope, stores, missionDecisions).filter(isReviewCard);
  const perRequest = new Map<string, number>();
  let withoutRequest = 0;
  for (const card of cards) {
    if (card.requestId === null) withoutRequest += 1;
    else perRequest.set(card.requestId, (perRequest.get(card.requestId) ?? 0) + 1);
  }
  const counts = [...perRequest.values()];
  return {
    decisionsIncluded,
    cards: cards.length,
    reviewCap: cards.filter((card) => card.subject === REVIEW_CAP_SUBJECT).length,
    belowCap: cards.filter((card) => card.subject === LEGACY_REVIEW_BUDGET_SUBJECT).length,
    requests: counts.length,
    maxPerRequest: counts.length === 0 ? null : Math.max(...counts),
    meanPerRequest: ratio(
      counts.reduce((sum, count) => sum + count, 0),
      counts.length,
    ),
    requestsOverOne: counts.filter((count) => count > 1).length,
    withoutRequest,
  };
}

/** True while `decision` was unsettled at `ms`: asked by then, not settled before. */
function openAt(decision: Pick<Decision, "askedAt" | "settledAt">, ms: number): boolean {
  const asked = timeOrNull(decision.askedAt);
  const settled = timeOrNull(decision.settledAt);
  return asked !== null && asked <= ms && (settled === null || settled > ms);
}

/** M-41 over the cards in scope. */
export function m41Of(
  scope: EvalScope,
  stores: EvalStores,
  missionDecisions: readonly Decision[],
  input: Pick<EvalInput, "decisions" | "missionDecisions" | "missionRequests">,
): EvalMetrics["m41"] {
  const cards = cardsOf(scope, stores, missionDecisions);
  const questionsByRequest = new Map<string, Decision[]>();
  for (const decision of stores.decisions) {
    if (decisionKindOf(decision.id) !== "question" || decision.requestId === null) continue;
    const list = questionsByRequest.get(decision.requestId) ?? [];
    list.push(decision);
    questionsByRequest.set(decision.requestId, list);
  }

  const byKind = { duplicate: 0, governorProcess: 0, review: 0 };
  let missionCardsWithoutRequests = 0;
  for (const card of cards) {
    if (isReviewCard(card)) {
      byKind.review += 1;
      continue;
    }
    const missionId = MISSION_DECISION_ID.exec(card.id)?.[1];
    if (missionId !== undefined) {
      const requestIds = input.missionRequests?.[missionId];
      const askedAt = timeOrNull(card.askedAt);
      if (requestIds === undefined) {
        missionCardsWithoutRequests += 1;
        continue;
      }
      const repeats =
        askedAt !== null &&
        requestIds.some((requestId) =>
          (questionsByRequest.get(requestId) ?? []).some(
            (question) => openAt(question, askedAt) && ((card.subject !== null && question.subject === card.subject) || sameQuestionText(question.question, card.question)),
          ),
        );
      if (repeats) byKind.duplicate += 1;
      continue;
    }
    if (decisionKindOf(card.id) !== "orchestrator" || !PROCESS_CLASSES.includes(decisionClassOf(card))) continue;
    if (card.subject !== null && GOAL_OR_SPLIT_SUBJECT.test(card.subject)) continue;
    // A goal change, a split or an arbitration carried as a mission action passes the step-4 gate: the owner's own decision.
    if (card.options.some((option) => isMissionActionKind(option.action?.kind))) continue;
    byKind.governorProcess += 1;
  }
  const notProduct = byKind.duplicate + byKind.governorProcess + byKind.review;
  return {
    decisionsIncluded: input.decisions !== undefined,
    missionDecisionsIncluded: input.missionDecisions !== undefined,
    cards: cards.length,
    notProduct,
    share: ratio(notProduct, cards.length),
    byKind,
    missionCardsWithoutRequests,
  };
}
