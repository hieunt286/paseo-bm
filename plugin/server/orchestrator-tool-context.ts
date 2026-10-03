/**
 * What every Orchestrator tool runs with (Orchestrator design §5; code review
 * 2026-09-30 §4): the context of one call, the refusal a check throws, and
 * the paseo-bm agents and projects a tool may name. The tools live in
 * `orchestrator-read-tools.ts`, `command-authority.ts`,
 * `orchestrator-decide-tools.ts` and `repo-tool.ts`; `orchestrator-tools.ts`
 * lists and dispatches them. This module imports none of them.
 *
 * One call walks `agents.list` at most once (`ToolContext.listed`, on first
 * use): the target checks, the owner's word in the chat and the
 * Orchestrator's own id all read that one walk.
 */
import { listAllAgents, parentOf, roleOfProvider } from "./agent-role";
import type { DashboardPaseo } from "./paseo-directory";
import type { BmEvent } from "./event-bus";
import type { LiveTimelinePaseo } from "./live-timeline";
import { findOrchestratorAgent, type OrchestratorAgentPaseo, type OrchestratorAgentSnapshot } from "./orchestrator-agent";
import type { OrchestratorStore, OrchestratorStoreDeps } from "./orchestrator-store";
import { storedWorkspaceIds, type TraceStoreLocation } from "./trace-store";
import { knownRequestIdOf } from "./request-registry";
import { dataHome } from "./rpc-kit";

/** The SDK slice the tools use. `PaseoApi` is structurally assignable. */
export type OrchestratorToolsPaseo = DashboardPaseo & LiveTimelinePaseo;

/** A tool's answer: text for the agent, or the reason it was refused. */
export type ServerToolResult = { ok: true; text: string } | { ok: false; text: string };

/** What more than one tool module reads of the plugin's deps. */
export interface ToolDeps {
  /** The store's own deps (fixed proposal ids in tests). A command `bm_send_command` records takes its id from `store.newId` too. */
  store?: OrchestratorStoreDeps;
  /**
   * The events of the Orchestrator's running wake (the event bus's
   * `wakeEventsOf`), which a delivered command is logged against as an
   * intervention (autonomy design §G.3). None by default: only what the owner
   * asked for in the chat is logged.
   */
  wakeEventsOf?: (orchestratorId: string) => readonly BmEvent[];
  log?: (message: string) => void;
}

/** One call of a tool: the handle, the data folder and its stores, the time, and the environment whose secrets are masked. */
export interface ToolContext {
  paseo: OrchestratorToolsPaseo;
  home: string;
  location: TraceStoreLocation;
  store: OrchestratorStore;
  now: Date;
  env: NodeJS.ProcessEnv;
  /** Every agent `agents.list` shows, archived ones included: walked once per call, on first use (`agentListOf`). */
  listed: () => Promise<ReadonlyArray<Record<string, unknown>>>;
}

/** Why a tool refused; the registry answers `Refused: <message>.` */
export class Refusal extends Error {}

