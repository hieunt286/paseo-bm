/**
 * Plugin registration — turn the payload the applier placed on disk into a
 * plugin the Paseo daemon knows about (REQ-005(a)(c), REQ-010, Design §9.1,
 * §9.3, ADR-001 decision 3, ADR-004 decision 3).
 *
 * The only mechanisms used are Paseo's own:
 *
 *     paseo plugin install <install home>/plugin/<version> --id paseo-bm --json
 *     paseo plugin remove paseo-bm --json
 *
 * The `plugins` key in `config.json` is Paseo's; nothing here reads or writes
 * it. Calls go through the adapter, so they inherit argv-only spawning and the
 * 15-second deadline, and JSON is read with the adapter's defensive parser.
 *
 * ## Updating a registration (bm-vey)
 *
 * Paseo 0.8 refuses `plugin install` for an id that is already configured
 * ("Plugin ID "paseo-bm" is already configured; choose another ID with --id")
 * and has no command that re-points a directory plugin. So, given what
 * `paseo plugin ls` reported before the run ({@link RegisterPluginInput.current}):
 *
 * - not configured → `install <new dir>`;
 * - configured from the new directory already → no Paseo call at all;
 * - configured from another directory → `remove paseo-bm`, then
 *   `install <new dir>`. When that install fails, the previous directory is
 *   registered again (`remove` first, because Paseo 0.8 keeps the entry of a
 *   directory it could not start, then `install <old dir>`), so the plugin runs
 *   as before. The error names Paseo's reason and what the fallback did.
 *
 * Between `remove` and `install` the plugin is briefly absent; the bead accepts
 * that. The daemon is never restarted or stopped.
 *
 * ## What "success" means here
 *
 * A zero exit with `status: "disabled"` is a success (verified on Paseo 0.8.0):
 * the plugin is registered and waits for the plugin switch, which WP-107 asks
 * consent for. `status: "running"` is a success too. `enabled` is never read —
 * it is true after every install, running or not.
 *
 * ## Failures
 *
 * - `install`/`remove` fails → {@link PluginRegistrationError} `install-failed`
 *   (`E_PLUGIN_LOAD_FAILED`, exit 7). The payload is kept; `paseo.pluginDir`
 *   and `versions[].active` are not changed, and the record's `version` is put
 *   back to {@link RegisterPluginInput.previousVersion} (the applier already
 *   wrote the new one). The message carries Paseo's own reason verbatim
 *   ({@link paseoFailureDetail}) and names `paseo plugin logs paseo-bm`.
 * - Exit zero but a status that is neither `running` nor `disabled` →
 *   `load-failed`. Paseo did register the source, so the record states that
 *   truthfully (uninstall must be able to remove it) before the error is raised.
 * - Exit zero with output that is not the expected JSON, or another plugin id →
 *   the adapter's {@link PaseoCliError} is raised unchanged, with its registry
 *   code (the record's `version` is still put back). No fallback runs then:
 *   Paseo answered success, so the new directory is most likely registered.
 *
 * ## Path spelling
 *
 * The directory handed to Paseo is derived from `record.installHome` and the
 * recorded `versions[].dir` with `path.resolve` only — the same spelling the
 * planner compares a registration against (`installPaths(...).pluginVersionDir`,
 * `resolve(state.dir) !== versionDirAbsolute`). The directory Paseo reports is
 * compared after `path.resolve` as well, never `realpath`: canonicalising here
 * would make this step and the planner disagree about "already registered".
 */

import { resolve } from "node:path";
import type { FsOps, WriteOutcome } from "../../fsops.js";
import type { PaseoAdapter, PluginSummary } from "../../paseo/adapter.js";
import {
  PLUGIN_STATUS_DISABLED,
  PLUGIN_STATUS_RUNNING,
  PaseoCliError,
  isPaseoCliError,
  isPluginRunning,
  paseoFailureDetail,
  parseJsonOutput,
  parsePluginSummary,
} from "../../paseo/adapter.js";
import type { InstallRecord, VersionRecord } from "../../record.js";
import { resolveRecordedPath, toIsoUtc, writeRecord } from "../../record.js";
import { DEFAULT_PLUGIN_ID } from "./planner.js";

/** Why registration did not end with a usable plugin. */
export type PluginRegistrationFailure = "version-not-recorded" | "install-failed" | "load-failed";

/**
 * What happened to the previous registration after a failed update:
 * `not-attempted` (nothing had been removed), `restored`, `failed` (restoring
 * it failed too), or `unavailable` (Paseo reported no directory to restore).
 */
export type PluginFallbackOutcome = "not-attempted" | "restored" | "failed" | "unavailable";

