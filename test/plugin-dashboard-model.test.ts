import { describe, expect, it, vi } from "vitest";
import {
  HOST_SCOPE_NOTICE,
  PRIVACY_NOTICE,
  STEP_LABELS,
  beadClaim,
  beadCountLine,
  confidenceSuffix,
  createConfirmationGate,
  dashboardStyles,
  describeAction,
  formatBytes,
  formatCost,
  formatDuration,
  formatElapsed,
  formatTokens,
  formatUsage,
  groupTraces,
  guardrailMismatch,
  linkingBadge,
  errorCard,
  errorTally,
  overviewCards,
  ROLE_MARK,
  requestGraph,
  requestsPerDay,
  turnLabel,
  heaviestWorkers,
  stepChip,
  STEP_LEGEND,
  barShare,
  reviewerLine,
  stateBadge,
  storageView,
  toneColor,
  tokensByModelRole,
  workspaceStateBadge,
} from "../plugin/client/dashboard-model";
import type {
  BeadStats,
  TraceDetail,
  TraceSummary,
  Usage,
  WorkflowStepResult,
} from "../plugin/shared/contracts";

/**
 * WP-211.1: the Dashboard's logic and wording, with no renderer.
 *
 * Most of these tests are about honesty of wording rather than layout: a
 * duration that is unknown must not read as zero, a bead claim must not read as
 * "none" unless it was reported as none, and a delete confirmation must say
 * what is lost.
 */

const theme = {
  colors: {
    surface0: "#000",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    foreground: "#fff",
    foregroundMuted: "#aaa",
    accent: "#00f",
    accentForeground: "#fff",
    statusSuccess: "#0f0",
    statusWarning: "#ff0",
    statusDanger: "#f00",
  },
} as const;

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  inputTokens: 12_345,
  cachedInputTokens: 2_000_000,
  outputTokens: 900,
  costUsd: 1.5,
  costBasis: "estimated",
  model: "claude-opus-5",
  pricesUpdatedAt: "2026-06-24",
  ...overrides,
});

const counts = (created: number, confidence: TraceSummary["beadCounts"]["created"]["confidence"]) => ({
  created: { count: created, confidence },
  updated: { count: 0, confidence },
  closed: { count: 0, confidence },
  ready: { count: 0, confidence },
});

const trace = (overrides: Partial<TraceSummary> = {}): TraceSummary => ({
  traceId: "req:req-A",
  requestId: "req-A",
  turn: null,
  requestedAt: "2026-09-16T10:00:00.000Z",
  excerpt: "thêm màn hình báo cáo",
  state: "completed",
  workerIds: ["w1"],
  reviewerIds: ["rev-1"],
  reviewCalls: 2,
  guardrailReported: null,
  durationMs: 600_000,
  usage: usage(),
  messageCount: 8,
  userMessageCount: 0,
  workerUsage: [{ agentId: "w1", title: null, usage: usage() }],
  beadCounts: counts(2, "exact"),
  tier: "Medium",
  linking: "exact",
  agentsMissing: [],
  workspaceState: "live",
  reassignedFrom: null,
  notices: [],
  ...overrides,
});

describe("formatting", () => {
  it("never reads an unknown duration as zero", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("0 ms");
  });

  it.each([
    [500, "500 ms"],
    [1_500, "2s"],
    [65_000, "1m 5s"],
    [120_000, "2m"],
    [3_600_000, "1h"],
    [7_830_000, "2h 10m"],
  ])("formats %i ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it("shows elapsed time for something still running", () => {
    const now = new Date("2026-09-16T10:05:00.000Z");
    expect(formatElapsed("2026-09-16T10:00:00.000Z", now)).toBe("5m so far");
    expect(formatElapsed(null, now)).toBe("—");
    expect(formatElapsed("not a date", now)).toBe("—");
  });

  it.each([
    [512, "512 B"],
    [2048, "2.0 KB"],
    [1024 * 1024 * 15, "15 MB"],
    [1024 * 1024 * 1024 * 3, "3.0 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([
    [900, "900"],
    [1200, "1.2k"],
    [45_000, "45k"],
    [9_500, "9.5k"],
    [2_000_000, "2.0M"],
  ])("formats %i tokens as %s", (tokens, expected) => {
    expect(formatTokens(tokens)).toBe(expected);
  });

  it("shows tokens split so a cache-heavy run is visible", () => {
    expect(formatUsage(usage())).toBe("12k in · 2.0M cached · 900 out");
  });
});

