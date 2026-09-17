/**
 * `paseo-bm doctor` — proof of the invariant, not just of the output.
 *
 * The bead behind this file (bm-wp-111-cop.1) is mostly a list of things doctor
 * must *not* do, so the tests are built around four claims:
 *
 *  1. **Zero writes.** `test/helpers/write-scope.ts` patches every mutating
 *     entry point of `node:fs` and `node:fs/promises` for the duration of the
 *     run, and the assertion is that the recorded write list is empty — not
 *     merely that no write escaped the install home.
 *  2. **An exact external-command allow-list.** A recording adapter implements
 *     all six `PaseoAdapter` members; each one pushes the argv it would have
 *     spawned, and the four state-changing members also throw. The assertion
 *     compares the recorded set against `DOCTOR_PASEO_COMMANDS`, so a new call
 *     fails the test whether it succeeds or not. On top of that, `spawn` itself
 *     is wrapped for the whole file, which is what proves the third-party
 *     `skills` CLI is never executed.
 *  3. **The three states.** Healthy exits 0, drift exits 1, not-installed exits
 *     0 with a warning; each one has a JSON snapshot.
 *  4. **Warnings are not drift.** Missing skills and a missing beads CLI keep
 *     the exit code at 0 (Design §4.3).
 *
 * Nothing here runs a real `paseo`, reads a real `~/.paseo`, or touches the
 * developer's agent directories: every path is inside a fake `$HOME` under the
 * OS temp directory, and the only executable ever spawned is a Node script this
 * file writes itself.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as ChildProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Every child process started while this file runs is recorded and then handed
 * to the real `spawn`, so behaviour is unchanged and the assertion is simply
 * "the log holds nothing but the two allow-listed `paseo` calls". A doctor that
 * grew a `skills` invocation would be caught here even if it never went through
 * the Paseo adapter.
 */
