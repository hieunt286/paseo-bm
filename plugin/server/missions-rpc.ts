/**
 * The Missions screen's RPCs (missions design §10.2, §10.4; REQ-196).
 *
 * - `missions.list {}` → every mission's summary, open first (newest
 *   `createdAt` first), then closed (newest `closedAt` first).
 * - `mission.get { missionId }` → one mission's page: its summary (each repo
 *   with a worktree carrying its `placement`, delivery line design §4.9),
 *   charter, every governor family, one row per roster request, its
 *   contracts, the newest `MISSION_PAGE_JOURNAL` journal lines (newest first)
 *   and its plan.
 * - `mission.change { missionId, name?, code?, addRepos?, close? }` → the
 *   owner's own change, applied at once on the `m:` card's path
 *   (`mission-tools.ts`): the card's checks (`missionChangeRefusalsOf`),
 *   `applyMissionChange`, a `charter` journal line by `owner`, the Main told
 *   (`tellMain`), retitled and relabelled (`syncMainAfterChange`).
 * - `mission.integration.revoke { missionId, repo }` → the owner's revoke of
 *   the mission's integration grant for a repo (delivery line design §4.3,
 *   `integration-grant.ts`).
 * - `mission.integration.ask { missionId, repo }` → the owner's "Ask me
 *   again": a fresh integration card for the repo (§4.3).
 * - `memory.list { workspaceId }` → one repository's active project memory,
 *   newest first, at most `MEMORY_LIST_LIMIT`.
 *
 * What a summary reads: the mission (`mission-store.ts`), its roster
 * (`mission-roster.ts`), its level (`mission-autonomy-store.ts`), its Main's
 * Paseo status and its live Workers (one `agents.list` walk), the open `q:`
 * decisions of its requests (the Inbox's own listing: unsettled, in each
 * request's repo) and its open `m:` cards, and — for an open mission — the
 * governor's figures now (`governor-figures.ts`) with each family's ladder
 * state (`governor-store.ts`). The governor watches open missions only: a
 * closed mission's families read as quiet. Repositories are named as the
 * Orchestrator names projects (`workspaceLabelOf`).
 *
 * Every handler only reads, except `mission.change`,
 * `mission.integration.revoke` and `mission.integration.ask`, and none creates or messages an agent but
 * through `tellMain` and the revoke's `BM-SETTINGS`. A refusal, and an unknown
 * mission, is `E_MISSION_INVALID` with its reasons; any other failure is a
 * coded error, never a bare one.
 */
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DashboardError,
  memoryListRpc,
  missionChangeRpc,
  missionGetRpc,
  missionIntegrationAskRpc,
  missionIntegrationRevokeRpc,
  missionsListRpc,
  type MemoryListOutput,
  type MissionChangeInput,
  type MissionChangeOutput,
  type MissionGetOutput,
  type MissionIntegrationAskInput,
  type MissionIntegrationAskOutput,
  type MissionIntegrationRevokeInput,
  type MissionIntegrationRevokeOutput,
  type MissionPlacement,
  type MissionRow,
  type MissionSignal,
  type MissionSummary,
  type MissionsListOutput,
} from "../shared/contracts";
import type { CoordinationSettings } from "../shared/coordination";
import { UNSETTLED_STATUSES, type Decision } from "../shared/decisions";
import { isEmptyMissionChange, missionChangeLinesOf, type MissionChange } from "../shared/mission-change";
import { timeOrZero } from "../shared/time";
import { readCoordinationSettings } from "./coordination-rpc";
import { askIntegrationAgain, isIntegrationCard, revokeIntegration } from "./integration-grant";
import { TRACES_DIR_NAME } from "./data-home";
import { createDecisionStore } from "./decision-store";
import { GOVERNOR_FAMILIES, governorFiguresOf, liveWorkersOf, readGovernorSnapshot, type GovernorFigure, type ListedAgent } from "./governor-figures";
import { createGovernorStore, type MissionLadder } from "./governor-store";
import { createMemoryStore } from "./memory-store";
import { createPrecedentStore } from "./precedent-store";
import { PRECEDENT_SCOPE_ALL } from "../shared/precedents";
import { MISSION_CLASSES, createMissionAutonomyStore } from "./mission-autonomy-store";
import { createMissionDecisionStore } from "./mission-decisions";
import { createMissionRoster, stopActiveRequests, type RosterEntry } from "./mission-roster";
import { offerMerges } from "./mission-ownership";
import { MISSION_CODE_PATTERN, createMissionStore, journalQuietly, type Mission, type Placement } from "./mission-store";
import { missionStateOf } from "./mission-state";
import type { MissionState } from "../shared/mission-state";
import { openArchiveCards, retitlePlacements } from "./placement-create";
import { applyMissionChange, missionChangeRefusalsOf, syncMainAfterChange, tellMain } from "./mission-tools";
import { missionInvalid } from "./missions-home";
import { workspaceLabelOf } from "./orchestrator-state";
import { newestReportRecordOf, reportPhaseOf } from "./outbox";
import type { PaseoCliDeps } from "./paseo-cli";
import { bmAgentsOf, listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { createPeerLinkStore, isLiveLink } from "./peer-links";
import { repoKeyOf } from "./placements";
import { isPluginHomeIn } from "./plugin-homes";
import { firstLine } from "./request-trace";
import { READ_FAILED, coded, dataHome, errorText, logOf, requireDataHome, type RpcHomeDeps } from "./rpc-kit";
import type { TraceStoreLocation } from "./trace-store";
import type { AgentFacts } from "./traces";

/** The journal lines a mission's page carries, newest first (§10.2). */
export const MISSION_PAGE_JOURNAL = 50;
/** The memory entries `memory.list` hands out, newest first (§10.4). */
export const MEMORY_LIST_LIMIT = 300;

/** A Main's Paseo status → its state on the screen (§10.2); an archived, missing or unknown Main is `none`. */
const MAIN_STATES: Readonly<Record<string, MissionSummary["main"]["state"]>> = {
  idle: "idle",
  running: "working",
  initializing: "working",
  error: "stopped",
  closed: "stopped",
};

export type MissionsRpcDeps = RpcHomeDeps & {
  /** The clock; `new Date()` by default. */
  now?: () => Date;
  /** Where a failure that does not fail the call goes; `console.warn` by default. */
  log?: (message: string) => void;
  /** The `paseo` CLI that retitles and relabels a Main after `mission.change`; the real one by default. */
  cli?: PaseoCliDeps;
};

/** `run`, with any failure that is not a coded error coded as a read that failed. */
async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    throw new DashboardError(READ_FAILED, `cannot ${what}: ${errorText(error)}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// What every read shares: one walk of Paseo's lists and the owner's settings.
// ---------------------------------------------------------------------------

interface ReadContext {
  home: string;
  now: Date;
  log: (message: string) => void;
  location: TraceStoreLocation;
  listed: ListedWorkspace[] | null;
  agents: Array<{ workspaceId: string | null; facts: AgentFacts }>;
  settings: CoordinationSettings;
  ladders: Record<string, MissionLadder>;
}

async function readContextOf(paseo: unknown, home: string, deps: MissionsRpcDeps): Promise<ReadContext> {
  const handle = paseo === null || paseo === undefined ? null : (paseo as DashboardPaseo);
  const [listed, agents] = await Promise.all([
    handle === null ? null : listedWorkspaces(handle).catch(() => null),
    handle === null ? [] : bmAgentsOf(handle, { home }).catch(() => []),
  ]);
  return {
    home,
    now: deps.now?.() ?? new Date(),
    log: logOf(deps),
    location: { tracesDir: join(home, TRACES_DIR_NAME) },
    listed,
    agents,
    settings: readCoordinationSettings({ home }),
    ladders: createGovernorStore(home).list(),
  };
}

const repoOf = (context: Pick<ReadContext, "listed" | "location">, workspaceId: string) => ({
  workspaceId,
  name: workspaceLabelOf(workspaceId, context.listed, context.location),
});

function mainStateOf(context: ReadContext, mainId: string | null): MissionSummary["main"]["state"] {
  if (mainId === null) return "none";
  const main = context.agents.find(({ facts }) => facts.id === mainId);
  if (main === undefined || main.facts.archived) return "none";
  return MAIN_STATES[main.facts.status] ?? "stopped";
}

/** The `Qn` of a `q:<requestId>:<Qn>` id. */
const questionIdOf = (id: string): string => id.slice(id.lastIndexOf(":") + 1);

const requestKey = (workspaceId: string, requestId: string) => `${workspaceId}\n${requestId}`;

/**
 * The open questions the owner answers for the roster's requests: the
 * Inbox's `q:` decisions (unsettled) of each request in its repo, as `Qn` ids
 * by request. Never throws: a store that cannot be read is none.
 */
function ownerQuestionsOf(context: ReadContext, roster: readonly RosterEntry[]): Map<string, string[]> {
  const byRequest = new Map<string, string[]>();
  const known = new Set(roster.map((entry) => requestKey(entry.workspaceId, entry.requestId)));
  const store = createDecisionStore(context.home, { log: context.log });
  for (const workspaceId of new Set(roster.map((entry) => entry.workspaceId))) {
    let decisions: ReturnType<typeof store.list>;
    try {
      decisions = store.list({ workspaceId, statuses: UNSETTLED_STATUSES });
    } catch {
      continue;
    }
    for (const decision of decisions) {
      if (!decision.id.startsWith("q:") || decision.requestId === null) continue;
      const key = requestKey(workspaceId, decision.requestId);
      if (known.has(key)) byRequest.set(key, [...(byRequest.get(key) ?? []), questionIdOf(decision.id)]);
    }
  }
  return byRequest;
}

/**
 * Every governor family of the mission, in `GOVERNOR_FAMILIES` order: its
 * ladder step (quiet for a closed mission), its figures crossed now, its last
 * action, and when a re-plan comes due (step 2: the nudge's time plus
 * `governor.windowMinutes`). Pure.
 */
function governorOf(mission: Mission, figures: readonly GovernorFigure[], ladder: MissionLadder, settings: CoordinationSettings): MissionSignal[] {
  return GOVERNOR_FAMILIES.map((family) => {
    const state = mission.state === "open" ? ladder[family] : undefined;
    const step = state?.step ?? 0;
    const last = state?.lastAction ?? null;
    const nudgedAt = step === 2 && last?.kind === "nudge" ? timeOrZero(last.at) : 0;
    return {
      family,
      step,
      crossed: figures
        .filter((entry) => entry.family === family && entry.crossed)
        .map(({ id, value, threshold, op, crossed, detail }) => ({ id, value, threshold, op, crossed, detail })),
      lastAction: last === null ? null : { kind: last.kind, at: last.at },
      replanDueAt: nudgedAt === 0 ? null : new Date(nudgedAt + settings.governor.windowMinutes * 60_000).toISOString(),
    };
  });
}

/** One mission as the screen reads it: its summary and what its page builds on. */
interface MissionView {
  summary: MissionSummary;
  roster: RosterEntry[];
  liveWorkerIds: Set<string>;
  questions: Map<string, string[]>;
  governor: MissionSignal[];
}

function missionViewOf(context: ReadContext, mission: Mission): MissionView {
  const roster = createMissionRoster(context.home).list(mission.missionId);
  // The governor's figures only for an open mission (it watches no other); its live Workers either way.
  const snapshot =
    mission.state === "open" ? readGovernorSnapshot(context.home, mission, { now: context.now, agents: context.agents as ListedAgent[], settings: context.settings, log: context.log }) : null;
  const live = snapshot?.liveWorkers ?? liveWorkersOf(context.agents as ListedAgent[], roster);
  const figures = snapshot === null ? [] : governorFiguresOf(snapshot, context.settings.governor);
  const questions = ownerQuestionsOf(context, roster);
  const cards = createMissionDecisionStore(context.home).list(mission.missionId, UNSETTLED_STATUSES);
  const governor = governorOf(mission, figures, context.ladders[mission.missionId] ?? {}, context.settings);
  const autonomy = createMissionAutonomyStore(context.home).get(mission.missionId);
  const counted = mission.charter.doneCriteria.filter((criterion) => criterion.status !== "dropped");
  return {
    summary: {
      missionId: mission.missionId,
      code: mission.code,
      name: mission.name,
      state: mission.state,
      createdAt: mission.createdAt,
      closedAt: mission.closedAt,
      main: { agentId: mission.mainId, state: mainStateOf(context, mission.mainId) },
      level: autonomy.level,
      delegated: MISSION_CLASSES.filter((name) => autonomy.cells[name].mode === "delegate"),
      repos: mission.charter.repos.map((workspaceId) => repoOf(context, workspaceId)),
      liveWorkers: live.length,
      requests: roster.length,
      criteria: { met: counted.filter((criterion) => criterion.status === "met").length, total: counted.length },
      questions: [...questions.values()].reduce((sum, ids) => sum + ids.length, 0) + cards.length,
      signals: governor.filter((signal) => signal.step >= 1),
    },
    roster,
    liveWorkerIds: new Set(live.map((worker) => worker.agentId)),
    questions,
    governor,
  };
}

/**
 * One row per roster request (§10.2 "Workers by repository"): its repo, its
 * topic (the roster's, which the Projects screen shows as the request's
 * text), its newest live Worker (else its newest), its phase (the roster's
 * finished or stopped; an active one with an open owner question or whose
 * Worker's newest report is `blocked` is blocked; else working), its open
 * owner questions and its live peer links by partner repository (plugin
 * homes left out). Never throws: a store that cannot be read is none.
 */
function rowsOf(context: ReadContext, view: MissionView): MissionRow[] {
  let links: ReturnType<ReturnType<typeof createPeerLinkStore>["list"]> = [];
  try {
    links = createPeerLinkStore(context.home).list().filter(isLiveLink);
  } catch {
    links = [];
  }
  return view.roster.map((entry) => {
    const workerId = [...entry.workerIds].reverse().find((id) => view.liveWorkerIds.has(id)) ?? entry.workerIds.at(-1) ?? null;
    const ownerQuestions = view.questions.get(requestKey(entry.workspaceId, entry.requestId)) ?? [];
    let phase: MissionRow["phase"] = entry.state === "active" ? "working" : entry.state;
    if (entry.state === "active") {
      const report = workerId === null ? null : newestReportRecordOf(context.home, entry.workspaceId, workerId);
      if (ownerQuestions.length > 0 || (report !== null && reportPhaseOf(report.text) === "blocked")) phase = "blocked";
    }
    const partners = new Map<string, number>();
    for (const link of links) {
      const asked = link.from.workspaceId === entry.workspaceId && link.from.requestId === entry.requestId;
      const took = repoKeyOf(context.home, link.to.workspaceId) === repoKeyOf(context.home, entry.workspaceId) && link.to.requestId === entry.requestId;
      if (!asked && !took) continue;
      const partner = asked ? link.to.workspaceId : link.from.workspaceId;
      if (isPluginHomeIn(partner, context.listed, context.home)) continue;
      partners.set(partner, (partners.get(partner) ?? 0) + link.messages.length);
    }
    return {
      repo: repoOf(context, entry.workspaceId),
      requestId: entry.requestId,
      topic: firstLine(entry.topic, process.env),
      workerId,
      phase,
      ownerQuestions,
      links: [...partners].map(([workspaceId, messages]) => ({ repo: repoOf(context, workspaceId), messages })),
    };
  });
}

/** The summary of one mission now; null for an unknown one. */
async function summaryNow(paseo: unknown, home: string, missionId: string, deps: MissionsRpcDeps): Promise<MissionSummary | null> {
  const mission = createMissionStore(home).get(missionId);
  return mission === null ? null : missionViewOf(await readContextOf(paseo, home, deps), mission).summary;
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/** `missions.list` (§10.4). Reads only; no usable data folder reads as none. */
export async function handleMissionsList(paseo: unknown, deps: MissionsRpcDeps = {}): Promise<MissionsListOutput> {
  const home = dataHome(deps);
  if (home === null) return { missions: [] };
  return guarded("read the missions", async () => {
    const store = createMissionStore(home);
    const missions = store
      .list()
      .map((entry) => store.get(entry.missionId))
      .filter((mission): mission is Mission => mission !== null);
    if (missions.length === 0) return { missions: [] };
    const when = (mission: Mission) => timeOrZero(mission.state === "open" ? mission.createdAt : (mission.closedAt ?? mission.createdAt));
    missions.sort((a, b) => (a.state === b.state ? when(b) - when(a) : a.state === "open" ? -1 : 1));
    const context = await readContextOf(paseo, home, deps);
    return { missions: missions.map((mission) => missionViewOf(context, mission).summary) };
  });
}

/** `mission.get` (§10.4). Reads only. Unknown → `E_MISSION_INVALID`. */
export async function handleMissionGet(input: { missionId: string }, paseo: unknown, deps: MissionsRpcDeps = {}): Promise<MissionGetOutput> {
  const home = requireDataHome(deps, "read the mission");
  return guarded("read the mission", async () => {
    const store = createMissionStore(home);
    const mission = store.get(input.missionId);
    if (mission === null) throw missionInvalid([`unknown mission ${input.missionId}`]);
    const context = await readContextOf(paseo, home, deps);
    const view = missionViewOf(context, mission);
    const { charter } = mission;
    const flight = inFlightOf(home, mission.missionId);
    return {
      summary: { ...view.summary, repos: withPlacements(home, mission, view.summary.repos, flight.inFlight), ci: context.settings.integration.ci },
      charter: {
        goal: charter.goal,
        nonGoals: charter.nonGoals,
        confirmedAt: charter.confirmedAt,
        criteria: charter.doneCriteria.map((criterion) => ({ id: criterion.id, text: criterion.text, status: criterion.status, at: criterion.at })),
        budget: charter.budget,
      },
      governor: view.governor,
      rows: rowsOf(context, view),
      contracts: mission.contracts.map((contract) => ({
        id: contract.id,
        title: contract.title,
        provider: repoOf(context, contract.providerRepo),
        consumers: contract.consumerRepos.map((workspaceId) => repoOf(context, workspaceId)),
        version: contract.version,
        updatedAt: contract.updatedAt,
      })),
      journal: store
        .journal(mission.missionId, MISSION_PAGE_JOURNAL)
        .reverse()
        .map((line) => ({ at: line.at, kind: line.kind, by: line.by, text: line.text })),
      plan: { text: mission.plan.text, updatedAt: mission.plan.updatedAt },
      // Mission runtime design §7: the page's In flight and Main history read the one mission state.
      ...flight,
      mainHistory: mission.mainHistory.map((entry) => ({ agentId: entry.agentId, from: entry.from, to: entry.to, reason: entry.reason })),
    };
  });
}

/** `mission.get`'s `inFlight`: the mission state, when it can be read. Never throws. */
function inFlightOf(home: string, missionId: string): { inFlight?: MissionState } {
  try {
    const state = missionStateOf(home, missionId);
    return state === null ? {} : { inFlight: state };
  } catch {
    return {};
  }
}

/**
 * Push and merge request of a placement (delivery line design §4.3, §4.9):
 * allowed while its grant is `granted`, revoked once the owner revoked it,
 * else from its integration card — waiting while open, not now once the
 * owner answered other than its "Yes" — and none before any card. Pure.
 */
export function integrationStateOf(placement: Pick<Placement, "repo" | "integration">, cards: readonly Decision[]): MissionPlacement["integration"] {
  const grant = placement.integration;
  if (grant?.state === "granted") return { state: "allowed", at: grant.grantedAt, decisionId: grant.decisionId };
  if (grant?.state === "revoked") return { state: "revoked", at: grant.revokedAt, decisionId: grant.decisionId };
  const card = cards.filter((decision) => isIntegrationCard(decision) && decision.options.some((option) => option.action?.kind === "integration.grant" && option.action.repo === placement.repo)).at(-1);
  if (card === undefined) return { state: "none", at: null, decisionId: null };
  if (UNSETTLED_STATUSES.includes(card.status)) return { state: "waiting", at: null, decisionId: card.id };
  const answered = card.status === "answered" && card.answer !== null && card.answer.optionKey !== "a";
  return { state: answered ? "not-now" : "none", at: null, decisionId: card.id };
}

/**
 * The summary's repos, each with a worktree carrying its `placement`
 * (delivery line design §4.9): its line as the mission state read it (no
 * git here) and push and merge request (`integrationStateOf`). Never throws:
 * unreadable cards read as none.
 */
function withPlacements(home: string, mission: Mission, repos: MissionSummary["repos"], state: MissionState | undefined): MissionSummary["repos"] {
  const lines = state?.placements ?? [];
  if (lines.length === 0) return repos;
  let cards: Decision[] = [];
  try {
    cards = createMissionDecisionStore(home).list(mission.missionId);
  } catch {
    cards = [];
  }
  const stored = new Map((mission.placements ?? []).map((placement) => [placement.repo, placement]));
  return repos.map((repo) => {
    const line = lines.find((entry) => entry.repo === repo.workspaceId);
    const placement = stored.get(repo.workspaceId);
    if (line === undefined || placement === undefined) return repo;
    const { branch, target, state: lineState, dirty, ahead, behind, lastCommitAt, pushed, mr, ci, readAt } = line;
    return { ...repo, placement: { branch, target, state: lineState, dirty, ahead, behind, lastCommitAt, pushed, mr, ci, readAt, integration: integrationStateOf(placement, cards) } };
  });
}

/**
 * `mission.change` (§10.4): the owner's own change from the screen, applied
 * at once on the `m:` card's path. A part that changes nothing (the same
 * name or code, a repo already in the charter) is left out; a change left
 * empty is refused. Every refusal writes nothing. The Main is told with the
 * mission id as the message's reference: the change answers no card.
 */
export async function handleMissionChange(input: MissionChangeInput, paseo: unknown, deps: MissionsRpcDeps = {}): Promise<MissionChangeOutput> {
  const home = requireDataHome(deps, "change the mission");
  const now = deps.now?.() ?? new Date();
  const log = logOf(deps);
  const store = createMissionStore(home, { now: () => now });
  const mission = coded(READ_FAILED, "read the mission", () => store.get(input.missionId));
  if (mission === null) throw missionInvalid([`unknown mission ${input.missionId}`]);
  if (mission.state !== "open") throw missionInvalid([`mission ${mission.code} is closed`]);
  const reasons: string[] = [];
  const change: MissionChange = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") reasons.push("the name is empty");
    else if (name !== mission.name) change.name = name;
  }
  if (input.code !== undefined) {
    const code = input.code.trim();
    if (!MISSION_CODE_PATTERN.test(code)) reasons.push(`code ${code} is not 2 to 8 capital letters or digits, a letter first`);
    else if (code !== mission.code) change.code = code;
  }
  const adding = [...new Set(input.addRepos ?? [])].filter((workspaceId) => !mission.charter.repos.includes(workspaceId));
  if (adding.length > 0) change.addRepos = adding;
  if (input.close === true) change.close = true;
  if (reasons.length === 0 && isEmptyMissionChange(change)) reasons.push("nothing to change");
  if (!isEmptyMissionChange(change)) reasons.push(...(await missionChangeRefusalsOf(mission.missionId, change, paseo, home)));
  if (reasons.length > 0) throw missionInvalid(reasons);

  const at = now.toISOString();
  const result = coded("E_MISSION_WRITE_FAILED", "write the mission", () => store.update(mission.missionId, (current) => applyMissionChange(current, change, at)));
  if (!result.ok) throw missionInvalid(result.reasons);
  if (change.close === true) stopActiveRequests(home, mission.missionId, log);
  if ((change.addRepos ?? []).length > 0) offerMerges(home, mission.missionId, { now, log });
  // Delivery line design §3.6: the owner's removal or close retires placements and offers their archive card now; a new code retitles them.
  if (change.close === true || (change.removeRepos ?? []).length > 0) await openArchiveCards(home, mission.missionId, { log, now: () => now }).catch(() => null);
  if (change.code !== undefined) await retitlePlacements(paseo, result.mission, log).catch(() => undefined);
  const lines = missionChangeLinesOf(change).join("; ");
  journalQuietly(store, mission.missionId, { kind: "charter", by: "owner", text: `The owner changed the mission from the Missions screen: ${lines}.` }, log);
  await tellMain(mission.missionId, mission.missionId, `The owner changed your mission from the Missions screen: ${lines}.`, {
    home,
    now,
    log,
    paseo,
    ...(deps.cli === undefined ? {} : { cli: deps.cli }),
  });
  await syncMainAfterChange(result.mission, change, { log, ...(deps.cli === undefined ? {} : { cli: deps.cli }) });
  const summary = await guarded("read the mission", () => summaryNow(paseo, home, mission.missionId, deps));
  if (summary === null) throw missionInvalid([`unknown mission ${input.missionId}`]);
  return { summary };
}

/** `memory.list` (§10.4). Reads only; no usable data folder reads as none. */
export async function handleMemoryList(input: { workspaceId: string }, paseo: unknown, deps: MissionsRpcDeps = {}): Promise<MemoryListOutput> {
  const home = dataHome(deps);
  return guarded("read the project memory", async () => {
    const listed = paseo === null || paseo === undefined ? null : await listedWorkspaces(paseo as DashboardPaseo).catch(() => null);
    const name = workspaceLabelOf(input.workspaceId, listed, home === null ? null : { tracesDir: join(home, TRACES_DIR_NAME) });
    if (home === null) return { workspaceId: input.workspaceId, name, total: 0, entries: [] };
    const stored = createMemoryStore(home)
      .active(input.workspaceId)
      .map((entry) => ({ id: entry.id, kind: entry.kind, text: entry.text, source: entry.source, by: { role: entry.by.role, agentId: entry.by.agentId }, at: entry.at }));
    // The owner's active precedents for this repo and for all projects, as bm_memory read shows them (artboard F).
    const precedents = createPrecedentStore(home)
      .active(deps.now?.() ?? new Date(), input.workspaceId)
      .map((precedent) => ({
        id: precedent.id,
        kind: "precedent" as const,
        text: precedent.text,
        source: precedent.scope === PRECEDENT_SCOPE_ALL ? "all projects" : (precedent.sourceDecisionId ?? "the owner's Settings"),
        by: { role: "owner" as const, agentId: null },
        at: precedent.createdAt,
      }));
    const all = [...stored, ...precedents];
    const newest = all
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => timeOrZero(b.entry.at) - timeOrZero(a.entry.at) || b.index - a.index)
      .slice(0, MEMORY_LIST_LIMIT)
      .map(({ entry }) => entry);
    return { workspaceId: input.workspaceId, name, total: all.length, entries: newest };
  });
}

/**
 * `mission.integration.revoke` (delivery line design §4.3): the owner's
 * revoke of the mission's integration grant for `repo`, through
 * `revokeIntegration`. A refusal writes nothing.
 */
export async function handleMissionIntegrationRevoke(input: MissionIntegrationRevokeInput, paseo: unknown, deps: MissionsRpcDeps = {}): Promise<MissionIntegrationRevokeOutput> {
  const home = requireDataHome(deps, "revoke the integration grant");
  const mission = coded(READ_FAILED, "read the mission", () => createMissionStore(home).get(input.missionId));
  if (mission === null) throw missionInvalid([`unknown mission ${input.missionId}`]);
  const revoked = await revokeIntegration(mission.missionId, input.repo, { home, now: deps.now?.() ?? new Date(), log: logOf(deps), paseo });
  if (!revoked.ok) throw missionInvalid(revoked.reasons);
  return { revokedAt: revoked.placement.integration?.revokedAt ?? "", notified: revoked.notified };
}

/**
 * `mission.integration.ask` (delivery line design §4.3): the owner's "Ask me
 * again" from the mission page, through `askIntegrationAgain`. A refusal
 * writes nothing.
 */
export async function handleMissionIntegrationAsk(input: MissionIntegrationAskInput, _paseo: unknown, deps: MissionsRpcDeps = {}): Promise<MissionIntegrationAskOutput> {
  const home = requireDataHome(deps, "ask about the integration again");
  const asked = askIntegrationAgain(home, input.missionId, input.repo, { now: deps.now?.() ?? new Date(), log: logOf(deps) });
  if (!asked.ok) throw missionInvalid(asked.reasons);
  return { decisionId: asked.decisionId };
}

/** Registers `missions.list`, `mission.get`, `mission.change`, `mission.integration.revoke`, `mission.integration.ask` and `memory.list`. */
export function registerMissionsRpcs(server: Pick<PluginServerContext, "handle">, deps: MissionsRpcDeps = {}): void {
  server.handle(missionsListRpc, (_input, context) => handleMissionsList(context?.paseo, deps));
  server.handle(missionGetRpc, (input, context) => handleMissionGet(input, context?.paseo, deps));
  server.handle(missionChangeRpc, (input, context) => handleMissionChange(input, context?.paseo, deps));
  server.handle(missionIntegrationRevokeRpc, (input, context) => handleMissionIntegrationRevoke(input, context?.paseo, deps));
  server.handle(missionIntegrationAskRpc, (input, context) => handleMissionIntegrationAsk(input, context?.paseo, deps));
  server.handle(memoryListRpc, (input, context) => handleMemoryList(input, context?.paseo, deps));
}
