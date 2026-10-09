/**
 * The Missions home and its Mains (missions design §3.1–§3.3, §3.5; ADR-029).
 *
 * - **The home** (`ensureMissionsHome`, §3.1): `<data folder>/missions/home`
 *   (`0700`, a `README.md` saying what it is), opened as a workspace with
 *   `paseo.workspaces.open({ cwd })` as the Orchestrator's home is. Its
 *   workspace id is cached in `ui/missions-home.json`, which the creation
 *   hook reads (`missionsHomeIdOf`, `isMissionsHome`): a `bm-manager` the
 *   owner opens there is an unassigned Main.
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
import { basename, join, resolve } from "node:path";
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
import { VERSION_LABEL, createMain, ensureRolesFor, findMain, setupNoticeFor, type ManagerPaseo } from "./manager";
import { MISSION_CLASSES, createMissionAutonomyStore } from "./mission-autonomy-store";
import { replaceMain } from "./mission-replace";
import { createMissionRoster } from "./mission-roster";
import { MISSIONS_DIR_NAME, createMissionStore, type Mission } from "./mission-store";
import { briefLineOf } from "./notices";
import { orchestratorHomeOf } from "./orchestrator-agent";
import { newestReportRecordOf, reportPhaseOf } from "./outbox";
import { setAgentLabels, setAgentTitle, type PaseoCliDeps } from "./paseo-cli";
import { listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { createRequestRegistry } from "./request-registry";
import { asRecord, nonEmpty } from "./role-choices";
import { currentInstructions, type MainFacts } from "./role-instructions";
import { MISSION_CODE_LABEL, MISSION_ID_LABEL, mainTitleOf } from "./role-title";
import { coded, dataHome, errorText, requireDataHome, type RpcHomeDeps } from "./rpc-kit";

/** The home's folder, under `<data folder>/missions/`. */
export const MISSIONS_HOME_DIR_NAME = "home";
/** Where the home's workspace id is cached, in the data folder's `ui/`. */
export const MISSIONS_HOME_FILE = "missions-home.json";
export const MISSIONS_HOME_VERSION = 1;
/** How long a mission whose Main was archived awaits a successor (§3.3). */
export const SUCCESSOR_WINDOW_MS = 60_000;
/** The journal lines a brief carries (§3.5). */
export const BRIEF_JOURNAL_LINES = 20;

/** What the home folder's `README.md` says, so a user who finds it knows what it is. */
export const MISSIONS_HOME_README = `# Beads Missions

This folder is the workspace of paseo-bm's Mains: one Beads Manager per
mission, each working across the repositories of its mission. It holds no
project; the work happens in the repositories.

paseo-bm created it; the missions themselves are kept beside it, in this
folder's parent.
`;

/** `<data folder>/missions/home`. */
export function missionsHomeDirOf(home: string): string {
  return join(home, MISSIONS_DIR_NAME, MISSIONS_HOME_DIR_NAME);
}

