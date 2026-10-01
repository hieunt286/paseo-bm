/**
 * Materialisation (autonomy design §A.5 a–c, ADR-017): the typed blocks agents
 * write become stored decisions at the end of the turn that wrote them. Agents
 * keep writing `BM-QUESTIONS` and `BM-ANSWERS` with side-effect-free tools; the
 * plugin reads the recorded turn and acts on it here, on the collector's
 * `onRecorded` — the same trigger the question–answer ledger used.
 *
 * | Turn end of | Read from the turn's record | Does |
 * |---|---|---|
 * | a Manager | inbound (`sent`) messages that are not the owner's, holding `BM-QUESTIONS` | opens `q:<requestId>:<Qn>` when absent (a) |
 * | a Manager whose inbound messages include the owner's typed one | `BM-ANSWERS` blocks in its replies (`received`) | settles those decisions, `via: chat-manager` (b) |
 * | a Worker | the owner's typed messages holding `BM-ANSWERS` | settles the named decisions, `via: chat-worker` (c) |
 * | a Worker | any other owner text while its request has open questions | marks those asked before it `needs-confirmation` (c) |
 * | a Manager | inbound messages that are not the owner's, holding a `finished` `BM-REPORT` | expires that request's unsettled questions asked up to it (§A.3) |
 *
 * - **Origin.** A trace message's `origin` is `user` only when it was typed in
 *   the app (it carries `clientMessageId` and is not a plugin notice); a
 *   `BM-COMMAND` and every plugin notice are `agent` (`collector.ts`). A
 *   Manager's block never settles anything without the owner's typed message
 *   in the same turn.
 * - **Class.** An opened question keeps the riskier of the class the Worker
 *   proposed (`[class: …]`) and the classes its options' effects imply
 *   (autonomy design §B.1); with neither, `reversible-technical`.
 * - **Supersession.** A question tagged `[supersedes: Qn]`, or whose
 *   normalised text equals an unsettled question of the same request, replaces
 *   that one (`decision-store.ts` `open` supersedes it in the same write).
 * - **Predictions and reversals** (autonomy design §B.3). An opened question
 *   records its recommended option as `prediction.recommended`. A new
 *   question with the `subject` of an **answered** question of the same
 *   request reverses that answer (`re-asked`); re-asking one still unsettled
 *   is supersession only. A `br reopen` in the turn's evidence whose reason
 *   cites an answered decision (`q:…`, `o:…`, or a `Qn` of the request)
 *   reverses it (`reopened`); a reopen citing none is ordinary work (a review
 *   finding), not a reversal. A reversal is only recorded (ADR-025 decision
 *   4): no cell or level changes.
 * - **Precedents** (autonomy design §B.6). A question that opens on the
 *   subject of an active precedent is answered by it at once
 *   (`precedent-resolve.ts`), and goes to `onSettled` with the turn's other
 *   answers — except a subject a precedent already answered in the same
 *   request, which is the owner's. An owner's answer here that differs from a
 *   precedent on its subject supersedes it.
 * - **Delegation** (autonomy design §B.5). A question in a `delegate` cell is
 *   not answered here: the event bus asks the Orchestrator to decide it
 *   (`decision.opened`, `bm_decide`).
 * - **Round.** A block's questions share one round: the round of any of them
 *   already stored, else one more than the request's highest stored round.
 * - **Expiry.** A request's `finished` report means its Worker no longer
 *   waits: after the turn's opening and answers, each `q:` decision of that
 *   request still `open` or `needs-confirmation` and asked no later than the
 *   report becomes `expired`, in its own write re-checked on the stored
 *   decision, so an answer given meanwhile stands. So does the owner's open
 *   override (`r:`, autonomy design §B.7) of such a question: its corrected
 *   answer has no Worker left to reach. `o:` and `f:` decisions, and their
 *   overrides, are never expired here; a question asked after the report (the
 *   owner sent the Worker on) stays open.
 * - **Idempotent.** Paseo reuses turn ids, and a record may be read again:
 *   opening is keyed by id and answering a settled decision is refused, so
 *   neither changes anything the second time. A `needs-confirmation` mark is
 *   remembered by its owner message (agent, time, text) for this plugin run,
 *   so the same message never marks a question again after the owner said
 *   "Keep open".
 * - **Settlement.** The decisions this turn answered go to `onSettled`, the
 *   same hook shape as `decisions.answer` (`decision-rpc.ts`): the delivery of
 *   §A.6 consumes it. A no-op by default; a failing hook is logged. Then
 *   `afterTurn` sees every record: the answers' delivery (`decision-delivery.ts`)
 *   marks a queued block that reached a Worker `sent`, and re-delivers after a
 *   reload.
 *
 * The block readers (`readableOf`, `questionBlockOf`, `answerBlockOf`) came
 * from the question–answer ledger this store replaced (autonomy design §A.14).
 *
 * Texts come from the trace record, which the collector has already masked
 * (REQ-048b): nothing here reads, stores or prints an unmasked message.
 * Nothing here throws into an agent's turn end: a failure is one log line.
 */
