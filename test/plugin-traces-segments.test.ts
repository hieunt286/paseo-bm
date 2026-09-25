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

/**
 * How many times a request went wrong, whatever the reason
 * (delta 20260925 §3.4, REQ-069 g).
 *
 * The rule the counting exists for: adding a request's rows up must count each
 * failure exactly once — not once per turn row, and not once per source that saw
 * the same death.
 */
describe("errors of a request", () => {
  const WORKER = "agent-worker";
  const workerFacts = (status: string): AgentFacts & { id: string } => ({
    id: WORKER,
    role: "worker",
    status,
    parentAgentId: MANAGER,
    createdAt: "2026-09-17T09:01:00.000Z",
    requestIdLabel: REQ,
    batchIdLabel: null,
    archived: false,
  });
  const workerTurn = (at: string, outcome: TraceRecord["outcome"]) =>
    record({ agentId: WORKER, role: "worker", at, endedAt: at, turnId: `worker-${at.slice(14, 16)}`, outcome });
  const withWorker = (agents: Array<AgentFacts & { id: string }>, records: TraceRecord[]) =>
    reconstructTraces({ records, agents: [reviewerFacts, ...agents] }).find((t) => t.requestId === REQ)!;

  it("counts a failed turn on the row it happened in, and nothing when nothing failed", () => {
    const clean = summarise(traceOf(conversation()), deps);
    expect(clean.errors).toEqual({ failedTurns: 0, agentErrors: 0, fallbacks: 0 });

    const records = [...conversation(), workerTurn("2026-09-17T09:06:00.000Z", "failed")];
    const rows = summariseSegments(withWorker([], records), deps);
    expect(rows.map((row) => row.errors!.failedTurns)).toEqual([1, 0]);
  });

  it("keeps the request's own errors on the opening row, so a sum over the rows counts each once", () => {
    const records = [...conversation(), workerTurn("2026-09-17T09:06:00.000Z", "failed")];
    const withFallbacks = { ...deps, agents: new Map([[WORKER, workerFacts("idle")]]), fallbacksOf: () => 2 };
    const rows = summariseSegments(withWorker([workerFacts("idle")], records), withFallbacks);
    expect(rows.map((row) => row.errors)).toEqual([
      { failedTurns: 1, agentErrors: 0, fallbacks: 2 },
      { failedTurns: 0, agentErrors: 0, fallbacks: 0 },
    ]);
    const total = rows.reduce(
      (sum, row) => sum + row.errors!.failedTurns + row.errors!.agentErrors + row.errors!.fallbacks,
      0,
    );
    expect(total).toBe(3);
  });

  it("counts an agent left in error only when no failed turn of its own was recorded", () => {
    // Killed before the collector wrote anything: nothing else counts it.
    const noRecord = withWorker([workerFacts("error")], conversation());
    expect(summarise(noRecord, { ...deps, agents: new Map([[WORKER, workerFacts("error")]]) }).errors).toEqual({
      failedTurns: 0,
      agentErrors: 1,
      fallbacks: 0,
    });

    // The usual case: the agent's own turn failed, so the failure is already counted.
    const records = [...conversation(), workerTurn("2026-09-17T09:06:00.000Z", "failed")];
    const withRecord = withWorker([workerFacts("error")], records);
    expect(summarise(withRecord, { ...deps, agents: new Map([[WORKER, workerFacts("error")]]) }).errors).toEqual({
      failedTurns: 1,
      agentErrors: 0,
      fallbacks: 0,
    });
  });

  it("reports no fallback incident when nobody tells it about them", () => {
    expect(summarise(traceOf(conversation()), deps).errors!.fallbacks).toBe(0);
  });
});

/**
 * The case review b2 found: a Worker that died on the FOLLOW-UP turn and was
 * left in Paseo's `error` status. Row 1 must not count it as an agent error
 * while row 2 counts its failed turn — that is one death, and the Errors card
 * adds the rows up.
 */
describe("a request whose last turn died", () => {
  const WORKER = "agent-worker";
  const worker: AgentFacts & { id: string } = {
    id: WORKER,
    role: "worker",
    status: "error",
    parentAgentId: MANAGER,
    createdAt: "2026-09-17T09:01:00.000Z",
    requestIdLabel: REQ,
    batchIdLabel: null,
    archived: false,
  };

  it("counts the death once across the rows, not once per row", () => {
    const records = [
      turn("2026-09-17T09:00:00.000Z", "Sửa giúp tôi cái CI đang đỏ", "user", 100),
      turn("2026-09-17T09:10:00.000Z", "Tiện thể thêm cả test cho case rỗng", "user", 7),
      // The failed turn belongs to the SECOND question.
      record({
        agentId: WORKER,
        role: "worker",
        at: "2026-09-17T09:12:00.000Z",
        endedAt: "2026-09-17T09:12:00.000Z",
        turnId: "worker-12",
        outcome: "failed",
      }),
    ];
    const trace = reconstructTraces({ records, agents: [worker] }).find((t) => t.requestId === REQ)!;
    const withAgents = { ...deps, agents: new Map([[WORKER, worker]]) };
    const rows = summariseSegments(trace, withAgents);
    expect(rows.map((row) => row.errors)).toEqual([
      { failedTurns: 0, agentErrors: 0, fallbacks: 0 },
      { failedTurns: 1, agentErrors: 0, fallbacks: 0 },
    ]);
    const total = rows.reduce(
      (sum, row) => sum + row.errors!.failedTurns + row.errors!.agentErrors + row.errors!.fallbacks,
      0,
    );
    expect(total).toBe(1);
    // And the whole request says the same number.
    expect(summarise(trace, withAgents).errors).toEqual({ failedTurns: 1, agentErrors: 0, fallbacks: 0 });
  });
});
