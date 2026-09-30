import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROLE_DISPLAY_NAMES,
  ROLE_NAMES,
  ROLE_PROFILE_NOTES,
  ensureRoles,
  markCleanedUpThisRun,
  MANAGER_DISABLED_PASEO_TOOLS,
  WORKER_DISABLED_PASEO_TOOLS,
  paseoToolsPolicyOfAlias,
  roleAliasEntry,
  roleGrantsPaseoTools,
  rolePaseoToolsPolicy,
  roleId,
  roleProfileEntry,
} from "../plugin/server/setup-roles";
import { readSetupState, updateSetupState } from "../plugin/server/setup-state";

/**
 * WP-402: the values the plugin creates the four roles with (design §6.1; the
 * fourth, `bm-orchestrator`, from orchestrator design §3.1).
 *
 * These used to be checked against a second copy in `src/roles/`, so a machine
 * set up by the plugin matched one set up by `npx paseo-bm`. WP-406 deleted the
 * installer's copy, so the plugin's is now the only one and what is pinned here
 * is its shape and its exact texts.
 */

describe("the plugin's role texts", () => {
  it("covers exactly the four roles, with the documented names", () => {
    expect(ROLE_NAMES).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
    expect(Object.keys(ROLE_PROFILE_NOTES)).toEqual([...ROLE_NAMES]);
    expect(ROLE_DISPLAY_NAMES).toEqual({
      manager: "Beads Manager",
      worker: "Beads Worker",
      reviewer: "Beads Reviewer",
      orchestrator: "Beads Orchestrator",
    });
    for (const role of ROLE_NAMES) {
      expect(ROLE_PROFILE_NOTES[role], role).toContain("paseo-bm ");
    }
  });
});

describe("what a created role looks like", () => {
  it("gives the Manager and the Worker Paseo tools minus their disabled list, and the Reviewer and the Orchestrator none", () => {
    expect(roleAliasEntry("manager", "claude")).toEqual({
      extends: "claude",
      label: "Beads Manager",
      paseoTools: { enabled: true, disabledTools: [...MANAGER_DISABLED_PASEO_TOOLS] },
    });
    expect(roleAliasEntry("worker", "codex")).toEqual({
      extends: "codex",
      label: "Beads Worker",
      paseoTools: { enabled: true, disabledTools: [...WORKER_DISABLED_PASEO_TOOLS] },
    });
    // Written as false, never omitted: Paseo 0.9.2 reads a missing policy as
    // enabled while its agent-tools switch is on (autonomy design §A.10).
    expect(roleAliasEntry("reviewer", "codex")).toEqual({ extends: "codex", label: "Beads Reviewer", paseoTools: { enabled: false } });
    expect(roleAliasEntry("orchestrator", "claude")).toEqual({ extends: "claude", label: "Beads Orchestrator", paseoTools: { enabled: false } });
    expect(ROLE_NAMES.map(roleGrantsPaseoTools)).toEqual([true, true, false, false]);
  });

  it("disables exactly the documented Paseo tools (REQ-116), and none the role instructions use", () => {
    expect(MANAGER_DISABLED_PASEO_TOOLS).toEqual([
      "kill_agent",
      "archive_agent",
      "archive_workspace",
      "respond_to_permission",
      "list_pending_permissions",
      "set_agent_mode",
      "update_agent",
      "create_schedule",
      "update_schedule",
      "delete_schedule",
      "run_schedule_once",
      "pause_schedule",
      "resume_schedule",
      "create_heartbeat",
      "delete_heartbeat",
    ]);
    expect(WORKER_DISABLED_PASEO_TOOLS).toEqual([...MANAGER_DISABLED_PASEO_TOOLS, "create_workspace", "rename_workspace"]);
    const used = ["create_agent", "send_agent_prompt", "get_agent_status", "get_agent_activity", "list_agents", "list_profiles", "cancel_agent"];
    for (const tool of used) {
      expect(MANAGER_DISABLED_PASEO_TOOLS, tool).not.toContain(tool);
      expect(WORKER_DISABLED_PASEO_TOOLS, tool).not.toContain(tool);
    }
    // A fresh array each time: a caller that mutates one cannot widen the next role.
    expect(rolePaseoToolsPolicy("worker").disabledTools).not.toBe(rolePaseoToolsPolicy("worker").disabledTools);
  });

  it("maps every main and fallback alias to its role's policy, and nothing else", () => {
    expect(paseoToolsPolicyOfAlias("bm-manager")).toEqual(rolePaseoToolsPolicy("manager"));
    expect(paseoToolsPolicyOfAlias("bm-orchestrator")).toEqual({ enabled: false });
    expect(paseoToolsPolicyOfAlias("bm-worker-fallback-2")).toEqual(rolePaseoToolsPolicy("worker"));
    expect(paseoToolsPolicyOfAlias("bm-manager-fallback-1")).toEqual(rolePaseoToolsPolicy("manager"));
    expect(paseoToolsPolicyOfAlias("bm-reviewer-fallback-3")).toEqual({ enabled: false });
    expect(paseoToolsPolicyOfAlias("bm-worker-fallback-4")).toBeNull();
    expect(paseoToolsPolicyOfAlias("bm-something")).toBeNull();
    expect(paseoToolsPolicyOfAlias("claude")).toBeNull();
  });

  it("names the profile after the alias and writes no mode or thinking option", () => {
    expect(roleProfileEntry("worker", "claude-opus-5")).toEqual({
      id: "bm-worker",
      name: "Beads Worker",
      provider: "bm-worker",
      model: "claude-opus-5",
      notes: ROLE_PROFILE_NOTES.worker,
    });
    expect(roleProfileEntry("orchestrator", "claude-opus-5")).toEqual({
      id: "bm-orchestrator",
      name: "Beads Orchestrator",
      provider: "bm-orchestrator",
      model: "claude-opus-5",
      notes: ROLE_PROFILE_NOTES.orchestrator,
    });
    expect(ROLE_NAMES.map(roleId)).toEqual(["bm-manager", "bm-worker", "bm-reviewer", "bm-orchestrator"]);
  });
});

