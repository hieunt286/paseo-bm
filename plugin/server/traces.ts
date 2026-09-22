/**
 * Trace reconstruction (WP-206.1, Dashboard Design §6, §7.3).
 *
 * Turns the store's per-turn records plus the current agent list into one row
 * per *user request*. Two rules are absolute, and both exist because a
 * confident wrong answer is worse than an honest gap:
 *
 * 1. **Never attach an agent to the nearest trace on a hunch.** When nothing
 *    links it, it goes to the unknown group and the row says `linking:
 *    "unknown"` (REQ-041d).
 * 2. **One Manager user request is one trace.** A Worker's `BM-REPORT`, which
 *    arrives in the Manager's timeline as a `user_message` (confirmed against
 *    the shipped daemon in WP-205.2), never opens a trace of its own.
 *
 * This module is pure: records in, rows out. No filesystem, no SDK, no clock.
 */
import { looksLikeReport, requestIdFromText } from "./bm-report";
import { isPluginNotice } from "./notices";
import { brActions } from "./shell";
import { byAt, uniqueBy } from "../shared/order";
import type {
  AgentTiming,
  Confidence,
  Evidence,
  GuardrailReport,
  ParsedReport,
  ParsedReview,
  RuntimeRow,
  SubAgentTrace,
  Tier,
  TraceBead,
  TraceDetail,
  TraceMessage,
  TraceRecord,
  TraceState,
  TraceSummary,
  TurnTiming,
  WorkflowStepResult,
  Usage,
  WorkspaceState,
} from "../shared/contracts";

/** Agent facts reconstruction needs, from `agents.list` or the store. */
export interface AgentFacts {
  id: string;
  role: "manager" | "worker" | "reviewer" | "unknown";
  status: string;
  parentAgentId: string | null;
  createdAt: string | null;
  /** `bm.requestId` label when the agent carries one (REQ-051). */
  requestIdLabel: string | null;
  /** `bm.batchId` label when the agent carries one. */
  batchIdLabel: string | null;
  archived: boolean;
  /** The agent's title in Paseo, when known. */
  title?: string | null;
  /**
   * False when the role came from the provider only: the agent carries no valid
   * `bm.role` label (delta 20260918g §4.1). Absent means labelled.
   */
  labelled?: boolean;
  /** `bm.replacedBy` label: the agent that took over after a fallback switch (delta 20260921 §4.4.7). */
  replacedBy?: string | null;
}

/** One reconstructed request, before timing and bead enrichment (WP-206.1.2). */
export interface ReconstructedTrace {
  traceId: string;
  requestId: string | null;
  requestedAt: string;
  /** Null when collection started after the request did (no user turn captured). */
  requestText: string | null;
  managerAgentId: string | null;
  workerIds: string[];
  reviewerIds: string[];
  /** Turn records that belong to this trace, oldest first. */
  records: TraceRecord[];
  reports: ParsedReport[];
  reviews: ParsedReview[];
  reviewCalls: number | null;
  guardrailReported: GuardrailReport | null;
  tier: Tier | null;
  state: TraceState;
  linking: Confidence;
  agentsMissing: string[];
  notices: string[];
  /** The request's turns, oldest first. Always at least one (delta 20260917e §4.3). */
  segments: TraceSegment[];
}

/**
 * One turn of the conversation inside a request: what the user asked, and
 * everything that happened until they asked again.
 *
 * The owner asked for a follow-up to show as its own flow instead of being
 * folded into one hard-to-trace row (delta 20260917e §4.3). A segment opens at
 * a Manager turn whose first inbound message is the USER's — `origin: "user"`,
 * which the collector sets only when the timeline item carried a
 * `clientMessageId`.
 *
 * That field, not the wording, is what makes this safe. A Worker's status
 * update reaches its Manager as a `user_message` too and is indistinguishable
 * by text — WP-214 defect 9, which is why unnamed turns are folded at all. It
 * carries `origin: "agent"`, so it never opens a segment. Records written
 * before `origin` existed have none, and AGENTS.md forbids reading that absence
 * as `user`: such a request stays a single segment.
 */
export interface TraceSegment {
  /** 1-based, in time order. */
  index: number;
  startedAt: string;
  /** The user's message that opened this segment; null when the opening turn was never captured. */
  text: string | null;
  /** Records of this trace inside the segment's window, oldest first. */
  records: TraceRecord[];
  /** Reports that arrived while this segment was open. */
  reports: ParsedReport[];
}

/**
 * Splits a finished trace into its turns.
 *
 * Boundaries are the Manager turns the USER opened. Everything before the first
 * such turn still belongs to segment 1, so no record is ever dropped: a request
 * whose opening turn was not captured, or one written before the `origin` field
 * existed, comes back as exactly one segment covering everything.
 */
