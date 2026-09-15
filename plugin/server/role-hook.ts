import type { PluginBeforeRequests, PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_INSTRUCTIONS } from "./manager-instructions";
import { providerId } from "./provider-id";
import { REVIEWER_INSTRUCTIONS } from "./reviewer-instructions";
import { WORKER_INSTRUCTIONS } from "./worker-instructions";

/**
 * Role instructions injected into every paseo-bm agent at creation (bm-hld).
 *
 * Paseo's `create_agent` tool has no system-prompt parameter, so a Worker the
 * Manager creates, or a Reviewer the Worker creates, would otherwise start
 * without its role contract. The daemon runs `before("agent.create")` hooks for
 * every agent creation, whoever asks for it, so the plugin sets the prompt
 * there, keyed by the provider id.
 */
export const ROLE_INSTRUCTIONS_BY_PROVIDER: Readonly<Record<string, string>> = {
  "bm-manager": MANAGER_INSTRUCTIONS,
  "bm-worker": WORKER_INSTRUCTIONS,
  "bm-reviewer": REVIEWER_INSTRUCTIONS,
};

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
export function applyRoleInstructions(request: AgentCreateRequest): AgentCreateRequest | undefined {
  try {
    // Typed as required, but never trusted: a malformed request must not throw.
    const config = (request as Partial<AgentCreateRequest> | null | undefined)?.config;
    if (config === null || typeof config !== "object") return undefined;
    const id = providerId(config.provider);
    if (id === null || !Object.prototype.hasOwnProperty.call(ROLE_INSTRUCTIONS_BY_PROVIDER, id)) return undefined;
    const instructions = ROLE_INSTRUCTIONS_BY_PROVIDER[id]!;

    const existing = typeof config.systemPrompt === "string" ? config.systemPrompt : "";
    if (existing.includes(instructions)) return undefined;
    const systemPrompt = existing.trim() === "" ? instructions : `${instructions}${ROLE_PROMPT_SEPARATOR}${existing}`;
    return { ...request, config: { ...config, systemPrompt } };
  } catch {
    return undefined;
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
  const remove = host.before("agent.create", (input) =>
    applyRoleInstructions((input as { request?: AgentCreateRequest } | undefined)?.request as AgentCreateRequest),
  );
  return typeof remove === "function" ? remove : () => {};
}
