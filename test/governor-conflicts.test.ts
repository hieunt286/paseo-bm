import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearJsonFileCache } from "../plugin/server/data-files";
import {
  WHOLE_REPO_AREA,
  areaCovers,
  areaOfFile,
  createArbitrationStore,
  createConflictWatch,
  isArbitrated,
  linkConflictsOf,
  normalArea,
  overlapConflictsOf,
  type Arbitration,
} from "../plugin/server/governor-conflicts";
import { LINE_REFRESH_MS, cachedLineOf, clearLineCache, refreshLines } from "../plugin/server/line-watch";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore, type Placement } from "../plugin/server/mission-store";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { TraceRecord } from "../plugin/shared/contracts";
import { file, turn } from "./fixtures/orchestrator-traces";
import { fakeLineGit, type FakeLine } from "./helpers/line-git";

/**
 * Conflict detection between missions (missions design §9.6, WP-204;
 * delivery line design §4.7): two missions' branches of one repo changing one
 * area, a link from one mission into another's repo — and the arbitrations
 * that settle them — on a temporary data folder. Writer collisions and
 * charter areas are no source any more. The lines' git is a fake runner.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const hoursAgo = (hours: number): string => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const A = "mis-00000000a1";
const B = "mis-00000000b2";
const RA = "req-20261009T100000Z";
const RB = "req-20261009T100001Z";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-governor-conflicts-"));
  clearRequestIndexCache();
  clearTraceStoreCache();
  clearLineCache();
});
afterEach(() => {
  clearRequestIndexCache();
  clearTraceStoreCache();
  clearLineCache();
  clearJsonFileCache();
  rmSync(home, { recursive: true, force: true });
});

/** Mission A (PAY, request RA by Worker w-a) and mission B (WEB, request RB by Worker w-b), both with repo-a in their charters. */
function twoMissions(reposOfB: string[] = ["repo-a"]): void {
  const ids = [A, B];
  const store = createMissionStore(home, { now: () => NOW, newId: () => ids.shift()!, env: {} });
  expect(store.create({ code: "PAY", name: "Payments", goal: "Card payments.", repos: ["repo-a"], createdBy: "owner", mainId: "main-a" }).ok).toBe(true);
  expect(store.create({ code: "WEB", name: "Website", goal: "The new website.", repos: reposOfB, createdBy: "owner", mainId: "main-b" }).ok).toBe(true);
  const roster = createMissionRoster(home, { now: () => NOW, env: {} });
  roster.add(A, { requestId: RA, workspaceId: "repo-a", topic: "cards", workerId: "w-a" });
  roster.add(B, { requestId: RB, workspaceId: reposOfB[0]!, topic: "pages", workerId: "w-b" });
}

/** Each mission's placement of `repo`: PAY's worktree /w/pay, WEB's /w/web. */
function placeBoth(repoOfB = "repo-a"): void {
  const placement = (code: string, repo: string): Placement => ({
    repo,
    workspaceId: `wks-${code.toLowerCase()}`,
    directory: `/w/${code.toLowerCase()}`,
    branch: `m/${code}/${repo}`,
    target: "develop",
    base: "origin/develop",
    worktreeSlug: `m-${code.toLowerCase()}-${repo}`,
    state: "ready",
    requestKey: `bm-place-${code}`,
    createdAt: NOW.toISOString(),
    deps: { cloned: [], at: null, note: null },
    integration: null,
  });
  const store = createMissionStore(home, { now: () => NOW, env: {} });
  expect(store.update(A, (mission) => ({ ...mission, placements: [placement("PAY", "repo-a")] })).ok).toBe(true);
  expect(store.update(B, (mission) => ({ ...mission, placements: [placement("WEB", repoOfB)] })).ok).toBe(true);
}

/** A clean worktree on its branch, one commit ahead, changing `files`. */
const line = (branch: string, files: readonly string[]): FakeLine => ({
  counts: "0\t1",
  status: "",
  lastCommitAt: hoursAgo(1),
  head: "abcdef1234567",
  branch,
  aheadLog: hoursAgo(1),
  diff: files.join("\n"),
});

