/**
 * The Orchestrator's decision tools (Orchestrator design §6A, §6B.4; autonomy
 * design §A.3, §A.6, §A.9, §B.3, §B.5, §B.9; change-004; code review
 * 2026-09-30 §3.4, §4).
 *
 * - `bm_ask_owner` (§6A, §6B.4; autonomy design §A.3, §A.6) stores an open
 *   `o:` decision in the decision store (`decision-store.ts`), each option
 *   with its declared effects and, optionally, a prepared command the plugin
 *   delivers itself once the owner picks it (`orchestrator-decisions.ts`); its
 *   class is the riskier of the one proposed and its effects' (autonomy design
 *   §B.1). It replaces the Orchestrator's open decision of the same request unless
 *   `separate`, and says which one it replaced; it sends nothing itself. An
 *   owner precedent (§B.6) may answer it at once (`resolveAtOpen`,
 *   `policy-resolve.ts`) while the loop guard has room for its request; that
 *   answer is delivered as the owner's would be. The policy never answers an
 *   `o:` decision: it is the owner's. An option may carry a
 *   prepared change of the owner's settings instead of a command (§G.4:
 *   `precedent.save`, `autonomy.set`, `coordination.set`), checked as the
 *   owner's Settings check it and written out on the question the owner
 *   reads; such a decision is the owner's alone (no precedent or policy
 *   answers it, it records no prediction), and the plugin applies the change
 *   only on the owner's own answer (`orchestrator-decisions.ts`). A decision
 *   left to the owner that carries one, or that is about a whole project in
 *   the wake of its `advice.due`, is logged as an `advice` intervention.
 * - `bm_decisions` (autonomy design §A.9) lists stored decisions, read-only
 *   (`decision-tools.ts`).
 * - `bm_decide` (change-004; autonomy design §B.5, §B.9) decides for the
 *   owner an open decision the Orchestrator did not ask (`q:`, `f:`) whose
 *   class the owner's policy delegates — a `delegate` cell, any class
 *   (`decideRefusalOf`, ADR-025) — answering `by: policy`
 *   with its reason, and hands it to the delivery the owner's answers take
 *   (`onSettled`); it is logged as an `answer` intervention
 *   (`recordInterventionOf`). The log never holds back or fails the tool.
 * - `bm_predict` (autonomy design §B.3, §B.9) records the challenger's
 *   prediction of the owner's answer (`prediction.orchestrator`) on an open
 *   decision the Orchestrator did not ask, of any class in an `owner` or
 *   `shadow` cell, where the project's prediction switch is on (a level of 1
 *   or more), once (`predictionRefusalOf`). The owner sees it as the
 *   Orchestrator's proposal on the decision's card (ADR-025). It answers
 *   nothing, sends nothing and is no intervention; A-7 counts it as its
 *   wake's action.
 *
 * `bm_decide` and `bm_predict` write through one step, `transitionUnderPolicy`.
 * Nothing here sends to an agent.
 */
