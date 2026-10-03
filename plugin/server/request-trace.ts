/**
 * The trace of the request that just had a turn, rebuilt once per finished turn
 * (Orchestrator design §4.1, §6), and the `RuleInput` the rules read from it.
 *
 * `review-budget.ts` rebuilt this on its own; the rules need the same trace,
 * so the rebuild lives here and every check shares it.
 * Built from the store's records and the live agent list (Dashboard design
 * §6) — never from `traces.get`, so there is no pricing, no bead lookup and no
 * timeline read. The Dashboard's `readTraceContext` rebuilds through
 * `workspaceTracesOf` too, so both read one rebuild (code review 2026-09-30
 * §4).
 *
 * It also keeps what the Orchestrator's tools, `orchestrator.state` and the
 * watchers read of a rebuilt trace (`firstLine`, `requestKeyOf`,
 * `lastActivityOf`, `waitingSinceOf`), so none of them imports another's
 * module for it (code review 2026-09-30 §4), and their one scan of recent
 * requests (`recentWorkspacesOf`, `recentTracesOf`, §3.5).
 */
import type { RuleInput, RuleMessage, RuleReviewGrant } from "../shared/rule-input";
import type { ParsedReport, TraceRecord, TraceWorkspaceMeta } from "../shared/contracts";
import { isFinishedUnverified, requestFinishOf, verificationOf, type RequestFinish } from "../shared/evidence";
import { byAt } from "../shared/order";
import { redactText } from "./collector";
import { errorText } from "./rpc-kit";
import { reviewerReplacementsFor } from "./fallback-state";
import { agentFactsOf, type DashboardPaseo } from "./paseo-directory";
import { readRecords, readWorkspaceMeta, storedWorkspaceIds, type TraceStoreLocation } from "./trace-store";
import { handoffSuccessorsOf, reconstructTraces, reviewCallsOf, toolCallsOf, type AgentFacts, type ReconstructedTrace } from "./traces";
import { createRequestRegistry, type RegisteredRequest } from "./request-registry";
import { timeOrZero } from "../shared/time";
import { dirname } from "node:path";

export interface RequestTraceDeps {
  location: TraceStoreLocation;
  paseo: DashboardPaseo;
  /**
   * The install home, whose `role-fallback-state.json` names the Reviewers
   * that replaced a stopped one (delta 20260921 §4.5.1); looked up otherwise.
   */
  home?: string | null;
  /**
   * Those Reviewers, when the caller has read the incidents already (the
   * Dashboard reads them once for this and for the error count); read from
   * `home` otherwise.
   */
  replacementIds?: ReadonlySet<string>;
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
  /** The workspace's requests in the request registry, as the rebuild read them (`registeredRequestsOf`). */
  requests: RegisteredRequest[];
  /** What reading the store had to say: a newer schema, unreadable lines (`readRecords`). */
  notices: string[];
}

/** The longest first line of a request in `bm_projects`. */
export const REQUEST_LINE_MAX_CHARS = 200;

/** The first non-empty line of `text`, redacted and cut; `bm_projects` and `orchestrator.state` use it. */
export function firstLine(text: string | null, env: NodeJS.ProcessEnv): string | null {
  if (text === null) return null;
  const line = redactText(text, env)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return null;
  // One line, always: `cutText` would put its truncation marker on lines of its own.
  const chars = [...line];
  return chars.length <= REQUEST_LINE_MAX_CHARS ? line : `${chars.slice(0, REQUEST_LINE_MAX_CHARS - 1).join("")}…`;
}

/**
 * The key a request's stall situations are stored under (design §5.4):
 * its request id, or its trace id when it has none.
 */
export function requestKeyOf(trace: Pick<ReconstructedTrace, "requestId" | "traceId">): string {
  return trace.requestId ?? trace.traceId;
}

/** The newest time anything of the request was recorded. */
export function lastActivityOf(trace: ReconstructedTrace): string {
  let latest = trace.requestedAt;
  for (const record of trace.records) if (timeOrZero(record.endedAt) > timeOrZero(latest)) latest = record.endedAt;
  return latest;
}

/**
 * The workspaces a scan of recent requests reads (`bm_projects`,
 * `orchestrator.state`, the stall pass; code review 2026-09-30 §3.5): every
 * workspace of the store, with its `meta.json`, that the store saw at or
 * after `since` (epoch ms), has no `meta.json`, or is in `running`; in the
 * store's order.
 */
export function recentWorkspacesOf(
  location: TraceStoreLocation,
  since: number,
  running: ReadonlySet<string> = new Set(),
): Array<{ workspaceId: string; meta: TraceWorkspaceMeta | null }> {
  return storedWorkspaceIds(location)
    .map((workspaceId) => ({ workspaceId, meta: readWorkspaceMeta(location, workspaceId) }))
    .filter(({ workspaceId, meta }) => running.has(workspaceId) || meta === null || timeOrZero(meta.lastSeenAt) >= since);
}

