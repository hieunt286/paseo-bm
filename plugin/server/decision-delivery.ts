/**
 * Delivering the owner's answers to a Worker's questions (autonomy design
 * §A.6, owner decision DQ-2, REQ-111, REQ-112): the `question` part of the
 * decisions' `onSettled` hook (`decision-rpc.ts` `settledByKind`). The Manager
 * no longer relays answers; the plugin does.
 *
 * - **At once, whatever is answered.** Each time a `q:` decision is settled —
 *   in the Inbox, on a card, through the Manager's `BM-ANSWERS` — the Worker
 *   gets one message, `Continue <requestId>.` and a `BM-ANSWERS` block
 *   (`answersText`) holding **every** answered, undelivered question of that
 *   request. Questions still open stay open; nothing waits for the round.
 * - **Through the notice queue, never into a running turn.** Kind
 *   `answers:<requestId>`: a newer block replaces an unsent older one, and
 *   since the newer block holds every undelivered answer, nothing is lost.
 * - **To the request's sole live Worker** (`soleWorkerOf`: labelled with the
 *   request, not archived, not replaced by a fallback Worker, one only). None,
 *   or more than one: the answers are recorded `failed` — the Inbox shows it —
 *   and never sent to a guess.
 * - **Recorded on each decision:** `delivery { to, kind, at, outcome }` —
 *   `sent` when the Worker was idle, `queued` while it waits for the Worker's
 *   turn end, `failed` when there is no Worker or the queue dropped it. A
 *   `queued` answer becomes `sent` when the Worker's next turn record shows the
 *   block arrived (`afterTurn`), or when this run's queue no longer holds it.
 * - **Answered in the Worker's own chat** (`via: chat-worker`, including a
 *   confirmed chat answer): the Worker already read it, so nothing is sent; it
 *   is recorded `sent` at the answer's time and never joins a block.
 * - **A reload loses the queue** (it lives in memory): once per plugin run, at
 *   the first settlement or recorded turn that brings a Paseo handle, every
 *   answered `q:` decision still undelivered (`delivery` null, or `queued`) is
 *   delivered again, a block per request. A `queued` one may therefore reach
 *   the Worker twice across a reload; losing an answer would be worse.
 * - **Each request is delivered by one run at a time**; a settlement during a
 *   run makes that run look once more. Never throws: a failure is one log line.
 */
import type { TraceRecord } from "../shared/contracts";
import { answersText, type Pick as AnswerPick, type Question } from "../shared/bm-questions";
import { decisionKindOf, type Decision, type DecisionDelivery } from "../shared/decisions";
import { soleWorkerOf } from "../shared/sole-worker";
import { bmAgentsOf, type DashboardPaseo } from "./dashboard-rpc";
import { answerBlockOf } from "./decision-materialiser";
import type { OnDecisionsSettled } from "./decision-rpc";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { readIncidents, replacementsOf } from "./fallback-state";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { DELIVERY_NOTICE_MARKER } from "../shared/notices";
import { dataHomeOf } from "./role-extras";

const defaultLog = (message: string): void => console.warn(message);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The notice-queue kind of a request's answers: one queued block per request and Worker. */
export function answersKindOf(requestId: string): string {
  return `answers:${requestId}`;
}

function requestKey(workspaceId: string, requestId: string): string {
  return JSON.stringify([workspaceId, requestId]);
}

/** `Qn` of `q:<requestId>:<Qn>`. */
function questionIdOf(decisionId: string): string {
  return decisionId.slice(decisionId.lastIndexOf(":") + 1);
}

function questionNumber(decisionId: string): number {
  return Number(questionIdOf(decisionId).slice(1));
}

/**
 * The message a Worker receives: the plugin's `BM-DELIVERY answers` line (so the
 * trace never counts it as the owner's typing), `Continue <requestId>.`, a blank line, then
 * the `BM-ANSWERS` block of `decisions` in question order — an option as
 * `Qn: a — <label>`, the owner's words as `Qn: other — <words>`. Throws when a
 * decision carries neither (a confirmed chat answer), as `answersText` does.
 */
