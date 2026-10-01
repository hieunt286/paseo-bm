/**
 * The trace store's two rewrite paths (WP-210, Dashboard Design §3.5, §3.7;
 * code review 2026-09-30 §4): deletion, and reassigning a workspace's traces
 * onto another workspace.
 *
 * Built only on the primitives of `trace-store.ts`: every path comes from its
 * checker (`storePath`, the no-follow walk of design §3.8), every mutation runs
 * under its per-workspace mutex (`withWorkspaceLock`), every rewrite goes
 * through its temp + `fsync` + `rename` write, and every failure carries its
 * code, `E_TRACE_STORE_UNWRITABLE`. This module builds no path and takes no
 * lock of its own.
 */
import { readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { DashboardError, traceRecordSchema, type TraceDeleteScope, type TraceRecord } from "../shared/contracts";
import {
  assertNoSymlinkOnPath,
  assertWorkspaceId,
  assertWritableSchema,
  clearTraceStoreCache,
  countTraces,
  dataFolderOf,
  dedupeRecords,
  ensureStoreDir,
  forgetCachedFile,
  monthlyFiles,
  recordKeyOf,
  storePath,
  unwritable,
  withWorkspaceLock,
  writeStoreFileAtomically,
  type TraceStoreLocation,
} from "./trace-store";

// ---------------------------------------------------------------------------
// Deletion (WP-210, Dashboard Design §3.5).
//
// The only irreversible operation in the feature: there is no undo and no
// bin. Two rules therefore hold without exception — every mutation goes
// through the guard and the mutex of `trace-store.ts`, and **nothing in the
// product calls this except a user action** (REQ-054f). There is deliberately
// no timer, hook or retention policy that can reach it.
// ---------------------------------------------------------------------------

/** How many traces and bytes a delete would remove, or removed. */
export interface DeleteOutcome {
  traces: number;
  bytes: number;
}

/** Scope of a deletion, as `traces.delete` validated it. */
export type DeleteScope = TraceDeleteScope;

/** Trace key of a record: the request it belongs to, or a per-turn fallback. */
export function traceKeyOf(record: TraceRecord): string {
  return record.requestId ?? `${record.agentId}::${record.turnId ?? record.at}`;
}

function matchesScope(record: TraceRecord, scope: DeleteScope, recordKeys?: ReadonlySet<string>): boolean {
  if ("allOfWorkspace" in scope) return true;
  if ("traceId" in scope) {
    // The caller resolves a trace to its records (a trace spans several agents
    // and unnamed Manager turns); a bare key match is only the fallback.
    if (recordKeys !== undefined) return recordKeys.has(recordKeyOf(record));
    return traceKeyOf(record) === scope.traceId || `req:${traceKeyOf(record)}` === scope.traceId;
  }
  return record.at < scope.before;
}

function bytesOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Splits one monthly file into the lines a scope keeps and the ones it drops. */
function splitMonthlyFile(
  path: string,
  scope: DeleteScope,
  recordKeys?: ReadonlySet<string>,
): { keptLines: string[]; dropped: TraceRecord[]; droppedLines: number; fileBytes: number } {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return { keptLines: [], dropped: [], droppedLines: 0, fileBytes: 0 };
  }
  const keptLines: string[] = [];
  const dropped: TraceRecord[] = [];
  let droppedLines = 0;
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const parsed = traceRecordSchema.safeParse(safeJson(line));
    // An unreadable line matches no trace, so it is kept: deletion must only
    // remove what the user asked for, never data it failed to understand.
    if (!parsed.success || !matchesScope(parsed.data, scope, recordKeys)) {
      keptLines.push(line);
      continue;
    }
    droppedLines += 1;
    dropped.push(parsed.data);
  }
  return { keptLines, dropped, droppedLines, fileBytes: Buffer.byteLength(body, "utf8") };
}

/**
 * Plans a deletion: what would go.
 *
 * `traces.delete` with `dryRun: true` returns exactly this, so the confirmation
 * the user sees is computed by the same code that does the work — a preview
 * that can disagree with the deletion is worse than no preview at all.
 */
