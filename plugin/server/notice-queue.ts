/**
 * The notice queue: the one way the plugin delivers a notice to an agent that
 * may be running (delta 20260921 §4.2.4, §4.3.5, §4.4.6, F13; REQ-063 d,
 * REQ-064 d, REQ-065 c).
 *
 * `PaseoAgentHandle.send()` on a running agent REPLACES its turn (delta
 * 20260918g K10; `stop-propagation.ts` relies on exactly that to interrupt a
 * Reviewer). `BM-TOOLS`, `BM-SETTINGS`, `BM-FALLBACK`, `BM-DELIVERY` and
 * `BM-COMMAND` go to Managers and Workers that are often mid-turn, so none of
 * them calls `send()` itself.
 *
 * API — what consumer modules import:
 *
 * - `enqueue(targetId, kind, text, paseo?)` → `Promise<NoticeOutcome>`, never
 *   rejects. `refresh()`es the target (as `review-budget.ts` does before its
 *   send); when it is not `running` or `initializing` the notice is sent now
 *   (`"sent"`), otherwise `{ kind, text }` is held in memory (`"queued"`) and
 *   sent at a later `agent.turn_ended` of that target. `kind` is the notice's
 *   marker (`"BM-TOOLS"`, `"BM-SETTINGS"`, `"BM-FALLBACK"`). `paseo` is the
 *   handle of the caller's own hook or RPC context (`context.paseo`, the
 *   `{ paseo }` of a handler); without it the queue uses the last handle a
 *   hook gave it, and with none yet the notice waits for the target's turn end,
 *   whose hook context brings one. `"dropped"`: bad input, the target is
 *   archived, closed or gone, or its send failed. `"replaced"`: a newer notice
 *   of the same kind for the same target took its place before it went out.
 *   `callbacks` (design §16.7, the outbox): `onSent(targetId, kind)` once the
 *   notice went out — at once or at a later turn end — as a batch has its
 *   own; `onDropped(targetId, kind, reason)` when a queued notice is dropped
 *   later (target gone, send failed). Neither is called for a notice replaced
 *   or forgotten by `clear()` (a reload), and a throw costs one log line.
 *   `options.first` (delivery line design §6.6: maintenance, `BM-STATE`)
 *   sends it before every other notice queued for the target, as a batch's
 *   `first` group goes; among `first` notices the oldest goes first.
 *   `options.isHeld` (delivery line design §6.4, the wake gate at the send):
 *   read at the idle moment, synchronously, just before the send; true takes
 *   the notice off the queue unsent and tells `callbacks.onHeld`, so its
 *   sender keeps it in its own held state. A throw counts as false (it
 *   goes). A notice held during the `enqueue` call answers `"queued"`.
 * - `retarget(oldId, newId, paseo?)` (missions design §3.4): when a Main is
 *   replaced, what is queued for the old one is queued for its successor.
 * - `noticeQueue`: the one shared queue `enqueue` uses. `createNoticeQueue()`
 *   makes a private one (tests).
 * - `enqueueBatch(targetId, batch, items, paseo?)` → one `NoticeOutcome` per
 *   item, never rejects: the **batch kind** (autonomy design §A.8). Each item
 *   is one line (an event for the Orchestrator); every batched item of the same
 *   `batch.name` and the same `group` still pending for the target when it is
 *   idle goes out as ONE message, `batch.compose(lines, group)`, oldest first
 *   (missions design §20: one mission per wake). Another group of the batch
 *   waits for the turn end that message starts. A group holding a `first` item
 *   goes before every other notice of the target. An item whose `isCurrent()`
 *   says false at that moment — its subject settled meanwhile — is dropped
 *   (`"dropped"`); when none is left, nothing is sent. An item's kind is
 *   `<batch.name>:<item.key>`, so a newer item of the same key replaces a
 *   queued one. All items of one call are queued before the one delivery, so a
 *   burst from one source is one message too. Once the message went out,
 *   `batch.onSent(targetId, keys)` is told which items it carried, and the
 *   target's next turn end calls `batch.onTurnEnded(targetId, paseo)` once,
 *   first, and waits for it. An item may carry its own `callbacks`, told of
 *   that item as a single notice's are (mission runtime design §6.2: the
 *   Main's channel settles each outbox record it carries): `onSent` once its
 *   message went out, `onDropped` when it is dropped (target gone, send
 *   failed, or its subject settled before delivery). An item's `isHeld` is
 *   read as a single notice's is: a held item leaves the message, and its
 *   `onHeld` is told.
 * - `options.steer` (delivery line design §19.5, ADR-038 decision 4): the
 *   owner's words (`isOwnerWords`, `owner-words.ts`). When the target is in a
 *   running turn and every guard of `steerRefusalOf` holds — a Worker whose
 *   provider's base is Claude or Codex, `status: "running"` with an
 *   `activeTurn.turnId`, a text that does not start with `/` — it is sent at
 *   once with `send(text, { messageId, activeTurnBehavior: "steer" })`, ahead
 *   of what is queued for the target. The turn id is read before and after
 *   the send: the same id answers `"steered"`; another id means Paseo
 *   replaced the turn (it does when the provider refuses the steer) and
 *   answers `"turn-replaced"`, with one log line. Either way
 *   `callbacks.onSteered` is told, then `onSent`. A guard that does not hold
 *   — or an idle, gone or unreadable target — leaves the notice to the rules
 *   above: sent now when idle, else queued for the turn end. Never a steer
 *   without `options.steer`, and never to a target not read `running` just
 *   before.
 * - `registerNoticeQueue(host)` → `{ host, remove }`: the queue does not add a
 *   lifecycle hook of its own. It rides on an existing `agent.turn_ended` hook:
 *   pass the returned `host` to the module that registers one (index.server.ts
 *   uses the BM-FORMAT check), and every turn end that hook sees then also
 *   delivers the queue, AFTER that module's handler. So a BM-FORMAT notice sent
 *   at the same turn end is already running when the queue `refresh()`es, and
 *   the queue waits instead of replacing it. `remove()` detaches the queue and
 *   forgets what it holds.
 *
 * Rules this module must never lose:
 * - **Never into a running turn**, but for a steer (`options.steer`, above).
 *   Nothing else is sent unless `refresh()`, read just before, says the
 *   target is neither `running` nor `initializing`.
 * - **One notice per idle moment.** The notice sent starts a turn on the
 *   target, and a second `send()` would replace that turn; so each chance
 *   sends the oldest queued notice only — a batch group counts as one notice,
 *   at the place of its oldest item, and a `first` group or notice goes
 *   ahead of the rest — and that turn's end carries the next
 *   (the lesson `review-budget.ts` records). Queued notices therefore go out
 *   in order, one turn apart. A send that fails costs one log line and drops
 *   that notice; the next queued one is tried at once, after a fresh
 *   `refresh()`.
 * - **The newest notice of a kind wins.** A new notice replaces a queued one of
 *   the SAME kind for the SAME target and moves to the back of that target's
 *   queue; other kinds and other targets are kept.
 * - **Lifecycle belongs to the user (ADR-005).** `send()` un-archives an
 *   archived agent and starts a turn on it, so an archived, closed or unknown
 *   target is never sent to: its queued notices are dropped with one log line.
 * - **Keyed by agent id and kind, never by turn id.** Paseo reuses turn ids
 *   inside one agent (AGENTS.md).
 * - **In memory only.** A plugin reload loses the queue; each consumer
 *   documents its own fallback.
 * - **Never throws.** Every failure costs one `console.warn` line that starts
 *   with `[paseo-bm]`.
 */
