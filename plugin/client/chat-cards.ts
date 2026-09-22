/**
 * Chat cards for messages between the Manager, Workers and Reviewers
 * (delta 20260916-chat-cards).
 *
 * Paseo runs a timeline transformer on every chat item of every agent, and the
 * transformer cannot tell whose chat it is. So a card is made only for what is
 * unmistakably paseo-bm's: a message another agent sent that carries a
 * `BM-REPORT`, a `BM-REVIEW` or a request id, an agent's own finished
 * message that carries a report or review block, and the plugin's own
 * `BM-FALLBACK` notice (delta 20260921 §4.4.6). Everything else is left to
 * Paseo. Who sent what is decided later, by the renderer, from `chat.peers`.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { z } from "zod";
import { looksLikeReport, parseReports, parseReviews, requestIdFromText } from "../shared/bm-report";
import { answersText, parseQuestions, type Pick, type Question } from "../shared/bm-questions";
import { checkBlocks, issueText } from "../shared/bm-format";
import { BM_FALLBACK_MARKER, parseFallbackNotice } from "../shared/bm-fallback";
import {
  FALLBACK_MAX_WAIT_MS,
  type BeadRow,
  type ChatPeer,
  type FallbackActInput,
  type FallbackIncident,
  type RoleModelOption,
  type WaitingWorker,
} from "../shared/contracts";
import { MODEL_PRICES, type ModelPrice } from "../shared/prices";
import { soleWorkerOf } from "../shared/sole-worker";
import type { Badge, GraphNode, Tone } from "./dashboard-model";
import { errorCodeOf, errorMessageOf } from "./launch-manager";
import { providerLabel } from "./setup-model";

export const CHAT_CARD_KIND = "bm-message";
export const CHAT_CARD_VERSION = 1;

/** A question of a `BM-QUESTIONS` block (delta 20260918c-question-cards §4.4). */
export const questionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string(), recommended: z.boolean() })),
});

/**
 * What a `BM-FALLBACK` card keeps of its notice (delta 20260921 §4.4.6): the
 * incident it is about, and what to show until `fallback.incidents` answers.
 * Never the incident's state — no status, candidate or reset time — so an old
 * notice cannot show a button that no longer applies.
 */
export const fallbackNoticeCardSchema = z.object({
  incident: z.string(),
  role: z.enum(["manager", "worker", "reviewer"]).nullable(),
  agent: z.string().nullable(),
  class: z.enum(["L1", "L2", "L4", "L5"]).nullable(),
  provider: z.string().nullable(),
  message: z.string().nullable(),
});

export type FallbackNoticeCard = z.infer<typeof fallbackNoticeCardSchema>;

export const chatCardSchema = z.object({
  type: z.enum(["report", "review", "message", "fallback"]),
  /** `received`: another agent sent it into this chat; `sent`: this chat's agent wrote it. */
  direction: z.enum(["received", "sent"]),
  requestId: z.string().nullable(),
  batchId: z.string().nullable(),
  phase: z.string().nullable(),
  tier: z.string().nullable(),
  verdict: z.string().nullable(),
  blocking: z.number().nullable(),
  blockers: z.string().nullable(),
  beads: z.object({ created: z.number(), updated: z.number(), closed: z.number() }),
  /** First meaningful line of a free-text message. */
  gist: z.string(),
  text: z.string(),
  /** The report's `BM-QUESTIONS`; empty for every other card and for old-style reports. */
  questions: z.array(questionSchema).default([]),
  /**
   * Where the message's BM-* blocks break their template (delta 20260918g
   * §4.8), one `<kind> <field>: <issue>` line each; empty when they follow it.
   */
  formatIssues: z.array(z.string()).default([]),
  /** The notice of a `fallback` card; null for every other card. */
  fallback: fallbackNoticeCardSchema.nullable().default(null),
});

export type ChatCard = z.infer<typeof chatCardSchema>;

const BARE_REQUEST_ID = /\breq-\d{8}T\d{6}Z\b/;
/** A `phase:` line listing the allowed values: the report format, not a report. */
const TEMPLATE_PHASE = /^\s*>?\s*phase\s*:[^\n]*\|/im;
const REVIEW_MARKER = /^\s*>?\s*(?:```\s*)?BM-REVIEW\b/m;
const BATCH_ID = /\bbatch(?:Id)?[`*\s]*[:=]?[`*\s]*([A-Za-z]?\d+[A-Za-z0-9._-]*)\b/i;

/** The item fields the transformer reads; Paseo's timeline items carry more. */
export interface ChatItem {
  type: string;
  text?: unknown;
  clientMessageId?: unknown;
}

function gistOf(text: string): string {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[#>*\s-]+/, "").replace(/[*`_]/g, "").trim();
    if (line !== "") return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
  return "";
}

/**
 * The card for a chat item, or undefined to leave the item to Paseo.
 * Never throws: a transformer error only costs a console line, but the item
 * would still be shown raw, so this simply declines instead.
 */
