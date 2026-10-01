/**
 * The metrics read off the question keys (evaluation design §4): A-1 (how each
 * key was settled), A-2 (duplicates), A-5's lower bound (reversals), and the owner's wait
 * and the recommended option's agreement. Every one of them starts from
 * `questionOutcomesOf`, the classification of every key in the window.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { Evidence, TraceRecord } from "../contracts";
import type { Proposal } from "../orchestrator";
import { answerChoiceOf, compareText, median, normaliseQuestionText, percentile, ratio, sameChoice, type AnswerChoice } from "./helpers";
import {
  isOrchestratorCommand,
  proposalInScope,
  sentTimeOf,
  type AskedDecision,
  type Conversation,
  type EvalScope,
  type OwnerText,
  type QuestionFacts,
} from "./scope";
import type { EvalMetrics, EvalUnknowns, QuestionSplit } from "./types";
import { BR_REOPEN } from "../shell";
import { timeOrNull } from "../time";

const OVERRIDE_WINDOW_MS = 24 * 60 * 60_000;

/** How one key of a request in the window was settled (A-1), with what the other figures read off it. */
export interface QuestionOutcome {
  question: QuestionFacts;
  outcome: "reachedOwner" | "answeredByAgents" | "unanswered";
  /** Answered by agents, and the Orchestrator's answer. */
  viaCommand: boolean;
  /** The owner's wait, question → the owner's answer (else the first answer); null when it did not reach the owner or cannot be timed. */
  ownerWait: [number, number] | null;
  /** What each answer chose, oldest first (null: unreadable); empty when never answered. */
  choices: Array<AnswerChoice | null>;
}

/** A-1 and what hangs off it: the classification of every key of a request in the window, in key order. */
export function questionOutcomesOf(
  scope: EvalScope,
  conversation: Conversation,
  ownerTexts: ReadonlyMap<string, readonly OwnerText[]>,
  decisionsByRequest: ReadonlyMap<string, readonly AskedDecision[]>,
  unknowns: EvalUnknowns,
): QuestionOutcome[] {
  const outcomes: QuestionOutcome[] = [];
  const between = (at: number | null, from: number, to: number): boolean => at !== null && at >= from && at <= to;
  const orderedQuestions = [...conversation.questions.entries()].sort(([a], [b]) => compareText(a, b));
  for (const [key, question] of orderedQuestions) {
    if (!scope.included.has(question.requestId)) continue;
    const delivered = conversation.answers.get(key) ?? [];
    const first = delivered[0];
    const decisions = decisionsByRequest.get(question.requestId) ?? [];
    let outcome: QuestionOutcome["outcome"];
    let viaCommand = false;
    let ownerWait: QuestionOutcome["ownerWait"] = null;
    if (first === undefined) {
      const asked = decisions.some((decision) => question.at === null || (timeOrNull(decision.at) ?? Number.NEGATIVE_INFINITY) >= question.at);
      outcome = asked ? "reachedOwner" : "unanswered";
    } else {
      const timed = question.at !== null && first.at !== null;
      if (!timed) unknowns.questionsWithoutTime += 1;
      const from = question.at ?? Number.POSITIVE_INFINITY;
      const to = first.at ?? Number.NEGATIVE_INFINITY;
      // The owner answered its stored decision: it reached the owner, whoever answered first.
      const ownerAnswer = conversation.ownerAnswerOf.get(key);
      const ownerBetween =
        ownerAnswer !== undefined ||
        first.owner ||
        (timed && (ownerTexts.get(question.requestId) ?? []).some((text) => between(text.at, from, to))) ||
        (timed && decisions.some((decision) => between(timeOrNull(decision.at), from, to)));
      outcome = ownerBetween ? "reachedOwner" : "answeredByAgents";
      if (!ownerBetween) viaCommand = first.fromOrchestrator || (conversation.commandAnswerAt.get(key) ?? []).some((at) => first.at !== null && at <= first.at);
      // The owner's wait ends at the owner's own answer when the store has it.
      const waitEnd = ownerAnswer?.at ?? first.at;
      if (ownerBetween && question.at !== null && waitEnd !== null && waitEnd >= question.at) ownerWait = [question.at, waitEnd];
    }
    const choices = delivered.map((answer) => answerChoiceOf(answer.text, question.optionKeys.length > 0 ? question.optionKeys : undefined));
    outcomes.push({ question, outcome, viaCommand, ownerWait, choices });
  }
  return outcomes;
}

/** A-1: how the questions were settled, over the requests in the window and over the finished ones. */
export function a1Of(outcomes: readonly QuestionOutcome[], scope: EvalScope): EvalMetrics["a1"] {
  const emptySplit = (): QuestionSplit => ({ asked: 0, reachedOwner: 0, answeredByAgents: 0, answeredByAgentsViaCommand: 0, unanswered: 0 });
  const all = emptySplit();
  const finished = emptySplit();
  for (const { question, outcome, viaCommand } of outcomes) {
    for (const split of scope.finishedIds.has(question.requestId) ? [all, finished] : [all]) {
      split.asked += 1;
      split[outcome] += 1;
      if (viaCommand) split.answeredByAgentsViaCommand += 1;
    }
  }
  const finishedCount = scope.finishedRequests.length;
  return {
    all,
    finished,
    perFinishedRequest:
      finishedCount === 0
        ? null
        : {
            asked: finished.asked / finishedCount,
            reachedOwner: finished.reachedOwner / finishedCount,
            answeredByAgents: finished.answeredByAgents / finishedCount,
          },
  };
}

