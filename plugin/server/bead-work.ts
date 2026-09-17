/**
 * Who is working on a bead, and since when, read from the trace store.
 *
 * The bead store cannot say: `br` records no start time, and Workers do not set
 * an assignee. What the store of traces does have is every shell command a
 * Worker ran and every report it sent, so:
 *
 * - **started**: the latest Worker command that moved the bead to
 *   `in_progress` (`br update <id> --status in_progress` or `--claim`);
 * - **last**: the latest Worker command or `BM-REPORT` that named the bead.
 *
 * Only Worker turns count: a Reviewer reading a bead with `br show` is not
 * working on it. Pure: records and agents in, marks out.
 */
import { brActions } from "./shell";
import type { AgentFacts } from "./traces";
import type { BeadWork, TraceRecord } from "../shared/contracts";

interface Seen {
  agentId: string;
  at: string;
}

/** A matcher for `id` as a whole id (`bm-a.1` does not match `bm-a.12`). */
function wholeId(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`);
}

/** True when `text` names `id` as a whole id. */
export function namesBead(text: string, id: string): boolean {
  return wholeId(id).test(text);
}

export function beadWorkOf(
  beadIds: readonly string[],
  records: readonly TraceRecord[],
  agents: ReadonlyMap<string, AgentFacts>,
): Map<string, BeadWork> {
  const started = new Map<string, Seen>();
  const last = new Map<string, Seen>();
  const later = (map: Map<string, Seen>, id: string, seen: Seen) => {
    const current = map.get(id);
    if (current === undefined || current.at <= seen.at) map.set(id, seen);
  };

  // Built once: the loop below runs them over every Worker command.
  const matchers = beadIds.map((id) => [id, wholeId(id)] as const);
  for (const record of records) {
    if (record.role !== "worker") continue;
    for (const evidence of record.evidence) {
      if (evidence.kind !== "shell") continue;
      const seen = { agentId: record.agentId, at: evidence.at ?? record.at };
      const actions = brActions(evidence.detail);
      const startedIds = new Set(actions.flatMap((action) => (action.startsWork ? action.ids : [])));
      for (const [id, matcher] of matchers) {
        if (startedIds.has(id)) later(started, id, seen);
        if (matcher.test(evidence.detail)) later(last, id, seen);
      }
    }
    for (const report of record.reports) {
      const named = new Set([...report.beadsCreated, ...report.beadsUpdated, ...report.beadsClosed, ...report.beadsReady]);
      for (const id of beadIds) {
        if (named.has(id)) later(last, id, { agentId: report.agentId, at: report.at });
      }
    }
  }

  const mark = (seen: Seen | undefined) => {
    if (seen === undefined) return null;
    const agent = agents.get(seen.agentId);
    return { ...seen, title: agent?.title ?? null, status: agent?.status ?? null };
  };
  const out = new Map<string, BeadWork>();
  for (const id of beadIds) {
    if (!started.has(id) && !last.has(id)) continue;
    out.set(id, { started: mark(started.get(id)), last: mark(last.get(id)) });
  }
  return out;
}
