/**
 * The Missions home and its Mains (missions design §3.1–§3.3, §3.5; ADR-029).
 *
 * - **The home** (`ensureMissionsHome`, §3.1, ADR-034): the Mission-List
 *   project, `<data folder>/missions/Mission-List` (`0700`, a `README.md`),
 *   opened as a workspace with `paseo.workspaces.open({ cwd })`; its id is
 *   cached in `ui/missions-home.json` (with the earlier shared home's as
 *   `legacyWorkspaceId`). Each mission has its own workspace there
 *   (`ensureMissionWorkspace`), where its Mains are created. The creation
 *   hook reads the places (`missionsPlaceOf`, `isMissionsHome`): a
 *   `bm-manager` the owner opens in the root is an unassigned Main; one in a
 *   mission's workspace is that mission's.
 * - **Creating** (§3.3): `missions.create { name?, code?, repos?, goal? }`
 *   writes the mission and creates its Main (`createMain`) — or, without a
 *   name and a code (the Command Center's "New mission"), an unassigned Main.
 *   `mission.ensure { missionId, replace? }` opens the mission's live Main
 *   (`findMain`), creating one when there is none, or a successor on
 *   `replace`; every change of the mission's Main then takes `replaceMain`
 *   (`mission-replace.ts`, §3.4).
 * - **The brief** (`mainBriefOf`, §3.5) and the **Runtime facts**
 *   (`mainFactsOf`): the mission, its level's cells and its repos' levels.
 * - **Keeping the title** (§3.2): `syncMainTitle` after a rename.
 * - **A cleared conversation** (§3.3, `createMainSuccession`): at
 *   `agent.archived` of the Main of an open mission, the mission awaits a
 *   successor for `SUCCESSOR_WINDOW_MS`; a `bm-manager` the owner's app
 *   creates in the home in that window, with no mission of its own, is
 *   claimed: its binding and labels get the mission, it is titled from it,
 *   and it becomes the Main through `replaceMain` (reason `replaced`). The window runs
 *   both ways, as Paseo's order of the two events is not known.
 *
 * Nothing here archives, stops or deletes an agent (ADR-005).
 */
import { join, resolve } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  missionEnsureRpc,
  missionsCreateRpc,
  type MissionEnsureInput,
  type MissionEnsureOutput,
  type MissionsCreateInput,
  type MissionsCreateOutput,
} from "../shared/contracts";
import { levelOf } from "../shared/autonomy";
import { roleOfProvider } from "./agent-role";
import { NO_BINDER, type AgentBinder, type BindingStore } from "./agent-bindings";
import { readAutonomyPolicy } from "./autonomy-rpc";
import { createJsonFileStore, ensureDataDir, writeFileAtomically } from "./data-files";
import { UI_DIR_NAME } from "./data-home";
import { hasOutdatedInstructions } from "./instructions-label";
import { REPLACES_LABEL, VERSION_LABEL, createMain, ensureRolesFor, findMain, setupNoticeFor, type ManagerPaseo } from "./manager";
import { MISSION_CLASSES, createMissionAutonomyStore } from "./mission-autonomy-store";
import { replaceMain, type ReplaceMainDeps } from "./mission-replace";
import { offerMerges } from "./mission-ownership";
import { MISSIONS_DIR_NAME, MISSION_ID_PATTERN, createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { missionStateOf } from "./mission-state";
import { renderMissionState } from "../shared/mission-state";
import { briefLineOf } from "./notices";
import { orchestratorHomeOf } from "./orchestrator-agent";
import { setAgentLabels, setAgentTitle, setWorkspaceTitle, type PaseoCliDeps } from "./paseo-cli";
import { directoryIn, listedWorkspaces, titleIn, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { asRecord, nonEmpty } from "./role-choices";
import { currentInstructions, type MainFacts } from "./role-instructions";
import { MISSION_CODE_LABEL, MISSION_ID_LABEL, mainTitleOf } from "./role-title";
import { coded, dataHome, errorText, requireDataHome, type RpcHomeDeps } from "./rpc-kit";

/** The home's folder, under `<data folder>/missions/`: Paseo names the project after it (ADR-034). */
export const MISSIONS_HOME_DIR_NAME = "Mission-List";
/** The home's folder before ADR-034: its workspace and Mains are still recognised as a Missions place. */
export const LEGACY_MISSIONS_HOME_DIR_NAME = "home";
/** Where the home's workspace id is cached, in the data folder's `ui/`. */
export const MISSIONS_HOME_FILE = "missions-home.json";
export const MISSIONS_HOME_VERSION = 1;
/** How long a mission whose Main was archived awaits a successor (§3.3). */
export const SUCCESSOR_WINDOW_MS = 60_000;
/** The journal lines a brief carries (§3.5). */
export const BRIEF_JOURNAL_LINES = 20;

/** What the home folder's `README.md` says, so a user who finds it knows what it is. */
export const MISSIONS_HOME_README = `# Mission-List

paseo-bm's missions: one folder, and one Paseo workspace, per mission, where
its Main (one Beads Manager per mission) works across the mission's
repositories. This root workspace holds a Main you open here by hand before
its mission has a name. No project lives here; the work happens in the
repositories.

paseo-bm created it; the missions themselves are kept beside it, in this
folder's parent.
`;

/** `<data folder>/missions/Mission-List` (ADR-034). */
export function missionsHomeDirOf(home: string): string {
  return join(home, MISSIONS_DIR_NAME, MISSIONS_HOME_DIR_NAME);
}

/** `<data folder>/missions/home`, the shared home before ADR-034. */
export function legacyMissionsHomeDirOf(home: string): string {
  return join(home, MISSIONS_DIR_NAME, LEGACY_MISSIONS_HOME_DIR_NAME);
}

/** A mission's own folder, `<Mission-List>/<missionId>` (ADR-034 decision 2). */
export function missionWorkspaceDirOf(home: string, missionId: string): string {
  return join(missionsHomeDirOf(home), missionId);
}

/** A mission's workspace title: `<CODE> · <name>`, at most 80 characters. Pure. */
export function missionWorkspaceTitleOf(code: string, name: string): string {
  const title = `${code} · ${name.replace(/\s+/g, " ").trim()}`.trim();
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}

interface HomeRecord {
  workspaceId: string | null;
  directory: string | null;
  /** The shared home's workspace before ADR-034, still recognised; null when there was none. */
  legacyWorkspaceId: string | null;
}

const homeFile = (home: string) =>
  createJsonFileStore<HomeRecord>({
    home,
    dir: UI_DIR_NAME,
    file: MISSIONS_HOME_FILE,
    version: MISSIONS_HOME_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ workspaceId: nonEmpty(body["workspaceId"]), directory: nonEmpty(body["directory"]), legacyWorkspaceId: nonEmpty(body["legacyWorkspaceId"]) }),
    empty: () => ({ workspaceId: null, directory: null, legacyWorkspaceId: null }),
    codes: { unwritable: "E_MISSION_WRITE_FAILED" },
    cached: true,
  });