export function planDeletion(
  location: TraceStoreLocation,
  workspaceId: string,
  scope: DeleteScope,
  options: { recordKeys?: ReadonlySet<string> } = {},
): DeleteOutcome {
  const doomed: TraceRecord[] = [];
  let bytes = 0;

  for (const path of monthlyFiles(location, workspaceId)) {
    const split = splitMonthlyFile(path, scope, options.recordKeys);
    if (split.droppedLines === 0) continue;
    doomed.push(...split.dropped);
    bytes +=
      split.keptLines.length === 0
        ? split.fileBytes
        : split.fileBytes - Buffer.byteLength(`${split.keptLines.join("\n")}\n`, "utf8");
  }

  if ("allOfWorkspace" in scope) {
    bytes += bytesOf(storePath(location.tracesDir, workspaceId, "meta.json"));
  }

  return {
    traces: "traceId" in scope ? (doomed.length > 0 ? 1 : 0) : countTraces(doomed),
    bytes,
  };
}

/**
 * Deletes traces. Irreversible: no bin, no undo.
 *
 * Whole months and whole workspaces are removed outright; a month that keeps
 * some records is rewritten through the store's temp + `fsync` + `rename` path,
 * so a crash leaves either the old file or the new one, never a half file.
 */
export async function deleteTraces(
  location: TraceStoreLocation,
  workspaceId: string,
  scope: DeleteScope,
  options: {
    dryRun?: boolean;
    /** Records a trace-scoped delete removes, from the reconstructed trace. */
    recordKeys?: ReadonlySet<string>;
    timeoutMs?: number;
  } = {},
): Promise<DeleteOutcome> {
  assertWorkspaceId(workspaceId);
  // Validate the path family before anything is touched, so an escaping id
  // fails with nothing written.
  storePath(location.tracesDir, workspaceId, "meta.json");

  if (options.dryRun === true) {
    return planDeletion(location, workspaceId, scope, options);
  }

  return withWorkspaceLock(
    workspaceId,
    () => {
      assertWritableSchema(location);
      const planned = planDeletion(location, workspaceId, scope, options);

      if ("allOfWorkspace" in scope) {
        const dir = dirname(storePath(location.tracesDir, workspaceId, "meta.json"));
        assertNoSymlinkOnPath(dataFolderOf(location.tracesDir), dir);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (error) {
          throw unwritable(`cannot remove ${dir}`, error);
        }
        clearTraceStoreCache();
        return planned;
      }

      for (const path of monthlyFiles(location, workspaceId)) {
        const split = splitMonthlyFile(path, scope, options.recordKeys);
        if (split.droppedLines === 0) continue;
        if (split.keptLines.length === 0) {
          assertNoSymlinkOnPath(dataFolderOf(location.tracesDir), path);
          try {
            unlinkSync(path);
          } catch (error) {
            throw unwritable(`cannot remove ${path}`, error);
          }
        } else {
          writeStoreFileAtomically(location, path, `${split.keptLines.join("\n")}\n`);
        }
        forgetCachedFile(path);
      }

      clearTraceStoreCache();
      return planned;
    },
    { timeoutMs: options.timeoutMs },
  );
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reassignment (WP-210, Dashboard Design §3.7).
//
// A workspace the user removed from Paseo must not take its history with it,
// and it must not be guessed back onto a new workspace either: matching by
// repository path would merge two different lines of work the first time
// someone reuses a directory. So the store reports what it sees
// (`classifyWorkspaces`, `trace-store.ts`), and only a user action moves
// anything (REQ-057f).
// ---------------------------------------------------------------------------

/** How many traces and bytes a reassignment would move, or moved. */
export interface ReassignOutcome {
  traces: number;
  bytes: number;
}

function reassignInvalid(detail: string): DashboardError {
  return new DashboardError("E_TRACE_REASSIGN_INVALID", detail);
}

/**
 * Moves every trace of `fromWorkspaceId` onto `toWorkspaceId`.
 *
 * An empty destination is a single `rename` of the directory: one syscall, so
 * an interruption cannot leave half the traces behind. A destination that
 * already has files is merged month by month with the same `dedupeRecords` key,
 * which is also what makes an interrupted merge harmless — the worst case is
 * both copies existing, and the reader keeps one (REQ-057e).
 *
 * The `workspaceId` inside each record is left alone: it is the historical
 * fact. Directory position is what decides which workspace a trace belongs to,
 * and the caller reports the difference as `reassignedFrom`.
 */
export async function reassignWorkspace(
  location: TraceStoreLocation,
  fromWorkspaceId: string,
  toWorkspaceId: string,
  options: {
    dryRun?: boolean;
    /** Ids Paseo currently lists; the destination must be one of them. */
    destinationExists?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<ReassignOutcome> {
  assertWorkspaceId(fromWorkspaceId);
  assertWorkspaceId(toWorkspaceId);
  if (fromWorkspaceId === toWorkspaceId) {
    throw reassignInvalid(`cannot reassign workspace ${fromWorkspaceId} onto itself`);
  }
  if (options.destinationExists === false) {
    throw reassignInvalid(`Paseo does not list a workspace ${toWorkspaceId} to reassign onto`);
  }

  const sourceDir = dirname(storePath(location.tracesDir, fromWorkspaceId, "meta.json"));
  const destinationDir = dirname(storePath(location.tracesDir, toWorkspaceId, "meta.json"));
  const sourceFiles = monthlyFiles(location, fromWorkspaceId);

  const moving: TraceRecord[] = [];
  let bytes = 0;
  for (const path of sourceFiles) {
    bytes += bytesOf(path);
    moving.push(...linesOf(path).records);
  }
  const planned: ReassignOutcome = { traces: countTraces(moving), bytes };
  if (options.dryRun === true) return planned;

  // Both workspaces are mutated, so both locks are taken, always in id order
  // so two concurrent reassignments cannot deadlock against each other.
  const [firstId, secondId] = [fromWorkspaceId, toWorkspaceId].sort();
  return withWorkspaceLock(
    firstId!,
    () =>
      withWorkspaceLock(
        secondId!,
        () => {
          assertWritableSchema(location);
          const root = dataFolderOf(location.tracesDir);
          assertNoSymlinkOnPath(root, sourceDir);
          assertNoSymlinkOnPath(root, destinationDir);

          let destinationExisting: string[];
          try {
            destinationExisting = readdirSync(destinationDir);
          } catch {
            destinationExisting = [];
          }

          if (destinationExisting.length === 0) {
            try {
              rmSync(destinationDir, { recursive: true, force: true });
              renameSync(sourceDir, destinationDir);
            } catch (error) {
              throw unwritable(`cannot move ${sourceDir} to ${destinationDir}`, error);
            }
            clearTraceStoreCache();
            return planned;
          }

          ensureStoreDir(location.tracesDir, destinationDir);
          for (const sourcePath of sourceFiles) {
            const name = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
            const destinationPath = storePath(location.tracesDir, toWorkspaceId, name);
            const destination = linesOf(destinationPath);
            const source = linesOf(sourcePath);
            const merged = dedupeRecords([...destination.records, ...source.records]);
            // Lines this version cannot read are carried over as they are: a
            // merge must not delete data it failed to understand.
            const body = [
              ...merged.map((record) => JSON.stringify(record)),
              ...destination.unreadable,
              ...source.unreadable,
            ].join("\n");
            writeStoreFileAtomically(location, destinationPath, `${body}\n`);
            try {
              unlinkSync(sourcePath);
            } catch (error) {
              throw unwritable(`cannot remove ${sourcePath} after merging it`, error);
            }
          }
          // The destination keeps its own metadata; the source directory goes.
          try {
            rmSync(sourceDir, { recursive: true, force: true });
          } catch (error) {
            throw unwritable(`cannot remove ${sourceDir}`, error);
          }
          clearTraceStoreCache();
          return planned;
        },
        { timeoutMs: options.timeoutMs },
      ),
    { timeoutMs: options.timeoutMs },
  );
}

/** Records of one monthly file and the lines that are not records, uncached. */
function linesOf(path: string): { records: TraceRecord[]; unreadable: string[] } {
  const split = splitMonthlyFile(path, { allOfWorkspace: true });
  return { records: split.dropped, unreadable: split.keptLines };
}
