/**
 * The mission level (missions design §2.4, §8; ADR-029): what a mission's
 * Main may do on its own, beside the repo level of ADR-025.
 *
 * `<data folder>/missions/autonomy.json` =
 * `{ schemaVersion: 1, missions: { <missionId>: { level, cells: { <class>: { mode, at } } } } }`.
 * A mission with no entry is at `DEFAULT_MISSION_LEVEL` (2: `proceed` and
 * `staffing` delegated). Cells can be set one by one; the level is the
 * highest whose cells all delegate (`levelOfCells`).
 *
 * A `createJsonFileStore` file (`0700` folder, `0600`, atomic, no symlink, a
 * newer `schemaVersion` read as empty and never written), never overwritten
 * when it cannot be used; each mission's entry is read on its own. Readers
 * never throw.
 */
import { createJsonFileStore, keyedEntriesOf } from "./data-files";
import { MISSIONS_DIR_NAME, MISSIONS_VERSION, MISSION_ID_PATTERN } from "./mission-store";
import {
  DEFAULT_MISSION_LEVEL,
  MISSION_CLASSES,
  MISSION_LEVELS,
  MISSION_LEVEL_CLASSES,
  missionAutonomySchema as entrySchema,
  type MissionAutonomy,
  type MissionCell,
  type MissionClass,
  type MissionLevel,
} from "../shared/autonomy";

// The vocabulary lives in `shared/autonomy.ts`, so the RPC contracts and the client read it too.
export { DEFAULT_MISSION_LEVEL, MISSION_CLASSES, MISSION_LEVELS, MISSION_LEVEL_CLASSES, type MissionAutonomy, type MissionCell, type MissionClass, type MissionLevel };

export const MISSION_AUTONOMY_FILE_NAME = "autonomy.json";

/** The cells of `level`, each set `at` (`""` for the default of a mission never set). Pure. */
export function cellsOfLevel(level: MissionLevel, at: string): MissionAutonomy["cells"] {
  const delegated = new Set(MISSION_LEVEL_CLASSES[level]);
  return Object.fromEntries(MISSION_CLASSES.map((name) => [name, { mode: delegated.has(name) ? "delegate" : "owner", at }])) as MissionAutonomy["cells"];
}

/** The highest level whose classes all delegate in `cells`. Pure. */
export function levelOfCells(cells: MissionAutonomy["cells"]): MissionLevel {
  return [...MISSION_LEVELS].reverse().find((level) => MISSION_LEVEL_CLASSES[level].every((name) => cells[name].mode === "delegate")) ?? 0;
}

export interface MissionAutonomyStore {
  /** The mission's level and cells; the default level's for a mission never set. Never throws. */
  get(missionId: string): MissionAutonomy;
  /** True when the mission's cell for `name` delegates. Never throws. */
  isDelegated(missionId: string, name: MissionClass): boolean;
  /** Sets every cell to `level`'s. Throws when the file cannot be written. */
  setLevel(missionId: string, level: MissionLevel): MissionAutonomy;
  /** Sets one cell; the level follows the cells. Throws when the file cannot be written. */
  setCell(missionId: string, name: MissionClass, mode: MissionCell["mode"]): MissionAutonomy;
}

/** The mission level store of the data folder `home`. Creating it touches nothing on disk. */
export function createMissionAutonomyStore(home: string, deps: { now?: () => Date } = {}): MissionAutonomyStore {
  const now = deps.now ?? (() => new Date());
  const file = createJsonFileStore<{ missions: Record<string, MissionAutonomy> }>({
    home,
    dir: MISSIONS_DIR_NAME,
    file: MISSION_AUTONOMY_FILE_NAME,
    version: MISSIONS_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ missions: keyedEntriesOf(entrySchema, body["missions"], (missionId) => MISSION_ID_PATTERN.test(missionId)) }),
    empty: () => ({ missions: {} }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
    // The owner's choices: a file that cannot be read is fixed or deleted by hand, never replaced.
    keepUnusable: true,
    cached: true,
  });

  const defaults = (): MissionAutonomy => ({ level: DEFAULT_MISSION_LEVEL, cells: cellsOfLevel(DEFAULT_MISSION_LEVEL, "") });

  const get = (missionId: string): MissionAutonomy => {
    try {
      return file.read().missions[missionId] ?? defaults();
    } catch {
      return defaults();
    }
  };

  const set = (missionId: string, change: (current: MissionAutonomy, at: string) => MissionAutonomy["cells"]): MissionAutonomy => {
    if (!MISSION_ID_PATTERN.test(missionId)) throw new Error(`not a mission id: ${JSON.stringify(missionId)}`);
    let next = defaults();
    file.update((current) => {
      const cells = change(current.missions[missionId] ?? defaults(), now().toISOString());
      next = { level: levelOfCells(cells), cells };
      return { missions: { ...current.missions, [missionId]: next } };
    });
    return next;
  };

  return {
    get,
    isDelegated: (missionId, name) => get(missionId).cells[name].mode === "delegate",
    setLevel: (missionId, level) => set(missionId, (_, at) => cellsOfLevel(level, at)),
    setCell: (missionId, name, mode) => set(missionId, (current, at) => ({ ...current.cells, [name]: { mode, at } })),
  };
}
