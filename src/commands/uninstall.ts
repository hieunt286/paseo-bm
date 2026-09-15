/**
 * `paseo-bm uninstall` — remove exactly what paseo-bm owns (REQ-012, M-5,
 * Technical Design §3.2, §3.4, §4.2–§4.4, §9.4; ADR-002, ADR-004, ADR-006
 * decisions 7 and 8).
 *
 * The flow of §9.4, and who does what:
 *
 *   light preflight → read install.json → {@link planUninstall} (reads only)
 *   → preview → confirm → {@link applyUninstall} (decides nothing):
 *   `paseo plugin remove` → drop the `bm-*` providers and profiles → put
 *   `daemon.mcp.injectIntoAgents` back → restore backups when asked → delete
 *   the payload by `versions[]` → keep user-modified files → backups by choice
 *   → install.json → report.
 *
 * What stays behind, on purpose (the three branches the bead allows):
 *
 * 1. **A file the user edited.** Its bytes no longer match `files[]`, so it is
 *    kept and listed. `--force` deletes it, after copying it into a backup.
 * 2. **Backups, when the user keeps them.** Removing them cannot be undone, so
 *    they only go when the user answers yes at the prompt. A run without a
 *    terminal keeps them.
 * 3. **install.json, when the daemon is not running.** The files are removed,
 *    but the Paseo half (plugin, roles, the MCP switch) cannot be undone
 *    without the daemon, so the record keeps it for the next run (REQ-012(h)).
 *
 * Never touched: skills and the `skills` CLI, the agents that exist in Paseo
 * (they belong to the user), the `plugins: {}` key Paseo leaves behind, every
 * config entry without the `bm-` prefix, and anything on disk the record does
 * not list. The whole Paseo config file is never restored from a backup:
 * that would discard every change made since the install (ADR-006 decision 8).
 */

import { rmdir } from "node:fs/promises";
import { posix } from "node:path";

import type { Action, ConfigAction, FileAction, ActionSummary, PlanReport, ReportError, RoleReport } from "../action.js";
import { summarizeActions } from "../action.js";
import type { CommandContext, CommandHandler } from "../cli.js";
import type { ErrorCode } from "../errors.js";
import { diagnostic } from "../errors.js";
import type { ExitCode } from "../exit-codes.js";
import { EXIT_CODES, previewExitCode } from "../exit-codes.js";
import type { NodeFsApi } from "../fs-guard.js";
import { nodeFs } from "../fs-guard.js";
import type { FsOps } from "../fsops.js";
import { FILE_MODE, backupStamp, createFsOps } from "../fsops.js";
import type { Layout, ResolveLayoutInput } from "../layout.js";
import { paseoConfigFile, resolveLayout } from "../layout.js";
import { LockError, withLock } from "../lock.js";
import type { AcquireLockOptions } from "../lock.js";
import { installHomeLabel } from "../ownership.js";
import type { DaemonStatus, PaseoAdapter, PluginSummary } from "../paseo/adapter.js";
import { createPaseoAdapter, isPaseoCliError } from "../paseo/adapter.js";
import type { ConfigEdit, ConfigSnapshot, JsonValue } from "../paseo/config.js";
import {
  CONFIG_BACKUP_NAME,
  MCP_INJECT_PATH,
  PLUGINS_ENABLED_PATH,
  PROVIDERS_PATH,
  AGENT_PROFILES_PATH,
  applyConfigEdit,
  bmProfileIds,
  bmProviderIds,
  editConfig,
  isConfigMutationError,
  readBooleanKey,
  readConfigSnapshot,
} from "../paseo/config.js";
import { PathGuardError, pathGuardErrorCode } from "../paths-guard.js";
import { checkDaemon, checkNodeVersion, checkOperatingSystem } from "../preflight.js";
import type { Prompter } from "../prompter.js";
import type { BackupRecord, FileRecord, InstallRecord } from "../record.js";
import { isRecordError, readRecord, recordPath, toIsoUtc, writeRecord } from "../record.js";
import { writeHumanReport } from "../report/human.js";
import { writeJsonReport } from "../report/json.js";
import {
  entryType,
  isDirectChild,
  listUnrecorded,
  normalizeDir,
  removeEmptyDirs,
  removeFile,
  walk,
} from "./prune.js";

/* ------------------------------------------------------------------ model */

/** Relative path of the record inside the install home. */
const RECORD_FILE = "install.json";

/** Why something is removed, kept or edited. Free strings in the report; this is the closed set used here. */
export type UninstallReason =
  /** A recorded payload file whose bytes still match `files[]`. */
  | "unchanged"
  | "user-modified"
  /** Recorded, but already gone from disk; only the record entry goes. */
  | "missing"
  | "unrecorded"
  | "payload-version"
  | "unexpected-location"
  | "not-a-directory"
  | "symlink"
  | "not-a-regular-file"
  | "changed-since-preview"
  | "restored-from-backup"
  | "backup"
  | "kept-by-choice"
  | "config-backup-not-restored"
  | "record"
  | "registered"
  | "not-registered"
  /** A `bm-*` entry in Paseo's config. */
  | "owned-by-paseo-bm"
  | "restore-previous"
  | "changed-since-install"
  | "not-set-by-paseo-bm"
  | "set-by-paseo-bm"
  | "other-plugins-installed"
  | "paseo-unavailable";

/** Choices that change the plan. Flags give the first two; the prompt the other two. */
export interface UninstallChoices {
  /** `--force`: delete user-modified files too, after backing them up. */
  readonly force: boolean;
  /** `--restore-backups`: put backed-up payload files back before removing. */
  readonly restoreBackups: boolean;
  /** Answered at the prompt. Without a terminal backups are always kept. */
  readonly removeBackups: boolean;
  /** Answered at the prompt, and only offered when REQ-012(d) allows it. */
  readonly turnOffPlugins: boolean;
}

