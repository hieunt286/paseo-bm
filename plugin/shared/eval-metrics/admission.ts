/**
 * The admission evidence (autonomy design §F.2; evaluation design §4, "Also
 * reported"): for each error class a candidate specialist claims to catch —
 * written first in `docs/operations/paseo-bm-specialist-admission-template.md`
 * — the replay figure that shows whether the current roles miss it today. A
 * class no figure can measure is listed as such (`measured: false`): no
 * evidence, no candidate.
 *
 * Most classes reuse a figure that already measures them (review lift,
 * `writers-observed`, A-6, A-5, A-8). Two figures are new here:
 *
 * - **Verification** (`verificationFiguresOf`): the finished requests' check
 *   verdicts and the finished-unverified share (§C.2, §C.3), labelled by the
 *   very `requestFinishOf` the Work screen and `request.finished` read.
 * - **Worker reading** (`workerReadingOf`): the Worker's tokens read before its
 *   first change of the request — the context a read-only scout would take
 *   (PRD A-8: the Worker holds 93 % of the tokens).
 *
 * The admission evidence is computed beside `EvalMetrics`, not inside it: the
 * metric set, the Insights summary and the suite's averaged scorecard stay as
 * they are. Numbers only — the class ids and candidates are this module's own
 * constants, never store text.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { TraceRecord } from "../contracts";
import { CHECKS_VERDICTS, requestFinishOf, type ChecksVerdict } from "../evidence";
import { writtenFilesOf } from "../writers-observed";
import { ratio, roleOf } from "./helpers";
import type { EvalScope } from "./scope";
import { spreadOf, turnTokensOf, type TurnTokens } from "./tokens";
import type { EvalInput, EvalMetrics, Spread } from "./types";

// ── The catalogue: every class a candidate claims, and its query ────────────

/** The candidates of §F.2. */
export const ADMISSION_CANDIDATES = [
  "security reviewer",
  "independent tester",
  "read-only scout",
  "design committee of two model families",
  "per-Worker worktrees",
  "a cheaper model for a role",
] as const;
export type AdmissionCandidate = (typeof ADMISSION_CANDIDATES)[number];

/**
 * Each error class, the candidate that claims it, and whether a replay figure
 * measures it. The template lists the same classes in the same order; a new
 * claim is written there first, then added here with its query.
 */
export const ADMISSION_CLASSES = [
  { id: "unverified-finish", candidate: "independent tester", measured: true },
  { id: "worker-exploration", candidate: "read-only scout", measured: true },
  { id: "concurrent-writes", candidate: "per-Worker worktrees", measured: true },
  { id: "blocking-at-review", candidate: "design committee of two model families", measured: true },
  { id: "security-effect", candidate: "security reviewer", measured: true },
  { id: "security-flaw-after-review", candidate: "security reviewer", measured: false },
  { id: "role-cost", candidate: "a cheaper model for a role", measured: true },
] as const satisfies ReadonlyArray<{ id: string; candidate: AdmissionCandidate; measured: boolean }>;
export type AdmissionClassId = (typeof ADMISSION_CLASSES)[number]["id"];

// ── Verification: the independent tester's class ───────────────────────────

/** The finished requests' check verdicts (autonomy design §C.2, §C.3). */
export interface VerificationFigures {
  /** Finished requests in scope. */
  finished: number;
  /** Of `finished`: labelled — their latest report with a milestone is `finished`. */
  labelled: number;
  /** The labelled requests by their checks' verdict. */
  byChecks: Record<ChecksVerdict, number>;
  /** Labelled requests whose code changed: a report names a file, or a record edited or wrote one. */
  changedCode: number;
  /** Finished-unverified (`isFinishedUnverified`): code changed, named checks not all detected. */
  finishedUnverified: number;
  /** finishedUnverified ÷ the changed-code requests whose checks could be judged (not `not-checked`); null with none. */
  share: number | null;
  unknown: {
    /** Finished once, but a later report ended the finish: not labelled. */
    laterReportAfterFinish: number;
    /** Changed-code requests recorded before shell entries carried a status: left out of `share`. */
    changedCodeNotChecked: number;
  };
}

