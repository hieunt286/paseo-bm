/**
 * The Orchestrator's data store: `<data folder>/orchestrator/` (Orchestrator
 * design §4.3, §5.4).
 *
 * The one module that reads and writes that folder:
 *
 * - `settings.json` — the projects with Autopilot on (`version: 3`; a
 *   `version: 2` file reads with none, and the Watch switch an older file
 *   still carries is ignored: autonomy design §A.8);
 * - `proposals.json` — the commands the Orchestrator sent itself, to Managers
 *   and Workers, the 200 newest (the loop guard and a project's last action
 *   read them). The entries of the proposal era — pending, dismissed and
 *   failed proposals, commands the owner sent from its former screen, and
 *   decisions asked before the decision store — are ignored and dropped by the
 *   next write (autonomy design §A.14);
 * - `stalls.json` — which Worker may be interrupted, for 10 minutes after a
 *   `danger` signal (design §6B.3). The stall, event and Worker-signal keys
 *   older builds kept here are ignored and dropped by the next write: stalls
 *   and signals are Inbox alerts now (`alert-store.ts`, autonomy design §A.8);
 * - `notes/<workspaceId>.json` — the Orchestrator's notes about a project, the
 *   20 newest (design §6B.4 `bm_note`);
 * - `model-corrections.json` — the models the creation hook replaced, the 500
 *   newest;
 * - `wakes.json` — each time the event bus woke the Orchestrator with a
 *   `BM-EVENTS` message and when that turn ended, the 500 newest: ids, times
 *   and a count only (evaluation design §4, A-7);
 * - `assessments/<workspaceId>.jsonl` — assessment results, one line per write,
 *   workflow assessments included.
 *
 * An old `nudges.json` from the first design is never read; cleanup deletes it
 * with the rest of the folder.
 *
 * Every operation is synchronous. The plugin server is one thread, so a
 * read-modify-write here cannot interleave with another one — which is what
 * lets a command be recorded, or an allowance be opened, without a lock.
 *
 * The containment rules are the trace store's: the folder is created `0700`
 * only by a write, never by a read; files are `0600`; the JSON files are
 * replaced atomically (temp file, then rename) and the assessments are
 * appended; a symlink anywhere below the data folder is refused. Paths are
 * built with `trace-store.ts`'s helpers, rooted at the data folder.
 *
 * Reads never repair a file. A missing, corrupt or unrecognised file reads as
 * its default — no Autopilot, no command, no allowance, nothing corrected,
 * nothing assessed — and the next write replaces it. In `proposals.json` and
 * `stalls.json` an entry that does not validate is skipped on its own, and
 * dropped by the next write.
 */
import { randomUUID } from "node:crypto";
import { fsyncSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DANGER_ALLOWANCE_MS,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  MAX_NOTES,
  MAX_WAKE_WORKSPACES,
  WORKFLOW_ASSESSMENT_TRACE_ID,
  allowOf,
  assessmentLineSchema,
  autopilotEntrySchema,
  isSentCommand,
  knownCategories,
  modelCorrectionLogSchema,
  modelCorrectionSchema,
  notesFileSchema,
  orchestratorNoteSchema,
  orchestratorSettingsSchema,
  proposalLogSchema,
  proposalSchema,
  stallEntrySchema,
  stallRecordSchema,
  wakeEntrySchema,
  wakeLogSchema,
  type AssessmentLine,
  type AutopilotEntry,
  type CommandTarget,
  type ModelCorrection,
  type OrchestratorNote,
  type OrchestratorSettings,
  type Proposal,
  type ProposalOutcome,
  type StallEntry,
  type WakeEntry,
} from "../shared/orchestrator";
import type { GateCategory } from "../shared/decision-gate";
import { TRACES_DIR_NAME, ensureDataHome } from "./data-home";
import {
  WORKSPACE_ID_PATTERN,
  assertNoSymlinkOnPath,
  assertWorkspaceId,
  capText,
  closeQuietly,
  ensureStoreDir,
  openStoreFileForAppend,
  writeStoreFileAtomically,
  type TraceStoreLocation,
} from "./trace-store";

