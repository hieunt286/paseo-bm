import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetModelCosts } from "../plugin/server/model-costs";
import { noticeQueue } from "../plugin/server/notice-queue";
import { LOOKUP_TIMEOUT_MS, forgetModes } from "../plugin/server/role-mode";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { BASE_INSTRUCTIONS, HAND_PATH_HEADING, OWNER_PRECEDENTS_HEADING, RUNTIME_FACTS_HEADING, currentInstructions } from "../plugin/server/role-instructions";
import { PRECEDENT_SCOPE_ALL } from "../plugin/shared/precedents";
import {
  canonicalJson,
  handleRolesInstructions,
  handleRolesOptions,
  handleRolesSaveSettings,
  handleRolesSettings,
  registerRoleSettingsRpcs,
  roleSettingsRevision,
  sharedPlanWarning,
} from "../plugin/server/role-settings-rpc";
import { DashboardError, rolesOptionsRpc, rolesSettingsRpc } from "../plugin/shared/contracts";
import { fakePaseo, type FakeApi, type FakePaseo } from "./helpers/fake-paseo";

/**
 * Delta 20260921 §4.3.2 (REQ-064 a/b): `roles.settings` and `roles.options`,
 * against a fake Paseo SDK whose providers cover the capability classes:
 * Claude (`tiered`), OpenCode (`untiered`), Pi (`none`) and a provider whose
 * modes answer an error (`unknown`). Nothing here touches a real daemon.
 */

// roles.settings now reads the fallback chains from the install home (delta
// 20260921 §4.4.3): point $HOME at an empty directory so this machine's real
// ~/.paseo-bm is never read. No install home there, so the chains are the defaults.
const realHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "bm-role-settings-home-"));
beforeAll(() => {
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

/** The chains when nothing is saved: ask, no entry (the Worker's since phase 2a-16, the Reviewer's and the Manager's since 2a-17). */
const DEFAULT_FALLBACK = {
  worker: { role: "worker", policy: "ask", entries: [], patternsFromFile: false },
  reviewer: { role: "reviewer", policy: "ask", entries: [], patternsFromFile: false },
  manager: { role: "manager", policy: "ask", entries: [], patternsFromFile: false },
};

const FETCHED_AT = "2026-09-22T08:00:00.000Z";

const modeList = (provider: string, modes: unknown[], error: string | null = null) => ({
  provider,
  modes,
  error,
  fetchedAt: FETCHED_AT,
  requestId: "r-modes",
});

const modelList = (provider: string, models: unknown[], error: string | null = null) => ({
  provider,
  models,
  error,
  fetchedAt: FETCHED_AT,
  requestId: "r-models",
});

const MODES: Record<string, unknown> = {
  claude: modeList("claude", [
    { id: "plan", label: "Plan", colorTier: "planning" },
    { id: "default", label: "Default", colorTier: "safe" },
    { id: "acceptEdits", label: "Accept edits", colorTier: "moderate" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
  ]),
  codex: modeList("codex", [
    { id: "auto", label: "Auto", colorTier: "moderate" },
    { id: "full-access", label: "Full access", colorTier: "dangerous" },
  ]),
  // OpenCode's modes are the user's own OpenCode agents: no colorTier (F1).
  opencode: modeList("opencode", [
    { id: "build", label: "Build" },
    { id: "review", label: "" },
    { id: "", label: "nameless" },
    { id: "build", label: "Build again" },
  ]),
  // Pi has no modes at all: an empty list WITHOUT an error (F1, F3).
  pi: modeList("pi", []),
  // Modes that cannot be read: `unknown`.
  warming: modeList("warming", [], "provider is still starting"),
};

const OPUS = {
  provider: "claude",
  id: "claude-opus-5",
  label: "Opus 5",
  thinkingOptions: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", description: "slower" },
  ],
  defaultThinkingOptionId: "high",
  metadata: { cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } } },
};

/** No label, a default flagged on the option, an option without an id, and no listed rate. */
const HAIKU = {
  provider: "claude",
  id: "claude-haiku-5",
  label: "",
  thinkingOptions: [{ id: "on", label: "On", isDefault: true }, { label: "no id" }, { id: "off", label: "" }],
};

const MODELS: Record<string, unknown> = {
  claude: modelList("claude", [OPUS, HAIKU, { label: "a model without an id" }, { ...OPUS, label: "Opus 5 again" }, null]),
  codex: modelList("codex", [{ provider: "codex", id: "gpt-5.6-sol", label: "GPT-5.6-Sol", thinkingOptions: [] }]),
  // An OpenCode id carries `/`; no `cache.read` means cache reads cost the input rate.
  opencode: modelList("opencode", [
    { provider: "opencode", id: "anthropic/claude-sonnet-4-6", label: "Sonnet 4.6", metadata: { cost: { input: 3, output: 15 } } },
  ]),
  pi: modelList("pi", [{ provider: "pi", id: "pi-default", label: "Pi" }]),
  warming: modelList("warming", [], "provider is still starting"),
};

const FEATURES: Record<string, unknown> = {
  opencode: { provider: "opencode", features: [{ type: "toggle", id: "auto_accept", label: "Auto-accept", value: false }] },
};

