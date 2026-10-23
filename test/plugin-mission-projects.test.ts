import { describe, expect, it, vi } from "vitest";
import {
  PROJECTS_FOOTNOTE,
  missionProjectsOf,
  projectIndexOf,
  projectNameOf,
  projectPickerOf,
  projectsMatching,
  shortPath,
  toggled,
  workspaceIdsOf,
  type ListedWorkspaceEntry,
  type MissionProject,
} from "../plugin/client/mission-projects";
import { listedWorkspaces, titleIn, type DashboardPaseo } from "../plugin/server/paseo-directory";
import { workspaceLabelOf } from "../plugin/server/orchestrator-state";

/**
 * The projects a mission chooses from (mockup `mission-projects.html`,
 * artboards L, M and N): one row per Paseo project, built from
 * `paseo.workspaces.list` entries — grouping, the root workspace, what is
 * left out, the name Paseo's sidebar shows, the shortened folder, the filter.
 */

const HOME = "/Users/me";
let clock = 0;
/** A listed workspace; `at` is minutes after a fixed start (bigger is more recent). */
const entry = (over: Partial<ListedWorkspaceEntry> & Pick<ListedWorkspaceEntry, "id" | "projectId" | "projectRootPath">): ListedWorkspaceEntry => ({
  projectDisplayName: over.projectRootPath.split("/").pop()!,
  workspaceKind: "local_checkout",
  workspaceDirectory: over.projectRootPath,
  activityAt: new Date(Date.UTC(2026, 9, 21, 8, (clock += 1))).toISOString(),
  ...over,
});
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 21, 9, minutes)).toISOString();

const BM_ROOT = `${HOME}/work/self/paseo-plugins/paseo-bm`;
const UI_ROOT = `${HOME}/work/dx/frontend/xspace/xspace-ai-assistant`;
const SITE_ROOT = `${HOME}/work/self/paseo-plugins/paseo-bm-site`;
const DATA = `${HOME}/.paseo-bm`;