/** The folder inside the data folder; removing paseo-bm's data deletes it whole. */
export const ORCHESTRATOR_DIR_NAME = "orchestrator";
export const ORCHESTRATOR_SETTINGS_FILE = "settings.json";
export const PROPOSALS_FILE = "proposals.json";
export const STALLS_FILE = "stalls.json";
export const MODEL_CORRECTIONS_FILE = "model-corrections.json";
export const WAKES_FILE = "wakes.json";
export const ASSESSMENTS_DIR_NAME = "assessments";
export const NOTES_DIR_NAME = "notes";

/** At most this many recorded commands; the oldest go first (design §5.4). */
export const COMMAND_LOG_LIMIT = 200;
/** At most this many entries in `stalls.json` (interrupt allowances); the oldest go first. */
export const STALL_ENTRY_LIMIT = 500;
/** The model-correction log keeps this many of the newest entries (design §4.3). */
export const MODEL_CORRECTION_LIMIT = 500;
/** `wakes.json` keeps this many of the newest wakes (evaluation design §4, A-7). */
export const WAKE_LOG_LIMIT = 500;
/** Longest `raw` reply kept on an assessment line (design §5.3: 8 KB, like one trace message). */
export const MAX_ASSESSMENT_RAW_CHARS = 8 * 1024;

/** Everything this module takes from outside, injectable so a test runs on fixed time. */
export interface OrchestratorStoreDeps {
  now?: () => Date;
  /** A new command id; `randomUUID` by default. */
  newId?: () => string;
  /** Where a failed correction write is reported; `console.warn` by default. */
  log?: (message: string) => void;
}

/**
 * A command the Orchestrator sent itself (design §6A, §6B.1, §6B.4), recorded
 * once it is delivered: on Autopilot or on the owner's word in its chat
 * (`source`). `situation` is its `re:` line, `command` its body, `reason` its
 * `why:`, `sentText` the whole block. A `worker` command names `workerId`,
 * and `managerId` is that Worker's Manager (who got the copy) or null.
 */
export interface SentCommandInput {
  workspaceId: string;
  managerId: string | null;
  requestId: string | null;
  situation: string;
  command: string;
  reason: string;
  source: "autopilot" | "chat";
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

/** What `deleteAssessmentsFor` removes: every line of these traces or requests. */
export interface AssessmentDeleteScope {
  traceIds?: readonly string[];
  requestIds?: readonly string[];
}

export interface OrchestratorStore {
  /** `<data folder>/orchestrator`. */
  readonly dir: string;

  /**
   * The switches (`version: 3`). A `version: 2`, first-design (`version: 1`)
   * or unreadable file reads as the default: no Autopilot. A `watch` field is
   * ignored. An Autopilot entry that does not validate is skipped on its own.
   */
  readSettings(): OrchestratorSettings;
  /** True when the project has Autopilot on. */
  isAutopilot(workspaceId: string): boolean;
  /**
   * Turns Autopilot on or off for one project (design §6A). Turning it on
   * records `since` (now) and `by`; turning on a project that already has it
   * keeps its entry. Writes nothing when nothing changes. Returns the
   * switches as stored.
   */
  setAutopilot(workspaceId: string, enabled: boolean, by?: AutopilotEntry["by"]): OrchestratorSettings;
  /**
   * The gate categories the owner allowed for the project (design §6B.5); none
   * when it has no Autopilot entry or the entry allows none.
   */
  allowedCategories(workspaceId: string): GateCategory[];
  /**
   * Sets the categories allowed for a project with Autopilot on (unknown names
   * dropped, each once, in `GATE_CATEGORIES` order; an empty list removes
   * `allow`). Returns the switches as stored, or null — writing nothing — when
   * the project has Autopilot off: the allowance belongs to the Autopilot
   * entry, so turning Autopilot off forgets it and turning it on starts with none.
   */
  setAutopilotAllow(workspaceId: string, allow: readonly GateCategory[]): OrchestratorSettings | null;

  /** Records a command the Orchestrator sent (`status: sent`, stamped now) and returns the entry stored. */
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

  /** Records a model the hook replaced. Never throws; a failed write is logged once. */
  appendCorrection(entry: ModelCorrection): void;
  readCorrections(): ModelCorrection[];

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
   * closes one wake may already have delivered the next. Returns the wake it
   * ended, or null — writing nothing — when none was open.
   */
  endWake(orchestratorId: string): WakeEntry | null;
  /** The recorded wakes in file order (oldest first). */
  readWakes(): WakeEntry[];

