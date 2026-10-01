/**
 * The handoff's shared vocabulary (autonomy design §G.6; PRD REQ-135; bead
 * `7gxw.11`): what the successor Worker's first message starts with, and how
 * the pure readers — Work's timeline, the detected evidence — recognise it.
 *
 * The brief is the plugin's (`server/handoff.ts` builds it from the stores),
 * but it reaches the successor as the Manager's `create_agent` first message,
 * so it is not a plugin notice: its marker is `BM-HANDOFF-BRIEF`, which the
 * notice list's whole-word `BM-HANDOFF` (the plugin's note request) does not
 * match. The Manager may put words before it, so the marker is looked for at
 * the start of any line.
 *
 * It also holds the two readings of a request the handoff's threshold and
 * refusals share (§G.7): its tokens read since it started or since its last
 * handoff, and whether it is finished.
 *
 * `shared/`, pure: no Node and no React Native imports.
 */
import type { TraceRecord } from "./contracts";
import { turnTokensOf } from "./eval-metrics/tokens";
import { timeOrNull } from "./time";

/** First line of a handoff brief: `BM-HANDOFF-BRIEF <handoff id>`. */
export const HANDOFF_BRIEF_MARKER = "BM-HANDOFF-BRIEF";

/** The longest note the outgoing Worker writes (`bm_report` `handoffNote`, design §G.6 step 1). */
export const MAX_HANDOFF_NOTE_CHARS = 1_500;

const BRIEF_LINE = new RegExp(`^\\s*${HANDOFF_BRIEF_MARKER}(?:\\s|$)`);
const REPLACES_LINE = /^\s*replaces:\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*$/;

/** True when `text` holds a handoff brief: a line that starts with its marker. Pure. */
export function holdsHandoffBrief(text: unknown): boolean {
  return typeof text === "string" && text.split("\n").some((line) => BRIEF_LINE.test(line));
}

/** The outgoing Worker a brief names on its `replaces:` line, or null. Pure. */
export function handoffBriefReplaces(text: unknown): string | null {
  if (!holdsHandoffBrief(text)) return null;
  for (const line of (text as string).split("\n")) {
    const match = REPLACES_LINE.exec(line);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** When a record ended, as far as it says. */
const endOf = (record: Pick<TraceRecord, "endedAt" | "at">): number | null => timeOrNull(record.endedAt) ?? timeOrNull(record.at);

/**
 * A request's tokens read (design §G.7, change-008 C2): the sum of
 * `turnTokensOf` over every turn of it, whatever the role, that ended after
 * `since` (its last handoff; every turn when null), each beside its agent's
 * turn before it that had usage. Null when none of those turns had usage.
 * Pure.
 */
export function requestTokensReadOf(records: readonly TraceRecord[], requestId: string, since: number | null): number | null {
  const ordered = records
    .map((record) => ({ record, end: endOf(record) }))
    .filter((entry): entry is { record: TraceRecord; end: number } => entry.end !== null)
    .sort((a, b) => a.end - b.end);
  const previous = new Map<string, TraceRecord>();
  let total: number | null = null;
  for (const { record, end } of ordered) {
    if (record.requestId === requestId && (since === null || end > since)) {
      const read = turnTokensOf(record, previous.get(record.agentId) ?? null).tokensRead;
      if (read !== null) total = (total ?? 0) + read;
    }
    if (record.usage !== null) previous.set(record.agentId, record);
  }
  return total;
}

/** Whether the request's latest report, by time, is `finished` (the stall pass's reading). Pure. */
export function requestFinishedOf(records: readonly TraceRecord[], requestId: string): boolean {
  let latest: { at: number; phase: string | null } | null = null;
  for (const record of records) {
    for (const report of record.reports) {
      if ((report.requestId ?? record.requestId) !== requestId || report.phase === null) continue;
      const at = timeOrNull(report.at) ?? endOf(record) ?? 0;
      if (latest === null || at >= latest.at) latest = { at, phase: report.phase };
    }
  }
  return latest?.phase === "finished";
}