describe("missionProjectsOf: one row per Paseo project", () => {
  it("groups a project's workspaces into one row named as Paseo's sidebar names it, its root workspace the value", () => {
    const listed = [
      // Two workspaces of paseo-bm at its root, one titled from a chat, and a worktree of it.
      entry({ id: "ws-bm-chat", projectId: "p-bm", projectRootPath: BM_ROOT, activityAt: at(30) }),
      entry({ id: "ws-bm-old", projectId: "p-bm", projectRootPath: BM_ROOT, activityAt: at(10) }),
      entry({ id: "ws-bm-wt", projectId: "p-bm", projectRootPath: BM_ROOT, workspaceKind: "worktree", workspaceDirectory: `${HOME}/.paseo/worktrees/bm-feature`, activityAt: at(50) }),
      entry({ id: "ws-ui", projectId: "p-ui", projectRootPath: UI_ROOT, projectCustomName: "AI Assistant UI", activityAt: at(40) }),
    ];
    const rows = missionProjectsOf(listed, { homes: [] }, false)!;
    expect(rows).toEqual([
      // paseo-bm's last activity is its worktree's (09:50): it sorts first.
      { id: "ws-bm-chat", projectId: "p-bm", name: "paseo-bm", path: "~/…/self/paseo-plugins/paseo-bm", rootPath: BM_ROOT, workspaceId: "ws-bm-chat" },
      { id: "ws-ui", projectId: "p-ui", name: "AI Assistant UI", path: "~/…/dx/frontend/xspace/xspace-ai-assistant", rootPath: UI_ROOT, workspaceId: "ws-ui" },
    ]);
  });

  it("prefers the root workspace a mission already uses, else the most recently active", () => {
    const listed = [
      entry({ id: "ws-new", projectId: "p-bm", projectRootPath: BM_ROOT, activityAt: at(30) }),
      entry({ id: "ws-used", projectId: "p-bm", projectRootPath: BM_ROOT, activityAt: at(10) }),
      // A workspace in a subfolder is no root.
      entry({ id: "ws-sub", projectId: "p-bm", projectRootPath: BM_ROOT, workspaceKind: "directory", workspaceDirectory: `${BM_ROOT}/docs`, activityAt: at(59) }),
    ];
    expect(missionProjectsOf(listed, { homes: [] }, false)![0]!.id).toBe("ws-new");
    expect(missionProjectsOf(listed, { homes: [] }, false, new Set(["ws-used"]))![0]!.id).toBe("ws-used");
    // A root workspace with no folder of its own (no `workspaceDirectory`) is at the project's root.
    const bare = { ...entry({ id: "ws-bare", projectId: "p-x", projectRootPath: SITE_ROOT }), workspaceDirectory: undefined };
    expect(missionProjectsOf([bare], {}, false)![0]!.workspaceId).toBe("ws-bare");
  });

  it("still lists a project with no workspace at its folder, by a project: id until one is opened", () => {
    const listed = [entry({ id: "ws-docs", projectId: "p-site", projectRootPath: SITE_ROOT, workspaceKind: "directory", workspaceDirectory: `${SITE_ROOT}/docs` })];
    expect(missionProjectsOf(listed, { homes: [] }, false)).toEqual([
      { id: "project:p-site", projectId: "p-site", name: "paseo-bm-site", path: "~/…/self/paseo-plugins/paseo-bm-site", rootPath: SITE_ROOT, workspaceId: null },
    ]);
  });

  it("leaves out paseo-bm's homes, the missions' placements, worktree-only projects and projects rooted at a plugin home", () => {
    const listed = [
      entry({ id: "ws-bm", projectId: "p-bm", projectRootPath: BM_ROOT }),
      // A mission's placement: a worktree of paseo-bm, and a project that only holds one.
      entry({ id: "ws-place", projectId: "p-bm", projectRootPath: BM_ROOT, workspaceKind: "worktree", workspaceDirectory: `${DATA}/placements/AIX-bm` }),
      entry({ id: "ws-place-own", projectId: "p-place", projectRootPath: `${DATA}/placements/AIX-ui`, workspaceKind: "worktree" }),
      // A project of worktrees only.
      entry({ id: "ws-wt", projectId: "p-wt", projectRootPath: `${HOME}/work/other`, workspaceKind: "worktree", workspaceDirectory: `${HOME}/.paseo/worktrees/other-1` }),
      // The Mission-List project: its root (a home) and a mission's own workspace in it, not a home by id here.
      entry({ id: "ws-mission-list", projectId: "p-ml", projectRootPath: `${DATA}/missions/Mission-List` }),
      entry({ id: "ws-mission-aix", projectId: "p-ml", projectRootPath: `${DATA}/missions/Mission-List`, workspaceKind: "directory", workspaceDirectory: `${DATA}/missions/Mission-List/mis-1` }),
      // The earlier shared home and the Orchestrator's home, known by their folders alone.
      entry({ id: "ws-old-home", projectId: "p-old", projectRootPath: `${DATA}/missions/home` }),
      entry({ id: "ws-orch", projectId: "p-orch", projectRootPath: `${DATA}/orchestrator/home` }),
      // A home whose project root is elsewhere: every workspace of a project rooted at the home's folder goes too.
      entry({ id: "ws-home-custom", projectId: "p-home", projectRootPath: `${HOME}/bm-home` }),
      entry({ id: "ws-home-other", projectId: "p-home", projectRootPath: `${HOME}/bm-home`, workspaceKind: "directory", workspaceDirectory: `${HOME}/bm-home/sub` }),
      // An archived workspace is gone.
      entry({ id: "ws-archived", projectId: "p-arch", projectRootPath: `${HOME}/work/archived`, archivingAt: at(1) }),
    ];
    const stored = { homes: ["ws-mission-list", "ws-home-custom"], placements: { "ws-place": "ws-bm", "ws-place-own": "ws-ui" } };
    expect(missionProjectsOf(listed, stored, false)!.map((row) => row.projectId)).toEqual(["p-bm"]);
  });

  it("waits for the list, and for the stored homes unless their read settled", () => {
    const listed = [entry({ id: "ws-bm", projectId: "p-bm", projectRootPath: BM_ROOT })];
    expect(missionProjectsOf(undefined, { homes: [] }, false)).toBeUndefined();
    expect(missionProjectsOf(listed, undefined, false)).toBeUndefined();
    expect(missionProjectsOf(listed, undefined, true)!.map((row) => row.id)).toEqual(["ws-bm"]);
  });

  it("names a project by its custom name, else its folder name, and indexes every workspace by its project", () => {
    expect(projectNameOf({ projectDisplayName: "paseo-bm", projectCustomName: null })).toBe("paseo-bm");
    expect(projectNameOf({ projectDisplayName: "paseo-bm", projectCustomName: "  " })).toBe("paseo-bm");
    expect(projectNameOf({ projectDisplayName: "paseo-bm", projectCustomName: "Beads Manager" })).toBe("Beads Manager");
    const index = projectIndexOf([
      entry({ id: "ws-bm", projectId: "p-bm", projectRootPath: BM_ROOT }),
      entry({ id: "ws-place", projectId: "p-bm", projectRootPath: BM_ROOT, workspaceKind: "worktree", workspaceDirectory: `${DATA}/placements/x` }),
      entry({ id: "ws-ui", projectId: "p-ui", projectRootPath: UI_ROOT, projectCustomName: "AI Assistant UI" }),
    ]);
    expect(index.get("ws-place")).toEqual({ projectId: "p-bm", name: "paseo-bm" });
    expect(index.get("ws-ui")).toEqual({ projectId: "p-ui", name: "AI Assistant UI" });
    expect(projectIndexOf(undefined).size).toBe(0);
  });
});

