/**
 * Off-tool Reviewers (design §16.8; ADR-027 decision 10).
 *
 * A bound Worker keeps Paseo's `create_agent`: the tools policy is per alias
 * (ADR-020), and withholding it would break older Workers on the same alias.
 * So it could create a Reviewer around its budget. On `agent.created`, a
 * `bm-reviewer` (or fallback alias) whose `parentAgentId` is a Worker bound
 * with the creation tools, and which is not one of the plugin's own creations
 * (no binding of its own, not created by `createPluginReviewer` — the
 * replacement Reviewer of §16.9 included), is an **off-tool Reviewer**
 * (`offToolReviewerOf`). The plugin then:
 *
 * 1. counts it — nothing to do here: `reviewCallsOf` counts every message a
 *    Reviewer of the request received, and an off-tool Reviewer is one by its
 *    parent (`traces.ts`);
 * 2. raises the Inbox alert `off-tool-reviewer`, naming the Worker, the
 *    request and the Reviewer (cleared when that Reviewer is archived, or when
 *    its request reports `finished` or `stopped` — `bm_report`);
 * 3. raises a `worker.signal` of kind `off-tool-review` for the Orchestrator,
 *    where the policy's scope covers the project (the event bus filters it);
 * 4. hands the finding to `cancel`, the hook point where bead
 *    bm-agent-tools-1upv.16 (WP-714, S5 passed) cancels the Reviewer. Until
 *    then nothing is cancelled: one off-tool review can run before the owner
 *    sees the alert (the accepted residual).
 *
 * Nothing here throws into the event handler.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import type { AgentBinding, BindingStore } from "./agent-bindings";
import { createAlertStore, type AlertInput } from "./alert-store";
import type { BmEvent, WorkerSignalEvent } from "./event-bus";
import { isPluginReviewer, pluginCreationsSettled } from "./review-tools";
import { reasonOf } from "./role-choices";

/** A Reviewer a bound Worker created outside its tools. */
export interface OffToolReviewer {
  reviewerId: string;
  workerId: string;
  workspaceId: string;
  /** The Worker's request, from its binding. */
  requestId: string | null;
}

/** The new agent as `agent.created` names it. */
export interface CreatedAgent {
  id: string;
  provider: unknown;
  parentAgentId: string | null;
  workspaceId: string | null;
}

/**
 * The off-tool decision (design §16.8), one function: the finding when `agent`
 * is a Reviewer whose parent is a Worker bound with the creation tools and
 * which is not the plugin's own creation; null otherwise. Pure over
 * `bindings` and `isOwn`.
 */
export function offToolReviewerOf(agent: CreatedAgent, bindings: readonly AgentBinding[], isOwn: (agentId: string) => boolean = isPluginReviewer): OffToolReviewer | null {
  if (roleOfProvider(agent.provider) !== "reviewer" || agent.parentAgentId === null) return null;
  const worker = bindings.find(
    (binding) => binding.agentId === agent.parentAgentId && binding.role === "worker" && binding.state === "bound" && binding.creationTools,
  );
  if (worker === undefined) return null;
  // The plugin's own: a binding of its own (bound or revoked), or created by createPluginReviewer.
  if (bindings.some((binding) => binding.agentId === agent.id) || isOwn(agent.id)) return null;
  return { reviewerId: agent.id, workerId: worker.agentId!, workspaceId: agent.workspaceId ?? worker.workspaceId, requestId: worker.requestId };
}

/** The `off-tool-reviewer` alert of a finding: about the Reviewer, the Worker and the request in its detail. */
export function offToolAlertOf(finding: OffToolReviewer): AlertInput {
  return {
    workspaceId: finding.workspaceId,
    kind: "off-tool-reviewer",
    subject: finding.reviewerId,
    detail: `Worker ${finding.workerId} ${offToolRequestPhrase(finding.requestId ?? "(not known)")} created Reviewer ${finding.reviewerId} outside its tools; its review calls count against the request's budget.`,
  };
}

/** The words of an `off-tool-reviewer` detail that name its request: written by `offToolAlertOf`, read by `clearOffToolAlertsOfRequest`. */
function offToolRequestPhrase(requestId: string): string {
  return `of request ${requestId}`;
}

