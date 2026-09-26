/**
 * The one thing `paseo-bm` 0.4.0 does: move an install made by an earlier
 * `npx paseo-bm` to the plugin on npm (Technical Design §4.3–§4.6; ADR-012
 * decision 7).
 *
 * The order of writes is the whole safety story, and it is never inverted:
 *
 * 1. **Step 0, before Paseo is touched at all.** The pointer that tells the
 *    plugin where a non-default data folder is, and the carry-over of "paseo-bm
 *    turned Paseo's agent tools on". Both files are invisible to a 0.3.x
 *    plugin, so writing them first is free: if everything after fails, they
 *    change nothing for anybody.
 * 2. **Paseo second** — remove the directory plugin, add the npm one, wait for
 *    it. A failure here puts the directory install back, and the record still
 *    says `schemaVersion: 1`, so the machine is exactly where it started.
 * 3. **`install.json` last, and only on success.** Stamping `schemaVersion: 2`
 *    is what stops a 0.3.x build ever "re-installing" a directory plugin over
 *    the npm one: it reads 2, does not understand it, and exits 3. Writing that
 *    mark before the switch succeeded would strand the user on a build that
 *    refuses to help them.
 *
 * Nothing here deletes anything: no data, no role, no switch, no old payload.
 * The user's traces, `ui/`, `role-*.json`, `plugin/<ver>/` and `backups/` are
 * all still there afterwards, and the plugin reads the first three in place.
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import type { Action, MigrateReport, PaseoFacts, ReportResult } from "../action.js";
import type { CommandContext, CommandHandler } from "../cli.js";
import { diagnostic, isErrorCode, type DiagnosticCode, type ErrorCode, type WarningCode } from "../errors.js";
import { writeJsonReport } from "../report/json.js";
import { EXIT_CODES } from "../exit-codes.js";
import { createFsOps, FILE_MODE, type FsOps } from "../fsops.js";
import { acquireLock, LockError, type LockHandle } from "../lock.js";
import type { NodeFsApi } from "../fs-guard.js";
import { DEFAULT_DIR_NAMES, installPaths, resolveLayout } from "../layout.js";
import type { PaseoAdapter, PluginSummary } from "../paseo/adapter.js";
import {
  createPaseoAdapter,
  isPaseoCliError,
  paseoFailureDetail,
  parseJsonOutput,
  parsePluginSummary,
  PLUGIN_STATUS_DISABLED,
  PLUGIN_STATUS_RUNNING,
} from "../paseo/adapter.js";
import { isRecordError, readRecord, writeRecord, MIGRATED_RECORD_SCHEMA_VERSION, type InstallRecord } from "../record.js";
import { runPreflight } from "../preflight.js";

/** What the report says about Paseo when the run stopped before it could ask. */
const UNKNOWN_PASEO: PaseoFacts = { cliVersion: null, daemonVersion: null, home: null, pluginsEnabled: false };

/** The plugin id paseo-bm has always registered with Paseo. */
export const PLUGIN_ID = "paseo-bm";

/** The npm package the plugin now lives in. */
export const PLUGIN_PACKAGE = "paseo-bm-plugin";

/** `paseo plugin add npm:…` fetches from the network, so it gets its own deadline. */
export const PLUGIN_ADD_TIMEOUT_MS = 120_000;

/** How long the new plugin has to reach a registered status, and how often it is asked. */
export const PLUGIN_RUNNING_TIMEOUT_MS = 30_000;
export const PLUGIN_POLL_INTERVAL_MS = 500;

/** The one question the migration asks, defaulting to No like every other apply. */
export const MIGRATE_QUESTION = "Switch this install to the plugin on npm?";

/** What the run did, as the `--json` report names it. */
export type MigrationOutcome =
  | "migrated"
  | "already-npm"
  | "no-directory-install"
  | "not-ours"
  | "fell-back"
  | "fallback-failed"
  | "remove-failed";

