import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  EXIT_CODES,
  FLAG_SPECS,
  parseCommandLine,
  homeFlagOverrides,
} from "../src/flags.js";
import type { CommandName, FlagSpec, ParsedCommandLine } from "../src/flags.js";

/**
 * Transcribed from Technical Design §4.2. This table is the contract: if a row
 * here and a row in FLAG_SPECS disagree, the published command line changed.
 */
const DESIGN_FLAG_TABLE: readonly (readonly [string, readonly CommandName[]])[] = [
  ["--apply", ["install", "uninstall"]],
  ["--yes", ["install", "uninstall"]],
  ["--enable-plugins", ["install"]],
  ["--install-skills", ["install"]],
  ["--skills-agents", ["install", "doctor"]],
  ["--role", ["install"]],
  ["--reconfigure", ["install"]],
  ["--skip-skills-check", ["install", "doctor"]],
  ["--force", ["install", "uninstall"]],
  ["--ask-skills-again", ["install"]],
  ["--restore-backups", ["uninstall"]],
  ["--prune", ["install"]],
  ["--home", ["install", "doctor", "uninstall"]],
  ["--paseo-home", ["install", "doctor", "uninstall"]],
  ["--claude-home", ["install", "doctor", "uninstall"]],
  ["--codex-home", ["install", "doctor", "uninstall"]],
  ["--json", ["install", "doctor", "uninstall"]],
  ["--verbose", ["install", "doctor", "uninstall"]],
];

function expectOk(argv: readonly string[]): ParsedCommandLine {
  const result = parseCommandLine(argv);
  if (!result.ok) {
    throw new Error(`expected ${argv.join(" ")} to parse, got: ${result.error.message}`);
  }
  return result.parsed;
}

function expectUsageError(argv: readonly string[]): string {
  const result = parseCommandLine(argv);
  if (result.ok) {
    throw new Error(`expected ${argv.join(" ")} to be rejected`);
  }
  return result.error.message;
}

function sample(spec: FlagSpec): string[] {
  switch (spec.kind) {
    case "boolean":
      return [spec.flag];
    case "value":
      return [spec.flag, "/tmp/x"];
    case "repeatable":
      return [spec.flag, "worker=codex/gpt-5.6-sol"];
  }
}

describe("flag registry", () => {
  it("registers exactly the flags of Design §4.2, in table order", () => {
    expect(FLAG_SPECS.map((spec) => spec.flag)).toEqual(DESIGN_FLAG_TABLE.map(([flag]) => flag));
  });

  it("scopes every flag to the commands the design assigns it", () => {
    for (const [flag, commands] of DESIGN_FLAG_TABLE) {
      const spec = FLAG_SPECS.find((candidate) => candidate.flag === flag);
      expect(spec, `missing spec for ${flag}`).toBeDefined();
      expect([...(spec?.commands ?? [])].sort(), flag).toEqual([...commands].sort());
    }
  });

  it("maps every flag to a distinct parsed key", () => {
    const keys = FLAG_SPECS.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("exposes the exit codes of Design §4.3", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      doctorDrift: 1,
      usage: 2,
      preflight: 3,
      consentMissing: 4,
      conflict: 5,
      noTtyNoApply: 6,
      pluginLoadFailed: 7,
    });
  });
});

describe("parseCommandLine — every registered flag", () => {
  for (const spec of FLAG_SPECS) {
    const allowed = spec.commands[0] as CommandName;

    it(`accepts ${spec.flag} on ${allowed} and records a value`, () => {
      const parsed = expectOk([allowed, ...sample(spec)]);
      const value = parsed.flags[spec.key];
      if (spec.kind === "boolean") {
        expect(value).toBe(true);
      } else if (spec.kind === "repeatable") {
        expect(value).toEqual(["worker=codex/gpt-5.6-sol"]);
      } else {
        expect(value).toBe("/tmp/x");
      }
    });

    const forbidden = COMMANDS.find((command) => !spec.commands.includes(command));
    if (forbidden !== undefined) {
      it(`rejects ${spec.flag} on ${forbidden}`, () => {
        const message = expectUsageError([forbidden, ...sample(spec)]);
        expect(message).toContain(spec.flag);
        expect(message).toContain("not valid");
      });
    }
  }

  it("defaults every unset flag to a falsy, empty value", () => {
    const parsed = expectOk(["doctor"]);
    expect(parsed.flags).toEqual({
      apply: false,
      yes: false,
      enablePlugins: false,
      installSkills: false,
      skillsAgents: undefined,
      role: [],
      reconfigure: false,
      skipSkillsCheck: false,
      force: false,
      askSkillsAgain: false,
      restoreBackups: false,
      prune: false,
      home: undefined,
      paseoHome: undefined,
      claudeHome: undefined,
      codexHome: undefined,
      json: false,
      verbose: false,
    });
  });
});

