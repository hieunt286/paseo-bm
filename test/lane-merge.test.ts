import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { MERGE_RETRY_MS, laneMergeIssueOf, laneMergeLineOf, mergeLane, overwrittenFilesOf, retryPendingMerges } from "../plugin/server/lane-merge";
import { createMissionStore, type Placement } from "../plugin/server/mission-store";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * Merging a finished lane into the mission branch (delivery line design
 * §19.2, ADR-038): real git in temporary folders — a root repository, lane 1's
 * worktree on the mission branch and lane 2's on its own branch.
 */

const NOW = new Date("2026-10-25T10:00:00.000Z");
const REPO = "wks_repo";

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearJsonFileCache();
  removeDataFolders();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function commitIn(cwd: string, file: string, text: string, message: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
}

/** A root repository with lane 1 (`m/ABC/repo`) and lane 2 (`m/ABC/repo-2`) worktrees, and the mission recording both. */
function world() {
  const home = dataFolder();
  const base = dirname(home);
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  // mergeGit creates merge commits itself; commitIn's per-call identity is
  // not inherited. Keep the fixture's identity in its own repository and
  // refuse Git's host-dependent identity guessing, as a clean CI runner does.
  git(root, "config", "user.useConfigOnly", "true");
  git(root, "config", "user.name", "Lane merge test");
  git(root, "config", "user.email", "lane-merge@example.invalid");
  commitIn(root, "a.txt", "a\n", "init");
  const lane1Dir = join(base, "lane1");
  const lane2Dir = join(base, "lane2");
  git(root, "worktree", "add", "-q", "-b", "m/ABC/repo", lane1Dir);
  git(root, "worktree", "add", "-q", "-b", "m/ABC/repo-2", lane2Dir, "m/ABC/repo");
  const made = createMissionStore(home, { now: () => NOW }).create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("\n"));
  const placement = (lane: number, directory: string, branch: string): Placement => ({
    repo: REPO,
    workspaceId: `wks_lane${lane}`,
    directory,
    branch,
    target: "main",
    base: lane === 1 ? "origin/main" : "m/ABC/repo",
    worktreeSlug: `m-abc-repo${lane === 1 ? "" : `-${lane}`}`,
    state: "ready",
    requestKey: `key-${lane}`,
    createdAt: NOW.toISOString(),
    deps: { cloned: [], at: NOW.toISOString(), note: null },
    integration: null,
    ...(lane === 1 ? {} : { lane }),
  });
  const lane1 = placement(1, lane1Dir, "m/ABC/repo");
  const lane2 = placement(2, lane2Dir, "m/ABC/repo-2");
  createMissionStore(home, { now: () => NOW }).update(made.mission.missionId, (mission) => ({ ...mission, placements: [lane1, lane2] }));
  return { home, missionId: made.mission.missionId, lane1, lane2, lane1Dir, lane2Dir };
}

const laneOfStore = (home: string, missionId: string, key: string) => createMissionStore(home).get(missionId)!.placements!.find((placement) => placement.requestKey === key)!;
const log = () => {};

