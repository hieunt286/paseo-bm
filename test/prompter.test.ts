import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  NonInteractivePrompter,
  PromptUnavailableError,
  ReadlinePrompter,
  ScriptExhaustedError,
  ScriptedPrompter,
  createPrompter,
  detectTty,
} from "../src/prompter.js";

describe("detectTty", () => {
  it("reports an interactive session only when both ends are a terminal", () => {
    expect(detectTty({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toEqual({
      stdin: true,
      stdout: true,
      interactive: true,
    });
    expect(detectTty({ stdin: { isTTY: true }, stdout: { isTTY: false } }).interactive).toBe(false);
    expect(detectTty({ stdin: { isTTY: false }, stdout: { isTTY: true } }).interactive).toBe(false);
  });

  it("treats a missing or undefined isTTY as not a terminal", () => {
    expect(detectTty({}).interactive).toBe(false);
    expect(detectTty({ stdin: {}, stdout: {} }).interactive).toBe(false);
  });
});

describe("ScriptedPrompter", () => {
  it("answers from the script and counts every call by kind", async () => {
    const prompter = new ScriptedPrompter({
      confirm: [true, false, true],
      input: ["Beads Worker"],
      select: ["codex"],
    });

    await prompter.confirm({ message: "Apply these changes?" });
    await prompter.confirm({ message: "Enable plugins and grant agent tool access?" });
    await prompter.confirm({ message: "Install the recommended skills?" });
    await prompter.input({ message: "Worker name" });
    await prompter.select({
      message: "Provider for Worker",
      choices: [
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex" },
      ],
    });

    expect(prompter.counts).toEqual({ confirm: 3, input: 1, select: 1, total: 5 });
    expect(prompter.confirmMessages).toEqual([
      "Apply these changes?",
      "Enable plugins and grant agent tool access?",
      "Install the recommended skills?",
    ]);
    expect(prompter.asked[1]?.answer).toBe(false);
  });

  it("records the details shown with a question", async () => {
    const prompter = new ScriptedPrompter({ confirm: [true] });
    await prompter.confirm({ message: "Enable?", details: ["Plugins run unsandboxed.", "Every agent gains tools."] });
    expect(prompter.asked[0]?.details).toEqual(["Plugins run unsandboxed.", "Every agent gains tools."]);
  });

  it("throws when a run asks more questions than the script answers, and still counts the attempt", () => {
    const prompter = new ScriptedPrompter({ confirm: [true] });
    expect(() => prompter.confirm({ message: "first" })).not.toThrow();
    expect(() => prompter.confirm({ message: "one too many" })).toThrow(ScriptExhaustedError);
    expect(prompter.counts.confirm).toBe(2);
  });

  it("matches a select answer by value, by label, then by index", async () => {
    const choices = [
      { value: "claude", label: "Claude Code" },
      { value: "codex", label: "Codex" },
    ];
    const prompter = new ScriptedPrompter({ select: ["codex", "Claude Code", 1] });
    expect(await prompter.select({ message: "a", choices })).toBe("codex");
    expect(await prompter.select({ message: "b", choices })).toBe("claude");
    expect(await prompter.select({ message: "c", choices })).toBe("codex");
  });

  it("falls back to the declared default when the script is silent", async () => {
    const prompter = new ScriptedPrompter({});
    expect(await prompter.input({ message: "Worker name", defaultValue: "Beads Worker" })).toBe("Beads Worker");
    expect(
      await prompter.select({
        message: "Provider",
        choices: [{ value: "claude", label: "Claude Code" }],
        defaultValue: "claude",
      }),
    ).toBe("claude");
    expect(prompter.counts.total).toBe(2);
  });

  it("records that it was closed", async () => {
    const prompter = new ScriptedPrompter();
    expect(prompter.isClosed).toBe(false);
    await prompter.close();
    expect(prompter.isClosed).toBe(true);
  });
});

describe("NonInteractivePrompter", () => {
  it("refuses instead of blocking, and says how to proceed", () => {
    const prompter = new NonInteractivePrompter();
    expect(prompter.interactive).toBe(false);
    expect(() => prompter.confirm({ message: "Apply?" })).toThrow(PromptUnavailableError);
    expect(() => prompter.input({ message: "Name" })).toThrow(/not interactive/);
    expect(() => prompter.select({ message: "Provider", choices: [] })).toThrow(PromptUnavailableError);
  });
});

describe("createPrompter", () => {
  it("picks the readline prompter only for an interactive session", () => {
    expect(createPrompter({ stdin: true, stdout: true, interactive: true })).toBeInstanceOf(ReadlinePrompter);
    expect(createPrompter({ stdin: false, stdout: false, interactive: false })).toBeInstanceOf(
      NonInteractivePrompter,
    );
  });
});

describe("ReadlinePrompter", () => {
  function fakeStreams(): { input: PassThrough; output: PassThrough; written: () => string } {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer | string) => {
      text += String(chunk);
    });
    return { input, output, written: () => text };
  }

  it("reads a confirmation, and uses the default on an empty answer", async () => {
    const { input, output, written } = fakeStreams();
    const prompter = new ReadlinePrompter({ input, output });

    const yes = prompter.confirm({ message: "Apply these changes?", details: ["3 actions"] });
    input.write("y\n");
    expect(await yes).toBe(true);

    const fallback = prompter.confirm({ message: "Apply these changes?", defaultValue: false });
    input.write("\n");
    expect(await fallback).toBe(false);

    await prompter.close();
    expect(written()).toContain("3 actions");
    expect(written()).toContain("[y/N]");
  });

  it("reads a numbered selection", async () => {
    const { input, output } = fakeStreams();
    const prompter = new ReadlinePrompter({ input, output });
    const answer = prompter.select({
      message: "Provider for Worker",
      choices: [
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex", hint: "gpt-5.6-sol" },
      ],
    });
    input.write("2\n");
    expect(await answer).toBe("codex");
    await prompter.close();
  });

  it("returns the default for an empty text answer", async () => {
    const { input, output } = fakeStreams();
    const prompter = new ReadlinePrompter({ input, output });
    const answer = prompter.input({ message: "Worker name", defaultValue: "Beads Worker" });
    input.write("\n");
    expect(await answer).toBe("Beads Worker");
    await prompter.close();
  });
});
