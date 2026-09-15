import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveLayout } from "../src/layout.js";
import type { Layout } from "../src/layout.js";
import {
  OPTIONAL_SKILLS,
  REQUIRED_SKILLS,
  SKILL_AGENT_IDS,
  agentsMissingSkills,
  detectSkills,
  hasMissingRequiredSkills,
  missingRequiredSkills,
  missingSkillsDetail,
  skillsChecks,
  toSkillsByAgent,
} from "../src/skills/detect.js";
import type { AgentSkillsDetection, SkillAgentId, SkillsDetection } from "../src/skills/detect.js";

/**
 * Proof #1 that detection never writes (AC: "0 thao tác ghi vào thư mục
 * skills"). The shared write guard of WP-102 is being written in parallel and is
 * not available to this module yet, so the guarantee is asserted here directly:
 * every mutating entry point of `node:fs/promises` is replaced with a recorder
 * that throws, while the read calls stay real. If `detect.ts` ever grows a
 * `mkdir` for a missing agent directory — the exact mistake ADR-003 forbids —
 * every test in this file fails at once.
 */
const { writeAttempts } = vi.hoisted(() => ({ writeAttempts: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const mutators = [
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "lchmod",
    "lchown",
    "link",
    "lutimes",
    "mkdir",
    "mkdtemp",
    "open",
    "rename",
    "rm",
    "rmdir",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ] as const;
  const guarded: Record<string, unknown> = { ...actual };
  for (const name of mutators) {
    // `async` so it rejects the way the real API does, rather than throwing
    // synchronously out of the caller's stack.
    guarded[name] = async (...args: unknown[]) => {
      writeAttempts.push(`${name}(${String(args[0])})`);
      throw new Error(`forbidden write: fs.promises.${name}`);
    };
  }
  return { ...guarded, default: guarded };
});

let scratch: string;
let home: string;

beforeEach(() => {
  writeAttempts.length = 0;
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-skills-"));
  home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  // Some cases make directories read-only; put them back so cleanup can run.
  for (const dir of walkDirs(scratch)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  expect(writeAttempts).toEqual([]);
});

function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkDirs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    found.push(dir);
    for (const entry of safeReaddir(dir)) {
      if (entry.isDirectory()) visit(join(dir, entry.name));
    }
  };
  visit(root);
  return found.reverse();
}

/** A skill is a directory with a `SKILL.md` inside it (PRD Appendix A). */
function makeSkill(skillsDir: string, name: string): string {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
  return dir;
}

function makeSkillsDir(agentHome: string, skills: readonly string[] = []): string {
  const skillsDir = join(agentHome, "skills");
  mkdirSync(skillsDir, { recursive: true });
  for (const skill of skills) makeSkill(skillsDir, skill);
  return skillsDir;
}

function layoutFor(env: Record<string, string | undefined> = {}): Layout {
  return resolveLayout({ homeDir: home, env, cwd: scratch });
}

function entryFor(detection: SkillsDetection, agent: SkillAgentId): AgentSkillsDetection {
  const entry = detection.agents.find((candidate) => candidate.agent === agent);
  if (entry === undefined) throw new Error(`no detection entry for ${agent}`);
  return entry;
}

/**
 * Proof #2 that detection never writes: a full snapshot of the fake `$HOME`,
 * taken with `lstat` so symlinks are compared as symlinks and never followed.
 * Mode is included, so even a `chmod` would show up.
 */
function snapshot(root: string): string[] {
  const rows: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const stats = lstatSync(full);
      const kind = stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "dir" : "file";
      rows.push(
        `${kind} ${relative(root, full)} mode=${(stats.mode & 0o777).toString(8)} size=${stats.size} mtime=${stats.mtimeMs}`,
      );
      if (kind === "dir") visit(full);
    }
  };
  visit(root);
  return rows;
}

