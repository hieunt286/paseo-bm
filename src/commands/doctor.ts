/**
 * `paseo-bm doctor` — the read-only health check (REQ-011, Technical Design
 * §4.1, §4.3, §4.4).
 *
 * The one invariant this file exists to protect: **doctor never changes
 * anything.** Concretely that means
 *
 *   - no writes: not a directory, not a probe file, not the process lock. The
 *     lock module is deliberately not imported here (Design §4.1: "`paseo-bm
 *     doctor` never needs the lock", `E_LOCKED` remediation).
 *   - no network.
 *   - exactly two external commands, both read-only:
 *     `paseo daemon status --json` and `paseo plugin ls --json`, listed in
 *     {@link DOCTOR_PASEO_COMMANDS}. The third-party `skills` CLI is **never**
 *     run — skills are observed by reading directories, never by executing
 *     anything (ADR-003).
 *   - no state-changing Paseo command: `daemon reload`, `plugin install`,
 *     `plugin remove` are all off-limits, and `test/doctor.test.ts` asserts the
 *     recorded call list is exactly the allow-list.
 *
 * `--prune` is **not** a doctor flag (Design §4.2): pruning writes.
 *
 * Nothing here diagnoses on its own. The environment checks are the very
 * functions `src/preflight.ts` exposes — composed so that *every* item runs
 * instead of stopping at the first failure, which is the one behavioural
 * difference between preflight and doctor. Skills findings come from
 * `skillsChecks()`; ownership comes from `install.json`.
 *
 * Exit codes (Design §4.3): `0` healthy, `1` drift inside what paseo-bm owns,
 * `2` misuse — and `2` is decided at parse time in `src/flags.ts`, never here.
 * Warnings about skills and about the beads CLI never change the exit code.
 *
 * The trap this file is careful about: a plugin's `enabled` field is its own
 * switch and is always `true` after install. Only `status` says whether the
 * plugin is live, so every decision below goes through `isPluginRunning()`.
 */

import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { Check, DoctorReport, PaseoFacts, ReportWarning, RoleReport, SkillsReport } from "../action.js";
import { hasCheckErrors } from "../action.js";
import type { FileStatusReason } from "../action.js";
import type { CommandContext, CommandHandler } from "../cli.js";
import { DIAGNOSTICS } from "../errors.js";
import type { ExitCode } from "../exit-codes.js";
import { EXIT_CODES } from "../exit-codes.js";
import { sha256 } from "../fsops.js";
import type { Environment } from "../flags.js";
import type { Layout } from "../layout.js";
import { paseoConfigFile, resolveLayout } from "../layout.js";
import type { DaemonStatus, PaseoAdapter, PluginSummary } from "../paseo/adapter.js";
import { createPaseoAdapter, isPaseoCliError, isPluginRunning } from "../paseo/adapter.js";
import type { FsProbe } from "../preflight.js";
import { checkBeadsCli, checkDaemon, checkPaseoVersion, realFsProbe, toCheck } from "../preflight.js";
import type { InstallRecord } from "../record.js";
import { ROLE_NAMES, isRecordError, parseRecord, recordPath, resolveRecordedPath, roleId } from "../record.js";
import { writeHumanReport } from "../report/human.js";
import { writeJsonReport } from "../report/json.js";
import type { SkillsDetection } from "../skills/detect.js";
import { detectSkills, skillsChecks, toSkillsByAgent } from "../skills/detect.js";
import { readVersion } from "../version.js";

/* -------------------------------------------------------------- allow-list */

/**
 * Every external command `doctor` is permitted to run, argv by argv.
 *
 * This is the machine-readable form of the invariant in the file header, and
 * `test/doctor.test.ts` compares it against the calls a recording adapter
 * actually saw. Adding a row here is a deliberate widening of what a read-only
 * command may do, and should not happen without the design saying so.
 */
export const DOCTOR_PASEO_COMMANDS: readonly (readonly string[])[] = [
  ["daemon", "status", "--json"],
  ["plugin", "ls", "--json"],
];

