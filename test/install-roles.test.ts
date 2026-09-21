/**
 * Roles wired into the install flow (bead bm-wp-107-2r5.4) — Primary Proof
 * `npm test -- install-roles`.
 *
 * The real install handler runs through `runCli` against a fake `$HOME`, the
 * fake `paseo` on PATH (scripted with `BM_FAKE_SCRIPT`), and the write-scope
 * guard. No login command ever runs: `spawnLogin` is injected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanReport } from "../src/action.js";
import { runCli } from "../src/cli.js";
import type { CommandHandlers } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { ScriptedPrompter } from "../src/prompter.js";
import type { ScriptedAnswers, TtyInfo } from "../src/prompter.js";
import type { LoginCommand, LoginRunResult } from "../src/roles/login.js";
import { APPLY_QUESTION, createInstallCommand } from "../src/commands/install/index.js";
import { createRolesStep } from "../src/commands/install/roles-step.js";
import type { WriteScopeHarness } from "./helpers/write-scope.js";
import { startWriteScope } from "./helpers/write-scope.js";

// Several scenarios run two to four whole installs, each spawning the fake CLI a
// dozen times; the default 5 seconds is too tight when the full suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

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

const PROVIDERS = [
  { provider: "claude", label: "Claude", status: "available" },
  { provider: "codex", label: "Codex", status: "available" },
];
/** `provider models` is scripted by its first two argv words, so every provider offers these. */
const MODELS = [
  { id: "claude-opus-5", model: "Opus 5" },
  { id: "gpt-5.6-sol", model: "GPT-5.6-Sol" },
];

function diagnostic(loggedIn: boolean): Scripted {
  return { stdout: JSON.stringify({ provider: "x", diagnostic: `Status: Ready\nAuth: {"loggedIn": ${String(loggedIn)}}` }) };
}

function script(overrides: Record<string, Scripted> = {}): void {
  const base: Record<string, Scripted> = {
    "daemon status": { stdout: JSON.stringify({ home: paseoHome, cliVersion: "0.8.0", daemonVersion: "0.8.0" }) },
    "daemon reload": { stdout: JSON.stringify({ appliedPaths: [] }) },
    "plugin ls": { stdout: "[]" },
    "plugin install": {
      stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }),
    },
    "provider ls": { stdout: JSON.stringify(PROVIDERS) },
    "provider models": { stdout: JSON.stringify(MODELS) },
    "provider diagnostic": diagnostic(true),
  };
  writeFileSync(scriptFile, JSON.stringify({ ...base, ...overrides }));
}

/** A user profile that is not ours: it must keep its place and its bytes. */
const USER_PROFILE = { id: "room-lead", name: "Room lead", provider: "claude", model: "claude-opus-5" };

