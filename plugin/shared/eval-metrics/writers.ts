/**
 * `writers-observed` as a replay figure (autonomy design §F.1; evaluation
 * design §4, "Also reported"): two agents of one workspace that wrote one
 * file in overlapping turns, counted over the turns in scope with the very
 * detection the plugin raises its Inbox alert with
 * (`shared/writers-observed.ts`). The per-Worker worktrees candidate
 * (WP-603) is judged on it.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { TraceRecord } from "../contracts";
import { writersObservedOf } from "../writers-observed";
import type { EvalMetrics, WritersObservedFigures } from "./types";

/** Collisions, their files and the pairs not judged, over `records` and per workspace (in id order). Pure. */
export function writersObservedFiguresOf(
  records: readonly TraceRecord[],
  workspaceDirectories: Readonly<Record<string, string>> | undefined,
): EvalMetrics["supplementary"]["writersObserved"] {
  const observed = writersObservedOf(records, (workspaceId) => workspaceDirectories?.[workspaceId] ?? null);
  const perWorkspace = new Map<string, { pairs: number; files: Set<string>; unknownPairs: number }>();
  const tallyOf = (workspaceId: string) => {
    const known = perWorkspace.get(workspaceId);
    if (known !== undefined) return known;
    const fresh = { pairs: 0, files: new Set<string>(), unknownPairs: 0 };
    perWorkspace.set(workspaceId, fresh);
    return fresh;
  };
  for (const collision of observed.collisions) {
    const tally = tallyOf(collision.workspaceId);
    tally.pairs += 1;
    tally.files.add(collision.file);
  }
  for (const pair of observed.unknown) tallyOf(pair.workspaceId).unknownPairs += 1;

  const all: WritersObservedFigures = { pairs: 0, files: 0, unknownPairs: 0 };
  const byWorkspace: Record<string, WritersObservedFigures> = {};
  for (const workspaceId of [...perWorkspace.keys()].sort()) {
    const tally = perWorkspace.get(workspaceId)!;
    const figures = { pairs: tally.pairs, files: tally.files.size, unknownPairs: tally.unknownPairs };
    byWorkspace[workspaceId] = figures;
    all.pairs += figures.pairs;
    all.files += figures.files;
    all.unknownPairs += figures.unknownPairs;
  }
  return { ...all, byWorkspace };
}
