/**
 * The Main asks the owner with a stored decision (mission runtime design
 * §4.6, ADR-033 decision 3, REQ-205): `bm_owner_question`.
 *
 * - **Ask** `{ question, options[2–5] (one recommended), class, subject?,
 *   ownerOnly? }`: an `m:` decision on the Main's mission (`m:<missionId>:<n>`),
 *   asked by the plugin on the Main's behalf (`askedBy.agentId` the Main),
 *   options `a`, `b`, … with no action — the owner's Inbox card. A journal
 *   `decision` line names it.
 * - **Answered** `{ answered: m:…, option | words }`: the owner's answer typed
 *   in the Main's chat, proposed for the current turn and settled at its end
 *   (`settleOwnerQuestionAnswers`, from the materialiser) only when the turn
 *   holds an owner-typed message — as `bm_answers` does for Worker questions.
 *
 * An answer on the card goes through `decisions.answer` → `applyMissionDecision`,
 * which journals it and tells the Main. Never throws.
 */
import type { ToolCaller } from "./agent-bindings";
import { OWNER_QUESTION_FACE, schemaIssues } from "../shared/bm-tools";
import { answerDecision, type Decision, type DecisionClass, type DecisionOption } from "../shared/decisions";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import { createMissionDecisionStore, isMainQuestion, missionOfDecisionId } from "./mission-decisions";
import { createMissionStore, journalQuietly } from "./mission-store";
import { MISSION_NOT_BOUND_MESSAGE, NOT_A_MAIN_MESSAGE, applyMissionDecision, missionOfMain } from "./mission-tools";
import { redactText } from "./collector";
import { errorText } from "./rpc-kit";
import { actingTools, answered, boundAs, fixThese, refused, withoutNulls } from "./tool-kit";

const NOTHING = "Nothing was recorded.";
const OPTION_KEYS = ["a", "b", "c", "d", "e"] as const;

interface OwnerQuestionInput {
  question?: string;
  options?: Array<{ label: string; recommended?: boolean }>;
  class?: DecisionClass;
  subject?: string;
  ownerOnly?: boolean;
  answered?: string;
  option?: string;
  words?: string;
}

/** The owner's answers a Main proposed in a turn, held until that turn ends. */
interface ProposedOwnerAnswer {
  decisionId: string;
  optionKey: string | null;
  words: string | null;
}
const proposals = new Map<string, { startedAt: string; list: ProposedOwnerAnswer[] }>();

export interface OwnerQuestionDeps {
  home: () => string;
  log: (message: string) => void;
  now?: () => Date;
  /** The start of a Main's current turn, to tie a proposed answer to it; null when unknown. */
  turnStartOf?: (agentId: string) => string | null;
}

