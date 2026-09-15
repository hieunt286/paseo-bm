/**
 * The role step of `paseo-bm install` (bead bm-wp-107-2r5.4; REQ-027(a)–(e),
 * REQ-031; Technical Design §3.2, §3.4, §4.2, §9.1; ADR-006 decisions 1, 2, 5).
 *
 * This file composes three modules that already decide everything and adds
 * only the wiring:
 *
 * - `configureRoles` (`src/roles/config.ts`) — `--role`, the recorded
 *   `roles[]` (reused unless `--reconfigure`), a question per role, or a
 *   default plus a warning when nothing can be asked;
 * - `ensureProviderLogins` (`src/roles/login.ts`) — `W_PROVIDER_NOT_LOGGED_IN`,
 *   never blocking;
 * - `registerRoles` (`src/roles/register.ts`) — only `bm-*` entries, no write
 *   when they already hold the right value.
 *
 * It runs in two halves, because the install flow has two phases:
 *
 * 1. {@link RolesStep.plan}, before anything is written. It loads Paseo's
 *    provider catalogue, checks every `--role` pair against it
 *    (`E_PROVIDER_UNAVAILABLE`, exit 3, zero writes), decides the three roles —
 *    asking on a terminal — and turns the decision into `config` actions for
 *    the preview. The preview is therefore the plan here too.
 * 2. {@link RolesStep.apply}, under the lock, after plugin registration and the
 *    trust-boundary step (Design §9.1): the login check, the `bm-*` write, and
 *    `roles[]` in `install.json`. The config backup is added to `backups[]`
 *    and handed back so `--prune` keeps it.
 *
 * Nothing here reads, stores or prints a credential: the login check keeps one
 * boolean, and a login is the provider tool's own command.
 */

import type { Action, JsonValue, ReportWarning, RoleReport } from "../../action.js";
import type { CommandContext } from "../../cli.js";
import type { ErrorCode } from "../../errors.js";
import type { ExitCode } from "../../exit-codes.js";
import { EXIT_CODES } from "../../exit-codes.js";
import type { NodeFsApi } from "../../fs-guard.js";
import type { FsOps } from "../../fsops.js";
import { backupStamp } from "../../fsops.js";
import { installPaths, paseoConfigFile } from "../../layout.js";
import type { PaseoAdapter } from "../../paseo/adapter.js";
import { isPaseoCliError } from "../../paseo/adapter.js";
import type { PaseoConfig } from "../../paseo/config.js";
import {
  AGENT_PROFILES_PATH,
  CONFIG_BACKUP_NAME,
  PROVIDERS_PATH,
  editConfig,
  isConfigMutationError,
  readConfigSnapshot,
} from "../../paseo/config.js";
import type { Prompter } from "../../prompter.js";
import { PromptUnavailableError } from "../../prompter.js";
import type { InstallRecord, RoleName, RoleRecord } from "../../record.js";
import { ROLE_NAMES, roleId, toIsoUtc, writeRecord } from "../../record.js";
import type { ProviderCatalog, RoleSelection } from "../../roles/config.js";
import { RoleConfigError, configureRoles, loadProviderCatalog, toRoleRecord, validateRoleSpecs } from "../../roles/config.js";
import type { LoginSpawner, ProviderLoginReport } from "../../roles/login.js";
import { ensureProviderLogins } from "../../roles/login.js";
import { registerRoles, roleRegistrationEdit } from "../../roles/register.js";
import { CONFIG_BACKUP_REASON } from "./enable.js";

/** A failure the install command reports in `result.error` with this exit code. */
export interface RolesStepFailure {
  readonly exitCode: ExitCode;
  /** Absent when the failure has no registry code; the detail is still printed. */
  readonly code?: ErrorCode;
  readonly detail: string;
}

export interface RolesPlanInput {
  readonly context: CommandContext;
  /** False under `--json` or without a terminal: nothing is asked then. */
  readonly interactive: boolean;
  readonly adapter: PaseoAdapter;
  readonly paseoHome: string;
  readonly fs: NodeFsApi;
  /** The record before this run; its `roles[]` is reused unless `--reconfigure`. */
  readonly record: InstallRecord | undefined;
}