export const DEFAULT_UNINSTALL_CHOICES: UninstallChoices = {
  force: false,
  restoreBackups: false,
  removeBackups: false,
  turnOffPlugins: false,
};

/** What paseo-bm could learn about Paseo before planning. */
export interface PaseoView {
  /** False when the daemon did not answer: the Paseo half waits for a later run. */
  readonly available: boolean;
  readonly status: DaemonStatus | null;
  /** `paseo plugin ls`; `null` when Paseo is unavailable. */
  readonly plugins: readonly PluginSummary[] | null;
  /** Paseo's home as resolved for this run. */
  readonly paseoHome: string | null;
  /** `config.json`; `null` when unavailable or when the file does not exist. */
  readonly config: ConfigSnapshot | null;
  /** Why Paseo is unavailable, for the report; `null` when it is available. */
  readonly unavailableReason: string | null;
}

/** One path left in place, relative to the install home. */
export interface KeptFile {
  readonly path: string;
  readonly reason: UninstallReason;
}

export interface RestorePlan {
  /** The backup copy, relative to the install home. */
  readonly from: string;
  /** Where it goes back, relative to the install home. */
  readonly to: string;
}

export interface BackupPlan {
  readonly record: BackupRecord;
  readonly decision: "delete" | "forget" | "keep";
  readonly reason: UninstallReason;
  readonly deleteFiles: readonly string[];
  readonly dirs: readonly string[];
  readonly kept: readonly KeptFile[];
}

export interface UninstallPlan {
  readonly record: InstallRecord;
  readonly choices: UninstallChoices;
  readonly paseoAvailable: boolean;
  /** Plugin id to hand to `paseo plugin remove`; `null` when nothing is registered. */
  readonly removePlugin: string | null;
  /** The config edit to apply; `null` when nothing in `config.json` would change. */
  readonly configEdit: ConfigEdit | null;
  /** True when REQ-012(d) allows offering to turn `pluginsEnabled` off. */
  readonly offerPluginsOff: boolean;
  /** Recorded files that still match; removed. */
  readonly deleteFiles: readonly FileRecord[];
  /** User-modified files removed because of `--force`; each is backed up first. */
  readonly forceFiles: readonly FileRecord[];
  /** Recorded files already gone. */
  readonly missingFiles: readonly FileRecord[];
  readonly keptFiles: readonly KeptFile[];
  /** Payload directories to `rmdir`, deepest first. */
  readonly versionDirs: readonly string[];
  readonly restores: readonly RestorePlan[];
  readonly backups: readonly BackupPlan[];
  /** Entries under `plugin/` and `backups/` the record does not list. */
  readonly unrecorded: readonly string[];
  /** True when install.json stays (the Paseo half could not be undone). */
  readonly keepRecord: boolean;
  readonly actions: readonly Action[];
  readonly summary: ActionSummary;
}

export interface PlanUninstallInput {
  readonly record: InstallRecord;
  readonly fsops: FsOps;
  readonly fs?: NodeFsApi | undefined;
  readonly paseo: PaseoView;
  readonly choices?: UninstallChoices | undefined;
}

/* --------------------------------------------------------------- planning */

