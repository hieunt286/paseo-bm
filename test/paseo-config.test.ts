/**
 * The config-mutation module is the only place paseo-bm writes into a file that
 * belongs to another product, so these tests are about *not* breaking a machine
 * that already has other software on it.
 *
 * The fixture is deliberately not empty: it carries six `room-*` providers and
 * six `room-*` agent profiles, the way the owner's real machine looks after
 * paseo-room has been installed, plus the user's own provider and profile. The
 * central assertion is byte-level — every entry that is not ours comes out of
 * the write identical, down to the whitespace, and the profiles array keeps its
 * order. Replacing that array wholesale is the paseo-room defect ADR-006
 * decision 5 exists to prevent.
 *
 * Nothing here touches a real `~/.paseo`: every test runs in a `mkdtemp`
 * directory with a fake Paseo home, and `paseo` is a stub object that only
 * offers `daemonReload`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeFsApi } from "../src/fs-guard.js";
import { nodeFs } from "../src/fs-guard.js";
import type { DaemonReload } from "../src/paseo/adapter.js";
import { PaseoCliError } from "../src/paseo/adapter.js";
import type { ApplyConfigEditOptions, ConfigEdit, PaseoConfig } from "../src/paseo/config.js";
import {
  AGENT_PROFILES_PATH,
  CONFIG_BACKUP_NAME,
  MCP_INJECT_PATH,
  PLUGINS_ENABLED_PATH,
  PROVIDERS_PATH,
  agentProfileIds,
  applyConfigEdit,
  bmProfileIds,
  bmProviderIds,
  editConfig,
  isConfigMutationError,
  mcpInjectRecordFrom,
  readConfigSnapshot,
  readMcpInject,
  readPluginsEnabled,
} from "../src/paseo/config.js";
import { startWriteScope } from "./helpers/write-scope.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/paseo-config.room.json", import.meta.url));
const FIXTURE_TEXT = readFileSync(FIXTURE, "utf8");

/** Everything in the fixture that paseo-bm must never touch. */
const ROOM_PROVIDERS = [
  "room-architect",
  "room-builder",
  "room-tester",
  "room-scribe",
  "room-scout",
  "room-sentinel",
] as const;
const ROOM_PROFILES = ROOM_PROVIDERS;
const USER_PROVIDERS = ["anthropic", "openai"] as const;
const FIXTURE_PROFILE_ORDER = ["my-default", ...ROOM_PROFILES];

let scratch: string;
let fakeHome: string;
let paseoHome: string;
let installHome: string;
let configPath: string;
/** The same three paths with symlinks resolved — `/var` is `/private/var` on macOS. */
let realPaseoHome: string;
let realInstallHome: string;
let realConfigPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-config-"));
  fakeHome = join(scratch, "home");
  paseoHome = join(fakeHome, ".paseo");
  installHome = join(fakeHome, ".paseo-bm");
  configPath = join(paseoHome, "config.json");
  mkdirSync(paseoHome, { recursive: true });
  writeFileSync(configPath, FIXTURE_TEXT, { mode: 0o644 });
  const realScratch = realpathSync(scratch);
  realPaseoHome = join(realScratch, "home", ".paseo");
  realInstallHome = join(realScratch, "home", ".paseo-bm");
  realConfigPath = join(realPaseoHome, "config.json");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------- utilities */

function readConfigText(): string {
  return readFileSync(configPath, "utf8");
}

function readConfig(): PaseoConfig {
  return JSON.parse(readConfigText()) as PaseoConfig;
}