/** A-2 duplicates: (a) a key answered twice, (b) the same question text under two keys, (c) two decisions open at once. */
export function a2Of(outcomes: readonly QuestionOutcome[], decisionsByRequest: ReadonlyMap<string, readonly AskedDecision[]>): EvalMetrics["a2"] {
  const answeredTwice = outcomes.filter((outcome) => outcome.choices.length > 1).length;

  // (b): the same question text under two keys of one request.
  let sameTextTwoKeys = 0;
  const textsByRequest = new Map<string, Set<string>>();
  for (const { question } of outcomes) {
    const text = normaliseQuestionText(question.text);
    if (text === "") continue;
    const seen = textsByRequest.get(question.requestId) ?? new Set<string>();
    if (seen.has(text)) sameTextTwoKeys += 1;
    else seen.add(text);
    textsByRequest.set(question.requestId, seen);
  }

  // (c): two decisions of one request open at the same time.
  let overlappingDecisions = 0;
  for (const decisions of decisionsByRequest.values()) {
    const spans = decisions
      .map((decision) => {
        const start = timeOrNull(decision.at);
        const settled = timeOrNull(decision.settledAt);
        const end = settled ?? (decision.open ? Number.POSITIVE_INFINITY : start);
        return start === null || end === null ? null : { start, end };
      })
      .filter((span): span is { start: number; end: number } => span !== null);
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        if (spans[i]!.start < spans[j]!.end && spans[j]!.start < spans[i]!.end) overlappingDecisions += 1;
      }
    }
  }

  return { answeredTwice, sameTextTwoKeys, overlappingDecisions, total: answeredTwice + sameTextTwoKeys + overlappingDecisions };
}

/**
 * A-5 reversals, a lower bound: (i) a key re-answered with another choice;
 * (ii) `br reopen` after an answer of the same request; (iii) owner commands
 * overriding Orchestrator ones within 24 hours. The reversals decisions record
 * from Phase 2 are `delegation.ts`'s.
 */
export function a5Of(
  outcomes: readonly QuestionOutcome[],
  scope: EvalScope,
  answeredAtByRequest: ReadonlyMap<string, readonly number[]>,
  shellByRecord: ReadonlyMap<TraceRecord, readonly Evidence[]>,
  proposals: readonly Proposal[],
): Omit<EvalMetrics["a5"], "delegated" | "owner"> {
  let reanswered = 0;
  let answered = 0;
  for (const { choices } of outcomes) {
    if (choices.length === 0) continue;
    answered += 1;
    const firstChoice = choices[0] ?? null;
    if (firstChoice !== null && choices.slice(1).some((choice) => choice !== null && !sameChoice(firstChoice, choice))) reanswered += 1;
  }

  let reopenedAfterAnswer = 0;
  for (const facts of scope.inScope) {
    const answeredTimes = answeredAtByRequest.get(facts.id) ?? [];
    if (answeredTimes.length === 0) continue;
    const firstAnswer = Math.min(...answeredTimes);
    for (const record of facts.records) {
      for (const evidence of shellByRecord.get(record) ?? []) {
        const at = timeOrNull(evidence.at);
        if (at !== null && at > firstAnswer && BR_REOPEN.test(evidence.detail)) reopenedAfterAnswer += 1;
      }
    }
  }

  let ownerOverrides = 0;
  const sentCommands = proposals.filter((proposal) => proposal.kind === "command" && proposal.status === "sent" && proposalInScope(scope, proposal));
  for (const command of sentCommands) {
    if (!isOrchestratorCommand(command)) continue;
    const sent = sentTimeOf(command);
    if (sent === null) continue;
    const overridden = sentCommands.some((other) => {
      const at = sentTimeOf(other);
      return other.source === "user" && other.requestId === command.requestId && at !== null && at > sent && at <= sent + OVERRIDE_WINDOW_MS;
    });
    if (overridden) ownerOverrides += 1;
  }

  const total = reanswered + reopenedAfterAnswer + ownerOverrides;
  return { lowerBound: true, reanswered, reopenedAfterAnswer, ownerOverrides, total, answered, perAnsweredQuestion: ratio(total, answered) };
}

/** How the first answer to each key chose: the recommended option, another option or own words; an unreadable one is left out and counted. */
export function recommendedAgreementOf(outcomes: readonly QuestionOutcome[], unknowns: EvalUnknowns): EvalMetrics["supplementary"]["recommendedAgreement"] {
  const agreement = { answered: 0, recommended: 0, otherOption: 0, ownWords: 0 };
  for (const { question, choices } of outcomes) {
    if (choices.length === 0) continue;
    const firstChoice = choices[0] ?? null;
    if (firstChoice === null) {
      unknowns.unreadableAnswers += 1;
      continue;
    }
    agreement.answered += 1;
    if ("other" in firstChoice) agreement.ownWords += 1;
    else if (firstChoice.key === question.recommended) agreement.recommended += 1;
    else agreement.otherOption += 1;
  }
  return { ...agreement, share: ratio(agreement.recommended, agreement.answered) };
}

/** The owner's wait over the questions that reached the owner: its median and p90. */
export function ownerWaitOf(outcomes: readonly QuestionOutcome[]): EvalMetrics["supplementary"]["ownerWait"] {
  const waits = outcomes.flatMap(({ ownerWait }) => (ownerWait === null ? [] : [ownerWait[1] - ownerWait[0]]));
  return { questions: waits.length, medianMs: median(waits), p90Ms: percentile(waits, 90) };
}
