/**
 * The upgrade sweep of the retired `review-budget` question (delivery line
 * design §5.6; ADR-035 decision 4): review budgets are retired, and past its
 * review cap a request gets one owner-only `review-cap` decision instead
 * (§5.4). An older build may have left `review-budget` questions open, which
 * nothing would answer for good any more.
 *
 * - **Once per plugin run**, at the first Paseo handle of the run (as the
 *   other start-up sweeps: `index.server.ts` `shareHandle`), every unsettled
 *   `q:` decision of subject `review-budget` is withdrawn, each in its own
 *   write re-checked on the stored decision, so an answer given meanwhile
 *   stands.
 * - **Idempotent**: a withdrawn decision is settled, so a second start finds
 *   none and does nothing.
 * - **The Worker is told**: one message per request, through the notice queue
 *   (never into a running turn), to the request's sole live Worker
 *   (`soleWorkerOfRequest`), kind `withdrawn:<requestId>`:
 *   `BM-DELIVERY answers`, `Continue <requestId>.` and one line per question,
 *   "Q3 is withdrawn: review budgets are retired: paseo-bm asks once, at the
 *   request's review cap. Do not wait for it." The outcome is recorded on each
 *   decision's `delivery` (`failed` without a single live Worker).
 *
 * Never throws: a failure is one log line.
 */
import { LEGACY_REVIEW_BUDGET_SUBJECT, UNSETTLED_STATUSES, decisionKindOf, withdrawDecision, type Decision, type DecisionDelivery } from "../shared/decisions";
import { DELIVERY_NOTICE_MARKER } from "../shared/notices";
import { soleWorkerOfRequest } from "./decision-delivery";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import type { DashboardPaseo } from "./paseo-directory";
import { dataHome, errorText } from "./rpc-kit";

/** Why an open `review-budget` question is withdrawn (delivery line design §5.6), word for word. */
export const REVIEW_BUDGET_RETIRED = "review budgets are retired: paseo-bm asks once, at the request's review cap";

/** The notice-queue kind of a request's withdrawal message. */
export function withdrawnKindOf(requestId: string): string {
  return `withdrawn:${requestId}`;
}

/** The message a request's Worker gets for its withdrawn `review-budget` questions. Pure. */
export function withdrawalTextOf(requestId: string, decisions: readonly Pick<Decision, "id">[]): string {
  const lines = decisions.map((decision) => `${decision.id.slice(decision.id.lastIndexOf(":") + 1)} is withdrawn: ${REVIEW_BUDGET_RETIRED}. Do not wait for it.`);
  return `${DELIVERY_NOTICE_MARKER} answers\nContinue ${requestId}.\n${lines.join("\n")}`;
}

/**
 * Withdraws every unsettled `q:` decision of subject `review-budget` in
 * `store`, at `at`; returns the withdrawn ones. Each in its own
 * write, re-checked on the stored decision. Never throws.
 */
export function withdrawReviewBudgetQuestions(store: DecisionStore, at: string, log: (message: string) => void): Decision[] {
  const withdrawn: Decision[] = [];
  let open: Decision[];
  try {
    open = store.list({ statuses: UNSETTLED_STATUSES }).filter((decision) => decision.subject === LEGACY_REVIEW_BUDGET_SUBJECT && decisionKindOf(decision.id) === "question");
  } catch (error) {
    log(`[paseo-bm] could not read the decisions to withdraw the retired review-budget questions: ${errorText(error)}`);
    return withdrawn;
  }
  for (const decision of open) {
    try {
      const mutation = store.transition(decision.id, (current) => withdrawDecision(current, { at }), decision.workspaceId);
      if (mutation.status === "updated") withdrawn.push(mutation.decision);
    } catch (error) {
      log(`[paseo-bm] could not withdraw the retired review-budget question ${decision.id}: ${errorText(error)}`);
    }
  }
  if (withdrawn.length > 0) log(`[paseo-bm] withdrew ${withdrawn.map((decision) => decision.id).join(", ")}: ${REVIEW_BUDGET_RETIRED}.`);
  return withdrawn;
}

export interface ReviewBudgetSweepDeps {
  /** The data folder; looked up otherwise. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** The queue the messages go through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The request's sole live Worker; `soleWorkerOfRequest` by default. */
  workerOf?: (input: { workspaceId: string; requestId: string; home: string }, paseo: DashboardPaseo) => Promise<string | null>;
}

export interface ReviewBudgetSweep {
  /** Once per plugin run, with the first usable Paseo handle: withdraws and tells the Workers. Returns the withdrawn ids. Never rejects. */
  run(paseo: unknown): Promise<string[]>;
}

function isPaseo(value: unknown): value is DashboardPaseo & NoticePaseo {
  const agents = (value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined)?.agents;
  return typeof agents?.list === "function" && typeof agents?.ref === "function";
}

export function createReviewBudgetSweep(deps: ReviewBudgetSweepDeps = {}): ReviewBudgetSweep {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const queue = deps.queue ?? noticeQueue;
  const workerOf = deps.workerOf ?? soleWorkerOfRequest;
  let ran = false;

  const record = (store: DecisionStore, decision: Decision, delivery: DecisionDelivery): void => {
    try {
      store.transition(decision.id, (current) => ({ ok: true, decision: { ...current, delivery } }), decision.workspaceId);
    } catch (error) {
      log(`[paseo-bm] could not record the withdrawal message of ${decision.id}: ${errorText(error)}`);
    }
  };

  const tell = async (store: DecisionStore, home: string, paseo: DashboardPaseo & NoticePaseo, workspaceId: string, requestId: string, decisions: Decision[]): Promise<void> => {
    const kind = withdrawnKindOf(requestId);
    let workerId: string | null = null;
    try {
      workerId = await workerOf({ workspaceId, requestId, home }, paseo);
    } catch (error) {
      log(`[paseo-bm] could not find the Worker of ${requestId} to tell it of its withdrawn questions: ${errorText(error)}`);
    }
    const outcome = workerId === null ? "dropped" : await queue.enqueue(workerId, kind, withdrawalTextOf(requestId, decisions), paseo);
    if (outcome === "dropped") log(`[paseo-bm] the withdrawal of ${decisions.map((decision) => decision.id).join(", ")} reached no Worker of ${requestId}.`);
    const at = now().toISOString();
    for (const decision of decisions) {
      record(store, decision, { to: workerId ?? decision.askedBy.agentId ?? "worker", kind, at, outcome: outcome === "sent" ? "sent" : outcome === "dropped" ? "failed" : "queued" });
    }
  };

  return {
    async run(paseo) {
      if (ran || !isPaseo(paseo)) return [];
      ran = true;
      try {
        const home = deps.home === undefined ? dataHome() : deps.home();
        if (home === null) return [];
        const store = createDecisionStore(home, { log });
        const withdrawn = withdrawReviewBudgetQuestions(store, now().toISOString(), log);
        const byRequest = new Map<string, { workspaceId: string; requestId: string; decisions: Decision[] }>();
        for (const decision of withdrawn) {
          const key = JSON.stringify([decision.workspaceId, decision.requestId]);
          const entry = byRequest.get(key) ?? { workspaceId: decision.workspaceId, requestId: decision.requestId!, decisions: [] };
          entry.decisions.push(decision);
          byRequest.set(key, entry);
        }
        for (const { workspaceId, requestId, decisions } of byRequest.values()) await tell(store, home, paseo, workspaceId, requestId, decisions);
        return withdrawn.map((decision) => decision.id);
      } catch (error) {
        log(`[paseo-bm] the sweep of the retired review-budget questions failed: ${errorText(error)}`);
        return [];
      }
    },
  };
}
