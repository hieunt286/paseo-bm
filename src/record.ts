/**
 * The install record — `<install home>/install.json`, Technical Design §5.2,
 * ADR-002 decisions 1, 8 and 9.
 *
 * This file is the **single source of truth about ownership**: what is not in
 * the record is not paseo-bm's. Update and uninstall both read it and nothing
 * else, so three properties matter more than convenience:
 *
 * 1. **It never holds a secret.** No password, no token, no API key, no content
 *    of a user's file. {@link serializeRecord} is a whitelist projection: only
 *    the fields listed in Design §5.2 are written, so a stray key attached to
 *    an object in memory physically cannot reach the file.
 * 2. **A record we do not understand stops the run.** A `schemaVersion` above
 *    {@link RECORD_SCHEMA_VERSION} raises `E_RECORD_SCHEMA_TOO_NEW` (ADR-002
 *    decision 9) instead of being read optimistically. A record that does not
 *    parse or does not validate raises a {@link RecordError} that names the
 *    field — and reading never writes, so a damaged record is left exactly as
 *    it is for a human to look at.
 * 3. **`paseo.mcpInject` stores the state, not a flag.** It keeps
 *    `{ setByUs, previous: { present, value } }`, because "the key was absent"
 *    is a different world from "the key was `false`", and a single boolean
 *    cannot undo the first one correctly (ADR-006 decision 8). The optional
 *    `paseo.pluginsEnabledPrevious` does the same for `pluginsEnabled`, and
 *    `paseo.createdConfigContainers` lists the containers of Paseo's config
 *    that only exist because paseo-bm created them (bead bm-tm2).
 *
 * Writing goes through {@link FsOps}, so it inherits atomic replace, "only
 * write when the bytes differ", and mode `0600` (ADR-002 decisions 2, 3, 8).
 */

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ErrorCode } from "./errors.js";
import { diagnostic } from "./errors.js";
import { FILE_MODE } from "./fsops.js";
import type { FsOps, WriteResult } from "./fsops.js";
import { installPaths } from "./layout.js";

/** Schema version this build writes and is willing to read. */
export const RECORD_SCHEMA_VERSION = 1 as const;

/**
 * The version `paseo-bm migrate` stamps once it has moved an install to the
 * npm plugin (design §4.5).
 *
 * Raising the number is deliberate and is the whole mechanism: a 0.3.x build
 * reading a schema-2 record stops with `E_RECORD_SCHEMA_TOO_NEW` instead of
 * "re-installing" a directory plugin over the npm one. This build therefore
 * reads both 1 and 2, and only the migration writes 2.
 */
export const MIGRATED_RECORD_SCHEMA_VERSION = 2 as const;

/** Every schemaVersion this build understands. */
export const SUPPORTED_RECORD_SCHEMA_VERSIONS: readonly number[] = [
  RECORD_SCHEMA_VERSION,
  MIGRATED_RECORD_SCHEMA_VERSION,
];

/** Where an install was moved to, written only by the migration. */
export interface MigratedToRecord {
  readonly source: "npm";
  readonly package: string;
  readonly version: string;
  readonly at: string;
}

/** The three roles paseo-bm registers, in the order they are used. */
export const ROLE_NAMES = ["manager", "worker", "reviewer"] as const;

/** A role, as stored in `roles[].role` and in the `bm.role` agent label. */
export type RoleName = (typeof ROLE_NAMES)[number];

/** Prefix every provider and profile paseo-bm creates carries (ADR-006 decision 1). */
export const ROLE_ID_PREFIX = "bm-";

/** `bm-manager`, `bm-worker`, `bm-reviewer` — the derived provider / profile id. */
export function roleId(role: RoleName): string {
  return `${ROLE_ID_PREFIX}${role}`;
}

/** True when an arbitrary string is one of the three role names. */
export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(value);
}

/**
 * The state of `daemon.mcp.injectIntoAgents` **before** paseo-bm touched it.
 * `present` is whether the key existed at all; `value` is what it held, and is
 * `null` exactly when `present` is false.
 */
export interface McpInjectPrevious {
  readonly present: boolean;
  readonly value: boolean | null;
}