import { dirname } from "node:path";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { parseAnswers, parseQuestions, type Answer, type Question } from "../shared/bm-questions";
import { parseReports } from "../shared/bm-report";
import type { TraceMessage, TraceRecord } from "../shared/contracts";
import {
  DECISION_ID_PATTERN,
  answerDecision,
  checkedClass,
  declaredEffects,
  decisionKindOf,
  deliveryKindOf,
  expireDecision,
  isAnswerable,
  markNeedsConfirmation,
  openingPrediction,
  questionDecisionId,
  recordReversal,
  type AnswerVia,
  type ChatVia,
  type Decision,
  type DecisionOption,
  type DecisionReversal,
} from "../shared/decisions";
import { parseCommandBlock } from "../shared/orchestrator-command";
import { BR_REOPEN } from "../shared/shell";
import { bmAgentsOf, type DashboardPaseo } from "./paseo-directory";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import type { OnDecisionsSettled } from "./decision-rpc";
import { isPluginNotice } from "./notices";
import { resolveAtOpen } from "./policy-resolve";
import { supersedePrecedentsBy } from "./precedent-resolve";
import type { TraceStoreLocation } from "./trace-store";
import { errorText } from "./rpc-kit";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

// ---------------------------------------------------------------------------
// Reading the blocks.
// ---------------------------------------------------------------------------

/** A `requestId:` line anywhere in a message (the report right above a block). */
export const REQUEST_LINE = /^\s*(?:[-*]\s+)?requestId\s*:\s*`?(req-\d{8}T\d{6}Z)`?/im;
/** The first request id a message names. */
export const ANY_REQUEST_ID = /\b(req-\d{8}T\d{6}Z)\b/;

/** What of a message the readers read. */
export interface ReadableMessage {
  text: string;
  /** The request a `BM-COMMAND` is about; null for any other message. */
  requestId: string | null;
  command: boolean;
}

/**
 * What of a message is read: its whole text; the body of a `BM-COMMAND` block
 * (Orchestrator design §6B.1 — the Orchestrator's or the owner's command, which
 * may embed a `BM-ANSWERS` block), with the block's `requestId` as the request
 * it is about; nothing of any other plugin notice.
 */
export function readableOf(text: string): ReadableMessage | null {
  const command = parseCommandBlock(text);
  if (command !== null) return { text: command.body, requestId: command.requestId, command: true };
  return isPluginNotice(text) ? null : { text, requestId: null, command: false };
}

/**
 * The `BM-QUESTIONS` block of one message with the request it belongs to, or
 * null. A block without its own `requestId` belongs to the report right above
 * it, then to the request of the `BM-COMMAND` it came in.
 */
export function questionBlockOf(text: string): { requestId: string; questions: Question[] } | null {
  const readable = readableOf(text);
  if (readable === null) return null;
  const set = parseQuestions(readable.text);
  if (set === null) return null;
  const requestId = set.requestId ?? REQUEST_LINE.exec(readable.text)?.[1] ?? readable.requestId;
  return requestId === null ? null : { requestId, questions: set.questions };
}

