/**
 * M-5 end to end for bead bm-tm2: install, then uninstall, on a `config.json`
 * that has no `pluginsEnabled` and no `agents` — the state the Phase 1a
 * acceptance run started from. Afterwards the file must match the one from
 * before the install key for key, apart from the `plugins` key Paseo keeps.
 *
 * The install is the real handler driven through `runCli` with the fake `paseo`
 * (test/helpers/install-harness.ts); the uninstall is the real `runUninstall`
 * on the same fake daemon. No real `paseo`, no real HOME.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runUninstall } from "../src/commands/uninstall.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import type { PaseoAdapter } from "../src/paseo/adapter.js";
import { ScriptedPrompter } from "../src/prompter.js";
import { parseRecord } from "../src/record.js";
import type { Fixture } from "./helpers/install-harness.js";
import {
  FAKE_DIR,
  NO_TTY,
  createFixture,
  daemonAdapter,
  removeFixture,
  runInstall,
  seedCompleteSkills,
  writePaseoConfig,
  writePayload,
} from "./helpers/install-harness.js";
import { startWriteScope } from "./helpers/write-scope.js";

vi.setConfig({ testTimeout: 30_000 });

const VERSION = "0.2.0";
let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture("uninstall-restore");
  writePayload(fixture, VERSION);
  seedCompleteSkills(fixture);
});

afterEach(() => {
  removeFixture(fixture);
});

const configFile = (): string => join(fixture.paseoHome, "config.json");
const readConfig = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), "utf8")) as Record<string, unknown>;

function withoutPlugins(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => key !== "plugins"));
}

/** The fake daemon for uninstall: `plugin remove` behaves like Paseo 0.8.0 and leaves `plugins: {}`. */
function uninstallAdapter(): PaseoAdapter {
  const env = { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}`, BM_FAKE_ARGV_LOG: fixture.argvLog, BM_FAKE_SCRIPT: fixture.scriptFile };
  const base = daemonAdapter(fixture, env);
  return {
    ...base,
    pluginRemove: async (id) => {
      fixture.daemon.pluginDir = null;
      writeFileSync(configFile(), `${JSON.stringify({ ...readConfig(), plugins: {} }, null, 2)}\n`);
      return { id, raw: null };
    },
  };
}

describe("M-5 — install then uninstall restores config.json key for key (bm-tm2)", () => {
  it.each([
    ["an empty config", {}, ["agents", "agents.providers", "daemon", "daemon.agentProfiles", "daemon.mcp"]],
    ["a config with only daemon.listen", { daemon: { listen: "127.0.0.1:7777" } }, ["agents", "agents.providers", "daemon.agentProfiles", "daemon.mcp"]],
    [
      "pluginsEnabled false and an existing daemon.mcp",
      { pluginsEnabled: false, daemon: { listen: "127.0.0.1:7777", mcp: { transport: "stdio" } } },
      ["agents", "agents.providers", "daemon.agentProfiles"],
    ],
  ])("%s", async (_label, before, expectedContainers) => {
    writePaseoConfig(fixture, before);

    /* -- install, with consent -------------------------------------------- */
    const installed = await runInstall(fixture, ["install", "--apply", "--enable-plugins"], { version: VERSION, tty: NO_TTY, guard: "record" });
    expect(installed.thrown).toBeUndefined();
    expect(installed.code).toBe(EXIT_CODES.ok);
    expect(readConfig()["pluginsEnabled"]).toBe(true);

    const record = parseRecord(readFileSync(join(fixture.installHome, "install.json"), "utf8"));
    const wasPresent = "pluginsEnabled" in before;
    expect(record.paseo.pluginsEnabledSetByUs).toBe(true);
    expect(record.paseo.pluginsEnabledPrevious).toEqual(wasPresent ? { present: true, value: false } : { present: false, value: null });
    expect(record.paseo.createdConfigContainers).toEqual(expectedContainers);

    /* -- uninstall, interactive: yes, turn plugins off, drop backups -------- */
    const scope = startWriteScope({ installHome: fixture.installHome, paseoHome: fixture.paseoHome, watch: [fixture.home], mode: "record" });
    const prompter = new ScriptedPrompter({ confirm: [true, true, true] });
    let out = "";
    let outcome;
    try {
      outcome = await runUninstall({
        adapter: uninstallAdapter(),
        layoutInput: { homeDir: fixture.home, env: {} },
        prompter,
        apply: true,
        json: true,
        version: VERSION,
        stdout: (text) => {
          out += text;
        },
        stderr: () => undefined,
        fs: scope.fs,
        platform: "darwin",
        nodeVersion: "22.9.0",
        lockOptions: { handleSignals: false },
      });
    } finally {
      scope.restore();
    }

    expect(outcome.exitCode).toBe(EXIT_CODES.ok);
    expect(prompter.counts.confirm).toBe(3);
    expect(out.length).toBeGreaterThan(0);

    // Nothing written outside the install home and config.json (and its atomic temp sibling).
    const paseoDir = realpathSync(fixture.paseoHome);
    const stray = scope.violations.filter((write) => {
      const isPaseoHome = write.canonicalPath === paseoDir || write.path === fixture.paseoHome;
      const isConfigTemp =
        (dirname(write.path) === paseoDir || dirname(write.path) === fixture.paseoHome) &&
        /^\.config\.json\.\d+\.[0-9a-f]+\.tmp$/.test(write.path.split("/").pop() ?? "");
      return !((write.kind === "make-dir" && isPaseoHome) || isConfigTemp);
    });
    expect(stray.map((write) => `${write.call} ${write.path}`)).toEqual([]);

    // Key for key and in order, apart from Paseo's own `plugins` key.
    const after = readConfig();
    expect(after["plugins"]).toEqual({});
    expect(JSON.stringify(withoutPlugins(after))).toBe(JSON.stringify(before));
    expect(existsSync(fixture.installHome)).toBe(false);
  });
});
