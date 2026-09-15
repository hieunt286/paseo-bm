/**
 * The install command flow (bead bm-wp-105-6ec.4) — Primary Proof
 * `npm test -- install-command`.
 *
 * Every scenario runs the real handler through `runCli` against a fake `$HOME`
 * under the OS temp directory, with the fake `paseo` from `test/fakes/` found
 * on PATH and the write-scope guard patched over `node:fs`. The argv log of the
 * fake lives outside the fake `$HOME`, so the guard sees only paseo-bm's writes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanReport } from "../src/action.js";
import { runCli } from "../src/cli.js";
import type { CommandHandlers } from "../src/cli.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { ScriptedPrompter } from "../src/prompter.js";
import type { TtyInfo } from "../src/prompter.js";
import { ROLE_NAMES, createRecord, serializeRecord } from "../src/record.js";
import { DEFAULT_ROLE_DISPLAY_NAMES, roleGrantsPaseoTools } from "../src/roles/config.js";
import { roleRegistrationEdit } from "../src/roles/register.js";
import {
  APPLY_QUESTION,
  DOWNGRADE_QUESTION,
  createInstallCommand,
} from "../src/commands/install/index.js";
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
    "plugin ls": { stdout: "[]" },
    "plugin install": {
      stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }),
    },
    // The role step (bm-wp-107-2r5.4): one provider with one model, logged in.
    "provider ls": { stdout: JSON.stringify([{ provider: "claude", label: "Claude", status: "available" }]) },
    "provider models": { stdout: JSON.stringify([{ id: "claude-opus-5", model: "Opus 5" }]) },
    "provider diagnostic": { stdout: JSON.stringify({ provider: "claude", diagnostic: 'Auth: {"loggedIn": true}' }) },
  };
  writeFileSync(scriptFile, JSON.stringify({ ...base, ...overrides }));
}

/**
 * `config` plus the bm-* entries the role step would write by default for the
 * scripted catalogue, so these flow tests never write Paseo's config (the role
 * step itself is proven in test/install-roles.test.ts).
 */
function withDefaultRoles(config: Record<string, unknown>): Record<string, unknown> {
  const edit = roleRegistrationEdit(
    ROLE_NAMES.map((role) => ({
      role,
      displayName: DEFAULT_ROLE_DISPLAY_NAMES[role],
      provider: "claude",
      model: "claude-opus-5",
      paseoTools: roleGrantsPaseoTools(role),
      source: "default" as const,
    })),
  );
  const daemon = (config["daemon"] ?? {}) as Record<string, unknown>;
  return { ...config, agents: { providers: edit.providers }, daemon: { ...daemon, agentProfiles: edit.profiles } };
}

function writePaseoConfig(config: Record<string, unknown>): void {
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(join(paseoHome, "config.json"), `${JSON.stringify(withDefaultRoles(config), null, 2)}\n`);
}

/** What the role step reads from Paseo before the preview. */
const ROLE_READS = ["provider ls", "provider models"];