/** Labels each finished request's latest report against its records. Pure. */
export function verificationFiguresOf(scope: EvalScope, workspaceDirectories: EvalInput["workspaceDirectories"]): VerificationFigures {
  const byChecks = Object.fromEntries(CHECKS_VERDICTS.map((verdict) => [verdict, 0])) as Record<ChecksVerdict, number>;
  let labelled = 0;
  let changedCode = 0;
  let finishedUnverified = 0;
  let laterReportAfterFinish = 0;
  let changedCodeNotChecked = 0;
  for (const facts of scope.finishedRequests) {
    const workspaceId = facts.records[0]?.workspaceId ?? null;
    const finish = requestFinishOf({
      reports: facts.reports,
      records: facts.records,
      workspaceDirectory: workspaceId === null ? null : (workspaceDirectories?.[workspaceId] ?? null),
    });
    if (finish === null) {
      laterReportAfterFinish += 1;
      continue;
    }
    labelled += 1;
    byChecks[finish.checks] += 1;
    if (!finish.changedFiles) continue;
    changedCode += 1;
    if (finish.checks === "not-checked") changedCodeNotChecked += 1;
    if (finish.unverified) finishedUnverified += 1;
  }
  return {
    finished: scope.finishedRequests.length,
    labelled,
    byChecks,
    changedCode,
    finishedUnverified,
    share: ratio(finishedUnverified, changedCode - changedCodeNotChecked),
    unknown: { laterReportAfterFinish, changedCodeNotChecked },
  };
}

// ── Worker reading: the read-only scout's class ─────────────────────────────

/** The Worker's tokens read before its first change of a request (PRD A-8; §F.2's read-only scout). */
export interface WorkerReadingFigures {
  /** Finished requests in scope with a Worker turn. */
  requests: number;
  /** Of `requests`: a Worker wrote a file inside the workspace, and every Worker turn has usage. */
  withWrite: number;
  /** Tokens read (as the context figures count them) over those requests' Worker turns. */
  workerTokensRead: number;
  /** Of `workerTokensRead`: in the Worker turns before the first turn that wrote a file. The writing turn itself is not counted: a lower bound. */
  beforeFirstWrite: number;
  /** beforeFirstWrite ÷ workerTokensRead; null with none. */
  share: number | null;
  /** beforeFirstWrite per request. */
  perRequestBeforeFirstWrite: Spread;
  /** Requests whose Workers wrote no file inside the workspace (every Worker turn with usage), and their Worker tokens read. */
  withoutWrite: number;
  withoutWriteTokensRead: number;
  unknown: {
    /** Requests with a Worker turn without usage: in no figure. */
    requestsWithoutUsage: number;
  };
}

/**
 * Per finished request, its Worker turns in the metric order (every Worker of
 * the request, a handoff's successor included): the tokens read before the
 * first turn with a file edit or write inside the workspace folder
 * (`writtenFilesOf`), over all of them. Each turn is read beside its agent's
 * turn before it with usage, as the context figures read it. Pure.
 */
export function workerReadingOf(scope: EvalScope, workspaceDirectories: EvalInput["workspaceDirectories"]): WorkerReadingFigures {
  const turnTokens = new Map<TraceRecord, TurnTokens>();
  const lastWithUsage = new Map<string, TraceRecord>();
  for (const record of scope.records) {
    turnTokens.set(record, turnTokensOf(record, lastWithUsage.get(record.agentId) ?? null));
    if (record.usage !== null) lastWithUsage.set(record.agentId, record);
  }
  let requests = 0;
  let withWrite = 0;
  let workerTokensRead = 0;
  let beforeFirstWrite = 0;
  const perRequest: number[] = [];
  let withoutWrite = 0;
  let withoutWriteTokensRead = 0;
  let requestsWithoutUsage = 0;
  for (const facts of scope.finishedRequests) {
    const workerTurns = facts.records.filter((record) => roleOf(record) === "worker");
    if (workerTurns.length === 0) continue;
    requests += 1;
    const reads = workerTurns.map((record) => (turnTokens.get(record) ?? turnTokensOf(record)).tokensRead);
    if (reads.some((read) => read === null)) {
      requestsWithoutUsage += 1;
      continue;
    }
    const total = (reads as number[]).reduce((sum, read) => sum + read, 0);
    const first = workerTurns.findIndex((record) => writtenFilesOf(record, workspaceDirectories?.[record.workspaceId] ?? null).length > 0);
    if (first < 0) {
      withoutWrite += 1;
      withoutWriteTokensRead += total;
      continue;
    }
    const before = (reads as number[]).slice(0, first).reduce((sum, read) => sum + read, 0);
    withWrite += 1;
    workerTokensRead += total;
    beforeFirstWrite += before;
    perRequest.push(before);
  }
  return {
    requests,
    withWrite,
    workerTokensRead,
    beforeFirstWrite,
    share: ratio(beforeFirstWrite, workerTokensRead),
    perRequestBeforeFirstWrite: spreadOf(perRequest),
    withoutWrite,
    withoutWriteTokensRead,
    unknown: { requestsWithoutUsage },
  };
}

