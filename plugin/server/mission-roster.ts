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
import { MISSIONS_DIR_NAME, MISSIONS_VERSION, MISSION_ID_PATTERN } from "./mission-store";
import { REQUEST_ID_PATTERN, createRequestRegistry } from "./request-registry";

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
export function noteRosterReport(home: string, requestId: string, phase: string, log: (message: string) => void = () => {}): void {
  try {
    const place = requestIndexOf(home, requestId);
    if (place === null) return;
    const state: RosterState = phase === "finished" || phase === "stopped" ? phase : "active";
    createMissionRoster(home).setState(place.missionId, requestId, state);
  } catch (error) {
    log(`[paseo-bm] could not note the ${phase} report of request ${requestId} in its mission's roster: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  };
}
