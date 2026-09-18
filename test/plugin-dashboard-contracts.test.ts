import { describe, expect, it } from "vitest";
import {
  DASHBOARD_ERROR_CODES,
  DashboardError,
  TRACE_LIST_LIMIT,
  TRACE_STORE_SCHEMA_VERSION,
  beadStatsSchema,
  chatPeerSchema,
  beadsStatsRpc,
  traceDetailSchema,
  traceDeleteScopeSchema,
  traceRecordSchema,
  traceStoreMetaSchema,
  traceSummarySchema,
  traceWorkspaceMetaSchema,
  tracesDeleteRpc,
  tracesGetRpc,
  tracesListRpc,
  tracesReassignRpc,
  usageSchema,
  type TraceDetail,
  type TraceRecord,
  type TraceSummary,
} from "../plugin/shared/contracts";

/**
 * WP-201: the Dashboard contracts and the persisted record schema.
 *
 * These are a public provider boundary *and* an on-disk format, so the tests
 * assert both directions: a valid sample parses, and a malformed one is
 * rejected. A silently accepted bad shape here becomes a migration later.
 */

const usage = {
  inputTokens: 1200,
  cachedInputTokens: 800,
  outputTokens: 350,
  costUsd: 0.0125,
  costBasis: "estimated" as const,
  model: "claude-opus-5",
  pricesUpdatedAt: "2026-06-24",
};

const summary: TraceSummary = {
  traceId: "agent-manager:42",
  requestId: "req-20260916T091500Z",
  turn: null,
  requestedAt: "2026-09-16T09:15:00.000Z",
  excerpt: "thêm màn hình xuất báo cáo theo tháng",
  state: "completed",
  workerIds: ["agent-worker"],
  reviewerIds: ["agent-reviewer-1", "agent-reviewer-2"],
  messageCount: 12,
  userMessageCount: 1,
  workerUsage: [{ agentId: "agent-worker", title: "Worker — màn báo cáo", usage }],
  reviewCalls: 3,
  guardrailReported: {
    batchId: "batch-1",
    batchReviews: 2,
    batchMax: 2,
    polish: 1,
    polishMax: 1,
    total: 3,
    budget: 6,
    userAllowedExtra: 0,
    raw: "batch batch-1 reviews 2/2; polish 1/1; total 3/6; userAllowedExtra 0",
  },
  durationMs: 742_000,
  usage,
  beadCounts: {
    created: { count: 2, confidence: "exact" },
    updated: { count: 1, confidence: "inferred" },
    closed: { count: 0, confidence: "unknown" },
    ready: { count: 1, confidence: "exact" },
  },
  tier: "Medium",
  linking: "exact",
  agentsMissing: [],
  workspaceState: "live",
  reassignedFrom: null,
  notices: [],
};

const detail: TraceDetail = {
  ...summary,
  sent: {
    userRequest: { agentId: null, at: summary.requestedAt, text: "thêm màn hình…", truncated: false },
    workerInitialPrompts: [
      { agentId: "agent-worker", at: summary.requestedAt, text: "requestId: req-…", truncated: true },
    ],
    reviewRequests: [
      {
        agentId: "agent-reviewer-1",
        at: "2026-09-16T09:20:00.000Z",
        text: "review batch-1",
        truncated: false,
        batchId: "batch-1",
      },
    ],
  },
  received: {
    reports: [
      {
        agentId: "agent-worker",
        at: "2026-09-16T09:18:00.000Z",
        requestId: summary.requestId,
        phase: "beads-done",
        tier: "Medium",
        filesChanged: ["docs/design/foo.md"],
        beadsCreated: ["bm-a1b"],
        beadsUpdated: [],
        beadsClosed: [],
        beadsReady: ["bm-a1b"],
        reviewFindingsOpen: null,
        buildAndTests: "npm test — pass",
        blockers: null,
        guardrail: summary.guardrailReported,
        unparsedFields: ["someFutureField"],
        incompleteFields: [],
        skillsUsed: [],
      },
    ],
    reviews: [
      {
        agentId: "agent-reviewer-1",
        at: "2026-09-16T09:25:00.000Z",
        batchId: "batch-1",
        verdict: "changes-required",
        blockingCount: 1,
      },
    ],
    managerReplies: [
      { agentId: "agent-manager", at: "2026-09-16T09:30:00.000Z", text: "đã xong", truncated: false },
    ],
  },
  timing: {
    totalMs: 742_000,
    managerTurns: [
      { turnId: "turn-1", startedAt: summary.requestedAt, endedAt: "2026-09-16T09:16:00.000Z", ms: 60_000 },
    ],
    workers: [
      {
        agentId: "agent-worker",
        role: "worker",
        startedAt: summary.requestedAt,
        lastActivityAt: "2026-09-16T09:27:00.000Z",
        ms: 720_000,
        state: "completed",
      },
    ],
    reviewers: [],
    basis: "Thời gian treo, gồm cả thời gian chờ người dùng trả lời.",
  },
  usageByAgent: [{ agentId: "agent-worker", role: "worker", usage }],
  beads: [
    {
      id: "bm-a1b",
      title: "Xuất báo cáo tháng",
      statusNow: "open",
      action: "created",
      confidence: "exact",
      evidence: [
        { kind: "report", detail: "BM-REPORT phase=beads-done", agentId: "agent-worker", at: null },
      ],
    },
  ],
  workflowSteps: [
    {
      step: "convert_to_beads",
      status: "done",
      confidence: "exact",
      evidence: [{ kind: "shell", detail: "br create bm-a1b", agentId: "agent-worker", at: null }],
      note: null,
    },
    { step: "polish_beads", status: "skipped", confidence: "exact", evidence: [], note: "tier Medium" },
    { step: "prd", status: "unknown", confidence: "unknown", evidence: [], note: null },
  ],
  subAgentTraces: [
    { agentId: "agent-worker", subAgentType: "general", description: null, count: 2 },
  ],
  userMessages: [
    { agentId: "agent-worker", at: "2026-09-16T09:19:00.000Z", text: "dùng cột amount_xu", truncated: false, origin: "user" },
  ],
  skills: [{ agentId: "agent-worker", skill: "feature-workflow", at: "2026-09-16T09:16:00.000Z" }],
};