/** Builds the uninstall plan. Reads only: no write, no external command. */
export async function planUninstall(input: PlanUninstallInput): Promise<UninstallPlan> {
  const { record, fsops, paseo } = input;
  const fs = input.fs ?? nodeFs;
  const choices = input.choices ?? DEFAULT_UNINSTALL_CHOICES;
  const actions: Action[] = [];

  /* -- Paseo: the plugin ------------------------------------------------ */

  const pluginId = record.paseo.pluginId;
  let removePlugin: string | null = null;
  const pluginTarget = `paseoDaemon/plugins[${pluginId ?? "paseo-bm"}]`;
  if (!paseo.available) {
    if (hasPaseoPart(record)) {
      actions.push(keep(pluginTarget, "paseo-daemon", "paseo-unavailable", unavailableDetail(paseo)));
    }
  } else if (pluginId !== null) {
    if (paseo.plugins?.some((plugin) => plugin.id === pluginId) === true) {
      removePlugin = pluginId;
      actions.push({
        kind: "delete",
        target: pluginTarget,
        location: "paseo-daemon",
        reason: "registered",
        detail: `paseo plugin remove ${pluginId}; Paseo keeps its own empty plugins key and the payload directory is removed below`,
      });
    } else {
      actions.push(keep(pluginTarget, "paseo-daemon", "not-registered", "Paseo no longer lists this plugin"));
    }
  }

  /* -- Paseo: config.json -------------------------------------------------- */

  let configEdit: ConfigEdit | null = null;
  let offerPluginsOff = false;
  if (!paseo.available) {
    if (hasPaseoPart(record)) {
      actions.push(keep("paseoHome/config.json", "paseo-config", "paseo-unavailable", unavailableDetail(paseo)));
    }
  } else if (paseo.config !== null) {
    const config = paseo.config.config;
    const others = (paseo.plugins ?? []).filter((plugin) => plugin.id !== pluginId);
    const pluginsEnabled = readBooleanKey(config, PLUGINS_ENABLED_PATH);
    offerPluginsOff = record.paseo.pluginsEnabledSetByUs && pluginsEnabled.value === true && others.length === 0;

    const edit: ConfigEdit = {
      removeProviders: bmProviderIds(config),
      removeProfiles: bmProfileIds(config),
      ...(record.paseo.mcpInject.setByUs
        ? { mcpInject: { action: "restore" as const, previous: record.paseo.mcpInject.previous, expect: true } }
        : {}),
      ...(offerPluginsOff && choices.turnOffPlugins ? { pluginsEnabled: false } : {}),
    };
    const edited = editConfig(config, edit);
    if (edited.changedPaths.length > 0) {
      configEdit = edit;
    }

    const providers = objectAt(config, PROVIDERS_PATH);
    for (const id of edit.removeProviders ?? []) {
      actions.push(configAction(`${PROVIDERS_PATH}.${id}`, toJson(providers?.[id]), null, "owned-by-paseo-bm"));
    }
    const profiles = arrayAt(config, AGENT_PROFILES_PATH);
    for (const id of edit.removeProfiles ?? []) {
      const entry = profiles.find((item) => isObject(item) && item["id"] === id);
      actions.push(configAction(`${AGENT_PROFILES_PATH}[${id}]`, toJson(entry), null, "owned-by-paseo-bm"));
    }

    actions.push(mcpAction(record, config, edited.skippedPaths.includes(MCP_INJECT_PATH)));
    actions.push(pluginsEnabledAction(record, pluginsEnabled.value, offerPluginsOff, choices.turnOffPlugins, others.length));
  }

  /* -- restores -------------------------------------------------------------- */

  const recordedByPath = new Map(record.files.map((file) => [file.path, file]));
  const restores = choices.restoreBackups ? await planRestores(record, fsops, fs, recordedByPath) : [];
  const restoreTargets = new Set(restores.map((restore) => restore.to));
  for (const restore of restores) {
    actions.push(
      keep(installHomeLabel(restore.to), "install-home", "restored-from-backup", `--restore-backups: copied back from ${restore.from}; kept as your file`),
    );
  }

  /* -- payload ------------------------------------------------------------- */

  const deleteFiles: FileRecord[] = [];
  const forceFiles: FileRecord[] = [];
  const missingFiles: FileRecord[] = [];
  const keptFiles: KeptFile[] = [];
  const versionDirs: string[] = [];
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();

  const judgeFile = async (path: string): Promise<void> => {
    seenFiles.add(path);
    const entry = recordedByPath.get(path);
    if (entry === undefined) {
      keptFiles.push({ path, reason: "unrecorded" });
    } else if (restoreTargets.has(path)) {
      keptFiles.push({ path, reason: "restored-from-backup" });
    } else if ((await fsops.hashFile(fsops.resolvePath(path))) === entry.sha256) {
      deleteFiles.push(entry);
    } else if (choices.force) {
      forceFiles.push(entry);
    } else {
      keptFiles.push({ path, reason: "user-modified" });
    }
  };

  for (const version of record.versions) {
    const dir = normalizeDir(version.dir);
    const target = installHomeLabel(version.dir);
    if (!isDirectChild(dir, "plugin")) {
      actions.push(keep(target, "install-home", "unexpected-location", "the record points outside plugin/<version>; not followed"));
      continue;
    }
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const type = await entryType(fsops, fs, dir);
    if (type === "missing") continue;
    if (type !== "directory") {
      actions.push(keep(target, "install-home", type === "symlink" ? "symlink" : "not-a-directory"));
      continue;
    }
    const walked = await walk(fsops, dir);
    keptFiles.push(...walked.odd.map((odd) => ({ path: odd.path, reason: odd.reason as UninstallReason })));
    for (const path of walked.files) {
      await judgeFile(path);
    }
    versionDirs.push(...walked.dirs);
  }

  for (const file of record.files) {
    if (seenFiles.has(file.path)) continue;
    const type = await safeEntryType(fsops, fs, file.path);
    if (type === "missing") {
      missingFiles.push(file);
    } else if (type === "file") {
      await judgeFile(file.path);
    } else {
      keptFiles.push({ path: file.path, reason: type === "symlink" ? "symlink" : "not-a-regular-file" });
    }
  }

  for (const file of deleteFiles) {
    actions.push(fileAction("delete", file.path, "unchanged"));
  }
  for (const file of forceFiles) {
    actions.push(fileAction("delete", file.path, "user-modified", "--force: your edits are copied into a backup first"));
  }
  for (const file of missingFiles) {
    actions.push(fileAction("delete", file.path, "missing", "already gone; only the record entry goes"));
  }
  for (const kept of keptFiles) {
    if (kept.reason === "restored-from-backup") continue;
    actions.push(
      fileAction(
        "keep",
        kept.path,
        kept.reason,
        kept.reason === "user-modified"
          ? "you changed this file, so it is kept; --force removes it after taking a backup"
          : kept.reason === "unrecorded"
            ? "not listed in install.json; left untouched"
            : undefined,
      ),
    );
  }
  for (const dir of seenDirs) {
    const holdsKept = keptFiles.some((kept) => kept.path.startsWith(`${dir}/`)) || restores.some((r) => r.to.startsWith(`${dir}/`));
    actions.push(
      holdsKept
        ? fileAction("keep", dir, "payload-version", "the directory stays because it holds files paseo-bm will not remove")
        : fileAction("delete", dir, "payload-version"),
    );
  }

  /* -- backups --------------------------------------------------------------- */

  const backups = await planBackups(record, fsops, fs, choices.removeBackups);
  for (const backup of backups) {
    const origin = `backup taken ${backup.record.at} (${backup.record.reason})`;
    const target = installHomeLabel(backup.record.dir);
    if (backup.decision === "delete") {
      actions.push(fileAction("delete", backup.record.dir, "backup", `cannot be undone: the ${origin}, ${backup.deleteFiles.length} file(s)`));
    } else if (backup.decision === "forget") {
      actions.push(fileAction("delete", backup.record.dir, "missing", "already gone; only the record entry goes"));
    } else {
      actions.push(keep(target, "install-home", backup.reason, origin));
    }
    for (const kept of backup.kept) {
      actions.push(fileAction("keep", kept.path, kept.reason));
    }
  }
  if (choices.restoreBackups) {
    for (const backup of record.backups) {
      const dir = normalizeDir(backup.dir);
      if (isDirectChild(dir, "backups") && (await safeEntryType(fsops, fs, posix.join(dir, CONFIG_BACKUP_NAME))) === "file") {
        actions.push(
          fileAction(
            "keep",
            posix.join(dir, CONFIG_BACKUP_NAME),
            "config-backup-not-restored",
            "Paseo's config is never restored as a whole file: that would discard every change made since the install (ADR-006 decision 8). Only the keys paseo-bm owns are undone",
          ),
        );
      }
    }
  }

  const unrecorded = [
    ...(await listUnrecorded(fsops, "plugin", new Set(record.versions.map((v) => normalizeDir(v.dir))))),
    ...(await listUnrecorded(fsops, "backups", new Set(record.backups.map((b) => normalizeDir(b.dir))))),
  ];
  for (const path of unrecorded) {
    actions.push(fileAction("keep", path, "unrecorded", "not listed in install.json; left untouched"));
  }

  /* -- the record ------------------------------------------------------------ */

  const keepRecord = !paseo.available && hasPaseoPart(record);
  actions.push(
    keepRecord
      ? fileAction("keep", RECORD_FILE, "paseo-unavailable", "kept so a later uninstall can finish removing the plugin, the bm-* roles and the MCP switch")
      : fileAction("delete", RECORD_FILE, "record"),
  );

  return {
    record,
    choices,
    paseoAvailable: paseo.available,
    removePlugin,
    configEdit,
    offerPluginsOff,
    deleteFiles,
    forceFiles,
    missingFiles,
    keptFiles,
    versionDirs,
    restores,
    backups,
    unrecorded,
    keepRecord,
    actions,
    summary: summarizeActions(actions),
  };
}

