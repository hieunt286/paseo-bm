/**
 * The owner's precedents (autonomy design §B.6, §B.9; PRD REQ-124): the store
 * `<data folder>/autonomy/precedents.json` =
 * `{ version: 1, entries: [{ id, scope, subject, text, sourceDecisionId, createdAt, expiresAt, supersededBy }] }`.
 * The schema and its pure rules are `shared/precedents.ts`; the owner's RPCs
 * over it are in `autonomy-rpc.ts`, beside the policy's.
 *
 * - Saving a precedent with the scope and subject of an active one supersedes
 *   that one (`supersededBy`, REQ-124 c) in the same write. So does the
 *   owner's answer on its subject that differs from it (`supersede`, called by
 *   `precedent-resolve.ts`), with the decision's id.
 * - Ending a precedent sets its `expiresAt` to now; one already inactive is
 *   left as it is.
 * - Every active precedent is kept; of the inactive ones (expired, ended,
 *   superseded) the `PRECEDENT_INACTIVE_LIMIT` newest are kept.
 *
 * The file rules are the policy store's (`autonomy-store.ts`), in the same
 * folder, and every store's (`data-files.ts` `createJsonFileStore`, code
 * review 2026-09-30 §3.1): the folder is created `0700` only by a write, never
 * by a read; the file is `0600` and replaced atomically; a symlink anywhere
 * below the data folder is refused (`E_TRACE_STORE_UNWRITABLE`, as a failed
 * write). A missing or corrupt file reads as none; an entry that does not
 * validate is skipped alone and dropped by the next write; a file whose
 * `version` is newer than this build reads as none and is never written
 * (`E_PRECEDENT_WRITE_FAILED`). A refused save writes nothing.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { randomUUID } from "node:crypto";
import { DashboardError } from "../shared/contracts";
import {
  PRECEDENTS_FILE_VERSION,
  activeFor,
  activePrecedents,
  expiresAtOf,
  isActive,
  precedentSchema,
  precedentsOf,
  type Precedent,
  type PrecedentDraft,
} from "../shared/precedents";
import { AUTONOMY_DIR_NAME } from "./autonomy-store";
import { capBy, createJsonFileStore } from "./data-files";
import { timeOrZero } from "../shared/time";

export const PRECEDENTS_FILE = "precedents.json";
/** Inactive precedents kept; active ones are never evicted. */
export const PRECEDENT_INACTIVE_LIMIT = 500;

export interface PrecedentStoreDeps {
  /** A new precedent's id, after `p:`; `randomUUID` by default. */
  newId?: () => string;
}

export interface SavePrecedentResult {
  precedent: Precedent;
  /** The ids of the active precedents of the same scope and subject it replaced. */
  superseded: string[];
}

export interface PrecedentStore {
  /** `<data folder>/autonomy/precedents.json`. */
  readonly path: string;
  /** Every readable precedent, in file order. Throws only on a symlink. */
  read(): Precedent[];
  /** The active precedents, newest first: of one workspace and the global ones, or all of them. */
  active(now: Date, workspaceId?: string): Precedent[];
  /** The precedent with this id, active or not; null when none. */
  get(id: string): Precedent | null;
  /**
   * Stores a checked draft, created `now`, and supersedes every active
   * precedent of the same scope and subject in the same write. Throws,
   * writing nothing, on a draft that does not validate
   * (`E_PRECEDENT_INVALID`) and on a file written by a newer paseo-bm
   * (`E_PRECEDENT_WRITE_FAILED`).
   */
  save(draft: PrecedentDraft, now: Date): SavePrecedentResult;
  /**
   * Ends a precedent: its `expiresAt` becomes `now`. One already inactive is
   * returned as it is and nothing is written. Null when there is no such id.
   */
  end(id: string, now: Date): Precedent | null;
  /**
   * Marks these precedents superseded by `by` — the owner's decision that
   * answered their subject differently (REQ-124 c) — in one write, and returns
   * them as stored. An id that is unknown or no longer active is left as it
   * is; nothing is written when none changes. Throws, writing nothing, on a
   * `by` that is neither a precedent nor a decision id (`E_PRECEDENT_INVALID`)
   * and on a file written by a newer paseo-bm (`E_PRECEDENT_WRITE_FAILED`).
   */
  supersede(ids: readonly string[], by: string, now: Date): Precedent[];
}

