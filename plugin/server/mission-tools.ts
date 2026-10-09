/**
 * The Main's mission tools (missions design §4, §4.1; ADR-029; REQ-184,
 * REQ-191): the owner creates and names a mission, the Main keeps its charter.
 *
 * | Tool | Does |
 * |---|---|
 * | `bm_mission` | reads the caller's mission: charter, plan, contracts, roster (each request's repo, Worker, phase, newest report), its Workers' open questions, the open `m:` cards, the mission level, the newest `MISSION_JOURNAL_SHOWN` journal lines |
 * | `bm_mission_start` | an unassigned Main in the Missions home proposes the mission the owner named (`proposed-mission-starts.ts`); `settleMissionStart` records it at the turn's end only when the turn holds the owner's own message (the decision materialiser), then binds, labels and titles the Main |
 * | `bm_mission_update` | writes the free changes at once (plan, contracts, new criteria, a criterion's status open or met, a repo added at a mission level that delegates `scope-repo`), each with a journal line; everything else opens one `m:` decision whose "apply" option carries the change |
 * | `bm_answer_worker` | answers open `q:` questions of the mission's requests within missions design §8 (`mainAnswerRuleOf`): `by: main`, `via: main`, no grant, handed to `onSettled` (the Worker gets it cited as the Main's); in a `shadow` cell the Main may not decide, records its recommendation as `prediction.main`. Refused for an `ownerOnly` question, one asked over `MAIN_ANSWER_MINUTES` ago, a settled one, an option with a grant or a change, a request of another mission |
 *
 * **The owner's card.** An `m:<missionId>:<n>` decision lives in the
 * mission's own store (`mission-decisions.ts`), asked by `plugin` with the
 * Main's id, with the mission id as its `workspaceId`. Its "apply" option
 * carries the prepared action `mission-change` (`shared/mission-change.ts`);
 * only `decisions.answer` answers it (`decision-rpc.ts`), which checks the
 * change again first (`missionAnswerRefusalsOf`, nothing written on a
 * refusal) and has it applied after the owner's answer is recorded
 * (`applyMissionDecision`), which tells the mission's current Main what the
 * owner decided (an outbox `message` in the Main's workspace). No agent tool,
 * policy or precedent reads that store, and `answerDecision` refuses any
 * answerer but the owner on it.
 *
 * Common rules (§7.15): a refusal is one line per reason and changes nothing;
 * a pending binding is refused by the shared guard; the caller's mission
 * comes from its binding (or the mission whose Main it is, §2.3), never from
 * the input. Text is masked by the stores. Nothing here throws into the
 * endpoint.
 */
