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
 * What is read off a rebuilt trace lives beside it (code review 2026-09-30
 * §4): timing and bead actions in `trace-timing.ts`, tokens and cost in
 * `trace-usage.ts`, the Dashboard's rows in `trace-views.ts`.
 */
import { looksLikeReport, ownReviewsOf, requestIdFromText } from "./bm-report";
import { isPluginNotice } from "./notices";
import { byAt, uniqueBy } from "../shared/order";
import type {
  Confidence,
  GuardrailReport,
  ParsedReport,
  ParsedReview,
  Tier,
  TraceMessage,
  TraceRecord,
  TraceState,
} from "../shared/contracts";

/** Agent facts reconstruction needs, from `agents.list` or the store. */
export interface AgentFacts {
  id: string;
  /**
   * `orchestrator` only from `bmAgentsOf(…, { includeOrchestrator: true })`,
   * which no reconstruction reads: the assessment agent is never part of a
   * request's trace (orchestrator design §3.2).
   */
  role: "manager" | "worker" | "reviewer" | "orchestrator" | "unknown";
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
  /**
   * `bm.handoffFrom` label: the Worker this one took its request over from by
   * a handoff (autonomy design §G.6), checked by the plugin on `agent.created`.
   * Absent when the agent carries none.
   */
  handoffFrom?: string | null;
}

/** One reconstructed request, before timing and bead enrichment (WP-206.1.2). */
/**
 * The Workers of a trace that took its request over by a handoff (autonomy
 * design §G.6), each with the Worker it replaced: those whose facts carry a
 * `bm.handoffFrom` label. The brief's first line is only a secondary signal
 * (`shared/handoff.ts`), since the Manager may drop it. Pure.
 */
export function handoffSuccessorsOf(trace: Pick<ReconstructedTrace, "workerIds">, agents: ReadonlyMap<string, AgentFacts>): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of trace.workerIds) {
    const from = agents.get(id)?.handoffFrom ?? null;
    if (from !== null && from !== "") out.set(id, from);
  }
  return out;
}

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
 *
 * A tool-built report carries its outbox `recordId` (design §16.7): one the
 * request already holds (`held`), or one earlier in `reports`, is the same
 * report again — a delivery that reached its target twice across a reload —
 * and is dropped.
 */
export function reportsBelongingTo(requestId: string | null, reports: readonly ParsedReport[], held: readonly ParsedReport[] = []): ParsedReport[] {
  const seen = new Set(held.flatMap((report) => (report.recordId === undefined ? [] : [report.recordId])));
  return reports.filter((report) => {
    if (report.requestId !== null && report.requestId !== requestId) return false;
    if (report.recordId === undefined) return true;
    if (seen.has(report.recordId)) return false;
    seen.add(report.recordId);
    return true;
  });
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
        reviews: ownReviewsOf(record),
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
    bucket.trace.reports.push(...reportsBelongingTo(bucket.trace.requestId, record.reports, bucket.trace.reports));
    bucket.trace.reviews.push(...ownReviewsOf(record));
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
    const previousNamed: (string | null)[] = new Array(own.length).fill(null);
    for (let position = 1; position < own.length; position += 1) {
      previousNamed[position] = idOf[own[position - 1]!] ?? previousNamed[position - 1] ?? null;
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
      // A turn with no inbound message is the Manager woken by its Worker's end
      // of turn: it closes the request already open (its summary to the
      // user), not the next one. Folded forward, it made a row that predated
      // the next request by 41 s and charged it the summary's tokens
      // (Orchestrator acceptance 2026-09-28, finding P1).
      const nextRequestId =
        text === null
          ? (previousNamed[position] ?? nextNamed[position] ?? null)
          : (openedAfter(position) ?? nextNamed[position] ?? null);
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
 * Request id of an agent, in the order design §6.1 step 4 fixes: label → its own
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

/**
 * Number of review requests a Reviewer received: its inbound non-`BM-REVIEW` messages.
 *
 * `replacementIds` are Reviewers that took over from one stopped on its
 * provider plan (delta 20260921 §4.5.1). The Worker sends each of them,
 * unchanged, the review message the old one got: the same review call, so the
 * FIRST message each would count is skipped and every later one counts. A
 * replacement the Worker did not label `bm.replaces` is not in the set and its
 * resend IS counted — the safe failure: `BM-BUDGET`, and the Manager asks the user.
 */
export function reviewCallsOf(
  reviewerIds: readonly string[],
  records: readonly TraceRecord[],
  replacementIds: Iterable<string> = [],
): number | null {
  // Replacements whose resend has not been met yet.
  const resendPending = new Set(replacementIds);
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
      if (resendPending.delete(record.agentId)) continue;
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
  // `Decided: …` entries are the Worker's own choices, recorded for the user to
  // overturn — not something waiting (design delta 20260924-instruction-quality).
  const withoutNotes = text
    .replace(/(Suggestion \(not done\)|\bDecided):[^]*?(?=Suggestion \(not done\):|\bDecided:|$)/gi, "")
    .replace(/^[\s.;,]+|[\s.;,]+$/g, "")
    .trim();
  return withoutNotes !== "";
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
  /**
   * Reviewers that replaced a stopped one (delta 20260921 §4.5.1): their first
   * message is not a new review call (`reviewCallsOf`). None by default.
   */
  replacementIds?: Iterable<string>;
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
  const replacementIds = new Set(options.replacementIds ?? []);
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
      bucket.trace.reports.push(...reportsBelongingTo(bucket.trace.requestId, [report], bucket.trace.reports));
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
      trace.reports.push(...reportsBelongingTo(trace.requestId, record.reports, trace.reports));
      // Only a Reviewer's own answers: a quoted or relayed block is the same review again (bead 7gxw.12).
      trace.reviews.push(...ownReviewsOf(record));
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
    // A tool-built report or review is keyed by its outbox record (design §16.7).
    trace.reports = uniqueBy(
      [...trace.reports].sort(byAt),
      (report) => (report.recordId !== undefined ? `record:${report.recordId}` : `${report.agentId}|${report.phase ?? ""}|${report.requestId ?? ""}|${report.at}`),
    );
    trace.reviews = uniqueBy(
      [...trace.reviews].sort(byAt),
      (review) => (review.recordId !== undefined ? `record:${review.recordId}` : `${review.agentId}|${review.batchId ?? ""}|${review.verdict ?? ""}|${review.at}`),
    );
    trace.records.sort(byAt);
    trace.segments = segmentsOf(trace);

    const lastGuardrail = [...trace.reports].reverse().find((report) => report.guardrail !== null);
    trace.guardrailReported = lastGuardrail?.guardrail ?? null;
    trace.tier = [...trace.reports].reverse().find((report) => report.tier !== null)?.tier ?? null;
    trace.reviewCalls = reviewCallsOf(trace.reviewerIds, trace.records, replacementIds);

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