export function refuse(message: string): never {
  throw new Refusal(message);
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Timeline pages a tool reads back at most; a provider streams a reply in many chunks. */
export const MESSAGE_PAGES = 5;
export const MESSAGE_PAGE_LIMIT = 200;

/** Every agent on the host, archived ones included: one walk over every page of `agents.list`. */
async function listAgents(paseo: Pick<OrchestratorToolsPaseo, "agents">): Promise<Array<Record<string, unknown>>> {
  return listAllAgents(
    async (options) => {
      const result = await paseo.agents.list(options);
      return {
        entries: result.entries.map((entry) => ({ agent: (entry["agent"] ?? entry) as Record<string, unknown> })),
        ...(result.pageInfo === undefined ? {} : { pageInfo: result.pageInfo }),
      };
    },
    { includeArchived: true },
  );
}

/**
 * The walk of one call (`ToolContext.listed`): `agents.list` is read on first
 * use, and every later check of the same call reads the same list (code
 * review 2026-09-30 §4).
 */
export function agentListOf(paseo: Pick<OrchestratorToolsPaseo, "agents">): () => Promise<ReadonlyArray<Record<string, unknown>>> {
  let walk: Promise<ReadonlyArray<Record<string, unknown>>> | null = null;
  return () => (walk ??= listAgents(paseo));
}

/**
 * An agent's `bm.requestId` as far as the plugin trusts it (design §16.4,
 * `knownRequestIdOf`): the Orchestrator's tools scope a Worker to a request
 * through it.
 */
function requestLabelOf(agent: Record<string, unknown>, id: string, workspaceId: string | null, home: string | null): string | null {
  const labels = (agent["labels"] ?? {}) as Record<string, unknown>;
  return knownRequestIdOf({ id, workspaceId, labels, parentAgentId: parentOf(agent) }, { home });
}

/** The paseo-bm Managers, Workers and Reviewers of a walk, by their provider. */
function workingAgentsIn(listed: ReadonlyArray<Record<string, unknown>>) {
  // One data folder for the walk: the labels are checked against its registry and bindings.
  const home = dataHome();
  return listed.flatMap((agent) => {
    const role = roleOfProvider(agent["provider"]);
    const id = typeof agent["id"] === "string" ? agent["id"] : "";
    if (id === "" || (role !== "manager" && role !== "worker" && role !== "reviewer")) return [];
    const workspaceId = typeof agent["workspaceId"] === "string" ? agent["workspaceId"] : null;
    return [
      {
        id,
        role,
        workspaceId,
        title: typeof agent["title"] === "string" ? agent["title"] : null,
        status: typeof agent["status"] === "string" ? agent["status"] : "closed",
        archived: typeof agent["archivedAt"] === "string" && agent["archivedAt"] !== "",
        // The agent that created it: a Worker's Manager (`paseo.parent-agent-id`, AGENTS.md).
        parentAgentId: parentOf(agent),
        // A Worker's request (`bm.requestId`), or null.
        requestIdLabel: requestLabelOf(agent, id, workspaceId, home),
      },
    ];
  });
}

/** Every paseo-bm Manager, Worker and Reviewer by its provider, as `agents.list` shows it (design §5.2). */
export async function workingAgents(paseo: Pick<OrchestratorToolsPaseo, "agents">): Promise<ReturnType<typeof workingAgentsIn>> {
  return workingAgentsIn(await listAgents(paseo));
}

/** `workingAgents` from the call's own walk. */
export async function workingAgentsOf(context: Pick<ToolContext, "listed">): Promise<ReturnType<typeof workingAgentsIn>> {
  return workingAgentsIn(await context.listed());
}

/** The Orchestrator agent, from the call's own walk (`findOrchestratorAgent` checks its labels itself); null when there is none. */
export async function orchestratorOf(context: Pick<ToolContext, "listed">): Promise<OrchestratorAgentSnapshot | null> {
  const listed = await context.listed();
  const snapshot = { agents: { list: async () => ({ entries: listed.map((agent) => ({ agent })) }) } };
  return findOrchestratorAgent(snapshot as unknown as OrchestratorAgentPaseo);
}

/** The Orchestrator agent's id, or null when it cannot be found. */
export async function orchestratorIdOf(context: Pick<ToolContext, "listed">): Promise<string | null> {
  try {
    return (await orchestratorOf(context))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The events of the Orchestrator's running wake (the event bus's
 * `wakeEventsOf`), which what it does in that turn is logged against
 * (autonomy design §G.3); none without the bus or an Orchestrator.
 */
export async function wakeEventsNow(context: Pick<ToolContext, "listed">, deps: Pick<ToolDeps, "wakeEventsOf">): Promise<readonly BmEvent[]> {
  const wakeEventsOf = deps.wakeEventsOf;
  if (wakeEventsOf === undefined) return [];
  const orchestratorId = await orchestratorIdOf(context);
  return orchestratorId === null ? [] : wakeEventsOf(orchestratorId);
}

/** The non-archived paseo-bm Manager `managerId` of `workspaceId`, or a refusal saying which of these it is not. */
export async function requireManager(input: { workspaceId: string; managerId: string }, context: ToolContext) {
  const manager = (await workingAgentsOf(context)).find((candidate) => candidate.id === input.managerId);
  if (manager === undefined || manager.role !== "manager") refuse(`${input.managerId} is not a paseo-bm Manager; use a managerId bm_projects gave`);
  if (manager.workspaceId !== input.workspaceId) refuse(`Manager ${input.managerId} does not belong to project ${input.workspaceId}`);
  if (manager.archived) refuse(`Manager ${input.managerId} is archived; nothing can be sent to it`);
  return manager;
}

/** Refuses a workspace that is not a paseo-bm project: none of its turns is stored and none of its agents is paseo-bm's. */
export async function requireProject(workspaceId: string, context: ToolContext): Promise<void> {
  if (storedWorkspaceIds(context.location).includes(workspaceId)) return;
  if ((await workingAgentsOf(context)).some((agent) => agent.workspaceId === workspaceId)) return;
  refuse(`no paseo-bm project ${workspaceId}; use the workspaceId bm_projects gave`);
}
