import { roleOfProvider } from "./agent-role";
import type { AgentCreateRequest } from "./role-hook";

/** Codex's creation-scoped switch for its provider-native multi-agent tool. */
export const CODEX_NATIVE_DELEGATION_FEATURE = "multi_agent";

/**
 * Prototype provider adapter: disables Codex's native delegation only for a
 * paseo-bm role creation. Returning `undefined` means the request is unchanged,
 * following the convention used by the creation-hook transforms.
 *
 * This is deliberately not wired into `registerRoleHook`: the spike proves the
 * composition point without changing production behaviour.
 */
export function suppressCodexNativeDelegation(
  request: AgentCreateRequest,
  baseProvider: string | null,
): AgentCreateRequest | undefined {
  try {
    const config = request.config;
    if (baseProvider !== "codex" || roleOfProvider(config.provider) === null) return undefined;
    const current = config.featureValues;
    const featureValues =
      current !== null && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>), [CODEX_NATIVE_DELEGATION_FEATURE]: false }
        : { [CODEX_NATIVE_DELEGATION_FEATURE]: false };
    return { ...request, config: { ...config, featureValues } };
  } catch {
    return undefined;
  }
}
