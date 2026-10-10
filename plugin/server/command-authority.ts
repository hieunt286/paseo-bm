/**
 * The authority a command of the Orchestrator's goes on, and the two tools
 * that send one (Orchestrator design §6B.4; autonomy design §A.7, §B.9;
 * missions design §9.1, §9.4; ADR-016, ADR-017, ADR-029).
 *
 * - `bm_govern` (missions design §9.4) sends a `BM-COMMAND` to a mission's
 *   current Main: `from: orchestrator`, `authority: governor:<step>` (nudge,
 *   replan, arbitrate), `effects: none`, no request. The authority is
 *   structural, like `coordination:handoff`: the send (`command-send.ts`)
 *   delivers it only to the current Main of an open mission and counts its
 *   loop guard per mission (12 in 24 hours). The figures it names
 *   (`governor-figures.ts`, read now) are appended to its text with their
 *   thresholds. Once delivered it adds a `governor` journal line to the
 *   mission and records itself as the `lastAction` of each family it
 *   concerns on the ladder (`governor-store.ts`): a nudge takes a family at
 *   step 1 to 2 (its window counts from now), a re-plan one at step 3 to 4
 *   (escalate or stop); any other step on a family at step 1 or 2 restarts
 *   its window, both its minutes and its Main turns.
 * - `bm_direct_worker` (§6B.4, ADR-016; narrowed by missions design §9.1)
 *   only stops a paseo-bm Worker at once (`intent: stop`, `interrupt: true`,
 *   no effect), and only while a danger signal of that Worker is open or a
 *   family of its mission stands at the governor's stop step (4). Its
 *   authority (`stopAuthorityOf`): an Orchestrator decision the owner
 *   answered (`decisionId`, which grants nothing), the owner's policy delegating
 *   `reversible-technical` for the project (`policy:reversible-technical`,
 *   autonomy design §B.9), or the owner's own latest inbound message in the
 *   Orchestrator's chat (`isOwnerWord`). Its Main (else its Manager) gets
 *   the same block with `copy: yes` through the queue. Never a Reviewer.
 * - A stop never carries the answer to a question the decision store holds
 *   (change-004, ADR-017): a `BM-ANSWERS` block naming a stored `Qn` of that
 *   request is refused (`refuseStoredAnswers`).
 * - Both pass the backstop (`undeclaredCategoriesOf` over `re:` and the body:
 *   a category of the big-decision gate refuses, autonomy design §B.8). A
 *   refusal sends and records nothing.
 * - A delivered command that answers an event of its wake or the owner's
 *   word in the chat is logged as a coordination intervention, with its
 *   command id (autonomy design §G.3, `command-send.ts`); a `bm_govern` step
 *   as a `govern`, and a stop only the governor's stop step allowed as a
 *   `stop`, trigger `governor` (missions design §9.3). The log never holds
 *   back or fails the tool.
 * - The command an option of `bm_ask_owner` prepares (`preparedCommandOf`)
 *   goes on the decision's authority, or on the policy's when the policy chose
 *   the option (autonomy design §A.6, §B.5).
 *
 * Only these two tools reach a working agent — a Main, or a Worker and its
 * Main. Nothing here sends to a Reviewer, creates, archives, or writes to a
 * repository.
 */
