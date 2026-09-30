/**
 * Agents on older role instructions (autonomy PRD §11 rule 3 and the
 * compatibility NFR, owner decision Q-106; design §A.11, §A.14): no
 * compatibility layer, only detection and replacement.
 *
 * An agent is **outdated** when its `bm.instructions` label
 * (`instructions-label.ts`) is missing or holds another hash than this build's
 * for its role. Every live Beads Manager, Worker and Reviewer that is outdated
 * is an `outdated-agent` Inbox alert (§A.8) on its workspace, the agent's id as
 * subject:
 *
 * - a **Manager** is offered its replacement: `manager.ensure { workspaceId,
 *   replaceOutdated: true }` creates a new one and marks the old one
 *   `bm.replacedBy`, which never archives it (ADR-005);
 * - a **Worker** or **Reviewer** is only flagged: it ends with its request, and
 *   the next request gets a new, current one.
 *
 * The Orchestrator is not flagged: it replaces itself (`orchestrator-agent.ts`).
 * An agent another agent replaced (`bm.replacedBy`), an archived or closed
 * one, and one created in the last `STAMP_GRACE_MS` still without the label
 * (its `agent.created` stamp may not have landed yet) are not outdated.
 *
 * **When it runs:** a pass lists every non-archived agent and raises or clears
 * the alerts to match. It runs at most once per `OUTDATED_PASS_INTERVAL_MS`,
 * started by `inbox.alerts` (the Inbox reads every 5 s while it shows) and by
 * `agent.turn_started`; neither waits for it. `agent.archived` clears the
 * archived agent's alert at once. A listing that fails changes nothing.
 *
 * Nothing here messages, stops or archives an agent, and nothing throws.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents, roleOfAgent, type BmRole } from "./agent-role";
import { createAlertStore, type AlertInput, type AlertStore } from "./alert-store";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { INSTRUCTIONS_LABEL, hasOutdatedInstructions } from "./instructions-label";

/** Least time between two passes. */
export const OUTDATED_PASS_INTERVAL_MS = 60_000;

/** How long a new agent without `bm.instructions` is given before it counts as outdated. */
export const STAMP_GRACE_MS = 5 * 60_000;

/** The roles that are flagged. */
export type OutdatedRole = Exclude<BmRole, "orchestrator">;

/** The snapshot fields a pass reads; `PaseoAgent` is structurally assignable. */
export interface OutdatedAgentSnapshot {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  labels?: Record<string, string> | null;
  archivedAt?: string | null;
  status?: string;
  createdAt?: string;
}

