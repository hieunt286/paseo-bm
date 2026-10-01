/**
 * The Inbox's Decided for you and its Override (autonomy design §B.7, §B.9;
 * PRD REQ-125): the rules both sides read.
 *
 * - **Decided for you** is a decision answered by the owner's policy or by an
 *   owner precedent (`isDecidedForOwner`); an owner's answer, and a Phase 1
 *   answer of the Orchestrator, never are.
 * - **Override** takes one of them back as a new owner decision `r:<uuid>`
 *   (`overrideDecisionOf`): the same question, options, subject, class and
 *   request, `supersedes` the delegated one, open until the owner answers it.
 *   Override itself answers nothing; the delegated answer, already delivered,
 *   is not recalled — the owner's corrected answer follows it to the same
 *   agent (`deliveryKindOf`). The delegated decision records the reversal
 *   `overridden` with the override's id, and that is what makes a second
 *   press return the same override (`overrideIdOf`).
 * - An override is the owner's own correction: no precedent, no policy and no
 *   Orchestrator ever answers or predicts it (`shared/autonomy.ts`,
 *   `shared/precedents.ts`, `server/policy-resolve.ts` leave `r:` alone).
 *
 * Pure: no clock, no file, no agent. `shared/`: Zod and plain values only.
 */
import { OVERRIDE_ID_PREFIX, answeredByText, decisionClassOf, decisionKindOf, isAnswerable, type Decision } from "./decisions";

/** True for a decision answered for the owner: by the policy (§B.5) or an owner precedent (§B.6). */
export function isDecidedForOwner(decision: Pick<Decision, "status" | "answer">): boolean {
  return decision.status === "answered" && (decision.answer?.by === "policy" || decision.answer?.by === "precedent");
}

/** The override already made of `decision` (its `overridden` reversal's id), or null. */
export function overrideIdOf(decision: Pick<Decision, "reversals">): string | null {
  return decision.reversals?.find((reversal) => reversal.kind === "overridden" && reversal.ref.startsWith(OVERRIDE_ID_PREFIX))?.ref ?? null;
}

/** Why a decision cannot be overridden: it was never decided for the owner, or nothing stands to override. */
export interface OverrideRefusal {
  refusal: "not-delegated" | "settled";
  message: string;
}

/**
 * Why `decision` cannot be overridden, or null when it can: only a decision
 * answered for the owner by the policy or a precedent can. One still open is
 * the owner's to answer; one the owner (or, in Phase 1, the Orchestrator)
 * answered was never decided for them; a superseded, withdrawn or expired one
 * has no answer to take back.
 */
export function overrideRefusalOf(decision: Pick<Decision, "id" | "status" | "answer">): OverrideRefusal | null {
  // Autonomy design §D.2: a held request the policy allowed already ran; there is nothing to take back.
  if (decisionKindOf(decision.id) === "held" && decision.status === "answered") {
    return { refusal: "not-delegated", message: `decision ${decision.id} allowed a permission request that already ran; it cannot be overridden` };
  }
  if (isDecidedForOwner(decision)) return null;
  if (isAnswerable(decision)) {
    return { refusal: "not-delegated", message: `decision ${decision.id} is still open for the owner; answer it instead of overriding it` };
  }
  if (decision.status === "answered") {
    return {
      refusal: "not-delegated",
      message: `decision ${decision.id} was answered by ${answeredByText(decision.answer?.by ?? "owner")}; only an answer the policy or a precedent gave for the owner can be overridden`,
    };
  }
  return { refusal: "settled", message: `decision ${decision.id} is ${decision.status}; it has no answer to override` };
}

/**
 * The owner decision an Override opens (§B.9): `id` (`r:<uuid>`), asked `at`,
 * with the delegated decision's request, asker, round, question, subject and
 * options, its answer's class (the cell the override takes back), open, and
 * `supersedes` the delegated one. It keeps the option marked recommended as
 * its prediction when the delegated decision recorded one, so the owner's
 * corrected answer counts in the agreement ledger like any owner answer
 * (§B.3); the Orchestrator never predicts it.
 */
export function overrideDecisionOf(decision: Decision, input: { id: string; at: string }): Decision {
  return {
    id: input.id,
    workspaceId: decision.workspaceId,
    requestId: decision.requestId,
    askedBy: decision.askedBy,
    askedAt: input.at,
    round: decision.round,
    question: decision.question,
    subject: decision.subject,
    class: decision.answer?.class ?? decisionClassOf(decision),
    options: decision.options,
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: decision.id,
    supersededBy: null,
    ...(decision.prediction === undefined ? {} : { prediction: { recommended: decision.prediction.recommended, orchestrator: null } }),
  };
}
