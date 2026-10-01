/**
 * What the Orchestrator's rule reads about one request (Orchestrator design
 * §4.1, §4.2): everything `flagsOf` needs, and nothing it would have to fetch.
 * With the assessment-only rules retired (autonomy design §B.9), that is the
 * request's tier, its review calls and the messages its agents received.
 *
 * Built on the server by `ruleInputOf` (`server/request-trace.ts`) from a
 * reconstructed trace — not from `traces.get`, so there is no pricing, no live
 * bead lookup and no live timeline read. It keeps what `TraceDetail` drops:
 * the agent that received each message.
 *
 * Pure types, environment-neutral: the rules in `shared/orchestrator-rules.ts`
 * import this, and must never import server code.
 */
import type { Tier, TraceRecord } from "./contracts";

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
  tier: Tier | null;
  /** Null when no Reviewer turn was recorded: unknown, not zero. */
  reviewCalls: number | null;
  /** Every inbound message of every agent of the request, oldest first. */
  inbound: RuleMessage[];
}
