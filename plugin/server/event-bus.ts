/**
 * The event bus to the Beads Orchestrator (autonomy design §A.8, REQ-115 b).
 *
 * Replaces earlier builds' one-notice-per-situation wake-ups (autonomy design
 * §A.14) with typed events, delivered in batches:
 *
 * | Event | Source | Settled (dropped before delivery) when |
 * |---|---|---|
 * | `decision.opened` | a new `q:` decision the materialiser opened (`decision-materialiser.ts`) or a new `f:` decision a fallback incident's listener opened (`fallback-rpc.ts`), by the owner's policy per cell (below): a decision asked of the Orchestrator, or a prediction asked of the challenger | the decision may no longer be decided (`decideRefusalOf`), or predicted (`predictionRefusalOf`) |
 * | `request.finished` | a `finished` report recorded in a Manager's turn (the collector's `onRecorded`) that shows work left, or leaves its request finished-unverified (Phase 3, design §C.3) | — (only its project leaving the scope) |
 * | `request.stalled` | the stall pass raised a `request-stalled` alert (`stall-watcher.ts`) | its alert is cleared |
 * | `worker.signal` | the live watch saw a signal (`worker-watch.ts`) | its alert is cleared (`stuck`, `permission`, `danger`), or the Worker's turn ended (`failing`, `heavy`, `outside`) |
 * | `advice.due` | a project's finished requests since its last advice reached Settings' `advice.everyFinished` (the `finished` reports of recorded Manager turns, counted in `advice-store.ts`; design §G.4) | advice was turned off (`advice.everyFinished` 0) |
 * | `threshold.crossed` (`compact`) | a recorded Manager's or Worker's turn crossing its compaction threshold (`compactCrossedEventOf`, design §G.7, change-008 C1) while compaction is on for its provider, the agent is below `compact.maxPerAgent` and no compaction of it is pending | compaction was turned off, or the agent compacted (or a compaction of it was requested) |
 * | `threshold.crossed` (`handoff`) | a recorded Worker's turn of an unfinished request whose tokens read since it started, or since its last handoff, reach `handoff.requestTokens` (`handoffCrossedEventOf`, design §G.6, §G.7, change-008 C1) while handoff is on, the request is below `handoff.maxPerRequest` and no handoff of it is pending | handoff was turned off, or the request was handed over (or a handoff of it was requested), or it finished |
 * | `writers.observed` | a recorded turn wrote a file another agent of its workspace wrote in an overlapping turn (`writers-watch.ts`, design §F.1), with its `writers-observed` alert | its alert is cleared (the later of the two requests finished) |
 *
 * - **Only what needs a judgement** (REQ-115 b, A-7): a decision wakes the
 *   Orchestrator only when the owner's policy asks it something of that
 *   decision (below) — never for release, data, security or cost, which are
 *   the owner's alone (X-4, REQ-121 c) and wait in the Inbox; a finished
 *   report wakes it only when it shows work left — ready beads, open review
 *   findings, blockers, or failing checks (`workLeftOf`) — or when its request
 *   is finished-unverified (design §C.3, Phase 3: code changed and not every
 *   check it names was detected), which the event then says. A clean finish
 *   was already proved by the Worker and its Reviewer; checking it again is a
 *   wake with nothing to do (measured 2026-09-29: 3 of 3 wakes of the S1/S7
 *   live check ended with no action).
 *
 * - **The policy's scope** (design §A.8, §B.2; change-007 C1).
 *   `request.finished`, `request.stalled`, `worker.signal` and
 *   `writers.observed` are published
 *   only for a project with a class above `owner` in the owner's policy
 *   (`projectsAboveOwner`), and dropped at delivery when that project fell
 *   back to all-`owner` meanwhile: elsewhere the Orchestrator acts only when
 *   the owner talks to it, and what needs the owner is in the Inbox
 *   (decisions, alerts). `decision.opened` is not scoped by it: it follows
 *   its own per-cell rule (`decisionOpenedEventsOf`); nor is `advice.due`,
 *   which every project with finished requests gets (design §G.4), nor
 *   `threshold.crossed`, whose scope is the owner's Settings (design §G.7).
 * - **`threshold.crossed`, per agent cycle** (design §G.5, §G.7; change-008
 *   C1, C2; bead `7gxw.10`). A recorded Manager's or Worker's turn crossing
 *   its compaction threshold (`compactCrossingOf`) — never a turn with a
 *   compaction, whose figure understates — raises one, keyed by the agent and
 *   its compactions so far, so each compaction starts a new cycle. A judgement
 *   wake: its line names `bm_compact`, and a declined one ends with a note.
 *   Its `handoff` kind (bead `7gxw.11`) is per request cycle: a Worker's turn
 *   whose request crosses `handoff.requestTokens` raises one keyed by the
 *   request and its handoffs so far; its line names `bm_handoff`.
 * - **`advice.due`, per project** (design §G.4, §G.7; PRD REQ-128). Each
 *   `finished` report of a recorded Manager turn counts its request toward
 *   its project, once per advice (`finishedRequestKeysOf`); when the count
 *   reaches `advice.everyFinished` (Settings → Coordination, default 5), the
 *   count starts again and one `advice.due` is published — a judgement wake:
 *   the Orchestrator reads `bm_findings` and asks the owner, with a prepared
 *   change on an option, about each finding worth acting on. 0 turns it off:
 *   nothing is counted, and a pending one is dropped at delivery.
 * - **`decision.opened`, per cell** (design §B.5, §B.9; change-007 C1). A
 *   decision the Orchestrator did not ask (`q:`, `f:`), still open, of a
 *   delegable class raises one exactly when:
 *   - its cell is `delegate` with the predictor `orchestrator`
 *     (`decideRefusalOf`): it asks for a decision (`asks: "decision"`), its
 *     line names `bm_decide`;
 *   - its cell is `owner` or `shadow` and the project's challenger is on
 *     (`predictionRefusalOf`): it asks for a prediction
 *     (`asks: "prediction"`), its line names `bm_predict`.
 *   Nothing else: not with the challenger off, not for a cell of the
 *   recommended predictor (answered at open, `policy-resolve.ts`), never for
 *   release, data, security or cost, never for the Orchestrator's own `o:`.
 *   It is published whatever the policy scope — a project whose cells are all
 *   `owner` included, which is every new project. A decision that waits for
 *   `bm_decide` and gets none simply stays open in the Inbox for the owner:
 *   nothing times out into an answer. One event per decision, one dedupe key.
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
 *   queue delivers anything else) its oldest open wake gets its end and that
 *   closing turn's tokens (change-007 C6, `closingTurnUsage`). Ids, times and
 *   counts only. A wake whose turn end came after a reload keeps no end. The
 *   events a wake carried stay in memory until that turn end
 *   (`wakeEventsOf`), so a command the Orchestrator sends in it is logged as
 *   the intervention on those events (design §G.3, `intervention-store.ts`).
 *
 * Nothing here throws into the plugin: a failure is one log line.
 */