describe("cost wording (REQ-052)", () => {
  it("labels a provider figure as reported", () => {
    expect(formatCost(usage({ costBasis: "provider", costUsd: 2 }))).toBe("$2.00 (reported by the tool)");
  });

  it("labels an estimate with the price date", () => {
    expect(formatCost(usage())).toBe("$1.50 (estimated, prices of 2026-06-24)");
  });

  it("shows no money for an unknown model", () => {
    expect(formatCost(usage({ costBasis: "unavailable", costUsd: null }))).toBe("cost unavailable");
  });

  it("keeps small amounts readable", () => {
    expect(formatCost(usage({ costUsd: 0.0042 }))).toContain("$0.0042");
  });
});

describe("badges", () => {
  it.each([
    ["running", "Running"],
    ["waiting_user", "Waiting for you"],
    ["completed", "Completed"],
    ["stopped", "Stopped"],
    ["failed", "Failed"],
    ["unknown", "Unknown"],
  ] as const)("labels the %s state", (state, text) => {
    expect(stateBadge(state).text).toBe(text);
  });

  it("only badges linking when it is not exact", () => {
    expect(linkingBadge("exact")).toBeNull();
    expect(linkingBadge("inferred")?.text).toBe("Linked by time");
    expect(linkingBadge("unknown")?.text).toBe("Not linked to a request");
  });

  it("spells out confidence as a suffix", () => {
    expect(confidenceSuffix("exact")).toBe("");
    expect(confidenceSuffix("inferred")).toBe(" (inferred)");
    expect(confidenceSuffix("unknown")).toBe(" (unknown)");
  });

  it("badges only the non-live workspace states", () => {
    expect(workspaceStateBadge("live")).toBeNull();
    expect(workspaceStateBadge("orphaned")?.tone).toBe("warning");
    expect(workspaceStateBadge("archived")?.tone).toBe("muted");
  });

  it("colours each workflow step by whether it was used", () => {
    const row = (
      step: WorkflowStepResult["step"],
      status: WorkflowStepResult["status"],
      confidence: WorkflowStepResult["confidence"],
    ): WorkflowStepResult => ({ step, status, confidence, evidence: [], note: null });
    expect(stepChip(row("classify_tier", "done", "exact"))).toEqual({ text: "✓ Size classified", tone: "success" });
    expect(stepChip(row("polish_beads", "done", "inferred"))).toEqual({ text: "✓ Beads polished ~", tone: "info" });
    expect(stepChip(row("prd", "skipped", "exact"))).toEqual({ text: "– PRD", tone: "muted" });
    expect(stepChip(row("design", "unknown", "unknown"))).toEqual({ text: "? Technical design", tone: "warning" });
    expect(STEP_LEGEND).toContain("grey not needed");
    expect(Object.keys(STEP_LABELS)).toHaveLength(12);
    expect(stepChip(row("review_plan", "done", "exact"))).toEqual({ text: "✓ Plan reviewed", tone: "success" });
  });
});

describe("bead claims (REQ-044c)", () => {
  it("states the counts with their confidence", () => {
    expect(beadCountLine(counts(2, "inferred"))).toBe(
      "2 created (inferred) · 0 updated (inferred) · 0 closed (inferred)",
    );
  });

  it("only says 'no beads' on an exact empty count", () => {
    expect(beadClaim(counts(0, "exact"))).toBe("No beads were created for this request");
    expect(beadClaim(counts(0, "unknown"))).toBe("Whether this request created beads is not known");
    expect(beadClaim(counts(0, "inferred"))).toBe("Whether this request created beads is not known");
    expect(beadClaim(counts(3, "exact"))).toContain("3 created");
  });
});

describe("reviewer counts (REQ-042b, REQ-042c)", () => {
  it("shows agents and calls as different numbers, plus what the worker claimed", () => {
    const line = reviewerLine(
      trace({
        reviewerIds: ["rev-1"],
        reviewCalls: 3,
        guardrailReported: {
          batchId: "b1",
          batchReviews: 1,
          batchMax: 2,
          polish: 0,
          polishMax: 1,
          total: 5,
          budget: 6,
          userAllowedExtra: 0,
          raw: "raw",
        },
      }),
    );
    expect(line).toBe("1 reviewer · 3 review calls · worker reported 5");
  });

  it("says calls are unknown rather than guessing zero", () => {
    expect(reviewerLine(trace({ reviewCalls: null, reviewerIds: [] }))).toContain("review calls unknown");
  });

  it("flags a mismatch between the observed and the claimed count", () => {
    const guardrail = { batchId: null, batchReviews: null, batchMax: null, polish: null, polishMax: null, total: 5, budget: 6, userAllowedExtra: null, raw: "raw" };
    expect(guardrailMismatch(trace({ reviewCalls: 3, guardrailReported: guardrail }))).toBe(true);
    expect(guardrailMismatch(trace({ reviewCalls: 5, guardrailReported: guardrail }))).toBe(false);
    expect(guardrailMismatch(trace({ reviewCalls: null, guardrailReported: guardrail }))).toBe(false);
  });
});