/** A workspace's traces with activity at or after `since` (epoch ms), newest first, each with its last activity (`lastActivityOf`). */
export function recentTracesOf(traces: readonly ReconstructedTrace[], since: number): Array<{ trace: ReconstructedTrace; lastActivityAt: string }> {
  return traces
    .map((trace) => ({ trace, lastActivityAt: lastActivityOf(trace) }))
    .filter((entry) => timeOrZero(entry.lastActivityAt) >= since)
    .sort((a, b) => timeOrZero(b.lastActivityAt) - timeOrZero(a.lastActivityAt));
}

/**
 * When the request started waiting on the user: the time of its last report,
 * when that one is `blocked`. A stored message time can be the write time
 * (AGENTS.md), which is never before the end of the turn that carried the
 * report, so that end time is used when it is earlier (design §6).
 */
export function waitingSinceOf(trace: ReconstructedTrace): string | null {
  const last = trace.reports.at(-1);
  if (last?.phase !== "blocked") return null;
  const carrier = trace.records.find((record) =>
    record.reports.some((entry) => entry === last || (entry.agentId === last.agentId && entry.at === last.at && entry.phase === "blocked")),
  );
  const endedAt = carrier === undefined ? 0 : timeOrZero(carrier.endedAt);
  return endedAt > 0 && endedAt < timeOrZero(last.at) ? carrier!.endedAt : last.at;
}

/** One request's trace, with the live facts of its agents and its registry entry beside it. */
export interface RequestTrace {
  trace: ReconstructedTrace;
  agents: Map<string, AgentFacts>;
  /** The request in the request registry (design §16.4), as the rebuild read it; null when it holds none. */
  request: RegisteredRequest | null;
}

/**
 * Every trace of one workspace. Call it only after the collector has written
 * the turn that triggered it, or that turn is missing from the result.
 */
export async function workspaceTracesOf(deps: RequestTraceDeps, workspaceId: string): Promise<WorkspaceTraces> {
  const { records, notices } = readRecords(deps.location, workspaceId);
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
    deps.replacementIds ?? reviewerReplacementsFor({ home: deps.home }),
  ]);
  // Design §16.8: the request registry's review tool records, counted with the activity stream.
  const requests = registeredRequestsOf(deps, workspaceId);
  const traces = reconstructTraces({ records, agents: [...agents.values()], replacementIds, requests });
  return { records, agents, traces, requests, notices };
}

/**
 * The workspace's requests in the request registry (design §16.4) of the data
 * folder the traces are in (`deps.home`, else the trace store's parent). Never
 * throws: a registry that cannot be read is none.
 */
export function registeredRequestsOf(deps: Pick<RequestTraceDeps, "location" | "home">, workspaceId: string): RegisteredRequest[] {
  try {
    const home = deps.home ?? dirname(deps.location.tracesDir);
    return createRequestRegistry(home, { log: () => {} }).list(workspaceId);
  } catch {
    return [];
  }
}

/** A request's review calls as the Dashboard counts them (design §16.8), and the trace they were read from. */
export interface RequestReviewCount {
  /** The one count (`reviewCallsOf`); 0 when nothing was recorded yet. */
  calls: number;
  /** The request's rebuilt trace, when the store holds one. */
  trace: ReconstructedTrace | null;
}

/**
 * The review calls of one request, by the one function the Dashboard shows
 * (design §16.8): the request's trace rebuilt exactly as `workspaceTracesOf`
 * rebuilds it for the Dashboard, its `reviewCalls` read; with no trace of it
 * yet (no Manager turn recorded), the same `reviewCallsOf` over the
 * Reviewers labelled with the request or created by one of its Workers and its
 * tool records. Rejects when the store cannot be read.
 */
export async function requestReviewCountOf(deps: RequestTraceDeps, workspaceId: string, requestId: string): Promise<RequestReviewCount> {
  const { records, agents, traces, requests } = await workspaceTracesOf(deps, workspaceId);
  const trace = traces.find((candidate) => candidate.requestId === requestId) ?? null;
  // The trace's own figure when there is one: the very number the Dashboard shows.
  if (trace !== null) return { calls: trace.reviewCalls ?? 0, trace };
  const request = requests.find((entry) => entry.requestId === requestId) ?? null;
  const replacementIds = deps.replacementIds ?? (await reviewerReplacementsFor({ home: deps.home }));
  const workerIds = new Set(request?.workerIds ?? []);
  const reviewerIds = [...agents.values()]
    .filter((agent) => agent.role === "reviewer" && (agent.requestIdLabel === requestId || (agent.parentAgentId !== null && workerIds.has(agent.parentAgentId))))
    .map((agent) => agent.id);
  return { calls: reviewCallsOf(reviewerIds, records, replacementIds, toolCallsOf(request)) ?? 0, trace: null };
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
  const { agents, traces, requests } = await workspaceTracesOf(deps, workspaceId);
  const trace = traceOfAgent(traces, agentId);
  if (trace === undefined) return null;
  return { trace, agents, request: trace.requestId === null ? null : (requests.find((entry) => entry.requestId === trace.requestId) ?? null) };
}

/** A request to read: by its id, else the one an agent (a Worker or Reviewer) belongs to. */
export interface RequestRef {
  requestId: string | null;
  agentId?: string | null;
}

