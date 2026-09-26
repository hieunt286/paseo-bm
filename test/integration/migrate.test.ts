/**
 * `paseo-bm migrate` end to end (WP-406, design §4.3–§4.6).
 *
 * A fake `$HOME`, a fake `paseo` on PATH driven by a state file that behaves
 * like a real daemon's plugin catalogue, and the real command. The properties
 * under test are the ones a user cannot check afterwards:
 *
 * - the ORDER of writes — the pointer and the carry-over before Paseo, the
 *   `install.json` mark last and only on success;
 * - that a failure puts the directory install back and leaves the record at
 *   `schemaVersion: 1`, so a rerun still works;
 * - that nothing is deleted: traces, `ui/`, `role-*.json`, `plugin/` and
 *   `backups/` are all still there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { MigrateReport } from "../../src/action.js";
import type { CommandContext } from "../../src/cli.js";
import { EXIT_CODES } from "../../src/exit-codes.js";
import { homeFlagOverrides, parseCommandLine } from "../../src/flags.js";
import { createPaseoAdapter, type PaseoAdapter } from "../../src/paseo/adapter.js";
import { ScriptedPrompter } from "../../src/prompter.js";
import { PLUGIN_ADD_TIMEOUT_MS, createMigrateCommand, migrate, type MigrateResult } from "../../src/commands/migrate.js";
import { FAKE_DIR, NO_TTY, TTY, createFixture, removeFixture, writeScript, type Fixture } from "../helpers/migrate-harness.js";
import { startWriteScope } from "../helpers/write-scope.js";

vi.setConfig({ testTimeout: 60_000 });

const VERSION = "0.4.0";
const PLUGIN_VERSION = "0.3.1";
let fixture: Fixture;
let stateFile: string;

beforeEach(() => {
  fixture = createFixture("migrate");
  stateFile = join(fixture.outside, "daemon-state.json");
  writeScript(fixture, PLUGIN_VERSION);
  mkdirSync(fixture.paseoHome, { recursive: true });
  writeFileSync(join(fixture.paseoHome, "config.json"), "{}\n");
});

afterEach(() => {
  removeFixture(fixture);
});

/** The daemon's plugin catalogue, as the fake `paseo` reads and writes it. */
function daemonState(plugins: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writeFileSync(stateFile, JSON.stringify({ plugins, ...extra }, null, 2));
}

const directoryPlugin = (path: string, identity?: Record<string, unknown>) => ({
  path,
  status: "running",
  ...(identity === undefined ? {} : { identity }),
});

