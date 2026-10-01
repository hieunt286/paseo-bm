/**
 * The request- and turn-level figures (evaluation design §4): A-11 (time to
 * finished, owner wait excluded), review lift per tier and workspace (autonomy
 * design §C.4) and the supplementary figures read from the requests' reports,
 * reviews and turns — among them what the retired runtime rules flagged
 * (`supplementary.process`, autonomy design §B.9).
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { ParsedReview, Tier, TraceRecord } from "../contracts";
import { guessLanguage } from "../language-guess";
import { isProcessDocumentPath } from "../orchestrator-rules";
import { brActions } from "../shell";
import { compareText, median, push, ratio, roleOf, tokensOf, zeroRoles } from "./helpers";
import type { QuestionOutcome } from "./questions";
import type { EvalScope, RequestFacts } from "./scope";
import { EVAL_ROLES, REVIEW_TIERS, type EvalMetrics, type EvalUnknowns, type ReviewLiftFigures, type ReviewLiftSplit, type RoleCounts } from "./types";

type Supplementary = EvalMetrics["supplementary"];

/** True when a shell line runs `br create` for real, as the server's bead readers read it (`shell.ts` `brActions`). */
function runsBrCreate(line: string): boolean {
  return brActions(line).some((action) => action.verb === "create");
}

/** The other of the two languages `guessLanguage` tells apart; none for `unknown`. */
const OTHER_LANGUAGE: Readonly<Record<string, "vi" | "en">> = { vi: "en", en: "vi" };

/** A-11: first turn start → first finished report, less the owner-wait intervals. */
export function a11Of(finishedRequests: readonly RequestFacts[], outcomes: readonly QuestionOutcome[], unknowns: EvalUnknowns): EvalMetrics["a11"] {
  const ownerWaitIntervals = new Map<string, Array<[number, number]>>();
  for (const { question, ownerWait } of outcomes) if (ownerWait !== null) push(ownerWaitIntervals, question.requestId, ownerWait);
  const durations: number[] = [];
  for (const facts of finishedRequests) {
    if (facts.start === null || facts.finishedAt === null || facts.finishedAt < facts.start) {
      unknowns.requestsWithoutDuration += 1;
      continue;
    }
    const start = facts.start;
    const end = facts.finishedAt;
    const clipped = (ownerWaitIntervals.get(facts.id) ?? [])
      .map(([from, to]): [number, number] => [Math.max(from, start), Math.min(to, end)])
      .filter(([from, to]) => to > from)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let waited = 0;
    let reach = start;
    for (const [from, to] of clipped) {
      if (to <= reach) continue;
      waited += to - Math.max(from, reach);
      reach = to;
    }
    durations.push(end - start - waited);
  }
  return { medianMs: median(durations), requests: durations.length };
}

/** The Worker's `blocked` reports, and the requests with at least one. */
export function roundsBlockedOf(inScope: readonly RequestFacts[]): Supplementary["roundsBlocked"] {
  let rounds = 0;
  let blockedRequests = 0;
  for (const facts of inScope) {
    const blocked = facts.reports.filter((report) => report.phase === "blocked").length;
    rounds += blocked;
    if (blocked > 0) blockedRequests += 1;
  }
  return { rounds, requestsBlockedAtLeastOnce: blockedRequests, perRequest: ratio(rounds, inScope.length) };
}

/** Each request's reported tier: `changed` when it reported more than one, `unknown` when none. */
export function tierMixOf(inScope: readonly RequestFacts[]): Supplementary["tierMix"] {
  const tierMix = { Small: 0, Medium: 0, Large: 0, changed: 0, unknown: 0 };
  for (const facts of inScope) {
    const tiers = new Set(facts.reports.map((report) => report.tier).filter((tier): tier is Tier => tier !== null));
    if (tiers.size === 0) tierMix.unknown += 1;
    else if (tiers.size > 1) tierMix.changed += 1;
    else tierMix[[...tiers][0]!] += 1;
  }
  return tierMix;
}

