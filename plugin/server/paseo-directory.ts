/**
 * What Paseo lists of paseo-bm (code review 2026-09-30 §4): its workspaces
 * with their directories, and its agents with the facts a trace is rebuilt
 * from. Read-only — `workspaces.list` and `agents.list`, nothing else — and
 * shared by the Dashboard RPCs, the Orchestrator's readers, the watchers and
 * the hooks.
 *
 * Workspace directory: a repository path only the workspace snapshot has, so
 * it is read through `paseo.workspaces.list()` and matched by id. A workspace
 * that is not in the list has no directory (null) — it may simply have been
 * archived — and each caller says what that means for it.
 */
import { listAllAgents, roleOfAgent } from "./agent-role";
import type { AgentFacts } from "./traces";

/** The SDK slice the Dashboard and these readers use. `PaseoApi` is structurally assignable. */
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

/** The directory of `workspaceId` in a list `listedWorkspaces` read, or null. */
export function directoryIn(listed: readonly ListedWorkspace[] | null, workspaceId: string): string | null {
  return listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
}

/** Repository path of a workspace, or null when Paseo no longer lists it. */
export async function workspaceDirectory(paseo: DashboardPaseo, workspaceId: string): Promise<string | null> {
  return directoryIn(await listedWorkspaces(paseo), workspaceId);
}

/** Agent facts of one workspace, keyed by id (design §6.1 step 1). */
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
 *
 * The Orchestrator's assessment agent is left out unless `includeOrchestrator`
 * asks for it: it is a paseo-bm agent the user sees and archives, but no part
 * of a request, so nothing that rebuilds a trace or picks a chat peer may meet
 * it (orchestrator design §3.2).
 */
export async function bmAgentsOf(
  paseo: DashboardPaseo,
  options: { includeOrchestrator?: boolean } = {},
): Promise<Array<{ workspaceId: string | null; facts: AgentFacts }>> {
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
    if (fact.role === "orchestrator" && options.includeOrchestrator !== true) continue;
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
      replacedBy: labels["bm.replacedBy"] ?? null,
      // Autonomy design §G.6: the Worker it took the request over from, only when labelled.
      ...(typeof labels["bm.handoffFrom"] === "string" && labels["bm.handoffFrom"] !== "" ? { handoffFrom: labels["bm.handoffFrom"] } : {}),
    };
    out.push({ workspaceId: typeof agent["workspaceId"] === "string" ? agent["workspaceId"] : null, facts });
  }
  return out;
}