/**
 * The recommended skills repository (PRD Q-002, Design §4.4). It is only ever
 * *named* in a report; doctor never fetches it and never runs the CLI that
 * would. When the skills-assist module lands this constant belongs there, with
 * doctor importing it.
 */
export const DEFAULT_SKILLS_SOURCE = "cuongntr/agent-skills";

/* ------------------------------------------------------------- check ids */

/**
 * Stable ids of the checks doctor emits, in report order.
 *
 * The convention, shared with `src/preflight.ts` and `src/skills/detect.ts`, is
 * lower-kebab `<subject>-<aspect>`, and `<subject>-<item>` when there is one
 * check per item (`role-bm-worker`, `skills-claude`). The ids are part of the
 * `--json` contract of Design §4.4: renaming one is a breaking change.
 */
export const DOCTOR_CHECK_IDS = [
  "paseo-daemon",
  "paseo-version",
  "install-record",
  "install-version",
  "files-missing",
  "files-modified",
  "plugin-registered",
  "plugin-status",
  "plugin-path",
  "plugins-enabled",
  "agent-tools",
  "role-bm-manager",
  "role-bm-worker",
  "role-bm-reviewer",
  "payload-versions",
  "backups",
  "beads-cli",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_IDS)[number];

/* ------------------------------------------------------- read-only probes */

/**
 * What doctor needs from Paseo's `config.json`, and nothing more.
 *
 * `src/paseo/config.ts` is the module that will own reading and *writing* this
 * file. Doctor only ever reads it, so it takes the answer through this port and
 * ships an interim reader ({@link readPaseoConfigFacts}) until that module
 * exists; swapping the default is then a one-line change.
 */
export interface PaseoConfigFacts {
  readonly path: string;
  /** False when the file does not exist at all. */
  readonly present: boolean;
  /** False when the file exists but could not be read or parsed as JSON. */
  readonly readable: boolean;
  /** `pluginsEnabled` — the global plugin switch (Design §3.4). */
  readonly pluginsEnabled: boolean;
  /** `daemon.mcp.injectIntoAgents` — the agent tool switch (Design §3.4). */
  readonly mcpInjectIntoAgents: boolean;
  /** Ids under `agents.providers`. */
  readonly agentProviderIds: readonly string[];
  /** Ids of `daemon.agentProfiles[]` entries. */
  readonly agentProfileIds: readonly string[];
  /** Whether `agents.providers.<id>.paseoTools` is switched on, per provider id. */
  readonly providerPaseoTools: Readonly<Record<string, boolean>>;
}

export type PaseoConfigReader = (configFile: string) => Promise<PaseoConfigFacts>;

/** One owned payload file, judged against the hash recorded for it (§3.3). */
export interface OwnedFileStatus {
  /** Path relative to the install home, exactly as `install.json` records it. */
  readonly path: string;
  readonly absolutePath: string;
  readonly status: FileStatusReason;
}

export type OwnedFileProbe = (
  record: InstallRecord,
  installHome: string,
) => Promise<readonly OwnedFileStatus[]>;

export interface DoctorOptions {
  /**
   * Adapter over the `paseo` CLI. Required on purpose: no path here may fall
   * back to spawning the real CLI by accident.
   */
  readonly adapter: PaseoAdapter;
  /** Every directory doctor may read, already resolved (`src/layout.ts`). */
  readonly layout: Layout;
  /** Version of the running package. Defaults to {@link readVersion}. */
  readonly version?: string;
  /** Environment used to find the beads CLI. Defaults to `process.env`. */
  readonly env?: Environment;
  /** Read-only filesystem probe for the beads lookup. */
  readonly fs?: FsProbe;
  /** `--skip-skills-check`: drop the skills section entirely (Design §4.2). */
  readonly skipSkillsCheck?: boolean;
  /** Overrides the interim `config.json` reader. */
  readonly readConfig?: PaseoConfigReader;
  /** Overrides the interim ownership probe; `src/ownership.ts` will own this. */
  readonly probeOwnedFiles?: OwnedFileProbe;
  /** Overrides skills detection, e.g. to make a test deterministic. */
  readonly detect?: (layout: Layout) => Promise<SkillsDetection>;
  /** Repository named in the skills section of the report. */
  readonly skillsSource?: string;
  /**
   * The `skills add …` line a user could run themselves. Built by the
   * skills-assist module, which does not exist yet; until it does the report
   * says `null` rather than inventing a command line.
   */
  readonly suggestedSkillsCommand?: string | null;
}

