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
 * Every agent `agent.created` reports also gets `bm.instructions`, the hash of
 * the role text this build's creation hook gave it (autonomy design §A.11,
 * PRD §11 rule 3; `instructions-label.ts`), in the same command. The load-time
 * scan never adds it: an agent without it is one `outdated-agents.ts` flags.
 * A new Worker or Reviewer also gets `bm.boundary=on|off` (autonomy design
 * §D.2, change-009 C3) from the `Action boundary` line of its Runtime facts —
 * a prompt without the line is `off` — so the permission handler, the
 * `boundary-off` alert and the replay can tell whether it runs under the
 * action boundary without reading its prompt. At `agent.created` the snapshot
 * usually carries no prompt yet (live check 2026-10-01 F1), so the value the
 * creation hook recorded for it (`created-boundary.ts`) is used instead.
 *
 * Best effort: running the CLI from inside the daemon is not proven on a real
 * daemon yet (bead bm-wp-249-5qqp.1). Recognising the role by provider
 * (`agent-role.ts`) is what guarantees the cards; a failure here costs one log
 * line. Nothing here throws, and each agent is handled at most once per run.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents, roleOfAgent, roleOfProvider, type BmRole } from "./agent-role";
import { INSTRUCTIONS_LABEL, currentInstructionsHash, roleTextOf } from "./instructions-label";
import { actionBoundaryOfPrompt } from "./role-instructions";
import { BOUNDARY_LABEL } from "./role-mode";
import { takeCreatedBoundary } from "./created-boundary";
import { setAgentLabels, type PaseoCliDeps } from "./paseo-cli";
import { checkWorkerTools, type ToolsPaseo } from "./tools-check";
import { linkReplacementReviewer } from "./fallback-reviewer";
import { checkRolePairing, type PairingPaseo, type RolePairingDeps } from "./role-pairing";
import { errorText } from "./rpc-kit";
import { createTitleMarker, type TitleMarker, type TitlePaseo } from "./role-title";

