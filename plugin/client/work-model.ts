/**
 * Work (experience concept §4.2, autonomy design §A.12): what the project
 * rows and a project's page show, without a renderer. `work.tsx` reads the
 * data and draws it.
 *
 * - **Rows**: every workspace, most recent activity first, each one line on a
 *   phone: the running dot, the current request, its stage, the agents, and
 *   when it last moved. The stage and the agents come from `orchestrator.state`
 *   (the coordinator's per-project facts), the dot and the bead figures from
 *   `workspaces.overview`.
 * - **A project page**: Requests · Beads · Agents. A request is a stage bar
 *   (Received ▸ Plan ▸ Build ▸ Review ▸ Done), a few evidence lines taken from
 *   the Worker's reports, and a timeline of typed events built from the trace
 *   and the request's decisions. A step or an event that cannot be told is not
 *   drawn — never a "?" (concept §4.2).
 * - **A finish, labelled** (autonomy design §C.3, §C.6; REQ-130): once the
 *   request's latest report is `finished`, the row's `verification` labels
 *   each check it names (detected ✓, self-reported, unverified) and the files
 *   and beads it claims (detected, self-reported); a finished-unverified
 *   request reads "Done — unverified" in the warning tone
 *   (`verification-view.ts`). A request that is not checked reads as before.
 * - **Tokens and context** (autonomy design §G.2): a request's Details give its
 *   tokens read by role and each agent's context trend; the Agents tab gives
 *   each agent's over its life. An estimate and a lower bound say so.
 *
 * Pure: no React, no React Native, no JSX. Ids appear only in `details`.
 */
import type {
  AgentNode,
  AgentTokenFigures,
  Confidence,
  OrchestratorProjectRow,
  ParsedReport,
  ReportPhase,
  TraceDetail,
  TraceSummary,
  TraceVerification,
  Usage,
  WorkspaceOverview,
} from "../shared/contracts";
import { decisionKindOf, deliveryKindOf, realEffects, type Decision, type Effect } from "../shared/decisions";
import { ago, confidenceSuffix, excerptLine, formatCost, formatTokens, localTimeText } from "./format";
import type { Tone } from "./tone";
import { agentDots, stageView } from "./orchestrator-model";
import { timeOrNull } from "../shared/time";
import { handoffBriefReplaces, holdsHandoffBrief } from "../shared/handoff";
import { plural, shorten } from "../shared/text";
import { DONE_UNVERIFIED_LABEL, checksText, claimCountsText, isShownVerification, verificationDetailLines } from "./verification-view";

/** How often Work reads its rows and an open project's requests while they show. */
export const WORK_POLL_MS = 10_000;

// ---------------------------------------------------------------------------
// The project page's tabs.
// ---------------------------------------------------------------------------

export const PROJECT_TABS = [
  { key: "requests", label: "Requests" },
  { key: "beads", label: "Beads" },
  { key: "agents", label: "Agents" },
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number]["key"];

// ---------------------------------------------------------------------------
// Stages.
// ---------------------------------------------------------------------------

