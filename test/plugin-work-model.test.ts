import { describe, expect, it, vi } from "vitest";
import type {
  AgentTokenFigures,
  InsightsSummary,
  OrchestratorProjectRow,
  ParsedReport,
  TraceDetail,
  TraceSummary,
  TraceVerification,
  Usage,
  WorkspaceOverview,
} from "../plugin/shared/contracts";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { localTimeText } from "../plugin/client/format";
import {
  ALL_REQUESTS_LABEL,
  ESTIMATE_NOTE,
  LOWER_BOUND_NOTE,
  OVERVIEW_NO_OPEN,
  OVERVIEW_NO_TOKENS,
  OVERVIEW_OPEN_MAX,
  OVERVIEW_OPEN_TITLE,
  OVERVIEW_TOKENS_TITLE,
  NO_AGENT_TOKENS_TEXT,
  NO_REQUEST_TOKENS_TEXT,
  PROJECT_TABS,
  TOKEN_FIGURES_TITLE,
  WORK_STAGES,
  agentNamer,
  agentTokenFigures,
  contextTrendView,
  evidenceLines,
  levelNameOf,
  projectOverviewView,
  projectStageFacts,
  requestCardView,
  requestStage,
  runtimeDetailLines,
  requestSummaries,
  requestTokenFigures,
  stageBar,
  timelineEvents,
  workRows,
  type RequestCardView,
  type StageBarView,
  type WorkRowView,
} from "../plugin/client/work-model";
import { makeDecision } from "./helpers/decisions";
import { allNodes, pressables, renderTree, textOf, texts, type RNode } from "./helpers/element-tree";

