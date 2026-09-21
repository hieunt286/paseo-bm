/**
 * The notice queue: the one way the plugin delivers a notice to an agent that
 * may be running (delta 20260921 §4.2.4, §4.3.5, §4.4.6, F13; REQ-063 d,
 * REQ-064 d, REQ-065 c).
 *
 * `PaseoAgentHandle.send()` on a running agent REPLACES its turn (delta
 * 20260918g K10; `stop-propagation.ts` relies on exactly that to interrupt a
 * Reviewer). `BM-TOOLS`, `BM-SETTINGS` and `BM-FALLBACK` go to Managers and
 * Workers that are often mid-turn, so none of them calls `send()` itself.
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
 * - `noticeQueue`: the one shared queue `enqueue` uses. `createNoticeQueue()`
 *   makes a private one (tests).
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
 * - **Never into a running turn.** Nothing is sent unless `refresh()`, read
 *   just before, says the target is neither `running` nor `initializing`.
 * - **One notice per idle moment.** The notice sent starts a turn on the
 *   target, and a second `send()` would replace that turn; so each chance
 *   sends the oldest queued notice only, and that turn's end carries the next
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
import type { PluginServerContext } from "@getpaseo/plugin/server";

/** A notice's marker, for example `"BM-TOOLS"`; one queued notice per kind and target. */
export type NoticeKind = string;

export type NoticeOutcome = "sent" | "queued" | "replaced" | "dropped";

/** The snapshot fields this module reads; `PaseoAgent` is structurally assignable. */
export interface NoticeAgentSnapshot {
  status?: string | null;
  archivedAt?: string | null;
}

/** The SDK slice this module uses; `PaseoApi` from a hook or handler context is structurally assignable. */
export interface NoticePaseo {
  agents: {
    ref(agentId: string): {
      refresh(): Promise<{ agent?: NoticeAgentSnapshot | null } | null>;
      send(text: string): Promise<void>;
    };
  };
}

/** A queued notice, as `pending()` shows it. */
export interface QueuedNotice {
  kind: NoticeKind;
  text: string;
}

export interface NoticeQueue {
  /** Sends now when the target is idle, otherwise holds the notice for its next turn end. Never rejects. */
  enqueue(targetId: string, kind: NoticeKind, text: string, paseo?: NoticePaseo): Promise<NoticeOutcome>;
  /** One `agent.turn_ended`: delivers the ended agent's queued notices when it is idle. Never rejects. */
  turnEnded(event: unknown, paseo?: unknown): Promise<void>;
  /** What is queued for `targetId`, oldest first (a copy). */
  pending(targetId: string): QueuedNotice[];
  /** Forgets every queued notice and the remembered Paseo handle. */
  clear(): void;
}

export interface NoticeQueueDeps {
  /** Where failures are reported. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

interface Entry extends QueuedNotice {
  state: "queued" | "sending" | NoticeOutcome;
}

type DeliveryStep = "empty" | "unknown" | "gone" | "busy" | "sent" | "failed";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

export function createNoticeQueue(deps: NoticeQueueDeps = {}): NoticeQueue {
  const log = deps.log ?? ((message: string) => console.warn(message));
  /** Target agent id → its queued notices, oldest first. */
  const queued = new Map<string, Entry[]>();
  /** Targets being delivered to right now; `again` asks that delivery for one more look. */
  const delivering = new Map<string, { again: boolean }>();
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

  function take(targetId: string): Entry | undefined {
    const list = queued.get(targetId);
    const first = list?.shift();
    if (list !== undefined && list.length === 0) queued.delete(targetId);
    return first;
  }

  function dropAll(targetId: string): void {
    const list = queued.get(targetId) ?? [];
    queued.delete(targetId);
    if (list.length === 0) return;
    for (const entry of list) entry.state = "dropped";
    log(
      `[paseo-bm] ${targetId} is archived, closed or gone; dropped its queued notices (${list.map((entry) => entry.kind).join(", ")}).`,
    );
  }

  /** One look at the target: sends its oldest notice when it is idle. */
  async function step(targetId: string, paseo: NoticePaseo): Promise<DeliveryStep> {
    const head = queued.get(targetId)?.[0];
    if (head === undefined) return "empty";
    let agent: NoticeAgentSnapshot | null;
    try {
      agent = (await paseo.agents.ref(targetId).refresh())?.agent ?? null;
    } catch (error) {
      log(`[paseo-bm] could not read ${targetId} to deliver its ${head.kind} notice: ${describeError(error)}; it waits for that agent's next turn end.`);
      return "unknown";
    }
    if (agent === null || agent.archivedAt != null || agent.status === "closed") {
      dropAll(targetId);
      return "gone";
    }
    if (isBusy(agent.status)) return "busy";
    const entry = take(targetId);
    if (entry === undefined) return "empty";
    // Taken off the queue BEFORE the await: a turn end handled meanwhile never sends it twice.
    entry.state = "sending";
    try {
      await paseo.agents.ref(targetId).send(entry.text);
      entry.state = "sent";
      return "sent";
    } catch (error) {
      entry.state = "dropped";
      log(`[paseo-bm] could not send the ${entry.kind} notice to ${targetId}: ${describeError(error)}; dropped it.`);
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
        // The target stayed idle: the next queued notice may go now.
        if (result === "failed") continue;
        // Busy or unreadable: wait for its next turn end, unless something changed meanwhile.
        if (!flag.again) return;
      }
    } finally {
      delivering.delete(targetId);
    }
  }

  async function enqueue(targetId: string, kind: NoticeKind, text: string, paseo?: NoticePaseo): Promise<NoticeOutcome> {
    try {
      if (!nonEmpty(targetId) || !nonEmpty(kind) || !nonEmpty(text)) {
        log("[paseo-bm] a plugin notice without a target, a kind or a text was not queued.");
        return "dropped";
      }
      const entry: Entry = { kind, text, state: "queued" };
      put(targetId, entry);
      const handle = handleFor(paseo);
      if (handle !== null) await deliver(targetId, handle);
      return entry.state === "sending" ? "queued" : entry.state;
    } catch (error) {
      log(`[paseo-bm] queueing the ${String(kind)} notice for ${String(targetId)} failed: ${describeError(error)}`);
      return "dropped";
    }
  }

  async function turnEnded(event: unknown, paseo?: unknown): Promise<void> {
    try {
      const handle = handleFor(paseo);
      const targetId = agentIdOf(event);
      if (targetId === null || handle === null || !queued.has(targetId)) return;
      await deliver(targetId, handle);
    } catch (error) {
      log(`[paseo-bm] delivering queued notices failed: ${describeError(error)}`);
    }
  }

  return {
    enqueue,
    turnEnded,
    pending: (targetId) => (queued.get(targetId) ?? []).map(({ kind, text }) => ({ kind, text })),
    clear() {
      for (const list of queued.values()) for (const entry of list) entry.state = "dropped";
      queued.clear();
      lastPaseo = null;
    },
  };
}

/** The queue every consumer shares; `registerNoticeQueue` delivers it by default. */
export const noticeQueue: NoticeQueue = createNoticeQueue();

/** `noticeQueue.enqueue`: send now when `targetId` is idle, otherwise at its next turn end. Never rejects. */
export function enqueue(targetId: string, kind: NoticeKind, text: string, paseo?: NoticePaseo): Promise<NoticeOutcome> {
  return noticeQueue.enqueue(targetId, kind, text, paseo);
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