import { join } from "node:path";
import { TRACES_DIR_NAME, resolveDataHome } from "./data-home";
import { createAdviceStore } from "./advice-store";
import { createAlertStore } from "./alert-store";
import { currentPolicy } from "./autonomy-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { usageOfSnapshot, type CollectorPaseo } from "./collector";
import { createCompactionStore, pendingCompactionOf, sentCompactionsOf } from "./compaction-store";
import { compactCrossingOf, compactionOnFor, handoffCrossingOf, type CoordinationRole, type CoordinationSettings, type ThresholdFigure } from "../shared/coordination";
import { requestFinishedOf, requestTokensReadOf } from "../shared/handoff";
import { createHandoffStore, handoffsDoneOf, lastHandoffAtOf, pendingHandoffOf } from "./handoff-store";
import { readRecords } from "./trace-store";
import { turnTokensOf } from "../shared/eval-metrics/tokens";
import { createDecisionStore } from "./decision-store";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticeQueue } from "./notice-queue";
import { EVENTS_NOTICE_MARKER } from "./notices";
import { wakeableOrchestrator, type OrchestratorAgentDeps, type OrchestratorAgentPaseo, type OrchestratorAgentSnapshot } from "./orchestrator-agent";
import { createOrchestratorStore } from "./orchestrator-store";
import { EMPTY_AUTONOMY_POLICY, decideRefusalOf, predictionRefusalOf, projectsAboveOwner, type AutonomyPolicy } from "../shared/autonomy";
import type { Decision } from "../shared/decisions";
import { namesFailingChecks } from "../shared/interventions";
import type { WakeUsage, WorkerSignal } from "../shared/orchestrator";
import type { ParsedReport, TraceRecord } from "../shared/contracts";
import { errorText } from "./rpc-kit";
import { timeOrNull } from "../shared/time";

/** Why a request stalled (design §A.8): nobody ran for 5 minutes, or the review went over its budget. */
export const STALL_REASONS = ["idle-unfinished", "review-over-budget"] as const;
export type StallReason = (typeof STALL_REASONS)[number];

export interface DecisionOpenedEvent {
  type: "decision.opened";
  workspaceId: string;
  requestId: string | null;
  decisionId: string;
  /** The Worker that asked, when known; null for a fallback incident. */
  askedBy: string | null;
  /**
   * What it asks of the Orchestrator (design §B.5, §B.9): `decision` — the
   * owner's policy delegates its class to the Orchestrator, which decides it
   * with `bm_decide`; `prediction` — the owner's answer predicted with
   * `bm_predict`. Every event asks one of them: events live in memory only,
   * so none of Phase 1's look (no `asks`) is left to read.
   */
  asks: "decision" | "prediction";
}

