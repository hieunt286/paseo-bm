import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_INSTRUCTIONS } from "./server/manager-instructions";
import { ensureManager, listWorkspaceAgents } from "./server/manager";
import { registerRoleHook } from "./server/role-hook";
import { describeRoles } from "./server/roles";
import { agentsListRpc, managerEnsureRpc, rolesDescribeRpc } from "./shared/contracts";

/**
 * Text of `roles/manager.md`.
 *
 * Embedded at build time (scripts/generate-role-instructions.mjs), never read
 * from disk: Paseo 0.8 compiles this entry into a CommonJS bundle and runs it
 * in a forked worker without a cwd, so this code has no way to know where its
 * payload lives (bm-dnc). Nothing in the server entry may depend on file
 * locations at run time.
 */
export function readManagerInstructions(): Promise<string> {
  return Promise.resolve(MANAGER_INSTRUCTIONS);
}

/**
 * Server entry of the paseo-bm plugin.
 *
 * WP-112 registers `manager.ensure`, `agents.list` and `roles.describe`. All
 * three only read or create; there is deliberately no RPC that deletes or archives agents:
 * their lifecycle belongs to the user (ADR-005).
 *
 * It also registers a `before("agent.create")` hook that puts the role
 * instructions into the system prompt of every `bm-manager`, `bm-worker` and
 * `bm-reviewer` agent, whoever creates it: Paseo's `create_agent` tool has no
 * system-prompt parameter (bm-hld). The returned cleanup removes that hook.
 *
 * This entry must never import from `client/`: that is a compile error.
 *
 * Declared as a hoisted `export default function`, not `const` + `export
 * default`: Paseo 0.8 rewrites esbuild's export getters into eager copies
 * (makeHermesInteropEager), so a late-bound default export is copied while
 * still undefined and the daemon refuses the plugin ("must default export a
 * function"). Guarded by test/plugin-bundle-cjs.test.ts.
 */
export default function contribute(server: PluginServerContext): () => void {
  server.handle(managerEnsureRpc, async (input, { paseo }) => {
    const result = await ensureManager(input, {
      paseo,
      readInstructions: readManagerInstructions,
    });
    if (result.otherManagerIds.length > 0) {
      console.warn(
        `[paseo-bm] workspace ${input.workspaceId} has ${result.otherManagerIds.length + 1} live Managers; using the newest (${result.agentId}). Left untouched: ${result.otherManagerIds.join(", ")}.`,
      );
    }
    return result;
  });
  server.handle(agentsListRpc, (input, { paseo }) => listWorkspaceAgents(input, { paseo }));
  server.handle(rolesDescribeRpc, (_input, { paseo }) => describeRoles({ paseo }));
  const removeRoleHook = registerRoleHook(server);
  return () => {
    removeRoleHook();
  };
}
