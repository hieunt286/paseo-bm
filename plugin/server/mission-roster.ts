/**
 * The mission roster and the request index (missions design §2.3, ADR-029).
 *
 * `<data folder>/missions/<missionId>.roster.json` lists the requests of a
 * mission, each with the repo (workspace) it lives in — the only source of
 * mission membership: the `missionId` a registry entry or a binding carries
 * is a cache, and every reader falls back to the index when it is missing.
 *
 * **The request index.** `requestIndexOf(home, requestId)` →
 * `{ missionId, workspaceId }`, built in memory from every roster and kept
 * while no roster file changes (mtime, size, inode), is how every Main-side
 * lookup finds a request's repo. `request-registry.ts` `generate` reads its
 * ids, so no two repos get the same request id.
 *
 * A `createJsonFileStore` file (`0700` folder, `0600`, atomic, no symlink, a
 * newer `schemaVersion` read as empty and never written), never overwritten
 * when it cannot be used. Topics are masked with `redactText`. Readers never
 * throw.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { redactText } from "./collector";
import { assertNoSymlink, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { MISSIONS_DIR_NAME, MISSIONS_VERSION, MISSION_ID_PATTERN, createMissionStore, journalQuietly } from "./mission-store";
import { bmAgentsOf, type DashboardPaseo } from "./paseo-directory";
import { REQUEST_ID_PATTERN, createRequestRegistry } from "./request-registry";
import { errorText } from "./rpc-kit";

/** The longest topic: the Main's one-line label of a request. */
export const MAX_ROSTER_TOPIC = 120;
export const ROSTER_STATES = ["active", "finished", "stopped"] as const;
export type RosterState = (typeof ROSTER_STATES)[number];

const rosterEntrySchema = z.object({
  // Read when an entry is parsed, not when this module loads: `request-registry.ts` imports this module.
  requestId: z.string().refine((id) => REQUEST_ID_PATTERN.test(id), "not a request id"),
  workspaceId: z.string().min(1),
  createdAt: z.string(),
  workerIds: z.array(z.string().min(1)),
  topic: z.string(),
  state: z.enum(ROSTER_STATES),
  /** The newest follow-up the Main told the request's Worker (`bm_tell_worker`, mission runtime design §2.3); absent when none. */
  followUpAt: z.string().optional(),
});

export type RosterEntry = z.infer<typeof rosterEntrySchema>;

/** Where a request lives: its mission and its repo. */
export interface RequestPlace {
  missionId: string;
  workspaceId: string;
}

const ROSTER_FILE = /^(mis-[0-9a-f]{10})\.roster\.json$/;
const UNWRITABLE = "E_TRACE_STORE_UNWRITABLE" as const;

function rosterFile(home: string, missionId: string): JsonFileStore<{ requests: RosterEntry[] }> {
  if (!MISSION_ID_PATTERN.test(missionId)) throw new Error(`not a mission id: ${JSON.stringify(missionId)}`);
  return createJsonFileStore<{ requests: RosterEntry[] }>({
    home,
    dir: MISSIONS_DIR_NAME,
    file: `${missionId}.roster.json`,
    version: MISSIONS_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ requests: entriesOf(rosterEntrySchema, body["requests"]) }),
    empty: () => ({ requests: [] }),
    codes: { unwritable: UNWRITABLE },
    keepUnusable: true,
    cached: true,
  });
}

/** The built index of one data folder, and the roster files it was built from. */
const indexCache = new Map<string, { key: string; index: Map<string, RequestPlace> }>();

/** Drops the built request indexes; tests only (`clearJsonFileCache` drops the rosters). */
export function clearRequestIndexCache(): void {
  indexCache.clear();
}

/**
 * Every request of every roster → its place, the first roster (by mission id)
 * winning a request two hold. Rebuilt when a roster file appears, goes or
 * changes. Never throws: none for a folder that cannot be read.
 */