import { randomUUID } from "node:crypto";
import { currentPolicy } from "./autonomy-store";
import { redactText } from "./collector";
import { ownerJustSpoke, preparedCommandOf } from "./command-authority";
import { COMMAND_LIMIT_PER_REQUEST, COMMAND_LIMIT_WINDOW_HOURS, loopGuardFull } from "./command-send";
import type { OnDecisionsSettled } from "./decision-rpc";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { decisionsText, type DecisionsQuery } from "./decision-tools";
import { interventionOfAdvice, interventionOfDecision, recordIntervention } from "./intervention-store";
import { commandRequestIdOf } from "./orchestrator-state";
import { preparedChangeFactsOf } from "./prepared-changes";
import { isFinishedUnverifiedNow } from "./request-trace";
import {
  Refusal,
  fixThese,
  json,
  orchestratorIdOf,
  refuse,
  requireManager,
  requireProject,
  wakeEventsNow,
  workingAgentsOf,
  type ServerToolResult,
  type ToolContext,
  type ToolDeps,
} from "./orchestrator-tool-context";
import { resolveAtOpen } from "./policy-resolve";
import { undeclaredCategoriesOf } from "../shared/decision-gate";
import { actsOnFinish, decideRefusalOf, predictionRefusalOf, type AutonomyPolicy } from "../shared/autonomy";
import {
  MAX_ANSWER_REASON_CHARS,
  MAX_ASK_OWNER_OPTIONS,
  MAX_DECISION_TEXT_CHARS,
  UNSETTLED_STATUSES,
  answerDecision,
  carriesPreparedChange,
  checkedClass,
  decisionClassOf,
  declaredEffects,
  decisionKindOf,
  openingPrediction,
  realEffects,
  type Decision,
  type DecisionClass,
  type DecisionOption,
  type Effect,
  type TransitionResult,
} from "../shared/decisions";
import { commandInputProblems, type CommandTo, type DeclaredCommandIntent } from "../shared/orchestrator-command";
import { preparedChangeCheckOf, preparedChangeLinesOf, preparedChangeOfInput, type PreparedChangeFacts, type PreparedChangeInput } from "../shared/prepared-changes";
import { timeOrZero } from "../shared/time";
import { errorText } from "./rpc-kit";

/** What the decision tools read of the plugin's deps. */
export interface DecideToolDeps extends ToolDeps {
  /** A new assessment id, and the part after `o:` of a new decision id; `randomUUID` by default. Proposal ids come from the store. */
  newId?: () => string;
  /**
   * Where a decision answered here goes — a `bm_ask_owner` decision an owner
   * precedent or the owner's policy answered at once, a decision `bm_decide`
   * decided: the same delivery hook the owner's answers go
   * to (`settledByKind` in `index.server.ts`, autonomy design §A.6). None by
   * default: the answer is only stored, and a later delivery, or the next
   * plugin run, sends it.
   */
  onSettled?: OnDecisionsSettled;
}

/**
 * Hands a decision answered here to `onSettled`, the delivery the owner's
 * answers take; a failing delivery is one log line saying `how` it was
 * answered, and the answer stands.
 */