import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { roleOfProvider } from "./agent-role";
import { aliasBases } from "./alias-bases";
import { providerId } from "./provider-id";
import { errorText } from "./rpc-kit";

/** A notice's marker, for example `"BM-TOOLS"`; one queued notice per kind and target. */
export type NoticeKind = string;

/**
 * `steered` and `turn-replaced` answer only a notice queued with
 * `options.steer` (delivery line design §19.5): it went into the running
 * turn, or Paseo replaced that turn with it.
 */
export type NoticeOutcome = "sent" | "queued" | "replaced" | "dropped" | "steered" | "turn-replaced";

/** The snapshot fields this module reads; `PaseoAgent` is structurally assignable. */
export interface NoticeAgentSnapshot {
  status?: string | null;
  archivedAt?: string | null;
  /** The provider id (`bm-worker`, `bm-worker/<model>`); read only for a steer. */
  provider?: string | null;
  /** The foreground turn while one runs (Paseo's `activeTurn`); read only for a steer. */
  activeTurn?: { turnId?: string | null } | null;
}

/** The SDK slice this module uses; `PaseoApi` from a hook or handler context is structurally assignable. */
export interface NoticePaseo {
  agents: {
    ref(agentId: string): {
      refresh(): Promise<{ agent?: NoticeAgentSnapshot | null } | null>;
      send(text: string, options?: { messageId?: string }): Promise<void>;
    };
  };
}

