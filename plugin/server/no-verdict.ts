/**
 * Wake-ups and a missing verdict (design §16.10; ADR-027 decision 11, spike S2
 * passed).
 *
 * A Worker created by `bm_create_worker`, or a Reviewer created by
 * `bm_create_reviewer`, has its creator as `parent`, but the creator did not
 * call `create_agent`, so Paseo's `notifyOnFinish` wake does not apply (S2: a
 * child created through the SDK with `parent` never woke its parent). The
 * parent is woken only by deliveries (§16.7) and by the plugin's own notices;
 * nothing here turns a Worker's turn end into a Manager turn.
 *
 * So a bound Reviewer that ends its turn without `bm_review` would leave its
 * Worker waiting forever. On `agent.turn_ended` of a bound Reviewer — AFTER
 * `fallback-detect.ts` has classified that turn (`registerFallbackDetection`
 * runs this as its after-step) — the plugin stores and delivers one
 * `no-verdict` outbox record to its Worker when all hold:
 *
 * - the outcome is `completed`, or `failed`, and the fallback detection found
 *   no provider failure in the turn (a turn with a fallback incident is the
 *   fallback's); a `canceled` turn sends nothing: the Worker stopped it;
 * - no `review` record exists for its batch since the turn's review call —
 *   the call its first message names (`BM-BRIEF reviewer … call:`,
 *   `BM-DELIVERY message <id>`), else the batch's newest call;
 * - no `no-verdict` was sent for that `(batchId, callId)` yet.
 *
 * At most one per review call: a re-review that also ends without a verdict
 * gets a second one.
 *
 * **A plugin-created Reviewer that ended up unbound** — its base provider is
 * outside `TOOL_PROVIDERS` (Pi, Copilot), or the hook never kept its token —
 * has no `bm_review` and writes its `BM-REVIEW` as its final answer, which
 * nothing would carry to its Worker. It is known by the registry: it is a
 * Reviewer of one of the request's batches (`noteReviewer`). At its turn end,
 * under the same conditions, the plugin parses its final `BM-REVIEW`
 * (`finalReviewOf`, `parseReviews`) and stores and delivers it to its Worker
 * as a `review` record — the path a bound `bm_review` takes — once per review
 * call; a turn without one gets the `no-verdict` record. Nothing here throws
 * into a turn end.
 */
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import type { BindingStore } from "./agent-bindings";
import { parseReviews } from "./bm-report";
import { joinStreamedText, sliceLastTurn } from "./collector";
import type { NoticePaseo, NoticeQueue } from "./notice-queue";
import { createOutbox, storeAndDeliver, type OutboxDeps } from "./outbox";
import { createRequestRegistry, type ReviewCall } from "./request-registry";
import { reasonOf } from "./role-choices";
import { NO_VERDICT_SENTENCE, reviewCallIdOf } from "../shared/notices";
import { timeOrZero } from "../shared/time";

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];

/** What one check did, for the tests and the log. */
export type NoVerdictOutcome =
  | "sent"
  | "review-delivered"
  | "not-bound-reviewer"
  | "outcome"
  | "fallback"
  | "no-call"
  | "verdict"
  | "already-sent"
  | "failed";

/** The text of a `no-verdict` record (design §16.7): the request, the batch, the Reviewer, the fixed sentence. */
export function noVerdictTextOf(input: { requestId: string; batchId: string; reviewerId: string }): string {
  return [`requestId: ${input.requestId}`, `batchId: ${input.batchId}`, `reviewer: ${input.reviewerId}`, NO_VERDICT_SENTENCE].join("\n");
}

export interface NoVerdictDeps {
  /** The data folder. */
  home: string;
  /** The turn's Paseo handle. */
  paseo: unknown;
  /** The per-agent bindings: a bound Reviewer is checked by its binding, any other by the request registry. */
  bindings: BindingStore | null;
  /** True when the fallback detection classified this turn as a provider failure (an incident is, or was already, open). */
  classified: boolean;
  now?: () => Date;
  log?: (message: string) => void;
  queue?: Pick<NoticeQueue, "enqueue">;
  outbox?: Pick<OutboxDeps, "newId" | "env">;
}

