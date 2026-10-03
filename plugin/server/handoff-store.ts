/**
 * The handoffs the Orchestrator asked for (autonomy design §G.6, §G.7; PRD
 * REQ-135; bead `7gxw.11`): one file per handoff, with its brief.
 *
 * `<data folder>/handoffs/<id>.json` = `{ version: 1, handoff: <HandoffEntry> }`.
 *
 * - **An entry** is one `bm_handoff` the plugin accepted: the request, the
 *   outgoing Worker and its Manager (who creates the successor), the
 *   intervention it is logged as, the Orchestrator's reason (masked, one
 *   line), the outgoing Worker's note and the brief once built (both masked),
 *   and where its sequence stands (`handoff.ts`): `waiting` for the Worker's
 *   idle moment after a safe point; `noting` once the note was asked for;
 *   `briefed` once the brief is built and the command waits for the Manager's
 *   idle moment; `creating` while the plugin creates the successor itself
 *   for a bound Manager (design §16.9: moved there from `briefed` by one
 *   compare-and-set, `claimCreation`, so two turn ends or a reload never
 *   create two); `commanded` once the `BM-COMMAND` went out; `done` when the
 *   successor appeared with `bm.handoffFrom`. It ends without a successor as
 *   `dropped` (before the command went out: no safe point, handoff turned
 *   off, the request finished, no Manager, the loop guard or another refusal
 *   of the send, the Manager busy too long, a successor the plugin was creating
 *   that never appeared within `CREATING_WAIT_MS`) or `failed` (after it: the Manager could not be reached, or
 *   created no successor in time). An entry past its bound reads as ended
 *   (`staleEndingOf`) until a write records it.
 * - **Its handoffs so far** (`handoffsDoneOf`) are the request's entries
 *   whose successor appeared: they count toward `handoff.maxPerRequest`, key
 *   the `threshold.crossed` cycle (design §G.7), and the newest one's time is
 *   where the request's tokens are counted from again.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`):
 * the folder is created `0700` only by a write, never by a read; each file is
 * `0600` and replaced atomically; a symlink is refused; a missing, corrupt or
 * invalid file is skipped on its own; a file of a newer version reads as
 * absent and is never written. The cleanup deletes the folder
 * (`setup-machine.ts` `CLEANUP_DELETES`).
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { INTERVENTION_WINDOW_MS } from "../shared/interventions";
import { MAX_HANDOFF_NOTE_CHARS } from "../shared/handoff";
import { MAX_COMMAND_BODY_CHARS, MAX_COMMAND_WHY_CHARS } from "../shared/orchestrator-command";
import { timeOrNull } from "../shared/time";
import { PENDING_TTL_MS } from "./agent-bindings";
import { assertNoSymlink, createJsonFileStore } from "./data-files";

/** The folder under the data folder (design §G.6 step 2). */
export const HANDOFFS_DIR_NAME = "handoffs";
/** The file format this build reads and writes. */
export const HANDOFF_FILE_VERSION = 1;

/**
 * How long a handoff waits for the outgoing Worker's idle moment after a safe
 * point: the `handoff` intervention's window (design §G.3).
 */
export const HANDOFF_SAFE_POINT_WAIT_MS = INTERVENTION_WINDOW_MS.handoff;
/** How long the plugin waits for the outgoing Worker's note before it goes on without one (design §G.6 step 1). */
export const NOTE_WAIT_MS = 10 * 60_000;
/** How long a built brief waits for the Manager's idle moment before the handoff is dropped. */
export const MANAGER_WAIT_MS = 30 * 60_000;
/** How long after the command the plugin waits for the successor (`agent.created` with `bm.handoffFrom`). */
export const SUCCESSOR_WAIT_MS = 30 * 60_000;
/**
 * How long a successor the plugin is creating (`creating`) may take to appear
 * before the handoff ends `no-successor`: a binding's pending time.
 */
export const CREATING_WAIT_MS = PENDING_TTL_MS;
/** The longest reason kept, as a command's `why` (`MAX_COMMAND_WHY_CHARS`). */
export const MAX_HANDOFF_REASON_CHARS = MAX_COMMAND_WHY_CHARS;

export const HANDOFF_STATES = ["waiting", "noting", "briefed", "creating", "commanded", "done", "dropped", "failed"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];
/** Why an entry ended without a successor. */
export const HANDOFF_ENDINGS = ["no-safe-point", "off", "finished", "no-manager", "loop-guard", "refused", "manager-busy", "unreachable", "no-successor"] as const;
export type HandoffEnding = (typeof HANDOFF_ENDINGS)[number];

/** A handoff id: one plain file name. */
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const time = z.string().min(1);

