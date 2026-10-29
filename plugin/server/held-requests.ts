/**
 * The held queue (delivery line design §19.6, ADR-038 decision 5): work a
 * Main gave with `bm_create_worker` `after`, waiting for requests of its
 * mission to finish, kept by paseo-bm rather than in the Main's memory.
 *
 * `<data folder>/missions/<missionId>.held.json` =
 * `{ schemaVersion: 1, entries: [{ holdId, after, input, by, at, state, startedAs?, note? }] }`.
 *
 * - **Held:** the `bm_create_worker` input as the Main gave it, without
 *   `after`. Its id is `hold-<time>`: no request id until its Worker exists.
 * - **Started** (`startHeldRequests`, at the governor's pass, about each
 *   minute): when every request of `after` is `finished`, the Worker is
 *   created through `bm_create_worker` as the mission's Main, so staffing,
 *   lanes and the brief apply as for any request. The Main is told.
 * - **Waiting on a stop:** a request of `after` `stopped` is told to the Main
 *   once, and the entry waits.
 * - **Cancelled:** the Main's `bm_hold_cancel`.
 *
 * Bounded: at most `MAX_HELD` waiting entries a mission; the newest
 * `MAX_SETTLED_HELD` settled ones are kept. Never throws to its callers.
 */
import { z } from "zod";
import type { ToolCaller } from "./agent-bindings";
import { capBy, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { enqueueNotice, type ChannelQueue } from "./main-channel";
import { createMissionRoster } from "./mission-roster";
import { MISSIONS_DIR_NAME, createMissionStore, journalQuietly } from "./mission-store";
import type { NoticePaseo } from "./notice-queue";
import { errorText } from "./rpc-kit";
import { timeOrZero } from "../shared/time";

export const HELD_VERSION = 1;
/** The most waiting entries a mission holds. */
export const MAX_HELD = 30;
/** The settled entries kept, the newest. */
export const MAX_SETTLED_HELD = 50;
export const HOLD_ID_PATTERN = /^hold-\d{8}T\d{6,9}Z$/;

const entrySchema = z.object({
  holdId: z.string().regex(HOLD_ID_PATTERN),
  after: z.array(z.string()).min(1),
  input: z.record(z.string(), z.unknown()),
  topic: z.string(),
  by: z.string(),
  at: z.string(),
  state: z.enum(["held", "waiting-stopped", "started", "cancelled"]),
  startedAs: z.string().optional(),
  note: z.string().optional(),
  settledAt: z.string().optional(),
});

export type HeldRequest = z.infer<typeof entrySchema>;

const isSettled = (entry: HeldRequest) => entry.state === "started" || entry.state === "cancelled";

function fileOf(home: string, missionId: string): JsonFileStore<{ entries: HeldRequest[] }> {
  return createJsonFileStore<{ entries: HeldRequest[] }>({
    home,
    dir: MISSIONS_DIR_NAME,
    file: `${missionId}.held.json`,
    version: HELD_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ entries: entriesOf(entrySchema, body["entries"]) }),
    empty: () => ({ entries: [] }),
    cap: ({ entries }) => {
      const settled = entries.flatMap((entry, index) => (isSettled(entry) ? [index] : []));
      const kept = new Set(capBy(settled, MAX_SETTLED_HELD, (index) => timeOrZero(entries[index]!.settledAt ?? entries[index]!.at)));
      return { entries: entries.filter((entry, index) => !isSettled(entry) || kept.has(index)) };
    },
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
    keepUnusable: true,
    cached: true,
  });
}

/** A hold id at `now`: `hold-` and the compact UTC time. Pure. */
export const holdIdOf = (now: Date): string => `hold-${now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z")}`;

/** The mission's held entries, oldest first (settled ones included). Never throws. */
export function heldRequestsOf(home: string, missionId: string): HeldRequest[] {
  try {
    return fileOf(home, missionId).read().entries;
  } catch {
    return [];
  }
}

/** Records a held request; refused past `MAX_HELD` waiting entries. Throws when the file cannot be written. */
export function holdRequest(home: string, missionId: string, init: Omit<HeldRequest, "holdId" | "at" | "state">, now: Date): { ok: true; entry: HeldRequest } | { ok: false; reason: string } {
  let result: { ok: true; entry: HeldRequest } | { ok: false; reason: string } = { ok: false, reason: "nothing was held" };
  fileOf(home, missionId).update((current) => {
    if (current.entries.filter((entry) => !isSettled(entry)).length >= MAX_HELD) {
      result = { ok: false, reason: `mission holds ${MAX_HELD} requests already; cancel one with bm_hold_cancel` };
      return null;
    }
    const taken = new Set(current.entries.map((entry) => entry.holdId));
    let at = now;
    while (taken.has(holdIdOf(at))) at = new Date(at.getTime() + 1);
    const entry = entrySchema.parse({ ...init, holdId: holdIdOf(at), at: now.toISOString(), state: "held" });
    result = { ok: true, entry };
    return { entries: [...current.entries, entry] };
  });
  return result;
}

/** Changes one entry; false when it is not there or `change` keeps it. Never throws. */
function changeHeld(home: string, missionId: string, holdId: string, change: (entry: HeldRequest) => HeldRequest | null): boolean {
  let changed = false;
  try {
    fileOf(home, missionId).update((current) => {
      const at = current.entries.findIndex((entry) => entry.holdId === holdId);
      if (at === -1) return null;
      const next = change(current.entries[at]!);
      if (next === null) return null;
      changed = true;
      return { entries: current.entries.map((entry, index) => (index === at ? next : entry)) };
    });
  } catch {
    changed = false;
  }
  return changed;
}

