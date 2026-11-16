import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAutonomyStore, currentPolicy } from "../plugin/server/autonomy-store";
import { modeOf } from "../plugin/shared/autonomy";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME, createMissionStore, type Mission, type Placement } from "../plugin/server/mission-store";
import type { ListedWorkspace } from "../plugin/server/paseo-directory";
import { effectivePolicy, placementEntryOf, repoKeyOf } from "../plugin/server/placements";
import { missionRepoOf } from "../plugin/server/create-worker";
import { recordedOriginOf, staleReposOf, withLiveRoots } from "../plugin/server/repo-aliases";

/** ADR-043 on a real temporary Git repository: a live root is proved to be the archived repo, or it is not taken. */
const OLD = "wks_old_root";
const NEW = "wks_new_root";
const LANE = "wks_lane_2";
const PROJECT = "prj_backend";
const BRANCH = "m/AIX-dc7e/ai-assistant";

const repoAt = (folder: string, branches: readonly string[]): string => {
  mkdirSync(folder, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "a.txt"), "a\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "a");
  for (const branch of branches) git("branch", branch);
  return folder;
};

const placement = (directory: string, over: Partial<Placement> = {}, projectId = PROJECT): Placement => ({
  repo: OLD,
  workspaceId: LANE,
  directory: "/gone",
  branch: BRANCH,
  target: "dev",
  base: "origin/dev",
  worktreeSlug: "m-aix-dc7e-ai-assistant",
  state: "archived",
  requestKey: "bm-place-1",
  createdAt: "2026-10-29T00:00:00.000Z",
  deps: { cloned: [], at: null, note: null },
  integration: null,
  requestBody: JSON.stringify({ requestId: "bm-place-1", title: "AIX", source: { kind: "worktree", cwd: directory, projectId, action: "branch-off" } }),
  ...over,
});

const root = (id: string, directory: string, over: Partial<ListedWorkspace> = {}): ListedWorkspace => ({ id, archived: false, directory, projectId: PROJECT, kind: "local_checkout", ...over });
const laneEntry: ListedWorkspace = { id: LANE, archived: false, directory: "/lane", projectId: PROJECT, kind: "worktree" };