export function toChatCard(item: ChatItem, phase: "streaming" | "complete"): ChatCard | undefined {
  if (typeof item.text !== "string" || item.text.trim() === "") return undefined;
  const text = item.text;
  // The plugin's own notice. Paseo stores a `clientMessageId` on it like on
  // the user's words (`server/notices.ts`), so it is told apart by its first
  // line, as the plugin writes it, before that test.
  if (item.type === "user_message") {
    const card = fallbackCardOf(text);
    if (card !== undefined) return card;
  }
  let direction: ChatCard["direction"];
  if (item.type === "user_message") {
    // Typed by the user in Paseo's app: that is the user's own message.
    if (typeof item.clientMessageId === "string") return undefined;
    direction = "received";
  } else if (item.type === "assistant_message") {
    if (phase !== "complete") return undefined;
    direction = "sent";
  } else {
    return undefined;
  }

  const context = { agentId: "", at: "" };
  const isReport = looksLikeReport(text);
  const isReview = REVIEW_MARKER.test(text);
  const namesRequest = BARE_REQUEST_ID.test(text) || requestIdFromText(text) !== null;
  if (!isReport && !isReview && (direction === "sent" || !namesRequest)) return undefined;

  // A block that lists the allowed values ("phase: received | finished", "verdict:
  // approved | changes-required") is the format being explained, not a report:
  // Workers paste it into every review request.
  const report = isReport
    ? parseReports(text, context)
        .filter((block) =>
          block.requestId !== null && BARE_REQUEST_ID.test(block.requestId)
            ? true
            : block.phase !== null && !TEMPLATE_PHASE.test(text),
        )
        .at(-1)
    : undefined;
  const review = !isReport && isReview
    ? parseReviews(text, context)
        .filter((block) => block.verdict === null || !block.verdict.includes("|"))
        .at(-1)
    : undefined;
  if (report === undefined && review === undefined && (direction === "sent" || !namesRequest)) return undefined;
  const requestId = report?.requestId ?? requestIdFromText(text) ?? BARE_REQUEST_ID.exec(text)?.[0] ?? null;
  // A block naming another request is not this Worker's to be answered here.
  const asked = report === undefined ? null : parseQuestions(text);
  const questions = asked !== null && (asked.requestId === null || asked.requestId === requestId) ? asked.questions : [];
  // A received message is another agent's block, checked against its
  // template. Of this chat's own messages only a Reviewer's review is one: a
  // Worker quoting its report in its own chat has sent nothing.
  const formatIssues = checkBlocks(text)
    .filter((block) => direction === "received" || block.kind === "BM-REVIEW")
    .flatMap((block) => block.issues.map(issueText));
  return {
    type: report !== undefined ? "report" : review !== undefined ? "review" : "message",
    direction,
    requestId,
    batchId: review?.batchId ?? BATCH_ID.exec(text)?.[1] ?? null,
    phase: report?.phase ?? null,
    tier: report?.tier ?? null,
    verdict: review?.verdict ?? null,
    blocking: review?.blockingCount ?? null,
    blockers: report?.blockers ?? null,
    beads: {
      created: report?.beadsCreated.length ?? 0,
      updated: report?.beadsUpdated.length ?? 0,
      closed: report?.beadsClosed.length ?? 0,
    },
    gist: gistOf(text),
    text,
    questions,
    formatIssues,
    fallback: null,
  };
}

// ---------------------------------------------------------------------------
// Who sent it, who gets it.
// ---------------------------------------------------------------------------

export type ChatRole = "manager" | "worker" | "reviewer";

export interface Party {
  role: ChatRole | null;
  /** Null when the agent cannot be established. */
  id: string | null;
  title: string | null;
}

const ROLE_NAME: Record<ChatRole, string> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

function party(peer: ChatPeer | undefined, fallback: ChatRole | null): Party {
  if (peer === undefined) return { role: fallback, id: null, title: null };
  const role = peer.role === "unknown" ? fallback : peer.role;
  return { role, id: peer.id, title: peer.title };
}

/** Exactly one match, or nothing: a card never picks between candidates. */
function only<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/**
 * Sender and recipient of a card in the chat of `owner`. Returns roles even
 * when the agents are unknown, and ids only when exactly one agent fits.
 */
export function partiesOf(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): { from: Party; to: Party } {
  const ownerRole = owner === null || owner.role === "unknown" ? null : owner.role;
  const self = owner === null ? party(undefined, null) : party(owner, ownerRole);
  const byId = (id: string | null) => (id === null ? undefined : peers.find((peer) => peer.id === id));
  const ofRole = (role: ChatRole) => peers.filter((peer) => peer.role === role);
  // The one live Worker of the request (the rule `chat.waiting` uses too); an
  // old card of a Worker that has since been archived keeps its name
  // (delta 20260918f F12).
  const workerOf = (requestId: string | null) =>
    soleWorkerOf(peers, requestId) ??
    only(ofRole("worker").filter((peer) => requestId !== null && peer.requestId === requestId));
  const manager = () => {
    const parent = byId(owner?.parentId ?? null);
    return parent?.role === "manager" ? parent : only(ofRole("manager"));
  };
  const parentWorker = () => {
    const parent = byId(owner?.parentId ?? null);
    return parent?.role === "worker" ? parent : undefined;
  };

  if (card.direction === "sent") {
    const role = ownerRole ?? (card.type === "review" ? "reviewer" : card.type === "report" ? "worker" : null);
    const to =
      card.type === "review"
        ? party(parentWorker() ?? workerOf(card.requestId), "worker")
        : party(manager(), "manager");
    return { from: { ...self, role }, to };
  }

  if (card.type === "report") return { from: party(workerOf(card.requestId), "worker"), to: self };
  if (card.type === "review") {
    const reviewers = ofRole("reviewer").filter(
      (peer) => (card.requestId === null || peer.requestId === card.requestId) && (card.batchId === null || peer.batchId === card.batchId),
    );
    return { from: party(only(reviewers), "reviewer"), to: self };
  }
  switch (ownerRole) {
    case "worker":
      return { from: party(manager(), "manager"), to: self };
    case "reviewer":
      return { from: party(parentWorker(), "worker"), to: self };
    case "manager":
      return { from: party(workerOf(card.requestId), "worker"), to: self };
    default:
      return { from: party(undefined, null), to: self };
  }
}