// ── ensureRoles (design §7.13.2) ───────────────────────────────────────────

/** A daemon that behaves like Paseo 0.8's `config.patch` and lists providers. */
function fakeDaemon(initial: {
  providers?: Record<string, Record<string, unknown>>;
  agentProfiles?: Array<Record<string, unknown>>;
  available?: Array<{ provider: string; available: boolean }>;
  models?: Record<string, Array<{ id: string }>>;
}) {
  const state = {
    providers: structuredClone(initial.providers ?? {}),
    agentProfiles: structuredClone(initial.agentProfiles ?? []),
  };
  const models = initial.models ?? { claude: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }], codex: [{ id: "gpt-5.6-sol" }] };
  const patches: Array<Record<string, unknown>> = [];
  const paseo = {
    providers: {
      listAvailable: vi.fn(async () => ({
        providers: initial.available ?? [{ provider: "claude", available: true }, { provider: "codex", available: true }],
      })),
      listModels: vi.fn(async (provider: string) => ({ provider, models: models[provider] ?? [], error: null })),
    },
    config: {
      get: vi.fn(async () => ({ config: structuredClone(state) })),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        patches.push(structuredClone(patch));
        for (const [id, entry] of Object.entries((patch["providers"] ?? {}) as Record<string, Record<string, unknown>>)) {
          state.providers[id] = { ...(state.providers[id] ?? {}), ...entry };
        }
        if (patch["agentProfiles"] !== undefined) state.agentProfiles = structuredClone(patch["agentProfiles"]) as typeof state.agentProfiles;
        return {};
      }),
    },
  };
  return { paseo, patches, state: () => state };
}

let home: string;
const deps = () => ({ env: {}, homedir: () => home, log: () => {} });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-ensure-roles-"));
  markCleanedUpThisRun(false);
});

afterEach(() => {
  markCleanedUpThisRun(false);
  rmSync(home, { recursive: true, force: true });
});