async function settle(answered: Decision, how: string, context: ToolContext, deps: DecideToolDeps): Promise<void> {
  if (deps.onSettled === undefined) return;
  try {
    await deps.onSettled([answered], { paseo: context.paseo });
  } catch (error) {
    (deps.log ?? ((message: string) => console.warn(message)))(`[paseo-bm] decision ${answered.id} is ${how}, but its delivery failed: ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------------------
// bm_ask_owner (design §6A, §6B.4; autonomy design §A.3, §A.6).
// ---------------------------------------------------------------------------

interface AskOwnerOption {
  label: string;
  effects: Effect[];
  recommended?: boolean;
  command?: { to: CommandTo; agentId: string; intent: DeclaredCommandIntent; body: string };
  /** A prepared change of the owner's settings (autonomy design §G.4), applied only on the owner's own answer. */
  change?: PreparedChangeInput;
}

export interface AskOwnerInput {
  workspaceId: string;
  managerId?: string;
  requestId?: string;
  question: string;
  recommendation: string;
  options?: AskOwnerOption[];
  subject?: string;
  class?: DecisionClass;
  separate?: boolean;
}

/** The keys of `bm_ask_owner`'s options, by position: one letter for each option it takes (`MAX_ASK_OWNER_OPTIONS`). */
export const ASK_OWNER_OPTION_KEYS: readonly string[] = [..."abcdefghijklmnopqrstuvwxyz".slice(0, MAX_ASK_OWNER_OPTIONS)];

/** The question a decision of the Orchestrator stores: the question, then its recommendation. */
export function askedQuestionOf(question: string, recommendation: string): string {
  return `${question.trim()}\n\nRecommendation: ${recommendation.trim()}`;
}

/**
 * The question stored for a decision whose options carry prepared changes of
 * the owner's settings (autonomy design §G.4): the asked question, then one
 * line per such option saying what choosing it applies, so the owner reads
 * exactly what a tap changes (`preparedChangeLinesOf`).
 */
export function storedQuestionOf(question: string, recommendation: string, changeLines: readonly string[]): string {
  const asked = askedQuestionOf(question, recommendation);
  return changeLines.length === 0 ? asked : `${asked}\n\n${changeLines.join("\n")}`;
}

/**
 * The open decision of the Orchestrator's that a new one about `requestId`
 * replaces (autonomy design §A.3): an unsettled `o:` decision of the project
 * about the same request (or both about the whole project) — the newest of
 * the same `subject` when there is one, else the newest.
 */
function replacedByAsk(workspaceId: string, requestId: string | null, subject: string | null, home: string): Decision | null {
  const open = createDecisionStore(home)
    .list({ workspaceId, statuses: UNSETTLED_STATUSES })
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decisionKindOf(decision.id) === "orchestrator" && decision.requestId === requestId)
    .sort((a, b) => timeOrZero(b.decision.askedAt) - timeOrZero(a.decision.askedAt) || b.index - a.index)
    .map(({ decision }) => decision);
  return (subject === null ? undefined : open.find((decision) => decision.subject === subject)) ?? open[0] ?? null;
}

/**
 * `bm_ask_owner` (design §6A, §6B.4; autonomy design §A.3, §A.6): stores an
 * open `o:` decision for the owner and sends nothing. Each option carries its
 * declared effects and, optionally, a prepared command to a Manager or a
 * Worker of the project, checked now as it will be sent: a live paseo-bm
 * agent of that role in the project, a block that can be written, and no
 * category of the backstop in its text that the option's effects do not
 * declare. Its class is the riskier of the one proposed and the one its
 * options' effects imply (autonomy design §B.1), and the answer names it. It
 * replaces the Orchestrator's open decision of the same request unless
 * `separate: true`, and the answer names the id it replaced — only when the
 * store did replace one. An active owner precedent on its `subject` answers it
 * at once (autonomy design §B.6, `resolveAtOpen`); the answer goes to
 * `onSettled` like the owner's, and the tool says so. It does not answer at
 * once while the loop guard is full for its request (`loopGuardFull`): the
 * owner does, and the owner's choice is the one command the guard never
 * refuses.
 */
export async function bmAskOwner(input: AskOwnerInput, context: ToolContext, deps: DecideToolDeps): Promise<ServerToolResult> {
  if (input.managerId !== undefined) await requireManager({ workspaceId: input.workspaceId, managerId: input.managerId }, context);
  else await requireProject(input.workspaceId, context);
  const requestId = input.requestId ?? null;
  const id = `o:${(deps.newId ?? randomUUID)()}`;
  const given = input.options ?? [];

  const problems: string[] = [];
  if (given.filter((option) => option.recommended === true).length > 1) problems.push("input.options: at most one option is recommended");
  const agents = given.some((option) => option.command !== undefined) ? await workingAgentsOf(context) : [];
  // What a prepared change is checked against: the owner's settings now, read once and only when an option carries one.
  let settingsNow: PreparedChangeFacts | null = null;
  const factsNow = (): PreparedChangeFacts =>
    (settingsNow ??= preparedChangeFactsOf(input.workspaceId, { home: context.home, now: context.now, ...(deps.log === undefined ? {} : { log: deps.log }) }));
  const options: DecisionOption[] = given.map((option, index) => {
    const key = ASK_OWNER_OPTION_KEYS[index]!;
    const label = option.label.replace(/\s+/g, " ").trim();
    const effects = realEffects(option.effects).length === 0 ? (["none"] as Effect[]) : realEffects(option.effects);
    const entry: DecisionOption = { key, label, recommended: option.recommended === true, effects };
    // Autonomy design §G.4: a change of the owner's settings, checked as the owner's Settings would check it.
    if (option.change !== undefined) {
      const at = `input.options[${index}]`;
      if (option.command !== undefined) problems.push(`${at}: an option carries a command or a change, not both`);
      if (realEffects(option.effects).length > 0) problems.push(`${at}.effects: an option with a change allows no effect; give ["none"]`);
      const converted = preparedChangeOfInput(option.change);
      if ("problems" in converted) {
        problems.push(...converted.problems.map((problem) => `${at}.change.${problem}`));
        return entry;
      }
      const check = preparedChangeCheckOf(converted.change, factsNow());
      if ("refusal" in check) problems.push(`${at}.change: ${check.refusal}`);
      else if ("unchanged" in check) problems.push(`${at}.change: it would change nothing: ${check.unchanged}`);
      return { ...entry, action: converted.change };
    }
    const command = option.command;
    if (command === undefined) return entry;
    const at = `input.options[${index}].command`;
    const role = command.to === "manager" ? "Manager" : "Worker";
    const target = agents.find((agent) => agent.id === command.agentId);
    if (target === undefined || target.role !== command.to) problems.push(`${at}.agentId: ${command.agentId} is not a paseo-bm ${role}; use an id bm_projects or bm_request gave`);
    else if (target.workspaceId !== input.workspaceId) problems.push(`${at}.agentId: ${role} ${command.agentId} does not belong to project ${input.workspaceId}`);
    else if (target.archived) problems.push(`${at}.agentId: ${role} ${command.agentId} is archived; nothing can be sent to it`);
    const action = { to: command.to, intent: command.intent, body: command.body, effects };
    const block = preparedCommandOf({ id, requestId }, { label }, action, effects);
    problems.push(...commandInputProblems(block).map((problem) => `${at}: ${problem}`));
    const undeclared = undeclaredCategoriesOf(`${block.re}\n${block.body}`, effects);
    if (undeclared.length > 0) {
      problems.push(`${at}: the text shows ${undeclared.join(", ")} that the option's effects do not declare; declare the effect on the option`);
    }
    return { ...entry, action: { kind: "command", agentId: command.agentId, ...action, body: command.body.trim() } };
  });
  // The owner reads what each prepared change applies on the question itself (autonomy design §G.4).
  const changeLines = preparedChangeLinesOf(options);
  const question = storedQuestionOf(input.question, input.recommendation, changeLines);
  if (question.length > MAX_DECISION_TEXT_CHARS) {
    const room = MAX_DECISION_TEXT_CHARS - askedQuestionOf("", "").length;
    problems.unshift(
      changeLines.length === 0
        ? `input.question: with the recommendation it must be at most ${room} characters in all`
        : `input.question: with the recommendation and the lines saying what each change applies (${question.length - askedQuestionOf(input.question, input.recommendation).length} characters) it must be at most ${room - (question.length - askedQuestionOf(input.question, input.recommendation).length)} characters in all`,
    );
  }
  if (problems.length > 0) return { ok: false, text: fixThese("bm_ask_owner", problems) };
  const preparedChange = carriesPreparedChange({ options });

  const replaced = input.separate === true ? null : replacedByAsk(input.workspaceId, requestId, input.subject ?? null, context.home);
  const decision: Decision = {
    id,
    workspaceId: input.workspaceId,
    requestId,
    askedBy: { role: "orchestrator", agentId: await orchestratorIdOf(context) },
    askedAt: context.now.toISOString(),
    round: null,
    question,
    subject: input.subject ?? null,
    // The Orchestrator's proposal, raised to what its options' effects imply (autonomy design §B.1).
    class: checkedClass(input.class, declaredEffects({ options })),
    options,
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: replaced?.id ?? null,
    supersededBy: null,
    // The option it recommends is the recommended predictor's prediction (autonomy design §B.3). A decision about the
    // owner's settings (§G.4) records none: it is no decision of its class, so the agreement ledger leaves it out and
    // agreeing with advice never earns a class its delegation.
    ...(preparedChange ? {} : { prediction: openingPrediction(options) }),
  };
  const stored = createDecisionStore(context.home).open(decision);
  const replacedId = stored.superseded?.id ?? null;
  const replacedLine =
    replacedId === null ? null : `It replaced your open question ${replacedId} of this ${requestId === null ? "project" : "request"}, which can no longer be answered.`;
  // The loop guard (design §6A) counts the commands a precedent chose too: once it is full for the request, no
  // precedent answers at once — the owner does. A store that cannot be read counts as full: the owner is asked.
  let guardFull = false;
  try {
    guardFull = stored.created && loopGuardFull(context.home, input.workspaceId, commandRequestIdOf(requestId), context.now, deps.store);
  } catch {
    guardFull = true;
  }
  // Autonomy design §B.6: an owner precedent on its subject.
  const atOpen =
    stored.created && !guardFull ? resolveAtOpen(stored.decision, { home: context.home, now: context.now, ...(deps.log === undefined ? {} : { log: deps.log }) }) : null;
  const answered = atOpen?.answered ?? null;
  const precedentId = answered === null ? null : (atOpen?.precedent?.id ?? null);
  // Autonomy design §G.3, §G.4: advice the owner is left to answer is an `advice` intervention.
  if (answered === null && stored.created) await recordAdviceOf(stored.decision, context, deps);
  if (answered !== null) {
    await settle(answered, `answered by precedent ${precedentId ?? "of the owner"}`, context, deps);
    const option = answered.options.find((entry) => entry.key === answered.answer?.optionKey);
    const answerText = option === undefined ? `in the owner's words: ${redactText(answered.answer?.words ?? "", context.env)}` : `option ${option.key}: ${option.label}`;
    const decisionClass = decisionClassOf(answered);
    const said = [
      `Answered at once by the owner's precedent ${precedentId ?? ""} on "${answered.subject}" (${answerText}); the owner is not asked.`,
      replacedLine,
      option?.action !== undefined
        ? "The plugin delivers the option's command itself, with the owner's authority."
        : "It comes back to you as a BM-ANSWER notice that cites the precedent; act on it as the owner's answer.",
      "Tell the owner in one line here too.",
    ]
      .filter((line): line is string => line !== null)
      .join(" ");
    const facts = { decisionId: answered.id, replaced: replacedId, class: decisionClass, answeredBy: "precedent", precedentId };
    return { ok: true, text: `${said}\n${json(facts)}` };
  }
  const prepared = options.filter((option) => option.action?.kind === "command").length;
  const changes = options.filter((option) => carriesPreparedChange({ options: [option] })).length;
  const suggested = atOpen?.precedent ?? null;
  const said = [
    `Asked. The owner answers it in paseo-bm${options.length === 0 ? "" : ", with one button per option"}; nothing was sent to any agent.`,
    replacedLine,
    guardFull ? `${COMMAND_LIMIT_PER_REQUEST} commands went to this request in ${COMMAND_LIMIT_WINDOW_HOURS} hours: the owner answers this one, not a precedent.` : null,
    suggested === null ? null : `The owner's precedent on "${suggested.subject}" is shown to them as a suggestion only.`,
    prepared === 0 ? null : "When the owner picks an option with a command, the plugin delivers that command itself, with the owner's authority.",
    changes === 0
      ? null
      : "When the owner picks an option with a change, the plugin applies it to the owner's settings itself and tells you in the BM-ANSWER; only the owner's own answer applies it, so no precedent, policy or tool of yours ever does.",
    "An answer in the owner's own words comes back to you as a BM-ANSWER notice. Tell the owner in one line here too.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
  const facts = { decisionId: stored.decision.id, replaced: replacedId, class: decisionClassOf(stored.decision), ...(changes === 0 ? {} : { changes }) };
  return { ok: true, text: `${said}\n${json(facts)}` };
}

