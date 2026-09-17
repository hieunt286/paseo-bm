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
import type { ChatPeer } from "../shared/contracts";
import type { Badge, GraphNode } from "./dashboard-model";

export const CHAT_CARD_KIND = "bm-message";
export const CHAT_CARD_VERSION = 1;

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

/** One line under the header. */
export function summaryOf(card: ChatCard): string {
  if (card.type === "report") {
    const beads = [
      card.beads.created > 0 ? `${card.beads.created} created` : null,
      card.beads.updated > 0 ? `${card.beads.updated} updated` : null,
      card.beads.closed > 0 ? `${card.beads.closed} closed` : null,
    ].filter((part) => part !== null);
    const blockers = card.blockers === null || /^none\b/i.test(card.blockers) ? null : `waiting on: ${card.blockers}`;
    return [card.tier, beads.length === 0 ? null : `beads ${beads.join(", ")}`, blockers].filter((part) => part !== null).join(" · ") || "report";
  }
  if (card.type === "review") return [card.batchId === null ? null : `batch ${card.batchId}`, card.gist].filter((part) => part !== null).join(" · ");
  return card.gist;
}

const BLOCK_START = /^\s*>?\s*(?:```\s*)?(BM-REPORT|BM-REVIEW)\b/;
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
  if (card.type !== "report" || card.phase !== "blocked") return [];
  return ["Continue as you proposed.", "Stop here and send your finished report."];
}

export function roleName(role: ChatRole | null): string {
  return role === null ? "agent" : ROLE_NAME[role];
}
