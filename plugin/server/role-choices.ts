/**
 * What a role may run, as Paseo lists it (delta 20260921 §4.3.2–§4.3.3): the
 * available base providers, each provider's models with their prices, and the
 * one check every save runs before it writes anything — `roles.save-settings`
 * for a role itself, `roles.save-fallback` for each entry of its chain.
 *
 * Every lookup is raced against `LOOKUP_TIMEOUT_MS`; one that fails becomes an
 * empty list (or `null`) and costs one `console.warn` line starting
 * `[paseo-bm]`. Only `checkRoleChoice` throws, and only a coded `DashboardError`.
 */
import { costOf } from "./model-costs";
import { LOOKUP_TIMEOUT_MS, TIMED_OUT, capabilityOf, modesFor, withTimeout, type ProviderCapability, type ProviderMode } from "./role-mode";
import { DashboardError, type BmRole, type RoleModelOption } from "../shared/contracts";

export const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A `bm-*` role alias (`bm-worker`, `bm-worker/<model>`, `bm-worker-fallback-1`), not a base provider. */
export function isRoleAlias(provider: string): boolean {
  return /^bm-/i.test(provider.trim());
}

/** The base providers Paseo reports as available, or `null` when it cannot say. Never throws. */
export async function availableProviders(paseo: unknown): Promise<Set<string> | null> {
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

/** The base providers the Edit form offers: available ones, never a `bm-*` alias, sorted; `[]` when Paseo cannot say. */
export async function pickableProviders(paseo: unknown): Promise<string[]> {
  const available = await availableProviders(paseo);
  return available === null ? [] : [...available].filter((id) => !isRoleAlias(id)).sort();
}

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
export async function modelOptionsOf(paseo: unknown, provider: string, log: (message: string) => void): Promise<RoleModelOption[]> {
  const models = await listedModelsOf(paseo, provider, log);
  return Promise.all(
    models.map(async (model) => ({
      ...model,
      cost: await costOf(paseo, provider, model.id, log).catch(() => null),
    })),
  );
}

/** What a role runs: a base provider, one of its models, and optional thinking and mode. */
export interface RoleChoice {
  baseProvider: string;
  model: string;
  thinkingOptionId: string | null;
  modeId: string | null;
}

/**
 * The checks of §4.3.3, before any write; each failure is
 * `E_ROLE_SETTINGS_INVALID`: the base provider is available and is not a
 * `bm-*` alias; the model is one Paseo lists for it; the thinking level is one
 * of that model's; the mode is one the provider lists, and never `dangerous` /
 * `planning` for the Reviewer. Returns the model, as listed, and the
 * provider's capability. `available` lets a caller checking several choices
 * read the provider list once.
 */
export async function checkRoleChoice(
  role: BmRole,
  choice: RoleChoice,
  paseo: unknown,
  log: (message: string) => void,
  available?: Set<string> | null,
): Promise<{ model: RoleModelOption; capability: ProviderCapability; modes: ProviderMode[] | null }> {
  const invalid = (detail: string) => new DashboardError("E_ROLE_SETTINGS_INVALID", detail);
  if (isRoleAlias(choice.baseProvider)) throw invalid(`"${choice.baseProvider}" is a paseo-bm role alias, not a base provider`);
  const listed = available === undefined ? await availableProviders(paseo) : available;
  if (listed === null) throw invalid("Paseo cannot say which providers are available right now; try again");
  if (!listed.has(choice.baseProvider)) throw invalid(`provider "${choice.baseProvider}" is not available in Paseo`);

  const [models, modes] = await Promise.all([modelOptionsOf(paseo, choice.baseProvider, log), modesFor(paseo, choice.baseProvider, log)]);
  const model = models.find((entry) => entry.id === choice.model);
  if (model === undefined) throw invalid(`model "${choice.model}" is not listed for ${choice.baseProvider}`);
  if (choice.thinkingOptionId !== null && !model.thinkingOptions.some((option) => option.id === choice.thinkingOptionId)) {
    throw invalid(`thinking "${choice.thinkingOptionId}" is not offered by ${choice.model}`);
  }
  if (choice.modeId !== null) {
    const mode = (modes ?? []).find((entry) => entry?.id === choice.modeId);
    if (mode === undefined) throw invalid(`mode "${choice.modeId}" is not listed for ${choice.baseProvider}`);
    const tier = typeof mode.colorTier === "string" ? mode.colorTier.toLowerCase() : "";
    if (role === "reviewer" && (tier === "dangerous" || tier === "planning")) {
      throw invalid(`the Reviewer never runs in a ${tier} mode ("${choice.modeId}")`);
    }
  }
  return { model, capability: capabilityOf(modes), modes };
}