export function requestIndex(home: string): ReadonlyMap<string, RequestPlace> {
  const dir = join(home, MISSIONS_DIR_NAME);
  let rosters: Array<{ missionId: string; key: string }>;
  try {
    assertNoSymlink(home, dir, UNWRITABLE);
    rosters = readdirSync(dir)
      .flatMap((name) => {
        const match = ROSTER_FILE.exec(name);
        if (match === null) return [];
        const stat = lstatSync(join(dir, name));
        return [{ missionId: match[1]!, key: `${name}:${stat.mtimeMs}:${stat.size}:${stat.ino}` }];
      })
      .sort((a, b) => a.missionId.localeCompare(b.missionId));
  } catch {
    return new Map();
  }
  const key = rosters.map((roster) => roster.key).join("|");
  const kept = indexCache.get(home);
  if (kept !== undefined && kept.key === key) return kept.index;
  const index = new Map<string, RequestPlace>();
  for (const { missionId } of rosters) {
    let requests: RosterEntry[];
    try {
      requests = rosterFile(home, missionId).read().requests;
    } catch {
      continue;
    }
    for (const request of requests) {
      if (!index.has(request.requestId)) index.set(request.requestId, { missionId, workspaceId: request.workspaceId });
    }
  }
  indexCache.set(home, { key, index });
  return index;
}

/** Where `requestId` lives, from the rosters, or null for a request of no mission. Never throws. */
export function requestIndexOf(home: string, requestId: string): RequestPlace | null {
  return requestIndex(home).get(requestId) ?? null;
}

/**
 * The current Main of a request of a mission (§3.4 step 4): the registry's
 * `managerId` in the request's repo. Null for a request of no mission, or one
 * with no Manager, where a reader falls back to the `paseo.parent-agent-id`
 * label as before. Never throws.
 */
export function missionManagerOf(home: string | null, requestId: string | null): string | null {
  if (home === null || requestId === null) return null;
  try {
    const place = requestIndexOf(home, requestId);
    return place === null ? null : (createRequestRegistry(home, { log: () => {} }).get(place.workspaceId, requestId)?.managerId ?? null);
  } catch {
    return null;
  }
}

/**
 * A Worker's report of `requestId` sets its roster state (missions design
 * §2.3): `finished` or `stopped` as the report says, `active` again for any
 * other phase (a follow-up through `bm_tell_worker` reopened the work). A
 * request of no mission is left alone. Called by `bm_report` and the unbound
 * relay. Never throws: a failure is one log line.
 */
export function noteRosterReport(home: string, requestId: string, phase: string, log: (message: string) => void = () => {}, reportText?: string): void {
  try {
    const place = requestIndexOf(home, requestId);
    if (place === null) return;
    const state: RosterState = phase === "finished" || phase === "stopped" ? phase : "active";
    createMissionRoster(home).setState(place.missionId, requestId, state);
    // Mission runtime design §2.3: the phases that change what the mission waits on are its history.
    if (reportText !== undefined && (phase === "blocked" || phase === "finished" || phase === "stopped")) {
      const summary = reportSummaryOf(reportText);
      journalQuietly(createMissionStore(home), place.missionId, { kind: "worker", by: "plugin", text: `${requestId} ${phase}${summary === "" ? "" : `: ${summary}`}`, ref: requestId }, log);
    }
  } catch (error) {
    log(`[paseo-bm] could not note the ${phase} report of request ${requestId} in its mission's roster: ${errorText(error)}`);
  }
}

