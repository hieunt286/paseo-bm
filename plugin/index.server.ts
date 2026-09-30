import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_INSTRUCTIONS } from "./server/manager-instructions";
import { ensureManager, listWorkspaceAgents } from "./server/manager";
import { registerCollector } from "./server/collector";
import { checkReviewBudget, type BudgetOverrun, type BudgetPaseo } from "./server/review-budget";
import { registerDashboardRpcs } from "./server/dashboard-rpc";
import { registerRoleHook } from "./server/role-hook";
import { startAgentTools, toolsStaleSince } from "./server/agent-tools";
import { describeRoles } from "./server/roles";
import { registerStopPropagation } from "./server/stop-propagation";
import { registerAgentLabels } from "./server/agent-labels";
import { handleFallbackAct, registerFallbackRpcs, type FallbackActions } from "./server/fallback-rpc";
import { createFallbackDecisionDelivery, createFallbackDecisionStartup } from "./server/fallback-decisions";
import { registerFallbackDetection, replacementsFor } from "./server/fallback-state";
import { createManagerSwitch } from "./server/fallback-manager";
import { createReviewerResend, createReviewerSwitch } from "./server/fallback-reviewer";
import type { FallbackAction } from "./server/fallback-rpc";
import { createWorkerSwitch } from "./server/fallback-switch";
import { createFallbackWaiter } from "./server/fallback-wait";
import { createBudgetTold } from "./server/budget-told";
import { registerFormatCheck } from "./server/format-check";
import { registerNoticeQueue } from "./server/notice-queue";
import { currentInstructions } from "./server/role-extras";
import { registerSetupRpcs } from "./server/setup-rpc";
import { registerRoleSettingsRpcs } from "./server/role-settings-rpc";
import { registerChatRpcs } from "./server/chat-rpc";
import { registerDecisionRpcs, settledByKind } from "./server/decision-rpc";
import { registerInboxRpcs } from "./server/inbox-rpc";
import { registerInsightsRpcs } from "./server/insights-rpc";
import { createDecisionMaterialiser } from "./server/decision-materialiser";
import { createQuestionDecisionDelivery } from "./server/decision-delivery";
import { registerOrchestratorRpcs } from "./server/orchestrator-rpc";
import { createStallWatcher } from "./server/stall-watcher";
import { createOrchestratorTools } from "./server/orchestrator-tools";
import { createOrchestratorDecisionDelivery } from "./server/orchestrator-decisions";
import { createEventBus } from "./server/event-bus";
import { raiseInboxAlert } from "./server/alert-store";
import { rolePairingAlertOf } from "./server/role-pairing";
import { createOutdatedAgentsPass, registerOutdatedAgents } from "./server/outdated-agents";
import { agentsListRpc, managerEnsureRpc, rolesDescribeRpc, type FallbackIncident } from "./shared/contracts";
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
      // The base plus the role's additional instructions, when any.
      readInstructions: () => currentInstructions("manager", paseo),
    });
    if (result.otherManagerIds.length > 0) {
      console.warn(
        `[paseo-bm] workspace ${input.workspaceId} has ${result.otherManagerIds.length + 1} live Managers; using ${result.agentId} (labelled Managers first, then the newest). Left untouched: ${result.otherManagerIds.join(", ")}.`,
      );
    }
    if (result.modeNotice !== null) console.warn(`[paseo-bm] ${result.modeNotice}`);
    if (result.toolsNotice !== null) console.warn(`[paseo-bm] ${result.toolsNotice}`);
    return result;
  });
  // Without this the Dashboard's settings screen cannot read or save anything:
  // `useSettings` on the client calls `settings.paseo-bm.read`, an RPC the HOST
  // only contributes once the server has declared the definition. The owner's
  // daemon log carried eight `Plugin paseo-bm does not contribute RPC
  // settings.paseo-bm.read` errors because this one line was missing
  // (bm-settings-rpc-stgv).
  server.registerSettings(dashboardSettings);
  server.handle(agentsListRpc, async (input, { paseo }) => listWorkspaceAgents(input, { paseo, replacements: replacementsFor() }));
  server.handle(rolesDescribeRpc, (_input, { paseo }) => describeRoles({ paseo }));
  registerDashboardRpcs(server, {
    ensureManager: async (workspaceId, paseo) => {
      const result = await ensureManager({ workspaceId }, { paseo: paseo as never, readInstructions: () => currentInstructions("manager", paseo) });
      // This path shows no launcher notice, so the log is the only place a mode problem surfaces.
      if (result.modeNotice !== null) console.warn(`[paseo-bm] ${result.modeNotice}`);
      if (result.toolsNotice !== null) console.warn(`[paseo-bm] ${result.toolsNotice}`);
      return result;
    },
  });
  registerSetupRpcs(server);
  // delta 20260921 §4.3.2: the read-only data of Roles & models (`roles.settings`, `roles.options`).
  registerRoleSettingsRpcs(server);
  registerChatRpcs(server);
  // Autonomy design §A.8: the event bus to the Orchestrator. Every event of an
  // Autopilot project pending at the Orchestrator's idle moment goes as ONE
  // BM-EVENTS message; an event whose subject settled first is dropped. It
  // replaces an Orchestrator that is outdated or has lost its tools before
  // waking it (design §3.3); the check is read when it publishes, after the
  // endpoint below has started.
  const eventBus = createEventBus({ isToolsStale: (agent) => isToolsStale(agent) });
  // The stall pass (always on: stalled work is an Inbox alert) and the live
  // Worker watch publish through it. Neither has a Paseo handle of its own:
  // they keep the last one an `orchestrator.*` call, a paseo-bm creation or a
  // recorded turn brought.
  const stallWatcher = createStallWatcher({ bus: eventBus });
  // The agents' block-building tools (ADR-010): one endpoint, given to every bm-* agent created from now on.
  const agentTools = startAgentTools({ orchestrator: createOrchestratorTools() });
  // Orchestrator design §8: the `orchestrator.*` RPCs. An Orchestrator created
  // before the endpoint's stored secret was made has an old URL (§5.1).
  const isToolsStale = toolsStaleSince(agentTools.secretSince);
  registerOrchestratorRpcs(server, {
    isToolsStale,
    onPaseo: (paseo) => {
      stallWatcher.usePaseo(paseo);
      eventBus.usePaseo(paseo);
    },
  });
  stallWatcher.start();
  const removeRoleHook = registerRoleHook(server, {
    urlFor: (role) => agentTools.urlFor(role),
    usePaseo: (paseo) => {
      agentTools.usePaseo(paseo);
      stallWatcher.usePaseo(paseo);
      eventBus.usePaseo(paseo);
    },
  });
  const removeStopPropagation = registerStopPropagation(server);
  // delta 20260918g §4.5: a bm-* agent created without its bm.role label gets it.
  // Design §A.10: a Worker or Reviewer created by the wrong role is an Inbox alert (§A.8).
  const removeAgentLabels = registerAgentLabels(server, undefined, {
    raiseAlert: (mismatch) => {
      raiseInboxAlert(rolePairingAlertOf(mismatch));
    },
  });
  // delta 20260921 §4.2.4 (F13): a plugin notice to an agent that may be running
  // (BM-TOOLS, BM-SETTINGS, BM-FALLBACK, BM-DELIVERY) waits in memory for that agent's next
  // turn end. The queue adds no hook of its own: it rides on the BM-FORMAT
  // check's agent.turn_ended hook and runs after it, so a BM-FORMAT notice sent
  // at the same turn end is never replaced by a queued one.
  const noticeQueue = registerNoticeQueue(server);
  // delta 20260918g §4.7: the sender of a BM-* block that breaks its template is told (BM-FORMAT).
  const removeFormatCheck = registerFormatCheck(noticeQueue.host);
  // delta 20260917c §4.7: the plugin counts the review budget and tells the
  // Manager once per request; it never stops an agent.
  // Kept on disk (delta: diagnosis 2026-09-23 fault L5): a reload used to wipe
  // this and the same overrun was announced to the user a second time.
  const budgetTold = createBudgetTold();
  // Only an overrun found at a Worker's or Reviewer's turn end goes in here, and
  // only what is in here may be sent at a Manager's turn end (review b2).
  const budgetPending = new Map<string, BudgetOverrun>();
  // delta 20260921 §4.4.4–§4.4.5: a Worker turn that ends on a provider-plan
  // failure is classified and recorded as a fallback incident. Its own handler,
  // not the collector's onRecorded, so detection never depends on the trace store.
  // §4.4.9 (owner decision Q6 a): one timer per Wait click, set again after a
  // reload at the first hook or fallback RPC that brings an SDK handle.
  const fallbackWaiter = createFallbackWaiter();
  // Autonomy design §A.5 d: pending incidents recorded before this run get their decision once.
  const syncFallbackDecisionsOnce = createFallbackDecisionStartup();
  const armWaits = (paseo: unknown) => {
    void fallbackWaiter.ensureArmed(paseo);
    syncFallbackDecisionsOnce();
  };
  const removeFallbackDetection = registerFallbackDetection(server, { onPaseo: armWaits });
  // delta 20260921 §4.4.6: fallback.incidents and fallback.act; a new pending
  // incident becomes the owner's decision f:<incidentId> (autonomy design §A.5 d).
  // "Switch": the plugin creates a replacement Worker (§4.4.7) or Manager
  // (§4.5.2); for a Reviewer it tells the Worker how to create the
  // replacement itself (§4.5.1).
  const switches: Record<FallbackIncident["role"], FallbackAction> = {
    worker: createWorkerSwitch(),
    reviewer: createReviewerSwitch(),
    manager: createManagerSwitch(),
  };
  const switchByRole: FallbackAction = (incident, paseo, deps) => switches[incident.role](incident, paseo, deps);
  const fallbackActions: FallbackActions = { switch: switchByRole, wait: fallbackWaiter.wait, resend: createReviewerResend() };
  const removeFallbackRpcs = registerFallbackRpcs(server, fallbackActions, { onPaseo: armWaits });
  // Autonomy design §A.6 (ADR-017): decisions.list / get / answer / confirm. An
  // answered decision is delivered by its asker kind: a fallback decision runs
  // its prepared action through fallback.act's own handler.
  // One settlement hook for every way a decision is answered: the RPCs and the
  // materialiser below; each kind has its own delivery (§A.6).
  // A Worker's answered questions go to it at its next idle moment, one
  // BM-ANSWERS block per request (DQ-2); undelivered ones are resent after a reload.
  const questionDelivery = createQuestionDecisionDelivery();
  const onDecisionsSettled = settledByKind({
    question: questionDelivery.onSettled,
    fallback: createFallbackDecisionDelivery((input, paseo) => {
      armWaits(paseo);
      return handleFallbackAct(input, paseo, { actions: fallbackActions });
    }),
    // An Orchestrator decision delivers its option's prepared command, or hands
    // the owner's words and the grant to the Orchestrator as BM-ANSWER.
    orchestrator: createOrchestratorDecisionDelivery(),
  });
  registerDecisionRpcs(server, { onSettled: onDecisionsSettled });
  // Autonomy PRD §11 rule 3 (design §A.11): a Manager, Worker or Reviewer on
  // older instructions is an `outdated-agent` alert. A throttled pass, started
  // by the Inbox's reads and by turn starts; an archived agent's alert clears.
  const outdatedAgents = createOutdatedAgentsPass();
  const removeOutdatedAgents = registerOutdatedAgents(server, outdatedAgents);
  // Autonomy design §A.12: the Inbox reads its alerts (the stores' producers raise and clear them).
  registerInboxRpcs(server, { onRead: (paseo) => outdatedAgents.run(paseo) });
  // Autonomy design §A.12: Insights reads the metric module over the data folder, read-only.
  registerInsightsRpcs(server);
  // Autonomy design §A.5 a–c: the BM-QUESTIONS and BM-ANSWERS of a recorded
  // Manager or Worker turn open, supersede and settle stored decisions.
  const materialiseDecisions = createDecisionMaterialiser({ onSettled: onDecisionsSettled, afterTurn: questionDelivery.afterTurn });
  const removeCollector = registerCollector(server, {
    onRecorded: async (event, { location, paseo, record }) => {
      // Orchestrator design §6B.3: a Worker's signals (and their alerts) hold for its turn only.
      stallWatcher.workerTurnEnded(event?.agent);
      const materialised = await materialiseDecisions(event, { location, paseo, record });
      if (paseo === undefined) return undefined;
      stallWatcher.usePaseo(paseo);
      const outcome = await checkReviewBudget(event, { location, paseo: paseo as BudgetPaseo, told: budgetTold, pending: budgetPending });
      // Autonomy design §A.8: a new Worker question or a finished step of an
      // Autopilot project is an event for the Orchestrator, batched with the rest.
      await eventBus.turnRecorded(record, materialised?.opened ?? [], paseo);
      return outcome;
    },
  });
  return () => {
    removeRoleHook();
    removeStopPropagation();
    removeAgentLabels();
    removeOutdatedAgents();
    removeFormatCheck();
    noticeQueue.remove();
    removeFallbackDetection();
    removeFallbackRpcs();
    fallbackWaiter.clear();
    removeCollector();
    stallWatcher.stop();
    void agentTools.close();
  };
}