// ── The evidence per class ──────────────────────────────────────────────────

/** One class's evidence: its figures (numbers or null — unknown, never 0), none when it is not measured. */
export interface AdmissionClassEvidence {
  id: AdmissionClassId;
  candidate: AdmissionCandidate;
  /** False: no replay figure measures the class. */
  measured: boolean;
  figures: Record<string, number | null>;
}

export interface AdmissionEvidence {
  /** Finished requests in scope, which every figure below is over unless it says otherwise. */
  finishedRequests: number;
  /** Every class of `ADMISSION_CLASSES`, in its order. */
  classes: AdmissionClassEvidence[];
  /** The two figures this module adds, in full. */
  verification: VerificationFigures;
  workerReading: WorkerReadingFigures;
}

/** The figures of one class, from the metric set and the two new figures. */
function figuresOf(
  id: AdmissionClassId,
  metrics: EvalMetrics,
  verification: VerificationFigures,
  reading: WorkerReadingFigures,
): Record<string, number | null> {
  switch (id) {
    case "unverified-finish":
      return {
        changedCode: verification.changedCode,
        finishedUnverified: verification.finishedUnverified,
        share: verification.share,
        detected: verification.byChecks.detected,
        selfReported: verification.byChecks["self-reported"],
        unverified: verification.byChecks.unverified,
        changedCodeNotChecked: verification.unknown.changedCodeNotChecked,
      };
    case "worker-exploration":
      return {
        requests: reading.withWrite,
        workerTokensRead: reading.workerTokensRead,
        beforeFirstWrite: reading.beforeFirstWrite,
        share: reading.share,
        medianBeforeFirstWrite: reading.perRequestBeforeFirstWrite.median,
        // A-8's Worker part of every finished request's tokens (input + cached + output).
        workerShareOfTokens: ratio(metrics.a8.tokens.byRole.worker, metrics.a8.tokens.total),
        requestsWithoutUsage: reading.unknown.requestsWithoutUsage,
      };
    case "concurrent-writes": {
      const writers = metrics.supplementary.writersObserved;
      return { pairs: writers.pairs, files: writers.files, unknownPairs: writers.unknownPairs };
    }
    case "blocking-at-review": {
      const { Medium, Large } = metrics.reviewLift.byTier;
      const owner = metrics.a5.owner;
      return {
        mediumBatches: Medium.batches,
        mediumBlockingPerBatch: Medium.blockingPerBatch,
        largeBatches: Large.batches,
        largeBlockingPerBatch: Large.blockingPerBatch,
        ownerDecisions: owner.decisions,
        ownerReversed: owner.reversed,
        ownerReversalRate: owner.rate,
      };
    }
    case "security-effect": {
      const { a6 } = metrics;
      return {
        effectful: a6.total,
        notShownAuthorised: a6.notShownAuthorised,
        estimateCalls: a6.estimate.calls,
        estimateSecurity: a6.estimate.byClass.security,
      };
    }
    case "security-flaw-after-review":
      // A review carries counts, not the kind of finding, and the replay reads no text: nothing measures it.
      return {};
    case "role-cost": {
      const per = metrics.a8.perFinishedRequest;
      return {
        managerPerFinishedRequest: per?.byRole.manager ?? null,
        workerPerFinishedRequest: per?.byRole.worker ?? null,
        reviewerPerFinishedRequest: per?.byRole.reviewer ?? null,
        orchestratorPerFinishedRequest: metrics.a8.orchestrator.perFinishedRequest,
        medianPerFinishedRequest: metrics.a8.medianPerFinishedRequest,
        finishedRequestsWithMissingUsage: metrics.a8.finishedRequestsWithMissingUsage,
      };
    }
  }
}

/**
 * The admission evidence of one scope: `metrics` is `computeEvalMetrics` of
 * the same `scope`'s input. Pure and deterministic.
 */
export function admissionEvidenceOf(scope: EvalScope, metrics: EvalMetrics, workspaceDirectories: EvalInput["workspaceDirectories"]): AdmissionEvidence {
  const verification = verificationFiguresOf(scope, workspaceDirectories);
  const workerReading = workerReadingOf(scope, workspaceDirectories);
  return {
    finishedRequests: scope.finishedRequests.length,
    classes: ADMISSION_CLASSES.map((entry) => ({
      id: entry.id,
      candidate: entry.candidate,
      measured: entry.measured,
      figures: figuresOf(entry.id, metrics, verification, workerReading),
    })),
    verification,
    workerReading,
  };
}
