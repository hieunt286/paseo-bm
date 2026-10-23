/**
 * The projects a mission chooses from (the approved mockup
 * `docs/design/mockups/mission-projects.html`, artboards L, M and N): one row
 * per Paseo project, named as Paseo's sidebar names it, with its folder
 * underneath — built from `paseo.workspaces.list`, not from the workspaces'
 * titles (often a chat's title, and one per workspace of the same repository).
 *
 * The value a project gives a mission is its root workspace: the workspace at
 * the project's own folder that is no worktree. A project with none is still
 * listed, and the form opens one there (`workspaceIdsOf`) before it calls
 * `missions.create` or `mission.change`, which keep taking workspace ids.
 *
 * Left out: paseo-bm's homes and the missions' placements (`traces.workspaces`'
 * `homes` and `placements`), worktree-only projects, and a project whose root
 * is a plugin home (the Mission-List project, the earlier missions home, the
 * Orchestrator's home).
 *
 * Pure: no React, no React Native, no `server/` import.
 */

/** The slice of a `paseo.workspaces.list` entry this reads. */
export interface ListedWorkspaceEntry {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectRootPath: string;
  workspaceDirectory?: string;
  workspaceKind: string;
  activityAt?: string | null;
  archivingAt?: string | null;
}

/** A listed project, as New mission and "+ Add" show it. */
export interface MissionProject {
  /** What the form keeps: the root workspace's id, else `project:<projectId>` until one is opened. */
  id: string;
  /** Paseo's project id. */
  projectId: string;
  /** The project's name: its custom name in Paseo, else its folder name. */
  name: string;
  /** Its folder, shortened (`shortPath`). */
  path: string;
  /** Its folder in full, where a workspace is opened when it has none. */
  rootPath: string;
  /** Its root workspace; null when no workspace is open at its folder. */
  workspaceId: string | null;
}

