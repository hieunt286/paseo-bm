/**
 * The event bus to the Beads Orchestrator (autonomy design §A.8, REQ-115 b).
 *
 * Replaces earlier builds' one-notice-per-situation wake-ups (autonomy design
 * §A.14) with typed events, delivered in batches:
 *
 * | Event | Source | Settled (dropped before delivery) when |
 * |---|---|---|
 * | `decision.opened` | a new `q:` decision the materialiser opened (`decision-materialiser.ts`), unless an option carries a `CONFIRM_EFFECTS` effect | the decision is no longer open or needs-confirmation |
 * | `request.finished` | a `finished` report recorded in a Manager's turn (the collector's `onRecorded`) that shows work left | — (only Autopilot turned off) |
 *
 * - **Only what needs a judgement** (REQ-115 b, A-7): a question with an
 *   option that releases, touches real data, migrates, touches security or
 *   spends is the owner's alone (X-4), so it waits in the Inbox and does not
 *   wake the Orchestrator; a finished report wakes it only when it shows work
 *   left — ready beads, open review findings, blockers, or failing checks
 *   (`workLeftOf`). A clean finish was already proved by the Worker and its
 *   Reviewer; checking it again is a wake with nothing to do (measured
 *   2026-09-29: 3 of 3 wakes of the S1/S7 live check ended with no action).
 * | `request.stalled` | the stall pass raised a `request-stalled` alert (`stall-watcher.ts`) | its alert is cleared |
 * | `worker.signal` | the live watch saw a signal (`worker-watch.ts`) | its alert is cleared (`stuck`, `permission`, `danger`), or the Worker's turn ended (`failing`, `heavy`, `outside`) |
 *
 * - **Autopilot projects only.** Every event is published only for a project
 *   with Autopilot on, and dropped at delivery when Autopilot was turned off
 *   meanwhile: outside Autopilot the Orchestrator acts only when the owner
 *   talks to it, and what needs the owner is in the Inbox (decisions, alerts).
 *   Part B replaces this with the owner's policy.
 * - **One message per idle moment.** Events go through the notice queue's
 *   batch kind (`enqueueBatch`, `BM-EVENTS`): everything pending when the
 *   Orchestrator is idle goes as ONE `BM-EVENTS` message, one short line per
 *   event with the ids to look up; never into a running turn.
 * - **Once per event.** Each event has a dedupe key (`eventKeyOf`); a key
 *   published in this plugin run is not published again. The sources dedupe
 *   across reloads themselves: a decision opens once (the store), an alert is
 *   raised once (the alerts store), a turn is recorded once. Only the
 *   `failing`, `heavy` and `outside` signals may be told once more after a
 *   reload in the middle of the Worker's turn.
 * - **Only to the Orchestrator**, the one the plugin may wake
 *   (`wakeableOrchestrator`: an outdated one, or one without tools, is replaced
 *   first). Without an Orchestrator nothing is queued. Nothing here ever
 *   messages the owner, a Manager, a Worker or a Reviewer.
 * - **Each wake is recorded** (evaluation design §4, A-7): once a `BM-EVENTS`
 *   message went out (the batch's `onSent`), `orchestrator/wakes.json` gets
 *   the Orchestrator's id, the time, the projects and the number of events; at
 *   that Orchestrator's next turn end (the batch's `onTurnEnded`, before the
 *   queue delivers anything else) its oldest open wake gets its end. Ids,
 *   times and a count only. A wake whose turn end came after a reload keeps no
 *   end.
 *
 * Nothing here throws into the plugin: a failure is one log line.
 */
import { resolveDataHome } from "./data-home";
import { createAlertStore } from "./alert-store";
import { createDecisionStore } from "./decision-store";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticeQueue } from "./notice-queue";
import { EVENTS_NOTICE_MARKER } from "./notices";
import { wakeableOrchestrator, type OrchestratorAgentDeps, type OrchestratorAgentPaseo, type OrchestratorAgentSnapshot } from "./orchestrator-agent";
import { createOrchestratorStore } from "./orchestrator-store";
import { UNSETTLED_STATUSES, needsOwnerConfirmation, type Decision } from "../shared/decisions";
import type { WorkerSignal } from "../shared/orchestrator";
import type { TraceRecord } from "../shared/contracts";

