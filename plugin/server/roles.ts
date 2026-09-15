/**
 * `roles.describe` on the daemon side (design §5, REQ-032d; errata bm-dnc).
 *
 * The answer comes from the configuration Paseo has in effect right now, read
 * through the plugin SDK's `paseo.config.get()` — not from `install.json`. The
 * server entry runs as a CommonJS bundle in a worker that knows nothing about
 * where the payload or the install home live, so reading a file is not an
 * option; the daemon configuration is also exactly what Paseo uses when it
 * starts a role, so it works for any install home.
 *
 * SDK facts this relies on (checked, not guessed):
 * - `PaseoApi.config.get(): Promise<{ requestId; config: MutableDaemonConfig }>`
 *   (@getpaseo/client 0.8.0 `dist/index.d.ts`, `PaseoConfigActions`).
 * - `MutableDaemonConfig.providers` is the daemon's view of `agents.providers`
 *   (a loose record: `paseoTools?: { enabled?: boolean }`, plus pass-through
 *   keys such as `extends`); `MutableDaemonConfig.agentProfiles` is
 *   `daemon.agentProfiles` (`{ id, provider, model?, … }[]`)
 *   (@getpaseo/protocol 0.8.0 `dist/messages.d.ts`, `MutableDaemonConfigSchema`).
 * - The Paseo 0.8 daemon fills `providers` from `agents.providers` parsed with
 *   `ProviderOverrideSchema`, which declares `extends`.
 *
 * Read-only: nothing is patched.
 */
import type { BmRole, RoleDescriptor } from "../shared/contracts";

const ROLE_ORDER: readonly BmRole[] = ["manager", "worker", "reviewer"];

/** Derived provider id and agent profile id of a role, as the installer registers them (ADR-006). */
export function roleConfigId(role: BmRole): string {
  return `bm-${role}`;
}

/** Name of a role's instructions inside the payload (embedded in the bundle for the Manager). */
export function roleInstructionsName(role: BmRole): string {
  return `roles/${role}.md`;
}

/** Minimal SDK view `roles.describe` needs. `PaseoApi` is structurally assignable. */
export interface RolesConfigPaseo {
  config: {
    get(): Promise<{
      config: {
        providers?: Record<string, unknown>;
        agentProfiles?: ReadonlyArray<{ id: string; provider: string; model?: string }>;
      };
    }>;
  };
}

export interface DescribeRolesDeps {
  paseo: RolesConfigPaseo;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Handler body of `roles.describe`.
 *
 * For each role, in the order manager, worker, reviewer:
 * - `provider` is `extends` of the derived provider `agents.providers.bm-<role>`
 *   (the user's own tool), or `""` when the entry or the key is missing;
 * - `model` is `model` of the agent profile `bm-<role>`, or `""`;
 * - `paseoTools` is true only when `paseoTools.enabled === true` on the derived
 *   provider (the shape Paseo stores; an absent key means not granted);
 * - `instructionsPath` is the instructions name, e.g. `roles/manager.md`.
 *
 * A role with neither a derived provider nor a profile is not registered and
 * is left out, so a daemon without paseo-bm roles yields `{ roles: [] }`.
 */
export async function describeRoles(deps: DescribeRolesDeps): Promise<{ roles: RoleDescriptor[] }> {
  const { config } = await deps.paseo.config.get();
  const providers = asRecord(config.providers) ?? {};
  const profiles = config.agentProfiles ?? [];

  const roles: RoleDescriptor[] = [];
  for (const role of ROLE_ORDER) {
    const id = roleConfigId(role);
    const provider = asRecord(providers[id]);
    const profile = profiles.find((entry) => entry.id === id);
    if (!provider && !profile) continue;

    const base = provider?.["extends"];
    roles.push({
      role,
      provider: typeof base === "string" ? base : "",
      model: typeof profile?.model === "string" ? profile.model : "",
      paseoTools: asRecord(provider?.["paseoTools"])?.["enabled"] === true,
      instructionsPath: roleInstructionsName(role),
    });
  }
  return { roles };
}