/**
 * Projects (change-014 outcome 5; experience concept §4.2, autonomy design §A.12): the model is pure and
 * tested here — stage derivation, the rows, the evidence lines and the typed
 * timeline — and the hook-free pieces of `work.tsx` are expanded with the
 * element-tree helper, at phone (`compact`) and desktop widths. `react-native`
 * and the SDK icon are named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const workPath = "../plugin/client/work.tsx";
const uiPath = "../plugin/client/ui.tsx";
const insightsPath = "../plugin/client/insights.tsx";
const treePath = "../plugin/client/tree.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { StageBarRow, WorkRowItem, WorkList, RequestCard, TimelineList, EvidenceList, ProjectHeader, ProjectOverviewBody, AgentMarks, TokenFigures, AgentTokensRow, ContextBars } = (await import(
  workPath
)) as Record<
  | "ProjectOverviewBody"
  | "StageBarRow"
  | "WorkRowItem"
  | "WorkList"
  | "RequestCard"
  | "TimelineList"
  | "EvidenceList"
  | "ProjectHeader"
  | "AgentMarks"
  | "TokenFigures"
  | "AgentTokensRow"
  | "ContextBars",
  Component
>;
const { BeadsFigures } = (await import(insightsPath)) as { BeadsFigures: Component };
const { AgentTreeView } = (await import(treePath)) as { AgentTreeView: Component };
const { WorkspaceScreenHeader } = (await import(uiPath)) as { WorkspaceScreenHeader: Component };

const styles = new Proxy({}, { get: (_target, key) => (key === "content" ? { padding: 12, gap: 8 } : { name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;

const NOW = new Date("2026-09-29T08:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 1_000,
  cachedInputTokens: 800_000,
  outputTokens: 1_000,
  costUsd: 1.05,
  costBasis: "estimated",
  model: "claude-opus-5",
  pricesUpdatedAt: "2026-06-24",
  ...overrides,
});

const counts = (created = 0, closed = 0): TraceSummary["beadCounts"] => ({
  created: { count: created, confidence: "exact" },
  updated: { count: 0, confidence: "exact" },
  closed: { count: closed, confidence: "exact" },
  ready: { count: 0, confidence: "exact" },
});

function summary(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    traceId: "tr-1",
    requestId: "req-1",
    requestedAt: at(180),
    excerpt: "Migrate fee list to the new repos",
    turn: null,
    state: "running",
    workerIds: ["wrk-aaaaaaaa1"],
    reviewerIds: [],
    reviewCalls: 0,
    guardrailReported: null,
    durationMs: null,
    usage: usage(),
    messageCount: 4,
    userMessageCount: 0,
    workerUsage: [],
    beadCounts: counts(),
    tier: null,
    linking: "exact",
    agentsMissing: [],
    workspaceState: "live",
    reassignedFrom: null,
    notices: [],
    ...overrides,
  };
}

function report(phase: ParsedReport["phase"], minutesAgo: number, overrides: Partial<ParsedReport> = {}): ParsedReport {
  return {
    agentId: "wrk-aaaaaaaa1",
    at: at(minutesAgo),
    requestId: "req-1",
    phase,
    tier: null,
    filesChanged: [],
    beadsCreated: [],
    beadsUpdated: [],
    beadsClosed: [],
    beadsReady: [],
    reviewFindingsOpen: null,
    buildAndTests: null,
    skillsUsed: [],
    blockers: null,
    guardrail: null,
    unparsedFields: [],
    incompleteFields: [],
    ...overrides,
  };
}

function detail(overrides: Partial<TraceDetail> = {}, base: Partial<TraceSummary> = {}): TraceDetail {
  return {
    ...summary(base),
    sent: {
      userRequest: { agentId: "mgr-1", at: at(180), text: "Migrate fee list to the new repos", truncated: false },
      workerInitialPrompts: [{ agentId: "wrk-aaaaaaaa1", at: at(178), text: "Please do it", truncated: false }],
      reviewRequests: [],
    },
    received: { reports: [], reviews: [], managerReplies: [] },
    timing: { totalMs: null, managerTurns: [], workers: [], reviewers: [], basis: "wall clock" },
    usageByAgent: [{ agentId: "mgr-1", role: "manager", usage: usage() }],
    beads: [],
    workflowSteps: [],
    subAgentTraces: [],
    userMessages: [],
    skills: [],
    ...overrides,
  };
}

const withReports = (reports: ParsedReport[], base: Partial<TraceSummary> = {}, extra: Partial<TraceDetail> = {}) =>
  detail({ received: { reports, reviews: [], managerReplies: [] }, ...extra }, base);

// ---------------------------------------------------------------------------

describe("the stage of a request (Received ▸ Plan ▸ Build ▸ Review ▸ Done)", () => {
  it("reads the Worker's reports: received and documents → Plan, beads and implementation → Build, finished → Done", () => {
    const stage = (phases: Array<ParsedReport["phase"]>) =>
      requestStage(summary(), withReports(phases.map((phase, index) => report(phase, 100 - index)))).stage;
    expect(stage([])).toBe("received");
    expect(stage(["received"])).toBe("plan");
    expect(stage(["received", "documents-done"])).toBe("plan");
    expect(stage(["received", "beads-done"])).toBe("build");
    expect(stage(["received", "beads-done", "bead-implemented"])).toBe("build");
    expect(stage(["received", "beads-done", "finished"])).toBe("done");
  });

  it("keeps the stage before a block, and says the request waits for the owner", () => {
    const facts = requestStage(summary(), withReports([report("received", 50), report("beads-done", 40), report("blocked", 30)]));
    expect(facts).toEqual({ stage: "build", waiting: true, ended: null });
    // The trace's own state says so too, before any report.
    expect(requestStage(summary({ state: "waiting_user" }), withReports([])).waiting).toBe(true);
  });

  it("is Review while a Reviewer runs, or a review was asked after the last report and has no verdict yet", () => {
    const running = withReports([report("bead-implemented", 30)], {}, {
      timing: { totalMs: null, managerTurns: [], workers: [], reviewers: [{ agentId: "rev-1", role: "reviewer", startedAt: at(20), lastActivityAt: at(1), ms: null, state: "running" }], basis: "b" },
    });
    expect(requestStage(summary(), running).stage).toBe("review");

    const asked = detail({
      sent: { userRequest: null, workerInitialPrompts: [], reviewRequests: [{ agentId: "rev-1", at: at(20), text: "review b1", truncated: false, batchId: "b1" }] },
      received: { reports: [report("bead-implemented", 30)], reviews: [], managerReplies: [] },
    });
    expect(requestStage(summary(), asked).stage).toBe("review");

    // A verdict after the request: the review is over, the Worker's stage holds again.
    const answered = { ...asked, received: { ...asked.received, reviews: [{ agentId: "rev-1", at: at(10), batchId: "b1", verdict: "pass", blockingCount: 0 }] } };
    expect(requestStage(summary(), answered).stage).toBe("build");
  });

  it("is Done once the request completed, and a finished request is neither waiting nor ended", () => {
    expect(requestStage(summary({ state: "completed" }), withReports([report("received", 10)])).stage).toBe("done");
    expect(requestStage(summary({ state: "waiting_user" }), withReports([report("finished", 5)]))).toEqual({ stage: "done", waiting: false, ended: null });
  });

  it("says a request ended without finishing", () => {
    expect(requestStage(summary({ state: "failed" }), withReports([report("beads-done", 5)]))).toEqual({ stage: "build", waiting: false, ended: "failed" });
    expect(requestStage(summary({ state: "stopped" }), null).ended).toBe("stopped");
  });

  it("does not draw what cannot be told: a report without a milestone is skipped, an unknown trace has no stage", () => {
    expect(requestStage(summary(), withReports([report("received", 20), report(null, 10)])).stage).toBe("plan");
    expect(requestStage(summary({ state: "unknown" }), withReports([report(null, 10)])).stage).toBeNull();
    expect(requestStage(summary({ state: "unknown" }), null).stage).toBeNull();
    expect(stageBar({ stage: null, waiting: false, ended: null })).toBeNull();
  });

  it("reads the list row alone before the detail comes: completed, beads, a size, or just received", () => {
    expect(requestStage(summary({ state: "completed" }), null).stage).toBe("done");
    expect(requestStage(summary({ beadCounts: counts(3, 0) }), null).stage).toBe("build");
    expect(requestStage(summary({ tier: "Medium" }), null).stage).toBe("plan");
    expect(requestStage(summary(), null).stage).toBe("received");
  });

  it("draws five steps: done before the current one, the rest to come, with its words for a screen reader", () => {
    const bar = stageBar({ stage: "build", waiting: false, ended: null })!;
    expect(WORK_STAGES.map((stage) => stage.label)).toEqual(["Received", "Plan", "Build", "Review", "Done"]);
    expect(bar.steps.map((step) => step.state)).toEqual(["done", "done", "current", "next", "next"]);
    expect(bar).toMatchObject({ current: "build", text: "Build · 3 of 5", note: null, tone: "info", accessibilityLabel: "Stage: Build, 3 of 5" });
    expect(stageBar({ stage: "plan", waiting: true, ended: null })).toMatchObject({ note: "Waiting for you", tone: "warning", accessibilityLabel: "Stage: Plan, 2 of 5. Waiting for you" });
    expect(stageBar({ stage: "build", waiting: false, ended: "failed" })).toMatchObject({ note: "Failed", tone: "danger" });
    expect(stageBar({ stage: "build", waiting: false, ended: "stopped" })).toMatchObject({ note: "Stopped", tone: "muted" });
    expect(stageBar({ stage: "done", waiting: false, ended: null })).toMatchObject({ tone: "success", text: "Done · 5 of 5" });
  });

  it("maps the coordinator's coarse stage for a row: a Worker at work reads as Build, waiting and idle have no step", () => {
    expect(projectStageFacts("received").stage).toBe("received");
    expect(projectStageFacts("implementing").stage).toBe("build");
    expect(projectStageFacts("reviewing").stage).toBe("review");
    expect(projectStageFacts("finished").stage).toBe("done");
    expect(projectStageFacts("waiting-user")).toEqual({ stage: null, waiting: true, ended: null });
    expect(projectStageFacts("idle").stage).toBeNull();
    expect(projectStageFacts(undefined).stage).toBeNull();
  });

  it("tells Plan from Build on a row from the Worker's last report, and keeps the reported stage while waiting", () => {
    expect(projectStageFacts("implementing", "documents-done").stage).toBe("plan");
    expect(projectStageFacts("received", "received").stage).toBe("plan");
    expect(projectStageFacts("implementing", "bead-implemented").stage).toBe("build");
    expect(projectStageFacts("implementing", null).stage).toBe("build");
    expect(projectStageFacts("waiting-user", "beads-done")).toEqual({ stage: "build", waiting: true, ended: null });
    expect(projectStageFacts("waiting-user", "finished")).toEqual({ stage: null, waiting: true, ended: null });
  });
});

// ---------------------------------------------------------------------------

function project(overrides: Partial<OrchestratorProjectRow> = {}): OrchestratorProjectRow {
  return {
    workspaceId: "ws-a",
    workspaceLabel: "xspace",
    managerId: "mgr-1",
    managerTitle: null,
    managerStatus: "idle",
    state: "running",
    lastActivityAt: at(2),
    requests: 1,
    stage: "implementing",
    agents: { manager: { id: "mgr-1", title: null, status: "idle" }, workers: [{ id: "wrk-1", title: null, status: "running" }], reviewers: [] },
    lastProgressAt: at(2),
    currentRequest: { requestId: "req-1", title: "Migrate fee list…" },
    lastAction: null,
    ...overrides,
  };
}

function overview(workspaceId: string, running: Partial<WorkspaceOverview["runningAgents"]> = {}, beads: WorkspaceOverview["beads"] = null): WorkspaceOverview {
  const runningAgents = { manager: 0, worker: 0, reviewer: 0, ...running };
  return { workspaceId, beads, runningWorkers: runningAgents.worker, runningAgents };
}

describe("the project rows", () => {
  const workspaces = [
    { id: "ws-a", label: "xspace-master-data", detail: "" },
    { id: "ws-b", label: "shop", detail: "shop-repo" },
    { id: "ws-c", label: "paseo-bm-site", detail: "" },
    { id: "ws-d", label: "notes", detail: "" },
  ];
  const rows = workRows({
    workspaces,
    projects: [
      project(),
      project({ workspaceId: "ws-b", stage: "waiting-user", state: "waiting-user", lastProgressAt: at(17), currentRequest: { requestId: "r", title: null } }),
      project({ workspaceId: "ws-c", stage: "finished", state: "idle", lastProgressAt: at(120), agents: { manager: null, workers: [], reviewers: [] }, managerId: null }),
    ],
    overview: new Map([
      ["ws-a", overview("ws-a", { worker: 1 }, { total: 5, inProgress: 2, blocked: 1, ready: 1 })],
      ["ws-c", overview("ws-c")],
    ]),
    now: NOW,
  });
  const byId = (id: string) => rows.find((row) => row.workspaceId === id)!;

  it("keeps the order of the workspace list: most recent activity first", () => {
    expect(rows.map((row) => row.workspaceId)).toEqual(["ws-a", "ws-b", "ws-c", "ws-d"]);
  });

  it("shows a working project's request, stage, agents, beads and when it moved", () => {
    expect(byId("ws-a")).toMatchObject({
      request: "Migrate fee list…",
      status: { text: "▸ Build", tone: "info" },
      time: "2 min ago",
      beads: "2 in progress · 1 blocked",
    });
    expect(byId("ws-a").agents).toEqual([
      { letter: "M", tone: "muted", label: "Manager idle" },
      { letter: "W", tone: "success", label: "Worker running" },
    ]);
    expect(byId("ws-a").accessibilityLabel).toBe(
      "xspace-master-data. Migrate fee list…. Stage: Build. Manager idle, Worker running. beads: 2 in progress · 1 blocked. moved 2 min ago. Open the project",
    );
  });

  it("says how long a project has waited for the owner", () => {
    expect(byId("ws-b")).toMatchObject({ request: "Untitled request", status: { text: "Waiting for you · 17 min", tone: "warning" } });
  });

  it("reads a finished project with nothing running as idle, with when it finished; an unknown one as idle", () => {
    expect(byId("ws-c")).toMatchObject({ request: null, status: { text: "idle · last finished 2 h ago", tone: "muted" }, time: null, agents: [] });
    expect(byId("ws-d")).toMatchObject({ request: null, status: { text: "idle", tone: "muted" }, agents: [], beads: null });
  });

  it("shows no stage before the coordinator's facts answered", () => {
    const before = workRows({ workspaces, projects: null, overview: new Map(), now: NOW });
    expect(before.every((row) => row.status.text === "idle" && row.request === null)).toBe(true);
  });

  it("never puts an id in what a row says", () => {
    for (const row of rows) {
      for (const text of [row.label, row.request, row.status.text, row.accessibilityLabel, ...row.agents.map((agent) => agent.label)]) {
        expect(text ?? "").not.toMatch(/mgr-1|wrk-1|ws-/);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("requests: one per trace, its turns merged", () => {
  it("merges the turns of one request and keeps the list's order", () => {
    const merged = requestSummaries([
      summary({ traceId: "tr-2", requestId: "req-2", turn: { index: 2, total: 2 }, state: "running", excerpt: "second question", usage: usage({ costUsd: 0.5 }), beadCounts: counts(0, 2) }),
      summary({ traceId: "tr-2", requestId: "req-2", turn: { index: 1, total: 2 }, state: "completed", excerpt: "first question", tier: "Medium", usage: usage({ costUsd: 1 }), beadCounts: counts(3, 1), reviewerIds: ["rev-1"] }),
      summary({ traceId: "tr-1" }),
    ]);
    expect(merged.map((entry) => entry.traceId)).toEqual(["tr-2", "tr-1"]);
    expect(merged[0]).toMatchObject({ excerpt: "first question", state: "running", tier: "Medium", turns: 2, reviewerIds: ["rev-1"] });
    expect(merged[0]!.usage).toMatchObject({ inputTokens: 2_000, costUsd: 1.5, costBasis: "estimated" });
    expect(merged[0]!.beadCounts.created.count).toBe(3);
    expect(merged[0]!.beadCounts.closed.count).toBe(3);
  });

  it("shows no money when one turn's cost is unknown", () => {
    const [entry] = requestSummaries([summary({ turn: { index: 1, total: 2 } }), summary({ turn: { index: 2, total: 2 }, usage: usage({ costUsd: null, costBasis: "unavailable" }) })]);
    expect(entry!.usage).toMatchObject({ costUsd: null, costBasis: "unavailable" });
  });

  it("names agents by role, numbered only when there are several, never by id", () => {
    const one = agentNamer({ workerIds: ["w1"], reviewerIds: ["r1", "r2"] }, [{ agentId: "m1", role: "manager" }]);
    expect([one("w1"), one("r1"), one("r2"), one("m1"), one("zz"), one(null)]).toEqual(["Worker", "Reviewer 1", "Reviewer 2", "the Manager", "an agent", "an agent"]);
  });
});

describe("evidence lines (from the reports)", () => {
  it("says the plan, what was closed with the checks the report named, the verdict, and the decisions still open", () => {
    const entry = requestSummaries([summary({ beadCounts: counts(5, 3) })])[0]!;
    const trace = detail({
      received: {
        reports: [report("bead-implemented", 20, { buildAndTests: "npm run verify: green" })],
        reviews: [{ agentId: "rev-1", at: at(10), batchId: "b1", verdict: "changes required", blockingCount: 1 }],
        managerReplies: [],
      },
    });
    const open = makeDecision({ id: "q:req-1:Q1", requestId: "req-1" });
    const other = makeDecision({ id: "q:req-9:Q1", requestId: "req-9" });
    expect(evidenceLines(entry, trace, [open, other])).toEqual([
      { key: "plan", mark: "✓", text: "plan: 5 beads", tone: "plain" },
      { key: "closed", mark: "✓", text: "3 closed · checks reported: npm run verify: green", tone: "plain" },
      { key: "review", mark: "!", text: "review: changes required · 1 blocking", tone: "warning" },
      { key: "decisions", mark: "◐", text: "1 decision open", tone: "warning" },
    ]);
  });

  it("leaves a line out when there is nothing to say", () => {
    expect(evidenceLines(requestSummaries([summary()])[0]!, null, [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the timeline of a request", () => {
  const question = makeDecision({ id: "q:req-1:Q1", requestId: "req-1", askedBy: { role: "worker", agentId: "wrk-aaaaaaaa1" }, askedAt: at(60) });
  const answered = (() => {
    const result = answerDecision(question, { via: "inbox", optionKey: "a", at: at(50) });
    if (!result.ok) throw new Error("answer refused");
    return { ...result.decision, delivery: { to: "wrk-aaaaaaaa1", kind: "answer-worker", at: at(50), outcome: "sent" } } as Decision;
  })();
  const trace = detail({
    sent: {
      userRequest: { agentId: "mgr-1", at: at(180), text: "Migrate fee list to the new repos", truncated: false },
      workerInitialPrompts: [{ agentId: "wrk-aaaaaaaa1", at: at(178), text: "go", truncated: false }],
      reviewRequests: [{ agentId: "rev-1", at: at(40), text: "review b1", truncated: false, batchId: "b1" }],
    },
    received: {
      reports: [
        report("received", 170, { tier: "Medium" }),
        report("beads-done", 150, { beadsCreated: ["bm-1", "bm-2"] }),
        report(null, 140),
        report("blocked", 61, { blockers: "push both backends?" }),
        report("bead-implemented", 45, { beadsClosed: ["bm-1"], buildAndTests: "npm test" }),
      ],
      reviews: [
        { agentId: "rev-1", at: at(30), batchId: "b1", verdict: "changes required", blockingCount: 1 },
        { agentId: "rev-1", at: at(29), batchId: "b1", verdict: null, blockingCount: null },
      ],
      managerReplies: [{ agentId: "mgr-1", at: "not a time", text: "Done.", truncated: false }],
    },
    reviewerIds: ["rev-1"],
    userMessages: [{ agentId: "wrk-aaaaaaaa1", at: at(55), text: "Use the contract only", truncated: false, origin: "user" }],
  });
  const events = timelineEvents(trace, [answered], NOW);

  it("puts the events newest first, typed", () => {
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["verdict", "Reviewer: changes required · 1 blocking"],
      ["review-asked", "A review was asked of Reviewer"],
      ["report", "Worker: 1 bead closed"],
      ["decision-answered", 'You chose "Push contract only" → Worker'],
      ["you-said", "You → Worker: Use the contract only"],
      ["decision-asked", "Worker asked: Push both backends to origin/dev?"],
      ["blocked", "Worker is blocked: push both backends?"],
      ["report", "Worker: plan ready · 2 beads"],
      ["report", "Worker took the request on · Medium"],
      ["handed-over", "The Manager handed it to Worker"],
      ["asked", "You asked: Migrate fee list to the new repos"],
    ]);
    const times = events.map((event) => Date.parse(event.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(events[0]!.time).toBe(localTimeText(new Date(at(30)), NOW));
  });

  it("draws no unknown step: a report without a milestone, a review without a verdict, an event without a readable time", () => {
    expect(events.some((event) => event.key === "report:2")).toBe(false);
    expect(events.some((event) => event.key === "verdict:1")).toBe(false);
    expect(events.some((event) => event.kind === "reply")).toBe(false);
  });

  it("tags a question with the effects it asks about, and an answer with its grant", () => {
    expect(events.find((event) => event.kind === "decision-asked")!.tag).toBe("push, publish");
    expect(events.find((event) => event.kind === "decision-answered")).toMatchObject({ tag: "grant: push, 1×", tone: "success" });
    expect(events.find((event) => event.kind === "report" && event.text.includes("closed"))!.tag).toBe("checks reported");
  });

  it("keeps the source order for events at the same time, newest source first", () => {
    const same = detail({
      sent: { userRequest: null, workerInitialPrompts: [], reviewRequests: [] },
      received: { reports: [report("received", 10), report("documents-done", 10)], reviews: [], managerReplies: [] },
    });
    expect(timelineEvents(same, [], NOW).map((event) => event.key)).toEqual(["report:1", "report:0"]);
  });

  it("names nobody by id, and only shows decisions of this request", () => {
    for (const event of events) expect(event.text).not.toMatch(/wrk-|rev-1|mgr-1|q:req/);
    const foreign = makeDecision({ id: "q:req-9:Q1", requestId: "req-9" });
    expect(timelineEvents(trace, [foreign], NOW).some((event) => event.kind === "decision-asked")).toBe(false);
  });

  it("says the policy decided a delegated question for the owner (autonomy design §B.5), never that the owner chose", () => {
    const scope = makeDecision({
      id: "q:req-1:Q2",
      requestId: "req-1",
      class: "scope",
      askedAt: at(60),
      options: [{ key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] }, { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] }],
    });
    const result = answerDecision(scope, { by: "policy", via: "inbox", optionKey: "a", class: "scope", at: at(59) });
    if (!result.ok) throw new Error(result.message);
    const decided = { ...result.decision, delivery: { to: "wrk-aaaaaaaa1", kind: "answers:req-1", at: at(59), outcome: "sent" } } as Decision;
    const event = timelineEvents(trace, [decided], NOW).find((entry) => entry.kind === "decision-answered")!;
    expect(event).toMatchObject({ text: 'Decided for you by the Orchestrator: "dd/mm/yyyy" → Worker', tag: null, tone: "success" });
    expect(event.text).not.toContain("You");
  });

  it("shows a held permission request: held by paseo-bm, then allowed in Paseo's prompt or withdrawn (autonomy design §D.2)", () => {
    const heldOpen = makeDecision({
      id: "h:wrk-aaaaaaaa1:perm-1",
      requestId: "req-1",
      askedBy: { role: "plugin", agentId: "wrk-aaaaaaaa1" },
      askedAt: at(60),
      round: null,
      question: "The Worker asks to run `git push`. Held: git push. Allow it once?",
      options: [
        { key: "allow", label: "Allow once", recommended: false, effects: ["push"], action: { kind: "permission", agentId: "wrk-aaaaaaaa1", requestId: "perm-1", allow: true } },
        { key: "deny", label: "Deny", recommended: false, effects: ["none"], action: { kind: "permission", agentId: "wrk-aaaaaaaa1", requestId: "perm-1", allow: false } },
      ],
    });
    const asked = timelineEvents(trace, [heldOpen], NOW).find((entry) => entry.kind === "decision-asked")!;
    expect(asked.text).toBe("paseo-bm held a request of Worker: The Worker asks to run `git push`. Held: git push. Allow it once?");
    const allowed = answerDecision(heldOpen, { via: "paseo", optionKey: "allow", at: at(59) });
    if (!allowed.ok) throw new Error(allowed.message);
    expect(timelineEvents(trace, [allowed.decision], NOW).find((entry) => entry.kind === "decision-answered")!.text).toBe(`You chose "Allow once" in Paseo's own prompt`);
    const withdrawn = { ...heldOpen, status: "withdrawn", settledAt: at(59) } as Decision;
    expect(timelineEvents(trace, [withdrawn], NOW).find((entry) => entry.kind === "decision-closed")!.text).toBe("The held request was answered elsewhere, or its agent moved on");
  });

  it("shows a handoff: the successor's first message holds its brief, and the request keeps its id (autonomy design §G.6)", () => {
    const brief = "Handoff h1: the Orchestrator hands request req-1 over.\n\nBM-HANDOFF-BRIEF h1\nrole: worker\nrequestId: req-1\nreplaces: wrk-aaaaaaaa1\nrequest: Migrate fee list";
    const handedOver = detail(
      {
        sent: {
          userRequest: null,
          workerInitialPrompts: [
            { agentId: "wrk-aaaaaaaa1", at: at(178), text: "go", truncated: false },
            { agentId: "wrk-bbbbbbbb2", at: at(60), text: brief, truncated: false },
          ],
          reviewRequests: [],
        },
      },
      { workerIds: ["wrk-aaaaaaaa1", "wrk-bbbbbbbb2"] },
    );
    const events = timelineEvents(handedOver, [], NOW);
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["handoff", "Handed over to Worker 2 from Worker 1, with a brief of the records"],
      ["handed-over", "The Manager handed it to Worker 1"],
    ]);
    expect(events[0]).toMatchObject({ key: "handoff:1", tag: "handoff", tone: "info" });
    for (const event of events) expect(event.text).not.toMatch(/wrk-/);
  });

  it("shows a handoff the server names by the successor's label even when the Manager dropped the brief's marker line (Phase 3 live check F2)", () => {
    const withoutMarker = "role: worker\nrequestId: req-1\nrequest: Migrate fee list";
    const handedOver = detail(
      {
        sent: {
          userRequest: null,
          workerInitialPrompts: [
            { agentId: "wrk-aaaaaaaa1", at: at(178), text: "go", truncated: false },
            { agentId: "wrk-bbbbbbbb2", at: at(60), text: withoutMarker, truncated: false },
            // A later turn's first message of the same successor is not a second handoff.
            { agentId: "wrk-bbbbbbbb2", at: at(30), text: "Continue req-1.", truncated: false },
          ],
          reviewRequests: [],
        },
        handoffs: [{ agentId: "wrk-bbbbbbbb2", from: "wrk-aaaaaaaa1" }],
      },
      { workerIds: ["wrk-aaaaaaaa1", "wrk-bbbbbbbb2"] },
    );
    expect(timelineEvents(handedOver, [], NOW).map((event) => [event.kind, event.text])).toEqual([
      ["handed-over", "The Manager handed it to Worker 2"],
      ["handoff", "Handed over to Worker 2 from Worker 1, with a brief of the records"],
      ["handed-over", "The Manager handed it to Worker 1"],
    ]);
  });

  it("says a closed question without an answer was closed", () => {
    const withdrawn = { ...question, status: "withdrawn", settledAt: at(5) } as Decision;
    expect(timelineEvents(trace, [withdrawn], NOW).find((event) => event.kind === "decision-closed")).toMatchObject({ text: "The question was withdrawn", tone: "muted" });
    // A Worker's question expires when its request finishes (bead 81y2.26).
    const expired = { ...question, status: "expired", settledAt: at(5) } as Decision;
    expect(timelineEvents(trace, [expired], NOW).find((event) => event.kind === "decision-closed")).toMatchObject({ text: "The question expired when the request finished.", tone: "muted" });
  });
});

describe("a request card", () => {
  it("says who works on it, since when, its size and cost, with ids only in Details", () => {
    const entry = requestSummaries([summary({ tier: "Medium", workerIds: ["wrk-aaaaaaaa1"], reviewerIds: ["rev-1"] })])[0]!;
    const view = requestCardView(entry, null, [], NOW);
    expect(view.title).toBe("Migrate fee list to the new repos");
    expect(view.meta).toBe("Worker · started 3 h ago · Medium");
    expect(view.cost).toBe("Cost 802k tokens · $1.05 (estimated, prices of 2026-06-24)");
    expect(view.workerId).toBe("wrk-aaaaaaaa1");
    expect(view.live).toBe(true);
    expect(view.stage?.current).toBe("plan");
    expect(view.details).toEqual(["Request: req-1", "Trace: tr-1", "Worker: wrk-aaaaaaaa1", "Reviewer: rev-1"]);
    for (const text of [view.title, view.meta, view.cost, view.accessibilityLabel]) expect(text).not.toMatch(/wrk-|rev-1|tr-1|req-1/);
  });

  it("names under Details what each agent ran on and the tokens per model, once the detail was read (REQ-058)", () => {
    const entry = requestSummaries([summary({ workerIds: ["wrk-aaaaaaaa1"] })])[0]!;
    const read = detail({
      usageByAgent: [
        {
          agentId: "mgr-1",
          role: "manager",
          usage: usage(),
          runtime: [{ model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions", recorded: true, turns: 3 }],
        },
        {
          agentId: "wrk-aaaaaaaa1",
          role: "worker",
          usage: usage(),
          runtime: [
            { model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access", recorded: true, turns: 1 },
            { model: "gpt-5.5", thinkingOptionId: null, modeId: null, recorded: false, turns: 2 },
          ],
        },
      ],
      usageByModel: [
        { model: "claude-opus-5", usage: usage() },
        { model: null, usage: usage({ costUsd: null }) },
      ],
    });
    expect(runtimeDetailLines(read)).toEqual([
      "Manager mgr-1: claude-opus-5 · thinking provider default · mode bypassPermissions · 3 turns",
      "Worker wrk-aaaaaaaa1: gpt-5.6-sol · thinking high · mode full-access · 1 turn",
      "Worker wrk-aaaaaaaa1: gpt-5.5 · thinking and mode not recorded · 2 turns",
      "Tokens by model: claude-opus-5 802k tokens · $1.05 (estimated, prices of 2026-06-24) · unknown model 802k tokens",
    ]);
    expect(requestCardView(entry, read, [], NOW).details.slice(-4)).toEqual(runtimeDetailLines(read));
    // Nothing is guessed before the detail was read, nor for an agent without runtime rows.
    expect(runtimeDetailLines(null)).toEqual([]);
    expect(runtimeDetailLines(detail())).toEqual([]);
  });

  it("says a request no Worker took is the Manager's", () => {
    const entry = requestSummaries([summary({ workerIds: [], state: "completed", turn: { index: 1, total: 3 } })])[0]!;
    expect(requestCardView(entry, null, [], NOW)).toMatchObject({ meta: "Manager only · started 3 h ago · 3 turns", workerId: null, live: false });
  });
});

// ---------------------------------------------------------------------------
// The hook-free pieces, at phone and desktop widths.
// ---------------------------------------------------------------------------

const bar: StageBarView = stageBar({ stage: "build", waiting: true, ended: null })!;
const labelled = (nodes: Array<RNode | string>) => allNodes(nodes).filter((node) => node.props.accessibilityLabel !== undefined);

describe("the stage bar on screen", () => {
  it("is five segments with the stage written under them on a phone", () => {
    const tree = renderTree(StageBarRow({ bar, compact: true, styles, theme }));
    const root = tree[0] as RNode;
    expect(root.props).toMatchObject({ accessibilityRole: "progressbar", accessibilityLabel: "Stage: Build, 3 of 5. Waiting for you", accessibilityValue: { min: 1, max: 5, now: 3 } });
    const segments = allNodes(tree).filter((node) => node.type === "View" && (node.props.style as { height?: number } | undefined)?.height === 4);
    expect(segments.map((node) => (node.props.style as { backgroundColor: string }).backgroundColor)).toEqual([
      "#foregroundMuted",
      "#foregroundMuted",
      "#statusWarning",
      "#surface2",
      "#surface2",
    ]);
    expect(texts(tree)).toEqual(["Build · 3 of 5 · Waiting for you"]);
  });

  it("writes the five stages on a wide screen, the current one bold", () => {
    const tree = renderTree(StageBarRow({ bar, compact: false, styles, theme }));
    expect(texts(tree)).toEqual(["Received", "Plan", "Build", "Review", "Done", "Waiting for you"]);
    const build = allNodes(tree).find((node) => node.type === "Text" && textOf(node) === "Build")!;
    expect(JSON.stringify(build.props.style)).toContain('"fontWeight":"700"');
    const plan = allNodes(tree).find((node) => node.type === "Text" && textOf(node) === "Plan")!;
    expect(JSON.stringify(plan.props.style)).toContain('"fontWeight":"400"');
  });
});

describe("a project row on screen", () => {
  const row: WorkRowView = {
    workspaceId: "ws-a",
    label: "xspace",
    detail: "",
    request: "Migrate fee list…",
    status: { text: "▸ Build", tone: "info" },
    agents: [{ letter: "W", tone: "success", label: "Worker running" }],
    time: "2 min ago",
    beads: "2 in progress",
    level: "Cruise",
    accessibilityLabel: "xspace. Open the project",
  };

  it("is one pressable per row, labelled, on two lines on a phone and one on a wide screen", () => {
    const onOpen = vi.fn();
    for (const compact of [true, false]) {
      const tree = renderTree(WorkRowItem({ row, dot: "DOT", onOpen, compact, styles, theme }));
      const [press] = pressables(tree);
      expect(press!.props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "xspace. Open the project" });
      (press!.props.onPress as () => void)();
      expect(texts(tree)).toEqual(expect.arrayContaining(["xspace", "Migrate fee list…", "▸ Build", "W", "2 in progress", "Cruise", "2 min ago"]));
      expect(allNodes(tree).some((node) => node.children.includes("DOT"))).toBe(true);
      const lines = (press!.children as RNode[]).filter((child) => typeof child !== "string" && child.type === "View");
      expect(lines, String(compact)).toHaveLength(compact ? 2 : 1);
    }
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("colours the status and the agent letters only through toneColor", () => {
    const tree = renderTree(WorkRowItem({ row, dot: null, onOpen: noop, compact: false, styles, theme }));
    const stage = allNodes(tree).find((node) => node.type === "Text" && textOf(node) === "▸ Build")!;
    expect(JSON.stringify(stage.props.style)).toContain("#accent");
    const letter = allNodes(tree).find((node) => node.type === "Text" && textOf(node) === "W")!;
    expect(JSON.stringify(letter.props.style)).toContain("#statusSuccess");
    expect(renderTree(AgentMarks({ agents: [], styles, theme }))).toEqual([]);
  });

  it("lists the projects, then the closed workspaces with history, and says when there is none", () => {
    const onOpen = vi.fn();
    const tree = renderTree(
      WorkList({
        rows: [row],
        closed: [{ workspaceId: "ws-z", label: "old", detail: "archived" }],
        loading: false,
        error: null,
        status: "STATUS",
        footer: "paseo-bm 0.5.0",
        renderDot: (workspaceId: string) => `DOT ${workspaceId}`,
        onOpen,
        compact: false,
        styles,
        theme,
      }),
    );
    expect(texts(tree)).toEqual(expect.arrayContaining(["Closed workspaces with history", "old", "paseo-bm 0.5.0"]));
    // Each project row draws the dot `renderDot` gives for its workspace (the surface passes the running dot).
    const projectRow = pressables(tree).find((node) => JSON.stringify(node).includes(`DOT ${row.workspaceId}`));
    expect(projectRow?.props.accessibilityRole).toBe("button");
    expect(JSON.stringify(tree).match(/DOT /g)).toHaveLength(1);
    const closed = pressables(tree).find((node) => node.props.accessibilityLabel === "Open the requests of the closed workspace old")!;
    (closed.props.onPress as () => void)();
    expect(onOpen).toHaveBeenCalledWith("ws-z", "old");
    const empty = renderTree(WorkList({ rows: [], closed: [], loading: false, error: null, renderDot: () => null, onOpen, compact: true, styles, theme }));
    expect(texts(empty)).toEqual(["No workspaces on this host yet."]);
    const failed = renderTree(WorkList({ rows: [], closed: [], loading: false, error: "boom", renderDot: () => null, onOpen, compact: true, styles, theme }));
    expect(texts(failed)).toEqual(["Could not load the workspaces. boom"]);
  });
});

describe("a request card on screen", () => {
  const entry = requestSummaries([summary({ beadCounts: counts(5, 3) })])[0]!;
  const view: RequestCardView = requestCardView(entry, withReports([report("beads-done", 10)]), [], NOW);
  const events = timelineEvents(withReports([report("beads-done", 10)]), [], NOW);
  const card = (overrides: Record<string, unknown> = {}) =>
    renderTree(
      RequestCard({
        view,
        expanded: false,
        timeline: null,
        loading: false,
        error: null,
        detailsOpen: false,
        onToggle: noop,
        onToggleDetails: noop,
        compact: false,
        styles,
        theme,
        ...overrides,
      }),
    );

  it("shows the stage bar and the evidence lines, and the timeline only when opened", () => {
    const closed = card();
    expect(texts(closed)).toEqual(expect.arrayContaining(["Migrate fee list to the new repos", "Build", "✓ plan: 5 beads", "✓ 3 closed", "Timeline ▸", "Details ▸"]));
    expect(texts(closed).some((text) => text.includes("plan ready"))).toBe(false);
    const open = card({ expanded: true, timeline: events });
    expect(texts(open)).toEqual(expect.arrayContaining(["Timeline ▾", "Worker: plan ready", "You asked: Migrate fee list to the new repos"]));
    const reading = card({ expanded: true, timeline: null, loading: true });
    expect(allNodes(reading).some((node) => node.type === "ActivityIndicator")).toBe(true);
  });

  it("labels every pressable, offers Open Worker only on a host that can open agents, and shows ids only under Details", () => {
    for (const press of pressables(card())) expect(press.props.accessibilityLabel).toEqual(expect.any(String));
    expect(texts(card()).includes("Open Worker ▸")).toBe(false);
    const openAgent = vi.fn();
    const withOpen = card({ onOpenAgent: openAgent });
    const open = pressables(withOpen).find((node) => node.props.accessibilityLabel === "Open the Worker of this request")!;
    (open.props.onPress as () => void)();
    expect(openAgent).toHaveBeenCalledWith("wrk-aaaaaaaa1");
    expect(texts(card()).some((text) => text.includes("tr-1"))).toBe(false);
    expect(texts(card({ detailsOpen: true }))).toEqual(expect.arrayContaining(["Trace: tr-1", "Request: req-1"]));
  });

  it("draws the request's history actions under Details only, after the ids", () => {
    const all = (tree: Array<RNode | string>) => tree.map(textOf).join("\n");
    expect(all(card({ detailsExtra: "HISTORY ACTIONS" }))).not.toContain("HISTORY ACTIONS");
    const open = all(card({ detailsOpen: true, detailsExtra: "HISTORY ACTIONS" }));
    expect(open.indexOf("HISTORY ACTIONS")).toBeGreaterThan(open.indexOf("Trace: tr-1"));
  });

  it("puts a timeline event's time above its text on a phone, and in its own column on a wide screen", () => {
    const phone = renderTree(TimelineList({ events, compact: true, styles, theme }));
    const wide = renderTree(TimelineList({ events, compact: false, styles, theme }));
    const rowOf = (tree: Array<RNode | string>) => ((tree[0] as RNode).children[0] as RNode).props.style as Record<string, unknown>;
    expect(rowOf(phone).flexDirection).toBeUndefined();
    expect(rowOf(wide).flexDirection).toBe("row");
    expect(texts(renderTree(TimelineList({ events: [], compact: true, styles, theme })))).toEqual(["Nothing on record for this request yet."]);
  });

  it("stacks the evidence lines on a phone and puts them side by side on a wide screen", () => {
    const lines = view.evidence;
    const direction = (compact: boolean) => ((renderTree(EvidenceList({ lines, compact, styles, theme }))[0] as RNode).props.style as { flexDirection: string }).flexDirection;
    expect(direction(true)).toBe("column");
    expect(direction(false)).toBe("row");
    expect(renderTree(EvidenceList({ lines: [], compact: true, styles, theme }))).toEqual([]);
  });
});

describe("the project page's header", () => {
  it("has the five tabs, Overview · Requests · Beads · Metrics · Agents, and Chat only on a host that can open agents", () => {
    expect(PROJECT_TABS.map((tab) => tab.label)).toEqual(["Overview", "Requests", "Beads", "Metrics", "Agents"]);
    expect(PROJECT_TABS.map((tab) => tab.key)).toEqual(["overview", "requests", "beads", "metrics", "agents"]);
    const onTab = vi.fn();
    const onChat = vi.fn();
    const tree = renderTree(ProjectHeader({ label: "xspace", tab: "requests", onTab, onChat, chatBusy: false, styles }));
    expect(texts(tree)).toEqual(expect.arrayContaining(["xspace", "Chat ▸", "Overview", "Requests", "Beads", "Metrics", "Agents"]));
    const chat = pressables(tree).find((node) => node.props.accessibilityLabel === "Chat with the Beads Manager of xspace")!;
    (chat.props.onPress as () => void)();
    expect(onChat).toHaveBeenCalled();
    const beads = pressables(tree).find((node) => node.props.accessibilityRole === "tab" && textOf(node) === "Beads")!;
    (beads.props.onPress as () => void)();
    expect(onTab).toHaveBeenCalledWith("beads");
    const busy = renderTree(ProjectHeader({ label: "xspace", tab: "beads", onTab, onChat, chatBusy: true, styles }));
    expect(pressables(busy).find((node) => node.props.accessibilityLabel?.toString().startsWith("Chat"))!.props).toMatchObject({ disabled: true });
    const old = renderTree(ProjectHeader({ label: "xspace", tab: "agents", onTab, chatBusy: false, styles }));
    expect(texts(old).includes("Chat ▸")).toBe(false);
    expect(labelled(old).length).toBeGreaterThan(0);
    // In the workspace's own Beads tab: no title and no ←, the tabs as everywhere.
    const inTab = renderTree(ProjectHeader({ label: null, tab: "beads", onTab, chatBusy: false, styles }));
    expect(texts(inTab)).toEqual(["Overview", "Requests", "Beads", "Metrics", "Agents"]);
  });

  it("is the header the Beads board draws too, with the surface's status strip right under it (F3)", () => {
    const onBack = vi.fn();
    const page = renderTree(ProjectHeader({ label: "xspace", tab: "requests", onTab: noop, onBack, backLabel: "Back to Projects", status: "STATUS", chatBusy: false, styles }));
    const shared = renderTree(WorkspaceScreenHeader({ title: "xspace", onBack, backLabel: "Back to Projects", status: "STATUS", right: null, styles }));
    expect(shared.at(-1)).toBe("STATUS");
    expect(page.slice(0, shared.length)).toEqual(shared);
  });
});

describe("Beads and Agents under Projects", () => {
  it("draws the Beads overview figures only where the Metrics tab asks for them", () => {
    const overviewView = {
      status: [{ label: "Total", value: "5", hint: "all" }],
      progress: { closed: 1, total: 4, share: 0.25, label: "1 of 4 done" },
      byType: [],
      byPriority: [],
      timing: [{ label: "Oldest open", value: "3 d", hint: "" }],
    };
    const figures = { kind: "figures", overview: overviewView, done: { text: "✓ 1 / 4 done", label: "1 of 4 beads done" } };
    expect(texts(renderTree(BeadsFigures({ view: figures, styles, theme })))).toEqual(
      expect.arrayContaining(["Total", "Progress", "1 of 4 done", "By type", "By priority", "Oldest open"]),
    );
    // The Beads screen itself is the board first, with no overview figures (view-source.test.ts).
  });

  it("shows the agent tree without the role configuration, which Settings shows", () => {
    const tree = renderTree(
      AgentTreeView({ theme, compact: true, agents: { status: "success", data: [] }, openAgent: noop }),
    );
    expect(texts(tree)).toContain("Beads agents");
    expect(texts(tree)).not.toContain("Role configuration");
  });
});

// ---------------------------------------------------------------------------
// Tokens and context (autonomy design §G.2 Shown).
// ---------------------------------------------------------------------------

const figures = (overrides: Partial<AgentTokenFigures> & Pick<AgentTokenFigures, "agentId" | "role">): AgentTokenFigures => ({
  turns: 4,
  turnsWithUsage: 4,
  tokensRead: 400_000,
  lastCallTurns: 0,
  contextTrend: [20_000, 60_000, 100_000, 80_000],
  contextTurns: 4,
  contextEstimated: 0,
  contextPeak: 100_000,
  contextMax: 200_000,
  compactions: 0,
  ...overrides,
});

const REQUEST_AGENTS: AgentTokenFigures[] = [
  figures({ agentId: "mgr-1", role: "manager", tokensRead: 1_200_000 }),
  // Two Workers, the second first by turn: named in the request's order, as the ids in Details are.
  figures({ agentId: "wrk-bbbbbbbb2", role: "worker", tokensRead: 6_000_000, contextMax: null, contextEstimated: 4, compactions: 1 }),
  figures({ agentId: "wrk-aaaaaaaa1", role: "worker", tokensRead: 2_400_000, lastCallTurns: 3, contextEstimated: 1, contextTurns: 30 }),
  figures({ agentId: "rev-1", role: "reviewer", turns: 1, turnsWithUsage: 0, tokensRead: 0, contextTrend: [], contextTurns: 0, contextPeak: null, contextMax: null }),
];
const TWO_WORKERS = { workerIds: ["wrk-aaaaaaaa1", "wrk-bbbbbbbb2"], reviewerIds: ["rev-1"] };

describe("tokens and context: the model", () => {
  it("draws a context trend against the window, with its peak, or against its own largest point when no window was reported", () => {
    expect(contextTrendView(REQUEST_AGENTS[0]!)).toEqual({
      bars: [0.1, 0.3, 0.5, 0.4],
      text: "context 80k of 200k (40 %) · peak 100k",
      estimate: null,
      accessibilityLabel: "Context over 4 turns: 20k to 80k of 200k",
    });
    const noWindow = contextTrendView(REQUEST_AGENTS[1]!)!;
    expect(noWindow.bars).toEqual([0.2, 0.6, 1, 0.8]);
    expect(noWindow.text).toBe("context 80k · peak 100k");
    expect(contextTrendView(figures({ agentId: "a", role: "worker", contextTrend: [5_000, 9_000], contextPeak: 9_000 }))!.text).toBe("context 9.0k of 200k (5 %)");
    expect(contextTrendView(REQUEST_AGENTS[3]!)).toBeNull();
  });

  it("labels an estimate: every point, some of them, and says when the trend holds only the last turns", () => {
    expect(contextTrendView(REQUEST_AGENTS[1]!)!.estimate).toBe("estimate");
    const partly = contextTrendView(REQUEST_AGENTS[2]!)!;
    expect(partly.estimate).toBe("partly estimated");
    expect(partly.accessibilityLabel).toBe("Context over the last 4 turns: 20k to 80k of 200k, partly estimated");
  });

  it("gives a request's Details its tokens read by role and each agent, named by role, never by id", () => {
    const state = requestTokenFigures(TWO_WORKERS, REQUEST_AGENTS, null);
    if (state.kind !== "figures") throw new Error(`expected figures, got ${state.kind}`);
    const { view } = state;
    expect(view.byRole).toBe("Tokens read: Manager 1.2M · Worker 8.4M");
    expect(view.agents.map((row) => [row.name, row.tokens, row.note])).toEqual([
      ["Manager", "1.2M read · 4 turns", null],
      ["Worker 2", "6.0M read · 4 turns", "1 compaction"],
      ["Worker 1", "at least 2.4M read · 4 turns", null],
      ["Reviewer", "no usage recorded · 1 turn", null],
    ]);
    expect(view.agents[3]!.trend).toBeNull();
    expect(view.agents[3]!.accessibilityLabel).toBe("Reviewer. no usage recorded · 1 turn. context not known");
    expect(view.notes).toEqual([LOWER_BOUND_NOTE, ESTIMATE_NOTE]);
    // What is drawn (everything but the list key) names nobody by id.
    const drawn = view.agents.map((row) => [row.name, row.tokens, row.trend, row.note, row.accessibilityLabel]);
    expect(JSON.stringify(drawn)).not.toMatch(/mgr-1|wrk-|rev-1/);
    // Without a lower bound or an estimate, no note.
    const exact = requestTokenFigures(TWO_WORKERS, [REQUEST_AGENTS[0]!], null);
    expect(exact.kind === "figures" && exact.view.notes).toEqual([]);
  });

  it("waits, fails with the reason, or says a request has no turn yet", () => {
    expect(requestTokenFigures(TWO_WORKERS, undefined, null)).toEqual({ kind: "loading" });
    expect(requestTokenFigures(TWO_WORKERS, undefined, "E_TRACE_NOT_FOUND: gone")).toEqual({
      kind: "error",
      text: "Could not read the tokens and context. E_TRACE_NOT_FOUND: gone",
    });
    expect(requestTokenFigures(TWO_WORKERS, [], null)).toEqual({ kind: "empty", text: NO_REQUEST_TOKENS_TEXT });
    // No turn with usage: no line by role.
    const unused = requestTokenFigures(TWO_WORKERS, [REQUEST_AGENTS[3]!], null);
    expect(unused.kind === "figures" && unused.view.byRole).toBeNull();
  });

  it("gives the Agents tab each listed agent over its life, by role and title, and waits for both reads", () => {
    const listed = [
      { id: "mgr-1", title: "Beads Manager" },
      { id: "wrk-aaaaaaaa1", title: "Migrate fee list to the new repos" },
      { id: "rev-1", title: null },
    ];
    const state = agentTokenFigures(REQUEST_AGENTS, listed, null);
    if (state.kind !== "figures") throw new Error(`expected figures, got ${state.kind}`);
    expect(state.view.byRole).toBeNull();
    // An agent the tree no longer lists is left out.
    expect(state.view.agents.map((row) => row.name)).toEqual(["Manager · Beads Manager", "Worker · Migrate fee list to the new repos", "Reviewer"]);
    expect(state.view.notes).toEqual([LOWER_BOUND_NOTE, ESTIMATE_NOTE]);
    expect(agentTokenFigures(undefined, listed, null)).toEqual({ kind: "loading" });
    expect(agentTokenFigures(REQUEST_AGENTS, undefined, null)).toEqual({ kind: "loading" });
    expect(agentTokenFigures(undefined, listed, "boom")).toEqual({ kind: "error", text: "Could not read the tokens and context. boom" });
    expect(agentTokenFigures(REQUEST_AGENTS, [{ id: "other", title: "x" }], null)).toEqual({ kind: "empty", text: NO_AGENT_TOKENS_TEXT });
    expect(agentTokenFigures([], listed, null)).toEqual({ kind: "empty", text: NO_AGENT_TOKENS_TEXT });
  });
});

describe("tokens and context on screen", () => {
  const state = requestTokenFigures(TWO_WORKERS, REQUEST_AGENTS, null);
  const view = state.kind === "figures" ? state.view : null!;
  const draw = (compact: boolean, drawn = state) => renderTree(TokenFigures({ state: drawn, compact, styles, theme }));

  it("draws the title, the tokens by role, a row per agent and the notes, with the estimate beside its trend", () => {
    for (const compact of [true, false]) {
      const shown = texts(draw(compact));
      const order = [TOKEN_FIGURES_TITLE, "Tokens read: Manager 1.2M · Worker 8.4M", "Manager", "Worker 2", "estimate", "6.0M read · 4 turns · 1 compaction", "Worker 1", "partly estimated", "Reviewer", "context not known", LOWER_BOUND_NOTE, ESTIMATE_NOTE];
      const positions = order.map((text) => shown.indexOf(text));
      expect(positions.every((position) => position >= 0), `${compact}: ${shown.join(" | ")}`).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(shown.join("\n")).not.toMatch(/mgr-1|wrk-|rev-1/);
    }
    const header = allNodes(draw(true)).find((node) => node.type === "Text" && textOf(node) === TOKEN_FIGURES_TITLE)!;
    expect(header.props.accessibilityRole).toBe("header");
  });

  it("stacks an agent's name, trend and tokens on a phone, and puts them in one row on a wide screen", () => {
    const row = (compact: boolean) => renderTree(AgentTokensRow({ row: view.agents[1]!, compact, styles, theme }))[0] as RNode;
    expect((row(true).props.style as Record<string, unknown>).flexDirection).toBeUndefined();
    expect((row(false).props.style as Record<string, unknown>).flexDirection).toBe("row");
    for (const compact of [true, false]) {
      expect(row(compact).props.accessibilityLabel).toBe("Worker 2. 6.0M read · 4 turns. Context over 4 turns: 20k to 80k, estimate. 1 compaction");
      expect(texts([row(compact)])).toEqual(["Worker 2", "context 80k · peak 100k", "estimate", "6.0M read · 4 turns · 1 compaction"]);
    }
  });

  it("draws the trend as one bar per turn, as tall as its share, coloured through toneColor and described for a screen reader", () => {
    const trend = view.agents[0]!.trend!;
    for (const compact of [true, false]) {
      const [chart] = renderTree(ContextBars({ trend, compact, theme })) as RNode[];
      expect(chart!.props).toMatchObject({ accessibilityRole: "image", accessibilityLabel: "Context over 4 turns: 20k to 80k of 200k" });
      const bars = chart!.children as RNode[];
      expect(bars.map((bar) => (bar.props.style as { height: number }).height)).toEqual([2, 5, 9, 7]);
      expect(bars.every((bar) => (bar.props.style as { backgroundColor: string; width: number }).backgroundColor === "#accent")).toBe(true);
      expect((bars[0]!.props.style as { width: number }).width).toBe(compact ? 3 : 4);
    }
    const estimate = allNodes(draw(false)).find((node) => node.type === "Text" && textOf(node) === "estimate")!;
    expect(JSON.stringify(estimate.props.style)).toContain("#foregroundMuted");
  });

  it("says it is reading, why it failed, or that there is nothing yet", () => {
    expect(allNodes(draw(true, { kind: "loading" })).map((node) => node.type)).toContain("ActivityIndicator");
    const failed = allNodes(draw(false, { kind: "error", text: "Could not read the tokens and context. boom" }));
    const line = failed.find((node) => node.type === "Text" && textOf(node) === "Could not read the tokens and context. boom")!;
    expect(JSON.stringify(line.props.style)).toContain("#statusDanger");
    expect(texts(draw(true, { kind: "empty", text: NO_REQUEST_TOKENS_TEXT }))).toEqual([TOKEN_FIGURES_TITLE, NO_REQUEST_TOKENS_TEXT]);
  });

  it("opens a request's Details with its tokens and context, before the ids, and only while Details is open", () => {
    const entry = requestSummaries([summary()])[0]!;
    const card = (detailsOpen: boolean) =>
      texts(
        renderTree(
          RequestCard({
            view: requestCardView(entry, null, [], NOW),
            expanded: false,
            timeline: null,
            loading: false,
            error: null,
            detailsOpen,
            onToggle: noop,
            onToggleDetails: noop,
            tokens: state,
            compact: true,
            styles,
            theme,
          }),
        ),
      );
    expect(card(false)).not.toContain(TOKEN_FIGURES_TITLE);
    const open = card(true);
    expect(open.indexOf(TOKEN_FIGURES_TITLE)).toBeGreaterThan(-1);
    expect(open.indexOf(TOKEN_FIGURES_TITLE)).toBeLessThan(open.indexOf("Request: req-1"));
  });

  it("puts each agent's figures under the tree in the Agents tab, before any role configuration", () => {
    const tree = renderTree(
      AgentTreeView({
        theme,
        compact: false,
        agents: { status: "success", data: [] },
        roles: { status: "success", data: [] },
        openAgent: noop,
        children: TokenFigures({ state: { kind: "empty", text: NO_AGENT_TOKENS_TEXT }, compact: false, styles, theme }),
      }),
    );
    const shown = texts(tree);
    expect(shown.indexOf("Beads agents")).toBeLessThan(shown.indexOf(TOKEN_FIGURES_TITLE));
    expect(shown.indexOf(NO_AGENT_TOKENS_TEXT)).toBeLessThan(shown.indexOf("Role configuration"));
    // The Agents tab reads them with `traces.agents` and draws them in the tree (view-source.test.ts).
  });
});

// ---------------------------------------------------------------------------
// A finish, labelled (autonomy design §C.2, §C.3, §C.6; REQ-130; bead 7gxw.4).
// ---------------------------------------------------------------------------

describe("a finish, labelled: Done or Done — unverified, and each claim with its label", () => {
  const verification = (overrides: Partial<TraceVerification> = {}): TraceVerification => ({
    reportAt: at(5),
    checks: "self-reported",
    named: [
      { check: "npm test", label: "detected" },
      { check: "npm run lint", label: "self-reported" },
    ],
    files: [
      { path: "src/fees.ts", label: "detected" },
      { path: "src/repos.ts", label: "self-reported" },
    ],
    beads: [{ id: "bd-7", label: "detected" }],
    changedFiles: true,
    unverified: true,
    ...overrides,
  });
  const verified = verification({ checks: "detected", named: [{ check: "npm test", label: "detected" }], unverified: false });
  const finishedEntry = (finish?: TraceVerification, base: Partial<TraceSummary> = {}) =>
    requestSummaries([summary({ state: "completed", beadCounts: counts(0, 2), ...base, ...(finish === undefined ? {} : { verification: finish }) })])[0]!;
  const read = withReports([report("finished", 5, { buildAndTests: "`npm test` pass; `npm run lint` pass" })]);

  it("reads Done for a verified finish and Done — unverified, in the warning tone, for an unverified one", () => {
    expect(requestStage(finishedEntry(verified), read)).toEqual({ stage: "done", waiting: false, ended: null });
    expect(stageBar(requestStage(finishedEntry(verified), read))).toMatchObject({ text: "Done · 5 of 5", tone: "success", accessibilityLabel: "Stage: Done, 5 of 5" });

    const facts = requestStage(finishedEntry(verification()), read);
    expect(facts).toEqual({ stage: "done", waiting: false, ended: null, unverified: true });
    const unverified = stageBar(facts)!;
    expect(unverified).toMatchObject({ current: "done", text: "Done — unverified · 5 of 5", note: null, tone: "warning", accessibilityLabel: "Stage: Done — unverified, 5 of 5" });
    expect(unverified.steps.map((step) => step.label)).toEqual(["Received", "Plan", "Build", "Review", "Done — unverified"]);
    // From the row alone, before the detail is read, too.
    expect(requestStage(finishedEntry(verification()), null)).toMatchObject({ stage: "done", unverified: true });
  });

  it("reads Done as before for a request that is not checked, or whose finish the server does not send", () => {
    const notChecked = verification({ checks: "not-checked", unverified: false });
    expect(stageBar(requestStage(finishedEntry(notChecked), read))).toMatchObject({ text: "Done · 5 of 5", tone: "success" });
    expect(stageBar(requestStage(finishedEntry(), read))).toMatchObject({ text: "Done · 5 of 5", tone: "success" });
    // And the evidence line is the one of before: the closed count and the checks as reported.
    expect(evidenceLines(finishedEntry(notChecked), read, [])).toEqual([{ key: "closed", mark: "✓", text: "2 closed · checks reported: `npm test` pass; `npm run lint` pass", tone: "plain" }]);
    expect(requestCardView(finishedEntry(notChecked), read, [], NOW).details).not.toContain("Check: npm test — detected ✓");
  });

  it("names each check with its label, and counts the files changed and beads closed by theirs", () => {
    expect(evidenceLines(finishedEntry(verification()), read, [])).toEqual([
      { key: "checks", mark: "!", text: "checks: npm test — detected ✓ · npm run lint — self-reported", tone: "warning" },
      { key: "files", mark: "✓", text: "files: 2 changed · 1 detected, 1 self-reported", tone: "plain" },
      { key: "beads", mark: "✓", text: "beads: 1 closed · detected", tone: "plain" },
    ]);
    // Every check detected: a plain line; no bead claimed: the request's closed count stands in.
    expect(evidenceLines(finishedEntry({ ...verified, files: [{ path: "src/fees.ts", label: "self-reported" }], beads: [] }), read, [])).toEqual([
      { key: "checks", mark: "✓", text: "checks: npm test — detected ✓", tone: "plain" },
      { key: "files", mark: "✓", text: "files: 1 changed · self-reported", tone: "plain" },
      { key: "beads", mark: "✓", text: "beads: 2 closed", tone: "plain" },
    ]);
    // The report says nothing ran: each named check is unverified; none named at all says so.
    expect(evidenceLines(finishedEntry(verification({ checks: "unverified", named: [{ check: "npm test", label: "self-reported" }] })), read, [])[0]).toEqual({
      key: "checks",
      mark: "!",
      text: "checks: npm test — unverified",
      tone: "warning",
    });
    expect(evidenceLines(finishedEntry(verification({ checks: "unverified", named: [] })), read, [])[0]!.text).toBe("checks: unverified, none shown to run");
    // Many checks: three, then how many more; a long one is cut (Details has it whole).
    const many = verification({ named: ["a", "b", "c", "d", "e"].map((name) => ({ check: `npm run ${name}`, label: "detected" as const })) });
    expect(evidenceLines(finishedEntry(many), read, [])[0]!.text).toBe(
      "checks: npm run a — detected ✓ · npm run b — detected ✓ · npm run c — detected ✓ · +2 more",
    );
    const long = verification({ named: [{ check: `npm test -- ${"x".repeat(60)}`, label: "detected" }] });
    expect(evidenceLines(finishedEntry(long), read, [])[0]!.text.length).toBeLessThan(80);
  });

  it("keeps the finish when a request's turns are merged, and lists every check, file and bead under Details only", () => {
    const rows = [
      summary({ turn: { index: 1, total: 2 }, verification: verification() }),
      summary({ turn: { index: 2, total: 2 }, state: "completed", verification: verification() }),
    ];
    const entry = requestSummaries(rows)[0]!;
    expect(entry.verification).toEqual(verification());
    expect(requestSummaries([summary()])[0]).not.toHaveProperty("verification");
    const view = requestCardView(entry, read, [], NOW);
    expect(view.details.slice(-6)).toEqual([
      "Finished — unverified: code changed, and not every check the report names was seen to pass after the last edit.",
      "Check: npm test — detected ✓",
      "Check: npm run lint — self-reported",
      "File: src/fees.ts — detected",
      "File: src/repos.ts — self-reported",
      "Bead: bd-7 — detected",
    ]);
    for (const text of [view.title, view.meta, view.cost, view.accessibilityLabel, ...view.evidence.map((line) => line.text)]) {
      expect(text).not.toMatch(/src\/fees|bd-7/);
    }
    expect(view.accessibilityLabel).toContain("Stage: Done — unverified, 5 of 5");
  });

  it("draws Done — unverified in the warning colour, on a phone and on a wide screen", () => {
    const warned = stageBar(requestStage(finishedEntry(verification()), read))!;
    const phone = renderTree(StageBarRow({ bar: warned, compact: true, styles, theme }));
    expect(texts(phone)).toEqual(["Done — unverified · 5 of 5"]);
    const segments = allNodes(phone).filter((node) => node.type === "View" && (node.props.style as { height?: number } | undefined)?.height === 4);
    expect((segments.at(-1)!.props.style as { backgroundColor: string }).backgroundColor).toBe("#statusWarning");
    expect((phone[0] as RNode).props.accessibilityLabel).toBe("Stage: Done — unverified, 5 of 5");

    const wide = renderTree(StageBarRow({ bar: warned, compact: false, styles, theme }));
    expect(texts(wide)).toEqual(["Received", "Plan", "Build", "Review", "Done — unverified"]);
    const done = allNodes(wide).find((node) => node.type === "Text" && textOf(node) === "Done — unverified")!;
    expect(JSON.stringify(done.props.style)).toContain('"fontWeight":"700"');
    expect(JSON.stringify(done.props.style)).toContain("#statusWarning");

    const view = requestCardView(finishedEntry(verification()), read, [], NOW);
    for (const compact of [true, false]) {
      const card = renderTree(
        RequestCard({ view, expanded: false, timeline: null, loading: false, error: null, detailsOpen: false, onToggle: noop, onToggleDetails: noop, compact, styles, theme }),
      );
      expect(texts(card)).toEqual(expect.arrayContaining(["! checks: npm test — detected ✓ · npm run lint — self-reported", "✓ files: 2 changed · 1 detected, 1 self-reported", "✓ beads: 1 closed · detected"]));
      expect(texts(card).some((text) => text.includes("src/fees.ts"))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Projects (change-014 outcome 5): each row's level, and a project's Overview.
// ---------------------------------------------------------------------------

describe("a project's autonomy level by name (ADR-025)", () => {
  it("names the five levels and Custom, reads a project the policy does not name as Hands-on, and says nothing before the policy answered", () => {
    const levels = { "ws-0": 0, "ws-1": 1, "ws-2": 2, "ws-3": 3, "ws-4": 4, "ws-x": "custom" } as const;
    expect(["ws-0", "ws-1", "ws-2", "ws-3", "ws-4", "ws-x", "ws-new"].map((id) => levelNameOf(levels, id))).toEqual([
      "Hands-on",
      "Co-pilot",
      "Cruise",
      "Turbo",
      "Full auto",
      "Custom",
      "Hands-on",
    ]);
    expect(levelNameOf(undefined, "ws-0")).toBeNull();
  });

  it("puts the level on each project row and in its label once autonomy.policy answered", () => {
    const input = { workspaces: [{ id: "ws-a", label: "shop", detail: "" }], projects: null, overview: new Map(), now: NOW };
    expect(workRows(input)[0]!.level).toBeNull();
    const row = workRows({ ...input, levels: { "ws-a": 2 } })[0]!;
    expect(row.level).toBe("Cruise");
    expect(row.accessibilityLabel).toBe("shop. idle. autonomy: Cruise. Open the project");
  });
});

const ROLES = (manager: number, worker: number, reviewer: number, orchestrator = 0, unknown = 0) => ({ manager, worker, reviewer, orchestrator, unknown });

/** The parts of `insights.summary` the Overview reads. */
function overviewSummary(withContext = true): InsightsSummary {
  return {
    requests: { inWindow: 8, finished: 5 },
    turnsByRole: ROLES(160, 123, 30),
    ...(withContext ? { context: { tokensRead: { total: 578_800_000, byRole: ROLES(18_300_000, 554_300_000, 6_200_000) } } } : {}),
  } as unknown as InsightsSummary;
}

