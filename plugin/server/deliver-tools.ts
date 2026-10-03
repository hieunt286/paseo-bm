/**
 * The bound agents' delivering tools (design §16.6, §16.7; ADR-027 decisions
 * 4 and 9, ship point C): a bound agent writes the content, the plugin's code
 * carries it.
 *
 * | Tool | Caller | Does |
 * |---|---|---|
 * | `bm_report` | bound Worker | builds and checks the `BM-REPORT`, stores a `report` outbox record, delivers it to the Manager that created the Worker; `finished` is refused while a review call of the request has no verdict delivered (`batchesAwaitingVerdict`); `finished` expires the request's unsettled questions; `finished` or `stopped` clears its `delivery-dropped` and `off-tool-reviewer` alerts; the registry's `tier` and `finishedAt` follow it |
 * | `bm_questions` | bound Worker | opens each question through the materialiser's shared open path (`openQuestions`), numbered after the request's highest `Qn` |
 * | `bm_review` | bound Reviewer | builds and checks the `BM-REVIEW`, stores a `review` record for its batch, delivers it to its Worker |
 * | `bm_answers` | bound Manager | checks each `Qn` is an open question of a request of its own and proposes the answers for its current turn (`proposed-answers.ts`); the materialiser settles them at the turn's end only with the owner's own message in it |
 * | `bm_tell_worker` | bound Manager | stores a `message` record and delivers `Continue <requestId>.`, the owner's words and their source to the request's sole live Worker |
 *
 * An unbound caller never reaches `bm_report`, `bm_review` or `bm_answers`
 * here: the endpoint answers it with the pure builders (`agent-tools.ts`).
 * `bm_questions` and `bm_tell_worker` refuse it with one line.
 *
 * Common rules (§16.6): a refusal is `{ ok: false }` (the endpoint's
 * `isError`), one line per reason, and nothing is written, created or sent; a
 * pending binding is refused by the shared guard ("try again in a moment",
 * `tool-kit.ts`). **The binding is the
 * authority for the request**: a bound Worker's or Reviewer's call whose input
 * `requestId` (or a Reviewer's `batchId`) differs from its binding's is
 * refused, naming both. **A bound Manager's requests** are only those whose
 * registry record names it as `managerId`.
 *
 * Nothing here throws into the endpoint: a failure is one refusal line.
 */
import type { ToolCaller } from "./agent-bindings";
import { answersKindOf, soleWorkerOfRequest } from "./decision-delivery";
import { expireQuestionsOf, openQuestions, type OpenContext, type OpenableQuestion } from "./decision-materialiser";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import type { ServerToolAnswer, ServerTools } from "./decision-tools";
import type { NoticeQueue } from "./notice-queue";
import { clearOffToolAlertsOfRequest } from "./off-tool-reviewer";
import { stopRunningReviewers, type StopPaseo } from "./stop-propagation";
import { OUTBOX_SETTLED_MS, clearDroppedAlert, createOutbox, deliverRecord, isOpenRecord, type OutboxDeps, type OutboxRecord } from "./outbox";
import type { DashboardPaseo } from "./paseo-directory";
import { proposeAnswers } from "./proposed-answers";
import { createRequestRegistry, type RegisteredRequest } from "./request-registry";
import { reasonOf } from "./role-choices";
import { actingTools, answered, boundAs, deliveryOf, fixThese, outboxDepsOf, refused, withoutNulls, type DeliveryState } from "./tool-kit";
import { timeOrZero } from "../shared/time";
import {
  BOUND_ANSWERS_TOOL,
  BOUND_REPORT_TOOL,
  BOUND_REVIEW_TOOL,
  QUESTIONS_FACE,
  TELL_WORKER_FACE,
  questionsRules,
  schemaIssues,
  type AgentTool,
  type QuestionsInput,
} from "../shared/bm-tools";
import { decisionKindOf, isAnswerable, questionDecisionId, type Decision } from "../shared/decisions";

export const QUESTIONS_TOOL = "bm_questions";
export const TELL_WORKER_TOOL = "bm_tell_worker";

