/**
 * Tells a delivery that failed (ADR-042 decision 5). A request whose answer or
 * message reached nobody stops without a sound unless someone is told: this
 * raises the `delivery-dropped` Inbox alert and, for an open request, sends its
 * Main one `BM-DELIVERY-FAILED` notice for each alert that opens, however many
 * drops the alert then covers (ADR-045 decision 14). The Main is left out when
 * it is the target that could not be reached; the alert and the governor's
 * `dropped` figure still stand. Never rejects.
 */
import { createAlertStore } from "./alert-store";
import { enqueueNotice, type ChannelQueue } from "./main-channel";
import type { NoticePaseo } from "./notice-queue";
import { createRequestRegistry } from "./request-registry";
import { errorText } from "./rpc-kit";

export const DELIVERY_FAILED_MARKER = "BM-DELIVERY-FAILED";

export interface FailedDelivery {
  workspaceId: string;
  requestId: string;
  /** What did not arrive, in a few words: `the answers q:…:Q1`. */
  what: string;
  /** The agent it was for. */
  to: string;
  reason: string;
  /** The alert's line, when the caller has a fuller one than `<what> did not reach <to>: <reason>.` */
  detail?: string;
}

export interface FailedDeliveryDeps {
  home: string;
  queue?: ChannelQueue;
  paseo?: NoticePaseo;
  now?: () => Date;
  log?: (message: string) => void;
}

/** The notice to the Main. Pure. */
export function failedDeliveryNoticeOf(failure: FailedDelivery): string {
  return [
    DELIVERY_FAILED_MARKER,
    `requestId: ${failure.requestId}`,
    `what: ${failure.what}`,
    `to: ${failure.to}`,
    `reason: ${failure.reason}`,
    "It did not arrive, so the request will not move by itself. If its work must go on, pass it on with bm_tell_worker; tell the owner in one line.",
  ].join("\n");
}

/** The Main of an open request; null when the request is unknown or finished, or has no Main. */
function mainOfOpenRequest(home: string, failure: FailedDelivery): string | null {
  const request = createRequestRegistry(home).get(failure.workspaceId, failure.requestId);
  return request === null || request === undefined || request.finishedAt !== null ? null : request.managerId;
}

/** The Main's notice alone. Never rejects. */
async function tellMainOfFailedDelivery(failure: FailedDelivery, deps: FailedDeliveryDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  try {
    const mainId = mainOfOpenRequest(deps.home, failure);
    if (mainId === null || mainId === failure.to) return;
    await enqueueNotice({
      home: deps.home,
      targetId: mainId,
      kind: `${DELIVERY_FAILED_MARKER}:${failure.requestId}`,
      text: failedDeliveryNoticeOf(failure),
      ...(deps.queue === undefined ? {} : { queue: deps.queue }),
      ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }),
    });
  } catch (error) {
    log(`[paseo-bm] could not tell the Main of ${failure.requestId} that ${failure.what} did not arrive: ${errorText(error)}`);
  }
}

/**
 * The one path for a delivery that failed: the alert, and the Main's notice
 * when this call opened it (`raised`; a drop on an alert already open, or one
 * that only updates its detail, sends none). The alert is raised before the
 * first await. Never rejects.
 */
export async function tellFailedDelivery(failure: FailedDelivery, deps: FailedDeliveryDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  let raised = false;
  try {
    raised = createAlertStore(deps.home, deps.now === undefined ? {} : { now: deps.now }).raise({
      workspaceId: failure.workspaceId,
      kind: "delivery-dropped",
      subject: failure.requestId,
      detail: failure.detail ?? `${failure.what} did not reach ${failure.to}: ${failure.reason}.`,
    }).raised;
  } catch (error) {
    log(`[paseo-bm] could not raise the delivery-dropped alert of ${failure.requestId}: ${errorText(error)}`);
  }
  if (raised) await tellMainOfFailedDelivery(failure, deps);
}
