/**
 * M-36, M-40 and M-42 (missions PRD; delivery line design §13): bounded
 * requests, waits by structure and maintenance on time, read from the stores
 * alone — the trace records, the request registry's chain fields, the stored
 * decisions, `orchestrator/compactions.json` and `handoffs/*.json`.
 *
 * - **M-36** (§2.6): the tokens a request reads — input + cached over all its
 *   turns, every role, as `turnTokensOf` reads a turn (the rollover's own
 *   `requestTokensReadOf`) — over the requests in the window: the largest,
 *   p50 and p95, and how many exceed `rollover.ceilingFactor` ×
 *   `rollover.tokens` at the settings read (the defaults without them). A
 *   chain (§2.2: the registry's `chainRootId`, else its `continuationOf` walked
 *   back) adds its requests in the window; the largest is given beside.
 * - **M-40** (§6.2–§6.4): (a) Worker turns started by a plugin delivery while
 *   the request's newest Worker report before the turn was `blocked` naming
 *   items by id (its `blockers` line: `waiting on the owner: Qn`, `waiting on
 *   requests:`, `waiting on review:`, `waiting on project: … (peer-…)`, and a
 *   `req-…` in `waiting for:`) and that wait was not yet met. The registry
 *   keeps only a request's current `waiting`, so each item's settle time is
 *   rebuilt: a question from its decision's `settledAt` (any final status, as
 *   `settleQuestionWait`); a request when it, or the head of its chain,
 *   reports `finished` or `stopped`; a batch at its first review or registry
 *   result after the report. A link's reply, and an item settled because its
 *   agent died, are not in these stores: such a wait is counted as not judged
 *   unless its known items decide it. `afterBlocked` is the upper bound — every
 *   such turn whether the wait was met or not. (b) The share of Worker tokens
 *   read in turns that end with a `blocked` report: the last report the
 *   Worker sent in the turn is `blocked` (a turn that sent none is not one,
 *   though it may follow one: a Worker goes on working after its answers).
 * - **M-42** (§6.6): compactions and handoffs dropped `no-safe-point`, by when
 *   they were asked; `afterCeiling` those that had waited at least
 *   `MAINTENANCE_WAIT_MS` (the time ceiling) when they ended. The token figure
 *   at the ceiling is not stored, so the time ceiling is the one judged; every
 *   `no-safe-point` drop waited its window (60 min), past the 30-minute ceiling.
 * - **M-37** (§3, ADR-035 decision 2): files written by Workers of two
 *   missions in one workspace — a placement, or before placements the shared
 *   checkout of a repo — from the Workers' own reports' `filesChanged` of the
 *   requests in the window, each file relative to its workspace folder. A
 *   request's mission is its roster's (`missions/<id>.roster.json`), else the
 *   mission whose placement its workspace is (`missions/index.json`).
 * - **M-38** (§4.4, §4.6): the finished mission requests (labelled as the
 *   admission evidence labels them, `requestFinishOf`) that changed files
 *   with no commit on their mission branch — as the Main's finished line
 *   said ("finished, committed on …" / "finished, uncommitted: …", found by
 *   the report's outbox record in a delivery), else as the report's
 *   `integration.commit` says — and the share of them (finished with changed
 *   files, as the admission evidence's verification share) verified: the
 *   line's "verified", the report's `integration.ci` success, or a check the
 *   plugin detected (A-9's `detected`); CI red is never verified.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { z } from "zod";
import { WAITING_FOR_PREFIX, WAITING_ON_OWNER_PREFIX, WAITING_ON_PROJECT_PREFIX } from "../bm-format";
import type { ParsedReport, TraceRecord } from "../contracts";
import { coordinationSettingsOf, DEFAULT_COORDINATION_SETTINGS } from "../coordination";
import type { Decision } from "../decisions";
import { requestFinishOf } from "../evidence";
import { MAINTENANCE_WAIT_MS } from "../interventions";
import { isPluginNotice, isPluginPrompt, noticeMarkerOf, parseDelivery, updatesItemsOf } from "../notices";
import { timeOrNull } from "../time";
import { requestIdsInText } from "../waits";
import { workspaceFileOf } from "../writers-observed";
import { compareText, percentile, ratio, recordStart, within } from "./helpers";
import type { EvalScope, EvalStores } from "./scope";
import { turnTokensOf } from "./tokens";
import type { EvalInput, EvalMetrics, EvalUnknowns } from "./types";

// ── The stores ──────────────────────────────────────────────────────────────

/** What the metrics read of a registry entry (`server/request-registry.ts`): its chain fields and its batches' results. */
const registryEntrySchema = z.object({
  requestId: z.string().min(1),
  workspaceId: z.string().min(1),
  continuationOf: z.string().min(1).optional(),
  chainRootId: z.string().min(1).optional(),
  continuedBy: z.string().min(1).optional(),
  reviews: z
    .object({ batches: z.array(z.object({ batchId: z.string(), results: z.array(z.object({ at: z.string() })).optional() })) })
    .optional(),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** What the metrics read of a compaction or handoff entry: where, when asked, when and how it ended. */
const maintenanceEntrySchema = z.object({
  workspaceId: z.string().min(1),
  requestedAt: z.string().min(1),
  endedAt: z.string().min(1).nullable(),
  ending: z.string().min(1).nullable(),
});
type MaintenanceEntry = z.infer<typeof maintenanceEntrySchema>;

/** The registry entries, valid ones by request id (the first of each); a bad one is counted. */
export function registryOf(input: Pick<EvalInput, "requests">, unknowns: EvalUnknowns): Map<string, RegistryEntry> {
  const entries: RegistryEntry[] = [];
  for (const raw of input.requests ?? []) {
    const parsed = registryEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else unknowns.invalidRequestEntries += 1;
  }
  entries.sort((a, b) => compareText(a.requestId, b.requestId) || compareText(a.workspaceId, b.workspaceId));
  const byId = new Map<string, RegistryEntry>();
  for (const entry of entries) if (!byId.has(entry.requestId)) byId.set(entry.requestId, entry);
  return byId;
}

/** Walks `next` from `start` until it gives none; bounded against a loop. */
function walk(start: string, next: (requestId: string) => string | undefined): string {
  const seen = new Set<string>([start]);
  let current = start;
  for (let step = next(current); step !== undefined && !seen.has(step) && seen.size < 1_000; step = next(current)) {
    seen.add(step);
    current = step;
  }
  return current;
}

/** Every turn's tokens read, beside its agent's turn before it that had usage (as `contextOf` reads them). */
export function tokensReadOf(scope: EvalScope): Map<TraceRecord, number | null> {
  const read = new Map<TraceRecord, number | null>();
  const lastWithUsage = new Map<string, TraceRecord>();
  for (const record of scope.records) {
    read.set(record, turnTokensOf(record, lastWithUsage.get(record.agentId) ?? null).tokensRead);
    if (record.usage !== null) lastWithUsage.set(record.agentId, record);
  }
  return read;
}

// ── M-36 ────────────────────────────────────────────────────────────────────

/** M-36 over the requests in the window. */
export function m36Of(
  scope: EvalScope,
  registry: ReadonlyMap<string, RegistryEntry>,
  read: ReadonlyMap<TraceRecord, number | null>,
  input: Pick<EvalInput, "requests" | "coordinationSettings">,
): EvalMetrics["m36"] {
  const settings = input.coordinationSettings === undefined ? DEFAULT_COORDINATION_SETTINGS : coordinationSettingsOf(input.coordinationSettings);
  const ceilingTokens = settings.rollover.ceilingFactor * settings.rollover.tokens;

  const totals: Array<{ requestId: string; workspaceId: string; tokensRead: number }> = [];
  for (const facts of scope.inScope) {
    let total: number | null = null;
    for (const record of facts.records) {
      const tokens = read.get(record) ?? null;
      if (tokens !== null) total = (total ?? 0) + tokens;
    }
    if (total !== null) totals.push({ requestId: facts.id, workspaceId: facts.records[0]!.workspaceId, tokensRead: total });
  }
  totals.sort((a, b) => b.tokensRead - a.tokensRead || compareText(a.workspaceId, b.workspaceId) || compareText(a.requestId, b.requestId));

  // A chain's root: the registry's `chainRootId`, else its `continuationOf` walked back; a request the registry does not know is its own.
  const rootOf = (requestId: string): string => registry.get(requestId)?.chainRootId ?? walk(requestId, (id) => registry.get(id)?.continuationOf);
  const chains = new Map<string, { requests: number; tokensRead: number }>();
  for (const total of totals) {
    const root = rootOf(total.requestId);
    const chain = chains.get(root) ?? { requests: 0, tokensRead: 0 };
    chain.requests += 1;
    chain.tokensRead += total.tokensRead;
    chains.set(root, chain);
  }
  const largestChain =
    [...chains.entries()]
      .map(([rootId, chain]) => ({ rootId, ...chain }))
      .sort((a, b) => b.tokensRead - a.tokensRead || compareText(a.rootId, b.rootId))[0] ?? null;
  const values = totals.map((total) => total.tokensRead);
  return {
    registryIncluded: input.requests !== undefined,
    settingsIncluded: input.coordinationSettings !== undefined,
    ceilingTokens,
    requests: totals.length,
    largest: totals[0] ?? null,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    overCeiling: values.filter((value) => value > ceilingTokens).length,
    chains: [...chains.values()].filter((chain) => chain.requests > 1).length,
    largestChain,
  };
}

// ── M-40 ────────────────────────────────────────────────────────────────────

/** An item a blocked report names by id. */
type WaitRef = { kind: "question" | "request" | "batch" | "link"; id: string };

const OWNER_QUESTIONS = new RegExp(`${WAITING_ON_OWNER_PREFIX} (Q\\d+(?:, Q\\d+)*)`);
const PEER_LINK_IN_TEXT = /\((peer-[0-9a-f]{12})\)/g;
/** Where the free text of `waiting for:` ends: the next part `bm_report` writes after it. */
const AFTER_WAITING_FOR = new RegExp(`\\. (?:${WAITING_ON_PROJECT_PREFIX}|wake on: any|Suggestion \\(not done\\):)`);

/** The items a blocked report names by id (delivery line design §6.2), each once; none for any other report. */
export function waitRefsOfReport(report: Pick<ParsedReport, "phase" | "blockers" | "waitingOnRequests" | "waitingOnBatches">, requestId: string): WaitRef[] {
  if (report.phase !== "blocked" || report.blockers === null) return [];
  const blockers = report.blockers;
  const refs: WaitRef[] = [];
  const seen = new Set<string>();
  const add = (kind: WaitRef["kind"], id: string): void => {
    if (seen.has(`${kind}:${id}`)) return;
    seen.add(`${kind}:${id}`);
    refs.push({ kind, id });
  };
  for (const n of OWNER_QUESTIONS.exec(blockers)?.[1]?.split(", ") ?? []) add("question", `q:${requestId}:${n}`);
  for (const id of report.waitingOnRequests ?? []) if (id !== requestId) add("request", id);
  const forAt = blockers.indexOf(WAITING_FOR_PREFIX);
  if (forAt >= 0) {
    const rest = blockers.slice(forAt + WAITING_FOR_PREFIX.length);
    const end = AFTER_WAITING_FOR.exec(rest)?.index ?? rest.length;
    for (const id of requestIdsInText(rest.slice(0, end), requestId)) add("request", id);
  }
  for (const id of report.waitingOnBatches ?? []) add("batch", id);
  const projectAt = blockers.indexOf(WAITING_ON_PROJECT_PREFIX);
  if (projectAt >= 0) for (const found of blockers.slice(projectAt).matchAll(PEER_LINK_IN_TEXT)) add("link", found[1]!);
  return refs;
}

/** The marker of a first inbound message: `BM-UPDATES`, a notice marker with its kind word (`BM-DELIVERY report`, `BM-ROLLOVER soft`), `BM-BRIEF`, `other`. */
function markerOf(text: string): string {
  if (updatesItemsOf(text) !== null) return "BM-UPDATES";
  const marker = noticeMarkerOf(text);
  if (marker !== null && text.startsWith(marker)) {
    const kind = /^[ \t]+([a-z][a-z-]*)(?=[ \t\r\n]|$)/.exec(text.slice(marker.length).split("\n")[0] ?? "")?.[1];
    return kind === undefined ? marker : `${marker} ${kind}`;
  }
  if (marker !== null) return marker;
  return isPluginPrompt(text) ? "BM-BRIEF" : "other";
}

/** What started a turn, as M-40 reads it: a plugin delivery or not, and the first inbound message's marker. */
function deliveryOf(record: TraceRecord): { plugin: boolean; marker: string } {
  const first = [...record.sent].sort((a, b) => compareText(a.at, b.at))[0];
  const text = first?.text;
  const marker = text === undefined ? "none" : markerOf(text);
  // The collector's `trigger` (delivery line design §8.4) where recorded; else the first inbound message's marker.
  if (record.trigger !== undefined) return { plugin: record.trigger === "plugin" || record.trigger === "report", marker };
  return { plugin: text !== undefined && (updatesItemsOf(text) !== null || isPluginNotice(text) || isPluginPrompt(text)), marker };
}

/** M-40 over the Worker turns in scope. */
export function m40Of(
  scope: EvalScope,
  stores: EvalStores,
  registry: ReadonlyMap<string, RegistryEntry>,
  read: ReadonlyMap<TraceRecord, number | null>,
  input: Pick<EvalInput, "requests" | "decisions">,
): EvalMetrics["m40"] {

  // Each request's Worker reports, oldest first: the reports its Worker turns carry (a Main's relay is not one).
  const workerReports = new Map<string, Array<{ at: number; report: ParsedReport }>>();
  for (const facts of scope.byRequest.values()) {
    const workers = new Set(facts.records.filter((record) => record.role === "worker").map((record) => record.agentId));
    const reports = facts.reports
      .filter((report) => workers.has(report.agentId))
      .map((report) => ({ at: timeOrNull(report.at), report }))
      .filter((entry): entry is { at: number; report: ParsedReport } => entry.at !== null)
      .sort((a, b) => a.at - b.at);
    workerReports.set(facts.id, reports);
  }
  /** The request's newest Worker report before `ms`. */
  const newestBefore = (requestId: string, ms: number): { at: number; report: ParsedReport } | null => {
    let newest: { at: number; report: ParsedReport } | null = null;
    for (const entry of workerReports.get(requestId) ?? []) if (entry.at < ms) newest = entry;
    return newest;
  };

  /** When an item settled: a time, Infinity while it never did in these stores, null when they cannot say. */
  const settledAtOf = (ref: WaitRef, requestId: string, since: number): number | null => {
    switch (ref.kind) {
      case "question": {
        const decision: Decision | undefined = stores.decisionById.get(ref.id);
        if (decision === undefined) return null;
        if (decision.status === "open" || decision.status === "needs-confirmation") return Number.POSITIVE_INFINITY;
        return timeOrNull(decision.settledAt);
      }
      case "request": {
        // It, or the head of its chain (delivery line design §6.3): a size finish of an earlier request settles nothing.
        const head = walk(ref.id, (id) => registry.get(id)?.continuedBy);
        const facts = scope.byRequest.get(head);
        if (facts === undefined) return null;
        const ends = facts.reports.filter((report) => report.phase === "finished" || report.phase === "stopped").map((report) => timeOrNull(report.at) ?? Number.POSITIVE_INFINITY);
        return ends.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ends);
      }
      case "batch": {
        const times = [
          ...(scope.byRequest.get(requestId)?.reviews ?? []).filter((review) => review.batchId === ref.id).map((review) => timeOrNull(review.at)),
          ...(registry.get(requestId)?.reviews?.batches ?? []).filter((batch) => batch.batchId === ref.id).flatMap((batch) => (batch.results ?? []).map((result) => timeOrNull(result.at))),
        ].filter((ms): ms is number => ms !== null && ms > since);
        return times.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...times);
      }
      case "link":
        return null;
    }
  };

  let workerTurns = 0;
  let afterBlocked = 0;
  let startedWhileWaiting = 0;
  let notJudged = 0;
  let tokensReadWhileWaiting = 0;
  const byMarker: Record<string, number> = {};
  let workerTokensRead = 0;
  let blockedEndTokensRead = 0;
  let blockedEndTurns = 0;

  for (const record of scope.scopeRecords) {
    if (record.role !== "worker") continue;
    workerTurns += 1;
    const tokens = read.get(record) ?? null;
    const requestId = record.requestId;

    // (b) The turn ends with a blocked report: the last report the Worker sent in it.
    if (tokens !== null) {
      workerTokensRead += tokens;
      const own = record.reports.filter((report) => report.agentId === record.agentId).sort((a, b) => compareText(a.at, b.at));
      if (own.at(-1)?.phase === "blocked") {
        blockedEndTokensRead += tokens;
        blockedEndTurns += 1;
      }
    }

    // (a) A turn a plugin delivery started while the newest report before it waited on items by id.
    const start = recordStart(record);
    if (requestId === null || start === null) continue;
    const blocked = newestBefore(requestId, start);
    if (blocked === null) continue;
    const refs = waitRefsOfReport(blocked.report, blocked.report.requestId ?? requestId);
    if (refs.length === 0) continue;
    const delivery = deliveryOf(record);
    if (!delivery.plugin) continue;
    afterBlocked += 1;
    const states = refs.map((ref) => {
      const settled = settledAtOf(ref, requestId, blocked.at);
      return settled === null ? "unknown" : settled <= start ? "settled" : "open";
    });
    const any = blocked.report.wakeOn === "any";
    const met = any ? states.includes("settled") : states.every((state) => state === "settled");
    const unmet = any ? states.every((state) => state === "open") : states.includes("open");
    if (!met && !unmet) {
      notJudged += 1;
      continue;
    }
    if (met) continue;
    startedWhileWaiting += 1;
    tokensReadWhileWaiting += tokens ?? 0;
    byMarker[delivery.marker] = (byMarker[delivery.marker] ?? 0) + 1;
  }

  return {
    registryIncluded: input.requests !== undefined,
    decisionsIncluded: input.decisions !== undefined,
    workerTurns,
    afterBlocked,
    startedWhileWaiting,
    notJudged,
    tokensReadWhileWaiting,
    byMarker: Object.fromEntries(Object.entries(byMarker).sort(([a], [b]) => compareText(a, b))),
    workerTokensRead,
    blockedEndTurns,
    blockedEndTokensRead,
    blockedEndShare: ratio(blockedEndTokensRead, workerTokensRead),
  };
}

