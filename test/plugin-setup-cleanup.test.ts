import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupPaseoBm } from "../plugin/server/setup-machine";
import { ensureRoles, markCleanedUpThisRun } from "../plugin/server/setup-roles";
import { readSetupState, updateSetupState } from "../plugin/server/setup-state";
import { setupCleanupRpc } from "../plugin/shared/contracts";

/**
 * WP-404: "Remove paseo-bm's settings" (design §7.13.7, ADR-012 decision 6).
 *
 * Paseo has no hook that runs when a plugin is removed, so this button is the
 * whole uninstall. Two properties matter more than the removal itself: it must
 * put Paseo's agent-tools switch back ONLY when paseo-bm turned it on, and it
 * must leave the mark that stops the plugin recreating the roles before the
 * user gets around to `paseo plugin remove`.
 */

let home: string;
let dataHome: string;
const deps = () => ({ env: {}, homedir: () => home, now: () => new Date("2026-09-25T12:00:00.000Z") });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-cleanup-"));
  dataHome = join(home, ".paseo-bm");
  markCleanedUpThisRun(false);
});

afterEach(() => {
  markCleanedUpThisRun(false);
  rmSync(home, { recursive: true, force: true });
});

const ROOM = { id: "room-lead", name: "Lead", provider: "room-lead", model: "gpt-5" };

function fakeDaemon(options: { injectIntoAgents?: boolean; patchFails?: boolean } = {}) {
  const state: { providers: Record<string, unknown>; agentProfiles: Array<Record<string, unknown>>; mcp: { injectIntoAgents: boolean } } = {
    providers: {
      claude: { enabled: true },
      "room-lead": { extends: "codex" },
      "bm-manager": { extends: "claude" },
      "bm-worker": { extends: "claude" },
      "bm-reviewer": { extends: "codex" },
      "bm-worker-fallback-1": { extends: "codex" },
      "bm-worker-fallback-2": { extends: "pi" },
      "bm-reviewer-fallback-1": { extends: "pi" },
    },
    agentProfiles: [ROOM, { id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }],
    mcp: { injectIntoAgents: options.injectIntoAgents ?? true },
  };
  const patches: Array<Record<string, unknown>> = [];
  const paseo = {
    config: {
      get: vi.fn(async () => ({ config: structuredClone(state) })),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        if (options.patchFails === true) throw new Error("Request failed: config is read-only");
        patches.push(structuredClone(patch));
        for (const [id, entry] of Object.entries((patch["providers"] ?? {}) as Record<string, Record<string, unknown>>)) {
          state.providers[id] = { ...((state.providers[id] ?? {}) as object), ...entry };
        }
        for (const id of (patch["removeProviders"] as string[] | undefined) ?? []) delete state.providers[id];
        if (patch["agentProfiles"] !== undefined) state.agentProfiles = structuredClone(patch["agentProfiles"]) as typeof state.agentProfiles;
        const mcp = patch["mcp"] as { injectIntoAgents?: boolean } | undefined;
        if (mcp?.injectIntoAgents !== undefined) state.mcp.injectIntoAgents = mcp.injectIntoAgents;
        return {};
      }),
    },
  };
  return { paseo, patches, state: () => state };
}

/** A data folder with one of everything the button may and may not touch. */
function fillDataHome(): void {
  mkdirSync(join(dataHome, "traces", "wks_1"), { recursive: true });
  writeFileSync(join(dataHome, "traces", "wks_1", "events.jsonl"), "{}\n");
  mkdirSync(join(dataHome, "ui"), { recursive: true });
  for (const name of ["answer-marks.json", "budget-told.json", "qa-ledger.json", "agent-tools.json"]) {
    writeFileSync(join(dataHome, "ui", name), "{}");
  }
  for (const name of ["role-extras.json", "role-fallback.json", "role-fallback-state.json"]) {
    writeFileSync(join(dataHome, name), "{}");
  }
  // Not ours: the CLI's pointer, the old installer's record and folders.
  // A valid pointer naming this same folder: it reads as "no pointer", which is
  // what a 0.4.0 CLI leaves on a machine whose data folder is the default one.
  writeFileSync(
    join(dataHome, "home.json"),
    JSON.stringify({ schemaVersion: 1, home: dataHome, writtenBy: "paseo-bm@0.4.0", at: "2026-09-25T00:00:00.000Z" }),
  );
  writeFileSync(join(dataHome, "install.json"), JSON.stringify({ schemaVersion: 1 }));
  writeFileSync(join(dataHome, ".lock"), "");
  mkdirSync(join(dataHome, "plugin", "0.3.1"), { recursive: true });
  mkdirSync(join(dataHome, "backups", "20260101T000000Z"), { recursive: true });
  writeFileSync(join(home, "notes.txt"), "outside");
}