/** The Missions home's workspace id, as last opened; null before the first open or with no data folder. Never throws. */
export function missionsHomeIdOf(home: string | null = dataHome()): string | null {
  if (home === null) return null;
  try {
    return homeFile(home).read().workspaceId;
  } catch {
    return null;
  }
}

/**
 * Which Missions place `workspaceIdOrDirectory` is (ADR-034): the root (the
 * lobby), the shared home of earlier builds (`legacy`), or a mission's own
 * workspace (its id or folder); null for anything else. Never throws.
 */
export function missionsPlaceOf(workspaceIdOrDirectory: string | null | undefined, home: string | null = dataHome()): { kind: "root" | "legacy" } | { kind: "mission"; missionId: string } | null {
  if (home === null || typeof workspaceIdOrDirectory !== "string" || workspaceIdOrDirectory === "") return null;
  try {
    const record = homeFile(home).read();
    if (workspaceIdOrDirectory === record.workspaceId) return { kind: "root" };
    if (workspaceIdOrDirectory === record.legacyWorkspaceId) return { kind: "legacy" };
    const byId = createMissionStore(home).list().find((entry) => entry.workspaceId === workspaceIdOrDirectory);
    if (byId !== undefined) return { kind: "mission", missionId: byId.missionId };
    if (!workspaceIdOrDirectory.startsWith("/")) return null;
    const directory = resolve(workspaceIdOrDirectory);
    const root = resolve(missionsHomeDirOf(home));
    if (directory === root) return { kind: "root" };
    if (directory === resolve(legacyMissionsHomeDirOf(home))) return { kind: "legacy" };
    const named = directory.startsWith(`${root}/`) ? directory.slice(root.length + 1) : null;
    return named !== null && MISSION_ID_PATTERN.test(named) ? { kind: "mission", missionId: named } : null;
  } catch {
    return null;
  }
}

/** True when `workspaceIdOrDirectory` is a Missions place (`missionsPlaceOf`): a paseo-bm home, never a repo. Never throws. */
export function isMissionsHome(workspaceIdOrDirectory: string | null | undefined, home: string | null = dataHome()): boolean {
  return missionsPlaceOf(workspaceIdOrDirectory, home) !== null;
}

/**
 * Where a mission's Mains have worked, so where their turns are traced
 * (ADR-034 decision 7): its own workspace, the root, the earlier shared home,
 * and a legacy mission's repo. Never throws.
 */
export function mainPlacesOf(home: string, mission: Pick<Mission, "legacyWorkspaceId"> & { workspaceId?: string | null }): string[] {
  let record: HomeRecord = { workspaceId: null, directory: null, legacyWorkspaceId: null };
  try {
    record = homeFile(home).read();
  } catch {
    // An unreadable home record leaves the mission's own places.
  }
  return [...new Set([mission.workspaceId ?? null, record.workspaceId, record.legacyWorkspaceId, mission.legacyWorkspaceId].filter((id): id is string => id !== null))];
}

/** Every Missions place's workspace id: the root, the earlier shared home, each mission's workspace (ADR-034 decision 7). Never throws. */
export function missionsWorkspaceIdsOf(home: string | null = dataHome()): string[] {
  if (home === null) return [];
  try {
    const record = homeFile(home).read();
    const missions = createMissionStore(home)
      .list()
      .flatMap((entry) => (entry.workspaceId == null ? [] : [entry.workspaceId]));
    return [...new Set([record.workspaceId, record.legacyWorkspaceId, ...missions].filter((id): id is string => id !== null))];
  } catch {
    return [];
  }
}

