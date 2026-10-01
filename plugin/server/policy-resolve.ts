/**
 * Delegation by the recommended predictor (autonomy design §B.5, §B.9; PRD
 * REQ-121, REQ-123): a decision that opens in a `delegate` cell whose
 * predictor is `recommended` is answered at once, in the same write that
 * settles it, with its recommended option — `by: policy`, the cell's `class`
 * and `predictor`, and the reason "The recommended option: <class> is
 * delegated to it in this project". The rule is pure
 * (`recommendedDelegationOf`, `shared/autonomy.ts`); this module reads the
 * policy store and writes the decision store.
 *
 * - **After the precedents.** Every opening point calls `resolveAtOpen`, which
 *   calls `resolveByPrecedent` first and this only when no precedent bears on
 *   the decision: one that answers it is the owner's own standing word, and
 *   one that is only suggested (an owner-fixed class, or a fallback incident's
 *   words) leaves it to the owner rather than to the recommended option.
 *   Called where decisions open: the materialiser (`q:`), `bm_ask_owner`
 *   (`o:`) and a new fallback incident's listener (`f:`, when its action can
 *   run at once).
 * - **Never the owner's alone.** Release, data, security and cost never read
 *   `delegate`; an option allowing one of their effects is never chosen, and
 *   `answerDecision` refuses to store such a policy answer. Nor is a decision
 *   an option of which carries a prepared change of the owner's settings
 *   (§G.4): `resolveAtOpen` leaves it open, and `answerDecision` refuses any
 *   answer but the owner's. An `owner` or
 *   `shadow` cell, a cell whose predictor is the Orchestrator, and a decision
 *   with no (or more than one) recommended option are left open.
 * - **Delivered as an owner answer.** `via: inbox`, as a precedent's: nothing
 *   was typed in a chat. The answer grants the option's effects as the owner's
 *   choice of it would; the caller hands the answered decision to `onSettled`
 *   (`settledByKind`), so a Worker gets it in the same `BM-ANSWERS` block as an
 *   owner answer and a prepared command goes as `BM-COMMAND` v2 with
 *   `authority: policy:<class>` (`orchestrator-decisions.ts`). The provenance
 *   is shown to the owner (cards, Work, the digest), not to the Worker.
 * - **Not on an unverified finish** (autonomy design §C.3, §C.6 change-008
 *   C4). While the decision's request stands finished-unverified
 *   (`finishedUnverified`, read by the caller from the trace store:
 *   `isFinishedUnverifiedNow`), a recommended option that acts on it as done
 *   — declares `commit`, or carries a prepared command approving `commit` or
 *   of intent `release` (`actsOnFinish`) — is not chosen: the decision stays
 *   open for the owner. A precedent still answers it: that is the owner's
 *   standing word.
 * - **Taken back on a reversal.** Re-asked, overridden or reopened, a policy
 *   answer demotes its class (`demoteOnReversal`, §B.4); `autonomy.reset` stops
 *   all delegation of a project at once. A policy answer is not an
 *   intervention of the Orchestrator's and is not logged as one (§G.3); the
 *   ledger counts it as delegated, never as an owner agreement (§B.3).
 *
 * The policy is read at each call; a store that cannot be read reads as every
 * class `owner` (one log line). Never throws: a failure is one log line, and a
 * decision it could not answer simply stays open for the owner.
 */
import { recommendedDelegationOf, unverifiedFinishRefusalOf } from "../shared/autonomy";
import { answerDecision, carriesPreparedChange, decisionKindOf, type Decision } from "../shared/decisions";
import type { Precedent } from "../shared/precedents";
import { currentPolicy } from "./autonomy-store";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { resolveByPrecedent } from "./precedent-resolve";
import { errorText } from "./rpc-kit";

export interface PolicyResolveDeps {
  /** The data folder holding both stores. */
  home: string;
  now: Date;
  log?: (message: string) => void;
  /** The decision store to write through; one over `home` by default. */
  store?: DecisionStore;
  /**
   * The decision's request stands finished-unverified now (autonomy design
   * §C.6, change-008 C4), as the caller read it from the trace store
   * (`isFinishedUnverifiedNow`): then an option that acts on the finish is
   * left to the owner. Absent or false: no such request.
   */
  finishedUnverified?: boolean;
}

export interface PolicyResolveResult {
  /** The decision as stored now: answered `by: policy` when this call answered it, else as it came. */
  decision: Decision;
  /** True when this call answered it. */
  resolved: boolean;
}

const defaultLog = (message: string): void => console.warn(message);

/**
 * Answers a decision that has just opened with its recommended option when
 * the owner's policy delegates its class to that predictor (see the module
 * comment). Anything else — including a decision no longer `open` — is
 * returned as it came, and nothing is written.
 */
