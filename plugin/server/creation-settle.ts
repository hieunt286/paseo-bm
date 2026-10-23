/**
 * The plugin's own creations, settled at `agent.created` (design §16.5,
 * §16.8; ADR-027 decisions 3 and 10).
 *
 * A Worker or Reviewer the plugin creates is settled when `agents.create`
 * returns: its binding bound, the registry told (`createBound`,
 * `bm_create_worker`, `bm_create_reviewer`). Two things can cut that short
 * after Paseo created the agent: a plugin reload in the middle of the
 * creation, and an `agents.create` that rejects although the agent exists.
 * The binding is then left `pending` (attached: `BindingStore.discard` keeps
 * it), the registry's create call has an empty `reviewerId`, and the new
 * Reviewer would be flagged off-tool. So at `agent.created` of a Worker or a
 * Reviewer (`settleCreatedAgent`), before the off-tool check:
 *
 * - **the hand path's request** (a Worker, §16.4): the request its
 *   `bm.requestId` label names is registered when its creator is unbound
 *   (`sightRequestId`), from the same snapshot read;
 * - **the binding**: the one attached `pending` binding of its role, parent
 *   and workspace — and its `bm.batchId` (a Reviewer) or `bm.requestId` (a
 *   Worker) label — is bound to it (`BindingStore.settleCreated`); a Worker
 *   settled here is added to its request's Workers;
 * - **the registry** (a Reviewer): a create call of its labelled batch with
 *   an empty `reviewerId` gets it (`noteReviewer`) once no creation of its
 *   Worker is under way in this run (`pluginCreationsSettled`) — when the
 *   binding settled here proves it, or its parent is the request's Worker.
 *   A Reviewer its batch already names (`createPluginReviewer` names its
 *   own before the creation counts as done) is left as it is.
 *
 * A Reviewer settled either way is the plugin's own — named in its batch —
 * never off-tool.
 *
 * A **Manager** the owner opened from Paseo's composer was bound by the
 * creation hook (design §7.17.7), and its session's opening recorded its id on
 * that binding (`claimedBy`, `BindingStore.claimHook`): at its `agent.created`
 * the attached `pending` hook binding it claimed — the one whose token it
 * holds — is bound to it, when it carries no `bm.version` label. Another
 * Manager of the workspace never takes it. The **recovery pass**
 * (`recoverHookBindings`, on the stall pass's minute) settles a claimed hook
 * binding still `pending` to the Manager that claimed it, when that Manager is
 * live, without a binding or a `bm.version` label; a claimed hook binding that
 * expired unsettled raises `outdated-agent` for that Manager. A hook binding
 * no session claimed (the creation failed before Paseo opened the agent's
 * session) is never settled, and goes without an alert when it expires.
 *
 * Nothing here throws into the event handler.
 */
import { listAllAgents, parentOf, roleOfAgent, roleOfProvider } from "./agent-role";
import type { AgentBinding, BindingStore } from "./agent-bindings";
import { createAlertStore } from "./alert-store";
import { REPLACED_BY_LABEL } from "./fallback-detect";
import { VERSION_LABEL } from "./manager";
import { unboundManagerAlertOf } from "./outdated-agents";
import { REQUEST_ID_LABEL, createRequestRegistry, isEmptyCreateCall, sightRequestId } from "./request-registry";
import { pluginCreationsSettled } from "./review-tools";
import { asRecord, nonEmpty, reasonOf } from "./role-choices";

/** The new agent as `agent.created` names it. */
export interface SettledAgent {
  id: string;
  provider: unknown;
  parentAgentId: string | null;
  workspaceId: string | null;
}

export interface CreationSettleDeps {
  /** The data folder. */
  home: string | null;
  /** The per-agent bindings. */
  bindings: BindingStore | null;
  log?: (message: string) => void;
}

/** The agent's labels, from its snapshot; none when it cannot be read. */
async function labelsOf(paseo: unknown, agentId: string): Promise<Record<string, unknown>> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<{ agent?: unknown } | null> } } } | null)?.agents?.ref?.(agentId);
    return asRecord(asRecord((await ref?.refresh?.())?.agent)?.["labels"]) ?? {};
  } catch {
    return {};
  }
}

