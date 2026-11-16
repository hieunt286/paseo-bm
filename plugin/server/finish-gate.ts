/**
 * The finish gate (ADR-045 decision 2, mission line plan §5.2): whether a
 * request, read over its continuation chain, may go further.
 *
 * `bm_report` computes it on every `finished`, before storing, and writes the
 * final result as the first act of the report's `before` step
 * (`noteFinishGate`), so a pass that sees `finished` sees the result. Each
 * failing condition is one short clause:
 *
 * - the head's `finished` with `remaining`;
 * - a Medium or Large chain with changed files whose newest `wave` or
 *   `finished` batch has no passing latest result (a plan batch never counts,
 *   nor a batch an older build opened with no milestone);
 * - any adopted batch without a passing latest result;
 * - a non-empty `reviewFindingsOpen` in the head's report;
 * - changed files with checks neither `detected` nor `reused`, read from the
 *   newest report of the chain that names checks, against the records of
 *   every Worker of every request of the chain and the reporter's live tail;
 * - changed files not committed, or changed outside a placement, by the
 *   newest commit reported in the chain;
 * - with `integration.ci` on, a CI `failure` (local checks are required
 *   either way: a green or pending pipeline adds nothing).
 *
 * A request with no predecessor and no changed file passes; a continuation
 * with none is judged on its chain, so its predecessor's work must have gone
 * through. Changed files are the union of the chain's `filesChanged` and of
 * the paths its Workers' records edited, and a reported commit counts as a
 * change: a shell-only merge, cherry-pick or generated commit edits through no
 * file tool, and its sha is what the local merge moves the owner's branch to.
 * What cannot be read fails, with a reason.
 *
 * `finishGateOf` is pure. `readFinishGate` reads its input and never throws.
 */
import { join } from "node:path";
import { outboxBlocksOf } from "./collector";
import { integrationCiOf } from "./coordination-store";
import { TRACES_DIR_NAME } from "./data-home";
import { committedOf } from "./line-state";
import type { Placement } from "./mission-store";
import { createOutbox } from "./outbox";
import { bmAgentsOf, type DashboardPaseo } from "./paseo-directory";
import type { GitRunner } from "./repo-tool";
import { createRequestRegistry, type ReviewBatch } from "./request-registry";
import { batchResultsOf, isPassVerdict } from "./review-tools";
import { reasonOf } from "./role-choices";
import { readRecords } from "./trace-store";
import { chainOf, locateRequest } from "./waits";
import type { IntegrationCi } from "../shared/coordination";
import type { ParsedReport, ParsedReview, TraceRecord, Tier } from "../shared/contracts";
import { checksVerified, namedChecksOf, verificationOf, type VerificationRecord } from "../shared/evidence";
import { timeOrZero } from "../shared/time";

/** What the gate reads of one report. */
export type FinishGateReport = Pick<ParsedReport, "at" | "phase" | "tier" | "filesChanged" | "beadsClosed" | "reviewFindingsOpen" | "buildAndTests" | "remaining" | "integration">;

/** What the gate reads of one review batch; `adoptedFrom` names the request a continuation took it from (ADR-045 decision 10). */
export type FinishGateBatch = Pick<ReviewBatch, "batchId" | "milestone" | "results"> & { adoptedFrom?: string };

/** One request of the chain. */
export interface FinishGateRequest {
  requestId: string;
  tier: Tier | null;
  batches: readonly FinishGateBatch[];
  /** The reviews of its records: the results of a batch an older build opened (`batchResultsOf`). */
  traceReviews: readonly ParsedReview[];
  /** Oldest first; the head's newest is the `finished` being judged. */
  reports: readonly FinishGateReport[];
}

export interface FinishGateInput {
  /** Root to head. */
  chain: readonly FinishGateRequest[];
  /** Every Worker's record of every request of the chain, with the reporter's live tail, in time order. */
  records: readonly VerificationRecord[];
  workspaceDirectory: string | null;
  /** The chain's Workers that took a request over by a handoff (`VerificationInput`). */
  handoffSuccessors?: ReadonlySet<string>;
  /** The reporting workspace is a mission's placement. */
  inPlacement: boolean;
  /** `committedOf` of the chain's newest commit; null when there is no commit or no placement to read it in. */
  committed: { committed: true } | { committed: false; why: string } | null;
  /** The owner's `integration.ci`. */
  ci: IntegrationCi;
  /** What could not be read, one clause each: each fails the gate. */
  unreadable: readonly string[];
}

export interface FinishGateVerdict {
  passed: boolean;
  reasons: string[];
}

