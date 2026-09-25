import { describe, expect, it } from "vitest";
import { renderHelp, runCli } from "../src/cli.js";
import type { CommandContext, CommandHandlers, Writer } from "../src/cli.js";
import { COMMAND_SPECS, EXIT_CODES, FLAG_SPECS } from "../src/flags.js";
import { NonInteractivePrompter, ScriptedPrompter } from "../src/prompter.js";
import type { Prompter, TtyInfo } from "../src/prompter.js";
import { readVersion } from "../src/version.js";

const TTY: TtyInfo = { stdin: true, stdout: true, interactive: true };
const NO_TTY: TtyInfo = { stdin: false, stdout: false, interactive: false };

interface Harness {
  readonly out: () => string;
  readonly err: () => string;
  readonly seen: CommandContext[];
  readonly handlers: CommandHandlers;
  readonly stdout: Writer;
  readonly stderr: Writer;
}

function harness(overrides: Partial<Record<keyof CommandHandlers, number>> = {}): Harness {
  let out = "";
  let err = "";
  const seen: CommandContext[] = [];
  const make = (name: keyof CommandHandlers) => (context: CommandContext) => {
    seen.push(context);
    return overrides[name] ?? EXIT_CODES.ok;
  };
  return {
    out: () => out,
    err: () => err,
    seen,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    handlers: { install: make("install"), doctor: make("doctor"), uninstall: make("uninstall") },
  };
}

