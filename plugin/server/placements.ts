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
 * placement every reader behaves as before. A repo alias (ADR-043) is a live
 * root read as the repo key whose root is archived: `repoKeyOf` follows it, and
 * it stays apart from the placements, as a root is none. Never throws.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { AutonomyPolicy } from "../shared/autonomy";
import { currentPolicy } from "./autonomy-store";
import { MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME, createMissionStore, type Mission, type Placement, type PlacementIndex } from "./mission-store";

/** The placements map of each data folder, kept while its index file is unchanged. */
const memo = new Map<string, { stamp: string | null; placements: PlacementIndex; aliases: Record<string, string> }>();

/** What tells the index file apart from its last read: a write replaces it (a new inode). */
function stampOf(home: string): string | null {
  try {
    const stat = lstatSync(join(home, MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME));
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** The index of `home`, memoised on its stamp; empty when unreadable. */
function indexIn(home: string): { placements: PlacementIndex; aliases: Record<string, string> } {
  const stamp = stampOf(home);
  const known = memo.get(home);
  if (known !== undefined && known.stamp === stamp) return known;
  let placements: PlacementIndex = {};
  let aliases: Record<string, string> = {};
  try {
    const store = createMissionStore(home);
    placements = store.placements();
    aliases = store.repoAliases();
  } catch {
    // An unreadable mission store: no placement, every workspace its own repo.
  }
  // A missing or stale index was rebuilt by the read: its new stamp is the one kept.
  const read = { stamp: stampOf(home), placements, aliases };
  memo.set(home, read);
  return read;
}

/** Every placement workspace of `home` with its mission and repo key; none when unreadable. Memoised on the index's stamp. */
export function placementIndexIn(home: string | null): PlacementIndex {
  return home === null ? {} : indexIn(home).placements;
}

/** Every repo alias of `home` (ADR-043): a live root → its repo key. */
export function repoAliasesIn(home: string | null): Record<string, string> {
  return home === null ? {} : indexIn(home).aliases;
}

/** The live workspace to address for `repo`, a repo key (ADR-043): the key while listed, else a live alias, else the key. */
export function liveRootOf(home: string | null, repo: string, listed: ReadonlyArray<{ id: string; archived: boolean }> | null): string {
  const live = (id: string) => listed?.some((entry) => entry.id === id && !entry.archived) === true;
  if (live(repo)) return repo;
  return Object.entries(repoAliasesIn(home)).find(([id, key]) => key === repo && live(id))?.[0] ?? repo;
}

/** The repo key of `workspaceId`: the repo of a placement, else the id itself. Synchronous. */
export function repoKeyOf(home: string | null, workspaceId: string): string {
  return placementIndexIn(home)[workspaceId]?.repo ?? repoAliasesIn(home)[workspaceId] ?? workspaceId;
}

/** `repoKeyOf` bound to one data folder, for the pure readers that take a key function. */
export function repoKeysIn(home: string | null): (workspaceId: string) => string {
  const placements = placementIndexIn(home);
  const aliases = repoAliasesIn(home);
  return (workspaceId) => placements[workspaceId]?.repo ?? aliases[workspaceId] ?? workspaceId;
}

/** The mission whose placement `workspaceId` is, and its repo; null for any other workspace. */
export function placementEntryOf(home: string | null, workspaceId: string): { missionId: string; repo: string } | null {
  return placementIndexIn(home)[workspaceId] ?? null;
}

/** A placement's lane (delivery line design §19.1): 1, the mission branch, unless recorded. Pure. */
export const laneOf = (placement: Pick<Placement, "lane">): number => placement.lane ?? 1;

/** The mission's placement of `repo` (a repo key) on the mission branch — lane 1, the newest recorded; null when it has none. Never throws. */
export function placementOf(home: string, missionId: string, repo: string): Placement | null {
  try {
    const mission = createMissionStore(home).get(missionId);
    return (mission?.placements ?? []).filter((placement) => placement.repo === repo && laneOf(placement) === 1).at(-1) ?? null;
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
  const key = repoKeyOf(home, workspaceId);
  return mission.charter.repos.some((repo) => repoKeyOf(home, repo) === key);
}

/** The charter's repos by key (ADR-047): a live id and its key are one repo. */
export const charterKeysOf = (home: string | null, mission: Pick<Mission, "charter">): string[] => [...new Set(mission.charter.repos.map((repo) => repoKeyOf(home, repo)))];

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
 * `policy` with each repo alias (ADR-043) reading exactly as its repo: what the
 * repo has, and nothing the alias's id held of its own, so a reopened workspace
 * is never allowed more than its repo. Pure.
 */
export function policyWithAliases(policy: AutonomyPolicy, aliases: Readonly<Record<string, string>>): AutonomyPolicy {
  const entries = Object.entries(aliases);
  if (entries.length === 0) return policy;
  const read = <T>(of: Record<string, T>): Record<string, T> => {
    const out = { ...of };
    for (const [alias, repo] of entries) {
      if (of[repo] === undefined) delete out[alias];
      else out[alias] = of[repo]!;
    }
    return out;
  };
  return { projects: read(policy.projects), challenger: read(policy.challenger), ...(policy.boundary === undefined ? {} : { boundary: read(policy.boundary) }) };
}

/**
 * The owner's policy as the enforcement readers apply it (§3.1): the stored
 * policy (`currentPolicy`) with each placement aliased to its repo. Settings
 * keeps `currentPolicy`, so a placement never shows as a project. Never throws.
 */
export function effectivePolicy(home: string, onUnreadable?: (reason: string) => void): AutonomyPolicy {
  const policy = currentPolicy(home, onUnreadable);
  const placements = placementIndexIn(home);
  const placed = Object.keys(placements).length === 0 ? policy : policyWithPlacements(policy, placements);
  return policyWithAliases(placed, repoAliasesIn(home));
}
