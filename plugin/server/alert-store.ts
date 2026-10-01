/**
 * The Inbox alerts store (autonomy design §A.8): `<data folder>/inbox/alerts.json`
 * = `{ version: 1, entries: { <key>: { workspaceId, kind, subject, since, clearedAt, detail?, role? } } }`.
 *
 * An alert is raised **once per key** — raising an open key changes nothing but
 * its `detail` — and cleared when its condition ends (an agent runs again, the
 * permission is answered, the Worker's turn ends, the incident is resolved). A
 * cleared key raised again opens afresh with a new `since`. Alerts are data the
 * Inbox reads: nothing here ever messages the owner or an agent.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`,
 * code review 2026-09-30 §3.1): the folder is created `0700` only by a write,
 * never by a read; the file is `0600` and replaced atomically; a symlink
 * anywhere below the data folder is refused. A missing or corrupt file reads
 * as empty; an entry that does not validate is skipped on its own and dropped
 * by the next write; a file whose `version` is newer than this build reads as
 * empty and is never written — a write throws `E_TRACE_STORE_UNWRITABLE`, the
 * code of every failure of this file.
 *
 * Open alerts are never evicted; of the cleared ones the `ALERT_CLEARED_LIMIT`
 * newest (by `clearedAt`) are kept.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import {
  ALERTS_FILE_VERSION,
  MAX_ALERT_DETAIL_CHARS,
  alertEntrySchema,
  alertKeyOf,
  type Alert,
  type AlertEntry,
  type AlertKind,
  type AlertRole,
} from "../shared/alerts";
import { capBy, createJsonFileStore, keyedEntriesOf } from "./data-files";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { timeOrZero } from "../shared/time";

/** The folder inside the data folder; cleanup deletes it whole. */
export const INBOX_DIR_NAME = "inbox";
export const ALERTS_FILE = "alerts.json";
/** Cleared alerts kept; open ones are never evicted. */
export const ALERT_CLEARED_LIMIT = 500;

export interface AlertStoreDeps {
  now?: () => Date;
}

/** What `raise` records. */
export interface AlertInput {
  workspaceId: string | null;
  kind: AlertKind;
  subject: string;
  /** A short line, already redacted; cut to `MAX_ALERT_DETAIL_CHARS`. */
  detail?: string | null;
  /** The agent's role, on an `outdated-agent` alert. */
  role?: AlertRole;
}

export interface RaiseAlertResult {
  /** True when the key was not open before this call: the one time a producer acts on it. */
  raised: boolean;
  alert: Alert;
}

export interface AlertFilter {
  /** Only the open (`true`) or cleared (`false`) alerts. */
  open?: boolean;
  workspaceId?: string;
  kinds?: readonly AlertKind[];
  subject?: string;
}

export interface AlertStore {
  /** `<data folder>/inbox/alerts.json`. */
  readonly path: string;
  /** Opens the alert of this key, or only updates its `detail` when it is open already. */
  raise(input: AlertInput): RaiseAlertResult;
  /** Clears an open alert. False when nothing was open under that key. */
  clear(key: string): boolean;
  /** Clears every open alert that matches; returns the cleared keys. */
  clearWhere(match: (alert: Alert) => boolean): string[];
  /** The alert of this key, open or cleared; null when none. */
  get(key: string): Alert | null;
  /** True while the alert of this key is open. */
  isOpen(key: string): boolean;
  /** The alerts that match, oldest first. */
  list(filter?: AlertFilter): Alert[];
}

function detailOf(detail: string | null | undefined): string | undefined {
  if (typeof detail !== "string") return undefined;
  const line = detail.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  const chars = [...line];
  return chars.length <= MAX_ALERT_DETAIL_CHARS ? line : `${chars.slice(0, MAX_ALERT_DETAIL_CHARS - 1).join("")}…`;
}