function run(
  argv: readonly string[],
  h: Harness,
  extra: { tty?: TtyInfo; prompter?: Prompter; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  return runCli(argv, {
    handlers: h.handlers,
    stdout: h.stdout,
    stderr: h.stderr,
    env: extra.env ?? {},
    tty: extra.tty ?? TTY,
    ...(extra.prompter === undefined ? {} : { createPrompter: () => extra.prompter as Prompter }),
  });
}

describe("runCli — help", () => {
  it("lists every subcommand and every flag", async () => {
    const h = harness();
    expect(await run(["--help"], h)).toBe(EXIT_CODES.ok);
    const text = h.out();
    for (const command of COMMAND_SPECS) {
      expect(text, `missing command ${command.name}`).toContain(`  ${command.name}`);
    }
    for (const spec of FLAG_SPECS) {
      expect(text, `missing flag ${spec.flag}`).toContain(spec.flag);
    }
    expect(text).toContain("-h, --help");
    expect(text).toContain("-v, --version");
    expect(h.seen).toHaveLength(0);
  });

  it("states that --yes never grants a trust boundary", async () => {
    const h = harness();
    await run(["--help"], h);
    expect(h.out()).toMatch(/--yes only skips the apply confirmation/);
  });

  it("documents the exit code table", async () => {
    const h = harness();
    await run(["--help"], h);
    for (const code of [0, 1, 2, 3, 4, 5, 6]) {
      expect(h.out()).toMatch(new RegExp(`\\n  ${code} `));
    }
  });

  it("narrows the option list for a command topic", async () => {
    const optionLine = (flag: string): RegExp => new RegExp(`\\n {2}\\${flag}( |$)`, "m");
    const uninstall = renderHelp("uninstall");
    expect(uninstall).toMatch(optionLine("--restore-backups"));
    expect(uninstall).not.toMatch(optionLine("--enable-plugins"));
    const doctor = renderHelp("doctor");
    expect(doctor).toMatch(optionLine("--skills-agents"));
    expect(doctor).not.toMatch(optionLine("--apply"));
    expect(doctor).not.toMatch(optionLine("--prune"));
  });

  it("prints the package version for --version", async () => {
    const h = harness();
    expect(await run(["--version"], h)).toBe(EXIT_CODES.ok);
    expect(h.out()).toBe(`${readVersion()}\n`);
  });
});

describe("runCli — misuse returns exit code 2", () => {
  it("rejects an unknown flag without running a command", async () => {
    const h = harness();
    expect(await run(["install", "--nope"], h)).toBe(EXIT_CODES.usage);
    expect(h.err()).toContain("Unknown flag --nope");
    expect(h.err()).toContain("--help");
    expect(h.seen).toHaveLength(0);
    expect(h.out()).toBe("");
  });

  it("rejects an unknown command", async () => {
    const h = harness();
    expect(await run(["instal"], h)).toBe(EXIT_CODES.usage);
    expect(h.err()).toContain('Unknown command "instal"');
  });

  it.each([
    ["doctor", "--apply"],
    ["doctor", "--yes"],
    ["doctor", "--force"],
    ["doctor", "--prune"],
    ["install", "--restore-backups"],
    ["uninstall", "--enable-plugins"],
    ["uninstall", "--install-skills"],
    ["uninstall", "--reconfigure"],
  ])("rejects %s %s", async (command, flag) => {
    const h = harness();
    expect(await run([command, flag], h)).toBe(EXIT_CODES.usage);
    expect(h.err()).toContain(flag);
    expect(h.seen).toHaveLength(0);
  });
});

describe("runCli — routing", () => {
  it.each(["install", "doctor", "uninstall"] as const)("routes %s to its handler", async (command) => {
    const h = harness();
    await run([command], h);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.command).toBe(command);
    expect(h.seen[0]?.explicitCommand).toBe(true);
  });

  it("routes a bare invocation to install, flagged as implicit", async () => {
    const h = harness();
    await run([], h);
    expect(h.seen[0]?.command).toBe("install");
    expect(h.seen[0]?.explicitCommand).toBe(false);
  });

  it("returns the handler's exit code unchanged", async () => {
    const h = harness({ doctor: EXIT_CODES.doctorDrift });
    expect(await run(["doctor"], h)).toBe(EXIT_CODES.doctorDrift);
  });

  it("hands the handler its flags, flag-level home overrides and TTY state", async () => {
    const h = harness();
    await run(
      ["install", "--apply", "--role", "worker=codex/gpt-5.6-sol", "--paseo-home=/flag/paseo"],
      h,
      { tty: NO_TTY, env: { PASEO_HOME: "/env/paseo" } },
    );
    const context = h.seen[0];
    expect(context?.flags.apply).toBe(true);
    expect(context?.flags.role).toEqual(["worker=codex/gpt-5.6-sol"]);
    expect(context?.homes.paseoHome).toBe("/flag/paseo");
    expect(context?.tty.interactive).toBe(false);
  });

  // context.homes carries the *flag* layer only. Environment variables and
  // defaults are applied later by resolveLayout() in src/layout.ts, which owns
  // the flag > env > daemon > default contract. Resolving env here too would
  // give that contract two implementations that can drift apart.
  it("does not fold environment variables into the home overrides", async () => {
    const h = harness();
    await run(["install"], h, { tty: NO_TTY, env: { PASEO_HOME: "/env/paseo" } });
    expect(h.seen[0]?.homes.paseoHome).toBeUndefined();
  });

  it("gives a non-interactive session a prompter that refuses instead of blocking", async () => {
    const h = harness();
    await run(["install"], h, { tty: NO_TTY });
    expect(h.seen[0]?.prompter).toBeInstanceOf(NonInteractivePrompter);
    expect(h.seen[0]?.prompter.interactive).toBe(false);
  });

  it("closes the prompter even when the handler throws", async () => {
    const prompter = new ScriptedPrompter();
    const h = harness();
    const handlers: CommandHandlers = {
      ...h.handlers,
      doctor: () => {
        throw new Error("boom");
      },
    };
    await expect(
      runCli(["doctor"], { handlers, stdout: h.stdout, stderr: h.stderr, env: {}, tty: TTY, createPrompter: () => prompter }),
    ).rejects.toThrow("boom");
    expect(prompter.isClosed).toBe(true);
  });
});