describe("bead statistics and storage", () => {
  const stats = (overrides: Partial<BeadStats> = {}): BeadStats => ({
    total: 130,
    open: 25,
    inProgress: 1,
    blocked: 22,
    closed: 104,
    ready: 3,
    readAt: "2026-09-16T10:00:00.000Z",
    source: "/repo/.beads/issues.jsonl",
    skippedLines: 0,
    present: true,
    ...overrides,
  });

  it("shows the bead numbers on the overview card, and says when there is no store", () => {
    const beads = overviewCards([trace()], stats()).find((card) => card.label === "Beads")!;
    expect(beads.value).toBe("130");
    expect(beads.hint).toBe("1 in progress · 25 not started · 104 done");
    expect(overviewCards([], stats({ present: false })).find((card) => card.label === "Beads")?.hint).toContain(
      "no .beads/",
    );
  });

  it("warns only above the threshold, and says the threshold is machine-wide", () => {
    const store = { traces: 5, bytes: 300 * 1024 * 1024, workspaceBytes: 1024 };
    const warned = storageView(store, 200 * 1024 * 1024);
    expect(warned.warning?.tone).toBe("warning");
    expect(warned.warning?.text).toContain(HOST_SCOPE_NOTICE);
    expect(storageView(store, 400 * 1024 * 1024).warning).toBeNull();
    // No trace count here: the storage line reports bytes, because the store's
    // unit count and the number of rows in the list are not the same number
    // (WP-214 acceptance, defect 6).
    expect(warned.summary).not.toMatch(/\d+ traces?\b/);
    expect(warned.summary).toContain("of traces here");
  });
});