import { currentPolicy } from "./autonomy-store";
import { copyRecipientOf, sendCommand, type CommandSendResult } from "./command-send";
import { readCoordinationSettings } from "./coordination-rpc";
import { answerBlockOf } from "./decision-materialiser";
import { createDecisionStore } from "./decision-store";
import { GOVERNOR_FAMILIES, GOVERNOR_FIGURES, figureText, type GovernorFigure, type GovernorFigureId } from "../shared/governor-figures";
import { governorFiguresOf, readGovernorSnapshot } from "./governor-figures";
import { createGovernorStore, type MissionLadder } from "./governor-store";
import { interventionOfGovern, recordIntervention } from "./intervention-store";
import { readTimelinePages } from "./live-timeline";
import { createMissionStore, type Mission } from "./mission-store";
import { missionsHomeIdOf } from "./missions-home";
import type { NoticePaseo, NoticeQueue } from "./notice-queue";
import { isOwnerWord } from "./orchestrator-agent";
import { commandRequestIdOf, commandSubjectOf } from "./orchestrator-state";
import {
  MESSAGE_PAGES,
  MESSAGE_PAGE_LIMIT,
  json,
  missionOfRequest,
  orchestratorOf,
  refuse,
  wakeEventsNow,
  workingAgentsOf,
  type ServerToolResult,
  type ToolContext,
  type ToolDeps,
} from "./orchestrator-tool-context";
import { bmAgentsOf } from "./paseo-directory";
import { modeOf } from "../shared/autonomy";
import {
  DEFAULT_DECISION_CLASS,
  decisionKindOf,
  deliveryKindOf,
  notOpenRefusalOf,
  questionDecisionId,
  realEffects,
  type Decision,
  type DecisionClass,
  type DecisionOption,
  type Effect,
} from "../shared/decisions";
import {
  MAX_COMMAND_BODY_CHARS,
  decisionAuthorityOf,
  governorAuthorityOf,
  policyAuthorityOf,
  type CommandAuthority,
  type CommandInput,
  type CommandIntent,
  type CommandTo,
  type GovernorStep,
} from "../shared/orchestrator-command";
import { errorText } from "./rpc-kit";
import { fixThese } from "./tool-kit";

/** Why `bm_direct_worker` refused for want of authority (design §6B.4). */
export const DIRECT_REFUSED_MESSAGE =
  "the owner has not just told you to stop it; ask the owner with bm_ask_owner, and once the owner has answered, stop it with that decisionId";

/** Why `bm_direct_worker` refused a call that is not a stop at once (missions design §9.1). */
export const STOP_ONLY_MESSAGE = "bm_direct_worker only stops a Worker at once (intent stop, interrupt: true); anything else goes to its Main with bm_govern";

/** Why `bm_direct_worker` refused a stop while nothing allows one (missions design §9.1, §9.3). */
export const STOP_NOT_OPEN_MESSAGE =
  "a Worker is stopped only while a danger signal of it is open or a family of its mission stands at the governor's stop step (4); tell its Main with bm_govern instead";

/** The governor's stop step (missions design §9.3: 4, escalate or stop). */
export const GOVERNOR_STOP_STEP = 4;