export interface RequestFinishedEvent {
  type: "request.finished";
  workspaceId: string;
  /** The request id, or null when the report named none. */
  requestId: string | null;
  managerId: string;
  /** When the report was recorded: one event per report. */
  at: string;
  /**
   * The finish is unverified (design §C.3): code changed and not every check
   * the report names was detected. Present only then; it does not change the
   * dedupe key.
   */
  unverified?: true;
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

/**
 * Advice is due for a project (design §G.4): its finished requests since its
 * last advice reached the cadence of Settings → Coordination.
 */
export interface AdviceDueEvent {
  type: "advice.due";
  workspaceId: string;
  /** The finished requests counted since the last advice: the count that reached the cadence. */
  finished: number;
  /** When the count reached it, the last counted report's time: one event per count. */
  at: string;
}

/**
 * A Manager's or a Worker's turn crossed a threshold of Settings →
 * Coordination (design §G.7, change-008 C1): for `compact`, the turn's tokens
 * read or its context share; for `handoff`, a Worker's request's tokens read
 * since it started or since its last handoff — against the owner's figure.
 */
export interface ThresholdCrossedEvent {
  type: "threshold.crossed";
  workspaceId: string;
  /** The Worker's request; null for a Manager's turn that named none. */
  requestId: string | null;
  agentId: string;
  role: CoordinationRole;
  kind: "compact" | "handoff";
  figure: ThresholdFigure;
  value: number;
  threshold: number;
  /** When the crossing turn ended. */
  at: string;
  /** `compact`: the agent's compactions so far (`sentCompactionsOf`); `handoff`: the request's handoffs so far (`handoffsDoneOf`). The event's cycle, one per cycle. */
  cycle: number;
}

/** One of the two turns of a `writers.observed` event. */
export interface ObservedWriter {
  agentId: string;
  role: TraceRecord["role"];
  /** The turn's request (`requestOfTurn`); null when not known. */
  requestId: string | null;
  /** When the turn started: with the agent, the turn's identity (Paseo reuses turn ids). */
  startedAt: string;
}

/**
 * Two agents of one project wrote the same file in overlapping turns (design
 * §F.1, REQ-161): detection only. One event per file and turn pair.
 */
export interface WritersObservedEvent {
  type: "writers.observed";
  workspaceId: string;
  /** The file, relative to the workspace folder. */
  file: string;
  /** The two turns, the earlier start first. */
  writers: [ObservedWriter, ObservedWriter];
  /** The file's `writers-observed` alert; the event is settled once it is cleared. */
  alertKey: string;
  /** When the later of the two turns ended: when the collision was seen. */
  at: string;
}

export type BmEvent = DecisionOpenedEvent | RequestFinishedEvent | RequestStalledEvent | WorkerSignalEvent | AdviceDueEvent | ThresholdCrossedEvent | WritersObservedEvent;

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
    case "advice.due":
      return `advice.due:${event.workspaceId}@${event.at}`;
    case "threshold.crossed":
      return `threshold.crossed:${event.kind}:${event.kind === "handoff" ? event.requestId : event.agentId}#${event.cycle}`;
    case "writers.observed":
      return `writers.observed:${event.workspaceId}:${event.file}:${event.writers.map((writer) => `${writer.agentId}@${writer.startedAt}`).join("+")}`;
  }
}

/** A crossing's figure in words: `it read 6,100,000 tokens in one turn (threshold 5,700,000)`. */
function crossingWords(event: Pick<ThresholdCrossedEvent, "figure" | "value" | "threshold">): string {
  const count = (value: number) => Math.round(value).toLocaleString("en-US");
  const share = (value: number) => `${Math.round(value * 100)} %`;
  switch (event.figure) {
    case "tokensPerTurn":
      return `it read ${count(event.value)} tokens in one turn (threshold ${count(event.threshold)})`;
    case "contextShare":
      return `its context filled ${share(event.value)} of its window (threshold ${share(event.threshold)})`;
    case "requestTokens":
      return `its request read ${count(event.value)} tokens (threshold ${count(event.threshold)})`;
  }
}

/** One short line per event: what happened, and the ids to look up (design §A.8). */
export function eventLineOf(event: BmEvent): string {
  const project = `project ${event.workspaceId}`;
  switch (event.type) {
    case "decision.opened": {
      const opened = `- decision.opened — ${project}, request ${event.requestId ?? "none"}, decision ${event.decisionId}${
        event.askedBy === null ? "" : `, asked by Worker ${event.askedBy}`
      }.`;
      if (event.asks === "decision") {
        return `${opened} A decision is asked: the owner's policy delegates its class to you. Read it with bm_decisions and choose the option the owner would, with bm_decide and your reason in one line.`;
      }
      return `${opened} A prediction is asked: read it with bm_decisions and give the option you expect the owner to choose with bm_predict. The owner decides it: answer nothing and tell the owner nothing.`;
    }
    case "request.finished": {
      const finished = `- request.finished — ${project}, request ${event.requestId ?? "not named"}, Manager ${event.managerId}, at ${event.at}`;
      if (event.unverified !== true) return `${finished}. Check it with bm_request.`;
      return `${finished}: finished — unverified, its code changed and not every check it names was seen to pass. Check it with bm_request; a commit or release on the owner's policy waits for the owner.`;
    }
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
    case "advice.due":
      return `- advice.due — ${project}, ${event.finished} requests finished since the last advice. Read its figures with bm_findings; for each finding worth acting on, ask the owner with bm_ask_owner, one option carrying the prepared change. With none worth it, keep a note with bm_note.`;
    case "threshold.crossed": {
      const crossed = `- threshold.crossed ${event.kind} — ${project}, ${event.role === "manager" ? "Manager" : "Worker"} ${event.agentId}, request ${event.requestId ?? "none"}, at ${event.at}: ${crossingWords(event)}.`;
      if (event.kind === "handoff") {
        return `${crossed} If a handoff to a new Worker is worth it, request it with bm_handoff; the plugin hands it over at that Worker's next safe point. Otherwise keep a note with bm_note.`;
      }
      return `${crossed} If a compaction is worth it, request it with bm_compact; the plugin runs it at that agent's next safe point. Otherwise keep a note with bm_note.`;
    }
    case "writers.observed": {
      const [first, second] = event.writers.map((writer) => `${WRITER_ROLE_WORDS[writer.role]} ${writer.agentId} (request ${writer.requestId ?? "not known"})`);
      return `- writers.observed — ${project}, file ${event.file}: ${first} and ${second} wrote it in overlapping turns, at ${event.at}. Check the file with bm_repo; if one change may have undone the other, tell that request's Manager with bm_send_command. Otherwise keep a note with bm_note.`;
    }
  }
}