/** Keeps every open alert and the `ALERT_CLEARED_LIMIT` newest cleared ones (by `clearedAt`; of a tie, the later key). */
export function capAlerts(entries: Record<string, AlertEntry>): Record<string, AlertEntry> {
  const cleared = Object.entries(entries).filter(([, entry]) => entry.clearedAt !== null);
  const kept = new Set(capBy(cleared, ALERT_CLEARED_LIMIT, ([, entry]) => timeOrZero(entry.clearedAt)).map(([key]) => key));
  return Object.fromEntries(Object.entries(entries).filter(([key, entry]) => entry.clearedAt === null || kept.has(key)));
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createAlertStore(home: string, deps: AlertStoreDeps = {}): AlertStore {
  const now = deps.now ?? (() => new Date());
  const file = createJsonFileStore<{ entries: Record<string, AlertEntry> }>({
    home,
    dir: INBOX_DIR_NAME,
    file: ALERTS_FILE,
    version: ALERTS_FILE_VERSION,
    // An entry filed under another key is as unusable as a broken one.
    parse: (body) => ({ entries: keyedEntriesOf(alertEntrySchema, body["entries"], (key, entry) => alertKeyOf(entry.kind, entry.workspaceId, entry.subject) === key) }),
    empty: () => ({ entries: {} }),
    cap: ({ entries }) => ({ entries: capAlerts(entries) }),
    // The code this file has always had; a newer file's refusal gets it too (it used to be a plain Error).
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });

  const read = (): { entries: Record<string, AlertEntry> } => file.read();
  const write = (entries: Record<string, AlertEntry>): void => {
    file.write({ entries });
  };

  const view = (key: string, entry: AlertEntry): Alert => ({ key, ...entry });

  const matches = (alert: Alert, filter: AlertFilter): boolean =>
    (filter.open === undefined || (alert.clearedAt === null) === filter.open) &&
    (filter.workspaceId === undefined || alert.workspaceId === filter.workspaceId) &&
    (filter.kinds === undefined || filter.kinds.includes(alert.kind)) &&
    (filter.subject === undefined || alert.subject === filter.subject);

  return {
    path: file.path,

    raise(input) {
      const key = alertKeyOf(input.kind, input.workspaceId, input.subject);
      const detail = detailOf(input.detail);
      const { entries } = read();
      const existing = entries[key];
      if (existing !== undefined && existing.clearedAt === null) {
        if (detail === undefined || existing.detail === detail) return { raised: false, alert: view(key, existing) };
        const updated = alertEntrySchema.parse({ ...existing, detail });
        write({ ...entries, [key]: updated });
        return { raised: false, alert: view(key, updated) };
      }
      const entry = alertEntrySchema.parse({
        workspaceId: input.workspaceId,
        kind: input.kind,
        subject: input.subject,
        since: now().toISOString(),
        clearedAt: null,
        ...(detail === undefined ? {} : { detail }),
        ...(input.role === undefined ? {} : { role: input.role }),
      });
      write({ ...entries, [key]: entry });
      return { raised: true, alert: view(key, entry) };
    },

    clear(key) {
      const { entries } = read();
      const existing = entries[key];
      if (existing === undefined || existing.clearedAt !== null) return false;
      write({ ...entries, [key]: { ...existing, clearedAt: now().toISOString() } });
      return true;
    },

    clearWhere(match) {
      const { entries } = read();
      const at = now().toISOString();
      const cleared: string[] = [];
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.clearedAt !== null || !match(view(key, entry))) continue;
        entries[key] = { ...entry, clearedAt: at };
        cleared.push(key);
      }
      if (cleared.length > 0) write(entries);
      return cleared;
    },

    get(key) {
      const entry = read().entries[key];
      return entry === undefined ? null : view(key, entry);
    },

    isOpen(key) {
      return read().entries[key]?.clearedAt === null;
    },

    list(filter = {}) {
      return Object.entries(read().entries)
        .map(([key, entry]) => view(key, entry))
        .filter((alert) => matches(alert, filter))
        .sort((a, b) => timeOrZero(a.since) - timeOrZero(b.since));
    },
  };
}

/**
 * Raises one alert in the plugin's data folder (a producer with no store of its
 * own: the role pairing check). Throws when there is no usable data folder.
 */
export function raiseInboxAlert(input: AlertInput, deps: AlertStoreDeps & DataHomeDeps = {}): RaiseAlertResult {
  const home = resolveDataHome(deps).home;
  if (home === null) throw new Error("paseo-bm has no usable data folder for its Inbox alerts");
  return createAlertStore(home, deps).raise(input);
}