/** What reading a request's finish needs of a tool call (`isFinishedUnverifiedNow`). */
export function finishReadOf(context: Pick<ToolContext, "location" | "paseo" | "home">) {
  return { location: context.location, paseo: context.paseo, home: context.home };
}

/** The Worker a decision's prepared commands go to, when they name one: its request is the decision's, else that Worker's (change-008 C4). */
function workerOfCommands(decision: Pick<Decision, "options">): string | null {
  const workers = new Set(decision.options.flatMap((option) => (option.action?.kind === "command" && option.action.to === "worker" ? [option.action.agentId] : [])));
  return workers.size === 1 ? [...workers][0]! : null;
}

/**
 * Logs a decision of `bm_ask_owner` that is left to the owner as an `advice`
 * intervention (autonomy design §G.3, §G.4) when it is one
 * (`interventionOfAdvice`): the owner's own word in the chat is read only
 * when the wake carried no `advice.due` of its project. Never throws and never
 * fails the tool: a failure is one log line.
 */
async function recordAdviceOf(decision: Decision, context: ToolContext, deps: DecideToolDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const preparedChange = carriesPreparedChange(decision);
    const wake = await wakeEventsNow(context, deps);
    const due = wake.some((event) => event.type === "advice.due" && event.workspaceId === decision.workspaceId);
    if (!preparedChange && !(due && decision.requestId === null)) return;
    const ownerAsked = due ? false : await ownerJustSpoke(context).catch(() => false);
    recordIntervention(context.home, interventionOfAdvice({ ...decision, preparedChange }, wake, ownerAsked), { now: () => context.now, log });
  } catch (error) {
    log(`[paseo-bm] could not log the Orchestrator's advice: ${errorText(error)}`);
  }
}

