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
 * - **the binding**: the one attached `pending` binding of its role, parent
 *   and workspace — and its `bm.batchId` (a Reviewer) or `bm.requestId` (a
 *   Worker) label — is bound to it (`BindingStore.settleCreated`); a Worker
 *   settled here is added to its request's Workers;
 * - **the registry** (a Reviewer): a create call of its labelled batch with
 *   an empty `reviewerId` gets it (`noteReviewer`) once no creation of its
 *   Worker is under way in this run (`pluginCreationsSettled`) — when the
 *   binding settled here proves it, or its parent is the request's Worker —
 *   and it is remembered as the plugin's own (`markPluginReviewer`).
 *
 * A Reviewer settled either way is the plugin's own, never off-tool. Nothing
 * here throws into the event handler.
 */
import { roleOfProvider } from "./agent-role";
import type { AgentBinding, BindingStore } from "./agent-bindings";
import { createRequestRegistry } from "./request-registry";
import { isPluginReviewer, markPluginReviewer, pluginCreationsSettled } from "./review-tools";
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

/** What `settleCreatedAgent` did. */
export interface CreationSettled {
  /** True for an agent the plugin created itself (a binding of its own, or a batch of the registry names it). */
  own: boolean;
  /** The binding bound to it here, or null. */
  binding: AgentBinding | null;
  /** The create call it filled in, or null. */
  repairedCallId: string | null;
}

const NOTHING: CreationSettled = { own: false, binding: null, repairedCallId: null };

/** The agent's labels, from its snapshot; none when it cannot be read. */
async function labelsOf(paseo: unknown, agentId: string): Promise<Record<string, unknown>> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<{ agent?: unknown } | null> } } } | null)?.agents?.ref?.(agentId);
    return asRecord(asRecord((await ref?.refresh?.())?.agent)?.["labels"]) ?? {};
  } catch {
    return {};
  }
}

/** Settles a new Worker or Reviewer the plugin may have created (see the module comment). Never throws. */
export async function settleCreatedAgent(agent: SettledAgent, paseo: unknown, deps: CreationSettleDeps): Promise<CreationSettled> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const role = roleOfProvider(agent.provider);
    if ((role !== "worker" && role !== "reviewer") || deps.home === null) return NOTHING;
    const labels = await labelsOf(paseo, agent.id);
    const parentId = agent.parentAgentId ?? nonEmpty(labels["paseo.parent-agent-id"]);
    const requestId = nonEmpty(labels["bm.requestId"]);
    const batchId = nonEmpty(labels["bm.batchId"]);
    // The plugin's own creation for that Worker settles itself first: its agent.created may come before the id.
    if (role === "reviewer" && parentId !== null) await pluginCreationsSettled(parentId);

    const before = deps.bindings?.bindingOfAgent(agent.id) ?? null;
    const binding = deps.bindings?.settleCreated({ agentId: agent.id, role, parentId, workspaceId: agent.workspaceId, requestId, batchId }) ?? null;
    const settledHere = before === null && binding !== null ? binding : null;
    if (settledHere !== null) log(`[paseo-bm] ${role} ${agent.id} is bound to its own tool path; its creation was not settled when Paseo created it.`);

    const workspaceId = agent.workspaceId ?? binding?.workspaceId ?? null;
    if (role === "worker") {
      if (settledHere !== null && settledHere.requestId !== null && workspaceId !== null) {
        createRequestRegistry(deps.home, { log }).addWorker(workspaceId, settledHere.requestId, agent.id);
      }
      return { own: binding !== null, binding: settledHere, repairedCallId: null };
    }

    if (isPluginReviewer(agent.id)) return { own: true, binding: settledHere, repairedCallId: null };
    const own = binding !== null;
    const forRequest = settledHere?.requestId ?? requestId;
    const forBatch = settledHere?.batchId ?? batchId;
    if (workspaceId === null || forRequest === null || forBatch === null || parentId === null) return { own, binding: settledHere, repairedCallId: null };
    const registry = createRequestRegistry(deps.home, { log });
    const request = registry.get(workspaceId, forRequest);
    const batch = request?.reviews.batches.find((entry) => entry.batchId === forBatch);
    if (request === null || batch === undefined) return { own, binding: settledHere, repairedCallId: null };
    if (batch.reviewerIds.includes(agent.id)) {
      markPluginReviewer(agent.id);
      return { own: true, binding: settledHere, repairedCallId: null };
    }
    // The label alone is not trusted: the binding settled here, or the request's own Worker as its parent.
    if (settledHere === null && !request.workerIds.includes(parentId)) return { own, binding: settledHere, repairedCallId: null };
    const call = batch.calls.find((entry) => entry.kind === "create" && entry.reviewerId === "");
    if (call === undefined) return { own, binding: settledHere, repairedCallId: null };
    registry.noteReviewer(workspaceId, forRequest, forBatch, agent.id, call.callId);
    markPluginReviewer(agent.id);
    log(`[paseo-bm] Reviewer ${agent.id} is the one the review call ${call.callId} of batch ${forBatch} created; the registry now names it.`);
    return { own: true, binding: settledHere, repairedCallId: call.callId };
  } catch (error) {
    log(`[paseo-bm] settling the new agent ${agent.id} failed: ${reasonOf(error)}`);
    return NOTHING;
  }
}
