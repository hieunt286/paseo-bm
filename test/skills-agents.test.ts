import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { CommandContext, CommandHandlers } from "../src/cli.js";
import { EXIT_CODES } from "../src/flags.js";
import {
  DEFAULT_SKILLS_AGENTS,
  MAX_SKILLS_AGENTS,
  parseSkillsAgents,
} from "../src/skills/agents.js";
import { startWriteScope } from "./helpers/write-scope.js";

describe("parseSkillsAgents", () => {
  it("falls back to claude,codex when the flag is absent", () => {
    expect(parseSkillsAgents(undefined)).toEqual({ ok: true, agents: DEFAULT_SKILLS_AGENTS });
    expect(DEFAULT_SKILLS_AGENTS).toEqual(["claude", "codex"]);
  });

  const valid: readonly (readonly [string, readonly string[]])[] = [
    ["claude", ["claude"]],
    ["claude,codex", ["claude", "codex"]],
    [" claude , codex ", ["claude", "codex"]],
    ["open_code,agent-2,9lives", ["open_code", "agent-2", "9lives"]],
    ["a".repeat(32), ["a".repeat(32)]],
    [Array.from({ length: MAX_SKILLS_AGENTS }, (_, i) => `a${String(i)}`).join(","), Array.from({ length: MAX_SKILLS_AGENTS }, (_, i) => `a${String(i)}`)],
  ];
  for (const [value, agents] of valid) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      expect(parseSkillsAgents(value)).toEqual({ ok: true, agents });
    });
  }

  const invalid: readonly (readonly [string, string, RegExp])[] = [
    ["strange characters", "claude,Codex", /is not an agent name/],
    ["shell metacharacters", "claude;rm", /is not an agent name/],
    ["a space inside a name", "open code", /is not an agent name/],
    ["a name longer than 32", "a".repeat(33), /is not an agent name/],
    ["a leading dash", "claude,--global", /starts with "-"/],
    ["a single leading dash", "-y", /starts with "-"/],
    ["duplicates", "claude,codex,claude", /"claude" is given more than once/],
    ["more than 8", Array.from({ length: 9 }, (_, i) => `a${String(i)}`).join(","), /9 agents were given; at most 8/],
    ["an empty element", "claude,,codex", /empty element/],
    ["an empty value", "", /empty element/],
  ];
  for (const [label, value, why] of invalid) {
    it(`rejects ${label} with E_BAD_SKILLS_AGENTS`, () => {
      const result = parseSkillsAgents(value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("E_BAD_SKILLS_AGENTS");
      expect(result.error.message).toMatch(why);
      expect(result.error.hint).toContain("--skills-agents claude,codex");
    });
  }
});

describe("runCli — --skills-agents at parse time", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bm-skills-agents-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function harness() {
    let err = "";
    const seen: CommandContext[] = [];
    const handler = (context: CommandContext) => {
      seen.push(context);
      // Would be a write if the handler were ever reached with a bad list.
      writeFileSync(join(root, "home", ".paseo-bm", "reached"), "x");
      return EXIT_CODES.ok;
    };
    const handlers: CommandHandlers = { install: handler, doctor: handler, uninstall: handler };
    return {
      seen,
      err: () => err,
      run: (argv: readonly string[]) =>
        runCli(argv, {
          handlers,
          stdout: () => undefined,
          stderr: (text) => {
            err += text;
          },
          env: {},
          tty: { stdin: false, stdout: false, interactive: false },
        }),
    };
  }

  const bad: readonly (readonly [string, string])[] = [
    ["strange characters", "claude,Co$dex"],
    ["a leading dash", "-g"],
    ["duplicates", "codex,codex"],
    ["more than 8", "a,b,c,d,e,f,g,h,i"],
  ];
  for (const command of ["install", "doctor"] as const) {
    for (const [label, value] of bad) {
      it(`${command}: ${label} exits 2 with E_BAD_SKILLS_AGENTS and writes nothing`, async () => {
        const home = join(root, "home");
        const scope = startWriteScope({
          installHome: join(home, ".paseo-bm"),
          paseoHome: join(home, ".paseo"),
          watch: [root],
          mode: "record",
        });
        const h = harness();
        try {
          const flag = `--skills-agents=${value}`;
          const argv = command === "install" ? [command, "--apply", flag] : [command, flag];
          expect(await h.run(argv)).toBe(EXIT_CODES.usage);
        } finally {
          scope.restore();
        }
        expect(h.err()).toContain("error: E_BAD_SKILLS_AGENTS:");
        expect(h.seen).toHaveLength(0);
        expect(scope.writes).toEqual([]);
      });
    }
  }

  it("the write guard does see a write in the fake home (the zero above is meaningful)", () => {
    const home = join(root, "home");
    const scope = startWriteScope({
      installHome: join(home, ".paseo-bm"),
      paseoHome: join(home, ".paseo"),
      watch: [root],
      mode: "record",
    });
    try {
      writeFileSync(join(root, "stray"), "x");
    } finally {
      scope.restore();
    }
    expect(scope.writes.length).toBeGreaterThan(0);
  });

  it("hands the validated list, or the default, to the handler", async () => {
    const seen: CommandContext[] = [];
    const record = (context: CommandContext) => {
      seen.push(context);
      return EXIT_CODES.ok;
    };
    const deps = {
      handlers: { install: record, doctor: record, uninstall: record },
      stdout: () => undefined,
      stderr: () => undefined,
      env: {},
      tty: { stdin: false, stdout: false, interactive: false },
    };
    expect(await runCli(["doctor", "--skills-agents", "claude, opencode"], deps)).toBe(EXIT_CODES.ok);
    expect(await runCli(["doctor"], deps)).toBe(EXIT_CODES.ok);
    expect(seen.map((context) => context.skillsAgents)).toEqual([["claude", "opencode"], ["claude", "codex"]]);
  });
});