function segmentsOf(trace: ReconstructedTrace): TraceSegment[] {
  const opens: Array<{ at: string; text: string }> = [];
  for (const record of trace.records) {
    if (record.role !== "manager") continue;
    const message = firstUserMessage(record);
    // `origin` is absent on records written before the collector recorded it.
    // Absence is NOT "user" (AGENTS.md), so such a record opens nothing.
    if (message?.origin !== "user") continue;
    opens.push({ at: message.at, text: message.text });
  }
  opens.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const first = trace.records[0]?.at ?? trace.requestedAt;
  // The opening segment starts with the trace itself unless the user's first
  // message is what started it.
  const heads =
    opens.length > 0 && opens[0]!.at <= first
      ? opens
      : [{ at: first, text: null as string | null }, ...opens];

  const segments: TraceSegment[] = heads.map((head, index) => ({
    index: index + 1,
    startedAt: head.at,
    text: head.text,
    records: [],
    reports: [],
  }));

  const segmentAt = (at: string): TraceSegment => {
    let chosen = segments[0]!;
    for (const segment of segments) {
      if (segment.startedAt <= at) chosen = segment;
      else break;
    }
    return chosen;
  };

  for (const record of trace.records) segmentAt(record.at).records.push(record);
  for (const report of trace.reports) segmentAt(report.at).reports.push(report);
  return segments;
}

/** First inbound message that is neither a role report nor one of the plugin's own notices. */
function firstUserMessage(record: TraceRecord): TraceMessage | null {
  for (const message of record.sent) {
    if (!looksLikeReport(message.text) && !isPluginNotice(message.text)) return message;
  }
  return null;
}

function firstUserText(record: TraceRecord): string | null {
  return firstUserMessage(record)?.text ?? null;
}

/**
 * Trace key of a Manager turn: stable across reads so the UI can link to it.
 * Prefers the request id, which survives a re-read even if the Manager's turn
 * ids change.
 */
export function traceIdFor(record: TraceRecord): string {
  return record.requestId !== null ? `req:${record.requestId}` : `${record.agentId}:${record.turnId ?? record.at}`;
}

interface Bucket {
  trace: ReconstructedTrace;
  /** Window used for time-based inference: request time to last activity. */
  from: string;
  to: string;
}

/**
 * Request id of a Manager turn, when the record itself does not carry one.
 *
 * Found in the acceptance run (WP-214): the Manager *generates* the id during
 * the turn that opens the request, so it is not in the incoming message. It
 * shows up in the Manager's own reply ("- `requestId`: `req-…`"), so that is
 * read too. It is deliberately NOT read from the `date` command the Manager
 * runs to build the id: that command carries a format string
 * (`date -u +req-%Y%m%dT%H%M%SZ`), not the id.
 */
export function managerRequestId(record: TraceRecord): string | null {
  if (record.requestId !== null) return record.requestId;
  for (const message of [...record.received, ...record.sent]) {
    const found = requestIdFromText(message.text);
    if (found !== null) return found;
  }
  return null;
}

/** Said once, retracted in one place: see the fold below. */
const MISSING_REQUEST_TEXT =
  "The request text was not recorded: collection started after this request began.";

/**
 * A report belongs to the request it names, and to no other.
 *
 * WP-214 acceptance: one malformed record (defect 10) carried F-1's request id
 * while holding F-2's reports, and F-1's state, tier and guardrail were then
 * read off F-2's `finished` report. A report that names a different request is
 * never evidence about this one, whatever record it arrived in.
 */
function reportsBelongingTo(requestId: string | null, reports: readonly ParsedReport[]): ParsedReport[] {
  return reports.filter((report) => report.requestId === null || report.requestId === requestId);
}

/**
 * Opens one bucket per request the Manager handled.
 *
 * A request is keyed by its id, so N Manager turns of one request are one row.
 * A Manager turn whose only inbound message is a `BM-REPORT` never opens a
 * request of its own.
 */
