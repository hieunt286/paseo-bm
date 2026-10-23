/**
 * `bm_findings { workspaceId }` (autonomy design §G.4; PRD REQ-128; ADR-021
 * decision 5): a project's measured findings, for the advice the Orchestrator
 * gives after every `advice.everyFinished` finished requests (`advice.due`)
 * or whenever the owner asks in its chat — the same tool both ways.
 *
 * Each finding carries its figures, and names the prepared change that acts
 * on it when there is one (`act`), which the Orchestrator puts on an option
 * of `bm_ask_owner`:
 *
 * | Finding | From | Acts with |
 * |---|---|---|
 * | `repeated-subject` — a question subject asked again and again, with no active precedent | the decision store | `precedent.save` |
 * | `agreement` — a predictor's agreement with the owner in a class that is not delegated (a figure, no threshold) | the agreement ledger (§B.3) | `autonomy.set` |
 * | `intervention-below-target` — an intervention kind below A-12's 80 % | the intervention log (§G.3) | `coordination.set` for `advice`, else none |
 * | `blocked-rounds` — rounds blocked on the owner, and how long the owner took | the metric module | — |
 * | `reviews` — review batches and blocking findings, the first-round and re-review pass shares and the batches the convergence rule stopped, per tier, with the tier's cap (delivery line design §5.6) | the metric module and the Reviewers' reviews, per tier; Settings → Coordination | `coordination.set` on `review.callsPerBatch` or `review.maxRereviews` |
 * | `stalls` — stall reasons and the Worker alerts | the Inbox alerts | — |
 * | `heavy-request` — the heaviest requests, the Worker's share | the metric module (§G.2) | — (Phase 3) |
 * | `compaction-candidates`, `handoff-candidates` — estimates | the metric module (§G.2) | — (Phase 3) |
 *
 * Over the last `FINDINGS_WINDOW_DAYS` days, with the settings they bear on.
 * Figures, ids and short labels (slugs, enums) only — never a message, a
 * question or an answer's text — redacted, in at most `FINDINGS_MAX_CHARS`
 * characters: findings past the bound are left out, the least actionable
 * first, and counted in `omitted`. Read-only: files are opened for reading
 * only (`eval-store.ts` `readStore`), and nothing is written or sent.
 */
import { redactText } from "./collector";
import { effectivePolicy } from "./placements";
import { readCoordinationSettings } from "./coordination-rpc";
import { createAlertStore } from "./alert-store";
import { createDecisionStore } from "./decision-store";
import { evalInputsOf, readStore, selectWorkspaces, workspaceDirectoriesOf } from "./eval-store";
import { createPrecedentStore } from "./precedent-store";
import { requireProject, type ServerToolResult, type ToolContext } from "./orchestrator-tool-context";
import { STALL_REASONS } from "./event-bus";
import { errorText } from "./rpc-kit";
import type { Alert } from "../shared/alerts";
import { challengerOf, modeOf, type AutonomyPolicy } from "../shared/autonomy";
import { agreementLedger, agreementRateOf, type AgreementCell } from "../shared/autonomy-ledger";
import { FINDINGS_MAX_CHARS, FINDINGS_WINDOW_DAYS } from "../shared/bm-tools";
import type { Tier, TraceRecord } from "../shared/contracts";
import type { CoordinationSettings } from "../shared/coordination";
import { ownReviewsOf } from "../shared/bm-report";
import { REVIEW_MILESTONES_MAX, reviewCapOf } from "../shared/orchestrator-rules";
import { CONVERGENCE_STOP_TAIL, convergenceRefusalOf, isPassVerdict } from "./review-tools";
import { DECISION_CLASSES, decisionKindOf, type Decision } from "../shared/decisions";
import { computeEvalMetrics, type EvalMetrics, type EvalWindow } from "../shared/eval-metrics";
import { A12_TARGET, INTERVENTION_KINDS } from "../shared/interventions";
import { precedentTextOf, type Precedent } from "../shared/precedents";
import { timeOrZero } from "../shared/time";

