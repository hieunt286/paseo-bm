/**
 * The authority a command of the Orchestrator's goes on, and the two tools
 * that send one (Orchestrator design §6A, §6B.1, §6B.4; autonomy design §A.7,
 * §B.9; ADR-015, ADR-016, ADR-017; code review 2026-09-30 §4).
 *
 * - `bm_send_command` (§6A, §6B.1, ADR-015) sends a command to a paseo-bm
 *   Manager itself, on an authority (`authorityOf`, autonomy design §A.7,
 *   ADR-017): the grant of an Orchestrator decision the owner answered
 *   (`decisionId`), the owner's autonomy policy (every class of its effects
 *   delegated for the project, `policy:<class>`, autonomy design §B.9), or
 *   the owner's own latest inbound message in the Orchestrator's chat
 *   (`isOwnerWord`). It declares its `intent` and `effects`; each declared
 *   effect must be covered — by the grant or the policy for any effect
 *   (ADR-025: a push, publish, deploy, migration, real data, security or cost
 *   where its class is delegated), by the owner's word in the chat only
 *   outside `CONFIRM_EFFECTS`. It is a
 *   `BM-COMMAND` v2 block (`from: orchestrator`, `via: chat`, `authority`,
 *   `approved`, the limits that remain), delivered through the notice queue
 *   (`command:<id>`), and recorded in `orchestrator/proposals.json` with
 *   source `chat`. A grant is spent (`useGrant`) once the command is
 *   delivered. Both send tools, and the delivery of a prepared command an
 *   option chose (`orchestrator-decisions.ts`), go through the one send
 *   pipeline, `command-send.ts`. Without any of the three it is refused:
 *   the Orchestrator asks the owner with `bm_ask_owner`, whose option may
 *   carry the command prepared (autonomy design §A.7).
 * - `bm_direct_worker` (§6B.4, ADR-016) sends a `BM-COMMAND to: worker` to a
 *   paseo-bm Worker under the same authority: through the queue (at its turn
 *   end), or at once with `interrupt: true` only while that Worker's danger
 *   allowance is open; its Manager always gets the same block with `copy:
 *   yes` through the queue. Never a Reviewer.
 * - Neither carries the answer to a question the decision store holds
 *   (change-004, ADR-017): a `BM-ANSWERS` block naming a stored `Qn` of that
 *   request is refused — an open one is answered with `bm_decide`, a settled
 *   one already was (`refuseStoredAnswers`).
 * - Both pass the backstop (`undeclaredCategoriesOf` over `re:` and the body:
 *   a category of the big-decision gate that the declared effects do not
 *   cover refuses with "declare the effect or ask the owner"; nothing
 *   silences it, autonomy design §B.8),
 *   then a loop guard that refuses a 13th command for one request (or one
 *   project, without a request) within 24 hours, counting every delivered
 *   command — the prepared commands an option chose included. A refusal
 *   sends, records and spends nothing.
 * - Not on an unverified finish (autonomy design §C.3, §C.6 change-008 C4):
 *   while the command's request — its own, else its Worker's — stands
 *   finished-unverified (`isFinishedUnverifiedNow`, read from the trace store
 *   at the call), a command on `policy:<class>` that approves `commit` or has
 *   the intent `release` is refused, naming `bm_ask_owner`
 *   (`unverifiedFinishText`). A grant (`decision:<id>`) and the owner's own
 *   word in the chat are the owner's and pass.
 * - A delivered command that answers an event of its wake or the owner's
 *   word in the chat is logged as a coordination intervention, with its
 *   command id (autonomy design §G.3, `command-send.ts`). The log never holds
 *   back or fails the tool.
 * - The command an option of `bm_ask_owner` prepares (`preparedCommandOf`)
 *   goes on the decision's authority, or on the policy's when the policy chose
 *   the option (autonomy design §A.6, §B.5).
 *
 * Only these two tools reach a working agent — a Manager, or a Worker and its
 * Manager. Nothing here sends to a Reviewer, creates, stops or archives, or
 * writes to a repository.
 */
