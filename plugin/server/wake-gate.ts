/**
 * The wake gate (delivery line design §6.4, ADR-035 decision 5): a bound
 * Worker that reported `blocked` on items by id (`waiting`, `waits.ts`) gets
 * no delivery that settles none of them; it gets what was held as ONE message
 * when its wait is met.
 *
 * - **The gate** (`wakeGate(home, targetId, kind, refs)`) answers `deliver` or
 *   `hold`. It holds only for a bound Worker whose `waiting` has unsettled
 *   items, and only a delivery whose kind is not on the always-at-once list
 *   (`AT_ONCE_KINDS`). The items the delivery names (`refs`: a review's batch,
 *   an answer's questions) are settled first, should their own hook not have
 *   (design §6.3); a wait met then is `deliver` with a `release`. Called in
 *   outbox `deliverRecord`, the answers' delivery and the override delivery.
 *   Every `BM-COMMAND` is on the list, so `command-send.ts` never asks.
 * - **At the send too** (`holdsAtSend`): a delivery queued while its Worker
 *   ran a turn goes at that turn's end, after the turn's own `blocked`
 *   report. So each gated item carries the gate into the notice queue
 *   (`isHeld`), read just before it is sent; one it now holds leaves the
 *   queue unsent and goes to its source's held state (`onHeld`). A release
 *   whose wait a newer unmet one replaced is gated so, item by item; its
 *   facts block is then kept in memory for the next release. Only the
 *   request's newest Worker is gated: a Worker a handoff replaced is not.
 * - **Holding** is the caller's: an outbox record goes to the open state
 *   `held` (`outbox.ts`, gated again after a reload), an answer is recorded
 *   `delivery.outcome: "held"` (`decision-delivery.ts`, `override-delivery.ts`).
 *   Each gives the release what it holds (`heldRecordItems`, `useHeldSource`).
 * - **The release** (`releaseWait`): the wait is cleared (the wake), then the
 *   delivery that met it, the wait's facts ("req-X finished: …") and every
 *   held item go through the notice queue in ONE call on the Main's updates
 *   batch (`main-channel.ts` `enqueueUpdates`): one `BM-UPDATES <n>` message
 *   at the Worker's idle moment, the settling item first; one item alone goes
 *   as its own block. A delivery that settles nothing of the wait goes after
 *   the facts. Each item keeps its own callbacks, so every source records its
 *   outcome as before; an item handed to a release is in flight
 *   (`isReleasing`) until its callback, so nothing sends it twice.
 * - **Releases without a delivery**: a request that ended or an item the
 *   stall pass found dead settles a wait with no delivery to carry it;
 *   `releaseSettledWaits` releases the met ones (the report's `before` step;
 *   the stall pass). `releaseHeldOf` releases what is held for a Worker whose
 *   wait a new report cleared.
 *
 * An unbound Worker, or a wait without items, is never gated. Nothing here
 * throws: a failure is one log line, and a gate that cannot read delivers.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DELIVERY_NOTICE_MARKER, type DeliveryKind } from "../shared/notices";
import { unsettledItemsOf, waitMet, type WaitItem, type WaitRef, type Waiting } from "../shared/waits";
import { assertNoSymlink } from "./data-files";
import { enqueueUpdates, type ChannelQueue } from "./main-channel";
import { noticeQueue, type NoticeCallbacks, type NoticeOutcome, type NoticePaseo } from "./notice-queue";
import { heldRecordItems } from "./outbox";
import { REQUESTS_DIR_NAME, createRequestRegistry, isBoundRequest, type RegisteredRequest } from "./request-registry";
import { errorText } from "./rpc-kit";
import { locateRequest, settleWaitItem, type SettledWait } from "./waits";

const defaultLog = (message: string): void => console.warn(message);

/**
 * What always reaches a waiting Worker at once (design §6.4): the owner's chat
 * (Paseo delivers it; the plugin never sees it), `BM-STOP` and stop
 * propagation, every `BM-COMMAND`, `BM-REPLACED`, a `BM-SETTINGS` mode change,
 * `BM-ROLLOVER now`, maintenance (§6.6), and `bm_tell_worker` with `now: true`.
 */
export const AT_ONCE_KINDS = ["owner-chat", "stop", "command", "replaced", "settings-mode", "rollover-now", "maintenance", "tell-now"] as const;
export type AtOnceKind = (typeof AT_ONCE_KINDS)[number];
/** A delivery the gate may hold: an outbox record's kind, a request's answers, an override's corrected answer. */
export type GatedKind = DeliveryKind | "answers" | "override" | "rollover-soft" | "update";
export type WakeKind = AtOnceKind | GatedKind;

