/**
 * One consent for both switches (bead bm-wp-107-2r5.2) — Primary Proof
 * `npm test -- consent-enable`.
 *
 * Runs the real install handler through `runCli` against a fake `$HOME`, the
 * fake `paseo` on PATH, and the write-scope guard. `plugin ls` after the reload
 * is scripted through a thin adapter wrapper, and the 30-second poll runs on a
 * fake clock, so no test waits for real.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanReport } from "../src/action.js";
import { runCli } from "../src/cli.js";
import type { CommandHandlers } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { PaseoAdapter, PluginSummary } from "../src/paseo/adapter.js";
import { createPaseoAdapter } from "../src/paseo/adapter.js";
import { ScriptedPrompter } from "../src/prompter.js";
import type { TtyInfo } from "../src/prompter.js";
import {
  PLUGIN_POLL_INTERVAL_MS,
  PLUGIN_RUNNING_TIMEOUT_MS,
  TRUST_QUESTION,
  TRUST_WARNING,
  createTrustBoundaryStep,
} from "../src/commands/install/enable.js";
import { APPLY_QUESTION, createInstallCommand } from "../src/commands/install/index.js";
import type { WriteScopeHarness } from "./helpers/write-scope.js";
import { startWriteScope } from "./helpers/write-scope.js";

const FAKE_DIR = fileURLToPath(new URL("./fakes/", import.meta.url));
const VERSION = "0.2.0";
const TTY: TtyInfo = { stdin: true, stdout: true, interactive: true };
const NO_TTY: TtyInfo = { stdin: false, stdout: false, interactive: false };

let home: string;
let outside: string;
let installHome: string;
let paseoHome: string;
let payloadRoot: string;
let argvLog: string;
let scriptFile: string;
let scope: WriteScopeHarness | undefined;

interface Scripted {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

function script(overrides: Record<string, Scripted> = {}): void {
  const base: Record<string, Scripted> = {
    "daemon status": { stdout: JSON.stringify({ home: paseoHome, cliVersion: "0.8.0", daemonVersion: "0.8.0" }) },
    "daemon reload": { stdout: JSON.stringify({ appliedPaths: ["pluginsEnabled", "daemon.mcp.injectIntoAgents"] }) },
    "plugin ls": { stdout: "[]" },
    "plugin install": {
      stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "disabled" }),
    },
  };
  writeFileSync(scriptFile, JSON.stringify({ ...base, ...overrides }));
}

function configText(): string {
  return readFileSync(join(paseoHome, "config.json"), "utf8");
}

function writePaseoConfig(config: Record<string, unknown>): void {
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function writePayload(): void {
  const files: Record<string, string> = {
    "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
    "index.server.ts": `export const version = "${VERSION}";\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    const target = join(payloadRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function subcommands(): string[] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv.slice(0, 2).join(" "));
}

interface RecordShape {
  paseo: { pluginsEnabledSetByUs: boolean; mcpInject: { setByUs: boolean; previous: { present: boolean; value: boolean | null } } };
  backups: { dir: string; reason: string }[];
}

function installedRecord(): RecordShape {
  return JSON.parse(readFileSync(join(installHome, "install.json"), "utf8")) as RecordShape;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-consent-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-consent-log-")));
  installHome = join(home, ".paseo-bm");
  paseoHome = join(home, ".paseo");
  payloadRoot = join(outside, "package", "plugin");
  argvLog = join(outside, "argv.log");
  scriptFile = join(outside, "script.json");
  writePayload();
  writePaseoConfig({});
  script();
});

afterEach(() => {
  scope?.restore();
  scope = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface RunOptions {
  tty?: TtyInfo;
  confirm?: boolean[];
  /** Statuses `plugin ls` reports after the reload, one per poll; the last one repeats. */
  statusesAfterReload?: string[];
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  prompter: ScriptedPrompter;
  /** Fake clock at the end, in ms since the run started. */
  elapsedMs: number;
  sleeps: number[];
}