import { currentPolicy } from "./autonomy-store";
import { copyRecipientOf, grantInFlight, sendCommand, type CommandSendResult } from "./command-send";
import { answerBlockOf } from "./decision-materialiser";
import { createDecisionStore } from "./decision-store";
import { readTimelinePages } from "./live-timeline";
import type { NoticePaseo, NoticeQueue } from "./notice-queue";
import { isOwnerWord } from "./orchestrator-agent";
import { commandRequestIdOf, commandSubjectOf } from "./orchestrator-state";
import {
  MESSAGE_PAGES,
  MESSAGE_PAGE_LIMIT,
  json,
  orchestratorOf,
  refuse,
  requireManager,
  wakeEventsNow,
  workingAgentsOf,
  type ServerToolResult,
  type ToolContext,
  type ToolDeps,
} from "./orchestrator-tool-context";
import { commandActsOnFinish, modeOf, unverifiedFinishText, type AutonomyPolicy } from "../shared/autonomy";
import { isFinishedUnverifiedNow } from "./request-trace";
import {
  CLASS_OF_EFFECT,
  CONFIRM_EFFECTS,
  DECISION_CLASSES,
  DEFAULT_DECISION_CLASS,
  decisionKindOf,
  deliveryKindOf,
  grantRefusal,
  notOpenRefusalOf,
  questionDecisionId,
  realEffects,
  type Decision,
  type DecisionClass,
  type DecisionOption,
  type Effect,
} from "../shared/decisions";
import {
  decisionAuthorityOf,
  policyAuthorityOf,
  type CommandAuthority,
  type CommandInput,
  type CommandIntent,
  type CommandTo,
} from "../shared/orchestrator-command";
import { errorText } from "./rpc-kit";

/** Why `bm_send_command` refused, after the classes the owner has not delegated (design §6A; autonomy design §A.7, §B.9). */
export const SEND_REFUSED_MESSAGE =
  "the owner has not just told you to send; ask the owner with bm_ask_owner, with this command prepared on an option";

/** Why `bm_direct_worker` refused for want of authority (design §6B.4: the same rule as `bm_send_command`). */
export const DIRECT_REFUSED_MESSAGE = SEND_REFUSED_MESSAGE;

/** What a command refused on an unverified finish does instead (autonomy design §C.6, change-008 C4). */
export const UNVERIFIED_FINISH_INSTEAD = "ask the owner with bm_ask_owner, with this command prepared on an option";

