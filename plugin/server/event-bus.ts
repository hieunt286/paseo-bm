/**
 * The event bus to the Beads Orchestrator (autonomy design §A.8, REQ-115 b).
 *
 * Replaces earlier builds' one-notice-per-situation wake-ups (autonomy design
 * §A.14) with typed events, delivered in batches.
 *
 * **The governor's wakes** (missions design §9.7, §9.1; REQ-195). Only these
 * wake the Orchestrator (`wakesGovernor`):
 *
 * | Event | Wakes it when | Settled (dropped before delivery) when |
 * |---|---|---|
 * | `mission.signal` | a family of the governor's ladder came due for step 3, re-plan (`governor-store.ts`, `missionSignalEventsOf`) | the governor reset the family meanwhile (its figures back under their thresholds) |
 * | `mission.conflict` | always; published by the conflict detection (§9.6) | one of its missions closed |
 * | `mission.scope` | an active request, or a live link one asked, of a mission is in a repo outside its charter, the mission's `scope-repo` cell is not delegated and no `m:` card asked to add that repo `governor.windowMinutes` after this run first saw it (`outsideCharterOf`) | the repo joined the charter, `scope-repo` was delegated, a card asked for it, or the mission closed |
 * | `mission.review` | the mission's finished requests (roster) reached a next multiple of 10, or a budget field's figure reached 50 % or 100 % (`reviewMarksOf`), between two of the governor's recomputations in this run — a mark already passed when the run first saw the mission raises nothing | the mission closed |
 * | `mission.split` | its Main, on the owner's yes, suggested that work belongs to a new mission (`bm_split_mission`, `mission-split.ts`); one per mission and code | a mission took the code, or the source mission closed (`openSplitSuggestionsOf`) |
 * | `worker.signal` `danger` | always, in the policy's scope (below) | its alert is cleared |
 *
 * - **One wake per mission per 15 minutes** (`MISSION_WAKE_MS`), `danger`
 *   excepted: a mission event within 15 minutes of the last publish that
 *   queued one of that mission's is held in memory, and goes with the first
 *   publish after the window (the governor's pass publishes each minute,
 *   `governed`). Events of one mission published together are one wake.
 * - **Retired as wakes** (§9.1): every other event below. Their sources still
 *   build them where other code reads them — the advice count
 *   (`advice-store.ts`), the stall and writers alerts, the pure builders —
 *   but `publish` skips them, before it looks for an Orchestrator.
 * - **Whether a wake acted** (M-26): an act tool the Orchestrator called with
 *   success in a wake's turn (`WAKE_ACT_TOOLS`, `actsNoted`) marks it; the
 *   wake record gets its event types and, at its end, `acted`.
 *
 * Until the governor, these woke it too:
 *
 * | Event | Source | Settled (dropped before delivery) when |
 * |---|---|---|
 * | `decision.opened` | a new `q:` decision the materialiser opened (`decision-materialiser.ts`) or a new `f:` decision a fallback incident's listener opened (`fallback-rpc.ts`), by the owner's policy per cell (below): a decision asked of the Orchestrator, or a prediction asked of the challenger | the decision may no longer be decided (`decideRefusalOf`), or predicted (`predictionRefusalOf`) |
 * | `request.finished` | a `finished` report recorded in a Manager's turn or in the Worker's own (the collector's `onRecorded`; REQ-183 i) that shows work left, or leaves its request finished-unverified (Phase 3, design §C.3) | — (only its project leaving the scope) |
 * | `request.stalled` | the stall pass raised a `request-stalled` alert (`stall-watcher.ts`) | its alert is cleared |
 * | `worker.signal` | the live watch saw a signal (`worker-watch.ts`) | its alert is cleared (`stuck`, `permission`, `danger`), or the Worker's turn ended (`failing`, `heavy`, `outside`) |
 * | `advice.due` | a project's finished requests since its last advice reached Settings' `advice.everyFinished` (the `finished` reports of recorded Manager and Worker turns, counted in `advice-store.ts`; design §G.4) | advice was turned off (`advice.everyFinished` 0) |
 * | `threshold.crossed` (`compact`) | a recorded Manager's or Worker's turn crossing its compaction threshold (`compactCrossedEventOf`, design §G.7, change-008 C1) while compaction is on for its provider, the agent is below `compact.maxPerAgent` and no compaction of it is pending | compaction was turned off, or the agent compacted (or a compaction of it was requested) |
 * | `threshold.crossed` (`handoff`) | a recorded Worker's turn of an unfinished request whose tokens read since it started, or since its last handoff, reach `handoff.requestTokens` (`handoffCrossedEventOf`, design §G.6, §G.7, change-008 C1) while handoff is on, the request is below `handoff.maxPerRequest` and no handoff of it is pending | handoff was turned off, or the request was handed over (or a handoff of it was requested), or it finished |
 * | `writers.observed` | a recorded turn wrote a file another agent of its workspace wrote in an overlapping turn (`writers-watch.ts`, design §F.1), with its `writers-observed` alert | its alert is cleared (the later of the two requests finished) |
 *
 * - **Only what needs a judgement** (REQ-115 b, A-7): a decision wakes the
 *   Orchestrator only when the owner's policy asks it something of that
 *   decision (below), any class at the project's level (ADR-025); a finished
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
 *   `finished` report of a recorded Manager or Worker turn counts its request toward
 *   its project, once per advice (`finishedRequestKeysOf`); when the count
 *   reaches `advice.everyFinished` (Settings → Coordination, default 5), the
 *   count starts again and one `advice.due` is published — a judgement wake:
 *   the Orchestrator reads `bm_findings` and asks the owner, with a prepared
 *   change on an option, about each finding worth acting on. 0 turns it off:
 *   nothing is counted, and a pending one is dropped at delivery.
 * - **`decision.opened`, per cell** (design §B.5, §B.9; change-007 C1). A
 *   decision the Orchestrator did not ask (`q:`, `f:`), still open, of any
 *   class (ADR-025) raises one exactly when:
 *   - its cell is `delegate` (`decideRefusalOf`): it asks for a decision
 *     (`asks: "decision"`), its line names `bm_decide`;
 *   - its cell is `owner` or `shadow` and the project's challenger is on
 *     (`predictionRefusalOf`): it asks for a prediction
 *     (`asks: "prediction"`), its line names `bm_predict`; the owner sees the
 *     prediction as the Orchestrator's proposal.
 *   Nothing else: not with the challenger off, never for the Orchestrator's
 *   own `o:`.
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
import { resolveDataHome } from "./data-home";
import { createAdviceStore } from "./advice-store";
import { createAlertStore } from "./alert-store";
import { currentPolicy } from "./autonomy-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { usageOfSnapshot, type CollectorPaseo } from "./collector";
import { compactCrossingOf, compactionOnFor, handoffCrossingOf, type CoordinationRole, type CoordinationSettings, type ThresholdFigure } from "../shared/coordination";
import { turnTokensOf } from "../shared/eval-metrics/tokens";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticeQueue } from "./notice-queue";
import { EVENTS_NOTICE_MARKER } from "./notices";
import { wakeableOrchestrator, type OrchestratorAgentDeps, type OrchestratorAgentPaseo, type OrchestratorAgentSnapshot } from "./orchestrator-agent";
import { createOrchestratorStore } from "./orchestrator-store";
import { EMPTY_AUTONOMY_POLICY, decideRefusalOf, predictionRefusalOf, projectsAboveOwner, type AutonomyPolicy } from "../shared/autonomy";
import type { Decision } from "../shared/decisions";
import { namesFailingChecks } from "../shared/interventions";
import type { WakeUsage, WorkerSignal } from "../shared/orchestrator";
import type { ParsedReport, TraceRecord } from "../shared/contracts";
import { isPluginHome } from "./plugin-homes";
import { createMissionRoster, missionManagerOf, requestIndexOf } from "./mission-roster";
// Types only: governor-figures.ts reaches this module back through review-tools.ts (a load cycle).
import type { GovernorFamily, GovernorFigure, GovernorFigureId } from "./governor-figures";
import type { GovernorOutcome } from "./governor-store";
import { createMissionStore, openSplitSuggestionsOf, type Mission } from "./mission-store";
import { createMissionAutonomyStore } from "./mission-autonomy-store";
import { createMissionDecisionStore } from "./mission-decisions";
import { createPeerLinkStore, isLiveLink } from "./peer-links";
import { errorText } from "./rpc-kit";

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

/** A family of a mission's ladder came due for step 3, re-plan (missions design §9.3, §9.7). */
export interface MissionSignalEvent {
  type: "mission.signal";
  missionId: string;
  family: GovernorFamily;
  /** The family's crossed figures, with their thresholds. */
  figures: GovernorFigure[];
  step: 3;
  /** When the step came due: one event per climb. */
  at: string;
}

