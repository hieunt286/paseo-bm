/**
 * `manager.ensure` on the daemon side (WP-112, design §5, §8, §9.3).
 *
 * One Manager per workspace: look the live Manager up by its `bm.role=manager`
 * label BEFORE creating anything; when there is none, create one from the
 * `bm-manager` agent profile with the instructions in `roles/manager.md` and the
 * labels `bm.role=manager` + `bm.version=<plugin version>`.
 *
 * Lifecycle belongs to the user (ADR-005): this module never deletes or archives
 * a healthy agent. The single exception is cleanup of the exact agent this call
 * just created when the SDK handed it back already failed, so a failed ensure
 * leaves no half-started Manager behind.
 *
 * SDK facts this relies on (checked against @getpaseo/client 0.8.0 typings and
 * @getpaseo/protocol 0.8.0 schemas, not guessed):
 * - `agents.list({ filter: { labels, includeArchived }, page: { limit<=200, cursor } })`;
 *   the directory filter has NO workspace key, so the workspace is matched on
 *   `entry.agent.workspaceId` here.
 * - `agents.create` takes no profile id: `config.provider` is `provider/model`.
 *   The profile is read from `config.get().config.agentProfiles[]`.
 * - Agent snapshots carry `createdAt`, `status` (initializing|idle|running|error|closed),
 *   `archivedAt` and `providerUnavailable`.
 * - The only removal a handle offers is `archive()`; the SDK has no delete.
 */
import type { AgentNode } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import { setAgentLabel, setAgentMode, type PaseoCliDeps } from "./paseo-cli";
import { listAllAgents, roleOfAgent } from "./agent-role";
import { providerId } from "./provider-id";
import { managerModeFor, modesFor } from "./role-mode";

/** Label key and value that identify a paseo-bm Manager (design §5). */
export const MANAGER_ROLE_LABEL = "bm.role";
export const MANAGER_ROLE_VALUE = "manager";
export const VERSION_LABEL = "bm.version";

/**
 * "paseo-bm already set this Manager's mode", with the mode as its value
 * (delta 20260918 §4.1). A Manager that carries it is never switched again, so
 * a mode the user picks by hand afterwards is respected (owner decision Q36).
 */
export const MODE_SET_LABEL = "bm.modeSet";

/** Agent profile id registered by the installer (ADR-006, WP-107). */
export const MANAGER_PROFILE_ID = "bm-manager";

/** Title given to a freshly created Manager. */
export const MANAGER_TITLE = "Beads Manager";

/**
 * Error codes this RPC can report. Taken from the single Phase 1 registry in
 * design §4.4 ("Không được đặt mã tại chỗ"); §5 itself lists no RPC codes.
 */
export type ManagerEnsureErrorCode = "E_PROVIDER_UNAVAILABLE";

/**
 * Coded failure of `manager.ensure`. The message starts with the code so it
 * survives transports that only forward `message`.
 */
export class ManagerEnsureError extends Error {
  readonly code: ManagerEnsureErrorCode;