/** `{ present, value }` of one boolean key before paseo-bm touched it. */
export type PreviousKeyState = McpInjectPrevious;

/**
 * The closed set of `config.json` containers paseo-bm can bring into existence
 * on its way to a key it writes (Design §5.2, §6.1; bead bm-tm2). Only these may
 * appear in `paseo.createdConfigContainers`, so a record can never point the
 * uninstaller at an arbitrary key of Paseo's file.
 */
export const CONFIG_CONTAINER_PATHS = [
  "agents",
  "agents.providers",
  "daemon",
  "daemon.agentProfiles",
  "daemon.mcp",
] as const;

/** One entry of {@link CONFIG_CONTAINER_PATHS}. */
export type ConfigContainerPath = (typeof CONFIG_CONTAINER_PATHS)[number];

/** True when a string names one of the containers paseo-bm can create. */
export function isConfigContainerPath(value: string): value is ConfigContainerPath {
  return (CONFIG_CONTAINER_PATHS as readonly string[]).includes(value);
}

/** Ownership of the global MCP switch (ADR-006 decisions 3, 7, 8). */
export interface McpInjectRecord {
  /** True only when this installer was the one that turned the switch on. */
  readonly setByUs: boolean;
  readonly previous: McpInjectPrevious;
}

/** What paseo-bm knows about the Paseo installation it wrote into. */
export interface PaseoRecord {
  /** Paseo's home, as reported by `paseo daemon status --json` (ADR-004). */
  readonly home: string;
  /**
   * The registered plugin's id, or `null` while the payload has been copied but
   * `paseo plugin install` has not been run for it yet.
   */
  readonly pluginId: string | null;
  /**
   * The absolute directory handed to `paseo plugin install` — the same string
   * Paseo stores as the plugin source, so `doctor` can compare them literally.
   */
  readonly pluginDir: string | null;
  /** True only when this installer was the one that set `pluginsEnabled`. */
  readonly pluginsEnabledSetByUs: boolean;
  /**
   * `{ present, value }` of `pluginsEnabled` before paseo-bm first turned it on.
   * Optional: a record written before bead bm-tm2 has none, and uninstall then
   * keeps the old behaviour (turn it off with `false`) instead of guessing.
   */
  readonly pluginsEnabledPrevious?: PreviousKeyState | undefined;
  readonly mcpInject: McpInjectRecord;
  /**
   * `config.json` containers that did not exist until paseo-bm created them, in
   * {@link CONFIG_CONTAINER_PATHS} order. Uninstall removes one only when it is
   * empty again. Optional; absent means "none recorded".
   */
  readonly createdConfigContainers?: readonly ConfigContainerPath[] | undefined;
}

/** One registered role: the derived provider, its profile, and the tool grant. */
export interface RoleRecord {
  readonly role: RoleName;
  /** `agents.providers.<providerId>` — `bm-manager` and friends. */
  readonly providerId: string;
  /** The `daemon.agentProfiles[]` entry id. */
  readonly profileId: string;
  /** The user's own provider this role `extends`; never a credential. */
  readonly baseProvider: string;
  readonly model: string;
  /** Profile fields that are optional in Paseo; `null` when not set. */
  readonly modeId: string | null;
  readonly thinkingOptionId: string | null;
  /** Whether the role is granted Paseo tools (false for `bm-reviewer`). */
  readonly paseoTools: boolean;
}

/** One payload file paseo-bm owns, hashed so a user edit is visible (Design §5.3). */
export interface FileRecord {
  /** Relative to `installHome`, e.g. `plugin/0.1.0/roles/worker.md`. */
  readonly path: string;
  /** Lowercase hex sha256 of the bytes paseo-bm wrote. */
  readonly sha256: string;
  /** Permission bits as written, normally `0o600` (384). */
  readonly mode: number;
}

/** One installed payload version. All are kept; only `--prune` removes any. */
export interface VersionRecord {
  readonly version: string;
  /** Relative to `installHome`, e.g. `plugin/0.1.0`. */
  readonly dir: string;
  readonly installedAt: string;
  /** At most one version is active at a time. */
  readonly active: boolean;
}

