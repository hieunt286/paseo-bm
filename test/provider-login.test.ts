import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PaseoCliError } from "../src/paseo/adapter.js";
import type { PaseoInvocation } from "../src/paseo/adapter.js";
import { ScriptedPrompter } from "../src/prompter.js";
import type { RoleSelection } from "../src/roles/config.js";
import {
  PROVIDER_LOGIN_COMMANDS,
  checkProviderLogin,
  ensureProviderLogins,
  formatLoginCommand,
  loginChecks,
  parseProviderDiagnostic,
  runLoginCommand,
} from "../src/roles/login.js";
import type { LoginCommand, LoginSpawner } from "../src/roles/login.js";

/**
 * Provider login (bm-wp-106-7zj.2). Everything runs against in-memory Paseo
 * answers and the fake login binary in `test/fakes/login`; no real `claude`,
 * `codex` or `opencode` login is ever started, and no real credential or
 * `~/.paseo` is touched.
 */

const recorder = vi.hoisted(() => {
  const touches: { fn: string; path: string }[] = [];
  const toPath = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value instanceof URL) return decodeURIComponent(value.pathname);
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    return undefined;
  };
  const isClass = (value: { prototype?: object }): boolean =>
    value.prototype !== undefined && Object.getOwnPropertyNames(value.prototype).length > 1;
  const wrapModule = (actual: Record<string, unknown>): Record<string, unknown> => {
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(actual)) {
      if (name === "default" || name === "promises") continue;
      if (typeof value !== "function" || isClass(value as { prototype?: object })) {
        wrapped[name] = value;
        continue;
      }
      const original = value as (...args: unknown[]) => unknown;
      const wrapper = (...args: unknown[]): unknown => {
        const path = toPath(args[0]);
        if (path !== undefined) touches.push({ fn: name, path });
        return original(...args);
      };
      wrapped[name] = Object.assign(wrapper, original);
    }
    return wrapped;
  };
  return { touches, wrapModule };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const wrapped = recorder.wrapModule((await importOriginal()) as Record<string, unknown>);
  wrapped.default = wrapped;
  return wrapped;
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const wrapped = recorder.wrapModule(actual);
  wrapped.promises = recorder.wrapModule(actual.promises as Record<string, unknown>);
  wrapped.default = wrapped;
  return wrapped;
});

const FAKE_LOGIN = fileURLToPath(new URL("./fakes/login", import.meta.url));
const FAKE_TOKEN = "sk-ant-oat01-NEVER-LEAK-THIS-TOKEN";
const FAKE_EMAIL = "someone@example.invalid";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paseo-bm-login-"));
  recorder.touches.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A diagnostic shaped like Paseo 0.8.0's, with a secret a careless parser would keep. */
function diagnosticText(provider: string, loggedIn: boolean | undefined): string {
  const auth =
    loggedIn === undefined
      ? ""
      : `  Auth: {\n  "loggedIn": ${String(loggedIn)},\n  "email": "${FAKE_EMAIL}",\n  "accessToken": "${FAKE_TOKEN}"\n}\n`;
  return `${provider}\n  Binary: ${provider}\n${auth}  Models: 3\n  Status: Ready`;
}

/** In-memory `paseo`: answers `provider diagnostic <id>` from a per-call script. */
function fakeRunner(script: Record<string, (boolean | undefined | "fail")[]>) {
  const calls: string[][] = [];
  return {
    calls,
    run(args: readonly string[]): Promise<PaseoInvocation> {
      calls.push([...args]);
      const provider = args[2] ?? "";
      const answer = script[provider]?.shift();
      if (answer === "fail") {
        return Promise.reject(new PaseoCliError({ reason: "timeout", message: "no daemon", argv: args }));
      }
      const stdout = JSON.stringify({ provider, diagnostic: diagnosticText(provider, answer) });
      return Promise.resolve({ argv: [...args], exitCode: 0, stdout, stderr: "", durationMs: 1 });
    },
  };
}

function selection(role: RoleSelection["role"], provider: string): RoleSelection {
  return { role, displayName: role, provider, model: "m", paseoTools: role !== "reviewer", source: "flag" };
}

const ALL_CLAUDE = [selection("manager", "claude"), selection("worker", "claude"), selection("reviewer", "claude")];

