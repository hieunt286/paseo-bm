import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore } from "../plugin/server/agent-bindings";
import { createAlertStore } from "../plugin/server/alert-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { currentInstructionsHash } from "../plugin/server/instructions-label";
import { adoptComposerManager, createLegacyMigration, handleManagerEnsure, legacyCodeOf, migrateWorkspace } from "../plugin/server/mission-legacy";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { ensureMissionsHome, type MissionsPaseo } from "../plugin/server/missions-home";
import { EXTRA_MANAGER_DETAIL, detectOutdatedAgents, openMissionsOf } from "../plugin/server/outdated-agents";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { fakeCli } from "./helpers/fake-cli";
import { roleAliases, roleProfiles } from "./helpers/roles";

/**
 * WP-114 (missions design §3.6, REQ-192): per-workspace Managers become
 * one-repo missions, extra Managers are flagged, and `manager.ensure` opens
 * a mission's Main. A fake Paseo and a fake `paseo` CLI in a temporary data
 * folder; no daemon is contacted.
 */

const REPO = "wks-a";
const CURRENT = { "bm.role": "manager", "bm.instructions": currentInstructionsHash("manager") };

let root: string;
let home: string;
let bindings: BindingStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-legacy-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bindings = createBindingStore(home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearJsonFileCache();
  clearBindingCache();
  clearRequestRegistryCache();
  rmSync(root, { recursive: true, force: true });
});

function daemon(agents: FakeAgent[] = []) {
  return fakePaseo<MissionsPaseo>({
    agents,
    workspaces: [
      { id: REPO, directory: "/repo/api" },
      { id: "wks-b", directory: "/repo/web" },
    ],
    config: { providers: roleAliases(), agentProfiles: roleProfiles() },
    omit: ["providers"],
  });
}

const manager = (id: string, createdAt: string, labels: Record<string, string> = {}, extra: Partial<FakeAgent> = {}): FakeAgent => ({
  id,
  workspaceId: REPO,
  provider: "bm-manager",
  status: "idle",
  createdAt,
  labels: { ...CURRENT, ...labels },
  archivedAt: null,
  ...extra,
});

/** A bound binding of the Manager, as the creation hook leaves a composer Manager's. */
function bind(agentId: string, workspaceId = REPO): void {
  const issued = bindings.issue({ role: "manager", workspaceId, origin: "hook" });
  bindings.attach(issued.token, "manager");
  bindings.settle(issued.tokenSha256, agentId);
}

const readInstructions = async () => "instructions";

describe("legacyCodeOf (§3.6)", () => {
  it("takes the folder name's first letters in upper case, made unique with a digit", () => {
    expect(legacyCodeOf("api", () => false)).toBe("API");
    expect(legacyCodeOf("paseo-bm", () => false)).toBe("PASE");
    expect(legacyCodeOf("2fa-service", () => false)).toBe("FASE");
    expect(legacyCodeOf("x", () => false)).toBe("XX");
    expect(legacyCodeOf("--", () => false)).toBe("REPO");
    const taken = new Set(["API", "API2"]);
    expect(legacyCodeOf("api", (code) => taken.has(code))).toBe("API3");
  });
});