/** A writer's role in an event line. */
const WRITER_ROLE_WORDS: Readonly<Record<TraceRecord["role"], string>> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  orchestrator: "Orchestrator",
  unknown: "agent",
};

/**
 * The `threshold.crossed` (`compact`) a recorded turn raises, or null (design
 * §G.7, change-008 C1, C2): a Manager's or a Worker's turn — never one with a
 * compaction, whose context figure understates (the check reads the NEXT turn,
 * spike run note 2026-09-30 §2) — that crosses its threshold
 * (`compactCrossingOf`: tokens read against the role's figure where the
 * provider counts the whole turn, else the context share), while compaction
 * is on for its provider (read from the turn, `turnTokensOf`), the agent is
 * below `compact.maxPerAgent` (`compactions`: its compactions so far) and no
 * compaction of it is `pending`. Pure.
 */
export function compactCrossedEventOf(
  record: TraceRecord | null | undefined,
  settings: Pick<CoordinationSettings, "compact">,
  agent: { compactions: number; pending: boolean },
): ThresholdCrossedEvent | null {
  if (record === null || record === undefined || (record.role !== "manager" && record.role !== "worker")) return null;
  if (record.evidence.some((evidence) => evidence.kind === "compaction")) return null;
  const turn = turnTokensOf(record);
  if (!compactionOnFor(settings, turn.provider === "unknown" ? null : turn.provider)) return null;
  if (agent.pending || agent.compactions >= settings.compact.maxPerAgent) return null;
  const crossing = compactCrossingOf(record.role, { coverage: turn.coverage, tokensRead: turn.tokensRead, contextShare: turn.contextShare }, settings);
  if (crossing === null) return null;
  return {
    type: "threshold.crossed",
    workspaceId: record.workspaceId,
    requestId: record.requestId,
    agentId: record.agentId,
    role: record.role,
    kind: "compact",
    ...crossing,
    at: record.endedAt ?? record.at,
    cycle: agent.compactions,
  };
}

/**
 * The `threshold.crossed` (`handoff`) a recorded turn raises, or null (design
 * §G.6, §G.7, change-008 C1): a Worker's turn of an unfinished request
 * (`finished` false) whose tokens read since it started, or since its last
 * handoff (`tokensRead`, `requestTokensReadOf`), reach `handoff.requestTokens`
 * (`handoffCrossingOf`), while handoff is on, the request is below
 * `handoff.maxPerRequest` (`handoffs`: its handoffs so far) and no handoff of
 * it is `pending`. Pure.
 */
export function handoffCrossedEventOf(
  record: TraceRecord | null | undefined,
  settings: Pick<CoordinationSettings, "handoff">,
  request: { tokensRead: number | null; handoffs: number; pending: boolean; finished: boolean },
): ThresholdCrossedEvent | null {
  if (record === null || record === undefined || record.role !== "worker" || record.requestId === null) return null;
  if (!settings.handoff.enabled || request.finished || request.pending || request.handoffs >= settings.handoff.maxPerRequest) return null;
  const crossing = handoffCrossingOf(request.tokensRead, settings);
  if (crossing === null) return null;
  return {
    type: "threshold.crossed",
    workspaceId: record.workspaceId,
    requestId: record.requestId,
    agentId: record.agentId,
    role: "worker",
    kind: "handoff",
    ...crossing,
    at: record.endedAt ?? record.at,
    cycle: request.handoffs,
  };
}

/**
 * The tokens of the Orchestrator turn that just ended (change-007 C6): the
 * input, cached and output tokens of its snapshot's `lastUsage`
 * (`usageOfSnapshot` says what they cover per provider), read with one small
 * `timeline.refetch` — the path the collector reads every other role's usage
 * by, since it records no Orchestrator turn. Null when there is no handle, the
 * call fails or the snapshot has no usage. Never throws.
 */