/** `bm_decisions` (autonomy design §A.9): the stored decisions, newest asked first, with their grants; read-only. */
export function bmDecisions(input: DecisionsQuery, context: ToolContext): ServerToolResult {
  return { ok: true, text: decisionsText(context.home, input, context.env, { grant: true }) };
}

// ---------------------------------------------------------------------------
// bm_decide and bm_predict (autonomy design §B.3, §B.5, §B.9).
// ---------------------------------------------------------------------------

export interface DecideInput {
  decisionId: string;
  optionKey: string;
  reason: string;
}

/** What one tool writes under the owner's policy (`transitionUnderPolicy`). */
interface PolicyTransition {
  /** The rule of the owner's policy that must allow the write, on the decision as read and again as stored; null when it does. */
  refusalOf: (policy: AutonomyPolicy, decision: Decision) => string | null;
  /** Where a decisionId comes from, for the refusal of one that is not stored. */
  idsFrom: string;
  /** What could not be stored, for the refusal of a failed write. */
  what: string;
  /** The change, on the stored decision, with the reason and the time of the call. */
  change: (current: Decision, written: { reason: string; at: string }) => TransitionResult;
}

/**
 * The one write of `bm_decide` and `bm_predict` (autonomy design §B.5, §B.9;
 * code review 2026-09-30 §3.4): the Orchestrator's reason, redacted and on one
 * line (refused when empty); the decision read; the owner's policy read now
 * and its rule checked; the option checked; then the change written in one
 * transition that checks the rule again on the stored decision. From the read
 * to the write nothing awaits, so no other answer comes between (the first
 * write wins). Returns the decision as written and the store it went through;
 * a refusal writes nothing.
 */
