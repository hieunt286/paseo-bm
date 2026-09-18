/**
 * Wiring for the Dashboard RPCs (WP-208, WP-210; Dashboard Design §5).
 *
 * One place resolves the trace store and one place turns a thrown
 * `DashboardError` into the coded message the client reads with `errorCodeOf`.
 * Handlers stay thin: the behaviour lives in `trace-store.ts`, `beads-store.ts`
 * and `traces.ts`, which are all testable without a daemon.
 *
 * Workspace directory: `beads.stats` needs the repository path, which only the
 * workspace snapshot has, so it is read through `paseo.workspaces.list()` and
 * matched by id. A workspace that is not in the list is reported as an empty
 * bead store rather than an error — it may simply have been archived.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents, roleOfAgent } from "./agent-role";
import { beadStats, lookupBeads } from "./beads-store";
import { resolveInstallHome } from "./install-home";
import { priceUsage } from "./cost";
import { inferWorkflowSteps } from "./workflow-steps";
import { mergeExtras, readLiveExtras } from "./live-timeline";
import { getBeadDetail, listBeadRows, runBeadAction, type BeadActionPaseo } from "./bead-actions";
import { beadWorkOf } from "./bead-work";
import { readAnswerMarks, writeAnswerMark } from "./answer-marks";
import { stopAllInWorkspace, type StopPaseo } from "./stop-propagation";
import {
  detail,
  paginate,
  reconstructTraces,
  summariseSegments,
  type AgentFacts,
  type ReconstructedTrace,
} from "./traces";
import {
  classifyWorkspaces,
  readRecords,
  deleteTraces,
  measureStore,
  reassignWorkspace,
  readWorkspaceMeta,
  recordKeyOf,
  type DeleteScope,
  type TraceStoreLocation,
  type WorkspaceClassification,
} from "./trace-store";
import type { WorkspaceState } from "../shared/contracts";
import {
  TRACE_LIST_LIMIT,
  DashboardError,
  beadsStatsRpc,
  beadsListRpc,
  beadsGetRpc,
  beadsActionRpc,
  workspacesOverviewRpc,
  answersMarkRpc,
  answersMarksRpc,
  agentsStopAllRpc,
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
  type TraceDetail,
  type TraceSummary,
} from "../shared/contracts";

/** The SDK slice these handlers use. `PaseoApi` is structurally assignable. */
export interface DashboardPaseo {
  agents: {
    /** Absent on hosts (and fakes) without per-agent timeline access. */
    ref?(agentId: string): { timeline: { refetch(options: Record<string, unknown>): Promise<unknown> } };
    list(options: {
      filter: { labels?: Record<string, string>; includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{ entries: Array<Record<string, unknown>>; pageInfo?: { nextCursor: string | null; hasMore: boolean } }>;
  };
  workspaces: {
    list(options?: unknown): Promise<{ entries: Array<Record<string, unknown>> }>;
  };
  config: {
    get(): Promise<{ config: { plugins?: Record<string, unknown> } }>;
  };
}

/**
 * Resolves the trace store for a handler, or throws a coded error.
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
  const resolution = await resolveInstallHome({
    paseo,
    fs: { readFileSync: (path, encoding) => readFileSync(path, encoding) },
    homedir: deps.homedir ?? homedir,
  });
  if (resolution.home === null) {
    throw new DashboardError(
      "E_TRACE_STORE_UNWRITABLE",
      `the paseo-bm trace store is unavailable: ${resolution.reason}`,
    );
  }
  return { tracesDir: resolution.tracesDir };
}

export interface ListedWorkspace {
  id: string;
  archived: boolean;
  directory: string | null;
}

/**
 * Workspaces Paseo currently lists, or null when the list could not be read.
 *
 * `null` is load-bearing: `classifyWorkspaces` must not label anything orphaned
 * because of one failed call (REQ-057a).
 */
export async function listedWorkspaces(paseo: DashboardPaseo): Promise<ListedWorkspace[] | null> {
  let entries: Array<Record<string, unknown>>;
  try {
    ({ entries } = await paseo.workspaces.list());
  } catch {
    return null;
  }
  return entries.map((entry) => {
    const workspace = (entry["workspace"] ?? entry) as Record<string, unknown>;
    const archivingAt = workspace["archivingAt"] ?? workspace["archivedAt"];
    // The workspace's own directory. The project root is only the same place
    // for a plain checkout: a worktree's root is the main checkout, and reading
    // beads there would show another workspace's beads.
    const kind = workspace["kind"] ?? workspace["workspaceKind"];
    const keys = kind === "worktree" ? ["directory", "workspaceDirectory", "cwd"] : ["directory", "workspaceDirectory", "cwd", "projectRootPath"];
    const directory = keys
      .map((key) => workspace[key])
      .find((value): value is string => typeof value === "string" && value !== "");
    return {
      id: String(workspace["id"] ?? ""),
      archived: typeof archivingAt === "string" && archivingAt !== "",
      directory: directory ?? null,
    };
  });
}

function directoryIn(listed: readonly ListedWorkspace[] | null, workspaceId: string): string | null {
  return listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
}

/** Repository path of a workspace, or null when Paseo no longer lists it. */
export async function workspaceDirectory(paseo: DashboardPaseo, workspaceId: string): Promise<string | null> {
  return directoryIn(await listedWorkspaces(paseo), workspaceId);
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
  const outcome = await deleteTraces(location, input.workspaceId, scope, {
    dryRun: input.dryRun === true,
    recordKeys,
  });
  return {
    deleted: { ...outcome, running: inScope.filter((trace) => trace.state === "running").length },
    store: measureStore(location, input.workspaceId),
  };
}

/**
 * Everything the two read handlers need, gathered once: the store, the agent
 * facts, the workspace's state and the reconstructed traces.
 *
 * `agents.list` is filtered by `bm.role` label exactly as `manager.ts` does, and
 * then by workspace, because the daemon's directory filter has no workspace key.
 */
export async function readTraceContext(
  input: { workspaceId: string },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{
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
}> {
  const location = await requireLocation(paseo, deps);
  const read = readRecords(location, input.workspaceId);
  const agents = await agentFactsOf(paseo, input.workspaceId);
  const listed = await listedWorkspaces(paseo);
  const classified = classifyWorkspaces(location, listed).find(
    (entry) => entry.workspaceId === input.workspaceId,
  );
  const traces = reconstructTraces({ records: read.records, agents: [...agents.values()] });
  return {
    location,
    traces,
    agents,
    directory: directoryIn(listed, input.workspaceId),
    evidenceDirectory:
      directoryIn(listed, input.workspaceId) ?? readWorkspaceMeta(location, input.workspaceId)?.lastKnownDirectory ?? null,
    workspaceState: classified?.state ?? (listed === null ? "unknown" : "live"),
    notices: read.notices,
    store: measureStore(location, input.workspaceId),
  };
}

/** Agent facts of one workspace, keyed by id (design §6 step 1). */
export async function agentFactsOf(
  paseo: DashboardPaseo,
  workspaceId: string,
): Promise<Map<string, AgentFacts>> {
  const all = await bmAgentsOf(paseo);
  return new Map(all.filter((entry) => entry.workspaceId === workspaceId).map((entry) => [entry.facts.id, entry.facts]));
}

/**
 * Every paseo-bm agent on this host, with its workspace. One walk over every
 * page of `agents.list`, no label filter: the role comes from `roleOfAgent`, so
 * an agent started from Paseo's own new-agent flow with a paseo-bm profile
 * (no `bm.role` label) is found too, marked `labelled: false` (delta 20260918g
 * §4.2). The daemon's directory filter has no workspace key.
 */
export async function bmAgentsOf(paseo: DashboardPaseo): Promise<Array<{ workspaceId: string | null; facts: AgentFacts }>> {
  let listed: Array<Record<string, unknown>>;
  try {
    listed = await listAllAgents(
      async (options) => {
        const result = await paseo.agents.list(options);
        // Entries are `{ agent }` on the SDK; older fakes hand the agent itself.
        return {
          entries: result.entries.map((entry) => ({ agent: (entry["agent"] ?? entry) as Record<string, unknown> })),
          ...(result.pageInfo === undefined ? {} : { pageInfo: result.pageInfo }),
        };
      },
      { includeArchived: true },
    );
  } catch {
    return [];
  }
  const out: Array<{ workspaceId: string | null; facts: AgentFacts }> = [];
  for (const agent of listed) {
    const fact = roleOfAgent(agent);
    const id = String(agent["id"] ?? "");
    if (fact === null || id === "") continue;
    const labels = (agent["labels"] ?? {}) as Record<string, string>;
    const facts: AgentFacts = {
      id,
      role: fact.role,
      labelled: fact.labelled,
      status: String(agent["status"] ?? "closed"),
      parentAgentId: labels["paseo.parent-agent-id"] ?? (agent["parentAgentId"] as string | null) ?? null,
      createdAt: typeof agent["createdAt"] === "string" ? (agent["createdAt"] as string) : null,
      requestIdLabel: labels["bm.requestId"] ?? null,
      batchIdLabel: labels["bm.batchId"] ?? null,
      archived: typeof agent["archivedAt"] === "string" && agent["archivedAt"] !== "",
      title: typeof agent["title"] === "string" ? (agent["title"] as string) : null,
    };
    out.push({ workspaceId: typeof agent["workspaceId"] === "string" ? agent["workspaceId"] : null, facts });
  }
  return out;
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
  return {
    traces: page.flatMap((trace) =>
      summariseSegments(trace, {
        agents: context.agents,
        workspaceState: context.workspaceState,
        reassignedFrom: reassignedFromOf(trace, input.workspaceId),
        priceUsage,
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
  deps: { homedir?: () => string } = {},
): Promise<{ trace: TraceDetail }> {
  const context = await readTraceContext(input, paseo, deps);
  const trace = context.traces.find((candidate) => candidate.traceId === input.traceId);
  if (trace === undefined) {
    throw new DashboardError(
      "E_TRACE_NOT_FOUND",
      `no trace ${input.traceId} in workspace ${input.workspaceId}; the agents it belonged to may have been deleted`,
    );
  }
  const { directory } = context;
  const built = detail(trace, {
    agents: context.agents,
    workspaceState: context.workspaceState,
    reassignedFrom: reassignedFromOf(trace, input.workspaceId),
    priceUsage,
    lookupBeads: (ids) => (directory === null ? { found: [], missing: [...ids] } : lookupBeads(directory, ids)),
    workflowSteps: (reconstructed, beadStatus) =>
      inferWorkflowSteps(reconstructed, { beadStatus, workspaceDir: context.evidenceDirectory }),
  });
  // What the agents did before the collector saw them is still in their
  // timelines: add their skills and the user's messages from there.
  const present = [...trace.workerIds, ...trace.reviewerIds].filter((id) => context.agents.has(id));
  const extras = mergeExtras(built, await readLiveExtras(paseo, present));
  return { trace: { ...built, skills: extras.skills, userMessages: extras.userMessages } };
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

/** `answers.marks` handler: the cards marked as answered (delta 20260918d §4.9). */
export async function handleAnswerMarksGet(
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ keys: string[]; notices: string[] }> {
  const { keys, notices } = readAnswerMarks(await requireLocation(paseo, deps));
  return { keys, notices };
}

/** `answers.mark` handler: marks one card as answered, or removes the mark. */
export async function handleAnswerMarkSet(
  input: { key: string; marked: boolean },
  paseo: DashboardPaseo,
  deps: { homedir?: () => string } = {},
): Promise<{ keys: string[]; notices: string[] }> {
  const { keys, notices } = writeAnswerMark(await requireLocation(paseo, deps), input.key, input.marked);
  return { keys, notices };
}

/**
 * `workspaces.overview` handler: bead counts and running agents per listed
 * workspace. Read-only.
 *
 * `runningWorkers` is kept exactly as it was — other readers depend on it — and
 * `runningAgents` is added beside it. Owner decision Q25 (delta 20260917e):
 * the Manager thinking and a Reviewer running both count as "this project is
 * busy". Counting Workers alone left the screen still during the parts of a
 * request where the user most wants to see something happening.
 */
export async function handleWorkspacesOverview(paseo: DashboardPaseo): Promise<{ workspaces: WorkspaceOverview[] }> {
  const listed = (await listedWorkspaces(paseo)) ?? [];
  const agents = await bmAgentsOf(paseo);
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
  server.handle(tracesDeleteRpc, (input, context) => handleTracesDelete(input, sdk(context)));
  server.handle(tracesReassignRpc, (input, context) => handleTracesReassign(input, sdk(context)));
  server.handle(tracesWorkspacesRpc, (_input, context) => handleTracesWorkspaces(sdk(context)));
  server.handle(beadsStatsRpc, (input, context) => handleBeadsStats(input, sdk(context)));
  server.handle(beadsListRpc, (input, context) => handleBeadsList(input, sdk(context)));
  server.handle(beadsGetRpc, (input, context) => handleBeadsGet(input, sdk(context)));
  server.handle(workspacesOverviewRpc, (_input, context) => handleWorkspacesOverview(sdk(context)));
  server.handle(answersMarksRpc, (_input, context) => handleAnswerMarksGet(sdk(context)));
  server.handle(answersMarkRpc, (input, context) => handleAnswerMarkSet(input, sdk(context)));
  server.handle(agentsStopAllRpc, (input, context) => handleAgentsStopAll(input, context.paseo as StopPaseo));
  const ensureManager = deps.ensureManager;
  if (ensureManager !== undefined) {
    server.handle(beadsActionRpc, (input, context) =>
      handleBeadsAction(input, sdk(context), (workspaceId) => ensureManager(workspaceId, context.paseo)),
    );
  }
}
