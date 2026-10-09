import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MISSION_LEVEL,
  MISSION_AUTONOMY_FILE_NAME,
  MISSION_CLASSES,
  MISSION_LEVEL_CLASSES,
  cellsOfLevel,
  createMissionAutonomyStore,
  levelOfCells,
} from "../plugin/server/mission-autonomy-store";
import { MISSIONS_DIR_NAME } from "../plugin/server/mission-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/** The mission level (missions design §2.4). Temporary data folders only. */

const M1 = "mis-0000000001";
const T0 = new Date("2026-10-09T10:00:00.000Z");

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

describe("the levels table (§2.4)", () => {
  it("delegates by level as the design's table says", () => {
    expect(MISSION_CLASSES).toEqual(["proceed", "staffing", "scope-repo", "answer-technical", "answer-effects", "split"]);
    expect(MISSION_LEVEL_CLASSES).toEqual({
      0: [],
      1: ["proceed"],
      2: ["proceed", "staffing"],
      3: ["proceed", "staffing", "answer-technical"],
      4: ["proceed", "staffing", "answer-technical", "answer-effects", "scope-repo", "split"],
    });
    expect(DEFAULT_MISSION_LEVEL).toBe(2);
  });

  it("reads the level as the highest whose cells all delegate", () => {
    for (const level of [0, 1, 2, 3, 4] as const) expect(levelOfCells(cellsOfLevel(level, ""))).toBe(level);
    const cells = cellsOfLevel(1, "");
    expect(levelOfCells({ ...cells, "answer-technical": { mode: "delegate", at: "" } })).toBe(1);
    expect(levelOfCells({ ...cells, proceed: { mode: "owner", at: "" }, staffing: { mode: "delegate", at: "" } })).toBe(0);
  });
});

describe("the store", () => {
  it("reads a mission never set at level 2 and creates nothing", () => {
    const home = dataFolder();
    const store = createMissionAutonomyStore(home);
    expect(store.get(M1)).toEqual({ level: 2, cells: cellsOfLevel(2, "") });
    expect(store.isDelegated(M1, "staffing")).toBe(true);
    expect(store.isDelegated(M1, "scope-repo")).toBe(false);
  });

  it("sets a level, then one cell, the level following the cells", () => {
    const home = dataFolder();
    const store = createMissionAutonomyStore(home, { now: () => T0 });
    expect(store.setLevel(M1, 3).level).toBe(3);
    expect(store.get(M1).cells["answer-technical"]).toEqual({ mode: "delegate", at: T0.toISOString() });
    expect(store.setCell(M1, "staffing", "owner").level).toBe(1);
    expect(store.setCell(M1, "staffing", "delegate").level).toBe(3);
    const path = join(home, MISSIONS_DIR_NAME, MISSION_AUTONOMY_FILE_NAME);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion: number; missions: Record<string, { level: number }> };
    expect(body.schemaVersion).toBe(1);
    expect(body.missions[M1]?.level).toBe(3);
    expect(() => store.setLevel("wks_a", 1)).toThrow();
  });

  it("skips a malformed mission on its own and never overwrites a file that cannot be used", () => {
    const home = dataFolder();
    const store = createMissionAutonomyStore(home, { now: () => T0 });
    store.setLevel(M1, 4);
    const path = join(home, MISSIONS_DIR_NAME, MISSION_AUTONOMY_FILE_NAME);
    const body = JSON.parse(readFileSync(path, "utf8")) as { missions: Record<string, unknown> };
    writeFileSync(path, JSON.stringify({ ...body, missions: { ...body.missions, "mis-0000000002": { level: 9 } } }));
    clearJsonFileCache();
    expect(store.get(M1).level).toBe(4);
    expect(store.get("mis-0000000002").level).toBe(2);
    writeFileSync(path, "{ broken");
    expect(store.get(M1).level).toBe(2);
    expect(() => store.setLevel(M1, 1)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });
});
