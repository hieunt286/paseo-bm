/**
 * Labels a paseo-bm agent that was created without its `bm.role` label
 * (delta 20260918g §4.5, REQ-061 d, owner decision Q1 b).
 *
 * Paseo's `before("agent.create")` hook can change `{ config, env }` only, so an
 * agent started from Paseo's own new-agent flow with a paseo-bm profile runs the
 * role but carries no label. `on("agent.created")` sees it the moment it exists
 * and sets the label through the Paseo CLI (`paseo agent update --label`, which
 * adds or sets labels and never removes one). A Manager also gets `bm.modeSet`
 * set to the mode it already runs in, so `manager.ensure` never switches a mode
 * the user chose.
 *
 * Best effort: running the CLI from inside the daemon is not proven on a real
 * daemon yet (bead bm-wp-249-5qqp.1). Recognising the role by provider
 * (`agent-role.ts`) is what guarantees the cards; a failure here costs one log
 * line. Nothing here throws, and each agent is handled at most once per run.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents, roleOfAgent, roleOfProvider } from "./agent-role";
import { setAgentLabels, type PaseoCliDeps } from "./paseo-cli";
import { checkWorkerTools, type ToolsPaseo } from "./tools-check";
import { linkReplacementReviewer } from "./fallback-reviewer";

/** The snapshot fields this module reads; `PaseoAgent` is structurally assignable. */
export interface LabelAgentSnapshot {
  labels?: Record<string, string> | null;
  currentModeId?: string | null;
  runtimeInfo?: { modeId?: string | null } | null;
}

/** Minimal SDK view: re-read one agent. */
export interface LabelPaseo {
  agents: {
    ref(agentId: string): { refresh(): Promise<{ agent: LabelAgentSnapshot } | null> };
  };
}

/** What the load-time scan reads from `agents.list`. */
export interface ScanAgentSnapshot {
  id: string;
  provider?: string;
  labels?: Record<string, string> | null;
  archivedAt?: string | null;
}

/** Minimal SDK view for the scan: list every agent, and re-read one. */
export interface ScanPaseo extends LabelPaseo {
  agents: LabelPaseo["agents"] & {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: ScanAgentSnapshot }>;
      pageInfo?: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

export interface AgentLabelsDeps {
  /** How the `paseo` CLI is found and run; tests pass a fake runner. */
  cli?: PaseoCliDeps;
  /** Where outcomes are reported. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

export type LabelOutcome = "not-bm" | "already-handled" | "already-labelled" | "labelled" | "failed";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * One labeller per plugin run: it remembers which agents it has handled, so an
 * agent is labelled at most once whether `agent.created` or a scan sees it.
 */
export function createAgentLabeller(deps: AgentLabelsDeps = {}) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const handled = new Set<string>();

  /** Labels `agentId` when its provider is paseo-bm's and it has no valid `bm.role`. Never throws. */
  async function labelAgent(agentId: string, provider: unknown, paseo: LabelPaseo): Promise<LabelOutcome> {
    const role = roleOfProvider(provider);
    if (role === null) return "not-bm";
    if (handled.has(agentId)) return "already-handled";
    // Marked before the first await: two events for one agent label it once.
    handled.add(agentId);
    try {
      const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
      if (snapshot === null) {
        log(`[paseo-bm] could not label ${agentId} as ${role}: Paseo returned no snapshot for it.`);
        return "failed";
      }
      if (roleOfAgent({ labels: snapshot.labels ?? {} })?.labelled === true) return "already-labelled";
      const labels: Record<string, string> = { "bm.role": role };
      if (role === "manager") {
        const mode = nonEmpty(snapshot.runtimeInfo?.modeId) ?? nonEmpty(snapshot.currentModeId);
        if (mode !== null) labels["bm.modeSet"] = mode;
      }
      const result = await setAgentLabels(agentId, labels, deps.cli);
      if (!result.ok) {
        log(`[paseo-bm] could not label ${agentId} as ${role}: ${result.reason}`);
        return "failed";
      }
      log(`[paseo-bm] labelled ${agentId} as ${role} (it was created without bm.role).`);
      return "labelled";
    } catch (error) {
      log(`[paseo-bm] could not label ${agentId} as ${role}: ${describeError(error)}`);
      return "failed";
    }
  }

  let scan: Promise<void> | null = null;

  /**
   * Labels every live bm-* agent that lacks `bm.role`, once per plugin run
   * (owner decision Q6 a). The server has no Paseo handle at load time, so the
   * first lifecycle event after load starts it with its own `paseo` (design
   * §4.5 errata). Returns the scan; callers do not wait for it. Never rejects.
   */
  function scanOnce(paseo: ScanPaseo): Promise<void> {
    if (scan !== null) return scan;
    scan = (async () => {
      let agents: ScanAgentSnapshot[];
      try {
        agents = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
      } catch (error) {
        log(`[paseo-bm] could not list the agents to label: ${describeError(error)}`);
        return;
      }
      for (const agent of agents) {
        if (!agent || agent.archivedAt || roleOfAgent(agent)?.labelled !== false) continue;
        await labelAgent(agent.id, agent.provider, paseo);
      }
    })();
    return scan;
  }

  return { labelAgent, scanOnce };
}

export type AgentLabeller = ReturnType<typeof createAgentLabeller>;

export type AgentLabelsHost = Partial<Pick<PluginServerContext, "on">>;

/**
 * Registers `on("agent.created")` (label the new agent) and
 * `on("agent.turn_started")` (start the once-per-run scan) and returns their
 * remover; a no-op on a host without `on` (the stop propagation already logs
 * that host's one line). Neither handler waits for the scan.
 */
export function registerAgentLabels(host: AgentLabelsHost, labeller: AgentLabeller = createAgentLabeller()): () => void {
  if (typeof host.on !== "function") return () => {};
  const removers = [
    host.on("agent.created", async (event, context) => {
      try {
        // `PaseoApi` is structurally a `ScanPaseo`; typecheck:plugin checks it here.
        const paseo: ScanPaseo = context.paseo;
        void labeller.scanOnce(paseo);
        await labeller.labelAgent(event.agent.id, event.agent.provider, paseo);
      } catch (error) {
        console.warn(`[paseo-bm] labelling a new agent failed: ${describeError(error)}`);
      }
      // Delta 20260921 §4.2.4: a Worker without Paseo tools (Pi without
      // pi-mcp-adapter) is reported to its Manager with BM-TOOLS.
      const created = (event as { agent?: { id?: unknown; provider?: unknown; parentAgentId?: unknown } } | null)?.agent;
      if (typeof created?.id === "string" && typeof created.provider === "string" && roleOfProvider(created.provider) === "worker") {
        await checkWorkerTools(
          { id: created.id, provider: created.provider, parentAgentId: typeof created.parentAgentId === "string" ? created.parentAgentId : null },
          (context as { paseo?: unknown } | null)?.paseo as ToolsPaseo,
        );
      }
      // Delta 20260921 §4.5.1: the Reviewer a Worker creates to replace a
      // stopped one completes its fallback incident.
      if (typeof created?.id === "string" && roleOfProvider(created.provider) === "reviewer") {
        await linkReplacementReviewer(created.id, created.provider, (context as { paseo?: unknown } | null)?.paseo);
      }
    }),
    host.on("agent.turn_started", (_event, context) => {
      try {
        const paseo: ScanPaseo = context.paseo;
        void labeller.scanOnce(paseo);
      } catch (error) {
        console.warn(`[paseo-bm] starting the label scan failed: ${describeError(error)}`);
      }
    }),
  ];
  return () => {
    for (const remove of removers) if (typeof remove === "function") remove();
  };
}