/** One backup directory, so it can be listed and restored. */
export interface BackupRecord {
  readonly at: string;
  /** Relative to `installHome`, e.g. `backups/20260915T101500Z`. */
  readonly dir: string;
  readonly reason: string;
}

/** One line of the last skills probe: is this skill present for this agent. */
export interface SkillsStatusRecord {
  readonly agent: string;
  readonly skill: string;
  readonly present: boolean;
}

/** How the last assisted `skills` run ended; `null` when there was none. */
export type SkillsAssistOutcome = "ok" | "failed" | "interrupted" | null;

/** Every outcome a `skills` assist may be recorded with. */
export const SKILLS_ASSIST_OUTCOMES = ["ok", "failed", "interrupted"] as const;

/**
 * The skills section. paseo-bm only remembers *decisions and observations*
 * here — never the output of the third-party CLI, which could quote anything.
 */
export interface SkillsRecord {
  /** Agents the user chose for the `skills` CLI, e.g. `["claude", "codex"]`. */
  readonly agents: readonly string[];
  readonly lastStatus: readonly SkillsStatusRecord[];
  /** When the user said "do not ask again"; `null` while they have not. */
  readonly assistDeclinedAt: string | null;
  /** The exact command paseo-bm ran on the user's behalf. */
  readonly lastCommand: string | null;
  readonly assistOutcome: SkillsAssistOutcome;
}

/** `install.json`, schema v1 (Design §5.2). */
export interface InstallRecord {
  readonly schemaVersion: typeof RECORD_SCHEMA_VERSION | typeof MIGRATED_RECORD_SCHEMA_VERSION;
  /** The npm package version that wrote this record. */
  readonly version: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  /** Absolute path of the install home that was used. */
  readonly installHome: string;
  readonly paseo: PaseoRecord;
  readonly roles: readonly RoleRecord[];
  readonly files: readonly FileRecord[];
  readonly versions: readonly VersionRecord[];
  readonly backups: readonly BackupRecord[];
  readonly skills: SkillsRecord;
  /**
   * Set once `paseo-bm migrate` has switched this install to the npm plugin.
   * Absent on every record a 0.3.x install wrote.
   */
  readonly migratedTo?: MigratedToRecord | undefined;
}

/** Why a record could not be used. Only `schema-too-new` has a registry code. */
export type RecordErrorReason = "unreadable" | "not-json" | "invalid" | "schema-too-new";

/**
 * A refusal to read or write a record. It always names the file and, when the
 * problem is a field, the JSON path of that field — "install.json is broken" is
 * not something a user can act on; `paseo.mcpInject.previous.value` is.
 *
 * Raising this never changes anything on disk: validation happens before any
 * write, and reading a damaged record leaves it untouched (ADR-002 decision 1).
 */
export class RecordError extends Error {
  readonly reason: RecordErrorReason;
  /** The diagnostic code, for the reporter. Only set for `schema-too-new`. */
  readonly code: ErrorCode | undefined;
  /** What the user can do about it, when there is a registry entry. */
  readonly remediation: string | undefined;
  /** The record file, when the problem came from one. */
  readonly path: string | undefined;
  /** JSON path of the offending field, e.g. `roles[1].model`. */
  readonly field: string | undefined;
  /** The `schemaVersion` found, for `schema-too-new`. */
  readonly foundSchemaVersion: number | undefined;

  constructor(details: {
    reason: RecordErrorReason;
    message: string;
    code?: ErrorCode;
    remediation?: string;
    path?: string | undefined;
    field?: string | undefined;
    foundSchemaVersion?: number;
    cause?: unknown;
  }) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RecordError";
    this.reason = details.reason;
    this.code = details.code;
    this.remediation = details.remediation;
    this.path = details.path;
    this.field = details.field;
    this.foundSchemaVersion = details.foundSchemaVersion;
  }
}

/** True when `value` is a {@link RecordError}. */
export function isRecordError(value: unknown): value is RecordError {
  return value instanceof RecordError;
}

/** Context carried into validation so error messages can name the file. */
export interface RecordContext {
  /** The record file the value came from, when it came from one. */
  readonly path?: string | undefined;
}

