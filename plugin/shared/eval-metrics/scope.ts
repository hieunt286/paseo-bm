/**
 * The prepared inputs of the metrics: the records put in a total order and
 * read into requests, the requests the window holds, the stores checked entry
 * by entry, and every message that reached an agent read once — into the
 * question keys and their answers, what the owner said, what the owner granted
 * and the decisions put to the owner. Each metric takes the pieces it needs.
 *
 * It reads the `BM-*` blocks with the plugin's own readers (`parseQuestions` /
 * `parseAnswers`, `parseCommandBlock`, and the reports the collector already
 * parsed into each record), so a metric reads a block exactly as the
 * collector, the question ledger and the cards do.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { Evidence, ParsedReport, ParsedReview, TraceMessage, TraceRecord } from "../contracts";
import { parseAnswers, parseQuestions } from "../bm-questions";
import { ownReviewsOf, requestIdFromText } from "../bm-report";
import { decisionKindOf, decisionSchema, isSettledStatus, policyPredictorOf, realEffects, type Decision, type Effect } from "../decisions";
import { isPluginNotice } from "../notices";
import { decisionIdOfAuthority, parseCommandBlock, type CommandBlock } from "../orchestrator-command";
import { proposalSchema, wakeEntrySchema, type Proposal, type WakeEntry } from "../orchestrator";
import { uniqueBy } from "../order";
import { boundsOf, compareRecords, compareText, compareTimes, keyOf, push, recordStart, within, type Bounds } from "./helpers";
import type { EvalInput, EvalUnknowns } from "./types";
import { timeOrNull } from "../time";

const BARE_REQUEST_ID = /\b(req-\d{8}T\d{6}Z)\b/;

/** Every unknown at zero, in the output's order. */
export function emptyUnknowns(): EvalUnknowns {
  return {
    recordsWithoutRequest: 0,
    turnsWithoutUsage: 0,
    messagesWithoutOrigin: 0,
    questionsWithoutRequest: 0,
    answersWithoutRequest: 0,
    answersWithoutQuestion: 0,
    questionsWithoutTime: 0,
    unreadableAnswers: 0,
    requestsWithoutDuration: 0,
    reviewsWithoutBatch: 0,
    reviewsWithUnknownBlocking: 0,
    decisionsWithoutRequest: 0,
    invalidProposals: 0,
    invalidDecisions: 0,
    invalidStallEntries: 0,
    invalidWakes: 0,
    wakesWithoutTime: 0,
    wakesWithoutEnd: 0,
    invalidInterventions: 0,
    effectfulWithoutTime: 0,
    rmTargetsNotJudged: 0,
    processWeightWithoutTier: 0,
    unreviewedWithoutTier: 0,
    languageOrderUnknown: 0,
    ownerAnswersBeforeReversals: 0,
  };
}

// ── The records and the window ──────────────────────────────────────────────

export interface RequestFacts {
  id: string;
  records: TraceRecord[];
  /** Earliest turn start; null when no record of it has one. */
  start: number | null;
  reports: ParsedReport[];
  reviews: ParsedReview[];
  finishedAt: number | null;
  finished: boolean;
}

/** The records read into requests, and what the window holds of them. */
export interface EvalScope {
  bounds: Bounds;
  /** Every record, in the total order (`compareRecords`). */
  records: TraceRecord[];
  byRequest: Map<string, RequestFacts>;
  /** The ids of the requests in the window: their earliest activity is. */
  included: Set<string>;
  /** Each request's earliest activity; null when none of its records has a readable time. */
  earliestOf: Map<string, number | null>;
  /** The turns in scope: the records of the requests in the window, and the records without a request whose own time is in it. */
  scopeRecords: TraceRecord[];
  /** The requests in the window, in the order first seen. */
  inScope: RequestFacts[];
  finishedRequests: RequestFacts[];
  finishedIds: Set<string>;
}

/** A record counts for the turn-level figures when its request is in the window, or, without one, when its own time is. */
function recordInScope(record: TraceRecord, included: ReadonlySet<string>, bounds: Bounds): boolean {
  return record.requestId === null ? within(timeOrNull(record.at), bounds) : included.has(record.requestId);
}

