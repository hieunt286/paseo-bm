/**
 * The report model: `Action`, `Check`, and the envelope both renderers read.
 *
 * The architectural rule this file exists to enforce is that the planner
 * produces `Action`s and the applier consumes them. A preview is therefore just
 * "run the planner and print the result" — there is no second code path that
 * could describe the work differently from the way it is performed (REQ-003,
 * REQ-009). Anything a preview needs to say must live in this model, never in
 * ad-hoc strings assembled by whoever happened to print it.
 *
 * `src/report/human.ts` and `src/report/json.ts` are the only two renderers.
 * Both take a `Report` and a sink; neither writes to `process.stdout` itself.
 *
 * Shapes here follow Technical Design §4.4 (JSON), §3.3 (ownership statuses)
 * and §3.4 (the config keys paseo-bm owns).
 */

import type { WarningCode } from "./errors.js";
import type { ExitCode } from "./exit-codes.js";
import type { CommandName } from "./flags.js";

/** Any value that survives a round trip through JSON. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A JSON object, the shape of a rendered document. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * What an action does, Design §4.4.
 *
 * `create` / `update` / `skip` / `conflict` come from an install plan;
 * `delete` / `keep` / `config` are what an uninstall plan uses (`config` is
 * shared: both commands edit the keys of §3.4).
 */
export const ACTION_KINDS = ["create", "update", "skip", "conflict", "delete", "keep", "config"] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** Kinds that change something. `skip`, `keep` and `conflict` leave the target alone. */
export const WRITING_ACTION_KINDS: readonly ActionKind[] = ["create", "update", "delete", "config"];

/**
 * Where an action lands. The human renderer groups by this, so the user reads
 * one block per place on their machine that is about to change, and the set is
 * closed: paseo-bm only writes inside its install home and the config keys of
 * Design §3.4 (§7, "write scope of the installer").
 */
export const ACTION_LOCATIONS = ["install-home", "paseo-config", "paseo-daemon", "agent-skills"] as const;

export type ActionLocation = (typeof ACTION_LOCATIONS)[number];

/** Heading for a location block in the human report. */
export const ACTION_LOCATION_LABELS: Readonly<Record<ActionLocation, string>> = {
  "install-home": "Install home",
  "paseo-config": "Paseo config",
  "paseo-daemon": "Paseo daemon",
  "agent-skills": "Agent skills",
};

/**
 * The ownership statuses of Design §3.3, which are the reasons a file action
 * carries. `reason` is a free string because uninstall and config actions need
 * reasons this table does not cover; these are the values a file plan uses.
 */
export const FILE_STATUS_REASONS = ["unchanged", "outdated", "user-modified", "conflict", "missing"] as const;

export type FileStatusReason = (typeof FILE_STATUS_REASONS)[number];

interface ActionFields {
  /**
   * What is being acted on, written the way Design §4.4 writes it: a path
   * rooted at a named home (`installHome/plugin/0.1.0/roles/worker.md`) or a
   * config key (`paseoHome/config.json#daemon.agentProfiles[bm-worker]`).
   * Keeping the root symbolic keeps reports stable and free of `$HOME`.
   */
  readonly target: string;
  readonly location: ActionLocation;
  /** Why, in one lower-case word or phrase; see `FILE_STATUS_REASONS`. */
  readonly reason: string;
  /** Optional extra sentence for the human report; never parsed. */
  readonly detail?: string;
}

/** An action on a file or on a registration that is created, removed or left alone. */
export interface FileAction extends ActionFields {
  readonly kind: Exclude<ActionKind, "config">;
}

/** An edit to a single configuration key, Design §3.4. */
export interface ConfigAction extends ActionFields {
  readonly kind: "config";
  /** Value before the edit; `null` when the key was absent. */
  readonly from: JsonValue;
  /** Value after the edit. */
  readonly to: JsonValue;
  /**
   * How consent for this edit was obtained. Design §4.4 shows `"interactive"`
   * but never pins the full vocabulary, so this stays a pass-through string
   * rather than an invented enum.
   */
  readonly consent?: string;
}

export type Action = FileAction | ConfigAction;

/** Narrow to the `config` variant, which is the only one with `from` / `to`. */
export function isConfigAction(action: Action): action is ConfigAction {
  return action.kind === "config";
}

/** True when this action would change something. */
export function isWritingAction(action: Action): boolean {
  return WRITING_ACTION_KINDS.includes(action.kind);
}