export interface DoctorOutcome {
  readonly report: DoctorReport;
  readonly checks: readonly Check[];
  /** `0` healthy, `1` drift inside what paseo-bm owns. Never anything else. */
  readonly exitCode: ExitCode;
  /** False when there is no `install.json`: nothing is owned here yet. */
  readonly installed: boolean;
}

/* --------------------------------------------------------------- helpers */

/**
 * Build one finding. `id` is typed as a plain string because two families of
 * id are generated rather than listed: `role-<roleId>` and the `skills-<agent>`
 * ids that `skillsChecks()` owns.
 */
function check(id: string, severity: Check["severity"], message: string, remediation = ""): Check {
  return { id, severity, message, remediation };
}

const RUN_INSTALL = "Run `npx paseo-bm install --apply` to put it back. Nothing is changed by `doctor`.";
const RUN_INSTALL_CONSENT =
  "Run `npx paseo-bm install --apply --enable-plugins` to consent to both halves of that trust boundary: enabling plugins and granting Paseo tools to agents.";
const BROKEN_RECORD =
  "Restore or repair install.json, then run `paseo-bm doctor` again. Do not delete it: it is the only record of what paseo-bm owns.";

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/* ------------------------------------------------- interim config reader */

function asRecordObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Paseo stores the switch as `paseoTools: { enabled: boolean }` — the shape
 * `roleProviderEntry` in `src/roles/register.ts` writes (ADR-006). A bare
 * `paseoTools: true` is accepted too, for compatibility. Anything else, or an
 * absent key, means off.
 */
function paseoToolsEnabled(value: unknown): boolean {
  if (value === true) return true;
  return asRecordObject(value)?.["enabled"] === true;
}

const MISSING_CONFIG = (path: string, present: boolean, readable: boolean): PaseoConfigFacts => ({
  path,
  present,
  readable,
  pluginsEnabled: false,
  mcpInjectIntoAgents: false,
  agentProviderIds: [],
  agentProfileIds: [],
  providerPaseoTools: {},
});

/**
 * Reads the handful of fields doctor reports out of Paseo's `config.json`.
 *
 * Interim: `src/paseo/config.ts` is the module that will own this file. Until
 * it lands, this reader is deliberately the narrowest thing that answers the
 * questions in Design §3.4 — it opens the file read-only, never repairs it, and
 * treats every shape it does not recognise as "absent" rather than guessing.
 */
export const readPaseoConfigFacts: PaseoConfigReader = async (configFile) => {
  let text: string;
  try {
    text = await readFile(configFile, "utf8");
  } catch (error) {
    return MISSING_CONFIG(configFile, !isErrno(error, "ENOENT"), false);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return MISSING_CONFIG(configFile, true, false);
  }

  const root = asRecordObject(parsed);
  if (root === undefined) {
    return MISSING_CONFIG(configFile, true, false);
  }

  const daemon = asRecordObject(root["daemon"]);
  const mcp = asRecordObject(daemon?.["mcp"]);
  const providers = asRecordObject(asRecordObject(root["agents"])?.["providers"]) ?? {};
  const profiles = Array.isArray(daemon?.["agentProfiles"]) ? daemon["agentProfiles"] : [];

  const providerPaseoTools: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(providers)) {
    providerPaseoTools[id] = paseoToolsEnabled(asRecordObject(value)?.["paseoTools"]);
  }

  return {
    path: configFile,
    present: true,
    readable: true,
    pluginsEnabled: root["pluginsEnabled"] === true,
    mcpInjectIntoAgents: mcp?.["injectIntoAgents"] === true,
    agentProviderIds: Object.keys(providers),
    agentProfileIds: profiles
      .map((entry) => asRecordObject(entry)?.["id"])
      .filter((id): id is string => typeof id === "string" && id.length > 0),
    providerPaseoTools,
  };
};

