/**
 * `writers-observed` (autonomy design §F.1, REQ-161): two agents of one
 * workspace with edit or write evidence on the same file in overlapping turns.
 * Detection only — nothing here holds or prevents a write; the per-Worker
 * worktrees candidate (WP-603) is judged on what this counts.
 *
 * - **A turn** is one trace record: its agent and its span
 *   `[startedAt, endedAt)`. Turns are paired by agent and time, never by
 *   `(agentId, turnId)` — Paseo reuses turn ids inside one agent (AGENTS.md).
 * - **Overlapping** is half-open (`spansOverlap`): a turn that starts the very
 *   millisecond another ends does not overlap it.
 * - **One agent twice** never collides with itself; any two agents do (Workers
 *   mostly; a Manager or a Reviewer writing is itself notable).
 * - **Unknown**: a pair whose turn has no start (or no readable end) cannot be
 *   judged. It is counted apart, never as a collision nor as none.
 * - **One file** is the `file` evidence path relative to the workspace folder
 *   (`workspaceFileOf`): Claude records absolute paths, Codex relative ones,
 *   so both forms of one file match. A write outside the workspace folder —
 *   an absolute path not below it, a relative one that climbs above it — is
 *   ignored. Without the folder, paths are compared as written.
 * - **Settled** (the alert's clear rule, design §F.3): once the later of the
 *   two requests finished — each turn's request (its own, else the one its
 *   Worker or Reviewer serves) whose latest milestone report is `finished`. A
 *   turn whose request is not known holds nothing open.
 *
 * The suite's S6 check (`scripts/eval/score.ts`, `noOverlappingEdits`) pairs
 * its turns with `turnPairsOf` and `spansOverlap` from here.
 *
 * `shared/`, pure: no Node and no React Native imports.
 */
import type { TraceRecord } from "./contracts";
import { normalisedPath } from "./evidence";
import { timeOrNull, timeOrZero } from "./time";

/** A span in epoch milliseconds, half-open: `[start, end)`. */
export interface Span {
  start: number;
  end: number;
}

/** Two half-open spans overlap. */
export const spansOverlap = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/** A turn as the pairing reads it: its agent, and its span with null where a time is unknown. */
export interface TimedTurn {
  agentId: string;
  start: number | null;
  end: number | null;
}

/** The pairs of turns of two different agents: overlapping, and not judged for a missing time. */
export interface TurnPairs<T> {
  overlapping: Array<[T, T]>;
  unknown: Array<[T, T]>;
}

/**
 * Every pair of `turns` by two different agents, in input order: overlapping
 * when both spans are known and intersect, unknown when either misses a time.
 * A pair of one agent's turns is never counted. Pure.
 */
export function turnPairsOf<T extends TimedTurn>(turns: readonly T[]): TurnPairs<T> {
  const overlapping: Array<[T, T]> = [];
  const unknown: Array<[T, T]> = [];
  for (let i = 0; i < turns.length; i += 1) {
    for (let j = i + 1; j < turns.length; j += 1) {
      const a = turns[i]!;
      const b = turns[j]!;
      if (a.agentId === b.agentId) continue;
      if (a.start === null || a.end === null || b.start === null || b.end === null) unknown.push([a, b]);
      else if (spansOverlap({ start: a.start, end: a.end }, { start: b.start, end: b.end })) overlapping.push([a, b]);
    }
  }
  return { overlapping, unknown };
}

/** What a turn record needs for the detection. */
export type WriterRecord = Pick<TraceRecord, "workspaceId" | "agentId" | "role" | "turnId" | "requestId" | "startedAt" | "endedAt" | "evidence">;

/** A turn's span: its recorded start (never a guess from its messages) and its end. */
export function turnSpanOf(record: Pick<TraceRecord, "startedAt" | "endedAt">): { start: number | null; end: number | null } {
  return { start: timeOrNull(record.startedAt), end: timeOrNull(record.endedAt) };
}

/**
 * A written path relative to the workspace folder; null when it lies outside
 * it (an absolute path not below the folder, or a relative one climbing above
 * it) or is empty. Without the folder, the normalised path as written. Pure.
 */
export function workspaceFileOf(path: string, workspaceDirectory: string | null): string | null {
  const key = normalisedPath(path);
  if (key === "" || key === "/" || key === ".." || key.startsWith("../")) return null;
  if (!key.startsWith("/")) return key;
  const folder = workspaceDirectory === null || workspaceDirectory.trim() === "" ? null : normalisedPath(workspaceDirectory);
  if (folder === null) return key;
  if (folder === "/") return key.slice(1);
  return key.startsWith(`${folder}/`) ? key.slice(folder.length + 1) : null;
}

/** The files a turn edited or wrote, relative to the workspace folder, once each, in their order; writes outside it left out. Pure. */
export function writtenFilesOf(record: Pick<TraceRecord, "evidence">, workspaceDirectory: string | null): string[] {
  const files = new Set<string>();
  for (const evidence of record.evidence) {
    if (evidence.kind !== "file") continue;
    const file = workspaceFileOf(evidence.detail, workspaceDirectory);
    if (file !== null) files.add(file);
  }
  return [...files];
}

/** Two turns of two agents on one file: overlapping (a collision), or not judged (unknown). */
export interface Collision<T extends WriterRecord = WriterRecord> {
  workspaceId: string;
  /** Relative to the workspace folder. */
  file: string;
  /** The two turns, the earlier start first (a turn without one last). */
  turns: [T, T];
}

