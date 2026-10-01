/**
 * Timing and bead actions of a rebuilt trace (WP-206.1.2; Dashboard Design
 * §4.3, §7.1; code review 2026-09-30 §4): how long the request and each of its
 * agents took, and which beads its reports and `br` commands name.
 *
 * Pure, like the rebuild it reads (`traces.ts`): a trace in, figures out.
 */
import { brActions } from "../shared/shell";
import { byAt } from "../shared/order";
import type { AgentTiming, Confidence, Evidence, ParsedReport, TurnTiming } from "../shared/contracts";
import type { AgentFacts, ReconstructedTrace } from "./traces";

/** Sentence printed next to every duration, so no number is read as machine time. */
export const TIMING_BASIS =
  "Wall-clock time, measured from the request to the last recorded activity. It includes any time spent waiting for you to answer.";

function msBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** Turn timings of the Manager records of a trace (design §7.1). */
export function managerTurns(trace: ReconstructedTrace): TurnTiming[] {
  return trace.records
    .filter((record) => record.role === "manager")
    .map((record) => ({
      turnId: record.turnId,
      startedAt: record.startedAt ?? record.sent[0]?.at ?? null,
      endedAt: record.endedAt,
      ms: msBetween(record.startedAt ?? record.sent[0]?.at ?? null, record.endedAt),
    }));
}

/**
 * Lifetime of one agent inside a trace.
 *
 * A Worker ends at its `finished` report, a Reviewer at its last `BM-REVIEW`;
 * without either, the last recorded activity is used. A running agent has no
 * end, so `ms` stays null rather than being measured against "now" — the UI
 * shows elapsed time instead (REQ-043d).
 */
export function agentTiming(
  agentId: string,
  role: "worker" | "reviewer",
  trace: ReconstructedTrace,
  agents: ReadonlyMap<string, AgentFacts>,
): AgentTiming {
  const own = trace.records.filter((record) => record.agentId === agentId);
  const startedAt = agents.get(agentId)?.createdAt ?? own[0]?.startedAt ?? own[0]?.at ?? null;
  const lastActivityAt = own.at(-1)?.at ?? null;

  const finishedAt =
    role === "worker"
      ? (trace.reports.filter((report) => report.agentId === agentId && report.phase === "finished").at(-1)?.at ??
        null)
      : (trace.reviews.filter((review) => review.agentId === agentId).at(-1)?.at ?? null);

  const status = agents.get(agentId)?.status ?? "closed";
  const endedAt = status === "running" ? null : (finishedAt ?? lastActivityAt);

  return {
    agentId,
    role,
    startedAt,
    lastActivityAt,
    ms: msBetween(startedAt, endedAt),
    state: status === "running" ? "running" : status === "error" ? "failed" : "completed",
  };
}

/** Total duration of a request, or null while anything is still running. */
export function totalMsOf(trace: ReconstructedTrace): number | null {
  if (trace.state === "running") return null;
  const finished = trace.reports.filter((report) => report.phase === "finished").at(-1)?.at ?? null;
  const lastRecord = trace.records.at(-1)?.at ?? null;
  const end = finished !== null && lastRecord !== null ? (finished > lastRecord ? finished : lastRecord) : (finished ?? lastRecord);
  return msBetween(trace.requestedAt, end);
}

/** Bead ids a trace touched, split by action, with the confidence of each source. */
export interface BeadActions {
  created: { ids: string[]; confidence: Confidence };
  updated: { ids: string[]; confidence: Confidence };
  closed: { ids: string[]; confidence: Confidence };
  ready: { ids: string[]; confidence: Confidence };
  evidenceById: Map<string, Evidence[]>;
}

/**
 * Collects bead actions from reports first, then from `br` commands seen in the
 * timeline.
 *
 * A report is `exact`; a command is `inferred`. When there is no report and no
 * command, the confidence is `unknown` — which is what stops the UI from
 * claiming "this request created no beads" (REQ-044c). Only a `finished` report
 * that says `beadsCreated: none` justifies that claim, and that shows up here
 * as an `exact` empty list.
 */
export function beadActionsOf(trace: ReconstructedTrace): BeadActions {
  const evidenceById = new Map<string, Evidence[]>();
  const add = (bucket: Set<string>, ids: readonly string[], evidence: Evidence | null) => {
    for (const id of ids) {
      bucket.add(id);
      if (evidence === null) continue;
      evidenceById.set(id, [...(evidenceById.get(id) ?? []), evidence]);
    }
  };

  const created = new Set<string>();
  const updated = new Set<string>();
  const closed = new Set<string>();
  const ready = new Set<string>();

  const reportEvidence = (report: ParsedReport): Evidence => ({
    kind: "report",
    detail: `BM-REPORT phase=${report.phase ?? "unknown"}`,
    agentId: report.agentId,
    at: report.at,
  });
  // Stable sort: reports with the same timestamp keep their order.
  const byTime = [...trace.reports].sort(byAt);
  for (const report of byTime) {
    const evidence = reportEvidence(report);
    add(created, report.beadsCreated, evidence);
    add(updated, report.beadsUpdated, evidence);
    add(closed, report.beadsClosed, evidence);
  }
  // `ready` is a state, not an action (delta 20260917 §5.2): only the latest
  // report says what is ready now. The 2026-09-16 run showed 3 ready beads
  // from `beads-done` although `finished` said `beadsReady: none`.
  const latest = byTime.at(-1);
  if (latest !== undefined) add(ready, latest.beadsReady, reportEvidence(latest));

  let sawCommand = false;
  for (const record of trace.records) {
    for (const evidence of record.evidence) {
      if (evidence.kind !== "shell") continue;
      for (const { verb, ids } of brActions(evidence.detail)) {
        if (ids.length === 0 && verb !== "create") continue;
        sawCommand = true;
        add(verb === "create" ? created : verb === "update" ? updated : closed, ids, evidence);
      }
    }
  }

  // A list the parser could not fully read is a lower bound (delta 20260917
  // §5.1): the count is then `inferred`, not `exact`.
  const confidenceFor = (fromReports: boolean, incomplete: boolean): Confidence =>
    fromReports ? (incomplete ? "inferred" : "exact") : sawCommand ? "inferred" : "unknown";
  const incompleteIn = (reports: readonly ParsedReport[], field: string): boolean =>
    reports.some((report) => (report.incompleteFields ?? []).includes(field));

  const reportedAny = trace.reports.length > 0;
  return {
    created: { ids: [...created], confidence: confidenceFor(reportedAny, incompleteIn(byTime, "beadsCreated")) },
    updated: { ids: [...updated], confidence: confidenceFor(reportedAny, incompleteIn(byTime, "beadsUpdated")) },
    closed: { ids: [...closed], confidence: confidenceFor(reportedAny, incompleteIn(byTime, "beadsClosed")) },
    ready: {
      ids: [...ready],
      confidence: confidenceFor(reportedAny, latest !== undefined && incompleteIn([latest], "beadsReady")),
    },
    evidenceById,
  };
}