const wrote = (agentId: string, requestId: string, paths: readonly string[], hours: number): TraceRecord =>
  turn({ workspaceId: "repo-a", agentId, role: "worker", requestId, turnId: `turn-${agentId}-${hours}`, endedAt: hoursAgo(hours), at: hoursAgo(hours), evidence: paths.map((path) => file(path, hoursAgo(hours), agentId)) });

const arbitration = (over: Partial<Arbitration> = {}): Arbitration => ({
  id: "arb-0123456789",
  at: NOW.toISOString(),
  missions: [B, A],
  workspaceId: "repo-a",
  area: "src/shared",
  owner: A,
  reason: "Payments owns the shared code.",
  commandIds: [],
  decisionId: null,
  ...over,
});

describe("areas (pure)", () => {
  it("an area is a file's folder, or the file at the repo's root; '.', '*' and '' are the whole repo; a folder covers what is under it", () => {
    expect(areaOfFile("src/shared/money.ts")).toBe("src/shared");
    expect(areaOfFile("package.json")).toBe("package.json");
    expect(normalArea("./src/shared/**")).toBe("src/shared");
    expect(normalArea("src/shared/")).toBe("src/shared");
    expect(normalArea("*")).toBe(WHOLE_REPO_AREA);
    expect(normalArea("  ")).toBe(WHOLE_REPO_AREA);
    expect(areaCovers("src", "src/shared")).toBe(true);
    expect(areaCovers("src/shared/**", "src/shared/money.ts")).toBe(true);
    expect(areaCovers(".", "anything")).toBe(true);
    expect(areaCovers("src/shared", "src/sharedx")).toBe(false);
    expect(areaCovers("src/shared", "src")).toBe(false);
  });

  it("an arbitration settles a conflict of the same two missions, in its repo, whose area it covers", () => {
    const event = { missions: [A, B], workspaceId: "repo-a", area: "src/shared/money.ts" };
    expect(isArbitrated(event, [arbitration()])).toBe(true);
    expect(isArbitrated({ ...event, workspaceId: "repo-b" }, [arbitration()])).toBe(false);
    expect(isArbitrated({ ...event, area: "src/web" }, [arbitration()])).toBe(false);
    expect(isArbitrated({ ...event, missions: [A, "mis-00000000c3"] }, [arbitration()])).toBe(false);
    expect(isArbitrated({ ...event, missions: [A, A] }, [arbitration({ missions: [A, A] })])).toBe(false);
  });
});

