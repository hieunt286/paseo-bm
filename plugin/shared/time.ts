/**
 * An ISO time as epoch milliseconds, for ordering and comparing (code review
 * 2026-09-30 §3.6). A caller that needs NaN for a time that does not read
 * calls `Date.parse` itself.
 *
 * Pure and environment-neutral.
 */

/** Epoch milliseconds of `at`; null when it is absent or does not read. */
export function timeOrNull(at: string | null | undefined): number | null {
  if (typeof at !== "string") return null;
  const time = Date.parse(at);
  return Number.isNaN(time) ? null : time;
}

/** Epoch milliseconds of `at`; 0 when it is absent or does not read, so it sorts first. */
export function timeOrZero(at: string | null | undefined): number {
  return timeOrNull(at) ?? 0;
}
