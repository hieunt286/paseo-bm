/**
 * Provider id of a provider selection: `bm-worker` and `bm-worker/<model>` both
 * name the `bm-worker` provider. Anything that is not a string yields `null`.
 *
 * Shared by the `agent.create` role hook and the `agent.turn_ended` stop
 * propagation so both recognise paseo-bm roles the same way.
 */
export function providerId(provider: unknown): string | null {
  if (typeof provider !== "string") return null;
  const slash = provider.indexOf("/");
  return slash === -1 ? provider : provider.slice(0, slash);
}
