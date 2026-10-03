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
 * knows comes in `RuleFacts` — the review budget (`server/review-budget.ts`).
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
  /** The owner's review budget per tier (Settings → Coordination, §G.7; `readReviewBudget`), 2 / 2 / 4 by default. */
  reviewBudget: Readonly<Record<Tier, number>>;
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

/**
 * A request's review ceiling (design §16.8): the owner's budget for its tier
 * plus the calls the request's review-budget grants added.
 */
export function reviewCeilingOf(budget: number, granted: number): number {
  return budget + granted;
}

/**
 * True when `calls` review calls are past the ceiling once the `exempt` ones
 * are left out — the calls of every batch an `{ untilClean }` grant covers,
 * live or spent (design §16.8; `ruleReviewGrantOf` in `server/review-tools.ts`). The one
 * comparison the review tools (of the calls after one more), this rule and
 * the Manager's budget notice (`overrunOf`) all make.
 */
export function overReviewCeiling(calls: number, exempt: number, ceiling: number): boolean {
  return calls - exempt > ceiling;
}

/** A message a Reviewer received that is not a review call (`reviewCallsOf` in `server/traces.ts`). */
const REVIEW_BLOCK = /^\s*>?\s*(?:[-*]\s*)?bm-review\b/im;

function overBudget(input: RuleInput, facts: RuleFacts): Flag | null {
  const calls = input.reviewCalls;
  if (calls === null) return null;
  const evidence: FlagEvidence[] = input.inbound
    .filter((message) => message.role === "reviewer" && !isPluginNotice(message.text) && !REVIEW_BLOCK.test(message.text))
    .map((message) => ({ agentId: message.agentId, at: message.at, kind: "sent", excerpt: message.text }));
  const why = "Review calls past the tier's budget cost time and tokens the size of the request does not justify.";
  // Design §16.8: the request's grants raise its ceiling, and the calls of a live untilClean batch are left out.
  const granted = input.reviewGrant?.calls ?? 0;
  const exempt = input.reviewGrant?.exempt ?? 0;
  if (input.tier === null) {
    const smallest = Math.min(...Object.values(facts.reviewBudget));
    if (!overReviewCeiling(calls, exempt, reviewCeilingOf(smallest, granted))) return null;
    return flag(
      "review.over-budget",
      "warning",
      "unknown",
      `The request made ${plural(calls, "review call")}, but no report gave its tier, so its budget is not known.`,
      why,
      evidence,
    );
  }
  const budget = facts.reviewBudget[input.tier];
  if (!overReviewCeiling(calls, exempt, reviewCeilingOf(budget, granted))) return null;
  const over = granted > 0 ? `over its budget of ${budget} plus ${granted} granted` : `over its budget of ${budget}`;
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
