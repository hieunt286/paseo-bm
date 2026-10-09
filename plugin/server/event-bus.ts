/**
 * The event bus to the Beads Orchestrator (autonomy design §A.8, REQ-115 b;
 * missions design §9.7, §9.1): typed events, delivered in batches.
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
 * | `worker.signal` `danger` | always, for a project in the policy's scope (`eventScopeOf`: a class above `owner`, never a plugin home) | its alert is cleared, or the project left the scope |
 *
 * - **Retired as wakes** (§9.1): every other event type (`request.stalled`,
 *   `worker.signal` other than `danger`, `writers.observed`, and the types
 *   no source builds any more). Their sources still build them where other
 *   code reads them — the stall and writers alerts, the conflict detection —
 *   but `publish` skips them before it looks for an Orchestrator.
 * - **One wake per mission per 15 minutes** (`MISSION_WAKE_MS`), `danger`
 *   excepted: a mission event within 15 minutes of the last publish that
 *   queued one of that mission's is held in memory, and goes with the first
 *   publish after the window (the governor's pass publishes each minute,
 *   `governed`); a publish that cannot reach the queue (no data folder, no
 *   Paseo handle, a failure) keeps what it held. Events of one mission
 *   published together are one wake.
 * - **One message per idle moment.** Events go through the notice queue's
 *   batch kind (`enqueueBatch`, `BM-EVENTS`): everything pending when the
 *   Orchestrator is idle goes as ONE `BM-EVENTS` message, one short line per
 *   event with the ids to look up; never into a running turn.
 * - **Once per event.** Each event has a dedupe key (`eventKeyOf`); a key
 *   queued or sent in this plugin run is not published again.
 * - **Only to the Orchestrator**, the one the plugin may wake
 *   (`wakeableOrchestrator`: an outdated one, or one without tools, is replaced
 *   first). Without an Orchestrator nothing is queued. Nothing here ever
 *   messages the owner, a Manager, a Worker or a Reviewer.
 * - **Each wake is recorded** (evaluation design §4, A-7): once a `BM-EVENTS`
 *   message went out (the batch's `onSent`), `orchestrator/wakes.json` gets
 *   the Orchestrator's id, the time, the projects, the number of events and
 *   their types; at that Orchestrator's next turn end (the batch's
 *   `onTurnEnded`) its oldest open wake gets its end, that closing turn's
 *   tokens (change-007 C6, `closingTurnUsage`) and whether it acted (M-26: an
 *   act tool called with success in its turn, `WAKE_ACT_TOOLS`, `actsNoted`).
 *   The events a wake carried stay in memory until that turn end
 *   (`wakeEventsOf`), so a command the Orchestrator sends in it is logged as
 *   the intervention on those events (design §G.3, `intervention-store.ts`).
 * - **The advice count** (design §G.4): each recorded Manager's or Worker's
 *   turn counts its finished requests toward its project's advice
 *   (`advice-store.ts`); it wakes nothing.
 *
 * Nothing here throws into the plugin: a failure is one log line.
 */
import { resolveDataHome } from "./data-home";
import { createAdviceStore } from "./advice-store";
import { createAlertStore } from "./alert-store";
import { currentPolicy } from "./autonomy-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { usageOfSnapshot, type CollectorPaseo } from "./collector";
import type { CoordinationRole, ThresholdFigure } from "../shared/coordination";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticeQueue } from "./notice-queue";
import { EVENTS_NOTICE_MARKER } from "./notices";
import { wakeableOrchestrator, type OrchestratorAgentDeps, type OrchestratorAgentPaseo, type OrchestratorAgentSnapshot } from "./orchestrator-agent";
import { createOrchestratorStore } from "./orchestrator-store";
import { projectsAboveOwner, type AutonomyPolicy } from "../shared/autonomy";
import { familyFiguresOf, figureText, type GovernorFamily, type GovernorFigure, type GovernorFigureId } from "../shared/governor-figures";
import type { WakeUsage, WorkerSignal } from "../shared/orchestrator";
import type { TraceRecord } from "../shared/contracts";
import { isPluginHome } from "./plugin-homes";
import { createMissionRoster, requestIndexOf } from "./mission-roster";
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
  /** What it asks of the Orchestrator (design §B.5, §B.9): a decision (`bm_decide`), or a prediction (`bm_predict`). */
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

