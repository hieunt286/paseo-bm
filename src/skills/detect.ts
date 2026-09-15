/**
 * Read-only detection of the agent skills the paseo-bm roles rely on
 * (REQ-007(a)(b)(c), ADR-003, Design §6).
 *
 * The rule this module exists to honour is ADR-003 decision 1: **paseo-bm never
 * creates, edits, deletes or backs up anything inside a skills directory.** That
 * includes the directories themselves — an agent that is not installed is
 * *reported as skipped*, never given a directory. The only system call this file
 * makes is `stat`.
 *
 * Detection is deliberately a filesystem read rather than a `skills list` call
 * (ADR-003 decision 2 and its rejected alternative): it has to be fast, work
 * offline, have no side effects, and stay usable from `doctor`, which may not
 * call the `skills` CLI at all (REQ-011a).
 *
 * Two details that look small and are not:
 *
 * 1. **`stat`, not `lstat`.** On a real machine `~/.claude/skills` is usually a
 *    symlink into `~/.agents/skills`, and individual skills can be symlinks too,
 *    because ADR-003 decision 5 picks the `skills` CLI's default symlink mode.
 *    Refusing to follow links would report a fully-equipped machine as empty.
 *    A dangling symlink fails `stat` and therefore counts as missing, which is
 *    the honest answer.
 * 2. **Names only, no versions.** The source repo has no tags (Q-013), so Phase
 *    1 compares presence of `<skills dir>/<skill>/SKILL.md` and nothing else.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "../action.js";
import { DIAGNOSTICS } from "../errors.js";
import type { Layout, PathSource, ResolvedPath } from "../layout.js";

/**
 * The required set: the five skills of PRD Appendix A that cover the whole bead
 * lifecycle. Missing ones produce `W_SKILLS_MISSING` and nothing more — they
 * never block an install and never change an exit code (REQ-007i).
 */
export const REQUIRED_SKILLS = [
  "feature-workflow",
  "reviewing-plan",
  "converting-plan-to-beads",
  "polishing-beads",
  "implementing-beads",
] as const;

/**
 * The optional set of PRD Appendix A: listed as a suggestion only. Their absence
 * is never a warning, so they are kept apart from `REQUIRED_SKILLS` rather than
 * flagged inside one list (REQ-007b).
 */
export const OPTIONAL_SKILLS = ["architecture-premise-audit", "authoring-workspace-protocol"] as const;

/** The marker file that makes a directory a skill (PRD Appendix A, layout row). */
export const SKILL_MARKER_FILE = "SKILL.md";

/** Directory name holding skills inside an agent's config home. */
export const SKILLS_DIR_NAME = "skills";

/**
 * The three places skills live, in report order. The identifiers match the ones
 * `--skills-agents` accepts (Design §4.2, default `claude,codex`); `agents` is
 * the shared directory the `skills` CLI actually installs into (ADR-003).
 */
export const SKILL_AGENT_IDS = ["agents", "claude", "codex"] as const;

export type SkillAgentId = (typeof SKILL_AGENT_IDS)[number];

