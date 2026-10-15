/**
 * The governor's arbitration and split tools (missions design §9.6, §4.1;
 * ADR-029; REQ-194), served with the Orchestrator's (`orchestrator-tools.ts`).
 *
 * - **`bm_arbitrate { missions, workspaceId, area, owner, reason, goal? }`**
 *   gives one area of a repo to one of two open missions: it writes the call
 *   to `orchestrator/arbitrations.json` (`governor-conflicts.ts`), adds a
 *   `governor` journal line to both missions and sends both Mains a
 *   `governor:arbitrate` command (`governSend`, `command-authority.ts`). With
 *   `goal` — the losing mission's goal as the call leaves it — it also opens an
 *   `m:` card of that mission whose "apply" option carries the `arbitration`
 *   prepared change: the plugin sets the goal on the owner's tap.
 * - **`bm_create_main { fromMissionId, name, code, goal, repos, requestIds?,
 *   reason }`** splits a mission. Its authority is the source mission's
 *   `split` cell (`mission-autonomy-store.ts`): delegated, the split runs at
 *   once (`executeSplit`); otherwise the tool opens an `m:` card of the
 *   source mission whose "apply" option carries the `mission-split` prepared
 *   change, and the plugin runs the split on the owner's tap. A split writes
 *   the new mission (`createdBy: orchestrator`, `parentMissionId`,
 *   `splitReason`), moves the named requests to it (`transferRequests`,
 *   mission runtime design §5.1: roster, registry mission, bindings), creates
 *   its Main in the Missions home (`handleMissionEnsure`, whose `replaceMain`
 *   points those requests and their Workers at it) and tells the source
 *   mission's Main; the new Main reads it in its brief's journal.
 * - **Refused** (`splitRefusalsOf`, checked by the tool and again on the
 *   owner's tap): the source mission unknown or closed, a code an open mission
 *   holds, a repo Paseo does not list, a request not on the source's roster,
 *   the source's Main running a turn, an area the moved requests wrote in the
 *   last 7 days that another open mission wrote too or was given by an
 *   arbitration, and more than `MAX_SPLITS_PER_DAY` splits of one mission in
 *   24 hours.
 *
 * The `m:` cards' answers come only through `decisions.answer`
 * (`decision-rpc.ts`): `governorAnswerRefusalsOf` first (nothing written on a
 * refusal), then `applyGovernorDecision`, which applies the change only on
 * the owner's own answer. A refusal is one line per reason and changes
 * nothing.
 */