// ── M-42 ────────────────────────────────────────────────────────────────────

/** One kind's figures over its entries asked in the window. */
function maintenanceFiguresOf(raw: readonly unknown[] | undefined, ceilingMs: number, scope: EvalScope, unknowns: EvalUnknowns): EvalMetrics["m42"]["compactions"] {
  const entries: MaintenanceEntry[] = [];
  for (const entry of raw ?? []) {
    const parsed = maintenanceEntrySchema.safeParse(entry);
    if (parsed.success) entries.push(parsed.data);
    else unknowns.invalidMaintenanceEntries += 1;
  }
  const inWindow = entries.filter((entry) => within(timeOrNull(entry.requestedAt), scope.bounds));
  const dropped = inWindow.filter((entry) => entry.ending === "no-safe-point");
  const afterCeiling = dropped.filter((entry) => {
    const asked = timeOrNull(entry.requestedAt);
    const ended = timeOrNull(entry.endedAt);
    return asked !== null && ended !== null && ended - asked >= ceilingMs;
  });
  return { entries: inWindow.length, dropped: dropped.length, afterCeiling: afterCeiling.length };
}

/** M-42 over the compactions and handoffs asked in the window. */
export function m42Of(scope: EvalScope, input: Pick<EvalInput, "compactions" | "handoffs">, unknowns: EvalUnknowns): EvalMetrics["m42"] {
  return {
    compactionsIncluded: input.compactions !== undefined,
    handoffsIncluded: input.handoffs !== undefined,
    ceilingMs: { compact: MAINTENANCE_WAIT_MS.compact, handoff: MAINTENANCE_WAIT_MS.handoff },
    compactions: maintenanceFiguresOf(input.compactions, MAINTENANCE_WAIT_MS.compact, scope, unknowns),
    handoffs: maintenanceFiguresOf(input.handoffs, MAINTENANCE_WAIT_MS.handoff, scope, unknowns),
  };
}