export interface OffToolDeps {
  /** The data folder. */
  home: string | null;
  /** The per-agent bindings. */
  bindings: BindingStore | null;
  /** Publishes the `worker.signal` event (the event bus); none without it. */
  publish?: (events: readonly BmEvent[], paseo?: unknown) => Promise<unknown>;
  /**
   * The cancel of an off-tool Reviewer: the hook point of bead
   * bm-agent-tools-1upv.16 (WP-714, S5 passed). Nothing is cancelled until it
   * is given.
   */
  cancel?: (finding: OffToolReviewer, paseo: unknown) => Promise<unknown>;
  now?: () => Date;
  log?: (message: string) => void;
  /** The plugin's own Reviewers; `isPluginReviewer` by default. */
  isOwn?: (agentId: string) => boolean;
}

/**
 * `agent.created` of any agent: an off-tool Reviewer raises its alert and its
 * signal, and goes to the cancel hook. Waits first for the plugin's own
 * Reviewer creations under way for that Worker, whose `agent.created` can come
 * before their id is known. Returns the finding, or null. Never throws.
 */
export async function checkOffToolReviewer(agent: CreatedAgent, paseo: unknown, deps: OffToolDeps): Promise<OffToolReviewer | null> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    if (roleOfProvider(agent.provider) !== "reviewer" || agent.parentAgentId === null || deps.bindings === null || deps.home === null) return null;
    await pluginCreationsSettled(agent.parentAgentId);
    const finding = offToolReviewerOf(agent, deps.bindings.list(), deps.isOwn ?? isPluginReviewer);
    if (finding === null) return null;
    log(`[paseo-bm] Worker ${finding.workerId} created Reviewer ${finding.reviewerId} outside its tools (request ${finding.requestId ?? "not known"}).`);
    const raised = createAlertStore(deps.home, deps.now === undefined ? {} : { now: deps.now }).raise(offToolAlertOf(finding));
    if (raised.raised && deps.publish !== undefined) {
      const signal: WorkerSignalEvent = {
        type: "worker.signal",
        workspaceId: finding.workspaceId,
        workerId: finding.workerId,
        requestKey: finding.requestId,
        signal: "off-tool-review",
        turnStart: raised.alert.since,
        alertKey: raised.alert.key,
        since: raised.alert.since,
      };
      try {
        await deps.publish([signal], paseo);
      } catch (error) {
        log(`[paseo-bm] could not publish the off-tool-review signal of ${finding.reviewerId}: ${reasonOf(error)}`);
      }
    }
    if (deps.cancel !== undefined) {
      try {
        await deps.cancel(finding, paseo);
      } catch (error) {
        log(`[paseo-bm] could not cancel the off-tool Reviewer ${finding.reviewerId}: ${reasonOf(error)}`);
      }
    }
    return finding;
  } catch (error) {
    log(`[paseo-bm] the off-tool check of ${agent.id} failed: ${reasonOf(error)}`);
    return null;
  }
}

/** Clears the `off-tool-reviewer` alert of an archived Reviewer; returns the cleared keys. Never throws. */
export function clearOffToolAlert(home: string | null, reviewerId: string, deps: { now?: () => Date } = {}): string[] {
  if (home === null) return [];
  try {
    return createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }).clearWhere((alert) => alert.kind === "off-tool-reviewer" && alert.subject === reviewerId);
  } catch {
    return [];
  }
}

/**
 * Clears the `off-tool-reviewer` alerts of a request that reported `finished`
 * or `stopped` (design §16.8): its off-tool Reviewers no longer cost it
 * anything. The request is the one `offToolAlertOf` wrote into the detail (the
 * alert's subject is the Reviewer). Returns the cleared keys. Never throws.
 */
export function clearOffToolAlertsOfRequest(home: string | null, workspaceId: string, requestId: string, deps: { now?: () => Date } = {}): string[] {
  if (home === null) return [];
  const phrase = `${offToolRequestPhrase(requestId)} `;
  try {
    return createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }).clearWhere(
      (alert) => alert.kind === "off-tool-reviewer" && alert.workspaceId === workspaceId && (alert.detail ?? "").includes(phrase),
    );
  } catch {
    return [];
  }
}

/** Registers `on("agent.archived")`, which clears an archived Reviewer's `off-tool-reviewer` alert, and returns its remover. */
export function registerOffToolAlertClear(host: Partial<Pick<PluginServerContext, "on">>, home: () => string | null): () => void {
  if (typeof host.on !== "function") return () => {};
  const remove = host.on("agent.archived", (event) => {
    const id = (event as { agent?: { id?: unknown } } | null)?.agent?.id;
    if (typeof id === "string" && id !== "") clearOffToolAlert(home(), id);
  });
  return typeof remove === "function" ? remove : () => {};
}