/** Reviews per batch and their blocking findings; a review without a batch or a blocking count is counted unknown. */
export function reviewsOf(inScope: readonly RequestFacts[], unknowns: EvalUnknowns): Supplementary["reviews"] {
  const batches = new Set<string>();
  let reviewCount = 0;
  let batchedReviews = 0;
  let blockingFindings = 0;
  let batchedBlocking = 0;
  for (const facts of inScope) {
    for (const review of facts.reviews) {
      reviewCount += 1;
      if (review.batchId === null) unknowns.reviewsWithoutBatch += 1;
      else {
        batches.add(`${facts.id}\u0000${review.batchId}`);
        batchedReviews += 1;
        batchedBlocking += review.blockingCount ?? 0;
      }
      if (review.blockingCount === null) unknowns.reviewsWithUnknownBlocking += 1;
      else blockingFindings += review.blockingCount;
    }
  }
  return {
    reviews: reviewCount,
    batches: batches.size,
    perBatch: ratio(batchedReviews, batches.size),
    blockingFindings,
    blockingPerBatch: ratio(batchedBlocking, batches.size),
  };
}

/** A request's last reported tier, as the retired rules read it; null when it reported none. */
export function lastTierOf(facts: RequestFacts): Tier | null {
  return [...facts.reports].reverse().find((report) => report.tier !== null)?.tier ?? null;
}

function emptyLift(): ReviewLiftFigures {
  return {
    requests: 0,
    reviews: 0,
    reviewsPerRequest: null,
    batches: 0,
    blockingFindings: 0,
    blockingPerBatch: null,
    actedOn: { reReviewedBatches: 0, found: 0, fixed: 0, reviewedOnceBatches: 0 },
    tokens: { reviews: 0, total: 0, perReview: null },
    unknown: {
      reviewsWithoutBatch: 0,
      reviewsWithUnknownBlocking: 0,
      batchesWithUnknownBlocking: 0,
      reReviewedWithUnknownBlocking: 0,
      requestsWithoutReviewerTokens: 0,
      requestsWithoutReview: 0,
    },
  };
}

function emptySplit(): ReviewLiftSplit {
  return {
    all: emptyLift(),
    byTier: Object.fromEntries(REVIEW_TIERS.map((tier) => [tier, emptyLift()])) as ReviewLiftSplit["byTier"],
    reviewerTurnsWithoutRequest: 0,
  };
}

/** One request's review lift, counts only; `reviewerRecords` are its Reviewer turns. */
function requestLiftOf(facts: RequestFacts, reviewerRecords: readonly TraceRecord[]): ReviewLiftFigures {
  const lift = emptyLift();
  if (facts.reviews.length === 0) {
    lift.unknown.requestsWithoutReview = 1;
    return lift;
  }
  lift.requests = 1;
  lift.reviews = facts.reviews.length;
  const batches = new Map<string, ParsedReview[]>();
  for (const review of facts.reviews) {
    if (review.blockingCount === null) lift.unknown.reviewsWithUnknownBlocking += 1;
    if (review.batchId === null) lift.unknown.reviewsWithoutBatch += 1;
    else push(batches, review.batchId, review);
  }
  lift.batches = batches.size;
  for (const batch of batches.values()) {
    // Oldest first; the records' total order settles a tie.
    const reviews = [...batch].sort((a, b) => compareText(a.at, b.at));
    const counts = reviews.map((review) => review.blockingCount);
    if (counts.some((count) => count === null)) lift.unknown.batchesWithUnknownBlocking += 1;
    else lift.blockingFindings += counts.reduce((sum: number, count) => sum + (count ?? 0), 0);
    if (reviews.length === 1) {
      lift.actedOn.reviewedOnceBatches += 1;
      continue;
    }
    const first = counts[0] ?? null;
    const last = counts.at(-1) ?? null;
    if (first === null || last === null) {
      lift.unknown.reReviewedWithUnknownBlocking += 1;
      continue;
    }
    lift.actedOn.reReviewedBatches += 1;
    lift.actedOn.found += first;
    lift.actedOn.fixed += Math.max(0, first - last);
  }
  if (reviewerRecords.length === 0 || reviewerRecords.some((record) => record.usage === null)) lift.unknown.requestsWithoutReviewerTokens = 1;
  else lift.tokens = { reviews: lift.reviews, total: reviewerRecords.reduce((sum, record) => sum + tokensOf(record), 0), perReview: null };
  return lift;
}