// ── M-37 and M-38 ───────────────────────────────────────────────────────────

/** A request's mission: its roster's (the first mission by id when two rosters hold it), else the mission whose placement one of its workspaces is; null for none. */
function missionOfRequestIn(input: Pick<EvalInput, "missionRequests" | "placements">): (requestId: string, workspaceIds: readonly string[]) => string | null {
  const byRequest = new Map<string, string>();
  const rosters = input.missionRequests ?? {};
  for (const missionId of Object.keys(rosters).sort(compareText)) for (const requestId of rosters[missionId] ?? []) if (!byRequest.has(requestId)) byRequest.set(requestId, missionId);
  return (requestId, workspaceIds) => {
    const rostered = byRequest.get(requestId);
    if (rostered !== undefined) return rostered;
    for (const workspaceId of [...workspaceIds].sort(compareText)) {
      const placed = input.placements?.[workspaceId]?.missionId;
      if (placed !== undefined) return placed;
    }
    return null;
  };
}

/** M-37 over the requests in the window. */
export function m37Of(scope: EvalScope, input: Pick<EvalInput, "missionRequests" | "placements" | "workspaceDirectories">): EvalMetrics["m37"] {
  const missionOf = missionOfRequestIn(input);
  // Each file a Worker reported, by its workspace: the missions whose requests wrote it.
  const written = new Map<string, { workspaceId: string; missions: Set<string> }>();
  let requests = 0;
  let requestsWithoutMission = 0;
  for (const facts of scope.inScope) {
    const files: Array<{ workspaceId: string; file: string }> = [];
    for (const record of facts.records) {
      if (record.role !== "worker") continue;
      const folder = input.workspaceDirectories?.[record.workspaceId] ?? null;
      for (const report of record.reports) {
        if (report.agentId !== record.agentId) continue;
        for (const path of report.filesChanged) {
          const file = workspaceFileOf(path, folder);
          if (file !== null) files.push({ workspaceId: record.workspaceId, file });
        }
      }
    }
    if (files.length === 0) continue;
    const mission = missionOf(facts.id, facts.records.map((record) => record.workspaceId));
    if (mission === null) {
      requestsWithoutMission += 1;
      continue;
    }
    requests += 1;
    for (const { workspaceId, file } of files) {
      const key = JSON.stringify([workspaceId, file]);
      const entry = written.get(key) ?? { workspaceId, missions: new Set<string>() };
      entry.missions.add(mission);
      written.set(key, entry);
    }
  }

  let files = 0;
  let inPlacements = 0;
  const pairs = new Map<string, { workspaceId: string; placement: boolean; missions: [string, string]; files: number }>();
  for (const { workspaceId, missions } of written.values()) {
    if (missions.size < 2) continue;
    files += 1;
    const placement = input.placements?.[workspaceId] !== undefined;
    if (placement) inPlacements += 1;
    const sorted = [...missions].sort(compareText);
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const key = JSON.stringify([workspaceId, sorted[i], sorted[j]]);
        const pair = pairs.get(key) ?? { workspaceId, placement, missions: [sorted[i]!, sorted[j]!], files: 0 };
        pair.files += 1;
        pairs.set(key, pair);
      }
    }
  }
  return {
    missionsIncluded: input.missionRequests !== undefined,
    placementsIncluded: input.placements !== undefined,
    requests,
    requestsWithoutMission,
    files,
    inPlacements,
    pairs: [...pairs.values()].sort(
      (a, b) => b.files - a.files || compareText(a.workspaceId, b.workspaceId) || compareText(a.missions[0], b.missions[0]) || compareText(a.missions[1], b.missions[1]),
    ),
  };
}

