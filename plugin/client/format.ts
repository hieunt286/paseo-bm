/**
 * How the screens of the Beads Manager surface write a figure (WP-211.1;
 * Dashboard Design §2.1, REQ-041 → REQ-057): durations, moments, sizes, tokens
 * and cost, how sure a number is, and the cards and bars figures are drawn as.
 * Split from `dashboard-model.ts`, with `tone.ts` and `styles.ts` (code review
 * 2026-09-30 §4); one duration style and one date style for every screen
 * (§3.6).
 *
 * The wording rules are part of the product, not decoration:
 *
 * - every derived number says how sure it is (`exact` / `inferred` / `unknown`);
 * - a cost says whether it came from the tool or from the bundled price table,
 *   with the date of that table;
 * - a duration is labelled wall-clock, using the sentence the server sends.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { Confidence, Usage } from "../shared/contracts";
import { timeOrNull } from "../shared/time";

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

/** `3 h` and `3 h 5 min`: the larger unit, and the smaller one unless it is 0. */
function twoUnits(large: number, largeUnit: string, small: number, smallUnit: string): string {
  return small === 0 ? `${large} ${largeUnit}` : `${large} ${largeUnit} ${small} ${smallUnit}`;
}

/**
 * The one duration style: `450 ms`, `12 s`, `3 min 5 s`, `1 h 20 min`,
 * `2 d 3 h` — at most two units. `null` becomes an em dash, never `0` (REQ-043d).
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return twoUnits(minutes, "min", seconds % 60, "s");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return twoUnits(hours, "h", minutes % 60, "min");
  return twoUnits(Math.floor(hours / 24), "d", hours % 24, "h");
}

/** A span to the minute, in the same style: `under 1 min`, `12 min`, `3 h 5 min`, `2 d 3 h`. */
export function shortSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 1 ? "under 1 min" : formatDuration(minutes * 60_000);
}

/** How long ago `at` was (`shortSpan`); null when the time is unknown. */
export function spanSince(at: string | null, now: Date): string | null {
  const time = timeOrNull(at);
  return time === null ? null : shortSpan(now.getTime() - time);
}

/** `12 min ago`, `just now`, or `—` when the time is unknown. */
export function ago(at: string | null, now: Date): string {
  const span = spanSince(at, now);
  if (span === null) return "—";
  return span === "under 1 min" ? "just now" : `${span} ago`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The one date style, in the device's time zone: `15:40` today, `tomorrow 15:40`,
 * `yesterday 15:40`, else `Thu 24 Sep 15:40` — with the year when it is not this
 * year's (`Thu 24 Sep 2025 15:40`). "" for a time that does not read.
 */
export function localTimeText(at: Date, now: Date): string {
  if (Number.isNaN(at.getTime())) return "";
  const two = (value: number) => String(value).padStart(2, "0");
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  const dayOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((dayOf(at) - dayOf(now)) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  const year = at.getFullYear() === now.getFullYear() ? "" : ` ${at.getFullYear()}`;
  return `${WEEKDAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}${year} ${time}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/**
 * Cost with its basis. An estimate always carries the word "estimated" and the
 * date of the price table; an unknown model shows no money at all (REQ-052).
 */
export function formatCost(usage: Usage): string {
  if (usage.costBasis === "unavailable" || usage.costUsd === null) return "cost unavailable";
  const amount = usage.costUsd < 0.01 ? `$${usage.costUsd.toFixed(4)}` : `$${usage.costUsd.toFixed(2)}`;
  if (usage.costBasis === "provider") return `${amount} (reported by the tool)`;
  return `${amount} (estimated, prices of ${usage.pricesUpdatedAt ?? "unknown date"})`;
}

// ---------------------------------------------------------------------------
// Labels.
// ---------------------------------------------------------------------------

export function confidenceSuffix(confidence: Confidence): string {
  switch (confidence) {
    case "exact":
      return "";
    case "inferred":
      return " (inferred)";
    case "unknown":
      return " (unknown)";
  }
}

/**
 * Row title. A trace can exist without its request text — collection starts
 * when the plugin loads, so a request already in flight has no user turn on
 * record — and the screen has to say that instead of showing a blank line.
 */
export function excerptLine(excerpt: string | null): string {
  if (excerpt === null) return "Request text not recorded (this request started before the Dashboard did)";
  return excerpt.trim() === "" ? "(empty request)" : excerpt;
}

// ---------------------------------------------------------------------------
// Figures: cards and bars (Insights, and the Beads overview it shows).
// ---------------------------------------------------------------------------

export interface OverviewCard {
  label: string;
  value: string;
  hint: string;
}

export interface Bar {
  label: string;
  value: number;
  display: string;
  /** Opened when the bar is pressed. */
  agentId?: string;
  /** Second line under the label. */
  hint?: string;
}

/** Bar width as a share of the largest value, 0..1. */
export function barShare(bar: Bar, bars: readonly Bar[]): number {
  const max = Math.max(0, ...bars.map((entry) => entry.value));
  return max === 0 ? 0 : bar.value / max;
}