  /** Appends one assessment line; `raw` is cut to 8 KB. */
  appendAssessment(workspaceId: string, line: AssessmentLine): AssessmentLine;
  /** The newest line of each assessment, newest first. */
  readAssessments(workspaceId: string): AssessmentLine[];
  /**
   * Rewrites the workspace's file without the named traces' lines — and
   * without any workflow line whose scope names a deleted request; returns
   * how many lines went.
   */
  deleteAssessmentsFor(workspaceId: string, scope: AssessmentDeleteScope): number;
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

/**
 * The frame of a `version: 3` settings file; each Autopilot entry is validated
 * on its own, so one bad entry costs only itself. A `watch` field of an older
 * build is not read.
 */
const settingsFileSchema = z.object({
  version: z.literal(3),
  autopilot: z.record(z.string(), z.unknown()),
});

/** A workspace id the store accepts (`assertWorkspaceId`), without throwing. */
function isWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_ID_PATTERN.test(workspaceId) && workspaceId !== "." && workspaceId !== "..";
}

/** `<home>/orchestrator`. */
export function orchestratorDirOf(home: string): string {
  return join(home, ORCHESTRATOR_DIR_NAME);
}

/**
 * One warning per process for the correction log: the hook runs on every agent
 * creation, and a folder that cannot be written stays that way.
 */
let correctionWriteWarned = false;

/** Test-only: lets the next failed correction write warn again. */
export function resetCorrectionWarning(): void {
  correctionWriteWarned = false;
}

function readJson(path: string, root: string): unknown | null {
  // Before the read, so a symlinked path is refused rather than followed.
  assertNoSymlinkOnPath(root, path);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** A time for ordering; an unparsable one sorts first, so it is evicted first. */
function timeOf(iso: string | null): number {
  if (iso === null) return 0;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

/** Keeps `proposals.json` at `COMMAND_LOG_LIMIT`: the commands sent longest ago go first. */
function capCommands(entries: Proposal[]): Proposal[] {
  return entries.length <= COMMAND_LOG_LIMIT ? entries : newestFirst(entries).slice(0, COMMAND_LOG_LIMIT).reverse();
}

/** Keeps `stalls.json` at `STALL_ENTRY_LIMIT`: the allowances opened longest ago go first. */
function capStalls(entries: Record<string, StallEntry>): Record<string, StallEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= STALL_ENTRY_LIMIT) return entries;
  const evict = keys
    .map((key, index) => ({ key, index, entry: entries[key]! }))
    .sort((a, b) => timeOf(a.entry.raisedAt) - timeOf(b.entry.raisedAt) || a.index - b.index)
    .slice(0, keys.length - STALL_ENTRY_LIMIT)
    .map(({ key }) => key);
  const kept = { ...entries };
  for (const key of evict) delete kept[key];
  return kept;
}

/** Newest first: by `settledAt`, else by `at`; later in the file first on a tie. */
function newestFirst(entries: readonly Proposal[]): Proposal[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => timeOf(b.entry.settledAt ?? b.entry.at) - timeOf(a.entry.settledAt ?? a.entry.at) || b.index - a.index)
    .map(({ entry }) => entry);
}

/**
 * The store rooted at the data folder `home` (from `resolveDataHome`). Creating
 * it touches nothing on disk.
 */