/* ---------------------------------------------- interim ownership probe */

/**
 * Compares every file `install.json` claims against what is on disk.
 *
 * Interim: `src/ownership.ts` is the module that will own the §3.3 status
 * table for install and uninstall as well. Doctor needs only the read half —
 * hash what is there, compare it to what was written — so it carries this
 * narrow version behind {@link OwnedFileProbe} and will hand the job over.
 *
 * `outdated` is intentionally never produced here: it means "matches an older
 * record", and doctor holds exactly one record. Payload staleness is reported
 * against the running package version by the `install-version` check instead.
 */
export const probeOwnedFiles: OwnedFileProbe = async (record, installHome) => {
  const results: OwnedFileStatus[] = [];
  for (const entry of record.files) {
    const absolutePath = resolveRecordedPath(installHome, entry.path);
    let status: FileStatusReason;
    try {
      const bytes = await readFile(absolutePath);
      status = sha256(bytes) === entry.sha256 ? "unchanged" : "user-modified";
    } catch (error) {
      // Gone is `missing`. Present but unreadable is still a deviation a human
      // has to look at, and `user-modified` is the category whose remediation
      // ("re-run install, a backup is taken") fits it; the errno is not
      // swallowed silently because the path is named in the check message.
      status = isErrno(error, "ENOENT") ? "missing" : "user-modified";
    }
    results.push({ path: entry.path, absolutePath, status });
  }
  return results;
};

/* ----------------------------------------------------------- the command */