describe("conflict detection (§9.6)", () => {
  it("two open missions' branches of one repo changing one area against origin/<target> are 'expect a merge conflict', once per area (delivery line design §4.7)", async () => {
    twoMissions();
    placeBoth();
    const { git, calls } = fakeLineGit({
      "/w/pay": line("m/PAY/repo-a", ["src/shared/money.ts", "src/pay/card.ts"]),
      "/w/web": line("m/WEB/repo-a", ["src/shared/money.ts", "src/web/page.ts"]),
    });
    const watch = createConflictWatch({ home: () => home, now: () => NOW, log: () => {}, git });
    expect(await watch.pass()).toEqual([
      {
        type: "mission.conflict",
        missions: [A, B],
        workspaceId: "repo-a",
        area: "src/shared",
        evidence: "expect a merge conflict: PAY (m/PAY/repo-a) and WEB (m/WEB/repo-a) both change src/shared against origin/develop: 1 file, e.g. src/shared/money.ts",
      },
    ]);
    // The read-only diff of each branch against its integration branch, three dots.
    expect(calls.filter((call) => call.args[0] === "diff").map((call) => [call.cwd, call.args.join(" ")])).toEqual([
      ["/w/pay", "diff --name-only origin/develop...m/PAY/repo-a"],
      ["/w/web", "diff --name-only origin/develop...m/WEB/repo-a"],
    ]);
    // The pure source reads the lines as last read: no git.
    const before = calls.length;
    expect(overlapConflictsOf(home).map((event) => event.area)).toEqual(["src/shared"]);
    expect(calls.length).toBe(before);
  });

  it("branches changing different files raise nothing; nor do the charters' written areas or two Workers writing one file, which are no source any more", async () => {
    twoMissions();
    placeBoth();
    // Both missions wrote src/shared in their traces: the old charter source would have raised it.
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, wrote("w-a", RA, ["src/shared/money.ts"], 5));
    await appendRecord(location, wrote("w-b", RB, ["src/shared/format.ts"], 3));
    const { git } = fakeLineGit({ "/w/pay": line("m/PAY/repo-a", ["src/pay/card.ts"]), "/w/web": line("m/WEB/repo-a", ["src/web/page.ts"]) });
    const watch = createConflictWatch({ home: () => home, now: () => NOW, log: () => {}, git });
    expect(await watch.pass()).toEqual([]);
    // Writer collisions stay inside a placement (writers-observed): the watch has no turn source.
    expect(Object.keys(watch)).toEqual(["pass"]);
  });

  it("reads each line at most once a minute, and a diff only where two open missions share a repo", async () => {
    twoMissions(["repo-b"]);
    placeBoth("repo-b");
    const { git, calls } = fakeLineGit({ "/w/pay": line("m/PAY/repo-a", ["src/a.ts"]), "/w/web": line("m/WEB/repo-b", ["src/a.ts"]) });
    await refreshLines(home, { now: () => NOW, git });
    // Two repos: no diff read, no conflict.
    expect(calls.some((call) => call.args[0] === "diff")).toBe(false);
    expect(cachedLineOf(home, "wks-pay")).toMatchObject({ at: NOW.toISOString(), changed: null, firstAheadAt: hoursAgo(1), line: { ahead: 1, behind: 0, dirty: false } });
    expect(overlapConflictsOf(home)).toEqual([]);
    const first = calls.length;
    await refreshLines(home, { now: () => new Date(NOW.getTime() + LINE_REFRESH_MS - 1), git });
    expect(calls.length).toBe(first);
    await refreshLines(home, { now: () => new Date(NOW.getTime() + LINE_REFRESH_MS), git });
    expect(calls.length).toBe(first * 2);
  });

  it("a live project link of a mission's request into a repo of another mission's charter is a conflict on the whole repo", () => {
    twoMissions(["repo-b"]);
    const created = createPeerLinkStore(home).createLink({
      kind: "work",
      from: { workspaceId: "repo-a", requestId: RA, agentId: "w-a", role: "worker" },
      to: { workspaceId: "repo-b", managerId: "main-b" },
      text: "Add a pay button to the website.",
    });
    expect(created.ok).toBe(true);
    const linkId = created.ok ? created.link.linkId : "";
    expect(linkConflictsOf(home)).toEqual([
      {
        type: "mission.conflict",
        missions: [A, B],
        workspaceId: "repo-b",
        area: WHOLE_REPO_AREA,
        evidence: `link ${linkId} of request ${RA} (mission PAY) asks into this repo of mission WEB's charter`,
      },
    ]);
  });

  it("the watch leaves out a conflict an arbitration settled", async () => {
    twoMissions();
    placeBoth();
    const { git } = fakeLineGit({ "/w/pay": line("m/PAY/repo-a", ["src/shared/money.ts"]), "/w/web": line("m/WEB/repo-a", ["src/shared/money.ts"]) });
    const watch = createConflictWatch({ home: () => home, now: () => NOW, log: () => {}, git });
    expect((await watch.pass()).map((event) => event.area)).toEqual(["src/shared"]);
    createArbitrationStore(home).put(arbitration());
    expect(await watch.pass()).toEqual([]);
    expect(createArbitrationStore(home).list()).toEqual([arbitration()]);
  });
});