async function planRestores(
  record: InstallRecord,
  fsops: FsOps,
  fs: NodeFsApi,
  recorded: ReadonlyMap<string, FileRecord>,
): Promise<RestorePlan[]> {
  // Oldest first, so the newest copy of a path is the one that wins.
  const ordered = [...record.backups].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const byTarget = new Map<string, RestorePlan>();
  for (const backup of ordered) {
    const dir = normalizeDir(backup.dir);
    if (!isDirectChild(dir, "backups") || (await entryType(fsops, fs, dir)) !== "directory") continue;
    const walked = await walk(fsops, dir);
    for (const from of walked.files) {
      const to = from.slice(dir.length + 1);
      // Only a copy of a payload file paseo-bm recorded goes back, and only onto
      // that recorded path. The config copy never does (ADR-006 decision 8).
      const entry = recorded.get(to);
      if (to === CONFIG_BACKUP_NAME || entry === undefined) continue;
      if ((await fsops.hashFile(fsops.resolvePath(from))) === entry.sha256) continue;
      byTarget.set(to, { from, to });
    }
  }
  return [...byTarget.values()].sort((a, b) => (a.to < b.to ? -1 : 1));
}

async function planBackups(record: InstallRecord, fsops: FsOps, fs: NodeFsApi, remove: boolean): Promise<BackupPlan[]> {
  const plans: BackupPlan[] = [];
  const seen = new Set<string>();
  for (const backup of record.backups) {
    const dir = normalizeDir(backup.dir);
    const base = { record: backup, deleteFiles: [], dirs: [], kept: [] };
    if (!isDirectChild(dir, "backups")) {
      plans.push({ ...base, decision: "keep", reason: "unexpected-location" });
      continue;
    }
    if (!remove) {
      plans.push({ ...base, decision: "keep", reason: "kept-by-choice" });
      continue;
    }
    if (seen.has(dir)) {
      plans.push({ ...base, decision: "forget", reason: "backup" });
      continue;
    }
    seen.add(dir);
    const type = await entryType(fsops, fs, dir);
    if (type === "missing") {
      plans.push({ ...base, decision: "forget", reason: "missing" });
      continue;
    }
    if (type !== "directory") {
      plans.push({ ...base, decision: "keep", reason: type === "symlink" ? "symlink" : "not-a-directory" });
      continue;
    }
    const walked = await walk(fsops, dir);
    if (walked.odd.length > 0) {
      const kept = walked.odd.map((odd) => ({ path: odd.path, reason: odd.reason as UninstallReason }));
      plans.push({ ...base, decision: "keep", reason: kept[0]!.reason, kept });
      continue;
    }
    plans.push({ ...base, decision: "delete", reason: "backup", deleteFiles: walked.files, dirs: walked.dirs });
  }
  return plans;
}

function mcpAction(record: InstallRecord, config: Record<string, unknown>, skipped: boolean): Action {
  const target = MCP_INJECT_PATH;
  const current = readBooleanKey(config, MCP_INJECT_PATH);
  const { setByUs, previous } = record.paseo.mcpInject;
  if (!setByUs) {
    return keep(`paseoHome/config.json#${target}`, "paseo-config", "not-set-by-paseo-bm", "paseo-bm did not turn this switch on, so it is left as it is");
  }
  if (skipped) {
    return keep(
      `paseoHome/config.json#${target}`,
      "paseo-config",
      "changed-since-install",
      `paseo-bm set it to true, but it is now ${current.present ? JSON.stringify(current.raw) : "absent"}; someone else changed it, so it is left alone`,
    );
  }
  return configAction(
    target,
    current.present ? toJson(current.raw) : null,
    previous.present ? previous.value : null,
    "restore-previous",
    previous.present ? "back to the value it had before paseo-bm" : "the key did not exist before paseo-bm, so it is removed",
  );
}

