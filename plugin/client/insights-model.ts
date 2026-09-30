/**
 * Everything Insights shows, without a renderer (experience concept §4.3,
 * autonomy design §A.12). Phase 1 shows the flow and cost figures that
 * `insights.summary` computes with the metric module, and the Beads figures
 * that used to open the Beads screen (`beadsOverview`). Autonomy (Phase 2) and
 * review lift (Phase 3) are placeholders that say when they arrive.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { INSIGHTS_WINDOWS, type BeadRow, type BeadStats, type InsightsSummary, type InsightsWindow } from "../shared/contracts";
import { beadsOverview, doneText, type BeadsOverview } from "./beads-model";
import { formatDuration, formatTokens, type Bar, type OverviewCard } from "./dashboard-model";

const DAY_MS = 86_400_000;

export const INSIGHTS_DEFAULT_WINDOW: InsightsWindow = "30d";

/** The window tabs, in `INSIGHTS_WINDOWS` order. */
export const WINDOW_LABELS: Readonly<Record<InsightsWindow, string>> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

export const WINDOW_TABS: ReadonlyArray<{ key: InsightsWindow; label: string }> = INSIGHTS_WINDOWS.map((key) => ({
  key,
  label: WINDOW_LABELS[key],
}));

/** The project choice meaning every project. Not a workspace id: those are never empty. */
export const ALL_PROJECTS = "";

/** At most this many days are drawn in the per-day chart. */
export const PER_DAY_MAX_BARS = 14;

const WINDOW_DAYS: Readonly<Record<InsightsWindow, number | null>> = { "7d": 7, "30d": 30, "90d": 90, all: null };

type Role = keyof InsightsSummary["turnsByRole"];

/** Roles in the order Insights lists them, with the word the owner reads. */
export const ROLE_LABELS: ReadonlyArray<[Role, string]> = [
  ["manager", "Manager"],
  ["worker", "Worker"],
  ["reviewer", "Reviewer"],
  ["orchestrator", "Orchestrator"],
  ["unknown", "Other"],
];

export interface InsightsProject {
  id: string;
  label: string;
}

/**
 * The projects Insights can narrow to: the open workspaces in the surface's
 * order, then the closed ones that left history under a known name. A closed
 * workspace with no name is left out rather than shown by its id.
 */
export function insightsProjects(
  open: ReadonlyArray<{ id: string; screenTitle: string }>,
  stored: ReadonlyArray<{ workspaceId: string; lastKnownName: string | null }>,
): InsightsProject[] {
  const seen = new Set(open.map((workspace) => workspace.id));
  const closed = stored
    .filter((entry) => !seen.has(entry.workspaceId) && entry.lastKnownName !== null)
    .map((entry) => ({ id: entry.workspaceId, label: `${entry.lastKnownName ?? ""} (closed)` }));
  return [...open.map((workspace) => ({ id: workspace.id, label: workspace.screenTitle })), ...closed];
}

/** The project tabs: every project first, then each one the surface knows by name. */
export function projectTabs(projects: readonly InsightsProject[]): Array<{ key: string; label: string }> {
  return [{ key: ALL_PROJECTS, label: "All projects" }, ...projects.map((project) => ({ key: project.id, label: project.label }))];
}

/** One line saying what the figures cover: `Last 30 days · all projects`. */
export function scopeLine(window: InsightsWindow, projectLabel: string | null): string {
  const when = window === "all" ? "Everything recorded" : `Last ${WINDOW_LABELS[window]}`;
  return `${when} · ${projectLabel ?? "all projects"}`;
}

