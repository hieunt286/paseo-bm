import { describe, expect, it, vi } from "vitest";
import {
  BEADS_TOOL_SCRIPTS,
  beadsToolsPreviewLines,
  createBeadsToolsStep,
  missingBeadsTools,
  planBeadsTools,
} from "../src/beads-tools.js";
import type { CommandContext } from "../src/cli.js";
import { parseCommandLine } from "../src/flags.js";
import type { FsProbe } from "../src/preflight.js";
import type { SkillsRunner } from "../src/skills/assist.js";
import { commandsFor } from "../plugin/server/setup-tools.js";

/**
 * `install` installs missing br / bv (delta 20260916-setup-screen, owner
 * decision 2026-09-16). Every runner here is fake: nothing is downloaded.
 */

function probe(files: Set<string>): FsProbe {
  return {
    exists: (path) => files.has(path),
    isDirectory: () => true,
    isWritableDirectory: () => true,
    isExecutableFile: (path) => files.has(path),
  };
}

function context(argv: string[], out: string[] = []): CommandContext {
  const parsed = parseCommandLine(["install", ...argv]);
  if (!parsed.ok) throw new Error("bad argv");
  return {
    flags: parsed.parsed.flags,
    env: { PATH: "/bin:/opt/homebrew/bin", HOME: "/home/u" },
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => out.push(text),
  } as unknown as CommandContext;
}

const timers = { setTimeout: () => 0, clearTimeout: () => {} };
const signals = { on: () => undefined, off: () => undefined };

describe("choosing what to run", () => {
  it("looks for br and bv themselves", () => {
    const env = { PATH: "/bin" };
    expect(missingBeadsTools(env, probe(new Set(["/bin/bd"])))).toEqual(["br", "bv"]);
    expect(missingBeadsTools(env, probe(new Set(["/bin/br", "/bin/bv"])))).toEqual([]);
  });

  it("uses Homebrew when it is there, the documented scripts otherwise", () => {
    const env = { PATH: "/bin:/opt/homebrew/bin" };
    expect(planBeadsTools(["br"], env, probe(new Set(["/opt/homebrew/bin/brew"])))).toEqual([
      {
        tool: "br",
        command: { executable: "/opt/homebrew/bin/brew", args: ["install", "dicklesworthstone/tap/br"] },
        text: "brew install dicklesworthstone/tap/br",
      },
    ]);
    const [br, bv] = planBeadsTools(["br", "bv"], env, probe(new Set()));
    expect(br).toEqual({ tool: "br", command: { executable: "/bin/bash", args: ["-c", BEADS_TOOL_SCRIPTS.br] }, text: BEADS_TOOL_SCRIPTS.br });
    expect(br!.text).toContain("--skip-skills");
    expect(bv!.text).toContain("/a43b8e85a39664381566abdfd85dc8fcbfdcb773/install.sh");
    expect(beadsToolsPreviewLines([br!, bv!])[0]).toBe("Missing beads tools (br, bv) will be installed when you apply these changes:");
    expect(beadsToolsPreviewLines([])).toEqual([]);
  });
});