function writePaseoConfig(config: Record<string, unknown>): void {
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(join(paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function configText(): string {
  return readFileSync(join(paseoHome, "config.json"), "utf8");
}

interface ConfigShape {
  agents?: { providers?: Record<string, Record<string, unknown>> };
  daemon: { agentProfiles?: Record<string, unknown>[] };
}

function config(): ConfigShape {
  return JSON.parse(configText()) as ConfigShape;
}

interface RecordShape {
  roles: { role: string; providerId: string; profileId: string; baseProvider: string; model: string; paseoTools: boolean }[];
  backups: { dir: string; reason: string }[];
}

function installedRecord(): RecordShape {
  return JSON.parse(readFileSync(join(installHome, "install.json"), "utf8")) as RecordShape;
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

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-install-roles-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-install-roles-log-")));
  installHome = join(home, ".paseo-bm");
  paseoHome = join(home, ".paseo");
  payloadRoot = join(outside, "package", "plugin");
  argvLog = join(outside, "argv.log");
  scriptFile = join(outside, "script.json");
  writePayload();
  // Both switches on, so the trust-boundary question stays out of these tests.
  writePaseoConfig({ pluginsEnabled: true, daemon: { mcp: { injectIntoAgents: true }, agentProfiles: [USER_PROFILE] } });
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
  answers?: ScriptedAnswers;
  /** What the injected login spawner returns; every call is recorded. */
  login?: LoginRunResult;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
  prompter: ScriptedPrompter;
  logins: LoginCommand[];
}

async function install(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const tty = options.tty ?? NO_TTY;
  const prompter = new ScriptedPrompter(options.answers ?? {}, { interactive: tty.interactive });
  const env = { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`, BM_FAKE_ARGV_LOG: argvLog, BM_FAKE_SCRIPT: scriptFile };
  const logins: LoginCommand[] = [];
  const roles = createRolesStep({
    spawnLogin: (command) => {
      logins.push(command);
      return Promise.resolve(options.login ?? { ok: true, exitCode: 0 });
    },
  });

  // `record` as in test/consent-enable.test.ts: the atomic write of config.json
  // creates a temporary file beside it. Every write is judged below.
  scope = startWriteScope({ installHome, paseoHome, watch: [home], mode: "record" });
  const handler = createInstallCommand({
    homeDir: home,
    payloadRoot,
    fs: scope.fs,
    lock: { handleSignals: false },
    steps: { roles },
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
  return { code, out, err, prompter, logins };
}

function configWrites(): number {
  return (scope?.writes ?? []).filter((write) => write.path === join(paseoHome, "config.json")).length;
}

function roleQuestions(prompter: ScriptedPrompter, label: string): string[] {
  return prompter.asked.map((record) => record.message).filter((message) => message.includes(label));
}

/* ------------------------------------------------------------------------ */

describe("install-roles — interactive, scripted prompter", () => {
  it("asks all three roles (Reviewer on its own), previews bm-* entries, then writes them and roles[]", async () => {
    const run = await install(["install"], {
      tty: TTY,
      answers: {
        input: ["BM Manager", "BM Worker", "BM Reviewer"],
        // manager: claude / claude-opus-5; worker: codex / gpt-5.6-sol; reviewer: claude / claude-opus-5
        select: ["claude", "claude-opus-5", "codex", "gpt-5.6-sol", "claude", "claude-opus-5"],
        confirm: [true],
      },
    });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION]);
    for (const label of ["Manager", "Worker", "Reviewer"]) {
      expect(roleQuestions(run.prompter, label)).toHaveLength(3);
    }
    // The Reviewer is asked separately, with its own explanation.
    const reviewerName = run.prompter.asked.find((record) => record.message === "Name for the Reviewer agent");
    expect(reviewerName?.details.join(" ")).toMatch(/asked separately/);

    // Every role question comes before the apply confirmation, and the preview
    // printed before that confirmation lists the entries to register.
    const kinds = run.prompter.asked.map((record) => record.kind);
    expect(kinds.lastIndexOf("select")).toBeLessThan(kinds.indexOf("confirm"));
    const preview = run.out.slice(0, run.out.indexOf("Changes made"));
    for (const id of ["bm-manager", "bm-worker", "bm-reviewer"]) {
      expect(preview).toContain(`paseoHome/config.json#agents.providers.${id}`);
      expect(preview).toContain(`paseoHome/config.json#daemon.agentProfiles[${id}]`);
    }

    const written = config();
    expect(written.agents?.providers).toEqual({
      "bm-manager": { extends: "claude", label: "BM Manager", paseoTools: { enabled: true } },
      "bm-worker": { extends: "codex", label: "BM Worker", paseoTools: { enabled: true } },
      "bm-reviewer": { extends: "claude", label: "BM Reviewer" },
    });
    const profiles = written.daemon.agentProfiles ?? [];
    expect(profiles[0]).toEqual(USER_PROFILE);
    expect(profiles.slice(1).map((profile) => [profile["id"], profile["provider"], profile["model"]])).toEqual([
      ["bm-manager", "bm-manager", "claude-opus-5"],
      ["bm-worker", "bm-worker", "gpt-5.6-sol"],
      ["bm-reviewer", "bm-reviewer", "claude-opus-5"],
    ]);

    expect(installedRecord().roles.map((entry) => [entry.role, entry.providerId, entry.profileId, entry.baseProvider, entry.model, entry.paseoTools])).toEqual([
      ["manager", "bm-manager", "bm-manager", "claude", "claude-opus-5", true],
      ["worker", "bm-worker", "bm-worker", "codex", "gpt-5.6-sol", true],
      ["reviewer", "bm-reviewer", "bm-reviewer", "claude", "claude-opus-5", false],
    ]);
    // The config backup is in backups[] and on disk.
    const backup = installedRecord().backups.find((entry) => entry.reason.includes("paseo-config"));
    expect(backup).toBeDefined();
    expect(existsSync(join(installHome, backup?.dir ?? "missing", "paseo-config.json"))).toBe(true);
    expect(subcommands()).toContain("daemon reload");
    expect(subcommands()).not.toContain("daemon restart");
  });

  it("the JSON preview lists the three roles and a config action per bm-* entry, with zero writes", async () => {
    const run = await install(["install", "--json", "--role=worker=codex/gpt-5.6-sol"]);
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.noTtyNoApply);
    expect(scope?.writes).toEqual([]);
    expect(report.roles.map((role) => [role.role, role.provider, role.model, role.paseoTools])).toEqual([
      ["manager", "claude", "claude-opus-5", true],
      ["worker", "codex", "gpt-5.6-sol", true],
      ["reviewer", "claude", "claude-opus-5", false],
    ]);
    const targets = report.actions.filter((action) => action.kind === "config").map((action) => action.target);
    expect(targets).toEqual(
      expect.arrayContaining([
        "paseoHome/config.json#agents.providers.bm-worker",
        "paseoHome/config.json#daemon.agentProfiles[bm-reviewer]",
      ]),
    );
    expect(targets.filter((target) => target.includes("bm-"))).toHaveLength(6);
  });
});

