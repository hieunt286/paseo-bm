import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearBindingCache, createBindingStore, type AgentBinder, type BindingRequest } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { findMain } from "../plugin/server/manager";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { createMissionStore } from "../plugin/server/mission-store";
import {
  MISSIONS_HOME_README,
  SUCCESSOR_WINDOW_MS,
  UNASSIGNED_MAIN_BRIEF,
  createMainSuccession,
  ensureMissionsHome,
  handleMissionEnsure,
  handleMissionsCreate,
  isMissionsHome,
  mainBriefOf,
  mainFactsOf,
  missionsHomeDirOf,
  missionsHomeIdOf,
  syncMainTitle,
  type MissionsPaseo,
} from "../plugin/server/missions-home";
import { registerRoleHook, type AgentCreateRequest } from "../plugin/server/role-hook";
import { currentInstructions, runtimeFactsText } from "../plugin/server/role-instructions";
import { createTitleMarker, mainTitleOf, replacedMainTitleOf } from "../plugin/server/role-title";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { fakeCli } from "./helpers/fake-cli";
import { roleAliases, roleProfiles } from "./helpers/roles";

/**
 * WP-103 (missions design §3.1–§3.3, §3.5): the Missions home, its Mains,
 * their names and the successor of a cleared conversation, against a fake
 * Paseo and a fake `paseo` CLI. No daemon is contacted.
 */

const managerMd = readFileSync(fileURLToPath(new URL("../plugin/roles/manager.md", import.meta.url)), "utf8");

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-missions-home-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearJsonFileCache();
  clearBindingCache();
  rmSync(root, { recursive: true, force: true });
});

function daemon(agents: FakeAgent[] = []) {
  return fakePaseo<MissionsPaseo>({
    agents,
    workspaces: [
      { id: "wks-a", directory: "/repo/api" },
      { id: "wks-b", directory: "/repo/web" },
      { id: "wks-gone", directory: "/repo/gone", archivedAt: "2026-10-01T00:00:00.000Z" },
    ],
    config: { providers: roleAliases(), agentProfiles: roleProfiles() },
    omit: ["providers"],
  });
}

/** A binder that records what it was asked to bind and binds nothing. */
function recordingBinder() {
  const requests: BindingRequest[] = [];
  const binder: AgentBinder = { issue: (request) => (requests.push(request), null), settle: () => "unbound", discard: () => "none" };
  return { binder, requests };
}

const readInstructions = async (_paseo: unknown, workspaceId: string, missionId: string | null) => `instructions ${workspaceId} ${missionId ?? "none"}`;

describe("the Missions home (§3.1)", () => {
  it("creates <data>/missions/home with its README (0700), opens it as a workspace and caches its id", async () => {
    const fake = daemon();
    expect(missionsHomeIdOf(home)).toBeNull();
    const opened = await ensureMissionsHome(fake.paseo, { home });
    const directory = missionsHomeDirOf(home);
    expect(opened).toEqual({ workspaceId: "wks-own", directory });
    expect(fake.api.workspaces.open).toHaveBeenCalledWith({ cwd: directory });
    expect(readFileSync(join(directory, "README.md"), "utf8")).toBe(MISSIONS_HOME_README);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(missionsHomeIdOf(home)).toBe("wks-own");
    expect(isMissionsHome("wks-own", home)).toBe(true);
    expect(isMissionsHome(directory, home)).toBe(true);
    expect(isMissionsHome("wks-a", home)).toBe(false);
    expect(isMissionsHome(null, home)).toBe(false);
  });
});

