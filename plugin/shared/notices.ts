/**
 * Messages the PLUGIN sends to an agent, and how to recognise them again.
 *
 * Paseo's SDK always attaches a `messageId` to `PaseoAgentHandle.send()`, and
 * the daemon stores it as `clientMessageId` — the very field the collector uses
 * to tell a message the user typed from one an agent relayed (AGENTS.md). So
 * without this list the plugin's own notices are recorded as the user's words:
 * a request's history shows "you" saying `BM-BUDGET …`, counts it among the
 * user's messages, and can even take it for the request text (review b2).
 *
 * Kept in its own module so the pure modules (`traces.ts`), the senders
 * (`stop-propagation.ts`, `review-budget.ts`) and the chat cards
 * (`client/chat-card-parse.ts`, which draw a notice as a card) share one
 * definition without importing each other. Pure: no import at all.
 */

/** First word of the review-budget notice (`review-budget.ts`). */
export const BUDGET_NOTICE_MARKER = "BM-BUDGET";

/** Start of the stop notice a Worker's Reviewers receive (`stop-propagation.ts`). */
export const REVIEWER_STOP_NOTICE_PREFIX = "STOP: The Beads Worker that created you was stopped";

/** First word of the stop notice a Worker receives from `/bm-worker-stop-all`. */
export const WORKER_STOP_NOTICE_MARKER = "BM-STOP";

/**
 * What `/bm-worker-stop-all` sends to a running Worker.
 *
 * It POINTS AT the Worker's own stop rule rather than restating it. Restating
 * would create a second procedure that drifts from `roles/worker.md`: the first
 * draft of delta 20260917e did exactly that and its wording would have deleted
 * the mandatory `cancel_agent` on the Worker's own Reviewers, and asked for a
 * `blocked` report that `manager.md` renders as a question list — for a stop
 * that has no questions.
 */
export const WORKER_STOP_NOTICE =
  `${WORKER_STOP_NOTICE_MARKER} The user asked every Beads Worker and Reviewer in this workspace to stop. This is a stop: follow your Stop rule.`;

/**
 * First word of the notice the sender of a block that breaks its template
 * receives (`format-check.ts`, delta 20260918g §4.7). Listed here so the trace
 * store never records it as the user's words and `reviewCallsOf` never counts
 * one sent to a Reviewer as a review call.
 */
export const FORMAT_NOTICE_MARKER = "BM-FORMAT";

/**
 * First word of the notice a Manager receives when a Worker it created has no
 * Paseo tools (`tools-check.ts`, delta 20260921 §4.2.4).
 */
export const TOOLS_NOTICE_MARKER = "BM-TOOLS";

/**
 * First word of the notice a live Manager or Worker receives when the user
 * changed the start mode of the agents it creates (`settings-notices.ts`,
 * delta 20260921 §4.3.5).
 */
export const SETTINGS_NOTICE_MARKER = "BM-SETTINGS";

/**
 * First words of the plugin's fallback notices (delta 20260921 §4.4.6,
 * §4.4.9): `BM-FALLBACK` gives a Worker the instructions to replace its
 * stopped Reviewer (older builds also told the Manager about each incident;
 * the owner decides it in the Inbox now, autonomy design §A.5 d);
 * `BM-RESUME` asks an agent to carry on after its usage reset.
 */
export const FALLBACK_NOTICE_MARKER = "BM-FALLBACK";
export const RESUME_NOTICE_MARKER = "BM-RESUME";

/**
 * First word of the one message that carries every event pending for the
 * Beads Orchestrator at its idle moment (`event-bus.ts`, autonomy design §A.8):
 * a decision opened, a request finished or stalled, a Worker signal. Listed so
 * it never counts as the owner's words, nor as the owner's approval in the
 * Orchestrator's chat.
 */
export const EVENTS_NOTICE_MARKER = "BM-EVENTS";

/**
 * First word of every command the plugin delivers to a Manager or a Worker —
 * the Orchestrator's, and the prepared command of an option the owner chose
 * (`shared/orchestrator-command.ts` `COMMAND_MARKER`, Orchestrator design
 * §6B.1, autonomy design §A.7). Listed so the collector never counts one as a
 * new user request.
 */
export const COMMAND_NOTICE_MARKER = "BM-COMMAND";

/**
 * First word of the owner's answer to one of the Orchestrator's decisions,
 * which the plugin hands to the Orchestrator (`server/orchestrator-decisions.ts`,
 * autonomy design §A.6). Listed so it never counts as the owner's own word in
 * the Orchestrator's chat: the grant it carries is the authority, not the chat.
 *
 * Matched as a whole word (`WHOLE_WORD_MARKERS`): `BM-ANSWERS`, the answers
 * block an owner may type in a Worker's chat, starts with the same letters
 * and is never a plugin notice.
 */
export const ANSWER_NOTICE_MARKER = "BM-ANSWER";