function pluginsEnabledAction(
  record: InstallRecord,
  current: boolean | null,
  offer: boolean,
  turnOff: boolean,
  otherPlugins: number,
): Action {
  const target = `paseoHome/config.json#${PLUGINS_ENABLED_PATH}`;
  if (!record.paseo.pluginsEnabledSetByUs) {
    return keep(target, "paseo-config", "not-set-by-paseo-bm", "paseo-bm did not turn plugins on, so the switch is left as it is");
  }
  if (!offer) {
    return keep(
      target,
      "paseo-config",
      otherPlugins > 0 ? "other-plugins-installed" : "changed-since-install",
      otherPlugins > 0 ? "other plugins still use it" : "the switch is no longer on",
    );
  }
  if (turnOff) {
    return configAction(PLUGINS_ENABLED_PATH, current, false, "set-by-paseo-bm", "you chose to turn plugins off again");
  }
  return keep(target, "paseo-config", "set-by-paseo-bm", "kept on by default; an interactive uninstall asks whether to turn it off");
}

/* ---------------------------------------------------------------- applying */

export interface ApplyUninstallInput {
  readonly plan: UninstallPlan;
  readonly fsops: FsOps;
  readonly fs?: NodeFsApi | undefined;
  readonly adapter: PaseoAdapter;
  /** Paseo's home; required when the plan touches Paseo. */
  readonly paseoHome: string | null;
  readonly now?: Date | undefined;
}

export interface ApplyUninstallResult {
  readonly pluginRemoved: boolean;
  readonly configChanged: readonly string[];
  readonly removedFiles: readonly string[];
  readonly restoredFiles: readonly string[];
  readonly kept: readonly KeptFile[];
  /** The backup this run took (config copy, `--force` copies), relative; `null` when none is left. */
  readonly runBackup: string | null;
  readonly recordDeleted: boolean;
  /** The record written back when it is kept. */
  readonly record: InstallRecord | undefined;
  /** Actions describing apply-time surprises, appended to the plan's. */
  readonly extraActions: readonly Action[];
}

/** An error raised after something was already changed. */
export class UninstallApplyError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UninstallApplyError";
    this.cause = cause;
  }
}

/** Carries out an uninstall plan. Every decision was made by the planner. */
export async function applyUninstall(input: ApplyUninstallInput): Promise<ApplyUninstallResult> {
  const { plan, fsops, adapter } = input;
  const fs = input.fs ?? nodeFs;
  const now = input.now ?? new Date();
  const extraActions: Action[] = [];
  const kept: KeptFile[] = [...plan.keptFiles];
  const removedFiles: string[] = [];
  const restoredFiles: string[] = [];
  let runBackup: string | null = null;
  let wroteSomething = false;

  const backupDir = async (): Promise<string> => {
    if (runBackup === null) {
      runBackup = await freeBackupDir(fsops, fs, now);
    }
    return runBackup;
  };

  try {
    /* 1. Paseo: plugin, then config. Nothing on disk is removed before both succeed. */
    let pluginRemoved = false;
    if (plan.paseoAvailable && plan.removePlugin !== null) {
      await adapter.pluginRemove(plan.removePlugin);
      pluginRemoved = true;
      wroteSomething = true;
    }

    let configChanged: readonly string[] = [];
    if (plan.paseoAvailable && plan.configEdit !== null && input.paseoHome !== null) {
      const dir = await backupDir();
      const result = await applyConfigEdit({
        paseoHome: input.paseoHome,
        installHome: fsops.root,
        edit: plan.configEdit,
        adapter,
        fs,
        backupDir: fsops.resolvePath(dir),
        now,
      });
      wroteSomething = true;
      configChanged = result.changedPaths;
      if (result.skippedPaths.includes(MCP_INJECT_PATH) && !plan.actions.some((a) => a.reason === "changed-since-install" && a.target.endsWith(MCP_INJECT_PATH))) {
        extraActions.push(
          keep(`paseoHome/config.json#${MCP_INJECT_PATH}`, "paseo-config", "changed-since-install", "changed by someone else after the preview; left alone"),
        );
      }
    }

    /* 2. Backups go back before anything is removed. */
    for (const restore of plan.restores) {
      const bytes = await fs.readFile(fsops.resolvePath(restore.from));
      await fsops.writeFileAtomic(restore.to, bytes, { mode: FILE_MODE });
      restoredFiles.push(restore.to);
      wroteSomething = true;
    }

    /* 3. The payload. */
    for (const file of plan.forceFiles) {
      await fsops.backupFile(fsops.resolvePath(file.path), { backupDir: fsops.resolvePath(await backupDir()) });
      wroteSomething = true;
      const outcome = await removeFile(fsops, fs, file.path, undefined);
      if (outcome === "removed") removedFiles.push(file.path);
      else kept.push({ path: file.path, reason: outcome });
    }
    for (const file of plan.deleteFiles) {
      const outcome = await removeFile(fsops, fs, file.path, file.sha256);
      wroteSomething = true;
      if (outcome === "removed") {
        removedFiles.push(file.path);
      } else {
        kept.push({ path: file.path, reason: outcome });
        extraActions.push(fileAction("keep", file.path, outcome, "changed between the preview and the removal, so it was kept"));
      }
    }
    await removeEmptyDirs(fsops, plan.versionDirs);

    /* 4. Backups, by choice. */
    const removedBackups = new Set<BackupRecord>();
    for (const backup of plan.backups) {
      if (backup.decision === "keep") continue;
      for (const path of backup.deleteFiles) {
        const outcome = await removeFile(fsops, fs, path, undefined);
        wroteSomething = true;
        if (outcome !== "removed") kept.push({ path, reason: outcome });
      }
      await removeEmptyDirs(fsops, backup.dirs);
      if ((await entryType(fsops, fs, normalizeDir(backup.record.dir))) === "missing") {
        removedBackups.add(backup.record);
      }
    }

    // This run's own backup goes too when the user drops backups — unless it
    // holds a user's file removed with --force: that copy is the only one left.
    if (runBackup !== null && plan.choices.removeBackups && plan.forceFiles.length === 0) {
      const walked = (await entryType(fsops, fs, runBackup)) === "directory" ? await walk(fsops, runBackup) : undefined;
      if (walked !== undefined && walked.odd.length === 0) {
        for (const path of walked.files) await removeFile(fsops, fs, path, undefined);
        await removeEmptyDirs(fsops, walked.dirs);
      }
      if ((await entryType(fsops, fs, runBackup)) === "missing") runBackup = null;
    }

    /* 5. The record. */
    let record: InstallRecord | undefined;
    let recordDeleted = false;
    if (plan.keepRecord) {
      const removed = new Set([...removedFiles, ...plan.missingFiles.map((file) => file.path)]);
      const goneDirs = new Set<string>();
      for (const version of plan.record.versions) {
        if ((await safeEntryType(fsops, fs, normalizeDir(version.dir))) === "missing") goneDirs.add(normalizeDir(version.dir));
      }
      const backups = plan.record.backups.filter((backup) => !removedBackups.has(backup));
      const ownBackup: string | null = runBackup;
      if (ownBackup !== null) {
        backups.push({ at: toIsoUtc(now), dir: ownBackup, reason: "uninstall" });
      }
      record = {
        ...plan.record,
        updatedAt: toIsoUtc(now),
        files: plan.record.files.filter((file) => !removed.has(file.path)),
        versions: plan.record.versions.filter((version) => !goneDirs.has(normalizeDir(version.dir))),
        backups,
      };
      await writeRecord(fsops, record);
      wroteSomething = true;
    } else {
      await fs.unlink(fsops.resolvePath(RECORD_FILE)).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
      recordDeleted = true;
      wroteSomething = true;
    }

    await removeEmptyDirs(fsops, ["plugin", "backups"]);

    return {
      pluginRemoved,
      configChanged,
      removedFiles,
      restoredFiles,
      kept,
      runBackup,
      recordDeleted,
      record,
      extraActions,
    };
  } catch (error) {
    throw wroteSomething ? new UninstallApplyError(error) : error;
  }
}

