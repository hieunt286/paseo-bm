import { describe, expect, it } from "vitest";
import { reconstructTraces, summarise, type AgentFacts } from "../plugin/server/traces";
import { inferWorkflowSteps } from "../plugin/server/workflow-steps";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-214 D-1: "the list appears within 3 seconds with up to 20 agents and up to
 * 500 traces".
 *
 * The acceptance run could only measure the server tier on the real store, and
 * that store held two requests — three orders of magnitude below the threshold.
 * This builds the stated worst case so the claim is measured rather than
 * extrapolated. It also guards the shape of the algorithm: the pass that
 * attaches an unnamed Manager turn to the request named next was quadratic in
 * Manager turns when first written, which only shows up at this size.
 */
const MANAGER = "agent-manager";
const TRACES = 500;
const AGENTS = 20;
/** A tenth of the user-facing budget, leaving the rest for I/O and rendering. */
const BUDGET_MS = 300;

function buildStore(): { records: TraceRecord[]; agents: AgentFacts[] } {
  const records: TraceRecord[] = [];
  const agents: AgentFacts[] = [];
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (offsetMs: number) => new Date(base + offsetMs).toISOString();

  for (let index = 0; index < TRACES; index += 1) {
    const requestId = `req-2026010${index % 10}T${String(index).padStart(6, "0")}Z`;
    const start = index * 600_000;
    const workerId = `worker-${index % AGENTS}`;

    const record = (overrides: Partial<TraceRecord>): TraceRecord => ({
      v: TRACE_STORE_SCHEMA_VERSION,
      kind: "turn",
      at: at(start),
      workspaceId: "wks_bench",
      agentId: MANAGER,
      role: "manager",
      turnId: `turn-${index}`,
      requestId: null,
      parentAgentId: null,
      agentCreatedAt: null,
      startedAt: at(start),
      endedAt: at(start),
      outcome: "completed",
      sent: [],
      received: [],
      reports: [],
      reviews: [],
      evidence: [],
      usage: { inputTokens: 10, cachedInputTokens: 1000, outputTokens: 50, costUsd: null, costBasis: "unavailable", model: "claude-opus-5", pricesUpdatedAt: null },
      ...overrides,
    });

    const message = (text: string, offset: number) => ({
      agentId: MANAGER,
      at: at(start + offset),
      text,
      truncated: false,
    });

    // The realistic shape: an unnamed request turn, then the Manager's report
    // turns, then the Worker's own turns with evidence.
    records.push(record({ sent: [message(`yêu cầu số ${index}`, 0)] }));
    records.push(
      record({
        at: at(start + 60_000),
        requestId,
        sent: [message(`BM-REPORT\nrequestId: ${requestId}\nphase: received\ntier: Medium`, 60_000)],
      }),
    );
    records.push(
      record({
        at: at(start + 300_000),
        agentId: workerId,
        role: "worker",
        requestId,
        turnId: `w-turn-${index}`,
        evidence: [
          { kind: "shell", detail: `br create "bead ${index}" -t task -l "feature:f${index}"`, agentId: workerId, at: at(start + 120_000) },
          { kind: "shell", detail: `br close bm-${index} -r "done with evidence"`, agentId: workerId, at: at(start + 240_000) },
          { kind: "file", detail: `src/module-${index}.ts`, agentId: workerId, at: at(start + 180_000) },
        ],
      }),
    );
  }

  for (let index = 0; index < AGENTS; index += 1) {
    agents.push({
      id: `worker-${index}`,
      role: "worker",
      status: "idle",
      parentAgentId: MANAGER,
      createdAt: at(index * 600_000 + 30_000),
      requestIdLabel: null,
      batchIdLabel: null,
      archived: false,
    });
  }
  return { records, agents };
}

describe("reconstruction at D-1's stated scale", () => {
  it(`rebuilds ${TRACES} requests over ${AGENTS} agents well inside the budget`, () => {
    const { records, agents } = buildStore();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));

    const started = performance.now();
    const built = reconstructTraces({ records, agents });
    const rows = built.map((trace) =>
      summarise(trace, { agents: byId, workspaceState: "live", reassignedFrom: null }),
    );
    const elapsed = performance.now() - started;

    // One row per request, plus the "could not be linked" group.
    expect(rows.filter((row) => row.traceId !== "unknown")).toHaveLength(TRACES);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it("builds the workflow table for every row inside the same budget", () => {
    const { records, agents } = buildStore();
    const built = reconstructTraces({ records, agents });

    const started = performance.now();
    for (const trace of built) inferWorkflowSteps(trace, {});
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});
