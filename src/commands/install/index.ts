/**
 * `paseo-bm install` — the end-to-end command flow (bead bm-wp-105-6ec.4;
 * REQ-001(a)(b), REQ-003, REQ-010(b); Technical Design §2.1, §4.1–§4.4, §8,
 * §9.1, §9.3).
 *
 * This file composes modules that already exist and decides nothing they
 * already decide:
 *
 *     layout → preflight → record → plan (read-only)
 *            → roles plan (catalogue, --role existence, questions; read-only)
 *            → preview → [downgrade question] → apply confirmation (default No)
 *            → lock → clean partial payload → re-plan → applier
 *            → plugin registration → trust boundary step
 *            → roles apply (login, bm-* entries, roles[]) → --prune
 *            → skills step → summary
 *
 * Rules the flow is built around:
 *
 * - **The preview is the plan.** Everything before the lock only reads. A run
 *   with no terminal and no `--apply` prints the preview and exits 6 with zero
 *   filesystem writes. Declining the confirmation leaves the disk and Paseo as
 *   they were: nothing is written before the answer, not even the lock file.
 * - **The plan that is applied is the plan that was shown.** Under the lock
 *   the state is re-read and re-planned. When that plan differs from the one
 *   previewed (and the difference is not the announced cleanup of a partial
 *   payload), the new plan is shown and the question is asked again.
 * - **`--yes` only skips the apply confirmation.** It never answers the
 *   downgrade question and never counts as consent to a trust boundary.
 * - **Every registry failure ends in `result.error`** with the exit code of
 *   §4.3, and under `--json` stdout carries exactly one document.
 *
 * Two later beads plug into this flow through {@link InstallSteps}; their
 * defaults here are deliberately inert:
 *
 * - `trustBoundary` — bm-wp-107-2r5.2 (one consent: `pluginsEnabled` and
 *   `daemon.mcp.injectIntoAgents`), implemented in `./enable.ts` and used by
 *   default. `deferredTrustBoundary` stays as an inert step for tests.
 * - `skills` — bm-wp-110-rkw.3 (running the skills CLI after consent). The
 *   default only detects skills and reports them; it never runs anything.
 */

import type { Action, PaseoFacts, PlanReport, ReportError, ReportWarning, RoleReport, SkillsReport } from "../../action.js";
import { isWritingAction } from "../../action.js";
import type { CommandContext, CommandHandler } from "../../cli.js";
import type { ErrorCode } from "../../errors.js";
import { diagnostic } from "../../errors.js";
import type { ExitCode } from "../../exit-codes.js";
import { EXIT_CODES, previewExitCode } from "../../exit-codes.js";
import type { NodeFsApi } from "../../fs-guard.js";
import { nodeFs } from "../../fs-guard.js";
import type { FsOps } from "../../fsops.js";
import { createFsOps } from "../../fsops.js";
import type { Layout } from "../../layout.js";
import { paseoConfigFile, resolveLayout } from "../../layout.js";
import type { AcquireLockOptions, LockHandle } from "../../lock.js";
import { LockError, acquireLock } from "../../lock.js";
import { createDiskReader, installHomeLabel } from "../../ownership.js";
import type { PaseoAdapter, PluginSummary } from "../../paseo/adapter.js";
import { createPaseoAdapter, isPaseoCliError } from "../../paseo/adapter.js";
import { readConfigSnapshot, readMcpInject, readPluginsEnabled } from "../../paseo/config.js";
import { PathGuardError, pathGuardErrorCode } from "../../paths-guard.js";
import type { FsProbe } from "../../preflight.js";
import { runPreflight } from "../../preflight.js";
import type { InstallRecord } from "../../record.js";
import { isRecordError, readRecord } from "../../record.js";
import { createRedactor } from "../../redact.js";
import { writeHumanReport } from "../../report/human.js";
import { writeJsonReport } from "../../report/json.js";
import { assistSkills } from "../../skills/assist.js";
import { detectSkills, skillsChecks, toSkillsByAgent } from "../../skills/detect.js";
import { DEFAULT_SKILLS_SOURCE } from "../doctor.js";
import type { PrunePlan } from "../prune.js";
import { applyPrune, planPrune } from "../prune.js";
import type { ApplyInstallResult } from "./applier.js";
import { applyInstall, findPartialPayloadDirs, removePartialPayloadDirs } from "./applier.js";
import type { PayloadManifest } from "./manifest.js";
import { buildPayloadManifest, findPayloadRoot } from "./manifest.js";
import type { InstallPlan, PaseoSwitchState, PluginRegistrationState } from "./planner.js";
import { DEFAULT_PLUGIN_ID, planInstall } from "./planner.js";
import { enableTrustBoundary } from "./enable.js";
import { isPluginRegistrationError, registerPlugin } from "./register.js";
import type { RolesPlan, RolesStep } from "./roles-step.js";
import { defaultRolesStep } from "./roles-step.js";

