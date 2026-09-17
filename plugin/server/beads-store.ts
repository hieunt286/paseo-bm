/**
 * Read-only reader for a workspace's bead store (WP-208, Dashboard Design §10).
 *
 * `.beads/issues.jsonl` at the repository root is the committed source of truth
 * for `br`, so the Dashboard reads exactly that file and nothing else:
 *
 * - no `br` subprocess — the daemon's `PATH` is not ours to assume, and
 *   spawning processes from a plugin is a trust boundary we do not need;
 * - no `beads.db` — that is a local cache and `br` holds locks on it;
 * - no writes, ever. `br` owns this data (AGENTS.md).
 *
 * "Ready" is computed the way `br ready` defines it: open, and every `blocks`
 * dependency closed. `parent-child` edges do not block — getting that wrong
 * produces a number that looks plausible and is wrong, which is worse than an
 * obvious failure.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DashboardError, type BeadStats } from "../shared/contracts";

/** Largest bead store this reads in one go (REQ-049a, Q-034). */
export const MAX_BEADS_FILE_BYTES = 32 * 1024 * 1024;

/** Path of the bead store inside a workspace. */
export const BEADS_RELATIVE_PATH = join(".beads", "issues.jsonl");

/** One bead, reduced to what the Dashboard needs. */
export interface BeadRecord {
  id: string;
  title: string | null;
  status: string;
  /** `task`, `bug`, `epic`, …; epics are containers and are never "ready". */
  issueType: string;
  updatedAt: string;
  labels: string[];
  /** Ids this bead is blocked by (`blocks` dependencies only). */
  blockedBy: string[];
  priority: number | null;
  createdAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  description: string | null;
  /** The `parent-child` parent, when the bead has one. */
  parentId: string | null;
}

export interface ReadBeadsResult {
  beads: Map<string, BeadRecord>;
  skippedLines: number;
  present: boolean;
  source: string;
  readAt: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: ReadBeadsResult;
}

const cache = new Map<string, CacheEntry>();

/** Drops the bead-store cache. Test helper and post-mutation escape hatch. */
export function clearBeadsCache(): void {
  cache.clear();
}

function unreadable(detail: string, cause?: unknown): DashboardError {
  return new DashboardError("E_BEADS_STORE_UNREADABLE", detail, cause ? { cause } : undefined);
}

/**
 * Resolves `<workspace>/.beads/issues.jsonl`, refusing to leave the workspace.
 *
 * Same no-follow principle as the trace store (design §3.8) and the installer's
 * `src/paths-guard.ts`: a symlinked `.beads` or `issues.jsonl` could point at
 * any file on the machine, and reading it would leak whatever it holds into the
 * Dashboard.
 */
export function beadsStorePath(workspaceDirectory: string): string {
  if (!isAbsolute(workspaceDirectory)) {
    throw unreadable(`workspace directory must be absolute: ${workspaceDirectory}`);
  }
  const root = resolve(workspaceDirectory);
  const target = resolve(join(root, BEADS_RELATIVE_PATH));
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw unreadable(`bead store path escapes the workspace: ${target}`);
  }

  let current = root;
  for (const part of rel.split(sep)) {
    if (part === "" || part === ".") continue;
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw unreadable(`refusing to follow a symlinked bead store path: ${current}`);
      }
    } catch (error) {
      if (error instanceof DashboardError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw unreadable(`cannot inspect ${current}`, error);
    }
  }
  return target;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parentOf(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const dep = entry as { type?: unknown; depends_on_id?: unknown };
    if (dep.type === "parent-child" && typeof dep.depends_on_id === "string") return dep.depends_on_id;
  }
  return null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

function blockedByOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const dep = entry as { type?: unknown; depends_on_id?: unknown };
    if (dep.type !== "blocks") continue;
    if (typeof dep.depends_on_id === "string") out.push(dep.depends_on_id);
  }
  return out;
}

/**
 * Reads and indexes the bead store.
 *
 * A missing file is an empty state (`present: false`), not an error: a
 * workspace without beads is a perfectly normal workspace (REQ-046d). A single
 * unparseable line is skipped and counted, so one bad line cannot hide the
 * other ninety-nine (REQ-046e).
 */