/** The bound Manager's `bm_owner_question` (see the module comment). */
export function createOwnerQuestionTools(deps: OwnerQuestionDeps): ServerTools {
  const now = deps.now ?? (() => new Date());
  const run = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const main = boundAs(caller, "manager");
    if (main === null) return refused(MISSION_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw ?? {}) as OwnerQuestionInput;
    const issues = schemaIssues(OWNER_QUESTION_FACE.inputSchema, input);
    if (issues.length > 0) return fixThese("bm_owner_question", issues);
    const home = deps.home();
    const mission = missionOfMain(home, main);
    if (mission === null) return refused(NOT_A_MAIN_MESSAGE);
    const store = createMissionDecisionStore(home);

    if (input.answered !== undefined) {
      const reasons: string[] = [];
      if (input.question !== undefined || input.options !== undefined) reasons.push("answered: record an answer or ask a question, not both");
      if ((input.option === undefined) === (input.words === undefined)) reasons.push("answered: give the option the owner chose or their words, exactly one");
      const decision = store.get(input.answered);
      if (decision === null || missionOfDecisionId(input.answered) !== mission.missionId || !isMainQuestion(decision)) reasons.push(`answered: ${input.answered} is not a question of yours on mission ${mission.code}`);
      else if (decision.status !== "open") reasons.push(`answered: ${input.answered} is ${decision.status} already`);
      else if (input.option !== undefined && !decision.options.some((option) => option.key === input.option)) reasons.push(`option: ${input.answered} has no option ${input.option}`);
      if (reasons.length > 0) return fixThese("bm_owner_question", reasons);
      const startedAt = (deps.turnStartOf ?? (() => null))(main.agentId!);
      if (startedAt === null) return refused(`paseo-bm cannot tie this answer to your current turn; tell the owner to answer on the card. ${NOTHING}`);
      const held = proposals.get(main.agentId!);
      const list = (held?.startedAt === startedAt ? held.list : []).filter((entry) => entry.decisionId !== input.answered);
      proposals.set(main.agentId!, { startedAt, list: [...list, { decisionId: input.answered, optionKey: input.option ?? null, words: input.words ?? null }] });
      return answered({ proposed: input.answered });
    }

    const reasons: string[] = [];
    if (input.question === undefined) reasons.push("question: required to ask");
    if (input.options === undefined) reasons.push("options: required to ask");
    if (input.class === undefined) reasons.push("class: required to ask");
    if (input.options !== undefined && input.options.filter((option) => option.recommended === true).length !== 1) reasons.push("options: exactly one must be recommended");
    if (reasons.length > 0) return fixThese("bm_owner_question", reasons);
    const at = now().toISOString();
    const options: DecisionOption[] = input.options!.map((option, index) => ({
      key: OPTION_KEYS[index]!,
      label: redactText(option.label).trim(),
      recommended: option.recommended === true,
      effects: [],
    }));
    const decision: Decision = {
      id: store.nextId(mission.missionId),
      workspaceId: mission.missionId,
      requestId: null,
      askedBy: { role: "plugin", agentId: main.agentId },
      askedAt: at,
      round: null,
      question: redactText(input.question!).trim(),
      subject: input.subject ?? null,
      class: input.class!,
      options,
      status: "open",
      settledAt: null,
      needsConfirmation: null,
      answer: null,
      grant: null,
      delivery: null,
      supersedes: null,
      supersededBy: null,
      ...(input.ownerOnly === true ? { ownerOnly: true } : {}),
    };
    try {
      store.open(decision);
    } catch (error) {
      return refused(`The question could not be stored: ${errorText(error)}. ${NOTHING}`);
    }
    const first = decision.question.split("\n")[0]!.replace(/\s+/g, " ");
    journalQuietly(createMissionStore(home), mission.missionId, { kind: "decision", by: "main", text: `The Main asked the owner (${decision.id}): ${first.length <= 200 ? first : `${first.slice(0, 199)}…`}`, ref: decision.id }, deps.log);
    return answered({ decisionId: decision.id });
  };
  return actingTools([OWNER_QUESTION_FACE], { bm_owner_question: run }, NOTHING);
}

/**
 * At a Main's turn end (the materialiser): the owner's answers it proposed in
 * that turn, settled `by: owner`, `via: chat-manager` only when the turn holds
 * an owner-typed message (`ownerTyped`), then journaled (§4.6); dropped with a
 * log line otherwise. Returns the decisions settled. Never throws.
 */
export async function settleOwnerQuestionAnswers(
  agentId: string,
  startedAt: string | null,
  ownerTyped: boolean,
  deps: { home: string; log: (message: string) => void; now?: () => Date },
): Promise<Decision[]> {
  const held = proposals.get(agentId);
  proposals.delete(agentId);
  if (held === undefined || held.list.length === 0) return [];
  if (held.startedAt !== startedAt) return [];
  if (!ownerTyped) {
    deps.log(`[paseo-bm] the Main ${agentId} recorded answers to its own questions (${held.list.map((entry) => entry.decisionId).join(", ")}) in a turn without the owner's words; nothing was settled.`);
    return [];
  }
  const settled: Decision[] = [];
  const at = (deps.now ?? (() => new Date()))();
  const store = createMissionDecisionStore(deps.home);
  for (const entry of held.list) {
    try {
      const mutation = store.transition(entry.decisionId, (current) => answerDecision(current, { via: "chat-manager", optionKey: entry.optionKey, words: entry.words, at: at.toISOString() }));
      if (mutation.status !== "updated") continue;
      settled.push(mutation.decision);
      // Journaled; the Main recorded it itself, so it is not told again.
      await applyMissionDecision(mutation.decision, { home: deps.home, now: at, log: deps.log, quiet: true });
    } catch (error) {
      deps.log(`[paseo-bm] the owner's answer to ${entry.decisionId} could not be settled: ${errorText(error)}`);
    }
  }
  return settled;
}