/** The records in their total order, read into requests with their reports and reviews; which are in the window. */
export function scopeOf(input: Pick<EvalInput, "records" | "window">, unknowns: EvalUnknowns): EvalScope {
  const bounds = boundsOf(input.window);
  const records = [...input.records].sort(compareRecords);

  // Requests, and which are in the window.
  const byRequest = new Map<string, RequestFacts>();
  for (const record of records) {
    if (record.requestId === null) continue;
    let facts = byRequest.get(record.requestId);
    if (facts === undefined) {
      facts = { id: record.requestId, records: [], start: null, reports: [], reviews: [], finishedAt: null, finished: false };
      byRequest.set(record.requestId, facts);
    }
    facts.records.push(record);
    const start = recordStart(record);
    if (start !== null && (facts.start === null || start < facts.start)) facts.start = start;
  }
  const included = new Set<string>();
  const earliestOf = new Map<string, number | null>();
  for (const facts of byRequest.values()) {
    const earliest = facts.start ?? Math.min(...facts.records.map((record) => timeOrNull(record.at) ?? Number.POSITIVE_INFINITY));
    const known = Number.isFinite(earliest) ? earliest : null;
    earliestOf.set(facts.id, known);
    if (within(known, bounds)) included.add(facts.id);
  }
  const scopeRecords = records.filter((record) => recordInScope(record, included, bounds));
  for (const record of scopeRecords) {
    if (record.requestId === null) unknowns.recordsWithoutRequest += 1;
    if (record.usage === null) unknowns.turnsWithoutUsage += 1;
  }

  // Reports and reviews, de-duplicated on the Dashboard's keys (traces.ts).
  const allReports: Array<{ requestId: string; report: ParsedReport }> = [];
  const allReviews: Array<{ requestId: string | null; review: ParsedReview }> = [];
  for (const record of records) {
    for (const report of record.reports) {
      const requestId = report.requestId ?? record.requestId;
      if (requestId !== null) allReports.push({ requestId, report });
    }
    // Only a Reviewer's own answers: a quoted or relayed block is the same review again (bead 7gxw.12).
    for (const review of ownReviewsOf(record)) allReviews.push({ requestId: record.requestId, review });
  }
  const reports = uniqueBy(allReports, ({ requestId, report }) => `${report.agentId}|${report.phase ?? ""}|${requestId}|${report.at}`);
  const reviews = uniqueBy(
    allReviews,
    ({ review }) => `${review.agentId}|${review.batchId ?? ""}|${review.verdict ?? ""}|${review.at}`,
  );
  for (const { requestId, report } of reports) byRequest.get(requestId)?.reports.push(report);
  for (const { requestId, review } of reviews) if (requestId !== null) byRequest.get(requestId)?.reviews.push(review);
  for (const facts of byRequest.values()) {
    facts.reports.sort((a, b) => compareText(a.at, b.at));
    const finishedTimes = facts.reports.filter((report) => report.phase === "finished").map((report) => timeOrNull(report.at));
    facts.finished = finishedTimes.length > 0;
    const known = finishedTimes.filter((ms): ms is number => ms !== null);
    facts.finishedAt = known.length === 0 ? null : Math.min(...known);
  }
  const inScope = [...byRequest.values()].filter((facts) => included.has(facts.id));
  const finishedRequests = inScope.filter((facts) => facts.finished);
  return {
    bounds,
    records,
    byRequest,
    included,
    earliestOf,
    scopeRecords,
    inScope,
    finishedRequests,
    finishedIds: new Set(finishedRequests.map((facts) => facts.id)),
  };
}

// ── The stores ──────────────────────────────────────────────────────────────

/** The stores read beside the records: valid entries only, each in a total order; a bad entry is counted, never read. */
export interface EvalStores {
  /** The stored decisions (Phase 1). */
  decisions: Decision[];
  /** The first stored decision of each id. */
  decisionById: Map<string, Decision>;
  /** The Orchestrator's proposals (older builds). */
  proposals: Proposal[];
  /** The Orchestrator's wake records (A-7, A-8). */
  wakes: WakeEntry[];
}

