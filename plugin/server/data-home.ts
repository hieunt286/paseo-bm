/**
 * Where the plugin keeps its own data, and how that folder gets created
 * (Technical Design §5.1, §5.2; ADR-012 decision 3).
 *
 * From 0.4.0 the plugin is the whole product, so it owns its data folder
 * instead of borrowing one the installer prepared. Two properties drive every
 * choice here:
 *
 * 1. **Synchronous and handle-free.** The agent-tools endpoint has to know
 *    where to record its port while the plugin is still loading, long before a
 *    `PaseoApi` handle exists, so resolution may not await anything and may not
 *    read the Paseo configuration. That rules out the old
 *    `install-home.ts` route (registered plugin path → two levels up), which
 *    also stops working the moment Paseo owns the package directory: the npm
 *    source lives under `~/.paseo/plugins/paseo-bm/<uuid>/…` and moves on every
 *    update, so it can never hold data.
 * 2. **Never split the data in two.** A candidate that fails a rule returns a
 *    reason; it never quietly falls back to `~/.paseo-bm`. Falling back would
 *    write half the traces in one folder and half in another, and the user
 *    would have no way to tell.
 *
 * `install.json` is deliberately not read: it was the old installer's
 * ownership record, and a paseo.cafe install has none, which is exactly the
 * case that used to leave the Dashboard empty.
 */
import { lstatSync, mkdirSync, readFileSync as nodeReadFileSync } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The trace store, inside the data folder (Dashboard design §3.2). */
export const TRACES_DIR_NAME = "traces";

/**
 * Small files of the plugin's own, inside the data folder: the answer marks,
 * the questions-and-answers ledger, the review-budget notices already sent, the
 * agent-tools port and the setup state.
 */
export const UI_DIR_NAME = "ui";

/** Environment variable that overrides the data folder (design §5.1 step 1). */
export const DATA_HOME_ENV_VAR = "PASEO_BM_HOME";

/** The default data folder, and the only place the pointer is looked for. */
export const DEFAULT_DATA_DIR_NAME = ".paseo-bm";

/** `~/.paseo-bm/home.json` — written by the 0.4.0 CLI, read-only here (§5.2). */
export const POINTER_FILE_NAME = "home.json";

/** Highest `home.json` schema version this build understands (§5.2). */
export const SUPPORTED_POINTER_SCHEMA_VERSION = 1;

/** Mode of the data folder: nobody but the user reads what is in it. */
export const DATA_HOME_MODE = 0o700;

/** How the data folder was found — what a "why is my history empty?" answer needs. */
export type DataHomeSource = "env" | "pointer" | "default";

/** Either the data folder, or the readable reason the stores stay off. */
export type DataHomeResolution =
  | { home: string; tracesDir: string; source: DataHomeSource }
  | { home: null; tracesDir: null; reason: string };

/**
 * Everything this module touches outside itself, injectable so a test runs
 * against a temporary HOME with no environment of its own.
 */
export interface DataHomeDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** `os.homedir()`. */
  homedir?: () => string;
  /** `fs.readFileSync`; only the pointer is ever read. */
  readFileSync?: (path: string, encoding: "utf8") => string;
}

/** Thrown by `ensureDataHome`; callers turn it into their own coded error. */
export class DataHomeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataHomeError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** True when `candidate` is `root` itself or lives underneath it (lexical). */
function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when `ancestor` strictly contains `descendant`. */
function contains(ancestor: string, descendant: string): boolean {
  return resolve(ancestor) !== resolve(descendant) && isWithin(ancestor, descendant);
}

function pickEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  return value.trim().length === 0 ? undefined : value;
}

/**
 * Directories a data folder may never touch, with the environment variable
 * that moves each one. Same list as the installer's `assertSafeInstallHome`
 * (`src/layout.ts`), copied rather than imported because the plugin bundle
 * never pulls in `src/`.
 */
const PROTECTED_DIRS: readonly (readonly [label: string, envVar: string | null, dirName: string])[] = [
  ["Paseo home", "PASEO_HOME", ".paseo"],
  ["Claude Code home", "CLAUDE_CONFIG_DIR", ".claude"],
  ["Codex home", "CODEX_HOME", ".codex"],
  ["shared agent home", null, ".agents"],
];

