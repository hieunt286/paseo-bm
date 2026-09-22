/**
 * Review budget, counted by the plugin (delta 20260917c §4.7, REQ-037 errata).
 *
 * The Worker used to count its own review calls and the Manager used to check
 * the count. The 2026-09-17 acceptance run showed the trace store counting 4
 * calls correctly while the Worker reported 5, so the number now comes from the
 * one place that gets it right: `reviewCallsOf`, the same figure the Dashboard
 * shows. The guardrail stays behavioural — this module only TELLS the Manager;
 * the Manager decides and the user permits. Nothing here stops an agent.
 *
 * Two properties this module must never lose (review b2):
 * - It only ever tells the Manager about an overrun a Worker's or Reviewer's
 *   turn end DISCOVERED in this process. A Manager turn end can only flush
 *   what is already pending. Without that, a restart would make the first
 *   Manager turn end announce every old finished request, and each notice
 *   starts a Manager turn whose end announces the next one.
 * - One notice per request, even when two turn ends are handled at once: the
 *   request is marked before the first `await`, not after the send.
 *
 * Facts this relies on (checked, not guessed):
 * - A Reviewer's inbound request is recorded when that Reviewer's turn ends, so
 *   a new call becomes visible at a Reviewer turn end. The Worker's last report
 *   usually WAKES the Manager, so a notice found at the Worker's turn end is
 *   deferred — which is why the MANAGER's own turn end is checked too, and is
 *   often the moment the notice can finally go out (review b1, B2).
 * - `PaseoAgentHandle.send()` on a running agent REPLACES its current turn —
 *   `stop-propagation.ts` relies on exactly that to interrupt a Reviewer. A
 *   Manager in the middle of answering the user must not be cut off, so the
 *   notice is sent only when `refresh()` says the Manager is not `running`.
 * - A Manager turn is attributed to the request whose `requestId: req-…` it
 *   contains (`managerRequestId`), so the notice carries that exact form and
 *   never opens a request of its own.
 *
 * Lifecycle belongs to the user (ADR-005): nothing here archives, deletes or
 * cancels anything.
 */
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { Tier } from "../shared/contracts";
import { agentFactsOf, type DashboardPaseo } from "./dashboard-rpc";
import { BUDGET_NOTICE_MARKER } from "./notices";
import { roleOfProvider } from "./agent-role";
import { readRecords, type TraceStoreLocation } from "./trace-store";
import { reconstructTraces, type ReconstructedTrace } from "./traces";

/** Total review calls per request, by tier (REQ-037; unchanged by this delta). */
export const REVIEW_BUDGET: Readonly<Record<Tier, number>> = { Small: 1, Medium: 4, Large: 6 };

/** First word of the notice; `roles/manager.md` tells the Manager what to do with it. */
export { BUDGET_NOTICE_MARKER } from "./notices";

/**
 * The fixed notice the Manager receives, word for word from design delta §4.7.
 * The Manager ASKS the user; it never cancels on the notice alone, because the
 * user may have allowed the extra calls in the Worker's own chat (REQ-026e,
 * owner decision Q21). `roles/manager.md` pins the same text.
 */
export function budgetNotice(over: BudgetOverrun): string {
  return (
    `${BUDGET_NOTICE_MARKER} requestId: ${over.requestId}\n` +
    `The Worker has used ${over.calls} review calls; the ${over.tier} budget is ${over.budget}. ` +
    "Ask the user whether to continue or to cancel the Worker's run, and wait for the answer. " +
    "Do not cancel on your own: the user may already have allowed the extra calls in the Worker's chat."
  );
}

export interface BudgetOverrun {
  requestId: string;
  tier: Tier;
  calls: number;
  budget: number;
  managerAgentId: string;
}

/**
 * The overrun of one reconstructed request, or `null` when it is within
 * budget, or when its tier, its call count, its request id or its Manager is
 * not known — an unknown number never produces a notice.
 */
export function overrunOf(trace: ReconstructedTrace): BudgetOverrun | null {
  if (trace.requestId === null || trace.tier === null || trace.reviewCalls === null) return null;
  if (trace.managerAgentId === null) return null;
  const budget = REVIEW_BUDGET[trace.tier];
  if (budget === undefined || trace.reviewCalls <= budget) return null;
  return {
    requestId: trace.requestId,
    tier: trace.tier,
    calls: trace.reviewCalls,
    budget,
    managerAgentId: trace.managerAgentId,
  };
}

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/** What the check needs from Paseo: the Dashboard's agent listing, plus refresh and send. */
export interface BudgetPaseo extends Omit<DashboardPaseo, "agents"> {
  agents: Omit<DashboardPaseo["agents"], "ref"> & {
    ref?(agentId: string): {
      timeline: { refetch(options: Record<string, unknown>): Promise<unknown> };
      refresh?(): Promise<{ agent?: { status?: string | null; archivedAt?: string | null } | null } | null>;
      send?(text: string): Promise<void>;
    };
  };
}

