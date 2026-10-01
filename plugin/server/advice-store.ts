/**
 * The advice cadence's count (autonomy design §G.4, §G.7; PRD REQ-128;
 * ADR-021 decision 5): per project, the finished requests counted since its
 * last `advice.due`, so the event bus wakes the Orchestrator once for every
 * `advice.everyFinished` of them.
 *
 * `<data folder>/orchestrator/advice.json` =
 * `{ version: 1, entries: { <workspaceId>: { counted: [<request key>, …], at, dueAt } } }`:
 * the keys of the requests counted since the last advice (each once per
 * cycle, however many `finished` reports it sends in it), when the project was
 * last counted, and when it was last due (null before its first advice). Ids
 * and times only.
 *
 * - **Counted at the source** (`count`): each `finished` report of a recorded
 *   Manager turn (`event-bus.ts` `finishedRequestKeysOf`). When the count
 *   reaches the cadence, it is due: the entry is reset in the same write, so
 *   one count gives one `advice.due`, whatever becomes of it (an event with no
 *   Orchestrator to wake is not queued, as every event).
 * - **Off** (`advice.everyFinished` 0): nothing is counted.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`):
 * the folder is created `0700` only by a write, the file is `0600` and
 * replaced atomically, a symlink is refused; a missing or corrupt file reads
 * as empty, an entry that does not validate is skipped alone and dropped by
 * the next write, a file of a newer version reads as empty and is never
 * written. The `ADVICE_PROJECTS_LIMIT` projects counted most recently are
 * kept. It lives in the Orchestrator's folder, so the cleanup deletes it with
 * `orchestrator/`.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { z } from "zod";
import { ADVICE_EVERY_FINISHED } from "../shared/coordination";
import { timeOrZero } from "../shared/time";
import { capBy, createJsonFileStore, keyedEntriesOf } from "./data-files";
import { ORCHESTRATOR_DIR_NAME } from "./orchestrator-store";

export const ADVICE_FILE = "advice.json";
/** The file format this build reads and writes. */
export const ADVICE_FILE_VERSION = 1;
/** The projects kept, those counted most recently. */
export const ADVICE_PROJECTS_LIMIT = 500;

/** One project's count since its last advice. */
export const adviceCountSchema = z.object({
  /** The request keys counted since the last advice, oldest first; never more than the cadence's bound. */
  counted: z.array(z.string().min(1)).max(ADVICE_EVERY_FINISHED.max),
  /** When the project was last counted. */
  at: z.string().min(1),
  /** When it was last due; null before its first advice. */
  dueAt: z.string().min(1).nullable(),
});
export type AdviceCount = z.infer<typeof adviceCountSchema>;

/** What one count did: how many requests are counted now, and whether that made the advice due (the count then starts again). */
export interface AdviceCountResult {
  /** The requests counted since the last advice, this call's included; at the moment it became due, the count that reached the cadence. */
  finished: number;
  due: boolean;
}

export interface AdviceStore {
  /** `<data folder>/orchestrator/advice.json`. */
  readonly path: string;
  /** Every project's count. */
  read(): Record<string, AdviceCount>;
  /**
   * Counts the finished requests `keys` of a project at `at`, each once per
   * cycle. When the count reaches `everyFinished` (at least 1), the advice is
   * due: the count starts again in the same write. Nothing is counted — and
   * nothing written — for no new key or a cadence of 0.
   */
  count(workspaceId: string, keys: readonly string[], everyFinished: number, at: string): AdviceCountResult;
}

/** A workspace id the file keys a project by; `__proto__` would read as the prototype, not a project. */
const isProjectKey = (key: string): boolean => key !== "" && key !== "__proto__";

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createAdviceStore(home: string): AdviceStore {
  const file = createJsonFileStore<{ entries: Record<string, AdviceCount> }>({
    home,
    dir: ORCHESTRATOR_DIR_NAME,
    file: ADVICE_FILE,
    version: ADVICE_FILE_VERSION,
    parse: (body) => ({ entries: keyedEntriesOf(adviceCountSchema, body["entries"], (key) => isProjectKey(key)) }),
    empty: () => ({ entries: {} }),
    cap: ({ entries }) => ({ entries: Object.fromEntries(capBy(Object.entries(entries), ADVICE_PROJECTS_LIMIT, ([, entry]) => timeOrZero(entry.at))) }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });

  return {
    path: file.path,

    read() {
      return file.read().entries;
    },

    count(workspaceId, keys, everyFinished, at) {
      const entryOf = (entries: Record<string, AdviceCount>): AdviceCount | null => (Object.hasOwn(entries, workspaceId) ? entries[workspaceId]! : null);
      // Set inside the update, which runs synchronously.
      let result = null as AdviceCountResult | null;
      if (everyFinished >= 1 && keys.length > 0 && isProjectKey(workspaceId)) {
        file.update((current) => {
          const entry = entryOf(current.entries) ?? { counted: [], at, dueAt: null };
          const fresh = [...new Set(keys)].filter((key) => !entry.counted.includes(key));
          if (fresh.length === 0) return null;
          const all = [...entry.counted, ...fresh];
          const due = all.length >= everyFinished;
          result = { finished: all.length, due };
          const next: AdviceCount = due ? { counted: [], at, dueAt: at } : { counted: all.slice(-ADVICE_EVERY_FINISHED.max), at, dueAt: entry.dueAt };
          return { entries: { ...current.entries, [workspaceId]: next } };
        });
      }
      return result ?? { finished: entryOf(file.read().entries)?.counted.length ?? 0, due: false };
    },
  };
}