const MILESTONES_THAT_REVIEW: ReadonlySet<string> = new Set(["wave", "finished"]);

/** Head first, each request newest report first. */
function reportsNewestFirst(chain: readonly FinishGateRequest[]): FinishGateReport[] {
  return [...chain].reverse().flatMap((request) => [...request.reports].reverse());
}

/** The git fields of the newest report in the chain naming a commit (the head's first); null when none does. Pure. */
export function newestIntegrationOf(chain: readonly FinishGateRequest[]): NonNullable<ParsedReport["integration"]> | null {
  return reportsNewestFirst(chain).find((report) => report.integration?.commit !== undefined)?.integration ?? null;
}

const passedLatest = (batch: FinishGateBatch, request: FinishGateRequest): boolean => isPassVerdict(batchResultsOf(batch, request.traceReviews).at(-1)?.verdict);

/** The newest `wave` or `finished` batch of the chain, head first, each request's newest first. */
function newestReviewBatchOf(chain: readonly FinishGateRequest[]): { batch: FinishGateBatch; request: FinishGateRequest } | null {
  for (const request of [...chain].reverse()) {
    const batch = request.batches.findLast((entry) => entry.milestone !== undefined && MILESTONES_THAT_REVIEW.has(entry.milestone));
    if (batch !== undefined) return { batch, request };
  }
  return null;
}

/** Adopted batches whose latest result is no pass; a copy a later request of the chain adopted in turn is that request's to clear. */
function openAdoptedBatchesOf(chain: readonly FinishGateRequest[]): FinishGateBatch[] {
  return chain.flatMap((request, index) =>
    request.batches.filter(
      (batch) =>
        batch.adoptedFrom !== undefined &&
        !passedLatest(batch, request) &&
        !chain.slice(index + 1).some((later) => later.batches.some((entry) => entry.batchId === batch.batchId && entry.adoptedFrom === request.requestId)),
    ),
  );
}

/** A request's tier: its newest report's that names one, else the registry's. */
const tierOf = (request: FinishGateRequest): Tier | null => request.reports.findLast((report) => report.tier !== null)?.tier ?? request.tier;

/** Whether the chain passes the finish gate, and why not (see the module comment). Pure. */
export function finishGateOf(input: FinishGateInput): FinishGateVerdict {
  const { chain, records } = input;
  const reasons = [...input.unreadable];
  const report = chain.at(-1)?.reports.at(-1);
  if (report === undefined) return { passed: false, reasons: reasons.length > 0 ? reasons : ["the finished report could not be read"] };
  if (report.phase !== "finished") reasons.push("the newest report is not finished");
  if ((report.remaining ?? []).length > 0) reasons.push("it left work for a continuation");

  const changed = newestIntegrationOf(chain) !== null || chain.some((request) => request.reports.some((entry) => entry.filesChanged.length > 0)) || records.some((record) => record.evidence.some((entry) => entry.kind === "file"));

  const openAdopted = openAdoptedBatchesOf(chain);
  // A tier that cannot be read counts as one that needs a review.
  if (changed && chain.some((request) => tierOf(request) !== "Small")) {
    const newest = newestReviewBatchOf(chain);
    if (newest === null) reasons.push("the changed files have no wave or finished review");
    else if (!passedLatest(newest.batch, newest.request) && !openAdopted.includes(newest.batch)) reasons.push(`review batch ${newest.batch.batchId} has not passed`);
  }
  for (const batch of openAdopted) reasons.push(`adopted review batch ${batch.batchId} has not passed`);

  if (report.reviewFindingsOpen !== null) reasons.push("review findings are still open");

  if (changed) {
    const naming = reportsNewestFirst(chain).find((entry) => namedChecksOf(entry.buildAndTests).length > 0);
    if (naming === undefined) reasons.push("no report of the chain names its checks");
    else {
      const { checks } = verificationOf({ report: naming, records, workspaceDirectory: input.workspaceDirectory, ...(input.handoffSuccessors === undefined ? {} : { handoffSuccessors: input.handoffSuccessors }) });
      if (!checksVerified(checks)) reasons.push(`its checks are ${checks}, neither detected nor reused`);
    }
    if (!input.inPlacement) reasons.push("files changed outside a placement");
    else if (newestIntegrationOf(chain) === null) reasons.push("the changed files have no reported commit");
    else if (input.committed === null) reasons.push("the reported commit could not be read");
    else if (!input.committed.committed) reasons.push(`the changed files are not committed: ${input.committed.why}`);
  }

  if (input.ci === "on" && newestIntegrationOf(chain)?.ci === "failure") reasons.push("CI failed on the reported commit");
  return { passed: reasons.length === 0, reasons };
}

