/**
 * The rows the Dashboard shows of a rebuilt trace (WP-206.1.2; Dashboard
 * Design §4.2, §4.3, §7.4; code review 2026-09-30 §4): one summary per request
 * or per turn the user opened (`traces.list`), the full detail (`traces.get`),
 * the errors, and the page of rows.
 *
 * Pure, like the rebuild it reads (`traces.ts`): the timing and bead actions
 * come from `trace-timing.ts`, the tokens from `trace-usage.ts`, and anything
 * that needs a file or the SDK (prices, bead lookup, the workflow table,
 * fallback incidents) is injected.
 */
import { isPluginNotice } from "./notices";
import { requestFinishOf } from "../shared/evidence";
import { byAt, uniqueBy } from "../shared/order";
import type {
  Confidence,
  SubAgentTrace,
  TraceBead,
  TraceDetail,
  TraceErrors,
  TraceMessage,
  TraceSummary,
  TraceVerification,
  Usage,
  WorkflowStepResult,
  WorkspaceState,
} from "../shared/contracts";
import { handoffSuccessorsOf, type AgentFacts, type ReconstructedTrace } from "./traces";
import { TIMING_BASIS, agentTiming, beadActionsOf, managerTurns, totalMsOf } from "./trace-timing";
import { runtimeRowsOf, usageByModelOf, usageByModelRoleOf, usageOfAgent, usageOfTrace } from "./trace-usage";

/** Sub-agent traces of a trace: provider-internal agents, counted per parent (REQ-042e). */
export function subAgentTracesOf(trace: ReconstructedTrace): SubAgentTrace[] {
  const byAgent = new Map<string, { subAgentType: string | null; description: string | null; count: number }>();
  for (const record of trace.records) {
    for (const evidence of record.evidence) {
      if (evidence.kind !== "agent") continue;
      const current = byAgent.get(record.agentId) ?? { subAgentType: null, description: null, count: 0 };
      const [type, description] = evidence.detail.split(" — ");
      byAgent.set(record.agentId, {
        subAgentType: current.subAgentType ?? (type ?? null),
        description: current.description ?? (description ?? null),
        count: current.count + 1,
      });
    }
  }
  return [...byAgent.entries()].map(([agentId, value]) => ({ agentId, ...value }));
}

export interface SummariseDeps {
  agents: ReadonlyMap<string, AgentFacts>;
  workspaceState: WorkspaceState;
  reassignedFrom: string | null;
  /**
   * Applies the price table to a token sum (WP-209). Injected so this module
   * never has to know about money; without it the row reports tokens only.
   */
  priceUsage?: (usage: Usage) => Usage;
  /**
   * How many provider-plan incidents of this request did not fail a turn
   * (delta 20260925 §3.4). Injected, because the incidents live in a file this
   * module does not read; without it the row reports none.
   */
  fallbacksOf?: (requestId: string | null) => number;
  /**
   * The workspace folder, so a report's file paths are matched against the
   * records' (autonomy design §C.2); without it a relative path matches an
   * absolute one ending in it.
   */
  workspaceDirectory?: string | null;
}

/**
 * The request's finish, labelled (autonomy design §C.3, §C.6): its latest
 * report when that is `finished`, against every record of the trace; none
 * otherwise. It belongs to the request, so a per-turn row carries the whole
 * trace's (`summariseSegments`).
 */
export function verificationOf(trace: ReconstructedTrace, deps: Pick<SummariseDeps, "agents" | "workspaceDirectory">): TraceVerification | null {
  return requestFinishOf({
    reports: trace.reports,
    records: trace.records,
    workspaceDirectory: deps.workspaceDirectory ?? null,
    // Autonomy design §G.6 step 5: a successor, known by its label, proves again.
    handoffSuccessors: new Set(handoffSuccessorsOf(trace, deps.agents).keys()),
  });
}

/**
 * The errors of a whole trace, whatever their reason (delta 20260925 §3.4).
 *
 * `failedTurns` is of the records it is given, so a per-turn row gets its own
 * count. The other two belong to the request, and `summariseSegments` keeps them
 * on the opening row so adding a request's rows up counts each failure once.
 */
