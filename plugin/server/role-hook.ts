import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { ROLE_BY_PROVIDER } from "./agent-role";
import { providerId } from "./provider-id";
import { LOOKUP_TIMEOUT_MS, ROLE_GETS_MODE, TIMED_OUT, chooseModeId, modesFor, profileOf, withTimeout, type ProviderMode, type RoleProfile } from "./role-mode";
import {
  BASE_INSTRUCTIONS,
  fullInstructions,
  installHomeOf,
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
 * Provider ids map to roles through `ROLE_BY_PROVIDER` (agent-role.ts), the
 * same map every lookup uses to tell paseo-bm agents apart (delta 20260918g).
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
    const id = providerId(config.provider);
    if (id === null || !Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id)) return undefined;
    const role = ROLE_BY_PROVIDER[id]!;
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
    if (id === null || !Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id)) return undefined;
    const current = typeof config.modeId === "string" && config.modeId.trim() !== "" ? config.modeId : undefined;
    const modeId = chooseModeId(ROLE_BY_PROVIDER[id]!, modes, current, profileModeId);
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
    const id = providerId(config.provider);
    if (id === null || !Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id)) return undefined;
    const role = ROLE_BY_PROVIDER[id]!;
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

/** Instructions, profile settings and start mode together; `undefined` when none changes. */
export function applyRoleConfig(
  request: AgentCreateRequest,
  extras: Partial<RoleExtras> = {},
  modes: readonly ProviderMode[] | null = null,
  facts: RuntimeFacts = {},
  profileModeId: string | null = null,
  profile: RoleProfile | null = null,
): AgentCreateRequest | undefined {
  const withInstructions = applyRoleInstructions(request, extras, facts);
  const withProfile = applyRoleProfile(withInstructions ?? request, profile) ?? withInstructions;
  return applyRoleMode(withProfile ?? request, modes, profileModeId) ?? withProfile;
}

/**
 * The provider id whose modes are worth a lookup, or `null`. A Worker whose
 * creator already chose a mode keeps it, so it costs no round trip; a
 * Reviewer always needs the list, to recognise a mode it must not run in.
 */
function modeLookupFor(request: AgentCreateRequest): string | null {
  try {
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    const id = providerId(config?.provider);
    if (id === null || !Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id)) return null;
    const role = ROLE_BY_PROVIDER[id]!;
    if (!ROLE_GETS_MODE[role]) return null;
    const chosen = typeof config?.modeId === "string" && config.modeId.trim() !== "";
    return role === "worker" && chosen ? null : id;
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
}> {
  let extras: Partial<RoleExtras> = {};
  try {
    const home = await installHomeOf(paseo);
    if (home !== null) extras = readRoleExtras(home);
  } catch {
    // Without the additions the agent still gets its base instructions.
  }
  const cwd = typeof request?.config?.cwd === "string" ? request.config.cwd : undefined;
  const id = providerId(request?.config?.provider);
  const role = id !== null && Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id) ? ROLE_BY_PROVIDER[id] : undefined;
  // The Worker's or Reviewer's own profile: its mode (bm-msy), and its
  // thinking and features (delta 20260921 §4.1.1). One read, whether or not
  // the mode needs a lookup: a Worker created WITH a mode still gets the
  // thinking set on its profile.
  const profile = role === "worker" || role === "reviewer" ? await profileOf(paseo, id!) : null;
  const lookup = modeLookupFor(request);
  const profileModeId = lookup === null ? null : (profile?.modeId ?? null);
  const modes = lookup === null ? null : await modesFor(paseo, lookup, undefined, cwd);
  const facts = role === undefined ? {} : await runtimeFactsOf(role, paseo, cwd);
  return { extras, modes, facts, profileModeId, profile };
}

function isBmRequest(request: AgentCreateRequest): boolean {
  try {
    const id = providerId((request as Partial<AgentCreateRequest> | null | undefined)?.config?.provider);
    return id !== null && Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id);
  } catch {
    return false;
  }
}

/** The part of the server context this hook needs; `before` is absent on older hosts. */
export type RoleHookHost = Partial<Pick<PluginServerContext, "before">>;

/**
 * Registers the `before("agent.create")` hook and returns its remover. On a
 * host without `before` it logs one line and returns a no-op.
 */
export function registerRoleHook(host: RoleHookHost): () => void {
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
        return applyRoleInstructions(request);
      }
      return applyRoleConfig(request, prepared.extras, prepared.modes, prepared.facts, prepared.profileModeId, prepared.profile);
    })();
  });
  return typeof remove === "function" ? remove : () => {};
}