/**
 * Run every check and build the report. Performs no writes and takes no lock.
 *
 * Unlike `runPreflight`, nothing here stops early: a doctor that reported one
 * problem and hid the other four would send the user round the loop five
 * times. Each step is therefore independently guarded, and a step that cannot
 * be answered says so instead of being skipped silently.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorOutcome> {
  const { adapter, layout } = options;
  const version = options.version ?? readVersion();
  const env = options.env ?? process.env;
  const probe = options.fs ?? realFsProbe;
  const readConfig = options.readConfig ?? readPaseoConfigFacts;
  const classify = options.probeOwnedFiles ?? probeOwnedFiles;
  const detect = options.detect ?? detectSkills;

  const checks: Check[] = [];
  const warnings: ReportWarning[] = [];
  const installHome = layout.installHome.path;

  /* -- 1. the daemon, and the versions it reports (allow-listed call #1) --- */

  const daemon = await checkDaemon(adapter);
  checks.push(toCheck(daemon.finding));
  const status: DaemonStatus | null = daemon.status;
  if (status !== null) {
    checks.push(toCheck(checkPaseoVersion(status)));
  }

  /* -- 2. the install record: the source of truth about what is owned ------ */

  const recordFile = recordPath(installHome);
  let record: InstallRecord | undefined;
  let recordBroken = false;
  try {
    record = await loadRecord(recordFile);
  } catch (error) {
    recordBroken = true;
    const remediation = (isRecordError(error) ? error.remediation : undefined) ?? BROKEN_RECORD;
    checks.push(
      check("install-record", "error", error instanceof Error ? error.message : String(error), remediation),
    );
  }

  if (!recordBroken) {
    if (record === undefined) {
      // Not a deviation: with no record there is nothing owned to deviate. A
      // warning keeps the exit code at 0 and still tells the user what to do.
      checks.push(
        check(
          "install-record",
          "warn",
          `paseo-bm is not installed here: there is no install record at ${recordFile}.`,
          "Run `npx paseo-bm install --apply` to install it. Nothing else is reported because nothing is owned yet.",
        ),
      );
    } else {
      checks.push(check("install-record", "ok", `The install record at ${recordFile} is readable.`));
    }
  }

  /* -- 3. everything that only makes sense once something is installed ----- */

  const config = await readConfig(paseoConfigFile(layout.paseoHome.path));
  let pluginState: string | null = null;

  if (record !== undefined) {
    checks.push(versionCheck(record, version));

    const files = await classify(record, installHome);
    checks.push(...fileChecks(files, record.files.length));

    const plugins = status === null ? null : await listPlugins(adapter, checks);
    if (plugins !== null) {
      const found = pluginChecks(record, plugins, checks);
      pluginState = found?.status ?? null;
      if (found !== undefined) {
        checks.push(await pluginPathCheck(record, found, installHome));
      }
    }

    checks.push(...switchChecks(config));
    checks.push(...roleChecks(record, config));
    checks.push(...inventoryChecks(record));
  }

  /* -- 4. warnings; these never change the exit code (Design §4.3) -------- */

  const beads = checkBeadsCli({ env, fs: probe });
  checks.push(toCheck(beads.finding));
  if (beads.path === null) {
    warnings.push({ code: "W_BEADS_CLI_MISSING", detail: "looked for br and bd on PATH" });
  }

  let skills: SkillsReport | null = null;
  if (options.skipSkillsCheck !== true) {
    const detection = await detect(layout);
    const findings = skillsChecks(detection);
    checks.push(...findings);
    if (findings.some((finding) => finding.severity === "warn")) {
      warnings.push({ code: "W_SKILLS_MISSING" });
    }
    skills = {
      source: options.skillsSource ?? DEFAULT_SKILLS_SOURCE,
      required: detection.required,
      byAgent: toSkillsByAgent(detection),
      suggestedCommand: options.suggestedSkillsCommand ?? null,
      assisted: record?.skills.lastCommand != null,
      outcome: record?.skills.assistOutcome ?? null,
    };
  }
  if (record?.skills.assistOutcome === "failed") {
    warnings.push({ code: "W_SKILLS_ASSIST_FAILED" });
  }

  /* -- 5. the report ------------------------------------------------------ */

  const exitCode: ExitCode = hasCheckErrors(checks) ? EXIT_CODES.doctorDrift : EXIT_CODES.ok;
  const paseo: PaseoFacts = {
    cliVersion: status?.cliVersion ?? null,
    daemonVersion: status?.daemonVersion ?? null,
    home: status?.home ?? null,
    pluginsEnabled: config.pluginsEnabled,
  };

  const report: DoctorReport = {
    schemaVersion: 1,
    command: "doctor",
    // Always `preview`: doctor has nothing to apply.
    mode: "preview",
    paseoBmVersion: version,
    paseo,
    roles: rolesOf(record, config),
    skills,
    warnings,
    checks,
    result: { exitCode, pluginState },
  };

  return { report, checks, exitCode, installed: record !== undefined };
}

/* ------------------------------------------------------------ the pieces */

/** Reads `install.json` without going through the write-oriented `FsOps`. */
async function loadRecord(file: string): Promise<InstallRecord | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  return parseRecord(text, { path: file });
}

/**
 * Is the installed payload the one this package would install today?
 *
 * First the record has to agree with itself: `version` names the payload
 * install last *meant* to put in place, `versions[].active` the one that is
 * actually in place. They drift apart when an update copies the new payload
 * and records its version but fails before the switch-over (bm-p48); comparing
 * only `version` with the running package would then report a healthy install
 * while the old payload is still the live one.
 */
function versionCheck(record: InstallRecord, version: string): Check {
  const active = record.versions.find((entry) => entry.active);
  if (active === undefined) {
    return check(
      "install-version",
      "error",
      `The install record says version ${record.version}, but marks no payload version active.`,
      "Run `npx paseo-bm install --apply` to put the current payload in place and register it. Nothing is changed by `doctor`.",
    );
  }
  if (active.version !== record.version) {
    return check(
      "install-version",
      "error",
      `The install record says version ${record.version}, but the active payload is version ${active.version}: an update did not finish.`,
      "Run `npx paseo-bm install --apply` to finish the update. Earlier versions are kept; only `--prune` removes them.",
    );
  }
  if (record.version === version) {
    return check("install-version", "ok", `The installed payload is version ${record.version}, the version running now.`);
  }
  return check(
    "install-version",
    "error",
    `The installed payload is version ${record.version}, but this paseo-bm is ${version}.`,
    "Run `npx paseo-bm install --apply` to install the current payload. Earlier versions are kept; only `--prune` removes them.",
  );
}

