/**
 * The facts the authority resolver reads (mission runtime design §4.1,
 * `shared/authority.ts`), from the data folder: the owner's policy (repo
 * cells, a placement read as its repo: delivery line design §3.1), the rosters' request index and the mission levels. The review caps
 * of §4.3 are retired (delivery line design §5.6). Read once per call to
 * `authorityFactsOf`; the functions it returns read their stores when called.
 * Never throws: an unreadable store reads as the safe side (no delegation).
 */
import { modeOf } from "../shared/autonomy";
import type { AuthorityFacts } from "../shared/authority";
import { effectivePolicy } from "./placements";
import { createMissionAutonomyStore } from "./mission-autonomy-store";
import { requestIndexOf } from "./mission-roster";

/** The resolver's facts for the data folder `home`. Never throws. */
export function authorityFactsOf(home: string, log: (message: string) => void = () => {}): AuthorityFacts {
  // Delivery line design §3.1: a placement's decision is decided by its repo's cells.
  const policy = effectivePolicy(home, (reason) => log(`[paseo-bm] could not read the autonomy policy for the authority resolver: ${reason}`));
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
  };
}
