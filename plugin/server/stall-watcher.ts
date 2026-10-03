/**
 * The stall pass (Orchestrator design §6, REQ-073; autonomy design §A.8): once
 * a minute it looks for paseo-bm requests that stopped moving, keeps one
 * `request-stalled` **Inbox alert** per such request (`alert-store.ts`), and
 * for a project in the policy's scope (a class above `owner`, `eventScopeOf`)
 * publishes a `request.stalled` event to the Orchestrator (`event-bus.ts`). It
 * never messages the owner.
 *
 * - **Always on.** The Watch for stalled work switch is gone (§A.8): the pass
 *   costs no token (no timeline read, no model call), and a stalled request
 *   is data the Inbox shows. `start()` at plugin load, `stop()` at unload; the
 *   timer is `unref`ed. A pass that is under way when the timer stops writes
 *   and publishes nothing more.
 * - **One pass at a time**, every 60 seconds: `agents.list` once; the trace
 *   store of every workspace that saw a turn in the last 24 hours, rebuilt
 *   with `workspaceTracesOf`; **every** request with activity in those 24
 *   hours — a Manager often runs several at once.
 * - **Why a request stalls** (`stallReasonsOf`, pure), never while a Worker or
 *   a Reviewer of the request is `running` (the Manager is left out: it is
 *   shared by every request of its workspace): `idle-unfinished` — the last
 *   report is not `finished`, the request waits on no decision of the owner,
 *   and nothing happened for 5 minutes; `review-over-budget` —
 *   `review.over-budget` is raised, against the owner's review budget per tier
 *   (Settings → Coordination, §G.7), and the last report is not `finished`.
 *   **Waiting on the owner is read from the decision store, never from what an
 *   agent says** (ADR-024): a request with an unsettled decision (`q:`, `o:`,
 *   `h:`, `f:`) is not stalled — it waits in the Inbox; a `blocked` report
 *   whose questions are all answered, or a question asked only in chat words,
 *   waits on nobody the Inbox shows, so it stalls like any other idle request.
 *   When the store cannot be read, a `blocked` report counts as waiting, as
 *   before. A request the Manager answered itself (no Worker, no report)
 *   never stalls.
 * - **Once per stall.** The alert is raised once while it holds and cleared
 *   when it no longer does (an agent runs, a new report arrives, the request
 *   leaves the 24-hour window or its trace is deleted); raised afresh after
 *   that. Only the pass that raises it publishes the event, and the event is
 *   dropped if the alert is cleared before the Orchestrator is idle.
 * - **The live watch of running Workers** (design §6B.3, `worker-watch.ts`)
 *   rides on the same timer: every second tick (2 minutes) a Worker pass of
 *   its own, never overlapping another Worker pass, looks at the running
 *   Workers of every project. `workerTurnEnded` clears a Worker's
 *   alerts and settles its events when the collector records the end of its
 *   turn.
 *
 * The plugin server has no Paseo handle of its own: `usePaseo` keeps the last
 * one a hook or an `orchestrator.*` call brought (index.server.ts). A pass
 * before any handle arrived does nothing.
 *
 * Nothing here throws into the plugin: a failure is one log line and the next
 * pass tries again.
 */
import { join } from "node:path";
import { readReviewBudget } from "./coordination-rpc";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import type { DashboardPaseo } from "./paseo-directory";
import { createAlertStore } from "./alert-store";
import { createDecisionStore } from "./decision-store";
import { isAnswerable } from "../shared/decisions";
import { createEventBus, eventScopeOf, type BmEvent, type EventBus, type StallReason } from "./event-bus";
import { agentsOf, type OrchestratorStatePaseo } from "./orchestrator-state";
import { lastActivityOf, recentWorkspacesOf, requestKeyOf, ruleInputOf, workspaceTracesOf } from "./request-trace";
import { ruleReviewGrantOf } from "./review-tools";
import type { TraceStoreLocation } from "./trace-store";
import type { AgentFacts, ReconstructedTrace } from "./traces";
import { flagsOf, type Flag } from "../shared/orchestrator-rules";
import { roleOfProvider } from "./agent-role";
import { WORKER_PASS_MS, clearWorkerTurnSignals, runWorkerPass, workerPassResult, type PermissionFirstSeen, type WorkerPassResult } from "./worker-watch";
import { errorText } from "./rpc-kit";
import { timeOrZero } from "../shared/time";

