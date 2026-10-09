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
 *   request's registry entry in its repo (tier, finish, review calls and
 *   grants), the trace records of the mission's requests and Workers in their
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
 * | overengineering | `processDocsPerCriterion`: process documents (`isProcessDocumentPath`) written ÷ done criteria not dropped (at least 1) | > `processDocsPerCriterion` |
 * | | `beadsPerFinishedRequest`: beads created by the finished requests ÷ their number | > `beadsPerRequest` |
 * | | `tierRaised`: requests whose report tier rose above their `received` tier | ≥ `tierRaised` |
 * | | `reviewBudgetExhausted`: requests whose next review call the budget refuses | ≥ `reviewExhausted` |
 * | | `openApprovals`: open `q:`/`o:` cards of the mission's requests and open `m:` cards | > `openApprovals` |
 * | drift | `mainTurnsSinceCriterion`: the Mains' turns since a done criterion last changed state (else since the charter was confirmed, else since the mission began); none while every done criterion is met or dropped and no request is open | > `mainTurnsSinceCriterion` |
 * | | `finishedSinceCriterion`: requests finished since then | > `finishedSinceCriterion` |
 * | | `outsideCharter`: requests and live links in repos outside `charter.repos` (none while it is empty) | ≥ `outsideCharter` |
 * | stuck | `stalled`, `unansweredLinks`: open alerts of the mission's requests; `oldCards`: open cards older than `cardAgeHours` | ≥ 1 each |
 * | budget | `requestsBudget`, `workersBudget`, `reviewCallsBudget`, `daysBudget`: percent of each `charter.budget` field above 0 | ≥ `budgetPercent` |
 *
 * Documents in Review or Draft are not counted among the open approvals: no
 * store holds them yet.
 */
import { join } from "node:path";
import type { Alert } from "../shared/alerts";
import type { Tier, TraceRecord } from "../shared/contracts";
import { reviewBudgetOf, type CoordinationSettings, type GovernorSettings, type ReviewBudget } from "../shared/coordination";
import { isAnswerable, type Decision } from "../shared/decisions";
import { isProcessDocumentPath, overReviewCeiling, reviewCeilingOf } from "../shared/orchestrator-rules";
import { timeOrZero } from "../shared/time";
import { GOVERNOR_FIGURES, MAX_FIGURE_DETAIL, type GovernorFigure, type GovernorFigureId } from "../shared/governor-figures";
import { writtenFilesOf } from "../shared/writers-observed";
import { createAlertStore } from "./alert-store";
import { TRACES_DIR_NAME } from "./data-home";
import { createDecisionStore } from "./decision-store";
import { createMissionDecisionStore, missionOfDecisionId } from "./mission-decisions";
import { createMissionRoster, type RosterState } from "./mission-roster";
import type { Mission } from "./mission-store";
import { missionsHomeIdOf } from "./missions-home";
import { createOutbox } from "./outbox";
import { createPeerLinkStore, isLiveLink } from "./peer-links";
import { createRequestRegistry } from "./request-registry";
import { exemptCallsOf, grantedCallsOf } from "./review-tools";
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
  /** Its review calls, the calls its grants add, and those an untilClean grant leaves out (`review-tools.ts`). */
  reviewCalls: number;
  reviewGranted: number;
  reviewExempt: number;
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
  /** The `q:`/`o:` decisions of the mission's requests and its `m:` decisions. */
  decisions: ReadonlyArray<Pick<Decision, "id" | "requestId" | "subject" | "askedAt" | "status">>;
  /** The mission's dropped outbox records. */
  dropped: ReadonlyArray<{ id: string; outcomeAt: string | null }>;
  /** The open `request-stalled` and `peer-unanswered` alerts of the mission's requests. */
  alerts: ReadonlyArray<Pick<Alert, "kind" | "subject">>;
  /** The live links the mission's requests asked, by their target repo. */
  links: ReadonlyArray<{ linkId: string; toWorkspaceId: string }>;
  /** The owner's review budget per tier. */
  reviewBudget: ReviewBudget;
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