export function storesOf(input: Pick<EvalInput, "decisions" | "proposals" | "wakes">, unknowns: EvalUnknowns): EvalStores {
  // Stored decisions (Phase 1).
  const decisions: Decision[] = [];
  for (const raw of input.decisions ?? []) {
    const parsed = decisionSchema.safeParse(raw);
    if (parsed.success) decisions.push(parsed.data);
    else unknowns.invalidDecisions += 1;
  }
  decisions.sort((a, b) => compareText(a.askedAt, b.askedAt) || compareText(a.workspaceId, b.workspaceId) || compareText(a.id, b.id));
  const decisionById = new Map<string, Decision>();
  for (const decision of decisions) if (!decisionById.has(decision.id)) decisionById.set(decision.id, decision);

  // Proposals.
  const proposals: Proposal[] = [];
  for (const raw of input.proposals ?? []) {
    const parsed = proposalSchema.safeParse(raw);
    if (parsed.success) proposals.push(parsed.data);
    else unknowns.invalidProposals += 1;
  }
  proposals.sort((a, b) => compareText(a.at, b.at) || compareText(a.id, b.id));

  // Wake records.
  const wakes: WakeEntry[] = [];
  for (const raw of input.wakes ?? []) {
    const parsed = wakeEntrySchema.safeParse(raw);
    if (parsed.success) wakes.push(parsed.data);
    else unknowns.invalidWakes += 1;
  }
  wakes.sort((a, b) => compareText(a.at, b.at) || compareText(a.orchestratorId, b.orchestratorId));

  return { decisions, decisionById, proposals, wakes };
}

/** Proposal time as sent (its settlement), else when it was stored. */
export const sentTimeOf = (proposal: Proposal): number | null => timeOrNull(proposal.settledAt) ?? timeOrNull(proposal.at);

export const isOrchestratorCommand = (proposal: Proposal): boolean => proposal.kind === "command" && proposal.source !== "user";

/** A proposal counts for a request in the window, or, for a request with no record, when it was made in the window. */
export function proposalInScope(scope: EvalScope, proposal: Proposal): boolean {
  return (
    proposal.requestId !== null &&
    (scope.included.has(proposal.requestId) || (!scope.byRequest.has(proposal.requestId) && within(timeOrNull(proposal.at), scope.bounds)))
  );
}

// ── The messages ────────────────────────────────────────────────────────────

/** A message that reached an agent, read once. */
export interface Delivery {
  record: TraceRecord;
  message: TraceMessage;
  at: number | null;
  command: CommandBlock | null;
  /** What the block readers read: a command's body, a plain message's text; null for any other plugin notice. */
  readable: string | null;
  /** Typed by the owner in the app, or a command from the owner (`from: owner`, which builds before Phase 1 sent). */
  owner: boolean;
}

/** Every message that reached an agent, read once (a reused turn id can put it in two records). */
export function deliveriesOf(scope: EvalScope, unknowns: EvalUnknowns): Delivery[] {
  const deliveries: Delivery[] = [];
  const seenMessages = new Set<string>();
  for (const record of scope.records) {
    for (const message of record.sent) {
      const identity = `${record.agentId}\u0000${message.at}\u0000${message.text}`;
      if (seenMessages.has(identity)) continue;
      seenMessages.add(identity);
      const command = parseCommandBlock(message.text);
      const readable = command !== null ? command.body : isPluginNotice(message.text) ? null : message.text;
      const owner = command !== null ? command.from === "owner" : message.origin === "user";
      deliveries.push({ record, message, at: timeOrNull(message.at), command, readable, owner });
      if (recordInScope(record, scope.included, scope.bounds) && message.origin === undefined) unknowns.messagesWithoutOrigin += 1;
    }
  }
  return deliveries;
}

export interface QuestionFacts {
  requestId: string;
  id: string;
  text: string;
  at: number | null;
  recommended: string | null;
  optionKeys: string[];
}

export interface AnswerFacts {
  requestId: string;
  id: string;
  text: string;
  at: number | null;
  owner: boolean;
  fromOrchestrator: boolean;
}

/** The question keys `(requestId, Qn)` and their answers (A-1 and what hangs off it). */
export interface Conversation {
  /** Each key at its first sight: in the records, else in its stored decision. */
  questions: Map<string, QuestionFacts>;
  /** The answers to each key that reached a Worker, and the stored ones; oldest first. */
  answers: Map<string, AnswerFacts[]>;
  /** When an Orchestrator command carried an answer to each key. */
  commandAnswerAt: Map<string, number[]>;
  /** When each request's answers came (A-5 (ii)). */
  answeredAtByRequest: Map<string, number[]>;
  /** The owner's stored answer to each key, when the store has one. */
  ownerAnswerOf: Map<string, { at: number | null }>;
}

