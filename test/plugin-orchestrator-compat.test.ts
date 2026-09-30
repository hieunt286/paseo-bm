import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { roleConfigRevision } from "../plugin/server/config-writer";
import { ROLE_FALLBACK_STATE_FILE, readIncidents, updateIncidents } from "../plugin/server/fallback-state";
import { ROLE_EXTRAS_FILE, readRoleExtras, saveRoleExtra } from "../plugin/server/role-extras";
import { ensureRoles, markCleanedUpThisRun, roleAliasEntry, roleProfileEntry } from "../plugin/server/setup-roles";
import { readSetupState, setupStatePath, updateSetupState } from "../plugin/server/setup-state";
import { bmRoleSchema, fallbackIncidentSchema, type FallbackIncident } from "../plugin/shared/contracts";

/**
 * Orchestrator design §10–§11 (bead WP-502): the fourth role must leave every
 * file and config entry 0.4.1 reads usable after a downgrade.
 *
 * The 0.4.1 side is the real 0.4.1 code, not a copy of today's:
 * `fixtures/v0.4.1/plugin-server.mjs` is its server code bundled from the git
 * tag (the file's header says how). It is loaded by path so the TypeScript
 * program never type-checks the bundle.
 */

type Deps = { env: Record<string, string>; homedir: () => string };
type Paseo = Record<string, unknown>;

/** The 0.4.1 exports these tests call, typed as loosely as the bundle is. */
interface V041 {
  handleRolesSaveSettings(input: Record<string, unknown>, paseo: unknown, deps?: { log?: (message: string) => void }): Promise<{
    revision: string;
    role: Record<string, unknown>;
    warnings: string[];
    notified: number;
  }>;
  handleRolesSettings(paseo: unknown, deps?: { log?: (message: string) => void }): Promise<{ roles: Array<{ role: string }> }>;
  roleSettingsRevision(config: unknown): string;
  readSetupState(deps: Deps): Record<string, unknown>;
  updateSetupState(patch: Record<string, unknown>, deps: Deps): unknown;
  readIncidents(home: string, log?: (message: string) => void): { incidents: unknown[]; error: string | null };
  updateIncidents(home: string, change: (incidents: unknown[]) => unknown[] | null, log?: (message: string) => void): Promise<unknown[] | null>;
  readRoleExtras(home: string): Record<string, string>;
  saveRoleExtra(home: string, role: string, text: string): Record<string, string>;
  removeAllBmEntries(paseo: unknown, restore: boolean | null): Promise<{ removedProviders: string[]; removedProfiles: string[] }>;
  forgetModes(): void;
  forgetModelCosts(): void;
  bmRoleSchema: { options: readonly string[] };
  fallbackIncidentSchema: { parse(value: unknown): unknown };
}

const FIXTURE = fileURLToPath(new URL("./fixtures/v0.4.1/plugin-server.mjs", import.meta.url));
let v041: V041;

// 0.4.1's handlers find the data folder from $HOME: point it at a temporary
// directory so this machine's real ~/.paseo-bm is never read or written.
const realEnv = { HOME: process.env.HOME, PASEO_BM_HOME: process.env.PASEO_BM_HOME };
let home: string;
let dataHome: string;
const deps = (): Deps => ({ env: {}, homedir: () => home });

beforeAll(async () => {
  v041 = (await import(FIXTURE)) as V041;
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-orchestrator-compat-"));
  dataHome = join(home, ".paseo-bm");
  process.env.HOME = home;
  delete process.env.PASEO_BM_HOME;
  markCleanedUpThisRun(false);
  v041.forgetModes();
  v041.forgetModelCosts();
});

