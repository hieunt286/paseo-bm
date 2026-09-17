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
type SkillState = SetupStatus["skills"]["skills"][number]["claude"];

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

export function skillBadge(agent: "Claude" | "Codex", state: SkillState): Badge {
  switch (state) {
    case "ok":
      return { text: `${agent} ✓`, tone: "success" };
    case "broken":
      return { text: `${agent} broken`, tone: "danger" };
    default:
      return { text: `${agent} missing`, tone: "warning" };
  }
}

/** One line at the top: is this machine ready for the Beads agents? */
export function setupHeadline(status: SetupStatus): Badge {
  const missingTools = status.tools.filter((tool) => tool.required && tool.path === null).map((tool) => tool.id);
  const required = status.skills.skills.filter((skill) => skill.required).length;
  const skills = `skills: Claude ${required - status.skills.missingRequired.claude}/${required}, Codex ${required - status.skills.missingRequired.codex}/${required}`;
  if (missingTools.length > 0) {
    return { text: `Missing ${missingTools.join(" and ")} — the Worker cannot manage beads without it · ${skills}`, tone: "danger" };
  }
  const readyForOne = status.skills.missingRequired.claude === 0 || status.skills.missingRequired.codex === 0;
  return { text: `br and bv ready · ${skills}`, tone: readyForOne ? "success" : "warning" };
}

export function extraCounter(length: number, max: number): string {
  return `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")} characters`;
}

export function installWarning(tool: Tool): string {
  return tool.installCommand?.startsWith("brew ")
    ? `This runs Homebrew on this machine: ${tool.installCommand}`
    : `This downloads and runs the project's install script from GitHub on this machine: ${tool.installCommand ?? ""}`;
}
