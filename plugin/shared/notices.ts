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
 * (`client/chat-cards.ts`, which draw a notice as a card) share one
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
];

/** Markers that count only as a whole word: followed by whitespace or nothing. */
const WHOLE_WORD_MARKERS: ReadonlySet<string> = new Set([ANSWER_NOTICE_MARKER, DELIVERY_NOTICE_MARKER]);

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