const { spawns } = vi.hoisted(() => ({ spawns: [] as { file: string; args: string[] }[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: (file: string, args?: readonly string[], options?: unknown) => {
      spawns.push({ file, args: [...(args ?? [])] });
      return (actual.spawn as unknown as (...rest: unknown[]) => unknown)(file, args, options);
    },
  };
});

import type { Check, DoctorReport } from "../src/action.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { FLAG_SPECS } from "../src/flags.js";
import type { Layout } from "../src/layout.js";
import { resolveLayout } from "../src/layout.js";
import type { DaemonStatus, PaseoAdapter, PluginSummary } from "../src/paseo/adapter.js";
import { PaseoCliError, createPaseoAdapter } from "../src/paseo/adapter.js";
import type { InstallRecord } from "../src/record.js";
import { serializeRecord } from "../src/record.js";
import { renderJsonReport } from "../src/report/json.js";
import { REQUIRED_SKILLS } from "../src/skills/detect.js";
import { startWriteScope } from "./helpers/write-scope.js";

import { DOCTOR_PASEO_COMMANDS, runDoctor } from "../src/commands/doctor.js";

/* ------------------------------------------------------------- fake world */

const PACKAGE_VERSION = "0.1.0";
const PLUGIN_ID = "paseo-bm";
const INSTALLED_AT = "2026-09-15T10:15:00.000Z";

interface World {
  readonly home: string;
  readonly layout: Layout;
  readonly binDir: string;
  /** `env` to hand to doctor: a PATH holding only what this test put there. */
  readonly env: Record<string, string | undefined>;
  cleanup(): void;
}

let worlds: World[] = [];

function payload(version: string): { path: string; content: string }[] {
  return [
    { path: `plugin/${version}/index.server.js`, content: "// server half of the payload\n" },
    { path: `plugin/${version}/roles/worker.md`, content: "# Beads Worker\n" },
  ];
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A fake `$HOME` with a PATH of its own. Nothing outside it is ever touched. */
function makeWorld(options: { beads?: boolean } = {}): World {
  const home = mkdtempSync(join(tmpdir(), "paseo-bm-doctor-"));
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  if (options.beads !== false) {
    // A healthy machine has both beads tools (delta 20260916-setup-screen).
    for (const tool of ["br", "bv"]) {
      writeFileSync(join(binDir, tool), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, tool), 0o755);
    }
  }

  const env: Record<string, string | undefined> = { PATH: binDir };
  const layout = resolveLayout({ homeDir: home, env: {} });
  const world: World = {
    home,
    layout,
    binDir,
    env,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
  worlds.push(world);
  return world;
}

/** The five required skills, installed for Claude Code only. */
function installSkills(world: World, skills: readonly string[] = REQUIRED_SKILLS): void {
  for (const skill of skills) {
    const dir = join(world.layout.claudeHome.path, "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${skill}\n`);
  }
}

function writePaseoConfig(world: World, config: unknown): void {
  mkdirSync(world.layout.paseoHome.path, { recursive: true });
  writeFileSync(join(world.layout.paseoHome.path, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function healthyConfig(): unknown {
  return {
    pluginsEnabled: true,
    agents: {
      providers: {
        // The shape `roleProviderEntry` writes: an object for Manager and
        // Worker, and no key at all for the Reviewer (ADR-006).
        "bm-manager": { extends: "claude", label: "Beads Manager", paseoTools: { enabled: true } },
        "bm-worker": { extends: "codex", label: "Beads Worker", paseoTools: { enabled: true } },
        "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
      },
    },
    daemon: {
      mcp: { injectIntoAgents: true },
      agentProfiles: [{ id: "someone-elses" }, { id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }],
    },
  };
}

function makeRecord(world: World, overrides: Partial<InstallRecord> = {}): InstallRecord {
  const version = overrides.version ?? PACKAGE_VERSION;
  return {
    schemaVersion: 1,
    version,
    installedAt: INSTALLED_AT,
    updatedAt: INSTALLED_AT,
    installHome: world.layout.installHome.path,
    paseo: {
      home: world.layout.paseoHome.path,
      pluginId: PLUGIN_ID,
      pluginDir: join(world.layout.installHome.path, "plugin", version),
      pluginsEnabledSetByUs: true,
      mcpInject: { setByUs: true, previous: { present: false, value: null } },
    },
    roles: [
      {
        role: "manager",
        providerId: "bm-manager",
        profileId: "bm-manager",
        baseProvider: "claude",
        model: "claude-opus-5",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: true,
      },
      {
        role: "worker",
        providerId: "bm-worker",
        profileId: "bm-worker",
        baseProvider: "codex",
        model: "gpt-5.6-sol",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: true,
      },
      {
        role: "reviewer",
        providerId: "bm-reviewer",
        profileId: "bm-reviewer",
        baseProvider: "codex",
        model: "gpt-5.6-sol",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: false,
      },
    ],
    files: payload(version).map((file) => ({ path: file.path, sha256: hash(file.content), mode: 0o600 })),
    versions: [{ version, dir: `plugin/${version}`, installedAt: INSTALLED_AT, active: true }],
    backups: [],
    skills: { agents: ["claude", "codex"], lastStatus: [], assistDeclinedAt: null, lastCommand: null, assistOutcome: null },
    ...overrides,
  };
}

/** Lay the payload on disk and write `install.json`, exactly as install would. */
function installOnDisk(world: World, record: InstallRecord, files = payload(record.version)): void {
  for (const file of files) {
    const target = join(world.layout.installHome.path, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content, { mode: 0o600 });
  }
  mkdirSync(world.layout.installHome.path, { recursive: true });
  writeFileSync(join(world.layout.installHome.path, "install.json"), serializeRecord(record), { mode: 0o600 });
}

/* ------------------------------------------------------- recording adapter */

interface AdapterScript {
  readonly daemon?: DaemonStatus | Error;
  readonly plugins?: readonly PluginSummary[] | Error;
  /**
   * When `plugins` is not scripted, the default `paseo-bm` entry reports this
   * world's active payload directory as its `path` — what a healthy install
   * looks like to `paseo plugin ls`.
   */
  readonly world?: World;
}

/** The directory install hands to `paseo plugin install` for `version`. */
function activePluginDir(world: World, version: string = PACKAGE_VERSION): string {
  return join(world.layout.installHome.path, "plugin", version);
}

interface RecordingAdapter {
  readonly adapter: PaseoAdapter;
  /** Every argv the adapter was asked to run, in order. */
  readonly calls: string[][];
}

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    home: "/fake/paseo",
    cliVersion: "0.8.0",
    daemonVersion: "0.8.0",
    listen: "127.0.0.1:7777",
    raw: {},
    ...overrides,
  };
}

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return { id: PLUGIN_ID, path: "/fake/dir", enabled: true, status: "running", raw: {}, ...overrides };
}

/**
 * Implements the whole `PaseoAdapter` surface. Every member records the argv it
 * stands for — including the four that doctor must never reach for, which then
 * also throw. That combination is what makes the allow-list assertion strict:
 * an extra call shows up in `calls` whether or not the caller handles the
 * failure.
 */
function recordingAdapter(script: AdapterScript = {}): RecordingAdapter {
  const calls: string[][] = [];
  const forbidden = (args: readonly string[]): Error =>
    new Error(`doctor must never run \`paseo ${args.join(" ")}\``);
  const note = (args: readonly string[]): string[] => {
    const copy = [...args];
    calls.push(copy);
    return copy;
  };

  const adapter: PaseoAdapter = {
    executable: "paseo-never-spawned",
    timeoutMs: 1_000,
    async run(args) {
      throw forbidden(note(args));
    },
    async daemonStatus() {
      note(["daemon", "status", "--json"]);
      const answer = script.daemon ?? status();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async pluginList() {
      note(["plugin", "ls", "--json"]);
      const answer =
        script.plugins ?? [plugin(script.world === undefined ? {} : { path: activePluginDir(script.world) })];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async daemonReload() {
      throw forbidden(note(["daemon", "reload", "--json"]));
    },
    async pluginInstall(directory) {
      throw forbidden(note(["plugin", "install", directory, "--json"]));
    },
    async pluginLogs(pluginId) {
      throw forbidden(note(pluginId === undefined ? ["plugin", "logs", "--json"] : ["plugin", "logs", pluginId, "--json"]));
    },
    async pluginRemove(pluginId) {
      throw forbidden(note(["plugin", "remove", pluginId, "--json"]));
    },
  };

  return { adapter, calls };
}

/* ------------------------------------------------------------- assertions */

function severityOf(checks: readonly Check[], id: string): Check["severity"] | undefined {
  return checks.find((entry) => entry.id === id)?.severity;
}

function find(checks: readonly Check[], id: string): Check {
  const found = checks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no check with id \`${id}\` in ${checks.map((c) => c.id).join(", ")}`);
  return found;
}

/** Absolute temp paths would make every snapshot unique; fold them away. */
function stable(text: string, world: World): string {
  return text.split(world.home).join("<HOME>");
}

afterEach(() => {
  spawns.length = 0;
});

afterAll(() => {
  for (const world of worlds) world.cleanup();
  worlds = [];
});

/* ------------------------------------------------------------ state: healthy */

async function healthyWorld(): Promise<World> {
  const world = makeWorld();
  installSkills(world);
  writePaseoConfig(world, healthyConfig());
  installOnDisk(world, makeRecord(world));
  return world;
}

describe("runDoctor — a healthy install", () => {
  it("reports every check as ok and exits 0", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });

    const outcome = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(outcome.installed).toBe(true);
    expect(outcome.checks.filter((entry) => entry.severity !== "ok")).toEqual([]);
    expect(outcome.report.result.pluginState).toBe("running");
  });

  it("covers every item the bead lists", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    const ids = checks.map((entry) => entry.id);
    expect(ids).toEqual([
      "paseo-daemon",
      "paseo-version",
      "install-record",
      "install-version",
      "files-missing",
      "files-modified",
      "plugin-registered",
      "plugin-status",
      "plugin-path",
      "plugins-enabled",
      "agent-tools",
      "role-bm-manager",
      "role-bm-worker",
      "role-bm-reviewer",
      "payload-versions",
      "backups",
      "beads-cli",
      "beads-viewer",
      "skills-agents",
      "skills-claude",
      "skills-codex",
    ]);
  });

  it("counts payload versions and backups rather than measuring bytes", async () => {
    const world = makeWorld();
    installSkills(world);
    writePaseoConfig(world, healthyConfig());
    const base = makeRecord(world);
    installOnDisk(world, {
      ...base,
      versions: [
        { version: "0.0.9", dir: "plugin/0.0.9", installedAt: INSTALLED_AT, active: false },
        ...base.versions,
      ],
      backups: [{ at: INSTALLED_AT, dir: "backups/20260915T101500Z", reason: "config" }],
    });

    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(find(checks, "payload-versions").message).toBe("2 payload versions are kept (active: 0.1.0).");
    expect(find(checks, "backups").message).toBe("1 backup is kept.");
    // Informational only: keeping old versions is the designed behaviour.
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(find(checks, "payload-versions").severity).toBe("ok");
  });

  it("renders the JSON document of Design §4.4", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const { report } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(stable(renderJsonReport(report, { redact: (text) => text }), world)).toMatchSnapshot();
  });
});