/** `backups/<stamp>`, with `-2`, `-3`… when that directory already exists. */
async function freeBackupDir(fsops: FsOps, fs: NodeFsApi, now: Date): Promise<string> {
  const stamp = backupStamp(now);
  for (let index = 1; ; index += 1) {
    const dir = posix.join("backups", index === 1 ? stamp : `${stamp}-${index}`);
    if ((await entryType(fsops, fs, dir)) === "missing") return dir;
  }
}

/* ------------------------------------------------------------- the command */

export interface UninstallOptions {
  readonly adapter: PaseoAdapter;
  /** Everything but the daemon's home, which this run asks the daemon for. */
  readonly layoutInput: Omit<ResolveLayoutInput, "daemonPaseoHome">;
  readonly prompter: Prompter;
  readonly apply: boolean;
  readonly yes?: boolean;
  readonly force?: boolean;
  readonly restoreBackups?: boolean;
  readonly json?: boolean;
  readonly version: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fs?: NodeFsApi;
  readonly now?: Date;
  readonly platform?: NodeJS.Platform;
  readonly nodeVersion?: string;
  readonly lockOptions?: AcquireLockOptions;
}

export interface UninstallOutcome {
  readonly report: PlanReport;
  readonly exitCode: ExitCode;
  readonly plan: UninstallPlan | undefined;
  readonly applied: ApplyUninstallResult | undefined;
}

/**
 * Runs the whole command and writes the report. Returns the outcome so a test
 * can look at the plan and the result as well as the rendered document.
 */
