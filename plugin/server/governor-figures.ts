/**
 * The governor's figures (missions design §9.2; ADR-029): what the process of
 * one mission looks like, in numbers, against the owner's thresholds
 * (Settings → Coordination `governor.*`, `shared/coordination.ts`). No model
 * reads anything here: the ladder (`governor-store.ts`) acts on a family
 * whose figure crossed.
 *
 * - **Pure figures** (`governorFiguresOf`) over a **read snapshot**
 *   (`GovernorSnapshot`), so each family is tested from fixtures. Each figure
 *   says its value, its threshold, how it crosses (`>=` reached, `>` passed,
 *   as the design's table words it) and, where it helps, which file, repo or
 *   request it is about.
 * - **The snapshot** (`readGovernorSnapshot`) reads the stores once: the
 *   mission and its roster (`mission-store.ts`, `mission-roster.ts`), each
 *   request's registry entry in its repo (tier, finish, review calls, grants
 *   and batches), the trace records of the mission's requests and Workers in their
 *   repos (file evidence, reports) and of its Mains in their home, the
 *   decisions of its requests and its `m:` cards, its dropped outbox records,
 *   the open `request-stalled` and `peer-unanswered` alerts of its requests,
 *   and the live links they asked. Which Workers are live is the caller's: a
 *   Paseo agent list (`liveWorkersOf`).
 *
 * | Family | Figure | Crosses |
 * |---|---|---|
 * | mess | `writersOnOneFile`: live Workers with `file` evidence on one file in 24 h | ≥ `writersPerFile` |
 * | | `workersInOneRepo`: live Workers in one repo with a request still open (not `finished` or `stopped` on the roster) | > `workersPerRepo`, or > `charter.budget.workers` when lower |
 * | | `reAsks`: the most re-asks of one question subject in a request | ≥ `reAsks` |
 * | | `dropped`: outbox records of the mission dropped in 24 h | ≥ `dropped` |
 * | | `uncommittedHours`: hours since the last finished request of a placement whose worktree is dirty with no live Worker (delivery line design §4.9) | ≥ `uncommittedHours` |
 * | overengineering | `processDocsPerCriterion`: process documents (`isProcessDocumentPath`) written ÷ done criteria not dropped (at least 1) | > `processDocsPerCriterion` |
 * | | `beadsPerFinishedRequest`: beads created by the finished requests ÷ their number | > `beadsPerRequest` |
 * | | `tierRaised`: requests whose report tier rose above their `received` tier | ≥ `tierRaised` |
 * | | `reviewCapReached`: requests whose next review call passes the cap, even in a new milestone batch | ≥ `reviewExhausted` |
 * | | `unconvergedBatches`: review batches the convergence rule stopped in 24 h (delivery line design §5.2) | ≥ `reviewExhausted` |
 * | | `openApprovals`: open `q:`/`o:` cards of the mission's requests and open `m:` cards | > `openApprovals` |
 * | drift | `mainTurnsSinceCriterion`: the Mains' turns the owner or a report started (a record without `trigger`: every turn) since a done criterion was last met with evidence (else since the charter was confirmed, else since the mission began); none while every done criterion is met or dropped and no request is open | > `mainTurnsSinceCriterion` |
 * | | `finishedSinceCriterion`: requests finished since then, a chain once | > `finishedSinceCriterion` |
 * | | `outsideCharter`: requests and live links in repos outside `charter.repos` (none while it is empty) | ≥ `outsideCharter` |
 * | | `behindIntegration`: the most commits a mission branch is behind its integration branch (§4.9) | ≥ `behindCommits` |
 * | stuck | `stalled`, `unansweredLinks`: open alerts of the mission's requests — `stalled` leaves out a stopped request, a continued one (delivery line design §2.7) and one that waits: by structure on live items (`structuralWaitOf`, delivery line design §6.5), or, for an older report, on active work of the mission it names (`waitingOrStoppedOf`, mission runtime design §6.3); `oldCards`: open cards older than `cardAgeHours` | ≥ 1 each |
 * | | `unpushedNoMr`: hours a mission branch has been ahead of its integration branch with no merge request, from its oldest commit not in it; `ciRed` (only with `integration.ci` on, ADR-036): minutes its CI has been red; `mrConflicting`: merge requests not mergeable for conflicts (§4.9) | ≥ `unpushedHours`, ≥ `ciRedMinutes`, ≥ 1 |
 * | budget | `requestsBudget`, `workersBudget`, `reviewCallsBudget`, `daysBudget`: percent of each `charter.budget` field above 0 | ≥ `budgetPercent` |
 *
 * Documents in Review or Draft are not counted among the open approvals: no
 * store holds them yet. The line figures read each ready placement's line as
 * the 60-second pass last read it (`line-watch.ts`): a recomputation at a
 * recorded turn runs no git.
 */