export function errorsOf(trace: ReconstructedTrace, deps: SummariseDeps): TraceErrors {
  const failedTurns = trace.records.filter((record) => record.outcome === "failed").length;
  // An agent in `error` almost always wrote a failed turn first; only one killed
  // before that is a failure nothing else counted.
  const failedAgents = new Set(
    trace.records.filter((record) => record.outcome === "failed").map((record) => record.agentId),
  );
  const agentErrors = [...trace.workerIds, ...trace.reviewerIds].filter((id) => {
    const agent = deps.agents.get(id);
    return agent?.status === "error" && !failedAgents.has(id);
  }).length;
  return { failedTurns, agentErrors, fallbacks: deps.fallbacksOf?.(trace.requestId) ?? 0 };
}

/**
 * What the user typed directly to an agent of this request, oldest first.
 *
 * Only messages the collector marked `origin: "user"`; a record written before
 * that field existed says nothing either way and contributes nothing.
 */
export function userMessagesOf(trace: ReconstructedTrace): TraceMessage[] {
  const out: TraceMessage[] = [];
  for (const record of trace.records) {
    for (const message of record.sent) {
      if (message.origin === "user") out.push({ ...message, agentId: record.agentId });
    }
  }
  return out.sort(byAt);
}

/** Skills each agent loaded, oldest first, one entry per agent and skill. */
export function skillsOf(trace: ReconstructedTrace): Array<{ agentId: string; skill: string; at: string | null }> {
  const all = trace.records.flatMap((record) =>
    record.evidence
      .filter((entry) => entry.kind === "skill")
      .map((entry) => ({ agentId: entry.agentId ?? record.agentId, skill: entry.detail, at: entry.at })),
  );
  return uniqueBy(all.sort(byAt), (entry) => `${entry.agentId}|${entry.skill}`);
}

/** One row for `traces.list` (design §4.2). */
export function summarise(trace: ReconstructedTrace, deps: SummariseDeps): TraceSummary {
  const beads = beadActionsOf(trace);
  const total = usageOfTrace(trace, deps.priceUsage);
  const verification = verificationOf(trace, deps);
  return {
    traceId: trace.traceId,
    requestId: trace.requestId,
    requestedAt: trace.requestedAt,
    excerpt: trace.requestText === null ? null : (trace.requestText.split("\n")[0]?.slice(0, 200) ?? ""),
    turn: null,
    state: trace.state,
    workerIds: trace.workerIds,
    reviewerIds: trace.reviewerIds,
    reviewCalls: trace.reviewCalls,
    guardrailReported: trace.guardrailReported,
    durationMs: totalMsOf(trace),
    usage: total.usage,
    errors: errorsOf(trace, deps),
    messageCount: trace.records.reduce((count, record) => count + record.sent.length + record.received.length, 0),
    userMessageCount: userMessagesOf(trace).length,
    workerUsage: trace.workerIds.map((agentId) => ({
      agentId,
      title: deps.agents.get(agentId)?.title ?? null,
      usage: usageOfAgent(trace, agentId, deps.priceUsage),
    })),
    usageByModelRole: usageByModelRoleOf(trace, deps.priceUsage),
    beadCounts: {
      created: { count: beads.created.ids.length, confidence: beads.created.confidence },
      updated: { count: beads.updated.ids.length, confidence: beads.updated.confidence },
      closed: { count: beads.closed.ids.length, confidence: beads.closed.confidence },
      ready: { count: beads.ready.ids.length, confidence: beads.ready.confidence },
    },
    tier: trace.tier,
    linking: trace.linking,
    agentsMissing: trace.agentsMissing,
    workspaceState: deps.workspaceState,
    reassignedFrom: deps.reassignedFrom,
    notices: total.notice === null ? trace.notices : [...trace.notices, total.notice],
    ...(verification === null ? {} : { verification }),
  };
}