describe("ensureRoles", () => {
  it("creates all four on a machine the installer never touched, in one patch", async () => {
    const daemon = fakeDaemon({});

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result).toEqual({
      created: ["manager", "worker", "reviewer", "orchestrator"],
      baseProvider: "claude",
      model: "claude-opus-5",
      skipped: null,
    });
    expect(daemon.patches).toHaveLength(1);
    expect(Object.keys(daemon.state().providers)).toEqual(["bm-manager", "bm-worker", "bm-reviewer", "bm-orchestrator"]);
  });

  it("records what it created in the setup state, the Orchestrator in its own field", async () => {
    const daemon = fakeDaemon({});

    await ensureRoles(daemon.paseo, deps());

    const state = readSetupState(deps());
    expect(state).toMatchObject({
      rolesCreated: { roles: ["manager", "worker", "reviewer"], baseProvider: "claude", model: "claude-opus-5" },
    });
    // Never a fourth value in `rolesCreated.roles`: 0.4.1 would read the whole file as empty.
    expect(state.orchestratorCreatedAt).toBe(state.rolesCreated?.at);
  });

  it("gives a 0.4.x machine bm-orchestrator and changes nothing but paseoTools on what it has (REQ-077e, §A.10)", async () => {
    const providers = {
      claude: { enabled: true },
      "bm-manager": { extends: "codex", label: "Beads Manager", paseoTools: { enabled: true } },
      "bm-worker": { extends: "claude", label: "My Worker", paseoTools: { enabled: true, disabledTools: ["x"] } },
      "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
      "bm-worker-fallback-1": { extends: "codex", label: "Beads Worker · fallback 1", paseoTools: { enabled: true } },
    };
    const agentProfiles = [
      { id: "mine", name: "My own", provider: "claude", model: "claude-opus-5" },
      { id: "bm-manager", name: "Beads Manager", provider: "bm-manager", model: "gpt-5.6-sol", modeId: "full-access" },
      { id: "bm-worker", name: "Beads Worker", provider: "bm-worker", model: "claude-sonnet-5", thinkingOptionId: "high", icon: "bot" },
      { id: "bm-reviewer", name: "Beads Reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol", notes: "mine" },
    ];
    const daemon = fakeDaemon({ providers, agentProfiles });
    const earlier = { at: "2026-09-20T08:00:00.000Z", roles: ["manager", "worker", "reviewer"] as const, baseProvider: "codex", model: "gpt-5.6-sol" };
    updateSetupState({ rolesCreated: { ...earlier, roles: [...earlier.roles] } }, deps());

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result).toEqual({ created: ["orchestrator"], baseProvider: "claude", model: "claude-opus-5", skipped: null });
    expect(daemon.patches).toHaveLength(2);
    // First the policy of every bm-* alias already there — the key and nothing else.
    expect(daemon.patches[0]).toEqual({
      providers: {
        "bm-manager": { paseoTools: rolePaseoToolsPolicy("manager") },
        "bm-worker": { paseoTools: rolePaseoToolsPolicy("worker") },
        "bm-reviewer": { paseoTools: { enabled: false } },
        "bm-worker-fallback-1": { paseoTools: rolePaseoToolsPolicy("worker") },
      },
    });
    expect(daemon.patches[1]).toEqual({
      providers: { "bm-orchestrator": { extends: "claude", label: "Beads Orchestrator", paseoTools: { enabled: false } } },
      agentProfiles: [...agentProfiles, roleProfileEntry("orchestrator", "claude-opus-5")],
    });
    const after = daemon.state();
    for (const [id, entry] of Object.entries(providers)) {
      const policy = paseoToolsPolicyOfAlias(id);
      expect(JSON.stringify(after.providers[id]), id).toBe(JSON.stringify(policy === null ? entry : { ...entry, paseoTools: policy }));
    }
    expect(JSON.stringify(after.agentProfiles.slice(0, 4))).toBe(JSON.stringify(agentProfiles));
    expect(after.providers["bm-orchestrator"]).toHaveProperty("paseoTools", { enabled: false });

    // The note about the three roles is the one written before; the Orchestrator has its own.
    const state = readSetupState(deps());
    expect(state.rolesCreated).toEqual({ ...earlier, roles: [...earlier.roles] });
    expect(state.orchestratorCreatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // And it is there for good: the next call has nothing to do.
    expect(await ensureRoles(daemon.paseo, deps())).toEqual({ created: [], baseProvider: null, model: null, skipped: null });
    expect(daemon.patches).toHaveLength(2);
  });

  it("creates only the ones that are missing", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": { extends: "codex" }, "bm-worker": { extends: "codex" } },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }],
    });

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result.created).toEqual(["reviewer", "orchestrator"]);
    expect(daemon.state().providers["bm-manager"]).toEqual({ extends: "codex", paseoTools: rolePaseoToolsPolicy("manager") });
  });

  it("completes a half-created role: a profile for an alias keeps that alias's provider", async () => {
    const daemon = fakeDaemon({
      providers: {
        "bm-manager": { extends: "codex" },
        "bm-worker": { extends: "claude" },
        "bm-reviewer": { extends: "claude" },
        "bm-orchestrator": { extends: "claude" },
      },
      agentProfiles: [{ id: "bm-worker" }, { id: "bm-reviewer" }, { id: "bm-orchestrator" }],
    });

    await ensureRoles(daemon.paseo, deps());

    // The Manager's profile follows its own alias to codex, not the default.
    expect(daemon.state().agentProfiles.at(-1)).toMatchObject({ id: "bm-manager", model: "gpt-5.6-sol" });
    expect(daemon.state().providers["bm-manager"]).toEqual({ extends: "codex", paseoTools: rolePaseoToolsPolicy("manager") });
  });

  it("completes the other half: an alias for a profile, on the default provider", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": {}, "bm-worker": {}, "bm-orchestrator": {} },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer", name: "Mine", model: "mine" }, { id: "bm-orchestrator" }],
    });

    await ensureRoles(daemon.paseo, deps());

    expect(daemon.state().providers["bm-reviewer"]).toEqual({ extends: "claude", label: "Beads Reviewer", paseoTools: { enabled: false } });
    // The profile that was already there is kept exactly as it was.
    expect(daemon.state().agentProfiles[2]).toEqual({ id: "bm-reviewer", name: "Mine", model: "mine" });
  });

  it("patches nothing when all four are there with their policy", async () => {
    const daemon = fakeDaemon({
      providers: Object.fromEntries(ROLE_NAMES.map((role) => [roleId(role), { paseoTools: rolePaseoToolsPolicy(role) }])),
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }, { id: "bm-orchestrator" }],
    });

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result).toEqual({ created: [], baseProvider: null, model: null, skipped: null });
    expect(daemon.patches).toHaveLength(0);
  });

  it("gives roles that exist without a policy theirs, in one patch of paseoTools alone, and keeps a key the user added", async () => {
    const daemon = fakeDaemon({
      providers: {
        claude: { enabled: true },
        "bm-manager": { extends: "claude", label: "Beads Manager", paseoTools: { enabled: true } },
        "bm-worker": { extends: "claude", label: "Beads Worker", paseoTools: { enabled: true }, env: { MINE: "1" } },
        "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
        "bm-orchestrator": { extends: "claude", label: "Beads Orchestrator" },
        "bm-reviewer-fallback-1": { extends: "claude", label: "Reviewer (fallback 1)" },
        "bm-mine": { extends: "claude" },
      },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }, { id: "bm-orchestrator" }],
    });
    const lines: string[] = [];

    const result = await ensureRoles(daemon.paseo, { ...deps(), log: (line: string) => lines.push(line) });

    expect(result).toEqual({ created: [], baseProvider: null, model: null, skipped: null });
    expect(daemon.patches).toEqual([
      {
        providers: {
          "bm-manager": { paseoTools: rolePaseoToolsPolicy("manager") },
          "bm-worker": { paseoTools: rolePaseoToolsPolicy("worker") },
          "bm-reviewer": { paseoTools: { enabled: false } },
          "bm-orchestrator": { paseoTools: { enabled: false } },
          "bm-reviewer-fallback-1": { paseoTools: { enabled: false } },
        },
      },
    ]);
    const after = daemon.state().providers;
    expect(after["bm-worker"]).toEqual({ extends: "claude", label: "Beads Worker", paseoTools: rolePaseoToolsPolicy("worker"), env: { MINE: "1" } });
    expect(after["bm-mine"]).toEqual({ extends: "claude" });
    expect(after["claude"]).toEqual({ enabled: true });
    expect(lines.some((line) => line.includes("Paseo-tools policy") && line.includes("bm-reviewer-fallback-1"))).toBe(true);

    // Once written, a second call sends nothing.
    await ensureRoles(daemon.paseo, deps());
    expect(daemon.patches).toHaveLength(1);
  });

  it("leaves the policy alone after the user removed paseo-bm's settings", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": { extends: "claude" } },
      agentProfiles: [{ id: "bm-manager" }],
    });
    markCleanedUpThisRun(true);

    expect((await ensureRoles(daemon.paseo, deps())).skipped).toBe("cleaned-up");
    expect(daemon.patches).toHaveLength(0);
  });

  it("fails loudly when Paseo does not keep the policy, and creates nothing after it", async () => {
    const daemon = fakeDaemon({ providers: { "bm-reviewer": { extends: "claude" } }, agentProfiles: [] });
    daemon.paseo.config.patch.mockImplementationOnce(async () => ({}));

    await expect(ensureRoles(daemon.paseo, deps())).rejects.toMatchObject({ code: "E_SETUP_ROLES_FAILED" });
    expect(daemon.state().providers["bm-reviewer"]).toEqual({ extends: "claude" });
    expect(daemon.state().agentProfiles).toEqual([]);
  });

  it("uses the first provider Paseo returns, not the alphabetically first", async () => {
    const daemon = fakeDaemon({
      available: [{ provider: "bm-worker", available: true }, { provider: "codex", available: true }, { provider: "claude", available: true }],
    });

    const result = await ensureRoles(daemon.paseo, deps());

    // `bm-worker` is one of our own aliases and is never a base provider.
    expect(result.baseProvider).toBe("codex");
    expect(result.model).toBe("gpt-5.6-sol");
  });

  it("writes nothing when Paseo reports no available provider", async () => {
    const daemon = fakeDaemon({ available: [{ provider: "claude", available: false }] });

    await expect(ensureRoles(daemon.paseo, deps())).rejects.toThrow("E_SETUP_ROLES_FAILED: Paseo reports no available provider");
    expect(daemon.patches).toHaveLength(0);
  });

  it("writes nothing when Paseo lists no model for that provider", async () => {
    const daemon = fakeDaemon({ models: { claude: [] } });

    await expect(ensureRoles(daemon.paseo, deps())).rejects.toThrow("E_SETUP_ROLES_FAILED: Paseo lists no model for claude");
    expect(daemon.patches).toHaveLength(0);
  });

  it("reports a refused patch and a read-back that lost the entries", async () => {
    const refusing = fakeDaemon({});
    vi.spyOn(refusing.paseo.config, "patch").mockRejectedValueOnce(new Error("Request failed: read-only"));
    await expect(ensureRoles(refusing.paseo, deps())).rejects.toMatchObject({ code: "E_SETUP_ROLES_FAILED" });

    const forgetful = fakeDaemon({});
    vi.spyOn(forgetful.paseo.config, "patch").mockImplementationOnce(async () => ({}));
    await expect(ensureRoles(forgetful.paseo, deps())).rejects.toMatchObject({ code: "E_SETUP_ROLES_FAILED" });
  });
});