const openRequests = (states: Array<TraceSummary["state"]>) =>
  requestSummaries(states.map((state, index) => summary({ traceId: `tr-${index}`, requestId: `req-${index}`, state, excerpt: `Request ${index}`, tier: index === 0 ? "Large" : null })));

describe("a project's Overview: the model", () => {
  it("has four figures — requests in the window, turns by role, tokens read, waiting on you —, unknown as a dash", () => {
    const decisions = [makeDecision({ id: "q:1" }), makeDecision({ id: "q:2" }), makeDecision({ id: "q:3", status: "withdrawn" })];
    const view = projectOverviewView({ summary: overviewSummary(), window: "30d", requests: [], decisions, now: NOW });
    expect(view.figures).toEqual([
      { label: "Requests · 30 days", value: "8", hint: "5 finished" },
      { label: "Turns", value: "313", hint: "M 160 · W 123 · R 30" },
      { label: "Tokens read", value: "578.8M", hint: "context read per turn" },
      { label: "Waiting on you", value: "2", hint: "open decisions" },
    ]);
    const unread = projectOverviewView({ summary: undefined, window: "7d", requests: undefined, decisions: undefined, now: NOW });
    expect(unread.figures.map((figure) => [figure.label, figure.value])).toEqual([
      ["Requests · 7 days", "—"],
      ["Turns", "—"],
      ["Tokens read", "—"],
      ["Waiting on you", "—"],
    ]);
    expect([unread.requests, unread.tokensEmpty, unread.more]).toEqual([null, null, null]);
  });

  it("draws the tokens read by role with their share, roles with none left out; a server without context says so", () => {
    const view = projectOverviewView({ summary: overviewSummary(), window: "30d", requests: [], decisions: [], now: NOW });
    expect(view.tokensByRole.map((bar) => [bar.label, bar.display])).toEqual([
      ["Manager", "18.3M · 3 %"],
      ["Worker", "554.3M · 96 %"],
      ["Reviewer", "6.2M · 1 %"],
    ]);
    expect(view.tokensEmpty).toBeNull();
    const older = projectOverviewView({ summary: overviewSummary(false), window: "30d", requests: [], decisions: [], now: NOW });
    expect([older.tokensByRole, older.tokensEmpty, older.figures[2]!.value]).toEqual([[], OVERVIEW_NO_TOKENS, "—"]);
  });

  it("lists the newest open requests, at most a few, and counts the rest; finished ones are left to Requests", () => {
    const view = projectOverviewView({
      summary: overviewSummary(),
      window: "30d",
      requests: openRequests(["waiting_user", "running", "completed", "running", "running"]),
      decisions: [],
      now: NOW,
    });
    expect(OVERVIEW_OPEN_MAX).toBe(3);
    expect(view.requests!.map((row) => [row.title, row.state.text, row.state.tone])).toEqual([
      ["Request 0", "Needs you", "warning"],
      ["Request 1", "Running", "info"],
      ["Request 3", "Running", "info"],
    ]);
    expect(view.requests![0]!.meta).toBe("Large · started 3 h ago · 802k tokens");
    expect(view.more).toBe("1 more open request in Requests");
    expect(projectOverviewView({ summary: undefined, window: "30d", requests: openRequests(["completed"]), decisions: [], now: NOW }).requests).toEqual([]);
  });
});

