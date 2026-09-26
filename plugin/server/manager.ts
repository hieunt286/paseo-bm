/**
 * `manager.ensure` on the daemon side (WP-112, Technical Design §7.3).
 *
 * One Manager per workspace: look the live Manager up by its `bm.role=manager`
 * label BEFORE creating anything; when there is none, create one from the
 * `bm-manager` agent profile with the instructions in `roles/manager.md` and the
 * labels `bm.role=manager` + `bm.version=<plugin version>`. A Manager another
 * Manager replaced does not count (delta 20260921 §4.5.2), and `createManager`
 * is the one code path that creates a Manager, for `manager.ensure` and for a
 * replacement alike.
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
import { AUTO_APPROVE_FEATURE, capabilityOf, featuresFor, managerModeFor, modesFor, runPostureOf } from "./role-mode";
import { workspaceDirectory, type DashboardPaseo } from "./dashboard-rpc";
import { readIncidents } from "./fallback-state";
import { dataHomeOf } from "./role-extras";
import { ensureRoles, type EnsureRolesResult } from "./setup-roles";
import { recordTools } from "./tools-check";

/** Label key and value that identify a paseo-bm Manager (Technical Design §7.1). */
export const MANAGER_ROLE_LABEL = "bm.role";
export const MANAGER_ROLE_VALUE = "manager";
export const VERSION_LABEL = "bm.version";

/**
 * "paseo-bm already set this Manager's mode", with the mode as its value
 * (delta 20260918 §4.1). A Manager that carries it is never switched again, so
 * a mode the user picks by hand afterwards is respected (owner decision Q36).
 */
export const MODE_SET_LABEL = "bm.modeSet";

/** Label on an agent another agent replaced, with the replacement's id (delta 20260921 §4.4.8, §4.5.2). */
const REPLACED_BY_LABEL = "bm.replacedBy";

/** Agent profile id registered by the installer (ADR-006, WP-107). */
export const MANAGER_PROFILE_ID = "bm-manager";

/** Title given to a freshly created Manager. */
export const MANAGER_TITLE = "Beads Manager";

/**
 * Error codes this RPC can report. Taken from the single Phase 1 registry in
 * Technical Design §4.4 (no code is minted in place); §7.3 names `E_PROVIDER_UNAVAILABLE`.
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
  /** The agent's feature values, when the snapshot carries them (`auto_accept` on OpenCode). */
  features?: ReadonlyArray<{ id?: string; value?: unknown }>;
  /** What the agent's provider supports; `supportsMcpServers: false` means no Paseo tools (delta 20260921 §4.2.4). */
  capabilities?: { supportsMcpServers?: unknown } | null;
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
          /** The agent's first message (a replacement Manager's `BM-HANDOVER`, delta 20260921 §4.5.2). */
          prompt?: string;
        }): Promise<ManagerAgentHandle>;
      };
    };
  };
  config: {
    get(): Promise<{
      config: {
        agentProfiles?: ManagerAgentProfile[];
        /** Read by `ensureRoles` (0.4.0) to see which roles are missing. */
        providers?: Record<string, unknown> | null;
        /** Paseo's agent-tools switch; `false` is what the setup notice reports. */
        mcp?: { injectIntoAgents?: unknown };
      };
    }>;
    /** Used only by `ensureRoles` to create a missing role (design §7.13.2). */
    patch?(patch: Record<string, unknown>): Promise<unknown>;
  };
  /**
   * Absent on a host that cannot list modes; the Manager then gets no mode of
   * ours. `listAvailable` and `listModels` are what `ensureRoles` picks a new
   * role's provider and model from.
   */
  providers?: {
    listModes?(provider: string, options?: { cwd?: string }): Promise<unknown>;
    listAvailable?(): Promise<unknown>;
    listModels?(provider: string): Promise<unknown>;
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
  /**
   * The workspace's directory, needed to read an untiered provider's features
   * (delta 20260921 §4.2.2). Defaults to the directory Paseo lists for it.
   */
  workspaceDirectory?: (workspaceId: string) => Promise<string | null>;
  /**
   * The data folder, whose `role-fallback-state.json` names the replaced
   * Managers (delta 20260921 §4.5.2); `null` means none. Looked up when absent;
   * tests pass one.
   */
  home?: string | null;
}

