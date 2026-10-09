/**
 * The `decisions.*` RPCs (autonomy design §A.6, ADR-017): every surface reads
 * and answers the same stored decision. Each handler is an exported
 * `handle…` function taking its input and an injectable `DecisionRpcDeps`,
 * plus one line in `registerDecisionRpcs`.
 *
 * Answering records the answer and its one-use grant in the store, then hands
 * the settled decisions to `onSettled` — the delivery hook (§A.6); a no-op by
 * default. `settledByKind` builds it from one delivery per asker kind: the
 * Worker's answers block (`decision-delivery.ts`), the Orchestrator's command
 * or `BM-ANSWER` (`orchestrator-decisions.ts`), and the fallback incidents'
 * `fallback.act` (`fallback-decisions.ts`). The answer
 * stands whatever the hook does: a failing hook is logged, never turned into a
 * failed answer. The same hook delivers a decision the Orchestrator decided
 * with `bm_decide` on the owner's policy (`orchestrator-decide-tools.ts`, autonomy
 * design §B.5), so its answer reaches the Worker, or runs the incident's
 * action, exactly as the owner's does.
 *
 * A mission's `m:` decisions (missions design §4.1) live in their mission's
 * own store (`mission-decisions.ts`): `decisions.list` and `.get` read them
 * too, and `decisions.answer` records the owner's answer there and has the
 * plugin apply the mission change it chose (`mission-tools.ts`).
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  DECISION_LIST_DEFAULT,
  DashboardError,
  decisionsAnswerRpc,
  decisionsConfirmRpc,
  decisionsGetRpc,
  decisionsListRpc,
  decisionsOverrideRpc,
  type DecisionOutput,
  type DecisionsAnswerInput,
  type DecisionsConfirmInput,
  type DecisionsGetInput,
  type DecisionsListInput,
  type DecisionsListOutput,
} from "../shared/contracts";
import {
  UNSETTLED_STATUSES,
  answerDecision,
  confirmDecision,
  decisionKindOf,
  needsOwnerConfirmation,
  type Decision,
  type TransitionRefusal,
} from "../shared/decisions";
import { createDecisionStore, type DecisionMutation, type DecisionStore } from "./decision-store";
import { createMissionDecisionStore, isMissionDecisionId } from "./mission-decisions";
import { MISSION_ID_PATTERN, createMissionStore } from "./mission-store";
import { applyMissionDecision, missionAnswerRefusalsOf } from "./mission-tools";
import { applyGovernorDecision, governorAnswerRefusalsOf, isGovernorCard, type GovernorMissionDeps } from "./governor-tools";
import type { PaseoCliDeps } from "./paseo-cli";
import { handleDecisionsOverride, ownerViewsOf } from "./decision-override";
import { supersedePrecedentsBy } from "./precedent-resolve";
import { READ_FAILED, coded, dataHome, errorText, logOf, requireDataHome, type RpcHomeDeps } from "./rpc-kit";
import { timeOrZero } from "../shared/time";

/** What a settled decision is handed to: the delivery of §A.6. */
export type OnDecisionsSettled = (decisions: Decision[], context: { paseo: unknown }) => void | Promise<void>;

/** The asker kinds of `decisionKindOf`: each has its own delivery (§A.6). */
export type DecisionKind = NonNullable<ReturnType<typeof decisionKindOf>>;

/**
 * One `onSettled` hook from a delivery per asker kind (§A.6): the settled
 * decisions are split by `decisionKindOf` and each group goes to its own
 * handler; a kind without a handler is not delivered. A failing handler is
 * logged and never stops another kind's delivery.
 */
export function settledByKind(
  handlers: Partial<Record<DecisionKind, OnDecisionsSettled>>,
  log: (message: string) => void = (message) => console.warn(message),
): OnDecisionsSettled {
  return async (decisions, context) => {
    const groups = new Map<DecisionKind, Decision[]>();
    for (const decision of decisions) {
      const kind = decisionKindOf(decision.id);
      if (kind === null || handlers[kind] === undefined) continue;
      groups.set(kind, [...(groups.get(kind) ?? []), decision]);
    }
    for (const [kind, group] of groups) {
      try {
        await handlers[kind]!(group, context);
      } catch (error) {
        log(`[paseo-bm] delivering ${group.map((decision) => decision.id).join(", ")} failed: ${errorText(error)}`);
      }
    }
  };
}