export function answersMessageOf(requestId: string, decisions: readonly Decision[]): string {
  const ordered = [...decisions].sort((a, b) => questionNumber(a.id) - questionNumber(b.id));
  const questions: Question[] = ordered.map((decision) => ({
    id: questionIdOf(decision.id),
    text: decision.question,
    options: decision.options.map((option) => ({ key: option.key, text: option.label, recommended: option.recommended })),
  }));
  const picks: Record<string, AnswerPick> = {};
  for (const decision of ordered) {
    const answer = decision.answer;
    if (answer?.optionKey != null) picks[questionIdOf(decision.id)] = { key: answer.optionKey };
    else if (answer?.words != null) picks[questionIdOf(decision.id)] = { other: answer.words };
  }
  return `${DELIVERY_NOTICE_MARKER} answers\nContinue ${requestId}.\n\n${answersText(requestId, questions, picks)}`;
}

/** A settled Worker question the plugin may have to deliver. */
function isAnsweredQuestion(decision: Decision): boolean {
  return decisionKindOf(decision.id) === "question" && decision.status === "answered" && decision.answer !== null && decision.requestId !== null;
}

/** Answered where the Worker read it already: in its own chat, or a confirmed chat answer the plugin cannot word. */
function answeredInChat(decision: Decision): boolean {
  const answer = decision.answer!;
  return answer.via === "chat-worker" || (answer.optionKey === null && answer.words === null);
}

function isPaseo(value: unknown): value is DashboardPaseo & NoticePaseo {
  const agents = (value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined)?.agents;
  return typeof agents?.list === "function" && typeof agents?.ref === "function";
}

export interface QuestionDeliveryDeps {
  /** The data folder; looked up otherwise. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** The queue the blocks go through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue" | "pending">;
  /** The request's sole live Worker; `soleWorkerOfRequest` by default. */
  workerOf?: (input: { workspaceId: string; requestId: string; home: string }, paseo: DashboardPaseo) => Promise<string | null>;
}


export interface QuestionDelivery {
  /** The `question` part of `settledByKind`. Never rejects. */
  onSettled: OnDecisionsSettled;
  /**
   * The materialiser's `afterTurn`: a Worker's record showing an answers block
   * arrived marks those `queued` answers `sent`; then, once per plugin run,
   * the undelivered answers are delivered again. Never rejects.
   */
  afterTurn(record: TraceRecord, context: { paseo: unknown }): Promise<void>;
  /** Once per plugin run: delivers every answered, undelivered Worker question. Never rejects. */
  resume(paseo: unknown): Promise<void>;
}

/**
 * The request's sole live Worker in the workspace (`soleWorkerOf` over the
 * paseo-bm agents' labels, with the Workers a fallback Worker replaced left
 * out), or null.
 */
export async function soleWorkerOfRequest(
  input: { workspaceId: string; requestId: string; home: string },
  paseo: DashboardPaseo,
): Promise<string | null> {
  const replacements = replacementsOf(readIncidents(input.home, () => {}).incidents);
  const peers = (await bmAgentsOf(paseo))
    .filter((agent) => agent.workspaceId === input.workspaceId)
    .map(({ facts }) => ({
      id: facts.id,
      role: facts.role,
      requestId: facts.requestIdLabel,
      archived: facts.archived,
      replaced: (facts.replacedBy ?? null) !== null || replacements.has(facts.id),
    }));
  return soleWorkerOf(peers, input.requestId)?.id ?? null;
}

