import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_INSTRUCTIONS } from "./server/manager-instructions";
import { ensureManager, listWorkspaceAgents } from "./server/manager";
import { registerCollector } from "./server/collector";
import { checkReviewBudget, type BudgetOverrun, type BudgetPaseo } from "./server/review-budget";
import { registerDashboardRpcs } from "./server/dashboard-rpc";
import { registerRoleHook } from "./server/role-hook";
import { describeRoles } from "./server/roles";
import { registerStopPropagation } from "./server/stop-propagation";
import { registerAgentLabels } from "./server/agent-labels";
import { registerFormatCheck } from "./server/format-check";
import { currentInstructions } from "./server/role-extras";
import { registerSetupRpcs } from "./server/setup-rpc";
import { registerChatRpcs } from "./server/chat-rpc";
import { agentsListRpc, managerEnsureRpc, rolesDescribeRpc } from "./shared/contracts";
import { dashboardSettings } from "./shared/settings";

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
 * WP-208 and WP-210 add the Dashboard RPCs (`beads.stats`, `traces.delete`);
 * `traces.delete` is the only handler in the plugin that removes anything, and
 * it only ever removes paseo-bm's own trace records.
 *
 * WP-205 adds the trace collector: `agent.turn_started` and `agent.turn_ended`
 * hooks that write one record per `bm-*` agent turn into the trace store, so the
 * Dashboard has history that outlives the agents themselves (ADR-007). It
 * resolves the store itself from the hook context and can never throw into an
 * agent turn.
 *
 * It also registers a `before("agent.create")` hook that puts the role
 * instructions into the system prompt of every `bm-manager`, `bm-worker` and
 * `bm-reviewer` agent, whoever creates it: Paseo's `create_agent` tool has no
 * system-prompt parameter (bm-hld). It also registers an `on("agent.turn_ended")`
 * hook that sends a stop notice to the running Reviewers of a Worker the user
 * stopped (bm-wq6, REQ-026f). The returned cleanup removes every hook.
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
      // The base plus the user's additions from the Setup screen, when any.
      readInstructions: () => currentInstructions("manager", paseo),
    });
    if (result.otherManagerIds.length > 0) {
      console.warn(
        `[paseo-bm] workspace ${input.workspaceId} has ${result.otherManagerIds.length + 1} live Managers; using ${result.agentId} (labelled Managers first, then the newest). Left untouched: ${result.otherManagerIds.join(", ")}.`,
      );
    }
    if (result.modeNotice !== null) console.warn(`[paseo-bm] ${result.modeNotice}`);
    return result;
  });
  // Without this the Dashboard's settings screen cannot read or save anything:
  // `useSettings` on the client calls `settings.paseo-bm.read`, an RPC the HOST
  // only contributes once the server has declared the definition. The owner's
  // daemon log carried eight `Plugin paseo-bm does not contribute RPC
  // settings.paseo-bm.read` errors because this one line was missing
  // (bm-settings-rpc-stgv).
  server.registerSettings(dashboardSettings);
  server.handle(agentsListRpc, (input, { paseo }) => listWorkspaceAgents(input, { paseo }));
  server.handle(rolesDescribeRpc, (_input, { paseo }) => describeRoles({ paseo }));
  registerDashboardRpcs(server, {
    ensureManager: async (workspaceId, paseo) => {
      const result = await ensureManager({ workspaceId }, { paseo: paseo as never, readInstructions: () => currentInstructions("manager", paseo) });
      // This path shows no launcher notice, so the log is the only place a mode problem surfaces.
      if (result.modeNotice !== null) console.warn(`[paseo-bm] ${result.modeNotice}`);
      return result;
    },
  });
  registerSetupRpcs(server);
  registerChatRpcs(server);
  const removeRoleHook = registerRoleHook(server);
  const removeStopPropagation = registerStopPropagation(server);
  // delta 20260918g §4.5: a bm-* agent created without its bm.role label gets it.
  const removeAgentLabels = registerAgentLabels(server);
  // delta 20260918g §4.7: the sender of a BM-* block that breaks its template is told (BM-FORMAT).
  const removeFormatCheck = registerFormatCheck(server);
  // delta 20260917c §4.7: the plugin counts the review budget and tells the
  // Manager once per request; it never stops an agent.
  const budgetTold = new Set<string>();
  // Only an overrun found at a Worker's or Reviewer's turn end goes in here, and
  // only what is in here may be sent at a Manager's turn end (review b2).
  const budgetPending = new Map<string, BudgetOverrun>();
  const removeCollector = registerCollector(server, {
    onRecorded: (event, { location, paseo }) =>
      paseo === undefined
        ? undefined
        : checkReviewBudget(event, { location, paseo: paseo as BudgetPaseo, told: budgetTold, pending: budgetPending }),
  });
  return () => {
    removeRoleHook();
    removeStopPropagation();
    removeAgentLabels();
    removeFormatCheck();
    removeCollector();
  };
}