/** Two missions want one area (missions design §9.6); the detection publishes it. */
export interface MissionConflictEvent {
  type: "mission.conflict";
  /** The missions, each once. */
  missions: string[];
  /** The repo of the area. */
  workspaceId: string;
  /** The area: a folder or file pattern in that repo. */
  area: string;
  /** What shows it, one short line. */
  evidence: string;
}

/** A request or a link of a mission in a repo outside its charter, that its Main may not add and has not asked to (missions design §9.7). */
export interface MissionScopeEvent {
  type: "mission.scope";
  missionId: string;
  /** The repo outside the charter. */
  workspaceId: string;
  /** The request in that repo, or the request that asked the link. */
  requestId: string | null;
  /** The link into that repo; null for a request. */
  linkId: string | null;
}

/** Why a mission's review is due (missions design §9.7). */
export const MISSION_REVIEW_REASONS = ["finished-10", "budget-50", "budget-100"] as const;
export type MissionReviewReason = (typeof MISSION_REVIEW_REASONS)[number];

/** A mission reached a review mark (missions design §9.7). */
export interface MissionReviewEvent {
  type: "mission.review";
  missionId: string;
  reason: MissionReviewReason;
  /** `finished-10`: the finished requests; `budget-*`: the budget field's percent. */
  value: number;
  /** The budget figure of a `budget-*` review; null for `finished-10`. */
  figure: GovernorFigureId | null;
}