/** The snapshot fields this module reads; `PaseoAgent` is structurally assignable. */
export interface LabelAgentSnapshot {
  labels?: Record<string, string> | null;
  currentModeId?: string | null;
  runtimeInfo?: { modeId?: string | null } | null;
  /** The system prompt Paseo gave the agent, when the snapshot carries it (`persistence.metadata.systemPrompt`). */
  persistence?: { metadata?: unknown } | null;
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

export interface LabelOptions {
  /**
   * True only from `agent.created`: the agent was just created by this build,
   * whose creation hook gave it this build's role text, so it also gets
   * `bm.instructions` (`instructions-label.ts`). The load-time scan never sets
   * it — the agents it finds are older than this run, and stamping them would
   * hide exactly what the outdated-agent check looks for.
   */
  created?: boolean;
  /**
   * The new agent's folder, from `agent.created`: with the provider, it finds
   * the boundary the creation hook applied (`created-boundary.ts`) when the
   * snapshot shows no prompt yet.
   */
  cwd?: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * False only when the snapshot shows a system prompt that does not hold this
 * build's role text (the creation hook did not run on it); a snapshot without
 * a readable prompt is taken at the hook's word.
 */
function promptHoldsRoleText(snapshot: LabelAgentSnapshot, role: BmRole): boolean {
  const metadata = snapshot.persistence?.metadata;
  const prompt = metadata !== null && typeof metadata === "object" ? (metadata as { systemPrompt?: unknown }).systemPrompt : undefined;
  return typeof prompt !== "string" || prompt.includes(roleTextOf(role));
}

export { BOUNDARY_LABEL };

/**
 * A new Worker's or Reviewer's `bm.boundary` value from its prompt's facts
 * line: `on`, else `off` (a missing line reads as off); null for another role
 * or when the snapshot shows no prompt.
 */
export function boundaryLabelOf(snapshot: LabelAgentSnapshot, role: BmRole): "on" | "off" | null {
  if (role !== "worker" && role !== "reviewer") return null;
  const metadata = snapshot.persistence?.metadata;
  const prompt = metadata !== null && typeof metadata === "object" ? (metadata as { systemPrompt?: unknown }).systemPrompt : undefined;
  if (typeof prompt !== "string") return null;
  return actionBoundaryOfPrompt(prompt) === "on" ? "on" : "off";
}

/**
 * One labeller per plugin run: it remembers which agents it has handled, so an
 * agent is labelled at most once whether `agent.created` or a scan sees it.
 */
export function createAgentLabeller(deps: AgentLabelsDeps = {}) {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const handled = new Set<string>();
  // Agents `agent.created` has stamped with `bm.instructions`; separate from
  // `handled`, so a scan that reached a new agent first does not cost it its stamp.
  const stamped = new Set<string>();

  /**
   * Labels `agentId` when its provider is paseo-bm's: `bm.role` (and a
   * Manager's `bm.modeSet`) when it has no valid role label, and — only for
   * `created` — `bm.instructions` with this build's hash, all in one command.
   * Never throws.
   */
  async function labelAgent(agentId: string, provider: unknown, paseo: LabelPaseo, options: LabelOptions = {}): Promise<LabelOutcome> {
    const role = roleOfProvider(provider);
    if (role === null) return "not-bm";
    const roleDone = handled.has(agentId);
    const stamp = options.created === true && !stamped.has(agentId);
    if (roleDone && !stamp) return "already-handled";
    // Marked before the first await: two events for one agent label it once.
    handled.add(agentId);
    if (stamp) stamped.add(agentId);
    // Taken whatever the snapshot shows, so each creation uses up its own entry.
    const recorded = stamp && (role === "worker" || role === "reviewer") ? takeCreatedBoundary(provider, options.cwd) : null;
    try {
      const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
      if (snapshot === null) {
        log(`[paseo-bm] could not label ${agentId} as ${role}: Paseo returned no snapshot for it.`);
        return "failed";
      }
      const current = snapshot.labels ?? {};
      const labels: Record<string, string> = {};
      const addRole = !roleDone && roleOfAgent({ labels: current })?.labelled !== true;
      if (addRole) {
        labels["bm.role"] = role;
        if (role === "manager") {
          const mode = nonEmpty(snapshot.runtimeInfo?.modeId) ?? nonEmpty(snapshot.currentModeId);
          if (mode !== null) labels["bm.modeSet"] = mode;
        }
      }
      if (stamp && current[INSTRUCTIONS_LABEL] !== currentInstructionsHash(role)) {
        if (promptHoldsRoleText(snapshot, role)) labels[INSTRUCTIONS_LABEL] = currentInstructionsHash(role);
        else log(`[paseo-bm] ${agentId} was created without this build's ${role} instructions, so it is not marked as current.`);
      }
      // The prompt's facts line when the snapshot shows it, else the hook's record.
      const boundary = stamp ? (boundaryLabelOf(snapshot, role) ?? recorded) : null;
      if (boundary !== null && current[BOUNDARY_LABEL] !== boundary) labels[BOUNDARY_LABEL] = boundary;
      if (Object.keys(labels).length === 0) return "already-labelled";
      const result = await setAgentLabels(agentId, labels, deps.cli);
      if (!result.ok) {
        log(`[paseo-bm] could not label ${agentId} as ${role}: ${result.reason}`);
        return "failed";
      }
      if (addRole) log(`[paseo-bm] labelled ${agentId} as ${role} (it was created without bm.role).`);
      return "labelled";
    } catch (error) {
      log(`[paseo-bm] could not label ${agentId} as ${role}: ${errorText(error)}`);
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
        log(`[paseo-bm] could not list the agents to label: ${errorText(error)}`);
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
 * Registers `on("agent.created")` (label the new agent, and check the role
 * pairing: `role-pairing.ts`, design §A.10) and `on("agent.turn_started")`
 * (start the once-per-run scan, and put the role marker back on a title
 * Paseo set after the creation: `role-title.ts`) and returns their remover; a no-op on a host
 * without `on` (the stop propagation already logs that host's one line).
 * Neither handler waits for the scan. `pairing` is where a mismatch goes (the
 * Inbox alerts store once the event bus is wired, a log line until then).
 * `onCreated`, when given, also sees every new agent, last: the handoff's
 * successor check (`handoff.ts`, autonomy design §G.6).
 */
export function registerAgentLabels(
  host: AgentLabelsHost,
  labeller: AgentLabeller = createAgentLabeller(),
  pairing: RolePairingDeps = {},
  onCreated?: (agent: { id: string; provider: unknown; parentAgentId: string | null; workspaceId: string | null }, paseo: unknown) => Promise<unknown>,
  titles: TitleMarker = createTitleMarker(),
): () => void {
  if (typeof host.on !== "function") return () => {};
  const removers = [
    host.on("agent.created", async (event, context) => {
      try {
        // `PaseoApi` is structurally a `ScanPaseo`; typecheck:plugin checks it here.
        const paseo: ScanPaseo = context.paseo;
        void labeller.scanOnce(paseo);
        await labeller.labelAgent(event.agent.id, event.agent.provider, paseo, {
          created: true,
          ...(typeof event.agent.cwd === "string" ? { cwd: event.agent.cwd } : {}),
        });
      } catch (error) {
        console.warn(`[paseo-bm] labelling a new agent failed: ${errorText(error)}`);
      }
      // Delta 20260921 §4.2.4: a Worker without Paseo tools (Pi without
      // pi-mcp-adapter) is reported to its Manager with BM-TOOLS.
      const created = (
        event as { agent?: { id?: unknown; provider?: unknown; parentAgentId?: unknown; workspaceId?: unknown } } | null
      )?.agent;
      // Design §A.10: the creation hook cannot see the creator, so the pairing is checked here.
      if (typeof created?.id === "string" && typeof created.provider === "string") {
        await checkRolePairing(
          {
            id: created.id,
            provider: created.provider,
            parentAgentId: typeof created.parentAgentId === "string" ? created.parentAgentId : null,
            workspaceId: typeof created.workspaceId === "string" ? created.workspaceId : null,
          },
          (context as { paseo?: unknown } | null)?.paseo as PairingPaseo | undefined,
          pairing,
        );
      }
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
      // Autonomy design §G.6: a Worker its handoff's Manager created with bm.handoffFrom completes the handoff.
      if (typeof created?.id === "string" && onCreated !== undefined) {
        try {
          await onCreated(
            {
              id: created.id,
              provider: created.provider,
              parentAgentId: typeof created.parentAgentId === "string" ? created.parentAgentId : null,
              workspaceId: typeof created.workspaceId === "string" ? created.workspaceId : null,
            },
            (context as { paseo?: unknown } | null)?.paseo,
          );
        } catch (error) {
          console.warn(`[paseo-bm] checking a new agent for a handoff failed: ${errorText(error)}`);
        }
      }
    }),
    host.on("agent.turn_started", (event, context) => {
      try {
        const paseo: ScanPaseo = context.paseo;
        void labeller.scanOnce(paseo);
      } catch (error) {
        console.warn(`[paseo-bm] starting the label scan failed: ${errorText(error)}`);
      }
      // An agent Paseo named after its creation (a cleared conversation) gets its role marker back.
      const agent = (event as { agent?: { id?: unknown; provider?: unknown; title?: unknown } } | null)?.agent;
      if (typeof agent?.id === "string") {
        void titles.remark(
          { id: agent.id, provider: agent.provider, title: typeof agent.title === "string" ? agent.title : null },
          (context as { paseo?: unknown } | null)?.paseo as TitlePaseo,
        );
      }
    }),
  ];
  return () => {
    for (const remove of removers) if (typeof remove === "function") remove();
  };
}