describe("a Main's title (§3.2)", () => {
  it("is '🟣 M · <code> <name>', at most 200 characters, the name on one line and cut at a word end", () => {
    expect(mainTitleOf("WEB", "Website  relaunch\n")).toBe("🟣 M · WEB Website relaunch");
    expect(mainTitleOf("WEB", "  ")).toBe("🟣 M · WEB");
    const long = mainTitleOf("WEB", `${"word ".repeat(60)}end`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith("🟣 M · WEB word word")).toBe(true);
    expect(long.endsWith("word")).toBe(true);
  });

  it("a rename sets the Main's title through the Paseo CLI; a mission without a Main needs none", async () => {
    const { cli, calls } = fakeCli();
    expect(await syncMainTitle({ mainId: "main-1", code: "WEB", name: "Website v2" }, cli)).toEqual({ ok: true });
    expect(calls).toEqual([["agent", "update", "main-1", "--name", "🟣 M · WEB Website v2", "--json"]]);
    expect(await syncMainTitle({ mainId: null, code: "WEB", name: "x" }, cli)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("createTitleMarker rebuilds a Main's whole title from bm.missionId, titled or not", async () => {
    const { cli, calls } = fakeCli();
    const marker = createTitleMarker({ cli, log: () => {}, missionOf: (id) => (id === "mis-0123456789" ? { code: "WEB", name: "Website" } : null) });
    const paseoWith = (title: string | null) => ({ agents: { ref: () => ({ refresh: async () => ({ agent: { title, labels: { "bm.missionId": "mis-0123456789" } } }) }) } });
    expect(await marker.remark({ id: "main-1", provider: "bm-manager", title: null }, paseoWith("Fix the login"))).toBe("marked");
    expect(await marker.remark({ id: "main-2", provider: "bm-manager", title: null }, paseoWith(null))).toBe("marked");
    expect(await marker.remark({ id: "main-3", provider: "bm-manager", title: null }, paseoWith("🟣 M · WEB Website"))).toBe("already-marked");
    expect(calls.map((args) => args[4])).toEqual(["🟣 M · WEB Website", "🟣 M · WEB Website"]);
  });

  it("a replaced Main's title is the mission title + ' · replaced', within 200 characters", () => {
    expect(replacedMainTitleOf("WEB", "Website")).toBe("🟣 M · WEB Website · replaced");
    const long = replacedMainTitleOf("WEB", `${"word ".repeat(60)}end`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.startsWith("🟣 M · WEB word word")).toBe(true);
    expect(long.endsWith("word · replaced")).toBe(true);
  });

  it("createTitleMarker never retitles a Main labelled bm.replacedBy back to the mission title", async () => {
    const { cli, calls } = fakeCli();
    const marker = createTitleMarker({ cli, log: () => {}, missionOf: (id) => (id === "mis-0123456789" ? { code: "WEB", name: "Website" } : null) });
    const paseoWith = (title: string | null) => ({
      agents: { ref: () => ({ refresh: async () => ({ agent: { title, labels: { "bm.missionId": "mis-0123456789", "bm.replacedBy": "main-new" } } }) }) },
    });
    expect(await marker.remark({ id: "main-1", provider: "bm-manager", title: null }, paseoWith("🟣 M · WEB Website · replaced"))).toBe("already-marked");
    expect(await marker.remark({ id: "main-2", provider: "bm-manager", title: null }, paseoWith("Fix the login"))).toBe("marked");
    expect(calls.map((args) => args[4])).toEqual(["🟣 M · WEB Website · replaced"]);
  });
});

describe("missions.create (§3.3)", () => {
  it("with a name and a code writes the mission and creates its Main in the home, titled, labelled, bound to the mission and briefed", async () => {
    const fake = daemon();
    const { binder, requests } = recordingBinder();
    const result = await handleMissionsCreate(
      { name: "Website relaunch", code: "WEB", repos: ["wks-a", "wks-b"], goal: "Ship the new site." },
      fake.paseo,
      { home, binder: () => binder, readInstructions },
    );
    expect(result).toMatchObject({ agentId: "created-1", created: true, toolsNotice: null, setupNotice: null });
    const mission = createMissionStore(home).get(result.missionId!)!;
    expect(mission).toMatchObject({ code: "WEB", name: "Website relaunch", state: "open", createdBy: "owner", mainId: "created-1" });
    expect(mission.charter).toMatchObject({ goal: "Ship the new site.", repos: ["wks-a", "wks-b"] });
    expect(mission.mainHistory).toEqual([{ agentId: "created-1", from: expect.any(String), to: null, reason: "created" }]);
    expect(createMissionStore(home).journal(mission.missionId).map((line) => line.kind)).toEqual(["main"]);

    const [created] = fake.creates;
    expect(created!.workspaceId).toBe("wks-own");
    expect(created!.options.title).toBe("🟣 M · WEB Website relaunch");
    expect(created!.options.labels).toMatchObject({ "bm.role": "manager", "bm.missionId": mission.missionId, "bm.missionCode": "WEB" });
    expect(created!.options.config.systemPrompt).toBe(`instructions wks-own ${mission.missionId}`);
    const prompt = created!.options.prompt!;
    expect(prompt.split("\n")[0]).toBe("BM-BRIEF manager requestId: none mission: WEB");
    expect(prompt).toContain("Goal: Ship the new site.");
    expect(prompt).toContain("- api (wks-a): /repo/api");
    expect(prompt).toContain("- web (wks-b): /repo/web");
    expect(prompt.trimEnd().endsWith("Read the whole mission with bm_mission.")).toBe(true);
    // The binding is asked for the Main's mission (§3.3).
    expect(requests).toEqual([{ role: "manager", base: "codex", workspaceId: "wks-own", missionId: mission.missionId }]);
  });

  it("without a name and a code creates an unassigned Main in the home, which asks the owner its mission", async () => {
    const fake = daemon();
    const { binder, requests } = recordingBinder();
    const result = await handleMissionsCreate({}, fake.paseo, { home, binder: () => binder, readInstructions });
    expect(result).toMatchObject({ missionId: null, agentId: "created-1", created: true });
    expect(createMissionStore(home).list()).toEqual([]);
    const [created] = fake.creates;
    expect(created!.workspaceId).toBe("wks-own");
    expect(created!.options.title).toBe("🟣 M · New mission");
    expect(created!.options.labels?.["bm.missionId"]).toBeUndefined();
    expect(created!.options.prompt).toBe(UNASSIGNED_MAIN_BRIEF);
    expect(UNASSIGNED_MAIN_BRIEF.split("\n")[0]).toBe("BM-BRIEF manager requestId: none mission: none");
    expect(UNASSIGNED_MAIN_BRIEF).toContain("bm_mission_start");
    expect(requests).toEqual([{ role: "manager", base: "codex", workspaceId: "wks-own" }]);
  });

  it("refuses half a name, a taken or malformed code and a repo that is not a listed project, creating nothing", async () => {
    const fake = daemon();
    const deps = { home, readInstructions };
    await expect(handleMissionsCreate({ name: "Website" }, fake.paseo, deps)).rejects.toThrow(/^E_MISSION_INVALID: give the mission both a name and a code/);
    await expect(handleMissionsCreate({ goal: "x" }, fake.paseo, deps)).rejects.toThrow(/^E_MISSION_INVALID/);
    await expect(handleMissionsCreate({ name: "Website", code: "web" }, fake.paseo, deps)).rejects.toThrow(/^E_MISSION_INVALID: code "web"/);
    await expect(handleMissionsCreate({ name: "Website", code: "WEB", repos: ["wks-x", "wks-gone"] }, fake.paseo, deps)).rejects.toThrow(
      "E_MISSION_INVALID: wks-x is not a listed, unarchived workspace; wks-gone is not a listed, unarchived workspace",
    );
    await ensureMissionsHome(fake.paseo, { home });
    await expect(handleMissionsCreate({ name: "Website", code: "WEB", repos: ["wks-own"] }, fake.paseo, deps)).rejects.toThrow(/^E_MISSION_INVALID/);
    expect(fake.creates).toEqual([]);
    await handleMissionsCreate({ name: "Website", code: "WEB" }, fake.paseo, deps);
    await expect(handleMissionsCreate({ name: "Other", code: "WEB" }, fake.paseo, deps)).rejects.toThrow(/^E_MISSION_INVALID: code WEB is taken/);
    expect(fake.creates).toHaveLength(1);
  });

  it("refuses a taken code before any write: no role set up, no home opened", async () => {
    createMissionStore(home).create({ code: "WEB", name: "Website", goal: "", repos: [], createdBy: "owner" });
    const fake = daemon();
    await expect(handleMissionsCreate({ name: "Other", code: "WEB" }, fake.paseo, { home, readInstructions })).rejects.toThrow(/^E_MISSION_INVALID: code WEB is taken/);
    expect(fake.api.workspaces.open).not.toHaveBeenCalled();
    expect(fake.api.config.patch).not.toHaveBeenCalled();
    expect(existsSync(missionsHomeDirOf(home))).toBe(false);
    expect(fake.creates).toEqual([]);
  });
});

describe("findMain and mission.ensure (§3.2, §3.4)", () => {
  const MISSION = "mis-0123456789";
  const main = (id: string, createdAt: string, labels: Record<string, string> = {}, extra: Partial<FakeAgent> = {}): FakeAgent => ({
    id,
    workspaceId: "wks-own",
    provider: "bm-manager",
    status: "idle",
    createdAt,
    labels: { "bm.role": "manager", "bm.missionId": MISSION, ...labels },
    archivedAt: null,
    ...extra,
  });

  it("findMain lists the live Mains of the mission, newest first, skipping replaced, archived, other missions and other roles", async () => {
    const fake = fakePaseo<MissionsPaseo>({
      ignoresListFilter: true,
      agents: [
        main("main-old", "2026-10-01T00:00:00.000Z"),
        main("main-new", "2026-10-02T00:00:00.000Z"),
        main("main-replaced", "2026-10-03T00:00:00.000Z", { "bm.replacedBy": "main-new" }),
        main("main-archived", "2026-10-04T00:00:00.000Z", {}, { archivedAt: "2026-10-05T00:00:00.000Z" }),
        main("main-other", "2026-10-04T00:00:00.000Z", { "bm.missionId": "mis-9999999999" }),
        main("worker", "2026-10-04T00:00:00.000Z", { "bm.role": "worker" }, { provider: "bm-worker" }),
      ],
    });
    expect((await findMain(fake.paseo, MISSION)).map((agent) => agent.id)).toEqual(["main-new", "main-old"]);
  });

  function seeded(agents: FakeAgent[]) {
    const fake = daemon(agents);
    const created = createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [], createdBy: "owner", mainId: "main-1" });
    expect(created.ok).toBe(true);
    return fake;
  }

  it("opens the live Main, creates one when there is none, and refuses an unknown or closed mission", async () => {
    const fake = seeded([main("main-1", "2026-10-01T00:00:00.000Z")]);
    const deps = { home, readInstructions };
    expect(await handleMissionEnsure({ missionId: MISSION }, fake.paseo, deps)).toEqual({ agentId: "main-1", created: false, replacedMainId: null });
    fake.byId("main-1")!.archivedAt = "2026-10-02T00:00:00.000Z";
    expect(await handleMissionEnsure({ missionId: MISSION }, fake.paseo, deps)).toMatchObject({ agentId: "created-1", created: true, replacedMainId: null });
    expect(createMissionStore(home).get(MISSION)).toMatchObject({ mainId: "created-1" });
    expect(createMissionStore(home).get(MISSION)!.mainHistory.at(-1)).toMatchObject({ agentId: "created-1", reason: "replaced" });
    await expect(handleMissionEnsure({ missionId: "mis-aaaaaaaaaa" }, fake.paseo, deps)).rejects.toThrow("E_MISSION_INVALID: unknown mission mis-aaaaaaaaaa");
    createMissionStore(home).update(MISSION, (mission) => ({ ...mission, state: "closed", closedAt: "2026-10-03T00:00:00.000Z" }));
    await expect(handleMissionEnsure({ missionId: MISSION }, fake.paseo, deps)).rejects.toThrow("E_MISSION_INVALID: mission WEB is closed");
  });

  it("replace: owner creates a successor labelled bm.replaces and marks the old Main bm.replacedBy, never archiving it", async () => {
    const fake = seeded([main("main-1", "2026-10-01T00:00:00.000Z")]);
    const { cli, calls } = fakeCli();
    const result = await handleMissionEnsure({ missionId: MISSION, replace: "owner" }, fake.paseo, { home, readInstructions, cli });
    expect(result).toMatchObject({ agentId: "created-1", created: true, replacedMainId: "main-1" });
    expect(fake.creates[0]!.options.labels).toMatchObject({ "bm.missionId": MISSION, "bm.replaces": "main-1" });
    expect(calls).toContainEqual(["agent", "update", "main-1", "--label", "bm.replacedBy=created-1", "--json"]);
    expect(fake.archives).toEqual([]);
    expect(createMissionStore(home).get(MISSION)!.mainHistory.map((entry) => [entry.agentId, entry.reason])).toEqual([
      ["main-1", "created"],
      ["created-1", "owner"],
    ]);
  });

  it("replace: outdated keeps a current Main", async () => {
    const { currentInstructionsHash } = await import("../plugin/server/instructions-label");
    const fake = seeded([main("main-1", "2026-10-01T00:00:00.000Z", { "bm.instructions": currentInstructionsHash("manager") })]);
    expect(await handleMissionEnsure({ missionId: MISSION, replace: "outdated" }, fake.paseo, { home, readInstructions })).toEqual({
      agentId: "main-1",
      created: false,
      replacedMainId: null,
    });
    expect(fake.creates).toEqual([]);
  });
});

describe("a cleared conversation's successor (§3.3)", () => {
  const MISSION = "mis-0123456789";
  let clock: number;
  const now = () => new Date(clock);

  async function setup() {
    clock = Date.parse("2026-10-09T10:00:00.000Z");
    await ensureMissionsHome(daemon().paseo, { home });
    createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [], createdBy: "owner", mainId: "main-old" });
    const bindings = createBindingStore(home);
    // The new Manager's binding, bound as the creation hook binds a composer Manager.
    const issued = bindings.issue({ role: "manager", workspaceId: "wks-own", origin: "hook" });
    bindings.attach(issued.token, "manager");
    bindings.settle(issued.tokenSha256, "new-1");
    const { cli, calls } = fakeCli();
    const succession = createMainSuccession({ home, now, cli, bindings: () => bindings, log: () => {} });
    const paseoWith = (labels: Record<string, string> = {}) => ({ agents: { ref: () => ({ refresh: async () => ({ agent: { labels } }) }) } });
    return { bindings, succession, calls, paseoWith };
  }
  const candidate = (id = "new-1", workspaceId = "wks-own") => ({ id, provider: "bm-manager", workspaceId });

  it("a bm-manager of the home within 60 s of the Main's archive becomes the Main: mission, binding, labels and title", async () => {
    const { bindings, succession, calls, paseoWith } = await setup();
    expect(await succession.mainArchived("main-old")).toBeNull();
    clock += 30_000;
    expect(await succession.agentCreated(candidate(), paseoWith())).toBe(MISSION);
    const mission = createMissionStore(home).get(MISSION)!;
    expect(mission.mainId).toBe("new-1");
    expect(mission.mainHistory.at(-1)).toMatchObject({ agentId: "new-1", reason: "replaced" });
    expect(bindings.bindingOfAgent("new-1")?.missionId).toBe(MISSION);
    expect(calls).toEqual([
      ["agent", "update", "new-1", "--label", `bm.missionId=${MISSION}`, "--label", "bm.missionCode=WEB", "--label", "bm.replaces=main-old", "--json"],
      ["agent", "update", "new-1", "--name", "🟣 M · WEB Website", "--json"],
      // §3.4 step 5, through replaceMain: marked, then retitled.
      ["agent", "update", "main-old", "--label", "bm.replacedBy=new-1", "--json"],
      ["agent", "update", "main-old", "--name", "🟣 M · WEB Website · replaced", "--json"],
    ]);
    // Claimed once.
    expect(await succession.agentCreated(candidate("new-2"), paseoWith())).toBeNull();
  });

  it("works when Paseo reports the new agent before the archive", async () => {
    const { succession, paseoWith } = await setup();
    expect(await succession.agentCreated(candidate(), paseoWith())).toBeNull();
    clock += 10_000;
    expect(await succession.mainArchived("main-old")).toBe(MISSION);
    expect(createMissionStore(home).get(MISSION)!.mainId).toBe("new-1");
  });

  it("claims nothing after 60 s, for the plugin's own creations, outside the home, or for a Main of no open mission", async () => {
    const { succession, calls, paseoWith } = await setup();
    await succession.mainArchived("main-old");
    expect(await succession.agentCreated(candidate("own"), paseoWith({ "bm.version": "0.5.5" }))).toBeNull();
    expect(await succession.agentCreated(candidate("elsewhere", "wks-a"), paseoWith())).toBeNull();
    clock += SUCCESSOR_WINDOW_MS + 1;
    expect(await succession.agentCreated(candidate(), paseoWith())).toBeNull();
    expect(await succession.mainArchived("not-a-main")).toBeNull();
    expect(createMissionStore(home).get(MISSION)!.mainId).toBe("main-old");
    expect(calls).toEqual([]);
  });

  it("a successor that already carries the mission's labels is claimed without labelling it again", async () => {
    const { succession, calls, paseoWith } = await setup();
    await succession.mainArchived("main-old");
    expect(await succession.agentCreated(candidate(), paseoWith({ "bm.missionId": MISSION, "bm.version": "0.5.5" }))).toBe(MISSION);
    expect(calls).toEqual([
      ["agent", "update", "new-1", "--name", "🟣 M · WEB Website", "--json"],
      ["agent", "update", "main-old", "--label", "bm.replacedBy=new-1", "--json"],
      ["agent", "update", "main-old", "--name", "🟣 M · WEB Website · replaced", "--json"],
    ]);
  });
});