/**
 * First line of the answers the plugin delivers to a Worker (autonomy design §A.6):
 * `BM-DELIVERY answers`, then `Continue <requestId>.` and the `BM-ANSWERS` block. It
 * marks the message as the plugin's, so the trace never counts it as typed by the owner.
 */
export const DELIVERY_NOTICE_MARKER = "BM-DELIVERY";

/**
 * The kinds of an outbox record (design §16.7): what a bound agent's tool
 * stored and the plugin delivers, each as `BM-DELIVERY <kind> <recordId>` on
 * its first line, the text after it.
 */
export const DELIVERY_KINDS = ["report", "review", "message", "no-verdict"] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/** An outbox record's id: `out-` + 12 lowercase hex digits. */
export const OUTBOX_RECORD_ID_PATTERN = /^out-[0-9a-f]{12}$/;

/** The fixed sentence of a `no-verdict` delivery (design §16.7). */
export const NO_VERDICT_SENTENCE =
  "The Reviewer ended its turn without a verdict. Ask it once more with bm_rereview, or report this batch as not reviewed.";

/** The first line of a delivery: `BM-DELIVERY <kind> <recordId>`. */
export function deliveryLineOf(kind: DeliveryKind, recordId: string): string {
  return `${DELIVERY_NOTICE_MARKER} ${kind} ${recordId}`;
}

/** A delivery's marker line read back. */
export interface ParsedDelivery {
  kind: DeliveryKind;
  recordId: string;
  /** Everything after the marker line. */
  body: string;
}

const DELIVERY_LINE = new RegExp(`^${DELIVERY_NOTICE_MARKER}[ \\t]+(${DELIVERY_KINDS.join("|")})[ \\t]+(out-[0-9a-f]{12})[ \\t]*(?:\\r?\\n|$)`);

/**
 * The kind, record id and text of an outbox delivery, or null for any other
 * text — `BM-DELIVERY answers` included, which carries no record id. Pure.
 */
export function parseDelivery(text: unknown): ParsedDelivery | null {
  if (typeof text !== "string") return null;
  const found = DELIVERY_LINE.exec(text);
  if (found === null) return null;
  return { kind: found[1] as DeliveryKind, recordId: found[2]!, body: text.slice(found[0].length) };
}

/**
 * First line of the state brief the plugin sends a Manager or a Worker right
 * after the compaction the Orchestrator asked for (`server/compaction.ts`,
 * autonomy design §G.5 step 4): what the stores hold, so what matters is
 * restored from artifacts. Listed so it is never the owner's words; the
 * `/compact` before it has no marker, and the send log tells it apart
 * (`server/compaction-store.ts`). Matched as a whole word.
 */
export const STATE_NOTICE_MARKER = "BM-STATE";

/**
 * First line of the plugin's request to an outgoing Worker for its handoff
 * note (`server/handoff.ts`, autonomy design §G.6 step 1): `bm_report` with
 * `handoffNote`, posted in its own chat. Listed so it is never the owner's
 * words. Matched as a whole word: the successor's brief starts
 * `BM-HANDOFF-BRIEF` (`shared/handoff.ts`), which the Manager sends, and is no
 * notice.
 */
export const HANDOFF_NOTICE_MARKER = "BM-HANDOFF";

/**
 * First line of the plugin's word to the outgoing Worker once its successor
 * appeared (`server/handoff.ts`, autonomy design §G.6 step 3): its request is
 * handed to that Worker; it stops working on it and ends its turn. The plugin
 * tells it, not the Manager, whose own attempt could miss (Phase 3 live check
 * F4). Listed so it is never the owner's words. Matched as a whole word.
 */
export const REPLACED_NOTICE_MARKER = "BM-REPLACED";

/**
 * First line of the plugin's word to a Manager or a Worker whose turn Paseo
 * cut short to deliver a message, and which then sat idle
 * (`server/interruption-watch.ts`, ADR-024): the cut was not the owner's stop.
 * Listed so it is never the owner's words. Matched as a whole word.
 */
export const INTERRUPTED_NOTICE_MARKER = "BM-INTERRUPTED";

/**
 * First line of the owner's question to the asker of an open decision, which
 * the plugin delivers (`server/decision-ask.ts`, change-014 outcome 3: Ask
 * back). Listed so it is never the owner's words: the owner's question is
 * quoted inside it, and the decision stays open. Matched as a whole word.
 */
export const ASK_NOTICE_MARKER = "BM-ASK";

/**
 * First words of notices older builds sent and no build sends any more
 * (autonomy design §A.14). Stored history still holds them, so they are
 * recognised — and so ignored — like every notice: the notice that told a
 * Manager its Worker had been answered directly (0.4.x), which the decision
 * store replaced.
 */
const RETIRED_NOTICE_MARKERS: readonly string[] = ["BM-ANSWERED"];

