import { describe, expect, it } from "vitest";
import { reconstructTraces, summarise, summariseSegments, type AgentFacts } from "../plugin/server/traces";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * One row per turn the user opened, instead of one row per request
 * (delta 20260917e §4.3).
 *
 * The split is easy; what must NOT be split is the point. Review calls are
 * counted per `requestId` — give each turn its own count and a user who asks
 * three follow-ups silently gets three times the reviews their tier allows,
 * which is the one thing the budget exists to stop (owner decision Q23).
 */

const WS = "wks_1";
const MANAGER = "agent-manager";
const REQ = "req-20260917T090000Z";

const deps = { agents: new Map(), workspaceState: "live" as const, reassignedFrom: null };

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-17T09:00:00.000Z",
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: REQ,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-17T09:00:00.000Z",
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

const said = (text: string, at: string, origin?: "user" | "agent") => ({
  agentId: MANAGER,
  at,
  text,
  truncated: false,
  ...(origin === undefined ? {} : { origin }),
});

const usage = (outputTokens: number) => ({
  inputTokens: 1,
  cachedInputTokens: 0,
  outputTokens,
  costUsd: null,
  costBasis: "unavailable" as const,
  model: "claude-opus-5",
  pricesUpdatedAt: null,
});

const turn = (at: string, text: string, origin: "user" | "agent", outputTokens: number) =>
  record({
    at,
    endedAt: at,
    turnId: `foreground-turn-${at.slice(14, 16)}`,
    sent: [said(text, at, origin)],
    usage: usage(outputTokens),
  });

const REVIEWER = "agent-reviewer";

/**
 * Two questions from the user, a Worker status update between them, and one
 * review call that happens inside the FIRST question only.
 *
 * The review call is what makes the budget assertion real: counted per turn,
 * turn 2 would report a different number from the request.
 */
const conversation = (): TraceRecord[] => [
  turn("2026-09-17T09:00:00.000Z", "Sửa giúp tôi cái CI đang đỏ", "user", 100),
  record({
    agentId: REVIEWER,
    role: "reviewer",
    at: "2026-09-17T09:03:00.000Z",
    endedAt: "2026-09-17T09:03:00.000Z",
    turnId: "reviewer-turn-1",
    sent: [said("Review batch b1 of this change.", "2026-09-17T09:03:00.000Z", "agent")],
  }),
  turn("2026-09-17T09:05:00.000Z", "Status update: đang chạy test", "agent", 20),
  turn("2026-09-17T09:10:00.000Z", "Tiện thể thêm cả test cho case rỗng", "user", 7),
];

/** The Reviewer has to be a known agent of the request for its calls to count. */
const reviewerFacts: AgentFacts & { id: string } = {
  id: REVIEWER,
  role: "reviewer",
  status: "idle",
  parentAgentId: "agent-worker",
  createdAt: "2026-09-17T09:02:00.000Z",
  requestIdLabel: REQ,
  batchIdLabel: null,
  archived: false,
};

const traceOf = (records: TraceRecord[]) =>
  reconstructTraces({ records, agents: [reviewerFacts] }).find((t) => t.requestId === REQ)!;

describe("summariseSegments", () => {
  it("returns one row per turn, numbered and counted", () => {
    const rows = summariseSegments(traceOf(conversation()), deps);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.turn)).toEqual([
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ]);
  });

  it("gives each row the time and the words of its own question", () => {
    const rows = summariseSegments(traceOf(conversation()), deps);
    expect(rows[0]!.requestedAt).toBe("2026-09-17T09:00:00.000Z");
    expect(rows[0]!.excerpt).toBe("Sửa giúp tôi cái CI đang đỏ");
    expect(rows[1]!.requestedAt).toBe("2026-09-17T09:10:00.000Z");
    expect(rows[1]!.excerpt).toBe("Tiện thể thêm cả test cho case rỗng");
  });

  it("counts each turn's own tokens, and together they still add up", () => {
    const rows = summariseSegments(traceOf(conversation()), deps);
    // 100 + 20 for the first turn (the status update arrived inside it), 7 for
    // the second.
    expect(rows[0]!.usage.outputTokens).toBe(120);
    expect(rows[1]!.usage.outputTokens).toBe(7);
    const whole = summarise(traceOf(conversation()), deps);
    expect(rows[0]!.usage.outputTokens + rows[1]!.usage.outputTokens).toBe(whole.usage.outputTokens);
  });

  it("every row points at the same request, so opening any of them lands there", () => {
    const rows = summariseSegments(traceOf(conversation()), deps);
    expect(new Set(rows.map((row) => row.traceId)).size).toBe(1);
    expect(new Set(rows.map((row) => row.requestId))).toEqual(new Set([REQ]));
  });

  /**
   * The load-bearing case. Splitting the review budget per turn would multiply
   * the tier's allowance by how often the user spoke.
   */
  it("keeps the request-level figures whole on every row", () => {
    const trace = traceOf(conversation());
    const whole = summarise(trace, deps);
    expect(whole.reviewCalls).toBe(1);
    for (const row of summariseSegments(trace, deps)) {
      // The load-bearing one: turn 2 has no Reviewer record, so a per-turn
      // count would read `null` here while the request counted 1.
      expect(row.reviewCalls).toBe(whole.reviewCalls);
      expect(row.guardrailReported).toEqual(whole.guardrailReported);
      expect(row.state).toBe(whole.state);
      expect(row.tier).toBe(whole.tier);
      expect(row.linking).toBe(whole.linking);
      expect(row.workerIds).toEqual(whole.workerIds);
      expect(row.reviewerIds).toEqual(whole.reviewerIds);
    }
  });

  it("leaves a request nobody followed up exactly as it was", () => {
    const once = [turn("2026-09-17T09:00:00.000Z", "Sửa giúp tôi cái CI đang đỏ", "user", 100)];
    const rows = summariseSegments(traceOf(once), deps);
    expect(rows).toHaveLength(1);
    // `null`, not `{ index: 1, total: 1 }`: such a row must show no turn label.
    expect(rows[0]!.turn).toBeNull();
    expect(rows[0]).toEqual(summarise(traceOf(once), deps));
  });
});