describe("setup.cleanup", () => {
  it("removes every bm-* entry in one patch and leaves everything else alone", async () => {
    const daemon = fakeDaemon();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(daemon.patches).toHaveLength(1);
    expect(result.removedProviders).toEqual([
      "bm-manager",
      "bm-worker",
      "bm-reviewer",
      "bm-worker-fallback-1",
      "bm-worker-fallback-2",
      "bm-reviewer-fallback-1",
    ]);
    expect(result.removedProfiles).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(Object.keys(daemon.state().providers)).toEqual(["claude", "room-lead"]);
    expect(daemon.state().agentProfiles).toEqual([ROOM]);
    expect(result.nextCommand).toBe("paseo plugin remove paseo-bm");
  });

  it("puts the agent-tools switch back when paseo-bm turned it on", async () => {
    const daemon = fakeDaemon({ injectIntoAgents: true });
    updateSetupState({ agentTools: { setBy: "plugin", previous: false, at: "2026-09-25T10:00:00.000Z" } }, deps());

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.agentTools).toBe("restored");
    expect(daemon.state().mcp.injectIntoAgents).toBe(false);
    expect(daemon.patches[0]).toMatchObject({ mcp: { injectIntoAgents: false } });
  });

  it("leaves a switch the user turned on exactly where it is", async () => {
    const daemon = fakeDaemon({ injectIntoAgents: true });

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.agentTools).toBe("left-on");
    expect(daemon.state().mcp.injectIntoAgents).toBe(true);
    expect(daemon.patches[0]).not.toHaveProperty("mcp");
  });

  it("says off when the switch was never on", async () => {
    const daemon = fakeDaemon({ injectIntoAgents: false });

    expect((await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps())).agentTools).toBe("off");
  });

  it("restores a switch that was on before paseo-bm, to what was recorded", async () => {
    const daemon = fakeDaemon({ injectIntoAgents: true });
    updateSetupState({ agentTools: { setBy: "installer", previous: true, at: "2026-09-01T00:00:00.000Z" } }, deps());

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.agentTools).toBe("restored");
    expect(daemon.state().mcp.injectIntoAgents).toBe(true);
  });

  it("writes the cleanup mark and forgets that the switch was ever ours", async () => {
    const daemon = fakeDaemon();
    updateSetupState({ agentTools: { setBy: "plugin", previous: false, at: "2026-09-25T10:00:00.000Z" } }, deps());

    await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(readSetupState(deps())).toMatchObject({ cleanedUpAt: "2026-09-25T12:00:00.000Z", agentTools: null });
  });

  it("writes no mark and deletes nothing when the patch is refused", async () => {
    const daemon = fakeDaemon({ patchFails: true });
    fillDataHome();

    await expect(cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps())).rejects.toMatchObject({
      code: "E_SETUP_WRITE_FAILED",
    });

    expect(readSetupState(deps()).cleanedUpAt).toBeNull();
    expect(existsSync(join(dataHome, "traces"))).toBe(true);
  });

  it("keeps the data folder untouched unless asked", async () => {
    const daemon = fakeDaemon();
    fillDataHome();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.data).toBeNull();
    expect(existsSync(join(dataHome, "traces"))).toBe(true);
    expect(existsSync(join(dataHome, "role-extras.json"))).toBe(true);
  });
});

