/**
 * Running the skills CLI after consent (bead bm-wp-110-rkw.3) — Primary Proof
 * `npm test -- skills-assist`.
 *
 * Every scenario runs the real install handler through `runCli` on a fake
 * `$HOME`, with the fake `paseo` and a fake `npx` (test/fakes/skills-cli/) on
 * PATH. The real `npx` is never reachable: the fake directory comes first and
 * the argv log proves the fake is what ran. Timers are compressed (the step
 * still asks for 300 000 ms and 60 000 ms; the test waits a fraction of that),
 * and SIGINT is delivered through an injected emitter, never to the test
 * process. The write-scope guard is on for every run.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanReport } from "../src/action.js";
import { runCli } from "../src/cli.js";
import type { CommandHandlers } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { ProcessHooks } from "../src/lock.js";
import type { PaseoAdapter, PluginSummary } from "../src/paseo/adapter.js";
import { createPaseoAdapter } from "../src/paseo/adapter.js";
import { ScriptedPrompter } from "../src/prompter.js";
import type { TtyInfo } from "../src/prompter.js";
import { parseRecord } from "../src/record.js";
import { TRUST_QUESTION, createTrustBoundaryStep } from "../src/commands/install/enable.js";
import { APPLY_QUESTION, createInstallCommand } from "../src/commands/install/index.js";
import { createRolesStep } from "../src/commands/install/roles-step.js";
import { REQUIRED_SKILLS } from "../src/skills/detect.js";
import type { SignalSource, SkillsTimers } from "../src/skills/assist.js";
import { SKILLS_QUESTION, SKILLS_SILENCE_WARNING_MS, SKILLS_SOURCE, SKILLS_TIMEOUT_MS, createSkillsAssistStep, formatSkillsCommand, skillsAddCommand, toSkillsCliAgents } from "../src/skills/assist.js";
import type { WriteScopeHarness } from "./helpers/write-scope.js";
import { startWriteScope } from "./helpers/write-scope.js";

const FAKE_DIR = fileURLToPath(new URL("./fakes/", import.meta.url));
const FAKE_NPX_DIR = fileURLToPath(new URL("./fakes/skills-cli/", import.meta.url));
const VERSION = "0.2.0";
const TTY: TtyInfo = { stdin: true, stdout: true, interactive: true };
const NO_TTY: TtyInfo = { stdin: false, stdout: false, interactive: false };
const ROLE_FLAGS = ["manager", "worker", "reviewer"].map((role) => `--role=${role}=claude/claude-opus-5`);
const EXPECTED_ARGV = ["-y", "skills", "add", "cuongntr/agent-skills", "-g", "-a", "claude-code", "codex", "-s", ...REQUIRED_SKILLS, "-y"];

let home: string;
let outside: string;
let installHome: string;
let paseoHome: string;
let payloadRoot: string;
let paseoLog: string;
let scriptFile: string;
let npxLog: string;
let npxPid: string;
let npxSignals: string;
let scope: WriteScopeHarness | undefined;

function writePaseoConfig(config: Record<string, unknown>): void {
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-skills-assist-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-skills-assist-log-")));
  installHome = join(home, ".paseo-bm");
  paseoHome = join(home, ".paseo");
  payloadRoot = join(outside, "package", "plugin");
  paseoLog = join(outside, "paseo-argv.log");
  scriptFile = join(outside, "script.json");
  npxLog = join(outside, "npx-argv.log");
  npxPid = join(outside, "npx.pid");
  npxSignals = join(outside, "npx-signals.log");

  for (const [path, text] of Object.entries({
    "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
    "index.server.ts": `export const version = "${VERSION}";\n`,
  })) {
    mkdirSync(dirname(join(payloadRoot, path)), { recursive: true });
    writeFileSync(join(payloadRoot, path), text);
  }
  writePaseoConfig({ pluginsEnabled: true, daemon: { mcp: { injectIntoAgents: true } } });
  writeFileSync(
    scriptFile,
    JSON.stringify({
      "daemon status": { stdout: JSON.stringify({ home: paseoHome, cliVersion: "0.8.0", daemonVersion: "0.8.0" }) },
      "daemon reload": { stdout: JSON.stringify({ appliedPaths: ["pluginsEnabled"] }) },
      "plugin ls": { stdout: "[]" },
      "plugin install": {
        stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }),
      },
      // For the roles step (bm-wp-107-2r5.4), shaped as in test/install-roles.test.ts.
      "provider ls": { stdout: JSON.stringify([{ provider: "claude", label: "Claude", status: "available" }]) },
      "provider models": { stdout: JSON.stringify([{ id: "claude-opus-5", model: "Opus 5" }]) },
      "provider diagnostic": { stdout: JSON.stringify({ provider: "claude", diagnostic: 'Status: Ready\nAuth: {"loggedIn": true}' }) },
    }),
  );
  // Claude Code is "installed" with an empty skills directory: all five are missing.
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
});

afterEach(() => {
  scope?.restore();
  scope = undefined;
  if (existsSync(npxPid)) {
    try {
      process.kill(Number(readFileSync(npxPid, "utf8")), "SIGKILL");
    } catch {
      // Already gone, which is the expected state.
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Timers that record the delay asked for and wait `ms / factor` for real. */
function compressedTimers(factor: number): { timers: SkillsTimers; requested: number[] } {
  const requested: number[] = [];
  return {
    requested,
    timers: {
      setTimeout: (callback, ms) => {
        requested.push(ms);
        return setTimeout(callback, Math.max(1, Math.round(ms / factor)));
      },
      clearTimeout: (handle) => {
        clearTimeout(handle as NodeJS.Timeout);
      },
    },
  };
}

