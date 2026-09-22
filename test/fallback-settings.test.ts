import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { roleConfigRevision, type RoleConfigView } from "../plugin/server/config-writer";
import {
  ROLE_FALLBACK_FILE,
  fallbackAliasEntry,
  fallbackForSettings,
  handleRolesSaveFallback,
  readRoleFallback,
} from "../plugin/server/fallback-settings";
import { forgetModelCosts } from "../plugin/server/model-costs";
import { forgetModes } from "../plugin/server/role-mode";
import type { RolesSaveFallbackInput } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.4.1–§4.4.3 (REQ-065 f): a role's fallback chain is saved
 * as aliases in Paseo's config (through the config writer) and as the user's
 * own `role-fallback.json`. Fake daemon, temporary install home.
 */

type Providers = Record<string, Record<string, unknown>>;
type Profile = Record<string, unknown>;

const MODES: Record<string, unknown[]> = {
  claude: [
    { id: "default", label: "Default", colorTier: "safe" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
  ],
  codex: [
    { id: "auto", label: "Auto", colorTier: "moderate" },
    { id: "full-access", label: "Full access", colorTier: "dangerous" },
  ],
  pi: [],
};
const MODELS: Record<string, unknown[]> = {
  claude: [
    { id: "claude-opus-5", label: "Opus 5", thinkingOptions: [{ id: "high", label: "High" }] },
    { id: "claude-sonnet-5", label: "Sonnet 5", thinkingOptions: [] },
  ],
  codex: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", thinkingOptions: [{ id: "high", label: "High" }] }],
  pi: [{ id: "pi-default", label: "Pi" }],
};

function fakeDaemon(providers: Providers = {}) {
  const state: { providers: Providers; agentProfiles: Profile[] } = {
    providers: {
      claude: { enabled: true },
      "bm-worker": { extends: "claude", label: "Beads Worker", paseoTools: { enabled: true } },
      "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
      ...providers,
    },
    agentProfiles: [
      { id: "mine", name: "Mine", provider: "claude", model: "claude-opus-5" },
      { id: "bm-worker", name: "Worker", provider: "bm-worker", model: "claude-opus-5" },
      { id: "bm-reviewer", name: "Reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol" },
    ],
  };
  const patches: Array<Record<string, unknown>> = [];
  const paseo = {
    providers: {
      listAvailable: vi.fn(async () => ({ providers: ["claude", "codex", "pi"].map((provider) => ({ provider, available: true })) })),
      listModels: vi.fn(async (provider: string) => ({ provider, models: MODELS[provider] ?? [], error: null })),
      listModes: vi.fn(async (provider: string) => ({ provider, modes: MODES[provider] ?? [], error: null })),
    },
    config: {
      get: vi.fn(async () => ({ config: structuredClone(state) as RoleConfigView })),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        patches.push(structuredClone(patch));
        for (const [id, entry] of Object.entries((patch.providers ?? {}) as Providers)) state.providers[id] = { ...(state.providers[id] ?? {}), ...entry };
        for (const id of (patch.removeProviders as string[] | undefined) ?? []) delete state.providers[id];
        if (patch.agentProfiles !== undefined) state.agentProfiles = structuredClone(patch.agentProfiles as Profile[]);
        return {};
      }),
    },
  };
  return { paseo, state, patches, revision: () => roleConfigRevision(state as RoleConfigView) };
}

const CODEX = { baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: "full-access" };
const PI = { baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null };

let root: string;
let home: string;
let logged: string[];
const log = (message: string) => void logged.push(message);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-settings-"));
  home = join(root, ".paseo-bm");
  mkdirSync(home);
  logged = [];
  forgetModes();
  forgetModelCosts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const save = (daemon: ReturnType<typeof fakeDaemon>, input: Partial<RolesSaveFallbackInput>) =>
  handleRolesSaveFallback({ revision: daemon.revision(), role: "worker", policy: "ask", entries: [], ...input } as RolesSaveFallbackInput, daemon.paseo, {
    log,
    home,
  });