/* ------------------------------------------- roles: the paseoTools shape */

/** A healthy world whose three provider entries carry the given `paseoTools` values. */
function worldWithPaseoTools(tools: { manager?: unknown; worker?: unknown; reviewer?: unknown }): World {
  const world = makeWorld();
  installSkills(world);
  const entry = (label: string, value: unknown): Record<string, unknown> =>
    value === undefined ? { extends: "codex", label } : { extends: "codex", label, paseoTools: value };
  writePaseoConfig(world, {
    ...(healthyConfig() as Record<string, unknown>),
    agents: {
      providers: {
        "bm-manager": entry("Beads Manager", tools.manager),
        "bm-worker": entry("Beads Worker", tools.worker),
        "bm-reviewer": entry("Beads Reviewer", tools.reviewer),
      },
    },
  });
  installOnDisk(world, makeRecord(world));
  return world;
}

describe("runDoctor — reads paseoTools in the shape Paseo stores it (bm-ym3)", () => {
  it("treats `{ enabled: true }` as on: Manager and Worker roles are ok", async () => {
    const world = worldWithPaseoTools({ manager: { enabled: true }, worker: { enabled: true } });
    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode, report } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(severityOf(checks, "role-bm-manager")).toBe("ok");
    expect(severityOf(checks, "role-bm-worker")).toBe("ok");
    expect(severityOf(checks, "role-bm-reviewer")).toBe("ok");
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(report.roles.map((role) => role.paseoTools)).toEqual([true, true, false]);
  });

  it("still accepts a bare `true` for compatibility", async () => {
    const world = worldWithPaseoTools({ manager: true, worker: true });
    const { adapter } = recordingAdapter({ world });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "role-bm-manager")).toBe("ok");
    expect(severityOf(checks, "role-bm-worker")).toBe("ok");
  });

  it("treats `{ enabled: false }` as off: an error where the record says true, ok for the Reviewer", async () => {
    const world = worldWithPaseoTools({ manager: { enabled: false }, worker: { enabled: false }, reviewer: { enabled: false } });
    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(severityOf(checks, "role-bm-manager")).toBe("error");
    expect(find(checks, "role-bm-manager").message).toBe(
      "The `bm-manager` role is recorded with paseoTools true, but Paseo's configuration has false.",
    );
    expect(severityOf(checks, "role-bm-worker")).toBe("error");
    expect(severityOf(checks, "role-bm-reviewer")).toBe("ok");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
  });

  it("treats an absent key as off: an error where the record says true, ok for the Reviewer", async () => {
    const world = worldWithPaseoTools({});
    const { adapter } = recordingAdapter({ world });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "role-bm-manager")).toBe("error");
    expect(severityOf(checks, "role-bm-worker")).toBe("error");
    expect(severityOf(checks, "role-bm-reviewer")).toBe("ok");
  });

  it("flags a Reviewer whose provider has `{ enabled: true }` against a record of false", async () => {
    const world = worldWithPaseoTools({ manager: { enabled: true }, worker: { enabled: true }, reviewer: { enabled: true } });
    const { adapter } = recordingAdapter({ world });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "role-bm-reviewer")).toBe("error");
    expect(find(checks, "role-bm-reviewer").message).toContain("recorded with paseoTools false");
  });
});