/** A Main suggested, on the owner's yes, that work belongs to a new mission (missions design §9.6): the fields `bm_create_main` takes. */
export interface MissionSplitEvent {
  type: "mission.split";
  /** The source mission: the suggesting Main's. */
  missionId: string;
  code: string;
  name: string;
  goal: string;
  /** Workspace ids. */
  repos: string[];
  /** Requests of the source mission's roster that go with it. */
  requestIds: string[];
  reason: string;
  /** When the Main suggested it (its journal line). */
  at: string;
}

export type MissionEvent = MissionSignalEvent | MissionConflictEvent | MissionScopeEvent | MissionReviewEvent | MissionSplitEvent;

export type BmEvent =
  | DecisionOpenedEvent
  | RequestFinishedEvent
  | RequestStalledEvent
  | WorkerSignalEvent
  | AdviceDueEvent
  | ThresholdCrossedEvent
  | WritersObservedEvent
  | MissionEvent;

/** True for an event of the governor's missions (§9.7). */
export function isMissionEvent(event: BmEvent): event is MissionEvent {
  return event.type.startsWith("mission.");
}

/**
 * Whether an event wakes the Orchestrator (missions design §9.7): a mission
 * event, or a `danger` signal. Every other is retired as a wake (§9.1).
 */
export function wakesGovernor(event: BmEvent): boolean {
  return isMissionEvent(event) || (event.type === "worker.signal" && event.signal === "danger");
}

/** The missions an event's wake counts against (§9.7): none for a `danger` signal and the retired events. */
export function missionsOfEvent(event: BmEvent): string[] {
  if (!isMissionEvent(event)) return [];
  return event.type === "mission.conflict" ? [...new Set(event.missions)] : [event.missionId];
}