/** The line a `finished` delivery gains when the gate failed. Pure. */
export function finishGateLineOf(reasons: readonly string[]): string {
  return `finish gate not passed: ${reasons.join("; ")}`;
}

/** What `readFinishGate` is told of the report in hand. */
export interface FinishGateRead {
  workspaceId: string;
  requestId: string;
  /** The `finished` report being judged, parsed from its text; null when it cannot be read. */
  report: ParsedReport | null;
  /** The placement of the reporting workspace; null for any other workspace. */
  place: Placement | null;
  /** The reporting Worker's live tail (`liveRecordOf`), for the turn not yet recorded. */
  live: VerificationRecord;
  paseo: unknown;
}

/** The chain's Workers a handoff brought in (their `bm.handoffFrom` label); none when Paseo cannot be read. */
async function handoffSuccessorsAmong(paseo: unknown, workerIds: ReadonlySet<string>): Promise<Set<string>> {
  try {
    const agents = await bmAgentsOf(paseo as DashboardPaseo);
    return new Set(agents.filter(({ facts }) => workerIds.has(facts.id) && (facts.handoffFrom ?? "") !== "").map(({ facts }) => facts.id));
  } catch {
    return new Set();
  }
}

/** The gate for the report in hand, read over its chain, with the chain's newest reported commit. Never throws: what cannot be read fails it. */
export async function readFinishGate(home: string, read: FinishGateRead, deps: { git?: GitRunner; log: (message: string) => void }): Promise<FinishGateVerdict & { commit: string | null }> {
  try {
    const registry = createRequestRegistry(home, { log: deps.log });
    const located = chainOf(home, read.requestId, read.workspaceId).reverse().map((id) => ({ id, found: locateRequest(home, id, read.workspaceId, registry) }));
    const unreadable = located.filter(({ found }) => found === null).map(({ id }) => `request ${id} of its chain could not be read`);
    const known = located.flatMap(({ found }) => (found === null ? [] : [found]));
    const ids = new Set(known.map(({ request }) => request.requestId));
    // A request that moved keeps its records and outbox under the workspaces it left (delivery line design §4.8).
    const workspaces = new Set(known.flatMap(({ workspaceId, request }) => [workspaceId, ...(request.movedFrom ?? []).map((entry) => entry.workspaceId)]));
    const records: TraceRecord[] = [];
    const stored: ParsedReport[] = [];
    for (const workspaceId of workspaces) {
      const trace = readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, workspaceId);
      if (trace.limitedRead) unreadable.push("the trace store is newer than this build and could not be read in full");
      records.push(...trace.records.filter((record) => record.requestId !== null && ids.has(record.requestId)));
      for (const record of createOutbox(home).list(workspaceId)) {
        if (record.kind === "report" && ids.has(record.requestId ?? "")) stored.push(...outboxBlocksOf([record], record.from).reports);
      }
    }
    records.sort((a, b) => timeOrZero(a.endedAt) - timeOrZero(b.endedAt));
    const chain: FinishGateRequest[] = known.map(({ request }) => ({
      requestId: request.requestId,
      tier: request.tier,
      batches: request.reviews.batches,
      traceReviews: records.filter((record) => record.requestId === request.requestId).flatMap((record) => record.reviews),
      reports: [...records.flatMap((record) => record.reports), ...stored].filter((report) => report.requestId === request.requestId).sort((a, b) => timeOrZero(a.at) - timeOrZero(b.at)),
    }));
    const head = chain.at(-1);
    if (head !== undefined && read.report !== null) head.reports = [...head.reports, read.report];
    const commit = newestIntegrationOf(chain)?.commit ?? null;
    const committed = read.place === null || commit === null ? null : await committedOf(home, read.place, commit, deps.git === undefined ? {} : { git: deps.git });
    const verdict = finishGateOf({
      chain,
      // ADR-045 decision 2: the chain's Workers alone; a Reviewer's scratch file or own run is neither an edit nor a check of the step.
      records: [...records.filter((record) => record.role === "worker"), read.live],
      workspaceDirectory: read.place?.directory ?? null,
      handoffSuccessors: await handoffSuccessorsAmong(read.paseo, new Set(known.flatMap(({ request }) => request.workerIds))),
      inPlacement: read.place !== null,
      committed,
      ci: integrationCiOf(home),
      unreadable,
    });
    return { ...verdict, commit };
  } catch (error) {
    return { passed: false, reasons: [`the request could not be read: ${reasonOf(error)}`], commit: null };
  }
}