describe("shortPath: the folder line", () => {
  it("shows the home folder as ~ and the middle of a long path as …, keeping three or four segments as the mockup's rows", () => {
    expect(shortPath(`${HOME}/work/dx/frontend/xspace/xspace-ai-assistant`)).toBe("~/…/dx/frontend/xspace/xspace-ai-assistant");
    expect(shortPath(`${HOME}/work/dx/backends/ai-assistant`)).toBe("~/…/dx/backends/ai-assistant");
    expect(shortPath(`${HOME}/work/self/paseo-plugins/paseo-bm`)).toBe("~/…/self/paseo-plugins/paseo-bm");
    expect(shortPath(`${HOME}/a/b/work/self/paseo-plugins/paseo-bm`)).toBe("~/…/work/self/paseo-plugins/paseo-bm");
    expect(shortPath(`${HOME}/code/app/web`)).toBe("~/code/app/web");
    expect(shortPath(HOME)).toBe("~");
    expect(shortPath("/home/me/src/app/")).toBe("~/src/app");
    expect(shortPath("/root/app")).toBe("~/app");
    // macOS's shared folder is nobody's home.
    expect(shortPath("/Users/Shared/work/self/paseo-plugins/paseo-bm")).toBe("/…/work/self/paseo-plugins/paseo-bm");
    expect(shortPath("/opt/app")).toBe("/opt/app");
    expect(shortPath("/")).toBe("/");
  });
});

