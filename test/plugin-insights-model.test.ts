import { describe, expect, it, vi } from "vitest";
import {
  ALL_PROJECTS,
  AUTONOMY_CHOOSE_PROJECT,
  AUTONOMY_NO_DATA,
  AUTONOMY_NOTE,
  AUTONOMY_TITLE,
  BEADS_CHOOSE_PROJECT,
  COORDINATION_EMPTY,
  COORDINATION_NOTE,
  HEAVIEST_TITLE,
  INSIGHTS_DEFAULT_WINDOW,
  INTERVENTION_LABELS,
  INSIGHTS_EMPTY,
  INSIGHTS_UNAVAILABLE,
  PER_DAY_MAX_BARS,
  REQUEST_TOKENS_EMPTY,
  REVIEW_LIFT_EMPTY,
  REVIEW_LIFT_NOTE,
  REVIEW_LIFT_TITLE,
  UNNAMED_PROJECT,
  WINDOW_TABS,
  CLOSED_PER_DAY_MAX,
  TOKENS_BY_ROLE_NOTE,
  WINDOW_SEGMENTS,
  autonomyFiguresView,
  beadStatusBar,
  closedPerDay,
  featureBars,
  leadTimes,
  metricsView,
  processRows,
  roleTokenRows,
  beadsFiguresView,
  coordinationCards,
  costCards,
  flowCards,
  formatPerRequest,
  insightsProjects,
  insightsView,
  requestTokensView,
  requestsPerDayBars,
  reviewLiftView,
  scopeLine,
  tokensByRoleBars,
  unknownsLine,
} from "../plugin/client/insights-model";
import { beadsOverview } from "../plugin/client/beads-model";
import { dashboardStyles } from "../plugin/client/styles";
import { AUTONOMY_POLICY_KEY } from "../plugin/client/settings-autonomy-model";
import { EMPTY_AUTONOMY_POLICY, type AutonomyPolicy } from "../plugin/shared/autonomy";
import type { AgreementCell, AgreementLedger } from "../plugin/shared/autonomy-ledger";
import { INSIGHTS_WINDOWS, type BeadRow, type BeadStats, type InsightsSummary } from "../plugin/shared/contracts";
import { INTERVENTION_KINDS } from "../plugin/shared/interventions";
import { allNodes, pressables, renderTree, textOf, texts, type RNode } from "./helpers/element-tree";

/**
 * A project's Metrics tab (change-014 outcome 5; the Insights section until
 * then — experience concept §4.3, autonomy design §A.12): its model is
 * pure and tested here; its hook-free pieces (`MetricsBody`,
 * `InsightsFigures`, `BeadsFigures`, `AutonomyFigures`, `ReviewLiftFigures`)
 * are expanded with the element-tree helper, at phone and desktop widths where
 * they differ. `react-native` and the SDK icon are named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const insightsPath = "../plugin/client/insights.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const insightsModule = (await import(insightsPath)) as Record<string, unknown>;
const { MetricsBody, InsightsFigures, BeadsFigures, AutonomyFigures, ReviewLiftFigures, HeavyRequestRow } = insightsModule as {
  HeavyRequestRow: Component;
  MetricsBody: Component;
  InsightsFigures: Component;
  BeadsFigures: Component;
  AutonomyFigures: Component;
  ReviewLiftFigures: Component;
};
const PROCESS_LEGEND = insightsModule.PROCESS_LEGEND as string;

const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const styles = dashboardStyles(theme as never, false);
const NOW = new Date("2026-09-27T09:00:00.000Z");
const noop = () => undefined;
const roles = (manager: number, worker: number, reviewer: number, orchestrator = 0, unknown = 0) => ({ manager, worker, reviewer, orchestrator, unknown });

type ReviewLift = NonNullable<InsightsSummary["reviewLift"]>;
type ReviewFigures = ReviewLift["all"];
const NO_REVIEWS: ReviewFigures = {
  requests: 0,
  reviews: 0,
  reviewsPerRequest: null,
  batches: 0,
  blockingFindings: 0,
  blockingPerBatch: null,
  actedOn: { reReviewedBatches: 0, found: 0, fixed: 0, reviewedOnceBatches: 0 },
  tokens: { reviews: 0, total: 0, perReview: null },
  unknown: {
    reviewsWithoutBatch: 0,
    reviewsWithUnknownBlocking: 0,
    batchesWithUnknownBlocking: 0,
    reReviewedWithUnknownBlocking: 0,
    requestsWithoutReviewerTokens: 0,
    requestsWithoutReview: 0,
  },
};
const reviewFigures = (
  figures: Partial<Omit<ReviewFigures, "actedOn" | "tokens" | "unknown">> & {
    actedOn?: Partial<ReviewFigures["actedOn"]>;
    tokens?: Partial<ReviewFigures["tokens"]>;
    unknown?: Partial<ReviewFigures["unknown"]>;
  },
): ReviewFigures => ({
  ...NO_REVIEWS,
  ...figures,
  actedOn: { ...NO_REVIEWS.actedOn, ...figures.actedOn },
  tokens: { ...NO_REVIEWS.tokens, ...figures.tokens },
  unknown: { ...NO_REVIEWS.unknown, ...figures.unknown },
});
/** Three tiers reviewed (none Large): Small approved at once, Medium with findings fixed on re-review, one request without a tier or Reviewer usage. */
const REVIEW_LIFT: ReviewLift = {
  all: reviewFigures({
    requests: 16,
    reviews: 33,
    reviewsPerRequest: 33 / 16,
    batches: 17,
    blockingFindings: 20,
    blockingPerBatch: 20 / 16,
    actedOn: { reReviewedBatches: 8, found: 12, fixed: 9, reviewedOnceBatches: 8 },
    tokens: { reviews: 29, total: 8_510_000, perReview: 8_510_000 / 29 },
    unknown: { reviewsWithoutBatch: 2, reviewsWithUnknownBlocking: 1, batchesWithUnknownBlocking: 1, reReviewedWithUnknownBlocking: 1, requestsWithoutReviewerTokens: 2, requestsWithoutReview: 1 },
  }),
  byTier: {
    Small: reviewFigures({ requests: 3, reviews: 3, reviewsPerRequest: 1, batches: 3, blockingPerBatch: 0, actedOn: { reviewedOnceBatches: 3 }, tokens: { reviews: 3, total: 450_000, perReview: 150_000 } }),
    Medium: reviewFigures({
      requests: 12,
      reviews: 28,
      reviewsPerRequest: 28 / 12,
      batches: 14,
      blockingFindings: 20,
      blockingPerBatch: 20 / 13,
      actedOn: { reReviewedBatches: 8, found: 12, fixed: 9, reviewedOnceBatches: 5 },
      tokens: { reviews: 26, total: 8_060_000, perReview: 310_000 },
      unknown: { reviewsWithUnknownBlocking: 1, batchesWithUnknownBlocking: 1, reReviewedWithUnknownBlocking: 1, requestsWithoutReviewerTokens: 1, requestsWithoutReview: 1 },
    }),
    Large: NO_REVIEWS,
    unknown: reviewFigures({ requests: 1, reviews: 2, reviewsPerRequest: 2, unknown: { reviewsWithoutBatch: 2, requestsWithoutReviewerTokens: 1 } }),
  },
  reviewerTurnsWithoutRequest: 1,
};
const NO_REVIEW_LIFT: ReviewLift = { all: NO_REVIEWS, byTier: { Small: NO_REVIEWS, Medium: NO_REVIEWS, Large: NO_REVIEWS, unknown: NO_REVIEWS }, reviewerTurnsWithoutRequest: 0 };

