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
 *   `bm.replacedBy`, which never archives it (ADR-005); a **Main** (missions
 *   design §6) is replaced by `mission.ensure { missionId, replace:
 *   "outdated" }` instead, so its alert carries no role but its `missionId`;
 * - a **Worker** or **Reviewer** is only flagged: it ends with its request, and
 *   the next request gets a new, current one.
 *
 * An **extra Manager** (missions design §3.6) is an `outdated-agent` alert too,
 * whatever its instructions: a live Manager of a repo workspace an open
 * mission's scope holds that is not the Main of an open mission (by its
 * `bm.missionId` label or the mission's `mainId`). Its alert
 * (`EXTRA_MANAGER_DETAIL`) carries `role: "manager"` and the newest such
 * mission's `missionId`: the Inbox opens that mission's Main.
 *
 * A Manager the creation hook bound whose binding expired unsettled (design
 * §7.17.7) is an `outdated-agent` alert too, with its own detail
 * (`UNBOUND_MANAGER_DETAIL`): its instructions are bound, its tools are not,
 * so it has neither path. The recovery pass raises it (`creation-settle.ts`);
 * the pass here keeps it open while the Manager is live and not replaced, and
 * `manager.ensure { replaceOutdated: true }` replaces that Manager too.
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
 * The same pass, over the same listing, raises and clears the `boundary-off`
 * alerts (`boundary-off.ts`, autonomy design §D.2, change-010 C6), and
 * `agent.archived` clears that agent's one too.
 *
 * Nothing here messages, stops or archives an agent, and nothing throws.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listAllAgents, roleOfAgent, type BmRole } from "./agent-role";
import { createAlertStore, type AlertInput, type AlertStore } from "./alert-store";
import { effectivePolicy } from "./placements";
import { boundaryConfigOf, detectBoundaryOff } from "./boundary-off";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { createMissionStore, type Mission } from "./mission-store";
import { MISSION_ID_LABEL } from "./role-title";
import { INSTRUCTIONS_LABEL, hasOutdatedInstructions } from "./instructions-label";
import { errorText } from "./rpc-kit";
import { alertKeyOf } from "../shared/alerts";

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
  /** The system prompt, when the listing carries it: the `boundary-off` check reads its facts line until `bm.boundary` is written. */
  persistence?: unknown;
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
  /** A Main's mission (`bm.missionId`): its remedy is `mission.ensure`, not `manager.ensure` (missions design §6). */
  missionId?: string;
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
    const missionId = role === "manager" ? labels[MISSION_ID_LABEL] : undefined;
    return { agentId: agent.id, workspaceId, role, ...(missionId === undefined || missionId === "" ? {} : { missionId }) };
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

/**
 * The detail of an outdated Main (missions design §6): its remedy is
 * `mission.ensure { missionId, replace: "outdated" }`, which moves its
 * requests, Workers and queued deliveries to the successor.
 */
export const OUTDATED_MAIN_DETAIL =
  "This Main runs the instructions of an older paseo-bm. Replacing it gives the mission a Main with the current ones: its requests and Workers move to the new one, and the old one stays until you archive it.";

/** The detail of a Manager whose hook binding expired unsettled (§7.17.7): what it is and what the owner can do. */
export const UNBOUND_MANAGER_DETAIL =
  "This Beads Manager was set up for paseo-bm's tools, but they never connected. Replace it to give the project a Manager that has them; the old one stays until you archive it.";

/** The `outdated-agent` alert of a Manager whose hook binding expired unsettled (§7.17.7). */
export function unboundManagerAlertOf(agent: { agentId: string; workspaceId: string | null }): AlertInput {
  return { workspaceId: agent.workspaceId, kind: "outdated-agent", subject: agent.agentId, detail: UNBOUND_MANAGER_DETAIL, role: "manager" };
}