describe("install-roles — --role", () => {
  it("a valid --role skips that role's questions only", async () => {
    const run = await install(["install", "--role=worker=codex/gpt-5.6-sol"], { tty: TTY, answers: { confirm: [true] } });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(roleQuestions(run.prompter, "Worker")).toEqual([]);
    expect(roleQuestions(run.prompter, "Manager")).toHaveLength(3);
    expect(roleQuestions(run.prompter, "Reviewer")).toHaveLength(3);
    expect(config().agents?.providers?.["bm-worker"]).toEqual({ extends: "codex", label: "Beads Worker", paseoTools: { enabled: true } });
  });

  it.each([
    ["an unknown provider", "--role=worker=ghost/gpt-5.6-sol"],
    ["an unknown model", "--role=reviewer=codex/no-such-model"],
  ])("%s: exit 3 with E_PROVIDER_UNAVAILABLE and zero writes", async (_label, flag) => {
    const before = configText();
    const run = await install(["install", "--apply", "--yes", "--json", flag]);
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.preflight);
    expect(report.result.error?.code).toBe("E_PROVIDER_UNAVAILABLE");
    expect(scope?.writes).toEqual([]);
    expect(existsSync(installHome)).toBe(false);
    expect(configText()).toBe(before);
    expect(subcommands()).not.toContain("plugin install");
    expect(subcommands()).not.toContain("daemon reload");
  });
});