export const handoffEntrySchema = z.object({
  id: z.string().regex(HANDOFF_ID),
  workspaceId: z.string().min(1),
  requestId: z.string().min(1),
  /** The outgoing Worker. */
  workerId: z.string().min(1),
  /** Its Manager, who gets the command and creates the successor. */
  managerId: z.string().min(1),
  /** The `handoff` intervention it is logged as; null when that record failed. */
  interventionId: z.string().min(1).nullable(),
  /** The Orchestrator's reason, masked, on one line. */
  reason: z.string().max(MAX_HANDOFF_REASON_CHARS),
  state: z.enum(HANDOFF_STATES),
  requestedAt: time,
  /** When the note request went out; null before. */
  noteAskedAt: time.nullable(),
  /** The outgoing Worker's note, masked; null when it wrote none (yet). */
  note: z.string().max(MAX_HANDOFF_NOTE_CHARS).nullable(),
  /** When the brief was built. */
  briefAt: time.nullable(),
  /** The brief as the successor gets it, masked, at most `HANDOFF_BRIEF_MAX_CHARS` (`handoff.ts`). */
  brief: z.string().max(MAX_COMMAND_BODY_CHARS).nullable(),
  /** The command to the Manager, as the commands store records it. */
  commandId: z.string().min(1).nullable(),
  commandSentAt: time.nullable(),
  /** When the plugin began creating the successor for a bound Manager (`creating`); null otherwise. Absent in older files. */
  creatingAt: time.nullable().default(null),
  /** The successor Worker, once `agent.created` showed it. */
  successorId: z.string().min(1).nullable(),
  successorAt: time.nullable(),
  endedAt: time.nullable(),
  ending: z.enum(HANDOFF_ENDINGS).nullable(),
});
export type HandoffEntry = z.infer<typeof handoffEntrySchema>;

/** What `add` takes; the rest starts as `waiting`, at now. */
export type HandoffInput = Pick<HandoffEntry, "workspaceId" | "requestId" | "workerId" | "managerId" | "interventionId" | "reason">;

export interface HandoffStoreDeps {
  now?: () => Date;
  /** A new entry id; `randomUUID` by default. */
  newId?: () => string;
}

export interface HandoffStore {
  /** `<data folder>/handoffs`. */
  readonly dir: string;
  /** Every entry, oldest requested first. */
  list(): HandoffEntry[];
  /** The entry with this id, or null. */
  get(id: string): HandoffEntry | null;
  /** Writes one `waiting` entry at now. */
  add(input: HandoffInput): HandoffEntry;
  /** Changes one entry in one write; `change` returning it unchanged writes nothing. Returns the entry as stored, or null when it is not there. */
  update(id: string, change: (entry: HandoffEntry) => HandoffEntry): HandoffEntry | null;
  /**
   * Moves a `briefed` entry to `creating` at now, in one write, only when it is
   * `briefed` now (compare-and-set): the one caller that gets the entry back
   * creates the successor; every other gets null. Never throws on a missing entry.
   */
  claimCreation(id: string): HandoffEntry | null;
  /** Ends every entry past its bound (`staleEndingOf`) at now; returns the entries it ended. */
  expire(): HandoffEntry[];
}

/** Pending: not ended, whatever its step. */
export function isPendingHandoffState(state: HandoffState): boolean {
  return state === "waiting" || state === "noting" || state === "briefed" || state === "creating" || state === "commanded";
}

/**
 * How a pending entry ends at `now` once past its bound: `no-safe-point` for
 * one `waiting` longer than `HANDOFF_SAFE_POINT_WAIT_MS`, `manager-busy` for a
 * brief not sent within `MANAGER_WAIT_MS`, `no-successor` for a command with
 * no successor within `SUCCESSOR_WAIT_MS` or a creation the plugin began with
 * no successor within `CREATING_WAIT_MS`. A `noting` entry has no ending of
 * its own: past `NOTE_WAIT_MS` it goes on without the note. Null while it is
 * within its bound, or not pending. Pure.
 */
export function staleEndingOf(entry: HandoffEntry, now: Date | number): HandoffEnding | null {
  const at = typeof now === "number" ? now : now.getTime();
  const past = (from: string | null, bound: number): boolean => {
    const start = timeOrNull(from);
    return start !== null && at - start > bound;
  };
  switch (entry.state) {
    case "waiting":
      return past(entry.requestedAt, HANDOFF_SAFE_POINT_WAIT_MS) ? "no-safe-point" : null;
    case "briefed":
      return past(entry.briefAt, MANAGER_WAIT_MS) ? "manager-busy" : null;
    case "creating":
      return past(entry.creatingAt, CREATING_WAIT_MS) ? "no-successor" : null;
    case "commanded":
      return past(entry.commandSentAt, SUCCESSOR_WAIT_MS) ? "no-successor" : null;
    default:
      return null;
  }
}

