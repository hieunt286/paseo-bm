import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COORDINATION_DIR_NAME, createCoordinationStore } from "../plugin/server/coordination-store";
import { AUTONOMY_DIR_NAME, createAutonomyStore } from "../plugin/server/autonomy-store";
import { createInterventionStore } from "../plugin/server/intervention-store";
import { cleanupPaseoBm } from "../plugin/server/setup-machine";
import { ensureRoles, markCleanedUpThisRun } from "../plugin/server/setup-roles";
import { readSetupState, updateSetupState } from "../plugin/server/setup-state";
import { setupCleanupRpc } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

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

/** A machine set up with the four roles, their fallbacks and a room of the user's own; Claude can be offered again. */
function daemonWith(options: { injectIntoAgents?: boolean; patchFails?: boolean } = {}) {
  const fake = fakePaseo({
    providers: { available: ["claude"], models: { claude: [{ id: "claude-opus-5" }] } },
    config: {
      providers: {
        claude: { enabled: true },
        "room-lead": { extends: "codex" },
        "bm-manager": { extends: "claude" },
        "bm-worker": { extends: "claude" },
        "bm-reviewer": { extends: "codex" },
        "bm-orchestrator": { extends: "claude" },
        "bm-worker-fallback-1": { extends: "codex" },
        "bm-worker-fallback-2": { extends: "pi" },
        "bm-reviewer-fallback-1": { extends: "pi" },
      },
      agentProfiles: [ROOM, { id: "bm-manager" }, { id: "bm-worker" }, { id: "bm-reviewer" }, { id: "bm-orchestrator" }],
      mcp: { injectIntoAgents: options.injectIntoAgents ?? true },
    },
    ...(options.patchFails === true ? { patch: new Error("Request failed: config is read-only") } : {}),
  });
  type State = { providers: Record<string, unknown>; agentProfiles: Array<Record<string, unknown>>; mcp: { injectIntoAgents: boolean } };
  return { paseo: fake.paseo, patches: fake.patches, state: () => fake.config<State>() };
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
  // The Orchestrator's folder (orchestrator design §5): settings, a first-design
  // nudges.json nothing reads any more, and an assessment. It goes whole.
  mkdirSync(join(dataHome, "orchestrator", "assessments"), { recursive: true });
  for (const name of ["settings.json", "nudges.json", "model-corrections.json"]) {
    writeFileSync(join(dataHome, "orchestrator", name), "{}");
  }
  writeFileSync(join(dataHome, "orchestrator", "assessments", "wks_1.jsonl"), "{}\n");
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
    const daemon = daemonWith();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(daemon.patches).toHaveLength(1);
    expect(result.removedProviders).toEqual([
      "bm-manager",
      "bm-worker",
      "bm-reviewer",
      "bm-orchestrator",
      "bm-worker-fallback-1",
      "bm-worker-fallback-2",
      "bm-reviewer-fallback-1",
    ]);
    expect(result.removedProfiles).toEqual(["bm-manager", "bm-worker", "bm-reviewer", "bm-orchestrator"]);
    expect(Object.keys(daemon.state().providers)).toEqual(["claude", "room-lead"]);
    expect(daemon.state().agentProfiles).toEqual([ROOM]);
    expect(result.nextCommand).toBe("paseo plugin remove paseo-bm");
  });

  it("puts the agent-tools switch back when paseo-bm turned it on", async () => {
    const daemon = daemonWith({ injectIntoAgents: true });
    updateSetupState({ agentTools: { setBy: "plugin", previous: false, at: "2026-09-25T10:00:00.000Z" } }, deps());

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.agentTools).toBe("restored");
    expect(daemon.state().mcp.injectIntoAgents).toBe(false);
    expect(daemon.patches[0]).toMatchObject({ mcp: { injectIntoAgents: false } });
  });

  it("leaves a switch the user turned on exactly where it is", async () => {
    const daemon = daemonWith({ injectIntoAgents: true });

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.agentTools).toBe("left-on");
    expect(daemon.state().mcp.injectIntoAgents).toBe(true);
    expect(daemon.patches[0]).not.toHaveProperty("mcp");
  });

  it("says off when the switch was never on", async () => {
    const daemon = daemonWith({ injectIntoAgents: false });

    expect((await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps())).agentTools).toBe("off");
  });

  it("restores a switch that was on before paseo-bm, to what was recorded", async () => {
    const daemon = daemonWith({ injectIntoAgents: true });
    updateSetupState({ agentTools: { setBy: "installer", previous: true, at: "2026-09-01T00:00:00.000Z" } }, deps());

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.agentTools).toBe("restored");
    expect(daemon.state().mcp.injectIntoAgents).toBe(true);
  });

  it("writes the cleanup mark and forgets that the switch was ever ours", async () => {
    const daemon = daemonWith();
    updateSetupState({ agentTools: { setBy: "plugin", previous: false, at: "2026-09-25T10:00:00.000Z" } }, deps());

    await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(readSetupState(deps())).toMatchObject({ cleanedUpAt: "2026-09-25T12:00:00.000Z", agentTools: null });
  });

  it("writes no mark and deletes nothing when the patch is refused", async () => {
    const daemon = daemonWith({ patchFails: true });
    fillDataHome();

    await expect(cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps())).rejects.toMatchObject({
      code: "E_SETUP_WRITE_FAILED",
    });

    expect(readSetupState(deps()).cleanedUpAt).toBeNull();
    expect(existsSync(join(dataHome, "traces"))).toBe(true);
  });

  it("keeps the data folder untouched unless asked", async () => {
    const daemon = daemonWith();
    fillDataHome();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());

    expect(result.data).toBeNull();
    expect(existsSync(join(dataHome, "traces"))).toBe(true);
    expect(existsSync(join(dataHome, "role-extras.json"))).toBe(true);
    expect(existsSync(join(dataHome, "orchestrator", "assessments", "wks_1.jsonl"))).toBe(true);
  });
});

