/**
 * The repo key and the placement (delivery line design §3.1, ADR-035
 * decision 2): the one resolver every owner-level reader passes a workspace
 * id through.
 *
 * - A **placement** is the workspace a request's agents run in; for a
 *   mission, its worktree of a repo (`Mission.placements`, §3.2).
 *   Request-level stores (bindings, the registry, the roster, the outbox,
 *   traces, `writers-watch`, decisions, `h:` grants) stay keyed by it.
 * - The **repo key** is the repo's root workspace. Owner-level settings
 *   follow it: policy cells, levels and the action boundary, precedents,
 *   project memory, charter membership, contracts and peer links.
 *
 * Fed by the `placements` map of `missions/index.json`, rebuilt with the
 * index. A workspace that is no placement is its own repo key, so with no
 * placement every reader behaves as before. Never throws.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { AutonomyPolicy } from "../shared/autonomy";
import { currentPolicy } from "./autonomy-store";
import { MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME, createMissionStore, type Mission, type Placement, type PlacementIndex } from "./mission-store";

/** The placements map of each data folder, kept while its index file is unchanged. */
const memo = new Map<string, { stamp: string | null; placements: PlacementIndex }>();

/** What tells the index file apart from its last read: a write replaces it (a new inode). */
function stampOf(home: string): string | null {
  try {
    const stat = lstatSync(join(home, MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME));
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Every placement workspace of `home` with its mission and repo key; none when unreadable. Memoised on the index's stamp. */
export function placementIndexIn(home: string | null): PlacementIndex {
  if (home === null) return {};
  const stamp = stampOf(home);
  const known = memo.get(home);
  if (known !== undefined && known.stamp === stamp) return known.placements;
  let placements: PlacementIndex = {};
  try {
    placements = createMissionStore(home).placements();
  } catch {
    // An unreadable mission store: no placement, every workspace its own repo.
  }
  // A missing or stale index was rebuilt by the read: its new stamp is the one kept.
  memo.set(home, { stamp: stampOf(home), placements });
  return placements;
}

/** The repo key of `workspaceId`: the repo of a placement, else the id itself. Synchronous. */
export function repoKeyOf(home: string | null, workspaceId: string): string {
  return placementIndexIn(home)[workspaceId]?.repo ?? workspaceId;
}

/** `repoKeyOf` bound to one data folder, for the pure readers that take a key function. */
export function repoKeysIn(home: string | null): (workspaceId: string) => string {
  const placements = placementIndexIn(home);
  return (workspaceId) => placements[workspaceId]?.repo ?? workspaceId;
}

/** The mission whose placement `workspaceId` is, and its repo; null for any other workspace. */
export function placementEntryOf(home: string | null, workspaceId: string): { missionId: string; repo: string } | null {
  return placementIndexIn(home)[workspaceId] ?? null;
}

/** The mission's placement of `repo` (a repo key), the newest recorded; null when it has none. Never throws. */
export function placementOf(home: string, missionId: string, repo: string): Placement | null {
  try {
    const mission = createMissionStore(home).get(missionId);
    return (mission?.placements ?? []).filter((placement) => placement.repo === repo).at(-1) ?? null;
  } catch {
    return null;
  }
}

/** The placement record whose workspace is `workspaceId`, or null for any other workspace. Never throws. */
export function placementOfWorkspace(home: string | null, workspaceId: string): Placement | null {
  const entry = placementEntryOf(home, workspaceId);
  if (home === null || entry === null) return null;
  try {
    return (createMissionStore(home).get(entry.missionId)?.placements ?? []).filter((placement) => placement.workspaceId === workspaceId).at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Why no new agent may start in `workspaceId` (delivery line design §3.6): it
 * is a mission's placement that is retired, archived or failed. Null for a
 * ready or creating placement and any other workspace. Never throws.
 */
export function placementBlockOf(home: string | null, workspaceId: string): string | null {
  const placement = placementOfWorkspace(home, workspaceId);
  if (placement === null) return null;
  const where = `the mission's worktree ${placement.directory ?? workspaceId} (branch ${placement.branch})`;
  switch (placement.state) {
    case "retired":
      return `${where} is retired: its repo left the mission or the mission closed, so no new agent starts in it`;
    case "archived":
      return `${where} was archived in Paseo, so no new agent starts in it; the branch keeps its commits, and the next bm_create_worker for this repo re-creates the worktree from it`;
    case "failed":
      return `${where} failed (${placement.note ?? "no reason recorded"}), so no new agent starts in it`;
    default:
      return null;
  }
}

/** Whether `workspaceId` (a repo, or a placement of one) is in the mission's charter. */
export function inCharter(home: string | null, mission: Pick<Mission, "charter">, workspaceId: string): boolean {
  return mission.charter.repos.includes(repoKeyOf(home, workspaceId));
}

/**
 * `policy` with each placement read as its repo: a read-only alias of the
 * repo's cells, challenger and boundary under the placement's id. Pure.
 */
export function policyWithPlacements(policy: AutonomyPolicy, placements: PlacementIndex): AutonomyPolicy {
  const projects = { ...policy.projects };
  const challenger = { ...policy.challenger };
  const boundary = policy.boundary === undefined ? undefined : { ...policy.boundary };
  for (const [placement, { repo }] of Object.entries(placements)) {
    if (policy.projects[repo] !== undefined) projects[placement] = policy.projects[repo];
    if (policy.challenger[repo] !== undefined) challenger[placement] = policy.challenger[repo];
    if (boundary !== undefined && policy.boundary![repo] !== undefined) boundary[placement] = policy.boundary![repo];
  }
  return { projects, challenger, ...(boundary === undefined ? {} : { boundary }) };
}

/**
 * The owner's policy as the enforcement readers apply it (§3.1): the stored
 * policy (`currentPolicy`) with each placement aliased to its repo. Settings
 * keeps `currentPolicy`, so a placement never shows as a project. Never throws.
 */
export function effectivePolicy(home: string, onUnreadable?: (reason: string) => void): AutonomyPolicy {
  const policy = currentPolicy(home, onUnreadable);
  const placements = placementIndexIn(home);
  return Object.keys(placements).length === 0 ? policy : policyWithPlacements(policy, placements);
}
