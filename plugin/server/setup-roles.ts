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
 * The texts were first written by the retired installer, whose source now
 * lives only at the `v0.4.0` tag (ADR-022 decision 1); this module is their one
 * copy in the repository. The Orchestrator came after the installer retired.
 */

import { DashboardError } from "../shared/contracts";
import { fallbackAliasOf } from "../shared/fallback";
import { modelFamily } from "../shared/model-family";
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
    "It reads the projects' work and asks you in the Inbox, each option with its next step ready; it tells a Manager what to do itself only " +
    "where you delegated it or on your word in its chat, and assesses a project's workflow when asked; it edits nothing and never creates or stops an agent.",
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
  /**
   * The Reviewer's provider and model, only when this call created it on
   * another model family's provider than `baseProvider` (autonomy design §C.5).
   */
  reviewer?: { baseProvider: string; model: string };
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
 * The providers a missing role may be created on: those Paseo reports as
 * available that are not one of our own aliases, in Paseo's own order. The
 * first is the one every role gets, the Reviewer aside (`independentReviewer`).
 *
 * Deliberately not sorted and deliberately not "the one the user used last":
 * this is the retired installer's rule (its `defaultProvider`), and matching it
 * is what makes a machine set up by the plugin identical to one set up by that
 * installer. Unlike it, a machine with nothing available
 * fails instead of pointing a role at a provider that cannot run.
 */
async function availableBaseProviders(paseo: unknown): Promise<string[]> {
  const available = await availableProviders(paseo);
  const bases = available === null ? [] : [...available].filter((id) => !isRoleAlias(id));
  if (bases.length === 0) throw failed("Paseo reports no available provider");
  return bases;
}

/** The first model Paseo lists for `provider`, or `null` when it lists none or cannot say. Never throws. */
async function firstListedModel(paseo: unknown, provider: string): Promise<string | null> {
  const providers = (paseo as { providers?: { listModels?: unknown } } | null | undefined)?.providers;
  const listModels = providers?.listModels;
  if (typeof listModels !== "function") return null;
  let result: { models?: unknown } | null | undefined | typeof TIMED_OUT;
  try {
    result = await withTimeout(listModels.call(providers, provider) as Promise<{ models?: unknown }>);
  } catch {
    return null;
  }
  if (result === TIMED_OUT || !Array.isArray(result?.models)) return null;
  for (const entry of result.models as Array<{ id?: unknown }>) {
    const id = nonEmpty(entry?.id);
    if (id !== null) return id;
  }
  return null;
}

/** `firstListedModel` read once per provider in one `ensureRoles` call. */
function modelLookup(paseo: unknown): (provider: string) => Promise<string | null> {
  const seen = new Map<string, Promise<string | null>>();
  return (provider) => {
    let found = seen.get(provider);
    if (found === undefined) {
      found = firstListedModel(paseo, provider);
      seen.set(provider, found);
    }
    return found;
  };
}

/** The first model Paseo lists for `provider`; a coded failure when there is none. */
async function firstModelOf(modelOf: (provider: string) => Promise<string | null>, provider: string): Promise<string> {
  const model = await modelOf(provider);
  if (model === null) throw failed(`Paseo lists no model for ${provider}`);
  return model;
}

/**
 * Where a new Reviewer runs so its review is independent (autonomy design
 * §C.5, REQ-133): the first available base provider, in Paseo's order, whose
 * family (`modelFamily`) differs from the Worker's, with that provider's first
 * model. `null` — the Reviewer then gets the default provider, like every
 * other role — when the Worker's family cannot be told or no other family is
 * signed in ("signed in" = listed `available: true`, §C.6). A provider whose
 * models cannot be read is passed over.
 */
async function independentReviewer(
  bases: readonly string[],
  workerFamily: string | null,
  modelOf: (provider: string) => Promise<string | null>,
): Promise<{ provider: string; model: string } | null> {
  if (workerFamily === null) return null;
  for (const provider of bases) {
    // Claude Code and Codex are known without reading their models.
    if (modelFamily(provider, null) === workerFamily) continue;
    const model = await modelOf(provider);
    if (model === null) continue;
    const family = modelFamily(provider, model);
    if (family !== null && family !== workerFamily) return { provider, model };
  }
  return null;
}

