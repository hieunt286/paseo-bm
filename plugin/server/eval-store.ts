/**
 * Reading a paseo-bm data folder for the metrics (evaluation design §5,
 * autonomy design §A.12): what the replay (`scripts/eval/replay.ts`), the
 * suite's scoring (`scripts/eval/score.ts`) and the Insights RPC
 * (`insights-rpc.ts`) hand to `shared/eval-metrics.ts`.
 *
 * Read-only by construction: files are opened for reading only
 * (`readFileSync`, `readdirSync`), no lock is taken and nothing is written, so
 * it can run against the owner's real `~/.paseo-bm` while the plugin writes to
 * it. A line that does not parse, or a record that does not validate, is
 * counted and skipped; a store file that cannot be read is counted and skipped.
 *
 * What is read:
 *
 * - `traces/<workspaceId>/events-<YYYYMM>.jsonl` — the turn records, with the
 *   Dashboard's de-duplication (`dedupeRecords`);
 * - `traces/<workspaceId>/meta.json` — the workspace's label (`lastKnownName`)
 *   and directory (`lastKnownDirectory`, for A-6 and `writers-observed`, never
 *   shown);
 * - `decisions/<workspaceId>.json` — the stored decisions (Phase 1: A-1,
 *   A-2 (c), A-6), each entry handed on unvalidated;
 * - `orchestrator/proposals.json`, `orchestrator/stalls.json`,
 *   `orchestrator/wakes.json` (A-7), `orchestrator/interventions.json`
 *   (A-12) and the times of `orchestrator/notes/<workspaceId>.json`, when
 *   present.
 *
 * Moved here from the replay so the plugin can read with the very same code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { traceRecordSchema, traceWorkspaceMetaSchema, type TraceRecord } from "../shared/contracts";
import { workspaceOfStallKey, type EvalInput, type EvalNote } from "../shared/eval-metrics";
import { INTERVENTIONS_FILE_VERSION, interventionsFileSchema } from "../shared/interventions";
import { notesFileSchema, proposalLogSchema, stallRecordSchema, wakeLogSchema } from "../shared/orchestrator";
import { DECISIONS_FILE_VERSION } from "./decision-store";
import { dedupeRecords } from "./trace-store";

export interface StoreRead {
  /** De-duplicated records of every workspace. */
  records: TraceRecord[];
  /**
   * Per workspace id: its label and directory from `meta.json` (null when
   * absent), and how many lines of its `events-*.jsonl` did not parse or
   * validate (its share of `unknowns.malformedLines`).
   */
  workspaces: Map<string, { label: string | null; directory: string | null; malformedLines: number }>;
  /** `proposals.json` → `entries`, unvalidated; `undefined` when the file is absent. */
  proposals: unknown[] | undefined;
  /** `stalls.json` → `entries`, unvalidated; `undefined` when the file is absent. */
  stalls: Record<string, unknown> | undefined;
  /** Note times; `undefined` when there is no notes folder. */
  notes: EvalNote[] | undefined;
  /** Every workspace's `decisions/<workspaceId>.json` → `entries`, unvalidated; `undefined` when there is no decisions folder. */
  decisions: unknown[] | undefined;
  /** `wakes.json` → `entries`, unvalidated; `undefined` when the file is absent. */
  wakes: unknown[] | undefined;
  /** `interventions.json` → `entries`, unvalidated; `undefined` when the file is absent. */
  interventions: unknown[] | undefined;
  unknowns: {
    /** Lines of `events-*.jsonl` that did not parse or validate (a blank last line is not one). */
    malformedLines: number;
    /** Store files present but unreadable, or whose frame did not validate. */
    unreadableFiles: number;
    /** Records dropped as a second write of the same turn. */
    duplicateRecords: number;
  };
}

const EVENTS_FILE = /^events-\d{6}\.jsonl$/;

/** The frame of `decisions/<workspaceId>.json`; its entries are validated by the metric module. */
const decisionFileSchema = z.object({ version: z.number(), entries: z.array(z.unknown()) });

type Read = { kind: "absent" } | { kind: "bad" } | { kind: "ok"; value: unknown };

function readJson(path: string): Read {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "bad" };
  }
  try {
    return { kind: "ok", value: JSON.parse(body) as unknown };
  } catch {
    return { kind: "bad" };
  }
}

type Listing = { kind: "absent" } | { kind: "bad" } | { kind: "ok"; names: string[] };

/** The names in a folder, sorted; `directoriesOnly` keeps the sub-folders. */
function listDir(path: string, directoriesOnly = false): Listing {
  try {
    const entries = readdirSync(path, { withFileTypes: true });
    const names = entries.filter((entry) => !directoriesOnly || entry.isDirectory()).map((entry) => entry.name);
    return { kind: "ok", names: names.sort() };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "bad" };
  }
}

const namesOf = (listing: Listing): string[] => (listing.kind === "ok" ? listing.names : []);

