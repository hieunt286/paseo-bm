/**
 * Where the trace store lives (WP-202, Dashboard Design §3.1).
 *
 * The server bundle cannot work this out by itself: Paseo 0.8 compiles
 * `index.server.ts` into a CommonJS bundle and forks a worker with no cwd, and
 * the module-URL global is empty there (errata bm-dnc), which is why the payload
 * guard in test/plugin-bundle-cjs.test.ts forbids naming it at all. The authority is therefore
 * the path Paseo itself recorded when the plugin was installed:
 * `config.plugins["paseo-bm"] = { source: "directory", path }`, where `path` is
 * `<install home>/plugin/<version>`. Two levels up is the install home, so a
 * user who installed with `--home` or `PASEO_BM_HOME` is handled with no extra
 * configuration.
 *
 * Read-only by construction: this module reads `install.json` to confirm it
 * found the right directory and never writes anything. When it cannot be sure,
 * it returns a reason instead of throwing — tracing then stays off and the rest
 * of the Dashboard (bead statistics) keeps working.
 *
 * SDK facts this relies on (checked against @getpaseo/protocol 0.8.0
 * `MutableDaemonConfigSchema`, not guessed):
 * - `config.plugins` is `Record<string, { source: "directory"; path: string; enabled?: boolean }>`.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Plugin id the installer registers with Paseo (Technical Design §5.2 `paseo.pluginId`). */
export const PLUGIN_ID = "paseo-bm";

/** Directory of the trace store inside the install home (design §3.2). */
export const TRACES_DIR_NAME = "traces";

/**
 * Directory inside the install home for UI state that is not trace data
 * (`answer-marks.json`). The pin order an earlier version kept here is no
 * longer read, and is left alone (delta 20260918f §4.5).
 */
export const UI_DIR_NAME = "ui";

/** Highest `install.json` schema version this code understands (Technical Design §5.2). */
export const SUPPORTED_RECORD_SCHEMA_VERSION = 1;

/** Minimal SDK view this module needs. `PaseoApi` is structurally assignable to it. */
export interface InstallHomePaseo {
  config: {
    get(): Promise<{
      config: {
        plugins?: Record<string, unknown>;
      };
    }>;
  };
}

/** The bits of `node:fs` this module needs, injectable so tests need no real home. */
export interface InstallHomeFs {
  readFileSync(path: string, encoding: "utf8"): string;
}

export interface ResolveInstallHomeDeps {
  paseo: InstallHomePaseo;
  fs: InstallHomeFs;
  /** `os.homedir()`; injected so the fallback is testable. */
  homedir: () => string;
}

/**
 * Either the install home, or the readable reason tracing is off.
 *
 * `source` records how it was found, which is what a support question ("why is
 * my history empty?") actually needs.
 */
export type InstallHomeResolution =
  | { home: string; tracesDir: string; source: "plugin-path" | "default-home" }
  | { home: null; tracesDir: null; reason: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `<install home>/plugin/<version>` → `<install home>`, or null when the shape is wrong. */
export function installHomeFromPluginPath(pluginPath: string): string | null {
  if (typeof pluginPath !== "string" || pluginPath.trim() === "" || !isAbsolute(pluginPath)) return null;
  const versionDir = resolve(pluginPath);
  const pluginDir = dirname(versionDir);
  const home = dirname(pluginDir);
  // Guard against a path so short that dirname() starts returning the same root.
  if (home === pluginDir || pluginDir === versionDir) return null;
  return home;
}

/**
 * True when `<home>/install.json` is readable, is JSON, and carries a
 * `schemaVersion` this build understands.
 *
 * A newer profile means a newer paseo-bm wrote it; this build must not assume
 * it understands that directory, so it reports "not confirmed" rather than
 * using it (same posture as `E_RECORD_SCHEMA_TOO_NEW` in the CLI).
 */
export function confirmInstallHome(
  home: string,
  fs: InstallHomeFs,
): { ok: true } | { ok: false; reason: string } {
  const recordPath = join(home, "install.json");
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, "utf8");
  } catch {
    return { ok: false, reason: `no readable install.json at ${recordPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `install.json at ${recordPath} is not valid JSON` };
  }
  const version = asRecord(parsed)?.["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: `install.json at ${recordPath} has no usable schemaVersion` };
  }
  if (version > SUPPORTED_RECORD_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `install.json at ${recordPath} has schemaVersion ${version}, newer than this plugin understands (${SUPPORTED_RECORD_SCHEMA_VERSION})`,
    };
  }
  return { ok: true };
}

/**
 * Resolves the install home in the three steps of design §3.1, and never throws.
 *
 * 1. the directory Paseo registered for this plugin, two levels up;
 * 2. confirmed by a readable `install.json`;
 * 3. otherwise `~/.paseo-bm`, confirmed the same way.
 *
 * Anything else returns `{ home: null, reason }` so the caller can disable
 * tracing with a message a person can act on.
 */
export async function resolveInstallHome(
  deps: ResolveInstallHomeDeps,
): Promise<InstallHomeResolution> {
  const disabled = (reason: string): InstallHomeResolution => ({ home: null, tracesDir: null, reason });

  let plugins: Record<string, unknown> | undefined;
  try {
    const { config } = await deps.paseo.config.get();
    plugins = asRecord(config?.plugins);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return disabled(`could not read the Paseo configuration: ${message}`);
  }

  const entry = asRecord(plugins?.[PLUGIN_ID]);
  const registeredPath = typeof entry?.["path"] === "string" ? (entry["path"] as string) : null;

  if (registeredPath !== null) {
    const home = installHomeFromPluginPath(registeredPath);
    if (home === null) {
      return disabled(`the registered plugin path is not a usable directory: ${registeredPath}`);
    }
    const confirmed = confirmInstallHome(home, deps.fs);
    if (confirmed.ok) {
      return { home, tracesDir: join(home, TRACES_DIR_NAME), source: "plugin-path" };
    }
    // Fall through to the default home: a directory plugin can be registered
    // from somewhere that is not an install home at all (a developer checkout),
    // and the default home may still hold a real installation.
    const fallback = join(deps.homedir(), ".paseo-bm");
    if (fallback !== home) {
      const fallbackConfirmed = confirmInstallHome(fallback, deps.fs);
      if (fallbackConfirmed.ok) {
        return { home: fallback, tracesDir: join(fallback, TRACES_DIR_NAME), source: "default-home" };
      }
      return disabled(`${confirmed.reason}; ${fallbackConfirmed.reason}`);
    }
    return disabled(confirmed.reason);
  }

  const fallback = join(deps.homedir(), ".paseo-bm");
  const fallbackConfirmed = confirmInstallHome(fallback, deps.fs);
  if (fallbackConfirmed.ok) {
    return { home: fallback, tracesDir: join(fallback, TRACES_DIR_NAME), source: "default-home" };
  }
  return disabled(
    `Paseo has no directory plugin registered as "${PLUGIN_ID}"; ${fallbackConfirmed.reason}`,
  );
}
