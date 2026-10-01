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
 *   `bm_direct_worker` sends. It is sent by the one send pipeline
 *   (`command-send.ts`), as `bm_send_command`'s commands are: the grant is
 *   claimed and spent only once the command is delivered, and the command is
 *   recorded in the commands store, where the loop guard counts it. The
 *   owner's choice needs no further gate: the backstop checked the command's
 *   text against its effects when it was asked (`bm_ask_owner`), and the loop
 *   guard never refuses the owner's own answer.
 * - **An answer in the owner's own words, or an option without a command:** a
 *   `BM-ANSWER` notice (`answerNoticeOf`) goes to the Orchestrator through the
 *   notice queue, with the grant it may spend: one command, with that
 *   `decisionId`, before the grant expires.
 * - **A prepared command that could not be delivered** leaves the grant
 *   unused and tells the Orchestrator so in the same `BM-ANSWER`.
 * - **An option with a prepared change of the owner's settings** (autonomy
 *   design §G.4: a precedent, an autonomy cell, a coordination setting): the
 *   plugin applies it itself on the owner's own answer, through the Settings
 *   RPC that owns it (`prepared-changes.ts`), before anything is delivered;
 *   the `BM-ANSWER` says on a `change:` line whether it was applied. No other
 *   answerer can choose such an option (`answerDecision`).
 * - **Chosen by the owner's policy** (autonomy design §B.5, `by: policy`): the
 *   same delivery, but the command goes on the policy's authority
 *   (`authority: policy:<class>`, `via: chat`, the answer's class), its grant
 *   claimed and spent the same way; one whose `approved` would hold a
 *   release, data, security or cost effect is never sent (the builder refuses
 *   it). The `BM-ANSWER` names the policy on a `policy:` line.
 * - **Chosen by the policy or an owner precedent while the loop guard is
 *   full** for its request (12 commands in 24 hours, whichever way they
 *   went): not sent; the `BM-ANSWER` says so, and the grant is unused.
 *
 * Each decision is delivered once: never again once it records a `delivery`,
 * nor while a delivery for it is under way. A confirmed chat answer (no
 * option, no words) names nothing to deliver. Never throws: a failure is one
 * log line and a `failed` delivery.
 */
import { createDecisionStore } from "./decision-store";
import type { OnDecisionsSettled } from "./decision-rpc";
import { preparedCommandOf } from "./command-authority";
import { copyRecipientOf, sendCommand, type CommandSendResult } from "./command-send";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { commandKindOf } from "./orchestrator-state";
import { findOrchestratorAgent, type OrchestratorAgentPaseo } from "./orchestrator-agent";
import type { OrchestratorStoreDeps } from "./orchestrator-store";
import { workingAgents, type OrchestratorToolsPaseo } from "./orchestrator-tool-context";
import { applyPreparedChange, type PreparedChangeResult } from "./prepared-changes";
import { firstLine } from "./request-trace";
import { dataHomeOf } from "./role-instructions";
import { ANSWER_NOTICE_MARKER } from "../shared/notices";
import { decisionClassOf, decisionKindOf, deliveryKindOf, grantRefusal, policyPredictorOf, realEffects, type Decision, type DecisionDelivery, type Effect } from "../shared/decisions";
import { errorText } from "./rpc-kit";

const defaultLog = (message: string): void => console.warn(message);

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
export function answerNoticeOf(decision: Decision, failure: string | null = null, change: PreparedChangeResult | null = null): string {
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
  // Autonomy design §B.6: an answer an owner precedent gave cites it.
  if (answer?.by === "precedent") lines.push(`precedent: ${answer.precedentId ?? "unknown"}, the owner's standing answer${decision.subject === null ? "" : ` on "${decision.subject}"`}`);
  // Autonomy design §B.5: an answer the owner's policy gave names the class it delegates.
  if (answer?.by === "policy") lines.push(`policy: ${answer.class ?? decisionClassOf(decision)} is delegated to the ${policyPredictorOf(decision) === "recommended" ? "recommended option" : "Orchestrator"} in this project; the owner was not asked`);
  // Autonomy design §B.7: the owner's override corrects an answer made for them; it replaces that answer.
  if (decisionKindOf(decision.id) === "override") lines.push(`overrides: ${decision.supersedes ?? "unknown"}, answered earlier for the owner; this answer replaces that one`);
  if (failure !== null) lines.push(`delivery: the prepared command was not delivered (${failure}); nothing was sent, and the grant is unused`);
  // Autonomy design §G.4: the prepared change of the owner's settings the plugin applied on this answer, or why not.
  if (change !== null) {
    lines.push(
      change.applied
        ? `change: applied by the plugin — it ${change.text}${change.wrote ? "" : " (it was so already)"}; send nothing for it`
        : `change: not applied (${change.reason}); nothing was changed — tell the owner, and set nothing yourself`,
    );
  }
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
  /** The commands store's own deps (fixed command ids in tests); its clock is `now` unless given. */
  store?: OrchestratorStoreDeps;
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

  /**
   * Delivers the prepared command of the chosen option through the one send
   * pipeline (`sendCommand`): its delivery, and why it failed (null when it
   * did not).
   */
  const deliverCommand = async (decision: Decision, paseo: DeliveryPaseo, home: string): Promise<{ failure: string | null; delivery: DecisionDelivery }> => {
    const option = decision.options.find((entry) => entry.key === decision.answer?.optionKey)!;
    const action = option.action;
    if (action?.kind !== "command") throw new Error("not a prepared command");
    const at = now();
    const kind = commandKindOf(decision.id);
    const failed = (failure: string) => ({ failure, delivery: { to: action.agentId, kind, at: at.toISOString(), outcome: "failed" as const } });
    // What the answer granted of the command's effects; the rest stays withheld by the limits.
    const approved: Effect[] = realEffects(action.effects).filter((effect) => decision.grant?.effects.includes(effect) === true);
    // Autonomy design §B.5: an option the owner's policy chose goes on the policy's authority — never with a release,
    // data, security or cost effect: the builder refuses such a block (`commandInputProblems`; code review 2026-09-30 §6).
    const policyClass = decision.answer?.by === "policy" ? (decision.answer.class ?? decisionClassOf(decision)) : null;
    const grantOf = approved.length > 0 ? decision.id : null;
    if (grantOf !== null) {
      const refusal = grantRefusal(decision, approved, at.toISOString());
      if (refusal !== null) return failed(refusal.message);
    }
    let agents: Awaited<ReturnType<typeof workingAgents>>;
    try {
      agents = await workingAgents(paseo);
    } catch (error) {
      return failed(`the agents could not be listed: ${errorText(error)}`);
    }
    const target = agents.find((agent) => agent.id === action.agentId);
    if (target === undefined || target.role !== action.to || target.workspaceId !== decision.workspaceId || target.archived) {
      return failed(`${action.agentId} is no longer a live paseo-bm ${action.to} of project ${decision.workspaceId}`);
    }
    // The copy `bm_direct_worker` sends (ADR-016 decision 2): the Worker's own Manager, when it is one of the project.
    const copyTo = action.to === "worker" ? (copyRecipientOf(agents, target, decision.workspaceId)?.id ?? null) : null;
    let sent: CommandSendResult;
    try {
      sent = await sendCommand({
        home,
        now: at,
        paseo,
        workspaceId: decision.workspaceId,
        command: preparedCommandOf(decision, option, action, approved, policyClass),
        targetId: target.id,
        copyTo,
        grantOf,
        approved,
        // The backstop checked the text against the option's effects when it was asked (`bm_ask_owner`).
        backstop: false,
        // The owner's own answer is counted and never refused; one a precedent or the policy gave is refused once the guard is full.
        loopGuard: decision.answer?.by === "owner" ? "count" : "refuse",
        kind,
        intervention: null,
        queue: deps.queue ?? noticeQueue,
        store: { now: () => at, ...deps.store },
        log,
      });
    } catch (error) {
      return failed(errorText(error));
    }
    if (!sent.ok) return failed(sent.reason);
    if (sent.spent !== null) log(`[paseo-bm] decision ${decision.id}: ${sent.spent}`);
    if (sent.unrecorded !== null) log(`[paseo-bm] decision ${decision.id}: its command was delivered, but could not be recorded: ${sent.unrecorded}`);
    if (sent.copy === "failed") log(`[paseo-bm] decision ${decision.id}: the copy to Manager ${copyTo} could not be delivered.`);
    return { failure: null, delivery: { to: target.id, kind, at: at.toISOString(), outcome: sent.outcome } };
  };

  /** Hands the answer to the Orchestrator as a `BM-ANSWER`. */
  const deliverAnswer = async (
    decision: Decision,
    paseo: DeliveryPaseo,
    failure: string | null,
    change: PreparedChangeResult | null = null,
  ): Promise<DecisionDelivery> => {
    const at = now().toISOString();
    const kind = answerKindOf(decision.id);
    let orchestratorId: string | null = null;
    try {
      orchestratorId = (await findOrchestratorAgent(paseo as unknown as OrchestratorAgentPaseo))?.id ?? null;
    } catch (error) {
      log(`[paseo-bm] decision ${decision.id}: the Orchestrator could not be looked up: ${errorText(error)}`);
    }
    if (orchestratorId === null) {
      log(`[paseo-bm] decision ${decision.id} is answered, but no Beads Orchestrator is open to receive it; it reads it with bm_decisions.`);
      return { to: decision.askedBy.agentId ?? "orchestrator", kind, at, outcome: "failed" };
    }
    const outcome = await (deps.queue ?? noticeQueue).enqueue(orchestratorId, kind, answerNoticeOf(decision, failure, change), paseo);
    return { to: orchestratorId, kind, at, outcome: delivered(outcome) ? outcome : "failed" };
  };

  return async (decisions, { paseo }) => {
    for (const decision of decisions) {
      const answer = decision.answer;
      // An `o:` decision, or the owner's override of one (§B.7), which `override-delivery.ts` hands here.
      if (decision.status !== "answered" || answer === null || deliveryKindOf(decision) !== "orchestrator") continue;
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
        // Autonomy design §G.4: the chosen option's prepared change of the owner's settings, applied on the owner's
        // own answer only (`applyPreparedChange` reads `by: owner`) and before any delivery: it needs no Paseo handle.
        const change = applyPreparedChange(stored, { home, now: now(), log });
        if (change !== null) {
          log(
            change.applied
              ? `[paseo-bm] decision ${stored.id}: the owner's answer ${change.wrote ? "applied" : "found already applied"}: it ${change.text}`
              : `[paseo-bm] decision ${stored.id}: the owner's answer could not apply its change (${change.reason}); nothing was changed`,
          );
        }
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
            delivery = await deliverAnswer(stored, paseo, null, change);
          }
        }
        try {
          store.transition(stored.id, (current) => ({ ok: true, decision: { ...current, delivery } }), stored.workspaceId);
        } catch (error) {
          log(`[paseo-bm] could not record the delivery of decision ${stored.id}: ${errorText(error)}`);
        }
      } catch (error) {
        log(`[paseo-bm] delivering decision ${decision.id} failed: ${errorText(error)}`);
      } finally {
        running.delete(decision.id);
      }
    }
  };
}
