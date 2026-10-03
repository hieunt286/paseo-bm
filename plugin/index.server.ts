import type { PluginServerContext } from "@getpaseo/plugin/server";
import { MANAGER_INSTRUCTIONS } from "./server/manager-instructions";
import { ensureManager, listWorkspaceAgents } from "./server/manager";
import { registerCollector } from "./server/collector";
import { checkReviewBudget, type BudgetOverrun, type BudgetPaseo } from "./server/review-budget";
import { registerDashboardRpcs } from "./server/dashboard-rpc";
import { registerRoleHook } from "./server/role-hook";
import { startAgentTools, toolsStaleSince } from "./server/agent-tools";
import { createBindingSweep, registerBindingLifecycle } from "./server/agent-bindings";
import { sightCreatedWorker } from "./server/request-registry";
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
import { createOutboxResend } from "./server/outbox";
import { dataHome } from "./server/rpc-kit";
import { currentInstructions } from "./server/role-instructions";
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
import { createDecisionMaterialiser } from "./server/decision-materialiser";
import { createQuestionDecisionDelivery } from "./server/decision-delivery";
import { registerOrchestratorRpcs } from "./server/orchestrator-rpc";
import { createStallWatcher } from "./server/stall-watcher";
import { createOrchestratorTools } from "./server/orchestrator-tools";
import { createInterruptionWatch } from "./server/interruption-watch";
import { createOrchestratorDecisionDelivery } from "./server/orchestrator-decisions";
import { createOverrideDelivery } from "./server/override-delivery";
import { createEventBus } from "./server/event-bus";
import { createCompactionRunner } from "./server/compaction";
import { createHandoffRunner } from "./server/handoff";
import { createWritersWatch } from "./server/writers-watch";
import type { DashboardPaseo } from "./server/paseo-directory";
import { unverifiedFinishesOf } from "./server/request-trace";
import { raiseInboxAlert } from "./server/alert-store";
import { rolePairingAlertOf } from "./server/role-pairing";
import { createOutdatedAgentsPass, registerOutdatedAgents } from "./server/outdated-agents";
import { createInterventionCheck } from "./server/intervention-store";
import { createCoordinationGuard } from "./server/coordination-guard";
import { createActionBoundary } from "./server/action-boundary";
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
      // The base, the Runtime facts with the workspace's precedents, and the role's additional instructions, when any.
      readInstructions: (workspaceId) => currentInstructions("manager", paseo, { workspaceId }),
      // Design §16.5, §16.6: a new Manager is bound to its own tool path, with bm_create_worker.
      binder: agentTools.binder,
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
      const result = await ensureManager(
        { workspaceId },
        { paseo: paseo as never, readInstructions: (id) => currentInstructions("manager", paseo, { workspaceId: id }), binder: agentTools.binder },
      );
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
  // Autonomy design §A.8: the event bus to the Orchestrator. Every event pending
  // at the Orchestrator's idle moment goes as ONE BM-EVENTS message; an event
  // whose subject settled, or whose project left the policy's scope (a class
  // above `owner`, §B.2), before then is dropped. It replaces an Orchestrator
  // that is outdated or has lost its tools before waking it (design §3.3); the
  // check is read when it publishes, after the endpoint below has started.
  const eventBus = createEventBus({ isToolsStale: (agent) => isToolsStale(agent) });
  // Autonomy design §G.5: the compactions the Orchestrator asks for with bm_compact, kept in the
  // data folder; each recorded turn of their target sends the /compact at a safe point, or the
  // BM-STATE brief once the compaction completed, through the notice queue.
  const compactions = createCompactionRunner();
  // Autonomy design §G.6: the handoffs the Orchestrator asks for with bm_handoff, kept in the data
  // folder; each recorded turn takes their next step (the note request at the Worker's safe point,
  // the brief, the command to its Manager), and `agent.created` completes one when its successor appears.
  // Design §16.9: for a bound Manager the runner creates the successor itself, bound by the endpoint's binder.
  const handoffs = createHandoffRunner({ binder: () => agentTools.binder });
  // The stall pass (always on: stalled work is an Inbox alert) and the live
  // Worker watch (its stuck, permission and danger alerts for every project)
  // publish through it, for the projects in the policy's scope only. Neither
  // has a Paseo handle of its own: they keep the last one an `orchestrator.*`
  // call, a paseo-bm creation or a recorded turn brought.
  // Autonomy design §D.2 (ADR-019): the action boundary answers every permission request of a Worker or
  // Reviewer at once — allowed, or held as the owner's decision h:<agentId>:<requestId>. It scans the
  // pending requests at the first Paseo handle of the run and at every Worker pass (events are not replayed).
  const actionBoundary = createActionBoundary();
  const stallWatcher = createStallWatcher({ bus: eventBus, beforeWorkerPass: (handle) => actionBoundary.scan(handle) });
  // The agents' block-building tools (ADR-010): one endpoint, given to every bm-* agent created from now on.
  // A decision the Orchestrator decides for the owner (bm_decide, autonomy design §B.5) takes the delivery
  // the owner's answers take: the settlement hook below, read when a call comes, long after this line.
  const agentTools = startAgentTools({
    orchestrator: createOrchestratorTools({
      onSettled: (decisions, context) => onDecisionsSettled(decisions, context),
      // Autonomy design §G.3: a command or answer is logged against the events of the wake that sent it.
      wakeEventsOf: (orchestratorId) => eventBus.wakeEventsOf(orchestratorId),
      // Autonomy design §G.5: bm_compact hands its compaction to the runner the turn ends below advance.
      compaction: compactions,
      // Autonomy design §G.6: bm_handoff hands its handoff to the runner the turn ends below advance.
      handoff: handoffs,
    }),
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
  // Design §16.7: after a reload, the first handle of the run delivers every pending or queued outbox record again.
  const outboxResend = createOutboxResend({ home: () => dataHome() });
  const shareHandle = (paseo: unknown): void => {
    void bindingSweep.run(paseo);
    void outboxResend.run(paseo);
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
      await sightCreatedWorker(agent, paseo);
      return handoffs.agentCreated(agent, paseo);
    },
  );
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
    shareHandle(paseo);
  };
  const removeFallbackDetection = registerFallbackDetection(server, { onPaseo: armWaits });
  // delta 20260921 §4.4.6: fallback.incidents and fallback.act; a new pending
  // incident becomes the owner's decision f:<incidentId> (autonomy design §A.5 d).
  // "Switch": the plugin creates a replacement Worker (§4.4.7) or Manager
  // (§4.5.2); for a Reviewer it tells the Worker how to create the
  // replacement itself (§4.5.1).
  const switches: Record<FallbackIncident["role"], FallbackAction> = {
    // Design §16.5, §16.6: a replacement Worker or Manager is bound to its own tool path, with the creation tools.
    worker: createWorkerSwitch({ binder: agentTools.binder }),
    reviewer: createReviewerSwitch(),
    manager: createManagerSwitch({ binder: agentTools.binder }),
  };
  const switchByRole: FallbackAction = (incident, paseo, deps) => switches[incident.role](incident, paseo, deps);
  const fallbackActions: FallbackActions = { switch: switchByRole, wait: fallbackWaiter.wait, resend: createReviewerResend() };
  // Autonomy design §A.8, §B.9: a new incident's decision the owner's policy asks the Orchestrator
  // to decide (bm_decide) or predict (bm_predict) is a decision.opened event, as a Worker's question is.
  const removeFallbackRpcs = registerFallbackRpcs(server, fallbackActions, {
    onPaseo: armWaits,
    onDecisionsOpened: (opened, paseo) => eventBus.decisionsOpened(opened, paseo),
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
  const onDecisionsSettled: OnDecisionsSettled = deliverSettled;
  registerDecisionRpcs(server, { onSettled: onDecisionsSettled });
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
  // the later of the two requests finished, and a writers.observed event (in the policy's scope).
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
      const materialised = await materialiseDecisions(event, { location, paseo, record });
      coordinationGuard.afterCheck(interventionCheck.run());
      // Alerts need no Paseo handle; the events go with the bus's last one when this turn brought none.
      const writersObserved = writersWatch.turnRecorded(record, location, typeof event?.agent?.cwd === "string" ? event.agent.cwd : null);
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
      // Autonomy design §A.8: a new Worker question the policy asks the Orchestrator to
      // decide or predict (§B.9, per cell) or a finished step of a project in the
      // policy's scope is an event for the Orchestrator, batched with the rest.
      // Autonomy design §C.3: a finished report that leaves its request finished-unverified
      // (read from the request's records, now written) is an event too, and says so.
      const isUnverified = await unverifiedFinishesOf({ location, paseo: paseo as DashboardPaseo }, record);
      await eventBus.turnRecorded(record, materialised?.opened ?? [], paseo, isUnverified);
      if (writersObserved.length > 0) await eventBus.publish(writersObserved, paseo);
      return outcome;
    },
  });
  return () => {
    removeRoleHook();
    removeBindingLifecycle();
    removeActionBoundary();
    removeStopPropagation();
    removeAgentLabels();
    removeOutdatedAgents();
    removeFormatCheck();
    noticeQueue.remove();
    removeFallbackDetection();
    removeFallbackRpcs();
    fallbackWaiter.clear();
    removeCollector();
    removeDenyWatch();
    stallWatcher.stop();
    void agentTools.close();
  };
}
