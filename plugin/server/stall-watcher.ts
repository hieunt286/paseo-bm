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
 *   `review.over-budget` is raised, against the request's review cap
 *   (`reviewCapOf`, delivery line design §5.3), and the last report is not `finished`.
 *   **Waiting on the owner is read from the decision store, never from what an
 *   agent says** (ADR-024): a request with an unsettled decision (`q:`, `o:`,
 *   `h:`, `f:`) is not stalled — it waits in the Inbox; a `blocked` report
 *   whose questions are all answered, or a question asked only in chat words,
 *   waits on nobody the Inbox shows, so it stalls like any other idle request.
 *   When the store cannot be read, a `blocked` report counts as waiting, as
 *   before. A request the Manager answered itself (no Worker, no report)
 *   never stalls.
 * - **Waiting on another project** (design §7.17.5): the link store is read
 *   once per pass; a `blocked` request whose live links it asked carry
 *   `waitingSince` from that report (`waitedLinksOf`) waits, as on the owner,
 *   until each waited link passes its ceiling (`peerCeilingOf`: taken but no
 *   live agent of the answering request, or `PEER_SILENT_MS` without a word
 *   from the answering side). One `peer-unanswered` alert per asking request
 *   names its links past the ceiling and those `open` for
 *   `PEER_UNANSWERED_MS` without a word from the answering side
 *   (`unansweredOf`); it clears when none is left (taken, answered, closed or
 *   answered on), and an asking request whose newest report is `finished` or
 *   `stopped` has none (it waits on nobody). No event: the Inbox shows it.
 * - **Waits by structure** (delivery line design §6.5): a request whose
 *   structured wait (`waiting`, design §6.2) has every unsettled item live —
 *   an open question, a running Reviewer or a call younger than the pending
 *   window, an active request with a live Worker, a link under its ceiling —
 *   waits (`structuralWaitOf`): no `idle-unfinished`, no event, no re-wake.
 *   Before it looks at any request, each pass settles the **dead** items as
 *   facts — a Reviewer gone with no verdict, an awaited request stopped,
 *   finished or with no live Worker left, a link answered, closed or past its
 *   ceiling (`settleDeadWaitItems`, `waits.ts`) — and hands the waits it
 *   changed to `onWaitsSettled`, the release that wakes the Worker once
 *   (design §6.4). An item settles once, so it wakes once.
 * - **Once per stall.** The alert is raised once while it holds and cleared
 *   on progress (`progressSinceOf`, delivery line design §8.4: a report, a
 *   review result, a bead closed), once the request waits on the owner or
 *   another project, or when it leaves the 24-hour window or its trace is
 *   deleted — never because one of its agents ran; raised afresh after that. Only the pass that raises it publishes the event, and the event is
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
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import type { DashboardPaseo } from "./paseo-directory";
import { createAlertStore } from "./alert-store";
import { createDecisionStore } from "./decision-store";
import { isAnswerable } from "../shared/decisions";
import { createEventBus, eventScopeOf, type BmEvent, type EventBus, type StallReason } from "./event-bus";
import { agentsOf, type OrchestratorStatePaseo } from "./orchestrator-state";
import { lastActivityOf, recentWorkspacesOf, requestKeyOf, ruleInputOf, waitedLinksOf, workspaceTracesOf } from "./request-trace";
import { createPeerLinkStore, isLiveLink, type PeerLink } from "./peer-links";
import { repoKeysIn } from "./placements";
import { ruleReviewGrantOf } from "./review-tools";
import type { TraceStoreLocation } from "./trace-store";
import type { AgentFacts, ReconstructedTrace } from "./traces";
import { flagsOf, type Flag } from "../shared/orchestrator-rules";
import { roleOfProvider } from "./agent-role";
import { isPluginHome } from "./plugin-homes";
import { WORKER_PASS_MS, clearWorkerTurnSignals, runWorkerPass, workerPassResult, type PermissionFirstSeen, type WorkerPassResult } from "./worker-watch";
import { errorText } from "./rpc-kit";
import { settleDeadWaitItems, waitFactsOf, type DeadWaitFacts, type SettledWait } from "./waits";
import { structuralWaitOf, type WaitQuestionFact } from "../shared/structural-wait";
import { createRequestRegistry } from "./request-registry";
import { PENDING_TTL_MS } from "./agent-bindings";
import type { ChannelQueue } from "./main-channel";
import { timeOrZero } from "../shared/time";
import { alertKeyOf } from "../shared/alerts";
import { andChainOf, brActions, shellSucceeded } from "../shared/shell";

