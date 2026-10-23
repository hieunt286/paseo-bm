/**
 * The Orchestrator's runtime rule: a fixed check scored over one request, no
 * LLM (Orchestrator design §4.1, §4.2; REQ-072).
 *
 * Only `review.over-budget` is left, because the stall pass reads it (autonomy
 * design §A.8). The six rules that served only the workflow assessment are
 * retired with it (§B.8, §B.9): the replay measures what they flagged
 * (`eval-metrics.ts` `supplementary.process`), and the Orchestrator reads a
 * request through its bounded tools, not through flags.
 *
 * `flagsOf` is pure and deterministic: the same `RuleInput` and `RuleFacts`
 * always give the same flags, in the order of `RULE_IDS`, at most one flag per
 * rule. A rule that lacks the data to decide returns `state: "unknown"` rather
 * than staying silent (REQ-072d); it never turns missing data into a pass.
 *
 * This module is `shared/`: it imports no server code. What only the server
 * knows comes in `RuleFacts` — the owner's review settings, for the cap.
 * It also keeps `isProcessDocumentPath`, which the live Worker watch and the
 * replay share.
 */
import type { Tier } from "./contracts";
import { isPluginNotice } from "./notices";
import { byAt } from "./order";
import type { RuleId } from "./orchestrator";
import type { RuleInput } from "./rule-input";
import { plural } from "./text";

/** The longest excerpt a flag's evidence carries (design §4.1). */
export const EXCERPT_MAX_CHARS = 160;

export interface FlagEvidence {
  agentId: string;
  at: string | null;
  /** `sent`: a message the agent RECEIVED (the trace record's `sent`). */
  kind: "sent";
  /** At most `EXCERPT_MAX_CHARS` characters. */
  excerpt: string;
}

export interface Flag {
  rule: RuleId;
  severity: "info" | "warning";
  state: "raised" | "unknown";
  /** One English sentence: what was seen. */
  observed: string;
  /** One English sentence: why it matters. */
  why: string;
  evidence: FlagEvidence[];
}

export interface RuleFacts {
  /** The owner's review settings (Settings → Coordination): `review.callsPerBatch`, 3 by default (delivery line design §5.3). */
  review: { readonly callsPerBatch: number };
}

/** One line, whitespace collapsed, cut to `EXCERPT_MAX_CHARS` characters with an ellipsis. */
export function excerptOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= EXCERPT_MAX_CHARS ? line : `${chars.slice(0, EXCERPT_MAX_CHARS - 1).join("")}…`;
}

function flag(
  rule: RuleId,
  severity: Flag["severity"],
  state: Flag["state"],
  observed: string,
  why: string,
  evidence: FlagEvidence[],
): Flag {
  return {
    rule,
    severity,
    state,
    observed,
    why,
    // Oldest first, whatever order the rule found them in (a missing time first).
    evidence: [...evidence].sort(byAt).map((entry) => ({ ...entry, excerpt: excerptOf(entry.excerpt) })),
  };
}

// ── Process documents ───────────────────────────────────────────────────────

const PROCESS_DOC = /(?:^|[\\/])docs[\\/](?:plans|adr)[\\/]/;

/**
 * True for a path under `docs/plans/` or `docs/adr/`, relative or absolute: a
 * plan or an ADR is process weight a Small request never needs. Product and
 * design documents do not count — `worker.md` lets a Small request correct the
 * documents that describe it, and the evidence cannot tell creating from
 * editing. Shared by the live Worker watch (design §6.5) and the replay
 * (`eval-metrics.ts`), which must use the same test.
 */
export function isProcessDocumentPath(path: string): boolean {
  return PROCESS_DOC.test(path);
}

// ── review.over-budget ──────────────────────────────────────────────────────

/** Mmax: the milestone batches a request of each tier is paid for (delivery line design §5.3). */
export const REVIEW_MILESTONES_MAX: Readonly<Record<Tier, number>> = { Small: 1, Medium: 2, Large: 4 };

/**
 * A request's review cap (delivery line design §5.3): `callsPerBatch` ×
 * min(M, Mmax[tier]), where M is its milestone batches — the one being opened
 * included — and never fewer than one: a request that makes a review call has
 * a batch. At the defaults at most 3 / 6 / 12 calls, pooled across the
 * request's batches. The one function the review tools, this rule, the stall
 * reason, the Manager's notice (`overrunOf`) and the governor use; the owner's
 * granted calls (`grantedCallsOf`) are added to it by each.
 */
export function reviewCapOf(tier: Tier, milestones: number, settings: { readonly callsPerBatch: number }): number {
  return settings.callsPerBatch * Math.min(Math.max(1, milestones), REVIEW_MILESTONES_MAX[tier]);
}

/**
 * True when `calls` review calls are past `ceiling` (the cap plus the granted
 * calls). No call is exempt: an older build's `{ untilClean }` grant no longer
 * leaves any out (delivery line design §5.6). The one comparison the review
 * tools (of the calls after one more), this rule and the Manager's notice all
 * make.
 */
export function overReviewCap(calls: number, ceiling: number): boolean {
  return calls > ceiling;
}

/** A message a Reviewer received that is not a review call (`reviewCallsOf` in `server/traces.ts`). */
const REVIEW_BLOCK = /^\s*>?\s*(?:[-*]\s*)?bm-review\b/im;

function overBudget(input: RuleInput, facts: RuleFacts): Flag | null {
  const calls = input.reviewCalls;
  if (calls === null) return null;
  const evidence: FlagEvidence[] = input.inbound
    .filter((message) => message.role === "reviewer" && !isPluginNotice(message.text) && !REVIEW_BLOCK.test(message.text))
    .map((message) => ({ agentId: message.agentId, at: message.at, kind: "sent", excerpt: message.text }));
  const why = "Review calls past the request's review cap cost time and tokens the size of the request does not justify.";
  // Design §16.8: the request's grants raise its ceiling; delivery line design §5.6: no call is exempt.
  const granted = input.reviewGrant?.calls ?? 0;
  const milestones = input.reviewGrant?.milestones ?? 1;
  if (input.tier === null) {
    // The smallest cap of any tier at these milestones: Small's.
    if (!overReviewCap(calls, reviewCapOf("Small", milestones, facts.review) + granted)) return null;
    return flag(
      "review.over-budget",
      "warning",
      "unknown",
      `The request made ${plural(calls, "review call")}, but no report gave its tier, so its review cap is not known.`,
      why,
      evidence,
    );
  }
  const cap = reviewCapOf(input.tier, milestones, facts.review);
  if (!overReviewCap(calls, cap + granted)) return null;
  const over = granted > 0 ? `over its review cap of ${cap} plus ${granted} granted` : `over its review cap of ${cap}`;
  return flag(
    "review.over-budget",
    "warning",
    "raised",
    `The ${input.tier} request made ${plural(calls, "review call")}, ${over}.`,
    why,
    evidence,
  );
}

// ── The catalogue ───────────────────────────────────────────────────────────

/**
 * Every flag of one request, in the order of `RULE_IDS`. Pure: reads only its
 * two arguments and changes neither.
 */
export function flagsOf(input: RuleInput, facts: RuleFacts): Flag[] {
  return [overBudget(input, facts)].filter((entry): entry is Flag => entry !== null);
}
