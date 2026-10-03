/**
 * The Inbox's model (experience concept §4.1, autonomy design §A.12): what
 * needs the owner, in three sections, always in this order —
 *
 * 1. **Needs you**: the unsettled decisions (`decisions.list {scope: inbox}`),
 *    grouped by project, the project with the oldest question first and the
 *    oldest question first inside it. A decision the owner settled HERE stays
 *    in its place, drawn settled, until the Inbox is left, so the owner sees
 *    what the tap did (for a fallback incident: what became of the agent).
 * 2. **Decided for you** (autonomy design §B.7; PRD REQ-125): the decisions
 *    the owner's policy or an owner precedent answered since the owner last
 *    looked (`inbox.seen`, `inbox.digest`), the latest first, one line each —
 *    what was decided, the project and who decided — with its reason, the ids
 *    under Details, and **Override**, which opens the decision again as the
 *    owner's (`decisions.override`). Once overridden, the line says so.
 *    Merged with them by time, the Orchestrator's interventions since then
 *    (§G.3, REQ-127 c; bead `t9lm.23`): what it did and for whom, the
 *    project, why, and the outcome — pending, met, missed or unknown — with
 *    no Override (only decisions are overridden, REQ-125). An answer the
 *    Orchestrator gave (`bm_decide`) is already a decision line: its outcome
 *    joins that line instead of a second one.
 * 3. **Alerts**: the open alerts (`inbox.alerts`), in `ALERT_KINDS` order and
 *    oldest first, plus one follow-up per switched Reviewer whose replacement
 *    never appeared (`fallback.act` resend). Compaction or handoff switched off below A-12's
 *    target (`coordination-off`, §G.3) names the mechanism, for all projects;
 *    its figures and the way back are in its detail. Two agents that edited
 *    one file in overlapping turns (`writers-observed`, §F.1) open the
 *    project; the file and the agents are in its detail.
 *
 * As drawn (change-014, the approved mockup): Needs you and Alerts are one
 * list of project groups (`inboxProjects`) — each project's decisions, held
 * actions and alerts together, the alerts with no project last under
 * `Other` — with a filter (All · Decisions · Actions · Alerts); Decided for
 * you follows.
 *
 * An empty Inbox is one sentence with a way to Projects. The Inbox tab's label
 * carries the count of unsettled decisions and alerts (DQ-3: no sidebar badge).
 *
 * Pure: no React, no React Native, no `server/` import. Ids appear only in
 * `details`, never in a line the owner reads first.
 */
import type { DigestIntervention, DigestTargetRole, FallbackIncident } from "../shared/contracts";
import { ALERT_KINDS, type Alert, type AlertKind } from "../shared/alerts";
import { isDecidedForOwner, overrideIdOf } from "../shared/decision-override";
import { decisionClassOf, decisionKindOf, isAnswerable, policyPredictorOf, type Decision } from "../shared/decisions";
import type { ExpectedOutcome, InterventionKind, InterventionOutcome, InterventionTrigger } from "../shared/interventions";
import type { WorkerSignal } from "../shared/orchestrator";
import { decisionCardOf, type ChatCard, type DecisionSeed } from "./chat-card-parse";
import type { Tone } from "./tone";
import { ago, formatDuration, localTimeText } from "./format";
import { providerLabel } from "./settings-roles-model";
import { timeOrZero } from "../shared/time";
import { plural, shorten } from "../shared/text";

/** How often the Inbox reads its decisions, alerts and incidents while it is shown (REQ-111 b). */
export const INBOX_POLL_MS = 5_000;

/**
 * A switched Reviewer whose replacement has not appeared is followed up this
 * long after the switch; an older one is history, not something to act on.
 */
export const RESEND_FOLLOW_UP_MS = 24 * 60 * 60 * 1000;

/** Decided for you with nothing in it (§B.7). */
export const DECIDED_FOR_YOU_EMPTY = "Nothing was decided for you since you last looked.";

/** Under Decided for you when `inbox.digest` had more than it returned. */
export const DECIDED_FOR_YOU_TRUNCATED = "More was decided for you than the Inbox shows; each project's Requests tab has every decision.";