/** How often a pass runs (design §6). */
export const STALL_PASS_MS = 60_000;
/** `idle-unfinished`: nothing happened for this long (design §6). */
export const IDLE_UNFINISHED_MS = 5 * 60_000;
/** Only workspaces and requests with activity in this window are looked at (design §6). */
export const STALL_WINDOW_MS = 24 * 3_600_000;
/** A waited link with no word from the answering side for this long stops counting as a wait (design §7.17.5). */
export const PEER_SILENT_MS = 2 * 3_600_000;
/** An `open` link with no word from the answering side for this long raises `peer-unanswered` (design §7.17.5). */
export const PEER_UNANSWERED_MS = 10 * 60_000;

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
 * as waiting on the owner (ADR-024). `waitsOnPeer`: the request waits on a
 * link within its ceiling (design §7.17.5). `waitsByStructure`: its
 * structured wait holds on live items (`structuralWaitOf`, delivery line
 * design §6.5). Pure.
 */
export function stallReasonsOf(
  trace: ReconstructedTrace,
  agents: ReadonlyMap<string, AgentFacts>,
  flags: readonly Flag[],
  now: Date,
  waitsOnOwner: boolean | null = null,
  waitsOnPeer = false,
  waitsByStructure = false,
): HeldStall[] {
  if ([...trace.workerIds, ...trace.reviewerIds].some((id) => agents.get(id)?.status === "running")) return [];
  // No Worker and no report: the Manager answered itself; nothing was handed over to stall.
  if (trace.workerIds.length === 0 && trace.reports.length === 0) return [];

  const phase = trace.reports.at(-1)?.phase ?? null;
  const lastActivityAt = lastActivityOf(trace);
  const held: HeldStall[] = [];
  const waiting = (waitsOnOwner ?? phase === "blocked") || waitsOnPeer || waitsByStructure;
  if (phase !== "finished" && !waiting && now.getTime() - timeOrZero(lastActivityAt) >= IDLE_UNFINISHED_MS) {
    held.push({ reason: "idle-unfinished", since: lastActivityAt });
  }
  if (phase !== "finished" && flags.some((flag) => flag.state === "raised" && flag.rule === "review.over-budget")) {
    held.push({ reason: "review-over-budget", since: lastActivityAt });
  }
  return held;
}

/**
 * Whether the request made progress after `since` (delivery line design §8.4):
 * a report, a review result, or a bead closed (a successful `br close`, or a
 * report naming closed beads). A turn that only ran is none. Pure.
 */
export function progressSinceOf(trace: Pick<ReconstructedTrace, "records" | "reports" | "reviews">, since: string): boolean {
  const after = (at: string | null): boolean => timeOrZero(at) > timeOrZero(since);
  if (trace.reports.some((report) => after(report.at))) return true;
  if (trace.reviews.some((review) => review.verdict !== null && after(review.at))) return true;
  return trace.records.some(
    (record) =>
      after(record.endedAt) &&
      record.evidence.some(
        (evidence) =>
          evidence.kind === "shell" &&
          shellSucceeded(evidence.status ?? null, evidence.exitCode ?? null) &&
          andChainOf(evidence.detail) !== null &&
          brActions(evidence.detail).some((action) => action.verb === "close" && action.ids.length > 0),
      ),
  );
}

/**
 * Why a waited link no longer counts as a wait at `now` (design §7.17.5), or
 * null while it does: it is `taken` but `answering` finds no live agent of
 * the answering request, or nothing came from the answering side for
 * `PEER_SILENT_MS` since the wait began or its last word. Pure.
 */
export function peerCeilingOf(link: PeerLink, now: Date, answering: (link: PeerLink) => boolean): string | null {
  if (link.state === "taken" && !answering(link)) {
    return `${link.linkId}: taken by request ${link.to.requestId ?? "?"} of project ${link.to.workspaceId}, which has no live agent`;
  }
  const heard = Math.max(timeOrZero(link.waitingSince), ...link.messages.filter((entry) => entry.side === "answerer").map((entry) => timeOrZero(entry.at)));
  return now.getTime() - heard >= PEER_SILENT_MS ? `${link.linkId}: no word from project ${link.to.workspaceId} for 2 hours` : null;
}