describe("a project's Overview on screen", () => {
  const view = projectOverviewView({ summary: overviewSummary(), window: "30d", requests: openRequests(["waiting_user"]), decisions: [], now: NOW });

  it("leads with the autonomy level, which opens Settings, then the figures, the tokens by role and the open requests", () => {
    const onOpenSettings = vi.fn();
    const onRequests = vi.fn();
    const tree = renderTree(ProjectOverviewBody({ view, level: "Cruise", error: null, onOpenSettings, onRequests, compact: true, styles, theme }));
    const shown = texts(tree);
    const order = ["Autonomy: Cruise", "Requests · 30 days", "Turns", "Tokens read", "Waiting on you", OVERVIEW_TOKENS_TITLE, OVERVIEW_OPEN_TITLE, "Request 0", "Needs you", ALL_REQUESTS_LABEL];
    expect(order.map((text) => shown.indexOf(text))).toEqual([...order.map((text) => shown.indexOf(text))].sort((a, b) => a - b));
    expect(order.every((text) => shown.includes(text))).toBe(true);
    const press = (label: string) => (pressables(tree).find((node) => node.props.accessibilityLabel === label)!.props.onPress as () => void)();
    press("Autonomy: Cruise. Open Settings to change it");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    press("Open every request of this project");
    press(`${view.requests![0]!.accessibilityLabel}. Open in Requests`);
    expect(onRequests).toHaveBeenCalledTimes(2);
  });

  it("names the level without a button where Settings cannot be opened, and says when nothing is open", () => {
    const empty = projectOverviewView({ summary: overviewSummary(), window: "30d", requests: [], decisions: [], now: NOW });
    const tree = renderTree(ProjectOverviewBody({ view: empty, level: "Custom", error: "boom", onRequests: noop, compact: false, styles, theme }));
    expect(texts(tree)).toEqual(expect.arrayContaining(["Autonomy: Custom", "Could not read the figures. boom", OVERVIEW_NO_OPEN]));
    expect(pressables(tree).map((node) => node.props.accessibilityLabel)).toEqual(["Open every request of this project"]);
  });
});
