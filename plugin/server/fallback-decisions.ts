/**
 * Fallback incidents as decisions (autonomy design §A.5 d, REQ-110, REQ-111).
 *
 * Each `pending` incident of `role-fallback-state.json` is one open decision
 * `f:<incidentId>` in the decision store, whose options are what the fallback
 * card offers for it — Switch (with a candidate), Wait (with a reset at most
 * 7 days ahead), "I'll handle it" — each carrying a prepared `fallback` action.
 *
 * - **Open and withdraw:** `syncFallbackDecisions` aligns the store with the
 *   incidents file: a pending incident without a decision gets one; an open
 *   `f:` decision whose incident is no longer pending (decided on the card,
 *   waited, switched, failed, dropped) is withdrawn. It is idempotent and runs
 *   after every incident written, after every `fallback.act`, and once per
 *   plugin run (incidents recorded before this build).
 * - **Answer:** `createFallbackDecisionDelivery` is the `fallback` part of the
 *   decisions' `onSettled` hook: the chosen option's prepared action runs
 *   through `fallback.act`'s own handler — the same lock, checks and actions as
 *   a click — once per decision, and its outcome is recorded as the decision's
 *   `delivery`.
 * - **Auto policy:** an incident the `auto` policy is deciding is held
 *   (`holdFallbackDecision`), so it gets a decision only when the policy
 *   leaves it pending.
 * - **A failed action** (autonomy design §A.8): an answered `f:` decision whose
 *   `delivery.outcome` is `failed` while its incident is still pending keeps a
 *   `fallback-failed` Inbox alert open, so the owner can act again; the alert
 *   is cleared once the incident is no longer pending (`syncFallbackFailedAlerts`,
 *   run with every alignment and after every delivery).
 *
 * The options declare no effect: the plugin runs the action itself, so an
 * answer grants nothing an agent could spend (§A.3 grants are for commands).
 * The fallback's own safety rules stay in the action code; the decision only
 * chooses the action.
 */
import { createAlertStore } from "./alert-store";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { readIncidents } from "./fallback-state";
import { providerId } from "./provider-id";
import { reasonOf } from "./role-choices";
import { dataHomeOf } from "./role-extras";
import type { OnDecisionsSettled } from "./decision-rpc";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import { FALLBACK_MAX_WAIT_MS, type FallbackActInput, type FallbackIncident } from "../shared/contracts";
import { alertKeyOf } from "../shared/alerts";
import {
  MAX_DECISION_TEXT_CHARS,
  UNSETTLED_STATUSES,
  withdrawDecision,
  type Decision,
  type DecisionDelivery,
  type DecisionOption,
} from "../shared/decisions";

/** Every fallback decision id starts with this (§A.3). */
export const FALLBACK_DECISION_PREFIX = "f:";

/** Longest provider message quoted in the question. */
export const QUESTION_MESSAGE_CHARS = 300;

/** A reset this close is waited for rather than switched away from (§4.6, REQ-067 b). */
export const AUTO_WAIT_WINDOW_MS = 30 * 60 * 1000;

const defaultLog = (message: string): void => console.warn(message);

const ROLE_NAMES: Readonly<Record<FallbackIncident["role"], string>> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

/** `f:<incidentId>`. */
export function fallbackDecisionId(incidentId: string): string {
  return `${FALLBACK_DECISION_PREFIX}${incidentId}`;
}

/** The incident id of a fallback decision id, or null for any other id. */
export function incidentIdOf(decisionId: string): string | null {
  if (!decisionId.startsWith(FALLBACK_DECISION_PREFIX)) return null;
  const id = decisionId.slice(FALLBACK_DECISION_PREFIX.length);
  return id === "" ? null : id;
}

/**
 * What the `auto` policy chooses for a new `pending` incident (§4.6): `wait`
 * when the reset is known and at most 30 minutes away (a reset already past
 * counts), else `switch` when there is a candidate, else nothing — the
 * incident stays pending, as with "Ask me". The decision recommends the same.
 */
