/**
 * Project memory (missions design §2.5, §7; ADR-029): what a repo has
 * decided, learnt and agreed, for the Mains and Workers that come after.
 *
 * `<data folder>/memory/<repo key>.json` (delivery line design §3.1) =
 * `{ schemaVersion: 1, entries: [{ id, kind, text, source, by, at, supersedes, state, scope?, subject? }] }`.
 *
 * - **Masking:** `text` (≤ `MAX_MEMORY_TEXT`) and `source`
 *   (≤ `MAX_MEMORY_SOURCE`) are masked with `redactText`.
 * - **Scope and life** (delivery line design §18.1, ADR-037): an entry is
 *   `repo` or `mission` (`scopeOf`). An active entry is live unless
 *   `retirementsOf` retires it — its mission closed, a newer entry names its
 *   `subject`, or it is a mission fact past `MEMORY_FACT_DAYS`. Retirement is
 *   computed at each read and never stored; an entry retired for
 *   `MEMORY_RETIRED_DAYS` becomes `removed` at the next write.
 * - **Bounds:** at most `MAX_ACTIVE_MEMORY` live entries. An agent's `add`
 *   past it is refused ("curate the memory first"); an automatic entry
 *   (`by.role: "plugin"`) past it replaces the oldest automatic `decision`
 *   entry. A removed entry is kept, the newest `MAX_REMOVED_MEMORY` of them.
 * - An entry that `supersedes` an active one removes it in the same write.
 *
 * A `createJsonFileStore` file (`0700` folder, `0600`, atomic, no symlink, a
 * newer `schemaVersion` read as empty and never written), never overwritten
 * when it cannot be used. Readers never throw; a refused change is a result
 * with one line per reason.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { redactText } from "./collector";
import { capBy, createJsonFileStore, entriesOf, type JsonFileStore } from "./data-files";
import { requestIndexOf } from "./mission-roster";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MISSIONS_DIR_NAME, createMissionStore } from "./mission-store";
import { repoKeyOf } from "./placements";
import { WORKSPACE_ID_PATTERN } from "./trace-store";
import { timeOrZero } from "../shared/time";

/** The memory's folder in the data folder (§2.5); the cleanup button deletes it. */
export const MEMORY_DIR_NAME = "memory";
export const MEMORY_VERSION = 1;
export const MAX_MEMORY_TEXT = 1_000;
export const MAX_MEMORY_SOURCE = 300;
/** The most active entries per repo (§2.5). */
export const MAX_ACTIVE_MEMORY = 300;
/** The most removed entries kept per repo, the newest; not in §2.5: keeps the file bounded. */
export const MAX_REMOVED_MEMORY = 300;
export const MEMORY_ID_PATTERN = /^mem-[0-9a-f]{10}$/;
export const MEMORY_KINDS = ["decision", "precedent", "fact", "convention", "contract"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_AUTHORS = ["owner", "main", "worker", "plugin"] as const;
/** Who an entry is for (§18.1): every later mission in the repo, or the mission that settled it. */
export const MEMORY_SCOPES = ["repo", "mission"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export const MAX_MEMORY_SUBJECT = 80;
/** A mission's fact older than this many days leaves briefs and reads (§18.1). */
export const MEMORY_FACT_DAYS = 14;
/** An entry retired this many days becomes `removed` at the next write (§18.1). */
export const MEMORY_RETIRED_DAYS = 30;
const DAY_MS = 86_400_000;
/** The refusal of an `add` past `MAX_ACTIVE_MEMORY` (§2.5). */
export const MEMORY_FULL_REASON = `the memory holds ${MAX_ACTIVE_MEMORY} live entries; curate the memory first (bm_memory remove)`;

const entrySchema = z.object({
  id: z.string().regex(MEMORY_ID_PATTERN),
  kind: z.enum(MEMORY_KINDS),
  text: z.string().max(MAX_MEMORY_TEXT),
  source: z.string().max(MAX_MEMORY_SOURCE),
  by: z.object({ role: z.enum(MEMORY_AUTHORS), agentId: z.string().min(1).nullable(), missionId: z.string().min(1).nullable() }),
  at: z.string(),
  supersedes: z.string().regex(MEMORY_ID_PATTERN).nullable(),
  state: z.enum(["active", "removed"]),
  /** Absent on an entry stored before ADR-037: `scopeOf` reads the default. */
  scope: z.enum(MEMORY_SCOPES).optional(),
  subject: z.string().max(MAX_MEMORY_SUBJECT).optional(),
});

export type MemoryEntry = z.infer<typeof entrySchema>;

/** What a new entry says; `id` and `at` are the store's. */
export interface NewMemoryEntry {
  kind: MemoryKind;
  text: string;
  source: string;
  by: MemoryEntry["by"];
  supersedes?: string | null;
  /** `scopeOf`'s default when absent. */
  scope?: MemoryScope;
  /** A newer live entry with the same subject retires this one (§18.1). */
  subject?: string;
}

/** Why a live-looking entry is retired (§18.1), and since when. */
export type MemoryRetirement = { reason: "mission-closed" | "superseded" | "stale"; since: string };

/** A mission as retirement reads it; null = unknown to the data folder. */
export type MissionLife = { state: "open" | "closed"; closedAt: string | null } | null;

/** An entry's scope (§18.1): its own, else `mission` for a mission's fact or decision, else `repo`. Pure. */
export function scopeOf(entry: Pick<MemoryEntry, "scope" | "kind" | "by">): MemoryScope {
  if (entry.scope !== undefined) return entry.scope;
  return (entry.kind === "fact" || entry.kind === "decision") && entry.by.missionId !== null ? "mission" : "repo";
}

/** A subject as entries are compared by it: trimmed, case aside; null for none. Pure. */
const subjectKeyOf = (entry: Pick<MemoryEntry, "subject">): string | null => {
  const key = entry.subject?.trim().toLowerCase() ?? "";
  return key === "" ? null : key;
};

/**
 * The retired active entries by id (§18.1), the first reason that holds:
 * `mission-closed` (a mission entry of a closed or unknown mission), then
 * `superseded` (a newer active entry, not retired otherwise, names its
 * subject — a `repo` entry only by a `repo` one, so a mission's entry never
 * hides a lasting rule that would come back or be lost when the mission
 * closes; a `mission` entry by a `repo` one or one of its own mission), then
 * `stale` (a mission fact older than `MEMORY_FACT_DAYS`). Pure.
 */
export function retirementsOf(entries: readonly MemoryEntry[], missionOf: (missionId: string) => MissionLife, now: Date): Map<string, MemoryRetirement> {
  const active = entries.filter((entry) => entry.state === "active");
  const closed = new Map<string, MemoryRetirement>();
  const stale = new Map<string, MemoryRetirement>();
  const lives = new Map<string, MissionLife>();
  for (const entry of active) {
    if (scopeOf(entry) !== "mission") continue;
    const missionId = entry.by.missionId;
    const life = missionId === null ? null : lives.has(missionId) ? lives.get(missionId)! : (lives.set(missionId, missionOf(missionId)), lives.get(missionId)!);
    if (life === null || life.state === "closed") {
      closed.set(entry.id, { reason: "mission-closed", since: life?.closedAt ?? entry.at });
      continue;
    }
    const staleAt = timeOrZero(entry.at) + MEMORY_FACT_DAYS * DAY_MS;
    if (entry.kind === "fact" && staleAt <= now.getTime()) stale.set(entry.id, { reason: "stale", since: new Date(staleAt).toISOString() });
  }
  // The candidates that may supersede: active, not retired otherwise, with a subject.
  const bySubject = new Map<string, MemoryEntry[]>();
  for (const entry of active) {
    const key = subjectKeyOf(entry);
    if (key === null || closed.has(entry.id) || stale.has(entry.id)) continue;
    bySubject.set(key, [...(bySubject.get(key) ?? []), entry]);
  }
  /** Whether `newer` may retire `older` (same subject, later): a repo entry always; a mission entry only another entry of its own mission. */
  const replaces = (newer: MemoryEntry, older: MemoryEntry): boolean =>
    scopeOf(newer) === "repo" || (scopeOf(older) === "mission" && older.by.missionId !== null && older.by.missionId === newer.by.missionId);
  const retired = new Map<string, MemoryRetirement>(closed);
  for (const entry of active) {
    if (retired.has(entry.id)) continue;
    const key = subjectKeyOf(entry);
    const after = (other: MemoryEntry) => timeOrZero(other.at) > timeOrZero(entry.at) || (timeOrZero(other.at) === timeOrZero(entry.at) && active.indexOf(other) > active.indexOf(entry));
    const newer = key === null ? [] : (bySubject.get(key) ?? []).filter((other) => other.id !== entry.id && after(other) && replaces(other, entry));
    const winner = newer.sort((a, b) => timeOrZero(a.at) - timeOrZero(b.at) || active.indexOf(a) - active.indexOf(b)).at(-1);
    if (winner !== undefined) retired.set(entry.id, { reason: "superseded", since: winner.at });
    else if (stale.has(entry.id)) retired.set(entry.id, stale.get(entry.id)!);
  }
  return retired;
}

/** The source of the plugin's entry for an owner's answer (`decision-store.ts`); its request names its mission. */
const OWNER_ANSWER_SOURCE = /^the owner's answer to q:(req-[0-9TZ]+):/;

/**
 * The entries with an owner's answer stored before ADR-037 tied to its
 * request's mission (§18.1): `by.missionId` from `missionOfRequest` when the
 * entry has none. Every other entry as it is. Pure given `missionOfRequest`.
 */
export function resolvedMemory(entries: readonly MemoryEntry[], missionOfRequest: (requestId: string) => string | null): MemoryEntry[] {
  return entries.map((entry) => {
    if (entry.by.missionId !== null || entry.by.role !== "plugin") return entry;
    const requestId = OWNER_ANSWER_SOURCE.exec(entry.source)?.[1];
    const missionId = requestId === undefined ? null : missionOfRequest(requestId);
    return missionId === null ? entry : { ...entry, by: { ...entry.by, missionId } };
  });
}

/** The active entries `retirementsOf` keeps, oldest first. Pure. */
export function liveMemoryOf(entries: readonly MemoryEntry[], missionOf: (missionId: string) => MissionLife, now: Date): MemoryEntry[] {
  const retired = retirementsOf(entries, missionOf, now);
  return entries.filter((entry) => entry.state === "active" && !retired.has(entry.id));
}

/** The entries with every one retired for `MEMORY_RETIRED_DAYS` made `removed` (§18.1). Pure. */
export function prunedMemory(entries: readonly MemoryEntry[], missionOf: (missionId: string) => MissionLife, now: Date): MemoryEntry[] {
  const retired = retirementsOf(entries, missionOf, now);
  const cutoff = now.getTime() - MEMORY_RETIRED_DAYS * DAY_MS;
  return entries.map((entry) => {
    const found = retired.get(entry.id);
    return found !== undefined && timeOrZero(found.since) <= cutoff ? { ...entry, state: "removed" as const } : entry;
  });
}

export type MemoryResult = { ok: true; entry: MemoryEntry } | { ok: false; reasons: string[] };

/** A fresh entry id: `mem-` + 10 hex digits. */
export function newMemoryId(): string {
  return `mem-${randomBytes(5).toString("hex")}`;
}

/** The active entries, then the newest `MAX_REMOVED_MEMORY` removed ones, in file order. Pure. */
export function capMemory(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const removed = entries.flatMap((entry, index) => (entry.state === "removed" ? [index] : []));
  const kept = new Set(capBy(removed, MAX_REMOVED_MEMORY, (index) => timeOrZero(entries[index]!.at)));
  return entries.filter((entry, index) => entry.state === "active" || kept.has(index));
}

export interface MemoryStoreDeps {
  now?: () => Date;
  /** The entry id generator; `newMemoryId` by default (tests pin it). */
  newId?: () => string;
  /** Secrets to mask; the process's own by default. */
  env?: NodeJS.ProcessEnv;
  /** A mission's state for retirement; the data folder's mission store by default. */
  missionOf?: (missionId: string) => MissionLife;
  /** A request's mission; the data folder's rosters by default. */
  missionOfRequest?: (requestId: string) => string | null;
}

export interface MemoryStore {
  /** Every entry of the repo, oldest first (removed ones included). Never throws. */
  list(workspaceId: string): MemoryEntry[];
  /** The repo's active entries, oldest first. Never throws. */
  active(workspaceId: string): MemoryEntry[];
  /** The repo's live entries (§18.1), oldest first. Never throws. */
  live(workspaceId: string): MemoryEntry[];
  /** The repo's retired active entries with why, oldest first. Never throws. */
  retired(workspaceId: string): Array<{ entry: MemoryEntry; retirement: MemoryRetirement }>;
  /**
   * Adds an entry. Refused: a `supersedes` that names no active entry, and —
   * for an agent's or the owner's entry — a repo at `MAX_ACTIVE_MEMORY`
   * live entries. An automatic entry (`by.role: "plugin"`) at the bound
   * replaces the oldest automatic `decision` entry (refused when there is
   * none). Throws when the file cannot be written.
   */
  add(workspaceId: string, init: NewMemoryEntry): MemoryResult;
  /** An active entry becomes `removed`. Refused: an unknown or removed entry. Throws when the file cannot be written. */
  remove(workspaceId: string, id: string): MemoryResult;
}

function isUsableWorkspaceId(workspaceId: string): boolean {
  return WORKSPACE_ID_PATTERN.test(workspaceId) && workspaceId !== "." && workspaceId !== "..";
}

/** The project memory of the data folder `home`. Creating it touches nothing on disk. */
export function createMemoryStore(home: string, deps: MemoryStoreDeps = {}): MemoryStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? newMemoryId;
  const env = deps.env ?? process.env;
  const missionOf =
    deps.missionOf ??
    ((missionId: string): MissionLife => {
      // Unknown means no mission file; a file paseo-bm cannot read (a newer build's) reads as open, so nothing is pruned for it.
      const open: MissionLife = { state: "open", closedAt: null };
      try {
        const mission = createMissionStore(home).get(missionId);
        if (mission !== null) return { state: mission.state, closedAt: mission.closedAt };
        return existsSync(join(home, MISSIONS_DIR_NAME, `${missionId}.json`)) ? open : null;
      } catch {
        return open;
      }
    });

  const missionOfRequest =
    deps.missionOfRequest ??
    ((requestId: string): string | null => {
      try {
        return requestIndexOf(home, requestId)?.missionId ?? null;
      } catch {
        return null;
      }
    });

  // Delivery line design §3.1: a placement reads and adds to its repo's memory.
  const fileOf = (workspaceId: string): JsonFileStore<{ entries: MemoryEntry[] }> => {
    const repo = repoKeyOf(home, workspaceId);
    if (!isUsableWorkspaceId(repo)) throw new Error(`workspace id is not usable as a file name: ${JSON.stringify(repo)}`);
    return createJsonFileStore<{ entries: MemoryEntry[] }>({
      home,
      dir: MEMORY_DIR_NAME,
      file: `${repo}.json`,
      version: MEMORY_VERSION,
      versionKey: "schemaVersion",
      parse: (body) => ({ entries: entriesOf(entrySchema, body["entries"]) }),
      empty: () => ({ entries: [] }),
      cap: ({ entries }) => ({ entries: capMemory(entries) }),
      codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
      keepUnusable: true,
      cached: true,
    });
  };

  const list = (workspaceId: string): MemoryEntry[] => {
    try {
      return resolvedMemory(fileOf(workspaceId).read().entries, missionOfRequest);
    } catch {
      return [];
    }
  };

  /** One read-modify-write: `step` returns the entries and the entry the result names, or the refusal. */
  const change = (workspaceId: string, step: (entries: MemoryEntry[]) => { entries: MemoryEntry[]; entry: MemoryEntry } | { reasons: string[] }): MemoryResult => {
    let result: MemoryResult = { ok: false, reasons: ["the memory was not written"] };
    fileOf(workspaceId).update((current) => {
      // §18.1: what has been retired for MEMORY_RETIRED_DAYS is removed at a write.
      const next = step(prunedMemory(resolvedMemory(current.entries, missionOfRequest), missionOf, now()));
      if ("reasons" in next) {
        result = { ok: false, reasons: next.reasons };
        return null;
      }
      result = { ok: true, entry: next.entry };
      return { entries: next.entries };
    });
    return result;
  };

  return {
    list,
    active: (workspaceId) => list(workspaceId).filter((entry) => entry.state === "active"),
    live: (workspaceId) => liveMemoryOf(list(workspaceId), missionOf, now()),
    retired(workspaceId) {
      const entries = list(workspaceId);
      const retired = retirementsOf(entries, missionOf, now());
      return entries.flatMap((entry) => {
        const retirement = retired.get(entry.id);
        return retirement === undefined ? [] : [{ entry, retirement }];
      });
    },
    add(workspaceId, init) {
      return change(workspaceId, (current) => {
        const supersedes = init.supersedes ?? null;
        if (supersedes !== null && !current.some((entry) => entry.id === supersedes && entry.state === "active")) {
          return { reasons: [`memory entry ${supersedes} is not an active entry of this project`] };
        }
        const taken = new Set(current.map((entry) => entry.id));
        let id = newId();
        while (taken.has(id)) id = newId();
        const entry = entrySchema.parse({
          id,
          kind: init.kind,
          text: redactText(init.text, env).slice(0, MAX_MEMORY_TEXT),
          source: redactText(init.source, env).slice(0, MAX_MEMORY_SOURCE),
          by: init.by,
          at: now().toISOString(),
          supersedes,
          state: "active",
          ...(init.scope === undefined ? {} : { scope: init.scope }),
          ...(init.subject === undefined || init.subject.trim() === "" ? {} : { subject: redactText(init.subject.trim(), env).slice(0, MAX_MEMORY_SUBJECT) }),
        });
        let entries = current.map((found) => (found.id === supersedes ? { ...found, state: "removed" as const } : found));
        const live = new Set(liveMemoryOf(entries, missionOf, now()).map((found) => found.id));
        if (live.size >= MAX_ACTIVE_MEMORY) {
          if (init.by.role !== "plugin") return { reasons: [MEMORY_FULL_REASON] };
          const oldest = entries.find((found) => live.has(found.id) && found.by.role === "plugin" && found.kind === "decision");
          if (oldest === undefined) return { reasons: [MEMORY_FULL_REASON] };
          entries = entries.filter((found) => found.id !== oldest.id);
        }
        return { entries: [...entries, entry], entry };
      });
    },
    remove(workspaceId, id) {
      return change(workspaceId, (current) => {
        const found = current.find((entry) => entry.id === id && entry.state === "active");
        if (found === undefined) return { reasons: [`memory entry ${id} is not an active entry of this project`] };
        const entry = { ...found, state: "removed" as const };
        return { entries: current.map((other) => (other.id === id ? entry : other)), entry };
      });
    },
  };
}