const DAY_MS = 86_400_000;
const TIERS: readonly Tier[] = ["Small", "Medium", "Large"];

/** A subject is a finding once asked at least this many times in the window. */
export const REPEATED_SUBJECT_MIN = 2;
/** The most findings of each listed kind. */
export const FINDINGS_PER_KIND = { repeatedSubjects: 5, agreement: 3, heavyRequests: 3 } as const;
/** The first line of the answer, before its JSON. */
export const FINDINGS_NOTE =
  "Figures only. For each finding worth acting on, ask the owner with bm_ask_owner, its change (act) on an option; read a decision with bm_decisions, a request with bm_request.";

/** One finding: its kind, its figures, and the prepared change that acts on it when there is one. */
export type Finding = { finding: string; act?: "precedent.save" | "autonomy.set" | "coordination.set" } & Record<string, unknown>;

/** What `findingsOf` reads: the project's stores, read once. */
export interface FindingsFacts {
  workspaceId: string;
  now: Date;
  window: EvalWindow;
  /** The metrics of the project's records and Orchestrator entries over the window. */
  metrics: EvalMetrics;
  /**
   * The same metrics' review figures over each tier's requests (a request's
   * last reported tier), for the tiers that have any, with how their batches
   * converged (`reviewConvergenceOf`).
   */
  reviewsByTier: Partial<Record<Tier, { requests: number; reviews: EvalMetrics["supplementary"]["reviews"]; convergence?: ReviewConvergence }>>;
  /** The project's stored decisions. */
  decisions: readonly Decision[];
  /** The active precedents that hold in the project. */
  precedents: readonly Precedent[];
  /** The project's Inbox alerts, open and cleared. */
  alerts: readonly Alert[];
  policy: AutonomyPolicy;
  settings: CoordinationSettings;
}

/** The whole answer before it is bounded. */
export interface FindingsReport {
  workspaceId: string;
  window: { days: number; since: string | null };
  requests: { inWindow: number; finished: number };
  settings: Record<string, unknown>;
  findings: Finding[];
  /** Findings left out to keep within the bound. */
  omitted: number;
}

/** A share with two decimals; null stays null. */
function share(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

/** Milliseconds as whole minutes; null stays null. */
function minutes(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms / 60_000);
}

/** In the window: at or after its start. */
function inWindow(at: string | null | undefined, window: EvalWindow): boolean {
  return window.since === null || timeOrZero(at ?? null) >= timeOrZero(window.since);
}

/** Question subjects asked at least `REPEATED_SUBJECT_MIN` times in the window with no active precedent, most asked first (§G.4). */
function repeatedSubjectsOf(facts: FindingsFacts): Finding[] {
  const bySubject = new Map<string, Decision[]>();
  for (const decision of facts.decisions) {
    if (decisionKindOf(decision.id) !== "question" || decision.subject === null || !inWindow(decision.askedAt, facts.window)) continue;
    bySubject.set(decision.subject, [...(bySubject.get(decision.subject) ?? []), decision]);
  }
  const covered = new Set(facts.precedents.map((precedent) => precedent.subject));
  return [...bySubject.entries()]
    .filter(([subject, asked]) => asked.length >= REPEATED_SUBJECT_MIN && !covered.has(subject))
    .map(([subject, asked]) => {
      const owners = asked.filter((decision) => decision.status === "answered" && decision.answer?.by === "owner");
      const texts = new Map<string, number>();
      for (const decision of owners) {
        const text = precedentTextOf(decision);
        if (text === null) continue;
        const key = text.replace(/\s+/g, " ").trim();
        texts.set(key, (texts.get(key) ?? 0) + 1);
      }
      const latest = [...(owners.length > 0 ? owners : asked)].sort((a, b) => timeOrZero(b.askedAt) - timeOrZero(a.askedAt))[0]!;
      return {
        finding: "repeated-subject",
        subject,
        asked: asked.length,
        ownerAnswers: owners.length,
        sameAnswer: Math.max(0, ...texts.values()),
        lastDecisionId: latest.id,
        act: "precedent.save" as const,
      };
    })
    .sort((a, b) => b.asked - a.asked || a.subject.localeCompare(b.subject))
    .slice(0, FINDINGS_PER_KIND.repeatedSubjects);
}