export function autoActionOf(incident: FallbackIncident, now: Date): "wait" | "switch" | null {
  const resetsAt = incident.resetsAt === null ? Number.NaN : Date.parse(incident.resetsAt);
  if (!Number.isNaN(resetsAt) && resetsAt - now.getTime() <= AUTO_WAIT_WINDOW_MS) return "wait";
  return incident.candidate === null ? null : "switch";
}

/**
 * The options of a pending incident's decision, as the card offers them: Switch
 * when there is a candidate, Wait when the reset is known and at most 7 days
 * ahead (a past one resumes at once), and "I'll handle it" always. The option
 * the `auto` policy would choose is recommended.
 */
export function fallbackOptionsOf(incident: FallbackIncident, now: Date): DecisionOption[] {
  const recommended = autoActionOf(incident, now);
  const option = (key: "switch" | "wait" | "dismiss", label: string): DecisionOption => ({
    key,
    label,
    recommended: key === recommended,
    effects: ["none"],
    action: { kind: "fallback", action: key, target: incident.id },
  });
  const options: DecisionOption[] = [];
  if (incident.candidate !== null) {
    const candidate = incident.candidate;
    options.push(option("switch", `Switch to ${candidate.alias} · ${candidate.baseProvider} · ${candidate.model}`));
  }
  const resetsAt = incident.resetsAt === null ? Number.NaN : Date.parse(incident.resetsAt);
  if (!Number.isNaN(resetsAt) && resetsAt - now.getTime() <= FALLBACK_MAX_WAIT_MS) {
    options.push(
      option(
        "wait",
        resetsAt > now.getTime()
          ? `Wait until the limit resets (${incident.resetsAt}), then resume`
          : `Resume now (the limit reset at ${incident.resetsAt})`,
      ),
    );
  }
  options.push(option("dismiss", "I'll handle it"));
  return options;
}