/** A mean per request: one decimal, `—` when unknown. */
export function formatPerRequest(value: number | null): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A duration in milliseconds, whole, or `—` when unknown. */
function formatMs(ms: number | null): string {
  return formatDuration(ms === null ? null : Math.round(ms));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function percent(part: number, whole: number): string {
  return whole <= 0 ? "—" : `${Math.round((100 * part) / whole)} %`;
}

/**
 * Requests per day over the last days of the window, oldest first, a day
 * without a request drawn as zero. At most `PER_DAY_MAX_BARS` days, ending
 * today (UTC, as the metric module counts days).
 */
export function requestsPerDayBars(byDay: InsightsSummary["requestsByDay"], window: InsightsWindow, now: Date): Bar[] {
  const counts = new Map(byDay.map((entry) => [entry.day, entry.requests]));
  const days = Math.min(PER_DAY_MAX_BARS, WINDOW_DAYS[window] ?? PER_DAY_MAX_BARS);
  const bars: Bar[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    const value = counts.get(day) ?? 0;
    bars.push({ label: day.slice(5), value, display: String(value) });
  }
  return bars;
}

/** Tokens per finished request by role, each with its share; roles with none are left out. */
export function tokensByRoleBars(tokens: InsightsSummary["tokens"]): Bar[] {
  const per = tokens.perFinishedRequest;
  if (per === null) return [];
  return ROLE_LABELS.filter(([role]) => per.byRole[role] > 0).map(([role, label]) => ({
    label,
    value: per.byRole[role],
    display: `${formatTokens(Math.round(per.byRole[role]))} · ${percent(per.byRole[role], per.total)}`,
  }));
}

/** The flow cards: requests, questions, owner wait, time to finished, errors. */
export function flowCards(summary: InsightsSummary): OverviewCard[] {
  const { requests, questions, ownerWait, timeToFinished, errors } = summary;
  const per = questions.perFinishedRequest;
  return [
    { label: "Requests", value: String(requests.inWindow), hint: `${requests.finished} finished` },
    {
      label: "Questions per request",
      value: formatPerRequest(per?.asked ?? null),
      hint:
        per === null
          ? "no finished request"
          : `${formatPerRequest(per.reachedOwner)} reached you · ${formatPerRequest(per.answeredByAgents)} answered by agents`,
    },
    {
      label: "Your wait",
      value: formatMs(ownerWait.medianMs),
      hint: ownerWait.questions === 0 ? "no question waited on you" : `median · p90 ${formatMs(ownerWait.p90Ms)} · ${plural(ownerWait.questions, "question")}`,
    },
    {
      label: "Time to finished",
      value: formatMs(timeToFinished.medianMs),
      hint: timeToFinished.requests === 0 ? "no finished request" : `median of ${plural(timeToFinished.requests, "request")}, your wait excluded`,
    },
    {
      label: "Errors",
      value: String(errors.failedTurns.total),
      hint: `${plural(errors.failedTurns.total, "failed turn")} · ${errors.cancelledTurns.total} cancelled`,
    },
  ];
}

/** The cost cards: tokens per finished request and in all. */
export function costCards(summary: InsightsSummary): OverviewCard[] {
  const { tokens, requests } = summary;
  const missing = tokens.finishedRequestsWithMissingUsage;
  return [
    {
      label: "Tokens per request",
      value: tokens.perFinishedRequest === null ? "—" : formatTokens(Math.round(tokens.perFinishedRequest.total)),
      hint:
        tokens.medianPerFinishedRequest === null
          ? "no finished request"
          : `median ${formatTokens(Math.round(tokens.medianPerFinishedRequest))}${missing === 0 ? "" : ` · ${missing} with usage missing`}`,
    },
    {
      label: "Tokens",
      value: formatTokens(Math.round(tokens.total)),
      hint: `over ${plural(requests.finished, "finished request")}`,
    },
  ];
}

/** What could not be counted, in one line; `null` when everything was. */
export function unknownsLine(unknowns: InsightsSummary["unknowns"]): string | null {
  const parts = [
    unknowns.malformedLines === 0 ? null : plural(unknowns.malformedLines, "unreadable line"),
    unknowns.unreadableFiles === 0 ? null : plural(unknowns.unreadableFiles, "unreadable file"),
    unknowns.turnsWithoutUsage === 0 ? null : `${plural(unknowns.turnsWithoutUsage, "turn")} without usage`,
    unknowns.requestsWithoutDuration === 0 ? null : `${plural(unknowns.requestsWithoutDuration, "finished request")} without a duration`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Not counted: ${parts.join(" · ")}`;
}

export const INSIGHTS_UNAVAILABLE = "paseo-bm's data folder cannot be read, so there is nothing to count yet.";
export const INSIGHTS_EMPTY = "No request was recorded in this period.";

export interface InsightsView {
  /** A sentence instead of the figures, or null when there are figures. */
  empty: string | null;
  flow: OverviewCard[];
  cost: OverviewCard[];
  tokensByRole: Bar[];
  requestsPerDay: Bar[];
  perDayTitle: string;
  unknowns: string | null;
}

/** Everything the flow and cost part of Insights draws, from one summary. */
export function insightsView(summary: InsightsSummary, now: Date): InsightsView {
  const turns = ROLE_LABELS.reduce((sum, [role]) => sum + summary.turnsByRole[role], 0);
  const { window: range } = summary;
  const perDay = requestsPerDayBars(summary.requestsByDay, range.key, now);
  return {
    empty: !summary.available ? INSIGHTS_UNAVAILABLE : summary.requests.inWindow === 0 && turns === 0 ? INSIGHTS_EMPTY : null,
    flow: flowCards(summary),
    cost: costCards(summary),
    tokensByRole: tokensByRoleBars(summary.tokens),
    requestsPerDay: perDay,
    perDayTitle: `Requests per day · last ${plural(perDay.length, "day")}`,
    unknowns: unknownsLine(summary.unknowns),
  };
}

// ---------------------------------------------------------------------------
// Beads: the figures that opened the Beads screen (delta 20260916-beads-screen).
// ---------------------------------------------------------------------------

export const BEADS_CHOOSE_PROJECT = "Choose a project above to see its beads.";

export type BeadsFiguresView =
  | { kind: "choose"; text: string }
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "figures"; overview: BeadsOverview; done: { text: string; label: string } };

/** The Beads part: a project's `beadsOverview`, or why there is none. */
export function beadsFiguresView(
  projectId: string,
  data: { beads: readonly BeadRow[]; stats: BeadStats } | undefined,
  error: string | null,
  now: Date,
): BeadsFiguresView {
  if (projectId === ALL_PROJECTS) return { kind: "choose", text: BEADS_CHOOSE_PROJECT };
  if (error !== null) return { kind: "error", text: error };
  if (data === undefined) return { kind: "loading" };
  const overview = beadsOverview(data.beads, data.stats, now);
  return { kind: "figures", overview, done: doneText(overview.progress) };
}

// ---------------------------------------------------------------------------
// What later phases add.
// ---------------------------------------------------------------------------

export interface PhasePlaceholder {
  key: "autonomy" | "review";
  title: string;
  text: string;
}

export const PHASE_PLACEHOLDERS: readonly PhasePlaceholder[] = [
  {
    key: "autonomy",
    title: "Autonomy by class",
    text: "Arrives with Phase 2, calibrated autonomy: for each class of decision, who decides, how often the recommended answer was taken, and what was reversed.",
  },
  {
    key: "review",
    title: "Review lift",
    text: "Arrives with Phase 3, evidence: blocking findings per review batch, findings acted on, and tokens per review.",
  },
];
