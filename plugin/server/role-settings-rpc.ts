/**
 * `roles.settings` and `roles.options`: the data of the Roles & models section
 * of the Setup screen (delta 20260921 §4.3.2, REQ-064 a/b). Both only read.
 *
 * - `roles.settings` describes the three roles from ONE `config.get()`. The
 *   SDK view is flat (design F12): `config.providers` is `agents.providers`,
 *   `config.agentProfiles` is `daemon.agentProfiles`. It hands the client the
 *   `revision` that `roles.save-settings` must send back.
 * - `roles.options` lists what the Edit form may offer for one BASE provider,
 *   from `providers.listModels`, `listModes`, `listFeatures` and `costOf`.
 *
 * Neither handler throws anything but a coded `DashboardError`: a lookup that
 * fails, times out or answers an `error` becomes an empty list or `unknown`
 * and costs one `console.warn` line starting `[paseo-bm]`. Every lookup is
 * raced against `LOOKUP_TIMEOUT_MS`.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { canonicalJson, roleConfigRevision, writeRoleConfig, type ConfigPaseo, type RoleConfigView } from "./config-writer";
import { costOf } from "./model-costs";
import { childFactLine, notifyChildFactChange, type SettingsPaseo } from "./settings-notices";
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
import {
  DashboardError,
  rolesOptionsRpc,
  rolesSaveSettingsRpc,
  rolesSettingsRpc,
  type RolesSaveSettingsInput,
  type BmRole,
  type RoleModeOption,
  type RoleModelOption,
  type RoleSetting,
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
}

const defaultLog = (message: string): void => console.warn(message);

const ROLES: readonly BmRole[] = ["manager", "worker", "reviewer"];

const PROVIDER_IDS = { manager: "bm-manager", worker: "bm-worker", reviewer: "bm-reviewer" } as const satisfies Record<
  BmRole,
  RoleSetting["providerId"]
>;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A `bm-*` role alias (`bm-worker`, `bm-worker/<model>`, `bm-worker-fallback-1`), not a base provider. */
function isRoleAlias(provider: string): boolean {
  return /^bm-/i.test(provider.trim());
}

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
    return { failure: reasonOf(error) };
  }
}

/** A role the configuration does not describe: every field `null`. */
function emptySetting(role: BmRole): RoleSetting {
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
 * Handler body of `roles.settings`. Always three roles, in the order manager,
 * worker, reviewer; a role the configuration lacks has `null` fields. The
 * capability is looked up once per distinct base provider.
 *
 * When the configuration cannot be read at all, the three roles come back
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
      fallback: null,
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

  return { revision: roleSettingsRevision(config), roles, fallback: null, warnings, providers: await pickableProviders(paseo) };
}

/** The base providers the Edit form offers: available ones, never a `bm-*` alias, sorted; `[]` when Paseo cannot say. */
async function pickableProviders(paseo: unknown): Promise<string[]> {
  const available = await availableProviders(paseo);
  return available === null ? [] : [...available].filter((id) => !isRoleAlias(id)).sort();
}

// ---------------------------------------------------------------------------
// roles.options
// ---------------------------------------------------------------------------

type ListedModel = Omit<RoleModelOption, "cost">;