/**
 * Creates whatever of the four roles is missing, with the installer's
 * defaults, and records that it did.
 *
 * A role counts as missing when EITHER its provider alias or its agent profile
 * is absent: half an entry is what a hand-edited config or an interrupted
 * uninstall leaves, and a profile without its alias cannot start an agent.
 *
 * Every role is created on the first available provider, except a Reviewer
 * created whole while another family is signed in: that one goes to the first
 * provider of a family other than the Worker's (`independentReviewer`). The
 * result's and the setup state's `baseProvider` / `model` stay the default's;
 * their `reviewer` names the Reviewer's own, only when it differs.
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

  const hasAlias = (id: string) => Object.prototype.hasOwnProperty.call(providers, id);
  const profileOf = (id: string) => profiles.find((entry) => entry?.id === id);
  const modelOf = modelLookup(paseo);
  const bases = await availableBaseProviders(paseo);
  const baseProvider = bases[0]!;
  const model = await firstModelOf(modelOf, baseProvider);

  // Only a Reviewer created whole — neither its alias nor its profile there —
  // moves to another family (autonomy design §C.5): a half that exists is the
  // user's, and a new alias on another vendor under an existing profile would
  // pair it with a model that provider does not run.
  let reviewer: { provider: string; model: string } | null = null;
  const reviewerId = roleId("reviewer");
  if (missing.includes("reviewer") && !hasAlias(reviewerId) && profileOf(reviewerId) === undefined) {
    // The Worker as it runs once this call is done: its alias's base, else the
    // default it is about to get; its profile's model, else the one it gets.
    const workerId = roleId("worker");
    const workerBase = hasAlias(workerId) ? nonEmpty((providers[workerId] as { extends?: unknown } | undefined)?.extends) : baseProvider;
    const workerProfile = profileOf(workerId);
    const workerModel =
      workerProfile !== undefined ? nonEmpty(workerProfile["model"]) : workerBase === null ? null : await modelOf(workerBase);
    reviewer = await independentReviewer(bases, modelFamily(workerBase, workerModel), modelOf);
  }

  const wanted: Record<string, { alias: Record<string, unknown>; profile: Record<string, unknown> }> = {};
  for (const role of missing) {
    const id = roleId(role);
    if (role === "reviewer" && reviewer !== null) {
      wanted[id] = { alias: roleAliasEntry(role, reviewer.provider), profile: roleProfileEntry(role, reviewer.model) };
      continue;
    }
    // A role that has its alias but not its profile keeps the provider it is
    // already pointed at: the user may have moved it, and only the missing
    // half is ours to invent.
    const existingBase = nonEmpty((providers[id] as { extends?: unknown } | undefined)?.extends);
    const profileModel = existingBase === null ? model : await firstModelOf(modelOf, existingBase);
    wanted[id] = { alias: roleAliasEntry(role, baseProvider), profile: roleProfileEntry(role, profileModel) };
  }

  const result = await createRoleEntries(paseo as ConfigPaseo, wanted);
  if (result.created.length === 0) return nothing;

  const created = missing.filter((role) => result.created.includes(roleId(role)));
  // Recorded only when the Reviewer really runs elsewhere: the defaults'
  // sentence then names it (`rolesDefaultsText`).
  const apart =
    reviewer !== null && created.includes("reviewer") && (reviewer.provider !== baseProvider || reviewer.model !== model)
      ? { baseProvider: reviewer.provider, model: reviewer.model }
      : null;
  const reviewerField = apart === null ? {} : { reviewer: apart };
  const at = new Date().toISOString();
  // `rolesCreated.roles` keeps to the three roles an older release can parse:
  // 0.4.1 reads the whole file with a three-role enum, and one unknown value
  // there would make it drop `agentTools` and `cleanedUpAt` with it. The
  // Orchestrator gets its own field, which an older release ignores
  // (orchestrator design §3.2, §10).
  const mains = created.filter((role): role is SetupRoleName => (SETUP_ROLE_NAMES as readonly string[]).includes(role));
  const record: Partial<SetupState> = {};
  if (mains.length > 0) record.rolesCreated = { at, roles: mains, baseProvider, model, ...reviewerField };
  if (created.includes("orchestrator")) record.orchestratorCreatedAt = at;
  try {
    updateSetupState(record, deps);
  } catch (error) {
    // The configuration is already right; losing the note only costs Setup a
    // sentence about the defaults it used.
    log(`[paseo-bm] could not record the roles it created: ${error instanceof Error ? error.message : String(error)}`);
  }
  const together = created.filter((role) => apart === null || role !== "reviewer").map(roleId);
  const parts = [
    ...(together.length > 0 ? [`${together.join(", ")} on ${baseProvider} · ${model}`] : []),
    ...(apart === null ? [] : [`${reviewerId} on ${apart.baseProvider} · ${apart.model}`]),
  ];
  log(`[paseo-bm] created roles ${parts.join("; ")}`);
  return { created, baseProvider, model, ...reviewerField, skipped: null };
}