/** True when the Manager's open `outdated-agent` alert is the unbound one (§7.17.7): `manager.ensure` may replace it. Never throws. */
export function hasUnboundManagerAlert(home: string | null, workspaceId: string, agentId: string): boolean {
  try {
    if (home === null) return false;
    const alert = createAlertStore(home).get(alertKeyOf("outdated-agent", workspaceId, agentId));
    return alert !== null && alert.clearedAt === null && alert.detail === UNBOUND_MANAGER_DETAIL;
  } catch {
    return false;
  }
}

/** True when the snapshot is a live Manager no other agent replaced: one an unbound-Manager alert stays open for. Never throws. */
function isLiveManager(agent: OutdatedAgentSnapshot): boolean {
  try {
    return roleOfAgent(agent)?.role === "manager" && !agent.archivedAt && agent.status !== "closed" && agent.labels?.[REPLACED_BY_LABEL] === undefined;
  } catch {
    return false;
  }
}

/**
 * The alert of an outdated agent. A Main's carries no `role` but its
 * `missionId`: the Inbox's replace action is then `mission.ensure { missionId,
 * replace: "outdated" }`, not `manager.ensure` on the alert's workspace (for a
 * Main, the Missions home), and the detail names its remedy.
 */
export function outdatedAgentAlertOf(agent: OutdatedAgent): AlertInput {
  if (agent.missionId !== undefined) return { workspaceId: agent.workspaceId, kind: "outdated-agent", subject: agent.agentId, detail: OUTDATED_MAIN_DETAIL, missionId: agent.missionId };
  return {
    workspaceId: agent.workspaceId,
    kind: "outdated-agent",
    subject: agent.agentId,
    detail: outdatedAgentDetail(agent.role),
    role: agent.role,
  };
}

/** The detail of an extra Manager of a repo a mission holds (missions design §3.6). */
export const EXTRA_MANAGER_DETAIL =
  "This Beads Manager is an extra one: this project's work goes to its mission's Main. Open the mission's Main; this one stays until you archive it.";

/** What the extra-Manager check reads of an open mission; the newest mission first. */
export type OpenMission = Pick<Mission, "missionId" | "mainId"> & { repos: readonly string[] };

/** The open missions of the data folder, the newest first. Never throws: none when they cannot be read. */
export function openMissionsOf(home: string): OpenMission[] {
  try {
    const store = createMissionStore(home);
    return store
      .list()
      .filter((entry) => entry.state === "open")
      .map((entry) => store.get(entry.missionId))
      .filter((mission): mission is Mission => mission !== null && mission.state === "open")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((mission) => ({ missionId: mission.missionId, mainId: mission.mainId, repos: mission.charter.repos }));
  } catch {
    return [];
  }
}

/**
 * The extra Managers (missions design §3.6): each live, non-replaced Manager of
 * a workspace an open mission's scope holds that is not the Main of an open
 * mission, with the newest such mission. Never throws.
 */
export function extraManagersOf(agents: readonly (OutdatedAgentSnapshot | null | undefined)[], missions: readonly OpenMission[]): Array<OutdatedAgent & { missionId: string }> {
  if (missions.length === 0) return [];
  const mains = new Set(missions.flatMap((mission) => [mission.missionId, ...(mission.mainId === null ? [] : [mission.mainId])]));
  return agents.flatMap((agent) => {
    if (agent === null || agent === undefined || !isLiveManager(agent) || typeof agent.workspaceId !== "string") return [];
    const label = agent.labels?.[MISSION_ID_LABEL];
    if (mains.has(agent.id) || (label !== undefined && mains.has(label))) return [];
    const mission = missions.find((entry) => entry.repos.includes(agent.workspaceId as string));
    return mission === undefined ? [] : [{ agentId: agent.id, workspaceId: agent.workspaceId, role: "manager" as const, missionId: mission.missionId }];
  });
}

/** The `outdated-agent` alert of an extra Manager (§3.6): the Inbox opens its mission's Main. */
export function extraManagerAlertOf(agent: { agentId: string; workspaceId: string | null; missionId: string }): AlertInput {
  return { workspaceId: agent.workspaceId, kind: "outdated-agent", subject: agent.agentId, detail: EXTRA_MANAGER_DETAIL, role: "manager", missionId: agent.missionId };
}

