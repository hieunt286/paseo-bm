/**
 * The Ask back threads (change-014 outcome 3): the owner's questions to the
 * asker of an open decision and the asker's replies, beside the decision
 * store: `<data folder>/decisions/threads/<workspaceId>.json` =
 * `{ version: 1, threads: [{ decisionId, entries: [{ by, text, at, agentId? }] }] }`.
 *
 * - **Beside, not inside, the decision.** A thread never changes a decision:
 *   asking and replying leave it open (`shared/decision-threads.ts`).
 * - **Masked before the disk** (REQ-048b): every text goes through
 *   `redactText` here, then is cut to `MAX_THREAD_TEXT_CHARS`.
 * - **Bounded:** the `MAX_THREAD_ENTRIES` newest entries per decision, and the
 *   `THREADS_PER_WORKSPACE_LIMIT` threads written to most recently per
 *   workspace.
 * - **Cleanup** deletes it with `decisions/`. The decision store lists only
 *   the `*.json` files of `decisions/` itself, so this folder is never read as
 *   a workspace.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`):
 * the folder is created `0700` only by a write, the file is `0600` and
 * replaced atomically, a symlink is refused; a missing or corrupt file reads
 * as empty, a thread that does not validate is skipped alone and dropped by the
 * next write, a file of a newer version reads as empty and is never written.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so the check and the append of `append` cannot
 * interleave with another.
 */
import { join } from "node:path";
import { redactText } from "./collector";
import { capBy, createJsonFileStore, entriesOf } from "./data-files";
import { DECISIONS_DIR_NAME } from "./decision-store";
import { assertWorkspaceId } from "./trace-store";
import {
  MAX_THREAD_ENTRIES,
  MAX_THREAD_TEXT_CHARS,
  decisionThreadSchema,
  type DecisionThread,
  type ThreadEntry,
} from "../shared/decision-threads";
import { timeOrZero } from "../shared/time";

/** The folder inside `decisions/`. */
export const THREADS_DIR_NAME = "threads";
/** The file format this build reads and writes. */
export const THREADS_FILE_VERSION = 1;
/** Threads kept per workspace: those written to most recently. */
export const THREADS_PER_WORKSPACE_LIMIT = 500;

export interface DecisionThreadStoreDeps {
  /** Secrets to mask; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
}

export interface DecisionThreadStore {
  /** The thread of a decision; no entries when none was written. */
  read(workspaceId: string, decisionId: string): DecisionThread;
  /**
   * Appends `entry` (its text masked and cut) to the decision's thread, when
   * `accept` — given the thread as it is — says true; returns the thread as
   * written, or null when refused (nothing is written). Throws
   * `E_TRACE_STORE_UNWRITABLE` when the file cannot be written.
   */
  append(workspaceId: string, decisionId: string, entry: ThreadEntry, accept?: (thread: DecisionThread) => boolean): DecisionThread | null;
}

type ThreadsFile = { threads: DecisionThread[] };

/** The text as stored: masked, then cut to the limit. */
export function storedThreadText(text: string, env: NodeJS.ProcessEnv): string {
  return redactText(text.trim(), env).slice(0, MAX_THREAD_TEXT_CHARS);
}

/** The time a thread was last written to: its newest entry's. */
const lastAt = (thread: DecisionThread): number => timeOrZero(thread.entries.at(-1)?.at ?? null);

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createDecisionThreadStore(home: string, deps: DecisionThreadStoreDeps = {}): DecisionThreadStore {
  const env = deps.redactEnv ?? process.env;
  const fileOf = (workspaceId: string) => {
    assertWorkspaceId(workspaceId);
    return createJsonFileStore<ThreadsFile>({
      home,
      dir: join(DECISIONS_DIR_NAME, THREADS_DIR_NAME),
      file: `${workspaceId}.json`,
      version: THREADS_FILE_VERSION,
      parse: (body) => ({ threads: entriesOf(decisionThreadSchema, body["threads"]) }),
      empty: () => ({ threads: [] }),
      cap: ({ threads }) => ({ threads: capBy(threads, THREADS_PER_WORKSPACE_LIMIT, lastAt) }),
      codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
    });
  };

  return {
    read(workspaceId, decisionId) {
      const found = fileOf(workspaceId)
        .read()
        .threads.find((thread) => thread.decisionId === decisionId);
      return found ?? { decisionId, entries: [] };
    },

    append(workspaceId, decisionId, entry, accept) {
      const text = storedThreadText(entry.text, env);
      if (text === "") return null;
      const stored: ThreadEntry = { by: entry.by, text, at: entry.at, ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }) };
      let written: DecisionThread | null = null;
      fileOf(workspaceId).update((current) => {
        const index = current.threads.findIndex((thread) => thread.decisionId === decisionId);
        const thread = index >= 0 ? current.threads[index]! : { decisionId, entries: [] };
        if (accept !== undefined && !accept(thread)) return null;
        written = { decisionId, entries: capBy([...thread.entries, stored], MAX_THREAD_ENTRIES) };
        const threads = index >= 0 ? current.threads.map((old, at) => (at === index ? written! : old)) : [...current.threads, written];
        return { threads };
      });
      return written;
    },
  };
}
