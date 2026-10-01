/**
 * When the owner last looked at the Inbox (autonomy design §B.7, §B.9):
 * `<data folder>/inbox/seen.json` = `{ version: 1, seenAt, since }`, beside the
 * alerts (`alert-store.ts`) and with the same file rules (`data-files.ts`
 * `createJsonFileStore`): the folder is created `0700` only by a write, the
 * file is `0600` and replaced atomically, a symlink below the data folder is
 * refused, a missing or corrupt file reads as never seen, and a file a newer
 * paseo-bm wrote reads as never seen and is never written. Cleanup deletes
 * the `inbox/` folder with it.
 *
 * - `seenAt`: the last time the Inbox was shown (its polls included).
 * - `since`: where Decided for you starts — the last time the owner looked
 *   before the current visit; null when the Inbox was never shown before it.
 *
 * A **visit** goes on while the Inbox is shown again within
 * `INBOX_VISIT_GAP_MS` of `seenAt`: its 5-second polls, a reload of the app or
 * the plugin, a quick look at Work. Within a visit `since` stays put, so the
 * digest survives a reload; the first showing after a longer gap starts a new
 * visit, whose `since` is the previous `seenAt` — what the owner saw then
 * leaves the digest (it stays visible in Work). A time that does not read, or
 * a `seenAt` in the future (a clock set back), keeps the visit and is
 * written again.
 *
 * Writes are kept few: a showing within a visit writes only once
 * `INBOX_SEEN_WRITE_EVERY_MS` has passed since `seenAt`. **No lock, on
 * purpose:** every operation is synchronous and the plugin server is one thread.
 */
import { createJsonFileStore, type JsonFileRead } from "./data-files";
import { INBOX_DIR_NAME } from "./alert-store";

export const INBOX_SEEN_FILE = "seen.json";
/** The file format this build reads and writes. */
export const INBOX_SEEN_FILE_VERSION = 1;
/** A showing this soon after the last one is the same visit (§B.9): `since` does not move. */
export const INBOX_VISIT_GAP_MS = 5 * 60_000;
/** Within a visit, `seenAt` is written again only this long after the last write. */
export const INBOX_SEEN_WRITE_EVERY_MS = 30_000;

export interface InboxSeen {
  /** The last time the Inbox was shown; null when never. */
  seenAt: string | null;
  /** Where Decided for you starts: when the owner last looked before this visit; null when never. */
  since: string | null;
}

const NEVER: InboxSeen = { seenAt: null, since: null };

function timeOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * The state after the Inbox is shown at `now`, and whether it must be
 * written (see the module comment). Pure.
 */
export function nextInboxSeen(current: InboxSeen, now: Date): { seen: InboxSeen; write: boolean } {
  const at = now.toISOString();
  const last = current.seenAt === null ? Number.NaN : Date.parse(current.seenAt);
  if (Number.isNaN(last)) return { seen: { seenAt: at, since: null }, write: true };
  const elapsed = now.getTime() - last;
  if (elapsed > INBOX_VISIT_GAP_MS) return { seen: { seenAt: at, since: current.seenAt }, write: true };
  // The same visit: `since` stays. A clock set back is written again, so the next gap is measured from now.
  return { seen: { seenAt: at, since: current.since }, write: elapsed < 0 || elapsed >= INBOX_SEEN_WRITE_EVERY_MS };
}

export interface InboxSeenStore {
  /** `<data folder>/inbox/seen.json`. */
  readonly path: string;
  /** What is on disk and what was found; creates nothing. Throws `E_INBOX_WRITE_FAILED` on a symlink below the data folder. */
  inspect(): JsonFileRead<InboxSeen>;
  /** The Inbox is shown at `now`: the state it leaves (written when `nextInboxSeen` says so). Throws `E_INBOX_WRITE_FAILED`. */
  shown(now: Date): InboxSeen;
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createInboxSeenStore(home: string): InboxSeenStore {
  const file = createJsonFileStore<InboxSeen>({
    home,
    dir: INBOX_DIR_NAME,
    file: INBOX_SEEN_FILE,
    version: INBOX_SEEN_FILE_VERSION,
    parse: (body) => {
      const seenAt = timeOrNull(body["seenAt"]);
      // A `since` without a `seenAt` has no visit to belong to.
      return { seenAt, since: seenAt === null ? null : timeOrNull(body["since"]) };
    },
    empty: () => ({ ...NEVER }),
    codes: { unwritable: "E_INBOX_WRITE_FAILED" },
  });

  return {
    path: file.path,
    inspect: () => file.inspect(),
    shown(now) {
      let seen: InboxSeen = NEVER;
      file.update((current) => {
        const next = nextInboxSeen(current, now);
        seen = next.seen;
        return next.write ? next.seen : null;
      });
      return seen;
    },
  };
}
