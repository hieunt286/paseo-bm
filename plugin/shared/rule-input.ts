/**
 * What the Orchestrator's rules read about one request (Orchestrator design
 * §4.1, §4.2): everything `flagsOf` needs, and nothing it would have to fetch.
 *
 * Built on the server by `ruleInputOf` (`server/request-trace.ts`) from a
 * reconstructed trace — not from `traces.get`, so there is no pricing, no live
 * bead lookup and no live timeline read. It keeps what `TraceDetail` drops:
 * each turn's recorded outcome, evidence with its paths, and the agent that
 * received each message.
 *
 * Pure types, environment-neutral: the rules in `shared/orchestrator-rules.ts`
 * import this, and must never import server code.
 */
import type {
  Confidence,
  Evidence,
  ParsedReport,
  Tier,
  TraceRecord,
  TraceState,
  TraceSummary,
} from "./contracts";

/** One recorded turn of an agent of the request. */
export interface RuleTurn {
  agentId: string;
  role: TraceRecord["role"];
  turnId: string | null;
  /** When the turn was recorded. */
  at: string;
  startedAt: string | null;
  endedAt: string;
  outcome: TraceRecord["outcome"];
}

/** A Worker or Reviewer of the request, with its live state and timing. */
export interface RuleAgent {
  agentId: string;
  role: "worker" | "reviewer";
  /** Paseo's live status; null when the agent is no longer listed (see `agentsMissing`). */
  status: string | null;
  /** The Dashboard's timing state of the agent: `running`, `failed` (live `error`) or `completed`. */
  state: TraceState;
  /** The live agent's `createdAt`, or failing that the start of its first recorded turn (design §4.3). */
  startedAt: string | null;
  /** When its last turn was recorded; null when none was. */
  lastActivityAt: string | null;
}

/**
 * One message in an agent's timeline. For an inbound message `agentId` is the
 * agent that RECEIVED it; for a reply, the agent that wrote it.
 */
export interface RuleMessage {
  agentId: string;
  role: TraceRecord["role"];
  at: string;
  text: string;
  truncated: boolean;
  /**
   * `user` when typed in Paseo's app, `agent` when another agent sent it. Null
   * on records written before the field existed — never read that as `user`.
   */
  origin: "user" | "agent" | null;
}

export interface RuleInput {
  traceId: string;
  requestId: string | null;
  requestedAt: string;
  managerAgentId: string | null;
  workerIds: string[];
  reviewerIds: string[];
  tier: Tier | null;
  state: TraceState;
  /**
   * How the request's agents were attached. The trace is rebuilt from the
   * agents that exist now, so deleting one can change `workerIds` and
   * `reviewCalls`; a flag says so when this is not `exact` (design §4.1).
   */
  linking: Confidence;
  /** Agents of the request that are no longer on this machine. */
  agentsMissing: string[];
  /** Null when no Reviewer turn was recorded: unknown, not zero. */
  reviewCalls: number | null;
  /** The Dashboard's bead counts; `created` includes `br create` commands that name ids. */
  beadCounts: TraceSummary["beadCounts"];
  /** Every path a report listed in `filesChanged`, first mention first. */
  filesChanged: string[];
  /** Edit and write tool calls (`kind: "file"`, the path in `detail`), oldest first. */
  fileEdits: Evidence[];
  /**
   * Shell evidence holding a `br create` that acts (not `--help` or
   * `--dry-run`), oldest first. Separate from `beadCounts`: `br create` names no
   * id, so a command whose bead no report lists adds nothing to the count.
   */
  brCreates: Evidence[];
  /** Every recorded turn of the request, of every role, oldest first. */
  turns: RuleTurn[];
  /** Workers, then Reviewers, in the trace's order. */
  agents: RuleAgent[];
  /** The request's reports, oldest first, with `unparsedFields`/`incompleteFields` and `phase`. */
  reports: ParsedReport[];
  /** Every inbound message of every agent of the request, oldest first. */
  inbound: RuleMessage[];
  /** What the Manager wrote in its recorded turns, oldest first. */
  managerReplies: RuleMessage[];
}