describe("grouping", () => {
  it("splits rows by workspace state and hints at reassignment for orphans", () => {
    const groups = groupTraces([
      trace({ traceId: "a", workspaceState: "live" }),
      trace({ traceId: "b", workspaceState: "orphaned" }),
      trace({ traceId: "c", workspaceState: "archived" }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["live", "archived", "orphaned"]);
    expect(groups.find((group) => group.key === "orphaned")?.hint).toContain("reassign");
  });

  it("omits empty groups", () => {
    expect(groupTraces([trace()]).map((group) => group.key)).toEqual(["live"]);
    expect(groupTraces([])).toEqual([]);
  });
});

describe("destructive actions", () => {
  it("names what is lost for each delete scope and says it cannot be undone", () => {
    const one = describeAction({
      kind: "delete",
      scope: { traceId: "req:req-A" },
      preview: { traces: 1, bytes: 2048 },
      running: 0,
    });
    expect(one.title).toBe("Delete these traces?");
    expect(one.body[0]).toContain("1 trace(s) (2.0 KB)");
    expect(one.body[0]).toContain("this one request");
    expect(one.body.join(" ")).toContain("cannot be undone");
    expect(one.body.join(" ")).toContain("Beads, documents, agents");

    expect(
      describeAction({
        kind: "delete",
        scope: { before: "2026-09-01T00:00:00.000Z" },
        preview: { traces: 9, bytes: 1024 },
        running: 0,
      }).body[0],
    ).toContain("before 2026-09-01");

    expect(
      describeAction({
        kind: "delete",
        scope: { allOfWorkspace: true },
        preview: { traces: 30, bytes: 1024 },
        running: 0,
      }).body[0],
    ).toContain("every trace of this workspace");
  });

  it("warns when a trace in scope is still running (REQ-054e)", () => {
    const described = describeAction({
      kind: "delete",
      scope: { allOfWorkspace: true },
      preview: { traces: 3, bytes: 1024 },
      running: 1,
    });
    expect(described.body.join(" ")).toContain("still have a running turn");
  });

  it("describes a reassignment without claiming anything else moves", () => {
    const described = describeAction({
      kind: "reassign",
      fromWorkspaceId: "wks_old",
      toWorkspaceId: "wks_new",
      preview: { traces: 4, bytes: 4096 },
    });
    expect(described.confirmLabel).toBe("Reassign");
    expect(described.body.join(" ")).toContain("keep the workspace they were recorded under");
    expect(described.body.join(" ")).toContain("Nothing else on this machine is touched");
  });
});

describe("the confirmation gate defaults to No", () => {
  it("cannot run anything until an action was requested with a preview", async () => {
    const gate = createConfirmationGate();
    const run = vi.fn(async () => "ran");
    expect(gate.getPending()).toBeNull();
    expect(await gate.confirm(run)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once confirmed, then forgets the action", async () => {
    const gate = createConfirmationGate();
    const seen: string[] = [];
    const unsubscribe = gate.subscribe(() => seen.push(gate.getPending()?.kind ?? "none"));
    gate.request({ kind: "delete", scope: { allOfWorkspace: true }, preview: { traces: 1, bytes: 1 }, running: 0 });
    expect(gate.getPending()?.kind).toBe("delete");

    const run = vi.fn(async () => "deleted");
    expect(await gate.confirm(run)).toBe("deleted");
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.getPending()).toBeNull();
    expect(seen).toEqual(["delete", "none"]);
    unsubscribe();
  });

  it("clears the action on cancel and after a failure", async () => {
    const gate = createConfirmationGate();
    gate.request({ kind: "delete", scope: { allOfWorkspace: true }, preview: { traces: 1, bytes: 1 }, running: 0 });
    gate.cancel();
    expect(gate.getPending()).toBeNull();

    gate.request({ kind: "delete", scope: { allOfWorkspace: true }, preview: { traces: 1, bytes: 1 }, running: 0 });
    await expect(
      gate.confirm(async () => {
        throw new Error("rpc failed");
      }),
    ).rejects.toThrow("rpc failed");
    expect(gate.getPending()).toBeNull();
  });
});

describe("how many times a request went wrong (delta 20260925 §3.5, REQ-069 g)", () => {
  const errs = (failedTurns: number, agentErrors = 0, fallbacks = 0) => ({ failedTurns, agentErrors, fallbacks });

  it("adds the three kinds up and counts the requests they belong to", () => {
    const tally = errorTally([
      trace({ errors: errs(2, 1, 1) }),
      trace({ traceId: "req:req-B", errors: errs(0, 0, 3) }),
      trace({ traceId: "req:req-C", errors: errs(0) }),
    ]);
    expect(tally).toEqual({ total: 7, requests: 2, failedTurns: 2, agentErrors: 1, fallbacks: 4 });
  });

  it("counts a request once however many questions it took", () => {
    // The rows of one request share a traceId (delta 20260917e §4.3): the server
    // keeps the request's own errors on the opening row, and this must not read
    // two rows of one request as two failing requests.
    const tally = errorTally([
      trace({ turn: { index: 1, total: 2 }, errors: errs(1, 0, 2) }),
      trace({ turn: { index: 2, total: 2 }, errors: errs(1) }),
    ]);
    expect(tally).toEqual({ total: 4, requests: 1, failedTurns: 2, agentErrors: 0, fallbacks: 2 });
  });

  it("reads a row from an older server as nothing to count", () => {
    const older = trace();
    delete (older as { errors?: unknown }).errors;
    expect(errorTally([older])).toEqual({ total: 0, requests: 0, failedTurns: 0, agentErrors: 0, fallbacks: 0 });
    expect(errorTally([])).toEqual({ total: 0, requests: 0, failedTurns: 0, agentErrors: 0, fallbacks: 0 });
  });

  it("says plainly when nothing failed, and names the unit when something did", () => {
    expect(errorCard(errorTally([trace({ errors: errs(0) })]))).toEqual({
      label: "Errors",
      value: "0",
      hint: "no error recorded",
    });
    expect(errorCard(errorTally([trace({ errors: errs(1) })]))).toEqual({
      label: "Errors",
      value: "1",
      hint: "1 request with an error · 1 failed turn",
    });
    // Parts that are zero are left out, and the plural follows the count.
    expect(errorCard(errorTally([trace({ errors: errs(2, 0, 3) }), trace({ traceId: "req:req-B", errors: errs(0, 1) })])).hint).toBe(
      "2 requests with an error · 2 failed turns · 1 agent error · 3 provider fallbacks",
    );
  });

  it("sits right after the Requests card, so the two are read together", () => {
    const cards = overviewCards([trace({ errors: errs(1, 0, 1) })], null);
    expect(cards.map((card) => card.label).slice(0, 3)).toEqual(["Requests", "Errors", "Beads"]);
    expect(cards.find((card) => card.label === "Errors")).toEqual({
      label: "Errors",
      value: "2",
      hint: "1 request with an error · 1 failed turn · 1 provider fallback",
    });
  });
});

describe("overview", () => {
  it("sums requests, agents, messages, tokens and cost across requests", () => {
    const cards = overviewCards(
      [
        trace({ state: "running", workerIds: ["w1"], reviewerIds: ["r1", "r2"] }),
        trace({ traceId: "req:req-B", workerIds: ["w2"], reviewerIds: ["r1"] }),
      ],
      null,
    );
    const byLabel = Object.fromEntries(cards.map((card) => [card.label, card]));
    expect(byLabel.Requests?.value).toBe("2");
    expect(byLabel.Requests?.hint).toContain("1 running");
    expect(byLabel.Agents?.value).toBe("4");
    expect(byLabel.Messages?.value).toBe("16");
    expect(byLabel.Cost?.hint).toBe("estimated");
    expect(byLabel.Beads?.value).toBe("…");
  });

  it("does not invent a cost for unpriced requests", () => {
    const unpriced = usage({ costUsd: null, costBasis: "unavailable" });
    const cost = overviewCards([trace({ usage: unpriced })], null).find((card) => card.label === "Cost")!;
    expect(cost.value).toBe("—");
    expect(cost.hint).toContain("1 request(s) unpriced");
  });

  it("counts requests per day, oldest first", () => {
    const bars = requestsPerDay(
      [trace({ requestedAt: "2026-09-16T10:00:00.000Z" }), trace({ requestedAt: "2026-09-15T09:00:00.000Z" })],
      new Date("2026-09-16T12:00:00.000Z"),
      3,
    );
    expect(bars.map((bar) => [bar.label, bar.value])).toEqual([
      ["09-14", 0],
      ["09-15", 1],
      ["09-16", 1],
    ]);
  });

  describe("tokens by model × role (delta 20260918 §4.4, REQ-058e)", () => {
    const part = (role: "manager" | "worker" | "reviewer", model: string | null, inputTokens: number, costUsd: number | null) => ({
      role,
      model,
      usage: usage({ inputTokens, cachedInputTokens: 0, outputTokens: 0, costUsd, costBasis: costUsd === null ? "unavailable" : "estimated", model }),
    });
    // Each summary's parts add up to its own usage, as the server builds them.
    const summary = (parts: ReturnType<typeof part>[]) =>
      trace({
        usage: usage({
          inputTokens: parts.reduce((sum, entry) => sum + entry.usage.inputTokens, 0),
          cachedInputTokens: 0,
          outputTokens: 0,
        }),
        usageByModelRole: parts,
      });
    const rows = [
      summary([part("manager", "claude-opus-5", 1_000, 0.1), part("worker", "claude-opus-5", 30_000, 2), part("reviewer", "gpt-5.6-sol", 5_000, null)]),
      summary([part("manager", "claude-opus-5", 2_000, 0.2), part("worker", "claude-opus-5", 10_000, 1)]),
      summary([part("reviewer", "gpt-5.6-sol", 4_000, null), part("worker", null, 500, null)]),
    ];

    it("one bar per (model, role) pair, summed across requests, heaviest first", () => {
      const bars = tokensByModelRole(rows);

      expect(bars.map((bar) => [bar.label, bar.value])).toEqual([
        ["claude-opus-5 · worker", 40_000],
        ["gpt-5.6-sol · reviewer", 9_000],
        ["claude-opus-5 · manager", 3_000],
        ["unknown model · worker", 500],
      ]);
      expect(bars[0]!.display).toBe("40k · $3.00");
      // No price: tokens only.
      expect(bars[1]!.display).toBe("9.0k");
    });

    it("counts exactly the tokens the overview's Tokens card counts, on the same rows", () => {
      const total = tokensByModelRole(rows).reduce((sum, bar) => sum + bar.value, 0);
      const card = overviewCards(rows, null).find((entry) => entry.label === "Tokens")!;

      expect(formatTokens(total)).toBe(card.value);
      expect(total).toBe(rows.reduce((sum, row) => sum + row.usage.inputTokens, 0));
    });

    it("a row from an older server without the field adds nothing and breaks nothing", () => {
      expect(tokensByModelRole([trace()])).toEqual([]);
    });
  });

  it("ranks the five heaviest Workers across requests and scales bars to the largest", () => {
    const worker = (agentId: string, title: string | null, inputTokens: number, costUsd: number | null) => ({
      agentId,
      title,
      usage: usage({ inputTokens, cachedInputTokens: 0, outputTokens: 0, costUsd }),
    });
    const bars = heaviestWorkers([
      trace({ excerpt: "bug PAKD", workerUsage: [worker("w-big", "Worker — bug PAKD", 1000, 4.2)] }),
      trace({ excerpt: "màn Contact", workerUsage: [worker("w-small", null, 10, null), worker("w-zero", null, 0, null)] }),
      ...Array.from({ length: 5 }, (_, index) => trace({ workerUsage: [worker(`w-${index}`, null, 100 + index, 0.1)] })),
    ]);
    expect(bars).toHaveLength(5);
    expect(bars[0]).toMatchObject({ agentId: "w-big", label: "Worker — bug PAKD", hint: "bug PAKD", display: "1.0k · $4.20" });
    expect(bars.map((bar) => bar.agentId)).not.toContain("w-zero");
    expect(bars[4]?.label).toBe("Worker w-1");
    expect(barShare(bars[1]!, bars)).toBeCloseTo(0.104);
  });
});

describe("request graph", () => {
  const detail = (overrides: Partial<TraceDetail> = {}): TraceDetail => ({
    ...trace(),
    sent: {
      userRequest: { agentId: null, at: "2026-09-16T10:00:00.000Z", text: "thêm màn hình báo cáo", truncated: false },
      workerInitialPrompts: [],
      reviewRequests: [{ agentId: "rev-1", at: "2026-09-16T10:05:00.000Z", text: "review b1", truncated: false, batchId: "b1" }],
    },
    received: {
      reports: [],
      reviews: [{ agentId: "rev-1", at: "2026-09-16T10:06:00.000Z", batchId: "b1", verdict: "pass", blockingCount: 0 }],
      managerReplies: [{ agentId: "agent-manager", at: "2026-09-16T10:07:00.000Z", text: "Xong.", truncated: false }],
    },
    timing: {
      totalMs: 600_000,
      managerTurns: [],
      workers: [{ agentId: "w1", role: "worker", startedAt: null, lastActivityAt: null, ms: 540_000, state: "completed" }],
      reviewers: [{ agentId: "rev-1", role: "reviewer", startedAt: null, lastActivityAt: null, ms: 60_000, state: "completed" }],
      basis: "b",
    },
    usageByAgent: [],
    beads: [],
    workflowSteps: [],
    subAgentTraces: [],
    userMessages: [],
    skills: [],
    ...overrides,
  });
  const now = new Date("2026-09-16T10:10:00.000Z");

  it("chains Request → Worker → Reviewer, with the reviewer under its only worker", () => {
    const nodes = requestGraph(trace(), detail(), now);
    expect(nodes.map((node) => [node.kind, node.depth])).toEqual([
      ["request", 0],
      ["worker", 1],
      ["reviewer", 2],
    ]);
    expect(nodes[2]?.title).toBe("Reviewer rev-1 · batch b1");
    expect(nodes[2]?.badge).toEqual({ text: "pass", tone: "success" });
  });

  it("gives each role its own icon and colour, so agents are told apart at a glance", () => {
    const marks = Object.values(ROLE_MARK);
    expect(marks.map((mark) => mark.role)).toEqual(["Manager", "Worker", "Reviewer"]);
    expect(new Set(marks.map((mark) => mark.icon)).size).toBe(3);
    expect(new Set(marks.map((mark) => mark.tone)).size).toBe(3);
    // Danger is kept for failures; a role is never drawn in it.
    expect(marks.every((mark) => mark.tone !== "danger")).toBe(true);
    // Every node kind the graph produces has a mark.
    for (const node of requestGraph(trace(), detail(), now)) expect(ROLE_MARK[node.kind]).toBeDefined();
  });

  it("keeps reviewers under the request when several workers could own them", () => {
    const nodes = requestGraph(trace({ workerIds: ["w1", "w2"] }), null, now);
    expect(nodes.map((node) => [node.kind, node.depth])).toEqual([
      ["request", 0],
      ["worker", 1],
      ["worker", 1],
      ["reviewer", 1],
    ]);
  });

  it("expands the request into what was asked, what came back and how long it took", () => {
    const root = requestGraph(trace(), detail(), now)[0]!;
    expect(root.details[0]).toBe("Asked: thêm màn hình báo cáo");
    expect(root.details[1]).toBe("Answer: Xong.");
    expect(root.details[2]).toContain("Time: 10m");
  });

  it("has no details until the trace is loaded, and says when the request was not recorded", () => {
    expect(requestGraph(trace(), null, now).every((node) => node.details.length === 0)).toBe(true);
    const root = requestGraph(trace(), detail({ sent: { userRequest: null, workerInitialPrompts: [], reviewRequests: [] } }), now)[0]!;
    expect(root.details[0]).toBe("Asked: not recorded");
  });

  it("shows what the user typed to each agent, and the skills each agent loaded", () => {
    const withExtras = detail({
      userMessages: [
        { agentId: "w1", at: "2026-09-16T10:03:00.000Z", text: "dùng cột amount_xu", truncated: false, origin: "user" },
        { agentId: "agent-manager", at: "2026-09-16T10:04:00.000Z", text: "ưu tiên việc này", truncated: false, origin: "user" },
        // A Worker the user deleted: not a node any more, and not the Manager.
        { agentId: "w-deleted", at: "2026-09-16T10:05:00.000Z", text: "gửi worker cũ", truncated: false, origin: "user" },
      ],
      usageByAgent: [
        { agentId: "agent-manager", role: "manager", usage: detail().usage },
        { agentId: "w-deleted", role: "worker", usage: detail().usage },
      ],
      skills: [
        { agentId: "w1", skill: "feature-workflow", at: "2026-09-16T10:01:00.000Z" },
        { agentId: "w1", skill: "implementing-beads", at: "2026-09-16T10:02:00.000Z" },
      ],
    });
    const nodes = requestGraph(trace({ userMessageCount: 3 }), withExtras, now);
    const [root, worker] = nodes;
    expect(root!.subtitle).toContain("💬 3 from you");
    expect(root!.chipGroups.find((group) => group.label === "Skills used")?.chips.map((chip) => chip.text)).toEqual([
      "feature-workflow",
      "implementing-beads",
    ]);
    expect(root!.details.join("\n")).toContain("💬 You → Manager (10:04:00): ưu tiên việc này");
    expect(root!.details.join("\n")).not.toContain("You → Manager (10:03:00)");
    expect(root!.details.join("\n")).not.toContain("gửi worker cũ");
    expect(worker!.subtitle).toContain("💬 1");
    expect(worker!.chipGroups).toEqual([
      {
        label: "Skills loaded",
        chips: [
          { text: "feature-workflow", tone: "info" },
          { text: "implementing-beads", tone: "info" },
        ],
      },
    ]);
    expect(worker!.details.join("\n")).toContain("💬 You → w1 (10:03:00): dùng cột amount_xu");
  });

  describe("which model, thinking and mode each agent ran (delta 20260918 §4.4)", () => {
    const priced = (model: string, tokens: number, costUsd: number | null) => ({
      ...detail().usage,
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      model,
      costUsd,
      costBasis: costUsd === null ? ("unavailable" as const) : ("estimated" as const),
      pricesUpdatedAt: costUsd === null ? null : "2026-09-16",
    });
    const withRuntime = detail({
      usageByAgent: [
        {
          agentId: "agent-manager",
          role: "manager",
          usage: detail().usage,
          runtime: [{ model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions", recorded: true, turns: 4 }],
        },
        {
          agentId: "w1",
          role: "worker",
          usage: detail().usage,
          runtime: [
            { model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions", recorded: true, turns: 3 },
            { model: "claude-opus-5", thinkingOptionId: "high", modeId: "bypassPermissions", recorded: true, turns: 1 },
            { model: "claude-opus-5", thinkingOptionId: null, modeId: null, recorded: false, turns: 2 },
          ],
        },
        {
          agentId: "rev-1",
          role: "reviewer",
          usage: detail().usage,
          runtime: [{ model: null, thinkingOptionId: null, modeId: null, recorded: false, turns: 1 }],
        },
      ],
      usageByModel: [
        { model: "claude-opus-5", usage: priced("claude-opus-5", 12_300, 0.12) },
        { model: "gpt-5.6-sol", usage: priced("gpt-5.6-sol", 300_000, null) },
      ],
    });
    const [root, worker, reviewer] = requestGraph(trace(), withRuntime, now);

    it("a Worker lists one line per combination, with turn counts; an unset thinking option is the provider's default", () => {
      expect(worker!.details).toEqual(
        expect.arrayContaining([
          "Model: claude-opus-5 · thinking: provider default · mode: bypassPermissions · 3 turns",
          "Model: claude-opus-5 · thinking: high · mode: bypassPermissions · 1 turn",
          "Model: claude-opus-5 · thinking/mode: not recorded · 2 turns",
        ]),
      );
      // One known model: it goes in the subtitle too.
      expect(worker!.subtitle).toContain("claude-opus-5");
    });

    it("a turn with no model at all says so, and a Reviewer without a known model gets no model in its subtitle", () => {
      expect(reviewer!.details).toContain("Model: not recorded · 1 turn");
      expect(reviewer!.subtitle).not.toContain("not recorded");
    });

    it("the Manager's lines and the tokens by model go in the request's details", () => {
      expect(root!.details).toContain("Manager agent-ma — Model: claude-opus-5 · thinking: provider default · mode: bypassPermissions · 4 turns");
      const byModel = root!.details.find((line) => line.startsWith("Tokens by model: "));
      expect(byModel).toContain("claude-opus-5 12k tokens · $0.12 (estimated, prices of 2026-09-16)");
      // No price for the Codex model: tokens only, never "cost unavailable" noise.
      expect(byModel).toMatch(/gpt-5\.6-sol 300k tokens$/);
    });

    it("nothing new before the detail is loaded, or when the server sent no runtime", () => {
      const bare = requestGraph(trace(), detail(), now);
      expect(bare.flatMap((node) => node.details).some((line) => line.includes("Model:") || line.startsWith("Tokens by model"))).toBe(false);
      expect(requestGraph(trace(), null, now).every((node) => node.details.length === 0)).toBe(true);
    });
  });

  it("shows the workflow steps as chips with a legend", () => {
    const withSteps = detail({
      workflowSteps: [
        { step: "classify_tier", status: "done", confidence: "exact", evidence: [], note: null },
        { step: "prd", status: "skipped", confidence: "exact", evidence: [], note: null },
      ],
    });
    const steps = requestGraph(trace(), withSteps, now)[0]!.chipGroups.find((group) => group.label === "Workflow steps");
    expect(steps?.chips.map((chip) => chip.tone)).toEqual(["success", "muted"]);
    expect(steps?.note).toBe(STEP_LEGEND);
  });

  it("keeps the honesty notes: time-linked rows and disagreeing counts", () => {
    const guardrail = { batchId: null, batchReviews: null, batchMax: null, polish: null, polishMax: null, total: 5, budget: 6, userAllowedExtra: null, raw: "raw" };
    const root = requestGraph(trace({ linking: "inferred", reviewCalls: 3, guardrailReported: guardrail }), detail(), now)[0]!;
    expect(root.details.join(" ")).toContain("Linked by time");
    expect(root.details.join(" ")).toContain("review counts disagree");
  });
});

describe("styles and the privacy notice", () => {
  it("takes every colour from the theme", () => {
    const palette = new Set<string>(Object.values(theme.colors));
    const styles = dashboardStyles(theme as never, false);
    const colours = JSON.stringify(styles).match(/"#[0-9a-f]{3,8}"/gi) ?? [];
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) expect(palette.has(colour.slice(1, -1))).toBe(true);
  });

  it("maps every tone to a theme colour", () => {
    for (const tone of ["muted", "info", "warning", "danger", "success"] as const) {
      expect(Object.values(theme.colors)).toContain(toneColor(theme as never, tone));
    }
  });

  it("tells the user the screen holds conversation they can delete", () => {
    expect(PRIVACY_NOTICE).toContain("delete");
  });
});


/**
 * One row per question (delta 20260917e §4.3), and the chart that must NOT
 * follow it (owner decision Q27).
 */
describe("turns of a request", () => {
  const turned = (index: number, total: number, at: string) =>
    trace({ turn: { index, total }, requestedAt: at, traceId: "req:req-A", requestId: "req-A" });

  it("says which turn a row is, and says nothing for a request nobody followed up", () => {
    expect(turnLabel(null)).toBe("");
    expect(turnLabel({ index: 2, total: 3 })).toBe("turn 2 of 3 · ");
  });

  it("counts a request once however many times the user asked", () => {
    const day = "2026-09-17";
    const bars = requestsPerDay(
      [turned(1, 3, `${day}T09:00:00.000Z`), turned(2, 3, `${day}T09:10:00.000Z`), turned(3, 3, `${day}T09:20:00.000Z`)],
      new Date(`${day}T23:00:00.000Z`),
    );
    // Three rows, one request.
    expect(bars.at(-1)).toEqual({ label: "09-17", value: 1, display: "1" });
  });

  it("still counts a request that was never followed up", () => {
    const day = "2026-09-17";
    const bars = requestsPerDay([trace({ requestedAt: `${day}T09:00:00.000Z` })], new Date(`${day}T23:00:00.000Z`));
    expect(bars.at(-1)?.value).toBe(1);
  });

  it("gives each turn of a request its own node id", () => {
    // Rows of one request share a `traceId` on purpose, so without the turn in
    // the id two rows would collide as one.
    const first = requestGraph(turned(1, 2, "2026-09-17T09:00:00.000Z"), null, new Date());
    const second = requestGraph(turned(2, 2, "2026-09-17T09:10:00.000Z"), null, new Date());
    expect(first[0]!.id).not.toBe(second[0]!.id);
    expect(second[0]!.id).toContain("#2");
  });

  it("leaves the node id of a request nobody followed up unchanged", () => {
    const only = requestGraph(trace(), null, new Date());
    expect(only[0]!.id).toBe("request:req:req-A");
  });

  it("counts two separate requests on the same day as two", () => {
    const day = "2026-09-17";
    const bars = requestsPerDay(
      [
        trace({ traceId: "req:req-A", requestId: "req-A", requestedAt: `${day}T09:00:00.000Z` }),
        trace({ traceId: "req:req-B", requestId: "req-B", requestedAt: `${day}T11:00:00.000Z` }),
      ],
      new Date(`${day}T23:00:00.000Z`),
    );
    expect(bars.at(-1)?.value).toBe(2);
  });
});
