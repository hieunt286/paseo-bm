/**
 * Plugin registration (bm-wp-105-6ec.3, REQ-005(a)(c), Design §9.1, §9.3).
 *
 * Runs against the fake CLI in `test/fakes/paseo` inside a `mkdtemp` install
 * home: no daemon is contacted and `~/.paseo` is never read or written.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFsOps } from "../src/fsops.js";
import type { FsOps } from "../src/fsops.js";
import { createPaseoAdapter, isPaseoCliError } from "../src/paseo/adapter.js";
import type { PaseoAdapter } from "../src/paseo/adapter.js";
import type { InstallRecord } from "../src/record.js";
import { createRecord, readRecord, recordPath, writeRecord } from "../src/record.js";
import type { PluginRegistrationError } from "../src/commands/install/register.js";
import {
  isPluginRegistrationError,
  pluginLogsCommand,
  registerPlugin,
} from "../src/commands/install/register.js";

const FAKE_DIR = fileURLToPath(new URL("./fakes/", import.meta.url));
const FAKE_PASEO = join(FAKE_DIR, "paseo");
const NOW = new Date("2026-09-15T10:00:00Z");
const LATER = new Date("2026-09-15T11:00:00Z");

let scratch: string;
let installHome: string;
let argvLog: string;
let fsops: FsOps;

interface FakeScript {
  stdout?: string;
  stderr?: string;
  exit?: number;
}

function adapter(script: FakeScript): PaseoAdapter {
  const env: NodeJS.ProcessEnv = { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`, BM_FAKE_ARGV_LOG: argvLog };
  if (script.stdout !== undefined) env["BM_FAKE_STDOUT"] = script.stdout;
  if (script.stderr !== undefined) env["BM_FAKE_STDERR"] = script.stderr;
  if (script.exit !== undefined) env["BM_FAKE_EXIT"] = String(script.exit);
  return createPaseoAdapter({ executable: FAKE_PASEO, env, timeoutMs: 10_000 });
}

function calls(): string[][] {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv);
}

function pluginJson(status: string, extra: Record<string, unknown> = {}): string {
  // `enabled: true` on purpose: it is always true and must never be read.
  return JSON.stringify({ id: "paseo-bm", path: "ignored", enabled: true, status, ...extra });
}

async function seedRecord(home: string): Promise<InstallRecord> {
  const base = createRecord({ version: "0.2.0", installHome: home, paseo: { home: join(scratch, ".paseo") }, at: NOW });
  const record: InstallRecord = {
    ...base,
    versions: [
      { version: "0.1.0", dir: "plugin/0.1.0", installedAt: "2026-09-01T00:00:00Z", active: true },
      { version: "0.2.0", dir: "plugin/0.2.0", installedAt: "2026-09-15T10:00:00Z", active: false },
    ],
  };
  mkdirSync(join(home, "plugin", "0.1.0"), { recursive: true });
  mkdirSync(join(home, "plugin", "0.2.0"), { recursive: true });
  await writeRecord(createFsOps({ root: home }), record);
  return record;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-register-"));
  installHome = join(scratch, "home with space", ".paseo-bm");
  mkdirSync(installHome, { recursive: true });
  argvLog = join(scratch, "argv.log");
  fsops = createFsOps({ root: installHome });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("registerPlugin — success while the plugin switch is off", () => {
  it("calls `paseo plugin install <dir> --id paseo-bm --json` and records the registration", async () => {
    const record = await seedRecord(installHome);
    const dir = join(installHome, "plugin", "0.2.0");

    const result = await registerPlugin({
      adapter: adapter({ stdout: pluginJson("disabled") }),
      fsops,
      record,
      version: "0.2.0",
      now: LATER,
    });

    // One argv element for a directory with a space: no shell involved.
    expect(calls()).toEqual([["plugin", "install", dir, "--id", "paseo-bm", "--json"]]);
    expect(result.plugin.status).toBe("disabled");
    expect(result.plugin.enabled).toBe(true);
    expect(result.running).toBe(false);
    expect(result.pluginDir).toBe(dir);
    expect(result.recordOutcome).toBe("updated");

    const onDisk = await readRecord(createFsOps({ root: installHome }));
    expect(onDisk?.paseo.pluginId).toBe("paseo-bm");
    expect(onDisk?.paseo.pluginDir).toBe(dir);
    expect(onDisk?.versions.map((v) => [v.version, v.active])).toEqual([
      ["0.1.0", false],
      ["0.2.0", true],
    ]);
    expect(onDisk?.updatedAt).toBe(LATER.toISOString());
    // Paseo's config is never touched by this step.
    expect(existsSync(join(scratch, ".paseo"))).toBe(false);
  });

  it("reports running when Paseo says so", async () => {
    const record = await seedRecord(installHome);
    const result = await registerPlugin({ adapter: adapter({ stdout: pluginJson("running") }), fsops, record, version: "0.2.0" });
    expect(result.running).toBe(true);
  });

  it("does not rewrite the record when the same registration is run again", async () => {
    const record = await seedRecord(installHome);
    const first = await registerPlugin({ adapter: adapter({ stdout: pluginJson("disabled") }), fsops, record, version: "0.2.0", now: LATER });
    const bytes = readFileSync(recordPath(installHome), "utf8");

    const second = await registerPlugin({
      adapter: adapter({ stdout: pluginJson("disabled") }),
      fsops,
      record: first.record,
      version: "0.2.0",
      now: new Date("2026-09-16T00:00:00Z"),
    });
    expect(second.recordOutcome).toBe("not-written");
    expect(readFileSync(recordPath(installHome), "utf8")).toBe(bytes);
  });
});

describe("registerPlugin — plugin failures", () => {
  it("install exits non-zero: message names the logs command, payload and record are kept", async () => {
    const record = await seedRecord(installHome);
    const before = readFileSync(recordPath(installHome), "utf8");

    const error = await registerPlugin({
      adapter: adapter({ exit: 1, stderr: "plugin manifest invalid\n" }),
      fsops,
      record,
      version: "0.2.0",
    }).catch((caught: unknown) => caught);

    expect(isPluginRegistrationError(error)).toBe(true);
    const failure = error as PluginRegistrationError;
    expect(failure.reason).toBe("install-failed");
    expect(failure.code).toBe("E_PLUGIN_LOAD_FAILED");
    expect(failure.message).toContain("paseo plugin logs paseo-bm");
    expect(failure.logsCommand).toBe(pluginLogsCommand());
    expect(readFileSync(recordPath(installHome), "utf8")).toBe(before);
    expect(existsSync(join(installHome, "plugin", "0.2.0"))).toBe(true);
    expect(existsSync(join(scratch, ".paseo"))).toBe(false);
  });

  it("status other than running/disabled: load failure with logs command, record states the registration", async () => {
    const record = await seedRecord(installHome);

    const error = await registerPlugin({
      adapter: adapter({ stdout: pluginJson("error") }),
      fsops,
      record,
      version: "0.2.0",
    }).catch((caught: unknown) => caught);

    expect(isPluginRegistrationError(error)).toBe(true);
    const failure = error as PluginRegistrationError;
    expect(failure.reason).toBe("load-failed");
    expect(failure.code).toBe("E_PLUGIN_LOAD_FAILED");
    expect(failure.status).toBe("error");
    expect(failure.message).toContain("paseo plugin logs paseo-bm");
    const onDisk = await readRecord(createFsOps({ root: installHome }));
    expect(onDisk?.paseo.pluginId).toBe("paseo-bm");
  });

  it("output that is not JSON keeps the adapter's registry code and writes nothing", async () => {
    const record = await seedRecord(installHome);
    const before = readFileSync(recordPath(installHome), "utf8");
    const error = await registerPlugin({ adapter: adapter({ stdout: "installed!" }), fsops, record, version: "0.2.0" }).catch(
      (caught: unknown) => caught,
    );
    expect(isPaseoCliError(error) && error.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
    expect(readFileSync(recordPath(installHome), "utf8")).toBe(before);
  });

  it("a different plugin id in the answer is unexpected output", async () => {
    const record = await seedRecord(installHome);
    const error = await registerPlugin({
      adapter: adapter({ stdout: pluginJson("disabled", { id: "someone-else" }) }),
      fsops,
      record,
      version: "0.2.0",
    }).catch((caught: unknown) => caught);
    expect(isPaseoCliError(error) && error.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
  });

  it("refuses a version that is not in the record without calling Paseo", async () => {
    const record = await seedRecord(installHome);
    const error = await registerPlugin({ adapter: adapter({ stdout: pluginJson("disabled") }), fsops, record, version: "9.9.9" }).catch(
      (caught: unknown) => caught,
    );
    expect(isPluginRegistrationError(error) && error.reason).toBe("version-not-recorded");
    expect(isPluginRegistrationError(error) && error.code).toBeUndefined();
    expect(calls()).toEqual([]);
  });
});
