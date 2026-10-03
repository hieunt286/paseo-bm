/**
 * Safe files in the data folder: the one set of helpers the stores write
 * through (code review 2026-09-30 §3.1). The rules are the trace store's
 * (Dashboard design §3.8), keyed on the data folder itself — the folder
 * `resolveDataHome` returns — and with the error code a parameter, so a store
 * neither fakes a trace-store location nor borrows the trace store's code:
 *
 * - **No symlink** from the data folder down to the path, the folder itself
 *   included (`data-home.ts` `firstSymlinkBelow`, walked from the folder's
 *   parent). Checked before a read as well as before a write, so a link is
 *   refused rather than followed.
 * - **Folders `0700`**, created only by a write, with the check again after
 *   the `mkdir` (a component that appears in between is caught).
 * - **Files `0600`**, opened with `O_NOFOLLOW`. A rewrite is a temporary file in
 *   the same folder (`O_CREAT | O_EXCL | O_NOFOLLOW`), written, `fsync`ed and
 *   renamed over the file, so a crash leaves the old file or the new one.
 *
 * `createJsonFileStore` puts one versioned JSON file on top: read → version →
 * validate → create the folder → atomic write → cap, the steps eleven stores
 * used to copy (§3.1). Reads never repair a file, and a file written by a
 * newer paseo-bm is never written: it reads as empty and a write throws.
 *
 * Every function is synchronous: the plugin server is one thread, so a
 * read-modify-write of one file cannot interleave with another.
 */
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { DashboardError, type DashboardErrorCode } from "../shared/contracts";
import { ensureDataHome, firstSymlinkBelow } from "./data-home";

/** Mode of every folder the stores create (REQ-048c). */
export const DATA_DIR_MODE = 0o700;
/** Mode of every file the stores write (REQ-048c). */
export const DATA_FILE_MODE = 0o600;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function coded(code: DashboardErrorCode, detail: string, cause?: unknown): DashboardError {
  return new DashboardError(code, detail, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `path` is `root` or lies below it (lexical). */
function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// Paths, folders and files.
// ---------------------------------------------------------------------------

/**
 * Refuses a symlink anywhere from the data folder `home` (included) down to
 * `target`, without following one. Components that do not exist yet are fine:
 * nothing below them exists either. Throws `code`.
 */
export function assertNoSymlink(home: string, target: string, code: DashboardErrorCode): void {
  let found: string | null;
  try {
    found = firstSymlinkBelow(dirname(resolve(home)), target);
  } catch (error) {
    throw coded(code, messageOf(error), (error as Error).cause ?? error);
  }
  if (found !== null) throw coded(code, `refusing to use a symlinked path inside the data folder: ${found}`);
}

/**
 * Creates `directory` — the data folder or a folder inside it — with mode
 * 0700, checking for symlinks before and after. Nothing above the data folder
 * is judged: that is `ensureDataDir`'s first step. Throws `code`.
 */
export function makeDataDir(home: string, directory: string, code: DashboardErrorCode): void {
  assertNoSymlink(home, directory, code);
  try {
    mkdirSync(directory, { recursive: true, mode: DATA_DIR_MODE });
  } catch (error) {
    throw coded(code, `cannot create ${directory}`, error);
  }
  assertNoSymlink(home, directory, code);
}

/**
 * The folder a store's first write needs: the data folder as `ensureDataHome`
 * creates it (design §5.1: the walk starts at `$HOME` for a folder inside it),
 * then `directory` inside it (`makeDataDir`). Throws `code`.
 */
export function ensureDataDir(home: string, directory: string, code: DashboardErrorCode): void {
  try {
    ensureDataHome(home);
  } catch (error) {
    throw coded(code, messageOf(error), error);
  }
  makeDataDir(home, directory, code);
}

/** Opens a file for appending with `O_NOFOLLOW`, creating it 0600. Throws `code`. */
export function openForAppend(path: string, code: DashboardErrorCode): number {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW;
  try {
    return openSync(path, flags, DATA_FILE_MODE);
  } catch (error) {
    throw coded(code, `cannot append to ${path}`, error);
  }
}

/**
 * Creates the temporary file of a rewrite, 0600. `O_EXCL` means an existing
 * file — including one an attacker just created — fails instead of being
 * reused. Throws `code`.
 */
export function createTempFile(path: string, code: DashboardErrorCode): number {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  try {
    return openSync(path, flags, DATA_FILE_MODE);
  } catch (error) {
    throw coded(code, `cannot create the temporary file ${path}`, error);
  }
}

/** Closes a descriptor without masking the error that made the caller close it. */
export function closeQuietly(fd: number | null): void {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
    // Nothing useful to do: the write already reported the real failure.
  }
}

/**
 * Appends `text` to a file whose folder exists, with one `write` and an
 * `fsync`: a reader that meets a half-written last line (a process killed
 * mid-write) skips exactly that line. Throws `code`.
 */
export function appendToFile(path: string, text: string, code: DashboardErrorCode): void {
  let fd: number | null = null;
  try {
    fd = openForAppend(path, code);
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    throw coded(code, `cannot append to ${path}`, error);
  } finally {
    closeQuietly(fd);
  }
}

/**
 * Replaces a file in the data folder `home`: a temporary file in the same
 * folder (so the rename stays on one filesystem), written, `fsync`ed, then
 * renamed over it. The folder must exist (`ensureDataDir`). A failure removes
 * the temporary file and leaves the file as it was. Throws `code`.
 */
export function writeFileAtomically(home: string, path: string, body: string, code: DashboardErrorCode): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  assertNoSymlink(home, tempPath, code);
  const removeTemp = (): void => {
    try {
      unlinkSync(tempPath);
    } catch {
      // Leaving a stray temp file behind beats masking the real failure.
    }
  };
  let fd: number | null = null;
  try {
    fd = createTempFile(tempPath, code);
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    // Only a file this call created is removed: a refused `O_EXCL` open was
    // someone else's file.
    if (fd !== null) {
      closeQuietly(fd);
      fd = null;
      removeTemp();
    }
    if (error instanceof DashboardError) throw error;
    throw coded(code, `cannot write ${tempPath}`, error);
  } finally {
    closeQuietly(fd);
  }
  try {
    renameSync(tempPath, path);
  } catch (error) {
    removeTemp();
    throw coded(code, `cannot replace ${path}`, error);
  }
}