export async function runUninstall(options: UninstallOptions): Promise<UninstallOutcome> {
  const fs = options.fs ?? nodeFs;
  const interactive = options.prompter.interactive;
  const facts = { cliVersion: null as string | null, daemonVersion: null as string | null, home: null as string | null, pluginsEnabled: false };
  let plan: UninstallPlan | undefined;
  let applied: ApplyUninstallResult | undefined;
  let record: InstallRecord | undefined;
  let pluginState: string | null = null;

  const finish = (mode: "preview" | "applied", exitCode: ExitCode, error?: ReportError): UninstallOutcome => {
    const actions = [...(plan?.actions ?? []), ...(applied?.extraActions ?? [])];
    const report: PlanReport = {
      schemaVersion: 1,
      command: "uninstall",
      mode,
      paseoBmVersion: options.version,
      paseo: facts,
      actions,
      roles: rolesOf(record),
      skills: null,
      warnings: [],
      result: { exitCode, pluginState, ...(error === undefined ? {} : { error }) },
    };
    if (options.json === true) {
      writeJsonReport(report, options.stdout);
    } else {
      writeHumanReport(report, options.stdout);
    }
    const notes = closingNotes(plan, mode);
    if (notes.length > 0) {
      (options.json === true ? options.stderr : options.stdout)(`${notes.join("\n")}\n`);
    }
    return { report, exitCode, plan, applied };
  };

  const fail = (mode: "preview" | "applied", exitCode: ExitCode, error: unknown): UninstallOutcome => {
    const described = describeFailure(error);
    options.stderr(`error: ${described.code === undefined ? "" : `${described.code}: `}${described.message}\n`);
    if (described.remediation !== undefined) options.stderr(`${described.remediation}\n`);
    return finish(mode, exitCode, described.code === undefined ? undefined : { code: described.code, message: described.message });
  };

  /* -- light preflight: OS, Node, and whether the daemon answers ---------- */

  for (const finding of [
    checkOperatingSystem(options.platform ?? process.platform),
    checkNodeVersion(options.nodeVersion ?? process.versions.node),
  ]) {
    if (finding.severity === "error" && finding.code !== null && finding.code.startsWith("E_")) {
      const code = finding.code as ErrorCode;
      return finish("preview", EXIT_CODES.preflight, { code, message: finding.message });
    }
  }

  const daemon = await checkDaemon(options.adapter);
  const status = daemon.status;
  if (status !== null) {
    facts.cliVersion = status.cliVersion;
    facts.daemonVersion = status.daemonVersion;
    facts.home = status.home;
  }

  let layout: Layout;
  let fsops: FsOps;
  try {
    layout = resolveLayout({ ...options.layoutInput, daemonPaseoHome: status?.home });
    fsops = createFsOps({ root: layout.installHome.path, fs });
    record = await readRecord(fsops);
  } catch (error) {
    return fail("preview", EXIT_CODES.preflight, error);
  }

  if (record === undefined) {
    options.stderr(`paseo-bm is not installed here: there is no install record at ${recordPath(layout.installHome.path)}. Nothing to remove.\n`);
    return finish("preview", options.apply ? EXIT_CODES.ok : previewExitCode({ interactive, apply: false }));
  }

  let paseo: PaseoView;
  try {
    paseo = await viewPaseo(options.adapter, status, daemon.finding.message, layout, fs);
  } catch (error) {
    return fail("preview", EXIT_CODES.preflight, error);
  }
  facts.pluginsEnabled = paseo.config === null ? false : readBooleanKey(paseo.config.config, PLUGINS_ENABLED_PATH).value === true;
  pluginState = paseo.plugins?.find((plugin) => plugin.id === record?.paseo.pluginId)?.status ?? null;

  const baseChoices: UninstallChoices = {
    ...DEFAULT_UNINSTALL_CHOICES,
    force: options.force === true,
    restoreBackups: options.restoreBackups === true,
  };

  try {
    plan = await planUninstall({ record, fsops, fs, paseo, choices: baseChoices });
  } catch (error) {
    return fail("preview", EXIT_CODES.preflight, error);
  }

  if (!options.apply) {
    return finish("preview", previewExitCode({ interactive, apply: false }));
  }

  /* -- confirmation and the two choices only a person can make ------------ */

  let choices = baseChoices;
  if (interactive) {
    if (options.yes !== true) {
      const preview = buildPreview(plan, facts, options.version, record, pluginState);
      writeHumanReport(preview, options.json === true ? options.stderr : options.stdout);
      const confirmed = await options.prompter.confirm({ message: "Uninstall paseo-bm as shown above?", defaultValue: false });
      if (!confirmed) {
        options.stderr("Nothing was changed.\n");
        return finish("preview", EXIT_CODES.ok);
      }
    }
    const turnOffPlugins = plan.offerPluginsOff
      ? await options.prompter.confirm({
          message: "paseo-bm turned Paseo plugins on and no other plugin is installed. Turn plugins off again?",
          defaultValue: false,
        })
      : false;
    const hasBackups = record.backups.length > 0 || plan.configEdit !== null;
    const removeBackups = hasBackups
      ? await options.prompter.confirm({
          message: "Also remove paseo-bm's backups? This cannot be undone.",
          defaultValue: false,
          details: ["Backups hold earlier copies of Paseo's config.json and of files paseo-bm overwrote."],
        })
      : false;
    choices = { ...baseChoices, turnOffPlugins, removeBackups };
  }

  /* -- apply, under the lock ------------------------------------------------ */

  const installHome = layout.installHome.path;
  try {
    await withLock(
      installHome,
      async () => {
        // Re-read under the lock: the plan that is applied is the plan of the
        // record as it is now, not as it was when the preview was printed.
        const current = await readRecord(fsops);
        if (current === undefined) {
          plan = undefined;
          return;
        }
        record = current;
        plan = await planUninstall({ record: current, fsops, fs, paseo, choices });
        applied = await applyUninstall({ plan, fsops, fs, adapter: options.adapter, paseoHome: paseo.paseoHome, now: options.now });
      },
      { command: "uninstall", ...options.lockOptions },
    );
  } catch (error) {
    if (error instanceof UninstallApplyError) {
      // Something was already changed: the run stopped part-way and a person
      // has to look at it before running again.
      return fail("applied", EXIT_CODES.conflict, error.cause);
    }
    if (isConfigMutationError(error) && error.reason === "concurrent-write") {
      return fail("preview", EXIT_CODES.conflict, error);
    }
    return fail("preview", EXIT_CODES.preflight, error);
  }

  // The lock file lived inside the install home; with it gone, an empty
  // install home can go too. A non-empty one stays (rmdir refuses).
  if (applied !== undefined && !plan!.keepRecord) {
    await rmdir(fsops.root).catch(() => undefined);
  }
  if (applied?.pluginRemoved === true) {
    pluginState = null;
  }
  return finish("applied", EXIT_CODES.ok);
}

/** The handler `src/cli.ts` routes `uninstall` to. */
export const uninstallCommand: CommandHandler = async (context: CommandContext): Promise<number> => {
  const outcome = await runUninstall({
    adapter: createPaseoAdapter({ env: context.env }),
    layoutInput: { flags: context.homes, env: context.env },
    prompter: context.prompter,
    apply: context.flags.apply,
    yes: context.flags.yes,
    force: context.flags.force,
    restoreBackups: context.flags.restoreBackups,
    json: context.flags.json,
    version: context.version,
    stdout: context.stdout,
    stderr: context.stderr,
  });
  return outcome.exitCode;
};