describe("deleting the data too", () => {
  it("deletes what the plugin made and keeps what it did not", async () => {
    const daemon = fakeDaemon();
    fillDataHome();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted.sort()).toEqual(
      [
        "traces",
        "role-extras.json",
        "role-fallback.json",
        "role-fallback-state.json",
        join("ui", "answer-marks.json"),
        join("ui", "budget-told.json"),
        join("ui", "qa-ledger.json"),
        join("ui", "agent-tools.json"),
      ].sort(),
    );
    for (const gone of ["traces", "role-extras.json", "role-fallback.json", "role-fallback-state.json"]) {
      expect(existsSync(join(dataHome, gone))).toBe(false);
    }
    for (const kept of ["home.json", "install.json", ".lock", "plugin", "backups"]) {
      expect(existsSync(join(dataHome, kept))).toBe(true);
      expect(result.data?.kept.join("\n")).toContain(kept);
    }
    // Nothing outside the data folder is ever looked at.
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
  });

  it("keeps the setup state, because it carries the mark", async () => {
    const daemon = fakeDaemon();
    fillDataHome();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(existsSync(join(dataHome, "ui", "setup-state.json"))).toBe(true);
    expect(result.data?.kept.join("\n")).toContain("ui/setup-state.json");
    expect(readSetupState(deps()).cleanedUpAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("skips a symlink instead of following it", async () => {
    const daemon = fakeDaemon();
    fillDataHome();
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep-me.txt"), "still here");
    rmSync(join(dataHome, "role-extras.json"));
    symlinkSync(outside, join(dataHome, "role-extras.json"));

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted).not.toContain("role-extras.json");
    expect(result.data?.kept.join("\n")).toContain("role-extras.json (role-extras.json is a symlink; paseo-bm did not create it)");
    expect(readFileSync(join(outside, "keep-me.txt"), "utf8")).toBe("still here");
  });

  // Review b1: checking only the last component is not enough. `readdir`
  // follows a symlinked `ui/`, and the `lstat` of `ui/<name>` then resolves
  // through it and reports an ordinary file, so the delete lands outside the
  // data folder.
  it("does not list, let alone delete through, a symlinked ui/", async () => {
    const daemon = fakeDaemon();
    fillDataHome();
    const outside = join(home, "outside-ui");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "someone-elses.json"), "keep me");
    rmSync(join(dataHome, "ui"), { recursive: true });
    symlinkSync(outside, join(dataHome, "ui"));

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(readFileSync(join(outside, "someone-elses.json"), "utf8")).toBe("keep me");
    expect(result.data?.deleted.filter((name) => name.startsWith("ui"))).toEqual([]);
    expect(result.data?.kept.join("\n")).toContain("ui (ui is a symlink; paseo-bm did not create it)");
  });

  it("deletes nothing at all when the data folder itself is a symlink", async () => {
    const daemon = fakeDaemon();
    const elsewhere = join(home, "elsewhere");
    mkdirSync(join(elsewhere, "traces"), { recursive: true });
    writeFileSync(join(elsewhere, "role-extras.json"), "keep me");
    symlinkSync(elsewhere, dataHome);

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted).toEqual([]);
    expect(result.data?.kept.join("\n")).toContain("the data folder is a symlink");
    expect(readFileSync(join(elsewhere, "role-extras.json"), "utf8")).toBe("keep me");
    expect(existsSync(join(elsewhere, "traces"))).toBe(true);
  });

  it("says so, rather than failing, when the data folder cannot be used", async () => {
    const daemon = fakeDaemon();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, { env: { PASEO_BM_HOME: "relative/bm" }, homedir: () => home });

    expect(result.data?.deleted).toEqual([]);
    expect(result.data?.kept.join("\n")).toContain("the data folder could not be used");
    expect(result.removedProviders.length).toBeGreaterThan(0);
  });
});

describe("after the button, before `paseo plugin remove`", () => {
  it("does not recreate the roles, even once the plugin has reloaded", async () => {
    const daemon = fakeDaemon();
    await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    // A reload clears the in-memory flag; the mark on disk is what remains.
    markCleanedUpThisRun(false);
    const again = await ensureRoles(daemon.paseo, { ...deps(), log: () => {} });

    expect(again).toMatchObject({ created: [], skipped: "cleaned-up" });
    expect(daemon.patches).toHaveLength(1);
  });

  it("creates them again when the user asks to set up again", async () => {
    const daemon = fakeDaemon();
    await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());
    markCleanedUpThisRun(false);

    const again = await ensureRoles(
      { ...daemon.paseo, providers: { listAvailable: async () => ({ providers: [{ provider: "claude", available: true }] }), listModels: async () => ({ models: [{ id: "claude-opus-5" }] }) } },
      { ...deps(), log: () => {}, resume: true },
    );

    expect(again.created).toEqual(["manager", "worker", "reviewer"]);
  });
});

describe("the contract of setup.cleanup", () => {
  it("needs an explicit confirmation and an explicit answer about the data", () => {
    expect(setupCleanupRpc.input.parse({ confirmed: true, deleteData: false })).toEqual({ confirmed: true, deleteData: false });
    for (const input of [{}, { confirmed: true }, { confirmed: false, deleteData: false }, { deleteData: true }]) {
      expect(() => setupCleanupRpc.input.parse(input)).toThrow();
    }
  });
});