function summary(overrides: Partial<InsightsSummary> = {}): InsightsSummary {
  return {
    available: true,
    window: { key: "30d", since: "2026-08-28T09:00:00.000Z", until: null },
    requests: { inWindow: 4, finished: 3 },
    requestsByDay: [
      { day: "2026-09-10", requests: 1 },
      { day: "2026-09-25", requests: 2 },
      { day: "2026-09-27", requests: 1 },
    ],
    questions: { asked: 4, reachedOwner: 1, answeredByAgents: 3, perFinishedRequest: { asked: 4 / 3, reachedOwner: 1 / 3, answeredByAgents: 1 } },
    ownerWait: { questions: 1, medianMs: 175_000, p90Ms: 175_000 },
    timeToFinished: { medianMs: 4_830_500, requests: 3 },
    tokens: {
      total: 3_300_000,
      byRole: roles(300_000, 2_700_000, 300_000),
      perFinishedRequest: { total: 1_100_000, byRole: roles(100_000, 900_000, 100_000) },
      medianPerFinishedRequest: 1_050_000,
      finishedRequestsWithMissingUsage: 0,
    },
    errors: { failedTurns: { total: 2, byRole: roles(0, 1, 1) }, cancelledTurns: { total: 1, byRole: roles(0, 1, 0) } },
    turnsByRole: roles(12, 8, 3),
    interventions: INTERVENTION_KINDS.map((kind) =>
      kind === "answer"
        ? { kind, recorded: 5, met: 3, missed: 1, unknown: 1, pending: 0, share: 0.75 }
        : kind === "stop"
          ? { kind, recorded: 1, met: 0, missed: 0, unknown: 0, pending: 1, share: null }
          : { kind, recorded: 0, met: 0, missed: 0, unknown: 0, pending: 0, share: null },
    ),
    unknowns: { malformedLines: 0, unreadableFiles: 0, turnsWithoutUsage: 0, requestsWithoutDuration: 0 },
    reviewLift: REVIEW_LIFT,
    ...overrides,
  };
}

const STRIP_SPREAD = { count: 4, median: 4_000_000, p75: 6_000_000, p80: 6_000_000, p90: 8_000_000, max: 9_000_000 };
const NO_SPREAD = { count: 0, median: null, p75: null, p80: null, p90: null, max: null };
const SPREAD_BY_ROLE = (all: typeof NO_SPREAD | typeof STRIP_SPREAD) => ({ all, byRole: { manager: NO_SPREAD, worker: NO_SPREAD, reviewer: NO_SPREAD, orchestrator: NO_SPREAD, unknown: NO_SPREAD } });
/** Context figures for the Metrics strip: 20M read over 4 requests. */
const CONTEXT_FOR_STRIP: NonNullable<InsightsSummary["context"]> = {
  turns: { withUsage: 23, byProvider: { claude: 23, codex: 0, opencode: 0, unknown: 0 }, repeated: 0, withToolCalls: 20 },
  tokensRead: {
    total: 20_000_000,
    byRole: roles(2_000_000, 17_000_000, 1_000_000),
    perTurn: SPREAD_BY_ROLE(NO_SPREAD),
    perRequest: SPREAD_BY_ROLE(STRIP_SPREAD),
    perAgent: SPREAD_BY_ROLE(NO_SPREAD),
    heaviestRequests: [],
  },
  contextEstimate: { reported: 23, estimated: 0, unknown: 0, perTurn: SPREAD_BY_ROLE(NO_SPREAD), shareOfWindow: NO_SPREAD },
  orchestrator: { wakes: 0, wakesWithUsage: 0, tokens: null, perFinishedRequest: null },
};
const EMPTY_ROLES = roles(0, 0, 0);
const nothing = summary({
  requests: { inWindow: 0, finished: 0 },
  requestsByDay: [],
  questions: { asked: 0, reachedOwner: 0, answeredByAgents: 0, perFinishedRequest: null },
  ownerWait: { questions: 0, medianMs: null, p90Ms: null },
  timeToFinished: { medianMs: null, requests: 0 },
  tokens: { total: 0, byRole: EMPTY_ROLES, perFinishedRequest: null, medianPerFinishedRequest: null, finishedRequestsWithMissingUsage: 0 },
  errors: { failedTurns: { total: 0, byRole: EMPTY_ROLES }, cancelledTurns: { total: 0, byRole: EMPTY_ROLES } },
  turnsByRole: EMPTY_ROLES,
  interventions: INTERVENTION_KINDS.map((kind) => ({ kind, recorded: 0, met: 0, missed: 0, unknown: 0, pending: 0, share: null })),
  reviewLift: NO_REVIEW_LIFT,
});

const STATS: BeadStats = {
  total: 3,
  open: 1,
  inProgress: 1,
  blocked: 0,
  closed: 1,
  ready: 1,
  readAt: "2026-09-27T08:00:00.000Z",
  source: "/work/app/.beads/issues.jsonl",
  skippedLines: 0,
  present: true,
};
const bead = (id: string, status: string, overrides: Partial<BeadRow> = {}): BeadRow => ({
  id,
  title: `Bead ${id}`,
  status,
  issueType: "task",
  priority: 1,
  labels: [],
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
  closedAt: status === "closed" ? "2026-09-22T10:00:00.000Z" : null,
  ready: status === "open",
  parentId: null,
  work: null,
  ...overrides,
});
const BEADS = [bead("bm-1", "open"), bead("bm-2", "in_progress"), bead("bm-3", "closed", { issueType: "bug" })];

const cell = (overrides: Partial<AgreementCell> & Pick<AgreementCell, "class" | "predictor">): AgreementCell => ({
  workspaceId: "wks_a",
  count: 0,
  agreed: 0,
  unread: 0,
  firstAt: null,
  lastAt: null,
  reversals: 0,
  reversalsByKind: { "re-asked": 0, overridden: 0, reopened: 0 },
  ...overrides,
});
/** One project's ledger, given in the ledger's own order, with another project's cell that must not show. */
const LEDGER: AgreementLedger = {
  cells: [
    cell({ class: "release", predictor: "recommended", count: 12, agreed: 12, firstAt: "2026-09-03T10:00:00.000Z", lastAt: "2026-09-26T16:00:00.000Z" }),
    cell({
      class: "scope",
      predictor: "recommended",
      count: 34,
      agreed: 31,
      firstAt: "2026-09-01T08:00:00.000Z",
      lastAt: "2026-09-28T23:30:00.000Z",
      reversals: 2,
      reversalsByKind: { "re-asked": 1, overridden: 0, reopened: 1 },
    }),
    cell({ class: "scope", predictor: "orchestrator", count: 16, agreed: 14, unread: 2, firstAt: "2026-09-10T09:00:00.000Z", lastAt: "2026-09-28T09:00:00.000Z" }),
    cell({ class: "reversible-technical", predictor: "recommended", count: 1, agreed: 1, firstAt: "2026-09-20T09:00:00.000Z", lastAt: "2026-09-20T11:00:00.000Z" }),
    cell({ workspaceId: "wks_b", class: "security", predictor: "recommended", count: 3, agreed: 1 }),
  ],
  delegated: [],
};
const POLICY: AutonomyPolicy = {
  projects: {
    wks_a: {
      scope: { mode: "shadow", at: "2026-09-02T00:00:00.000Z" },
      preference: { mode: "delegate", at: "2026-09-25T00:00:00.000Z" },
    },
  },
  challenger: { wks_a: true },
};
const autonomyOf = (overrides: Partial<Parameters<typeof autonomyFiguresView>[0]> = {}) =>
  autonomyFiguresView({ projectId: "wks_a", ledger: LEDGER, policy: POLICY, error: null, ...overrides });