/** Which of design §4.3's cases this machine is in. */
export type MigrationCase = "A" | "B" | "C" | "D" | "E";

export interface MigrationPlan {
  readonly case: MigrationCase;
  /** The directory Paseo currently loads the plugin from, when it is a directory install. */
  readonly from: string | null;
  /** `npm:paseo-bm-plugin@<version>`. */
  readonly to: string;
  /** Why nothing can be done, for the cases that do nothing. */
  readonly reason: string | null;
}

export interface MigrateResult {
  readonly exitCode: number;
  /** What Paseo said about itself, for the report. */
  readonly paseo?: PaseoFacts;
  readonly outcome: MigrationOutcome;
  readonly plan: MigrationPlan;
  readonly actions: readonly Action[];
  readonly warnings: readonly WarningCode[];
  readonly pluginState: string | null;
  readonly error: string | null;
  /**
   * The failing error's own registry code, when it has one.
   *
   * Design §4.3 asks a failed `plugin ls` to report the `PaseoCliError`'s code,
   * not a code invented from the outcome: "the daemon did not answer" and "we
   * refuse to touch someone else's plugin" are different problems.
   */
  readonly code?: ErrorCode;
  readonly fallback: { outcome: "fell-back" | "fallback-failed"; detail: string } | null;
}

/** `paseo plugin add npm:<package>@<version> --id <id> --json`. */
export function pluginAddArgs(version: string, pluginId: string = PLUGIN_ID): string[] {
  return ["plugin", "add", `npm:${PLUGIN_PACKAGE}@${version}`, "--id", pluginId, "--json"];
}

/** `paseo plugin install <dir> --id <id> --json`, the fallback's command. */
export function pluginInstallArgs(directory: string, pluginId: string = PLUGIN_ID): string[] {
  return ["plugin", "install", directory, "--id", pluginId, "--json"];
}