/** Settles a new Worker or Reviewer the plugin may have created, or a Manager the hook bound (see the module comment). Never throws. */
export async function settleCreatedAgent(agent: SettledAgent, paseo: unknown, deps: CreationSettleDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const role = roleOfProvider(agent.provider);
    if (role === "manager" && deps.home !== null) {
      settleCreatedManager(agent, await labelsOf(paseo, agent.id), deps.bindings, log);
      return;
    }
    if ((role !== "worker" && role !== "reviewer") || deps.home === null) return;
    const labels = await labelsOf(paseo, agent.id);
    const parentId = parentOf({ parentAgentId: agent.parentAgentId, labels });
    const requestId = nonEmpty(labels[REQUEST_ID_LABEL]);
    const batchId = nonEmpty(labels["bm.batchId"]);
    // Design §16.4: the request of a new Worker an unbound Manager created is registered at first sight.
    if (role === "worker") sightRequestId({ workspaceId: agent.workspaceId, requestId, role, agentId: agent.id, parentAgentId: parentId }, { home: deps.home, log });
    // The plugin's own creation for that Worker settles itself first: its agent.created may come before the id.
    if (role === "reviewer" && parentId !== null) await pluginCreationsSettled(parentId);

    const settled = deps.bindings?.settleCreated({ agentId: agent.id, role, parentId, workspaceId: agent.workspaceId, requestId, batchId }) ?? { binding: null, settledNow: false };
    const settledHere = settled.settledNow ? settled.binding : null;
    if (settledHere !== null) log(`[paseo-bm] ${role} ${agent.id} is bound to its own tool path; its creation was not settled when Paseo created it.`);

    const workspaceId = agent.workspaceId ?? settled.binding?.workspaceId ?? null;
    if (role === "worker") {
      if (settledHere !== null && settledHere.requestId !== null && workspaceId !== null) {
        createRequestRegistry(deps.home, { log }).addWorker(workspaceId, settledHere.requestId, agent.id);
      }
      return;
    }

    const forRequest = settledHere?.requestId ?? requestId;
    const forBatch = settledHere?.batchId ?? batchId;
    if (workspaceId === null || forRequest === null || forBatch === null || parentId === null) return;
    const registry = createRequestRegistry(deps.home, { log });
    const request = registry.get(workspaceId, forRequest);
    const batch = request?.reviews.batches.find((entry) => entry.batchId === forBatch);
    if (request === null || batch === undefined) return;
    if (batch.reviewerIds.includes(agent.id)) return;
    // The label alone is not trusted: the binding settled here, or the request's own Worker as its parent.
    if (settledHere === null && !request.workerIds.includes(parentId)) return;
    const call = batch.calls.find(isEmptyCreateCall);
    if (call === undefined) return;
    registry.noteReviewer(workspaceId, forRequest, forBatch, agent.id, call.callId);
    log(`[paseo-bm] Reviewer ${agent.id} is the one the review call ${call.callId} of batch ${forBatch} created; the registry now names it.`);
  } catch (error) {
    log(`[paseo-bm] settling the new agent ${agent.id} failed: ${reasonOf(error)}`);
  }
}

/** Design §7.17.7: a new Manager without `bm.version` takes the attached hook binding it claimed, if any. Never throws. */
function settleCreatedManager(agent: SettledAgent, labels: Record<string, unknown>, bindings: BindingStore | null, log: (message: string) => void): void {
  const versioned = nonEmpty(labels[VERSION_LABEL]) !== null;
  const settled = bindings?.settleCreated({
    agentId: agent.id,
    role: "manager",
    parentId: null,
    workspaceId: agent.workspaceId,
    requestId: null,
    batchId: null,
    versioned,
  });
  if (settled?.settledNow === true) log(`[paseo-bm] Manager ${agent.id} is bound to its own tool path; the creation hook bound it.`);
}

// ---------------------------------------------------------------------------
// The recovery pass of the hook bindings (design §7.17.7).
// ---------------------------------------------------------------------------

/** The snapshot fields the recovery pass reads; `PaseoAgent` is structurally assignable. */
interface RecoveryAgentSnapshot {
  id: string;
  workspaceId?: string | null;
  provider?: string;
  labels?: Record<string, string> | null;
  archivedAt?: string | null;
  status?: string;
  createdAt?: string;
}

