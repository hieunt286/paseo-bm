import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { MERGE_RETRY_MS, fastForwardLocalTarget, laneMergeIssueOf, laneMergeLineOf, localMergeRefusalOf, mergeGit, mergeLane, overwrittenFilesOf, retryPendingMerges, worktreeOfBranch } from "../plugin/server/lane-merge";
import type { GitRunner } from "../plugin/server/repo-tool";
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

  it("reads the worktree a branch is checked out in", () => {
    const porcelain = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /l\nHEAD bbb\nbranch refs/heads/m/ABC/repo\n\nworktree /d\nHEAD ccc\ndetached\n";
    expect([worktreeOfBranch(porcelain, "main"), worktreeOfBranch(porcelain, "m/ABC/repo"), worktreeOfBranch(porcelain, "dev"), worktreeOfBranch(porcelain, "repo")]).toEqual(["/r", "/l", null, null]);
  });

  it("reads the files git says would be overwritten", () => {
    expect(overwrittenFilesOf("error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\n\tsrc/b.ts\nPlease commit your changes")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(overwrittenFilesOf("fatal: Not possible to fast-forward, aborting.")).toEqual([]);
  });
});

describe("the local merge (ADR-045 decision 4, plan §5.3)", () => {
  const rootOf = (lane1Dir: string) => join(dirname(lane1Dir), "repo");
  /** A commit on the mission branch; its sha. */
  function workOn(lane1Dir: string): string {
    commitIn(lane1Dir, "b.txt", "b\n", "mission work");
    return git(lane1Dir, "rev-parse", "HEAD");
  }
  function recording(): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    return { calls, git: (args, options) => (calls.push([...args]), mergeGit(args, options)) };
  }
  const WRITES = ["merge", "update-ref", "push", "tag", "reset", "branch", "rebase", "fetch"];
  const writesOf = (calls: readonly string[][]) => calls.filter((args) => WRITES.includes(args[0]!)).map((args) => args[0]);
  const stated = { state: "granted" as const, decisionId: "m:x:1", grantedAt: NOW.toISOString(), revokedAt: null, target: "main" };
  function granted(home: string, missionId: string, over: Record<string, unknown> = stated): void {
    createMissionStore(home).update(missionId, (mission) => ({ ...mission, placements: mission.placements!.map((placement) => (placement.requestKey === "key-1" ? ({ ...placement, localMerge: over } as Placement) : placement)) }));
  }
  const journalOf = (home: string, missionId: string) => createMissionStore(home).journal(missionId, 20).map((line) => line.text);

  it("the target checked out in a worktree moves by fast-forward, its files with it", async () => {
    const { lane1Dir } = world();
    const root = rootOf(lane1Dir);
    const sha = workOn(lane1Dir);
    const spy = recording();
    expect(await fastForwardLocalTarget("main", sha, lane1Dir, { git: spy.git })).toEqual({ merged: true });
    expect(git(root, "rev-parse", "main")).toBe(sha);
    expect(git(root, "show", "HEAD:b.txt")).toBe("b");
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(writesOf(spy.calls)).toEqual(["merge"]);
    expect(spy.calls.find((args) => args[0] === "merge")).toEqual(["merge", "--ff-only", sha]);
  });

  it("a target not checked out moves by the guarded update-ref", async () => {
    const { lane1Dir } = world();
    const root = rootOf(lane1Dir);
    git(root, "checkout", "-q", "-b", "elsewhere");
    const old = git(root, "rev-parse", "main");
    const sha = workOn(lane1Dir);
    const spy = recording();
    expect(await fastForwardLocalTarget("main", sha, lane1Dir, { git: spy.git })).toEqual({ merged: true });
    expect(git(root, "rev-parse", "main")).toBe(sha);
    expect(git(root, "rev-parse", "elsewhere")).toBe(old);
    expect(writesOf(spy.calls)).toEqual(["update-ref"]);
    expect(spy.calls.find((args) => args[0] === "update-ref")).toEqual(["update-ref", "refs/heads/main", sha, old]);
  });

  it("a diverged target stays, checked out or not, with a named reason", async () => {
    for (const checkedOut of [true, false]) {
      const { lane1Dir } = world();
      const root = rootOf(lane1Dir);
      const sha = workOn(lane1Dir);
      commitIn(root, "c.txt", "c\n", "owner's own commit");
      if (!checkedOut) git(root, "checkout", "-q", "-b", "elsewhere");
      const before = git(root, "rev-parse", "main");
      const spy = recording();
      expect(await fastForwardLocalTarget("main", sha, lane1Dir, { git: spy.git })).toEqual({ merged: false, reason: `main and ${sha} have diverged, so it is not a fast-forward` });
      expect(git(root, "rev-parse", "main")).toBe(before);
      expect(writesOf(spy.calls)).toEqual([]);
    }
  });

  it("a dirty file the merge would overwrite leaves the target and the file as they were", async () => {
    const { lane1Dir } = world();
    const root = rootOf(lane1Dir);
    commitIn(lane1Dir, "a.txt", "mission\n", "mission edits a");
    const sha = git(lane1Dir, "rev-parse", "HEAD");
    writeFileSync(join(root, "a.txt"), "half done\n");
    const before = git(root, "rev-parse", "main");
    expect(await fastForwardLocalTarget("main", sha, lane1Dir)).toEqual({ merged: false, reason: "uncommitted changes in main's worktree would be overwritten: a.txt" });
    expect(git(root, "rev-parse", "main")).toBe(before);
    expect(git(root, "status", "--porcelain")).toBe("M a.txt");
  });

  it("a target that already holds the commit needs no write; a commit or target it cannot read is refused", async () => {
    const { lane1Dir } = world();
    const root = rootOf(lane1Dir);
    const base = git(root, "rev-parse", "main");
    const spy = recording();
    expect(await fastForwardLocalTarget("main", base, lane1Dir, { git: spy.git })).toEqual({ merged: true });
    expect(writesOf(spy.calls)).toEqual([]);
    const unknownSha = await fastForwardLocalTarget("main", "abcdef1", lane1Dir);
    expect(unknownSha.merged === false && unknownSha.reason).toContain("git could not read main and abcdef1");
    const noTarget = await fastForwardLocalTarget("dev", base, lane1Dir);
    expect(noTarget.merged === false && noTarget.reason).toContain("git could not read dev");
    const broken: GitRunner = async () => {
      throw Object.assign(new Error("boom"), { stderr: "fatal: not a git repository" });
    };
    expect(await fastForwardLocalTarget("main", base, lane1Dir, { git: broken })).toEqual({ merged: false, reason: `git could not read main and ${base}: fatal: not a git repository` });
    expect(git(root, "rev-parse", "main")).toBe(base);
  });

  it("without the grant, or with one for another target, git is not touched", async () => {
    const { home, missionId, lane1, lane1Dir } = world();
    const sha = workOn(lane1Dir);
    const before = git(rootOf(lane1Dir), "rev-parse", "main");
    const spy = recording();
    expect(await localMergeRefusalOf(home, lane1, sha, false, { log, now: () => NOW, git: spy.git })).toBeNull();
    granted(home, missionId, { ...stated, target: "develop" });
    expect(await localMergeRefusalOf(home, lane1, sha, false, { log, now: () => NOW, git: spy.git })).toBeNull();
    granted(home, missionId, { ...stated, state: "revoked", revokedAt: NOW.toISOString() });
    expect(await localMergeRefusalOf(home, lane1, sha, false, { log, now: () => NOW, git: spy.git })).toBeNull();
    expect(spy.calls).toEqual([]);
    expect(git(rootOf(lane1Dir), "rev-parse", "main")).toBe(before);
  });

  it("under the grant: moves and journals; a refusal changes nothing and names why", async () => {
    const { home, missionId, lane1, lane1Dir } = world();
    granted(home, missionId);
    const sha = workOn(lane1Dir);
    expect(await localMergeRefusalOf(home, lane1, sha, false, { log, now: () => NOW })).toBeNull();
    expect(git(rootOf(lane1Dir), "rev-parse", "main")).toBe(sha);
    expect(journalOf(home, missionId)).toContain(`main moved forward to ${sha} by fast-forward.`);

    commitIn(rootOf(lane1Dir), "c.txt", "c\n", "owner's own commit");
    const next = workOn2(lane1Dir);
    const before = git(rootOf(lane1Dir), "rev-parse", "main");
    expect(await localMergeRefusalOf(home, lane1, next, false, { log, now: () => NOW })).toBe(`the local merge into main was refused: main and ${next} have diverged, so it is not a fast-forward`);
    expect(git(rootOf(lane1Dir), "rev-parse", "main")).toBe(before);
    expect(journalOf(home, missionId)).toContain(`The local merge of ${next} into main changed nothing: main and ${next} have diverged, so it is not a fast-forward.`);
  });

  it("a lane n >= 2 merges only once mergeLane merged it, under the grant on lane 1", async () => {
    const { home, missionId, lane2, lane1Dir, lane2Dir } = world();
    granted(home, missionId);
    commitIn(lane2Dir, "b.txt", "b\n", "lane work");
    const sha = git(lane2Dir, "rev-parse", "HEAD");
    const before = git(rootOf(lane1Dir), "rev-parse", "main");
    const spy = recording();
    expect(await localMergeRefusalOf(home, lane2, sha, false, { log, now: () => NOW, git: spy.git })).toBe("the local merge into main was refused: lane 2 is not merged into m/ABC/repo yet");
    expect(spy.calls).toEqual([]);
    expect(git(rootOf(lane1Dir), "rev-parse", "main")).toBe(before);
    expect((await mergeLane(home, missionId, lane2, { log, now: () => NOW })).merged).toBe(true);
    expect(await localMergeRefusalOf(home, lane2, sha, true, { log, now: () => NOW })).toBeNull();
    expect(git(rootOf(lane1Dir), "rev-parse", "main")).toBe(sha);
  });

  /** A second commit on the mission branch; its sha. */
  function workOn2(lane1Dir: string): string {
    commitIn(lane1Dir, "d.txt", "d\n", "more mission work");
    return git(lane1Dir, "rev-parse", "HEAD");
  }
});
