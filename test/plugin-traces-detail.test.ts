import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconstructTraces, type AgentFacts } from "../plugin/server/traces";
import { TIMING_BASIS, agentTiming, beadActionsOf, managerTurns, totalMsOf } from "../plugin/server/trace-timing";
import { agentTokenFiguresOf, summariseUsage, usageOfTrace } from "../plugin/server/trace-usage";
import { detail, paginate, skillsOf, subAgentTracesOf, summarise, userMessagesOf } from "../plugin/server/trace-views";
import { priceUsage } from "../plugin/server/cost";
import { handleTracesAgents, handleTracesGet, handleTracesList } from "../plugin/server/dashboard-rpc";
import { createCompactionStore } from "../plugin/server/compaction-store";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { inferWorkflowSteps } from "../plugin/server/workflow-steps";
import { CONTEXT_TREND_MAX, TRACE_STORE_SCHEMA_VERSION, tracesAgentsRpc, type TraceRecord } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * WP-206.1.2: timing, bead detail, summaries, pagination and the read RPCs.
 *
 * The rules under test: a running turn has no total, a missing mark is null and
 * never zero, and a bead claim carries the confidence of whatever produced it.
 */

const WS = "wks_1";
const MANAGER = "agent-manager";
let home: string;
let workspace: string;

/** The shared fake SDK with these agents and workspaces (the one at `workspace` by default); it honours the list filter, like the daemon. */
const daemonWith = (agents: Array<Record<string, unknown> & { id: string }>, workspaces: Array<Record<string, unknown>> = [{ id: WS, directory: workspace }]) =>
  fakePaseo<DashboardPaseo>({ agents, workspaces }).paseo;

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: "req-A",
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: "2026-09-16T10:00:00.000Z",
    endedAt: "2026-09-16T10:00:20.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

const msg = (text: string, at = "2026-09-16T10:00:00.000Z") => ({ agentId: MANAGER, at, text, truncated: false });

function report(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "w1",
    at: "2026-09-16T10:10:00.000Z",
    requestId: "req-A",
    phase: "finished" as const,
    tier: "Small" as const,
    filesChanged: [],
    beadsCreated: [],
    beadsUpdated: [],
    beadsClosed: [],
    beadsReady: [],
    reviewFindingsOpen: null,
    buildAndTests: null,
    blockers: null,
    guardrail: null,
    unparsedFields: [],
    incompleteFields: [],
    skillsUsed: [],
    ...overrides,
  };
}

function agent(overrides: Partial<AgentFacts> & { id: string }): AgentFacts {
  return {
    role: "worker",
    status: "idle",
    parentAgentId: MANAGER,
    createdAt: "2026-09-16T10:00:10.000Z",
    requestIdLabel: "req-A",
    batchIdLabel: null,
    archived: false,
    ...overrides,
  };
}

function trace(records: TraceRecord[], agents: AgentFacts[]) {
  const built = reconstructTraces({ records, agents });
  return { trace: built[0]!, agents: new Map(agents.map((a) => [a.id, a])) };
}

const baseRecords = () => [
  record({ sent: [msg("thêm màn hình báo cáo")] }),
  record({
    agentId: "w1",
    role: "worker",
    turnId: "w-turn",
    at: "2026-09-16T10:10:00.000Z",
    startedAt: "2026-09-16T10:00:30.000Z",
    endedAt: "2026-09-16T10:10:00.000Z",
    reports: [report()],
  }),
];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-detail-"));
  workspace = join(home, "repo");
  mkdirSync(join(workspace, ".beads"), { recursive: true });
  // From 0.4.0 the store is found with `resolveDataHome`, so the folder is
  // named here rather than through the plugin path in the fake configuration.
  process.env["PASEO_BM_HOME"] = home;
  clearTraceStoreCache();
  clearBeadsCache();
});

afterEach(() => {
  delete process.env["PASEO_BM_HOME"];
  rmSync(home, { recursive: true, force: true });
});

describe("timing", () => {
  it("measures the total from the request to the last activity", () => {
    const { trace: built } = trace(baseRecords(), [agent({ id: "w1" })]);
    expect(totalMsOf(built)).toBe(600_000);
    expect(TIMING_BASIS).toContain("waiting for you to answer");
  });

  it("returns null while anything is still running, instead of measuring against now", () => {
    const { trace: built, agents } = trace(baseRecords(), [agent({ id: "w1", status: "running" })]);
    expect(built.state).toBe("running");
    expect(totalMsOf(built)).toBeNull();
    expect(agentTiming("w1", "worker", built, agents).ms).toBeNull();
  });

  it("never turns a missing mark into zero", () => {
    const { trace: built, agents } = trace(
      [record({ sent: [msg("x")], startedAt: null, endedAt: "2026-09-16T10:00:20.000Z" })],
      [],
    );
    const turns = managerTurns(built);
    expect(turns[0]?.ms).toBe(20_000);
    const orphanTiming = agentTiming("nobody", "worker", built, agents);
    expect(orphanTiming.ms).toBeNull();
    expect(orphanTiming.startedAt).toBeNull();
  });

  it("ends a Worker at its finished report and a Reviewer at its last review", () => {
    const records = [
      ...baseRecords(),
      record({
        agentId: "rev-1",
        role: "reviewer",
        turnId: "rev-turn",
        at: "2026-09-16T10:08:00.000Z",
        sent: [msg("review batch-1", "2026-09-16T10:06:00.000Z")],
        reviews: [{ agentId: "rev-1", at: "2026-09-16T10:07:00.000Z", batchId: "batch-1", verdict: "approved", blockingCount: null }],
      }),
    ];
    const { trace: built, agents } = trace(records, [
      agent({ id: "w1" }),
      agent({ id: "rev-1", role: "reviewer", parentAgentId: "w1", createdAt: "2026-09-16T10:05:00.000Z" }),
    ]);
    expect(agentTiming("w1", "worker", built, agents).ms).toBe(590_000);
    expect(agentTiming("rev-1", "reviewer", built, agents).ms).toBe(120_000);
  });
});