/** The SDK slice the home and its Mains use; `PaseoApi` is structurally assignable. */
export type MissionsPaseo = ManagerPaseo & {
  workspaces: ManagerPaseo["workspaces"] & {
    open(input: { cwd: string }): Promise<{ readonly id: string; readonly projectId?: string | null }>;
    list(options?: unknown): Promise<{ entries: Array<Record<string, unknown>> }>;
    /** A directory workspace in an existing project (ADR-034); absent from an older host. */
    create?(options: { source: { kind: "directory"; path: string; projectId?: string }; title?: string }): Promise<{ readonly id: string }>;
  };
};

export interface MissionsHomeDeps extends RpcHomeDeps {
  /** Binds a new Main to its own tool path (design §16.5); none when absent. */
  binder?: () => AgentBinder;
  /** The binding store, for a claimed successor's mission. */
  bindings?: () => BindingStore | null;
  cli?: PaseoCliDeps;
  now?: () => Date;
  log?: (message: string) => void;
  /** A Main's system prompt; `currentInstructions` with its `mainFactsOf` by default. */
  readInstructions?: (paseo: unknown, workspaceId: string, missionId: string | null) => Promise<string>;
}

const logOf = (deps: MissionsHomeDeps) => deps.log ?? ((message: string) => console.warn(message));

/**
 * Creates `<data folder>/missions/Mission-List` (`0700`, its `README.md`),
 * opens it as a workspace — the root of the Mission-List project — and caches
 * its id (§3.1, ADR-034). A cached home in another folder (the shared `home`
 * of earlier builds) is kept as `legacyWorkspaceId`. No data folder →
 * `E_DATA_HOME_UNAVAILABLE`; a failed write → `E_MISSION_WRITE_FAILED`.
 */
export async function ensureMissionsHome(paseo: Pick<MissionsPaseo, "workspaces">, deps: MissionsHomeDeps = {}): Promise<{ workspaceId: string; directory: string; projectId: string | null }> {
  const home = requireDataHome(deps, "open the Missions home");
  const directory = missionsHomeDirOf(home);
  coded("E_MISSION_WRITE_FAILED", `prepare the Missions home ${directory}`, () => {
    ensureDataDir(home, directory, "E_MISSION_WRITE_FAILED");
    writeFileAtomically(home, join(directory, "README.md"), MISSIONS_HOME_README, "E_MISSION_WRITE_FAILED");
  });
  const opened = await paseo.workspaces.open({ cwd: directory });
  const file = homeFile(home);
  const cached = file.read();
  const legacyWorkspaceId = cached.legacyWorkspaceId ?? (cached.workspaceId !== null && cached.workspaceId !== opened.id ? cached.workspaceId : null);
  if (cached.workspaceId !== opened.id || cached.directory !== directory || cached.legacyWorkspaceId !== legacyWorkspaceId) {
    coded("E_MISSION_WRITE_FAILED", "remember the Missions home", () => file.write({ workspaceId: opened.id, directory, legacyWorkspaceId }));
  }
  return { workspaceId: opened.id, directory, projectId: opened.projectId ?? null };
}

/**
 * A mission's own workspace (ADR-034 decision 2): its folder
 * `<Mission-List>/<missionId>` (with a `README.md`), the workspace Paseo
 * lists for that folder, else a new directory workspace in the root's
 * project titled `missionWorkspaceTitleOf`; its id cached on the mission.
 * A host without `workspaces.create`, or a creation Paseo refuses, gives the
 * root (one log line). Throws as `ensureMissionsHome` does.
 */
export async function ensureMissionWorkspace(paseo: Pick<MissionsPaseo, "workspaces">, mission: Pick<Mission, "missionId" | "code" | "name">, deps: MissionsHomeDeps = {}): Promise<string> {
  const home = requireDataHome(deps, "open a mission's workspace");
  const root = await ensureMissionsHome(paseo, deps);
  const directory = missionWorkspaceDirOf(home, mission.missionId);
  const title = missionWorkspaceTitleOf(mission.code, mission.name);
  const log = logOf(deps);
  try {
    coded("E_MISSION_WRITE_FAILED", `prepare the workspace of mission ${mission.code}`, () => {
      ensureDataDir(home, directory, "E_MISSION_WRITE_FAILED");
      writeFileAtomically(home, join(directory, "README.md"), `# ${title}\n\nThe workspace of mission ${mission.code}'s Main (paseo-bm). The work happens in the mission's repositories.\n`, "E_MISSION_WRITE_FAILED");
    });
    const listed = await listedWorkspaces(paseo as unknown as DashboardPaseo);
    let workspaceId = listed?.find((entry) => !entry.archived && entry.directory !== null && resolve(entry.directory) === resolve(directory))?.id ?? null;
    if (workspaceId === null) {
      if (typeof paseo.workspaces.create !== "function" || root.projectId === null) {
        log(`[paseo-bm] this Paseo cannot add a workspace to the Mission-List project; mission ${mission.code}'s Main works in the root.`);
        return root.workspaceId;
      }
      workspaceId = (await paseo.workspaces.create({ source: { kind: "directory", path: directory, projectId: root.projectId }, title })).id;
    }
    const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
    if (store.get(mission.missionId)?.workspaceId !== workspaceId) {
      const saved = store.update(mission.missionId, (current) => ({ ...current, workspaceId }));
      if (!saved.ok) log(`[paseo-bm] the workspace of mission ${mission.code} could not be recorded: ${saved.reasons.join("; ")}`);
    }
    return workspaceId;
  } catch (error) {
    log(`[paseo-bm] the workspace of mission ${mission.code} could not be opened (${errorText(error)}); its Main works in the root.`);
    return root.workspaceId;
  }
}