/** The option key or the owner's words of a stored answer, as `answerChoiceOf` reads an answer line; empty for a confirmed chat answer. */
function answerTextOf(answer: NonNullable<Decision["answer"]>): string {
  if (answer.optionKey !== null) return answer.optionKey;
  return answer.words === null ? "" : `other — ${answer.words}`;
}

/** The `Qn` of a `q:<requestId>:<Qn>` decision, or null. */
function questionIdOf(decision: Decision): string | null {
  if (decisionKindOf(decision.id) !== "question" || decision.requestId === null) return null;
  const prefix = `q:${decision.requestId}:`;
  return decision.id.startsWith(prefix) ? decision.id.slice(prefix.length) : null;
}

/** Questions, first seen; answers that reached a Worker; answers inside Orchestrator commands; and the stored ones. */
export function conversationOf(deliveries: readonly Delivery[], scope: EvalScope, stores: EvalStores, unknowns: EvalUnknowns): Conversation {
  const questions = new Map<string, QuestionFacts>();
  const answers = new Map<string, AnswerFacts[]>();
  const commandAnswerAt = new Map<string, number[]>();
  const answeredAtByRequest = new Map<string, number[]>();
  for (const delivery of deliveries) {
    const { record, message, command, readable } = delivery;
    if (readable === null) continue;

    if (message.origin !== "user") {
      const set = parseQuestions(readable);
      if (set !== null && set.questions.length > 0) {
        const requestId = set.requestId ?? requestIdFromText(readable) ?? command?.requestId ?? record.requestId;
        if (requestId === null) unknowns.questionsWithoutRequest += set.questions.length;
        else {
          for (const question of set.questions) {
            const key = keyOf(requestId, question.id);
            const known = questions.get(key);
            const earlier = known === undefined || (delivery.at !== null && (known.at === null || delivery.at < known.at));
            if (!earlier) continue;
            questions.set(key, {
              requestId,
              id: question.id,
              text: question.text,
              at: delivery.at,
              recommended: question.options.find((option) => option.recommended)?.key ?? null,
              optionKeys: question.options.map((option) => option.key),
            });
          }
        }
      }
    }

    if (command?.from === "orchestrator" && delivery.at !== null) {
      const set = parseAnswers(command.body);
      const requestId = set?.requestId ?? command.requestId ?? record.requestId;
      if (set !== null && requestId !== null) for (const answer of set.answers) push(commandAnswerAt, keyOf(requestId, answer.id), delivery.at);
    }

    if (record.role !== "worker") continue;
    const set = parseAnswers(readable);
    if (set === null || set.answers.length === 0) continue;
    const requestId =
      set.requestId ?? requestIdFromText(readable) ?? BARE_REQUEST_ID.exec(readable)?.[1] ?? command?.requestId ?? record.requestId;
    if (requestId === null) {
      unknowns.answersWithoutRequest += set.answers.length;
      continue;
    }
    for (const answer of set.answers) {
      push(answers, keyOf(requestId, answer.id), {
        requestId,
        id: answer.id,
        text: answer.text,
        at: delivery.at,
        owner: delivery.owner,
        fromOrchestrator: command?.from === "orchestrator",
      });
      if (delivery.at !== null) push(answeredAtByRequest, requestId, delivery.at);
    }
  }
  // Stored Worker questions (Phase 1): a question the records do not show is taken from its decision;
  // the owner's answer is one more answer to its key, unless the owner's own answer already reached the Worker.
  // The Orchestrator's stored answer (`bm_decide`, change-004) never reached the owner: an answer by agents,
  // which the Worker gets only as the plugin's BM-DELIVERY (never read from the records as an answer).
  const ownerAnswerOf = new Map<string, { at: number | null }>();
  for (const decision of stores.decisions) {
    const id = questionIdOf(decision);
    if (id === null || decision.requestId === null) continue;
    const key = keyOf(decision.requestId, id);
    if (!questions.has(key)) {
      questions.set(key, {
        requestId: decision.requestId,
        id,
        text: decision.question,
        at: timeOrNull(decision.askedAt),
        recommended: decision.options.find((option) => option.recommended)?.key ?? null,
        optionKeys: decision.options.map((option) => option.key),
      });
    }
    if (decision.status !== "answered" || decision.answer === null) continue;
    const answeredAt = timeOrNull(decision.answer.at);
    const byOwner = decision.answer.by === "owner";
    if (byOwner) {
      ownerAnswerOf.set(key, { at: answeredAt });
      if ((answers.get(key) ?? []).some((answer) => answer.owner)) continue;
    }
    // The Orchestrator's own answers only: Phase 1's `by: orchestrator`, or the
    // policy with the Orchestrator as predictor (`bm_decide`); the recommended
    // option and a precedent are answered by agents, not by the Orchestrator
    // (Phase 2 live check, 2026-09-30).
    const byOrchestrator = decision.answer.by === "orchestrator" || policyPredictorOf(decision) === "orchestrator";
    push(answers, key, { requestId: decision.requestId, id, text: answerTextOf(decision.answer), at: answeredAt, owner: byOwner, fromOrchestrator: byOrchestrator });
    if (answeredAt !== null) push(answeredAtByRequest, decision.requestId, answeredAt);
  }
  for (const list of answers.values()) list.sort((a, b) => compareTimes(a.at, b.at));
  for (const [key, list] of answers) {
    if (!questions.has(key) && scope.included.has(list[0]!.requestId)) unknowns.answersWithoutQuestion += 1;
  }
  return { questions, answers, commandAnswerAt, answeredAtByRequest, ownerAnswerOf };
}