export interface EnsureManagerResult {
  agentId: string;
  created: boolean;
  /**
   * Other live Managers found in the same workspace, newest first, never a
   * replaced one. Reported so the panel can tell the user (Technical Design §7.3); never
   * deleted or archived here.
   */
  otherManagerIds: string[];
  /**
   * Why an existing Manager was not switched to its mode, or `null` when there
   * was nothing to say (delta 20260918 §4.1). Never blocks returning the Manager.
   */
  modeNotice: string | null;
  /**
   * Set when the Manager just created has no Paseo tools (Pi without
   * pi-mcp-adapter), so it cannot create or message a Worker (delta 20260921
   * §4.2.4); `null` otherwise, and always for an existing Manager.
   */
  toolsNotice: string | null;
  /**
   * What this machine still needs, in one line: the roles this call created
   * with defaults, and Paseo's agent-tools switch being off (design §7.3).
   * `null` when there is nothing to say, which is the usual case.
   */
  setupNotice: string | null;
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
 *
 * A replaced Manager is left out (delta 20260921 §4.5.2): it carries
 * `bm.replacedBy`, or — when labelling it failed — it is the `agentId` of a
 * `switched` Manager incident. So `manager.ensure` opens the replacement and
 * never reports the old one, which stays alive until the user archives it
 * (ADR-005). The incidents are only read when a live Manager is found.
 */
export async function findLiveManagers(
  paseo: ManagerPaseo,
  workspaceId: string,
  lookup: { home?: string | null; log?: (message: string) => void } = {},
): Promise<ManagerAgentSnapshot[]> {
  const all = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
  const live = all.filter(
    (agent) =>
      agent.workspaceId === workspaceId &&
      roleOfAgent(agent)?.role === "manager" &&
      isLive(agent) &&
      agent.labels?.[REPLACED_BY_LABEL] === undefined,
  );
  const replaced = live.length === 0 ? new Set<string>() : replacedManagerIds(lookup);
  return live
    .filter((agent) => !replaced.has(agent.id))
    .sort((a, b) => Number(labelledManager(b)) - Number(labelledManager(a)) || newestFirst(a, b));
}

/**
 * The `agentId` of every `switched` Manager incident in the data folder's
 * `role-fallback-state.json` (delta 20260921 §4.5.2). Empty when there is no
 * data folder or the file cannot be used; the `bm.replacedBy` label still
 * applies then. Never throws.
 */
function replacedManagerIds(lookup: { home?: string | null; log?: (message: string) => void }): Set<string> {
  try {
    const home = lookup.home !== undefined ? lookup.home : dataHomeOf();
    if (home === null) return new Set();
    return new Set(
      readIncidents(home, lookup.log)
        .incidents.filter((incident) => incident.role === "manager" && incident.status === "switched")
        .map((incident) => incident.agentId),
    );
  } catch {
    return new Set();
  }
}

/** The workspace's directory for a features lookup, or `null`. Never throws. */
async function directoryOf(deps: EnsureManagerDeps, workspaceId: string): Promise<string | null> {
  try {
    return deps.workspaceDirectory !== undefined
      ? await deps.workspaceDirectory(workspaceId)
      : await workspaceDirectory(deps.paseo as unknown as DashboardPaseo, workspaceId);
  } catch {
    return null;
  }
}

function providerSelection(profile: ManagerAgentProfile): string {
  return profile.model ? `${profile.provider}/${profile.model}` : profile.provider;
}

/** The snapshot of a just-created agent says its provider could not start. */
function startedBroken(snapshot: ManagerAgentSnapshot | null): boolean {
  return snapshot !== null && (snapshot.status === "error" || snapshot.providerUnavailable === true);
}

/**
 * Creates whatever of the three roles is missing, and turns every failure into
 * the one error this RPC speaks.
 *
 * A failure here stops the Manager being created on purpose: without its
 * profile there is nothing to create, and a half-set-up machine that silently
 * produced an agent on some other provider would be worse than a sentence
 * telling the user where to look.
 */
async function ensureRolesFor(paseo: ManagerPaseo, log?: (message: string) => void): Promise<EnsureRolesResult> {
  let ensured: EnsureRolesResult;
  try {
    ensured = await ensureRoles(paseo, log === undefined ? {} : { log });
  } catch (error) {
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      `paseo-bm could not create its roles (${error instanceof Error ? error.message : String(error)}). Open Beads Manager → Setup to see what is missing.`,
    );
  }
  if (ensured.skipped === "cleaned-up") {
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      'paseo-bm\'s settings were removed. Open Beads Manager → Setup and choose "Set up again", or remove the plugin with: paseo plugin remove paseo-bm',
    );
  }
  return ensured;
}

