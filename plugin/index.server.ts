import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createMainFallbackRecovery, tellMainOfQuestions } from "./server/mission-tools";
import type { Decision } from "./shared/decisions";
import { MANAGER_INSTRUCTIONS } from "./server/manager-instructions";
import { listWorkspaceAgents } from "./server/manager";
import { registerCollector } from "./server/collector";
import { checkReviewBudget, type BudgetOverrun, type BudgetPaseo } from "./server/review-budget";
import { registerDashboardRpcs } from "./server/dashboard-rpc";
import { registerRoleHook } from "./server/role-hook";
import { startAgentTools, toolsStaleSince } from "./server/agent-tools";
import { createBindingSweep, registerBindingLifecycle } from "./server/agent-bindings";
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
import { checkNoVerdict } from "./server/no-verdict";
import { relayUnboundBlocks } from "./server/unbound-relay";
import { cancelOffToolReviewer, checkOffToolReviewer, registerOffToolAlertClear, registerOffToolTurnCancel } from "./server/off-tool-reviewer";
import { recoverHookBindings, settleCreatedAgent } from "./server/creation-settle";
import { applyReviewCapAnswer } from "./server/review-tools";
import { createReviewBudgetSweep } from "./server/review-budget-sweep";
import { createPlacementLifecycle } from "./server/placement-create";
import { writeCutOver } from "./server/checkpoint";
import { createCheckpointOffers } from "./server/checkpoint-card";
import { createBudgetTold } from "./server/budget-told";
import { registerFormatCheck } from "./server/format-check";
import { registerNoticeQueue, type NoticePaseo } from "./server/notice-queue";
import { createWorkerCreationTools } from "./server/create-worker";
import { startHeldRequests } from "./server/held-requests";
import { replaceOutdatedMains } from "./server/main-upgrade";
import { createOutboxResend } from "./server/outbox";
import { dataHome } from "./server/rpc-kit";
import { registerSetupRpcs } from "./server/setup-rpc";
import { registerRoleSettingsRpcs } from "./server/role-settings-rpc";
import { registerChatRpcs } from "./server/chat-rpc";
import { registerDecisionRpcs, settledByKind, type OnDecisionsSettled } from "./server/decision-rpc";
import { createReplyFallback, registerDecisionAskRpcs } from "./server/decision-ask";
import { registerInboxRpcs } from "./server/inbox-rpc";
import { registerInsightsRpcs } from "./server/insights-rpc";
import { registerSkillsUsageRpcs } from "./server/skills-usage";
import { registerCoordinationRpcs } from "./server/coordination-rpc";
import { registerAutonomyRpcs } from "./server/autonomy-rpc";
import { registerAutonomyLedgerRpcs } from "./server/autonomy-ledger-rpc";
import { registerLinksRpcs } from "./server/links-rpc";
import { registerUpdateRpcs } from "./server/update-check";
import { registerUpdateInstallRpc } from "./server/update-install";
import { createDecisionMaterialiser } from "./server/decision-materialiser";
import { createQuestionDecisionDelivery } from "./server/decision-delivery";
import { registerOrchestratorRpcs } from "./server/orchestrator-rpc";
import { createOrchestratorRetirement } from "./server/orchestrator-agent";
import { createStallWatcher } from "./server/stall-watcher";
import { releaseSettledWaits } from "./server/wake-gate";
import { createConflictWatch } from "./server/governor-conflicts";
import { createGovernor, type GovernorPaseo } from "./server/governor-store";
import { createOrchestratorTools } from "./server/orchestrator-tools";
import { createInterruptionWatch } from "./server/interruption-watch";
import { createOrchestratorDecisionDelivery } from "./server/orchestrator-decisions";
import { createOverrideDelivery } from "./server/override-delivery";
import { actsNoted, createEventBus } from "./server/event-bus";
import { createCompactionRunner } from "./server/compaction";
import { createHandoffRunner } from "./server/handoff";
import { rolloverTurnRecorded } from "./server/rollover";
import { createWritersWatch } from "./server/writers-watch";
import { raiseInboxAlert } from "./server/alert-store";
import { rolePairingAlertOf } from "./server/role-pairing";
import { createOutdatedAgentsPass, registerOutdatedAgents } from "./server/outdated-agents";
import { createInterventionCheck } from "./server/intervention-store";
import { createCoordinationGuard } from "./server/coordination-guard";
import { createActionBoundary } from "./server/action-boundary";
import { registerMissionsHome } from "./server/missions-home";
import { registerMissionsRpcs } from "./server/missions-rpc";
import { adoptComposerManager, createLegacyMigration, handleManagerEnsure } from "./server/mission-legacy";
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
  // Missions design §3.6: manager.ensure opens the Main of the workspace's mission (a one-repo mission made
  // from its Manager, or a new one); a new Main is bound to its own tool path by the endpoint's binder.
  const missionDeps = { binder: () => agentTools.binder, bindings: () => agentTools.bindings };
  server.handle(managerEnsureRpc, async (input, { paseo }) => {
    const result = await handleManagerEnsure(input, paseo, missionDeps);
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
      const result = await handleManagerEnsure({ workspaceId }, paseo as never, missionDeps);
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
  // Autonomy design §A.8, missions design §9.7: the event bus to the Orchestrator. Only the governor's
  // mission events and a danger signal wake it; every event pending at its idle moment goes as ONE
  // BM-EVENTS message, and one whose subject settled before then is dropped. It replaces an Orchestrator
  // that is outdated or has lost its tools before waking it (design §3.3); the check is read when it
  // publishes, after the endpoint below has started.
  const eventBus = createEventBus({ isToolsStale: (agent) => isToolsStale(agent) });
  /** Mission runtime design §4.4: the Main whose Worker asked a question it decides is told at once. */
  const tellMainsOf = (opened: readonly Decision[], paseo: unknown): void => {
    const home = dataHome();
    if (home === null || opened.length === 0) return;
    void tellMainOfQuestions(opened, { home, now: new Date(), log: (message: string) => console.warn(message), paseo });
  };
  // Autonomy design §G.5, missions design §9.5: the compactions the plugin starts itself when a turn
  // crosses its threshold, kept in the data folder; each recorded turn of their target sends the
  // /compact at a safe point, or the BM-STATE brief once the compaction completed, through the notice queue.
  const compactions = createCompactionRunner();
  // Autonomy design §G.6, missions design §9.5: the handoffs the plugin starts itself when a request
  // crosses its threshold, kept in the data folder; each recorded turn takes their next step (the note
  // request at the Worker's safe point, the brief, the command to its Manager), and `agent.created`
  // completes one when its successor appears.
  // Design §16.9: for a bound Manager the runner creates the successor itself, bound by the endpoint's binder.
  const handoffs = createHandoffRunner({ binder: () => agentTools.binder });
  // The stall pass (always on: stalled work is an Inbox alert) and the live
  // Worker watch (its stuck, permission and danger alerts for every project)
  // publish through it, for the projects in the policy's scope only (a danger
  // signal wakes the Orchestrator; the rest are retired as wakes). Neither
  // has a Paseo handle of its own: they keep the last one an `orchestrator.*`
  // call, a paseo-bm creation or a recorded turn brought.
  // Autonomy design §D.2 (ADR-019): the action boundary answers every permission request of a Worker or
  // Reviewer at once — allowed, or held as the owner's decision h:<agentId>:<requestId>. It scans the
  // pending requests at the first Paseo handle of the run and at every Worker pass (events are not replayed).
  const actionBoundary = createActionBoundary();
  // Missions design §9.2, §9.3: the governor's figures and its ladder's code steps, for every open
  // mission each minute (beside the stall pass) and for a mission at each recorded turn of its agents.
  const governor = createGovernor();
  // Missions design §9.6, delivery line design §4.7: conflicts between missions (branches changing one area, links) wake the governor as mission.conflict.
  const conflicts = createConflictWatch();
  // Design §7.17.7: each minute, before the stall pass, the hook bindings of Managers the owner opened are recovered.
  const stallWatcher = createStallWatcher({
    bus: eventBus,
    beforeWorkerPass: (handle) => actionBoundary.scan(handle),
    beforePass: async (handle) => {
      try {
        await recoverHookBindings(handle, { home: dataHome(), bindings: agentTools.bindings });
      } finally {
        // Delivery line design §19.6: held requests whose requests finished start, created as their Main would.
        const home = dataHome();
        if (home !== null) {
          const creation = createWorkerCreationTools({ binder: () => agentTools.binder, paseo: () => handle, home: () => home, log: (message) => console.warn(message) });
          await startHeldRequests(home, { create: (input, caller) => creation.call("bm_create_worker", input, caller), paseo: handle as unknown as NoticePaseo, log: (message) => console.warn(message) });
          // Delivery line design §19.12: a Main on an older paseo-bm's instructions is handed over while idle.
          await replaceOutdatedMains(home, handle, { home, binder: () => agentTools.binder, bindings: () => agentTools.bindings, log: (message) => console.warn(message) });
        }
        // Missions design §9.7: the governor's mission.signal, mission.review and mission.scope wake the Orchestrator.
        await eventBus.governed(await governor.pass(handle), handle);
        await eventBus.publish(await conflicts.pass(), handle);
      }
    },
    // Delivery line design §6.4, §6.5: a wait the pass's dead items met wakes its Worker once, the fact first.
    onWaitsSettled: (settled, handle) => {
      const home = dataHome();
      return home === null ? undefined : releaseSettledWaits(home, settled, { paseo: handle as unknown as NoticePaseo });
    },
  });
  // The agents' block-building tools (ADR-010): one endpoint, given to every bm-* agent created from now on.
  // A decision the Orchestrator decides for the owner (bm_decide, autonomy design §B.5) takes the delivery
  // the owner's answers take: the settlement hook below, read when a call comes, long after this line.
  const agentTools = startAgentTools({
    // Missions design §9.7 (M-26): the Orchestrator's act tools mark the wake they answer as acted.
    orchestrator: actsNoted(createOrchestratorTools({
      onSettled: (decisions, context) => onDecisionsSettled(decisions, context),
      // Autonomy design §G.3: a command or answer is logged against the events of the wake that sent it.
      wakeEventsOf: (orchestratorId) => eventBus.wakeEventsOf(orchestratorId),
      // Missions design §9.6: bm_create_main binds the new Main to its own tool path.
      missions: missionDeps,
    }), eventBus),
    // Design §16.6: a bound Worker's bm_questions opens decisions outside a recorded turn. They wake nothing
    // (missions design §9.1); the handle goes to the bus with any event a mission's window held.
    // Mission runtime design §4.4: a question whose decider is the Main tells that Main at once.
    onDecisionsOpened: (opened, paseo) => {
      tellMainsOf(opened, paseo);
      return eventBus.publish([], paseo);
    },
    // Missions design §4: a Main's bm_answer_worker answers take the delivery the owner's answers take.
    onDecisionsSettled: (decisions, context) => onDecisionsSettled(decisions, context),
    // Missions design §9.6, §9.7: a Main's bm_split_mission wakes the governor as mission.split.
    onMissionSplit: (events, paseo) => eventBus.publish(events, paseo),
  });
  // Orchestrator design §8: the `orchestrator.*` RPCs. An Orchestrator created
  // before the endpoint's stored secret was made has an old URL (§5.1).
  const isToolsStale = toolsStaleSince(agentTools.secretSince);
  // The server gets no Paseo handle of its own: each hook or RPC context brings one. Every one of them is
  // handed to everything that keeps the last handle, so after a plugin reload the first turn start, Inbox
  // read or creation is enough — before, only a paseo-bm creation reached the agents' tools, and the
  // Orchestrator's tools refused every call until a new agent was created.
  // Design §16.5: the per-agent tool bindings. The first handle of a run sweeps away the bindings of
  // agents Paseo no longer lists; an archived agent's binding is revoked (registered below).
  const bindingSweep = createBindingSweep(() => agentTools.bindings);
  // Design §16.7: after a reload, the first handle of the run delivers every pending outbox record again.
  const outboxResend = createOutboxResend({ home: () => dataHome() });
  // Missions design §3.6: the first handle of the run turns each workspace's bound Manager into a one-repo mission.
  const legacyMigration = createLegacyMigration(missionDeps);
  // Delivery line design §8.5: older Orchestrators still labelled main are relabelled retired and retitled,
  // once at the first handle of the run and at each new Orchestrator's agent.created (never archived, ADR-005).
  const orchestratorRetirement = createOrchestratorRetirement();
  // Delivery line design §5.6: the first handle of the run withdraws the open review-budget questions an
  // older build left, once, and tells their Workers.
  const reviewBudgetSweep = createReviewBudgetSweep();
  // Delivery line design §3.3, §3.6: the mission placements are reconciled with Paseo's workspaces at the first
  // handle of the run (then at most every ten minutes); an archived worktree workspace marks its placement archived.
  const placements = createPlacementLifecycle();
  // Delivery line design §4.8: this build's first start is the cut-over (missions/placement-mode.json { since });
  // the owner's checkpoint cards are offered at the first handle of the run, then at most every ten minutes.
  writeCutOver(dataHome(), new Date(), (message) => console.warn(message));
  const checkpoints = createCheckpointOffers();
  const removePlacementArchived =
    typeof server.on === "function" ? server.on("workspace.archived", (event) => placements.archived(event?.workspace?.id)) : () => {};
  const shareHandle = (paseo: unknown): void => {
    void bindingSweep.run(paseo);
    void legacyMigration.run(paseo);
    void orchestratorRetirement.start(paseo);
    void outboxResend.run(paseo);
    void reviewBudgetSweep.run(paseo);
    void placements.run(paseo);
    void checkpoints.run(paseo);
    agentTools.usePaseo(paseo);
    stallWatcher.usePaseo(paseo);
    eventBus.usePaseo(paseo);
    actionBoundary.usePaseo(paseo);
  };
  registerOrchestratorRpcs(server, {
    isToolsStale,
    onPaseo: shareHandle,
  });
  stallWatcher.start();
  const removeRoleHook = registerRoleHook(server, {
    urlFor: (role) => agentTools.urlFor(role),
    usePaseo: shareHandle,
    // Design §16.5: the hook keeps the bound URL of a creation the plugin made itself.
    bindings: agentTools.bindings,
  });
  const removeBindingLifecycle = registerBindingLifecycle(server, () => agentTools.bindings);
  // Missions design §3.1–§3.3: missions.create and mission.ensure create Mains in the Missions home, bound by
  // the endpoint's binder; a Main archived by a cleared conversation is succeeded by the new bm-manager of the home.
  const missionsHome = registerMissionsHome(server, { binder: () => agentTools.binder, bindings: () => agentTools.bindings });
  // Missions design §10.4: the Missions screen reads missions.list, mission.get and memory.list; mission.change is
  // the owner's own change, applied on the m: card's path.
  registerMissionsRpcs(server);
  const removeActionBoundary = actionBoundary.register(server);
  const removeStopPropagation = registerStopPropagation(server);
  // delta 20260918g §4.5: a bm-* agent created without its bm.role label gets it.
  // Design §A.10: a Worker or Reviewer created by the wrong role is an Inbox alert (§A.8).
  // Autonomy design §G.6: a Worker its handoff's Manager created with bm.handoffFrom completes the
  // handoff, and the outgoing Worker is labelled bm.replacedBy (never archived).
  const removeAgentLabels = registerAgentLabels(
    server,
    undefined,
    {
      raiseAlert: (mismatch) => {
        raiseInboxAlert(rolePairingAlertOf(mismatch));
      },
    },
    async (agent, paseo) => {
      // Design §16.4: the request of a new Worker an unbound Manager created is registered at first sight.
      // Design §16.5, §16.8: a Worker or Reviewer the plugin created whose creation a reload or Paseo's late
      // error left unsettled gets its binding and its registry entry now, so it is never taken for off-tool.
      await settleCreatedAgent(agent, paseo, { home: dataHome(), bindings: agentTools.bindings });
      // Missions design §3.3: once its binding settled, a new bm-manager of the Missions home may be a Main's successor.
      await missionsHome.succession.agentCreated(agent, paseo);
      // Missions design §3.6: a composer's bm-manager in a repo workspace is an extra agent, or its mission's Main.
      await adoptComposerManager(agent, paseo, missionDeps);
      // Design §16.8: a Reviewer a bound Worker created outside its tools is an Inbox alert and an
      // off-tool-review signal, and is cancelled at once through the Paseo CLI (spike S5).
      await checkOffToolReviewer(agent, paseo, {
        home: dataHome(),
        bindings: agentTools.bindings,
        publish: (events, handle) => eventBus.publish(events, handle),
        // Not awaited: the handoff check below does not wait for the CLI. It never rejects.
        cancel: async (finding) => {
          void cancelOffToolReviewer(finding);
        },
      });
      // Delivery line design §8.5: a new Orchestrator retires the older ones still labelled main.
      await orchestratorRetirement.agentCreated(agent, paseo);
      return handoffs.agentCreated(agent, paseo);
    },
  );
  // delta 20260921 §4.2.4 (F13): a plugin notice to an agent that may be running
  // (BM-TOOLS, BM-SETTINGS, BM-FALLBACK, BM-DELIVERY) waits in memory for that agent's next
  // turn end. The queue adds no hook of its own: it rides on the BM-FORMAT
  // check's agent.turn_ended hook and runs after it, so a BM-FORMAT notice sent
  // at the same turn end is never replaced by a queued one.
  const noticeQueue = registerNoticeQueue(server);
  // delta 20260918g §4.7: the sender of a BM-* block that breaks its template is told (BM-FORMAT);
  // a bound sender's tool-built block is never checked (design §16.7).
  const removeFormatCheck = registerFormatCheck(noticeQueue.host, undefined, () => agentTools.bindings);
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
  const recoverMainFallbacks = createMainFallbackRecovery();
  const armWaits = (paseo: unknown) => {
    void fallbackWaiter.ensureArmed(paseo);
    syncFallbackDecisionsOnce();
    const home = dataHome();
    if (home !== null) void recoverMainFallbacks({ home, paseo, now: new Date(), log: (message) => console.warn(message) });
    shareHandle(paseo);
  };
  const removeFallbackDetection = registerFallbackDetection(server, {
    onPaseo: armWaits,
    // Design §16.10: once the fallback detection of a bound Reviewer's turn ran, a turn without a
    // verdict sends its Worker one no-verdict delivery per review call. ADR-027 decision 9 (amended):
    // an unbound Worker's BM-REPORT blocks in its reply are relayed to its parent as report records.
    afterDetection: async (event, { paseo, classified }) => {
      const home = dataHome();
      if (home === null || paseo === undefined) return undefined;
      await relayUnboundBlocks(event, {
        home,
        paseo,
        bindings: agentTools.bindings,
        onOpened: (opened, handle) => {
          tellMainsOf(opened, handle);
          return eventBus.publish([], handle);
        },
        onSettled: (decisions, context) => onDecisionsSettled(decisions, context),
      });
      return checkNoVerdict(event, { home, paseo, bindings: agentTools.bindings, classified });
    },
  });
  // Design §16.8: an archived off-tool Reviewer's alert is cleared.
  const removeOffToolAlertClear = registerOffToolAlertClear(server, () => dataHome());
  // Design §16.8 step 4: every turn an off-tool Reviewer starts while its alert is open is cancelled too.
  const removeOffToolTurnCancel = registerOffToolTurnCancel(server, () => dataHome());
  // delta 20260921 §4.4.6: fallback.incidents and fallback.act; a new pending
  // incident becomes the owner's decision f:<incidentId> (autonomy design §A.5 d).
  // "Switch": the plugin creates a replacement Worker (§4.4.7) or Manager
  // (§4.5.2); for a Reviewer it tells the Worker how to create the
  // replacement itself (§4.5.1).
  const switches: Record<FallbackIncident["role"], FallbackAction> = {
    // Design §16.5, §16.6: a replacement Worker or Manager is bound to its own tool path, with its delivering and creating tools.
    worker: createWorkerSwitch({ binder: agentTools.binder }),
    // Design §16.9: a bound Worker's replacement Reviewer is created by the plugin, bound by the endpoint's binder.
    reviewer: createReviewerSwitch({ binder: agentTools.binder, bindings: () => agentTools.bindings }),
    manager: createManagerSwitch({ binder: agentTools.binder }),
  };
  const switchByRole: FallbackAction = (incident, paseo, deps) => switches[incident.role](incident, paseo, deps);
  const fallbackActions: FallbackActions = { switch: switchByRole, wait: fallbackWaiter.wait, resend: createReviewerResend() };
  // ADR-040: a delegated request fallback reaches its Main through the durable channel.
  const removeFallbackRpcs = registerFallbackRpcs(server, fallbackActions, {
    onPaseo: armWaits,
    onDecisionsOpened: (opened, paseo) => {
      tellMainsOf(opened, paseo);
      return eventBus.publish([], paseo);
    },
  });
  // Autonomy design §A.6 (ADR-017): decisions.list / get / answer / confirm. An
  // answered decision is delivered by its asker kind: a fallback decision runs
  // its prepared action through fallback.act's own handler.
  // One settlement hook for every way a decision is answered: the RPCs, the
  // materialiser below, the Orchestrator's bm_decide and bm_ask_owner (above),
  // and a precedent's or the policy's answer at open (§B.5, §B.6); each kind
  // has its own delivery (§A.6).
  // A Worker's answered questions go to it at its next idle moment, one
  // BM-ANSWERS block per request (DQ-2); undelivered ones are resent after a reload.
  const questionDelivery = createQuestionDecisionDelivery();
  const fallbackDelivery = createFallbackDecisionDelivery((input, paseo) => {
    armWaits(paseo);
    return handleFallbackAct(input, paseo, { actions: fallbackActions });
  });
  // An Orchestrator decision delivers its option's prepared command, or hands
  // the owner's words and the grant to the Orchestrator as BM-ANSWER.
  const orchestratorDelivery = createOrchestratorDecisionDelivery();
  // Autonomy design §B.7: the owner's answer to an override reaches the agent the overridden decision's
  // answer reached — a Worker's corrected answer (with a Worker answer's guarantees), or the delivery of an
  // `o:` or `f:` decision.
  const overrideDelivery = createOverrideDelivery({ orchestrator: orchestratorDelivery, fallback: fallbackDelivery });
  const deliverSettled = settledByKind({
    question: questionDelivery.onSettled,
    fallback: fallbackDelivery,
    orchestrator: orchestratorDelivery,
    override: overrideDelivery.onSettled,
    // Autonomy design §D.2: the owner's Allow or Deny of a held request answers it, exactly once.
    held: actionBoundary.onSettled,
  });
  // Delivery line design §5.4: the owner's answer to a request's review-cap decision grants its calls
  // before its answer is delivered. A review-budget answer grants nothing any more (§5.6).
  const onDecisionsSettled: OnDecisionsSettled = (decisions, context) => {
    applyReviewCapAnswer(decisions);
    return deliverSettled(decisions, context);
  };
  registerDecisionRpcs(server, { onSettled: onDecisionsSettled, missions: missionDeps });
  // Change-014 outcome 3 (Ask back): the owner asks the asker of an open q:/o: decision; the BM-ASK
  // notice goes through the notice queue, the asker replies with bm_reply (or BM-REPLY in its chat).
  registerDecisionAskRpcs(server);
  const replyFallback = createReplyFallback();
  // Autonomy PRD §11 rule 3 (design §A.11): a Manager, Worker or Reviewer on
  // older instructions is an `outdated-agent` alert. A throttled pass, started
  // by the Inbox's reads and by turn starts; an archived agent's alert clears.
  const outdatedAgents = createOutdatedAgentsPass();
  const removeOutdatedAgents = registerOutdatedAgents(server, outdatedAgents);
  // Autonomy design §G.3: the Orchestrator's interventions get their outcome from
  // the stores, in a pass throttled like the one above. It adds no hook of its
  // own: it runs at each turn end the collector records (below), once that
  // turn's record is in the store.
  const interventionCheck = createInterventionCheck();
  // Autonomy design §G.3, §G.7: compaction or handoff below A-12's target is switched
  // off, with an Inbox alert, when the check settles one of their entries.
  const coordinationGuard = createCoordinationGuard();
  // Autonomy design §A.12: the Inbox reads its alerts (the stores' producers raise and clear them).
  registerInboxRpcs(server, {
    onRead: (paseo) => {
      shareHandle(paseo);
      return outdatedAgents.run(paseo);
    },
  });
  // Autonomy design §A.12: Insights reads the metric module over the data folder, read-only.
  registerInsightsRpcs(server);
  // Change-014 outcome 4: Tools & skills reads how often reports named each skill, read-only.
  registerSkillsUsageRpcs(server);
  // Autonomy design §G.7: Settings → Coordination, the owner's settings (the advice cadence).
  registerCoordinationRpcs(server);
  // Autonomy design §B.2: Settings → Autonomy, the owner's policy per project and class.
  registerAutonomyRpcs(server);
  // Autonomy design §B.3: the agreement ledger, derived from the decision store, read-only.
  registerAutonomyLedgerRpcs(server);
  // Autonomy design §E.2, §E.4: Work → request → Why?, the chain behind a request, read-only.
  registerLinksRpcs(server);
  // REQ-173: a bounded npm metadata read, cached at most once per local day.
  registerUpdateRpcs(server);
  registerUpdateInstallRpc(server);
  // Autonomy design §A.5 a–c: the BM-QUESTIONS and BM-ANSWERS of a recorded
  // Manager or Worker turn open, supersede and settle stored decisions; §B.3:
  // they record predictions at open and reversals (a re-ask, a cited br reopen).
  // §B.5, §B.6: a question an owner precedent, else the policy's recommended
  // option (a delegated class), answers as it opens takes this same delivery.
  // After each recorded turn, both Worker deliveries note what arrived and, once per run, resend what a reload lost.
  const materialiseDecisions = createDecisionMaterialiser({
    onSettled: onDecisionsSettled,
    afterTurn: async (record, context) => {
      await questionDelivery.afterTurn(record, context);
      await overrideDelivery.afterTurn(record, context);
      // A Worker created before bm_reply answers a BM-ASK in its chat: `BM-REPLY <decisionId>`.
      replyFallback.afterTurn(record);
    },
  });
  // Autonomy design §F.1: two agents writing one file in overlapping turns — an Inbox alert, cleared once
  // the later of the two requests finished, and a writers.observed event (retired as a wake, §9.1; the
  // conflict detection reads it).
  const writersWatch = createWritersWatch();
  // ADR-024: a turn Paseo cut short to deliver a message is not the owner's stop; the agent is told so
  // (BM-INTERRUPTED) when it then sat idle. An owner's deny is read from agent.permission_resolved.
  const interruptions = createInterruptionWatch();
  const removeDenyWatch =
    typeof server.on === "function" ? server.on("agent.permission_resolved", (event) => interruptions.permissionResolved(event)) : () => {};
  const removeCollector = registerCollector(server, {
    // Any agent's turn start brings a handle: the Orchestrator's first turn after a reload included.
    // It also tells the interruption watch that the agent moved on (ADR-024).
    onStarted: (event, paseo) => {
      if (typeof event?.agent?.id === "string") interruptions.turnStarted(event.agent.id);
      if (paseo !== undefined) shareHandle(paseo);
    },
    onRecorded: async (event, { location, paseo, record }) => {
      // Orchestrator design §6B.3: a Worker's signals (and their alerts) hold for its turn only.
      stallWatcher.workerTurnEnded(event?.agent);
      await materialiseDecisions(event, { location, paseo, record });
      coordinationGuard.afterCheck(interventionCheck.run());
      // Alerts need no Paseo handle; the events go with the bus's last one when this turn brought none.
      const collisions = writersWatch.turnRecorded(record, location, typeof event?.agent?.cwd === "string" ? event.agent.cwd : null);
      // Delivery line design §4.7: a collision stays inside a placement; it is no conflict between missions.
      const writersObserved = collisions;
      interruptions.turnRecorded(record, paseo);
      if (paseo === undefined) {
        if (writersObserved.length > 0) await eventBus.publish(writersObserved);
        return undefined;
      }
      shareHandle(paseo);
      const outcome = await checkReviewBudget(event, { location, paseo: paseo as BudgetPaseo, told: budgetTold, pending: budgetPending });
      // Autonomy design §G.5: this turn may be its agent's safe point for a pending compaction, or
      // show the compaction completed (then the BM-STATE brief goes); before the events, which read it.
      await compactions.turnRecorded(event, record, paseo);
      // Autonomy design §G.6: this turn may be a pending handoff's next step; before the events, which read it.
      await handoffs.turnRecorded(event, record, paseo);
      // Delivery line design §2.6: a bound request past its size figures is asked to roll over.
      const home = dataHome();
      if (home !== null) await rolloverTurnRecorded(home, record, paseo);
      // Missions design §9.1: decisions opened and finished requests wake nothing any more; a finish
      // (the Manager's turn or the Worker's own, design §7.17.8 i) only counts toward advice.
      await eventBus.turnRecorded(record, paseo);
      if (writersObserved.length > 0) await eventBus.publish(writersObserved, paseo);
      const governed = await governor.turnRecorded(record, paseo as GovernorPaseo);
      // Missions design §9.7: a recomputation at a mission's turn may wake the Orchestrator too.
      await eventBus.governed(governed === null ? [] : [governed], paseo);
      return outcome;
    },
  });
  return () => {
    removeRoleHook();
    removeBindingLifecycle();
    missionsHome.remove();
    removeActionBoundary();
    removeStopPropagation();
    removeAgentLabels();
    removeOutdatedAgents();
    removeFormatCheck();
    noticeQueue.remove();
    removeFallbackDetection();
    removeOffToolAlertClear();
    removeOffToolTurnCancel();
    removeFallbackRpcs();
    fallbackWaiter.clear();
    removeCollector();
    removeDenyWatch();
    removePlacementArchived();
    stallWatcher.stop();
    void agentTools.close();
  };
}
