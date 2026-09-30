/**
 * Delivering the owner's answer to one of the Orchestrator's decisions
 * (autonomy design §A.6, ADR-017, REQ-112): the `orchestrator` part of the
 * decisions' `onSettled` hook (`decision-rpc.ts` `settledByKind`).
 *
 * - **An option with a prepared command:** the plugin delivers that command
 *   itself, at once, as a `BM-COMMAND` v2 from the Orchestrator (which
 *   prepared it), via the owner's tap, on the authority `decision:<id>`, with
 *   `approved` the option's effects the answer granted — so no limit
 *   contradicts them (`preparedCommandOf`). It goes through the notice queue
 *   to its Manager or Worker, which must still be a live paseo-bm agent of
 *   that role in the project; a Worker's Manager gets the copy
 *   `bm_direct_worker` sends. The grant is claimed and spent exactly as
 *   `bm_send_command` spends it (`claimGrant`, `spendGrant`): only once the
 *   command is delivered. The owner's choice needs no further gate: the
 *   backstop checked the command's text against its effects when it was
 *   asked (`bm_ask_owner`).
 * - **An answer in the owner's own words, or an option without a command:** a
 *   `BM-ANSWER` notice (`answerNoticeOf`) goes to the Orchestrator through the
 *   notice queue, with the grant it may spend: one command, with that
 *   `decisionId`, before the grant expires.
 * - **A prepared command that could not be delivered** leaves the grant
 *   unused and tells the Orchestrator so in the same `BM-ANSWER`.
 *
 * Each decision is delivered once: never again once it records a `delivery`,
 * nor while a delivery for it is under way. A confirmed chat answer (no
 * option, no words) names nothing to deliver. Never throws: a failure is one
 * log line and a `failed` delivery.
 */
import { createDecisionStore } from "./decision-store";
import type { OnDecisionsSettled } from "./decision-rpc";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { commandKindOf } from "./orchestrator-actions";
import { findOrchestratorAgent, type OrchestratorAgentPaseo } from "./orchestrator-agent";
import { claimGrant, firstLine, preparedCommandOf, spendGrant, workingAgents, type OrchestratorToolsPaseo } from "./orchestrator-tools";
import { dataHomeOf } from "./role-extras";
import { ANSWER_NOTICE_MARKER } from "../shared/notices";
import { commandBlockOf } from "../shared/orchestrator-command";
import { grantRefusal, realEffects, type Decision, type DecisionDelivery, type Effect } from "../shared/decisions";

const defaultLog = (message: string): void => console.warn(message);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The notice-queue kind of a `BM-ANSWER`: one per decision. */
export function answerKindOf(decisionId: string): string {
  return `answer:${decisionId}`;
}

/**
 * The `BM-ANSWER` notice the Orchestrator receives (autonomy design §A.6):
 * which decision, what the owner answered, the grant it may spend, and — when
 * the plugin could not deliver the option's prepared command — why. The
 * owner's own words follow the header after one blank line, as written.
 */
export function answerNoticeOf(decision: Decision, failure: string | null = null): string {
  const answer = decision.answer;
  const option = answer?.optionKey == null ? null : (decision.options.find((entry) => entry.key === answer.optionKey) ?? null);
  const grant = decision.grant;
  const lines = [
    ANSWER_NOTICE_MARKER,
    `decisionId: ${decision.id}`,
    `workspaceId: ${decision.workspaceId}`,
    `requestId: ${decision.requestId ?? "none"}`,
    `question: ${firstLine(decision.question, {}) ?? ""}`,
    `answer: ${option !== null ? `option ${option.key}: ${option.label}` : answer?.words != null ? "in the owner's own words, below" : "none"}`,
    grant === null || grant.usedAt !== null
      ? "grant: none"
      : `grant: ${grant.effects.join(", ")}, for one command with decisionId ${decision.id}, until ${grant.expiresAt}`,
  ];
  if (failure !== null) lines.push(`delivery: the prepared command was not delivered (${failure}); nothing was sent, and the grant is unused`);
  lines.push("This is the owner's answer, delivered by the paseo-bm plugin. Act on it now; tell the owner in one line what you did.");
  if (option === null && answer?.words != null) lines.push("", answer.words);
  return lines.join("\n");
}

