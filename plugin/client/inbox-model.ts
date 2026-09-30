/**
 * The Inbox's model (experience concept §4.1, autonomy design §A.12): what
 * needs the owner, in three sections, always in this order —
 *
 * 1. **Needs you**: the unsettled decisions (`decisions.list {scope: inbox}`),
 *    grouped by project, the project with the oldest question first and the
 *    oldest question first inside it. A decision the owner settled HERE stays
 *    in its place, drawn settled, until the Inbox is left, so the owner sees
 *    what the tap did (for a fallback incident: what became of the agent).
 * 2. **Decided for you**: empty in Phase 1 (delegation is Part B).
 * 3. **Alerts**: the open alerts (`inbox.alerts`), in `ALERT_KINDS` order and
 *    oldest first, plus one follow-up per switched Reviewer whose replacement
 *    never appeared (`fallback.act` resend).
 *
 * An empty Inbox is one sentence with a way to Work. The Inbox tab's label
 * carries the count of unsettled decisions and alerts (DQ-3: no sidebar badge).
 *
 * Pure: no React, no React Native, no `server/` import. Ids appear only in
 * `details`, never in a line the owner reads first.
 */
import type { FallbackIncident } from "../shared/contracts";
import { ALERT_KINDS, type Alert, type AlertKind } from "../shared/alerts";
import { isAnswerable, type Decision } from "../shared/decisions";
import { decisionCardOf, localTimeText, type ChatCard, type DecisionSeed } from "./chat-cards";
import type { Tone } from "./dashboard-model";
import { ago } from "./orchestrator-model";
import { providerLabel } from "./setup-model";

/** How often the Inbox reads its decisions, alerts and incidents while it is shown (REQ-111 b). */
export const INBOX_POLL_MS = 5_000;

/**
 * A switched Reviewer whose replacement has not appeared is followed up this
 * long after the switch; an older one is history, not something to act on.
 */
export const RESEND_FOLLOW_UP_MS = 24 * 60 * 60 * 1000;

/** The Decided-for-you section until delegation exists (Part B). */
export const DECIDED_FOR_YOU_EMPTY = "Nothing is decided for you yet: every decision comes to you.";

/** The sentence of an empty Inbox, before the running count. */
export const EMPTY_INBOX = "Nothing needs you.";

/** What a follow-up or an alert offers, when the surface can do it. */
export type InboxAction =
  | { kind: "open-agent"; agentId: string; label: string; accessibilityLabel: string }
  | { kind: "open-project"; workspaceId: string; label: string; accessibilityLabel: string }
  | { kind: "resend"; incidentId: string; label: string; accessibilityLabel: string }
  | { kind: "replace-manager"; workspaceId: string; label: string; accessibilityLabel: string };

/** What became of a fallback incident after its decision (a follow-up of the cards review). */
export interface FallbackOutcome {
  text: string;
  tone: Tone;
  action: InboxAction | null;
}

export interface InboxDecisionItem {
  decision: Decision;
  /** The seed card `DecisionCard` draws from; the decision itself is `initial`. */
  card: ChatCard;
  /** True for a decision settled in this Inbox and kept in place until the Inbox is left. */
  settledHere: boolean;
  /** For a settled fallback decision: the incident's outcome; null otherwise. */
  outcome: FallbackOutcome | null;
}

export interface InboxGroup {
  workspaceId: string;
  /** The project's name, never its id. */
  label: string;
  items: InboxDecisionItem[];
  /** An asking agent of this project: `chat.peers` of it names the askers. Null when none is known. */
  peersOf: string | null;
}

export interface InboxAlertRow {
  key: string;
  tone: Tone;
  /** `<what happened> · <project>`. */
  text: string;
  /** `12 min ago`. */
  time: string;
  /** What the row says aloud, with its time. */
  accessibilityLabel: string;
  /** Detail and ids, shown on a tap. */
  details: string[];
  action: InboxAction | null;
}

export interface InboxView {
  needsYou: { count: number; groups: InboxGroup[] };
  decidedForYou: { empty: string };
  alerts: { count: number; rows: InboxAlertRow[]; truncated: boolean };
  /** The one sentence of an empty Inbox; null when anything is shown. */
  empty: string | null;
  /** Open decisions and alerts: the Inbox tab's count. */
  count: number;
}

export interface InboxInput {
  /** `decisions.list {scope: inbox}`: the unsettled decisions, oldest asked first. */
  decisions: readonly Decision[];
  /** Decisions settled in this Inbox since it was opened, as their answer returned them. */
  settledHere: readonly Decision[];
  /** `inbox.alerts`. */
  alerts: readonly Alert[];
  alertsTruncated?: boolean;
  /** `fallback.incidents`, every workspace. */
  incidents: readonly FallbackIncident[];
  /** The project name of a workspace id, when the surface knows it. */
  projectOf: (workspaceId: string) => string | null;
  /** Running Workers across the projects, for the empty sentence; null when unknown. */
  runningWorkers: number | null;
  /** What the surface can open (`navigation`); an action it cannot run is not offered. */
  can: { openAgent: boolean; openWorkspace: boolean };
  now: Date;
}

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