/** A 0.3.x install: the payload under `plugin/<ver>`, a record, and some data. */
function seedDirectoryInstall(options: { installHome?: string; setByUs?: boolean; previous?: boolean } = {}): string {
  const installHome = options.installHome ?? fixture.installHome;
  const pluginDir = join(installHome, "plugin", PLUGIN_VERSION);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "index.server.ts"), "// payload\n");
  mkdirSync(join(installHome, "traces", "wks_1"), { recursive: true });
  writeFileSync(join(installHome, "traces", "wks_1", "events.jsonl"), "{}\n");
  writeFileSync(join(installHome, "role-extras.json"), JSON.stringify({ version: 1, roles: {} }));
  mkdirSync(join(installHome, "backups", "20260101T000000Z"), { recursive: true });

  writeFileSync(
    join(installHome, "install.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: PLUGIN_VERSION,
        installedAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
        installHome,
        paseo: {
          home: fixture.paseoHome,
          pluginId: "paseo-bm",
          pluginDir,
          pluginsEnabledSetByUs: true,
          mcpInject: {
            setByUs: options.setByUs ?? false,
            previous: { present: options.previous !== undefined, value: options.previous ?? null },
          },
        },
        roles: [],
        files: [],
        versions: [{ version: PLUGIN_VERSION, dir: `plugin/${PLUGIN_VERSION}`, installedAt: "2026-09-01T00:00:00.000Z", active: true }],
        backups: [],
        skills: { agents: ["claude"], lastStatus: [], assistDeclinedAt: null, lastCommand: null, assistOutcome: null },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return pluginDir;
}

interface RunOptions {
  argv?: readonly string[];
  tty?: typeof TTY;
  answers?: { confirm?: boolean[] };
  homeDir?: string;
  /** Wrapped in the deadline test, to record what each call asked for. */
  adapter?: PaseoAdapter;
}

/** Runs the real command against the fake daemon, and returns its result and output. */
async function run(options: RunOptions = {}): Promise<{ result: MigrateResult; out: string; code: number }> {
  const argv = options.argv ?? ["migrate", "--apply"];
  const parsed = parseCommandLine(argv);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const tty = options.tty ?? NO_TTY;
  const prompter = new ScriptedPrompter(options.answers ?? {}, { interactive: tty.interactive });
  const env: Record<string, string> = {
    PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`,
    BM_FAKE_ARGV_LOG: fixture.argvLog,
    BM_FAKE_SCRIPT: fixture.scriptFile,
    BM_FAKE_STATE: stateFile,
  };
  let out = "";
  const context: CommandContext = {
    command: parsed.parsed.command,
    explicitCommand: parsed.parsed.explicitCommand,
    flags: parsed.parsed.flags,
    homes: homeFlagOverrides(parsed.parsed.flags),
    tty,
    prompter,
    stdout: (text) => {
      out += text;
    },
    stderr: () => undefined,
    env,
    version: VERSION,
  };
  const adapter = options.adapter ?? createPaseoAdapter({ env });
  const result = await migrate(context, {
    adapter,
    homeDir: options.homeDir ?? fixture.home,
    now: () => new Date("2026-09-26T00:00:00.000Z"),
    sleep: async () => undefined,
    handleSignals: false,
  });
  await prompter.close();
  return { result, out, code: result.exitCode };
}

const record = (installHome = fixture.installHome): Record<string, unknown> =>
  JSON.parse(readFileSync(join(installHome, "install.json"), "utf8")) as Record<string, unknown>;

const plugins = (): Record<string, { path: string; status: string }> =>
  (JSON.parse(readFileSync(stateFile, "utf8")) as { plugins: Record<string, { path: string; status: string }> }).plugins;

// ── case A: the one that actually migrates ─────────────────────────────────

describe("case A — a directory install paseo-bm made", () => {
  it("switches it to npm and marks the record last", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.ok);
    expect(result.outcome).toBe("migrated");
    expect(plugins()["paseo-bm"]?.path).toBe(`npm:paseo-bm-plugin@${VERSION}`);
    expect(record()).toMatchObject({
      schemaVersion: 2,
      migratedTo: { source: "npm", package: "paseo-bm-plugin", version: VERSION, at: "2026-09-26T00:00:00.000Z" },
    });
  });

  it("keeps every byte of the user's data, and the old payload", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    await run();

    for (const kept of [
      join(fixture.installHome, "traces", "wks_1", "events.jsonl"),
      join(fixture.installHome, "role-extras.json"),
      join(pluginDir, "index.server.ts"),
      join(fixture.installHome, "backups", "20260101T000000Z"),
    ]) {
      expect(existsSync(kept), kept).toBe(true);
    }
  });

  it("writes no pointer when the data folder is the default one", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    await run();

    expect(existsSync(join(fixture.installHome, "home.json"))).toBe(false);
  });

  it("writes the pointer when the install home is somewhere else", async () => {
    const custom = join(fixture.home, "custom-bm");
    const pluginDir = seedDirectoryInstall({ installHome: custom });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { code } = await run({ argv: ["migrate", "--apply", `--home=${custom}`] });

    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(readFileSync(join(fixture.installHome, "home.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      home: custom,
      writtenBy: `paseo-bm@${VERSION}`,
      at: "2026-09-26T00:00:00.000Z",
    });
    expect(record(custom)).toMatchObject({ schemaVersion: 2 });
  });

  it("carries the agent-tools switch over only when paseo-bm turned it on", async () => {
    const pluginDir = seedDirectoryInstall({ setByUs: true, previous: false });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    await run();

    expect(JSON.parse(readFileSync(join(fixture.installHome, "ui", "setup-state.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      agentTools: { setBy: "installer", previous: false, at: "2026-09-26T00:00:00.000Z" },
    });
  });

  it("carries nothing over when the switch was not paseo-bm's", async () => {
    const pluginDir = seedDirectoryInstall({ setByUs: false });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    await run();

    expect(existsSync(join(fixture.installHome, "ui", "setup-state.json"))).toBe(false);
  });

  it("does not overwrite an agentTools mark the plugin already wrote", async () => {
    const pluginDir = seedDirectoryInstall({ setByUs: true, previous: true });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });
    mkdirSync(join(fixture.installHome, "ui"), { recursive: true });
    const mine = JSON.stringify({ schemaVersion: 1, agentTools: { setBy: "plugin", previous: false, at: "2026-09-20T00:00:00.000Z" } });
    writeFileSync(join(fixture.installHome, "ui", "setup-state.json"), mine);

    await run();

    expect(readFileSync(join(fixture.installHome, "ui", "setup-state.json"), "utf8")).toBe(mine);
  });

  it("a second run is case B and changes nothing more", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });
    await run();
    const after = record();

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.ok);
    expect(result.outcome).toBe("already-npm");
    expect(record()).toEqual(after);
  });
});

// ── the other four cases ───────────────────────────────────────────────────

describe("case B — Paseo already loads the npm plugin", () => {
  it("only brings the record up to date", async () => {
    seedDirectoryInstall();
    daemonState({
      "paseo-bm": { path: "npm:paseo-bm-plugin@0.4.0", status: "running", identity: { kind: "npm", packageName: "paseo-bm-plugin", pluginPath: "." } },
    });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.ok);
    expect(result.outcome).toBe("already-npm");
    expect(record()).toMatchObject({ schemaVersion: 2 });
    // No Paseo write at all.
    expect(plugins()["paseo-bm"]?.path).toBe("npm:paseo-bm-plugin@0.4.0");
  });
});

describe("case C — a directory install somewhere else", () => {
  it("changes nothing and points at --home", async () => {
    seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(join(fixture.outside, "someone-elses-plugin")) });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.conflict);
    expect(result.outcome).toBe("not-ours");
    expect(result.plan.reason).toContain("--home <dir>");
    expect(record()).toMatchObject({ schemaVersion: 1 });
  });

  it("treats a directory inside the install home with no install.json the same way", async () => {
    const pluginDir = join(fixture.installHome, "plugin", PLUGIN_VERSION);
    mkdirSync(pluginDir, { recursive: true });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.conflict);
    expect(result.plan.reason).toContain("no install.json");
  });
});

describe("case D — Paseo has no paseo-bm plugin", () => {
  it("prints how to install it and changes nothing", async () => {
    daemonState({});

    const { result, out, code } = await run();

    expect(code).toBe(EXIT_CODES.ok);
    expect(result.outcome).toBe("no-directory-install");
    expect(out).toContain("paseo plugin add npm:paseo-bm-plugin");
    expect(existsSync(join(fixture.installHome, "install.json"))).toBe(false);
  });

  it("says the existing data will be used when there is some", async () => {
    seedDirectoryInstall();
    daemonState({});

    const { out } = await run();

    expect(out).toContain("will be used by it");
    expect(record()).toMatchObject({ schemaVersion: 1 });
  });
});

describe("case E — something paseo-bm did not install", () => {
  it("refuses an npm plugin from another package", async () => {
    seedDirectoryInstall();
    daemonState({
      "paseo-bm": { path: "npm:someone-else", status: "running", identity: { kind: "npm", packageName: "someone-else", pluginPath: "." } },
    });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.conflict);
    expect(result.plan.reason).toContain("someone-else");
  });

  it("refuses to migrate twice", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });
    await run();
    // Paseo shows a directory install again, but the record says we are done.
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.conflict);
    expect(result.plan.reason).toContain("already switched once");
  });
});

// ── failures ───────────────────────────────────────────────────────────────

describe("when Paseo will not cooperate", () => {
  it("stops before anything else when the remove fails", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) }, { removeFailures: { "paseo-bm": "the daemon is busy" } });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(result.outcome).toBe("remove-failed");
    expect(result.error).toContain("the daemon is busy");
    expect(result.error).toContain("Nothing was changed");
    // Paseo still has the old plugin, and the record is untouched.
    expect(plugins()["paseo-bm"]?.path).toBe(pluginDir);
    expect(record()).toMatchObject({ schemaVersion: 1 });
  });

  it("refuses to run while another paseo-bm holds the install home", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });
    // A holder that is really alive and is not this process: pid 1 always is,
    // and a lock left by a dead run is reclaimed rather than refused.
    writeFileSync(
      join(fixture.installHome, ".lock"),
      JSON.stringify({ pid: 1, hostname: hostname(), acquiredAt: "2026-09-26T00:00:00.000Z", command: "install" }),
    );

    const { result, code } = await run();
    expect(code).toBe(EXIT_CODES.preflight);
    expect(result.error).toContain("install");
    expect(record()).toMatchObject({ schemaVersion: 1 });
    expect(plugins()["paseo-bm"]?.path).toBe(pluginDir);
  });

  it("puts the directory install back when the npm one will not load", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) }, { addFailures: { [`npm:paseo-bm-plugin@${VERSION}`]: "the package could not be resolved" } });

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(result.outcome).toBe("fell-back");
    expect(result.fallback).toMatchObject({ outcome: "fell-back" });
    expect(plugins()["paseo-bm"]?.path).toBe(pluginDir);
    // The record is untouched, so the user can simply run it again.
    expect(record()).toMatchObject({ schemaVersion: 1 });
    expect(record()).not.toHaveProperty("migratedTo");
  });

  it("says what to run by hand when even the fallback fails", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState(
      { "paseo-bm": directoryPlugin(pluginDir) },
      {
        addFailures: { [`npm:paseo-bm-plugin@${VERSION}`]: "the package could not be resolved" },
        installFailures: { [pluginDir]: "the payload is gone" },
      },
    );

    const { result, code } = await run();

    expect(code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(result.outcome).toBe("fallback-failed");
    expect(result.error).toContain(`paseo plugin install ${pluginDir} --id paseo-bm`);
    expect(record()).toMatchObject({ schemaVersion: 1 });
  });
});

// ── asking, previewing and reporting ───────────────────────────────────────

describe("what it asks before it writes", () => {
  it("prints the preview and exits 6 without a terminal and without --apply", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { out, code } = await run({ argv: ["migrate"] });

    expect(code).toBe(EXIT_CODES.noTtyNoApply);
    expect(out).toContain("This will:");
    expect(out).toContain("agents keep running");
    expect(record()).toMatchObject({ schemaVersion: 1 });
    expect(plugins()["paseo-bm"]?.path).toBe(pluginDir);
  });

  it("asks on a terminal, and a No writes nothing", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { out, code } = await run({ argv: ["migrate", "--apply"], tty: TTY, answers: { confirm: [false] } });

    expect(code).toBe(EXIT_CODES.ok);
    expect(out).toContain("Nothing was changed.");
    expect(record()).toMatchObject({ schemaVersion: 1 });
    expect(plugins()["paseo-bm"]?.path).toBe(pluginDir);
  });

  it("a Yes on a terminal migrates", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { code } = await run({ argv: ["migrate", "--apply"], tty: TTY, answers: { confirm: [true] } });

    expect(code).toBe(EXIT_CODES.ok);
    expect(record()).toMatchObject({ schemaVersion: 2 });
  });
});

describe("what a failure looks like without --json", () => {
  /** Runs the real handler, so the command's own reporting is what is tested. */
  async function handle(
    argv: readonly string[],
    options: { scriptOnly?: boolean } = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const parsed = parseCommandLine(argv);
    if (!parsed.ok) throw new Error(parsed.error.message);
    let out = "";
    let err = "";
    const env: Record<string, string> = {
      PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`,
      BM_FAKE_SCRIPT: fixture.scriptFile,
      // The state file answers `plugin ls` ahead of the script, so a test that
      // wants the script's answer (a broken `plugin ls`) leaves it out.
      ...(options.scriptOnly === true ? {} : { BM_FAKE_STATE: stateFile }),
    };
    const handler = createMigrateCommand({
      adapter: createPaseoAdapter({ env }),
      homeDir: fixture.home,
      now: () => new Date("2026-09-26T00:00:00.000Z"),
      sleep: async () => undefined,
      handleSignals: false,
    });
    const code = await handler({
      command: parsed.parsed.command,
      explicitCommand: parsed.parsed.explicitCommand,
      flags: parsed.parsed.flags,
      homes: homeFlagOverrides(parsed.parsed.flags),
      tty: NO_TTY,
      prompter: new ScriptedPrompter({}, { interactive: false }),
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env,
      version: VERSION,
    });
    return { code, out, err };
  }

  // Review b1: the message only ever reached `writeJsonReport`, so a terminal
  // user got an empty stdout, an empty stderr and a bare exit code.
  it("says why it refused a plugin paseo-bm did not install", async () => {
    seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(join(fixture.outside, "someone-elses-plugin")) });

    const { code, err } = await handle(["migrate", "--apply"]);

    expect(code).toBe(EXIT_CODES.conflict);
    expect(err).toContain("E_CONFLICT");
    expect(err).toContain("--home <dir>");
  });

  it("passes Paseo's own reason through when the remove fails", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) }, { removeFailures: { "paseo-bm": "the daemon is busy" } });

    const { code, err } = await handle(["migrate", "--apply"]);

    expect(code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(err).toContain("E_PLUGIN_LOAD_FAILED");
    expect(err).toContain("the daemon is busy");
  });

  it("prints the two commands to run by hand when even the fallback failed", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState(
      { "paseo-bm": directoryPlugin(pluginDir) },
      {
        addFailures: { [`npm:paseo-bm-plugin@${VERSION}`]: "the package could not be resolved" },
        installFailures: { [pluginDir]: "the payload is gone" },
      },
    );

    const { code, err } = await handle(["migrate", "--apply"]);

    expect(code).toBe(EXIT_CODES.pluginLoadFailed);
    expect(err).toContain(`paseo plugin install ${pluginDir} --id paseo-bm`);
    expect(err).toContain("paseo plugin logs paseo-bm");
  });

  // Design §4.3: a failed `plugin ls` reports the PaseoCliError's own code, not
  // one invented from the outcome — "the daemon did not answer" and "we refuse
  // to touch someone else's plugin" are different problems.
  it("reports the daemon's own code when Paseo itself failed", async () => {
    seedDirectoryInstall();
    writeFileSync(
      fixture.scriptFile,
      JSON.stringify({
        "daemon status": { stdout: JSON.stringify({ home: fixture.paseoHome, cliVersion: "0.9.2", daemonVersion: "0.9.2" }) },
        "plugin ls": { stdout: "not json at all", exit: 0 },
      }),
    );

    const { code, err } = await handle(["migrate", "--apply"], { scriptOnly: true });

    expect(code).toBe(EXIT_CODES.preflight);
    expect(err).toContain("E_PASEO_OUTPUT_UNEXPECTED");
    expect(err).not.toContain("E_CONFLICT");
  });

  it("reports a daemon it cannot reach as such, not as a conflict", async () => {
    seedDirectoryInstall();
    writeFileSync(
      fixture.scriptFile,
      JSON.stringify({ "daemon status": { stdout: "", stderr: "connection refused", exit: 1 } }),
    );

    const { code, err } = await handle(["migrate", "--apply"], { scriptOnly: true });

    expect(code).toBe(EXIT_CODES.preflight);
    expect(err).toContain("E_DAEMON_UNREACHABLE");
    expect(err).not.toContain("E_CONFLICT");
  });

  it("says nothing on stderr when the run succeeded", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const { code, out, err } = await handle(["migrate", "--apply"]);

    expect(code).toBe(EXIT_CODES.ok);
    expect(err).toBe("");
    expect(out).toContain("Switched `paseo-bm`");
  });
});