/** The first user message of the turn that just ended, or null. */
function turnPromptOf(event: TurnEndedEvent): string | null {
  const raw: unknown = (event as { timeline?: unknown }).timeline;
  const timeline: readonly unknown[] = Array.isArray(raw) ? raw : [];
  const first = sliceLastTurn(timeline)[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "user_message" && typeof first.text === "string" ? first.text : null;
}

/** A `BM-REVIEW` marker line, as `parseReviews` reads one. */
const REVIEW_MARKER_LINE = /^\s*>?\s*(?:[-*]\s*)?(?:\*\*)?bm-review\b/i;

/**
 * The final `BM-REVIEW` of the turn that just ended: in its last reply that
 * holds one with a verdict, from that block's marker line to the end. Null
 * when the turn wrote none. Pure.
 */
export function finalReviewOf(timeline: readonly unknown[], agentId: string, at: string): string | null {
  const replies = joinStreamedText(sliceLastTurn(timeline)).filter(
    (item): item is { type: "assistant_message"; text: string } =>
      (item as { type?: unknown } | null)?.type === "assistant_message" && typeof (item as { text?: unknown }).text === "string",
  );
  for (const reply of [...replies].reverse()) {
    const lines = reply.text.replace(/\r\n/g, "\n").split("\n");
    const start = lines.findLastIndex((line) => REVIEW_MARKER_LINE.test(line));
    if (start === -1) continue;
    const block = lines.slice(start).join("\n").trim();
    if (parseReviews(block, { agentId, at }).some((review) => review.verdict !== null)) return block;
  }
  return null;
}

/** The request, batch and Worker a Reviewer reviews for, and how it delivers. */
interface ReviewerContext {
  workspaceId: string;
  requestId: string;
  batchId: string;
  workerId: string;
  /** True for a Reviewer bound with the creation tools: its `bm_review` delivers. */
  bound: boolean;
}

/**
 * A bound Reviewer's facts from its binding; else, for a Reviewer the plugin
 * created that is unbound, from the request registry (a batch that names it
 * among its Reviewers) and its parent. Null for any other agent. Never throws.
 */
function reviewerContextOf(agent: TurnEndedEvent["agent"], deps: Pick<NoVerdictDeps, "bindings" | "home">, log: (message: string) => void): ReviewerContext | null {
  const binding = deps.bindings?.bindingOfAgent(agent.id) ?? null;
  if (binding !== null && binding.role === "reviewer" && binding.state === "bound" && binding.creationTools) {
    if (binding.requestId === null || binding.batchId === null || binding.parentId === null) return null;
    return { workspaceId: binding.workspaceId, requestId: binding.requestId, batchId: binding.batchId, workerId: binding.parentId, bound: true };
  }
  if (binding !== null && binding.state === "bound") return null;
  if (agent.workspaceId === null) return null;
  for (const request of createRequestRegistry(deps.home, { log }).list(agent.workspaceId)) {
    const batch = request.reviews.batches.find((entry) => entry.reviewerIds.includes(agent.id));
    if (batch === undefined) continue;
    const workerId = agent.parentAgentId ?? request.workerIds.at(-1) ?? null;
    if (workerId === null) return null;
    return { workspaceId: agent.workspaceId, requestId: request.requestId, batchId: batch.batchId, workerId, bound: false };
  }
  return null;
}

/**
 * Checks one turn end (design §16.10) and sends the `no-verdict` record when
 * every condition holds — or, for a plugin-created Reviewer that is unbound,
 * delivers its final `BM-REVIEW` as a `review` record. Call it after the
 * fallback detection ran for the turn. Never throws.
 */
export async function checkNoVerdict(event: TurnEndedEvent, deps: NoVerdictDeps): Promise<NoVerdictOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const agent = event?.agent;
    if (agent === undefined || roleOfProvider(agent.provider) !== "reviewer") return "not-bound-reviewer";
    const context = reviewerContextOf(agent, deps, log);
    if (context === null) return "not-bound-reviewer";
    const outcome = (event.outcome as { kind?: unknown } | undefined)?.kind;
    // A canceled turn was the Worker's stop; any other kind is not a finished review turn.
    if (outcome !== "completed" && outcome !== "failed") return "outcome";
    // A provider failure is the fallback's (an incident, its card and its switch).
    if (deps.classified) return "fallback";

    const { requestId, batchId, workerId, workspaceId } = context;
    const request = createRequestRegistry(deps.home, { log }).get(workspaceId, requestId);
    const batch = request?.reviews.batches.find((entry) => entry.batchId === batchId);
    if (batch === undefined || batch.calls.length === 0) return "no-call";
    // The call this turn answered: the one its first message names, else the batch's newest.
    const named = reviewCallIdOf(turnPromptOf(event));
    const newest = [...batch.calls].sort((a, b) => timeOrZero(a.at) - timeOrZero(b.at)).at(-1)!;
    const call: ReviewCall = (named === null ? undefined : batch.calls.find((entry) => entry.callId === named)) ?? newest;
    const since = timeOrZero(call.at);

    const outbox = createOutbox(deps.home, { ...(deps.now === undefined ? {} : { now: deps.now }), ...deps.outbox });
    const records = outbox.list(workspaceId).filter((record) => record.requestId === requestId && record.batchId === batchId && timeOrZero(record.createdAt) >= since);
    if (records.some((record) => record.kind === "review")) return "verdict";
    const delivery = {
      home: deps.home,
      log,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...deps.outbox,
      ...(deps.queue === undefined ? {} : { queue: deps.queue }),
      paseo: deps.paseo as NoticePaseo,
    };
    // An unbound Reviewer's review is its final answer: the plugin carries it, as bm_review would.
    if (!context.bound) {
      const raw: unknown = (event as { timeline?: unknown }).timeline;
      const review = finalReviewOf(Array.isArray(raw) ? raw : [], agent.id, (deps.now?.() ?? new Date()).toISOString());
      if (review !== null) {
        await storeAndDeliver(workspaceId, { kind: "review", requestId, batchId, from: agent.id, to: workerId, text: review }, delivery);
        return "review-delivered";
      }
    }
    // Once per (batchId, callId): a no-verdict created after the call is this call's.
    if (records.some((record) => record.kind === "no-verdict")) return "already-sent";

    await storeAndDeliver(
      workspaceId,
      { kind: "no-verdict", requestId, batchId, from: agent.id, to: workerId, text: noVerdictTextOf({ requestId, batchId, reviewerId: agent.id }) },
      delivery,
    );
    return "sent";
  } catch (error) {
    log(`[paseo-bm] the missing-verdict check of ${event?.agent?.id ?? "(unknown)"} failed: ${reasonOf(error)}`);
    return "failed";
  }
}
