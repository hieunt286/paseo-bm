import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearJsonFileCache } from "../plugin/server/data-files";
import type { WritersObservedEvent } from "../plugin/server/event-bus";
import {
  WHOLE_REPO_AREA,
  areaCovers,
  areaOfFile,
  charterConflictsOf,
  createArbitrationStore,
  createConflictWatch,
  isArbitrated,
  linkConflictsOf,
  normalArea,
  writerConflictsOf,
  type Arbitration,
} from "../plugin/server/governor-conflicts";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { TraceRecord } from "../plugin/shared/contracts";
import { file, turn } from "./fixtures/orchestrator-traces";

/**
 * Conflict detection between missions (missions design §9.6, WP-204): two
 * charters on one area, a writer collision between two missions' Workers, a
 * link from one mission into another's repo — and the arbitrations that
 * settle them — on a temporary data folder.
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
});
afterEach(() => {
  clearRequestIndexCache();
  clearTraceStoreCache();
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
  it("two open charters with one repo and one area written in the last 7 days are a mission.conflict, once per area", async () => {
    twoMissions();
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, wrote("w-a", RA, ["src/shared/money.ts", "src/pay/card.ts"], 5));
    await appendRecord(location, wrote("w-b", RB, ["src/shared/format.ts", "src/web/page.ts"], 30));
    // Older than 7 days: not an area of the mission now.
    await appendRecord(location, wrote("w-b", RB, ["src/pay/old.ts"], 24 * 8));

    expect(charterConflictsOf(home, NOW)).toEqual([
      {
        type: "mission.conflict",
        missions: [A, B],
        workspaceId: "repo-a",
        area: "src/shared",
        evidence: "both charters hold this repo and both missions wrote src/shared in the last 7 days: PAY 1 file, e.g. src/shared/money.ts; WEB 1 file, e.g. src/shared/format.ts",
      },
    ]);
  });

  it("charters on two repos, or one mission closed, raise nothing", async () => {
    twoMissions(["repo-b"]);
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, wrote("w-a", RA, ["src/shared/money.ts"], 5));
    expect(charterConflictsOf(home, NOW)).toEqual([]);
  });

  it("a writers.observed collision between Workers of two missions is a conflict on that file; one of one mission is not", () => {
    twoMissions();
    const collision = (requestIds: [string, string]): WritersObservedEvent => ({
      type: "writers.observed",
      workspaceId: "repo-a",
      file: "src/shared/money.ts",
      writers: [
        { agentId: "w-a", role: "worker", requestId: requestIds[0], startedAt: hoursAgo(2) },
        { agentId: "w-b", role: "worker", requestId: requestIds[1], startedAt: hoursAgo(1) },
      ],
      alertKey: "writers-observed:repo-a:src/shared/money.ts",
      at: hoursAgo(1),
    });
    expect(writerConflictsOf(home, [collision([RA, RB])])).toEqual([
      {
        type: "mission.conflict",
        missions: [A, B],
        workspaceId: "repo-a",
        area: "src/shared/money.ts",
        evidence: `w-a (request ${RA}, mission PAY) and w-b (request ${RB}, mission WEB) wrote it in overlapping turns, at ${hoursAgo(1)}`,
      },
    ]);
    expect(writerConflictsOf(home, [collision([RA, RA])])).toEqual([]);
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

  it("the watch leaves out a conflict an arbitration settled, and a writer conflict too", async () => {
    twoMissions();
    const location = { tracesDir: join(home, "traces") };
    await appendRecord(location, wrote("w-a", RA, ["src/shared/money.ts"], 5));
    await appendRecord(location, wrote("w-b", RB, ["src/shared/format.ts"], 3));
    const watch = createConflictWatch({ home: () => home, now: () => NOW, log: () => {} });
    expect(watch.pass().map((event) => event.area)).toEqual(["src/shared"]);
    createArbitrationStore(home).put(arbitration());
    expect(watch.pass()).toEqual([]);
    expect(createArbitrationStore(home).list()).toEqual([arbitration()]);
    expect(watch.writersCollided([])).toEqual([]);
  });
});