export type DecisionRpcDeps = RpcHomeDeps & {
  /** The clock; `new Date()` by default. */
  now?: () => Date;
  /** Called after an answer or a confirmed chat answer is stored; a no-op by default. */
  onSettled?: OnDecisionsSettled;
  /** Where a failing `onSettled` is reported; `console.warn` by default. */
  log?: (message: string) => void;
  /** The `paseo` CLI that retitles a Main after an applied `m:` change; the real one by default. */
  cli?: PaseoCliDeps;
  /** Missions design §9.6: what a split the owner applies needs to create its Main (the endpoint's binder and bindings). */
  missions?: GovernorMissionDeps;
};

function storeOf(deps: DecisionRpcDeps, what: string): DecisionStore {
  return createDecisionStore(requireDataHome(deps, what), deps.log === undefined ? {} : { log: deps.log });
}

/**
 * The codes of a store operation (rpc-kit `coded`, code review 2026-09-30
 * §3.2): a read that fails is `READ_FAILED`, a write `E_DECISION_WRITE_FAILED`;
 * a data folder that cannot be created is `E_DATA_HOME_UNAVAILABLE`.
 */
const reading = <T>(what: string, operation: () => T): T => coded(READ_FAILED, what, operation);
const writing = <T>(what: string, operation: () => T): T => coded("E_DECISION_WRITE_FAILED", what, operation);

const REFUSAL_CODES: Record<TransitionRefusal, DashboardError["code"]> = {
  settled: "E_DECISION_SETTLED",
  "invalid-answer": "E_DECISION_ANSWER_INVALID",
  "unknown-option": "E_DECISION_ANSWER_INVALID",
  "not-needs-confirmation": "E_DECISION_NOT_NEEDS_CONFIRMATION",
  "no-grant": "E_DECISION_SETTLED",
  "grant-used": "E_DECISION_SETTLED",
  "grant-expired": "E_DECISION_SETTLED",
  "effect-not-granted": "E_DECISION_SETTLED",
  "not-answered": "E_DECISION_ANSWER_INVALID",
};