/** When a done criterion last changed state, else when the charter was confirmed, else when the mission began. Pure. */
export function lastCriterionChangeOf(mission: Pick<Mission, "createdAt" | "charter">): string {
  const changes = mission.charter.doneCriteria.map((criterion) => criterion.at).filter((at): at is string => at !== null);
  const latest = changes.reduce<string | null>((best, at) => (best === null || timeOrZero(at) > timeOrZero(best) ? at : best), null);
  return latest ?? mission.charter.confirmedAt ?? mission.createdAt;
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

  return [
    figure("writersOnOneFile", onOneFile, settings.writersPerFile, ">=", file),
    figure("workersInOneRepo", inOneRepo, repoThreshold, ">", repo),
    figure("reAsks", Math.max(0, asked - 1), settings.reAsks, ">=", subject),
    figure("dropped", dropped, settings.dropped, ">="),
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
  const exhausted = snapshot.requests.filter((request) => {
    if (request.tier === null) return false;
    const ceiling = reviewCeilingOf(snapshot.reviewBudget[request.tier], request.reviewGranted);
    // The next call would pass the ceiling: the review tools refuse it.
    return overReviewCeiling(request.reviewCalls + 1, request.reviewExempt, ceiling);
  }).length;
  // The snapshot holds only q:/o: and m: decisions.
  const approvals = snapshot.decisions.filter(isAnswerable).length;

  return [
    figure("processDocsPerCriterion", tenths(documents.size / Math.max(1, criteria)), settings.processDocsPerCriterion, ">"),
    figure("beadsPerFinishedRequest", finished.length === 0 ? 0 : tenths(beads / finished.length), settings.beadsPerRequest, ">"),
    figure("tierRaised", raised, settings.tierRaised, ">="),
    figure("reviewBudgetExhausted", exhausted, settings.reviewExhausted, ">="),
    figure("openApprovals", approvals, settings.openApprovals, ">"),
  ];
}

function driftFigures(snapshot: GovernorSnapshot, settings: GovernorSettings): GovernorFigure[] {
  const since = timeOrZero(lastCriterionChangeOf(snapshot.mission));
  // A mission whose done criteria are all settled, with no request open, has no goal left to drift from:
  // its Main only answers the owner (the 2026-10-09 acceptance run). Without criteria, its turns still count.
  const criteria = snapshot.mission.charter.doneCriteria;
  const settled = criteria.length > 0 && criteria.every((criterion) => criterion.status !== "open") && snapshot.requests.every((request) => request.rosterState !== "active");
  const turns = settled ? 0 : snapshot.mainTurnEnds.filter((at) => timeOrZero(at) > since).length;
  const finished = snapshot.requests.filter((request) => request.finishedAt !== null && timeOrZero(request.finishedAt) > since).length;
  const repos = new Set(snapshot.mission.charter.repos);
  const outside =
    repos.size === 0
      ? []
      : [
          ...snapshot.requests.filter((request) => !repos.has(request.workspaceId)).map((request) => request.workspaceId),
          ...snapshot.links.filter((link) => !repos.has(link.toWorkspaceId)).map((link) => link.toWorkspaceId),
        ];
  return [
    figure("mainTurnsSinceCriterion", turns, settings.mainTurnsSinceCriterion, ">"),
    figure("finishedSinceCriterion", finished, settings.finishedSinceCriterion, ">"),
    figure("outsideCharter", outside.length, settings.outsideCharter, ">=", outside.length === 0 ? null : [...new Set(outside)].join(", ")),
  ];
}

function stuckFigures(snapshot: GovernorSnapshot, settings: GovernorSettings): GovernorFigure[] {
  const now = timeOrZero(snapshot.now);
  const old = snapshot.decisions.filter((decision) => isAnswerable(decision) && now - timeOrZero(decision.askedAt) > settings.cardAgeHours * 3_600_000);
  const count = (id: GovernorFigureId, subjects: readonly string[]) => figure(id, subjects.length, 1, ">=", subjects.length === 0 ? null : subjects.join(", "));
  const of = (kind: Alert["kind"]) => snapshot.alerts.filter((alert) => alert.kind === kind).map((alert) => alert.subject);
  return [count("stalled", of("request-stalled")), count("unansweredLinks", of("peer-unanswered")), count("oldCards", old.map((decision) => decision.id))];
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

export interface GovernorSnapshotDeps {
  now: Date;
  /** The live agents (a Paseo list); the mission's live Workers are taken from it. */
  agents: readonly ListedAgent[];
  settings: Pick<CoordinationSettings, "review">;
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
  const requests: GovernorRequestFacts[] = roster.map((entry) => {
    const registered = registry.get(entry.workspaceId, entry.requestId);
    return {
      requestId: entry.requestId,
      workspaceId: entry.workspaceId,
      rosterState: entry.state,
      workerIds: [...new Set([...entry.workerIds, ...(registered?.workerIds ?? [])])],
      finishedAt: registered?.finishedAt ?? null,
      tier: registered?.tier ?? null,
      reviewCalls: registered === null ? 0 : registered.reviews.batches.reduce((sum, batch) => sum + batch.calls.length, 0),
      reviewGranted: registered === null ? 0 : grantedCallsOf(registered),
      reviewExempt: registered === null ? 0 : exemptCallsOf(registered),
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
  const directories = Object.fromEntries(repos.map((workspaceId) => [workspaceId, quietly("a repo's folder", () => readWorkspaceMeta(location, workspaceId)?.lastKnownDirectory ?? null, null)]));

  // The Mains' turns are traced under their home; a legacy mission's Main in its repo (§3.6).
  const mainIds = new Set([...mission.mainHistory.map((entry) => entry.agentId), ...(mission.mainId === null ? [] : [mission.mainId])]);
  const mainPlaces = [...new Set([missionsHomeIdOf(home), mission.legacyWorkspaceId].filter((id): id is string => id !== null))];
  const mainTurns = new Map<string, string>();
  for (const workspaceId of mainPlaces) {
    for (const record of quietly("the Mains' traces", () => readRecords(location, workspaceId).records, [])) {
      if (mainIds.has(record.agentId)) mainTurns.set(`${record.agentId}|${record.startedAt ?? ""}|${record.endedAt}`, record.endedAt);
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
  const links = quietly("the links", () => createPeerLinkStore(home).list(), [])
    .filter((link) => isLiveLink(link) && link.from.requestId !== null && requestIds.has(link.from.requestId))
    .map((link) => ({ linkId: link.linkId, toWorkspaceId: link.to.workspaceId }));

  return {
    now: deps.now.toISOString(),
    mission,
    requests,
    liveWorkers: liveWorkersOf(deps.agents, requests),
    records,
    directories,
    mainTurnEnds: [...mainTurns.values()],
    decisions,
    dropped,
    alerts,
    links,
    reviewBudget: reviewBudgetOf(deps.settings),
  };
}