/** The event types, in the order of design §A.8. */
export const EVENT_TYPES = ["decision.opened", "request.finished", "request.stalled", "worker.signal"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Why a request stalled (design §A.8): nobody ran for 5 minutes, or the review went over its budget. */
export const STALL_REASONS = ["idle-unfinished", "review-over-budget"] as const;
export type StallReason = (typeof STALL_REASONS)[number];

export interface DecisionOpenedEvent {
  type: "decision.opened";
  workspaceId: string;
  requestId: string | null;
  decisionId: string;
  /** The Worker that asked, when known. */
  askedBy: string | null;
}

export interface RequestFinishedEvent {
  type: "request.finished";
  workspaceId: string;
  /** The request id, or null when the report named none. */
  requestId: string | null;
  managerId: string;
  /** When the report was recorded: one event per report. */
  at: string;
}

export interface RequestStalledEvent {
  type: "request.stalled";
  workspaceId: string;
  /** The request id, or its trace id when it has none. */
  requestKey: string;
  managerId: string | null;
  reason: StallReason;
  /** The `request-stalled` alert this event reports; the event is settled once it is cleared. */
  alertKey: string;
  /** When the alert was raised. */
  since: string;
}

export interface WorkerSignalEvent {
  type: "worker.signal";
  workspaceId: string;
  workerId: string;
  requestKey: string | null;
  signal: WorkerSignal;
  /** The start of the Worker's turn the signal was seen in. */
  turnStart: string;
  /** The signal's alert (`stuck`, `permission`, `danger`); null for the others, which hold until the turn ends. */
  alertKey: string | null;
  /** When the signal began, or its alert was raised. */
  since: string;
  /** A `danger` signal's interrupt allowance: until when the Orchestrator may interrupt that Worker. */
  interruptUntil?: string | null;
}

export type BmEvent = DecisionOpenedEvent | RequestFinishedEvent | RequestStalledEvent | WorkerSignalEvent;

/** The dedupe key of an event: one delivery per key. */
export function eventKeyOf(event: BmEvent): string {
  switch (event.type) {
    case "decision.opened":
      return `decision.opened:${event.decisionId}`;
    case "request.finished":
      return `request.finished:${event.workspaceId}:${event.requestId ?? `manager:${event.managerId}`}@${event.at}`;
    case "request.stalled":
      return `request.stalled:${event.workspaceId}:${event.requestKey}@${event.since}`;
    case "worker.signal":
      return `worker.signal:${event.workspaceId}:${event.workerId}:${event.signal}@${event.alertKey === null ? event.turnStart : event.since}`;
  }
}

/** One short line per event: what happened, and the ids to look up (design §A.8). */
export function eventLineOf(event: BmEvent): string {
  const project = `project ${event.workspaceId}`;
  switch (event.type) {
    case "decision.opened":
      return `- decision.opened — ${project}, request ${event.requestId ?? "none"}, decision ${event.decisionId}${
        event.askedBy === null ? "" : `, asked by Worker ${event.askedBy}`
      }. Read it with bm_decisions.`;
    case "request.finished":
      return `- request.finished — ${project}, request ${event.requestId ?? "not named"}, Manager ${event.managerId}, at ${event.at}. Check it with bm_request.`;
    case "request.stalled":
      return `- request.stalled ${event.reason} — ${project}, request ${event.requestKey}${
        event.managerId === null ? "" : `, Manager ${event.managerId}`
      }, since ${event.since}. Look with bm_request.`;
    case "worker.signal": {
      const allowance =
        event.interruptUntil === undefined || event.interruptUntil === null
          ? ""
          : ` You may interrupt this Worker until ${event.interruptUntil} (bm_direct_worker with interrupt: true).`;
      return `- worker.signal ${event.signal} — ${project}, Worker ${event.workerId}, request ${event.requestKey ?? "not known"}, since ${event.since}. Look with bm_agent_messages.${allowance}`;
    }
  }
}

/** The one message that carries the lines pending at the Orchestrator's idle moment. */
export function eventsMessageOf(lines: readonly string[]): string {
  return [
    EVENTS_NOTICE_MARKER,
    `From the paseo-bm plugin, not the owner: ${lines.length} event${lines.length === 1 ? "" : "s"} of projects with Autopilot on, oldest first. Look before you act; when nothing needs doing, do nothing.`,
    ...lines,
  ].join("\n");
}

/**
 * `decision.opened` for each unsettled Worker question (`q:`) among `decisions`
 * that the Orchestrator could settle: none of its options needs the owner's
 * confirmation (§A.8). Pure.
 */
export function decisionOpenedEventsOf(decisions: readonly Decision[]): DecisionOpenedEvent[] {
  return decisions
    .filter((decision) => decision.id.startsWith("q:") && UNSETTLED_STATUSES.includes(decision.status))
    .filter((decision) => !decision.options.some((option) => needsOwnerConfirmation(option.effects)))
    .map((decision) => ({
      type: "decision.opened",
      workspaceId: decision.workspaceId,
      requestId: decision.requestId,
      decisionId: decision.id,
      askedBy: decision.askedBy.agentId,
    }));
}

/**
 * A report field that says nothing is there: empty, or starting with "none",
 * "no", "nothing", "n/a", "0" or a dash ("none. Suggestion: …" is still none).
 */
function saysNothing(value: string | null): boolean {
  if (value === null) return true;
  return /^\s*(?:$|(?:none|no|nothing|n\/a|0)\b|[-—])/i.test(value);
}

/** Zero counts of failures ("0 fail", "failed: 0", "no errors"): not failures. */
const ZERO_FAILURES = /\b(?:0|no|zero)\s+(?:fail(?:s|ed|ing|ures?)?|errors?)\b|\b(?:fail(?:s|ed|ing|ures?)?|errors?)\s*[:=]\s*0\b/gi;

/** Checks the report names as failing, once the zero counts are set aside. */
const FAILING_CHECKS = /\b(?:fail(?:s|ed|ing|ures?)?|red|errors?|broken)\b/i;

/**
 * Whether a `finished` report shows work left for a coordinator: ready beads,
 * open review findings, blockers, or failing checks (§A.8). Pure.
 */
export function workLeftOf(report: TraceRecord["reports"][number]): boolean {
  return (
    report.beadsReady.length > 0 ||
    !saysNothing(report.reviewFindingsOpen) ||
    !saysNothing(report.blockers) ||
    (report.buildAndTests !== null && FAILING_CHECKS.test(report.buildAndTests.replace(ZERO_FAILURES, "")))
  );
}

/** `request.finished` for each `finished` report recorded in a Manager's turn that shows work left (§A.8). Pure. */
export function requestFinishedEventsOf(record: TraceRecord | null | undefined): RequestFinishedEvent[] {
  if (record === null || record === undefined || record.role !== "manager") return [];
  return record.reports
    .filter((report) => report.phase === "finished" && workLeftOf(report))
    .map((report) => ({
      type: "request.finished",
      workspaceId: record.workspaceId,
      requestId: report.requestId ?? record.requestId,
      managerId: record.agentId,
      at: report.at,
    }));
}

/**
 * The batch the notice queue merges the events into. A bus adds its own
 * `onSent`, which records the wake.
 */
export const EVENTS_BATCH: NoticeBatch = { name: EVENTS_NOTICE_MARKER, compose: eventsMessageOf };

// ---------------------------------------------------------------------------
// The bus.
// ---------------------------------------------------------------------------

/** How many published keys the bus remembers; the oldest are forgotten first. */
export const PUBLISHED_KEYS_LIMIT = 2_000;

export interface EventBusDeps extends OrchestratorAgentDeps {
  /** The notice queue; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueueBatch">;
  /** The data folder; `resolveDataHome` by default. */
  home?: () => string | null;
}

/** What one publish did, for the tests and the log. */
export interface PublishResult {
  status: "done" | "none" | "no-paseo" | "no-data-folder" | "no-orchestrator" | "failed";
  /** Event keys queued or sent to the Orchestrator. */
  published: string[];
  /** Event keys left out: not an Autopilot project, or already published. */
  skipped: string[];
}

export interface EventBus {
  /** Keeps the handle a hook or RPC context brought; anything that is not one is ignored. */
  usePaseo(paseo: unknown): void;
  /** Publishes events to the Orchestrator (Autopilot projects only). Never rejects. */
  publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult>;
  /**
   * One recorded turn (the collector's `onRecorded`): `decision.opened` for
   * the Worker questions it opened, `request.finished` for its `finished`
   * reports — one publish, so they reach the Orchestrator together. Never rejects.
   */
  turnRecorded(record: TraceRecord | null | undefined, opened: readonly Decision[], paseo?: unknown): Promise<PublishResult>;
  /** A Worker's turn ended: its `failing`, `heavy` and `outside` events are settled. */
  workerTurnEnded(workerId: string): void;
  /** True while this non-alert Worker-signal key is open (published in the Worker's current turn). */
  isSignalOpen(key: string): boolean;
}

function isPaseo(value: unknown): value is OrchestratorAgentPaseo {
  const candidate = value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined;
  return typeof candidate?.agents?.list === "function" && typeof candidate?.agents?.ref === "function";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const result = (status: PublishResult["status"], skipped: string[] = []): PublishResult => ({ status, published: [], skipped });

export function createEventBus(deps: EventBusDeps = {}): EventBus {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const queue = deps.queue ?? noticeQueue;
  let lastPaseo: OrchestratorAgentPaseo | null = null;
  /** Keys published in this run, oldest first. */
  const published = new Set<string>();
  /** Open non-alert Worker-signal keys → their Worker. */
  const openSignals = new Map<string, string>();
  /** Published keys → their project, until the wake that carried them is recorded (A-7). */
  const workspaceOfKey = new Map<string, string>();

  const homeOf = (): string | null => {
    try {
      return deps.home === undefined ? resolveDataHome(deps).home : deps.home();
    } catch {
      return null;
    }
  };

  const remember = (key: string): void => {
    published.add(key);
    if (published.size <= PUBLISHED_KEYS_LIMIT) return;
    const oldest = published.values().next().value;
    if (oldest !== undefined) {
      published.delete(oldest);
      workspaceOfKey.delete(oldest);
    }
  };

  /** A `BM-EVENTS` message went out: one wake of that Orchestrator (A-7). */
  const recordWake = (targetId: string, keys: readonly string[]): void => {
    const workspaceIds = keys.map((key) => workspaceOfKey.get(key)).filter((id): id is string => id !== undefined);
    for (const key of keys) workspaceOfKey.delete(key);
    const home = homeOf();
    if (home === null || keys.length === 0) return;
    try {
      createOrchestratorStore(home, { now: deps.now }).appendWake({ orchestratorId: targetId, workspaceIds, events: keys.length });
    } catch (error) {
      log(`[paseo-bm] could not record the Orchestrator's wake: ${describeError(error)}`);
    }
  };

  /** That Orchestrator's turn after a `BM-EVENTS` message ended: its oldest open wake ends now (A-7). */
  const endWake = (targetId: string): void => {
    const home = homeOf();
    if (home === null) return;
    try {
      createOrchestratorStore(home, { now: deps.now }).endWake(targetId);
    } catch (error) {
      log(`[paseo-bm] could not record the end of the Orchestrator's wake: ${describeError(error)}`);
    }
  };

  const batch: NoticeBatch = { ...EVENTS_BATCH, onSent: recordWake, onTurnEnded: endWake };

  /** Whether the event's subject still needs the Orchestrator: read synchronously at the idle moment. */
  const isCurrentOf =
    (event: BmEvent, key: string, home: string) =>
    (): boolean => {
      if (!createOrchestratorStore(home).isAutopilot(event.workspaceId)) return false;
      switch (event.type) {
        case "decision.opened": {
          const decision = createDecisionStore(home, { log }).get(event.decisionId, event.workspaceId);
          return decision !== null && UNSETTLED_STATUSES.includes(decision.status);
        }
        case "request.finished":
          return true;
        case "request.stalled":
          return createAlertStore(home).isOpen(event.alertKey);
        case "worker.signal":
          return event.alertKey === null ? openSignals.has(key) : createAlertStore(home).isOpen(event.alertKey);
      }
    };

  async function publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult> {
    try {
      if (isPaseo(paseo)) lastPaseo = paseo;
      if (events.length === 0) return result("none");
      const home = homeOf();
      if (home === null) return result("no-data-folder");
      const store = createOrchestratorStore(home);
      const skipped: string[] = [];
      const fresh: Array<{ event: BmEvent; key: string }> = [];
      for (const event of events) {
        const key = eventKeyOf(event);
        if (published.has(key) || fresh.some((entry) => entry.key === key) || !store.isAutopilot(event.workspaceId)) skipped.push(key);
        else fresh.push({ event, key });
      }
      if (fresh.length === 0) return result("none", skipped);
      const handle = lastPaseo;
      if (handle === null) return result("no-paseo", skipped);
      const orchestrator = await wakeableOrchestrator(handle, { ...deps, log }, found);
      if (orchestrator === null) return result("no-orchestrator", skipped);
      const items: BatchItem[] = fresh.map(({ event, key }) => {
        remember(key);
        workspaceOfKey.set(key, event.workspaceId);
        if (event.type === "worker.signal" && event.alertKey === null) openSignals.set(key, event.workerId);
        return { key, line: eventLineOf(event), isCurrent: isCurrentOf(event, key, home) };
      });
      const outcomes = await queue.enqueueBatch(orchestrator.id, batch, items, handle as never);
      const done: PublishResult = { status: "done", published: [], skipped };
      outcomes.forEach((outcome, index) => {
        const key = fresh[index]!.key;
        if (outcome === "sent" || outcome === "queued") done.published.push(key);
        else skipped.push(key);
      });
      return done;
    } catch (error) {
      log(`[paseo-bm] publishing events to the Orchestrator failed: ${describeError(error)}`);
      return result("failed");
    }
  }

  return {
    usePaseo(paseo) {
      if (isPaseo(paseo)) lastPaseo = paseo;
    },
    publish,
    turnRecorded(record, opened, paseo) {
      return publish([...decisionOpenedEventsOf(opened), ...requestFinishedEventsOf(record)], paseo);
    },
    workerTurnEnded(workerId) {
      for (const [key, worker] of openSignals) if (worker === workerId) openSignals.delete(key);
    },
    isSignalOpen: (key) => openSignals.has(key),
  };
}