/** The decision a mutation left, or the coded error it amounts to. */
function settledOrThrow(id: string, mutation: DecisionMutation): Decision {
  if (mutation.status === "not-found") throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${id}`);
  if (mutation.status === "refused") throw new DashboardError(REFUSAL_CODES[mutation.refusal], mutation.message);
  return mutation.decision;
}

async function handOver(decision: Decision, paseo: unknown, deps: DecisionRpcDeps): Promise<void> {
  if (deps.onSettled === undefined) return;
  try {
    await deps.onSettled([decision], { paseo });
  } catch (error) {
    logOf(deps)(`[paseo-bm] decision ${decision.id} is answered, but its delivery failed: ${errorText(error)}`);
  }
}

/** The decision as stored now (delivery may have recorded itself), or `decision` when it cannot be read. */
function reread(store: DecisionStore, decision: Decision): Decision {
  try {
    return store.get(decision.id, decision.workspaceId) ?? decision;
  } catch {
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Mission decisions (missions design §4.1): `m:<missionId>:<n>`, in each
// mission's own store, answered here by the owner only.
// ---------------------------------------------------------------------------

/**
 * The `m:` decisions `decisions.list` adds: with no `workspaceId`, every
 * mission's (unsettled ones only for the Inbox); with a mission id as the
 * `workspaceId`, that mission's; none for any other workspace. Never throws.
 */
function missionDecisionsOf(home: string, workspaceId: string | undefined, inbox: boolean): Decision[] {
  if (workspaceId !== undefined && !MISSION_ID_PATTERN.test(workspaceId)) return [];
  try {
    const store = createMissionDecisionStore(home);
    const missions = workspaceId === undefined ? createMissionStore(home).list().map((entry) => entry.missionId) : [workspaceId];
    return missions.flatMap((missionId) => store.list(missionId, inbox ? UNSETTLED_STATUSES : undefined));
  } catch {
    return [];
  }
}

/**
 * `decisions.answer` of an `m:` decision: the change the chosen option
 * carries is checked first (`E_MISSION_INVALID`, nothing written), then the
 * owner's answer is recorded and the plugin applies the change
 * (`mission-tools.ts`), then tells the mission's Main what the owner decided.
 */
async function answerMissionDecision(input: DecisionsAnswerInput, paseo: unknown, deps: DecisionRpcDeps): Promise<DecisionOutput> {
  const home = requireDataHome(deps, "answer the decision");
  const store = createMissionDecisionStore(home);
  const at = deps.now?.() ?? new Date();
  const current = reading("read the decision", () => store.get(input.id));
  if (current === null) throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${input.id}`);
  // Missions design §9.6: a split or an arbitration the governor asked takes its own check and apply.
  const governed = isGovernorCard(current);
  const refusals = governed
    ? await governorAnswerRefusalsOf(current, input.optionKey ?? null, paseo, home, at)
    : await missionAnswerRefusalsOf(current, input.optionKey ?? null, paseo, home);
  if (refusals.length > 0) throw new DashboardError("E_MISSION_INVALID", refusals.join("; "));
  const mutation = writing("answer the decision", () =>
    store.transition(input.id, (decision) =>
      answerDecision(decision, { via: input.via ?? "inbox", optionKey: input.optionKey ?? null, words: input.words ?? null, at: at.toISOString() }),
    ),
  );
  const settled = settledOrThrow(input.id, mutation);
  const applyDeps = { home, now: at, log: logOf(deps), paseo, ...(deps.cli === undefined ? {} : { cli: deps.cli }) };
  if (governed) await applyGovernorDecision(settled, { ...applyDeps, ...(deps.missions === undefined ? {} : { missions: deps.missions }) });
  else await applyMissionDecision(settled, applyDeps);
  return { decision: store.get(settled.id) ?? settled };
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/** `decisions.list` (§A.6). Reads only; no usable data folder reads as none. */
export function handleDecisionsList(input: DecisionsListInput, deps: DecisionRpcDeps = {}): DecisionsListOutput {
  const home = dataHome(deps);
  if (home === null) return { decisions: [], truncated: false };
  const store = createDecisionStore(home, deps.log === undefined ? {} : { log: deps.log });
  const inbox = input.scope === "inbox";
  const matched = reading("read the decisions", () => [
    ...store.list({
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.scope === "request" && input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(inbox ? { statuses: UNSETTLED_STATUSES } : {}),
    }),
    ...(input.scope === "request" ? [] : missionDecisionsOf(home, input.workspaceId, inbox)),
  ]).filter((decision) => input.status === undefined || decision.status === input.status);
  const direction = inbox ? 1 : -1;
  const ordered = matched
    .map((decision, index) => ({ decision, index }))
    .sort((a, b) => direction * (timeOrZero(a.decision.askedAt) - timeOrZero(b.decision.askedAt)) || direction * (a.index - b.index))
    .map(({ decision }) => decision);
  const limit = input.limit ?? DECISION_LIST_DEFAULT;
  const ownerView = ownerViewsOf(deps);
  return { decisions: ordered.slice(0, limit).map((decision) => ownerView(decision)), truncated: ordered.length > limit };
}

/** `decisions.get` (§A.6). An unsettled decision comes with the Orchestrator's proposal only at a level of 1 or more (`ownerViewsOf`). */
export function handleDecisionsGet(input: DecisionsGetInput, deps: DecisionRpcDeps = {}): DecisionOutput {
  const store = storeOf(deps, "read the decision");
  const decision = reading("read the decision", () =>
    isMissionDecisionId(input.id) ? createMissionDecisionStore(requireDataHome(deps, "read the decision")).get(input.id) : store.get(input.id),
  );
  if (decision === null) throw new DashboardError("E_DECISION_NOT_FOUND", `no decision ${input.id}`);
  return { decision: ownerViewsOf(deps)(decision) };
}

