import { describe, expect, it, vi } from "vitest";
import {
  ALL_PROJECTS,
  BEADS_CHOOSE_PROJECT,
  INSIGHTS_DEFAULT_WINDOW,
  INSIGHTS_EMPTY,
  INSIGHTS_UNAVAILABLE,
  PER_DAY_MAX_BARS,
  PHASE_PLACEHOLDERS,
  WINDOW_TABS,
  beadsFiguresView,
  costCards,
  flowCards,
  formatPerRequest,
  insightsProjects,
  insightsView,
  projectTabs,
  requestsPerDayBars,
  scopeLine,
  tokensByRoleBars,
  unknownsLine,
} from "../plugin/client/insights-model";
import { beadsOverview } from "../plugin/client/beads-model";
import { dashboardStyles } from "../plugin/client/dashboard-model";
import { INSIGHTS_WINDOWS, type BeadRow, type BeadStats, type InsightsSummary } from "../plugin/shared/contracts";
import { allNodes, pressables, renderTree, texts } from "./helpers/element-tree";

/**
 * Insights (experience concept §4.3, autonomy design §A.12): its model is
 * pure and tested here; its hook-free pieces (`InsightsBody`,
 * `InsightsFigures`, `BeadsFigures`, `PhasePlaceholders`) are expanded with
 * the element-tree helper. `react-native` and the SDK icon are named
 * stand-ins.
 */

vi.mock("react-native", () => {
  const make = (name: string) => Object.assign(() => null, { displayName: name, primitive: true });
  return {
    ActivityIndicator: make("ActivityIndicator"),
    Pressable: make("Pressable"),
    ScrollView: make("ScrollView"),
    Text: make("Text"),
    TextInput: make("TextInput"),
    View: make("View"),
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: Object.assign(() => null, { displayName: "Icon", primitive: true }) }));

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const insightsPath = "../plugin/client/insights.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { InsightsBody, InsightsFigures, BeadsFigures, PhasePlaceholders } = (await import(insightsPath)) as {
  InsightsBody: Component;
  InsightsFigures: Component;
  BeadsFigures: Component;
  PhasePlaceholders: Component;
};

const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const styles = dashboardStyles(theme as never, false);
const NOW = new Date("2026-09-27T09:00:00.000Z");
const noop = () => undefined;
const roles = (manager: number, worker: number, reviewer: number, orchestrator = 0, unknown = 0) => ({ manager, worker, reviewer, orchestrator, unknown });

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
    unknowns: { malformedLines: 0, unreadableFiles: 0, turnsWithoutUsage: 0, requestsWithoutDuration: 0 },
    ...overrides,
  };
}

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
    expect(projectTabs(projects).map((tab) => tab.label)).toEqual(["All projects", "main · app", "docs · site", "old branch (closed)"]);
    expect(projectTabs(projects)[0]!.key).toBe(ALL_PROJECTS);
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
      { label: "Your wait", value: "2m 55s", hint: "median · p90 2m 55s · 1 question" },
      { label: "Time to finished", value: "1h 20m", hint: "median of 3 requests, your wait excluded" },
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

describe("the screen", () => {
  const body = (overrides: Record<string, unknown> = {}) =>
    renderTree(
      InsightsBody({
        window: "30d",
        projectId: ALL_PROJECTS,
        projects: [{ id: "wks_a", label: "main · app" }],
        view: insightsView(summary(), NOW),
        loading: false,
        error: null,
        beads: { kind: "choose", text: BEADS_CHOOSE_PROJECT },
        onWindow: noop,
        onProject: noop,
        onRefresh: noop,
        styles,
        theme,
        ...overrides,
      }),
    );

  it("reads top to bottom: title, choices, scope, flow, cost, beads, then what later phases add", () => {
    const shown = texts(body());
    const order = ["Insights", "Last 30 days · all projects", "Flow", "Questions per request", "Requests per day · last 14 days", "Cost", "Tokens per request by role", "Beads", BEADS_CHOOSE_PROJECT, "Autonomy by class", "Review lift"];
    const positions = order.map((text) => shown.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("every pressable is a labelled button or tab; the window and project tabs call back with their key", () => {
    const onWindow = vi.fn();
    const onProject = vi.fn();
    const onRefresh = vi.fn();
    const nodes = body({ onWindow, onProject, onRefresh });
    const buttons = pressables(nodes);
    for (const button of buttons) {
      expect(["button", "tab"]).toContain(button.props.accessibilityRole);
      expect(typeof button.props.accessibilityLabel).toBe("string");
    }
    const byLabel = (label: string) => buttons.find((button) => button.props.accessibilityLabel === label)!;
    (byLabel("7 days").props.onPress as () => void)();
    (byLabel("main · app").props.onPress as () => void)();
    (byLabel("Refresh the figures").props.onPress as () => void)();
    expect(onWindow).toHaveBeenCalledWith("7d");
    expect(onProject).toHaveBeenCalledWith("wks_a");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(byLabel("30 days").props.accessibilityState).toEqual({ selected: true });
    expect(byLabel("All projects").props.accessibilityState).toEqual({ selected: true });
  });

  it("shows no id: projects by name only", () => {
    const shown = texts(body({ projectId: "wks_a", beads: { kind: "loading" } })).join("\n");
    expect(shown).toContain("Last 30 days · main · app");
    expect(shown).not.toContain("wks_a");
  });

  it("while loading, a spinner; on a failed read, the reason in the danger colour", () => {
    const loading = allNodes(body({ view: null, loading: true }));
    expect(loading.some((node) => node.type === "ActivityIndicator")).toBe(true);
    const failed = allNodes(body({ view: null, error: "E_DATA_HOME_UNAVAILABLE" }));
    const line = failed.find((node) => node.type === "Text" && texts([node])[0] === "Could not read the figures. E_DATA_HOME_UNAVAILABLE");
    expect(line).toBeDefined();
    expect(JSON.stringify(line!.props.style)).toContain("#statusDanger");
  });

  it("an empty period says so instead of drawing zeros", () => {
    const shown = texts(renderTree(InsightsFigures({ view: insightsView(nothing, NOW), styles })));
    expect(shown).toEqual([INSIGHTS_EMPTY]);
  });

  it("names the phase each placeholder arrives with", () => {
    const shown = texts(renderTree(PhasePlaceholders({ styles })));
    expect(PHASE_PLACEHOLDERS.map((placeholder) => placeholder.key)).toEqual(["autonomy", "review"]);
    expect(shown.find((text) => text.startsWith("Arrives with Phase 2"))).toBeDefined();
    expect(shown.find((text) => text.startsWith("Arrives with Phase 3"))).toBeDefined();
  });
});