describe("the deadline of `plugin add`", () => {
  // Review b1: the call ran on the adapter's 15 s budget while Paseo runs a
  // real npm install, so a normal network was enough to kill it and send the
  // run down the fallback — failing the one thing 0.4.0 does.
  it("gives the npm install 120 seconds, not the adapter's 15", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });
    const seen: Array<{ args: readonly string[]; timeoutMs: number | undefined }> = [];
    const base = createPaseoAdapter({
      env: { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`, BM_FAKE_SCRIPT: fixture.scriptFile, BM_FAKE_STATE: stateFile },
    });
    const adapter = {
      ...base,
      run: (args: readonly string[], options?: { timeoutMs?: number }) => {
        seen.push({ args, timeoutMs: options?.timeoutMs });
        return base.run(args, options);
      },
    };

    await run({ adapter });

    const add = seen.find((call) => call.args[1] === "add");
    expect(add, "the add was never called").toBeDefined();
    expect(add?.timeoutMs).toBe(PLUGIN_ADD_TIMEOUT_MS);
    expect(PLUGIN_ADD_TIMEOUT_MS).toBe(120_000);
    // Everything else keeps the adapter's own deadline.
    for (const call of seen.filter((entry) => entry.args[1] !== "add")) {
      expect(call.timeoutMs).toBeUndefined();
    }
  });
});

describe("--json", () => {
  it("writes exactly one document, with the migration block", async () => {
    const pluginDir = seedDirectoryInstall();
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });
    const parsed = parseCommandLine(["migrate", "--apply", "--json"]);
    if (!parsed.ok) throw new Error(parsed.error.message);
    let out = "";
    const env: Record<string, string> = {
      PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`,
      BM_FAKE_SCRIPT: fixture.scriptFile,
      BM_FAKE_STATE: stateFile,
    };
    const handler = createMigrateCommand({
      adapter: createPaseoAdapter({ env }),
      homeDir: fixture.home,
      now: () => new Date("2026-09-26T00:00:00.000Z"),
      sleep: async () => undefined,
    });

    const code = await handler({
      command: "migrate",
      explicitCommand: true,
      flags: parsed.parsed.flags,
      homes: homeFlagOverrides(parsed.parsed.flags),
      tty: NO_TTY,
      prompter: new ScriptedPrompter({}, { interactive: false }),
      stdout: (text) => {
        out += text;
      },
      stderr: () => undefined,
      env,
      version: VERSION,
    });

    expect(code).toBe(EXIT_CODES.ok);
    const document = JSON.parse(out) as MigrateReport & { migration: Record<string, unknown> };
    expect(document.schemaVersion).toBe(1);
    expect(document.command).toBe("migrate");
    expect(document.paseoBmVersion).toBe(VERSION);
    expect(document.paseo.daemonVersion).toBe("0.9.2");
    expect(document.migration).toMatchObject({
      outcome: "migrated",
      from: pluginDir,
      to: `npm:paseo-bm-plugin@${VERSION}`,
      fallback: null,
    });
    expect(document.actions.some((action) => action.kind === "plugin")).toBe(true);
    expect(document.result).toMatchObject({ exitCode: 0 });
    expect(document.result).not.toHaveProperty("error");
  });
});

