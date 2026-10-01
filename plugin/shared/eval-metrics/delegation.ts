/**
 * A-4 and A-5 of delegated decisions (evaluation design §4; autonomy design
 * §B.3, §B.7, §B.9): per decision class, what became of the decisions the
 * owner's policy or a precedent answered — overridden by the owner (A-4),
 * reversed in any way (A-5) — and, as A-5's reference, the owner's own
 * answers reversed.
 *
 * Read from the stored decisions only, as the agreement ledger reads them
 * (`shared/autonomy-ledger.ts`): the class is `decisionClassOf`, a reversal is
 * one the decision records (`reversals[]`: re-asked, overridden, reopened),
 * and a decision reversed twice, or the same way twice, counts once, and once
 * per kind. An override is an `r:` decision that `supersedes` a delegated one;
 * the Override writes it together with the reversal `overridden` (§B.7), so
 * either alone counts, once. An answer `by: orchestrator` (Phase 1's
 * `bm_decide`, change-004) is in neither figure (change-007 C4).
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import {
  DECISION_CLASSES,
  REVERSAL_KINDS,
  carriesPreparedChange,
  decisionClassOf,
  decisionKindOf,
  type Decision,
  type DecisionClass,
  type ReversalKind,
} from "../decisions";
import { timeOrNull } from "../time";
import { ratio, within } from "./helpers";
import type { EvalScope, EvalStores } from "./scope";
import type { EvalMetrics, EvalUnknowns, OverrideCounts, ReversalRate } from "./types";

/**
 * A stored decision counts when its request is in the window; one without a
 * request, or of a request no record shows, when it was asked in the window
 * (as the Orchestrator's decisions are scoped for A-2).
 */
function decisionInScope(scope: EvalScope, decision: Decision): boolean {
  if (decision.requestId !== null && scope.byRequest.has(decision.requestId)) return scope.included.has(decision.requestId);
  return within(timeOrNull(decision.askedAt), scope.bounds);
}

const placeOf = (workspaceId: string, id: string): string => `${workspaceId}\u0000${id}`;

const noOverrides = (): OverrideCounts => ({ delegated: 0, byPolicy: 0, byPrecedent: 0, overridden: 0, rate: null });

const noReversals = (): ReversalRate => ({
  decisions: 0,
  reversed: 0,
  byKind: Object.fromEntries(REVERSAL_KINDS.map((kind) => [kind, 0])) as Record<ReversalKind, number>,
  rate: null,
});

function byClassOf<T>(make: () => T): Record<DecisionClass, T> {
  return Object.fromEntries(DECISION_CLASSES.map((decisionClass) => [decisionClass, make()])) as Record<DecisionClass, T>;
}

function addReversals(counts: ReversalRate, kinds: ReadonlySet<ReversalKind>): void {
  counts.decisions += 1;
  if (kinds.size === 0) return;
  counts.reversed += 1;
  for (const kind of kinds) counts.byKind[kind] += 1;
}

export interface DelegationFigures {
  a4: EvalMetrics["a4"];
  /** A-5's figures over delegated decisions, and the owner's own as its reference. */
  a5: Pick<EvalMetrics["a5"], "delegated" | "owner">;
}

/** A-4 and A-5 of the delegated decisions in scope, per class, with the owner's reference. */
export function delegationOf(scope: EvalScope, stores: EvalStores, unknowns: EvalUnknowns): DelegationFigures {
  // The decisions an override supersedes, whenever the override came: what became of a decision in scope.
  const overriddenPlaces = new Set<string>();
  for (const decision of stores.decisions) {
    if (decisionKindOf(decision.id) === "override" && decision.supersedes !== null) overriddenPlaces.add(placeOf(decision.workspaceId, decision.supersedes));
  }

  const overrides = { ...noOverrides(), byClass: byClassOf(noOverrides) };
  const delegated = { ...noReversals(), byClass: byClassOf(noReversals) };
  const owner = { ...noReversals(), byClass: byClassOf(noReversals) };
  const seen = new Set<string>();
  for (const decision of stores.decisions) {
    const answer = decision.answer;
    if (decision.status !== "answered" || answer === null || !decisionInScope(scope, decision)) continue;
    const place = placeOf(decision.workspaceId, decision.id);
    if (seen.has(place)) continue;
    seen.add(place);
    const decisionClass = decisionClassOf(decision);
    const kinds = new Set((decision.reversals ?? []).map((reversal) => reversal.kind));

    if (answer.by === "policy" || answer.by === "precedent") {
      if (overriddenPlaces.has(place)) kinds.add("overridden");
      for (const counts of [overrides, overrides.byClass[decisionClass]]) {
        counts.delegated += 1;
        if (answer.by === "policy") counts.byPolicy += 1;
        else counts.byPrecedent += 1;
        if (kinds.has("overridden")) counts.overridden += 1;
      }
      addReversals(delegated, kinds);
      addReversals(delegated.byClass[decisionClass], kinds);
      continue;
    }
    if (answer.by !== "owner") continue;
    // The reference: owner answers whose reversals can be recorded (re-asked, reopened), never a settings change.
    const kind = decisionKindOf(decision.id);
    if ((kind !== "question" && kind !== "orchestrator") || carriesPreparedChange(decision)) continue;
    if (decision.prediction === undefined) {
      unknowns.ownerAnswersBeforeReversals += 1;
      continue;
    }
    addReversals(owner, kinds);
    addReversals(owner.byClass[decisionClass], kinds);
  }

  for (const counts of [overrides, ...Object.values(overrides.byClass)]) counts.rate = ratio(counts.overridden, counts.delegated);
  for (const counts of [delegated, ...Object.values(delegated.byClass), owner, ...Object.values(owner.byClass)]) {
    counts.rate = ratio(counts.reversed, counts.decisions);
  }
  return { a4: overrides, a5: { delegated, owner } };
}