/** Counts a preview needs in order to describe itself honestly. */
export interface ActionSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<ActionKind, number>>;
  /** True when at least one action would write. */
  readonly writes: boolean;
  /** True when at least one action needs a human decision (Design §3.3, exit code 5). */
  readonly conflicts: boolean;
}

export function summarizeActions(actions: readonly Action[]): ActionSummary {
  const byKind: Record<ActionKind, number> = {
    create: 0,
    update: 0,
    skip: 0,
    conflict: 0,
    delete: 0,
    keep: 0,
    config: 0,
  };
  for (const action of actions) {
    byKind[action.kind] += 1;
  }
  return {
    total: actions.length,
    byKind,
    writes: actions.some(isWritingAction),
    conflicts: byKind.conflict > 0,
  };
}

/** One block of the human report: every action landing in the same place. */
export interface ActionGroup {
  readonly location: ActionLocation;
  readonly label: string;
  readonly actions: readonly Action[];
}

/**
 * Group actions by destination, in the fixed order of `ACTION_LOCATIONS` and,
 * inside a group, in planner order. Empty locations are dropped, so a report
 * never shows a heading with nothing under it.
 */
export function groupActionsByLocation(actions: readonly Action[]): readonly ActionGroup[] {
  const groups: ActionGroup[] = [];
  for (const location of ACTION_LOCATIONS) {
    const matching = actions.filter((action) => action.location === location);
    if (matching.length > 0) {
      groups.push({ location, label: ACTION_LOCATION_LABELS[location], actions: matching });
    }
  }
  return groups;
}

/** Severity of a `doctor` check, Design §4.4. */
export const CHECK_SEVERITIES = ["ok", "warn", "error"] as const;

export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

/**
 * What `doctor` reports instead of actions. `doctor` never writes, so it has no
 * plan; it has findings, each with the fix the user can apply themselves.
 */
export interface Check {
  /** Stable identifier of the check, e.g. `plugin-status`. */
  readonly id: string;
  readonly severity: CheckSeverity;
  readonly message: string;
  /** What the user can do about it; empty for a check that passed. */
  readonly remediation: string;
}

/** True when a check needs the drift exit code (1); warnings never do. */
export function hasCheckErrors(checks: readonly Check[]): boolean {
  return checks.some((check) => check.severity === "error");
}

/** Counts per severity, for the summary line of the human report. */
export function summarizeChecks(checks: readonly Check[]): Readonly<Record<CheckSeverity, number>> {
  const counts: Record<CheckSeverity, number> = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) {
    counts[check.severity] += 1;
  }
  return counts;
}

/** `preview` — nothing was written; `applied` — the plan was carried out. */
export type ReportMode = "preview" | "applied";

/**
 * Facts about the Paseo installation the run talked to. Versions and home are
 * nullable because `doctor` still reports when the daemon does not answer.
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
  /** Whether this role is granted Paseo tool access (trust boundary 3, §7). */
  readonly paseoTools: boolean;
  /** Whether the provider has a login session; `null` when it could not be told. */
  readonly loggedIn: boolean | null;
}

/** Skill presence for one agent. */
export interface SkillsByAgent {
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

/** Outcome of a `skills` run paseo-bm made on the user's behalf (Design §3.2). */
export type SkillsAssistOutcome = "ok" | "failed" | "interrupted" | null;

/**
 * The skills section. `null` in the report when `--skip-skills-check` removed
 * the step, so the key is always present and always tells the truth.
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
}

/** Fields every report carries, Design §4.4. */
export interface ReportBase {
  readonly schemaVersion: 1;
  readonly command: CommandName;
  readonly mode: ReportMode;
  readonly paseoBmVersion: string;
  readonly paseo: PaseoFacts;
  readonly roles: readonly RoleReport[];
  readonly skills: SkillsReport | null;
  readonly warnings: readonly ReportWarning[];
  readonly result: ReportResult;
}

/** `install` and `uninstall`: a plan, previewed or applied. */
export interface PlanReport extends ReportBase {
  readonly command: "install" | "uninstall";
  readonly actions: readonly Action[];
}

/** `doctor`: findings instead of actions, and always `preview` since it never writes. */
export interface DoctorReport extends ReportBase {
  readonly command: "doctor";
  readonly mode: "preview";
  readonly checks: readonly Check[];
}

export type Report = PlanReport | DoctorReport;

export function isDoctorReport(report: Report): report is DoctorReport {
  return report.command === "doctor";
}

/** The JSON document version of Design §4.4. Bumping it is a breaking change. */
export const REPORT_SCHEMA_VERSION = 1;
