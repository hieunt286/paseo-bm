/**
 * The Orchestrator's data store: `<data folder>/orchestrator/` (Orchestrator
 * design §4.3, §5.4).
 *
 * The module that reads and writes that folder's own files (the intervention
 * log, `interventions.json`, has its own store: `intervention-store.ts`):
 *
 * - `proposals.json` — every command of the Orchestrator's delivered to a
 *   Manager or Worker (`command-send.ts`): those it sent itself and the
 *   prepared commands of the options chosen on its decisions; the 200 newest
 *   (the loop guard and a project's last action read them). The entries of
 *   the proposal era — pending, dismissed and failed proposals, commands the
 *   owner sent from its former screen, and decisions asked before the
 *   decision store — are ignored and dropped by the next write (autonomy
 *   design §A.14);
 * - `stalls.json` — which Worker may be interrupted, for 10 minutes after a
 *   `danger` signal (design §6B.3). The stall, event and Worker-signal keys
 *   older builds kept here are ignored and dropped by the next write: stalls
 *   and signals are Inbox alerts now (`alert-store.ts`, autonomy design §A.8);
 * - `notes/<workspaceId>.json` — the Orchestrator's notes about a project, the
 *   20 newest (design §6B.4 `bm_note`);
 * - `wakes.json` — each time the event bus woke the Orchestrator with a
 *   `BM-EVENTS` message, when that turn ended and its tokens, the 500 newest:
 *   ids, times and counts only (evaluation design §4, A-7; change-007 C6).
 *
 * An old `nudges.json` from the first design, the `settings.json` that held
 * the projects on Autopilot and their Allow… categories until Autopilot was
 * retired (autonomy design §B.8), the `model-corrections.json` the creation
 * hook kept until nothing read it (its rule retired, §B.9), and the
 * `assessments/<workspaceId>.jsonl` of the workflow assessment, retired with
 * the additional instructions (§B.9), are never read or written; cleanup
 * deletes them with the rest of the folder, and deleting a project's traces deletes its old assessments
 * file (`deleteRetiredAssessments`), which may quote them.
 *
 * Every operation is synchronous. The plugin server is one thread, so a
 * read-modify-write here cannot interleave with another one — which is what
 * lets a command be recorded, or an allowance be opened, without a lock.
 *
 * The containment rules are the trace store's, from `data-files.ts`: the
 * folder is created `0700` only by a write, never by a read; files are `0600`;
 * the JSON files are replaced atomically (temp file, then rename, each through
 * `createJsonFileStore`); a symlink anywhere
 * from the data folder down is refused. Every failure of those steps is
 * `E_ORCHESTRATOR_WRITE_FAILED` (design §8).
 *
 * Reads never repair a file. A missing, corrupt or unrecognised file reads as
 * its default — no command, no allowance — and the next
 * write replaces it. In `proposals.json`,
 * `stalls.json`, the notes and `wakes.json` an entry that does not validate is
 * skipped on its own, and dropped by the next write. A JSON file whose
 * `version` is newer than this build reads as its default too, but is never
 * written: a write throws `E_ORCHESTRATOR_WRITE_FAILED` and leaves it as it is
 * (code review 2026-09-30 §2.3 — the old store replaced it, losing a newer
 * build's data after a downgrade).
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DashboardErrorCode } from "../shared/contracts";
import {
  DANGER_ALLOWANCE_MS,
  MAX_NOTES,
  MAX_WAKE_WORKSPACES,
  isSentCommand,
  orchestratorNoteSchema,
  proposalSchema,
  stallEntrySchema,
  wakeEntrySchema,
  wakeUsageSchema,
  type CommandTarget,
  type OrchestratorNote,
  type Proposal,
  type ProposalOutcome,
  type StallEntry,
  type WakeEntry,
  type WakeUsage,
} from "../shared/orchestrator";
import {
  assertNoSymlink,
  capBy,
  createJsonFileStore,
  entriesOf,
  keyedEntriesOf,
  type JsonFileStore,
} from "./data-files";
import { assertWorkspaceId } from "./trace-store";
import { timeOrZero } from "../shared/time";

/** The folder inside the data folder; removing paseo-bm's data deletes it whole. */
export const ORCHESTRATOR_DIR_NAME = "orchestrator";
export const PROPOSALS_FILE = "proposals.json";
export const STALLS_FILE = "stalls.json";
export const WAKES_FILE = "wakes.json";
/** Where an earlier build kept the workflow assessments; retired (autonomy design §B.9), never read or written. */
export const RETIRED_ASSESSMENTS_DIR_NAME = "assessments";
export const NOTES_DIR_NAME = "notes";