/** An ISO 8601 UTC instant with millisecond precision, as `Date#toISOString` writes it. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Lowercase hex sha256. Uppercase is refused so two records compare as text. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Every timestamp in the record is written in this one shape. */
export function toIsoUtc(at: Date | string = new Date()): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const time = date.getTime();
  if (Number.isNaN(time)) {
    throw new RecordError({ reason: "invalid", message: `Not a usable timestamp: ${String(at)}` });
  }
  return new Date(time).toISOString();
}

/** True when a string is an ISO 8601 UTC instant this module would write. */
export function isIsoUtc(value: string): boolean {
  return ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
}

/** The `install.json` inside an install home (Design §5.1). */
export function recordPath(installHome: string): string {
  return installPaths(installHome).record;
}

/**
 * Renders a record as the exact text that goes on disk: the field order of
 * Design §5.2, two-space indent, one trailing newline.
 *
 * Every value is copied field by field. That is what makes "the record holds no
 * secret" a structural property rather than a promise — an object carrying an
 * extra `token` key serializes without it.
 */
export function serializeRecord(record: InstallRecord): string {
  const valid = validateRecord(record);
  const document = {
    schemaVersion: valid.schemaVersion,
    version: valid.version,
    installedAt: valid.installedAt,
    updatedAt: valid.updatedAt,
    installHome: valid.installHome,
    paseo: {
      home: valid.paseo.home,
      pluginId: valid.paseo.pluginId,
      pluginDir: valid.paseo.pluginDir,
      pluginsEnabledSetByUs: valid.paseo.pluginsEnabledSetByUs,
      // Optional fields are written only when they carry something, so a
      // record that never used them serializes exactly as before bm-tm2.
      ...(valid.paseo.pluginsEnabledPrevious === undefined
        ? {}
        : {
            pluginsEnabledPrevious: {
              present: valid.paseo.pluginsEnabledPrevious.present,
              value: valid.paseo.pluginsEnabledPrevious.value,
            },
          }),
      mcpInject: {
        setByUs: valid.paseo.mcpInject.setByUs,
        previous: {
          present: valid.paseo.mcpInject.previous.present,
          value: valid.paseo.mcpInject.previous.value,
        },
      },
      ...((valid.paseo.createdConfigContainers ?? []).length === 0
        ? {}
        : { createdConfigContainers: [...(valid.paseo.createdConfigContainers ?? [])] }),
    },
    roles: valid.roles.map((role) => ({
      role: role.role,
      providerId: role.providerId,
      profileId: role.profileId,
      baseProvider: role.baseProvider,
      model: role.model,
      modeId: role.modeId,
      thinkingOptionId: role.thinkingOptionId,
      paseoTools: role.paseoTools,
    })),
    files: valid.files.map((file) => ({ path: file.path, sha256: file.sha256, mode: file.mode })),
    versions: valid.versions.map((version) => ({
      version: version.version,
      dir: version.dir,
      installedAt: version.installedAt,
      active: version.active,
    })),
    backups: valid.backups.map((backup) => ({ at: backup.at, dir: backup.dir, reason: backup.reason })),
    ...(valid.migratedTo === undefined
      ? {}
      : {
          migratedTo: {
            source: valid.migratedTo.source,
            package: valid.migratedTo.package,
            version: valid.migratedTo.version,
            at: valid.migratedTo.at,
          },
        }),
    skills: {
      agents: [...valid.skills.agents],
      lastStatus: valid.skills.lastStatus.map((status) => ({
        agent: status.agent,
        skill: status.skill,
        present: status.present,
      })),
      assistDeclinedAt: valid.skills.assistDeclinedAt,
      lastCommand: valid.skills.lastCommand,
      assistOutcome: valid.skills.assistOutcome,
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Parses record text. Raises instead of guessing at anything malformed. */
export function parseRecord(text: string, context: RecordContext = {}): InstallRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RecordError({
      reason: "not-json",
      message: `${describeFile(context)} is not valid JSON: ${(error as Error).message}. It has not been changed.`,
      path: context.path,
      cause: error,
    });
  }
  return validateRecord(value, context);
}

/**
 * Checks an arbitrary value against schema v1 and returns it typed.
 *
 * The version gate runs first: a record from a newer paseo-bm is refused as a
 * whole, because a field this build does not know about may be the only trace
 * of something that build owns, and acting on a partial reading of it could
 * delete or overwrite it (ADR-002 decision 9).
 *
 * Unknown *extra* keys inside a schema-1 record are ignored rather than
 * refused, and are dropped on the next write.
 */
export function validateRecord(value: unknown, context: RecordContext = {}): InstallRecord {
  const root = asObject(value, "", context, "the install record");
  const schemaVersion = asInteger(root["schemaVersion"], "schemaVersion", context);

  if (schemaVersion > MIGRATED_RECORD_SCHEMA_VERSION) {
    const entry = diagnostic("E_RECORD_SCHEMA_TOO_NEW");
    throw new RecordError({
      reason: "schema-too-new",
      code: entry.code,
      remediation: entry.remediation,
      foundSchemaVersion: schemaVersion,
      message:
        `${entry.message} ${describeFile(context)} declares schemaVersion ${schemaVersion}, ` +
        `but this build understands ${SUPPORTED_RECORD_SCHEMA_VERSIONS.join(" and ")}. ${entry.remediation}`,
      path: context.path,
      field: "schemaVersion",
    });
  }
  if (schemaVersion < 1) {
    throw invalid(`schemaVersion must be at least 1, found ${schemaVersion}`, "schemaVersion", context);
  }

  const paseo = asObject(root["paseo"], "paseo", context);
  const mcpInject = asObject(paseo["mcpInject"], "paseo.mcpInject", context);
  const { present, value: previousValue } = readPrevious(mcpInject["previous"], "paseo.mcpInject.previous", context);
  const pluginsEnabledPrevious =
    paseo["pluginsEnabledPrevious"] === undefined
      ? undefined
      : readPrevious(paseo["pluginsEnabledPrevious"], "paseo.pluginsEnabledPrevious", context);
  const createdConfigContainers =
    paseo["createdConfigContainers"] === undefined
      ? undefined
      : readContainers(paseo["createdConfigContainers"], "paseo.createdConfigContainers", context);

  const skills = asObject(root["skills"], "skills", context);

  const roles = asArray(root["roles"], "roles", context).map((entry, index) =>
    readRole(entry, `roles[${index}]`, context),
  );
  assertUniqueRoles(roles, context);

  const versions = asArray(root["versions"], "versions", context).map((entry, index) =>
    readVersion(entry, `versions[${index}]`, context),
  );
  assertAtMostOneActive(versions, context);

  const migratedTo = root["migratedTo"] === undefined || root["migratedTo"] === null
    ? undefined
    : readMigratedTo(root["migratedTo"], "migratedTo", context);

  return {
    schemaVersion: schemaVersion === MIGRATED_RECORD_SCHEMA_VERSION ? MIGRATED_RECORD_SCHEMA_VERSION : RECORD_SCHEMA_VERSION,
    version: asNonEmptyString(root["version"], "version", context),
    installedAt: asTimestamp(root["installedAt"], "installedAt", context),
    updatedAt: asTimestamp(root["updatedAt"], "updatedAt", context),
    installHome: asAbsolutePath(root["installHome"], "installHome", context),
    paseo: {
      home: asAbsolutePath(paseo["home"], "paseo.home", context),
      pluginId: asNullableNonEmptyString(paseo["pluginId"], "paseo.pluginId", context),
      pluginDir: asNullableAbsolutePath(paseo["pluginDir"], "paseo.pluginDir", context),
      pluginsEnabledSetByUs: asBoolean(
        paseo["pluginsEnabledSetByUs"],
        "paseo.pluginsEnabledSetByUs",
        context,
      ),
      ...(pluginsEnabledPrevious === undefined ? {} : { pluginsEnabledPrevious }),
      mcpInject: {
        setByUs: asBoolean(mcpInject["setByUs"], "paseo.mcpInject.setByUs", context),
        previous: { present, value: previousValue },
      },
      ...(createdConfigContainers === undefined ? {} : { createdConfigContainers }),
    },
    roles,
    files: asArray(root["files"], "files", context).map((entry, index) =>
      readFileEntry(entry, `files[${index}]`, context),
    ),
    versions,
    backups: asArray(root["backups"], "backups", context).map((entry, index) =>
      readBackup(entry, `backups[${index}]`, context),
    ),
    skills: {
      agents: asArray(skills["agents"], "skills.agents", context).map((entry, index) =>
        asNonEmptyString(entry, `skills.agents[${index}]`, context),
      ),
      lastStatus: asArray(skills["lastStatus"], "skills.lastStatus", context).map((entry, index) =>
        readSkillStatus(entry, `skills.lastStatus[${index}]`, context),
      ),
      assistDeclinedAt: asNullableTimestamp(
        skills["assistDeclinedAt"],
        "skills.assistDeclinedAt",
        context,
      ),
      lastCommand: asNullableNonEmptyString(skills["lastCommand"], "skills.lastCommand", context),
      assistOutcome: readAssistOutcome(skills["assistOutcome"], "skills.assistOutcome", context),
    },
    ...(migratedTo === undefined ? {} : { migratedTo }),
  };
}

/** `migratedTo`, the one field only the migration writes. */
function readMigratedTo(value: unknown, field: string, context: RecordContext): MigratedToRecord {
  const entry = asObject(value, field, context);
  const source = asNonEmptyString(entry["source"], `${field}.source`, context);
  if (source !== "npm") {
    throw invalid(`${field}.source must be "npm", found ${JSON.stringify(source)}`, `${field}.source`, context);
  }
  return {
    source: "npm",
    package: asNonEmptyString(entry["package"], `${field}.package`, context),
    version: asNonEmptyString(entry["version"], `${field}.version`, context),
    at: asTimestamp(entry["at"], `${field}.at`, context),
  };
}

export interface RecordIoOptions {
  /** Overrides `<install home>/install.json`. */
  readonly path?: string;
}

/**
 * Reads the record, or `undefined` when there is none — which means "paseo-bm
 * is not installed here", not "everything on disk is ours".
 *
 * Anything present but unusable raises: a damaged record is never treated as a
 * missing one, because that would hand the installer a clean slate and let it
 * overwrite files the record was the only evidence for.
 */
export async function readRecord(
  fsops: FsOps,
  options: RecordIoOptions = {},
): Promise<InstallRecord | undefined> {
  const target = options.path === undefined ? recordPath(fsops.root) : fsops.resolvePath(options.path);

  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw new RecordError({
      reason: "unreadable",
      message: `Could not read the install record at ${target}: ${(error as Error).message}. Nothing has been changed.`,
      path: target,
      cause: error,
    });
  }

  return parseRecord(text, { path: target });
}