describe("bead actions and confidence", () => {
  it("is exact when a report names the beads", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        reports: [report({ beadsCreated: ["bm-a1"], beadsClosed: ["bm-a1"], beadsReady: ["bm-b2"] })],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    const actions = beadActionsOf(built);
    expect(actions.created).toEqual({ ids: ["bm-a1"], confidence: "exact" });
    expect(actions.closed.ids).toEqual(["bm-a1"]);
    expect(actions.ready.ids).toEqual(["bm-b2"]);
    expect(actions.evidenceById.get("bm-a1")?.[0]?.kind).toBe("report");
  });

  it("is inferred when only a br command was seen", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        evidence: [
          { kind: "shell", detail: "br update bm-c3 --status=in_progress", agentId: "w1", at: "2026-09-16T10:09:00.000Z" },
        ],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    const actions = beadActionsOf(built);
    expect(actions.updated).toEqual({ ids: ["bm-c3"], confidence: "inferred" });
    expect(actions.evidenceById.get("bm-c3")?.[0]?.kind).toBe("shell");
  });

  it("takes ready from the latest report, since ready is a state (delta 20260917-workflow-skills §5.2)", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        turnId: "w-1",
        at: "2026-09-16T10:10:00.000Z",
        reports: [report({ phase: "beads-done", at: "2026-09-16T10:10:00.000Z", beadsCreated: ["bm-a1", "bm-a2", "bm-a3"], beadsReady: ["bm-a1", "bm-a2", "bm-a3"] })],
      }),
      record({
        agentId: "w1",
        role: "worker",
        turnId: "w-2",
        at: "2026-09-16T10:30:00.000Z",
        reports: [report({ phase: "finished", at: "2026-09-16T10:30:00.000Z", beadsClosed: ["bm-a1", "bm-a2", "bm-a3"] })],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    const actions = beadActionsOf(built);
    expect(actions.ready).toEqual({ ids: [], confidence: "exact" });
    expect(actions.created.ids).toHaveLength(3);
    expect(actions.closed.ids).toHaveLength(3);
  });

  it("keeps ready from a beads-done report when nothing came after it", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        reports: [report({ phase: "beads-done", beadsReady: ["bm-a1", "bm-a2", "bm-a3"] })],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    expect(beadActionsOf(built).ready).toEqual({ ids: ["bm-a1", "bm-a2", "bm-a3"], confidence: "exact" });
  });

  it("marks a count inferred when its list was reported incomplete, and only that count (delta 20260917-workflow-skills §5.1)", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        reports: [report({ beadsCreated: ["bm-a1"], beadsClosed: ["bm-a1"], incompleteFields: ["beadsCreated"] })],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    const actions = beadActionsOf(built);
    expect(actions.created).toEqual({ ids: ["bm-a1"], confidence: "inferred" });
    expect(actions.closed.confidence).toBe("exact");
    expect(actions.updated.confidence).toBe("exact");
    expect(actions.ready.confidence).toBe("exact");
  });

  it("is unknown when there is neither a report nor a command", () => {
    const { trace: built } = trace([record({ sent: [msg("x")] })], []);
    const actions = beadActionsOf(built);
    expect(actions.created).toEqual({ ids: [], confidence: "unknown" });
  });

  /**
   * WP-214 acceptance, defect 7: the real `br` lines below made one request
   * that created one bead and closed it report 2 created and 6 closed, with
   * `single-line`, `non-empty`, `bm-reviewer` and `gpt-5.6-sol` among the ids.
   *
   * Every string here is verbatim from
   * `~/.paseo-bm/traces/wks_1a215b77cbcfd5e7/events-202609.jsonl`.
   */
  describe("a bead id is a positional argument, not any hyphenated word on the line", () => {
    const shell = (detail: string) => ({
      kind: "shell" as const,
      detail,
      agentId: "w1",
      at: "2026-09-16T10:09:00.000Z",
    });

    const fromCommands = (details: string[]) => {
      const records = [
        record({ sent: [msg("x")] }),
        record({
          agentId: "w1",
          role: "worker",
          at: "2026-09-16T10:10:00.000Z",
          evidence: details.map(shell),
        }),
      ];
      const { trace: built } = trace(records, [agent({ id: "w1" })]);
      return beadActionsOf(built);
    };

    it("ignores the label list of br create, which names no id at all", () => {
      const actions = fromCommands([
        'br create "Them docstring cho ham format_date" -t task -p 2 -l "feature:format-date,component:invoice"',
      ]);
      expect(actions.created.ids).toEqual([]);
      // A create still happened, so the count is an inference, not a denial.
      expect(actions.created.confidence).toBe("inferred");
    });

    it("ignores the prose of a --reason and keeps only the bead being closed", () => {
      const actions = fromCommands([
        'br close repo-37g -r "Acceptance criteria met. Added a single-line docstring \\"Format a date value as a dd/mm/yyyy string.\\" to format_date in src/invoice.py, reviewed by bm-reviewer gpt-5.6-sol, non-empty and one-line."',
      ]);
      expect(actions.closed.ids).toEqual(["repo-37g"]);
    });

    it("reads the id of br update before its flags", () => {
      expect(fromCommands(['br update repo-37g -d "$(cat <<\'EOF\' ## Objective ... EOF)"']).updated.ids).toEqual([
        "repo-37g",
      ]);
      expect(fromCommands(["br update repo-37g -s in_progress"]).updated.ids).toEqual(["repo-37g"]);
    });

    it("does not treat a help page as an action", () => {
      const actions = fromCommands(["br create --help 2>&1 | head -40", "br close --help 2>&1 | head -25"]);
      expect(actions.created.ids).toEqual([]);
      expect(actions.created.confidence).toBe("unknown");
    });
  });

  it("is an exact empty list when a finished report says none", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({ agentId: "w1", role: "worker", at: "2026-09-16T10:10:00.000Z", reports: [report({ beadsCreated: [] })] }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    // This is the only shape that lets the UI say "this request created no beads".
    expect(beadActionsOf(built).created).toEqual({ ids: [], confidence: "exact" });
  });
});