describe("withLiveRoots", () => {
  let folder: string;
  let home: string;
  let logs: string[];
  const deps = () => ({ log: (message: string) => void logs.push(message) });

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "bm-repo-aliases-"));
    home = join(folder, "data");
    logs = [];
  });
  afterEach(() => {
    clearJsonFileCache();
    rmSync(folder, { recursive: true, force: true });
  });

  function mission(placements: Placement[], repos: string[] = [OLD, NEW]): Mission {
    const store = createMissionStore(home);
    const made = store.create({ code: "AIX", name: "Enhance", goal: "Ship", repos, createdBy: "owner", mainId: "main-1" });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const stored = store.update(made.mission.missionId, (current) => ({ ...current, placements }));
    if (!stored.ok) throw new Error(stored.reasons.join("; "));
    return stored.mission;
  }
  const aliasesOf = (found: Mission) => createMissionStore(home).get(found.missionId)!.repoAliases;

  it("reads the live root under the archived key, stores the alias, and rewrites nothing else", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    const found = mission([placement(directory)]);
    const listed = await withLiveRoots(home, found, [root(NEW, directory), root("wks_same_folder", directory), laneEntry], deps());
    expect(listed.find((entry) => entry.id === OLD)).toMatchObject({ archived: false, directory, projectId: PROJECT });
    expect(aliasesOf(found)).toEqual({ [NEW]: OLD, wks_same_folder: OLD });
    const after = createMissionStore(home).get(found.missionId)!;
    expect(after.placements).toEqual(found.placements);
    expect(after.charter.repos).toEqual(found.charter.repos);
    expect(createMissionStore(home).journal(found.missionId).map((entry) => entry.text).join("\n")).toContain("the same folder, project and mission branch");
  });

  it("makes the new id read as the repo key, so the owner's policy follows, without calling it a placement", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    await withLiveRoots(home, mission([placement(directory)]), [root(NEW, directory), laneEntry], deps());
    expect(repoKeyOf(home, NEW)).toBe(OLD);
    expect(placementEntryOf(home, NEW)).toBeNull();
    expect(placementEntryOf(home, LANE)).toMatchObject({ repo: OLD });
    createAutonomyStore(home).set({ workspaceId: OLD, class: "dependency", mode: "delegate", confirmed: true }, "2026-10-08T06:00:00.000Z");
    expect(modeOf(effectivePolicy(home), NEW, "dependency")).toBe("delegate");
    expect(modeOf(currentPolicy(home), NEW, "dependency")).toBe("owner");
  });

  it("reads an alias exactly as its repo: a grant the new id held of its own never survives", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    createAutonomyStore(home).set({ workspaceId: NEW, class: "dependency", mode: "delegate", confirmed: true }, "2026-10-08T06:00:00.000Z");
    await withLiveRoots(home, mission([placement(directory)]), [root(NEW, directory), laneEntry], deps());
    expect(modeOf(effectivePolicy(home), OLD, "dependency")).toBe("owner");
    expect(modeOf(effectivePolicy(home), NEW, "dependency")).toBe("owner");
    expect(modeOf(currentPolicy(home), NEW, "dependency")).toBe("delegate");
  });

  it("keeps aliases out of the index's placements, the map an older reader trusts as placements", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    await withLiveRoots(home, mission([placement(directory)]), [root(NEW, directory), laneEntry], deps());
    const stored = JSON.parse(readFileSync(join(home, MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME), "utf8")) as Record<string, Record<string, unknown>>;
    expect(stored["placements"]![NEW]).toBeUndefined();
    expect(stored["placements"]![LANE]).toBeDefined();
    expect(stored["repoAliases"]).toEqual({ [NEW]: OLD });
  });

  it("rebuilds the aliases from the mission files when the index is lost", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    await withLiveRoots(home, mission([placement(directory)]), [root(NEW, directory), laneEntry], deps());
    rmSync(join(home, MISSIONS_DIR_NAME, MISSION_INDEX_FILE_NAME));
    clearJsonFileCache();
    expect(createMissionStore(home).repoAliases()).toEqual({ [NEW]: OLD });
  });

  it("stores nothing again on a later call", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    const found = mission([placement(directory)]);
    await withLiveRoots(home, found, [root(NEW, directory), laneEntry], deps());
    const again = createMissionStore(home).get(found.missionId)!;
    const lines = createMissionStore(home).journal(found.missionId).length;
    await withLiveRoots(home, again, [root(NEW, directory), laneEntry], deps());
    expect(createMissionStore(home).journal(found.missionId)).toHaveLength(lines);
  });

  it("takes no unrelated repository, even with the same branch name and the same project", async () => {
    const original = repoAt(join(folder, "backend"), [BRANCH]);
    const unrelated = repoAt(join(folder, "unrelated"), [BRANCH]);
    const found = mission([placement(original)]);
    await withLiveRoots(home, found, [root(NEW, unrelated), laneEntry], deps());
    expect(aliasesOf(found)).toBeUndefined();
  });

  it("takes no root of another Paseo project, even at the recorded folder", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    const found = mission([placement(directory)]);
    await withLiveRoots(home, found, [root(NEW, directory, { projectId: "prj_other" }), laneEntry], deps());
    expect(aliasesOf(found)).toBeUndefined();
  });

  it("takes no recorded folder whose git no longer holds the mission's branch", async () => {
    const directory = repoAt(join(folder, "backend"), ["m/SOMEONE/else"]);
    const found = mission([placement(directory)]);
    const listed = await withLiveRoots(home, found, [root(NEW, directory), laneEntry], deps());
    expect(listed.some((entry) => entry.id === OLD)).toBe(false);
    expect(aliasesOf(found)).toBeUndefined();
  });

  it("proves nothing from a placement with no creation record", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    const found = mission([{ ...placement(directory), requestBody: undefined } as Placement]);
    await withLiveRoots(home, found, [root(NEW, directory), laneEntry], deps());
    expect(aliasesOf(found)).toBeUndefined();
    expect(recordedOriginOf({ requestBody: "not json" })).toBeNull();
  });

  it("takes neither of two recorded folders that both hold the branch, and says so", async () => {
    const one = repoAt(join(folder, "one"), [BRANCH]);
    const two = repoAt(join(folder, "two"), [BRANCH]);
    const found = mission([placement(one), placement(two)]);
    await withLiveRoots(home, found, [root(NEW, one), root("wks_two", two), laneEntry], deps());
    expect(aliasesOf(found)).toBeUndefined();
    expect(logs.join("\n")).toContain("both hold its branches");
  });

  it("never takes a worktree or a directory workspace for a root", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    const found = mission([placement(directory)]);
    await withLiveRoots(home, found, [root("wks_tree", directory, { kind: "worktree" }), root("wks_dir", directory, { kind: "directory" }), laneEntry], deps());
    expect(aliasesOf(found)).toBeUndefined();
  });

  it("after the adopted root is lost too, staffing says what the owner can do; only a continuation says to use a new Worker", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    await withLiveRoots(home, mission([placement(directory)], [OLD]), [root(NEW, directory), laneEntry], deps());
    const found = createMissionStore(home).list().map((entry) => createMissionStore(home).get(entry.missionId)!)[0]!;
    expect(found.repoAliases).toEqual({ [NEW]: OLD });

    const lost = await withLiveRoots(home, found, [root(NEW, directory, { archived: true }), laneEntry], deps());
    expect(missionRepoOf(home, found, OLD, lost).toString()).toContain("the owner opens the repo's folder in Paseo");
    expect(missionRepoOf(home, found, OLD, lost, { continuing: true }).toString()).toContain("the owner opens the repo's folder in Paseo");

    const unproved = [root(NEW, join(folder, "moved")), laneEntry];
    expect(missionRepoOf(home, found, OLD, unproved).toString()).toContain("the owner opens the repo's folder in Paseo");
    expect(missionRepoOf(home, found, OLD, unproved, { continuing: true }).toString()).toContain("give the work a new Worker");
  });

  it("leaves a live repo, and an archived one with no placement, as listed", async () => {
    const directory = repoAt(join(folder, "backend"), [BRANCH]);
    const live = mission([placement(directory)], [OLD]);
    const listed = [root(OLD, directory), laneEntry];
    expect(staleReposOf(live, listed)).toEqual([]);
    expect(await withLiveRoots(home, live, listed, deps())).toEqual(listed);
    expect(staleReposOf({ charter: { repos: [OLD] } as Mission["charter"], placements: [] }, [])).toEqual([]);
  });
});
