import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetModelCosts } from "../plugin/server/model-costs";
import { noticeQueue } from "../plugin/server/notice-queue";
import { LOOKUP_TIMEOUT_MS, forgetModes } from "../plugin/server/role-mode";
import {
  canonicalJson,
  handleRolesOptions,
  handleRolesSaveSettings,
  handleRolesSettings,
  registerRoleSettingsRpcs,
  roleSettingsRevision,
  sharedPlanWarning,
} from "../plugin/server/role-settings-rpc";
import { DashboardError, rolesOptionsRpc, rolesSettingsRpc } from "../plugin/shared/contracts";

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
  ],
};

interface FakeOptions {
  config?: unknown;
  configError?: Error;
  modes?: Record<string, unknown>;
  models?: Record<string, unknown>;
  features?: Record<string, unknown>;
}

function fakePaseo(options: FakeOptions = {}) {
  const modes = options.modes ?? MODES;
  const models = options.models ?? MODELS;
  const features = options.features ?? FEATURES;
  const answer = (table: Record<string, unknown>, key: string, fallback: unknown) => {
    const value = table[key];
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  const listModes = vi.fn(async (provider: string) => answer(modes, provider, modeList(provider, [], `unknown provider ${provider}`)));
  const listModels = vi.fn(async (provider: string) => answer(models, provider, modelList(provider, [], `unknown provider ${provider}`)));
  const listFeatures = vi.fn(async (draft: { provider: string; cwd: string }) =>
    answer(features, draft.provider, { provider: draft.provider, features: [] }),
  );
  const get = vi.fn(async () => {
    if (options.configError !== undefined) throw options.configError;
    return { requestId: "r-config", config: options.config ?? CONFIG };
  });
  const patch = vi.fn();
  return {
    paseo: { providers: { listModes, listModels, listFeatures }, config: { get, patch } },
    listModes,
    listModels,
    listFeatures,
    get,
    patch,
  };
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
  it("describes the three roles from config.providers and config.agentProfiles, with each capability class", async () => {
    const { paseo, patch } = fakePaseo();
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
      ],
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
    const { paseo, listModes } = fakePaseo({ config });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.map((role) => role.role)).toEqual(["manager", "worker", "reviewer"]);
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
    const { paseo, listModes } = fakePaseo({ config: { providers: { claude: {} }, agentProfiles: [] } });
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
    const warningsFor = async (config: unknown) => (await handleRolesSettings(fakePaseo({ config }).paseo, { log })).warnings;

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
    const { paseo, listModes } = fakePaseo({ config });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.map((role) => role.capability)).toEqual(["unknown", "tiered", "tiered"]);
    expect(listModes.mock.calls.map((call) => call[0]).sort()).toEqual(["claude", "warming"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^\[paseo-bm\] could not read the modes of warming \(provider is still starting\)/);
  });

  it("never throws when the configuration cannot be read: three empty roles, a warning and one log line", async () => {
    const { paseo, listModes } = fakePaseo({ configError: new Error("daemon went away") });
    const result = await handleRolesSettings(paseo, { log });
    expect(result.roles.map((role) => [role.role, role.baseProvider, role.model, role.capability])).toEqual([
      ["manager", null, null, "unknown"],
      ["worker", null, null, "unknown"],
      ["reviewer", null, null, "unknown"],
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
      expect(result.roles).toHaveLength(3);
      expect(result.warnings).toHaveLength(1);
    }
  });
});