export interface OrchestratorDeliveryDeps {
  /** The data folder; looked up otherwise. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** The queue commands and notices go through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
}

type DeliveryPaseo = OrchestratorToolsPaseo & NoticePaseo;

function isDeliveryPaseo(value: unknown): value is DeliveryPaseo {
  const agents = (value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined)?.agents;
  return typeof agents?.list === "function" && typeof agents?.ref === "function";
}

function delivered(outcome: string): outcome is "sent" | "queued" {
  return outcome === "sent" || outcome === "queued";
}

/**
 * The `orchestrator` part of the decisions' `onSettled` hook (§A.6): see the
 * module comment. Never throws.
 */
export function createOrchestratorDecisionDelivery(deps: OrchestratorDeliveryDeps = {}): OnDecisionsSettled {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const running = new Set<string>();

  /** Delivers the prepared command of the chosen option: its delivery, and why it failed (null when it did not). */
  const deliverCommand = async (decision: Decision, paseo: DeliveryPaseo, home: string): Promise<{ failure: string | null; delivery: DecisionDelivery }> => {
    const option = decision.options.find((entry) => entry.key === decision.answer?.optionKey)!;
    const action = option.action;
    if (action?.kind !== "command") throw new Error("not a prepared command");
    const at = now();
    const kind = commandKindOf(decision.id);
    const failed = (failure: string) => ({ failure, delivery: { to: action.agentId, kind, at: at.toISOString(), outcome: "failed" as const } });
    // What the answer granted of the command's effects; the rest stays withheld by the limits.
    const approved: Effect[] = realEffects(action.effects).filter((effect) => decision.grant?.effects.includes(effect) === true);
    const grantOf = approved.length > 0 ? decision.id : null;
    if (grantOf !== null) {
      const refusal = grantRefusal(decision, approved, at.toISOString());
      if (refusal !== null) return failed(refusal.message);
    }
    let agents: Awaited<ReturnType<typeof workingAgents>>;
    try {
      agents = await workingAgents(paseo);
    } catch (error) {
      return failed(`the agents could not be listed: ${describeError(error)}`);
    }
    const target = agents.find((agent) => agent.id === action.agentId);
    if (target === undefined || target.role !== action.to || target.workspaceId !== decision.workspaceId || target.archived) {
      return failed(`${action.agentId} is no longer a live paseo-bm ${action.to} of project ${decision.workspaceId}`);
    }
    const command = preparedCommandOf(decision, option, action, approved);
    let text: string;
    try {
      text = commandBlockOf(command);
    } catch (error) {
      return failed(describeError(error));
    }
    let release: () => void;
    try {
      release = claimGrant(grantOf);
    } catch (error) {
      return failed(describeError(error));
    }
    const queue = deps.queue ?? noticeQueue;
    let outcome: Awaited<ReturnType<NoticeQueue["enqueue"]>>;
    try {
      outcome = await queue.enqueue(target.id, kind, text, paseo);
    } catch (error) {
      release();
      return failed(describeError(error));
    }
    if (!delivered(outcome)) {
      release();
      return failed(`${action.to} ${target.id} could not be reached`);
    }
    const spent = spendGrant(grantOf, decision.workspaceId, approved, { home, now: at });
    if (spent !== null) log(`[paseo-bm] decision ${decision.id}: ${spent}`);
    if (action.to === "worker") {
      // The copy `bm_direct_worker` sends (ADR-016 decision 2): the Worker's own Manager, when it is one of the project.
      const manager = agents.find(
        (agent) => agent.id === target.parentAgentId && agent.role === "manager" && !agent.archived && agent.workspaceId === decision.workspaceId,
      );
      if (manager !== undefined) {
        const copy = await queue.enqueue(manager.id, kind, commandBlockOf({ ...command, copy: true }), paseo);
        if (!delivered(copy)) log(`[paseo-bm] decision ${decision.id}: the copy to Manager ${manager.id} could not be delivered.`);
      }
    }
    return { failure: null, delivery: { to: target.id, kind, at: at.toISOString(), outcome } };
  };

  /** Hands the answer to the Orchestrator as a `BM-ANSWER`. */
  const deliverAnswer = async (decision: Decision, paseo: DeliveryPaseo, failure: string | null): Promise<DecisionDelivery> => {
    const at = now().toISOString();
    const kind = answerKindOf(decision.id);
    let orchestratorId: string | null = null;
    try {
      orchestratorId = (await findOrchestratorAgent(paseo as unknown as OrchestratorAgentPaseo))?.id ?? null;
    } catch (error) {
      log(`[paseo-bm] decision ${decision.id}: the Orchestrator could not be looked up: ${describeError(error)}`);
    }
    if (orchestratorId === null) {
      log(`[paseo-bm] decision ${decision.id} is answered, but no Beads Orchestrator is open to receive it; it reads it with bm_decisions.`);
      return { to: decision.askedBy.agentId ?? "orchestrator", kind, at, outcome: "failed" };
    }
    const outcome = await (deps.queue ?? noticeQueue).enqueue(orchestratorId, kind, answerNoticeOf(decision, failure), paseo);
    return { to: orchestratorId, kind, at, outcome: delivered(outcome) ? outcome : "failed" };
  };

  return async (decisions, { paseo }) => {
    for (const decision of decisions) {
      const answer = decision.answer;
      if (decision.status !== "answered" || answer === null || !decision.id.startsWith("o:")) continue;
      // A confirmed chat answer: the owner said it in a chat; nothing to deliver.
      if (answer.optionKey === null && answer.words === null) continue;
      if (running.has(decision.id)) continue;
      running.add(decision.id);
      try {
        const home = deps.home === undefined ? dataHomeOf() : deps.home();
        if (home === null) {
          log(`[paseo-bm] decision ${decision.id} was answered, but paseo-bm has no data folder to deliver it from.`);
          continue;
        }
        const store = createDecisionStore(home, { log });
        const stored = store.get(decision.id, decision.workspaceId) ?? decision;
        if (stored.delivery !== null) continue;
        let delivery: DecisionDelivery;
        if (!isDeliveryPaseo(paseo)) {
          log(`[paseo-bm] decision ${decision.id} was answered, but there is no Paseo connection to deliver it.`);
          delivery = { to: stored.askedBy.agentId ?? "orchestrator", kind: answerKindOf(stored.id), at: now().toISOString(), outcome: "failed" };
        } else {
          const option = stored.options.find((entry) => entry.key === answer.optionKey);
          if (option?.action?.kind === "command") {
            const result = await deliverCommand(stored, paseo, home);
            delivery = result.delivery;
            if (result.failure !== null) {
              log(`[paseo-bm] decision ${stored.id}: its command was not delivered: ${result.failure}`);
              await deliverAnswer(store.get(stored.id, stored.workspaceId) ?? stored, paseo, result.failure);
            }
          } else {
            delivery = await deliverAnswer(stored, paseo, null);
          }
        }
        try {
          store.transition(stored.id, (current) => ({ ok: true, decision: { ...current, delivery } }), stored.workspaceId);
        } catch (error) {
          log(`[paseo-bm] could not record the delivery of decision ${stored.id}: ${describeError(error)}`);
        }
      } catch (error) {
        log(`[paseo-bm] delivering decision ${decision.id} failed: ${describeError(error)}`);
      } finally {
        running.delete(decision.id);
      }
    }
  };
}