describe("the step", () => {
  it("only prints the commands in a preview", async () => {
    const runner = vi.fn<SkillsRunner>();
    const step = createBeadsToolsStep({ runner, fs: probe(new Set()) });
    const outcome = await step({ context: context([]), interactive: true, apply: false });
    expect(runner).not.toHaveBeenCalled();
    expect(outcome.notes[0]).toBe("To install the missing beads tools yourself, run:");
  });

  it("runs nothing without a terminal unless --install-beads-tools is given", async () => {
    const runner = vi.fn<SkillsRunner>();
    const step = createBeadsToolsStep({ runner, fs: probe(new Set()) });
    const outcome = await step({ context: context(["--apply"]), interactive: false, apply: true });
    expect(runner).not.toHaveBeenCalled();
    expect(outcome.notes).toContain("Without a terminal, pass --install-beads-tools to let paseo-bm install them.");
  });

  it("installs on a terminal, and clears the preflight warning of each tool it installed", async () => {
    const files = new Set(["/opt/homebrew/bin/brew"]);
    const runner = vi.fn<SkillsRunner>(async (command) => {
      files.add(`/opt/homebrew/bin/${command.args[1]!.split("/").at(-1)}`);
      return { outcome: "ok", exitCode: 0 };
    });
    const out: string[] = [];
    const step = createBeadsToolsStep({ runner, fs: probe(files), timers, signals, homedir: () => "/home/u" });
    const outcome = await step({ context: context([], out), interactive: true, apply: true });
    expect(runner.mock.calls.map((call) => call[0].args)).toEqual([
      ["install", "dicklesworthstone/tap/br"],
      ["install", "dicklesworthstone/tap/bv"],
    ]);
    expect(outcome.resolvedWarnings).toEqual(["W_BEADS_CLI_MISSING", "W_BEADS_VIEWER_MISSING"]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.notes).toEqual(["Installed br at /opt/homebrew/bin/br.", "Installed bv at /opt/homebrew/bin/bv."]);
    expect(out.join("")).toContain("Installing br: brew install dicklesworthstone/tap/br");
  });

  it("with the flag, without a terminal; a script install into ~/.local/bin says to add it to PATH", async () => {
    const files = new Set<string>();
    const runner = vi.fn<SkillsRunner>(async () => {
      files.add("/home/u/.local/bin/br");
      files.add("/home/u/.local/bin/bv");
      return { outcome: "ok", exitCode: 0 };
    });
    const step = createBeadsToolsStep({ runner, fs: probe(files), timers, signals, homedir: () => "/home/u" });
    const outcome = await step({ context: context(["--apply", "--install-beads-tools"]), interactive: false, apply: true });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0]![0]).toEqual({ executable: "/bin/bash", args: ["-c", BEADS_TOOL_SCRIPTS.br] });
    expect(outcome.notes).toContain("/home/u/.local/bin is not on your PATH yet; add it so agents can run br.");
    expect(outcome.resolvedWarnings).toHaveLength(2);
  });

  it("turns a failed or ineffective install into a warning and the manual command", async () => {
    const runner = vi
      .fn<SkillsRunner>()
      .mockResolvedValueOnce({ outcome: "failed", reason: "exit-code", exitCode: 22, signal: null })
      .mockResolvedValueOnce({ outcome: "ok", exitCode: 0 });
    const step = createBeadsToolsStep({ runner, fs: probe(new Set()), timers, signals, homedir: () => "/home/u" });
    const outcome = await step({ context: context([]), interactive: true, apply: true });
    expect(outcome.resolvedWarnings).toEqual([]);
    expect(outcome.warnings.map((warning) => warning.code)).toEqual(["W_BEADS_TOOLS_INSTALL_FAILED", "W_BEADS_TOOLS_INSTALL_FAILED"]);
    expect(outcome.warnings[0]!.detail).toContain("exited with code 22");
    expect(outcome.warnings[1]!.detail).toContain("still not on PATH");
  });

  it("does nothing when both tools are there", async () => {
    const runner = vi.fn<SkillsRunner>();
    const step = createBeadsToolsStep({ runner, fs: probe(new Set(["/bin/br", "/bin/bv"])) });
    expect(await step({ context: context([]), interactive: true, apply: true })).toEqual({ warnings: [], notes: [], resolvedWarnings: [] });
  });
});

describe("the plugin's Setup screen", () => {
  it("offers exactly the commands the CLI runs (src/ and plugin/ cannot share code)", () => {
    for (const tool of ["br", "bv"] as const) {
      expect(commandsFor(tool, null).install).toBe(BEADS_TOOL_SCRIPTS[tool]);
      expect(commandsFor(tool, "/opt/homebrew/bin/brew").install).toBe(
        planBeadsTools([tool], { PATH: "/opt/homebrew/bin" }, probe(new Set(["/opt/homebrew/bin/brew"])))[0]!.text,
      );
    }
  });
});

describe("the flag", () => {
  it("parses for install only", () => {
    const parsed = parseCommandLine(["install", "--install-beads-tools"]);
    expect(parsed.ok && parsed.parsed.flags.installBeadsTools).toBe(true);
    expect(parseCommandLine(["doctor", "--install-beads-tools"]).ok).toBe(false);
  });
});