export interface RolesPlan {
  /** All three roles, in `ROLE_NAMES` order. */
  readonly selections: readonly RoleSelection[];
  /** `config` for an entry that will change, `skip` for one that already matches. */
  readonly actions: readonly Action[];
  /** The roles as the report shows them before any login was checked. */
  readonly roles: readonly RoleReport[];
  /** Lines for the user: why a role ended on a default, and similar. */
  readonly notes: readonly string[];
  readonly questionsAsked: number;
}

export type RolesPlanResult =
  | { readonly ok: true; readonly plan: RolesPlan }
  | { readonly ok: false; readonly failure: RolesStepFailure };

export interface RolesApplyInput {
  readonly context: CommandContext;
  readonly interactive: boolean;
  readonly adapter: PaseoAdapter;
  readonly installHome: string;
  readonly paseoHome: string;
  readonly fsops: FsOps;
  readonly fs: NodeFsApi;
  /** The record as it is on disk right now. */
  readonly record: InstallRecord;
  readonly plan: RolesPlan;
  readonly now: Date;
}

export interface RolesApplyOutcome {
  /** The record after the step; the input unchanged when nothing was written. */
  readonly record: InstallRecord;
  readonly roles: readonly RoleReport[];
  /** What was actually done to the `bm-*` entries. */
  readonly actions: readonly Action[];
  /** `W_PROVIDER_NOT_LOGGED_IN`; never changes the exit code. */
  readonly warnings: readonly ReportWarning[];
  /** Backup directories this step took (relative to the install home); `--prune` keeps them. */
  readonly backupDirs: readonly string[];
  readonly notes: readonly string[];
  readonly failure?: RolesStepFailure;
}

export interface RolesStep {
  plan(input: RolesPlanInput): Promise<RolesPlanResult>;
  apply(input: RolesApplyInput): Promise<RolesApplyOutcome>;
}

export interface RolesStepDeps {
  /** Starts a provider's login command. Tests inject one; the default runs the real tool. */
  readonly spawnLogin?: LoginSpawner;
  /** Default: `paseo provider ls` / `provider models` through the adapter. */
  readonly loadCatalog?: (adapter: PaseoAdapter) => Promise<ProviderCatalog>;
}

/** Builds the step; {@link defaultRolesStep} is the one the install command uses. */
export function createRolesStep(deps: RolesStepDeps = {}): RolesStep {
  const loadCatalog = deps.loadCatalog ?? ((adapter: PaseoAdapter) => loadProviderCatalog(adapter));
  return {
    plan: (input) => planRoles(input, loadCatalog),
    apply: (input) => applyRoles(input, deps.spawnLogin),
  };
}

export const defaultRolesStep: RolesStep = createRolesStep();

/* ----------------------------------------------------------------- plan */

async function planRoles(
  input: RolesPlanInput,
  loadCatalog: (adapter: PaseoAdapter) => Promise<ProviderCatalog>,
): Promise<RolesPlanResult> {
  const { context } = input;
  let catalog: ProviderCatalog;
  try {
    catalog = await loadCatalog(input.adapter);
  } catch (error) {
    if (isPaseoCliError(error)) {
      return { ok: false, failure: { exitCode: EXIT_CODES.preflight, code: error.code, detail: error.message } };
    }
    throw error;
  }

  // Existence of every --role pair, before any question and before any write.
  const check = await validateRoleSpecs(context.roleSpecs, catalog);
  if (!check.ok) {
    return {
      ok: false,
      failure: {
        exitCode: EXIT_CODES.preflight,
        code: "E_PROVIDER_UNAVAILABLE",
        detail: check.errors.map((entry) => entry.message).join(" "),
      },
    };
  }

  // Read before deciding: a reused roles[] entry takes its name from here,
  // because roles[] itself has no name field (Design §3.2, bug bm-lev).
  const config = await readConfigOrEmpty(input.paseoHome, input.fs);

  let configuration;
  try {
    configuration = await configureRoles({
      specs: context.roleSpecs,
      catalog,
      prompter: input.interactive ? context.prompter : nonInteractive(context.prompter),
      existing: input.record?.roles ?? [],
      existingNames: registeredRoleNames(config),
      reconfigure: context.flags.reconfigure,
    });
  } catch (error) {
    if (error instanceof RoleConfigError) {
      return { ok: false, failure: { exitCode: EXIT_CODES.preflight, code: error.code, detail: error.message } };
    }
    if (isPaseoCliError(error)) {
      return { ok: false, failure: { exitCode: EXIT_CODES.preflight, code: error.code, detail: error.message } };
    }
    throw error;
  }

  return {
    ok: true,
    plan: {
      selections: configuration.selections,
      actions: roleActions(config, configuration.selections),
      roles: configuration.selections.map((selection) => roleReport(toRoleRecord(selection), null)),
      notes: configuration.warnings.map((warning) => warning.message),
      questionsAsked: configuration.questionsAsked,
    },
  };
}