/** What the two send tools read of the plugin's deps. */
export interface CommandToolDeps extends ToolDeps {
  /** The notice queue `bm_send_command` delivers through; the plugin's shared one by default. */
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

/** Why a command was refused for declaring an effect only a decision covers. */
export function needsDecisionMessageOf(effects: readonly Effect[]): string {
  return `${effects.join(", ")} needs the owner's decision: ask with bm_ask_owner, and once the owner has answered, send with its decisionId`;
}

/**
 * The classes a command's declared effects map to for the owner's policy
 * (autonomy design §B.9): each effect's class (§B.1), `commit` counting as
 * `reversible-technical`, and a command that declares no effect as
 * `reversible-technical` too. Riskiest first (`DECISION_CLASSES` order). Pure.
 */
export function commandClassesOf(effects: readonly Effect[]): DecisionClass[] {
  const classes = new Set(realEffects(effects).map((effect) => CLASS_OF_EFFECT[effect] ?? DEFAULT_DECISION_CLASS));
  if (classes.size === 0) classes.add(DEFAULT_DECISION_CLASS);
  return DECISION_CLASSES.filter((decisionClass) => classes.has(decisionClass));
}

/**
 * What the owner's policy says of a command that answers no decision
 * (autonomy design §B.9): `riskiest`, the class its `policy:<class>` authority
 * would name, and `notDelegated`, its classes that are not `delegate` for the
 * project (`modeOf`), riskiest first. The policy authorises the command only
 * when `notDelegated` is empty — any class, release, data, security and cost
 * included (ADR-025). Pure.
 */
export function policyCoverOf(
  policy: AutonomyPolicy,
  workspaceId: string,
  effects: readonly Effect[],
): { riskiest: DecisionClass; notDelegated: DecisionClass[] } {
  const classes = commandClassesOf(effects);
  return { riskiest: classes[0]!, notDelegated: classes.filter((decisionClass) => modeOf(policy, workspaceId, decisionClass) !== "delegate") };
}

/** A refusal for want of authority, naming the command's classes the owner has not delegated for its project (autonomy design §B.9). */
export function notDelegatedRefusalOf(classes: readonly DecisionClass[], refusal: string): string {
  const named = classes.length < 2 ? classes.join("") : `${classes.slice(0, -1).join(", ")} and ${classes.at(-1)!}`;
  return `${named} ${classes.length < 2 ? "is" : "are"} not delegated in this project and ${refusal}`;
}

/** What `authorityOf` found: on whose authority the command leaves (always `via: chat`), what that covers, and the grant it spends. */
interface CommandAuthorityOf {
  authority: CommandAuthority;
  /** The declared effects, every one covered. */
  approved: Effect[];
  /** The decision whose grant the command spends once delivered; null when it spends none. */
  grantOf: string | null;
}

/**
 * The decision `decisionId` names, when it can authorise this command: one
 * the Orchestrator asked (`o:…`) in this project, answered by the owner, about
 * the command's request when it names one — and, for a command that declares
 * effects, whose grant covers them now (unused, within its hour, every effect
 * granted: `grantRefusal`) and is not being spent by another call.
 */
function answeredDecisionOf(decisionId: string, workspaceId: string, requestId: string | null, declared: readonly Effect[], context: ToolContext): Decision {
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
  // A grant the owner's policy gave holds only what its classes delegated allowed (ADR-025), so the grant check below covers it.
  if (declared.length > 0) {
    const refusal = grantRefusal(decision, declared, context.now.toISOString());
    if (refusal !== null) refuse(`${refusal.message}; ask the owner again with bm_ask_owner`);
    if (grantInFlight(decisionId)) refuse(`the grant of decision ${decisionId} is being used by another command`);
  }
  return decision;
}

/**
 * Who lets the Orchestrator send, and which of the declared effects that
 * covers (autonomy design §A.7, replacing the gate as the authority):
 *
 * - `decisionId`: an Orchestrator decision the owner answered
 *   (`answeredDecisionOf`) — authority `decision:<id>`, covering any effect
 *   its grant covers; the grant is spent on delivery. It needs no word of the
 *   owner in the chat.
 * - else the owner's policy, read now (autonomy design §B.9): when every class
 *   of the declared effects (`commandClassesOf`) is `delegate` for the
 *   project — release, data, security and cost included, at Turbo and Full
 *   auto (ADR-025) —, `policy:<class>` naming the riskiest — unless the command
 *   approves `commit` or has the intent `release` while its request (`finish`:
 *   the command's, else its Worker's) stands finished-unverified (§C.6,
 *   change-008 C4): then only the owner's word in the chat covers it, else it
 *   is refused, naming `bm_ask_owner`.
 * - else a command declaring one of `CONFIRM_EFFECTS` (release, data,
 *   security and cost: experience concept X-4) is refused: beyond the policy
 *   only a grant covers those, never the owner's word in the chat.
 * - else the owner's own latest word in the Orchestrator's chat (`owner`),
 *   else `refusal`, after the classes the owner has not delegated
 *   (`notDelegatedRefusalOf`).
 *
 * Every command leaves `via: chat`: from the Orchestrator's chat, where the
 * owner's word, a decision's answer and its events reach it.
 */
async function authorityOf(
  input: {
    workspaceId: string;
    requestId: string | null;
    decisionId?: string;
    effects: readonly Effect[];
    intent: CommandIntent;
    /** The request whose finish a policy command may not act on: the command's, else its Worker's (change-008 C4). */
    finish: { requestId: string | null; agentId: string | null };
  },
  context: ToolContext,
  refusal: string,
  log?: (message: string) => void,
): Promise<CommandAuthorityOf> {
  const declared = realEffects(input.effects);
  if (input.decisionId !== undefined) {
    answeredDecisionOf(input.decisionId, input.workspaceId, input.requestId, declared, context);
    return { authority: decisionAuthorityOf(input.decisionId), approved: declared, grantOf: declared.length > 0 ? input.decisionId : null };
  }
  // Read at each send, so a cell set back meanwhile refuses the command.
  const policy = policyCoverOf(currentPolicy(context.home), input.workspaceId, declared);
  const needsDecision = declared.filter((effect) => CONFIRM_EFFECTS.includes(effect));
  if (policy.notDelegated.length === 0) {
    // Autonomy design §C.6 (change-008 C4): the policy acts on no unverified finish; read from the trace store now.
    const onFinish =
      commandActsOnFinish({ approved: declared, intent: input.intent }) &&
      (await isFinishedUnverifiedNow(
        { location: context.location, paseo: context.paseo, home: context.home, ...(log === undefined ? {} : { log }) },
        input.workspaceId,
        input.finish,
      ));
    if (!onFinish) return { authority: policyAuthorityOf(policy.riskiest), approved: declared, grantOf: null };
    // The owner's word in the chat never covers what only a decision may (X-4).
    if (needsDecision.length > 0) refuse(unverifiedFinishText(input.finish.requestId, UNVERIFIED_FINISH_INSTEAD));
    if (!(await ownerJustSpoke(context))) refuse(unverifiedFinishText(input.finish.requestId, UNVERIFIED_FINISH_INSTEAD));
    return { authority: "owner", approved: declared, grantOf: null };
  }
  if (needsDecision.length > 0) refuse(needsDecisionMessageOf(needsDecision));
  if (!(await ownerJustSpoke(context))) refuse(notDelegatedRefusalOf(policy.notDelegated, refusal));
  return { authority: "owner", approved: declared, grantOf: null };
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
    }) ?? `${what}: answer it with bm_decide, not in a BM-ANSWERS block`
  );
}