/**
 * Each predictor's agreement in a class that is not delegated (§B.3, §G.4;
 * any class, ADR-025): a plain figure, no threshold — the owner delegates a
 * class whenever they choose (ADR-023). Only cells with a counted answer, most
 * answers first.
 */
function agreementOf(facts: FindingsFacts): Finding[] {
  const answered = facts.decisions.filter((decision) => decision.status === "answered");
  const cells: AgreementCell[] = agreementLedger(answered, { workspaceId: facts.workspaceId }).cells;
  return cells
    .filter((cell) => cell.count > 0 && modeOf(facts.policy, facts.workspaceId, cell.class) !== "delegate")
    .sort((a, b) => b.count - a.count)
    .slice(0, FINDINGS_PER_KIND.agreement)
    .map((cell) => ({
      finding: "agreement",
      class: cell.class,
      predictor: cell.predictor,
      agreement: share(agreementRateOf(cell)),
      answers: cell.count,
      reversals: cell.reversals,
      mode: modeOf(facts.policy, facts.workspaceId, cell.class),
      act: "autonomy.set" as const,
    }));
}

/** The intervention kinds under A-12's target (§G.3): advice under it acts on the cadence. */
function interventionsOf(facts: FindingsFacts): Finding[] {
  return INTERVENTION_KINDS.flatMap((kind) => {
    const counts = facts.metrics.a12.byKind[kind];
    if (counts.share === null || counts.share >= A12_TARGET) return [];
    return [
      {
        finding: "intervention-below-target",
        kind,
        met: counts.met,
        missed: counts.missed,
        share: share(counts.share),
        target: A12_TARGET,
        ...(kind === "advice" ? { act: "coordination.set" as const } : {}),
      },
    ];
  });
}

/** Rounds blocked on the owner, the owner's questions per finished request and how long the owner took. */
function blockedOf(facts: FindingsFacts): Finding[] {
  const { roundsBlocked, ownerWait } = facts.metrics.supplementary;
  if (roundsBlocked.rounds === 0) return [];
  return [
    {
      finding: "blocked-rounds",
      rounds: roundsBlocked.rounds,
      requestsBlocked: roundsBlocked.requestsBlockedAtLeastOnce,
      perRequest: share(roundsBlocked.perRequest),
      ownerQuestionsPerFinishedRequest: share(facts.metrics.a1.perFinishedRequest?.reachedOwner ?? null),
      ownerWaitMedianMin: minutes(ownerWait.medianMs),
      ownerWaitP90Min: minutes(ownerWait.p90Ms),
    },
  ];
}

/** How one tier's review batches converged (delivery line design §5.2), over the batches with a verdict. */
export interface ReviewConvergence {
  /** Batches with at least one verdict. */
  batches: number;
  /** Of them, those whose first review passed. */
  firstRoundPassed: number;
  /** Re-reviews with a verdict, and those that passed. */
  rereviews: number;
  rereviewsPassed: number;
  /** Batches the convergence rule stopped: re-reviews spent, or the blocking count not falling. */
  unconverged: number;
}

/** One review as `reviewConvergenceOf` reads it: its request, batch, time, verdict and blocking count. */
export type ConvergenceReview = { requestId: string; batchId: string | null; at: string; verdict: string | null; blockingCount: number | null };

/**
 * How the batches of `reviews` converged against `maxRereviews` (delivery
 * line design §5.2): each batch's reviews with a verdict in time order, the
 * first being its first round and every later one a re-review; a batch is
 * unconverged when the rule would refuse its next re-review for its counts. A
 * review without a batch or a verdict is left out. Pure.
 */
