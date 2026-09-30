import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  OrchestratorProjectRow,
  ParsedReport,
  TraceDetail,
  TraceSummary,
  Usage,
  WorkspaceOverview,
} from "../plugin/shared/contracts";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { formatClock } from "../plugin/client/beads-model";
import {
  PROJECT_TABS,
  WORK_STAGES,
  agentNamer,
  evidenceLines,
  projectStageFacts,
  requestCardView,
  requestStage,
  runtimeDetailLines,
  requestSummaries,
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
 * Work (experience concept §4.2, autonomy design §A.12): the model is pure and
 * tested here — stage derivation, the rows, the evidence lines and the typed
 * timeline — and the hook-free pieces of `work.tsx` are expanded with the
 * element-tree helper, at phone (`compact`) and desktop widths. `react-native`
 * and the SDK icon are named stand-ins.
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

// The root tsconfig has no `jsx`, so the .tsx modules load through non-literal specifiers.
const workPath = "../plugin/client/work.tsx";
const beadsScreenPath = "../plugin/client/beads-screen.tsx";
const treePath = "../plugin/client/tree.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { StageBarRow, WorkRowItem, WorkList, RequestCard, TimelineList, EvidenceList, ProjectHeader, AgentMarks } = (await import(workPath)) as Record<
  "StageBarRow" | "WorkRowItem" | "WorkList" | "RequestCard" | "TimelineList" | "EvidenceList" | "ProjectHeader" | "AgentMarks",
  Component
>;
const { BeadsOverviewSection } = (await import(beadsScreenPath)) as { BeadsOverviewSection: Component };
const { AgentTreeView } = (await import(treePath)) as { AgentTreeView: Component };

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
    autopilot: false,
    stage: "implementing",
    agents: { manager: { id: "mgr-1", title: null, status: "idle" }, workers: [{ id: "wrk-1", title: null, status: "running" }], reviewers: [] },
    lastProgressAt: at(2),
    currentRequest: { requestId: "req-1", title: "Migrate fee list…" },
    lastAction: null,
    assessment: null,
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
  const events = timelineEvents(trace, [answered]);

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
    expect(events[0]!.time).toBe(formatClock(at(30)));
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
    expect(timelineEvents(same, []).map((event) => event.key)).toEqual(["report:1", "report:0"]);
  });

  it("names nobody by id, and only shows decisions of this request", () => {
    for (const event of events) expect(event.text).not.toMatch(/wrk-|rev-1|mgr-1|q:req/);
    const foreign = makeDecision({ id: "q:req-9:Q1", requestId: "req-9" });
    expect(timelineEvents(trace, [foreign]).some((event) => event.kind === "decision-asked")).toBe(false);
  });

  it("says a closed question without an answer was closed", () => {
    const withdrawn = { ...question, status: "withdrawn", settledAt: at(5) } as Decision;
    expect(timelineEvents(trace, [withdrawn]).find((event) => event.kind === "decision-closed")).toMatchObject({ text: "The question was withdrawn", tone: "muted" });
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
    accessibilityLabel: "xspace. Open the project",
  };

  it("is one pressable per row, labelled, on two lines on a phone and one on a wide screen", () => {
    const onOpen = vi.fn();
    for (const compact of [true, false]) {
      const tree = renderTree(WorkRowItem({ row, dot: "DOT", onOpen, compact, styles, theme }));
      const [press] = pressables(tree);
      expect(press!.props).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "xspace. Open the project" });
      (press!.props.onPress as () => void)();
      expect(texts(tree)).toEqual(expect.arrayContaining(["xspace", "Migrate fee list…", "▸ Build", "W", "2 in progress", "2 min ago"]));
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
        renderDot: () => null,
        onOpen,
        compact: false,
        styles,
        theme,
      }),
    );
    expect(texts(tree)).toEqual(expect.arrayContaining(["Closed workspaces with history", "old", "paseo-bm 0.5.0"]));
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
  const events = timelineEvents(withReports([report("beads-done", 10)]), []);
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

  it("offers deleting a request's history in its Details, and a closed workspace's history above its requests (autonomy design §A.12)", () => {
    const work = readFileSync(fileURLToPath(new URL(workPath, import.meta.url)), "utf8");
    // Per request: the same confirmed flow as before, scoped to the trace.
    expect(work).toMatch(/detailsExtra=\{\s*<TraceActions [^>]*scope="trace" traceId=\{traceId\}/);
    // A closed workspace: delete, or move onto a workspace that exists, behind the same confirmation.
    expect(work).toMatch(/closed === undefined \? null : \(\s*<ClosedHistory workspaceId=\{workspaceId\} state=\{closed\}/);
    expect(work).toMatch(/<TraceActions [^>]*scope="workspace" workspaceState=\{state\}/);
    // The surface hands the page a closed workspace's state, and offers no chat for it.
    const launcher = readFileSync(fileURLToPath(new URL("../plugin/client/launcher.tsx", import.meta.url)), "utf8");
    expect(launcher).toMatch(/closed=\{project\.closed\}/);
    expect(launcher).toMatch(/project\.closed !== undefined \? undefined/);
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
  it("has the three tabs, Requests · Beads · Agents, and Chat only on a host that can open agents", () => {
    expect(PROJECT_TABS.map((tab) => tab.label)).toEqual(["Requests", "Beads", "Agents"]);
    const onTab = vi.fn();
    const onChat = vi.fn();
    const tree = renderTree(ProjectHeader({ label: "xspace", tab: "requests", onTab, onChat, chatBusy: false, styles }));
    expect(texts(tree)).toEqual(expect.arrayContaining(["xspace", "Chat ▸", "Requests", "Beads", "Agents"]));
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
    expect(texts(inTab)).toEqual(["Requests", "Beads", "Agents"]);
  });
});

describe("Beads and Agents under Work", () => {
  it("draws the Beads overview figures only where Insights asks for them", () => {
    const overviewView = {
      status: [{ label: "Total", value: "5", hint: "all" }],
      progress: { closed: 1, total: 4, share: 0.25, label: "1 of 4 done" },
      byType: [],
      byPriority: [],
      timing: [{ label: "Oldest open", value: "3 d", hint: "" }],
    };
    expect(texts(renderTree(BeadsOverviewSection({ overview: overviewView, styles })))).toEqual(
      expect.arrayContaining(["Total", "Progress", "1 of 4 done", "By type", "By priority", "Oldest open"]),
    );
    // The Beads screen itself is the board first: no overview figures in it.
    const source = readFileSync(fileURLToPath(new URL(beadsScreenPath, import.meta.url)), "utf8");
    const screen = source.slice(source.indexOf("export function BeadsScreen("));
    expect(screen).not.toMatch(/<StatCards|<BarChart|<BeadsOverviewSection/);
    expect(screen.indexOf("<KanbanBoard")).toBeGreaterThan(0);
    expect(screen.indexOf("beads`}</Text>")).toBeLessThan(screen.indexOf("Filters and sort"));
  });

  it("shows the agent tree without the role configuration, which Settings shows", () => {
    const tree = renderTree(
      AgentTreeView({ theme, compact: true, agents: { status: "success", data: [] }, openAgent: noop }),
    );
    expect(texts(tree)).toContain("Beads agents");
    expect(texts(tree)).not.toContain("Role configuration");
  });
});
