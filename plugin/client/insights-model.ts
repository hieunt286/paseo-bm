/**
 * Everything a project's Metrics tab shows, without a renderer (change-014
 * outcome 5; it was the Insights section until then — experience concept
 * §4.3, autonomy design §A.12): the flow and cost figures that
 * `insights.summary` computes with the metric module, the Beads figures
 * (`beadsOverview`), the Orchestrator's interventions and how many reached
 * their outcome (A-12, §G.3), autonomy by class — the agreement ledger of the
 * project with each class's mode (§B.3), read only since ADR-025 —, the
 * tokens read per request and the heaviest requests (§G.2), and review lift
 * per size of request (§C.4).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { modeOf, type AutonomyPolicy } from "../shared/autonomy";
import type { AgreementCell, AgreementLedger } from "../shared/autonomy-ledger";
import { INSIGHTS_WINDOWS, type BeadRow, type BeadStats, type InsightsSummary, type InsightsWindow } from "../shared/contracts";
import { DECISION_CLASSES, PREDICTORS, REVERSAL_KINDS, type DecisionClass, type Predictor, type ReversalKind } from "../shared/decisions";
import { A12_TARGET, type InterventionKind } from "../shared/interventions";
import { beadsOverview, doneText, type BeadsOverview } from "./beads-model";
import { formatDuration, formatTokens, type Bar, type OverviewCard } from "./format";
import type { Tone } from "./tone";
import { CLASS_LABELS, MODE_LABELS } from "./settings-autonomy-model";
import { plural } from "../shared/text";
import { timeOrNull } from "../shared/time";
import { median, percentile } from "../shared/eval-metrics/helpers";

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
 * The projects the surface knows by name — Settings and Tools & skills name
 * projects with them: the open workspaces in the surface's order, then the closed ones that left history under a known name. A closed
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

// ---------------------------------------------------------------------------
// Cost: tokens read per request and the heaviest requests (autonomy design
// §G.2 Shown), from `summary.context`. Numbers and project names only.
// ---------------------------------------------------------------------------

export const HEAVIEST_TITLE = "Heaviest requests";
export const REQUEST_TOKENS_EMPTY = "No request read any tokens in this period.";
/** Said of a project the surface cannot name (a closed workspace with no known name): never its id. */
export const UNNAMED_PROJECT = "Unnamed project";

/** One of the heaviest requests: its project by name and its numbers. */
export interface HeavyRequestView {
  /** A list key, never drawn. */
  key: string;
  project: string;
  /** `21M read`. */
  tokens: string;
  /** `Worker 93 % · 48 turns · finished`: the role that read most, its share, the turns, and whether it finished. */
  detail: string;
  accessibilityLabel: string;
}

export interface RequestTokensView {
  /** A sentence instead of the figures, or null. */
  empty: string | null;
  /** Tokens read per request: the median, p75, p90 and the largest. */
  distribution: Bar[];
  distributionTitle: string;
  heaviest: HeavyRequestView[];
  /** What the figures cannot say: the turns whose provider reports only the last model call. */
  notes: string[];
}

/**
 * Tokens read per request and the heaviest requests, or null when the server
 * sends no context figures (an older one). A request counts once it has a
 * turn with usage; a percentile that cannot be had is left out.
 */