describe("install-roles — re-install", () => {
  it("without --reconfigure asks nothing again and does not rewrite config.json; with it, asks again", async () => {
    await install(["install", "--apply", "--yes"], { tty: TTY, answers: { select: ["claude", "claude-opus-5", "codex", "gpt-5.6-sol"] } });
    const before = configText();
    scope?.restore();
    rmSync(argvLog, { force: true });

    const again = await install(["install", "--apply", "--json"], { tty: TTY });
    const report = JSON.parse(again.out) as PlanReport;
    expect(again.code).toBe(EXIT_CODES.ok);
    expect(again.prompter.counts.total).toBe(0);
    expect(configText()).toBe(before);
    expect(configWrites()).toBe(0);
    expect(subcommands()).not.toContain("daemon reload");
    expect(report.actions.filter((action) => action.target.includes("bm-")).every((action) => action.kind === "skip")).toBe(true);
    expect(report.roles.find((role) => role.role === "worker")?.provider).toBe("codex");

    // Interactive re-run without --reconfigure: still no role question.
    scope?.restore();
    const quiet = await install(["install"], { tty: TTY, answers: { confirm: [true] } });
    expect(quiet.prompter.counts.input + quiet.prompter.counts.select).toBe(0);
    expect(configText()).toBe(before);

    scope?.restore();
    const redo = await install(["install", "--reconfigure"], {
      tty: TTY,
      answers: { select: ["codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol"], confirm: [true] },
    });
    expect(redo.code).toBe(EXIT_CODES.ok);
    expect(redo.prompter.counts.input).toBe(3);
    expect(redo.prompter.counts.select).toBe(6);
    expect(config().agents?.providers?.["bm-manager"]?.["extends"]).toBe("codex");
    expect(installedRecord().roles.every((entry) => entry.baseProvider === "codex")).toBe(true);
  });

  it("keeps the names chosen interactively: a non-interactive re-run plans no change and leaves config.json byte-identical (bm-lev)", async () => {
    const first = await install(["install"], {
      tty: TTY,
      answers: {
        input: ["Hieu", "Cuong", "Duy"],
        select: ["claude", "claude-opus-5", "codex", "gpt-5.6-sol", "claude", "claude-opus-5"],
        confirm: [true],
      },
    });
    expect(first.code).toBe(EXIT_CODES.ok);
    expect(config().agents?.providers?.["bm-worker"]?.["label"]).toBe("Cuong");
    const before = configText();
    scope?.restore();
    rmSync(argvLog, { force: true });
    // The daemon now has the plugin, as a real one would after the first run.
    script({
      "plugin ls": {
        stdout: JSON.stringify([{ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }]),
      },
    });

    const again = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(again.out) as PlanReport;
    expect(again.code).toBe(EXIT_CODES.ok);
    expect(report.actions.filter((action) => action.kind !== "skip")).toEqual([]);
    expect(configText()).toBe(before);
    expect(configWrites()).toBe(0);
    expect(subcommands()).not.toContain("daemon reload");
    const names = (config().daemon.agentProfiles ?? []).slice(1).map((profile) => profile["name"]);
    expect(names).toEqual(["Hieu", "Cuong", "Duy"]);
  });

  it("a re-run with --role changes that role's provider/model and keeps its chosen name (bm-6uy)", async () => {
    const first = await install(["install"], {
      tty: TTY,
      answers: {
        input: ["Hieu", "Cuong", "Duy"],
        select: ["claude", "claude-opus-5", "codex", "gpt-5.6-sol", "claude", "claude-opus-5"],
        confirm: [true],
      },
    });
    expect(first.code).toBe(EXIT_CODES.ok);
    scope?.restore();
    script({
      "plugin ls": {
        stdout: JSON.stringify([{ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }]),
      },
    });

    const again = await install(["install", "--apply", "--json", "--role=manager=codex/gpt-5.6-sol"]);
    expect(again.code).toBe(EXIT_CODES.ok);
    const profiles = (config().daemon.agentProfiles ?? []).slice(1);
    expect(profiles.map((profile) => [profile["id"], profile["name"], profile["model"]])).toEqual([
      ["bm-manager", "Hieu", "gpt-5.6-sol"],
      ["bm-worker", "Cuong", "gpt-5.6-sol"],
      ["bm-reviewer", "Duy", "claude-opus-5"],
    ]);
    expect(config().agents?.providers?.["bm-manager"]).toEqual({ extends: "codex", label: "Hieu", paseoTools: { enabled: true } });
    expect(installedRecord().roles.find((entry) => entry.role === "manager")?.baseProvider).toBe("codex");
  });

  it("--prune keeps the config backup taken by the role step", async () => {
    await install(["install", "--apply"]);
    scope?.restore();

    const run = await install(["install", "--apply", "--prune", "--role=worker=codex/gpt-5.6-sol"]);
    expect(run.code).toBe(EXIT_CODES.ok);
    const backups = installedRecord().backups.filter((entry) => entry.reason.includes("paseo-config"));
    expect(backups.length).toBeGreaterThan(0);
    const latest = backups[backups.length - 1];
    expect(existsSync(join(installHome, latest?.dir ?? "missing", "paseo-config.json"))).toBe(true);
  });
});

describe("install-roles — no terminal", () => {
  it("missing configuration: defaults with a warning, no question, does not hang", async () => {
    const run = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.counts.total).toBe(0);
    expect(run.err).toMatch(/No terminal to ask on and no --role for the Manager, so it defaults to claude\/claude-opus-5/);
    expect(run.err).toMatch(/Reviewer/);
    expect(report.roles).toHaveLength(3);
    expect(installedRecord().roles).toHaveLength(3);
    expect(Object.keys(config().agents?.providers ?? {})).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
  });

  it.each([
    ["install --apply", ["install", "--apply"]],
    ["install --apply --json", ["install", "--apply", "--json"]],
    ["install (preview)", ["install"]],
  ])("%s prints each default-role warning exactly once (bm-os3)", async (_label, argv) => {
    const run = await install(argv);
    const everything = `${run.out}${run.err}`;
    for (const role of ["Manager", "Worker", "Reviewer"]) {
      const needle = `No terminal to ask on and no --role for the ${role},`;
      expect(everything.split(needle).length - 1).toBe(1);
    }
  });
});

