import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { checkLaneOverlaps, laneFilesOf, lanesInUseOf, overlapSignalOf } from "../plugin/server/lane-overlap";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore, type Placement } from "../plugin/server/mission-store";
import { runGit } from "../plugin/server/repo-tool";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/** Two lanes changing the same files (delivery line design §19.3, ADR-038): real git in temporary folders, a fake notice queue. */

const NOW = new Date("2026-10-25T10:00:00.000Z");
const REPO = "wks_repo";

afterEach(() => {
  clearJsonFileCache();
  clearRequestIndexCache();
  removeDataFolders();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

function write(cwd: string, file: string, text: string, commit?: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
  if (commit !== undefined) {
    git(cwd, "add", file);
    git(cwd, "commit", "-q", "-m", commit);
  }
}

function world() {
  const home = dataFolder();
  const base = dirname(home);
  const root = join(base, "repo");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  write(root, "a.txt", "a\n", "init");
  write(root, "b.txt", "b\n", "init b");
  const lane1Dir = join(base, "lane1");
  const lane2Dir = join(base, "lane2");
  git(root, "worktree", "add", "-q", "-b", "m/ABC/repo", lane1Dir);
  git(root, "worktree", "add", "-q", "-b", "m/ABC/repo-2", lane2Dir, "m/ABC/repo");
  const made = createMissionStore(home, { now: () => NOW }).create({ code: "ABC", name: "Alpha", goal: "Ship it.", repos: [REPO], createdBy: "owner", mainId: "main-1" });
  if (!made.ok) throw new Error(made.reasons.join("\n"));
  const placement = (lane: number, directory: string, branch: string, extra: Partial<Placement> = {}): Placement => ({
    repo: REPO,
    workspaceId: `wks_lane${lane}`,
    directory,
    branch,
    target: "main",
    base: lane === 1 ? "origin/main" : "m/ABC/repo",
    worktreeSlug: `m-abc-repo-${lane}`,
    state: "ready",
    requestKey: `key-${lane}`,
    createdAt: NOW.toISOString(),
    deps: { cloned: [], at: NOW.toISOString(), note: null },
    integration: null,
    ...(lane === 1 ? {} : { lane }),
    ...extra,
  });
  createMissionStore(home, { now: () => NOW }).update(made.mission.missionId, (mission) => ({
    ...mission,
    placements: [placement(1, lane1Dir, "m/ABC/repo"), placement(2, lane2Dir, "m/ABC/repo-2"), placement(3, join(base, "nowhere"), "m/ABC/repo-3", { freeSince: NOW.toISOString() })],
  }));
  createMissionRoster(home, { now: () => NOW }).add(made.mission.missionId, { requestId: "req-20261025T010000Z", workspaceId: "wks_lane1", topic: "audit", workerId: "w1" });
  createMissionRoster(home, { now: () => NOW }).add(made.mission.missionId, { requestId: "req-20261025T020000Z", workspaceId: "wks_lane2", topic: "flags", workerId: "w2" });
  return { home, missionId: made.mission.missionId, lane1Dir, lane2Dir };
}

function fakeQueue() {
  const sent: Array<{ targetId: string; kind: string; text: string }> = [];
  const enqueue = vi.fn(async (targetId: string, kind: string, text: string) => {
    sent.push({ targetId, kind, text });
    return "sent" as const;
  });
  const enqueueBatch = vi.fn(async (targetId: string, _batch: unknown, items: Array<{ key: string; line: string }>) => {
    for (const item of items) sent.push({ targetId, kind: item.key, text: item.line });
    return items.map(() => "sent" as const);
  });
  return { queue: { enqueue, enqueueBatch } as never, sent };
}

describe("lane overlap (§19.3)", () => {
  it("reads lane 1's uncommitted files and a lane's files since the mission branch, and skips a free lane", async () => {
    const { home, missionId, lane1Dir, lane2Dir } = world();
    write(lane1Dir, "a.txt", "half\n");
    write(lane2Dir, "a.txt", "lane\n", "lane edits a");
    write(lane2Dir, "c.txt", "new\n");
    const lanes = lanesInUseOf(createMissionStore(home).get(missionId)!).get(REPO)!;
    expect(lanes.map((lane) => lane.requestKey)).toEqual(["key-1", "key-2"]);
    expect(await laneFilesOf(runGit, lanes[0]!)).toEqual(["a.txt"]);
    expect(await laneFilesOf(runGit, lanes[1]!)).toEqual(["a.txt", "c.txt"]);
  });

  it("tells the Main once per shared set, and again only when it grows", async () => {
    const { home, missionId, lane1Dir, lane2Dir } = world();
    write(lane1Dir, "a.txt", "half\n");
    write(lane2Dir, "a.txt", "lane\n", "lane edits a");
    const { queue, sent } = fakeQueue();
    await checkLaneOverlaps(home, { log: () => {}, queue, now: () => NOW });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.targetId).toBe("main-1");
    expect(sent[0]!.text).toBe(
      overlapSignalOf({ repo: "lane1", lanes: [1, 2], requests: [["req-20261025T010000Z"], ["req-20261025T020000Z"]], files: ["a.txt"] }),
    );
    expect(sent[0]!.text).toContain("lanes 1 and 2 of lane1 both change a.txt (lane 1: req-20261025T010000Z; lane 2: req-20261025T020000Z)");
    // §19.8: the higher lane keeps the files told and when, for the mission page's overlap line.
    const told = createMissionStore(home).get(missionId)!.placements!.find((placement) => placement.requestKey === "key-2")!;
    expect([told.overlapTold, told.overlapToldAt]).toEqual([{ "1": ["a.txt"] }, { "1": NOW.toISOString() }]);
    await checkLaneOverlaps(home, { log: () => {}, queue, now: () => NOW });
    expect(sent).toHaveLength(1);
    write(lane1Dir, "b.txt", "half b\n");
    write(lane2Dir, "b.txt", "lane b\n", "lane edits b");
    await checkLaneOverlaps(home, { log: () => {}, queue, now: () => NOW });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("both change a.txt, b.txt");
  });

  it("says nothing when the lanes change different files", async () => {
    const { home, lane1Dir, lane2Dir } = world();
    write(lane1Dir, "a.txt", "half\n");
    write(lane2Dir, "b.txt", "lane\n", "lane edits b");
    const { queue, sent } = fakeQueue();
    await checkLaneOverlaps(home, { log: () => {}, queue, now: () => NOW });
    expect(sent).toEqual([]);
  });
});
