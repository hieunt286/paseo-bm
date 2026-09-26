import { describe, expect, it } from "vitest";
import { renderHelp, runCli } from "../src/cli.js";
import type { CommandContext, CommandHandlers, Writer } from "../src/cli.js";
import { EXIT_CODES, FLAG_SPECS } from "../src/flags.js";
import { RETIRED_FLAGS } from "../src/retired.js";
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
    handlers: { migrate: make("migrate"), install: make("install") },
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
  it("lists only the 0.4.0 surface, and says where everything else went", async () => {
    const h = harness();
    expect(await run(["--help"], h)).toBe(EXIT_CODES.ok);
    const text = h.out();

    for (const spec of FLAG_SPECS) {
      if (RETIRED_FLAGS[spec.flag] !== undefined) {
        expect(text, `retired flag still offered: ${spec.flag}`).not.toContain(spec.flag);
        continue;
      }
      expect(text, `missing flag ${spec.flag}`).toContain(spec.flag);
    }
    expect(text).toContain("-h, --help");
    expect(text).toContain("-v, --version");
    // The jobs that moved into the plugin are named, so `--help` still answers
    // "how do I install / check / remove it?".
    expect(text).toContain("paseo plugin add npm:paseo-bm-plugin");
    expect(text).toContain("Beads Manager → Setup");
    expect(text).toContain("paseo plugin remove paseo-bm");
    expect(h.seen).toHaveLength(0);
  });

  it("states that --yes never grants a trust boundary", async () => {
    const h = harness();
    await run(["--help"], h);
    expect(h.out()).toMatch(/--yes only skips the apply confirmation/);
  });

  it("documents the exit codes 0.4.0 can still return, and no others", async () => {
    const h = harness();
    await run(["--help"], h);
    for (const code of [0, 2, 3, 5, 6, 7]) {
      expect(h.out()).toMatch(new RegExp(`\\n  ${code} `));
    }
    // 1 was `doctor` drift and 4 was a missing consent: neither exists now,
    // and neither number is ever reused.
    for (const gone of [1, 4]) {
      expect(h.out()).not.toMatch(new RegExp(`\\n  ${gone} `));
    }
  });

  it("narrows the option list for a command topic, and offers no retired flag", () => {
    const optionLine = (flag: string): RegExp => new RegExp(`\\n {2}\\${flag}( |$)`, "m");
    const install = renderHelp("install");

    expect(install).toMatch(optionLine("--apply"));
    expect(install).toMatch(optionLine("--home"));
    for (const retired of Object.keys(RETIRED_FLAGS)) {
      expect(install, `retired flag still offered: ${retired}`).not.toMatch(optionLine(retired));
    }
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

  // A flag on a command that does not take it. `doctor` and `uninstall` are
  // gone in 0.4.0, and so is every flag that used to be wrong on them: those
  // now answer with their retirement (test/retired.test.ts).
  it("rejects a flag that does not exist at all", async () => {
    const h = harness();
    expect(await run(["install", "--nope"], h)).toBe(EXIT_CODES.usage);
    expect(h.err()).toContain("--nope");
    expect(h.seen).toHaveLength(0);
  });
});

describe("runCli — routing", () => {
  it("routes install to its handler", async () => {
    const h = harness();
    await run(["install"], h);
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.command).toBe("install");
    expect(h.seen[0]?.explicitCommand).toBe(true);
  });

  // 0.4.0 only migrates (ADR-012 decision 7): `doctor` and `uninstall` are
  // answered with the sentence that says where the job went, not routed.
  it.each(["doctor", "uninstall"] as const)("answers %s with its retirement instead of running it", async (command) => {
    const h = harness();
    expect(await run([command], h)).toBe(EXIT_CODES.usage);
    expect(h.seen).toHaveLength(0);
    expect(h.err()).toContain("E_COMMAND_RETIRED");
  });

  it("routes a bare invocation to migrate, flagged as implicit", async () => {
    const h = harness();
    await run([], h);
    expect(h.seen[0]?.command).toBe("migrate");
    expect(h.seen[0]?.explicitCommand).toBe(false);
  });

  it("returns the handler's exit code unchanged", async () => {
    const h = harness({ install: EXIT_CODES.conflict });
    expect(await run(["install"], h)).toBe(EXIT_CODES.conflict);
  });

  it("hands the handler its flags, flag-level home overrides and TTY state", async () => {
    const h = harness();
    await run(["install", "--apply", "--paseo-home=/flag/paseo"], h, {
      tty: NO_TTY,
      env: { PASEO_HOME: "/env/paseo" },
    });
    const context = h.seen[0];
    expect(context?.flags.apply).toBe(true);
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
      install: () => {
        throw new Error("boom");
      },
    };
    await expect(
      runCli(["install"], { handlers, stdout: h.stdout, stderr: h.stderr, env: {}, tty: TTY, createPrompter: () => prompter }),
    ).rejects.toThrow("boom");
    expect(prompter.isClosed).toBe(true);
  });
});