/**
 * The reason `target` is not usable as a data folder, or `null` when it is.
 *
 * Being *inside* `$HOME` is normal — that is where the default lives. Being
 * `$HOME`, containing it, or overlapping a folder that belongs to Paseo or to
 * an agent is not: everything under the data folder is ours to create and
 * later delete.
 */
export function unsafeDataHomeReason(
  target: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const resolvedTarget = resolve(target);
  const resolvedHome = resolve(homeDir);

  if (resolvedTarget === resolvedHome || contains(resolvedTarget, resolvedHome)) {
    return `refusing to use ${resolvedTarget} as the data folder: it is the home directory or contains it`;
  }

  for (const [label, envVar, dirName] of PROTECTED_DIRS) {
    const candidates = [resolve(resolvedHome, dirName)];
    const override = envVar === null ? undefined : pickEnv(env, envVar);
    if (override !== undefined && isAbsolute(override)) candidates.push(resolve(override));

    for (const dir of candidates) {
      if (resolvedTarget === dir || contains(resolvedTarget, dir) || contains(dir, resolvedTarget)) {
        return `refusing to use ${resolvedTarget} as the data folder: it overlaps the ${label} at ${dir}`;
      }
    }
  }

  return null;
}

/**
 * Reads `~/.paseo-bm/home.json`.
 *
 * Three outcomes, kept apart on purpose: the file is absent (no pointer, carry
 * on to the default), the file names a folder, or the file is unusable — and
 * an unusable pointer is a hard stop, because the folder it meant to name may
 * well be where the data already is.
 */