import type { AgentBinder, BindingStore } from "./agent-bindings";
import { isAnswerable, type Decision } from "../shared/decisions";
import {
  missionSplitLinesOf,
  type ArbitrationAction,
  type MissionSplit,
  type MissionSplitAction,
} from "../shared/mission-change";
import { governSend, type CommandToolDeps } from "./command-authority";
import {
  CONFLICT_WINDOW_MS,
  areaCovers,
  areasOverlap,
  createArbitrationStore,
  missionAreasOf,
  newArbitrationId,
  normalArea,
  openMissionsOf,
  type Arbitration,
} from "./governor-conflicts";
import { createMissionAutonomyStore } from "./mission-autonomy-store";
import { createMissionDecisionStore, missionOfDecisionId } from "./mission-decisions";
import { transferRequests, type TransferDeps } from "./mission-transfer";
import { createMissionRoster } from "./mission-roster";
import { MISSION_CODE_PATTERN, createMissionStore, type Mission } from "./mission-store";
import { resolveRepos, tellMain, type MissionAnswerDeps } from "./mission-tools";
import { handleMissionEnsure, type MissionsPaseo } from "./missions-home";
import type { NoticeQueue } from "./notice-queue";
import { Refusal, json, orchestratorIdOf, type ServerToolResult, type ToolContext } from "./orchestrator-tool-context";
import type { PaseoCliDeps } from "./paseo-cli";
import { bmAgentsOf, listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { cutText } from "./request-render";
import { errorText } from "./rpc-kit";
import { refused } from "./tool-kit";

/** At most this many splits of one mission in 24 hours (§9.6). */
export const MAX_SPLITS_PER_DAY = 2;
const DAY_MS = 86_400_000;
const NOTHING = "Nothing was recorded or sent.";

/** What creating a new Main needs of the plugin: the endpoint's binder and bindings, the `paseo` CLI. */
export interface GovernorMissionDeps {
  binder?: () => AgentBinder;
  bindings?: () => BindingStore | null;
  cli?: PaseoCliDeps;
  /** A Main's system prompt (tests); `currentInstructions` by default. */
  readInstructions?: (paseo: unknown, workspaceId: string, missionId: string | null) => Promise<string>;
}

export interface GovernorToolDeps extends CommandToolDeps {
  missions?: GovernorMissionDeps;
}

export interface ArbitrateInput {
  missions: string[];
  workspaceId: string;
  area: string;
  owner: string;
  reason: string;
  /** The losing mission's goal as the call leaves it; only when the call changes it. */
  goal?: string;
}

export interface CreateMainInput {
  fromMissionId: string;
  name: string;
  code: string;
  goal: string;
  repos: string[];
  requestIds?: string[];
  reason: string;
}

const why = (reasons: readonly string[]): ServerToolResult => refused([...reasons, NOTHING].join("\n"));

/** An `m:` card of `mission` with "apply" carrying `action` and "keep as is". Pure. */
function governorCardOf(mission: Mission, lines: readonly string[], action: MissionSplitAction | ArbitrationAction, input: { id: string; askedBy: string | null; at: string }): Decision {
  return {
    id: input.id,
    workspaceId: mission.missionId,
    requestId: null,
    askedBy: { role: "plugin", agentId: input.askedBy },
    askedAt: input.at,
    round: null,
    question: cutText([`Mission ${mission.code} (${mission.name}): the governor asks to`, ...lines.map((line) => `- ${line}`)].join("\n"), 1_000),
    subject: null,
    class: "scope",
    options: [
      { key: "apply", label: action.kind === "mission-split" ? "Split the mission" : "Set the new goal", recommended: false, effects: [], action },
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

/** The `mission-split` or `arbitration` action the chosen option carries, or null. Pure. */
export function chosenGovernorAction(decision: Decision, optionKey: string | null): MissionSplitAction | ArbitrationAction | null {
  const action = decision.options.find((option) => option.key === optionKey)?.action;
  return action?.kind === "mission-split" || action?.kind === "arbitration" ? action : null;
}

/** True for an `m:` card the governor opened: one of its options carries a split or an arbitration. Pure. */
export function isGovernorCard(decision: Pick<Decision, "options">): boolean {
  return decision.options.some((option) => option.action?.kind === "mission-split" || option.action?.kind === "arbitration");
}

// ---------------------------------------------------------------------------
// The split.
// ---------------------------------------------------------------------------

/**
 * See the module comment. `split.repos` are workspace ids or folders.
 * `mainMayRun`: the source's Main is the caller, in its own turn
 * (`bm_split_mission`), so its running turn is no refusal. Never throws.
 */
export async function splitRefusalsOf(home: string, source: Mission | null, split: MissionSplit, paseo: unknown, now: Date, options: { mainMayRun?: boolean } = {}): Promise<string[]> {
  if (source === null) return ["fromMissionId: no such mission; use a missionId bm_missions gave"];
  if (source.state !== "open") return [`mission ${source.code} is closed`];
  try {
    const reasons: string[] = [];
    const store = createMissionStore(home);
    if (!MISSION_CODE_PATTERN.test(split.code)) reasons.push("code: 2 to 8 capital letters or digits, a letter first");
    const taken = store.list().find((entry) => entry.state === "open" && entry.code === split.code);
    if (taken !== undefined) reasons.push(`code ${split.code} is taken by the open mission ${taken.name}`);
    reasons.push(...resolveRepos(split.repos, await listedWorkspaces(paseo as DashboardPaseo), home, "repos").reasons);
    const roster = createMissionRoster(home).list(source.missionId);
    for (const requestId of split.requestIds) if (!roster.some((entry) => entry.requestId === requestId)) reasons.push(`request ${requestId} is not on the roster of mission ${source.code}`);
    if (source.mainId !== null && options.mainMayRun !== true) {
      const main = (await bmAgentsOf(paseo as DashboardPaseo, { home })).find(({ facts }) => facts.id === source.mainId);
      if (main?.facts.status === "running") reasons.push(`the Main of mission ${source.code} is running a turn; split it once that turn ends`);
    }
    const recent = store.list().filter((entry) => {
      const mission = store.get(entry.missionId);
      return mission?.parentMissionId === source.missionId && now.getTime() - Date.parse(mission.createdAt) < DAY_MS;
    });
    if (recent.length >= MAX_SPLITS_PER_DAY) reasons.push(`mission ${source.code} was split ${recent.length} times in the last 24 hours; at most ${MAX_SPLITS_PER_DAY}`);
    if (split.requestIds.length > 0) {
      const since = now.getTime() - CONFLICT_WINDOW_MS;
      const moved = missionAreasOf(home, source, since, new Set(split.requestIds));
      const arbitrations = createArbitrationStore(home).list();
      for (const other of openMissionsOf(home).filter((mission) => mission.missionId !== source.missionId)) {
        const theirs = missionAreasOf(home, other, since);
        for (const [workspaceId, areas] of moved) {
          for (const area of areas.keys()) {
            const overlaps = [...(theirs.get(workspaceId)?.keys() ?? [])].some((their) => areasOverlap(area, their));
            const given = arbitrations.some((entry) => entry.workspaceId === workspaceId && entry.owner === other.missionId && areaCovers(entry.area, area));
            if (overlaps || given) reasons.push(`the requests to move wrote ${area} in ${workspaceId}, an area of mission ${other.code} too`);
          }
        }
      }
    }
    return [...new Set(reasons)];
  } catch (error) {
    return [`the missions cannot be read: ${errorText(error)}`];
  }
}

export interface SplitDeps {
  home: string;
  now: Date;
  paseo: unknown;
  log: (message: string) => void;
  queue?: Pick<NoticeQueue, "enqueue">;
  missions?: GovernorMissionDeps;
}

export type SplitResult = { ok: true; mission: Mission; mainId: string; moved: string[]; workers: string[] } | { ok: false; reasons: string[] };

/**
 * Runs a split already checked (see the module comment); `by` is who
 * authorised it (`owner` on the card, `orchestrator` on the `split` cell),
 * `ref` the card or the source mission. Any failure between the new mission's
 * creation and its Main's (`undo`) puts the moved requests back, closes the
 * new mission and journals why on the source, each step on its own: the
 * result keeps the failure that stopped the split. Never throws.
 */
export async function executeSplit(source: Mission, split: MissionSplit, by: "owner" | "orchestrator", ref: string, deps: SplitDeps): Promise<SplitResult> {
  const { home, log } = deps;
  const store = createMissionStore(home, { now: () => deps.now });
  const bindings = deps.missions?.bindings?.() ?? undefined;
  const transferDeps: TransferDeps = {
    home,
    now: deps.now,
    paseo: deps.paseo,
    log,
    ...(bindings ? { bindings } : {}),
    ...(deps.queue === undefined ? {} : { queue: deps.queue }),
    ...(deps.missions?.cli === undefined ? {} : { cli: deps.missions.cli }),
  };
  /** The new mission and the requests moved to it, until its Main exists; then null: the split stands. */
  let undoable: { mission: Mission; movedIds: string[] } | null = null;
  const undo = async (why: string): Promise<void> => {
    if (undoable === null) return;
    const { mission, movedIds } = undoable;
    undoable = null;
    const back = async (): Promise<void> => {
      if (movedIds.length === 0) return;
      const returned = await transferRequests({ from: mission.missionId, to: source.missionId, requestIds: movedIds, reason: why, by: "plugin", ref: mission.missionId, journal: false, tell: false }, transferDeps);
      if (!returned.ok) throw new Error(returned.reasons.join("; "));
    };
    const steps: Array<[string, () => unknown]> = [
      ["put the moved requests back", back],
      ["close the new mission", () => store.update(mission.missionId, (current) => ({ ...current, state: "closed", closedAt: deps.now.toISOString() }))],
      ["journal it", () => store.appendJournal(source.missionId, { kind: "charter", by: "plugin", text: `Split into ${split.code} undone: ${why}`, ref: mission.missionId })],
    ];
    for (const [what, step] of steps) {
      try {
        await step();
      } catch (error) {
        log(`[paseo-bm] undoing the split into ${split.code} could not ${what}: ${errorText(error)}`);
      }
    }
  };
  try {
    const listed = await listedWorkspaces(deps.paseo as DashboardPaseo);
    const repos = resolveRepos(split.repos, listed, home, "repos").ids;
    const created = store.create({ code: split.code, name: split.name, goal: split.goal, repos, createdBy: "orchestrator", parentMissionId: source.missionId, splitReason: split.reason });
    if (!created.ok) return { ok: false, reasons: created.reasons };
    const mission = created.mission;
    undoable = { mission, movedIds: [] };
    // Mission runtime design §5.1: the one transfer; the new mission has no Main yet, so its creation points the requests at it.
    const transferred = await transferRequests({ from: source.missionId, to: mission.missionId, requestIds: split.requestIds, reason: split.reason, by, ref, journal: false, tell: false }, transferDeps);
    if (!transferred.ok) throw new Error(transferred.reasons.join("; "));
    const movedIds = transferred.moved;
    undoable = { mission, movedIds };
    const listedIds = movedIds.length === 0 ? "no request" : `requests ${movedIds.join(", ")}`;
    store.appendJournal(mission.missionId, { kind: "charter", by, text: `Split from mission ${source.code} with ${listedIds}: ${split.reason}`, ref: source.missionId });
    store.appendJournal(source.missionId, { kind: "charter", by, text: `Split: mission ${split.code} took ${listedIds}: ${split.reason}`, ref: mission.missionId });
    let mainId: string;
    try {
      const missions = deps.missions ?? {};
      mainId = (
        await handleMissionEnsure({ missionId: mission.missionId }, deps.paseo as MissionsPaseo, {
          home,
          now: () => deps.now,
          log,
          ...(missions.binder === undefined ? {} : { binder: missions.binder }),
          ...(missions.bindings === undefined ? {} : { bindings: missions.bindings }),
          ...(missions.cli === undefined ? {} : { cli: missions.cli }),
          ...(missions.readInstructions === undefined ? {} : { readInstructions: missions.readInstructions }),
        })
      ).agentId;
    } catch (error) {
      await undo(`its Main could not be created (${errorText(error)})`);
      return { ok: false, reasons: [`the new mission's Main could not be created: ${errorText(error)}`] };
    }
    undoable = null;
    const workers = transferred.workers;
    const told: MissionAnswerDeps = { home, now: deps.now, log, paseo: deps.paseo, ...(deps.missions?.cli === undefined ? {} : { cli: deps.missions.cli }) };
    await tellMain(
      source.missionId,
      ref,
      `Your mission was split: mission ${split.code} "${split.name}" (Main ${mainId}) took ${listedIds} and their Workers. Reason: ${split.reason}. Plan without them; ask that mission with bm_ask_mission.`,
      told,
      by,
    );
    return { ok: true, mission: store.get(mission.missionId) ?? mission, mainId, moved: movedIds, workers };
  } catch (error) {
    await undo(`it failed before its Main was created (${errorText(error)})`);
    return { ok: false, reasons: [errorText(error)] };
  }
}

/** `bm_create_main` (see the module comment). */
export async function bmCreateMain(input: CreateMainInput, context: ToolContext, deps: GovernorToolDeps): Promise<ServerToolResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const source = createMissionStore(context.home).get(input.fromMissionId);
  const split: MissionSplit = {
    name: input.name.trim(),
    code: input.code,
    goal: input.goal.trim(),
    repos: [...new Set(input.repos)],
    requestIds: [...new Set(input.requestIds ?? [])],
    reason: input.reason.trim(),
  };
  const reasons = await splitRefusalsOf(context.home, source, split, context.paseo, context.now);
  if (reasons.length > 0 || source === null) return why(reasons);
  split.repos = resolveRepos(split.repos, await listedWorkspaces(context.paseo), context.home, "repos").ids;

  if (createMissionAutonomyStore(context.home).isDelegated(source.missionId, "split")) {
    const done = await executeSplit(source, split, "orchestrator", source.missionId, { home: context.home, now: context.now, paseo: context.paseo, log, ...(deps.queue === undefined ? {} : { queue: deps.queue }), ...(deps.missions === undefined ? {} : { missions: deps.missions }) });
    if (!done.ok) return why(done.reasons);
    return {
      ok: true,
      text: `Split on mission ${source.code}'s split cell: mission ${done.mission.code} and its Main ${done.mainId} were created; both Mains know.\n${json({ missionId: done.mission.missionId, code: done.mission.code, mainId: done.mainId, moved: done.moved, workers: done.workers })}`,
    };
  }

  // Without the split cell the owner decides, on an m: card of the source mission (§4.1).
  const cards = createMissionDecisionStore(context.home);
  const open = cards.list(source.missionId).find((decision) => isAnswerable(decision) && decision.options.some((option) => option.action?.kind === "mission-split" && option.action.split.code === split.code));
  if (open !== undefined) return why([`the owner's card ${open.id} asks this split already`]);
  const action: MissionSplitAction = { kind: "mission-split", missionId: source.missionId, split };
  try {
    const card = governorCardOf(source, missionSplitLinesOf(split), action, { id: cards.nextId(source.missionId), askedBy: await orchestratorIdOf(context), at: context.now.toISOString() });
    const { decision } = cards.open(card);
    createMissionStore(context.home).appendJournal(source.missionId, { kind: "decision", by: "orchestrator", text: `Asked the owner to split off mission ${split.code} (${decision.id}): ${split.reason}`, ref: decision.id });
    return {
      ok: true,
      text: `Mission ${source.code}'s split cell is the owner's: they are asked on card ${decision.id}. The plugin creates mission ${split.code} and its Main when they apply it.\n${json({ decisionId: decision.id })}`,
    };
  } catch (error) {
    return why([`the owner's card could not be written: ${errorText(error)}`]);
  }
}

// ---------------------------------------------------------------------------
// bm_arbitrate.
// ---------------------------------------------------------------------------

/** `bm_arbitrate` (see the module comment). */
export async function bmArbitrate(input: ArbitrateInput, context: ToolContext, deps: GovernorToolDeps): Promise<ServerToolResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const store = createMissionStore(context.home);
  const [firstId, secondId] = input.missions as [string, string];
  const reasons: string[] = [];
  if (firstId === secondId) reasons.push("missions: name two different missions");
  const pair = [firstId, secondId].map((missionId) => {
    const mission = store.get(missionId);
    if (mission === null) reasons.push(`no mission ${missionId}; use a missionId bm_missions gave`);
    else if (mission.state !== "open") reasons.push(`mission ${mission.code} is closed`);
    return mission;
  });
  if (!input.missions.includes(input.owner)) reasons.push("owner: must be one of the two missions");
  const [first, second] = pair;
  if (reasons.length > 0 || first === null || second === null || first === undefined || second === undefined) return why(reasons);
  const owner = first.missionId === input.owner ? first : second;
  const loser = owner === first ? second : first;
  const goal = input.goal?.trim();
  if (goal !== undefined && goal === loser.charter.goal.trim()) return why([`goal: it is mission ${loser.code}'s goal already; leave goal out`]);

  const area = normalArea(input.area);
  const reason = input.reason.trim();
  const arbitrations = createArbitrationStore(context.home);
  const entry: Arbitration = {
    id: newArbitrationId(),
    at: context.now.toISOString(),
    missions: [first.missionId, second.missionId],
    workspaceId: input.workspaceId,
    area,
    owner: owner.missionId,
    reason,
    commandIds: [],
    decisionId: null,
  };
  try {
    arbitrations.put(entry);
  } catch (error) {
    return why([`the arbitration could not be written: ${errorText(error)}`]);
  }
  const line = `Arbitration ${entry.id}: ${area} in ${input.workspaceId} belongs to mission ${owner.code}. ${reason}`;
  for (const mission of [first, second]) {
    try {
      store.appendJournal(mission.missionId, { kind: "governor", by: "orchestrator", text: line, ref: entry.id });
    } catch (error) {
      log(`[paseo-bm] bm_arbitrate could not write the journal of mission ${mission.code}: ${errorText(error)}`);
    }
  }

  if (goal !== undefined) {
    try {
      const cards = createMissionDecisionStore(context.home);
      const action: ArbitrationAction = { kind: "arbitration", missionId: loser.missionId, arbitrationId: entry.id, goal };
      const card = governorCardOf(loser, [`set its goal, as arbitration ${entry.id} leaves it (${area} in ${input.workspaceId} goes to mission ${owner.code}), to ${JSON.stringify(goal.slice(0, 300))}`, `because ${reason.slice(0, 300)}`], action, {
        id: cards.nextId(loser.missionId),
        askedBy: await orchestratorIdOf(context),
        at: context.now.toISOString(),
      });
      entry.decisionId = cards.open(card).decision.id;
    } catch (error) {
      log(`[paseo-bm] bm_arbitrate could not open the owner's card of mission ${loser.code}: ${errorText(error)}`);
    }
  }

  const told: string[] = [];
  const texts: Array<[Mission, string]> = [
    [owner, `${line}\nThe area is your mission's: mission ${loser.code} (${loser.name}) leaves it to you; answer what it asks there with bm_peer_reply.`],
    [
      loser,
      `${line}\nLeave that area to mission ${owner.code} (${owner.name}): stop changing it, and ask that mission with bm_ask_mission for what you need there.${
        entry.decisionId === null ? "" : ` The owner is asked on card ${entry.decisionId} to change your goal; it stands as it is until they apply it.`
      }`,
    ],
  ];
  for (const [mission, text] of texts) {
    try {
      const sent = await governSend({ missionId: mission.missionId, step: "arbitrate", text, ownWords: `${input.area}\n${reason}` }, context, deps);
      // A command the store could not record is named nowhere, as `bm_govern` names none.
      const id = sent.ok && sent.unrecorded === null ? sent.id : null;
      if (id !== null) entry.commandIds.push(id);
      told.push(sent.ok ? `the Main of ${mission.code} is told${id === null ? "" : ` (command ${id})`}` : `the Main of ${mission.code} could not be told: ${sent.text}`);
    } catch (error) {
      told.push(`the Main of ${mission.code} could not be told: ${error instanceof Refusal ? error.message : errorText(error)}`);
    }
  }
  try {
    arbitrations.put(entry);
  } catch (error) {
    log(`[paseo-bm] bm_arbitrate could not record the commands of ${entry.id}: ${errorText(error)}`);
  }
  return {
    ok: true,
    text: `Arbitration ${entry.id} recorded: ${area} in ${input.workspaceId} belongs to mission ${owner.code}; ${told.join("; ")}.${
      entry.decisionId === null ? "" : ` The owner is asked on card ${entry.decisionId} to change mission ${loser.code}'s goal.`
    }\n${json({ arbitrationId: entry.id, commandIds: entry.commandIds, decisionId: entry.decisionId })}`,
  };
}

// ---------------------------------------------------------------------------
// The owner's tap on a governor card (decision-rpc.ts).
// ---------------------------------------------------------------------------

/** Why the owner's answer `optionKey` on a governor card cannot be applied now; none for "keep" or words. Never throws. */
export async function governorAnswerRefusalsOf(decision: Decision, optionKey: string | null, paseo: unknown, home: string, now: Date): Promise<string[]> {
  const action = chosenGovernorAction(decision, optionKey);
  if (action === null) return [];
  const mission = createMissionStore(home).get(action.missionId);
  if (action.kind === "mission-split") {
    if (paseo === null || paseo === undefined) return ["paseo-bm has no connection to Paseo yet; try again in a moment"];
    return splitRefusalsOf(home, mission, action.split, paseo, now);
  }
  if (mission === null) return [`mission ${action.missionId} no longer exists`];
  return mission.state === "open" ? [] : [`mission ${mission.code} is closed`];
}

export interface GovernorAnswerDeps extends MissionAnswerDeps {
  missions?: GovernorMissionDeps;
}

/**
 * After the owner's answer on a governor card is recorded: the split or the
 * goal change of the option they chose, only on the owner's own answer, with
 * its journal lines; keep as is, or words, is a journal line and a word to
 * the mission's Main. Never throws.
 */
export async function applyGovernorDecision(decision: Decision, deps: GovernorAnswerDeps): Promise<void> {
  const missionId = missionOfDecisionId(decision.id);
  const answer = decision.answer;
  if (missionId === null || answer === null || decision.status !== "answered") return;
  try {
    const store = createMissionStore(deps.home, { now: () => deps.now });
    const action = answer.by === "owner" ? chosenGovernorAction(decision, answer.optionKey) : null;
    if (action === null) {
      const how = answer.optionKey === null ? `answered in words: ${answer.words ?? ""}` : "kept the mission as it is";
      store.appendJournal(missionId, { kind: "decision", by: "owner", text: `The owner ${how} (${decision.id}).`, ref: decision.id });
      await tellMain(missionId, decision.id, `The owner ${how} on the governor's card ${decision.id}.`, deps);
      return;
    }
    if (action.kind === "mission-split") {
      const source = store.get(action.missionId);
      const done = source === null ? ({ ok: false, reasons: [`mission ${action.missionId} no longer exists`] } as const) : await executeSplit(source, action.split, "owner", decision.id, { ...deps, paseo: deps.paseo });
      if (!done.ok) {
        deps.log(`[paseo-bm] the owner chose to apply ${decision.id}, but the split could not run: ${done.reasons.join("; ")}`);
        store.appendJournal(missionId, { kind: "decision", by: "plugin", text: `${decision.id} could not be applied: ${done.reasons.join("; ")}`, ref: decision.id });
      }
      return;
    }
    const result = store.update(action.missionId, (mission) => ({ ...mission, charter: { ...mission.charter, goal: action.goal } }));
    if (!result.ok) {
      deps.log(`[paseo-bm] the owner chose to apply ${decision.id}, but it could not be applied: ${result.reasons.join("; ")}`);
      return;
    }
    store.appendJournal(action.missionId, { kind: "charter", by: "owner", text: `The owner applied ${decision.id}: the goal as arbitration ${action.arbitrationId} leaves it.`, ref: decision.id });
    await tellMain(action.missionId, decision.id, `The owner applied the governor's card ${decision.id}: your goal is now ${JSON.stringify(action.goal.slice(0, 300))}.`, deps);
  } catch (error) {
    deps.log(`[paseo-bm] applying ${decision.id} failed: ${errorText(error)}`);
  }
}