/** Human label for an agent target, for the human report and `doctor`. */
export const SKILL_AGENT_LABELS: Readonly<Record<SkillAgentId, string>> = {
  agents: "shared agent home",
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * What was found for one agent.
 *
 * `agent-not-installed` and `no-skills-dir` are two different facts and are kept
 * apart on purpose: the first means "nothing of this agent is on the machine, so
 * skip it", the second means "the agent is here but has no skills yet", which is
 * something the `skills` CLI can fix.
 */
export const AGENT_SKILLS_STATUSES = [
  "complete",
  "incomplete",
  "no-skills-dir",
  "agent-not-installed",
] as const;

export type AgentSkillsStatus = (typeof AGENT_SKILLS_STATUSES)[number];

export interface AgentSkillsDetection {
  readonly agent: SkillAgentId;
  readonly label: string;
  /** The agent's config home, as resolved by the path layer. */
  readonly home: string;
  /** Where that home came from — flag, env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) or default. */
  readonly homeSource: PathSource;
  /** `<home>/skills`. Reported even when it does not exist; never created. */
  readonly skillsDir: string;
  /**
   * Every directory looked in for this agent, in lookup order: `skillsDir`
   * first, then the shared `~/.agents/skills` for an agent that reads it
   * (Codex, see `READS_SHARED_SKILLS_DIR`). Never created.
   */
  readonly searchedDirs: readonly string[];
  /**
   * The directories in `searchedDirs` that actually hold at least one required
   * skill, so `doctor` can say where the skills were found (bug bm-ozd).
   */
  readonly foundIn: readonly string[];
  readonly status: AgentSkillsStatus;
  /** Required skills found, in `REQUIRED_SKILLS` order. */
  readonly present: readonly string[];
  /** Required skills not found, in `REQUIRED_SKILLS` order. */
  readonly missing: readonly string[];
  /** Optional skills found; informational only. */
  readonly optionalPresent: readonly string[];
  /** Optional skills not found; never a warning (REQ-007b). */
  readonly optionalMissing: readonly string[];
}

export interface SkillsDetection {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** One entry per agent target, in `SKILL_AGENT_IDS` order. */
  readonly agents: readonly AgentSkillsDetection[];
}

/** True when this agent was looked at rather than skipped. */
export function isCheckedAgent(entry: AgentSkillsDetection): boolean {
  return entry.status !== "agent-not-installed";
}

/**
 * Does the path exist, following symlinks?
 *
 * `stat` rather than `lstat` is the whole point (see the file header). Any error
 * means "not usable as a skill", not just `ENOENT`: a dangling symlink gives
 * `ENOENT`, a symlink loop gives `ELOOP`, an unreadable parent gives `EACCES`,
 * and in every one of those cases the honest report is that the skill is not
 * available. Detection must never throw — it runs inside `install` and `doctor`,
 * where a missing skill is not an error.
 */
async function statKind(path: string): Promise<"file" | "dir" | "none"> {
  try {
    const stats = await stat(path);
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "dir";
    return "none";
  } catch {
    return "none";
  }
}

/** A skill is present when `<skills dir>/<name>/SKILL.md` resolves to a file. */
async function hasSkill(skillsDir: string, name: string): Promise<boolean> {
  return (await statKind(join(skillsDir, name, SKILL_MARKER_FILE))) === "file";
}

/**
 * Split `names` into present and missing across `dirs`: a skill is present when
 * any of the directories holds it. `foundIn` lists, in `dirs` order, the
 * directories that hold at least one of `names`.
 */
async function partition(
  dirs: readonly string[],
  names: readonly string[],
): Promise<{ present: string[]; missing: string[]; foundIn: string[] }> {
  const found = await Promise.all(
    names.map(async (name) => {
      const hits = await Promise.all(dirs.map((dir) => hasSkill(dir, name)));
      return dirs.filter((_, index) => hits[index] === true);
    }),
  );
  const present: string[] = [];
  const missing: string[] = [];
  const holding = new Set<string>();
  names.forEach((name, index) => {
    const where = found[index] ?? [];
    (where.length > 0 ? present : missing).push(name);
    for (const dir of where) holding.add(dir);
  });
  return { present, missing, foundIn: dirs.filter((dir) => holding.has(dir)) };
}

/**
 * Agents whose skills also count when they sit only in the shared
 * `~/.agents/skills` directory (bug bm-ozd).
 *
 * Based on the `skills` CLI 1.5.26 (`dist/cli.mjs`): Codex is declared with
 * `skillsDir: ".agents/skills"`, which makes it a "universal" agent
 * (`isUniversalAgent`). For a global install the installer copies each skill
 * into the canonical `~/.agents/skills` and returns right there for universal
 * agents, so no link is ever created in `$CODEX_HOME/skills`. Codex itself reads
 * `~/.agents/skills`. Claude Code is not universal: the CLI links each skill
 * into `$CLAUDE_CONFIG_DIR/skills`, so Claude keeps looking only there.
 * `agents` is the shared directory itself and has nothing to fall back to.
 */
export const READS_SHARED_SKILLS_DIR: Readonly<Record<SkillAgentId, boolean>> = {
  agents: false,
  claude: false,
  codex: true,
};

async function detectAgent(
  agent: SkillAgentId,
  home: ResolvedPath,
  sharedSkillsDir: string,
): Promise<AgentSkillsDetection> {
  const skillsDir = join(home.path, SKILLS_DIR_NAME);
  const searchedDirs =
    READS_SHARED_SKILLS_DIR[agent] && sharedSkillsDir !== skillsDir ? [skillsDir, sharedSkillsDir] : [skillsDir];
  const base = {
    agent,
    label: SKILL_AGENT_LABELS[agent],
    home: home.path,
    homeSource: home.source,
    skillsDir,
    searchedDirs,
  } as const;

  if ((await statKind(home.path)) !== "dir") {
    // The agent is not installed. Report it as skipped and stop: creating the
    // directory here would be exactly the write ADR-003 forbids.
    return {
      ...base,
      status: "agent-not-installed",
      present: [],
      missing: [],
      foundIn: [],
      optionalPresent: [],
      optionalMissing: [],
    };
  }

  // A missing directory simply yields no skills, so looking before knowing
  // whether `skillsDir` exists is safe and still read-only.
  const required = await partition(searchedDirs, REQUIRED_SKILLS);
  const optional = await partition(searchedDirs, OPTIONAL_SKILLS);

  if ((await statKind(skillsDir)) !== "dir" && required.present.length === 0) {
    // The agent's own directory is absent and no shared directory it reads
    // holds a required skill either.
    return {
      ...base,
      status: "no-skills-dir",
      present: [],
      missing: [...REQUIRED_SKILLS],
      foundIn: [],
      optionalPresent: optional.present,
      optionalMissing: optional.missing,
    };
  }

  return {
    ...base,
    foundIn: required.foundIn,
    status: required.missing.length === 0 ? "complete" : "incomplete",
    present: required.present,
    missing: required.missing,
    optionalPresent: optional.present,
    optionalMissing: optional.missing,
  };
}

/**
 * Detect the required and optional skills for all three agent targets.
 *
 * Reads only; creates nothing. The layout it is handed already applied
 * flag > env > default, so `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured
 * here for free (REQ-007a, REQ-014).
 */
export async function detectSkills(layout: Layout): Promise<SkillsDetection> {
  const homes: Readonly<Record<SkillAgentId, ResolvedPath>> = {
    agents: layout.agentsHome,
    claude: layout.claudeHome,
    codex: layout.codexHome,
  };
  const sharedSkillsDir = join(layout.agentsHome.path, SKILLS_DIR_NAME);
  const agents = await Promise.all(
    SKILL_AGENT_IDS.map((agent) => detectAgent(agent, homes[agent], sharedSkillsDir)),
  );
  return { required: [...REQUIRED_SKILLS], optional: [...OPTIONAL_SKILLS], agents };
}

/** Agents that are installed and still missing at least one required skill. */
export function agentsMissingSkills(detection: SkillsDetection): readonly AgentSkillsDetection[] {
  return detection.agents.filter((entry) => isCheckedAgent(entry) && entry.missing.length > 0);
}

/**
 * True when an installed agent lacks a required skill — the condition for
 * `W_SKILLS_MISSING`.
 *
 * An agent that is not installed never triggers this: there is nothing to fix
 * for a tool the user does not have, and warning about it would push towards
 * creating directories that are not ours (ADR-003).
 */
export function hasMissingRequiredSkills(detection: SkillsDetection): boolean {
  return agentsMissingSkills(detection).length > 0;
}

/** The union of required skills missing from at least one installed agent. */
export function missingRequiredSkills(detection: SkillsDetection): readonly string[] {
  const missing = new Set<string>();
  for (const entry of agentsMissingSkills(detection)) {
    for (const skill of entry.missing) missing.add(skill);
  }
  return REQUIRED_SKILLS.filter((skill) => missing.has(skill));
}

/**
 * Run-specific context for `W_SKILLS_MISSING`, or `null` when nothing is
 * missing. The wording of the warning itself lives in the registry; only the
 * "which agent, which skill" part belongs to a run (Design §4.4).
 */
export function missingSkillsDetail(detection: SkillsDetection): string | null {
  const affected = agentsMissingSkills(detection);
  if (affected.length === 0) return null;
  return affected
    .map((entry) => `${entry.label} (${entry.agent}) is missing ${entry.missing.join(", ")}`)
    .join("; ");
}

/**
 * The report model's per-agent view (Design §4.4, `skills.byAgent`).
 *
 * A skipped agent reports empty lists rather than "everything is missing":
 * `status` is what says it was skipped, and padding `missing` would turn an
 * absent tool into five fake problems.
 */
export function toSkillsByAgent(
  detection: SkillsDetection,
): Readonly<Record<string, { readonly present: readonly string[]; readonly missing: readonly string[] }>> {
  const byAgent: Record<string, { present: readonly string[]; missing: readonly string[] }> = {};
  for (const entry of detection.agents) {
    byAgent[entry.agent] = { present: entry.present, missing: entry.missing };
  }
  return byAgent;
}

/**
 * `doctor` findings, one per agent (REQ-011b).
 *
 * Severity is never `error`: skills are third-party content outside paseo-bm's
 * ownership, so a gap there must not push `doctor` to exit 1 (REQ-011c).
 */
export function skillsChecks(detection: SkillsDetection): readonly Check[] {
  const remediation = DIAGNOSTICS.W_SKILLS_MISSING.remediation;
  return detection.agents.map((entry) => {
    const id = `skills-${entry.agent}`;
    switch (entry.status) {
      case "complete":
        return {
          id,
          severity: "ok" as const,
          message: `${entry.label}: all ${detection.required.length} required skills are installed in ${entry.foundIn.join(" and ")}`,
          remediation: "",
        };
      case "agent-not-installed":
        return {
          id,
          severity: "ok" as const,
          message: `${entry.label}: not installed (${entry.home} does not exist), skipped`,
          remediation: "",
        };
      case "no-skills-dir":
        return {
          id,
          severity: "warn" as const,
          message:
            entry.searchedDirs.length > 1
              ? `${entry.label}: no skills directory at ${entry.skillsDir} and no required skills in ${entry.searchedDirs.slice(1).join(" or ")}, so all ${entry.missing.length} required skills are missing`
              : `${entry.label}: no skills directory at ${entry.skillsDir}, so all ${entry.missing.length} required skills are missing`,
          remediation,
        };
      case "incomplete":
        return {
          id,
          severity: "warn" as const,
          message: `${entry.label}: missing ${entry.missing.join(", ")} in ${entry.searchedDirs.join(" or ")}`,
          remediation,
        };
    }
  });
}