describe("roles.save-fallback", () => {
  it("writes one alias per entry, then role-fallback.json (0600), and returns the chain as the screen shows it", async () => {
    const daemon = fakeDaemon();
    const result = await save(daemon, { entries: [CODEX, PI] });
    expect(daemon.patches).toEqual([
      {
        providers: {
          "bm-worker-fallback-1": { extends: "codex", label: "Worker (fallback 1)", paseoTools: { enabled: true } },
          "bm-worker-fallback-2": { extends: "pi", label: "Worker (fallback 2)", paseoTools: { enabled: true } },
        },
      },
    ]);
    const path = join(home, ROLE_FALLBACK_FILE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, roles: { worker: { policy: "ask", entries: [CODEX, PI] } } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(result.revision).toBe(daemon.revision());
    expect(result.fallback).toMatchObject({
      role: "worker",
      policy: "ask",
      patternsFromFile: false,
      entries: [
        { position: 1, alias: "bm-worker-fallback-1", ...CODEX, capability: "tiered" },
        { position: 2, alias: "bm-worker-fallback-2", ...PI, capability: "none" },
      ],
    });
    // Every profile is untouched: an alias write never sends the profile array.
    expect(daemon.patches[0]).not.toHaveProperty("agentProfiles");
  });

  it("renumbers when entry 1 is removed: alias 1 takes entry 2's provider, alias 2 is removed", async () => {
    const daemon = fakeDaemon();
    await save(daemon, { entries: [CODEX, PI] });
    await save(daemon, { entries: [PI] });
    expect(daemon.patches[1]).toEqual({
      providers: { "bm-worker-fallback-1": { extends: "pi", label: "Worker (fallback 1)", paseoTools: { enabled: true } } },
      removeProviders: ["bm-worker-fallback-2"],
    });
    expect(Object.keys(daemon.state.providers).filter((id) => id.startsWith("bm-worker-fallback"))).toEqual(["bm-worker-fallback-1"]);
    expect(JSON.parse(readFileSync(join(home, ROLE_FALLBACK_FILE), "utf8")).roles.worker.entries).toEqual([PI]);
  });

  it("changes only the file when the aliases already match (policy off)", async () => {
    const daemon = fakeDaemon();
    await save(daemon, { entries: [CODEX] });
    await save(daemon, { entries: [CODEX], policy: "off" });
    expect(daemon.patches).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, ROLE_FALLBACK_FILE), "utf8")).roles.worker.policy).toBe("off");
  });

  it.each([
    ["two entries with the same provider and model", { entries: [CODEX, CODEX] }],
    ["an entry equal to the Worker itself", { entries: [{ baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: null }] }],
    ["a role that is not paseo-bm's", { role: "planner" as never, entries: [PI] }],
    ["a policy that does not exist", { policy: "sometimes" as never }],
    ["a model the provider does not list", { entries: [{ ...CODEX, model: "gpt-9" }] }],
    ["a bm-* alias as base provider", { entries: [{ ...CODEX, baseProvider: "bm-reviewer" }] }],
    ["four entries", { entries: [CODEX, PI, CODEX, PI] }],
  ])("refuses %s with E_ROLE_SETTINGS_INVALID, writing nothing", async (_label, input) => {
    const daemon = fakeDaemon();
    await expect(save(daemon, input)).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
    expect(daemon.paseo.config.patch).not.toHaveBeenCalled();
    expect(() => readFileSync(join(home, ROLE_FALLBACK_FILE))).toThrow();
  });

  it("saves the Auto switch policy since phase 2a-18 (§4.6, owner decision Q17 b)", async () => {
    const daemon = fakeDaemon();
    const result = await save(daemon, { entries: [CODEX], policy: "auto" });
    expect(result.fallback.policy).toBe("auto");
    expect(JSON.parse(readFileSync(join(home, ROLE_FALLBACK_FILE), "utf8")).roles.worker.policy).toBe("auto");
  });

  it("warns, never refuses, for an entry on the Worker's own base provider", async () => {
    const daemon = fakeDaemon();
    const result = await save(daemon, { entries: [{ baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: null, modeId: null }] });
    expect(result.warnings).toEqual(["Fallback 1 runs on claude like the Worker itself: it only helps when the limit is per model."]);
  });

  it("refuses a stale revision with E_ROLE_SETTINGS_CONFLICT and leaves the file alone", async () => {
    const daemon = fakeDaemon();
    const stale = daemon.revision();
    daemon.state.agentProfiles[0] = { ...daemon.state.agentProfiles[0], model: "claude-sonnet-5" };
    await expect(save(daemon, { revision: stale, entries: [CODEX] })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_CONFLICT" });
    expect(daemon.paseo.config.patch).not.toHaveBeenCalled();
    expect(() => readFileSync(join(home, ROLE_FALLBACK_FILE))).toThrow();
  });

  it("never overwrites an invalid role-fallback.json: the save is refused and the file kept byte for byte", async () => {
    const daemon = fakeDaemon();
    writeFileSync(join(home, ROLE_FALLBACK_FILE), '{"version": 1, "patterns": {"L1": ["my limit"]}, "roles": {"worker": {"policy": "sometimes"}}}');
    await expect(save(daemon, { entries: [CODEX] })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
    expect(readFileSync(join(home, ROLE_FALLBACK_FILE), "utf8")).toContain('"sometimes"');
    expect(daemon.paseo.config.patch).not.toHaveBeenCalled();
  });

  it("keeps the keys it does not own (hand-edited patterns) when it rewrites the file", async () => {
    const daemon = fakeDaemon();
    writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: {}, patterns: { L1: ["my limit"] } }));
    const result = await save(daemon, { entries: [PI] });
    expect(JSON.parse(readFileSync(join(home, ROLE_FALLBACK_FILE), "utf8"))).toEqual({
      version: 1,
      roles: { worker: { policy: "ask", entries: [PI] } },
      patterns: { L1: ["my limit"] },
    });
    expect(result.fallback.patternsFromFile).toBe(true);
  });

  it("refuses to write through a symlinked install home", async () => {
    const daemon = fakeDaemon();
    const outside = join(root, "outside");
    mkdirSync(outside);
    rmSync(home, { recursive: true });
    symlinkSync(outside, home);
    await expect(save(daemon, { entries: [PI] })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_WRITE_FAILED" });
    expect(() => readFileSync(join(outside, ROLE_FALLBACK_FILE))).toThrow();
  });

  it("reports an install home it cannot find as E_ROLE_SETTINGS_WRITE_FAILED", async () => {
    const daemon = fakeDaemon();
    await expect(
      handleRolesSaveFallback({ revision: daemon.revision(), role: "worker", policy: "ask", entries: [] }, daemon.paseo, { log, home: null }),
    ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_WRITE_FAILED" });
  });
});