/* ------------------------------------------------------------ questions */

/** The apply confirmation. One of the three confirmations counted by M-1. */
export const APPLY_QUESTION = "Apply these changes?";

/** Asked on top of the apply confirmation when the plan needs it; `--yes` never answers it. */
export const DOWNGRADE_QUESTION = "Install an older paseo-bm over the newer one that is installed?";

/** Design §3.3: a user-modified file is kept unless the user decides otherwise. */
export const OVERWRITE_QUESTION = "Overwrite the files you changed? A backup of each is taken first.";

/* ---------------------------------------------------------------- steps */

/** What a step that runs after the plugin is registered gets to see. */
export interface InstallStepInput {
  readonly context: CommandContext;
  /** False under `--json` or without a terminal: a step must not ask then. */
  readonly interactive: boolean;
  readonly adapter: PaseoAdapter;
  readonly layout: Layout;
  readonly installHome: string;
  readonly paseoHome: string;
  /** The record as it is on disk right now. */
  readonly record: InstallRecord;
  /** Bound to the install home, on the same filesystem seam as the run. */
  readonly fsops: FsOps;
  readonly fs: NodeFsApi;
  /** What Paseo reported for the plugin after registration; `null` if unknown. */
  readonly plugin: PluginSummary | null;
  /** The two switches, as read before anything was written. */
  readonly switches: PaseoSwitchState;
  readonly now: Date;
}

/** Result of the trust-boundary step (bm-wp-107-2r5.2). */
export interface TrustBoundaryOutcome {
  /** True when both switches are on at the end of the step. False → exit 4. */
  readonly consented: boolean;
  /** The record after the step; return the input unchanged when nothing was written. */
  readonly record: InstallRecord;
  /** Paseo's `status` after the step, when it re-read it; `null` keeps the registration's. */
  readonly pluginState: string | null;
  /** `pluginsEnabled` after the step. */
  readonly pluginsEnabled: boolean;
  readonly warnings: readonly ReportWarning[];
  /** Backup directories this step took (relative to the install home); `--prune` keeps them. */
  readonly backupDirs: readonly string[];
  /** Lines for the user, printed to stderr after the report. */
  readonly notes: readonly string[];
  /** A registry failure the command reports in `result.error` with this exit code. */
  readonly failure?: { readonly exitCode: ExitCode; readonly code: ErrorCode; readonly detail: string };
}

export type TrustBoundaryStep = (input: InstallStepInput) => Promise<TrustBoundaryOutcome>;

/** What the skills step gets: `apply` is false for a preview, where it must only observe. */
export interface SkillsStepInput {
  readonly context: CommandContext;
  readonly interactive: boolean;
  readonly apply: boolean;
  readonly layout: Layout;
  readonly record: InstallRecord | undefined;
  readonly fs: NodeFsApi;
}

export interface SkillsStepOutcome {
  /** `null` when `--skip-skills-check` removed the step (Design §4.4). */
  readonly skills: SkillsReport | null;
  /** Warnings never change the exit code (Design §4.3). */
  readonly warnings: readonly ReportWarning[];
  readonly notes: readonly string[];
}

export type SkillsStep = (input: SkillsStepInput) => Promise<SkillsStepOutcome>;

/** The seams later beads fill in. */
export interface InstallSteps {
  readonly trustBoundary?: TrustBoundaryStep;
  readonly skills?: SkillsStep;
  /** bm-wp-107-2r5.4: roles decided before the preview, registered after the trust boundary. */
  readonly roles?: RolesStep;
}