describe("detectSkills — the M-8 layout matrix", () => {
  it("layout 1: every agent has every required skill", async () => {
    makeSkillsDir(join(home, ".agents"), [...REQUIRED_SKILLS, ...OPTIONAL_SKILLS]);
    makeSkillsDir(join(home, ".claude"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".codex"), REQUIRED_SKILLS);

    const detection = await detectSkills(layoutFor());

    expect(detection.agents.map((entry) => entry.agent)).toEqual([...SKILL_AGENT_IDS]);
    for (const entry of detection.agents) {
      expect(entry.status).toBe("complete");
      expect(entry.present).toEqual([...REQUIRED_SKILLS]);
      expect(entry.missing).toEqual([]);
    }
    expect(entryFor(detection, "agents").optionalPresent).toEqual([...OPTIONAL_SKILLS]);
    // Optional skills missing elsewhere is not a problem and not a warning.
    expect(entryFor(detection, "claude").optionalMissing).toEqual([...OPTIONAL_SKILLS]);
    expect(hasMissingRequiredSkills(detection)).toBe(false);
    expect(missingSkillsDetail(detection)).toBeNull();
    expect(skillsChecks(detection).every((check) => check.severity === "ok")).toBe(true);
  });

  it("layout 2: partially installed — reports exactly which skills are missing, per agent", async () => {
    // The shared directory lacks polishing-beads. Codex counts the union of its
    // own directory and the shared one (bm-ozd); Claude counts only its own.
    const shared = makeSkillsDir(
      join(home, ".agents"),
      REQUIRED_SKILLS.filter((skill) => skill !== "polishing-beads"),
    );
    makeSkillsDir(join(home, ".claude"), ["feature-workflow", "implementing-beads"]);
    const codexSkills = makeSkillsDir(join(home, ".codex"), ["feature-workflow"]);

    const detection = await detectSkills(layoutFor());

    const agents = entryFor(detection, "agents");
    expect(agents.status).toBe("incomplete");
    expect(agents.missing).toEqual(["polishing-beads"]);
    const claude = entryFor(detection, "claude");
    expect(claude.status).toBe("incomplete");
    expect(claude.present).toEqual(["feature-workflow", "implementing-beads"]);
    expect(claude.missing).toEqual(["reviewing-plan", "converting-plan-to-beads", "polishing-beads"]);
    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("incomplete");
    expect(codex.present).toEqual(["feature-workflow", "reviewing-plan", "converting-plan-to-beads", "implementing-beads"]);
    expect(codex.missing).toEqual(["polishing-beads"]);
    expect(codex.foundIn).toEqual([codexSkills, shared]);

    expect(hasMissingRequiredSkills(detection)).toBe(true);
    expect(agentsMissingSkills(detection).map((entry) => entry.agent)).toEqual(["agents", "claude", "codex"]);
    expect(missingRequiredSkills(detection)).toEqual(["reviewing-plan", "converting-plan-to-beads", "polishing-beads"]);
    expect(missingSkillsDetail(detection)).toContain("Claude Code (claude) is missing");
    expect(skillsChecks(detection).find((check) => check.id === "skills-codex")?.message).toBe(
      `Codex: missing polishing-beads in ${codexSkills} or ${shared}`,
    );
  });

  it("layout 3: nothing installed — empty skills directory and no skills directory are different facts", async () => {
    makeSkillsDir(join(home, ".agents"));
    makeSkillsDir(join(home, ".claude"));
    mkdirSync(join(home, ".codex"), { recursive: true }); // agent present, skills dir absent

    const detection = await detectSkills(layoutFor());

    for (const agent of ["agents", "claude"] as const) {
      const entry = entryFor(detection, agent);
      expect(entry.status).toBe("incomplete");
      expect(entry.present).toEqual([]);
      expect(entry.missing).toEqual([...REQUIRED_SKILLS]);
    }
    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("no-skills-dir");
    expect(codex.missing).toEqual([...REQUIRED_SKILLS]);
    expect(existsSync(codex.skillsDir)).toBe(false); // still not created

    expect(skillsChecks(detection).map((check) => check.severity)).toEqual(["warn", "warn", "warn"]);
    expect(skillsChecks(detection).every((check) => check.remediation.length > 0)).toBe(true);
  });

  it("layout 4: symlinks — a symlinked skills directory, symlinked skills and a symlinked SKILL.md all count", async () => {
    // `~/.claude/skills` is a symlink pointing at a store. The store sits outside
    // `~/.agents` here: Codex also counts `~/.agents/skills` (bm-ozd), and a full
    // shared directory would hide the per-skill symlink cases below.
    const store = makeSkillsDir(join(scratch, "store"), REQUIRED_SKILLS);
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(store, join(home, ".claude", "skills"), "dir");

    // Codex has its own directory with each skill symlinked individually, one
    // skill whose SKILL.md is itself a symlink, and one dangling link.
    const codexSkills = makeSkillsDir(join(home, ".codex"));
    for (const skill of ["feature-workflow", "reviewing-plan", "converting-plan-to-beads"]) {
      symlinkSync(join(store, skill), join(codexSkills, skill), "dir");
    }
    const polishing = join(codexSkills, "polishing-beads");
    mkdirSync(polishing, { recursive: true });
    symlinkSync(join(store, "polishing-beads", "SKILL.md"), join(polishing, "SKILL.md"), "file");
    symlinkSync(join(scratch, "does-not-exist", "implementing-beads"), join(codexSkills, "implementing-beads"), "dir");

    const detection = await detectSkills(layoutFor());

    expect(entryFor(detection, "claude").status).toBe("complete");
    expect(entryFor(detection, "claude").present).toEqual([...REQUIRED_SKILLS]);
    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("incomplete");
    expect(codex.present).toEqual([
      "feature-workflow",
      "reviewing-plan",
      "converting-plan-to-beads",
      "polishing-beads",
    ]);
    // A dangling symlink is reported as missing, not as present.
    expect(codex.missing).toEqual(["implementing-beads"]);
  });

  it("layout 5: relocated by CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    // The default locations are fully stocked; the relocated ones are not. If
    // detection read the defaults, everything would look complete.
    makeSkillsDir(join(home, ".claude"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".codex"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);

    const claudeElsewhere = join(scratch, "xdg", "claude");
    const codexElsewhere = join(scratch, "xdg", "codex");
    makeSkillsDir(claudeElsewhere, ["feature-workflow"]);
    mkdirSync(codexElsewhere, { recursive: true });

    const detection = await detectSkills(
      layoutFor({ CLAUDE_CONFIG_DIR: claudeElsewhere, CODEX_HOME: codexElsewhere }),
    );

    const claude = entryFor(detection, "claude");
    expect(claude.home).toBe(claudeElsewhere);
    expect(claude.homeSource).toBe("env");
    expect(claude.skillsDir).toBe(join(claudeElsewhere, "skills"));
    expect(claude.present).toEqual(["feature-workflow"]);
    expect(claude.missing).toHaveLength(4);

    // Codex at CODEX_HOME has no skills directory, but reads the shared one,
    // which is fully stocked (bm-ozd). The stocked default ~/.codex/skills is
    // never among the directories searched or found.
    const codex = entryFor(detection, "codex");
    expect(codex.home).toBe(codexElsewhere);
    expect(codex.homeSource).toBe("env");
    expect(codex.skillsDir).toBe(join(codexElsewhere, "skills"));
    expect(codex.searchedDirs).toEqual([join(codexElsewhere, "skills"), join(home, ".agents", "skills")]);
    expect(codex.status).toBe("complete");
    expect(codex.foundIn).toEqual([join(home, ".agents", "skills")]);

    // The shared directory has no environment override and stays at the default.
    const shared = entryFor(detection, "agents");
    expect(shared.home).toBe(join(home, ".agents"));
    expect(shared.homeSource).toBe("default");
    expect(shared.status).toBe("complete");
  });

  it("layout 5b: CODEX_HOME with an empty shared directory reports the relocated Codex home only", async () => {
    makeSkillsDir(join(home, ".codex"), REQUIRED_SKILLS);
    const codexElsewhere = join(scratch, "xdg", "codex");
    mkdirSync(codexElsewhere, { recursive: true });

    const detection = await detectSkills(layoutFor({ CODEX_HOME: codexElsewhere }));

    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("no-skills-dir");
    expect(codex.missing).toEqual([...REQUIRED_SKILLS]);
    expect(existsSync(codex.skillsDir)).toBe(false);
  });

  it("layout 6: an agent that is not installed is skipped, and no directory is created for it", async () => {
    makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".claude"), REQUIRED_SKILLS);
    // No `~/.codex` at all.

    const detection = await detectSkills(layoutFor());

    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("agent-not-installed");
    expect(codex.present).toEqual([]);
    expect(codex.missing).toEqual([]); // skipped, not "five problems"
    expect(existsSync(codex.home)).toBe(false);
    expect(existsSync(codex.skillsDir)).toBe(false);

    // A tool the user does not have never raises the warning.
    expect(hasMissingRequiredSkills(detection)).toBe(false);
    expect(missingSkillsDetail(detection)).toBeNull();
    const check = skillsChecks(detection).find((candidate) => candidate.id === "skills-codex");
    expect(check?.severity).toBe("ok");
    expect(check?.message).toContain("skipped");
  });
});