/**
 * Writes the record atomically at mode `0600`. The record is validated first,
 * so an invalid one never reaches the file and the previous record survives.
 */
export async function writeRecord(
  fsops: FsOps,
  record: InstallRecord,
  options: RecordIoOptions = {},
): Promise<WriteResult> {
  const target = options.path === undefined ? recordPath(fsops.root) : options.path;
  const text = serializeRecord(record);
  return fsops.writeFileAtomic(target, text, { mode: FILE_MODE });
}

/**
 * `{ present, value }` of one key. The whole point of storing it instead of a
 * boolean is that "absent" and "false" are different, so a value that claims
 * both — or neither — is refused: it could not be undone faithfully.
 */
function readPrevious(value: unknown, field: string, context: RecordContext): PreviousKeyState {
  const entry = asObject(value, field, context);
  const present = asBoolean(entry["present"], `${field}.present`, context);
  const previousValue = asNullableBoolean(entry["value"], `${field}.value`, context);
  if (!present && previousValue !== null) {
    throw invalid(
      `${field} says the key was absent but still records the value ${String(previousValue)}; ` +
        "an absent key must record `value: null`",
      `${field}.value`,
      context,
    );
  }
  if (present && previousValue === null) {
    throw invalid(`${field} says the key was present but records no value`, `${field}.value`, context);
  }
  return { present, value: previousValue };
}

