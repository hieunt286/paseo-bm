import { describe, expect, it, vi } from "vitest";
import { canonicalJson, roleConfigRevision, writeRoleConfig, type ConfigPaseo, type RoleConfigView, type RoleConfigWrite } from "../plugin/server/config-writer";
import { DashboardError } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.3.4, ADR-008 D3: the plugin's only write path to Paseo's
 * config. The fake daemon behaves like Paseo 0.8's `config.patch` (proposal
 * S10): `providers` deep-merged, `removeProviders` deletes, `agentProfiles`
 * replaced whole.
 */

type Profile = Record<string, unknown>;

function fakeDaemon(initial: { providers: Record<string, Record<string, unknown>>; agentProfiles: Profile[] }) {
  let state = structuredClone(initial);
  const patches: Array<Record<string, unknown>> = [];
  /** Runs once, between the write's first read and its patch (a concurrent writer). */
  let beforePatch: (() => void) | null = null;
  let getCalls = 0;
  const paseo: ConfigPaseo = {
    config: {
      get: vi.fn(async () => {
        getCalls += 1;
        return { config: structuredClone(state) as RoleConfigView };
      }),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        beforePatch?.();
        beforePatch = null;
        patches.push(structuredClone(patch));
        const providers = patch.providers as Record<string, Record<string, unknown>> | undefined;
        for (const [id, entry] of Object.entries(providers ?? {})) state.providers[id] = { ...(state.providers[id] ?? {}), ...entry };
        for (const id of (patch.removeProviders as string[] | undefined) ?? []) delete state.providers[id];
        if (patch.agentProfiles !== undefined) state.agentProfiles = structuredClone(patch.agentProfiles as Profile[]);
        return { config: structuredClone(state) };
      }),
    },
  };
  return {
    paseo,
    patches,
    state: () => state,
    set: (next: typeof state) => (state = next),
    concurrently: (change: () => void) => (beforePatch = change),
    getCalls: () => getCalls,
  };
}

const ROOM = { id: "room-lead", name: "Lead", provider: "room-lead", model: "gpt-5", notes: "paseo-room" };
const initial = () => ({
  providers: {
    "bm-worker": { extends: "claude", label: "Worker", paseoTools: { enabled: true, disabledTools: ["x"] } },
    "bm-reviewer": { extends: "codex", label: "Reviewer" },
    "room-lead": { extends: "codex" },
  },
  agentProfiles: [
    ROOM,
    { id: "bm-worker", name: "Worker", provider: "bm-worker", model: "claude-opus-5", thinkingOptionId: "high", icon: "bot" },
    { id: "bm-reviewer", name: "Reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol" },
  ],
});