export interface WritersObserved<T extends WriterRecord = WriterRecord> {
  collisions: Array<Collision<T>>;
  /** Pairs of two agents on one file with a turn missing its start or end: neither a collision nor none. */
  unknown: Array<Collision<T>>;
}

function ordered<T extends WriterRecord>(a: T, b: T): [T, T] {
  const start = (record: T) => turnSpanOf(record).start ?? Number.POSITIVE_INFINITY;
  return start(a) < start(b) || (start(a) === start(b) && a.agentId <= b.agentId) ? [a, b] : [b, a];
}

/**
 * The collisions and the unknown pairs of `records` (any workspaces), per
 * workspace and file, in the records' order. `directoryOf` gives a
 * workspace's folder, null when unknown. Pure.
 */
export function writersObservedOf<T extends WriterRecord>(records: readonly T[], directoryOf: (workspaceId: string) => string | null): WritersObserved<T> {
  // workspace → file → the turns that wrote it, in the records' order.
  const byFile = new Map<string, Map<string, Array<{ agentId: string; start: number | null; end: number | null; record: T }>>>();
  const directories = new Map<string, string | null>();
  for (const record of records) {
    if (!directories.has(record.workspaceId)) directories.set(record.workspaceId, directoryOf(record.workspaceId));
    const files = writtenFilesOf(record, directories.get(record.workspaceId) ?? null);
    if (files.length === 0) continue;
    const perFile = byFile.get(record.workspaceId) ?? new Map<string, Array<{ agentId: string; start: number | null; end: number | null; record: T }>>();
    byFile.set(record.workspaceId, perFile);
    const turn = { agentId: record.agentId, ...turnSpanOf(record), record };
    for (const file of files) perFile.set(file, [...(perFile.get(file) ?? []), turn]);
  }
  const collisions: Array<Collision<T>> = [];
  const unknown: Array<Collision<T>> = [];
  for (const [workspaceId, perFile] of byFile) {
    for (const [file, turns] of perFile) {
      const pairs = turnPairsOf(turns);
      for (const [a, b] of pairs.overlapping) collisions.push({ workspaceId, file, turns: ordered(a.record, b.record) });
      for (const [a, b] of pairs.unknown) unknown.push({ workspaceId, file, turns: ordered(a.record, b.record) });
    }
  }
  return { collisions, unknown };
}

/** True when two records are the same turn: the agent, the turn id and both times (a reused turn id has other times). */
export function isSameTurn(a: WriterRecord, b: WriterRecord): boolean {
  return a.agentId === b.agentId && a.turnId === b.turnId && a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.workspaceId === b.workspaceId;
}

/**
 * The collisions and unknown pairs one recorded turn makes with the other
 * turns of its workspace (`records`, which may hold its own stored copy: that
 * copy is left out). Only the other turns that wrote one of its files are
 * compared. Pure.
 */
export function collisionsOfTurn<T extends WriterRecord>(record: T, records: readonly T[], workspaceDirectory: string | null): WritersObserved<T> {
  const files = new Set(writtenFilesOf(record, workspaceDirectory));
  if (files.size === 0) return { collisions: [], unknown: [] };
  const others = records.filter(
    (other) =>
      other.workspaceId === record.workspaceId &&
      other !== record &&
      !isSameTurn(other, record) &&
      writtenFilesOf(other, workspaceDirectory).some((file) => files.has(file)),
  );
  const found = writersObservedOf([record, ...others], () => workspaceDirectory);
  const involves = (collision: Collision<T>) => collision.turns.includes(record);
  return { collisions: found.collisions.filter(involves), unknown: found.unknown.filter(involves) };
}

/** What the clear rule reads of a record: its request and its reports. */
export type RequestRecord = Pick<TraceRecord, "agentId" | "role" | "requestId" | "reports">;

/**
 * A turn's request: its own, else — for a Worker or a Reviewer, which serve
 * one request — the one the latest other record of the same agent names;
 * null when none is known (a Manager serves many). Pure.
 */
export function requestOfTurn(record: RequestRecord & Pick<TraceRecord, "endedAt">, records: ReadonlyArray<RequestRecord & Pick<TraceRecord, "endedAt">>): string | null {
  if (record.requestId !== null) return record.requestId;
  if (record.role !== "worker" && record.role !== "reviewer") return null;
  let found: { id: string; at: number } | null = null;
  for (const other of records) {
    if (other.agentId !== record.agentId || other.requestId === null) continue;
    const at = timeOrZero(other.endedAt);
    if (found === null || at >= found.at) found = { id: other.requestId, at };
  }
  return found?.id ?? null;
}

/** True when the request's latest milestone report (by time, the later of a tie) is `finished`. Pure. */
export function isRequestFinished(requestId: string, records: readonly RequestRecord[]): boolean {
  let latest: { at: number; finished: boolean } | null = null;
  for (const record of records) {
    for (const report of record.reports) {
      if (report.phase === null || (report.requestId ?? record.requestId) !== requestId) continue;
      const at = timeOrZero(report.at);
      if (latest === null || at >= latest.at) latest = { at, finished: report.phase === "finished" };
    }
  }
  return latest?.finished === true;
}

/**
 * A collision is settled once the later of its two requests finished: every
 * request its turns belong to that is known has its latest milestone
 * `finished` (design §F.3). A turn with no known request holds nothing open.
 * Pure.
 */
export function isCollisionSettled(collision: Collision<WriterRecord & RequestRecord>, records: ReadonlyArray<RequestRecord & Pick<TraceRecord, "endedAt">>): boolean {
  return collision.turns.every((turn) => {
    const requestId = requestOfTurn(turn, records);
    return requestId === null || isRequestFinished(requestId, records);
  });
}