/** Missing and modified owned files, reported as two separate findings. */
function fileChecks(files: readonly OwnedFileStatus[], total: number): readonly Check[] {
  const missing = files.filter((file) => file.status === "missing");
  const modified = files.filter((file) => file.status === "user-modified");

  const missingCheck =
    missing.length === 0
      ? check("files-missing", "ok", `All ${total} recorded ${plural(total, "file is", "files are")} present.`)
      : check(
          "files-missing",
          "error",
          `${missing.length} recorded ${plural(missing.length, "file is", "files are")} gone: ${missing
            .map((file) => file.path)
            .join(", ")}.`,
          RUN_INSTALL,
        );

  const modifiedCheck =
    modified.length === 0
      ? check("files-modified", "ok", `No recorded file has been changed since it was installed.`)
      : check(
          "files-modified",
          "error",
          `${modified.length} recorded ${plural(modified.length, "file no longer matches", "files no longer match")} the hash paseo-bm wrote: ${modified
            .map((file) => file.path)
            .join(", ")}.`,
          "Keep your edits, or run `npx paseo-bm install --apply --force` to restore the shipped copy. A backup is always taken before overwriting.",
        );

  return [missingCheck, modifiedCheck];
}

/** The second and last allow-listed call. A failure is reported, never thrown. */
async function listPlugins(adapter: PaseoAdapter, checks: Check[]): Promise<readonly PluginSummary[] | null> {
  try {
    return await adapter.pluginList();
  } catch (error) {
    const message = isPaseoCliError(error) ? error.message : error instanceof Error ? error.message : String(error);
    const remediation = isPaseoCliError(error)
      ? DIAGNOSTICS[error.code].remediation
      : DIAGNOSTICS.E_PASEO_OUTPUT_UNEXPECTED.remediation;
    checks.push(check("plugin-registered", "error", `Paseo could not list its plugins: ${message}`, remediation));
    return null;
  }
}

/**
 * Is the plugin registered, and is it actually live?
 *
 * `status` is the only field consulted for "live". `enabled` is the plugin's
 * own switch, is true after every successful install, and would report a
 * disabled daemon as healthy.
 */
function pluginChecks(
  record: InstallRecord,
  plugins: readonly PluginSummary[],
  checks: Check[],
): PluginSummary | undefined {
  const pluginId = record.paseo.pluginId;
  if (pluginId === null) {
    checks.push(
      check(
        "plugin-registered",
        "error",
        "The install record names no plugin id, so the payload was copied but never registered with Paseo.",
        RUN_INSTALL,
      ),
    );
    return undefined;
  }

  const found = plugins.find((plugin) => plugin.id === pluginId);
  if (found === undefined) {
    checks.push(
      check(
        "plugin-registered",
        "error",
        `Paseo does not list a plugin with id \`${pluginId}\`, which the install record says was registered.`,
        RUN_INSTALL,
      ),
    );
    return undefined;
  }

  checks.push(check("plugin-registered", "ok", `Paseo lists the plugin \`${pluginId}\`.`));
  checks.push(
    isPluginRunning(found)
      ? check("plugin-status", "ok", `Paseo reports the plugin \`${pluginId}\` as running.`)
      : check(
          "plugin-status",
          "error",
          `Paseo reports the plugin \`${pluginId}\` with status \`${found.status}\`, not running.`,
          RUN_INSTALL_CONSENT,
        ),
  );
  return found;
}

/**
 * Is Paseo loading the plugin from the payload version the record calls active?
 *
 * Only asked once the plugin is known to be registered. The expected directory
 * is the active `versions[].dir` under the install home doctor inspected,
 * spelled with `path.resolve` — the spelling install hands to
 * `paseo plugin install` and the planner compares against. When the two
 * spellings differ, both sides are canonicalised with `realpath` (a read) so a
 * symlinked home such as macOS's `/var` → `/private/var` is not reported as
 * drift; a side that cannot be resolved keeps its `path.resolve` spelling.
 *
 * Older or future Paseo builds may not report `path`. That is not evidence of
 * drift either way, so it is a warning (exit code unchanged), never an `ok`.
 */
