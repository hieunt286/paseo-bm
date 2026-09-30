/**
 * Chat cards v2 (autonomy design §A.12, experience concept §5).
 *
 * Paseo runs a timeline transformer on every chat item of every agent, and the
 * transformer cannot tell whose chat it is. So a card is made only for what is
 * unmistakably paseo-bm's, and every card has one grammar — actor → recipient ·
 * authority · time, one status chip, a title, at most three body lines, one
 * primary action, Details — drawn by `CardFrame` (`ui.tsx`):
 *
 * | Card | Made from |
 * |---|---|
 * | `decision` | a question of a `BM-QUESTIONS` block (`q:<requestId>:<Qn>`), a `BM-FALLBACK` notice (`f:<incidentId>`), a `BM-ANSWER` notice (its `decisionId:`) — drawn live from the decision store |
 * | `progress` | a `BM-REPORT` that is not `finished` and asks nothing |
 * | `finished` | a `finished` `BM-REPORT` |
 * | `verdict` | a `BM-REVIEW` |
 * | `brief` | another agent's message that names a request (a request brief, a review request) |
 * | `action` | a delivered `BM-COMMAND` (v2, v1 still read) |
 * | `notice` | every other plugin notice, and a Manager's copy of a Worker command: one compact line |
 *
 * There is no other question UI: no reply box, no answered chip, no "Mark as
 * answered", no "Use recommendations", no question rows. One question has one
 * card, answered through `decisions.answer` wherever it is drawn.
 *
 * Everything the cards say is decided here, tested without a renderer; ids
 * appear only in Details. Who sent what is decided later, by the renderer,
 * from `chat.peers`.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { z } from "zod";
import { looksLikeReport, parseReports, parseReviews, requestIdFromText } from "../shared/bm-report";
import { parseQuestions } from "../shared/bm-questions";
import { checkBlocks, issueText } from "../shared/bm-format";
import { BM_FALLBACK_MARKER, FALLBACK_CLASS_LABELS, parseFallbackNotice } from "../shared/bm-fallback";
import { ANSWER_NOTICE_MARKER, EVENTS_NOTICE_MARKER, noticeMarkerOf } from "../shared/notices";
import {
  COMMAND_FROM,
  COMMAND_INTENTS,
  COMMAND_TO,
  COMMAND_VIA,
  decisionIdOfAuthority,
  isCommandAuthority,
  parseCommandBlock,
  type CommandBlock,
} from "../shared/orchestrator-command";
import {
  ASKER_ROLES,
  DECISION_ID_PATTERN,
  declaredEffects,
  effectsOfAnswer,
  effectSchema,
  isAnswerable,
  needsOwnerConfirmation,
  questionDecisionId,
  realEffects,
  type AnswerVia,
  type ChatVia,
  type Decision,
  type Effect,
} from "../shared/decisions";
import { reportPhaseSchema, type BeadRow, type ChatPeer } from "../shared/contracts";
import { soleWorkerOf } from "../shared/sole-worker";
import type { Badge, RoleMarkKind, Tone } from "./dashboard-model";
import { errorCodeOf, errorMessageOf } from "./launch-manager";
import { ago } from "./orchestrator-model";
import type { SetupDialog } from "./setup-model";

export const CHAT_CARD_KIND = "bm-message";
export const CHAT_CARD_VERSION = 2;

export const CARD_TYPES = ["decision", "progress", "finished", "verdict", "brief", "action", "notice"] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Most body lines a card shows (experience concept §5.1). */
export const MAX_BODY_LINES = 3;

const toneSchema = z.enum(["muted", "plain", "info", "warning", "danger", "success"]);

/** What a report card keeps of its `BM-REPORT`. */
export const reportFactsSchema = z.object({
  phase: reportPhaseSchema.nullable(),
  tier: z.string().nullable(),
  blockers: z.string().nullable(),
  beads: z.object({ created: z.number().int(), updated: z.number().int(), closed: z.number().int() }),
  filesChanged: z.number().int(),
  checks: z.string().nullable(),
  /** Choices the Worker made on its own (`decided`). */
  decided: z.number().int(),
});

/** What a verdict card keeps of its `BM-REVIEW`. */
export const reviewFactsSchema = z.object({
  batchId: z.string().nullable(),
  verdict: z.string().nullable(),
  blocking: z.number().int().nullable(),
});

/**
 * The decision a card stands for, and what to show until `decisions.get`
 * answers. Never the decision's state: status, answer and delivery come only
 * from the store, so an old message never shows a button that no longer
 * applies.
 */
export const decisionSeedSchema = z.object({
  id: z.string().regex(DECISION_ID_PATTERN),
  asker: z.enum(ASKER_ROLES),
  /** `Q<n>` of a Worker question; null for the other askers. */
  questionId: z.string().nullable(),
  question: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string(), recommended: z.boolean() })),
});
export type DecisionSeed = z.infer<typeof decisionSeedSchema>;

/** A `BM-COMMAND` block as its action card keeps it (`parseCommandBlock`'s result). */
export const commandCardSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  from: z.enum(COMMAND_FROM),
  via: z.enum(COMMAND_VIA),
  to: z.enum(COMMAND_TO),
  copy: z.boolean(),
  requestId: z.string().nullable(),
  re: z.string(),
  intent: z.enum(COMMAND_INTENTS).nullable(),
  effects: z.array(effectSchema),
  authority: z.custom<CommandBlock["authority"]>((value) => value === null || isCommandAuthority(value)),
  approved: z.array(effectSchema),
  limits: z.array(z.string()),
  body: z.string(),
  why: z.string().nullable(),
});

/** What a notice's compact line says. */
export const noticeFactsSchema = z.object({
  /** The notice's marker (`BM-FORMAT`, `BM-EVENTS`, …; `STOP` for the Reviewer's stop notice; `BM-COMMAND` for a copy). */
  marker: z.string(),
  /** What happened, in plain words. */
  what: z.string(),
  tone: toneSchema,
  /** The project the notice is about, by name; null when it names none. */
  project: z.string().nullable(),
});

export const chatCardSchema = z.object({
  type: z.enum(CARD_TYPES),
  /** `received`: another agent or the plugin sent it into this chat; `sent`: this chat's agent wrote it. */
  direction: z.enum(["received", "sent"]),
  requestId: z.string().nullable(),
  /** First meaningful line of the message, outside its blocks; "" when it has none. */
  gist: z.string(),
  /** The whole message: Details only. */
  text: z.string(),
  /** Where the message's BM-* blocks break their template, one `<kind> <field>: <issue>` line each. */
  formatIssues: z.array(z.string()),
  report: reportFactsSchema.nullable(),
  review: reviewFactsSchema.nullable(),
  decision: decisionSeedSchema.nullable(),
  command: commandCardSchema.nullable(),
  notice: noticeFactsSchema.nullable(),
});

