/**
 * The four roles the plugin creates, and what it creates them with
 * (Technical Design §6.1, §7.13.2; ADR-012 decision 4; the fourth,
 * `orchestrator`, from orchestrator design §3.1).
 *
 * Until 0.3.x only the installer wrote these entries, so a user who installed
 * straight from paseo.cafe got the screens and no roles at all: the Manager
 * could not create a Worker. ADR-012 lifts ADR-008 decision 2 — the plugin may
 * now create the three main roles — and this module holds the values it creates
 * them with, which are exactly the installer's defaults so a machine set up
 * either way ends up the same.
 *
 * The texts are duplicated from `src/roles/register.ts` rather than imported:
 * the plugin bundle never pulls in `src/` (it is a separate npm package). A
 * test keeps the two copies identical for as long as both exist; the CLI's copy
 * goes when its role code does. The Orchestrator came after the installer
 * retired, so its texts exist here only.
 */

import { DashboardError } from "../shared/contracts";
import { fallbackAliasOf } from "../shared/fallback";
import { applyRoleToolPolicies, createRoleEntries, type ConfigPaseo } from "./config-writer";
import { availableProviders, isRoleAlias, nonEmpty } from "./role-choices";
import { TIMED_OUT, withTimeout } from "./role-mode";
import { SETUP_ROLE_NAMES, readSetupState, updateSetupState, type SetupRoleName, type SetupState, type SetupStateDeps } from "./setup-state";