import { join } from "node:path";
import type { Alert } from "../shared/alerts";
import type { Tier, TraceRecord } from "../shared/contracts";
import { ciUsed, type CoordinationSettings, type GovernorSettings, type IntegrationCi } from "../shared/coordination";
import { isAnswerable, type Decision } from "../shared/decisions";
import { isProcessDocumentPath, reviewCapOf } from "../shared/orchestrator-rules";
import { timeOrZero } from "../shared/time";
import { GOVERNOR_FIGURES, MAX_FIGURE_DETAIL, type GovernorFigure, type GovernorFigureId } from "../shared/governor-figures";
import { writtenFilesOf } from "../shared/writers-observed";
import { waitingOnOf } from "../shared/mission-state";
import { structuralWaitOf, type StructuralWaitFacts, type WaitBatch, type WaitRequestFact } from "../shared/structural-wait";
import type { Waiting } from "../shared/waits";
import { PENDING_TTL_MS } from "./agent-bindings";
import { createAlertStore } from "./alert-store";
import { TRACES_DIR_NAME } from "./data-home";
import { createDecisionStore } from "./decision-store";
import { createMissionDecisionStore, missionOfDecisionId } from "./mission-decisions";
import { createMissionRoster, type RosterState } from "./mission-roster";
import { metAtOf, type Mission } from "./mission-store";
import { mainPlacesOf } from "./missions-home";
import { createOutbox, newestReportRecordOf, reportPhaseOf } from "./outbox";
import { createPeerLinkStore, isLiveLink } from "./peer-links";
import { createRequestRegistry } from "./request-registry";
import { CONVERGENCE_STOP_TAIL, batchResultsOf, convergenceRefusalOf, grantedCallsOf, milestoneBatchesOf } from "./review-tools";
import type { RegisteredRequest } from "./request-registry";
import { ownReviewsOf } from "../shared/bm-report";
import { placementIndexIn } from "./placements";
import { cachedLineOf, newestPlacementsOf, placementFactsOf, reportedLineOf, type PlacementFacts, type ReportedLine } from "./line-watch";
import { errorText } from "./rpc-kit";
import { readRecords, readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";

// The pure definitions live in `shared/governor-figures.ts`; read here too, as before.
export {
  GOVERNOR_FAMILIES,
  GOVERNOR_FIGURES,
  MAX_FIGURE_DETAIL,
  familyFiguresOf,
  figureText,
  type GovernorFamily,
  type GovernorFigure,
  type GovernorFigureId,
} from "../shared/governor-figures";

/** The window of the writers and dropped figures (§9.2: file evidence over the last 24 h). */
export const GOVERNOR_RECENT_MS = 24 * 3_600_000;

/** What the figures read of one request of the mission. */
export interface GovernorRequestFacts {
  requestId: string;
  /** Its repo. */
  workspaceId: string;
  rosterState: RosterState;
  workerIds: readonly string[];
  /** From its registry entry; null while not finished, or when the registry does not hold it. */
  finishedAt: string | null;
  tier: Tier | null;
  /** Its review calls, the calls its grants add, and its milestone batches (`review-tools.ts`). No call is exempt (delivery line design §5.6). */
  reviewCalls: number;
  reviewGranted: number;
  reviewMilestones: number;
  /** When each of its batches the convergence rule stopped got its last result (delivery line design §5.2); absent: none. */
  unconvergedAt?: readonly string[];
  /** Its newest report's phase, and what a `blocked` one waits on besides the owner (`waitingOnOf`); absent when unknown. */
  lastPhase?: string | null;
  waitingOn?: string | null;
  /** Its structured wait (delivery line design §6.2), read before `waitingOn`; absent or null: none (an older report). */
  waiting?: Waiting | null;
  /** Its review batches, for the batch items of its wait (delivery line design §6.5); absent: none. */
  reviewBatches?: readonly WaitBatch[];
  /** The request that continues it (delivery line design §2.4); absent: none. */
  continuedBy?: string;
}

/** A read of everything one mission's figures need. Built by `readGovernorSnapshot`; fixtures in tests. */
export interface GovernorSnapshot {
  now: string;
  mission: Mission;
  requests: readonly GovernorRequestFacts[];
  /** The mission's Workers that are live now, with their repo. */
  liveWorkers: ReadonlyArray<{ agentId: string; workspaceId: string }>;
  /** The trace records of the mission's requests and Workers, in their repos. */
  records: readonly TraceRecord[];
  /** Each repo's folder, for file evidence; null when unknown. */
  directories: Readonly<Record<string, string | null>>;
  /** When each turn of the mission's Mains (every Main of `mainHistory`) ended. */
  mainTurnEnds: readonly string[];
  /**
   * The turns of `mainTurnEnds` drift counts (delivery line design §8.4): those
   * the owner or a report started, and those of a record without `trigger`
   * (written before it). Absent: every turn of `mainTurnEnds`.
   */
  driftTurnEnds?: readonly string[];
  /** The `q:`/`o:` decisions of the mission's requests and its `m:` decisions. */
  decisions: ReadonlyArray<Pick<Decision, "id" | "requestId" | "subject" | "askedAt" | "status">>;
  /** The mission's dropped outbox records. */
  dropped: ReadonlyArray<{ id: string; outcomeAt: string | null }>;
  /** The open `request-stalled` and `peer-unanswered` alerts of the mission's requests. */
  alerts: ReadonlyArray<Pick<Alert, "kind" | "subject">>;
  /** The live links the mission's requests asked, by their target repo. */
  links: ReadonlyArray<{ linkId: string; toWorkspaceId: string }>;
  /** The owner's review settings, for the cap (`reviewCapOf`, delivery line design §5.3). */
  review: { readonly callsPerBatch: number };
  /** The agents whose turn runs now (a Reviewer of an awaited batch, delivery line design §6.5); absent: none. */
  runningAgents?: readonly string[];
  /** Each placement workspace's repo key (delivery line design §3.1); absent: none, every workspace its own repo. */
  repoKeys?: Readonly<Record<string, string>>;
  /** The mission's line in each repo (delivery line design §4.9), as last read; absent: none. */
  placements?: readonly PlacementFacts[];
  /** The owner's `integration.ci` (ADR-036, §17.1): `ciRed` is computed only when on; absent: off, the default. */
  ci?: IntegrationCi;
}

// ---------------------------------------------------------------------------
// The figures (pure).
// ---------------------------------------------------------------------------

function figure(id: GovernorFigureId, value: number, threshold: number, op: ">=" | ">", detail: string | null = null): GovernorFigure {
  const crossed = op === ">=" ? value >= threshold : value > threshold;
  return { family: GOVERNOR_FIGURES[id], id, value, threshold, op, crossed, detail: detail === null ? null : detail.slice(0, MAX_FIGURE_DETAIL) };
}

/** `value` to one decimal. */
const tenths = (value: number): number => Math.round(value * 10) / 10;

const TIER_RANK: Readonly<Record<Tier, number>> = { Small: 0, Medium: 1, Large: 2 };

/** The largest entry of a count map, or `[null, 0]`. */
function largest(counts: ReadonlyMap<string, number>): [string | null, number] {
  let best: [string | null, number] = [null, 0];
  for (const [key, count] of counts) if (count > best[1]) best = [key, count];
  return best;
}

/**
 * When a done criterion was last met with evidence (delivery line design §8.4:
 * its `metAt`; an older entry, its `at` while it is met), else when the
 * charter was confirmed, else when the mission began. A criterion moved back
 * to open, or a status sent again, moves nothing. Pure.
 */
export function lastCriterionChangeOf(mission: Pick<Mission, "createdAt" | "charter">): string {
  const changes = mission.charter.doneCriteria.map(metAtOf).filter((at): at is string => at !== null);
  const latest = changes.reduce<string | null>((best, at) => (best === null || timeOrZero(at) > timeOrZero(best) ? at : best), null);
  return latest ?? mission.charter.confirmedAt ?? mission.createdAt;
}

/** Whether a Main's turn counts for drift (delivery line design §8.4): the owner or a report started it, or its record predates `trigger`. */
export function countsForDrift(record: Pick<TraceRecord, "trigger">): boolean {
  return record.trigger === undefined || record.trigger === "owner" || record.trigger === "report";
}

/** The reports of one request in `records`, oldest first, each once. */
function reportsOf(records: readonly TraceRecord[], requestId: string): TraceRecord["reports"] {
  const seen = new Set<string>();
  const reports: TraceRecord["reports"] = [];
  for (const record of records) {
    for (const report of record.reports) {
      if ((report.requestId ?? record.requestId) !== requestId) continue;
      const key = report.recordId ?? `${report.agentId}|${report.at}|${report.phase ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reports.push(report);
    }
  }
  return reports.sort((a, b) => timeOrZero(a.at) - timeOrZero(b.at));
}

/** True when a report's tier rose above the request's `received` tier (else its first tier). */
function tierWasRaised(reports: TraceRecord["reports"]): boolean {
  const tiered = reports.filter((report): report is typeof report & { tier: Tier } => report.tier !== null);
  const base = tiered.find((report) => report.phase === "received") ?? tiered[0];
  if (base === undefined) return false;
  const after = tiered.slice(tiered.indexOf(base) + 1);
  return after.some((report) => TIER_RANK[report.tier] > TIER_RANK[base.tier]);
}

/** The snapshot's lines of ready placements (delivery line design §4.9): an archived or retired one is nobody's work now. */
const linesOf = (snapshot: GovernorSnapshot): readonly PlacementFacts[] => (snapshot.placements ?? []).filter((line) => line.state === "ready");

/** The files each record of the snapshot wrote (`writtenFilesOf`), read once per record for every figure. */
type WrittenFiles = ReadonlyMap<TraceRecord, readonly string[]>;

function messFigures(snapshot: GovernorSnapshot, settings: GovernorSettings, written: WrittenFiles): GovernorFigure[] {
  const now = timeOrZero(snapshot.now);
  const live = new Map(snapshot.liveWorkers.map((worker) => [worker.agentId, worker.workspaceId]));

  // Live Workers on one file, from their file evidence of the last 24 hours.
  const writers = new Map<string, Set<string>>();
  for (const record of snapshot.records) {
    if (!live.has(record.agentId) || now - timeOrZero(record.endedAt) > GOVERNOR_RECENT_MS) continue;
    for (const file of written.get(record) ?? []) {
      const key = `${record.workspaceId}: ${file}`;
      writers.set(key, (writers.get(key) ?? new Set()).add(record.agentId));
    }
  }
  const [file, onOneFile] = largest(new Map([...writers].map(([key, agents]) => [key, agents.size])));

  // Workers at work: a finished Worker left idle for its Main to reuse is no sprawl (the 2026-10-09 acceptance run).
  const busy = new Set(snapshot.requests.filter((request) => request.rosterState === "active").flatMap((request) => request.workerIds));
  const perRepo = new Map<string, number>();
  for (const [agentId, workspaceId] of live) if (busy.has(agentId)) perRepo.set(workspaceId, (perRepo.get(workspaceId) ?? 0) + 1);
  const [repo, inOneRepo] = largest(perRepo);
  const budgetWorkers = snapshot.mission.charter.budget?.workers ?? null;
  const repoThreshold = budgetWorkers === null ? settings.workersPerRepo : Math.min(settings.workersPerRepo, budgetWorkers);

  // Re-asks: one request's questions on one subject, past the first.
  const asks = new Map<string, number>();
  for (const decision of snapshot.decisions) {
    if (!decision.id.startsWith("q:") || decision.subject === null || decision.requestId === null) continue;
    const key = `${decision.requestId}: ${decision.subject}`;
    asks.set(key, (asks.get(key) ?? 0) + 1);
  }
  const [subject, asked] = largest(asks);

  const dropped = snapshot.dropped.filter((record) => record.outcomeAt === null || now - timeOrZero(record.outcomeAt) <= GOVERNOR_RECENT_MS).length;

  // Delivery line design §4.9: a dirty worktree nobody works in, hours after its last finished request.
  const working = new Set(live.values());
  const idle = new Map<string, number>();
  for (const line of linesOf(snapshot)) {
    if (line.dirty !== true || line.workspaceId === null || working.has(line.workspaceId)) continue;
    const last = Math.max(...snapshot.requests.filter((request) => request.workspaceId === line.workspaceId && request.finishedAt !== null).map((request) => timeOrZero(request.finishedAt)));
    if (Number.isFinite(last) && last > 0) idle.set(line.repo, tenths(Math.max(0, now - last) / 3_600_000));
  }
  const [uncommittedRepo, uncommitted] = largest(idle);

  return [
    figure("writersOnOneFile", onOneFile, settings.writersPerFile, ">=", file),
    figure("workersInOneRepo", inOneRepo, repoThreshold, ">", repo),
    figure("reAsks", Math.max(0, asked - 1), settings.reAsks, ">=", subject),
    figure("dropped", dropped, settings.dropped, ">="),
    figure("uncommittedHours", uncommitted, settings.uncommittedHours, ">=", uncommittedRepo),
  ];
}

function overengineeringFigures(snapshot: GovernorSnapshot, settings: GovernorSettings, written: WrittenFiles): GovernorFigure[] {
  const documents = new Set<string>();
  for (const record of snapshot.records) {
    for (const file of written.get(record) ?? []) {
      if (isProcessDocumentPath(file)) documents.add(`${record.workspaceId}: ${file}`);
    }
  }
  const criteria = snapshot.mission.charter.doneCriteria.filter((criterion) => criterion.status !== "dropped").length;

  const finished = snapshot.requests.filter((request) => request.finishedAt !== null || request.rosterState === "finished");
  const beads = finished.reduce(
    (sum, request) => sum + new Set(reportsOf(snapshot.records, request.requestId).flatMap((report) => report.beadsCreated)).size,
    0,
  );

  const raised = snapshot.requests.filter((request) => tierWasRaised(reportsOf(snapshot.records, request.requestId))).length;
  const capReached = snapshot.requests.filter((request) => {
    if (request.tier === null) return false;
    // The next call would pass the ceiling even in a new milestone batch: the review tools refuse it.
    const ceiling = reviewCapOf(request.tier, request.reviewMilestones + 1, snapshot.review) + request.reviewGranted;
    return request.reviewCalls + 1 > ceiling;
  }).length;
  const now = timeOrZero(snapshot.now);
  const unconverged = snapshot.requests.reduce(
    (sum, request) => sum + (request.unconvergedAt ?? []).filter((at) => now - timeOrZero(at) <= GOVERNOR_RECENT_MS).length,
    0,
  );
  // The snapshot holds only q:/o: and m: decisions.
  const approvals = snapshot.decisions.filter(isAnswerable).length;

  return [
    figure("processDocsPerCriterion", tenths(documents.size / Math.max(1, criteria)), settings.processDocsPerCriterion, ">"),
    figure("beadsPerFinishedRequest", finished.length === 0 ? 0 : tenths(beads / finished.length), settings.beadsPerRequest, ">"),
    figure("tierRaised", raised, settings.tierRaised, ">="),
    figure("reviewCapReached", capReached, settings.reviewExhausted, ">="),
    figure("unconvergedBatches", unconverged, settings.reviewExhausted, ">="),
    figure("openApprovals", approvals, settings.openApprovals, ">"),
  ];
}

function driftFigures(snapshot: GovernorSnapshot, settings: GovernorSettings): GovernorFigure[] {
  const since = timeOrZero(lastCriterionChangeOf(snapshot.mission));
  // A mission whose done criteria are all settled, with no request open, has no goal left to drift from:
  // its Main only answers the owner (the 2026-10-09 acceptance run). Without criteria, its turns still count.
  const criteria = snapshot.mission.charter.doneCriteria;
  const settled = criteria.length > 0 && criteria.every((criterion) => criterion.status !== "open") && snapshot.requests.every((request) => request.rosterState !== "active");
  // Delivery line design §8.4: only the turns the owner or a report started; the plugin's own wake-ups are no drift.
  const turns = settled ? 0 : (snapshot.driftTurnEnds ?? snapshot.mainTurnEnds).filter((at) => timeOrZero(at) > since).length;
  // Delivery line design §2.7: a chain counts once — a finished request whose continuation finished too is left out.
  const finishedIds = new Set(snapshot.requests.filter((request) => request.finishedAt !== null && timeOrZero(request.finishedAt) > since).map((request) => request.requestId));
  const finished = snapshot.requests.filter((request) => finishedIds.has(request.requestId) && !finishedIds.has(request.continuedBy ?? "")).length;
  const repos = new Set(snapshot.mission.charter.repos);
  // Delivery line design §3.1: a placement is its repo, so a request in it is inside the charter.
  const keyOf = (workspaceId: string): string => snapshot.repoKeys?.[workspaceId] ?? workspaceId;
  const outside =
    repos.size === 0
      ? []
      : [
          ...snapshot.requests.map((request) => keyOf(request.workspaceId)),
          ...snapshot.links.map((link) => keyOf(link.toWorkspaceId)),
        ].filter((repo) => !repos.has(repo));
  const [behindRepo, behind] = largest(new Map(linesOf(snapshot).map((line): [string, number] => [line.repo, line.behind ?? 0])));
  return [
    figure("mainTurnsSinceCriterion", turns, settings.mainTurnsSinceCriterion, ">"),
    figure("finishedSinceCriterion", finished, settings.finishedSinceCriterion, ">"),
    figure("outsideCharter", outside.length, settings.outsideCharter, ">=", outside.length === 0 ? null : [...new Set(outside)].join(", ")),
    figure("behindIntegration", behind, settings.behindCommits, ">=", behindRepo),
  ];
}

const isDone = (request: GovernorRequestFacts): boolean =>
  request.rosterState === "finished" || request.rosterState === "stopped" || request.lastPhase === "finished" || request.lastPhase === "stopped";

/** What the snapshot knows for `structuralWaitOf` (delivery line design §6.5). */
export type GovernorWaitContext = Pick<GovernorSnapshot, "now" | "decisions" | "links" | "liveWorkers" | "runningAgents">;

/**
 * The snapshot's facts for `structuralWaitOf`: a question among its
 * decisions; an awaited request of the mission at the head of its chain, with
 * its live Workers; a link while it is live (the stall pass settles one past
 * its ceiling); a Reviewer running. Anything else is unknown. Pure.
 */
export function governorWaitFactsOf(requests: readonly GovernorRequestFacts[], context: GovernorWaitContext): StructuralWaitFacts {
  const byId = new Map(requests.map((request) => [request.requestId, request]));
  const live = new Set(context.liveWorkers.map((worker) => worker.agentId));
  const running = new Set(context.runningAgents ?? []);
  return {
    now: context.now,
    pendingMs: PENDING_TTL_MS,
    question(id) {
      const decision = context.decisions.find((entry) => entry.id === id);
      return decision === undefined ? null : isAnswerable(decision) ? "open" : "closed";
    },
    request(id): WaitRequestFact | null {
      let head = byId.get(id);
      if (head === undefined) return null;
      for (let step = 0; step < 50 && head.continuedBy !== undefined; step += 1) {
        const next = byId.get(head.continuedBy);
        if (next === undefined) break;
        head = next;
      }
      const state = head.finishedAt !== null || head.rosterState === "finished" || head.lastPhase === "finished" ? "finished" : head.rosterState === "stopped" || head.lastPhase === "stopped" ? "stopped" : "active";
      return { headId: head.requestId, state, workers: head.workerIds.length, liveWorker: head.workerIds.some((workerId) => live.has(workerId)) };
    },
    link: (id) => (context.links.some((link) => link.linkId === id) ? { state: "taken", closedBy: null, ceiling: null } : null),
    isRunning: (agentId) => running.has(agentId),
  };
}

/**
 * The requests the `stalled` figure leaves out: a stopped one, and a waiting
 * one. A request with a structured wait (delivery line design §6.5) waits
 * while every unsettled item of it is live (`structuralWaitOf`); an older
 * report, with none, waits when it is `blocked` on a request or Worker of the
 * same mission that is not finished or stopped, as its `waitingFor` text
 * names it (mission runtime design §6.3). Without `context`, only the older
 * reading. Pure.
 */
export function waitingOrStoppedOf(requests: readonly GovernorRequestFacts[], context: GovernorWaitContext | null = null): Set<string> {
  const active = requests.filter((request) => !isDone(request));
  const facts = context === null ? null : governorWaitFactsOf(requests, context);
  const out = new Set<string>();
  for (const request of requests) {
    // Delivery line design §2.7: a continued request's work goes on as its continuation.
    if (request.rosterState === "stopped" || request.lastPhase === "stopped" || request.continuedBy !== undefined) out.add(request.requestId);
    else if ((request.waiting?.items.length ?? 0) > 0) {
      if (facts !== null && structuralWaitOf({ waiting: request.waiting, reviews: { batches: request.reviewBatches ?? [] } }, facts).holds) out.add(request.requestId);
    } else if (request.lastPhase === "blocked" && request.waitingOn != null) {
      const on = request.waitingOn;
      const named = active.some((other) => other.requestId !== request.requestId && (on.includes(other.requestId) || other.workerIds.some((workerId) => on.includes(workerId))));
      if (named) out.add(request.requestId);
    }
  }
  return out;
}

function stuckFigures(snapshot: GovernorSnapshot, settings: GovernorSettings): GovernorFigure[] {
  const now = timeOrZero(snapshot.now);
  const old = snapshot.decisions.filter((decision) => isAnswerable(decision) && now - timeOrZero(decision.askedAt) > settings.cardAgeHours * 3_600_000);
  const count = (id: GovernorFigureId, subjects: readonly string[]) => figure(id, subjects.length, 1, ">=", subjects.length === 0 ? null : subjects.join(", "));
  const of = (kind: Alert["kind"]) => snapshot.alerts.filter((alert) => alert.kind === kind).map((alert) => alert.subject);
  const notStalled = waitingOrStoppedOf(snapshot.requests, snapshot);
  // Delivery line design §4.9: a line ahead with no merge request, red CI, a merge request that conflicts.
  const lines = linesOf(snapshot);
  const since = (at: string | null, unit: number): number => (at === null ? 0 : Math.max(0, now - timeOrZero(at)) / unit);
  const [unpushedRepo, unpushed] = largest(new Map(lines.filter((line) => (line.ahead ?? 0) > 0 && line.mr === null).map((line): [string, number] => [line.repo, tenths(since(line.firstAheadAt, 3_600_000))])));
  const [redRepo, red] = largest(new Map(lines.filter((line) => line.ci === "failure").map((line): [string, number] => [line.repo, Math.floor(since(line.ciSince, 60_000))])));
  return [
    count("stalled", of("request-stalled").filter((requestId) => !notStalled.has(requestId))),
    count("unansweredLinks", of("peer-unanswered")),
    count("oldCards", old.map((decision) => decision.id)),
    figure("unpushedNoMr", unpushed, settings.unpushedHours, ">=", unpushedRepo),
    // ADR-036 (§17.1): with CI off there is no `ciRed`.
    ...(snapshot.ci === "on" ? [figure("ciRed", red, settings.ciRedMinutes, ">=", redRepo)] : []),
    count("mrConflicting", lines.filter((line) => line.mr?.mergeable === false).map((line) => line.repo)),
  ];
}

function budgetFigures(snapshot: GovernorSnapshot, settings: GovernorSettings): GovernorFigure[] {
  const budget = snapshot.mission.charter.budget;
  if (budget === null) return [];
  const started = snapshot.mission.charter.confirmedAt ?? snapshot.mission.createdAt;
  const used: ReadonlyArray<[GovernorFigureId, number | null, number]> = [
    ["requestsBudget", budget.requests, snapshot.requests.length],
    ["workersBudget", budget.workers, new Set(snapshot.requests.flatMap((request) => request.workerIds)).size],
    ["reviewCallsBudget", budget.reviewCalls, snapshot.requests.reduce((sum, request) => sum + request.reviewCalls, 0)],
    ["daysBudget", budget.days, Math.max(0, timeOrZero(snapshot.now) - timeOrZero(started)) / 86_400_000],
  ];
  // A field the owner left empty, or set to 0, budgets nothing.
  return used.flatMap(([id, limit, value]) =>
    limit === null || limit <= 0 ? [] : [figure(id, Math.floor((value / limit) * 100), settings.budgetPercent, ">=", `${tenths(value)} of ${limit}`)],
  );
}

/** Every figure of the mission now, in the order of `GOVERNOR_FIGURES` (the budget ones only for its budget's fields). Pure. */
export function governorFiguresOf(snapshot: GovernorSnapshot, settings: GovernorSettings): GovernorFigure[] {
  const written: WrittenFiles = new Map(snapshot.records.map((record) => [record, writtenFilesOf(record, snapshot.directories[record.workspaceId] ?? null)]));
  return [
    ...messFigures(snapshot, settings, written),
    ...overengineeringFigures(snapshot, settings, written),
    ...driftFigures(snapshot, settings),
    ...stuckFigures(snapshot, settings),
    ...budgetFigures(snapshot, settings),
  ];
}

// ---------------------------------------------------------------------------
// The snapshot (reads the stores).
// ---------------------------------------------------------------------------

/** An agent as a Paseo list gives it (`agentsOf(...).bm`). */
export interface ListedAgent {
  workspaceId: string | null;
  facts: { id: string; status: string; archived: boolean; replacedBy?: string | null };
}

/** The mission's Workers among `agents` that are live: not archived, not closed, not replaced. Pure. */
export function liveWorkersOf(agents: readonly ListedAgent[], requests: ReadonlyArray<Pick<GovernorRequestFacts, "workspaceId" | "workerIds">>): Array<{ agentId: string; workspaceId: string }> {
  const repoOf = new Map(requests.flatMap((request) => request.workerIds.map((workerId) => [workerId, request.workspaceId] as const)));
  return agents
    .filter(({ facts }) => repoOf.has(facts.id) && !facts.archived && facts.status !== "closed" && (facts.replacedBy ?? null) === null)
    .map(({ facts }) => ({ agentId: facts.id, workspaceId: repoOf.get(facts.id)! }));
}

/** The newest report record of a request's Workers, newest Worker first. */
function newestReportOf(home: string, workspaceId: string, workerIds: readonly string[]): { text: string; createdAt: string } | null {
  for (const workerId of [...workerIds].reverse()) {
    const record = newestReportRecordOf(home, workspaceId, workerId);
    if (record !== null) return record;
  }
  return null;
}

/**
 * When each batch of `request` the convergence rule stopped (delivery line
 * design §5.2: its re-reviews spent, or its blocking count not falling) got
 * its last result. Pure.
 */
export function unconvergedTimesOf(request: Pick<RegisteredRequest, "reviews">, traceReviews: Parameters<typeof batchResultsOf>[1], maxRereviews: number): string[] {
  return request.reviews.batches.flatMap((batch) => {
    const results = batchResultsOf(batch, traceReviews);
    const refusal = convergenceRefusalOf({ batchId: batch.batchId, results, calls: batch.calls, maxRereviews });
    const last = results.at(-1);
    return refusal !== null && refusal.endsWith(CONVERGENCE_STOP_TAIL) && last !== undefined ? [last.at] : [];
  });
}

export interface GovernorSnapshotDeps {
  now: Date;
  /** The live agents (a Paseo list); the mission's live Workers are taken from it. */
  agents: readonly ListedAgent[];
  /** The owner's review settings: `callsPerBatch` for the cap, `maxRereviews` for the convergence rule; `integration.ci` for `ciRed` (absent: off). */
  settings: Pick<CoordinationSettings, "review"> & Partial<Pick<CoordinationSettings, "integration">>;
  log?: (message: string) => void;
}

/**
 * Reads one mission's snapshot from the data folder `home` (see the module
 * comment). A store that cannot be read counts as empty for its figures.
 * Never throws.
 */
export function readGovernorSnapshot(home: string, mission: Mission, deps: GovernorSnapshotDeps): GovernorSnapshot {
  const log = deps.log ?? (() => {});
  const quietly = <T>(what: string, read: () => T, fallback: T): T => {
    try {
      return read();
    } catch (error) {
      log(`[paseo-bm] the governor could not read ${what} of mission ${mission.code}: ${errorText(error)}`);
      return fallback;
    }
  };
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };
  const roster = createMissionRoster(home).list(mission.missionId);
  const registry = createRequestRegistry(home, { log });
  const registeredOf = new Map<string, RegisteredRequest>();
  // Delivery line design §4.9: the newest git fields reported in each placement.
  const reportedIn = new Map<string, ReportedLine>();
  const requests: GovernorRequestFacts[] = roster.map((entry) => {
    const registered = registry.get(entry.workspaceId, entry.requestId);
    if (registered !== null) registeredOf.set(entry.requestId, registered);
    const report = quietly(`the reports of ${entry.requestId}`, () => newestReportOf(home, entry.workspaceId, entry.workerIds), null);
    const reported = report === null ? null : reportedLineOf({ text: report.text, at: report.createdAt });
    const known = reportedIn.get(entry.workspaceId);
    if (reported !== null && (known === undefined || timeOrZero(known.at) < timeOrZero(reported.at))) reportedIn.set(entry.workspaceId, reported);
    return {
      requestId: entry.requestId,
      workspaceId: entry.workspaceId,
      rosterState: entry.state,
      workerIds: [...new Set([...entry.workerIds, ...(registered?.workerIds ?? [])])],
      finishedAt: registered?.finishedAt ?? null,
      tier: registered?.tier ?? null,
      reviewCalls: registered === null ? 0 : registered.reviews.batches.reduce((sum, batch) => sum + batch.calls.length, 0),
      reviewGranted: registered === null ? 0 : grantedCallsOf(registered),
      reviewMilestones: registered === null ? 0 : milestoneBatchesOf(registered),
      lastPhase: report === null ? null : (reportPhaseOf(report.text) ?? null),
      waitingOn: report === null ? null : waitingOnOf(report.text),
      // Delivery line design §6.5: the structured wait, read before the text.
      ...(registered?.waiting == null ? {} : { waiting: registered.waiting, reviewBatches: registered.reviews.batches }),
      ...(registered?.continuedBy === undefined ? {} : { continuedBy: registered.continuedBy }),
    };
  });
  const requestIds = new Set(requests.map((request) => request.requestId));
  const workerIds = new Set(requests.flatMap((request) => request.workerIds));
  const repos = [...new Set(requests.map((request) => request.workspaceId))];

  const records = repos.flatMap((workspaceId) =>
    quietly(`the traces of ${workspaceId}`, () => readRecords(location, workspaceId).records, []).filter(
      (record) => (record.requestId !== null && requestIds.has(record.requestId)) || workerIds.has(record.agentId),
    ),
  );
  // Delivery line design §5.2: the batches the convergence rule stopped; a batch an older build opened reads its results from the trace.
  for (const request of requests) {
    const registered = registeredOf.get(request.requestId);
    if (registered === undefined) continue;
    const reviews = records.filter((record) => record.requestId === request.requestId).flatMap(ownReviewsOf);
    request.unconvergedAt = unconvergedTimesOf(registered, reviews, deps.settings.review.maxRereviews);
  }
  const directories = Object.fromEntries(repos.map((workspaceId) => [workspaceId, quietly("a repo's folder", () => readWorkspaceMeta(location, workspaceId)?.lastKnownDirectory ?? null, null)]));

  // The Mains' turns are traced under their home; a legacy mission's Main in its repo (§3.6).
  const mainIds = new Set([...mission.mainHistory.map((entry) => entry.agentId), ...(mission.mainId === null ? [] : [mission.mainId])]);
  const mainPlaces = mainPlacesOf(home, mission);
  const mainTurns = new Map<string, string>();
  const driftTurns = new Map<string, string>();
  for (const workspaceId of mainPlaces) {
    for (const record of quietly("the Mains' traces", () => readRecords(location, workspaceId).records, [])) {
      if (!mainIds.has(record.agentId)) continue;
      const key = `${record.agentId}|${record.startedAt ?? ""}|${record.endedAt}`;
      mainTurns.set(key, record.endedAt);
      if (countsForDrift(record)) driftTurns.set(key, record.endedAt);
    }
  }

  const decisionStore = createDecisionStore(home, { log });
  const decisions = [
    ...repos.flatMap((workspaceId) =>
      quietly("the decisions", () => decisionStore.list({ workspaceId }), []).filter(
        (decision) => decision.requestId !== null && requestIds.has(decision.requestId) && /^[qo]:/.test(decision.id),
      ),
    ),
    ...createMissionDecisionStore(home).list(mission.missionId),
  ];

  const outbox = createOutbox(home);
  const dropped = [...new Set([...repos, ...mainPlaces])].flatMap((workspaceId) =>
    outbox
      .list(workspaceId)
      .filter((record) => record.state === "dropped" && (requestIds.has(record.requestId) || missionOfDecisionId(record.requestId) === mission.missionId))
      .map((record) => ({ id: record.id, outcomeAt: record.outcomeAt })),
  );

  const repoOf = new Map(requests.map((request) => [request.requestId, request.workspaceId]));
  const alerts = quietly("the alerts", () => createAlertStore(home).list({ open: true, kinds: ["request-stalled", "peer-unanswered"] }), []).filter(
    (alert) => repoOf.get(alert.subject) === alert.workspaceId,
  );
  const repoKeys = Object.entries(placementIndexIn(home)).map(([placement, { repo }]) => [placement, repo] as const);
  const links = quietly("the links", () => createPeerLinkStore(home).list(), [])
    .filter((link) => isLiveLink(link) && link.from.requestId !== null && requestIds.has(link.from.requestId))
    .map((link) => ({ linkId: link.linkId, toWorkspaceId: link.to.workspaceId }));
  // The lines as the 60-second pass last read them: no git here (`line-watch.ts`).
  const ci: IntegrationCi = ciUsed(deps.settings) ? "on" : "off";
  const placements = newestPlacementsOf(mission).map((placement) =>
    placementFactsOf(placement, cachedLineOf(home, placement.workspaceId), placement.workspaceId === null ? null : (reportedIn.get(placement.workspaceId) ?? null), null, ci),
  );

  return {
    now: deps.now.toISOString(),
    mission,
    requests,
    liveWorkers: liveWorkersOf(deps.agents, requests),
    records,
    directories,
    mainTurnEnds: [...mainTurns.values()],
    driftTurnEnds: [...driftTurns.values()],
    decisions,
    dropped,
    alerts,
    links,
    review: deps.settings.review,
    runningAgents: deps.agents.filter(({ facts }) => facts.status === "running").map(({ facts }) => facts.id),
    ...(repoKeys.length === 0 ? {} : { repoKeys: Object.fromEntries(repoKeys) }),
    ...(placements.length === 0 ? {} : { placements }),
    ci,
  };
}