export interface BudgetDeps {
  location: TraceStoreLocation;
  paseo: BudgetPaseo;
  /** `workspaceId::requestId` of every request already told, or being told now. */
  told: Set<string>;
  /**
   * Overruns found at a Worker's or Reviewer's turn end that could not be sent
   * yet (the Manager was running). Only these may go out at a Manager turn end,
   * so a restart never announces old finished requests.
   */
  pending?: Map<string, BudgetOverrun>;
  log?: (message: string) => void;
}

export type BudgetOutcome = "ignored" | "within" | "already-told" | "deferred" | "sent";

const NO_PENDING = new Map<string, BudgetOverrun>();

/**
 * Checks the requests of the agent whose turn just ended, and tells their
 * Manager once each when a request is over budget. Call it only after the
 * collector has written that turn's record. One notice per call, so a Manager
 * is never sent two messages back to back; the next turn end carries the next.
 * Never throws.
 */
export async function checkReviewBudget(event: TurnEndedEvent, deps: BudgetDeps): Promise<BudgetOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const pending = deps.pending ?? NO_PENDING;
  let claimed: string | null = null;
  try {
    const agent = event?.agent;
    // Every paseo-bm role counts, on its main alias or a fallback one (delta 20260921 §4.4.1).
    const role = roleOfProvider(agent?.provider);
    const workspaceId = agent?.workspaceId ?? null;
    if (role === null || workspaceId === null) return "ignored";
    const keyOf = (found: BudgetOverrun): string => `${workspaceId}::${found.requestId}`;

    let over: BudgetOverrun | undefined;
    if (role === "manager") {
      // A Manager turn end only FLUSHES what a Worker or Reviewer turn end
      // already found — usually the notice deferred moments ago because this
      // Manager was still answering the Worker's last report.
      over = [...pending.values()].find((found) => keyOf(found) === `${workspaceId}::${found.requestId}` && found.managerAgentId === agent.id);
      if (over === undefined) return "within";
    } else {
      const records = readRecords(deps.location, workspaceId).records;
      const facts = await agentFactsOf(deps.paseo, workspaceId);
      const trace = reconstructTraces({ records, agents: [...facts.values()] }).find(
        (candidate) => candidate.workerIds.includes(agent.id) || candidate.reviewerIds.includes(agent.id),
      );
      over = trace === undefined ? undefined : (overrunOf(trace) ?? undefined);
      if (over === undefined) return "within";
      if (deps.told.has(keyOf(over))) return "already-told";
      pending.set(keyOf(over), over);
    }

    const key = keyOf(over);
    if (deps.told.has(key)) return "already-told";
    // Claimed BEFORE any await: two turn ends handled at once must not both send.
    deps.told.add(key);
    claimed = key;

    const handle = deps.paseo.agents.ref?.(over.managerAgentId);
    if (typeof handle?.refresh !== "function" || typeof handle.send !== "function") {
      log("[paseo-bm] cannot reach the Manager on this host; the review budget notice was not sent.");
      return "deferred";
    }
    const snapshot = await handle.refresh();
    const status = snapshot?.agent?.status ?? null;
    if (status === "running") return "deferred";
    // Lifecycle belongs to the user (ADR-005): `send()` un-archives an archived
    // agent and starts a turn on it, so an archived or closed Manager is left
    // alone and the notice is dropped rather than deferred forever.
    if (snapshot?.agent?.archivedAt != null || status === "closed") {
      log(`[paseo-bm] the Manager of ${over.requestId} is archived or closed; the review budget notice was not sent.`);
      pending.delete(key);
      claimed = null;
      return "ignored";
    }

    await handle.send(budgetNotice(over));
    pending.delete(key);
    claimed = null;
    return "sent";
  } catch (error) {
    // This runs inside a real agent's turn end: a failure costs one notice, never the turn.
    log(`[paseo-bm] review budget check failed: ${error instanceof Error ? error.message : String(error)}`);
    return "deferred";
  } finally {
    // Not sent after all: let a later turn end try again.
    if (claimed !== null) deps.told.delete(claimed);
  }
}
