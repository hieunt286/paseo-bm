/**
 * Conflicts between missions and the governor's arbitrations (missions
 * design §9.6; ADR-029). Detection only: nothing here holds, moves or undoes
 * work; the governor answers a conflict with `bm_arbitrate`
 * (`governor-tools.ts`).
 *
 * **`mission.conflict { missions, workspaceId, area, evidence }`** comes from:
 *
 * - **charters** (`charterConflictsOf`, the 60-second pass): two open
 *   missions whose charters hold one repo and whose requests wrote files of
 *   one area there in the last `CONFLICT_WINDOW_MS` (trace `file` evidence).
 *   An area is a file's folder (`areaOfFile`; a file at the repo's root is its
 *   own area); at most `MAX_AREAS_PER_PAIR` areas per pair and repo, the most
 *   written first;
 * - **writers** (`writerConflictsOf`, each recorded turn): a
 *   `writers.observed` collision (`writers-watch.ts`) whose two writers
 *   belong to two open missions (their requests in the request index, else
 *   the mission whose Main wrote); the area is the file;
 * - **links** (`linkConflictsOf`, the 60-second pass): a live `project` link
 *   of a mission's request into a repo of another open mission's charter that
 *   is not in its own, and a live `mission` link of kind `work` from one
 *   mission's Main to another's, once per repo both charters hold; the area
 *   is the whole repo (`.`).
 *
 * A conflict an arbitration of the same two missions already settled — the
 * same repo, its area covering the conflict's (`areaCovers`) — is not raised
 * again. The event bus publishes each key once per run.
 *
 * **Arbitrations** (`<data folder>/orchestrator/arbitrations.json` =
 * `{ version: 1, entries }`): each call of `bm_arbitrate`, newest last, at most
 * `MAX_ARBITRATIONS` kept. The file rules are every store's (`data-files.ts`).
 * Nothing here throws into the plugin: a failure is one log line and no event.
 */
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { timeOrZero } from "../shared/time";
import { writtenFilesOf } from "../shared/writers-observed";
import { createJsonFileStore, entriesOf } from "./data-files";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import type { BmEvent, MissionConflictEvent, WritersObservedEvent } from "./event-bus";
import { createMissionRoster, requestIndexOf } from "./mission-roster";
import { createMissionStore, type Mission } from "./mission-store";
import { ORCHESTRATOR_DIR_NAME } from "./orchestrator-store";
import { createPeerLinkStore, isLiveLink, routeOf } from "./peer-links";
import { errorText } from "./rpc-kit";
import { readRecords, readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";

export const ARBITRATIONS_FILE = "arbitrations.json";
export const ARBITRATIONS_VERSION = 1;
export const MAX_ARBITRATIONS = 500;
/** How far back the charters' file areas are read (§9.6: the last 7 days). */
export const CONFLICT_WINDOW_MS = 7 * 86_400_000;
/** The most areas one pair of missions raises in one repo. */
export const MAX_AREAS_PER_PAIR = 3;
/** The area of a whole repo. */
export const WHOLE_REPO_AREA = ".";
export const ARBITRATION_ID_PATTERN = /^arb-[0-9a-f]{10}$/;

const arbitrationSchema = z.object({
  id: z.string().regex(ARBITRATION_ID_PATTERN),
  at: z.string(),
  /** The two missions, as the call named them. */
  missions: z.tuple([z.string(), z.string()]),
  workspaceId: z.string().min(1),
  area: z.string().min(1),
  /** The mission the area belongs to now. */
  owner: z.string(),
  reason: z.string(),
  /** The `governor:arbitrate` commands sent, one per Main told. */
  commandIds: z.array(z.string()),
  /** The `m:` card of the losing mission when the call changes its goal; else null. */
  decisionId: z.string().nullable(),
});
export type Arbitration = z.infer<typeof arbitrationSchema>;

export interface ArbitrationStore {
  readonly path: string;
  /** Every arbitration, oldest first. Never throws. */
  list(): Arbitration[];
  get(id: string): Arbitration | null;
  /** Adds or replaces the arbitration of that id. Throws when the file cannot be written. */
  put(entry: Arbitration): void;
}

export function newArbitrationId(): string {
  return `arb-${randomBytes(5).toString("hex")}`;
}

/** The arbitrations of the data folder `home`. Creating it touches nothing on disk. */
export function createArbitrationStore(home: string): ArbitrationStore {
  const file = createJsonFileStore<{ entries: Arbitration[] }>({
    home,
    dir: ORCHESTRATOR_DIR_NAME,
    file: ARBITRATIONS_FILE,
    version: ARBITRATIONS_VERSION,
    parse: (body) => ({ entries: entriesOf(arbitrationSchema, body["entries"]) }),
    empty: () => ({ entries: [] }),
    cap: ({ entries }) => ({ entries: entries.slice(-MAX_ARBITRATIONS) }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });
  const list = (): Arbitration[] => {
    try {
      return file.read().entries;
    } catch {
      return [];
    }
  };
  return {
    path: file.path,
    list,
    get: (id) => list().find((entry) => entry.id === id) ?? null,
    put(entry) {
      const valid = arbitrationSchema.parse(entry);
      file.update((current) => ({ entries: [...current.entries.filter((known) => known.id !== valid.id), valid] }));
    },
  };
}

// ---------------------------------------------------------------------------
// Areas (pure).
// ---------------------------------------------------------------------------

/** An area as written: no leading `./`, no trailing `/`, `/*` or `/**`; the whole repo is `.`. Pure. */
export function normalArea(area: string): string {
  const trimmed = area.trim().replace(/^\.\//, "").replace(/(\/\*\*|\/\*|\/)+$/, "");
  return trimmed === "" || trimmed === "*" || trimmed === "**" ? WHOLE_REPO_AREA : trimmed;
}

/** A file's area: its folder, or the file itself at the repo's root. Pure. */
export function areaOfFile(file: string): string {
  const folder = dirname(file);
  return folder === "." || folder === "" ? file : folder;
}

/** True when `owned` covers `area`: the same, a folder of it, or the whole repo. Pure. */
export function areaCovers(owned: string, area: string): boolean {
  const [a, b] = [normalArea(owned), normalArea(area)];
  return a === WHOLE_REPO_AREA || a === b || b.startsWith(`${a}/`);
}

/** True when two areas overlap: one covers the other. Pure. */
export function areasOverlap(a: string, b: string): boolean {
  return areaCovers(a, b) || areaCovers(b, a);
}

/** Whether an arbitration of the conflict's two missions, in its repo, settled its area already. Pure. */
export function isArbitrated(event: Pick<MissionConflictEvent, "missions" | "workspaceId" | "area">, arbitrations: readonly Arbitration[]): boolean {
  const pair = new Set(event.missions);
  if (pair.size !== 2) return false;
  return arbitrations.some((entry) => entry.workspaceId === event.workspaceId && entry.missions.every((missionId) => pair.has(missionId)) && areaCovers(entry.area, event.area));
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------

/** The files one mission's requests wrote since `since`, per repo and area. Never throws: an unreadable repo counts as none. */
export function missionAreasOf(home: string, mission: Pick<Mission, "missionId">, since: number, requestIds?: ReadonlySet<string>): Map<string, Map<string, Set<string>>> {
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };
  const roster = createMissionRoster(home)
    .list(mission.missionId)
    .filter((entry) => requestIds === undefined || requestIds.has(entry.requestId));
  const areas = new Map<string, Map<string, Set<string>>>();
  for (const workspaceId of new Set(roster.map((entry) => entry.workspaceId))) {
    const own = roster.filter((entry) => entry.workspaceId === workspaceId);
    const ids = new Set(own.map((entry) => entry.requestId));
    const workers = new Set(own.flatMap((entry) => entry.workerIds));
    try {
      const directory = readWorkspaceMeta(location, workspaceId)?.lastKnownDirectory ?? null;
      for (const record of readRecords(location, workspaceId).records) {
        if (timeOrZero(record.endedAt) < since) continue;
        if (!((record.requestId !== null && ids.has(record.requestId)) || workers.has(record.agentId))) continue;
        for (const file of writtenFilesOf(record, directory)) {
          const byArea = areas.get(workspaceId) ?? new Map<string, Set<string>>();
          areas.set(workspaceId, byArea);
          const area = areaOfFile(file);
          byArea.set(area, (byArea.get(area) ?? new Set()).add(file));
        }
      }
    } catch {
      // An unreadable repo: no area there.
    }
  }
  return areas;
}

/** Every open mission. Never throws. */
export function openMissionsOf(home: string): Mission[] {
  const store = createMissionStore(home);
  return store
    .list()
    .filter((entry) => entry.state === "open")
    .flatMap((entry) => store.get(entry.missionId) ?? []);
}

const sample = (files: ReadonlySet<string>): string => `${files.size} file${files.size === 1 ? "" : "s"}, e.g. ${[...files].sort()[0] ?? ""}`;

/** Two open charters with one repo and one area written in the last 7 days (§9.6). Never throws. */
export function charterConflictsOf(home: string, now: Date): MissionConflictEvent[] {
  const open = openMissionsOf(home);
  // Only a mission whose charter shares a repo with another open one can conflict: the others' traces are not read.
  const sharing = open.filter((mission) => open.some((other) => other !== mission && other.charter.repos.some((repo) => mission.charter.repos.includes(repo))));
  if (sharing.length < 2) return [];
  const since = now.getTime() - CONFLICT_WINDOW_MS;
  const areas = new Map(sharing.map((mission) => [mission.missionId, missionAreasOf(home, mission, since)]));
  const events: MissionConflictEvent[] = [];
  sharing.forEach((a, index) => {
    for (const b of sharing.slice(index + 1)) {
      for (const workspaceId of a.charter.repos.filter((repo) => b.charter.repos.includes(repo))) {
        const ofA = areas.get(a.missionId)?.get(workspaceId);
        const ofB = areas.get(b.missionId)?.get(workspaceId);
        if (ofA === undefined || ofB === undefined) continue;
        const shared = [...ofA.keys()]
          .filter((area) => ofB.has(area))
          .sort((x, y) => ofA.get(y)!.size + ofB.get(y)!.size - (ofA.get(x)!.size + ofB.get(x)!.size) || x.localeCompare(y))
          .slice(0, MAX_AREAS_PER_PAIR);
        for (const area of shared) {
          events.push({
            type: "mission.conflict",
            missions: [a.missionId, b.missionId],
            workspaceId,
            area,
            evidence: `both charters hold this repo and both missions wrote ${area} in the last 7 days: ${a.code} ${sample(ofA.get(area)!)}; ${b.code} ${sample(ofB.get(area)!)}`,
          });
        }
      }
    }
  });
  return events;
}

/** The open mission an agent's write belongs to: its request's, else the one whose Main it is. */
function missionOfWriter(home: string, open: readonly Mission[], writer: { agentId: string; requestId: string | null }): Mission | null {
  const place = writer.requestId === null ? null : requestIndexOf(home, writer.requestId);
  if (place !== null) return open.find((mission) => mission.missionId === place.missionId) ?? null;
  return open.find((mission) => mission.mainId === writer.agentId) ?? null;
}

/** The `writers.observed` collisions among `events` between two open missions (§9.6). Never throws. */
export function writerConflictsOf(home: string, events: readonly BmEvent[]): MissionConflictEvent[] {
  const collisions = events.filter((event): event is WritersObservedEvent => event.type === "writers.observed");
  if (collisions.length === 0) return [];
  const open = openMissionsOf(home);
  if (open.length < 2) return [];
  return collisions.flatMap((event): MissionConflictEvent[] => {
    const [a, b] = event.writers.map((writer) => missionOfWriter(home, open, writer));
    if (a === null || b === null || a === undefined || b === undefined || a.missionId === b.missionId) return [];
    const [first, second] = event.writers;
    return [
      {
        type: "mission.conflict",
        missions: [a.missionId, b.missionId],
        workspaceId: event.workspaceId,
        area: event.file,
        evidence: `${first.agentId} (request ${first.requestId ?? "not known"}, mission ${a.code}) and ${second.agentId} (request ${second.requestId ?? "not known"}, mission ${b.code}) wrote it in overlapping turns, at ${event.at}`,
      },
    ];
  });
}

/** Live links from one mission into another's area (§9.6). Never throws. */
export function linkConflictsOf(home: string): MissionConflictEvent[] {
  const open = openMissionsOf(home);
  if (open.length < 2) return [];
  const events: MissionConflictEvent[] = [];
  for (const link of createPeerLinkStore(home).list().filter(isLiveLink)) {
    const route = routeOf(link);
    if (route === "project") {
      const from = missionOfWriter(home, open, { agentId: "", requestId: link.from.requestId });
      if (from === null || from.charter.repos.includes(link.to.workspaceId)) continue;
      for (const other of open.filter((mission) => mission.missionId !== from.missionId && mission.charter.repos.includes(link.to.workspaceId))) {
        events.push({
          type: "mission.conflict",
          missions: [from.missionId, other.missionId],
          workspaceId: link.to.workspaceId,
          area: WHOLE_REPO_AREA,
          evidence: `link ${link.linkId} of request ${link.from.requestId ?? "none"} (mission ${from.code}) asks into this repo of mission ${other.code}'s charter`,
        });
      }
    } else if (route === "mission" && link.kind === "work") {
      const from = open.find((mission) => mission.mainId === link.from.agentId || mission.mainHistory.some((entry) => entry.agentId === link.from.agentId));
      const to = open.find((mission) => mission.missionId === link.missionId);
      if (from === undefined || to === undefined || from.missionId === to.missionId) continue;
      for (const workspaceId of from.charter.repos.filter((repo) => to.charter.repos.includes(repo))) {
        events.push({
          type: "mission.conflict",
          missions: [from.missionId, to.missionId],
          workspaceId,
          area: WHOLE_REPO_AREA,
          evidence: `link ${link.linkId}: the Main of mission ${from.code} gave mission ${to.code} work in a repo both charters hold`,
        });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// The watch the plugin runs.
// ---------------------------------------------------------------------------

export interface ConflictWatchDeps extends DataHomeDeps {
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ConflictWatch {
  /** The charter and link conflicts now, those not arbitrated (the 60-second pass). Never throws. */
  pass(): MissionConflictEvent[];
  /** The conflicts the turn's `writers.observed` events show, those not arbitrated. Never throws. */
  writersCollided(events: readonly BmEvent[]): MissionConflictEvent[];
}

export function createConflictWatch(deps: ConflictWatchDeps = {}): ConflictWatch {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const homeOf =
    deps.home ??
    (() => {
      try {
        return resolveDataHome(deps).home;
      } catch {
        return null;
      }
    });
  const unsettled = (read: (home: string) => MissionConflictEvent[]): MissionConflictEvent[] => {
    const home = homeOf();
    if (home === null) return [];
    try {
      const found = read(home);
      if (found.length === 0) return [];
      const arbitrations = createArbitrationStore(home).list();
      return found.filter((event) => !isArbitrated(event, arbitrations));
    } catch (error) {
      log(`[paseo-bm] the conflicts between missions could not be read: ${errorText(error)}`);
      return [];
    }
  };
  return {
    pass: () => unsettled((home) => [...charterConflictsOf(home, now()), ...linkConflictsOf(home)]),
    writersCollided: (events) => (events.some((event) => event.type === "writers.observed") ? unsettled((home) => writerConflictsOf(home, events)) : []),
  };
}
