/**
 * Machine renderer — Technical Design §4.4.
 *
 * With `--json`, stdout carries exactly one JSON document and nothing else:
 * no progress lines, no child-process output, no trailing chatter. Everything
 * else a run wants to say goes to stderr. That is why this module renders into
 * a sink handed to it rather than calling `console.log`: a test can assert that
 * the stdout sink received one parseable document, and a caller physically
 * cannot interleave a log line into it.
 *
 * The document is built key by key, in the order Design §4.4 lists, so the
 * output is stable enough to snapshot and to diff between releases.
 */

import { DIAGNOSTICS } from "../errors.js";
import { REPORT_SCHEMA_VERSION, isConfigAction, isDoctorReport } from "../action.js";
import type { Action, Check, JsonObject, JsonValue, Report, ReportWarning, SkillsReport } from "../action.js";

/** Anything that accepts text: `process.stdout.write`, a test buffer, a pipe. */
export type OutputWriter = (chunk: string) => void;

export interface JsonRenderOptions {
  /** Spaces per indent level; `0` renders one compact line. Default 2. */
  readonly indent?: number;
  /**
   * Last-pass filter over the finished document text. This is the seam where
   * secret masking is installed (its own bead); nothing here masks anything.
   */
  readonly redact?: (text: string) => string;
}

/**
 * Build the document. Pure: no clock, no environment, no I/O — the same report
 * always renders the same object.
 */
export function toJsonDocument(report: Report): JsonObject {
  const document: Record<string, JsonValue> = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    command: report.command,
    mode: report.mode,
    paseoBmVersion: report.paseoBmVersion,
    paseo: {
      cliVersion: report.paseo.cliVersion,
      daemonVersion: report.paseo.daemonVersion,
      home: report.paseo.home,
      pluginsEnabled: report.paseo.pluginsEnabled,
    },
  };

  // doctor reports findings; install and uninstall report a plan. Exactly one
  // of the two keys is present, so a consumer cannot read an empty plan as "no
  // work" when it is really looking at a health check.
  if (isDoctorReport(report)) {
    document.checks = report.checks.map(checkToJson);
  } else {
    document.actions = report.actions.map(actionToJson);
  }

  document.roles = report.roles.map((role) => ({
    role: role.role,
    provider: role.provider,
    model: role.model,
    paseoTools: role.paseoTools,
    loggedIn: role.loggedIn,
  }));
  document.skills = report.skills === null ? null : skillsToJson(report.skills);
  document.warnings = report.warnings.map(warningToJson);
  document.result = {
    exitCode: report.result.exitCode,
    pluginState: report.result.pluginState,
  };

  return document;
}

function actionToJson(action: Action): JsonObject {
  const base: Record<string, JsonValue> = {
    kind: action.kind,
    target: action.target,
    reason: action.reason,
  };
  if (isConfigAction(action)) {
    base.from = action.from;
    base.to = action.to;
    if (action.consent !== undefined) {
      base.consent = action.consent;
    }
  }
  if (action.detail !== undefined) {
    base.detail = action.detail;
  }
  return base;
}

function checkToJson(check: Check): JsonObject {
  return {
    id: check.id,
    severity: check.severity,
    message: check.message,
    remediation: check.remediation,
  };
}

function skillsToJson(skills: SkillsReport): JsonObject {
  const byAgent: Record<string, JsonValue> = {};
  for (const agent of Object.keys(skills.byAgent).sort()) {
    const entry = skills.byAgent[agent];
    if (entry === undefined) continue;
    byAgent[agent] = { present: [...entry.present], missing: [...entry.missing] };
  }
  return {
    source: skills.source,
    required: [...skills.required],
    byAgent,
    suggestedCommand: skills.suggestedCommand,
    assisted: skills.assisted,
    outcome: skills.outcome,
  };
}

/**
 * Warnings carry only a code; the wording comes from the registry, so two runs
 * can never describe the same code differently. The rendered shape is exactly
 * the `{ code, message }` of Design §4.4 — the remediation text stays in the
 * registry, where `doctor`'s `checks[]` and the human report read it from.
 */
function warningToJson(warning: ReportWarning): JsonObject {
  const entry = DIAGNOSTICS[warning.code];
  const json: Record<string, JsonValue> = {
    code: entry.code,
    message: entry.message,
  };
  if (warning.detail !== undefined) {
    json.detail = warning.detail;
  }
  return json;
}

/** Serialize the report as exactly one JSON document, ending in one newline. */
export function renderJsonReport(report: Report, options: JsonRenderOptions = {}): string {
  const indent = options.indent ?? 2;
  const text = `${JSON.stringify(toJsonDocument(report), null, indent)}\n`;
  return options.redact === undefined ? text : options.redact(text);
}

/**
 * Write the one document to the given sink. Handlers call this instead of
 * printing, which is what keeps stdout single-document under `--json`.
 */
export function writeJsonReport(report: Report, stdout: OutputWriter, options?: JsonRenderOptions): void {
  stdout(renderJsonReport(report, options));
}