interface RunOptions {
  tty?: TtyInfo;
  confirm?: boolean[];
  npxMode?: "ok" | "fail" | "hang" | "hang-quiet";
  /** Where the fake CLI "installs" skills, standing in for the real CLI. */
  npxInstallInto?: string;
  factor?: number;
  signals?: EventEmitter;
  /** Lock hooks sharing the signal emitter, so the lock's own SIGINT handler is exercised. */
  lockHooks?: ProcessHooks;
  onStarted?: () => void;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  prompter: ScriptedPrompter;
  requested: number[];
}

async function install(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const tty = options.tty ?? NO_TTY;
  const prompter = new ScriptedPrompter({ confirm: options.confirm ?? [] }, { interactive: tty.interactive });
  const env: Record<string, string> = {
    PATH: `${FAKE_NPX_DIR}:${FAKE_DIR}:${process.env["PATH"] ?? ""}`,
    BM_FAKE_ARGV_LOG: paseoLog,
    BM_FAKE_SCRIPT: scriptFile,
    BM_FAKE_NPX_ARGV_LOG: npxLog,
    BM_FAKE_NPX_PID_FILE: npxPid,
    BM_FAKE_NPX_SIGNAL_LOG: npxSignals,
    BM_FAKE_NPX_MODE: options.npxMode ?? "ok",
    ...(options.npxInstallInto === undefined ? {} : { BM_FAKE_NPX_INSTALL: options.npxInstallInto }),
  };

  // After a reload the plugin reports running, as in test/consent-enable.test.ts.
  const real = createPaseoAdapter({ env });
  let reloaded = false;
  const adapter: PaseoAdapter = {
    ...real,
    daemonReload: async () => {
      const result = await real.daemonReload();
      reloaded = true;
      return result;
    },
    pluginList: async () => {
      if (!reloaded) return real.pluginList();
      const plugin: PluginSummary = { id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running", raw: {} };
      return [plugin];
    },
  };
  let clockMs = 0;
  const trustBoundary = createTrustBoundaryStep({
    clock: () => clockMs,
    sleep: (ms) => {
      clockMs += ms;
      return Promise.resolve();
    },
  });

  // 1/100: the 300-second deadline is 3 real seconds, far above a node start-up
  // under load, so only the scenario that wants the deadline ever reaches it.
  const { timers, requested } = compressedTimers(options.factor ?? 100);
  const skills = createSkillsAssistStep({
    timers,
    signals: (options.signals ?? new EventEmitter()) as unknown as SignalSource,
  });

  // The roles step never runs a real login here, and `--role` for all three
  // roles keeps its configuration questions out of the confirmation count.
  const roles = createRolesStep({ spawnLogin: () => Promise.resolve({ ok: true, exitCode: 0 }) });

  scope = startWriteScope({ installHome, paseoHome, watch: [home], mode: "record" });
  const handler = createInstallCommand({
    homeDir: home,
    payloadRoot,
    adapter,
    fs: scope.fs,
    lock: options.lockHooks === undefined ? { handleSignals: false } : { hooks: options.lockHooks },
    steps: { trustBoundary, skills, roles },
  });
  argv = [...argv, ...ROLE_FLAGS];
  const handlers: CommandHandlers = { install: handler, doctor: () => EXIT_CODES.usage, uninstall: () => EXIT_CODES.usage };
  let out = "";
  let err = "";
  const code = await runCli(argv, {
    handlers,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    tty,
    createPrompter: () => prompter,
    version: VERSION,
  });

  // Guard: paseo-bm itself wrote only into the install home and config.json —
  // zero writes under any agent's skills directory.
  const tempFile = new RegExp(`^${paseoHome}/\\.config\\.json\\.\\d+\\.[0-9a-f]+\\.tmp$`);
  const paths = scope.paths();
  expect(paths.filter((path) => /\/\.(claude|codex|agents)(\/|$)/.test(path))).toEqual([]);
  expect(
    paths
      .filter((path) => !(path === installHome || path.startsWith(`${installHome}/`)))
      .filter((path) => path !== join(paseoHome, "config.json") && path !== paseoHome && !tempFile.test(path)),
  ).toEqual([]);
  return { code, out, err, prompter, requested };
}

function npxCalls(): string[][] {
  if (!existsSync(npxLog)) return [];
  return readFileSync(npxLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

function record(): ReturnType<typeof parseRecord> {
  return parseRecord(readFileSync(join(installHome, "install.json"), "utf8"));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("waitFor: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const COMMAND_TEXT = formatSkillsCommand(skillsAddCommand(["claude", "codex"]));

describe("skills-assist — the argv", () => {
  it("is exactly the bead's command: constant source, symlink mode (no --copy), agents and skills as separate elements", () => {
    const command = skillsAddCommand(["claude", "codex"]);
    expect(command.executable).toBe("npx");
    expect(command.args).toEqual(EXPECTED_ARGV);
    expect(command.args).not.toContain("--copy");
    expect(SKILLS_SOURCE).toBe("cuongntr/agent-skills");
    expect(COMMAND_TEXT).toBe(`npx ${EXPECTED_ARGV.join(" ")}`);
  });

  it("spawns with an argv array and no shell (source check on the one spawn call)", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/skills/assist.ts", import.meta.url)), "utf8");
    expect(source.match(/spawn\(/g)).toHaveLength(1);
    expect(source).toContain("shell: false");
    expect(source).not.toMatch(/(?<![.\w])exec(Sync)?\(|execFile|spawnSync|shell:\s*true|--copy"/);
  });
});

describe("skills-assist — M-1: a happy interactive install stops for exactly 3 confirmations", () => {
  it("apply; enable plugin with tool access; install skills — then the skills are detected again", async () => {
    writePaseoConfig({});
    const run = await install(["install"], {
      tty: TTY,
      confirm: [true, true, true],
      npxInstallInto: join(home, ".claude", "skills"),
    });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION, TRUST_QUESTION, SKILLS_QUESTION]);
    expect(run.prompter.counts.total).toBe(3);

    // The argv and the target agents are shown inside the consent question.
    const details = run.prompter.asked.find((entry) => entry.message === SKILLS_QUESTION)?.details.join("\n") ?? "";
    expect(details).toContain(`  ${COMMAND_TEXT}`);
    expect(details).toContain("Target agents: claude, codex");

    expect(npxCalls()).toEqual([EXPECTED_ARGV]);
    expect(run.err).toContain("Skills before: Claude Code (claude) is missing");
    expect(run.err).toContain("Skills after: all required skills are installed");
    expect(run.out).toContain("fake skills: installing");
    const skills = record().skills;
    expect(skills.assistOutcome).toBe("ok");
    expect(skills.lastCommand).toBe(COMMAND_TEXT);
    expect(skills.agents).toEqual(["claude", "codex"]);
    expect(skills.lastStatus.filter((entry) => entry.agent === "claude").every((entry) => entry.present)).toBe(true);
  }, 20_000);
});

describe("skills-assist — timeout", () => {
  it("a CLI that sleeps forever is killed at the deadline; install still succeeds, exit code unchanged", async () => {
    const run = await install(["install", "--apply", "--json", "--install-skills"], { npxMode: "hang-quiet", factor: 100 });
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(report.result.exitCode).toBe(EXIT_CODES.ok);
    expect(report.result.pluginState).toBe("running");
    expect("error" in report.result).toBe(false);

    expect(run.requested).toContain(SKILLS_TIMEOUT_MS);
    expect(run.requested).toContain(SKILLS_SILENCE_WARNING_MS);
    expect(run.err).toContain("printed nothing for 60 seconds");

    const pid = Number(readFileSync(npxPid, "utf8"));
    expect(isAlive(pid)).toBe(false);
    expect(report.skills?.outcome).toBe("failed");
    expect(report.skills?.assisted).toBe(true);
    expect(report.warnings.map((warning) => warning.code)).toContain("W_SKILLS_ASSIST_FAILED");
    expect(run.err).toContain("did not finish within 300 seconds");
    expect(run.err).toContain(COMMAND_TEXT);
    expect(record().skills.assistOutcome).toBe("failed");
  }, 20_000);

  it("a failing CLI is a warning, never an exit code", async () => {
    const run = await install(["install", "--apply", "--json", "--install-skills"], { npxMode: "fail" });
    const report = JSON.parse(run.out) as PlanReport;
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["W_SKILLS_ASSIST_FAILED", "W_SKILLS_MISSING"]));
    expect(run.err).toContain("exited with code 1");
  }, 20_000);
});

describe("skills-assist — --json keeps stdout one document", () => {
  it("install --apply --json --install-skills: stdout parses while the fake CLI writes to both streams", async () => {
    const run = await install(["install", "--apply", "--json", "--install-skills"], {
      npxInstallInto: join(home, ".claude", "skills"),
    });

    const report = JSON.parse(run.out) as PlanReport;
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.counts.total).toBe(0);
    expect(run.out).not.toContain("fake skills");
    expect(run.err).toContain("fake skills: installing");
    expect(run.err).toContain("fake skills: progress on stderr");
    expect(run.err).toContain(`Running: ${COMMAND_TEXT}`);
    expect(report.skills).toMatchObject({ source: SKILLS_SOURCE, assisted: true, outcome: "ok", suggestedCommand: null });
    expect(npxCalls()).toEqual([EXPECTED_ARGV]);
  }, 20_000);

  it("without --install-skills and without a terminal nothing runs; the command is suggested", async () => {
    const run = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(run.out) as PlanReport;
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(npxCalls()).toEqual([]);
    expect(report.skills?.suggestedCommand).toBe(COMMAND_TEXT);
    expect(report.warnings.map((warning) => warning.code)).toContain("W_SKILLS_MISSING");
    expect(run.err).toContain("--install-skills");
  }, 20_000);
});

describe("skills-assist — SIGINT while the child runs", () => {
  it("forwards the signal, keeps install.json valid, releases the lock, records interrupted, prints the rerun command", async () => {
    const signals = new EventEmitter();
    const hooks: ProcessHooks = {
      pid: process.pid,
      on: (event, listener) => signals.on(event, listener),
      off: (event, listener) => signals.off(event, listener),
      // The lock re-raises the signal on itself; never let that reach the test process.
      kill: (pid, signal) => (signal === 0 || signal === undefined ? process.kill(pid, 0) : true),
    };

    const running = install(["install", "--apply", "--json", "--install-skills"], {
      npxMode: "hang",
      factor: 20,
      signals,
      lockHooks: hooks,
    });
    await waitFor(() => existsSync(npxPid) && existsSync(npxSignals) === false && readFileSync(npxPid, "utf8").length > 0);
    // Give the fake a moment to install its signal handler after writing the pid.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(join(installHome, ".lock"))).toBe(true);

    signals.emit("SIGINT");
    expect(existsSync(join(installHome, ".lock"))).toBe(false);

    const run = await running;
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(readFileSync(npxSignals, "utf8")).toContain("SIGINT");
    expect(isAlive(Number(readFileSync(npxPid, "utf8")))).toBe(false);
    expect(existsSync(join(installHome, ".lock"))).toBe(false);
    expect(record().skills.assistOutcome).toBe("interrupted");
    expect(report.skills?.outcome).toBe("interrupted");
    expect(run.err).toContain("The skills CLI was interrupted. To run it again:");
    expect(run.err).toContain(`  ${COMMAND_TEXT}`);
  }, 20_000);
});

describe("skills-assist — declining is remembered", () => {
  it("No prints manual instructions and records assistDeclinedAt; the next run does not ask; --ask-skills-again asks again", async () => {
    const first = await install(["install"], { tty: TTY, confirm: [true, false] });
    expect(first.code).toBe(EXIT_CODES.ok);
    expect(first.prompter.confirmMessages).toEqual([APPLY_QUESTION, SKILLS_QUESTION]);
    expect(npxCalls()).toEqual([]);
    expect(first.err).toContain("To install the missing agent skills yourself, run:");
    expect(first.err).toContain(`  ${COMMAND_TEXT}`);
    const declinedAt = record().skills.assistDeclinedAt;
    expect(declinedAt).not.toBeNull();

    scope?.restore();
    const second = await install(["install"], { tty: TTY, confirm: [true] });
    expect(second.prompter.confirmMessages).toEqual([APPLY_QUESTION]);
    expect(second.err).toContain("will not ask again until you pass --ask-skills-again");
    expect(record().skills.assistDeclinedAt).toBe(declinedAt);

    scope?.restore();
    const third = await install(["install", "--ask-skills-again"], { tty: TTY, confirm: [true, false] });
    expect(third.prompter.confirmMessages).toEqual([APPLY_QUESTION, SKILLS_QUESTION]);
    expect(npxCalls()).toEqual([]);
    expect(record().skills.assistDeclinedAt).not.toBeNull();
  }, 30_000);

  it("a preview never runs anything and never asks about skills", async () => {
    const run = await install(["install", "--json"]);
    const report = JSON.parse(run.out) as PlanReport;
    expect(run.code).toBe(EXIT_CODES.noTtyNoApply);
    expect(npxCalls()).toEqual([]);
    expect(report.skills?.suggestedCommand).toBe(COMMAND_TEXT);
    expect(existsSync(join(installHome, "install.json"))).toBe(false);
  }, 20_000);
});

describe("skills CLI agent names (owner decision 2026-09-15)", () => {
  it("maps claude to claude-code and passes other names through", () => {
    expect(toSkillsCliAgents(["claude", "codex"])).toEqual(["claude-code", "codex"]);
    expect(toSkillsCliAgents(["claude-code", "opencode"])).toEqual(["claude-code", "opencode"]);
  });

  it("drops the duplicate when both claude and claude-code are given", () => {
    expect(toSkillsCliAgents(["claude", "claude-code", "codex"])).toEqual(["claude-code", "codex"]);
  });

  it("never passes the bare name claude to the skills CLI", () => {
    const args = skillsAddCommand(["claude", "codex"]).args;
    const agents = args.slice(args.indexOf("-a") + 1, args.indexOf("-s"));
    expect(agents).toEqual(["claude-code", "codex"]);
    expect(agents).not.toContain("claude");
  });
});
