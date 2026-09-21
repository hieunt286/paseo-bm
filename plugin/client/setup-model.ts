/**
 * What the Setup screen says (delta 20260916-setup-screen), without a
 * renderer.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { SetupStatus } from "../shared/contracts";
import type { Badge, GraphNode } from "./dashboard-model";

export type SetupRole = "manager" | "worker" | "reviewer";
type Tool = SetupStatus["tools"][number];
type SkillRow = SetupStatus["skills"]["skills"][number];
type SkillState = SkillRow["claude"];
export type SkillAgent = "Claude" | "Codex" | "Pi" | "OpenCode";

/**
 * The skill columns, in order. Pi and OpenCode (delta 20260921 §4.2.6) are
 * optional in the payload: a column the server did not report is not shown.
 */
export const SKILL_COLUMNS: ReadonlyArray<{ key: "claude" | "codex" | "pi" | "opencode"; agent: SkillAgent }> = [
  { key: "claude", agent: "Claude" },
  { key: "codex", agent: "Codex" },
  { key: "pi", agent: "Pi" },
  { key: "opencode", agent: "OpenCode" },
];

export const SETUP_ROLES: ReadonlyArray<{ role: SetupRole; label: string; mark: GraphNode["kind"] }> = [
  { role: "manager", label: "Manager", mark: "request" },
  { role: "worker", label: "Worker", mark: "worker" },
  { role: "reviewer", label: "Reviewer", mark: "reviewer" },
];

/** Numeric comparison of `0.2.10` / `v0.25.0`; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)?.slice(1).map((part) => Number(part ?? 0));
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return null;
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function toolBadge(tool: Tool): Badge {
  if (tool.path === null) return tool.required ? { text: "Missing", tone: "danger" } : { text: "Not installed", tone: "muted" };
  if (tool.version !== null && tool.latestKnown !== null && (compareVersions(tool.version, tool.latestKnown) ?? 0) < 0) {
    return { text: `${tool.version} · ${tool.latestKnown} available`, tone: "warning" };
  }
  return { text: tool.version ?? "Installed", tone: "success" };
}

export function skillBadge(agent: SkillAgent, state: SkillState): Badge {
  switch (state) {
    case "ok":
      return { text: `${agent} ✓`, tone: "success" };
    case "broken":
      return { text: `${agent} broken`, tone: "danger" };
    default:
      return { text: `${agent} missing`, tone: "warning" };
  }
}

/** One chip per skill column the row has, in column order. */
export function skillChips(skill: SkillRow): Badge[] {
  return SKILL_COLUMNS.flatMap(({ key, agent }) => {
    const state = skill[key];
    return state === undefined ? [] : [skillBadge(agent, state)];
  });
}

/** Where each agent's skills were looked for, one entry per reported column. */
export function skillDirsText(dirs: SetupStatus["skills"]["dirs"]): string {
  return [
    `Claude: ${dirs.claude}`,
    `Codex: ${dirs.shared} or ${dirs.codex}`,
    ...(dirs.pi === undefined ? [] : [`Pi: ${dirs.pi}`]),
    ...(dirs.opencode === undefined ? [] : [`OpenCode: ${dirs.opencode}`]),
  ].join(" · ");
}

/** One line at the top: is this machine ready for the Beads agents? */
export function setupHeadline(status: SetupStatus): Badge {
  const missingTools = status.tools.filter((tool) => tool.required && tool.path === null).map((tool) => tool.id);
  const required = status.skills.skills.filter((skill) => skill.required).length;
  const counts = SKILL_COLUMNS.flatMap(({ key, agent }) => {
    const missing = status.skills.missingRequired[key];
    return missing === undefined ? [] : [{ agent, missing }];
  });
  const skills = `skills: ${counts.map((count) => `${count.agent} ${required - count.missing}/${required}`).join(", ")}`;
  if (missingTools.length > 0) {
    return { text: `Missing ${missingTools.join(" and ")} — the Worker cannot manage beads without it · ${skills}`, tone: "danger" };
  }
  const readyForOne = counts.some((count) => count.missing === 0);
  return { text: `br and bv ready · ${skills}`, tone: readyForOne ? "success" : "warning" };
}

/**
 * One warning per role whose last new agent had no Paseo tools (delta 20260921
 * §4.2.4, REQ-063 d); nothing for `ok`, `unknown` or an older server.
 */
export function paseoToolsWarnings(status: SetupStatus): string[] {
  const seen = status.paseoTools;
  if (seen === undefined) return [];
  return (["manager", "worker"] as const).flatMap((role) => {
    const entry = seen[role];
    if (entry === null || entry.state !== "missing") return [];
    const name = role === "manager" ? "Manager" : "Worker";
    return [
      `The last ${name} (${entry.agentId}) runs on ${entry.provider} without Paseo tools, so it cannot create or message other agents. On Pi, install the pi-mcp-adapter extension.`,
    ];
  });
}

export function extraCounter(length: number, max: number): string {
  return `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} characters`;
}

export function installWarning(tool: Tool): string {
  return tool.installCommand?.startsWith("brew ")
    ? `This runs Homebrew on this machine: ${tool.installCommand}`
    : `This downloads and runs the project's install script from GitHub on this machine: ${tool.installCommand ?? ""}`;
}