/** The four roles, in the order Setup lists them. */
export const ROLE_NAMES = ["manager", "worker", "reviewer", "orchestrator"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** `bm-manager`, `bm-worker`, `bm-reviewer`, `bm-orchestrator` — the alias and profile id of a role. */
export const roleId = (role: RoleName): string => `bm-${role}`;

/** Agent names, matching the names used throughout the documentation. */
export const ROLE_DISPLAY_NAMES: Readonly<Record<RoleName, string>> = {
  manager: "Beads Manager",
  worker: "Beads Worker",
  reviewer: "Beads Reviewer",
  orchestrator: "Beads Orchestrator",
};

/** What the profile says about the role in Paseo's own Agents tab. */
export const ROLE_PROFILE_NOTES: Readonly<Record<RoleName, string>> = {
  manager:
    "paseo-bm Manager — the agent you talk to. It delegates every request to a Beads Worker " +
    "and reports progress back; it does not do the work itself and never archives or deletes an agent.",
  worker:
    "paseo-bm Worker — does the work in the repository, sized to the request: a small change is made and " +
    "checked directly; larger work gets beads, documents where needed and a Beads Reviewer. " +
    "It commits or pushes only when the user asks.",
  reviewer:
    "paseo-bm Reviewer — read-only review of the batch of changes just made. It reports findings " +
    "by severity, does not edit anything, and must never create or stop an agent.",
  orchestrator:
    "paseo-bm Orchestrator — one coordinator for every paseo-bm project, opened from the Inbox of Beads Manager. " +
    "It reads the projects' work and asks you in the Inbox, each option with its next step ready; it tells a Manager what to do itself only on " +
    "Autopilot or your word in its chat, and assesses a project's workflow when asked; it edits nothing and never creates or stops an agent.",
};

/**
 * Whether the role's agents get any of Paseo's agent tools.
 *
 * ADR-006 decision 3: the Manager and the Worker create and message agents, the
 * Reviewer must not, and neither may the Orchestrator (orchestrator design
 * §3.1). What each gets exactly is `rolePaseoToolsPolicy`.
 */
export const roleGrantsPaseoTools = (role: RoleName): boolean => role === "manager" || role === "worker";

/**
 * The Paseo tools a Manager never gets (autonomy design §A.10, REQ-116): stopping,
 * archiving or re-moding an agent, answering permission prompts, and every
 * schedule and heartbeat. Names are Paseo 0.9.2's (`paseo-tools.js`). Nothing
 * the Manager's instructions use is here: it keeps create_agent,
 * send_agent_prompt, get_agent_status, get_agent_activity, list_agents,
 * list_profiles and cancel_agent.
 */
export const MANAGER_DISABLED_PASEO_TOOLS: readonly string[] = [
  "kill_agent",
  "archive_agent",
  "archive_workspace",
  "respond_to_permission",
  "list_pending_permissions",
  "set_agent_mode",
  "update_agent",
  "create_schedule",
  "update_schedule",
  "delete_schedule",
  "run_schedule_once",
  "pause_schedule",
  "resume_schedule",
  "create_heartbeat",
  "delete_heartbeat",
];

/** The Worker's list: the Manager's, plus making or renaming a workspace. */
export const WORKER_DISABLED_PASEO_TOOLS: readonly string[] = [...MANAGER_DISABLED_PASEO_TOOLS, "create_workspace", "rename_workspace"];

/** Paseo's per-provider tool policy (`agents.providers.<id>.paseoTools`). */
export interface PaseoToolsPolicy {
  enabled: boolean;
  disabledTools?: string[];
}

/**
 * The `paseoTools` policy a role's alias carries (autonomy design §A.10).
 *
 * Always written, never omitted: Paseo 0.9.2 treats a missing policy as enabled
 * while `daemon.mcp.injectIntoAgents` is on (`isPaseoToolEnabled`), so an alias
 * without the key hands its agents every Paseo tool. This supersedes ADR-006
 * decision 3's "omitted rather than false" for the Reviewer.
 */
export function rolePaseoToolsPolicy(role: RoleName): PaseoToolsPolicy {
  if (role === "manager") return { enabled: true, disabledTools: [...MANAGER_DISABLED_PASEO_TOOLS] };
  if (role === "worker") return { enabled: true, disabledTools: [...WORKER_DISABLED_PASEO_TOOLS] };
  return { enabled: false };
}

/**
 * The policy a `bm-*` alias must carry: a main role's (`bm-worker`) or a
 * fallback alias's (`bm-worker-fallback-2` runs a Worker), or `null` for any
 * other `bm-*` id, which is not ours to limit.
 */
export function paseoToolsPolicyOfAlias(id: string): PaseoToolsPolicy | null {
  const main = ROLE_NAMES.find((role) => roleId(role) === id);
  if (main !== undefined) return rolePaseoToolsPolicy(main);
  const fallback = fallbackAliasOf(id);
  return fallback === null ? null : rolePaseoToolsPolicy(fallback.role);
}

/** The base provider and model a role is created on. */
export interface RoleDefault {
  baseProvider: string;
  model: string;
}

/** The provider alias for a role: its base provider, its label and its Paseo-tools policy. */
export function roleAliasEntry(role: RoleName, baseProvider: string): Record<string, unknown> {
  return { extends: baseProvider, label: ROLE_DISPLAY_NAMES[role], paseoTools: rolePaseoToolsPolicy(role) };
}

/**
 * The agent profile for a role.
 *
 * `modeId` and `thinkingOptionId` are deliberately not written: Paseo treats
 * them as optional, nothing here asks the user for either, and writing one
 * would claim a choice nobody made. A value the user sets later is kept,
 * because creation only ever runs for a role that has no profile at all.
 */
export function roleProfileEntry(role: RoleName, model: string): Record<string, unknown> {
  const id = roleId(role);
  return { id, name: ROLE_DISPLAY_NAMES[role], provider: id, model, notes: ROLE_PROFILE_NOTES[role] };
}

// ---------------------------------------------------------------------------
// `ensureRoles` — the lazy first-use setup (design §7.13.2).
// ---------------------------------------------------------------------------

/**
 * `ensureRoles` runs on every Setup open and on every `manager.ensure`, because
 * the plugin has no install hook: `contribute()` has no Paseo handle, so there
 * is no moment at load time when the roles could be created. It is therefore
 * written to do nothing at all — not one patch — on the overwhelmingly common
 * path where the four roles are already there with their Paseo-tools policy.
 * It is also how a machine set up by 0.4.x gets the Orchestrator: of the three
 * roles it has only `paseoTools` changes (autonomy design §A.10) and only the
 * missing fourth is created (orchestrator design §3.1, REQ-077e).
 */
export interface EnsureRolesResult {
  /** The role ids created, empty when there was nothing to do. */
  created: RoleName[];
  baseProvider: string | null;
  model: string | null;
  /** `"cleaned-up"` when the user removed paseo-bm's settings and has not resumed. */
  skipped: "cleaned-up" | null;
}

export interface EnsureRolesDeps extends SetupStateDeps {
  log?: (line: string) => void;
  /** Cleared when the user resumes; see `markCleanedUpThisRun`. */
  resume?: boolean;
}

/**
 * Set by `setup.cleanup` for the rest of this plugin run.
 *
 * `cleanedUpAt` in the state file is the durable mark, but the file lives in
 * the data folder the user may have just asked to delete. This flag is what
 * stops a reload-free second call from recreating what was removed a second
 * ago (REQ-012 e).
 */
let cleanedUpThisRun = false;

export function markCleanedUpThisRun(value: boolean): void {
  cleanedUpThisRun = value;
}

function failed(detail: string, cause?: unknown): DashboardError {
  return new DashboardError("E_SETUP_ROLES_FAILED", detail, cause === undefined ? undefined : { cause });
}

/**
 * The provider a missing role is created on: the first one Paseo reports as
 * available that is not one of our own aliases, in Paseo's own order.
 *
 * Deliberately not sorted and deliberately not "the one the user used last":
 * this is the installer's rule (`src/roles/config.ts` `defaultProvider`), and
 * matching it is what makes a machine set up by the plugin identical to one set
 * up by the retired installer. Unlike it, a machine with nothing available
 * fails instead of pointing a role at a provider that cannot run.
 */
async function firstAvailableProvider(paseo: unknown): Promise<string> {
  const available = await availableProviders(paseo);
  const first = available === null ? undefined : [...available].find((id) => !isRoleAlias(id));
  if (first === undefined) throw failed("Paseo reports no available provider");
  return first;
}

/** The first model Paseo lists for `provider`. */
async function firstModelOf(paseo: unknown, provider: string): Promise<string> {
  const providers = (paseo as { providers?: { listModels?: unknown } } | null | undefined)?.providers;
  const listModels = providers?.listModels;
  const none = (): never => {
    throw failed(`Paseo lists no model for ${provider}`);
  };
  if (typeof listModels !== "function") return none();
  let result: { models?: unknown } | null | undefined | typeof TIMED_OUT;
  try {
    result = await withTimeout(listModels.call(providers, provider) as Promise<{ models?: unknown }>);
  } catch {
    return none();
  }
  if (result === TIMED_OUT || !Array.isArray(result?.models)) return none();
  for (const entry of result.models as Array<{ id?: unknown }>) {
    const id = nonEmpty(entry?.id);
    if (id !== null) return id;
  }
  return none();
}

/**
 * Creates whatever of the four roles is missing, with the installer's
 * defaults, and records that it did.
 *
 * A role counts as missing when EITHER its provider alias or its agent profile
 * is absent: half an entry is what a hand-edited config or an interrupted
 * uninstall leaves, and a profile without its alias cannot start an agent.
 */
export async function ensureRoles(paseo: unknown, deps: EnsureRolesDeps = {}): Promise<EnsureRolesResult> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const nothing: EnsureRolesResult = { created: [], baseProvider: null, model: null, skipped: null };

  if (deps.resume === true) {
    cleanedUpThisRun = false;
    try {
      if (readSetupState(deps).cleanedUpAt !== null) updateSetupState({ cleanedUpAt: null }, deps);
    } catch (error) {
      // The mark lives in the data folder; an unusable folder is Setup's
      // problem to show, and it cannot be the reason roles stay missing.
      log(`[paseo-bm] could not clear the cleanup mark: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    let cleanedUpAt: string | null = null;
    try {
      cleanedUpAt = readSetupState(deps).cleanedUpAt;
    } catch {
      // No readable state means no mark: a fresh machine must still get roles.
    }
    if (cleanedUpThisRun || cleanedUpAt !== null) return { ...nothing, skipped: "cleaned-up" };
  }

  // Every `bm-*` alias already there — main role or fallback — carries its
  // role's Paseo-tools policy (autonomy design §A.10). A patch only when one
  // differs, and it changes nothing but `paseoTools`; the roles created below
  // get the policy from `roleAliasEntry`.
  const policies = await applyRoleToolPolicies(paseo as ConfigPaseo, paseoToolsPolicyOfAlias);
  if (policies.updated.length > 0) log(`[paseo-bm] set the Paseo-tools policy of ${policies.updated.join(", ")}`);
  const { config } = policies;
  const providers = (config.providers ?? {}) as Record<string, unknown>;
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  const missing = ROLE_NAMES.filter((role) => {
    const id = roleId(role);
    return (
      !Object.prototype.hasOwnProperty.call(providers, id) || !profiles.some((entry) => entry?.id === id)
    );
  });
  if (missing.length === 0) return nothing;

  const baseProvider = await firstAvailableProvider(paseo);
  const model = await firstModelOf(paseo, baseProvider);

  const wanted: Record<string, { alias: Record<string, unknown>; profile: Record<string, unknown> }> = {};
  for (const role of missing) {
    const id = roleId(role);
    // A role that has its alias but not its profile keeps the provider it is
    // already pointed at: the user may have moved it, and only the missing
    // half is ours to invent.
    const existingBase = nonEmpty((providers[id] as { extends?: unknown } | undefined)?.extends);
    const profileModel = existingBase === null ? model : await firstModelOf(paseo, existingBase);
    wanted[id] = { alias: roleAliasEntry(role, baseProvider), profile: roleProfileEntry(role, profileModel) };
  }

  const result = await createRoleEntries(paseo as ConfigPaseo, wanted);
  if (result.created.length === 0) return nothing;

  const created = missing.filter((role) => result.created.includes(roleId(role)));
  const at = new Date().toISOString();
  // `rolesCreated.roles` keeps to the three roles an older release can parse:
  // 0.4.1 reads the whole file with a three-role enum, and one unknown value
  // there would make it drop `agentTools` and `cleanedUpAt` with it. The
  // Orchestrator gets its own field, which an older release ignores
  // (orchestrator design §3.2, §10).
  const mains = created.filter((role): role is SetupRoleName => (SETUP_ROLE_NAMES as readonly string[]).includes(role));
  const record: Partial<SetupState> = {};
  if (mains.length > 0) record.rolesCreated = { at, roles: mains, baseProvider, model };
  if (created.includes("orchestrator")) record.orchestratorCreatedAt = at;
  try {
    updateSetupState(record, deps);
  } catch (error) {
    // The configuration is already right; losing the note only costs Setup a
    // sentence about the defaults it used.
    log(`[paseo-bm] could not record the roles it created: ${error instanceof Error ? error.message : String(error)}`);
  }
  log(`[paseo-bm] created roles ${created.map(roleId).join(", ")} on ${baseProvider} · ${model}`);
  return { created, baseProvider, model, skipped: null };
}