export async function closingTurnUsage(agentId: string, paseo: unknown): Promise<WakeUsage | null> {
  try {
    const timeline = (paseo as Partial<CollectorPaseo> | null | undefined)?.agents?.ref(agentId)?.timeline;
    if (typeof timeline?.refetch !== "function") return null;
    const payload = await timeline.refetch({ direction: "tail", limit: 1 });
    const usage = usageOfSnapshot((payload as { agent?: unknown } | null)?.agent);
    return usage === null ? null : { inputTokens: usage.inputTokens, cachedInputTokens: usage.cachedInputTokens, outputTokens: usage.outputTokens };
  } catch {
    return null;
  }
}

/** The one message that carries the lines pending at the Orchestrator's idle moment. */
export function eventsMessageOf(lines: readonly string[]): string {
  return [
    EVENTS_NOTICE_MARKER,
    `From the paseo-bm plugin, not the owner: ${lines.length} event${lines.length === 1 ? "" : "s"}, oldest first. Look before you act; when nothing needs doing, do nothing.`,
    ...lines,
  ].join("\n");
}

/**
 * `decision.opened` for each decision among `decisions` that needs the
 * Orchestrator, by the owner's `policy` per cell (design §B.5, §B.9;
 * change-007 C1), and for nothing else:
 *
 * - one delegated to it (`decideRefusalOf`: not its own, open, a delegable
 *   class `delegate` in its project with the predictor `orchestrator`) asks
 *   for a decision;
 * - one the challenger may predict (`predictionRefusalOf`: not its own, open,
 *   a delegable class in an `owner` or `shadow` cell, the project's challenger
 *   on) asks for a prediction, whatever else the project's policy holds.
 *
 * The two never both hold (a `delegate` cell is not predicted). Release,
 * data, security and cost — by a proposed class or an option's effect — wake
 * nobody. Pure.
 */
export function decisionOpenedEventsOf(decisions: readonly Decision[], policy: AutonomyPolicy = EMPTY_AUTONOMY_POLICY): DecisionOpenedEvent[] {
  return decisions.flatMap((decision): DecisionOpenedEvent[] => {
    const event: Omit<DecisionOpenedEvent, "asks"> = {
      type: "decision.opened",
      workspaceId: decision.workspaceId,
      requestId: decision.requestId,
      decisionId: decision.id,
      askedBy: decision.askedBy.agentId,
    };
    if (decideRefusalOf(policy, decision) === null) return [{ ...event, asks: "decision" }];
    if (predictionRefusalOf(policy, decision) === null) return [{ ...event, asks: "prediction" }];
    return [];
  });
}

/**
 * A report field that says nothing is there: empty, or starting with "none",
 * "no", "nothing", "n/a", "0" or a dash ("none. Suggestion: …" is still none).
 */
function saysNothing(value: string | null): boolean {
  if (value === null) return true;
  return /^\s*(?:$|(?:none|no|nothing|n\/a|0)\b|[-—])/i.test(value);
}

/**
 * Whether a `finished` report shows work left for a coordinator: ready beads,
 * open review findings, blockers, or failing checks (§A.8), read as the
 * intervention check reads them (`namesFailingChecks`). Pure.
 */
export function workLeftOf(report: TraceRecord["reports"][number]): boolean {
  return (
    report.beadsReady.length > 0 ||
    !saysNothing(report.reviewFindingsOpen) ||
    !saysNothing(report.blockers) ||
    (report.buildAndTests !== null && namesFailingChecks(report.buildAndTests))
  );
}

/**
 * `request.finished` for each `finished` report recorded in a Manager's turn
 * that shows work left (§A.8) or leaves its request finished-unverified
 * (design §C.3; `isUnverified`, read from the request's records by the caller,
 * `unverifiedFinishesOf`), which the event carries as `unverified: true`. Pure.
 */
export function requestFinishedEventsOf(
  record: TraceRecord | null | undefined,
  isUnverified: (report: ParsedReport) => boolean = () => false,
): RequestFinishedEvent[] {
  if (record === null || record === undefined || record.role !== "manager") return [];
  return record.reports.flatMap((report): RequestFinishedEvent[] => {
    if (report.phase !== "finished") return [];
    const unverified = isUnverified(report);
    if (!unverified && !workLeftOf(report)) return [];
    return [
      {
        type: "request.finished",
        workspaceId: record.workspaceId,
        requestId: report.requestId ?? record.requestId,
        managerId: record.agentId,
        at: report.at,
        ...(unverified ? { unverified: true as const } : {}),
      },
    ];
  });
}

/**
 * The finished requests of a recorded Manager turn, for the advice cadence
 * (design §G.4): one key per request that sent a `finished` report — its
 * request id, else the Manager and the report's time — with the latest such
 * report's time. Every finished report counts, work left or not. Pure.
 */
