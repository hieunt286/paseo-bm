/**
 * `decisions.override` (autonomy design §B.7, §B.9; PRD REQ-125 b, REQ-123 b):
 * the Override of a line in the Inbox's Decided for you.
 *
 * In one synchronous block — nothing can answer or override the decision
 * between the read and the writes:
 *
 * 1. The decision must have been answered for the owner, by the policy or an
 *    owner precedent (`overrideRefusalOf`); every refusal writes nothing.
 * 2. It records the reversal `overridden` (`recordReversal`, §B.3) naming the
 *    override's id, `r:<uuid>` — first, so the id is fixed on the decision.
 * 3. It opens the override (`overrideDecisionOf`): a new owner decision with
 *    the same question and options that `supersedes` the delegated one, open
 *    until the owner answers it. It is never handed to `resolveAtOpen`: no
 *    precedent and no policy answers the owner's own correction.
 *
 * Pressed again, or after a write failed between 2 and 3, the reversal's id
 * gives the same override back (opened now if it was not stored): one
 * decision, one override. Only the call that recorded the override takes the
 * class back (`demoteOnReversal`, §B.4): a `delegate` cell becomes `shadow`
 * with an `autonomy-demoted` alert; any other cell is left as it is.
 *
 * Override answers and sends nothing. The delegated answer, already
 * delivered, is not recalled; once the owner answers the override
 * (`decisions.answer`), the corrected answer reaches the agent concerned
 * through the `override` delivery (`override-delivery.ts`).
 */
import { randomUUID } from "node:crypto";
import { DashboardError, type DecisionsOverrideInput, type DecisionsOverrideOutput } from "../shared/contracts";
import { overrideDecisionOf, overrideIdOf, overrideRefusalOf } from "../shared/decision-override";
import { OVERRIDE_ID_PREFIX, ownerViewOfDecision, recordReversal, type Decision } from "../shared/decisions";
import { demoteOnReversal } from "./autonomy-rpc";
import { createDecisionStore } from "./decision-store";
import type { DecisionRpcDeps } from "./decision-rpc";
import { READ_FAILED, coded, logOf, requireDataHome } from "./rpc-kit";

export type DecisionOverrideDeps = DecisionRpcDeps & {
  /** The part after `r:` of a new override's id; `randomUUID` by default. */
  newId?: () => string;
};

interface Overridden {
  decision: Decision;
  overridden: Decision;
  created: boolean;
}

/** `decisions.override`: see the module comment. */
export function handleDecisionsOverride(input: DecisionsOverrideInput, deps: DecisionOverrideDeps = {}): DecisionsOverrideOutput {
  const home = requireDataHome(deps, "override the decision");
  const log = logOf(deps);
  const store = createDecisionStore(home, { log });
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  // Synchronous from this read to the last write (no `await`): nothing answers or overrides it in between.
  const current = coded(READ_FAILED, "read the decision", () => store.get(input.id));
  if (current === null) throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${input.id}`);
  const refusal = overrideRefusalOf(current);
  if (refusal !== null) throw new DashboardError(refusal.refusal === "settled" ? "E_DECISION_SETTLED" : "E_DECISION_NOT_DELEGATED", refusal.message);
  const result = coded("E_DECISION_WRITE_FAILED", "override the decision", (): Overridden => {
    const known = overrideIdOf(current);
    if (known !== null) {
      const stored = store.get(known, current.workspaceId);
      if (stored !== null) return { decision: stored, overridden: current, created: false };
    }
    const id = known ?? `${OVERRIDE_ID_PREFIX}${(deps.newId ?? randomUUID)()}`;
    const reversed = store.transition(current.id, (decision) => recordReversal(decision, { kind: "overridden", at, ref: id }), current.workspaceId);
    if (reversed.status === "not-found") throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${input.id}`);
    if (reversed.status === "refused") throw new DashboardError("E_DECISION_NOT_DELEGATED", reversed.message);
    const opened = store.open(overrideDecisionOf(reversed.decision, { id, at }));
    return { decision: opened.decision, overridden: reversed.decision, created: true };
  });
  // §B.4: the owner's override of an answer made for them takes its delegated class back at once.
  if (result.created) demoteOnReversal(result.overridden, "overridden", { home, now: () => now, log });
  return { decision: ownerViewOfDecision(result.decision), overridden: result.overridden, created: result.created };
}