/** Minimal SDK view: list every agent. `PaseoApi` is structurally assignable. */
export interface OutdatedPaseo {
  agents: {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: OutdatedAgentSnapshot }>;
      pageInfo?: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

export interface OutdatedAgent {
  agentId: string;
  workspaceId: string | null;
  role: OutdatedRole;
}

const ROLE_NAME: Readonly<Record<OutdatedRole, string>> = {
  manager: "Beads Manager",
  worker: "Beads Worker",
  reviewer: "Reviewer",
};

/**
 * The agent as an outdated one, or null: not a Manager, Worker or Reviewer,
 * archived, closed, replaced, current, or new and not stamped yet. Never throws.
 */
export function outdatedAgentOf(agent: OutdatedAgentSnapshot, now: number): OutdatedAgent | null {
  try {
    const role = roleOfAgent(agent)?.role;
    if (role === undefined || role === "orchestrator") return null;
    if (agent.archivedAt || agent.status === "closed") return null;
    const labels = agent.labels ?? {};
    if (labels[REPLACED_BY_LABEL] !== undefined) return null;
    if (!hasOutdatedInstructions(labels, role)) return null;
    if (labels[INSTRUCTIONS_LABEL] === undefined) {
      const created = typeof agent.createdAt === "string" ? Date.parse(agent.createdAt) : Number.NaN;
      if (!Number.isNaN(created) && now - created < STAMP_GRACE_MS) return null;
    }
    const workspaceId = typeof agent.workspaceId === "string" && agent.workspaceId !== "" ? agent.workspaceId : null;
    return { agentId: agent.id, workspaceId, role };
  } catch {
    return null;
  }
}

/** The one-line detail of the alert: what it is and what the owner can do. */
export function outdatedAgentDetail(role: OutdatedRole): string {
  return role === "manager"
    ? "This Beads Manager runs the instructions of an older paseo-bm. Replace it to give the project a Manager with the current ones; the old one stays until you archive it."
    : `This ${ROLE_NAME[role]} runs the instructions of an older paseo-bm. It keeps its request; the next request gets a new ${ROLE_NAME[role]} with the current ones.`;
}

/** The alert of an outdated agent. */
export function outdatedAgentAlertOf(agent: OutdatedAgent): AlertInput {
  return {
    workspaceId: agent.workspaceId,
    kind: "outdated-agent",
    subject: agent.agentId,
    detail: outdatedAgentDetail(agent.role),
    role: agent.role,
  };
}

export interface OutdatedPassResult {
  outdated: OutdatedAgent[];
  /** Keys raised by this pass (not open before it). */
  raised: string[];
  /** Keys cleared by this pass. */
  cleared: string[];
}

/**
 * One pass: lists every non-archived agent, raises an alert for each outdated
 * one and clears every open `outdated-agent` alert whose agent is no longer
 * outdated (current, replaced, archived, closed or gone). Rejects when the
 * listing fails, before touching the store.
 */
export async function detectOutdatedAgents(
  paseo: OutdatedPaseo,
  store: Pick<AlertStore, "raise" | "clearWhere">,
  now: number = Date.now(),
): Promise<OutdatedPassResult> {
  const agents = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
  const outdated = agents.map((agent) => (agent ? outdatedAgentOf(agent, now) : null)).filter((agent): agent is OutdatedAgent => agent !== null);
  const keep = new Set<string>();
  const raised: string[] = [];
  for (const agent of outdated) {
    const result = store.raise(outdatedAgentAlertOf(agent));
    keep.add(result.alert.key);
    if (result.raised) raised.push(result.alert.key);
  }
  const cleared = store.clearWhere((alert) => alert.kind === "outdated-agent" && !keep.has(alert.key));
  return { outdated, raised, cleared };
}

export interface OutdatedAgentsDeps extends DataHomeDeps {
  /** Least time between two passes. Defaults to `OUTDATED_PASS_INTERVAL_MS`. */
  intervalMs?: number;
  now?: () => number;
  /** Where a failed pass is reported. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

export interface OutdatedAgentsPass {
  /** Starts a pass unless one ran within the interval or is running. Never rejects. */
  run(paseo: unknown): Promise<void>;
  /** Clears the open alert of an agent that was archived, whatever its workspace. Never throws. */
  clearAgent(agentId: string): void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isListingPaseo(paseo: unknown): paseo is OutdatedPaseo {
  return (
    typeof paseo === "object" &&
    paseo !== null &&
    typeof (paseo as { agents?: { list?: unknown } }).agents?.list === "function"
  );
}

/** One throttled pass per plugin run, on the data folder's alerts store. */
export function createOutdatedAgentsPass(deps: OutdatedAgentsDeps = {}): OutdatedAgentsPass {
  const intervalMs = deps.intervalMs ?? OUTDATED_PASS_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((message: string) => console.warn(message));
  let lastStart = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;

  const storeOf = (): AlertStore | null => {
    const home = resolveDataHome(deps).home;
    return home === null ? null : createAlertStore(home, { now: () => new Date(now()) });
  };

  return {
    run(paseo) {
      if (running !== null) return running;
      if (!isListingPaseo(paseo)) return Promise.resolve();
      const at = now();
      if (at - lastStart < intervalMs) return Promise.resolve();
      lastStart = at;
      running = (async () => {
        try {
          const store = storeOf();
          if (store === null) return;
          await detectOutdatedAgents(paseo, store, at);
        } catch (error) {
          log(`[paseo-bm] could not check the agents for older instructions: ${describeError(error)}`);
        } finally {
          running = null;
        }
      })();
      return running;
    },

    clearAgent(agentId) {
      try {
        const store = storeOf();
        store?.clearWhere((alert) => alert.kind === "outdated-agent" && alert.subject === agentId);
      } catch (error) {
        log(`[paseo-bm] could not clear the older-instructions alert of ${agentId}: ${describeError(error)}`);
      }
    },
  };
}

export type OutdatedAgentsHost = Partial<Pick<PluginServerContext, "on">>;

/**
 * Registers `agent.turn_started` (start a pass, not waited for) and
 * `agent.archived` (clear that agent's alert) and returns their remover; a
 * no-op on a host without `on`.
 */
export function registerOutdatedAgents(host: OutdatedAgentsHost, pass: OutdatedAgentsPass): () => void {
  if (typeof host.on !== "function") return () => {};
  const removers = [
    host.on("agent.turn_started", (_event, context) => {
      void pass.run((context as { paseo?: unknown } | null)?.paseo);
    }),
    host.on("agent.archived", (event) => {
      const id = (event as { agent?: { id?: unknown } } | null)?.agent?.id;
      if (typeof id === "string" && id !== "") pass.clearAgent(id);
    }),
  ];
  return () => {
    for (const remove of removers) if (typeof remove === "function") remove();
  };
}
