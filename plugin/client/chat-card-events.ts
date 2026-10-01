/**
 * The Orchestrator's batched events (`BM-EVENTS`, autonomy design §A.8), as a
 * chat card says them: one compact line that says what happened; the lines
 * with their ids in Details. Split from `chat-cards.ts` (code review
 * 2026-09-30 §4); the card is made in `chat-card-parse.ts`.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { Tone } from "./tone";

export interface EventFacts {
  /** `decision.opened`, `request.finished`, `request.stalled`, `worker.signal`, `advice.due`, `threshold.crossed`, `writers.observed`, or one this client does not know. */
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
    case "advice.due":
      return "advice is due for a project";
    case "threshold.crossed":
      return "an agent crossed its threshold";
    case "writers.observed":
      return "two agents edited one file at the same time";
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
    case "advice.due":
    case "threshold.crossed":
      return "info";
    case "request.stalled":
    case "writers.observed":
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