describe("a cleared conversation's successor, both ways (§3.3)", () => {
  const MISSION = "mis-0123456789";
  let clock: number;
  const now = () => new Date(clock);

  async function setup() {
    clock = Date.parse("2026-10-09T10:00:00.000Z");
    await ensureMissionsHome(daemon().paseo, { home });
    createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [], createdBy: "owner", mainId: "main-old" });
    const { cli, calls } = fakeCli();
    const succession = createMainSuccession({ home, now, cli, bindings: () => createBindingStore(home), log: () => {} });
    const paseoWith = (labels: Record<string, string> = {}) => ({ agents: { ref: () => ({ refresh: async () => ({ agent: { labels } }) }) } });
    return { succession, calls, paseoWith };
  }
  const candidate = (id: string) => ({ id, provider: "bm-manager", workspaceId: "wks-own" });

  it("a successor carrying the mission's labels, reported before the archive, is claimed at the archive, before an unlabelled one", async () => {
    const { succession, calls, paseoWith } = await setup();
    expect(await succession.agentCreated(candidate("new-1"), paseoWith())).toBeNull();
    expect(await succession.agentCreated(candidate("new-2"), paseoWith({ "bm.missionId": MISSION, "bm.version": "0.5.5" }))).toBeNull();
    clock += 10_000;
    expect(await succession.mainArchived("main-old")).toBe(MISSION);
    expect(createMissionStore(home).get(MISSION)!.mainId).toBe("new-2");
    // Labelled already: only titled, then the old Main marked and retitled.
    expect(calls[0]).toEqual(["agent", "update", "new-2", "--name", "🟣 M · WEB Website", "--json"]);
    expect(calls.some((args) => args.includes("new-1"))).toBe(false);
  });

  it("never claims an agent that is the Main of another open mission, whichever event comes first", async () => {
    const { succession, calls, paseoWith } = await setup();
    createMissionStore(home).create({ code: "OPS", name: "Ops", goal: "", repos: [], createdBy: "owner", mainId: "main-ops" });
    expect(await succession.agentCreated(candidate("main-ops"), paseoWith())).toBeNull();
    expect(await succession.mainArchived("main-old")).toBeNull();
    expect(await succession.agentCreated(candidate("main-ops"), paseoWith())).toBeNull();
    expect(createMissionStore(home).get(MISSION)!.mainId).toBe("main-old");
    expect(createMissionStore(home).byCode("OPS")!.mainId).toBe("main-ops");
    expect(calls).toEqual([]);
    // The mission still awaits a successor: a fresh agent within the window is claimed.
    clock += 10_000;
    expect(await succession.agentCreated(candidate("new-1"), paseoWith())).toBe(MISSION);
  });
});