// ---------------------------------------------------------------------------
// Entries and caps.
// ---------------------------------------------------------------------------

/** The entries of `raw` that `schema` accepts, in order: one that does not validate costs only itself. Not an array → none. */
export function entriesOf<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const valid = schema.safeParse(entry);
    return valid.success ? [valid.data] : [];
  });
}

/**
 * The entries of a keyed record that `schema` accepts — and `keep`, when given,
 * keeps — in order: one that does not validate costs only itself. Not a plain
 * object → none.
 */
export function keyedEntriesOf<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  keep?: (key: string, entry: T) => boolean,
): Record<string, T> {
  if (!isRecord(raw)) return {};
  const entries: Record<string, T> = {};
  for (const [key, entry] of Object.entries(raw)) {
    const valid = schema.safeParse(entry);
    if (valid.success && (keep === undefined || keep(key, valid.data))) entries[key] = valid.data;
  }
  return entries;
}

/**
 * At most `limit` of `entries`, in their order. The ones `rank` puts lowest go
 * first, and of two with the same rank the earlier one; without `rank` the
 * first ones go (a log that keeps its newest).
 */
export function capBy<T>(entries: readonly T[], limit: number, rank?: (entry: T) => number): T[] {
  if (entries.length <= limit) return entries.slice();
  const drop = new Set(
    entries
      .map((entry, index) => ({ index, rank: rank === undefined ? 0 : rank(entry) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, entries.length - Math.max(0, limit))
      .map(({ index }) => index),
  );
  return entries.filter((_, index) => !drop.has(index));
}

// ---------------------------------------------------------------------------
// One versioned JSON file.
// ---------------------------------------------------------------------------

/** Codes of a JSON file's failures. */
export interface JsonFileCodes {
  /** A symlink on the way, a folder or file that cannot be created or replaced — and an unusable file a `keepUnusable` store refuses. */
  unwritable: DashboardErrorCode;
  /** A write refused because a newer paseo-bm wrote the file; `unwritable` when absent. */
  tooNew?: DashboardErrorCode;
}

export interface JsonFileStoreOptions<T extends object> {
  /** The data folder (`resolveDataHome().home`). */
  home: string;
  /** The file's folder, relative to the data folder; `""` for the data folder itself. */
  dir: string;
  /** The file name: one plain path segment. */
  file: string;
  /** The version this build reads and writes. */
  version: number;
  /** The key that holds it; `version` when absent (`schemaVersion` in some files). */
  versionKey?: string;
  /**
   * The file's content, from its JSON object (its version already checked).
   * What it returns is what `write` writes, after the version key. It may
   * throw: the file is then unusable, and the error's message says why.
   */
  parse: (body: Record<string, unknown>) => T;
  /** What a missing, unusable or newer file reads as. */
  empty: () => T;
  /** Applied to every value written, e.g. with `capBy`. */
  cap?: (value: T) => T;
  codes: JsonFileCodes;
  /**
   * For user data: a file that exists but cannot be used (unreadable, not
   * JSON, another version, refused by `parse`) is never overwritten — every
   * write throws `codes.unwritable` until it is fixed or deleted. Otherwise it
   * reads as `empty()` and the next write replaces it.
   */
  keepUnusable?: boolean;
  /**
   * `read` keeps the parsed content while the file's identity (mtime, size,
   * inode) does not change, so a file read at every turn end is parsed once
   * per change; a write through the store drops it. The value is shared:
   * callers never mutate what `read` returns.
   */
  cached?: boolean;
}

/** What a read found: the content, and why a file that exists was not used. */
export type JsonFileRead<T> =
  | { state: "missing" | "ok"; value: T; problem: null }
  | { state: "unusable" | "too-new"; value: T; problem: string };

export interface JsonFileStore<T extends object> {
  /** The file's absolute path. */
  readonly path: string;
  /** The content and what was found. Creates nothing; throws `codes.unwritable` on a symlink below the data folder. */
  inspect(): JsonFileRead<T>;
  /** The content: `empty()` for a missing, unusable or newer file. */
  read(): T;
  /** The content for a read-modify-write: throws, writing nothing, on a newer file (and, with `keepUnusable`, an unusable one). */
  readForWrite(): T;
  /** Writes `value`, capped, after the checks of `readForWrite`, creating the folders; returns what was written. */
  write(value: T): T;
  /** `readForWrite`, `change`, then `write` what it returns; null from `change` writes nothing and returns null. */
  update(change: (current: T) => T): T;
  update(change: (current: T) => T | null): T | null;
}

/** Parsed files of the `cached` stores, by path. */
const readCache = new Map<string, { key: string; value: unknown }>();

/** The identity of the file at `path` (mtime, size, inode), or null when it cannot be read. */
function fileKeyOf(path: string): string | null {
  try {
    const stat = lstatSync(path);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch {
    return null;
  }
}

/** Drops every `cached` store's parsed files; tests only. */
export function clearJsonFileCache(): void {
  readCache.clear();
}

/**
 * One versioned JSON file in the data folder (code review 2026-09-30 §3.1).
 * Creating the store touches nothing on disk; it throws `codes.unwritable`
 * when `dir` leaves the data folder or `file` is not a plain name.
 *
 * The file is `{ <versionKey>: <version>, ...value }`, pretty-printed with two
 * spaces and a trailing newline, the way every store has written its files.
 */
export function createJsonFileStore<T extends object>(options: JsonFileStoreOptions<T>): JsonFileStore<T> {
  const { home, version, codes, empty } = options;
  const versionKey = options.versionKey ?? "version";
  const dir = resolve(home, options.dir);
  const path = join(dir, options.file);
  const plainName = options.file !== "" && options.file !== "." && options.file !== ".." && basename(options.file) === options.file && !options.file.includes("\\");
  if (!plainName || !isInside(home, dir)) {
    throw coded(codes.unwritable, `not a file inside the data folder: ${JSON.stringify(join(options.dir, options.file))}`);
  }

  const inspect = (): JsonFileRead<T> => {
    // Before the read, so a symlinked path is refused rather than followed.
    assertNoSymlink(home, path, codes.unwritable);
    const unusable = (problem: string): JsonFileRead<T> => ({ state: "unusable", value: empty(), problem });
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", value: empty(), problem: null };
      return unusable(messageOf(error));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return unusable(`not JSON: ${messageOf(error)}`);
    }
    if (!isRecord(raw)) return unusable("not a JSON object");
    const found = raw[versionKey];
    if (typeof found === "number" && found > version) {
      return {
        state: "too-new",
        value: empty(),
        problem: `written by a newer paseo-bm (${versionKey} ${found}; this build understands ${version})`,
      };
    }
    if (found !== version) return unusable(`${versionKey}: expected ${version}, got ${JSON.stringify(found ?? null)}`);
    try {
      return { state: "ok", value: options.parse(raw), problem: null };
    } catch (error) {
      return unusable(messageOf(error));
    }
  };

  const readForWrite = (): T => {
    const found = inspect();
    if (found.state === "too-new") {
      throw coded(codes.tooNew ?? codes.unwritable, `${path} was written by a newer paseo-bm; it is left as it is`);
    }
    if (found.state === "unusable" && options.keepUnusable === true) {
      throw coded(codes.unwritable, `${path} is not usable (${found.problem}); it is left as it is`);
    }
    return found.value;
  };

  const put = (value: T): T => {
    const capped = options.cap === undefined ? value : options.cap(value);
    // The version first, as every store has written it, and always this
    // build's: a value that carries the key (a body kept whole) cannot change it.
    const body: Record<string, unknown> = { [versionKey]: version, ...capped };
    body[versionKey] = version;
    ensureDataDir(home, dir, codes.unwritable);
    readCache.delete(path);
    writeFileAtomically(home, path, `${JSON.stringify(body, null, 2)}\n`, codes.unwritable);
    readCache.delete(path);
    return capped;
  };

  const read = (): T => {
    if (options.cached !== true) return inspect().value;
    const key = fileKeyOf(path);
    const kept = readCache.get(path);
    if (key !== null && kept !== undefined && kept.key === key) return kept.value as T;
    const value = inspect().value;
    if (key !== null) readCache.set(path, { key, value });
    return value;
  };

  function update(change: (current: T) => T): T;
  function update(change: (current: T) => T | null): T | null;
  function update(change: (current: T) => T | null): T | null {
    const next = change(readForWrite());
    return next === null ? null : put(next);
  }

  return {
    path,
    inspect,
    read,
    readForWrite,
    write(value) {
      readForWrite();
      return put(value);
    },
    update,
  };
}