/* ---------------------------------------------------------------- helpers */

async function viewPaseo(
  adapter: PaseoAdapter,
  status: DaemonStatus | null,
  reason: string,
  layout: Layout,
  fs: NodeFsApi,
): Promise<PaseoView> {
  if (status === null) {
    return { available: false, status: null, plugins: null, paseoHome: null, config: null, unavailableReason: reason };
  }
  const plugins = await adapter.pluginList();
  const paseoHome = layout.paseoHome.path;
  let config: ConfigSnapshot | null = null;
  try {
    config = await readConfigSnapshot(paseoConfigFile(paseoHome), fs);
  } catch (error) {
    if (!(isConfigMutationError(error) && error.reason === "config-missing")) throw error;
  }
  return { available: true, status, plugins, paseoHome, config, unavailableReason: null };
}

function buildPreview(
  plan: UninstallPlan,
  paseo: PlanReport["paseo"],
  version: string,
  record: InstallRecord,
  pluginState: string | null,
): PlanReport {
  return {
    schemaVersion: 1,
    command: "uninstall",
    mode: "preview",
    paseoBmVersion: version,
    paseo,
    actions: plan.actions,
    roles: rolesOf(record),
    skills: null,
    warnings: [],
    result: { exitCode: EXIT_CODES.ok, pluginState },
  };
}

function closingNotes(plan: UninstallPlan | undefined, mode: "preview" | "applied"): string[] {
  if (plan === undefined) return [];
  const notes = [
    "Agent skills are not touched: they are managed by the skills tool, which can remove them.",
    "Beads Manager, Worker and Reviewer agents already in Paseo are yours and are left as they are; archive or delete them in Paseo if you want them gone.",
  ];
  if (!plan.paseoAvailable) {
    notes.push(
      mode === "applied"
        ? "The Paseo daemon did not answer, so only files were removed. install.json was kept; run `npx paseo-bm uninstall --apply` again once Paseo is running to remove the plugin, the bm-* roles and the MCP switch."
        : "The Paseo daemon did not answer, so only files would be removed and install.json would be kept for a later run.",
    );
  }
  return notes;
}

function rolesOf(record: InstallRecord | undefined): RoleReport[] {
  return (record?.roles ?? []).map((role) => ({
    role: role.role,
    provider: role.baseProvider,
    model: role.model,
    paseoTools: role.paseoTools,
    loggedIn: null,
  }));
}

interface DescribedFailure {
  readonly code: ErrorCode | undefined;
  readonly message: string;
  readonly remediation: string | undefined;
}

function describeFailure(error: unknown): DescribedFailure {
  if (error instanceof PathGuardError) {
    const code = pathGuardErrorCode(error.reason);
    return { code, message: `${diagnostic(code).message} ${error.message}`, remediation: diagnostic(code).remediation };
  }
  if (error instanceof LockError) {
    return { code: error.code, message: error.message, remediation: undefined };
  }
  if (isRecordError(error) || isConfigMutationError(error)) {
    return { code: error.code, message: error.message, remediation: error.remediation };
  }
  if (isPaseoCliError(error)) {
    return { code: error.code, message: error.message, remediation: diagnostic(error.code).remediation };
  }
  return { code: undefined, message: error instanceof Error ? error.message : String(error), remediation: undefined };
}

function hasPaseoPart(record: InstallRecord): boolean {
  return (
    record.paseo.pluginId !== null ||
    record.roles.length > 0 ||
    record.paseo.mcpInject.setByUs ||
    record.paseo.pluginsEnabledSetByUs
  );
}

function unavailableDetail(paseo: PaseoView): string {
  return `left for a later run: ${paseo.unavailableReason ?? "the Paseo daemon did not answer"}`;
}

function keep(target: string, location: FileAction["location"], reason: UninstallReason, detail?: string): FileAction {
  return { kind: "keep", target, location, reason, ...(detail === undefined ? {} : { detail }) };
}

function fileAction(kind: "delete" | "keep", path: string, reason: UninstallReason, detail?: string): FileAction {
  return {
    kind,
    target: installHomeLabel(path),
    location: "install-home",
    reason,
    ...(detail === undefined ? {} : { detail }),
  };
}

function configAction(key: string, from: JsonValue | null, to: JsonValue | null, reason: UninstallReason, detail?: string): ConfigAction {
  return {
    kind: "config",
    target: `paseoHome/config.json#${key}`,
    location: "paseo-config",
    reason,
    from: from as ConfigAction["from"],
    to: to as ConfigAction["to"],
    ...(detail === undefined ? {} : { detail }),
  };
}

/** A recorded path's type; a path the guard refuses counts as a symlink. */
async function safeEntryType(fsops: FsOps, fs: NodeFsApi, path: string): Promise<Awaited<ReturnType<typeof entryType>>> {
  try {
    return await entryType(fsops, fs, path);
  } catch (error) {
    if (error instanceof PathGuardError) return "symlink";
    throw error;
  }
}

function objectAt(config: Record<string, unknown>, path: string): Record<string, unknown> | undefined {
  let node: unknown = config;
  for (const segment of path.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[segment];
  }
  return isObject(node) ? node : undefined;
}

function arrayAt(config: Record<string, unknown>, path: string): unknown[] {
  const segments = path.split(".");
  const leaf = segments.pop() ?? path;
  const parent = segments.length === 0 ? config : objectAt(config, segments.join("."));
  const value = parent?.[leaf];
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJson(value: unknown): JsonValue | null {
  return value === undefined ? null : (value as JsonValue);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}