/** What the owner said in a request, and when (`null` when unknown). */
export interface OwnerText {
  at: number | null;
  text: string;
}

/**
 * What the owner said in each request: the owner's messages that reached an
 * agent, and (older builds) the owner's sent commands and decision answers of
 * the proposals in scope.
 */
export function ownerTextsOf(deliveries: readonly Delivery[], scope: EvalScope, proposals: readonly Proposal[]): Map<string, OwnerText[]> {
  const ownerTexts = new Map<string, OwnerText[]>();
  for (const delivery of deliveries) {
    if (!delivery.owner) continue;
    const requestId = delivery.command?.requestId ?? delivery.record.requestId;
    if (requestId !== null) push(ownerTexts, requestId, { at: delivery.at, text: delivery.readable ?? delivery.message.text });
  }
  for (const proposal of proposals) {
    if (!proposalInScope(scope, proposal) || proposal.requestId === null) continue;
    if (proposal.kind === "command" && proposal.source === "user" && proposal.status === "sent") {
      push(ownerTexts, proposal.requestId, { at: sentTimeOf(proposal), text: proposal.sentText ?? proposal.command });
    }
    if (proposal.kind === "decision" && proposal.sentText !== null && proposal.settledAt !== null) {
      push(ownerTexts, proposal.requestId, { at: timeOrNull(proposal.settledAt), text: proposal.sentText });
    }
  }
  return ownerTexts;
}

/** An owner's grant to one request (A-6): from `at` on, these effects. */
export interface RequestGrant {
  at: number;
  effects: ReadonlySet<Effect>;
}

/** A-6 only: what the owner granted each request, and the owner's words there. */
export interface OwnerGrants {
  /** Stored decisions, and commands on their authority. */
  grants: Map<string, RequestGrant[]>;
  /** The owner's own words in an answered decision. */
  words: Map<string, Array<{ at: number; text: string }>>;
}

