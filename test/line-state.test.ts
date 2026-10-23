import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { committedOf, descriptorOf, finishedLineOf, lineStateOf, liveChecksOf, verifiedOf } from "../plugin/server/line-state";
import type { Placement } from "../plugin/server/mission-store";
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "../plugin/server/repo-tool";

/**
 * The line's state (delivery line design §4.5, §4.6): read-only git in a
 * placement's worktree is the primary source, the descriptor fills what git
 * cannot read; committed and verified follow from them. A temporary git
 * repository per test, its origin refs written by the test itself (no remote,
 * no fetch).
 */

const BRANCH = "m/ABC/fe";
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let repo: string;
// No background maintenance, no user config (as test/orchestrator-tools.test.ts's bm_repo).
const gitIn = (...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "pipe",
    encoding: "utf8",
  }).trim();
const commit = (file: string, body: string): string => {
  writeFileSync(join(repo, file), body);
  gitIn("add", file);
  gitIn("commit", "-q", "-m", `Change ${file}`);
  return gitIn("rev-parse", "HEAD");
};

function placement(over: Partial<Placement> = {}): Placement {
  return {
    repo: "wks_repo",
    workspaceId: "wks_place",
    directory: repo,
    branch: BRANCH,
    target: "main",
    base: "origin/main",
    worktreeSlug: "m-abc-fe",
    state: "ready",
    requestKey: "bm-place-x",
    createdAt: "2026-10-21T10:00:00.000Z",
    deps: { cloned: [], at: null, note: null },
    integration: null,
    ...over,
  };
}

/** A repo on the mission branch, one commit ahead of `origin/main`. */
function lineRepo(): string {
  gitIn("init", "-q", "-b", "main");
  commit(".gitignore", "local.json\n");
  gitIn("update-ref", "refs/remotes/origin/main", "HEAD");
  gitIn("checkout", "-q", "-b", BRANCH);
  return commit("b.txt", "b\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-line-"));
  repo = join(root, "repo");
  execFileSync("mkdir", [repo]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the line's state from read-only git (§4.5)", () => {
  it.skipIf(!hasGit)("reads dirty, ahead and behind the target, the last commit, HEAD and the branch; ahead of origin once pushed", async () => {
    const sha = lineRepo();
    const state = await lineStateOf(null, placement());
    expect(state).toMatchObject({ dirty: false, ahead: 1, behind: 0, head: sha, branchOk: true, aheadOfOrigin: null });
    expect(Date.parse(state!.lastCommitAt!)).not.toBeNaN();
    // The integration branch moves on (Paseo's fetch): one behind.
    gitIn("checkout", "-q", "main");
    commit("c.txt", "c\n");
    gitIn("update-ref", "refs/remotes/origin/main", "HEAD");
    gitIn("checkout", "-q", BRANCH);
    gitIn("update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
    expect(await lineStateOf(null, placement())).toMatchObject({ ahead: 1, behind: 1, aheadOfOrigin: 0 });
    commit("d.txt", "d\n");
    expect(await lineStateOf(null, placement())).toMatchObject({ ahead: 2, aheadOfOrigin: 1 });
  });

  it.skipIf(!hasGit)("runs only reading git commands, each with bm_repo's read-only prefix", async () => {
    const sha = lineRepo();
    const calls: string[][] = [];
    const git: GitRunner = (args, options) => {
      calls.push([...args]);
      return runGit(args, options);
    };
    await committedOf(null, placement(), sha, { git });
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args.slice(0, GIT_READ_ONLY_PREFIX.length)).toEqual([...GIT_READ_ONLY_PREFIX]);
    expect(new Set(calls.map((args) => args[GIT_READ_ONLY_PREFIX.length]))).toEqual(new Set(["rev-list", "status", "log", "rev-parse", "merge-base"]));
  });

  it("the descriptor fills what git cannot read; no worktree yet reads null", async () => {
    const failing: GitRunner = async () => {
      throw new Error("not a git repository");
    };
    const descriptor = descriptorOf({ workspace: { id: "wks_place", gitRuntime: { currentBranch: BRANCH, isDirty: true, aheadBehind: { ahead: 3, behind: 2 }, aheadOfOrigin: null, behindOfOrigin: null } } });
    expect(descriptor).toEqual({ currentBranch: BRANCH, isDirty: true, aheadBehind: { ahead: 3, behind: 2 }, aheadOfOrigin: null, behindOfOrigin: null });
    expect(await lineStateOf(null, placement(), { git: failing, descriptor })).toEqual({ dirty: true, ahead: 3, behind: 2, lastCommitAt: null, head: null, branchOk: true, aheadOfOrigin: null });
    expect(await lineStateOf(null, placement({ directory: null }))).toBeNull();
    // A workspace that is no placement.
    expect(await lineStateOf(null, "wks_other")).toBeNull();
    expect(descriptorOf({ id: "wks_place" })).toBeNull();
    expect(descriptorOf({ githubRuntime: { pullRequest: { url: "https://example.com/pr/1", checksStatus: "success" } } })?.pullRequest).toEqual({ url: "https://example.com/pr/1", checksStatus: "success" });
  });
});

