/**
 * The trace of the request that just had a turn, rebuilt once per finished turn
 * (Orchestrator design §4.1, §6.2), and the `RuleInput` the rules read from it.
 *
 * `review-budget.ts` rebuilt this on its own; the rules need the same trace,
 * so the rebuild lives here and every check shares it.
 * Built from the store's records and the live agent list, the same way the
 * Dashboard builds it (Dashboard design §6) — never from `traces.get`, so
 * there is no pricing, no bead lookup and no timeline read.
 */
import type { RuleAgent, RuleInput, RuleMessage } from "../shared/rule-input";
import type { TraceRecord } from "../shared/contracts";
import { byAt } from "../shared/order";
import { agentFactsOf, reviewerReplacementsFor, type DashboardPaseo } from "./dashboard-rpc";
import { brActions } from "./shell";
import { readRecords, type TraceStoreLocation } from "./trace-store";
import {
  agentTiming,
  beadActionsOf,
  reconstructTraces,
  type AgentFacts,
  type ReconstructedTrace,
} from "./traces";

export interface RequestTraceDeps {
  location: TraceStoreLocation;
  paseo: DashboardPaseo;
  /**
   * The install home, whose `role-fallback-state.json` names the Reviewers
   * that replaced a stopped one (delta 20260921 §4.5.1); looked up otherwise.
   */
  home?: string | null;
  /**
   * Every paseo-bm agent on the host, already listed by `bmAgentsOf`. A caller
   * that reads many workspaces lists the agents once and hands them in here;
   * without it, `agents.list` is walked for this workspace alone.
   */
  allAgents?: ReadonlyArray<{ workspaceId: string | null; facts: AgentFacts }>;
}

/** One workspace's traces, with the records and agents they were rebuilt from. */
export interface WorkspaceTraces {
  records: TraceRecord[];
  agents: Map<string, AgentFacts>;
  traces: ReconstructedTrace[];
}

/** One request's trace, with the agent facts `ruleInputOf` needs beside it. */
export interface RequestTrace {
  trace: ReconstructedTrace;
  agents: Map<string, AgentFacts>;
}

/**
 * Every trace of one workspace. Call it only after the collector has written
 * the turn that triggered it, or that turn is missing from the result.
 */
export async function workspaceTracesOf(deps: RequestTraceDeps, workspaceId: string): Promise<WorkspaceTraces> {
  const records = readRecords(deps.location, workspaceId).records;
  // A replacement Reviewer's first message is the stopped Reviewer's
  // review call sent again, not a new one (delta 20260921 §4.5.1).
  const [agents, replacementIds] = await Promise.all([
    deps.allAgents === undefined
      ? agentFactsOf(deps.paseo, workspaceId)
      : new Map(
          deps.allAgents
            .filter((entry) => entry.workspaceId === workspaceId)
            .map((entry) => [entry.facts.id, entry.facts] as const),
        ),
    reviewerReplacementsFor({ home: deps.home }),
  ]);
  const traces = reconstructTraces({ records, agents: [...agents.values()], replacementIds });
  return { records, agents, traces };
}

/** The request a Worker or Reviewer belongs to, or undefined when it is linked to none. */
export function traceOfAgent(traces: readonly ReconstructedTrace[], agentId: string): ReconstructedTrace | undefined {
  return traces.find((candidate) => candidate.workerIds.includes(agentId) || candidate.reviewerIds.includes(agentId));
}

/**
 * The request a Manager's newest recorded turn belongs to: a Manager serves
 * many requests, and the turn that just ended is the one that counts.
 */
export function traceOfManagerTurn(
  traces: readonly ReconstructedTrace[],
  managerAgentId: string,
): ReconstructedTrace | undefined {
  let newest: { trace: ReconstructedTrace; at: string } | undefined;
  for (const trace of traces) {
    for (const record of trace.records) {
      if (record.agentId !== managerAgentId || record.role !== "manager") continue;
      if (newest === undefined || record.at > newest.at) newest = { trace, at: record.at };
    }
  }
  return newest?.trace;
}

/** The trace of the request a Worker or Reviewer belongs to, or null. */
export async function requestTraceOf(
  deps: RequestTraceDeps,
  workspaceId: string,
  agentId: string,
): Promise<RequestTrace | null> {
  const { agents, traces } = await workspaceTracesOf(deps, workspaceId);
  const trace = traceOfAgent(traces, agentId);
  return trace === undefined ? null : { trace, agents };
}

function messagesOf(records: readonly TraceRecord[], pick: (record: TraceRecord) => TraceRecord["sent"]): RuleMessage[] {
  return records
    .flatMap((record) =>
      pick(record).map((message) => ({
        agentId: record.agentId,
        role: record.role,
        at: message.at,
        text: message.text,
        truncated: message.truncated,
        origin: message.origin ?? null,
      })),
    )
    .sort(byAt);
}

/**
 * What the rules read about one request. Pure: the trace and the agent facts it
 * was rebuilt from in, one `RuleInput` out. `agents` gives the live status and
 * creation time; everything else comes from the trace's own records.
 */
export function ruleInputOf(trace: ReconstructedTrace, agents: ReadonlyMap<string, AgentFacts>): RuleInput {
  const beads = beadActionsOf(trace);
  const evidence = trace.records.flatMap((record) => record.evidence).sort(byAt);
  const agentOf = (agentId: string, role: RuleAgent["role"]): RuleAgent => {
    const timing = agentTiming(agentId, role, trace, agents);
    return {
      agentId,
      role,
      status: agents.get(agentId)?.status ?? null,
      state: timing.state,
      startedAt: timing.startedAt,
      lastActivityAt: timing.lastActivityAt,
    };
  };
  return {
    traceId: trace.traceId,
    requestId: trace.requestId,
    requestedAt: trace.requestedAt,
    managerAgentId: trace.managerAgentId,
    workerIds: [...trace.workerIds],
    reviewerIds: [...trace.reviewerIds],
    tier: trace.tier,
    state: trace.state,
    linking: trace.linking,
    agentsMissing: [...trace.agentsMissing],
    reviewCalls: trace.reviewCalls,
    beadCounts: {
      created: { count: beads.created.ids.length, confidence: beads.created.confidence },
      updated: { count: beads.updated.ids.length, confidence: beads.updated.confidence },
      closed: { count: beads.closed.ids.length, confidence: beads.closed.confidence },
      ready: { count: beads.ready.ids.length, confidence: beads.ready.confidence },
    },
    filesChanged: [...new Set(trace.reports.flatMap((report) => report.filesChanged))],
    fileEdits: evidence.filter((entry) => entry.kind === "file"),
    brCreates: evidence.filter(
      (entry) => entry.kind === "shell" && brActions(entry.detail).some((action) => action.verb === "create"),
    ),
    turns: trace.records.map((record) => ({
      agentId: record.agentId,
      role: record.role,
      turnId: record.turnId,
      at: record.at,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      outcome: record.outcome,
    })),
    agents: [
      ...trace.workerIds.map((id) => agentOf(id, "worker")),
      ...trace.reviewerIds.map((id) => agentOf(id, "reviewer")),
    ],
    reports: [...trace.reports],
    inbound: messagesOf(trace.records, (record) => record.sent),
    managerReplies: messagesOf(
      trace.records.filter((record) => record.role === "manager"),
      (record) => record.received,
    ),
  };
}
