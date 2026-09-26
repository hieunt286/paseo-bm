/**
 * Whether the agent skills the roles rely on are installed, as the Paseo
 * daemon sees them (delta 20260916-setup-screen §3.3). Read-only: the plugin
 * never installs or removes a skill.
 *
 * Same lists and rules as the CLI (`src/skills/detect.ts`) and `manager.md`:
 * Claude Code counts only its own directory; Codex counts the shared
 * `~/.agents/skills` or its own. The plugin payload cannot import `src/`, so
 * the two short lists are repeated here and pinned by a test.
 *
 * Pi and OpenCode (delta 20260921 §4.2.6, F8) count only their own
 * directory, `~/.pi/agent/skills` and `~/.config/opencode/skill` (singular),
 * checked the same way as Claude's. No environment variable moves them in this
 * release, and the CLI (`--skills-agents`, `doctor`) does not look at them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DashboardError } from "../shared/contracts";
import { redactText } from "./collector";
import { run, type ToolDeps } from "./setup-tools";
import { updateSetupState, type SetupStateDeps } from "./setup-state";

export const REQUIRED_SKILLS = [
  "feature-workflow",
  "reviewing-plan",
  "converting-plan-to-beads",
  "polishing-beads",
  "implementing-beads",
] as const;
export const OPTIONAL_SKILLS = ["architecture-premise-audit", "authoring-workspace-protocol"] as const;

export type SkillState = "ok" | "missing" | "broken";

export interface SkillRow {
  name: string;
  required: boolean;
  claude: SkillState;
  codex: SkillState;
  pi: SkillState;
  opencode: SkillState;
  /** Why a copy is broken, when one is. */
  problem: string | null;
}

export interface SkillsStatus {
  checkedAt: string;
  dirs: { shared: string; claude: string; codex: string; pi: string; opencode: string };
  skills: SkillRow[];
  /** Required skills not usable, per agent. */
  missingRequired: { claude: number; codex: number; pi: number; opencode: number };
  installCommand: string;
}

export interface SkillDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  readFile?: (path: string) => string;
  now?: () => Date;
}

export function skillDirs(deps: SkillDeps = {}): SkillsStatus["dirs"] {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? homedir)();
  return {
    shared: join(home, ".agents", "skills"),
    claude: join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "skills"),
    codex: join(env.CODEX_HOME ?? join(home, ".codex"), "skills"),
    pi: join(home, ".pi", "agent", "skills"),
    opencode: join(home, ".config", "opencode", "skill"),
  };
}

