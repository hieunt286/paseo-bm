/**
 * `paseo-bm uninstall` (bead bm-wp-111-cop.2).
 *
 * Every scenario runs on a fake `$HOME` under the OS temp directory, with a fake
 * Paseo adapter that records each argv and behaves like Paseo 0.8.0 where it
 * matters: `plugin remove` drops the plugin but leaves an empty `plugins: {}`
 * key in `config.json`. The write-scope guard is active for the whole run, so a
 * write outside the install home and `config.json` fails the test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { runDoctor } from "../src/commands/doctor.js";
import { runUninstall } from "../src/commands/uninstall.js";
import type { UninstallOutcome } from "../src/commands/uninstall.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { FsWrite } from "../src/fs-guard.js";
import { sha256 } from "../src/fsops.js";
import { resolveLayout } from "../src/layout.js";
import type { PaseoAdapter, PluginSummary } from "../src/paseo/adapter.js";
import { PaseoCliError } from "../src/paseo/adapter.js";
import { ScriptedPrompter } from "../src/prompter.js";
import type { InstallRecord, McpInjectPrevious, RoleRecord } from "../src/record.js";
import { createRecord, parseRecord, serializeRecord } from "../src/record.js";
import type { WriteScopeHarness } from "./helpers/write-scope.js";
import { startWriteScope } from "./helpers/write-scope.js";

const VERSION = "0.1.0";
const PLUGIN_ID = "paseo-bm";
const INSTALLED_AT = "2026-09-15T10:15:00.000Z";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const OLD_BACKUP = "backups/20260915T101500Z";

let home: string;
let installHome: string;
let paseoHome: string;
let scope: WriteScopeHarness | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-uninstall-")));
  installHome = join(home, ".paseo-bm");
  paseoHome = join(home, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
});

afterEach(() => {
  scope?.restore();
  scope = undefined;
  rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------------------- fake world */

const PAYLOAD: Readonly<Record<string, string>> = {
  "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
  "index.server.js": "// server half\n",
  "roles/worker.md": "# Beads Worker\n",
};

const ROLES: readonly RoleRecord[] = [
  { role: "manager", providerId: "bm-manager", profileId: "bm-manager", baseProvider: "claude", model: "claude-opus-5", modeId: null, thinkingOptionId: null, paseoTools: true },
  { role: "worker", providerId: "bm-worker", profileId: "bm-worker", baseProvider: "codex", model: "gpt-5.6-sol", modeId: null, thinkingOptionId: null, paseoTools: true },
  { role: "reviewer", providerId: "bm-reviewer", profileId: "bm-reviewer", baseProvider: "codex", model: "gpt-5.6-sol", modeId: null, thinkingOptionId: null, paseoTools: false },
];

/** Paseo's config as it was before paseo-bm, with paseo-room's and the user's own entries. */
function preInstallConfig(): Record<string, unknown> {
  return {
    pluginsEnabled: true,
    agents: { providers: { "room-worker": { extends: "claude", label: "Room Worker" } } },
    daemon: {
      listen: "127.0.0.1:7777",
      mcp: { transport: "stdio" },
      agentProfiles: [
        { id: "room-planner", provider: "room-worker" },
        { id: "mine", provider: "claude" },
      ],
    },
  };
}