/** At most this many recorded commands; the oldest go first (design §5.4). */
export const COMMAND_LOG_LIMIT = 200;
/** At most this many entries in `stalls.json` (interrupt allowances); the oldest go first. */
export const STALL_ENTRY_LIMIT = 500;
/** `wakes.json` keeps this many of the newest wakes (evaluation design §4, A-7). */
export const WAKE_LOG_LIMIT = 500;

/** Every failure to read or write the folder (design §8). */
const WRITE_FAILED: DashboardErrorCode = "E_ORCHESTRATOR_WRITE_FAILED";
/** The version of every JSON file in the folder. */
const FILE_VERSION = 1;

/** Everything this module takes from outside, injectable so a test runs on fixed time. */
export interface OrchestratorStoreDeps {
  now?: () => Date;
  /** A new command id; `randomUUID` by default. */
  newId?: () => string;
}

/**
 * A command of the Orchestrator's (design §6A, §6B.1, §6B.4), recorded once
 * it is delivered (`command-send.ts`), with source `chat`: every one it sends
 * itself — on the owner's word in its chat, a decision's grant or the owner's
 * policy — and every prepared command delivered because the owner, the
 * owner's policy or an owner precedent chose its option (an entry of Phase 1
 * with source `autopilot` is still read, `isSentCommand`).
 * `situation` is its `re:` line, `command` its body, `reason` its `why:`,
 * `sentText` the whole block. A `worker` command names `workerId`, and
 * `managerId` is that Worker's Manager (who got the copy) or null.
 */
export interface SentCommandInput {
  /** The command's id, when it was named before delivery (its `command:<id>` notice, its intervention); a new one otherwise. */
  id?: string;
  workspaceId: string;
  managerId: string | null;
  requestId: string | null;
  situation: string;
  command: string;
  reason: string;
  sentText: string;
  outcome: ProposalOutcome;
  /** `manager` when absent. */
  to?: CommandTarget;
  workerId?: string;
}

/** An interrupt allowance (design §6B.3): the Worker may be interrupted until `until`. */
export interface DangerAllowanceView {
  key: string;
  workspaceId: string;
  workerId: string;
  openedAt: string;
  until: string;
  /** True while `until` lies ahead. */
  open: boolean;
}

export interface OrchestratorStore {
  /** `<data folder>/orchestrator`. */
  readonly dir: string;

  /** Records a delivered command (`status: sent`, stamped now) under `input.id` or a new id, and returns the entry stored; throws on an id already used. */
  appendCommand(input: SentCommandInput): Proposal;
  /** The recorded commands, newest first (by when they were sent), at most `limit` of them. */
  listCommands(limit?: number): Proposal[];

  /**
   * Opens an interrupt allowance for the Worker for `DANGER_ALLOWANCE_MS`
   * (10 minutes) from now (design §6B.3) and returns it. Expired allowances of
   * every Worker are dropped in the same write.
   */
  openDangerAllowance(workspaceId: string, workerId: string): DangerAllowanceView;
  /** True while an allowance of this Worker is open: the Orchestrator may interrupt it (design §6B.4). */
  isDangerOpen(workspaceId: string, workerId: string): boolean;
  /** Every stored allowance, or only the open (`open: true`) or expired ones, oldest first. */
  listDangerAllowances(filter?: { open?: boolean }): DangerAllowanceView[];

