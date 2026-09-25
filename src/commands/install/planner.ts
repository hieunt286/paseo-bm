/**
 * The install planner — Technical Design §2, §4.5, §5.3, §9.
 *
 * The architectural rule is "the planner does not write, the applier does not
 * decide". This module turns the current state of the machine — the install
 * record, the bytes on disk, the version of the package that is running, and
 * what Paseo already has switched on — into the complete list of `Action`s an
 * install would perform. Nothing else. The preview is "run the planner and
 * print the result", and `--apply` hands the very same list to the applier, so
 * the two cannot drift apart (REQ-003, REQ-009).
 *
 * What it recognises:
 *
 * - **Four situations** (REQ-010(a)(b)): `fresh`, `upgrade`, `reinstall` (same
 *   version again — this is also the repair path) and `downgrade`. A downgrade
 *   sets `requiresConfirmation` so the command flow asks explicitly; the planner
 *   never asks anything itself.
 * - **Ownership of every destination**, through `inspectOwnership` and
 *   `defaultInstallAction` from `src/ownership.ts`. On an upgrade every payload
 *   destination lands in the new `plugin/<version>/` directory and is therefore
 *   `missing`; the three conflicting states only show up on a reinstall/repair,
 *   or for `install.json` itself.
 * - **The two switches of one trust boundary** (§6.1): `pluginsEnabled` and
 *   `daemon.mcp.injectIntoAgents`. They are planned as `config` actions only;
 *   consent and the write belong to the command flow and the applier.
 * - **Plugin registration** with the daemon, when the caller says what Paseo
 *   currently has registered.
 *
 * `install.json` cannot list itself in `files[]`, so it needs a baseline passed
 * in explicitly (`OwnershipTarget.recorded`). See {@link recordBaseline}.
 */

import { posix, resolve } from "node:path";
import type { Action, ActionSummary, ConfigAction, FileAction } from "../../action.js";
import { isWritingAction, summarizeActions } from "../../action.js";
import { FILE_MODE, sha256 } from "../../fsops.js";
import { installPaths } from "../../layout.js";
import type { DiskReader, Ownership, OwnershipSummary, OwnershipTarget } from "../../ownership.js";
import { defaultInstallAction, inspectOwnership, summarizeOwnership } from "../../ownership.js";
import { MCP_INJECT_PATH, PLUGINS_ENABLED_PATH } from "../../paseo/config.js";
import { compareVersions, parseVersion } from "../../preflight.js";
import type { FileRecord, InstallRecord } from "../../record.js";
import { serializeRecord } from "../../record.js";

/** The plugin id paseo-bm registers under (`plugin/paseo-plugin.json`). */
export const DEFAULT_PLUGIN_ID = "paseo-bm";

/** `install.json`, spelled relative to the install home like every `files[]` path. */
export const RECORD_RELATIVE_PATH = "install.json";

/** The four situations of REQ-010(a)(b). */
export const INSTALL_SITUATIONS = ["fresh", "upgrade", "reinstall", "downgrade"] as const;

export type InstallSituation = (typeof INSTALL_SITUATIONS)[number];

/**
 * Why the command flow must ask before applying, on top of the usual apply
 * confirmation. `unknown-version-order` covers two different versions that
 * cannot be ordered (unparseable, or prereleases of the same release): the
 * planner cannot prove it is not a downgrade, so it does not pretend.
 */
export type ConfirmationReason = "downgrade" | "unknown-version-order";

/** Reason carried by a planned switch edit that still needs consent. */
export const CONSENT_REQUIRED_REASON = "consent-required";

/** One file of the plugin payload, as the payload source describes it. */
export interface PayloadFile {
  /** Path relative to the payload root, e.g. `roles/worker.md`. */
  readonly path: string;
  /** Lowercase hex sha256 of the bytes that will be copied. */
  readonly sha256: string;
  /** Intended mode; defaults to `FILE_MODE` (0600). */
  readonly mode?: number;
}

/** Current values of the two switches in Paseo's `config.json`; `null` = key absent. */
export interface PaseoSwitchState {
  readonly pluginsEnabled: boolean | null;
  readonly injectIntoAgents: boolean | null;
  /**
   * Passed through to `ConfigAction.consent` when the command flow already
   * knows how consent is obtained. Omitted otherwise — the vocabulary is not
   * pinned by the design, so the planner does not invent one.
   */
  readonly consent?: string;
}

