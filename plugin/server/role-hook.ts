import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import { TOOL_PROVIDERS, withAgentTools, type AgentToolsEndpoint } from "./agent-tools";
import { aliasBases } from "./alias-bases";
import { providerId } from "./provider-id";
import {
  LOOKUP_TIMEOUT_MS,
  ROLE_GETS_MODE,
  TIMED_OUT,
  capabilityOf,
  chooseModeId,
  featuresFor,
  modesFor,
  profileOf,
  runPostureOf,
  withTimeout,
  type ProviderCapability,
  type ProviderFeature,
  type ProviderMode,
  type RoleProfile,
} from "./role-mode";
import {
  BASE_INSTRUCTIONS,
  fullInstructions,
  dataHomeOf,
  readRoleExtras,
  runtimeFactsOf,
  type RoleExtras,
  type RuntimeFacts,
} from "./role-extras";

/**
 * Role instructions injected into every paseo-bm agent at creation (bm-hld).
 *
 * Paseo's `create_agent` tool has no system-prompt parameter, so a Worker the
 * Manager creates, or a Reviewer the Worker creates, would otherwise start
 * without its role contract. The daemon runs `before("agent.create")` hooks for
 * every agent creation, whoever asks for it, so the plugin sets the prompt
 * there, keyed by the provider id.
 *
 * The same hook sets the start mode of Workers and Reviewers (delta 20260917c
 * §4.6): what the role files used to teach in a paragraph each is one lookup
 * here, and it cannot be got wrong by an agent.
 *
 * Provider ids map to roles through `roleOfProvider` (agent-role.ts), the
 * same rule every lookup uses to tell paseo-bm agents apart (delta 20260918g):
 * the three main aliases and the fallback aliases `bm-<role>-fallback-<n>`
 * (delta 20260921 §4.4.1). Lookups use the agent's real alias.
 */

export { chooseModeId, type ProviderMode } from "./role-mode";

/** Separates the role instructions from a system prompt that was already set. */
export const ROLE_PROMPT_SEPARATOR = "\n\n---\n\n";

/** The `agent.create` before-request the daemon hands to the hook. */
export type AgentCreateRequest = PluginBeforeRequests["agent.create"];

/**
 * Returns the request with the role instructions in `config.systemPrompt`, or
 * `undefined` when nothing changes (not a paseo-bm provider, or the prompt
 * already contains the instructions). Never throws.
 *
 * An existing, different system prompt is kept after the instructions,
 * separated by `ROLE_PROMPT_SEPARATOR`.
 */
export function applyRoleInstructions(
  request: AgentCreateRequest,
  extras: Partial<RoleExtras> = {},
  facts: RuntimeFacts = {},
): AgentCreateRequest | undefined {
  try {
    // Typed as required, but never trusted: a malformed request must not throw.
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    if (role === null) return undefined;
    const base = BASE_INSTRUCTIONS[role];
    // The user's additions from the Setup screen come after the base, never instead of it.
    // Runtime facts sit between the two, so manager.ensure and this hook write the same text.
    const instructions = fullInstructions(role, extras[role] ?? "", facts);

    const existing = typeof config.systemPrompt === "string" ? config.systemPrompt : "";
    if (existing.includes(instructions)) return undefined;
    let systemPrompt: string;
    if (existing.includes(base)) {
      // Set by an older call with the base only: upgrade it in place.
      systemPrompt = existing.replace(base, instructions);
    } else {
      systemPrompt = existing.trim() === "" ? instructions : `${instructions}${ROLE_PROMPT_SEPARATOR}${existing}`;
    }
    return { ...request, config: { ...config, systemPrompt } };
  } catch {
    return undefined;
  }
}

/**
 * Returns the request with `config.modeId` set by `chooseModeId`, or
 * `undefined` when nothing changes. `modes` is `null` when the provider's list
 * could not be read. Never throws.
 */
export function applyRoleMode(
  request: AgentCreateRequest,
  modes: readonly ProviderMode[] | null,
  profileModeId: string | null = null,
): AgentCreateRequest | undefined {
  try {
    if (modes === null) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const id = providerId(config.provider);
    const role = roleOfProvider(id);
    if (id === null || role === null) return undefined;
    const current = typeof config.modeId === "string" && config.modeId.trim() !== "" ? config.modeId : undefined;
    const modeId = chooseModeId(role, modes, current, profileModeId);
    if (modeId === undefined || modeId === current) return undefined;
    if (current !== undefined) {
      console.warn(`[paseo-bm] ${id} was created in mode "${current}", which that role must not use; starting it in "${modeId}" instead.`);
    }
    return { ...request, config: { ...config, modeId } };
  } catch {
    return undefined;
  }
}

