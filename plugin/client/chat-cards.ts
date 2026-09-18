/**
 * Chat cards for messages between the Manager, Workers and Reviewers
 * (delta 20260916-chat-cards).
 *
 * Paseo runs a timeline transformer on every chat item of every agent, and the
 * transformer cannot tell whose chat it is. So a card is made only for what is
 * unmistakably paseo-bm's: a message another agent sent that carries a
 * `BM-REPORT`, a `BM-REVIEW` or a request id, and an agent's own finished
 * message that carries a report or review block. Everything else is left to
 * Paseo. Who sent what is decided later, by the renderer, from `chat.peers`.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { z } from "zod";
import { looksLikeReport, parseReports, parseReviews, requestIdFromText } from "../shared/bm-report";
import { answersText, parseQuestions, type Pick, type Question } from "../shared/bm-questions";
import type { ChatPeer } from "../shared/contracts";
import type { Badge, GraphNode } from "./dashboard-model";
import { errorMessageOf } from "./launch-manager";

export const CHAT_CARD_KIND = "bm-message";
export const CHAT_CARD_VERSION = 1;

/** A question of a `BM-QUESTIONS` block (delta 20260918c-question-cards §4.4). */
export const questionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.object({ key: z.string(), text: z.string(), recommended: z.boolean() })),
});

export const chatCardSchema = z.object({
  type: z.enum(["report", "review", "message"]),
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
  const workerOf = (requestId: string | null) =>
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

/** Every question has an existing option, or the user's own non-blank words. */
export function formComplete(questions: readonly Question[], picks: Readonly<Picks>): boolean {
  return (
    questions.length > 0 &&
    questions.every((question) => {
      const pick = picks[question.id];
      if (pick === undefined) return false;
      return "key" in pick ? choosable(question) && question.options.some((option) => option.key === pick.key) : pick.other.trim() !== "";
    })
  );
}

/** `Q1 a, Q2 other`: what the card says it sent. */
export function answerSummary(questions: readonly Question[], picks: Readonly<Picks>): string {
  return questions
    .map((question) => {
      const pick = picks[question.id];
      return pick === undefined ? null : `${question.id} ${"key" in pick ? pick.key : "other"}`;
    })
    .filter((part) => part !== null)
    .join(", ");
}

export type AnswerTarget = { worker: ChatPeer } | { reason: string };

/**
 * The Worker the answers go to, or why they cannot go now. The Worker is the
 * one `partiesOf` finds — the only Worker of the report's request — never an
 * id read from the message. Only an `idle` or `error` Worker is sent to: a
 * message to a running one would replace the turn it is in.
 */
export function answerTarget(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): AnswerTarget {
  const { from } = partiesOf(card, owner, peers);
  const worker = from.id === null ? undefined : peers.find((peer) => peer.id === from.id && peer.role === "worker");
  if (worker === undefined) {
    return { reason: `Cannot tell which Worker asked this: no single Worker has \`${card.requestId ?? "this request"}\`.` };
  }
  const name = partyName({ role: "worker", id: worker.id, title: worker.title });
  if (worker.status === "idle" || worker.status === "error") return { worker };
  if (worker.status === "running" || worker.status === "initializing") {
    return { reason: `${name} is working; a message now would replace its turn. Send when it stops.` };
  }
  return { reason: `${name} is ${worker.status}.` };
}

export interface SendAnswersInput {
  card: ChatCard;
  picks: Readonly<Picks>;
  /** Fresh `chat.peers` for the chat: the cached one can be half a minute old. */
  refreshPeers: () => Promise<{ owner: ChatPeer | null; peers: ChatPeer[] }>;
  send: (agentId: string, text: string) => Promise<void>;
}

export type SendAnswersResult = { ok: true; to: ChatPeer; text: string } | { ok: false; reason: string };

/**
 * The whole send path of the question card, kept here so it is tested without
 * a renderer: re-read who is where and in what state, then send ONE
 * `BM-ANSWERS` message to the asking Worker. `send` is called at most once.
 */
export async function sendAnswers(input: SendAnswersInput): Promise<SendAnswersResult> {
  const { card, picks } = input;
  if (!formComplete(card.questions, picks)) return { ok: false, reason: "Answer every question first." };
  try {
    const fresh = await input.refreshPeers();
    const target = answerTarget(card, fresh.owner, fresh.peers);
    if ("reason" in target) return { ok: false, reason: target.reason };
    if (card.requestId === null) return { ok: false, reason: "This report names no request." };
    const text = answersText(card.requestId, card.questions, picks);
    await input.send(target.worker.id, text);
    return { ok: true, to: target.worker, text };
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