/** A list of container paths from the closed set, deduplicated, in canonical order. */
function readContainers(value: unknown, field: string, context: RecordContext): ConfigContainerPath[] {
  const found = new Set<ConfigContainerPath>();
  for (const [index, entry] of asArray(value, field, context).entries()) {
    const path = asNonEmptyString(entry, `${field}[${index}]`, context);
    if (!isConfigContainerPath(path)) {
      throw invalid(
        `${field}[${index}] must be one of ${CONFIG_CONTAINER_PATHS.join(", ")}, found ${JSON.stringify(path)}`,
        `${field}[${index}]`,
        context,
      );
    }
    found.add(path);
  }
  return CONFIG_CONTAINER_PATHS.filter((path) => found.has(path));
}

function readRole(value: unknown, field: string, context: RecordContext): RoleRecord {
  const entry = asObject(value, field, context);
  const role = asNonEmptyString(entry["role"], `${field}.role`, context);
  if (!isRoleName(role)) {
    throw invalid(
      `${field}.role must be one of ${ROLE_NAMES.join(", ")}, found ${JSON.stringify(role)}`,
      `${field}.role`,
      context,
    );
  }
  return {
    role,
    providerId: asNonEmptyString(entry["providerId"], `${field}.providerId`, context),
    profileId: asNonEmptyString(entry["profileId"], `${field}.profileId`, context),
    baseProvider: asNonEmptyString(entry["baseProvider"], `${field}.baseProvider`, context),
    model: asNonEmptyString(entry["model"], `${field}.model`, context),
    modeId: asNullableNonEmptyString(entry["modeId"], `${field}.modeId`, context),
    thinkingOptionId: asNullableNonEmptyString(
      entry["thinkingOptionId"],
      `${field}.thinkingOptionId`,
      context,
    ),
    paseoTools: asBoolean(entry["paseoTools"], `${field}.paseoTools`, context),
  };
}