describe("a Main's brief and Runtime facts (§3.5)", () => {
  const MISSION = "mis-0123456789";

  it("mainFactsOf names the mission, its level's cells and its repos' levels; runtimeFactsText writes them first", () => {
    createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: ["wks-a"], createdBy: "owner" });
    createMissionAutonomyStore(home).setLevel(MISSION, 1);
    const facts = mainFactsOf(home, MISSION);
    expect(facts).toEqual({
      mission: { missionId: MISSION, code: "WEB", name: "Website" },
      level: { level: 1, delegated: ["proceed"], owner: ["staffing", "scope-repo", "answer-technical", "answer-effects", "split"] },
      repoLevels: [{ workspaceId: "wks-a", level: 0 }],
    });
    const text = runtimeFactsText("manager", { main: facts, bound: true });
    expect(text.split("\n").slice(0, 5)).toEqual([
      "## Runtime facts",
      "",
      `Mission: \`WEB\` Website (${MISSION}). Read it whole with \`bm_mission\`.`,
      "Mission level: 1 — delegated: proceed; the owner's: staffing, scope-repo, answer-technical, answer-effects, split.",
      "Repo levels: wks-a 0.",
    ]);
    expect(mainFactsOf(home, null)).toEqual({ mission: null });
    expect(runtimeFactsText("manager", { main: { mission: null }, bound: true })).toContain("Mission: none yet — you are an unassigned Main.");
  });

  it("currentInstructions carries a Main's facts after the Manager's role text", async () => {
    const text = await currentInstructions("manager", null, { workspaceId: "wks-own", bound: true, main: { mission: null } });
    expect(text.startsWith(managerMd.trimEnd())).toBe(true);
    expect(text).toContain("\n## Runtime facts\n\nMission: none yet");
  });

  it("the brief lists the open requests, the open done criteria and the newest journal lines", async () => {
    const store = createMissionStore(home, { newId: () => MISSION });
    store.create({ code: "WEB", name: "Website", goal: "", repos: ["wks-a"], createdBy: "owner" });
    store.update(MISSION, (mission) => ({
      ...mission,
      charter: { ...mission.charter, doneCriteria: [{ id: "D1", text: "The site is live", status: "open", at: null, evidence: null }, { id: "D2", text: "Old", status: "met", at: null, evidence: null }] },
    }));
    store.appendJournal(MISSION, { kind: "note", by: "owner", text: "Started" });
    const { createMissionRoster } = await import("../plugin/server/mission-roster");
    createMissionRoster(home).add(MISSION, { requestId: "req-20261009T100000Z", workspaceId: "wks-a", topic: "Login page", workerId: "w-1" });
    const brief = await mainBriefOf(daemon().paseo, home, store.get(MISSION));
    expect(brief).toContain("Goal: not set yet — ask the owner when you need it");
    expect(brief).toContain("- req-20261009T100000Z in api: Login page; Worker w-1; newest report: none");
    expect(brief).toContain("- D1: The site is live");
    expect(brief).not.toContain("D2");
    expect(brief).toMatch(/Journal \(newest last\):\n- \S+ note owner: Started/);
  });

  it("the brief's newest report: two in one second read as the further phase, whatever the outbox file's order (acceptance 2026-10-09)", async () => {
    const store = createMissionStore(home, { newId: () => MISSION });
    store.create({ code: "WEB", name: "Website", goal: "", repos: ["wks-a"], createdBy: "owner" });
    const { createMissionRoster } = await import("../plugin/server/mission-roster");
    const { createOutbox } = await import("../plugin/server/outbox");
    createMissionRoster(home).add(MISSION, { requestId: "req-20261009T100000Z", workspaceId: "wks-a", topic: "Login page", workerId: "w-1" });
    const outbox = createOutbox(home, { now: () => new Date("2026-10-09T11:57:36.000Z") });
    for (const phase of ["blocked", "received"]) {
      outbox.add("wks-a", { kind: "report", requestId: "req-20261009T100000Z", from: "w-1", to: "main-1", text: ["BM-REPORT", "requestId: req-20261009T100000Z", `phase: ${phase}`].join("\n") });
    }
    const brief = await mainBriefOf(daemon().paseo, home, store.get(MISSION));
    expect(brief).toContain("- req-20261009T100000Z in api: Login page; Worker w-1; newest report: blocked");
  });
});

