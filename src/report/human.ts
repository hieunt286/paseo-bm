/**
 * Human renderer — the same `Report` the JSON renderer reads, laid out as a
 * table a person can scan.
 *
 * Actions are grouped by destination, so the question "what is about to change
 * on my machine, and where" is answered by reading the headings. A preview and
 * an applied run render through this one function, which is what stops the two
 * from drifting apart (REQ-003, REQ-009).
 *
 * Like the JSON renderer, this writes into a sink it is handed. Nothing here
 * calls `console.log`, so a caller can send a report to stderr — which is where
 * it belongs when `--json` owns stdout.
 */

import { DIAGNOSTICS } from "../errors.js";
import { exitCodeMeaning } from "../exit-codes.js";
import { groupActionsByLocation, isConfigAction, isDoctorReport, summarizeActions, summarizeChecks } from "../action.js";
import type { Action, Check, JsonValue, Report, ReportWarning, SkillsReport } from "../action.js";
import { createRedactor } from "../redact.js";
import type { Redactor } from "../redact.js";
import type { OutputWriter } from "./json.js";

export interface HumanRenderOptions {
  /**
   * Last-pass filter over the finished text — the single place this channel
   * can mask a secret. Defaults to {@link createRedactor}, so the safe
   * behaviour is what you get by forgetting about it; pass your own only to
   * change what counts as a secret, or `(text) => text` in a test that wants
   * the raw rendering.
   */
  readonly redact?: Redactor;
  /** Longest a rendered config value may be before it is cut short. Default 72. */
  readonly maxValueLength?: number;
}

const KIND_COLUMN = 9;
const INDENT = "  ";
const SEVERITY_LABELS: Readonly<Record<Check["severity"], string>> = {
  ok: "[ok]",
  warn: "[warn]",
  error: "[error]",
};
const SEVERITY_COLUMN = 8;

