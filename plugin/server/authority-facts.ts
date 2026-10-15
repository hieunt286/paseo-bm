/**
 * The facts the authority resolver reads (mission runtime design §4.1,
 * `shared/authority.ts`), from the data folder: the owner's policy (repo
 * cells), the rosters' request index, the mission levels, and each request's
 * review caps (§4.3). Read once per call to `authorityFactsOf`; the functions
 * it returns read their stores when called. Never throws: an unreadable store
 * reads as the safe side (no delegation, no cap left).
 */
import { modeOf } from "../shared/autonomy";
import type { AuthorityFacts, ReviewCaps } from "../shared/authority";
import { policyGrantCapOf } from "../shared/decisions";
import { currentPolicy } from "./autonomy-store";
import { createDecisionStore } from "./decision-store";
import { createMissionAutonomyStore } from "./mission-autonomy-store";
import { requestIndexOf } from "./mission-roster";
import { createRequestRegistry } from "./request-registry";
import { readReviewBudget } from "./coordination-rpc";

/**
 * A request's review caps (design §4.3): what code (answers `by: policy`)
 * and the Main (`by: main`) may still grant — each the tier's policy cap
 * (`policyGrantCapOf`) less the calls of the grants that grantor gave; an
 * `untilClean` grant counts the calls it covered beyond the budget
 * (`untilCleanCalls`, the registry's covered calls), so it is bounded too.
 * Null without a request. Never throws: an unreadable store gives no cap left.
 */
export function reviewCapsOf(home: string, workspaceId: string, requestId: string | null, log: (message: string) => void = () => {}, exceptDecisionId?: string): ReviewCaps | null {
  if (requestId === null) return null;
  try {
    const request = createRequestRegistry(home, { log }).get(workspaceId, requestId);
    const cap = policyGrantCapOf(request?.tier ?? null, readReviewBudget({ home, log }));
    const grants = (request?.reviews.grants ?? []).filter((grant) => grant.decisionId !== exceptDecisionId);
    if (grants.length === 0) return { codeLeft: cap, mainLeft: cap };
    const store = createDecisionStore(home, { log });
    let code = 0;
    let main = 0;
    for (const grant of grants) {
      const by = store.get(grant.decisionId, workspaceId)?.answer?.by ?? "policy";
      const calls = grant.calls ?? untilCleanCalls(request, grant.untilCleanBatch);
      if (by === "policy") code += calls;
      else if (by === "main") main += calls;
    }
    return { codeLeft: Math.max(0, cap - code), mainLeft: Math.max(0, cap - main) };
  } catch {
    return { codeLeft: 0, mainLeft: 0 };
  }
}

/** The review calls of batch `batch` made after its first: what an `untilClean` grant of it has covered so far. */
function untilCleanCalls(request: { reviews: { batches: Array<{ batchId: string; calls: unknown[] }> } } | null | undefined, batch: string | null): number {
  if (batch === null || request === null || request === undefined) return 0;
  const found = request.reviews.batches.find((entry) => entry.batchId === batch);
  return found === undefined ? 0 : Math.max(0, found.calls.length - 1);
}

/** The resolver's facts for the data folder `home`. Never throws. */
export function authorityFactsOf(home: string, log: (message: string) => void = () => {}): AuthorityFacts {
  const policy = currentPolicy(home, (reason) => log(`[paseo-bm] could not read the autonomy policy for the authority resolver: ${reason}`));
  const levels = createMissionAutonomyStore(home);
  return {
    modeOf: (workspaceId, decisionClass) => modeOf(policy, workspaceId, decisionClass),
    missionOf: (requestId) => (requestId === null ? null : (requestIndexOf(home, requestId)?.missionId ?? null)),
    missionDelegates: (missionId, cell) => {
      try {
        return levels.isDelegated(missionId, cell);
      } catch {
        return false;
      }
    },
    reviewCaps: (workspaceId, requestId) => reviewCapsOf(home, workspaceId, requestId, log),
  };
}