describe("choices", () => {
  it("offers every window in the contract's order, 30 days first chosen", () => {
    expect(WINDOW_TABS.map((tab) => tab.key)).toEqual([...INSIGHTS_WINDOWS]);
    expect(WINDOW_TABS.map((tab) => tab.label)).toEqual(["7 days", "30 days", "90 days", "All time"]);
    expect(INSIGHTS_DEFAULT_WINDOW).toBe("30d");
  });

  it("lists every project first, then open workspaces, then closed ones with a name — never an id", () => {
    const projects = insightsProjects(
      [
        { id: "wks_a", screenTitle: "main · app" },
        { id: "wks_b", screenTitle: "docs · site" },
      ],
      [
        { workspaceId: "wks_a", lastKnownName: "main" },
        { workspaceId: "wks_c", lastKnownName: "old branch" },
        { workspaceId: "wks_d", lastKnownName: null },
      ],
    );
    expect(projects).toEqual([
      { id: "wks_a", label: "main · app" },
      { id: "wks_b", label: "docs · site" },
      { id: "wks_c", label: "old branch (closed)" },
    ]);
  });

  it("says what the figures cover", () => {
    expect(scopeLine("30d", null)).toBe("Last 30 days · all projects");
    expect(scopeLine("all", "main · app")).toBe("Everything recorded · main · app");
  });
});

describe("flow and cost figures", () => {
  it("formats a mean per request with one decimal, unknown as a dash", () => {
    expect(formatPerRequest(null)).toBe("—");
    expect(formatPerRequest(1)).toBe("1");
    expect(formatPerRequest(4 / 3)).toBe("1.3");
  });

  it("flow: requests, questions per request, your wait, time to finished, errors", () => {
    expect(flowCards(summary())).toEqual([
      { label: "Requests", value: "4", hint: "3 finished" },
      { label: "Questions per request", value: "1.3", hint: "0.3 reached you · 1 answered by agents" },
      { label: "Your wait", value: "2 min 55 s", hint: "median · p90 2 min 55 s · 1 question" },
      { label: "Time to finished", value: "1 h 20 min", hint: "median of 3 requests, your wait excluded" },
      { label: "Errors", value: "2", hint: "2 failed turns · 1 cancelled" },
    ]);
  });

  it("unknown is a dash, never zero", () => {
    const cards = flowCards(nothing);
    expect(cards.map((card) => card.value)).toEqual(["0", "—", "—", "—", "0"]);
    expect(cards[1]!.hint).toBe("no finished request");
    expect(cards[2]!.hint).toBe("no question waited on you");
    expect(costCards(nothing).map((card) => card.value)).toEqual(["—", "0"]);
  });

  it("cost: tokens per finished request with its median, and tokens by role with each share", () => {
    expect(costCards(summary())).toEqual([
      { label: "Tokens per request", value: "1.1M", hint: "median 1.1M" },
      { label: "Tokens", value: "3.3M", hint: "over 3 finished requests" },
    ]);
    expect(costCards(summary({ tokens: { ...summary().tokens, finishedRequestsWithMissingUsage: 1 } }))[0]!.hint).toBe("median 1.1M · 1 with usage missing");
    expect(tokensByRoleBars(summary().tokens)).toEqual([
      { label: "Manager", value: 100_000, display: "100k · 9 %" },
      { label: "Worker", value: 900_000, display: "900k · 82 %" },
      { label: "Reviewer", value: 100_000, display: "100k · 9 %" },
    ]);
    expect(tokensByRoleBars(nothing.tokens)).toEqual([]);
  });

  it("requests per day: the window's last days ending today, zeros drawn, at most 14", () => {
    const month = requestsPerDayBars(summary().requestsByDay, "30d", NOW);
    expect(month).toHaveLength(PER_DAY_MAX_BARS);
    expect(month[0]!.label).toBe("09-14");
    expect(month.at(-1)).toEqual({ label: "09-27", value: 1, display: "1" });
    expect(month.find((bar) => bar.label === "09-25")?.value).toBe(2);
    // 09-10 is outside the drawn days.
    expect(month.reduce((sum, bar) => sum + bar.value, 0)).toBe(3);
    const week = requestsPerDayBars(summary().requestsByDay, "7d", NOW);
    expect(week.map((bar) => bar.label)).toEqual(["09-21", "09-22", "09-23", "09-24", "09-25", "09-26", "09-27"]);
    expect(requestsPerDayBars([], "all", NOW)).toHaveLength(PER_DAY_MAX_BARS);
  });

  it("names what was not counted", () => {
    expect(unknownsLine(summary().unknowns)).toBeNull();
    expect(unknownsLine({ malformedLines: 2, unreadableFiles: 1, turnsWithoutUsage: 3, requestsWithoutDuration: 1 })).toBe(
      "Not counted: 2 unreadable lines · 1 unreadable file · 3 turns without usage · 1 finished request without a duration",
    );
  });

  it("the view: figures, an empty period, or a data folder that cannot be read", () => {
    const view = insightsView(summary(), NOW);
    expect(view.empty).toBeNull();
    expect(view.perDayTitle).toBe("Requests per day · last 14 days");
    expect(insightsView(nothing, NOW).empty).toBe(INSIGHTS_EMPTY);
    expect(insightsView({ ...nothing, available: false }, NOW).empty).toBe(INSIGHTS_UNAVAILABLE);
    // Turns without a request still mean something happened.
    expect(insightsView({ ...nothing, turnsByRole: roles(0, 0, 0, 2) }, NOW).empty).toBeNull();
  });
});

