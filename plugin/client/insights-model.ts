/**
 * Everything Insights shows, without a renderer (experience concept §4.3,
 * autonomy design §A.12). Phase 1 shows the flow and cost figures that
 * `insights.summary` computes with the metric module, and the Beads figures
 * that used to open the Beads screen (`beadsOverview`); Phase 2 adds the
 * Orchestrator's interventions and how many reached their outcome (A-12,
 * §G.3), and autonomy by class — the agreement ledger of one project with each
 * class's mode (§B.3) and **Delegate?** where a class earned it (§B.4), and
 * to Cost the tokens read per request and the heaviest requests (§G.2); Phase 3
 * adds review lift per size of request (§C.4).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import {
  ELIGIBLE_MIN_AGREEMENT,
  ELIGIBLE_MIN_DECISIONS,
  ELIGIBLE_MIN_SPAN_DAYS,
  canDelegate,
  demotedAtOf,
  eligibility,
  modeOf,
  predictorOf,
  type AutonomyPolicy,
  type AutonomySetInput,
} from "../shared/autonomy";
import type { AgreementCell, AgreementLedger } from "../shared/autonomy-ledger";
import { INSIGHTS_WINDOWS, type BeadRow, type BeadStats, type InsightsSummary, type InsightsWindow } from "../shared/contracts";
import { DECISION_CLASSES, PREDICTORS, REVERSAL_KINDS, type DecisionClass, type Predictor, type ReversalKind } from "../shared/decisions";
import { A12_TARGET, type InterventionKind } from "../shared/interventions";
import { beadsOverview, doneText, type BeadsOverview } from "./beads-model";
import { formatDuration, formatTokens, type Bar, type OverviewCard } from "./format";
import type { Tone } from "./tone";
import { CLASS_LABELS, MODE_LABELS, PREDICTOR_WORDS, RETURN_ALL_LABEL } from "./settings-autonomy-model";
import type { ConfirmDialog } from "./ui-types";
import { plural } from "../shared/text";

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
// and the class's mode. Numbers only: no question, option or id. Promotion
// (§B.4; REQ-123 a): **Delegate?** on each predictor's figures that earned it,
// confirmed in place (Cancel first) before `autonomy.set` delegates the class.
// ---------------------------------------------------------------------------

export const AUTONOMY_TITLE = "Autonomy by class";

/**
 * What the figures are, that the window tabs do not narrow them (a class earns
 * autonomy over every answer, §B.4), and when Delegate? is offered.
 */
export const AUTONOMY_NOTE =
  "How often each prediction matched your answer, per class of decision — over every answer recorded, whatever the period above; " +
  "a class that went back to Shadow counts again from then. " +
  `Delegate? is offered once a prediction matched at least ${Math.round(ELIGIBLE_MIN_AGREEMENT * 100)} % of ${ELIGIBLE_MIN_DECISIONS} or more answers ` +
  `over ${ELIGIBLE_MIN_SPAN_DAYS} days or more, none reversed.`;

export const DELEGATE_LABEL = "Delegate?";

/** Which Delegate? confirmation is open, and how its change went (the screen's state). */
export interface DelegationUi {
  confirming: { decisionClass: DecisionClass; predictor: Predictor } | null;
  /** `autonomy.set` is running. */
  busy: boolean;
  /** Why the last delegation failed. */
  error: string | null;
}

export const DELEGATION_UI_IDLE: DelegationUi = { confirming: null, busy: false, error: null };

/** Delegate? on one predictor's figures: only on an eligible cell of a delegable class that is not delegated yet. */
export interface DelegateOfferView {
  decisionClass: DecisionClass;
  predictor: Predictor;
  label: string;
  /** False while a delegation runs or a confirmation is open. */
  enabled: boolean;
  accessibilityLabel: string;
}

/** Delegate?'s confirmation, in place under its class, Cancel first. */
export interface DelegateConfirmView {
  dialog: ConfirmDialog;
  busy: boolean;
  busyLabel: string;
  error: string | null;
  /** What confirming sends: `autonomy.set` with `confirmed: true` and the predictor that earned it. */
  input: AutonomySetInput;
}

/** `autonomy.set`'s input for a confirmed Delegate?: the class, and the predictor that made the cell eligible (§B.4). */
export function delegateInputOf(workspaceId: string, decisionClass: DecisionClass, predictor: Predictor): AutonomySetInput {
  return { workspaceId, class: decisionClass, mode: "delegate", confirmed: true, predictor };
}