describe("the mark left by \"Remove paseo-bm's settings\"", () => {
  it("stops the roles being created again, from the state file", async () => {
    const daemon = fakeDaemon({});
    updateSetupState({ cleanedUpAt: "2026-09-25T12:00:00.000Z" }, deps());

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result).toEqual({ created: [], baseProvider: null, model: null, skipped: "cleaned-up" });
    expect(daemon.patches).toHaveLength(0);
  });

  it("stops bm-orchestrator being created on a machine that still has the three roles", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": {}, "bm-worker": {}, "bm-reviewer": {} },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }],
    });
    updateSetupState({ cleanedUpAt: "2026-09-25T12:00:00.000Z" }, deps());

    expect(await ensureRoles(daemon.paseo, deps())).toMatchObject({ created: [], skipped: "cleaned-up" });
    expect(daemon.patches).toHaveLength(0);
    expect(readSetupState(deps()).orchestratorCreatedAt).toBeNull();
  });

  it("stops them for the rest of the run even before anything is written", async () => {
    const daemon = fakeDaemon({});
    markCleanedUpThisRun(true);

    expect(await ensureRoles(daemon.paseo, deps())).toMatchObject({ skipped: "cleaned-up" });
    expect(daemon.patches).toHaveLength(0);
  });

  it("is cleared by resume, which then creates the roles", async () => {
    const daemon = fakeDaemon({});
    updateSetupState({ cleanedUpAt: "2026-09-25T12:00:00.000Z" }, deps());
    markCleanedUpThisRun(true);

    const result = await ensureRoles(daemon.paseo, { ...deps(), resume: true });

    expect(result.created).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
    expect(readSetupState(deps()).cleanedUpAt).toBeNull();
    // And it stays cleared for the next call.
    expect(await ensureRoles(daemon.paseo, deps())).toMatchObject({ skipped: null });
  });

  it("creates the roles on a machine whose data folder cannot be read at all", async () => {
    const daemon = fakeDaemon({});

    const result = await ensureRoles(daemon.paseo, { env: { PASEO_BM_HOME: "relative/bm" }, homedir: () => home, log: () => {} });

    expect(result.created).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
  });
});

describe("two callers at once", () => {
  it("produce exactly one patch: Setup opening while manager.ensure runs", async () => {
    const daemon = fakeDaemon({});

    const [first, second] = await Promise.all([ensureRoles(daemon.paseo, deps()), ensureRoles(daemon.paseo, deps())]);

    expect(daemon.patches).toHaveLength(1);
    expect([first.created.length, second.created.length].sort()).toEqual([0, 4]);
  });
});
