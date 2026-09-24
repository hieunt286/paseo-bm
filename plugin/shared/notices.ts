/**
 * Messages the PLUGIN sends to an agent, and how to recognise them again.
 *
 * Paseo's SDK always attaches a `messageId` to `PaseoAgentHandle.send()`, and
 * the daemon stores it as `clientMessageId` — the very field the collector uses
 * to tell a message the user typed from one an agent relayed (AGENTS.md). So
 * without this list the plugin's own notices are recorded as the user's words:
 * the Metric screen shows "you" saying `BM-BUDGET …`, counts it among the
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
 * §4.4.9): `BM-FALLBACK` tells a Manager about an incident and its decision;
 * `BM-RESUME` asks an agent to carry on after its usage reset.
 */
export const FALLBACK_NOTICE_MARKER = "BM-FALLBACK";
export const RESUME_NOTICE_MARKER = "BM-RESUME";

/**
 * First word of the notice that tells a Manager the user answered its Worker
 * directly, in the card or the Worker's chat (design delta 20260924-qa-ledger §5).
 */
export const ANSWERED_NOTICE_MARKER = "BM-ANSWERED";

const PREFIXES: readonly string[] = [
  BUDGET_NOTICE_MARKER,
  REVIEWER_STOP_NOTICE_PREFIX,
  WORKER_STOP_NOTICE_MARKER,
  FORMAT_NOTICE_MARKER,
  TOOLS_NOTICE_MARKER,
  SETTINGS_NOTICE_MARKER,
  FALLBACK_NOTICE_MARKER,
  RESUME_NOTICE_MARKER,
  ANSWERED_NOTICE_MARKER,
];

/** True when this text is one of the plugin's own notices, not a person's words. */
export function isPluginNotice(text: unknown): boolean {
  return typeof text === "string" && PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** The marker a plugin notice starts with (the stop prefix counts as `STOP`), or null. */
export function noticeMarkerOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  if (text.startsWith(REVIEWER_STOP_NOTICE_PREFIX)) return "STOP";
  return PREFIXES.find((prefix) => text.startsWith(prefix)) ?? null;
}