const record: TraceRecord = {
  v: TRACE_STORE_SCHEMA_VERSION,
  kind: "turn",
  at: "2026-09-16T09:18:00.000Z",
  workspaceId: "wks_1",
  agentId: "agent-worker",
  role: "worker",
  turnId: "turn-7",
  requestId: summary.requestId,
  parentAgentId: "agent-manager",
  agentCreatedAt: summary.requestedAt,
  startedAt: "2026-09-16T09:17:00.000Z",
  endedAt: "2026-09-16T09:18:00.000Z",
  outcome: "completed",
  sent: [],
  received: [],
  reports: detail.received.reports,
  reviews: [],
  evidence: [],
  usage,
};

describe("Dashboard data contracts", () => {
  it("parses a full TraceSummary and TraceDetail", () => {
    expect(traceSummarySchema.parse(summary)).toEqual(summary);
    expect(traceDetailSchema.parse(detail)).toEqual(detail);
  });

  it("parses BeadStats including the empty-store shape", () => {
    const stats = {
      total: 0,
      open: 0,
      inProgress: 0,
      blocked: 0,
      closed: 0,
      ready: 0,
      readAt: "2026-09-16T09:00:00.000Z",
      source: "/repo/.beads/issues.jsonl",
      skippedLines: 0,
      present: false,
    };
    expect(beadStatsSchema.parse(stats).present).toBe(false);
  });

  it("rejects a summary that is missing a required field", () => {
    const withoutLinking: Record<string, unknown> = { ...summary };
    delete withoutLinking.linking;
    expect(() => traceSummarySchema.parse(withoutLinking)).toThrow();
  });

  it("rejects an unknown enum value instead of passing it through", () => {
    expect(() => traceSummarySchema.parse({ ...summary, state: "almost-done" })).toThrow();
    expect(() => traceSummarySchema.parse({ ...summary, linking: "probably" })).toThrow();
    expect(() => traceSummarySchema.parse({ ...summary, workspaceState: "deleted" })).toThrow();
  });

  it("rejects a negative or fractional token count", () => {
    expect(() => usageSchema.parse({ ...usage, inputTokens: -1 })).toThrow();
    expect(() => usageSchema.parse({ ...usage, outputTokens: 1.5 })).toThrow();
  });

  it("keeps costUsd nullable so an unknown model can report tokens only", () => {
    const unknownModel = { ...usage, costUsd: null, costBasis: "unavailable" as const, model: "mystery" };
    expect(usageSchema.parse(unknownModel).costUsd).toBeNull();
  });
});