/**
 * The `BM-ANSWERS` block of one message with the request it belongs to, or
 * null. A block without its own `requestId` belongs to the request the
 * message names first ("Continue <requestId>." from the Manager, "Reply from
 * the user about `<requestId>`" from a card, the `requestId:` line of a
 * command), then to `fallbackRequestId`.
 */
export function answerBlockOf(
  text: string,
  fallbackRequestId: string | null = null,
): { requestId: string; answers: Answer[]; command: boolean } | null {
  const readable = readableOf(text);
  if (readable === null) return null;
  const set = parseAnswers(readable.text);
  if (set === null) return null;
  const requestId = set.requestId ?? ANY_REQUEST_ID.exec(readable.text)?.[1] ?? readable.requestId ?? fallbackRequestId;
  return requestId === null ? null : { requestId, answers: set.answers, command: readable.command };
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** A question's text for comparison: case, punctuation and spacing ignored. */
export function normalisedQuestion(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** `a — text`, `(a) text`, `a: text`, a bare `a`: the option letter an answer starts with. */
const OPTION_ANSWER = /^\(?([a-z])\)?(?:\s+[—–-](?:\s+|$)|\s*[:.)](?:\s+|$)|$)/i;
/** `other — words` from a card or `bm_answers`. */
const OTHER_ANSWER = /^other\b\s*(?:[—–:-]\s*)?/i;

/**
 * What one `BM-ANSWERS` line answers: the option it names when the decision
 * has that option, else the owner's own words (`other — …` without its prefix).
 * Null when nothing is left to record.
 */
export function answerInputOf(decision: Pick<Decision, "options">, text: string): { optionKey: string } | { words: string } | null {
  const trimmed = text.trim();
  const option = OPTION_ANSWER.exec(trimmed);
  const key = option?.[1]?.toLowerCase();
  if (key !== undefined && decision.options.some((entry) => entry.key === key)) return { optionKey: key };
  const other = OTHER_ANSWER.exec(trimmed);
  const words = (other === null ? trimmed : trimmed.slice(other[0].length)).trim();
  return words === "" ? null : { words };
}

function validIso(at: string, fallback: string): string {
  return Number.isNaN(Date.parse(at)) ? fallback : at;
}

/** `br` flags that take the next word as their value. */
const BR_VALUE_FLAGS = new Set(["--db", "--actor", "--lock-timeout"]);
/** A decision id a reason may cite: a Worker's question or an Orchestrator decision (§B.3). */
const CITED_DECISION_ID = /(?<![\w:])(q:[^\s:]+:Q\d{1,3}|o:[A-Za-z0-9-]{1,64})/g;
/** A bare question number (`Q2`), not one inside a `q:…:Q2` id. */
const CITED_QUESTION = /(?<![\w:])(Q\d{1,3})\b/g;
/** The bead a `br reopen` naming none reopens (the last touched): one reference for them all. */
export const LAST_TOUCHED_BEAD = "last-touched";

/**
 * The words of a shell command from its start up to the first separator
 * outside quotes (`;`, `&`, `|`, a newline): single quotes literal, double
 * quotes and a backslash escaping as a shell does. Enough to read a `br`
 * call's arguments; nothing is expanded.
 */
function wordsUntilSeparator(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) word += text[++i]!;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < text.length) {
      word += text[++i]!;
      inWord = true;
    } else if (";&|\n".includes(char)) {
      break;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * Every `br reopen` a shell command runs: the beads it names (none: the last
 * touched) and its `--reason` / `-r`, or null without one. Pure.
 */
export function reopensOf(command: string): Array<{ beads: string[]; reason: string | null }> {
  const out: Array<{ beads: string[]; reason: string | null }> = [];
  for (const match of command.matchAll(new RegExp(BR_REOPEN.source, "g"))) {
    const words = wordsUntilSeparator(command.slice(match.index + match[0].length));
    const beads: string[] = [];
    let reason: string | null = null;
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;
      if (word === "-r" || word === "--reason") reason = words[++i] ?? null;
      else if (word.startsWith("--reason=")) reason = word.slice("--reason=".length);
      else if (word.startsWith("-r") && !word.startsWith("--")) reason = word.slice(2);
      else if (BR_VALUE_FLAGS.has(word)) i += 1;
      else if (!word.startsWith("-") && word !== "") beads.push(word);
    }
    out.push({ beads, reason });
  }
  return out;
}