describe("detectSkills — Codex reads the shared directory (bug bm-ozd, skills CLI 1.5.26)", () => {
  function codexCheck(detection: SkillsDetection) {
    return skillsChecks(detection).find((check) => check.id === "skills-codex");
  }

  it("skills only in ~/.agents/skills, Codex home present without skills → Codex complete, no warning", async () => {
    // Exactly what the real skills CLI leaves behind (acceptance run 2026-09-15).
    const shared = makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".claude"), REQUIRED_SKILLS);
    mkdirSync(join(home, ".codex"), { recursive: true });

    const detection = await detectSkills(layoutFor());

    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("complete");
    expect(codex.present).toEqual([...REQUIRED_SKILLS]);
    expect(codex.missing).toEqual([]);
    expect(codex.searchedDirs).toEqual([join(home, ".codex", "skills"), shared]);
    expect(codex.foundIn).toEqual([shared]);
    expect(hasMissingRequiredSkills(detection)).toBe(false);
    expect(missingSkillsDetail(detection)).toBeNull();
    expect(codexCheck(detection)).toEqual({
      id: "skills-codex",
      severity: "ok",
      message: `Codex: all 5 required skills are installed in ${shared}`,
      remediation: "",
    });
    expect(existsSync(join(home, ".codex", "skills"))).toBe(false);
  });

  it("skills in a symlinked shared directory still count for Codex", async () => {
    const store = makeSkillsDir(join(scratch, "store"), REQUIRED_SKILLS);
    mkdirSync(join(home, ".agents"), { recursive: true });
    symlinkSync(store, join(home, ".agents", "skills"), "dir");
    mkdirSync(join(home, ".codex"), { recursive: true });

    const detection = await detectSkills(layoutFor());

    expect(entryFor(detection, "codex").status).toBe("complete");
  });

  it("skills only in $CODEX_HOME/skills → Codex complete, found there", async () => {
    const codexElsewhere = join(scratch, "xdg", "codex");
    const codexSkills = makeSkillsDir(codexElsewhere, REQUIRED_SKILLS);

    const detection = await detectSkills(layoutFor({ CODEX_HOME: codexElsewhere }));

    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("complete");
    expect(codex.foundIn).toEqual([codexSkills]);
    expect(codexCheck(detection)?.message).toBe(`Codex: all 5 required skills are installed in ${codexSkills}`);
  });

  it("skills in neither directory → Codex missing all of them, and the warning names both places", async () => {
    makeSkillsDir(join(home, ".agents"));
    mkdirSync(join(home, ".codex"), { recursive: true });

    const detection = await detectSkills(layoutFor());

    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("no-skills-dir");
    expect(codex.missing).toEqual([...REQUIRED_SKILLS]);
    expect(codex.foundIn).toEqual([]);
    expect(agentsMissingSkills(detection).map((entry) => entry.agent)).toEqual(["agents", "codex"]);
    expect(missingSkillsDetail(detection)).toContain("Codex (codex) is missing");
    const check = codexCheck(detection);
    expect(check?.severity).toBe("warn");
    expect(check?.message).toBe(
      `Codex: no skills directory at ${join(home, ".codex", "skills")} and no required skills in ${join(home, ".agents", "skills")}, so all 5 required skills are missing`,
    );
  });

  it("Codex not installed → skipped even when the shared directory is full", async () => {
    makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);

    const detection = await detectSkills(layoutFor());

    const codex = entryFor(detection, "codex");
    expect(codex.status).toBe("agent-not-installed");
    expect(codex.present).toEqual([]);
    expect(codex.missing).toEqual([]);
    expect(codexCheck(detection)?.message).toContain("skipped");
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("Claude Code does not read the shared directory", async () => {
    makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);
    const claudeSkills = makeSkillsDir(join(home, ".claude"));

    const detection = await detectSkills(layoutFor());

    const claude = entryFor(detection, "claude");
    expect(claude.searchedDirs).toEqual([claudeSkills]);
    expect(claude.status).toBe("incomplete");
    expect(claude.missing).toEqual([...REQUIRED_SKILLS]);
    expect(skillsChecks(detection).find((check) => check.id === "skills-claude")?.message).toBe(
      `Claude Code: missing ${REQUIRED_SKILLS.join(", ")} in ${claudeSkills}`,
    );
  });
});