  /** The project's notes, oldest first (design §6B.4 `bm_note`); none when it has no file. */
  readNotes(workspaceId: string): OrchestratorNote[];
  /**
   * Adds a note (1–500 characters once trimmed, else throws); with `replace`
   * the project's notes are emptied first. The 20 newest are kept. Returns the
   * notes as stored, oldest first.
   */
  appendNote(workspaceId: string, text: string, options?: { replace?: boolean }): OrchestratorNote[];

  /**
   * Records a wake (evaluation design §4, A-7): the event bus delivered a
   * `BM-EVENTS` message of `events` events of these projects to this
   * Orchestrator, now. Returns the entry stored; throws when it does not
   * validate or cannot be written.
   */
  appendWake(input: { orchestratorId: string; workspaceIds: readonly string[]; events: number }): WakeEntry;
  /**
   * The Orchestrator's turn ended: its **oldest** wake still without an end,
   * started no later than now, ends now. Oldest, because the turn end that
   * closes one wake may already have delivered the next. `usage` is the
   * tokens of that closing turn (change-007 C6), null when unknown. Returns the
   * wake it ended, or null — writing nothing — when none was open.
   */
  endWake(orchestratorId: string, usage?: WakeUsage | null): WakeEntry | null;
  /** The recorded wakes in file order (oldest first). */
  readWakes(): WakeEntry[];

  /**
   * Deletes the workspace's `assessments/<workspaceId>.jsonl` an earlier build
   * wrote (autonomy design §B.9): nothing reads it, but it may quote the
   * project's requests, so it goes when any of their traces is deleted
   * (orchestrator design §5.3, REQ-075 e). True when a file was deleted.
   */
  deleteRetiredAssessments(workspaceId: string): boolean;
}

/**
 * The parts of a key `<ws>::<middle>::<name>@<time>`: the workspace id ends at
 * the first "::" and the name starts after the last, so a middle part holding
 * "::" still splits correctly. Null when the key is not of that shape.
 */
function splitTimedKey(key: string): { workspaceId: string; middle: string; name: string; at: string } | null {
  const first = key.indexOf("::");
  const last = key.lastIndexOf("::");
  if (first <= 0 || last <= first + 2) return null;
  const tail = key.slice(last + 2);
  const at = tail.indexOf("@");
  if (at <= 0 || at === tail.length - 1) return null;
  return { workspaceId: key.slice(0, first), middle: key.slice(first + 2, last), name: tail.slice(0, at), at: tail.slice(at + 1) };
}

/** Throws unless `time` can end a timed key: not empty, no "::". */
function assertKeyTime(time: string, what: string): void {
  if (time === "" || time.includes("::")) throw new Error(`not ${what}: ${JSON.stringify(time)}`);
}

/** The last part of an interrupt allowance's key. */
export const DANGER_OPEN = "danger-open";

/**
 * The key of an interrupt allowance in `stalls.json` (design §6B.3):
 * `<ws>::<workerId>::danger-open@<time opened>`. Throws on a workspace id the
 * store would refuse, an empty Worker id or one holding "::", and a time that
 * is empty or holds "::".
 */
export function dangerOpenKey(workspaceId: string, workerId: string, openedAt: string): string {
  assertWorkspaceId(workspaceId);
  if (workerId === "" || workerId.includes("::")) throw new Error(`not a Worker id: ${JSON.stringify(workerId)}`);
  assertKeyTime(openedAt, "a time");
  return `${workspaceId}::${workerId}::${DANGER_OPEN}@${openedAt}`;
}

/** The parts of an interrupt allowance's key, or null when it is not one `dangerOpenKey` makes. */
export function parseDangerOpenKey(key: string): { workspaceId: string; workerId: string; openedAt: string } | null {
  const parts = splitTimedKey(key);
  if (parts === null || parts.name !== DANGER_OPEN || parts.middle.includes("::")) return null;
  return { workspaceId: parts.workspaceId, workerId: parts.middle, openedAt: parts.at };
}

/** True when `stalls.json` may hold this key: an interrupt allowance (older builds' other keys are dropped). */
function isKnownStallsKey(key: string): boolean {
  return parseDangerOpenKey(key) !== null;
}

/** `<home>/orchestrator`. */
export function orchestratorDirOf(home: string): string {
  return join(home, ORCHESTRATOR_DIR_NAME);
}