function openBuckets(records: readonly TraceRecord[]): { buckets: Bucket[]; byRequestId: Map<string, Bucket> } {
  const managerRecords = records.filter((record) => record.role === "manager");
  // Computed once per turn: the passes below read them repeatedly, and D-1's
  // threshold is stated at up to 500 traces.
  const idOf = managerRecords.map((record) => managerRequestId(record));
  const textOf = managerRecords.map((record) => firstUserText(record));
  const buckets: Bucket[] = [];
  const byRequestId = new Map<string, Bucket>();

  const newBucket = (record: TraceRecord, requestId: string | null, text: string | null): void => {
    const at = record.sent[0]?.at ?? record.at;
    const bucket: Bucket = {
      trace: {
        traceId: requestId === null ? traceIdFor(record) : `req:${requestId}`,
        requestId,
        requestedAt: at,
        requestText: text,
        managerAgentId: record.agentId,
        workerIds: [],
        reviewerIds: [],
        records: [record],
        reports: reportsBelongingTo(requestId, record.reports),
        reviews: [...record.reviews],
        reviewCalls: null,
        guardrailReported: null,
        tier: null,
        state: "unknown",
        linking: requestId !== null ? "exact" : "unknown",
        agentsMissing: [],
        notices: [],
        segments: [],
      },
      from: at,
      to: record.at,
    };
    buckets.push(bucket);
    if (requestId !== null) byRequestId.set(requestId, bucket);
  };

  /** Folds one more Manager turn into a request already open. */
  const fold = (bucket: Bucket, record: TraceRecord, text: string | null): void => {
    const at = record.sent[0]?.at ?? record.at;
    // The earliest user message of a request is the request; later ones are
    // follow-ups, and a Worker's status update is neither.
    if (text !== null && (bucket.trace.requestText === null || at < bucket.trace.requestedAt)) {
      bucket.trace.requestText = text;
      bucket.trace.requestedAt = at;
    }
    if (at < bucket.from) bucket.from = at;
    if (bucket.to < record.at) bucket.to = record.at;
    bucket.trace.records.push(record);
    bucket.trace.reports.push(...reportsBelongingTo(bucket.trace.requestId, record.reports));
    bucket.trace.reviews.push(...record.reviews);
  };

  // Pass 1: every request the Manager actually named gets exactly one bucket.
  managerRecords.forEach((record, index) => {
    const requestId = idOf[index]!;
    if (requestId === null) return;
    const existing = byRequestId.get(requestId);
    if (existing === undefined) newBucket(record, requestId, textOf[index]!);
    else fold(existing, record, textOf[index]!);
  });

  // Pass 2: a Manager turn that names no request belongs to the request the
  // SAME Manager names NEXT.
  //
  // WP-214 acceptance, defect 9: a Worker's status update to its Manager
  // arrives as a `user_message`, exactly like a user request, and opened a row
  // of its own with no worker, no beads and eleven unknown steps. Nothing
  // textual separates the two, but the Manager's own next word does. A user's
  // follow-up instruction lands on its request for the same reason.
  //
  // That reason only holds inside ONE Manager's conversation, so every step
  // below runs over one Manager's own turns. Workspace-wide, a turn of an
  // archived Manager reached the next Manager's request across eighteen hours
  // and carried its text, its time and its tokens into that row (delta
  // 20260917d defect A, observed on the owner's workspace).
  const turnsOfManager = new Map<string, number[]>();
  managerRecords.forEach((record, index) => {
    const own = turnsOfManager.get(record.agentId);
    if (own === undefined) turnsOfManager.set(record.agentId, [index]);
    else own.push(index);
  });

  for (const own of turnsOfManager.values()) {
    // Positions are into `own`; `own[position]` indexes `managerRecords`.
    const nextNamed: (string | null)[] = new Array(own.length).fill(null);
    for (let position = own.length - 2; position >= 0; position -= 1) {
      nextNamed[position] = idOf[own[position + 1]!] ?? nextNamed[position + 1] ?? null;
    }
    const firstPosition = new Map<string, number>();
    own.forEach((index, position) => {
      const id = idOf[index]!;
      if (id !== null && !firstPosition.has(id)) firstPosition.set(id, position);
    });
    // A message can close one request and open another ("(a) keep it. New
    // request: CSV export"). If a request OPENS before the next unnamed user
    // turn, the message started that request; without this, WP-214 F-4 was
    // timed from a later answer, four minutes late.
    const openedAfter = (position: number): string | null => {
      for (let later = position + 1; later < own.length; later += 1) {
        const index = own[later]!;
        const id = idOf[index]!;
        if (id === null) {
          if (textOf[index] !== null) return null;
        } else if (firstPosition.get(id) === later) {
          return id;
        }
      }
      return null;
    };

    own.forEach((index, position) => {
      if (idOf[index] !== null) return;
      const record = managerRecords[index]!;
      const text = textOf[index]!;
      const nextRequestId = (text === null ? null : openedAfter(position)) ?? nextNamed[position] ?? null;
      const bucket = nextRequestId === null ? undefined : byRequestId.get(nextRequestId);
      if (bucket !== undefined) fold(bucket, record, text);
      // Nothing follows from this Manager: a request still in flight gets a
      // provisional row; a turn without user text has nothing to show.
      else if (text !== null) newBucket(record, null, text);
    });
  }

  for (const bucket of buckets) {
    if (bucket.trace.requestText === null) bucket.trace.notices.push(MISSING_REQUEST_TEXT);
  }
  buckets.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { buckets, byRequestId };
}

const BARE_REQUEST_ID = /\breq-\d{8}T\d{6}Z\b/g;

/**
 * Request id of an agent, in the order design §6 step 3 fixes: label → its own
 * records and reports → its prompts → the bare id its messages name most.
 * Returns the confidence with it so the caller can tell a fact from an
 * inference.
 */