function transitionUnderPolicy(input: DecideInput, context: ToolContext, rule: PolicyTransition): { decision: Decision; store: DecisionStore } {
  const reason = redactText(input.reason, context.env).replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_REASON_CHARS);
  if (reason === "") refuse("give your reason in one line");
  const store = createDecisionStore(context.home);
  const at = context.now.toISOString();
  let mutation: ReturnType<typeof store.transition>;
  try {
    const decision = store.get(input.decisionId);
    if (decision === null) refuse(`no decision ${input.decisionId}; use a decisionId ${rule.idsFrom}`);
    const policy = currentPolicy(context.home);
    const problem = rule.refusalOf(policy, decision);
    if (problem !== null) refuse(problem);
    if (!decision.options.some((option) => option.key === input.optionKey)) {
      refuse(`decision ${decision.id} has no option ${JSON.stringify(input.optionKey)}; its options are ${decision.options.map((option) => option.key).join(", ") || "none"}`);
    }
    mutation = store.transition(
      decision.id,
      (current) => {
        // Checked again on the stored decision, in the write that changes it.
        const again = rule.refusalOf(policy, current);
        if (again !== null) refuse(again);
        return rule.change(current, { reason, at });
      },
      decision.workspaceId,
    );
  } catch (error) {
    if (error instanceof Refusal) throw error;
    refuse(`${rule.what} ${input.decisionId} could not be stored (${errorText(error)}); nothing was changed`);
  }
  if (mutation.status === "not-found") refuse(`no decision ${input.decisionId}`);
  if (mutation.status === "refused") refuse(`${mutation.message}; nothing was changed`);
  return { decision: mutation.decision, store };
}