/** The trace of one request: by its id, else the request `agentId` belongs to (`traceOfAgent`). */
export function traceOfRequest(traces: readonly ReconstructedTrace[], ref: RequestRef): ReconstructedTrace | undefined {
  const byId = ref.requestId === null ? undefined : traces.find((trace) => trace.requestId === ref.requestId);
  if (byId !== undefined || ref.agentId === null || ref.agentId === undefined) return byId;
  return traceOfAgent(traces, ref.agentId);
}

/** The workspace folder the store last saw, for a report's file paths (autonomy design §C.2); null when unknown. */
function workspaceDirectoryOf(location: TraceStoreLocation, workspaceId: string): string | null {
  return readWorkspaceMeta(location, workspaceId)?.lastKnownDirectory ?? null;
}

/**
 * A request's finish now (autonomy design §C.3, §C.6): the request rebuilt
 * from the trace store at the call, its latest report labelled when that is
 * `finished` (`requestFinishOf`). Null when the request is not on record or
 * its latest report is not `finished`. Rejects when the store cannot be read.
 */
export async function requestFinishNow(deps: RequestTraceDeps, workspaceId: string, ref: RequestRef): Promise<RequestFinish | null> {
  const { traces, agents } = await workspaceTracesOf(deps, workspaceId);
  const trace = traceOfRequest(traces, ref);
  if (trace === undefined) return null;
  return requestFinishOf({
    reports: trace.reports,
    records: trace.records,
    workspaceDirectory: workspaceDirectoryOf(deps.location, workspaceId),
    handoffSuccessors: new Set(handoffSuccessorsOf(trace, agents).keys()),
  });
}

/**
 * Whether a request stands finished-unverified now, the state a delegate may
 * not act on (autonomy design §C.6, change-008 C4): read from the trace store
 * at the call, so a later report of the request ends it. False with no request
 * and no agent to read. A store that cannot be read counts as unverified —
 * the owner's side: the delegate leaves it to the owner — with one log line.
 * Never rejects.
 */
export async function isFinishedUnverifiedNow(
  deps: RequestTraceDeps & { log?: (message: string) => void },
  workspaceId: string,
  ref: RequestRef,
): Promise<boolean> {
  if (ref.requestId === null && (ref.agentId ?? null) === null) return false;
  try {
    return (await requestFinishNow(deps, workspaceId, ref))?.unverified === true;
  } catch (error) {
    const what = ref.requestId === null ? `the request of ${ref.agentId}` : `request ${ref.requestId}`;
    (deps.log ?? ((message: string) => console.warn(message)))(
      `[paseo-bm] could not read ${what} to check its finish; it is left to the owner: ${errorText(error)}`,
    );
    return true;
  }
}

/**
 * Which `finished` reports of a recorded Manager turn leave their request
 * finished-unverified (autonomy design §C.3, §A.8): each labelled against
 * every record of its request — by the report's request id, else the Manager's
 * newest turn — read once the collector has written the turn. The answer is a
 * test for `requestFinishedEventsOf`. For any other turn nothing is read, and
 * nothing is unverified; so too when the store cannot be read (one log line):
 * the events are then as before. Never rejects.
 */
export async function unverifiedFinishesOf(
  deps: RequestTraceDeps & { log?: (message: string) => void },
  record: TraceRecord | null | undefined,
): Promise<(report: ParsedReport) => boolean> {
  const none = () => false;
  if (record === null || record === undefined || record.role !== "manager") return none;
  const finished = record.reports.filter((report) => report.phase === "finished");
  if (finished.length === 0) return none;
  try {
    const { traces, agents } = await workspaceTracesOf(deps, record.workspaceId);
    const workspaceDirectory = workspaceDirectoryOf(deps.location, record.workspaceId);
    const unverified = new Set<ParsedReport>();
    for (const report of finished) {
      const requestId = report.requestId ?? record.requestId;
      const trace = (requestId === null ? undefined : traceOfRequest(traces, { requestId })) ?? traceOfManagerTurn(traces, record.agentId);
      if (trace === undefined) continue;
      const handoffSuccessors = new Set(handoffSuccessorsOf(trace, agents).keys());
      if (isFinishedUnverified(verificationOf({ report, records: trace.records, workspaceDirectory, handoffSuccessors }))) unverified.add(report);
    }
    return (report) => unverified.has(report);
  } catch (error) {
    (deps.log ?? ((message: string) => console.warn(message)))(`[paseo-bm] could not check the finish of ${record.agentId}'s turn: ${errorText(error)}`);
    return none;
  }
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
 * What the rule reads about one request. Pure: the trace in, one `RuleInput`
 * out, everything from the trace's own records — and the request's
 * review-budget grants when the caller read them (`ruleReviewGrantOf`, design
 * §16.8).
 */
export function ruleInputOf(trace: ReconstructedTrace, reviewGrant?: RuleReviewGrant): RuleInput {
  return {
    traceId: trace.traceId,
    requestId: trace.requestId,
    tier: trace.tier,
    reviewCalls: trace.reviewCalls,
    inbound: messagesOf(trace.records, (record) => record.sent),
    ...(reviewGrant === undefined ? {} : { reviewGrant }),
  };
}