/** Under Decided for you when `inbox.digest` had more interventions than it returned (§G.3). */
export const INTERVENTIONS_TRUNCATED = "The Orchestrator intervened more often than the Inbox shows; a project's Metrics → Coordination counts every intervention.";

/** What an overridden line says while the owner's answer is awaited, and once it is not any more. */
export const OVERRIDE_WAITING = "Overridden: it waits for your answer in Needs you.";
export const OVERRIDE_DONE = "Overridden.";

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
  /** The project the alert is about, to group it with; null for none (it goes to the "Other" group). */
  workspaceId: string | null;
  /** `<what happened>`: the row's lead, in its project's group. */
  what: string;
  /** The project's name, for its group. */
  project: string;
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

/** What a Decided-for-you line offers: Override, or what became of the override. */
export type DigestOverride =
  | { state: "offered"; label: string; accessibilityLabel: string }
  | { state: "waiting" | "done"; text: string; tone: Tone };

/**
 * What became of an intervention (§G.3): the outcome its check settled —
 * `pending`, `met`, `missed` or `unknown`, each said as such — with the
 * outcome it waits for and its window: `Met · expected: the Worker resumes
 * within 10 min`.
 */
export interface DigestOutcome {
  outcome: InterventionOutcome;
  text: string;
  tone: Tone;
}

/** What every line of Decided for you has. */
interface DigestLine {
  /** Unique within the section: the decision's id, or `intervention:<id>`. Never shown. */
  key: string;
  /** The project's name, the line's lead (the mockup's `<project> · <what> → <answer>`). */
  project: string;
  /** Who decided or acted: `the Orchestrator`, `your precedent`, …. */
  by: string;
  /** A decision: `<question> → <answer>`. An intervention: what the Orchestrator did, and for whom. */
  what: string;
  /** `<project> · <who decided>`, or `<project> · the Orchestrator`. */
  where: string;
  /** Why, in one line (the policy's, the precedent's or the Orchestrator's reason); null when none was stored. */
  reason: string | null;
  /** An intervention's outcome, or that of the Orchestrator's answer a decision line carries; null otherwise. */
  outcome: DigestOutcome | null;
  /** `12 min ago`: when it was answered or done. */
  time: string;
  /** What the line says aloud, with its time. */
  accessibilityLabel: string;
  /** Ids and times, shown on a tap. */
  details: string[];
}

/** One decision of Decided for you (§B.7), with Override. */
export interface DigestDecisionRow extends DigestLine {
  kind: "decision";
  /** The decision's id: a key and the Override's target, never shown but under Details. */
  decisionId: string;
  /** Null for a held request the policy allowed (autonomy design §D.2): it already ran, there is nothing to take back. */
  override: DigestOverride | null;
}

/** One intervention of the Orchestrator's in Decided for you (§G.3): no Override. */
export interface DigestInterventionRow extends DigestLine {
  kind: "intervention";
  interventionKind: InterventionKind;
}

/** One line of Decided for you: a decision answered for the owner, or an intervention of the Orchestrator's. */
export type DigestRow = DigestDecisionRow | DigestInterventionRow;

export interface InboxView {
  needsYou: { count: number; groups: InboxGroup[] };
  /** `empty` is the section's sentence when it has no line, else null; `interventionsTruncated`: more interventions than shown. */
  decidedForYou: { count: number; rows: DigestRow[]; empty: string | null; truncated: boolean; interventionsTruncated: boolean };
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
  /** `inbox.digest`: the decisions answered for the owner since they last looked, the latest first; none when not read. */
  digest?: readonly Decision[];
  digestTruncated?: boolean;
  /** `inbox.digest`'s interventions of the Orchestrator since the owner last looked, the latest first; none when not read. */
  interventions?: readonly DigestIntervention[];
  interventionsTruncated?: boolean;
  /** Where the digest starts: when the owner last looked before this visit (`inbox.seen`); null when never, or not known. */
  digestSince?: string | null;
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
  // Autonomy design §F.1: the file and the agents are in its detail, on a tap.
  "writers-observed": { what: "Two agents edited one file at the same time", tone: "warning", opens: "project", agentWord: "" },
  "pairing-mismatch": { what: "An agent was created by the wrong role", tone: "warning", opens: "agent", agentWord: "agent" },
  "outdated-agent": { what: "An agent runs on older instructions", tone: "muted", opens: "agent", agentWord: "agent" },
  "fallback-failed": { what: "A fallback action failed; the agent is still stopped", tone: "danger", opens: "project", agentWord: "" },
  // Design §16.7: a report, review or message an agent's tool stored never reached its target; the record is in the detail.
  "delivery-dropped": { what: "A report or message could not be delivered", tone: "warning", opens: "project", agentWord: "" },
  // Design §16.8: a bound Worker created a Reviewer with create_agent; its Worker and request are in the detail.
  "off-tool-reviewer": { what: "A Worker created a Reviewer outside its tools", tone: "warning", opens: "agent", agentWord: "Reviewer" },
  // Autonomy design §G.3, §G.7: `coordinationOffWhat` names the mechanism.
  "coordination-off": { what: "Compaction or handoff was switched off: below its target", tone: "warning", opens: null, agentWord: "" },
  // Autonomy design §D.2 (change-010 C6): a Worker or Reviewer only watched in a project whose boundary is on.
  "boundary-off": { what: "An agent runs without the action boundary", tone: "warning", opens: "agent", agentWord: "agent" },
};

