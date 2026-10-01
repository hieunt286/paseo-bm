/**
 * The `boundary-off` Inbox alert (autonomy design §D.2, change-009 C3,
 * change-010 C6): a Worker or Reviewer that runs without the action boundary
 * in a project where the owner turned it on.
 *
 * One alert per agent, on its workspace, the agent's id as subject, for a
 * live Worker or Reviewer that is:
 *
 * - in a project whose boundary is on, and created after it was turned on
 *   (its creation time ≥ the entry's `at`): turning the switch on raises
 *   nothing for the agents already running, which its confirmation says;
 * - on a base provider the boundary covers (`BOUNDARY_PROVIDERS`);
 * - on this build's instructions (`bm.instructions` current — an agent
 *   without them is already an `outdated-agent` alert);
 * - not labelled `bm.boundary=on`, and — while it carries no `bm.boundary` —
 *   not saying `Action boundary: on` in its prompt's Runtime facts, as the
 *   permission handler reads it (live check 2026-10-01 F1: a missing label
 *   raised the alert for every agent under the boundary);
 * - on a profile whose mode the owner did not set by hand (§D.4: the owner's
 *   mode wins, and Settings → Agents says so).
 *
 * It clears when the agent is archived, closed, replaced or gone, when it no
 * longer matches, or when the project's switch is turned off (at once, by
 * `autonomy.set-boundary`, and by the next pass). The pass rides on the
 * outdated-agents pass (`outdated-agents.ts`) and its listing. A config that
 * cannot be read changes nothing. Nothing here messages, stops or archives an
 * agent, and nothing throws.
 */
import { boundaryOf, type AutonomyPolicy } from "../shared/autonomy";
import { roleOfAgent } from "./agent-role";
import type { AlertInput, AlertStore } from "./alert-store";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { hasOutdatedInstructions } from "./instructions-label";
import { providerId } from "./provider-id";
import { asRecord, nonEmpty } from "./role-choices";
import { actionBoundaryOfPrompt } from "./role-instructions";
import { BOUNDARY_LABEL, BOUNDARY_PROVIDERS, TIMED_OUT, withTimeout } from "./role-mode";

/** The snapshot fields the pass reads; `PaseoAgent` is structurally assignable. */
export interface BoundaryOffSnapshot {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  labels?: Record<string, string> | null;
  archivedAt?: string | null;
  status?: string;
  createdAt?: string;
  /** Where the snapshot carries the agent's system prompt (`persistence.metadata.systemPrompt`), when it does. */
  persistence?: unknown;
}

/** What the pass reads of Paseo's config: each alias's base provider and the aliases whose profile sets a mode by hand. */
export interface BoundaryConfig {
  bases: Readonly<Record<string, string>>;
  handSet: ReadonlySet<string>;
}

export interface BoundaryOffAgent {
  agentId: string;
  workspaceId: string;
  role: "worker" | "reviewer";
}

const ROLE_NAME = { worker: "Beads Worker", reviewer: "Reviewer" } as const;

/**
 * The agent as one running without the boundary where it should, or null.
 * Never throws.
 */
export function boundaryOffAgentOf(agent: BoundaryOffSnapshot, policy: AutonomyPolicy, config: BoundaryConfig): BoundaryOffAgent | null {
  try {
    const role = roleOfAgent(agent)?.role;
    if (role !== "worker" && role !== "reviewer") return null;
    if (agent.archivedAt || agent.status === "closed") return null;
    const labels = agent.labels ?? {};
    if (labels[REPLACED_BY_LABEL] !== undefined) return null;
    const workspaceId = typeof agent.workspaceId === "string" && agent.workspaceId !== "" ? agent.workspaceId : null;
    const entry = workspaceId === null ? null : boundaryOf(policy, workspaceId);
    if (workspaceId === null || entry === null) return null;
    const created = typeof agent.createdAt === "string" ? Date.parse(agent.createdAt) : Number.NaN;
    const on = Date.parse(entry.at);
    if (Number.isNaN(created) || Number.isNaN(on) || created < on) return null;
    const alias = providerId(agent.provider);
    if (alias === null || !BOUNDARY_PROVIDERS.includes(config.bases[alias] ?? "")) return null;
    if (hasOutdatedInstructions(labels, role)) return null;
    if (labels[BOUNDARY_LABEL] === "on") return null;
    if (labels[BOUNDARY_LABEL] === undefined && actionBoundaryOfPrompt(asRecord(asRecord(agent.persistence)?.["metadata"])?.["systemPrompt"]) === "on") return null;
    if (config.handSet.has(alias)) return null;
    return { agentId: agent.id, workspaceId, role };
  } catch {
    return null;
  }
}

/** The one-line detail of the alert: what it is and what the owner can do. */
export function boundaryOffDetail(role: BoundaryOffAgent["role"]): string {
  return `This ${ROLE_NAME[role]} started without the action boundary, although it is on in this project: its actions are only watched, not held. It keeps its request; the next one gets a ${ROLE_NAME[role]} under the boundary.`;
}

/** The alert of an agent running without the boundary. */
export function boundaryOffAlertOf(agent: BoundaryOffAgent): AlertInput {
  return { workspaceId: agent.workspaceId, kind: "boundary-off", subject: agent.agentId, detail: boundaryOffDetail(agent.role) };
}

/**
 * The bases and hand-set modes from ONE `config.get()` under the lookup
 * budget, or null when it cannot be read. Never throws.
 */
export async function boundaryConfigOf(paseo: unknown): Promise<BoundaryConfig | null> {
  const config = (paseo as { config?: { get?: unknown } } | null | undefined)?.config;
  if (typeof config?.get !== "function") return null;
  try {
    const result = await withTimeout(config.get.call(config) as Promise<{ config?: unknown } | null | undefined>);
    if (result === TIMED_OUT) return null;
    const read = asRecord(result?.config);
    if (read === null) return null;
    const bases: Record<string, string> = {};
    for (const [id, entry] of Object.entries(asRecord(read["providers"]) ?? {})) {
      const base = nonEmpty(asRecord(entry)?.["extends"]);
      if (base !== null) bases[id] = base;
    }
    const handSet = new Set<string>();
    const profiles = Array.isArray(read["agentProfiles"]) ? (read["agentProfiles"] as unknown[]) : [];
    for (const profile of profiles) {
      const id = nonEmpty(asRecord(profile)?.["id"]);
      if (id !== null && nonEmpty(asRecord(profile)?.["modeId"]) !== null) handSet.add(id);
    }
    return { bases, handSet };
  } catch {
    return null;
  }
}

/**
 * One pass over the listed agents: raises an alert for each agent running
 * without the boundary and clears every open `boundary-off` alert that no
 * longer matches. Returns the keys raised and cleared.
 */
export function detectBoundaryOff(
  agents: readonly (BoundaryOffSnapshot | null | undefined)[],
  store: Pick<AlertStore, "raise" | "clearWhere">,
  policy: AutonomyPolicy,
  config: BoundaryConfig,
): { raised: string[]; cleared: string[] } {
  const keep = new Set<string>();
  const raised: string[] = [];
  for (const agent of agents) {
    const off = agent ? boundaryOffAgentOf(agent, policy, config) : null;
    if (off === null) continue;
    const result = store.raise(boundaryOffAlertOf(off));
    keep.add(result.alert.key);
    if (result.raised) raised.push(result.alert.key);
  }
  const cleared = store.clearWhere((alert) => alert.kind === "boundary-off" && !keep.has(alert.key));
  return { raised, cleared };
}
