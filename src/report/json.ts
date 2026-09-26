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
import { createJsonRedactor } from "../redact.js";
import type { Redactor } from "../redact.js";
import { REPORT_SCHEMA_VERSION, isMigrateReport, isPluginAction } from "../action.js";
import type { Action, JsonObject, JsonValue, Report, ReportWarning, SkillsReport } from "../action.js";

/** Anything that accepts text: `process.stdout.write`, a test buffer, a pipe. */
export type OutputWriter = (chunk: string) => void;

export interface JsonRenderOptions {
  /** Spaces per indent level; `0` renders one compact line. Default 2. */
  readonly indent?: number;
  /**
   * Last-pass filter over the finished document text — the single place this
   * channel can mask a secret. Defaults to {@link createJsonRedactor}, which
   * masks inside the values so the result is still exactly one parseable
   * document; pass `(text) => text` only in a test that wants the raw
   * rendering.
   */
  readonly redact?: Redactor;
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

  document.actions = report.actions.map(actionToJson);

  // The migration is the one command whose outcome is not readable from the
  // actions alone: "the plugin was switched" and "the switch failed and the old
  // one is back" look the same from a list of files.
  if (isMigrateReport(report)) {
    document.migration = {
      outcome: report.migration.outcome,
      from: report.migration.from,
      to: report.migration.to,
      fallback:
        report.migration.fallback === null
          ? null
          : { outcome: report.migration.fallback.outcome, detail: report.migration.fallback.detail },
    };
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
  const result: Record<string, JsonValue> = {
    exitCode: report.result.exitCode,
    pluginState: report.result.pluginState,
  };
  // Only a failed run carries an error; a success omits the key entirely, so
  // `"error" in result` is a reliable test for failure.
  if (report.result.error !== undefined) {
    result.error = { code: report.result.error.code, message: report.result.error.message };
  }
  document.result = result;

  return document;
}

function actionToJson(action: Action): JsonObject {
  const base: Record<string, JsonValue> = {
    kind: action.kind,
    target: action.target,
    reason: action.reason,
  };
  if (isPluginAction(action)) {
    base.from = action.from;
    base.to = action.to;
  }
  if (action.detail !== undefined) {
    base.detail = action.detail;
  }
  return base;
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
 * registry, which is where `src/preflight.ts` reads it from when a warning
 * becomes a line a human has to act on.
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
  const redact = options.redact ?? createJsonRedactor({ indent });
  return redact(text);
}

/**
 * Write the one document to the given sink. Handlers call this instead of
 * printing, which is what keeps stdout single-document under `--json`.
 */
export function writeJsonReport(report: Report, stdout: OutputWriter, options?: JsonRenderOptions): void {
  stdout(renderJsonReport(report, options));
}
