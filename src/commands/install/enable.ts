/**
 * The trust-boundary step of `paseo-bm install` (bead bm-wp-107-2r5.2;
 * REQ-006(a)(b)(d)(e), REQ-031(c), REQ-005(b), M-7; Technical Design §3.2,
 * §3.4, §4.2, §7, §8, §9.1, §9.3; ADR-006 decisions 3, 4 and 8).
 *
 * One consent covers two switches in Paseo's `config.json`:
 *
 * - `pluginsEnabled` — plugins run without a sandbox;
 * - `daemon.mcp.injectIntoAgents` — grants Paseo's tools to **every** agent on
 *   the machine, so any agent can create, prompt and stop other agents.
 *
 * Enabling the plugin without the tools is useless (Manager could not create a
 * Worker), so the owner decided on one question for both (ADR-006 decision 4).
 *
 * Rules:
 *
 * - Both switches already on → nothing is asked and nothing is written.
 * - Consent is `--enable-plugins`, or a "yes" to exactly one question on a
 *   terminal. `--yes` never counts. Without a terminal and without the flag
 *   the step declines, and the command ends installed with exit 4.
 * - Before `config.json` is touched, the record states the per-key previous
 *   state and that paseo-bm is about to set the switches; it is corrected from
 *   what actually changed afterwards, and put back when the change did not
 *   stick. `setByUs` is true only for a switch paseo-bm itself turned on.
 * - The write goes through `applyConfigEdit` (backup, minimal edit, reload,
 *   `appliedPaths` check, rollback on a failed reload). There is no restart.
 * - After the reload, `plugin ls` is polled until the plugin's `status` is
 *   `running` — never `enabled` — for 30 seconds at 500 ms intervals (§8).
 *   A plugin that does not get there is `E_PLUGIN_LOAD_FAILED` (exit 7); the
 *   switches are left on (§9.3).
 */

import type { ErrorCode } from "../../errors.js";
import type { ExitCode } from "../../exit-codes.js";
import { EXIT_CODES } from "../../exit-codes.js";
import { backupStamp } from "../../fsops.js";
import { installPaths, paseoConfigFile } from "../../layout.js";
import type { ApplyConfigEditResult, ConfigEdit } from "../../paseo/config.js";
import {
  MCP_INJECT_PATH,
  PLUGINS_ENABLED_PATH,
  applyConfigEdit,
  editConfig,
  isConfigMutationError,
  readConfigSnapshot,
  readMcpInject,
  readPluginsEnabled,
} from "../../paseo/config.js";
import type { InstallRecord } from "../../record.js";
import { toIsoUtc, withCreatedConfigContainers, writeRecord } from "../../record.js";
import type { InstallStepInput, TrustBoundaryOutcome, TrustBoundaryStep } from "./index.js";
import { DEFAULT_PLUGIN_ID } from "./planner.js";
import { PLUGIN_RUNNING_TIMEOUT_MS, pluginLogsCommand, waitForPluginRunning } from "./register.js";

// Design §8 wait values; they live with the shared poll in ./register.js (bm-i52).
export { PLUGIN_POLL_INTERVAL_MS, PLUGIN_RUNNING_TIMEOUT_MS } from "./register.js";

/** The single question for both switches. */
export const TRUST_QUESTION = "Enable Paseo plugins and grant Paseo tools to agents?";

/** Both consequences, stated in full every time consent is asked for or assumed. */
export const TRUST_WARNING: readonly string[] = [
  "This is one consent for two switches in Paseo's config.json:",
  "  1. pluginsEnabled: Paseo plugins run without a sandbox. The paseo-bm plugin runs with the same access to this machine as the Paseo daemon.",
  "  2. daemon.mcp.injectIntoAgents: Paseo's tools are granted to EVERY agent on this machine, not only paseo-bm's roles. Any agent can then create, prompt and stop other agents.",
];

/** How to give the consent later. */
export const ENABLE_LATER_COMMAND = "npx paseo-bm install --apply --enable-plugins";

/** Reason recorded in `backups[]` for the copy of Paseo's config taken here. */
export const CONFIG_BACKUP_REASON = "paseo-config";

/** The one edit this step makes: both switches on. */
const TRUST_EDIT: ConfigEdit = { pluginsEnabled: true, mcpInject: { action: "set", value: true } };

/** A failure the install command turns into `result.error` and an exit code. */
export interface TrustBoundaryFailure {
  readonly exitCode: ExitCode;
  readonly code: ErrorCode;
  readonly detail: string;
}