/** A spawner that records instead of running, sharing one event log with print/confirm. */
function recordingSpawner(events: string[], exitCode = 0): LoginSpawner {
  return (command) => {
    events.push(`spawn ${JSON.stringify([command.executable, ...command.args])}`);
    return Promise.resolve(
      exitCode === 0
        ? { ok: true as const, exitCode: 0 as const }
        : { ok: false as const, reason: "exit-code" as const, exitCode, signal: null },
    );
  };
}

class RecordingPrompter extends ScriptedPrompter {
  constructor(
    private readonly events: string[],
    answers: boolean[],
    interactive = true,
  ) {
    super({ confirm: answers }, { interactive });
  }
  override confirm(question: Parameters<ScriptedPrompter["confirm"]>[0]): Promise<boolean> {
    this.events.push(`confirm ${question.message}`);
    return super.confirm(question);
  }
}

describe("reading the login state from Paseo", () => {
  it("keeps only the boolean and the status word, never the diagnostic text", () => {
    const out = parseProviderDiagnostic("claude", { provider: "claude", diagnostic: diagnosticText("claude", false) });
    expect(out).toEqual({ provider: "claude", state: "logged-out", paseoStatus: "Ready" });
    expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(out)).not.toContain(FAKE_EMAIL);
  });

  it("reports unknown, not logged-out, when Paseo says nothing about auth or cannot be reached", async () => {
    expect(parseProviderDiagnostic("codex", { diagnostic: diagnosticText("codex", undefined) }).state).toBe("unknown");
    expect(parseProviderDiagnostic("x", "garbage").state).toBe("unknown");
    expect((await checkProviderLogin(fakeRunner({ claude: ["fail"] }), "claude")).state).toBe("unknown");
  });

  it("asks Paseo with the documented argv", async () => {
    const runner = fakeRunner({ claude: [true] });
    await checkProviderLogin(runner, "claude");
    expect(runner.calls).toEqual([["provider", "diagnostic", "claude", "--json"]]);
  });
});

describe("AC: a provider that is not logged in yields W_PROVIDER_NOT_LOGGED_IN without blocking the install", () => {
  it("declined: warns, prints manual steps, runs nothing, and resolves", async () => {
    const events: string[] = [];
    const lines: string[] = [];
    const report = await ensureProviderLogins({
      selections: ALL_CLAUDE,
      runner: fakeRunner({ claude: [false] }),
      prompter: new RecordingPrompter(events, [false]),
      print: (line) => lines.push(line),
      spawnLogin: recordingSpawner(events),
    });

    expect(report.blocksInstall).toBe(false);
    expect(report.warnings.map((w) => w.code)).toEqual(["W_PROVIDER_NOT_LOGGED_IN"]);
    expect(report.warnings[0]?.roles).toEqual(["manager", "worker", "reviewer"]);
    expect(report.providers[0]).toMatchObject({ outcome: "declined", ran: false, command: "claude auth login" });
    expect(events.some((e) => e.startsWith("spawn"))).toBe(false);
    expect(lines).toContain("  claude auth login");
  });

  it("non-interactive: never asks, never runs, still warns", async () => {
    const events: string[] = [];
    const prompter = new RecordingPrompter(events, [], false);
    const report = await ensureProviderLogins({
      selections: [selection("worker", "codex")],
      runner: fakeRunner({ codex: [false] }),
      prompter,
      print: () => undefined,
      spawnLogin: recordingSpawner(events),
    });
    expect(report.providers[0]?.outcome).toBe("non-interactive");
    expect(report.warnings).toHaveLength(1);
    expect(prompter.counts.total).toBe(0);
    expect(events).toEqual([]);
  });

  it("failed login command and unknown provider tool both warn and resolve", async () => {
    const events: string[] = [];
    const report = await ensureProviderLogins({
      selections: [selection("worker", "claude"), selection("reviewer", "copilot")],
      runner: fakeRunner({ claude: [false], copilot: [false] }),
      prompter: new RecordingPrompter(events, [true]),
      print: () => undefined,
      spawnLogin: recordingSpawner(events, 1),
    });
    expect(report.blocksInstall).toBe(false);
    expect(report.providers.map((p) => p.outcome)).toEqual(["failed", "no-command"]);
    expect(report.warnings.map((w) => w.provider)).toEqual(["claude", "copilot"]);
    expect(report.warnings[0]?.message).toContain("exited with code 1");
  });

  it("consented and succeeded: re-checks Paseo and clears the warning", async () => {
    const events: string[] = [];
    const runner = fakeRunner({ claude: [false, true] });
    const report = await ensureProviderLogins({
      selections: ALL_CLAUDE,
      runner,
      prompter: new RecordingPrompter(events, [true]),
      print: () => undefined,
      spawnLogin: recordingSpawner(events),
    });
    expect(report.providers[0]).toMatchObject({ before: "logged-out", after: "logged-in", outcome: "logged-in" });
    expect(report.warnings).toEqual([]);
    expect(runner.calls).toHaveLength(2);
  });

  it("logged in or unknown: asks nothing and warns nothing", async () => {
    const events: string[] = [];
    const report = await ensureProviderLogins({
      selections: [selection("worker", "claude"), selection("reviewer", "codex")],
      runner: fakeRunner({ claude: [true], codex: [undefined] }),
      prompter: new RecordingPrompter(events, []),
      print: () => undefined,
      spawnLogin: recordingSpawner(events),
    });
    expect(report.providers.map((p) => p.outcome)).toEqual(["already-logged-in", "unknown"]);
    expect(report.warnings).toEqual([]);
    expect(events).toEqual([]);
  });

  it("doctor checks: logged-out is a warning, never an error", () => {
    const checks = loginChecks([
      { provider: "claude", state: "logged-out", paseoStatus: "Ready" },
      { provider: "codex", state: "unknown", paseoStatus: "Ready" },
    ]);
    expect(checks.map((c) => c.severity)).toEqual(["warn", "ok"]);
    expect(checks[0]?.remediation).toContain("claude auth login");
  });
});