/* -------------------------------------------------------------- state: drift */

async function driftWorld(): Promise<World> {
  const world = makeWorld();
  installSkills(world);
  writePaseoConfig(world, {
    pluginsEnabled: false,
    agents: {
      providers: {
        "bm-manager": { paseoTools: { enabled: true } },
        "bm-worker": { paseoTools: { enabled: true } },
      },
    },
    daemon: { mcp: { injectIntoAgents: false }, agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }] },
  });

  // Recorded as 0.0.9 while the running package is 0.1.0; one payload file is
  // gone and the other has been edited by hand.
  const record = makeRecord(world, { version: "0.0.9" });
  installOnDisk(world, record, [
    { path: "plugin/0.0.9/roles/worker.md", content: "# edited by the user\n" },
  ]);
  return world;
}

describe("runDoctor — an install that has drifted", () => {
  it("reports every deviation at once and exits 1", async () => {
    const world = await driftWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ enabled: true, status: "disabled" })] });

    const { checks, exitCode } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
    expect(severityOf(checks, "install-version")).toBe("error");
    expect(severityOf(checks, "files-missing")).toBe("error");
    expect(severityOf(checks, "files-modified")).toBe("error");
    expect(severityOf(checks, "plugin-status")).toBe("error");
    expect(severityOf(checks, "plugins-enabled")).toBe("error");
    expect(severityOf(checks, "agent-tools")).toBe("error");
    expect(severityOf(checks, "role-bm-reviewer")).toBe("error");
    // Nothing stopped early: the daemon checks still ran and still passed.
    expect(severityOf(checks, "paseo-daemon")).toBe("ok");
    expect(severityOf(checks, "paseo-version")).toBe("ok");
  });

  it("gives every deviation a remediation", async () => {
    const world = await driftWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ status: "disabled" })] });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    for (const entry of checks.filter((candidate) => candidate.severity === "error")) {
      expect(entry.remediation, `check \`${entry.id}\` has no remediation`).not.toBe("");
    }
  });

  it("reads `status`, never `enabled`, to decide whether the plugin runs", async () => {
    const world = await healthyWorld();
    // The exact trap recorded in AGENTS.md: `enabled` stays true after install
    // even while the plugin is doing nothing.
    const { adapter } = recordingAdapter({ plugins: [plugin({ enabled: true, status: "disabled" })] });

    const { checks, exitCode, report } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(severityOf(checks, "plugin-status")).toBe("error");
    expect(find(checks, "plugin-status").message).toContain("`disabled`");
    expect(report.result.pluginState).toBe("disabled");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
  });

  it("says so when the plugin is not registered at all", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ id: "someone-elses" })] });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "plugin-registered")).toBe("error");
    expect(checks.some((entry) => entry.id === "plugin-status")).toBe(false);
  });

  it("keeps reporting when the daemon does not answer", async () => {
    const world = await healthyWorld();
    const unreachable = new PaseoCliError({
      reason: "timeout",
      message: "The Paseo daemon did not answer.",
      argv: ["daemon", "status", "--json"],
    });
    const { adapter, calls } = recordingAdapter({ daemon: unreachable });

    const { checks, exitCode } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(severityOf(checks, "paseo-daemon")).toBe("error");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
    // Everything that does not need the daemon was still reported…
    expect(severityOf(checks, "install-record")).toBe("ok");
    expect(severityOf(checks, "files-missing")).toBe("ok");
    // …and `plugin ls` was not attempted against a daemon that is not there.
    expect(calls).toEqual([["daemon", "status", "--json"]]);
  });

  it("reports a damaged install record instead of treating it as a fresh machine", async () => {
    const world = makeWorld();
    installSkills(world);
    writePaseoConfig(world, healthyConfig());
    mkdirSync(world.layout.installHome.path, { recursive: true });
    writeFileSync(join(world.layout.installHome.path, "install.json"), "{ not json\n");

    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode, installed } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(severityOf(checks, "install-record")).toBe("error");
    expect(find(checks, "install-record").remediation).not.toBe("");
    expect(installed).toBe(false);
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
  });

  it("renders the JSON document of Design §4.4", async () => {
    const world = await driftWorld();
    const { adapter } = recordingAdapter({
      plugins: [plugin({ enabled: true, status: "disabled", path: activePluginDir(world, "0.0.9") })],
    });
    const { report } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(stable(renderJsonReport(report, { redact: (text) => text }), world)).toMatchSnapshot();
  });
});