/**
 * Default trust-boundary step until bm-wp-107-2r5.2 lands: asks nothing,
 * writes nothing, and reports consent only when both switches are already on.
 * `--yes` plays no part in the answer.
 */
export const deferredTrustBoundary: TrustBoundaryStep = (input) => {
  const on = input.switches.pluginsEnabled === true && input.switches.injectIntoAgents === true;
  return Promise.resolve({
    consented: on,
    record: input.record,
    pluginState: null,
    pluginsEnabled: input.switches.pluginsEnabled === true,
    warnings: [],
    backupDirs: [],
    notes: on
      ? []
      : [
          "Plugins are not enabled, or Paseo tools are not granted to agents, so the plugin will not run yet.",
          "Enabling both is one consent: run `npx paseo-bm install --apply --enable-plugins`.",
        ],
  });
};

/**
 * Default skills step until bm-wp-110-rkw.3 lands: reads the three agent
 * directories and reports. Never runs the skills CLI.
 */
export const detectOnlySkills: SkillsStep = async (input) => {
  if (input.context.flags.skipSkillsCheck) {
    return { skills: null, warnings: [], notes: [] };
  }
  const detection = await detectSkills(input.layout);
  const missing = skillsChecks(detection).some((check) => check.severity === "warn");
  return {
    skills: {
      source: DEFAULT_SKILLS_SOURCE,
      required: detection.required,
      byAgent: toSkillsByAgent(detection),
      suggestedCommand: null,
      assisted: input.record?.skills.lastCommand != null,
      outcome: input.record?.skills.assistOutcome ?? null,
    },
    warnings: missing ? [{ code: "W_SKILLS_MISSING" }] : [],
    notes: [],
  };
};

/* -------------------------------------------------------------- options */

export interface InstallOptions {
  readonly context: CommandContext;
  /** Defaults to the real `paseo` CLI with the invocation's environment. */
  readonly adapter?: PaseoAdapter;
  /** Home directory for layout resolution; integration tests pass a fake `$HOME`. */
  readonly homeDir?: string;
  readonly cwd?: string;
  /** Filesystem seam for every write; tests pass the guarded one. */
  readonly fs?: NodeFsApi;
  /** Read-only probe for preflight. */
  readonly probe?: FsProbe;
  readonly platform?: NodeJS.Platform;
  readonly nodeVersion?: string;
  /** Directory the payload is copied from. Defaults to the package's `plugin/`. */
  readonly payloadRoot?: string;
  readonly now?: () => Date;
  /** Passed through to `acquireLock`. */
  readonly lock?: AcquireLockOptions;
  readonly steps?: InstallSteps;
}

export interface InstallOutcome {
  readonly report: PlanReport;
  readonly exitCode: ExitCode;
  /** True once the applier ran. */
  readonly applied: boolean;
  /** Human lines for stderr: remediation, conflict hints, next steps. */
  readonly notes: readonly string[];
}

/* ------------------------------------------------------------ the flow */

class Stop {
  constructor(readonly exitCode: ExitCode, readonly error: ReportError | undefined, readonly notes: readonly string[]) {}
}

function registryError(code: ErrorCode, detail?: string): ReportError {
  const entry = diagnostic(code);
  return { code, message: detail === undefined || detail === entry.message ? entry.message : `${entry.message} ${detail}` };
}

function stop(exitCode: ExitCode, code: ErrorCode | undefined, detail?: string, extraNotes: readonly string[] = []): Stop {
  if (code === undefined) {
    return new Stop(exitCode, undefined, [...(detail === undefined ? [] : [detail]), ...extraNotes]);
  }
  return new Stop(exitCode, registryError(code, detail), [diagnostic(code).remediation, ...extraNotes]);
}