describe("persisted trace schema v1", () => {
  it("parses a record and both meta shapes", () => {
    expect(traceRecordSchema.parse(record)).toEqual(record);
    expect(
      traceStoreMetaSchema.parse({
        schemaVersion: TRACE_STORE_SCHEMA_VERSION,
        createdAt: record.at,
        updatedAt: record.at,
      }).schemaVersion,
    ).toBe(1);
    expect(
      traceWorkspaceMetaSchema.parse({
        lastKnownName: "paseo-bm",
        lastKnownDirectory: "/repo",
        lastSeenAt: record.at,
      }).lastKnownName,
    ).toBe("paseo-bm");
  });

  it("requires the turn kind and a known outcome", () => {
    expect(() => traceRecordSchema.parse({ ...record, kind: "message" })).toThrow();
    expect(() => traceRecordSchema.parse({ ...record, outcome: "interrupted" })).toThrow();
  });

  it("accepts a record whose optional links are null", () => {
    const sparse = { ...record, turnId: null, requestId: null, parentAgentId: null, agentCreatedAt: null, startedAt: null, usage: null };
    expect(traceRecordSchema.parse(sparse).usage).toBeNull();
  });

  // delta 20260918 §4.2 / §7: `runtime` is an ADDED optional field, so the
  // store's version does not move and nothing migrates.
  describe("the added runtime field", () => {
    const runtime = { model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions" };
    const withoutRuntimeField = traceRecordSchema.omit({ runtime: true });

    it("a new record parses with a reader that predates the field, which drops it", () => {
      const parsed = withoutRuntimeField.parse({ ...record, runtime });
      expect(parsed).not.toHaveProperty("runtime");
      expect(parsed.usage).toEqual(record.usage);
    });

    it("an old record without it parses with the new reader; null is accepted too", () => {
      expect(traceRecordSchema.parse(record)).not.toHaveProperty("runtime");
      expect(traceRecordSchema.parse({ ...record, runtime: null }).runtime).toBeNull();
      expect(traceRecordSchema.parse({ ...record, runtime }).runtime).toEqual(runtime);
    });

    it("leaves the record and store version at 1", () => {
      expect(TRACE_STORE_SCHEMA_VERSION).toBe(1);
      expect(traceRecordSchema.parse({ ...record, runtime }).v).toBe(1);
    });
  });
});

describe("Dashboard RPC contracts", () => {
  it("names the five RPCs", () => {
    expect([
      tracesListRpc.name,
      tracesGetRpc.name,
      tracesDeleteRpc.name,
      tracesReassignRpc.name,
      beadsStatsRpc.name,
    ]).toEqual(["traces.list", "traces.get", "traces.delete", "traces.reassign", "beads.stats"]);
  });

  it("caps the trace page at the agreed limit", () => {
    expect(TRACE_LIST_LIMIT).toBe(50);
    expect(tracesListRpc.input.parse({ workspaceId: "wks_1", limit: 50 }).limit).toBe(50);
    expect(() => tracesListRpc.input.parse({ workspaceId: "wks_1", limit: 51 })).toThrow();
    expect(() => tracesListRpc.input.parse({ workspaceId: "wks_1", limit: 0 })).toThrow();
  });

  it("requires exactly one delete scope shape", () => {
    expect(traceDeleteScopeSchema.parse({ traceId: "t-1" })).toEqual({ traceId: "t-1" });
    expect(traceDeleteScopeSchema.parse({ before: "2026-09-01T00:00:00.000Z" })).toBeTruthy();
    expect(traceDeleteScopeSchema.parse({ allOfWorkspace: true })).toBeTruthy();
    expect(() => traceDeleteScopeSchema.parse({})).toThrow();
    expect(() => traceDeleteScopeSchema.parse({ allOfWorkspace: false })).toThrow();
    expect(() => traceDeleteScopeSchema.parse({ traceId: "" })).toThrow();
  });

  it("requires both workspace ids to reassign", () => {
    expect(() => tracesReassignRpc.input.parse({ fromWorkspaceId: "wks_1" })).toThrow();
    expect(
      tracesReassignRpc.input.parse({ fromWorkspaceId: "wks_1", toWorkspaceId: "wks_2", dryRun: true }).dryRun,
    ).toBe(true);
  });

  it("rejects an empty workspace id on every RPC", () => {
    for (const rpc of [tracesListRpc, tracesGetRpc, beadsStatsRpc]) {
      expect(() => rpc.input.parse({ workspaceId: "", traceId: "t-1" })).toThrow();
    }
  });
});

describe("Dashboard error codes", () => {
  it("registers exactly the approved codes", () => {
    expect([...DASHBOARD_ERROR_CODES]).toEqual([
      "E_TIMELINE_UNAVAILABLE",
      "E_BEADS_STORE_UNREADABLE",
      "E_TRACE_NOT_FOUND",
      "E_TRACE_STORE_UNWRITABLE",
      "E_TRACE_STORE_SCHEMA_TOO_NEW",
      "E_TRACE_REASSIGN_INVALID",
      // Beads screen delta, 2026-09-16.
      "E_BEAD_NOT_FOUND",
      // Setup screen delta, 2026-09-16.
      "E_ROLE_EXTRA_INVALID",
      "E_TOOL_PRESENT",
      "E_TOOL_INSTALL_FAILED",
    ]);
  });

  it("puts the code at the start of the message so a transport that only forwards message keeps it", () => {
    const error = new DashboardError("E_TRACE_NOT_FOUND", "trace t-9 is gone");
    expect(error.message).toBe("E_TRACE_NOT_FOUND: trace t-9 is gone");
    expect(error.code).toBe("E_TRACE_NOT_FOUND");
    expect(error.name).toBe("DashboardError");
  });
});

describe("chat.peers carries whether an agent is archived (delta 20260918f F12)", () => {
  const peer = { id: "w1", role: "worker", title: null, status: "idle", parentId: null, requestId: "req-1", batchId: null };
  it("requires the archived flag", () => {
    expect(chatPeerSchema.parse({ ...peer, archived: true }).archived).toBe(true);
    expect(chatPeerSchema.safeParse(peer).success).toBe(false);
  });
});