// ---------------------------------------------------------------------------
// The brief and the Runtime facts (§3.5).
// ---------------------------------------------------------------------------

/** A Main's Runtime facts: its mission, its level's cells, its repos' levels; `{ mission: null }` unassigned. Never throws. */
export function mainFactsOf(home: string | null, missionId: string | null): MainFacts {
  if (home === null || missionId === null) return { mission: null };
  try {
    const mission = createMissionStore(home).get(missionId);
    if (mission === null) return { mission: null };
    const autonomy = createMissionAutonomyStore(home).get(missionId);
    const delegated = MISSION_CLASSES.filter((name) => autonomy.cells[name].mode === "delegate");
    const policy = readAutonomyPolicy({ home, log: () => {} });
    return {
      mission: { missionId, code: mission.code, name: mission.name },
      level: { level: autonomy.level, delegated, owner: MISSION_CLASSES.filter((name) => !delegated.includes(name)) },
      repoLevels: mission.charter.repos.map((workspaceId) => ({ workspaceId, level: levelOf(policy, workspaceId) })),
    };
  } catch {
    return { mission: null };
  }
}

/** One line of text, at most `limit` characters. */
const oneLine = (text: string, limit = 300): string => text.replace(/\s+/g, " ").trim().slice(0, limit);

/** The brief an unassigned Main starts with (§3.3). Agent-facing, so English. */
export const UNASSIGNED_MAIN_BRIEF = [
  `${briefLineOf("manager", null)} mission: none`,
  "You are a Main with no mission yet. Ask the owner, in one short message, the mission's name, a short code (2 to 8 capital letters or digits, a letter first), its goal and the repositories it works in; then record them with bm_mission_start. Do nothing else until they answer.",
].join("\n");

/**
 * A Main's first prompt (§3.5; mission runtime design §2.2): the
 * `BM-BRIEF manager requestId: none mission: <code>` line, the mission's name,
 * goal and charter state, its repos with their folders, then the mission
 * state's rendering (`renderMissionState`): what is in flight, what waits on
 * whom, links, the owner's recent exchange, the governor, the journal. `UNASSIGNED_MAIN_BRIEF` for none. Never throws: a store that
 * cannot be read is left out.
 */
export async function mainBriefOf(paseo: unknown, home: string | null, mission: Mission | null): Promise<string> {
  if (mission === null || home === null) return UNASSIGNED_MAIN_BRIEF;
  const listed = await listedWorkspaces(paseo as DashboardPaseo).catch(() => null);
  const folderOf = (workspaceId: string) => directoryIn(listed, workspaceId);
  const repoName = (workspaceId: string) => titleIn(listed, workspaceId);
  const { charter } = mission;
  const lines = [
    `${briefLineOf("manager", null)} mission: ${mission.code}`,
    `Mission: ${mission.code} — ${oneLine(mission.name)} (${mission.missionId}). Charter: ${charter.confirmedAt === null ? "not confirmed by the owner yet" : `confirmed ${charter.confirmedAt.slice(0, 10)}`}.`,
    `Goal: ${charter.goal.trim() === "" ? "not set yet — ask the owner when you need it" : oneLine(charter.goal, 4_000)}`,
    "Repos:",
    ...(charter.repos.length === 0 ? ["- none yet"] : charter.repos.map((workspaceId) => `- ${repoName(workspaceId)} (${workspaceId}): ${folderOf(workspaceId) ?? "folder unknown"}`)),
  ];
  // Mission runtime design §2.2: what is in flight comes from the one mission state, never from the roster alone.
  const state = missionStateOf(home, mission.missionId, { repoName: (workspaceId) => (listed === null ? null : repoName(workspaceId)) });
  if (state === null) {
    lines.push("Read the whole mission with bm_mission.");
    return lines.join("\n");
  }
  lines.push(renderMissionState(state));
  return lines.join("\n");
}

/**
 * After a rename (§3.2): the mission's Main gets the title `mainTitleOf`
 * through the Paseo CLI. Ok when there is no Main to title. Never throws.
 */
