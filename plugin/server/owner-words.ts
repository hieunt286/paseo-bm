/**
 * The owner's words to a running Worker (delivery line design §19.5, ADR-038
 * decision 4): which deliveries are the owner's words, so the notice queue
 * steers them into the Worker's running turn (`EnqueueOptions.steer`), and
 * what is told when Paseo replaced that turn instead.
 *
 * - `isOwnerWords(delivery)`: a `bm_tell_worker` with `now: true` (stored as a
 *   `message` record with `atOnce`), or a `BM-COMMAND` to a Worker from the
 *   option the owner chose on a decision card (not the owner's policy, an
 *   owner precedent or the Orchestrator's own command). A `/bm-worker-new`
 *   request goes from the client to the Main, which creates a new Worker for
 *   it: it never reaches a running Worker, so it is no class here.
 * - `reportTurnReplaced(input)`: the Main is told with one `BM-SIGNAL
 *   replaced` (on its channel, `main-channel.ts`), and the owner's Inbox gets
 *   one `turn-replaced` alert for the Worker, cleared when its request
 *   reports `finished` or `stopped`. The queue logs the line itself. Never
 *   throws.
 */
import { SIGNAL_NOTICE_MARKER } from "../shared/notices";
import { createAlertStore } from "./alert-store";
import { enqueueNotice, type ChannelQueue } from "./main-channel";
import type { NoticePaseo } from "./notice-queue";
import { errorText } from "./rpc-kit";

/** A delivery to a Worker, as its sender knows it. */
export type OwnerWordsDelivery =
  /** `bm_tell_worker`: `now` is its `now: true` (the record's `atOnce`). */
  | { via: "tell"; now: boolean }
  /** A `BM-COMMAND`: its target's role, and who answered the decision whose prepared command it is (null for a command of no decision). */
  | { via: "command"; to: "worker" | "manager"; answeredBy: string | null | undefined };

/** Whether a delivery carries the owner's words (delivery line design §19.5). Pure. */
export function isOwnerWords(delivery: OwnerWordsDelivery): boolean {
  if (delivery.via === "tell") return delivery.now === true;
  return delivery.to === "worker" && delivery.answeredBy === "owner";
}

/** The queue kind of a Worker's replaced-turn signal to its Main: the newest per Worker. */
export function turnReplacedKindOf(workerId: string): string {
  return `signal-replaced:${workerId}`;
}

/** The `BM-SIGNAL replaced` notice to a Main (delivery line design §19.5). Pure. */
export function turnReplacedSignalOf(input: { workerId: string; requestId: string | null; workspaceId: string; what: string }): string {
  return [
    `${SIGNAL_NOTICE_MARKER} replaced`,
    `From the paseo-bm plugin, not the owner: Paseo could not steer ${input.what} into the running turn of your Worker ${input.workerId} (request ${input.requestId ?? "not known"}, repo ${input.workspaceId}), so it stopped that turn and started a new one with them.`,
    "The Worker goes on from there; work of the stopped turn it had not saved may be redone. Nothing to do unless its next report shows lost work; the owner's Inbox shows it.",
  ].join("\n");
}

/** What `reportTurnReplaced` tells. */
export interface TurnReplaced {
  home: string;
  /** The Worker's project. */
  workspaceId: string;
  workerId: string;
  requestId: string | null;
  /** Who is told; null for none. */
  mainId: string | null;
  /** The words in the notice: "the owner's words (message out-…)". */
  what: string;
  turnBefore: string;
  turnAfter: string | null;
  paseo?: NoticePaseo;
  queue?: ChannelQueue;
  now?: () => Date;
  log?: (message: string) => void;
}

/** Tells the Main and opens the owner's Inbox alert of a replaced turn (see the module comment). Never throws. */
export async function reportTurnReplaced(input: TurnReplaced): Promise<void> {
  const log = input.log ?? ((message: string) => console.warn(message));
  try {
    createAlertStore(input.home, input.now === undefined ? {} : { now: input.now }).raise({
      workspaceId: input.workspaceId,
      kind: "turn-replaced",
      subject: input.workerId,
      detail: `Paseo replaced the running turn of Worker ${input.workerId} (request ${input.requestId ?? "not known"}) with ${input.what} instead of steering them in (turn ${input.turnBefore} → ${input.turnAfter ?? "not known"}).`,
    });
  } catch (error) {
    log(`[paseo-bm] could not raise the turn-replaced alert of ${input.workerId}: ${errorText(error)}`);
  }
  if (input.mainId === null) return;
  try {
    const text = turnReplacedSignalOf({ workerId: input.workerId, requestId: input.requestId, workspaceId: input.workspaceId, what: input.what });
    await enqueueNotice({
      home: input.home,
      targetId: input.mainId,
      kind: turnReplacedKindOf(input.workerId),
      text,
      ...(input.paseo === undefined ? {} : { paseo: input.paseo }),
      ...(input.queue === undefined ? {} : { queue: input.queue }),
    });
  } catch (error) {
    log(`[paseo-bm] could not tell ${input.mainId} that ${input.workerId}'s turn was replaced: ${errorText(error)}`);
  }
}

/** Clears the Worker's `turn-replaced` alert (its request reported `finished` or `stopped`). Never throws. */
export function clearTurnReplacedAlert(home: string, workspaceId: string, workerId: string, deps: { now?: () => Date } = {}): void {
  try {
    const alerts = createAlertStore(home, deps.now === undefined ? {} : { now: deps.now });
    alerts.clearWhere((alert) => alert.kind === "turn-replaced" && alert.workspaceId === workspaceId && alert.subject === workerId);
  } catch {
    // An Inbox alert that cannot be cleared stays; nothing else depends on it.
  }
}