describe("roles.options", () => {
  it("lists a tiered provider's models, thinking options, rates and modes, and no auto-accept", async () => {
    const { paseo, listFeatures } = fakePaseo();
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
    const { paseo, listFeatures } = fakePaseo();
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
    const { paseo } = fakePaseo({
      features: { opencode: { provider: "opencode", features: [{ type: "select", id: "auto_accept", label: "x", value: "a", options: [] }] } },
    });
    const result = await handleRolesOptions({ provider: "opencode" }, paseo, { log, homedir: () => "/fake-home" });
    expect(result.capability).toBe("untiered");
    expect(result.autoAccept).toBe(false);
  });

  it("gives a provider without modes (Pi) the none class, no modes and no auto-accept", async () => {
    const { paseo, listFeatures } = fakePaseo();
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
    const { paseo, listFeatures } = fakePaseo();
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
    const { paseo } = fakePaseo({ models: { claude: boom }, modes: { claude: boom } });
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
      const { paseo, listModes, listModels, listFeatures } = fakePaseo();
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
    const { paseo } = fakePaseo();
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
    // roles.save-settings joined them with bead kj1p.3, roles.save-fallback with 332y.2.
    expect([...handlers.keys()].sort()).toEqual(["roles.options", "roles.save-fallback", "roles.save-settings", "roles.settings"]);

    const { paseo } = fakePaseo();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const settings = (await handlers.get("roles.settings")!({}, { paseo })) as { roles: unknown[]; revision: string };
      expect(settings.roles).toHaveLength(3);
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

  /** A fake whose config.patch behaves like Paseo's: providers deep-merged, agentProfiles replaced whole. */
  function stateful(config: unknown = CONFIG) {
    const fake = fakePaseo();
    let state = structuredClone(config) as { providers: Record<string, Record<string, unknown>>; agentProfiles: Array<Record<string, unknown>> };
    fake.get.mockImplementation(async () => ({ requestId: "r", config: structuredClone(state) }));
    fake.patch.mockImplementation(async (patch: Record<string, unknown>) => {
      for (const [id, entry] of Object.entries((patch.providers ?? {}) as Record<string, Record<string, unknown>>)) {
        state.providers[id] = { ...(state.providers[id] ?? {}), ...entry };
      }
      if (patch.agentProfiles !== undefined) state.agentProfiles = structuredClone(patch.agentProfiles as Array<Record<string, unknown>>);
      return {};
    });
    const listAvailable = vi.fn(async () => AVAILABLE);
    (fake.paseo.providers as Record<string, unknown>).listAvailable = listAvailable;
    // Like the daemon, a bm-* alias answers with the modes of the provider it extends now.
    fake.listModes.mockImplementation(async (provider: string) => {
      const base = provider.startsWith("bm-") ? String(state.providers[provider]?.extends ?? provider) : provider;
      const answer = MODES[base] ?? modeList(provider, [], `unknown provider ${provider}`);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    // Live agents, for BM-SETTINGS (§4.3.5); none unless a test adds some.
    const agents: Array<{ id: string; provider: string; labels?: Record<string, string>; status: string }> = [];
    const sent: Array<{ id: string; text: string }> = [];
    (fake.paseo as Record<string, unknown>).agents = {
      list: vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })) })),
      ref: (id: string) => ({
        refresh: async () => ({ agent: agents.find((agent) => agent.id === id) ?? null }),
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
    };
    return { ...fake, state: () => state, set: (next: typeof state) => (state = next), listAvailable, agents, sent };
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

  it("never lets the Reviewer be saved in a dangerous or planning mode", async () => {
    const fake = stateful();
    for (const modeId of ["bypassPermissions", "plan"]) {
      await expect(
        handleRolesSaveSettings({ revision: roleSettingsRevision(fake.state()), role: "reviewer", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId }, fake.paseo, { log }),
      ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
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

  it("refuses when Paseo cannot say which providers are available", async () => {
    const fake = stateful();
    fake.listAvailable.mockImplementation(async () => {
      throw new Error("daemon busy");
    });
    await expect(
      handleRolesSaveSettings({ revision: roleSettingsRevision(fake.state()), role: "worker", baseProvider: "claude", model: "claude-opus-5", thinkingOptionId: null, modeId: null }, fake.paseo, { log }),
    ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
  });

  it("registers roles.save-settings next to the two read RPCs, then roles.save-fallback", () => {
    const handle = vi.fn();
    registerRoleSettingsRpcs({ handle } as unknown as PluginServerContext);
    expect(handle.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
      "roles.settings",
      "roles.options",
      "roles.save-settings",
      "roles.save-fallback",
    ]);
  });
});

describe("roles.settings providers (the Edit form's Provider picker)", () => {
  it("lists the available base providers, sorted, never a bm-* alias or an unavailable one", async () => {
    const { paseo } = fakePaseo();
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