export async function syncMainTitle(mission: Pick<Mission, "mainId" | "code" | "name"> & { workspaceId?: string | null }, cli?: PaseoCliDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    // ADR-034: the mission's own workspace carries its code and name too.
    if (mission.workspaceId != null) {
      const renamed = await setWorkspaceTitle(mission.workspaceId, missionWorkspaceTitleOf(mission.code, mission.name), cli);
      if (!renamed.ok) return renamed;
    }
    if (mission.mainId === null) return { ok: true };
    return await setAgentTitle(mission.mainId, mainTitleOf(mission.code, mission.name), cli);
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

/**
 * Marks `agentId` as the Main of `mission` (§3.2): its binding's mission, the
 * `bm.missionId` and `bm.missionCode` labels with `extra` (none at all for
 * null: Paseo carried them over) and the title, through the Paseo CLI. Each
 * refusal is one log line. Returns whether the binding recorded the mission.
 * Never throws.
 */
export async function markMain(
  agentId: string,
  mission: Pick<Mission, "missionId" | "code" | "name">,
  deps: { bindings: BindingStore | null | undefined; cli?: PaseoCliDeps | undefined; log: (message: string) => void },
  extra: Record<string, string> | null = {},
): Promise<boolean> {
  const bound = deps.bindings?.assignMission(agentId, mission.missionId) ?? false;
  if (extra !== null) {
    const labels = await setAgentLabels(agentId, { [MISSION_ID_LABEL]: mission.missionId, [MISSION_CODE_LABEL]: mission.code, ...extra }, deps.cli).catch((error: unknown) => ({
      ok: false as const,
      reason: errorText(error),
    }));
    if (!labels.ok) deps.log(`[paseo-bm] Main ${agentId} of mission ${mission.code} could not be labelled: ${labels.reason}`);
  }
  const titled = await syncMainTitle({ mainId: agentId, code: mission.code, name: mission.name }, deps.cli);
  if (!titled.ok) deps.log(`[paseo-bm] Main ${agentId} of mission ${mission.code} could not be titled: ${titled.reason}`);
  return bound;
}

// ---------------------------------------------------------------------------
// missions.create and mission.ensure (§3.3, §3.4).
// ---------------------------------------------------------------------------

/** A mission refusal: `E_MISSION_INVALID` with its reasons. */
export function missionInvalid(reasons: readonly string[]): DashboardError {
  return new DashboardError("E_MISSION_INVALID", reasons.join("; "));
}

/** Why each repo cannot be in a charter (§3.3): not a listed, unarchived repo workspace, or a plugin home. */
function repoRefusals(repos: readonly string[], listed: readonly ListedWorkspace[] | null, home: string): string[] {
  if (repos.length === 0) return [];
  if (listed === null) return ["Paseo's workspaces cannot be read right now; try again"];
  const orchestratorHome = resolve(orchestratorHomeOf(home));
  return repos.flatMap((workspaceId) => {
    const entry = listed.find((workspace) => workspace.id === workspaceId);
    if (entry === undefined || entry.archived) return [`${workspaceId} is not a listed, unarchived workspace`];
    const folder = entry.directory === null ? null : resolve(entry.directory);
    if (isMissionsHome(workspaceId, home) || (folder !== null && (folder === resolve(missionsHomeDirOf(home)) || folder === orchestratorHome))) {
      return [`${workspaceId} is a paseo-bm home, not a project`];
    }
    return [];
  });
}

/** The Manager deps of a Main of `missionId` in the home. */
function managerDeps(paseo: MissionsPaseo, home: string, missionId: string | null, deps: MissionsHomeDeps) {
  const read = deps.readInstructions ?? ((handle, workspaceId, id) => currentInstructions("manager", handle, { workspaceId, main: mainFactsOf(home, id) }));
  return {
    paseo,
    home,
    readInstructions: (workspaceId: string) => read(paseo, workspaceId, missionId),
    binder: deps.binder?.() ?? NO_BINDER,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
  };
}

/** `missions.create` (§3.3). See the contract. */
export async function handleMissionsCreate(input: MissionsCreateInput, paseo: MissionsPaseo, deps: MissionsHomeDeps = {}): Promise<MissionsCreateOutput> {
  const home = requireDataHome(deps, "create a mission");
  const name = (input.name ?? "").trim();
  const code = (input.code ?? "").trim();
  const named = name !== "" || code !== "";
  if (named && (name === "" || code === "")) throw missionInvalid(["give the mission both a name and a code, or neither"]);
  const repos = [...new Set(input.repos ?? [])];
  if (!named && (repos.length > 0 || (input.goal ?? "").trim() !== "")) throw missionInvalid(["a mission's repos and goal need its name and code"]);
  const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
  // Every refusal before any write: the roles and the home are set up only for a mission that can be created.
  if (named) {
    const refused = repoRefusals(repos, await listedWorkspaces(paseo as unknown as DashboardPaseo), home);
    if (refused.length === 0) refused.push(...store.codeRefusals(code));
    if (refused.length > 0) throw missionInvalid(refused);
  }
  const ensured = await ensureRolesFor(paseo, deps.log);
  const root = await ensureMissionsHome(paseo, deps);
  let mission: Mission | null = null;
  if (named) {
    const created = coded("E_MISSION_WRITE_FAILED", "write the mission", () => store.create({ code, name, goal: input.goal ?? "", repos, createdBy: "owner" }));
    if (!created.ok) throw missionInvalid(created.reasons);
    mission = created.mission;
  }
  // ADR-034: a named mission's Main starts in its own workspace; an unassigned one in the root.
  const workspaceId = mission === null ? root.workspaceId : await ensureMissionWorkspace(paseo, mission, deps);
  const prompt = await mainBriefOf(paseo, home, mission);
  const main = await createMain({ workspaceId, mission, prompt }, managerDeps(paseo, home, mission?.missionId ?? null, deps), ensured);
  if (mission !== null) {
    // Mission runtime design §3.4: the one path names the mission's Main.
    const bindings = deps.bindings?.() ?? undefined;
    const named = await replaceMain(mission.missionId, main.agentId, "created", {
      home,
      paseo,
      expectedOld: null,
      ...(bindings ? { bindings } : {}),
      ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
    });
    if (!named.ok) logOf(deps)(`[paseo-bm] Main ${main.agentId} of mission ${mission.code} was created, but the mission could not record it: ${named.reasons.join("; ")}`);
    // Mission runtime design §5.2: an older one-repo mission of its repos is offered for merging.
    offerMerges(home, mission.missionId, { now: deps.now?.() ?? new Date(), log: logOf(deps) });
  }
  return { missionId: mission?.missionId ?? null, agentId: main.agentId, created: true, toolsNotice: main.toolsNotice, setupNotice: await setupNoticeFor(paseo, ensured) };
}

/**
 * Each mission's Main being created right now (mission runtime design §3.4):
 * a `mission.ensure` during it joins it instead of adopting the half-made
 * agent, so one replacement runs.
 */
const creatingMain = new Map<string, Promise<string>>();

/** Runs `create` as the mission's one creation in flight; another call meanwhile gets the same agent id. */
async function oneMainCreation(missionId: string, create: () => Promise<string>): Promise<{ agentId: string; joined: boolean }> {
  const running = creatingMain.get(missionId);
  if (running !== undefined) return { agentId: await running, joined: true };
  const started = create();
  creatingMain.set(missionId, started);
  try {
    return { agentId: await started, joined: false };
  } finally {
    if (creatingMain.get(missionId) === started) creatingMain.delete(missionId);
  }
}

/** `mission.ensure` (§3.4). See the contract. */
export async function handleMissionEnsure(input: MissionEnsureInput, paseo: MissionsPaseo, deps: MissionsHomeDeps = {}): Promise<MissionEnsureOutput> {
  const home = requireDataHome(deps, "open a mission");
  // Mission runtime design §3.4: a Main being created for this mission is the one to open.
  const inFlight = creatingMain.get(input.missionId);
  if (inFlight !== undefined) return { agentId: await inFlight, created: false, replacedMainId: null };
  const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
  const mission = store.get(input.missionId);
  if (mission === null) throw missionInvalid([`unknown mission ${input.missionId}`]);
  if (mission.state !== "open") throw missionInvalid([`mission ${mission.code} is closed`]);
  const [chosen] = await findMain(paseo, mission.missionId);
  const replace = chosen !== undefined && (input.replace === "owner" || (input.replace === "outdated" && hasOutdatedInstructions(chosen.labels, "manager")));
  const bindings = deps.bindings?.() ?? undefined;
  const replaceDeps = {
    home,
    paseo,
    ...(bindings ? { bindings } : {}),
    ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };
  if (chosen !== undefined && !replace) {
    // The labelled Main is the mission's, whatever an older write recorded: what was addressed to that one goes to it (§3.4).
    if (mission.mainId !== chosen.id) {
      const replaced = await replaceMain(mission.missionId, chosen.id, "replaced", replaceDeps);
      if (!replaced.ok) throw new DashboardError("E_MISSION_WRITE_FAILED", `record the mission's Main: ${replaced.reasons.join("; ")}`);
    }
    return { agentId: chosen.id, created: false, replacedMainId: null };
  }
  const ensured = await ensureRolesFor(paseo, deps.log);
  const workspaceId = await ensureMissionWorkspace(paseo, mission, deps);
  const live = chosen?.id ?? null;
  // An archived Main the mission still names is replaced too: what waits for it goes to the successor.
  const old = live ?? mission.mainId;
  const reason = input.replace === "owner" && live !== null ? "owner" : mission.mainId === null ? "created" : "replaced";
  let toolsNotice: string | null = null;
  const made = await oneMainCreation(mission.missionId, async () => {
    const prompt = await mainBriefOf(paseo, home, mission);
    const main = await createMain({ workspaceId, mission, prompt, reason, replaces: old }, managerDeps(paseo, home, mission.missionId, deps), ensured);
    toolsNotice = main.toolsNotice;
    // Mission runtime design §3.4: the one path names the successor, compare-and-set on the Main this call read.
    const replaced = await replaceMain(mission.missionId, main.agentId, reason, { ...replaceDeps, replaced: old, expectedOld: mission.mainId });
    if (!replaced.ok) logOf(deps)(`[paseo-bm] Main ${main.agentId} replaces ${old ?? "none"}, but the replacement could not complete: ${replaced.reasons.join("; ")}`);
    return main.agentId;
  });
  if (made.joined) return { agentId: made.agentId, created: false, replacedMainId: null };
  return { agentId: made.agentId, created: true, replacedMainId: live, toolsNotice };
}

/**
 * A code handoff of a Main (missions design §9.5): its successor, created as
 * `mission.ensure`'s replacement is — in the mission's workspace, from the brief of §3.5
 * with `notice` after it, `bm.replaces` = the old Main — then §3.4 steps 2–5
 * (`replaceMain`, reason `handoff`). Returns the successor's id. Throws as
 * `createMain` does; a replacement that cannot complete is one log line.
 */
export async function handOverMain(
  mission: Mission,
  paseo: MissionsPaseo,
  notice: string,
  deps: MissionsHomeDeps & { queue?: ReplaceMainDeps["queue"] } = {},
): Promise<string> {
  const home = requireDataHome(deps, "hand a Main over");
  const old = mission.mainId;
  const workspaceId = await ensureMissionWorkspace(paseo, mission, deps);
  const made = await oneMainCreation(mission.missionId, async () => {
    const prompt = `${await mainBriefOf(paseo, home, mission)}\n${notice}`;
    const main = await createMain({ workspaceId, mission, prompt, reason: "handoff", replaces: old }, managerDeps(paseo, home, mission.missionId, deps));
    const bindings = deps.bindings?.() ?? undefined;
    // Mission runtime design §3.4: inside the one creation, so a mission.ensure meanwhile joins it.
    const replaced = await replaceMain(mission.missionId, main.agentId, "handoff", {
      home,
      paseo,
      replaced: old,
      expectedOld: old,
      ...(bindings ? { bindings } : {}),
      ...(deps.queue !== undefined ? { queue: deps.queue } : {}),
      ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
    });
    if (!replaced.ok) logOf(deps)(`[paseo-bm] Main ${main.agentId} replaces ${old ?? "none"}, but the replacement could not complete: ${replaced.reasons.join("; ")}`);
    return main.agentId;
  });
  return made.agentId;
}

// ---------------------------------------------------------------------------
// A cleared conversation (§3.3).
// ---------------------------------------------------------------------------

/** The new agent as `agent.created` names it. */
export interface CreatedMainCandidate {
  id: string;
  provider: unknown;
  workspaceId: string | null;
}

/** The agent's labels, from a fresh snapshot; none when it cannot be read. Never throws. */
export async function labelsOf(paseo: unknown, agentId: string): Promise<Record<string, unknown>> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<{ agent?: unknown } | null> } } } | null)?.agents?.ref?.(agentId);
    return asRecord(asRecord((await ref?.refresh?.())?.agent)?.["labels"]) ?? {};
  } catch {
    return {};
  }
}