export interface OutdatedPassResult {
  outdated: OutdatedAgent[];
  /** The extra Managers of repos a mission holds (§3.6), whatever their instructions; not in `outdated`. */
  extra: OutdatedAgent[];
  /** Keys raised by this pass (not open before it). */
  raised: string[];
  /** Keys cleared by this pass. */
  cleared: string[];
}

/**
 * One pass: lists every non-archived agent, raises an alert for each extra
 * Manager of a repo one of `missions` holds (§3.6) and for each other outdated
 * one, and clears every open `outdated-agent` alert whose agent is no longer
 * outdated (current, replaced, archived, closed or gone) — an unbound
 * Manager's (§7.17.7) only once that Manager is no longer live or is
 * replaced. Rejects when the listing fails, before touching the store.
 */
export async function detectOutdatedAgents(
  paseo: OutdatedPaseo,
  store: Pick<AlertStore, "raise" | "clearWhere">,
  now: number = Date.now(),
  listed?: readonly (OutdatedAgentSnapshot | null | undefined)[],
  missions: readonly OpenMission[] = [],
): Promise<OutdatedPassResult> {
  const agents = listed ?? (await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false }));
  const extra = extraManagersOf(agents, missions);
  const extraIds = new Set(extra.map((agent) => agent.agentId));
  const outdated = agents
    .map((agent) => (agent && !extraIds.has(agent.id) ? outdatedAgentOf(agent, now) : null))
    .filter((agent): agent is OutdatedAgent => agent !== null);
  const keep = new Set<string>();
  const raised: string[] = [];
  for (const input of [...extra.map(extraManagerAlertOf), ...outdated.map(outdatedAgentAlertOf)]) {
    const result = store.raise(input);
    keep.add(result.alert.key);
    if (result.raised) raised.push(result.alert.key);
  }
  const liveManagers = new Set(agents.filter((agent): agent is OutdatedAgentSnapshot => agent !== null && agent !== undefined && isLiveManager(agent)).map((agent) => agent.id));
  const cleared = store.clearWhere(
    (alert) => alert.kind === "outdated-agent" && !keep.has(alert.key) && !(alert.detail === UNBOUND_MANAGER_DETAIL && liveManagers.has(alert.subject)),
  );
  return { outdated, extra, raised, cleared };
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

  const homeOf = (): string | null => resolveDataHome(deps).home;
  const storeOf = (home: string | null = homeOf()): AlertStore | null =>
    home === null ? null : createAlertStore(home, { now: () => new Date(now()) });

  return {
    run(paseo) {
      if (running !== null) return running;
      if (!isListingPaseo(paseo)) return Promise.resolve();
      const at = now();
      if (at - lastStart < intervalMs) return Promise.resolve();
      lastStart = at;
      running = (async () => {
        try {
          const home = homeOf();
          const store = storeOf(home);
          if (home === null || store === null) return;
          const agents = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
          await detectOutdatedAgents(paseo, store, at, agents, openMissionsOf(home));
          // The action boundary's alert (§D.2): only with the config read; an unreadable one changes nothing.
          const config = await boundaryConfigOf(paseo);
          if (config !== null) detectBoundaryOff(agents, store, effectivePolicy(home, (reason) => log(`[paseo-bm] could not read the autonomy policy: ${reason}`)), config);
        } catch (error) {
          log(`[paseo-bm] could not check the agents for older instructions: ${errorText(error)}`);
        } finally {
          running = null;
        }
      })();
      return running;
    },

    clearAgent(agentId) {
      try {
        const store = storeOf();
        store?.clearWhere((alert) => (alert.kind === "outdated-agent" || alert.kind === "boundary-off") && alert.subject === agentId);
      } catch (error) {
        log(`[paseo-bm] could not clear the older-instructions alert of ${agentId}: ${errorText(error)}`);
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