/**
 * Keeps every active precedent and the `PRECEDENT_INACTIVE_LIMIT` newest
 * inactive ones (by `createdAt`; of a tie, the later in the file), in file order.
 */
export function capPrecedents(entries: readonly Precedent[], now: Date): Precedent[] {
  const inactive = entries.flatMap((entry, index) => (isActive(entry, now) ? [] : [index]));
  const kept = new Set(capBy(inactive, PRECEDENT_INACTIVE_LIMIT, (index) => timeOrZero(entries[index]!.createdAt)));
  return entries.filter((entry, index) => isActive(entry, now) || kept.has(index));
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createPrecedentStore(home: string, deps: PrecedentStoreDeps = {}): PrecedentStore {
  const newId = deps.newId ?? (() => randomUUID());
  // The cap depends on the time of the write, so each write applies it (`write` below).
  const file = createJsonFileStore<{ entries: Precedent[] }>({
    home,
    dir: AUTONOMY_DIR_NAME,
    file: PRECEDENTS_FILE,
    version: PRECEDENTS_FILE_VERSION,
    parse: (body) => ({ entries: Array.isArray(body["entries"]) ? precedentsOf(body["entries"] as unknown[]) : [] }),
    empty: () => ({ entries: [] }),
    // A failed write keeps the code it has always had.
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE", tooNew: "E_PRECEDENT_WRITE_FAILED" },
  });

  const load = (): Precedent[] => file.read().entries;
  // Throws, writing nothing, on a newer file: even a change that would write nothing is refused.
  const loadForWrite = (): Precedent[] => file.readForWrite().entries;
  const write = (entries: readonly Precedent[], now: Date): void => {
    file.write({ entries: capPrecedents(entries, now) });
  };

  return {
    path: file.path,

    read() {
      return load();
    },

    active(now, workspaceId) {
      const entries = load();
      return workspaceId === undefined ? activePrecedents(entries, now) : activeFor(entries, workspaceId, now);
    },

    get(id) {
      return load().find((entry) => entry.id === id) ?? null;
    },

    save(draft, now) {
      const at = now.toISOString();
      const parsed = precedentSchema.safeParse({
        id: `p:${newId()}`,
        scope: draft.scope,
        subject: draft.subject,
        text: draft.text,
        sourceDecisionId: draft.sourceDecisionId,
        createdAt: at,
        expiresAt: expiresAtOf(now, draft.expiresInDays),
        supersededBy: null,
      });
      if (!parsed.success || !(draft.expiresInDays > 0)) {
        const why = parsed.success ? "its expiry is not in the future" : `${String(parsed.error.issues[0]?.path[0] ?? "")}: ${parsed.error.issues[0]?.message ?? ""}`;
        throw new DashboardError("E_PRECEDENT_INVALID", `the precedent does not validate (${why}); nothing was saved`);
      }
      const precedent = parsed.data;
      const entries = loadForWrite();
      const superseded: string[] = [];
      const next = entries.map((entry) => {
        if (entry.scope !== precedent.scope || entry.subject !== precedent.subject || !isActive(entry, now)) return entry;
        superseded.push(entry.id);
        return { ...entry, supersededBy: precedent.id };
      });
      write([...next, precedent], now);
      return { precedent, superseded };
    },

    end(id, now) {
      const entries = loadForWrite();
      const found = entries.find((entry) => entry.id === id);
      if (found === undefined) return null;
      if (!isActive(found, now)) return found;
      const ended: Precedent = { ...found, expiresAt: now.toISOString() };
      write(
        entries.map((entry) => (entry.id === id ? ended : entry)),
        now,
      );
      return ended;
    },

    supersede(ids, by, now) {
      // Checked before anything is read: a value the schema would refuse would drop the entry at the next read.
      if (typeof by !== "string" || !precedentSchema.shape.supersededBy.safeParse(by).success) {
        throw new DashboardError("E_PRECEDENT_INVALID", `${JSON.stringify(by)} is neither a precedent nor a decision id; nothing was superseded`);
      }
      const wanted = new Set(ids);
      if (wanted.size === 0) return [];
      const entries = loadForWrite();
      const changed: Precedent[] = [];
      const next = entries.map((entry) => {
        if (!wanted.has(entry.id) || !isActive(entry, now)) return entry;
        const superseded: Precedent = { ...entry, supersededBy: by };
        changed.push(superseded);
        return superseded;
      });
      if (changed.length > 0) write(next, now);
      return changed;
    },
  };
}