/**
 * The successor claim of §3.3: `mainArchived` notes a mission whose Main was
 * archived; `agentCreated` looks at a new `bm-manager` in the home. Whichever
 * comes second within `SUCCESSOR_WINDOW_MS` claims: the new agent becomes the
 * Main. A candidate has no mission of its own and no `bm.version` (the
 * plugin's own creations name their mission), or the archived Main's mission
 * on its labels (Paseo carried them over) — preferred over an unlabelled one.
 * An agent that is the Main of another open mission is never claimed. Each
 * mission and each agent is claimed once. Never throws.
 */
export function createMainSuccession(deps: MissionsHomeDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const log = logOf(deps);
  /** missionId → the archived Main and when. */
  const awaiting = new Map<string, { oldId: string; at: number }>();
  /** New Managers of the home not claimed yet: when they were seen, and the mission their labels name (null: none). */
  const unclaimed = new Map<string, { at: number; missionId: string | null }>();

  const fresh = (at: number) => now().getTime() - at <= SUCCESSOR_WINDOW_MS;
  const prune = () => {
    for (const [key, entry] of awaiting) if (!fresh(entry.at)) awaiting.delete(key);
    for (const [key, entry] of unclaimed) if (!fresh(entry.at)) unclaimed.delete(key);
  };

  async function claim(missionId: string, oldId: string, agentId: string, labelled: boolean, paseo?: unknown): Promise<boolean> {
    const home = dataHome(deps);
    if (home === null) return false;
    const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
    const mission = store.get(missionId);
    if (mission === null || mission.state !== "open") return false;
    const bindings = deps.bindings?.() ?? undefined;
    await markMain(agentId, mission, { bindings, cli: deps.cli, log }, labelled ? null : { [REPLACES_LABEL]: oldId });
    // §3.4: the one replacement path; a cleared conversation is a replacement.
    const replaced = await replaceMain(missionId, agentId, "replaced", {
      home,
      replaced: oldId,
      ...(paseo !== undefined ? { paseo } : {}),
      ...(bindings ? { bindings } : {}),
      ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      log,
    });
    if (!replaced.ok) {
      log(`[paseo-bm] could not make ${agentId} the Main of mission ${mission.code}: ${replaced.reasons.join("; ")}`);
      return false;
    }
    journalQuietly(store, missionId, { kind: "main", by: "plugin", text: `Main ${oldId} was archived (a cleared conversation); ${agentId} took over.`, ref: agentId }, log);
    log(`[paseo-bm] ${agentId} succeeds ${oldId} as the Main of mission ${mission.code} (a cleared conversation).`);
    return true;
  }

  /** ADR-034 decision 5: a `bm-manager` the owner opened in the workspace of a mission with no live Main becomes its Main. */
  async function adopt(missionId: string, agentId: string, labelled: boolean, paseo?: unknown): Promise<boolean> {
    const home = dataHome(deps);
    if (home === null) return false;
    const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
    const mission = store.get(missionId);
    if (mission === null || mission.state !== "open") return false;
    const bindings = deps.bindings?.() ?? undefined;
    await markMain(agentId, mission, { bindings, cli: deps.cli, log }, labelled ? null : mission.mainId === null ? {} : { [REPLACES_LABEL]: mission.mainId });
    const replaced = await replaceMain(missionId, agentId, mission.mainId === null ? "created" : "replaced", {
      home,
      ...(paseo !== undefined ? { paseo } : {}),
      ...(bindings ? { bindings } : {}),
      ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      log,
    });
    if (!replaced.ok) {
      log(`[paseo-bm] could not make ${agentId} the Main of mission ${mission.code}: ${replaced.reasons.join("; ")}`);
      return false;
    }
    log(`[paseo-bm] ${agentId}, opened in the workspace of mission ${mission.code}, is its Main now.`);
    return true;
  }

  return {
    /** `agent.archived`: an open mission whose Main this was awaits a successor. Returns the claimed mission, if any. */
    async mainArchived(agentId: string): Promise<string | null> {
      try {
        prune();
        const home = dataHome(deps);
        if (home === null) return null;
        const store = createMissionStore(home);
        const entry = store.openByMain(agentId);
        if (entry === null) return null;
        // A candidate seen first: one labelled with this mission, else the newest unlabelled one; never a Main already.
        const waiting = [...unclaimed].filter(([id, seen]) => id !== agentId && (seen.missionId ?? entry.missionId) === entry.missionId && store.openByMain(id) === null);
        const chosen = waiting.filter(([, seen]) => seen.missionId !== null).at(-1) ?? waiting.at(-1);
        if (chosen !== undefined) {
          const [candidate, seen] = chosen;
          unclaimed.delete(candidate);
          return (await claim(entry.missionId, agentId, candidate, seen.missionId !== null)) ? entry.missionId : null;
        }
        awaiting.set(entry.missionId, { oldId: agentId, at: now().getTime() });
        return null;
      } catch (error) {
        log(`[paseo-bm] noting the archived Main ${agentId} failed: ${errorText(error)}`);
        return null;
      }
    },
    /** `agent.created`: a new `bm-manager` of the home may be a successor. Returns the claimed mission, if any. */
    async agentCreated(agent: CreatedMainCandidate, paseo: unknown): Promise<string | null> {
      try {
        prune();
        const home = dataHome(deps);
        if (home === null || roleOfProvider(agent.provider) !== "manager" || agent.workspaceId === null || !isMissionsHome(agent.workspaceId, home)) return null;
        const labels = await labelsOf(paseo, agent.id);
        const own = nonEmpty(labels[MISSION_ID_LABEL]);
        if (own === null && nonEmpty(labels[VERSION_LABEL]) !== null) return null;
        // The Main of another open mission succeeds no one.
        const holds = createMissionStore(home).openByMain(agent.id);
        if (holds !== null && holds.missionId !== own) return null;
        // ADR-034 decision 5: in a mission's own workspace, the agent is that mission's.
        const place = missionsPlaceOf(agent.workspaceId, home);
        const placed = place?.kind === "mission" ? place.missionId : null;
        if (placed !== null && own !== null && own !== placed) return null;
        // The mission its labels name, else its workspace's, else the one whose Main was archived last.
        const missionId = own ?? placed ?? [...awaiting.entries()].sort((a, b) => b[1].at - a[1].at)[0]?.[0];
        const entry = missionId === undefined ? undefined : awaiting.get(missionId);
        if (placed !== null && entry === undefined && nonEmpty(labels[VERSION_LABEL]) === null) {
          // The owner opened it in the mission's workspace: its Main when the mission has none live; else an extra chat, left alone.
          const live = (await findMain(paseo as MissionsPaseo, placed)).filter((candidate) => candidate.id !== agent.id);
          if (live.length > 0) return null;
          return (await adopt(placed, agent.id, own !== null, paseo)) ? placed : null;
        }
        if (missionId === undefined || entry === undefined) {
          unclaimed.set(agent.id, { at: now().getTime(), missionId: own });
          return null;
        }
        awaiting.delete(missionId);
        return (await claim(missionId, entry.oldId, agent.id, own !== null, paseo)) ? missionId : null;
      } catch (error) {
        log(`[paseo-bm] checking ${agent.id} as a Main's successor failed: ${errorText(error)}`);
        return null;
      }
    },
  };
}

/**
 * Registers `missions.create`, `mission.ensure` and the `agent.archived`
 * half of the successor claim; returns the succession, whose `agentCreated`
 * the caller runs after the creation's binding settled, and the remover.
 */
export function registerMissionsHome(server: Pick<PluginServerContext, "handle"> & Partial<Pick<PluginServerContext, "on">>, deps: MissionsHomeDeps = {}) {
  const succession = createMainSuccession(deps);
  server.handle(missionsCreateRpc, (input, { paseo }) => handleMissionsCreate(input, paseo, deps));
  server.handle(missionEnsureRpc, (input, { paseo }) => handleMissionEnsure(input, paseo, deps));
  const removed =
    typeof server.on === "function"
      ? server.on("agent.archived", (event) => {
          const id = (event as { agent?: { id?: unknown } } | null)?.agent?.id;
          if (typeof id === "string" && id !== "") void succession.mainArchived(id);
        })
      : undefined;
  return { succession, remove: typeof removed === "function" ? removed : () => {} };
}