describe("the Reviewer's chain (phase 2a-17, §4.5.1)", () => {
  it("saves a Reviewer alias WITHOUT Paseo tools (ADR-006 D3)", async () => {
    const daemon = fakeDaemon();
    const sonnet = { baseProvider: "claude", model: "claude-sonnet-5", thinkingOptionId: null, modeId: "default" };
    await save(daemon, { role: "reviewer", entries: [sonnet] });
    expect(daemon.patches.at(-1)).toEqual({ providers: { "bm-reviewer-fallback-1": { extends: "claude", label: "Reviewer (fallback 1)" } } });
    expect(daemon.state.providers["bm-reviewer-fallback-1"]).not.toHaveProperty("paseoTools");
  });

  it("refuses a dangerous mode for a Reviewer entry, as for the Reviewer itself", async () => {
    const daemon = fakeDaemon();
    await expect(save(daemon, { role: "reviewer", entries: [{ ...CODEX, modeId: "full-access" }] })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
  });
});

describe("fallback aliases", () => {
  it("give Manager and Worker aliases Paseo tools, and NEVER a Reviewer alias (ADR-006 D3)", () => {
    expect(fallbackAliasEntry("worker", 1, "codex")).toEqual({ extends: "codex", label: "Worker (fallback 1)", paseoTools: { enabled: true } });
    expect(fallbackAliasEntry("manager", 3, "claude")).toEqual({ extends: "claude", label: "Manager (fallback 3)", paseoTools: { enabled: true } });
    expect(fallbackAliasEntry("reviewer", 2, "pi")).toEqual({ extends: "pi", label: "Reviewer (fallback 2)" });
  });
});

describe("role-fallback.json and roles.settings", () => {
  it("reads a missing file as the defaults, silently", () => {
    expect(readRoleFallback(home, log)).toEqual({ file: { version: 1, roles: {} }, raw: null, error: null });
    expect(logged).toEqual([]);
  });

  it("reads a corrupt file as the defaults, with one log line and a warning on the screen", async () => {
    writeFileSync(join(home, ROLE_FALLBACK_FILE), "{broken");
    const read = readRoleFallback(home, log);
    expect(read.file).toEqual({ version: 1, roles: {} });
    expect(read.error).toMatch(/^not JSON/);
    expect(logged).toHaveLength(1);
    const daemon = fakeDaemon();
    const settings = await fallbackForSettings(daemon.paseo, { log, home });
    expect(settings.fallback).toEqual({
      worker: { role: "worker", policy: "ask", entries: [], patternsFromFile: false },
      reviewer: { role: "reviewer", policy: "ask", entries: [], patternsFromFile: false },
      manager: { role: "manager", policy: "ask", entries: [], patternsFromFile: false },
    });
    expect(settings.warnings).toHaveLength(1);
    expect(settings.warnings[0]).toMatch(/^role-fallback\.json is not valid/);
  });

  it("shows the chain of every role this release offers: all three since phase 2a-17", async () => {
    const daemon = fakeDaemon();
    await save(daemon, { entries: [CODEX] });
    const settings = await fallbackForSettings(daemon.paseo, { log, home });
    expect(Object.keys(settings.fallback ?? {})).toEqual(["worker", "reviewer", "manager"]);
    expect(settings.fallback?.worker?.entries.map((entry) => entry.alias)).toEqual(["bm-worker-fallback-1"]);
  });
});