/** Statuses that mean the plugin is registered and healthy for this step. */
export const REGISTERED_PLUGIN_STATUSES: readonly string[] = [PLUGIN_STATUS_RUNNING, PLUGIN_STATUS_DISABLED];

/** The command a user runs to see why the plugin failed. */
export function pluginLogsCommand(pluginId: string = DEFAULT_PLUGIN_ID): string {
  return `paseo plugin logs ${pluginId}`;
}

/** argv for the registration call, without the executable. */
export function pluginInstallArgs(pluginDir: string, pluginId: string = DEFAULT_PLUGIN_ID): string[] {
  return ["plugin", "install", pluginDir, "--id", pluginId, "--json"];
}

export class PluginRegistrationError extends Error {
  readonly reason: PluginRegistrationFailure;
  readonly pluginId: string;
  readonly pluginDir: string | undefined;
  /** `paseo plugin logs <id>`; empty for `version-not-recorded`, where Paseo was never called. */
  readonly logsCommand: string;
  /**
   * Registry code for the failure: `E_PLUGIN_LOAD_FAILED` whenever Paseo was
   * asked and failed (the install command exits 7). Undefined for
   * `version-not-recorded`, a caller bug where Paseo was never called.
   */
  readonly code: "E_PLUGIN_LOAD_FAILED" | undefined;
  /** Status Paseo reported, for `load-failed`. */
  readonly status: string | undefined;
  /** Paseo's own reason for the failed call, verbatim, when it gave one. */
  readonly paseoDetail: string | undefined;
  /** What happened to the previous registration. */
  readonly fallback: PluginFallbackOutcome;
  /** The plugin as Paseo reported it after the previous directory was registered again. */
  readonly restoredPlugin: PluginSummary | undefined;
  /** Best knowledge of the plugin's status after the failure; `null` when unknown or absent. */
  readonly pluginState: string | null;
  /** The record as it is on disk after the failure. */
  readonly record: InstallRecord;

  constructor(details: {
    reason: PluginRegistrationFailure;
    message: string;
    pluginId: string;
    pluginDir?: string | undefined;
    status?: string | undefined;
    paseoDetail?: string | undefined;
    fallback?: PluginFallbackOutcome | undefined;
    restoredPlugin?: PluginSummary | undefined;
    pluginState?: string | null | undefined;
    record: InstallRecord;
    cause?: unknown;
  }) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "PluginRegistrationError";
    this.reason = details.reason;
    this.pluginId = details.pluginId;
    this.pluginDir = details.pluginDir;
    this.logsCommand = details.reason === "version-not-recorded" ? "" : pluginLogsCommand(details.pluginId);
    this.code = details.reason === "version-not-recorded" ? undefined : "E_PLUGIN_LOAD_FAILED";
    this.status = details.status;
    this.paseoDetail = details.paseoDetail;
    this.fallback = details.fallback ?? "not-attempted";
    this.restoredPlugin = details.restoredPlugin;
    this.pluginState = details.pluginState ?? details.status ?? null;
    this.record = details.record;
  }
}

export function isPluginRegistrationError(value: unknown): value is PluginRegistrationError {
  return value instanceof PluginRegistrationError;
}

export interface RegisterPluginInput {
  readonly adapter: PaseoAdapter;
  /** Bound to the install home; the record is written through it. */
  readonly fsops: FsOps;
  /** The record the applier returned; must list `version` in `versions[]`. */
  readonly record: InstallRecord;
  /** The payload version to register. */
  readonly version: string;
  /** Defaults to {@link DEFAULT_PLUGIN_ID}. */
  readonly pluginId?: string | undefined;
  /**
   * What `paseo plugin ls --json` reported for `pluginId` before this run:
   * `null` when it is not configured. Omitted means "not asked": the directory
   * is installed without looking for an existing registration.
   */
  readonly current?: PluginSummary | null | undefined;
  /**
   * The record's `version` before the applier ran. When the new version does
   * not get registered, `version` is written back to this value so the record
   * keeps naming the version Paseo still runs. Omitted: `version` is left as is.
   */
  readonly previousVersion?: string | undefined;
  readonly now?: Date | undefined;
}

export interface RegisterPluginResult {
  /** What Paseo reported. Decisions read `status`, never `enabled`. */
  readonly plugin: PluginSummary;
  /** Absolute directory handed to Paseo, as recorded in `paseo.pluginDir`. */
  readonly pluginDir: string;
  readonly running: boolean;
  readonly record: InstallRecord;
  readonly recordOutcome: WriteOutcome | "not-written";
  /** The directory the replaced registration used; `null` when nothing was replaced. */
  readonly replacedDir: string | null;
}

