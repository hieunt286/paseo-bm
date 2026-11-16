/**
 * A repository outlives its root workspace (ADR-043). The repo key is the id of
 * the repo's root workspace, and the owner's policy, the project memory, the
 * decisions and the placements stay keyed by it. Archiving that workspace and
 * opening the folder again gives a new id: this finds that id, proves it is the
 * same repository, and stores an alias (`Mission.repoAliases`), so `repoKeyOf`
 * reads the new id as the old key. Nothing stored under the key is rewritten.
 *
 * The proof, both parts: a live root workspace (not a worktree) at exactly the
 * folder and in exactly the Paseo project a placement of the repo recorded when
 * it was created (`requestBody`), and one of the mission's own branches of the
 * repo in that folder's git. A placement with no such record proves nothing.
 * Two folders with the proof are ambiguous and neither is taken.
 */
import { createMissionStore, journalQuietly, type Mission, type Placement } from "./mission-store";
import type { ListedWorkspace } from "./paseo-directory";
import { hasRef, type PlacementDeps } from "./placement-create";
import { repoKeyOf } from "./placements";
import { runGit, type GitRunner } from "./repo-tool";
import { errorText } from "./rpc-kit";

const isGone = (listed: readonly ListedWorkspace[], id: string): boolean => {
  const entry = listed.find((candidate) => candidate.id === id);
  return entry === undefined || entry.archived;
};

/** The charter repos whose root is gone and that hold a placement of the mission. Pure. */
export function staleReposOf(mission: Pick<Mission, "charter" | "placements">, listed: readonly ListedWorkspace[]): string[] {
  return mission.charter.repos.filter((repo) => isGone(listed, repo) && (mission.placements ?? []).some((placement) => placement.repo === repo));
}

/** Where a placement was made from, as its creation recorded: the root's folder and project; null with no such record. Pure. */
export function recordedOriginOf(placement: Pick<Placement, "requestBody">): { directory: string; projectId: string } | null {
  try {
    const source = (JSON.parse(placement.requestBody ?? "null") as { source?: { cwd?: unknown; projectId?: unknown } } | null)?.source;
    return typeof source?.cwd === "string" && typeof source.projectId === "string" ? { directory: source.cwd, projectId: source.projectId } : null;
  } catch {
    return null;
  }
}

/** The live root workspaces proved to be `repo`, one folder's; none when nothing proves it or two folders do. */
async function provenRootsOf(mission: Mission, repo: string, listed: readonly ListedWorkspace[], git: GitRunner, log: (message: string) => void): Promise<ListedWorkspace[]> {
  const placements = (mission.placements ?? []).filter((placement) => placement.repo === repo);
  const origins = placements.flatMap((placement) => recordedOriginOf(placement) ?? []);
  const roots = listed.filter(
    (entry) =>
      !entry.archived &&
      entry.kind !== "worktree" &&
      entry.kind !== "directory" &&
      origins.some((origin) => origin.directory === entry.directory && origin.projectId === entry.projectId),
  );
  const branches = [...new Set(placements.map((placement) => placement.branch))];
  const proved = new Map<string, ListedWorkspace[]>();
  for (const root of roots) {
    const directory = root.directory!;
    if (!proved.has(directory)) {
      let holds = false;
      for (const branch of branches) if (!holds) holds = await hasRef(git, directory, `refs/heads/${branch}`);
      if (!holds) continue;
      proved.set(directory, []);
    }
    proved.get(directory)!.push(root);
  }
  if (proved.size > 1) log(`[paseo-bm] mission ${mission.code}: ${[...proved.keys()].join(" and ")} both hold its branches of ${repo}: neither is taken.`);
  return proved.size === 1 ? [...proved.values()][0]! : [];
}

/**
 * `listed` as `mission` reads it: each stale charter repo answers with its live
 * root, under its own key, and the aliases proved now are stored. Never throws:
 * what cannot be read or stored leaves the repo as listed, with one log line.
 */
export async function withLiveRoots(home: string, mission: Mission, listed: readonly ListedWorkspace[], deps: Pick<PlacementDeps, "log" | "git" | "now">): Promise<ListedWorkspace[]> {
  const git = deps.git ?? runGit;
  let shown = [...listed];
  try {
    const found: Record<string, string> = {};
    for (const repo of staleReposOf(mission, listed)) {
      const roots = await provenRootsOf(mission, repo, listed, git, deps.log);
      if (roots.length === 0) continue;
      for (const root of roots) found[root.id] = repo;
      shown = [...shown.filter((entry) => entry.id !== repo), { ...roots[0]!, id: repo, archived: false }];
    }
    // A charter repo another mission proved to be an older key: this mission's charter names that key too.
    const keys: string[] = [];
    for (const repo of mission.charter.repos) {
      const key = repoKeyOf(home, repo);
      const live = listed.find((entry) => entry.id === repo && !entry.archived);
      if (key === repo || live === undefined) continue;
      keys.push(key);
      if (isGone(shown, key)) shown = [...shown.filter((entry) => entry.id !== key), { ...live, id: key }];
    }
    const missing = keys.filter((key) => !mission.charter.repos.includes(key));
    const fresh = Object.entries(found).filter(([id, repo]) => mission.repoAliases?.[id] !== repo);
    if (fresh.length === 0 && missing.length === 0) return shown;
    const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
    const stored = store.update(mission.missionId, (current) => ({
      ...current,
      charter: { ...current.charter, repos: [...new Set([...current.charter.repos, ...missing])] },
      ...(fresh.length === 0 ? {} : { repoAliases: { ...current.repoAliases, ...found } }),
    }));
    if (!stored.ok) {
      deps.log(`[paseo-bm] could not store ${mission.code}'s repos: ${stored.reasons.join("; ")}`);
      return [...listed];
    }
    mission.charter = stored.mission.charter;
    if (fresh.length === 0) return shown;
    const text = `The archived workspace of ${[...new Set(fresh.map(([, repo]) => repo))].join(", ")} now answers as ${fresh.map(([id]) => id).join(", ")}: the same folder, project and mission branch.`;
    journalQuietly(store, mission.missionId, { kind: "note", by: "plugin", text }, deps.log);
    return shown;
  } catch (error) {
    deps.log(`[paseo-bm] could not match mission ${mission.code}'s repos: ${errorText(error)}`);
    return [...listed];
  }
}