export function reviewConvergenceOf(reviews: readonly ConvergenceReview[], maxRereviews: number): ReviewConvergence {
  const batches = new Map<string, ConvergenceReview[]>();
  for (const review of reviews) {
    if (review.batchId === null || review.verdict === null) continue;
    const key = `${review.requestId}\u0000${review.batchId}`;
    batches.set(key, [...(batches.get(key) ?? []), review]);
  }
  const figures: ReviewConvergence = { batches: batches.size, firstRoundPassed: 0, rereviews: 0, rereviewsPassed: 0, unconverged: 0 };
  for (const batch of batches.values()) {
    const ordered = [...batch].sort((a, b) => timeOrZero(a.at) - timeOrZero(b.at));
    if (isPassVerdict(ordered[0]!.verdict)) figures.firstRoundPassed += 1;
    figures.rereviews += ordered.length - 1;
    figures.rereviewsPassed += ordered.slice(1).filter((review) => isPassVerdict(review.verdict)).length;
    const refusal = convergenceRefusalOf({
      batchId: ordered[0]!.batchId!,
      results: ordered.map((review) => ({ at: review.at, recordId: "", verdict: review.verdict!, blocking: review.blockingCount })),
      calls: ordered.map((review, index) => ({ callId: String(index), kind: index === 0 ? ("create" as const) : ("rereview" as const), reviewerId: "", at: review.at })),
      maxRereviews,
    });
    if (refusal !== null && refusal.endsWith(CONVERGENCE_STOP_TAIL)) figures.unconverged += 1;
  }
  return figures;
}

/** `part` of `whole` to two decimals; null with none. */
function shareOf(part: number, whole: number): number | null {
  return whole === 0 ? null : share(part / whole);
}

/**
 * Review batches and blocking findings per tier, for the tiers with a batch
 * (delivery line design §5.6): how often a first round and a re-review pass,
 * the batches the convergence rule stopped, and the tier's cap at its most
 * milestone batches, against the two settings that change them —
 * `review.callsPerBatch` and `review.maxRereviews`, each a `coordination.set`.
 */
function reviewsOf(facts: FindingsFacts): Finding[] {
  const { callsPerBatch, maxRereviews } = facts.settings.review;
  return TIERS.flatMap((tier) => {
    const figures = facts.reviewsByTier[tier];
    if (figures === undefined || figures.reviews.batches === 0) return [];
    const convergence = figures.convergence ?? { batches: 0, firstRoundPassed: 0, rereviews: 0, rereviewsPassed: 0, unconverged: 0 };
    return [
      {
        finding: "reviews",
        tier,
        requests: figures.requests,
        batches: figures.reviews.batches,
        reviewsPerBatch: share(figures.reviews.perBatch),
        blockingFindings: figures.reviews.blockingFindings,
        blockingPerBatch: share(figures.reviews.blockingPerBatch),
        firstRoundPassShare: shareOf(convergence.firstRoundPassed, convergence.batches),
        rereviews: convergence.rereviews,
        rereviewPassShare: shareOf(convergence.rereviewsPassed, convergence.rereviews),
        unconvergedBatches: convergence.unconverged,
        cap: reviewCapOf(tier, REVIEW_MILESTONES_MAX[tier], { callsPerBatch }),
        "review.callsPerBatch": callsPerBatch,
        "review.maxRereviews": maxRereviews,
        act: "coordination.set" as const,
      },
    ];
  });
}

/** Stall reasons (`request-stalled` alerts, by reason) and the Worker alerts raised in the window. */
function stallsOf(facts: FindingsFacts): Finding[] {
  const counts: Record<string, number> = {};
  const add = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  for (const alert of facts.alerts) {
    if (!inWindow(alert.since, facts.window)) continue;
    if (alert.kind === "request-stalled") {
      // Only the reasons the stall pass writes: never the detail's other text.
      const reasons = (alert.detail ?? "").split(/,\s*/).filter((reason): reason is (typeof STALL_REASONS)[number] => (STALL_REASONS as readonly string[]).includes(reason));
      for (const reason of reasons.length === 0 ? ["unknown"] : reasons) add(reason);
    } else if (alert.kind === "stuck" || alert.kind === "permission-waiting" || alert.kind === "danger") {
      add(alert.kind);
    }
  }
  return Object.keys(counts).length === 0 ? [] : [{ finding: "stalls", ...counts }];
}