describe("finished → committed (§4.6)", () => {
  it.skipIf(!hasGit)("clean, on the mission branch, the sha in HEAD's history: committed; an ignored file does not count", async () => {
    const sha = lineRepo();
    writeFileSync(join(repo, "local.json"), "{}\n");
    const result = await committedOf(null, placement(), sha);
    expect(result.committed).toBe(true);
    // An older commit of the branch is in the history too, and a short sha reads.
    expect((await committedOf(null, placement(), sha.slice(0, 7))).committed).toBe(true);
    expect(finishedLineOf(result, BRANCH, "unverified")).toBe(`finished, committed on ${BRANCH}.`);
  });

  it.skipIf(!hasGit)("dirty, wrong branch, or a sha not in the history: finished, uncommitted", async () => {
    const sha = lineRepo();
    writeFileSync(join(repo, "new.txt"), "untracked\n");
    const dirty = await committedOf(null, placement(), sha);
    expect(dirty).toMatchObject({ committed: false, why: "the worktree has changes not committed" });
    expect(finishedLineOf(dirty, BRANCH, "unverified")).toBe("finished, uncommitted: the worktree has changes not committed.");
    rmSync(join(repo, "new.txt"));
    writeFileSync(join(repo, "b.txt"), "changed\n");
    expect(await committedOf(null, placement(), sha)).toMatchObject({ committed: false, why: "the worktree has changes not committed" });
    gitIn("checkout", "-q", "--", "b.txt");

    gitIn("checkout", "-q", "-b", "other");
    const elsewhere = commit("e.txt", "e\n");
    expect(await committedOf(null, placement(), sha)).toMatchObject({ committed: false, why: `the worktree is not on ${BRANCH}` });
    gitIn("checkout", "-q", BRANCH);
    expect(await committedOf(null, placement(), elsewhere)).toMatchObject({ committed: false, why: `${elsewhere} is not in the history of ${BRANCH}` });
    expect(await committedOf(null, placement(), "0000000")).toMatchObject({ committed: false, why: `0000000 is not in the history of ${BRANCH}` });
    expect((await committedOf(null, placement(), sha)).committed).toBe(true);
  });

  it("a worktree git cannot read is never committed", async () => {
    const failing: GitRunner = async () => {
      throw new Error("not a git repository");
    };
    expect(await committedOf(null, placement(), "abcdef1", { git: failing })).toMatchObject({ committed: false, why: "paseo-bm could not read the git of the mission's worktree" });
  });
});

describe("committed → verified with integration.ci on (§4.6)", () => {
  const mr = "https://gitlab.example.com/group/fe/-/merge_requests/7";
  it("the merge request's checks passed on a pushed head containing the sha; failure is CI red", () => {
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "success" }, aheadOfOrigin: 0 })).toBe("verified");
    // Not pushed up to HEAD: the passed checks ran on an older head.
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "success" }, aheadOfOrigin: 1 })).toBe("pending");
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "success" }, aheadOfOrigin: null })).toBe("pending");
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "pending" }, aheadOfOrigin: 0 })).toBe("pending");
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "failure" }, aheadOfOrigin: 0 })).toBe("ci-red");
    expect(verifiedOf({ ci: "on", committed: false, integration: { mr, ci: "failure" }, aheadOfOrigin: 0 })).toBe("ci-red");
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "none" }, aheadOfOrigin: 0 })).toBe("unverified");
    // Paseo's githubRuntime.pullRequest, when filled, wins over the report's.
    expect(verifiedOf({ ci: "on", committed: true, integration: { mr, ci: "pending" }, aheadOfOrigin: 0, pullRequest: { checksStatus: "success" } })).toBe("verified");
    expect(verifiedOf({ ci: "on", committed: true, aheadOfOrigin: 0, pullRequest: { checksStatus: "failure" } })).toBe("ci-red");
  });

  it("before a merge request, a detected local check; uncommitted is never verified", () => {
    expect(verifiedOf({ ci: "on", committed: true, aheadOfOrigin: null, checks: "detected" })).toBe("verified");
    expect(verifiedOf({ ci: "on", committed: true, aheadOfOrigin: null, checks: "self-reported" })).toBe("unverified");
    expect(verifiedOf({ ci: "on", committed: true, aheadOfOrigin: null })).toBe("unverified");
    expect(verifiedOf({ ci: "on", committed: false, aheadOfOrigin: 0, checks: "detected" })).toBe("unverified");
  });

  it("the delivery line names CI red, verified and pending", () => {
    const line = { dirty: false, ahead: 1, behind: 0, lastCommitAt: null, head: "abc", branchOk: true, aheadOfOrigin: 0 };
    expect(finishedLineOf({ committed: true, line }, BRANCH, "ci-red")).toBe(`finished, committed on ${BRANCH}; CI red.`);
    expect(finishedLineOf({ committed: true, line }, BRANCH, "verified")).toBe(`finished, committed on ${BRANCH}; verified.`);
    expect(finishedLineOf({ committed: true, line }, BRANCH, "pending")).toBe(`finished, committed on ${BRANCH}; CI pending.`);
  });
});