/** No Paseo handle has reached the plugin yet (as `bm_create_worker` says, design §7.4). */
export const NO_PASEO_DELIVERY_MESSAGE = "paseo-bm has no connection to Paseo yet; try again in a moment. Nothing was stored or sent.";
/** `bm_questions` for a caller that is not a Worker bound with the tools. */
export const QUESTIONS_NOT_BOUND_MESSAGE =
  "bm_questions is only for a Worker paseo-bm created with its own tools, and you are not one: ask in your bm_report's questions as your instructions say. Nothing was opened.";
/** `bm_tell_worker` for a caller that is not a Manager bound with the tools. */
export const TELL_NOT_BOUND_MESSAGE =
  "bm_tell_worker is only for a Manager paseo-bm created with its own tools, and you are not one: give the Worker the owner's words as your instructions say. Nothing was sent.";
/** A bound builder name reached with a caller that is not bound (the endpoint answers unbound callers with the builders). */
export const DELIVERY_NOT_BOUND_MESSAGE = "This tool delivers only for an agent paseo-bm created with its own tools. Nothing was stored or sent.";

export interface DeliveringToolDeps {
  /** The last Paseo handle a hook or RPC brought; null before any did. */
  paseo: () => unknown;
  /** The data folder (the endpoint's: it serves no tools without one). */
  home: () => string;
  log?: (message: string) => void;
  now?: () => Date;
  /** The notice queue deliveries go through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** The outbox's record ids and masking; tests pin them. */
  outbox?: Pick<OutboxDeps, "newId" | "env">;
  /** Decisions `bm_questions` opened: the event bus's `decision.opened` (delegation, autonomy design §B.5). */
  onOpened?: (opened: readonly Decision[], paseo: unknown) => unknown;
  /** The start of a Manager's running turn (`currentTurnStartOf`, the collector's start mark). */
  turnStartOf?: (agentId: string) => string | null;
  /** The request's sole live Worker; `soleWorkerOfRequest` by default. */
  workerOf?: (input: { workspaceId: string; requestId: string; home: string }, paseo: DashboardPaseo) => Promise<string | null>;
  /**
   * Stops a Worker's running Reviewers when it reports `stopped` (design §7.9):
   * the Worker no longer cancels them itself, and a stop typed in its chat
   * reaches no Stop-button hook. `stopRunningReviewers` by default.
   */
  stopReviewers?: (paseo: unknown, workerId: string, workspaceId: string) => Promise<unknown>;
}

export interface DeliveringTools {
  /** `bm_report`, `bm_questions`. */
  worker: ServerTools;
  /** `bm_review`. */
  reviewer: ServerTools;
  /** `bm_answers`, `bm_tell_worker`. */
  manager: ServerTools;
}

/** The input's `field` when it is a string, else null. */
function stringField(input: unknown, field: string): string | null {
  const value = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" ? value : null;
}

/** The refusal of a call whose input names another request (or batch) than the binding's (design §16.6), or null. */
function bindingMismatch(field: "requestId" | "batchId", given: string | null, bound: string | null): string | null {
  if (given === null || bound === null || given === bound) return null;
  const what = field === "requestId" ? "request" : "batch";
  return `${field} ${given} is not yours: paseo-bm created you for ${what} ${bound}. Use ${bound}. Nothing was stored or sent.`;
}

/**
 * The batches of `request` whose newest review call has no verdict delivered
 * yet (design §16.6, `bm_report`; acceptance finding F3): no `review` or
 * `no-verdict` record of that batch, created at or after the call, has
 * settled. A verdict still `pending` or `queued` has not reached the Worker,
 * so it does not count; a `dropped` one does (its alert is the owner's). A
 * `no-verdict` settles the call: the Worker reports the batch as not reviewed.
 * A call older than the outbox keeps settled records (`OUTBOX_SETTLED_MS`)
 * counts as settled, since its verdict can no longer be read. Off-tool
 * Reviewers are not registry calls: the plugin cancels them at once (§16.8),
 * so none of them owes a verdict. Pure.
 */
export function batchesAwaitingVerdict(request: RegisteredRequest | null, records: readonly OutboxRecord[], now: Date): string[] {
  if (request === null) return [];
  return request.reviews.batches.flatMap((batch) => {
    const newest = batch.calls.reduce<number | null>((latest, call) => Math.max(latest ?? Number.NEGATIVE_INFINITY, timeOrZero(call.at)), null);
    if (newest === null || now.getTime() - newest > OUTBOX_SETTLED_MS) return [];
    const settled = records.some(
      (record) =>
        (record.kind === "review" || record.kind === "no-verdict") &&
        record.requestId === request.requestId &&
        record.batchId === batch.batchId &&
        timeOrZero(record.createdAt) >= newest &&
        !isOpenRecord(record),
    );
    return settled ? [] : [batch.batchId];
  });
}