/** The heaviest requests (§G.2): tokens read, the Worker's share, turns. */
function heavyOf(facts: FindingsFacts): Finding[] {
  return facts.metrics.context.tokensRead.heaviestRequests.slice(0, FINDINGS_PER_KIND.heavyRequests).map((request) => ({
    finding: "heavy-request",
    requestId: request.requestId,
    tokensRead: request.tokensRead,
    workerShare: share(request.tokensRead === 0 ? null : request.byRole.worker / request.tokensRead),
    turns: request.turns,
    finished: request.finished,
  }));
}

/** The compaction and handoff candidates of §G.2's replay: estimates, for Phase 3. */
function candidatesOf(facts: FindingsFacts): Finding[] {
  const { compaction, handoff, thresholds } = facts.metrics.context.candidates;
  return [
    ...(compaction.candidates === 0
      ? []
      : [{ finding: "compaction-candidates", candidates: compaction.candidates, savingTokens: compaction.savingTokens, workerTokensPerTurnP75: thresholds.compactTokensPerTurn.worker, estimate: true }]),
    ...(handoff.candidates === 0
      ? []
      : [{ finding: "handoff-candidates", candidates: handoff.candidates, savingTokens: handoff.savingTokens, requestTokensP80: thresholds.handoffRequestTokens, estimate: true }]),
  ];
}

/** The settings the findings bear on: the cadence, the project's cells above owner, the challenger, the active precedents. */
function settingsOf(facts: FindingsFacts): Record<string, unknown> {
  const cells = Object.fromEntries(
    DECISION_CLASSES.flatMap((decisionClass) => {
      const mode = modeOf(facts.policy, facts.workspaceId, decisionClass);
      return mode === "owner" ? [] : [[decisionClass, mode]];
    }),
  );
  return {
    "advice.everyFinished": facts.settings.advice.everyFinished,
    autonomy: cells,
    challenger: challengerOf(facts.policy, facts.workspaceId),
    activePrecedents: facts.precedents.length,
  };
}

/** Every finding of the project, the most actionable first (see the module comment). Pure. */
export function findingsOf(facts: FindingsFacts): FindingsReport {
  return {
    workspaceId: facts.workspaceId,
    window: { days: FINDINGS_WINDOW_DAYS, since: facts.window.since },
    requests: { inWindow: facts.metrics.requests.inWindow, finished: facts.metrics.requests.finished },
    settings: settingsOf(facts),
    findings: [
      ...repeatedSubjectsOf(facts),
      ...agreementOf(facts),
      ...interventionsOf(facts),
      ...blockedOf(facts),
      ...reviewsOf(facts),
      ...stallsOf(facts),
      ...heavyOf(facts),
      ...candidatesOf(facts),
    ],
    omitted: 0,
  };
}

/**
 * The answer: `FINDINGS_NOTE`, then the report as compact JSON, redacted, in
 * at most `FINDINGS_MAX_CHARS` characters — the last findings left out and
 * counted in `omitted` until it fits. Pure.
 */
export function findingsText(report: FindingsReport, env: NodeJS.ProcessEnv = {}): string {
  const findings = [...report.findings];
  const render = (): string => redactText(`${FINDINGS_NOTE}\n${JSON.stringify({ ...report, findings, omitted: report.omitted + report.findings.length - findings.length })}`, env);
  let text = render();
  while (text.length > FINDINGS_MAX_CHARS && findings.length > 0) {
    findings.pop();
    text = render();
  }
  return text;
}