describe("detection is read-only", () => {
  it("leaves the fake HOME byte-for-byte identical, including modes and mtimes", async () => {
    const store = makeSkillsDir(join(home, ".agents"), ["feature-workflow", "reviewing-plan"]);
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(store, join(home, ".claude", "skills"), "dir");
    mkdirSync(join(home, ".codex"), { recursive: true });

    const before = snapshot(home);
    await detectSkills(layoutFor());
    await detectSkills(layoutFor()); // twice, in case the first run "fixed" anything
    const after = snapshot(home);

    expect(after).toEqual(before);
    expect(writeAttempts).toEqual([]);
  });

  it("works with every skills directory made read-only", async () => {
    // Proof #3: with mode 0555 the operating system itself refuses any new
    // entry, so a detector that tried to create one would throw rather than
    // quietly succeed. (Meaningless when running as root; CI does not.)
    makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".claude"), ["feature-workflow"]);
    mkdirSync(join(home, ".codex"), { recursive: true });
    for (const dir of [join(home, ".agents", "skills"), join(home, ".claude", "skills"), join(home, ".codex")]) {
      chmodSync(dir, 0o555);
    }

    const detection = await detectSkills(layoutFor());

    expect(entryFor(detection, "agents").status).toBe("complete");
    expect(entryFor(detection, "claude").missing).toHaveLength(4);
    // No ~/.codex/skills, but the read-only shared directory is complete (bm-ozd).
    expect(entryFor(detection, "codex").status).toBe("complete");
    expect(existsSync(join(home, ".codex", "skills"))).toBe(false);
  });

  it("the write guard in this file actually bites", async () => {
    // A guard that cannot fail is worthless. This proves the mock at the top of
    // the file really does intercept a mutating call, so the empty
    // `writeAttempts` assertion in every other test means something.
    const { mkdir } = await import("node:fs/promises");
    await expect(mkdir(join(home, ".codex", "skills"), { recursive: true })).rejects.toThrow(
      /forbidden write/,
    );
    expect(writeAttempts).toHaveLength(1);
    writeAttempts.length = 0;
  });

  it("never throws when a skills path is unreadable", async () => {
    mkdirSync(join(home, ".agents", "skills", "feature-workflow"), { recursive: true });
    chmodSync(join(home, ".agents", "skills", "feature-workflow"), 0o000);
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });

    const detection = await detectSkills(layoutFor());

    expect(entryFor(detection, "agents").missing).toContain("feature-workflow");
  });
});