describe("install-roles — provider not logged in", () => {
  it("without a terminal: W_PROVIDER_NOT_LOGGED_IN, roles registered, exit code unchanged, nothing run", async () => {
    script({ "provider diagnostic": diagnostic(false) });
    const run = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(run.out) as PlanReport;

    expect(run.code).toBe(EXIT_CODES.ok);
    expect("error" in report.result).toBe(false);
    expect(report.warnings.map((warning) => warning.code)).toContain("W_PROVIDER_NOT_LOGGED_IN");
    expect(report.roles.every((role) => role.loggedIn === false)).toBe(true);
    expect(run.logins).toEqual([]);
    expect(installedRecord().roles).toHaveLength(3);
  });

  it("on a terminal: offers the tool's own login, a failed login still ends installed with a warning", async () => {
    script({ "provider diagnostic": diagnostic(false) });
    const run = await install(["install", "--role=manager=claude/claude-opus-5", "--role=worker=claude/claude-opus-5", "--role=reviewer=claude/claude-opus-5"], {
      tty: TTY,
      answers: { confirm: [true, true] },
      login: { ok: false, reason: "exit-code", exitCode: 1, signal: null },
    });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION, "Run `claude auth login` now?"]);
    expect(run.logins).toEqual([{ executable: "claude", args: ["auth", "login"] }]);
    expect(run.err).toContain("claude auth login");
    expect(installedRecord().roles).toHaveLength(3);
    expect(config().agents?.providers?.["bm-reviewer"]).toEqual({ extends: "claude", label: "Beads Reviewer" });
  });
});

/**
 * Delta 20260921 §4.1.2, ADR-008 D5: Paseo's config is the source of truth for
 * a role's settings, so a re-install merges into the `bm-*` entries instead of
 * replacing them. `config.json` is edited between two runs the way Paseo's
 * Settings screen would.
 */
