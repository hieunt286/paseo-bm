/**
 * How a count and a long line are written, in what the screens show and in
 * what the plugin tells an agent (code review 2026-09-30 §3.6).
 *
 * Pure and environment-neutral.
 */

/** `1 bead`, `3 beads`; `many` for a plural that is not `one` + `s` (`1 item needs`, `2 items need`). */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `text` on one line, cut to at most `max` characters with an ellipsis. */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}
