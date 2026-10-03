/**
 * `roles.settings`, `roles.options` and `roles.instructions`: the data of the
 * Roles & models section of Settings → Agents (delta 20260921 §4.3.2,
 * REQ-064 a/b; REQ-032 d). All three only read.
 *
 * - `roles.settings` describes the four roles from ONE `config.get()`. The
 *   SDK view is flat (design F12): `config.providers` is `agents.providers`,
 *   `config.agentProfiles` is `daemon.agentProfiles`. It hands the client the
 *   `revision` that `roles.save-settings` must send back.
 * - `roles.options` lists what the Edit form may offer for one BASE provider,
 *   from `providers.listModels`, `listModes`, `listFeatures` and `costOf`.
 * - `roles.instructions` shows what a new agent of a role is created with.
 *
 * Neither handler throws anything but a coded `DashboardError`: a lookup that
 * fails, times out or answers an `error` becomes an empty list or `unknown`
 * and costs one `console.warn` line starting `[paseo-bm]`. Every lookup is
 * raced against `LOOKUP_TIMEOUT_MS`.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { canonicalJson, roleConfigRevision, writeRoleConfig, type ConfigPaseo, type RoleConfigView } from "./config-writer";
import { fallbackForSettings, handleRolesSaveFallback } from "./fallback-settings";
import { asRecord, checkRoleChoice, isRoleAlias, modelOptionsOf, nonEmpty, pickableProviders } from "./role-choices";
import { childFactLines, notifyChildFactChange, type SettingsPaseo } from "./settings-notices";
import {
  LOOKUP_TIMEOUT_MS,
  TIMED_OUT,
  capabilityOf,
  featuresFor,
  modesFor,
  offersAutoApprove,
  withTimeout,
  type ProviderCapability,
} from "./role-mode";
import { errorText } from "./rpc-kit";
import { currentInstructions } from "./role-instructions";
import {
  DashboardError,
  rolesInstructionsRpc,
  rolesOptionsRpc,
  rolesSaveFallbackRpc,
  rolesSaveSettingsRpc,
  rolesSettingsRpc,
  type RolesSaveSettingsInput,
  type SetupRoleWithOrchestrator,
  type RoleModeOption,
  type RoleModelOption,
  type RoleSetting,
  type RolesInstructions,
  type RolesOptions,
  type RolesSettings,
} from "../shared/contracts";

// ---------------------------------------------------------------------------
// Revision.
// ---------------------------------------------------------------------------

/**
 * The part of Paseo's config the role settings live in (the SDK's flat view,
 * F12). Wider than the writer's view: a read tolerates malformed entries.
 */
export interface RoleSettingsConfig {
  providers?: Record<string, unknown> | null;
  agentProfiles?: ReadonlyArray<unknown> | null;
}

/** JSON with object keys sorted at every level (one definition, in config-writer.ts). */
export { canonicalJson };

/**
 * The revision of the role settings (delta 20260921 §4.3.2). THE single
 * definition lives in `config-writer.ts` (`roleConfigRevision`): `roles.settings`
 * hands this value to the client and the writer compares a save's input with
 * the same function, or every save would be refused as a conflict. Never throws.
 */
