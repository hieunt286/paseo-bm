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
 *   present;
 * - the Missions places' ids (A-14, ADR-034): `ui/missions-home.json` (the
 *   root and the earlier shared home), `missions/index.json` and each
 *   `missions/<missionId>.json` (each mission's workspace); only ids are read;
 * - `missions/<missionId>.decisions.json` (the `m:` decisions, M-41) and the
 *   request ids of `missions/<missionId>.roster.json` (which requests each
 *   mission holds, M-41 (a); delivery line design §13);
 * - the missions' placements (M-37, M-38; delivery line design §3.1): the
 *   `placements` map of `missions/index.json` and each mission file's
 *   placements with a workspace — the workspace, mission and repo key only;
 * - M-36, M-40 and M-42 (delivery line design §13): each request's chain
 *   fields and batch results from `requests/<workspaceId>.json`, the rollover
 *   figures of `coordination/settings.json`, and the times and endings of
 *   `orchestrator/compactions.json` and `handoffs/<id>.json` — only those
 *   fields are kept (a handoff's note and brief never leave this function).
 *
 * Moved here from the replay so the plugin can read with the very same code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { traceRecordSchema, traceWorkspaceMetaSchema, type TraceRecord } from "../shared/contracts";
import { workspaceOfStallKey, type EvalInput, type EvalNote } from "../shared/eval-metrics";
import { INTERVENTIONS_FILE_VERSION, interventionsFileSchema } from "../shared/interventions";
import { dangerLogSchema, notesFileSchema, proposalLogSchema, stallRecordSchema, wakeLogSchema } from "../shared/orchestrator";
import { COMPACTIONS_FILE, COMPACTIONS_FILE_VERSION } from "./compaction-store";
import { COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE } from "./coordination-store";
import { DECISIONS_FILE_VERSION } from "./decision-store";
import { HANDOFF_FILE_VERSION, HANDOFFS_DIR_NAME } from "./handoff-store";
import { REQUEST_REGISTRY_VERSION, REQUESTS_DIR_NAME } from "./request-registry";
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
  /** `dangers.json` → `entries`, unvalidated; `undefined` when the file is absent (A-13). */
  dangers: unknown[] | undefined;
  /** The Missions places' workspace ids (A-14, ADR-034); empty when none is known. */
  missionsWorkspaceIds: string[];
  /** Every `missions/<missionId>.decisions.json` → `entries`, unvalidated (M-41); `undefined` when there is no missions folder. */
  missionDecisions: unknown[] | undefined;
  /** Each mission's requests (`missions/<missionId>.roster.json`): ids only; `undefined` when there is no missions folder. */
  missionRequests: Record<string, Array<{ requestId: string; workspaceId: string | null }>> | undefined;
  /** Each placement workspace's mission and repo key (M-37, M-38): the index's map, then each mission file's placements; `undefined` when there is no missions folder. */
  placements: Record<string, { missionId: string; repo: string }> | undefined;
  /** Every `requests/<workspaceId>.json` → `requests`, each as its chain fields and batch results (M-36, M-40); `undefined` when there is no requests folder. */
  requests: unknown[] | undefined;
  /** `coordination/settings.json` as read (M-36's rollover figures); `undefined` when the file is absent or unreadable. */
  coordinationSettings: unknown;
  /** `compactions.json` → `entries`, each as its workspace, times and ending (M-42); `undefined` when the file is absent. */
  compactions: unknown[] | undefined;
  /** Every `handoffs/<id>.json` → `handoff`, as its workspace, times and ending (M-42); `undefined` when there is no handoffs folder. */
  handoffs: unknown[] | undefined;
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
/** `missions/<missionId>.json`, `.decisions.json`, `.roster.json` (mission-store.ts, mission-decisions.ts, mission-roster.ts). */
const MISSION_FILE = /^(mis-[0-9a-f]{10})\.json$/;
const MISSION_DECISIONS_FILE = /^(mis-[0-9a-f]{10})\.decisions\.json$/;
const MISSION_ROSTER_FILE = /^(mis-[0-9a-f]{10})\.roster\.json$/;

/** The frame of `decisions/<workspaceId>.json`; its entries are validated by the metric module. */
const decisionFileSchema = z.object({ version: z.number(), entries: z.array(z.unknown()) });
/** The frames of `requests/<workspaceId>.json`, `orchestrator/compactions.json` and `handoffs/<id>.json`; their entries are validated by the metric module. */
const registryFileSchema = z.object({ schemaVersion: z.number(), requests: z.array(z.unknown()) });
const compactionsFileSchema = z.object({ version: z.number(), entries: z.array(z.unknown()) });
const handoffFileSchema = z.object({ version: z.number(), handoff: z.unknown() });

/** Only these fields of an object; anything else (a note, a brief, a reason) is left behind. */
function pick(value: unknown, keys: readonly string[]): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}
const REGISTRY_KEYS = ["requestId", "workspaceId", "continuationOf", "chainRootId", "continuedBy"] as const;
const MAINTENANCE_KEYS = ["workspaceId", "requestId", "requestedAt", "endedAt", "ending"] as const;

/** A registry entry as the metrics read it: its chain fields, and each batch's id and result times. */
function registryEntryOf(entry: unknown): unknown {
  const picked = pick(entry, REGISTRY_KEYS);
  const batches = (entry as { reviews?: { batches?: unknown } } | null)?.reviews?.batches;
  if (typeof picked !== "object" || picked === null || !Array.isArray(batches)) return picked;
  return {
    ...picked,
    reviews: {
      batches: batches.map((batch) => {
        const results = (batch as { results?: unknown } | null)?.results;
        return { ...(pick(batch, ["batchId"]) as object), ...(Array.isArray(results) ? { results: results.map((result) => pick(result, ["at"])) } : {}) };
      }),
    },
  };
}

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

  let dangers: unknown[] | undefined;
  const dangerFile = readJson(join(orchestratorDir, "dangers.json"));
  if (dangerFile.kind === "ok") {
    const frame = dangerLogSchema.safeParse(dangerFile.value);
    if (frame.success) dangers = frame.data.entries;
    else unknowns.unreadableFiles += 1;
  } else if (dangerFile.kind === "bad") {
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

  // A-14: the Missions places (ADR-034) — the root and the earlier home from `ui/missions-home.json`, each mission's workspace from the missions index; only ids are read.
  const missionsWorkspaceIds: string[] = [];
  const idOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  const homeFile = readJson(join(home, "ui", "missions-home.json"));
  if (homeFile.kind === "ok" && typeof homeFile.value === "object" && homeFile.value !== null) {
    const record = homeFile.value as { workspaceId?: unknown; legacyWorkspaceId?: unknown };
    for (const id of [idOf(record.workspaceId), idOf(record.legacyWorkspaceId)]) if (id !== null) missionsWorkspaceIds.push(id);
  }
  const addPlace = (id: string | null) => {
    if (id !== null && !missionsWorkspaceIds.includes(id)) missionsWorkspaceIds.push(id);
  };
  const workspaceIdOf = (value: unknown): string | null => (typeof value === "object" && value !== null ? idOf((value as { workspaceId?: unknown }).workspaceId) : null);
  const missionsDir = join(home, "missions");
  const indexFile = readJson(join(missionsDir, "index.json"));
  const entries = indexFile.kind === "ok" && typeof indexFile.value === "object" && indexFile.value !== null ? (indexFile.value as { missions?: unknown }).missions : undefined;
  if (Array.isArray(entries)) for (const entry of entries) addPlace(workspaceIdOf(entry));
  // M-37, M-38 (delivery line design §3.1): each placement workspace's mission and repo key, the index's map first.
  const placementsRead: Record<string, { missionId: string; repo: string }> = {};
  const addPlacement = (workspaceId: string | null, missionId: string | null, repo: string | null) => {
    if (workspaceId !== null && missionId !== null && repo !== null && !(workspaceId in placementsRead)) placementsRead[workspaceId] = { missionId, repo };
  };
  const indexPlacements = indexFile.kind === "ok" && typeof indexFile.value === "object" && indexFile.value !== null ? (indexFile.value as { placements?: unknown }).placements : undefined;
  if (typeof indexPlacements === "object" && indexPlacements !== null && !Array.isArray(indexPlacements)) {
    for (const [workspaceId, entry] of Object.entries(indexPlacements as Record<string, unknown>)) {
      const fields = typeof entry === "object" && entry !== null ? (entry as { missionId?: unknown; repo?: unknown }) : {};
      addPlacement(idOf(workspaceId), idOf(fields.missionId), idOf(fields.repo));
    }
  }

  // M-41 (delivery line design §13): the mission decisions and each mission's requests; and each mission file's
  // workspace, so an index older than a mission still finds its place (the mission store rebuilds a stale index; this reader does not).
  let missionDecisions: unknown[] | undefined;
  let missionRequests: Record<string, Array<{ requestId: string; workspaceId: string | null }>> | undefined;
  let placements: Record<string, { missionId: string; repo: string }> | undefined;
  const missionFiles = listDir(missionsDir);
  if (missionFiles.kind === "bad") unknowns.unreadableFiles += 1;
  if (missionFiles.kind === "ok") {
    missionDecisions = [];
    missionRequests = {};
    for (const name of missionFiles.names) {
      const mission = MISSION_FILE.exec(name);
      if (mission !== null) {
        const file = readJson(join(missionsDir, name));
        if (file.kind === "ok") {
          addPlace(workspaceIdOf(file.value));
          // A mission file newer than the index still gives its placements (delivery line design §3.2).
          const placed = typeof file.value === "object" && file.value !== null ? (file.value as { placements?: unknown }).placements : undefined;
          if (Array.isArray(placed)) for (const placement of placed) addPlacement(workspaceIdOf(placement), mission[1]!, typeof placement === "object" && placement !== null ? idOf((placement as { repo?: unknown }).repo) : null);
        } else if (file.kind === "bad") unknowns.unreadableFiles += 1;
        continue;
      }
      const decided = MISSION_DECISIONS_FILE.exec(name);
      if (decided !== null) {
        const file = readJson(join(missionsDir, name));
        const frame = file.kind === "ok" ? decisionFileSchema.safeParse(file.value) : null;
        if (frame === null || !frame.success || frame.data.version !== DECISIONS_FILE_VERSION) {
          if (file.kind !== "absent") unknowns.unreadableFiles += 1;
          continue;
        }
        missionDecisions.push(...frame.data.entries);
        continue;
      }
      const roster = MISSION_ROSTER_FILE.exec(name);
      if (roster !== null) {
        const file = readJson(join(missionsDir, name));
        const requests = file.kind === "ok" && typeof file.value === "object" && file.value !== null ? (file.value as { requests?: unknown }).requests : undefined;
        if (!Array.isArray(requests)) {
          if (file.kind !== "absent") unknowns.unreadableFiles += 1;
          continue;
        }
        const ids: Array<{ requestId: string; workspaceId: string | null }> = [];
        for (const request of requests) {
          const requestId = typeof request === "object" && request !== null ? idOf((request as { requestId?: unknown }).requestId) : null;
          if (requestId !== null) ids.push({ requestId, workspaceId: workspaceIdOf(request) });
        }
        missionRequests[roster[1]!] = ids;
      }
    }
    placements = placementsRead;
  }

  // M-36 and M-40 (delivery line design §13): the request registry's chain fields and batch results.
  let requests: unknown[] | undefined;
  const requestsDir = join(home, REQUESTS_DIR_NAME);
  const registryFiles = listDir(requestsDir);
  if (registryFiles.kind === "bad") unknowns.unreadableFiles += 1;
  if (registryFiles.kind === "ok") {
    requests = [];
    for (const name of registryFiles.names.filter((candidate) => candidate.endsWith(".json"))) {
      const file = readJson(join(requestsDir, name));
      const frame = file.kind === "ok" ? registryFileSchema.safeParse(file.value) : null;
      // A file of another version is not this reader's to read, as the registry's own reader says.
      if (frame === null || !frame.success || frame.data.schemaVersion !== REQUEST_REGISTRY_VERSION) {
        if (file.kind !== "absent") unknowns.unreadableFiles += 1;
        continue;
      }
      requests.push(...frame.data.requests.map(registryEntryOf));
    }
  }

  // M-36: the rollover figures the owner set; the metric module reads them as the store does (missing ones at their defaults).
  const settingsFile = readJson(join(home, COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE));
  if (settingsFile.kind === "bad") unknowns.unreadableFiles += 1;
  const coordinationSettings = settingsFile.kind === "ok" ? settingsFile.value : undefined;

  // M-42: compactions and handoffs, their times and endings only.
  let compactions: unknown[] | undefined;
  const compactionFile = readJson(join(orchestratorDir, COMPACTIONS_FILE));
  if (compactionFile.kind === "ok") {
    const frame = compactionsFileSchema.safeParse(compactionFile.value);
    if (frame.success && frame.data.version === COMPACTIONS_FILE_VERSION) compactions = frame.data.entries.map((entry) => pick(entry, MAINTENANCE_KEYS));
    else unknowns.unreadableFiles += 1;
  } else if (compactionFile.kind === "bad") {
    unknowns.unreadableFiles += 1;
  }
  let handoffs: unknown[] | undefined;
  const handoffsDir = join(home, HANDOFFS_DIR_NAME);
  const handoffFiles = listDir(handoffsDir);
  if (handoffFiles.kind === "bad") unknowns.unreadableFiles += 1;
  if (handoffFiles.kind === "ok") {
    handoffs = [];
    for (const name of handoffFiles.names.filter((candidate) => candidate.endsWith(".json"))) {
      const file = readJson(join(handoffsDir, name));
      const frame = file.kind === "ok" ? handoffFileSchema.safeParse(file.value) : null;
      if (frame === null || !frame.success || frame.data.version !== HANDOFF_FILE_VERSION) {
        if (file.kind !== "absent") unknowns.unreadableFiles += 1;
        continue;
      }
      handoffs.push(pick(frame.data.handoff, MAINTENANCE_KEYS));
    }
  }

  return {
    records,
    workspaces,
    proposals,
    stalls,
    notes,
    decisions,
    wakes,
    interventions,
    dangers,
    missionsWorkspaceIds,
    missionDecisions,
    missionRequests,
    placements,
    requests,
    coordinationSettings,
    compactions,
    handoffs,
    unknowns,
  };
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
  dangers: unknown[] | undefined;
  missionsWorkspaceIds: string[];
  missionDecisions: unknown[] | undefined;
  missionRequests: Record<string, Array<{ requestId: string; workspaceId: string | null }>> | undefined;
  placements: Record<string, { missionId: string; repo: string }> | undefined;
  requests: unknown[] | undefined;
  coordinationSettings: unknown;
  compactions: unknown[] | undefined;
  handoffs: unknown[] | undefined;
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
export function evalInputsOf(
  selection: StoreInputs,
): Pick<
  EvalInput,
  | "records"
  | "proposals"
  | "stalls"
  | "notes"
  | "decisions"
  | "wakes"
  | "interventions"
  | "dangers"
  | "missionsWorkspaceIds"
  | "missionDecisions"
  | "missionRequests"
  | "placements"
  | "requests"
  | "coordinationSettings"
  | "compactions"
  | "handoffs"
> {
  return {
    records: selection.records,
    ...(selection.proposals === undefined ? {} : { proposals: selection.proposals }),
    ...(selection.stalls === undefined ? {} : { stalls: selection.stalls }),
    ...(selection.notes === undefined ? {} : { notes: selection.notes }),
    ...(selection.decisions === undefined ? {} : { decisions: selection.decisions }),
    ...(selection.wakes === undefined ? {} : { wakes: selection.wakes }),
    ...(selection.interventions === undefined ? {} : { interventions: selection.interventions }),
    ...(selection.dangers === undefined ? {} : { dangers: selection.dangers }),
    ...(selection.missionsWorkspaceIds === undefined || selection.missionsWorkspaceIds.length === 0 ? {} : { missionsWorkspaceIds: selection.missionsWorkspaceIds }),
    ...(selection.missionDecisions === undefined ? {} : { missionDecisions: selection.missionDecisions }),
    ...(selection.missionRequests === undefined
      ? {}
      : { missionRequests: Object.fromEntries(Object.entries(selection.missionRequests).map(([missionId, requests]) => [missionId, requests.map((request) => request.requestId)])) }),
    ...(selection.placements === undefined ? {} : { placements: selection.placements }),
    ...(selection.requests === undefined ? {} : { requests: selection.requests }),
    ...(selection.coordinationSettings === undefined ? {} : { coordinationSettings: selection.coordinationSettings }),
    ...(selection.compactions === undefined ? {} : { compactions: selection.compactions }),
    ...(selection.handoffs === undefined ? {} : { handoffs: selection.handoffs }),
  };
}

/** The projects a wake record names; none when it names none (it then belongs to no selection but "all"). */
export function workspacesOfWake(entry: unknown): string[] {
  const value = typeof entry === "object" && entry !== null ? (entry as { workspaceIds?: unknown }).workspaceIds : undefined;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** The mission an `m:` decision entry names (`m:<missionId>:<n>`), or null. */
const missionOfEntry = (entry: unknown): string | null => {
  const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
  return typeof id === "string" ? (/^m:(mis-[0-9a-f]{10}):/.exec(id)?.[1] ?? null) : null;
};

const workspaceOfEntry = (entry: unknown): string | null => {
  const value = typeof entry === "object" && entry !== null ? (entry as { workspaceId?: unknown }).workspaceId : undefined;
  return typeof value === "string" ? value : null;
};

/**
 * The records and Orchestrator entries of the given workspaces; `null` keeps
 * them all. A stall key is attributed by its `<workspaceId>::` prefix, a
 * proposal, a decision, an intervention and a danger by its `workspaceId`, a note by
 * its file, a wake by any of the projects whose events it carried. A mission
 * (its `m:` decisions and its requests) is kept when one of its requests is of
 * the given workspaces. A compaction or handoff is kept by its `workspaceId`;
 * the request registry, the placements and the settings pass whole (a chain
 * or an awaited request may be another workspace's).
 */
export function selectWorkspaces(store: StoreRead, workspaceIds: ReadonlySet<string> | null): WorkspaceSelection {
  const inWorkspace = (id: string | null): boolean => workspaceIds === null || (id !== null && workspaceIds.has(id));
  const missionKept = (missionId: string | null): boolean =>
    workspaceIds === null || (missionId !== null && (store.missionRequests?.[missionId] ?? []).some((request) => inWorkspace(request.workspaceId)));
  return {
    records: store.records.filter((record) => inWorkspace(record.workspaceId)),
    proposals: store.proposals?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    stalls:
      store.stalls === undefined ? undefined : Object.fromEntries(Object.entries(store.stalls).filter(([key]) => inWorkspace(workspaceOfStallKey(key)))),
    notes: store.notes?.filter((note) => inWorkspace(note.workspaceId)),
    decisions: store.decisions?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    wakes: store.wakes?.filter((entry) => workspaceIds === null || workspacesOfWake(entry).some((id) => workspaceIds.has(id))),
    interventions: store.interventions?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    dangers: store.dangers?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    missionsWorkspaceIds: store.missionsWorkspaceIds,
    missionDecisions: store.missionDecisions?.filter((entry) => missionKept(missionOfEntry(entry))),
    missionRequests: store.missionRequests === undefined ? undefined : Object.fromEntries(Object.entries(store.missionRequests).filter(([missionId]) => missionKept(missionId))),
    placements: store.placements,
    requests: store.requests,
    coordinationSettings: store.coordinationSettings,
    compactions: store.compactions?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
    handoffs: store.handoffs?.filter((entry) => inWorkspace(workspaceOfEntry(entry))),
  };
}

/** Workspace directory by id, for A-6's `rm -rf` rule and `writers-observed`'s file paths (autonomy design §F.1); never shown. */
export function workspaceDirectoriesOf(store: StoreRead): Record<string, string> {
  const directories: Record<string, string> = {};
  for (const [id, meta] of store.workspaces) if (meta.directory !== null) directories[id] = meta.directory;
  return directories;
}