describe("AC: the login command is printed verbatim before it runs", () => {
  it("prints the exact command, then asks, then spawns exactly that argv", async () => {
    const events: string[] = [];
    await ensureProviderLogins({
      selections: [selection("worker", "codex")],
      runner: fakeRunner({ codex: [false, true] }),
      prompter: new RecordingPrompter(events, [true]),
      print: (line) => events.push(`print ${line}`),
      spawnLogin: recordingSpawner(events),
    });

    const printed = events.indexOf("print   codex login");
    const asked = events.findIndex((e) => e.startsWith("confirm "));
    const spawned = events.indexOf(`spawn ${JSON.stringify(["codex", "login"])}`);
    expect(printed).toBeGreaterThanOrEqual(0);
    expect(asked).toBeGreaterThan(printed);
    expect(spawned).toBeGreaterThan(asked);
    expect(events[spawned - 1]).toBe("print Running: codex login");
  });

  it("the printed form of every known command is exactly its argv joined by spaces", () => {
    for (const command of Object.values(PROVIDER_LOGIN_COMMANDS)) {
      expect(formatLoginCommand(command)).toBe([command.executable, ...command.args].join(" "));
    }
    expect(formatLoginCommand({ executable: "x", args: ["a b", "it's"] })).toBe(`x 'a b' 'it'\\''s'`);
  });
});