const PREFIXES: readonly string[] = [
  BUDGET_NOTICE_MARKER,
  REVIEWER_STOP_NOTICE_PREFIX,
  WORKER_STOP_NOTICE_MARKER,
  FORMAT_NOTICE_MARKER,
  TOOLS_NOTICE_MARKER,
  SETTINGS_NOTICE_MARKER,
  FALLBACK_NOTICE_MARKER,
  RESUME_NOTICE_MARKER,
  ...RETIRED_NOTICE_MARKERS,
  EVENTS_NOTICE_MARKER,
  COMMAND_NOTICE_MARKER,
  ANSWER_NOTICE_MARKER,
  DELIVERY_NOTICE_MARKER,
  STATE_NOTICE_MARKER,
  HANDOFF_NOTICE_MARKER,
  REPLACED_NOTICE_MARKER,
  INTERRUPTED_NOTICE_MARKER,
  ASK_NOTICE_MARKER,
];

/** Markers that count only as a whole word: followed by whitespace or nothing. */
const WHOLE_WORD_MARKERS: ReadonlySet<string> = new Set([ANSWER_NOTICE_MARKER, DELIVERY_NOTICE_MARKER, STATE_NOTICE_MARKER, HANDOFF_NOTICE_MARKER, REPLACED_NOTICE_MARKER, INTERRUPTED_NOTICE_MARKER, ASK_NOTICE_MARKER]);

function startsWithMarker(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  if (!WHOLE_WORD_MARKERS.has(prefix)) return true;
  const next = text.charAt(prefix.length);
  return next === "" || /\s/.test(next);
}

/** True when this text is one of the plugin's own notices, not a person's words. */
export function isPluginNotice(text: unknown): boolean {
  return typeof text === "string" && PREFIXES.some((prefix) => startsWithMarker(text, prefix));
}

/** The marker a plugin notice starts with (the stop prefix counts as `STOP`), or null. */
export function noticeMarkerOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  if (text.startsWith(REVIEWER_STOP_NOTICE_PREFIX)) return "STOP";
  return PREFIXES.find((prefix) => startsWithMarker(text, prefix)) ?? null;
}

// ---------------------------------------------------------------------------
// Prompt markers (design §16.2, ADR-027 decision 5): the first line of a
// FIRST prompt the plugin writes for an agent. Unlike a notice, such a prompt
// starts an agent's work, so it is drawn as Paseo draws it — but, like a
// notice, it is never the owner's words (`shared/message-origin.ts`).
// ---------------------------------------------------------------------------

/**
 * First word of every first prompt the plugin writes: `BM-BRIEF <role>
 * requestId: <id | none>` (`briefLineOf`). Matched as a whole word.
 */
export const BRIEF_PROMPT_MARKER = "BM-BRIEF";

/** First line of a fallback handover (`server/fallback-handover.ts`), after its `BM-BRIEF` line. */
export const HANDOVER_PROMPT_MARKER = "BM-HANDOVER";

/**
 * First line of a handoff brief (`shared/handoff.ts` `HANDOFF_BRIEF_MARKER`),
 * including the one an unbound Manager sends as a successor's first message.
 * Matched as a whole word.
 */
export const HANDOFF_BRIEF_PROMPT_MARKER = "BM-HANDOFF-BRIEF";

/**
 * How the first message of every Orchestrator starts in the versions before
 * its `BM-BRIEF` line (`server/orchestrator-agent.ts`): kept so stored history
 * still reads right.
 */
export const ORCHESTRATOR_PROMPT_START = "The user opened you from ";

const PROMPT_MARKERS: readonly string[] = [BRIEF_PROMPT_MARKER, HANDOVER_PROMPT_MARKER, HANDOFF_BRIEF_PROMPT_MARKER, ORCHESTRATOR_PROMPT_START];

/** Prompt markers that count only as a whole word: followed by whitespace or nothing. */
const WHOLE_WORD_PROMPT_MARKERS: ReadonlySet<string> = new Set([BRIEF_PROMPT_MARKER, HANDOFF_BRIEF_PROMPT_MARKER]);

/** The prompt marker this text starts with, or null. */
export function promptMarkerOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return (
    PROMPT_MARKERS.find((marker) => {
      if (!text.startsWith(marker)) return false;
      if (!WHOLE_WORD_PROMPT_MARKERS.has(marker)) return true;
      const next = text.charAt(marker.length);
      return next === "" || /\s/.test(next);
    }) ?? null
  );
}

/** True when this text is one of the plugin's first prompts, not a person's words. */
export function isPluginPrompt(text: unknown): boolean {
  return promptMarkerOf(text) !== null;
}

/** The `BM-BRIEF` first line: `BM-BRIEF <role> requestId: <id | none>`. */
export function briefLineOf(role: string, requestId: string | null): string {
  return `${BRIEF_PROMPT_MARKER} ${role} requestId: ${requestId ?? "none"}`;
}