/** True when `path` is a folder that can be listed. */
export function isReadableFolder(path: string): boolean {
  return listDir(path).kind === "ok";
}

/** Everything the metrics need from a data folder, read without writing. */
export function readStore(home: string): StoreRead {
  const unknowns = { malformedLines: 0, unreadableFiles: 0, duplicateRecords: 0 };
  const tracesDir = join(home, "traces");
  const collected: TraceRecord[] = [];
  const workspaces = new Map<string, { label: string | null; directory: string | null; malformedLines: number }>();

  const dirs = listDir(tracesDir, true);
  if (dirs.kind === "bad") unknowns.unreadableFiles += 1;
  for (const workspaceId of namesOf(dirs)) {
    const dir = join(tracesDir, workspaceId);
    const meta = readJson(join(dir, "meta.json"));
    const parsedMeta = meta.kind === "ok" ? traceWorkspaceMetaSchema.safeParse(meta.value) : null;
    if (meta.kind === "bad" || (parsedMeta !== null && !parsedMeta.success)) unknowns.unreadableFiles += 1;
    const known = parsedMeta?.success === true ? parsedMeta.data : null;
    const malformedBefore = unknowns.malformedLines;

    const files = listDir(dir);
    if (files.kind === "bad") unknowns.unreadableFiles += 1;
    for (const name of namesOf(files).filter((candidate) => EVENTS_FILE.test(candidate))) {
      let body: string;
      try {
        body = readFileSync(join(dir, name), "utf8");
      } catch {
        unknowns.unreadableFiles += 1;
        continue;
      }
      const lines = body.split("\n");
      for (const [index, line] of lines.entries()) {
        if (line === "") {
          // The newline that ends the last record leaves one final "", which is not a line.
          if (index !== lines.length - 1) unknowns.malformedLines += 1;
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          unknowns.malformedLines += 1;
          continue;
        }
        const result = traceRecordSchema.safeParse(parsed);
        if (result.success) collected.push(result.data);
        else unknowns.malformedLines += 1;
      }
    }
    workspaces.set(workspaceId, {
      label: known?.lastKnownName ?? null,
      directory: known?.lastKnownDirectory ?? null,
      malformedLines: unknowns.malformedLines - malformedBefore,
    });
  }
  const records = dedupeRecords(collected);
  unknowns.duplicateRecords = collected.length - records.length;

  const orchestratorDir = join(home, "orchestrator");
  let proposals: unknown[] | undefined;
  const proposalFile = readJson(join(orchestratorDir, "proposals.json"));
  if (proposalFile.kind === "ok") {
    const frame = proposalLogSchema.safeParse(proposalFile.value);
    if (frame.success) proposals = frame.data.entries;
    else unknowns.unreadableFiles += 1;
  } else if (proposalFile.kind === "bad") {
    unknowns.unreadableFiles += 1;
  }

  let stalls: Record<string, unknown> | undefined;
  const stallFile = readJson(join(orchestratorDir, "stalls.json"));
  if (stallFile.kind === "ok") {
    const frame = stallRecordSchema.safeParse(stallFile.value);
    if (frame.success) stalls = frame.data.entries;
    else unknowns.unreadableFiles += 1;
  } else if (stallFile.kind === "bad") {
    unknowns.unreadableFiles += 1;
  }

  let notes: EvalNote[] | undefined;
  const notesDir = join(orchestratorDir, "notes");
  const noteFiles = listDir(notesDir);
  if (noteFiles.kind === "bad") unknowns.unreadableFiles += 1;
  if (noteFiles.kind === "ok") {
    notes = [];
    for (const name of noteFiles.names.filter((candidate) => candidate.endsWith(".json"))) {
      const workspaceId = name.slice(0, -".json".length);
      const file = readJson(join(notesDir, name));
      const frame = file.kind === "ok" ? notesFileSchema.safeParse(file.value) : null;
      if (frame === null || !frame.success) {
        if (file.kind !== "absent") unknowns.unreadableFiles += 1;
        continue;
      }
      // Only the time is read: a note's text never leaves this function.
      for (const entry of frame.data.entries) {
        const noteAt = typeof entry === "object" && entry !== null ? (entry as { at?: unknown }).at : undefined;
        if (typeof noteAt === "string") notes.push({ workspaceId, at: noteAt });
      }
    }
  }

  let wakes: unknown[] | undefined;
  const wakeFile = readJson(join(orchestratorDir, "wakes.json"));
  if (wakeFile.kind === "ok") {
    const frame = wakeLogSchema.safeParse(wakeFile.value);
    if (frame.success) wakes = frame.data.entries;
    else unknowns.unreadableFiles += 1;
  } else if (wakeFile.kind === "bad") {
    unknowns.unreadableFiles += 1;
  }

  let interventions: unknown[] | undefined;
  const interventionFile = readJson(join(orchestratorDir, "interventions.json"));
  if (interventionFile.kind === "ok") {
    const frame = interventionsFileSchema.safeParse(interventionFile.value);
    // A file of another version is not this reader's to read, as the intervention store's own reader says.
    if (frame.success && frame.data.version === INTERVENTIONS_FILE_VERSION) interventions = frame.data.entries;
    else unknowns.unreadableFiles += 1;
  } else if (interventionFile.kind === "bad") {
    unknowns.unreadableFiles += 1;
  }

  let decisions: unknown[] | undefined;
  const decisionsDir = join(home, "decisions");
  const decisionFiles = listDir(decisionsDir);
  if (decisionFiles.kind === "bad") unknowns.unreadableFiles += 1;
  if (decisionFiles.kind === "ok") {
    decisions = [];
    for (const name of decisionFiles.names.filter((candidate) => candidate.endsWith(".json"))) {
      const file = readJson(join(decisionsDir, name));
      const frame = file.kind === "ok" ? decisionFileSchema.safeParse(file.value) : null;
      if (frame === null || !frame.success) {
        if (file.kind !== "absent") unknowns.unreadableFiles += 1;
        continue;
      }
      // A file of another version is not this reader's to read, as the decision store's own reader says.
      if (frame.data.version !== DECISIONS_FILE_VERSION) {
        unknowns.unreadableFiles += 1;
        continue;
      }
      decisions.push(...frame.data.entries);
    }
  }

  return { records, workspaces, proposals, stalls, notes, decisions, wakes, interventions, unknowns };
}