/* ------------------------------- the payload Paseo loads vs. the active one */

/**
 * bm-p48. Acceptance run 5 (doctor-2.json): an update to 0.1.0-alpha.1 copied
 * and recorded the new payload but failed to register it, so `version` said
 * alpha.1, `versions[].active` still said alpha.0, and Paseo kept loading
 * `plugin/0.1.0-alpha.0`. Doctor reported all of that as healthy.
 */
describe("runDoctor — the plugin Paseo loads is the active payload (bm-p48)", () => {
  const OLD = "0.1.0-alpha.0";
  const NEW = "0.1.0-alpha.1";

  /** The state the failed update left behind: both payloads on disk, the old one active. */
  function failedUpdateWorld(): World {
    const world = makeWorld();
    installSkills(world);
    writePaseoConfig(world, healthyConfig());
    const base = makeRecord(world, { version: NEW });
    const record: InstallRecord = {
      ...base,
      paseo: { ...base.paseo, pluginDir: activePluginDir(world, OLD) },
      files: [...payload(OLD), ...payload(NEW)].map((file) => ({
        path: file.path,
        sha256: hash(file.content),
        mode: 0o600,
      })),
      versions: [
        { version: OLD, dir: `plugin/${OLD}`, installedAt: INSTALLED_AT, active: true },
        { version: NEW, dir: `plugin/${NEW}`, installedAt: INSTALLED_AT, active: false },
      ],
    };
    installOnDisk(world, record, [...payload(OLD), ...payload(NEW)]);
    return world;
  }

  it("is ok when Paseo loads the active payload directory", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(find(checks, "plugin-path")).toEqual({
      id: "plugin-path",
      severity: "ok",
      message: "Paseo loads the plugin `paseo-bm` from the active payload (version 0.1.0).",
      remediation: "",
    });
    expect(exitCode).toBe(EXIT_CODES.ok);
  });

  it("is ok when Paseo spells the same directory differently", async () => {
    const world = await healthyWorld();
    const spelled = `${world.layout.installHome.path}/plugin/./x/../${PACKAGE_VERSION}/`;
    const { adapter } = recordingAdapter({ plugins: [plugin({ path: spelled })] });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "plugin-path")).toBe("ok");
  });

  it("is an error when Paseo loads another directory than the active payload", async () => {
    const world = makeWorld();
    installSkills(world);
    writePaseoConfig(world, healthyConfig());
    installOnDisk(world, makeRecord(world));
    const { adapter } = recordingAdapter({ plugins: [plugin({ path: activePluginDir(world, "0.0.9") })] });

    const { checks, exitCode } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    const finding = find(checks, "plugin-path");
    expect(finding.severity).toBe("error");
    expect(stable(finding.message, world)).toBe(
      "Paseo loads the plugin `paseo-bm` from <HOME>/.paseo-bm/plugin/0.0.9, but the active payload (version 0.1.0) is <HOME>/.paseo-bm/plugin/0.1.0.",
    );
    expect(finding.remediation).toContain("npx paseo-bm install --apply");
    // Registration and liveness are still reported as they are.
    expect(severityOf(checks, "plugin-registered")).toBe("ok");
    expect(severityOf(checks, "plugin-status")).toBe("ok");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
  });

  it("is an error when the record's version is not the active payload", async () => {
    const world = failedUpdateWorld();
    // Paseo is consistent with `active` here, so only the record disagrees with itself.
    const { adapter } = recordingAdapter({ plugins: [plugin({ path: activePluginDir(world, OLD) })] });

    const { checks, exitCode } = await runDoctor({ adapter, layout: world.layout, version: NEW, env: world.env });

    const finding = find(checks, "install-version");
    expect(finding.severity).toBe("error");
    expect(finding.message).toBe(
      "The install record says version 0.1.0-alpha.1, but the active payload is version 0.1.0-alpha.0: an update did not finish.",
    );
    expect(finding.remediation).toContain("npx paseo-bm install --apply");
    expect(severityOf(checks, "plugin-path")).toBe("ok");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
  });

  it("reproduces doctor-2.json: both deviations are reported, neither as ok", async () => {
    const world = failedUpdateWorld();
    // What Paseo actually reported: still loading the old payload, and running.
    const { adapter } = recordingAdapter({ plugins: [plugin({ path: activePluginDir(world, OLD) })] });

    const { checks, exitCode } = await runDoctor({ adapter, layout: world.layout, version: NEW, env: world.env });

    expect(severityOf(checks, "install-version")).toBe("error");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);

    // …and if Paseo had been left on the new directory while the record still
    // calls the old one active, that is a path deviation.
    const { adapter: onNew } = recordingAdapter({ plugins: [plugin({ path: activePluginDir(world, NEW) })] });
    const second = await runDoctor({ adapter: onNew, layout: world.layout, version: NEW, env: world.env });
    expect(severityOf(second.checks, "plugin-path")).toBe("error");
    expect(severityOf(second.checks, "install-version")).toBe("error");
  });

  it("is an error when the record marks no payload version active", async () => {
    const world = makeWorld();
    installSkills(world);
    writePaseoConfig(world, healthyConfig());
    const base = makeRecord(world);
    installOnDisk(world, { ...base, versions: base.versions.map((entry) => ({ ...entry, active: false })) });
    const { adapter } = recordingAdapter({ world });

    const { checks, exitCode } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "install-version")).toBe("error");
    expect(severityOf(checks, "plugin-path")).toBe("error");
    expect(exitCode).toBe(EXIT_CODES.doctorDrift);
  });

  it("warns, without concluding either way, when Paseo does not report a path", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ path: undefined })] });

    const { checks, exitCode } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    const finding = find(checks, "plugin-path");
    expect(finding.severity).toBe("warn");
    expect(finding.remediation).not.toBe("");
    expect(exitCode).toBe(EXIT_CODES.ok);
  });

  it("does not compare paths for a plugin that is not registered", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ id: "someone-elses", path: "/elsewhere" })] });

    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(severityOf(checks, "plugin-registered")).toBe("error");
    expect(checks.some((entry) => entry.id === "plugin-path")).toBe(false);
  });

  it("stays read-only and within the two allow-listed calls while finding the deviation", async () => {
    const world = failedUpdateWorld();
    const { adapter, calls } = recordingAdapter({ plugins: [plugin({ path: activePluginDir(world, NEW) })] });
    const scope = startWriteScope({
      installHome: world.layout.installHome.path,
      paseoHome: world.layout.paseoHome.path,
      watch: [world.home],
    });
    try {
      await runDoctor({ adapter, layout: world.layout, version: NEW, env: world.env });
      expect(scope.writes).toEqual([]);
    } finally {
      scope.restore();
    }
    expect(calls.map((argv) => argv.join(" "))).toEqual(["daemon status --json", "plugin ls --json"]);
  });
});