export function grantsOf(deliveries: readonly Delivery[], stores: EvalStores): OwnerGrants {
  const grants = new Map<string, RequestGrant[]>();
  const words = new Map<string, Array<{ at: number; text: string }>>();
  for (const delivery of deliveries) {
    const { record, command } = delivery;
    // A command on a decision's authority, whose grant was used and covers what the command declares.
    const authorityId = decisionIdOfAuthority(command?.authority ?? null);
    const authority = authorityId === null ? undefined : stores.decisionById.get(authorityId);
    const requestOfCommand = command?.requestId ?? record.requestId;
    if (command !== null && authority?.grant != null && authority.grant.usedAt !== null && delivery.at !== null && requestOfCommand !== null) {
      const granted = authority.grant.effects;
      if (realEffects(command.effects).every((effect) => granted.includes(effect))) {
        push(grants, requestOfCommand, { at: delivery.at, effects: new Set(command.approved) });
      }
    }
  }
  // An answered decision's grant and words hold for its request.
  for (const decision of stores.decisions) {
    if (decision.status !== "answered" || decision.answer === null || decision.requestId === null) continue;
    const answeredAt = timeOrNull(decision.answer.at);
    if (answeredAt === null) continue;
    if (decision.answer.words !== null) push(words, decision.requestId, { at: answeredAt, text: decision.answer.words });
    // A Worker's question: the option the owner chose is the Worker's yes for its effects (autonomy design §A.11);
    // the Orchestrator's choice (`bm_decide`) is not the owner's. An Orchestrator's decision authorises through
    // the command sent on it (above).
    // A held request the owner allowed — in the Inbox or in Paseo's own prompt (`via: paseo`) — is their grant to its
    // request too (autonomy design §D.2, change-009 C6); a Deny grants nothing, and the policy's Allow is not the owner's.
    const kind = decisionKindOf(decision.id);
    if ((kind === "question" || kind === "held") && decision.grant !== null && decision.answer.by === "owner") {
      push(grants, decision.requestId, { at: answeredAt, effects: new Set(decision.grant.effects) });
    }
  }
  return { grants, words };
}

/**
 * A decision the Orchestrator put to the owner: a proposal-era `decision`, or
 * a stored `o:` decision (Phase 1). Its span is `at` → `settledAt`, open-ended
 * while it can still be answered.
 */
export interface AskedDecision {
  at: string;
  settledAt: string | null;
  open: boolean;
}

/** The decisions put to the owner in each request in scope, oldest first; one without a request, made in the window, is counted unknown. */
export function askedDecisionsOf(scope: EvalScope, stores: EvalStores, unknowns: EvalUnknowns): Map<string, AskedDecision[]> {
  const decisionsByRequest = new Map<string, AskedDecision[]>();
  for (const proposal of stores.proposals) {
    if (proposal.kind !== "decision") continue;
    if (proposal.requestId === null) {
      if (within(timeOrNull(proposal.at), scope.bounds)) unknowns.decisionsWithoutRequest += 1;
      continue;
    }
    if (proposalInScope(scope, proposal)) {
      push(decisionsByRequest, proposal.requestId, { at: proposal.at, settledAt: proposal.settledAt, open: proposal.status === "pending" });
    }
  }
  // The Orchestrator's stored decisions (`o:`, Phase 1), scoped as a proposal is.
  for (const decision of stores.decisions) {
    if (decisionKindOf(decision.id) !== "orchestrator") continue;
    if (decision.requestId === null) {
      if (within(timeOrNull(decision.askedAt), scope.bounds)) unknowns.decisionsWithoutRequest += 1;
      continue;
    }
    const inScope =
      scope.included.has(decision.requestId) || (!scope.byRequest.has(decision.requestId) && within(timeOrNull(decision.askedAt), scope.bounds));
    if (inScope) push(decisionsByRequest, decision.requestId, { at: decision.askedAt, settledAt: decision.settledAt, open: !isSettledStatus(decision.status) });
  }
  for (const list of decisionsByRequest.values()) list.sort((a, b) => compareText(a.at, b.at) || compareText(a.settledAt ?? "", b.settledAt ?? ""));
  return decisionsByRequest;
}

/** The shell evidence of each turn in scope, each command once (a reused turn id can put it in two records): A-5 (ii) and A-6. */
export function shellEvidenceOf(scopeRecords: readonly TraceRecord[]): Map<TraceRecord, Evidence[]> {
  const seenEvidence = new Set<string>();
  const shellByRecord = new Map<TraceRecord, Evidence[]>();
  for (const record of scopeRecords) {
    shellByRecord.set(
      record,
      record.evidence.filter((evidence) => {
        if (evidence.kind !== "shell") return false;
        const identity = `${evidence.agentId ?? record.agentId}\u0000${evidence.at ?? ""}\u0000${evidence.detail}`;
        if (seenEvidence.has(identity)) return false;
        seenEvidence.add(identity);
        return true;
      }),
    );
  }
  return shellByRecord;
}
