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
  roleAliasEntry,
  roleGrantsPaseoTools,
  roleId,
  roleProfileEntry,
} from "../plugin/server/setup-roles";
import { readSetupState, updateSetupState } from "../plugin/server/setup-state";

/**
 * WP-402: the values the plugin creates the three roles with (design §6.1).
 *
 * These used to be checked against a second copy in `src/roles/`, so a machine
 * set up by the plugin matched one set up by `npx paseo-bm`. WP-406 deleted the
 * installer's copy, so the plugin's is now the only one and what is pinned here
 * is its shape and its exact texts.
 */

describe("the plugin's role texts", () => {
  it("covers exactly the three roles, with the documented names", () => {
    expect(Object.keys(ROLE_PROFILE_NOTES)).toEqual([...ROLE_NAMES]);
    expect(ROLE_DISPLAY_NAMES).toEqual({ manager: "Beads Manager", worker: "Beads Worker", reviewer: "Beads Reviewer" });
    for (const role of ROLE_NAMES) {
      expect(ROLE_PROFILE_NOTES[role], role).toContain("paseo-bm ");
    }
  });
});

describe("what a created role looks like", () => {
  it("gives the Manager and the Worker Paseo tools, and the Reviewer none", () => {
    expect(roleAliasEntry("manager", "claude")).toEqual({ extends: "claude", label: "Beads Manager", paseoTools: { enabled: true } });
    expect(roleAliasEntry("worker", "codex")).toEqual({ extends: "codex", label: "Beads Worker", paseoTools: { enabled: true } });
    // Omitted, not false: that is what ADR-006 D3 says and what an uninstall leaves.
    expect(roleAliasEntry("reviewer", "codex")).toEqual({ extends: "codex", label: "Beads Reviewer" });
    expect(ROLE_NAMES.map(roleGrantsPaseoTools)).toEqual([true, true, false]);
  });

  it("names the profile after the alias and writes no mode or thinking option", () => {
    expect(roleProfileEntry("worker", "claude-opus-5")).toEqual({
      id: "bm-worker",
      name: "Beads Worker",
      provider: "bm-worker",
      model: "claude-opus-5",
      notes: ROLE_PROFILE_NOTES.worker,
    });
    expect(ROLE_NAMES.map(roleId)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
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
  it("creates all three on a machine the installer never touched, in one patch", async () => {
    const daemon = fakeDaemon({});

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result).toEqual({ created: ["manager", "worker", "reviewer"], baseProvider: "claude", model: "claude-opus-5", skipped: null });
    expect(daemon.patches).toHaveLength(1);
    expect(Object.keys(daemon.state().providers)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
  });

  it("records what it created in the setup state", async () => {
    const daemon = fakeDaemon({});

    await ensureRoles(daemon.paseo, deps());

    expect(readSetupState(deps())).toMatchObject({
      rolesCreated: { roles: ["manager", "worker", "reviewer"], baseProvider: "claude", model: "claude-opus-5" },
    });
  });

  it("creates only the one that is missing", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": { extends: "codex" }, "bm-worker": { extends: "codex" } },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }],
    });

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result.created).toEqual(["reviewer"]);
    expect(daemon.state().providers["bm-manager"]).toEqual({ extends: "codex" });
  });

  it("completes a half-created role: a profile for an alias keeps that alias's provider", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": { extends: "codex" }, "bm-worker": { extends: "claude" }, "bm-reviewer": { extends: "claude" } },
      agentProfiles: [{ id: "bm-worker" }, { id: "bm-reviewer" }],
    });

    await ensureRoles(daemon.paseo, deps());

    // The Manager's profile follows its own alias to codex, not the default.
    expect(daemon.state().agentProfiles.at(-1)).toMatchObject({ id: "bm-manager", model: "gpt-5.6-sol" });
    expect(daemon.state().providers["bm-manager"]).toEqual({ extends: "codex" });
  });

  it("completes the other half: an alias for a profile, on the default provider", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": {}, "bm-worker": {} },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer", name: "Mine", model: "mine" }],
    });

    await ensureRoles(daemon.paseo, deps());

    expect(daemon.state().providers["bm-reviewer"]).toEqual({ extends: "claude", label: "Beads Reviewer" });
    // The profile that was already there is kept exactly as it was.
    expect(daemon.state().agentProfiles[2]).toEqual({ id: "bm-reviewer", name: "Mine", model: "mine" });
  });

  it("patches nothing when all three are there", async () => {
    const daemon = fakeDaemon({
      providers: { "bm-manager": {}, "bm-worker": {}, "bm-reviewer": {} },
      agentProfiles: [{ id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }],
    });

    const result = await ensureRoles(daemon.paseo, deps());

    expect(result).toEqual({ created: [], baseProvider: null, model: null, skipped: null });
    expect(daemon.patches).toHaveLength(0);
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

    expect(result.created).toEqual(["manager", "worker", "reviewer"]);
    expect(readSetupState(deps()).cleanedUpAt).toBeNull();
    // And it stays cleared for the next call.
    expect(await ensureRoles(daemon.paseo, deps())).toMatchObject({ skipped: null });
  });

  it("creates the roles on a machine whose data folder cannot be read at all", async () => {
    const daemon = fakeDaemon({});

    const result = await ensureRoles(daemon.paseo, { env: { PASEO_BM_HOME: "relative/bm" }, homedir: () => home, log: () => {} });

    expect(result.created).toEqual(["manager", "worker", "reviewer"]);
  });
});

describe("two callers at once", () => {
  it("produce exactly one patch: Setup opening while manager.ensure runs", async () => {
    const daemon = fakeDaemon({});

    const [first, second] = await Promise.all([ensureRoles(daemon.paseo, deps()), ensureRoles(daemon.paseo, deps())]);

    expect(daemon.patches).toHaveLength(1);
    expect([first.created.length, second.created.length].sort()).toEqual([0, 3]);
  });
});