describe("coordination figures: A-12 per kind (autonomy design §G.3)", () => {
  it("one card per kind the Orchestrator used: the share met of those checked, then pending and unknown", () => {
    expect(coordinationCards(summary())).toEqual([
      { label: "Answers", value: "75 %", hint: "3 of 4 met · 1 unknown" },
      { label: "Stops", value: "—", hint: "none checked yet · 1 pending" },
    ]);
    expect(Object.keys(INTERVENTION_LABELS)).toEqual([...INTERVENTION_KINDS]);
  });

  it("the view carries them; a period without an intervention carries none", () => {
    expect(insightsView(summary(), NOW).coordination.map((card) => card.label)).toEqual(["Answers", "Stops"]);
    expect(insightsView(nothing, NOW).coordination).toEqual([]);
    expect(COORDINATION_NOTE).toBe(
      "How often the Orchestrator's interventions reached their expected outcome in time. The target is 80 % for each kind.",
    );
  });

  it("draws the Coordination section after Cost, or says there was no intervention", () => {
    const shown = texts(renderTree(InsightsFigures({ view: insightsView(summary(), NOW), styles })));
    const order = ["Cost", "Tokens per request by role", "Coordination", COORDINATION_NOTE, "Answers", "75 %", "3 of 4 met · 1 unknown", "Stops"];
    const positions = order.map((text) => shown.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(shown).not.toContain(COORDINATION_EMPTY);
    const quiet = texts(renderTree(InsightsFigures({ view: { ...insightsView(summary(), NOW), coordination: [] }, styles })));
    expect(quiet.slice(quiet.indexOf("Coordination"), quiet.indexOf("Coordination") + 3)).toEqual(["Coordination", COORDINATION_NOTE, COORDINATION_EMPTY]);
  });
});

describe("beads figures (moved from the Beads screen)", () => {
  it("asks for a project across all projects, waits, fails, or shows the project's overview", () => {
    expect(beadsFiguresView(ALL_PROJECTS, { beads: BEADS, stats: STATS }, null, NOW)).toEqual({ kind: "choose", text: BEADS_CHOOSE_PROJECT });
    expect(beadsFiguresView("wks_a", undefined, null, NOW)).toEqual({ kind: "loading" });
    expect(beadsFiguresView("wks_a", undefined, "E_BEADS_STORE_UNREADABLE", NOW)).toEqual({ kind: "error", text: "E_BEADS_STORE_UNREADABLE" });
    const view = beadsFiguresView("wks_a", { beads: BEADS, stats: STATS }, null, NOW);
    expect(view).toEqual({ kind: "figures", overview: beadsOverview(BEADS, STATS, NOW), done: { text: "✓ 1 / 3 done", label: "1 of 3 beads done, epics not counted" } });
  });

  it("draws status, progress, type, priority and time", () => {
    const view = beadsFiguresView("wks_a", { beads: BEADS, stats: STATS }, null, NOW);
    const shown = texts(renderTree(BeadsFigures({ view, styles, theme })));
    for (const text of ["Total", "Ready", "In progress", "Blocked", "Closed", "Progress", "By type", "By priority", "Median time to close", "Stale"]) {
      expect(shown).toContain(text);
    }
    expect(shown).toContain("33% done · 1/3 (epics not counted)");
    expect(texts(renderTree(BeadsFigures({ view: { kind: "choose", text: BEADS_CHOOSE_PROJECT }, styles, theme })))).toEqual([BEADS_CHOOSE_PROJECT]);
    expect(allNodes(renderTree(BeadsFigures({ view: { kind: "loading" }, styles, theme }))).map((node) => node.type)).toEqual(["ActivityIndicator"]);
  });
});

describe("autonomy by class: the agreement ledger (autonomy design §B.3; REQ-122 b)", () => {
  const figures = () => {
    const view = autonomyOf();
    if (view.kind !== "figures") throw new Error(`expected figures, got ${view.kind}`);
    return view;
  };
  const rowOf = (label: string) => figures().rows.find((row) => row.label === label)!;

  it("has a row per class with a figure or a mode above owner, riskiest first (the conflict order)", () => {
    expect(figures().rows.map((row) => row.label)).toEqual(["Release", "Scope", "Preference", "Reversible technical"]);
    expect(figures().quiet).toBe("No answer to compare yet: Security · Data · Cost · Dependency · Environment");
  });

  it("gives each predictor its agreement, count, span and reversals; the Orchestrator's column once it has a figure", () => {
    const [recommended, orchestrator] = rowOf("Scope").figures;
    expect(recommended).toMatchObject({
      predictor: "recommended",
      label: "Recommended option",
      agreement: "91 %",
      count: "matched 31 of 34 answers",
      span: "2026-09-01 → 2026-09-28",
      reversals: "2 reversed: 1 asked again · 1 reopened",
      reversalTone: "warning",
      unread: null,
    });
    expect(orchestrator).toMatchObject({
      predictor: "orchestrator",
      label: "Orchestrator",
      agreement: "88 %",
      count: "matched 14 of 16 answers",
      span: "2026-09-10 → 2026-09-28",
      reversals: "No reversal",
      reversalTone: "muted",
      unread: "2 answers given in a chat, not counted",
    });
    // One day is written once.
    expect(rowOf("Reversible technical").figures[0]).toMatchObject({ agreement: "100 %", count: "matched 1 of 1 answer", span: "2026-09-20" });
    // A project the Orchestrator never predicted has the recommended column only.
    const recommendedOnly = autonomyOf({ ledger: { ...LEDGER, cells: LEDGER.cells.filter((entry) => entry.predictor === "recommended") } });
    expect(recommendedOnly.kind === "figures" && recommendedOnly.rows.every((row) => row.figures.map((entry) => entry.predictor).join() === "recommended")).toBe(true);
  });

  it("shows each class's mode; no class is owner-only (ADR-025), and a delegated one is the Orchestrator's", () => {
    expect(figures().rows.map((row) => [row.label, row.modeText])).toEqual([
      ["Release", "Owner"],
      ["Scope", "Shadow"],
      ["Preference", "Delegated (Orchestrator)"],
      ["Reversible technical", "Owner"],
    ]);
    // A delegated class without an owner answer since has its row, with nothing to count.
    expect(rowOf("Preference").figures.map((entry) => [entry.agreement, entry.count])).toEqual([
      ["—", "No answer yet"],
      ["—", "No answer yet"],
    ]);
    expect(rowOf("Scope").accessibilityLabel).toBe(
      "Scope, Shadow. Recommended option: 91 % agreement, matched 31 of 34 answers, 2026-09-01 → 2026-09-28, 2 reversed: 1 asked again · 1 reopened. " +
        "Orchestrator: 88 % agreement, matched 14 of 16 answers, 2026-09-10 → 2026-09-28, No reversal, 2 answers given in a chat, not counted",
    );
  });

  it("asks for a project across all, waits for both reads, fails with the reason, or says a project has no data", () => {
    expect(autonomyOf({ projectId: ALL_PROJECTS })).toEqual({ kind: "choose", text: AUTONOMY_CHOOSE_PROJECT });
    expect(autonomyOf({ ledger: undefined })).toEqual({ kind: "loading" });
    expect(autonomyOf({ policy: undefined })).toEqual({ kind: "loading" });
    expect(autonomyOf({ error: "E_DECISION_WRITE_FAILED" })).toEqual({ kind: "error", text: "Could not read the autonomy figures. E_DECISION_WRITE_FAILED" });
    // Another project's cells never show, and a project with none and every class owner says so.
    expect(autonomyOf({ projectId: "wks_c", policy: EMPTY_AUTONOMY_POLICY })).toEqual({ kind: "empty", text: AUTONOMY_NO_DATA });
    const counted = cell({ class: "scope", predictor: "recommended", unread: 1 });
    const unreadOnly = autonomyOf({ ledger: { cells: [counted], delegated: [] }, policy: EMPTY_AUTONOMY_POLICY });
    expect(unreadOnly.kind === "figures" && unreadOnly.rows[0]!.figures[0]).toMatchObject({ agreement: "—", count: "No answer counted", span: null, reversals: "No reversal" });
  });

  it("says in one line that the period does not narrow it", () => {
    expect(AUTONOMY_NOTE).toContain("whatever the period above");
  });

  // The hook-free piece, at both widths.
  const draw = (compact: boolean) => renderTree(AutonomyFigures({ view: autonomyOf(), compact, styles, theme }));
  const directionOf = (tree: Array<RNode | string>) =>
    (allNodes(tree).filter((node) => node.type === "View" && node.props.accessibilityLabel !== undefined)[1]!.children[1] as RNode).props.style as { flexDirection: string };

  it("stacks a class's predictors on a phone, two short lines each", () => {
    const tree = draw(true);
    expect(directionOf(tree).flexDirection).toBe("column");
    const shown = texts(tree);
    const scope = shown.slice(shown.indexOf("Scope"));
    expect(scope.slice(0, 8)).toEqual([
      "Scope",
      "Shadow",
      "Recommended option · 91 %",
      "matched 31 of 34 answers · 2026-09-01 → 2026-09-28",
      "2 reversed: 1 asked again · 1 reopened",
      "Orchestrator · 88 %",
      "matched 14 of 16 answers · 2026-09-10 → 2026-09-28",
      "No reversal",
    ]);
  });

  it("puts a class's predictors side by side on a wide screen, the reversals in the warning colour", () => {
    const tree = draw(false);
    expect(directionOf(tree).flexDirection).toBe("row");
    const shown = texts(tree);
    const scope = shown.slice(shown.indexOf("Scope"));
    expect(scope.slice(0, 7)).toEqual(["Scope", "Shadow", "Recommended option", "91 %", "matched 31 of 34 answers", "2026-09-01 → 2026-09-28", "2 reversed: 1 asked again · 1 reopened"]);
    const reversed = allNodes(tree).find((node) => node.type === "Text" && texts([node])[0] === "2 reversed: 1 asked again · 1 reopened")!;
    expect(JSON.stringify(reversed.props.style)).toContain("#statusWarning");
    expect(shown.at(-1)).toBe("No answer to compare yet: Security · Data · Cost · Dependency · Environment");
  });

  it("labels every row, is read only — no Delegate? (ADR-025: autonomy is the project's level, set in Settings) —, and shows no id", () => {
    for (const compact of [true, false]) {
      const tree = draw(compact);
      const rows = allNodes(tree).filter((node) => node.type === "View" && typeof node.props.accessibilityLabel === "string");
      expect(rows).toHaveLength(4);
      expect(pressables(tree)).toEqual([]);
      expect(texts(tree).join("\n")).not.toMatch(/wks_|Delegate\?/);
    }
    for (const view of [autonomyOf({ projectId: ALL_PROJECTS }), autonomyOf({ projectId: "wks_c", policy: EMPTY_AUTONOMY_POLICY })]) {
      expect(texts(renderTree(AutonomyFigures({ view, compact: true, styles, theme })))).toEqual([view.kind === "choose" ? AUTONOMY_CHOOSE_PROJECT : AUTONOMY_NO_DATA]);
    }
    expect(allNodes(renderTree(AutonomyFigures({ view: { kind: "loading" }, compact: false, styles, theme }))).map((node) => node.type)).toEqual(["ActivityIndicator"]);
  });

  it("reads the policy through the query Settings writes", () => {
    expect(AUTONOMY_POLICY_KEY).toEqual(["paseo-bm", "autonomy", "policy"]);
  });
});

describe("autonomy by class is read only (ADR-025)", () => {
  it("offers no shortcut and no demotion line; the note sends the owner to the level in Settings", () => {
    const view = autonomyOf();
    expect(view.kind === "figures" && view.rows.every((row) => Object.keys(row).sort().join() === "accessibilityLabel,decisionClass,figures,label,modeText,modeTone")).toBe(true);
    expect(AUTONOMY_NOTE).toContain("The figures are for your information: the project's autonomy level is set in Settings → Autonomy.");
    expect(AUTONOMY_NOTE).not.toMatch(/Delegate\?|\d+ %/);
  });
});

/** The Metrics tab's view over `summary()` and `BEADS`, unless told otherwise. */
const metricsOf = (overrides: Partial<Parameters<typeof metricsView>[0]> = {}) =>
  metricsView({ summary: summary(), all: summary(), beads: BEADS, window: "30d", projects: [], now: NOW, ...overrides });

const metricsBody = (overrides: Record<string, unknown> = {}) =>
  renderTree(
    MetricsBody({
      view: metricsOf(),
      loading: false,
      error: null,
      beadsError: null,
      autonomy: { kind: "choose", text: AUTONOMY_CHOOSE_PROJECT },
      onRefresh: noop,
      styles,
      theme,
      ...overrides,
    }),
  );

describe("the Metrics tab: the model", () => {
  const beadAt = (id: string, created: string, closed: string | null, overrides: Partial<BeadRow> = {}) =>
    bead(id, closed === null ? "open" : "closed", { createdAt: created, closedAt: closed, ...overrides });

  it("names the periods short, mapped onto the server's windows", () => {
    expect(WINDOW_SEGMENTS.map((segment) => [segment.key, segment.label])).toEqual([
      ["7d", "7 d"],
      ["30d", "30 d"],
      ["90d", "90 d"],
      ["all", "All"],
    ]);
    expect(WINDOW_SEGMENTS.map((segment) => segment.accessibilityLabel)).toEqual(["Last 7 days", "Last 30 days", "Last 90 days", "Everything recorded"]);
  });

  it("takes the lead time of the work beads closed in the period: median, p90 and how many, epics left out", () => {
    const beads = [
      beadAt("a", "2026-09-26T09:00:00.000Z", "2026-09-26T09:18:00.000Z"),
      beadAt("b", "2026-09-26T09:00:00.000Z", "2026-09-26T10:00:00.000Z"),
      beadAt("c", "2026-09-26T09:00:00.000Z", "2026-09-26T09:10:00.000Z"),
      beadAt("e", "2026-09-01T09:00:00.000Z", "2026-09-26T09:00:00.000Z", { issueType: "epic" }),
      beadAt("old", "2026-08-01T09:00:00.000Z", "2026-08-02T09:00:00.000Z"),
      beadAt("open", "2026-09-26T09:00:00.000Z", null),
    ];
    expect(leadTimes(beads, "7d", NOW)).toEqual({ median: 18 * 60_000, p90: 60 * 60_000, count: 3 });
    expect(leadTimes(beads, "all", NOW).count).toBe(4);
    expect(leadTimes([], "30d", NOW)).toEqual({ median: null, p90: null, count: 0 });
  });

  it("counts the beads closed per local day in the period, only days with one, oldest first", () => {
    const local = (day: number, hour: number) => new Date(2026, 8, day, hour).toISOString();
    const beads = [
      beadAt("a", local(1, 8), local(17, 10)),
      beadAt("b", local(1, 8), local(26, 9)),
      beadAt("c", local(1, 8), local(26, 23)),
      beadAt("d", local(1, 8), null),
    ];
    expect(closedPerDay(beads, "30d", NOW)).toEqual([
      { key: "2026-09-17", label: "17 Sep", short: "17/9", value: 1 },
      { key: "2026-09-26", label: "26 Sep", short: "26/9", value: 2 },
    ]);
    expect(closedPerDay(beads, "7d", NOW).map((day) => day.label)).toEqual(["26 Sep"]);
    const many = Array.from({ length: 20 }, (_, index) => beadAt(`m${index}`, local(1, 8), new Date(2026, 8, 1 + index, 12).toISOString()));
    expect(closedPerDay(many, "all", NOW)).toHaveLength(CLOSED_PER_DAY_MAX);
  });

  it("splits the bead status bar into closed, deferred and open, and says how many open ones are ready", () => {
    const view = beadStatusBar([...BEADS, bead("bm-4", "deferred")]);
    expect(view.segments.map((segment) => [segment.label, segment.share])).toEqual([
      ["Closed 1", 0.25],
      ["Deferred 1", 0.25],
      ["Open 2 · 1 ready", 0.5],
    ]);
    expect(beadStatusBar([]).segments.every((segment) => segment.share === 0)).toBe(true);
  });

  it("counts beads per feature, most first, a bead with none left out", () => {
    const beads = [
      bead("a", "open", { labels: ["feature:site", "area:x"] }),
      bead("b", "open", { labels: ["feature:core"] }),
      bead("c", "closed", { labels: ["feature:core"] }),
      bead("d", "open"),
    ];
    expect(featureBars(beads).map((bar) => [bar.label, bar.display])).toEqual([
      ["core", "2"],
      ["site", "1"],
    ]);
  });

  it("has five figures: beads closed of all, lead time, requests, tokens per request, turns — a dash when unknown", () => {
    expect(metricsOf({ summary: summary({ context: CONTEXT_FOR_STRIP }) }).strip).toEqual([
      { label: "Beads closed", value: "1", unit: "/ 3", hint: null },
      { label: "Lead time · median", value: "2 d", unit: null, hint: "p90 2 d · 1 task" },
      { label: "Requests", value: "4", unit: null, hint: null },
      { label: "Tokens per request", value: "5.0M", unit: null, hint: "context read" },
      { label: "Turns", value: "23", unit: null, hint: "M 12 · W 8 · R 3" },
    ]);
    expect(metricsOf({ summary: undefined, beads: undefined }).strip.map((cell) => cell.value)).toEqual(["—", "—", "—", "—", "—"]);
  });

  it("tells how the work ran in this project beside all projects", () => {
    const rows = processRows(summary(), undefined);
    expect(rows.map((row) => [row.label, row.project, row.all])).toEqual([
      ["Questions reaching you per finished request", "0.3", "—"],
      ["Reviews per reviewed request", formatPerRequest(REVIEW_LIFT.all.reviewsPerRequest), "—"],
      ["Median time to finished", "1 h 20 min", "—"],
      ["Turns cut by Paseo · stalls", "1 · —", "—"],
      ["Your wait · median", "2 min 55 s", "—"],
      ["Failed turns", "2", "—"],
    ]);
  });

  it("orders tokens by role Worker first, leaves the Orchestrator out of Metrics, and says nothing for an older server", () => {
    const view = metricsOf({ summary: summary({ context: CONTEXT_FOR_STRIP }) });
    expect(view.roleTokens.map((row) => row.label)).toEqual(["Worker", "Manager", "Reviewer"]);
    expect(roleTokenRows(undefined)).toEqual([]);
  });
});

describe("the Metrics tab", () => {
  it("reads top to bottom as the artboard: the strip, bead status, closed per day, by feature, tokens by role, how the work ran; then what it showed before", () => {
    const shown = texts(metricsBody());
    expect(shown).not.toContain("Insights");
    const order = [
      "Beads closed",
      "Lead time · median",
      "Requests",
      "Tokens per request",
      "Turns",
      "Bead status",
      "Closed 1",
      "Closed per day",
      "22 Sep",
      "By feature",
      "Tokens by role",
      TOKENS_BY_ROLE_NOTE,
      "How the work ran",
      "Measure",
      "This project",
      "All projects",
      "Questions reaching you per finished request",
      "Orchestrator interventions",
      COORDINATION_NOTE,
      "Answers",
      AUTONOMY_TITLE,
      AUTONOMY_NOTE,
      AUTONOMY_CHOOSE_PROJECT,
      REVIEW_LIFT_TITLE,
      REVIEW_LIFT_NOTE,
      "Small",
      "Medium",
      "Refresh",
    ];
    const positions = order.map((text) => shown.indexOf(text));
    expect(positions.every((position) => position >= 0), order.filter((text) => !shown.includes(text)).join(" | ")).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("every pressable is a labelled button; Refresh reads again", () => {
    const onRefresh = vi.fn();
    const buttons = pressables(metricsBody({ onRefresh }));
    for (const button of buttons) {
      expect(button.props.accessibilityRole).toBe("button");
      expect(typeof button.props.accessibilityLabel).toBe("string");
    }
    (buttons.find((button) => button.props.accessibilityLabel === "Refresh the figures")!.props.onPress as () => void)();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows no id: projects by name only", () => {
    const shown = texts(metricsBody({ autonomy: autonomyOf() })).join("\n");
    expect(shown).not.toContain("wks_a");
  });

  it("while loading, a spinner; on a failed read, the reason in the danger colour", () => {
    const loading = allNodes(metricsBody({ view: metricsOf({ summary: undefined, beads: undefined }), loading: true }));
    expect(loading.some((node) => node.type === "ActivityIndicator")).toBe(true);
    const failed = allNodes(metricsBody({ view: metricsOf({ summary: undefined }), error: "E_DATA_HOME_UNAVAILABLE", beadsError: "boom" }));
    const line = failed.find((node) => node.type === "Text" && texts([node])[0] === "Could not read the figures. E_DATA_HOME_UNAVAILABLE");
    expect(line).toBeDefined();
    expect(JSON.stringify(line!.props.style)).toContain("#statusDanger");
    expect(texts(failed)).toContain("Could not read the beads. boom");
  });

  it("an empty period says so instead of drawing zeros", () => {
    const shown = texts(renderTree(InsightsFigures({ view: insightsView(nothing, NOW), styles })));
    expect(shown).toEqual([INSIGHTS_EMPTY]);
    expect(texts(metricsBody({ view: metricsOf({ summary: nothing }) }))).toContain(INSIGHTS_EMPTY);
  });

  it("has no placeholder left: autonomy is drawn from the ledger, review lift from the summary", () => {
    const shown = texts(metricsBody());
    expect(shown.find((text) => text.startsWith("Arrives with Phase"))).toBeUndefined();
  });

  it("draws the chosen project's autonomy at the width it is given", () => {
    const direction = (compact: boolean) => {
      const tree = metricsBody({ autonomy: autonomyOf(), compact });
      const row = allNodes(tree).find((node) => node.type === "View" && String(node.props.accessibilityLabel).startsWith("Scope, Shadow"))!;
      return ((row.children[1] as RNode).props.style as { flexDirection: string }).flexDirection;
    };
    expect(direction(true)).toBe("column");
    expect(direction(false)).toBe("row");
  });
});

describe("the Metrics tab on a phone (the MobileMetrics artboard)", () => {
  const phone = () => renderTree(MetricsBody({ view: metricsOf(), loading: false, error: null, beadsError: null, autonomy: { kind: "choose", text: AUTONOMY_CHOOSE_PROJECT }, onRefresh: noop, compact: true, styles, theme }));

  it("wraps the five figures two by two, Turns across the width, with an 11px label and a 22px value", () => {
    const tree = phone();
    const label = allNodes(tree).find((node) => node.type === "Text" && textOf(node) === "Beads closed")!;
    expect(label.props.style).toMatchObject({ fontSize: 11 });
    const value = allNodes(tree).find((node) => node.type === "Text" && textOf(node).startsWith("1") && (node.props.style as { fontSize?: number }).fontSize === 22);
    expect(value).toBeDefined();
    const cells = allNodes(tree).filter((node) => node.type === "View" && typeof node.props.accessibilityLabel === "string" && /^(Beads closed|Lead time · median|Requests|Tokens per request|Turns):/.test(node.props.accessibilityLabel as string));
    expect(cells.map((node) => (node.props.style as { minWidth?: unknown }).minWidth)).toEqual(["50%", "50%", "50%", "50%", "50%"]);
    // The fifth cell is alone on its row: flex 1 takes the full width.
    expect(cells[4]!.props.style).toMatchObject({ flex: 1, borderTopWidth: 1 });
  });

  it("writes the days short under bare bars, and how the work ran as rows with a legend", () => {
    const shown = texts(phone());
    expect(shown).toContain("22/9");
    expect(shown).not.toContain("22 Sep");
    expect(shown).not.toContain("Measure");
    expect(shown).toContain(PROCESS_LEGEND);
    expect(PROCESS_LEGEND).toBe("This project · all projects");
    const row = allNodes(phone()).find((node) => node.props.accessibilityLabel === "Median time to finished: 1 h 20 min in this project, 1 h 20 min in all projects")!;
    expect(texts([row])).toEqual(["Median time to finished", "1 h 20 min · 1 h 20 min", " · 1 h 20 min"]);
  });
});

describe("cost: tokens read per request and the heaviest requests (autonomy design §G.2)", () => {
  const spread = (count: number, median: number | null, p75: number | null, p90: number | null, max: number | null) => ({ count, median, p75, p80: p75, p90, max });
  const none = spread(0, null, null, null, null);
  const byRole = (all: ReturnType<typeof spread>) => ({ all, byRole: { manager: none, worker: none, reviewer: none, orchestrator: none, unknown: none } });
  const CONTEXT: NonNullable<InsightsSummary["context"]> = {
    turns: { withUsage: 80, byProvider: { claude: 68, codex: 10, opencode: 2, unknown: 0 }, repeated: 1, withToolCalls: 70 },
    tokensRead: {
      total: 60_000_000,
      byRole: roles(3_000_000, 55_000_000, 2_000_000),
      perTurn: byRole(spread(80, 400_000, 900_000, 2_000_000, 5_000_000)),
      perRequest: byRole(spread(12, 1_500_000, 4_000_000, 12_000_000, 21_000_000)),
      perAgent: byRole(none),
      heaviestRequests: [
        { workspaceId: "wks_a", tokensRead: 21_000_000, byRole: roles(500_000, 19_600_000, 900_000), turns: 48, finished: true },
        { workspaceId: "wks_gone", tokensRead: 12_000_000, byRole: roles(12_000_000, 0, 0), turns: 9, finished: false },
      ],
    },
    contextEstimate: { reported: 60, estimated: 15, unknown: 5, perTurn: byRole(none), shareOfWindow: none },
    orchestrator: { wakes: 0, wakesWithUsage: 0, tokens: null, perFinishedRequest: null },
  };
  const PROJECTS = [{ id: "wks_a", label: "main · app" }];
  const withContext = (context: InsightsSummary["context"] = CONTEXT) => summary({ context });

  it("shows the spread per request and the heaviest requests by project name, numbers only", () => {
    const view = requestTokensView(CONTEXT, PROJECTS)!;
    expect(view.empty).toBeNull();
    expect(view.distributionTitle).toBe("Tokens read per request · 12 requests");
    expect(view.distribution).toEqual([
      { label: "Median", value: 1_500_000, display: "1.5M" },
      { label: "p75", value: 4_000_000, display: "4.0M" },
      { label: "p90", value: 12_000_000, display: "12.0M" },
      { label: "Largest", value: 21_000_000, display: "21.0M" },
    ]);
    // What is drawn: everything but the list key.
    const drawn = view.heaviest.map((row) => ({ project: row.project, tokens: row.tokens, detail: row.detail, accessibilityLabel: row.accessibilityLabel }));
    expect(drawn).toEqual([
      { project: "main · app", tokens: "21.0M read", detail: "Worker 93 % · 48 turns · finished", accessibilityLabel: "main · app: 21.0M read, Worker 93 % · 48 turns · finished" },
      { project: UNNAMED_PROJECT, tokens: "12.0M read", detail: "Manager 100 % · 9 turns · not finished", accessibilityLabel: `${UNNAMED_PROJECT}: 12.0M read, Manager 100 % · 9 turns · not finished` },
    ]);
    expect(JSON.stringify(drawn)).not.toMatch(/wks_/);
  });

  it("labels the figures a lower bound when some turns count only their last model call", () => {
    expect(requestTokensView(CONTEXT, PROJECTS)!.notes).toEqual([
      "Codex and OpenCode report only the last model call of each turn (12 of 80 turns), so these figures are a lower bound.",
    ]);
    const claudeOnly = { ...CONTEXT, turns: { ...CONTEXT.turns, byProvider: { claude: 80, codex: 0, opencode: 0, unknown: 0 } } };
    expect(requestTokensView(claudeOnly, PROJECTS)!.notes).toEqual([]);
  });

  it("says a period without usage has none, and draws nothing for a server that sends no figures", () => {
    const empty = { ...CONTEXT, tokensRead: { ...CONTEXT.tokensRead, perRequest: byRole(none), heaviestRequests: [] } };
    expect(requestTokensView(empty, PROJECTS)).toMatchObject({ empty: REQUEST_TOKENS_EMPTY, distribution: [], heaviest: [] });
    expect(requestTokensView(undefined, PROJECTS)).toBeNull();
    expect(insightsView(summary(), NOW).requestTokens).toBeNull();
    // A percentile that cannot be had is left out.
    const one = { ...CONTEXT, tokensRead: { ...CONTEXT.tokensRead, perRequest: byRole(spread(1, 2_000_000, null, null, 2_000_000)) } };
    expect(requestTokensView(one, PROJECTS)!.distribution.map((bar) => bar.label)).toEqual(["Median", "Largest"]);
  });

  it("draws them under Cost, before Coordination, and nothing of them for an older server", () => {
    const shown = texts(renderTree(InsightsFigures({ view: insightsView(withContext(), NOW, PROJECTS), styles })));
    const order = ["Cost", "Tokens per request by role", "Tokens read per request · 12 requests", "Median", "1.5M", HEAVIEST_TITLE, "main · app", "Worker 93 % · 48 turns · finished", "21.0M read", UNNAMED_PROJECT, "Codex and OpenCode report only the last model call of each turn (12 of 80 turns), so these figures are a lower bound.", "Coordination"];
    const positions = order.map((text) => shown.indexOf(text));
    expect(positions.every((position) => position >= 0), shown.join(" | ")).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(shown.join("\n")).not.toMatch(/wks_/);
    const older = texts(renderTree(InsightsFigures({ view: insightsView(summary(), NOW, PROJECTS), styles })));
    expect(older).not.toContain(HEAVIEST_TITLE);
    const empty = { ...CONTEXT, tokensRead: { ...CONTEXT.tokensRead, perRequest: byRole(none), heaviestRequests: [] } };
    expect(texts(renderTree(InsightsFigures({ view: insightsView(withContext(empty), NOW, PROJECTS), styles })))).toContain(REQUEST_TOKENS_EMPTY);
  });

  it("puts a heavy request on two lines on a phone and one row on a wide screen, labelled for a screen reader", () => {
    const row = requestTokensView(CONTEXT, PROJECTS)!.heaviest[0]!;
    const drawn = (compact: boolean) => renderTree(HeavyRequestRow({ row, compact, styles }))[0] as RNode;
    expect((drawn(true).props.style as Record<string, unknown>).flexDirection).toBeUndefined();
    expect((drawn(false).props.style as Record<string, unknown>).flexDirection).toBe("row");
    for (const compact of [true, false]) {
      expect(drawn(compact).props.accessibilityLabel).toBe("main · app: 21.0M read, Worker 93 % · 48 turns · finished");
      expect(texts([drawn(compact)]).sort()).toEqual(["21.0M read", "Worker 93 % · 48 turns · finished", "main · app"].sort());
    }
    // The screen hands its width down: the heaviest requests stack on a phone.
    const direction = (compact: boolean) => {
      const tree = metricsBody({ view: metricsOf({ summary: withContext(), projects: PROJECTS }), compact });
      const heavy = allNodes(tree).find((node) => node.type === "View" && node.props.accessibilityLabel === row.accessibilityLabel)!;
      return (heavy.props.style as Record<string, unknown>).flexDirection;
    };
    expect(direction(true)).toBeUndefined();
    expect(direction(false)).toBe("row");
  });
});

describe("review lift (autonomy design §C.4)", () => {
  const figuresOf = () => {
    const view = reviewLiftView(REVIEW_LIFT);
    if (view === null || view.kind !== "figures") throw new Error(`expected figures, got ${view?.kind ?? "null"}`);
    return view;
  };
  const drawnFigures = (label: string) =>
    figuresOf()
      .rows.find((row) => row.label === label)!
      .figures.map((figure) => [figure.label, figure.value, figure.detail]);

  it("has a row per size with a reviewed request, in size order: four figures each", () => {
    expect(figuresOf().rows.map((row) => [row.label, row.count])).toEqual([
      ["Small", "3 requests reviewed"],
      ["Medium", "12 requests reviewed"],
      ["Size not reported", "1 request reviewed"],
    ]);
    expect(drawnFigures("Medium")).toEqual([
      ["Reviews per request", "2.3", "28 reviews in 14 batches"],
      ["Blocking findings per batch", "1.5", "20 findings over 13 batches"],
      ["Findings acted on", "75 %", "9 of 12 findings fixed on re-review · 5 batches reviewed once"],
      ["Tokens per review", "310k", "8.1M over 26 reviews"],
    ]);
    expect(drawnFigures("Small")).toEqual([
      ["Reviews per request", "1", "3 reviews in 3 batches"],
      ["Blocking findings per batch", "0", "0 findings over 3 batches"],
      ["Findings acted on", "—", "no batch reviewed again · 3 batches reviewed once"],
      ["Tokens per review", "150k", "450k over 3 reviews"],
    ]);
  });

  it("shows unknown as a dash, never zero, and names what was not counted", () => {
    expect(drawnFigures("Size not reported")).toEqual([
      ["Reviews per request", "2", "2 reviews in 0 batches"],
      ["Blocking findings per batch", "—", "no batch with a known count"],
      ["Findings acted on", "—", "no batch reviewed again"],
      ["Tokens per review", "—", "Reviewer usage unknown"],
    ]);
    expect(figuresOf().unknowns).toBe(
      "Not counted: 2 reviews without a batch · 1 batch with an unknown blocking count · 2 requests without Reviewer usage · 1 request whose Reviewer sent no review · 1 Reviewer turn without a request",
    );
    expect(figuresOf().rows[2]!.accessibilityLabel).toBe(
      "Size not reported, 1 request reviewed. Reviews per request 2, 2 reviews in 0 batches. Blocking findings per batch unknown, no batch with a known count. " +
        "Findings acted on unknown, no batch reviewed again. Tokens per review unknown, Reviewer usage unknown",
    );
  });

  it("says a period without a review has none, and draws nothing for a server that sends no review figures", () => {
    expect(reviewLiftView(NO_REVIEW_LIFT)).toEqual({ kind: "empty", text: REVIEW_LIFT_EMPTY });
    const unreviewed = { ...NO_REVIEW_LIFT, all: { ...NO_REVIEWS, unknown: { ...NO_REVIEWS.unknown, requestsWithoutReview: 2 } } };
    expect(reviewLiftView(unreviewed)).toEqual({ kind: "empty", text: `${REVIEW_LIFT_EMPTY} Not counted: 2 requests whose Reviewer sent no review` });
    expect(reviewLiftView(undefined)).toBeNull();
    expect(insightsView(summary(), NOW).reviewLift).toEqual(reviewLiftView(REVIEW_LIFT));
    expect(insightsView(summary({ reviewLift: undefined }), NOW).reviewLift).toBeNull();
  });

  it("draws the section after autonomy, its empty state, and nothing for an older server", () => {
    const draw = (view: ReturnType<typeof insightsView>) => texts(metricsBody({ view: { ...metricsOf(), insights: view } })).filter((text) => text !== "Refresh");
    const shown = draw(insightsView(summary(), NOW));
    const order = [AUTONOMY_TITLE, REVIEW_LIFT_TITLE, REVIEW_LIFT_NOTE, "Small", "3 requests reviewed", "Medium", "9 of 12 findings fixed on re-review · 5 batches reviewed once", "Size not reported"];
    const positions = order.map((text) => shown.indexOf(text));
    expect(positions.every((position) => position >= 0), shown.join(" | ")).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(shown.at(-1)).toBe(figuresOf().unknowns);
    expect(shown.join("\n")).not.toMatch(/wks_|req-|agent-/);
    const empty = draw(insightsView(nothing, NOW));
    expect(empty.slice(empty.indexOf(REVIEW_LIFT_TITLE))).toEqual([REVIEW_LIFT_TITLE, REVIEW_LIFT_NOTE, REVIEW_LIFT_EMPTY]);
    expect(draw(insightsView(summary({ reviewLift: undefined }), NOW))).not.toContain(REVIEW_LIFT_TITLE);
  });

  it("stacks a tier's figures on a phone and puts them side by side on a wide screen, labelled for a screen reader", () => {
    const view = reviewLiftView(REVIEW_LIFT)!;
    const tier = (compact: boolean) =>
      allNodes(renderTree(ReviewLiftFigures({ view, compact, styles, theme }))).find(
        (node) => node.type === "View" && String(node.props.accessibilityLabel).startsWith("Medium, 12 requests reviewed"),
      )!;
    const direction = (compact: boolean) => ((tier(compact).children[1] as RNode).props.style as { flexDirection: string }).flexDirection;
    expect(direction(true)).toBe("column");
    expect(direction(false)).toBe("row");
    expect(texts([tier(false)])).toEqual(
      expect.arrayContaining(["Medium", "12 requests reviewed", "Findings acted on", "75 %", "9 of 12 findings fixed on re-review · 5 batches reviewed once"]),
    );
    expect(texts([tier(true)])).toContain("Tokens per review · 310k");
    // Nothing to press: the figures only inform (the review budget is set in Settings).
    expect(pressables(renderTree(ReviewLiftFigures({ view, compact: false, styles, theme })))).toEqual([]);
  });
});