/** A report's one-line summary for the journal: the text after "—" on its `tier:` line, else its `blockers:` line; at most 160 characters. Pure. */
export function reportSummaryOf(text: string): string {
  const field = (key: string) => new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
  const tier = field("tier");
  const dash = tier === null ? -1 : tier.indexOf("—");
  const blockers = field("blockers");
  const line = tier !== null && dash >= 0 ? tier.slice(dash + 1).trim() : blockers !== null && !/^none\b/i.test(blockers) ? blockers : "";
  const flat = redactText(line).replace(/\s+/g, " ").trim();
  return flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`;
}

/**
 * The Main told a request's Worker more work (`bm_tell_worker`, mission
 * runtime design §2.3): the roster entry is `active` again with `followUpAt`,
 * and the journal gets "Follow-up to <request>: <first line>". A request of no
 * mission is left alone. Never throws: a failure is one log line.
 */
export function noteFollowUp(home: string, requestId: string, text: string, at: string, log: (message: string) => void = () => {}): void {
  try {
    const place = requestIndexOf(home, requestId);
    if (place === null) return;
    createMissionRoster(home).noteFollowUp(place.missionId, requestId, at);
    const first = redactText(text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/\s+/g, " ").trim();
    journalQuietly(createMissionStore(home), place.missionId, { kind: "worker", by: "main", text: `Follow-up to ${requestId}: ${first.length <= 160 ? first : `${first.slice(0, 159)}…`}`, ref: requestId }, log);
  } catch (error) {
    log(`[paseo-bm] could not note the follow-up of request ${requestId} in its mission: ${errorText(error)}`);
  }
}

/**
 * The mission's requests whose Worker still runs (missions design §4): `active`
 * in the roster, not finished in the registry, with an unarchived Worker
 * Paseo lists. None without an active request (Paseo is not read then); none
 * live when Paseo cannot be read.
 */
export async function runningRequestsOf(home: string, paseo: unknown, missionId: string): Promise<RosterEntry[]> {
  const active = createMissionRoster(home).list(missionId).filter((entry) => entry.state === "active");
  if (active.length === 0) return [];
  const registry = createRequestRegistry(home);
  const live = new Set((await bmAgentsOf(paseo as DashboardPaseo, { home })).filter(({ facts }) => facts.role === "worker" && !facts.archived).map(({ facts }) => facts.id));
  return active.filter((entry) => (registry.get(entry.workspaceId, entry.requestId)?.finishedAt ?? null) === null && entry.workerIds.some((id) => live.has(id)));
}

/**
 * The mission's requests whose Worker is running a turn now (mission runtime
 * design §5.4): `active` in the roster with a Worker Paseo lists as `running`
 * or `initializing`. An idle Worker, or one Paseo does not list, runs nothing:
 * closing or merging the mission does not wait for it. None when Paseo
 * cannot be read.
 */
export async function busyRequestsOf(home: string, paseo: unknown, missionId: string): Promise<RosterEntry[]> {
  const active = createMissionRoster(home).list(missionId).filter((entry) => entry.state === "active");
  if (active.length === 0) return [];
  const busy = new Set(
    (await bmAgentsOf(paseo as DashboardPaseo, { home })).filter(({ facts }) => facts.role === "worker" && !facts.archived && (facts.status === "running" || facts.status === "initializing")).map(({ facts }) => facts.id),
  );
  return active.filter((entry) => entry.workerIds.some((id) => busy.has(id)));
}

/** A closed mission's `active` requests become `stopped` (mission runtime design §5.4); returns them. Never throws: a failure is one log line. */
export function stopActiveRequests(home: string, missionId: string, log: (message: string) => void): string[] {
  const roster = createMissionRoster(home);
  const stopped: string[] = [];
  for (const entry of roster.list(missionId).filter((candidate) => candidate.state === "active")) {
    try {
      if (roster.setState(missionId, entry.requestId, "stopped")) stopped.push(entry.requestId);
    } catch (error) {
      log(`[paseo-bm] request ${entry.requestId} of the closed mission ${missionId} could not be marked stopped: ${errorText(error)}`);
    }
  }
  return stopped;
}

export interface MissionRosterDeps {
  now?: () => Date;
  /** Secrets to mask in topics; the process's own by default. */
  env?: NodeJS.ProcessEnv;
}

export interface MissionRoster {
  /** The mission's requests, oldest first. Never throws: none for a file that cannot be read. */
  list(missionId: string): RosterEntry[];
  /** One request of the mission, or null. Never throws. */
  get(missionId: string, requestId: string): RosterEntry | null;
  /**
   * Adds a request (`active`), or — already listed — appends `workerId` to its
   * Workers (newest last). Refused (null) when another mission's roster holds
   * the request or it is listed under another repo. Throws when the file
   * cannot be written.
   */
  add(missionId: string, init: { requestId: string; workspaceId: string; topic: string; workerId?: string | null }): RosterEntry | null;
  /** Sets a listed request's state; false when it is not listed. Throws when the file cannot be written. */
  setState(missionId: string, requestId: string, state: RosterState): boolean;
  /** A follow-up was told (mission runtime design §2.3): the entry becomes `active` with `followUpAt = at`; false when it is not listed. Throws when the file cannot be written. */
  noteFollowUp(missionId: string, requestId: string, at: string): boolean;
  /**
   * A split (missions design §9.6): the entries of `requestIds` leave the
   * roster of `fromMissionId` and join that of `toMissionId` as they are.
   * Returns the entries moved; one listed in neither is skipped. Throws when a
   * file cannot be written (the source is put back first).
   */
  move(fromMissionId: string, toMissionId: string, requestIds: readonly string[]): RosterEntry[];
}

/** The roster store of the data folder `home`. Creating it touches nothing on disk. */
export function createMissionRoster(home: string, deps: MissionRosterDeps = {}): MissionRoster {
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;

  const list = (missionId: string): RosterEntry[] => {
    try {
      return rosterFile(home, missionId).read().requests;
    } catch {
      return [];
    }
  };

  return {
    list,
    get: (missionId, requestId) => list(missionId).find((entry) => entry.requestId === requestId) ?? null,
    add(missionId, init) {
      if (!REQUEST_ID_PATTERN.test(init.requestId)) return null;
      const elsewhere = requestIndexOf(home, init.requestId);
      if (elsewhere !== null && elsewhere.missionId !== missionId) return null;
      let entry: RosterEntry | null = null;
      rosterFile(home, missionId).update((current) => {
        const index = current.requests.findIndex((request) => request.requestId === init.requestId);
        const workerId = init.workerId ?? null;
        if (index === -1) {
          entry = rosterEntrySchema.parse({
            requestId: init.requestId,
            workspaceId: init.workspaceId,
            createdAt: now().toISOString(),
            workerIds: workerId === null ? [] : [workerId],
            topic: redactText(init.topic.replace(/\s+/g, " ").trim(), env).slice(0, MAX_ROSTER_TOPIC),
            state: "active",
          });
          return { requests: [...current.requests, entry] };
        }
        const found = current.requests[index]!;
        if (found.workspaceId !== init.workspaceId) return null;
        entry = found;
        if (workerId === null || found.workerIds.includes(workerId)) return null;
        entry = { ...found, workerIds: [...found.workerIds, workerId] };
        return { requests: current.requests.map((request, at) => (at === index ? entry! : request)) };
      });
      return entry;
    },
    setState(missionId, requestId, state) {
      let found = false;
      rosterFile(home, missionId).update((current) => {
        const index = current.requests.findIndex((request) => request.requestId === requestId);
        if (index === -1) return null;
        found = true;
        if (current.requests[index]!.state === state) return null;
        return { requests: current.requests.map((request, at) => (at === index ? { ...request, state } : request)) };
      });
      return found;
    },
    noteFollowUp(missionId, requestId, at) {
      let found = false;
      rosterFile(home, missionId).update((current) => {
        const index = current.requests.findIndex((request) => request.requestId === requestId);
        if (index === -1) return null;
        found = true;
        return { requests: current.requests.map((request, position) => (position === index ? { ...request, state: "active" as const, followUpAt: at } : request)) };
      });
      return found;
    },
    move(fromMissionId, toMissionId, requestIds) {
      const wanted = new Set(requestIds);
      const source = rosterFile(home, fromMissionId);
      const moved = source.read().requests.filter((entry) => wanted.has(entry.requestId));
      if (moved.length === 0) return [];
      const ids = new Set(moved.map((entry) => entry.requestId));
      source.update((current) => ({ requests: current.requests.filter((entry) => !ids.has(entry.requestId)) }));
      try {
        rosterFile(home, toMissionId).update((current) => ({ requests: [...current.requests.filter((entry) => !ids.has(entry.requestId)), ...moved] }));
      } catch (error) {
        source.update((current) => ({ requests: [...current.requests, ...moved] }));
        throw error;
      }
      return moved;
    },
  };
}
