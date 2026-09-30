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
 * The file rules are the decision store's (`decision-store.ts`), on the same
 * `trace-store.ts` and `data-home.ts` helpers: the folder is created `0700`
 * only by a write, never by a read; the file is `0600` and replaced atomically;
 * a symlink anywhere below the data folder is refused. A missing or corrupt
 * file reads as empty; an entry that does not validate is skipped on its own
 * and dropped by the next write; a file whose `version` is newer than this
 * build reads as empty and is never written.
 *
 * Open alerts are never evicted; of the cleared ones the `ALERT_CLEARED_LIMIT`
 * newest (by `clearedAt`) are kept.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALERTS_FILE_VERSION,
  MAX_ALERT_DETAIL_CHARS,
  alertEntrySchema,
  alertKeyOf,
  alertsFileSchema,
  type Alert,
  type AlertEntry,
  type AlertKind,
  type AlertRole,
} from "../shared/alerts";
import { TRACES_DIR_NAME, ensureDataHome, resolveDataHome, type DataHomeDeps } from "./data-home";
import { assertNoSymlinkOnPath, ensureStoreDir, writeStoreFileAtomically, type TraceStoreLocation } from "./trace-store";

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

/** `<home>/inbox`. */
export function inboxDirOf(home: string): string {
  return join(home, INBOX_DIR_NAME);
}

function timeOf(iso: string | null): number {
  if (iso === null) return 0;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

function detailOf(detail: string | null | undefined): string | undefined {
  if (typeof detail !== "string") return undefined;
  const line = detail.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  const chars = [...line];
  return chars.length <= MAX_ALERT_DETAIL_CHARS ? line : `${chars.slice(0, MAX_ALERT_DETAIL_CHARS - 1).join("")}…`;
}

/** Keeps every open alert and the `ALERT_CLEARED_LIMIT` newest cleared ones. */
export function capAlerts(entries: Record<string, AlertEntry>): Record<string, AlertEntry> {
  const cleared = Object.entries(entries).filter(([, entry]) => entry.clearedAt !== null);
  if (cleared.length <= ALERT_CLEARED_LIMIT) return entries;
  const evict = new Set(
    cleared
      .sort((a, b) => timeOf(a[1].clearedAt) - timeOf(b[1].clearedAt))
      .slice(0, cleared.length - ALERT_CLEARED_LIMIT)
      .map(([key]) => key),
  );
  return Object.fromEntries(Object.entries(entries).filter(([key]) => !evict.has(key)));
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createAlertStore(home: string, deps: AlertStoreDeps = {}): AlertStore {
  const now = deps.now ?? (() => new Date());
  const dir = inboxDirOf(home);
  const path = join(dir, ALERTS_FILE);
  // `trace-store.ts` roots its symlink checks at the parent of `tracesDir`, which is the data folder.
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };

  const read = (): { entries: Record<string, AlertEntry>; tooNew: boolean } => {
    assertNoSymlinkOnPath(home, path);
    let raw: unknown = null;
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      raw = null;
    }
    const frame = alertsFileSchema.safeParse(raw);
    if (!frame.success) return { entries: {}, tooNew: false };
    if (frame.data.version !== ALERTS_FILE_VERSION) return { entries: {}, tooNew: frame.data.version > ALERTS_FILE_VERSION };
    const entries: Record<string, AlertEntry> = {};
    for (const [key, entry] of Object.entries(frame.data.entries)) {
      const valid = alertEntrySchema.safeParse(entry);
      // An entry filed under another key is as unusable as a broken one.
      if (valid.success && alertKeyOf(valid.data.kind, valid.data.workspaceId, valid.data.subject) === key) entries[key] = valid.data;
    }
    return { entries, tooNew: false };
  };

  const write = (entries: Record<string, AlertEntry>): void => {
    if (read().tooNew) throw new Error(`${path} was written by a newer paseo-bm; it is left as it is`);
    ensureDataHome(home);
    ensureStoreDir(location.tracesDir, dir);
    writeStoreFileAtomically(location, path, `${JSON.stringify({ version: ALERTS_FILE_VERSION, entries: capAlerts(entries) }, null, 2)}\n`);
  };

  const view = (key: string, entry: AlertEntry): Alert => ({ key, ...entry });

  const matches = (alert: Alert, filter: AlertFilter): boolean =>
    (filter.open === undefined || (alert.clearedAt === null) === filter.open) &&
    (filter.workspaceId === undefined || alert.workspaceId === filter.workspaceId) &&
    (filter.kinds === undefined || filter.kinds.includes(alert.kind)) &&
    (filter.subject === undefined || alert.subject === filter.subject);

  return {
    path,

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
        .sort((a, b) => timeOf(a.since) - timeOf(b.since));
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