/**
 * What a Main's finished line says (delivery line design §4.6): committed or
 * not, and whether it said verified or CI red; null for a text with none. The
 * pattern is `server/line-state.ts` `finishedLineFactsOf`'s, which a test
 * holds equal.
 */
function finishedLineIn(text: string): { committed: boolean; verified: boolean; ciRed: boolean } | null {
  const match = /^finished, (?:uncommitted: .*|committed on \S+?(?:; (CI red|verified|CI pending))?)\.$/m.exec(text);
  if (match === null) return null;
  if (match[0].startsWith("finished, uncommitted")) return { committed: false, verified: false, ciRed: false };
  return { committed: true, verified: match[1] === "verified", ciRed: match[1] === "CI red" };
}

/** M-38 over the finished requests in the window that belong to a mission. */
export function m38Of(scope: EvalScope, input: Pick<EvalInput, "missionRequests" | "placements" | "workspaceDirectories">): EvalMetrics["m38"] {
  const missionOf = missionOfRequestIn(input);
  // Each report delivery's finished line, by the outbox record the report came from (a `BM-UPDATES` item too).
  const lines = new Map<string, NonNullable<ReturnType<typeof finishedLineIn>>>();
  for (const record of scope.records) {
    for (const message of record.sent) {
      for (const text of updatesItemsOf(message.text) ?? [message.text]) {
        const delivery = parseDelivery(text);
        if (delivery?.kind !== "report" || lines.has(delivery.recordId)) continue;
        const line = finishedLineIn(delivery.body);
        if (line !== null) lines.set(delivery.recordId, line);
      }
    }
  }

  let finished = 0;
  let changedFiles = 0;
  let uncommitted = 0;
  const committedBy = { line: 0, report: 0 };
  let verified = 0;
  const verifiedBy = { ci: 0, check: 0 };
  let ciRed = 0;
  for (const facts of scope.finishedRequests) {
    if (missionOf(facts.id, facts.records.map((record) => record.workspaceId)) === null) continue;
    const workspaceId = facts.records[0]?.workspaceId ?? null;
    const finish = requestFinishOf({ reports: facts.reports, records: facts.records, workspaceDirectory: workspaceId === null ? null : (input.workspaceDirectories?.[workspaceId] ?? null) });
    if (finish === null) continue;
    finished += 1;
    const report = facts.reports.filter((candidate) => candidate.phase === "finished" && candidate.at === finish.reportAt).at(-1);
    const integration = report?.integration;
    const line = report?.recordId === undefined ? null : (lines.get(report.recordId) ?? null);

    // Commit and verification are judged on a finish that changed files, as the admission evidence's share is.
    if (!finish.changedFiles) continue;
    changedFiles += 1;
    const committed = line === null ? integration?.commit !== undefined : line.committed;
    if (line === null) committedBy.report += 1;
    else committedBy.line += 1;
    if (!committed) uncommitted += 1;

    if (line?.ciRed === true || integration?.ci === "failure") {
      ciRed += 1;
      continue;
    }
    if (line?.verified === true || integration?.ci === "success") {
      verified += 1;
      if (integration?.ci === "success" || finish.checks !== "detected") verifiedBy.ci += 1;
      else verifiedBy.check += 1;
    } else if (finish.checks === "detected") {
      verified += 1;
      verifiedBy.check += 1;
    }
  }
  return {
    missionsIncluded: input.missionRequests !== undefined,
    finished,
    changedFiles,
    uncommitted,
    committedBy,
    verified,
    verifiedBy,
    ciRed,
    verifiedShare: ratio(verified, changedFiles),
  };
}
