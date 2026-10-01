/**
 * Wiring for the Dashboard RPCs (WP-208, WP-210; Dashboard Design §5).
 *
 * One place resolves the trace store and one place turns a thrown
 * `DashboardError` into the coded message the client reads with `errorCodeOf`.
 * Handlers stay thin: the behaviour lives in `trace-store.ts`,
 * `trace-store-rewrite.ts`, `beads-store.ts`, the rebuild of `traces.ts` and
 * the rows of `trace-views.ts`, which are all testable without a daemon. What
 * Paseo lists — workspaces, their directories, the paseo-bm agents — is read
 * through `paseo-directory.ts`, and the fallback incidents' counts through
 * `fallback-state.ts` (code review 2026-09-30 §4).
 *
 * `beads.stats` needs the workspace's repository path (`workspaceDirectory`);
 * a workspace that Paseo no longer lists is reported as an empty bead store
 * rather than an error — it may simply have been archived.
 */
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { beadStats, lookupBeads } from "./beads-store";
import { TRACES_DIR_NAME, type DataHomeDeps } from "./data-home";
import { priceUsage } from "./cost";
import { listedPricesFor } from "./model-costs";
import { inferWorkflowSteps } from "./workflow-steps";
import { mergeExtras, readLiveExtras } from "./live-timeline";
import { pluginSentBeside } from "./collector";
import { getBeadDetail, listBeadRows, runBeadAction, type BeadActionPaseo } from "./bead-actions";
import { beadWorkOf } from "./bead-work";
import { stopAllInWorkspace, type StopPaseo } from "./stop-propagation";
import { fallbackCountsOf, incidentsIn, reviewerReplacementIds } from "./fallback-state";
import { agentFactsOf, bmAgentsOf, directoryIn, listedWorkspaces, workspaceDirectory, type DashboardPaseo } from "./paseo-directory";
import { workspaceTracesOf } from "./request-trace";
import { requireDataHome } from "./rpc-kit";
import { createOrchestratorStore } from "./orchestrator-store";
import { createDecisionStore } from "./decision-store";
import type { AgentFacts, ReconstructedTrace } from "./traces";
import { agentTokenFiguresOf } from "./trace-usage";
import { detail, paginate, summariseSegments } from "./trace-views";
import {
  assertWritableSchema,
  classifyWorkspaces,
  measureStore,
  readRecords,
  readWorkspaceMeta,
  recordKeyOf,
  type TraceStoreLocation,
  type WorkspaceClassification,
} from "./trace-store";
import { deleteTraces, reassignWorkspace, type DeleteScope } from "./trace-store-rewrite";
import type { WorkspaceState } from "../shared/contracts";
import {
  TRACE_LIST_LIMIT,
  DashboardError,
  beadsStatsRpc,
  beadsListRpc,
  beadsGetRpc,
  beadsActionRpc,
  workspacesOverviewRpc,
  agentsStopAllRpc,
  tracesAgentsRpc,
  tracesGetRpc,
  tracesListRpc,
  tracesWorkspacesRpc,
  tracesDeleteRpc,
  tracesReassignRpc,
  type BeadAction,
  type BeadDetail,
  type BeadRow,
  type BeadStats,
  type WorkspaceOverview,
  type StoreSize,
  type AgentTokenFigures,
  type TraceDetail,
  type TraceSummary,
} from "../shared/contracts";

/**
 * Resolves the trace store for a handler, or throws `E_DATA_HOME_UNAVAILABLE`
 * (rpc-kit `requireDataHome`, code review 2026-09-30 §3.2).
 *
 * `homedir` is injectable so a test never depends on the machine it runs on:
 * the default fallback path is inside the real user's home, and a real
 * paseo-bm installation there would otherwise make a "cannot resolve" test
 * silently succeed.
 */