/**
 * `decisions.answer` (§A.6, REQ-112): records the owner's answer and its grant,
 * supersedes the precedents on its subject it contradicts (§B.6, REQ-124 c),
 * then hands the decision to `onSettled`. Every refusal writes nothing.
 */
export async function handleDecisionsAnswer(
  input: DecisionsAnswerInput,
  paseo: unknown,
  deps: DecisionRpcDeps = {},
): Promise<DecisionOutput> {
  const hasOption = input.optionKey !== undefined;
  const hasWords = input.words !== undefined;
  if (hasOption === hasWords) {
    throw new DashboardError("E_DECISION_ANSWER_INVALID", "answer with exactly one of optionKey or words");
  }
  if (isMissionDecisionId(input.id)) return answerMissionDecision(input, paseo, deps);
  const store = storeOf(deps, "answer the decision");
  const at = (deps.now?.() ?? new Date()).toISOString();
  // One synchronous block: nothing can settle the decision between the read and the write.
  const mutation = writing("answer the decision", (): DecisionMutation => {
    const current = store.get(input.id);
    if (current === null) return { status: "not-found" };
    const result = answerDecision(current, {
      via: input.via ?? "inbox",
      optionKey: input.optionKey ?? null,
      words: input.words ?? null,
      at,
    });
    // Checked on a valid answer only, so a settled or malformed answer keeps its own code.
    const granted = result.ok ? (result.decision.grant?.effects ?? []) : [];
    if (input.confirmed !== true && needsOwnerConfirmation(granted)) {
      throw new DashboardError(
        "E_DECISION_NOT_CONFIRMED",
        `answering ${input.id} this way allows ${granted.join(", ")}; the owner's confirmation is needed`,
      );
    }
    return store.transition(input.id, () => result, current.workspaceId);
  });
  const answered = settledOrThrow(input.id, mutation);
  // Autonomy design §B.6 (REQ-124 c): an answer that differs from a standing precedent on its subject supersedes it.
  const home = dataHome(deps);
  if (home !== null) supersedePrecedentsBy(answered, { home, now: new Date(at), ...(deps.log === undefined ? {} : { log: deps.log }) });
  await handOver(answered, paseo, deps);
  return { decision: reread(store, answered) };
}

/**
 * `decisions.confirm` (§A.5 c, §A.6): closes a decision the owner says was
 * answered in a chat, or returns it to `open`. A close is handed to
 * `onSettled` like any answer.
 */
export async function handleDecisionsConfirm(
  input: DecisionsConfirmInput,
  paseo: unknown,
  deps: DecisionRpcDeps = {},
): Promise<DecisionOutput> {
  const store = storeOf(deps, "confirm the decision");
  const at = (deps.now?.() ?? new Date()).toISOString();
  const mutation = writing("confirm the decision", () =>
    store.transition(input.id, (decision) => confirmDecision(decision, { answered: input.answered, at })),
  );
  const decision = settledOrThrow(input.id, mutation);
  // Kept open: still the owner's to answer, so the prediction only as a proposal at a level of 1 or more.
  if (decision.status !== "answered") return { decision: ownerViewsOf(deps)(decision) };
  await handOver(decision, paseo, deps);
  return { decision: reread(store, decision) };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

export function registerDecisionRpcs(server: PluginServerContext, deps: DecisionRpcDeps = {}): void {
  server.handle(decisionsListRpc, (input) => handleDecisionsList(input, deps));
  server.handle(decisionsGetRpc, (input) => handleDecisionsGet(input, deps));
  server.handle(decisionsAnswerRpc, (input, context) => handleDecisionsAnswer(input, context?.paseo, deps));
  server.handle(decisionsConfirmRpc, (input, context) => handleDecisionsConfirm(input, context?.paseo, deps));
  // Autonomy design §B.7: the digest's Override opens an owner decision; its answer takes `onSettled` like any other.
  server.handle(decisionsOverrideRpc, (input) => handleDecisionsOverride(input, deps));
}
