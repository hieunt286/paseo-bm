/**
 * Project memory (missions design §2.5, §7; ADR-029): what a repo has
 * decided, learnt and agreed, for the Mains and Workers that come after.
 *
 * `<data folder>/memory/<workspaceId>.json` =
 * `{ schemaVersion: 1, entries: [{ id, kind, text, source, by, at, supersedes, state }] }`.
 *
 * - **Masking:** `text` (≤ `MAX_MEMORY_TEXT`) and `source`
 *   (≤ `MAX_MEMORY_SOURCE`) are masked with `redactText`.
 * - **Bounds:** at most `MAX_ACTIVE_MEMORY` active entries. An agent's `add`
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
/** The refusal of an `add` past `MAX_ACTIVE_MEMORY` (§2.5). */
export const MEMORY_FULL_REASON = `the memory holds ${MAX_ACTIVE_MEMORY} active entries; curate the memory first (bm_memory remove)`;

const entrySchema = z.object({
  id: z.string().regex(MEMORY_ID_PATTERN),
  kind: z.enum(MEMORY_KINDS),
  text: z.string().max(MAX_MEMORY_TEXT),
  source: z.string().max(MAX_MEMORY_SOURCE),
  by: z.object({ role: z.enum(MEMORY_AUTHORS), agentId: z.string().min(1).nullable(), missionId: z.string().min(1).nullable() }),
  at: z.string(),
  supersedes: z.string().regex(MEMORY_ID_PATTERN).nullable(),
  state: z.enum(["active", "removed"]),
});

export type MemoryEntry = z.infer<typeof entrySchema>;

/** What a new entry says; `id` and `at` are the store's. */
export interface NewMemoryEntry {
  kind: MemoryKind;
  text: string;
  source: string;
  by: MemoryEntry["by"];
  supersedes?: string | null;
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
}

export interface MemoryStore {
  /** Every entry of the repo, oldest first (removed ones included). Never throws. */
  list(workspaceId: string): MemoryEntry[];
  /** The repo's active entries, oldest first. Never throws. */
  active(workspaceId: string): MemoryEntry[];
  /**
   * Adds an entry. Refused: a `supersedes` that names no active entry, and —
   * for an agent's or the owner's entry — a repo at `MAX_ACTIVE_MEMORY`
   * active entries. An automatic entry (`by.role: "plugin"`) at the bound
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

  const fileOf = (workspaceId: string): JsonFileStore<{ entries: MemoryEntry[] }> => {
    if (!isUsableWorkspaceId(workspaceId)) throw new Error(`workspace id is not usable as a file name: ${JSON.stringify(workspaceId)}`);
    return createJsonFileStore<{ entries: MemoryEntry[] }>({
      home,
      dir: MEMORY_DIR_NAME,
      file: `${workspaceId}.json`,
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
      return fileOf(workspaceId).read().entries;
    } catch {
      return [];
    }
  };

  /** One read-modify-write: `step` returns the entries and the entry the result names, or the refusal. */
  const change = (workspaceId: string, step: (entries: MemoryEntry[]) => { entries: MemoryEntry[]; entry: MemoryEntry } | { reasons: string[] }): MemoryResult => {
    let result: MemoryResult = { ok: false, reasons: ["the memory was not written"] };
    fileOf(workspaceId).update((current) => {
      const next = step(current.entries);
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
        });
        let entries = current.map((found) => (found.id === supersedes ? { ...found, state: "removed" as const } : found));
        if (entries.filter((found) => found.state === "active").length >= MAX_ACTIVE_MEMORY) {
          if (init.by.role !== "plugin") return { reasons: [MEMORY_FULL_REASON] };
          const oldest = entries.find((found) => found.state === "active" && found.by.role === "plugin" && found.kind === "decision");
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
