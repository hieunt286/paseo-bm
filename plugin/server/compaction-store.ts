/**
 * The compactions the Orchestrator asked for, and the plugin's send log
 * (autonomy design §G.5, §G.7; PRD REQ-134; bead `7gxw.10`).
 *
 * `<data folder>/orchestrator/compactions.json` =
 * `{ version: 1, entries: [<CompactionEntry>, …], sent: [<SendLogEntry>, …] }`,
 * oldest first.
 *
 * - **An entry** is one `bm_compact` the plugin accepted: its target (a
 *   Manager or a Worker of a project), the provider that decides the command's
 *   form, the intervention it is logged as, the Orchestrator's reason (masked,
 *   one line) and where its sequence stands (`compaction.ts`): `waiting` for
 *   the target's idle moment after a safe point, `compacting` once the
 *   `/compact` went out, then `done` (the `BM-STATE` brief handed to the notice
 *   queue), or ended without one: `failed` (no completed `compaction` item
 *   within `COMPACTION_WAIT_MS`) or `dropped` (no safe point within
 *   `SAFE_POINT_WAIT_MS`, or compaction turned off before it went out). An
 *   entry past its bound reads as ended (`staleEndingOf`) until a write
 *   records it.
 * - **Its compactions so far** (`sentCompactionsOf`) are the entries whose
 *   `/compact` went out: they count toward `compact.maxPerAgent` and key the
 *   `threshold.crossed` cycle (design §G.7).
 * - **The send log** (`sent`) is what the plugin sent an agent for a
 *   compaction — the `/compact` and its `BM-STATE` — as the agent, the time
 *   and a SHA-256 of the text, never the text. Paseo stores the plugin's
 *   message as a `user_message` carrying `clientMessageId`, exactly like one
 *   the owner typed (spike run note 2026-09-30 §5), and a leading `/compact`
 *   cannot tell them apart, since the owner may type one too. The collector
 *   therefore classifies a `user_message` matching an entry — same agent, same
 *   hash, within `SEND_LOG_MATCH` of its time — as the plugin's
 *   (`pluginSentMatcher`), never as the owner's words.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`):
 * the folder is created `0700` only by a write, never by a read; the file is
 * `0600` and replaced atomically; a symlink is refused; a missing or corrupt
 * file reads as empty; an entry that does not validate is skipped on its own
 * and dropped by the next write; a file of a newer version reads as empty and
 * is never written. The newest `COMPACTIONS_LIMIT` entries and
 * `SEND_LOG_LIMIT` send-log entries are kept. It lives in the Orchestrator's
 * folder, so the cleanup deletes it with `orchestrator/`.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { COMPACTION_PROVIDERS } from "../shared/coordination";
import { INTERVENTION_WINDOW_MS } from "../shared/interventions";
import { timeOrNull } from "../shared/time";
import { capBy, createJsonFileStore, entriesOf } from "./data-files";
import { ORCHESTRATOR_DIR_NAME } from "./orchestrator-store";

export const COMPACTIONS_FILE = "compactions.json";
/** The file format this build reads and writes. */
export const COMPACTIONS_FILE_VERSION = 1;
/** The newest entries kept. */
export const COMPACTIONS_LIMIT = 500;
/** The newest send-log entries kept. */
export const SEND_LOG_LIMIT = 500;

/**
 * How long a compaction waits for its target's idle moment after a safe
 * point: the `compact` intervention's window (design §G.3), so the check
 * judges one that went out within it.
 */
export const SAFE_POINT_WAIT_MS = INTERVENTION_WINDOW_MS.compact;
/**
 * How long after its `/compact` the plugin waits for the `compaction` item to
 * complete (design §G.5 step 3). Measured 4–19 s for a context of 22,000–33,000
 * tokens (spike run note 2026-09-30 §3); the bound leaves room for a large one.
 */
export const COMPACTION_WAIT_MS = 10 * 60_000;
/**
 * Around a send-log entry's time, where a `user_message` with its hash is the
 * plugin's: a moment before (the two clocks are the same machine's; the log
 * is written just before the send), and long enough after for a record whose
 * message times are its write time (AGENTS.md: a failed `timeline.refetch`
 * stamps every message with `now()`).
 */
export const SEND_LOG_MATCH = { beforeMs: 60_000, afterMs: 30 * 60_000 } as const;
/** The longest reason kept, as a command's `why` (`MAX_COMMAND_WHY_CHARS`). */
export const MAX_COMPACTION_REASON_CHARS = 300;

export const COMPACTION_STATES = ["waiting", "compacting", "done", "failed", "dropped"] as const;
export type CompactionState = (typeof COMPACTION_STATES)[number];
/** Why an entry ended without its brief. */
export const COMPACTION_ENDINGS = ["no-safe-point", "no-compaction", "off"] as const;
export type CompactionEnding = (typeof COMPACTION_ENDINGS)[number];

const time = z.string().min(1);

