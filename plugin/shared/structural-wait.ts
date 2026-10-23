/**
 * Waits by structure (delivery line design §6.5; ADR-035 decision 5): whether
 * a request's structured wait (`waiting`, design §6.2) still holds on live
 * things, so the stall watcher raises no `idle-unfinished` and no event and
 * the governor counts it out of `stalled`, and which of its items are dead.
 *
 * An unsettled item is:
 *
 * | Item | Live | Dead (settles as a fact) |
 * |---|---|---|
 * | question | open | answered, decided, expired or withdrawn (no fact: its hook missed it) |
 * | batch | a Reviewer of it running, or its newest call younger than the pending window | a verdict since that call (no fact), or no running Reviewer past the window |
 * | request | active, with a live Worker on the head of its chain | finished, stopped, or no live Worker left |
 * | link | under its ceiling | answered, closed, or past its ceiling |
 *
 * Anything the facts do not know is **unknown**: neither live nor dead. The
 * wait **holds** while it is not met and every unsettled item is live; one
 * unknown or dead item and it does not. Pure: the facts are the caller's
 * (the stall pass reads the stores, the governor its snapshot).
 */
import { factText, requestFactOf, unsettledItemsOf, waitMet, type WaitItem, type Waiting } from "./waits";

/** What a question is now; null when the decisions do not know it. */
export type WaitQuestionFact = "open" | "closed";

/** The request an item awaits, read at the head of its chain (delivery line design §2.4). */
export interface WaitRequestFact {
  /** The head of its chain: itself when it was never continued. */
  headId: string;
  state: "active" | "finished" | "stopped";
  /** How many Workers the head has had, and whether one of them is live (not archived, closed or replaced). */
  workers: number;
  liveWorker: boolean;
}

/** A link an item awaits. */
export interface WaitLinkFact {
  state: "open" | "taken" | "answered" | "closed";
  closedBy: "asker" | "answerer" | null;
  /** Why it no longer counts as a wait (`peerCeilingOf`), or null while it does. */
  ceiling: string | null;
}

/** One of the waiting request's own review batches, as its registry entry keeps it. */
export interface WaitBatch {
  batchId: string;
  reviewerIds: readonly string[];
  calls: ReadonlyArray<{ at: string; reviewerId: string }>;
  /** Its results (delivery line design §5.2); absent on a batch an older build opened. */
  results?: ReadonlyArray<{ at: string }>;
}

/** What the caller knows now. Each lookup returns null for what it does not know. */
export interface StructuralWaitFacts {
  /** ISO time of the look. */
  now: string;
  /** How long a review call may go without a Reviewer before it counts as dead (`PENDING_TTL_MS`). */
  pendingMs: number;
  question(id: string): WaitQuestionFact | null;
  request(id: string): WaitRequestFact | null;
  link(id: string): WaitLinkFact | null;
  /** True for an agent whose turn runs now. */
  isRunning(agentId: string): boolean;
}

/** One unsettled item, judged. */
export type JudgedWaitItem = { item: WaitItem; state: "live" } | { item: WaitItem; state: "unknown" } | { item: WaitItem; state: "dead"; fact?: string };

export interface StructuralWait {
  /** The unsettled items, each judged, in the wait's order. */
  items: JudgedWaitItem[];
  /** True while the wait is not met and every unsettled item is live (design §6.5). */
  holds: boolean;
  /** The dead items, each with the fact it settles with (none for a question or a batch that only missed its hook). */
  dead: Array<{ item: WaitItem; fact?: string }>;
}

/** The fact of a link that closed (design §6.3). */
export function linkClosedFactOf(linkId: string, by: "asker" | "answerer" | null): string {
  return `${linkId} closed by the ${by === "answerer" ? "answering" : "asking"} side`;
}

