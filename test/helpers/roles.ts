import type { ManagerAgentProfile } from "../../plugin/server/manager";
import { rolePaseoToolsPolicy } from "../../plugin/server/setup-roles";

/** The four roles, in the order a set-up machine lists them. */
export const ROLES = ["manager", "worker", "reviewer", "orchestrator"] as const;
export type Role = (typeof ROLES)[number];

const LABELS: Record<Role, string> = { manager: "Beads Manager", worker: "Beads Worker", reviewer: "Beads Reviewer", orchestrator: "Beads Orchestrator" };

/** The `bm-<role>` provider aliases of a machine that has been set up (design §6.1; orchestrator design §3.1), each extending `base`. */
export function roleAliases(base = "codex", roles: readonly Role[] = ROLES): Record<string, unknown> {
  return Object.fromEntries(roles.map((role) => [`bm-${role}`, { extends: base, label: LABELS[role], paseoTools: rolePaseoToolsPolicy(role) }]));
}

/** The `bm-<role>` agent profiles, each on its alias with `model`. */
export function roleProfiles(model = "gpt-5.6-sol", roles: readonly Role[] = ROLES): ManagerAgentProfile[] {
  return roles.map((role) => ({ id: `bm-${role}`, provider: `bm-${role}`, model }));
}