/**
 * One row per turn the user opened, instead of one row per request.
 *
 * The owner asked for each follow-up to be its own flow rather than being
 * folded into a row that is hard to trace (delta 20260917e §4.3, decision Q23:
 * the Dashboard splits, the `requestId` does not).
 *
 * What is split and what is not matters more than the split itself:
 * - **split**, because it belongs to one turn — when it was asked, what was
 *   asked, the tokens, the duration, the messages, the beads its reports name;
 * - **kept whole**, because it belongs to the request — the review calls above
 *   all. Counting those per turn would hand a user who asks three follow-ups
 *   three times the reviews their tier allows, which is the very thing the
 *   budget exists to stop. Also whole: the state, tier, linking, and the agents,
 *   which are the request's, not a turn's.
 *
 * A request nobody followed up returns exactly one row with `turn: null`, so
 * nothing changes for it.
 */
export function summariseSegments(trace: ReconstructedTrace, deps: SummariseDeps): TraceSummary[] {
  const whole = summarise(trace, deps);
  if (trace.segments.length <= 1) return [whole];
  const total = trace.segments.length;
  return trace.segments.map((segment) => {
    const part = summarise(
      {
        ...trace,
        records: segment.records,
        reports: segment.reports,
        requestedAt: segment.startedAt,
        requestText: segment.text,
      },
      deps,
    );
    return {
      ...part,
      turn: { index: segment.index, total },
      // `failedTurns` is this turn's; the other two are the request's, so they
      // stay on the opening row — the rule by which a request counts once
      // however many turns it has (owner decision Q27), and
      // what keeps a sum over the rows from counting one failure twice
      // (delta 20260925 §3.4).
      //
      // They come from `whole`, never from `part`: `errorsOf` suppresses an
      // agent error that already has a failed turn record, and a segment only
      // sees its own records. A Worker that died on the follow-up turn would
      // otherwise count as an agent error on row 1 AND a failed turn on row 2.
      errors: {
        failedTurns: part.errors?.failedTurns ?? 0,
        agentErrors: segment.index === 1 ? (whole.errors?.agentErrors ?? 0) : 0,
        fallbacks: segment.index === 1 ? (whole.errors?.fallbacks ?? 0) : 0,
      },
      // Notices are the request's, and `summarise` derives one of them from the
      // records it was given — which here are a single turn's. Everything else
      // request-level (review calls, state, tier, linking, the agents) is
      // carried through untouched by `summarise`, so it needs no override; the
      // suite pins that invariant so a future change cannot start splitting it.
      notices: whole.notices,
      // The finish is the request's (autonomy design §C.3): every row carries the whole trace's, or none.
      verification: whole.verification,
    };
  });
}

export interface DetailDeps extends SummariseDeps {
  /** Current title and status of the beads a trace names (WP-208 lookup). */
  lookupBeads: (ids: readonly string[]) => {
    found: Array<{ id: string; title: string | null; status: string; updatedAt?: string }>;
    missing: string[];
  };
  /**
   * Feature-workflow table (WP-207). Injected rather than imported so this
   * module stays free of the inference rules, and so a caller that does not
   * want the table can leave it out.
   */
  workflowSteps?: (trace: ReconstructedTrace, beadStatus: (id: string) => string | null) => WorkflowStepResult[];
}