describe("the picker of New mission and + Add", () => {
  const p = (name: string, rootPath: string, id = `ws-${name}`): MissionProject => ({ id, projectId: `p-${name}`, name, path: shortPath(rootPath), rootPath, workspaceId: id.startsWith("project:") ? null : id });
  const SIX = ["xspace-ai-assistant", "ai-assistant", "xspace-shell", "paseo-bm", "paseo-bm-site", "oracle"].map((name) => p(name, `${HOME}/work/${name}`));

  it("filters by name and by folder, case-insensitively", () => {
    const projects = [p("paseo-bm", BM_ROOT), p("AI Assistant UI", UI_ROOT)];
    expect(projectsMatching(projects, "  ").map((row) => row.name)).toEqual(["paseo-bm", "AI Assistant UI"]);
    expect(projectsMatching(projects, "assistant").map((row) => row.name)).toEqual(["AI Assistant UI"]);
    expect(projectsMatching(projects, "FRONTEND").map((row) => row.name)).toEqual(["AI Assistant UI"]);
    expect(projectsMatching(projects, "paseo-plugins").map((row) => row.name)).toEqual(["paseo-bm"]);
  });

  it("shows the desktop header, N chosen, every row and the filter only above six projects", () => {
    const view = projectPickerOf({ projects: SIX, chosen: ["ws-ai-assistant"], filter: "", compact: false, empty: "No project is listed yet." });
    expect(view.header).toBe("Projects · the repositories this mission works in");
    expect(view.chosen).toBe("1 chosen");
    expect(view.filterShown).toBe(false);
    expect(view.rows.map((row) => [row.name, row.checked])).toEqual(SIX.map((row) => [row.name, row.name === "ai-assistant"]));
    expect(view.more).toBeNull();
    expect(view.empty).toBeNull();
    expect(projectPickerOf({ projects: [...SIX, p("xone", `${HOME}/work/xone`)], chosen: [], filter: "", compact: false, empty: "" }).filterShown).toBe(true);
    expect(projectPickerOf({ projects: [], chosen: [], filter: "", compact: false, empty: "No project is listed yet." }).empty).toBe("No project is listed yet.");
    expect(projectPickerOf({ projects: SIX, chosen: [], filter: "zzz", compact: false, empty: "" }).empty).toBe("No project matches.");
    expect(PROJECTS_FOOTNOTE).toBe("Named as in Paseo's sidebar; rename a project in Paseo to change its name here. The mission works in each project's own branch and worktree.");
  });

  it("shows a phone the first four rows, then + N more · type to find it, with the filter to type in", () => {
    const view = projectPickerOf({ projects: SIX.slice(0, 5), chosen: [], filter: "", compact: true, empty: "" });
    expect(view.header).toBe("Projects");
    expect(view.rows).toHaveLength(4);
    expect(view.more).toBe("+ 1 more · type to find it");
    expect(view.filterShown).toBe(true);
    const four = projectPickerOf({ projects: SIX.slice(0, 4), chosen: [], filter: "", compact: true, empty: "" });
    expect([four.more, four.filterShown]).toEqual([null, false]);
    // Typing finds it.
    expect(projectPickerOf({ projects: SIX, chosen: [], filter: "oracle", compact: true, empty: "" }).rows.map((row) => row.name)).toEqual(["oracle"]);
  });

  it("toggles a choice", () => {
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });

  it("opens a workspace at the folder of a chosen project that has none, and keeps the other ids", async () => {
    const projects = [p("paseo-bm", BM_ROOT), p("paseo-bm-site", SITE_ROOT, "project:p-paseo-bm-site")];
    const open = vi.fn(async (cwd: string) => ({ id: `opened:${cwd.split("/").pop()}` }));
    expect(await workspaceIdsOf(["ws-paseo-bm", "project:p-paseo-bm-site", "ws-unknown"], projects, open)).toEqual(["ws-paseo-bm", "opened:paseo-bm-site", "ws-unknown"]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(SITE_ROOT);
  });
});

describe("the server names a repository by its project, as Paseo's sidebar does", () => {
  const paseo = (entries: Array<Record<string, unknown>>): DashboardPaseo => ({ agents: { list: async () => ({ entries: [] }) }, workspaces: { list: async () => ({ entries }) } });

  it("reads the project name, prefers it in titleIn and workspaceLabelOf, and falls back to the folder name", async () => {
    const listed = (await listedWorkspaces(
      paseo([
        { id: "ws-ui", projectId: "p-ui", projectRootPath: UI_ROOT, workspaceDirectory: UI_ROOT, workspaceKind: "local_checkout", projectDisplayName: "xspace-ai-assistant", projectCustomName: "AI Assistant UI", title: "Greet user and await task" },
        { id: "ws-bm", projectId: "p-bm", projectRootPath: BM_ROOT, workspaceKind: "local_checkout", projectDisplayName: "paseo-bm", projectCustomName: null },
        { id: "ws-old", directory: SITE_ROOT },
      ]),
    ))!;
    expect(listed.map((entry) => entry.projectName)).toEqual(["AI Assistant UI", "paseo-bm", undefined]);
    expect(titleIn(listed, "ws-ui")).toBe("AI Assistant UI");
    expect(titleIn(listed, "ws-bm")).toBe("paseo-bm");
    expect(titleIn(listed, "ws-old")).toBe("paseo-bm-site");
    expect(titleIn(listed, "ws-gone")).toBe("ws-gone");
    expect(workspaceLabelOf("ws-ui", listed, null)).toBe("AI Assistant UI");
    expect(workspaceLabelOf("ws-old", listed, null)).toBe("paseo-bm-site");
  });
});