function writePayload(version: string): void {
  const files: Record<string, string> = {
    "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
    "index.server.ts": `export const version = "${version}";\n`,
    "roles/worker.md": "# Beads Worker\n",
  };
  for (const [path, text] of Object.entries(files)) {
    const target = join(payloadRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function calls(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

function subcommands(): string[] {
  return calls().map((argv) => argv.slice(0, 2).join(" "));
}

beforeEach(() => {
  // realpath: the guard records canonical paths.
  home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-install-cmd-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-install-cmd-log-")));
  installHome = join(home, ".paseo-bm");
  paseoHome = join(home, ".paseo");
  payloadRoot = join(outside, "package", "plugin");
  argvLog = join(outside, "argv.log");
  scriptFile = join(outside, "script.json");
  writePayload(VERSION);
  writePaseoConfig({ pluginsEnabled: true, daemon: { mcp: { injectIntoAgents: true } } });
  script();
});

afterEach(() => {
  scope?.restore();
  scope = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  out: string;
  err: string;
  prompter: ScriptedPrompter;
}

async function install(
  argv: readonly string[],
  options: { tty?: TtyInfo; confirm?: boolean[]; version?: string; guard?: boolean } = {},
): Promise<RunResult> {
  const tty = options.tty ?? NO_TTY;
  const prompter = new ScriptedPrompter({ confirm: options.confirm ?? [] }, { interactive: tty.interactive });
  let out = "";
  let err = "";
  if (options.guard !== false) {
    scope = startWriteScope({ installHome, paseoHome, watch: [home] });
  }
  const install = createInstallCommand({
    homeDir: home,
    payloadRoot,
    ...(scope === undefined ? {} : { fs: scope.fs }),
    lock: { handleSignals: false },
  });
  const handlers: CommandHandlers = {
    install,
    doctor: () => EXIT_CODES.usage,
    uninstall: () => EXIT_CODES.usage,
  };
  const code = await runCli(argv, {
    handlers,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env: { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`, BM_FAKE_ARGV_LOG: argvLog, BM_FAKE_SCRIPT: scriptFile },
    tty,
    createPrompter: () => prompter,
    version: options.version ?? VERSION,
  });
  scope?.assertNoViolations();
  return { code, out, err, prompter };
}

function json(out: string): PlanReport {
  // Exactly one document: JSON.parse fails on anything appended to it.
  return JSON.parse(out) as PlanReport;
}

function installedRecord(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(installHome, "install.json"), "utf8")) as Record<string, unknown>;
}

describe("install — interactive flow with a scripted prompter", () => {
  it("previews, asks once, applies, and registers the plugin", async () => {
    const run = await install(["install"], { tty: TTY, confirm: [true] });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION]);
    // The preview came before the question, the summary after it.
    const preview = run.out.indexOf("Planned changes");
    const summary = run.out.indexOf("Changes made");
    expect(preview).toBeGreaterThanOrEqual(0);
    expect(summary).toBeGreaterThan(preview);

    expect(existsSync(join(installHome, "plugin", VERSION, "roles", "worker.md"))).toBe(true);
    const record = installedRecord() as { version: string; paseo: { pluginId: string; pluginDir: string }; versions: { active: boolean }[] };
    expect(record.version).toBe(VERSION);
    expect(record.paseo.pluginId).toBe("paseo-bm");
    expect(record.paseo.pluginDir).toBe(join(installHome, "plugin", VERSION));
    expect(record.versions.map((entry) => entry.active)).toEqual([true]);
    expect(calls()).toContainEqual(["plugin", "install", join(installHome, "plugin", VERSION), "--id", "paseo-bm", "--json"]);
    // Every write stayed in the install home; the lock is gone again.
    expect(scope?.writes.every((write) => write.path.startsWith(installHome))).toBe(true);
    expect(existsSync(join(installHome, ".lock"))).toBe(false);
  });

  it("declining the confirmation executes zero actions: no write, no Paseo change", async () => {
    const run = await install(["install"], { tty: TTY, confirm: [false] });

    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.counts.confirm).toBe(1);
    expect(scope?.writes).toEqual([]);
    expect(existsSync(installHome)).toBe(false);
    expect(subcommands()).toEqual(["daemon status", "plugin ls", ...ROLE_READS]);
    expect(run.err).toContain("Nothing was written.");
  });

  it("--apply on a terminal still asks before writing", async () => {
    const run = await install(["install", "--apply"], { tty: TTY, confirm: [false] });
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([APPLY_QUESTION]);
    expect(scope?.writes).toEqual([]);
  });

  it("--yes skips only the apply confirmation", async () => {
    const run = await install(["install", "--apply", "--yes"], { tty: TTY });
    expect(run.code).toBe(EXIT_CODES.ok);
    // No confirmation; the role questions of a first install are not confirmations.
    expect(run.prompter.counts.confirm).toBe(0);
    expect(existsSync(join(installHome, "install.json"))).toBe(true);
  });

  it("--yes is not consent to a trust boundary: switches off ends installed with exit 4", async () => {
    writePaseoConfig({});
    // --yes skips the apply confirmation, but the trust question is still asked.
    const run = await install(["install", "--apply", "--yes"], { tty: TTY, confirm: [false] });
    expect(run.code).toBe(EXIT_CODES.consentMissing);
    expect(run.prompter.counts.confirm).toBe(1);
    expect(existsSync(join(installHome, "install.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8"))).toEqual(withDefaultRoles({}));
  });
});

describe("install — no terminal", () => {
  it("without --apply prints the preview, exits 6, and writes nothing (guard on)", async () => {
    const run = await install(["install"]);

    expect(run.code).toBe(EXIT_CODES.noTtyNoApply);
    expect(run.prompter.counts.total).toBe(0);
    expect(scope?.writes).toEqual([]);
    expect(existsSync(installHome)).toBe(false);
    expect(run.out).toContain("Planned changes");
    expect(subcommands()).toEqual(["daemon status", "plugin ls", ...ROLE_READS]);
  });

  it("a bare `paseo-bm` behaves the same", async () => {
    const run = await install([]);
    expect(run.code).toBe(EXIT_CODES.noTtyNoApply);
    expect(scope?.writes).toEqual([]);
  });

  it("--json preview is exactly one document with mode preview and no error", async () => {
    const run = await install(["install", "--json"]);
    const report = json(run.out);
    expect(run.code).toBe(EXIT_CODES.noTtyNoApply);
    expect(report.mode).toBe("preview");
    expect(report.result.exitCode).toBe(EXIT_CODES.noTtyNoApply);
    expect("error" in report.result).toBe(false);
    expect(report.actions.some((action) => action.kind === "create")).toBe(true);
  });

  it("--apply --json applies and prints one document", async () => {
    const run = await install(["install", "--apply", "--json"]);
    const report = json(run.out);
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(report.mode).toBe("applied");
    expect(report.result.pluginState).toBe("running");
    expect("error" in report.result).toBe(false);
  });

  it("--json on a terminal never prompts", async () => {
    const run = await install(["install", "--json"], { tty: TTY });
    expect(run.prompter.counts.total).toBe(0);
    expect(json(run.out).result.exitCode).toBe(EXIT_CODES.noTtyNoApply);
    expect(scope?.writes).toEqual([]);
  });
});

describe("install — failures carry their registry code and exit code", () => {
  it("preflight failure: exit 3, result.error, nothing written", async () => {
    script({ "daemon status": { exit: 1, stderr: "daemon is not running\n" } });
    const run = await install(["install", "--apply", "--json"]);
    const report = json(run.out);
    expect(run.code).toBe(EXIT_CODES.preflight);
    expect(report.result.error?.code).toBe("E_DAEMON_UNREACHABLE");
    expect(scope?.writes).toEqual([]);
  });

  it("an unsafe install home: exit 3 with E_UNSAFE_INSTALL_HOME", async () => {
    const run = await install(["install", "--apply", "--json", "--home", join(home, ".paseo")]);
    expect(run.code).toBe(EXIT_CODES.preflight);
    expect(json(run.out).result.error?.code).toBe("E_UNSAFE_INSTALL_HOME");
    expect(scope?.writes).toEqual([]);
  });

  it("Paseo cannot install the plugin: exit 7 with E_PLUGIN_LOAD_FAILED, payload kept", async () => {
    script({ "plugin install": { exit: 1, stderr: "manifest invalid\n" } });
    const run = await install(["install", "--apply", "--json"]);
    const report = json(run.out);
    expect(run.code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(report.mode).toBe("applied");
    expect(report.result.error?.code).toBe("E_PLUGIN_LOAD_FAILED");
    expect(existsSync(join(installHome, "plugin", VERSION, "index.server.ts"))).toBe(true);
    expect(run.err).toContain("paseo plugin logs paseo-bm");
  });

  it("another live run holds the lock: exit 3 with E_LOCKED", async () => {
    mkdirSync(installHome, { recursive: true });
    writeFileSync(
      join(installHome, ".lock"),
      JSON.stringify({ pid: process.ppid, acquiredAt: "2026-09-15T00:00:00Z", hostname: hostname(), command: "install" }),
    );
    const run = await install(["install", "--apply", "--json"]);
    expect(run.code).toBe(EXIT_CODES.preflight);
    expect(json(run.out).result.error?.code).toBe("E_LOCKED");
    expect(existsSync(join(installHome, "install.json"))).toBe(false);
  });

  it("a payload with no install record in the way: exit 5 with E_CONFLICT and a way out", async () => {
    mkdirSync(join(installHome, "plugin", VERSION), { recursive: true });
    writeFileSync(join(installHome, "plugin", VERSION, "index.server.ts"), "// someone else's\n");
    const run = await install(["install", "--apply", "--json"]);
    expect(run.code).toBe(EXIT_CODES.conflict);
    expect(json(run.out).result.error?.code).toBe("E_CONFLICT");
    expect(run.err).toContain(`plugin/${VERSION}/`);
    expect(run.err).toContain("delete that directory yourself");
    expect(readFileSync(join(installHome, "plugin", VERSION, "index.server.ts"), "utf8")).toBe("// someone else's\n");
  });
});

describe("install — situations that need an explicit answer", () => {
  function seedInstalled(version: string): void {
    const record = createRecord({ version, installHome, paseo: { home: paseoHome }, at: new Date("2026-09-01T00:00:00Z") });
    mkdirSync(installHome, { recursive: true });
    writeFileSync(join(installHome, "install.json"), serializeRecord(record), { mode: 0o600 });
  }

  it("a downgrade asks explicitly even with --yes, and No writes nothing", async () => {
    seedInstalled("9.0.0");
    const before = readFileSync(join(installHome, "install.json"), "utf8");
    const run = await install(["install", "--apply", "--yes"], { tty: TTY, confirm: [false] });
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([DOWNGRADE_QUESTION]);
    expect(scope?.writes).toEqual([]);
    expect(readFileSync(join(installHome, "install.json"), "utf8")).toBe(before);
  });

  it("a downgrade answered yes, then confirmed, is applied", async () => {
    seedInstalled("9.0.0");
    const run = await install(["install"], { tty: TTY, confirm: [true, true] });
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(run.prompter.confirmMessages).toEqual([DOWNGRADE_QUESTION, APPLY_QUESTION]);
    expect((installedRecord() as { version: string }).version).toBe(VERSION);
  });

  it("a downgrade without a terminal stops with exit 5 and writes nothing", async () => {
    seedInstalled("9.0.0");
    const run = await install(["install", "--apply", "--yes"]);
    expect(run.code).toBe(EXIT_CODES.conflict);
    expect(scope?.writes).toEqual([]);
  });

  it("an update between two prereleases without a terminal is an upgrade: exit 0, side by side (bm-d3q)", async () => {
    const previous = "0.1.0-alpha.0";
    const next = "0.1.0-alpha.1";
    writePayload(previous);
    script({
      "plugin install": {
        stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", previous), enabled: true, status: "running" }),
      },
    });
    const first = await install(["install", "--apply", "--yes", "--skip-skills-check", "--json"], { version: previous, guard: false });
    expect(first.code).toBe(EXIT_CODES.ok);

    writePayload(next);
    script({
      "plugin ls": {
        stdout: JSON.stringify([{ id: "paseo-bm", path: join(installHome, "plugin", previous), enabled: true, status: "running" }]),
      },
      "plugin install": {
        stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", next), enabled: true, status: "running" }),
      },
    });
    const run = await install(["install", "--apply", "--yes", "--skip-skills-check", "--json"], { version: next });
    const report = json(run.out);
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(report.mode).toBe("applied");
    expect("error" in report.result).toBe(false);
    expect(run.prompter.counts.total).toBe(0);
    expect(existsSync(join(installHome, "plugin", previous, "index.server.ts"))).toBe(true);
    expect(existsSync(join(installHome, "plugin", next, "index.server.ts"))).toBe(true);
    const record = installedRecord() as { version: string; versions: { version: string; active: boolean }[] };
    expect(record.version).toBe(next);
    expect(record.versions).toHaveLength(2);
    expect(record.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: previous, active: false }),
        expect.objectContaining({ version: next, active: true }),
      ]),
    );
  });

  it("--apply removes a partial payload of the same version before planning", async () => {
    seedInstalled("0.1.0");
    mkdirSync(join(installHome, "plugin", VERSION), { recursive: true });
    writeFileSync(join(installHome, "plugin", VERSION, "index.server.ts"), "// half written\n");

    const preview = await install(["install"]);
    expect(preview.code).toBe(EXIT_CODES.noTtyNoApply);
    expect(preview.err).toContain(`plugin/${VERSION}`);
    scope?.restore();
    scope = undefined;

    const run = await install(["install", "--apply"]);
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(readFileSync(join(installHome, "plugin", VERSION, "index.server.ts"), "utf8")).toBe(
      `export const version = "${VERSION}";\n`,
    );
  });

  it("a second --apply of the same version does not register the plugin again", async () => {
    script({
      "plugin ls": {
        stdout: JSON.stringify([{ id: "paseo-bm", path: join(installHome, "plugin", VERSION), enabled: true, status: "running" }]),
      },
    });
    await install(["install", "--apply"], { guard: false });
    rmSync(argvLog, { force: true });
    const run = await install(["install", "--apply", "--json"]);
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(subcommands()).not.toContain("plugin install");
    expect(json(run.out).actions.filter((action) => action.kind !== "skip")).toEqual([]);
  });
});

describe("install --prune", () => {
  it("runs after registration, keeps the version just installed, removes the old one", async () => {
    // First install 0.1.0 as the active version.
    writePayload("0.1.0");
    script({
      "plugin install": {
        stdout: JSON.stringify({ id: "paseo-bm", path: join(installHome, "plugin", "0.1.0"), enabled: true, status: "running" }),
      },
    });
    await install(["install", "--apply"], { version: "0.1.0", guard: false });
    expect(existsSync(join(installHome, "plugin", "0.1.0"))).toBe(true);

    writePayload(VERSION);
    script({
      "plugin ls": {
        stdout: JSON.stringify([{ id: "paseo-bm", path: join(installHome, "plugin", "0.1.0"), enabled: true, status: "running" }]),
      },
    });
    const preview = await install(["install", "--prune", "--json"]);
    expect(json(preview.out).actions).toContainEqual(expect.objectContaining({ kind: "delete", target: "installHome/plugin/0.1.0" }));
    expect(existsSync(join(installHome, "plugin", "0.1.0"))).toBe(true);
    scope?.restore();
    scope = undefined;

    const run = await install(["install", "--apply", "--prune"]);
    expect(run.code).toBe(EXIT_CODES.ok);
    expect(existsSync(join(installHome, "plugin", "0.1.0"))).toBe(false);
    expect(existsSync(join(installHome, "plugin", VERSION, "index.server.ts"))).toBe(true);
    const record = installedRecord() as { versions: { version: string; active: boolean }[] };
    expect(record.versions).toEqual([expect.objectContaining({ version: VERSION, active: true })]);
  });
});
