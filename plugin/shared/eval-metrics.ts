/**
 * The programme's metrics (evaluation design §4): pure functions from trace
 * records, the stored decisions, the Orchestrator's commands, wakes, notes and
 * intervention log (and the stall keys and proposals of older builds) to the
 * metric set A-1 … A-12, the context and token figures (autonomy design §G.2),
 * review lift (§C.4) and the supplementary figures — among them what the retired runtime rules
 * flagged (`supplementary.process`, autonomy design §B.9).
 *
 * This is the single definition of every metric: the replay
 * (`scripts/eval/replay.ts`), the evaluation suite and the Insights screen
 * (`server/insights-rpc.ts`) call it. `computeEvalMetrics` prepares the inputs
 * once (`eval-metrics/scope.ts`) and composes one function per metric:
 *
 * - `eval-metrics/questions.ts` — A-1, A-2, A-5's lower bound over the question keys, the owner's wait and the recommended option's agreement;
 * - `eval-metrics/delegation.ts` — A-4 and A-5 of delegated decisions per class, with the owner's own reversals as A-5's reference;
 * - `eval-metrics/actions.ts` — A-6;
 * - `eval-metrics/orchestrator.ts` — A-7, the Orchestrator's tokens of A-8, A-12;
 * - `eval-metrics/tokens.ts` — A-8 and the context and token figures;
 * - `eval-metrics/requests.ts` — A-11, review lift per tier and workspace (autonomy design §C.4) and the other supplementary figures;
 * - `eval-metrics/suite.ts` — A-3 and A-9, which only the suite knows;
 * - `eval-metrics/writers.ts` — `writers-observed`, two agents writing one file in overlapping turns (autonomy design §F.1);
 * - `eval-metrics/admission.ts` — the admission evidence per error class a candidate specialist claims (autonomy design §F.2), beside the metric set: `computeAdmissionEvidence`.
 *
 * The inputs and the output are in `eval-metrics/types.ts`, the small helpers
 * in `eval-metrics/helpers.ts`. This module is their public face: callers
 * import from it, never from `eval-metrics/`.
 *
 * Rules every metric follows:
 *
 * - **Pure and deterministic.** No clock, no file, no environment: the window
 *   is an input, and the inputs are put in a total order first, so the same
 *   records in another order give the same output.
 * - **Unknown is not zero.** A figure that cannot be computed is `null`, and
 *   every piece of missing data is counted in `unknowns`, never folded into a
 *   count as zero.
 * - **A request** is the records sharing a `requestId`; it is in the window
 *   when its earliest activity is. Every request-level figure then uses all of
 *   that request's records, whatever their time. A record without a request
 *   counts for the turn-level figures when its own time is in the window.
 * - **Finished** is a request with a `finished` report.
 *
 * Message times can be the collector's write time (when `timeline.refetch`
 * failed), so every duration here is as good as the times recorded.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { a6Of } from "./eval-metrics/actions";
import { admissionEvidenceOf, type AdmissionEvidence } from "./eval-metrics/admission";
import { delegationOf } from "./eval-metrics/delegation";
import { a12Of, a7Of, orchestratorTokensOf } from "./eval-metrics/orchestrator";
import { a1Of, a2Of, a5Of, ownerWaitOf, questionOutcomesOf, recommendedAgreementOf } from "./eval-metrics/questions";
import { a11Of, processOf, reportFormatOf, requestsByDayOf, reviewLiftOf, reviewsOf, roundsBlockedOf, tierMixOf, turnsByRoleOf, turnsEndedOf } from "./eval-metrics/requests";
import { askedDecisionsOf, conversationOf, deliveriesOf, emptyUnknowns, grantsOf, ownerTextsOf, scopeOf, shellEvidenceOf, storesOf } from "./eval-metrics/scope";
import { a3Of, a9Of } from "./eval-metrics/suite";
import { a8Of, contextOf } from "./eval-metrics/tokens";
import { writersObservedFiguresOf } from "./eval-metrics/writers";
import type { EvalInput, EvalMetrics } from "./eval-metrics/types";

export {
  EVAL_ROLES,
  REVIEW_TIERS,
  TOKEN_PROVIDERS,
  type CandidateRow,
  type CandidateSet,
  type ContextCandidates,
  type EvalInput,
  type EvalMetrics,
  type EvalNote,
  type EvalRole,
  type EvalScenarioOutcome,
  type EvalSuiteInputs,
  type EvalWindow,
  type HeavyRequest,
  type InterventionCounts,
  type OverrideCounts,
  type QuestionSplit,
  type ReversalRate,
  type ReviewLiftFigures,
  type ReviewLiftSplit,
  type ReviewTier,
  type RoleCounts,
  type Spread,
  type SpreadByRole,
  type TokenProvider,
  type WritersObservedFigures,
} from "./eval-metrics/types";
export {
  ADMISSION_CANDIDATES,
  ADMISSION_CLASSES,
  verificationFiguresOf,
  workerReadingOf,
  type AdmissionCandidate,
  type AdmissionClassEvidence,
  type AdmissionClassId,
  type AdmissionEvidence,
  type VerificationFigures,
  type WorkerReadingFigures,
} from "./eval-metrics/admission";
export { answerChoiceOf, freshInputTokensOf, median, normaliseQuestionText, percentile, recordStart, workspaceOfStallKey, type AnswerChoice } from "./eval-metrics/helpers";
export {
  BRIEF_CHARACTERS,
  BRIEF_TOKENS,
  CHARACTERS_PER_TOKEN,
  HEAVIEST_REQUESTS,
  TOKEN_COVERAGE,
  spreadOf,
  tokenProviderOf,
  turnTokensOf,
  type TokenCoverage,
  type TurnTokens,
} from "./eval-metrics/tokens";

/** Every metric of design §4 for one set of inputs. Pure and deterministic. */
export function computeEvalMetrics(input: EvalInput): EvalMetrics {
  // The prepared inputs, each read once; every piece of missing data is counted in `unknowns`.
  const unknowns = emptyUnknowns();
  const scope = scopeOf(input, unknowns);
  const stores = storesOf(input, unknowns);
  const deliveries = deliveriesOf(scope, unknowns);
  const conversation = conversationOf(deliveries, scope, stores, unknowns);
  const ownerTexts = ownerTextsOf(deliveries, scope, stores.proposals);
  const decisionsByRequest = askedDecisionsOf(scope, stores, unknowns);
  const shellByRecord = shellEvidenceOf(scope.scopeRecords);
  const outcomes = questionOutcomesOf(scope, conversation, ownerTexts, decisionsByRequest, unknowns);
  const delegation = delegationOf(scope, stores, unknowns);
  const finished = scope.finishedRequests.length;

  return {
    window: { since: input.window.since, until: input.window.until },
    requests: { inWindow: scope.inScope.length, finished },
    a1: a1Of(outcomes, scope),
    a2: a2Of(outcomes, decisionsByRequest),
    a3: a3Of(input.suite),
    a4: delegation.a4,
    a5: { ...a5Of(outcomes, scope, conversation.answeredAtByRequest, shellByRecord, stores.proposals), ...delegation.a5 },
    a6: a6Of(scope, shellByRecord, ownerTexts, grantsOf(deliveries, stores), input.workspaceDirectories, unknowns, stores),
    a7: a7Of(input, stores, scope.bounds, unknowns),
    a8: a8Of(scope.finishedRequests, orchestratorTokensOf(stores.wakes, input.wakes !== undefined, scope.bounds, finished), input.suite?.orchestratorCostUsd ?? null),
    a9: a9Of(input.suite),
    a11: a11Of(scope.finishedRequests, outcomes, unknowns),
    a12: a12Of(input.interventions, scope.bounds, unknowns),
    context: contextOf(scope),
    reviewLift: reviewLiftOf(scope),
    supplementary: {
      recommendedAgreement: recommendedAgreementOf(outcomes, unknowns),
      ownerWait: ownerWaitOf(outcomes),
      roundsBlocked: roundsBlockedOf(scope.inScope),
      tierMix: tierMixOf(scope.inScope),
      reviews: reviewsOf(scope.inScope, unknowns),
      reportFormat: reportFormatOf(scope.inScope),
      process: processOf(scope, unknowns),
      cancelledTurns: turnsEndedOf(scope.scopeRecords, "canceled"),
      failedTurns: turnsEndedOf(scope.scopeRecords, "failed"),
      turnsByRole: turnsByRoleOf(scope.scopeRecords),
      requestsByDay: requestsByDayOf(scope),
      writersObserved: writersObservedFiguresOf(scope.scopeRecords, input.workspaceDirectories),
    },
    unknowns,
  };
}

/**
 * The admission evidence (autonomy design §F.2) for one set of inputs: per
 * error class a candidate claims, the figure that measures it, or none.
 * `metrics` is `computeEvalMetrics(input)` when the caller has it already.
 * Kept apart from `computeEvalMetrics`, so the metric set is unchanged. Pure
 * and deterministic.
 */
export function computeAdmissionEvidence(input: EvalInput, metrics: EvalMetrics = computeEvalMetrics(input)): AdmissionEvidence {
  return admissionEvidenceOf(scopeOf(input, emptyUnknowns()), metrics, input.workspaceDirectories);
}
