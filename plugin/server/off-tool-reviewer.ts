/**
 * Off-tool Reviewers (design §16.8; ADR-027 decision 10).
 *
 * A bound Worker keeps Paseo's `create_agent`: the tools policy is per alias
 * (ADR-020), and withholding it would break older Workers on the same alias.
 * So it could create a Reviewer around its budget. On `agent.created`, a
 * `bm-reviewer` (or fallback alias) whose `parentAgentId` is a bound Worker,
 * and which is not one of the plugin's own creations (no binding of its own,
 * not named in a batch of the Worker's request — the replacement Reviewer of
 * §16.9 included), is an **off-tool Reviewer** (`offToolReviewerOf`). The
 * plugin then:
 *
 * 1. counts it — nothing to do here: `reviewCallsOf` counts every message a
 *    Reviewer of the request received, and an off-tool Reviewer is one by its
 *    parent (`traces.ts`);
 * 2. raises the Inbox alert `off-tool-reviewer`, naming the Worker, the
 *    request and the Reviewer (cleared when that Reviewer is archived, or when
 *    its request reports `finished` or `stopped` — `bm_report`);
 * 3. raises a `worker.signal` of kind `off-tool-review` for the Orchestrator,
 *    where the policy's scope covers the project (the event bus filters it);
 * 4. hands the finding to `cancel`: in the plugin `cancelOffToolReviewer`,
 *    which cancels the Reviewer's turn once, at once, through the Paseo CLI
 *    (spike S5, `paseo-cli.ts`). A failed cancel is logged and the alert
 *    stays. `agent.created` can come before the Reviewer's first turn starts,
 *    where that cancel stops nothing; every turn the Reviewer starts while its
 *    alert is open is cancelled at its `agent.turn_started`
 *    (`registerOffToolTurnCancel`), the first one included.
 *
 * The plugin's own Reviewer is never one: a binding of its own — settled at
 * `agent.created` when a reload or Paseo's late error left it pending
 * (`creation-settle.ts`) — or its name in a batch of the Worker's request
 * (`createPluginReviewer` writes it before its creation counts as done, and
 * the check waits for the creations under way: `pluginCreationsSettled`).
 *
 * Nothing here throws into the event handler.
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import { liveBindingOf, type AgentBinding, type BindingStore } from "./agent-bindings";
import { createAlertStore, type AlertInput } from "./alert-store";
import type { BmEvent, WorkerSignalEvent } from "./event-bus";
import { createRequestRegistry, type RegisteredRequest } from "./request-registry";
import { pluginCreationsSettled } from "./review-tools";
import { cancelAgent } from "./paseo-cli";
import { reasonOf } from "./role-choices";
import type { CancelAgent } from "./stop-propagation";

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

/** Reads one request of the registry: the Worker's, whose batches name the plugin's own Reviewers. */
export type RequestOf = (workspaceId: string, requestId: string) => Pick<RegisteredRequest, "reviews"> | null;

/**
 * The off-tool decision (design §16.8), one function: the finding when `agent`
 * is a Reviewer whose parent is a bound Worker and which is not the plugin's
 * own creation; null otherwise. Pure over `bindings` and `requestOf`.
 */