export function partyName(p: Party): string {
  const role = p.role === null ? "Agent" : ROLE_NAME[p.role];
  if (p.title !== null && p.title.trim() !== "") return `${role} · ${p.title.trim()}`;
  return p.id === null ? `${role} (unknown)` : `${role} ${p.id.slice(0, 8)}`;
}

/**
 * Whether the renderer should draw the card at all. A chat that is not a
 * paseo-bm agent's, or a block the chat's agent only quoted (a Manager quoting
 * a review), is shown as plain text instead of pretending to be a card.
 */
export function drawAsCard(card: ChatCard, owner: ChatPeer | null): boolean {
  if (owner === null || owner.role === "unknown") return false;
  if (card.direction === "received") return true;
  return card.type === "review" ? owner.role === "reviewer" : owner.role === "worker";
}

/**
 * What a card says in the chat of an agent that carries no `bm.role` label —
 * started outside Beads Manager and recognised by its provider (delta
 * 20260918g §4.4, owner decision Q1 a) — or null for every other chat.
 */
export function ownerWarning(owner: ChatPeer | null): { chip: Badge; line: string } | null {
  if (owner === null || owner.labelled !== false) return null;
  return {
    chip: { text: "Not started by paseo-bm", tone: "warning" },
    line: "This agent has no bm.role label: it was started outside Beads Manager, and paseo-bm recognised it by its provider.",
  };
}

/** The graph node kind whose icon and colour a role uses (`ROLE_MARK`). */
export function markOf(role: ChatRole | null): GraphNode["kind"] | null {
  return role === "manager" ? "request" : role;
}

// ---------------------------------------------------------------------------
// What the card says.
// ---------------------------------------------------------------------------

export function statusChip(card: ChatCard): Badge | null {
  if (card.type === "report" && card.phase !== null) {
    const tone: Badge["tone"] = card.phase === "blocked" ? "warning" : card.phase === "finished" ? "success" : "info";
    return { text: card.phase, tone };
  }
  if (card.type === "review" && card.verdict !== null) {
    const verdict = card.verdict.toLowerCase();
    const tone: Badge["tone"] = /pass|approved/.test(verdict) ? "success" : /stopped/.test(verdict) ? "muted" : "warning";
    return { text: card.blocking ? `${card.verdict} · ${card.blocking} blocking` : card.verdict, tone };
  }
  return null;
}

/**
 * A `finished` report's card opens with its whole message showing, in every
 * chat that draws it: the Manager does not repeat the result, so it must be
 * readable without a tap (delta 20260918d §4.10, Q1 a of req-20260918T074311Z).
 */
export function startsOpen(card: ChatCard): boolean {
  return card.type === "report" && card.phase === "finished";
}

/**
 * The tone of the outline around the whole card, or null for the usual border:
 * only a `finished` report stands out (delta 20260918d §4.10, Q2 a of
 * req-20260918T074311Z — the one exception to "no coloured border", Q11).
 */
export function outlineTone(card: ChatCard): "success" | null {
  return card.type === "report" && card.phase === "finished" ? "success" : null;
}

/**
 * Longest `blockers` text on the summary line (delta 20260918c, Q50): the full
 * text is one tap away in the opened message, and repeating a 1000-character
 * paragraph above it made old-style reports hard to answer.
 */
export const SUMMARY_BLOCKERS_CHARS = 160;