export function createDeliveringTools(deps: DeliveringToolDeps): DeliveringTools {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const paseoOf = (): unknown => {
    const paseo = deps.paseo();
    return paseo === null || paseo === undefined ? null : paseo;
  };

  /** Stores `init` (`pending`, written first), runs `before` once it is stored, then delivers it (§16.7). */
  const storeThenDeliver = async (
    home: string,
    workspaceId: string,
    init: { kind: OutboxRecord["kind"]; requestId: string; batchId?: string | null; from: string; to: string; text: string },
    paseo: unknown,
    before: (record: OutboxRecord) => void = () => {},
  ): Promise<ServerToolAnswer | { record: OutboxRecord; delivery: DeliveryState }> => {
    const outboxDeps = outboxDepsOf(home, { ...deps, now, log }, paseo);
    let record: OutboxRecord;
    try {
      record = createOutbox(home, outboxDeps).add(workspaceId, init);
    } catch (error) {
      return refused(`paseo-bm could not store your ${init.kind} (${reasonOf(error)}); nothing was sent. Tell the owner in one line.`);
    }
    before(record);
    const outcome = await deliverRecord(workspaceId, record, outboxDeps);
    return { record, delivery: deliveryOf(outcome) };
  };

  /** One run of a bound block tool's builder: its text, or the refusal listing each problem. */
  const build = (tool: AgentTool, input: unknown): { text: string } | ServerToolAnswer => {
    const result = tool.run(input);
    return result.ok ? { text: result.text } : fixThese(tool.name, result.issues);
  };

  // -------------------------------------------------------------------------
  // bm_report (bound Worker).
  // -------------------------------------------------------------------------

  const report = async (input: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundAs(caller, "worker");
    if (worker === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    if (worker.requestId === null) return refused("paseo-bm does not know your request, so it cannot deliver your report; tell the owner in one line and stop. Nothing was stored or sent.");
    const mismatch = bindingMismatch("requestId", stringField(input, "requestId"), worker.requestId);
    if (mismatch !== null) return refused(mismatch);
    const built = build(BOUND_REPORT_TOOL, input);
    if ("ok" in built) return built;
    const home = deps.home();
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    if (worker.parentId === null) return refused("paseo-bm does not know the Manager that created you, so it cannot deliver your report; tell the owner in one line and stop. Nothing was stored or sent.");
    const { phase, tier, waitingOn } = withoutNulls(input) as { phase: string; tier: { level: "Small" | "Medium" | "Large" }; waitingOn?: string[] };
    const requestId = worker.requestId;
    if (phase === "finished") {
      // A review the request has running ends before `finished` (F3); `stopped` and `blocked` are never held for it.
      const waiting = batchesAwaitingVerdict(createRequestRegistry(home, { log }).get(worker.workspaceId, requestId), createOutbox(home, { now }).list(worker.workspaceId), now());
      if (waiting.length > 0) {
        return refused(
          [...waiting.map((batchId) => `a review of batch ${batchId} has no verdict yet: wait for its delivery, then report finished`), "Nothing was stored or sent."].join("\n"),
        );
      }
    }
    const store = createDecisionStore(home, { log });
    // Only open questions of this request: the owner can still answer them.
    const notOpen = (waitingOn ?? []).filter((id) => {
      const decision = store.get(id, worker.workspaceId);
      return decision === null || decision.requestId !== requestId || !isAnswerable(decision);
    });
    if (notOpen.length > 0) {
      return fixThese(
        "bm_report",
        notOpen.map((id) => `input.waitingOn: ${id} is not an open question of ${requestId}; ask it with bm_questions, or leave it out`),
      );
    }
    const at = now().toISOString();
    const stored = await storeThenDeliver(
      home,
      worker.workspaceId,
      { kind: "report", requestId, from: worker.agentId, to: worker.parentId, text: built.text },
      paseo,
      () => {
        // A finished request no longer waits on its questions (§A.3); a stopped one expires nothing.
        if (phase === "finished") expireQuestionsOf({ store, workspaceId: worker.workspaceId, log }, requestId, at);
        try {
          createRequestRegistry(home, { log }).noteReport(worker.workspaceId, requestId, { tier: tier.level, phase, at });
        } catch (error) {
          log(`[paseo-bm] could not note the report of request ${requestId} in the registry: ${reasonOf(error)}`);
        }
        if (phase === "finished" || phase === "stopped") {
          try {
            clearDroppedAlert(home, worker.workspaceId, requestId, null, { now });
          } catch (error) {
            log(`[paseo-bm] could not clear the delivery-dropped alert of request ${requestId}: ${reasonOf(error)}`);
          }
          // Design §16.8: an ended request's off-tool Reviewer alerts end with it.
          clearOffToolAlertsOfRequest(home, worker.workspaceId, requestId, { now });
        }
      },
    );
    if ("ok" in stored) return stored;
    if (phase === "stopped") {
      // Not awaited: the report is answered at once; a failure costs one log line.
      const stop = deps.stopReviewers ?? ((handle, workerId, workspaceId) => stopRunningReviewers(handle as StopPaseo, workerId, workspaceId));
      void stop(paseo, worker.agentId, worker.workspaceId).catch((error: unknown) => log(`[paseo-bm] could not stop the Reviewers of Worker ${worker.agentId}: ${reasonOf(error)}`));
    }
    return answered({ recordId: stored.record.id, delivery: stored.delivery });
  };

  // -------------------------------------------------------------------------
  // bm_questions (bound Worker).
  // -------------------------------------------------------------------------

  /** The highest `Qn` the request's questions use; 0 for none. */
  const highestQuestion = (store: DecisionStore, workspaceId: string, requestId: string): number =>
    store
      .list({ workspaceId, requestId })
      .filter((decision) => decisionKindOf(decision.id) === "question")
      .reduce((highest, decision) => Math.max(highest, Number(decision.id.slice(decision.id.lastIndexOf(":Q") + 2)) || 0), 0);

  const answerTextOf = (decision: Decision): string | undefined => {
    const answer = decision.answer;
    if (answer === null) return undefined;
    if (answer.optionKey !== null) return `${answer.optionKey} — ${decision.options.find((option) => option.key === answer.optionKey)?.label ?? ""}`.trim();
    return answer.words ?? undefined;
  };

  const questions = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const worker = boundAs(caller, "worker");
    if (worker === null) return refused(QUESTIONS_NOT_BOUND_MESSAGE);
    if (worker.requestId === null) return refused("paseo-bm does not know your request, so it cannot open your questions; tell the owner in one line and stop. Nothing was opened.");
    const input = withoutNulls(raw);
    const shape = schemaIssues(QUESTIONS_FACE.inputSchema, input);
    if (shape.length > 0) return fixThese(QUESTIONS_TOOL, shape);
    const typed = input as QuestionsInput;
    const broken = questionsRules(typed);
    if (broken.length > 0) return fixThese(QUESTIONS_TOOL, broken);
    const home = deps.home();
    const requestId = worker.requestId;
    const store = createDecisionStore(home, { log });
    // A question it asks again must be one of this request's.
    const known = new Set(store.list({ workspaceId: worker.workspaceId, requestId }).map((decision) => decision.id));
    const unknown = typed.questions.flatMap((question, index) =>
      question.supersedes !== undefined && !known.has(questionDecisionId(requestId, question.supersedes))
        ? [`input.questions[${index}].supersedes: ${question.supersedes} is not a question of ${requestId}`]
        : [],
    );
    if (unknown.length > 0) return fixThese(QUESTIONS_TOOL, unknown);

    // Numbered after the request's highest Qn, and opened at once: nothing reads the store in between.
    const first = highestQuestion(store, worker.workspaceId, requestId) + 1;
    const openable: OpenableQuestion[] = typed.questions.map((question, index) => ({
      id: `Q${first + index}`,
      text: question.text,
      subject: question.subject,
      class: question.class,
      ...(question.supersedes === undefined ? {} : { supersedes: question.supersedes }),
      options: question.options.map((option) => ({
        key: option.key,
        text: option.text,
        recommended: option.recommended === true,
        effects: option.effects,
        ...(option.grant === undefined ? {} : { grant: option.grant.calls !== undefined ? { calls: option.grant.calls } : { untilClean: option.grant.untilClean! } }),
      })),
    }));
    const at = now().toISOString();
    const context: OpenContext = { home, store, workspaceId: worker.workspaceId, now: at, log, outcome: { opened: [], superseded: [], answered: [], reversed: [] } };
    openQuestions(context, { requestId, questions: openable, askedBy: worker.agentId, askedAt: at });

    // A question a precedent answered at once comes back answered: the Worker has the answer, so the plugin sends nothing.
    for (const decision of context.outcome.answered) {
      try {
        store.transition(
          decision.id,
          (current) => ({ ok: true, decision: { ...current, delivery: { to: worker.agentId, kind: answersKindOf(requestId), at, outcome: "sent" } } }),
          worker.workspaceId,
        );
      } catch (error) {
        log(`[paseo-bm] could not record that ${decision.id} reached its Worker in bm_questions' answer: ${reasonOf(error)}`);
      }
    }
    if (context.outcome.opened.length > 0 && deps.onOpened !== undefined) {
      try {
        await deps.onOpened(context.outcome.opened, paseoOf());
      } catch (error) {
        log(`[paseo-bm] the questions ${context.outcome.opened.map((decision) => decision.id).join(", ")} opened, but their events failed: ${reasonOf(error)}`);
      }
    }
    const results = openable.map((question) => {
      const decisionId = questionDecisionId(requestId, question.id);
      return { qn: question.id, decisionId, decision: store.get(decisionId, worker.workspaceId) };
    });
    const missing = results.filter((entry) => entry.decision === null).map((entry) => entry.qn);
    if (missing.length > 0) {
      return refused(`paseo-bm could not open ${missing.join(", ")}; see its log. Tell the owner in one line.`);
    }
    return answered(
      results.map(({ qn, decisionId, decision }) => {
        const state = decision!.status === "answered" ? "answered" : "open";
        const answer = state === "answered" ? answerTextOf(decision!) : undefined;
        return { qn, decisionId, state, ...(answer === undefined ? {} : { answer }) };
      }),
    );
  };

  // -------------------------------------------------------------------------
  // bm_review (bound Reviewer).
  // -------------------------------------------------------------------------

  const review = async (input: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const reviewer = boundAs(caller, "reviewer");
    if (reviewer === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    if (reviewer.requestId === null || reviewer.batchId === null) {
      return refused("paseo-bm does not know your request or batch, so it cannot deliver your review; make the BM-REVIEW block your final answer. Nothing was stored or sent.");
    }
    const mismatch =
      bindingMismatch("requestId", stringField(input, "requestId"), reviewer.requestId) ?? bindingMismatch("batchId", stringField(input, "batchId"), reviewer.batchId);
    if (mismatch !== null) return refused(mismatch);
    const built = build(BOUND_REVIEW_TOOL, input);
    if ("ok" in built) return built;
    const home = deps.home();
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    if (reviewer.parentId === null) return refused("paseo-bm does not know the Worker that created you, so it cannot deliver your review; make the BM-REVIEW block your final answer. Nothing was stored or sent.");
    const stored = await storeThenDeliver(
      home,
      reviewer.workspaceId,
      { kind: "review", requestId: reviewer.requestId, batchId: reviewer.batchId, from: reviewer.agentId, to: reviewer.parentId, text: built.text },
      paseo,
    );
    if ("ok" in stored) return stored;
    return answered({ recordId: stored.record.id, delivery: stored.delivery });
  };

  // -------------------------------------------------------------------------
  // The bound Manager's requests (design §16.6).
  // -------------------------------------------------------------------------

  /** The request when its registry record names `managerId` as its Manager; otherwise the refusal. */
  const managersRequest = (home: string, workspaceId: string, requestId: string, managerId: string, nothing: string): RegisteredRequest | ServerToolAnswer => {
    const request = createRequestRegistry(home, { log }).get(workspaceId, requestId);
    if (request === null) return refused(`paseo-bm knows no request ${requestId} in this workspace; use the requestId bm_create_worker gave you. ${nothing}`);
    if (request.managerId !== managerId) return refused(`request ${requestId} is not one of yours: another Manager created its Worker. ${nothing}`);
    return request;
  };

  // -------------------------------------------------------------------------
  // bm_answers (bound Manager).
  // -------------------------------------------------------------------------

  const answers = async (input: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const manager = boundAs(caller, "manager");
    if (manager === null) return refused(DELIVERY_NOT_BOUND_MESSAGE);
    const built = build(BOUND_ANSWERS_TOOL, input);
    if ("ok" in built) return built;
    const home = deps.home();
    const { requestId, answers: given } = withoutNulls(input) as { requestId: string; answers: Array<{ id: string; option?: string; optionText?: string; other?: string }> };
    const nothing = "Nothing was recorded.";
    const request = managersRequest(home, manager.workspaceId, requestId, manager.agentId, nothing);
    if ("ok" in request) return request;
    const store = createDecisionStore(home, { log });
    const issues = given.flatMap((answer, index) => {
      const decision = store.get(questionDecisionId(requestId, answer.id), manager.workspaceId);
      if (decision === null || !isAnswerable(decision)) return [`input.answers[${index}]: ${answer.id} is not an open question of ${requestId}; read them with bm_decisions`];
      if (answer.option !== undefined && !decision.options.some((option) => option.key === answer.option)) {
        return [`input.answers[${index}].option: ${answer.id} has no option ${answer.option}`];
      }
      return [];
    });
    if (issues.length > 0) return fixThese("bm_answers", issues);
    const turnStartedAt = (deps.turnStartOf ?? (() => null))(manager.agentId);
    if (turnStartedAt === null) {
      return refused("paseo-bm cannot tie these answers to your current turn (it may have reloaded during it); tell the owner to answer on the question's card. Nothing was recorded.");
    }
    proposeAnswers(manager.agentId, turnStartedAt, {
      requestId,
      answers: given.map((answer) => ({ id: answer.id, text: answer.other !== undefined ? `other — ${answer.other}` : `${answer.option} — ${answer.optionText ?? ""}` })),
    });
    return answered({ proposed: given.map((answer) => answer.id) });
  };

  // -------------------------------------------------------------------------
  // bm_tell_worker (bound Manager).
  // -------------------------------------------------------------------------

  const tell = async (raw: unknown, caller: ToolCaller | null): Promise<ServerToolAnswer> => {
    const manager = boundAs(caller, "manager");
    if (manager === null) return refused(TELL_NOT_BOUND_MESSAGE);
    const input = withoutNulls(raw);
    const shape = schemaIssues(TELL_WORKER_FACE.inputSchema, input);
    if (shape.length > 0) return fixThese(TELL_WORKER_TOOL, shape);
    const { requestId, text, source } = input as { requestId: string; text: string; source?: string };
    const home = deps.home();
    const nothing = "Nothing was sent.";
    const request = managersRequest(home, manager.workspaceId, requestId, manager.agentId, nothing);
    if ("ok" in request) return request;
    const paseo = paseoOf();
    if (paseo === null) return refused(NO_PASEO_DELIVERY_MESSAGE);
    let workerId: string | null;
    try {
      workerId = await (deps.workerOf ?? soleWorkerOfRequest)({ workspaceId: manager.workspaceId, requestId, home }, paseo as DashboardPaseo);
    } catch (error) {
      return refused(`paseo-bm could not read the Workers of ${requestId} (${reasonOf(error)}); try again in a moment. ${nothing}`);
    }
    if (workerId === null) return refused(`request ${requestId} has no single live Worker to tell; tell the owner in one line. ${nothing}`);
    const message = [`Continue ${requestId}.`, text.replace(/\r\n/g, "\n").trim(), ...(source === undefined ? [] : [`source: ${source.replace(/\s*\r?\n\s*/g, " ").trim()}`])].join("\n");
    const stored = await storeThenDeliver(home, manager.workspaceId, { kind: "message", requestId, from: manager.agentId, to: workerId, text: message }, paseo);
    if ("ok" in stored) return stored;
    return answered({ workerId, delivery: stored.delivery });
  };

  // -------------------------------------------------------------------------

  const nothingDone = "Nothing was stored or sent";
  return {
    worker: actingTools([BOUND_REPORT_TOOL, QUESTIONS_FACE], { bm_report: report, [QUESTIONS_TOOL]: questions }, nothingDone),
    reviewer: actingTools([BOUND_REVIEW_TOOL], { bm_review: review }, nothingDone),
    manager: actingTools([TELL_WORKER_FACE, BOUND_ANSWERS_TOOL], { [TELL_WORKER_TOOL]: tell, bm_answers: answers }, nothingDone),
  };
}