export function offToolReviewerOf(agent: CreatedAgent, bindings: readonly AgentBinding[], requestOf: RequestOf): OffToolReviewer | null {
  if (roleOfProvider(agent.provider) !== "reviewer" || agent.parentAgentId === null) return null;
  const worker = liveBindingOf(bindings, agent.parentAgentId, "worker");
  if (worker === null) return null;
  const workspaceId = agent.workspaceId ?? worker.workspaceId;
  // The plugin's own: a binding of its own (bound or revoked), or named in a batch of the Worker's request.
  if (bindings.some((binding) => binding.agentId === agent.id)) return null;
  const request = worker.requestId === null ? null : requestOf(workspaceId, worker.requestId);
  if (request?.reviews.batches.some((batch) => batch.reviewerIds.includes(agent.id)) === true) return null;
  return { reviewerId: agent.id, workerId: worker.agentId!, workspaceId, requestId: worker.requestId };
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
   * The cancel of an off-tool Reviewer (§16.8 step 4): `cancelOffToolReviewer`
   * in the plugin, which never rejects. Nothing is cancelled when it is absent.
   */
  cancel?: (finding: OffToolReviewer, paseo: unknown) => Promise<unknown>;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * `agent.created` of any agent: an off-tool Reviewer raises its alert and its
 * signal, and goes to the cancel hook. Waits first for the plugin's own
 * Reviewer creations under way for that Worker, whose `agent.created` can come
 * before their id is known (and before the registry names them). Returns the
 * finding, or null. Never throws.
 */
export async function checkOffToolReviewer(agent: CreatedAgent, paseo: unknown, deps: OffToolDeps): Promise<OffToolReviewer | null> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    if (roleOfProvider(agent.provider) !== "reviewer" || agent.parentAgentId === null || deps.bindings === null || deps.home === null) return null;
    await pluginCreationsSettled(agent.parentAgentId);
    const registry = createRequestRegistry(deps.home, { log });
    const finding = offToolReviewerOf(agent, deps.bindings.list(), (workspaceId, requestId) => registry.get(workspaceId, requestId));
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
    if (deps.cancel !== undefined) await deps.cancel(finding, paseo);
    return finding;
  } catch (error) {
    log(`[paseo-bm] the off-tool check of ${agent.id} failed: ${reasonOf(error)}`);
    return null;
  }
}

/**
 * Cancels an off-tool Reviewer's turn once, at once (design §16.8 step 4),
 * through the Paseo CLI: `paseo agent stop <id>`, with the whole id only. A
 * turn that has not started yet is cancelled when it starts
 * (`registerOffToolTurnCancel`). Resolves true when a turn was cancelled.
 * Never rejects: a failed cancel is logged with the CLI's reason (the agent
 * id, never a token), and the alert stays.
 */
export async function cancelOffToolReviewer(
  finding: OffToolReviewer,
  deps: { cancel?: CancelAgent; log?: (message: string) => void } = {},
): Promise<boolean> {
  const cancel = deps.cancel ?? ((agentId: string) => cancelAgent(agentId));
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const result = await cancel(finding.reviewerId);
    if (!result.ok) throw new Error(result.reason);
    if (result.stopped) log(`[paseo-bm] cancelled the off-tool Reviewer ${finding.reviewerId} of Worker ${finding.workerId}.`);
    return result.stopped;
  } catch (error) {
    log(`[paseo-bm] could not cancel the off-tool Reviewer ${finding.reviewerId}: ${reasonOf(error)}`);
    return false;
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

/**
 * Registers `on("agent.turn_started")`: a Reviewer whose `off-tool-reviewer`
 * alert is open has the turn it just started cancelled through the Paseo CLI
 * (design §16.8 step 4) — its first turn, when `agent.created` came before it
 * and `cancelOffToolReviewer` found nothing to stop, and every later one, a
 * reload included. Returns its remover. Never throws into the event.
 */
export function registerOffToolTurnCancel(
  host: Partial<Pick<PluginServerContext, "on">>,
  home: () => string | null,
  deps: { cancel?: CancelAgent; log?: (message: string) => void } = {},
): () => void {
  if (typeof host.on !== "function") return () => {};
  const cancel = deps.cancel ?? ((agentId: string) => cancelAgent(agentId));
  const log = deps.log ?? ((message: string) => console.warn(message));
  const remove = host.on("agent.turn_started", async (event) => {
    try {
      const agent = (event as { agent?: { id?: unknown; provider?: unknown } } | null)?.agent;
      if (typeof agent?.id !== "string" || agent.id === "" || roleOfProvider(agent.provider) !== "reviewer") return;
      const at = home();
      if (at === null) return;
      const open = createAlertStore(at).list({ open: true, kinds: ["off-tool-reviewer"], subject: agent.id });
      if (open.length === 0) return;
      const result = await cancel(agent.id);
      if (!result.ok) log(`[paseo-bm] could not cancel the turn the off-tool Reviewer ${agent.id} started: ${result.reason}`);
      else if (result.stopped) log(`[paseo-bm] cancelled the turn the off-tool Reviewer ${agent.id} started.`);
    } catch (error) {
      log(`[paseo-bm] the off-tool turn check failed: ${reasonOf(error)}`);
    }
  });
  return typeof remove === "function" ? remove : () => {};
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