export function createQuestionDecisionDelivery(deps: QuestionDeliveryDeps = {}): QuestionDelivery {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const queue = deps.queue ?? noticeQueue;
  const workerOf = deps.workerOf ?? soleWorkerOfRequest;
  const homeOf = (): string | null => (deps.home === undefined ? dataHomeOf() : deps.home());
  /** Decisions this run queued, and the Worker each went to: the queue is asked whether it still holds them. */
  const queuedHere = new Map<string, string>();
  /** Requests being delivered right now; `again` asks that run for one more look. */
  const running = new Map<string, { again: boolean }>();
  let resumed = false;

  const record = (store: DecisionStore, decision: Decision, delivery: DecisionDelivery): void => {
    try {
      store.transition(decision.id, (current) => ({ ok: true, decision: { ...current, delivery } }), decision.workspaceId);
      if (delivery.outcome === "queued") queuedHere.set(decision.id, delivery.to);
      else queuedHere.delete(decision.id);
    } catch (error) {
      log(`[paseo-bm] could not record the delivery of decision ${decision.id}: ${describeError(error)}`);
    }
  };

  /** The request's answered questions that still have to reach the Worker; records what needs no sending. */
  const undelivered = (store: DecisionStore, workspaceId: string, requestId: string): Decision[] => {
    const kind = answersKindOf(requestId);
    const out: Decision[] = [];
    for (const decision of store.list({ workspaceId, requestId, statuses: ["answered"] })) {
      if (!isAnsweredQuestion(decision)) continue;
      const delivery = decision.delivery;
      if (delivery !== null && delivery.outcome !== "queued") continue;
      if (delivery === null && answeredInChat(decision)) {
        record(store, decision, { to: decision.askedBy.agentId ?? "worker", kind, at: decision.answer!.at, outcome: "sent" });
        continue;
      }
      if (delivery !== null) {
        // Queued in this run and no longer in the queue: it went out at the Worker's turn end.
        const to = queuedHere.get(decision.id);
        if (to === delivery.to && !queue.pending(to).some((notice) => notice.kind === kind)) {
          record(store, decision, { ...delivery, at: now().toISOString(), outcome: "sent" });
          continue;
        }
      }
      out.push(decision);
    }
    return out;
  };

  /** One look at a request: sends its undelivered answers as one block. */
  const deliverOnce = async (workspaceId: string, requestId: string, paseo: DashboardPaseo & NoticePaseo, home: string): Promise<void> => {
    const store = createDecisionStore(home, { log });
    const pending = undelivered(store, workspaceId, requestId);
    if (pending.length === 0) return;
    const kind = answersKindOf(requestId);
    const failAll = (to: string | null, why: string): void => {
      log(`[paseo-bm] the answers ${pending.map((decision) => decision.id).join(", ")} were not delivered: ${why}.`);
      const at = now().toISOString();
      for (const decision of pending) record(store, decision, { to: to ?? decision.askedBy.agentId ?? "worker", kind, at, outcome: "failed" });
    };
    let workerId: string | null;
    try {
      workerId = await workerOf({ workspaceId, requestId, home }, paseo);
    } catch (error) {
      // Not known now; a later settlement or the next plugin run tries again.
      log(`[paseo-bm] could not find the Worker of ${requestId} to deliver its answers: ${describeError(error)}`);
      return;
    }
    if (workerId === null) {
      failAll(null, `request ${requestId} has no single live Worker`);
      return;
    }
    let text: string;
    try {
      text = answersMessageOf(requestId, pending);
    } catch (error) {
      failAll(workerId, describeError(error));
      return;
    }
    const outcome = await queue.enqueue(workerId, kind, text, paseo);
    if (outcome === "dropped") {
      failAll(workerId, `Worker ${workerId} is archived, closed or gone, or the send failed`);
      return;
    }
    // `replaced` cannot come from this module (one run per request); it is still waiting in the queue.
    const at = now().toISOString();
    for (const decision of pending) record(store, decision, { to: workerId, kind, at, outcome: outcome === "sent" ? "sent" : "queued" });
  };

  const deliverRequest = async (workspaceId: string, requestId: string, paseo: DashboardPaseo & NoticePaseo, home: string): Promise<void> => {
    const key = requestKey(workspaceId, requestId);
    const current = running.get(key);
    if (current !== undefined) {
      current.again = true;
      return;
    }
    const flag = { again: false };
    running.set(key, flag);
    try {
      do {
        flag.again = false;
        try {
          await deliverOnce(workspaceId, requestId, paseo, home);
        } catch (error) {
          log(`[paseo-bm] delivering the answers of ${requestId} failed: ${describeError(error)}`);
        }
      } while (flag.again);
    } finally {
      running.delete(key);
    }
  };

  const resume = async (paseo: unknown): Promise<void> => {
    if (resumed || !isPaseo(paseo)) return;
    const home = homeOf();
    if (home === null) return;
    resumed = true;
    try {
      const requests = new Map<string, { workspaceId: string; requestId: string }>();
      for (const decision of createDecisionStore(home, { log }).list({ statuses: ["answered"] })) {
        if (!isAnsweredQuestion(decision) || (decision.delivery !== null && decision.delivery.outcome !== "queued")) continue;
        requests.set(requestKey(decision.workspaceId, decision.requestId!), { workspaceId: decision.workspaceId, requestId: decision.requestId! });
      }
      for (const { workspaceId, requestId } of requests.values()) await deliverRequest(workspaceId, requestId, paseo, home);
    } catch (error) {
      log(`[paseo-bm] delivering the answers left from before this run failed: ${describeError(error)}`);
    }
  };

  const onSettled: OnDecisionsSettled = async (decisions, { paseo }) => {
    try {
      const requests = new Map<string, { workspaceId: string; requestId: string }>();
      for (const decision of decisions) {
        if (!isAnsweredQuestion(decision)) continue;
        requests.set(requestKey(decision.workspaceId, decision.requestId!), { workspaceId: decision.workspaceId, requestId: decision.requestId! });
      }
      if (requests.size === 0) return;
      const home = homeOf();
      if (home === null) {
        log(`[paseo-bm] ${decisions.map((decision) => decision.id).join(", ")} answered, but paseo-bm has no data folder to deliver from.`);
        return;
      }
      if (!isPaseo(paseo)) {
        // Left undelivered: the next settlement or recorded turn with a handle delivers it.
        log(`[paseo-bm] ${decisions.map((decision) => decision.id).join(", ")} answered, but there is no Paseo connection to deliver it now.`);
        return;
      }
      for (const { workspaceId, requestId } of requests.values()) await deliverRequest(workspaceId, requestId, paseo, home);
      await resume(paseo);
    } catch (error) {
      log(`[paseo-bm] delivering answers failed: ${describeError(error)}`);
    }
  };

  /** A Worker's turn record that carries an answers block: those `queued` answers reached it. */
  const noteArrived = (turn: TraceRecord, home: string): void => {
    if (turn.role !== "worker") return;
    let store: DecisionStore | null = null;
    for (const message of turn.sent) {
      // Our own delivery is a plugin notice: read the block under its `BM-DELIVERY` line.
      const text = message.text.startsWith(DELIVERY_NOTICE_MARKER) ? message.text.slice(message.text.indexOf("\n") + 1) : message.text;
      const block = answerBlockOf(text, turn.requestId);
      if (block === null) continue;
      store ??= createDecisionStore(home, { log });
      for (const answer of block.answers) {
        const decision = store.get(`q:${block.requestId}:${answer.id}`, turn.workspaceId);
        const delivery = decision?.delivery ?? null;
        if (decision === null || delivery === null || delivery.outcome !== "queued" || delivery.to !== turn.agentId) continue;
        const at = Number.isNaN(Date.parse(message.at)) ? now().toISOString() : message.at;
        record(store, decision, { ...delivery, at, outcome: "sent" });
      }
    }
  };

  const afterTurn = async (turn: TraceRecord, { paseo }: { paseo: unknown }): Promise<void> => {
    try {
      const home = homeOf();
      if (home === null) return;
      noteArrived(turn, home);
      await resume(paseo);
    } catch (error) {
      log(`[paseo-bm] checking delivered answers failed: ${describeError(error)}`);
    }
  };

  return { onSettled, afterTurn, resume };
}