function readFileEntry(value: unknown, field: string, context: RecordContext): FileRecord {
  const entry = asObject(value, field, context);
  const digest = asNonEmptyString(entry["sha256"], `${field}.sha256`, context);
  if (!SHA256_HEX.test(digest)) {
    throw invalid(
      `${field}.sha256 must be 64 lowercase hex characters, found ${JSON.stringify(digest)}`,
      `${field}.sha256`,
      context,
    );
  }
  const mode = asInteger(entry["mode"], `${field}.mode`, context);
  if (mode < 0 || mode > 0o7777) {
    throw invalid(`${field}.mode must be permission bits between 0 and 4095, found ${mode}`, `${field}.mode`, context);
  }
  return { path: asRelativePath(entry["path"], `${field}.path`, context), sha256: digest, mode };
}

function readVersion(value: unknown, field: string, context: RecordContext): VersionRecord {
  const entry = asObject(value, field, context);
  return {
    version: asNonEmptyString(entry["version"], `${field}.version`, context),
    dir: asRelativePath(entry["dir"], `${field}.dir`, context),
    installedAt: asTimestamp(entry["installedAt"], `${field}.installedAt`, context),
    active: asBoolean(entry["active"], `${field}.active`, context),
  };
}

function readBackup(value: unknown, field: string, context: RecordContext): BackupRecord {
  const entry = asObject(value, field, context);
  return {
    at: asTimestamp(entry["at"], `${field}.at`, context),
    dir: asRelativePath(entry["dir"], `${field}.dir`, context),
    reason: asNonEmptyString(entry["reason"], `${field}.reason`, context),
  };
}

function readSkillStatus(value: unknown, field: string, context: RecordContext): SkillsStatusRecord {
  const entry = asObject(value, field, context);
  return {
    agent: asNonEmptyString(entry["agent"], `${field}.agent`, context),
    skill: asNonEmptyString(entry["skill"], `${field}.skill`, context),
    present: asBoolean(entry["present"], `${field}.present`, context),
  };
}

function readAssistOutcome(value: unknown, field: string, context: RecordContext): SkillsAssistOutcome {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && (SKILLS_ASSIST_OUTCOMES as readonly string[]).includes(value)) {
    return value as Exclude<SkillsAssistOutcome, null>;
  }
  throw invalid(
    `${field} must be null or one of ${SKILLS_ASSIST_OUTCOMES.join(", ")}, found ${describe(value)}`,
    field,
    context,
  );
}