/** Cancels a waiting held request; why not, or null when done. Never throws. */
export function cancelHeld(home: string, missionId: string, holdId: string, why: string, now: Date): string | null {
  const found = heldRequestsOf(home, missionId).find((entry) => entry.holdId === holdId);
  if (found === undefined) return `no held request ${holdId} in this mission (bm_mission lists them)`;
  if (isSettled(found)) return `held request ${holdId} is already ${found.state}`;
  changeHeld(home, missionId, holdId, (entry) => ({ ...entry, state: "cancelled", note: why, settledAt: now.toISOString() }));
  return null;
}

/** What a held request waits for now: `finished` when every request of `after` finished, `stopped` naming one stopped, else `waiting`. */
export function holdStateOf(home: string, missionId: string, entry: Pick<HeldRequest, "after">): { kind: "finished" } | { kind: "stopped"; requestId: string } | { kind: "waiting" } {
  const roster = createMissionRoster(home).list(missionId);
  const stateOf = (requestId: string) => roster.find((request) => request.requestId === requestId)?.state ?? null;
  const stopped = entry.after.find((requestId) => stateOf(requestId) === "stopped");
  if (stopped !== undefined) return { kind: "stopped", requestId: stopped };
  return entry.after.every((requestId) => stateOf(requestId) === "finished") ? { kind: "finished" } : { kind: "waiting" };
}

/** How a held request is created: `bm_create_worker` as the mission's Main (the endpoint's own tool). */
export type CreateAsMain = (input: Record<string, unknown>, caller: ToolCaller) => Promise<{ ok: boolean; text: string }>;

export interface HeldDeps {
  create: CreateAsMain;
  now?: () => Date;
  log: (message: string) => void;
  paseo?: NoticePaseo;
  queue?: ChannelQueue;
}

async function tellMain(home: string, mainId: string, kind: string, text: string, deps: HeldDeps): Promise<void> {
  try {
    await enqueueNotice({ home, targetId: mainId, kind, text, ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }), ...(deps.queue === undefined ? {} : { queue: deps.queue }) });
  } catch (error) {
    deps.log(`[paseo-bm] could not tell Main ${mainId} about a held request: ${errorText(error)}`);
  }
}

/** Starts every held request whose requests finished, and tells the Main of one waiting on a stopped request (see the module comment). Never throws. */
export async function startHeldRequests(home: string, deps: HeldDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  try {
    const store = createMissionStore(home);
    for (const summary of store.list().filter((mission) => mission.state === "open")) {
      const mission = store.get(summary.missionId);
      if (mission === null || mission.mainId === null) continue;
      for (const entry of heldRequestsOf(home, mission.missionId).filter((held) => held.state === "held" || held.state === "waiting-stopped")) {
        const state = holdStateOf(home, mission.missionId, entry);
        if (state.kind === "waiting") continue;
        if (state.kind === "stopped") {
          if (entry.state === "waiting-stopped") continue;
          changeHeld(home, mission.missionId, entry.holdId, (current) => ({ ...current, state: "waiting-stopped", note: `${state.requestId} stopped` }));
          await tellMain(
            home,
            mission.mainId,
            `held-stopped:${entry.holdId}`,
            `BM-DELIVERY held\nFrom the paseo-bm plugin, not the owner: held request ${entry.holdId} ("${entry.topic}") waits for ${state.requestId}, which stopped. It does not start by itself: give its work again with bm_create_worker, or cancel it with bm_hold_cancel.`,
            deps,
          );
          continue;
        }
        const caller: ToolCaller = { agentId: mission.mainId, role: "manager", workspaceId: mission.workspaceId ?? "", requestId: null, parentId: null, batchId: null, missionId: mission.missionId };
        const answer = await deps.create(entry.input, caller);
        if (!answer.ok) {
          // Kept held: the next pass tries again, and the Main hears why once.
          if (entry.note !== answer.text) {
            changeHeld(home, mission.missionId, entry.holdId, (current) => ({ ...current, note: answer.text }));
            await tellMain(home, mission.mainId, `held-refused:${entry.holdId}`, `BM-DELIVERY held\nFrom the paseo-bm plugin, not the owner: held request ${entry.holdId} ("${entry.topic}") could not start: ${answer.text}`, deps);
          }
          continue;
        }
        let startedAs = "";
        let workerId = "";
        try {
          const parsed = JSON.parse(answer.text) as { requestId?: string; workerId?: string; lane?: number };
          startedAs = parsed.requestId ?? "";
          workerId = parsed.workerId ?? "";
        } catch {
          startedAs = "";
        }
        changeHeld(home, mission.missionId, entry.holdId, (current) => ({ ...current, state: "started", ...(startedAs === "" ? {} : { startedAs }), settledAt: now().toISOString() }));
        journalQuietly(createMissionStore(home), mission.missionId, { kind: "worker", by: "plugin", text: `Held request ${entry.holdId} started as ${startedAs || "a new request"}: ${entry.after.join(", ")} finished.`, ref: startedAs || entry.holdId }, deps.log);
        await tellMain(
          home,
          mission.mainId,
          `held-started:${entry.holdId}`,
          `BM-DELIVERY held\nFrom the paseo-bm plugin, not the owner: held request ${entry.holdId} ("${entry.topic}") started as ${startedAs} with Worker ${workerId}, since ${entry.after.join(", ")} finished.`,
          deps,
        );
      }
    }
  } catch (error) {
    deps.log(`[paseo-bm] held requests could not be started: ${errorText(error)}`);
  }
}