/* ---------------------------------------------------------------- apply */

async function applyRoles(input: RolesApplyInput, spawnLogin: LoginSpawner | undefined): Promise<RolesApplyOutcome> {
  const { context, plan } = input;
  const prompter = input.interactive ? context.prompter : nonInteractive(context.prompter);

  /* -- 1. login: warn, never block (Design §9.3) ---------------------------- */
  const logins = await ensureProviderLogins({
    selections: plan.selections,
    runner: input.adapter,
    prompter,
    // stderr: under --json stdout carries exactly one document.
    print: (line) => context.stderr(`${line}\n`),
    ...(spawnLogin === undefined ? {} : { spawnLogin }),
  });
  const warnings: ReportWarning[] = logins.warnings.map((warning) => ({ code: warning.code, detail: warning.message }));
  const roleRecords = plan.selections.map(toRoleRecord);
  const roles = roleRecords.map((entry) => roleReport(entry, loggedIn(logins, entry.baseProvider)));

  /* -- 2. the bm-* entries: re-read, write only what differs ---------------- */
  const config = await readConfigOrEmpty(input.paseoHome, input.fs);
  const actions = roleActions(config, plan.selections);
  let record = input.record;
  const backupDirs: string[] = [];
  const notes: string[] = [];

  if (actions.some((action) => action.kind === "config")) {
    const stamp = await freeBackupStamp(input.installHome, input.now, input.fs);
    const backupDirRel = `backups/${stamp}`;
    try {
      const result = await registerRoles({
        paseoHome: input.paseoHome,
        installHome: input.installHome,
        selections: plan.selections,
        adapter: input.adapter,
        fs: input.fs,
        backupDir: installPaths(input.installHome).backupDir(stamp),
        now: input.now,
      });
      if (result.config.backupPath !== undefined) {
        record = withBackup(record, backupDirRel, input.now);
        backupDirs.push(backupDirRel);
      }
    } catch (error) {
      if (!isConfigMutationError(error)) throw error;
      if (error.backupPath !== undefined) {
        record = withBackup(record, backupDirRel, input.now);
        backupDirs.push(backupDirRel);
      }
      if (record !== input.record) await writeRecord(input.fsops, record);
      return {
        record,
        roles,
        actions,
        warnings,
        backupDirs,
        notes: [
          ...(error.restoredFromBackup ? [`Paseo's config.json was put back from ${backupDirRel}.`] : []),
          "The agent roles were not registered. Re-run the install to try again.",
        ],
        failure: {
          // Files are installed and the plugin is registered, so 3 ("nothing was
          // written") would be false. The trust-boundary step maps a config
          // failure to 4 as well; the Design names no dedicated code.
          exitCode: EXIT_CODES.consentMissing,
          ...(error.code === undefined ? {} : { code: error.code }),
          detail: error.message,
        },
      };
    }
  }

  /* -- 3. roles[] in install.json ------------------------------------------- */
  if (JSON.stringify(record.roles) !== JSON.stringify(roleRecords)) {
    record = { ...record, updatedAt: toIsoUtc(input.now), roles: roleRecords };
  }
  if (record !== input.record) {
    await writeRecord(input.fsops, record);
  }

  return { record, roles, actions, warnings, backupDirs, notes };
}

/* -------------------------------------------------------------- helpers */

/** A prompter that asks nothing: `configureRoles` and the login check read `interactive`. */
function nonInteractive(prompter: Prompter): Prompter {
  const refuse = (message: string): Promise<never> => Promise.reject(new PromptUnavailableError(message));
  return {
    interactive: false,
    confirm: (question) => refuse(question.message),
    input: (question) => refuse(question.message),
    select: (question) => refuse(question.message),
    close: () => prompter.close(),
  };
}