/** True when `candidate` is `root` itself or lives underneath it, lexically. */
function isInside(root: string, candidate: string): boolean {
  const from = resolve(root);
  const to = resolve(candidate);
  if (from === to) return true;
  const rel = relative(from, to);
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * How Paseo describes where a plugin came from, when it says so at all.
 *
 * `pluginPath` is relative in Paseo's answer and is deliberately not read: case
 * B is decided by `kind` and `packageName` alone (design §13, Q-047).
 */
export interface PluginIdentity {
  readonly kind: string | undefined;
  readonly packageName: string | undefined;
}

export function identityOf(plugin: PluginSummary): PluginIdentity {
  const raw = plugin.raw;
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const installation = record?.["installation"];
  const identity =
    installation !== null && typeof installation === "object"
      ? ((installation as Record<string, unknown>)["identity"] as Record<string, unknown> | undefined)
      : undefined;
  const value = (key: string): string | undefined => {
    const found = identity?.[key];
    return typeof found === "string" && found.trim() !== "" ? found : undefined;
  };
  return { kind: value("kind"), packageName: value("packageName") };
}

export interface ClassifyInput {
  /** The `paseo-bm` entry of `paseo plugin ls --json`, or `undefined`. */
  readonly plugin: PluginSummary | undefined;
  /** `<install home>/plugin`. */
  readonly pluginRoot: string;
  /** The install record, or `undefined` when there is none. */
  readonly record: InstallRecord | undefined;
  readonly version: string;
  readonly installHome: string;
}

/**
 * Which case of design §4.3 this machine is in.
 *
 * Deliberately lexical: `path.resolve` only, never `realpath`. Paseo stores the
 * string the installer handed it, and comparing canonical paths would call a
 * symlinked install home "not ours" on a machine where nothing is wrong.
 */
export function classify(input: ClassifyInput): MigrationPlan {
  const to = `npm:${PLUGIN_PACKAGE}@${input.version}`;
  const plugin = input.plugin;

  if (plugin === undefined) {
    return { case: "D", from: null, to, reason: null };
  }

  const identity = identityOf(plugin);
  if (identity.kind === "npm") {
    return identity.packageName === PLUGIN_PACKAGE
      ? { case: "B", from: null, to, reason: null }
      : {
          case: "E",
          from: null,
          to,
          reason: `Paseo's \`${PLUGIN_ID}\` plugin comes from the npm package \`${identity.packageName ?? "unknown"}\`, which paseo-bm did not install.`,
        };
  }
  if (identity.kind !== undefined && identity.kind !== "directory") {
    return {
      case: "E",
      from: null,
      to,
      reason: `Paseo's \`${PLUGIN_ID}\` plugin has installation kind \`${identity.kind}\`, which paseo-bm did not install.`,
    };
  }

  const from = plugin.path;
  if (from === undefined) {
    return { case: "E", from: null, to, reason: `Paseo reports no source directory for the \`${PLUGIN_ID}\` plugin.` };
  }
  if (!isInside(input.pluginRoot, from)) {
    return {
      case: "C",
      from,
      to,
      reason:
        `Paseo loads \`${PLUGIN_ID}\` from ${from}, which is not inside ${input.pluginRoot}. ` +
        "paseo-bm did not install it, so it will not remove it. If your install home is elsewhere, name it with --home <dir>.",
    };
  }
  if (input.record === undefined) {
    return {
      case: "C",
      from,
      to,
      reason:
        `Paseo loads \`${PLUGIN_ID}\` from ${from}, but there is no install.json in ${input.installHome} to say paseo-bm put it there. ` +
        "If your install home is elsewhere, name it with --home <dir>.",
    };
  }
  if (input.record.schemaVersion === MIGRATED_RECORD_SCHEMA_VERSION) {
    return {
      case: "E",
      from,
      to,
      reason:
        "This install was already switched once; Paseo shows a directory install again. " +
        `Nothing was changed. Look at \`paseo plugin ls\`, then install the plugin yourself with: paseo plugin add npm:${PLUGIN_PACKAGE}`,
    };
  }
  return { case: "A", from, to, reason: null };
}

/** The pointer the plugin reads when the data folder is not `~/.paseo-bm`. */
export function pointerDocument(home: string, version: string, at: Date): string {
  return `${JSON.stringify(
    { schemaVersion: 1, home, writtenBy: `paseo-bm@${version}`, at: at.toISOString() },
    null,
    2,
  )}\n`;
}

/** The `agentTools` mark, in the shape `plugin/server/setup-state.ts` reads. */
export function setupStateWithAgentTools(existing: unknown, previous: boolean, at: Date): string | null {
  const record = existing !== null && typeof existing === "object" && !Array.isArray(existing)
    ? (existing as Record<string, unknown>)
    : undefined;
  if (record !== undefined) {
    const version = record["schemaVersion"];
    // A newer plugin owns the file; the mark is not worth overwriting it.
    if (typeof version === "number" && version > 1) return null;
    if (record["agentTools"] !== undefined && record["agentTools"] !== null) return null;
  }
  const next = {
    schemaVersion: 1,
    agentTools: { setBy: "installer", previous, at: at.toISOString() },
    rolesCreated: record?.["rolesCreated"] ?? null,
    skillsRun: record?.["skillsRun"] ?? null,
    cleanedUpAt: record?.["cleanedUpAt"] ?? null,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export interface MigrateDeps {
  /** With `--json`, stdout carries one document and nothing else. */
  readonly quiet?: boolean;
  readonly adapter?: PaseoAdapter;
  readonly fs?: NodeFsApi;
  readonly now?: () => Date;
  /** Overridden in tests so a 30-second wait does not cost 30 seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly homeDir?: string;
  /** Off in tests, so a lock cannot outlive the run that took it. */
  readonly handleSignals?: boolean;
}

const sentence = (text: string): string => (text.endsWith(".") ? text : `${text}.`);

/**
 * Paseo's own reason for a failure, verbatim, or the CLI error's message.
 *
 * `paseo` prints its reason inside a JSON error document; the exit code alone
 * ("failed with exit code 1") tells the user nothing they can act on.
 */
function detailOf(error: unknown): string {
  if (isPaseoCliError(error)) return paseoFailureDetail(error) ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/** The whole command, as a `CommandHandler`. */
export function createMigrateCommand(deps: MigrateDeps = {}): CommandHandler {
  return async (context: CommandContext): Promise<number> => {
    const result = await migrate(context, { ...deps, quiet: context.flags.json });
    if (context.flags.json) {
      writeJsonReport(toReport(context, result), context.stdout);
      return result.exitCode;
    }
    // Without --json the report is never rendered, so this is the only place a
    // failure reaches the person who ran the command. An exit code on its own
    // tells them nothing: design §4.4 steps 1 and 4 want Paseo's own reason and,
    // when even the fallback failed, the two commands to run by hand — and
    // `result.error` already carries both.
    if (result.error !== null) {
      context.stderr(`error: ${result.code ?? errorCodeFor(result.outcome)}: ${result.error}\n`);
    }
    return result.exitCode;
  };
}

/** The migration's `--json` document (§4.4). `command` is what ran, not what was typed. */
export function toReport(context: CommandContext, result: MigrateResult): MigrateReport {
  return {
    schemaVersion: 1,
    command: "migrate",
    mode: result.actions.length > 0 && result.exitCode !== EXIT_CODES.noTtyNoApply && context.flags.apply ? "applied" : "preview",
    paseoBmVersion: context.version,
    paseo: result.paseo ?? UNKNOWN_PASEO,
    actions: [...result.actions],
    migration: {
      outcome: result.outcome,
      from: result.plan.from,
      to: result.plan.to,
      fallback: result.fallback,
    },
    roles: [],
    skills: null,
    warnings: result.warnings.map((code) => ({ code })),
    result: {
      exitCode: result.exitCode as ReportResult["exitCode"],
      pluginState: result.pluginState,
      ...(result.error === null ? {} : { error: { code: result.code ?? errorCodeFor(result.outcome), message: result.error } }),
    },
  };
}

/** A diagnostic code narrowed to the error half of the registry. */
function asErrorCode(code: DiagnosticCode): ErrorCode | undefined {
  return isErrorCode(code) ? code : undefined;
}

/** An error's own registry code, when it carries one. */
function codeOf(error: unknown): ErrorCode | undefined {
  if (isPaseoCliError(error)) return error.code;
  if (isRecordError(error) && error.code !== undefined) return error.code;
  if (error instanceof LockError) return error.code;
  return undefined;
}

/** The diagnostic code that belongs with a failed outcome. */
function errorCodeFor(outcome: MigrationOutcome): ErrorCode {
  switch (outcome) {
    case "not-ours":
      return "E_CONFLICT";
    case "remove-failed":
    case "fell-back":
    case "fallback-failed":
      return "E_PLUGIN_LOAD_FAILED";
    default:
      return "E_CONFLICT";
  }
}

/**
 * Runs the migration and returns everything the reporter needs.
 *
 * Never throws for an expected failure: every stop is a `MigrateResult` with an
 * exit code, so the caller renders one report whatever happened.
 */
export async function migrate(context: CommandContext, deps: MigrateDeps = {}): Promise<MigrateResult> {
  const now = deps.now ?? (() => new Date());
  const layout = resolveLayout({
    flags: { ...(context.homes.home === undefined ? {} : { home: context.homes.home }) },
    env: context.env,
    ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
  });
  const installHome = layout.installHome.path;
  const paths = installPaths(installHome);
  const adapter = deps.adapter ?? createPaseoAdapter({ env: context.env });

  // Filled once preflight has asked the daemon; every result carries it, so a
  // `--json` document always names the Paseo it was run against.
  let paseo: PaseoFacts = UNKNOWN_PASEO;
  const stop = (
    outcome: MigrationOutcome,
    exitCode: number,
    plan: MigrationPlan,
    error: string | null,
    code?: ErrorCode,
  ): MigrateResult => ({
    exitCode,
    outcome,
    plan,
    paseo,
    actions: [],
    warnings: [],
    pluginState: null,
    error,
    ...(code === undefined ? {} : { code }),
    fallback: null,
  });
  const nowhere: MigrationPlan = { case: "D", from: null, to: `npm:${PLUGIN_PACKAGE}@${context.version}`, reason: null };

  // Preconditions first: they are the only stops that can happen before a
  // single byte is written, and they all exit 3.
  const preflight = await runPreflight({ adapter, installHome, env: context.env });
  paseo = {
    cliVersion: preflight.facts.cliVersion,
    daemonVersion: preflight.facts.daemonVersion,
    home: preflight.facts.paseoHome,
    // The migration never reads Paseo's own plugins switch: it does not write
    // it and does not need it. The report says so rather than guessing.
    pluginsEnabled: false,
  };
  if (!preflight.ok) {
    // The failing check's own code, for the same reason every other stop
    // carries one: "the daemon did not answer" and "we refuse to touch someone
    // else's plugin" are different problems and must not share a code.
    const failed = preflight.findings.find((finding) => finding.severity === "error");
    const code = failed?.code === null || failed?.code === undefined ? undefined : asErrorCode(failed.code);
    return stop("not-ours", EXIT_CODES.preflight, nowhere, failed?.detail ?? failed?.message ?? null, code);
  }

  const fsops = createFsOps({ root: installHome, ...(deps.fs === undefined ? {} : { fs: deps.fs }) });

  let record: InstallRecord | undefined;
  try {
    record = await readRecord(fsops);
  } catch (error) {
    return stop("not-ours", EXIT_CODES.preflight, nowhere, detailOf(error), codeOf(error));
  }

  let plugins: readonly PluginSummary[];
  try {
    plugins = await adapter.pluginList();
  } catch (error) {
    return stop("not-ours", EXIT_CODES.preflight, nowhere, detailOf(error), codeOf(error));
  }

  const plan = classify({
    plugin: plugins.find((entry) => entry.id === PLUGIN_ID),
    pluginRoot: paths.pluginRoot,
    record,
    version: context.version,
    installHome,
  });

  if (plan.case === "C" || plan.case === "E") {
    return stop("not-ours", EXIT_CODES.conflict, plan, plan.reason);
  }
  if (plan.case === "D") {
    const lines = [
      `Paseo has no \`${PLUGIN_ID}\` plugin, so there is nothing to migrate.`,
      `Install it from paseo.cafe, or run: paseo plugin add npm:${PLUGIN_PACKAGE}`,
    ];
    if (record !== undefined) {
      lines.push(`The data already in ${installHome} — history, role instructions and fallback settings — will be used by it.`);
    }
    if (deps.quiet !== true) context.stdout(`${lines.join("\n")}\n`);
    return { ...stop("no-directory-install", EXIT_CODES.ok, plan, null), warnings: [] };
  }

  // Cases A and B both write; everything below is the plan the user confirms.
  const actions = await planActions(fsops, paths, layout.homeDir, record, plan, now());
  if (!context.flags.apply) {
    if (deps.quiet !== true) context.stdout(renderPreview(plan, actions, installHome));
    if (!context.tty.interactive) {
      return { ...stop(plan.case === "B" ? "already-npm" : "migrated", EXIT_CODES.noTtyNoApply, plan, null), actions };
    }
    const confirmed = await context.prompter.confirm({ message: MIGRATE_QUESTION, defaultValue: false });
    if (!confirmed) {
      if (deps.quiet !== true) context.stdout("Nothing was changed.\n");
      return { ...stop(plan.case === "B" ? "already-npm" : "migrated", EXIT_CODES.ok, plan, null), actions };
    }
  } else if (context.tty.interactive && !context.flags.yes) {
    if (deps.quiet !== true) context.stdout(renderPreview(plan, actions, installHome));
    const confirmed = await context.prompter.confirm({ message: MIGRATE_QUESTION, defaultValue: false });
    if (!confirmed) {
      if (deps.quiet !== true) context.stdout("Nothing was changed.\n");
      return { ...stop(plan.case === "B" ? "already-npm" : "migrated", EXIT_CODES.ok, plan, null), actions };
    }
  }

  // The 0.3.x lock still guards this install home: a `paseo-bm` from before
  // 0.4.0 could be running `install` or `uninstall` in it right now, and two
  // processes rewriting `install.json` and Paseo's plugin entry would lose one
  // of the two.
  //
  // Taken here and not earlier, because taking it creates the folder it lives
  // in: a run that turns out to have nothing to do (cases C, D, E) or that is
  // only previewing must leave the machine exactly as it found it.
  let lock: LockHandle;
  try {
    lock = acquireLock(paths.lockFile, { command: "migrate", handleSignals: deps.handleSignals !== false });
  } catch (error) {
    return stop("not-ours", EXIT_CODES.preflight, nowhere, detailOf(error), codeOf(error));
  }
  try {
    return await apply(context, {
      adapter,
      fsops,
      paths,
      homeDir: layout.homeDir,
      record,
      plan,
      actions,
      now,
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.fs === undefined ? {} : { pointerFs: deps.fs }),
      ...(deps.quiet === undefined ? {} : { quiet: deps.quiet }),
      paseo,
    });
  } finally {
    lock.release();
  }
}

/** What step 0 would write, worked out before anything is touched. */
async function planActions(
  fsops: FsOps,
  paths: ReturnType<typeof installPaths>,
  homeDir: string,
  record: InstallRecord | undefined,
  plan: MigrationPlan,
  at: Date,
): Promise<Action[]> {
  const actions: Action[] = [];
  const defaultHome = join(homeDir, DEFAULT_DIR_NAMES.installHome);

  if (resolve(paths.root) !== resolve(defaultHome)) {
    actions.push({ kind: "create", target: join(defaultHome, "home.json"), reason: "custom-install-home" });
  }
  if (record?.paseo.mcpInject.setByUs === true) {
    const statePath = join(paths.root, "ui", "setup-state.json");
    const existing = await readJson(statePath);
    if (setupStateWithAgentTools(existing, record.paseo.mcpInject.previous.value === true, at) !== null) {
      actions.push({ kind: "create", target: `${statePath}#agentTools`, reason: "carry-over" });
    }
  }
  if (plan.case === "A") {
    actions.push({ kind: "plugin", target: PLUGIN_ID, reason: "switch-to-npm", from: plan.from ?? "", to: plan.to });
  }
  if (record !== undefined && record.schemaVersion !== MIGRATED_RECORD_SCHEMA_VERSION) {
    actions.push({ kind: "update", target: join(paths.root, "install.json"), reason: "migrated" });
  }
  return actions;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function renderPreview(plan: MigrationPlan, actions: readonly Action[], installHome: string): string {
  const lines = [
    plan.case === "B"
      ? `Paseo already loads \`${PLUGIN_ID}\` from npm; only this install's own record is behind.`
      : `Switching \`${PLUGIN_ID}\` from ${plan.from} to ${plan.to}.`,
    "",
    "This will:",
  ];
  for (const action of actions) {
    if (action.kind === "plugin") {
      lines.push(`  - remove the directory plugin and install ${action.to}`);
      continue;
    }
    lines.push(`  - ${action.kind === "create" ? "write" : "update"} ${action.target} (${action.reason})`);
  }
  lines.push(
    "",
    `Your data in ${installHome} is kept: history, role instructions, fallback settings and the old payload are not touched.`,
    "Your agents keep running; paseo-bm's hooks are off for the seconds the switch takes.",
    "",
  );
  return lines.join("\n");
}

interface ApplyInput {
  adapter: PaseoAdapter;
  fsops: FsOps;
  paths: ReturnType<typeof installPaths>;
  homeDir: string;
  record: InstallRecord | undefined;
  plan: MigrationPlan;
  actions: readonly Action[];
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The pointer lives in `~/.paseo-bm`, which may be outside the install home. */
  pointerFs?: NodeFsApi;
  /** With `--json`, stdout carries one document and nothing else. */
  quiet?: boolean;
  paseo: PaseoFacts;
}

async function apply(context: CommandContext, input: ApplyInput): Promise<MigrateResult> {
  const { fsops, paths, plan, actions } = input;
  const warnings: WarningCode[] = [];
  const at = input.now();

  // ── Step 0: the two files a 0.3.x plugin cannot see. ────────────────────
  for (const action of actions) {
    if (action.kind !== "create") continue;
    if (action.reason === "custom-install-home") {
      const pointerRoot = join(input.homeDir, DEFAULT_DIR_NAMES.installHome);
      const pointerOps = createFsOps({ root: pointerRoot, ...(input.pointerFs === undefined ? {} : { fs: input.pointerFs }) });
      await pointerOps.ensureDir(pointerRoot);
      await pointerOps.writeFileAtomic(join(pointerRoot, "home.json"), pointerDocument(paths.root, context.version, at), {
        mode: FILE_MODE,
      });
      continue;
    }
    if (action.reason === "carry-over" && input.record !== undefined) {
      const statePath = join(paths.root, "ui", "setup-state.json");
      const document = setupStateWithAgentTools(
        await readJson(statePath),
        input.record.paseo.mcpInject.previous.value === true,
        at,
      );
      if (document !== null) {
        await fsops.ensureDir(join(paths.root, "ui"));
        await fsops.writeFileAtomic(statePath, document, { mode: FILE_MODE });
      }
    }
  }

  // ── Steps 1–4: Paseo. Case B has nothing to switch. ─────────────────────
  let pluginState: string | null = null;
  if (plan.case === "A") {
    const switched = await switchPlugin(context, input);
    if (switched.error !== null) return { ...switched, actions, warnings };
    pluginState = switched.pluginState;
    if (pluginState === PLUGIN_STATUS_DISABLED) {
      warnings.push("W_PLUGINS_DISABLED");
    }
  }

  // ── Step 5: the mark, last and only on success. ─────────────────────────
  if (input.record !== undefined && input.record.schemaVersion !== MIGRATED_RECORD_SCHEMA_VERSION) {
    const next: InstallRecord = {
      ...input.record,
      schemaVersion: MIGRATED_RECORD_SCHEMA_VERSION,
      updatedAt: at.toISOString(),
      migratedTo: { source: "npm", package: PLUGIN_PACKAGE, version: context.version, at: at.toISOString() },
    };
    await writeRecord(fsops, next);
  }

  const outcome: MigrationOutcome = plan.case === "B" ? "already-npm" : "migrated";
  if (input.quiet !== true) {
    context.stdout(
      plan.case === "B"
        ? `Paseo already loads \`${PLUGIN_ID}\` from npm. This install's record now says so too.\n`
        : `Switched \`${PLUGIN_ID}\` to ${plan.to}. Your roles, settings and history are unchanged.\n`,
    );
  }
  for (const warning of warnings) {
    const entry = diagnostic(warning);
    if (input.quiet !== true) context.stdout(`${entry.message} ${entry.remediation}\n`);
  }
  return { exitCode: EXIT_CODES.ok, outcome, plan, paseo: input.paseo, actions, warnings, pluginState, error: null, fallback: null };
}

/** Steps 1–4: remove the directory plugin, add the npm one, and put it back if that fails. */
async function switchPlugin(context: CommandContext, input: ApplyInput): Promise<MigrateResult> {
  const { adapter, plan } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const failed = (outcome: MigrationOutcome, error: string, fallback: MigrateResult["fallback"], pluginState: string | null): MigrateResult => ({
    exitCode: EXIT_CODES.pluginLoadFailed,
    outcome,
    plan,
    paseo: input.paseo,
    actions: [],
    warnings: [],
    pluginState,
    error,
    fallback,
  });

  try {
    await adapter.pluginRemove(PLUGIN_ID);
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
    return failed(
      "remove-failed",
      `Paseo could not remove the \`${PLUGIN_ID}\` plugin: ${sentence(detailOf(error))} Nothing was changed; ` +
        `see why with: paseo plugin logs ${PLUGIN_ID}`,
      null,
      null,
    );
  }

  try {
    // Paseo runs a real npm install here, so this one call gets 120 seconds
    // instead of the adapter's 15 (design §4.4 step 2). Without it a normal
    // network is enough to kill the add and send the run down the fallback.
    const invocation = await adapter.run(pluginAddArgs(context.version), { timeoutMs: PLUGIN_ADD_TIMEOUT_MS });
    parsePluginSummary(parseJsonOutput(invocation), invocation.argv);
    const state = await waitForRegistered(adapter, sleep);
    if (state !== null) {
      return { exitCode: EXIT_CODES.ok, outcome: "migrated", plan, paseo: input.paseo, actions: [], warnings: [], pluginState: state, error: null, fallback: null };
    }
    return await fallBack(context, input, `Paseo installed ${plan.to} but it never reached a running state.`);
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
    return await fallBack(context, input, `Paseo could not install ${plan.to}: ${sentence(detailOf(error))}`);
  }
}

/** Puts the directory install back, exactly as `install --apply` does after a failed update. */
async function fallBack(context: CommandContext, input: ApplyInput, why: string): Promise<MigrateResult> {
  const { adapter, plan } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const from = plan.from ?? "";

  // Paseo writes the `plugins[id]` entry before starting a plugin and keeps it
  // when the start fails, so the id has to go before it can be reused.
  try {
    await adapter.pluginRemove(PLUGIN_ID);
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
  }

  try {
    const invocation = await adapter.run(pluginInstallArgs(from));
    parsePluginSummary(parseJsonOutput(invocation), invocation.argv);
    const state = await waitForRegistered(adapter, sleep);
    if (state !== null) {
      return {
        exitCode: EXIT_CODES.pluginLoadFailed,
        outcome: "fell-back",
        plan,
        paseo: input.paseo,
        actions: [],
        warnings: [],
        pluginState: state,
        error: `${why} Your previous install from ${from} was put back (status "${state}"), and install.json is unchanged.`,
        fallback: { outcome: "fell-back", detail: `restored ${from}` },
      };
    }
  } catch (error) {
    if (!isPaseoCliError(error)) throw error;
  }

  void context;
  return {
    exitCode: EXIT_CODES.pluginLoadFailed,
    outcome: "fallback-failed",
    plan,
    paseo: input.paseo,
    actions: [],
    warnings: [],
    pluginState: null,
    error:
      `${why} Putting your previous install back also failed, so Paseo may have no \`${PLUGIN_ID}\` plugin now. ` +
      `Register it again with: paseo plugin install ${from} --id ${PLUGIN_ID}` +
      `, and see why with: paseo plugin logs ${PLUGIN_ID}. install.json is unchanged.`,
    fallback: { outcome: "fallback-failed", detail: `could not restore ${from}` },
  };
}

/** Polls `plugin ls` until the plugin is registered, or the deadline passes. */
async function waitForRegistered(adapter: PaseoAdapter, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  const deadline = Date.now() + PLUGIN_RUNNING_TIMEOUT_MS;
  for (;;) {
    let found: PluginSummary | undefined;
    try {
      found = (await adapter.pluginList()).find((entry) => entry.id === PLUGIN_ID);
    } catch {
      found = undefined;
    }
    if (found !== undefined && (found.status === PLUGIN_STATUS_RUNNING || found.status === PLUGIN_STATUS_DISABLED)) {
      return found.status;
    }
    if (Date.now() >= deadline) return null;
    await sleep(PLUGIN_POLL_INTERVAL_MS);
  }
}