const CONFIG = {
  providers: {
    claude: { enabled: true },
    opencode: { enabled: true },
    "bm-manager": { extends: "claude", label: "Beads Manager", paseoTools: { enabled: true } },
    "bm-worker": { extends: "opencode", label: "Beads Worker", paseoTools: { enabled: true } },
    "bm-reviewer": { extends: "pi", label: "Beads Reviewer" },
    "bm-orchestrator": { extends: "codex", label: "Beads Orchestrator" },
  },
  agentProfiles: [
    { id: "mine", name: "My own", provider: "claude", model: "claude-opus-5" },
    {
      id: "bm-manager",
      name: "Beads Manager",
      provider: "bm-manager",
      model: "claude-opus-5",
      thinkingOptionId: "high",
      modeId: "bypassPermissions",
      notes: "installed by paseo-bm",
    },
    { id: "bm-worker", name: "Beads Worker", provider: "bm-worker", model: "anthropic/claude-sonnet-4-6", featureValues: { auto_accept: true } },
    { id: "bm-reviewer", name: "Beads Reviewer", provider: "bm-reviewer", model: "pi-default", thinkingOptionId: "  " },
    { id: "bm-orchestrator", name: "Beads Orchestrator", provider: "bm-orchestrator", model: "gpt-5.6-sol" },
  ],
};

interface FakeOptions {
  config?: unknown;
  configError?: Error;
  modes?: Record<string, unknown>;
  models?: Record<string, unknown>;
  features?: Record<string, unknown>;
}

/** Looks `key` up in `table`: an Error there is thrown, a missing key is `fallback`. */
function answer(table: Record<string, unknown>, key: string, fallback: unknown): unknown {
  const value = table[key];
  if (value instanceof Error) throw value;
  return value ?? fallback;
}

/**
 * The shared fake SDK with the lookups these tests read: each provider's modes,
 * models and features, and the configuration (or an error reading it). This
 * host has no `listAvailable`: Paseo cannot say which providers exist.
 */