/** How often a pass runs (design §6). */
export const STALL_PASS_MS = 60_000;
/** `idle-unfinished`: nothing happened for this long (design §6). */
export const IDLE_UNFINISHED_MS = 5 * 60_000;
/** Only workspaces and requests with activity in this window are looked at (design §6). */
export const STALL_WINDOW_MS = 24 * 3_600_000;

// ---------------------------------------------------------------------------
// Why a request stalls (pure).
// ---------------------------------------------------------------------------

/** A reason that holds now, and since when. */
export interface HeldStall {
  reason: StallReason;
  since: string;
}

/**
 * The reasons one request is stalled at `now` (autonomy design §A.8), in the
 * order of `STALL_REASONS`. `agents` gives the live status of its Workers and
 * Reviewers — the Manager's is not looked at, since it serves every request of
 * its workspace; `flags` are the rules' flags for the request. `waitsOnOwner`
 * is whether the request has an unsettled decision in the decision store;
 * `null` when the store could not be read, and then a `blocked` report counts
 * as waiting on the owner (ADR-024). Pure.
 */
export function stallReasonsOf(
  trace: ReconstructedTrace,
  agents: ReadonlyMap<string, AgentFacts>,
  flags: readonly Flag[],
  now: Date,
  waitsOnOwner: boolean | null = null,
): HeldStall[] {
  if ([...trace.workerIds, ...trace.reviewerIds].some((id) => agents.get(id)?.status === "running")) return [];
  // No Worker and no report: the Manager answered itself; nothing was handed over to stall.
  if (trace.workerIds.length === 0 && trace.reports.length === 0) return [];

  const phase = trace.reports.at(-1)?.phase ?? null;
  const lastActivityAt = lastActivityOf(trace);
  const held: HeldStall[] = [];
  const waiting = waitsOnOwner ?? phase === "blocked";
  if (phase !== "finished" && !waiting && now.getTime() - timeOrZero(lastActivityAt) >= IDLE_UNFINISHED_MS) {
    held.push({ reason: "idle-unfinished", since: lastActivityAt });
  }
  if (phase !== "finished" && flags.some((flag) => flag.state === "raised" && flag.rule === "review.over-budget")) {
    held.push({ reason: "review-over-budget", since: lastActivityAt });
  }
  return held;
}

/**
 * The requests of a workspace that wait on the owner: those with an unsettled
 * decision of any kind. Null when the decision store cannot be read.
 */