/**
 * The model a creation request names, or `null`: the daemon's resolved
 * `config.model` when set, else everything after the FIRST `/` of
 * `config.provider` (OpenCode model ids contain `/` themselves, so
 * `bm-worker/anthropic/claude-sonnet-4-6` names `anthropic/claude-sonnet-4-6`).
 */
function requestModelOf(config: { provider?: unknown; model?: unknown }): string | null {
  if (typeof config.model === "string" && config.model.trim() !== "") return config.model;
  if (typeof config.provider !== "string") return null;
  const slash = config.provider.indexOf("/");
  return slash === -1 || slash === config.provider.length - 1 ? null : config.provider.slice(slash + 1);
}

/**
 * Returns the request with the model of the Worker's or Reviewer's own profile
 * when the creator named another one, or `undefined` when nothing changes.
 * Never throws.
 *
 * The role files tell the creator to pass `bm-<role>/<model of the profile>`,
 * but a Manager reads the profile once and keeps it: after the user moved the
 * Worker from Claude to Codex in Setup, a Manager created earlier still asked
 * for `bm-worker/claude-opus-5-5`, and Codex refused the model at the Worker's
 * first turn (clean-install run 2026-09-26). The profile is what the user set,
 * so it wins, the way `applyRoleMode` makes the role's mode win. Only the main
 * aliases have a profile; a fallback alias keeps the model it was given.
 */
export function applyRoleModel(request: AgentCreateRequest, profile: RoleProfile | null): AgentCreateRequest | undefined {
  try {
    if (profile === null || profile.model === null) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const id = providerId(config.provider);
    const role = roleOfProvider(id);
    if (id === null || (role !== "worker" && role !== "reviewer")) return undefined;
    const requested = requestModelOf(config);
    if (requested === null || requested === profile.model) return undefined;
    const next: Record<string, unknown> = { ...config };
    if (typeof config.provider === "string" && config.provider.includes("/")) next.provider = `${id}/${profile.model}`;
    if (typeof config.model === "string" && config.model.trim() !== "") next.model = profile.model;
    // A thinking level belongs to the model it was chosen for and may not exist
    // on the profile's; `applyRoleProfile` then sets the profile's own, if any.
    delete next.thinkingOptionId;
    console.warn(`[paseo-bm] ${id} was asked for model "${requested}", but its profile names "${profile.model}"; starting it on "${profile.model}".`);
    return { ...request, config: next as unknown as AgentCreateRequest["config"] };
  } catch {
    return undefined;
  }
}

/**
 * Returns the request with the thinking level and feature values of the
 * Worker's or Reviewer's own profile (delta 20260921 §4.1.1, REQ-062 a), or
 * `undefined` when nothing changes. Never throws.
 *
 * - `thinkingOptionId`: the profile's, only when the creator passed none and
 *   the request's model is the profile's model (or names no model): a
 *   thinking level belongs to a model and may not exist on another one.
 * - `featureValues`: the profile's, merged under the creator's, whose keys win.
 *
 * The Manager is left alone: `manager.ensure` already passes its profile.
 */
