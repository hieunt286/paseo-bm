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
 * gets a second one. Nothing here throws into a turn end.
 */
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import type { BindingStore } from "./agent-bindings";
import { sliceLastTurn } from "./collector";
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
  /** The per-agent bindings: only a bound Reviewer is checked. */
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

/**
 * Checks one turn end (design §16.10) and sends the `no-verdict` record when
 * every condition holds. Call it after the fallback detection ran for the
 * turn. Never throws.
 */
export async function checkNoVerdict(event: TurnEndedEvent, deps: NoVerdictDeps): Promise<NoVerdictOutcome> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const agent = event?.agent;
    if (agent === undefined || roleOfProvider(agent.provider) !== "reviewer" || deps.bindings === null) return "not-bound-reviewer";
    const binding = deps.bindings.bindingOfAgent(agent.id);
    if (
      binding === null ||
      binding.role !== "reviewer" ||
      binding.state !== "bound" ||
      !binding.creationTools ||
      binding.requestId === null ||
      binding.batchId === null ||
      binding.parentId === null
    ) {
      return "not-bound-reviewer";
    }
    const outcome = (event.outcome as { kind?: unknown } | undefined)?.kind;
    // A canceled turn was the Worker's stop; any other kind is not a finished review turn.
    if (outcome !== "completed" && outcome !== "failed") return "outcome";
    // A provider failure is the fallback's (an incident, its card and its switch).
    if (deps.classified) return "fallback";

    const { requestId, batchId, parentId: workerId, workspaceId } = binding;
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
    // Once per (batchId, callId): a no-verdict created after the call is this call's.
    if (records.some((record) => record.kind === "no-verdict")) return "already-sent";

    await storeAndDeliver(
      workspaceId,
      { kind: "no-verdict", requestId, batchId, from: agent.id, to: workerId, text: noVerdictTextOf({ requestId, batchId, reviewerId: agent.id }) },
      {
        home: deps.home,
        log,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...deps.outbox,
        ...(deps.queue === undefined ? {} : { queue: deps.queue }),
        paseo: deps.paseo as NoticePaseo,
      },
    );
    return "sent";
  } catch (error) {
    log(`[paseo-bm] the missing-verdict check of ${event?.agent?.id ?? "(unknown)"} failed: ${reasonOf(error)}`);
    return "failed";
  }
}