export function requestIdOfAgent(
  agent: AgentFacts,
  records: readonly TraceRecord[],
): { requestId: string | null; confidence: Confidence } {
  if (agent.requestIdLabel !== null) return { requestId: agent.requestIdLabel, confidence: "exact" };
  const own = records.filter((record) => record.agentId === agent.id);
  for (const record of own) {
    if (record.requestId !== null) return { requestId: record.requestId, confidence: "exact" };
    for (const report of record.reports) {
      if (report.requestId !== null) return { requestId: report.requestId, confidence: "exact" };
    }
  }
  for (const record of own) {
    for (const message of record.sent) {
      const fromPrompt = requestIdFromText(message.text);
      if (fromPrompt !== null) return { requestId: fromPrompt, confidence: "exact" };
    }
  }
  // The id written bare, e.g. "TIẾP TỤC LÀM VIỆC — `req-20260916T081749Z`".
  // Managers from paseo-bm 0.1.0 wrote it that way and set no label, and a
  // Worker's messages also cite other requests for cross-reference. On the
  // owner's workspace one Worker's messages named its request 5 times and
  // three others once each. The id named more often than all others together
  // is the agent's request; anything less decisive says nothing.
  const counts = new Map<string, number>();
  for (const record of own) {
    for (const message of record.sent) {
      for (const id of new Set(message.text.match(BARE_REQUEST_ID) ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (top !== undefined && top[1] > total - top[1]) return { requestId: top[0], confidence: "inferred" };
  return { requestId: null, confidence: "unknown" };
}

/**
 * Buckets an agent by time: its creation must fall inside exactly one request
 * window, or after exactly one request's start.
 *
 * Two matching windows return null rather than a guess. With per-turn records
 * that is hard to reach — a Manager handles one turn at a time, so request
 * windows do not overlap — but the branch stays as the defence that keeps the
 * "never attach on a hunch" rule true if the record shape ever changes.
 *
 * An agent created **before every request** also returns null: there is nothing
 * it could plausibly belong to.
 */
function bucketByTime(buckets: Bucket[], createdAt: string | null): Bucket | null {
  if (createdAt === null) return null;
  const candidates = buckets.filter((bucket) => createdAt >= bucket.from && createdAt <= bucket.to);
  if (candidates.length === 1) return candidates[0] ?? null;
  if (candidates.length > 1) return null;
  // Nothing contains it: fall back to the most recent request that started
  // before it, but only when that request is unambiguous (exactly one).
  const before = buckets.filter((bucket) => createdAt >= bucket.from);
  return before.length === 1 ? (before[0] ?? null) : null;
}

/** Number of review requests a Reviewer received: its inbound non-`BM-REVIEW` messages. */
export function reviewCallsOf(reviewerIds: readonly string[], records: readonly TraceRecord[]): number | null {
  let calls = 0;
  let seen = false;
  for (const record of records) {
    if (!reviewerIds.includes(record.agentId)) continue;
    seen = true;
    for (const message of record.sent) {
      // Neither a Reviewer's own BM-REVIEW nor the plugin's stop notice
      // (stop-propagation.ts) is a review request.
      if (/^\s*>?\s*(?:[-*]\s*)?bm-review\b/im.test(message.text)) continue;
      if (isPluginNotice(message.text)) continue;
      calls += 1;
    }
  }
  // No Reviewer turn was recorded (collection started later, or the records
  // were deleted): the number of calls is unknown, not zero. The owner's
  // workspace showed "6 reviewers · 0 review calls" for exactly this reason.
  return seen ? calls : null;
}

/**
 * True when a `finished` report's `blockers` says something is still open.
 *
 * The report format writes `none` for an empty field, and Workers add notes and
 * `Suggestion (not done): …` items after it (worker.md asks for suggestions in
 * the finished report). WP-214 acceptance: two delivered requests read as
 * "Stopped" because their blockers were "none — user chose (a) …" and
 * "none. Suggestion (not done): …".
 */
export function blocksCompletion(blockers: string | null): boolean {
  if (blockers === null) return false;
  const text = blockers.trim();
  if (text === "" || /^none\b/i.test(text)) return false;
  const withoutSuggestions = text.replace(/Suggestion \(not done\):[^]*?(?=Suggestion \(not done\):|$)/gi, "").trim();
  return withoutSuggestions !== "";
}

/**
 * State of a trace, in the precedence order of design §7.3. Order matters: a
 * running agent outranks a `blocked` report, because "still working" is what
 * the user needs to know first.
 */
export function stateOf(
  trace: Pick<ReconstructedTrace, "workerIds" | "reviewerIds" | "reports">,
  agents: ReadonlyMap<string, AgentFacts>,
  records: readonly TraceRecord[],
): TraceState {
  const own = [...trace.workerIds, ...trace.reviewerIds]
    .map((id) => agents.get(id))
    .filter((agent): agent is AgentFacts => agent !== undefined);

  if (own.some((agent) => agent.status === "running")) return "running";

  const lastReport = trace.reports.at(-1);
  if (lastReport?.phase === "blocked") return "waiting_user";

  const failedTurn = records.some((record) => record.outcome === "failed");
  if (own.some((agent) => agent.status === "error") || failedTurn) return "failed";

  // `worker.md` sends `finished` both when the work is done AND when the Worker
  // was stopped, so the phase alone does not mean success. The Worker says which
  // it was in `blockers`; a stopped run names what it did not deliver.
  // (Found in the WP-214 acceptance run, where a stopped request read as
  // "Completed".)
  //
  // Only the LAST report decides. An earlier `canceled` turn is history, not a
  // verdict: F-1 of that same run was interrupted four times and then finished
  // properly, and reading "any canceled turn" as a stop reported the delivered
  // request as "Stopped" — the mirror image of the first defect. A Worker
  // killed so hard it never reported at all does not reach this branch and
  // falls through to the `stopped` default below.
  if (lastReport?.phase === "finished") {
    return blocksCompletion(lastReport.blockers) ? "stopped" : "completed";
  }

  if (trace.workerIds.length > 0) return "stopped";
  return "unknown";
}

export interface ReconstructOptions {
  records: readonly TraceRecord[];
  agents: readonly AgentFacts[];
}

/**
 * Rebuilds every trace of one workspace.
 *
 * The unknown group is returned as its own trace with `linking: "unknown"` so
 * nothing is silently dropped: an agent whose request cannot be determined is
 * still visible, just not attributed.
 */
export function reconstructTraces(options: ReconstructOptions): ReconstructedTrace[] {
  const { records, agents } = options;
  const ordered = [...records].sort(byAt);
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const { buckets, byRequestId: byRequest } = openBuckets(ordered);

  const unknown: ReconstructedTrace = {
    traceId: "unknown",
    requestId: null,
    requestedAt: ordered[0]?.at ?? "",
    requestText: null,
    managerAgentId: null,
    workerIds: [],
    reviewerIds: [],
    records: [],
    reports: [],
    reviews: [],
    reviewCalls: null,
    guardrailReported: null,
    tier: null,
    state: "unknown",
    linking: "unknown",
    agentsMissing: [],
    notices: ["These agents could not be linked to a request."],
    segments: [],
  };

  // Reports that arrived in the Manager's timeline belong to the trace they name.
  for (const record of ordered) {
    if (record.role !== "manager") continue;
    for (const report of record.reports) {
      const bucket = report.requestId === null ? undefined : byRequest.get(report.requestId);
      if (bucket === undefined) continue;
      bucket.trace.reports.push(report);
      if (bucket.to < record.at) bucket.to = record.at;
    }
  }

  const assignWorker = (agent: AgentFacts): Bucket | null => {
    const { requestId } = requestIdOfAgent(agent, ordered);
    if (requestId !== null) {
      const bucket = byRequest.get(requestId);
      if (bucket !== undefined) return bucket;
      // The agent names its request, but no Manager turn recorded that id. When
      // its creation falls inside exactly one request window, that window is the
      // request it names: adopt the id rather than calling the link a guess.
      const containing = buckets.filter(
        (candidate) =>
          candidate.trace.requestId === null &&
          agent.createdAt !== null &&
          agent.createdAt >= candidate.from &&
          agent.createdAt <= candidate.to,
      );
      if (containing.length === 1) {
        const adopted = containing[0]!;
        adopted.trace.requestId = requestId;
        adopted.trace.traceId = `req:${requestId}`;
        adopted.trace.linking = "exact";
        byRequest.set(requestId, adopted);
        return adopted;
      }
      // The agent says which request it belongs to, and that request is not
      // here (its trace was deleted, or never recorded). Attaching it to
      // another request by time would contradict its own label — WP-214 D-9:
      // after deleting one trace, its Worker was linked to a different Large
      // request because its creation fell inside that request's window.
      return null;
    }
    const inferred = bucketByTime(buckets, agent.createdAt);
    if (inferred !== null) {
      // The row's linking describes how its agents were attached, so a time
      // link downgrades an exact row and upgrades an unknown one.
      inferred.trace.linking = "inferred";
      inferred.trace.notices.push(`Agent ${agent.id} was linked by time, not by request id.`);
      return inferred;
    }
    return null;
  };

  for (const agent of agents) {
    if (agent.role !== "worker") continue;
    const bucket = assignWorker(agent);
    if (bucket === null) {
      unknown.workerIds.push(agent.id);
      continue;
    }
    bucket.trace.workerIds.push(agent.id);
    if (agent.archived) {
      bucket.trace.notices.push(`Worker ${agent.id} has been archived.`);
    }
  }

  for (const agent of agents) {
    if (agent.role !== "reviewer") continue;
    // The Reviewer's own label names its request exactly; the parent is only a
    // fallback. On the owner's workspace six Reviewers labelled with one
    // request followed their parent Worker into a different, time-linked one.
    if (agent.requestIdLabel !== null) {
      const labelled = byRequest.get(agent.requestIdLabel);
      if (labelled !== undefined) {
        labelled.trace.reviewerIds.push(agent.id);
        continue;
      }
    }
    const owner =
      agent.parentAgentId === null
        ? undefined
        : buckets.find((bucket) => bucket.trace.workerIds.includes(agent.parentAgentId!));
    if (owner !== undefined) {
      owner.trace.reviewerIds.push(agent.id);
      continue;
    }
    // No parent in this workspace: try what the agent itself says, then give up honestly.
    const { requestId } = requestIdOfAgent(agent, ordered);
    const byLabel = requestId === null ? undefined : byRequest.get(requestId);
    if (byLabel !== undefined) {
      byLabel.trace.reviewerIds.push(agent.id);
      byLabel.trace.notices.push(`Reviewer ${agent.id} was linked by request id; its Worker is not here.`);
      continue;
    }
    unknown.reviewerIds.push(agent.id);
  }

  for (const bucket of buckets) {
    const trace = bucket.trace;

    // Records of the trace's own Workers and Reviewers; its Manager turns are
    // already held.
    const ownAgentIds = new Set([trace.managerAgentId, ...trace.workerIds, ...trace.reviewerIds]);
    const held = new Set(trace.records);
    const take = (record: TraceRecord): void => {
      held.add(record);
      trace.records.push(record);
      trace.reports.push(...reportsBelongingTo(trace.requestId, record.reports));
      trace.reviews.push(...record.reviews);
    };
    for (const record of ordered) {
      if (record.role !== "manager" && !held.has(record) && ownAgentIds.has(record.agentId)) take(record);
    }

    // A record names its own request, so it can be placed even when its agent
    // cannot. The user may delete a Worker — `agents.list` then has nothing to
    // match on — and without this the row loses the work those records
    // describe (D-8's "archive, then delete the Worker" leg).
    const recordedOnly = new Set<string>();
    for (const record of ordered) {
      if (trace.requestId === null || record.requestId !== trace.requestId || held.has(record)) continue;
      if (agentById.has(record.agentId) || ownAgentIds.has(record.agentId)) continue;
      take(record);
      recordedOnly.add(record.agentId);
    }

    // "Latest" has to mean latest in time: reports arrive from several passes,
    // so array order is not chronology (WP-214 F-1 once read its state off
    // whichever report was appended last). The same report also arrives twice —
    // from a Worker's turn and from the Manager turn quoting it — as two parsed
    // objects, so it is de-duplicated on the design's key, not on identity.
    trace.reports = uniqueBy(
      [...trace.reports].sort(byAt),
      (report) => `${report.agentId}|${report.phase ?? ""}|${report.requestId ?? ""}|${report.at}`,
    );
    trace.reviews = uniqueBy(
      [...trace.reviews].sort(byAt),
      (review) => `${review.agentId}|${review.batchId ?? ""}|${review.verdict ?? ""}|${review.at}`,
    );
    trace.records.sort(byAt);
    trace.segments = segmentsOf(trace);

    const lastGuardrail = [...trace.reports].reverse().find((report) => report.guardrail !== null);
    trace.guardrailReported = lastGuardrail?.guardrail ?? null;
    trace.tier = [...trace.reports].reverse().find((report) => report.tier !== null)?.tier ?? null;
    trace.reviewCalls = reviewCallsOf(trace.reviewerIds, trace.records);

    const missing = [
      ...new Set([
        ...[...trace.workerIds, ...trace.reviewerIds].filter((id) => !agentById.has(id)),
        ...recordedOnly,
      ]),
    ];
    trace.agentsMissing = missing;
    if (missing.length > 0) {
      trace.notices.push(
        `${missing.length} agent(s) of this request are no longer on this machine; showing what was recorded.`,
      );
    }

    trace.state = stateOf(trace, agentById, trace.records);
    trace.notices = [...new Set(trace.notices)];
  }

  const result = buckets.map((bucket) => bucket.trace);
  if (unknown.workerIds.length > 0 || unknown.reviewerIds.length > 0) {
    unknown.state = stateOf(unknown, agentById, []);
    result.push(unknown);
  }
  // Newest first (REQ-041c).
  return result.sort((a, b) => (a.requestedAt > b.requestedAt ? -1 : a.requestedAt < b.requestedAt ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Timing, bead detail, summaries and pages (WP-206.1.2; Design §4.2, §4.3, §7).
// ---------------------------------------------------------------------------

/** Sentence printed next to every duration, so no number is read as machine time. */
export const TIMING_BASIS =
  "Wall-clock time, measured from the request to the last recorded activity. It includes any time spent waiting for you to answer.";

function msBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/** Turn timings of the Manager records of a trace (design §7.1). */
export function managerTurns(trace: ReconstructedTrace): TurnTiming[] {
  return trace.records
    .filter((record) => record.role === "manager")
    .map((record) => ({
      turnId: record.turnId,
      startedAt: record.startedAt ?? record.sent[0]?.at ?? null,
      endedAt: record.endedAt,
      ms: msBetween(record.startedAt ?? record.sent[0]?.at ?? null, record.endedAt),
    }));
}

/**
 * Lifetime of one agent inside a trace.
 *
 * A Worker ends at its `finished` report, a Reviewer at its last `BM-REVIEW`;
 * without either, the last recorded activity is used. A running agent has no
 * end, so `ms` stays null rather than being measured against "now" — the UI
 * shows elapsed time instead (REQ-043d).
 */
export function agentTiming(
  agentId: string,
  role: "worker" | "reviewer",
  trace: ReconstructedTrace,
  agents: ReadonlyMap<string, AgentFacts>,
): AgentTiming {
  const own = trace.records.filter((record) => record.agentId === agentId);
  const startedAt = agents.get(agentId)?.createdAt ?? own[0]?.startedAt ?? own[0]?.at ?? null;
  const lastActivityAt = own.at(-1)?.at ?? null;

  const finishedAt =
    role === "worker"
      ? (trace.reports.filter((report) => report.agentId === agentId && report.phase === "finished").at(-1)?.at ??
        null)
      : (trace.reviews.filter((review) => review.agentId === agentId).at(-1)?.at ?? null);

  const status = agents.get(agentId)?.status ?? "closed";
  const endedAt = status === "running" ? null : (finishedAt ?? lastActivityAt);

  return {
    agentId,
    role,
    startedAt,
    lastActivityAt,
    ms: msBetween(startedAt, endedAt),
    state: status === "running" ? "running" : status === "error" ? "failed" : "completed",
  };
}

/** Total duration of a request, or null while anything is still running. */
export function totalMsOf(trace: ReconstructedTrace): number | null {
  if (trace.state === "running") return null;
  const finished = trace.reports.filter((report) => report.phase === "finished").at(-1)?.at ?? null;
  const lastRecord = trace.records.at(-1)?.at ?? null;
  const end = finished !== null && lastRecord !== null ? (finished > lastRecord ? finished : lastRecord) : (finished ?? lastRecord);
  return msBetween(trace.requestedAt, end);
}

/** Bead ids a trace touched, split by action, with the confidence of each source. */
export interface BeadActions {
  created: { ids: string[]; confidence: Confidence };
  updated: { ids: string[]; confidence: Confidence };
  closed: { ids: string[]; confidence: Confidence };
  ready: { ids: string[]; confidence: Confidence };
  evidenceById: Map<string, Evidence[]>;
}

/**
 * Collects bead actions from reports first, then from `br` commands seen in the
 * timeline.
 *
 * A report is `exact`; a command is `inferred`. When there is no report and no
 * command, the confidence is `unknown` — which is what stops the UI from
 * claiming "this request created no beads" (REQ-044c). Only a `finished` report
 * that says `beadsCreated: none` justifies that claim, and that shows up here
 * as an `exact` empty list.
 */
export function beadActionsOf(trace: ReconstructedTrace): BeadActions {
  const evidenceById = new Map<string, Evidence[]>();
  const add = (bucket: Set<string>, ids: readonly string[], evidence: Evidence | null) => {
    for (const id of ids) {
      bucket.add(id);
      if (evidence === null) continue;
      evidenceById.set(id, [...(evidenceById.get(id) ?? []), evidence]);
    }
  };

  const created = new Set<string>();
  const updated = new Set<string>();
  const closed = new Set<string>();
  const ready = new Set<string>();

  const reportEvidence = (report: ParsedReport): Evidence => ({
    kind: "report",
    detail: `BM-REPORT phase=${report.phase ?? "unknown"}`,
    agentId: report.agentId,
    at: report.at,
  });
  // Stable sort: reports with the same timestamp keep their order.
  const byTime = [...trace.reports].sort(byAt);
  for (const report of byTime) {
    const evidence = reportEvidence(report);
    add(created, report.beadsCreated, evidence);
    add(updated, report.beadsUpdated, evidence);
    add(closed, report.beadsClosed, evidence);
  }
  // `ready` is a state, not an action (delta 20260917 §5.2): only the latest
  // report says what is ready now. The 2026-09-16 run showed 3 ready beads
  // from `beads-done` although `finished` said `beadsReady: none`.
  const latest = byTime.at(-1);
  if (latest !== undefined) add(ready, latest.beadsReady, reportEvidence(latest));

  let sawCommand = false;
  for (const record of trace.records) {
    for (const evidence of record.evidence) {
      if (evidence.kind !== "shell") continue;
      for (const { verb, ids } of brActions(evidence.detail)) {
        if (ids.length === 0 && verb !== "create") continue;
        sawCommand = true;
        add(verb === "create" ? created : verb === "update" ? updated : closed, ids, evidence);
      }
    }
  }

  // A list the parser could not fully read is a lower bound (delta 20260917
  // §5.1): the count is then `inferred`, not `exact`.
  const confidenceFor = (fromReports: boolean, incomplete: boolean): Confidence =>
    fromReports ? (incomplete ? "inferred" : "exact") : sawCommand ? "inferred" : "unknown";
  const incompleteIn = (reports: readonly ParsedReport[], field: string): boolean =>
    reports.some((report) => (report.incompleteFields ?? []).includes(field));

  const reportedAny = trace.reports.length > 0;
  return {
    created: { ids: [...created], confidence: confidenceFor(reportedAny, incompleteIn(byTime, "beadsCreated")) },
    updated: { ids: [...updated], confidence: confidenceFor(reportedAny, incompleteIn(byTime, "beadsUpdated")) },
    closed: { ids: [...closed], confidence: confidenceFor(reportedAny, incompleteIn(byTime, "beadsClosed")) },
    ready: {
      ids: [...ready],
      confidence: confidenceFor(reportedAny, latest !== undefined && incompleteIn([latest], "beadsReady")),
    },
    evidenceById,
  };
}

/**
 * The model a turn actually ran on (delta 20260918 §4.2): the running model the
 * collector recorded in `runtime`, else the configured one in `usage`. Records
 * written before that delta only have the second. Every grouping by model uses
 * this one definition, so cost, the per-model lines and the overview agree.
 */
export function effectiveModel(record: Pick<TraceRecord, "runtime" | "usage">): string | null {
  return record.runtime?.model ?? record.usage?.model ?? null;
}

/**
 * Sums the tokens a trace used. Cost is left unpriced here (`unavailable`):
 * WP-209 owns the price table and applies it, so this module never has to know
 * about money.
 */
export function summariseUsage(trace: ReconstructedTrace): Usage {
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let model: string | null = null;
  for (const record of trace.records) {
    if (record.usage === null) continue;
    inputTokens += record.usage.inputTokens;
    cachedInputTokens += record.usage.cachedInputTokens;
    outputTokens += record.usage.outputTokens;
    // The model the turn ran on, so a part priced below is priced as what ran.
    model = effectiveModel(record) ?? model;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    costUsd: null,
    costBasis: "unavailable",
    model,
    pricesUpdatedAt: null,
  };
}

const tokensOf = (usage: Usage) => usage.inputTokens + usage.cachedInputTokens + usage.outputTokens;

/**
 * A trace's records grouped by the model they ran on (`effectiveModel`, delta
 * 20260918 §4.3), in order of first appearance, each summed and still unpriced.
 * Parts without tokens are dropped. `key` is the model without a provider
 * prefix — `bm-worker/claude-opus-5` and `claude-opus-5` are one model, and the
 * price table accepts both — or `""` when no model is known.
 */
function modelParts(trace: ReconstructedTrace): Array<{ key: string; usage: Usage }> {
  const byModel = new Map<string, TraceRecord[]>();
  for (const record of trace.records) {
    if (record.usage === null) continue;
    const model = effectiveModel(record) ?? "";
    const key = model.slice(model.lastIndexOf("/") + 1);
    byModel.set(key, [...(byModel.get(key) ?? []), record]);
  }
  return [...byModel.entries()]
    .map(([key, records]) => ({ key, usage: summariseUsage({ ...trace, records }) }))
    .filter((part) => tokensOf(part.usage) > 0);
}

/**
 * Tokens and cost of a trace per model it ran on (delta 20260918 §4.3,
 * REQ-058d): the same parts `usageOfTrace` prices, so the lines add up to its
 * total. A model without a price keeps `costUsd: null` and shows tokens only.
 */
export function usageByModelOf(
  trace: ReconstructedTrace,
  price?: (usage: Usage) => Usage,
): Array<{ model: string | null; usage: Usage }> {
  return modelParts(trace).map((part) => {
    const model = part.key === "" ? null : part.key;
    const usage = { ...part.usage, model };
    return { model, usage: price === undefined ? usage : price(usage) };
  });
}

/**
 * Tokens and cost per role and model (delta 20260918 §4.3, REQ-058e): the
 * per-model parts of each role's records, so a role's lines add up to what its
 * agents used and a model is keyed the same way as everywhere else.
 */
export function usageByModelRoleOf(
  trace: ReconstructedTrace,
  price?: (usage: Usage) => Usage,
): Array<{ role: TraceRecord["role"]; model: string | null; usage: Usage }> {
  const roles = [...new Set(trace.records.map((record) => record.role))];
  return roles.flatMap((role) =>
    usageByModelOf({ ...trace, records: trace.records.filter((record) => record.role === role) }, price).map((entry) => ({
      role,
      ...entry,
    })),
  );
}

/**
 * What one agent ran on, turn by turn, folded into one row per distinct
 * combination in order of first appearance (delta 20260918 §4.3). A turn with
 * `runtime` gives a recorded row; one without keeps the model its `usage` knew,
 * and says thinking and mode were not recorded.
 */
export function runtimeRowsOf(trace: ReconstructedTrace, agentId: string): RuntimeRow[] {
  const rows = new Map<string, RuntimeRow>();
  for (const record of trace.records) {
    if (record.agentId !== agentId) continue;
    const runtime = record.runtime ?? null;
    const row: Omit<RuntimeRow, "turns"> =
      runtime === null
        ? { model: record.usage?.model ?? null, thinkingOptionId: null, modeId: null, recorded: false }
        : { model: effectiveModel(record), thinkingOptionId: runtime.thinkingOptionId, modeId: runtime.modeId, recorded: true };
    const key = JSON.stringify([row.model, row.thinkingOptionId, row.modeId, row.recorded]);
    const current = rows.get(key);
    rows.set(key, current === undefined ? { ...row, turns: 1 } : { ...current, turns: current.turns + 1 });
  }
  return [...rows.values()];
}

/**
 * A trace's total usage, priced per model (delta 20260917 §5.4).
 *
 * The total used to price the summed tokens of every agent with one model —
 * the model of the last record — so on 2026-09-16 the Codex Reviewers' tokens
 * were charged as claude-opus-5 and the total ($17.71) did not match the
 * agents ($0.68 + $14.55). Now each model is priced on its own, the money is
 * the sum of the priced parts, and tokens from a model without a price are
 * named in a notice instead of being priced wrongly or hiding the rest.
 */
export function usageOfTrace(
  trace: ReconstructedTrace,
  price?: (usage: Usage) => Usage,
): { usage: Usage; notice: string | null } {
  const parts = modelParts(trace);
  const total = summariseUsage(trace);
  // No tokens at all: nothing to split, so keep the plain result.
  if (parts.length === 0) return { usage: price === undefined ? total : price(total), notice: null };
  const model = parts.length === 1 && parts[0]!.key !== "" ? parts[0]!.key : null;
  if (price === undefined) return { usage: { ...total, model }, notice: null };

  let costUsd: number | null = null;
  let pricesUpdatedAt: string | null = null;
  const unpricedModels: string[] = [];
  let unpricedTokens = 0;
  for (const part of parts) {
    const priced = price(part.usage);
    if (priced.costUsd === null) {
      unpricedModels.push(part.key === "" ? "unknown model" : part.key);
      unpricedTokens += tokensOf(part.usage);
      continue;
    }
    costUsd = (costUsd ?? 0) + priced.costUsd;
    pricesUpdatedAt = pricesUpdatedAt ?? priced.pricesUpdatedAt;
  }
  return {
    usage: {
      ...total,
      model,
      costUsd: costUsd === null ? null : Math.round(costUsd * 10_000) / 10_000,
      costBasis: costUsd === null ? "unavailable" : "estimated",
      pricesUpdatedAt,
    },
    notice:
      unpricedModels.length === 0
        ? null
        : `Cost excludes ${unpricedTokens} tokens from models without a price: ${unpricedModels.join(", ")}.`,
  };
}

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

/**
 * Tokens of one agent inside a trace, priced per model when a price table is
 * given (an agent can switch models between turns).
 */
function usageOfAgent(trace: ReconstructedTrace, agentId: string, price?: (usage: Usage) => Usage): Usage {
  return usageOfTrace({ ...trace, records: trace.records.filter((record) => record.agentId === agentId) }, price).usage;
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
      // Notices are the request's, and `summarise` derives one of them from the
      // records it was given — which here are a single turn's. Everything else
      // request-level (review calls, state, tier, linking, the agents) is
      // carried through untouched by `summarise`, so it needs no override; the
      // suite pins that invariant so a future change cannot start splitting it.
      notices: whole.notices,
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

  const workerPrompts = trace.records
    .filter((record) => record.role === "worker")
    .flatMap((record) => record.sent.slice(0, 1));
  const reviewRequests = trace.records
    .filter((record) => record.role === "reviewer")
    .flatMap((record) =>
      record.sent.map((message) => ({ ...message, batchId: /batch[\s:-]*([A-Za-z0-9._-]+)/i.exec(message.text)?.[1] ?? null })),
    );
  const managerReplies = trace.records
    .filter((record) => record.role === "manager")
    .flatMap((record) => record.received);

  return {
    ...summary,
    notices,
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
