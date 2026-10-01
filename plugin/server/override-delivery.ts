/**
 * Delivering the owner's answer to an override (autonomy design §B.7, §B.9;
 * PRD REQ-125 b): the `override` part of the decisions' `onSettled` hook
 * (`decision-rpc.ts` `settledByKind`). An override `r:<uuid>` corrects a
 * decision the policy or a precedent answered for the owner; its answer
 * reaches the agent concerned as a decision, the way the overridden kind's
 * answers do (`deliveryKindOf`):
 *
 * - **A Worker's question (`q:`):** the request's sole live Worker
 *   (`soleWorkerOfRequest`) gets `BM-DELIVERY answers`, `Continue
 *   <requestId>.`, one line saying the owner changed the answer to `Qn` and
 *   what the earlier one was, then a `BM-ANSWERS` block answering that `Qn`
 *   (`overrideAnswersMessageOf`). Through the notice queue under its own kind
 *   (`override:<id>`), so it never replaces, nor is replaced by, the request's
 *   `answers:<requestId>` block; queued behind one, it goes after it. It has
 *   the guarantees of a Worker's answer (§A.6, `decision-delivery.ts`):
 *   - recorded `sent` (the Worker was idle), `queued` (held for its turn end)
 *     or `failed` (no single live Worker, or the queue dropped it — never sent
 *     to a guess, never retried);
 *   - a `queued` one becomes `sent` when a Worker's turn record carries it
 *     (`afterTurn`: the correction line and its `BM-ANSWERS` block), or when
 *     this run's queue no longer holds its `override:<id>` notice;
 *   - without a Paseo handle or a data folder nothing is recorded, and once
 *     per plugin run — at the first settlement or recorded turn with a Paseo
 *     handle — every answered override of a `q:` still undelivered (`delivery`
 *     null or `queued`) is delivered again (`resume`). A `queued` one sent
 *     just before a reload may reach the Worker twice; a corrected answer is
 *     never lost.
 * - **An Orchestrator decision (`o:`):** the Orchestrator's own delivery
 *   (`orchestrator-decisions.ts`), exactly as for an `o:` answer: the chosen
 *   option's prepared command through the one send pipeline
 *   (`command-send.ts`, recorded in the commands store) on the authority
 *   `decision:<override id>` — the owner's choice, counted by the loop guard
 *   and never refused there — or the `BM-ANSWER` naming the override and its
 *   grant.
 * - **A fallback incident (`f:`):** the fallback delivery
 *   (`fallback-decisions.ts`), at once: the chosen action through
 *   `fallback.act`, which runs it only while the incident is still pending;
 *   once the delegated action ran, it refuses, and the override records
 *   `failed`.
 *
 * The delegated answer already delivered is never recalled: the corrected one
 * follows it. One delivery per override at a time. Never throws: a failure is
 * one log line.
 */
import type { TraceRecord } from "../shared/contracts";
import { answersText, type Pick as AnswerPick } from "../shared/bm-questions";
import { decisionKindOf, deliveryKindOf, questionDecisionId, type Decision, type DecisionDelivery } from "../shared/decisions";
import { DELIVERY_NOTICE_MARKER } from "../shared/notices";
import { soleWorkerOfRequest } from "./decision-delivery";
import { answerBlockOf } from "./decision-materialiser";
import type { OnDecisionsSettled } from "./decision-rpc";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import type { DashboardPaseo } from "./paseo-directory";
import { dataHomeOf } from "./role-instructions";
import { errorText } from "./rpc-kit";

const defaultLog = (message: string): void => console.warn(message);

/** The notice-queue kind of an override's corrected answer: one per override. */
export function overrideKindOf(overrideId: string): string {
  return `override:${overrideId}`;
}

/** How the correction line of a Worker's corrected answer starts; `afterTurn` knows the block by it. */
export const OVERRIDE_CORRECTION_PREFIX = "The owner changed the answer to ";

/** `Qn` of `q:<requestId>:<Qn>`. */
function questionIdOf(decisionId: string): string {
  return decisionId.slice(decisionId.lastIndexOf(":") + 1);
}