/**
 * Refuses a command whose `BM-ANSWERS` block names a question the decision
 * store holds for that request (change-004; ADR-017: one source of truth,
 * nobody relays): an open one is answered with `bm_decide`, which the plugin
 * delivers once; a settled one was answered or replaced already, and a second
 * answer would reach the Worker twice. The request is the block's own
 * `requestId:`, else one the body names, else `requestId`. A block that names
 * no stored question passes; a store that cannot be read refuses. Reads only.
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
// bm_send_command and bm_direct_worker.
// ---------------------------------------------------------------------------

/** What a command of the Orchestrator declares (autonomy design §A.7). */
interface Declared {
  intent: CommandIntent;
  effects: Effect[];
  /** An Orchestrator decision the owner answered, whose grant covers this command. */
  decisionId?: string;
}

export interface SendInput extends Declared {
  workspaceId: string;
  managerId: string;
  requestId?: string;
  re?: string;
  command: string;
  reason: string;
}

/** What the tool's JSON says about the authority a command went on. */
function authorityFields(granted: CommandAuthorityOf) {
  return { authority: granted.authority, approved: granted.approved };
}

/**
 * Sends a command of the Orchestrator's own, its target and authority
 * checked, through the one send pipeline (`sendCommand`): the block, the
 * backstop and the loop guard, then the grant claimed, the delivery, the grant
 * spent, the command recorded, its intervention logged and the Manager's copy.
 * A refusal there is the tool's; nothing was sent, recorded or spent.
 */