/** Newest first: by `settledAt`, else by `at`; later in the file first on a tie. */
function newestFirst(entries: readonly Proposal[]): Proposal[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => timeOrZero(b.entry.settledAt ?? b.entry.at) - timeOrZero(a.entry.settledAt ?? a.entry.at) || b.index - a.index)
    .map(({ entry }) => entry);
}

/** A JSON file of the folder: `{ version: 1, entries }`. */
interface EntriesFile<E> {
  entries: E;
}

/**
 * The store rooted at the data folder `home` (from `resolveDataHome`). Creating
 * it touches nothing on disk.
 */
export function createOrchestratorStore(home: string, deps: OrchestratorStoreDeps = {}): OrchestratorStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const dir = orchestratorDirOf(home);

  /** One `{ version: 1, entries }` file of the folder: `parse` reads its entries, `cap` bounds them. */
  const entriesFile = <E>(
    folder: string,
    file: string,
    parse: (raw: unknown) => E,
    empty: () => E,
    cap: (entries: E) => E,
  ): JsonFileStore<EntriesFile<E>> =>
    createJsonFileStore<EntriesFile<E>>({
      home,
      dir: folder,
      file,
      version: FILE_VERSION,
      codes: { unwritable: WRITE_FAILED },
      parse: (body) => ({ entries: parse(body["entries"]) }),
      empty: () => ({ entries: empty() }),
      cap: ({ entries }) => ({ entries: cap(entries) }),
    });

  // The recorded commands in file order; an entry of the proposal era is
  // skipped like one that does not validate. The commands sent longest ago go
  // first past the limit.
  const commands = entriesFile(
    ORCHESTRATOR_DIR_NAME,
    PROPOSALS_FILE,
    (raw) => entriesOf(proposalSchema, raw).filter(isSentCommand),
    () => [],
    (entries) => capBy(entries, COMMAND_LOG_LIMIT, (entry) => timeOrZero(entry.settledAt ?? entry.at)),
  );
  const readCommands = (): Proposal[] => commands.read().entries;

  // The interrupt allowances (older builds' other keys are dropped); the ones
  // opened longest ago go first past the limit.
  const stalls = entriesFile<Record<string, StallEntry>>(
    ORCHESTRATOR_DIR_NAME,
    STALLS_FILE,
    (raw) => keyedEntriesOf(stallEntrySchema, raw, isKnownStallsKey),
    () => ({}),
    (entries) => Object.fromEntries(capBy(Object.entries(entries), STALL_ENTRY_LIMIT, ([, entry]) => timeOrZero(entry.raisedAt))),
  );
  const readStalls = (): Record<string, StallEntry> => stalls.read().entries;

  // The wakes in file order; the `WAKE_LOG_LIMIT` newest are kept.
  const wakes = entriesFile(ORCHESTRATOR_DIR_NAME, WAKES_FILE, (raw) => entriesOf(wakeEntrySchema, raw), () => [], (entries) => capBy(entries, WAKE_LOG_LIMIT));

  const allowanceOf = (key: string, entry: StallEntry, at: number): DangerAllowanceView | null => {
    const parts = parseDangerOpenKey(key);
    if (parts === null) return null;
    const until = timeOrZero(entry.raisedAt) + DANGER_ALLOWANCE_MS;
    return { key, workspaceId: parts.workspaceId, workerId: parts.workerId, openedAt: entry.raisedAt, until: new Date(until).toISOString(), open: at < until };
  };

  /** A project's notes file; the 20 newest are kept. */
  const notesFile = (workspaceId: string): JsonFileStore<EntriesFile<OrchestratorNote[]>> => {
    assertWorkspaceId(workspaceId);
    return entriesFile(join(ORCHESTRATOR_DIR_NAME, NOTES_DIR_NAME), `${workspaceId}.json`, (raw) => entriesOf(orchestratorNoteSchema, raw), () => [], (entries) => capBy(entries, MAX_NOTES));
  };

  const readNotes = (workspaceId: string): OrchestratorNote[] => notesFile(workspaceId).read().entries;

  /** The wakes in file order; an entry that does not validate is skipped and dropped by the next write. */
  const readWakes = (): WakeEntry[] => wakes.read().entries;

  return {
    dir,

    appendCommand(input) {
      const at = now().toISOString();
      const command = proposalSchema.parse({
        id: input.id ?? newId(),
        at,
        kind: "command",
        workspaceId: input.workspaceId,
        managerId: input.managerId,
        requestId: input.requestId,
        situation: input.situation,
        command: input.command,
        reason: input.reason,
        source: "chat",
        status: "sent",
        settledAt: at,
        sentText: input.sentText,
        outcome: input.outcome,
        error: null,
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
      });
      commands.update(({ entries }) => {
        if (entries.some((entry) => entry.id === command.id)) throw new Error(`command id already used: ${command.id}`);
        return { entries: [...entries, command] };
      });
      return command;
    },

    listCommands(limit) {
      const newest = newestFirst(readCommands());
      return limit === undefined ? newest : newest.slice(0, Math.max(0, limit));
    },

    openDangerAllowance(workspaceId, workerId) {
      const at = now();
      const key = dangerOpenKey(workspaceId, workerId, at.toISOString());
      const entry: StallEntry = { raisedAt: at.toISOString(), lastSeenAt: at.toISOString(), clearedAt: null, woke: false };
      stalls.update(({ entries }) => {
        const kept = Object.fromEntries(Object.entries(entries).filter(([other, stored]) => allowanceOf(other, stored, at.getTime())?.open !== false));
        return { entries: { ...kept, [key]: entry } };
      });
      return allowanceOf(key, entry, at.getTime())!;
    },

    isDangerOpen(workspaceId, workerId) {
      const at = now().getTime();
      return Object.entries(readStalls()).some(([key, entry]) => {
        const allowance = allowanceOf(key, entry, at);
        return allowance !== null && allowance.open && allowance.workspaceId === workspaceId && allowance.workerId === workerId;
      });
    },

    listDangerAllowances(filter = {}) {
      const at = now().getTime();
      return Object.entries(readStalls())
        .flatMap(([key, entry]) => {
          const allowance = allowanceOf(key, entry, at);
          if (allowance === null || (filter.open !== undefined && allowance.open !== filter.open)) return [];
          return [allowance];
        })
        .sort((a, b) => timeOrZero(a.openedAt) - timeOrZero(b.openedAt));
    },

    readNotes,

    appendNote(workspaceId, text, options = {}) {
      const notes = notesFile(workspaceId);
      const note = orchestratorNoteSchema.parse({ at: now().toISOString(), text: text.trim() });
      return notes.update(({ entries }) => ({ entries: [...(options.replace === true ? [] : entries), note] })).entries;
    },

    appendWake(input) {
      const entry = wakeEntrySchema.parse({
        orchestratorId: input.orchestratorId,
        at: now().toISOString(),
        endedAt: null,
        workspaceIds: [...new Set(input.workspaceIds)].sort().slice(0, MAX_WAKE_WORKSPACES),
        events: input.events,
      });
      wakes.update(({ entries }) => ({ entries: [...entries, entry] }));
      return entry;
    },

    endWake(orchestratorId, usage = null) {
      const end = now();
      const entries = readWakes();
      const index = entries.findIndex(
        (entry) => entry.orchestratorId === orchestratorId && entry.endedAt === null && timeOrZero(entry.at) <= end.getTime(),
      );
      if (index < 0) return null;
      // Usage that does not validate is unknown, and never costs the wake its end.
      const known = wakeUsageSchema.safeParse(usage);
      const ended: WakeEntry = { ...entries[index]!, endedAt: end.toISOString(), usage: known.success ? known.data : null };
      entries[index] = ended;
      wakes.write({ entries });
      return ended;
    },

    readWakes,

    deleteRetiredAssessments(workspaceId) {
      assertWorkspaceId(workspaceId);
      const path = join(dir, RETIRED_ASSESSMENTS_DIR_NAME, `${workspaceId}.jsonl`);
      assertNoSymlink(home, path, WRITE_FAILED);
      try {
        unlinkSync(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