/**
 * The one line the launcher shows under the Manager, or `null`.
 *
 * Two sentences, in this order, each only when it is true. The roles sentence
 * is about what THIS call just did; the agent-tools one is checked on every
 * call, because the switch is Paseo's and the user can turn it off at any time
 * — and with it off the Manager cannot create a Worker at all.
 */
async function setupNoticeFor(paseo: ManagerPaseo, ensured: EnsureRolesResult): Promise<string | null> {
  const sentences: string[] = [];
  if (ensured.created.length > 0 && ensured.baseProvider !== null && ensured.model !== null) {
    sentences.push(
      `paseo-bm created its roles with defaults (${ensured.baseProvider} · ${ensured.model}). Change them in Setup → Agents.`,
    );
  }
  if (await agentToolsOff(paseo)) {
    sentences.push("Paseo's agent tools are off, so the Manager may not be able to create a Worker. Allow them in Setup.");
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}

/**
 * Why no new Manager was created. It names the button because the error line
 * is drawn above the Setup screen that holds it.
 */
export const AGENT_TOOLS_OFF_MESSAGE =
  "Paseo's agent tools are off, and a Beads Manager created now would never get them, so it could not create a Worker. " +
  'Press "Allow agent tools…" in Setup, then open Beads Manager again.';

/** True only when Paseo says the switch is off; a config it cannot read says nothing. */
async function agentToolsOff(paseo: ManagerPaseo): Promise<boolean> {
  try {
    const { config } = await paseo.config.get();
    return (config as { mcp?: { injectIntoAgents?: unknown } }).mcp?.injectIntoAgents === false;
  } catch {
    return false;
  }
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

  // Opening the Manager is one of the two moments a machine gets set up (the
  // other is the Setup screen). The plugin has no install hook — `contribute()`
  // has no Paseo handle — so this is where a paseo.cafe install gets its roles.
  const ensured = await ensureRolesFor(paseo, deps.log);

  const [chosen, ...others] = await findLiveManagers(paseo, workspaceId, { home: deps.home, log: deps.log });
  if (chosen) {
    return {
      agentId: chosen.id,
      created: false,
      otherManagerIds: others.map((agent) => agent.id),
      // A Manager recognised only by its provider was created by the user in a
      // mode they chose: paseo-bm never switches it (delta 20260918g §4.3).
      modeNotice: labelledManager(chosen) ? await switchOnce(chosen, deps) : null,
      toolsNotice: null,
      setupNotice: await setupNoticeFor(paseo, ensured),
    };
  }

  // A Manager gets Paseo's tools when it is created, never later: one created
  // while the switch is off keeps working without `create_agent` even after the
  // user allows them, and only the user may archive it. So none is created
  // until the switch is on; an existing Manager is still opened above.
  if (await agentToolsOff(paseo)) {
    throw new ManagerEnsureError("E_PROVIDER_UNAVAILABLE", AGENT_TOOLS_OFF_MESSAGE);
  }

  const { config } = await paseo.config.get();
  const profile = config.agentProfiles?.find((entry) => entry.id === MANAGER_PROFILE_ID);
  if (!profile) {
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      `agent profile "${MANAGER_PROFILE_ID}" is not registered on this daemon; open Beads Manager → Setup to see what is missing.`,
    );
  }

  // The provider's no-prompt mode unless the profile names its own (delta
  // 20260918 §4.1). `modesFor` is raced against 5 s and logs every miss; a miss
  // creates the Manager exactly as before, without the label, so the next open
  // can still switch it.
  const provider = providerId(profile.provider) ?? profile.provider;
  const modes = await modesFor(paseo, provider, deps.log);
  const capability = capabilityOf(modes);
  let chosenMode: string | undefined;
  let modeId: string | undefined;
  let featureValues = profile.featureValues;
  if (capability === "untiered" || capability === "none") {
    // Delta 20260921 §4.2.2: OpenCode (untiered) gets a listed mode — the
    // profile's, else the first — and auto-approve on unless the profile sets
    // it; Pi (none) gets neither.
    const features =
      capability === "untiered"
        ? await featuresFor(paseo, providerSelection(profile), (await directoryOf(deps, workspaceId)) ?? undefined, deps.log)
        : null;
    const posture = runPostureOf("manager", capability, modes ?? [], features, profile.modeId ?? null, {
      ...(profile.featureValues !== undefined ? { featureValues: profile.featureValues } : {}),
    });
    chosenMode = posture?.modeId ?? undefined;
    modeId = chosenMode;
    // `null` removes the key: a Manager on a provider without modes (Pi) gets no
    // mode and no feature, even when its profile sets them (review b4).
    if (posture?.featureValues === null) featureValues = undefined;
    else if (posture?.featureValues !== undefined) featureValues = posture.featureValues;
  } else {
    chosenMode = modes === null ? undefined : managerModeFor(modes, profile.modeId ?? null);
    // Modes unknown: exactly as before this delta. Modes known: only a mode the
    // provider lists — a profile mode it does not list would make the creation fail.
    modeId = modes === null ? profile.modeId : chosenMode;
  }
  if (capability === "tiered" && chosenMode === undefined) {
    (deps.log ?? ((message: string) => console.warn(message)))(
      `[paseo-bm] ${provider} lists no mode that runs without permission prompts${
        profile.modeId === undefined ? "" : `, nor the profile's own mode "${profile.modeId}"`
      }; the Manager starts in the provider's default mode.`,
    );
  }

  const created = await createManager(paseo, workspaceId, {
    providerSelection: providerSelection(profile),
    modeId,
    thinkingOptionId: profile.thinkingOptionId,
    featureValues,
    labels: chosenMode !== undefined ? { [MODE_SET_LABEL]: chosenMode } : {},
    readInstructions: deps.readInstructions,
    version: deps.version,
  });
  return {
    agentId: created.agentId,
    created: true,
    otherManagerIds: [],
    modeNotice: null,
    toolsNotice: created.toolsNotice,
    setupNotice: await setupNoticeFor(paseo, ensured),
  };
}