/* ------------------------------------------------------ state: not installed */

describe("runDoctor — nothing installed yet", () => {
  it("says so without calling it drift", async () => {
    const world = makeWorld();
    const { adapter } = recordingAdapter({ world });

    const { checks, exitCode, installed, report } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(installed).toBe(false);
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(severityOf(checks, "install-record")).toBe("warn");
    expect(find(checks, "install-record").remediation).toContain("paseo-bm install");
    expect(report.roles).toEqual([]);
    expect(report.result.pluginState).toBeNull();
  });

  it("does not report ownership checks for a scope that does not exist", async () => {
    const world = makeWorld();
    const { adapter } = recordingAdapter({ world });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    const ids = checks.map((entry) => entry.id);
    for (const id of ["install-version", "files-missing", "plugin-status", "plugins-enabled", "role-bm-worker"]) {
      expect(ids).not.toContain(id);
    }
  });

  it("renders the JSON document of Design §4.4", async () => {
    const world = makeWorld();
    const { adapter } = recordingAdapter({ world });
    const { report } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(stable(renderJsonReport(report, { redact: (text) => text }), world)).toMatchSnapshot();
  });
});

/* -------------------------------------------- warnings never change the code */

describe("runDoctor — warnings are not drift (Design §4.3)", () => {
  it("keeps exit 0 when the beads CLI is missing", async () => {
    const world = makeWorld({ beads: false });
    installSkills(world);
    writePaseoConfig(world, healthyConfig());
    installOnDisk(world, makeRecord(world));

    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode, report } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: { PATH: join(world.home, "empty") },
    });

    expect(severityOf(checks, "beads-cli")).toBe("warn");
    expect(severityOf(checks, "beads-viewer")).toBe("warn");
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(report.warnings.map((entry) => entry.code)).toContain("W_BEADS_CLI_MISSING");
    expect(report.warnings.map((entry) => entry.code)).toContain("W_BEADS_VIEWER_MISSING");
  });

  it("keeps exit 0 when agent skills are missing", async () => {
    const world = makeWorld();
    // Claude Code is installed but has no skills directory at all.
    mkdirSync(world.layout.claudeHome.path, { recursive: true });
    writePaseoConfig(world, healthyConfig());
    installOnDisk(world, makeRecord(world));

    const { adapter } = recordingAdapter({ world });
    const { checks, exitCode, report } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
    });

    expect(severityOf(checks, "skills-claude")).toBe("warn");
    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(report.warnings.map((entry) => entry.code)).toContain("W_SKILLS_MISSING");
    expect(report.skills?.source).toBe("cuongntr/agent-skills");
  });

  it("drops the skills section entirely under --skip-skills-check", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const { checks, report } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: world.env,
      skipSkillsCheck: true,
    });

    expect(report.skills).toBeNull();
    expect(checks.some((entry) => entry.id.startsWith("skills-"))).toBe(false);
  });
});

