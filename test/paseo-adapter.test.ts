import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PASEO_CALL_TIMEOUT_MS,
  PaseoCliError,
  createPaseoAdapter,
  isPaseoCliError,
  isPluginRunning,
  parsePluginSummary,
} from "../src/paseo/adapter.js";
import type { PaseoAdapter } from "../src/paseo/adapter.js";

/**
 * Everything here runs against the fake CLI in `test/fakes/paseo`, never
 * against a real `paseo`: no daemon is contacted, no plugin is installed and
 * `~/.paseo` is never read or written.
 */
const FAKE_DIR = fileURLToPath(new URL("./fakes/", import.meta.url));
const FAKE_PASEO = join(FAKE_DIR, "paseo");
const ADAPTER_SOURCE = fileURLToPath(new URL("../src/paseo/adapter.ts", import.meta.url));

const temporaryDirs: string[] = [];

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-bm-adapter-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface FakeScript {
  /** JSON (or not) the fake prints on stdout. */
  stdout?: string;
  stderr?: string;
  exit?: number;
  mode?: "ok" | "hang" | "hang-ignore-term";
  /** File the fake creates when it starts, so a test can prove it ran. */
  touch?: string;
  pidFile?: string;
  argvLog?: string;
  /** PATH for the child; defaults to the fake's own directory only. */
  path?: string;
}

function fakeEnv(script: FakeScript): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Node itself must stay reachable: the fake starts with `#!/usr/bin/env node`.
    PATH: script.path ?? `${FAKE_DIR}:${process.env["PATH"] ?? ""}`,
  };
  if (script.stdout !== undefined) env["BM_FAKE_STDOUT"] = script.stdout;
  if (script.stderr !== undefined) env["BM_FAKE_STDERR"] = script.stderr;
  if (script.exit !== undefined) env["BM_FAKE_EXIT"] = String(script.exit);
  if (script.mode !== undefined) env["BM_FAKE_MODE"] = script.mode;
  if (script.touch !== undefined) env["BM_FAKE_TOUCH"] = script.touch;
  if (script.pidFile !== undefined) env["BM_FAKE_PID_FILE"] = script.pidFile;
  if (script.argvLog !== undefined) env["BM_FAKE_ARGV_LOG"] = script.argvLog;
  return env;
}

/** Adapter wired to the fake CLI by absolute path. */
function adapterFor(script: FakeScript, options: { timeoutMs?: number; killGraceMs?: number } = {}): PaseoAdapter {
  return createPaseoAdapter({
    executable: FAKE_PASEO,
    env: fakeEnv(script),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });
}

interface RecordedCall {
  readonly argv: string[];
  readonly argc: number;
}

function readArgvLog(path: string): RecordedCall[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedCall);
}