/** A project the surface does not list any more is still named, without its id. */
export const UNKNOWN_PROJECT = "a closed project";
export const NO_PROJECT = "no project";

function projectName(workspaceId: string | null, projectOf: InboxInput["projectOf"]): string {
  if (workspaceId === null) return NO_PROJECT;
  return projectOf(workspaceId) ?? UNKNOWN_PROJECT;
}

/** What each alert kind means to the owner, its colour, and what it opens. */
export const ALERT_WORDS: Readonly<Record<AlertKind, { what: string; tone: Tone; opens: "agent" | "project" | null; agentWord: string }>> = {
  "request-stalled": { what: "A request stopped moving", tone: "warning", opens: "project", agentWord: "" },
  "permission-waiting": { what: "A Worker is waiting for a permission", tone: "warning", opens: "agent", agentWord: "Worker" },
  danger: { what: "A Worker ran a risky command", tone: "danger", opens: "agent", agentWord: "Worker" },
  stuck: { what: "A Worker looks stuck", tone: "warning", opens: "agent", agentWord: "Worker" },
  "pairing-mismatch": { what: "An agent was created by the wrong role", tone: "warning", opens: "agent", agentWord: "agent" },
  "outdated-agent": { what: "An agent runs on older instructions", tone: "muted", opens: "agent", agentWord: "agent" },
  "fallback-failed": { what: "A fallback action failed; the agent is still stopped", tone: "danger", opens: "project", agentWord: "" },
};

const ROLE_WORDS: Readonly<Record<FallbackIncident["role"], string>> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