/** Render the whole report as text, ending in a single newline. */
export function renderHumanReport(report: Report, options: HumanRenderOptions = {}): string {
  const maxValue = options.maxValueLength ?? 72;
  const blocks: string[][] = [renderHeader(report)];

  if (isDoctorReport(report)) {
    blocks.push(renderChecks(report.checks));
  } else {
    blocks.push(...renderPlan(report.actions, report.mode, maxValue));
  }

  const roles = renderRoles(report);
  if (roles.length > 0) blocks.push(roles);

  const skills = renderSkills(report.skills);
  if (skills.length > 0) blocks.push(skills);

  const warnings = renderWarnings(report.warnings);
  if (warnings.length > 0) blocks.push(warnings);

  blocks.push(renderResult(report));

  const text = `${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
  const redact = options.redact ?? createRedactor();
  return redact(text);
}

/** Write the report to a sink — stdout for a normal run, stderr under `--json`. */
export function writeHumanReport(report: Report, sink: OutputWriter, options?: HumanRenderOptions): void {
  sink(renderHumanReport(report, options));
}

function renderHeader(report: Report): string[] {
  const { paseo } = report;
  const lines = [`paseo-bm ${report.paseoBmVersion} — ${report.command} (${describeMode(report)})`];
  const facts = [
    `Paseo CLI ${paseo.cliVersion ?? "unknown"}`,
    `daemon ${paseo.daemonVersion ?? "unknown"}`,
    `home ${paseo.home ?? "unknown"}`,
    `plugins enabled: ${yesNo(paseo.pluginsEnabled)}`,
  ];
  lines.push(facts.join(", "));
  return lines;
}

function describeMode(report: Report): string {
  if (report.command === "doctor") {
    return "read-only, nothing is written";
  }
  return report.mode === "applied" ? "applied" : "preview, nothing has been written";
}

function renderPlan(actions: readonly Action[], mode: Report["mode"], maxValue: number): string[][] {
  const heading = mode === "applied" ? "Changes made" : "Planned changes";
  if (actions.length === 0) {
    return [[heading, `${INDENT}nothing to do — everything is already in the state paseo-bm expects`]];
  }

  const targetColumn = Math.max(...actions.map((action) => action.target.length)) + 2;

  const blocks: string[][] = [];
  const planBlock: string[] = [heading];
  for (const group of groupActionsByLocation(actions)) {
    planBlock.push(`${INDENT}${group.label}`);
    for (const action of group.actions) {
      planBlock.push(`${INDENT}${INDENT}${formatActionRow(action, targetColumn, maxValue)}`);
    }
  }
  blocks.push(planBlock);
  blocks.push([summarizePlanLine(actions)]);
  return blocks;
}

function formatActionRow(action: Action, targetColumn: number, maxValue: number): string {
  const notes = [action.reason];
  if (isConfigAction(action)) {
    notes.push(`${formatValue(action.from, maxValue)} -> ${formatValue(action.to, maxValue)}`);
    if (action.consent !== undefined) {
      notes.push(`consent: ${action.consent}`);
    }
  }
  if (action.detail !== undefined) {
    notes.push(action.detail);
  }
  return `${action.kind.padEnd(KIND_COLUMN)}${action.target.padEnd(targetColumn)}${notes.join("; ")}`.trimEnd();
}

function summarizePlanLine(actions: readonly Action[]): string {
  const summary = summarizeActions(actions);
  const parts = Object.entries(summary.byKind)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  const tail = summary.conflicts ? " — a conflict needs your decision" : "";
  return `${summary.total} action${summary.total === 1 ? "" : "s"}: ${parts.join(", ")}${tail}`;
}

function renderChecks(checks: readonly Check[]): string[] {
  const lines = ["Checks"];
  if (checks.length === 0) {
    lines.push(`${INDENT}no checks ran`);
    return lines;
  }
  const idColumn = Math.max(...checks.map((check) => check.id.length)) + 2;
  for (const check of checks) {
    const severity = SEVERITY_LABELS[check.severity].padEnd(SEVERITY_COLUMN);
    lines.push(`${INDENT}${severity}${check.id.padEnd(idColumn)}${check.message}`);
    if (check.severity !== "ok" && check.remediation !== "") {
      lines.push(`${INDENT}${" ".repeat(SEVERITY_COLUMN)}${" ".repeat(idColumn)}Fix: ${check.remediation}`);
    }
  }
  const counts = summarizeChecks(checks);
  lines.push("");
  lines.push(`${counts.ok} ok, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.error} error${counts.error === 1 ? "" : "s"}`);
  return lines;
}

function renderRoles(report: Report): string[] {
  if (report.roles.length === 0) {
    return [];
  }
  const lines = ["Agent roles"];
  const roleColumn = Math.max(...report.roles.map((role) => role.role.length)) + 2;
  const toolColumn =
    Math.max(...report.roles.map((role) => `${role.provider}/${role.model}`.length)) + 2;
  for (const role of report.roles) {
    const tool = `${role.provider}/${role.model}`;
    const signedIn = role.loggedIn === null ? "unknown" : yesNo(role.loggedIn);
    lines.push(
      `${INDENT}${role.role.padEnd(roleColumn)}${tool.padEnd(toolColumn)}Paseo tools: ${yesNo(role.paseoTools)}; signed in: ${signedIn}`,
    );
  }
  return lines;
}

function renderSkills(skills: SkillsReport | null): string[] {
  if (skills === null) {
    return [];
  }
  const lines = ["Agent skills", `${INDENT}source: ${skills.source}`];
  const agents = Object.keys(skills.byAgent).sort();
  if (agents.length === 0) {
    lines.push(`${INDENT}no agent was checked`);
  }
  for (const agent of agents) {
    const entry = skills.byAgent[agent];
    if (entry === undefined) continue;
    const missing = entry.missing.length === 0 ? "none missing" : `missing: ${entry.missing.join(", ")}`;
    lines.push(`${INDENT}${agent}: ${entry.present.length} present, ${missing}`);
  }
  if (skills.suggestedCommand !== null) {
    lines.push(`${INDENT}run it yourself: ${skills.suggestedCommand}`);
  }
  if (skills.assisted) {
    lines.push(`${INDENT}paseo-bm ran that command for you — outcome: ${skills.outcome ?? "unknown"}`);
  }
  return lines;
}

function renderWarnings(warnings: readonly ReportWarning[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  const lines = ["Warnings (these never change the exit code)"];
  for (const warning of warnings) {
    const entry = DIAGNOSTICS[warning.code];
    lines.push(`${INDENT}${entry.code}  ${entry.message}`);
    if (warning.detail !== undefined) {
      lines.push(`${INDENT}${INDENT}${warning.detail}`);
    }
    lines.push(`${INDENT}${INDENT}Fix: ${entry.remediation}`);
  }
  return lines;
}

function renderResult(report: Report): string[] {
  const lines: string[] = [];
  if (report.result.pluginState !== null) {
    lines.push(`Plugin status: ${report.result.pluginState}`);
  }
  lines.push(`Exit code ${report.result.exitCode} — ${exitCodeMeaning(report.result.exitCode)}`);
  return lines;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Render a config value the way JSON would, cut short when it is unreasonably long. */
function formatValue(value: JsonValue, maxLength: number): string {
  const text = JSON.stringify(value) ?? "null";
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