  constructor(code: ManagerEnsureErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = "ManagerEnsureError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Minimal, injectable view of the Paseo SDK. `PaseoApi` from @getpaseo/client
// is structurally assignable to it (index.server.ts passes the real one, which
// `npm run typecheck:plugin` checks); tests pass a fake.
// ---------------------------------------------------------------------------

export interface ManagerAgentSnapshot {
  id: string;
  workspaceId?: string;
  createdAt: string;
  status: string;
  labels: Record<string, string>;
  /** Provider selection (`bm-manager` or `bm-manager/<model>`); decides the role when the label is missing. */
  provider?: string;
  archivedAt?: string | null;
  providerUnavailable?: boolean;
  lastError?: string;
  /** The mode the agent is in now; `agents.list` entries carry it. */
  currentModeId?: string | null;
}

export interface ManagerAgentHandle {
  readonly id: string;
  current(): ManagerAgentSnapshot | null;
  archive(): Promise<unknown>;
}

export interface ManagerAgentProfile {
  id: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export interface ManagerPaseo {
  agents: {
    list(options: {
      filter: { labels?: Record<string, string>; includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: ManagerAgentSnapshot }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
  workspaces: {
    ref(workspaceId: string): {
      agents: {
        create(options: {
          config: {
            provider: string;
            modeId?: string;
            thinkingOptionId?: string;
            featureValues?: Record<string, unknown>;
            systemPrompt?: string;
          };
          title?: string;
          labels?: Record<string, string>;
        }): Promise<ManagerAgentHandle>;
      };
    };
  };
  config: {
    get(): Promise<{ config: { agentProfiles?: ManagerAgentProfile[] } }>;
  };
  /** Absent on a host that cannot list modes; the Manager then gets no mode of ours. */
  providers?: {
    listModes(provider: string, options?: { cwd?: string }): Promise<unknown>;
  };
}

export interface EnsureManagerDeps {
  paseo: ManagerPaseo;
  /** Returns the text of `roles/manager.md`. */
  readInstructions: () => Promise<string>;
  /** Plugin version written to `bm.version`. Defaults to the baked-in version. */
  version?: string;
  /** Where a failed mode lookup is reported. Defaults to `console.warn`. */
  log?: (message: string) => void;
  /** How the `paseo` CLI is found and run; tests pass a fake runner. */
  cli?: PaseoCliDeps;
}

export interface EnsureManagerResult {
  agentId: string;
  created: boolean;
  /**
   * Other live Managers found in the same workspace, newest first. Reported so
   * the panel can tell the user (design §9.3); never deleted or archived here.
   */
  otherManagerIds: string[];
  /**
   * Why an existing Manager was not switched to its mode, or `null` when there
   * was nothing to say (delta 20260918 §4.1). Never blocks returning the Manager.
   */
  modeNotice: string | null;
}

/** A Manager is live when it is neither archived nor closed. */
function isLive(agent: ManagerAgentSnapshot): boolean {
  return !agent.archivedAt && agent.status !== "closed";
}

/** Newest first by `createdAt`; ties broken by id so the choice is stable. */
function newestFirst(a: ManagerAgentSnapshot, b: ManagerAgentSnapshot): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when the Manager carries the `bm.role=manager` label; false when only its provider says so. */
function labelledManager(agent: ManagerAgentSnapshot): boolean {
  return roleOfAgent(agent)?.labelled === true;
}

/**
 * Every live Manager of the workspace: labelled Managers first, then the ones
 * recognised only by their `bm-manager` provider (started from Paseo's own
 * new-agent flow), each group newest first (delta 20260918g §4.3). Listing
 * with no label filter is what lets the second group be found at all; without
 * it `manager.ensure` created a second Manager next to the user's own.
 */
export async function findLiveManagers(
  paseo: ManagerPaseo,
  workspaceId: string,
): Promise<ManagerAgentSnapshot[]> {
  const all = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
  return all
    .filter((agent) => agent.workspaceId === workspaceId && roleOfAgent(agent)?.role === "manager" && isLive(agent))
    .sort((a, b) => Number(labelledManager(b)) - Number(labelledManager(a)) || newestFirst(a, b));
}

function providerSelection(profile: ManagerAgentProfile): string {
  return profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
}

/** The snapshot of a just-created agent says its provider could not start. */
function startedBroken(snapshot: ManagerAgentSnapshot | null): boolean {
  return snapshot !== null && (snapshot.status === "error" || snapshot.providerUnavailable === true);
}

/**
 * Handler body of `manager.ensure`.
 *
 * Throws `ManagerEnsureError` (`E_PROVIDER_UNAVAILABLE`) when the Manager cannot
 * be created: the `bm-manager` profile is missing, the SDK rejects the create,
 * or the created agent comes back already failed (then that exact agent is
 * archived before throwing).
 */
export async function ensureManager(
  input: { workspaceId: string },
  deps: EnsureManagerDeps,
): Promise<EnsureManagerResult> {
  const { paseo } = deps;
  const { workspaceId } = input;

  const [chosen, ...others] = await findLiveManagers(paseo, workspaceId);
  if (chosen) {
    return {
      agentId: chosen.id,
      created: false,
      otherManagerIds: others.map((agent) => agent.id),
      // A Manager recognised only by its provider was created by the user in a
      // mode they chose: paseo-bm never switches it (delta 20260918g §4.3).
      modeNotice: labelledManager(chosen) ? await switchOnce(chosen, deps) : null,
    };
  }

  const { config } = await paseo.config.get();
  const profile = config.agentProfiles?.find((entry) => entry.id === MANAGER_PROFILE_ID);
  if (!profile) {
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      `agent profile "${MANAGER_PROFILE_ID}" is not registered on this daemon; re-run \`npx paseo-bm\` to register the roles.`,
    );
  }

  const systemPrompt = await deps.readInstructions();

  // The provider's no-prompt mode unless the profile names its own (delta
  // 20260918 §4.1). `modesFor` is raced against 5 s and logs every miss; a miss
  // creates the Manager exactly as before, without the label, so the next open
  // can still switch it.
  const provider = providerId(profile.provider) ?? profile.provider;
  const modes = await modesFor(paseo, provider, deps.log);
  const chosenMode = modes === null ? undefined : managerModeFor(modes, profile.modeId ?? null);
  // Modes unknown: exactly as before this delta. Modes known: only a mode the
  // provider lists — a profile mode it does not list would make the creation fail.
  const modeId = modes === null ? profile.modeId : chosenMode;
  if (modes !== null && chosenMode === undefined) {
    (deps.log ?? ((message: string) => console.warn(message)))(
      `[paseo-bm] ${provider} lists no mode that runs without permission prompts${
        profile.modeId === undefined ? "" : `, nor the profile's own mode "${profile.modeId}"`
      }; the Manager starts in the provider's default mode.`,
    );
  }

  let handle: ManagerAgentHandle;
  try {
    handle = await paseo.workspaces.ref(workspaceId).agents.create({
      config: {
        provider: providerSelection(profile),
        ...(modeId !== undefined ? { modeId } : {}),
        ...(profile.thinkingOptionId !== undefined
          ? { thinkingOptionId: profile.thinkingOptionId }
          : {}),
        ...(profile.featureValues !== undefined ? { featureValues: profile.featureValues } : {}),
        systemPrompt,
      },
      title: MANAGER_TITLE,
      labels: {
        [MANAGER_ROLE_LABEL]: MANAGER_ROLE_VALUE,
        [VERSION_LABEL]: deps.version ?? PLUGIN_VERSION,
        ...(chosenMode !== undefined ? { [MODE_SET_LABEL]: chosenMode } : {}),
      },
    });
  } catch (cause) {
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      `could not create the Manager with profile "${MANAGER_PROFILE_ID}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const snapshot = handle.current();
  if (startedBroken(snapshot)) {
    // Clean up exactly the agent this call created; nothing else is touched.
    let cleanup = "it was archived";
    try {
      await handle.archive();
    } catch (archiveError) {
      cleanup = `archiving it failed (${archiveError instanceof Error ? archiveError.message : String(archiveError)}); archive agent ${handle.id} yourself`;
    }
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      `the Manager's provider did not start${snapshot?.lastError ? `: ${snapshot.lastError}` : ""}; ${cleanup}.`,
    );
  }

  return { agentId: handle.id, created: true, otherManagerIds: [], modeNotice: null };
}

/**
 * Switches a Manager created before delta 20260918 to its mode, once, and marks
 * it with `bm.modeSet` (§4.1, owner decisions Q36, Q37, Q39). Returns what the
 * user should be told, or `null`. Never throws: whatever goes wrong, the
 * Manager is still opened.
 */
async function switchOnce(manager: ManagerAgentSnapshot, deps: EnsureManagerDeps): Promise<string | null> {
  try {
    // 1. Already handled: a mode the user picked since then is theirs.
    if (manager.labels[MODE_SET_LABEL] !== undefined) return null;

    // 2. The same target a new Manager would get; no target, nothing to do.
    const { config } = await deps.paseo.config.get();
    const profile = config.agentProfiles?.find((entry) => entry.id === MANAGER_PROFILE_ID);
    if (!profile) return null;
    const modes = await modesFor(deps.paseo, providerId(profile.provider) ?? profile.provider, deps.log);
    const target = modes === null ? undefined : managerModeFor(modes, profile.modeId ?? null);
    if (target === undefined) return null;

    // 3. Switching mid-turn can rebuild a Claude session's query: wait for the next open.
    if (manager.status === "running") {
      return `Beads Manager ${manager.id} is busy, so it was not switched to "${target}" yet; paseo-bm will try again the next time you open it.`;
    }

    // 4. Switch only when it is not already there.
    if (manager.currentModeId !== target) {
      const switched = await setAgentMode(manager.id, target, deps.cli);
      if (!switched.ok) {
        return `Could not switch Beads Manager ${manager.id} to "${target}": ${switched.reason}. Switch its mode yourself in Paseo.`;
      }
    }

    // 5. Mark it, so it is never switched again. A miss here only means the next open marks it.
    const marked = await setAgentLabel(manager.id, MODE_SET_LABEL, target, deps.cli);
    if (!marked.ok) {
      return `Beads Manager ${manager.id} is in "${target}", but could not be marked as done (${marked.reason}); paseo-bm will try again the next time you open it.`;
    }
    return null;
  } catch (error) {
    return `Could not check the mode of Beads Manager ${manager.id}: ${error instanceof Error ? error.message : String(error)}. Switch its mode yourself in Paseo if it still asks for permission.`;
  }
}

// ---------------------------------------------------------------------------
// `agents.list` (WP-112, design §5, REQ-025a)
// ---------------------------------------------------------------------------

/** Label Paseo sets on an agent created by another agent (AGENTS.md, verified). */
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";

/** Snapshot fields `agents.list` reads. `PaseoAgent` is structurally assignable. */
export interface ListedAgentSnapshot {
  id: string;
  workspaceId?: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  labels: Record<string, string>;
  /** Provider selection; decides the role when the `bm.role` label is missing. */
  provider?: string;
  archivedAt?: string | null;
}

/**
 * Minimal SDK view for `agents.list`. The directory filter's `labels` is
 * optional in the protocol, and it must be omitted here: an unlabeled agent can
 * only be recognised through its parent.
 */
export interface AgentDirectoryPaseo {
  agents: {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: ListedAgentSnapshot }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
}

/** The label's role, else the provider's (delta 20260918g §4.1), else `unknown`. */
function roleOf(agent: ListedAgentSnapshot): AgentNode["role"] {
  return roleOfAgent(agent)?.role ?? "unknown";
}

/** Oldest first by `createdAt`, ties by id, so the list order is stable. */
function oldestFirst(a: ListedAgentSnapshot, b: ListedAgentSnapshot): number {
  const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Handler body of `agents.list`: the non-archived paseo-bm agents of one
 * workspace, flat, oldest first.
 *
 * Membership: an agent with a paseo-bm role — by its `bm.role` label or, when
 * that is missing, by its `bm-*` provider (delta 20260918g) — plus every agent
 * that descends from one through `paseo.parent-agent-id` (an agent of another
 * provider under a Worker still shows up, with role `unknown`). A node without a
 * valid label is `labelled: false`; nothing here throws on labels.
 *
 * `parentId` is the parent label only when that parent is in the result. A
 * parent that was deleted or archived yields `null`, so an orphaned Worker is a
 * root the client can still draw. Read-only: nothing is stopped or archived.
 */
export async function listWorkspaceAgents(
  input: { workspaceId: string },
  deps: { paseo: AgentDirectoryPaseo },
): Promise<{ agents: AgentNode[] }> {
  const all = await listAllAgents((options) => deps.paseo.agents.list(options), {
    includeArchived: false,
  });
  const inWorkspace = all.filter(
    (agent) => agent.workspaceId === input.workspaceId && !agent.archivedAt,
  );

  // Roots: every agent with a paseo-bm role, by label or by provider, and — as
  // before delta 20260918g — any agent carrying a `bm.role` label at all.
  const members = new Set(
    inWorkspace
      .filter((agent) => roleOfAgent(agent) !== null || agent.labels[MANAGER_ROLE_LABEL] !== undefined)
      .map((a) => a.id),
  );
  // Pull in descendants until the set stops growing (depth is small; bounded by n passes).
  for (let grew = true; grew; ) {
    grew = false;
    for (const agent of inWorkspace) {
      const parent = agent.labels[PARENT_AGENT_LABEL];
      if (!members.has(agent.id) && parent !== undefined && members.has(parent)) {
        members.add(agent.id);
        grew = true;
      }
    }
  }

  const agents = inWorkspace
    .filter((agent) => members.has(agent.id))
    .sort(oldestFirst)
    .map((agent): AgentNode => {
      const parent = agent.labels[PARENT_AGENT_LABEL];
      return {
        id: agent.id,
        role: roleOf(agent),
        title: agent.title,
        status: agent.status,
        parentId: parent !== undefined && members.has(parent) ? parent : null,
        updatedAt: agent.updatedAt,
        labelled: roleOfAgent(agent)?.labelled ?? false,
      };
    });
  return { agents };
}