/* ------------------------------------------------------ the read-only claims */

describe("doctor is read-only", () => {
  it("performs zero writes", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });

    // Started only after the fixture is on disk, so the fixture's own writes
    // are never mistaken for doctor's.
    const scope = startWriteScope({
      installHome: world.layout.installHome.path,
      paseoHome: world.layout.paseoHome.path,
      watch: [world.home],
    });
    try {
      const { exitCode } = await runDoctor({
        adapter,
        layout: world.layout,
        version: PACKAGE_VERSION,
        env: world.env,
      });
      expect(exitCode).toBe(EXIT_CODES.ok);

      // Stronger than "no violation": not one mutating call anywhere under the
      // fake $HOME — no install home, no ~/.paseo, no agent skills directory.
      expect(scope.writes).toEqual([]);
      scope.assertNoViolations();
    } finally {
      scope.restore();
    }
  });

  it("performs zero writes even when everything has drifted", async () => {
    const world = await driftWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ status: "disabled" })] });

    const scope = startWriteScope({
      installHome: world.layout.installHome.path,
      paseoHome: world.layout.paseoHome.path,
      watch: [world.home],
    });
    try {
      const { exitCode } = await runDoctor({
        adapter,
        layout: world.layout,
        version: PACKAGE_VERSION,
        env: world.env,
      });
      expect(exitCode).toBe(EXIT_CODES.doctorDrift);
      // Finding a problem must not tempt doctor into fixing it.
      expect(scope.writes).toEqual([]);
    } finally {
      scope.restore();
    }
  });

  it("never takes the process lock", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const scope = startWriteScope({
      installHome: world.layout.installHome.path,
      paseoHome: world.layout.paseoHome.path,
      watch: [world.home],
    });
    try {
      await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });
      expect(scope.paths()).not.toContain(join(world.layout.installHome.path, ".lock"));
    } finally {
      scope.restore();
    }
  });
});

describe("doctor's external-command allow-list", () => {
  it("is exactly `paseo daemon status` and `paseo plugin ls`", () => {
    expect(DOCTOR_PASEO_COMMANDS.map((argv) => argv.join(" "))).toEqual([
      "daemon status --json",
      "plugin ls --json",
    ]);
  });

  it("makes exactly those two calls and no other, in a healthy run", async () => {
    const world = await healthyWorld();
    const { adapter, calls } = recordingAdapter({ world });

    await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    const seen = new Set(calls.map((argv) => argv.join(" ")));
    const allowed = new Set(DOCTOR_PASEO_COMMANDS.map((argv) => argv.join(" ")));
    expect(seen).toEqual(allowed);
    // Each one exactly once: a health check has no reason to ask twice.
    expect(calls).toHaveLength(2);
  });

  it("makes exactly those two calls and no other, in a drifted run", async () => {
    const world = await driftWorld();
    const { adapter, calls } = recordingAdapter({ plugins: [plugin({ status: "disabled" })] });

    await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(new Set(calls.map((argv) => argv.join(" ")))).toEqual(
      new Set(DOCTOR_PASEO_COMMANDS.map((argv) => argv.join(" "))),
    );
    expect(calls.some((argv) => argv[0] === "plugin" && argv[1] === "install")).toBe(false);
    expect(calls.some((argv) => argv[0] === "plugin" && argv[1] === "remove")).toBe(false);
    expect(calls.some((argv) => argv[0] === "daemon" && argv[1] === "reload")).toBe(false);
  });

  it("spawns nothing at all when the adapter is in-memory — so no `skills` CLI", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });

    await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(spawns).toEqual([]);
  });

  it("does not accept --prune: pruning writes", () => {
    const prune = FLAG_SPECS.find((spec) => spec.flag === "--prune");
    expect(prune?.commands).not.toContain("doctor");
  });
});