describe("the migration of a workspace's Manager (§3.6)", () => {
  it("makes the newest bound, live, non-replaced Manager a one-repo mission's Main, keeping the agent and its open requests", async () => {
    const fake = daemon([
      manager("mgr-old", "2026-10-01T00:00:00.000Z"),
      manager("mgr-bound", "2026-10-02T00:00:00.000Z"),
      manager("mgr-unbound", "2026-10-03T00:00:00.000Z"),
      manager("mgr-replaced", "2026-10-04T00:00:00.000Z", { "bm.replacedBy": "mgr-bound" }),
    ]);
    bind("mgr-old");
    bind("mgr-bound");
    bind("mgr-replaced");
    const registry = createRequestRegistry(home);
    const open = registry.generate(REPO, { managerId: "mgr-bound" });
    registry.addWorker(REPO, open.requestId, "wrk-1");
    const { cli, calls } = fakeCli();

    const mission = await migrateWorkspace(fake.paseo, REPO, { home, cli, bindings: () => bindings, log: () => {} });
    expect(mission).toMatchObject({ code: "API", name: "api", createdBy: "legacy", legacyWorkspaceId: REPO, mainId: "mgr-bound", state: "open" });
    expect(mission!.charter).toMatchObject({ goal: "", repos: [REPO] });
    expect(bindings.bindingOfAgent("mgr-bound")?.missionId).toBe(mission!.missionId);
    expect(calls).toEqual([
      ["agent", "update", "mgr-bound", "--label", `bm.missionId=${mission!.missionId}`, "--label", "bm.missionCode=API", "--json"],
      ["agent", "update", "mgr-bound", "--name", "🟣 M · API api", "--json"],
    ]);
    expect(createMissionRoster(home).list(mission!.missionId)).toEqual([
      expect.objectContaining({ requestId: open.requestId, workspaceId: REPO, workerIds: ["wrk-1"], state: "active" }),
    ]);
    // It stays in the repo workspace: nothing created, nothing archived.
    expect(fake.creates).toEqual([]);
    expect(fake.archives).toEqual([]);

    // Idempotent: a workspace an open mission holds is never given a second one.
    expect(await migrateWorkspace(fake.paseo, REPO, { home, cli, bindings: () => bindings, log: () => {} })).toBeNull();
    expect(createMissionStore(home).list()).toHaveLength(1);
  });

  it("migrates nothing without a bound Manager, for a plugin home, or for a workspace a mission already holds", async () => {
    const fake = daemon([manager("mgr-unbound", "2026-10-01T00:00:00.000Z"), manager("mgr-b", "2026-10-01T00:00:00.000Z", {}, { workspaceId: "wks-b" })]);
    bind("mgr-b", "wks-b");
    const deps = { home, cli: fakeCli().cli, bindings: () => bindings, log: () => {} };
    expect(await migrateWorkspace(fake.paseo, REPO, deps)).toBeNull();
    const { workspaceId: homeId } = await ensureMissionsHome(fake.paseo, { home });
    expect(await migrateWorkspace(fake.paseo, homeId, deps)).toBeNull();
    createMissionStore(home).create({ code: "WEB", name: "Website", goal: "", repos: ["wks-b"], createdBy: "owner" });
    expect(await migrateWorkspace(fake.paseo, "wks-b", deps)).toBeNull();
    expect(createMissionStore(home).list().map((entry) => entry.code)).toEqual(["WEB"]);
  });

  it("runs once per plugin run, at the first Paseo handle, over every workspace with a Manager", async () => {
    const fake = daemon([manager("mgr-a", "2026-10-01T00:00:00.000Z"), manager("mgr-b", "2026-10-01T00:00:00.000Z", {}, { workspaceId: "wks-b" })]);
    bind("mgr-a");
    bind("mgr-b", "wks-b");
    const migration = createLegacyMigration({ home, cli: fakeCli().cli, bindings: () => bindings, log: () => {} });
    await migration.run(fake.paseo);
    await migration.run(fake.paseo);
    expect(
      createMissionStore(home)
        .list()
        .map((entry) => [entry.code, entry.mainId])
        .sort(),
    ).toEqual([
      ["API", "mgr-a"],
      ["WEB", "mgr-b"],
    ]);
  });
});