async function pluginPathCheck(record: InstallRecord, found: PluginSummary, installHome: string): Promise<Check> {
  const pluginId = found.id;
  const active = record.versions.find((entry) => entry.active);
  if (active === undefined) {
    return check(
      "plugin-path",
      "error",
      `Paseo loads the plugin \`${pluginId}\`, but the install record marks no payload version active to compare it with.`,
      RUN_INSTALL,
    );
  }

  let expected: string;
  try {
    expected = resolveRecordedPath(installHome, active.dir);
  } catch (error) {
    return check(
      "plugin-path",
      "error",
      `The active payload directory \`${active.dir}\` in the install record is not inside ${installHome}: ${error instanceof Error ? error.message : String(error)}`,
      BROKEN_RECORD,
    );
  }

  if (found.path === undefined) {
    return check(
      "plugin-path",
      "warn",
      `Paseo did not report which directory the plugin \`${pluginId}\` is loaded from, so it could not be compared with the active payload ${expected}.`,
      "Nothing to do unless the plugin misbehaves; `npx paseo-bm install --apply` registers the active payload again.",
    );
  }

  const actual = resolve(found.path);
  if (actual === expected || (await canonical(actual)) === (await canonical(expected))) {
    return check(
      "plugin-path",
      "ok",
      `Paseo loads the plugin \`${pluginId}\` from the active payload (version ${active.version}).`,
    );
  }

  return check(
    "plugin-path",
    "error",
    `Paseo loads the plugin \`${pluginId}\` from ${actual}, but the active payload (version ${active.version}) is ${expected}.`,
    "Run `npx paseo-bm install --apply` to register the active payload with Paseo. Nothing is changed by `doctor`.",
  );
}

/** `realpath`, or the input unchanged when it cannot be resolved. Read-only. */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** The two switches of one trust boundary, Design §3.4 and REQ-006 / REQ-031c. */
function switchChecks(config: PaseoConfigFacts): readonly Check[] {
  if (!config.readable) {
    const message = config.present
      ? `Paseo's configuration at ${config.path} could not be read as JSON, so neither switch could be checked.`
      : `Paseo has no configuration file at ${config.path}, so neither switch could be checked.`;
    const remediation = "Open the Paseo app once so it writes its configuration, then run `paseo-bm doctor` again.";
    return [check("plugins-enabled", "error", message, remediation), check("agent-tools", "error", message, remediation)];
  }

  return [
    config.pluginsEnabled
      ? check("plugins-enabled", "ok", "Paseo's plugin switch (`pluginsEnabled`) is on.")
      : check(
          "plugins-enabled",
          "error",
          "Paseo's plugin switch (`pluginsEnabled`) is off, so the installed plugin does nothing.",
          RUN_INSTALL_CONSENT,
        ),
    config.mcpInjectIntoAgents
      ? check("agent-tools", "ok", "Paseo's agent tool switch (`daemon.mcp.injectIntoAgents`) is on.")
      : check(
          "agent-tools",
          "error",
          "Paseo's agent tool switch (`daemon.mcp.injectIntoAgents`) is off, so Beads Manager cannot create Beads Worker.",
          RUN_INSTALL_CONSENT,
        ),
  ];
}