/** Paseo's models of `provider`, without prices; `[]` (and one log line) when they cannot be read. Never throws. */
async function listedModelsOf(paseo: unknown, provider: string, log: (message: string) => void): Promise<ListedModel[]> {
  const providers = (paseo as { providers?: { listModels?: unknown } } | null | undefined)?.providers;
  const listModels = providers?.listModels;
  if (typeof listModels !== "function") {
    log(`[paseo-bm] this Paseo host cannot list models; Roles & models offers no model of ${provider}.`);
    return [];
  }
  try {
    const result = await withTimeout(listModels.call(providers, provider) as Promise<{ models?: unknown; error?: unknown } | null | undefined>);
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the models of ${provider} took longer than ${LOOKUP_TIMEOUT_MS} ms; Roles & models offers none.`);
      return [];
    }
    const failure = nonEmpty(result?.error);
    if (failure !== null || !Array.isArray(result?.models)) {
      log(`[paseo-bm] could not read the models of ${provider} (${failure ?? "no models listed"}); Roles & models offers none.`);
      return [];
    }
    const out: ListedModel[] = [];
    const seen = new Set<string>();
    for (const raw of result.models as unknown[]) {
      const model = asRecord(raw);
      const id = nonEmpty(model?.["id"]);
      if (model === null || id === null || seen.has(id)) continue;
      seen.add(id);
      const thinkingOptions: ListedModel["thinkingOptions"] = [];
      let flaggedDefault: string | null = null;
      const optionIds = new Set<string>();
      for (const rawOption of Array.isArray(model["thinkingOptions"]) ? (model["thinkingOptions"] as unknown[]) : []) {
        const option = asRecord(rawOption);
        const optionId = nonEmpty(option?.["id"]);
        if (option === null || optionId === null || optionIds.has(optionId)) continue;
        optionIds.add(optionId);
        thinkingOptions.push({ id: optionId, label: nonEmpty(option["label"]) ?? optionId });
        if (flaggedDefault === null && option["isDefault"] === true) flaggedDefault = optionId;
      }
      out.push({
        id,
        label: nonEmpty(model["label"]) ?? id,
        thinkingOptions,
        defaultThinkingOptionId: nonEmpty(model["defaultThinkingOptionId"]) ?? flaggedDefault,
      });
    }
    return out;
  } catch (error) {
    log(`[paseo-bm] could not read the models of ${provider} (${reasonOf(error)}); Roles & models offers none.`);
    return [];
  }
}

/** The models with their listed rates (`costOf`, §4.2.7); a model without one has `cost: null`. */
async function modelOptionsOf(paseo: unknown, provider: string, log: (message: string) => void): Promise<RoleModelOption[]> {
  const models = await listedModelsOf(paseo, provider, log);
  return Promise.all(
    models.map(async (model) => ({
      ...model,
      cost: await costOf(paseo, provider, model.id, log).catch(() => null),
    })),
  );
}

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

/** The base providers Paseo reports as available, or `null` when it cannot say. Never throws. */
async function availableProviders(paseo: unknown): Promise<Set<string> | null> {
  const providers = (paseo as { providers?: { listAvailable?: unknown } } | null | undefined)?.providers;
  const listAvailable = providers?.listAvailable;
  if (typeof listAvailable !== "function") return null;
  try {
    const result = await withTimeout(listAvailable.call(providers) as Promise<{ providers?: unknown } | null | undefined>);
    if (result === TIMED_OUT || !Array.isArray(result?.providers)) return null;
    const ids = new Set<string>();
    for (const entry of result.providers as Array<{ provider?: unknown; available?: unknown }>) {
      if (entry?.available === true && typeof entry.provider === "string") ids.add(entry.provider);
    }
    return ids;
  } catch {
    return null;
  }
}

/** The warnings of a saved role (REQ-063 h and the §4.3.3 notes); never blocking. */
function saveWarnings(input: RolesSaveSettingsInput, capability: ProviderCapability, cost: RoleModelOption["cost"]): string[] {
  const warnings: string[] = [];
  const pi = input.baseProvider === "pi";
  if (pi && (input.role === "manager" || input.role === "worker")) {
    warnings.push("Pi needs pi-mcp-adapter to give this role Paseo tools.");
  }
  if (input.role === "reviewer" && (pi || capability === "none")) {
    warnings.push("Pi does not ask before running tools; the Reviewer's read-only rule is only in its instructions.");
  }
  if (input.role === "reviewer" && capability === "untiered" && input.modeId === null) {
    warnings.push("The Reviewer runs with your OpenCode agent's permissions; paseo-bm never auto-approves for it.");
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
  const invalid = (detail: string) => new DashboardError("E_ROLE_SETTINGS_INVALID", detail);
  if (isRoleAlias(input.baseProvider)) throw invalid(`"${input.baseProvider}" is a paseo-bm role alias, not a base provider`);
  const available = await availableProviders(paseo);
  if (available === null) throw invalid("Paseo cannot say which providers are available right now; try again");
  if (!available.has(input.baseProvider)) throw invalid(`provider "${input.baseProvider}" is not available in Paseo`);

  const [models, modes] = await Promise.all([modelOptionsOf(paseo, input.baseProvider, log), modesFor(paseo, input.baseProvider, log)]);
  const model = models.find((entry) => entry.id === input.model);
  if (model === undefined) throw invalid(`model "${input.model}" is not listed for ${input.baseProvider}`);
  if (input.thinkingOptionId !== null && !model.thinkingOptions.some((option) => option.id === input.thinkingOptionId)) {
    throw invalid(`thinking "${input.thinkingOptionId}" is not offered by ${input.model}`);
  }
  const capability = capabilityOf(modes);
  if (input.modeId !== null) {
    const mode = (modes ?? []).find((entry) => entry?.id === input.modeId);
    if (mode === undefined) throw invalid(`mode "${input.modeId}" is not listed for ${input.baseProvider}`);
    const tier = typeof mode.colorTier === "string" ? mode.colorTier.toLowerCase() : "";
    if (input.role === "reviewer" && (tier === "dangerous" || tier === "planning")) {
      throw invalid(`the Reviewer never runs in a ${tier} mode ("${input.modeId}")`);
    }
  }

  const id = PROVIDER_IDS[input.role];
  // The creator's child line before the write, to tell live agents a change (§4.3.5).
  const lineBefore = await childFactLine(input.role, paseo);
  await writeRoleConfig(paseo as ConfigPaseo, {
    expectedRevision: input.revision,
    providers: { [id]: { extends: input.baseProvider } },
    profiles: { [id]: { model: input.model, thinkingOptionId: input.thinkingOptionId, modeId: input.modeId } },
  });

  const settings = await handleRolesSettings(paseo, deps);
  const role = settings.roles.find((entry) => entry.role === input.role) ?? emptySetting(input.role);
  const shared = settings.warnings.filter((warning) => warning.startsWith("Manager and Worker share"));
  const lineAfter = await childFactLine(input.role, paseo);
  const notified = await notifyChildFactChange(input.role, lineBefore, lineAfter, paseo as SettingsPaseo, { log });
  return { revision: settings.revision, role, warnings: [...shared, ...saveWarnings(input, capability, model.cost)], notified };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/** Registers `roles.settings`, `roles.options` and `roles.save-settings`. */
export function registerRoleSettingsRpcs(server: PluginServerContext): void {
  server.handle(rolesSettingsRpc, (_input, context) => handleRolesSettings(context.paseo));
  server.handle(rolesOptionsRpc, (input, context) => handleRolesOptions(input, context.paseo));
  server.handle(rolesSaveSettingsRpc, (input, context) => handleRolesSaveSettings(input, context.paseo));
}