/** What the Orchestrator's decision did, in one sentence, from the delivery the plugin recorded. */
function decidedDeliveryText(decision: Decision): string {
  const fallback = decisionKindOf(decision.id) === "fallback";
  switch (decision.delivery?.outcome) {
    case "sent":
      return fallback ? "The plugin ran the option's action on the incident." : "The Worker has it now, as the plugin's BM-DELIVERY.";
    case "queued":
      return "The Worker gets it, as the plugin's BM-DELIVERY, when its current turn ends.";
    case "failed":
      return fallback
        ? "The plugin could not run the option's action; the owner sees that in the Inbox."
        : "The plugin could not deliver it: the request has no single live Worker. The owner sees that on the decision.";
    default:
      return fallback
        ? "The plugin runs the option's action as it runs the owner's choice."
        : "The plugin delivers it to the Worker at its next idle moment, as it delivers the owner's answers.";
  }
}

/**
 * Logs an answer of the Orchestrator's (`bm_decide`) as a coordination
 * intervention (autonomy design §G.3) against the events of the wake whose
 * turn gave it (`interventionOfDecision`). A delivered command is logged by
 * the send pipeline (`command-send.ts`). Never throws and never fails the
 * tool: a failure is one log line.
 */
async function recordInterventionOf(of: Decision, context: ToolContext, deps: DecideToolDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    recordIntervention(context.home, interventionOfDecision(of, await wakeEventsNow(context, deps)), { now: () => context.now, log });
  } catch (error) {
    log(`[paseo-bm] could not log the Orchestrator's intervention: ${errorText(error)}`);
  }
}

/**
 * `bm_decide` (autonomy design §B.5, §B.9; change-004, bead `t9lm.11`): the
 * Orchestrator decides for the owner a decision it did not ask — a Worker's
 * question (`q:`) or a fallback incident (`f:`) — where the owner's policy
 * delegates its class: a `delegate` cell, any class at the project's level
 * (`decideRefusalOf`, the policy read now; ADR-025). It answers with one of
 * the decision's options, `by: policy`, `via: inbox` (as the other policy
 * answers: nothing was typed in a chat), the cell's `class` and the
 * Orchestrator's reason (redacted, one line), with the grant the owner's
 * choice of that option would give — a push, publish, deploy, migration, real
 * data or cost included where its class is delegated. From the read to the
 * write nothing awaits, and the write checks the rule again, so no other
 * answer comes between (the first answer wins: `transitionUnderPolicy`). The
 * answered decision then goes to `onSettled`, the delivery the owner's answers
 * take: a Worker gets it in the same `BM-DELIVERY answers` block, an
 * incident's option runs through `fallback.act`. It is logged as an `answer`
 * intervention (§G.3) and is its wake's action for A-7. A refusal writes,
 * sends and logs nothing; a decision nobody decides stays open for the owner.
 */