/** An answer as the `BM-ANSWERS` line writes it: `a — <label>`, `other — <words>`; null for none. */
function answerWords(decision: Pick<Decision, "options" | "answer">): string | null {
  const answer = decision.answer;
  if (answer === null) return null;
  const option = answer.optionKey === null ? undefined : decision.options.find((entry) => entry.key === answer.optionKey);
  if (option !== undefined) return `${option.key} — ${option.label.replace(/\s+/g, " ").trim()}`;
  return answer.words === null ? null : `other — ${answer.words.replace(/\s+/g, " ").trim()}`;
}

/**
 * The message a Worker receives for the owner's corrected answer to one of its
 * questions: the plugin's `BM-DELIVERY answers` line (never the owner's
 * typing), `Continue <requestId>.`, the correction and the earlier answer
 * (when `overridden` is known), a blank line, then the `BM-ANSWERS` block
 * answering that `Qn`. Throws when the override has neither an option nor
 * words, as `answersText` does.
 */
export function overrideAnswersMessageOf(override: Decision, overridden: Decision | null): string {
  const requestId = override.requestId!;
  const questionId = questionIdOf(override.supersedes!);
  const answer = override.answer;
  const pick: AnswerPick | null = answer?.optionKey != null ? { key: answer.optionKey } : answer?.words != null ? { other: answer.words } : null;
  if (pick === null) throw new Error(`${override.id} has no answer to deliver`);
  const earlier = overridden === null ? null : answerWords(overridden);
  const correction =
    `${OVERRIDE_CORRECTION_PREFIX}${questionId}; this answer replaces the earlier one${earlier === null ? "" : ` (${questionId}: ${earlier})`}. ` +
    "If you already acted on the earlier answer, say what that changes in your next report.";
  const block = answersText(
    requestId,
    [{ id: questionId, text: override.question, options: override.options.map((option) => ({ key: option.key, text: option.label, recommended: option.recommended })) }],
    { [questionId]: pick },
  );
  return `${DELIVERY_NOTICE_MARKER} answers\nContinue ${requestId}.\n${correction}\n\n${block}`;
}

/** An answered override of a Worker's question: the one this module delivers itself. */
function isAnsweredQuestionOverride(decision: Decision): boolean {
  return (
    decisionKindOf(decision.id) === "override" &&
    deliveryKindOf(decision) === "question" &&
    decision.status === "answered" &&
    decision.answer !== null &&
    decision.requestId !== null
  );
}

export interface OverrideDeliveryDeps {
  /** The data folder; looked up otherwise. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** The queue a Worker's corrected answer goes through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue" | "pending">;
  /** The request's sole live Worker; `soleWorkerOfRequest` by default. */
  workerOf?: (input: { workspaceId: string; requestId: string; home: string }, paseo: DashboardPaseo) => Promise<string | null>;
  /** The Orchestrator's delivery (`createOrchestratorDecisionDelivery`): an override of an `o:` decision takes it. */
  orchestrator?: OnDecisionsSettled;
  /** The fallback delivery (`createFallbackDecisionDelivery`): an override of an `f:` decision takes it. */
  fallback?: OnDecisionsSettled;
}

export interface OverrideDelivery {
  /** The `override` part of `settledByKind`. Never rejects. */
  onSettled: OnDecisionsSettled;
  /**
   * With the materialiser's `afterTurn`: a Worker's record carrying a
   * corrected answer marks that `queued` override `sent`, as does this run's
   * queue no longer holding it; then, once per plugin run, the undelivered
   * overrides are delivered again. Never rejects.
   */
  afterTurn(record: TraceRecord, context: { paseo: unknown }): Promise<void>;
  /** Once per plugin run: delivers every answered override of a Worker's question still undelivered. Never rejects. */
  resume(paseo: unknown): Promise<void>;
}

function isPaseo(value: unknown): value is DashboardPaseo & NoticePaseo {
  const agents = (value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined)?.agents;
  return typeof agents?.list === "function" && typeof agents?.ref === "function";
}