describe("extra Managers are flagged (§3.6)", () => {
  it("every other live Manager of a repo a mission holds is an outdated-agent alert naming the mission; the Main is not", async () => {
    const agents = [
      manager("mgr-old", "2026-10-01T00:00:00.000Z"),
      manager("mgr-bound", "2026-10-02T00:00:00.000Z"),
      manager("mgr-other", "2026-10-02T00:00:00.000Z", {}, { workspaceId: "wks-c" }),
    ];
    const fake = daemon(agents);
    bind("mgr-bound");
    const mission = (await migrateWorkspace(fake.paseo, REPO, { home, cli: fakeCli().cli, bindings: () => bindings, log: () => {} }))!;
    const alerts = createAlertStore(home);
    // The labels never reached the fake daemon: the mission's mainId still names its Main.
    const result = await detectOutdatedAgents(fake.paseo, alerts, Date.now(), agents, openMissionsOf(home));
    expect(result.extra.map((agent) => agent.agentId)).toEqual(["mgr-old"]);
    expect(alerts.list({ open: true })).toEqual([
      expect.objectContaining({ kind: "outdated-agent", workspaceId: REPO, subject: "mgr-old", detail: EXTRA_MANAGER_DETAIL, role: "manager", missionId: mission.missionId }),
    ]);
  });
});

describe("manager.ensure opens the mission's Main (§3.6)", () => {
  it("migrates the workspace's bound Manager and opens it, reporting the extra Managers", async () => {
    const fake = daemon([manager("mgr-old", "2026-10-01T00:00:00.000Z"), manager("mgr-bound", "2026-10-02T00:00:00.000Z")]);
    bind("mgr-bound");
    const deps = { home, cli: fakeCli().cli, bindings: () => bindings, readInstructions, log: () => {} };
    const result = await handleManagerEnsure({ workspaceId: REPO }, fake.paseo, deps);
    expect(result).toEqual({ agentId: "mgr-bound", created: false, otherManagerIds: ["mgr-old"], modeNotice: null, toolsNotice: null, setupNotice: null, replacedManagerId: null });
    expect(await handleManagerEnsure({ workspaceId: REPO }, fake.paseo, deps)).toMatchObject({ agentId: "mgr-bound", created: false });
    expect(fake.creates).toEqual([]);
  });

  it("with no Manager, creates a one-repo mission and its Main in the Missions home, then opens that Main", async () => {
    const fake = daemon();
    const deps = { home, cli: fakeCli().cli, bindings: () => bindings, readInstructions, log: () => {} };
    const first = await handleManagerEnsure({ workspaceId: REPO }, fake.paseo, deps);
    expect(first).toMatchObject({ agentId: "created-1", created: true, otherManagerIds: [] });
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]!.workspaceId).toBe("wks-own");
    const [entry] = createMissionStore(home).list();
    expect(entry).toMatchObject({ code: "API", name: "api", repos: [REPO], mainId: "created-1" });
    expect(createMissionStore(home).get(entry!.missionId)).toMatchObject({ createdBy: "legacy", legacyWorkspaceId: REPO });
    expect(fake.creates[0]!.options.labels).toMatchObject({ "bm.missionId": entry!.missionId, "bm.missionCode": "API" });
    expect(await handleManagerEnsure({ workspaceId: REPO }, fake.paseo, deps)).toMatchObject({ agentId: "created-1", created: false });
    expect(createMissionStore(home).list()).toHaveLength(1);
  });

  it("opens the Main of the newest open mission whose scope holds the workspace", async () => {
    const fake = daemon([manager("main-web", "2026-10-02T00:00:00.000Z", { "bm.missionId": "mis-0000000002" }, { workspaceId: "wks-own" })]);
    let id = 1;
    const store = createMissionStore(home, { newId: () => `mis-000000000${id++}` });
    store.create({ code: "OLD", name: "Older", goal: "", repos: [REPO], createdBy: "owner", mainId: "main-old" });
    store.create({ code: "WEB", name: "Website", goal: "", repos: [REPO, "wks-b"], createdBy: "owner", mainId: "main-web" });
    store.update("mis-0000000001", (mission) => ({ ...mission, createdAt: "2026-10-01T00:00:00.000Z" }));
    store.update("mis-0000000002", (mission) => ({ ...mission, createdAt: "2026-10-02T00:00:00.000Z" }));
    const result = await handleManagerEnsure({ workspaceId: REPO }, fake.paseo, { home, cli: fakeCli().cli, bindings: () => bindings, readInstructions, log: () => {} });
    expect(result).toMatchObject({ agentId: "main-web", created: false });
    expect(fake.creates).toEqual([]);
  });

  it("replaceOutdated replaces an outdated Main through mission.ensure", async () => {
    const fake = daemon([manager("mgr-bound", "2026-10-02T00:00:00.000Z", { "bm.instructions": "old" })]);
    bind("mgr-bound");
    const { cli, calls } = fakeCli();
    const result = await handleManagerEnsure({ workspaceId: REPO, replaceOutdated: true }, fake.paseo, { home, cli, bindings: () => bindings, readInstructions, log: () => {} });
    expect(result).toMatchObject({ agentId: "created-1", created: true, replacedManagerId: "mgr-bound" });
    expect(fake.creates[0]!.workspaceId).toBe("wks-own");
    expect(calls).toContainEqual(["agent", "update", "mgr-bound", "--label", "bm.replacedBy=created-1", "--json"]);
    expect(createMissionStore(home).list()[0]).toMatchObject({ mainId: "created-1" });
  });
});