/** Each request's last reported tier (by the report's time), from the records. */
function tiersOf(records: readonly TraceRecord[]): Map<string, Tier> {
  const latest = new Map<string, { tier: Tier; at: number }>();
  for (const record of records) {
    for (const report of record.reports) {
      const requestId = report.requestId ?? record.requestId;
      if (requestId === null || report.tier === null) continue;
      const at = timeOrZero(report.at);
      const known = latest.get(requestId);
      if (known === undefined || at >= known.at) latest.set(requestId, { tier: report.tier, at });
    }
  }
  return new Map([...latest].map(([requestId, entry]) => [requestId, entry.tier]));
}

/**
 * The Reviewers' own reviews of `records` (a quoted block is not one,
 * `ownReviewsOf`) from `since`, each once, as the metric module keys them.
 */
function windowReviewsOf(records: readonly TraceRecord[], since: string | null): ConvergenceReview[] {
  const from = since === null ? 0 : timeOrZero(since);
  const seen = new Set<string>();
  const reviews: ConvergenceReview[] = [];
  for (const record of records) {
    if (record.requestId === null) continue;
    for (const review of ownReviewsOf(record)) {
      const key = `${review.agentId}|${review.batchId ?? ""}|${review.verdict ?? ""}|${review.at}`;
      if (seen.has(key) || timeOrZero(review.at) < from) continue;
      seen.add(key);
      reviews.push({ requestId: record.requestId, batchId: review.batchId, at: review.at, verdict: review.verdict, blockingCount: review.blockingCount });
    }
  }
  return reviews;
}

/** A store read that falls back: `fallback` when it throws, with one log line. */
function readOrNone<T>(what: string, fallback: T, read: () => T, log: (message: string) => void): T {
  try {
    return read();
  } catch (error) {
    log(`[paseo-bm] bm_findings could not read ${what}: ${errorText(error)}`);
    return fallback;
  }
}

/** What `findingsOf` reads of the data folder for one project, over the window ending `now`. Read-only; never throws for a store it cannot read. */
export function findingsFactsOf(workspaceId: string, home: string, now: Date, log: (message: string) => void = (message) => console.warn(message)): FindingsFacts {
  const window: EvalWindow = { since: new Date(now.getTime() - FINDINGS_WINDOW_DAYS * DAY_MS).toISOString(), until: null };
  const store = readStore(home);
  const selection = selectWorkspaces(store, new Set([workspaceId]));
  const metrics = computeEvalMetrics({ ...evalInputsOf(selection), window, workspaceDirectories: workspaceDirectoriesOf(store) });
  const tiers = tiersOf(selection.records);
  const settings = readCoordinationSettings({ home, log });
  const reviewsByTier: FindingsFacts["reviewsByTier"] = {};
  for (const tier of TIERS) {
    const records = selection.records.filter((record) => record.requestId !== null && tiers.get(record.requestId) === tier);
    if (records.length === 0) continue;
    const perTier = computeEvalMetrics({ records, window });
    const convergence = reviewConvergenceOf(windowReviewsOf(records, window.since), settings.review.maxRereviews);
    reviewsByTier[tier] = { requests: perTier.requests.inWindow, reviews: perTier.supplementary.reviews, convergence };
  }
  const policy = effectivePolicy(home, (reason) => log(`[paseo-bm] bm_findings could not read the autonomy policy: ${reason}`));
  return {
    workspaceId,
    now,
    window,
    metrics,
    reviewsByTier,
    decisions: readOrNone("the decisions", [], () => createDecisionStore(home, { log }).list({ workspaceId }), log),
    precedents: readOrNone("the precedents", [], () => createPrecedentStore(home).active(now, workspaceId), log),
    alerts: readOrNone("the Inbox alerts", [], () => createAlertStore(home).list({ workspaceId }), log),
    policy,
    settings,
  };
}

/** `bm_findings { workspaceId }`: the project's findings (see the module comment). Read-only; sends nothing. */
export async function bmFindings(input: { workspaceId: string }, context: ToolContext, log?: (message: string) => void): Promise<ServerToolResult> {
  await requireProject(input.workspaceId, context);
  return { ok: true, text: findingsText(findingsOf(findingsFactsOf(input.workspaceId, context.home, context.now, log)), context.env) };
}