/** A `coordination-off` alert's line, naming its mechanism (its subject). */
export function coordinationOffWhat(subject: string): string {
  if (subject === "compact") return "Compaction was switched off: below its target";
  if (subject === "handoff") return "Handoff was switched off: below its target";
  return ALERT_WORDS["coordination-off"].what;
}

/** Where an alert about every project is, instead of a project's name. */
export const ALL_PROJECTS = "all projects";

const ROLE_WORDS: Readonly<Record<FallbackIncident["role"], string>> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

function candidateWords(incident: FallbackIncident): string | null {
  const candidate = incident.candidate;
  return candidate === null ? null : `${providerLabel(candidate.baseProvider)} · ${candidate.model}`;
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
      const project = projectName(incident.workspaceId, input.projectOf);
      const text = `The new Reviewer has not appeared · ${project}`;
      const time = ago(incident.decidedAt ?? incident.detectedAt, input.now);
      return {
        key: `resend:${incident.id}`,
        tone: "warning" as const,
        workspaceId: incident.workspaceId,
        what: "The new Reviewer has not appeared",
        project,
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
  const what = alert.kind === "coordination-off" ? coordinationOffWhat(alert.subject) : words.what;
  const where = alert.kind === "coordination-off" ? ALL_PROJECTS : projectName(alert.workspaceId, input.projectOf);
  const text = `${what} · ${where}`;
  const time = ago(alert.since, input.now);
  return {
    key: alert.key,
    tone: words.tone,
    // An alert about every project (`coordination-off`) belongs to none of them.
    workspaceId: alert.kind === "coordination-off" ? null : alert.workspaceId,
    what,
    project: where,
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
  return timeOrZero(decision.askedAt);
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
// Decided for you (autonomy design §B.7; PRD REQ-125).
// ---------------------------------------------------------------------------

/**
 * Who answered for the owner, in the line's words (ADR-025): a precedent;
 * the Orchestrator, the policy's only predictor; "your earlier policy" for an
 * answer an older build stored with the recommended option as predictor;
 * "your policy" for a held request the action boundary allowed.
 */
export function decidedByWords(decision: Pick<Decision, "id" | "answer">): string {
  if (decision.answer?.by === "precedent") return "your precedent";
  const predictor = policyPredictorOf(decision);
  return predictor === "orchestrator" ? "the Orchestrator" : predictor === "recommended" ? "your earlier policy" : "your policy";
}

/** A question's first line, shortened: an Orchestrator's decision carries its recommendation below it. */
function questionLine(question: string, max: number): string {
  return shorten(question.split("\n")[0] ?? question, max);
}

/** What was chosen: the option's label, or the precedent's words in quotes. */
function answerLine(decision: Decision): string {
  const answer = decision.answer;
  const option = answer?.optionKey == null ? undefined : decision.options.find((entry) => entry.key === answer.optionKey);
  if (option !== undefined) return shorten(option.label, 60);
  return answer?.words == null ? "answered" : `"${shorten(answer.words, 60)}"`;
}

function overrideOf(decision: Decision, question: string, open: ReadonlySet<string>): DigestOverride {
  const overrideId = overrideIdOf(decision);
  if (overrideId === null) {
    return {
      state: "offered",
      label: "Override",
      accessibilityLabel: `Override "${question}": it comes back to you as a question, and your answer replaces this one`,
    };
  }
  return open.has(overrideId) ? { state: "waiting", text: OVERRIDE_WAITING, tone: "warning" } : { state: "done", text: OVERRIDE_DONE, tone: "muted" };
}

// ---------------------------------------------------------------------------
// The Orchestrator's interventions in Decided for you (autonomy design §G.3;
// PRD REQ-127 c; bead t9lm.23).
// ---------------------------------------------------------------------------

/** Whom an intervention was for, in the line's words; null when the stores could not tell. */
const TARGET_WORDS: Readonly<Record<DigestTargetRole, string>> = { manager: "Manager", worker: "Worker", owner: "you" };

/** What the Orchestrator did, by kind, for its target (`Worker`, `Manager`, or null when not known). */
const INTERVENTION_WHAT: Readonly<Record<InterventionKind, (target: string | null) => string>> = {
  answer: (target) => (target === null ? "Answered a question" : `Answered the ${target}'s question`),
  unblock: (target) => (target === null ? "Unblocked a request" : `Unblocked the ${target}`),
  correct: (target) => (target === null ? "Sent a correction" : `Corrected the ${target}`),
  stop: (target) => (target === null ? "Stopped a turn" : `Stopped the ${target}'s turn`),
  compact: (target) => (target === null ? "Had an agent compact its context" : `Had the ${target} compact its context`),
  handoff: (target) => (target === null ? "Handed an agent's work to a new one" : `Handed the ${target}'s work to a new ${target}`),
  advice: () => "Advised you",
};

/** What a Worker signal said, as the reason of a correction or a stop. */
const SIGNAL_REASON: Readonly<Record<WorkerSignal, string>> = {
  stuck: "The Worker looked stuck",
  permission: "The Worker was waiting for a permission",
  danger: "The Worker ran a risky command",
  failing: "The Worker's command kept failing",
  heavy: "The Worker used heavy process for small work",
  outside: "The Worker edited outside the project",
  "off-tool-review": "The Worker created a Reviewer outside its tools",
};

/** What set an intervention off (its trigger), as the start of its reason. */
function triggerWords(trigger: InterventionTrigger, signal: WorkerSignal | undefined): string {
  switch (trigger) {
    case "decision.opened":
      return "A question was waiting";
    case "request.stalled":
      return "The request stopped moving";
    case "worker.signal":
      return signal === undefined ? "The Worker needed a look" : SIGNAL_REASON[signal];
    case "advice.due":
      return "Advice was due for the project";
    case "threshold.crossed":
      return "An agent crossed its threshold in Settings";
    case "owner":
      return "You asked for it in the Orchestrator's chat";
    case "orchestrator":
      return "On the Orchestrator's own look";
  }
}

/** The outcome each kind waits for, as the outcome line says it. */
const EXPECTED_WORDS: Readonly<Record<ExpectedOutcome, string>> = {
  "worker-resumes": "the Worker resumes",
  "stall-clears": "the request moves again",
  "signal-clears-or-checks-pass": "the problem clears or the checks pass",
  "turn-ends": "the turn ends",
  "tokens-per-turn-down": "fewer tokens per turn",
  "successor-progresses": "the successor makes progress",
  "owner-answers": "you answer it",
};

/** Each outcome's word and colour: `unknown` is said as such, never hidden. */
const OUTCOME_WORDS: Readonly<Record<InterventionOutcome, { word: string; tone: Tone }>> = {
  pending: { word: "Pending", tone: "info" },
  met: { word: "Met", tone: "success" },
  missed: { word: "Missed", tone: "warning" },
  unknown: { word: "Unknown", tone: "muted" },
};

/** `Met · expected: the Worker resumes within 10 min`. */
export function digestOutcomeOf(entry: Pick<DigestIntervention, "outcome" | "expected" | "windowMs">): DigestOutcome {
  const { word, tone } = OUTCOME_WORDS[entry.outcome];
  return { outcome: entry.outcome, text: `${word} · expected: ${EXPECTED_WORDS[entry.expected]} within ${formatDuration(entry.windowMs)}`, tone };
}

/** An intervention's ids and times, for Details. */
function interventionDetails(entry: DigestIntervention): string[] {
  return [
    `Intervention: ${entry.id}`,
    `Kind: ${entry.kind} · trigger: ${entry.trigger}`,
    ...(entry.requestId === null ? [] : [`Request: ${entry.requestId}`]),
    ...(entry.targetAgentId === null ? [] : [`Agent: ${entry.targetAgentId}`]),
    ...(entry.commandId === undefined ? [] : [`Command: ${entry.commandId}`]),
    ...(entry.decisionId === undefined ? [] : [`Decision: ${entry.decisionId}`]),
    ...(entry.alertKey === undefined ? [] : [`Alert: ${entry.alertKey}`]),
    `At: ${entry.at}`,
    ...(entry.checkedAt === null ? [] : [`Checked: ${entry.checkedAt}`]),
  ];
}

/**
 * One intervention line (§G.3): what the Orchestrator did and for whom · the
 * project · why (what set it off, then the Orchestrator's own words when a
 * store kept them) · its outcome, pending, met, missed or unknown. No
 * Override. Ids only under Details.
 */
export function interventionRowOf(entry: DigestIntervention, input: Pick<InboxInput, "projectOf" | "now">): DigestInterventionRow {
  const target = entry.targetRole === null ? null : TARGET_WORDS[entry.targetRole];
  const what = INTERVENTION_WHAT[entry.kind](target);
  const project = projectName(entry.workspaceId, input.projectOf);
  const where = `${project} · the Orchestrator`;
  const trigger = triggerWords(entry.trigger, entry.signal);
  const outcome = digestOutcomeOf(entry);
  const time = ago(entry.at, input.now);
  return {
    kind: "intervention",
    key: `intervention:${entry.id}`,
    project,
    by: "the Orchestrator",
    interventionKind: entry.kind,
    what,
    where,
    reason: entry.reason === null ? `${trigger}.` : `${trigger}: ${shorten(entry.reason, 300)}`,
    outcome,
    time,
    accessibilityLabel: `The Orchestrator: ${what}, ${where}, ${outcome.text}, ${time}`,
    details: interventionDetails(entry),
  };
}

// ---------------------------------------------------------------------------
// Decided for you: the lines, merged.
// ---------------------------------------------------------------------------

/**
 * One Decided-for-you line: what was decided (the question and the answer),
 * the project, who decided, the reason, and Override — or, once overridden,
 * whether the owner's answer is still awaited (`open`: the unsettled
 * decisions' ids). `answered`: the Orchestrator's `answer` intervention for
 * this decision (§G.3), whose outcome the line then carries. Ids only under
 * Details.
 */
export function digestRowOf(
  decision: Decision,
  input: Pick<InboxInput, "projectOf" | "now">,
  open: ReadonlySet<string> = new Set(),
  answered: DigestIntervention | null = null,
): DigestDecisionRow {
  const answer = decision.answer;
  const question = questionLine(decision.question, 80);
  const what = `${question} → ${answerLine(decision)}`;
  const project = projectName(decision.workspaceId, input.projectOf);
  const by = decidedByWords(decision);
  const where = `${project} · ${by}`;
  const time = ago(answer?.at ?? decision.settledAt, input.now);
  const overrideId = overrideIdOf(decision);
  const outcome = answered === null ? null : digestOutcomeOf(answered);
  return {
    kind: "decision",
    key: decision.id,
    project,
    by,
    decisionId: decision.id,
    what,
    where,
    reason: answer?.reason === undefined ? null : shorten(answer.reason, 300),
    outcome,
    time,
    accessibilityLabel: `Decided for you: ${what}, ${where}, ${outcome === null ? "" : `${outcome.text}, `}${time}`,
    details: [
      `Decision: ${decision.id}`,
      ...(decision.requestId === null ? [] : [`Request: ${decision.requestId}`]),
      `Class: ${answer?.class ?? decisionClassOf(decision)}`,
      ...(answer?.precedentId === undefined ? [] : [`Precedent: ${answer.precedentId}`]),
      `Answered: ${answer?.at ?? "unknown"}`,
      ...(decision.delivery === null ? [] : [`Delivery: ${decision.delivery.outcome} to ${decision.delivery.to} at ${decision.delivery.at}`]),
      ...(overrideId === null ? [] : [`Override: ${overrideId}`]),
      ...(answered === null ? [] : [`Intervention: ${answered.id}`, ...(answered.checkedAt === null ? [] : [`Checked: ${answered.checkedAt}`])]),
    ],
    override: decisionKindOf(decision.id) === "held" ? null : overrideOf(decision, question, open),
  };
}

/**
 * Decided for you: one line per decision `inbox.digest` returned — only
 * answers the policy or a precedent gave, and only after `digestSince` when
 * it is known: an owner's answer is never one — and one per intervention of
 * the Orchestrator's after it, merged into one list, the latest first (a
 * tie keeps the decision first). An `answer` intervention whose decision is
 * a line already gives that line its outcome instead of a line of its own.
 */
export function decidedForYouOf(
  input: Pick<InboxInput, "digest" | "digestTruncated" | "digestSince" | "interventions" | "interventionsTruncated" | "decisions" | "projectOf" | "now">,
): InboxView["decidedForYou"] {
  const open = new Set(input.decisions.filter((decision) => isAnswerable(decision)).map((decision) => decision.id));
  const since = input.digestSince == null ? null : timeOrZero(input.digestSince);
  const decisions = (input.digest ?? []).filter((decision) => isDecidedForOwner(decision) && (since === null || timeOrZero(decision.answer!.at) > since));
  const interventions = (input.interventions ?? []).filter((entry) => since === null || timeOrZero(entry.at) > since);
  const lined = new Set(decisions.map((decision) => decision.id));
  const answers = new Map<string, DigestIntervention>();
  for (const entry of interventions) {
    // The latest answer of a decision wins; there is one per decision.
    if (entry.kind === "answer" && entry.decisionId !== undefined && lined.has(entry.decisionId) && !answers.has(entry.decisionId)) answers.set(entry.decisionId, entry);
  }
  const folded = new Set([...answers.values()].map((entry) => entry.id));
  const timed = [
    ...decisions.map((decision) => ({ at: timeOrZero(decision.answer!.at), row: digestRowOf(decision, input, open, answers.get(decision.id) ?? null) as DigestRow })),
    ...interventions.filter((entry) => !folded.has(entry.id)).map((entry) => ({ at: timeOrZero(entry.at), row: interventionRowOf(entry, input) as DigestRow })),
  ];
  // Stable: each list keeps `inbox.digest`'s order within a tie, decisions first.
  const rows = timed
    .map((line, index) => ({ ...line, index }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((line) => line.row);
  return {
    count: rows.length,
    rows,
    empty: rows.length === 0 ? DECIDED_FOR_YOU_EMPTY : null,
    truncated: input.digestTruncated === true,
    interventionsTruncated: input.interventionsTruncated === true,
  };
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
  // Decided for you is shown, never counted: nothing in it waits for the owner.
  const decidedForYou = decidedForYouOf(input);
  return {
    needsYou: { count: decisionsCount, groups },
    decidedForYou,
    alerts: { count: rows.length, rows, truncated: input.alertsTruncated === true },
    empty: groups.length === 0 && rows.length === 0 && decidedForYou.count === 0 ? emptySentence(input.runningWorkers) : null,
    count,
  };
}

/** The Inbox tab: its label carries the count (DQ-3: there is no sidebar badge). */
export function inboxTab(count: number | null): { key: "inbox"; label: string; count?: number; hint?: string } {
  if (count === null || count === 0) return { key: "inbox", label: "Inbox", ...(count === 0 ? { hint: "nothing needs you" } : {}) };
  return { key: "inbox", label: "Inbox", count, hint: `${plural(count, "item needs", "items need")} you` };
}

// ---------------------------------------------------------------------------
// Needs you, as the approved mockup draws it (change-014): one group per
// project holding its decisions, held actions and alerts, and a filter.
// ---------------------------------------------------------------------------

/** The Inbox's filter (client state): everything, the open decisions, the held actions, or the alerts. */
export type InboxFilter = "all" | "decisions" | "actions" | "alerts";

export const INBOX_FILTERS: ReadonlyArray<{ key: InboxFilter; label: string; accessibilityLabel: string }> = [
  { key: "all", label: "All", accessibilityLabel: "Show everything that needs you" },
  { key: "decisions", label: "Decisions", accessibilityLabel: "Show only the decisions" },
  { key: "actions", label: "Actions", accessibilityLabel: "Show only the held actions" },
  { key: "alerts", label: "Alerts", accessibilityLabel: "Show only the alerts" },
];

/** The group of the alerts that name no project: last. */
export const OTHER_GROUP = "Other";

/** One project's group: its decisions and held actions, then its alerts. */
export interface InboxProject {
  /** The workspace id, or `other` for the alerts with none. */
  key: string;
  workspaceId: string | null;
  /** The project's name only (never `label · directory`), or `OTHER_GROUP`. */
  label: string;
  items: InboxDecisionItem[];
  alerts: InboxAlertRow[];
  /** An asking agent of this project, for `chat.peers`; null when none is known. */
  peersOf: string | null;
  /** What in the group still waits: its unsettled items and its alerts. */
  open: number;
}

/** Which filter a Needs-you decision falls under: a held request (`h:`) is an action; every other kind a decision. */
export function filterOfDecision(decision: Pick<Decision, "id">): "decisions" | "actions" {
  return decisionKindOf(decision.id) === "held" ? "actions" : "decisions";
}

/**
 * Needs you as groups: one per project, in the order of `needsYou.groups`
 * (the oldest question first), then the projects with only alerts in alert
 * order, then `Other` for the alerts that name no project. `filter` keeps
 * only its kind; a group left with nothing is not drawn.
 */
export function inboxProjects(view: Pick<InboxView, "needsYou" | "alerts">, filter: InboxFilter): InboxProject[] {
  const projects = new Map<string, InboxProject>();
  const groupOf = (workspaceId: string | null, label: string, peersOf: string | null): InboxProject => {
    const key = workspaceId ?? "other";
    let project = projects.get(key);
    if (project === undefined) {
      project = { key, workspaceId, label, items: [], alerts: [], peersOf, open: 0 };
      projects.set(key, project);
    }
    return project;
  };
  for (const group of view.needsYou.groups) {
    const project = groupOf(group.workspaceId, group.label, group.peersOf);
    for (const item of group.items) {
      if (filter !== "all" && filter !== filterOfDecision(item.decision)) continue;
      project.items.push(item);
      if (!item.settledHere) project.open += 1;
    }
  }
  if (filter === "all" || filter === "alerts") {
    for (const row of view.alerts.rows) {
      const project = row.workspaceId === null ? null : groupOf(row.workspaceId, row.project, null);
      // The project-less ones wait until the end, so `Other` is last.
      if (project === null) continue;
      project.alerts.push(row);
      project.open += 1;
    }
    for (const row of view.alerts.rows) {
      if (row.workspaceId !== null) continue;
      const other = groupOf(null, OTHER_GROUP, null);
      other.alerts.push(row);
      other.open += 1;
    }
  }
  return [...projects.values()].filter((project) => project.items.length > 0 || project.alerts.length > 0);
}

/** The title row's count: `4 items in 2 projects` (`Other` is not a project). */
export function needsYouSummary(projects: readonly InboxProject[]): string {
  const items = projects.reduce((sum, project) => sum + project.open, 0);
  const named = projects.filter((project) => project.workspaceId !== null && project.open > 0).length;
  return named === 0 ? plural(items, "item") : `${plural(items, "item")} in ${plural(named, "project")}`;
}

/** A group's label: `<project> · n`, or the name alone when nothing in it waits. */
export function projectHeading(project: Pick<InboxProject, "label" | "open">): string {
  return project.open === 0 ? project.label : `${project.label} · ${project.open}`;
}

/** Decided for you's label: what was decided since the owner last looked, and how many. */
export function decidedHeading(count: number): string {
  return `Decided for you · since you last looked · ${count}`;
}

/** Section headings, with their counts. */
export function sectionHeading(title: "Needs you" | "Decided for you" | "Alerts", count: number): string {
  return `${title} · ${count}`;
}

