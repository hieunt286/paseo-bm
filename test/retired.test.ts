import { describe, expect, it } from "vitest";
import { runCli, type CommandHandlers } from "../src/cli.js";
import type { TtyInfo } from "../src/prompter.js";
import { DIAGNOSTICS } from "../src/errors.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { RETIRED_COMMANDS, RETIRED_FLAGS, retiredFlagIn, retirementMessage } from "../src/retired.js";

/**
 * WP-406: what the `paseo-bm` command used to do, and where each job went.
 *
 * 0.4.0 is the command's last version and only migrates (ADR-012 decision 7).
 * A retired command must still explain itself (REQ-070 f): someone typing
 * `paseo-bm doctor` has a question, and "unknown command" is not an answer.
 */

const NO_TTY: TtyInfo = { stdin: false, stdout: false, interactive: false };

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const seen: string[] = [];
  const handler = (name: string) => () => {
    seen.push(name);
    return EXIT_CODES.ok;
  };
  const handlers = {
    migrate: handler("migrate"),
    install: handler("install"),
    doctor: handler("doctor"),
    uninstall: handler("uninstall"),
  } as CommandHandlers;
  return {
    handlers,
    seen,
    stdout: (text: string) => void out.push(text),
    stderr: (text: string) => void err.push(text),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const run = (argv: string[]) => {
  const h = harness();
  return runCli(argv, { handlers: h.handlers, stdout: h.stdout, stderr: h.stderr, env: {}, tty: NO_TTY, version: "0.4.0" }).then(
    (code) => ({ code, err: h.err(), out: h.out(), seen: h.seen }),
  );
};

describe("retired commands", () => {
  it.each(Object.keys(RETIRED_COMMANDS))("answers `%s` with exit 2 and E_COMMAND_RETIRED", async (command) => {
    const result = await run([command]);

    expect(result.code).toBe(EXIT_CODES.usage);
    expect(result.seen).toEqual([]);
    expect(result.err).toContain("E_COMMAND_RETIRED");
    expect(result.err).toContain(`\`paseo-bm ${command}\` was retired in paseo-bm 0.4.0.`);
  });

  it("sends `doctor` to Setup, and to Paseo's own commands when the plugin does not load", async () => {
    const result = await run(["doctor"]);

    expect(result.err).toContain("Beads Manager → Setup");
    expect(result.err).toContain("paseo plugin logs paseo-bm");
  });

  it("sends `uninstall` to the button first, then `paseo plugin remove`", async () => {
    const result = await run(["uninstall"]);

    expect(result.err).toContain('"Remove paseo-bm\'s settings"');
    expect(result.err).toContain("paseo plugin remove paseo-bm");
  });

  it("does not retire `install`: it is what migrates", async () => {
    const result = await run(["install"]);

    expect(result.code).toBe(EXIT_CODES.ok);
    expect(result.seen).toEqual(["install"]);
  });
});

describe("retired flags", () => {
  it.each(Object.keys(RETIRED_FLAGS))("answers `%s` with exit 2 and names its replacement", async (flag) => {
    const result = await run(["install", flag, "value"]);

    expect(result.code).toBe(EXIT_CODES.usage);
    expect(result.seen).toEqual([]);
    expect(result.err).toContain("E_COMMAND_RETIRED");
    expect(result.err).toContain(`\`${flag}\` was retired`);
    expect(result.err).toContain(RETIRED_FLAGS[flag]!);
  });

  it("recognises a flag written with =", () => {
    expect(retiredFlagIn(["install", "--role=worker=codex/gpt-5"])?.name).toBe("`--role`");
  });

  it("leaves the flags 0.4.0 still takes alone", () => {
    for (const kept of ["--apply", "--yes", "--home", "--paseo-home", "--json", "--verbose", "--help", "--version"]) {
      expect(retiredFlagIn(["install", kept])).toBeUndefined();
    }
  });

  it("stops at `--`, so a value that looks like a flag is not one", () => {
    expect(retiredFlagIn(["install", "--", "--force"])).toBeUndefined();
  });
});

describe("the retirement message", () => {
  it("says what was retired, when, and where the job went", () => {
    expect(retirementMessage({ name: "`x`", replacement: "Do y instead." })).toBe(
      "`x` was retired in paseo-bm 0.4.0. Do y instead.",
    );
  });

  it("is a registered diagnostic, so it is greppable in a transcript", () => {
    expect(DIAGNOSTICS.E_COMMAND_RETIRED.code).toBe("E_COMMAND_RETIRED");
    expect(DIAGNOSTICS.E_COMMAND_RETIRED.remediation).toContain("Beads Manager → Setup");
  });
});

describe("exit codes 1 and 4", () => {
  it("are never produced by a retirement", async () => {
    const codes = await Promise.all([...Object.keys(RETIRED_COMMANDS), "--force", "--role"].map((argument) => run([argument])));

    expect(codes.map((result) => result.code)).toEqual(codes.map(() => EXIT_CODES.usage));
    expect(codes.some((result) => result.code === EXIT_CODES.doctorDrift || result.code === EXIT_CODES.consentMissing)).toBe(false);
  });
});
