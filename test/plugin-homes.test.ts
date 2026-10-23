import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { handleTracesWorkspaces, handleWorkspacesOverview } from "../plugin/server/dashboard-rpc";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { eventScopeOf } from "../plugin/server/event-bus";
import { handleInsightsSummary } from "../plugin/server/insights-rpc";
import { ensureMissionsHome, missionsHomeDirOf, type MissionsPaseo } from "../plugin/server/missions-home";
import { createMissionStore } from "../plugin/server/mission-store";
import { orchestratorHomeOf } from "../plugin/server/orchestrator-agent";
import { createOrchestratorTools } from "../plugin/server/orchestrator-tools";
import { listedWorkspaces, type DashboardPaseo } from "../plugin/server/paseo-directory";
import { resolveProjectIn } from "../plugin/server/peer-links";
import { isPluginHome, isPluginHomeIn } from "../plugin/server/plugin-homes";
import { workspaceOfFolder } from "../plugin/server/role-hook";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import { projectWorkspacesOf } from "../plugin/client/work-model";
import { LEVELS } from "../plugin/shared/autonomy";
import { DECISION_CLASSES } from "../plugin/shared/decisions";
import { msg, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * WP-104 (missions design §3.1; REQ-185 b): the Missions home and the
 * Orchestrator home are not projects. Every project view leaves them out;
 * `listedWorkspaces` and the creation hook's `workspaceOfFolder` still see
 * them. A temporary data folder named by `PASEO_BM_HOME`, a fake Paseo.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");
const PROJECT = "wks_project";
const ORCHESTRATOR_WS = "wks_orchestrator";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-plugin-homes-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  clearTraceStoreCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearJsonFileCache();
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const location = () => ({ tracesDir: join(home, "traces") });

/** Paseo lists a project, the Orchestrator home and (once opened) the Missions home `wks-own`. */
function daemon() {
  return fakePaseo<MissionsPaseo & DashboardPaseo>({
    workspaces: [
      { id: PROJECT, directory: "/repo/api" },
      { id: ORCHESTRATOR_WS, directory: orchestratorHomeOf(home) },
      { id: "wks-own", directory: missionsHomeDirOf(home) },
    ],
  });
}

/** Opens the Missions home, so its id `wks-own` is cached. */
async function withMissionsHome() {
  const fake = daemon();
  await ensureMissionsHome(fake.paseo, { home });
  return fake;
}

describe("isPluginHome", () => {
  it("knows both homes by id or folder, and the Orchestrator home's id by the folder the trace store saw it in", async () => {
    await withMissionsHome();
    expect(isPluginHome("wks-own", home)).toBe(true);
    expect(isPluginHome(missionsHomeDirOf(home), home)).toBe(true);
    expect(isPluginHome(`${orchestratorHomeOf(home)}/`, home)).toBe(true);
    expect(isPluginHome(ORCHESTRATOR_WS, home)).toBe(false);
    writeWorkspaceMeta(location(), ORCHESTRATOR_WS, { lastKnownName: "home", lastKnownDirectory: orchestratorHomeOf(home), lastSeenAt: NOW.toISOString() });
    expect(isPluginHome(ORCHESTRATOR_WS, home)).toBe(true);
    for (const other of [PROJECT, "/repo/api", "home", "../x", "", null, undefined]) expect(isPluginHome(other, home)).toBe(false);
    expect(isPluginHome("wks-own", null)).toBe(false);
  });

  it("isPluginHomeIn reads the directory a listing gives the workspace", async () => {
    const listed = await listedWorkspaces(daemon().paseo);
    expect(isPluginHomeIn(ORCHESTRATOR_WS, listed, home)).toBe(true);
    expect(isPluginHomeIn("wks-own", listed, home)).toBe(true);
    expect(isPluginHomeIn(PROJECT, listed, home)).toBe(false);
    expect(isPluginHomeIn(ORCHESTRATOR_WS, null, home)).toBe(false);
  });

  it("leaves listedWorkspaces raw: the creation hook still resolves the Missions home's folder", async () => {
    const fake = await withMissionsHome();
    expect((await listedWorkspaces(fake.paseo))?.map((entry) => entry.id)).toEqual([PROJECT, ORCHESTRATOR_WS, "wks-own"]);
    expect(await workspaceOfFolder(fake.paseo, missionsHomeDirOf(home))).toBe("wks-own");
  });
});

describe("the project views leave the homes out", () => {
  it("project resolution of a link refuses a home, by id or by a folder inside it", async () => {
    const listed = await listedWorkspaces(daemon().paseo);
    expect(resolveProjectIn(listed, ORCHESTRATOR_WS, PROJECT, home)).toEqual({ ok: false, reasons: [`project "${ORCHESTRATOR_WS}" is a paseo-bm home, not a project; ask another project`] });
    expect(resolveProjectIn(listed, join(missionsHomeDirOf(home), "notes"), PROJECT, home)).toMatchObject({ ok: false });
    expect(resolveProjectIn(listed, "/repo/api", ORCHESTRATOR_WS, home)).toMatchObject({ ok: true, workspaceId: PROJECT });
  });

  it("bm_projects lists no home, and a tool naming one is refused", async () => {
    for (const workspaceId of [PROJECT, ORCHESTRATOR_WS]) {
      const at = "2026-09-26T10:00:00.000Z";
      await appendRecord(location(), turn({ workspaceId, agentId: `mgr-${workspaceId}`, requestId: "req-20260926T100000Z", at, endedAt: at, sent: [msg(`mgr-${workspaceId}`, at, "A request", "user")] }));
    }
    const fake = daemon();
    const tools = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {} });
    tools.usePaseo(fake.paseo);
    const answer = await tools.call("bm_projects", { sinceHours: 168, detail: "full" });
    const projects = (JSON.parse(answer.text.slice(answer.text.indexOf("{"))) as { projects: Array<{ workspaceId: string }> }).projects;
    expect(projects.map((project) => project.workspaceId)).toEqual([PROJECT]);
    // The collector keeps the folder each workspace's turns ran in.
    writeWorkspaceMeta(location(), ORCHESTRATOR_WS, { lastKnownName: "home", lastKnownDirectory: orchestratorHomeOf(home), lastSeenAt: NOW.toISOString() });
    const note = await tools.call("bm_note", { workspaceId: ORCHESTRATOR_WS, text: "x" });
    expect(note.ok).toBe(false);
    expect(note.text).toContain(`${ORCHESTRATOR_WS} is a paseo-bm home, not a project`);
  });

  it("bm_projects folds a mission placement into its repo, naming the placement of its requests (delivery line design §3.1)", async () => {
    const PLACE = "wks_place";
    const missions = createMissionStore(home);
    const made = missions.create({ code: "ABC", name: "Alpha", goal: "", repos: [PROJECT], createdBy: "owner", mainId: null });
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    const placement = { repo: PROJECT, workspaceId: PLACE, directory: "/wt/m-abc-api", branch: "m/ABC/api", target: "develop", base: "origin/develop", worktreeSlug: "m-abc-api", state: "ready" as const, requestKey: "bm-place", createdAt: NOW.toISOString(), deps: { cloned: [], at: null, note: null }, integration: null };
    missions.update(made.mission.missionId, (mission) => ({ ...mission, placements: [placement] }));
    const requests = { [PROJECT]: "req-20260926T100000Z", [PLACE]: "req-20260926T100100Z" };
    for (const [workspaceId, requestId] of Object.entries(requests)) {
      const at = "2026-09-26T10:00:00.000Z";
      await appendRecord(location(), turn({ workspaceId, agentId: `mgr-${workspaceId}`, requestId, at, endedAt: at, sent: [msg(`mgr-${workspaceId}`, at, "A request", "user")] }));
    }
    const fake = fakePaseo<MissionsPaseo & DashboardPaseo>({ workspaces: [{ id: PROJECT, directory: "/repo/api" }, { id: PLACE, directory: "/wt/m-abc-api" }] });
    const tools = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {} });
    tools.usePaseo(fake.paseo);
    const answer = await tools.call("bm_projects", { sinceHours: 168, detail: "full" });
    const projects = (JSON.parse(answer.text.slice(answer.text.indexOf("{"))) as { projects: Array<{ workspaceId: string; requests: Array<{ requestId: string; workspaceId?: string }> }> }).projects;
    expect(projects.map((project) => project.workspaceId)).toEqual([PROJECT]);
    expect(projects[0]!.requests.map((request) => [request.requestId, request.workspaceId ?? null]).sort()).toEqual([
      [requests[PROJECT], null],
      [requests[PLACE], PLACE],
    ]);
  });

  it("the overview counts and the stored workspaces leave them out, and traces.workspaces names the listed homes", async () => {
    const fake = await withMissionsHome();
    await appendRecord(location(), turn({ workspaceId: "wks-own", agentId: "main-1" }));
    await appendRecord(location(), turn({ workspaceId: PROJECT, agentId: "mgr-1" }));
    const overview = await handleWorkspacesOverview(fake.paseo, { home });
    expect(overview.workspaces.map((entry) => entry.workspaceId)).toEqual([PROJECT]);
    const stored = await handleTracesWorkspaces(fake.paseo, { homedir: () => root });
    expect(stored.workspaces.map((entry) => entry.workspaceId)).toEqual([PROJECT]);
    expect(stored.homes).toEqual([ORCHESTRATOR_WS, "wks-own"]);
  });

  it("Insights leaves a home's turns out", async () => {
    const summaryWith = async (folder: string, withHome: boolean) => {
      mkdirSync(folder, { recursive: true });
      const at = { tracesDir: join(folder, "traces") };
      await appendRecord(at, turn({ workspaceId: PROJECT, agentId: "mgr-1" }));
      writeWorkspaceMeta(at, PROJECT, { lastKnownName: "api", lastKnownDirectory: "/repo/api", lastSeenAt: NOW.toISOString() });
      if (withHome) {
        await appendRecord(at, turn({ workspaceId: ORCHESTRATOR_WS, agentId: "main-1", turnId: "turn-2", usage: null }));
        writeWorkspaceMeta(at, ORCHESTRATOR_WS, { lastKnownName: "home", lastKnownDirectory: orchestratorHomeOf(folder), lastSeenAt: NOW.toISOString() });
      }
      return handleInsightsSummary({ window: "all" }, { home: folder, now: () => NOW });
    };
    const other = join(root, "other");
    expect(await summaryWith(home, true)).toEqual(await summaryWith(other, false));
  });

  it("the event scope leaves out a home the policy names", async () => {
    await withMissionsHome();
    const delegated = DECISION_CLASSES.find((decisionClass) => LEVELS[2]!.delegated.includes(decisionClass))!;
    const autonomy = createAutonomyStore(home);
    for (const workspaceId of [PROJECT, "wks-own"]) autonomy.set({ workspaceId, class: delegated, mode: "delegate", confirmed: true }, NOW.toISOString());
    expect([...eventScopeOf(home, () => {})]).toEqual([PROJECT]);
  });

  it("the client's project lists leave out the homes traces.workspaces names, and wait for it", () => {
    const listed = [{ id: PROJECT }, { id: "wks-own" }];
    expect(projectWorkspacesOf(listed, undefined, false)).toBeUndefined();
    expect(projectWorkspacesOf(listed, { homes: ["wks-own"] }, false)).toEqual([{ id: PROJECT }]);
    expect(projectWorkspacesOf(listed, {}, false)).toEqual(listed);
    expect(projectWorkspacesOf(listed, undefined, true)).toEqual(listed);
    expect(projectWorkspacesOf(undefined, { homes: [] }, false)).toBeUndefined();
  });
});