/** What the two send tools read of the plugin's deps. */
export interface CommandToolDeps extends ToolDeps {
  /** The notice queue a command is delivered through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
}

/**
 * Whether the owner has just spoken in the Orchestrator's own chat (design
 * §6A (b), ADR-015 decision 3): the latest inbound message of its timeline is
 * the owner's own words (`isOwnerWord`: a `user_message` carrying
 * `clientMessageId` that is neither a plugin notice nor one of the plugin's
 * prompts). The calling agent is the one Orchestrator
 * (`findOrchestratorAgent`, over the call's walk of `agents.list`): the
 * endpoint's path secret is given to it alone.
 * No Orchestrator, or a timeline that cannot be read → false.
 */
export async function ownerJustSpoke(context: ToolContext): Promise<boolean> {
  const orchestrator = await orchestratorOf(context);
  if (orchestrator === null) return false;
  // Pages come newest first, each oldest first inside.
  const pages: Array<Array<{ item?: unknown }>> = [];
  await readTimelinePages(context.paseo, orchestrator.id, { pages: MESSAGE_PAGES, limit: MESSAGE_PAGE_LIMIT }, (entries) => pages.unshift(entries));
  const latest = pages
    .flat()
    .map((entry) => entry.item as { type?: unknown } | null | undefined)
    .filter((item) => item?.type === "user_message")
    .at(-1);
  return isOwnerWord(latest);
}

/** A refusal for want of authority, naming the command's classes the owner has not delegated for its project (autonomy design §B.9). */
export function notDelegatedRefusalOf(classes: readonly DecisionClass[], refusal: string): string {
  const named = classes.length < 2 ? classes.join("") : `${classes.slice(0, -1).join(", ")} and ${classes.at(-1)!}`;
  return `${named} ${classes.length < 2 ? "is" : "are"} not delegated in this project and ${refusal}`;
}

/** What `stopAuthorityOf` found: on whose authority the command leaves (always `via: chat`). A stop approves no effect and spends no grant (ADR-031). */
interface CommandAuthorityOf {
  authority: CommandAuthority;
}

/**
 * Refuses unless `decisionId` names a decision the Orchestrator asked
 * (`o:…`, or the owner's override of one) in this project, answered by the
 * owner, about the stop's request when it names one.
 */
function answeredDecisionOf(decisionId: string, workspaceId: string, requestId: string | null, context: ToolContext): void {
  const notYours = `${decisionId} is not a decision you asked; decisionId takes the id (o:…) of your own decision the owner answered`;
  // Autonomy design §B.7: the owner's override (r:…) of one of your decisions authorises as that decision's answer would.
  const kind = decisionKindOf(decisionId);
  if (kind !== "orchestrator" && kind !== "override") refuse(notYours);
  let decision: Decision | null;
  try {
    decision = createDecisionStore(context.home).get(decisionId, workspaceId);
  } catch (error) {
    refuse(`the decisions of project ${workspaceId} cannot be read: ${errorText(error)}`);
  }
  if (decision === null) refuse(`no decision ${decisionId} in project ${workspaceId}`);
  if (kind === "override" && deliveryKindOf(decision) !== "orchestrator") refuse(notYours);
  if (decision.status !== "answered") refuse(`decision ${decisionId} is ${decision.status}; only a decision the owner answered authorises a command`);
  if (decision.requestId !== null && decision.requestId !== requestId) {
    refuse(`decision ${decisionId} is about request ${decision.requestId}; a command on its authority names that request`);
  }
}

/**
 * Who lets the Orchestrator stop a Worker (autonomy design §A.7, §B.9): an
 * Orchestrator decision the owner answered (`decision:<id>`); else the
 * owner's policy, read now, when `reversible-technical` (a command with no
 * effect) is `delegate` for the project (`policy:reversible-technical`); else
 * the owner's own latest word in the Orchestrator's chat (`owner`); else
 * refused, naming the class.
 */
async function stopAuthorityOf(input: { workspaceId: string; requestId: string | null; decisionId?: string }, context: ToolContext): Promise<CommandAuthorityOf> {
  if (input.decisionId !== undefined) {
    answeredDecisionOf(input.decisionId, input.workspaceId, input.requestId, context);
    return { authority: decisionAuthorityOf(input.decisionId) };
  }
  // Read at each send, so a cell set back meanwhile refuses the command.
  if (modeOf(currentPolicy(context.home), input.workspaceId, DEFAULT_DECISION_CLASS) === "delegate") {
    return { authority: policyAuthorityOf(DEFAULT_DECISION_CLASS) };
  }
  if (!(await ownerJustSpoke(context))) refuse(notDelegatedRefusalOf([DEFAULT_DECISION_CLASS], DIRECT_REFUSED_MESSAGE));
  return { authority: "owner" };
}

/** Why a command's `BM-ANSWERS` line for this stored Worker question is refused (change-004). */
export function storedAnswerRefusalOf(questionId: string, decision: Decision): string {
  const what = `${questionId} of ${decision.requestId ?? "its request"} is the stored decision ${decision.id}`;
  return (
    notOpenRefusalOf(decision, {
      needsConfirmation: `${what}, waiting for the owner to confirm an answer typed in a chat: it is the owner's`,
      answered: (by) => `${what}, already answered by ${by}: the plugin delivers that answer itself, so send nothing for it`,
      superseded: (by) => `${what}, superseded${by === null ? "" : ` by ${by}`}: it can no longer be answered`,
      closed: (status) => `${what}, ${status}: it can no longer be answered`,
    }) ?? `${what}: its Main or the owner answers it, never a BM-ANSWERS block of yours`
  );
}

/**
 * Refuses a command whose `BM-ANSWERS` block names a question the decision
 * store holds for that request (change-004; ADR-017: one source of truth,
 * nobody relays). The request is the block's own `requestId:`, else one the
 * body names, else `requestId`. A block that names no stored question
 * passes; a store that cannot be read refuses. Reads only.
 */
function refuseStoredAnswers(body: string, workspaceId: string, requestId: string | null, home: string): void {
  const block = answerBlockOf(body, requestId);
  if (block === null || block.answers.length === 0) return;
  let stored: Array<{ questionId: string; decision: Decision }> = [];
  try {
    const store = createDecisionStore(home);
    stored = block.answers.flatMap((answer) => {
      const decision = store.get(questionDecisionId(block.requestId, answer.id), workspaceId);
      return decision === null ? [] : [{ questionId: answer.id, decision }];
    });
  } catch (error) {
    refuse(`the decisions of project ${workspaceId} cannot be read to check the BM-ANSWERS block (${errorText(error)}); nothing was sent`);
  }
  if (stored.length > 0) refuse(stored.map(({ questionId, decision }) => storedAnswerRefusalOf(questionId, decision)).join("; "));
}

// ---------------------------------------------------------------------------
// The command a decision's option prepares (autonomy design §A.6, §B.5).
// ---------------------------------------------------------------------------

/**
 * The `why:` line of a prepared command, which the plugin writes when the
 * owner picks its option (`orchestrator-decisions.ts`).
 */
export function preparedWhyOf(label: string, decisionId: string): string {
  return `The owner chose "${label.replace(/\s+/g, " ").trim()}" on decision ${decisionId}.`;
}

/**
 * The `why:` line of a prepared command the owner's policy chose (autonomy
 * design §B.5). Shorter than `preparedWhyOf`'s for the same option, so every
 * command `bm_ask_owner` accepted can also be written on the policy's authority.
 */
export function policyWhyOf(label: string, decisionId: string): string {
  return `Policy chose "${label.replace(/\s+/g, " ").trim()}" on decision ${decisionId}.`;
}

/**
 * The `BM-COMMAND` a prepared command becomes when its option is picked
 * (autonomy design §A.6): from the Orchestrator, which prepared it, via the
 * owner's tap on the option (`via: tab`), on the authority of the decision, with `approved` the
 * option's effects the answer granted — so no limit contradicts them. When the
 * owner's policy chose the option (`policyClass`, autonomy design §B.5), it
 * goes on the policy's authority instead, `policy:<class>`, and `via: chat` as
 * every command on that authority does (§A.7): nobody tapped.
 */
export function preparedCommandOf(
  decision: Pick<Decision, "id" | "requestId">,
  option: Pick<DecisionOption, "label">,
  action: { to: CommandTo; intent: CommandIntent; body: string; effects: readonly Effect[] },
  approved: readonly Effect[],
  policyClass: DecisionClass | null = null,
): CommandInput {
  return {
    from: "orchestrator",
    via: policyClass === null ? "tab" : "chat",
    to: action.to,
    requestId: commandRequestIdOf(decision.requestId),
    re: commandSubjectOf(option.label) || commandSubjectOf(action.body),
    body: action.body,
    why: policyClass === null ? preparedWhyOf(option.label, decision.id) : policyWhyOf(option.label, decision.id),
    intent: action.intent,
    effects: realEffects(action.effects),
    authority: policyClass === null ? decisionAuthorityOf(decision.id) : policyAuthorityOf(policyClass),
    approved: realEffects(approved),
  };
}

// ---------------------------------------------------------------------------
// bm_govern and bm_direct_worker.
// ---------------------------------------------------------------------------

/**
 * Sends a command of the Orchestrator's own, its target and authority
 * checked, through the one send pipeline (`sendCommand`): the block, the
 * backstop and the loop guard, then the delivery, the command recorded, its
 * intervention logged and the Main's copy. A refusal there is the tool's;
 * nothing was sent or recorded.
 */
async function sendOwnCommand(
  command: CommandInput,
  target: {
    workspaceId: string;
    targetId: string;
    copyTo: string | null;
    missionId?: string;
    interrupt?: { open: boolean };
    interventionRequestId: string | null;
    /** The caller logs the intervention itself (a governor step, missions design §9.3). */
    governorLogged?: true;
    /** The Orchestrator's own words, when the plugin wrote the rest of the block (`CommandSend.backstopText`). */
    backstopText?: string;
  },
  granted: CommandAuthorityOf,
  context: ToolContext,
  deps: CommandToolDeps,
): Promise<Extract<CommandSendResult, { ok: true }>> {
  const result = await sendCommand({
    home: context.home,
    now: context.now,
    paseo: context.paseo as unknown as NoticePaseo,
    workspaceId: target.workspaceId,
    command,
    targetId: target.targetId,
    ...(target.missionId === undefined ? {} : { missionId: target.missionId }),
    copyTo: target.copyTo,
    backstop: true,
    ...(target.backstopText === undefined ? {} : { backstopText: target.backstopText }),
    loopGuard: "refuse",
    ...(target.interrupt === undefined ? {} : { interrupt: target.interrupt }),
    intervention:
      target.governorLogged === true
        ? null
        : { requestId: target.interventionRequestId, ownerAsked: granted.authority === "owner", wakeEvents: () => wakeEventsNow(context, deps) },
    ...(deps.queue === undefined ? {} : { queue: deps.queue }),
    ...(deps.store === undefined ? {} : { store: deps.store }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
  if (!result.ok) refuse(result.stage === "delivery" ? `${result.reason}; nothing was sent` : result.reason);
  return result;
}

/** What the tool says when the command went out but could not be recorded: so the Orchestrator does not send it again. */
function unrecordedText(said: string, problem: string): string {
  return `${said} The plugin could not record it (${problem}); do not send it again, and tell the owner in one line.`;
}

export interface GovernInput {
  missionId: string;
  step: GovernorStep;
  text: string;
  /** Figure ids (`GOVERNOR_FIGURES`) whose values and thresholds the command cites. */
  figures?: string[];
  /** The Orchestrator's own words in `text`, when the plugin wrote the rest (`bm_arbitrate`); `text` otherwise. */
  ownWords?: string;
}

/**
 * The ladder after a governor command (missions design §9.3): each family it
 * concerns — the families of the figures it names, else (but for an
 * arbitration) every family above step 0 — records it as its `lastAction`; a
 * nudge takes a family at step 1 to 2, a re-plan one at step 3 to the stop
 * step. A family at step 1 or 2 counts its window from the step: from its
 * `at` (the minutes) and from `mainTurns` (the Main's turns), whatever the
 * step. A family at step 0 is left as it is. Pure.
 */
export function governedLadderOf(ladder: MissionLadder, step: GovernorStep, figures: readonly GovernorFigureId[], action: { at: string; id: string; mainTurns: number }): MissionLadder {
  const named = new Set(figures.map((id) => GOVERNOR_FIGURES[id]));
  const next: MissionLadder = { ...ladder };
  for (const family of GOVERNOR_FAMILIES) {
    const state = ladder[family];
    if (state === undefined || state.step === 0) continue;
    if (named.size > 0 ? !named.has(family) : step === "arbitrate") continue;
    const lastAction = { at: action.at, kind: step, id: action.id };
    if (step === "nudge" && state.step === 1) next[family] = { ...state, step: 2, lastAction, mainTurnsAt: action.mainTurns };
    else if (step === "replan" && state.step === 3) next[family] = { ...state, step: GOVERNOR_STOP_STEP, lastAction };
    // In the window (§9.3): the step restarts its minutes (`lastAction.at`) and its Main turns alike.
    else if (state.step <= 2) next[family] = { ...state, lastAction, mainTurnsAt: action.mainTurns };
    else next[family] = { ...state, lastAction };
  }
  return next;
}

/** A governor command delivered (`governSend`), or the tool's refusal of its input. */
export type GovernSent =
  | {
      ok: true;
      /** The command's id; `unrecorded` says why the commands store does not hold it, else null. */
      id: string;
      outcome: "sent" | "queued";
      unrecorded: string | null;
      mission: Mission;
      /** The figures it named, as sent. */
      figures: GovernorFigure[];
    }
  | { ok: false; text: string };

/**
 * A governor command to the mission's current Main (`bm_govern`, and
 * `bm_arbitrate`'s two): `from: orchestrator`, `authority: governor:<step>`,
 * `effects: none`, `re: Governor: <step>, mission <code>` — its text, then the
 * figures it names (read now, with their thresholds; the snapshot is read
 * only for named figures, a nudge or a re-plan, whose families' windows
 * count the Main's turns — an arbitration naming none concerns no family).
 * The send checks the target (the current Main of an open mission), the
 * backstop and the loop guard per mission. Once delivered: a `governor`
 * journal line by `orchestrator`, its command id as `ref`, the ladder's
 * `lastAction` (`governedLadderOf`, read and written in one update) and the
 * `govern` intervention; a journal or ladder that cannot be written is one log
 * line, the command stands. Throws a `Refusal` for a refused send.
 */
export async function governSend(input: GovernInput, context: ToolContext, deps: CommandToolDeps): Promise<GovernSent> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const missions = createMissionStore(context.home);
  const mission = missions.get(input.missionId);
  if (mission === null) refuse(`no mission ${input.missionId}; use a missionId bm_missions gave`);
  const known = Object.keys(GOVERNOR_FIGURES);
  const unknown = (input.figures ?? []).filter((id) => !known.includes(id));
  if (unknown.length > 0) return fixThese("bm_govern", unknown.map((id) => `input.figures: ${id} is not a figure; the figures are ${known.join(", ")}`));
  const named = [...new Set(input.figures ?? [])] as GovernorFigureId[];
  let snapshot: ReturnType<typeof readGovernorSnapshot> | null = null;
  let figures: GovernorFigure[] = [];
  if (named.length > 0 || input.step !== "arbitrate") {
    const settings = readCoordinationSettings({ home: context.home, log });
    snapshot = readGovernorSnapshot(context.home, mission, { now: context.now, agents: await bmAgentsOf(context.paseo), settings, log });
    figures = governorFiguresOf(snapshot, settings.governor).filter((entry) => named.includes(entry.id));
  }
  const body = [input.text.trim(), ...(figures.length === 0 ? [] : ["", "Figures:", ...figures.map((entry) => `- ${figureText(entry)}`)])].join("\n");
  if (body.length > MAX_COMMAND_BODY_CHARS) {
    return fixThese("bm_govern", [`input.text: with the figures' lines (${body.length - input.text.trim().length} characters) it must be at most ${MAX_COMMAND_BODY_CHARS - (body.length - input.text.trim().length)} characters`]);
  }
  const workspaceId = missionsHomeIdOf(context.home) ?? mission.legacyWorkspaceId ?? mission.missionId;
  const command: CommandInput = {
    from: "orchestrator",
    via: "chat",
    to: "manager",
    requestId: null,
    re: `Governor: ${input.step}, mission ${mission.code}`,
    body,
    intent: "other",
    effects: [],
    authority: governorAuthorityOf(input.step),
    approved: [],
  };
  const sent = await sendOwnCommand(
    command,
    {
      workspaceId,
      // The send refuses a mission without a Main, or a Main that is not the current one.
      targetId: mission.mainId ?? "",
      missionId: mission.missionId,
      copyTo: null,
      interventionRequestId: null,
      governorLogged: true,
      // The backstop reads the Orchestrator's words, not the mission's code in re: nor the figures' lines.
      backstopText: input.ownWords ?? input.text,
    },
    { authority: command.authority! },
    context,
    deps,
  );
  try {
    missions.appendJournal(mission.missionId, { kind: "governor", by: "orchestrator", text: `${input.step}: ${commandSubjectOf(input.text)}`, ref: sent.id });
  } catch (error) {
    log(`[paseo-bm] bm_govern could not write the journal of mission ${mission.code}: ${errorText(error)}`);
  }
  // The families the step concerns: those whose last action it now is.
  let families: string[] = [];
  try {
    const action = { at: context.now.toISOString(), id: sent.id, mainTurns: snapshot?.mainTurnEnds.length ?? 0 };
    const next = createGovernorStore(context.home).update(mission.missionId, (current) => governedLadderOf(current, input.step, named, action));
    families = GOVERNOR_FAMILIES.filter((family) => next[family]?.lastAction?.id === sent.id);
  } catch (error) {
    log(`[paseo-bm] bm_govern could not write the ladder of mission ${mission.code}: ${errorText(error)}`);
  }
  // Missions design §9.3: the intervention log (A-12) records each step 2–4.
  recordIntervention(
    context.home,
    interventionOfGovern({ workspaceId, missionId: mission.missionId, mainId: mission.mainId, step: input.step, families, commandId: sent.id }),
    { now: () => context.now, log },
  );
  return { ok: true, id: sent.id, outcome: sent.outcome, unrecorded: sent.unrecorded, mission, figures };
}

/** `bm_govern` (missions design §9.4): `governSend`, and what it did in words. */
export async function bmGovern(input: GovernInput, context: ToolContext, deps: CommandToolDeps): Promise<ServerToolResult> {
  const sent = await governSend(input, context, deps);
  if (!sent.ok) return sent;
  const { mission } = sent;
  const said =
    sent.outcome === "sent"
      ? `Sent to ${mission.mainId}, the Main of mission ${mission.code}, as a BM-COMMAND on governor:${input.step}.`
      : `Queued: the Main of mission ${mission.code} gets it, as a BM-COMMAND on governor:${input.step}, when its current turn ends.`;
  if (sent.unrecorded !== null) return { ok: true, text: unrecordedText(said, sent.unrecorded) };
  return { ok: true, text: `${said}\n${json({ commandId: sent.id, outcome: sent.outcome, missionId: mission.missionId, mainId: mission.mainId, figures: sent.figures.map(figureText) })}` };
}

export interface DirectInput {
  workspaceId: string;
  workerId: string;
  requestId?: string;
  re: string;
  command: string;
  why?: string;
  intent: "stop";
  interrupt: boolean;
  /** An Orchestrator decision the owner answered, on whose authority the stop goes. */
  decisionId?: string;
}

/** The families of the mission that stand at the governor's stop step (missions design §9.3). Reads only. */
function stopFamiliesOf(home: string, missionId: string | null): string[] {
  if (missionId === null) return [];
  const ladder = createGovernorStore(home).ladder(missionId);
  return GOVERNOR_FAMILIES.filter((family) => (ladder[family]?.step ?? 0) >= GOVERNOR_STOP_STEP);
}

/**
 * `bm_direct_worker` (design §6B.4, ADR-016 decision 2; missions design
 * §9.1): stops a non-archived paseo-bm Worker of the project at once — never
 * a Reviewer — replacing its running turn with a `BM-COMMAND to: worker`,
 * `intent: stop`, no effect. Refused unless `interrupt: true`, and unless a
 * danger signal of that Worker is open (`isDangerOpen`) or a family of its
 * request's mission stands at the governor's stop step (`stopFamiliesOf`).
 * Its authority is `stopAuthorityOf`'s; the pipeline checks the block, the
 * backstop and the loop guard. Once the Worker has it, its Main (else its
 * Manager, `copyRecipientOf`) gets the same block with `copy: yes` through
 * the queue. Recorded `sent` with `to: "worker"`, `workerId`, and the agent
 * that got the copy as `managerId`. Every refusal comes before anything is
 * sent.
 */
export async function bmDirectWorker(input: DirectInput, context: ToolContext, deps: CommandToolDeps): Promise<ServerToolResult> {
  if (input.intent !== "stop" || input.interrupt !== true) refuse(STOP_ONLY_MESSAGE);
  const agents = await workingAgentsOf(context);
  const worker = agents.find((candidate) => candidate.id === input.workerId);
  if (worker === undefined || worker.role !== "worker") {
    refuse(`${input.workerId} is not a paseo-bm Worker; use a Worker's id from bm_request (a Reviewer is never commanded directly)`);
  }
  if (worker.workspaceId !== input.workspaceId) refuse(`Worker ${input.workerId} does not belong to project ${input.workspaceId}`);
  if (worker.archived) refuse(`Worker ${input.workerId} is archived; nothing can be sent to it`);
  const requestId = input.requestId ?? null;
  const missionId = missionOfRequest(context.home, requestId ?? worker.requestIdLabel)?.missionId ?? null;
  // Missions design §9.3: a stop only the governor's stop step allows is that step's intervention, logged here.
  const governorStop = context.store.isDangerOpen(input.workspaceId, worker.id) ? null : stopFamiliesOf(context.home, missionId);
  if (governorStop !== null && governorStop.length === 0) refuse(STOP_NOT_OPEN_MESSAGE);
  // A block without a request of its own is about the Worker's request.
  refuseStoredAnswers(input.command, input.workspaceId, requestId ?? worker.requestIdLabel, context.home);
  const granted = await stopAuthorityOf({ workspaceId: input.workspaceId, requestId, ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }) }, context);
  const manager = copyRecipientOf(agents, worker, input.workspaceId, context.home);
  const command: CommandInput = {
    from: "orchestrator",
    via: "chat",
    to: "worker",
    requestId,
    re: input.re,
    body: input.command,
    why: input.why ?? null,
    intent: "stop",
    effects: [],
    authority: granted.authority,
    approved: [],
  };
  const sent = await sendOwnCommand(
    command,
    {
      workspaceId: input.workspaceId,
      targetId: worker.id,
      copyTo: manager?.id ?? null,
      interrupt: { open: true },
      interventionRequestId: requestId ?? worker.requestIdLabel,
      ...(governorStop === null ? {} : { governorLogged: true as const }),
    },
    granted,
    context,
    deps,
  );
  if (governorStop !== null) {
    recordIntervention(
      context.home,
      {
        kind: "stop",
        workspaceId: input.workspaceId,
        requestId: requestId ?? worker.requestIdLabel,
        targetAgentId: worker.id,
        trigger: "governor",
        commandId: sent.id,
        ...(missionId === null ? {} : { missionId }),
        families: governorStop,
      },
      { now: () => context.now, ...(deps.log === undefined ? {} : { log: deps.log }) },
    );
  }

  const said = [
    "Stopped: the Worker's running turn was replaced by your command.",
    manager === null
      ? "The Worker has no paseo-bm Main or Manager, so no copy was sent."
      : sent.copy !== "failed"
        ? `Its Main ${manager.id} gets a copy${sent.copy === "queued" ? " when its current turn ends" : ""}.`
        : `The copy to its Main ${manager.id} could not be delivered; tell the owner.`,
  ].join(" ");
  if (sent.unrecorded !== null) return { ok: true, text: unrecordedText(said, sent.unrecorded) };
  return {
    ok: true,
    text: `${said} Tell the owner in one line what you stopped and why.\n${json({
      commandId: sent.id,
      outcome: sent.outcome,
      interrupted: true,
      managerId: manager?.id ?? null,
      copy: sent.copy,
      authority: granted.authority,
      approved: [],
    })}`,
  };
}