function errno(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Runs the whole flow and returns the report; renders nothing except the interactive preview. */
export async function runInstall(options: InstallOptions): Promise<InstallOutcome> {
  const { context } = options;
  const flags = context.flags;
  const fs = options.fs ?? nodeFs;
  const clock = options.now ?? (() => new Date());
  const adapter = options.adapter ?? createPaseoAdapter({ env: context.env as NodeJS.ProcessEnv });
  const trustBoundary = options.steps?.trustBoundary ?? enableTrustBoundary;
  const skillsStep = options.steps?.skills ?? assistSkills;
  const rolesStep = options.steps?.roles ?? defaultRolesStep;
  // Under --json stdout belongs to one document, and a question would be
  // written into it, so a --json run never asks.
  const interactive = context.tty.interactive && context.prompter.interactive && !flags.json;

  const warnings: ReportWarning[] = [];
  const notes: string[] = [];
  let paseo: PaseoFacts = { cliVersion: null, daemonVersion: null, home: null, pluginsEnabled: false };
  let actions: readonly Action[] = [];
  let roles: readonly RoleReport[] = [];
  let skills: SkillsReport | null = null;
  let pluginState: string | null = null;
  let mode: PlanReport["mode"] = "preview";
  let applied = false;

  const finish = (exitCode: ExitCode, error?: ReportError): InstallOutcome => ({
    report: {
      schemaVersion: 1,
      command: "install",
      mode,
      paseoBmVersion: context.version,
      paseo,
      actions,
      roles,
      skills,
      warnings,
      result: error === undefined ? { exitCode, pluginState } : { exitCode, pluginState, error },
    },
    exitCode,
    applied,
    notes,
  });

  const observeSkills = async (layout: Layout, record: InstallRecord | undefined, apply: boolean): Promise<void> => {
    const outcome = await skillsStep({ context, interactive, apply, layout, record, fs });
    skills = outcome.skills;
    warnings.push(...outcome.warnings);
    notes.push(...outcome.notes);
  };

  try {
    /* -- 1. layout: refuse a dangerous install home before anything else -- */
    const baseLayout = resolveOrStop(() =>
      resolveLayout({ flags: context.homes, env: context.env, homeDir: options.homeDir, cwd: options.cwd }),
    );

    /* -- 2. preflight: nothing is written when it fails ------------------- */
    const preflight = await runPreflight({
      adapter,
      installHome: baseLayout.installHome.path,
      env: context.env,
      ...(options.probe === undefined ? {} : { fs: options.probe }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.nodeVersion === undefined ? {} : { nodeVersion: options.nodeVersion }),
    });
    warnings.push(...preflight.warnings);
    paseo = {
      cliVersion: preflight.facts.cliVersion,
      daemonVersion: preflight.facts.daemonVersion,
      home: preflight.facts.paseoHome,
      pluginsEnabled: false,
    };
    if (!preflight.ok || preflight.failure !== null) {
      const failure = preflight.failure;
      if (failure === null) throw stop(EXIT_CODES.preflight, "E_DAEMON_UNREACHABLE");
      throw new Stop(EXIT_CODES.preflight, { code: failure.code, message: failure.message }, [failure.remediation]);
    }

    // Paseo's own answer is the source of truth for its home (ADR-004), below flag and env.
    const layout = resolveOrStop(() =>
      resolveLayout({
        flags: context.homes,
        env: context.env,
        homeDir: options.homeDir,
        cwd: options.cwd,
        daemonPaseoHome: preflight.facts.paseoHome ?? undefined,
      }),
    );
    const installHome = layout.installHome.path;
    const paseoHome = layout.paseoHome.path;
    paseo = { ...paseo, home: paseoHome };

    /* -- 3. read the current state; still no writes ------------------------ */
    const readOps = createFsOps({ root: installHome, fs });
    const record0 = await loadRecordOrStop(readOps);
    roles = rolesOf(record0);

    const manifest = await buildPayloadManifest(options.payloadRoot ?? findPayloadRoot());
    const listed = await listPluginOrStop(adapter);
    pluginState = listed?.status ?? null;
    const registration: PluginRegistrationState = {
      pluginId: DEFAULT_PLUGIN_ID,
      dir: listed === null ? null : (listed.path ?? record0?.paseo.pluginDir ?? null),
    };
    const switches = await readSwitches(paseoHome, fs);
    paseo = { ...paseo, pluginsEnabled: switches.pluginsEnabled === true };

    let force = flags.force;
    const makePlan = (record: InstallRecord | undefined, fsops: FsOps): Promise<InstallPlan> =>
      planInstall({
        installHome,
        version: context.version,
        payload: manifest.files,
        record,
        reader: createDiskReader({ fsops, fs }),
        switches,
        registration,
        force,
      });

    let plan = await makePlan(record0, readOps);
    const partial = await findPartialPayloadDirs({ installHome, record: record0, fsops: readOps, fs });
    const mayApply = flags.apply || interactive;
    const prunePreview = async (base: InstallPlan): Promise<PrunePlan | null> =>
      flags.prune
        ? planPrune({
            prune: true,
            record: record0 === undefined ? undefined : asIfRegistered(record0, base, installHome),
            fsops: readOps,
            fs,
            keepVersions: [base.version],
          })
        : null;
    let pruned = await prunePreview(plan);

    /* -- 3b. roles: catalogue, --role existence, decision; still no writes -- */
    // Decided before the preview so the preview lists what will be registered,
    // and so E_PROVIDER_UNAVAILABLE stops the run before anything is written.
    const rolesPlanned = await rolesStep.plan({ context, interactive, adapter, paseoHome, fs, record: record0 });
    if (!rolesPlanned.ok) {
      throw stop(rolesPlanned.failure.exitCode, rolesPlanned.failure.code, rolesPlanned.failure.detail);
    }
    const rolesPlan: RolesPlan = rolesPlanned.plan;
    roles = rolesPlan.roles;
    notes.push(...rolesPlan.notes);
    actions = [...plan.actions, ...rolesPlan.actions, ...(pruned?.actions ?? [])];

    if (partial.length > 0) {
      notes.push(
        `Left over from an interrupted run and not in install.json: ${partial.join(", ")}. ` +
          (flags.apply || interactive
            ? "It is removed before the payload is copied when the changes are applied."
            : "Re-run with --apply to remove it; a preview never deletes anything."),
      );
    }

    /* -- 4. no terminal and no --apply: print the preview, exit 6 ---------- */
    if (!flags.apply && !interactive) {
      conflictNotes(plan, partial, record0).forEach((line) => notes.push(line));
      notes.push("Nothing was written. Re-run with --apply to install.");
      await observeSkills(layout, record0, false);
      return finish(previewExitCode({ interactive: false, apply: false }));
    }

    /* -- 5. decisions: conflicts, downgrade, confirmation ------------------ */
    let previewShown = false;
    const showPreview = (): void => {
      if (!interactive) return;
      const preview = finish(previewExitCode({ interactive, apply: flags.apply })).report;
      writeHumanReport(preview, context.stdout);
      previewShown = true;
    };

    let blocking = blockingConflicts(plan, mayApply ? partial : []);
    if (blocking.length > 0) {
      const onlyUserModified = blocking.every((action) => action.reason === "user-modified");
      if (interactive && !force && onlyUserModified) {
        showPreview();
        const overwrite = await context.prompter.confirm({
          message: OVERWRITE_QUESTION,
          defaultValue: false,
          details: blocking.map((action) => `  ${action.target}`),
        });
        if (overwrite) {
          force = true;
          plan = await makePlan(record0, readOps);
          pruned = await prunePreview(plan);
          actions = [...plan.actions, ...rolesPlan.actions, ...(pruned?.actions ?? [])];
          blocking = blockingConflicts(plan, partial);
          previewShown = false;
        }
      }
      if (blocking.length > 0) {
        throw stop(EXIT_CODES.conflict, "E_CONFLICT", describeConflicts(blocking), conflictNotes(plan, partial, record0));
      }
    }

    if (plan.requiresConfirmation) {
      if (!interactive) {
        throw stop(
          EXIT_CODES.conflict,
          undefined,
          `The installed paseo-bm is ${plan.installedVersion ?? "unknown"} and this one is ${plan.version}; ` +
            "installing it needs an explicit answer on a terminal, and --yes does not give one. Nothing was written.",
        );
      }
      if (!previewShown) showPreview();
      const downgrade = await context.prompter.confirm({
        message: DOWNGRADE_QUESTION,
        defaultValue: false,
        details: [`Installed: ${plan.installedVersion ?? "unknown"}. This package: ${plan.version}.`],
      });
      if (!downgrade) {
        notes.push("Nothing was written.");
        await observeSkills(layout, record0, false);
        return finish(previewExitCode({ interactive, apply: flags.apply }));
      }
    }

    // REQ-009: a re-run with nothing to write asks no apply confirmation. The
    // state is re-planned under the lock below; if it changed in between, the
    // new plan is shown and the question is asked after all.
    const nothingToWrite = partial.length === 0 && !actions.some((action) => isWritingAction(action));
    const confirmationSkipped = interactive && !flags.yes && nothingToWrite;
    if (interactive && !flags.yes && !nothingToWrite) {
      if (!previewShown) showPreview();
      if (!(await context.prompter.confirm({ message: APPLY_QUESTION, defaultValue: false }))) {
        notes.push("Nothing was written.");
        await observeSkills(layout, record0, false);
        return finish(previewExitCode({ interactive, apply: flags.apply }));
      }
    }

    /* -- 6. apply, under the lock ----------------------------------------- */
    let lock: LockHandle;
    try {
      lock = acquireLock(installHome, { command: "install", ...options.lock });
    } catch (error) {
      if (error instanceof LockError) throw stop(EXIT_CODES.preflight, "E_LOCKED", error.message);
      throw error;
    }

    try {
      const fsops = createFsOps({ root: installHome, fs });
      const record1 = await loadRecordOrStop(fsops);
      // Carry-over from the applier bead: a half-written plugin/<same version>/
      // must go before planning, or the planner reports it as a conflict.
      const removed = await removePartialPayloadDirs({ installHome, record: record1, fsops, fs });
      let plan1 = await makePlan(record1, fsops);

      if ((previewShown || confirmationSkipped) && removed.length === 0 && !sameActions(plan, plan1)) {
        notes.push("The install home changed after the preview was shown; the new plan is shown below.");
        plan = plan1;
        pruned = await prunePreview(plan);
        actions = [...plan.actions, ...rolesPlan.actions, ...(pruned?.actions ?? [])];
        showPreview();
        if (!(await context.prompter.confirm({ message: APPLY_QUESTION, defaultValue: false }))) {
          notes.push("Nothing was written.");
          return finish(previewExitCode({ interactive, apply: flags.apply }));
        }
        plan1 = await makePlan(await loadRecordOrStop(fsops), fsops);
      }
      if (plan1.conflicts.length > 0) {
        actions = plan1.actions;
        throw stop(EXIT_CODES.conflict, "E_CONFLICT", describeConflicts(plan1.conflicts), conflictNotes(plan1, [], record1));
      }

      let result: ApplyInstallResult;
      try {
        result = await applyInstall({
          plan: plan1,
          payload: manifest as PayloadManifest,
          record: record1,
          installHome,
          paseoHome,
          fsops,
          fs,
          now: clock(),
        });
      } catch (error) {
        throw writeFailure(error);
      }
      applied = true;
      mode = "applied";
      actions = plan1.actions;
      let record = result.record;
      roles = rolesOf(record);

      /* -- 7. plugin registration ---------------------------------------- */
      let plugin: PluginSummary | null = listed;
      const daemonAction = plan1.actions.find((action) => action.location === "paseo-daemon");
      const active = record.versions.some((entry) => entry.version === plan1.version && entry.active);
      if ((daemonAction !== undefined && isWritingAction(daemonAction)) || record.paseo.pluginId === null || !active) {
        try {
          const registered = await registerPlugin({ adapter, fsops, record, version: plan1.version, now: clock() });
          record = registered.record;
          plugin = registered.plugin;
          pluginState = registered.plugin.status;
        } catch (error) {
          if (isPluginRegistrationError(error) && error.code !== undefined) {
            pluginState = error.status ?? null;
            throw stop(EXIT_CODES.pluginLoadFailed, error.code, error.message);
          }
          if (isPaseoCliError(error)) {
            // Files are already installed, so 3 ("nothing was written") would be false.
            throw stop(EXIT_CODES.pluginLoadFailed, error.code, error.message);
          }
          throw error;
        }
      }

      /* -- 8. trust boundary (bm-wp-107-2r5.2) --------------------------- */
      const trust = await trustBoundary({
        context,
        interactive,
        adapter,
        layout,
        installHome,
        paseoHome,
        record,
        fsops,
        fs,
        plugin,
        switches,
        now: clock(),
      });
      record = trust.record;
      pluginState = trust.pluginState ?? pluginState;
      paseo = { ...paseo, pluginsEnabled: trust.pluginsEnabled };
      warnings.push(...trust.warnings);
      notes.push(...trust.notes);
      if (trust.failure !== undefined) {
        throw stop(trust.failure.exitCode, trust.failure.code, trust.failure.detail);
      }

      /* -- 8b. roles (bm-wp-107-2r5.4): login, bm-* entries, roles[] ------ */
      const rolesApplied = await rolesStep.apply({
        context,
        interactive,
        adapter,
        installHome,
        paseoHome,
        fsops,
        fs,
        record,
        plan: rolesPlan,
        now: clock(),
      });
      record = rolesApplied.record;
      roles = rolesApplied.roles;
      actions = [...actions, ...rolesApplied.actions];
      warnings.push(...rolesApplied.warnings);
      notes.push(...rolesApplied.notes);
      if (rolesApplied.failure !== undefined) {
        throw stop(rolesApplied.failure.exitCode, rolesApplied.failure.code, rolesApplied.failure.detail);
      }

      /* -- 9. --prune, after registration has fixed the active version --- */
      if (flags.prune) {
        const prunePlan = await planPrune({
          prune: true,
          record,
          fsops,
          fs,
          keepVersions: [plan1.version],
          keepBackups: [
            ...(result.backup === null ? [] : [result.backup.dir]),
            ...trust.backupDirs,
            ...rolesApplied.backupDirs,
          ],
        });
        const prunedResult = await applyPrune({ plan: prunePlan, record, fsops, fs, now: clock() });
        record = prunedResult.record ?? record;
        actions = [...actions, ...prunePlan.actions];
      }

      /* -- 10. skills (bm-wp-110-rkw.3) ----------------------------------- */
      await observeSkills(layout, record, true);

      return finish(trust.consented ? EXIT_CODES.ok : EXIT_CODES.consentMissing);
    } finally {
      lock.release();
    }
  } catch (caught) {
    if (caught instanceof Stop) {
      notes.push(...caught.notes);
      return finish(caught.exitCode, caught.error);
    }
    throw caught;
  }
}

/* ------------------------------------------------------------- helpers */

function resolveOrStop(resolveIt: () => Layout): Layout {
  try {
    return resolveIt();
  } catch (error) {
    if (error instanceof PathGuardError) {
      throw stop(EXIT_CODES.preflight, pathGuardErrorCode(error.reason), error.message);
    }
    throw error;
  }
}

async function loadRecordOrStop(fsops: FsOps): Promise<InstallRecord | undefined> {
  try {
    return await readRecord(fsops);
  } catch (error) {
    if (isRecordError(error)) {
      // Only `schema-too-new` has a registry code; a damaged record still stops
      // the run before any write, because it is the only evidence of ownership.
      throw error.code === undefined
        ? stop(EXIT_CODES.preflight, undefined, error.message)
        : stop(EXIT_CODES.preflight, error.code, error.message);
    }
    throw error;
  }
}

async function listPluginOrStop(adapter: PaseoAdapter): Promise<PluginSummary | null> {
  try {
    const plugins = await adapter.pluginList();
    return plugins.find((plugin) => plugin.id === DEFAULT_PLUGIN_ID) ?? null;
  } catch (error) {
    if (isPaseoCliError(error)) throw stop(EXIT_CODES.preflight, error.code, error.message);
    throw error;
  }
}

/** The two switches; an absent or unreadable config means "off" (ADR-004). */
async function readSwitches(paseoHome: string, fs: NodeFsApi): Promise<PaseoSwitchState> {
  try {
    const snapshot = await readConfigSnapshot(paseoConfigFile(paseoHome), fs);
    return { pluginsEnabled: readPluginsEnabled(snapshot.config).value, injectIntoAgents: readMcpInject(snapshot.config).value };
  } catch {
    return { pluginsEnabled: null, injectIntoAgents: null };
  }
}

function rolesOf(record: InstallRecord | undefined): readonly RoleReport[] {
  return (record?.roles ?? []).map((entry) => ({
    role: entry.role,
    provider: entry.baseProvider,
    model: entry.model,
    paseoTools: entry.paseoTools,
    loggedIn: null,
  }));
}

/** Conflicts that stop the run, leaving out those a partial-payload cleanup will remove. */
function blockingConflicts(plan: InstallPlan, cleaned: readonly string[]): readonly Action[] {
  const prefixes = cleaned.map((dir) => `${installHomeLabel(dir)}/`);
  return plan.conflicts.filter((action) => !prefixes.some((prefix) => action.target.startsWith(prefix)));
}

function describeConflicts(conflicts: readonly Action[]): string {
  const shown = conflicts.slice(0, 5).map((action) => `${action.target} (${action.reason})`);
  const more = conflicts.length > shown.length ? `, and ${String(conflicts.length - shown.length)} more` : "";
  return `In the way: ${shown.join(", ")}${more}.`;
}

/** Carry-over (2) of the applier bead: explain a payload left by an interrupted first install. */
function conflictNotes(plan: InstallPlan, partial: readonly string[], record: InstallRecord | undefined): string[] {
  if (plan.conflicts.length === 0) return [];
  const versionPrefix = `${installHomeLabel(plan.versionDir)}/`;
  const inVersionDir = plan.conflicts.some((action) => action.target.startsWith(versionPrefix));
  const lines: string[] = [];
  if (record === undefined && inVersionDir) {
    lines.push(
      `${plan.versionDir}/ exists but there is no install.json, so paseo-bm cannot prove it wrote it. ` +
        "If it was left by an interrupted first install, delete that directory yourself and run the command again.",
    );
  }
  if (plan.conflicts.some((action) => action.reason === "user-modified")) {
    lines.push("Files you changed are kept. Re-run with --force to overwrite them; a backup is taken first.");
  }
  if (partial.length > 0 && lines.length === 0) {
    lines.push("The conflicts inside the leftover directory disappear once it is removed by --apply.");
  }
  return lines;
}

/** The record as it will look once this version is registered, for a read-only prune preview. */
function asIfRegistered(record: InstallRecord, plan: InstallPlan, installHome: string): InstallRecord {
  const known = record.versions.some((entry) => entry.version === plan.version);
  const versions = [
    ...record.versions.map((entry) => ({ ...entry, active: entry.version === plan.version })),
    ...(known ? [] : [{ version: plan.version, dir: plan.versionDir, installedAt: record.updatedAt, active: true }]),
  ];
  return { ...record, versions, paseo: { ...record.paseo, pluginDir: `${installHome}/${plan.versionDir}` } };
}

function sameActions(left: InstallPlan, right: InstallPlan): boolean {
  return JSON.stringify(left.actions) === JSON.stringify(right.actions);
}

/** A failure while writing the payload, mapped onto the registry where a code exists. */
function writeFailure(error: unknown): unknown {
  if (error instanceof PathGuardError) {
    return stop(EXIT_CODES.preflight, pathGuardErrorCode(error.reason), error.message);
  }
  const code = errno(error);
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return stop(EXIT_CODES.preflight, "E_TARGET_NOT_WRITABLE", error instanceof Error ? error.message : String(error));
  }
  return error;
}

/* ---------------------------------------------------------- CLI wiring */

/** Builds the handler, with dependencies a test can replace. */
export function createInstallCommand(deps: Omit<InstallOptions, "context"> = {}): CommandHandler {
  return async (context: CommandContext): Promise<number> => {
    const outcome = await runInstall({ ...deps, context });
    if (context.flags.json) {
      writeJsonReport(outcome.report, context.stdout);
    } else {
      writeHumanReport(outcome.report, context.stdout);
    }
    if (outcome.notes.length > 0) {
      const redact = createRedactor({ env: context.env });
      context.stderr(redact(`${outcome.notes.join("\n")}\n`));
    }
    return outcome.exitCode;
  };
}

/** The handler `src/index.ts` routes `install` (and a bare `paseo-bm`) to. */
export const installCommand: CommandHandler = createInstallCommand();
