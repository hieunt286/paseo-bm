import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_INSTRUCTIONS, fullInstructions } from "../plugin/server/role-instructions";
import { applyRoleInstructions } from "../plugin/server/role-hook";
import { OPTIONAL_SKILLS, REQUIRED_SKILLS, checkSkillAt, skillsStatus } from "../plugin/server/setup-skills";
import { commandsFor, findTool, installTool, toolsStatus, versionOf } from "../plugin/server/setup-tools";
import { handleSetupStatus } from "../plugin/server/setup-rpc";
import { setupEnsureRolesRpc, setupStatusSchema } from "../plugin/shared/contracts";
import { updateSetupState } from "../plugin/server/setup-state";

/** Setup screen (delta 20260916-setup-screen). */

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-setup-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const paseo = { config: { get: async () => ({ config: {} }) } };
const deps = () => ({ homedir: () => root });

describe("role instructions: the additional instructions are retired (autonomy design §B.8)", () => {
  it("reach agents through the create hook as the base, and upgrade a base-only prompt in place", () => {
    const worker = applyRoleInstructions({ config: { provider: "bm-worker", cwd: "/r" } } as never);
    expect(worker?.config.systemPrompt).toBe(fullInstructions("worker"));
    // An unbound agent's facts carry its hand path (design §16.12); a bound one with no facts is the base alone.
    expect(fullInstructions("worker", { bound: true })).toBe(BASE_INSTRUCTIONS.worker);
    const facts = { workerModeId: "bypassPermissions" };
    const manager = applyRoleInstructions({ config: { provider: "bm-manager", cwd: "/r", systemPrompt: BASE_INSTRUCTIONS.manager } } as never, facts);
    expect(manager?.config.systemPrompt).toBe(fullInstructions("manager", facts));
    // Already complete: nothing to do.
    expect(applyRoleInstructions({ config: { provider: "bm-worker", systemPrompt: fullInstructions("worker") } } as never)).toBeUndefined();
  });
});