describe("usage and sub-agents", () => {
  it("sums tokens and leaves the price to WP-209", () => {
    const usage = { inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, costUsd: null, costBasis: "unavailable" as const, model: "claude-opus-5", pricesUpdatedAt: null };
    const records = [
      record({ sent: [msg("x")], usage }),
      record({ agentId: "w1", role: "worker", at: "2026-09-16T10:10:00.000Z", usage }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    expect(summariseUsage(built)).toMatchObject({
      inputTokens: 20,
      cachedInputTokens: 10,
      outputTokens: 4,
      costUsd: null,
      costBasis: "unavailable",
      model: "claude-opus-5",
    });
  });

  describe("a total priced per model (delta 20260917-workflow-skills §5.4)", () => {
    const tokens = (model: string | null, inputTokens: number, cachedInputTokens: number, outputTokens: number) => ({
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costUsd: null,
      costBasis: "unavailable" as const,
      model,
      pricesUpdatedAt: null,
    });
    // Opus: 1M in ($5) + 2M cached ($1) + 0.1M out ($2.5) = $8.5; Codex model not in the table.
    const opus = tokens("claude-opus-5", 1_000_000, 2_000_000, 100_000);
    const codex = tokens("gpt-5.6-sol", 400_000, 300_000, 3_000);
    const mixed = (reviewerLast: boolean) => {
      const worker = record({ agentId: "w1", role: "worker", turnId: "w", at: "2026-09-16T10:10:00.000Z", usage: opus });
      const reviewer = record({ agentId: "r1", role: "reviewer", turnId: "r", at: "2026-09-16T10:05:00.000Z", usage: codex });
      const records = [record({ sent: [msg("x")] }), ...(reviewerLast ? [worker, { ...reviewer, at: "2026-09-16T10:20:00.000Z" }] : [reviewer, worker])];
      return trace(records, [agent({ id: "w1" }), agent({ id: "r1", role: "reviewer", parentAgentId: "w1", batchIdLabel: "b1" })]);
    };

    it.each([false, true])("prices only the priced model and names the rest (reviewer last: %s)", (reviewerLast) => {
      const { trace: built } = mixed(reviewerLast);
      const { usage, notice } = usageOfTrace(built, priceUsage);
      expect(usage).toMatchObject({
        inputTokens: 1_400_000,
        cachedInputTokens: 2_300_000,
        outputTokens: 103_000,
        costUsd: 8.5,
        costBasis: "estimated",
        model: null,
      });
      expect(usage.pricesUpdatedAt).not.toBeNull();
      expect(notice).toBe("Cost excludes 703000 tokens from models without a price: gpt-5.6-sol.");
    });

    it("makes the total equal the sum of the per-agent costs the detail shows, and shows the notice", () => {
      const { trace: built, agents } = mixed(true);
      const shown = detail(built, {
        agents,
        workspaceState: "live",
        reassignedFrom: null,
        priceUsage,
        lookupBeads: () => ({ found: [], missing: [] }),
      });
      const perAgent = shown.usageByAgent.reduce((sum, entry) => sum + (entry.usage.costUsd ?? 0), 0);
      expect(shown.usageByAgent.length).toBeGreaterThanOrEqual(2);
      expect(shown.usage.costUsd).toBe(perAgent);
      expect(shown.notices).toContain("Cost excludes 703000 tokens from models without a price: gpt-5.6-sol.");
    });

    it("treats a provider-qualified model id as the same model (review bm-wp-220-nvk.1)", () => {
      const records = [
        record({ sent: [msg("x")], usage: opus }),
        record({ agentId: "w1", role: "worker", at: "2026-09-16T10:10:00.000Z", usage: { ...opus, model: "bm-worker/claude-opus-5" } }),
      ];
      const { trace: built } = trace(records, [agent({ id: "w1" })]);
      const { usage, notice } = usageOfTrace(built, priceUsage);
      expect(usage).toMatchObject({ model: "claude-opus-5", costUsd: 17, costBasis: "estimated" });
      expect(notice).toBeNull();
    });

    it("keeps the plain result for a trace whose records carry no tokens", () => {
      const records = [record({ sent: [msg("x")], usage: tokens("claude-opus-5", 0, 0, 0) })];
      const { trace: built } = trace(records, []);
      expect(usageOfTrace(built, priceUsage).usage).toEqual(priceUsage(summariseUsage(built)));
    });

    it("prices an agent that switched models per model (review bm-wp-220-nvk.1)", () => {
      const sonnet = tokens("claude-sonnet-5", 1_000_000, 0, 0); // $2
      const records = [
        record({ sent: [msg("x")] }),
        record({ agentId: "w1", role: "worker", turnId: "w-a", at: "2026-09-16T10:10:00.000Z", usage: opus }),
        record({ agentId: "w1", role: "worker", turnId: "w-b", at: "2026-09-16T10:20:00.000Z", usage: sonnet }),
      ];
      const { trace: built, agents } = trace(records, [agent({ id: "w1" })]);
      const summary = summarise(built, { agents, workspaceState: "live", reassignedFrom: null, priceUsage });
      expect(summary.workerUsage[0]?.usage.costUsd).toBe(10.5);
      expect(summary.usage.costUsd).toBe(10.5);
    });

    it("keeps a single-model trace exactly as before, with no notice", () => {
      const records = [record({ sent: [msg("x")], usage: opus }), record({ agentId: "w1", role: "worker", at: "2026-09-16T10:10:00.000Z", usage: opus })];
      const { trace: built } = trace(records, [agent({ id: "w1" })]);
      const { usage, notice } = usageOfTrace(built, priceUsage);
      expect(usage).toEqual(priceUsage(summariseUsage(built)));
      expect(notice).toBeNull();
    });

    it("reports no money when no part has a price", () => {
      const records = [record({ sent: [msg("x")], usage: codex })];
      const { trace: built } = trace(records, []);
      const { usage, notice } = usageOfTrace(built, priceUsage);
      expect(usage).toMatchObject({ costUsd: null, costBasis: "unavailable", model: "gpt-5.6-sol" });
      expect(notice).toBe("Cost excludes 703000 tokens from models without a price: gpt-5.6-sol.");
    });
  });

  describe("what each agent ran on, and tokens by model (delta 20260918 §4.3)", () => {
    const tokens = (model: string | null, inputTokens: number) => ({
      inputTokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      costBasis: "unavailable" as const,
      model,
      pricesUpdatedAt: null,
    });
    const ran = (model: string | null, thinkingOptionId: string | null, modeId: string | null) => ({ model, thinkingOptionId, modeId });
    const workerTurn = (n: number, overrides: Partial<TraceRecord>) =>
      record({ agentId: "w1", role: "worker", turnId: `w-${n}`, at: `2026-09-16T10:1${n}:00.000Z`, ...overrides });
    const show = (records: TraceRecord[], agents: AgentFacts[] = [agent({ id: "w1" })]) => {
      const built = trace(records, agents);
      return detail(built.trace, {
        agents: built.agents,
        workspaceState: "live",
        reassignedFrom: null,
        priceUsage,
        lookupBeads: () => ({ found: [], missing: [] }),
      });
    };
    const rowsOf = (shown: ReturnType<typeof show>, agentId: string) =>
      shown.usageByAgent.find((entry) => entry.agentId === agentId)?.runtime;

    it("one row per combination, with its turns, in the order first seen", () => {
      const shown = show([
        record({ sent: [msg("x")] }),
        workerTurn(1, { usage: tokens("claude-opus-5", 10), runtime: ran("claude-opus-5", null, "bypassPermissions") }),
        workerTurn(2, { usage: tokens("claude-opus-5", 10), runtime: ran("claude-opus-5", "high", "bypassPermissions") }),
        workerTurn(3, { usage: tokens("claude-opus-5", 10), runtime: ran("claude-opus-5", null, "bypassPermissions") }),
        workerTurn(4, { usage: tokens("claude-opus-5", 10), runtime: ran("claude-opus-5", null, "bypassPermissions") }),
      ]);

      expect(rowsOf(shown, "w1")).toEqual([
        { model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions", recorded: true, turns: 3 },
        { model: "claude-opus-5", thinkingOptionId: "high", modeId: "bypassPermissions", recorded: true, turns: 1 },
      ]);
    });

    it("an old turn keeps the model it recorded; only thinking and mode are unknown", () => {
      const shown = show([
        record({ sent: [msg("x")] }),
        workerTurn(1, { usage: tokens("claude-opus-5", 10) }),
        workerTurn(2, { usage: tokens("claude-opus-5", 10) }),
        workerTurn(3, {}),
      ]);

      expect(rowsOf(shown, "w1")).toEqual([
        { model: "claude-opus-5", thinkingOptionId: null, modeId: null, recorded: false, turns: 2 },
        { model: null, thinkingOptionId: null, modeId: null, recorded: false, turns: 1 },
      ]);
    });

    it("the Manager gets its rows too", () => {
      const shown = show([record({ sent: [msg("x")], usage: tokens("claude-opus-5", 5), runtime: ran("claude-opus-5", null, "bypassPermissions") })], []);

      expect(rowsOf(shown, MANAGER)).toEqual([
        { model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions", recorded: true, turns: 1 },
      ]);
    });

    it("tokens by model add up to the request's tokens, and their money to its cost", () => {
      const shown = show(
        [
          record({ sent: [msg("x")], usage: tokens("claude-opus-5", 1_000_000), runtime: ran("claude-opus-5", null, "bypassPermissions") }),
          workerTurn(1, { usage: tokens("claude-opus-5", 1_000_000) }),
          record({ agentId: "r1", role: "reviewer", turnId: "r", at: "2026-09-16T10:20:00.000Z", usage: tokens("gpt-5.6-sol", 300_000), runtime: ran("gpt-5.6-sol", null, "auto") }),
        ],
        [agent({ id: "w1" }), agent({ id: "r1", role: "reviewer", parentAgentId: "w1", batchIdLabel: "b1" })],
      );

      const byModel = shown.usageByModel ?? [];
      expect(byModel.map((entry) => entry.model)).toEqual(["claude-opus-5", "gpt-5.6-sol"]);
      expect(byModel.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)).toBe(shown.usage.inputTokens);
      expect(byModel[0]!.usage).toMatchObject({ costUsd: 10, costBasis: "estimated" });
      // No price for the Codex model: tokens only.
      expect(byModel[1]!.usage).toMatchObject({ inputTokens: 300_000, costUsd: null });
      expect(shown.usage.costUsd).toBe(byModel.reduce((sum, entry) => sum + (entry.usage.costUsd ?? 0), 0));
    });

    it("a summary splits its tokens by role and model, and the parts add up (REQ-058e)", () => {
      const records = [
        record({ sent: [msg("x")], usage: tokens("claude-opus-5", 1_000_000), runtime: ran("claude-opus-5", null, "bypassPermissions") }),
        workerTurn(1, { usage: tokens("claude-opus-5", 2_000_000) }),
        record({ agentId: "r1", role: "reviewer", turnId: "r", at: "2026-09-16T10:20:00.000Z", usage: tokens("gpt-5.6-sol", 300_000) }),
      ];
      const built = trace(records, [agent({ id: "w1" }), agent({ id: "r1", role: "reviewer", parentAgentId: "w1", batchIdLabel: "b1" })]);
      const summary = summarise(built.trace, { agents: built.agents, workspaceState: "live", reassignedFrom: null, priceUsage });

      expect(summary.usageByModelRole?.map((entry) => [entry.role, entry.model, entry.usage.inputTokens, entry.usage.costUsd])).toEqual([
        ["manager", "claude-opus-5", 1_000_000, 5],
        ["worker", "claude-opus-5", 2_000_000, 10],
        ["reviewer", "gpt-5.6-sol", 300_000, null],
      ]);
      expect(summary.usageByModelRole!.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)).toBe(summary.usage.inputTokens);
    });

    it("a profile that names no model is priced as the model that actually ran (Q38)", () => {
      // `usage.model` is the configured model (null here); `runtime.model` is what ran.
      const records = [record({ sent: [msg("x")], usage: tokens(null, 1_000_000), runtime: ran("claude-opus-5", null, "bypassPermissions") })];
      const { trace: built } = trace(records, []);

      const { usage, notice } = usageOfTrace(built, priceUsage);

      expect(usage).toMatchObject({ model: "claude-opus-5", costUsd: 5, costBasis: "estimated" });
      expect(notice).toBeNull();
    });
  });

  it("counts provider sub-agent traces per agent", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        evidence: [
          { kind: "agent", detail: "general — review", agentId: "w1", at: "2026-09-16T10:09:00.000Z" },
          { kind: "agent", detail: "general — review", agentId: "w1", at: "2026-09-16T10:09:30.000Z" },
        ],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    expect(subAgentTracesOf(built)).toEqual([
      { agentId: "w1", subAgentType: "general", description: "review", count: 2 },
    ]);
  });
});

describe("summary and detail", () => {
  it("builds a row with the excerpt, counts and workspace state", () => {
    const { trace: built, agents } = trace(baseRecords(), [agent({ id: "w1" })]);
    const summary = summarise(built, { agents, workspaceState: "archived", reassignedFrom: null });
    expect(summary).toMatchObject({
      requestId: "req-A",
      excerpt: "thêm màn hình báo cáo",
      state: "completed",
      workerIds: ["w1"],
      tier: "Small",
      workspaceState: "archived",
      reassignedFrom: null,
    });
    expect(summary.durationMs).toBe(600_000);
  });

  it("assembles detail with bead status, the timing basis and a missing-bead notice", () => {
    const records = [
      record({ sent: [msg("thêm màn hình báo cáo")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        sent: [msg("Your task\nrequestId: req-A", "2026-09-16T10:00:30.000Z")],
        reports: [report({ beadsCreated: ["bm-here", "bm-gone"] })],
      }),
    ];
    const { trace: built, agents } = trace(records, [agent({ id: "w1" })]);
    const full = detail(built, {
      agents,
      workspaceState: "live",
      reassignedFrom: null,
      lookupBeads: (ids) => ({
        found: ids.includes("bm-here") ? [{ id: "bm-here", title: "Here", status: "open" }] : [],
        missing: ids.filter((id) => id !== "bm-here"),
      }),
    });
    expect(full.beads).toEqual([
      { id: "bm-here", title: "Here", statusNow: "open", action: "created", confidence: "exact", evidence: expect.any(Array) },
      { id: "bm-gone", title: null, statusNow: null, action: "created", confidence: "exact", evidence: expect.any(Array) },
    ]);
    expect(full.notices.join(" ")).toContain("not in the workspace's bead store");
    expect(full.timing.basis).toBe(TIMING_BASIS);
    expect(full.sent.userRequest?.text).toBe("thêm màn hình báo cáo");
    expect(full.sent.workerInitialPrompts[0]?.text).toContain("requestId: req-A");
    expect(full.workflowSteps).toEqual([]);
  });

  it("does not take a plugin notice that opens a Worker turn for its initial prompt", () => {
    const worker = (turnId: string, text: string, at: string) =>
      record({ agentId: "w1", role: "worker", turnId, at, startedAt: at, endedAt: at, sent: [msg(text, at)] });
    const records = [
      record({ sent: [msg("thêm màn hình báo cáo")] }),
      worker("turn-1", "Your task\nrequestId: req-A", "2026-09-16T10:00:30.000Z"),
      worker(
        "turn-2",
        "BM-RESUME The provider is back; continue the request where you stopped.",
        "2026-09-16T10:02:00.000Z",
      ),
      worker("turn-3", "BM-STOP The user asked every Beads Worker and Reviewer in this workspace to stop.", "2026-09-16T10:03:00.000Z"),
    ];
    const { trace: built, agents } = trace(records, [agent({ id: "w1" })]);
    const full = detail(built, {
      agents,
      workspaceState: "live",
      reassignedFrom: null,
      lookupBeads: () => ({ found: [], missing: [] }),
    });
    expect(full.sent.workerInitialPrompts.map((message) => message.text)).toEqual(["Your task\nrequestId: req-A"]);
  });

  it("names a successor by its bm.handoffFrom label and holds it to its own checks, with no brief marker in its first message (autonomy design §G.6; live check F2)", () => {
    const shell = (agentId: string, at: string) => ({ kind: "shell" as const, detail: "npm test", agentId, at, status: "completed", exitCode: 0 });
    const records = [
      record({ sent: [msg("thêm màn hình báo cáo")] }),
      record({
        agentId: "w1",
        role: "worker",
        turnId: "w1-turn",
        at: "2026-09-16T10:05:00.000Z",
        startedAt: "2026-09-16T10:00:30.000Z",
        endedAt: "2026-09-16T10:05:00.000Z",
        sent: [msg("Your task\nrequestId: req-A", "2026-09-16T10:00:30.000Z")],
        evidence: [{ kind: "file", detail: "src/a.ts", agentId: "w1", at: "2026-09-16T10:01:00.000Z" }, shell("w1", "2026-09-16T10:02:00.000Z")],
      }),
      record({
        agentId: "w2",
        role: "worker",
        turnId: "w2-turn",
        at: "2026-09-16T10:10:00.000Z",
        startedAt: "2026-09-16T10:06:00.000Z",
        endedAt: "2026-09-16T10:10:00.000Z",
        sent: [msg("requestId: req-A\nrequest: thêm màn hình báo cáo", "2026-09-16T10:06:00.000Z")],
        reports: [report({ agentId: "w2", filesChanged: ["src/a.ts"], buildAndTests: "`npm test` pass" })],
      }),
    ];
    const facts = [agent({ id: "w1", replacedBy: "w2" }), agent({ id: "w2", createdAt: "2026-09-16T10:06:00.000Z", handoffFrom: "w1" })];
    const { trace: built, agents } = trace(records, facts);
    const full = detail(built, { agents, workspaceState: "live", reassignedFrom: null, lookupBeads: () => ({ found: [], missing: [] }) });
    expect(full.handoffs).toEqual([{ agentId: "w2", from: "w1" }]);
    expect(full.verification).toMatchObject({ checks: "self-reported", unverified: true });
    // Without the label the predecessor's run after the last edit counts, and the detail names no handoff.
    const plain = trace(records, [agent({ id: "w1" }), agent({ id: "w2", createdAt: "2026-09-16T10:06:00.000Z" })]);
    const unlabelled = detail(plain.trace, { agents: plain.agents, workspaceState: "live", reassignedFrom: null, lookupBeads: () => ({ found: [], missing: [] }) });
    expect(unlabelled.handoffs).toBeUndefined();
    expect(unlabelled.verification).toMatchObject({ checks: "detected", unverified: false });
  });
});

describe("pagination", () => {
  it("pages with an opaque cursor and reports truncation", () => {
    const rows = [1, 2, 3, 4, 5];
    const first = paginate(rows, 2);
    expect(first).toMatchObject({ page: [1, 2], nextCursor: "2", truncated: true });
    const second = paginate(rows, 2, first.nextCursor!);
    expect(second).toMatchObject({ page: [3, 4], nextCursor: "4", truncated: true });
    const third = paginate(rows, 2, second.nextCursor!);
    expect(third).toMatchObject({ page: [5], nextCursor: null, truncated: false });
    expect(paginate(rows, 2, "nonsense").page).toEqual([1, 2]);
  });
});

describe("read RPC handlers", () => {
  async function seed(): Promise<void> {
    const location = { tracesDir: join(home, "traces") };
    for (const entry of baseRecords()) await appendRecord(location, entry);
    clearTraceStoreCache();
  }

  it("lists traces newest first with the store size and notices", async () => {
    await seed();
    const paseo = daemonWith([
      { id: "w1", workspaceId: WS, status: "idle", createdAt: "2026-09-16T10:00:10.000Z", labels: { "bm.role": "worker", "bm.requestId": "req-A" } },
    ]);
    const result = await handleTracesList({ workspaceId: WS }, paseo);
    expect(result.traces).toHaveLength(1);
    expect(result.traces[0]).toMatchObject({ requestId: "req-A", workerIds: ["w1"], state: "completed" });
    expect(result.truncated).toBe(false);
    expect(result.store.workspaceBytes).toBeGreaterThan(0);
  });

  it("caps the page at the agreed limit", async () => {
    await seed();
    const result = await handleTracesList({ workspaceId: WS, limit: 999 }, daemonWith([]));
    expect(result.traces.length).toBeLessThanOrEqual(50);
  });

  it("gets one trace by id and fails a missing id with the coded error", async () => {
    await seed();
    const paseo = daemonWith([
      { id: "w1", workspaceId: WS, status: "idle", createdAt: "2026-09-16T10:00:10.000Z", labels: { "bm.role": "worker", "bm.requestId": "req-A" } },
    ]);
    const listed = await handleTracesList({ workspaceId: WS }, paseo);
    const traceId = listed.traces[0]!.traceId;

    const got = await handleTracesGet({ workspaceId: WS, traceId }, paseo);
    expect(got.trace.traceId).toBe(traceId);
    expect(got.trace.timing.basis).toBe(TIMING_BASIS);

    await expect(handleTracesGet({ workspaceId: WS, traceId: "req:nope" }, paseo)).rejects.toThrow(
      /E_TRACE_NOT_FOUND/,
    );
  });

  it("leaves the plugin's own /compact out of what the owner typed, read live from the Worker's timeline (autonomy design §G.5)", async () => {
    await seed();
    // The send log of the data folder the trace store lives in.
    createCompactionStore(home, { now: () => new Date("2026-09-16T10:05:00.000Z") }).logSend("w1", "/compact", "cmp-1");
    const typed = (text: string) => ({ type: "user_message", text, messageId: "m", clientMessageId: "c" });
    const paseo = fakePaseo<DashboardPaseo>({
      agents: [{ id: "w1", workspaceId: WS, status: "idle", createdAt: "2026-09-16T10:00:10.000Z", labels: { "bm.role": "worker", "bm.requestId": "req-A" } }],
      workspaces: [{ id: WS, directory: workspace }],
      timelines: {
        w1: [
          { item: typed("/compact"), timestamp: "2026-09-16T10:05:01.000Z" },
          { item: typed("use the contract only"), timestamp: "2026-09-16T10:06:00.000Z" },
        ],
      },
    }).paseo;
    const traceId = (await handleTracesList({ workspaceId: WS }, paseo)).traces[0]!.traceId;
    const { trace: got } = await handleTracesGet({ workspaceId: WS, traceId }, paseo);
    expect(got.userMessages.map((message) => message.text)).toEqual(["use the contract only"]);
  });

  it("reads absolute file evidence against the workspace directory in the workflow table (delta 20260917-workflow-skills §5.5)", async () => {
    const location = { tracesDir: join(home, "traces") };
    const [manager, worker] = baseRecords();
    await appendRecord(location, manager!);
    await appendRecord(location, {
      ...worker!,
      evidence: [{ kind: "file", detail: join(workspace, "docs", "design", "x.md"), agentId: "w1", at: "2026-09-16T10:05:00.000Z" }],
    });
    clearTraceStoreCache();
    const paseo = daemonWith([
      { id: "w1", workspaceId: WS, status: "idle", createdAt: "2026-09-16T10:00:10.000Z", labels: { "bm.role": "worker", "bm.requestId": "req-A" } },
    ]);
    const traceId = (await handleTracesList({ workspaceId: WS }, paseo)).traces[0]!.traceId;
    const steps = (await handleTracesGet({ workspaceId: WS, traceId }, paseo)).trace.workflowSteps;
    expect(steps.find((row) => row.step === "design")).toMatchObject({ status: "done", confidence: "inferred" });
    expect(steps.find((row) => row.step === "implement")?.status).not.toBe("done");
  });

  it("uses the store's last known directory for the workflow table when Paseo no longer lists the workspace (review bm-wp-220-nvk.1)", async () => {
    const location = { tracesDir: join(home, "traces") };
    const [manager, worker] = baseRecords();
    await appendRecord(location, manager!);
    await appendRecord(location, {
      ...worker!,
      evidence: [{ kind: "file", detail: join(workspace, "docs", "design", "x.md"), agentId: "w1", at: "2026-09-16T10:05:00.000Z" }],
    });
    writeWorkspaceMeta(location, WS, { lastKnownName: "repo", lastKnownDirectory: workspace, lastSeenAt: "2026-09-16T10:10:00.000Z" });
    clearTraceStoreCache();
    // The Worker is still listed; its workspace no longer is.
    const gone = daemonWith([{ id: "w1", workspaceId: WS, status: "idle", createdAt: "2026-09-16T10:00:10.000Z", labels: { "bm.role": "worker", "bm.requestId": "req-A" } }], []);
    const traceId = (await handleTracesList({ workspaceId: WS }, gone)).traces[0]!.traceId;
    const steps = (await handleTracesGet({ workspaceId: WS, traceId }, gone)).trace.workflowSteps;
    expect(steps.find((row) => row.step === "design")).toMatchObject({ status: "done", confidence: "inferred" });
  });

  it("survives an agents.list failure by reporting no agents rather than throwing", async () => {
    await seed();
    const fake = fakePaseo<DashboardPaseo>({ workspaces: [{ id: WS, directory: workspace }] });
    fake.api.agents.list.mockRejectedValue(new Error("no daemon"));
    const result = await handleTracesList({ workspaceId: WS }, fake.paseo);
    expect(result.traces[0]?.workerIds).toEqual([]);
  });
});

/**
 * WP-214 acceptance: two robustness rules that keep one bad record from
 * poisoning a trace. Both were found on the real store.
 */
describe("a report belongs to the request it names", () => {
  it("ignores a report for another request, even inside a record of this one", () => {
    // Defect 10 produced exactly this: one record carrying F-1's requestId and
    // holding F-2's reports. F-1 then read `stopped` at tier Medium off F-2's
    // report, while its own last report was a clean finish at tier Small.
    const records = [
      record({ requestId: "req-A", sent: [msg("làm giúp tôi việc A")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        requestId: "req-A",
        reports: [
          report({ requestId: "req-A", phase: "finished", tier: "Small", blockers: null, at: "2026-09-16T10:09:00.000Z" }),
          report({ requestId: "req-B", phase: "finished", tier: "Medium", blockers: "STOPPED", at: "2026-09-16T10:10:00.000Z" }),
        ],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    expect(built.reports.map((r) => r.requestId)).toEqual(["req-A"]);
    expect(built.tier).toBe("Small");
    expect(built.state).toBe("completed");
  });

  it("counts a report quoted twice only once", () => {
    const twice = (at: string) =>
      report({ requestId: "req-A", phase: "beads-done", agentId: "w1", at, beadsCreated: ["bm-a1"] });
    const records = [
      record({ requestId: "req-A", sent: [msg("làm giúp tôi việc A")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        requestId: "req-A",
        // The same milestone, parsed from the Worker's turn and from the
        // Manager turn that quoted it: two objects, one report.
        reports: [twice("2026-09-16T10:09:00.000Z"), twice("2026-09-16T10:09:00.000Z")],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    expect(built.reports).toHaveLength(1);
    expect(beadActionsOf(built).created.ids).toEqual(["bm-a1"]);
  });
});

/**
 * WP-214 F-3: the Worker reported `beadsUpdated: repo-cv6`, but the bead store
 * still showed repo-cv6's creation time, from before the request. The screen
 * must not repeat that claim as exact.
 */
describe("a reported update the bead store contradicts", () => {
  it("is downgraded to unknown and named in a notice", () => {
    const records = [
      record({ requestId: "req-A", sent: [msg("làm việc A")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        requestId: "req-A",
        reports: [report({ requestId: "req-A", beadsUpdated: ["bm-old", "bm-new"] })],
      }),
    ];
    const { trace: built, agents } = trace(records, [agent({ id: "w1" })]);
    const full = detail(built, {
      agents,
      workspaceState: "live",
      reassignedFrom: null,
      lookupBeads: () => ({
        found: [
          { id: "bm-old", title: null, status: "open", updatedAt: "2026-09-15T00:00:00.000Z" },
          { id: "bm-new", title: null, status: "open", updatedAt: "2026-09-16T10:05:00.000Z" },
        ],
        missing: [],
      }),
    });
    const updated = full.beads.filter((bead) => bead.action === "updated");
    expect(updated.find((bead) => bead.id === "bm-old")?.confidence).toBe("unknown");
    expect(updated.find((bead) => bead.id === "bm-new")?.confidence).toBe("exact");
    expect(full.notices.join(" ")).toContain("unchanged in the bead store since this request began: bm-old");
  });
});

describe("the request shown in the detail", () => {
  it("is the request text, not a report that happens to come first", () => {
    const records = [
      record({ turnId: "t0", at: "2026-09-16T09:59:00.000Z", sent: [msg("BM-REPORT\nrequestId: req-A\nphase: received", "2026-09-16T09:59:00.000Z")] }),
      record({ turnId: "t1", sent: [msg("thêm docstring cho format_date")] }),
    ];
    const { trace: built, agents } = trace(records, []);
    const full = detail(built, { agents, workspaceState: "live", reassignedFrom: null, lookupBeads: () => ({ found: [], missing: [] }) });
    expect(full.sent.userRequest?.text).toBe("thêm docstring cho format_date");
  });
});

describe("user messages and skills in a trace", () => {
  it("lists only messages marked as the user's, never unmarked old ones", () => {
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        sent: [
          { agentId: "w1", at: "2026-09-16T10:09:00.000Z", text: "typed by you", truncated: false, origin: "user" },
          { agentId: "w1", at: "2026-09-16T10:08:00.000Z", text: "relayed", truncated: false, origin: "agent" },
          { agentId: "w1", at: "2026-09-16T10:07:00.000Z", text: "written before origin existed", truncated: false },
        ],
      }),
    ];
    const { trace: built, agents } = trace(records, [agent({ id: "w1" })]);
    expect(userMessagesOf(built).map((message) => message.text)).toEqual(["typed by you"]);
    expect(summarise(built, { agents, workspaceState: "live", reassignedFrom: null }).userMessageCount).toBe(1);
  });

  it("lists each agent's skills once, oldest first", () => {
    const skill = (detail: string, at: string) => ({ kind: "skill" as const, detail, agentId: "w1", at });
    const records = [
      record({ sent: [msg("x")] }),
      record({
        agentId: "w1",
        role: "worker",
        at: "2026-09-16T10:10:00.000Z",
        evidence: [
          skill("implementing-beads", "2026-09-16T10:05:00.000Z"),
          skill("feature-workflow", "2026-09-16T10:01:00.000Z"),
          skill("feature-workflow", "2026-09-16T10:06:00.000Z"),
        ],
      }),
    ];
    const { trace: built } = trace(records, [agent({ id: "w1" })]);
    expect(skillsOf(built).map((entry) => entry.skill)).toEqual(["feature-workflow", "implementing-beads"]);
    // Skill evidence is not a workflow step.
    expect(inferWorkflowSteps(built).every((row) => row.evidence.every((entry) => entry.kind !== "skill"))).toBe(true);
  });
});

/**
 * Autonomy design §G.2 Shown: `traces.agents` — each agent's tokens and
 * context, over one request or over its life, every turn read with the metric
 * module's `turnTokensOf` beside the agent's turn before it.
 */
describe("tokens and context per agent (traces.agents)", () => {
  const usage = (input: number, cached: number, extra: Partial<NonNullable<TraceRecord["usage"]>> = {}): NonNullable<TraceRecord["usage"]> => ({
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: 500,
    costUsd: null,
    costBasis: "unavailable",
    model: null,
    pricesUpdatedAt: null,
    ...extra,
  });
  const claude = { model: "claude-opus-5", thinkingOptionId: null, modeId: "default" };
  const codex = { model: "gpt-5.6-sol", thinkingOptionId: null, modeId: "full-access" };
  const turn = (agentId: string, role: TraceRecord["role"], at: string, overrides: Partial<TraceRecord> = {}) =>
    record({ agentId, role, turnId: `${agentId}-${at}`, at, startedAt: at, endedAt: at, ...overrides });

  const manager1 = turn(MANAGER, "manager", "2026-09-16T10:00:00.000Z", {
    runtime: claude,
    usage: usage(1_000, 9_000, { contextUsed: 10_000, contextMax: 200_000 }),
    toolCalls: 2,
  });
  const manager2 = turn(MANAGER, "manager", "2026-09-16T11:00:00.000Z", {
    runtime: claude,
    usage: usage(2_000, 18_000, { contextUsed: 30_000, contextMax: 200_000 }),
    toolCalls: 1,
  });
  // Codex: its input holds its cached tokens, and it reports the last model call only.
  const worker1 = turn("w1", "worker", "2026-09-16T10:05:00.000Z", { runtime: codex, usage: usage(50_000, 40_000), toolCalls: 3 });
  const worker2 = turn("w1", "worker", "2026-09-16T10:09:00.000Z", {
    runtime: codex,
    usage: usage(70_000, 60_000),
    toolCalls: 5,
    evidence: [{ kind: "compaction", detail: "auto", agentId: "w1", at: "2026-09-16T10:08:00.000Z", trigger: "auto", preTokens: null }],
  });
  // Claude with its tool calls counted: the context is an estimate, tokens read ÷ (tool calls + 1).
  const worker3 = turn("w2", "worker", "2026-09-16T11:05:00.000Z", { runtime: claude, usage: usage(1_000, 99_000), toolCalls: 4 });
  const reviewer = turn("r1", "reviewer", "2026-09-16T10:07:00.000Z");

  it("reads each turn by its provider: Codex's input alone and a lower bound, a reported context, an estimate, a turn without usage", () => {
    const all = [worker3, reviewer, worker2, manager2, manager1, worker1];
    expect(agentTokenFiguresOf(all)).toEqual([
      {
        agentId: MANAGER,
        role: "manager",
        turns: 2,
        turnsWithUsage: 2,
        tokensRead: 30_000,
        lastCallTurns: 0,
        contextTrend: [10_000, 30_000],
        contextTurns: 2,
        contextEstimated: 0,
        contextPeak: 30_000,
        contextMax: 200_000,
        compactions: 0,
      },
      {
        agentId: "w1",
        role: "worker",
        turns: 2,
        turnsWithUsage: 2,
        tokensRead: 120_000,
        lastCallTurns: 2,
        contextTrend: [50_000, 70_000],
        contextTurns: 2,
        contextEstimated: 2,
        contextPeak: 70_000,
        contextMax: null,
        compactions: 1,
      },
      {
        agentId: "w2",
        role: "worker",
        turns: 1,
        turnsWithUsage: 1,
        tokensRead: 100_000,
        lastCallTurns: 0,
        contextTrend: [20_000],
        contextTurns: 1,
        contextEstimated: 1,
        contextPeak: 20_000,
        contextMax: null,
        compactions: 0,
      },
      {
        agentId: "r1",
        role: "reviewer",
        turns: 1,
        turnsWithUsage: 0,
        tokensRead: 0,
        lastCallTurns: 0,
        contextTrend: [],
        contextTurns: 0,
        contextEstimated: 0,
        contextPeak: null,
        contextMax: null,
        compactions: 0,
      },
    ]);
  });

  it("counts only the turns in scope and the agents kept, and takes the role from the agent list first", () => {
    const all = [manager1, worker1, worker2, manager2, worker3];
    const scoped = agentTokenFiguresOf(all, { scope: new Set([manager2, worker3]), roleOf: (id) => (id === "w2" ? "unknown" : undefined) });
    expect(scoped.map((entry) => [entry.agentId, entry.role, entry.turns, entry.tokensRead, entry.contextTrend])).toEqual([
      [MANAGER, "manager", 1, 20_000, [30_000]],
      ["w2", "unknown", 1, 100_000, [20_000]],
    ]);
    expect(agentTokenFiguresOf(all, { keep: (id) => id === "w1" }).map((entry) => entry.agentId)).toEqual(["w1"]);
  });

  it("knows an OpenCode turn that repeated the counts of the agent's turn before it, even when that turn is out of scope", () => {
    const opencode = { model: "openai/gpt-5", thinkingOptionId: null, modeId: null };
    const first = turn("w3", "worker", "2026-09-16T12:00:00.000Z", { runtime: opencode, usage: usage(40_000, 10_000), toolCalls: 2 });
    const repeated = turn("w3", "worker", "2026-09-16T12:05:00.000Z", { runtime: opencode, usage: usage(40_000, 10_000), toolCalls: 0 });
    const [figures] = agentTokenFiguresOf([first, repeated], { scope: new Set([repeated]) });
    expect(figures).toMatchObject({ turns: 1, turnsWithUsage: 1, tokensRead: 0, lastCallTurns: 1, contextTrend: [], contextTurns: 0 });
  });

  it("sends at most the newest points of a long trend, with its peak and count over the whole scope", () => {
    const turns = Array.from({ length: CONTEXT_TREND_MAX + 6 }, (_, index) =>
      turn(MANAGER, "manager", new Date(Date.parse("2026-09-16T10:00:00.000Z") + index * 60_000).toISOString(), {
        runtime: claude,
        usage: usage(1_000, 1_000, { contextUsed: index === 0 ? 150_000 : 1_000 * (index + 1), contextMax: 200_000 }),
      }),
    );
    const [figures] = agentTokenFiguresOf(turns);
    expect(figures!.contextTrend).toHaveLength(CONTEXT_TREND_MAX);
    expect(figures!.contextTrend.at(-1)).toBe(30_000);
    expect(figures!.contextTurns).toBe(CONTEXT_TREND_MAX + 6);
    expect(figures!.contextPeak).toBe(150_000);
    expect(tracesAgentsRpc.output.parse({ agents: [figures] }).agents).toHaveLength(1);
  });

  describe("the handler", () => {
    const listed = (id: string, role: string, extra: Record<string, unknown> = {}) => ({
      id,
      workspaceId: WS,
      status: "idle",
      createdAt: "2026-09-16T10:00:10.000Z",
      labels: { "bm.role": role, ...(role === "manager" ? {} : { "bm.requestId": "req-A" }) },
      ...extra,
    });

    async function seedTurns(): Promise<void> {
      const location = { tracesDir: join(home, "traces") };
      await appendRecord(location, { ...manager1, sent: [msg("add the report screen")] });
      await appendRecord(location, { ...worker1, reports: [report({ phase: "received", at: worker1.at })] });
      await appendRecord(location, { ...worker2, reports: [report({ at: worker2.at })] });
      await appendRecord(location, { ...reviewer, requestId: "req-A" });
      clearTraceStoreCache();
    }

    it("without a request: each agent Paseo lists and has not archived, over its life", async () => {
      await seedTurns();
      const paseo = daemonWith([listed(MANAGER, "manager"), listed("w1", "worker"), listed("r1", "reviewer", { archivedAt: "2026-09-17T00:00:00.000Z" })]);
      const result = await handleTracesAgents({ workspaceId: WS }, paseo);
      expect(result.agents.map((entry) => [entry.agentId, entry.role, entry.tokensRead])).toEqual([
        [MANAGER, "manager", 10_000],
        ["w1", "worker", 120_000],
      ]);
      expect(tracesAgentsRpc.output.parse(result).agents).toHaveLength(2);
    });

    it("with a request: every agent of it, listed or not; an unknown request fails with the coded error", async () => {
      await seedTurns();
      const paseo = daemonWith([listed("w1", "worker")]);
      const traceId = (await handleTracesList({ workspaceId: WS }, paseo)).traces[0]!.traceId;
      const result = await handleTracesAgents({ workspaceId: WS, traceId }, paseo);
      expect(result.agents.map((entry) => entry.agentId)).toEqual(expect.arrayContaining([MANAGER, "w1"]));
      expect(result.agents.find((entry) => entry.agentId === "w1")).toMatchObject({ turns: 2, lastCallTurns: 2, compactions: 1 });
      await expect(handleTracesAgents({ workspaceId: WS, traceId: "req:nope" }, paseo)).rejects.toThrow(/E_TRACE_NOT_FOUND/);
    });
  });
});