/** Registers the recorded payload version with Paseo and records the result. */
export async function registerPlugin(input: RegisterPluginInput): Promise<RegisterPluginResult> {
  const pluginId = input.pluginId ?? DEFAULT_PLUGIN_ID;
  const { record, adapter } = input;
  const logs = `See why with: ${pluginLogsCommand(pluginId)}`;

  const entry = record.versions.find((candidate) => candidate.version === input.version);
  if (entry === undefined) {
    throw new PluginRegistrationError({
      reason: "version-not-recorded",
      message:
        `Payload version ${input.version} is not in the install record, so it was not registered with Paseo. ` +
        "The payload must be applied before it is registered.",
      pluginId,
      record,
    });
  }
  const pluginDir = resolveRecordedPath(record.installHome, entry.dir);
  const current = input.current ?? null;
  const currentDir = current === null ? null : configuredDir(current, record, pluginId);

  // Already registered from this very directory: nothing to ask Paseo.
  if (current !== null && currentDir === pluginDir) {
    return await recordAndCheck(input, pluginId, pluginDir, current, null);
  }

  if (current !== null) {
    try {
      await adapter.pluginRemove(pluginId);
    } catch (error) {
      if (!isPaseoCliError(error)) throw error;
      const detail = detailOf(error);
      throw new PluginRegistrationError({
        reason: "install-failed",
        message:
          `Paseo could not remove the ${pluginId} plugin registered from ${currentDir ?? "a directory it did not report"}, ` +
          `so ${pluginDir} was not registered: ${sentence(detail)} ` +
          `The plugin was left as it was and the new payload was kept. ${logs}`,
        pluginId,
        pluginDir,
        paseoDetail: detail,
        pluginState: current.status,
        record: await restoreVersion(input),
        cause: error,
      });
    }
  }

  let plugin: PluginSummary;
  try {
    plugin = await installDirectory(adapter, pluginDir, pluginId);
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
    const kept = await restoreVersion(input);
    if (error.reason === "invalid-json" || error.reason === "unexpected-shape") {
      // Paseo answered success; its answer just is not usable. Not a failed install.
      throw error;
    }
    const detail = detailOf(error);
    const failed = `Paseo could not install the ${pluginId} plugin from ${pluginDir}: ${sentence(detail)}`;
    if (current === null) {
      throw new PluginRegistrationError({
        reason: "install-failed",
        message: `${failed} The payload was kept and paseo-bm did not change Paseo's config.json. ${logs}`,
        pluginId,
        pluginDir,
        paseoDetail: detail,
        pluginState: null,
        record: kept,
        cause: error,
      });
    }

    const keptVersion = kept.version;
    if (currentDir === null) {
      throw new PluginRegistrationError({
        reason: "install-failed",
        message:
          `${failed} The previous registration was removed, and Paseo had not reported its directory, so it could not ` +
          `be restored: the ${pluginId} plugin is not registered with Paseo now. install.json still names ` +
          `${keptVersion} as the installed version and the new payload was kept. ${logs}`,
        pluginId,
        pluginDir,
        paseoDetail: detail,
        fallback: "unavailable",
        pluginState: null,
        record: kept,
        cause: error,
      });
    }

    const restored = await restorePrevious(adapter, pluginId, currentDir);
    if (restored.ok) {
      throw new PluginRegistrationError({
        reason: "install-failed",
        message:
          `${failed} The previous registration from ${currentDir} was restored (status "${restored.plugin.status}"), ` +
          `install.json still names ${keptVersion} as the installed version, and the new payload was kept. ${logs}`,
        pluginId,
        pluginDir,
        paseoDetail: detail,
        fallback: "restored",
        restoredPlugin: restored.plugin,
        pluginState: restored.plugin.status,
        record: kept,
        cause: error,
      });
    }
    throw new PluginRegistrationError({
      reason: "install-failed",
      message:
        `${failed} Restoring the previous registration from ${currentDir} also failed: ${sentence(restored.detail)} ` +
        `The ${pluginId} plugin may not be registered with Paseo now; register it again with: ` +
        `paseo plugin install ${currentDir} --id ${pluginId}. install.json still names ${keptVersion} as the ` +
        `installed version and the new payload was kept. ${logs}`,
      pluginId,
      pluginDir,
      paseoDetail: detail,
      fallback: "failed",
      pluginState: null,
      record: kept,
      cause: error,
    });
  }

  return await recordAndCheck(input, pluginId, pluginDir, plugin, current === null ? null : currentDir);
}