/**
 * The decisions a reopen's reason cites (§B.3, §B.9): each `q:…` or `o:…` id
 * it names, and each bare `Qn` as a question of the request ids it names —
 * of `requestId` when it names none. Pure; each id once, in order.
 */
export function citedDecisionIds(reason: string, requestId: string | null): string[] {
  const ids = new Set<string>();
  for (const match of reason.matchAll(CITED_DECISION_ID)) {
    if (DECISION_ID_PATTERN.test(match[1]!)) ids.add(match[1]!);
  }
  const named = [...reason.matchAll(new RegExp(ANY_REQUEST_ID.source, "g"))].map((match) => match[1]!);
  const requests = named.length > 0 ? [...new Set(named)] : requestId === null ? [] : [requestId];
  for (const match of reason.matchAll(CITED_QUESTION)) {
    for (const request of requests) ids.add(questionDecisionId(request, match[1]!));
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// The materialiser.
// ---------------------------------------------------------------------------

/** Finds the Worker that asked for a request; null when it is not known for certain. */
export type WorkerLookup = (input: { requestId: string; workspaceId: string; managerId: string }, paseo: unknown) => Promise<string | null>;

export interface MaterialiserDeps {
  /** The data folder (the parent of the trace store). */
  home: string;
  /** The SDK handle of the hook, for the Worker lookup and the settlement hook. */
  paseo?: unknown;
  now?: () => Date;
  log?: (message: string) => void;
  /** Called with the decisions this turn answered; a no-op by default. */
  onSettled?: OnDecisionsSettled;
  /** `workerOfRequest` by default. */
  workerOf?: WorkerLookup;
  /** Called with every record after it is materialised and settled (the answers' delivery, §A.6); a no-op by default. */
  afterTurn?: AfterTurn;
}

/** What runs after a recorded turn is materialised: the answers' delivery notes arrivals and resumes (§A.6). */
export type AfterTurn = (record: TraceRecord, context: { paseo: unknown }) => void | Promise<void>;

export interface MaterialiseOutcome {
  role: "manager" | "worker" | null;
  /** Decisions this turn opened. */
  opened: Decision[];
  /** Decisions a new one replaced in this turn. */
  superseded: Decision[];
  /** Decisions this turn answered (what went to `onSettled`). */
  answered: Decision[];
  /** Decisions this turn marked `needs-confirmation`. */
  marked: Decision[];
  /** Answered decisions this turn reversed (§B.3), as stored after the reversal. */
  reversed: Decision[];
  /** Worker questions a `finished` report in this turn expired (§A.3). */
  expired: Decision[];
}

/** Owner messages already acted on for a `needs-confirmation` mark, in this plugin run. */
const markedMessages = new Set<string>();
const MARKED_MESSAGES_LIMIT = 2000;

/** Test-only: forgets which owner messages already marked decisions. */
export function clearMaterialiserMemory(): void {
  markedMessages.clear();
}

function remember(key: string): void {
  markedMessages.add(key);
  if (markedMessages.size <= MARKED_MESSAGES_LIMIT) return;
  const oldest = markedMessages.values().next().value;
  if (oldest !== undefined) markedMessages.delete(oldest);
}

/**
 * The live Worker labelled with the request: among the Workers carrying
 * `bm.requestId = requestId` (not archived, not replaced), the one whose parent
 * is the Manager, else the only one of the workspace; null otherwise.
 */
export const workerOfRequest: WorkerLookup = async ({ requestId, workspaceId, managerId }, paseo) => {
  const agents = paseo as Partial<DashboardPaseo> | null | undefined;
  if (typeof agents?.agents?.list !== "function") return null;
  const all = await bmAgentsOf(paseo as DashboardPaseo);
  const workers = all.filter(
    ({ workspaceId: ws, facts }) =>
      facts.role === "worker" && facts.requestIdLabel === requestId && !facts.archived && (facts.replacedBy ?? null) === null && ws === workspaceId,
  );
  const children = workers.filter(({ facts }) => facts.parentAgentId === managerId);
  if (children.length === 1) return children[0]!.facts.id;
  return workers.length === 1 ? workers[0]!.facts.id : null;
};

interface Context {
  /** The data folder: the precedents are read from it (§B.6). */
  home: string;
  store: DecisionStore;
  record: TraceRecord;
  now: string;
  log: (message: string) => void;
  outcome: MaterialiseOutcome;
}

function questionsOfRequest(context: Context, requestId: string): Decision[] {
  return context.store
    .list({ workspaceId: context.record.workspaceId, requestId })
    .filter((decision) => decisionKindOf(decision.id) === "question");
}

/** The request's Worker questions and the owner's overrides of them (§B.7): what its `finished` report expires. */
function expirableOfRequest(context: Context, requestId: string): Decision[] {
  return context.store
    .list({ workspaceId: context.record.workspaceId, requestId })
    .filter((decision) => deliveryKindOf(decision) === "question");
}

/**
 * Records one reversal of `id` (§B.3) when it is answered, the reversal is not
 * earlier than the answer, and it is not recorded yet; writes nothing
 * otherwise.
 */
function reverse(context: Context, id: string, reversal: DecisionReversal): void {
  try {
    const decision = context.store.get(id, context.record.workspaceId);
    if (decision === null || decision.status !== "answered" || decision.answer === null) return;
    if (Date.parse(reversal.at) < Date.parse(decision.answer.at)) return;
    if ((decision.reversals ?? []).some((entry) => entry.kind === reversal.kind && entry.ref === reversal.ref)) return;
    const mutation = context.store.transition(id, (current) => recordReversal(current, reversal), context.record.workspaceId);
    if (mutation.status === "updated" && (mutation.decision.reversals?.length ?? 0) > (decision.reversals?.length ?? 0)) {
      context.outcome.reversed.push(mutation.decision);
    }
  } catch (error) {
    context.log(`[paseo-bm] could not record the reversal of decision ${id}: ${errorText(error)}`);
  }
}

/** Reversal kind (3): a `br reopen` in the turn's evidence whose reason cites an answered decision (§B.3, §B.9). */
function reverseReopened(context: Context): void {
  const { record } = context;
  for (const evidence of record.evidence) {
    if (evidence.kind !== "shell") continue;
    for (const reopen of reopensOf(evidence.detail)) {
      if (reopen.reason === null) continue;
      const cited = citedDecisionIds(reopen.reason, record.requestId);
      if (cited.length === 0) continue;
      const at = validIso(evidence.at ?? record.endedAt, context.now);
      const beads = reopen.beads.length === 0 ? [LAST_TOUCHED_BEAD] : reopen.beads;
      for (const id of cited) {
        for (const bead of beads) reverse(context, id, { kind: "reopened", at, ref: bead });
      }
    }
  }
}

function optionsOf(question: Question): DecisionOption[] {
  return question.options.map((option) => ({
    key: option.key,
    label: option.text.trim() === "" ? option.key : option.text,
    recommended: option.recommended,
    effects: option.effects ?? [],
  }));
}

/** Opens the questions of one `BM-QUESTIONS` block (§A.5 a). */
async function openBlock(
  context: Context,
  block: { requestId: string; questions: Question[] },
  message: TraceMessage,
  askedBy: () => Promise<string | null>,
): Promise<void> {
  const { store, record } = context;
  const existing = questionsOfRequest(context, block.requestId);
  const ids = new Set(existing.map((decision) => decision.id));
  const fresh = block.questions.filter((question) => !ids.has(questionDecisionId(block.requestId, question.id)));
  if (fresh.length === 0) return;

  const storedRound = existing.find((decision) => block.questions.some((question) => decision.id === questionDecisionId(block.requestId, question.id)))?.round;
  const round = storedRound ?? existing.reduce((highest, decision) => Math.max(highest, decision.round ?? 0), 0) + 1;
  const agentId = await askedBy();
  const askedAt = validIso(message.at, context.now);

  for (const question of fresh) {
    const id = questionDecisionId(block.requestId, question.id);
    // Read again for each: an earlier question of this block may have superseded one.
    const current = questionsOfRequest(context, block.requestId);
    const tagged = question.supersedes === undefined ? null : questionDecisionId(block.requestId, question.supersedes);
    const byTag = tagged !== null && current.some((decision) => decision.id === tagged) ? tagged : null;
    const text = normalisedQuestion(question.text);
    const byText =
      text === ""
        ? null
        : (current.find((decision) => decision.id !== id && (decision.status === "open" || decision.status === "needs-confirmation") && normalisedQuestion(decision.question) === text)?.id ?? null);
    const options = optionsOf(question);
    const decision: Decision = {
      id,
      workspaceId: record.workspaceId,
      requestId: block.requestId,
      askedBy: { role: "worker", agentId },
      askedAt,
      round,
      question: question.text.trim() === "" ? question.id : question.text,
      subject: question.subject ?? null,
      // The Worker's proposal, raised to what its options' effects imply (§B.1).
      class: checkedClass(question.class, declaredEffects({ options })),
      options,
      status: "open",
      settledAt: null,
      needsConfirmation: null,
      answer: null,
      grant: null,
      delivery: null,
      supersedes: byTag ?? byText,
      supersededBy: null,
      // The option the Worker recommends is the recommended predictor's prediction (§B.3).
      prediction: openingPrediction(options),
    };
    let created = false;
    try {
      const result = store.open(decision);
      created = result.created;
      if (result.created) {
        const answeredBefore = (by: readonly string[]) =>
          decision.subject !== null && current.some((earlier) => earlier.subject === decision.subject && by.includes(earlier.answer?.by ?? ""));
        const atOpen = resolveAtOpen(result.decision, {
          home: context.home,
          now: new Date(context.now),
          log: context.log,
          store,
          // §B.6: an active precedent on its subject answers it at once. Not a subject a precedent already
          // answered in this request: asked again, the same answer did not do, so the owner decides.
          skipPrecedent: answeredBefore(["precedent"]),
        });
        context.outcome.opened.push(atOpen.decision);
        if (atOpen.answered !== null) context.outcome.answered.push(atOpen.answered);
      }
      if (result.superseded !== null) context.outcome.superseded.push(result.superseded);
    } catch (error) {
      context.log(`[paseo-bm] could not open decision ${id}: ${errorText(error)}`);
    }
    // Reversal kind (1): asked again with the subject of an answered question of
    // this request. An unsettled one was superseded above, which is no reversal.
    if (!created || decision.subject === null) continue;
    for (const earlier of questionsOfRequest(context, block.requestId)) {
      if (earlier.id !== id && earlier.status === "answered" && earlier.subject === decision.subject) {
        reverse(context, earlier.id, { kind: "re-asked", at: askedAt, ref: id });
      }
    }
  }
}

/** Settles the decisions one `BM-ANSWERS` block names. */
function settleBlock(context: Context, block: { requestId: string; answers: Answer[] }, via: AnswerVia, at: string): void {
  for (const answer of block.answers) {
    const id = questionDecisionId(block.requestId, answer.id);
    try {
      const decision = context.store.get(id, context.record.workspaceId);
      if (decision === null) continue;
      const input = answerInputOf(decision, answer.text);
      if (input === null) continue;
      const mutation = context.store.transition(
        id,
        (current) => answerDecision(current, { via, at, ...("optionKey" in input ? { optionKey: input.optionKey } : { words: input.words }) }),
        context.record.workspaceId,
      );
      if (mutation.status === "updated") {
        context.outcome.answered.push(mutation.decision);
        // REQ-124 c: the owner's answer that differs from a standing precedent on its subject supersedes it.
        supersedePrecedentsBy(mutation.decision, { home: context.home, now: new Date(context.now), log: context.log });
      }
    } catch (error) {
      context.log(`[paseo-bm] could not settle decision ${id}: ${errorText(error)}`);
    }
  }
}

/**
 * Marks the open questions of a request `needs-confirmation`, once per owner
 * message. Only a question asked before the message: the owner's message that
 * started the turn in which the Worker asked cannot have answered it.
 */
function markOpen(context: Context, requestId: string, message: TraceMessage, via: ChatVia): void {
  const key = `${context.record.agentId}|${message.at}|${message.text}`;
  if (markedMessages.has(key)) return;
  const at = validIso(message.at, context.now);
  for (const decision of questionsOfRequest(context, requestId)) {
    if (decision.status !== "open" || !(Date.parse(decision.askedAt) < Date.parse(at))) continue;
    try {
      const mutation = context.store.transition(
        decision.id,
        (current) => markNeedsConfirmation(current, { via, at }),
        context.record.workspaceId,
      );
      if (mutation.status === "updated") context.outcome.marked.push(mutation.decision);
    } catch (error) {
      context.log(`[paseo-bm] could not mark decision ${decision.id}: ${errorText(error)}`);
    }
  }
  remember(key);
}

/** Every `BM-ANSWERS` block the agent wrote in the turn, each message alone, then the replies joined (a streamed block). */
function replyBlocks(record: TraceRecord): Array<{ requestId: string; answers: Answer[] }> {
  const texts = record.received.map((message) => message.text);
  if (texts.length > 1) texts.push(texts.join(""), texts.join("\n"));
  const seen = new Set<string>();
  const out: Array<{ requestId: string; answers: Answer[] }> = [];
  for (const text of texts) {
    const block = answerBlockOf(text, record.requestId);
    if (block === null || block.command) continue;
    const answers = block.answers.filter((answer) => !seen.has(`${block.requestId}|${answer.id}`));
    for (const answer of answers) seen.add(`${block.requestId}|${answer.id}`);
    if (answers.length > 0) out.push({ requestId: block.requestId, answers });
  }
  return out;
}

async function materialiseManager(context: Context, deps: MaterialiserDeps): Promise<void> {
  const { record } = context;
  const workers = new Map<string, Promise<string | null>>();
  const askedBy = (requestId: string) => () => {
    let found = workers.get(requestId);
    if (found === undefined) {
      found = (deps.workerOf ?? workerOfRequest)({ requestId, workspaceId: record.workspaceId, managerId: record.agentId }, deps.paseo).catch(
        (error: unknown) => {
          context.log(`[paseo-bm] could not find the Worker of ${requestId}: ${errorText(error)}`);
          return null;
        },
      );
      workers.set(requestId, found);
    }
    return found;
  };

  // (a) Questions reach the Manager from its Worker, never from the owner.
  for (const message of record.sent) {
    if (message.origin === "user") continue;
    const block = questionBlockOf(message.text);
    if (block !== null && block.questions.length > 0) await openBlock(context, block, message, askedBy(block.requestId));
  }

  // (b) The Manager's own block settles nothing unless the owner typed in this turn.
  const owner = record.sent.filter((message) => message.origin === "user");
  if (owner.length === 0) return;
  const at = validIso(owner.at(-1)!.at, context.now);
  for (const block of replyBlocks(record)) settleBlock(context, block, "chat-manager", at);
}

/**
 * The `finished` reports that reached the Manager in this turn — from its
 * Worker, never the owner's typed text or a plugin notice — each with the
 * request it names and the time of its message. A report naming no request is
 * left out.
 */
function finishedReportsOf(context: Context): Array<{ requestId: string; at: string }> {
  const out: Array<{ requestId: string; at: string }> = [];
  for (const message of context.record.sent) {
    if (message.origin === "user" || isPluginNotice(message.text)) continue;
    const at = validIso(message.at, context.now);
    for (const report of parseReports(message.text, { agentId: context.record.agentId, at })) {
      const requestId = ANY_REQUEST_ID.exec(report.requestId ?? "")?.[1];
      if (report.phase === "finished" && requestId !== undefined) out.push({ requestId, at });
    }
  }
  return out;
}

/**
 * Expiry (§A.3): a request's `finished` report expires its Worker questions,
 * and the owner's overrides of them (§B.7), still unsettled and asked no later
 * than the report — the Worker no longer
 * waits for them. Each goes in its own write, re-checked on the stored
 * decision, so an answer given meanwhile stands.
 */
function expireFinished(context: Context): void {
  for (const report of finishedReportsOf(context)) {
    const until = Date.parse(report.at);
    for (const decision of expirableOfRequest(context, report.requestId)) {
      if (!isAnswerable(decision) || !(Date.parse(decision.askedAt) <= until)) continue;
      try {
        const mutation = context.store.transition(decision.id, (current) => expireDecision(current, { at: report.at }), context.record.workspaceId);
        if (mutation.status === "updated") context.outcome.expired.push(mutation.decision);
      } catch (error) {
        context.log(`[paseo-bm] could not expire decision ${decision.id}: ${errorText(error)}`);
      }
    }
  }
  // A question opened and expired in this same turn is handed on as stored, so no event asks about it.
  if (context.outcome.expired.length === 0) return;
  const expired = new Map(context.outcome.expired.map((decision) => [decision.id, decision]));
  context.outcome.opened = context.outcome.opened.map((decision) => expired.get(decision.id) ?? decision);
}

function materialiseWorker(context: Context): void {
  const { record } = context;
  for (const message of record.sent) {
    if (message.origin !== "user" || message.text.trim() === "") continue;
    const block = answerBlockOf(message.text, record.requestId);
    if (block !== null && block.answers.length > 0) {
      settleBlock(context, block, "chat-worker", validIso(message.at, context.now));
      continue;
    }
    // (c) Other owner text may have answered the Worker's open questions: the owner confirms.
    const requestId = block?.requestId ?? record.requestId;
    if (requestId !== null) markOpen(context, requestId, message, "chat-worker");
  }
}

/**
 * Materialises one recorded turn (§A.5 a–c) and hands the decisions it
 * answered to `onSettled`. Never rejects.
 */
export async function materialiseTurn(record: TraceRecord, deps: MaterialiserDeps): Promise<MaterialiseOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const outcome: MaterialiseOutcome = { role: null, opened: [], superseded: [], answered: [], marked: [], reversed: [], expired: [] };
  try {
    if (record.role !== "manager" && record.role !== "worker") return outcome;
    outcome.role = record.role;
    const context: Context = {
      home: deps.home,
      store: createDecisionStore(deps.home, { log }),
      record,
      now: (deps.now ?? (() => new Date()))().toISOString(),
      log,
      outcome,
    };
    if (record.role === "manager") {
      await materialiseManager(context, deps);
      // After the turn's opening and answers: the owner's answer in the same turn stands.
      expireFinished(context);
    } else materialiseWorker(context);
    reverseReopened(context);
  } catch (error) {
    log(`[paseo-bm] reading the decisions of ${record?.agentId ?? "an agent"}'s turn failed: ${errorText(error)}`);
  }
  if (outcome.answered.length > 0 && deps.onSettled !== undefined) {
    try {
      await deps.onSettled(outcome.answered, { paseo: deps.paseo });
    } catch (error) {
      log(`[paseo-bm] ${outcome.answered.map((decision) => decision.id).join(", ")} answered, but the delivery failed: ${errorText(error)}`);
    }
  }
  if (deps.afterTurn !== undefined) {
    try {
      await deps.afterTurn(record, { paseo: deps.paseo });
    } catch (error) {
      log(`[paseo-bm] after ${record?.agentId ?? "an agent"}'s turn, the answers' delivery failed: ${errorText(error)}`);
    }
  }
  return outcome;
}

export interface DecisionMaterialiserOptions {
  now?: () => Date;
  log?: (message: string) => void;
  onSettled?: OnDecisionsSettled;
  workerOf?: WorkerLookup;
  afterTurn?: AfterTurn;
}

/**
 * The collector's `onRecorded` step: materialises the turn it just recorded,
 * in the data folder that holds the trace store. Never rejects.
 */
export function createDecisionMaterialiser(
  options: DecisionMaterialiserOptions = {},
): (event: TurnEndedEvent, input: { location: TraceStoreLocation; paseo: unknown; record?: TraceRecord }) => Promise<MaterialiseOutcome | null> {
  return async (_event, { location, paseo, record }) => {
    if (record === undefined) return null;
    return materialiseTurn(record, { home: dirname(location.tracesDir), paseo, ...options });
  };
}