describe("committed → verified with integration.ci off, the default (ADR-036, §17.1)", () => {
  const mr = "https://gitlab.example.com/group/fe/-/merge_requests/7";
  const line = { dirty: false, ahead: 1, behind: 0, lastCommitAt: null, head: "abc", branchOk: true, aheadOfOrigin: 0 };

  it("verified is a detected check only, merge request or not", () => {
    expect(verifiedOf({ ci: "off", committed: true, aheadOfOrigin: null, checks: "detected" })).toBe("verified");
    expect(verifiedOf({ ci: "off", committed: true, integration: { mr }, aheadOfOrigin: 0, checks: "detected" })).toBe("verified");
    expect(verifiedOf({ ci: "off", committed: true, aheadOfOrigin: null, checks: "self-reported" })).toBe("unverified");
    expect(verifiedOf({ ci: "off", committed: true, aheadOfOrigin: null })).toBe("unverified");
    expect(verifiedOf({ ci: "off", committed: false, aheadOfOrigin: 0, checks: "detected" })).toBe("unverified");
  });

  it("the report's ci and the descriptor's checks are ignored: never CI red nor pending", () => {
    expect(verifiedOf({ ci: "off", committed: true, integration: { mr, ci: "failure" }, aheadOfOrigin: 0, checks: "detected" })).toBe("verified");
    expect(verifiedOf({ ci: "off", committed: false, integration: { mr, ci: "failure" }, aheadOfOrigin: 0 })).toBe("unverified");
    expect(verifiedOf({ ci: "off", committed: true, integration: { mr, ci: "success" }, aheadOfOrigin: 0 })).toBe("unverified");
    expect(verifiedOf({ ci: "off", committed: true, integration: { mr, ci: "pending" }, aheadOfOrigin: 0 })).toBe("unverified");
    expect(verifiedOf({ ci: "off", committed: true, aheadOfOrigin: 0, pullRequest: { checksStatus: "failure" } })).toBe("unverified");
    expect(verifiedOf({ ci: "off", committed: true, aheadOfOrigin: 0, pullRequest: { checksStatus: "success" }, checks: "detected" })).toBe("verified");
  });

  it("the Main's line has no CI words", () => {
    for (const ci of ["failure", "pending", "success", "none", "not-run"] as const) {
      for (const checks of ["detected", "self-reported", null] as const) {
        const verified = verifiedOf({ ci: "off", committed: true, integration: { mr, ci }, aheadOfOrigin: 0, pullRequest: { checksStatus: ci }, checks });
        const text = finishedLineOf({ committed: true, line }, BRANCH, verified);
        expect(text).not.toMatch(/\bCI\b/);
        expect(text).toBe(checks === "detected" ? `finished, committed on ${BRANCH}; verified.` : `finished, committed on ${BRANCH}.`);
      }
    }
  });

  it("turning the setting on restores §4.6", () => {
    const input = { committed: true, integration: { mr, ci: "failure" as const }, aheadOfOrigin: 0, checks: "detected" as const };
    expect(verifiedOf({ ...input, ci: "off" })).toBe("verified");
    expect(verifiedOf({ ...input, ci: "on" })).toBe("ci-red");
  });
});

describe("the checks detected in the Worker's own turns, read live (ADR-036, §17.1)", () => {
  const shell = (callId: string, command: string, status: string, at: string) => ({ item: { type: "tool_call", callId, name: "Bash", status, error: null, detail: { type: "shell", command } }, timestamp: at });
  const edit = (path: string, at: string) => ({ item: { type: "tool_call", callId: `e-${at}`, name: "Edit", status: "completed", error: null, detail: { type: "edit", filePath: path } }, timestamp: at });
  const report = { buildAndTests: "`npm test` passed", filesChanged: ["src/a.ts"], beadsClosed: [] };
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 23, 10, minute)).toISOString();

  it("a named check run with success after the last edit is detected; one before it, or failed, is not", () => {
    expect(liveChecksOf([[edit("/w/fe/src/a.ts", at(1)), shell("c1", "npm test", "completed", at(2))]], "w1", report, "/w/fe")).toBe("detected");
    expect(liveChecksOf([[shell("c1", "npm test", "completed", at(1)), edit("/w/fe/src/a.ts", at(2))]], "w1", report, "/w/fe")).toBe("self-reported");
    expect(liveChecksOf([[edit("/w/fe/src/a.ts", at(1)), shell("c1", "npm test", "failed", at(2))]], "w1", report, "/w/fe")).toBe("self-reported");
    expect(liveChecksOf([], "w1", report, "/w/fe")).toBe("self-reported");
    expect(liveChecksOf([[shell("c1", "npm test", "completed", at(2))]], "w1", { ...report, buildAndTests: "not run" }, "/w/fe")).toBe("unverified");
  });

  it("reads the pages newest first, so a call that spans two pages ends in its latest state", () => {
    const older = [edit("/w/fe/src/a.ts", at(1)), shell("c1", "npm test", "running", at(2))];
    const newer = [shell("c1", "npm test", "completed", at(4))];
    expect(liveChecksOf([newer, older], "w1", report, "/w/fe")).toBe("detected");
  });
});