export function readBeads(workspaceDirectory: string): ReadBeadsResult {
  const path = beadsStorePath(workspaceDirectory);
  const readAt = new Date().toISOString();

  let stats: { mtimeMs: number; size: number };
  try {
    const stat = statSync(path);
    stats = { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { beads: new Map(), skippedLines: 0, present: false, source: path, readAt };
    }
    throw unreadable(`cannot read ${path}`, error);
  }

  if (stats.size > MAX_BEADS_FILE_BYTES) {
    throw unreadable(
      `${path} is ${stats.size} bytes, over the ${MAX_BEADS_FILE_BYTES}-byte limit this reader accepts`,
    );
  }

  const cached = cache.get(path);
  if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    return { ...cached.result, readAt };
  }

  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    throw unreadable(`cannot read ${path}`, error);
  }

  const beads = new Map<string, BeadRecord>();
  let skippedLines = 0;
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      skippedLines += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      skippedLines += 1;
      continue;
    }
    const row = parsed as Record<string, unknown>;
    const id = row["id"];
    const status = row["status"];
    if (typeof id !== "string" || id === "" || typeof status !== "string") {
      skippedLines += 1;
      continue;
    }
    const record: BeadRecord = {
      id,
      title: typeof row["title"] === "string" ? (row["title"] as string) : null,
      status,
      issueType: typeof row["issue_type"] === "string" ? (row["issue_type"] as string) : "task",
      updatedAt: typeof row["updated_at"] === "string" ? (row["updated_at"] as string) : "",
      labels: asStringArray(row["labels"]),
      blockedBy: blockedByOf(row["dependencies"]),
      // `br` writes priority as a number; some exports write it as a string.
      priority: Number.isFinite(Number(row["priority"])) && row["priority"] !== null && row["priority"] !== "" ? Number(row["priority"]) : null,
      createdAt: text(row["created_at"]),
      closedAt: text(row["closed_at"]),
      closeReason: text(row["close_reason"]),
      description: text(row["description"]),
      parentId: parentOf(row["dependencies"]),
    };
    // Several lines can carry the same id; the latest `updated_at` wins.
    const existing = beads.get(id);
    if (existing === undefined || record.updatedAt >= existing.updatedAt) beads.set(id, record);
  }

  const result: ReadBeadsResult = { beads, skippedLines, present: true, source: path, readAt };
  cache.set(path, { ...stats, result });
  return result;
}

/**
 * Startable right now, matching what `br ready` lists: open, every `blocks`
 * dependency closed, and **not an epic**.
 *
 * Two rules here were derived by comparing against two real stores rather than
 * from the field names:
 *
 * - **Epics are excluded.** They are containers; `br ready` never offers one as
 *   work. Counting them produced 12 ready where `br` reported 3.
 * - **A dependency pointing at an id that is not in the store counts as NOT
 *   closed.** Treating an unknown edge as satisfied would advertise work as
 *   startable when nobody can tell whether it is.
 */
export function isReady(bead: BeadRecord, beads: Map<string, BeadRecord>): boolean {
  if (bead.status === "closed" || bead.status === "in_progress") return false;
  if (bead.issueType === "epic") return false;
  return bead.blockedBy.every((id) => beads.get(id)?.status === "closed");
}

/**
 * Counts for one workspace, shaped for the `beads.stats` RPC (REQ-046a).
 *
 * The buckets follow `br stats`, which was checked against two real stores
 * while this was written, and they are not all statuses:
 *
 * - `total = open + inProgress + closed`;
 * - **`ready` is derived**: an open non-epic bead whose every `blocks`
 *   dependency is closed;
 * - **`blocked` is derived** as the rest of the open work (`open - ready`),
 *   which is why an open epic counts as blocked;
 * - so `open = ready + blocked`.
 *
 * Reading `blocked` off a `status` field instead would report 0 on a store
 * where `br` reports 22 — a number that looks fine and is wrong.
 */
export function beadStats(workspaceDirectory: string): BeadStats {
  const { beads, skippedLines, present, source, readAt } = readBeads(workspaceDirectory);
  let open = 0;
  let inProgress = 0;
  let blocked = 0;
  let closed = 0;
  let ready = 0;
  for (const bead of beads.values()) {
    switch (bead.status) {
      case "closed":
        closed += 1;
        break;
      case "in_progress":
        inProgress += 1;
        break;
      case "blocked":
        // `br` derives this bucket, but honour an explicit status too.
        blocked += 1;
        break;
      default:
        // Everything else is open work: `open` is the bucket `br` reports, and
        // it splits into ready and blocked.
        open += 1;
        if (isReady(bead, beads)) ready += 1;
        else blocked += 1;
        break;
    }
  }
  return {
    total: beads.size,
    open,
    inProgress,
    blocked,
    closed,
    ready,
    readAt,
    source,
    skippedLines,
    present,
  };
}

/** One bead as the trace detail shows it (REQ-044a). */
export interface BeadLookup {
  id: string;
  title: string | null;
  status: string;
  /** `updated_at` from the store; "" when the store has none. */
  updatedAt: string;
}

/**
 * Looks up the beads a trace reported, by id.
 *
 * Ids that are no longer in the store come back in `missing` rather than
 * throwing: a bead can legitimately be gone (another repo, renamed prefix,
 * store not committed yet), and the trace must still render — the UI marks it
 * "not in store" (REQ-044d).
 */
export function lookupBeads(
  workspaceDirectory: string,
  ids: readonly string[],
): { found: BeadLookup[]; missing: string[] } {
  if (ids.length === 0) return { found: [], missing: [] };
  let beads: Map<string, BeadRecord>;
  try {
    beads = readBeads(workspaceDirectory).beads;
  } catch {
    // An unreadable store must not break a trace; every id is simply unknown.
    return { found: [], missing: [...ids] };
  }
  const found: BeadLookup[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const bead = beads.get(id);
    if (bead === undefined) {
      missing.push(id);
      continue;
    }
    found.push({ id: bead.id, title: bead.title, status: bead.status, updatedAt: bead.updatedAt });
  }
  return { found, missing };
}
