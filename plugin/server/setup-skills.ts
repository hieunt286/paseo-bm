/**
 * Whether the agent skills the roles rely on are installed, as the Paseo
 * daemon sees them (delta 20260916-setup-screen §3.3). Read-only: the plugin
 * never installs or removes a skill.
 *
 * Same lists and rules as the CLI (`src/skills/detect.ts`) and `manager.md`:
 * Claude Code counts only its own directory; Codex counts the shared
 * `~/.agents/skills` or its own. The plugin payload cannot import `src/`, so
 * the two short lists are repeated here and pinned by a test.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** Why a copy is broken, when one is. */
  problem: string | null;
}

export interface SkillsStatus {
  checkedAt: string;
  dirs: { shared: string; claude: string; codex: string };
  skills: SkillRow[];
  /** Required skills not usable, per agent. */
  missingRequired: { claude: number; codex: number };
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
    return {
      name,
      required: (REQUIRED_SKILLS as readonly string[]).includes(name),
      claude: claude.state,
      codex: codex.state,
      problem: claude.problem ?? codex.problem,
    };
  });
  return {
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    dirs,
    skills: rows,
    missingRequired: {
      claude: rows.filter((row) => row.required && row.claude !== "ok").length,
      codex: rows.filter((row) => row.required && row.codex !== "ok").length,
    },
    installCommand: `npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s ${REQUIRED_SKILLS.join(" ")} -y`,
  };
}