function unsettledRequestsOf(home: string, workspaceId: string, log: (message: string) => void): Set<string> | null {
  try {
    const waiting = new Set<string>();
    for (const decision of createDecisionStore(home).list({ workspaceId })) {
      if (decision.requestId !== null && isAnswerable(decision)) waiting.add(decision.requestId);
    }
    return waiting;
  } catch (error) {
    log(`[paseo-bm] the stall pass could not read the decisions of workspace ${workspaceId}: ${errorText(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The watcher.
// ---------------------------------------------------------------------------

/** The SDK slice a pass uses; `PaseoApi` is structurally assignable. */
export type StallWatcherPaseo = OrchestratorStatePaseo;

export interface StallWatcherDeps extends DataHomeDeps {
  now?: () => Date;
  /** Where the events go; a bus of its own by default. */
  bus?: Pick<EventBus, "publish" | "workerTurnEnded">;
  /** Milliseconds between passes; `STALL_PASS_MS` by default. */
  intervalMs?: number;
  /** Milliseconds between Worker passes (design §6B.3), a multiple of `intervalMs`; `WORKER_PASS_MS` by default. */
  workerIntervalMs?: number;
  /** Secrets to mask in an alert's detail; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /**
   * Whether the Orchestrator has lost its tools (design §5.1), for the bus
   * this watcher makes when none is given.
   */
  isToolsStale?: (agent: { id: string; createdAt: string | null }) => boolean;
  /**
   * Runs with the handle before each Worker pass (autonomy design §D.2: the
   * action boundary's scan of pending requests), so the watch reads what it
   * left. A failure is logged; the pass goes on.
   */
  beforeWorkerPass?: (handle: StallWatcherPaseo) => Promise<unknown>;
}

/** What one pass did, for the tests and the log. */
export interface StallPassResult {
  status: "done" | "busy" | "no-paseo" | "no-data-folder" | "off" | "failed";
  /** Alert keys raised by this pass. */
  raised: string[];
  /** Alert keys cleared by this pass. */
  cleared: string[];
  /** The events this pass handed to the event bus. */
  events: BmEvent[];
}

export interface StallWatcher {
  /** Starts the timer (plugin load); a second call changes nothing. */
  start(): void;
  /** Stops the timer; a pass under way writes and publishes nothing more. */
  stop(): void;
  /** True while the timer is set. */
  isRunning(): boolean;
  /** Keeps the handle a hook or RPC context brought; anything that is not one is ignored. */
  usePaseo(paseo: unknown): void;
  /** One pass now (the timer calls this). Never rejects. */
  pass(): Promise<StallPassResult>;
  /** One Worker pass now (design §6B.3; the timer calls this every `workerIntervalMs`). Never rejects. */
  workerPass(): Promise<WorkerPassResult>;
  /**
   * A recorded turn end (the collector's `onRecorded`): when it is a Beads
   * Worker's, its alerts are cleared and its events settled. Returns the
   * cleared alert keys. Never throws.
   */
  workerTurnEnded(agent: { id?: unknown; provider?: unknown } | null | undefined): string[];
}

function isPaseo(value: unknown): value is StallWatcherPaseo {
  const candidate = value as { agents?: { list?: unknown; ref?: unknown }; workspaces?: { list?: unknown } } | null | undefined;
  return (
    typeof candidate?.agents?.list === "function" &&
    typeof candidate?.agents?.ref === "function" &&
    typeof candidate?.workspaces?.list === "function"
  );
}

const result = (status: StallPassResult["status"]): StallPassResult => ({ status, raised: [], cleared: [], events: [] });

export function createStallWatcher(deps: StallWatcherDeps = {}): StallWatcher {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const intervalMs = deps.intervalMs ?? STALL_PASS_MS;
  const bus = deps.bus ?? createEventBus({ ...deps, log, now });
  /** The Worker pass runs on every n-th tick of the one timer. */
  const workerEvery = Math.max(1, Math.round((deps.workerIntervalMs ?? WORKER_PASS_MS) / intervalMs));
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticks = 0;
  let paseo: StallWatcherPaseo | null = null;
  let passing = false;
  let workerPassing = false;
  /** When each pending permission was first seen (design §6B.3), across Worker passes. */
  const permissionsSeen: PermissionFirstSeen = new Map();
  /** Moves on every stop, so a pass that began before it knows to write nothing more. */
  let epoch = 0;

  const homeOf = (): string | null => {
    try {
      return resolveDataHome(deps).home;
    } catch {
      return null;
    }
  };

  const start = (): void => {
    if (timer !== null) return;
    ticks = 0;
    timer = setInterval(() => {
      void pass();
      ticks += 1;
      if (ticks % workerEvery === 0) void workerPass();
    }, intervalMs);
    timer.unref?.();
  };

  const stop = (): void => {
    epoch += 1;
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  async function run(handle: StallWatcherPaseo, home: string, live: () => boolean): Promise<StallPassResult> {
    const done = result("done");
    const at = now();
    const alerts = createAlertStore(home, { now });
    const scope = eventScopeOf(home, log);
    const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };
    const snapshot = await agentsOf(handle);
    if (!live()) return result("off");
    const since = at.getTime() - STALL_WINDOW_MS;
    // The owner's budget, read once per pass (an unreadable store reads 2 / 2 / 4).
    const facts = { reviewBudget: readReviewBudget({ home, log }) };
    const examined = new Set<string>();
    /** Workspaces whose open alerts stay as they are: unreadable ones. */
    const untouched = new Set<string>();

    // A workspace the store did not see in 24 hours has no request in the window.
    for (const { workspaceId } of recentWorkspacesOf(location, since)) {
      if (!live()) return result("off");
      try {
        const { agents, traces, requests: registered } = await workspaceTracesOf(
          { location, paseo: handle as unknown as DashboardPaseo, home, allAgents: snapshot.bm },
          workspaceId,
        );
        if (!live()) return result("off");
        const waitingRequests = unsettledRequestsOf(home, workspaceId, log);
        for (const trace of traces) {
          // The group of agents linked to no request has no Manager to name.
          if (trace.managerAgentId === null || timeOrZero(lastActivityOf(trace)) < since) continue;
          const requestKey = requestKeyOf(trace);
          examined.add(`${workspaceId}::${requestKey}`);
          const waitsOnOwner = waitingRequests === null ? null : trace.requestId !== null && waitingRequests.has(trace.requestId);
          // Design §16.8: the request's review-budget grants, read as the review tools enforce them.
          const request = trace.requestId === null ? undefined : registered.find((entry) => entry.requestId === trace.requestId);
          const grant = request === undefined ? undefined : ruleReviewGrantOf(request);
          const held = stallReasonsOf(trace, agents, flagsOf(ruleInputOf(trace, grant), facts), at, waitsOnOwner);
          if (held.length === 0) {
            done.cleared.push(...alerts.clearWhere((alert) => alert.kind === "request-stalled" && alert.workspaceId === workspaceId && alert.subject === requestKey));
            continue;
          }
          const raised = alerts.raise({
            workspaceId,
            kind: "request-stalled",
            subject: requestKey,
            detail: held.map((entry) => entry.reason).join(", "),
          });
          if (!raised.raised) continue;
          done.raised.push(raised.alert.key);
          if (!scope.has(workspaceId)) continue;
          done.events.push({
            type: "request.stalled",
            workspaceId,
            requestKey,
            managerId: trace.managerAgentId,
            reason: held[0]!.reason,
            alertKey: raised.alert.key,
            since: raised.alert.since,
          });
        }
      } catch (error) {
        untouched.add(workspaceId);
        log(`[paseo-bm] the stall pass could not look at workspace ${workspaceId}: ${errorText(error)}`);
      }
    }

    // A request that left the window, or whose trace was deleted, is no longer stalled.
    if (!live()) return done;
    done.cleared.push(
      ...alerts.clearWhere(
        (alert) =>
          alert.kind === "request-stalled" &&
          !(alert.workspaceId !== null && untouched.has(alert.workspaceId)) &&
          !examined.has(`${alert.workspaceId}::${alert.subject}`),
      ),
    );
    if (done.events.length > 0) await bus.publish(done.events, handle, snapshot.orchestrator);
    return done;
  }

  async function pass(): Promise<StallPassResult> {
    if (passing) return result("busy");
    const handle = paseo;
    if (handle === null) return result("no-paseo");
    const home = homeOf();
    if (home === null) return result("no-data-folder");
    passing = true;
    const started = epoch;
    try {
      return await run(handle, home, () => epoch === started);
    } catch (error) {
      log(`[paseo-bm] a stall pass failed: ${errorText(error)}`);
      return result("failed");
    } finally {
      passing = false;
    }
  }

  async function workerPass(): Promise<WorkerPassResult> {
    if (workerPassing) return workerPassResult("busy");
    const handle = paseo;
    if (handle === null) return workerPassResult("no-paseo");
    const home = homeOf();
    if (home === null) return workerPassResult("no-data-folder");
    workerPassing = true;
    const started = epoch;
    try {
      if (deps.beforeWorkerPass !== undefined) {
        try {
          await deps.beforeWorkerPass(handle);
        } catch (error) {
          log(`[paseo-bm] the step before a Worker watch pass failed: ${errorText(error)}`);
        }
      }
      return await runWorkerPass(handle, home, () => epoch === started, { ...deps, log, now, bus }, permissionsSeen);
    } catch (error) {
      log(`[paseo-bm] a Worker watch pass failed: ${errorText(error)}`);
      return workerPassResult("failed");
    } finally {
      workerPassing = false;
    }
  }

  function workerTurnEnded(agent: { id?: unknown; provider?: unknown } | null | undefined): string[] {
    if (roleOfProvider(agent?.provider) !== "worker" || typeof agent?.id !== "string" || agent.id === "") return [];
    bus.workerTurnEnded(agent.id);
    const home = homeOf();
    if (home === null) return [];
    try {
      return clearWorkerTurnSignals(home, agent.id, { now });
    } catch (error) {
      log(`[paseo-bm] the Worker watch could not clear the alerts of ${agent.id}: ${errorText(error)}`);
      return [];
    }
  }

  return {
    start,
    stop,
    isRunning: () => timer !== null,
    usePaseo(value) {
      if (isPaseo(value)) paseo = value;
    },
    pass,
    workerPass,
    workerTurnEnded,
  };
}