afterEach(() => {
  markCleanedUpThisRun(false);
  rmSync(home, { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const AVAILABLE = { providers: ["claude", "codex"].map((provider) => ({ provider, available: true })) };
const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
  claude: [
    { id: "default", label: "Default", colorTier: "safe" },
    { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
  ],
  codex: [
    { id: "auto", label: "Auto", colorTier: "moderate" },
    { id: "full-access", label: "Full access", colorTier: "dangerous" },
  ],
};
const MODELS: Record<string, Array<{ id: string; label: string; thinkingOptions: Array<{ id: string; label: string }> }>> = {
  claude: [{ id: "claude-opus-5", label: "Opus 5", thinkingOptions: [{ id: "high", label: "High" }] }],
  codex: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol", thinkingOptions: [] }],
};

type Config = { providers: Record<string, Record<string, unknown>>; agentProfiles: Array<Record<string, unknown>> };

/** A daemon whose `config.patch` behaves like Paseo 0.8's: providers deep-merged, `removeProviders`, profiles replaced whole. */
function fakeDaemon(initial: Config) {
  let state = structuredClone(initial);
  const patches: Array<Record<string, unknown>> = [];
  const paseo: Paseo = {
    providers: {
      listAvailable: vi.fn(async () => AVAILABLE),
      listModels: vi.fn(async (provider: string) => ({ provider, models: MODELS[provider] ?? [], error: null })),
      // Like the daemon, a bm-* alias answers with the modes of the provider it extends.
      listModes: vi.fn(async (provider: string) => {
        const base = provider.startsWith("bm-") ? String(state.providers[provider.split("/")[0]!]?.extends ?? provider) : provider;
        return { provider, modes: MODES[base] ?? [], error: MODES[base] === undefined ? `unknown provider ${provider}` : null };
      }),
      listFeatures: vi.fn(async (draft: { provider: string }) => ({ provider: draft.provider, features: [] })),
    },
    config: {
      get: vi.fn(async () => ({ config: structuredClone(state) })),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        patches.push(structuredClone(patch));
        for (const [id, entry] of Object.entries((patch["providers"] ?? {}) as Record<string, Record<string, unknown>>)) {
          state.providers[id] = { ...(state.providers[id] ?? {}), ...entry };
        }
        for (const id of (patch["removeProviders"] as string[] | undefined) ?? []) delete state.providers[id];
        if (patch["agentProfiles"] !== undefined) state.agentProfiles = structuredClone(patch["agentProfiles"]) as Config["agentProfiles"];
        return {};
      }),
    },
    agents: {
      list: vi.fn(async () => ({ entries: [] })),
      ref: () => ({ refresh: async () => null, send: async () => undefined }),
    },
  };
  return { paseo, patches, state: () => state, set: (next: Config) => (state = structuredClone(next)) };
}

/** A machine set up by 0.4.x: the three roles, a fallback alias and the user's own entries. */
const machine041 = (): Config => ({
  providers: {
    claude: { enabled: true },
    "room-lead": { extends: "codex" },
    "bm-manager": { extends: "claude", label: "Beads Manager", paseoTools: { enabled: true } },
    "bm-worker": { extends: "claude", label: "Beads Worker", paseoTools: { enabled: true } },
    "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
    "bm-worker-fallback-1": { extends: "codex", label: "Beads Worker · fallback 1", paseoTools: { enabled: true } },
  },
  agentProfiles: [
    { id: "room-lead", name: "Lead", provider: "room-lead", model: "gpt-5.6-sol" },
    roleProfileEntry("manager", "claude-opus-5"),
    { ...roleProfileEntry("worker", "claude-opus-5"), thinkingOptionId: "high" },
    { ...roleProfileEntry("reviewer", "gpt-5.6-sol"), modeId: "auto" },
  ],
});

/** The same machine after this release's `ensureRoles`: `bm-orchestrator` added. */
const machineWithOrchestrator = (): Config => {
  const config = machine041();
  config.providers["bm-orchestrator"] = roleAliasEntry("orchestrator", "claude");
  config.agentProfiles.push(roleProfileEntry("orchestrator", "claude-opus-5"));
  return config;
};

const log = () => {};

describe("ui/setup-state.json after the update, read by 0.4.1", () => {
  const agentTools = { setBy: "plugin", previous: false, at: "2026-09-20T08:00:00.000Z" };
  const rolesCreated = { at: "2026-09-20T08:01:00.000Z", roles: ["manager", "worker", "reviewer"], baseProvider: "claude", model: "claude-opus-5" };

  it("keeps agentTools and rolesCreated readable, and drops orchestratorCreatedAt", async () => {
    // What a 0.4.1 machine has on disk.
    v041.updateSetupState({ agentTools, rolesCreated }, deps());
    const daemon = fakeDaemon(machine041());

    // This release opens once: it creates the Orchestrator and records it.
    expect(await ensureRoles(daemon.paseo, { ...deps(), log })).toMatchObject({ created: ["orchestrator"] });
    const written = JSON.parse(readFileSync(setupStatePath(dataHome), "utf8")) as Record<string, unknown>;
    expect(written["orchestratorCreatedAt"]).toEqual(expect.any(String));
    expect(written["rolesCreated"]).toEqual(rolesCreated);

    // The downgrade reads the same file: every field it knows survives.
    expect(v041.readSetupState(deps())).toEqual({ agentTools, rolesCreated, skillsRun: null, cleanedUpAt: null });
  });

  it("keeps the cleanup mark readable, so 0.4.1 does not recreate the roles the user removed", () => {
    updateSetupState(
      { rolesCreated: { ...rolesCreated, roles: ["manager", "worker", "reviewer"] }, orchestratorCreatedAt: "2026-09-28T09:00:00.000Z", cleanedUpAt: "2026-09-28T10:00:00.000Z" },
      deps(),
    );

    expect(v041.readSetupState(deps())).toMatchObject({ cleanedUpAt: "2026-09-28T10:00:00.000Z", rolesCreated });
  });

  it("would lose every field to 0.4.1 if the Orchestrator were a fourth value of rolesCreated.roles (the control)", () => {
    mkdirSync(join(dataHome, "ui"), { recursive: true });
    writeFileSync(
      setupStatePath(dataHome),
      JSON.stringify({ schemaVersion: 1, agentTools, rolesCreated: { ...rolesCreated, roles: [...rolesCreated.roles, "orchestrator"] } }),
    );

    expect(v041.readSetupState(deps())).toEqual({ agentTools: null, rolesCreated: null, skillsRun: null, cleanedUpAt: null });
  });

  it("is read back by this release after 0.4.1 rewrote it, with only orchestratorCreatedAt gone", () => {
    updateSetupState({ agentTools: { setBy: "plugin", previous: false, at: agentTools.at }, orchestratorCreatedAt: "2026-09-28T09:00:00.000Z" }, deps());
    v041.updateSetupState({ skillsRun: { at: "2026-09-29T08:00:00.000Z", command: "npx skills add …", code: 0, outcome: "ok" } }, deps());

    expect(readSetupState(deps())).toMatchObject({ agentTools, orchestratorCreatedAt: null });
  });
});

describe("Paseo's configuration with bm-orchestrator, used by 0.4.1", () => {
  it("roles.save-settings of 0.4.1 still saves another role, and leaves bm-orchestrator byte-identical", async () => {
    const daemon = fakeDaemon(machineWithOrchestrator());
    const orchestratorAlias = JSON.stringify(daemon.state().providers["bm-orchestrator"]);
    const orchestratorProfile = JSON.stringify(daemon.state().agentProfiles.find((entry) => entry["id"] === "bm-orchestrator"));
    // The revision the 0.4.1 client is handed is the one this release computes too.
    const revision = v041.roleSettingsRevision(daemon.state());
    expect(revision).toBe(roleConfigRevision(daemon.state()));

    const saved = await v041.handleRolesSaveSettings(
      { revision, role: "worker", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: "auto" },
      daemon.paseo,
      { log },
    );

    expect(saved.role).toMatchObject({ role: "worker", baseProvider: "codex", model: "gpt-5.6-sol", modeId: "auto" });
    expect(daemon.patches).toHaveLength(1);
    expect(daemon.state().providers["bm-worker"]).toMatchObject({ extends: "codex" });
    expect(JSON.stringify(daemon.state().providers["bm-orchestrator"])).toBe(orchestratorAlias);
    expect(JSON.stringify(daemon.state().agentProfiles.find((entry) => entry["id"] === "bm-orchestrator"))).toBe(orchestratorProfile);
    // 0.4.1 lists its three roles and does not show the fourth.
    expect((await v041.handleRolesSettings(daemon.paseo, { log })).roles.map((entry) => entry.role)).toEqual(["manager", "worker", "reviewer"]);
  });

  it("the cleanup of 0.4.1 still removes bm-orchestrator with every other bm-* entry", async () => {
    const daemon = fakeDaemon(machineWithOrchestrator());

    const removed = await v041.removeAllBmEntries(daemon.paseo, null);

    expect(removed.removedProviders).toContain("bm-orchestrator");
    expect(removed.removedProfiles).toContain("bm-orchestrator");
    expect(Object.keys(daemon.state().providers)).toEqual(["claude", "room-lead"]);
    expect(daemon.state().agentProfiles.map((entry) => entry["id"])).toEqual(["room-lead"]);
  });
});

describe("role-fallback-state.json across the downgrade", () => {
  const incident: FallbackIncident = {
    id: "fb-0123456789ab",
    role: "worker",
    workspaceId: "wks_1",
    requestId: "req-20260928T090000Z",
    agentId: "agent-worker",
    agentProvider: "bm-worker/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: "agent-manager",
    managerId: "agent-manager",
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: null,
    candidate: {
      position: 1,
      alias: "bm-worker-fallback-1",
      baseProvider: "codex",
      model: "gpt-5.6-sol",
      thinkingOptionId: null,
      modeId: null,
    },
    status: "pending",
    detectedAt: "2026-09-28T09:00:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
  };

  it("keeps bmRoleSchema — the schema of the fallback chain and of each incident — at the three roles of 0.4.1", () => {
    expect(bmRoleSchema.options).toEqual(["manager", "worker", "reviewer"]);
    expect([...bmRoleSchema.options]).toEqual([...v041.bmRoleSchema.options]);
  });

  it("parses a file 0.4.1 wrote, and 0.4.1 parses the one this release writes", async () => {
    expect(fallbackIncidentSchema.parse(incident)).toEqual(incident);
    // The incident store writes into a data folder the plugin created earlier.
    mkdirSync(dataHome, { recursive: true, mode: 0o700 });

    await v041.updateIncidents(dataHome, () => [incident], log);
    expect(readIncidents(dataHome, log)).toEqual({ incidents: [incident], error: null });

    const later = { ...incident, id: "fb-ba9876543210", role: "reviewer" as const, status: "dismissed" as const, decidedAt: "2026-09-28T09:05:00.000Z" };
    await updateIncidents(dataHome, (incidents) => [...incidents, later], log);
    expect(v041.readIncidents(dataHome, log)).toEqual({ incidents: [incident, later], error: null });
    expect(JSON.parse(readFileSync(join(dataHome, ROLE_FALLBACK_STATE_FILE), "utf8")).version).toBe(1);
  });
});

describe("role-extras.json across the downgrade (orchestrator design §10: the Orchestrator's text is lost, nothing else)", () => {
  it("0.4.1 reads a file with the orchestrator key, and its first save keeps the three roles' text", () => {
    saveRoleExtra(dataHome, "worker", "Use pnpm.");
    saveRoleExtra(dataHome, "orchestrator", "Score strictly.");
    expect(v041.readRoleExtras(dataHome)).toEqual({ manager: "", worker: "Use pnpm.", reviewer: "" });

    v041.saveRoleExtra(dataHome, "reviewer", "Check the tests.");

    expect(readRoleExtras(dataHome)).toEqual({ manager: "", worker: "Use pnpm.", reviewer: "Check the tests.", orchestrator: "" });
    expect(JSON.parse(readFileSync(join(dataHome, ROLE_EXTRAS_FILE), "utf8")).roles).not.toHaveProperty("orchestrator");
  });
});
