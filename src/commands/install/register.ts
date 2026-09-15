/**
 * Plugin registration — turn the payload the applier placed on disk into a
 * plugin the Paseo daemon knows about (REQ-005(a)(c), Design §9.1, §9.3,
 * ADR-001 decision 3, ADR-004 decision 3).
 *
 * The only mechanism used is Paseo's own:
 *
 *     paseo plugin install <install home>/plugin/<version> --id paseo-bm --json
 *
 * The `plugins` key in `config.json` is Paseo's; nothing here reads or writes
 * it. The call goes through the adapter's `run`, so it inherits argv-only
 * spawning and the 15-second deadline, and its JSON is read with the adapter's
 * own defensive parser.
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
 * - `paseo plugin install` exits non-zero → {@link PluginRegistrationError}
 *   `install-failed`. The payload is kept, the record is not touched, and the
 *   message names `paseo plugin logs paseo-bm` (Design §9.3).
 * - Exit zero but a status that is neither `running` nor `disabled` →
 *   `load-failed`. Paseo did register the source, so the record states that
 *   truthfully (uninstall must be able to remove it) before the error is raised.
 * - The CLI is missing, timed out, printed no JSON, or answered with the wrong
 *   shape or another plugin id → the adapter's {@link PaseoCliError} is raised
 *   unchanged, with its registry code.
 *
 * {@link PluginRegistrationError} deliberately carries **no** diagnostic code
 * and **no** exit code: Design §4.4 has no code for "the plugin failed to
 * install or load", and §4.3 has no row for it. Choosing either is an owner
 * decision, not something to borrow from a code with another meaning.
 *
 * ## Path spelling
 *
 * The directory handed to Paseo is derived from `record.installHome` and the
 * recorded `versions[].dir` with `path.resolve` only — the same spelling the
 * planner compares a registration against (`installPaths(...).pluginVersionDir`).
 * Canonicalising here (e.g. `realpath`) would make the next plan report a
 * spurious update, so the caller must hand the planner, the applier and this
 * step the install home spelled the same way.
 */

import type { FsOps, WriteOutcome } from "../../fsops.js";
import type { PaseoAdapter, PluginSummary } from "../../paseo/adapter.js";
import {
  PLUGIN_STATUS_DISABLED,
  PLUGIN_STATUS_RUNNING,
  PaseoCliError,
  isPaseoCliError,
  isPluginRunning,
  parseJsonOutput,
  parsePluginSummary,
} from "../../paseo/adapter.js";
import type { InstallRecord, VersionRecord } from "../../record.js";
import { resolveRecordedPath, toIsoUtc, writeRecord } from "../../record.js";
import { DEFAULT_PLUGIN_ID } from "./planner.js";

/** Why registration did not end with a usable plugin. */
export type PluginRegistrationFailure = "version-not-recorded" | "install-failed" | "load-failed";

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
  /** The record as it is on disk after the failure. */
  readonly record: InstallRecord;

  constructor(details: {
    reason: PluginRegistrationFailure;
    message: string;
    pluginId: string;
    pluginDir?: string | undefined;
    status?: string | undefined;
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
}

/** Registers the recorded payload version with Paseo and records the result. */
export async function registerPlugin(input: RegisterPluginInput): Promise<RegisterPluginResult> {
  const pluginId = input.pluginId ?? DEFAULT_PLUGIN_ID;
  const { record } = input;

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

  let plugin: PluginSummary;
  try {
    const invocation = await input.adapter.run(pluginInstallArgs(pluginDir, pluginId));
    plugin = parsePluginSummary(parseJsonOutput(invocation), invocation.argv);
  } catch (error) {
    if (isPaseoCliError(error) && error.reason === "exit-code") {
      throw new PluginRegistrationError({
        reason: "install-failed",
        message:
          `Paseo could not install the ${pluginId} plugin from ${pluginDir}. ` +
          "The payload was kept and Paseo's config.json was not changed. " +
          `See why with: ${pluginLogsCommand(pluginId)}`,
        pluginId,
        pluginDir,
        record,
        cause: error,
      });
    }
    throw error;
  }

  if (plugin.id !== pluginId) {
    throw new PaseoCliError({
      reason: "unexpected-shape",
      message: `\`paseo ${pluginInstallArgs(pluginDir, pluginId).join(" ")}\` reported plugin \`${plugin.id}\` instead of \`${pluginId}\`.`,
      argv: pluginInstallArgs(pluginDir, pluginId),
    });
  }

  // Paseo registered the source in both remaining cases, so the record says so.
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

  return { plugin, pluginDir, running: isPluginRunning(plugin), record: next, recordOutcome };
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
