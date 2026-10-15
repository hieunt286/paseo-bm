/**
 * Legacy one-repo missions (missions design §3.6, REQ-192): the per-workspace
 * Managers of earlier builds become missions, and every "open the Manager"
 * entry point opens a mission's Main.
 *
 * - **Migration** (`migrateWorkspace`): for a repo workspace with no open
 *   mission whose scope holds it, the newest bound, live, non-replaced Manager
 *   of that workspace (not already a Main) becomes the Main of a new mission:
 *   `createdBy: legacy`, `legacyWorkspaceId` and `repos` = the workspace,
 *   `name` = its folder's name, `code` = that name's first letters in upper
 *   case (`legacyCodeOf`), made unique with a digit, `charter.goal` = "". It
 *   is labelled `bm.missionId`/`bm.missionCode` and titled from the mission
 *   (the Paseo CLI; a refusal costs one log line), keeps its binding
 *   (`assignMission`) and stays in the repo workspace; its open requests
 *   (registry `managerId` = it) join the roster. Run once per plugin run at
 *   the first Paseo handle (`createLegacyMigration`) and at every
 *   `manager.ensure`. Idempotent: a workspace an open mission holds is never
 *   given a second one (checked again right before the write, which is
 *   synchronous).
 * - **Every other live Manager** of that workspace is flagged by the
 *   outdated-agents pass (`extraManagersOf`, `EXTRA_MANAGER_DETAIL`).
 * - **`manager.ensure { workspaceId, requestId? }`** (`handleManagerEnsure`),
 *   behind the sidebar's "Beads Manager", the Command Center's "Open Beads
 *   Manager", Work's "Open Manager", a bead action and the Inbox's replace
 *   action: the Main of the open mission whose roster holds `requestId`, when
 *   given; else the migration, then the Main of the open mission whose scope
 *   holds the workspace (`missionOfWorkspace`: an owner's before a legacy one,
 *   mission runtime design §5.5; `mission.ensure`, `replace: "outdated"` for
 *   `replaceOutdated`), else a new one-repo mission and its Main in the home. A plugin home, or
 *   no data folder, keeps the per-workspace `ensureManager`.
 * - **A `bm-manager` the owner opens from the composer in a repo workspace**
 *   (`adoptComposerManager`, at its `agent.created`): an extra agent when the
 *   workspace's mission has a live Main; that mission's Main when it has none
 *   (`replaceMain`, §3.4); a new one-repo mission's Main when there is none.
 *
 * Nothing here archives, stops or deletes an agent (ADR-005).
 */
import { basename } from "node:path";
import type { EnsureRolesResult } from "./setup-roles";
import { createBindingStore, type BindingStore } from "./agent-bindings";
import { listAllAgents, roleOfAgent, roleOfProvider } from "./agent-role";
import { VERSION_LABEL, ensureManager, ensureRolesFor, findLiveManagers, findMain, setupNoticeFor, type EnsureManagerResult, type ManagerAgentSnapshot } from "./manager";
import { createMissionRoster, requestIndexOf } from "./mission-roster";
import { replaceMain } from "./mission-replace";
import { offerMerges } from "./mission-ownership";
import { MISSION_CODE_PATTERN, createMissionStore, journalQuietly, type Mission } from "./mission-store";
import { ensureMissionWorkspace, ensureMissionsHome, handleMissionEnsure, labelsOf, markMain, type MissionsHomeDeps, type MissionsPaseo } from "./missions-home";
import { hasOutdatedInstructions } from "./instructions-label";
import { listedWorkspaces, workspaceDirectory, type DashboardPaseo } from "./paseo-directory";
import { isPluginHome, isPluginHomeIn } from "./plugin-homes";
import { createRequestRegistry } from "./request-registry";
import { nonEmpty } from "./role-choices";
import { currentInstructions } from "./role-instructions";
import { MISSION_ID_LABEL } from "./role-title";
import { dataHome, errorText } from "./rpc-kit";

/** How many of the folder name's letters a legacy code takes. */
export const LEGACY_CODE_LETTERS = 4;

const logOf = (deps: MissionsHomeDeps) => deps.log ?? ((message: string) => console.warn(message));
const storeOf = (home: string, deps: MissionsHomeDeps) => createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
const bindingsOf = (home: string, deps: MissionsHomeDeps): BindingStore => deps.bindings?.() ?? createBindingStore(home);

/**
 * A legacy mission's code (§3.6): the name's first `LEGACY_CODE_LETTERS`
 * letters and digits in upper case, from its first letter (`REPO` without
 * one, a one-letter name padded with `X`); when `taken`, the first free one
 * with a number appended (`API2`, `API3` …), cut to 8 characters.
 */