/** The fact of a link past its ceiling: the ceiling's own words, led by the link's id. */
export function linkCeilingFactOf(linkId: string, why: string): string {
  return factText(why.startsWith(linkId) ? why : `${linkId}: ${why}`);
}

/** The fact of an awaited request whose chain has no live Worker left. */
export function noLiveWorkerFactOf(requestId: string, headId: string): string {
  return `${requestId} has no live Worker left${headId === requestId ? "" : ` (as ${headId})`}`;
}

/** The fact of a batch whose Reviewer is gone with no verdict. */
export function noVerdictFactOf(batchId: string): string {
  return `${batchId} got no verdict: no Reviewer of it is running`;
}

function judgeBatch(item: WaitItem, batches: readonly WaitBatch[], facts: StructuralWaitFacts): JudgedWaitItem {
  const batch = batches.find((entry) => entry.batchId === item.id);
  if (batch === undefined || batch.calls.length === 0) return { item, state: "unknown" };
  const newest = Math.max(...batch.calls.map((call) => Date.parse(call.at) || 0));
  if ((batch.results ?? []).some((result) => (Date.parse(result.at) || 0) >= newest)) return { item, state: "dead" };
  const reviewers = new Set([...batch.reviewerIds, ...batch.calls.map((call) => call.reviewerId)].filter((id) => id !== ""));
  if ([...reviewers].some((id) => facts.isRunning(id))) return { item, state: "live" };
  if ((Date.parse(facts.now) || 0) - newest < facts.pendingMs) return { item, state: "live" };
  return { item, state: "dead", fact: noVerdictFactOf(item.id) };
}

function judge(item: WaitItem, batches: readonly WaitBatch[], facts: StructuralWaitFacts): JudgedWaitItem {
  switch (item.kind) {
    case "question": {
      const question = facts.question(item.id);
      return question === null ? { item, state: "unknown" } : question === "open" ? { item, state: "live" } : { item, state: "dead" };
    }
    case "batch":
      return judgeBatch(item, batches, facts);
    case "request": {
      const request = facts.request(item.id);
      if (request === null) return { item, state: "unknown" };
      if (request.state !== "active") return { item, state: "dead", fact: requestFactOf(item.id, request.state, null, request.headId) };
      if (request.liveWorker) return { item, state: "live" };
      // A request no Worker took yet: nothing says it is dead.
      return request.workers === 0 ? { item, state: "unknown" } : { item, state: "dead", fact: noLiveWorkerFactOf(item.id, request.headId) };
    }
    case "link": {
      const link = facts.link(item.id);
      if (link === null) return { item, state: "unknown" };
      if (link.state === "closed") return { item, state: "dead", fact: linkClosedFactOf(item.id, link.closedBy) };
      if (link.state === "answered") return { item, state: "dead", fact: `${item.id} answered` };
      return link.ceiling === null ? { item, state: "live" } : { item, state: "dead", fact: linkCeilingFactOf(item.id, link.ceiling) };
    }
  }
}

/**
 * The structured wait of `request` judged against `facts` (design §6.5): each
 * unsettled item live, dead or unknown, whether the wait holds, and the dead
 * items with their facts. A request with no wait, or a wait with no items,
 * holds nothing. Pure.
 */
export function structuralWaitOf(
  request: { waiting?: Waiting | null; reviews?: { batches: readonly WaitBatch[] } },
  facts: StructuralWaitFacts,
): StructuralWait {
  const waiting = request.waiting ?? null;
  const open = unsettledItemsOf(waiting);
  if (waiting === null || open.length === 0) return { items: [], holds: false, dead: [] };
  const batches = request.reviews?.batches ?? [];
  const items = open.map((item) => judge(item, batches, facts));
  const dead = items.flatMap((entry) => (entry.state === "dead" ? [entry.fact === undefined ? { item: entry.item } : { item: entry.item, fact: entry.fact }] : []));
  return { items, holds: !waitMet(waiting) && items.every((entry) => entry.state === "live"), dead };
}