/** The project an event names, or null (a mission's own event). */
function workspaceOfEvent(event: BmEvent): string | null {
  return "workspaceId" in event ? event.workspaceId : null;
}

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
    case "mission.signal":
      return `mission.signal:${event.missionId}:${event.family}@${event.at}`;
    case "mission.conflict":
      return `mission.conflict:${[...new Set(event.missions)].sort().join("+")}:${event.workspaceId}:${event.area}`;
    case "mission.scope":
      return `mission.scope:${event.missionId}:${event.workspaceId}:${event.linkId ?? event.requestId ?? "none"}`;
    case "mission.review":
      return `mission.review:${event.missionId}:${event.reason}:${event.figure ?? event.value}`;
    case "mission.split":
      return `mission.split:${event.missionId}:${event.code}`;
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
  const project = `project ${workspaceOfEvent(event) ?? "none"}`;
  switch (event.type) {
    case "decision.opened": {
      const opened = `- decision.opened — ${project}, request ${event.requestId ?? "none"}, decision ${event.decisionId}${
        event.askedBy === null ? "" : `, asked by Worker ${event.askedBy}`
      }.`;
      if (event.asks === "decision") {
        return `${opened} A decision is asked: the owner's policy delegates its class to you. Read it with bm_decisions and choose the option the owner would, with bm_decide and your reason in one line.`;
      }
      return `${opened} A prediction is asked: read it with bm_decisions and give the option you expect the owner to choose with bm_predict, with your reason in one line. The owner sees it as your proposal and decides: answer nothing.`;
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
    case "mission.signal":
      return `- mission.signal ${event.family} — mission ${event.missionId}, step 3: the Main was nudged and these still hold after the window: ${event.figures.map(figureWords).join("; ")}. Read the mission with bm_missions and send its Main bm_govern with step "replan"; on real risk, ask the owner with bm_ask_owner or stop a Worker with bm_direct_worker.`;
    case "mission.conflict":
      return `- mission.conflict — missions ${event.missions.join(" and ")}, ${project}, area ${event.area}: ${event.evidence}. Read both with bm_missions and give the area one owner with bm_arbitrate.`;
    case "mission.scope":
      return `- mission.scope — mission ${event.missionId}, ${project} is outside its charter (${event.linkId === null ? `request ${event.requestId ?? "not known"}` : `link ${event.linkId} of request ${event.requestId ?? "not known"}`}); its Main may not add the repo and has not asked the owner. Read the mission with bm_missions; tell its Main with bm_govern, or ask the owner with bm_ask_owner.`;
    case "mission.review":
      return `- mission.review ${event.reason} — mission ${event.missionId}, ${
        event.figure === null ? `${event.value} requests finished` : `${event.figure} at ${event.value} %`
      }. Read it with bm_missions against its charter; act with bm_govern or bm_ask_owner where it drifted, else keep a note with bm_note.`;
    case "mission.split":
      return `- mission.split — mission ${event.missionId}: its Main, on the owner's yes, suggests the new mission ${event.code} "${event.name}" (repos ${event.repos.join(", ") || "none"}; ${
        event.requestIds.length === 0 ? "no request" : `requests ${event.requestIds.join(", ")}`
      }): ${event.reason.slice(0, 300).replace(/[.\s]+$/, "")}. Read it with bm_missions (its splitSuggestions) and decide: bm_create_main with its fields, or tell the Main why not with bm_govern.`;
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
 * - one delegated to it (`decideRefusalOf`: not its own, open, its class
 *   `delegate` in its project) asks for a decision;
 * - one the challenger may predict (`predictionRefusalOf`: not its own, open,
 *   any class in an `owner` or `shadow` cell, the project's challenger on)
 *   asks for a prediction, whatever else the project's policy holds.
 *
 * The two never both hold (a `delegate` cell is not predicted). Pure.
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
 * The turns whose `finished` reports the events read (design §7.17.8 i): a
 * Manager's (a report sent to it by hand), and a Worker's own — what its
 * `bm_report` stored (with its `recordId`, `outboxBlocksOf`) or the block the
 * plugin relays for an unbound Worker — since the collector skips every
 * `BM-DELIVERY` in the Manager's turn.
 */
const readsFinishes = (record: TraceRecord | null | undefined): record is TraceRecord =>
  record !== null && record !== undefined && (record.role === "manager" || record.role === "worker");

/** The Manager a finish is told to: the recording Manager, else the Worker's parent, else the Worker. */
const managerOf = (record: TraceRecord): string => (record.role === "manager" ? record.agentId : (record.parentAgentId ?? record.agentId));

/** Where a request of a mission lives and its current Main (missions design §6); null for a request of no mission. */
export interface FinishPlace {
  workspaceId: string;
  managerId: string | null;
}

/** The place of a request of a mission in the data folder `home`, or null. Never throws. */
export function finishPlaceOf(home: string | null, requestId: string): FinishPlace | null {
  const place = home === null ? null : requestIndexOf(home, requestId);
  return place === null ? null : { workspaceId: place.workspaceId, managerId: missionManagerOf(home, requestId) };
}

/**
 * `request.finished` for each `finished` report recorded in a Manager's or a
 * Worker's turn (`readsFinishes`) that shows work left (§A.8) or leaves its request finished-unverified
 * (design §C.3; `isUnverified`, read from the request's records by the caller,
 * `unverifiedFinishesOf`), which the event carries as `unverified: true`.
 * A request of a mission (`placeOf`) is its repo's, told to its current Main
 * (missions design §6), wherever its turn was recorded. Pure.
 */
export function requestFinishedEventsOf(
  record: TraceRecord | null | undefined,
  isUnverified: (report: ParsedReport) => boolean = () => false,
  placeOf: (requestId: string) => FinishPlace | null = () => null,
): RequestFinishedEvent[] {
  if (!readsFinishes(record)) return [];
  return record.reports.flatMap((report): RequestFinishedEvent[] => {
    if (report.phase !== "finished") return [];
    const unverified = isUnverified(report);
    if (!unverified && !workLeftOf(report)) return [];
    const requestId = report.requestId ?? record.requestId;
    const place = requestId === null ? null : placeOf(requestId);
    return [
      {
        type: "request.finished",
        workspaceId: place?.workspaceId ?? record.workspaceId,
        requestId,
        managerId: place?.managerId ?? managerOf(record),
        at: report.at,
        ...(unverified ? { unverified: true as const } : {}),
      },
    ];
  });
}

/**
 * The finished requests of a recorded Manager or Worker turn
 * (`readsFinishes`), for the advice cadence (design §G.4): one key per
 * request that sent a `finished` report — its request id, else the Manager
 * and the report's time — with the latest such
 * report's time. Every finished report counts, work left or not. Pure.
 */
export function finishedRequestKeysOf(record: TraceRecord | null | undefined): { workspaceId: string; keys: string[]; at: string } | null {
  if (!readsFinishes(record)) return null;
  const finished = record.reports.filter((report) => report.phase === "finished");
  if (finished.length === 0) return null;
  const keys = [...new Set(finished.map((report) => report.requestId ?? record.requestId ?? `manager:${managerOf(record)}@${report.at}`))];
  const at = finished.map((report) => report.at).reduce((latest, next) => (Date.parse(next) > Date.parse(latest) ? next : latest));
  return { workspaceId: record.workspaceId, keys, at };
}

// ---------------------------------------------------------------------------
// The governor's events (missions design §9.7).
// ---------------------------------------------------------------------------

/** The figures of one family (`governor-figures.ts` `familyFiguresOf`). Pure. */
const familyFigures = (figures: readonly GovernorFigure[], family: GovernorFamily): GovernorFigure[] => figures.filter((entry) => entry.family === family);

/** One figure in words, as the nudge words it (`governor-figures.ts` `figureText`): `stalled 1 (threshold ≥ 1; req-…)`. Pure. */
const figureWords = (entry: GovernorFigure): string => `${entry.id} ${entry.value} (threshold ${entry.op === ">=" ? "≥" : ">"} ${entry.threshold}${entry.detail === null ? "" : `; ${entry.detail}`})`;

/** At most one wake per mission in this long, `danger` excepted (§9.7). */
export const MISSION_WAKE_MS = 15 * 60_000;

/** A review every this many finished requests of a mission (§9.7). */
export const REVIEW_EVERY_FINISHED = 10;

/** `mission.signal` for each family of a recomputation that came due for step 3 (`replan-due`), with its crossed figures. Pure. */
export function missionSignalEventsOf(outcome: Pick<GovernorOutcome, "missionId" | "figures" | "actions">, at: Date): MissionSignalEvent[] {
  return outcome.actions
    .filter((action) => action.action === "replan-due")
    .map((action) => ({
      type: "mission.signal",
      missionId: outcome.missionId,
      family: action.family,
      figures: familyFigures(outcome.figures, action.family).filter((entry) => entry.crossed),
      step: 3,
      at: at.toISOString(),
    }));
}

/** A mission's review marks: its finished requests in tens, and each budget figure's 0, 1 (≥ 50 %) or 2 (≥ 100 %). Pure. */
export interface ReviewMarks {
  finished: number;
  budgets: Partial<Record<GovernorFigureId, number>>;
}

/** The marks of a mission now: `finished` requests and its budget figures (the `budget` family). Pure. */
export function reviewMarksOf(finished: number, figures: readonly GovernorFigure[]): ReviewMarks {
  const budgets: ReviewMarks["budgets"] = {};
  for (const entry of familyFigures(figures, "budget")) budgets[entry.id] = entry.value >= 100 ? 2 : entry.value >= 50 ? 1 : 0;
  return { finished: Math.floor(finished / REVIEW_EVERY_FINISHED), budgets };
}

/**
 * `mission.review` for each mark `now` passed since `before` (§9.7): a next
 * ten of finished requests, a budget figure at 50 % or 100 % (one event, the
 * higher, when it passed both). None without `before`: a mark the run found
 * passed is not a new one. Pure.
 */
export function missionReviewEventsOf(missionId: string, before: ReviewMarks | undefined, now: ReviewMarks, finished: number, figures: readonly GovernorFigure[]): MissionReviewEvent[] {
  if (before === undefined) return [];
  const events: MissionReviewEvent[] = [];
  if (now.finished > before.finished) events.push({ type: "mission.review", missionId, reason: "finished-10", value: finished, figure: null });
  for (const entry of familyFigures(figures, "budget")) {
    const mark = now.budgets[entry.id] ?? 0;
    if (mark > (before.budgets[entry.id] ?? 0)) events.push({ type: "mission.review", missionId, reason: mark === 2 ? "budget-100" : "budget-50", value: entry.value, figure: entry.id });
  }
  return events;
}

/**
 * The active requests of a mission, and the live links they asked, in repos
 * outside its charter (§9.7 `mission.scope`): none while the charter names no
 * repo, the mission is closed, its `scope-repo` cell is delegated (its Main
 * adds the repo itself), or for a repo an `m:` card of the mission asked to
 * add. Reads the stores; throws only what they throw.
 */
export function outsideCharterOf(home: string, mission: Pick<Mission, "missionId" | "state" | "charter">): MissionScopeEvent[] {
  const repos = new Set(mission.charter.repos);
  if (mission.state !== "open" || repos.size === 0 || createMissionAutonomyStore(home).isDelegated(mission.missionId, "scope-repo")) return [];
  const roster = createMissionRoster(home).list(mission.missionId);
  const requestIds = new Set(roster.map((entry) => entry.requestId));
  const found: MissionScopeEvent[] = [
    ...roster
      .filter((entry) => entry.state === "active" && !repos.has(entry.workspaceId))
      .map((entry): MissionScopeEvent => ({ type: "mission.scope", missionId: mission.missionId, workspaceId: entry.workspaceId, requestId: entry.requestId, linkId: null })),
    ...createPeerLinkStore(home)
      .list()
      .filter((link) => isLiveLink(link) && link.from.requestId !== null && requestIds.has(link.from.requestId) && !repos.has(link.to.workspaceId))
      .map((link): MissionScopeEvent => ({ type: "mission.scope", missionId: mission.missionId, workspaceId: link.to.workspaceId, requestId: link.from.requestId, linkId: link.linkId })),
  ];
  if (found.length === 0) return [];
  const asked = new Set(
    createMissionDecisionStore(home)
      .list(mission.missionId)
      .flatMap((decision) => decision.options.flatMap((option) => (option.action?.kind === "mission-change" ? (option.action.change.addRepos ?? []) : []))),
  );
  return found.filter((event) => !asked.has(event.workspaceId));
}

/**
 * The tools whose successful call in a wake's turn is an action (M-26).
 * `bm_direct_worker` counts with `intent: "stop"` only.
 */
export const WAKE_ACT_TOOLS = ["bm_govern", "bm_arbitrate", "bm_create_main", "bm_direct_worker", "bm_ask_owner", "bm_note"] as const;

/** Whether a call of `name` with `input` is an act (M-26). Pure. */
export function isWakeAct(name: string, input: unknown): boolean {
  if (!(WAKE_ACT_TOOLS as readonly string[]).includes(name)) return false;
  return name !== "bm_direct_worker" || (input as { intent?: unknown } | null | undefined)?.intent === "stop";
}

/** `tools`, with each successful act noted on the bus (`EventBus.toolCalled`): what the wake record's `acted` reads. */
export function actsNoted<T extends { call(name: string, input: unknown): Promise<{ ok: boolean }> }>(tools: T, bus: Pick<EventBus, "toolCalled">): T {
  return {
    ...tools,
    async call(name: string, input: unknown) {
      const result = await tools.call(name, input);
      if (result.ok) bus.toolCalled(name, input);
      return result;
    },
  };
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
 * class above `owner` in the owner's policy, never a plugin home (missions
 * design §3.1). A policy that cannot be read is the empty scope, the safe
 * side, with one log line. Never throws.
 */
export function eventScopeOf(home: string, log: (message: string) => void = (message) => console.warn(message)): Set<string> {
  return scopeOfPolicy(eventPolicyOf(home, log), home);
}

/** `eventScopeOf` of a policy already read. */
function scopeOfPolicy(policy: AutonomyPolicy, home: string): Set<string> {
  return new Set([...projectsAboveOwner(policy)].filter((workspaceId) => !isPluginHome(workspaceId, home)));
}

/**
 * Whether an event may reach the Orchestrator: a mission event always
 * (missions design §9.7), `decision.opened` keeps its own filter (change-007
 * C1), `advice.due` its cadence (design §G.4) and `threshold.crossed` the
 * owner's Settings (design §G.7); the others need their project in `scope`.
 * Whether it wakes the Orchestrator at all is `wakesGovernor`'s.
 */
export function isInEventScope(event: BmEvent, scope: ReadonlySet<string>): boolean {
  if (isMissionEvent(event)) return true;
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
  /** Event keys left out: retired as wakes, not in the policy's scope, already published, or held for their mission's window. */
  skipped: string[];
}

export interface EventBus {
  /** Keeps the handle a hook or RPC context brought; anything that is not one is ignored. */
  usePaseo(paseo: unknown): void;
  /**
   * Publishes events to the Orchestrator: those that wake it (`wakesGovernor`),
   * in the policy's scope (`isInEventScope`), once per key, a mission's at
   * most once per `MISSION_WAKE_MS` (held until then). Never rejects.
   */
  publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult>;
  /**
   * One recorded turn (the collector's `onRecorded`). Its `decision.opened`,
   * `request.finished`, `advice.due` and `threshold.crossed` are retired as
   * wakes (missions design §9.1): only its finished requests still count
   * toward the project's advice (design §G.4, `advice-store.ts`). Never rejects.
   */
  turnRecorded(
    record: TraceRecord | null | undefined,
    opened: readonly Decision[],
    paseo?: unknown,
    isUnverified?: (report: ParsedReport) => boolean,
  ): Promise<PublishResult>;
  /** Decisions opened outside a recorded turn: `decision.opened` is retired as a wake (§9.1), so nothing is published. Never rejects. */
  decisionsOpened(opened: readonly Decision[], paseo?: unknown): Promise<PublishResult>;
  /** A Worker's turn ended. Nothing to settle since its non-alert signals no longer wake (§9.1); kept for the stall pass that calls it. */
  workerTurnEnded(workerId: string): void;
  /**
   * The governor's recomputations (`governor-store.ts`; each minute and at
   * each recorded turn of a mission's agents): their `mission.signal`,
   * `mission.review` and `mission.scope` (§9.7), published with any event a
   * mission's window held. Never rejects.
   */
  governed(outcomes: readonly GovernorOutcome[], paseo?: unknown): Promise<PublishResult>;
  /** The Orchestrator called `name` with success: an act (`isWakeAct`) marks each Orchestrator's running wake as acted (M-26). */
  toolCalled(name: string, input: unknown): void;
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
  const now = deps.now ?? (() => new Date());
  let lastPaseo: OrchestratorAgentPaseo | null = null;
  /** Keys published in this run, oldest first. */
  const published = new Set<string>();
  /** Finishes read in this run (project, request, the report without its sender and time) → the role whose turn held it first. */
  const finishes = new Map<string, TraceRecord["role"]>();
  /**
   * The turn without the finishes already read in the other role's turns: a
   * Worker's report sent to its Manager by hand is one finish in both records,
   * counted once (REQ-183 i). Repeats in one role's turns keep the advice
   * count's own dedupe.
   */
  const unseenFinishesOf = (record: TraceRecord | null | undefined): TraceRecord | null | undefined => {
    if (!readsFinishes(record)) return record;
    const reports = record.reports.filter((report) => {
      if (report.phase !== "finished") return true;
      const requestId = report.requestId ?? record.requestId;
      // Missions design §6: the request's workspace, so a Main's copy in the home and its Worker's in the repo are one finish.
      const workspaceId = (requestId === null ? null : finishPlaceOf(homeOf(), requestId))?.workspaceId ?? record.workspaceId;
      const key = JSON.stringify([workspaceId, requestId, { ...report, agentId: null, at: null, recordId: null }]);
      const first = finishes.get(key);
      if (first === undefined) finishes.set(key, record.role);
      if (finishes.size > PUBLISHED_KEYS_LIMIT) finishes.delete(finishes.keys().next().value!);
      return first === undefined || first === record.role;
    });
    return { ...record, reports };
  };
  /** Published keys → their project, until the wake that carried them is recorded (A-7). */
  const workspaceOfKey = new Map<string, string>();
  /** Each mission's last publish that queued one of its events (§9.7), in ms. */
  const missionWokenAt = new Map<string, number>();
  /** Mission events held for their mission's window, by key; they go with the first publish after it. */
  const held = new Map<string, BmEvent>();
  /** Each mission's review marks at its last recomputation in this run (`reviewMarksOf`). */
  const reviewMarks = new Map<string, ReviewMarks>();
  /** `mission.scope` keys → when this run first saw them, in ms. */
  const outsideSince = new Map<string, number>();
  /** `<missionId>:<family>` → when the governor last reset that family (§9.3), in ms: a `mission.signal` before it is settled. */
  const familyResetAt = new Map<string, number>();

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

  /** A `BM-EVENTS` message went out: one wake of that Orchestrator (A-7), with its event types (§9.7). */
  const recordWake = (targetId: string, keys: readonly string[], events: readonly BmEvent[]): void => {
    const workspaceIds = keys.map((key) => workspaceOfKey.get(key)).filter((id): id is string => id !== undefined);
    for (const key of keys) workspaceOfKey.delete(key);
    const home = homeOf();
    if (home === null || keys.length === 0) return;
    try {
      createOrchestratorStore(home, { now: deps.now }).appendWake({ orchestratorId: targetId, workspaceIds, events: keys.length, eventTypes: events.map((event) => event.type) });
    } catch (error) {
      log(`[paseo-bm] could not record the Orchestrator's wake: ${errorText(error)}`);
    }
  };

  /**
   * That Orchestrator's turn after a `BM-EVENTS` message ended: its oldest open
   * wake ends now (A-7), with that turn's tokens (change-007 C6) and whether
   * it acted (M-26; unknown for a wake a reload forgot).
   */
  const endWake = async (targetId: string, paseo: unknown, acted: boolean | undefined): Promise<void> => {
    const home = homeOf();
    if (home === null) return;
    const usage = await closingTurnUsage(targetId, paseo);
    try {
      createOrchestratorStore(home, { now: deps.now }).endWake(targetId, usage, acted);
    } catch (error) {
      log(`[paseo-bm] could not record the end of the Orchestrator's wake: ${errorText(error)}`);
    }
  };

  /** Published keys → their event until the wake that carried them went out, then each Orchestrator's open wakes, oldest first (§G.3). */
  const eventOfKey = new Map<string, BmEvent>();
  const openWakes = new Map<string, Array<{ events: BmEvent[]; acted: boolean }>>();

  const batch: NoticeBatch = {
    ...EVENTS_BATCH,
    onSent: (targetId, keys) => {
      const events = keys.flatMap((key) => eventOfKey.get(key) ?? []);
      openWakes.set(targetId, [...(openWakes.get(targetId) ?? []), { events, acted: false }]);
      for (const key of keys) eventOfKey.delete(key);
      recordWake(targetId, keys, events);
    },
    onTurnEnded: (targetId, paseo) => {
      const open = openWakes.get(targetId);
      const ended = open?.shift();
      if (open?.length === 0) openWakes.delete(targetId);
      return endWake(targetId, paseo, ended?.acted);
    },
  };

  /** Whether a mission is open in the data folder `home`. */
  const isOpenMission = (home: string, missionId: string): boolean => createMissionStore(home).get(missionId)?.state === "open";

  /**
   * Whether the event's subject still needs the Orchestrator: read
   * synchronously at the idle moment, the owner's policy once per check.
   * Only the events that wake it are ever queued (`wakesGovernor`).
   */
  const isCurrentOf =
    (event: BmEvent, home: string) =>
    (): boolean => {
      switch (event.type) {
        case "worker.signal":
          if (!isInEventScope(event, scopeOfPolicy(eventPolicyOf(home, log), home))) return false;
          return event.alertKey !== null && createAlertStore(home).isOpen(event.alertKey);
        case "mission.signal":
          // Dropped once the governor reset the family (its figures back under their thresholds) before delivery.
          return (familyResetAt.get(`${event.missionId}:${event.family}`) ?? Number.NEGATIVE_INFINITY) < (Date.parse(event.at) || 0);
        case "mission.conflict":
          return event.missions.every((missionId) => isOpenMission(home, missionId));
        case "mission.scope": {
          const mission = createMissionStore(home).get(event.missionId);
          return mission !== null && outsideCharterOf(home, mission).some((found) => eventKeyOf(found) === eventKeyOf(event));
        }
        case "mission.review":
          return isOpenMission(home, event.missionId);
        case "mission.split":
          // Dropped once a mission took the code, or the source mission closed (§9.6).
          return openSplitSuggestionsOf(home, event.missionId).some((suggestion) => suggestion.code === event.code);
        default:
          return false;
      }
    };

  async function publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult> {
    try {
      if (isPaseo(paseo)) lastPaseo = paseo;
      if (events.length === 0 && held.size === 0) return result("none");
      // Missions design §9.1: only the governor's events wake the Orchestrator; the rest are skipped before anything is read.
      const skipped = events.filter((event) => !wakesGovernor(event)).map(eventKeyOf);
      const waking = [...held.values(), ...events.filter(wakesGovernor)];
      held.clear();
      if (waking.length === 0) return result("none", skipped);
      const home = homeOf();
      if (home === null) return result("no-data-folder", skipped);
      const scope = eventScopeOf(home, log);
      const fresh: Array<{ event: BmEvent; key: string }> = [];
      for (const event of waking) {
        const key = eventKeyOf(event);
        if (published.has(key) || fresh.some((entry) => entry.key === key) || !isInEventScope(event, scope)) skipped.push(key);
        else fresh.push({ event, key });
      }
      if (fresh.length === 0) return result("none", skipped);
      const handle = lastPaseo;
      if (handle === null) return result("no-paseo", skipped);
      // §9.7: a mission woken within its window waits; the events of one mission that go now go together.
      const at = now().getTime();
      const goingFor = new Set<string>();
      const due: typeof fresh = [];
      const hold = new Map<string, BmEvent>();
      for (const entry of fresh) {
        const missions = missionsOfEvent(entry.event);
        if (missions.some((missionId) => !goingFor.has(missionId) && at - (missionWokenAt.get(missionId) ?? Number.NEGATIVE_INFINITY) < MISSION_WAKE_MS)) {
          hold.set(entry.key, entry.event);
          skipped.push(entry.key);
          continue;
        }
        for (const missionId of missions) goingFor.add(missionId);
        due.push(entry);
      }
      for (const [key, event] of hold) held.set(key, event);
      if (due.length === 0) return result("none", skipped);
      const orchestrator = await wakeableOrchestrator(handle, { ...deps, log }, found);
      if (orchestrator === null) return result("no-orchestrator", skipped);
      const items: BatchItem[] = due.map(({ event, key }) => {
        remember(key);
        const workspaceId = workspaceOfEvent(event);
        if (workspaceId !== null) workspaceOfKey.set(key, workspaceId);
        eventOfKey.set(key, event);
        return { key, line: eventLineOf(event), isCurrent: isCurrentOf(event, home) };
      });
      const outcomes = await queue.enqueueBatch(orchestrator.id, batch, items, handle as never);
      const done: PublishResult = { status: "done", published: [], skipped };
      outcomes.forEach((outcome, index) => {
        const { event, key } = due[index]!;
        if (outcome !== "sent" && outcome !== "queued") return void skipped.push(key);
        done.published.push(key);
        for (const missionId of missionsOfEvent(event)) missionWokenAt.set(missionId, at);
      });
      return done;
    } catch (error) {
      log(`[paseo-bm] publishing events to the Orchestrator failed: ${errorText(error)}`);
      return result("failed");
    }
  }

  /**
   * Counts the finished requests of a recorded Manager's or Worker's turn
   * toward its project's advice (design §G.4), which starts the count again
   * when it reaches the cadence. Nothing with advice off. Its `advice.due` is
   * retired as a wake (§9.1). Never throws: a store failure is one log line.
   */
  const countAdvice = (record: TraceRecord | null | undefined): void => {
    const finished = finishedRequestKeysOf(record);
    const home = finished === null ? null : homeOf();
    if (finished === null || home === null) return;
    const everyFinished = readCoordinationSettings({ home, log }).advice.everyFinished;
    if (everyFinished === 0) return;
    try {
      createAdviceStore(home).count(finished.workspaceId, finished.keys, everyFinished, finished.at);
    } catch (error) {
      log(`[paseo-bm] could not count the finished requests toward the advice: ${errorText(error)}`);
    }
  };

  /**
   * The governor's events of one recomputation (§9.7): `mission.signal` for
   * a family due for step 3, `mission.review` for a mark passed since the
   * last one, `mission.scope` for work outside the charter first seen
   * `governor.windowMinutes` ago. Never throws: a store failure is one log
   * line and no event of that mission.
   */
  const missionEventsOf = (home: string, outcome: GovernorOutcome, at: Date): BmEvent[] => {
    for (const action of outcome.actions) if (action.action === "reset") familyResetAt.set(`${outcome.missionId}:${action.family}`, at.getTime());
    try {
      const mission = createMissionStore(home).get(outcome.missionId);
      if (mission === null || mission.state !== "open") return [];
      const finished = createMissionRoster(home)
        .list(mission.missionId)
        .filter((entry) => entry.state === "finished").length;
      const marks = reviewMarksOf(finished, outcome.figures);
      const reviews = missionReviewEventsOf(mission.missionId, reviewMarks.get(mission.missionId), marks, finished, outcome.figures);
      reviewMarks.set(mission.missionId, marks);
      const windowMs = readCoordinationSettings({ home, log }).governor.windowMinutes * 60_000;
      const outside = outsideCharterOf(home, mission).filter((event) => {
        const key = eventKeyOf(event);
        const since = outsideSince.get(key) ?? at.getTime();
        outsideSince.set(key, since);
        return at.getTime() - since >= windowMs;
      });
      return [...missionSignalEventsOf(outcome, at), ...reviews, ...outside];
    } catch (error) {
      log(`[paseo-bm] could not read the governor's events of mission ${outcome.missionId}: ${errorText(error)}`);
      return [];
    }
  };

  return {
    usePaseo(paseo) {
      if (isPaseo(paseo)) lastPaseo = paseo;
    },
    publish,
    turnRecorded(record, _opened, paseo) {
      countAdvice(unseenFinishesOf(record));
      return publish([], paseo);
    },
    decisionsOpened(_opened, paseo) {
      return publish([], paseo);
    },
    workerTurnEnded() {},
    governed(outcomes, paseo) {
      const home = outcomes.length === 0 ? null : homeOf();
      const at = now();
      return publish(home === null ? [] : outcomes.flatMap((outcome) => missionEventsOf(home, outcome, at)), paseo);
    },
    toolCalled(name, input) {
      if (!isWakeAct(name, input)) return;
      for (const open of openWakes.values()) if (open[0] !== undefined) open[0].acted = true;
    },
    wakeEventsOf: (orchestratorId) => openWakes.get(orchestratorId)?.[0]?.events ?? [],
  };
}