export type ChatCard = z.infer<typeof chatCardSchema>;
export type ReportFacts = z.infer<typeof reportFactsSchema>;
export type NoticeFacts = z.infer<typeof noticeFactsSchema>;

const BARE_REQUEST_ID = /\breq-\d{8}T\d{6}Z\b/;
/** A `phase:` line listing the allowed values: the report format, not a report. */
const TEMPLATE_PHASE = /^\s*>?\s*phase\s*:[^\n]*\|/im;
const REVIEW_MARKER = /^\s*>?\s*(?:```\s*)?BM-REVIEW\b/m;
const BATCH_ID = /\bbatch(?:Id)?[`*\s]*[:=]?[`*\s]*([A-Za-z]?\d+[A-Za-z0-9._-]*)\b/i;
/** A line that starts one of paseo-bm's blocks. */
const BLOCK_LINE = /^\s*>?\s*(?:```\s*)?(?:\*\*)?BM-[A-Z]+\b/;

/** The item fields the transformer reads; Paseo's timeline items carry more. */
export interface ChatItem {
  type: string;
  text?: unknown;
  clientMessageId?: unknown;
}

function cleanLine(raw: string): string {
  return raw.replace(/^[#>*\s-]+/, "").replace(/[*`_]/g, "").trim();
}

function capped(line: string, limit = 160): string {
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** The meaningful lines of a text, cleaned of Markdown marks; `untilBlock` stops at the first block. */
function meaningfulLines(text: string, untilBlock: boolean): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (BLOCK_LINE.test(raw)) {
      if (untilBlock) break;
      continue;
    }
    if (/^\s*```/.test(raw) || /^\s*-{3,}\s*$/.test(raw)) continue;
    const line = cleanLine(raw);
    if (line !== "") out.push(capped(line));
  }
  return out;
}

function gistOf(text: string, untilBlock = false): string {
  return meaningfulLines(text, untilBlock)[0] ?? "";
}

function shortened(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

function firstLineOf(text: string): string {
  return (text.trimStart().split(/\r?\n/, 1)[0] ?? "").trim();
}

/** What every card starts from: no block facts. */
function base(type: CardType, direction: ChatCard["direction"], text: string, requestId: string | null): ChatCard {
  return { type, direction, requestId, gist: "", text, formatIssues: [], report: null, review: null, decision: null, command: null, notice: null };
}

/**
 * The cards for a chat item, or undefined to leave the item to Paseo. A
 * Worker's report that asks questions is one decision card per question.
 * Never throws: a transformer error only costs a console line, but the item
 * would still be shown raw, so this simply declines instead.
 */
export function toChatCards(item: ChatItem, phase: "streaming" | "complete"): ChatCard[] | undefined {
  if (typeof item.text !== "string" || item.text.trim() === "") return undefined;
  const text = item.text;
  // The plugin's own notice. Paseo stores a `clientMessageId` on it like on
  // the user's words (`server/notices.ts`), so it is told apart by its first
  // line, as the plugin writes it, before that test.
  if (item.type === "user_message") {
    const own = pluginCardOf(text);
    if (own !== undefined) return [own];
  }
  let direction: ChatCard["direction"];
  if (item.type === "user_message") {
    // Typed by the user in Paseo's app: the user's own words, left to Paseo.
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
          block.requestId !== null && BARE_REQUEST_ID.test(block.requestId) ? true : block.phase !== null && !TEMPLATE_PHASE.test(text),
        )
        .at(-1)
    : undefined;
  const review =
    !isReport && isReview ? parseReviews(text, context).filter((block) => block.verdict === null || !block.verdict.includes("|")).at(-1) : undefined;
  if (report === undefined && review === undefined && (direction === "sent" || !namesRequest)) return undefined;
  const requestId = report?.requestId ?? requestIdFromText(text) ?? BARE_REQUEST_ID.exec(text)?.[0] ?? null;
  // A received message is another agent's block, checked against its
  // template. Of this chat's own messages only a Reviewer's review is one: a
  // Worker quoting its report in its own chat has sent nothing.
  const formatIssues = checkBlocks(text)
    .filter((block) => direction === "received" || block.kind === "BM-REVIEW")
    .flatMap((block) => block.issues.map(issueText));

  if (report !== undefined) {
    const facts: ReportFacts = {
      phase: report.phase,
      tier: report.tier,
      blockers: report.blockers,
      beads: { created: report.beadsCreated.length, updated: report.beadsUpdated.length, closed: report.beadsClosed.length },
      filesChanged: report.filesChanged.length,
      checks: report.buildAndTests,
      decided: report.decided?.length ?? 0,
    };
    const reportCard: ChatCard = {
      ...base(report.phase === "finished" ? "finished" : "progress", direction, text, requestId),
      gist: gistOf(text, true),
      formatIssues,
      report: facts,
    };
    // A block naming another request is not this Worker's to be answered here;
    // a question without a request has no decision id.
    const asked = parseQuestions(text);
    const questions = asked !== null && requestId !== null && (asked.requestId === null || asked.requestId === requestId) ? asked.questions : [];
    const decisions = questions.map(
      (question): ChatCard => ({
        ...base("decision", direction, text, requestId),
        gist: question.text,
        formatIssues,
        decision: {
          id: questionDecisionId(requestId!, question.id),
          asker: "worker",
          questionId: question.id,
          question: question.text,
          options: question.options.map((option) => ({ key: option.key, label: option.text, recommended: option.recommended })),
        },
      }),
    );
    if (decisions.length === 0) return [reportCard];
    return report.phase === "finished" ? [reportCard, ...decisions] : decisions;
  }
  if (review !== undefined) {
    return [
      {
        ...base("verdict", direction, text, requestId),
        gist: gistOf(text, true),
        formatIssues,
        review: { batchId: review.batchId ?? BATCH_ID.exec(text)?.[1] ?? null, verdict: review.verdict, blocking: review.blockingCount },
      },
    ];
  }
  return [{ ...base("brief", direction, text, requestId), gist: gistOf(text), formatIssues }];
}

// ---------------------------------------------------------------------------
// The plugin's own messages.
// ---------------------------------------------------------------------------

/**
 * The card of a message the plugin wrote, or undefined for anything else: a
 * command is an action card (a Manager's copy a notice line), the owner's
 * answer to a decision and a fallback incident are that decision's card, and
 * every other notice is one compact line. A block that does not parse is
 * still the plugin's: it becomes a notice line, never the user's words.
 */
function pluginCardOf(text: string): ChatCard | undefined {
  const command = parseCommandBlock(text);
  if (command !== null) {
    if (command.copy) {
      const to = command.to === "manager" ? "the Manager" : "the Worker";
      return noticeCard(text, command.requestId, { marker: "BM-COMMAND", what: `Copy of a command to ${to}: ${command.re}`, tone: "muted", project: null }, "");
    }
    return { ...base("action", "received", text, command.requestId), gist: command.re, command };
  }
  const marker = noticeMarkerOf(text);
  if (marker === null) return undefined;
  if (marker === ANSWER_NOTICE_MARKER) {
    const answered = answerNoticeDecisionOf(text);
    if (answered !== null) return answered;
  }
  if (marker === BM_FALLBACK_MARKER && firstLineOf(text) === BM_FALLBACK_MARKER) {
    const fallback = fallbackDecisionCardOf(text);
    if (fallback !== null) return fallback;
  }
  return noticeCardOf(text, marker);
}

const LINE_OF = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m");

/** The decision card of a `BM-ANSWER` notice (autonomy design §A.6), or null when it names no decision. */
function answerNoticeDecisionOf(text: string): ChatCard | null {
  const id = LINE_OF("decisionId").exec(text)?.[1]?.trim() ?? "";
  if (!DECISION_ID_PATTERN.test(id)) return null;
  const requestText = LINE_OF("requestId").exec(text)?.[1]?.trim() ?? "none";
  const question = LINE_OF("question").exec(text)?.[1]?.trim() ?? "";
  const kind = id.startsWith("q:") ? "worker" : id.startsWith("o:") ? "orchestrator" : "plugin";
  return {
    ...base("decision", "received", text, requestText === "none" || requestText === "" ? null : requestText),
    gist: question,
    decision: { id, asker: kind, questionId: kind === "worker" ? (id.split(":").at(-1) ?? null) : null, question: question || "The owner's answer", options: [] },
  };
}

function stoppedTitle(role: ChatRole | null): string {
  return `${role === null ? "An agent" : `The ${ROLE_NAME[role]}`} was stopped by its provider plan`;
}

/** The decision card `f:<incidentId>` of a `BM-FALLBACK` notice (§A.5 d), or null when it names no usable incident. */
function fallbackDecisionCardOf(text: string): ChatCard | null {
  const notice = parseFallbackNotice(text);
  if (notice === null) return null;
  const decision = fallbackDecisionSeed(notice.incident, notice.role);
  if (decision === null) return null;
  const cls = notice.class === null ? null : FALLBACK_CLASS_LABELS[notice.class];
  return { ...base("decision", "received", text, notice.requestId), gist: [cls, notice.message].filter((part) => part !== null).join(" · "), decision };
}

/** The seed of a fallback incident's decision, or null for an id no decision can have. */
export function fallbackDecisionSeed(incidentId: string, role: ChatRole | null): DecisionSeed | null {
  const id = `f:${incidentId}`;
  if (!DECISION_ID_PATTERN.test(id)) return null;
  return { id, asker: "plugin", questionId: null, question: stoppedTitle(role), options: [] };
}

/** A decision card for a seed alone: what the Inbox draws for a stored decision. */
export function decisionCardOf(seed: DecisionSeed, requestId: string | null, text = ""): ChatCard {
  return { ...base("decision", "received", text, requestId), gist: seed.question, decision: seed };
}

function noticeCard(text: string, requestId: string | null, notice: NoticeFacts, gist: string): ChatCard {
  return { ...base("notice", "received", text, requestId), gist, notice };
}

const NOTICE_WORDS: Readonly<Record<string, string>> = {
  "BM-FORMAT": "A block broke its template",
  "BM-BUDGET": "Review budget",
  "BM-TOOLS": "A Worker has no Paseo tools",
  "BM-SETTINGS": "The start settings changed",
  "BM-FALLBACK": "An agent was stopped by its provider plan",
  "BM-RESUME": "Asked to carry on after the usage reset",
  [ANSWER_NOTICE_MARKER]: "The owner's answer",
  "BM-STOP": "Asked to stop",
  STOP: "Asked to stop",
  "BM-COMMAND": "A command",
};

const NOTICE_TONES: Readonly<Record<string, Tone>> = {
  "BM-FORMAT": "warning",
  "BM-TOOLS": "warning",
  "BM-FALLBACK": "warning",
  "BM-STOP": "warning",
  STOP: "warning",
};

/** A plugin notice as one compact line. */
function noticeCardOf(text: string, marker: string): ChatCard {
  const [head = "", ...rest] = text.split("\n");
  if (marker === EVENTS_NOTICE_MARKER) return noticeCard(text, null, { marker, ...eventsNoticeOf(text), project: null }, "");
  const requestId = BARE_REQUEST_ID.exec(head)?.[0] ?? null;
  // The first line is the marker and the request; the gist is what follows.
  const gist = gistOf(marker === "STOP" ? text : [head.slice(marker.length).replace(/\brequestId:\s*\S+/, ""), ...rest].join("\n"));
  return noticeCard(text, requestId, { marker, what: NOTICE_WORDS[marker] ?? marker, tone: NOTICE_TONES[marker] ?? "muted", project: null }, gist);
}

// ---------------------------------------------------------------------------
// The Orchestrator's batched events (`BM-EVENTS`, autonomy design §A.8): one
// compact line that says what happened; the lines with their ids in Details.
// ---------------------------------------------------------------------------

export interface EventFacts {
  /** `decision.opened`, `request.finished`, `request.stalled`, `worker.signal`, or one this client does not know. */
  type: string;
  /** The stall reason or the Worker signal; null for the others. */
  detail: string | null;
}

/** One event line of a `BM-EVENTS` message: `- <type>[ <detail>] — …`. */
const EVENT_LINE = /^-\s+([a-z][a-z.-]*)(?:[ \t]+([a-z][a-z-]*))?[ \t]+—/;

/** The events of a `BM-EVENTS` message, in its order. */
export function eventsOf(text: string): EventFacts[] {
  const events: EventFacts[] = [];
  for (const line of text.split("\n").slice(1)) {
    const match = EVENT_LINE.exec(line.trim());
    if (match !== null) events.push({ type: match[1]!, detail: match[2] ?? null });
  }
  return events;
}

const SIGNAL_WORDS: Readonly<Record<string, string>> = {
  stuck: "a Worker looks stuck",
  permission: "a Worker waits for a permission",
  danger: "a Worker ran a risky command",
  failing: "a Worker's command keeps failing",
  heavy: "a Worker uses heavy process for small work",
  outside: "a Worker edited outside the project",
};

/** What happened, in plain words. A type or signal this client does not know shows as written. */
export function eventWhat(event: EventFacts): string {
  switch (event.type) {
    case "decision.opened":
      return "a decision was opened";
    case "request.finished":
      return "a request finished";
    case "request.stalled":
      return event.detail === "review-over-budget" ? "a review went over its budget" : "a request stalled";
    case "worker.signal":
      return event.detail === null ? "a Worker needs a look" : (SIGNAL_WORDS[event.detail] ?? `a Worker signal: ${event.detail}`);
    default:
      return `event: ${event.type}`;
  }
}

const TONE_RANK: readonly Tone[] = ["danger", "warning", "info", "success", "muted", "plain"];

/** The colour of one event: a risky command is danger, a stall or a signal warns, a finish succeeds. */
export function eventTone(event: EventFacts): Tone {
  switch (event.type) {
    case "request.finished":
      return "success";
    case "decision.opened":
      return "info";
    case "request.stalled":
      return "warning";
    case "worker.signal":
      return event.detail === "danger" ? "danger" : "warning";
    default:
      return "muted";
  }
}

/** The compact line of a `BM-EVENTS` message: `3 events: a request finished, a decision was opened`, in the most urgent event's colour. */
export function eventsNoticeOf(text: string): { what: string; tone: Tone } {
  const events = eventsOf(text);
  if (events.length === 0) return { what: "Events for the Orchestrator", tone: "muted" };
  const words = [...new Set(events.map(eventWhat))];
  const tones = events.map(eventTone);
  const tone = TONE_RANK.find((candidate) => tones.includes(candidate)) ?? "muted";
  return { what: `${events.length} ${events.length === 1 ? "event" : "events"}: ${words.join(", ")}`, tone };
}

/** The dot that opens a compact line. */
export const NOTICE_DOT = "●";

/** A notice's compact line after its dot: `<project> · <what happened> — <gist> · <time ago>`; unknown parts are left out. */
export function noticeLine(card: ChatCard, at: Date, now: Date): string {
  const notice = card.notice;
  if (notice === null) return card.gist;
  const when = Number.isNaN(at.getTime()) ? "—" : ago(at.toISOString(), now);
  const what = card.gist === "" ? notice.what : `${notice.what} — ${card.gist}`;
  return [notice.project, what, when === "—" ? null : when].filter((part) => part !== null).join(" · ");
}

// ---------------------------------------------------------------------------
// Who sent it, who gets it.
// ---------------------------------------------------------------------------

export type ChatRole = "manager" | "worker" | "reviewer" | "orchestrator";

export interface Party {
  role: ChatRole | null;
  /** Null when the agent cannot be established. */
  id: string | null;
  title: string | null;
}

const ROLE_NAME: Record<ChatRole, string> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer", orchestrator: "Orchestrator" };

/** A peer's role as a card names it; an agent without a known role has none. */
function chatRoleOf(role: ChatPeer["role"]): ChatRole | null {
  return role === "unknown" ? null : role;
}

function party(peer: ChatPeer | undefined | null, fallback: ChatRole | null): Party {
  if (peer === undefined || peer === null) return { role: fallback, id: null, title: null };
  const role = chatRoleOf(peer.role) ?? fallback;
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
  const ownerRole = owner === null ? null : chatRoleOf(owner.role);
  const self = owner === null ? party(undefined, null) : party(owner, ownerRole);
  const byId = (id: string | null) => (id === null ? undefined : peers.find((peer) => peer.id === id));
  const ofRole = (role: ChatRole) => peers.filter((peer) => peer.role === role);
  // The one live Worker of the request; an old card of a Worker that has since
  // been archived keeps its name (delta 20260918f F12).
  const workerOf = (requestId: string | null) =>
    soleWorkerOf(peers, requestId) ?? only(ofRole("worker").filter((peer) => requestId !== null && peer.requestId === requestId));
  const manager = () => {
    const parent = byId(owner?.parentId ?? null);
    return parent?.role === "manager" ? parent : only(ofRole("manager"));
  };
  const parentWorker = () => {
    const parent = byId(owner?.parentId ?? null);
    return parent?.role === "worker" ? parent : undefined;
  };
  const fromReport = card.type === "progress" || card.type === "finished" || (card.type === "decision" && card.decision?.asker === "worker");

  if (card.direction === "sent") {
    const role = ownerRole ?? (card.type === "verdict" ? "reviewer" : fromReport ? "worker" : null);
    const to = card.type === "verdict" ? party(parentWorker() ?? workerOf(card.requestId), "worker") : party(manager(), "manager");
    return { from: { ...self, role }, to };
  }

  if (fromReport) return { from: party(workerOf(card.requestId), "worker"), to: self };
  if (card.type === "notice" || card.type === "decision") return { from: party(undefined, null), to: self };
  if (card.type === "verdict") {
    const batch = card.review?.batchId ?? null;
    const reviewers = ofRole("reviewer").filter(
      (peer) => (card.requestId === null || peer.requestId === card.requestId) && (batch === null || peer.batchId === batch),
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

/** A party as a card's actor line names it: role and title, never an id (experience concept §5.1). */
export function actorName(p: Party): string {
  const role = p.role === null ? "Agent" : ROLE_NAME[p.role];
  return p.title !== null && p.title.trim() !== "" ? `${role} · ${p.title.trim()}` : role;
}

export function roleName(role: ChatRole | null): string {
  return role === null ? "agent" : ROLE_NAME[role];
}

/**
 * Whether the renderer should draw the card at all. A chat that is not a
 * paseo-bm agent's, or a block the chat's agent only quoted (a Manager quoting
 * a review), is shown as plain text instead of pretending to be a card.
 */
export function drawAsCard(card: ChatCard, owner: ChatPeer | null): boolean {
  if (owner === null || owner.role === "unknown") return false;
  if (card.direction === "received") return true;
  return card.type === "verdict" ? owner.role === "reviewer" : owner.role === "worker";
}

/**
 * What Details says about the chat of an agent that carries no `bm.role`
 * label — started outside Beads Manager and recognised by its provider (delta
 * 20260918g §4.4) — or null for every other chat.
 */
export function ownerWarning(owner: ChatPeer | null): string | null {
  if (owner === null || owner.labelled !== false) return null;
  return "This agent has no bm.role label: it was started outside Beads Manager, and paseo-bm recognised it by its provider.";
}

/** The graph node kind whose icon and colour a role uses (`ROLE_MARK`). */
export function markOf(role: ChatRole | null): RoleMarkKind | null {
  return role === "manager" ? "request" : role;
}

// ---------------------------------------------------------------------------
// The frame every card is drawn in (`CardFrame`, `ui.tsx`).
// ---------------------------------------------------------------------------

/** Everything `CardFrame` draws above the actions (experience concept §5.1). */
export interface CardFrameView {
  actor: { mark: RoleMarkKind | null; name: string };
  /** Who it is for; null when the card has no one in particular. */
  recipient: string | null;
  /** `your answer 14:02`, `Autopilot`, …; null for a plain report. */
  authority: string | null;
  time: string;
  /** The one status chip, or none. */
  chip: Badge | null;
  title: string;
  /** A neutral tag on the title line (tier, effects, grant); null for none. */
  tag: string | null;
  /** At most `MAX_BODY_LINES`. */
  body: string[];
  /** The outline's tone, or null for the usual border. */
  outline: Tone | null;
  /** One line under the actions: an outcome or an error. */
  status: { text: string; tone: Tone } | null;
}

/** `14:02` in the device's time zone; "" for an unreadable time. */
export function clock(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return Number.isNaN(date.getTime()) ? "" : `${two(date.getHours())}:${two(date.getMinutes())}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `15:40`, `tomorrow 15:40`, `yesterday 15:40` or `Thu 24 Sep 15:40`, in the device's time zone. */
export function localTimeText(at: Date, now: Date): string {
  const time = clock(at);
  const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]} ${time}`;
}

/** A value that opens with "none" says nothing: the readers' rule (`blocksCompletion`, the trace). */
function isNoneLike(text: string | null): boolean {
  return text === null || /^\s*none\b/i.test(text);
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const PHASE_WORDS: Readonly<Record<string, { chip: Badge; title: string }>> = {
  received: { chip: { text: "Received", tone: "info" }, title: "Request received" },
  "documents-done": { chip: { text: "Working", tone: "info" }, title: "Documents done" },
  "beads-done": { chip: { text: "Working", tone: "info" }, title: "Beads planned" },
  "bead-implemented": { chip: { text: "Working", tone: "info" }, title: "A bead is done" },
  blocked: { chip: { text: "Blocked", tone: "warning" }, title: "Blocked" },
};

function beadsLine(report: ReportFacts): string | null {
  const parts = [
    report.beads.created > 0 ? `${report.beads.created} created` : null,
    report.beads.updated > 0 ? `${report.beads.updated} updated` : null,
    report.beads.closed > 0 ? `${report.beads.closed} closed` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `Beads: ${parts.join(", ")}`;
}

/** Longest `blockers` text on a body line: the whole text is in Details. */
export const BODY_BLOCKERS_CHARS = 160;

function withIssues(card: ChatCard, lines: Array<string | null>): string[] {
  const kept = lines.filter((line): line is string => line !== null && line !== "");
  if (card.formatIssues.length === 0) return kept.slice(0, MAX_BODY_LINES);
  // The template problem always shows: it takes the last line.
  return [...kept.slice(0, MAX_BODY_LINES - 1), "This message breaks its template: see Details."];
}

const VERDICT_CHIP = (verdict: string | null): Badge | null => {
  if (verdict === null) return null;
  const text = verdict.toLowerCase();
  if (/pass|approved/.test(text)) return { text: "Passed", tone: "success" };
  if (/changes/.test(text)) return { text: "Changes required", tone: "warning" };
  if (/stopped/.test(text)) return { text: "Stopped", tone: "muted" };
  return { text: verdict, tone: "muted" };
};

const INTENT_CHIP: Readonly<Record<string, Badge>> = {
  answer: { text: "Answer", tone: "info" },
  continue: { text: "Continue", tone: "info" },
  redirect: { text: "Redirect", tone: "warning" },
  stop: { text: "Stop", tone: "warning" },
  release: { text: "Release", tone: "warning" },
  other: { text: "Command", tone: "info" },
};

/** On whose authority a command went, in words (autonomy design §A.7); a version 1 block says how it left. */
export function commandAuthorityText(command: CommandBlock): string {
  if (command.authority === null) return command.via === "autopilot" ? "Autopilot" : command.via === "tab" ? "from the tab" : "approved in chat";
  if (command.authority === "autopilot") return "Autopilot";
  if (command.authority === "owner") return command.via === "tab" ? "your command" : "your word in chat";
  return "your decision";
}

/** A command's effects as its tag: `no effects`, or the effects it may have, with how many are approved. */
export function commandEffectsText(command: CommandBlock): string | null {
  if (command.version === 1) return null;
  if (command.effects.length === 0) return "no effects";
  return command.approved.length === 0 ? `effects: ${command.effects.join(", ")}` : `approved: ${command.approved.join(", ")}`;
}

/**
 * The Worker a `to: worker` command is for, as its card names it, or null (a
 * Manager's command, or no single Worker fits). In a Worker's own chat it is
 * the chat's agent.
 */
export function commandWorkerName(card: ChatCard, owner: ChatPeer | null, peers: readonly ChatPeer[]): string | null {
  const command = card.command;
  if (command === null || command.to !== "worker") return null;
  const peer = !command.copy && owner?.role === "worker" ? owner : soleWorkerOf(peers, command.requestId);
  return peer === null ? null : actorName(party(peer, "worker"));
}

/** The command's body without its `BM-ANSWERS` block, as up to `limit` plain lines. */
function commandBodyLines(command: CommandBlock, limit: number): string[] {
  return meaningfulLines(command.body, false).slice(0, limit);
}

export interface FrameContext {
  owner: ChatPeer | null;
  peers: readonly ChatPeer[];
  /** The message's time in the timeline. */
  at: Date;
  now: Date;
}

/** The frame of every card but `decision` (`decisionCardView`) and `notice` (`noticeLine`). */
export function cardFrameOf(card: ChatCard, context: FrameContext): CardFrameView {
  const { from, to } = partiesOf(card, context.owner, context.peers);
  const frame: CardFrameView = {
    actor: { mark: markOf(from.role), name: actorName(from) },
    recipient: actorName(to),
    authority: null,
    time: clock(context.at),
    chip: null,
    title: card.gist,
    tag: null,
    body: [],
    outline: null,
    status: null,
  };
  switch (card.type) {
    case "progress": {
      const report = card.report!;
      const words = report.phase === null ? null : (PHASE_WORDS[report.phase] ?? null);
      const lead = card.gist;
      return {
        ...frame,
        chip: words?.chip ?? { text: "Working", tone: "info" },
        title: words?.title ?? "Progress",
        tag: report.tier,
        body: withIssues(card, [
          lead,
          beadsLine(report),
          isNoneLike(report.blockers) ? null : `Waiting on: ${shortened(report.blockers!, BODY_BLOCKERS_CHARS)}`,
        ]),
      };
    }
    case "finished": {
      const report = card.report!;
      const changed = [
        report.filesChanged > 0 ? `${plural(report.filesChanged, "file")} changed` : null,
        report.beads.closed > 0 ? `${plural(report.beads.closed, "bead")} closed` : null,
      ].filter((part) => part !== null);
      return {
        ...frame,
        chip: { text: "Finished", tone: "success" },
        title: card.gist || "Request finished",
        tag: report.tier,
        outline: "success",
        body: withIssues(card, [
          changed.length === 0 ? null : changed.join(" · "),
          isNoneLike(report.checks) ? null : `Checks: ${shortened(report.checks!, 120)}`,
          report.decided > 0 ? `Decided on its own: ${report.decided} (see Details)` : null,
        ]),
      };
    }
    case "verdict": {
      const review = card.review!;
      const blocking = review.blocking;
      return {
        ...frame,
        chip: VERDICT_CHIP(review.verdict),
        title: card.gist || "Review verdict",
        body: withIssues(card, [blocking === null ? null : blocking === 0 ? "No blocking findings" : `${plural(blocking, "blocking finding")}`]),
      };
    }
    case "brief": {
      const lines = meaningfulLines(card.text, false);
      return { ...frame, title: lines[0] ?? card.gist, body: withIssues(card, lines.slice(1, 1 + MAX_BODY_LINES)) };
    }
    case "action": {
      const command = card.command!;
      const recipient = command.to === "manager" ? "Manager" : (commandWorkerName(card, context.owner, context.peers) ?? "Worker");
      return {
        ...frame,
        actor: command.from === "orchestrator" ? { mark: "orchestrator", name: "Orchestrator" } : { mark: null, name: "You" },
        recipient,
        authority: commandAuthorityText(command),
        chip: command.intent === null ? null : (INTENT_CHIP[command.intent] ?? null),
        title: command.re,
        tag: commandEffectsText(command),
        body: withIssues(card, [...commandBodyLines(command, command.why === null ? MAX_BODY_LINES : MAX_BODY_LINES - 1), command.why === null ? null : `Why: ${command.why}`]),
      };
    }
    default:
      return frame;
  }
}

/** What Details lists above the whole message: the ids and the machine facts, never on the card's face. */
export function detailLinesOf(card: ChatCard, owner: ChatPeer | null): string[] {
  const lines: string[] = [];
  const warning = ownerWarning(owner);
  if (warning !== null) lines.push(warning);
  if (card.requestId !== null) lines.push(`Request: ${card.requestId}`);
  if (card.review?.batchId != null) lines.push(`Batch: ${card.review.batchId}`);
  if (card.review?.verdict != null) lines.push(`Verdict: ${card.review.verdict}`);
  if (card.report !== null && card.report.phase !== null) lines.push(`Phase: ${card.report.phase}`);
  const command = card.command;
  if (command !== null) {
    lines.push(`From: ${command.from} · via: ${command.via} · to: ${command.to}`);
    if (command.intent !== null) lines.push(`Intent: ${command.intent}`);
    if (command.version === 2) lines.push(`Effects: ${command.effects.join(", ") || "none"} · approved: ${command.approved.join(", ") || "none"}`);
    if (command.authority !== null) lines.push(`Authority: ${command.authority}`);
    const decisionId = decisionIdOfAuthority(command.authority);
    if (decisionId !== null) lines.push(`Decision: ${decisionId}`);
    if (command.limits.length > 0) lines.push(`Limits: ${command.limits.join(", ")}`);
  }
  if (card.formatIssues.length > 0) {
    lines.push("This message breaks the template:");
    lines.push(...card.formatIssues.map((issue) => `• ${issue}`));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The decision card (experience concept §5.2): live from the decision store.
// ---------------------------------------------------------------------------

/** How often an unsettled decision is read again; a settled one is not read again. */
export const DECISION_POLL_MS = 5_000;
/** A decision the store does not have (yet) is looked for this long after its message: the materialiser runs at the end of the Manager's turn. */
export const DECISION_LOOKUP_WINDOW_MS = 10 * 60_000;

/** What `decisions.get` said about a card's decision. */
export type DecisionLookup =
  | { state: "loading" }
  | { state: "failed"; error: unknown }
  | { state: "missing" }
  | { state: "found"; decision: Decision };

/** The lookup of a `decisions.get` result: `E_DECISION_NOT_FOUND` is `missing`, any other failure `failed`. */
export function decisionLookupOf(result: { data?: { decision: Decision } | undefined; error?: unknown; isLoading?: boolean }): DecisionLookup {
  if (result.data !== undefined) return { state: "found", decision: result.data.decision };
  if (result.error !== undefined && result.error !== null) {
    return errorCodeOf(result.error) === "E_DECISION_NOT_FOUND" ? { state: "missing" } : { state: "failed", error: result.error };
  }
  return { state: "loading" };
}

/**
 * When to read the decision again: every `DECISION_POLL_MS` while it can
 * still be answered; never once it is settled; while it is not recorded or
 * unreadable, only within `DECISION_LOOKUP_WINDOW_MS` of its message, so an
 * old chat does not poll for decisions long gone.
 */
export function decisionPollMs(lookup: DecisionLookup, cardAt: Date, now: Date): number | false {
  if (lookup.state === "found") return isAnswerable(lookup.decision) ? DECISION_POLL_MS : false;
  const age = now.getTime() - cardAt.getTime();
  return Number.isNaN(age) || age > DECISION_LOOKUP_WINDOW_MS ? false : DECISION_POLL_MS;
}

/** The option key a words answer confirms under, in `DecisionUi.confirming`. */
export const OWN_WORDS = "*own-words*";

/** The card's own state: what the owner is doing on it right now. */
export interface DecisionUi {
  /** An option key (or `OWN_WORDS`) waiting for the confirmation step; null otherwise. */
  confirming: string | null;
  /** The own-words box, open when not null. */
  words: string | null;
  busy: boolean;
  /** What the last press could not do. */
  error: string | null;
}

export const DECISION_UI_IDLE: DecisionUi = { confirming: null, words: null, busy: false, error: null };

export interface DecisionButton {
  key: string;
  label: string;
  /** The recommended option is the one primary action; the others are secondary. */
  primary: boolean;
  /** Tapping it first asks for the confirmation (release, data, security, cost — X-4). */
  confirm: boolean;
  accessibilityLabel: string;
}

export interface DecisionCardView {
  frame: CardFrameView;
  /** The options, only while the decision is `open`. */
  options: DecisionButton[];
  /** "Own words…" offered: only while `open`. */
  ownWords: boolean;
  /** "Close as answered" / "Keep open", only while `needs-confirmation`. */
  confirmChat: boolean;
  /** The in-place confirmation, Cancel first; null when none is asked. */
  confirm: SetupDialog | null;
  details: string[];
}

const VIA_WHERE: Readonly<Record<AnswerVia, string>> = {
  inbox: " in the Inbox",
  "chat-card": "",
  "chat-manager": " in the Manager's chat",
  "chat-worker": " in the Worker's chat",
  "chat-orchestrator": " in the Orchestrator's chat",
  autopilot: " on Autopilot",
};

const CHAT_WORDS: Readonly<Record<ChatVia, string>> = {
  "chat-manager": "the Manager's chat",
  "chat-worker": "the Worker's chat",
  "chat-orchestrator": "the Orchestrator's chat",
};

const STATUS_CHIPS: Readonly<Record<Decision["status"], Badge>> = {
  open: { text: "Needs decision", tone: "warning" },
  "needs-confirmation": { text: "Needs confirmation", tone: "warning" },
  answered: { text: "Decided", tone: "success" },
  superseded: { text: "Superseded", tone: "muted" },
  withdrawn: { text: "Withdrawn", tone: "muted" },
  expired: { text: "Expired", tone: "muted" },
};

function agentNamed(id: string | null, agents: readonly ChatPeer[], fallback: ChatRole | null): string {
  const peer = id === null ? undefined : agents.find((candidate) => candidate.id === id);
  return actorName(party(peer, fallback));
}

function askerOf(role: DecisionSeed["asker"], agentId: string | null, agents: readonly ChatPeer[]): CardFrameView["actor"] {
  if (role === "orchestrator") return { mark: "orchestrator", name: "Orchestrator" };
  if (role === "plugin") return { mark: null, name: "paseo-bm plugin" };
  return { mark: "worker", name: agentNamed(agentId, agents, "worker") };
}

function effectWords(effects: readonly Effect[]): string {
  return effects.join(", ");
}

/** True when this answer needs the owner's confirmation first (X-4, `CONFIRM_EFFECTS`). */
export function choiceNeedsConfirmation(decision: Pick<Decision, "options">, choice: { optionKey: string } | { words: string }): boolean {
  return needsOwnerConfirmation(effectsOfAnswer(decision, "optionKey" in choice ? { optionKey: choice.optionKey } : { optionKey: null }));
}

function answerLines(decision: Decision, agents: readonly ChatPeer[]): string[] {
  const answer = decision.answer;
  const lines: string[] = [];
  if (answer !== null) {
    const option = answer.optionKey === null ? undefined : decision.options.find((entry) => entry.key === answer.optionKey);
    if (option !== undefined) lines.push(`✓ ${option.label}`);
    else if (answer.words !== null) lines.push(`Your words: ${shortened(answer.words, 160)}`);
    else lines.push(`Answered${VIA_WHERE[answer.via]} (confirmed by you).`);
  }
  const delivery = decision.delivery;
  if (delivery !== null) {
    const to = agentNamed(delivery.to, agents, null);
    const name = to === "Agent" ? "the agent" : to;
    lines.push(
      delivery.outcome === "sent" ? `Sent to ${name}.` : delivery.outcome === "queued" ? `Queued for ${name}: it goes when the agent is idle.` : `Could not deliver to ${name}.`,
    );
  }
  return lines;
}

function settledLine(decision: Decision): string | null {
  switch (decision.status) {
    case "superseded":
      return "Replaced by a newer question.";
    case "withdrawn":
      return decision.id.startsWith("f:") ? "The incident was handled another way." : "The asker no longer needs an answer.";
    case "expired":
      return "Nobody answered in time.";
    default:
      return null;
  }
}

function grantTag(decision: Decision): string | null {
  const grant = decision.grant;
  if (grant === null) return null;
  return grant.usedAt === null ? `grant: ${effectWords(grant.effects)} 1×` : "grant used";
}

function decisionDetails(card: ChatCard, seed: DecisionSeed, decision: Decision | null): string[] {
  const lines = [`Decision: ${seed.id}`];
  const requestId = decision?.requestId ?? card.requestId;
  if (requestId !== null) lines.push(`Request: ${requestId}`);
  if (decision === null) return lines;
  lines.push(`Asked by: ${decision.askedBy.role}${decision.askedBy.agentId === null ? "" : ` ${decision.askedBy.agentId}`} at ${decision.askedAt}`);
  if (decision.subject !== null) lines.push(`Subject: ${decision.subject}`);
  for (const option of decision.options) {
    const effects = realEffects(option.effects);
    lines.push(`${option.key}: ${option.label}${option.recommended ? " (recommended)" : ""} — effects: ${effects.length === 0 ? "none" : effectWords(effects)}`);
  }
  lines.push(`Status: ${decision.status}${decision.settledAt === null ? "" : ` at ${decision.settledAt}`}`);
  if (decision.answer !== null) {
    if (decision.answer.by === "orchestrator") lines.push("Answered by: the Orchestrator");
    lines.push(`Answer via: ${decision.answer.via}`);
    // The Orchestrator's reason (bm_decide, change-004): in Details, never on the card's face.
    if (decision.answer.reason !== undefined) lines.push(`Reason: ${decision.answer.reason}`);
  }
  if (decision.grant !== null) {
    lines.push(`Grant: ${effectWords(decision.grant.effects)} until ${decision.grant.expiresAt}${decision.grant.usedAt === null ? "" : `, used at ${decision.grant.usedAt}`}`);
  }
  if (decision.delivery !== null) lines.push(`Delivery: ${decision.delivery.outcome} to ${decision.delivery.to} at ${decision.delivery.at} (${decision.delivery.kind})`);
  if (decision.supersedes !== null) lines.push(`Supersedes: ${decision.supersedes}`);
  if (decision.supersededBy !== null) lines.push(`Superseded by: ${decision.supersededBy}`);
  return lines;
}

export interface DecisionViewInput {
  card: ChatCard;
  lookup: DecisionLookup;
  /** The agents the card can name: the chat's owner and its peers. */
  agents: readonly ChatPeer[];
  ui: DecisionUi;
  /** The message's time in the timeline. */
  cardAt: Date;
  now: Date;
}

/** Codes and messages of a failed RPC, in front: `(<code>): <message>`. */
function codedReason(error: unknown): string {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  if (code === null) return `: ${message}`;
  const rest = message.replace(/^\s*E_[A-Z0-9_]+\s*:?\s*/, "");
  return rest === "" ? ` (${code})` : ` (${code}): ${rest}`;
}

/**
 * Everything a decision card draws, from its seed and the decision as the
 * store has it now. The same card in every chat and in the Inbox: answering
 * anywhere shows answered everywhere on the next read.
 */
export function decisionCardView(input: DecisionViewInput): DecisionCardView {
  const { card, lookup, agents, ui, now } = input;
  const seed = card.decision!;
  const decision = lookup.state === "found" ? lookup.decision : null;
  const frame: CardFrameView = {
    actor: askerOf(decision?.askedBy.role ?? seed.asker, decision?.askedBy.agentId ?? null, agents),
    recipient: "you",
    authority: null,
    time: decision === null ? clock(input.cardAt) : `asked ${ago(decision.askedAt, now)}`,
    chip: null,
    title: decision?.question ?? seed.question,
    tag: null,
    body: [],
    outline: null,
    status: ui.error === null ? (ui.busy ? { text: "Sending your answer…", tone: "muted" } : null) : { text: ui.error, tone: "danger" },
  };
  const view: DecisionCardView = { frame, options: [], ownWords: false, confirmChat: false, confirm: null, details: decisionDetails(card, seed, decision) };

  if (decision === null) {
    const body =
      lookup.state === "loading"
        ? "Reading the decision…"
        : lookup.state === "failed"
          ? `Could not read the decision${codedReason(lookup.error)}`
          : seed.asker === "worker"
            ? "Not recorded yet: it opens once the Manager has read the report."
            : "This decision is not recorded.";
    return { ...view, frame: { ...frame, body: [body] } };
  }

  const chip = STATUS_CHIPS[decision.status];
  switch (decision.status) {
    case "open": {
      const declared = declaredEffects(decision);
      const options = decision.options.map(
        (option): DecisionButton => {
          const effects = realEffects(option.effects);
          return {
            key: option.key,
            label: option.recommended ? `${option.label} ★` : option.label,
            primary: option.recommended,
            confirm: needsOwnerConfirmation(effects),
            accessibilityLabel: `Answer: ${option.label}${option.recommended ? " (recommended)" : ""}${effects.length === 0 ? "" : `; allows ${effectWords(effects)}`}`,
          };
        },
      );
      let confirm: DecisionCardView["confirm"] = null;
      if (ui.confirming !== null) {
        const option = decision.options.find((entry) => entry.key === ui.confirming);
        const effects = effectsOfAnswer(decision, { optionKey: option?.key ?? null });
        confirm = {
          title: option === undefined ? "Send your own words?" : `Answer: ${option.label}?`,
          body: `This answer allows ${effectWords(effects)} once, within the hour. Nothing is sent until you confirm.`,
          confirmLabel: "Confirm and send",
          cancelLabel: "Cancel",
          defaultAction: "cancel",
        };
      }
      return {
        ...view,
        frame: { ...frame, chip, tag: declared.length === 0 ? null : `effects: ${effectWords(declared)}` },
        options: confirm === null && ui.words === null ? options : [],
        ownWords: confirm === null,
        confirm,
      };
    }
    case "needs-confirmation": {
      const where = decision.needsConfirmation === null ? "a chat" : CHAT_WORDS[decision.needsConfirmation.via];
      const at = decision.needsConfirmation === null ? "" : ` at ${localTimeText(new Date(decision.needsConfirmation.at), now)}`;
      return { ...view, frame: { ...frame, chip, body: [`You wrote in ${where}${at}. Did that answer it?`] }, confirmChat: true };
    }
    case "answered": {
      const answer = decision.answer!;
      // Settled either way, so no answer buttons: the Orchestrator's answer (bm_decide) is as final as the owner's.
      const by = answer.by === "orchestrator" ? "answered by the Orchestrator" : `answered by you${VIA_WHERE[answer.via]}`;
      return {
        ...view,
        frame: {
          ...frame,
          chip,
          authority: `${by} · ${localTimeText(new Date(answer.at), now)}`,
          tag: grantTag(decision),
          body: answerLines(decision, agents).slice(0, MAX_BODY_LINES),
        },
      };
    }
    default:
      return { ...view, frame: { ...frame, chip, body: [settledLine(decision) ?? ""].filter((line) => line !== "") } };
  }
}

export type DecisionChoice = { optionKey: string } | { words: string };

export type DecisionActResult = { ok: true; decision: Decision } | { ok: false; reason: string };

/**
 * One answer: ONE `decisions.answer` call with the card's surface. `confirmed`
 * is passed only after the owner confirmed on the card.
 */
export async function runDecisionAnswer(input: {
  id: string;
  choice: DecisionChoice;
  confirmed: boolean;
  via: "inbox" | "chat-card";
  answer: (input: { id: string; optionKey?: string; words?: string; confirmed?: true; via: "inbox" | "chat-card" }) => Promise<{ decision: Decision }>;
}): Promise<DecisionActResult> {
  if ("words" in input.choice && input.choice.words.trim() === "") return { ok: false, reason: "Write your answer first." };
  try {
    const { decision } = await input.answer({
      id: input.id,
      ...("optionKey" in input.choice ? { optionKey: input.choice.optionKey } : { words: input.choice.words }),
      ...(input.confirmed ? { confirmed: true as const } : {}),
      via: input.via,
    });
    return { ok: true, decision };
  } catch (failure) {
    return { ok: false, reason: `Could not answer${codedReason(failure)}` };
  }
}

/** The owner's tap on a decision that needs confirmation: ONE `decisions.confirm` call. */
export async function runDecisionConfirm(input: {
  id: string;
  answered: boolean;
  confirm: (input: { id: string; answered: boolean }) => Promise<{ decision: Decision }>;
}): Promise<DecisionActResult> {
  try {
    const { decision } = await input.confirm({ id: input.id, answered: input.answered });
    return { ok: true, decision };
  } catch (failure) {
    return { ok: false, reason: `Could not ${input.answered ? "close" : "reopen"} the decision${codedReason(failure)}` };
  }
}

// ---------------------------------------------------------------------------
// The message in Details, and a card shown as plain text.
// ---------------------------------------------------------------------------

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
 * 20260918g §4.8): laid out like Details, one field per line.
 */
export function fallbackMarkdown(card: { text: string }): string {
  return markdownOf(card.text);
}

// ---------------------------------------------------------------------------
// Related beads (the "Beads in this chat" panel's chips; delta 20260918d §4.7).
// ---------------------------------------------------------------------------

/** How many related-bead chips are shown before folding the rest behind "…". */
export const BEAD_CHIPS_SHOWN = 2;

/** The items shown, and how many are folded behind the "…" chip. */
export function visibleBeads<T>(items: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || items.length <= BEAD_CHIPS_SHOWN) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, BEAD_CHIPS_SHOWN), hidden: items.length - BEAD_CHIPS_SHOWN };
}

/** The chips of related beads: the first two beads the store REALLY has, and how many more (delta 20260918f F10). */
export function beadChipsView(found: readonly BeadRow[], expanded: boolean): { shown: BeadRow[]; hidden: number } {
  return visibleBeads(found, expanded);
}