/** Adds one request's counts to a set of figures (the ratios are taken at the end). */
function addLift(target: ReviewLiftFigures, part: ReviewLiftFigures): void {
  target.requests += part.requests;
  target.reviews += part.reviews;
  target.batches += part.batches;
  target.blockingFindings += part.blockingFindings;
  target.actedOn.reReviewedBatches += part.actedOn.reReviewedBatches;
  target.actedOn.found += part.actedOn.found;
  target.actedOn.fixed += part.actedOn.fixed;
  target.actedOn.reviewedOnceBatches += part.actedOn.reviewedOnceBatches;
  target.tokens.reviews += part.tokens.reviews;
  target.tokens.total += part.tokens.total;
  for (const key of Object.keys(target.unknown) as Array<keyof ReviewLiftFigures["unknown"]>) target.unknown[key] += part.unknown[key];
}

function finishedLift(lift: ReviewLiftFigures): ReviewLiftFigures {
  return {
    ...lift,
    reviewsPerRequest: ratio(lift.reviews, lift.requests),
    blockingPerBatch: ratio(lift.blockingFindings, lift.batches - lift.unknown.batchesWithUnknownBlocking),
    tokens: { ...lift.tokens, perReview: ratio(lift.tokens.total, lift.tokens.reviews) },
  };
}

function finishedSplit(split: ReviewLiftSplit): ReviewLiftSplit {
  return {
    all: finishedLift(split.all),
    byTier: Object.fromEntries(REVIEW_TIERS.map((tier) => [tier, finishedLift(split.byTier[tier])])) as ReviewLiftSplit["byTier"],
    reviewerTurnsWithoutRequest: split.reviewerTurnsWithoutRequest,
  };
}

/**
 * Review lift (autonomy design §C.4, §C.6) over the requests in the window,
 * per tier — the request's last reported tier — and per workspace (the
 * request's first record's). A request counts once it has a review; one with
 * Reviewer turns but no review is counted unknown. Reviewer tokens go to the
 * request of the record's `requestId`; a Reviewer turn without one is counted
 * unknown, never as zero.
 */
export function reviewLiftOf(scope: EvalScope): EvalMetrics["reviewLift"] {
  const whole = emptySplit();
  const byWorkspace = new Map<string, ReviewLiftSplit>();
  const workspaceSplit = (workspaceId: string): ReviewLiftSplit => {
    let split = byWorkspace.get(workspaceId);
    if (split === undefined) {
      split = emptySplit();
      byWorkspace.set(workspaceId, split);
    }
    return split;
  };
  for (const facts of scope.inScope) {
    const reviewerRecords = facts.records.filter((record) => record.role === "reviewer");
    if (facts.reviews.length === 0 && reviewerRecords.length === 0) continue;
    const part = requestLiftOf(facts, reviewerRecords);
    const tier = lastTierOf(facts) ?? "unknown";
    const workspace = workspaceSplit(facts.records[0]!.workspaceId);
    for (const figures of [whole.all, whole.byTier[tier], workspace.all, workspace.byTier[tier]]) addLift(figures, part);
  }
  for (const record of scope.scopeRecords) {
    if (record.role !== "reviewer" || record.requestId !== null) continue;
    whole.reviewerTurnsWithoutRequest += 1;
    workspaceSplit(record.workspaceId).reviewerTurnsWithoutRequest += 1;
  }
  return {
    ...finishedSplit(whole),
    byWorkspace: Object.fromEntries(
      [...byWorkspace.entries()].sort(([a], [b]) => compareText(a, b)).map(([workspaceId, split]) => [workspaceId, finishedSplit(split)]),
    ),
  };
}

/** Reports with fields the reader could not parse, or left incomplete. */
export function reportFormatOf(inScope: readonly RequestFacts[]): Supplementary["reportFormat"] {
  let reportCount = 0;
  let withUnparsed = 0;
  let withIncomplete = 0;
  for (const facts of inScope) {
    for (const report of facts.reports) {
      reportCount += 1;
      if ((report.unparsedFields ?? []).length > 0) withUnparsed += 1;
      if ((report.incompleteFields ?? []).length > 0) withIncomplete += 1;
    }
  }
  return { reports: reportCount, withUnparsedFields: withUnparsed, withIncompleteFields: withIncomplete };
}

