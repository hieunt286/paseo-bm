/**
 * `writers-observed` on each recorded turn (autonomy design §F.1, §F.3;
 * REQ-161): detection only — nothing here holds, prevents or undoes a write.
 *
 * Run from the collector's `onRecorded`, once the turn's record is in the
 * trace store:
 *
 * - **A turn that wrote files** inside its workspace folder is compared with
 *   the workspace's other recorded turns that wrote one of them
 *   (`collisionsOfTurn`, `shared/writers-observed.ts`). Each collision — two
 *   agents, one file, overlapping turns — raises the file's
 *   `writers-observed` alert (key `writers-observed:<workspaceId>:<file>`,
 *   raised once while open) and returns one `writers.observed` event for the
 *   event bus (one per file and turn pair). A pair is found once: when the
 *   later of its two turns is recorded, since the other is then in the store.
 *   A pair with a turn missing its start is not judged: no alert, no event.
 * - **The alert's detail** names the file and the agents of its unsettled
 *   collisions — those whose later request has not finished — with their
 *   requests: ids, shown only under Details. At most 300 characters.
 * - **A turn that carries a `finished` report** clears each open
 *   `writers-observed` alert of its workspace whose collisions are all
 *   settled: the later of the two requests finished (design §F.3,
 *   `isCollisionSettled`); a turn whose request is not known holds nothing
 *   open. Clearing runs before raising, so a turn that both finishes and
 *   collides leaves its new alert open.
 *
 * The workspace folder is the store's `lastKnownDirectory` (the collector's
 * agent cwd), else the recorded agent's cwd. Records are read with the trace
 * store's cached reader; alerts go to the data folder beside the traces.
 * Nothing here throws into the collector: a failure is one log line and no
 * event.
 */
import { dirname } from "node:path";
import type { TraceRecord } from "../shared/contracts";
import {
  collisionsOfTurn,
  isCollisionSettled,
  requestOfTurn,
  writersObservedOf,
  writtenFilesOf,
  type Collision,
} from "../shared/writers-observed";
import { createAlertStore } from "./alert-store";
import type { ObservedWriter, WritersObservedEvent } from "./event-bus";
import { errorText } from "./rpc-kit";
import { readRecords, readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";

export interface WritersWatchDeps {
  /** The data folder; beside the trace store (`<data>/traces`) by default. */
  home?: (location: TraceStoreLocation) => string | null;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface WritersWatch {
  /**
   * One recorded turn: clears the alerts it settles, raises one alert per new
   * collision's file, and returns the collisions' `writers.observed` events.
   * `cwd` is the recorded agent's folder, used when the store has none. Never
   * throws.
   */
  turnRecorded(record: TraceRecord | null | undefined, location: TraceStoreLocation, cwd?: string | null): WritersObservedEvent[];
}

const ROLE_WORDS: Readonly<Record<TraceRecord["role"], string>> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  orchestrator: "Orchestrator",
  unknown: "Agent",
};

/**
 * The alert's detail: the file and each agent of `collisions` once, with its
 * request — `src/math.js: Worker w-1 (request r-1) and Worker w-2 (request
 * r-2) wrote it in overlapping turns.` The store cuts it to 300 characters.
 * Pure.
 */
export function writersDetailOf(file: string, collisions: ReadonlyArray<Collision<TraceRecord>>, records: readonly TraceRecord[]): string {
  const named = new Map<string, string>();
  for (const collision of collisions) {
    for (const turn of collision.turns) {
      if (named.has(turn.agentId)) continue;
      const requestId = requestOfTurn(turn, records);
      named.set(turn.agentId, `${ROLE_WORDS[turn.role]} ${turn.agentId} (request ${requestId ?? "not known"})`);
    }
  }
  const agents = [...named.values()];
  const listed = agents.length <= 2 ? agents.join(" and ") : `${agents.slice(0, -1).join(", ")} and ${agents.at(-1)}`;
  return `${file}: ${listed} wrote it in overlapping turns.`;
}

/** One writer of an event: its agent, role, request and start. */
function writerOf(turn: TraceRecord, records: readonly TraceRecord[]): ObservedWriter {
  // A collision's turns both have a start: a pair without one is not judged.
  return { agentId: turn.agentId, role: turn.role, requestId: requestOfTurn(turn, records), startedAt: turn.startedAt ?? "" };
}

/** The later end of a collision's two turns. */
function laterEndOf(collision: Collision<TraceRecord>): string {
  const [a, b] = collision.turns;
  return Date.parse(a.endedAt) >= Date.parse(b.endedAt) ? a.endedAt : b.endedAt;
}

export function createWritersWatch(deps: WritersWatchDeps = {}): WritersWatch {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const homeOf = deps.home ?? ((location: TraceStoreLocation) => dirname(location.tracesDir));

  return {
    turnRecorded(record, location, cwd = null) {
      if (record === null || record === undefined) return [];
      try {
        const workspaceId = record.workspaceId;
        const directory = readWorkspaceMeta(location, workspaceId)?.lastKnownDirectory ?? cwd ?? null;
        const wrote = writtenFilesOf(record, directory).length > 0;
        const finishes = record.reports.some((report) => report.phase === "finished");
        if (!wrote && !finishes) return [];
        const home = homeOf(location);
        if (home === null) return [];
        const alerts = createAlertStore(home, deps.now === undefined ? {} : { now: deps.now });
        const open = finishes ? alerts.list({ open: true, workspaceId, kinds: ["writers-observed"] }) : [];
        if (!wrote && open.length === 0) return [];

        const records = readRecords(location, workspaceId).records;
        const observed = writersObservedOf(records, () => directory);
        const unsettledOn = (file: string) => observed.collisions.filter((collision) => collision.file === file && !isCollisionSettled(collision, records));

        // Clear first: the later of the two requests finished (design §F.3).
        for (const alert of open) {
          if (unsettledOn(alert.subject).length === 0) alerts.clear(alert.key);
        }

        if (!wrote) return [];
        const found = collisionsOfTurn(record, records, directory);
        return found.collisions.map((collision): WritersObservedEvent => {
          // The new pair first; each agent is named once, so the store's copy of this pair adds nobody.
          const raised = alerts.raise({
            workspaceId,
            kind: "writers-observed",
            subject: collision.file,
            detail: writersDetailOf(collision.file, [collision, ...unsettledOn(collision.file)], records),
          });
          return {
            type: "writers.observed",
            workspaceId,
            file: collision.file,
            writers: [writerOf(collision.turns[0], records), writerOf(collision.turns[1], records)],
            alertKey: raised.alert.key,
            at: laterEndOf(collision),
          };
        });
      } catch (error) {
        log(`[paseo-bm] could not check the turn's writes against its workspace's: ${errorText(error)}`);
        return [];
      }
    },
  };
}