export async function bmDecide(input: DecideInput, context: ToolContext, deps: DecideToolDeps): Promise<ServerToolResult> {
  // Autonomy design §C.6 (change-008 C4): an option that acts on its request's finish — a commit, a release — is the
  // owner's while that request stands finished-unverified. Read from the trace store now, before the write (which
  // awaits nothing), and only for such an option; a decision that cannot be read here is refused by the write.
  let finishedUnverified = false;
  try {
    const target = createDecisionStore(context.home).get(input.decisionId);
    const option = target?.options.find((entry) => entry.key === input.optionKey);
    if (target !== null && option !== undefined && actsOnFinish(option)) {
      finishedUnverified = await isFinishedUnverifiedNow({ ...finishReadOf(context), ...(deps.log === undefined ? {} : { log: deps.log }) }, target.workspaceId, {
        requestId: target.requestId,
        agentId: target.askedBy.role === "worker" ? target.askedBy.agentId : workerOfCommands(target),
      });
    }
  } catch {
    // The write reads the decision again and refuses what it cannot read.
  }
  const { decision: answered, store } = transitionUnderPolicy(input, context, {
    refusalOf: (policy, decision) => decideRefusalOf(policy, decision, { optionKey: input.optionKey, finishedUnverified }),
    idsFrom: "a decision.opened line or bm_decisions gave",
    what: "the answer to",
    change: (current, { reason, at }) =>
      answerDecision(current, { by: "policy", via: "inbox", optionKey: input.optionKey, class: decisionClassOf(current), reason, at }),
  });
  await settle(answered, "decided by the Orchestrator on the owner's policy", context, deps);
  // Autonomy design §G.3: an answer the Orchestrator gives is an `answer` intervention.
  await recordInterventionOf(answered, context, deps);
  let now = answered;
  try {
    now = store.get(answered.id, answered.workspaceId) ?? answered;
  } catch {
    // The answer stands; only what the delivery recorded is not known.
  }
  const decisionClass = decisionClassOf(answered);
  const option = answered.options.find((entry) => entry.key === input.optionKey)!;
  const what =
    decisionKindOf(answered.id) === "fallback"
      ? `fallback incident ${answered.id}`
      : `${answered.id.slice(answered.id.lastIndexOf(":") + 1)} of ${answered.requestId}`;
  const said = [
    `Decided ${what} for the owner with option ${option.key} (${option.label}), on the owner's policy: ${decisionClass} is delegated to you in this project.`,
    "The owner sees your choice and your reason on the decision.",
    decidedDeliveryText(now),
    "Send nothing more for it. Tell the owner in one line what you chose and why.",
  ].join(" ");
  const facts = { decisionId: answered.id, optionKey: option.key, class: decisionClass, answeredBy: "policy", grant: now.grant, delivery: now.delivery };
  return { ok: true, text: `${said}\n${json(facts)}` };
}

/**
 * `bm_predict` (autonomy design §B.3, §B.9; change-007 C1): records the option
 * the Orchestrator expects the owner to choose, with its reason (redacted, one
 * line), as the decision's `prediction.orchestrator` — only as far as
 * `predictionRefusalOf` allows, with the owner's policy read now, and for an
 * option the decision has. From the read to the write nothing awaits, and the
 * write checks again, so a decision gets one prediction
 * (`transitionUnderPolicy`). It answers nothing, delivers nothing and logs no
 * intervention: the owner decides, and sees the prediction on the decision's
 * card as the Orchestrator's proposal while the project's level is 1 or more
 * (`ownerViewOfDecision`, ADR-025). A refusal writes nothing.
 */
export function bmPredict(input: DecideInput, context: ToolContext): ServerToolResult {
  const { decision: predicted } = transitionUnderPolicy(input, context, {
    refusalOf: predictionRefusalOf,
    idsFrom: "a decision.opened line gave",
    what: "the prediction for",
    change: (current, { reason, at }) => {
      const orchestrator = { optionKey: input.optionKey, reason, at };
      return { ok: true, decision: { ...current, prediction: { recommended: current.prediction?.recommended ?? null, orchestrator } } };
    },
  });
  const said = [
    `Recorded your prediction for ${predicted.id}: option ${input.optionKey}.`,
    "It answers nothing and went to no agent: the owner decides, and sees it on the decision as your proposal, with your reason.",
    "Send nothing for it.",
  ].join(" ");
  return { ok: true, text: `${said}\n${json({ decisionId: predicted.id, optionKey: input.optionKey, class: decisionClassOf(predicted) })}` };
}