describe("report and doctor adapters", () => {
  it("maps onto the report model's skills.byAgent", async () => {
    makeSkillsDir(join(home, ".agents"), REQUIRED_SKILLS);
    makeSkillsDir(join(home, ".claude"), ["feature-workflow"]);

    const detection = await detectSkills(layoutFor());
    const byAgent = toSkillsByAgent(detection);

    expect(Object.keys(byAgent).sort()).toEqual(["agents", "claude", "codex"]);
    expect(byAgent.agents?.missing).toEqual([]);
    expect(byAgent.claude?.present).toEqual(["feature-workflow"]);
    expect(byAgent.codex).toEqual({ present: [], missing: [] });
  });

  it("never produces an error-severity check, because skills must not change an exit code", async () => {
    makeSkillsDir(join(home, ".claude"));
    const detection = await detectSkills(layoutFor());
    const checks = skillsChecks(detection);

    expect(checks).toHaveLength(SKILL_AGENT_IDS.length);
    expect(checks.some((check) => check.severity === "error")).toBe(false);
    expect(checks.map((check) => check.id)).toEqual(["skills-agents", "skills-claude", "skills-codex"]);
  });

  it("keeps the required list to the five skills of PRD Appendix A and the optional list separate", async () => {
    const detection = await detectSkills(layoutFor());
    expect(detection.required).toEqual([
      "feature-workflow",
      "reviewing-plan",
      "converting-plan-to-beads",
      "polishing-beads",
      "implementing-beads",
    ]);
    expect(detection.optional).toEqual(["architecture-premise-audit", "authoring-workspace-protocol"]);
  });
});
