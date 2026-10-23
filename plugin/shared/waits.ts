/**
 * Structured waits (delivery line design §6.2, §6.3; ADR-035 decision 5): what
 * a bound Worker's `blocked` report waits on, by id, as the request registry
 * keeps it (`waiting`), and the pure rules over it.
 *
 * - **Items**: a question (`q:` decision id), a peer link it asked, another
 *   request, or one of its own review batches; each `settled` once the thing
 *   it names is (design §6.3). A settled request or link keeps its fact
 *   ("req-X finished: …"), which the wake carries, so the Main stops relaying it.
 * - **`wakeOn`**: `all` (the default) is met when every item is settled, `any`
 *   at the first. A wait with no items (text only) holds nothing: it is met.
 * - **Promotion**: a `req-…` id in the free-text `waitingFor` becomes a
 *   `request` item (`requestIdsInText`); the server keeps only ids it knows.
 *
 * Pure; the server's settle hooks are `server/waits.ts`.
 */
import { z } from "zod";

export const WAIT_ITEM_KINDS = ["question", "link", "request", "batch"] as const;
export type WaitItemKind = (typeof WAIT_ITEM_KINDS)[number];
export const WAKE_ON = ["all", "any"] as const;
export type WakeOn = (typeof WAKE_ON)[number];

/** The longest fact a settled item keeps. */
export const MAX_WAIT_FACT = 300;

export const waitItemSchema = z.object({
  kind: z.enum(WAIT_ITEM_KINDS),
  id: z.string().min(1),
  settled: z.boolean(),
  /** When it settled; absent while it is not. */
  settledAt: z.string().optional(),
  /** What settled it, for the wake: a request's or a link's (design §6.3); absent otherwise. */
  fact: z.string().max(MAX_WAIT_FACT).optional(),
});

/** The registry's `waiting` (design §6.2): set by `blocked`, cleared by any other report or by the wake. */
export const waitingSchema = z.object({
  since: z.string(),
  /** The outbox record of the `blocked` report that set it. */
  reportRecordId: z.string(),
  wakeOn: z.enum(WAKE_ON),
  items: z.array(waitItemSchema),
});

export type WaitItem = z.infer<typeof waitItemSchema>;
export type Waiting = z.infer<typeof waitingSchema>;
/** An item by what it names. */
export type WaitRef = Pick<WaitItem, "kind" | "id">;

/** A request id as it may sit in prose. */
const REQUEST_ID_IN_TEXT = /\breq-\d{8}T\d{6}Z\b/g;

/** The `req-…` ids `text` names, each once, in order, without `own` (design §6.2 promotion). */
export function requestIdsInText(text: string | undefined, own: string | null = null): string[] {
  if (text === undefined) return [];
  return [...new Set(text.match(REQUEST_ID_IN_TEXT) ?? [])].filter((id) => id !== own);
}

/**
 * The items a blocked report names, each once: its questions, the requests,
 * its batches, then its links. Pure.
 */
export function waitRefsOf(input: { waitingOn?: readonly string[]; waitingOnRequests?: readonly string[]; waitingOnBatches?: readonly string[]; waitingOnPeers?: readonly string[] }): WaitRef[] {
  const out: WaitRef[] = [];
  const seen = new Set<string>();
  const add = (kind: WaitItemKind, ids: readonly string[] | undefined): void => {
    for (const id of ids ?? []) {
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, id });
    }
  };
  add("question", input.waitingOn);
  add("request", input.waitingOnRequests);
  add("batch", input.waitingOnBatches);
  add("link", input.waitingOnPeers);
  return out;
}

/** True when the wait no longer holds (design §6.2): every item settled (`all`), one (`any`), or no item at all. Pure. */
export function waitMet(waiting: Pick<Waiting, "wakeOn" | "items">): boolean {
  if (waiting.items.length === 0) return true;
  return waiting.wakeOn === "any" ? waiting.items.some((item) => item.settled) : waiting.items.every((item) => item.settled);
}

/** The items not settled yet. Pure. */
export function unsettledItemsOf(waiting: Pick<Waiting, "items"> | null | undefined): WaitItem[] {
  return (waiting?.items ?? []).filter((item) => !item.settled);
}

/** `text` on one line, at most `MAX_WAIT_FACT` characters. */
export function factText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_WAIT_FACT ? flat : `${flat.slice(0, MAX_WAIT_FACT - 1)}…`;
}

/**
 * `waiting` with the unsettled items `match` takes marked settled at `at`,
 * each with `fact` when given; null when none was. Pure.
 */
export function settleItemsOf(waiting: Waiting, match: (item: WaitItem) => boolean, settle: { at: string; fact?: string | ((item: WaitItem) => string | undefined) }): Waiting | null {
  let changed = false;
  const items = waiting.items.map((item) => {
    if (item.settled || !match(item)) return item;
    changed = true;
    const fact = typeof settle.fact === "function" ? settle.fact(item) : settle.fact;
    return { ...item, settled: true, settledAt: settle.at, ...(fact === undefined || fact.trim() === "" ? {} : { fact: factText(fact) }) };
  });
  return changed ? { ...waiting, items } : null;
}

/**
 * The fact of a request that ended (design §6.3): "req-X finished: <summary>"
 * or "req-X stopped: <why>". `as` names the chain's head when it is not the
 * awaited request itself ("req-A finished as req-B: …"). Pure.
 */
export function requestFactOf(awaited: string, phase: "finished" | "stopped", summary: string | null, as: string | null = null): string {
  const head = `${awaited} ${phase}${as === null || as === awaited ? "" : ` as ${as}`}`;
  return factText(summary === null || summary.trim() === "" ? head : `${head}: ${summary}`);
}

/**
 * What a finished or stopped report says in one line for the requests that
 * wait on it: its `forPeer`, else its build and tests, with the first files
 * it changed; a stopped one its blockers. Pure.
 */
export function reportSummaryOf(phase: "finished" | "stopped", input: { forPeer?: string; buildAndTests?: string; filesChanged?: readonly string[]; blockers?: string }): string | null {
  if (phase === "stopped") return input.blockers === undefined || input.blockers.trim() === "" ? null : input.blockers;
  if (input.forPeer !== undefined && input.forPeer.trim() !== "") return input.forPeer;
  const files = input.filesChanged ?? [];
  const named = files.length === 0 ? "" : `; files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ` (+${files.length - 5} more)` : ""}`;
  return input.buildAndTests === undefined ? (named === "" ? null : named.slice(2)) : `build and tests: ${input.buildAndTests}${named}`;
}
