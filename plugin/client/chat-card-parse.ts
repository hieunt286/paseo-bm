/**
 * Chat cards v2 (autonomy design §A.12, experience concept §5): what a chat
 * item becomes.
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
 * Everything the cards say is decided in the `chat-card-*` modules, tested
 * without a renderer; ids appear only in Details. Who sent what is decided
 * later, by the renderer, from `chat.peers`. The modules follow the sections
 * of the one file they were (code review 2026-09-30 §4):
 *
 * - `chat-card-parse.ts` (this file): the card schema, and the cards of a chat
 *   item and of the plugin's own messages;
 * - `chat-card-events.ts`: the Orchestrator's batched events;
 * - `chat-card-parties.ts`: who sent a card, who gets it;
 * - `chat-card-frame.ts`: the frame every card is drawn in, its time, and a
 *   notice's compact line;
 * - `chat-card-decision.ts`: the decision card, live from the decision store;
 * - `chat-card-precedent.ts`: Save as precedent, and the precedent a card
 *   suggests;
 * - `chat-card-markdown.ts`: the message in Details.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { z } from "zod";
import { looksLikeReport, parseReports, parseReviews, requestIdFromText } from "../shared/bm-report";
import { parseQuestions } from "../shared/bm-questions";
import { checkBlocks, issueText } from "../shared/bm-format";
import { BM_FALLBACK_MARKER, FALLBACK_CLASS_LABELS, parseFallbackNotice } from "../shared/bm-fallback";
import { ANSWER_NOTICE_MARKER, EVENTS_NOTICE_MARKER, HANDOFF_NOTICE_MARKER, REPLACED_NOTICE_MARKER, STATE_NOTICE_MARKER, noticeMarkerOf } from "../shared/notices";
import {
  COMMAND_FROM,
  COMMAND_INTENTS,
  COMMAND_TO,
  READ_COMMAND_VIA,
  isReadCommandAuthority,
  parseCommandBlock,
  type CommandBlock,
} from "../shared/orchestrator-command";
import { ASKER_ROLES, DECISION_ID_PATTERN, effectSchema, questionDecisionId } from "../shared/decisions";
import { reportPhaseSchema } from "../shared/contracts";
import { eventsNoticeOf } from "./chat-card-events";
import type { Tone } from "./tone";
import { shorten } from "../shared/text";

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
  via: z.enum(READ_COMMAND_VIA),
  to: z.enum(COMMAND_TO),
  copy: z.boolean(),
  requestId: z.string().nullable(),
  re: z.string(),
  intent: z.enum(COMMAND_INTENTS).nullable(),
  effects: z.array(effectSchema),
  authority: z.custom<CommandBlock["authority"]>((value) => value === null || isReadCommandAuthority(value)),
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

/** The meaningful lines of a text, cleaned of Markdown marks; `untilBlock` stops at the first block. */
export function meaningfulLines(text: string, untilBlock: boolean): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (BLOCK_LINE.test(raw)) {
      if (untilBlock) break;
      continue;
    }
    if (/^\s*```/.test(raw) || /^\s*-{3,}\s*$/.test(raw)) continue;
    const line = cleanLine(raw);
    if (line !== "") out.push(shorten(line, 160));
  }
  return out;
}

function gistOf(text: string, untilBlock = false): string {
  return meaningfulLines(text, untilBlock)[0] ?? "";
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

/** A paseo-bm role a card can name; which agent it is, is `chat-card-parties.ts`'s to decide. */
export type ChatRole = "manager" | "worker" | "reviewer" | "orchestrator";

/** A role as a card names it. */
export const ROLE_NAME: Readonly<Record<ChatRole, string>> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer", orchestrator: "Orchestrator" };

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
  [STATE_NOTICE_MARKER]: "State restored after compaction",
  [HANDOFF_NOTICE_MARKER]: "Asked for a handoff note",
  [REPLACED_NOTICE_MARKER]: "Handed over to another Worker",
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