/** What a store read holds for some workspaces: the metric module's inputs, filtered. */
export interface WorkspaceSelection {
  records: TraceRecord[];
  proposals: unknown[] | undefined;
  stalls: Record<string, unknown> | undefined;
  notes: EvalNote[] | undefined;
  decisions: unknown[] | undefined;
  wakes: unknown[] | undefined;
  interventions: unknown[] | undefined;
}

/** A selection's metric inputs: the records, and each store file's entries, `undefined` when the file was not read. */
export type StoreInputs = Pick<WorkspaceSelection, "records"> & Partial<Omit<WorkspaceSelection, "records">>;

/**
 * The store part of `computeEvalMetrics`'s input, written once for the
 * replay, the suite's scoring and Insights: the records, and each file's
 * entries only when the file was read. An unread file leaves its key out,
 * because absent is not empty — A-7 and A-12 report whether their file was
 * read.
 */
export function evalInputsOf(selection: StoreInputs): Pick<EvalInput, "records" | "proposals" | "stalls" | "notes" | "decisions" | "wakes" | "interventions"> {
  return {
    records: selection.records,
    ...(selection.proposals === undefined ? {} : { proposals: selection.proposals }),
    ...(selection.stalls === undefined ? {} : { stalls: selection.stalls }),
    ...(selection.notes === undefined ? {} : { notes: selection.notes }),
    ...(selection.decisions === undefined ? {} : { decisions: selection.decisions }),
    ...(selection.wakes === undefined ? {} : { wakes: selection.wakes }),
    ...(selection.interventions === undefined ? {} : { interventions: selection.interventions }),
  };
}

/** The projects a wake record names; none when it names none (it then belongs to no selection but "all"). */
export function workspacesOfWake(entry: unknown): string[] {
  const value = typeof entry === "object" && entry !== null ? (entry as { workspaceIds?: unknown }).workspaceIds : undefined;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

const workspaceOfEntry = (entry: unknown): string | null => {
  const value = typeof entry === "object" && entry !== null ? (entry as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof value === "string" ? value : null;
};

/**
 * The records and Orchestrator entries of the given workspaces; `null` keeps
 * them all. A stall key is attributed by its `<workspaceId>::` prefix, a
 * proposal, a decision and an intervention by its `workspaceId`, a note by
 * its file, a wake by any of the projects whose events it carried.
 */
export function selectWorkspaces(store: StoreRead, workspaceIds: ReadonlySet<string> | null): WorkspaceSelection {
  const inWorkspace = (id: string | null): boolean => workspaceIds === null || (id !== null && workspaceIds.has(id));
  return {
    records: store.records.filter((record) => inWorkspace(record.workspaceId)),
    proposals: store.proposals?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    stalls:
      store.stalls === undefined ? undefined : Object.fromEntries(Object.entries(store.stalls).filter(([key]) => inWorkspace(workspaceOfStallKey(key)))),
    notes: store.notes?.filter((note) => inWorkspace(note.workspaceId)),
    decisions: store.decisions?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    wakes: store.wakes?.filter((entry) => workspaceIds === null || workspacesOfWake(entry).some((id) => workspaceIds.has(id))),
    interventions: store.interventions?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
  };
}

/** Workspace directory by id, for A-6's `rm -rf` rule and `writers-observed`'s file paths (autonomy design §F.1); never shown. */
export function workspaceDirectoriesOf(store: StoreRead): Record<string, string> {
  const directories: Record<string, string> = {};
  for (const [id, meta] of store.workspaces) if (meta.directory !== null) directories[id] = meta.directory;
  return directories;
}