describe("skills", () => {
  const skill = (dir: string, name: string, declared = name) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${declared}\ndescription: x\n---\nbody`);
  };

  // These were checked against a second copy in the installer's skill detection
  // until WP-406 deleted it; the plugin's lists are now the only ones.
  it("names the five skills the Worker needs, and the two that are optional", () => {
    expect([...REQUIRED_SKILLS]).toEqual([
      "feature-workflow",
      "reviewing-plan",
      "converting-plan-to-beads",
      "polishing-beads",
      "implementing-beads",
    ]);
    expect([...OPTIONAL_SKILLS]).toEqual(["architecture-premise-audit", "authoring-workspace-protocol"]);
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
    expect(status.missingRequired).toEqual({ claude: 4, codex: 0, pi: 5, opencode: 5 });
    expect(status.installCommand).toContain(`-s ${REQUIRED_SKILLS.join(" ")}`);
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const status = skillsStatus({ homedir: () => root, env: { CLAUDE_CONFIG_DIR: "/cc", CODEX_HOME: "/cx" } });
    expect(status.dirs).toEqual({
      shared: join(root, ".agents", "skills"),
      claude: "/cc/skills",
      codex: "/cx/skills",
      pi: join(root, ".pi", "agent", "skills"),
      opencode: join(root, ".config", "opencode", "skill"),
    });
  });

  describe("Pi and OpenCode (delta 20260921 §4.2.6)", () => {
    const piDir = () => join(root, ".pi", "agent", "skills");
    const opencodeDir = () => join(root, ".config", "opencode", "skill");

    it("check each agent's own directory, symlinks included, like Claude's", () => {
      // Pi: real directories, one declaring the wrong name.
      for (const name of REQUIRED_SKILLS) skill(piDir(), name);
      skill(piDir(), "polishing-beads", "polish");
      // OpenCode: links into a store elsewhere (how the `skills` CLI installs),
      // one link dangling, and one real directory whose SKILL.md is a link.
      const store = join(root, "store");
      for (const name of REQUIRED_SKILLS) skill(store, name);
      mkdirSync(opencodeDir(), { recursive: true });
      symlinkSync(join(store, "feature-workflow"), join(opencodeDir(), "feature-workflow"));
      symlinkSync(join(store, "reviewing-plan"), join(opencodeDir(), "reviewing-plan"));
      symlinkSync(join(root, "gone"), join(opencodeDir(), "converting-plan-to-beads"));
      mkdirSync(join(opencodeDir(), "implementing-beads"));
      symlinkSync(join(store, "implementing-beads", "SKILL.md"), join(opencodeDir(), "implementing-beads", "SKILL.md"));
      // The shared directory counts for Codex only.
      skill(join(root, ".agents", "skills"), "polishing-beads");

      const status = skillsStatus({ homedir: () => root, env: {} });
      const row = (name: string) => status.skills.find((entry) => entry.name === name)!;
      expect(row("feature-workflow")).toMatchObject({ claude: "missing", codex: "missing", pi: "ok", opencode: "ok" });
      expect(row("reviewing-plan")).toMatchObject({ pi: "ok", opencode: "ok" });
      expect(row("converting-plan-to-beads")).toMatchObject({ pi: "ok", opencode: "missing", problem: null });
      expect(row("polishing-beads")).toMatchObject({ codex: "ok", pi: "broken", opencode: "missing" });
      expect(row("polishing-beads").problem).toContain("declares name `polish`");
      expect(row("implementing-beads")).toMatchObject({ pi: "ok", opencode: "ok" });
      expect(row("architecture-premise-audit")).toMatchObject({ required: false, pi: "missing", opencode: "missing" });
      expect(status.missingRequired).toEqual({ claude: 5, codex: 4, pi: 1, opencode: 2 });
    });

    it("without their directories every skill is missing, like an agent that is not installed, and nothing is created", () => {
      const status = skillsStatus({ homedir: () => root, env: {} });
      for (const row of status.skills) {
        expect(row).toMatchObject({ claude: "missing", codex: "missing", pi: "missing", opencode: "missing", problem: null });
      }
      expect(status.missingRequired).toEqual({ claude: 5, codex: 5, pi: 5, opencode: 5 });
      expect(existsSync(join(root, ".pi"))).toBe(false);
      expect(existsSync(join(root, ".config"))).toBe(false);
    });

    it("are not moved by an environment variable in this release", () => {
      const status = skillsStatus({
        homedir: () => root,
        env: { XDG_CONFIG_HOME: "/xdg", CLAUDE_CONFIG_DIR: "/cc", CODEX_HOME: "/cx" },
      });
      expect(status.dirs.pi).toBe(piDir());
      expect(status.dirs.opencode).toBe(opencodeDir());
    });
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
  it("reports tools and skills together", async () => {
    const status = await handleSetupStatus(paseo, {
      ...deps(),
      env: { PATH: "" },
      isExecutable: () => false,
      run: async () => ({ code: 0, output: "" }),
    });
    expect(status.tools.map((entry) => entry.path)).toEqual([null, null, null]);
    expect(status.skills.skills).toHaveLength(REQUIRED_SKILLS.length + OPTIONAL_SKILLS.length);
    expect(status.latestCheckedOn).toBe("2026-09-16");
    // The payload passes its own contract, the Pi and OpenCode columns intact.
    expect(setupStatusSchema.parse(status)).toEqual(status);
    expect(status.skills.missingRequired).toEqual({ claude: 5, codex: 5, pi: 5, opencode: 5 });
  });

  it("an older payload without the Pi and OpenCode columns still parses", () => {
    const old = {
      tools: [],
      latestCheckedOn: "2026-09-16",
      skills: {
        checkedAt: "2026-09-20T00:00:00.000Z",
        dirs: { shared: "/h/.agents/skills", claude: "/h/.claude/skills", codex: "/h/.codex/skills" },
        skills: [{ name: "feature-workflow", required: true, claude: "ok", codex: "missing", problem: null }],
        missingRequired: { claude: 0, codex: 1 },
        installCommand: "npx -y skills add x",
      },
    };
    const parsed = setupStatusSchema.parse(old);
    expect(parsed).toEqual(old);
    expect(parsed.skills.skills[0]?.pi).toBeUndefined();
    expect(parsed.skills.missingRequired.opencode).toBeUndefined();
    // A present column still has to be a known state.
    const bad = structuredClone(old);
    Object.assign(bad.skills.skills[0]!, { pi: "installed" });
    expect(setupStatusSchema.safeParse(bad).success).toBe(false);
  });
});

describe("setup.status: what the machine's setup looks like (0.4.0, design §7.13.5)", () => {
  const setUpDaemon = (overrides: Record<string, unknown> = {}) => ({
    providers: {
      diagnostic: async (provider: string) => ({ diagnostic: `{"loggedIn": ${provider === "claude"}, "home": "/secret/path"}` }),
    },
    config: {
      get: async () => ({
        config: {
          providers: {
            "bm-manager": { extends: "claude" },
            "bm-worker": { extends: "claude" },
            "bm-reviewer": { extends: "codex" },
            "bm-orchestrator": { extends: "codex" },
          },
          agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }, { id: "bm-orchestrator" }],
          mcp: { injectIntoAgents: true },
          ...overrides,
        },
      }),
    },
  });

  const statusDeps = () => ({ ...deps(), env: { PATH: "" }, isExecutable: () => false, run: async () => ({ code: 0, output: "" }) });

  it("reports the roles, the switch, the sign-ins and the data folder", async () => {
    const status = await handleSetupStatus(setUpDaemon(), statusDeps());

    expect(status.setup).toMatchObject({
      roles: { present: ["manager", "worker", "reviewer", "orchestrator"], missing: [], created: null, cleanedUpAt: null },
      agentTools: { injectIntoAgents: true, setBy: null },
      logins: [
        { provider: "claude", roles: ["manager", "worker"], state: "logged-in", loginCommand: "claude auth login" },
        { provider: "codex", roles: ["reviewer", "orchestrator"], state: "logged-out", loginCommand: "codex login" },
      ],
      skillsRun: null,
      dataHome: { path: home, source: "default", reason: null },
    });
    expect(setupStatusSchema.parse(status)).toEqual(status);
  });

  it("keeps nothing of a provider diagnostic but the sign-in boolean", async () => {
    const status = await handleSetupStatus(setUpDaemon(), statusDeps());

    expect(JSON.stringify(status)).not.toContain("/secret/path");
  });

  it("lists what is missing on a machine that has never been set up", async () => {
    const bare = { config: { get: async () => ({ config: {} }) } };

    const status = await handleSetupStatus(bare, statusDeps());

    expect(status.setup?.roles).toMatchObject({ present: [], missing: ["manager", "worker", "reviewer", "orchestrator"] });
    expect(status.setup?.agentTools).toEqual({ injectIntoAgents: false, setBy: null });
    expect(status.setup?.logins).toEqual([]);
  });

  it("says the switch is unknown when the configuration cannot be read", async () => {
    const broken = { config: { get: async () => { throw new Error("daemon is busy"); } } };

    const status = await handleSetupStatus(broken, statusDeps());

    expect(status.setup?.agentTools.injectIntoAgents).toBeNull();
  });

  it("carries the marks the other setup steps left", async () => {
    updateSetupState(
      {
        agentTools: { setBy: "plugin", previous: false, at: "2026-09-25T10:00:00.000Z" },
        rolesCreated: {
          at: "2026-09-25T09:00:00.000Z",
          roles: ["manager", "reviewer"],
          baseProvider: "claude",
          model: "claude-opus-5",
          reviewer: { baseProvider: "codex", model: "gpt-5.6-sol" },
        },
        skillsRun: { at: "2026-09-25T09:30:00.000Z", command: "npx -y skills add x", code: 0, outcome: "ok" },
        cleanedUpAt: "2026-09-25T11:00:00.000Z",
      },
      { env: {}, homedir: () => root },
    );

    const status = await handleSetupStatus(setUpDaemon(), statusDeps());

    expect(status.setup?.agentTools.setBy).toBe("plugin");
    expect(status.setup?.roles.created).toMatchObject({ roles: ["manager", "reviewer"], baseProvider: "claude" });
    // The Reviewer apart survives the contract, which an older server's answer (no field) also passes.
    expect(setupStatusSchema.parse(status).setup?.roles.created?.reviewer).toEqual({ baseProvider: "codex", model: "gpt-5.6-sol" });
    expect(status.setup?.roles.cleanedUpAt).toBe("2026-09-25T11:00:00.000Z");
    expect(status.setup?.skillsRun).toMatchObject({ outcome: "ok" });
  });

  it("setup.ensure-roles carries the Reviewer apart only when there is one", () => {
    const base = { created: ["reviewer"], baseProvider: "claude", model: "claude-opus-5", skipped: null };
    const reviewer = { baseProvider: "codex", model: "gpt-5.6-sol" };
    expect(setupEnsureRolesRpc.output.parse({ ...base, reviewer })).toEqual({ ...base, reviewer });
    expect(setupEnsureRolesRpc.output.parse(base)).not.toHaveProperty("reviewer");
  });

  it("reports an unusable data folder with its reason instead of failing", async () => {
    const status = await handleSetupStatus(setUpDaemon(), { ...statusDeps(), env: { PATH: "", PASEO_BM_HOME: "relative/bm" } });

    expect(status.setup?.dataHome).toMatchObject({ path: null, source: null });
    expect(status.setup?.dataHome.reason).toContain("absolute path");
  });

  it("writes nothing", async () => {
    rmSync(home, { recursive: true, force: true });

    await handleSetupStatus(setUpDaemon(), statusDeps());

    expect(existsSync(home)).toBe(false);
  });
});