export function resolveByPolicy(decision: Decision, deps: PolicyResolveDeps): PolicyResolveResult {
  const log = deps.log ?? defaultLog;
  const unchanged: PolicyResolveResult = { decision, resolved: false };
  if (decision.status !== "open") return unchanged;
  // The owner's policy as it is now; every class `owner` when it cannot be read.
  const policy = currentPolicy(deps.home, (reason) => log(`[paseo-bm] could not read the autonomy policy; every decision stays the owner's: ${reason}`));
  const chosen = recommendedDelegationOf(policy, decision);
  if (chosen === null) return unchanged;
  // Autonomy design §C.6 (change-008 C4): nothing acts on an unverified finish for the owner.
  const unverified = unverifiedFinishRefusalOf(decision, chosen.optionKey, deps.finishedUnverified === true);
  if (unverified !== null) {
    log(`[paseo-bm] the policy left decision ${decision.id} to the owner: ${unverified}`);
    return unchanged;
  }
  try {
    const store = deps.store ?? createDecisionStore(deps.home, { log });
    const at = deps.now.toISOString();
    const mutation = store.transition(
      decision.id,
      (current) => {
        // Checked again on the stored decision, in the write that answers it.
        const answer = recommendedDelegationOf(policy, current);
        if (answer === null) return { ok: false, refusal: "settled", message: `decision ${current.id} is no longer the policy's to answer` };
        const again = unverifiedFinishRefusalOf(current, answer.optionKey, deps.finishedUnverified === true);
        if (again !== null) return { ok: false, refusal: "settled", message: again };
        return answerDecision(current, { by: "policy", via: "inbox", at, ...answer });
      },
      decision.workspaceId,
    );
    if (mutation.status === "updated") return { decision: mutation.decision, resolved: true };
    if (mutation.status === "refused") {
      log(`[paseo-bm] the policy did not answer decision ${decision.id}: ${mutation.message}`);
      return { decision: mutation.decision, resolved: false };
    }
    return unchanged;
  } catch (error) {
    log(`[paseo-bm] the policy could not answer decision ${decision.id}: ${errorText(error)}`);
    return unchanged;
  }
}

export interface ResolveAtOpenDeps extends PolicyResolveDeps {
  /** Leaves the precedents out: one already answered this subject in the request, and did not do (the materialiser). */
  skipPrecedent?: boolean;
  /** Leaves the policy out: it or a precedent already answered this subject in the request (the materialiser). */
  skipPolicy?: boolean;
}

export interface ResolveAtOpenResult {
  /** The decision as stored now: the answered one, else as the precedent's step left it, else as it came. */
  decision: Decision;
  /** The decision as an owner precedent or the policy answered it; null when it stays open for the owner. */
  answered: Decision | null;
  /** Who answered it; null when nobody did. */
  by: "precedent" | "policy" | null;
  /** The precedent that bears on it — the one that answered it, or the one its card suggests; null when none does. */
  precedent: Precedent | null;
}

/**
 * Answers a decision that has just opened the way every opening point does
 * (autonomy design §B.5, §B.6; code review 2026-09-30 §3.4): an active owner
 * precedent on its subject first (`resolveByPrecedent`, unless its class is
 * owner-fixed), then — only when no precedent bears on it — the owner's
 * policy with its recommended option (`resolveByPolicy`). Called by the
 * materialiser (`q:`), `bm_ask_owner` (`o:`; not while the loop guard of its
 * request is full, when the owner answers) and the fallback incidents (`f:`,
 * when their delivery can run). The caller hands `answered` to `onSettled`.
 * Never throws: a failure is one log line, and the decision stays open.
 */
export function resolveAtOpen(decision: Decision, deps: ResolveAtOpenDeps): ResolveAtOpenResult {
  // §B.7, §B.9: the owner's override is the owner's own correction; no precedent and no policy answers it.
  if (decisionKindOf(decision.id) === "override") return { decision, answered: null, by: null, precedent: null };
  // Autonomy design §G.4: a prepared change of the owner's settings waits for the owner; nobody else answers it.
  if (carriesPreparedChange(decision)) return { decision, answered: null, by: null, precedent: null };
  const byPrecedent = deps.skipPrecedent === true ? null : resolveByPrecedent(decision, deps);
  const byPolicy =
    byPrecedent?.resolved === true || byPrecedent?.precedent != null || deps.skipPolicy === true ? null : resolveByPolicy(decision, deps);
  const by = byPrecedent?.resolved === true ? "precedent" : byPolicy?.resolved === true ? "policy" : null;
  const answered = by === "precedent" ? byPrecedent!.decision : by === "policy" ? byPolicy!.decision : null;
  return { decision: answered ?? byPrecedent?.decision ?? decision, answered, by, precedent: byPrecedent?.precedent ?? null };
}