export function applyRoleProfile(request: AgentCreateRequest, profile: RoleProfile | null): AgentCreateRequest | undefined {
  try {
    if (profile === null) return undefined;
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    if (role === null) return undefined;
    if (role !== "worker" && role !== "reviewer") return undefined;

    const next: Record<string, unknown> = { ...config };
    let changed = false;
    const current = typeof config.thinkingOptionId === "string" && config.thinkingOptionId.trim() !== "";
    const model = requestModelOf(config);
    if (!current && profile.thinkingOptionId !== null && (model === null || model === profile.model)) {
      next.thinkingOptionId = profile.thinkingOptionId;
      changed = true;
    }
    if (profile.featureValues !== null) {
      const own = config.featureValues;
      const creator = own !== null && typeof own === "object" && !Array.isArray(own) ? own : {};
      const merged = { ...profile.featureValues, ...creator };
      if (JSON.stringify(merged) !== JSON.stringify(own ?? null)) {
        next.featureValues = merged;
        changed = true;
      }
    }
    return changed ? { ...request, config: next as unknown as AgentCreateRequest["config"] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the request with the start mode and auto-approve of a Worker or
 * Reviewer on an `untiered` or `none` provider (delta 20260921 §4.2.2), or
 * `undefined` when nothing changes. `tiered` and `unknown` providers keep
 * `applyRoleMode`. Never throws.
 */
export function applyRunPosture(
  request: AgentCreateRequest,
  capability: ProviderCapability,
  modes: readonly ProviderMode[] | null,
  features: readonly ProviderFeature[] | null,
  profileModeId: string | null = null,
): AgentCreateRequest | undefined {
  try {
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const role = roleOfProvider(config.provider);
    if (role === null) return undefined;
    if (!ROLE_GETS_MODE[role]) return undefined;
    const own = config.featureValues;
    const current = {
      ...(typeof config.modeId === "string" && config.modeId.trim() !== "" ? { modeId: config.modeId } : {}),
      ...(own !== null && typeof own === "object" && !Array.isArray(own) ? { featureValues: own } : {}),
    };
    const posture = runPostureOf(role, capability, modes ?? [], features, profileModeId, current);
    if (posture === undefined || (posture.modeId === undefined && posture.featureValues === undefined)) return undefined;
    const next: Record<string, unknown> = { ...config };
    // `null` removes the key: a provider without modes gets neither (review b4).
    if (posture.modeId === null) delete next.modeId;
    else if (posture.modeId !== undefined) next.modeId = posture.modeId;
    if (posture.featureValues === null) delete next.featureValues;
    else if (posture.featureValues !== undefined) next.featureValues = posture.featureValues;
    return { ...request, config: next as unknown as AgentCreateRequest["config"] };
  } catch {
    return undefined;
  }
}

/** Instructions, profile settings and start posture together; `undefined` when none changes. */
export function applyRoleConfig(
  request: AgentCreateRequest,
  extras: Partial<RoleExtras> = {},
  modes: readonly ProviderMode[] | null = null,
  facts: RuntimeFacts = {},
  profileModeId: string | null = null,
  profile: RoleProfile | null = null,
  features: readonly ProviderFeature[] | null = null,
): AgentCreateRequest | undefined {
  const withInstructions = applyRoleInstructions(request, extras, facts);
  // The model first: the profile's thinking level only applies on the profile's model.
  const withModel = applyRoleModel(withInstructions ?? request, profile) ?? withInstructions;
  const withProfile = applyRoleProfile(withModel ?? request, profile) ?? withModel;
  const capability = capabilityOf(modes);
  const posture =
    capability === "untiered" || capability === "none"
      ? applyRunPosture(withProfile ?? request, capability, modes, features, profileModeId)
      : applyRoleMode(withProfile ?? request, modes, profileModeId);
  return posture ?? withProfile;
}

/**
 * The provider id whose modes are worth a lookup, or `null`. A Reviewer needs
 * the list to recognise a mode it must not run in; a Worker needs it even
 * when its creator already chose a mode, because the capability class decides
 * its auto-approve (delta 20260921 §4.2.1: on OpenCode the Worker's chosen
 * mode is kept but `auto_accept` must still be turned on).
 */
function modeLookupFor(request: AgentCreateRequest): string | null {
  try {
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    const id = providerId(config?.provider);
    const role = roleOfProvider(id);
    if (id === null || role === null) return null;
    return ROLE_GETS_MODE[role] ? id : null;
  } catch {
    return null;
  }
}

/** Everything the hook needs from the daemon, gathered under one time budget. */
async function prepare(
  request: AgentCreateRequest,
  paseo: unknown,
): Promise<{
  extras: Partial<RoleExtras>;
  modes: ProviderMode[] | null;
  facts: RuntimeFacts;
  profileModeId: string | null;
  profile: RoleProfile | null;
  features: ProviderFeature[] | null;
  /** The provider the alias extends (`claude`, `codex`, …), or null when unreadable. */
  base: string | null;
}> {
  let extras: Partial<RoleExtras> = {};
  try {
    const home = dataHomeOf();
    if (home !== null) extras = readRoleExtras(home);
  } catch {
    // Without the additions the agent still gets its base instructions.
  }
  const cwd = typeof request?.config?.cwd === "string" ? request.config.cwd : undefined;
  const id = providerId(request?.config?.provider);
  const role = roleOfProvider(id) ?? undefined;
  // The Worker's or Reviewer's own profile: its mode (bm-msy), and its
  // thinking and features (delta 20260921 §4.1.1). One read, whether or not
  // the mode needs a lookup: a Worker created WITH a mode still gets the
  // thinking set on its profile.
  const profile = role === "worker" || role === "reviewer" ? await profileOf(paseo, id!) : null;
  const lookup = modeLookupFor(request);
  const profileModeId = lookup === null ? null : (profile?.modeId ?? null);
  const modes = lookup === null ? null : await modesFor(paseo, lookup, undefined, cwd);
  // Only an untiered provider (OpenCode) costs the features round trip: its
  // auto-approve toggle is the one feature the posture rule sets (§4.2.2).
  // The model the agent will run on: the profile's when `applyRoleModel` will
  // switch to it, so the features are those of that model.
  const requested = typeof request?.config?.provider === "string" ? request.config.provider : (id ?? "");
  const wanted = profile?.model ?? null;
  const asked = request?.config ? requestModelOf(request.config) : null;
  const selection = id !== null && wanted !== null && asked !== null && asked !== wanted ? `${id}/${wanted}` : requested;
  const features = capabilityOf(modes) === "untiered" ? await featuresFor(paseo, selection, cwd) : null;
  const facts = role === undefined ? {} : await runtimeFactsOf(role, paseo, cwd);
  const base = id === null ? null : ((await aliasBases(paseo))[id] ?? null);
  return { extras, modes, facts, profileModeId, profile, features, base };
}

function isBmRequest(request: AgentCreateRequest): boolean {
  try {
    return roleOfProvider((request as Partial<AgentCreateRequest> | null | undefined)?.config?.provider) !== null;
  } catch {
    return false;
  }
}

/** The part of the server context this hook needs; `before` is absent on older hosts. */
export type RoleHookHost = Partial<Pick<PluginServerContext, "before">>;

/**
 * The request with the role's tool server added (design delta
 * 20260924b-agent-tools, ADR-010), or `undefined` when there is nothing to
 * add: not a paseo-bm agent, no endpoint listening, or a base provider that
 * is unknown or cannot take pre-approved tools (`TOOL_PROVIDERS`) — Paseo
 * would refuse to create that agent at all. Never throws.
 */
export function applyAgentTools(
  request: AgentCreateRequest,
  tools: Pick<AgentToolsEndpoint, "urlFor"> | null,
  base: string | null,
): AgentCreateRequest | undefined {
  try {
    if (tools === null || base === null || !TOOL_PROVIDERS.includes(base)) return undefined;
    const role = roleOfProvider(request.config.provider);
    const config = role === null ? undefined : withAgentTools(request.config, role, tools.urlFor(role));
    return config === undefined ? undefined : { ...request, config };
  } catch {
    return undefined;
  }
}

/**
 * Registers the `before("agent.create")` hook and returns its remover. On a
 * host without `before` it logs one line and returns a no-op.
 */
export function registerRoleHook(host: RoleHookHost, tools: Pick<AgentToolsEndpoint, "urlFor"> | null = null): () => void {
  if (typeof host.before !== "function") {
    console.warn(
      "[paseo-bm] this Paseo host has no before(\"agent.create\") hook; Worker and Reviewer agents will start without role instructions.",
    );
    return () => {};
  }
  const remove = host.before("agent.create", (input, context) => {
    const request = (input as { request?: AgentCreateRequest } | undefined)?.request as AgentCreateRequest;
    // Every agent creation passes here: only paseo-bm's own pay for a lookup.
    if (!isBmRequest(request)) return undefined;
    return (async () => {
      const paseo = (context as { paseo?: unknown } | undefined)?.paseo;
      // The host fails the whole creation if this hook takes longer than 30 s,
      // so everything it looks up is raced as ONE budget: a slow daemon costs
      // the extras, the mode and the facts, never the agent.
      const prepared = await withTimeout(prepare(request, paseo), LOOKUP_TIMEOUT_MS);
      if (prepared === TIMED_OUT) {
        console.warn(
          `[paseo-bm] preparing the role config took longer than ${LOOKUP_TIMEOUT_MS} ms; the agent starts with its role instructions only.`,
        );
        // The base provider is unknown here, so no tools: an agent Paseo refuses would cost more than a hand-written block.
        return applyRoleInstructions(request);
      }
      const configured = applyRoleConfig(
        request,
        prepared.extras,
        prepared.modes,
        prepared.facts,
        prepared.profileModeId,
        prepared.profile,
        prepared.features,
      );
      return applyAgentTools(configured ?? request, tools, prepared.base) ?? configured;
    })();
  });
  return typeof remove === "function" ? remove : () => {};
}
