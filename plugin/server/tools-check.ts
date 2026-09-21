/**
 * Whether a new Manager or Worker has Paseo's tools (delta 20260921 §4.2.4,
 * REQ-063 d).
 *
 * Pi drops `mcpServers` silently when the `pi-mcp-adapter` extension is
 * missing (proposal P4): the agent is created but has no Paseo tools, so a
 * Worker cannot send a `BM-REPORT` or create a Reviewer. The agent's
 * `capabilities.supportsMcpServers` says so. For a new Worker the plugin tells
 * the parent Manager with a `BM-TOOLS` notice, through the notice queue, since
 * that Manager is usually still running the turn that created the Worker
 * (design F13). Every check is also kept in memory for the Setup screen.
 *
 * That `supportsMcpServers` is `false` for Pi without its adapter is inferred
 * from the code (proposal O4), not observed: the owner checks it on the real
 * daemon at the phase acceptance. Nothing here throws.
 */
import { roleOfAgent } from "./agent-role";
import { TOOLS_NOTICE_MARKER } from "./notices";
import { enqueue as defaultEnqueue, type NoticeOutcome, type NoticePaseo } from "./notice-queue";

/** The two roles that need Paseo's tools. */
export type ToolsRole = "manager" | "worker";

export type ToolsState = "ok" | "missing" | "unknown";

/** The last check of one role, as `setup.status` reports it. */
export interface ToolsSeen {
  state: ToolsState;
  agentId: string;
  provider: string;
  at: string;
}

const seen = new Map<ToolsRole, ToolsSeen>();

/** The state a `supportsMcpServers` value means. */
export function toolsStateOf(supportsMcpServers: unknown): ToolsState {
  return supportsMcpServers === true ? "ok" : supportsMcpServers === false ? "missing" : "unknown";
}

/** Records the check of one agent; the newest check of a role wins. */
export function recordTools(role: ToolsRole, agentId: string, provider: string, supportsMcpServers: unknown, at: string = new Date().toISOString()): ToolsSeen {
  const entry: ToolsSeen = { state: toolsStateOf(supportsMcpServers), agentId, provider, at };
  seen.set(role, entry);
  return entry;
}

/** The last check of each role, or `null` when none ran in this plugin run. */
export function toolsSeen(): { manager: ToolsSeen | null; worker: ToolsSeen | null } {
  return { manager: seen.get("manager") ?? null, worker: seen.get("worker") ?? null };
}

/** Forgets every check; for tests. */
export function forgetTools(): void {
  seen.clear();
}

/** The notice the parent Manager gets. Agent-facing, so English. */
export function toolsNotice(workerId: string, provider: string): string {
  return `${TOOLS_NOTICE_MARKER} Worker ${workerId} runs on ${provider} without Paseo tools (on Pi this means pi-mcp-adapter is missing). It cannot send you a BM-REPORT or create a Reviewer. Tell the user in one line; do not create another Worker for this request unless the user asks.`;
}

/** The snapshot fields this module reads. */
export interface ToolsAgentSnapshot {
  status?: string | null;
  archivedAt?: string | null;
  provider?: string;
  labels?: Record<string, string> | null;
  capabilities?: { supportsMcpServers?: unknown } | null;
}

/** The SDK slice this module reads; `PaseoApi` is structurally assignable, and so is it to the notice queue's. */
export interface ToolsPaseo {
  agents: {
    ref(agentId: string): {
      refresh(): Promise<{ agent?: ToolsAgentSnapshot | null } | null>;
      send(text: string): Promise<void>;
    };
  };
}

export interface ToolsCheckDeps {
  enqueue?: (targetId: string, kind: string, text: string, paseo?: NoticePaseo) => Promise<NoticeOutcome>;
  log?: (message: string) => void;
}

/**
 * Checks a Worker just created. `agent` is the `agent.created` event's agent.
 * Records the result; when the Worker has no Paseo tools and its parent is a
 * Manager, queues `BM-TOOLS` for that Manager. Never throws.
 */
export async function checkWorkerTools(
  agent: { id: string; provider: string; parentAgentId?: string | null },
  paseo: ToolsPaseo,
  deps: ToolsCheckDeps = {},
): Promise<ToolsState> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const snapshot = await paseo.agents.ref(agent.id).refresh();
    const entry = recordTools("worker", agent.id, agent.provider, snapshot?.agent?.capabilities?.supportsMcpServers);
    if (entry.state !== "missing") return entry.state;
    const parentId = agent.parentAgentId ?? null;
    if (parentId === null) {
      log(`[paseo-bm] Worker ${agent.id} runs on ${agent.provider} without Paseo tools, and has no Manager to tell.`);
      return entry.state;
    }
    const parent = await paseo.agents.ref(parentId).refresh();
    if (roleOfAgent(parent?.agent)?.role !== "manager") {
      log(`[paseo-bm] Worker ${agent.id} runs on ${agent.provider} without Paseo tools; its parent ${parentId} is not a Beads Manager, so nobody is told.`);
      return entry.state;
    }
    await (deps.enqueue ?? defaultEnqueue)(parentId, TOOLS_NOTICE_MARKER, toolsNotice(agent.id, agent.provider), paseo);
    return entry.state;
  } catch (error) {
    log(`[paseo-bm] checking the Paseo tools of ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    return "unknown";
  }
}