/** The entry `ending` ends at `at`: `failed` once its command went out, else `dropped`. Pure. */
export function endedHandoff(entry: HandoffEntry, ending: HandoffEnding, at: string): HandoffEntry {
  return { ...entry, state: entry.commandSentAt === null ? "dropped" : "failed", ending, endedAt: at };
}

/** The request's pending handoff at `now` (at most one: `bm_handoff` refuses a second), or null. Pure. */
export function pendingHandoffOf(entries: readonly HandoffEntry[], requestId: string, now: Date | number): HandoffEntry | null {
  return entries.find((entry) => entry.requestId === requestId && isPendingHandoffState(entry.state) && staleEndingOf(entry, now) === null) ?? null;
}

/** Its handoffs so far: the request's entries whose successor appeared, oldest first. Pure. */
export function handoffsDoneOf(entries: readonly HandoffEntry[], requestId: string): HandoffEntry[] {
  return entries
    .filter((entry) => entry.requestId === requestId && entry.successorId !== null)
    .sort((a, b) => (timeOrNull(a.successorAt) ?? 0) - (timeOrNull(b.successorAt) ?? 0));
}

/** When the request's newest handoff happened (its successor appeared), or null. Pure. */
export function lastHandoffAtOf(entries: readonly HandoffEntry[], requestId: string): number | null {
  return timeOrNull(handoffsDoneOf(entries, requestId).at(-1)?.successorAt ?? null);
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createHandoffStore(home: string, deps: HandoffStoreDeps = {}): HandoffStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const dir = join(home, HANDOFFS_DIR_NAME);
  const fileOf = (id: string) =>
    createJsonFileStore<{ handoff: HandoffEntry | null }>({
      home,
      dir: HANDOFFS_DIR_NAME,
      file: `${id}.json`,
      version: HANDOFF_FILE_VERSION,
      parse: (body) => ({ handoff: handoffEntrySchema.parse(body["handoff"]) }),
      empty: () => ({ handoff: null }),
      codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
    });
  const read = (id: string): HandoffEntry | null => (HANDOFF_ID.test(id) ? fileOf(id).read().handoff : null);

  const list = (): HandoffEntry[] => {
    // Before the read, so a symlinked folder is refused rather than followed.
    assertNoSymlink(home, dir, "E_TRACE_STORE_UNWRITABLE");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".json") && HANDOFF_ID.test(name.slice(0, -".json".length)))
      .flatMap((name) => {
        const entry = read(name.slice(0, -".json".length));
        return entry === null ? [] : [entry];
      })
      .sort((a, b) => (timeOrNull(a.requestedAt) ?? 0) - (timeOrNull(b.requestedAt) ?? 0) || a.id.localeCompare(b.id));
  };

  const update = (id: string, change: (entry: HandoffEntry) => HandoffEntry): HandoffEntry | null => {
    if (!HANDOFF_ID.test(id)) return null;
    // Set inside the update, which runs synchronously.
    let stored = null as HandoffEntry | null;
    fileOf(id).update((current) => {
      if (current.handoff === null) return null;
      const after = handoffEntrySchema.parse(change(current.handoff));
      stored = after;
      return JSON.stringify(after) === JSON.stringify(current.handoff) ? null : { handoff: after };
    });
    return stored;
  };

  return {
    dir,
    list,
    get: read,
    add(input) {
      const entry = handoffEntrySchema.parse({
        id: newId(),
        ...input,
        state: "waiting",
        requestedAt: now().toISOString(),
        noteAskedAt: null,
        note: null,
        briefAt: null,
        brief: null,
        commandId: null,
        commandSentAt: null,
        creatingAt: null,
        successorId: null,
        successorAt: null,
        endedAt: null,
        ending: null,
      });
      fileOf(entry.id).write({ handoff: entry });
      return entry;
    },
    update,
    claimCreation(id) {
      let claimed = false;
      const next = update(id, (current) => {
        if (current.state !== "briefed") return current;
        claimed = true;
        return { ...current, state: "creating", creatingAt: now().toISOString() };
      });
      return claimed ? next : null;
    },
    expire() {
      const at = now();
      const ended: HandoffEntry[] = [];
      for (const entry of list()) {
        const ending = staleEndingOf(entry, at);
        if (ending === null) continue;
        const next = update(entry.id, (current) => endedHandoff(current, ending, at.toISOString()));
        if (next !== null) ended.push(next);
      }
      return ended;
    },
  };
}