/** What `createManager` creates; the caller has already decided the provider, mode and thinking. */
export interface CreateManagerOptions extends Pick<EnsureManagerDeps, "readInstructions" | "version"> {
  /** `provider/model`: `bm-manager/<model>` from the profile, or `bm-manager-fallback-<n>/<model>` for a replacement. */
  providerSelection: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  /**
   * Added to `bm.role=manager` and `bm.version`: `bm.modeSet` when paseo-bm
   * chose the mode (not for a profile mode passed on unchecked), `bm.replaces`
   * for a replacement (delta 20260921 §4.5.2).
   */
  labels: Record<string, string>;
  /** The Manager's first message: a replacement's `BM-HANDOVER`. None when absent. */
  prompt?: string;
}

export interface CreateManagerResult {
  agentId: string;
  /** As `EnsureManagerResult.toolsNotice`. */
  toolsNotice: string | null;
}

/**
 * Creates a Manager in the workspace: the one code path for `manager.ensure`
 * and for a replacement Manager (delta 20260921 §4.5.2), so both get the same
 * instructions and Runtime facts (`readInstructions`), the same labels and the
 * same `toolsNotice`.
 *
 * Throws `ManagerEnsureError` (`E_PROVIDER_UNAVAILABLE`) when the SDK rejects
 * the create, or when the created agent comes back already failed (then that
 * exact agent is archived before throwing).
 */