function readPointer(
  pointerPath: string,
  readFile: (path: string, encoding: "utf8") => string,
): { kind: "absent" } | { kind: "home"; home: string } | { kind: "error"; reason: string } {
  let raw: string;
  try {
    raw = readFile(pointerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", reason: `cannot read the data folder pointer ${pointerPath}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "error", reason: `the data folder pointer ${pointerPath} is not valid JSON` };
  }

  const record = asRecord(parsed);
  const schemaVersion = record?.["schemaVersion"];
  if (schemaVersion !== SUPPORTED_POINTER_SCHEMA_VERSION) {
    return {
      kind: "error",
      reason: `the data folder pointer ${pointerPath} has schemaVersion ${JSON.stringify(schemaVersion)}, not ${SUPPORTED_POINTER_SCHEMA_VERSION}`,
    };
  }

  const home = record?.["home"];
  if (typeof home !== "string" || home.trim().length === 0 || !isAbsolute(home)) {
    return {
      kind: "error",
      reason: `the data folder pointer ${pointerPath} has no absolute "home": ${JSON.stringify(home)}`,
    };
  }

  return { kind: "home", home };
}

/**
 * Finds the data folder in the three steps of design §5.1, and never throws.
 *
 * Nothing is created here and nothing is checked on disk beyond reading the
 * pointer: a folder that does not exist yet resolves normally and reads as
 * empty, and the first write calls `ensureDataHome`.
 */
export function resolveDataHome(deps: DataHomeDeps = {}): DataHomeResolution {
  const env = deps.env ?? process.env;
  const readFile = deps.readFileSync ?? nodeReadFileSync;
  const homeDir = resolve((deps.homedir ?? nodeHomedir)());
  const defaultHome = resolve(homeDir, DEFAULT_DATA_DIR_NAME);

  const unavailable = (reason: string): DataHomeResolution => ({ home: null, tracesDir: null, reason });
  const found = (home: string, source: DataHomeSource): DataHomeResolution => ({
    home,
    tracesDir: join(home, TRACES_DIR_NAME),
    source,
  });

  const fromEnv = pickEnv(env, DATA_HOME_ENV_VAR);
  if (fromEnv !== undefined) {
    if (!isAbsolute(fromEnv)) {
      return unavailable(`${DATA_HOME_ENV_VAR} must be an absolute path, got ${JSON.stringify(fromEnv)}`);
    }
    const target = resolve(fromEnv);
    const unsafe = unsafeDataHomeReason(target, homeDir, env);
    return unsafe === null ? found(target, "env") : unavailable(unsafe);
  }

  const pointer = readPointer(join(defaultHome, POINTER_FILE_NAME), readFile);
  if (pointer.kind === "error") return unavailable(pointer.reason);
  if (pointer.kind === "home") {
    const target = resolve(pointer.home);
    // A pointer that names the default is the same as having no pointer at
    // all; reporting `pointer` there would only puzzle whoever reads it.
    if (target !== defaultHome) {
      const unsafe = unsafeDataHomeReason(target, homeDir, env);
      return unsafe === null ? found(target, "pointer") : unavailable(unsafe);
    }
  }

  return found(defaultHome, "default");
}

/**
 * The one sentence every RPC and screen uses when the data folder is unusable.
 *
 * Resolution is synchronous and cheap, so the reason is worked out where the
 * error is thrown rather than threaded through a dozen lookups that only ever
 * needed the folder itself. When the folder does resolve, the caller got here
 * some other way — a lookup it gave up on — and says so instead of inventing a
 * cause.
 */
export function unusableDataHomeMessage(deps: DataHomeDeps = {}): string {
  let reason = "the lookup did not finish";
  try {
    const resolution = resolveDataHome(deps);
    if (resolution.home === null) reason = resolution.reason;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  return `paseo-bm cannot use its data folder (${reason})`;
}

/**
 * Refuses any symlink between `root` and `target`, without following one.
 *
 * Same shape as `trace-store.ts` `assertNoSymlinkOnPath`: a component that does
 * not exist yet ends the walk, because nothing below it exists either and there
 * is nothing to escape through.
 */
function assertNoSymlinkOnPath(root: string, target: string): void {
  const rootAbsolute = resolve(root);
  const targetAbsolute = resolve(target);

  /** What stands at `path`, without following a link. */
  const inspect = (path: string): "missing" | "symlink" | "plain" => {
    try {
      return lstatSync(path).isSymbolicLink() ? "symlink" : "plain";
    } catch (error) {
      // ENOENT: nothing below exists either. ENOTDIR: a regular file stands in
      // the path, so nothing below it can exist. Both end the walk with nothing
      // to escape through, and `mkdir` then reports the real problem.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return "missing";
      throw new DataHomeError(`cannot inspect ${path}`, { cause: error });
    }
  };

  // The root itself is only probed for existence, never judged: `$HOME` is a
  // symlink on plenty of machines (a home relocated to another mount), and
  // refusing it would leave the data folder — and with it the trace store, the
  // setup state and the cleanup mark — permanently uncreatable.
  if (inspect(rootAbsolute) === "missing") return;
  if (targetAbsolute === rootAbsolute) return;

  let current = rootAbsolute;
  for (const part of relative(rootAbsolute, targetAbsolute).split(sep)) {
    if (part === "" || part === ".") continue;
    current = join(current, part);
    const found = inspect(current);
    if (found === "missing") return;
    if (found === "symlink") {
      throw new DataHomeError(`refusing to use a symlinked path for the data folder: ${current}`);
    }
  }
}

/**
 * Creates the data folder with mode 0700, checking for symlinks before and
 * after. The second check closes the window where a component appears between
 * the check and the `mkdir`.
 *
 * Called by the first write that needs the folder, never by a read.
 *
 * The walk starts at `$HOME` for a folder inside it — the default and almost
 * every real install — and at the folder's own parent otherwise. Judging the
 * components above an explicit `PASEO_BM_HOME` is not this module's business
 * and would be wrong anyway: `/var` and `/tmp` are symlinks on macOS, so
 * walking from the filesystem root would refuse a perfectly ordinary
 * `PASEO_BM_HOME=/var/data/bm`. What must never be a symlink is the region we
 * create and later write into, and that is what is checked.
 */
export function ensureDataHome(home: string, deps: DataHomeDeps = {}): string {
  if (!isAbsolute(home)) {
    throw new DataHomeError(`the data folder must be an absolute path, got ${JSON.stringify(home)}`);
  }
  const target = resolve(home);
  const homeDir = resolve((deps.homedir ?? nodeHomedir)());
  const root = isWithin(homeDir, target) ? homeDir : dirname(target);

  assertNoSymlinkOnPath(root, target);
  try {
    mkdirSync(target, { recursive: true, mode: DATA_HOME_MODE });
  } catch (error) {
    throw new DataHomeError(`cannot create the data folder ${target}`, { cause: error });
  }
  assertNoSymlinkOnPath(root, target);
  return target;
}