function candidateWords(incident: FallbackIncident): string | null {
  const candidate = incident.candidate;
  return candidate === null ? null : `${providerLabel(candidate.baseProvider)} · ${candidate.model}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Fallback follow-ups.
// ---------------------------------------------------------------------------

/** `f:<incidentId>` → `<incidentId>`; null for any other decision. */
export function fallbackIncidentIdOf(decisionId: string): string | null {
  return decisionId.startsWith("f:") ? decisionId.slice(2) : null;
}

/** True for a switched Reviewer whose replacement never appeared: the one incident `fallback.act` resend accepts. */
export function needsResend(incident: FallbackIncident): boolean {
  return incident.role === "reviewer" && incident.status === "switched" && incident.replacementId === null;
}

function resendAction(incident: FallbackIncident): InboxAction {
  return {
    kind: "resend",
    incidentId: incident.id,
    label: "Resend to Worker",
    accessibilityLabel: "Resend to the Worker the instructions to create the new Reviewer",
  };
}

function openAgentAction(agentId: string, word: string, can: InboxInput["can"]): InboxAction | null {
  return can.openAgent ? { kind: "open-agent", agentId, label: `Open ${word}`, accessibilityLabel: `Open the ${word}` } : null;
}

/**
 * What became of a fallback incident once its decision is settled: the old
 * card's status line, with what the surface can do about it (open the new
 * agent; resend a Reviewer's instructions). Null while the incident is still
 * pending with nothing to report, or when it is not known.
 */
export function fallbackOutcomeOf(incident: FallbackIncident | undefined, decision: Decision, input: Pick<InboxInput, "can" | "now">): FallbackOutcome | null {
  if (incident === undefined) return null;
  const role = ROLE_WORDS[incident.role];
  const on = candidateWords(incident);
  switch (incident.status) {
    case "pending":
      return decision.delivery?.outcome === "failed"
        ? { text: `The chosen action did not run; the ${role} is still stopped. It is in Alerts.`, tone: "danger", action: null }
        : null;
    case "switched": {
      if (needsResend(incident)) {
        return {
          text: `The Worker was asked to create the new Reviewer${on === null ? "" : ` on ${on}`}; it has not appeared yet.`,
          tone: "warning",
          action: resendAction(incident),
        };
      }
      const open = incident.replacementId === null ? null : openAgentAction(incident.replacementId, `new ${role}`, input.can);
      if (incident.role === "manager") {
        return { text: `A new Beads Manager is running${on === null ? "" : ` on ${on}`}.`, tone: "success", action: open };
      }
      return { text: `A new ${role} is running${on === null ? "" : ` on ${on}`}.`, tone: "success", action: open };
    }
    case "waiting": {
      const until = incident.waitUntil ?? incident.resetsAt;
      const at = until === null ? null : new Date(until);
      const when = at === null || Number.isNaN(at.getTime()) ? null : localTimeText(at, input.now);
      return { text: when === null ? `Waiting for the usage reset; then the ${role} carries on.` : `Waiting until ${when}; then the ${role} carries on.`, tone: "info", action: null };
    }
    case "resumed":
      return { text: `The limit reset and the ${role} was asked to carry on.`, tone: "success", action: null };
    case "dismissed":
      return { text: "Recorded: you handle it.", tone: "muted", action: null };
    case "exhausted":
      return { text: "No fallback was left to switch to.", tone: "danger", action: null };
    case "expired":
      return { text: `By the reset the ${role} was archived, running or already replaced.`, tone: "muted", action: null };
    case "failed":
      return { text: `The fallback failed: ${incident.error ?? "unknown error"}`, tone: "danger", action: null };
  }
}

/** The Reviewer follow-ups for Alerts: switched within `RESEND_FOLLOW_UP_MS`, replacement never seen. */
export function resendFollowUps(
  incidents: readonly FallbackIncident[],
  shownOnCards: ReadonlySet<string>,
  input: Pick<InboxInput, "projectOf" | "now">,
): InboxAlertRow[] {
  return incidents
    .filter((incident) => needsResend(incident) && !shownOnCards.has(incident.id))
    .filter((incident) => {
      const at = Date.parse(incident.decidedAt ?? incident.detectedAt);
      return !Number.isNaN(at) && input.now.getTime() - at <= RESEND_FOLLOW_UP_MS;
    })
    .sort((a, b) => Date.parse(a.decidedAt ?? a.detectedAt) - Date.parse(b.decidedAt ?? b.detectedAt))
    .map((incident) => {
      const text = `The new Reviewer has not appeared · ${projectName(incident.workspaceId, input.projectOf)}`;
      const time = ago(incident.decidedAt ?? incident.detectedAt, input.now);
      return {
        key: `resend:${incident.id}`,
        tone: "warning" as const,
        text,
        time,
        accessibilityLabel: `${text}, switched ${time}`,
        details: [
          "The Reviewer stopped on its provider plan was switched; its Worker was asked to create the replacement, and none has appeared.",
          `Incident: ${incident.id}`,
          `Worker: ${incident.parentId ?? "unknown"}`,
          ...(incident.requestId === null ? [] : [`Request: ${incident.requestId}`]),
        ],
        action: resendAction(incident),
      };
    });
}

// ---------------------------------------------------------------------------
// Alerts.
// ---------------------------------------------------------------------------

function alertAction(alert: Alert, can: InboxInput["can"]): InboxAction | null {
  const words = ALERT_WORDS[alert.kind];
  // A Manager on older instructions is replaced (the old one stays, marked); a Worker or Reviewer only opened.
  if (alert.kind === "outdated-agent" && alert.role === "manager" && alert.workspaceId !== null) {
    return {
      kind: "replace-manager",
      workspaceId: alert.workspaceId,
      label: "Replace Manager",
      accessibilityLabel: "Replace the Beads Manager with one on the current instructions",
    };
  }
  if (words.opens === "agent") return openAgentAction(alert.subject, words.agentWord, can);
  if (words.opens === "project" && alert.workspaceId !== null && can.openWorkspace) {
    return { kind: "open-project", workspaceId: alert.workspaceId, label: "Open project", accessibilityLabel: "Open the project" };
  }
  return null;
}

/** One alert as a row: what happened and where, its time, the detail on a tap. */
export function alertRowOf(alert: Alert, input: Pick<InboxInput, "projectOf" | "can" | "now">): InboxAlertRow {
  const words = ALERT_WORDS[alert.kind];
  const text = `${words.what} · ${projectName(alert.workspaceId, input.projectOf)}`;
  const time = ago(alert.since, input.now);
  return {
    key: alert.key,
    tone: words.tone,
    text,
    time,
    accessibilityLabel: `${text}, ${time}`,
    details: [...(alert.detail === undefined ? [] : [alert.detail]), `Alert: ${alert.key}`, `Since: ${alert.since}`],
    action: alertAction(alert, input.can),
  };
}

/** Open alerts only, in `ALERT_KINDS` order and oldest first (the order `inbox.alerts` already returns). */
export function orderedAlerts(alerts: readonly Alert[]): Alert[] {
  return alerts
    .filter((alert) => alert.clearedAt === null)
    .map((alert, index) => ({ alert, index }))
    .sort(
      (a, b) =>
        ALERT_KINDS.indexOf(a.alert.kind) - ALERT_KINDS.indexOf(b.alert.kind) ||
        (Date.parse(a.alert.since) || 0) - (Date.parse(b.alert.since) || 0) ||
        a.index - b.index,
    )
    .map(({ alert }) => alert);
}

// ---------------------------------------------------------------------------
// Decisions.
// ---------------------------------------------------------------------------

/** The seed a stored decision's card is drawn from (`DecisionCard` reads the rest live). */
export function seedOf(decision: Decision): DecisionSeed {
  return {
    id: decision.id,
    asker: decision.askedBy.role,
    questionId: decision.id.startsWith("q:") ? (decision.id.split(":").at(-1) ?? null) : null,
    question: decision.question,
    options: decision.options.map((option) => ({ key: option.key, label: option.label, recommended: option.recommended })),
  };
}

function askedAtOf(decision: Decision): number {
  const at = Date.parse(decision.askedAt);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * Needs you: the unsettled decisions and the ones settled here, one group per
 * project. Groups are ordered by their oldest question, questions oldest
 * first; a settled one keeps its place. A decision settled here wins over the
 * list's copy of it (the list may have been read before the answer); one that
 * came back to `open` ("Keep open") is the list's again.
 */
export function needsYouGroups(input: Pick<InboxInput, "decisions" | "settledHere" | "incidents" | "projectOf" | "can" | "now">): InboxGroup[] {
  const byId = new Map<string, { decision: Decision; settledHere: boolean }>();
  for (const decision of input.decisions) {
    if (isAnswerable(decision)) byId.set(decision.id, { decision, settledHere: false });
  }
  for (const decision of input.settledHere) {
    if (!isAnswerable(decision)) byId.set(decision.id, { decision, settledHere: true });
  }
  const incidents = new Map(input.incidents.map((incident) => [incident.id, incident]));
  const groups = new Map<string, InboxDecisionItem[]>();
  for (const { decision, settledHere } of byId.values()) {
    const incidentId = fallbackIncidentIdOf(decision.id);
    const outcome = settledHere && incidentId !== null ? fallbackOutcomeOf(incidents.get(incidentId), decision, input) : null;
    const item: InboxDecisionItem = { decision, card: decisionCardOf(seedOf(decision), decision.requestId), settledHere, outcome };
    groups.set(decision.workspaceId, [...(groups.get(decision.workspaceId) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([workspaceId, items]) => {
      const sorted = [...items].sort((a, b) => askedAtOf(a.decision) - askedAtOf(b.decision));
      const asker = sorted.find((item) => item.decision.askedBy.role === "worker" && item.decision.askedBy.agentId !== null) ?? sorted.find((item) => item.decision.askedBy.agentId !== null);
      return { workspaceId, label: projectName(workspaceId, input.projectOf), items: sorted, peersOf: asker?.decision.askedBy.agentId ?? null };
    })
    .sort((a, b) => askedAtOf(a.items[0]!.decision) - askedAtOf(b.items[0]!.decision) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The whole Inbox.
// ---------------------------------------------------------------------------

/** The sentence of an empty Inbox: nothing needs the owner, and what is running. */
export function emptySentence(runningWorkers: number | null): string {
  if (runningWorkers === null || runningWorkers <= 0) return EMPTY_INBOX;
  return `${EMPTY_INBOX} ${plural(runningWorkers, "Worker is", "Workers are")} running.`;
}

export function inboxView(input: InboxInput): InboxView {
  const groups = needsYouGroups(input);
  const decisionsCount = groups.reduce((sum, group) => sum + group.items.filter((item) => !item.settledHere).length, 0);
  const onCards = new Set(
    groups.flatMap((group) => group.items.filter((item) => item.outcome !== null).map((item) => fallbackIncidentIdOf(item.decision.id) ?? "")),
  );
  const rows = [...orderedAlerts(input.alerts).map((alert) => alertRowOf(alert, input)), ...resendFollowUps(input.incidents, onCards, input)];
  const count = decisionsCount + rows.length;
  return {
    needsYou: { count: decisionsCount, groups },
    decidedForYou: { empty: DECIDED_FOR_YOU_EMPTY },
    alerts: { count: rows.length, rows, truncated: input.alertsTruncated === true },
    empty: groups.length === 0 && rows.length === 0 ? emptySentence(input.runningWorkers) : null,
    count,
  };
}

/** The Inbox tab: its label carries the count (DQ-3: there is no sidebar badge). */
export function inboxTab(count: number | null): { key: "inbox"; label: string; count?: number; hint?: string } {
  if (count === null || count === 0) return { key: "inbox", label: "Inbox", ...(count === 0 ? { hint: "nothing needs you" } : {}) };
  return { key: "inbox", label: "Inbox", count, hint: `${plural(count, "item needs", "items need")} you` };
}

/** Section headings, with their counts. */
export function sectionHeading(title: "Needs you" | "Alerts", count: number): string {
  return `${title} · ${count}`;
}