/* ------------------------------------------------- against a simulated daemon */

/**
 * The end-to-end half: a real child process, spawned by the real adapter.
 *
 * The stand-in `paseo` is a Node script written into the fake `$HOME`. It logs
 * every argv it is given, which turns the allow-list claim into an observation
 * about actual process launches rather than about an in-memory double, and it
 * answers fast so the latency budget measures doctor rather than a daemon.
 */
describe("runDoctor — against a simulated daemon", () => {
  let world: World;
  let fakeCli: string;

  beforeAll(async () => {
    world = await healthyWorld();
    fakeCli = join(world.home, "bin", "paseo");
    writeFileSync(
      fakeCli,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const argv = process.argv.slice(2);",
        'fs.appendFileSync(process.env.BM_DOCTOR_ARGV_LOG, JSON.stringify(argv) + "\\n");',
        'const key = argv.slice(0, 2).join(" ");',
        'if (key === "daemon status") { process.stdout.write(process.env.BM_DOCTOR_STATUS); process.exit(0); }',
        'if (key === "plugin ls") { process.stdout.write(process.env.BM_DOCTOR_PLUGINS); process.exit(0); }',
        'process.stderr.write("refused: " + argv.join(" ") + "\\n");',
        "process.exit(9);",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCli, 0o755);
  });

  it("answers in well under five seconds and spawns only the two allow-listed commands", async () => {
    const argvLog = join(world.home, "argv.log");
    writeFileSync(argvLog, "");

    const childEnv = {
      ...process.env,
      PATH: `${world.binDir}${delimiter}${process.env.PATH ?? ""}`,
      BM_DOCTOR_ARGV_LOG: argvLog,
      BM_DOCTOR_STATUS: JSON.stringify({
        home: world.layout.paseoHome.path,
        cliVersion: "0.8.0",
        daemonVersion: "0.8.0",
      }),
      BM_DOCTOR_PLUGINS: JSON.stringify([
        { id: PLUGIN_ID, path: activePluginDir(world), status: "running", enabled: true },
      ]),
    };

    const adapter = createPaseoAdapter({ executable: fakeCli, env: childEnv, timeoutMs: 5_000 });

    const startedAt = Date.now();
    const { exitCode } = await runDoctor({
      adapter,
      layout: world.layout,
      version: PACKAGE_VERSION,
      env: { PATH: world.binDir },
    });
    const elapsed = Date.now() - startedAt;

    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(elapsed).toBeLessThan(5_000);

    // What the fake CLI itself saw…
    const logged = (await import("node:fs")).readFileSync(argvLog, "utf8").trim().split("\n");
    expect(logged.map((line) => (JSON.parse(line) as string[]).join(" "))).toEqual([
      "daemon status --json",
      "plugin ls --json",
    ]);

    // …and what `spawn` was actually asked to start: only this fake, never a
    // `skills` binary and never a second executable of any kind.
    expect(new Set(spawns.map((call) => call.file))).toEqual(new Set([fakeCli]));
    expect(spawns.map((call) => call.args.join(" "))).toEqual(["daemon status --json", "plugin ls --json"]);
  });
});

/* ---------------------------------------------------------- report shape */

describe("the doctor report", () => {
  it("is always a preview and always carries checks instead of actions", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const { report } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    const doctor: DoctorReport = report;
    expect(doctor.command).toBe("doctor");
    expect(doctor.mode).toBe("preview");
    expect(doctor).not.toHaveProperty("actions");
  });

  it("gives every check the four fields of Design §4.4", async () => {
    const world = await driftWorld();
    const { adapter } = recordingAdapter({ plugins: [plugin({ status: "disabled" })] });
    const { checks } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    for (const entry of checks) {
      expect(Object.keys(entry).sort()).toEqual(["id", "message", "remediation", "severity"]);
      expect(entry.message).not.toBe("");
      if (entry.severity === "ok") continue;
      expect(entry.remediation).not.toBe("");
    }
  });

  it("leaves `loggedIn` null: asking would be a third command", async () => {
    const world = await healthyWorld();
    const { adapter } = recordingAdapter({ world });
    const { report } = await runDoctor({ adapter, layout: world.layout, version: PACKAGE_VERSION, env: world.env });

    expect(report.roles).toHaveLength(3);
    for (const role of report.roles) {
      expect(role.loggedIn).toBeNull();
    }
  });
});