/** The same config after install, and after Paseo registered the plugin. */
function installedConfig(mcp: { present: boolean; value: unknown }): Record<string, unknown> {
  return {
    pluginsEnabled: true,
    plugins: { [PLUGIN_ID]: { source: join(installHome, "plugin", VERSION) } },
    agents: {
      providers: {
        "room-worker": { extends: "claude", label: "Room Worker" },
        "bm-manager": { extends: "claude", label: "Beads Manager", paseoTools: true },
        "bm-worker": { extends: "codex", label: "Beads Worker", paseoTools: true },
        "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
      },
    },
    daemon: {
      listen: "127.0.0.1:7777",
      mcp: mcp.present ? { transport: "stdio", injectIntoAgents: mcp.value } : { transport: "stdio" },
      agentProfiles: [
        { id: "room-planner", provider: "room-worker" },
        { id: "bm-manager", provider: "bm-manager", model: "claude-opus-5" },
        { id: "mine", provider: "claude" },
        { id: "bm-worker", provider: "bm-worker", model: "gpt-5.6-sol" },
        { id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol" },
      ],
    },
  };
}

/** What M-5 expects: the pre-install config, plus the empty `plugins` key Paseo leaves. */
function expectedAfterUninstall(): Record<string, unknown> {
  const before = preInstallConfig();
  return { pluginsEnabled: before["pluginsEnabled"], plugins: {}, agents: before["agents"], daemon: before["daemon"] };
}

const configFile = (): string => join(paseoHome, "config.json");
const readConfig = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;

function put(relativePath: string, text: string): void {
  const absolute = join(installHome, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, { mode: 0o600 });
}

interface SeedOptions {
  readonly pluginsEnabledSetByUs?: boolean;
  readonly mcpSetByUs?: boolean;
  readonly mcpPrevious?: McpInjectPrevious;
  /** What `injectIntoAgents` holds right now; defaults to `true`, the value install set. */
  readonly mcpCurrent?: { present: boolean; value: unknown };
  /** Extra files inside the old backup, relative to it. */
  readonly backupFiles?: Readonly<Record<string, string>>;
}

/** Lays out an installed paseo-bm exactly as install leaves it, and returns its record. */
function seed(options: SeedOptions = {}): InstallRecord {
  const files = Object.entries(PAYLOAD).map(([path, text]) => {
    const relativePath = `plugin/${VERSION}/${path}`;
    put(relativePath, text);
    return { path: relativePath, sha256: sha256(text), mode: 0o600 };
  });
  put(`${OLD_BACKUP}/paseo-config.json`, `${JSON.stringify(preInstallConfig(), null, 2)}\n`);
  for (const [path, text] of Object.entries(options.backupFiles ?? {})) {
    put(`${OLD_BACKUP}/${path}`, text);
  }

  const base = createRecord({
    version: VERSION,
    installHome,
    paseo: {
      home: paseoHome,
      pluginId: PLUGIN_ID,
      pluginDir: join(installHome, "plugin", VERSION),
      pluginsEnabledSetByUs: options.pluginsEnabledSetByUs ?? false,
      mcpInject: { setByUs: options.mcpSetByUs ?? true, previous: options.mcpPrevious ?? { present: false, value: null } },
    },
    at: INSTALLED_AT,
  });
  const record: InstallRecord = {
    ...base,
    roles: ROLES,
    files,
    versions: [{ version: VERSION, dir: `plugin/${VERSION}`, installedAt: INSTALLED_AT, active: true }],
    backups: [{ at: INSTALLED_AT, dir: OLD_BACKUP, reason: "paseo-config" }],
  };
  writeFileSync(join(installHome, "install.json"), serializeRecord(record), { mode: 0o600 });
  writeFileSync(
    configFile(),
    `${JSON.stringify(installedConfig(options.mcpCurrent ?? { present: true, value: true }), null, 2)}\n`,
  );
  return record;
}

interface FakePaseo {
  readonly adapter: PaseoAdapter;
  readonly calls: string[][];
}

/** A recording stand-in for the `paseo` CLI. Anything uninstall must not run throws. */
function fakePaseo(options: { down?: boolean; otherPlugins?: readonly PluginSummary[] } = {}): FakePaseo {
  const calls: string[][] = [];
  let plugins: PluginSummary[] = [
    { id: PLUGIN_ID, path: join(installHome, "plugin", VERSION), enabled: true, status: "running", raw: {} },
    ...(options.otherPlugins ?? []),
  ];
  const forbid = (argv: string[]): never => {
    calls.push(argv);
    throw new Error(`uninstall must never run \`paseo ${argv.join(" ")}\``);
  };
  const adapter: PaseoAdapter = {
    executable: "paseo",
    timeoutMs: 15_000,
    run: async (args) => forbid([...args]),
    daemonStatus: async () => {
      calls.push(["daemon", "status", "--json"]);
      if (options.down === true) {
        throw new PaseoCliError({ reason: "timeout", message: "`paseo daemon status --json` did not answer.", argv: ["daemon", "status", "--json"] });
      }
      return { home: paseoHome, cliVersion: "0.8.0", daemonVersion: "0.8.0", listen: undefined, raw: {} };
    },
    daemonReload: async () => {
      calls.push(["daemon", "reload", "--json"]);
      return { appliedPaths: ["agents", "daemon", "pluginsEnabled"], raw: {} };
    },
    pluginInstall: async (dir) => forbid(["plugin", "install", dir, "--json"]),
    pluginList: async () => {
      calls.push(["plugin", "ls", "--json"]);
      return plugins;
    },
    pluginLogs: async () => forbid(["plugin", "logs", "--json"]),
    pluginRemove: async (id) => {
      calls.push(["plugin", "remove", id, "--json"]);
      plugins = plugins.filter((plugin) => plugin.id !== id);
      // Verified Paseo 0.8.0 behaviour: the entry goes, an empty key stays.
      const config = readConfig();
      config["plugins"] = {};
      writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`);
      return { id, raw: null };
    },
  };
  return { adapter, calls };
}

interface RunResult {
  readonly outcome: UninstallOutcome;
  readonly stdout: string;
  readonly stderr: string;
  readonly writes: readonly FsWrite[];
  readonly calls: readonly string[][];
  readonly document: {
    mode: string;
    actions: { kind: string; target: string; reason: string }[];
    result: { exitCode: number; error?: { code: string } };
  };
}

async function uninstall(
  options: {
    apply?: boolean;
    prompter?: ScriptedPrompter;
    force?: boolean;
    restoreBackups?: boolean;
    paseo?: FakePaseo;
  } = {},
): Promise<RunResult> {
  const paseo = options.paseo ?? fakePaseo();
  // `record`, not `block`, for the same reason as test/paseo-config.test.ts:
  // the shared atomic writer runs a recursive `mkdir` on the (existing) Paseo
  // home before replacing config.json, and the scope allows the exact file only.
  // That one no-op call is excused below; every other write is still judged.
  const harness = startWriteScope({ installHome, paseoHome, watch: [home], mode: "record" });
  scope = harness;
  const assertInScope = (): void => {
    const paseoDir = realpathSync(paseoHome);
    const inPaseoHome = (path: string): boolean => dirname(path) === paseoDir || dirname(path) === paseoHome;
    const stray = harness.violations.filter((write) => {
      const isPaseoHome = write.canonicalPath === paseoDir || write.path === paseoHome;
      // The temp sibling config.json is replaced through (`.config.json.<pid>.<hex>.tmp`).
      const isConfigTemp = inPaseoHome(write.path) && /^\.config\.json\.\d+\.[0-9a-f]+\.tmp$/.test(write.path.split("/").pop() ?? "");
      return !((write.kind === "make-dir" && isPaseoHome) || isConfigTemp);
    });
    expect(stray.map((write) => `${write.call} ${write.path}`)).toEqual([]);
  };
  let stdout = "";
  let stderr = "";
  try {
    const outcome = await runUninstall({
      adapter: paseo.adapter,
      layoutInput: { homeDir: home, env: {} },
      prompter: options.prompter ?? new ScriptedPrompter({}, { interactive: false }),
      apply: options.apply ?? true,
      force: options.force ?? false,
      restoreBackups: options.restoreBackups ?? false,
      json: true,
      version: VERSION,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      fs: harness.fs,
      now: NOW,
      platform: "darwin",
      nodeVersion: "22.9.0",
      lockOptions: { handleSignals: false },
    });
    assertInScope();
    return {
      outcome,
      stdout,
      stderr,
      writes: [...harness.writes],
      calls: paseo.calls,
      document: JSON.parse(stdout) as RunResult["document"],
    };
  } finally {
    harness.restore();
    scope = undefined;
  }
}

function tree(root: string = home): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else out[relative(root, absolute)] = `${readFileSync(absolute, "utf8")}@${statSync(absolute).mtimeMs}`;
    }
  };
  visit(root);
  return out;
}

function stable(text: string): string {
  return text.split(home).join("<HOME>");
}

function findBackupCopy(relativePath: string): string | undefined {
  const backups = join(installHome, "backups");
  if (!existsSync(backups)) return undefined;
  for (const stamp of readdirSync(backups)) {
    const candidate = join(backups, stamp, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/* ------------------------------------------------------------------ tests */

describe("M-5", () => {
  it("leaves no install home and no key paseo-bm wrote, when nothing was edited, the daemon runs and backups are dropped", async () => {
    seed();
    const paseo = fakePaseo();
    const prompter = new ScriptedPrompter({ confirm: [true, true] });

    const { outcome, calls } = await uninstall({ prompter, paseo });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(prompter.counts.confirm).toBe(2);
    expect(existsSync(installHome)).toBe(false);
    // Key for key and in order: only Paseo's own empty `plugins` key differs from before.
    expect(JSON.stringify(readConfig())).toBe(JSON.stringify(expectedAfterUninstall()));

    expect(calls).toContainEqual(["plugin", "remove", PLUGIN_ID, "--json"]);
    expect(calls).toContainEqual(["daemon", "reload", "--json"]);
    expect(calls.flat()).not.toContain("restart");
    expect(calls.flat()).not.toContain("stop");
    expect(calls.flat()).not.toContain("install");
  });

  it("doctor afterwards reports not installed and exits 0", async () => {
    seed();
    const paseo = fakePaseo();
    await uninstall({ prompter: new ScriptedPrompter({ confirm: [true, true] }), paseo });

    const doctor = await runDoctor({
      adapter: paseo.adapter,
      layout: resolveLayout({ homeDir: home, env: {}, daemonPaseoHome: paseoHome }),
      version: VERSION,
      env: { PATH: join(home, "no-bin") },
      skipSkillsCheck: true,
    });

    expect(doctor.installed).toBe(false);
    expect(doctor.exitCode).toBe(EXIT_CODES.ok);
    expect(doctor.checks.find((check) => check.id === "install-record")?.severity).toBe("warn");
  });
});

describe("the three branches allowed to stay", () => {
  it("keeps a file the user edited, and still removes everything else", async () => {
    seed();
    put(`plugin/${VERSION}/roles/worker.md`, "# my own worker\n");

    const { outcome, document } = await uninstall();

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(readFileSync(join(installHome, `plugin/${VERSION}/roles/worker.md`), "utf8")).toBe("# my own worker\n");
    expect(existsSync(join(installHome, `plugin/${VERSION}/index.server.js`))).toBe(false);
    expect(existsSync(join(installHome, `plugin/${VERSION}/paseo-plugin.json`))).toBe(false);
    expect(existsSync(join(installHome, "install.json"))).toBe(false);
    expect(document.actions).toContainEqual(
      expect.objectContaining({ kind: "keep", target: `installHome/plugin/${VERSION}/roles/worker.md`, reason: "user-modified" }),
    );
  });

  it("--force removes the edited file, but only after copying it into a backup", async () => {
    seed();
    put(`plugin/${VERSION}/roles/worker.md`, "# my own worker\n");

    const { outcome } = await uninstall({ force: true });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(existsSync(join(installHome, `plugin/${VERSION}`))).toBe(false);
    const copy = findBackupCopy(`plugin/${VERSION}/roles/worker.md`);
    expect(copy).toBeDefined();
    expect(readFileSync(copy!, "utf8")).toBe("# my own worker\n");
  });

  it("keeps backups when the user chooses to keep them", async () => {
    seed();
    const installed = readFileSync(configFile(), "utf8");
    const prompter = new ScriptedPrompter({ confirm: [true, false] });

    const { outcome, document } = await uninstall({ prompter });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(existsSync(join(installHome, `${OLD_BACKUP}/paseo-config.json`))).toBe(true);
    // This run's own copy of config.json is a backup too, and stays with the others.
    const runCopy = readdirSync(join(installHome, "backups"))
      .map((stamp) => join(installHome, "backups", stamp, "paseo-config.json"))
      .filter((path) => !path.includes("20260915T101500Z") && existsSync(path));
    expect(runCopy).toHaveLength(1);
    expect(JSON.parse(readFileSync(runCopy[0]!, "utf8"))).toEqual({ ...JSON.parse(installed), plugins: {} });

    expect(existsSync(join(installHome, "plugin"))).toBe(false);
    expect(existsSync(join(installHome, "install.json"))).toBe(false);
    expect(JSON.stringify(readConfig())).toBe(JSON.stringify(expectedAfterUninstall()));
    expect(document.actions).toContainEqual(
      expect.objectContaining({ kind: "keep", target: `installHome/${OLD_BACKUP}`, reason: "kept-by-choice" }),
    );
  });

  it("with the daemon down, removes the files but keeps install.json and the Paseo half for a later run", async () => {
    const seeded = seed();
    const configBefore = readFileSync(configFile(), "utf8");
    const paseo = fakePaseo({ down: true });

    const { outcome, calls, document, stderr } = await uninstall({ paseo });

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(existsSync(join(installHome, "plugin"))).toBe(false);
    expect(readFileSync(configFile(), "utf8")).toBe(configBefore);
    expect(calls).toEqual([["daemon", "status", "--json"]]);

    const record = parseRecord(readFileSync(join(installHome, "install.json"), "utf8"));
    expect(record.paseo).toEqual(seeded.paseo);
    expect(record.roles).toEqual(seeded.roles);
    expect(record.files).toEqual([]);
    expect(record.versions).toEqual([]);
    expect(record.backups).toEqual(seeded.backups);

    expect(document.actions).toContainEqual(
      expect.objectContaining({ kind: "keep", target: "installHome/install.json", reason: "paseo-unavailable" }),
    );
    expect(stderr).toContain("did not answer");
  });
});

describe("Paseo's config", () => {
  it("keeps every room-* and user entry, with its content and its position", async () => {
    seed();

    await uninstall();

    const config = readConfig();
    const daemon = config["daemon"] as { listen: string; agentProfiles: { id: string }[] };
    const providers = (config["agents"] as { providers: Record<string, unknown> }).providers;
    expect(daemon.agentProfiles).toEqual(preInstallConfig()["daemon"] && (preInstallConfig()["daemon"] as { agentProfiles: unknown }).agentProfiles);
    expect(Object.keys(providers)).toEqual(["room-worker"]);
    expect(providers["room-worker"]).toEqual({ extends: "claude", label: "Room Worker" });
    expect(daemon.listen).toBe("127.0.0.1:7777");
  });

  it("puts injectIntoAgents back to its recorded previous value", async () => {
    seed({ mcpPrevious: { present: true, value: false } });
    await uninstall();
    expect((readConfig()["daemon"] as { mcp: Record<string, unknown> }).mcp).toEqual({ transport: "stdio", injectIntoAgents: false });
  });

  it("removes injectIntoAgents when the key did not exist before paseo-bm", async () => {
    seed({ mcpPrevious: { present: false, value: null } });
    await uninstall();
    const mcp = (readConfig()["daemon"] as { mcp: Record<string, unknown> }).mcp;
    expect("injectIntoAgents" in mcp).toBe(false);
  });

  it("does not touch injectIntoAgents when someone changed it after paseo-bm set it", async () => {
    seed({ mcpPrevious: { present: false, value: null }, mcpCurrent: { present: true, value: false } });

    const { document } = await uninstall();

    expect((readConfig()["daemon"] as { mcp: Record<string, unknown> }).mcp).toEqual({ transport: "stdio", injectIntoAgents: false });
    expect(document.actions).toContainEqual(
      expect.objectContaining({ kind: "keep", target: "paseoHome/config.json#daemon.mcp.injectIntoAgents", reason: "changed-since-install" }),
    );
  });

  it("does not touch injectIntoAgents when paseo-bm did not turn it on", async () => {
    seed({ mcpSetByUs: false, mcpPrevious: { present: true, value: true } });
    await uninstall();
    expect((readConfig()["daemon"] as { mcp: Record<string, unknown> }).mcp).toEqual({ transport: "stdio", injectIntoAgents: true });
  });

  it("offers to turn pluginsEnabled off only when paseo-bm turned it on and no other plugin is left", async () => {
    seed({ pluginsEnabledSetByUs: true });
    const prompter = new ScriptedPrompter({ confirm: [true, true, false] });

    await uninstall({ prompter });

    expect(prompter.counts.confirm).toBe(3);
    expect(readConfig()["pluginsEnabled"]).toBe(false);
  });

  it("does not offer it while another plugin is installed", async () => {
    seed({ pluginsEnabledSetByUs: true });
    const other: PluginSummary = { id: "someone-else", path: "/elsewhere", enabled: true, status: "running", raw: {} };
    const prompter = new ScriptedPrompter({ confirm: [true, false] });

    await uninstall({ prompter, paseo: fakePaseo({ otherPlugins: [other] }) });

    expect(prompter.counts.confirm).toBe(2);
    expect(readConfig()["pluginsEnabled"]).toBe(true);
  });
});

describe("--restore-backups", () => {
  it("puts a backed-up payload file back and keeps it, but never restores the whole config file", async () => {
    seed({ backupFiles: { [`plugin/${VERSION}/roles/worker.md`]: "# worker before --force\n" } });

    const { document } = await uninstall({ restoreBackups: true });

    expect(readFileSync(join(installHome, `plugin/${VERSION}/roles/worker.md`), "utf8")).toBe("# worker before --force\n");
    expect(existsSync(join(installHome, `plugin/${VERSION}/index.server.js`))).toBe(false);
    expect(JSON.stringify(readConfig())).toBe(JSON.stringify(expectedAfterUninstall()));
    expect(document.actions).toContainEqual(
      expect.objectContaining({ kind: "keep", target: `installHome/${OLD_BACKUP}/paseo-config.json`, reason: "config-backup-not-restored" }),
    );
  });
});

describe("preview, refusals and reports", () => {
  it("previews without a terminal and without --apply: exit 6, nothing written, nothing run but read-only calls", async () => {
    seed();
    const before = tree();

    const { outcome, writes, calls, stdout } = await uninstall({ apply: false });

    expect(outcome.exitCode).toBe(EXIT_CODES.noTtyNoApply);
    expect(outcome.report.mode).toBe("preview");
    expect(writes).toEqual([]);
    expect(tree()).toEqual(before);
    expect(calls).toEqual([
      ["daemon", "status", "--json"],
      ["plugin", "ls", "--json"],
    ]);
    expect(stable(stdout)).toMatchSnapshot();
  });

  it("applied report", async () => {
    seed();
    const { outcome, stdout } = await uninstall();
    expect(outcome.report.mode).toBe("applied");
    expect(stable(stdout)).toMatchSnapshot();
  });

  it("does nothing when paseo-bm is not installed", async () => {
    const { outcome, writes, document } = await uninstall();
    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(document.actions).toEqual([]);
    expect(writes).toEqual([]);
    expect(existsSync(installHome)).toBe(false);
  });

  it("stops with E_LOCKED and exit 3 when another run holds the lock, and removes nothing", async () => {
    seed();
    writeFileSync(
      join(installHome, ".lock"),
      JSON.stringify({ pid: process.ppid, acquiredAt: NOW.toISOString(), hostname: hostname(), command: "install" }),
    );
    const configBefore = readFileSync(configFile(), "utf8");

    const { outcome, document, calls } = await uninstall();

    expect(outcome.exitCode).toBe(EXIT_CODES.preflight);
    expect(document.result.error?.code).toBe("E_LOCKED");
    expect(existsSync(join(installHome, `plugin/${VERSION}/index.server.js`))).toBe(true);
    expect(readFileSync(configFile(), "utf8")).toBe(configBefore);
    expect(calls.flat()).not.toContain("remove");
  });
});
