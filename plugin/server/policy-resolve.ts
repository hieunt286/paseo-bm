/**
 * What answers a decision as it opens (autonomy design §B.5, §B.6, §B.9; PRD
 * REQ-121, REQ-123, REQ-124): only an owner precedent on its subject
 * (`resolveByPrecedent`). The policy answers nothing at open (ADR-025 decision
 * 5: the instant answer by the recommended option is removed): a decision in
 * a `delegate` cell waits for the Orchestrator, which the event bus asks
 * (`decision.opened`, `asks: "decision"`) and which decides it with
 * `bm_decide`.
 *
 * Called where decisions open: the materialiser (`q:`), `bm_ask_owner` (`o:`)
 * and a new fallback incident's listener (`f:`, when its action can run). An
 * override (`r:`) and a decision that carries a prepared change of the
 * owner's settings (§G.4) are left open: only the owner answers them. The
 * caller hands `answered` to `onSettled`. Never throws: a failure is one log
 * line, and the decision stays open for the owner.
 */
import { carriesPreparedChange, decisionKindOf, type Decision } from "../shared/decisions";
import type { Precedent } from "../shared/precedents";
import { resolveByPrecedent, type PrecedentResolveDeps } from "./precedent-resolve";

export interface ResolveAtOpenDeps extends PrecedentResolveDeps {
  /** Leaves the precedents out: one already answered this subject in the request, and did not do (the materialiser). */
  skipPrecedent?: boolean;
}

export interface ResolveAtOpenResult {
  /** The decision as stored now: the answered one, else as the precedent's step left it, else as it came. */
  decision: Decision;
  /** The decision as an owner precedent answered it; null when it stays open. */
  answered: Decision | null;
  /** Who answered it; null when nobody did. */
  by: "precedent" | null;
  /** The precedent that bears on it — the one that answered it, or the one its card suggests; null when none does. */
  precedent: Precedent | null;
}

/**
 * Answers a decision that has just opened the way every opening point does
 * (autonomy design §B.6; code review 2026-09-30 §3.4): by an active owner
 * precedent on its subject (`resolveByPrecedent`), or not at all.
 */
export function resolveAtOpen(decision: Decision, deps: ResolveAtOpenDeps): ResolveAtOpenResult {
  // §B.7, §B.9: the owner's override is the owner's own correction; no precedent answers it.
  if (decisionKindOf(decision.id) === "override") return { decision, answered: null, by: null, precedent: null };
  // Autonomy design §G.4: a prepared change of the owner's settings waits for the owner; nobody else answers it.
  if (carriesPreparedChange(decision)) return { decision, answered: null, by: null, precedent: null };
  const byPrecedent = deps.skipPrecedent === true ? null : resolveByPrecedent(decision, deps);
  const answered = byPrecedent?.resolved === true ? byPrecedent.decision : null;
  return { decision: answered ?? byPrecedent?.decision ?? decision, answered, by: answered === null ? null : "precedent", precedent: byPrecedent?.precedent ?? null };
}