/** The base providers whose running turn takes a steer (delivery line design §19.9: the spike on Paseo 0.12). */
export const STEER_PROVIDERS: readonly string[] = ["claude", "codex"];

/** The foreground turn id of a snapshot, or null when it shows none. Pure. */
export function turnIdOf(agent: NoticeAgentSnapshot | null | undefined): string | null {
  const id = agent?.activeTurn?.turnId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * Why the owner's words would not be steered into `agent`'s turn (delivery
 * line design §19.5 guards), or null when every guard holds: a Worker, its
 * provider's `base` Claude or Codex, `running` with a foreground turn id, and
 * a text that does not start with `/`. Pure.
 */
export function steerRefusalOf(agent: NoticeAgentSnapshot, text: string, base: string | null): string | null {
  if (roleOfProvider(agent.provider) !== "worker") return "the target is not a Worker";
  if (base === null || !STEER_PROVIDERS.includes(base)) return `its provider's base (${base ?? "not known"}) is not Claude or Codex`;
  if (agent.status !== "running") return "it is not in a running turn";
  if (turnIdOf(agent) === null) return "Paseo shows no foreground turn id for it";
  if (text.trimStart().startsWith("/")) return "the text starts with /";
  return null;
}

/** What a steer came to (`NoticeCallbacks.onSteered`). */
export interface SteerResult {
  /** When the steer was sent (ISO). */
  at: string;
  /** The `messageId` it was sent with. */
  messageId: string;
  /** Paseo replaced the running turn: the turn id after the send differs from the one before. */
  replaced: boolean;
  turnBefore: string;
  /** Null when it could not be read after the send (counted as the same turn). */
  turnAfter: string | null;
}

/** The send options of a steer; the SDK's `PaseoAgentSendOptions` (0.8.0) does not declare `activeTurnBehavior`, Paseo 0.12's daemon reads it. */
interface SteerSendOptions {
  messageId: string;
  activeTurnBehavior: "steer";
}

/** A queued notice, as `pending()` shows it. */
export interface QueuedNotice {
  kind: NoticeKind;
  text: string;
}

/** How the items of one batch become one message (autonomy design §A.8). */
export interface NoticeBatch {
  /** The batch's name, for example `"BM-EVENTS"`; items of one name and group are merged. */
  name: string;
  /** The one message for these lines, oldest first, of one `group` (`""` for items without one); never called with none. */
  compose(lines: readonly string[], group: string): string;
  /**
   * Called once the message went out, with the target and the keys of the
   * items it carried, oldest first (the event bus records the wake, A-7). A
   * throw is logged and changes nothing.
   */
  onSent?(targetId: string, keys: readonly string[]): void;
  /**
   * Called at the target's first turn end after a message of this batch went
   * out — once per message, oldest first, before anything else queued for it
   * is delivered at that turn end (A-7: the wake ended). `paseo` is the
   * handle of that turn end's hook. A returned promise is awaited before that
   * delivery; a throw or a rejection is logged.
   */
  onTurnEnded?(targetId: string, paseo?: unknown): unknown;
}

/** One line of a batch. */
export interface BatchItem {
  /** Dedupe key: a newer item of the same key replaces a queued one. */
  key: string;
  line: string;
  /**
   * Read at the idle moment, synchronously, just before the batch is sent:
   * false drops the item (its subject settled before delivery). A throw counts
   * as false. Always current when absent.
   */
  isCurrent?: () => boolean;
  /** Items of one group go as one message; items of other groups wait for their own (missions design §20). `""` when absent. */
  group?: string;
  /** The item's group goes before every other notice queued for the target (a `danger` wake, §20). */
  first?: boolean;
  /** What this item's sender is told of it, as for a single notice (mission runtime design §6.2). */
  callbacks?: NoticeCallbacks;
  /** The wake gate at the send (delivery line design §6.4), read as `EnqueueOptions.isHeld` is. */
  isHeld?: () => boolean;
}

/** What a single notice's sender is told about it later (design §16.7). */
export interface NoticeCallbacks {
  /** The notice went out. */
  onSent?(targetId: string, kind: NoticeKind): void;
  /** The notice was dropped: the target is archived, closed or gone, or the send failed. */
  onDropped?(targetId: string, kind: NoticeKind, reason: string): void;
  /** Its `isHeld` held it at the send (delivery line design §6.4): it left the queue unsent; the sender holds it. */
  onHeld?(targetId: string, kind: NoticeKind): void;
  /** It was steered into the target's running turn (delivery line design §19.5); told before `onSent`. */
  onSteered?(targetId: string, kind: NoticeKind, result: SteerResult): void;
}

/** How a single notice is queued. */
export interface EnqueueOptions {
  /** It goes before every other notice queued for the target (delivery line design §6.6). */
  first?: boolean;
  /** Read just before the send: true holds it instead (delivery line design §6.4: the wake gate at the send). */
  isHeld?: () => boolean;
  /** The owner's words (delivery line design §19.5): steered into a running turn when every guard holds (`steerRefusalOf`). */
  steer?: boolean;
}

export interface NoticeQueue {
  /** Sends now when the target is idle, otherwise holds the notice for its next turn end. Never rejects. */
  enqueue(targetId: string, kind: NoticeKind, text: string, paseo?: NoticePaseo, callbacks?: NoticeCallbacks, options?: EnqueueOptions): Promise<NoticeOutcome>;
  /** Queues every item, then delivers once: the batched items pending at the idle moment go as one message. Never rejects. */
  enqueueBatch(targetId: string, batch: NoticeBatch, items: readonly BatchItem[], paseo?: NoticePaseo): Promise<NoticeOutcome[]>;
  /** One `agent.turn_ended`: delivers the ended agent's queued notices when it is idle. Never rejects. */
  turnEnded(event: unknown, paseo?: unknown): Promise<void>;
  /**
   * Missions design §3.4: every notice queued for `oldId` is queued for
   * `newId` instead (in order; a moved notice replaces one of the same kind
   * already queued there), with its callbacks, then delivered as any other.
   * Returns how many moved. Never rejects.
   */
  retarget(oldId: string, newId: string, paseo?: NoticePaseo): Promise<number>;
  /** What is queued for `targetId`, oldest first (a copy). */
  pending(targetId: string): QueuedNotice[];
  /** Forgets every queued notice and the remembered Paseo handle. */
  clear(): void;
}

export interface NoticeQueueDeps {
  /** Where failures are reported. Defaults to `console.warn`. */
  log?: (message: string) => void;
  /** A steer's time; the clock by default. */
  now?: () => Date;
  /** A steer's `messageId`; `randomUUID` by default. */
  newMessageId?: () => string;
  /** The base provider of a provider id (`bm-worker` → `claude`), for a steer's guard; the aliases' `extends` (`aliasBases`) by default. */
  baseOf?: (paseo: NoticePaseo, provider: string | null | undefined) => Promise<string | null>;
}

/** A provider id's base: a base itself, else its alias's `extends`; null when not known. Never rejects. */
async function defaultBaseOf(paseo: NoticePaseo, provider: string | null | undefined): Promise<string | null> {
  const id = providerId(provider);
  if (id === null) return null;
  if (STEER_PROVIDERS.includes(id)) return id;
  return (await aliasBases(paseo))[id] ?? null;
}

interface Entry extends QueuedNotice {
  state: "queued" | "sending" | "held" | NoticeOutcome;
  /** Set on a batched item: its batch, its own key, and whether it is still worth sending; `first` on a single notice too. */
  batch?: NoticeBatch;
  itemKey?: string;
  isCurrent?: () => boolean;
  group?: string;
  first?: boolean;
  isHeld?: () => boolean;
  /** Set on a notice, single or batched, whose sender wants its outcome. */
  callbacks?: NoticeCallbacks;
}

type DeliveryStep = "empty" | "unknown" | "gone" | "busy" | "sent" | "failed" | "settled";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPaseo(value: unknown): value is NoticePaseo {
  if (value === null || typeof value !== "object") return false;
  const agents = (value as { agents?: unknown }).agents;
  return agents !== null && typeof agents === "object" && typeof (agents as { ref?: unknown }).ref === "function";
}

function agentIdOf(event: unknown): string | null {
  if (event === null || typeof event !== "object") return null;
  const agent = (event as { agent?: unknown }).agent;
  if (agent === null || typeof agent !== "object") return null;
  const id = (agent as { id?: unknown }).id;
  return nonEmpty(id) ? id : null;
}

function isBusy(status: string | null | undefined): boolean {
  return status === "running" || status === "initializing";
}

/** What an enqueue answers for its entry: one being sent, or held by its sender at the send, is `queued` (told later or told already). */
function outcomeOf(entry: Entry): NoticeOutcome {
  return entry.state === "sending" || entry.state === "held" ? "queued" : entry.state;
}

export function createNoticeQueue(deps: NoticeQueueDeps = {}): NoticeQueue {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const newMessageId = deps.newMessageId ?? randomUUID;
  const baseOf = deps.baseOf ?? defaultBaseOf;
  /** Target agent id → its queued notices, oldest first. */
  const queued = new Map<string, Entry[]>();
  /** Targets being delivered to right now; `again` asks that delivery for one more look. */
  const delivering = new Map<string, { again: boolean }>();
  /** Target → the batches of the messages sent to it whose turn end is still to come, oldest first. */
  const awaitingEnd = new Map<string, NoticeBatch[]>();
  let lastPaseo: NoticePaseo | null = null;

  function handleFor(paseo: unknown): NoticePaseo | null {
    if (isPaseo(paseo)) lastPaseo = paseo;
    return lastPaseo;
  }

  function put(targetId: string, entry: Entry): void {
    const kept: Entry[] = [];
    for (const old of queued.get(targetId) ?? []) {
      if (old.kind === entry.kind) old.state = "replaced";
      else kept.push(old);
    }
    kept.push(entry);
    queued.set(targetId, kept);
  }

  /** Takes `entry` off the target's queue; other notices stay in order. */
  function take(targetId: string, entry: Entry | undefined): Entry | undefined {
    const list = queued.get(targetId);
    const index = entry === undefined || list === undefined ? -1 : list.indexOf(entry);
    if (index === -1) return undefined;
    list!.splice(index, 1);
    if (list!.length === 0) queued.delete(targetId);
    return entry;
  }

  /** Takes every queued item of `name` and `group` for the target, in order; other notices stay. */
  function takeBatch(targetId: string, name: string, group: string): Entry[] {
    const list = queued.get(targetId) ?? [];
    const inIt = (entry: Entry) => entry.batch?.name === name && (entry.group ?? "") === group;
    const taken = list.filter(inIt);
    const kept = list.filter((entry) => !inIt(entry));
    if (kept.length === 0) queued.delete(targetId);
    else queued.set(targetId, kept);
    return taken;
  }

  function stillCurrent(entry: Entry): boolean {
    if (entry.isCurrent === undefined) return true;
    try {
      return entry.isCurrent() === true;
    } catch (error) {
      log(`[paseo-bm] could not tell whether the ${entry.kind} notice is still current: ${errorText(error)}; dropped it.`);
      return false;
    }
  }

  /** The wake gate at the send (delivery line design §6.4): true holds the entry; a throw lets it go. */
  function heldNow(entry: Entry): boolean {
    if (entry.isHeld === undefined) return false;
    try {
      return entry.isHeld() === true;
    } catch (error) {
      log(`[paseo-bm] could not tell whether the ${entry.kind} notice is held: ${errorText(error)}; it goes.`);
      return false;
    }
  }

  /** Tells a single notice's sender what became of it; a throw is logged. */
  function tell(targetId: string, entry: Entry, outcome: "sent" | "dropped" | "held", reason = ""): void {
    try {
      if (outcome === "sent") entry.callbacks?.onSent?.(targetId, entry.kind);
      else if (outcome === "held") entry.callbacks?.onHeld?.(targetId, entry.kind);
      else entry.callbacks?.onDropped?.(targetId, entry.kind, reason);
    } catch (error) {
      log(`[paseo-bm] after the ${entry.kind} notice to ${targetId} was ${outcome}: ${errorText(error)}`);
    }
  }

  function dropAll(targetId: string): void {
    const list = queued.get(targetId) ?? [];
    queued.delete(targetId);
    if (list.length === 0) return;
    for (const entry of list) entry.state = "dropped";
    log(
      `[paseo-bm] ${targetId} is archived, closed or gone; dropped its queued notices (${list.map((entry) => entry.kind).join(", ")}).`,
    );
    for (const entry of list) tell(targetId, entry, "dropped", "the target is archived, closed or gone");
  }

  /** The notice that goes next: the oldest `first` notice or item of a `first` group, else the oldest notice. */
  function headOf(targetId: string): Entry | undefined {
    const list = queued.get(targetId);
    return list?.find((entry) => entry.first === true) ?? list?.[0];
  }

  /** One look at the target: sends its next notice (`headOf`) when it is idle. */
  async function step(targetId: string, paseo: NoticePaseo): Promise<DeliveryStep> {
    const head = headOf(targetId);
    if (head === undefined) return "empty";
    let agent: NoticeAgentSnapshot | null;
    try {
      agent = (await paseo.agents.ref(targetId).refresh())?.agent ?? null;
    } catch (error) {
      log(`[paseo-bm] could not read ${targetId} to deliver its ${head.kind} notice: ${errorText(error)}; it waits for that agent's next turn end.`);
      return "unknown";
    }
    if (agent === null || agent.archivedAt != null || agent.status === "closed") {
      dropAll(targetId);
      return "gone";
    }
    if (isBusy(agent.status)) return "busy";
    const next = headOf(targetId);
    const batch = next?.batch;
    const group = next?.group ?? "";
    // A batch: every item of its group pending now, less those whose subject settled, as one message.
    // Taken and judged synchronously right after the idle read, so nothing is added or settles in between.
    const entries = batch === undefined ? [take(targetId, next)].filter((entry): entry is Entry => entry !== undefined) : takeBatch(targetId, batch.name, group);
    const sending = entries.filter((entry) => {
      if (!stillCurrent(entry)) {
        entry.state = "dropped";
        tell(targetId, entry, "dropped", "its subject settled before delivery");
        return false;
      }
      // Delivery line design §6.4: the wake gate decides again at the send, not only when it was queued.
      if (!heldNow(entry)) return true;
      entry.state = "held";
      tell(targetId, entry, "held");
      return false;
    });
    if (entries.length === 0) return "empty";
    if (sending.length === 0) return "settled";
    // Taken off the queue BEFORE the await: a turn end handled meanwhile never sends it twice.
    for (const entry of sending) entry.state = "sending";
    const text = batch === undefined ? sending[0]!.text : batch.compose(sending.map((entry) => entry.text), group);
    const what = batch === undefined ? sending[0]!.kind : `${batch.name} (${sending.length})`;
    // Before the await, so a turn end handled meanwhile finds it.
    const awaiting = batch?.onTurnEnded === undefined ? null : batch;
    if (awaiting !== null) awaitingEnd.set(targetId, [...(awaitingEnd.get(targetId) ?? []), awaiting]);
    try {
      await paseo.agents.ref(targetId).send(text);
      for (const entry of sending) entry.state = "sent";
      for (const entry of sending) tell(targetId, entry, "sent");
      if (batch?.onSent !== undefined) {
        try {
          batch.onSent(targetId, sending.map((entry) => entry.itemKey ?? entry.kind));
        } catch (error) {
          log(`[paseo-bm] after sending the ${what} notice to ${targetId}: ${errorText(error)}`);
        }
      }
      return "sent";
    } catch (error) {
      for (const entry of sending) entry.state = "dropped";
      if (awaiting !== null) {
        const list = (awaitingEnd.get(targetId) ?? []).filter((item) => item !== awaiting);
        if (list.length === 0) awaitingEnd.delete(targetId);
        else awaitingEnd.set(targetId, list);
      }
      log(`[paseo-bm] could not send the ${what} notice to ${targetId}: ${errorText(error)}; dropped it.`);
      for (const entry of sending) tell(targetId, entry, "dropped", `the send failed: ${errorText(error)}`);
      return "failed";
    }
  }

  async function deliver(targetId: string, paseo: NoticePaseo): Promise<void> {
    const current = delivering.get(targetId);
    if (current !== undefined) {
      // Another delivery is reading this target: it takes one more look when it is done.
      current.again = true;
      return;
    }
    const flag = { again: false };
    delivering.set(targetId, flag);
    try {
      for (;;) {
        flag.again = false;
        const result = await step(targetId, paseo);
        // The notice started a turn; that turn's end carries the next one.
        if (result === "sent" || result === "empty" || result === "gone") return;
        // The target stayed idle (a failed send, or a batch whose every item settled): the next queued notice may go now.
        if (result === "failed" || result === "settled") continue;
        // Busy or unreadable: wait for its next turn end, unless something changed meanwhile.
        if (!flag.again) return;
      }
    } finally {
      delivering.delete(targetId);
    }
  }

  /**
   * Delivery line design §19.5: the owner's words into the target's running
   * turn, when every guard holds. Null when no steer applies — the target is
   * idle, gone, unreadable or being delivered to, the notice is held, or a
   * guard fails — and the notice takes the normal path. Holds the target's
   * delivery while it runs, so no other notice is sent meanwhile.
   */
  async function trySteer(targetId: string, entry: Entry, paseo: NoticePaseo): Promise<NoticeOutcome | null> {
    if (delivering.has(targetId) || heldNow(entry)) return null;
    const flag = { again: false };
    delivering.set(targetId, flag);
    try {
      const ref = paseo.agents.ref(targetId);
      let agent: NoticeAgentSnapshot | null;
      try {
        agent = (await ref.refresh())?.agent ?? null;
      } catch {
        return null;
      }
      if (agent === null || agent.archivedAt != null || agent.status !== "running") return null;
      let base: string | null;
      try {
        base = await baseOf(paseo, agent.provider);
      } catch {
        base = null;
      }
      if (steerRefusalOf(agent, entry.text, base) !== null) return null;
      const turnBefore = turnIdOf(agent)!;
      const messageId = newMessageId();
      try {
        // The SDK 0.8.0 types lack `activeTurnBehavior`; the plugin's `send` forwards its options to the daemon's `sendAgentMessage`.
        await ref.send(entry.text, { messageId, activeTurnBehavior: "steer" } satisfies SteerSendOptions as { messageId: string });
      } catch (error) {
        entry.state = "dropped";
        log(`[paseo-bm] could not steer the ${entry.kind} notice into ${targetId}'s turn: ${errorText(error)}; dropped it.`);
        tell(targetId, entry, "dropped", `the send failed: ${errorText(error)}`);
        return "dropped";
      }
      const at = now().toISOString();
      let turnAfter: string | null = null;
      try {
        turnAfter = turnIdOf((await ref.refresh())?.agent ?? null);
      } catch (error) {
        log(`[paseo-bm] could not read ${targetId} after steering the ${entry.kind} notice into its turn: ${errorText(error)}; counted as steered.`);
      }
      const replaced = turnAfter !== null && turnAfter !== turnBefore;
      // The newest notice of a kind wins (as `put`): an older one of this kind no longer goes.
      for (const old of queued.get(targetId) ?? []) if (old.kind === entry.kind) old.state = "replaced";
      const kept = (queued.get(targetId) ?? []).filter((old) => old.kind !== entry.kind);
      if (kept.length === 0) queued.delete(targetId);
      else queued.set(targetId, kept);
      entry.state = replaced ? "turn-replaced" : "steered";
      if (replaced) log(`[paseo-bm] Paseo replaced ${targetId}'s running turn (${turnBefore} → ${turnAfter}) with the ${entry.kind} notice instead of steering it in.`);
      try {
        entry.callbacks?.onSteered?.(targetId, entry.kind, { at, messageId, replaced, turnBefore, turnAfter });
      } catch (error) {
        log(`[paseo-bm] after steering the ${entry.kind} notice into ${targetId}'s turn: ${errorText(error)}`);
      }
      tell(targetId, entry, "sent");
      return entry.state;
    } finally {
      delivering.delete(targetId);
      // A turn end handled meanwhile left its delivery to this one.
      if (flag.again && queued.has(targetId)) await deliver(targetId, paseo);
    }
  }

  async function enqueue(targetId: string, kind: NoticeKind, text: string, paseo?: NoticePaseo, callbacks?: NoticeCallbacks, options?: EnqueueOptions): Promise<NoticeOutcome> {
    try {
      if (!nonEmpty(targetId) || !nonEmpty(kind) || !nonEmpty(text)) {
        log("[paseo-bm] a plugin notice without a target, a kind or a text was not queued.");
        return "dropped";
      }
      const entry: Entry = { kind, text, state: "queued" };
      if (callbacks !== undefined) entry.callbacks = callbacks;
      if (options?.first === true) entry.first = true;
      if (typeof options?.isHeld === "function") entry.isHeld = options.isHeld;
      if (options?.steer === true) {
        const steering = handleFor(paseo);
        const steered = steering === null ? null : await trySteer(targetId, entry, steering);
        if (steered !== null) return steered;
      }
      put(targetId, entry);
      const handle = handleFor(paseo);
      if (handle !== null) await deliver(targetId, handle);
      return outcomeOf(entry);
    } catch (error) {
      log(`[paseo-bm] queueing the ${String(kind)} notice for ${String(targetId)} failed: ${errorText(error)}`);
      return "dropped";
    }
  }

  async function enqueueBatch(
    targetId: string,
    batch: NoticeBatch,
    items: readonly BatchItem[],
    paseo?: NoticePaseo,
  ): Promise<NoticeOutcome[]> {
    try {
      if (!nonEmpty(targetId) || !nonEmpty(batch?.name) || typeof batch.compose !== "function") {
        log("[paseo-bm] a batch of plugin notices without a target or a batch was not queued.");
        return items.map(() => "dropped");
      }
      const entries = items.map((item): Entry | null => {
        if (!nonEmpty(item?.key) || !nonEmpty(item.line)) return null;
        const entry: Entry = { kind: `${batch.name}:${item.key}`, text: item.line, state: "queued", batch, itemKey: item.key };
        if (typeof item.isCurrent === "function") entry.isCurrent = item.isCurrent;
        if (nonEmpty(item.group)) entry.group = item.group;
        if (item.first === true) entry.first = true;
        if (typeof item.isHeld === "function") entry.isHeld = item.isHeld;
        if (item.callbacks !== undefined) entry.callbacks = item.callbacks;
        put(targetId, entry);
        return entry;
      });
      if (entries.includes(null)) log(`[paseo-bm] ${batch.name}: an item without a key or a line was not queued.`);
      const handle = handleFor(paseo);
      if (handle !== null && entries.some((entry) => entry !== null)) await deliver(targetId, handle);
      return entries.map((entry) => (entry === null ? "dropped" : outcomeOf(entry)));
    } catch (error) {
      log(`[paseo-bm] queueing the ${String(batch?.name)} batch for ${String(targetId)} failed: ${errorText(error)}`);
      return items.map(() => "dropped");
    }
  }

  /** The target's turn ended: the oldest batch message still waiting for that is told. */
  async function endOne(targetId: string, paseo: unknown): Promise<void> {
    const list = awaitingEnd.get(targetId);
    const first = list?.shift();
    if (list !== undefined && list.length === 0) awaitingEnd.delete(targetId);
    if (first === undefined) return;
    try {
      await first.onTurnEnded?.(targetId, paseo);
    } catch (error) {
      log(`[paseo-bm] after the turn end of ${targetId} (${first.name}): ${errorText(error)}`);
    }
  }

  async function turnEnded(event: unknown, paseo?: unknown): Promise<void> {
    try {
      const handle = handleFor(paseo);
      const targetId = agentIdOf(event);
      if (targetId !== null) await endOne(targetId, paseo);
      if (targetId === null || handle === null || !queued.has(targetId)) return;
      await deliver(targetId, handle);
    } catch (error) {
      log(`[paseo-bm] delivering queued notices failed: ${errorText(error)}`);
    }
  }

  async function retarget(oldId: string, newId: string, paseo?: NoticePaseo): Promise<number> {
    try {
      if (!nonEmpty(oldId) || !nonEmpty(newId) || oldId === newId) return 0;
      const moved = queued.get(oldId) ?? [];
      queued.delete(oldId);
      for (const entry of moved) put(newId, entry);
      const handle = handleFor(paseo);
      if (moved.length > 0 && handle !== null) await deliver(newId, handle);
      return moved.length;
    } catch (error) {
      log(`[paseo-bm] moving the notices queued for ${String(oldId)} to ${String(newId)} failed: ${errorText(error)}`);
      return 0;
    }
  }

  return {
    enqueue,
    enqueueBatch,
    turnEnded,
    retarget,
    pending: (targetId) => (queued.get(targetId) ?? []).map(({ kind, text }) => ({ kind, text })),
    clear() {
      for (const list of queued.values()) for (const entry of list) entry.state = "dropped";
      queued.clear();
      awaitingEnd.clear();
      lastPaseo = null;
    },
  };
}

/** The queue every consumer shares; `registerNoticeQueue` delivers it by default. */
export const noticeQueue: NoticeQueue = createNoticeQueue();

/** `noticeQueue.enqueue`: send now when `targetId` is idle, otherwise at its next turn end. Never rejects. */
export function enqueue(targetId: string, kind: NoticeKind, text: string, paseo?: NoticePaseo, callbacks?: NoticeCallbacks, options?: EnqueueOptions): Promise<NoticeOutcome> {
  return noticeQueue.enqueue(targetId, kind, text, paseo, callbacks, options);
}

export type NoticeHost = Partial<Pick<PluginServerContext, "on">>;

export interface NoticeQueueRegistration {
  /** Hand this to the module whose `agent.turn_ended` hook the queue rides on. */
  host: NoticeHost;
  /** Detaches the queue from that hook and forgets what it holds. */
  remove(): void;
}

/**
 * Lets the queue ride on an `agent.turn_ended` hook another module registers
 * through the returned `host`: after that module's handler settles, the same
 * turn end delivers the queue. Every other registration passes through
 * untouched. On a host without `on` the queue is never delivered at turn ends;
 * `enqueue` still sends to an idle target.
 */
export function registerNoticeQueue(host: NoticeHost, queue: NoticeQueue = noticeQueue): NoticeQueueRegistration {
  let attached = true;
  const remove = (): void => {
    attached = false;
    queue.clear();
  };
  if (typeof host.on !== "function") return { host, remove };
  const register = host.on.bind(host);
  const on: PluginServerContext["on"] = (name, handler) => {
    if (name !== "agent.turn_ended") return register(name, handler);
    return register(name, async (event, context) => {
      try {
        await handler(event, context);
      } finally {
        if (attached) await queue.turnEnded(event, context?.paseo);
      }
    });
  };
  return { host: { on }, remove };
}
