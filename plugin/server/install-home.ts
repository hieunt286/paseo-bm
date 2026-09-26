/**
 * Recognising an install the retired installer CLI laid out (design §7.13.6).
 *
 * This module used to be how the plugin found its data: it read the path Paseo
 * had registered (`<install home>/plugin/<version>`, two levels up) and trusted
 * a folder only when an `install.json` written by the installer confirmed it.
 * That is why an install straight from paseo.cafe had no history — there was no
 * such file. From 0.4.0 the plugin owns its folder and finds it itself
 * (`data-home.ts`), so all that is left here is the one question the Setup
 * screen still asks: **is this plugin running from a 0.3.x directory install?**
 *
 * The answer drives the banner that asks the user to run the migration once, so
 * it is read-only by construction and never throws: it reads `install.json` to
 * recognise the layout, and nothing else.
 *
 * SDK fact this relies on (checked against @getpaseo/protocol 0.8.0
 * `MutableDaemonConfigSchema`, not guessed): `config.plugins` is
 * `Record<string, { source: "directory"; path: string; enabled?: boolean }>`.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Plugin id the installer registered with Paseo (Technical Design §5.2 `paseo.pluginId`). */
export const PLUGIN_ID = "paseo-bm";

/**
 * Highest `install.json` schema version that means "not migrated yet".
 *
 * The migration stamps `2` (design §4.5), and a schema-2 record is exactly the
 * case where the banner must NOT appear: the work is done, and the command the
 * banner points at would refuse with exit 5. So `confirmInstallHome` answering
 * "no" for a newer record is the behaviour Setup wants, not a limitation.
 */
const UNMIGRATED_RECORD_SCHEMA_VERSION = 1;

/** The bits of `node:fs` this module needs, injectable so tests need no real home. */
export interface InstallHomeFs {
  readFileSync(path: string, encoding: "utf8"): string;
}

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
 * `schemaVersion` that means the old installer put this here and nothing has
 * migrated it yet.
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
  if (version > UNMIGRATED_RECORD_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `install.json at ${recordPath} has schemaVersion ${version}, so this install was already migrated`,
    };
  }
  return { ok: true };
}