export function finishedRequestKeysOf(record: TraceRecord | null | undefined): { workspaceId: string; keys: string[]; at: string } | null {
  if (record === null || record === undefined || record.role !== "manager") return null;
  const finished = record.reports.filter((report) => report.phase === "finished");
  if (finished.length === 0) return null;
  const keys = [...new Set(finished.map((report) => report.requestId ?? record.requestId ?? `manager:${record.agentId}@${report.at}`))];
  const at = finished.map((report) => report.at).reduce((latest, next) => (Date.parse(next) > Date.parse(latest) ? next : latest));
  return { workspaceId: record.workspaceId, keys, at };
}

/**
 * The batch the notice queue merges the events into. A bus adds its own
 * `onSent`, which records the wake.
 */
export const EVENTS_BATCH: NoticeBatch = { name: EVENTS_NOTICE_MARKER, compose: eventsMessageOf };

/**
 * The owner's policy as the events read it, at each publish and delivery. A
 * policy that cannot be read is the empty policy — no project in the scope, no
 * challenger on: the safe side — with one log line. Never throws.
 */
export function eventPolicyOf(home: string, log: (message: string) => void = (message) => console.warn(message)): AutonomyPolicy {
  return currentPolicy(home, (reason) => log(`[paseo-bm] could not read the autonomy policy for the Orchestrator's events: ${reason}`));
}

/**
 * The projects whose `request.finished`, `request.stalled`, `worker.signal`
 * and `writers.observed` reach the Orchestrator (design §A.8 Scope,
 * change-007 C1; §F.1): those with a
 * class above `owner` in the owner's policy. A policy that cannot be read is
 * the empty scope, the safe side, with one log line. Never throws.
 */
export function eventScopeOf(home: string, log: (message: string) => void = (message) => console.warn(message)): Set<string> {
  return projectsAboveOwner(eventPolicyOf(home, log));
}

/**
 * Whether an event may reach the Orchestrator: `decision.opened` keeps its own
 * filter (change-007 C1), `advice.due` its cadence (design §G.4) and
 * `threshold.crossed` the owner's Settings (design §G.7); the others need
 * their project in `scope`.
 */
export function isInEventScope(event: BmEvent, scope: ReadonlySet<string>): boolean {
  return event.type === "decision.opened" || event.type === "advice.due" || event.type === "threshold.crossed" || scope.has(event.workspaceId);
}

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
  /** Event keys left out: not in the policy's scope, or already published. */
  skipped: string[];
}

export interface EventBus {
  /** Keeps the handle a hook or RPC context brought; anything that is not one is ignored. */
  usePaseo(paseo: unknown): void;
  /** Publishes events to the Orchestrator (in the policy's scope, `isInEventScope`). Never rejects. */
  publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult>;
  /**
   * One recorded turn (the collector's `onRecorded`): `decision.opened` for
   * the Worker questions it opened, by the owner's policy per cell
   * (`decisionOpenedEventsOf`), `request.finished` for its `finished` reports
   * (`isUnverified` tells a finished-unverified one, design §C.3),
   * `advice.due` when its finished requests bring the project's count to
   * the advice cadence (design §G.4), and `threshold.crossed` when a Manager's
   * or a Worker's turn crosses its compaction threshold (design §G.7) — one
   * publish, so they reach the Orchestrator together. Never rejects.
   */
  turnRecorded(
    record: TraceRecord | null | undefined,
    opened: readonly Decision[],
    paseo?: unknown,
    isUnverified?: (report: ParsedReport) => boolean,
  ): Promise<PublishResult>;
  /**
   * Decisions opened outside a recorded turn — a fallback incident's (`f:`,
   * `fallback-rpc.ts`): their `decision.opened`, by the same per-cell rule.
   * Never rejects.
   */
  decisionsOpened(opened: readonly Decision[], paseo?: unknown): Promise<PublishResult>;
  /** A Worker's turn ended: its `failing`, `heavy` and `outside` events are settled. */
  workerTurnEnded(workerId: string): void;
  /** True while this non-alert Worker-signal key is open (published in the Worker's current turn). */
  isSignalOpen(key: string): boolean;
  /**
   * The events of that Orchestrator's oldest open wake — the one whose turn is
   * running — oldest first; none outside a wake (design §G.3: which event a
   * command answers). Kept in memory beside the wake record, so a reload
   * forgets them.
   */
  wakeEventsOf(orchestratorId: string): readonly BmEvent[];
}