export function roleSettingsRevision(config: RoleSettingsConfig | null | undefined): string {
  // The revision only hashes the entries, so malformed ones are fine here.
  return roleConfigRevision((config ?? {}) as RoleConfigView);
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

export interface RoleSettingsDeps {
  /** Where a failure is reported; one line each. */
  log?: (message: string) => void;
  /** Home directory used as the `cwd` of the features lookup (the daemon requires one). */
  homedir?: () => string;
  /** Whether a project's action boundary is on, for the `BM-SETTINGS` line of its agents; the owner's policy by default. */
  boundaryOn?: (workspaceId: string) => boolean;
}

const defaultLog = (message: string): void => console.warn(message);

const ROLES: readonly SetupRoleWithOrchestrator[] = ["manager", "worker", "reviewer", "orchestrator"];

const PROVIDER_IDS = {
  manager: "bm-manager",
  worker: "bm-worker",
  reviewer: "bm-reviewer",
  orchestrator: "bm-orchestrator",
} as const satisfies Record<SetupRoleWithOrchestrator, RoleSetting["providerId"]>;

// ---------------------------------------------------------------------------
// roles.settings
// ---------------------------------------------------------------------------

type ConfigRead = { config: RoleSettingsConfig } | { failure: string };

/** ONE `config.get()` under the lookup budget. Never throws. */
async function readConfig(paseo: unknown): Promise<ConfigRead> {
  const config = (paseo as { config?: { get?: unknown } } | null | undefined)?.config;
  const get = config?.get;
  if (typeof get !== "function") return { failure: "this Paseo host cannot read its configuration" };
  try {
    const result = await withTimeout(get.call(config) as Promise<{ config?: unknown } | null | undefined>);
    if (result === TIMED_OUT) return { failure: `no answer within ${LOOKUP_TIMEOUT_MS} ms` };
    const view = asRecord(result?.config);
    if (view === null) return { failure: "the answer carried no configuration" };
    return { config: view as RoleSettingsConfig };
  } catch (error) {
    return { failure: errorText(error) };
  }
}

/** A role the configuration does not describe: every field `null`. */
function emptySetting(role: SetupRoleWithOrchestrator): RoleSetting {
  return {
    role,
    providerId: PROVIDER_IDS[role],
    baseProvider: null,
    label: null,
    model: null,
    thinkingOptionId: null,
    modeId: null,
    featureValues: {},
    capability: "unknown",
  };
}

/** The warning of §4.3.3 / REQ-064: a Worker at its limit stops the Manager too. */
export function sharedPlanWarning(provider: string): string {
  return `Manager and Worker share the ${provider} plan: if the Worker hits its limit, the Manager stops too.`;
}

/**
 * Handler body of `roles.settings`. Always four roles, in the order manager,
 * worker, reviewer, orchestrator; a role the configuration lacks has `null` fields. The
 * capability is looked up once per distinct base provider.
 *
 * When the configuration cannot be read at all, the four roles come back
 * empty with a warning, and `revision` is that of an empty configuration: a
 * save sent with it is then refused (`E_ROLE_SETTINGS_CONFLICT` against a
 * configuration that has roles) rather than written blind.
 */
export async function handleRolesSettings(paseo: unknown, deps: RoleSettingsDeps = {}): Promise<RolesSettings> {
  const log = deps.log ?? defaultLog;
  const read = await readConfig(paseo);
  if ("failure" in read) {
    log(`[paseo-bm] could not read the Paseo configuration for Roles & models (${read.failure}).`);
    return {
      revision: roleSettingsRevision({}),
      roles: ROLES.map(emptySetting),
      // No second config read for the install home: the chains show as the defaults.
      fallback: (await fallbackForSettings(paseo, { ...deps, home: null })).fallback,
      warnings: [`paseo-bm could not read the Paseo configuration (${read.failure}); reopen Roles & models to try again.`],
      providers: await pickableProviders(paseo),
    };
  }

  const { config } = read;
  const providers = asRecord(config.providers) ?? {};
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  const capabilities = new Map<string, Promise<ProviderCapability>>();
  const capabilityFor = (provider: string): Promise<ProviderCapability> => {
    let known = capabilities.get(provider);
    if (known === undefined) {
      known = modesFor(paseo, provider, log).then(capabilityOf, () => "unknown" as const);
      capabilities.set(provider, known);
    }
    return known;
  };

  const roles = await Promise.all(
    ROLES.map(async (role): Promise<RoleSetting> => {
      const id = PROVIDER_IDS[role];
      const entry = asRecord(providers[id]);
      const profile = asRecord(profiles.find((candidate) => asRecord(candidate)?.["id"] === id));
      const baseProvider = nonEmpty(entry?.["extends"]);
      const features = asRecord(profile?.["featureValues"]);
      return {
        role,
        providerId: id,
        baseProvider,
        label: nonEmpty(entry?.["label"]),
        model: nonEmpty(profile?.["model"]),
        thinkingOptionId: nonEmpty(profile?.["thinkingOptionId"]),
        modeId: nonEmpty(profile?.["modeId"]),
        featureValues: features === null ? {} : { ...features },
        capability: baseProvider === null ? "unknown" : await capabilityFor(baseProvider),
      };
    }),
  );

  const warnings: string[] = [];
  const manager = roles.find((setting) => setting.role === "manager")?.baseProvider ?? null;
  const worker = roles.find((setting) => setting.role === "worker")?.baseProvider ?? null;
  if (manager !== null && manager === worker) warnings.push(sharedPlanWarning(manager));

  const chains = await fallbackForSettings(paseo, deps);
  warnings.push(...chains.warnings);
  return { revision: roleSettingsRevision(config), roles, fallback: chains.fallback, warnings, providers: await pickableProviders(paseo) };
}

// ---------------------------------------------------------------------------
// roles.options
// ---------------------------------------------------------------------------

/**
 * Handler body of `roles.options`. `provider` must be a base provider: a
 * `bm-*` alias is refused with `E_ROLE_SETTINGS_INVALID`. Models and modes
 * are read together; the features are read only for an `untiered` provider
 * (§4.2.1), with the home directory as the draft `cwd` the daemon requires.
 */
export async function handleRolesOptions(
  input: { provider: string },
  paseo: unknown,
  deps: RoleSettingsDeps = {},
): Promise<RolesOptions> {
  const provider = typeof input?.provider === "string" ? input.provider : "";
  if (provider.trim() === "") {
    throw new DashboardError("E_ROLE_SETTINGS_INVALID", "name the base provider to list the options of");
  }
  if (isRoleAlias(provider)) {
    throw new DashboardError(
      "E_ROLE_SETTINGS_INVALID",
      `"${provider.slice(0, 200)}" is a paseo-bm role alias, not a base provider; name the provider it extends`,
    );
  }
  const log = deps.log ?? defaultLog;

  const [models, listedModes] = await Promise.all([modelOptionsOf(paseo, provider, log), modesFor(paseo, provider, log)]);
  const capability = capabilityOf(listedModes);
  const modes: RoleModeOption[] = [];
  const modeIds = new Set<string>();
  for (const mode of listedModes ?? []) {
    const id = nonEmpty(mode?.id);
    if (id === null || modeIds.has(id)) continue;
    modeIds.add(id);
    modes.push({ id, label: nonEmpty(mode.label) ?? id, colorTier: nonEmpty(mode.colorTier) });
  }

  let autoAccept = false;
  if (capability === "untiered") {
    let cwd: string | undefined;
    try {
      cwd = (deps.homedir ?? homedir)();
    } catch {
      cwd = undefined;
    }
    autoAccept = offersAutoApprove(await featuresFor(paseo, provider, cwd, log));
  }

  return { provider, capability, models, modes, autoAccept };
}

// ---------------------------------------------------------------------------
// roles.save-settings (delta 20260921 §4.3.3–§4.3.4, REQ-064, REQ-063 h)
// ---------------------------------------------------------------------------

/**
 * The warnings of a saved role (REQ-063 h and the §4.3.3 notes); never blocking.
 * The Orchestrator is read-only the way the Reviewer is — by its instructions
 * and its mode — so the Reviewer's two warnings apply to it too (orchestrator
 * design §3.2).
 */
function saveWarnings(input: RolesSaveSettingsInput, capability: ProviderCapability, cost: RoleModelOption["cost"]): string[] {
  const warnings: string[] = [];
  const pi = input.baseProvider === "pi";
  if (pi && (input.role === "manager" || input.role === "worker")) {
    warnings.push("Pi needs pi-mcp-adapter to give this role Paseo tools.");
  }
  const readOnly = input.role === "reviewer" ? "Reviewer" : input.role === "orchestrator" ? "Orchestrator" : null;
  if (readOnly !== null && (pi || capability === "none")) {
    warnings.push(`Pi does not ask before running tools; the ${readOnly}'s read-only rule is only in its instructions.`);
  }
  if (readOnly !== null && capability === "untiered" && input.modeId === null) {
    warnings.push(`The ${readOnly} runs with your OpenCode agent's permissions; paseo-bm never auto-approves for it.`);
  }
  if (cost !== null) {
    warnings.push(`Priced at ~$${cost.inputUsdPerMTok} / $${cost.outputUsdPerMTok} per 1M tokens.`);
  }
  return warnings;
}

/**
 * Handler body of `roles.save-settings`. Every check of §4.3.3 runs before any
 * write and fails with `E_ROLE_SETTINGS_INVALID`: the base provider is
 * available and is not a `bm-*` alias; the model is one Paseo lists for it;
 * the thinking level is one of that model's; the mode is one the provider
 * lists, and never `dangerous` / `planning` for the Reviewer on a tiered
 * provider. Then one write through `config-writer` (revision check included),
 * and the saved role read back. Warnings never block.
 */
export async function handleRolesSaveSettings(
  input: RolesSaveSettingsInput,
  paseo: unknown,
  deps: RoleSettingsDeps = {},
): Promise<{ revision: string; role: RoleSetting; warnings: string[]; notified: number }> {
  const log = deps.log ?? defaultLog;
  const { model, capability } = await checkRoleChoice(input.role, input, paseo, log);

  const id = PROVIDER_IDS[input.role];
  // The creator's child lines before the write, to tell live agents a change (§4.3.5), per project boundary (§D.2).
  const lineBefore = await childFactLines(input.role, paseo);
  await writeRoleConfig(paseo as ConfigPaseo, {
    expectedRevision: input.revision,
    providers: { [id]: { extends: input.baseProvider } },
    profiles: { [id]: { model: input.model, thinkingOptionId: input.thinkingOptionId, modeId: input.modeId } },
  });

  const settings = await handleRolesSettings(paseo, deps);
  const role = settings.roles.find((entry) => entry.role === input.role) ?? emptySetting(input.role);
  const shared = settings.warnings.filter((warning) => warning.startsWith("Manager and Worker share"));
  const lineAfter = await childFactLines(input.role, paseo);
  const notified = await notifyChildFactChange(input.role, lineBefore, lineAfter, paseo as SettingsPaseo, {
    log,
    ...(deps.boundaryOn !== undefined ? { boundaryOn: deps.boundaryOn } : {}),
  });
  return { revision: settings.revision, role, warnings: [...shared, ...saveWarnings(input, capability, model.cost)], notified };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/**
 * Handler body of `roles.instructions` (design §7.12, base PRD REQ-032 d):
 * what a new agent of `role` is created with now, built by the very function
 * the creation paths use, so the view never drifts from them. Only reads;
 * a lookup that fails leaves its fact out, as at a creation.
 */
export async function handleRolesInstructions(
  input: { role: SetupRoleWithOrchestrator; workspaceId?: string },
  paseo: unknown,
  deps: { homedir?: () => string } = {},
): Promise<RolesInstructions> {
  const text = await currentInstructions(input.role, paseo, {
    ...(deps.homedir === undefined ? {} : { homedir: deps.homedir }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
  });
  return { role: input.role, text, workspaceId: input.workspaceId ?? null };
}

/** Registers `roles.settings`, `roles.options`, `roles.instructions`, `roles.save-settings` and `roles.save-fallback` (§4.4.3). */
export function registerRoleSettingsRpcs(server: PluginServerContext): void {
  server.handle(rolesSettingsRpc, (_input, context) => handleRolesSettings(context.paseo));
  server.handle(rolesInstructionsRpc, (input, context) => handleRolesInstructions(input, context.paseo));
  server.handle(rolesOptionsRpc, (input, context) => handleRolesOptions(input, context.paseo));
  server.handle(rolesSaveSettingsRpc, (input, context) => handleRolesSaveSettings(input, context.paseo));
  server.handle(rolesSaveFallbackRpc, (input, context) => handleRolesSaveFallback(input, context.paseo));
}