export function createOrchestratorStore(home: string, deps: OrchestratorStoreDeps = {}): OrchestratorStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const log = deps.log ?? ((message: string) => console.warn(message));
  const dir = orchestratorDirOf(home);
  const assessmentsDir = join(dir, ASSESSMENTS_DIR_NAME);
  // `trace-store.ts` roots its symlink checks at the parent of `tracesDir`,
  // which is exactly the data folder.
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };
  const settingsPath = join(dir, ORCHESTRATOR_SETTINGS_FILE);
  const proposalsPath = join(dir, PROPOSALS_FILE);
  const stallsPath = join(dir, STALLS_FILE);
  const correctionsPath = join(dir, MODEL_CORRECTIONS_FILE);
  const wakesPath = join(dir, WAKES_FILE);
  const notesDir = join(dir, NOTES_DIR_NAME);

  /** Creates the data folder and `orchestrator/` (0700) on the first write. */
  const ensureDir = (directory: string = dir): void => {
    ensureDataHome(home);
    ensureStoreDir(location.tracesDir, directory);
  };

  const writeJson = (path: string, value: unknown): void => {
    ensureDir();
    writeStoreFileAtomically(location, path, `${JSON.stringify(value, null, 2)}\n`);
  };

  /** The recorded commands in file order; an entry of the proposal era is skipped like one that does not validate. */
  const readCommands = (): Proposal[] => {
    const parsed = proposalLogSchema.safeParse(readJson(proposalsPath, home));
    if (!parsed.success) return [];
    return parsed.data.entries.flatMap((entry) => {
      const valid = proposalSchema.safeParse(entry);
      return valid.success && isSentCommand(valid.data) ? [valid.data] : [];
    });
  };

  const writeCommands = (entries: Proposal[]): void => {
    writeJson(proposalsPath, { version: 1, entries: capCommands(entries) });
  };

  const readSettings = (): OrchestratorSettings => {
    const raw = readJson(settingsPath, home);
    // A `version: 2` file (the Watch switch alone) and a first-design file
    // (`version: 1`, `nudge`) fail the parse and read as the default.
    const frame = settingsFileSchema.safeParse(raw);
    if (!frame.success) return structuredClone(DEFAULT_ORCHESTRATOR_SETTINGS);
    // `Object.fromEntries` defines each key as an own property, so no key can reach a prototype.
    const autopilot = Object.fromEntries(
      Object.entries(frame.data.autopilot).flatMap(([workspaceId, entry]) => {
        const valid = autopilotEntrySchema.safeParse(entry);
        return valid.success && isWorkspaceId(workspaceId) ? [[workspaceId, valid.data] as const] : [];
      }),
    );
    return { version: 3, autopilot };
  };

  const writeSettings = (settings: OrchestratorSettings): OrchestratorSettings => {
    const valid = orchestratorSettingsSchema.parse(settings);
    writeJson(settingsPath, valid);
    return valid;
  };

  const readStalls = (): Record<string, StallEntry> => {
    const parsed = stallRecordSchema.safeParse(readJson(stallsPath, home));
    if (!parsed.success) return {};
    const entries: Record<string, StallEntry> = {};
    for (const [key, entry] of Object.entries(parsed.data.entries)) {
      const valid = stallEntrySchema.safeParse(entry);
      if (valid.success && isKnownStallsKey(key)) entries[key] = valid.data;
    }
    return entries;
  };

  const writeStalls = (entries: Record<string, StallEntry>): void => {
    writeJson(stallsPath, { version: 1, entries: capStalls(entries) });
  };

  const allowanceOf = (key: string, entry: StallEntry, at: number): DangerAllowanceView | null => {
    const parts = parseDangerOpenKey(key);
    if (parts === null) return null;
    const until = timeOf(entry.raisedAt) + DANGER_ALLOWANCE_MS;
    return { key, workspaceId: parts.workspaceId, workerId: parts.workerId, openedAt: entry.raisedAt, until: new Date(until).toISOString(), open: at < until };
  };

  const notesPath = (workspaceId: string): string => {
    assertWorkspaceId(workspaceId);
    const path = join(notesDir, `${workspaceId}.json`);
    assertNoSymlinkOnPath(home, path);
    return path;
  };

  const readNotes = (workspaceId: string): OrchestratorNote[] => {
    const parsed = notesFileSchema.safeParse(readJson(notesPath(workspaceId), home));
    if (!parsed.success) return [];
    return parsed.data.entries.flatMap((entry) => {
      const valid = orchestratorNoteSchema.safeParse(entry);
      return valid.success ? [valid.data] : [];
    });
  };

  const assessmentsPath = (workspaceId: string): string => {
    assertWorkspaceId(workspaceId);
    const path = join(assessmentsDir, `${workspaceId}.jsonl`);
    assertNoSymlinkOnPath(home, path);
    return path;
  };

  const readAssessmentLines = (path: string): string[] => {
    try {
      return readFileSync(path, "utf8").split("\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const parseLine = (line: string): AssessmentLine | null => {
    if (line.trim() === "") return null;
    try {
      const parsed = assessmentLineSchema.safeParse(JSON.parse(line));
      return parsed.success ? parsed.data : null;
    } catch {
      // A half-written trailing line, or one a person edited by hand.
      return null;
    }
  };

  const readCorrections = (): ModelCorrection[] => {
    const parsed = modelCorrectionLogSchema.safeParse(readJson(correctionsPath, home));
    return parsed.success ? parsed.data.entries : [];
  };

  /** The wakes in file order; an entry that does not validate is skipped and dropped by the next write. */
  const readWakes = (): WakeEntry[] => {
    const parsed = wakeLogSchema.safeParse(readJson(wakesPath, home));
    if (!parsed.success) return [];
    return parsed.data.entries.flatMap((entry) => {
      const valid = wakeEntrySchema.safeParse(entry);
      return valid.success ? [valid.data] : [];
    });
  };

  /** Keeps the `WAKE_LOG_LIMIT` newest wakes, in file order. */
  const writeWakes = (entries: readonly WakeEntry[]): void => {
    writeJson(wakesPath, { version: 1, entries: entries.slice(-WAKE_LOG_LIMIT) });
  };

  return {
    dir,

    readSettings,

    isAutopilot(workspaceId) {
      return Object.hasOwn(readSettings().autopilot, workspaceId);
    },

    setAutopilot(workspaceId, enabled, by) {
      assertWorkspaceId(workspaceId);
      const current = readSettings();
      const on = Object.hasOwn(current.autopilot, workspaceId);
      if (on === enabled) return current;
      const others = Object.entries(current.autopilot).filter(([id]) => id !== workspaceId);
      const entry: AutopilotEntry = { enabled: true, since: now().toISOString(), ...(by === undefined ? {} : { by }) };
      // `Object.fromEntries`, not an assignment: a workspace id is never a prototype key.
      const autopilot = Object.fromEntries(enabled ? [...others, [workspaceId, entry] as const] : others);
      return writeSettings({ ...current, autopilot });
    },

    allowedCategories(workspaceId) {
      const { autopilot } = readSettings();
      return Object.hasOwn(autopilot, workspaceId) ? allowOf(autopilot[workspaceId]) : [];
    },

    setAutopilotAllow(workspaceId, allow) {
      assertWorkspaceId(workspaceId);
      const current = readSettings();
      if (!Object.hasOwn(current.autopilot, workspaceId)) return null;
      const old = current.autopilot[workspaceId]!;
      const known = knownCategories(allow);
      const entry: AutopilotEntry = {
        enabled: true,
        since: old.since,
        ...(old.by === undefined ? {} : { by: old.by }),
        ...(known.length === 0 ? {} : { allow: known }),
      };
      const autopilot = Object.fromEntries(Object.entries(current.autopilot).map(([id, old]) => [id, id === workspaceId ? entry : old] as const));
      return writeSettings({ ...current, autopilot });
    },

    appendCommand(input) {
      const entries = readCommands();
      const at = now().toISOString();
      const command = proposalSchema.parse({
        id: newId(),
        at,
        kind: "command",
        workspaceId: input.workspaceId,
        managerId: input.managerId,
        requestId: input.requestId,
        situation: input.situation,
        command: input.command,
        reason: input.reason,
        source: input.source,
        status: "sent",
        settledAt: at,
        sentText: input.sentText,
        outcome: input.outcome,
        error: null,
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
      });
      if (entries.some((entry) => entry.id === command.id)) throw new Error(`command id already used: ${command.id}`);
      writeCommands([...entries, command]);
      return command;
    },

    listCommands(limit) {
      const newest = newestFirst(readCommands());
      return limit === undefined ? newest : newest.slice(0, Math.max(0, limit));
    },

    openDangerAllowance(workspaceId, workerId) {
      const at = now();
      const key = dangerOpenKey(workspaceId, workerId, at.toISOString());
      const entries = Object.fromEntries(
        Object.entries(readStalls()).filter(([other, entry]) => allowanceOf(other, entry, at.getTime())?.open !== false),
      );
      const entry: StallEntry = { raisedAt: at.toISOString(), lastSeenAt: at.toISOString(), clearedAt: null, woke: false };
      entries[key] = entry;
      writeStalls(entries);
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
        .sort((a, b) => timeOf(a.openedAt) - timeOf(b.openedAt));
    },

    readNotes,

    appendNote(workspaceId, text, options = {}) {
      const path = notesPath(workspaceId);
      const note = orchestratorNoteSchema.parse({ at: now().toISOString(), text: text.trim() });
      const kept = options.replace === true ? [] : readNotes(workspaceId);
      const entries = [...kept, note].slice(-MAX_NOTES);
      ensureDir(notesDir);
      writeStoreFileAtomically(location, path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
      return entries;
    },

    appendCorrection(entry) {
      try {
        const valid = modelCorrectionSchema.parse(entry);
        const entries = [...readCorrections(), valid].slice(-MODEL_CORRECTION_LIMIT);
        writeJson(correctionsPath, { version: 1, entries });
      } catch (error) {
        // The hook must never fail a creation over its own bookkeeping (§4.3).
        if (correctionWriteWarned) return;
        correctionWriteWarned = true;
        log(`[paseo-bm] could not record a model correction in ${correctionsPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    readCorrections,

    appendWake(input) {
      const entry = wakeEntrySchema.parse({
        orchestratorId: input.orchestratorId,
        at: now().toISOString(),
        endedAt: null,
        workspaceIds: [...new Set(input.workspaceIds)].sort().slice(0, MAX_WAKE_WORKSPACES),
        events: input.events,
      });
      writeWakes([...readWakes(), entry]);
      return entry;
    },

    endWake(orchestratorId) {
      const end = now();
      const entries = readWakes();
      const index = entries.findIndex(
        (entry) => entry.orchestratorId === orchestratorId && entry.endedAt === null && timeOf(entry.at) <= end.getTime(),
      );
      if (index < 0) return null;
      const ended: WakeEntry = { ...entries[index]!, endedAt: end.toISOString() };
      entries[index] = ended;
      writeWakes(entries);
      return ended;
    },

    readWakes,

    appendAssessment(workspaceId, line) {
      const path = assessmentsPath(workspaceId);
      const valid = assessmentLineSchema.parse(line);
      const stored: AssessmentLine = valid.raw === undefined ? valid : { ...valid, raw: capText(valid.raw, MAX_ASSESSMENT_RAW_CHARS).text };
      ensureDir(assessmentsDir);
      let fd: number | null = null;
      try {
        fd = openStoreFileForAppend(path);
        writeSync(fd, `${JSON.stringify(stored)}\n`);
        fsyncSync(fd);
      } finally {
        closeQuietly(fd);
      }
      return stored;
    },

    readAssessments(workspaceId) {
      const latest = new Map<string, AssessmentLine>();
      for (const text of readAssessmentLines(assessmentsPath(workspaceId))) {
        const line = parseLine(text);
        if (line === null) continue;
        // Re-inserting moves the key to the end, so the map ends in the order
        // of each assessment's newest line.
        latest.delete(line.assessmentId);
        latest.set(line.assessmentId, line);
      }
      return [...latest.values()].reverse();
    },

    deleteAssessmentsFor(workspaceId, scope) {
      const path = assessmentsPath(workspaceId);
      const traceIds = new Set(scope.traceIds ?? []);
      const requestIds = new Set(scope.requestIds ?? []);
      if (traceIds.size === 0 && requestIds.size === 0) return 0;
      const named = [...traceIds, ...requestIds];

      const lines = readAssessmentLines(path).filter((text) => text.trim() !== "");
      const kept = lines.filter((text) => {
        const line = parseLine(text);
        if (line !== null) {
          if (line.traceId === WORKFLOW_ASSESSMENT_TRACE_ID) {
            // A workflow assessment may quote any request it covered, so it
            // goes with the first of them that is deleted.
            return !(line.scope?.requestIds ?? []).some((id) => requestIds.has(id));
          }
          return !traceIds.has(line.traceId) && !(line.requestId !== null && requestIds.has(line.requestId));
        }
        // A line that no longer parses cannot say whose it is; it goes if it
        // names one of the deleted traces anywhere, so no excerpt of a deleted
        // trace is left behind.
        return !named.some((id) => text.includes(JSON.stringify(id)));
      });
      const removed = lines.length - kept.length;
      if (removed === 0) return 0;
      if (kept.length === 0) {
        unlinkSync(path);
      } else {
        ensureDir(assessmentsDir);
        writeStoreFileAtomically(location, path, `${kept.join("\n")}\n`);
      }
      return removed;
    },
  };
}