describe("the creation hook in the Missions home (§3.3, §3.5)", () => {
  const roleUrl = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
  const MISSION = "mis-0123456789";

  async function hookIn() {
    const directory = missionsHomeDirOf(home);
    const host = {
      config: { get: async () => ({ config: { providers: { "bm-manager": { extends: "claude" } } } }) },
      workspaces: { list: async () => ({ entries: [{ workspace: { id: "wks-own", directory } }] }) },
    };
    await ensureMissionsHome({ workspaces: { open: async () => ({ id: "wks-own" }) } } as never, { home });
    const bindings = createBindingStore(home);
    let hook: ((input: { request: unknown }, context: unknown) => unknown) | undefined;
    registerRoleHook({ before: ((name: string, handler: typeof hook) => (name === "agent.create" ? (hook = handler) : undefined, () => {})) as never }, { urlFor: roleUrl, bindings });
    const create = async (config: Record<string, unknown>) => (await hook!({ request: { config } }, { paseo: host })) as AgentCreateRequest | undefined;
    return { bindings, create, directory };
  }

  it("a bm-manager the owner opens in the home is bound by the hook and told it is an unassigned Main", async () => {
    const { bindings, create, directory } = await hookIn();
    const created = await create({ provider: "bm-manager", cwd: directory });
    expect(bindings.list()).toEqual([expect.objectContaining({ role: "manager", workspaceId: "wks-own", origin: "hook" })]);
    expect(bindings.list()[0]?.missionId).toBeUndefined();
    expect(String(created?.config.systemPrompt)).toContain("\n## Runtime facts\n\nMission: none yet — you are an unassigned Main.");
  });

  it("a Main the plugin creates gets its mission's facts from its binding", async () => {
    const { bindings, create, directory } = await hookIn();
    createMissionStore(home, { newId: () => MISSION }).create({ code: "WEB", name: "Website", goal: "", repos: [], createdBy: "owner" });
    const issued = binderOf(roleUrl, bindings, () => {}).issue({ role: "manager", base: "claude", workspaceId: "wks-own", missionId: MISSION })!;
    expect(bindings.callerOf(issued.mcpServer.url.slice(-64), "manager")).toMatchObject({ agentId: null, missionId: MISSION });
    const created = await create({ provider: "bm-manager", cwd: directory, mcpServers: { "paseo-bm": issued.mcpServer } });
    expect(String(created?.config.systemPrompt)).toContain(`Mission: \`WEB\` Website (${MISSION}).`);
  });

  it("a Manager created in a repo is no Main", async () => {
    const { create } = await hookIn();
    const created = await create({ provider: "bm-manager", cwd: "/repo/api" });
    expect(String(created?.config.systemPrompt)).not.toContain("Mission:");
  });
});