describe("a bm-manager the owner opens from the composer in a repo workspace (§3.6)", () => {
  const MISSION = "mis-0123456789";
  const paseoOf = (agents: FakeAgent[]) => daemon(agents).paseo;
  const created = (id: string) => ({ id, provider: "bm-manager", workspaceId: REPO });

  it("is an extra agent when the workspace's mission has a live Main", async () => {
    createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [REPO], createdBy: "owner", mainId: "main-1" });
    const paseo = paseoOf([manager("main-1", "2026-10-01T00:00:00.000Z", { "bm.missionId": MISSION }, { workspaceId: "wks-own" }), manager("mgr-new", "2026-10-09T00:00:00.000Z")]);
    const { cli, calls } = fakeCli();
    expect(await adoptComposerManager(created("mgr-new"), paseo, { home, cli, bindings: () => bindings, log: () => {} })).toBe("extra");
    expect(calls).toEqual([]);
    expect(createMissionStore(home).get(MISSION)!.mainId).toBe("main-1");
  });

  it("becomes the mission's Main when it has none", async () => {
    createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [REPO], createdBy: "owner", mainId: "main-gone" });
    bind("mgr-new");
    const paseo = paseoOf([manager("mgr-new", "2026-10-09T00:00:00.000Z")]);
    const { cli, calls } = fakeCli();
    expect(await adoptComposerManager(created("mgr-new"), paseo, { home, cli, bindings: () => bindings, log: () => {} })).toBe("main");
    const mission = createMissionStore(home).get(MISSION)!;
    expect(mission.mainId).toBe("mgr-new");
    expect(mission.mainHistory.at(-1)).toMatchObject({ agentId: "mgr-new", reason: "replaced" });
    expect(bindings.bindingOfAgent("mgr-new")?.missionId).toBe(MISSION);
    expect(calls[0]).toEqual(["agent", "update", "mgr-new", "--label", `bm.missionId=${MISSION}`, "--label", "bm.missionCode=WEB", "--json"]);
  });

  it("becomes a one-repo mission's Main when there is no mission, bound or not; the plugin's own and a Main are left alone", async () => {
    const paseo = paseoOf([manager("mgr-new", "2026-10-09T00:00:00.000Z"), manager("mgr-own", "2026-10-09T00:00:00.000Z", { "bm.version": "0.6.0" })]);
    const deps = { home, cli: fakeCli().cli, bindings: () => bindings, log: () => {} };
    expect(await adoptComposerManager(created("mgr-own"), paseo, deps)).toBeNull();
    expect(await adoptComposerManager({ id: "wrk-1", provider: "bm-worker", workspaceId: REPO }, paseo, deps)).toBeNull();
    expect(await adoptComposerManager(created("mgr-new"), paseo, deps)).toBe("mission");
    expect(createMissionStore(home).list()).toEqual([expect.objectContaining({ code: "API", repos: [REPO], mainId: "mgr-new" })]);
  });
});