describe("deleting the data too", () => {
  it("deletes what the plugin made and keeps what it did not", async () => {
    const daemon = daemonWith();
    fillDataHome();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted.sort()).toEqual(
      [
        "traces",
        "role-extras.json",
        "role-fallback.json",
        "role-fallback-state.json",
        "orchestrator",
        join("ui", "answer-marks.json"),
        join("ui", "budget-told.json"),
        join("ui", "qa-ledger.json"),
        join("ui", "agent-tools.json"),
      ].sort(),
    );
    for (const gone of ["traces", "role-extras.json", "role-fallback.json", "role-fallback-state.json", "orchestrator"]) {
      expect(existsSync(join(dataHome, gone))).toBe(false);
    }
    for (const kept of ["home.json", "install.json", ".lock", "plugin", "backups"]) {
      expect(existsSync(join(dataHome, kept))).toBe(true);
      expect(result.data?.kept.join("\n")).toContain(kept);
    }
    // Before `orchestrator` was listed, the cleanup kept it as somebody else's.
    expect(result.data?.kept.join("\n")).not.toContain("orchestrator");
    // Nothing outside the data folder is ever looked at.
    expect(existsSync(join(home, "notes.txt"))).toBe(true);
  });

  it("keeps the setup state, because it carries the mark", async () => {
    const daemon = daemonWith();
    fillDataHome();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(existsSync(join(dataHome, "ui", "setup-state.json"))).toBe(true);
    expect(result.data?.kept.join("\n")).toContain("ui/setup-state.json");
    expect(readSetupState(deps()).cleanedUpAt).toBe("2026-09-25T12:00:00.000Z");
  });

  it("skips a symlink instead of following it", async () => {
    const daemon = daemonWith();
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

  it("keeps a symlinked orchestrator/ and what it points at", async () => {
    const daemon = daemonWith();
    fillDataHome();
    const outside = join(home, "outside-orchestrator");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "settings.json"), "keep me");
    rmSync(join(dataHome, "orchestrator"), { recursive: true });
    symlinkSync(outside, join(dataHome, "orchestrator"));

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted).not.toContain("orchestrator");
    expect(result.data?.kept.join("\n")).toContain("orchestrator (orchestrator is a symlink; paseo-bm did not create it)");
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("keep me");
  });

  it("deletes Settings → Coordination with the rest (autonomy design §G.7)", async () => {
    const daemon = daemonWith();
    fillDataHome();
    createCoordinationStore(dataHome).set({ key: "advice.everyFinished", value: 0 });
    expect(existsSync(join(dataHome, COORDINATION_DIR_NAME, "settings.json"))).toBe(true);

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted).toContain(COORDINATION_DIR_NAME);
    expect(existsSync(join(dataHome, COORDINATION_DIR_NAME))).toBe(false);
    expect(result.data?.kept.join("\n")).not.toContain(COORDINATION_DIR_NAME);
  });

  it("deletes the autonomy policy with the rest (autonomy design §B.2)", async () => {
    const daemon = daemonWith();
    fillDataHome();
    createAutonomyStore(dataHome).set({ workspaceId: "w1", class: "scope", mode: "delegate", confirmed: true }, "2026-09-30T10:00:00.000Z");
    expect(existsSync(join(dataHome, AUTONOMY_DIR_NAME, "policy.json"))).toBe(true);

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted).toContain(AUTONOMY_DIR_NAME);
    expect(existsSync(join(dataHome, AUTONOMY_DIR_NAME))).toBe(false);
    expect(result.data?.kept.join("\n")).not.toContain(AUTONOMY_DIR_NAME);
  });

  it("deletes the intervention log with orchestrator/ (autonomy design §G.3)", async () => {
    const daemon = daemonWith();
    fillDataHome();
    const log = createInterventionStore(dataHome);
    log.record({ kind: "stop", workspaceId: "w1", requestId: null, targetAgentId: "agent-w", trigger: "orchestrator" });
    expect(existsSync(log.path)).toBe(true);

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    expect(result.data?.deleted).toContain("orchestrator");
    expect(existsSync(log.path)).toBe(false);
    expect(existsSync(join(dataHome, "orchestrator"))).toBe(false);
  });

  // Review b1: checking only the last component is not enough. `readdir`
  // follows a symlinked `ui/`, and the `lstat` of `ui/<name>` then resolves
  // through it and reports an ordinary file, so the delete lands outside the
  // data folder.
  it("does not list, let alone delete through, a symlinked ui/", async () => {
    const daemon = daemonWith();
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
    const daemon = daemonWith();
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
    const daemon = daemonWith();

    const result = await cleanupPaseoBm(daemon.paseo, { deleteData: true }, { env: { PASEO_BM_HOME: "relative/bm" }, homedir: () => home });

    expect(result.data?.deleted).toEqual([]);
    expect(result.data?.kept.join("\n")).toContain("the data folder could not be used");
    expect(result.removedProviders.length).toBeGreaterThan(0);
  });
});

describe("after the button, before `paseo plugin remove`", () => {
  it("does not recreate the roles, even once the plugin has reloaded", async () => {
    const daemon = daemonWith();
    await cleanupPaseoBm(daemon.paseo, { deleteData: true }, deps());

    // A reload clears the in-memory flag; the mark on disk is what remains.
    markCleanedUpThisRun(false);
    const again = await ensureRoles(daemon.paseo, { ...deps(), log: () => {} });

    expect(again).toMatchObject({ created: [], skipped: "cleaned-up" });
    expect(daemon.patches).toHaveLength(1);
  });

  it("creates them again when the user asks to set up again", async () => {
    const daemon = daemonWith();
    await cleanupPaseoBm(daemon.paseo, { deleteData: false }, deps());
    markCleanedUpThisRun(false);

    const again = await ensureRoles(daemon.paseo, { ...deps(), log: () => {}, resume: true });

    expect(again.created).toEqual(["manager", "worker", "reviewer", "orchestrator"]);
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