import { isAbsolute, resolve } from "node:path";
import type { ToolCaller } from "./agent-bindings";
import { createBindingStore } from "./agent-bindings";
import { mainAnswerRuleOf } from "../shared/autonomy";
import { MAIN_ANSWER_MINUTES, MISSION_TOOL_FACES, schemaIssues, type ToolFace } from "../shared/bm-tools";
import {
  UNSETTLED_STATUSES,
  answerDecision,
  decisionClassOf,
  isPreparedChange,
  notOpenRefusalOf,
  questionDecisionId,
  type Decision,
  type TransitionResult,
} from "../shared/decisions";
import { currentPolicy } from "./autonomy-store";
import { redactText } from "./collector";
import type { OnDecisionsSettled } from "./decision-rpc";
import { isEmptyMissionChange, missionChangeLinesOf, type MissionChange, type MissionChangeAction } from "../shared/mission-change";
import { createDecisionStore } from "./decision-store";
import { decisionSummaryOf, type ServerToolAnswer, type ServerTools } from "./decision-tools";
import { MISSION_CLASSES, createMissionAutonomyStore } from "./mission-autonomy-store";
import { createMissionDecisionStore, missionOfDecisionId } from "./mission-decisions";
import { createMissionRoster, requestIndexOf, runningRequestsOf } from "./mission-roster";
import { createMissionStore, journalQuietly, type Mission, type MissionContract } from "./mission-store";
import { isMissionsHome, markMain, missionsHomeIdOf, syncMainTitle } from "./missions-home";
import type { NoticePaseo } from "./notice-queue";
import { newestReportRecordOf, reportPhaseOf, storeAndDeliver } from "./outbox";
import { setAgentLabel, type PaseoCliDeps } from "./paseo-cli";
import { directoryIn, listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { isPluginHomeIn } from "./plugin-homes";
import { proposeMissionStart, takeProposedMissionStart } from "./proposed-mission-starts";
import { cutText } from "./request-render";
import { MISSION_CODE_LABEL } from "./role-title";
import { errorText } from "./rpc-kit";
import { actingTools, answered, boundAs, fixThese, refused, withoutNulls, type BoundCaller } from "./tool-kit";

/** The journal lines `bm_mission` shows (§4). */
export const MISSION_JOURNAL_SHOWN = 50;
/** How much of a request's newest report `bm_mission` shows. */
export const MISSION_REPORT_SHOWN = 1_500;

const NOTHING = "Nothing was changed.";
/** A caller that is not a bound Manager. */
export const MISSION_NOT_BOUND_MESSAGE = "The mission tools are only for a Main paseo-bm created with its own tools. Nothing was read or changed.";
/** A bound Manager that is not the current Main of a mission. */
export const NOT_A_MAIN_MESSAGE =
  "You are not the Main of a mission: a Main with no mission yet records the one the owner names with bm_mission_start. Nothing was read or changed.";
const NO_PASEO = "paseo-bm has no connection to Paseo yet; try again in a moment. Nothing was changed.";

const faceOf = (name: string): ToolFace => MISSION_TOOL_FACES.find((face) => face.name === name)!;

/**
 * The mission whose current Main `caller` is: its binding's, else the open
 * one naming it, else a closed one naming it (§2.3: the binding's is a cache).
 * Null for an agent that is no mission's current Main (a replaced one). Never throws.
 */
export function missionOfMain(home: string, caller: Pick<ToolCaller, "agentId" | "missionId">): Mission | null {
  if (caller.agentId === null) return null;
  try {
    const store = createMissionStore(home);
    const bound = caller.missionId == null ? null : store.get(caller.missionId);
    if (bound !== null && bound.mainId === caller.agentId) return bound;
    const entry = store.openByMain(caller.agentId) ?? store.list().find((candidate) => candidate.mainId === caller.agentId);
    return entry === undefined ? null : store.get(entry.missionId);
  } catch {
    return null;
  }
}

/**
 * The workspace ids of `given` (ids or absolute folders), or why each cannot
 * be in a charter (§3.3): not a listed, unarchived workspace, or a paseo-bm
 * home. Pure but for the home check.
 */
export function resolveRepos(given: readonly string[], listed: readonly ListedWorkspace[] | null, home: string, field: string): { ids: string[]; reasons: string[] } {
  if (listed === null) return { ids: [], reasons: ["Paseo's workspaces cannot be read right now; try again in a moment"] };
  const ids: string[] = [];
  const reasons: string[] = [];
  for (const repo of given) {
    const byFolder = (entry: ListedWorkspace) => isAbsolute(repo) && entry.directory !== null && resolve(entry.directory) === resolve(repo);
    const matches = listed.filter((entry) => entry.id === repo || byFolder(entry));
    const entry = matches.find((candidate) => !candidate.archived) ?? matches[0];
    if (entry === undefined) reasons.push(`${field}: ${repo} is not a workspace Paseo lists`);
    else if (entry.archived) reasons.push(`${field}: ${repo} is archived`);
    else if (isPluginHomeIn(entry.id, listed, home)) reasons.push(`${field}: ${repo} is a paseo-bm home, not a repository`);
    else if (!ids.includes(entry.id)) ids.push(entry.id);
  }
  return { ids, reasons };
}

/** `repo` as a workspace id: the listed workspace of that id or folder, else as given. Pure. */
function idOf(repo: string, listed: readonly ListedWorkspace[] | null): string {
  const entry = listed?.find((candidate) => candidate.id === repo || (isAbsolute(repo) && candidate.directory !== null && resolve(candidate.directory) === resolve(repo)));
  return entry?.id ?? repo;
}

/** The ids of the mission's requests whose Worker still runs (`runningRequestsOf`). */
const runningIdsOf = async (home: string, paseo: unknown, mission: Mission): Promise<string[]> =>
  (await runningRequestsOf(home, paseo, mission.missionId)).map((entry) => entry.requestId);

// ---------------------------------------------------------------------------
// Applying changes (pure).
// ---------------------------------------------------------------------------

/** What `bm_mission_update` writes at once. */
export interface FreeMissionUpdate {
  plan?: string;
  newCriteria: string[];
  statuses: Array<{ id: string; status: "open" | "met"; evidence: string | null }>;
  newContracts: Array<Pick<MissionContract, "title" | "providerRepo" | "consumerRepos" | "text" | "source">>;
  versions: Array<{ id: string; text: string; source: string; title?: string; providerRepo?: string; consumerRepos?: string[] }>;
  addRepos: string[];
}

const emptyFree = (): FreeMissionUpdate => ({ newCriteria: [], statuses: [], newContracts: [], versions: [], addRepos: [] });

const isEmptyFree = (free: FreeMissionUpdate): boolean =>
  free.plan === undefined && [free.newCriteria, free.statuses, free.newContracts, free.versions, free.addRepos].every((list) => list.length === 0);

/** The next free number of `D…` / `C…` ids. */
const nextNumber = (ids: readonly string[]): number => Math.max(0, ...ids.map((id) => Number(id.slice(1)))) + 1;

/** `mission` with the free update applied at `at`. Pure. */
export function applyFreeUpdate(mission: Mission, free: FreeMissionUpdate, at: string): Mission {
  const { charter } = mission;
  let next = nextNumber(charter.doneCriteria.map((criterion) => criterion.id));
  const doneCriteria = [
    ...charter.doneCriteria.map((criterion) => {
      const status = free.statuses.find((entry) => entry.id === criterion.id);
      return status === undefined ? criterion : { ...criterion, status: status.status, at, evidence: status.evidence ?? criterion.evidence };
    }),
    ...free.newCriteria.map((text) => ({ id: `D${next++}`, text, status: "open" as const, at: null, evidence: null })),
  ];
  let contractNumber = nextNumber(mission.contracts.map((contract) => contract.id));
  const contracts = [
    ...mission.contracts.map((contract) => {
      const version = free.versions.find((entry) => entry.id === contract.id);
      return version === undefined ? contract : { ...contract, ...version, version: contract.version + 1, updatedAt: at };
    }),
    ...free.newContracts.map((contract) => ({ ...contract, id: `C${contractNumber++}`, version: 1, updatedAt: at })),
  ];
  return {
    ...mission,
    charter: { ...charter, repos: [...new Set([...charter.repos, ...free.addRepos])], doneCriteria },
    plan: free.plan === undefined ? mission.plan : { text: free.plan, updatedAt: at },
    contracts,
  };
}

/** `mission` with the owner's change applied at `at`, or why it cannot be. Pure. */
export function applyMissionChange(mission: Mission, change: MissionChange, at: string): Mission | { reasons: string[] } {
  const reasons = (change.criteria ?? []).flatMap((entry) => (mission.charter.doneCriteria.some((criterion) => criterion.id === entry.id) ? [] : [`no criterion ${entry.id}`]));
  if (mission.state !== "open") reasons.push(`mission ${mission.code} is closed`);
  if (reasons.length > 0) return { reasons };
  const { charter } = mission;
  const removed = new Set(change.removeRepos ?? []);
  return {
    ...mission,
    ...(change.name === undefined ? {} : { name: change.name }),
    ...(change.code === undefined ? {} : { code: change.code }),
    ...(change.close === true ? { state: "closed" as const, closedAt: at } : {}),
    charter: {
      ...charter,
      ...(change.goal === undefined ? {} : { goal: change.goal }),
      ...(change.nonGoals === undefined ? {} : { nonGoals: change.nonGoals }),
      ...(change.budget === undefined ? {} : { budget: change.budget }),
      ...(change.confirmCharter === true ? { confirmedAt: at } : {}),
      repos: [...new Set([...charter.repos, ...(change.addRepos ?? [])])].filter((repo) => !removed.has(repo)),
      doneCriteria: charter.doneCriteria.map((criterion) => {
        const entry = change.criteria?.find((candidate) => candidate.id === criterion.id);
        if (entry === undefined) return criterion;
        return { ...criterion, ...(entry.text === undefined ? {} : { text: entry.text }), ...(entry.status === undefined ? {} : { status: entry.status, at }) };
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// The owner's card (§4.1).
// ---------------------------------------------------------------------------

/** The `m:` decision that asks the owner for `change`. Pure. */
export function missionCardOf(mission: Mission, change: MissionChange, input: { id: string; mainId: string; at: string }): Decision {
  const action: MissionChangeAction = { kind: "mission-change", missionId: mission.missionId, change };
  const lines = missionChangeLinesOf(change).map((line) => `- ${line}`);
  return {
    id: input.id,
    workspaceId: mission.missionId,
    requestId: null,
    askedBy: { role: "plugin", agentId: input.mainId },
    askedAt: input.at,
    round: null,
    question: cutText([`Mission ${mission.code} (${mission.name}): its Main asks to`, ...lines].join("\n"), 1_000),
    subject: null,
    class: "scope",
    options: [
      { key: "apply", label: "Apply the change", recommended: false, effects: [], action },
      { key: "keep", label: "Keep as is", recommended: false, effects: [] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
  };
}

/** The mission change the chosen option of an `m:` decision carries, or null (keep as is, words, any other decision). Pure. */
export function chosenMissionChange(decision: Decision, optionKey: string | null): MissionChangeAction | null {
  const action = decision.options.find((option) => option.key === optionKey)?.action;
  return action?.kind === "mission-change" ? action : null;
}

/**
 * Why the owner's answer `optionKey` on an `m:` decision cannot be applied
 * now (checked before the answer is written, so a refusal writes nothing):
 * the mission is gone or closed, the code is taken, a repo to add is no
 * longer a listed project, `close` while a Worker of the mission runs, an
 * unknown criterion. None for an option without a change. Never throws.
 */
export async function missionAnswerRefusalsOf(decision: Decision, optionKey: string | null, paseo: unknown, home: string): Promise<string[]> {
  const action = chosenMissionChange(decision, optionKey);
  if (action === null) return [];
  return missionChangeRefusalsOf(action.missionId, action.change, paseo, home);
}

/**
 * Why the owner's `change` of mission `missionId` cannot be applied now
 * (`missionAnswerRefusalsOf`'s checks; the Missions screen's `mission.change`
 * takes them too, missions design §10.4). Never throws.
 */
export async function missionChangeRefusalsOf(missionId: string, change: MissionChange, paseo: unknown, home: string): Promise<string[]> {
  try {
    const mission = createMissionStore(home).get(missionId);
    if (mission === null) return [`mission ${missionId} no longer exists`];
    const applied = applyMissionChange(mission, change, new Date(0).toISOString());
    const reasons = "reasons" in applied ? [...applied.reasons] : [];
    const taken = change.code === undefined ? null : createMissionStore(home).codeTakenBy(change.code, mission.missionId);
    if (taken !== null) reasons.push(`code ${change.code} is taken by the open mission ${taken.name}`);
    const adding = change.addRepos ?? [];
    if (adding.length > 0 || change.close === true) {
      if (paseo === null || paseo === undefined) return [...reasons, "paseo-bm has no connection to Paseo yet; try again in a moment"];
      if (adding.length > 0) reasons.push(...resolveRepos(adding, await listedWorkspaces(paseo as DashboardPaseo), home, "repo").reasons);
      const running = change.close === true ? await runningIdsOf(home, paseo, mission) : [];
      if (running.length > 0) reasons.push(`a Worker of mission ${mission.code} still runs (${running.join(", ")}); it can be closed once they finish`);
    }
    return reasons;
  } catch (error) {
    return [`the mission cannot be read: ${errorText(error)}`];
  }
}

export interface MissionAnswerDeps {
  home: string;
  now: Date;
  log: (message: string) => void;
  cli?: PaseoCliDeps;
  /** The RPC's Paseo handle, for telling the Main; the notice queue's last one when absent. */
  paseo?: unknown;
}

/**
 * Tells the mission's current Main what the owner decided on its card: a
 * `message` record from `from` (`owner` by default; the governor's splits and
 * arbitrations, §9.6, pass `orchestrator`) in the Main's workspace's outbox
 * (its binding's, else the Missions home), delivered as `BM-DELIVERY
 * message`. A mission with no Main, or no workspace to store in, is one log
 * line. Never throws.
 */
export async function tellMain(missionId: string, decisionId: string, text: string, deps: MissionAnswerDeps, from = "owner"): Promise<void> {
  try {
    const mainId = createMissionStore(deps.home).get(missionId)?.mainId ?? null;
    const bound = mainId === null ? undefined : createBindingStore(deps.home, { log: deps.log }).list().find((binding) => binding.agentId === mainId);
    const workspaceId = bound?.workspaceId ?? missionsHomeIdOf(deps.home);
    if (mainId === null || workspaceId === null) return deps.log(`[paseo-bm] the Main of mission ${missionId} could not be told of ${decisionId}: it has no Main or workspace now.`);
    await storeAndDeliver(
      workspaceId,
      { kind: "message", requestId: decisionId, from, to: mainId, text: `${text}\nbm_mission shows the mission as it stands.` },
      { home: deps.home, log: deps.log, now: () => deps.now, ...(deps.paseo === undefined || deps.paseo === null ? {} : { paseo: deps.paseo as NoticePaseo }) },
    );
  } catch (error) {
    deps.log(`[paseo-bm] the Main of mission ${missionId} could not be told of ${decisionId}: ${errorText(error)}`);
  }
}

/**
 * After the owner's answer on an `m:` decision is recorded: applies the
 * change of the option they chose (only the owner's answer applies one),
 * adds the journal line, retitles and relabels the Main after a new name or
 * code, and tells the Main what the owner decided (`tellMain`). Keep as is,
 * or words, only adds the journal line and tells the Main. Never throws.
 */
export async function applyMissionDecision(decision: Decision, deps: MissionAnswerDeps): Promise<void> {
  const missionId = missionOfDecisionId(decision.id);
  const answer = decision.answer;
  if (missionId === null || answer === null || decision.status !== "answered") return;
  try {
    const store = createMissionStore(deps.home, { now: () => deps.now });
    const action = answer.by === "owner" ? chosenMissionChange(decision, answer.optionKey) : null;
    if (action === null) {
      const how = answer.optionKey === null ? `answered in words: ${answer.words ?? ""}` : "kept the mission as it is";
      journalQuietly(store, missionId, { kind: "decision", by: "owner", text: `The owner ${how} (${decision.id}).`, ref: decision.id }, deps.log);
      await tellMain(missionId, decision.id, `The owner ${how} on your card ${decision.id}.`, deps);
      return;
    }
    const at = deps.now.toISOString();
    const result = store.update(missionId, (mission) => applyMissionChange(mission, action.change, at));
    if (!result.ok) {
      deps.log(`[paseo-bm] the owner chose to apply ${decision.id}, but it could not be applied: ${result.reasons.join("; ")}`);
      journalQuietly(store, missionId, { kind: "decision", by: "plugin", text: `${decision.id} could not be applied: ${result.reasons.join("; ")}`, ref: decision.id }, deps.log);
      await tellMain(missionId, decision.id, `The owner chose to apply your card ${decision.id}, but it could not be applied: ${result.reasons.join("; ")}.`, deps);
      return;
    }
    const lines = missionChangeLinesOf(action.change).join("; ");
    journalQuietly(store, missionId, { kind: "charter", by: "owner", text: `The owner applied ${decision.id}: ${lines}.`, ref: decision.id }, deps.log);
    await tellMain(missionId, decision.id, `The owner applied your card ${decision.id}: ${lines}.`, deps);
    await syncMainAfterChange(result.mission, action.change, deps);
  } catch (error) {
    deps.log(`[paseo-bm] applying ${decision.id} failed: ${errorText(error)}`);
  }
}

/**
 * After the owner's applied `change` (an `m:` card's, or the Missions
 * screen's `mission.change`): the Main is retitled after a new name or code
 * and its `bm.missionCode` label set after a new code. Each failure is one
 * log line. Never throws.
 */
export async function syncMainAfterChange(mission: Mission, change: MissionChange, deps: Pick<MissionAnswerDeps, "log" | "cli">): Promise<void> {
  if ((change.name === undefined && change.code === undefined) || mission.mainId === null) return;
  const titled = await syncMainTitle(mission, deps.cli);
  if (!titled.ok) deps.log(`[paseo-bm] the Main of mission ${mission.code} could not be retitled: ${titled.reason}`);
  if (change.code !== undefined) {
    const labelled = await setAgentLabel(mission.mainId, MISSION_CODE_LABEL, mission.code, deps.cli).catch((error: unknown) => ({ ok: false as const, reason: errorText(error) }));
    if (!labelled.ok) deps.log(`[paseo-bm] the Main of mission ${mission.code} could not be relabelled: ${labelled.reason}`);
  }
}

// ---------------------------------------------------------------------------
// bm_mission_start, settled at the turn's end.
// ---------------------------------------------------------------------------

export interface SettleDeps {
  home: string;
  log: (message: string) => void;
  now?: () => Date;
  cli?: PaseoCliDeps;
}

/**
 * The end of a Main's turn (the decision materialiser): the mission it
 * proposed in that turn with `bm_mission_start` is recorded only when
 * `ownerTyped` (the turn holds the owner's own message), and dropped
 * otherwise. Recorded: the mission (`createdBy: owner`, this Main), a journal
 * line, the binding's mission, the labels and the title. Returns the new
 * mission's id, or null. Never throws.
 */
export async function settleMissionStart(mainId: string, turnStartedAt: string | null, ownerTyped: boolean, deps: SettleDeps): Promise<string | null> {
  const proposal = takeProposedMissionStart(mainId, turnStartedAt);
  if (proposal === null) return null;
  const { log } = deps;
  if (!ownerTyped) {
    log(`[paseo-bm] the mission ${proposal.code} Main ${mainId} proposed was not recorded: its turn holds no message of the owner's.`);
    return null;
  }
  try {
    const store = createMissionStore(deps.home, deps.now === undefined ? {} : { now: deps.now });
    const own = missionOfMain(deps.home, { agentId: mainId, missionId: null });
    if (own !== null) {
      log(`[paseo-bm] the mission ${proposal.code} Main ${mainId} proposed was not recorded: it is the Main of mission ${own.code} already.`);
      return null;
    }
    const created = store.create({ ...proposal, createdBy: "owner", mainId });
    if (!created.ok) {
      log(`[paseo-bm] the mission ${proposal.code} Main ${mainId} proposed was not recorded: ${created.reasons.join("; ")}`);
      return null;
    }
    const mission = created.mission;
    const text = `Mission ${mission.code} "${mission.name}" started with Main ${mainId}; repos ${mission.charter.repos.join(", ")}.`;
    journalQuietly(store, mission.missionId, { kind: "charter", by: "owner", text, ref: mainId }, log);
    const bound = await markMain(mainId, mission, { bindings: createBindingStore(deps.home, { log }), cli: deps.cli, log });
    if (!bound) log(`[paseo-bm] the binding of Main ${mainId} could not record mission ${mission.code}.`);
    return mission.missionId;
  } catch (error) {
    log(`[paseo-bm] recording the mission ${proposal.code} Main ${mainId} proposed failed: ${errorText(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

export interface MissionToolDeps {
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's). */
  home: () => string;
  log: (message: string) => void;
  now?: () => Date;
  /** The start of a Main's running turn (`currentTurnStartOf`, the collector's start mark). */
  turnStartOf?: (agentId: string) => string | null;
  /** Where `bm_answer_worker`'s answers go: the delivery the owner's answers take (`settledByKind`). None: only stored. */
  onSettled?: OnDecisionsSettled;
}

interface AnswerWorkerInput {
  requestId: string;
  answers: Array<{ qn: string; option: string; why: string }>;
}

interface StartInput {
  name: string;
  code: string;
  goal: string;
  repos: string[];
}

interface UpdateInput {
  name?: string;
  code?: string;
  goal?: string;
  nonGoals?: string[];
  doneCriteria?: Array<{ id?: string; text?: string; status?: "open" | "met" | "dropped"; evidence?: string }>;
  budget?: { requests?: number; workers?: number; reviewCalls?: number; days?: number };
  plan?: string;
  contracts?: Array<{ id?: string; title?: string; providerRepo?: string; consumerRepos?: string[]; text: string; source: string }>;
  repos?: { add?: string[]; remove?: string[] };
  confirmCharter?: boolean;
  close?: boolean;
}

/** The bound Manager's mission tools (§4), as server-run tools the endpoint composes with its others. Never throws. */
export function createMissionTools(deps: MissionToolDeps): ServerTools {
  const now = deps.now ?? (() => new Date());
  const { log } = deps;

  /** The caller as a Main, or its refusal. */
  const mainOf = (caller: ToolCaller | null): { main: BoundCaller; mission: Mission | null } | ServerToolAnswer => {
    const main = boundAs(caller, "manager");
    if (main === null) return refused(MISSION_NOT_BOUND_MESSAGE);
    return { main, mission: missionOfMain(deps.home(), main) };
  };

  const read = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const found = mainOf(caller);
    if ("ok" in found) return found;
    const issues = schemaIssues(faceOf("bm_mission").inputSchema, withoutNulls(raw ?? {}));
    if (issues.length > 0) return fixThese("bm_mission", issues);
    const { mission } = found;
    if (mission === null) return refused(NOT_A_MAIN_MESSAGE);
    const home = deps.home();
    const paseo = deps.paseo();
    const listed = paseo === null || paseo === undefined ? null : await listedWorkspaces(paseo as DashboardPaseo).catch(() => null);
    const folderOf = (workspaceId: string) => directoryIn(listed, workspaceId);
    const decisions = createDecisionStore(home, { log });
    const summary = (decision: Decision) => decisionSummaryOf(decision, process.env, { grant: false });
    const requests = createMissionRoster(home)
      .list(mission.missionId)
      .map((entry) => {
        const workerId = entry.workerIds.at(-1) ?? null;
        const report = workerId === null ? null : newestReportRecordOf(home, entry.workspaceId, workerId);
        return {
          requestId: entry.requestId,
          repo: { workspaceId: entry.workspaceId, folder: folderOf(entry.workspaceId) },
          topic: entry.topic,
          state: entry.state,
          workerId,
          phase: report === null ? null : reportPhaseOf(report.text),
          report: report === null ? null : { at: report.createdAt, text: cutText(report.text, MISSION_REPORT_SHOWN) },
          openQuestions: decisions.list({ workspaceId: entry.workspaceId, requestId: entry.requestId, statuses: UNSETTLED_STATUSES }).map(summary),
        };
      });
    const autonomy = createMissionAutonomyStore(home).get(mission.missionId);
    const delegated = MISSION_CLASSES.filter((name) => autonomy.cells[name].mode === "delegate");
    return answered({
      mission: { missionId: mission.missionId, code: mission.code, name: mission.name, state: mission.state, createdAt: mission.createdAt, closedAt: mission.closedAt },
      charter: { ...mission.charter, repos: mission.charter.repos.map((workspaceId) => ({ workspaceId, folder: folderOf(workspaceId) })) },
      plan: mission.plan,
      contracts: mission.contracts,
      requests,
      ownerCards: createMissionDecisionStore(home).list(mission.missionId, UNSETTLED_STATUSES).map(summary),
      level: { level: autonomy.level, delegated, owner: MISSION_CLASSES.filter((name) => !delegated.includes(name)) },
      journal: createMissionStore(home).journal(mission.missionId, MISSION_JOURNAL_SHOWN),
    });
  };

  const start = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const found = mainOf(caller);
    if ("ok" in found) return found;
    const input = withoutNulls(raw ?? {}) as StartInput;
    const issues = schemaIssues(faceOf("bm_mission_start").inputSchema, input);
    if (issues.length > 0) return fixThese("bm_mission_start", issues);
    const { main, mission } = found;
    const home = deps.home();
    const nothing = "Nothing was recorded.";
    if (mission !== null || (main.missionId ?? null) !== null) {
      return refused(`You are the Main of mission ${mission?.code ?? main.missionId} already: change it with bm_mission_update. ${nothing}`);
    }
    if (!isMissionsHome(main.workspaceId, home)) return refused(`bm_mission_start is for a Main in the Missions home with no mission yet; you work in a project's workspace. ${nothing}`);
    const paseo = deps.paseo();
    if (paseo === null || paseo === undefined) return refused(NO_PASEO);
    const reasons: string[] = [];
    const taken = createMissionStore(home).codeTakenBy(input.code);
    if (taken !== null) reasons.push(`input.code: ${input.code} is taken by the open mission ${taken.name}; ask the owner for another`);
    const repos = resolveRepos(input.repos, await listedWorkspaces(paseo as DashboardPaseo), home, "input.repos");
    reasons.push(...repos.reasons);
    if (reasons.length > 0) return fixThese("bm_mission_start", reasons);
    const turnStartedAt = (deps.turnStartOf ?? (() => null))(main.agentId);
    if (turnStartedAt === null) {
      return refused(`paseo-bm cannot tie this mission to your current turn (it may have reloaded during it); call bm_mission_start again in the turn of the owner's next message. ${nothing}`);
    }
    proposeMissionStart(main.agentId, turnStartedAt, { code: input.code, name: input.name.trim(), goal: input.goal.trim(), repos: repos.ids });
    return answered({
      proposed: { code: input.code, name: input.name.trim(), repos: repos.ids },
      recorded: "when this turn ends, only if it holds the owner's own message; then you are the mission's Main",
    });
  };

  const update = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const found = mainOf(caller);
    if ("ok" in found) return found;
    const input = withoutNulls(raw ?? {}) as UpdateInput;
    const issues = schemaIssues(faceOf("bm_mission_update").inputSchema, input);
    if (issues.length > 0) return fixThese("bm_mission_update", issues);
    const { main, mission } = found;
    if (mission === null) return refused(NOT_A_MAIN_MESSAGE);
    if (mission.state !== "open") return refused(`Mission ${mission.code} is closed. ${NOTHING}`);
    const home = deps.home();
    const { charter } = mission;
    const free = emptyFree();
    const card: MissionChange = {};
    const reasons: string[] = [];

    if (input.name !== undefined && input.name.trim() !== mission.name) card.name = input.name.trim();
    if (input.code !== undefined && input.code !== mission.code) {
      const taken = createMissionStore(home).codeTakenBy(input.code, mission.missionId);
      if (taken !== null) reasons.push(`input.code: ${input.code} is taken by the open mission ${taken.name}`);
      card.code = input.code;
    }
    if (input.goal !== undefined && input.goal.trim() !== charter.goal) card.goal = input.goal.trim();
    if (input.nonGoals !== undefined && JSON.stringify(input.nonGoals) !== JSON.stringify(charter.nonGoals)) card.nonGoals = input.nonGoals;
    if (input.budget !== undefined) {
      const { requests = null, workers = null, reviewCalls = null, days = null } = input.budget;
      const budget = [requests, workers, reviewCalls, days].every((value) => value === null) ? null : { requests, workers, reviewCalls, days };
      if (JSON.stringify(budget) !== JSON.stringify(charter.budget)) card.budget = budget;
    }
    if (input.confirmCharter === true) card.confirmCharter = true;
    if (input.plan !== undefined && input.plan !== mission.plan.text) free.plan = input.plan;

    // Repos: listed to add; in the scope to remove.
    const paseo = deps.paseo();
    const connected = paseo !== null && paseo !== undefined;
    if (!connected && ((input.repos?.add ?? []).length > 0 || input.close === true)) return refused(NO_PASEO);
    const listed = connected ? await listedWorkspaces(paseo as DashboardPaseo) : null;
    if (input.repos?.add !== undefined) {
      const added = resolveRepos(input.repos.add, listed, home, "input.repos.add");
      reasons.push(...added.reasons);
      const fresh = added.ids.filter((id) => !charter.repos.includes(id));
      if (fresh.length > 0) {
        if (createMissionAutonomyStore(home).isDelegated(mission.missionId, "scope-repo")) free.addRepos = fresh;
        else card.addRepos = fresh;
      }
    }
    if (input.repos?.remove !== undefined) {
      const removed = input.repos.remove.map((repo) => idOf(repo, listed));
      removed.forEach((id, index) => {
        if (!charter.repos.includes(id)) reasons.push(`input.repos.remove[${index}]: ${input.repos!.remove![index]} is not a repo of mission ${mission.code}`);
      });
      if (removed.some((id) => charter.repos.includes(id))) card.removeRepos = [...new Set(removed.filter((id) => charter.repos.includes(id)))];
    }
    if (input.close === true) {
      const running = await runningIdsOf(home, paseo, mission);
      if (running.length > 0) reasons.push(`input.close: a Worker of mission ${mission.code} still runs (${running.join(", ")}); close the mission once they finish`);
      card.close = true;
    }

    // Done criteria: new ones and a status are free; a new text, a drop or a restore is the owner's.
    const criteria: NonNullable<MissionChange["criteria"]> = [];
    (input.doneCriteria ?? []).forEach((entry, index) => {
      const at = `input.doneCriteria[${index}]`;
      if (entry.id === undefined) {
        if (entry.text === undefined) reasons.push(`${at}.text: a new criterion needs its text`);
        else if ((entry.status ?? "open") !== "open" || entry.evidence !== undefined) reasons.push(`${at}: a new criterion starts open, without evidence`);
        else free.newCriteria.push(entry.text.trim());
        return;
      }
      const criterion = charter.doneCriteria.find((candidate) => candidate.id === entry.id);
      if (criterion === undefined) return void reasons.push(`${at}.id: no criterion ${entry.id} (bm_mission lists them)`);
      if (entry.text === undefined && entry.status === undefined) return void reasons.push(`${at}: give its new text or its status`);
      const owner: NonNullable<MissionChange["criteria"]>[number] = { id: criterion.id };
      if (entry.text !== undefined && entry.text.trim() !== criterion.text) owner.text = entry.text.trim();
      if (entry.status === "dropped" && criterion.status !== "dropped") owner.status = "dropped";
      else if (entry.status !== undefined && entry.status !== "dropped" && criterion.status === "dropped") {
        if (entry.status === "met") reasons.push(`${at}.status: ${criterion.id} is dropped; restore it (status open) first`);
        else owner.status = "open";
      } else if (entry.status === "met" || entry.status === "open") {
        if (entry.status === "met" && entry.evidence === undefined) reasons.push(`${at}.evidence: a met criterion needs its evidence`);
        else if (entry.status !== criterion.status || entry.evidence !== undefined) free.statuses.push({ id: criterion.id, status: entry.status, evidence: entry.evidence ?? null });
      }
      if (owner.text !== undefined || owner.status !== undefined) criteria.push(owner);
    });
    if (criteria.length > 0) card.criteria = criteria;

    // Contracts: free, a new one or a new version.
    (input.contracts ?? []).forEach((entry, index) => {
      const at = `input.contracts[${index}]`;
      const repos = { ...(entry.providerRepo === undefined ? {} : { providerRepo: idOf(entry.providerRepo, listed) }), ...(entry.consumerRepos === undefined ? {} : { consumerRepos: entry.consumerRepos.map((repo) => idOf(repo, listed)) }) };
      if (entry.id === undefined) {
        if (entry.title === undefined || entry.providerRepo === undefined) return void reasons.push(`${at}: a new contract needs its title and providerRepo`);
        free.newContracts.push({ title: entry.title, providerRepo: repos.providerRepo!, consumerRepos: repos.consumerRepos ?? [], text: entry.text, source: entry.source });
        return;
      }
      if (!mission.contracts.some((contract) => contract.id === entry.id)) return void reasons.push(`${at}.id: no contract ${entry.id} (bm_mission lists them)`);
      free.versions.push({ id: entry.id, text: entry.text, source: entry.source, ...(entry.title === undefined ? {} : { title: entry.title }), ...repos });
    });

    if (reasons.length > 0) return fixThese("bm_mission_update", reasons);
    if (isEmptyFree(free) && isEmptyMissionChange(card)) return refused(`Nothing to change: what you gave is what mission ${mission.code} holds already. ${NOTHING}`);

    const at = now().toISOString();
    const store = createMissionStore(home, { now });
    const applied: string[] = [];
    if (!isEmptyFree(free)) {
      const written = store.update(mission.missionId, (current) => applyFreeUpdate(current, free, at));
      if (!written.ok) return fixThese("bm_mission_update", written.reasons);
      const journal = (kind: "plan" | "criterion" | "contract" | "charter", text: string) => {
        applied.push(text);
        journalQuietly(store, mission.missionId, { kind, by: "main", text, ref: main.agentId }, log);
      };
      if (free.plan !== undefined) journal("plan", "The Main rewrote the plan.");
      const newIds = written.mission.charter.doneCriteria.slice(charter.doneCriteria.length).map((criterion) => criterion.id);
      if (newIds.length > 0) journal("criterion", `The Main added the done criteria ${newIds.join(", ")}.`);
      for (const status of free.statuses) journal("criterion", `${status.id} is ${status.status}${status.evidence === null ? "" : `: ${status.evidence}`}.`);
      const newContracts = written.mission.contracts.slice(mission.contracts.length).map((contract) => contract.id);
      if (newContracts.length > 0) journal("contract", `The Main added the contracts ${newContracts.join(", ")}.`);
      for (const version of free.versions) journal("contract", `The Main wrote a new version of ${version.id} (source: ${version.source}).`);
      if (free.addRepos.length > 0) journal("charter", `The Main added the repos ${free.addRepos.join(", ")} (scope-repo is delegated).`);
    }
    let decisionId: string | null = null;
    if (!isEmptyMissionChange(card)) {
      const decisions = createMissionDecisionStore(home);
      const opened = decisions.open(missionCardOf(mission, card, { id: decisions.nextId(mission.missionId), mainId: main.agentId, at }));
      decisionId = opened.decision.id;
      journalQuietly(store, mission.missionId, { kind: "decision", by: "main", text: `The Main asked the owner to ${missionChangeLinesOf(card).join("; ")} (${decisionId}).`, ref: decisionId }, log);
    }
    return answered({
      applied,
      decisionId,
      ...(decisionId === null ? {} : { owner: `The owner applies ${decisionId} or keeps the mission as it is, on its card; bm_mission shows what stands.` }),
    });
  };

  /**
   * `bm_answer_worker` (§4, §8): every answer is checked on the decision as
   * read — open, an option without a grant or change, asked within
   * `MAIN_ANSWER_MINUTES`, allowed by `mainAnswerRuleOf` — and any refusal
   * writes nothing; then each is written in one transition that checks again.
   * From the reads to the writes nothing awaits.
   */
  const answerWorker = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const found = mainOf(caller);
    if ("ok" in found) return found;
    const input = withoutNulls(raw ?? {}) as AnswerWorkerInput;
    const issues = schemaIssues(faceOf("bm_answer_worker").inputSchema, input);
    if (issues.length > 0) return fixThese("bm_answer_worker", issues);
    const { main, mission } = found;
    if (mission === null) return refused(NOT_A_MAIN_MESSAGE);
    const home = deps.home();
    const place = requestIndexOf(home, input.requestId);
    if (place === null || place.missionId !== mission.missionId) return refused(`Request ${input.requestId} is not one of mission ${mission.code} (bm_mission lists them). ${NOTHING}`);
    const store = createDecisionStore(home, { log });
    const level = createMissionAutonomyStore(home);
    const policy = currentPolicy(home, (why) => log(`[paseo-bm] could not read the autonomy policy for bm_answer_worker: ${why}`));
    const at = now();
    const reasonOf = (why: string) => redactText(why, process.env).replace(/\s+/g, " ").trim();
    const ruleOf = (decision: Decision, option: string): { rule: "answer" | "predict" } | { refusal: string } => {
      const qn = decision.id.slice(decision.id.lastIndexOf(":") + 1);
      const notOpen = notOpenRefusalOf(decision, {
        needsConfirmation: `${qn} waits for the owner to confirm an answer typed in a chat; it is the owner's`,
        answered: (by, when) => `${qn} was already answered by ${by} at ${when} (${decision.answer?.optionKey ?? "in words"}); the first answer stands`,
        superseded: (by) => `${qn} is superseded by ${by}; answer that one if it is still open`,
        closed: (status) => `${qn} is ${status}; it can no longer be answered`,
      });
      if (notOpen !== null) return { refusal: notOpen };
      const chosen = decision.options.find((entry) => entry.key === option);
      if (chosen === undefined) return { refusal: `${qn} has no option ${option}; its options are ${decision.options.map((entry) => entry.key).join(", ")}` };
      if (chosen.grant !== undefined || isPreparedChange(chosen.action)) return { refusal: `option ${option} of ${qn} carries a grant or a change: only the owner chooses it` };
      if (at.getTime() - Date.parse(decision.askedAt) > MAIN_ANSWER_MINUTES * 60_000) {
        return { refusal: `${qn} was asked more than ${MAIN_ANSWER_MINUTES} minutes ago: it is the owner's now, on its card` };
      }
      const rule = mainAnswerRuleOf(policy, decision, (name) => level.isDelegated(mission.missionId, name));
      if ("rule" in rule && rule.rule === "predict" && (decision.prediction?.main ?? null) !== null) return { refusal: `you recommended an option for ${qn} already; the owner decides it` };
      return rule;
    };

    const reasons: string[] = [];
    const seen = new Set<string>();
    input.answers.forEach((entry, index) => {
      const decision = store.get(questionDecisionId(input.requestId, entry.qn), place.workspaceId);
      const rule = seen.has(entry.qn) ? { refusal: `${entry.qn} is answered twice` } : decision === null ? { refusal: `${entry.qn} is not a question of ${input.requestId}` } : ruleOf(decision, entry.option);
      seen.add(entry.qn);
      if ("refusal" in rule) reasons.push(`input.answers[${index}]: ${rule.refusal}`);
      else if (reasonOf(entry.why) === "") reasons.push(`input.answers[${index}].why: give your reason in one line`);
    });
    if (reasons.length > 0) return fixThese("bm_answer_worker", reasons);

    const iso = at.toISOString();
    const answeredNow: Decision[] = [];
    const results: Array<{ qn: string; decisionId: string; state: "answered" | "recommended" }> = [];
    for (const entry of input.answers) {
      const id = questionDecisionId(input.requestId, entry.qn);
      const reason = reasonOf(entry.why);
      let state: "answered" | "recommended" = "answered";
      const mutation = store.transition(
        id,
        (current): TransitionResult => {
          const rule = ruleOf(current, entry.option);
          if ("refusal" in rule) return { ok: false, refusal: "invalid-answer", message: rule.refusal };
          if (rule.rule === "answer") return answerDecision(current, { by: "main", via: "main", optionKey: entry.option, class: decisionClassOf(current), reason, at: iso });
          state = "recommended";
          const prediction = { recommended: current.prediction?.recommended ?? null, orchestrator: current.prediction?.orchestrator ?? null, main: { optionKey: entry.option, reason, at: iso } };
          return { ok: true, decision: { ...current, prediction } };
        },
        place.workspaceId,
      );
      if (mutation.status !== "updated") {
        log(`[paseo-bm] Main ${main.agentId}'s answer to ${id} was not recorded: ${mutation.status === "refused" ? mutation.message : "no such decision"}`);
        continue;
      }
      if (state === "answered") answeredNow.push(mutation.decision);
      results.push({ qn: entry.qn, decisionId: id, state });
    }
    if (results.length > 0) {
      const text = results.map((result) => `${result.state === "answered" ? "answered" : "recommended an option for"} ${result.qn}`).join(", ");
      journalQuietly(createMissionStore(home, { now }), mission.missionId, { kind: "decision", by: "main", text: `The Main ${text} of request ${input.requestId}.`, ref: input.requestId }, log);
    }
    if (answeredNow.length > 0 && deps.onSettled !== undefined) {
      try {
        await deps.onSettled(answeredNow, { paseo: deps.paseo() });
      } catch (error) {
        log(`[paseo-bm] ${answeredNow.map((decision) => decision.id).join(", ")} answered by Main ${main.agentId}, but the delivery failed: ${errorText(error)}`);
      }
    }
    return answered(
      results.map((result) => ({
        ...result,
        said: result.state === "answered" ? "delivered to the Worker as your answer, not the owner's; it grants nothing" : "recorded as your recommendation; the owner decides it",
      })),
    );
  };

  return actingTools(MISSION_TOOL_FACES, { bm_mission: read, bm_mission_start: start, bm_mission_update: update, bm_answer_worker: answerWorker }, NOTHING);
}