async function install(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const tty = options.tty ?? NO_TTY;
  const prompter = new ScriptedPrompter({ confirm: options.confirm ?? [] }, { interactive: tty.interactive });
  const env = { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`, BM_FAKE_ARGV_LOG: argvLog, BM_FAKE_SCRIPT: scriptFile };
  const real = createPaseoAdapter({ env });

  let reloaded = false;
  let polls = 0;
  const statuses = options.statusesAfterReload ?? ["running"];
  const adapter: PaseoAdapter = {
    ...real,
    daemonReload: async () => {
      const result = await real.daemonReload();
      reloaded = true;
      return result;
    },
    pluginList: async () => {
      const listed = await real.pluginList();
      if (!reloaded) return listed;
      const status = statuses[Math.min(polls, statuses.length - 1)] ?? "running";
      polls += 1;
      const plugin: PluginSummary = { id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status, raw: {} };
      return [plugin];
    },
  };

  let clockMs = 0;
  const sleeps: number[] = [];
  const trustBoundary = createTrustBoundaryStep({
    clock: () => clockMs,
    sleep: (ms) => {
      sleeps.push(ms);
      clockMs += ms;
      return Promise.resolve();
    },
  });

  // `record` rather than `block`, as in test/paseo-config.test.ts: the atomic
  // write of config.json issues a `mkdir -p` of the (existing) Paseo home and
  // a temporary file beside the target. Every write is judged below instead.
  scope = startWriteScope({ installHome, paseoHome, watch: [home], mode: "record" });
  const handler = createInstallCommand({
    homeDir: home,
    payloadRoot,
    adapter,
    fs: scope.fs,
    lock: { handleSignals: false },
    steps: { trustBoundary },
  });
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
  const tempFile = new RegExp(`^${paseoHome}/\\.config\\.json\\.\\d+\\.[0-9a-f]+\\.tmp$`);
  const stray = scope
    .paths()
    .filter((path) => !(path === installHome || path.startsWith(`${installHome}/`)))
    .filter((path) => path !== join(paseoHome, "config.json") && path !== paseoHome && !tempFile.test(path));
  expect(stray).toEqual([]);
  return { code, out, err, prompter, elapsedMs: clockMs, sleeps };
}

function trustQuestions(prompter: ScriptedPrompter): number {
  return prompter.confirmMessages.filter((message) => message === TRUST_QUESTION).length;
}

describe("consent-enable — both switches already on", () => {
  it("asks nothing, writes nothing to config.json, does not reload", async () => {
    writePaseoConfig({ pluginsEnabled: true, daemon: { mcp: { injectIntoAgents: true } } });
    const before = configText();

    const run = await install(["install"], { tty: TTY, confirm: [true] });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION]);
    expect(configText()).toBe(before);
    expect(subcommands()).not.toContain("daemon reload");
    expect(installedRecord().paseo.pluginsEnabledSetByUs).toBe(false);
    expect(installedRecord().paseo.mcpInject.setByUs).toBe(false);
  });
});

describe("consent-enable — switches off, consent given", () => {
  it("asks exactly one question naming both consequences, enables both, reloads, reaches running", async () => {
    const run = await install(["install"], { tty: TTY, confirm: [true, true], statusesAfterReload: ["disabled", "disabled", "running"] });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION, TRUST_QUESTION]);
    expect(trustQuestions(run.prompter)).toBe(1);

    // Both consequences are in the warning shown with the question.
    const details = run.prompter.asked.find((record) => record.message === TRUST_QUESTION)?.details ?? [];
    const warning = details.join("\n");
    expect(details).toEqual(TRUST_WARNING);
    expect(warning).toMatch(/without a sandbox/);
    expect(warning).toMatch(/EVERY agent on this machine/);
    expect(warning).toMatch(/create, prompt and stop other agents/);

    const config = JSON.parse(configText()) as { pluginsEnabled: boolean; daemon: { mcp: { injectIntoAgents: boolean } } };
    expect(config.pluginsEnabled).toBe(true);
    expect(config.daemon.mcp.injectIntoAgents).toBe(true);

    const calls = subcommands();
    expect(calls).toContain("daemon reload");
    expect(calls).not.toContain("daemon restart");
    expect(calls).not.toContain("daemon stop");

    // Polled on the fake clock: two waits of 500 ms, well inside 30 seconds.
    expect(run.sleeps).toEqual([PLUGIN_POLL_INTERVAL_MS, PLUGIN_POLL_INTERVAL_MS]);
    expect(run.elapsedMs).toBeLessThanOrEqual(PLUGIN_RUNNING_TIMEOUT_MS);

    const record = installedRecord();
    expect(record.paseo.pluginsEnabledSetByUs).toBe(true);
    expect(record.paseo.mcpInject).toEqual({ setByUs: true, previous: { present: false, value: null } });
    expect(record.backups).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("paseo-config") }));
    const backupDir = record.backups.find((entry) => entry.reason.includes("paseo-config"))?.dir ?? "";
    expect(readdirSync(join(installHome, backupDir))).toContain("paseo-config.json");
  });

  it("--enable-plugins without a terminal is consent: no question, previous state per key recorded", async () => {
    writePaseoConfig({ pluginsEnabled: false, daemon: { mcp: { injectIntoAgents: false } } });

    const run = await install(["install", "--apply", "--enable-plugins", "--json"]);
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.counts.total).toBe(0);
    expect(report.result.pluginState).toBe("running");
    expect(report.paseo.pluginsEnabled).toBe(true);
    expect("error" in report.result).toBe(false);
    expect(run.err).toMatch(/EVERY agent on this machine/);
    expect(installedRecord().paseo.mcpInject).toEqual({ setByUs: true, previous: { present: true, value: false } });
  });

  it("only the switch paseo-bm turned on is marked setByUs", async () => {
    writePaseoConfig({ pluginsEnabled: true });

    const run = await install(["install"], { tty: TTY, confirm: [true, true] });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(trustQuestions(run.prompter)).toBe(1);
    const record = installedRecord();
    expect(record.paseo.pluginsEnabledSetByUs).toBe(false);
    expect(record.paseo.mcpInject).toEqual({ setByUs: true, previous: { present: false, value: null } });
  });
});

describe("consent-enable — switches off, consent refused", () => {
  it("interactive No: the rest of the install completes, config untouched, exit 4, summary says how to enable", async () => {
    const before = configText();

    const run = await install(["install"], { tty: TTY, confirm: [true, false] });

    expect(run.code).toBe(EXIT_CODES.consentMissing);
    expect(trustQuestions(run.prompter)).toBe(1);
    expect(configText()).toBe(before);
    expect(subcommands()).toContain("plugin install");
    expect(subcommands()).not.toContain("daemon reload");
    expect(existsSync(join(installHome, "plugin", VERSION, "index.server.ts"))).toBe(true);
    expect(installedRecord().paseo.pluginsEnabledSetByUs).toBe(false);
    expect(installedRecord().paseo.mcpInject.setByUs).toBe(false);
    expect(run.err).toContain("npx paseo-bm install --apply --enable-plugins");
  });

  it("no terminal and no --enable-plugins: exit 4 with no question and no result.error", async () => {
    const before = configText();
    const run = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.consentMissing);
    expect(report.result.exitCode).toBe(EXIT_CODES.consentMissing);
    expect("error" in report.result).toBe(false);
    expect(report.result.pluginState).toBe("disabled");
    expect(run.prompter.counts.total).toBe(0);
    expect(configText()).toBe(before);
    expect(existsSync(join(installHome, "install.json"))).toBe(true);
  });
});

describe("consent-enable — --yes is never consent", () => {
  it("without a terminal, --apply --yes turns on no switch", async () => {
    const before = configText();
    const run = await install(["install", "--apply", "--yes"]);
    expect(run.code).toBe(EXIT_CODES.consentMissing);
    expect(configText()).toBe(before);
    expect(subcommands()).not.toContain("daemon reload");
  });

  it("on a terminal, --yes skips the apply confirmation but still asks the trust question; No enables nothing", async () => {
    const before = configText();
    const run = await install(["install", "--apply", "--yes"], { tty: TTY, confirm: [false] });
    expect(run.code).toBe(EXIT_CODES.consentMissing);
    expect(run.prompter.confirmMessages).toEqual([TRUST_QUESTION]);
    expect(configText()).toBe(before);
  });
});

describe("consent-enable — failures", () => {
  it("reload fails: config.json is restored from the backup, the record claims nothing, exit 4", async () => {
    writePaseoConfig({ pluginsEnabled: false, other: { keep: 1 } });
    const before = configText();
    script({ "daemon reload": { exit: 1, stderr: "config rejected\n" } });

    const run = await install(["install", "--apply", "--enable-plugins"]);

    expect(run.code).toBe(EXIT_CODES.consentMissing);
    expect(configText()).toBe(before);
    // One reload for the change, one quiet reload after putting the backup back.
    expect(subcommands().filter((call) => call === "daemon reload")).toHaveLength(2);
    const record = installedRecord();
    expect(record.paseo.pluginsEnabledSetByUs).toBe(false);
    expect(record.paseo.mcpInject).toEqual({ setByUs: false, previous: { present: false, value: null } });
    expect(run.err).toMatch(/backup was put back/);
  });

  it("plugin never reaches running within 30 seconds: exit 7 E_PLUGIN_LOAD_FAILED, switches left on", async () => {
    const run = await install(["install", "--apply", "--enable-plugins", "--json"], { statusesAfterReload: ["disabled"] });
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(report.result.error?.code).toBe("E_PLUGIN_LOAD_FAILED");
    expect(report.result.pluginState).toBe("disabled");
    expect(run.elapsedMs).toBe(PLUGIN_RUNNING_TIMEOUT_MS);
    expect(run.err).toContain("paseo plugin logs paseo-bm");
    const config = JSON.parse(configText()) as { pluginsEnabled: boolean; daemon: { mcp: { injectIntoAgents: boolean } } };
    expect(config.pluginsEnabled).toBe(true);
    expect(config.daemon.mcp.injectIntoAgents).toBe(true);
    expect(installedRecord().paseo.mcpInject.setByUs).toBe(true);
  });
});