/** One entry per role at most: two `worker` rows would make ownership ambiguous. */
function assertUniqueRoles(roles: readonly RoleRecord[], context: RecordContext): void {
  const seen = new Set<RoleName>();
  for (const [index, role] of roles.entries()) {
    if (seen.has(role.role)) {
      throw invalid(`roles[${index}].role repeats ${role.role}; each role may appear once`, `roles[${index}].role`, context);
    }
    seen.add(role.role);
  }
}

/** Exactly one payload version can be the one Paseo has registered. */
function assertAtMostOneActive(versions: readonly VersionRecord[], context: RecordContext): void {
  const active = versions.filter((version) => version.active);
  if (active.length > 1) {
    throw invalid(
      `versions[] marks ${active.length} versions active (${active.map((v) => v.version).join(", ")}); only one may be`,
      "versions",
      context,
    );
  }
}

function invalid(message: string, field: string | undefined, context: RecordContext): RecordError {
  return new RecordError({
    reason: "invalid",
    message: `${describeFile(context)} is not a valid install record: ${message}. It has not been changed.`,
    path: context.path,
    field,
  });
}

function describeFile(context: RecordContext): string {
  return context.path === undefined ? "The install record" : `The install record at ${context.path}`;
}

function describe(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `${typeof value} ${JSON.stringify(value)}`;
}

function asObject(
  value: unknown,
  field: string,
  context: RecordContext,
  label = field,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object, found ${describe(value)}`, field === "" ? undefined : field, context);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string, context: RecordContext): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${field} must be an array, found ${describe(value)}`, field, context);
  }
  return value;
}

function asBoolean(value: unknown, field: string, context: RecordContext): boolean {
  if (typeof value !== "boolean") {
    throw invalid(`${field} must be a boolean, found ${describe(value)}`, field, context);
  }
  return value;
}

function asNullableBoolean(value: unknown, field: string, context: RecordContext): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asBoolean(value, field, context);
}

function asInteger(value: unknown, field: string, context: RecordContext): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(`${field} must be an integer, found ${describe(value)}`, field, context);
  }
  return value;
}

function asNonEmptyString(value: unknown, field: string, context: RecordContext): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid(`${field} must be a non-empty string, found ${describe(value)}`, field, context);
  }
  return value;
}

function asNullableNonEmptyString(value: unknown, field: string, context: RecordContext): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asNonEmptyString(value, field, context);
}

function asTimestamp(value: unknown, field: string, context: RecordContext): string {
  const text = asNonEmptyString(value, field, context);
  if (!isIsoUtc(text)) {
    throw invalid(
      `${field} must be an ISO 8601 UTC timestamp such as 2026-09-15T10:15:00.000Z, found ${JSON.stringify(text)}`,
      field,
      context,
    );
  }
  return text;
}

function asNullableTimestamp(value: unknown, field: string, context: RecordContext): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asTimestamp(value, field, context);
}

function asAbsolutePath(value: unknown, field: string, context: RecordContext): string {
  const text = asNonEmptyString(value, field, context);
  if (!isAbsolute(text)) {
    throw invalid(`${field} must be an absolute path, found ${JSON.stringify(text)}`, field, context);
  }
  return text;
}

/**
 * Paths inside the record are relative to `installHome`. Absolute values and
 * `..` segments are refused: the record must never be able to point the
 * installer, the pruner or the uninstaller at something outside the one
 * directory paseo-bm owns.
 */
function asRelativePath(value: unknown, field: string, context: RecordContext): string {
  const text = asNonEmptyString(value, field, context);
  if (isAbsolute(text)) {
    throw invalid(
      `${field} must be relative to the install home, found the absolute path ${JSON.stringify(text)}`,
      field,
      context,
    );
  }
  const segments = text.split("/");
  if (segments.includes("..")) {
    throw invalid(
      `${field} must stay inside the install home, found ${JSON.stringify(text)}`,
      field,
      context,
    );
  }
  return text;
}

function asNullableAbsolutePath(value: unknown, field: string, context: RecordContext): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return asAbsolutePath(value, field, context);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
