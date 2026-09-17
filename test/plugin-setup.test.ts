import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BASE_INSTRUCTIONS,
  EXTRA_HEADING,
  MAX_EXTRA_CHARS,
  fullInstructions,
  readRoleExtras,
  saveRoleExtra,
} from "../plugin/server/role-extras";
import { applyRoleInstructions } from "../plugin/server/role-hook";
import { OPTIONAL_SKILLS, REQUIRED_SKILLS, checkSkillAt, skillsStatus } from "../plugin/server/setup-skills";
import { commandsFor, findTool, installTool, toolsStatus, versionOf } from "../plugin/server/setup-tools";
import { handleRolesInstructions, handleRolesSaveExtra, handleSetupStatus } from "../plugin/server/setup-rpc";
import { OPTIONAL_SKILLS as CLI_OPTIONAL, REQUIRED_SKILLS as CLI_REQUIRED } from "../src/skills/detect";

/** Setup screen (delta 20260916-setup-screen). */

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-setup-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "install.json"), JSON.stringify({ schemaVersion: 1 }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const paseo = { config: { get: async () => ({ config: {} }) } };
const deps = () => ({ homedir: () => root });

describe("additional role instructions", () => {
  it("append after the base under a heading that keeps the rules on top", () => {
    const full = fullInstructions("worker", "  Always answer in Vietnamese.  ");
    expect(full.startsWith(BASE_INSTRUCTIONS.worker.trimEnd())).toBe(true);
    expect(full).toContain(EXTRA_HEADING);
    expect(full.trimEnd().endsWith("Always answer in Vietnamese.")).toBe(true);
    expect(fullInstructions("worker", "   ")).toBe(BASE_INSTRUCTIONS.worker);
  });

  it("are saved per role, 0600, and read back; a broken file reads as empty", () => {
    saveRoleExtra(home, "worker", "Use pnpm.");
    const roles = saveRoleExtra(home, "reviewer", "Check i18n keys.");
    expect(roles).toEqual({ manager: "", worker: "Use pnpm.", reviewer: "Check i18n keys." });
    expect(readRoleExtras(home)).toEqual(roles);
    expect(statSync(join(home, "role-extras.json")).mode & 0o777).toBe(0o600);
    writeFileSync(join(home, "role-extras.json"), "{broken");
    expect(readRoleExtras(home)).toEqual({ manager: "", worker: "", reviewer: "" });
  });

  it("refuse text over the limit and a symlinked file", () => {
    expect(() => saveRoleExtra(home, "worker", "x".repeat(MAX_EXTRA_CHARS + 1))).toThrow(/E_ROLE_EXTRA_INVALID/);
    // An install home that is a symlink to somewhere else is refused.
    const target = join(root, "outside");
    mkdirSync(target);
    rmSync(home, { recursive: true });
    symlinkSync(target, home);
    expect(() => saveRoleExtra(home, "worker", "x")).toThrow(/E_TRACE_STORE_UNWRITABLE/);
  });

  it("reach agents through the create hook, and upgrade a base-only prompt in place", () => {
    const extras = { worker: "Use pnpm.", manager: "Reply in Vietnamese." };
    const worker = applyRoleInstructions({ config: { provider: "bm-worker", cwd: "/r" } } as never, extras);
    expect(worker?.config.systemPrompt).toBe(fullInstructions("worker", "Use pnpm."));
    const manager = applyRoleInstructions(
      { config: { provider: "bm-manager", cwd: "/r", systemPrompt: BASE_INSTRUCTIONS.manager } } as never,
      extras,
    );
    expect(manager?.config.systemPrompt).toBe(fullInstructions("manager", "Reply in Vietnamese."));
    // Already complete: nothing to do.
    expect(
      applyRoleInstructions({ config: { provider: "bm-worker", systemPrompt: fullInstructions("worker", "Use pnpm.") } } as never, extras),
    ).toBeUndefined();
  });

  it("are served and saved through the RPCs", async () => {
    await handleRolesSaveExtra({ role: "manager", text: "Keep it short." }, paseo, deps());
    const got = await handleRolesInstructions({ role: "manager" }, paseo, deps());
    expect(got).toMatchObject({ extra: "Keep it short.", base: BASE_INSTRUCTIONS.manager, path: join(home, "role-extras.json"), maxChars: MAX_EXTRA_CHARS });
    expect(got.full).toBe(fullInstructions("manager", "Keep it short."));
    await expect(handleRolesSaveExtra({ role: "manager", text: "x" }, paseo, { homedir: () => join(root, "none") })).rejects.toThrow(
      /E_ROLE_EXTRA_INVALID/,
    );
  });
});

describe("skills", () => {
  const skill = (dir: string, name: string, declared = name) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${declared}\ndescription: x\n---\nbody`);
  };

  it("uses the same lists as the CLI", () => {
    expect([...REQUIRED_SKILLS]).toEqual([...CLI_REQUIRED]);
    expect([...OPTIONAL_SKILLS]).toEqual([...CLI_OPTIONAL]);
  });

  it("counts Claude's own directory, and the shared or own directory for Codex", () => {
    for (const name of REQUIRED_SKILLS) skill(join(root, ".agents", "skills"), name);
    skill(join(root, ".claude", "skills"), "feature-workflow");
    skill(join(root, ".claude", "skills"), "reviewing-plan", "something-else");
    const status = skillsStatus({ homedir: () => root, env: {} });
    const row = (name: string) => status.skills.find((entry) => entry.name === name)!;
    expect(row("feature-workflow")).toMatchObject({ claude: "ok", codex: "ok", required: true });
    expect(row("reviewing-plan")).toMatchObject({ claude: "broken", codex: "ok" });
    expect(row("reviewing-plan").problem).toContain("declares name `something-else`");
    expect(row("implementing-beads")).toMatchObject({ claude: "missing", codex: "ok" });
    expect(row("architecture-premise-audit")).toMatchObject({ required: false, claude: "missing", codex: "missing" });
    expect(status.missingRequired).toEqual({ claude: 4, codex: 0 });
    expect(status.installCommand).toContain(`-s ${REQUIRED_SKILLS.join(" ")}`);
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const status = skillsStatus({ homedir: () => root, env: { CLAUDE_CONFIG_DIR: "/cc", CODEX_HOME: "/cx" } });
    expect(status.dirs).toEqual({ shared: join(root, ".agents", "skills"), claude: "/cc/skills", codex: "/cx/skills" });
  });

  it("reports a SKILL.md without frontmatter as broken", () => {
    mkdirSync(join(root, "s", "x"), { recursive: true });
    writeFileSync(join(root, "s", "x", "SKILL.md"), "no frontmatter");
    expect(checkSkillAt(join(root, "s"), "x", (path) => readFileSync(path, "utf8")).state).toBe("broken");
  });
});

describe("br and bv", () => {
  const bin = () => join(root, "bin");
  const tool = (name: string) => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(bin(), name), "#!/bin/sh\n", { mode: 0o755 });
  };
  const toolDeps = (run = vi.fn(async () => ({ code: 0, output: "" }))) => ({
    env: { PATH: bin() },
    homedir: () => join(root, "nohome"),
    isExecutable: (path: string) => {
      try {
        return statSync(path).isFile() && path.startsWith(bin());
      } catch {
        return false;
      }
    },
    run,
  });

  it("finds the tools and reads only --version", async () => {
    tool("br");
    tool("bv");
    const run = vi.fn(async (file: string, args: string[]) => ({
      code: 0,
      output: args.join(" ") !== "--version" ? "" : file.endsWith("br") ? "br 0.2.10\n" : "bv v0.16.4\n",
    }));
    const tools = await toolsStatus(toolDeps(run));
    expect(tools.map((entry) => [entry.id, entry.version, entry.path !== null])).toEqual([
      ["br", "0.2.10", true],
      ["bv", "v0.16.4", true],
      ["bd", null, false],
    ]);
    expect(run.mock.calls.every((call) => JSON.stringify(call[1]) === '["--version"]')).toBe(true);
    expect(tools[0]).toMatchObject({ required: true, latestKnown: "0.6.0" });
    expect(versionOf("\nbd version 1.2.3 (abc)\n")).toBe("1.2.3 (abc)");
  });

  it("prefers Homebrew, else the documented scripts (br without skills, bv pinned)", () => {
    expect(commandsFor("br", "/opt/homebrew/bin/brew")).toEqual({
      install: "brew install dicklesworthstone/tap/br",
      update: "brew upgrade dicklesworthstone/tap/br",
    });
    expect(commandsFor("br", null).install).toBe(
      "curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash -s -- --skip-skills",
    );
    expect(commandsFor("bv", null).install).toContain("/beads_viewer/a43b8e85a39664381566abdfd85dc8fcbfdcb773/install.sh");
    expect(commandsFor("bd", null)).toEqual({ install: null, update: null });
  });

  it("installs only a missing tool, with the shown command, and reports a failure", async () => {
    tool("br");
    await expect(installTool("br", toolDeps())).rejects.toThrow(/E_TOOL_PRESENT/);

    tool("brew");
    const run = vi.fn(async () => ({ code: 0, output: "==> Pouring bv\n==> Done\n" }));
    const done = await installTool("bv", toolDeps(run));
    expect(done).toEqual({ command: "brew install dicklesworthstone/tap/bv", code: 0, tail: ["==> Pouring bv", "==> Done"] });
    expect(run).toHaveBeenCalledWith("/bin/bash", ["-lc", "brew install dicklesworthstone/tap/bv"], 300_000);

    const failing = vi.fn(async () => ({ code: 1, output: "Error: no network\n" }));
    await expect(installTool("bv", toolDeps(failing))).rejects.toThrow(/E_TOOL_INSTALL_FAILED.*no network/);
    expect(findTool("bv", toolDeps())).toBeNull();
  });
});

describe("setup.status", () => {
  it("reports tools, skills and extra lengths together", async () => {
    saveRoleExtra(home, "worker", "Use pnpm.");
    const status = await handleSetupStatus(paseo, {
      ...deps(),
      env: { PATH: "" },
      isExecutable: () => false,
      run: async () => ({ code: 0, output: "" }),
    });
    expect(status.tools.map((entry) => entry.path)).toEqual([null, null, null]);
    expect(status.extras).toEqual({ manager: 0, worker: 9, reviewer: 0 });
    expect(status.skills.skills).toHaveLength(REQUIRED_SKILLS.length + OPTIONAL_SKILLS.length);
    expect(status.latestCheckedOn).toBe("2026-09-16");
  });
});