export async function requireLocation(
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<TraceStoreLocation> {
  return (await requireInstallHome(paseo, deps)).location;
}

/** `requireLocation`, with the data folder it was found in. */
async function requireInstallHome(
  paseo: DashboardPaseo,
  deps: DataHomeDeps,
): Promise<{ home: string; location: TraceStoreLocation }> {
  const home = requireDataHome(deps, "open the trace store");
  return { home, location: { tracesDir: join(home, TRACES_DIR_NAME) } };
}

/** The empty answer for a workspace whose directory cannot be found. */
export function emptyBeadStats(source: string): BeadStats {
  return {
    total: 0,
    open: 0,
    inProgress: 0,
    blocked: 0,
    closed: 0,
    ready: 0,
    readAt: new Date().toISOString(),
    source,
    skippedLines: 0,
    present: false,
  };
}

/** `beads.stats` handler (REQ-046). Read-only. */
export async function handleBeadsStats(
  input: { workspaceId: string },
  paseo: DashboardPaseo,
): Promise<{ stats: BeadStats }> {
  const directory = await workspaceDirectory(paseo, input.workspaceId);
  if (directory === null) {
    return { stats: emptyBeadStats(`workspace ${input.workspaceId} is not listed by Paseo`) };
  }
  return { stats: beadStats(directory) };
}

/** `traces.delete` handler (REQ-054). The only destructive handler in the plugin. */
export async function handleTracesDelete(
  input: { workspaceId: string; scope: DeleteScope; dryRun?: boolean },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ deleted: { traces: number; bytes: number; running: number }; store: StoreSize }> {
  const { location, traces } = await readTraceContext({ workspaceId: input.workspaceId }, paseo, deps);
  const scope = input.scope;
  const inScope = traces.filter((trace) =>
    "traceId" in scope
      ? trace.traceId === scope.traceId
      : "before" in scope
        ? trace.records.some((record) => record.at < scope.before)
        : true,
  );
  let recordKeys: Set<string> | undefined;
  if ("traceId" in scope) {
    // Delete exactly what the row shows. The row's id is not a store key, and a
    // trace spans several agents and unnamed Manager turns (WP-214 acceptance:
    // the button matched nothing and deleted nothing).
    const [trace] = inScope;
    if (trace === undefined) {
      throw new DashboardError("E_TRACE_NOT_FOUND", `no trace ${scope.traceId} in workspace ${input.workspaceId}`);
    }
    recordKeys = new Set(trace.records.map((record) => recordKeyOf(record)));
  }
  if (input.dryRun !== true && inScope.length > 0) {
    // An earlier build's workflow assessments of the project may quote the
    // deleted traces, so its retired file goes with them (orchestrator design
    // §5.3, REQ-075 e; autonomy design §B.9). Before the traces, not after: a
    // failure here then leaves everything in place for a retry, where the
    // other order would leave excerpts of traces that are already gone. The
    // store's own refusal comes first for the same reason.
    assertWritableSchema(location);
    const { home } = await requireInstallHome(paseo, deps);
    const requestIds = inScope.flatMap((trace) => (trace.requestId === null ? [] : [trace.requestId]));
    createOrchestratorStore(home).deleteRetiredAssessments(input.workspaceId);
    // Autonomy design §A.4: a deleted request's settled decisions go with it;
    // an open one stays, because the owner still has to answer it.
    createDecisionStore(home).deleteSettled(input.workspaceId, requestIds);
  }
  const outcome = await deleteTraces(location, input.workspaceId, scope, {
    dryRun: input.dryRun === true,
    recordKeys,
  });
  return {
    deleted: { ...outcome, running: inScope.filter((trace) => trace.state === "running").length },
    store: measureStore(location, input.workspaceId),
  };
}

/** One workspace's traces and everything the read handlers show beside them (`readTraceContext`). */
export interface TraceContext {
  location: TraceStoreLocation;
  traces: ReconstructedTrace[];
  agents: Map<string, AgentFacts>;
  /** Repository path from the same workspace list, or null. */
  directory: string | null;
  /**
   * Directory for reading file evidence in the workflow table: the listed one,
   * else the trace store's `lastKnownDirectory` (delta 20260917 §5.5), so a
   * closed workspace keeps its file-based steps. Never used to read beads.
   */
  evidenceDirectory: string | null;
  workspaceState: WorkspaceState;
  notices: string[];
  store: StoreSize;
  /** Provider-plan incidents per request that did not fail a turn (delta 20260925 §3.4). */
  fallbackCounts: Map<string, number>;
}

/**
 * Everything the read handlers need, gathered once: the store, the agent
 * facts, the workspace's state and the reconstructed traces. Not a handler:
 * the Orchestrator's `bm_request` reads its request through it too.
 *
 * The traces are `request-trace.ts`'s rebuild (`workspaceTracesOf`), the one
 * the Orchestrator's readers and the BM-BUDGET check read: `agents.list` walked
 * once, no label filter, then kept to the workspace, because the daemon's
 * directory filter has no workspace key.
 */
export async function readTraceContext(
  input: { workspaceId: string },
  paseo: DashboardPaseo,
  deps: DataHomeDeps = {},
): Promise<TraceContext> {
  const { home, location } = await requireInstallHome(paseo, deps);
  // One read of the incidents file for both things that need it: the review
  // count and the error count (delta 20260925 §3.4).
  const incidents = incidentsIn(home);
  // The same review count as the BM-BUDGET check: a replacement Reviewer's
  // first message is not a new call (delta 20260921 §4.5.1).
  const { traces, agents, notices } = await workspaceTracesOf(
    { location, paseo, home, replacementIds: reviewerReplacementIds(incidents) },
    input.workspaceId,
  );
  const listed = await listedWorkspaces(paseo);
  const classified = classifyWorkspaces(location, listed).find(
    (entry) => entry.workspaceId === input.workspaceId,
  );
  return {
    location,
    traces,
    agents,
    directory: directoryIn(listed, input.workspaceId),
    evidenceDirectory:
      directoryIn(listed, input.workspaceId) ?? readWorkspaceMeta(location, input.workspaceId)?.lastKnownDirectory ?? null,
    workspaceState: classified?.state ?? (listed === null ? "unknown" : "live"),
    notices,
    store: measureStore(location, input.workspaceId),
    fallbackCounts: fallbackCountsOf(incidents, input.workspaceId),
  };
}

/** `traces.list` handler (REQ-041). Read-only. */
export async function handleTracesList(
  input: { workspaceId: string; limit?: number; cursor?: string },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{
  traces: TraceSummary[];
  nextCursor: string | null;
  truncated: boolean;
  store: StoreSize;
  notices: string[];
}> {
  const context = await readTraceContext(input, paseo, deps);
  const limit = Math.min(input.limit ?? TRACE_LIST_LIMIT, TRACE_LIST_LIMIT);
  const { page, nextCursor, truncated } = paginate(context.traces, limit, input.cursor);
  // Rates Paseo lists for models the bundled table lacks (delta 20260921
  // §4.2.7), read before pricing so pricing itself stays synchronous.
  const listed = await listedPricesFor(
    paseo,
    page.flatMap((trace) => trace.records),
    undefined,
    context.directory ?? undefined,
  );
  return {
    traces: page.flatMap((trace) =>
      summariseSegments(trace, {
        agents: context.agents,
        workspaceState: context.workspaceState,
        reassignedFrom: reassignedFromOf(trace, input.workspaceId),
        priceUsage: (usage) => priceUsage(usage, listed),
        fallbacksOf: (requestId) => (requestId === null ? 0 : (context.fallbackCounts.get(requestId) ?? 0)),
        workspaceDirectory: context.evidenceDirectory,
      }),
    ),
    nextCursor,
    truncated,
    store: context.store,
    notices: context.notices,
  };
}

/** `traces.get` handler (REQ-043). Unknown id fails `E_TRACE_NOT_FOUND`. */
export async function handleTracesGet(
  input: { workspaceId: string; traceId: string },
  paseo: DashboardPaseo,
  deps: DataHomeDeps = {},
): Promise<{ trace: TraceDetail }> {
  const context = await readTraceContext(input, paseo, deps);
  const trace = context.traces.find((candidate) => candidate.traceId === input.traceId);
  if (trace === undefined) {
    throw new DashboardError(
      "E_TRACE_NOT_FOUND",
      `no trace ${input.traceId} in workspace ${input.workspaceId}; the agents it belonged to may have been deleted`,
    );
  }
  return { trace: await traceDetailOf({ workspaceId: input.workspaceId, trace }, context, paseo) };
}

/**
 * The full detail of one trace of `context` (design §4.3): priced, its beads
 * looked up, its workflow steps inferred, and what its agents' timelines still
 * hold. Not a handler: `traces.get` and the Orchestrator's `bm_request` both
 * build their request with it (code review 2026-09-30 §4).
 */
export async function traceDetailOf(
  input: { workspaceId: string; trace: ReconstructedTrace },
  context: TraceContext,
  paseo: DashboardPaseo,
): Promise<TraceDetail> {
  const { trace } = input;
  const { directory } = context;
  const listed = await listedPricesFor(paseo, trace.records, undefined, directory ?? undefined);
  const built = detail(trace, {
    agents: context.agents,
    workspaceState: context.workspaceState,
    reassignedFrom: reassignedFromOf(trace, input.workspaceId),
    priceUsage: (usage) => priceUsage(usage, listed),
    fallbacksOf: (requestId) => (requestId === null ? 0 : (context.fallbackCounts.get(requestId) ?? 0)),
    workspaceDirectory: context.evidenceDirectory,
    lookupBeads: (ids) => (directory === null ? { found: [], missing: [...ids] } : lookupBeads(directory, ids)),
    workflowSteps: (reconstructed, beadStatus) =>
      inferWorkflowSteps(reconstructed, { beadStatus, workspaceDir: context.evidenceDirectory }),
  });
  // What the agents did before the collector saw them is still in their
  // timelines: add their skills and the user's messages from there — never
  // what the plugin sent for a compaction, which its send log tells apart as
  // it does for the collector (autonomy design §G.5).
  const present = [...trace.workerIds, ...trace.reviewerIds].filter((id) => context.agents.has(id));
  const extras = mergeExtras(built, await readLiveExtras(paseo, present, process.env, pluginSentBeside(context.location)));
  return { ...built, skills: extras.skills, userMessages: extras.userMessages };
}

/**
 * `traces.agents` handler (autonomy design §G.2 Shown). Read-only. With
 * `traceId`: every agent of that request over its turns there; unknown id
 * fails `E_TRACE_NOT_FOUND`. Without: each agent Paseo lists in the workspace
 * and has not archived — the agents Work's Agents tab shows — over its life.
 */
export async function handleTracesAgents(
  input: { workspaceId: string; traceId?: string },
  paseo: DashboardPaseo,
  deps: DataHomeDeps = {},
): Promise<{ agents: AgentTokenFigures[] }> {
  const context = await readTraceContext(input, paseo, deps);
  const records = [...new Set(context.traces.flatMap((trace) => trace.records))];
  const roleOf = (agentId: string) => context.agents.get(agentId)?.role;
  if (input.traceId === undefined) {
    const keep = (agentId: string) => context.agents.get(agentId)?.archived === false;
    return { agents: agentTokenFiguresOf(records, { keep, roleOf }) };
  }
  const trace = context.traces.find((candidate) => candidate.traceId === input.traceId);
  if (trace === undefined) {
    throw new DashboardError(
      "E_TRACE_NOT_FOUND",
      `no trace ${input.traceId} in workspace ${input.workspaceId}; the agents it belonged to may have been deleted`,
    );
  }
  return { agents: agentTokenFiguresOf(records, { scope: new Set(trace.records), roleOf }) };
}

/**
 * The workspace a trace's records were written under, when that differs from
 * the directory it now lives in (REQ-057, `reassignedFrom`).
 */
export function reassignedFromOf(trace: ReconstructedTrace, workspaceId: string): string | null {
  const original = trace.records.find((record) => record.workspaceId !== workspaceId);
  return original?.workspaceId ?? null;
}

/**
 * `traces.reassign` handler (REQ-057d). Only ever reached by a user action:
 * the destination must be a workspace Paseo lists right now.
 */
export async function handleTracesReassign(
  input: { fromWorkspaceId: string; toWorkspaceId: string; dryRun?: boolean },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ moved: { traces: number; bytes: number }; store: StoreSize }> {
  const location = await requireLocation(paseo, deps);
  const listed = await listedWorkspaces(paseo);
  const outcome = await reassignWorkspace(location, input.fromWorkspaceId, input.toWorkspaceId, {
    dryRun: input.dryRun === true,
    destinationExists: listed === null ? undefined : listed.some((entry) => entry.id === input.toWorkspaceId),
  });
  return {
    moved: { traces: outcome.traces, bytes: outcome.bytes },
    store: measureStore(location, input.toWorkspaceId),
  };
}

/** `traces.workspaces`: stored workspaces with their current state, for the launcher. */
export async function handleTracesWorkspaces(
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{
  workspaces: Array<WorkspaceClassification & { lastSeenAt: string | null; bytes: number }>;
}> {
  const location = await requireLocation(paseo, deps);
  const classified = classifyWorkspaces(location, await listedWorkspaces(paseo));
  return {
    workspaces: classified.map((entry) => ({
      ...entry,
      lastSeenAt: readWorkspaceMeta(location, entry.workspaceId)?.lastSeenAt ?? null,
      bytes: measureStore(location, entry.workspaceId).workspaceBytes,
    })),
  };
}

/**
 * `agents.stop-all` handler: asks this workspace's Workers and Reviewers to
 * stop. The Manager is never asked — it is the user's point of contact.
 */
export async function handleAgentsStopAll(
  input: { workspaceId: string },
  paseo: StopPaseo,
): Promise<{ workers: number; reviewers: number; skipped: number }> {
  return stopAllInWorkspace(paseo, input.workspaceId);
}

/**
 * `workspaces.overview` handler: bead counts and running agents per listed
 * workspace. Read-only.
 *
 * `runningWorkers` is kept exactly as it was — other readers depend on it — and
 * `runningAgents` is added beside it. Owner decision Q25 (delta 20260917e):
 * the Manager thinking and a Reviewer running both count as "this project is
 * busy". Counting Workers alone left the screen still during the parts of a
 * request where the user most wants to see something happening. A running
 * Orchestrator assessment counts too, under its own key (orchestrator design
 * §3.2).
 */
export async function handleWorkspacesOverview(paseo: DashboardPaseo): Promise<{ workspaces: WorkspaceOverview[] }> {
  const listed = (await listedWorkspaces(paseo)) ?? [];
  const agents = await bmAgentsOf(paseo, { includeOrchestrator: true });
  return {
    workspaces: listed
      .filter((entry) => !entry.archived && entry.id !== "")
      .map((entry) => {
        let beads: WorkspaceOverview["beads"] = null;
        if (entry.directory !== null) {
          try {
            const stats = beadStats(entry.directory);
            if (stats.present) {
              beads = { total: stats.total, inProgress: stats.inProgress, blocked: stats.blocked, ready: stats.ready };
            }
          } catch {
            // An unreadable bead store shows as "no beads", never as an error row.
          }
        }
        const running = agents.filter(
          (agent) => agent.workspaceId === entry.id && agent.facts.status === "running",
        );
        const runningOf = (role: AgentFacts["role"]): number =>
          running.filter((agent) => agent.facts.role === role).length;
        const runningAgents = {
          manager: runningOf("manager"),
          worker: runningOf("worker"),
          reviewer: runningOf("reviewer"),
          orchestrator: runningOf("orchestrator"),
        };
        return { workspaceId: entry.id, beads, runningWorkers: runningAgents.worker, runningAgents };
      }),
  };
}

/** `beads.list` handler. Read-only. */
export async function handleBeadsList(
  input: { workspaceId: string },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ beads: BeadRow[]; stats: BeadStats }> {
  const directory = await workspaceDirectory(paseo, input.workspaceId);
  if (directory === null) {
    return { beads: [], stats: emptyBeadStats(`workspace ${input.workspaceId} is not listed by Paseo`) };
  }
  const rows = listBeadRows(directory);
  const working = rows.filter((row) => row.status === "in_progress").map((row) => row.id);
  if (working.length > 0) {
    // Who is on it comes from the trace store. Without a store (tracing off,
    // nothing recorded yet) the list is still complete, just without names.
    try {
      const location = await requireLocation(paseo, deps);
      const work = beadWorkOf(
        working,
        readRecords(location, input.workspaceId).records,
        await agentFactsOf(paseo, input.workspaceId),
      );
      for (const row of rows) row.work = work.get(row.id) ?? null;
    } catch {
      // Names are an extra; the bead list does not depend on them.
    }
  }
  return { beads: rows, stats: beadStats(directory) };
}

async function requireDirectory(paseo: DashboardPaseo, workspaceId: string): Promise<string> {
  const directory = await workspaceDirectory(paseo, workspaceId);
  if (directory === null) {
    throw new DashboardError("E_BEADS_STORE_UNREADABLE", `workspace ${workspaceId} is not listed by Paseo`);
  }
  return directory;
}

export async function handleBeadsGet(
  input: { workspaceId: string; id: string },
  paseo: DashboardPaseo,
): Promise<{ bead: BeadDetail }> {
  return { bead: getBeadDetail(await requireDirectory(paseo, input.workspaceId), input.id) };
}

export async function handleBeadsAction(
  input: { workspaceId: string; id: string; action: BeadAction },
  paseo: DashboardPaseo & BeadActionPaseo,
  ensure: (workspaceId: string) => Promise<{ agentId: string; created: boolean }>,
): Promise<{ managerId: string; created: boolean }> {
  // Resolve the bead first: an unknown id must fail before anything is sent.
  const bead = getBeadDetail(await requireDirectory(paseo, input.workspaceId), input.id);
  return runBeadAction({ workspaceId: input.workspaceId, action: input.action, bead }, { paseo, ensure });
}

/** Registers every Dashboard RPC on the server context. */
export function registerDashboardRpcs(
  server: PluginServerContext,
  deps: { ensureManager?: (workspaceId: string, paseo: unknown) => Promise<{ agentId: string; created: boolean }> } = {},
): void {
  // The SDK's `paseo` is structurally a `DashboardPaseo`; one cast, here.
  const sdk = (context: { paseo: unknown }) => context.paseo as DashboardPaseo & BeadActionPaseo;
  server.handle(tracesListRpc, (input, context) => handleTracesList(input, sdk(context)));
  server.handle(tracesGetRpc, (input, context) => handleTracesGet(input, sdk(context)));
  server.handle(tracesAgentsRpc, (input, context) => handleTracesAgents(input, sdk(context)));
  server.handle(tracesDeleteRpc, (input, context) => handleTracesDelete(input, sdk(context)));
  server.handle(tracesReassignRpc, (input, context) => handleTracesReassign(input, sdk(context)));
  server.handle(tracesWorkspacesRpc, (_input, context) => handleTracesWorkspaces(sdk(context)));
  server.handle(beadsStatsRpc, (input, context) => handleBeadsStats(input, sdk(context)));
  server.handle(beadsListRpc, (input, context) => handleBeadsList(input, sdk(context)));
  server.handle(beadsGetRpc, (input, context) => handleBeadsGet(input, sdk(context)));
  server.handle(workspacesOverviewRpc, (_input, context) => handleWorkspacesOverview(sdk(context)));
  server.handle(agentsStopAllRpc, (input, context) => handleAgentsStopAll(input, context.paseo as StopPaseo));
  const ensureManager = deps.ensureManager;
  if (ensureManager !== undefined) {
    server.handle(beadsActionRpc, (input, context) =>
      handleBeadsAction(input, sdk(context), (workspaceId) => ensureManager(workspaceId, context.paseo)),
    );
  }
}