/** Minimal SDK view: list every agent. */
interface RecoveryPaseo {
  agents: {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{ entries: Array<{ agent: RecoveryAgentSnapshot }>; pageInfo?: { nextCursor: string | null; hasMore: boolean } }>;
  };
}

export interface HookRecoveryDeps {
  home: string | null;
  bindings: BindingStore | null;
  now?: () => Date;
  log?: (message: string) => void;
}

/** What one recovery pass did, for the tests and the log. */
export interface HookRecoveryResult {
  /** `managerId` each still-pending hook binding was settled to. */
  settled: string[];
  /** The Managers an expired hook binding raised `outdated-agent` for. */
  flagged: string[];
}

/**
 * The live Manager a hook binding is for: the agent that claimed it (the one
 * holding its token), in its workspace, with no binding, no `bm.version`
 * label, not replaced; null when it is not listed so. Reads only.
 */
function managerFor(binding: AgentBinding, agents: readonly RecoveryAgentSnapshot[], bindings: BindingStore): RecoveryAgentSnapshot | null {
  if (binding.claimedBy === undefined) return null;
  const agent = agents.find((entry) => entry.id === binding.claimedBy);
  if (agent === undefined || agent.workspaceId !== binding.workspaceId || roleOfAgent(agent)?.role !== "manager") return null;
  if (agent.archivedAt || agent.status === "closed") return null;
  const labels = agent.labels ?? {};
  if (nonEmpty(labels[VERSION_LABEL]) !== null || labels[REPLACED_BY_LABEL] !== undefined) return null;
  return bindings.bindingOfAgent(agent.id) === null ? agent : null;
}

/**
 * One recovery pass (design §7.17.7): each claimed, attached hook binding
 * still `pending` is bound to the live Manager that claimed it (`managerFor`);
 * each attached hook binding that expired unsettled is removed, raising
 * `outdated-agent` (`unboundManagerAlertOf`) for that Manager when it claimed
 * one. Lists the agents only when a claimed binding needs it; a listing that
 * fails changes nothing. Never rejects.
 */
export async function recoverHookBindings(paseo: unknown, deps: HookRecoveryDeps): Promise<HookRecoveryResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const done: HookRecoveryResult = { settled: [], flagged: [] };
  try {
    const store = deps.bindings;
    const api = paseo as Partial<RecoveryPaseo> | null | undefined;
    if (store === null || deps.home === null || typeof api?.agents?.list !== "function") return done;
    const pending = store
      .list()
      .filter((binding) => binding.origin === "hook" && binding.state === "pending" && binding.attachedAt !== null && binding.claimedBy !== undefined);
    const expired = store.expiredHooks();
    // No session claimed it: the creation failed before Paseo opened the agent, so no Manager holds its token.
    for (const binding of expired) if (binding.claimedBy === undefined) store.removeExpiredHook(binding.tokenSha256);
    const claimedExpired = expired.filter((binding) => binding.claimedBy !== undefined);
    if (pending.length === 0 && claimedExpired.length === 0) return done;
    const agents = await listAllAgents((options) => (api as RecoveryPaseo).agents.list(options), { includeArchived: false });
    for (const binding of pending) {
      const manager = managerFor(binding, agents, store);
      if (manager === null || !store.settleHook(binding.tokenSha256, manager.id)) continue;
      done.settled.push(manager.id);
      log(`[paseo-bm] Manager ${manager.id} is bound to its own tool path; its creation hook's binding was settled late.`);
    }
    if (claimedExpired.length === 0) return done;
    const alerts = createAlertStore(deps.home, { now });
    for (const binding of claimedExpired) {
      const manager = managerFor(binding, agents, store);
      if (manager !== null) {
        alerts.raise(unboundManagerAlertOf({ agentId: manager.id, workspaceId: binding.workspaceId }));
        done.flagged.push(manager.id);
        log(`[paseo-bm] Manager ${manager.id} was set up for its own tool path, but its binding expired unsettled; it is flagged for replacement.`);
      }
      store.removeExpiredHook(binding.tokenSha256);
    }
  } catch (error) {
    log(`[paseo-bm] the recovery of the creation hook's Manager bindings failed: ${reasonOf(error)}`);
  }
  return done;
}