/** True for a kind on the always-at-once list. Pure. */
export function isAtOnce(kind: WakeKind): kind is AtOnceKind {
  return (AT_ONCE_KINDS as readonly string[]).includes(kind);
}

/** The wait a Worker is gated by: its request's registry entry and the Worker the release goes to. */
export interface GatedWait {
  workspaceId: string;
  requestId: string;
  workerId: string;
  waiting: Waiting;
}

/** The gate's answer (design §6.4). */
export type WakeVerdict =
  | {
      action: "deliver";
      /** The wait this delivery meets, to release with it (`releaseWait`); null when there is none to release. */
      release: GatedWait | null;
      /** Whether the delivery names an item of that wait: it goes first; else the wait's facts do. */
      settles: boolean;
    }
  | { action: "hold"; wait: GatedWait };

const DELIVER: WakeVerdict = { action: "deliver", release: null, settles: false };

/** The workspaces with a registry file. Never throws. */
function registryWorkspaces(home: string): string[] {
  try {
    assertNoSymlink(home, join(home, REQUESTS_DIR_NAME), "E_TRACE_STORE_UNWRITABLE");
    return readdirSync(join(home, REQUESTS_DIR_NAME))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

/**
 * The wait of `request` that gates `workerId`: a bound request whose newest
 * Worker it is, with a wait on items. A Worker a handoff replaced is no
 * longer the request's: its successor's wait never gates it.
 */
function gatedOf(workspaceId: string, request: RegisteredRequest, workerId: string): GatedWait | null {
  const waiting = request.waiting;
  if (!isBoundRequest(request) || waiting === undefined || waiting === null || waiting.items.length === 0 || request.workerIds.at(-1) !== workerId) return null;
  return { workspaceId, requestId: request.requestId, workerId, waiting };
}

/**
 * The wait gating `workerId` (design §6.4): its bound request — `hint`'s
 * when it is that Worker's, else found among the registries — with a wait on
 * items; null when it has none. Never throws.
 */
export function gatedWaitOf(home: string, workerId: string, hint: { workspaceId: string; requestId: string } | null = null): GatedWait | null {
  try {
    const registry = createRequestRegistry(home);
    if (hint !== null) {
      const located = locateRequest(home, hint.requestId, hint.workspaceId, registry);
      if (located !== null && located.request.workerIds.includes(workerId)) return gatedOf(located.workspaceId, located.request, workerId);
    }
    for (const workspaceId of registryWorkspaces(home)) {
      for (const request of registry.list(workspaceId)) {
        const gated = gatedOf(workspaceId, request, workerId);
        if (gated !== null) return gated;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const sameItem = (item: WaitItem, ref: WaitRef): boolean => item.kind === ref.kind && item.id === ref.id;

/**
 * The gate (design §6.4): `deliver` or `hold` for a delivery of `kind` to
 * `targetId` naming the wait items `refs`. Holds only a bound Worker's
 * delivery, off the always-at-once list, while its wait is not met once the
 * items `refs` names are settled. `hint` is where the delivery's request is,
 * when known. Never throws: a gate that cannot read delivers.
 */
export function wakeGate(
  home: string,
  targetId: string,
  kind: WakeKind,
  refs: readonly WaitRef[] = [],
  hint: { workspaceId: string; requestId: string } | null = null,
  deps: { now?: () => Date; log?: (message: string) => void } = {},
): WakeVerdict {
  if (isAtOnce(kind)) return DELIVER;
  const log = deps.log ?? defaultLog;
  try {
    const wait = gatedWaitOf(home, targetId, hint);
    if (wait === null) return DELIVER;
    let waiting = wait.waiting;
    // §6.3: what the delivery carries settles its item, should the item's own hook not have.
    const open = refs.filter((ref) => unsettledItemsOf(waiting).some((item) => sameItem(item, ref)));
    const at = (deps.now ?? (() => new Date()))().toISOString();
    for (const ref of open) {
      const changed = settleWaitItem(home, ref, { at }, { workspaceId: wait.workspaceId, requestId: wait.requestId }, log);
      waiting = changed[0]?.waiting ?? waiting;
    }
    const now = { ...wait, waiting };
    if (!waitMet(waiting)) return { action: "hold", wait: now };
    return { action: "deliver", release: now, settles: refs.some((ref) => waiting.items.some((item) => sameItem(item, ref))) };
  } catch (error) {
    log(`[paseo-bm] the wake gate could not read the wait of ${targetId}; delivered: ${errorText(error)}`);
    return DELIVER;
  }
}

/**
 * The gate at the send (design §6.4): a notice queue `isHeld` that asks
 * `wakeGate` again just before the item goes — true when it holds now. A
 * wait the item meets then is left for the Worker's next report or delivery
 * to release.
 */
export function holdsAtSend(
  home: string,
  targetId: string,
  kind: WakeKind,
  refs: readonly WaitRef[] = [],
  hint: { workspaceId: string; requestId: string } | null = null,
  deps: { now?: () => Date; log?: (message: string) => void } = {},
): () => boolean {
  return () => wakeGate(home, targetId, kind, refs, hint, deps).action === "hold";
}

// ---------------------------------------------------------------------------
// What a held tell answers.
// ---------------------------------------------------------------------------

/** An item as the Main reads it: `Q2` for a question, the id otherwise. */
function itemName(item: WaitItem): string {
  return item.kind === "question" ? item.id.slice(item.id.lastIndexOf(":") + 1) : item.id;
}

function listed(names: readonly string[], word: "and" | "or"): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${word} ${names.at(-1)!}`;
}

/**
 * What a held `bm_tell_worker` answers (design §6.4): "The Worker waits on
 * Q2 and Q3; it gets this with them." Pure.
 */
export function heldTellText(waiting: Pick<Waiting, "wakeOn" | "items">): string {
  const names = unsettledItemsOf(waiting).map(itemName);
  if (waiting.wakeOn === "any" && names.length > 1) return `The Worker waits on ${listed(names, "or")}; it gets this with the first of them.`;
  return `The Worker waits on ${listed(names, "and")}; it gets this with ${names.length === 1 ? "it" : "them"}.`;
}

// ---------------------------------------------------------------------------
// The release.
// ---------------------------------------------------------------------------

/** One block of a release: its key on the updates batch, its text, and what its sender is told. */
export interface ReleaseItem {
  key: string;
  block: string;
  /** Its sender's callbacks; `onHeld` puts it back in its held state when the gate holds it at the send. */
  callbacks?: NoticeCallbacks;
  /** The wait items it settles (a review's batch, an answer's questions), for the gate at the send. */
  refs?: readonly WaitRef[];
}

/** A held item a source gives the release. */
export interface HeldItem extends ReleaseItem {
  /** When it was held: held items go oldest first. */
  at: string;
  /** Called just before it is queued: the source leaves `held` (to `pending`, `queued`). A throw is one log line. */
  release?: () => void;
}

/** What is held for `wait`'s Worker in one store, its outcomes recorded at `now`; never throws (a failure is none). */
export type HeldSource = (home: string, wait: Omit<GatedWait, "waiting">, now: () => Date) => HeldItem[];

const heldSources = new Map<string, HeldSource>();

/**
 * Registers where held items of one kind are kept (`decision-delivery.ts`,
 * `override-delivery.ts`, at load). The outbox's are read directly
 * (`heldRecordItems`): it imports this module through the request registry.
 */
export function useHeldSource(name: string, source: HeldSource): void {
  heldSources.set(name, source);
}

/**
 * Worker → the facts blocks of released waits the gate held at the send, by
 * key: they go with that Worker's next release. In memory: a reload loses
 * them (each fact is in the request's report or its link already).
 */
const heldFacts = new Map<string, Map<string, { block: string; at: string }>>();

function keepFacts(workerId: string, key: string, block: string, at: string): void {
  const kept = heldFacts.get(workerId) ?? new Map<string, { block: string; at: string }>();
  kept.set(key, { block, at });
  heldFacts.set(workerId, kept);
}

function forgetFacts(workerId: string, key: string): void {
  const kept = heldFacts.get(workerId);
  kept?.delete(key);
  if (kept?.size === 0) heldFacts.delete(workerId);
}

/** The facts blocks held for `target`'s Worker (a held source). */
function heldFactsOf(_home: string, target: Omit<GatedWait, "waiting">): HeldItem[] {
  return [...(heldFacts.get(target.workerId) ?? [])].map(([key, { block, at }]) => ({
    key,
    block,
    at,
    release: () => forgetFacts(target.workerId, key),
    callbacks: { onHeld: () => keepFacts(target.workerId, key, block, at) },
  }));
}

useHeldSource("facts", heldFactsOf);

/** Target → the keys of the items handed to a release and not told of yet. In memory: a reload re-gates them. */
const releasing = new Map<string, Set<string>>();

/** True while the item `key` for `targetId` is in a release's message not yet sent: nothing else sends it. */
export function isReleasing(targetId: string, key: string): boolean {
  return releasing.get(targetId)?.has(key) === true;
}

function markReleasing(targetId: string, key: string, on: boolean): void {
  const keys = releasing.get(targetId) ?? new Set<string>();
  if (on) keys.add(key);
  else keys.delete(key);
  if (keys.size === 0) releasing.delete(targetId);
  else releasing.set(targetId, keys);
}

/** The block of a release that carries the wait's facts (design §6.3): the newest settled first. */
export const WAIT_FACTS_LINE = `${DELIVERY_NOTICE_MARKER} wait`;

/**
 * The facts of a met wait as one block: `BM-DELIVERY wait`, `Continue
 * <requestId>: what you waited on is settled.`, then each settled item's fact,
 * the newest first. With `bare` (nothing else is released), items without a
 * fact are named too. Null when there is nothing to say. Pure.
 */
export function waitFactsBlockOf(requestId: string, waiting: Pick<Waiting, "items">, bare: boolean): string | null {
  const settled = waiting.items.filter((item) => item.settled).sort((a, b) => (b.settledAt ?? "").localeCompare(a.settledAt ?? ""));
  const facts = settled.flatMap((item) => (item.fact === undefined ? [] : [item.fact]));
  const lines = facts.length > 0 ? facts : bare && settled.length > 0 ? [`Settled: ${settled.map(itemName).join(", ")}.`] : [];
  return lines.length === 0 ? null : [WAIT_FACTS_LINE, `Continue ${requestId}: what you waited on is settled.`, ...lines].join("\n");
}

export interface ReleaseDeps {
  home: string;
  /** The plugin's shared queue by default. */
  queue?: ChannelQueue;
  paseo?: NoticePaseo;
  log?: (message: string) => void;
  /** The clock held items record their outcomes by; the real one by default. */
  now?: () => Date;
}

/** Every item held for `target`'s Worker, oldest first, without the keys in `skip`. */
function heldItemsOf(home: string, target: Omit<GatedWait, "waiting">, skip: ReadonlySet<string>, log: (message: string) => void, now: () => Date): HeldItem[] {
  const out: HeldItem[] = [];
  for (const [name, source] of [["outbox", heldRecordItems] as const, ...heldSources]) {
    try {
      out.push(...source(home, target, now).filter((item) => !skip.has(item.key) && !isReleasing(target.workerId, item.key)));
    } catch (error) {
      log(`[paseo-bm] could not read what ${name} holds for ${target.workerId}: ${errorText(error)}`);
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Releases `target`'s Worker (design §6.4): clears its wait when `waiting` is
 * still the one stored (the wake), then queues `first` — the delivery that met
 * it, first when it `settles` an item, else after the facts — the wait's
 * facts and every held item as ONE message. Returns `first`'s outcome (null
 * without one, or when nothing went). Never rejects.
 */
export async function releaseWait(
  target: Omit<GatedWait, "waiting"> & { waiting: Waiting | null },
  first: (ReleaseItem & { settles: boolean }) | null,
  deps: ReleaseDeps,
): Promise<NoticeOutcome | null> {
  const log = deps.log ?? defaultLog;
  const { home } = deps;
  try {
    if (target.waiting !== null) {
      try {
        const registry = createRequestRegistry(home, { log });
        const stored = registry.get(target.workspaceId, target.requestId)?.waiting ?? null;
        if (stored !== null && stored.reportRecordId === target.waiting.reportRecordId) registry.setWaiting(target.workspaceId, target.requestId, null);
      } catch (error) {
        log(`[paseo-bm] could not clear the wait of request ${target.requestId}: ${errorText(error)}`);
      }
    }
    const now = deps.now ?? (() => new Date());
    const held = heldItemsOf(home, target, new Set(first === null ? [] : [first.key]), log, now);
    const facts = target.waiting === null ? null : waitFactsBlockOf(target.requestId, target.waiting, first === null && held.length === 0);
    // Held at the send (a newer wait), the facts wait in memory for the next release, under a key of their own.
    const factsKey = `wait:${target.requestId}`;
    const factsAt = now().toISOString();
    const factsItem: ReleaseItem | null =
      facts === null ? null : { key: factsKey, block: facts, callbacks: { onHeld: () => keepFacts(target.workerId, `${factsKey}@${factsAt}`, facts, factsAt) } };
    const head = first === null ? [factsItem] : first.settles ? [first, factsItem] : [factsItem, first];
    const items = [...head.filter((item): item is ReleaseItem => item !== null), ...held];
    if (items.length === 0) return null;
    for (const item of held) {
      try {
        item.release?.();
      } catch (error) {
        log(`[paseo-bm] could not release the held ${item.key} for ${target.workerId}: ${errorText(error)}`);
      }
    }
    const told = new Set<string>();
    const done = (key: string): void => {
      told.add(key);
      markReleasing(target.workerId, key, false);
    };
    const hint = { workspaceId: target.workspaceId, requestId: target.requestId };
    const queued = items.map((item) => {
      markReleasing(target.workerId, item.key, true);
      const callbacks: NoticeCallbacks = {
        onSent: (targetId, kind) => {
          done(item.key);
          item.callbacks?.onSent?.(targetId, kind);
        },
        onDropped: (targetId, kind, reason) => {
          done(item.key);
          item.callbacks?.onDropped?.(targetId, kind, reason);
        },
        // The gate at the send held it (a newer wait): back to its source's held state, for that wait's release.
        onHeld: (targetId, kind) => {
          done(item.key);
          item.callbacks?.onHeld?.(targetId, kind);
        },
      };
      return { key: item.key, line: item.block, callbacks, isHeld: holdsAtSend(home, target.workerId, "update", item.refs ?? [], hint, { now, log }) };
    });
    const outcomes = await enqueueUpdates({ targetId: target.workerId, items: queued, queue: deps.queue ?? noticeQueue, ...(deps.paseo === undefined ? {} : { paseo: deps.paseo }) });
    // An item the queue refused outright, or replaced, is told of nothing by it.
    queued.forEach((item, index) => {
      const outcome = outcomes[index];
      if (told.has(item.key) || (outcome !== "dropped" && outcome !== "replaced")) return;
      done(item.key);
      if (outcome === "dropped") item.callbacks.onDropped?.(target.workerId, item.key, "the notice queue refused it");
    });
    return first === null ? null : (outcomes[items.indexOf(first)] ?? "dropped");
  } catch (error) {
    log(`[paseo-bm] could not release the wait of request ${target.requestId}: ${errorText(error)}`);
    return first === null ? null : "dropped";
  }
}

/** The Worker a wait's release goes to: its request's newest Worker. */
function workerOfRequest(home: string, workspaceId: string, requestId: string): string | null {
  return createRequestRegistry(home).get(workspaceId, requestId)?.workerIds.at(-1) ?? null;
}

/**
 * Releases each met wait of `settled` (design §6.4) that no delivery carries:
 * an awaited request that ended (the report's `before` step), an item the
 * stall pass found dead (`settleDeadWaitItems`). Each goes to its request's
 * newest Worker, its facts first. Never rejects.
 */
export async function releaseSettledWaits(home: string, settled: readonly SettledWait[], deps: Omit<ReleaseDeps, "home"> = {}): Promise<void> {
  for (const wait of settled) {
    if (!wait.met) continue;
    try {
      const workerId = workerOfRequest(home, wait.workspaceId, wait.requestId);
      if (workerId === null) continue;
      await releaseWait({ workspaceId: wait.workspaceId, requestId: wait.requestId, workerId, waiting: wait.waiting }, null, { ...deps, home });
    } catch (error) {
      (deps.log ?? defaultLog)(`[paseo-bm] could not release the wait of request ${wait.requestId}: ${errorText(error)}`);
    }
  }
}

/**
 * Re-gates what is held for `target`'s Worker after its report changed its
 * wait (design §6.2: any other report clears it): with no wait left,
 * everything held goes as one message; a wait met already is released with
 * its facts; one not met keeps what it holds. Never rejects.
 */
export async function releaseHeldOf(target: Omit<GatedWait, "waiting">, deps: ReleaseDeps): Promise<void> {
  const log = deps.log ?? defaultLog;
  try {
    const wait = gatedWaitOf(deps.home, target.workerId, { workspaceId: target.workspaceId, requestId: target.requestId });
    if (wait !== null) {
      // A wait met already (an awaited request that had finished): the Worker wakes with its facts.
      if (waitMet(wait.waiting)) await releaseWait(wait, null, deps);
      return;
    }
    if (heldItemsOf(deps.home, target, new Set(), log, deps.now ?? (() => new Date())).length === 0) return;
    await releaseWait({ ...target, waiting: null }, null, deps);
  } catch (error) {
    log(`[paseo-bm] could not release what is held for ${target.workerId}: ${errorText(error)}`);
  }
}