/** Catch the adapter's own error type without letting a different failure pass. */
async function expectPaseoError(run: () => Promise<unknown>): Promise<PaseoCliError> {
  try {
    await run();
  } catch (error) {
    expect(isPaseoCliError(error), `not a PaseoCliError: ${String(error)}`).toBe(true);
    return error as PaseoCliError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const STATUS_JSON = JSON.stringify({
  home: "/Users/someone/.paseo",
  cliVersion: "0.8.0",
  daemonVersion: "0.8.0",
  listen: "127.0.0.1:7777",
  localDaemon: true,
  connectedDaemon: true,
});

describe("argument vector, no command interpreter", () => {
  it("passes every argument as one array element, so metacharacters stay data", async () => {
    const dir = workDir();
    const argvLog = join(dir, "argv.log");
    const sentinel = join(dir, "injected-semicolon");
    const substitution = join(dir, "injected-substitution");
    // A directory name that a command interpreter would tear apart, and that
    // would run two extra commands if the adapter ever built a command string.
    const hostileDir = `/tmp/plugin dir; touch ${sentinel}; echo $(touch ${substitution})`;

    const adapter = adapterFor({
      argvLog,
      stdout: JSON.stringify({ id: "paseo-bm", path: hostileDir, enabled: true, status: "disabled" }),
    });
    await adapter.pluginInstall(hostileDir);

    const calls = readArgvLog(argvLog);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(["plugin", "install", hostileDir, "--json"]);
    expect(calls[0]?.argc).toBe(4);
    expect(existsSync(sentinel), "a `;` in an argument started a second command").toBe(false);
    expect(existsSync(substitution), "a `$(...)` in an argument was evaluated").toBe(false);
  });

  it("sends the documented argv for every wrapped command, always with --json", async () => {
    const dir = workDir();
    const argvLog = join(dir, "argv.log");

    const status = adapterFor({ argvLog, stdout: STATUS_JSON });
    await status.daemonStatus();
    const reload = adapterFor({ argvLog, stdout: JSON.stringify({ appliedPaths: ["pluginsEnabled"] }) });
    await reload.daemonReload();
    const list = adapterFor({ argvLog, stdout: JSON.stringify([]) });
    await list.pluginList();
    const logs = adapterFor({ argvLog, stdout: JSON.stringify([]) });
    await logs.pluginLogs("paseo-bm");
    const logsAll = adapterFor({ argvLog, stdout: JSON.stringify([]) });
    await logsAll.pluginLogs();
    const remove = adapterFor({ argvLog, stdout: JSON.stringify({ id: "paseo-bm" }) });
    await remove.pluginRemove("paseo-bm");

    expect(readArgvLog(argvLog).map((call) => call.argv)).toEqual([
      ["daemon", "status", "--json"],
      ["daemon", "reload", "--json"],
      ["plugin", "ls", "--json"],
      ["plugin", "logs", "paseo-bm", "--json"],
      ["plugin", "logs", "--json"],
      ["plugin", "remove", "paseo-bm", "--json"],
    ]);
  });

  it("starts the child directly: the source never reaches for an interpreter", () => {
    const source = readFileSync(ADAPTER_SOURCE, "utf8");
    // `exec`/`execSync` hand a string to /bin/sh; `spawn` with an array does not.
    expect(source).not.toMatch(/\bexec(File|Sync|FileSync)?\s*\(/);
    // The option that would turn `spawn` itself into an interpreter call.
    expect(source).not.toMatch(/shell\s*:/);
    expect(source).toMatch(/import \{ spawn \} from "node:child_process";/);
  });

  it("offers no way to restart or stop the daemon", () => {
    const adapter = createPaseoAdapter();
    expect(Object.keys(adapter).sort()).toEqual([
      "daemonReload",
      "daemonStatus",
      "executable",
      "pluginInstall",
      "pluginList",
      "pluginLogs",
      "pluginRemove",
      "run",
      "timeoutMs",
    ]);
    const source = readFileSync(ADAPTER_SOURCE, "utf8");
    expect(source).not.toMatch(/"restart"/);
    expect(source).not.toMatch(/"stop"/);
  });

  it("finds the CLI through PATH and reports E_PASEO_CLI_MISSING when it is absent", async () => {
    const dir = workDir();
    const argvLog = join(dir, "argv.log");
    const onPath = createPaseoAdapter({ env: fakeEnv({ argvLog, stdout: STATUS_JSON }) });
    expect(onPath.executable).toBe("paseo");
    expect((await onPath.daemonStatus()).daemonVersion).toBe("0.8.0");
    expect(readArgvLog(argvLog)[0]?.argv).toEqual(["daemon", "status", "--json"]);

    const missing = createPaseoAdapter({ env: { PATH: workDir() } });
    const error = await expectPaseoError(() => missing.daemonStatus());
    expect(error.code).toBe("E_PASEO_CLI_MISSING");
    expect(error.reason).toBe("cli-missing");
  });
});

describe("well-formed JSON", () => {
  it("reads daemon status down to the three fields preflight needs", async () => {
    const adapter = adapterFor({ stdout: STATUS_JSON });
    const status = await adapter.daemonStatus();
    expect(status.home).toBe("/Users/someone/.paseo");
    expect(status.cliVersion).toBe("0.8.0");
    expect(status.daemonVersion).toBe("0.8.0");
    expect(status.listen).toBe("127.0.0.1:7777");
    expect(status.raw).toMatchObject({ localDaemon: true });
  });

  it("keeps enabled and status apart: enabled true with status disabled is not running", async () => {
    const adapter = adapterFor({
      stdout: JSON.stringify({ id: "paseo-bm", path: "/opt/paseo-bm", enabled: true, status: "disabled" }),
    });
    const installed = await adapter.pluginInstall("/opt/paseo-bm");
    expect(installed.enabled).toBe(true);
    expect(installed.status).toBe("disabled");
    expect(isPluginRunning(installed), "`enabled: true` must never read as running").toBe(false);
    expect(isPluginRunning({ status: "running" })).toBe(true);
  });

  it("accepts plugin ls as a bare array or wrapped under `plugins`", async () => {
    const entries = [
      { id: "paseo-bm", path: "/opt/paseo-bm", enabled: true, status: "running" },
      { id: "other", enabled: true, status: "disabled" },
    ];
    const bare = adapterFor({ stdout: JSON.stringify(entries) });
    const wrapped = adapterFor({ stdout: JSON.stringify({ plugins: entries }) });
    for (const plugins of [await bare.pluginList(), await wrapped.pluginList()]) {
      expect(plugins.map((plugin) => plugin.id)).toEqual(["paseo-bm", "other"]);
      expect(plugins.filter(isPluginRunning).map((plugin) => plugin.id)).toEqual(["paseo-bm"]);
      expect(plugins[1]?.path).toBeUndefined();
    }
  });

  it("reads appliedPaths from a reload, and treats an absent list as none", async () => {
    const applied = adapterFor({ stdout: JSON.stringify({ appliedPaths: ["pluginsEnabled"] }) });
    expect((await applied.daemonReload()).appliedPaths).toEqual(["pluginsEnabled"]);
    const silent = adapterFor({ stdout: JSON.stringify({ ok: true }) });
    expect((await silent.daemonReload()).appliedPaths).toEqual([]);
  });

  it("normalises plugin logs from objects, strings and a wrapper", async () => {
    const objects = adapterFor({
      stdout: JSON.stringify([{ timestamp: "2026-09-15T00:00:00Z", level: "error", message: "load failed" }]),
    });
    const [entry] = await objects.pluginLogs("paseo-bm");
    expect(entry?.message).toBe("load failed");
    expect(entry?.level).toBe("error");
    expect(entry?.timestamp).toBe("2026-09-15T00:00:00Z");

    const strings = adapterFor({ stdout: JSON.stringify({ entries: ["plain line"] }) });
    expect((await strings.pluginLogs()).map((line) => line.message)).toEqual(["plain line"]);
  });

  it("treats a silent plugin remove as success and ignores unknown fields", async () => {
    const silent = adapterFor({ stdout: "" });
    expect(await silent.pluginRemove("paseo-bm")).toEqual({ id: undefined, raw: null });
    const chatty = adapterFor({ stdout: JSON.stringify({ id: "paseo-bm", removed: true, extra: 1 }) });
    expect((await chatty.pluginRemove("paseo-bm")).id).toBe("paseo-bm");
  });

  it("finds the payload even when the CLI prints a log line first", async () => {
    const adapter = adapterFor({ stdout: `connecting to daemon...\n${STATUS_JSON}\n` });
    expect((await adapter.daemonStatus()).home).toBe("/Users/someone/.paseo");
  });
});

describe("output that does not match the expected shape", () => {
  it("rejects output that is not JSON at all", async () => {
    const adapter = adapterFor({ stdout: "Paseo daemon is running, all good!\n" });
    const error = await expectPaseoError(() => adapter.daemonStatus());
    expect(error.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
    expect(error.reason).toBe("invalid-json");
    expect(error.argv).toEqual(["daemon", "status", "--json"]);
  });

  it("rejects an empty payload from a command that must answer", async () => {
    const adapter = adapterFor({ stdout: "   \n" });
    const error = await expectPaseoError(() => adapter.daemonStatus());
    expect(error.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
    expect(error.reason).toBe("invalid-json");
  });

  it("rejects valid JSON that is missing a field it would have to invent", async () => {
    const adapter = adapterFor({ stdout: JSON.stringify({ home: "/Users/someone/.paseo", cliVersion: "0.8.0" }) });
    const error = await expectPaseoError(() => adapter.daemonStatus());
    expect(error.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
    expect(error.reason).toBe("unexpected-shape");
    expect(error.message).toContain("daemonVersion");
  });

  it("rejects valid JSON of the wrong kind", async () => {
    const array = adapterFor({ stdout: JSON.stringify([{ home: "/h", cliVersion: "0.8.0", daemonVersion: "0.8.0" }]) });
    expect((await expectPaseoError(() => array.daemonStatus())).reason).toBe("unexpected-shape");

    const scalar = adapterFor({ stdout: '"running"' });
    expect((await expectPaseoError(() => scalar.pluginList())).reason).toBe("unexpected-shape");

    const wrongWrapper = adapterFor({ stdout: JSON.stringify({ items: [] }) });
    expect((await expectPaseoError(() => wrongWrapper.pluginList())).code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
  });

  it("rejects a plugin entry with no status, rather than assuming it from enabled", async () => {
    const adapter = adapterFor({ stdout: JSON.stringify({ id: "paseo-bm", path: "/opt/paseo-bm", enabled: true }) });
    const error = await expectPaseoError(() => adapter.pluginInstall("/opt/paseo-bm"));
    expect(error.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
    expect(error.message).toContain("status");
    expect(() => parsePluginSummary({ id: "x", status: 7 }, ["plugin", "ls", "--json"])).toThrow(PaseoCliError);
  });

  it("rejects a reload whose appliedPaths is not a list of strings", async () => {
    const adapter = adapterFor({ stdout: JSON.stringify({ appliedPaths: [1, "pluginsEnabled"] }) });
    expect((await expectPaseoError(() => adapter.daemonReload())).reason).toBe("unexpected-shape");
  });
});

describe("a non-zero exit code", () => {
  it("fails with a diagnostic code and keeps the CLI's own output for the report", async () => {
    const adapter = adapterFor({
      exit: 3,
      stderr: "error: could not connect to the Paseo daemon\n",
      stdout: "",
    });
    const error = await expectPaseoError(() => adapter.daemonStatus());
    expect(error.code).toBe("E_DAEMON_UNREACHABLE");
    expect(error.reason).toBe("exit-code");
    expect(error.exitCode).toBe(3);
    expect(error.stderr).toContain("could not connect to the Paseo daemon");
    expect(error.message).toContain("exit code 3");
  });

  it("never parses stdout from a failed call, even when that stdout is valid JSON", async () => {
    const adapter = adapterFor({ exit: 1, stdout: STATUS_JSON });
    const error = await expectPaseoError(() => adapter.daemonStatus());
    expect(error.reason).toBe("exit-code");
    expect(error.code).toBe("E_DAEMON_UNREACHABLE");
  });
});

describe("the 15-second deadline", () => {
  it("defaults to exactly 15000 ms per call", () => {
    expect(PASEO_CALL_TIMEOUT_MS).toBe(15_000);
    expect(createPaseoAdapter().timeoutMs).toBe(15_000);
    expect(createPaseoAdapter({ executable: FAKE_PASEO }).timeoutMs).toBe(15_000);
    // Injectable only so tests need not wait out the real deadline.
    expect(createPaseoAdapter({ timeoutMs: 250 }).timeoutMs).toBe(250);
  });

  it("stops a hung call at the deadline and reports it", async () => {
    const dir = workDir();
    const pidFile = join(dir, "pid");
    const adapter = adapterFor({ mode: "hang", pidFile }, { timeoutMs: 300, killGraceMs: 100 });

    const startedAt = Date.now();
    const error = await expectPaseoError(() => adapter.daemonStatus());
    const elapsed = Date.now() - startedAt;

    expect(error.code).toBe("E_DAEMON_UNREACHABLE");
    expect(error.reason).toBe("timeout");
    expect(error.timeoutMs).toBe(300);
    expect(error.message).toContain("did not finish within 300 ms");
    expect(elapsed).toBeGreaterThanOrEqual(295);
    expect(elapsed).toBeLessThan(5_000);

    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(isProcessAlive(pid), `the timed-out child ${pid} is still running`).toBe(false);
  });

  it("kills a child that ignores the polite request to stop", async () => {
    const dir = workDir();
    const pidFile = join(dir, "pid");
    const adapter = adapterFor({ mode: "hang-ignore-term", pidFile }, { timeoutMs: 200, killGraceMs: 150 });

    const startedAt = Date.now();
    const error = await expectPaseoError(() => adapter.pluginList());
    const elapsed = Date.now() - startedAt;

    expect(error.reason).toBe("timeout");
    expect(error.signal).toBe("SIGKILL");
    // Only the escalation could have ended it, so it cannot have died early.
    expect(elapsed).toBeGreaterThanOrEqual(345);
    expect(elapsed).toBeLessThan(5_000);
    expect(isProcessAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });
});

/** Signal 0 checks for existence without delivering anything. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