export interface TrustBoundaryDeps {
  /** Milliseconds on a monotonic-enough clock. Tests inject a fake one. */
  readonly clock?: () => number;
  /** Waits; tests inject one that only advances the fake clock. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the step; `enableTrustBoundary` is the one the install command uses. */
export function createTrustBoundaryStep(deps: TrustBoundaryDeps = {}): TrustBoundaryStep {
  const clock = deps.clock ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  return (input) => runTrustBoundary(input, clock, sleep);
}

export const enableTrustBoundary: TrustBoundaryStep = createTrustBoundaryStep();

async function runTrustBoundary(
  input: InstallStepInput,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<TrustBoundaryOutcome> {
  const { context, record } = input;
  const configFile = paseoConfigFile(input.paseoHome);

  // Re-read right before deciding: the preview's reading may be minutes old.
  let pluginsOn = input.switches.pluginsEnabled === true;
  let mcpOn = input.switches.injectIntoAgents === true;
  try {
    const snapshot = await readConfigSnapshot(configFile, input.fs);
    pluginsOn = readPluginsEnabled(snapshot.config).value === true;
    mcpOn = readMcpInject(snapshot.config).value === true;
  } catch {
    // Unreadable → keep what was read before; applyConfigEdit reports it properly.
  }

  const declined = (extra: readonly string[] = []): TrustBoundaryOutcome => ({
    consented: false,
    record,
    pluginState: null,
    pluginsEnabled: pluginsOn,
    warnings: [],
    backupDirs: [],
    notes: [
      ...extra,
      "The paseo-bm plugin is installed but will not run: plugins are not enabled, or Paseo tools are not granted to agents.",
      `Enabling both is one consent: run \`${ENABLE_LATER_COMMAND}\`.`,
    ],
  });

  /* -- 1. both on already: ask nothing, write nothing ---------------------- */
  if (pluginsOn && mcpOn) {
    return { consented: true, record, pluginState: null, pluginsEnabled: true, warnings: [], backupDirs: [], notes: [] };
  }

  /* -- 2. one consent: the flag, or exactly one question on a terminal ------ */
  let consent = context.flags.enablePlugins;
  const notes: string[] = [];
  if (consent) {
    notes.push("Consent given with --enable-plugins.", ...TRUST_WARNING);
  } else if (input.interactive) {
    consent = await context.prompter.confirm({ message: TRUST_QUESTION, defaultValue: false, details: TRUST_WARNING });
  }
  if (!consent) {
    return declined(input.interactive ? [] : [...TRUST_WARNING]);
  }

  /* -- 3. record the intent and the per-key previous state before touching -- */
  const now = input.now;
  const stamp = backupStamp(now);
  const backupDirAbs = installPaths(input.installHome).backupDir(stamp);
  const backupDirRel = `backups/${stamp}`;

  let intentRecord = record;
  try {
    const snapshot = await readConfigSnapshot(configFile, input.fs);
    // Containers too: `daemon` and `daemon.mcp` exist only because of this
    // write when they are absent now, and uninstall must know that (bm-tm2).
    intentRecord = withCreatedConfigContainers(
      withSwitchOwnership(record, {
        pluginsEnabledChanged: readPluginsEnabled(snapshot.config).value !== true,
        pluginsPrevious: readPluginsEnabled(snapshot.config),
        mcpChanged: readMcpInject(snapshot.config).value !== true,
        mcpPrevious: readMcpInject(snapshot.config),
        now,
      }),
      editConfig(snapshot.config, TRUST_EDIT).createdContainers,
      now,
    );
    if (intentRecord !== record) await writeRecord(input.fsops, intentRecord);
  } catch (error) {
    if (!isConfigMutationError(error)) throw error;
    // Missing or unreadable config: applyConfigEdit raises the same error below.
  }

  /* -- 4. backup → minimal edit → reload → verify (rollback inside) --------- */
  let result: ApplyConfigEditResult;
  try {
    result = await applyConfigEdit({
      paseoHome: input.paseoHome,
      installHome: input.installHome,
      edit: TRUST_EDIT,
      adapter: input.adapter,
      fs: input.fs,
      backupDir: backupDirAbs,
      now,
    });
  } catch (error) {
    if (!isConfigMutationError(error)) throw error;
    // The switches are as they were: the record must not claim otherwise.
    const kept = withBackup(record, error.backupPath === undefined ? undefined : backupDirRel, now);
    if (kept !== intentRecord) await writeRecord(input.fsops, kept);
    const backupDirs = error.backupPath === undefined ? [] : [backupDirRel];
    const lines = [
      error.message,
      ...(error.restoredFromBackup ? [`Paseo's config.json was put back from ${backupDirRel}.`] : []),
    ];
    if (error.code !== undefined) {
      return {
        ...declined(),
        record: kept,
        backupDirs,
        failure: { exitCode: EXIT_CODES.consentMissing, code: error.code, detail: error.message },
      };
    }
    return { ...declined(lines), record: kept, backupDirs };
  }

  const finalRecord = withBackup(
    withCreatedConfigContainers(
      withSwitchOwnership(record, {
        pluginsEnabledChanged: result.changedPaths.includes(PLUGINS_ENABLED_PATH),
        pluginsPrevious: result.before.pluginsEnabled,
        mcpChanged: result.changedPaths.includes(MCP_INJECT_PATH),
        mcpPrevious: result.before.mcpInject,
        now,
      }),
      result.createdContainers,
      now,
    ),
    result.backupPath === undefined ? undefined : backupDirRel,
    now,
  );
  if (JSON.stringify(finalRecord) !== JSON.stringify(intentRecord)) {
    await writeRecord(input.fsops, finalRecord);
  }
  const backupDirs = result.backupPath === undefined ? [] : [backupDirRel];

  /* -- 5. poll `plugin ls` until status is running --------------------------- */
  const pluginId = record.paseo.pluginId ?? DEFAULT_PLUGIN_ID;
  const polled = await waitForPluginRunning(input.adapter, pluginId, clock, sleep);
  if (polled.running) {
    return { consented: true, record: finalRecord, pluginState: polled.status, pluginsEnabled: true, warnings: [], backupDirs, notes };
  }

  const seen = polled.status === null ? "it was not reported by `paseo plugin ls`" : `its last status was "${polled.status}"`;
  const detail =
    `Plugins are enabled and Paseo tools are granted, but the ${pluginId} plugin did not reach ` +
    `status "running" within ${String(PLUGIN_RUNNING_TIMEOUT_MS / 1000)} seconds; ${seen}. ` +
    `The switches were left on. See why with: ${pluginLogsCommand(pluginId)}`;
  return {
    consented: true,
    record: finalRecord,
    pluginState: polled.status,
    pluginsEnabled: true,
    warnings: [],
    backupDirs,
    notes,
    failure: { exitCode: EXIT_CODES.pluginLoadFailed, code: "E_PLUGIN_LOAD_FAILED", detail },
  };
}

/* ------------------------------------------------------------- helpers */

interface Ownership {
  readonly pluginsEnabledChanged: boolean;
  readonly pluginsPrevious: { readonly present: boolean; readonly value: boolean | null };
  readonly mcpChanged: boolean;
  readonly mcpPrevious: { readonly present: boolean; readonly value: boolean | null };
  readonly now: Date;
}

/**
 * `setByUs` only for a switch this run turns on, never cleared by a later run.
 * `previous` is the state before paseo-bm first set the switch: once paseo-bm
 * owns it, a later re-enable keeps the original state for uninstall.
 *
 * `pluginsEnabledPrevious` follows the same rule (bead bm-tm2). A record that
 * already owns the switch but predates the field gets none: the state from
 * before the first install is no longer observable, and guessing it is what
 * the bead forbids. A key holding a non-boolean is not recorded either — the
 * record has no faithful way to describe it.
 */
function withSwitchOwnership(record: InstallRecord, change: Ownership): InstallRecord {
  const paseo = record.paseo;
  const takesPlugins = change.pluginsEnabledChanged && !paseo.pluginsEnabledSetByUs;
  const pluginsEnabledSetByUs = paseo.pluginsEnabledSetByUs || change.pluginsEnabledChanged;
  const describable = !change.pluginsPrevious.present || change.pluginsPrevious.value !== null;
  const pluginsEnabledPrevious =
    takesPlugins && describable
      ? { present: change.pluginsPrevious.present, value: change.pluginsPrevious.value }
      : paseo.pluginsEnabledPrevious;
  const mcpInject =
    change.mcpChanged && !paseo.mcpInject.setByUs
      ? { setByUs: true, previous: { present: change.mcpPrevious.present, value: change.mcpPrevious.value } }
      : paseo.mcpInject;
  if (
    pluginsEnabledSetByUs === paseo.pluginsEnabledSetByUs &&
    pluginsEnabledPrevious === paseo.pluginsEnabledPrevious &&
    mcpInject === paseo.mcpInject
  ) {
    return record;
  }
  return {
    ...record,
    updatedAt: toIsoUtc(change.now),
    paseo: {
      ...paseo,
      pluginsEnabledSetByUs,
      ...(pluginsEnabledPrevious === undefined ? {} : { pluginsEnabledPrevious }),
      mcpInject,
    },
  };
}

/** Adds the config backup to `backups[]` so it can be listed, restored and kept by `--prune`. */
function withBackup(record: InstallRecord, dir: string | undefined, now: Date): InstallRecord {
  if (dir === undefined) return record;
  const existing = record.backups.find((entry) => entry.dir === dir);
  if (existing !== undefined) {
    if (existing.reason.split(",").includes(CONFIG_BACKUP_REASON)) return record;
    return {
      ...record,
      updatedAt: toIsoUtc(now),
      backups: record.backups.map((entry) =>
        entry === existing ? { ...entry, reason: `${entry.reason},${CONFIG_BACKUP_REASON}` } : entry,
      ),
    };
  }
  return {
    ...record,
    updatedAt: toIsoUtc(now),
    backups: [...record.backups, { at: toIsoUtc(now), dir, reason: CONFIG_BACKUP_REASON }],
  };
}