/** One copy of a skill: `ok`, `missing`, or `broken` with the reason. */
export function checkSkillAt(dir: string, name: string, read: (path: string) => string): { state: SkillState; problem: string | null } {
  let text: string;
  try {
    text = read(join(dir, name, "SKILL.md"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", problem: null };
    return { state: "broken", problem: `${join(dir, name, "SKILL.md")} cannot be read (${code ?? "error"})` };
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const declared = frontmatter === undefined ? null : /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(frontmatter)?.[1] ?? null;
  if (declared === null) return { state: "broken", problem: `${name}/SKILL.md has no \`name:\` in its frontmatter` };
  if (declared !== name) return { state: "broken", problem: `${name}/SKILL.md declares name \`${declared}\`` };
  return { state: "ok", problem: null };
}

function best(...states: Array<{ state: SkillState; problem: string | null }>): { state: SkillState; problem: string | null } {
  return states.find((entry) => entry.state === "ok") ?? states.find((entry) => entry.state === "broken") ?? states[0]!;
}

export function skillsStatus(deps: SkillDeps = {}): SkillsStatus {
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const dirs = skillDirs(deps);
  const rows: SkillRow[] = [...REQUIRED_SKILLS, ...OPTIONAL_SKILLS].map((name) => {
    const claude = checkSkillAt(dirs.claude, name, read);
    const codex = best(checkSkillAt(dirs.shared, name, read), checkSkillAt(dirs.codex, name, read));
    const pi = checkSkillAt(dirs.pi, name, read);
    const opencode = checkSkillAt(dirs.opencode, name, read);
    return {
      name,
      required: (REQUIRED_SKILLS as readonly string[]).includes(name),
      claude: claude.state,
      codex: codex.state,
      pi: pi.state,
      opencode: opencode.state,
      problem: claude.problem ?? codex.problem ?? pi.problem ?? opencode.problem,
    };
  });
  return {
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    dirs,
    skills: rows,
    missingRequired: {
      claude: rows.filter((row) => row.required && row.claude !== "ok").length,
      codex: rows.filter((row) => row.required && row.codex !== "ok").length,
      pi: rows.filter((row) => row.required && row.pi !== "ok").length,
      opencode: rows.filter((row) => row.required && row.opencode !== "ok").length,
    },
    installCommand: `npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s ${REQUIRED_SKILLS.join(" ")} -y`,
  };
}

// ---------------------------------------------------------------------------
// Installing them (0.4.0, design §7.13.4; ADR-012 decision 5 amends ADR-003).
// ---------------------------------------------------------------------------

/**
 * How long the third-party `skills` CLI may take. It downloads from the
 * network, so the limit is generous; past it the run is reported as a timeout,
 * not as a failure, because the two mean different things to the user.
 */
export const SKILLS_INSTALL_TIMEOUT_MS = 300_000;

export type InstallSkillsDeps = SkillDeps & ToolDeps & SetupStateDeps & { log?: (line: string) => void };

export interface InstallSkillsResult {
  command: string;
  code: number;
  tail: string[];
  missingBefore: SkillsStatus["missingRequired"];
  missingAfter: SkillsStatus["missingRequired"];
}

/**
 * Runs the `skills` CLI once, with the command the Setup screen showed.
 *
 * The plugin still never writes a skill folder itself (ADR-003): the only
 * thing that changes anything there is the CLI process the user chose to run,
 * and the command is a constant built from `REQUIRED_SKILLS` — nothing from the
 * request reaches the shell. What ADR-012 changed is only WHO starts it: a
 * button here instead of the retired installer.
 */
export async function installSkills(deps: InstallSkillsDeps = {}): Promise<InstallSkillsResult> {
  const before = skillsStatus(deps);
  if (before.missingRequired.claude === 0 && before.missingRequired.codex === 0) {
    throw new DashboardError(
      "E_SKILLS_PRESENT",
      "Claude Code and Codex already have every skill the roles need; nothing was run",
    );
  }

  const command = before.installCommand;
  const exec = deps.run ?? run;
  const env = deps.env ?? process.env;
  // A login shell, so the CLI sees the user's usual PATH (node, npx).
  const result = await exec(env.SHELL?.endsWith("zsh") ? "/bin/zsh" : "/bin/bash", ["-lc", command], SKILLS_INSTALL_TIMEOUT_MS);
  const timedOut = result.timedOut === true;
  const tail = redactText(result.output, env)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-40);
  const outcome = timedOut ? "timeout" : result.code === 0 ? "ok" : "failed";

  try {
    updateSetupState({ skillsRun: { at: new Date().toISOString(), command, code: result.code, outcome } }, deps);
  } catch (error) {
    // Only shown on Setup; the skills are installed or not either way.
    (deps.log ?? ((line: string) => console.warn(line)))(
      `[paseo-bm] could not record the skills run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (outcome !== "ok") {
    throw new DashboardError(
      "E_SKILLS_INSTALL_FAILED",
      timedOut
        ? `\`${command}\` did not finish within ${SKILLS_INSTALL_TIMEOUT_MS / 1000} seconds: ${tail.slice(-3).join(" | ")}`
        : `\`${command}\` exited with ${result.code}: ${tail.slice(-3).join(" | ")}`,
    );
  }

  return { command, code: result.code, tail, missingBefore: before.missingRequired, missingAfter: skillsStatus(deps).missingRequired };
}