/** Paseo's config for planning; absent or unreadable reads as empty, and the write reports it properly. */
async function readConfigOrEmpty(paseoHome: string, fs: NodeFsApi): Promise<PaseoConfig> {
  try {
    return (await readConfigSnapshot(paseoConfigFile(paseoHome), fs)).config;
  } catch (error) {
    if (isConfigMutationError(error)) return {};
    throw error;
  }
}

/**
 * The name each role already carries in Paseo's config: the `name` of its
 * `bm-<role>` agent profile, else the `label` of its derived provider. A role
 * with neither is left out, so `configureRoles` falls back to the default name.
 */
function registeredRoleNames(config: PaseoConfig): Partial<Record<RoleName, string>> {
  const providers = asObject(asObject(config["agents"])?.["providers"]);
  const profiles = asObject(config["daemon"])?.["agentProfiles"];
  const names: Partial<Record<RoleName, string>> = {};
  for (const role of ROLE_NAMES) {
    const id = roleId(role);
    const profile = Array.isArray(profiles)
      ? asObject(profiles.find((entry) => asObject(entry)?.["id"] === id))
      : undefined;
    const name = nonBlank(profile?.["name"]) ?? nonBlank(asObject(providers?.[id])?.["label"]);
    if (name !== undefined) names[role] = name;
  }
  return names;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * One action per `bm-*` provider and profile. Whether an entry changes is
 * decided by `editConfig` itself, so the preview and the write cannot disagree.
 */
function roleActions(config: PaseoConfig, selections: readonly RoleSelection[]): Action[] {
  const edit = roleRegistrationEdit(selections);
  const changed = new Set(editConfig(config, edit).changedPaths);
  const providers = asObject(asObject(config["agents"])?.["providers"]);
  const profiles = asObject(config["daemon"])?.["agentProfiles"];
  const actions: Action[] = [];

  for (const selection of selections) {
    const id = roleId(selection.role);
    const providerPath = `${PROVIDERS_PATH}.${id}`;
    const providerFrom = providers?.[id];
    actions.push(
      configAction(providerPath, changed.has(providerPath), providerFrom, edit.providers?.[id] ?? null),
    );

    const profilePath = `${AGENT_PROFILES_PATH}[${id}]`;
    const profileFrom = Array.isArray(profiles)
      ? profiles.find((entry) => asObject(entry)?.["id"] === id)
      : undefined;
    const profileTo = (edit.profiles ?? []).find((entry) => entry.id === id) ?? null;
    actions.push(configAction(profilePath, changed.has(profilePath), profileFrom, profileTo));
  }
  return actions;
}

function configAction(key: string, changes: boolean, from: unknown, to: unknown): Action {
  const target = `paseoHome/config.json#${key}`;
  if (!changes) {
    return { kind: "skip", target, location: "paseo-config", reason: "unchanged" };
  }
  return {
    kind: "config",
    target,
    location: "paseo-config",
    reason: from === undefined ? "missing" : "outdated",
    from: (from ?? null) as JsonValue,
    to: to as JsonValue,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function roleReport(entry: RoleRecord, signedIn: boolean | null): RoleReport {
  return { role: entry.role, provider: entry.baseProvider, model: entry.model, paseoTools: entry.paseoTools, loggedIn: signedIn };
}

function loggedIn(report: ProviderLoginReport, provider: string): boolean | null {
  const state = report.providers.find((entry) => entry.provider === provider)?.after;
  return state === "logged-in" ? true : state === "logged-out" ? false : null;
}

/**
 * A backup stamp whose directory holds no config backup yet. The trust-boundary
 * step may have taken one in the same second, and `backupFile` would overwrite
 * it — losing the state from before paseo-bm touched anything.
 */
async function freeBackupStamp(installHome: string, now: Date, fs: NodeFsApi): Promise<string> {
  for (let offset = 0; ; offset += 1) {
    const stamp = backupStamp(new Date(now.getTime() + offset * 1000));
    try {
      await fs.lstat(`${installPaths(installHome).backupDir(stamp)}/${CONFIG_BACKUP_NAME}`);
    } catch {
      return stamp;
    }
  }
}

/** Adds the config backup to `backups[]`, as the trust-boundary step does. */
function withBackup(record: InstallRecord, dir: string, now: Date): InstallRecord {
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