describe("what it touches, and in what order", () => {
  it("writes only the three files it names, and stamps the record last", async () => {
    const custom = join(fixture.home, "custom-bm");
    const pluginDir = seedDirectoryInstall({ installHome: custom, setByUs: true, previous: false });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    const scope = startWriteScope({
      installHome: custom,
      paseoHome: fixture.paseoHome,
      watch: [fixture.home],
      mode: "record",
    });
    let code: number;
    try {
      ({ code } = await run({ argv: ["migrate", "--apply", `--home=${custom}`] }));
    } finally {
      scope.restore();
    }

    expect(code).toBe(EXIT_CODES.ok);

    // Exactly the three destinations plus the lock, and nothing else anywhere
    // under the home. The lock is `<install home>/.lock`, the same file a 0.3.x
    // run took, and it is released before the process ends.
    const written = scope
      .paths()
      .filter((path) => !path.includes(".tmp"))
      .filter((path) => path !== custom && path !== join(custom, "ui") && path !== fixture.installHome);
    expect(written.sort()).toEqual(
      [
        join(custom, ".lock"),
        join(custom, "install.json"),
        join(custom, "ui", "setup-state.json"),
        join(fixture.installHome, "home.json"),
      ].sort(),
    );
    expect(existsSync(join(custom, ".lock"))).toBe(false);

    // And the order: both step-0 files before the record, which is the point —
    // a record stamped first would strand the user on a build that refuses to
    // help them (design §4.5).
    const order = scope.writes.map((write) => write.path).filter((path) => !path.includes(".tmp"));
    expect(order.indexOf(join(fixture.installHome, "home.json"))).toBeLessThan(order.lastIndexOf(join(custom, "install.json")));
    expect(order.indexOf(join(custom, "ui", "setup-state.json"))).toBeLessThan(order.lastIndexOf(join(custom, "install.json")));
  });

  it("calls Paseo between the step-0 files and the record", async () => {
    const pluginDir = seedDirectoryInstall({ setByUs: true, previous: false });
    daemonState({ "paseo-bm": directoryPlugin(pluginDir) });

    await run();

    const calls = readFileSync(fixture.argvLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv.slice(0, 2).join(" "));

    // `plugin remove` then `plugin add`, and nothing that restarts the daemon.
    expect(calls).toContain("plugin remove");
    expect(calls).toContain("plugin add");
    expect(calls.indexOf("plugin remove")).toBeLessThan(calls.indexOf("plugin add"));
    expect(calls.some((call) => call.startsWith("daemon restart") || call.startsWith("daemon stop"))).toBe(false);
  });
});