/** What the retired rules flagged (autonomy design §B.9), each read as its rule read the request. */
export function processOf(scope: EvalScope, unknowns: EvalUnknowns): Supplementary["process"] {
  const processFigures = { smallHeavy: 0, unreviewed: 0, failedFirstTurns: { worker: 0, reviewer: 0 }, finishedWithoutReceived: 0, languageMismatch: 0 };
  for (const facts of scope.inScope) {
    const tier = lastTierOf(facts);
    const heavy =
      facts.reports.some((report) => (report.beadsCreated ?? []).length > 0 || (report.filesChanged ?? []).some(isProcessDocumentPath)) ||
      facts.records.some((record) =>
        record.evidence.some((item) => (item.kind === "shell" && runsBrCreate(item.detail)) || (item.kind === "file" && isProcessDocumentPath(item.detail))),
      );
    if (heavy && tier === "Small") processFigures.smallHeavy += 1;
    else if (heavy && tier === null) unknowns.processWeightWithoutTier += 1;
    if (facts.finished && !facts.records.some((record) => record.role === "reviewer")) {
      if (tier === "Medium" || tier === "Large") processFigures.unreviewed += 1;
      else if (tier === null) unknowns.unreviewedWithoutTier += 1;
    }
    if (facts.finished && !facts.reports.some((report) => report.phase === "received")) processFigures.finishedWithoutReceived += 1;
    const managerRecords = facts.records.filter((record) => record.role === "manager");
    const typed = managerRecords
      .flatMap((record) => record.sent.filter((message) => message.origin === "user").map((message) => ({ agentId: record.agentId, message })))
      .sort((a, b) => compareText(a.message.at, b.message.at))
      .at(-1);
    const wrong = typed === undefined ? undefined : OTHER_LANGUAGE[guessLanguage(typed.message.text)];
    if (typed !== undefined && wrong !== undefined) {
      const replies = managerRecords.filter((record) => record.agentId === typed.agentId).flatMap((record) => record.received);
      const mismatching = replies.filter((reply) => guessLanguage(reply.text) === wrong);
      // A recorded time can be the write time: a reply with the message's own time proves nothing either way.
      if (mismatching.some((reply) => reply.at > typed.message.at)) processFigures.languageMismatch += 1;
      else if (mismatching.some((reply) => reply.at === typed.message.at)) unknowns.languageOrderUnknown += 1;
    }
  }
  // A Worker's or Reviewer's first recorded turn, over every record; counted when that turn is in scope.
  const firstTurnOf = new Map<string, TraceRecord>();
  for (const record of scope.records) if ((record.role === "worker" || record.role === "reviewer") && !firstTurnOf.has(record.agentId)) firstTurnOf.set(record.agentId, record);
  const inScopeRecords = new Set(scope.scopeRecords);
  for (const first of firstTurnOf.values()) {
    if (first.outcome === "failed" && inScopeRecords.has(first)) processFigures.failedFirstTurns[first.role as "worker" | "reviewer"] += 1;
  }
  return processFigures;
}

/** The turns in scope by role. */
export function turnsByRoleOf(scopeRecords: readonly TraceRecord[]): RoleCounts {
  const turnsByRole = zeroRoles();
  for (const record of scopeRecords) turnsByRole[roleOf(record)] += 1;
  return turnsByRole;
}

/** The turns in scope that ended so (`canceled`, `failed`), by role. */
export function turnsEndedOf(scopeRecords: readonly TraceRecord[], outcome: TraceRecord["outcome"]): { total: number; byRole: RoleCounts } {
  const byRole = zeroRoles();
  for (const record of scopeRecords) if (record.outcome === outcome) byRole[roleOf(record)] += 1;
  return { total: EVAL_ROLES.reduce((sum, role) => sum + byRole[role], 0), byRole };
}

/** Requests in the window by the UTC day of their earliest activity, oldest day first. */
export function requestsByDayOf(scope: EvalScope): Supplementary["requestsByDay"] {
  const dayCounts = new Map<string, number>();
  for (const facts of scope.inScope) {
    const earliest = scope.earliestOf.get(facts.id) ?? null;
    if (earliest === null) continue;
    const day = new Date(earliest).toISOString().slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }
  return Object.fromEntries([...dayCounts.entries()].sort(([a], [b]) => compareText(a, b)));
}