export const AUTONOMY_CHOOSE_PROJECT = "Choose a project above to see how often its answers were foreseen.";

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
  /** Delegate?, when this predictor's cell earned it (§B.4); else null. */
  delegate: DelegateOfferView | null;
  accessibilityLabel: string;
}

/** One class of the chosen project. */
export interface AutonomyClassRowView {
  decisionClass: DecisionClass;
  label: string;
  /** `Owner`, `Shadow`, `Delegated (Recommended option)`, or `Owner only` for release, data, security and cost. */
  modeText: string;
  modeTone: Tone;
  ownerOnly: boolean;
  /** One per predictor column, in `PREDICTORS` order. */
  figures: AgreementFiguresView[];
  /** `Went back to Shadow on 2026-09-30 after a reversal; counted from then.`, or null for a class never demoted. */
  demoted: string | null;
  /** Delegate?'s confirmation for this class while it is open; else null. */
  confirm: DelegateConfirmView | null;
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

function agreementFigures(predictor: Predictor, cell: AgreementCell | undefined, ownerOnly: boolean, delegate: DelegateOfferView | null): AgreementFiguresView {
  const label = LEDGER_PREDICTOR_LABELS[predictor];
  if (cell === undefined) {
    // The Orchestrator is never asked to predict a class that is always the owner's (§B.3).
    const count = predictor === "orchestrator" && ownerOnly ? "Not predicted: always yours" : "No answer yet";
    return {
      predictor,
      label,
      agreement: "—",
      count,
      span: null,
      reversals: null,
      reversalTone: "muted",
      unread: null,
      delegate: null,
      accessibilityLabel: `${label}: ${count}`,
    };
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
    delegate,
    accessibilityLabel: [
      `${label}: ${agreement === "—" ? "no agreement yet" : `${agreement} agreement`}`,
      count,
      span,
      reversals,
      unread,
      delegate === null ? null : "can be delegated",
    ]
      .filter((part): part is string => part !== null)
      .join(", "),
  };
}

/**
 * Delegate?'s confirmation (§B.4): the class, the project, who would decide,
 * the figures that earned it, and how it is taken back — a reversal or an
 * override at once, Return all to owner by hand. Cancel is the default.
 */
export function delegateDialog(input: { classLabel: string; projectLabel: string; predictor: Predictor; cell: AgreementCell }): ConfirmDialog {
  const { classLabel, projectLabel, predictor, cell } = input;
  const from = cell.firstAt === null ? null : utcDay(cell.firstAt);
  const to = cell.lastAt === null ? null : utcDay(cell.lastAt);
  const span = from === null || to === null ? "" : ` from ${from} to ${to}`;
  return {
    title: `Delegate ${classLabel} decisions?`,
    body:
      `In ${projectLabel}, ${classLabel} questions will be answered for you by ${PREDICTOR_WORDS[predictor]}, without asking you. ` +
      `It earned this: it matched ${cell.agreed} of your ${plural(cell.count, "answer")} (${percent(cell.agreed, cell.count)})${span}, none reversed. ` +
      `A reversal or an override takes it back at once; ${RETURN_ALL_LABEL} in Settings → Autonomy undoes it.`,
    confirmLabel: "Delegate",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

function modeTextOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): { text: string; tone: Tone } {
  if (!canDelegate(decisionClass)) return { text: "Owner only", tone: "muted" };
  const mode = modeOf(policy, workspaceId, decisionClass);
  if (mode === "delegate") {
    const predictor = predictorOf(policy, workspaceId, decisionClass);
    return { text: predictor === null ? MODE_LABELS.delegate : `${MODE_LABELS.delegate} (${LEDGER_PREDICTOR_LABELS[predictor]})`, tone: "info" };
  }
  return { text: MODE_LABELS[mode], tone: mode === "shadow" ? "plain" : "muted" };
}

/**
 * The Autonomy part for the chosen project: across all projects it asks for
 * one; then waits for the ledger and the policy, or says why it cannot. A
 * class has a row when the ledger has a cell of it or its mode is above
 * `owner`, in conflict order (riskiest first, `DECISION_CLASSES`); the
 * Orchestrator's column appears once it has a figure in the project. The
 * window does not narrow the ledger: eligibility is judged over every answer
 * (since the class's last demotion, which the server already counts from).
 *
 * **Delegate?** (§B.4) is on each predictor's figures whose cell is eligible
 * (`eligibility` at `now`), for a delegable class not delegated yet, in
 * either `owner` or `shadow` (§B.9). While `ui.confirming` names one still
 * offered, that class carries its confirmation and every offer waits.
 */
export function autonomyFiguresView(input: {
  projectId: string;
  /** The chosen project's name, for the confirmation; "this project" when unknown. */
  projectLabel?: string | null;
  ledger: AgreementLedger | undefined;
  policy: AutonomyPolicy | undefined;
  error: string | null;
  now: Date;
  ui?: DelegationUi;
}): AutonomyFiguresView {
  const { projectId, ledger, policy, error, now } = input;
  const ui = input.ui ?? DELEGATION_UI_IDLE;
  if (projectId === ALL_PROJECTS) return { kind: "choose", text: AUTONOMY_CHOOSE_PROJECT };
  if (error !== null) return { kind: "error", text: `Could not read the autonomy figures. ${error}` };
  if (ledger === undefined || policy === undefined) return { kind: "loading" };
  const projectLabel = input.projectLabel ?? "this project";
  const cells = ledger.cells.filter((cell) => cell.workspaceId === projectId);
  const shown = DECISION_CLASSES.filter(
    (decisionClass) => cells.some((cell) => cell.class === decisionClass) || modeOf(policy, projectId, decisionClass) !== "owner",
  );
  if (shown.length === 0) return { kind: "empty", text: AUTONOMY_NO_DATA };
  const predictors = PREDICTORS.filter((predictor) => predictor === "recommended" || cells.some((cell) => cell.predictor === predictor));
  const cellOfFigure = (decisionClass: DecisionClass, predictor: Predictor) =>
    cells.find((cell) => cell.class === decisionClass && cell.predictor === predictor);
  const earned = (decisionClass: DecisionClass, predictor: Predictor): AgreementCell | null => {
    const cell = cellOfFigure(decisionClass, predictor);
    if (cell === undefined || !canDelegate(decisionClass) || modeOf(policy, projectId, decisionClass) === "delegate") return null;
    return eligibility(cell, now).eligible ? cell : null;
  };
  const confirming = ui.confirming !== null && earned(ui.confirming.decisionClass, ui.confirming.predictor) !== null ? ui.confirming : null;
  const rows = shown.map((decisionClass): AutonomyClassRowView => {
    const label = CLASS_LABELS[decisionClass];
    const ownerOnly = !canDelegate(decisionClass);
    const mode = modeTextOf(policy, projectId, decisionClass);
    const figures = predictors.map((predictor) => {
      const offer: DelegateOfferView | null =
        earned(decisionClass, predictor) === null
          ? null
          : {
              decisionClass,
              predictor,
              label: DELEGATE_LABEL,
              enabled: !ui.busy && confirming === null,
              accessibilityLabel: `Delegate ${label} decisions in ${projectLabel} to ${PREDICTOR_WORDS[predictor]}`,
            };
      return agreementFigures(predictor, cellOfFigure(decisionClass, predictor), ownerOnly, offer);
    });
    const demotedAt = demotedAtOf(policy, projectId, decisionClass);
    const demoted = demotedAt === null ? null : `Went back to Shadow on ${utcDay(demotedAt)} after a reversal; counted from then.`;
    const confirmedCell = confirming?.decisionClass === decisionClass ? earned(decisionClass, confirming.predictor) : null;
    const confirm: DelegateConfirmView | null =
      confirming === null || confirmedCell === null
        ? null
        : {
            dialog: delegateDialog({ classLabel: label, projectLabel, predictor: confirming.predictor, cell: confirmedCell }),
            busy: ui.busy,
            busyLabel: "Delegating…",
            error: ui.error,
            input: delegateInputOf(projectId, decisionClass, confirming.predictor),
          };
    return {
      decisionClass,
      label,
      modeText: mode.text,
      modeTone: mode.tone,
      ownerOnly,
      figures,
      demoted,
      confirm,
      accessibilityLabel: [`${label}, ${mode.text}.`, figures.map((figure) => figure.accessibilityLabel).join(". "), demoted]
        .filter((part): part is string => part !== null)
        .join(" "),
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