function shortened(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** One line under the header. */
export function summaryOf(card: ChatCard): string {
  if (card.type === "report") {
    const beads = [
      card.beads.created > 0 ? `${card.beads.created} created` : null,
      card.beads.updated > 0 ? `${card.beads.updated} updated` : null,
      card.beads.closed > 0 ? `${card.beads.closed} closed` : null,
    ].filter((part) => part !== null);
    const count = card.questions.length;
    const blockers =
      count > 0
        ? `${count} ${count === 1 ? "question" : "questions"} waiting`
        : card.blockers === null || /^none\b/i.test(card.blockers)
          ? null
          : `waiting on: ${shortened(card.blockers, SUMMARY_BLOCKERS_CHARS)}`;
    return [card.tier, beads.length === 0 ? null : `beads ${beads.join(", ")}`, blockers].filter((part) => part !== null).join(" · ") || "report";
  }
  if (card.type === "review") return [card.batchId === null ? null : `batch ${card.batchId}`, card.gist].filter((part) => part !== null).join(" · ");
  return card.gist;
}

const BLOCK_START = /^\s*>?\s*(?:```\s*)?(BM-REPORT|BM-REVIEW|BM-QUESTIONS|BM-ANSWERS)\b/;
/** An option line of a `BM-QUESTIONS` block, nested under its question. */
const OPTION_LINE = /^>?\s*[-*]\s+(?:\(([a-z])\)|([a-z])\s*[:.)])\s*(.*)$/i;
const FENCE = /^\s*```\s*$/;
/** A top-level `key: value` line; indented lines belong to a list item above. */
const FIELD = /^>?\s?([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/;

/**
 * The message as Markdown. Report and review blocks are `key: value` lines,
 * which Markdown would run together into one paragraph, so each becomes a list
 * item with the key in bold. The fences around a block are dropped.
 */
export function markdownOf(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inBlock = false;
  lines.forEach((line, index) => {
    if (!inBlock && FENCE.test(line) && BLOCK_START.test(lines[index + 1] ?? "")) return;
    if (BLOCK_START.test(line)) {
      inBlock = true;
      out.push(`**${line.trim().replace(/^>?\s*(?:```\s*)?/, "")}**`);
      out.push("");
      return;
    }
    if (inBlock) {
      if (FENCE.test(line)) {
        inBlock = false;
        return;
      }
      const field = FIELD.exec(line);
      if (field !== null) {
        out.push(`- **${field[1]}**: ${field[2]}`);
        return;
      }
      const option = OPTION_LINE.exec(line);
      if (option !== null) {
        out.push(`  - **${option[1] ?? option[2]}**: ${option[3]}`);
        return;
      }
      if (line.trim() === "") inBlock = false;
    }
    out.push(line);
  });
  return out.join("\n");
}

/**
 * The Markdown of a message shown as plain text instead of a card (delta
 * 20260918g §4.8, owner decision Q3 a): laid out like the card's opened
 * message, one field per line and questions apart from their options, never
 * the raw text that Markdown runs together into one paragraph.
 */
export function fallbackMarkdown(card: { text: string }): string {
  return markdownOf(card.text);
}

/** The reply as sent: it names the request, so the agent knows what it answers. */
export function replyText(card: ChatCard, answer: string): string {
  const about = [card.requestId === null ? null : `\`${card.requestId}\``, card.batchId === null ? null : `batch ${card.batchId}`]
    .filter((part) => part !== null)
    .join(", ");
  const head = about === "" ? "Reply from the user:" : `Reply from the user about ${about}:`;
  return `${head}\n\n${answer.trim()}`;
}

/** Prefilled answers for a report that waits on the user. Never sent on their own. */
export function quickReplies(card: ChatCard): string[] {
  // "Continue as you proposed" is ambiguous next to questions with options.
  if (card.type !== "report" || card.phase !== "blocked" || card.questions.length > 0) return [];
  return ["Continue as you proposed.", "Stop here and send your finished report."];
}

export function roleName(role: ChatRole | null): string {
  return role === null ? "agent" : ROLE_NAME[role];
}

// ---------------------------------------------------------------------------
// Answering a Worker's questions from its card (delta 20260918c-question-cards §4.4).
// ---------------------------------------------------------------------------

/** The user's answer so far, by question id. */
export type Picks = Record<string, Pick>;

/** Only the Manager's chat answers a Worker's questions, and only in the report it received. */
export function showsQuestions(card: ChatCard, owner: ChatPeer | null): boolean {
  return card.type === "report" && card.direction === "received" && owner?.role === "manager" && card.questions.length > 0;
}

/** A question with fewer than two options can only be answered in the user's own words. */
export function choosable(question: Question): boolean {
  return question.options.length >= 2;
}

/** The part of a question before its first ` — `: shown in bold. */
export function topicOf(question: Question): { topic: string | null; rest: string } {
  const at = question.text.indexOf(" — ");
  return at <= 0 ? { topic: null, rest: question.text } : { topic: question.text.slice(0, at), rest: question.text.slice(at + 3) };
}

/**
 * A question as the card draws it (delta 20260918d §4.4): a bold heading
 * `Q6 · Storage`, then the question itself on its own line.
 */
export function questionHeading(question: Question): { heading: string; body: string } {
  const { topic, rest } = topicOf(question);
  return topic === null ? { heading: question.id, body: rest } : { heading: `${question.id} · ${topic}`, body: rest };
}

/** Fills the recommended option into every question still unanswered; never overwrites a pick. */
export function recommendedPicks(questions: readonly Question[], picks: Readonly<Picks>): Picks {
  const next: Picks = { ...picks };
  for (const question of questions) {
    if (next[question.id] !== undefined || !choosable(question)) continue;
    const recommended = question.options.find((option) => option.recommended);
    if (recommended !== undefined) next[question.id] = { key: recommended.key };
  }
  return next;
}

/**
 * A pick that answers its question: an existing option of a question with at
 * least two options, or the user's own non-blank words.
 */
export function isAnswered(question: Question, pick: Pick | undefined): boolean {
  if (pick === undefined) return false;
  if ("key" in pick) return choosable(question) && question.options.some((option) => option.key === pick.key);
  return pick.other.trim() !== "";
}

/**
 * The `BM-ANSWERS` block for the answered questions only, in question order;
 * "" when none is answered or the card names no request (delta 20260918d §4.1).
 * An unanswered question gets no line and stays open: the Worker asks again.
 */
export function answersDraft(card: ChatCard, picks: Readonly<Picks>): string {
  if (card.requestId === null) return "";
  const answered = card.questions.filter((question) => isAnswered(question, picks[question.id]));
  return answered.length === 0 ? "" : answersText(card.requestId, answered, picks);
}

const ANSWERS_HEAD = "BM-ANSWERS";
const ANSWERS_LINE = /^\s*(requestId|Q\d+)\s*:/;

/**
 * The Reply box `text` with its `BM-ANSWERS` block replaced by `block`, or
 * removed when `block` is "". The block always ends up at the very start; the
 * user's own words — above or below the old block — follow it, in order
 * (delta 20260918d §4.1, owner decision Q4).
 */
export function withAnswersBlock(text: string, block: string): string {
  const lines = text.split("\n");
  const head = lines.findIndex((line) => line.trim() === ANSWERS_HEAD);
  let rest = lines;
  if (head !== -1) {
    let end = head + 1;
    while (end < lines.length && ANSWERS_LINE.test(lines[end]!)) end += 1;
    while (end < lines.length && lines[end]!.trim() === "") end += 1;
    rest = [...lines.slice(0, head), ...lines.slice(end)];
  }
  let first = 0;
  while (first < rest.length && rest[first]!.trim() === "") first += 1;
  let last = rest.length;
  while (last > first && rest[last - 1]!.trim() === "") last -= 1;
  const words = rest.slice(first, last).join("\n");
  if (block === "") return words;
  return words === "" ? block : `${block}\n\n${words}`;
}

/** `Q1 a, Q2 other`: the answered questions, as the card says it sent them. */
export function answerSummary(questions: readonly Question[], picks: Readonly<Picks>): string {
  return questions
    .filter((question) => isAnswered(question, picks[question.id]))
    .map((question) => {
      const pick = picks[question.id]!;
      return `${question.id} ${"key" in pick ? pick.key : "other"}`;
    })
    .join(", ");
}

/**
 * What a sent Reply answered: the summary when the current answers block went
 * out whole in `text`, else null (the user deleted it, or picked nothing).
 */
export function sentSummary(card: ChatCard, picks: Readonly<Picks>, text: string): string | null {
  const draft = answersDraft(card, picks);
  return draft !== "" && text.includes(draft) ? answerSummary(card.questions, picks) : null;
}

// ---------------------------------------------------------------------------
// Is a question card answered? (delta 20260918d §4.9, batch b6)
// ---------------------------------------------------------------------------

/** The report of `card` is one `chat.waiting` still lists for this Manager's chat. */
export function stillWaiting(card: ChatCard, chatAgentId: string, waiting: readonly WaitingWorker[]): boolean {
  return waiting.some((entry) => entry.managerId === chatAgentId && entry.requestId === card.requestId && entry.text === card.text);
}

export type AnsweredHow = "sent" | "marked" | "moved-on";

/**
 * Why a question card counts as answered, or null: answers sent from a copy of
 * it in this session; the user's saved mark; or `chat.waiting` no longer
 * listing its report — the Worker is working, has reported since, or is gone
 * (owner decision Q17). `waiting` is null while it is unknown, and then
 * nothing is derived from it.
 */
export function answeredHow(input: {
  sent: boolean;
  marked: boolean;
  waiting: readonly WaitingWorker[] | null;
  stillWaitingNow: boolean;
}): AnsweredHow | null {
  if (input.sent) return "sent";
  if (input.marked) return "marked";
  if (input.waiting !== null && !input.stillWaitingNow) return "moved-on";
  return null;
}

// ---------------------------------------------------------------------------
// Related beads on a card (delta 20260918d §4.7, batch b4).
// ---------------------------------------------------------------------------

/** How many related-bead chips a card shows before folding the rest behind "…". */
export const BEAD_CHIPS_SHOWN = 2;

/** The items a card shows, and how many are folded behind the "…" chip. */
export function visibleBeads<T>(items: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || items.length <= BEAD_CHIPS_SHOWN) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, BEAD_CHIPS_SHOWN), hidden: items.length - BEAD_CHIPS_SHOWN };
}

/**
 * The chips of a card's related beads: the first two beads the store REALLY
 * has, and how many more it has (delta 20260918f F10). Folding must come after
 * the lookup: the candidates are only a shape test, so `BM-REPORT`,
 * `BM-QUESTIONS` or `local-first` come first and would take the two places.
 */
export function beadChipsView(found: readonly BeadRow[], expanded: boolean): { shown: BeadRow[]; hidden: number } {
  return visibleBeads(found, expanded);
}

/**
 * What a card offers for replying (delta 20260918d §4.7, owner decision Q14):
 * the Reply button, or — once a reply went out from this card — the small
 * "Answered" chip, which reopens the Reply box.
 */
export function replyControls(canReply: boolean, replied: boolean): { replyButton: boolean; answeredChip: boolean } {
  return { replyButton: canReply && !replied, answeredChip: canReply && replied };
}

// ---------------------------------------------------------------------------
// Replying from any card (delta 20260918d-card-replies §4.2).
// ---------------------------------------------------------------------------

export type ReplyTarget = { peer: ChatPeer } | { reason: string };

/**
 * The agent a card's Reply goes to, or why it cannot go now. The recipient is
 * the one `partiesOf` finds — the sender of a received card, the addressee of
 * a sent one — and must be in `peers`, because its status is read there.
 * Only an `idle` or `error` agent is sent to: a message to a running one would
 * replace the turn it is in and throw that work away.
 */
export function replyTarget(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): ReplyTarget {
  const { from, to } = partiesOf(card, owner, peers);
  const counterpart = card.direction === "received" ? from : to;
  const peer = counterpart.id === null ? undefined : peers.find((candidate) => candidate.id === counterpart.id);
  if (peer === undefined) {
    if (card.type === "report" && card.direction === "received") {
      return { reason: `Cannot tell which Worker asked this: no single Worker has \`${card.requestId ?? "this request"}\`.` };
    }
    return { reason: `Cannot tell which ${roleName(counterpart.role)} to send this to.` };
  }
  if (owner !== null && peer.id === owner.id) return { reason: "This is your own message." };
  const name = partyName({ role: counterpart.role, id: peer.id, title: peer.title });
  // Paseo brings an archived agent back when it gets a message (ADR-005).
  if (peer.archived) return { reason: `${name} is archived.` };
  if (peer.status === "idle" || peer.status === "error") return { peer };
  if (peer.status === "running" || peer.status === "initializing") {
    return { reason: `${name} is working; a message now would replace its turn. Send when it stops.` };
  }
  return { reason: `${name} is ${peer.status}.` };
}

export interface SendReplyInput {
  card: ChatCard;
  /** What is in the Reply box. */
  text: string;
  /** Fresh `chat.peers` for the chat: the cached one can be half a minute old. */
  refreshPeers: () => Promise<{ owner: ChatPeer | null; peers: ChatPeer[] }>;
  send: (agentId: string, text: string) => Promise<void>;
}

export type SendReplyResult = { ok: true; to: ChatPeer; text: string } | { ok: false; reason: string };

/**
 * The whole send path of a card's Reply box, kept here so it is tested without
 * a renderer: re-read who is where and in what state, then send ONE message.
 * `send` is called at most once.
 */
export async function sendReply(input: SendReplyInput): Promise<SendReplyResult> {
  const { card, text } = input;
  if (text.trim() === "") return { ok: false, reason: "Write a reply first." };
  try {
    const fresh = await input.refreshPeers();
    const target = replyTarget(card, fresh.owner, fresh.peers);
    if ("reason" in target) return { ok: false, reason: target.reason };
    const message = replyText(card, text);
    await input.send(target.peer.id, message);
    return { ok: true, to: target.peer, text: message };
  } catch (failure) {
    return { ok: false, reason: errorMessageOf(failure) };
  }
}

/** djb2: short and stable, enough to tell two reports of one request apart. */
function hashOf(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/** Key of the "already answered" memory: this chat, this request, these questions, this message. */
export function answeredKey(agentId: string, card: ChatCard): string {
  return [agentId, card.requestId ?? "", card.questions.map((question) => question.id).join(","), hashOf(card.text)].join("|");
}

// ---------------------------------------------------------------------------
// The fallback card (delta 20260921 §4.4.6, REQ-065 c).
//
// Built from the plugin's `BM-FALLBACK` notice, but everything that decides
// what the user may do — status, candidate, reset time — comes from
// `fallback.incidents`. The notice is only the incident's id and what to show
// until that answers.
// ---------------------------------------------------------------------------

/** First line of a text, trimmed. */
function firstLineOf(text: string): string {
  return (text.trimStart().split(/\r?\n/, 1)[0] ?? "").trim();
}

/** What a fallback card leaves empty: it carries no report or review block. */
const NO_BLOCK = { batchId: null, phase: null, tier: null, verdict: null, blocking: null, blockers: null } as const;

function stoppedTitle(role: ChatRole | null): string {
  return `${role === null ? "Agent" : ROLE_NAME[role]} stopped by its provider plan`;
}

/**
 * The card of a `BM-FALLBACK` notice, or undefined: the text must start with
 * the marker line, as the plugin writes it, and name a usable incident id.
 */
export function fallbackCardOf(text: string): ChatCard | undefined {
  if (firstLineOf(text) !== BM_FALLBACK_MARKER) return undefined;
  const notice = parseFallbackNotice(text);
  if (notice === null) return undefined;
  return {
    ...NO_BLOCK,
    type: "fallback",
    direction: "received",
    requestId: notice.requestId,
    beads: { created: 0, updated: 0, closed: 0 },
    questions: [],
    formatIssues: [],
    gist: stoppedTitle(notice.role),
    text,
    fallback: {
      incident: notice.incident,
      role: notice.role,
      agent: notice.agent,
      class: notice.class,
      provider: notice.provider,
      message: notice.message,
    },
  };
}

/** The failed agent's provider alias and model, as the card shows them. */
function failedProviderOf(incident: FallbackIncident): string {
  const alias = incident.agentProvider.split("/", 1)[0] ?? incident.agentProvider;
  return incident.agentModel === null ? alias : `${alias} · ${incident.agentModel}`;
}

/**
 * The card a waiting pill shows for an incident it counts: the pill reads
 * `chat.waiting`, not the timeline, so there is no notice text to build from.
 */
export function fallbackCardOfIncident(incident: FallbackIncident): ChatCard {
  return {
    ...NO_BLOCK,
    type: "fallback",
    direction: "received",
    requestId: incident.requestId,
    beads: { created: 0, updated: 0, closed: 0 },
    questions: [],
    formatIssues: [],
    gist: stoppedTitle(incident.role),
    text: "",
    fallback: {
      incident: incident.id,
      role: incident.role,
      agent: incident.agentId,
      class: incident.class,
      provider: failedProviderOf(incident),
      message: incident.message,
    },
  };
}

/** What `fallback.incidents` said about a card's incident. */
export type FallbackLookup =
  | { state: "loading" }
  | { state: "failed"; error: unknown }
  | { state: "missing" }
  | { state: "found"; incident: FallbackIncident };

export type FallbackAction = FallbackActInput["action"];

export interface FallbackButton {
  action: FallbackAction;
  label: string;
}

export interface FallbackCardView {
  role: ChatRole | null;
  title: string;
  requestId: string | null;
  /** The failure class, and the failed agent's provider and model. */
  summary: string;
  /** The provider's own words, verbatim. */
  message: string | null;
  /** The incident's status, once known. */
  chip: Badge | null;
  /** Only while the incident is `pending`. */
  buttons: FallbackButton[];
  /** Where there are no buttons: what became of the incident, or why nothing can be decided here. */
  statusLine: { text: string; tone: Tone } | null;
}

const CLASS_LABELS: Readonly<Record<FallbackIncident["class"], string>> = {
  L1: "Usage limit (L1)",
  L2: "Billing (L2)",
  L4: "Login (L4)",
  L5: "Provider unavailable (L5)",
};

const STATUS_TONES: Readonly<Record<FallbackIncident["status"], Tone>> = {
  pending: "warning",
  switched: "success",
  waiting: "info",
  resumed: "success",
  dismissed: "muted",
  exhausted: "danger",
  expired: "muted",
  failed: "danger",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `15:40`, `tomorrow 15:40`, `yesterday 15:40` or `Thu 24 Sep 15:40`, in the device's time zone. */
export function localTimeText(at: Date, now: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${time}`;
}

/**
 * The reset time "Wait" may wait for: a readable `resetsAt` at most
 * `FALLBACK_MAX_WAIT_MS` ahead — the rule `fallback.act` `wait` applies (§4.4.9).
 * A reset already past still counts: waiting then resumes the agent at once.
 */
export function waitDeadline(resetsAt: string | null, now: Date): Date | null {
  if (resetsAt === null) return null;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return null;
  return at.getTime() - now.getTime() <= FALLBACK_MAX_WAIT_MS ? at : null;
}

/** `bm-worker-fallback-1 · Codex · gpt-5.6-sol`. */
export function candidateText(candidate: NonNullable<FallbackIncident["candidate"]>): string {
  return `${candidate.alias} · ${providerLabel(candidate.baseProvider)} · ${candidate.model}`;
}

/** `~$5 / $25 per 1M tokens`, as Roles & models words a listed price. */
export function priceText(cost: ModelPrice): string {
  return `~$${cost.inputUsdPerMTok} / $${cost.outputUsdPerMTok} per 1M tokens`;
}

/**
 * The candidate's price, in the order the Dashboard uses (§4.2.7): the bundled
 * table, then the rate Paseo lists for the model (`roles.options` of its base
 * provider, `listed`), else none.
 */
export function candidateCost(
  candidate: FallbackIncident["candidate"],
  listed: readonly RoleModelOption[] | null | undefined,
): ModelPrice | null {
  if (candidate === null) return null;
  return MODEL_PRICES[candidate.model] ?? listed?.find((model) => model.id === candidate.model)?.cost ?? null;
}

/**
 * The base provider whose `roles.options` the card reads for the Switch
 * button's price, or null: only for a pending incident with a candidate the
 * bundled table has no price for.
 */
export function listedCostProvider(lookup: FallbackLookup): string | null {
  if (lookup.state !== "found" || lookup.incident.status !== "pending") return null;
  const candidate = lookup.incident.candidate;
  if (candidate === null || MODEL_PRICES[candidate.model] !== undefined) return null;
  return candidate.baseProvider;
}

/** The buttons of an incident: none unless it is `pending`, and "I'll handle it" always then. */
export function fallbackButtons(incident: FallbackIncident, now: Date, cost: ModelPrice | null): FallbackButton[] {
  if (incident.status !== "pending") return [];
  const buttons: FallbackButton[] = [];
  if (incident.candidate !== null) {
    buttons.push({
      action: "switch",
      label: `Switch to ${candidateText(incident.candidate)}${cost === null ? "" : ` · ${priceText(cost)}`}`,
    });
  }
  const deadline = waitDeadline(incident.resetsAt, now);
  if (deadline !== null) {
    const at = localTimeText(deadline, now);
    buttons.push({ action: "wait", label: deadline.getTime() > now.getTime() ? `Wait until ${at}` : `Resume now (the limit reset at ${at})` });
  }
  buttons.push({ action: "dismiss", label: "I'll handle it" });
  return buttons;
}

function timeOf(iso: string | null, now: Date): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : localTimeText(at, now);
}

/** One line for an incident that is no longer `pending`; null while it is. */
export function fallbackStatusLine(incident: FallbackIncident, now: Date): { text: string; tone: Tone } | null {
  const tone = STATUS_TONES[incident.status];
  const role = roleName(incident.role);
  switch (incident.status) {
    case "pending":
      return null;
    case "switched": {
      const to = incident.candidate === null ? "a fallback agent" : candidateText(incident.candidate);
      const agent = incident.replacementId === null ? "" : ` (agent ${incident.replacementId.slice(0, 8)})`;
      return { text: `Switched to ${to}${agent}.`, tone };
    }
    case "waiting": {
      const until = timeOf(incident.waitUntil ?? incident.resetsAt, now);
      return { text: until === null ? `Waiting for the usage reset; then the ${role} carries on.` : `Waiting until ${until}; then the ${role} carries on.`, tone };
    }
    case "resumed":
      return { text: `Resumed: the limit reset and the ${role} was asked to carry on.`, tone };
    case "dismissed":
      return { text: "Dismissed: you handle it.", tone };
    case "exhausted":
      return { text: "No fallback left to switch to.", tone };
    case "expired":
      return { text: `Expired: by the reset the ${role} was archived, running or already replaced.`, tone };
    case "failed":
      return { text: `Failed: ${incident.error ?? "unknown error"}`, tone };
  }
}

/** An RPC error with its registry code once, in front: `(<code>): <message>`. */
function codedReason(error: unknown): string {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  if (code === null) return `: ${message}`;
  const rest = message.replace(/^\s*E_[A-Z0-9_]+\s*:?\s*/, "");
  return rest === "" ? ` (${code})` : ` (${code}): ${rest}`;
}

/**
 * Everything a fallback card draws, from its notice and the incident as
 * `fallback.incidents` has it now. `cost` is the candidate's price, if known.
 */
export function fallbackCardView(card: ChatCard, lookup: FallbackLookup, now: Date, cost: ModelPrice | null): FallbackCardView {
  const notice = card.fallback;
  const incident = lookup.state === "found" ? lookup.incident : null;
  const role = incident?.role ?? notice?.role ?? null;
  const cls = incident?.class ?? notice?.class ?? null;
  const provider = incident === null ? (notice?.provider ?? null) : failedProviderOf(incident);
  const base = {
    role,
    title: stoppedTitle(role),
    requestId: incident === null ? card.requestId : incident.requestId,
    summary: [cls === null ? null : CLASS_LABELS[cls], provider].filter((part) => part !== null).join(" · "),
    message: incident === null ? (notice?.message ?? null) : incident.message.trim() || null,
  };
  switch (lookup.state) {
    case "loading":
      return { ...base, chip: null, buttons: [], statusLine: { text: "Checking the incident…", tone: "muted" } };
    case "failed":
      return { ...base, chip: null, buttons: [], statusLine: { text: `Could not read the incident${codedReason(lookup.error)}`, tone: "danger" } };
    case "missing":
      return { ...base, chip: null, buttons: [], statusLine: { text: "This incident is no longer recorded; there is nothing to decide here.", tone: "muted" } };
    case "found":
      return {
        ...base,
        chip: { text: lookup.incident.status, tone: STATUS_TONES[lookup.incident.status] },
        buttons: fallbackButtons(lookup.incident, now, cost),
        statusLine: fallbackStatusLine(lookup.incident, now),
      };
  }
}

/** The incident a `fallback.incidents` answer has for this card: `missing` when it has none. */
export function lookupOf(incidentId: string, incidents: readonly FallbackIncident[]): FallbackLookup {
  const incident = incidents.find((candidate) => candidate.id === incidentId);
  return incident === undefined ? { state: "missing" } : { state: "found", incident };
}

const ACTION_WORDS: Readonly<Record<FallbackAction, string>> = {
  switch: "switch to the fallback",
  wait: "wait for the reset",
  dismiss: "record that you handle it",
};

/** The error line of a failed button, with the registry code the server sent. */
export function fallbackActError(action: FallbackAction, error: unknown): string {
  return `Could not ${ACTION_WORDS[action]}${codedReason(error)}`;
}

export type FallbackActResult = { ok: true; incident: FallbackIncident } | { ok: false; reason: string };

/**
 * One button press: ONE `fallback.act` call. The incident it answers with is
 * the card's new state; a failure becomes the card's error line.
 */
export async function runFallbackAction(input: {
  incidentId: string;
  action: FallbackAction;
  act: (input: FallbackActInput) => Promise<{ incident: FallbackIncident }>;
}): Promise<FallbackActResult> {
  try {
    const { incident } = await input.act({ incidentId: input.incidentId, action: input.action });
    return { ok: true, incident };
  } catch (failure) {
    return { ok: false, reason: fallbackActError(input.action, failure) };
  }
}