/** `paseo plugin install <dir> --id <id> --json`, with the answer checked to be about `pluginId`. */
async function installDirectory(adapter: PaseoAdapter, pluginDir: string, pluginId: string): Promise<PluginSummary> {
  const invocation = await adapter.run(pluginInstallArgs(pluginDir, pluginId));
  const plugin = parsePluginSummary(parseJsonOutput(invocation), invocation.argv);
  if (plugin.id !== pluginId) {
    throw new PaseoCliError({
      reason: "unexpected-shape",
      message: `\`paseo ${pluginInstallArgs(pluginDir, pluginId).join(" ")}\` reported plugin \`${plugin.id}\` instead of \`${pluginId}\`.`,
      argv: pluginInstallArgs(pluginDir, pluginId),
    });
  }
  return plugin;
}

/**
 * Registers `previousDir` again after a failed update. Paseo 0.8 writes the
 * `plugins[id]` entry before starting the plugin and keeps it when the start
 * fails, so the id is removed first; a `remove` that fails because nothing is
 * configured is expected and ignored.
 */
async function restorePrevious(
  adapter: PaseoAdapter,
  pluginId: string,
  previousDir: string,
): Promise<{ ok: true; plugin: PluginSummary } | { ok: false; detail: string }> {
  try {
    await adapter.pluginRemove(pluginId);
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
  }
  try {
    return { ok: true, plugin: await installDirectory(adapter, previousDir, pluginId) };
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
    return { ok: false, detail: detailOf(error) };
  }
}

/** Writes the successful registration and checks the status Paseo reported. */
async function recordAndCheck(
  input: RegisterPluginInput,
  pluginId: string,
  pluginDir: string,
  plugin: PluginSummary,
  replacedDir: string | null,
): Promise<RegisterPluginResult> {
  const { record } = input;
  // Paseo has the source registered in both remaining cases, so the record says so.
  const next = recordRegistration(record, pluginId, pluginDir, input.version, input.now ?? new Date());
  const recordOutcome = next === record ? "not-written" : (await writeRecord(input.fsops, next)).outcome;

  if (!REGISTERED_PLUGIN_STATUSES.includes(plugin.status)) {
    throw new PluginRegistrationError({
      reason: "load-failed",
      message:
        `Paseo registered the ${pluginId} plugin from ${pluginDir} but reports status "${plugin.status}" instead of ` +
        `"${PLUGIN_STATUS_RUNNING}" or "${PLUGIN_STATUS_DISABLED}". See why with: ${pluginLogsCommand(pluginId)}`,
      pluginId,
      pluginDir,
      status: plugin.status,
      record: next,
    });
  }

  return { plugin, pluginDir, running: isPluginRunning(plugin), record: next, recordOutcome, replacedDir };
}

/**
 * The directory Paseo has `pluginId` registered from, spelled with
 * `path.resolve` like `pluginDir`: the path `plugin ls` reported, else the
 * record's `paseo.pluginDir` when the record names this plugin, else `null`.
 */
function configuredDir(current: PluginSummary, record: InstallRecord, pluginId: string): string | null {
  if (current.path !== undefined) return resolve(current.path);
  if (record.paseo.pluginId === pluginId && record.paseo.pluginDir !== null) return resolve(record.paseo.pluginDir);
  return null;
}

/** Puts the record's `version` back to the one Paseo still runs, when the applier changed it. */
async function restoreVersion(input: RegisterPluginInput): Promise<InstallRecord> {
  const { record, previousVersion } = input;
  if (previousVersion === undefined || previousVersion === record.version) return record;
  const next: InstallRecord = { ...record, version: previousVersion };
  await writeRecord(input.fsops, next);
  return next;
}

function detailOf(error: PaseoCliError): string {
  return paseoFailureDetail(error) ?? error.message;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * The record with `paseo.pluginId`/`pluginDir` set and exactly `version`
 * active. Returns the same object when nothing changes, so a re-run writes
 * nothing and `updatedAt` does not move.
 */
export function recordRegistration(
  record: InstallRecord,
  pluginId: string,
  pluginDir: string,
  version: string,
  now: Date,
): InstallRecord {
  const versions: VersionRecord[] = record.versions.map((entry) => {
    const active = entry.version === version;
    return entry.active === active ? entry : { ...entry, active };
  });
  const unchanged =
    record.paseo.pluginId === pluginId &&
    record.paseo.pluginDir === pluginDir &&
    versions.every((entry, index) => entry === record.versions[index]);
  if (unchanged) {
    return record;
  }
  return {
    ...record,
    updatedAt: toIsoUtc(now),
    paseo: { ...record.paseo, pluginId, pluginDir },
    versions,
  };
}