/** The question of an incident: who stopped, why, and what the fallback chain has left. */
export function fallbackQuestionOf(incident: FallbackIncident): string {
  const alias = providerId(incident.agentProvider) ?? incident.agentProvider;
  const provider = incident.agentModel === null ? alias : `${alias} · ${incident.agentModel}`;
  const message = incident.message.replace(/\s+/g, " ").trim().slice(0, QUESTION_MESSAGE_CHARS);
  const text = [
    `The ${ROLE_NAMES[incident.role]} ${incident.agentId} stopped: ${FALLBACK_CLASS_LABELS[incident.class]} on ${provider}.`,
    message === "" ? null : `The provider said: "${message}"`,
    incident.candidate === null ? "No fallback model is left in its chain." : null,
    "What should happen?",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
  return text.slice(0, MAX_DECISION_TEXT_CHARS);
}

/** The open decision of a pending incident (§A.5 d). */
export function fallbackDecisionOf(incident: FallbackIncident, now: Date): Decision {
  return {
    id: fallbackDecisionId(incident.id),
    workspaceId: incident.workspaceId,
    requestId: incident.requestId,
    askedBy: { role: "plugin", agentId: null },
    askedAt: incident.detectedAt,
    round: null,
    question: fallbackQuestionOf(incident),
    subject: `fallback-${incident.role}`,
    options: fallbackOptionsOf(incident, now),
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
  };
}

// ---------------------------------------------------------------------------
// Opening and withdrawing.
// ---------------------------------------------------------------------------

/**
 * Aligns the `fallback-failed` Inbox alerts (autonomy design §A.8): one open
 * alert per answered `f:` decision whose prepared action failed while its
 * incident is still pending; every other such alert is cleared. Returns the
 * alert keys raised and cleared. Throws on an unreadable store.
 */
export function syncFallbackFailedAlerts(
  home: string,
  decisions: DecisionStore,
  incidents: ReadonlyMap<string, FallbackIncident>,
  now: () => Date,
): { raised: string[]; cleared: string[] } {
  const alerts = createAlertStore(home, { now });
  const failing = new Set<string>();
  const raised: string[] = [];
  for (const decision of decisions.list({ statuses: ["answered"] })) {
    const incidentId = incidentIdOf(decision.id);
    if (incidentId === null || decision.delivery?.outcome !== "failed" || incidents.get(incidentId)?.status !== "pending") continue;
    failing.add(alertKeyOf("fallback-failed", decision.workspaceId, decision.id));
    const kind = decision.delivery.kind.startsWith("fallback:") ? decision.delivery.kind.slice("fallback:".length) : decision.delivery.kind;
    const result = alerts.raise({
      workspaceId: decision.workspaceId,
      kind: "fallback-failed",
      subject: decision.id,
      detail: `The chosen fallback action (${kind}) for incident ${incidentId} failed; the ${incidents.get(incidentId)!.role} is still stopped.`,
    });
    if (result.raised) raised.push(result.alert.key);
  }
  const cleared = alerts.clearWhere((alert) => alert.kind === "fallback-failed" && !failing.has(alert.key));
  return { raised, cleared };
}

/** Incidents the `auto` policy is deciding right now: no decision is opened for them meanwhile. */
const held = new Set<string>();

/** Holds back the decision of an incident until the returned release is called. */
export function holdFallbackDecision(incidentId: string): () => void {
  held.add(incidentId);
  return () => {
    held.delete(incidentId);
  };
}

export interface FallbackDecisionDeps {
  now?: () => Date;
  log?: (message: string) => void;
}

export interface FallbackDecisionSync {
  /** Decision ids opened by this pass. */
  opened: string[];
  /** Decision ids withdrawn by this pass. */
  withdrawn: string[];
  /** `fallback-failed` alert keys raised by this pass. */
  alerted: string[];
}

/**
 * Aligns the `f:` decisions with the incidents in `home`: opens the decision
 * of each pending incident that has none (never one already stored, whatever
 * its status), and withdraws each open `f:` decision whose incident is no
 * longer pending or is gone. An unreadable incidents file changes nothing.
 * Synchronous from the first read to the last write, so it cannot interleave
 * with another pass. Never throws: a failure costs one log line.
 */
export function syncFallbackDecisions(home: string, deps: FallbackDecisionDeps = {}): FallbackDecisionSync {
  const log = deps.log ?? defaultLog;
  const result: FallbackDecisionSync = { opened: [], withdrawn: [], alerted: [] };
  try {
    const read = readIncidents(home, log);
    if (read.error !== null) return result;
    const now = (deps.now ?? (() => new Date()))();
    const at = now.toISOString();
    const store = createDecisionStore(home, { log });
    const incidents = new Map(read.incidents.map((incident) => [incident.id, incident]));
    for (const decision of store.list({ statuses: UNSETTLED_STATUSES })) {
      const incidentId = incidentIdOf(decision.id);
      if (incidentId === null || incidents.get(incidentId)?.status === "pending") continue;
      try {
        const moved = store.transition(decision.id, (current) => withdrawDecision(current, { at }), decision.workspaceId);
        if (moved.status === "updated") result.withdrawn.push(decision.id);
      } catch (error) {
        log(`[paseo-bm] could not withdraw decision ${decision.id}: ${reasonOf(error)}`);
      }
    }
    for (const incident of read.incidents) {
      if (incident.status !== "pending" || held.has(incident.id)) continue;
      try {
        const opened = store.open(fallbackDecisionOf(incident, now));
        if (opened.created) result.opened.push(opened.decision.id);
      } catch (error) {
        log(`[paseo-bm] could not open the decision of fallback incident ${incident.id}: ${reasonOf(error)}`);
      }
    }
    try {
      result.alerted = syncFallbackFailedAlerts(home, store, incidents, () => now).raised;
    } catch (error) {
      log(`[paseo-bm] could not align the fallback-failed alerts: ${reasonOf(error)}`);
    }
  } catch (error) {
    log(`[paseo-bm] aligning the fallback decisions failed: ${reasonOf(error)}`);
  }
  return result;
}

/**
 * `syncFallbackDecisions` once per plugin run, for incidents recorded before
 * this build or while the plugin was not running: call it at the first hook or
 * RPC of the run (Paseo gives a plugin no start-up event). It stays armed
 * until a data folder is found. Never throws.
 */
export function createFallbackDecisionStartup(deps: FallbackDeliveryDeps = {}): () => void {
  let done = false;
  return () => {
    if (done) return;
    const home = deps.home === undefined ? dataHomeOf() : deps.home();
    if (home === null) return;
    done = true;
    syncFallbackDecisions(home, deps);
  };
}

// ---------------------------------------------------------------------------
// Answering.
// ---------------------------------------------------------------------------

/** `fallback.act`'s handler, bound to the plugin's actions. */
export type FallbackAct = (input: FallbackActInput, paseo: unknown) => Promise<{ incident: FallbackIncident }>;

export interface FallbackDeliveryDeps extends FallbackDecisionDeps {
  /** The data folder; looked up otherwise. */
  home?: () => string | null;
}

/**
 * The `fallback` part of the decisions' `onSettled` hook (§A.6 "Fallback:
 * `fallback.act` with the prepared action"). For each answered `f:` decision
 * whose chosen option carries a prepared `fallback` action for its own
 * incident, runs `act` once — never again for a decision that already records
 * a delivery, nor while a run for it is under way — and records the outcome
 * as the decision's `delivery` (`sent`, or `failed` when the action refused:
 * the incident is then as the action left it). An answer in words, or a
 * confirmed chat answer, names no action: nothing runs. Never throws.
 */
export function createFallbackDecisionDelivery(act: FallbackAct, deps: FallbackDeliveryDeps = {}): OnDecisionsSettled {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const running = new Set<string>();

  return async (decisions, { paseo }) => {
    for (const decision of decisions) {
      const incidentId = incidentIdOf(decision.id);
      if (incidentId === null || decision.status !== "answered" || decision.answer === null) continue;
      const action = decision.options.find((option) => option.key === decision.answer?.optionKey)?.action;
      if (action?.kind !== "fallback") {
        log(`[paseo-bm] decision ${decision.id} was answered without one of its actions; fallback incident ${incidentId} is left as it is.`);
        continue;
      }
      if (action.target !== incidentId) {
        log(`[paseo-bm] decision ${decision.id} names incident ${action.target}, not ${incidentId}; nothing was run.`);
        continue;
      }
      if (running.has(decision.id)) continue;
      running.add(decision.id);
      try {
        const home = deps.home === undefined ? dataHomeOf() : deps.home();
        if (home === null) {
          log(`[paseo-bm] decision ${decision.id} was answered, but paseo-bm has no data folder to run its action from.`);
          continue;
        }
        const store = createDecisionStore(home, { log });
        const stored = store.get(decision.id, decision.workspaceId) ?? decision;
        if (stored.delivery !== null) continue;

        let outcome: DecisionDelivery["outcome"] = "sent";
        let to: string | null = null;
        try {
          to = (await act({ incidentId, action: action.action }, paseo)).incident.agentId;
        } catch (error) {
          outcome = "failed";
          log(`[paseo-bm] decision ${decision.id}: ${action.action} on fallback incident ${incidentId} failed: ${reasonOf(error)}`);
        }
        to ??= readIncidents(home, () => {}).incidents.find((incident) => incident.id === incidentId)?.agentId ?? incidentId;
        const delivery: DecisionDelivery = { to, kind: `fallback:${action.action}`, at: now().toISOString(), outcome };
        try {
          store.transition(decision.id, (current) => ({ ok: true, decision: { ...current, delivery } }), decision.workspaceId);
        } catch (error) {
          log(`[paseo-bm] could not record the delivery of decision ${decision.id}: ${reasonOf(error)}`);
        }
        // A failed action leaves the incident pending: the owner is told in the Inbox (§A.8).
        if (outcome === "failed") {
          try {
            const read = readIncidents(home, () => {});
            if (read.error === null) syncFallbackFailedAlerts(home, store, new Map(read.incidents.map((incident) => [incident.id, incident])), now);
          } catch (error) {
            log(`[paseo-bm] could not raise the fallback-failed alert of decision ${decision.id}: ${reasonOf(error)}`);
          }
        }
      } finally {
        running.delete(decision.id);
      }
    }
  };
}