/** What the daemon currently has registered for our plugin id. */
export interface PluginRegistrationState {
  /** Defaults to {@link DEFAULT_PLUGIN_ID}. */
  readonly pluginId?: string;
  /** Absolute directory Paseo points at; `null` when not registered. */
  readonly dir: string | null;
}

export interface PlanInstallInput {
  readonly installHome: string;
  /** Version of the running package. */
  readonly version: string;
  readonly payload: readonly PayloadFile[];
  /** The loaded record; `undefined` when there is none. A damaged record stops the run before this point. */
  readonly record?: InstallRecord | undefined;
  /** Read-only disk access (`createDiskReader`). */
  readonly reader: DiskReader;
  /** Omit to leave the switches out of the plan. */
  readonly switches?: PaseoSwitchState | undefined;
  /** Omit to leave daemon registration out of the plan. */
  readonly registration?: PluginRegistrationState | undefined;
  /** `--force`: plan an overwrite of `user-modified` files. */
  readonly force?: boolean | undefined;
  /**
   * The caller knows the record will change for a reason the planner cannot
   * see (e.g. `--reconfigure` of roles), so `install.json` is planned as an
   * update even when nothing else writes.
   */
  readonly recordChanged?: boolean | undefined;
}

export interface SituationVerdict {
  readonly situation: InstallSituation;
  readonly installedVersion: string | null;
  readonly requiresConfirmation: boolean;
  readonly confirmationReason: ConfirmationReason | null;
}

export interface InstallPlan extends SituationVerdict {
  readonly version: string;
  /** `plugin/<version>`, relative to the install home. */
  readonly versionDir: string;
  /** Classification of every payload destination, in payload order. */
  readonly ownership: readonly Ownership[];
  /** Classification of `install.json`. */
  readonly recordOwnership: Ownership;
  /** Every action, in order: payload, `install.json`, Paseo config, daemon. */
  readonly actions: readonly Action[];
  readonly summary: ActionSummary;
  readonly ownershipSummary: OwnershipSummary;
  /** The `conflict` actions, i.e. what makes the run stop with exit code 5. */
  readonly conflicts: readonly Action[];
}

/**
 * Decides which of the four situations applies. Equal strings are a reinstall;
 * otherwise SemVer 2.0.0 precedence decides, prereleases included, so
 * `0.1.0-alpha.0` -> `0.1.0-alpha.1` is a plain upgrade. Only an order that
 * cannot be established (a string that is not SemVer, or two different
 * strings of equal precedence such as a build-metadata-only difference) is
 * treated as needing confirmation.
 */
export function classifySituation(installedVersion: string | null | undefined, version: string): SituationVerdict {
  if (installedVersion === null || installedVersion === undefined) {
    return { situation: "fresh", installedVersion: null, requiresConfirmation: false, confirmationReason: null };
  }
  if (installedVersion === version) {
    return { situation: "reinstall", installedVersion, requiresConfirmation: false, confirmationReason: null };
  }
  const installed = parseVersion(installedVersion);
  const running = parseVersion(version);
  const order = installed === null || running === null ? 0 : compareVersions(running, installed);
  if (order > 0) {
    return { situation: "upgrade", installedVersion, requiresConfirmation: false, confirmationReason: null };
  }
  if (order < 0) {
    return { situation: "downgrade", installedVersion, requiresConfirmation: true, confirmationReason: "downgrade" };
  }
  return {
    situation: "upgrade",
    installedVersion,
    requiresConfirmation: true,
    confirmationReason: "unknown-version-order",
  };
}

/** `plugin/<version>/<payload path>`, relative to the install home. */
export function payloadDestination(version: string, payloadPath: string): string {
  const normalized = posix.normalize(payloadPath.split("\\").join("/"));
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw new Error(`Payload path escapes the payload root: ${payloadPath}`);
  }
  return posix.join("plugin", version, normalized);
}

/**
 * The baseline `install.json` is compared against.
 *
 * The record cannot carry its own hash, so the baseline is the hash of the
 * record *re-serialized* with `serializeRecord` — the exact bytes paseo-bm would
 * have written for the content it just loaded. The consequences:
 *
 * - a record paseo-bm wrote classifies as `unchanged`, never as `conflict`;
 * - a record someone edited by hand (an extra key, a value serialization would
 *   not produce) classifies as `user-modified` and needs a decision;
 * - with no loaded record, anything at `install.json` is `conflict`.
 */
export function recordBaseline(record: InstallRecord): FileRecord {
  return { path: RECORD_RELATIVE_PATH, sha256: sha256(serializeRecord(record)), mode: FILE_MODE };
}