export const compactionEntrySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** A Worker's request (`bm.requestId`); null for a Manager. */
  requestId: z.string().min(1).nullable(),
  agentId: z.string().min(1),
  role: z.enum(["manager", "worker"]),
  /** The base provider: Claude gets `/compact <focus>`, Codex and OpenCode a bare `/compact` (design §G.5 Verified). */
  provider: z.enum(COMPACTION_PROVIDERS),
  /** The `compact` intervention it is logged as; null when that record failed. */
  interventionId: z.string().min(1).nullable(),
  /** The Orchestrator's reason, masked, on one line. */
  reason: z.string().max(MAX_COMPACTION_REASON_CHARS),
  state: z.enum(COMPACTION_STATES),
  requestedAt: time,
  /** When the `/compact` went out; null while it waits. */
  sentAt: time.nullable(),
  /** When the target's completed `compaction` item was recorded. */
  compactedAt: time.nullable(),
  /** When the `BM-STATE` brief was handed to the notice queue. */
  briefAt: time.nullable(),
  endedAt: time.nullable(),
  ending: z.enum(COMPACTION_ENDINGS).nullable(),
});
export type CompactionEntry = z.infer<typeof compactionEntrySchema>;

export const sendLogEntrySchema = z.object({
  agentId: z.string().min(1),
  at: time,
  /** SHA-256 of the text as sent, trimmed (`sentTextHashOf`). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  compactionId: z.string().min(1),
});
export type SendLogEntry = z.infer<typeof sendLogEntrySchema>;

interface CompactionsFile {
  entries: CompactionEntry[];
  sent: SendLogEntry[];
}

/** What `add` takes; the rest starts as `waiting`, at now. */
export type CompactionInput = Pick<CompactionEntry, "workspaceId" | "requestId" | "agentId" | "role" | "provider" | "interventionId" | "reason">;

export interface CompactionStoreDeps {
  now?: () => Date;
  /** A new entry id; `randomUUID` by default. */
  newId?: () => string;
}

export interface CompactionStore {
  /** `<data folder>/orchestrator/compactions.json`. */
  readonly path: string;
  /** Every entry, oldest first. */
  list(): CompactionEntry[];
  /** The entry with this id, or null. */
  get(id: string): CompactionEntry | null;
  /** The send log, oldest first. */
  sent(): SendLogEntry[];
  /** Appends one `waiting` entry at now. */
  add(input: CompactionInput): CompactionEntry;
  /** Changes one entry in one write; `change` returning the entry unchanged writes nothing. Returns the entry as stored, or null when it is not there. */
  update(id: string, change: (entry: CompactionEntry) => CompactionEntry): CompactionEntry | null;
  /** Records a message the plugin is about to send `agentId` for compaction `compactionId`, at now (once per text: a retry moves it). */
  logSend(agentId: string, text: string, compactionId: string): void;
  /** The `/compact` of `compactionId` went out now: its send-log entries take this time. */
  markSendTime(compactionId: string): void;
  /** Ends every entry past its bound (`staleEndingOf`) at now, in one write; returns the entries it ended. */
  expire(): CompactionEntry[];
}

/** SHA-256 of a message's text, trimmed: what the send log keeps instead of the text. */
export function sentTextHashOf(text: string): string {
  return createHash("sha256").update(text.trim(), "utf8").digest("hex");
}

/** Pending: waiting for its moment, or its `/compact` sent and the compaction not seen yet. */
export function isPendingState(state: CompactionState): boolean {
  return state === "waiting" || state === "compacting";
}

/**
 * How a pending entry ends at `now` once past its bound: `no-safe-point` for
 * one waiting longer than `SAFE_POINT_WAIT_MS`, `no-compaction` for one whose
 * `/compact` went out longer than `COMPACTION_WAIT_MS` ago with no completed
 * item seen. Null while it is within its bound, or not pending. Pure.
 */
export function staleEndingOf(entry: CompactionEntry, now: Date | number): CompactionEnding | null {
  const at = typeof now === "number" ? now : now.getTime();
  if (entry.state === "waiting") {
    const requested = timeOrNull(entry.requestedAt);
    return requested !== null && at - requested > SAFE_POINT_WAIT_MS ? "no-safe-point" : null;
  }
  if (entry.state === "compacting") {
    const sent = timeOrNull(entry.sentAt);
    return sent !== null && at - sent > COMPACTION_WAIT_MS ? "no-compaction" : null;
  }
  return null;
}

/** The entry `ending` ends at `at`: `failed` when its `/compact` went out, else `dropped`. Pure. */
export function endedEntry(entry: CompactionEntry, ending: CompactionEnding, at: string): CompactionEntry {
  return { ...entry, state: entry.sentAt === null ? "dropped" : "failed", ending, endedAt: at };
}

/** The agent's pending compaction at `now` (at most one: `bm_compact` refuses a second), or null. Pure. */
export function pendingCompactionOf(entries: readonly CompactionEntry[], agentId: string, now: Date | number): CompactionEntry | null {
  return entries.find((entry) => entry.agentId === agentId && isPendingState(entry.state) && staleEndingOf(entry, now) === null) ?? null;
}

/** Its compactions so far: the agent's entries whose `/compact` went out. Pure. */
export function sentCompactionsOf(entries: readonly CompactionEntry[], agentId: string): number {
  return entries.filter((entry) => entry.agentId === agentId && entry.sentAt !== null).length;
}

/**
 * Whether the plugin sent `text` to `agentId` around `at` (an ISO time; the
 * message's timeline time, or its record's write time): a send-log entry of
 * that agent with the text's hash, whose time is at most
 * `SEND_LOG_MATCH.beforeMs` after the message and at most
 * `SEND_LOG_MATCH.afterMs` before it. A message whose time cannot be read is
 * matched on the agent and the hash alone. Pure.
 */
export function isPluginSent(log: readonly SendLogEntry[], agentId: string, text: string, at: string | null): boolean {
  if (typeof text !== "string" || text.trim() === "") return false;
  const hash = sentTextHashOf(text);
  const when = timeOrNull(at);
  return log.some((entry) => {
    if (entry.agentId !== agentId || entry.hash !== hash) return false;
    const sent = timeOrNull(entry.at);
    if (when === null || sent === null) return true;
    return when >= sent - SEND_LOG_MATCH.beforeMs && when <= sent + SEND_LOG_MATCH.afterMs;
  });
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createCompactionStore(home: string, deps: CompactionStoreDeps = {}): CompactionStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const file = createJsonFileStore<CompactionsFile>({
    home,
    dir: ORCHESTRATOR_DIR_NAME,
    file: COMPACTIONS_FILE,
    version: COMPACTIONS_FILE_VERSION,
    parse: (body) => ({ entries: entriesOf(compactionEntrySchema, body["entries"]), sent: entriesOf(sendLogEntrySchema, body["sent"]) }),
    empty: () => ({ entries: [], sent: [] }),
    cap: ({ entries, sent }) => ({ entries: capBy(entries, COMPACTIONS_LIMIT), sent: capBy(sent, SEND_LOG_LIMIT) }),
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });

  return {
    path: file.path,

    list: () => file.read().entries,

    get: (id) => file.read().entries.find((entry) => entry.id === id) ?? null,

    sent: () => file.read().sent,

    add(input) {
      const entry = compactionEntrySchema.parse({
        id: newId(),
        ...input,
        state: "waiting",
        requestedAt: now().toISOString(),
        sentAt: null,
        compactedAt: null,
        briefAt: null,
        endedAt: null,
        ending: null,
      });
      file.update((current) => ({ ...current, entries: [...current.entries, entry] }));
      return entry;
    },

    update(id, change) {
      // Set inside the update, which runs synchronously.
      let stored = null as CompactionEntry | null;
      file.update((current) => {
        const index = current.entries.findIndex((entry) => entry.id === id);
        if (index === -1) return null;
        const before = current.entries[index]!;
        const after = compactionEntrySchema.parse(change(before));
        stored = after;
        if (JSON.stringify(after) === JSON.stringify(before)) return null;
        const entries = [...current.entries];
        entries[index] = after;
        return { ...current, entries };
      });
      return stored;
    },

    logSend(agentId, text, compactionId) {
      const entry = sendLogEntrySchema.parse({ agentId, at: now().toISOString(), hash: sentTextHashOf(text), compactionId });
      const same = (sent: SendLogEntry) => sent.agentId === entry.agentId && sent.hash === entry.hash && sent.compactionId === entry.compactionId;
      // A second attempt of the same message (its first was held and dropped) moves its entry to now.
      file.update((current) => ({ ...current, sent: [...current.sent.filter((sent) => !same(sent)), entry] }));
    },

    markSendTime(compactionId) {
      const at = now().toISOString();
      file.update((current) => {
        if (!current.sent.some((entry) => entry.compactionId === compactionId)) return null;
        return { ...current, sent: current.sent.map((entry) => (entry.compactionId === compactionId ? { ...entry, at } : entry)) };
      });
    },

    expire() {
      const at = now();
      const ended: CompactionEntry[] = [];
      const current = file.read();
      const entries = current.entries.map((entry) => {
        const ending = staleEndingOf(entry, at);
        if (ending === null) return entry;
        const next = endedEntry(entry, ending, at.toISOString());
        ended.push(next);
        return next;
      });
      // Nothing to end writes nothing, so a newer file refuses only a real change.
      if (ended.length > 0) file.write({ ...current, entries });
      return ended;
    },
  };
}

/**
 * The collector's reading of the send log in the data folder `home`
 * (`isPluginSent`), read once on first use: the `pluginSent` option of
 * `originOf` (`shared/message-origin.ts`, design §16.2), bound to one agent and
 * time by each caller. A log that cannot be read is empty — the message then
 * stays what the other rules say. Never throws.
 */
export function pluginSentMatcher(home: string | null): (agentId: string, text: string, at: string | null) => boolean {
  let log: readonly SendLogEntry[] | null = null;
  return (agentId, text, at) => {
    if (home === null) return false;
    if (log === null) {
      try {
        log = createCompactionStore(home).sent();
      } catch {
        log = [];
      }
    }
    return isPluginSent(log, agentId, text, at);
  };
}