export function legacyCodeOf(name: string, taken: (code: string) => boolean): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, "");
  const base = letters === "" ? "REPO" : letters.length === 1 ? `${letters}X` : letters.slice(0, LEGACY_CODE_LETTERS);
  if (!taken(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const digits = String(n);
    const code = `${base.slice(0, Math.max(1, Math.min(base.length, 8 - digits.length)))}${digits}`;
    if (MISSION_CODE_PATTERN.test(code) && !taken(code)) return code;
  }
  return base;
}

/**
 * The open mission whose scope holds the workspace, or null (mission runtime
 * design §5.5): one the owner or the orchestrator created before a legacy
 * one, then the one with the newest journal line, then the newest. Never throws.
 */
export function missionOfWorkspace(home: string, workspaceId: string): Mission | null {
  try {
    const store = createMissionStore(home);
    const lastActivity = (mission: Mission): string => store.journal(mission.missionId, 1).at(-1)?.at ?? "";
    return (
      store
        .list()
        .filter((entry) => entry.state === "open" && entry.repos.includes(workspaceId))
        .map((entry) => store.get(entry.missionId))
        .filter((mission): mission is Mission => mission !== null && mission.state === "open")
        .map((mission) => ({ mission, legacy: mission.createdBy === "legacy" ? 1 : 0, active: lastActivity(mission) }))
        .sort((a, b) => a.legacy - b.legacy || b.active.localeCompare(a.active) || b.mission.createdAt.localeCompare(a.mission.createdAt))[0]?.mission ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Writes a one-repo mission of `workspaceId` (§3.6) with `mainId` as its Main
 * (none: its Main is created after), unless an open mission holds the
 * workspace already — then that one. Synchronous from the check to the write.
 * Throws when the mission cannot be written.
 */
function writeLegacyMission(home: string, workspaceId: string, folder: string | null, mainId: string | null, deps: MissionsHomeDeps): { mission: Mission; created: boolean } {
  const existing = missionOfWorkspace(home, workspaceId);
  if (existing !== null) return { mission: existing, created: false };
  const store = storeOf(home, deps);
  const name = (folder === null ? workspaceId : basename(folder)).slice(0, 80);
  const open = new Set(store.list().flatMap((entry) => (entry.state === "open" ? [entry.code] : [])));
  const code = legacyCodeOf(name, (candidate) => open.has(candidate));
  const made = store.create({ code, name, goal: "", repos: [workspaceId], createdBy: "legacy", legacyWorkspaceId: workspaceId, mainId });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  journalQuietly(
    store,
    made.mission.missionId,
    {
      kind: "main",
      by: "plugin",
      text: mainId === null ? `One-repo mission of ${name}; its Main is created in the Missions home.` : `One-repo mission of ${name}, made from its Beads Manager ${mainId}.`,
      ...(mainId === null ? {} : { ref: mainId }),
    },
    logOf(deps),
  );
  return { mission: made.mission, created: true };
}

/** True when the Manager is labelled with a mission (a Main, of an open or a closed mission). */
const isMain = (agent: Pick<ManagerAgentSnapshot, "labels">): boolean => nonEmpty(agent.labels?.[MISSION_ID_LABEL]) !== null;

/**
 * The migration of one workspace (see the module comment). `managers` are its
 * live Managers (`findLiveManagers`), listed when absent; `prefer` is a
 * Manager to make the Main whether bound or not (a composer's). Returns the
 * mission made, or null: a plugin home, a workspace a mission holds already,
 * no Manager to migrate, or a failure (one log line). Never throws.
 */
export async function migrateWorkspace(
  paseo: MissionsPaseo,
  workspaceId: string,
  deps: MissionsHomeDeps = {},
  options: { managers?: readonly ManagerAgentSnapshot[]; prefer?: string } = {},
): Promise<Mission | null> {
  const home = dataHome(deps);
  if (home === null || (await isPluginHomeNow(paseo, workspaceId, home)) || missionOfWorkspace(home, workspaceId) !== null) return null;
  const log = logOf(deps);
  try {
    let chosen = options.prefer ?? null;
    if (chosen === null) {
      const managers = options.managers ?? (await findLiveManagers(paseo, workspaceId, { home, log }));
      const bindings = bindingsOf(home, deps);
      const bound = managers.filter((agent) => !isMain(agent) && bindings.bindingOfAgent(agent.id)?.state === "bound");
      chosen = [...bound].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : -1))[0]?.id ?? null;
    }
    if (chosen === null) return null;
    const folder = await workspaceDirectory(paseo as unknown as DashboardPaseo, workspaceId).catch(() => null);
    const { mission, created } = writeLegacyMission(home, workspaceId, folder, chosen, deps);
    if (!created) return null;
    await markMain(chosen, mission, { bindings: bindingsOf(home, deps), cli: deps.cli, log });
    const roster = createMissionRoster(home, deps.now === undefined ? {} : { now: deps.now });
    for (const request of createRequestRegistry(home, { log }).list(workspaceId)) {
      if (request.managerId !== chosen || request.finishedAt !== null) continue;
      for (const workerId of request.workerIds.length === 0 ? [null] : request.workerIds) {
        roster.add(mission.missionId, { requestId: request.requestId, workspaceId, topic: "", workerId });
      }
    }
    log(`[paseo-bm] the Beads Manager ${chosen} of ${workspaceId} is the Main of the one-repo mission ${mission.code} now.`);
    return mission;
  } catch (error) {
    log(`[paseo-bm] the Beads Manager of ${workspaceId} could not become a mission's Main: ${errorText(error)}`);
    return null;
  }
}

/** The start-up migration (§3.6): once per plugin run, every repo workspace with a live Manager. Never rejects. */
export function createLegacyMigration(deps: MissionsHomeDeps = {}) {
  let ran = false;
  return {
    async run(paseo: unknown): Promise<void> {
      if (ran || typeof (paseo as Partial<MissionsPaseo> | null)?.agents?.list !== "function") return;
      ran = true;
      try {
        const handle = paseo as MissionsPaseo;
        const agents = await listAllAgents((options) => handle.agents.list(options), { includeArchived: false });
        const workspaces = new Set(agents.filter((agent) => roleOfAgent(agent)?.role === "manager").map((agent) => agent.workspaceId));
        for (const workspaceId of workspaces) if (typeof workspaceId === "string" && workspaceId !== "") await migrateWorkspace(handle, workspaceId, deps);
        // Mission runtime design §5.2: every open mission is offered the merge of an older one-repo mission of its repos, once per pair.
        const home = dataHome(deps);
        if (home !== null) for (const entry of createMissionStore(home).list()) if (entry.state === "open") offerMerges(home, entry.missionId, { now: deps.now?.() ?? new Date(), log: logOf(deps) });
        // ADR-034 decision 6: the Mission-List project, and a workspace for every open mission of the owner or the orchestrator.
        if (home !== null && typeof handle.workspaces?.open === "function") {
          await ensureMissionsHome(handle, deps);
          const store = createMissionStore(home);
          for (const entry of store.list()) {
            const mission = entry.state === "open" ? store.get(entry.missionId) : null;
            if (mission !== null && mission.createdBy !== "legacy") await ensureMissionWorkspace(handle, mission, deps);
          }
        }
      } catch (error) {
        logOf(deps)(`[paseo-bm] the start-up migration of the Beads Managers failed: ${errorText(error)}`);
      }
    },
  };
}

/**
 * Whether a workspace is a plugin home, by its id or, when the id is cached
 * nowhere yet, by the folder Paseo lists for it: a second workspace Paseo
 * opened for a home folder, before its first trace, once became a one-repo
 * mission "HOME" (2026-10-12). Never throws.
 */
async function isPluginHomeNow(paseo: unknown, workspaceId: string, home: string): Promise<boolean> {
  if (isPluginHome(workspaceId, home)) return true;
  const listed = await listedWorkspaces(paseo as DashboardPaseo).catch(() => null);
  return isPluginHomeIn(workspaceId, listed, home);
}

/** The open mission whose roster holds `requestId`, or null. Never throws. */
function openMissionOfRequest(home: string, requestId: string): Mission | null {
  try {
    const place = requestIndexOf(home, requestId);
    const mission = place === null ? null : createMissionStore(home).get(place.missionId);
    return mission !== null && mission.state === "open" ? mission : null;
  } catch {
    return null;
  }
}

/** `manager.ensure` (§3.6): see the module comment. Throws as `mission.ensure` and `ensureManager` do. */
export async function handleManagerEnsure(
  input: { workspaceId: string; replaceOutdated?: boolean; requestId?: string },
  paseo: MissionsPaseo,
  deps: MissionsHomeDeps = {},
): Promise<EnsureManagerResult> {
  const home = dataHome(deps);
  const { workspaceId } = input;
  if (home === null || (await isPluginHomeNow(paseo, workspaceId, home))) {
    return ensureManager(input, {
      paseo,
      home,
      readInstructions: (id) => currentInstructions("manager", paseo, { workspaceId: id }),
      ...(deps.binder !== undefined ? { binder: deps.binder() } : {}),
      ...(deps.log !== undefined ? { log: deps.log } : {}),
      ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
    });
  }
  const ensured: EnsureRolesResult = await ensureRolesFor(paseo, deps.log);
  const managers = await findLiveManagers(paseo, workspaceId, { home, log: deps.log });
  // Mission runtime design §5.5: a request of an open mission opens that mission's Main.
  const ofRequest = input.requestId === undefined ? null : openMissionOfRequest(home, input.requestId);
  if (ofRequest === null) await migrateWorkspace(paseo, workspaceId, deps, { managers });
  const folder = ofRequest === null && missionOfWorkspace(home, workspaceId) === null ? await workspaceDirectory(paseo as unknown as DashboardPaseo, workspaceId).catch(() => null) : null;
  const { mission } = ofRequest !== null ? { mission: ofRequest } : writeLegacyMission(home, workspaceId, folder, null, deps);
  // A Main its label never reached (the CLI refused it) is still the mission's: opened unless it is replaced.
  const unlabelled = managers.find((agent) => agent.id === mission.mainId);
  const opened =
    unlabelled !== undefined && (await findMain(paseo, mission.missionId)).length === 0 && !(input.replaceOutdated === true && hasOutdatedInstructions(unlabelled.labels, "manager"))
      ? { agentId: unlabelled.id, created: false, replacedMainId: null, toolsNotice: null }
      : await handleMissionEnsure({ missionId: mission.missionId, ...(input.replaceOutdated === true ? { replace: "outdated" as const } : {}) }, paseo, deps);
  return {
    agentId: opened.agentId,
    created: opened.created,
    otherManagerIds: managers.filter((agent) => agent.id !== opened.agentId && !isMain(agent) && agent.id !== mission.mainId).map((agent) => agent.id),
    modeNotice: null,
    toolsNotice: opened.toolsNotice ?? null,
    setupNotice: await setupNoticeFor(paseo, ensured),
    // `mission.ensure` names only a labelled Main it replaced; an unlabelled one it replaced is the mission's `mainId`.
    replacedManagerId: opened.replacedMainId ?? (opened.created && unlabelled !== undefined ? unlabelled.id : null),
  };
}

/**
 * A `bm-manager` the owner opened from the composer in a repo workspace (§3.6),
 * at its `agent.created`, after its binding settled: none of the plugin's own
 * (`bm.version`) and none with a mission. Returns what it became. Never throws.
 */
export async function adoptComposerManager(
  agent: { id: string; provider: unknown; workspaceId: string | null },
  paseo: unknown,
  deps: MissionsHomeDeps = {},
): Promise<"main" | "extra" | "mission" | null> {
  const home = dataHome(deps);
  const workspaceId = agent.workspaceId;
  if (roleOfProvider(agent.provider) !== "manager" || home === null || workspaceId === null || (await isPluginHomeNow(paseo, workspaceId, home))) return null;
  const log = logOf(deps);
  try {
    const labels = await labelsOf(paseo, agent.id);
    if (nonEmpty(labels[VERSION_LABEL]) !== null || nonEmpty(labels[MISSION_ID_LABEL]) !== null) return null;
    const handle = paseo as MissionsPaseo;
    const mission = missionOfWorkspace(home, workspaceId);
    if (mission === null) return (await migrateWorkspace(handle, workspaceId, deps, { prefer: agent.id })) === null ? null : "mission";
    const live = (await findMain(handle, mission.missionId)).length > 0 || (mission.mainId !== null && (await findLiveManagers(handle, workspaceId, { home, log })).some((entry) => entry.id === mission.mainId));
    // The owner opened the wrong door: the outdated-agents pass flags it as an extra Manager.
    if (live) return "extra";
    await markMain(agent.id, mission, { bindings: bindingsOf(home, deps), cli: deps.cli, log });
    const bindings = deps.bindings?.() ?? undefined;
    const replaced = await replaceMain(mission.missionId, agent.id, mission.mainId === null ? "created" : "replaced", {
      home,
      paseo,
      ...(bindings ? { bindings } : {}),
      ...(deps.cli !== undefined ? { cli: deps.cli } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      log,
    });
    if (!replaced.ok) {
      log(`[paseo-bm] could not make ${agent.id} the Main of mission ${mission.code}: ${replaced.reasons.join("; ")}`);
      return null;
    }
    return "main";
  } catch (error) {
    log(`[paseo-bm] checking the composer's Beads Manager ${agent.id} against its mission failed: ${errorText(error)}`);
    return null;
  }
}