function isPaseo(value: unknown): value is OrchestratorAgentPaseo {
  const candidate = value as { agents?: { list?: unknown; ref?: unknown } } | null | undefined;
  return typeof candidate?.agents?.list === "function" && typeof candidate?.agents?.ref === "function";
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
      eventOfKey.delete(oldest);
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
      log(`[paseo-bm] could not record the Orchestrator's wake: ${errorText(error)}`);
    }
  };

  /**
   * That Orchestrator's turn after a `BM-EVENTS` message ended: its oldest open
   * wake ends now (A-7), with that turn's tokens (change-007 C6).
   */
  const endWake = async (targetId: string, paseo?: unknown): Promise<void> => {
    const home = homeOf();
    if (home === null) return;
    const usage = await closingTurnUsage(targetId, paseo);
    try {
      createOrchestratorStore(home, { now: deps.now }).endWake(targetId, usage);
    } catch (error) {
      log(`[paseo-bm] could not record the end of the Orchestrator's wake: ${errorText(error)}`);
    }
  };

  /** Published keys → their event until the wake that carried them went out, then each Orchestrator's open wakes, oldest first (§G.3). */
  const eventOfKey = new Map<string, BmEvent>();
  const openWakes = new Map<string, BmEvent[][]>();

  const batch: NoticeBatch = {
    ...EVENTS_BATCH,
    onSent: (targetId, keys) => {
      openWakes.set(targetId, [...(openWakes.get(targetId) ?? []), keys.flatMap((key) => eventOfKey.get(key) ?? [])]);
      for (const key of keys) eventOfKey.delete(key);
      recordWake(targetId, keys);
    },
    onTurnEnded: (targetId, paseo) => {
      const open = openWakes.get(targetId);
      open?.shift();
      if (open?.length === 0) openWakes.delete(targetId);
      return endWake(targetId, paseo);
    },
  };

  /**
   * Whether the event's subject still needs the Orchestrator: read
   * synchronously at the idle moment, the owner's policy once per check.
   */
  const isCurrentOf =
    (event: BmEvent, key: string, home: string) =>
    (): boolean => {
      const policy = eventPolicyOf(home, log);
      if (!isInEventScope(event, projectsAboveOwner(policy))) return false;
      switch (event.type) {
        case "decision.opened": {
          const decision = createDecisionStore(home, { log }).get(event.decisionId, event.workspaceId);
          if (decision === null) return false;
          // Dropped once it may no longer be asked: settled, its cell changed meanwhile (a
          // reset, a demotion), the challenger turned off, or the Orchestrator predicted it already.
          return (event.asks === "decision" ? decideRefusalOf(policy, decision) : predictionRefusalOf(policy, decision)) === null;
        }
        case "request.finished":
          return true;
        case "request.stalled":
          return createAlertStore(home).isOpen(event.alertKey);
        case "worker.signal":
          return event.alertKey === null ? openSignals.has(key) : createAlertStore(home).isOpen(event.alertKey);
        case "advice.due":
          // Dropped once the owner turned advice off.
          return readCoordinationSettings({ home, log }).advice.everyFinished > 0;
        case "threshold.crossed": {
          if (event.kind === "handoff") {
            // Dropped once the owner turned handoff off, or the request was handed over (or a handoff
            // of it was requested) or finished meanwhile.
            if (!readCoordinationSettings({ home, log }).handoff.enabled || event.requestId === null) return false;
            const handoffs = createHandoffStore(home).list();
            if (handoffsDoneOf(handoffs, event.requestId).length !== event.cycle) return false;
            if (pendingHandoffOf(handoffs, event.requestId, deps.now?.() ?? new Date()) !== null) return false;
            return !requestFinishedOf(readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, event.workspaceId).records, event.requestId);
          }
          // Dropped once the owner turned compaction off, or the agent compacted (its own, the owner's
          // or the plugin's) or a compaction of it was requested meanwhile.
          if (!readCoordinationSettings({ home, log }).compact.enabled) return false;
          if ((compactedAt.get(event.agentId) ?? Number.NEGATIVE_INFINITY) >= (timeOrNull(event.at) ?? Number.POSITIVE_INFINITY)) return false;
          const compactions = createCompactionStore(home).list();
          return sentCompactionsOf(compactions, event.agentId) === event.cycle && pendingCompactionOf(compactions, event.agentId, deps.now?.() ?? new Date()) === null;
        }
        case "writers.observed":
          // Dropped once its file's alert was cleared: the later of the two requests finished (design §F.3).
          return createAlertStore(home).isOpen(event.alertKey);
      }
    };

  async function publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult> {
    try {
      if (isPaseo(paseo)) lastPaseo = paseo;
      if (events.length === 0) return result("none");
      const home = homeOf();
      if (home === null) return result("no-data-folder");
      const scope = eventScopeOf(home, log);
      const skipped: string[] = [];
      const fresh: Array<{ event: BmEvent; key: string }> = [];
      for (const event of events) {
        const key = eventKeyOf(event);
        if (published.has(key) || fresh.some((entry) => entry.key === key) || !isInEventScope(event, scope)) skipped.push(key);
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
        eventOfKey.set(key, event);
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
      log(`[paseo-bm] publishing events to the Orchestrator failed: ${errorText(error)}`);
      return result("failed");
    }
  }

  /** `decision.opened` for new decisions: the policy decides which ask the Orchestrator something (§B.9); read only when one opened. */
  const openedEventsOf = (opened: readonly Decision[]): DecisionOpenedEvent[] => {
    const home = opened.length === 0 ? null : homeOf();
    return decisionOpenedEventsOf(opened, home === null ? EMPTY_AUTONOMY_POLICY : eventPolicyOf(home, log));
  };

  /**
   * Counts a recorded Manager turn's finished requests toward its project's
   * advice (design §G.4): `advice.due` when the count reaches the cadence,
   * which starts the count again in the same write. Nothing with advice off.
   * Never throws: a store failure is one log line and no event.
   */
  const adviceDueOf = (record: TraceRecord | null | undefined): AdviceDueEvent[] => {
    const finished = finishedRequestKeysOf(record);
    const home = finished === null ? null : homeOf();
    if (finished === null || home === null) return [];
    const everyFinished = readCoordinationSettings({ home, log }).advice.everyFinished;
    if (everyFinished === 0) return [];
    try {
      const counted = createAdviceStore(home).count(finished.workspaceId, finished.keys, everyFinished, finished.at);
      return counted.due ? [{ type: "advice.due", workspaceId: finished.workspaceId, finished: counted.finished, at: finished.at }] : [];
    } catch (error) {
      log(`[paseo-bm] could not count the finished requests toward the advice: ${errorText(error)}`);
      return [];
    }
  };

  /** Each agent's newest recorded compaction in this run, whoever started it: a crossing before it is dropped at delivery. */
  const compactedAt = new Map<string, number>();

  /**
   * The `threshold.crossed` of a recorded turn (design §G.7,
   * `compactCrossedEventOf`), with the owner's Settings and the agent's
   * compactions read from the data folder. Never throws: a store that cannot
   * be read is one log line and no event.
   */
  const thresholdCrossedOf = (record: TraceRecord | null | undefined): ThresholdCrossedEvent[] => [...compactCrossedOf(record), ...handoffCrossedOf(record)];

  /**
   * The `handoff` kind of a recorded Worker turn (design §G.6, §G.7,
   * `handoffCrossedEventOf`): its request's tokens read since it started or
   * since its last handoff, with the owner's Settings and the request's
   * handoffs read from the data folder. Read only while handoff is on. Never
   * throws: a store that cannot be read is one log line and no event.
   */
  const handoffCrossedOf = (record: TraceRecord | null | undefined): ThresholdCrossedEvent[] => {
    if (record === null || record === undefined || record.role !== "worker" || record.requestId === null) return [];
    const home = homeOf();
    if (home === null) return [];
    try {
      const settings = readCoordinationSettings({ home, log });
      if (!settings.handoff.enabled) return [];
      const requestId = record.requestId;
      const handoffs = createHandoffStore(home).list();
      const records = readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, record.workspaceId).records;
      const event = handoffCrossedEventOf(record, settings, {
        tokensRead: requestTokensReadOf(records, requestId, lastHandoffAtOf(handoffs, requestId)),
        handoffs: handoffsDoneOf(handoffs, requestId).length,
        pending: pendingHandoffOf(handoffs, requestId, deps.now?.() ?? new Date()) !== null,
        finished: requestFinishedOf(records, requestId),
      });
      return event === null ? [] : [event];
    } catch (error) {
      log(`[paseo-bm] could not check a turn against the handoff threshold: ${errorText(error)}`);
      return [];
    }
  };

  /** The `compact` kind of a recorded turn (`compactCrossedEventOf`). */
  const compactCrossedOf = (record: TraceRecord | null | undefined): ThresholdCrossedEvent[] => {
    if (record === null || record === undefined || (record.role !== "manager" && record.role !== "worker")) return [];
    const compaction = record.evidence.find((evidence) => evidence.kind === "compaction");
    if (compaction !== undefined) {
      const at = timeOrNull(compaction.at) ?? timeOrNull(record.endedAt) ?? timeOrNull(record.at);
      if (at !== null) compactedAt.set(record.agentId, Math.max(at, compactedAt.get(record.agentId) ?? at));
      return [];
    }
    const home = homeOf();
    if (home === null) return [];
    try {
      const settings = readCoordinationSettings({ home, log });
      // The compactions are read only for a turn that crosses at all: most turns do not.
      if (compactCrossedEventOf(record, settings, { compactions: 0, pending: false }) === null) return [];
      const compactions = createCompactionStore(home).list();
      const event = compactCrossedEventOf(record, settings, {
        compactions: sentCompactionsOf(compactions, record.agentId),
        pending: pendingCompactionOf(compactions, record.agentId, deps.now?.() ?? new Date()) !== null,
      });
      return event === null ? [] : [event];
    } catch (error) {
      log(`[paseo-bm] could not check a turn against the compaction threshold: ${errorText(error)}`);
      return [];
    }
  };

  return {
    usePaseo(paseo) {
      if (isPaseo(paseo)) lastPaseo = paseo;
    },
    publish,
    turnRecorded(record, opened, paseo, isUnverified) {
      return publish([...openedEventsOf(opened), ...requestFinishedEventsOf(record, isUnverified), ...adviceDueOf(record), ...thresholdCrossedOf(record)], paseo);
    },
    decisionsOpened(opened, paseo) {
      return publish(openedEventsOf(opened), paseo);
    },
    workerTurnEnded(workerId) {
      for (const [key, worker] of openSignals) if (worker === workerId) openSignals.delete(key);
    },
    isSignalOpen: (key) => openSignals.has(key),
    wakeEventsOf: (orchestratorId) => openWakes.get(orchestratorId)?.[0] ?? [],
  };
}
