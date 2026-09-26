/**
 * The report model: the `Action`s the migration plans, and the envelope the
 * renderer reads.
 *
 * The architectural rule this file exists to enforce is that the planner
 * produces `Action`s and the applier consumes them. A preview is therefore just
 * "run the planner and print the result" — there is no second code path that
 * could describe the work differently from the way it is performed (REQ-003,
 * REQ-009). Anything a preview needs to say must live in this model, never in
 * ad-hoc strings assembled by whoever happened to print it.
 *
 * `src/report/json.ts` is the only renderer. It takes a `Report` and a sink;
 * it never writes to `process.stdout` itself.
 *
 * 0.4.0 shrank this model to what one command emits. The install and uninstall
 * plans, the `doctor` findings and the human renderer went with the commands
 * that produced them (ADR-012), and so did everything here that only they used:
 * config actions, the `skip` / `conflict` / `delete` / `keep` kinds, the
 * per-location grouping, and the plan and check summaries. Shapes follow
 * Technical Design §4.4.
 */

import type { ErrorCode, WarningCode } from "./errors.js";
import type { ExitCode } from "./exit-codes.js";
import type { CommandName } from "./flags.js";

/** Any value that survives a round trip through JSON. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A JSON object, the shape of a rendered document. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * What an action does, Design §4.4.
 *
 * `create` and `update` are files the migration writes; `plugin` is the
 * registration it moves. Nothing in 0.4.0 plans an action it then declines to
 * perform, so there is no kind for one.
 */
export const ACTION_KINDS = ["create", "update", "plugin"] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

interface ActionFields {
  /**
   * What is being acted on, written the way Design §4.4 writes it: an absolute
   * path, or the plugin id for the registration.
   */
  readonly target: string;
  /** Why, in one lower-case word or phrase. */
  readonly reason: string;
  /** Optional extra sentence, never parsed. */
  readonly detail?: string;
}

/** An action on a file the migration writes. */
export interface FileAction extends ActionFields {
  readonly kind: Exclude<ActionKind, "plugin">;
}

/**
 * The plugin registration moving from one source to another (0.4.0, §4.4).
 *
 * `from` and `to` are the two sources as Paseo names them — a directory path
 * and `npm:<package>@<version>` — because "the plugin was re-registered" is not
 * something a reader can check without both.
 */
export interface PluginAction extends ActionFields {
  readonly kind: "plugin";
  readonly from: string;
  readonly to: string;
}

export type Action = FileAction | PluginAction;

/** Narrow to the one variant with `from` / `to`. */
export function isPluginAction(action: Action): action is PluginAction {
  return action.kind === "plugin";
}

/** `preview` — nothing was written; `applied` — the plan was carried out. */
export type ReportMode = "preview" | "applied";

/**
 * Facts about the Paseo installation the run talked to. Versions and home are
 * nullable because a run still reports when the daemon does not answer.
 */
export interface PaseoFacts {
  readonly cliVersion: string | null;
  readonly daemonVersion: string | null;
  readonly home: string | null;
  readonly pluginsEnabled: boolean;
}

/** One configured agent role, Design §4.4. */
export interface RoleReport {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  /** Whether this role is granted Paseo tool access (trust boundary 3, Design §9). */
  readonly paseoTools: boolean;
  /** Whether the provider has a login session; `null` when it could not be told. */
  readonly loggedIn: boolean | null;
}

/** Skill presence for one agent. */
export interface SkillsByAgent {
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

/** Outcome of a `skills` run paseo-bm made on the user's behalf (Design §5.2). */
export type SkillsAssistOutcome = "ok" | "failed" | "interrupted" | null;

/**
 * The skills section, `null` when the run has nothing to say about skills —
 * which in 0.4.0 is always, because the plugin's Setup screen owns skills now.
 * The key stays in the document so a reader of §4.4 finds it where it was.
 */
export interface SkillsReport {
  readonly source: string;
  readonly required: readonly string[];
  readonly byAgent: Readonly<Record<string, SkillsByAgent>>;
  /** The exact command the user can run themselves; `null` when nothing is missing. */
  readonly suggestedCommand: string | null;
  /** True when paseo-bm ran that command after consent. */
  readonly assisted: boolean;
  readonly outcome: SkillsAssistOutcome;
}

/**
 * A warning. Only the code is stored: the message and remediation come from the
 * registry in `src/errors.ts`, so no caller can invent wording for a code.
 * `detail` adds run-specific context (which agent, which path).
 */
export interface ReportWarning {
  readonly code: WarningCode;
  readonly detail?: string;
}

/** How the run ended. */
export interface ReportResult {
  readonly exitCode: ExitCode;
  /**
   * Paseo's own `status` for the plugin — `running` or `disabled` on a live
   * daemon. `null` when the plugin is not registered or could not be read.
   * Never derived from the plugin's `enabled` field, which is always true.
   */
  readonly pluginState: string | null;
  /**
   * Present only when the run failed with a registry error (Design §4.4 errata
   * 2026-09-15): the code scripts match on, and its message. Omitted on success.
   */
  readonly error?: ReportError | undefined;
}

/** The failure a run ended with, as carried in `result.error`. */
export interface ReportError {
  readonly code: ErrorCode;
  readonly message: string;
}

/** Fields every report carries, Design §4.4. */
export interface ReportBase {
  readonly schemaVersion: 1;
  readonly command: CommandName;
  readonly mode: ReportMode;
  readonly paseoBmVersion: string;
  readonly paseo: PaseoFacts;
  /**
   * Always empty in 0.4.0, and always `null`: roles and skills are the plugin's
   * Setup screen now, not the CLI's. Both keys stay in the document because
   * §4.4 keeps the schema-1 frame of the old report — so a 0.3.x script reading
   * `--json` still finds them where they were, rather than crashing on a key
   * that vanished.
   */
  readonly roles: readonly RoleReport[];
  readonly skills: SkillsReport | null;
  readonly warnings: readonly ReportWarning[];
  readonly result: ReportResult;
}

/** What the migration did, and to what (design §4.4, 0.4.0). */
export type MigrationOutcomeName =
  | "migrated"
  | "already-npm"
  | "no-directory-install"
  | "not-ours"
  | "fell-back"
  | "fallback-failed"
  | "remove-failed";

export interface MigrationReport {
  readonly outcome: MigrationOutcomeName;
  /** The directory Paseo loaded the plugin from, or `null`. */
  readonly from: string | null;
  /** `npm:paseo-bm-plugin@<version>`. */
  readonly to: string;
  /** Present only when the switch failed and the old install was put back, or not. */
  readonly fallback: { readonly outcome: "fell-back" | "fallback-failed"; readonly detail: string } | null;
}

/**
 * `migrate`: a plan plus what happened to the plugin registration.
 *
 * `command` is always `"migrate"`, even when the user typed `paseo-bm` or
 * `paseo-bm install`: the report says what ran, not what was typed.
 */
export interface MigrateReport extends ReportBase {
  readonly command: "migrate";
  readonly actions: readonly Action[];
  readonly migration: MigrationReport;
}

/** The only report 0.4.0 renders. */
export type Report = MigrateReport;

export function isMigrateReport(report: Report): report is MigrateReport {
  return report.command === "migrate";
}

/** The JSON document version of Design §4.4. Bumping it is a breaking change. */
export const REPORT_SCHEMA_VERSION = 1;