/** The plugin's own homes, by folder — a mission's own folder in Mission-List too: no project rooted there is listed (missions design §3.1). */
const PLUGIN_HOME_ROOT = /\/(missions\/Mission-List(\/[^/]+)?|missions\/home|orchestrator\/home)\/?$/;
/** A home folder `~` stands for: `/Users/<name>` (not the shared folder), `/home/<name>`, `/root`. */
const HOME_FOLDER = /^(\/Users\/(?!Shared(\/|$))[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/;
/** A folder of more segments than this is shortened; it keeps at most `PATH_TAIL_MAX` of them, and always hides one. */
const PATH_TAIL_MIN = 3;
const PATH_TAIL_MAX = 4;
/** "Find a project…" shows when more projects than this are listed. */
export const PROJECT_FILTER_FROM = 6;
/** A phone shows this many rows, then "+ N more · type to find it". */
export const PROJECT_ROWS_COMPACT = 4;

const ID_PREFIX = "project:";

/** A project's name as Paseo's sidebar shows it. */
export function projectNameOf(entry: Pick<ListedWorkspaceEntry, "projectCustomName" | "projectDisplayName">): string {
  const custom = entry.projectCustomName?.trim() ?? "";
  return custom !== "" ? custom : entry.projectDisplayName;
}

/** A folder for the row's second line: the home folder as `~`, the middle of a long path as `…`. */
export function shortPath(path: string): string {
  const home = HOME_FOLDER.exec(path);
  const prefix = home === null ? "" : "~";
  const rest = (home === null ? path : path.slice(home[0].length)).replace(/\/+$/, "");
  const parts = rest.split("/").filter((part) => part !== "");
  const lead = home === null ? (path.startsWith("/") ? "" : parts.shift() ?? "") : prefix;
  // The mockup's rows: `~/…/dx/backends/ai-assistant` (three kept), `~/…/dx/frontend/xspace/xspace-ai-assistant` (four).
  if (parts.length <= PATH_TAIL_MIN) return parts.length === 0 ? lead || "/" : `${lead}/${parts.join("/")}`;
  return `${lead}/…/${parts.slice(-Math.min(PATH_TAIL_MAX, parts.length - 1)).join("/")}`;
}

function directoryOf(entry: ListedWorkspaceEntry): string {
  // A non-worktree workspace with no folder of its own is the project's root (as `listedWorkspaces` reads it).
  return entry.workspaceDirectory ?? (entry.workspaceKind === "worktree" ? "" : entry.projectRootPath);
}

function sameFolder(a: string, b: string): boolean {
  return a !== "" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

function activityOf(entry: ListedWorkspaceEntry): number {
  const at = entry.activityAt === null || entry.activityAt === undefined ? Number.NaN : Date.parse(entry.activityAt);
  return Number.isNaN(at) ? 0 : at;
}

/**
 * One row per project, most recent activity first; undefined while the list
 * (or the stored homes, unless their read settled) has not answered.
 * `missionRepos` are the workspaces missions already work in: among several
 * root workspaces, the one a mission uses is chosen, else the most recent.
 */
export function missionProjectsOf(
  entries: readonly ListedWorkspaceEntry[] | undefined,
  stored: { homes?: readonly string[]; placements?: Readonly<Record<string, string>> } | undefined,
  settled: boolean,
  missionRepos: ReadonlySet<string> = new Set(),
): MissionProject[] | undefined {
  if (entries === undefined || (stored === undefined && !settled)) return undefined;
  const homes = new Set(stored?.homes ?? []);
  const placements = stored?.placements ?? {};
  const live = entries.filter((entry) => !entry.archivingAt && entry.id !== "");
  // A project rooted at a home's folder is the home's own project: none of its workspaces is listed.
  const homeRoots = live.filter((entry) => homes.has(entry.id)).flatMap((entry) => [entry.projectRootPath, directoryOf(entry)]);
  const groups = new Map<string, ListedWorkspaceEntry[]>();
  for (const entry of live) {
    if (homes.has(entry.id) || placements[entry.id] !== undefined) continue;
    const group = groups.get(entry.projectId);
    if (group === undefined) groups.set(entry.projectId, [entry]);
    else group.push(entry);
  }
  const rows: Array<{ project: MissionProject; activity: number; order: number }> = [];
  for (const [projectId, group] of groups) {
    const first = group[0]!;
    const rootPath = first.projectRootPath;
    if (PLUGIN_HOME_ROOT.test(rootPath) || homeRoots.some((root) => sameFolder(root, rootPath))) continue;
    if (group.every((entry) => entry.workspaceKind === "worktree")) continue;
    const roots = group
      .filter((entry) => entry.workspaceKind !== "worktree" && sameFolder(directoryOf(entry), rootPath))
      .sort((a, b) => Number(missionRepos.has(b.id)) - Number(missionRepos.has(a.id)) || activityOf(b) - activityOf(a));
    const root = roots[0] ?? null;
    rows.push({
      project: { id: root?.id ?? `${ID_PREFIX}${projectId}`, projectId, name: projectNameOf(first), path: shortPath(rootPath), rootPath, workspaceId: root?.id ?? null },
      activity: Math.max(...group.map(activityOf)),
      order: rows.length,
    });
  }
  return rows.sort((a, b) => b.activity - a.activity || a.order - b.order).map((row) => row.project);
}

/** Every listed workspace's project and its name, by workspace id (a placement's too: it is its repository's checkout). */
export type ProjectIndex = ReadonlyMap<string, { projectId: string; name: string }>;

export function projectIndexOf(entries: readonly ListedWorkspaceEntry[] | undefined): ProjectIndex {
  return new Map((entries ?? []).map((entry) => [entry.id, { projectId: entry.projectId, name: projectNameOf(entry) }]));
}

/** The projects whose name or folder holds `query`, case-insensitively; all of them when it is blank. */
export function projectsMatching(projects: readonly MissionProject[], query: string): MissionProject[] {
  const words = query.trim().toLowerCase();
  if (words === "") return [...projects];
  return projects.filter((project) => project.name.toLowerCase().includes(words) || project.rootPath.toLowerCase().includes(words));
}

/** What the list shows: its header, "N chosen", the filter, the rows and what is left out. */
export interface ProjectPickerView {
  header: string;
  chosen: string;
  filterShown: boolean;
  rows: Array<{ id: string; name: string; path: string; checked: boolean }>;
  /** "+ N more · type to find it" on a phone; null when every row shows. */
  more: string | null;
  /** The line shown in place of the rows; null when there are rows. */
  empty: string | null;
}

export const PROJECTS_FOOTNOTE =
  "Named as in Paseo's sidebar; rename a project in Paseo to change its name here. The mission works in each project's own branch and worktree.";

/** The project list of New mission (artboards L and M) and of "+ Add" (N). */
export function projectPickerOf(input: { projects: readonly MissionProject[]; chosen: readonly string[]; filter: string; compact: boolean; empty: string }): ProjectPickerView {
  const { projects, chosen, filter, compact } = input;
  const matching = projectsMatching(projects, filter);
  const shown = compact ? matching.slice(0, PROJECT_ROWS_COMPACT) : matching;
  const hidden = matching.length - shown.length;
  return {
    header: compact ? "Projects" : "Projects · the repositories this mission works in",
    chosen: `${chosen.length} chosen`,
    // A phone that cuts the list shows the filter too: its "type to find it" needs somewhere to type.
    filterShown: projects.length > PROJECT_FILTER_FROM || (compact && projects.length > PROJECT_ROWS_COMPACT),
    rows: shown.map((project) => ({ id: project.id, name: project.name, path: project.path, checked: chosen.includes(project.id) })),
    more: hidden > 0 ? `+ ${hidden} more · type to find it` : null,
    empty: projects.length === 0 ? input.empty : matching.length === 0 ? "No project matches." : null,
  };
}

/** `id` added to or taken from `chosen`. */
export function toggled(chosen: readonly string[], id: string): string[] {
  return chosen.includes(id) ? chosen.filter((value) => value !== id) : [...chosen, id];
}

/**
 * The workspace ids of the chosen projects: a project with no workspace at
 * its folder gets one opened there first (`open`, `paseo.workspaces.open`).
 * An id no listed project has is passed on as it is.
 */
export async function workspaceIdsOf(chosen: readonly string[], projects: readonly MissionProject[], open: (cwd: string) => Promise<{ id: string }>): Promise<string[]> {
  const out: string[] = [];
  for (const id of chosen) {
    const project = projects.find((candidate) => candidate.id === id);
    if (project === undefined || project.workspaceId !== null) {
      out.push(project?.workspaceId ?? id);
      continue;
    }
    const opened = await open(project.rootPath);
    out.push(opened.id);
  }
  return out;
}