/** The five stages of a request, in order (experience concept §4.2). */
export const WORK_STAGES = [
  { key: "received", label: "Received" },
  { key: "plan", label: "Plan" },
  { key: "build", label: "Build" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
] as const;

export type WorkStage = (typeof WORK_STAGES)[number]["key"];

/** Where a request stands. `stage: null` = it cannot be told: no bar is drawn. */
export interface StageFacts {
  stage: WorkStage | null;
  /** Blocked on the owner (its last report is `blocked`, or the trace waits on the user). */
  waiting: boolean;
  /** The request ended without finishing. */
  ended: "stopped" | "failed" | null;
  /** Done, but finished-unverified (autonomy design §C.3): present only then. */
  unverified?: true;
}

/**
 * The stage a Worker's report says it reached. `blocked` says nothing about
 * the stage — the one before it still holds — so it has none.
 */
const REPORT_STAGE: Readonly<Record<ReportPhase, WorkStage | null>> = {
  received: "plan",
  "documents-done": "plan",
  "beads-done": "build",
  "bead-implemented": "build",
  blocked: null,
  finished: "done",
};

function latest(times: ReadonlyArray<string | null | undefined>): number | null {
  let best: number | null = null;
  for (const at of times) {
    const time = timeOrNull(at);
    if (time !== null && (best === null || time > best)) best = time;
  }
  return best;
}

/**
 * A review is under way: a Reviewer of the request runs, or the newest review
 * request is newer than both the last verdict and the Worker's last report.
 */
function reviewing(detail: TraceDetail, lastReport: ParsedReport | undefined): boolean {
  if (detail.timing.reviewers.some((reviewer) => reviewer.state === "running")) return true;
  const asked = latest(detail.sent.reviewRequests.map((request) => request.at));
  if (asked === null) return false;
  const verdict = latest(detail.received.reviews.map((review) => review.at));
  const report = timeOrNull(lastReport?.at);
  return asked > (verdict ?? Number.NEGATIVE_INFINITY) && asked > (report ?? Number.NEGATIVE_INFINITY);
}

/**
 * The stage of one request (experience concept §4.2).
 *
 * With the trace's detail: `Done` once the Worker reported `finished` or the
 * request completed; `Review` while a review is under way; else the stage of
 * the Worker's last report that names one (`received`/`documents-done` →
 * Plan, `beads-done`/`bead-implemented` → Build); no report → Received, or
 * unknown when the trace's own state is unknown.
 *
 * From the list row alone (no detail yet) the reports are not there, so it
 * reads what the row carries: completed → Done; beads created or closed →
 * Build; a size the Worker gave → Plan; else Received — unknown when nothing
 * at all is known.
 *
 * Done is finished-unverified (`unverified`) when the row's `verification`
 * says so (autonomy design §C.3).
 */
export function requestStage(
  summary: Pick<TraceSummary, "state" | "tier" | "beadCounts"> & { verification?: TraceVerification | null },
  detail: TraceDetail | null,
): StageFacts {
  const ended = summary.state === "failed" ? "failed" : summary.state === "stopped" ? "stopped" : null;
  const reports = (detail?.received.reports ?? []).filter((report) => report.phase !== null);
  const last = reports.at(-1);
  let stage: WorkStage | null;
  if (detail !== null) {
    const reported = [...reports].reverse().map((report) => REPORT_STAGE[report.phase!]).find((entry) => entry !== null) ?? null;
    if (reported === "done" || summary.state === "completed") stage = "done";
    else if (reviewing(detail, last)) stage = "review";
    else if (reported !== null) stage = reported;
    else stage = summary.state === "unknown" ? null : "received";
  } else if (summary.state === "completed") stage = "done";
  else if (summary.beadCounts.created.count > 0 || summary.beadCounts.closed.count > 0) stage = "build";
  else if (summary.tier !== null) stage = "plan";
  else stage = summary.state === "unknown" ? null : "received";
  const waiting = stage !== "done" && (summary.state === "waiting_user" || last?.phase === "blocked");
  const unverified = stage === "done" && summary.verification?.unverified === true;
  return { stage, waiting, ended: stage === "done" ? null : ended, ...(unverified ? { unverified: true as const } : {}) };
}

export interface StageStep {
  key: WorkStage;
  label: string;
  state: "done" | "current" | "next";
}

export interface StageBarView {
  steps: StageStep[];
  current: WorkStage;
  /** `Build · 3 of 5`: what a phone shows under its segments. */
  text: string;
  /** `Waiting for you`, `Stopped`, `Failed`, or null. */
  note: string | null;
  tone: Tone;
  accessibilityLabel: string;
}

/**
 * The stage bar of a request, or null when its stage cannot be told (nothing
 * is drawn). A finished-unverified request's Done step reads "Done —
 * unverified", in the warning tone (autonomy design §C.3).
 */
export function stageBar(facts: StageFacts): StageBarView | null {
  if (facts.stage === null) return null;
  const index = WORK_STAGES.findIndex((entry) => entry.key === facts.stage);
  const unverified = facts.stage === "done" && facts.unverified === true;
  const steps = WORK_STAGES.map((entry, at) => ({
    key: entry.key,
    label: unverified && entry.key === "done" ? DONE_UNVERIFIED_LABEL : entry.label,
    state: (at < index ? "done" : at === index ? "current" : "next") as StageStep["state"],
  }));
  const note = facts.waiting ? "Waiting for you" : facts.ended === "failed" ? "Failed" : facts.ended === "stopped" ? "Stopped" : null;
  const tone: Tone = facts.waiting || unverified
    ? "warning"
    : facts.ended === "failed"
      ? "danger"
      : facts.ended === "stopped"
        ? "muted"
        : facts.stage === "done"
          ? "success"
          : "info";
  const label = steps[index]!.label;
  const text = `${label} · ${index + 1} of ${WORK_STAGES.length}`;
  return {
    steps,
    current: facts.stage,
    text,
    note,
    tone,
    accessibilityLabel: `Stage: ${label}, ${index + 1} of ${WORK_STAGES.length}${note === null ? "" : `. ${note}`}`,
  };
}

/**
 * A project's stage on its row, from the coordinator's coarse stage
 * (`orchestrator.state`) refined by the phase of the Worker's last report
 * (`workPhase`), so the row tells Plan from Build as the project page does.
 * Waiting keeps the reported stage; `idle` has no step. Without `workPhase`
 * (an older server) a Worker at work reads as Build.
 */
export function projectStageFacts(stage: OrchestratorProjectRow["stage"], workPhase?: ReportPhase | null): StageFacts {
  const reported = workPhase === null || workPhase === undefined ? null : REPORT_STAGE[workPhase];
  switch (stage) {
    case "received":
      return { stage: reported === "plan" ? "plan" : "received", waiting: false, ended: null };
    case "implementing":
      return { stage: reported === "plan" ? "plan" : "build", waiting: false, ended: null };
    case "reviewing":
      return { stage: "review", waiting: false, ended: null };
    case "finished":
      return { stage: "done", waiting: false, ended: null };
    case "waiting-user":
      return { stage: reported === "done" ? null : reported, waiting: true, ended: null };
    default:
      return { stage: null, waiting: false, ended: null };
  }
}

// ---------------------------------------------------------------------------
// Project rows.
// ---------------------------------------------------------------------------

export interface WorkspaceEntry {
  id: string;
  label: string;
  /** The project's display name, when it says more than the label. */
  detail: string;
}

export interface WorkAgentMark {
  letter: "M" | "W" | "R";
  /** `success` while one of them runs, `muted` otherwise. */
  tone: Tone;
  label: string;
}

export interface WorkRowView {
  workspaceId: string;
  label: string;
  detail: string;
  /** The current request's first line; null when idle. */
  request: string | null;
  /** `▸ Build`, `Waiting for you · 17 min`, `idle · last finished 2 h ago`, `idle`. */
  status: { text: string; tone: Tone };
  /** Only the roles the project has now. */
  agents: WorkAgentMark[];
  /** `2 min ago`: when the request last moved; null when idle. */
  time: string | null;
  /** `2 in progress · 1 blocked`, or null when neither. */
  beads: string | null;
  accessibilityLabel: string;
}

function runningCount(overview: WorkspaceOverview | undefined): number {
  if (overview === undefined) return 0;
  const running = overview.runningAgents;
  return running.manager + running.worker + running.reviewer + (running.orchestrator ?? 0);
}

function beadFigure(overview: WorkspaceOverview | undefined): string | null {
  const beads = overview?.beads;
  if (beads === null || beads === undefined) return null;
  const parts = [beads.inProgress > 0 ? `${beads.inProgress} in progress` : null, beads.blocked > 0 ? `${beads.blocked} blocked` : null];
  const shown = parts.filter((part) => part !== null);
  return shown.length === 0 ? null : shown.join(" · ");
}

/** One row per workspace, in the order given (most recent activity first). */
export function workRows(input: {
  workspaces: readonly WorkspaceEntry[];
  /** `orchestrator.state` projects; null before it answered (or when it failed). */
  projects: readonly OrchestratorProjectRow[] | null;
  overview: ReadonlyMap<string, WorkspaceOverview>;
  now: Date;
}): WorkRowView[] {
  const byId = new Map((input.projects ?? []).map((project) => [project.workspaceId, project]));
  return input.workspaces.map((workspace) => {
    const project = byId.get(workspace.id);
    const overview = input.overview.get(workspace.id);
    const running = runningCount(overview) > 0 || project?.state === "running";
    const facts = projectStageFacts(project?.stage, project?.workPhase);
    const movedAt = project === undefined ? null : (project.lastProgressAt ?? project.lastActivityAt);
    let status: WorkRowView["status"];
    let working = false;
    if (project === undefined || (facts.stage === null && !facts.waiting)) {
      const last = project?.lastActivityAt ?? null;
      status = { text: last === null ? "idle" : `idle · last active ${ago(last, input.now)}`, tone: "muted" };
    } else if (facts.waiting) {
      const waiting = stageView("waiting-user", movedAt, input.now);
      status = { text: waiting.text!, tone: waiting.tone };
      working = true;
    } else if (facts.stage === "done" && !running) {
      status = { text: `idle · last finished ${ago(movedAt, input.now)}`, tone: "muted" };
    } else {
      const label = WORK_STAGES.find((entry) => entry.key === facts.stage)!.label;
      status = { text: `▸ ${label}`, tone: facts.stage === "done" ? "success" : "info" };
      working = true;
    }
    const request =
      !working || project?.currentRequest === undefined || project.currentRequest === null
        ? null
        : (project.currentRequest.title ?? "Untitled request");
    const agents: WorkAgentMark[] =
      project === undefined
        ? []
        : agentDots(project)
            .filter((dot) => dot.present)
            .map((dot) => ({ letter: dot.letter, tone: dot.filled ? "success" : "muted", label: dot.label }));
    const time = working && movedAt !== null ? ago(movedAt, input.now) : null;
    const beads = beadFigure(overview);
    return {
      workspaceId: workspace.id,
      label: workspace.label,
      detail: workspace.detail,
      request,
      status,
      agents,
      time,
      beads,
      accessibilityLabel: [
        workspace.label,
        request,
        status.text.replace(/^▸ /, "Stage: "),
        agents.length === 0 ? null : agents.map((agent) => agent.label).join(", "),
        beads === null ? null : `beads: ${beads}`,
        time === null ? null : `moved ${time}`,
        "Open the project",
      ]
        .filter((part) => part !== null)
        .join(". "),
    };
  });
}

// ---------------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------------

/** One request of the Requests tab: the list's rows of one trace (one per turn), merged. */
export interface RequestSummary {
  traceId: string;
  requestId: string | null;
  excerpt: string | null;
  requestedAt: string;
  /** The state of its newest turn. */
  state: TraceSummary["state"];
  tier: TraceSummary["tier"];
  workerIds: string[];
  reviewerIds: string[];
  usage: Usage;
  beadCounts: TraceSummary["beadCounts"];
  /** How many times the owner asked in it. */
  turns: number;
  /** Its finish, labelled (autonomy design §C.3): present while its latest report is `finished`. */
  verification?: TraceVerification;
}

const CONFIDENCE_ORDER: readonly Confidence[] = ["exact", "inferred", "unknown"];

function weakest(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

function sumUsage(entries: readonly Usage[]): Usage {
  const first = entries[0]!;
  const basis: Usage["costBasis"] = entries.some((usage) => usage.costBasis === "unavailable" || usage.costUsd === null)
    ? "unavailable"
    : entries.some((usage) => usage.costBasis === "estimated")
      ? "estimated"
      : "provider";
  const models = new Set(entries.map((usage) => usage.model));
  return {
    inputTokens: entries.reduce((sum, usage) => sum + usage.inputTokens, 0),
    cachedInputTokens: entries.reduce((sum, usage) => sum + usage.cachedInputTokens, 0),
    outputTokens: entries.reduce((sum, usage) => sum + usage.outputTokens, 0),
    costUsd: basis === "unavailable" ? null : entries.reduce((sum, usage) => sum + (usage.costUsd ?? 0), 0),
    costBasis: basis,
    model: models.size === 1 ? first.model : null,
    pricesUpdatedAt: entries.find((usage) => usage.pricesUpdatedAt !== null)?.pricesUpdatedAt ?? null,
  };
}

/**
 * The list's rows grouped into requests, in the list's order (newest first).
 * A request the owner followed up has one row per turn; they share a
 * `traceId` and become one request here: its text from the first turn, its
 * state from the newest, its tokens and bead counts added up.
 */
export function requestSummaries(rows: readonly TraceSummary[]): RequestSummary[] {
  const groups = new Map<string, TraceSummary[]>();
  for (const row of rows) {
    const group = groups.get(row.traceId);
    if (group === undefined) groups.set(row.traceId, [row]);
    else group.push(row);
  }
  return [...groups.values()].map((group) => {
    const byTurn = [...group].sort((a, b) => (a.turn?.index ?? 1) - (b.turn?.index ?? 1));
    const first = byTurn[0]!;
    const newest = byTurn.at(-1)!;
    // The finish is the request's: every row carries the same one (`summariseSegments`).
    const verification = group.find((row) => row.verification !== undefined)?.verification;
    const count = (key: keyof TraceSummary["beadCounts"]) => ({
      count: group.reduce((sum, row) => sum + row.beadCounts[key].count, 0),
      confidence: group.map((row) => row.beadCounts[key].confidence).reduce(weakest),
    });
    return {
      traceId: first.traceId,
      requestId: first.requestId,
      excerpt: first.excerpt,
      requestedAt: first.requestedAt,
      state: newest.state,
      tier: [...byTurn].reverse().find((row) => row.tier !== null)?.tier ?? null,
      workerIds: [...new Set(group.flatMap((row) => row.workerIds))],
      reviewerIds: [...new Set(group.flatMap((row) => row.reviewerIds))],
      usage: sumUsage(group.map((row) => row.usage)),
      beadCounts: { created: count("created"), updated: count("updated"), closed: count("closed"), ready: count("ready") },
      turns: Math.max(group.length, newest.turn?.total ?? 1),
      ...(verification === undefined ? {} : { verification }),
    };
  });
}

/**
 * How the page names the request's agents: `Worker`, or `Worker 1`, `Worker 2`
 * when there are several; `the Manager` for an agent the detail knows as one.
 * Never an id.
 */
export function agentNamer(
  summary: Pick<RequestSummary, "workerIds" | "reviewerIds">,
  roles: ReadonlyArray<{ agentId: string; role: string }> = [],
): (agentId: string | null) => string {
  const names = new Map<string, string>();
  for (const entry of roles) if (entry.role === "manager") names.set(entry.agentId, "the Manager");
  const name = (ids: readonly string[], role: string) =>
    ids.forEach((id, index) => names.set(id, ids.length === 1 ? role : `${role} ${index + 1}`));
  name(summary.workerIds, "Worker");
  name(summary.reviewerIds, "Reviewer");
  return (agentId) => (agentId === null ? "an agent" : (names.get(agentId) ?? "an agent"));
}

// ---------------------------------------------------------------------------
// Evidence lines (from the reports; a finish's claims labelled, design §C.2).
// ---------------------------------------------------------------------------

export interface EvidenceLine {
  /** `checks`, `files` and `beads` replace `closed` once the request's finish is labelled. */
  key: "plan" | "closed" | "checks" | "files" | "beads" | "review" | "decisions";
  /** `✓` a fact, `◐` something still open, `!` something to look at. */
  mark: "✓" | "◐" | "!";
  text: string;
  tone: Tone;
}

/** Decisions of one request that are still waiting for the owner. */
function openDecisions(decisions: readonly Decision[], requestId: string | null): Decision[] {
  if (requestId === null) return [];
  return decisions.filter((decision) => decision.requestId === requestId && (decision.status === "open" || decision.status === "needs-confirmation"));
}

/**
 * The finish's lines (autonomy design §C.2, §C.6; REQ-130): each check the
 * report names with its label (`!` in the warning tone unless every one is
 * detected), then the files changed and the beads closed with theirs. With no
 * bead claimed, the request's closed count stands in, as before.
 */
function finishLines(verification: TraceVerification, closed: TraceSummary["beadCounts"]["closed"]): EvidenceLine[] {
  const detected = verification.checks === "detected";
  const lines: EvidenceLine[] = [{ key: "checks", mark: detected ? "✓" : "!", text: `checks: ${checksText(verification)}`, tone: detected ? "plain" : "warning" }];
  if (verification.files.length > 0) {
    lines.push({ key: "files", mark: "✓", text: `files: ${verification.files.length} changed · ${claimCountsText(verification.files)}`, tone: "plain" });
  }
  if (verification.beads.length > 0) {
    lines.push({ key: "beads", mark: "✓", text: `beads: ${verification.beads.length} closed · ${claimCountsText(verification.beads)}`, tone: "plain" });
  } else if (closed.count > 0) {
    lines.push({ key: "beads", mark: "✓", text: `beads: ${closed.count} closed${confidenceSuffix(closed.confidence)}`, tone: "plain" });
  }
  return lines;
}

/**
 * What the request has to show for itself, from the Worker's own reports and
 * the decision store: the plan (beads created), what was closed and which
 * checks the report named — once the request finished, each labelled
 * (`finishLines`) —, the last review verdict, and the decisions still open. A
 * line is left out when there is nothing to say.
 */
export function evidenceLines(summary: RequestSummary, detail: TraceDetail | null, decisions: readonly Decision[]): EvidenceLine[] {
  const lines: EvidenceLine[] = [];
  const { created, closed } = summary.beadCounts;
  if (created.count > 0) {
    lines.push({ key: "plan", mark: "✓", text: `plan: ${plural(created.count, "bead")}${confidenceSuffix(created.confidence)}`, tone: "plain" });
  }
  const checks = [...(detail?.received.reports ?? [])].reverse().find((report) => report.buildAndTests !== null)?.buildAndTests ?? null;
  if (isShownVerification(summary.verification)) {
    lines.push(...finishLines(summary.verification, closed));
  } else if (closed.count > 0 || checks !== null) {
    const parts = [
      closed.count > 0 ? `${closed.count} closed${confidenceSuffix(closed.confidence)}` : null,
      checks === null ? null : `checks reported: ${shorten(checks, 80)}`,
    ].filter((part) => part !== null);
    lines.push({ key: "closed", mark: "✓", text: parts.join(" · "), tone: "plain" });
  }
  const review = detail?.received.reviews.filter((entry) => entry.verdict !== null).at(-1);
  if (review !== undefined) {
    const passed = /pass|approved/i.test(review.verdict!);
    const blocking = review.blockingCount === null || review.blockingCount === 0 ? "" : ` · ${review.blockingCount} blocking`;
    lines.push({ key: "review", mark: passed ? "✓" : "!", text: `review: ${review.verdict}${blocking}`, tone: passed ? "plain" : "warning" });
  }
  const open = openDecisions(decisions, summary.requestId).length;
  if (open > 0) lines.push({ key: "decisions", mark: "◐", text: `${plural(open, "decision")} open`, tone: "warning" });
  return lines;
}

// ---------------------------------------------------------------------------
// The timeline.
// ---------------------------------------------------------------------------

export type TimelineKind =
  | "asked"
  | "handed-over"
  | "handoff"
  | "report"
  | "blocked"
  | "finished"
  | "review-asked"
  | "verdict"
  | "decision-asked"
  | "decision-answered"
  | "decision-closed"
  | "you-said"
  | "reply";

export interface TimelineEvent {
  key: string;
  at: string;
  /** `localTimeText`: `15:40`, `yesterday 15:40`, `Thu 24 Sep 15:40`. */
  time: string;
  kind: TimelineKind;
  text: string;
  /** What the event carries on the right: effects asked about, a grant. */
  tag: string | null;
  tone: Tone;
}

function effectText(effects: readonly Effect[]): string {
  return effects.join(", ");
}

function reportEvent(report: ParsedReport, name: string): Omit<TimelineEvent, "key" | "at" | "time"> | null {
  switch (report.phase) {
    case "received":
      return { kind: "report", text: `${name} took the request on${report.tier === null ? "" : ` · ${report.tier}`}`, tag: null, tone: "plain" };
    case "documents-done":
      return { kind: "report", text: `${name}: documents done`, tag: null, tone: "plain" };
    case "beads-done":
      return {
        kind: "report",
        text: `${name}: plan ready${report.beadsCreated.length === 0 ? "" : ` · ${plural(report.beadsCreated.length, "bead")}`}`,
        tag: null,
        tone: "plain",
      };
    case "bead-implemented":
      return {
        kind: "report",
        text: `${name}: ${report.beadsClosed.length === 0 ? "implemented a bead" : `${plural(report.beadsClosed.length, "bead")} closed`}`,
        tag: report.buildAndTests === null ? null : "checks reported",
        tone: "plain",
      };
    case "blocked":
      return { kind: "blocked", text: `${name} is blocked${report.blockers === null ? "" : `: ${shorten(report.blockers, 100)}`}`, tag: null, tone: "warning" };
    case "finished":
      return { kind: "finished", text: `${name} finished`, tag: report.buildAndTests === null ? null : "checks reported", tone: "success" };
    default:
      // A report whose milestone could not be read is an unknown step: not drawn.
      return null;
  }
}

function askerName(decision: Decision, nameOf: (agentId: string | null) => string): string {
  if (decision.askedBy.role === "orchestrator") return "The Orchestrator";
  if (decision.askedBy.role === "plugin") return "paseo-bm";
  return nameOf(decision.askedBy.agentId);
}

function decisionEvents(decision: Decision, nameOf: (agentId: string | null) => string): Array<Omit<TimelineEvent, "time">> {
  const events: Array<Omit<TimelineEvent, "time">> = [];
  const declared = realEffects(decision.options.flatMap((option) => option.effects));
  // Autonomy design §D.2: a held permission request is the agent's, held by paseo-bm.
  const held = decisionKindOf(decision.id) === "held";
  events.push({
    key: `decision:${decision.id}:asked`,
    at: decision.askedAt,
    kind: "decision-asked",
    text: held ? `paseo-bm held a request of ${nameOf(decision.askedBy.agentId)}: ${shorten(decision.question, 120)}` : `${askerName(decision, nameOf)} asked: ${shorten(decision.question, 120)}`,
    tag: declared.length === 0 ? null : effectText(declared),
    tone: decision.status === "open" || decision.status === "needs-confirmation" ? "warning" : "plain",
  });
  const answer = decision.answer;
  if (answer !== null) {
    const option = answer.optionKey === null ? undefined : decision.options.find((entry) => entry.key === answer.optionKey);
    const to = decision.delivery === null ? "" : ` → ${nameOf(decision.delivery.to)}`;
    // The Orchestrator answers only with an option (bm_decide, change-004); so does the policy (autonomy design §B.5).
    const who = answer.by === "orchestrator" ? "The Orchestrator" : "You";
    const text =
      option !== undefined
        ? answer.by === "policy"
          ? `Decided for you by the policy (${answer.predictor === "orchestrator" ? "the Orchestrator's choice" : "recommended option"}): "${shorten(option.label, 80)}"${to}`
          : answer.via === "paseo"
            ? `You chose "${shorten(option.label, 80)}" in Paseo's own prompt`
            : `${who} chose "${shorten(option.label, 80)}"${to}`
        : answer.words !== null
          ? `You answered in your own words${to}`
          : "You confirmed it was answered in the chat";
    const grant = decision.grant;
    events.push({
      key: `decision:${decision.id}:answered`,
      at: answer.at,
      kind: "decision-answered",
      text,
      tag: grant === null ? null : grant.usedAt === null ? `grant: ${effectText(grant.effects)}, 1×` : "grant used",
      tone: "success",
    });
  } else if (decision.settledAt !== null) {
    const words = decision.status === "superseded" ? "replaced by a newer one" : decision.status === "withdrawn" ? "withdrawn" : "expired";
    // A Worker's question, and the owner's override of one, expires when its request finishes (autonomy design §A.3, §B.7).
    const text =
      decision.status === "expired" && deliveryKindOf(decision) === "question"
        ? "The question expired when the request finished."
        : held && decision.status === "withdrawn"
          ? "The held request was answered elsewhere, or its agent moved on"
          : `The question was ${words}`;
    events.push({ key: `decision:${decision.id}:closed`, at: decision.settledAt, kind: "decision-closed", text, tag: null, tone: "muted" });
  }
  return events;
}

/**
 * The request's timeline, newest first: what the owner asked, the hand-over
 * to a Worker — a handoff to a successor (autonomy design §G.6: the request
 * keeps its id) for the first prompt of a Worker the server names in
 * `handoffs` (its `bm.handoffFrom` label), or else for a first message that
 * holds a handoff brief —, each report milestone, review requests and verdicts, the
 * owner's own messages, the Manager's replies, and every decision of the
 * request (asked, answered with its grant, or closed). An event without a
 * readable time, a report whose milestone is unknown and a review without a
 * verdict are not drawn. Events at the same time keep their order, newest
 * source last.
 */
export function timelineEvents(detail: TraceDetail, decisions: readonly Decision[], now: Date): TimelineEvent[] {
  const nameOf = agentNamer(detail, detail.usageByAgent);
  const events: Array<Omit<TimelineEvent, "time">> = [];
  const userRequest = detail.sent.userRequest;
  if (userRequest !== null) {
    events.push({ key: "asked", at: userRequest.at, kind: "asked", text: `You asked: ${shorten(userRequest.text, 100)}`, tag: null, tone: "plain" });
  }
  const successors = new Map((detail.handoffs ?? []).map((handoff) => [handoff.agentId, handoff.from] as const));
  const prompted = new Set<string>();
  detail.sent.workerInitialPrompts.forEach((prompt, index) => {
    // A successor's first prompt is the handoff even when the Manager dropped the brief's marker line (live check F2).
    const agentId = prompt.agentId;
    const successorsFirst = agentId !== null && successors.has(agentId) && !prompted.has(agentId);
    if (agentId !== null) prompted.add(agentId);
    if (successorsFirst || holdsHandoffBrief(prompt.text)) {
      const from = (agentId === null ? undefined : successors.get(agentId)) ?? handoffBriefReplaces(prompt.text);
      const text = `Handed over to ${nameOf(prompt.agentId)}${from === null ? "" : ` from ${nameOf(from)}`}, with a brief of the records`;
      events.push({ key: `handoff:${index}`, at: prompt.at, kind: "handoff", text, tag: "handoff", tone: "info" });
      return;
    }
    events.push({ key: `handed:${index}`, at: prompt.at, kind: "handed-over", text: `The Manager handed it to ${nameOf(prompt.agentId)}`, tag: null, tone: "plain" });
  });
  detail.received.reports.forEach((report, index) => {
    const event = reportEvent(report, nameOf(report.agentId));
    if (event !== null) events.push({ key: `report:${index}`, at: report.at, ...event });
  });
  detail.sent.reviewRequests.forEach((request, index) => {
    events.push({
      key: `review-asked:${index}`,
      at: request.at,
      kind: "review-asked",
      text: `A review was asked of ${nameOf(request.agentId)}`,
      tag: null,
      tone: "plain",
    });
  });
  detail.received.reviews.forEach((review, index) => {
    if (review.verdict === null) return;
    const passed = /pass|approved/i.test(review.verdict);
    const blocking = review.blockingCount === null || review.blockingCount === 0 ? "" : ` · ${review.blockingCount} blocking`;
    events.push({
      key: `verdict:${index}`,
      at: review.at,
      kind: "verdict",
      text: `${nameOf(review.agentId)}: ${review.verdict}${blocking}`,
      tag: null,
      tone: passed ? "success" : "warning",
    });
  });
  detail.userMessages.forEach((message, index) => {
    events.push({ key: `you:${index}`, at: message.at, kind: "you-said", text: `You → ${nameOf(message.agentId)}: ${shorten(message.text, 100)}`, tag: null, tone: "plain" });
  });
  detail.received.managerReplies.forEach((reply, index) => {
    events.push({ key: `reply:${index}`, at: reply.at, kind: "reply", text: `The Manager replied: ${shorten(reply.text, 100)}`, tag: null, tone: "muted" });
  });
  if (detail.requestId !== null) {
    for (const decision of decisions.filter((entry) => entry.requestId === detail.requestId)) events.push(...decisionEvents(decision, nameOf));
  }
  return events
    .map((event, index) => ({ event, index, time: timeOrNull(event.at) }))
    .filter((entry): entry is { event: Omit<TimelineEvent, "time">; index: number; time: number } => entry.time !== null)
    .sort((a, b) => b.time - a.time || b.index - a.index)
    .map(({ event }) => ({ ...event, time: localTimeText(new Date(event.at), now) }));
}

// ---------------------------------------------------------------------------
// A request card.
// ---------------------------------------------------------------------------

export interface RequestCardView {
  key: string;
  title: string;
  /** `Worker · started 3 h ago · Medium · 2 turns`. */
  meta: string;
  stage: StageBarView | null;
  evidence: EvidenceLine[];
  /** `Cost 1.8M tokens · $2.10 (estimated, …)`. */
  cost: string;
  /** The Worker `Open Worker` opens: the request's newest one. */
  workerId: string | null;
  /** Still moving: its detail is read again while it shows. */
  live: boolean;
  /** Ids, for Details only. */
  details: string[];
  accessibilityLabel: string;
}

const RUNTIME_ROLE_NAMES: Readonly<Record<TraceDetail["usageByAgent"][number]["role"], string>> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  orchestrator: "Orchestrator",
  unknown: "Agent",
};

/**
 * What each agent of a request actually ran on, and the tokens per model
 * (delta 20260918 §4.3–§4.4, REQ-058): one line per agent and combination it
 * ran on, for the request's Details. A turn recorded before thinking and mode
 * were says so instead of guessing; a recorded `null` thinking is the
 * provider's default. Empty until the request's detail was read.
 */
export function runtimeDetailLines(detail: TraceDetail | null): string[] {
  if (detail === null) return [];
  const turns = (count: number) => `${count} turn${count === 1 ? "" : "s"}`;
  const agents = detail.usageByAgent.flatMap((entry) =>
    (entry.runtime ?? []).map((row) => {
      const ran = row.recorded
        ? `${row.model ?? "model not recorded"} · thinking ${row.thinkingOptionId ?? "provider default"} · mode ${row.modeId ?? "unknown"}`
        : `${row.model ?? "model not recorded"} · thinking and mode not recorded`;
      return `${RUNTIME_ROLE_NAMES[entry.role]} ${entry.agentId}: ${ran} · ${turns(row.turns)}`;
    }),
  );
  const byModel = (detail.usageByModel ?? []).map(({ model, usage }) => {
    const tokens = `${formatTokens(usage.inputTokens + usage.cachedInputTokens + usage.outputTokens)} tokens`;
    return `${model ?? "unknown model"} ${tokens}${usage.costUsd === null ? "" : ` · ${formatCost(usage)}`}`;
  });
  return byModel.length === 0 ? agents : [...agents, `Tokens by model: ${byModel.join(" · ")}`];
}

export function requestCardView(summary: RequestSummary, detail: TraceDetail | null, decisions: readonly Decision[], now: Date): RequestCardView {
  const workers = summary.workerIds.length;
  const meta = [
    workers === 0 ? "Manager only" : workers === 1 ? "Worker" : `${workers} Workers`,
    `started ${ago(summary.requestedAt, now)}`,
    summary.tier ?? null,
    summary.turns > 1 ? `${summary.turns} turns` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const usage = summary.usage;
  const tokens = usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;
  const stage = stageBar(requestStage(summary, detail));
  const title = shorten(excerptLine(summary.excerpt), 120);
  return {
    key: summary.traceId,
    title,
    meta,
    stage,
    evidence: evidenceLines(summary, detail, decisions),
    cost: `Cost ${formatTokens(tokens)} tokens · ${formatCost(usage)}`,
    workerId: summary.workerIds.at(-1) ?? null,
    live: summary.state === "running" || summary.state === "waiting_user",
    details: [
      `Request: ${summary.requestId ?? "no id recorded"}`,
      `Trace: ${summary.traceId}`,
      ...summary.workerIds.map((id, index) => `Worker${workers === 1 ? "" : ` ${index + 1}`}: ${id}`),
      ...summary.reviewerIds.map((id, index) => `Reviewer${summary.reviewerIds.length === 1 ? "" : ` ${index + 1}`}: ${id}`),
      ...runtimeDetailLines(detail),
      ...(isShownVerification(summary.verification) ? verificationDetailLines(summary.verification) : []),
    ],
    accessibilityLabel: [title, meta, stage?.accessibilityLabel ?? null].filter((part) => part !== null).join(". "),
  };
}

/** Said when a project has no request on record yet. */
export const NO_REQUESTS_TEXT = "No request on record for this project yet. Chat with its Beads Manager to start one.";

// ---------------------------------------------------------------------------
// Tokens and context (autonomy design §G.2 Shown): a request's Details, and
// each agent in the Agents tab, from `traces.agents`.
// ---------------------------------------------------------------------------

export const TOKEN_FIGURES_TITLE = "Tokens and context";
export const NO_REQUEST_TOKENS_TEXT = "No turn of this request is on record yet.";
export const NO_AGENT_TOKENS_TEXT = "No turn of these agents is on record yet.";
/** Why a figure says "at least" (run note 2026-09-30 §4). */
export const LOWER_BOUND_NOTE = "“At least”: Codex and OpenCode report only the last model call of each turn.";
/** How a context the provider did not report is had (`turnTokensOf`). */
export const ESTIMATE_NOTE = "Where the provider did not report the context, it is estimated from the tokens the turn read.";

/** An agent's context over its turns: bars and words. */
export interface ContextTrendView {
  /** Each bar's height, 0..1 of the window when the provider reported one, else of the largest point; oldest first. */
  bars: number[];
  /** `context 142k of 200k (71 %) · peak 150k`, or `context 142k`. */
  text: string;
  /** `estimate`, `partly estimated`, or null when the provider reported every figure. */
  estimate: string | null;
  accessibilityLabel: string;
}

export interface AgentTokensView {
  /** The agent's id: a list key, never drawn. */
  key: string;
  /** `Worker 2`, `Manager · Fee list`: never an id. */
  name: string;
  /** `8.4M read · 38 turns`, `at least 8.4M read · …` on a last-call provider, `no usage recorded · 3 turns`. */
  tokens: string;
  /** Null when no turn has a context figure. */
  trend: ContextTrendView | null;
  /** `1 compaction`, or null. */
  note: string | null;
  accessibilityLabel: string;
}

export interface TokenFiguresView {
  /** `Tokens read: Manager 1.2M · Worker 8.4M` (a request's Details); null elsewhere, or when no turn had usage. */
  byRole: string | null;
  agents: AgentTokensView[];
  /** What the figures cannot say: a lower bound, an estimate. */
  notes: string[];
}

export type TokenFiguresState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "empty"; text: string }
  | { kind: "figures"; view: TokenFiguresView };

const TOKEN_ROLES: ReadonlyArray<AgentTokenFigures["role"]> = ["manager", "worker", "reviewer", "orchestrator", "unknown"];

function share(part: number, whole: number): string {
  return `${Math.round((100 * part) / whole)} %`;
}

/** The context trend of one agent, or null when none of its turns has a context figure. */
export function contextTrendView(figures: AgentTokenFigures): ContextTrendView | null {
  const points = figures.contextTrend;
  const latest = points.at(-1);
  if (latest === undefined) return null;
  const max = figures.contextMax;
  const scale = max ?? Math.max(...points);
  const peak = figures.contextPeak ?? latest;
  const text = [
    `context ${formatTokens(latest)}${max === null ? "" : ` of ${formatTokens(max)} (${share(latest, max)})`}`,
    peak > latest ? `peak ${formatTokens(peak)}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const estimate = figures.contextEstimated === 0 ? null : figures.contextEstimated >= figures.contextTurns ? "estimate" : "partly estimated";
  const over = figures.contextTurns > points.length ? `the last ${points.length} turns` : plural(points.length, "turn");
  return {
    bars: points.map((point) => (scale > 0 ? Math.min(1, point / scale) : 0)),
    text,
    estimate,
    accessibilityLabel: `Context over ${over}: ${formatTokens(points[0]!)} to ${formatTokens(latest)}${max === null ? "" : ` of ${formatTokens(max)}`}${estimate === null ? "" : `, ${estimate}`}`,
  };
}

function agentTokensView(figures: AgentTokenFigures, name: string): AgentTokensView {
  const turns = plural(figures.turns, "turn");
  const tokens =
    figures.turnsWithUsage === 0
      ? `no usage recorded · ${turns}`
      : `${figures.lastCallTurns > 0 ? "at least " : ""}${formatTokens(Math.round(figures.tokensRead))} read · ${turns}`;
  const trend = contextTrendView(figures);
  const note = figures.compactions === 0 ? null : plural(figures.compactions, "compaction");
  return {
    key: figures.agentId,
    name,
    tokens,
    trend,
    note,
    accessibilityLabel: [name, tokens, trend?.accessibilityLabel ?? "context not known", note].filter((part) => part !== null).join(". "),
  };
}

function tokenNotes(agents: readonly AgentTokenFigures[]): string[] {
  return [
    agents.some((agent) => agent.lastCallTurns > 0) ? LOWER_BOUND_NOTE : null,
    agents.some((agent) => agent.contextEstimated > 0) ? ESTIMATE_NOTE : null,
  ].filter((note): note is string => note !== null);
}

/**
 * A request's tokens and context, for its Details: the tokens read by role,
 * then each agent — named by role, numbered as the ids above them are when a
 * role has several — with its context trend. Waits, fails with the reason, or
 * says there is no turn yet.
 */
export function requestTokenFigures(
  summary: Pick<RequestSummary, "workerIds" | "reviewerIds">,
  agents: readonly AgentTokenFigures[] | undefined,
  error: string | null,
): TokenFiguresState {
  if (error !== null) return { kind: "error", text: `Could not read the tokens and context. ${error}` };
  if (agents === undefined) return { kind: "loading" };
  if (agents.length === 0) return { kind: "empty", text: NO_REQUEST_TOKENS_TEXT };
  // The Details lines number Workers and Reviewers in the request's order; the rest follow in the figures' order.
  const known: Partial<Record<AgentTokenFigures["role"], readonly string[]>> = { worker: summary.workerIds, reviewer: summary.reviewerIds };
  const nameOf = (figures: AgentTokenFigures): string => {
    const listed = known[figures.role] ?? [];
    const ids = [...listed, ...agents.filter((entry) => entry.role === figures.role && !listed.includes(entry.agentId)).map((entry) => entry.agentId)];
    const label = RUNTIME_ROLE_NAMES[figures.role];
    return ids.length <= 1 ? label : `${label} ${ids.indexOf(figures.agentId) + 1}`;
  };
  const read = TOKEN_ROLES.map((role) => ({
    role,
    tokens: agents.filter((entry) => entry.role === role && entry.turnsWithUsage > 0).reduce((sum, entry) => sum + entry.tokensRead, 0),
    counted: agents.some((entry) => entry.role === role && entry.turnsWithUsage > 0),
  })).filter((entry) => entry.counted);
  return {
    kind: "figures",
    view: {
      byRole: read.length === 0 ? null : `Tokens read: ${read.map((entry) => `${RUNTIME_ROLE_NAMES[entry.role]} ${formatTokens(Math.round(entry.tokens))}`).join(" · ")}`,
      agents: agents.map((figures) => agentTokensView(figures, nameOf(figures))),
      notes: tokenNotes(agents),
    },
  };
}

/**
 * The Agents tab's tokens and context: each agent the tree lists, over its
 * life, named by role and title — the figures' order (Managers, Workers,
 * Reviewers). Waits for both reads; an agent the tree no longer lists is left
 * out.
 */
export function agentTokenFigures(
  figures: readonly AgentTokenFigures[] | undefined,
  listed: ReadonlyArray<Pick<AgentNode, "id" | "title">> | undefined,
  error: string | null,
): TokenFiguresState {
  if (error !== null) return { kind: "error", text: `Could not read the tokens and context. ${error}` };
  if (figures === undefined || listed === undefined) return { kind: "loading" };
  const titles = new Map(listed.map((agent) => [agent.id, agent.title ?? null]));
  const shown = figures.filter((entry) => titles.has(entry.agentId));
  if (shown.length === 0) return { kind: "empty", text: NO_AGENT_TOKENS_TEXT };
  return {
    kind: "figures",
    view: {
      byRole: null,
      agents: shown.map((entry) => {
        const title = titles.get(entry.agentId) ?? null;
        const label = RUNTIME_ROLE_NAMES[entry.role];
        return agentTokensView(entry, title === null || title.trim() === "" ? label : `${label} · ${shorten(title, 60)}`);
      }),
      notes: tokenNotes(shown),
    },
  };
}