describe("roleConfigRevision", () => {
  it("is stable under key order and ignores non-bm providers, but covers the whole profile array", () => {
    const a = initial();
    const b = { providers: { "room-lead": { extends: "claude" }, "bm-reviewer": { label: "Reviewer", extends: "codex" }, "bm-worker": a.providers["bm-worker"] }, agentProfiles: a.agentProfiles };
    expect(roleConfigRevision(b)).toBe(roleConfigRevision(a));
    const roomChanged = { ...a, agentProfiles: [{ ...ROOM, model: "gpt-6" }, ...a.agentProfiles.slice(1)] };
    expect(roleConfigRevision(roomChanged)).not.toBe(roleConfigRevision(a));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("writeRoleConfig", () => {
  it("writes one patch that changes only the named bm-* entries; every other profile stays byte-identical", async () => {
    const daemon = fakeDaemon(initial());
    const revision = roleConfigRevision(daemon.state());
    const result = await writeRoleConfig(daemon.paseo, {
      expectedRevision: revision,
      providers: { "bm-worker": { extends: "opencode" } },
      profiles: { "bm-worker": { model: "anthropic/claude-sonnet-4-6", thinkingOptionId: null, modeId: "bytes" } },
    });
    expect(daemon.patches).toHaveLength(1);
    const after = daemon.state();
    expect(after.providers["bm-worker"]).toEqual({ extends: "opencode", label: "Worker", paseoTools: { enabled: true, disabledTools: ["x"] } });
    expect(after.agentProfiles[1]).toEqual({ id: "bm-worker", name: "Worker", provider: "bm-worker", model: "anthropic/claude-sonnet-4-6", modeId: "bytes", icon: "bot" });
    // `null` removed the key rather than writing null.
    expect(after.agentProfiles[1]).not.toHaveProperty("thinkingOptionId");
    expect(JSON.stringify(after.agentProfiles[0])).toBe(JSON.stringify(ROOM));
    expect(JSON.stringify(after.agentProfiles[2])).toBe(JSON.stringify(initial().agentProfiles[2]));
    expect(result.revision).toBe(roleConfigRevision(after));
  });

  it("writes nothing when the revision changed since the user opened the screen", async () => {
    const daemon = fakeDaemon(initial());
    const stale = roleConfigRevision(daemon.state());
    daemon.set({ ...daemon.state(), agentProfiles: [{ ...ROOM, model: "gpt-6" }, ...daemon.state().agentProfiles.slice(1)] });
    await expect(writeRoleConfig(daemon.paseo, { expectedRevision: stale, profiles: { "bm-worker": { model: "x" } } })).rejects.toMatchObject({
      code: "E_ROLE_SETTINGS_CONFLICT",
    });
    expect(daemon.paseo.config.patch).not.toHaveBeenCalled();
  });

  it("sends no agentProfiles array at all when no role profile changes", async () => {
    const daemon = fakeDaemon(initial());
    await writeRoleConfig(daemon.paseo, {
      expectedRevision: roleConfigRevision(daemon.state()),
      providers: { "bm-worker-fallback-1": { extends: "codex", label: "Worker (fallback 1)", paseoTools: { enabled: true } } },
    });
    expect(daemon.patches[0]).not.toHaveProperty("agentProfiles");
    expect(daemon.state().providers["bm-worker-fallback-1"]).toEqual({ extends: "codex", label: "Worker (fallback 1)", paseoTools: { enabled: true } });
  });

  it("deletes a bm-* alias with removeProviders", async () => {
    const daemon = fakeDaemon({ ...initial(), providers: { ...initial().providers, "bm-worker-fallback-2": { extends: "pi" } } });
    await writeRoleConfig(daemon.paseo, { expectedRevision: roleConfigRevision(daemon.state()), removeProviders: ["bm-worker-fallback-2"] });
    expect(daemon.patches[0]).toEqual({ removeProviders: ["bm-worker-fallback-2"] });
    expect(daemon.state().providers).not.toHaveProperty("bm-worker-fallback-2");
  });

  it("refuses anything outside its scope, before any write", async () => {
    const daemon = fakeDaemon(initial());
    const revision = roleConfigRevision(daemon.state());
    const cases: Array<Omit<RoleConfigWrite, "expectedRevision">> = [
      { providers: { "room-lead": { extends: "claude" } } },
      { removeProviders: ["room-lead"] },
      { removeProviders: ["bm-worker"] },
      { providers: { "bm-manager": { extends: "claude" } } },
      { profiles: { "room-lead": { model: "x" } } },
      { profiles: { "bm-manager": { model: "x" } } },
    ];
    for (const write of cases) {
      await expect(writeRoleConfig(daemon.paseo, { expectedRevision: revision, ...write })).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_INVALID" });
    }
    expect(daemon.paseo.config.patch).not.toHaveBeenCalled();
  });

  it("checks its OWN entries on the read-back (Q15 a): a write Paseo did not keep is an error", async () => {
    const daemon = fakeDaemon(initial());
    const revision = roleConfigRevision(daemon.state());
    daemon.paseo.config.patch = vi.fn(async () => ({}));
    await expect(
      writeRoleConfig(daemon.paseo, { expectedRevision: revision, providers: { "bm-worker": { extends: "pi" } }, profiles: { "bm-worker": { model: "qwen" } } }),
    ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_WRITE_FAILED", message: expect.stringContaining("provider bm-worker, profile bm-worker") });
  });

  it("reports a removal the read-back still shows", async () => {
    const daemon = fakeDaemon({ ...initial(), providers: { ...initial().providers, "bm-worker-fallback-2": { extends: "pi" } } });
    daemon.paseo.config.patch = vi.fn(async () => ({}));
    await expect(
      writeRoleConfig(daemon.paseo, { expectedRevision: roleConfigRevision(daemon.state()), removeProviders: ["bm-worker-fallback-2"] }),
    ).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_WRITE_FAILED", message: expect.stringContaining("removal of provider bm-worker-fallback-2") });
  });

  it("accepts a read-back where another writer changed an unrelated profile after the write", async () => {
    const daemon = fakeDaemon(initial());
    const revision = roleConfigRevision(daemon.state());
    const original = daemon.paseo.config.patch;
    daemon.paseo.config.patch = vi.fn(async (patch: Record<string, unknown>) => {
      const result = await original(patch);
      daemon.state().agentProfiles[0] = { ...ROOM, model: "gpt-6" };
      return result;
    });
    const result = await writeRoleConfig(daemon.paseo, { expectedRevision: revision, profiles: { "bm-worker": { model: "claude-sonnet-5" } } });
    expect(result.revision).toBe(roleConfigRevision(daemon.state()));
  });

  it("reports the daemon's refusal as E_ROLE_SETTINGS_WRITE_FAILED", async () => {
    const daemon = fakeDaemon(initial());
    daemon.paseo.config.patch = vi.fn(async () => {
      throw new Error("invalid config: agentProfiles[1].model");
    });
    const failure = writeRoleConfig(daemon.paseo, { expectedRevision: roleConfigRevision(daemon.state()), profiles: { "bm-worker": { model: "x" } } });
    await expect(failure).rejects.toBeInstanceOf(DashboardError);
    await expect(failure).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_WRITE_FAILED" });
  });

  it("runs two writes one after the other, so the second sees the first", async () => {
    const daemon = fakeDaemon(initial());
    const revision = roleConfigRevision(daemon.state());
    const first = writeRoleConfig(daemon.paseo, { expectedRevision: revision, profiles: { "bm-worker": { model: "a" } } });
    // Queued behind the first: by the time it reads, the revision has moved on.
    const second = writeRoleConfig(daemon.paseo, { expectedRevision: revision, profiles: { "bm-reviewer": { model: "b" } } });
    await expect(first).resolves.toMatchObject({ revision: expect.any(String) });
    await expect(second).rejects.toMatchObject({ code: "E_ROLE_SETTINGS_CONFLICT" });
    expect(daemon.patches).toHaveLength(1);
  });

  it("KNOWN LIMIT (owner question Q15): a change landing between its read and its patch is overwritten and cannot be reported", async () => {
    const daemon = fakeDaemon(initial());
    const revision = roleConfigRevision(daemon.state());
    daemon.concurrently(() => {
      const state = daemon.state();
      state.agentProfiles[0] = { ...ROOM, model: "gpt-6" };
    });
    await writeRoleConfig(daemon.paseo, { expectedRevision: revision, profiles: { "bm-worker": { model: "claude-sonnet-5" } } });
    // The whole array written back restores room-lead as it was read: the
    // read-back equals the first read, so there is nothing left to report.
    expect(daemon.state().agentProfiles[0]).toEqual(ROOM);
    expect(daemon.getCalls()).toBe(2);
  });
});
