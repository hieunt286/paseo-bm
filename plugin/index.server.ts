import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_INSTRUCTIONS } from "./server/manager-instructions";
import { ensureManager, listWorkspaceAgents } from "./server/manager";
import { describeRoles } from "./server/roles";
import { agentsListRpc, managerEnsureRpc, rolesDescribeRpc } from "./shared/contracts";

type ServerContribution = (server: PluginServerContext) => () => void;

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
 * This entry must never import from `client/`: that is a compile error.
 */
const contribute: ServerContribution = (server) => {
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
  return () => {};
};

export default contribute;