describe("runCli — a simulated interactive install runs end to end on the scripted prompter", () => {
  /**
   * Stand-in for the WP-105 install flow: the happy path of Design §4.5 asks
   * exactly three confirmations — apply, the single trust boundary covering
   * plugins plus agent tool access, and the skills CLI — plus role questions
   * that are not confirmations. The confirm counter is the evidence for M-1.
   */
  const installFlow = async (context: CommandContext): Promise<number> => {
    const { prompter, stdout } = context;
    stdout("preview: 3 actions\n");

    if (!context.flags.yes && !(await prompter.confirm({ message: "Apply these changes?" }))) {
      return EXIT_CODES.ok;
    }

    const name = await prompter.input({ message: "Worker agent name", defaultValue: "Beads Worker" });
    const provider = await prompter.select({
      message: "Provider for Worker",
      choices: [
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex" },
      ],
    });
    stdout(`worker: ${name} on ${provider}\n`);

    const trusted =
      context.flags.enablePlugins ||
      (await prompter.confirm({
        message: "Enable plugins and grant Paseo tool access to agents?",
        details: ["Plugin code is not sandboxed.", "Every agent on this machine gains agent-control tools."],
      }));
    stdout(`trust boundary: ${trusted ? "granted" : "declined"}\n`);

    const skills =
      context.flags.installSkills ||
      (await prompter.confirm({ message: "Run `npx -y skills add ...` for claude,codex?" }));
    stdout(`skills: ${skills ? "assisted" : "manual"}\n`);

    return trusted ? EXIT_CODES.ok : EXIT_CODES.consentMissing;
  };

  it("asks exactly three confirmations on the happy path (M-1)", async () => {
    const prompter = new ScriptedPrompter({
      confirm: [true, true, true],
      input: ["Beads Worker"],
      select: ["codex"],
    });
    const h = harness();
    const code = await runCli(["install", "--apply"], {
      handlers: { ...h.handlers, install: installFlow },
      stdout: h.stdout,
      stderr: h.stderr,
      env: {},
      tty: TTY,
      createPrompter: () => prompter,
    });

    expect(code).toBe(EXIT_CODES.ok);
    expect(prompter.counts.confirm).toBe(3);
    expect(prompter.counts).toEqual({ confirm: 3, input: 1, select: 1, total: 5 });
    expect(prompter.confirmMessages).toEqual([
      "Apply these changes?",
      "Enable plugins and grant Paseo tool access to agents?",
      "Run `npx -y skills add ...` for claude,codex?",
    ]);
    expect(h.out()).toContain("worker: Beads Worker on codex");
    expect(h.out()).toContain("trust boundary: granted");
    expect(h.out()).toContain("skills: assisted");
    expect(prompter.isClosed).toBe(true);
  });

  it("--yes drops only the apply confirmation, never a trust boundary", async () => {
    const prompter = new ScriptedPrompter({ confirm: [true, true], input: ["Beads Worker"], select: ["codex"] });
    const h = harness();
    await runCli(["install", "--apply", "--yes"], {
      handlers: { ...h.handlers, install: installFlow },
      stdout: h.stdout,
      stderr: h.stderr,
      env: {},
      tty: TTY,
      createPrompter: () => prompter,
    });

    expect(prompter.counts.confirm).toBe(2);
    expect(prompter.confirmMessages).toEqual([
      "Enable plugins and grant Paseo tool access to agents?",
      "Run `npx -y skills add ...` for claude,codex?",
    ]);
  });

  it("--enable-plugins covers both halves of the trust boundary with one answer", async () => {
    const prompter = new ScriptedPrompter({ confirm: [true, true], input: ["Beads Worker"], select: ["codex"] });
    const h = harness();
    const code = await runCli(["install", "--apply", "--enable-plugins"], {
      handlers: { ...h.handlers, install: installFlow },
      stdout: h.stdout,
      stderr: h.stderr,
      env: {},
      tty: TTY,
      createPrompter: () => prompter,
    });

    expect(code).toBe(EXIT_CODES.ok);
    expect(h.out()).toContain("trust boundary: granted");
    expect(prompter.confirmMessages).toEqual([
      "Apply these changes?",
      "Run `npx -y skills add ...` for claude,codex?",
    ]);
  });

  it("declining the trust boundary still finishes, and reports exit code 4", async () => {
    const prompter = new ScriptedPrompter({ confirm: [true, false, false], input: [], select: ["claude"] });
    const h = harness();
    const code = await runCli(["install", "--apply"], {
      handlers: { ...h.handlers, install: installFlow },
      stdout: h.stdout,
      stderr: h.stderr,
      env: {},
      tty: TTY,
      createPrompter: () => prompter,
    });

    expect(code).toBe(EXIT_CODES.consentMissing);
    expect(h.out()).toContain("trust boundary: declined");
    expect(prompter.counts.confirm).toBe(3);
  });
});