/** The `override` delivery: see the module comment. */
export function createOverrideDelivery(deps: OverrideDeliveryDeps = {}): OverrideDelivery {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const queue = deps.queue ?? noticeQueue;
  const workerOf = deps.workerOf ?? soleWorkerOfRequest;
  const homeOf = (): string | null => (deps.home === undefined ? dataHomeOf() : deps.home());
  /** Overrides this run queued, and the Worker each went to: the queue is asked whether it still holds them. */
  const queuedHere = new Map<string, string>();
  const running = new Set<string>();
  let resumed = false;

  const record = (store: DecisionStore, decision: Decision, delivery: DecisionDelivery): void => {
    try {
      store.transition(decision.id, (current) => ({ ok: true, decision: { ...current, delivery } }), decision.workspaceId);
      if (delivery.outcome === "queued") queuedHere.set(decision.id, delivery.to);
      else queuedHere.delete(decision.id);
    } catch (error) {
      log(`[paseo-bm] could not record the delivery of override ${decision.id}: ${errorText(error)}`);
    }
  };

  /** A `queued` override this run queued that its queue no longer holds went out at the Worker's turn end: recorded `sent`. */
  const settleLeftQueue = (store: DecisionStore, decision: Decision): boolean => {
    const delivery = decision.delivery;
    const to = queuedHere.get(decision.id);
    if (delivery?.outcome !== "queued" || to !== delivery.to) return false;
    if (queue.pending(to).some((notice) => notice.kind === overrideKindOf(decision.id))) return false;
    record(store, decision, { ...delivery, at: now().toISOString(), outcome: "sent" });
    return true;
  };

  /** A Worker question's override: the corrected answer to the request's sole Worker. */
  const deliverToWorker = async (decision: Decision, paseo: DashboardPaseo & NoticePaseo, home: string): Promise<void> => {
    if (running.has(decision.id)) return;
    running.add(decision.id);
    try {
      const store = createDecisionStore(home, { log });
      const stored = store.get(decision.id, decision.workspaceId) ?? decision;
      if (!isAnsweredQuestionOverride(stored)) return;
      const delivery = stored.delivery;
      // Delivered, failed, or queued in this run and still waiting in the queue (or just gone out): nothing to send.
      if (delivery !== null && (delivery.outcome !== "queued" || queuedHere.has(stored.id))) {
        settleLeftQueue(store, stored);
        return;
      }
      const requestId = stored.requestId!;
      const kind = overrideKindOf(stored.id);
      const failed = (to: string | null, why: string): void => {
        log(`[paseo-bm] the owner's corrected answer ${stored.id} was not delivered: ${why}.`);
        record(store, stored, { to: to ?? stored.askedBy.agentId ?? "worker", kind, at: now().toISOString(), outcome: "failed" });
      };
      let workerId: string | null;
      try {
        workerId = await workerOf({ workspaceId: stored.workspaceId, requestId, home }, paseo);
      } catch (error) {
        // Not known now; the next plugin run tries again.
        log(`[paseo-bm] could not find the Worker of ${requestId} to deliver override ${stored.id}: ${errorText(error)}`);
        return;
      }
      if (workerId === null) {
        failed(null, `request ${requestId} has no single live Worker`);
        return;
      }
      let text: string;
      try {
        text = overrideAnswersMessageOf(stored, stored.supersedes === null ? null : store.get(stored.supersedes, stored.workspaceId));
      } catch (error) {
        failed(workerId, errorText(error));
        return;
      }
      const outcome = await queue.enqueue(workerId, kind, text, paseo);
      if (outcome === "dropped" || outcome === "replaced") {
        failed(workerId, `Worker ${workerId} is archived, closed or gone, or the send failed`);
        return;
      }
      record(store, stored, { to: workerId, kind, at: now().toISOString(), outcome });
    } catch (error) {
      log(`[paseo-bm] delivering override ${decision.id} failed: ${errorText(error)}`);
    } finally {
      running.delete(decision.id);
    }
  };

  const resume = async (paseo: unknown): Promise<void> => {
    if (resumed || !isPaseo(paseo)) return;
    const home = homeOf();
    if (home === null) return;
    resumed = true;
    try {
      const pending = createDecisionStore(home, { log })
        .list({ statuses: ["answered"] })
        .filter((decision) => isAnsweredQuestionOverride(decision) && (decision.delivery === null || decision.delivery.outcome === "queued"));
      for (const decision of pending) await deliverToWorker(decision, paseo, home);
    } catch (error) {
      log(`[paseo-bm] delivering the corrected answers left from before this run failed: ${errorText(error)}`);
    }
  };

  const onSettled: OnDecisionsSettled = async (decisions, context) => {
    const toWorker: Decision[] = [];
    const toOrchestrator: Decision[] = [];
    const toFallback: Decision[] = [];
    for (const decision of decisions) {
      if (decisionKindOf(decision.id) !== "override" || decision.status !== "answered" || decision.answer === null) continue;
      // A confirmed chat answer names nothing to deliver (an override is never marked for one; kept for safety).
      if (decision.answer.optionKey === null && decision.answer.words === null) continue;
      const kind = deliveryKindOf(decision);
      if (kind === "question") toWorker.push(decision);
      else if (kind === "orchestrator") toOrchestrator.push(decision);
      else if (kind === "fallback") toFallback.push(decision);
      else log(`[paseo-bm] override ${decision.id} names no decision it corrects; nothing was delivered.`);
    }
    if (toWorker.length > 0) {
      const home = homeOf();
      if (home === null) log(`[paseo-bm] ${toWorker.map((decision) => decision.id).join(", ")} answered, but paseo-bm has no data folder to deliver from.`);
      else if (!isPaseo(context.paseo)) {
        // Left undelivered: the next plugin run delivers it.
        log(`[paseo-bm] ${toWorker.map((decision) => decision.id).join(", ")} answered, but there is no Paseo connection to deliver it now.`);
      } else {
        for (const decision of toWorker) await deliverToWorker(decision, context.paseo, home);
        await resume(context.paseo);
      }
    }
    for (const [group, deliver] of [
      [toOrchestrator, deps.orchestrator],
      [toFallback, deps.fallback],
    ] as const) {
      if (group.length === 0 || deliver === undefined) continue;
      try {
        await deliver(group, context);
      } catch (error) {
        log(`[paseo-bm] delivering ${group.map((decision) => decision.id).join(", ")} failed: ${errorText(error)}`);
      }
    }
  };

  /** A Worker's turn record that carries a corrected answer: that `queued` override reached it. */
  const noteArrived = (turn: TraceRecord, store: DecisionStore): void => {
    if (turn.role !== "worker") return;
    for (const message of turn.sent) {
      if (!message.text.startsWith(DELIVERY_NOTICE_MARKER) || !message.text.includes(OVERRIDE_CORRECTION_PREFIX)) continue;
      const block = answerBlockOf(message.text.slice(message.text.indexOf("\n") + 1), turn.requestId);
      if (block === null) continue;
      const corrected = new Set(block.answers.map((answer) => questionDecisionId(block.requestId, answer.id)));
      const at = Number.isNaN(Date.parse(message.at)) ? now().toISOString() : message.at;
      for (const decision of store.list({ workspaceId: turn.workspaceId, requestId: block.requestId, statuses: ["answered"] })) {
        const delivery = decision.delivery;
        if (!isAnsweredQuestionOverride(decision) || !corrected.has(decision.supersedes ?? "")) continue;
        if (delivery === null || delivery.outcome !== "queued" || delivery.to !== turn.agentId) continue;
        record(store, decision, { ...delivery, at, outcome: "sent" });
      }
    }
  };

  const afterTurn = async (turn: TraceRecord, { paseo }: { paseo: unknown }): Promise<void> => {
    try {
      const home = homeOf();
      if (home === null) return;
      if (turn.role === "worker" || queuedHere.size > 0) {
        const store = createDecisionStore(home, { log });
        noteArrived(turn, store);
        for (const id of [...queuedHere.keys()]) {
          const decision = store.get(id);
          if (decision?.delivery?.outcome !== "queued") queuedHere.delete(id);
          else settleLeftQueue(store, decision);
        }
      }
      await resume(paseo);
    } catch (error) {
      log(`[paseo-bm] checking the delivered corrected answers failed: ${errorText(error)}`);
    }
  };

  return { onSettled, afterTurn, resume };
}