export async function createManager(
  paseo: ManagerPaseo,
  workspaceId: string,
  options: CreateManagerOptions,
): Promise<CreateManagerResult> {
  const { providerSelection: selection, modeId, thinkingOptionId, featureValues, prompt } = options;
  const systemPrompt = await options.readInstructions();
  // `manager.ensure` names the profile, as it always has; a replacement names its provider.
  const alias = providerId(selection) ?? selection;
  const source = alias === MANAGER_PROFILE_ID ? `profile "${MANAGER_PROFILE_ID}"` : `provider "${selection}"`;

  let handle: ManagerAgentHandle;
  try {
    handle = await paseo.workspaces.ref(workspaceId).agents.create({
      config: {
        provider: selection,
        ...(modeId !== undefined ? { modeId } : {}),
        ...(thinkingOptionId !== undefined ? { thinkingOptionId } : {}),
        ...(featureValues !== undefined ? { featureValues } : {}),
        systemPrompt,
      },
      title: MANAGER_TITLE,
      labels: {
        [MANAGER_ROLE_LABEL]: MANAGER_ROLE_VALUE,
        [VERSION_LABEL]: options.version ?? PLUGIN_VERSION,
        ...options.labels,
      },
      ...(prompt !== undefined ? { prompt } : {}),
    });
  } catch (cause) {
    throw new ManagerEnsureError(
      "E_PROVIDER_UNAVAILABLE",
      `could not create the Manager with ${source}: ${cause instanceof Error ? cause.message : String(cause)}`,
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

  // Delta 20260921 §4.2.4: a Manager without Paseo tools cannot run a request.
  const supports = snapshot?.capabilities?.supportsMcpServers;
  recordTools("manager", handle.id, selection, supports);
  const toolsNotice =
    supports === false
      ? `This Manager runs on ${selection} without Paseo tools (on Pi this means pi-mcp-adapter is missing): it cannot create or message a Worker.`
      : null;
  return { agentId: handle.id, toolsNotice };
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
    const provider = providerId(profile.provider) ?? profile.provider;
    const modes = await modesFor(deps.paseo, provider, deps.log);
    if (capabilityOf(modes) === "untiered") {
      // The plugin cannot change the features of an existing agent (proposal
      // S9), so auto-approve cannot be turned on here (delta 20260921 §4.2.2).
      const autoApprove = manager.features?.find((feature) => feature?.id === AUTO_APPROVE_FEATURE)?.value === true;
      return autoApprove
        ? null
        : `This Manager runs on ${provider} and was created before paseo-bm could turn on auto-approve for it; it may ask for permissions. Start a new Manager to run without prompts.`;
    }
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
// `agents.list` (WP-112, Technical Design §7.3, REQ-025a)
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
  deps: {
    paseo: AgentDirectoryPaseo;
    /** Agent id → its replacement, from `switched` fallback incidents (delta 20260921 §4.4.8). */
    replacements?: ReadonlyMap<string, string>;
  },
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
        replacedBy: agent.labels["bm.replacedBy"] ?? deps.replacements?.get(agent.id) ?? null,
      };
    });
  return { agents };
}