export function requestTokensView(context: InsightsSummary["context"], projects: readonly InsightsProject[]): RequestTokensView | null {
  if (context === undefined) return null;
  const spread = context.tokensRead.perRequest.all;
  const { byProvider, withUsage } = context.turns;
  const lastCall = byProvider.codex + byProvider.opencode;
  const notes =
    lastCall === 0
      ? []
      : [`Codex and OpenCode report only the last model call of each turn (${lastCall} of ${plural(withUsage, "turn")}), so these figures are a lower bound.`];
  if (spread.count === 0) return { empty: REQUEST_TOKENS_EMPTY, distribution: [], distributionTitle: "", heaviest: [], notes: [] };
  const points: Array<[string, number | null]> = [
    ["Median", spread.median],
    ["p75", spread.p75],
    ["p90", spread.p90],
    ["Largest", spread.max],
  ];
  const distribution = points
    .filter((point): point is [string, number] => point[1] !== null)
    .map(([label, value]) => ({ label, value, display: formatTokens(Math.round(value)) }));
  const names = new Map(projects.map((project) => [project.id, project.label]));
  const heaviest = context.tokensRead.heaviestRequests.map((request, index): HeavyRequestView => {
    const project = names.get(request.workspaceId) ?? UNNAMED_PROJECT;
    const [role, label] = ROLE_LABELS.reduce((best, entry) => (request.byRole[entry[0]] > request.byRole[best[0]] ? entry : best));
    const tokens = `${formatTokens(Math.round(request.tokensRead))} read`;
    const detail = [
      request.tokensRead > 0 ? `${label} ${percent(request.byRole[role], request.tokensRead)}` : null,
      plural(request.turns, "turn"),
      request.finished ? "finished" : "not finished",
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
    return { key: `${index}:${request.workspaceId}`, project, tokens, detail, accessibilityLabel: `${project}: ${tokens}, ${detail}` };
  });
  return { empty: null, distribution, distributionTitle: `Tokens read per request · ${plural(spread.count, "request")}`, heaviest, notes };
}

/** The word the owner reads for each kind of intervention. */
export const INTERVENTION_LABELS: Readonly<Record<InterventionKind, string>> = {
  answer: "Answers",
  unblock: "Unblocks",
  correct: "Corrections",
  stop: "Stops",
  compact: "Compactions",
  handoff: "Handoffs",
  advice: "Advice",
};

/** What the Coordination figures are, and the target they are held to (A-12). */
export const COORDINATION_NOTE = `How often the Orchestrator's interventions reached their expected outcome in time. The target is ${Math.round(A12_TARGET * 100)} % for each kind.`;
export const COORDINATION_EMPTY = "The Orchestrator made no intervention in this period.";

/**
 * A-12 per kind (autonomy design §G.3): one card per kind the Orchestrator
 * used in the window — the share met of those checked, then what is still
 * pending or could not be told. A kind with no intervention is left out.
 */
export function coordinationCards(summary: InsightsSummary): OverviewCard[] {
  return summary.interventions
    .filter((row) => row.recorded > 0)
    .map((row) => {
      const checked = row.met + row.missed;
      return {
        label: INTERVENTION_LABELS[row.kind],
        value: row.share === null ? "—" : `${Math.round(row.share * 100)} %`,
        hint: [
          checked === 0 ? "none checked yet" : `${row.met} of ${checked} met`,
          row.pending === 0 ? null : `${row.pending} pending`,
          row.unknown === 0 ? null : `${row.unknown} unknown`,
        ]
          .filter((part): part is string => part !== null)
          .join(" · "),
      };
    });
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
  /** A-12 per kind used in the window; empty when the Orchestrator made no intervention. */
  coordination: OverviewCard[];
  tokensByRole: Bar[];
  /** Tokens read per request and the heaviest requests (§G.2); null from a server that sends none. */
  requestTokens: RequestTokensView | null;
  requestsPerDay: Bar[];
  perDayTitle: string;
  unknowns: string | null;
  /** Review lift per tier (§C.4); null from a server that sends none. */
  reviewLift: ReviewLiftView | null;
}

/**
 * Everything the flow, cost and coordination part of Insights draws, from one
 * summary. `projects` names the heaviest requests' projects.
 */
export function insightsView(summary: InsightsSummary, now: Date, projects: readonly InsightsProject[] = []): InsightsView {
  const turns = ROLE_LABELS.reduce((sum, [role]) => sum + summary.turnsByRole[role], 0);
  const { window: range } = summary;
  const perDay = requestsPerDayBars(summary.requestsByDay, range.key, now);
  return {
    empty: !summary.available ? INSIGHTS_UNAVAILABLE : summary.requests.inWindow === 0 && turns === 0 ? INSIGHTS_EMPTY : null,
    flow: flowCards(summary),
    cost: costCards(summary),
    coordination: coordinationCards(summary),
    tokensByRole: tokensByRoleBars(summary.tokens),
    requestTokens: requestTokensView(summary.context, projects),
    requestsPerDay: perDay,
    perDayTitle: `Requests per day · last ${plural(perDay.length, "day")}`,
    unknowns: unknownsLine(summary.unknowns),
    reviewLift: reviewLiftView(summary.reviewLift),
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
// Autonomy by class (autonomy design §B.3, §A.12; PRD REQ-122 b): one
// project's agreement ledger, a row per class with each predictor's figures
// and the class's mode. Numbers only: no question, option or id. Read only:
// the figures are information, never a condition, and the project's autonomy
// is its level, set in Settings (ADR-025; the Delegate? shortcut is retired).
// ---------------------------------------------------------------------------

export const AUTONOMY_TITLE = "Autonomy by class";

/** What the figures are, that the window tabs do not narrow them, and where autonomy is set. */
export const AUTONOMY_NOTE =
  "How often each prediction matched your answer, per class of decision — over every answer recorded, whatever the period above. " +
  "The figures are for your information: the project's autonomy level is set in Settings → Autonomy.";

export const AUTONOMY_CHOOSE_PROJECT = "Choose a project to see how often its answers were foreseen.";

export const AUTONOMY_NO_DATA =
  "None of your answers in this project can be compared with a prediction yet. The figures start with the next question you answer.";

/** Each predictor as a column heading. */
export const LEDGER_PREDICTOR_LABELS: Readonly<Record<Predictor, string>> = {
  recommended: "Recommended option",
  orchestrator: "Orchestrator",
};

/** How each kind of reversal (§B.3) reads. */
const REVERSAL_WORDS: Readonly<Record<ReversalKind, string>> = {
  "re-asked": "asked again",
  overridden: "overridden",
  reopened: "reopened",
};

/** One predictor's figures in a class row. */
export interface AgreementFiguresView {
  predictor: Predictor;
  label: string;
  /** `91 %`, or `—` with no answer counted (unknown, never zero). */
  agreement: string;
  /** `matched 31 of 34 answers`, or why there is nothing to count. */
  count: string;
  /** The first and last answer's UTC day, `2026-09-01 → 2026-09-28` (one day once); null with no answer counted. */
  span: string | null;
  /** `No reversal` or `2 reversed: 1 asked again · 1 reopened`; null when the predictor has no answer in this class. */
  reversals: string | null;
  reversalTone: Tone;
  /** Answers confirmed from a chat, never read, which count in neither figure; null when there is none. */
  unread: string | null;
  accessibilityLabel: string;
}

/** One class of the chosen project. */
export interface AutonomyClassRowView {
  decisionClass: DecisionClass;
  label: string;
  /** `Owner`, `Shadow` or `Delegated (Orchestrator)`. */
  modeText: string;
  modeTone: Tone;
  /** One per predictor column, in `PREDICTORS` order. */
  figures: AgreementFiguresView[];
  accessibilityLabel: string;
}

export type AutonomyFiguresView =
  | { kind: "choose"; text: string }
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "empty"; text: string }
  | {
      kind: "figures";
      rows: AutonomyClassRowView[];
      /** The classes with no figure and no mode above `owner`, named in one line; null when every class has a row. */
      quiet: string | null;
    };

function utcDay(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso.slice(0, 10) : new Date(time).toISOString().slice(0, 10);
}

function spanText(cell: AgreementCell): string | null {
  if (cell.firstAt === null || cell.lastAt === null) return null;
  const first = utcDay(cell.firstAt);
  const last = utcDay(cell.lastAt);
  return first === last ? first : `${first} → ${last}`;
}

/** Decisions reversed, then how, each decision once per kind (a decision reversed two ways is in both). */
function reversalsText(cell: AgreementCell): string {
  if (cell.reversals === 0) return "No reversal";
  const kinds = REVERSAL_KINDS.filter((kind) => cell.reversalsByKind[kind] > 0).map((kind) => `${cell.reversalsByKind[kind]} ${REVERSAL_WORDS[kind]}`);
  return `${cell.reversals} reversed: ${kinds.join(" · ")}`;
}

function agreementFigures(predictor: Predictor, cell: AgreementCell | undefined): AgreementFiguresView {
  const label = LEDGER_PREDICTOR_LABELS[predictor];
  if (cell === undefined) {
    const count = "No answer yet";
    return { predictor, label, agreement: "—", count, span: null, reversals: null, reversalTone: "muted", unread: null, accessibilityLabel: `${label}: ${count}` };
  }
  const agreement = percent(cell.agreed, cell.count);
  const count = cell.count === 0 ? "No answer counted" : `matched ${cell.agreed} of ${plural(cell.count, "answer")}`;
  const span = spanText(cell);
  const reversals = reversalsText(cell);
  const unread = cell.unread === 0 ? null : `${plural(cell.unread, "answer")} given in a chat, not counted`;
  return {
    predictor,
    label,
    agreement,
    count,
    span,
    reversals,
    reversalTone: cell.reversals === 0 ? "muted" : "warning",
    unread,
    accessibilityLabel: [
      `${label}: ${agreement === "—" ? "no agreement yet" : `${agreement} agreement`}`,
      count,
      span,
      reversals,
      unread,
    ]
      .filter((part): part is string => part !== null)
      .join(", "),
  };
}

function modeTextOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): { text: string; tone: Tone } {
  const mode = modeOf(policy, workspaceId, decisionClass);
  if (mode === "delegate") return { text: `${MODE_LABELS.delegate} (${LEDGER_PREDICTOR_LABELS.orchestrator})`, tone: "info" };
  return { text: MODE_LABELS[mode], tone: mode === "shadow" ? "plain" : "muted" };
}

/**
 * The Autonomy part for one project: waits for the ledger and the policy, or
 * says why it cannot. A class has a row when the ledger has a cell of it or
 * its mode is above `owner`, in conflict order (riskiest first,
 * `DECISION_CLASSES`); the Orchestrator's column appears once it has a figure
 * in the project. The window does not narrow the ledger: the figures are over
 * every answer. Read only (ADR-025).
 */
export function autonomyFiguresView(input: {
  projectId: string;
  ledger: AgreementLedger | undefined;
  policy: AutonomyPolicy | undefined;
  error: string | null;
}): AutonomyFiguresView {
  const { projectId, ledger, policy, error } = input;
  if (projectId === ALL_PROJECTS) return { kind: "choose", text: AUTONOMY_CHOOSE_PROJECT };
  if (error !== null) return { kind: "error", text: `Could not read the autonomy figures. ${error}` };
  if (ledger === undefined || policy === undefined) return { kind: "loading" };
  const cells = ledger.cells.filter((cell) => cell.workspaceId === projectId);
  const shown = DECISION_CLASSES.filter(
    (decisionClass) => cells.some((cell) => cell.class === decisionClass) || modeOf(policy, projectId, decisionClass) !== "owner",
  );
  if (shown.length === 0) return { kind: "empty", text: AUTONOMY_NO_DATA };
  const predictors = PREDICTORS.filter((predictor) => predictor === "recommended" || cells.some((cell) => cell.predictor === predictor));
  const rows = shown.map((decisionClass): AutonomyClassRowView => {
    const label = CLASS_LABELS[decisionClass];
    const mode = modeTextOf(policy, projectId, decisionClass);
    const figures = predictors.map((predictor) =>
      agreementFigures(predictor, cells.find((cell) => cell.class === decisionClass && cell.predictor === predictor)),
    );
    return {
      decisionClass,
      label,
      modeText: mode.text,
      modeTone: mode.tone,
      figures,
      accessibilityLabel: `${label}, ${mode.text}. ${figures.map((figure) => figure.accessibilityLabel).join(". ")}`,
    };
  });
  const quiet = DECISION_CLASSES.filter((decisionClass) => !shown.includes(decisionClass));
  return {
    kind: "figures",
    rows,
    quiet: quiet.length === 0 ? null : `No answer to compare yet: ${quiet.map((decisionClass) => CLASS_LABELS[decisionClass]).join(" · ")}`,
  };
}

// ---------------------------------------------------------------------------
// Review lift (autonomy design §C.4): per size of request, what the reviews
// found, how much the next review saw fixed, and what a review cost — the
// figures the review budget per tier is tuned from. It follows the window and
// project tabs. Numbers only; unknown is a dash, never zero.
// ---------------------------------------------------------------------------

type ReviewLift = NonNullable<InsightsSummary["reviewLift"]>;
type ReviewTier = keyof ReviewLift["byTier"];
type ReviewFigures = ReviewLift["all"];

export const REVIEW_LIFT_TITLE = "Review lift";
export const REVIEW_LIFT_NOTE = "What reviews found in each size of request, how much was fixed by the next review, and what a review cost.";
export const REVIEW_LIFT_EMPTY = "No review was recorded in this period.";

/** The tiers in the order they are listed, with the word the owner reads. */
export const REVIEW_TIER_LABELS: ReadonlyArray<[ReviewTier, string]> = [
  ["Small", "Small"],
  ["Medium", "Medium"],
  ["Large", "Large"],
  ["unknown", "Size not reported"],
];

/** One figure of a tier: its name, the number, and what it is over. */
export interface ReviewFigureView {
  label: string;
  /** `1.4`, `75 %`, `310k`, or `—` when unknown. */
  value: string;
  detail: string;
}

/** One tier with a reviewed request. */
export interface ReviewTierRowView {
  tier: ReviewTier;
  label: string;
  /** `12 requests reviewed`. */
  count: string;
  /** Reviews per request, blocking findings per batch, findings acted on, tokens per review. */
  figures: ReviewFigureView[];
  accessibilityLabel: string;
}

export type ReviewLiftView =
  | { kind: "empty"; text: string }
  | {
      kind: "figures";
      rows: ReviewTierRowView[];
      /** What could not be counted, in one line; null when everything was. */
      unknowns: string | null;
    };

function reviewFigures(figures: ReviewFigures): ReviewFigureView[] {
  const { actedOn, tokens } = figures;
  const knownBatches = figures.batches - figures.unknown.batchesWithUnknownBlocking;
  const actedOnDetail = [
    actedOn.reReviewedBatches === 0 ? "no batch reviewed again" : `${actedOn.fixed} of ${plural(actedOn.found, "finding")} fixed on re-review`,
    actedOn.reviewedOnceBatches === 0 ? null : `${plural(actedOn.reviewedOnceBatches, "batch", "batches")} reviewed once`,
  ].filter((part): part is string => part !== null);
  return [
    {
      label: "Reviews per request",
      value: formatPerRequest(figures.reviewsPerRequest),
      detail: `${plural(figures.reviews, "review")} in ${plural(figures.batches, "batch", "batches")}`,
    },
    {
      label: "Blocking findings per batch",
      value: formatPerRequest(figures.blockingPerBatch),
      detail: knownBatches === 0 ? "no batch with a known count" : `${plural(figures.blockingFindings, "finding")} over ${plural(knownBatches, "batch", "batches")}`,
    },
    { label: "Findings acted on", value: percent(actedOn.fixed, actedOn.found), detail: actedOnDetail.join(" · ") },
    {
      label: "Tokens per review",
      value: tokens.perReview === null ? "—" : formatTokens(Math.round(tokens.perReview)),
      detail: tokens.reviews === 0 ? "Reviewer usage unknown" : `${formatTokens(Math.round(tokens.total))} over ${plural(tokens.reviews, "review")}`,
    },
  ];
}

/** What review lift could not count, in one line; null when everything was. */
function reviewUnknownsLine(reviewLift: ReviewLift): string | null {
  const { unknown } = reviewLift.all;
  const parts = [
    unknown.reviewsWithoutBatch === 0 ? null : `${plural(unknown.reviewsWithoutBatch, "review")} without a batch`,
    unknown.batchesWithUnknownBlocking === 0 ? null : `${plural(unknown.batchesWithUnknownBlocking, "batch", "batches")} with an unknown blocking count`,
    unknown.requestsWithoutReviewerTokens === 0 ? null : `${plural(unknown.requestsWithoutReviewerTokens, "request")} without Reviewer usage`,
    unknown.requestsWithoutReview === 0 ? null : `${plural(unknown.requestsWithoutReview, "request")} whose Reviewer sent no review`,
    reviewLift.reviewerTurnsWithoutRequest === 0 ? null : `${plural(reviewLift.reviewerTurnsWithoutRequest, "Reviewer turn")} without a request`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `Not counted: ${parts.join(" · ")}`;
}

/**
 * Review lift of the chosen window and project: a row per tier with a
 * reviewed request, in size order, or why there is none; null from a server
 * that sends no review figures (an older one).
 */
export function reviewLiftView(reviewLift: InsightsSummary["reviewLift"]): ReviewLiftView | null {
  if (reviewLift === undefined) return null;
  const rows = REVIEW_TIER_LABELS.filter(([tier]) => reviewLift.byTier[tier].requests > 0).map(([tier, label]): ReviewTierRowView => {
    const figures = reviewFigures(reviewLift.byTier[tier]);
    const count = `${plural(reviewLift.byTier[tier].requests, "request")} reviewed`;
    return {
      tier,
      label,
      count,
      figures,
      accessibilityLabel: `${label}, ${count}. ${figures.map((figure) => `${figure.label} ${figure.value === "—" ? "unknown" : figure.value}, ${figure.detail}`).join(". ")}`,
    };
  });
  const unknowns = reviewUnknownsLine(reviewLift);
  if (rows.length === 0) return { kind: "empty", text: unknowns === null ? REVIEW_LIFT_EMPTY : `${REVIEW_LIFT_EMPTY} ${unknowns}` };
  return { kind: "figures", rows, unknowns };
}

// ---------------------------------------------------------------------------
// The Metrics tab as the approved mockup draws it (change-014 fidelity pass,
// ProjectMetrics artboard): the period as a segmented control, a strip of five
// figures, the bead status bar, closed beads per day, beads by feature, tokens
// by role, and "How the work ran" for this project beside all projects. The
// bead figures are computed here from `beads.list` rows (`createdAt`,
// `closedAt`), the rest from `insights.summary`. A figure that cannot be had
// reads `—`, never 0.
// ---------------------------------------------------------------------------

/** The period cells, in `INSIGHTS_WINDOWS` order: the windows the server offers, written short. */
export const WINDOW_SHORT_LABELS: Readonly<Record<InsightsWindow, string>> = { "7d": "7 d", "30d": "30 d", "90d": "90 d", all: "All" };

export const WINDOW_SEGMENTS: ReadonlyArray<{ key: InsightsWindow; label: string; accessibilityLabel: string }> = INSIGHTS_WINDOWS.map((key) => ({
  key,
  label: WINDOW_SHORT_LABELS[key],
  accessibilityLabel: key === "all" ? "Everything recorded" : `Last ${WINDOW_LABELS[key]}`,
}));

/** At most this many days are drawn in Closed per day: the newest days with a closed bead. */
export const CLOSED_PER_DAY_MAX = 14;

export const TOKENS_BY_ROLE_NOTE =
  "Context read per turn, summed. Claude counts every model call of a turn, Codex only the last, so roles on different providers are not exactly comparable.";

/** One cell of a figure strip: an uppercase label, a large value, an optional unit after it and a muted line under it. */
export interface FigureCell {
  label: string;
  value: string;
  /** `/ 50` after `43`, smaller and muted; null for none. */
  unit: string | null;
  hint: string | null;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The start of the window, in ms; null for everything recorded. */
function windowStart(window: InsightsWindow, now: Date): number | null {
  const days = WINDOW_DAYS[window];
  return days === null ? null : now.getTime() - days * DAY_MS;
}

function inWindow(at: number, start: number | null, now: Date): boolean {
  return (start === null || at >= start) && at <= now.getTime();
}

/** How long the work beads closed in the window took, created to closed: median, p90 and how many. Epics left out. */
export function leadTimes(beads: readonly BeadRow[], window: InsightsWindow, now: Date): { median: number | null; p90: number | null; count: number } {
  const start = windowStart(window, now);
  const spans: number[] = [];
  for (const bead of beads) {
    if (bead.issueType === "epic" || bead.status !== "closed") continue;
    const created = timeOrNull(bead.createdAt);
    const closed = timeOrNull(bead.closedAt);
    if (created === null || closed === null || closed < created || !inWindow(closed, start, now)) continue;
    spans.push(closed - created);
  }
  return { median: median(spans), p90: percentile(spans, 90), count: spans.length };
}

/** One day of Closed per day: `1 Oct` and how many beads closed that local day. */
export interface DayBar {
  key: string;
  label: string;
  /** The day as a phone writes it under its bar: `1/10` (day/month). */
  short: string;
  value: number;
}

/**
 * The beads closed per local day in the window, oldest first: only days with
 * a closed bead, the newest `CLOSED_PER_DAY_MAX` of them (the mockup's bars
 * skip quiet days).
 */
export function closedPerDay(beads: readonly BeadRow[], window: InsightsWindow, now: Date): DayBar[] {
  const start = windowStart(window, now);
  const counts = new Map<string, { at: Date; value: number }>();
  for (const bead of beads) {
    const closed = timeOrNull(bead.closedAt);
    if (closed === null || !inWindow(closed, start, now)) continue;
    const at = new Date(closed);
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    const entry = counts.get(key);
    if (entry === undefined) counts.set(key, { at, value: 1 });
    else entry.value += 1;
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-CLOSED_PER_DAY_MAX)
    .map(([key, { at, value }]) => ({ key, label: `${at.getDate()} ${MONTH_SHORT[at.getMonth()]}`, short: `${at.getDate()}/${at.getMonth() + 1}`, value }));
}

/** The bead status bar: closed, deferred and open (the rest), with how many of the open ones are ready. */
export interface BeadStatusBarView {
  total: number;
  segments: Array<{ key: "closed" | "deferred" | "open"; label: string; value: number; share: number }>;
  accessibilityLabel: string;
}

export function beadStatusBar(beads: readonly BeadRow[]): BeadStatusBarView {
  const total = beads.length;
  const closed = beads.filter((bead) => bead.status === "closed").length;
  const deferred = beads.filter((bead) => bead.status === "deferred").length;
  const open = total - closed - deferred;
  const ready = beads.filter((bead) => bead.status !== "closed" && bead.ready).length;
  const share = (value: number) => (total === 0 ? 0 : value / total);
  const segments: BeadStatusBarView["segments"] = [
    { key: "closed", label: `Closed ${closed}`, value: closed, share: share(closed) },
    { key: "deferred", label: `Deferred ${deferred}`, value: deferred, share: share(deferred) },
    { key: "open", label: ready > 0 ? `Open ${open} · ${ready} ready` : `Open ${open}`, value: open, share: share(open) },
  ];
  return { total, segments, accessibilityLabel: `${total} beads: ${segments.map((segment) => segment.label).join(", ")}` };
}

/** Beads per feature (`feature:<slug>` labels), most first; a bead without one is not counted. */
export function featureBars(beads: readonly BeadRow[]): Bar[] {
  const counts = new Map<string, number>();
  for (const bead of beads) {
    for (const label of bead.labels) {
      if (!label.startsWith("feature:")) continue;
      const feature = label.slice("feature:".length);
      counts.set(feature, (counts.get(feature) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value, display: String(value) }));
}

/** One row of Tokens by role: the role, its value and its share of the total read, or `not recorded`. */
export interface RoleTokenRow {
  key: Role;
  label: string;
  value: string;
  /** 0–1: the bar's length. */
  share: number;
  recorded: boolean;
}

/** The roles in the mockup's order: Worker, Manager, Reviewer, then Orchestrator; Other only when it read something. */
const ROLE_TOKEN_ORDER: readonly Role[] = ["worker", "manager", "reviewer", "orchestrator", "unknown"];

/**
 * Tokens read by role (context read per turn, summed), or `[]` from a server
 * that sends no context figures. The Orchestrator's row stays, reading `not
 * recorded`, when none of its turns was recorded.
 */
export function roleTokenRows(context: InsightsSummary["context"], options: { orchestrator: boolean } = { orchestrator: true }): RoleTokenRow[] {
  if (context === undefined) return [];
  const read = context.tokensRead;
  const label = (role: Role) => ROLE_LABELS.find(([key]) => key === role)![1];
  return ROLE_TOKEN_ORDER.flatMap((role): RoleTokenRow[] => {
    const value = read.byRole[role];
    if (value > 0) return [{ key: role, label: label(role), value: formatTokens(Math.round(value)), share: read.total <= 0 ? 0 : value / read.total, recorded: true }];
    if (role === "orchestrator" && options.orchestrator) return [{ key: role, label: label(role), value: "not recorded", share: 0, recorded: false }];
    return [];
  });
}

/** The letter of each role in the Turns figure: `M 160 · W 123 · R 30`. */
const TURN_LETTERS: ReadonlyArray<[Role, string]> = [
  ["manager", "M"],
  ["worker", "W"],
  ["reviewer", "R"],
  ["orchestrator", "O"],
];

export function turnsCell(summary: InsightsSummary | undefined): FigureCell {
  if (summary === undefined) return { label: "Turns", value: "—", unit: null, hint: null };
  const total = ROLE_LABELS.reduce((sum, [role]) => sum + summary.turnsByRole[role], 0);
  const hint = TURN_LETTERS.filter(([role]) => summary.turnsByRole[role] > 0)
    .map(([role, letter]) => `${letter} ${summary.turnsByRole[role]}`)
    .join(" · ");
  return { label: "Turns", value: String(total), unit: null, hint: hint === "" ? null : hint };
}

/** Context read per request: the tokens read over the requests that read any. */
export function tokensPerRequestText(summary: InsightsSummary | undefined): string {
  const read = summary?.context?.tokensRead;
  if (read === undefined || read.perRequest.all.count === 0) return "—";
  return formatTokens(Math.round(read.total / read.perRequest.all.count));
}

/** The Metrics strip: beads closed, lead time, requests, tokens per request, turns. */
export function metricsStrip(input: {
  summary: InsightsSummary | undefined;
  beads: readonly BeadRow[] | undefined;
  window: InsightsWindow;
  now: Date;
}): FigureCell[] {
  const { summary, beads, window, now } = input;
  const closed = beads === undefined ? null : beads.filter((bead) => bead.status === "closed").length;
  const lead = beads === undefined ? null : leadTimes(beads, window, now);
  return [
    { label: "Beads closed", value: closed === null ? "—" : String(closed), unit: beads === undefined ? null : `/ ${beads.length}`, hint: null },
    {
      label: "Lead time · median",
      value: lead === null ? "—" : formatMs(lead.median),
      unit: null,
      hint: lead === null || lead.count === 0 ? null : `p90 ${formatMs(lead.p90)} · ${plural(lead.count, "task")}`,
    },
    { label: "Requests", value: summary === undefined ? "—" : String(summary.requests.inWindow), unit: null, hint: null },
    { label: "Tokens per request", value: tokensPerRequestText(summary), unit: null, hint: "context read" },
    turnsCell(summary),
  ];
}

/** One measure of How the work ran: this project beside all projects. */
export interface ProcessRow {
  label: string;
  project: string;
  all: string;
}

function processFigures(summary: InsightsSummary | undefined) {
  if (summary === undefined) return null;
  return {
    questions: formatPerRequest(summary.questions.perFinishedRequest?.reachedOwner ?? null),
    reviews: formatPerRequest(summary.reviewLift?.all.reviewsPerRequest ?? null),
    finished: formatMs(summary.timeToFinished.medianMs),
    // Paseo's stall count is not in the summary yet: it reads as unknown, never 0.
    cut: `${summary.errors.cancelledTurns.total} · —`,
    wait: formatMs(summary.ownerWait.medianMs),
    failed: String(summary.errors.failedTurns.total),
  };
}

/** How the work ran, as a table: the mockup's four measures, then your wait and failed turns (what the Flow cards said). */
export function processRows(project: InsightsSummary | undefined, all: InsightsSummary | undefined): ProcessRow[] {
  const here = processFigures(project);
  const every = processFigures(all);
  const row = (label: string, key: keyof NonNullable<ReturnType<typeof processFigures>>): ProcessRow => ({
    label,
    project: here === null ? "—" : here[key],
    all: every === null ? "—" : every[key],
  });
  return [
    row("Questions reaching you per finished request", "questions"),
    row("Reviews per reviewed request", "reviews"),
    row("Median time to finished", "finished"),
    row("Turns cut by Paseo · stalls", "cut"),
    row("Your wait · median", "wait"),
    row("Failed turns", "failed"),
  ];
}

/** The three cells of the Overview's How the work ran. */
export function processCells(summary: InsightsSummary | undefined): Array<{ label: string; value: string }> {
  const recorded = summary === undefined ? null : summary.interventions.reduce((sum, row) => sum + row.recorded, 0);
  const helped = summary === undefined ? 0 : summary.interventions.reduce((sum, row) => sum + row.met, 0);
  return [
    { label: "Reviews per reviewed request", value: summary === undefined ? "—" : formatPerRequest(summary.reviewLift?.all.reviewsPerRequest ?? null) },
    { label: "Questions reaching you per request", value: summary === undefined ? "—" : formatPerRequest(summary.questions.perFinishedRequest?.reachedOwner ?? null) },
    { label: "Orchestrator interventions", value: recorded === null ? "—" : `${recorded} · ${helped} helped` },
  ];
}

/** Everything the Metrics tab draws, from what has been read so far (each input undefined until it answered). */
export interface MetricsView {
  strip: FigureCell[];
  /** Null until the beads were read. */
  beadStatus: BeadStatusBarView | null;
  closedPerDay: DayBar[] | null;
  features: Bar[] | null;
  roleTokens: RoleTokenRow[];
  process: ProcessRow[];
  /** Coordination, tokens read per request, review lift and what was not counted; null until the summary was read. */
  insights: InsightsView | null;
}

export function metricsView(input: {
  summary: InsightsSummary | undefined;
  /** The same window over every project, for How the work ran's second column. */
  all: InsightsSummary | undefined;
  beads: readonly BeadRow[] | undefined;
  window: InsightsWindow;
  projects: readonly InsightsProject[];
  now: Date;
}): MetricsView {
  const { summary, beads, window, now } = input;
  return {
    strip: metricsStrip({ summary, beads, window, now }),
    beadStatus: beads === undefined ? null : beadStatusBar(beads),
    closedPerDay: beads === undefined ? null : closedPerDay(beads, window, now),
    features: beads === undefined ? null : featureBars(beads),
    roleTokens: roleTokenRows(summary?.context, { orchestrator: false }),
    process: processRows(summary, input.all),
    insights: summary === undefined ? null : insightsView(summary, now, input.projects),
  };
}
