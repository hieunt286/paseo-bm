/**
 * Conflicts between missions and the governor's arbitrations (missions
 * design §9.6; ADR-029). Detection only: nothing here holds, moves or undoes
 * work; the governor answers a conflict with `bm_arbitrate`
 * (`governor-tools.ts`).
 *
 * **`mission.conflict { missions, workspaceId, area, evidence }`** comes from:
 *
 * - **overlaps** (`overlapConflictsOf`, the 60-second pass; delivery line
 *   design §4.7): two open missions whose ready placements of one repo (by
 *   repo key) change one file against their integration branch — `git diff
 *   --name-only origin/<target>...<branch>`, read by `line-watch.ts` at most
 *   once a minute, only for a repo two open placements share — "expect a
 *   merge conflict". An area is a file's folder (`areaOfFile`; a file at the
 *   repo's root is its own area); at most `MAX_AREAS_PER_PAIR` areas per pair
 *   and repo, the most files first;
 * - **links** (`linkConflictsOf`, the 60-second pass): a live `project` link
 *   of a mission's request into a repo of another open mission's charter that
 *   is not in its own, and a live `mission` link of kind `work` from one
 *   mission's Main to another's, once per repo both charters hold; the area
 *   is the whole repo (`.`).
 *
 * Two missions' Workers writing one file is no conflict between missions any
 * more (§4.7: each mission has its own branch): `writers.observed` stays an
 * alert inside a placement.
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
import type { MissionConflictEvent } from "./event-bus";
import { cachedLineOf, newestPlacementsOf, refreshLines } from "./line-watch";
import type { GitRunner } from "./repo-tool";
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

/**
 * The newest arbitration of the conflict's two missions, in its repo, whose
 * area covers the conflict's: the standing call `bm_arbitrate` returns
 * instead of sending (delivery line design §8.2). Null when none. Pure.
 */
export function standingArbitrationOf(event: Pick<MissionConflictEvent, "missions" | "workspaceId" | "area">, arbitrations: readonly Arbitration[]): Arbitration | null {
  const pair = new Set(event.missions);
  if (pair.size !== 2) return null;
  return arbitrations.findLast((entry) => entry.workspaceId === event.workspaceId && entry.missions.every((missionId) => pair.has(missionId)) && areaCovers(entry.area, event.area)) ?? null;
}

/** Whether an arbitration of the conflict's two missions, in its repo, settled its area already. Pure. */
export function isArbitrated(event: Pick<MissionConflictEvent, "missions" | "workspaceId" | "area">, arbitrations: readonly Arbitration[]): boolean {
  return standingArbitrationOf(event, arbitrations) !== null;
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

/**
 * Two open missions whose placements of one repo change one area against
 * their integration branch (delivery line design §4.7): "expect a merge
 * conflict". Reads the lines as `line-watch.ts` last read them; no git here.
 * Never throws.
 */
export function overlapConflictsOf(home: string): MissionConflictEvent[] {
  const open = openMissionsOf(home);
  if (open.length < 2) return [];
  const lines = open.flatMap((mission) =>
    newestPlacementsOf(mission)
      .filter((placement) => placement.state === "ready")
      .flatMap((placement) => {
        const changed = cachedLineOf(home, placement.workspaceId)?.changed ?? null;
        return changed === null || changed.length === 0 ? [] : [{ mission, placement, changed: new Set(changed) }];
      }),
  );
  const events: MissionConflictEvent[] = [];
  lines.forEach((a, index) => {
    for (const b of lines.slice(index + 1)) {
      if (a.mission.missionId === b.mission.missionId || a.placement.repo !== b.placement.repo) continue;
      const byArea = new Map<string, Set<string>>();
      for (const file of a.changed) if (b.changed.has(file)) byArea.set(areaOfFile(file), (byArea.get(areaOfFile(file)) ?? new Set()).add(file));
      const target = a.placement.target === b.placement.target ? `origin/${a.placement.target}` : `origin/${a.placement.target} and origin/${b.placement.target}`;
      const areas = [...byArea.keys()].sort((x, y) => byArea.get(y)!.size - byArea.get(x)!.size || x.localeCompare(y)).slice(0, MAX_AREAS_PER_PAIR);
      for (const area of areas) {
        events.push({
          type: "mission.conflict",
          missions: [a.mission.missionId, b.mission.missionId],
          workspaceId: a.placement.repo,
          area,
          evidence: `expect a merge conflict: ${a.mission.code} (${a.placement.branch}) and ${b.mission.code} (${b.placement.branch}) both change ${area} against ${target}: ${sample(byArea.get(area)!)}`,
        });
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
  /** How the lines' read-only git runs; `runGit` by default. */
  git?: GitRunner;
}

export interface ConflictWatch {
  /** The overlap and link conflicts now, those not arbitrated (the 60-second pass, after the governor's: its lines are read). Never throws. */
  pass(): Promise<MissionConflictEvent[]>;
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
    async pass() {
      const home = homeOf();
      // Delivery line design §4.7: a line the governor's pass read this minute is not read again.
      if (home !== null) await refreshLines(home, { now, log, ...(deps.git === undefined ? {} : { git: deps.git }) });
      return unsettled((home) => [...overlapConflictsOf(home), ...linkConflictsOf(home)]);
    },
  };
}