/** Builds the plan. Reads only; never writes, never prompts, never spawns. */
export async function planInstall(input: PlanInstallInput): Promise<InstallPlan> {
  const paths = installPaths(input.installHome);
  // Validates the version as a directory name inside `plugin/` before anything else.
  const versionDirAbsolute = paths.pluginVersionDir(input.version);
  const versionDir = posix.join("plugin", input.version);
  const verdict = classifySituation(input.record?.version, input.version);
  const force = input.force === true;

  const payloadTargets: OwnershipTarget[] = input.payload.map((file) => ({
    path: payloadDestination(input.version, file.path),
    expectedSha256: file.sha256,
    expectedMode: file.mode ?? FILE_MODE,
  }));
  const ownership = await inspectOwnership({
    installHome: paths.root,
    record: input.record,
    targets: payloadTargets,
    reader: input.reader,
  });
  const payloadActions = ownership.map((entry) => defaultInstallAction(entry, { force }));

  const configActions = input.switches === undefined ? [] : switchActions(input.switches);
  const daemonActions =
    input.registration === undefined ? [] : [registrationAction(input.registration, versionDirAbsolute)];

  const [recordOwnership] = await inspectOwnership({
    installHome: paths.root,
    record: undefined,
    targets: [
      {
        path: RECORD_RELATIVE_PATH,
        recorded: input.record === undefined ? undefined : recordBaseline(input.record),
      },
    ],
    reader: input.reader,
  });
  if (recordOwnership === undefined) {
    throw new Error("install.json was not classified");
  }

  // The record is rewritten only when there is something to record, which is
  // what keeps "the same version again produces zero writes" (Design §9) true.
  const recordNeedsUpdate =
    input.record === undefined ||
    input.record.version !== input.version ||
    input.recordChanged === true ||
    [...payloadActions, ...configActions, ...daemonActions].some(isWritingAction);
  const recordAction = planRecordAction(recordOwnership, recordNeedsUpdate, force);

  const actions: Action[] = [...payloadActions, recordAction, ...configActions, ...daemonActions];
  return {
    ...verdict,
    version: input.version,
    versionDir,
    ownership,
    recordOwnership,
    actions,
    summary: summarizeActions(actions),
    ownershipSummary: summarizeOwnership([...ownership, recordOwnership]),
    conflicts: actions.filter((action) => action.kind === "conflict"),
  };
}

function planRecordAction(ownership: Ownership, needsUpdate: boolean, force: boolean): FileAction {
  if (ownership.status !== "unchanged") {
    // missing -> create; conflict / user-modified -> conflict (or update with --force).
    return defaultInstallAction(ownership, { force });
  }
  const common = { target: ownership.target, location: ownership.location };
  return needsUpdate
    ? { ...common, kind: "update", reason: "outdated", detail: "the install record is rewritten to describe this run" }
    : { ...common, kind: "skip", reason: "unchanged" };
}

function switchActions(state: PaseoSwitchState): Action[] {
  return [
    switchAction(PLUGINS_ENABLED_PATH, state.pluginsEnabled, state.consent),
    switchAction(MCP_INJECT_PATH, state.injectIntoAgents, state.consent),
  ];
}

function switchAction(key: string, current: boolean | null, consent: string | undefined): Action {
  const target = `paseoHome/config.json#${key}`;
  if (current === true) {
    return { kind: "skip", target, location: "paseo-config", reason: "unchanged", detail: "already enabled" };
  }
  const action: ConfigAction = {
    kind: "config",
    target,
    location: "paseo-config",
    reason: CONSENT_REQUIRED_REASON,
    from: current,
    to: true,
    detail: "planned only; written after consent for the plugin trust boundary",
    ...(consent === undefined ? {} : { consent }),
  };
  return action;
}

function registrationAction(state: PluginRegistrationState, versionDirAbsolute: string): FileAction {
  const target = `paseoDaemon/plugins[${state.pluginId ?? DEFAULT_PLUGIN_ID}]`;
  if (state.dir === null) {
    return { kind: "create", target, location: "paseo-daemon", reason: "missing", detail: "not registered with the daemon yet" };
  }
  if (resolve(state.dir) !== versionDirAbsolute) {
    return { kind: "update", target, location: "paseo-daemon", reason: "outdated", detail: "registered for another payload directory" };
  }
  return { kind: "skip", target, location: "paseo-daemon", reason: "unchanged" };
}
