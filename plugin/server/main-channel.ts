/**
 * The Main's channel (mission runtime design §6.2, ADR-033 decision 5,
 * REQ-207): every notice the plugin queues for the Main of an open mission —
 * an outbox record (`outbox.ts`), a command or its copy (`command-send.ts`), a
 * `BM-SIGNAL` (`worker-watch.ts`) — goes through the notice queue's batch kind
 * `BM-UPDATES`, item key = the notice's own kind, one group. So what is
 * pending at the Main's idle moment starts ONE turn, not one turn per notice
 * (`updatesNoticeOf`: one item alone goes as its block). A `danger` item is
 * `first`: its message goes before anything else queued for the Main. Each
 * item keeps its own callbacks, so the outbox settles, retargets and holds
 * each record as before.
 *
 * Notices to Workers, to unbound Managers and to a Main's replaced
 * predecessor go one message each, as before — except the release of a
 * Worker waiting by structure (delivery line design §6.4, `wake-gate.ts`):
 * what was held for it goes on this same batch, in one call
 * (`enqueueUpdates`), so it is one `BM-UPDATES` message with the settling
 * item first. A queue without the batch kind (a test's) sends single notices,
 * and a release as one composed notice. Never rejects.
 */
import { UPDATES_NOTICE_MARKER, updatesNoticeOf } from "../shared/notices";
import { createMissionStore } from "./mission-store";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticeCallbacks, type NoticeOutcome, type NoticePaseo, type NoticeQueue } from "./notice-queue";

/** The one batch every Main's items share (§6.2). */
export const MAIN_UPDATES: NoticeBatch = { name: UPDATES_NOTICE_MARKER, compose: (blocks) => updatesNoticeOf(blocks) };

/** A queue the channel can use: the batch kind is optional. */
export type ChannelQueue = Pick<NoticeQueue, "enqueue"> & Partial<Pick<NoticeQueue, "enqueueBatch">>;

/** Whether `agentId` is the Main of an open mission in the data folder `home`. Never throws. */
export function isMissionMain(home: string, agentId: string): boolean {
  try {
    return createMissionStore(home).openByMain(agentId) !== null;
  } catch {
    return false;
  }
}

export interface AgentNotice {
  /** The data folder, to tell whether the target is a mission's Main. */
  home: string;
  targetId: string;
  /** The notice's queue kind; the item key on the Main's channel. */
  kind: string;
  text: string;
  paseo?: NoticePaseo;
  callbacks?: NoticeCallbacks;
  /** A `danger` item: its message goes first (§6.2). Ignored off the channel. */
  first?: boolean;
  /** The wake gate at the send (delivery line design §6.4): read just before it goes; true holds it (`callbacks.onHeld`). */
  isHeld?: () => boolean;
  /** The owner's words to a Worker (delivery line design §19.5): `EnqueueOptions.steer`. Ignored on the Main's channel. */
  steer?: boolean;
  /** The plugin's shared queue by default. */
  queue?: ChannelQueue;
}

/** Queues one notice: on the Main's channel when the target is an open mission's Main, else as a single notice. Never rejects. */
export async function enqueueNotice(notice: AgentNotice): Promise<NoticeOutcome> {
  const queue = notice.queue ?? noticeQueue;
  if (queue.enqueueBatch === undefined || !isMissionMain(notice.home, notice.targetId)) {
    const args = [notice.targetId, notice.kind, notice.text, notice.paseo] as const;
    if (notice.isHeld !== undefined || notice.steer === true) {
      return queue.enqueue(...args, notice.callbacks, { ...(notice.isHeld === undefined ? {} : { isHeld: notice.isHeld }), ...(notice.steer === true ? { steer: true } : {}) });
    }
    return notice.callbacks === undefined ? queue.enqueue(...args) : queue.enqueue(...args, notice.callbacks);
  }
  const item = {
    key: notice.kind,
    line: notice.text,
    ...(notice.callbacks === undefined ? {} : { callbacks: notice.callbacks }),
    ...(notice.first === true ? { first: true } : {}),
    ...(notice.isHeld === undefined ? {} : { isHeld: notice.isHeld }),
  };
  const [outcome] = await queue.enqueueBatch(notice.targetId, MAIN_UPDATES, [item], notice.paseo);
  return outcome ?? "dropped";
}

/** What `enqueueUpdates` queues for one agent. */
export interface UpdatesNotice {
  targetId: string;
  /** In the order the message lists them; each keeps its own callbacks, and is gated again at the send by its `isHeld`. */
  items: ReadonlyArray<Pick<BatchItem, "key" | "line" | "callbacks" | "isHeld">>;
  paseo?: NoticePaseo;
  /** The plugin's shared queue by default. */
  queue?: ChannelQueue;
}

/**
 * Queues `items` for any agent on the updates batch in ONE call (delivery line
 * design §6.4, the release of a waiting Worker): at its idle moment they go as
 * one `BM-UPDATES <n>` message in this order, one item alone as its block. A
 * queue without the batch kind gets one composed notice, whose outcome every
 * item is told. One outcome per item. Never rejects.
 */
export async function enqueueUpdates(notice: UpdatesNotice): Promise<NoticeOutcome[]> {
  const queue = notice.queue ?? noticeQueue;
  const { items } = notice;
  if (items.length === 0) return [];
  if (queue.enqueueBatch !== undefined) return queue.enqueueBatch(notice.targetId, MAIN_UPDATES, items, notice.paseo);
  const callbacks: NoticeCallbacks = {
    onSent: (targetId, kind) => items.forEach((item) => item.callbacks?.onSent?.(targetId, kind)),
    onDropped: (targetId, kind, reason) => items.forEach((item) => item.callbacks?.onDropped?.(targetId, kind, reason)),
  };
  const outcome = await queue.enqueue(notice.targetId, `${UPDATES_NOTICE_MARKER}:${items[0]!.key}`, updatesNoticeOf(items.map((item) => item.line)), notice.paseo, callbacks);
  return items.map(() => outcome);
}