describe("merging a lane (§19.2)", () => {
  it("asks the lane's Worker to merge the mission branch first when it moved on", async () => {
    const { lane2, lane1Dir, lane2Dir } = world();
    commitIn(lane2Dir, "b.txt", "b\n", "lane work");
    expect(await laneMergeIssueOf(lane2)).toBeNull();
    commitIn(lane1Dir, "c.txt", "c\n", "mission moved");
    expect(await laneMergeIssueOf(lane2)).toBe("merge m/ABC/repo into m/ABC/repo-2 (git merge m/ABC/repo), resolve the conflicts, check what the merge touched and commit, then report finished");
  });

  it("fast-forwards the mission branch in lane 1's worktree and frees the lane", async () => {
    const { home, missionId, lane2, lane1Dir, lane2Dir } = world();
    commitIn(lane2Dir, "b.txt", "b\n", "lane work");
    const outcome = await mergeLane(home, missionId, lane2, { log, now: () => NOW });
    expect(outcome).toEqual({ merged: true, into: "m/ABC/repo" });
    expect(git(lane1Dir, "rev-parse", "HEAD")).toBe(git(lane2Dir, "rev-parse", "HEAD"));
    expect(laneOfStore(home, missionId, "key-2")).toMatchObject({ mergedAt: NOW.toISOString(), freeSince: NOW.toISOString() });
    expect(laneMergeLineOf(lane2, outcome)).toBe("Lane 2 merged into m/ABC/repo; the lane is free for the next independent work.");
  });

  it("brings a mission branch that moved on into the lane when it merges cleanly, then fast-forwards", async () => {
    const { home, missionId, lane2, lane1Dir, lane2Dir } = world();
    commitIn(lane2Dir, "b.txt", "b\n", "lane work");
    commitIn(lane1Dir, "c.txt", "c\n", "another lane merged");
    const outcome = await mergeLane(home, missionId, lane2, { log, now: () => NOW });
    expect(outcome.merged).toBe(true);
    expect(git(lane1Dir, "rev-parse", "HEAD")).toBe(git(lane2Dir, "rev-parse", "HEAD"));
    expect(git(lane1Dir, "show", "HEAD:b.txt")).toBe("b");
    expect(git(lane1Dir, "show", "HEAD:c.txt")).toBe("c");
  });

  it("keeps the merge waiting, aborted, when the mission branch conflicts with the lane", async () => {
    const { home, missionId, lane2, lane1Dir, lane2Dir } = world();
    commitIn(lane2Dir, "a.txt", "lane\n", "lane edits a");
    commitIn(lane1Dir, "a.txt", "mission\n", "mission edits a");
    const outcome = await mergeLane(home, missionId, lane2, { log, now: () => NOW });
    expect(outcome.merged).toBe(false);
    if (outcome.merged) return;
    expect(outcome.files).toEqual(["a.txt"]);
    expect(outcome.reason).toContain("m/ABC/repo moved on and does not merge into m/ABC/repo-2 without conflicts");
    expect(git(lane2Dir, "status", "--porcelain")).toBe("");
    expect(laneOfStore(home, missionId, "key-2").mergePending).toMatchObject({ files: ["a.txt"], since: NOW.toISOString() });
    expect(laneMergeLineOf(lane2, outcome)).toContain("Lane 2 is NOT merged into m/ABC/repo yet");
  });

  it("waits while lane 1's uncommitted changes touch the lane's files, and merges on a retry once they are gone", async () => {
    const { home, missionId, lane2, lane1Dir, lane2Dir } = world();
    commitIn(lane2Dir, "a.txt", "lane\n", "lane edits a");
    writeFileSync(join(lane1Dir, "a.txt"), "half done\n");
    const outcome = await mergeLane(home, missionId, lane2, { log, now: () => NOW });
    expect(outcome).toEqual({ merged: false, reason: "lane 1 has uncommitted changes to files lane 2 changed", files: ["a.txt"] });
    // Not retried before MERGE_RETRY_MS; merged after it, once lane 1's change is gone.
    git(lane1Dir, "checkout", "--", "a.txt");
    await retryPendingMerges(home, { log, now: () => new Date(NOW.getTime() + MERGE_RETRY_MS - 1) });
    expect(laneOfStore(home, missionId, "key-2").mergePending).toBeDefined();
    await retryPendingMerges(home, { log, now: () => new Date(NOW.getTime() + MERGE_RETRY_MS) });
    expect(laneOfStore(home, missionId, "key-2").mergePending).toBeUndefined();
    expect(git(lane1Dir, "show", "HEAD:a.txt")).toBe("lane");
  });

  it("reads the files git says would be overwritten", () => {
    expect(overwrittenFilesOf("error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\n\tsrc/b.ts\nPlease commit your changes")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(overwrittenFilesOf("fatal: Not possible to fast-forward, aborting.")).toEqual([]);
  });
});