async function sendOwnCommand(
  command: CommandInput,
  target: { workspaceId: string; targetId: string; copyTo: string | null; interrupt?: { open: boolean }; interventionRequestId: string | null },
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
    copyTo: target.copyTo,
    grantOf: granted.grantOf,
    approved: granted.approved,
    backstop: true,
    loopGuard: "refuse",
    ...(target.interrupt === undefined ? {} : { interrupt: target.interrupt }),
    intervention: { requestId: target.interventionRequestId, ownerAsked: granted.authority === "owner", wakeEvents: () => wakeEventsNow(context, deps) },
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

/**
 * `bm_send_command` (design §6A, §6B.1; autonomy design §A.7): checks the
 * Manager, then the authority and what it covers (`authorityOf`), then sends
 * through the one pipeline (`sendOwnCommand`): the block, the backstop and
 * the loop guard, and only then the `BM-COMMAND` block through the notice
 * queue, spending the decision's grant once it is delivered. Its `re:` is the
 * one given, else the command's first line. The command is recorded after
 * delivery (`situation` the `re:`, `command` the body, `reason` the `why:`);
 * a Manager that cannot be reached records and spends nothing.
 */
export async function bmSendCommand(input: SendInput, context: ToolContext, deps: CommandToolDeps): Promise<ServerToolResult> {
  const manager = await requireManager(input, context);
  const requestId = input.requestId ?? null;
  refuseStoredAnswers(input.command, input.workspaceId, requestId, context.home);
  const granted = await authorityOf({ ...input, requestId, finish: { requestId, agentId: null } }, context, SEND_REFUSED_MESSAGE, deps.log);
  const command: CommandInput = {
    from: "orchestrator",
    via: "chat",
    to: "manager",
    requestId,
    re: commandSubjectOf(input.re ?? "") || commandSubjectOf(input.command),
    body: input.command,
    why: input.reason,
    intent: input.intent,
    effects: input.effects,
    authority: granted.authority,
    approved: granted.approved,
  };
  const sent = await sendOwnCommand(
    command,
    { workspaceId: input.workspaceId, targetId: manager.id, copyTo: null, interventionRequestId: requestId },
    granted,
    context,
    deps,
  );

  const said = [
    sent.outcome === "sent"
      ? "Sent. The Manager reads it as a BM-COMMAND block: the owner's word through you, with its authority and the limits that remain."
      : "Queued. The Manager is busy and gets it, as a BM-COMMAND block with its authority and the limits that remain, when its current turn ends.",
    ...(sent.spent === null ? [] : [sent.spent]),
  ].join(" ");
  // Delivered already: say so, so the Orchestrator does not send it again.
  if (sent.unrecorded !== null) return { ok: true, text: unrecordedText(said, sent.unrecorded) };
  return { ok: true, text: `${said} Tell the owner in one line what you sent and why.\n${json({ commandId: sent.id, outcome: sent.outcome, ...authorityFields(granted) })}` };
}

export interface DirectInput extends Declared {
  workspaceId: string;
  workerId: string;
  requestId?: string;
  re: string;
  command: string;
  why?: string;
  interrupt?: boolean;
}

/**
 * `bm_direct_worker` (design §6B.4, ADR-016 decision 2): a command to a
 * non-archived paseo-bm Worker of the project — never a Reviewer — under the
 * authority of `bm_send_command` (`authorityOf`: declared effects, a grant
 * spent once delivered), through the same pipeline: block, backstop and loop
 * guard (`sendOwnCommand`).
 * Delivered as `BM-COMMAND to: worker` through the notice queue (at the
 * Worker's turn end), or with `interrupt: true` — allowed only while that
 * Worker's interrupt allowance is open (`isDangerOpen`) — sent at once, which
 * replaces its running turn. Once the Worker has it, its Manager (the agent
 * that created it, when that is a non-archived paseo-bm Manager of the
 * project, `copyRecipientOf`) gets the same block with `copy: yes` through
 * the queue. Recorded `sent` with `to: "worker"`, `workerId`, and the Manager that got the copy as
 * `managerId` (null when the Worker has none). Every refusal comes before
 * anything is sent. A stop is checked by the backstop like any command: its
 * stop word negates what it stops ("stop the push"); an open danger allowance
 * exempts nothing (autonomy design §B.8).
 */
export async function bmDirectWorker(input: DirectInput, context: ToolContext, deps: CommandToolDeps): Promise<ServerToolResult> {
  const agents = await workingAgentsOf(context);
  const worker = agents.find((candidate) => candidate.id === input.workerId);
  if (worker === undefined || worker.role !== "worker") {
    refuse(`${input.workerId} is not a paseo-bm Worker; use a Worker's id from bm_request (a Reviewer is never commanded directly)`);
  }
  if (worker.workspaceId !== input.workspaceId) refuse(`Worker ${input.workerId} does not belong to project ${input.workspaceId}`);
  if (worker.archived) refuse(`Worker ${input.workerId} is archived; nothing can be sent to it`);
  const requestId = input.requestId ?? null;
  // A block without a request of its own is about the Worker's request.
  refuseStoredAnswers(input.command, input.workspaceId, requestId ?? worker.requestIdLabel, context.home);
  const granted = await authorityOf(
    { ...input, requestId, finish: { requestId: requestId ?? worker.requestIdLabel, agentId: worker.id } },
    context,
    DIRECT_REFUSED_MESSAGE,
    deps.log,
  );
  const manager = copyRecipientOf(agents, worker, input.workspaceId);
  const command: CommandInput = {
    from: "orchestrator",
    via: "chat",
    to: "worker",
    requestId,
    re: input.re,
    body: input.command,
    why: input.why ?? null,
    intent: input.intent,
    effects: input.effects,
    authority: granted.authority,
    approved: granted.approved,
  };
  const interrupt = input.interrupt === true;
  const sent = await sendOwnCommand(
    command,
    {
      workspaceId: input.workspaceId,
      targetId: worker.id,
      copyTo: manager?.id ?? null,
      ...(interrupt ? { interrupt: { open: context.store.isDangerOpen(input.workspaceId, worker.id) } } : {}),
      interventionRequestId: requestId ?? worker.requestIdLabel,
    },
    granted,
    context,
    deps,
  );

  const said = [
    interrupt
      ? "Sent at once: the Worker's running turn was replaced by your command."
      : sent.outcome === "sent"
        ? "Sent. The Worker reads it as a BM-COMMAND block: the owner's word through you, with its authority and the limits that remain."
        : "Queued. The Worker is busy and gets it, as a BM-COMMAND block with its authority and the limits that remain, when its current turn ends.",
    manager === null
      ? "The Worker has no paseo-bm Manager, so no copy was sent."
      : sent.copy !== "failed"
        ? `Its Manager ${manager.id} gets a copy${sent.copy === "queued" ? " when its current turn ends" : ""}.`
        : `The copy to its Manager ${manager.id} could not be delivered; tell the owner.`,
    ...(sent.spent === null ? [] : [sent.spent]),
  ].join(" ");
  if (sent.unrecorded !== null) return { ok: true, text: unrecordedText(said, sent.unrecorded) };
  return {
    ok: true,
    text: `${said} Tell the owner in one line what you told the Worker and why.\n${json({
      commandId: sent.id,
      outcome: sent.outcome,
      interrupted: interrupt,
      managerId: manager?.id ?? null,
      copy: sent.copy,
      ...authorityFields(granted),
    })}`,
  };
}