/** One check per `bm-*` role: recorded, present in the config, tools as recorded. */
function roleChecks(record: InstallRecord, config: PaseoConfigFacts): readonly Check[] {
  return ROLE_NAMES.map((role) => {
    const id = roleId(role);
    const checkId = `role-${id}`;
    const entry = record.roles.find((candidate) => candidate.role === role);
    if (entry === undefined) {
      return check(checkId, "error", `The install record has no entry for the \`${id}\` role.`, RUN_INSTALL);
    }

    if (!config.readable) {
      return check(
        checkId,
        "error",
        `The \`${id}\` role is recorded as ${entry.baseProvider}/${entry.model}, but Paseo's configuration could not be read to confirm it.`,
        "Open the Paseo app once so it writes its configuration, then run `paseo-bm doctor` again.",
      );
    }

    const missing = [
      config.agentProviderIds.includes(entry.providerId) ? undefined : `agents.providers.${entry.providerId}`,
      config.agentProfileIds.includes(entry.profileId) ? undefined : `daemon.agentProfiles[${entry.profileId}]`,
    ].filter((part): part is string => part !== undefined);

    if (missing.length > 0) {
      return check(
        checkId,
        "error",
        `The \`${id}\` role is recorded but Paseo's configuration is missing ${missing.join(" and ")}.`,
        RUN_INSTALL,
      );
    }

    const tools = config.providerPaseoTools[entry.providerId] === true;
    if (tools !== entry.paseoTools) {
      return check(
        checkId,
        "error",
        `The \`${id}\` role is recorded with paseoTools ${String(entry.paseoTools)}, but Paseo's configuration has ${String(tools)}.`,
        RUN_INSTALL,
      );
    }

    return check(
      checkId,
      "ok",
      `The \`${id}\` role is configured as ${entry.baseProvider}/${entry.model} (Paseo tools: ${entry.paseoTools ? "yes" : "no"}).`,
    );
  });
}

/**
 * How many payload versions and backups are being kept.
 *
 * A count, never a byte total: measuring size means walking every tree, which
 * buys nothing a user acts on. Both are informational — keeping old versions is
 * the designed behaviour (§3.1), and only `--prune` on `install` removes any.
 */
function inventoryChecks(record: InstallRecord): readonly Check[] {
  const versions = record.versions.length;
  const active = record.versions.find((entry) => entry.active)?.version ?? "none";
  const backups = record.backups.length;

  return [
    check(
      "payload-versions",
      "ok",
      `${versions} payload ${plural(versions, "version is", "versions are")} kept (active: ${active}).`,
      versions > 1 ? "Run `npx paseo-bm install --apply --prune` if you want the older versions removed." : "",
    ),
    check(
      "backups",
      "ok",
      `${backups} ${plural(backups, "backup is", "backups are")} kept.`,
      backups > 0 ? "Run `npx paseo-bm install --apply --prune` if you want them removed." : "",
    ),
  ];
}

/**
 * The `roles[]` section of the report.
 *
 * `loggedIn` is always `null`: answering it would mean asking Paseo about a
 * provider, and that is a third command outside doctor's allow-list. The field
 * is documented as "null when it could not be told", which is the truth here.
 */
function rolesOf(record: InstallRecord | undefined, config: PaseoConfigFacts): readonly RoleReport[] {
  if (record === undefined) return [];
  return record.roles.map((entry) => ({
    role: entry.role,
    provider: entry.baseProvider,
    model: entry.model,
    paseoTools: config.readable ? config.providerPaseoTools[entry.providerId] === true : entry.paseoTools,
    loggedIn: null,
  }));
}

/* ------------------------------------------------------------- CLI wiring */

/**
 * The handler `src/cli.ts` routes `doctor` to.
 *
 * Under `--json` stdout carries exactly one document and the human report goes
 * to stderr, which is the rule of Design §4.4. The layout is resolved from the
 * flags, the environment and — once the daemon has answered — Paseo's own home,
 * because that is the source of truth for paths (ADR-004).
 */
export const doctorCommand: CommandHandler = async (context: CommandContext): Promise<number> => {
  const adapter = createPaseoAdapter({ env: context.env });
  const layout = resolveLayout({ flags: context.homes, env: context.env });

  const outcome = await runDoctor({
    adapter,
    layout,
    version: context.version,
    env: context.env,
    skipSkillsCheck: context.flags.skipSkillsCheck,
  });

  if (context.flags.json) {
    writeJsonReport(outcome.report, context.stdout);
  } else {
    writeHumanReport(outcome.report, context.stdout);
  }
  return outcome.exitCode;
};