/** Rewrites the fake config after changing the parsed form, keeping the layout. */
function seedConfig(mutate: (config: PaseoConfig) => void): void {
  const config = JSON.parse(FIXTURE_TEXT) as PaseoConfig;
  mutate(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
}

function daemonOf(config: PaseoConfig): Record<string, unknown> {
  return config["daemon"] as Record<string, unknown>;
}

function profilesOf(config: PaseoConfig): Record<string, unknown>[] {
  return daemonOf(config)["agentProfiles"] as Record<string, unknown>[];
}

/** The balanced JSON value starting at `open`, as raw text. */
function balanced(text: string, open: number): string {
  const closers: Record<string, string> = { "{": "}", "[": "]" };
  const opener = text[open];
  if (opener === undefined || closers[opener] === undefined) {
    throw new Error(`Not the start of an object or array at ${open}: ${text.slice(open, open + 40)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(open, index + 1);
      }
    }
  }
  throw new Error("Unbalanced JSON text");
}

/** The raw text of `"<key>": <value>`'s value, e.g. one provider. */
function memberSlice(text: string, key: string): string {
  const needle = `${JSON.stringify(key)}: `;
  const at = text.indexOf(needle);
  if (at === -1) {
    throw new Error(`No member named ${key}`);
  }
  return balanced(text, at + needle.length);
}

/** The raw text of the array entry whose `id` is `id`, e.g. one agent profile. */
function entrySlice(text: string, id: string): string {
  const at = text.indexOf(`"id": ${JSON.stringify(id)}`);
  if (at === -1) {
    throw new Error(`No array entry with id ${id}`);
  }
  return balanced(text, text.lastIndexOf("{", at));
}

/**
 * The assertion this whole suite exists for: nothing that is not ours moved or
 * changed, at the byte level.
 */
function expectForeignEntriesUntouched(before: string, after: string): void {
  for (const id of [...ROOM_PROVIDERS, ...USER_PROVIDERS]) {
    expect(memberSlice(after, id), `provider ${id} changed`).toBe(memberSlice(before, id));
  }
  for (const id of [...ROOM_PROFILES, "my-default"]) {
    expect(entrySlice(after, id), `profile ${id} changed`).toBe(entrySlice(before, id));
  }
}

interface FakeAdapter {
  daemonReload(): Promise<DaemonReload>;
  readonly calls: number[];
}

/** A `paseo` stand-in. It has no `restart` and no `stop`, on purpose. */
function fakeAdapter(options: {
  appliedPaths?: readonly string[];
  fail?: boolean;
  onReload?: (call: number) => void;
} = {}): FakeAdapter {
  const calls: number[] = [];
  return {
    calls,
    async daemonReload(): Promise<DaemonReload> {
      calls.push(calls.length + 1);
      options.onReload?.(calls.length);
      if (options.fail === true && calls.length === 1) {
        throw new PaseoCliError({
          reason: "exit-code",
          message: "paseo daemon reload failed",
          argv: ["daemon", "reload", "--json"],
          exitCode: 1,
        });
      }
      return { appliedPaths: options.appliedPaths ?? ["pluginsEnabled", "daemon", "agents"], raw: {} };
    },
  };
}

/**
 * A filesystem seam that runs a callback after each read of `config.json`. It
 * is how a concurrent writer is simulated: the hook fires between paseo-bm's
 * read and its next check of the same file.
 */
function fsWithReadHook(onRead: (count: number) => void): NodeFsApi {
  let count = 0;
  return {
    ...nodeFs,
    readFile: async (path: string) => {
      const data = await nodeFs.readFile(path);
      if (resolve(path) === resolve(configPath)) {
        count += 1;
        onRead(count);
      }
      return data;
    },
  };
}

/** What another process writing the file at the same time looks like. */
function writeFromElsewhere(mutate: (config: PaseoConfig) => void): void {
  const config = readConfig();
  mutate(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

const BM_PROVIDERS = {
  "bm-manager": { extends: "anthropic", label: "Beads Manager", paseoTools: { enabled: true } },
  "bm-worker": { extends: "openai", label: "Beads Worker", paseoTools: { enabled: true } },
  "bm-reviewer": { extends: "anthropic", label: "Beads Reviewer" },
} as const;

const BM_PROFILES = [
  { id: "bm-manager", name: "Beads Manager", provider: "bm-manager", model: "claude-opus-5" },
  { id: "bm-worker", name: "Beads Worker", provider: "bm-worker", model: "gpt-5.6-sol" },
  { id: "bm-reviewer", name: "Beads Reviewer", provider: "bm-reviewer", model: "claude-sonnet-5" },
];

const ROLE_EDIT: ConfigEdit = { providers: BM_PROVIDERS, profiles: BM_PROFILES };

function apply(edit: ConfigEdit, overrides: Partial<ApplyConfigEditOptions> = {}) {
  return applyConfigEdit({
    paseoHome,
    installHome,
    edit,
    adapter: fakeAdapter(),
    ...overrides,
  });
}

/* ---------------------------------------------------------------- reading */

describe("readConfigSnapshot", () => {
  it("reads the file, its hash and its layout", async () => {
    const snapshot = await readConfigSnapshot(configPath);
    expect(snapshot.text).toBe(FIXTURE_TEXT);
    expect(snapshot.indent).toBe("  ");
    expect(snapshot.trailingNewline).toBe(true);
    expect(snapshot.mode).toBe(0o644);
    expect(agentProfileIds(snapshot.config)).toEqual(FIXTURE_PROFILE_ORDER);
    expect(bmProviderIds(snapshot.config)).toEqual([]);
    expect(bmProfileIds(snapshot.config)).toEqual([]);
  });

  it("refuses a missing file instead of inventing one", async () => {
    rmSync(configPath);
    await expect(readConfigSnapshot(configPath)).rejects.toMatchObject({
      name: "ConfigMutationError",
      reason: "config-missing",
    });
  });

  it("refuses a file that is not JSON", async () => {
    writeFileSync(configPath, "{ not json");
    await expect(readConfigSnapshot(configPath)).rejects.toMatchObject({ reason: "config-invalid-json" });
  });
});

/* ------------------------------------------- living next to paseo-room */

describe("writing next to paseo-room", () => {
  it("adds the bm-* entries and leaves every room-* entry byte-identical", async () => {
    const before = readConfigText();
    const result = await apply(ROLE_EDIT);
    const after = readConfigText();

    expect(result.written).toBe(true);
    expect(result.attempts).toBe(1);
    expectForeignEntriesUntouched(before, after);

    const config = readConfig();
    expect(agentProfileIds(config)).toEqual([...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-worker", "bm-reviewer"]);
    expect(bmProviderIds(config)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(result.changedPaths).toEqual([
      `${PROVIDERS_PATH}.bm-manager`,
      `${PROVIDERS_PATH}.bm-worker`,
      `${PROVIDERS_PATH}.bm-reviewer`,
      `${AGENT_PROFILES_PATH}[bm-manager]`,
      `${AGENT_PROFILES_PATH}[bm-worker]`,
      `${AGENT_PROFILES_PATH}[bm-reviewer]`,
    ]);
  });

  it("keeps every other key and the key order of the file", async () => {
    const before = JSON.parse(FIXTURE_TEXT) as PaseoConfig;
    await apply(ROLE_EDIT);
    const after = readConfig();

    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.keys(daemonOf(after))).toEqual(Object.keys(daemonOf(before)));
    expect(after["app"]).toEqual(before["app"]);
    expect(after["features"]).toEqual(before["features"]);
    expect(after["version"]).toBe(before["version"]);
    expect((after["agents"] as Record<string, unknown>)["defaultProfileId"]).toBe("my-default");
  });

  it("updates a bm-* profile in place, without moving it or the entries around it", async () => {
    // A previous install left bm-worker in the middle of the array.
    seedConfig((config) => {
      profilesOf(config).splice(3, 0, {
        id: "bm-worker",
        name: "Beads Worker",
        provider: "bm-worker",
        model: "gpt-5.5-old",
      });
    });
    const before = readConfigText();

    const result = await apply({ profiles: [BM_PROFILES[1]!] });
    const after = readConfigText();

    expect(result.changedPaths).toEqual([`${AGENT_PROFILES_PATH}[bm-worker]`]);
    expectForeignEntriesUntouched(before, after);
    const ids = agentProfileIds(readConfig());
    expect(ids).toEqual(["my-default", "room-architect", "room-builder", "bm-worker", "room-tester", "room-scribe", "room-scout", "room-sentinel"]);
    expect(profilesOf(readConfig())[3]).toEqual(BM_PROFILES[1]);
  });

  it("removes only the bm-* entries asked for", async () => {
    await apply(ROLE_EDIT);
    const before = readConfigText();

    const result = await apply({ removeProfiles: ["bm-reviewer"], removeProviders: ["bm-reviewer"] });
    const after = readConfigText();

    expectForeignEntriesUntouched(before, after);
    expect(result.changedPaths).toEqual([`${PROVIDERS_PATH}.bm-reviewer`, `${AGENT_PROFILES_PATH}[bm-reviewer]`]);
    expect(agentProfileIds(readConfig())).toEqual([...FIXTURE_PROFILE_ORDER, "bm-manager", "bm-worker"]);
    expect(bmProviderIds(readConfig())).toEqual(["bm-manager", "bm-worker"]);
  });

  it("refuses to touch an id that is not ours", () => {
    expect(() => editConfig(JSON.parse(FIXTURE_TEXT) as PaseoConfig, { removeProfiles: ["room-architect"] })).toThrow(
      /only ever writes entries whose id starts with "bm-"/,
    );
    expect(() =>
      editConfig(JSON.parse(FIXTURE_TEXT) as PaseoConfig, { providers: { "room-scout": { label: "hijack" } } }),
    ).toThrowError(expect.objectContaining({ reason: "not-ours" }));
  });

  it("writes nothing when everything is already registered", async () => {
    await apply(ROLE_EDIT);
    const before = readConfigText();
    const beforeTimes = statSync(configPath, { bigint: true }).mtimeNs;
    const adapter = fakeAdapter();

    const result = await apply(ROLE_EDIT, { adapter });

    expect(result.written).toBe(false);
    expect(result.changedPaths).toEqual([]);
    expect(result.verification).toBe("not-needed");
    expect(adapter.calls).toEqual([]);
    expect(readConfigText()).toBe(before);
    expect(statSync(configPath, { bigint: true }).mtimeNs).toBe(beforeTimes);
  });
});

/* ------------------------------------------------ the MCP switch, 4 states */

describe("daemon.mcp.injectIntoAgents", () => {
  it("state 1 — the key is absent: it is created and previous is { present: false }", async () => {
    const before = readConfigText();
    const result = await apply({ mcpInject: { action: "set", value: true } });
    const after = readConfigText();

    expect(result.before.mcpInject).toEqual({ present: false, value: null });
    expect(mcpInjectRecordFrom(result)).toEqual({ setByUs: true, previous: { present: false, value: null } });
    expect(result.changedPaths).toEqual([MCP_INJECT_PATH]);
    expect(readMcpInject(readConfig())).toEqual({ present: true, value: true });
    expectForeignEntriesUntouched(before, after);
  });

  it("state 2 — the key is false: previous records false, not absence", async () => {
    seedConfig((config) => {
      daemonOf(config)["mcp"] = { injectIntoAgents: false, servers: { local: { enabled: true } } };
    });

    const result = await apply({ mcpInject: { action: "set", value: true } });

    expect(result.before.mcpInject).toEqual({ present: true, value: false });
    expect(mcpInjectRecordFrom(result).setByUs).toBe(true);
    const mcp = daemonOf(readConfig())["mcp"] as Record<string, unknown>;
    expect(mcp["injectIntoAgents"]).toBe(true);
    // The sibling key inside daemon.mcp is none of our business.
    expect(mcp["servers"]).toEqual({ local: { enabled: true } });
  });

  it("state 3 — the key is already true: nothing is written and setByUs is false", async () => {
    seedConfig((config) => {
      daemonOf(config)["mcp"] = { injectIntoAgents: true };
    });
    const before = readConfigText();
    const adapter = fakeAdapter();

    const result = await apply({ mcpInject: { action: "set", value: true } }, { adapter });

    expect(result.written).toBe(false);
    expect(result.before.mcpInject).toEqual({ present: true, value: true });
    expect(mcpInjectRecordFrom(result)).toEqual({ setByUs: false, previous: { present: true, value: true } });
    expect(adapter.calls).toEqual([]);
    expect(readConfigText()).toBe(before);
  });

  it("state 4 — somebody changed it after the install: the key is left exactly as it is", async () => {
    // paseo-bm turned it on, recording that the key had been absent...
    const installed = await apply({ mcpInject: { action: "set", value: true } });
    const previous = mcpInjectRecordFrom(installed).previous;
    // ...and then the user turned it off again by hand.
    writeFromElsewhere((config) => {
      (daemonOf(config)["mcp"] as Record<string, unknown>)["injectIntoAgents"] = false;
    });
    const before = readConfigText();
    const adapter = fakeAdapter();

    const result = await apply({ mcpInject: { action: "restore", previous, expect: true } }, { adapter });

    expect(result.written).toBe(false);
    expect(result.skippedPaths).toEqual([MCP_INJECT_PATH]);
    expect(adapter.calls).toEqual([]);
    expect(readConfigText()).toBe(before);
    expect(readMcpInject(readConfig())).toEqual({ present: true, value: false });
  });

  it("uninstall removes a key that was absent before, and only that key", async () => {
    const installed = await apply({ pluginsEnabled: true, mcpInject: { action: "set", value: true } });
    const before = readConfigText();

    const result = await apply({
      mcpInject: { action: "restore", previous: mcpInjectRecordFrom(installed).previous, expect: true },
    });
    const after = readConfigText();

    expect(result.changedPaths).toEqual([MCP_INJECT_PATH]);
    expect(readMcpInject(readConfig())).toEqual({ present: false, value: null });
    // A full backup restore would have taken pluginsEnabled with it. Per-key
    // restore leaves everything that happened after the install alone.
    expect(readPluginsEnabled(readConfig())).toEqual({ present: true, value: true, raw: true });
    expectForeignEntriesUntouched(before, after);
  });

  it("uninstall puts a key that was false back to false", async () => {
    seedConfig((config) => {
      daemonOf(config)["mcp"] = { injectIntoAgents: false };
    });
    const installed = await apply({ mcpInject: { action: "set", value: true } });

    await apply({
      mcpInject: { action: "restore", previous: mcpInjectRecordFrom(installed).previous, expect: true },
    });

    expect(readMcpInject(readConfig())).toEqual({ present: true, value: false });
  });
});

describe("pluginsEnabled", () => {
  it("is set at the root and reported as a changed path", async () => {
    const before = readConfigText();
    const result = await apply({ pluginsEnabled: true });
    const after = readConfigText();

    expect(result.before.pluginsEnabled).toEqual({ present: false, value: null, raw: undefined });
    expect(result.changedPaths).toEqual([PLUGINS_ENABLED_PATH]);
    expect(readConfig()[PLUGINS_ENABLED_PATH]).toBe(true);
    expectForeignEntriesUntouched(before, after);
  });
});

/* ------------------------------------------------------- backup + reload */

describe("backup and reload", () => {
  it("backs the file up before writing anything", async () => {
    const result = await apply(ROLE_EDIT);

    expect(result.backupPath).toMatch(new RegExp(`${installHome}/backups/[0-9TZ]+/${CONFIG_BACKUP_NAME}$`));
    expect(readFileSync(result.backupPath!, "utf8")).toBe(FIXTURE_TEXT);
  });

  it("accepts the reload when appliedPaths covers the changed keys", async () => {
    const adapter = fakeAdapter({ appliedPaths: ["pluginsEnabled"] });
    const result = await apply({ pluginsEnabled: true }, { adapter });

    expect(result.verification).toBe("applied-paths");
    expect(adapter.calls).toEqual([1]);
  });

  it("falls back to re-reading the file when appliedPaths is empty", async () => {
    const adapter = fakeAdapter({ appliedPaths: [] });
    const result = await apply({ pluginsEnabled: true }, { adapter });

    expect(result.verification).toBe("re-read");
    expect(readConfig()[PLUGINS_ENABLED_PATH]).toBe(true);
  });

  it("restores the backup and reloads again when the daemon refuses the config", async () => {
    const adapter = fakeAdapter({ fail: true });

    await expect(apply(ROLE_EDIT, { adapter })).rejects.toMatchObject({
      name: "ConfigMutationError",
      reason: "reload-failed",
      restoredFromBackup: true,
    });

    expect(readConfigText()).toBe(FIXTURE_TEXT);
    // One failed reload, then one more to put the daemon back on the old config.
    expect(adapter.calls).toEqual([1, 2]);
  });

  it("restores the backup when the reload succeeds but the change is not in effect", async () => {
    // A daemon that silently rewrites the file it did not like.
    const adapter = fakeAdapter({
      appliedPaths: [],
      onReload: (call) => {
        if (call === 1) {
          writeFileSync(configPath, FIXTURE_TEXT);
        }
      },
    });

    await expect(apply(ROLE_EDIT, { adapter })).rejects.toMatchObject({
      reason: "reload-not-applied",
      restoredFromBackup: true,
    });
    expect(readConfigText()).toBe(FIXTURE_TEXT);
  });
});

/* -------------------------------------------------------- concurrent writes */

describe("concurrent writes", () => {
  it("retries exactly once and keeps the other process's change", async () => {
    const fs = fsWithReadHook((count) => {
      if (count === 1) {
        writeFromElsewhere((config) => {
          (config["app"] as Record<string, unknown>)["theme"] = "dark";
          profilesOf(config).push({ id: "other-added", name: "Added elsewhere", provider: "anthropic" });
        });
      }
    });

    const result = await apply(ROLE_EDIT, { fs });

    expect(result.attempts).toBe(2);
    expect(result.written).toBe(true);
    const config = readConfig();
    expect((config["app"] as Record<string, unknown>)["theme"]).toBe("dark");
    expect(agentProfileIds(config)).toEqual([
      ...FIXTURE_PROFILE_ORDER,
      "other-added",
      "bm-manager",
      "bm-worker",
      "bm-reviewer",
    ]);
  });

  it("stops with E_CONFIG_CONCURRENT_WRITE and keeps the other version when the retry conflicts too", async () => {
    let seen = 0;
    const fs = fsWithReadHook(() => {
      seen += 1;
      writeFromElsewhere((config) => {
        (config["app"] as Record<string, unknown>)["theme"] = `theme-${seen}`;
      });
    });
    const adapter = fakeAdapter();

    const error = await apply(ROLE_EDIT, { fs, adapter }).catch((thrown: unknown) => thrown);

    expect(isConfigMutationError(error)).toBe(true);
    expect(error).toMatchObject({ reason: "concurrent-write", code: "E_CONFIG_CONCURRENT_WRITE" });
    // The other process's file is still there, untouched by us.
    const config = readConfig();
    expect((config["app"] as Record<string, unknown>)["theme"]).toBe(`theme-${seen}`);
    expect(bmProviderIds(config)).toEqual([]);
    expect(agentProfileIds(config)).toEqual(FIXTURE_PROFILE_ORDER);
    expect(adapter.calls).toEqual([]);
  });
});

/* --------------------------------------------------------------- boundaries */

describe("write scope", () => {
  it("writes only Paseo's config.json and things inside the install home", async () => {
    // `record` rather than `block`: the atomic write puts its temporary file
    // next to the target, and the scope in src/fs-guard.ts allows the exact
    // config.json path only. Every write is judged here instead.
    const scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome], mode: "record" });
    try {
      await apply({ ...ROLE_EDIT, pluginsEnabled: true, mcpInject: { action: "set", value: true } }, { fs: scope.fs });

      const stray = scope
        .paths()
        .filter((path) => !isInstallHomePath(path) && !isConfigOrItsTempFile(path));
      expect(stray).toEqual([]);
      expect(scope.paths()).toContain(realConfigPath);
    } finally {
      scope.restore();
    }
  });
});

function isInstallHomePath(path: string): boolean {
  return path === realInstallHome || path.startsWith(`${realInstallHome}/`);
}

/**
 * What a write inside Paseo's home is allowed to be: the config file, the
 * temporary file the atomic write renames over it, and a `mkdir -p` of the
 * home itself, which `writeFileAtomic` issues for the target's parent and which
 * creates nothing because the directory is already there.
 */
function isConfigOrItsTempFile(path: string): boolean {
  if (path === realConfigPath || path === realPaseoHome) {
    return true;
  }
  return new RegExp(`^${realPaseoHome}/\\.config\\.json\\.\\d+\\.[0-9a-f]+\\.tmp$`).test(path);
}

describe("the restart ban", () => {
  it("never mentions a daemon restart or stop anywhere in the module", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/paseo/config.ts", import.meta.url)), "utf8");
    // ADR-004 decision 5: restarting the daemon can kill a running agent.
    expect(source).not.toMatch(/daemonRestart|daemonStop|"restart"|'restart'/);
  });
});
