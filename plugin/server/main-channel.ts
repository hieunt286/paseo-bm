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
 * predecessor go one message each, as before. A queue without the batch kind
 * (a test's) sends single notices. Never rejects.
 */
import { UPDATES_NOTICE_MARKER, updatesNoticeOf } from "../shared/notices";
import { createMissionStore } from "./mission-store";
import { noticeQueue, type NoticeBatch, type NoticeCallbacks, type NoticeOutcome, type NoticePaseo, type NoticeQueue } from "./notice-queue";

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
  /** The plugin's shared queue by default. */
  queue?: ChannelQueue;
}

/** Queues one notice: on the Main's channel when the target is an open mission's Main, else as a single notice. Never rejects. */
export async function enqueueNotice(notice: AgentNotice): Promise<NoticeOutcome> {
  const queue = notice.queue ?? noticeQueue;
  if (queue.enqueueBatch === undefined || !isMissionMain(notice.home, notice.targetId)) {
    const args = [notice.targetId, notice.kind, notice.text, notice.paseo] as const;
    return notice.callbacks === undefined ? queue.enqueue(...args) : queue.enqueue(...args, notice.callbacks);
  }
  const item = {
    key: notice.kind,
    line: notice.text,
    ...(notice.callbacks === undefined ? {} : { callbacks: notice.callbacks }),
    ...(notice.first === true ? { first: true } : {}),
  };
  const [outcome] = await queue.enqueueBatch(notice.targetId, MAIN_UPDATES, [item], notice.paseo);
  return outcome ?? "dropped";
}