const homeFile = (home: string) =>
  createJsonFileStore<{ workspaceId: string | null; directory: string | null }>({
    home,
    dir: UI_DIR_NAME,
    file: MISSIONS_HOME_FILE,
    version: MISSIONS_HOME_VERSION,
    versionKey: "schemaVersion",
    parse: (body) => ({ workspaceId: nonEmpty(body["workspaceId"]), directory: nonEmpty(body["directory"]) }),
    empty: () => ({ workspaceId: null, directory: null }),
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

/** True when `workspaceIdOrDirectory` is the Missions home: its cached id, or its folder. Never throws. */
export function isMissionsHome(workspaceIdOrDirectory: string | null | undefined, home: string | null = dataHome()): boolean {
  if (home === null || typeof workspaceIdOrDirectory !== "string" || workspaceIdOrDirectory === "") return false;
  if (workspaceIdOrDirectory === missionsHomeIdOf(home)) return true;
  try {
    return resolve(workspaceIdOrDirectory) === resolve(missionsHomeDirOf(home));
  } catch {
    return false;
  }
}

/** The SDK slice the home and its Mains use; `PaseoApi` is structurally assignable. */
export type MissionsPaseo = ManagerPaseo & {
  workspaces: ManagerPaseo["workspaces"] & {
    open(input: { cwd: string }): Promise<{ readonly id: string }>;
    list(options?: unknown): Promise<{ entries: Array<Record<string, unknown>> }>;
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
 * Creates `<data folder>/missions/home` (`0700`, its `README.md`), opens it
 * as a workspace and caches its id (§3.1). No data folder →
 * `E_DATA_HOME_UNAVAILABLE`; a failed write → `E_MISSION_WRITE_FAILED`.
 */
export async function ensureMissionsHome(paseo: Pick<MissionsPaseo, "workspaces">, deps: MissionsHomeDeps = {}): Promise<{ workspaceId: string; directory: string }> {
  const home = requireDataHome(deps, "open the Missions home");
  const directory = missionsHomeDirOf(home);
  coded("E_MISSION_WRITE_FAILED", `prepare the Missions home ${directory}`, () => {
    ensureDataDir(home, directory, "E_MISSION_WRITE_FAILED");
    writeFileAtomically(home, join(directory, "README.md"), MISSIONS_HOME_README, "E_MISSION_WRITE_FAILED");
  });
  const { id } = await paseo.workspaces.open({ cwd: directory });
  const file = homeFile(home);
  const cached = file.read();
  if (cached.workspaceId !== id || cached.directory !== directory) {
    coded("E_MISSION_WRITE_FAILED", "remember the Missions home", () => file.write({ workspaceId: id, directory }));
  }
  return { workspaceId: id, directory };
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
 * A Main's first prompt (§3.5): the `BM-BRIEF manager requestId: none
 * mission: <code>` line, the mission's name, goal and charter state, its repos
 * with their folders, its open requests (repo, newest Worker, newest report's
 * phase), its open done criteria, the newest 20 journal lines, and where the
 * rest is. `UNASSIGNED_MAIN_BRIEF` for none. Never throws: a store that
 * cannot be read is left out.
 */
export async function mainBriefOf(paseo: unknown, home: string | null, mission: Mission | null): Promise<string> {
  if (mission === null || home === null) return UNASSIGNED_MAIN_BRIEF;
  const listed = (await listedWorkspaces(paseo as DashboardPaseo).catch(() => null)) ?? [];
  const folderOf = (workspaceId: string) => listed.find((entry) => entry.id === workspaceId)?.directory ?? null;
  const repoName = (workspaceId: string) => {
    const folder = folderOf(workspaceId);
    return folder === null ? workspaceId : basename(folder);
  };
  const { charter } = mission;
  const lines = [
    `${briefLineOf("manager", null)} mission: ${mission.code}`,
    `Mission: ${mission.code} — ${oneLine(mission.name)} (${mission.missionId}). Charter: ${charter.confirmedAt === null ? "not confirmed by the owner yet" : `confirmed ${charter.confirmedAt.slice(0, 10)}`}.`,
    `Goal: ${charter.goal.trim() === "" ? "not set yet — ask the owner when you need it" : oneLine(charter.goal, 4_000)}`,
    "Repos:",
    ...(charter.repos.length === 0 ? ["- none yet"] : charter.repos.map((workspaceId) => `- ${repoName(workspaceId)} (${workspaceId}): ${folderOf(workspaceId) ?? "folder unknown"}`)),
  ];
  try {
    const registry = createRequestRegistry(home);
    const open = createMissionRoster(home).list(mission.missionId).filter((entry) => entry.state === "active");
    lines.push("Open requests:");
    if (open.length === 0) lines.push("- none");
    for (const entry of open) {
      const workerId = entry.workerIds.at(-1) ?? registry.get(entry.workspaceId, entry.requestId)?.workerIds.at(-1) ?? null;
      const report = workerId === null ? null : newestReportRecordOf(home, entry.workspaceId, workerId);
      const phase = report === null ? null : reportPhaseOf(report.text);
      lines.push(
        `- ${entry.requestId} in ${repoName(entry.workspaceId)}: ${oneLine(entry.topic, 120) || "no topic"}; Worker ${workerId ?? "none"}; newest report: ${phase ?? "none"}`,
      );
    }
  } catch {
    // The roster cannot be read: bm_mission reads it again.
  }
  const criteria = charter.doneCriteria.filter((criterion) => criterion.status === "open");
  lines.push("Open done criteria:", ...(criteria.length === 0 ? ["- none"] : criteria.map((criterion) => `- ${criterion.id}: ${oneLine(criterion.text, 500)}`)));
  const journal = createMissionStore(home).journal(mission.missionId, BRIEF_JOURNAL_LINES);
  if (journal.length > 0) lines.push("Journal (newest last):", ...journal.map((line) => `- ${line.at} ${line.kind} ${line.by}: ${oneLine(line.text)}`));
  lines.push("Read the whole mission with bm_mission.");
  return lines.join("\n");
}

/**
 * After a rename (§3.2): the mission's Main gets the title `mainTitleOf`
 * through the Paseo CLI. Ok when there is no Main to title. Never throws.
 */
export async function syncMainTitle(mission: Pick<Mission, "mainId" | "code" | "name">, cli?: PaseoCliDeps): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (mission.mainId === null) return { ok: true };
  try {
    return await setAgentTitle(mission.mainId, mainTitleOf(mission.code, mission.name), cli);
  } catch (error) {
    return { ok: false, reason: errorText(error) };
  }
}

// ---------------------------------------------------------------------------
// missions.create and mission.ensure (§3.3, §3.4).
// ---------------------------------------------------------------------------

function invalid(reasons: readonly string[]): DashboardError {
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
  if (named && (name === "" || code === "")) throw invalid(["give the mission both a name and a code, or neither"]);
  const repos = [...new Set(input.repos ?? [])];
  if (!named && (repos.length > 0 || (input.goal ?? "").trim() !== "")) throw invalid(["a mission's repos and goal need its name and code"]);
  if (named) {
    const refused = repoRefusals(repos, await listedWorkspaces(paseo as unknown as DashboardPaseo), home);
    if (refused.length > 0) throw invalid(refused);
  }
  const ensured = await ensureRolesFor(paseo, deps.log);
  const { workspaceId: homeWorkspaceId } = await ensureMissionsHome(paseo, deps);
  let mission: Mission | null = null;
  if (named) {
    const created = coded("E_MISSION_WRITE_FAILED", "write the mission", () =>
      createMissionStore(home, deps.now === undefined ? {} : { now: deps.now }).create({ code, name, goal: input.goal ?? "", repos, createdBy: "owner" }),
    );
    if (!created.ok) throw invalid(created.reasons);
    mission = created.mission;
  }
  const prompt = await mainBriefOf(paseo, home, mission);
  const main = await createMain({ homeWorkspaceId, mission, prompt }, managerDeps(paseo, home, mission?.missionId ?? null, deps), ensured);
  return { missionId: mission?.missionId ?? null, agentId: main.agentId, created: true, toolsNotice: main.toolsNotice, setupNotice: await setupNoticeFor(paseo, ensured) };
}

/** `mission.ensure` (§3.4). See the contract. */
export async function handleMissionEnsure(input: MissionEnsureInput, paseo: MissionsPaseo, deps: MissionsHomeDeps = {}): Promise<MissionEnsureOutput> {
  const home = requireDataHome(deps, "open a mission");
  const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
  const mission = store.get(input.missionId);
  if (mission === null) throw invalid([`unknown mission ${input.missionId}`]);
  if (mission.state !== "open") throw invalid([`mission ${mission.code} is closed`]);
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
  const { workspaceId: homeWorkspaceId } = await ensureMissionsHome(paseo, deps);
  const live = chosen?.id ?? null;
  // An archived Main the mission still names is replaced too: what waits for it goes to the successor.
  const old = live ?? mission.mainId;
  const reason = input.replace === "owner" && live !== null ? "owner" : mission.mainId === null ? "created" : "replaced";
  const prompt = await mainBriefOf(paseo, home, mission);
  const main = await createMain({ homeWorkspaceId, mission, prompt, reason, replaces: old }, managerDeps(paseo, home, mission.missionId, deps), ensured);
  if (old !== null) {
    // §3.4 steps 2–5; `createMain` named the successor (step 1).
    const replaced = await replaceMain(mission.missionId, main.agentId, reason, { ...replaceDeps, replaced: old });
    if (!replaced.ok) logOf(deps)(`[paseo-bm] Main ${main.agentId} replaces ${old}, but the replacement could not complete: ${replaced.reasons.join("; ")}`);
  }
  return { agentId: main.agentId, created: true, replacedMainId: live, toolsNotice: main.toolsNotice };
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

/** The agent's labels, from a fresh snapshot; none when it cannot be read. */
async function labelsOf(paseo: unknown, agentId: string): Promise<Record<string, unknown>> {
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
 * on its labels (Paseo carried them over). Each mission and each agent is
 * claimed once. Never throws.
 */
export function createMainSuccession(deps: MissionsHomeDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const log = logOf(deps);
  /** missionId → the archived Main and when. */
  const awaiting = new Map<string, { oldId: string; at: number }>();
  /** New unassigned Managers of the home, and when they were seen. */
  const unclaimed = new Map<string, number>();

  const fresh = (at: number) => now().getTime() - at <= SUCCESSOR_WINDOW_MS;
  const prune = () => {
    for (const [key, entry] of awaiting) if (!fresh(entry.at)) awaiting.delete(key);
    for (const [key, at] of unclaimed) if (!fresh(at)) unclaimed.delete(key);
  };

  async function claim(missionId: string, oldId: string, agentId: string, labelled: boolean, paseo?: unknown): Promise<boolean> {
    const home = dataHome(deps);
    if (home === null) return false;
    const store = createMissionStore(home, deps.now === undefined ? {} : { now: deps.now });
    const mission = store.get(missionId);
    if (mission === null || mission.state !== "open") return false;
    deps.bindings?.()?.assignMission(agentId, missionId);
    if (!labelled) {
      const labels = await setAgentLabels(agentId, { [MISSION_ID_LABEL]: missionId, [MISSION_CODE_LABEL]: mission.code, "bm.replaces": oldId }, deps.cli).catch(
        (error: unknown) => ({ ok: false as const, reason: errorText(error) }),
      );
      if (!labels.ok) log(`[paseo-bm] Main ${agentId} of mission ${mission.code} could not be labelled: ${labels.reason}`);
    }
    const titled = await syncMainTitle({ mainId: agentId, code: mission.code, name: mission.name }, deps.cli);
    if (!titled.ok) log(`[paseo-bm] Main ${agentId} of mission ${mission.code} could not be titled: ${titled.reason}`);
    // §3.4: the one replacement path; a cleared conversation is a replacement.
    const bindings = deps.bindings?.() ?? undefined;
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
    try {
      store.appendJournal(missionId, { kind: "main", by: "plugin", text: `Main ${oldId} was archived (a cleared conversation); ${agentId} took over.`, ref: agentId });
    } catch {
      // The journal is what happened, never state.
    }
    log(`[paseo-bm] ${agentId} succeeds ${oldId} as the Main of mission ${mission.code} (a cleared conversation).`);
    return true;
  }

  return {
    /** `agent.archived`: an open mission whose Main this was awaits a successor. Returns the claimed mission, if any. */
    async mainArchived(agentId: string): Promise<string | null> {
      try {
        prune();
        const home = dataHome(deps);
        if (home === null) return null;
        const entry = createMissionStore(home).list().find((mission) => mission.state === "open" && mission.mainId === agentId);
        if (entry === undefined) return null;
        const waiting = [...unclaimed.keys()].at(-1);
        if (waiting !== undefined) {
          unclaimed.delete(waiting);
          return (await claim(entry.missionId, agentId, waiting, false)) ? entry.missionId : null;
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
        if (roleOfProvider(agent.provider) !== "manager" || agent.workspaceId === null || !isMissionsHome(agent.workspaceId, dataHome(deps))) return null;
        const labels = await labelsOf(paseo, agent.id);
        const own = nonEmpty(labels[MISSION_ID_LABEL]);
        if (own !== null) {
          const entry = awaiting.get(own);
          if (entry === undefined) return null;
          awaiting.delete(own);
          return (await claim(own, entry.oldId, agent.id, true, paseo)) ? own : null;
        }
        if (nonEmpty(labels[VERSION_LABEL]) !== null) return null;
        const newest = [...awaiting.entries()].sort((a, b) => b[1].at - a[1].at)[0];
        if (newest === undefined) {
          unclaimed.set(agent.id, now().getTime());
          return null;
        }
        awaiting.delete(newest[0]);
        return (await claim(newest[0], newest[1].oldId, agent.id, false, paseo)) ? newest[0] : null;
      } catch (error) {
        log(`[paseo-bm] checking ${agent.id} as a Main's successor failed: ${errorText(error)}`);
        return null;
      }
    },
  };
}

export type MainSuccession = ReturnType<typeof createMainSuccession>;

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