function daemonWith(options: FakeOptions = {}) {
  const modes = options.modes ?? MODES;
  const models = options.models ?? MODELS;
  const features = options.features ?? FEATURES;
  const fake = fakePaseo({
    config: options.configError ?? ((options.config ?? CONFIG) as Record<string, unknown>),
    providers: {
      modes: (provider) => answer(modes, provider, modeList(provider, [], `unknown provider ${provider}`)),
      models: (provider) => answer(models, provider, modelList(provider, [], `unknown provider ${provider}`)),
      features: (provider) => answer(features, provider, { provider, features: [] }),
    },
    omit: ["providers.listAvailable"],
  });
  const { listModes, listModels, listFeatures } = fake.api.providers;
  return { ...fake, listModes, listModels, listFeatures, get: fake.api.config.get, patch: fake.api.config.patch };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let logged: string[];
const log = (message: string) => void logged.push(message);

beforeEach(() => {
  logged = [];
  forgetModelCosts();
  forgetModes();
});

afterEach(() => {
  vi.useRealTimers();
  noticeQueue.clear();
});

describe("roleSettingsRevision", () => {
  it("is sha256 of the canonical JSON of the bm-* providers and the whole profile array", () => {
    const expected = sha256(
      canonicalJson({
        providers: {
          "bm-manager": CONFIG.providers["bm-manager"],
          "bm-worker": CONFIG.providers["bm-worker"],
          "bm-reviewer": CONFIG.providers["bm-reviewer"],
          "bm-orchestrator": CONFIG.providers["bm-orchestrator"],
        },
        profiles: CONFIG.agentProfiles,
      }),
    );
    expect(roleSettingsRevision(CONFIG)).toBe(expected);
    expect(roleSettingsRevision(CONFIG)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order of object keys, at any depth", () => {
    const reordered = {
      agentProfiles: CONFIG.agentProfiles.map((profile) => Object.fromEntries(Object.entries(profile).reverse())),
      providers: Object.fromEntries(
        Object.entries(CONFIG.providers)
          .reverse()
          .map(([id, entry]) => [id, Object.fromEntries(Object.entries(entry).reverse())]),
      ),
    };
    expect(roleSettingsRevision(reordered)).toBe(roleSettingsRevision(CONFIG));
    expect(canonicalJson({ b: { d: 1, c: [{ f: 2, e: 3 }] }, a: null })).toBe('{"a":null,"b":{"c":[{"e":3,"f":2}],"d":1}}');
  });

  it("ignores providers that are not bm-*, and nothing else", () => {
    const base = roleSettingsRevision(CONFIG);
    expect(roleSettingsRevision({ ...CONFIG, providers: { ...CONFIG.providers, claude: { enabled: false }, codex: {} } })).toBe(base);
    // A bm-* provider, including a future fallback alias, is in it.
    expect(roleSettingsRevision({ ...CONFIG, providers: { ...CONFIG.providers, "bm-worker": { extends: "codex" } } })).not.toBe(base);
    expect(roleSettingsRevision({ ...CONFIG, providers: { ...CONFIG.providers, "bm-worker-fallback-1": { extends: "codex" } } })).not.toBe(base);
    // Every profile is in it, the user's own too: a write replaces the whole array.
    const [mine, ...rest] = CONFIG.agentProfiles;
    expect(roleSettingsRevision({ ...CONFIG, agentProfiles: [{ ...mine!, model: "other" }, ...rest] })).not.toBe(base);
    // The array's order is content.
    expect(roleSettingsRevision({ ...CONFIG, agentProfiles: [...rest, mine!] })).not.toBe(base);
  });

  it("reads a missing or malformed view as empty", () => {
    const empty = sha256('{"profiles":[],"providers":{}}');
    expect(roleSettingsRevision({})).toBe(empty);
    expect(roleSettingsRevision(null)).toBe(empty);
    expect(roleSettingsRevision({ providers: null, agentProfiles: null })).toBe(empty);
    expect(roleSettingsRevision({ providers: { claude: {} }, agentProfiles: undefined })).toBe(empty);
  });
});

describe("roles.settings", () => {
  it("describes the four roles from config.providers and config.agentProfiles, with each capability class", async () => {
    const { paseo, patch } = daemonWith();
    const result = await handleRolesSettings(paseo, { log });
    expect(result).toEqual({
      revision: roleSettingsRevision(CONFIG),
      roles: [
        {
          role: "manager",
          providerId: "bm-manager",
          baseProvider: "claude",
          label: "Beads Manager",
          model: "claude-opus-5",
          thinkingOptionId: "high",
          modeId: "bypassPermissions",
          featureValues: {},
          capability: "tiered",
        },
        {
          role: "worker",
          providerId: "bm-worker",
          baseProvider: "opencode",
          label: "Beads Worker",
          model: "anthropic/claude-sonnet-4-6",
          thinkingOptionId: null,
          modeId: null,
          featureValues: { auto_accept: true },
          capability: "untiered",
        },
        {
          role: "reviewer",
          providerId: "bm-reviewer",
          baseProvider: "pi",
          label: "Beads Reviewer",
          model: "pi-default",
          thinkingOptionId: null,
          modeId: null,
          featureValues: {},
          capability: "none",
        },
        {
          role: "orchestrator",
          providerId: "bm-orchestrator",
          baseProvider: "codex",
          label: "Beads Orchestrator",
          model: "gpt-5.6-sol",
          thinkingOptionId: null,
          modeId: null,
          featureValues: {},
          capability: "tiered",
        },
      ],
      // The Orchestrator has no fallback chain (orchestrator design §3.1).
      fallback: DEFAULT_FALLBACK,
      warnings: [],
      // No listAvailable on this fake: Paseo cannot say, so nothing to pick.
      providers: [],
    });
    expect(rolesSettingsRpc.output.parse(result)).toEqual(result);
    expect(patch).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("gives a missing role null fields and capability unknown, without a lookup", async () => {
    const config = {
      providers: { "bm-manager": { extends: "claude", label: "Beads Manager" } },
      // A profile without its provider, and junk entries that are skipped.
      agentProfiles: [null, "junk", { id: "bm-worker", provider: "bm-worker", model: "gpt-5.6-sol", featureValues: ["not", "a", "record"] }],
    };
    const { paseo, listModes } = daemonWith({ config });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.map((role) => role.role)).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
    expect(result.roles[1]).toEqual({
      role: "worker",
      providerId: "bm-worker",
      baseProvider: null,
      label: null,
      model: "gpt-5.6-sol",
      thinkingOptionId: null,
      modeId: null,
      featureValues: {},
      capability: "unknown",
    });
    expect(result.roles[2]).toEqual({
      role: "reviewer",
      providerId: "bm-reviewer",
      baseProvider: null,
      label: null,
      model: null,
      thinkingOptionId: null,
      modeId: null,
      featureValues: {},
      capability: "unknown",
    });
    expect(listModes.mock.calls.map((call) => call[0])).toEqual(["claude"]);
    expect(result.revision).toBe(roleSettingsRevision(config));
    expect(result.fallback).toEqual(DEFAULT_FALLBACK);
  });

  it("describes every role as missing on a daemon without paseo-bm roles", async () => {
    const { paseo, listModes } = daemonWith({ config: { providers: { claude: {} }, agentProfiles: [] } });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.every((role) => role.baseProvider === null && role.model === null && role.capability === "unknown")).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(listModes).not.toHaveBeenCalled();
  });

  it("warns that the Manager and the Worker share a plan exactly when they extend the same base provider", async () => {
    const withWorkerOn = (base: string | undefined) => ({
      ...CONFIG,
      providers: { ...CONFIG.providers, "bm-worker": base === undefined ? undefined : { extends: base, label: "Beads Worker" } },
    });
    const warningsFor = async (config: unknown) => (await handleRolesSettings(daemonWith({ config }).paseo, { log })).warnings;

    expect(await warningsFor(withWorkerOn("claude"))).toEqual([
      "Manager and Worker share the claude plan: if the Worker hits its limit, the Manager stops too.",
    ]);
    expect(sharedPlanWarning("codex")).toBe("Manager and Worker share the codex plan: if the Worker hits its limit, the Manager stops too.");
    // Different providers, a Worker without a provider, and the Reviewer sharing the Manager's: no warning.
    expect(await warningsFor(withWorkerOn("opencode"))).toEqual([]);
    expect(await warningsFor(withWorkerOn(undefined))).toEqual([]);
    expect(
      await warningsFor({ ...CONFIG, providers: { ...CONFIG.providers, "bm-reviewer": { extends: "claude" } } }),
    ).toEqual([]);
    // Neither role configured: no warning either (null is not a shared provider).
    expect(await warningsFor({ providers: {}, agentProfiles: [] })).toEqual([]);
  });

  it("looks the capability up once per distinct base provider, and reports unknown when the modes cannot be read", async () => {
    const config = {
      ...CONFIG,
      providers: {
        "bm-manager": { extends: "warming" },
        "bm-worker": { extends: "claude" },
        "bm-reviewer": { extends: "claude" },
      },
    };
    const { paseo, listModes } = daemonWith({ config });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.map((role) => role.capability)).toEqual(["unknown", "tiered", "tiered", "unknown"]);
    expect(listModes.mock.calls.map((call) => call[0]).sort()).toEqual(["claude", "warming"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[paseo-bm\] could not read the modes of warming \(provider is still starting\)/);
  });

  it("never throws when the configuration cannot be read: four empty roles, a warning and one log line", async () => {
    const { paseo, listModes } = daemonWith({ configError: new Error("daemon went away") });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.map((role) => [role.role, role.baseProvider, role.model, role.capability])).toEqual([
      ["manager", null, null, "unknown"],
      ["worker", null, null, "unknown"],
      ["reviewer", null, null, "unknown"],
      ["orchestrator", null, null, "unknown"],
    ]);
    expect(result.fallback).toEqual(DEFAULT_FALLBACK);
    expect(result.warnings).toEqual([
      "paseo-bm could not read the Paseo configuration (daemon went away); reopen Roles & models to try again.",
    ]);
    // The revision of an empty configuration: a save sent with it cannot match a configuration that has roles.
    expect(result.revision).toBe(roleSettingsRevision({}));
    expect(result.revision).not.toBe(roleSettingsRevision(CONFIG));
    expect(logged).toEqual(["[paseo-bm] could not read the Paseo configuration for Roles & models (daemon went away)."]);
    expect(listModes).not.toHaveBeenCalled();
    expect(rolesSettingsRpc.output.parse(result)).toEqual(result);
  });

  it("gives up on a configuration read after the lookup budget", async () => {
    vi.useFakeTimers();
    const paseo = { config: { get: () => new Promise(() => undefined) } };
    const pending = handleRolesSettings(paseo, { log });
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
    const result = await pending;
    expect(result.roles.every((role) => role.baseProvider === null)).toBe(true);
    expect(logged).toEqual([
      `[paseo-bm] could not read the Paseo configuration for Roles & models (no answer within ${LOOKUP_TIMEOUT_MS} ms).`,
    ]);
  });

  it("never throws on a host without config.get or with a malformed answer", async () => {
    for (const paseo of [undefined, {}, { config: {} }, { config: { get: async () => null } }, { config: { get: async () => ({ config: [] }) } }]) {
      const result = await handleRolesSettings(paseo, { log });
      expect(result.roles).toHaveLength(4);
      expect(result.warnings).toHaveLength(1);
    }
  });
});

describe("roles.options", () => {
  it("lists a tiered provider's models, thinking options, rates and modes, and no auto-accept", async () => {
    const { paseo, listFeatures } = daemonWith();
    const result = await handleRolesOptions({ provider: "claude" }, paseo, { log, homedir: () => "/fake-home" });
    expect(result).toEqual({
      provider: "claude",
      capability: "tiered",
      models: [
        {
          id: "claude-opus-5",
          label: "Opus 5",
          thinkingOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
          defaultThinkingOptionId: "high",
          cost: { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
        },
        {
          id: "claude-haiku-5",
          label: "claude-haiku-5",
          thinkingOptions: [
            { id: "on", label: "On" },
            { id: "off", label: "off" },
          ],
          defaultThinkingOptionId: "on",
          cost: null,
        },
      ],
      modes: [
        { id: "plan", label: "Plan", colorTier: "planning" },
        { id: "default", label: "Default", colorTier: "safe" },
        { id: "acceptEdits", label: "Accept edits", colorTier: "moderate" },
        { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
      ],
      autoAccept: false,
    });
    expect(rolesOptionsRpc.output.parse(result)).toEqual(result);
    // Only an untiered provider costs the features round trip (§4.2.1).
    expect(listFeatures).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("offers auto-accept on an untiered provider that lists the toggle, reading features with the home directory as cwd", async () => {
    const { paseo, listFeatures } = daemonWith();
    const result = await handleRolesOptions({ provider: "opencode" }, paseo, { log, homedir: () => "/fake-home" });
    expect(result.capability).toBe("untiered");
    expect(result.autoAccept).toBe(true);
    // Listed ids only, each once; a label falls back to the id; no colorTier is null.
    expect(result.modes).toEqual([
      { id: "build", label: "Build", colorTier: null },
      { id: "review", label: "review", colorTier: null },
    ]);
    expect(result.models).toEqual([
      {
        id: "anthropic/claude-sonnet-4-6",
        label: "Sonnet 4.6",
        thinkingOptions: [],
        defaultThinkingOptionId: null,
        // No cache.read listed: cache reads cost the input rate.
        cost: { inputUsdPerMTok: 3, cacheReadUsdPerMTok: 3, outputUsdPerMTok: 15 },
      },
    ]);
    expect(listFeatures).toHaveBeenCalledTimes(1);
    expect(listFeatures.mock.calls[0]![0]).toEqual({ provider: "opencode", cwd: "/fake-home" });
  });

  it("does not offer auto-accept on an untiered provider without the toggle", async () => {
    const { paseo } = daemonWith({
      features: { opencode: { provider: "opencode", features: [{ type: "select", id: "auto_accept", label: "x", value: "a", options: [] }] } },
    });
    const result = await handleRolesOptions({ provider: "opencode" }, paseo, { log, homedir: () => "/fake-home" });
    expect(result.capability).toBe("untiered");
    expect(result.autoAccept).toBe(false);
  });

  it("gives a provider without modes (Pi) the none class, no modes and no auto-accept", async () => {
    const { paseo, listFeatures } = daemonWith();
    const result = await handleRolesOptions({ provider: "pi" }, paseo, { log });
    expect(result).toEqual({
      provider: "pi",
      capability: "none",
      models: [{ id: "pi-default", label: "Pi", thinkingOptions: [], defaultThinkingOptionId: null, cost: null }],
      modes: [],
      autoAccept: false,
    });
    expect(listFeatures).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("answers unknown and empty lists when Paseo cannot list the provider, one log line per failed lookup", async () => {
    const { paseo, listFeatures } = daemonWith();
    const result = await handleRolesOptions({ provider: "warming" }, paseo, { log });
    expect(result).toEqual({ provider: "warming", capability: "unknown", models: [], modes: [], autoAccept: false });
    expect(listFeatures).not.toHaveBeenCalled();
    expect(logged).toHaveLength(2);
    expect(logged.every((line) => line.startsWith("[paseo-bm] "))).toBe(true);
    expect(logged.some((line) => line.includes("could not read the models of warming (provider is still starting)"))).toBe(true);
    expect(logged.some((line) => line.includes("could not read the modes of warming (provider is still starting)"))).toBe(true);
  });

  it("never throws when a lookup throws or the host has no provider API", async () => {
    const boom = new Error("socket closed");
    const { paseo } = daemonWith({ models: { claude: boom }, modes: { claude: boom } });
    await expect(handleRolesOptions({ provider: "claude" }, paseo, { log })).resolves.toEqual({
      provider: "claude",
      capability: "unknown",
      models: [],
      modes: [],
      autoAccept: false,
    });
    await expect(handleRolesOptions({ provider: "claude" }, {}, { log })).resolves.toEqual({
      provider: "claude",
      capability: "unknown",
      models: [],
      modes: [],
      autoAccept: false,
    });
  });

  it("gives a model a null cost when its rates cannot be read, and keeps the model", async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce(MODELS["codex"])
      .mockRejectedValueOnce(new Error("second read failed"));
    const paseo = { providers: { listModels, listModes: async () => MODES["codex"] } };
    const result = await handleRolesOptions({ provider: "codex" }, paseo, { log });
    expect(result.models).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", thinkingOptions: [], defaultThinkingOptionId: null, cost: null }]);
    expect(result.capability).toBe("tiered");
  });

  it.each(["bm-worker", "bm-reviewer/gpt-5.6-sol", "bm-worker-fallback-1", "BM-Manager", " bm-manager"])(
    "refuses the role alias %j with E_ROLE_SETTINGS_INVALID, without a lookup",
    async (provider) => {
      const { paseo, listModes, listModels, listFeatures } = daemonWith();
      const call = handleRolesOptions({ provider }, paseo, { log });
      await expect(call).rejects.toBeInstanceOf(DashboardError);
      await expect(call).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
      await expect(call).rejects.toThrow(/^E_ROLE_SETTINGS_INVALID: .*role alias/);
      expect(listModes).not.toHaveBeenCalled();
      expect(listModels).not.toHaveBeenCalled();
      expect(listFeatures).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty provider with E_ROLE_SETTINGS_INVALID", async () => {
    const { paseo } = daemonWith();
    await expect(handleRolesOptions({ provider: "  " }, paseo, { log })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
    expect(rolesOptionsRpc.input.safeParse({ provider: "" }).success).toBe(false);
  });
});

describe("registration", () => {
  it("registers roles.settings and roles.options, lowercase, handing them the context's paseo", async () => {
    const handlers = new Map<string, (input: unknown, context: { paseo: unknown }) => unknown>();
    const server = {
      handle: (contract: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => unknown) => {
        handlers.set(contract.name, handler);
      },
    } as unknown as PluginServerContext;
    registerRoleSettingsRpcs(server);
    // roles.save-settings joined them with bead kj1p.3, roles.save-fallback with 332y.2, roles.instructions on the owner's decision of 2026-10-02.
    expect([...handlers.keys()].sort()).toEqual(["roles.instructions", "roles.options", "roles.save-fallback", "roles.save-settings", "roles.settings"]);

    const { paseo } = daemonWith();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const settings = (await handlers.get("roles.settings")!({}, { paseo })) as { roles: unknown[]; revision: string };
      expect(settings.roles).toHaveLength(4);
      expect(settings.revision).toBe(roleSettingsRevision(CONFIG));
      const options = (await handlers.get("roles.options")!({ provider: "claude" }, { paseo })) as { capability: string };
      expect(options.capability).toBe("tiered");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("roles.save-settings (delta 20260921 §4.3.3–§4.3.4, REQ-064 b/c/e/f, REQ-063 h)", () => {
  const AVAILABLE = { providers: ["claude", "codex", "opencode", "pi"].map((provider) => ({ provider, available: true })) };

  /**
   * The shared fake SDK, its config.patch applied as Paseo's is: four providers
   * available, and a bm-* alias answering with the modes of the provider it
   * extends now, like the daemon. Live agents, for BM-SETTINGS (§4.3.5), are
   * none unless a test adds some to `fake.agents`.
   */
  function stateful(config: unknown = CONFIG) {
    type State = { providers: Record<string, Record<string, unknown>>; agentProfiles: Array<Record<string, unknown>> };
    const fake: FakePaseo<FakeApi> = fakePaseo({
      config: config as Record<string, unknown>,
      providers: {
        available: AVAILABLE.providers,
        modes: (provider) => {
          const base = provider.startsWith("bm-") ? String(fake.config<State>().providers[provider]?.extends ?? provider) : provider;
          return answer(MODES, base, modeList(provider, [], `unknown provider ${provider}`));
        },
        models: (provider) => answer(MODELS, provider, modelList(provider, [], `unknown provider ${provider}`)),
        features: (provider) => answer(FEATURES, provider, { provider, features: [] }),
      },
    });
    return {
      ...fake,
      patch: fake.api.config.patch,
      listAvailable: fake.api.providers.listAvailable,
      state: () => fake.config<State>(),
      set: (next: State) => fake.setConfig(next),
      sent: fake.sends,
    };
  }

  it("writes the role's base provider, model, thinking and mode into Paseo's config and returns the saved role", async () => {
    const fake = stateful();
    const revision = roleSettingsRevision(fake.state());
    const result = await handleRolesSaveSettings(
      { revision, role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: "low", modeId: "bypassPermissions" },
      fake.paseo,
      { log },
    );
    expect(fake.patch).toHaveBeenCalledTimes(1);
    expect(fake.state().providers["bm-worker"]).toMatchObject({ extends: "claude", label: "Beads Worker", paseoTools: { enabled: true } });
    expect(fake.state().agentProfiles.find((entry) => entry.id === "bm-worker")).toMatchObject({ model: "claude-opus-5", thinkingOptionId: "low", modeId: "bypassPermissions" });
    // The user's own profile is byte-identical.
    expect(JSON.stringify(fake.state().agentProfiles[0])).toBe(JSON.stringify(CONFIG.agentProfiles[0]));
    expect(result.role).toMatchObject({ role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: "low", modeId: "bypassPermissions" });
    expect(result.revision).toBe(roleSettingsRevision(fake.state()));
    expect(result.notified).toBe(0);
    // Manager and Worker now both on Claude.
    expect(result.warnings).toContain(sharedPlanWarning("claude"));
    expect(result.warnings).toContain("Priced at ~$5 / $25 per 1M tokens.");
  });

  it("removes thinking and mode when they are saved as null", async () => {
    const fake = stateful();
    await handleRolesSaveSettings(
      { revision: roleSettingsRevision(fake.state()), role: "manager", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log },
    );
    const manager = fake.state().agentProfiles.find((entry) => entry.id === "bm-manager")!;
    expect(manager).not.toHaveProperty("thinkingOptionId");
    expect(manager).not.toHaveProperty("modeId");
    expect(manager.notes).toBe("installed by paseo-bm");
  });

  it.each([
    ["a bm-* alias as base provider", { baseProvider: "bm-worker" }],
    ["a provider that is not available", { baseProvider: "copilot" }],
    ["a model the provider does not list", { model: "claude-opus-9" }],
    ["a thinking level the model does not offer", { thinkingOptionId: "max" }],
    ["a mode the provider does not list", { modeId: "yolo" }],
  ])("refuses %s before any write", async (_label, change) => {
    const fake = stateful();
    const input = { revision: roleSettingsRevision(fake.state()), role: "worker" as const, baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: "high", modeId: null, ...change };
    await expect(handleRolesSaveSettings(input, fake.paseo, { log })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
    expect(fake.patch).not.toHaveBeenCalled();
  });

  // The Orchestrator is read-only under the Reviewer's rule (orchestrator design §3.1).
  it.each(["reviewer", "orchestrator"] as const)("never lets the %s be saved in a dangerous or planning mode", async (role) => {
    const fake = stateful();
    for (const modeId of ["bypassPermissions", "plan"]) {
      await expect(
        handleRolesSaveSettings({ revision: roleSettingsRevision(fake.state()), role, baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId }, fake.paseo, { log }),
      ).rejects.toThrow(new RegExp(`E_ROLE_SETTINGS_INVALID: .*never runs in a (dangerous|planning) mode`));
    }
    expect(fake.patch).not.toHaveBeenCalled();
  });

  it("refuses a save whose revision is stale, writing nothing", async () => {
    const fake = stateful();
    const stale = roleSettingsRevision(fake.state());
    fake.set({ ...fake.state(), agentProfiles: [{ ...CONFIG.agentProfiles[0], model: "claude-haiku-5" }, ...fake.state().agentProfiles.slice(1)] });
    await expect(
      handleRolesSaveSettings({ revision: stale, role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: null }, fake.paseo, { log }),
    ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_CONFLICT" });
    expect(fake.patch).not.toHaveBeenCalled();
  });

  it("warns, never blocks, for Pi and for an OpenCode Reviewer without an agent chosen", async () => {
    const fake = stateful();
    const worker = await handleRolesSaveSettings(
      { revision: roleSettingsRevision(fake.state()), role: "worker", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log },
    );
    expect(worker.warnings).toContain("Pi needs pi-mcp-adapter to give this role Paseo tools.");
    const piReviewer = await handleRolesSaveSettings(
      { revision: worker.revision, role: "reviewer", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log },
    );
    expect(piReviewer.warnings).toContain("Pi does not ask before running tools; the Reviewer's read-only rule is only in its instructions.");
    const openCodeReviewer = await handleRolesSaveSettings(
      { revision: piReviewer.revision, role: "reviewer", baseProvider: "opencode", model: "anthropic/claude-sonnet-4-6", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log },
    );
    expect(openCodeReviewer.warnings).toContain("The Reviewer runs with your OpenCode agent's permissions; paseo-bm never auto-approves for it.");
    expect(fake.patch).toHaveBeenCalledTimes(3);
  });

  it("saves the Orchestrator like the other roles, with the Reviewer's warnings, and tells no agent (orchestrator design §3.2)", async () => {
    const fake = stateful();
    const others = JSON.stringify(fake.state().agentProfiles.filter((entry) => entry.id !== "bm-orchestrator"));
    const saved = await handleRolesSaveSettings(
      { revision: roleSettingsRevision(fake.state()), role: "orchestrator", baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log },
    );
    expect(fake.state().providers["bm-orchestrator"]).toEqual({ extends: "pi", label: "Beads Orchestrator" });
    expect(fake.state().agentProfiles.find((entry) => entry.id === "bm-orchestrator")).toMatchObject({ model: "pi-default" });
    expect(JSON.stringify(fake.state().agentProfiles.filter((entry) => entry.id !== "bm-orchestrator"))).toBe(others);
    expect(saved.role).toMatchObject({ role: "orchestrator", providerId: "bm-orchestrator", baseProvider: "pi", model: "pi-default" });
    expect(saved.warnings).toContain("Pi does not ask before running tools; the Orchestrator's read-only rule is only in its instructions.");
    expect(saved.warnings).not.toContain("Pi needs pi-mcp-adapter to give this role Paseo tools.");
    expect(saved.notified).toBe(0);

    const openCode = await handleRolesSaveSettings(
      { revision: saved.revision, role: "orchestrator", baseProvider: "opencode", model: "anthropic/claude-sonnet-4-6", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log },
    );
    expect(openCode.warnings).toContain("The Orchestrator runs with your OpenCode agent's permissions; paseo-bm never auto-approves for it.");
    expect(fake.sent).toEqual([]);
  });

  it("tells every live Manager a changed Worker mode with BM-SETTINGS, and nobody when the line stays the same (§4.3.5)", async () => {
    const fake = stateful();
    fake.agents.push(
      { id: "m-1", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle" },
      { id: "w-1", provider: "bm-worker", labels: { "bm.role": "worker" }, status: "idle" },
    );
    // bm-worker extends OpenCode (untiered, the Manager was told `build`); now Claude.
    const first = await handleRolesSaveSettings(
      { revision: roleSettingsRevision(fake.state()), role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: "bypassPermissions" },
      fake.paseo,
      { log },
    );
    expect(first.notified).toBe(1);
    expect(fake.sent).toEqual([
      {
        id: "m-1",
        text: [
          'BM-SETTINGS The user changed the paseo-bm role settings. This replaces the matching line under "## Runtime facts":',
          "Worker mode: `bypassPermissions` — pass it as `settings.modeId` when you create a Worker.",
          "Do not reply to this message; carry on with what you were doing.",
        ].join("\n"),
      },
    ]);
    const again = await handleRolesSaveSettings(
      { revision: first.revision, role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: "low", modeId: "bypassPermissions" },
      fake.paseo,
      { log },
    );
    expect(again.notified).toBe(0);
    expect(fake.sent).toHaveLength(1);
  });

  // Live check 2026-10-01 F4: the Manager of a project whose action boundary is on is told the Worker's boundary mode.
  it("tells each live Manager the Worker mode of its own project's boundary", async () => {
    const fake = stateful();
    fake.agents.push(
      { id: "m-on", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: "wks-on" },
      { id: "m-off", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: "wks-off" },
    );
    const saved = await handleRolesSaveSettings(
      { revision: roleSettingsRevision(fake.state()), role: "worker", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null },
      fake.paseo,
      { log, boundaryOn: (workspaceId) => workspaceId === "wks-on" },
    );
    expect(saved.notified).toBe(2);
    const line = (id: string) => fake.sent.find((entry) => entry.id === id)?.text.split("\n")[1];
    expect(line("m-on")).toBe("Worker mode: `auto` — pass it as `settings.modeId` when you create a Worker.");
    expect(line("m-off")).toBe("Worker mode: `full-access` — pass it as `settings.modeId` when you create a Worker.");
  });

  it("refuses when Paseo cannot say which providers are available", async () => {
    const fake = stateful();
    fake.listAvailable.mockImplementation(async () => {
      throw new Error("daemon busy");
    });
    await expect(
      handleRolesSaveSettings({ revision: roleSettingsRevision(fake.state()), role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: null }, fake.paseo, { log }),
    ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
  });

  it("registers roles.save-settings next to the three read RPCs, then roles.save-fallback", () => {
    const handle = vi.fn();
    registerRoleSettingsRpcs({ handle } as unknown as PluginServerContext);
    expect(handle.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
      "roles.settings",
      "roles.instructions",
      "roles.options",
      "roles.save-settings",
      "roles.save-fallback",
    ]);
  });
});

describe("roles.settings providers (the Edit form's Provider picker)", () => {
  it("lists the available base providers, sorted, never a bm-* alias or an unavailable one", async () => {
    const { paseo } = daemonWith();
    (paseo.providers as Record<string, unknown>).listAvailable = async () => ({
      providers: [
        { provider: "pi", available: true },
        { provider: "claude", available: true },
        { provider: "bm-worker", available: true },
        { provider: "copilot", available: false },
      ],
    });
    expect((await handleRolesSettings(paseo, { log })).providers).toEqual(["claude", "pi"]);
  });
});

describe("roles.instructions (design §7.12, base PRD REQ-032 d)", () => {
  const modes = { providers: { listModes: async () => ({ modes: [{ id: "full-access", colorTier: "dangerous" }, { id: "auto", colorTier: "moderate" }] }) } };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bm-roles-instructions-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("shows each role exactly what the creation paths write (currentInstructions), with the global precedents only", async () => {
    for (const role of ["manager", "worker", "reviewer", "orchestrator"] as const) {
      const shown = await handleRolesInstructions({ role }, modes, { homedir: () => root });
      expect(shown).toEqual({ role, text: await currentInstructions(role, modes, { homedir: () => root }), workspaceId: null });
      expect(shown.text).toContain(BASE_INSTRUCTIONS[role].trimEnd());
    }
  });

  it("shows the bound text on a provider that can carry paseo-bm's tools, the unbound text with its hand path otherwise (design §16.12)", async () => {
    const extending = (bases: Record<string, string>) => ({
      ...modes,
      config: { get: async () => ({ config: { providers: Object.fromEntries(Object.entries(bases).map(([alias, base]) => [alias, { extends: base }])), agentProfiles: [] } }) },
    });
    const onTools = extending({ "bm-manager": "claude", "bm-worker": "codex", "bm-reviewer": "opencode", "bm-orchestrator": "claude" });
    const offTools = extending({ "bm-manager": "pi", "bm-worker": "copilot", "bm-reviewer": "pi", "bm-orchestrator": "pi" });
    for (const role of ["manager", "worker", "reviewer"] as const) {
      const bound = await handleRolesInstructions({ role }, onTools, { homedir: () => root });
      expect(bound.text, role).toBe(await currentInstructions(role, onTools, { homedir: () => root, bound: true }));
      expect(bound.text, role).not.toContain(HAND_PATH_HEADING);
      expect(bound.text, role).not.toMatch(/ mode: .*when you create a/);
      const unbound = await handleRolesInstructions({ role }, offTools, { homedir: () => root });
      expect(unbound.text, role).toBe(await currentInstructions(role, offTools, { homedir: () => root }));
      expect(unbound.text, role).toContain(`${HAND_PATH_HEADING}`);
      expect(unbound.text, role).toContain(RUNTIME_FACTS_HEADING);
    }
    // The child mode line is the hand path's: shown to an unbound Worker, never to a bound one.
    expect((await handleRolesInstructions({ role: "worker" }, offTools, { homedir: () => root })).text).toMatch(/Reviewer mode: .*when you create a Reviewer/);
    // The Orchestrator has no hand path: the same text on either provider.
    expect((await handleRolesInstructions({ role: "orchestrator" }, onTools, { homedir: () => root })).text).toBe(
      (await handleRolesInstructions({ role: "orchestrator" }, offTools, { homedir: () => root })).text,
    );
  });

  it("adds a project's own precedents for that project, never another project's", async () => {
    const store = createPrecedentStore(join(root, ".paseo-bm"));
    const now = new Date();
    store.save({ scope: PRECEDENT_SCOPE_ALL, subject: "everywhere", text: "Use pnpm.", sourceDecisionId: null, expiresInDays: 30 }, now);
    store.save({ scope: "ws-1", subject: "here", text: "Ship on Fridays.", sourceDecisionId: null, expiresInDays: 30 }, now);
    store.save({ scope: "ws-2", subject: "elsewhere", text: "Never ship.", sourceDecisionId: null, expiresInDays: 30 }, now);

    const global = await handleRolesInstructions({ role: "manager" }, modes, { homedir: () => root });
    expect(global.text).toContain(OWNER_PRECEDENTS_HEADING);
    expect(global.text).toContain("`everywhere`");
    expect(global.text).not.toContain("`here`");

    const project = await handleRolesInstructions({ role: "manager", workspaceId: "ws-1" }, modes, { homedir: () => root });
    expect(project.workspaceId).toBe("ws-1");
    expect(project.text).toContain("`everywhere`");
    expect(project.text).toContain("`here`");
    expect(project.text).not.toContain("`elsewhere`");
    // The Reviewer and the Orchestrator never get precedents.
    expect((await handleRolesInstructions({ role: "reviewer", workspaceId: "ws-1" }, modes, { homedir: () => root })).text).not.toContain(OWNER_PRECEDENTS_HEADING);
  });
});