describe("install-roles — re-install keeps what the user set in Paseo (REQ-062 c, e)", () => {
  function editInPaseo(mutate: (current: ConfigShape) => void): void {
    const current = config();
    mutate(current);
    writeFileSync(join(paseoHome, "config.json"), `${JSON.stringify(current, null, 2)}\n`);
  }

  function profile(current: ConfigShape, id: string): Record<string, unknown> {
    const found = (current.daemon.agentProfiles ?? []).find((entry) => entry["id"] === id);
    if (found === undefined) throw new Error(`No profile ${id}`);
    return found;
  }

  /** The daemon has the plugin after the first run, as a real one would. */
  function pluginRegistered(): void {
    script({
      "plugin ls": {
        stdout: JSON.stringify([{ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }]),
      },
    });
  }

  /** Thinking, mode, features, icon and disabled tools, plus a fallback alias the installer does not own. */
  function setInPaseo(): void {
    editInPaseo((current) => {
      const providers = current.agents?.providers ?? {};
      providers["bm-manager"]!["paseoTools"] = { enabled: true, disabledTools: ["archive_agent"] };
      providers["bm-worker"]!["paseoTools"] = { enabled: true, disabledTools: ["kill_agent"] };
      providers["bm-worker-fallback-1"] = { extends: "codex", label: "Worker fallback" };
      Object.assign(profile(current, "bm-worker"), {
        thinkingOptionId: "high",
        modeId: "acceptEdits",
        featureValues: { fastMode: true },
        icon: "hammer",
      });
      Object.assign(profile(current, "bm-reviewer"), { thinkingOptionId: "xhigh", modeId: "auto" });
    });
  }

  it("keeps user keys: a plain re-install keeps thinking, mode, features, icon and disabledTools, and writes nothing (REQ-009)", async () => {
    const first = await install(["install", "--apply", "--json"]);
    expect(first.code).toBe(EXIT_CODES.ok);
    setInPaseo();
    const before = configText();
    scope?.restore();
    rmSync(argvLog, { force: true });
    pluginRegistered();

    const again = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(again.out) as PlanReport;

    expect(again.code).toBe(EXIT_CODES.ok);
    expect(report.actions.filter((action) => action.kind !== "skip")).toEqual([]);
    expect(configWrites()).toBe(0);
    expect(configText()).toBe(before);
    expect(subcommands()).not.toContain("daemon reload");
    const kept = config();
    expect(profile(kept, "bm-worker")).toMatchObject({ thinkingOptionId: "high", modeId: "acceptEdits", featureValues: { fastMode: true }, icon: "hammer" });
    expect(kept.agents?.providers?.["bm-worker"]?.["paseoTools"]).toEqual({ enabled: true, disabledTools: ["kill_agent"] });
  });

  it("--role worker=codex/gpt-5.6-sol: model and extends change, thinkingOptionId goes, modeId stays; the other roles are untouched", async () => {
    const first = await install(["install", "--apply", "--json"]);
    expect(first.code).toBe(EXIT_CODES.ok);
    expect(profile(config(), "bm-worker")["model"]).toBe("claude-opus-5");
    setInPaseo();
    const before = config();
    scope?.restore();
    pluginRegistered();

    const again = await install(["install", "--apply", "--json", "--role=worker=codex/gpt-5.6-sol"]);
    const report = JSON.parse(again.out) as PlanReport;

    expect(again.code).toBe(EXIT_CODES.ok);
    const after = config();
    const worker = profile(after, "bm-worker");
    expect(worker).toMatchObject({
      id: "bm-worker",
      name: "Beads Worker",
      provider: "bm-worker",
      model: "gpt-5.6-sol",
      modeId: "acceptEdits",
      featureValues: { fastMode: true },
      icon: "hammer",
    });
    expect(worker).not.toHaveProperty("thinkingOptionId");
    expect(String(worker["notes"])).toContain("paseo-bm Worker");
    expect(after.agents?.providers?.["bm-worker"]).toEqual({
      extends: "codex",
      label: "Beads Worker",
      paseoTools: { enabled: true, disabledTools: ["kill_agent"] },
    });

    // Not named: exactly as the user left them, fallback alias included.
    for (const id of ["bm-manager", "bm-reviewer", "bm-worker-fallback-1"]) {
      expect(after.agents?.providers?.[id]).toEqual(before.agents?.providers?.[id]);
    }
    for (const id of ["bm-manager", "bm-reviewer"]) {
      expect(profile(after, id)).toEqual(profile(before, id));
    }
    expect(after.agents?.providers?.["bm-reviewer"]).not.toHaveProperty("paseoTools");
    expect(after.daemon.agentProfiles?.[0]).toEqual(USER_PROFILE);

    // The report shows the merged entry that was written, not a replacement.
    const action = report.actions.find((entry) => entry.target === "paseoHome/config.json#daemon.agentProfiles[bm-worker]");
    expect(action).toMatchObject({ kind: "config", reason: "outdated", to: worker });
    // roles[] keeps its shape: what the installer wrote last.
    expect(installedRecord().roles.find((entry) => entry.role === "worker")).toMatchObject({
      baseProvider: "codex",
      model: "gpt-5.6-sol",
      modeId: null,
      thinkingOptionId: null,
    });
  });

  it("a bm-* entry deleted in Paseo is recreated from roles[], and only that entry is written", async () => {
    const first = await install(["install", "--apply", "--json", "--role=worker=codex/gpt-5.6-sol"]);
    expect(first.code).toBe(EXIT_CODES.ok);
    const original = config();
    editInPaseo((current) => {
      delete current.agents?.providers?.["bm-worker"];
      current.daemon.agentProfiles = (current.daemon.agentProfiles ?? []).filter((entry) => entry["id"] !== "bm-worker");
    });
    scope?.restore();
    pluginRegistered();

    const again = await install(["install", "--apply", "--json"]);
    const report = JSON.parse(again.out) as PlanReport;

    expect(again.code).toBe(EXIT_CODES.ok);
    expect(report.actions.filter((action) => action.kind === "config").map((action) => [action.target, action.reason])).toEqual([
      ["paseoHome/config.json#agents.providers.bm-worker", "missing"],
      ["paseoHome/config.json#daemon.agentProfiles[bm-worker]", "missing"],
    ]);
    // From roles[] (codex / gpt-5.6-sol), not from a catalogue default.
    const after = config();
    expect(after.agents?.providers?.["bm-worker"]).toEqual(original.agents?.providers?.["bm-worker"]);
    expect(profile(after, "bm-worker")).toEqual(profile(original, "bm-worker"));
    expect(profile(after, "bm-worker")["model"]).toBe("gpt-5.6-sol");
    for (const id of ["bm-manager", "bm-reviewer"]) {
      expect(profile(after, id)).toEqual(profile(original, id));
      expect(after.agents?.providers?.[id]).toEqual(original.agents?.providers?.[id]);
    }
  });
});