describe("parseCommandLine — commands", () => {
  it("routes an explicit command", () => {
    const parsed = expectOk(["uninstall", "--apply"]);
    expect(parsed.command).toBe("uninstall");
    expect(parsed.explicitCommand).toBe(true);
  });

  it("treats a bare invocation as the install wizard", () => {
    const parsed = expectOk([]);
    expect(parsed.command).toBe("install");
    expect(parsed.explicitCommand).toBe(false);
  });

  it("rejects an unknown command", () => {
    expect(expectUsageError(["nope"])).toContain('Unknown command "nope"');
  });

  it("rejects a second command", () => {
    expect(expectUsageError(["install", "doctor"])).toContain("Unexpected argument");
  });

  it("rejects an uninstall-only flag on the bare wizard", () => {
    expect(expectUsageError(["--restore-backups"])).toContain("--restore-backups");
  });
});

describe("parseCommandLine — flag syntax", () => {
  it("accepts both --flag value and --flag=value", () => {
    expect(expectOk(["install", "--skills-agents", "claude,codex"]).flags.skillsAgents).toBe("claude,codex");
    expect(expectOk(["install", "--skills-agents=claude"]).flags.skillsAgents).toBe("claude");
  });

  it("rejects an unknown flag", () => {
    expect(expectUsageError(["install", "--nope"])).toContain("Unknown flag --nope");
  });

  it("rejects a value given to a boolean flag", () => {
    expect(expectUsageError(["install", "--apply=true"])).toContain("does not take a value");
  });

  it("rejects a missing value instead of swallowing the next flag", () => {
    expect(expectUsageError(["install", "--home", "--json"])).toContain("--home requires a value");
    expect(expectUsageError(["install", "--home="])).toContain("non-empty");
  });

  it("passes a value that starts with a dash through the = form", () => {
    expect(expectOk(["install", "--home=-weird"]).flags.home).toBe("-weird");
  });

  it("collects --role repeatedly and does not validate its format here", () => {
    const parsed = expectOk(["install", "--role", "worker=codex/gpt-5.6-sol", "--role=reviewer=nonsense"]);
    expect(parsed.flags.role).toEqual(["worker=codex/gpt-5.6-sol", "reviewer=nonsense"]);
  });

  it("lets the last occurrence of a single-value flag win", () => {
    expect(expectOk(["install", "--home", "/a", "--home", "/b"]).flags.home).toBe("/b");
  });
});

describe("parseCommandLine — help and version", () => {
  it("reports --help without validating the rest of the line", () => {
    const parsed = expectOk(["--help"]);
    expect(parsed.help).toBe(true);
    expect(parsed.helpTopic).toBeUndefined();
    expect(expectOk(["--help", "--restore-backups"]).help).toBe(true);
  });

  it("carries the command as the help topic", () => {
    expect(expectOk(["uninstall", "--help"]).helpTopic).toBe("uninstall");
    expect(expectOk(["-h", "doctor"]).helpTopic).toBe("doctor");
  });

  it("reports --version, and prefers --help when both appear", () => {
    expect(expectOk(["--version"]).version).toBe(true);
    expect(expectOk(["-v"]).version).toBe(true);
    const both = expectOk(["--version", "--help"]);
    expect(both.help).toBe(true);
    expect(both.version).toBe(false);
  });
});

describe("homeFlagOverrides", () => {
  const flagsOf = (argv: readonly string[]) => {
    const result = parseCommandLine(argv);
    if (!result.ok) {
      throw new Error(`expected argv to parse: ${argv.join(" ")}`);
    }
    return result.parsed.flags;
  };

  const env = {
    PASEO_BM_HOME: "/env/bm",
    PASEO_HOME: "/env/paseo",
    CLAUDE_CONFIG_DIR: "/env/claude",
    CODEX_HOME: "/env/codex",
  };

  it("returns the flag values verbatim", () => {
    const flags = flagsOf(["install", "--home=/flag/bm", "--paseo-home=/flag/paseo"]);
    expect(homeFlagOverrides(flags)).toEqual({
      home: "/flag/bm",
      paseoHome: "/flag/paseo",
      claudeHome: undefined,
      codexHome: undefined,
    });
  });

  it("leaves every entry undefined when no flag was passed", () => {
    const flags = flagsOf(["install"]);
    expect(homeFlagOverrides(flags)).toEqual({
      home: undefined,
      paseoHome: undefined,
      claudeHome: undefined,
      codexHome: undefined,
    });
  });

  // Guards the single-source-of-truth split: this layer must NOT read the
  // environment. flag > env > daemon > default belongs to resolveLayout()
  // in src/layout.ts; two implementations of that precedence would drift.
  it("never consults the environment", () => {
    const flags = flagsOf(["install"]);
    const withEnvPresent = { ...process.env, ...env };
    const previous = process.env;
    try {
      process.env = withEnvPresent as NodeJS.ProcessEnv;
      expect(homeFlagOverrides(flags)).toEqual({
        home: undefined,
        paseoHome: undefined,
        claudeHome: undefined,
        codexHome: undefined,
      });
    } finally {
      process.env = previous;
    }
  });
});