/** Full detail for `traces.get` (design §4.3). */
export function detail(trace: ReconstructedTrace, deps: DetailDeps): TraceDetail {
  const summary = summarise(trace, deps);
  const actions = beadActionsOf(trace);

  const allIds = [
    ...new Set([...actions.created.ids, ...actions.updated.ids, ...actions.closed.ids, ...actions.ready.ids]),
  ];
  const { found, missing } = deps.lookupBeads(allIds);
  const currentById = new Map(found.map((bead) => [bead.id, bead]));

  const beadRows: TraceBead[] = [];
  // A reported update is checked against the store: a bead whose `updated_at`
  // is older than the request was not touched by it. WP-214 F-3: the Worker
  // listed `repo-cv6` under beadsUpdated while the store still showed its
  // creation time, and the screen repeated the claim as exact.
  const contradicted: string[] = [];
  const pushRows = (ids: readonly string[], action: TraceBead["action"], confidence: Confidence) => {
    for (const id of ids) {
      const current = currentById.get(id);
      const untouched =
        action === "updated" &&
        current?.updatedAt !== undefined &&
        current.updatedAt !== "" &&
        current.updatedAt < trace.requestedAt;
      if (untouched) contradicted.push(id);
      beadRows.push({
        id,
        title: current?.title ?? null,
        statusNow: current?.status ?? null,
        action,
        confidence: untouched ? "unknown" : confidence,
        evidence: actions.evidenceById.get(id) ?? [],
      });
    }
  };
  pushRows(actions.created.ids, "created", actions.created.confidence);
  pushRows(actions.updated.ids, "updated", actions.updated.confidence);
  pushRows(actions.closed.ids, "closed", actions.closed.confidence);
  pushRows(actions.ready.ids, "ready", actions.ready.confidence);

  const notices = [...summary.notices];
  if (missing.length > 0) {
    notices.push(`${missing.length} reported bead(s) are not in the workspace's bead store.`);
  }
  if (contradicted.length > 0) {
    notices.push(
      `Reported as updated, but unchanged in the bead store since this request began: ${contradicted.join(", ")}.`,
    );
  }

  // A Worker record's first message is its prompt only when a person or the
  // Manager wrote it: a plugin notice that opens a Worker turn (a `BM-STOP`,
  // a `BM-RESUME`) is not.
  const workerPrompts = trace.records
    .filter((record) => record.role === "worker")
    .flatMap((record) => record.sent.slice(0, 1))
    .filter((message) => !isPluginNotice(message.text));
  const reviewRequests = trace.records
    .filter((record) => record.role === "reviewer")
    .flatMap((record) =>
      record.sent.map((message) => ({ ...message, batchId: /batch[\s:-]*([A-Za-z0-9._-]+)/i.exec(message.text)?.[1] ?? null })),
    );
  const managerReplies = trace.records
    .filter((record) => record.role === "manager")
    .flatMap((record) => record.received);

  // The Workers that took the request over by a handoff (autonomy design §G.6), so Work's timeline shows it.
  const handoffs = [...handoffSuccessorsOf(trace, deps.agents)].map(([agentId, from]) => ({ agentId, from }));

  return {
    ...summary,
    notices,
    ...(handoffs.length === 0 ? {} : { handoffs }),
    sent: {
      // The message reconstruction chose as the request. The first Manager
      // record's first message can be a Worker's BM-REPORT instead.
      userRequest:
        trace.records
          .filter((record) => record.role === "manager")
          .flatMap((record) => record.sent)
          .find((message) => message.text === trace.requestText) ?? null,
      workerInitialPrompts: workerPrompts,
      reviewRequests,
    },
    received: {
      reports: trace.reports,
      reviews: trace.reviews,
      managerReplies,
    },
    timing: {
      totalMs: summary.durationMs,
      managerTurns: managerTurns(trace),
      workers: trace.workerIds.map((id) => agentTiming(id, "worker", trace, deps.agents)),
      reviewers: trace.reviewerIds.map((id) => agentTiming(id, "reviewer", trace, deps.agents)),
      basis: TIMING_BASIS,
    },
    usageByAgent: [...new Set(trace.records.map((record) => record.agentId))].map((agentId) => ({
      agentId,
      role: deps.agents.get(agentId)?.role ?? trace.records.find((record) => record.agentId === agentId)?.role ?? "unknown",
      usage: usageOfAgent(trace, agentId, deps.priceUsage),
      runtime: runtimeRowsOf(trace, agentId),
    })),
    usageByModel: usageByModelOf(trace, deps.priceUsage),
    beads: beadRows,
    workflowSteps:
      deps.workflowSteps?.(trace, (id) => currentById.get(id)?.status ?? null) ?? [],
    subAgentTraces: subAgentTracesOf(trace),
    userMessages: userMessagesOf(trace),
    skills: skillsOf(trace),
  };
}

/** One page of rows, oldest cursor semantics: an opaque index into the sorted list. */
export function paginate<T>(rows: readonly T[], limit: number, cursor?: string): { page: T[]; nextCursor: string | null; truncated: boolean } {
  const start = cursor === undefined ? 0 : Math.max(0, Number.parseInt(cursor, 10) || 0);
  const page = rows.slice(start, start + limit);
  const nextIndex = start + page.length;
  const hasMore = nextIndex < rows.length;
  return { page: [...page], nextCursor: hasMore ? String(nextIndex) : null, truncated: hasMore };
}
