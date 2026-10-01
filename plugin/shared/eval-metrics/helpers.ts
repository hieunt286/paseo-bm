/**
 * The small pure helpers of the metrics: times, medians and percentiles, the
 * reading of an answer's choice, the window's bounds and the total orders that
 * keep the output independent of input order. The public ones are re-exported
 * by `shared/eval-metrics.ts`; the suite's scoring reuses them.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { TraceRecord } from "../contracts";
import { EVAL_ROLES, type EvalRole, type EvalWindow, type RoleCounts } from "./types";
import { timeOrNull } from "../time";

// ── Small pure helpers (the scoring reuses them) ────────────────────────────

/** The median; the mean of the two middle values for an even count; null for none. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Nearest-rank percentile (`p` in 0–100); null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Question text as A-2 (b) compares it: NFC, lower case, whitespace runs made one space. */
export function normaliseQuestionText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** What an answer line chose: an option's key, the owner's own words, or null when unreadable. */
export type AnswerChoice = { key: string } | { other: string };

const OTHER_ANSWER = /^other\b\s*(?:[—–:-]\s*)?(.*)$/is;
const OPTION_ANSWER = /^\(?([a-z])\)?(?![\p{L}\p{N}_])/iu;

/**
 * The choice of one answer (the text after `Qn:`), as `answersText` writes it
 * (`a — <option>`, `other — <words>`) or a person types it (`a`, `(a)`).
 * `optionKeys`, when given, must hold the key: "I think…" is not option `i`.
 */
export function answerChoiceOf(text: string, optionKeys?: readonly string[]): AnswerChoice | null {
  const trimmed = text.trim();
  const other = OTHER_ANSWER.exec(trimmed);
  if (other !== null) return { other: normaliseQuestionText(other[1] ?? "") };
  const option = OPTION_ANSWER.exec(trimmed);
  if (option === null) return null;
  const key = option[1]!.toLowerCase();
  if (optionKeys !== undefined && !optionKeys.includes(key)) return null;
  return { key };
}

export function sameChoice(a: AnswerChoice, b: AnswerChoice): boolean {
  if ("key" in a) return "key" in b && a.key === b.key;
  return "other" in b && a.other === b.other;
}

/** The workspace of a `stalls.json` key (`<ws>::…`), or null when the key has none. */
export function workspaceOfStallKey(key: string): string | null {
  const end = key.indexOf("::");
  return end > 0 ? key.slice(0, end) : null;
}

// ── Reading the records ─────────────────────────────────────────────────────

/** A window's bounds in milliseconds; `null` leaves that side open. */
export interface Bounds {
  since: number | null;
  until: number | null;
}

/** The time bounds of a window; throws on a bound that is not a time (a caller's mistake). */
export function boundsOf(window: EvalWindow): Bounds {
  const bound = (value: string | null, name: string): number | null => {
    if (value === null) return null;
    const ms = timeOrNull(value);
    if (ms === null) throw new Error(`eval window: ${name} is not a time: ${JSON.stringify(value)}`);
    return ms;
  };
  return { since: bound(window.since, "since"), until: bound(window.until, "until") };
}

export function within(ms: number | null, bounds: Bounds): boolean {
  if (bounds.since === null && bounds.until === null) return true;
  if (ms === null) return false;
  return (bounds.since === null || ms >= bounds.since) && (bounds.until === null || ms <= bounds.until);
}

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Oldest first; an unknown time sorts first. */
export const compareTimes = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a - b);

/** A total order on records, so input order never changes the output. */
export function compareRecords(a: TraceRecord, b: TraceRecord): number {
  return (
    compareText(a.at, b.at) ||
    compareText(a.agentId, b.agentId) ||
    compareText(a.turnId ?? "", b.turnId ?? "") ||
    compareText(a.startedAt ?? "", b.startedAt ?? "") ||
    compareText(JSON.stringify(a), JSON.stringify(b))
  );
}

/**
 * When a turn started: its start mark, else the earliest time in it — a
 * message that reached it or a piece of its evidence (a tool call, a report,
 * a compaction). Everything in a turn happens at or after its start, so the
 * earliest time known is the closest bound; null when the turn has none. The
 * suite's scoring (`scripts/eval/score.ts`) times its turns with it too.
 */
export function recordStart(record: TraceRecord): number | null {
  const started = timeOrNull(record.startedAt);
  if (started !== null) return started;
  const times = [...record.sent.map((message) => timeOrNull(message.at)), ...record.evidence.map((item) => timeOrNull(item.at))].filter(
    (ms): ms is number => ms !== null,
  );
  return times.length === 0 ? null : Math.min(...times);
}

export const tokensOf = (record: TraceRecord): number =>
  record.usage === null ? 0 : record.usage.inputTokens + record.usage.cachedInputTokens + record.usage.outputTokens;

export const zeroRoles = (): RoleCounts => ({ manager: 0, worker: 0, reviewer: 0, orchestrator: 0, unknown: 0 });
export const roleOf = (record: TraceRecord): EvalRole => ((EVAL_ROLES as readonly string[]).includes(record.role) ? record.role : "unknown");

export const keyOf = (requestId: string, id: string): string => `${requestId}\u0000${id}`;

export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