/**
 * One short line per event: what happened, and the ids to look up (design
 * §A.8). Only the events that wake the Orchestrator (`wakesGovernor`) are
 * ever sent; a retired one gets its type and project alone.
 */
export function eventLineOf(event: BmEvent): string {
  const project = `project ${workspaceOfEvent(event) ?? "none"}`;
  switch (event.type) {
    case "worker.signal": {
      const allowance =
        event.interruptUntil === undefined || event.interruptUntil === null
          ? ""
          : ` You may interrupt this Worker until ${event.interruptUntil} (bm_direct_worker with interrupt: true).`;
      return `- worker.signal ${event.signal} — ${project}, Worker ${event.workerId}, request ${event.requestKey ?? "not known"}, since ${event.since}. Look with bm_agent_messages.${allowance}`;
    }
    case "mission.signal":
      return `- mission.signal ${event.family} — mission ${event.missionId}, step 3: the Main was nudged and these still hold after the window: ${event.figures.map(figureText).join("; ")}. Read the mission with bm_missions and send its Main bm_govern with step "replan"; on real risk, ask the owner with bm_ask_owner or stop a Worker with bm_direct_worker.`;
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
    default:
      return `- ${event.type} — ${project}.`;
  }
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
 * The turns whose `finished` reports the advice count reads (design §7.17.8
 * i): a Manager's (a report sent to it by hand), and a Worker's own — what its
 * `bm_report` stored (with its `recordId`, `outboxBlocksOf`) or the block the
 * plugin relays for an unbound Worker — since the collector skips every
 * `BM-DELIVERY` in the Manager's turn.
 */
const readsFinishes = (record: TraceRecord | null | undefined): record is TraceRecord =>
  record !== null && record !== undefined && (record.role === "manager" || record.role === "worker");

/** The Manager a finish without a request id is keyed by: the recording Manager, else the Worker's parent, else the Worker. */
const managerOf = (record: TraceRecord): string => (record.role === "manager" ? record.agentId : (record.parentAgentId ?? record.agentId));

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
      figures: familyFiguresOf(outcome.figures, action.family).filter((entry) => entry.crossed),
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
  for (const entry of familyFiguresOf(figures, "budget")) budgets[entry.id] = entry.value >= 100 ? 2 : entry.value >= 50 ? 1 : 0;
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
  for (const entry of familyFiguresOf(figures, "budget")) {
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
 * policy that cannot be read is the empty policy — no project in the scope:
 * the safe side — with one log line. Never throws.
 */
function eventPolicyOf(home: string, log: (message: string) => void = (message) => console.warn(message)): AutonomyPolicy {
  return currentPolicy(home, (reason) => log(`[paseo-bm] could not read the autonomy policy for the Orchestrator's events: ${reason}`));
}

/**
 * The events' scope (design §A.8 Scope, change-007 C1; §F.1): the projects
 * with a class above `owner` in the owner's policy, never a plugin home
 * (missions design §3.1) — those the stall pass and the Worker watch build
 * their events for, and a `danger` signal's wake needs. A policy that cannot
 * be read is the empty scope, the safe side, with one log line. Never throws.
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
 * (missions design §9.7); any other needs its project in `scope`. Whether it
 * wakes the Orchestrator at all is `wakesGovernor`'s.
 */
export function isInEventScope(event: BmEvent, scope: ReadonlySet<string>): boolean {
  return isMissionEvent(event) || scope.has(event.workspaceId);
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
   * One recorded turn (the collector's `onRecorded`): its finished requests
   * count toward the project's advice (design §G.4, `advice-store.ts`), and
   * any event a mission's window held is published. Never rejects.
   */
  turnRecorded(record: TraceRecord | null | undefined, paseo?: unknown): Promise<PublishResult>;
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
      const home = requestId === null ? null : homeOf();
      const workspaceId = (home === null || requestId === null ? null : requestIndexOf(home, requestId))?.workspaceId ?? record.workspaceId;
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

  /** Puts back the events a publish took from `held` and delivered nothing of: they go with the next publish. */
  const keepHeld = (events: ReadonlyMap<string, BmEvent>): void => {
    for (const [key, event] of events) if (!published.has(key) && !inFlight.has(key) && !held.has(key)) held.set(key, event);
  };
  /** Keys a publish is queueing now: remembered only once queued or sent, and never queued twice meanwhile. */
  const inFlight = new Set<string>();

  async function publish(events: readonly BmEvent[], paseo?: unknown, found?: OrchestratorAgentSnapshot | null): Promise<PublishResult> {
    const wasHeld = new Map(held);
    try {
      if (isPaseo(paseo)) lastPaseo = paseo;
      if (events.length === 0 && held.size === 0) return result("none");
      // Missions design §9.1: only the governor's events wake the Orchestrator; the rest are skipped before anything is read.
      const skipped = events.filter((event) => !wakesGovernor(event)).map(eventKeyOf);
      const waking = [...held.values(), ...events.filter(wakesGovernor)];
      held.clear();
      if (waking.length === 0) return result("none", skipped);
      const home = homeOf();
      if (home === null) {
        keepHeld(wasHeld);
        return result("no-data-folder", skipped);
      }
      const scope = eventScopeOf(home, log);
      const fresh: Array<{ event: BmEvent; key: string }> = [];
      for (const event of waking) {
        const key = eventKeyOf(event);
        if (published.has(key) || inFlight.has(key) || fresh.some((entry) => entry.key === key) || !isInEventScope(event, scope)) skipped.push(key);
        else fresh.push({ event, key });
      }
      if (fresh.length === 0) return result("none", skipped);
      const handle = lastPaseo;
      if (handle === null) {
        keepHeld(wasHeld);
        return result("no-paseo", skipped);
      }
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
      for (const { key } of due) inFlight.add(key);
      try {
        const orchestrator = await wakeableOrchestrator(handle, { ...deps, log }, found);
        if (orchestrator === null) return result("no-orchestrator", skipped);
        const items: BatchItem[] = due.map(({ event, key }) => {
          // Read by the batch's onSent, which may run inside enqueueBatch.
          const workspaceId = workspaceOfEvent(event);
          if (workspaceId !== null) workspaceOfKey.set(key, workspaceId);
          eventOfKey.set(key, event);
          return { key, line: eventLineOf(event), isCurrent: isCurrentOf(event, home) };
        });
        const outcomes = await queue.enqueueBatch(orchestrator.id, batch, items, handle as never);
        const done: PublishResult = { status: "done", published: [], skipped };
        due.forEach(({ event, key }, index) => {
          const outcome = outcomes[index];
          if (outcome !== "sent" && outcome !== "queued") {
            // Not queued: published again when a source raises it again.
            workspaceOfKey.delete(key);
            eventOfKey.delete(key);
            skipped.push(key);
            return;
          }
          remember(key);
          done.published.push(key);
          for (const missionId of missionsOfEvent(event)) missionWokenAt.set(missionId, at);
        });
        return done;
      } finally {
        for (const { key } of due) inFlight.delete(key);
      }
    } catch (error) {
      log(`[paseo-bm] publishing events to the Orchestrator failed: ${errorText(error)}`);
      keepHeld(wasHeld);
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
    turnRecorded(record, paseo) {
      countAdvice(unseenFinishesOf(record));
      return publish([], paseo);
    },
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