/** Why a live link raises `peer-unanswered` on its own (design §7.17.5): `open` for `PEER_UNANSWERED_MS` with no word from the answering side; else null. Pure. */
export function unansweredOf(link: PeerLink, now: Date): string | null {
  if (link.state !== "open" || now.getTime() - timeOrZero(link.createdAt) < PEER_UNANSWERED_MS) return null;
  if (link.messages.some((entry) => entry.side === "answerer")) return null;
  return `${link.linkId}: project ${link.to.workspaceId} has not taken it for 10 minutes`;
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

/**
 * What a question of a structured wait is now (delivery line design §6.5):
 * `open` while answerable, `closed` once settled, null when the decision
 * store does not hold it or cannot be read. The store is opened once.
 */
function questionStateOf(home: string, log: (message: string) => void): (decisionId: string) => WaitQuestionFact | null {
  let store: ReturnType<typeof createDecisionStore> | null = null;
  return (decisionId) => {
    try {
      store ??= createDecisionStore(home, { log });
      const decision = store.get(decisionId);
      return decision === null ? null : isAnswerable(decision) ? "open" : "closed";
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// The watcher.
// ---------------------------------------------------------------------------

/** The SDK slice a pass uses; `PaseoApi` is structurally assignable. */
export type StallWatcherPaseo = OrchestratorStatePaseo;

export interface StallWatcherDeps extends DataHomeDeps {
  now?: () => Date;
  /** Where the events go; a bus of its own by default. */
  bus?: Pick<EventBus, "publish">;
  /** Milliseconds between passes; `STALL_PASS_MS` by default. */
  intervalMs?: number;
  /** Milliseconds between Worker passes (design §6B.3), a multiple of `intervalMs`; `WORKER_PASS_MS` by default. */
  workerIntervalMs?: number;
  /** Secrets to mask in an alert's detail; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** How the Worker pass tells a Main of its Worker's danger (`BM-SIGNAL`, missions design §20); the shared notice queue by default. */
  signalQueue?: ChannelQueue;
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
  /** Runs with the handle before each pass (design §7.17.7: the hook bindings' recovery). A failure is logged; the pass goes on. */
  beforePass?: (handle: StallWatcherPaseo) => Promise<unknown>;
  /**
   * The release (delivery line design §6.4, §6.5): the waits this pass
   * settled dead items in, each with whether it is now met, so the Worker is
   * woken once with their facts. Called only when some wait changed; absent:
   * the items are settled and nobody is woken here. A failure is logged.
   */
  onWaitsSettled?: (settled: SettledWait[], handle: StallWatcherPaseo) => Promise<unknown> | unknown;
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
    // The owner's review settings for the cap (delivery line design §5.3), read once per pass (an unreadable store reads the defaults).
    const facts = { review: readCoordinationSettings({ home, log }).review };
    const examined = new Set<string>();
    /** Workspaces whose open alerts stay as they are: unreadable ones. */
    const untouched = new Set<string>();
    // The link store, read once per pass (design §7.17.5), and the live agents of each request.
    const peerLinks = createPeerLinkStore(home).list();
    // A link's `to` is a repo key (delivery line design §3.1): a request is found by its repo.
    const keyOf = repoKeysIn(home);
    const liveAgents = new Set(
      snapshot.bm
        .filter(({ facts }) => !facts.archived && facts.status !== "closed" && (facts.replacedBy ?? null) === null)
        .flatMap(({ workspaceId, facts }) => [facts.id, ...(facts.requestIdLabel === null || facts.role === "manager" ? [] : [`${workspaceId === null ? null : keyOf(workspaceId)}::${facts.requestIdLabel}`])]),
    );
    const answering = (link: PeerLink): boolean =>
      (link.to.workerId !== null && liveAgents.has(link.to.workerId)) || liveAgents.has(`${keyOf(link.to.workspaceId)}::${link.to.requestId}`);
    const running = new Set(snapshot.bm.filter(({ facts }) => facts.status === "running").map(({ facts }) => facts.id));
    const deadWaitFacts: DeadWaitFacts = {
      links: peerLinks,
      ceilingOf: (link) => peerCeilingOf(link, at, answering),
      isLive: (agentId) => liveAgents.has(agentId),
      isRunning: (agentId) => running.has(agentId),
      question: questionStateOf(home, log),
      pendingMs: PENDING_TTL_MS,
    };

    // Delivery line design §6.5: dead wait items settle as facts first, so a wait is judged on what is left; the release wakes the Worker once.
    const settled = settleDeadWaitItems(home, deadWaitFacts, at.toISOString(), log);
    if (settled.length > 0 && deps.onWaitsSettled !== undefined) {
      try {
        await deps.onWaitsSettled(settled, handle);
      } catch (error) {
        log(`[paseo-bm] the stall pass could not release the waits it settled: ${errorText(error)}`);
      }
    }
    if (!live()) return result("off");
    const waitFacts = waitFactsOf(home, deadWaitFacts, at.toISOString(), createRequestRegistry(home, { log }));
    /** `peer-unanswered` per asking request: `<workspaceId>::<requestId>` → why, per link. */
    const unanswered = new Map<string, { workspaceId: string; requestId: string; why: Map<string, string> }>();
    /** The requests whose newest report is `finished` or `stopped`: `<workspaceId>::<requestId>`; they raise no `peer-unanswered`. */
    const ended = new Set<string>();
    const noteUnanswered = (link: PeerLink, why: string): void => {
      // A Main's ask of another mission has no asking request (missions design §2.6).
      if (link.from.requestId === null) return;
      const key = `${link.from.workspaceId}::${link.from.requestId}`;
      if (ended.has(key)) return;
      const entry = unanswered.get(key) ?? { workspaceId: link.from.workspaceId, requestId: link.from.requestId, why: new Map<string, string>() };
      if (!entry.why.has(link.linkId)) entry.why.set(link.linkId, why);
      unanswered.set(key, entry);
    };

    // A workspace the store did not see in 24 hours has no request in the window. A Main's turns are
    // traced under its home, never a project: its requests are watched in their repos (missions design §6).
    for (const { workspaceId } of recentWorkspacesOf(location, since)) {
      if (!live()) return result("off");
      if (isPluginHome(workspaceId, home)) continue;
      try {
        const { agents, traces, requests: registered } = await workspaceTracesOf(
          { location, paseo: handle as unknown as DashboardPaseo, home, allAgents: snapshot.bm },
          workspaceId,
        );
        if (!live()) return result("off");
        const waitingRequests = unsettledRequestsOf(home, workspaceId, log);
        for (const trace of traces) {
          const phase = trace.reports.at(-1)?.phase;
          if (trace.requestId !== null && (phase === "finished" || phase === "stopped")) ended.add(`${workspaceId}::${trace.requestId}`);
          // The group of agents linked to no request has no Manager to name.
          if (trace.managerAgentId === null || timeOrZero(lastActivityOf(trace)) < since) continue;
          const requestKey = requestKeyOf(trace);
          examined.add(`${workspaceId}::${requestKey}`);
          const waitsOnOwner = waitingRequests === null ? null : trace.requestId !== null && waitingRequests.has(trace.requestId);
          // Design §16.8, delivery line design §5.3: the request's grants and milestone batches, read as the review tools enforce them.
          const request = trace.requestId === null ? undefined : registered.find((entry) => entry.requestId === trace.requestId);
          const grant = request === undefined ? undefined : ruleReviewGrantOf(request);
          // Design §7.17.5: a wait on another project, until each waited link passes its ceiling.
          const waited = waitedLinksOf(trace, workspaceId, peerLinks);
          let withinCeiling = 0;
          for (const link of waited) {
            const ceiling = peerCeilingOf(link, at, answering);
            if (ceiling === null) withinCeiling += 1;
            else noteUnanswered(link, ceiling);
          }
          // Delivery line design §6.5: a structured wait whose every unsettled item is live.
          const byStructure = request !== undefined && structuralWaitOf(request, waitFacts).holds;
          // Delivery line design §2.7: a continued request stalls nothing; its work goes on as its continuation.
          const continued = request?.continuedBy !== undefined;
          const held = continued ? [] : stallReasonsOf(trace, agents, flagsOf(ruleInputOf(trace, grant), facts), at, waitsOnOwner, withinCeiling > 0, byStructure);
          if (held.length === 0) {
            // Delivery line design §8.4: an open alert clears only on progress, or once the request waits on the owner,
            // another project or live items by structure (§6.5) — never because one of its agents ran (a blocked request woken again and again).
            const phase = trace.reports.at(-1)?.phase ?? null;
            const waits = (waitsOnOwner ?? phase === "blocked") || withinCeiling > 0 || byStructure;
            const open = alerts.get(alertKeyOf("request-stalled", workspaceId, requestKey));
            const keep = open !== null && open.clearedAt === null && phase !== "finished" && !continued && !waits && !progressSinceOf(trace, open.since);
            if (!keep) done.cleared.push(...alerts.clearWhere((alert) => alert.kind === "request-stalled" && alert.workspaceId === workspaceId && alert.subject === requestKey));
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

    // Design §7.17.5: the links nobody on the answering side took or answered.
    if (!live()) return done;
    for (const link of peerLinks) {
      const why = isLiveLink(link) ? unansweredOf(link, at) : null;
      if (why !== null) noteUnanswered(link, why);
    }
    for (const entry of unanswered.values()) {
      const raised = alerts.raise({ workspaceId: entry.workspaceId, kind: "peer-unanswered", subject: entry.requestId, detail: [...entry.why.values()].join("; ") });
      if (raised.raised) done.raised.push(raised.alert.key);
    }
    done.cleared.push(
      ...alerts.clearWhere(
        (alert) =>
          alert.kind === "peer-unanswered" &&
          !(alert.workspaceId !== null && untouched.has(alert.workspaceId)) &&
          !unanswered.has(`${alert.workspaceId}::${alert.subject}`),
      ),
    );

    // A request that left the window, or whose trace was deleted, is no longer stalled.
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
      if (deps.beforePass !== undefined) {
        try {
          await deps.beforePass(handle);
        } catch (error) {
          log(`[paseo-bm] the step before a stall pass failed: ${errorText(error)}`);
        }
      }
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
    const home = homeOf();
    if (home === null) return [];
    try {
      return clearWorkerTurnSignals(home, agent.id, { now, log });
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