describe("binding missionId (§3.3)", () => {
  it("assignMission writes the mission on the agent's bound binding, or the pending hook binding it claimed", () => {
    const bindings = createBindingStore(home);
    const plugin = bindings.issue({ role: "manager", workspaceId: "wks-own" });
    bindings.attach(plugin.token, "manager");
    bindings.settle(plugin.tokenSha256, "main-1");
    expect(bindings.assignMission("main-1", "mis-0123456789")).toBe(true);
    expect(bindings.callerOf(plugin.token, "manager")).toMatchObject({ agentId: "main-1", missionId: "mis-0123456789" });
    expect(bindings.assignMission("nobody", "mis-0123456789")).toBe(false);
    const hook = bindings.issue({ role: "manager", workspaceId: "wks-own", origin: "hook" });
    bindings.attach(hook.token, "manager");
    expect(bindings.claimHook(hook.tokenSha256.slice(0, 16), "main-2")).toBe(true);
    expect(bindings.assignMission("main-2", "mis-aaaaaaaaaa")).toBe(true);
    expect(bindings.list().find((binding) => binding.claimedBy === "main-2")?.missionId).toBe("mis-aaaaaaaaaa");
    // A Manager's binding without a mission says nothing of one.
    const other = bindings.issue({ role: "manager", workspaceId: "wks-a" });
    expect(bindings.callerOf(other.token, "manager")).not.toHaveProperty("missionId");
  });
});