describe("the real runner: argv array, no command interpreter, inherited stdio", () => {
  it("passes a hostile argument as one element and never evaluates it", async () => {
    const argvLog = join(dir, "argv.log");
    const sentinel = join(dir, "injected-semicolon");
    const substitution = join(dir, "injected-substitution");
    const hostile = `x; touch ${sentinel}; echo $(touch ${substitution})`;

    const result = await runLoginCommand(
      { executable: FAKE_LOGIN, args: ["login", hostile] },
      { env: { PATH: process.env["PATH"], BM_FAKE_LOGIN_ARGV_LOG: argvLog }, timeoutMs: 10_000 },
    );

    expect(result).toEqual({ ok: true, exitCode: 0 });
    const calls = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[] });
    expect(calls).toEqual([{ argv: ["login", hostile], argc: 2 }]);
    expect(existsSync(sentinel), "a `;` in an argument started a second command").toBe(false);
    expect(existsSync(substitution), "a `$(...)` was evaluated").toBe(false);
  });

  it("reports a non-zero exit, a missing binary and a timeout as results, never as throws", async () => {
    const env = { PATH: process.env["PATH"] };
    expect(await runLoginCommand({ executable: FAKE_LOGIN, args: [] }, { env: { ...env, BM_FAKE_LOGIN_EXIT: "3" } }))
      .toMatchObject({ ok: false, reason: "exit-code", exitCode: 3 });
    expect(await runLoginCommand({ executable: join(dir, "no-such-tool"), args: [] }, { env }))
      .toMatchObject({ ok: false, reason: "not-found" });
    expect(
      await runLoginCommand(
        { executable: FAKE_LOGIN, args: [] },
        { env: { ...env, BM_FAKE_LOGIN_MODE: "hang" }, timeoutMs: 300, killGraceMs: 200 },
      ),
    ).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("uses stdio inherit and no shell (source check on the one spawn call)", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/roles/login.ts", import.meta.url)), "utf8");
    expect(source.match(/spawn\(/g)).toHaveLength(1);
    expect(source).toContain('stdio: "inherit"');
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/(?<![.\w])exec(Sync)?\(|execFile|spawnSync|shell:\s*true/);
    expect(source).not.toMatch(/from "node:fs/);
  });
});

describe("AC: no code path reads a credential file", () => {
  const CREDENTIAL_NAMES = new Set(["auth.json", ".credentials.json", "credentials.json", ".claude.json", ".netrc"]);

  function plantDecoys(home: string): void {
    mkdirSync(join(home, ".paseo"), { recursive: true });
    writeFileSync(join(home, ".paseo", "auth.json"), `{"token":"${FAKE_TOKEN}"}`);
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), `{"accessToken":"${FAKE_TOKEN}"}`);
    writeFileSync(join(home, ".claude.json"), `{"oauthAccount":"${FAKE_EMAIL}"}`);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"${FAKE_TOKEN}"}`);
    mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "opencode", "auth.json"), `{"anthropic":"${FAKE_TOKEN}"}`);
  }

  /** Every outcome, with the REAL runner starting the fake binary for the login. */
  async function runEveryPath(home: string): Promise<{ lines: string[]; report: unknown[] }> {
    const realSpawnOfFake: LoginSpawner = (command: LoginCommand, options) =>
      runLoginCommand({ executable: FAKE_LOGIN, args: command.args }, options);
    const loginOptions = { env: { PATH: process.env["PATH"], HOME: home }, cwd: home, timeoutMs: 10_000 };
    const lines: string[] = [];
    const reports: unknown[] = [];
    const scenarios: [RoleSelection[], Record<string, (boolean | undefined | "fail")[]>, boolean[], boolean][] = [
      [ALL_CLAUDE, { claude: [false, true] }, [true], true],
      [[selection("worker", "codex")], { codex: [false] }, [false], true],
      [[selection("worker", "opencode")], { opencode: [false] }, [], false],
      [[selection("worker", "copilot")], { copilot: [false] }, [], true],
      [[selection("worker", "claude"), selection("reviewer", "codex")], { claude: [true], codex: ["fail"] }, [], true],
    ];
    for (const [selections, script, answers, interactive] of scenarios) {
      reports.push(
        await ensureProviderLogins({
          selections,
          runner: fakeRunner(script),
          prompter: new ScriptedPrompter({ confirm: answers }, { interactive }),
          print: (line) => lines.push(line),
          spawnLogin: realSpawnOfFake,
          loginOptions,
        }),
      );
    }
    return { lines, report: reports };
  }

  it("performs no filesystem access at all, so no credential file is read", async () => {
    const home = join(dir, "home");
    plantDecoys(home);
    recorder.touches.length = 0;

    const { lines, report } = await runEveryPath(home);
    const during = [...recorder.touches];

    expect(during).toEqual([]);
    expect(during.filter((t) => t.path.split(sep).some((s) => CREDENTIAL_NAMES.has(s)))).toEqual([]);
    // Nothing secret made it into anything paseo-bm printed or returned.
    const everything = JSON.stringify({ lines, report });
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain(FAKE_EMAIL);
  });

  it("the recorder does catch a credential read, so the check above is not vacuous", async () => {
    const home = join(dir, "home");
    plantDecoys(home);
    recorder.touches.length = 0;

    await runEveryPath(home);
    const { readFile } = await import("node:fs/promises");
    await readFile(join(home, ".codex", "auth.json"), "utf8");

    expect(recorder.touches).toEqual([{ fn: "readFile", path: join(home, ".codex", "auth.json") }]);
  });
});
