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
 * Kept in its own module so the pure modules (`traces.ts`) and the senders
 * (`stop-propagation.ts`, `review-budget.ts`) can share one definition without
 * importing each other.
 */

/** First word of the review-budget notice (`review-budget.ts`). */
export const BUDGET_NOTICE_MARKER = "BM-BUDGET";

/** Start of the stop notice a Worker's Reviewers receive (`stop-propagation.ts`). */
export const REVIEWER_STOP_NOTICE_PREFIX = "STOP: The Beads Worker that created you was stopped";

const PREFIXES: readonly string[] = [BUDGET_NOTICE_MARKER, REVIEWER_STOP_NOTICE_PREFIX];

/** True when this text is one of the plugin's own notices, not a person's words. */
export function isPluginNotice(text: unknown): boolean {
  return typeof text === "string" && PREFIXES.some((prefix) => text.startsWith(prefix));
}
