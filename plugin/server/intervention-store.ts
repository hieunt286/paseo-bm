/**
 * The coordination intervention log (autonomy design §G.3, REQ-127, ADR-021):
 * `<data folder>/orchestrator/interventions.json` =
 * `{ version: 1, entries: [<InterventionEntry>, …] }`, oldest first, with the
 * outcome each intervention reached (A-12).
 *
 * - **Recorded at the source** (`recordIntervention`), never blocking or
 *   failing the intervention itself — a failure is one log line:
 *   `bm_decide` records an `answer` (`interventionOfDecision`);
 *   `bm_send_command` and `bm_direct_worker` record the command, with its id
 *   in the commands store (`commandId`, `command-send.ts`), by the event
 *   it answers (`interventionOfCommand`): a command the Orchestrator sends in
 *   the turn of a wake is attributed to that wake's events (the event bus
 *   keeps them in memory beside the wake record, `wakeEventsOf`) —
 *   `request.stalled` of the same request → `unblock`, `worker.signal` of the
 *   same Worker → `correct`, an `interrupt` → `stop` whatever the events; a
 *   command matching no event of its wake is a `correct` with trigger `owner`
 *   when it went on the owner's word in the Orchestrator's chat, else not
 *   logged; `bm_ask_owner` records an `advice` (`interventionOfAdvice`, design
 *   §G.4) for a decision it leaves open for the owner that carries a prepared
 *   change of the owner's settings, or that is about a whole project in the
 *   wake of that project's `advice.due`; `bm_compact` records a `compact`
 *   and `bm_handoff` a `handoff` (`orchestrator-coordination-tools.ts`,
 *   design §G.5, §G.6).
 * - **The check** (`checkInterventions`): each pending entry is judged from
 *   the stores (`outcomeOf`) — the decision store, the Inbox alerts, the
 *   trace records, the compactions, the handoffs. `met` as soon as the stores show the expected outcome
 *   within the window; `missed` once they show it did not come within it;
 *   `unknown` when, the window over, they cannot tell. A pass runs on
 *   `agent.turn_ended`, throttled like the outdated-agents pass
 *   (`createInterventionCheck`): `index.server.ts` runs it at each turn end
 *   the collector records, so it adds no lifecycle hook of its own and finds
 *   that turn's record in the store.
 *
 * The file rules are every store's (`data-files.ts` `createJsonFileStore`,
 * code review 2026-09-30 §3.1): the folder is created `0700` only by a write,
 * never by a read; the file is `0600` and replaced atomically; a symlink
 * anywhere below the data folder is refused. A missing or corrupt file reads
 * as empty; an entry that does not validate is skipped on its own and dropped
 * by the next write; a file whose `version` is newer than this build reads as
 * empty and is never written — a write throws `E_TRACE_STORE_UNWRITABLE`, the
 * code of every failure of this file. The newest `INTERVENTION_LOG_LIMIT`
 * entries are kept. The file lives in the Orchestrator's folder, so the
 * cleanup deletes it with `orchestrator/`; `orchestrator-store.ts` keeps the
 * rest of that folder.
 *
 * **No lock, on purpose:** every operation is synchronous and the plugin
 * server is one thread, so a read-modify-write cannot interleave.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Alert } from "../shared/alerts";
import type { TraceRecord } from "../shared/contracts";
import { UNSETTLED_STATUSES, type Decision } from "../shared/decisions";
import { turnTokensOf } from "../shared/eval-metrics/tokens";
import {
  COMPACT_OUTCOME,
  EXPECTED_OUTCOME_OF,
  HANDOFF_OUTCOME,
  INTERVENTIONS_FILE_VERSION,
  INTERVENTION_SETTLE_MS,
  INTERVENTION_WINDOW_MS,
  interventionEntrySchema,
  reportChecksOf,
  type InterventionEntry,
  type InterventionKind,
  type InterventionOutcome,
  type InterventionTrigger,
} from "../shared/interventions";
import type { WorkerSignal } from "../shared/orchestrator";
import { createAlertStore } from "./alert-store";
import { createCompactionStore, staleEndingOf, type CompactionEntry } from "./compaction-store";
import { capBy, createJsonFileStore, entriesOf } from "./data-files";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import { createDecisionStore } from "./decision-store";
import type { BmEvent, RequestStalledEvent, WorkerSignalEvent } from "./event-bus";
import { createHandoffStore, isPendingHandoffState, staleEndingOf as staleHandoffEndingOf, type HandoffEntry } from "./handoff-store";
import { ORCHESTRATOR_DIR_NAME } from "./orchestrator-store";
import { readRecords, type TraceStoreLocation } from "./trace-store";
import { errorText } from "./rpc-kit";
import { timeOrNull } from "../shared/time";

export const INTERVENTIONS_FILE = "interventions.json";
/** The newest entries kept (design §G.3). */
export const INTERVENTION_LOG_LIMIT = 2_000;

export interface InterventionStoreDeps {
  now?: () => Date;
  /** A new entry id; `randomUUID` by default. */
  newId?: () => string;
}

/** What `record` takes: the rest (`expected`, `windowMs`, `at`, `outcome`) follows from the kind and the clock. */
export interface InterventionInput {
  kind: InterventionKind;
  workspaceId: string;
  requestId: string | null;
  targetAgentId: string | null;
  trigger: InterventionTrigger;
  decisionId?: string;
  alertKey?: string;
  signal?: WorkerSignal;
  commandId?: string;
}

export interface InterventionStore {
  /** `<data folder>/orchestrator/interventions.json`. */
  readonly path: string;
  /** Appends one `pending` entry with its kind's expected outcome and window, at now. */
  record(input: InterventionInput): InterventionEntry;
  /** Every entry, oldest first. */
  list(): InterventionEntry[];
  /** Settles the named pending entries at now, in one write; returns the entries it changed. */
  settle(outcomes: ReadonlyArray<{ id: string; outcome: Exclude<InterventionOutcome, "pending"> }>): InterventionEntry[];
}

/** The store rooted at the data folder `home`. Creating it touches nothing on disk. */
export function createInterventionStore(home: string, deps: InterventionStoreDeps = {}): InterventionStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;
  const file = createJsonFileStore<{ entries: InterventionEntry[] }>({
    home,
    dir: ORCHESTRATOR_DIR_NAME,
    file: INTERVENTIONS_FILE,
    version: INTERVENTIONS_FILE_VERSION,
    parse: (body) => ({ entries: entriesOf(interventionEntrySchema, body["entries"]) }),
    empty: () => ({ entries: [] }),
    cap: ({ entries }) => ({ entries: capBy(entries, INTERVENTION_LOG_LIMIT) }),
    // The code this file has always had; a newer file's refusal gets it too (it used to be a plain Error).
    codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" },
  });

  return {
    path: file.path,

    record(input) {
      const entry = interventionEntrySchema.parse({
        id: newId(),
        kind: input.kind,
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        targetAgentId: input.targetAgentId,
        trigger: input.trigger,
        expected: EXPECTED_OUTCOME_OF[input.kind],
        windowMs: INTERVENTION_WINDOW_MS[input.kind],
        at: now().toISOString(),
        outcome: "pending",
        checkedAt: null,
        ...(input.decisionId === undefined ? {} : { decisionId: input.decisionId }),
        ...(input.alertKey === undefined ? {} : { alertKey: input.alertKey }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      });
      file.update(({ entries }) => ({ entries: [...entries, entry] }));
      return entry;
    },

    list() {
      return file.read().entries;
    },

    settle(outcomes) {
      if (outcomes.length === 0) return [];
      const wanted = new Map(outcomes.map((entry) => [entry.id, entry.outcome]));
      const at = now().toISOString();
      const changed: InterventionEntry[] = [];
      const entries = file.read().entries.map((entry) => {
        const outcome = wanted.get(entry.id);
        if (outcome === undefined || entry.outcome !== "pending") return entry;
        const settled: InterventionEntry = { ...entry, outcome, checkedAt: at };
        changed.push(settled);
        return settled;
      });
      // Nothing to change writes nothing, so a newer file refuses only a real change.
      if (changed.length > 0) file.write({ entries });
      return changed;
    },
  };
}

// ---------------------------------------------------------------------------
// Recording at the source.
// ---------------------------------------------------------------------------

/** One delivered command of the Orchestrator, as `interventionOfCommand` reads it. */
export interface CommandFacts {
  workspaceId: string;
  /** The command's request; for a Worker's command without one, the Worker's request. */
  requestId: string | null;
  to: "manager" | "worker";
  /** The Manager or Worker the command went to. */
  targetAgentId: string;
  /** Sent at once, replacing the Worker's running turn. */
  interrupt: boolean;
  /** It went on the owner's word in the Orchestrator's chat (authority `owner`). */
  ownerAsked: boolean;
  /** Its id in the commands store (`command-send.ts`), carried onto the entry. */
  commandId?: string;
}

/**
 * The intervention a delivered command is, from the events of the wake whose
 * turn sent it (design §G.3), or null when it is not logged. An interrupt is
 * a `stop`. Otherwise a `request.stalled` of the command's request makes it
 * an `unblock`, else a `worker.signal` of the Worker it went to a `correct`;
 * a command matching no event is a `correct` with trigger `owner` when the
 * owner asked for it, else null. Pure.
 */
export function interventionOfCommand(command: CommandFacts, wakeEvents: readonly BmEvent[]): InterventionInput | null {
  const base = {
    workspaceId: command.workspaceId,
    requestId: command.requestId,
    targetAgentId: command.targetAgentId,
    ...(command.commandId === undefined ? {} : { commandId: command.commandId }),
  };
  const signal =
    command.to === "worker"
      ? wakeEvents.find(
          (event): event is WorkerSignalEvent =>
            event.type === "worker.signal" && event.workspaceId === command.workspaceId && event.workerId === command.targetAgentId,
        )
      : undefined;
  if (command.interrupt) {
    return {
      ...base,
      kind: "stop",
      trigger: signal !== undefined ? "worker.signal" : command.ownerAsked ? "owner" : "orchestrator",
      ...(signal === undefined ? {} : { signal: signal.signal }),
    };
  }
  const stalled =
    command.requestId === null
      ? undefined
      : wakeEvents.find(
          (event): event is RequestStalledEvent =>
            event.type === "request.stalled" && event.workspaceId === command.workspaceId && event.requestKey === command.requestId,
        );
  if (stalled !== undefined) return { ...base, kind: "unblock", trigger: "request.stalled", alertKey: stalled.alertKey };
  if (signal !== undefined) {
    return { ...base, kind: "correct", trigger: "worker.signal", signal: signal.signal, ...(signal.alertKey === null ? {} : { alertKey: signal.alertKey }) };
  }
  return command.ownerAsked ? { ...base, kind: "correct", trigger: "owner" } : null;
}

/**
 * The `answer` a Worker's question answered with `bm_decide` is: its target
 * the Worker that asked, triggered by its `decision.opened` when the wake
 * carried it, else on the Orchestrator's own look. Pure.
 */
export function interventionOfDecision(decision: Pick<Decision, "id" | "workspaceId" | "requestId" | "askedBy">, wakeEvents: readonly BmEvent[]): InterventionInput {
  const opened = wakeEvents.some((event) => event.type === "decision.opened" && event.decisionId === decision.id);
  return {
    kind: "answer",
    workspaceId: decision.workspaceId,
    requestId: decision.requestId,
    targetAgentId: decision.askedBy.agentId,
    trigger: opened ? "decision.opened" : "orchestrator",
    decisionId: decision.id,
  };
}

/**
 * The `advice` an Orchestrator decision is (design §G.3, §G.4), or null when
 * it is none: a decision the owner is left to answer is advice when it
 * carries a prepared change of the owner's settings, or when the wake that
 * asked it carried its project's `advice.due` and it is about the whole
 * project. The trigger is that `advice.due` when the wake carried it; else
 * the owner's word in the Orchestrator's chat (`owner`), else the
 * Orchestrator's own look (`orchestrator`). It targets no agent: its outcome
 * is the owner's answer within 7 days. Pure.
 */
export function interventionOfAdvice(
  decision: Pick<Decision, "id" | "workspaceId" | "requestId"> & { preparedChange: boolean },
  wakeEvents: readonly BmEvent[],
  ownerAsked: boolean,
): InterventionInput | null {
  const due = wakeEvents.some((event) => event.type === "advice.due" && event.workspaceId === decision.workspaceId);
  if (!decision.preparedChange && !(due && decision.requestId === null)) return null;
  return {
    kind: "advice",
    workspaceId: decision.workspaceId,
    requestId: decision.requestId,
    targetAgentId: null,
    trigger: due ? "advice.due" : ownerAsked ? "owner" : "orchestrator",
    decisionId: decision.id,
  };
}

export interface RecordInterventionDeps extends InterventionStoreDeps {
  /** Where a failed write is reported; `console.warn` by default. */
  log?: (message: string) => void;
}

/**
 * Records one intervention in the data folder `home`. Never throws: without a
 * data folder, or with nothing to record, it records nothing; a failed write
 * is one log line, and the intervention it describes stands.
 */
export function recordIntervention(home: string | null, input: InterventionInput | null, deps: RecordInterventionDeps = {}): InterventionEntry | null {
  if (home === null || input === null) return null;
  try {
    return createInterventionStore(home, deps).record(input);
  } catch (error) {
    (deps.log ?? ((message: string) => console.warn(message)))(`[paseo-bm] could not record the ${input.kind} intervention: ${errorText(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The outcome check.
// ---------------------------------------------------------------------------

/**
 * What the stores hold for one entry. A field is `undefined` when it was not
 * or could not be read, `null` (decision, alert) when the store has none.
 */
export interface InterventionEvidence {
  /** The entry's `decisionId`, from the decision store. */
  decision?: Decision | null;
  /** The entry's `alertKey`, from the Inbox alerts. */
  alert?: Alert | null;
  /** The trace records of the entry's workspace. */
  records?: readonly TraceRecord[];
  /** A `compact`'s compaction (`compaction-store.ts`, by its `interventionId`); null when the store has none. */
  compaction?: CompactionEntry | null;
  /** A `handoff`'s handoff (`handoff-store.ts`, by its `interventionId`); null when the store has none. */
  handoff?: HandoffEntry | null;
}

/** The kinds whose check reads the trace records. */
const READS_RECORDS: ReadonlySet<InterventionKind> = new Set(["answer", "correct", "stop", "compact", "handoff"]);

interface Window {
  at: number;
  end: number;
  /** The window and its settle margin are over: an absence of evidence now counts. */
  over: boolean;
}

/** The earliest start, at or after `from`, of a turn of `agentId`; null when none is recorded. */
function firstTurnFrom(records: readonly TraceRecord[] | undefined, agentId: string | null, from: number): TraceRecord | null {
  let first: TraceRecord | null = null;
  let firstAt = Number.POSITIVE_INFINITY;
  for (const record of records ?? []) {
    const started = timeOrNull(record.startedAt);
    if (agentId === null || record.agentId !== agentId || started === null || started < from) continue;
    if (started < firstAt) {
      first = record;
      firstAt = started;
    }
  }
  return first;
}

/** The first report of `requestId` after `from` and by `until`; null when none. */
function nextReportOf(records: readonly TraceRecord[] | undefined, requestId: string | null, from: number, until: number) {
  if (requestId === null) return null;
  let next: TraceRecord["reports"][number] | null = null;
  let nextAt = Number.POSITIVE_INFINITY;
  for (const record of records ?? []) {
    for (const report of record.reports) {
      const reported = timeOrNull(report.at);
      if ((report.requestId ?? record.requestId) !== requestId || reported === null || reported <= from || reported > until) continue;
      if (reported < nextAt) {
        next = report;
        nextAt = reported;
      }
    }
  }
  return next;
}

/**
 * When the alert of an entry stopped holding, as far as the store tells:
 * `{ at }` its clearing; `{ before }` for a key raised afresh after the
 * intervention, which cleared before its new `since`; `open` while it holds;
 * null when it cannot be told.
 */
function alertEndOf(alert: Alert | null | undefined, from: number): { at: number } | { before: number } | "open" | null {
  if (alert === undefined || alert === null) return null;
  const since = timeOrNull(alert.since);
  if (since !== null && since > from) return { before: since };
  const cleared = timeOrNull(alert.clearedAt);
  if (alert.clearedAt === null) return "open";
  return cleared === null ? null : { at: cleared };
}

/** `answer`: the Worker resumes — the answer was sent to it, or one of its turns started — within the window. */
function answerOutcome(entry: InterventionEntry, evidence: InterventionEvidence, w: Window): InterventionOutcome {
  const delivery = evidence.decision?.delivery ?? null;
  const sentAt = delivery?.outcome === "sent" ? timeOrNull(delivery.at) : null;
  const resumed = firstTurnFrom(evidence.records, entry.targetAgentId, w.at);
  const resumedAt = resumed === null ? null : timeOrNull(resumed.startedAt);
  if ((sentAt !== null && sentAt <= w.end) || (resumedAt !== null && resumedAt <= w.end)) return "met";
  if (!w.over) return "pending";
  // Sent or resumed late, still waiting for the Worker's turn to end, or no live Worker to take it.
  if (sentAt !== null || resumedAt !== null || delivery?.outcome === "queued" || delivery?.outcome === "failed") return "missed";
  return "unknown";
}

/** `unblock`: the stall alert clears within the window. */
function unblockOutcome(evidence: InterventionEvidence, w: Window): InterventionOutcome {
  const end = alertEndOf(evidence.alert, w.at);
  if (end === null) return w.over ? "unknown" : "pending";
  if (end === "open") return w.over ? "missed" : "pending";
  if ("before" in end) return end.before <= w.end ? "met" : w.over ? "unknown" : "pending";
  return end.at <= w.end ? "met" : "missed";
}

/**
 * `correct`: the signal clears (an alert signal's alert), or the request's
 * next report within the window says its checks pass. A signal without an
 * alert is settled by that report alone; an alert signal waits for the
 * window to end, as its alert may still clear.
 */
function correctOutcome(entry: InterventionEntry, evidence: InterventionEvidence, w: Window): InterventionOutcome {
  const alertEnd = entry.alertKey === undefined ? null : alertEndOf(evidence.alert, w.at);
  if (alertEnd !== null && alertEnd !== "open" && ("before" in alertEnd ? alertEnd.before : alertEnd.at) <= w.end) return "met";
  const report = nextReportOf(evidence.records, entry.requestId, w.at, w.end);
  const checks = report === null ? null : reportChecksOf(report.buildAndTests);
  if (checks === "pass") return "met";
  if (entry.alertKey === undefined) {
    if (report !== null) return checks === "fail" ? "missed" : "unknown";
    return w.over ? "unknown" : "pending";
  }
  if (!w.over) return "pending";
  if (alertEnd === "open" || (alertEnd !== null && "at" in alertEnd) || checks === "fail") return "missed";
  return "unknown";
}

/**
 * `stop`: the turn the stop started — the Worker's first turn from the
 * interrupt on — ends within the window. A turn is recorded when it ends, so
 * once the window is over no such turn means it ran on.
 */
function stopOutcome(entry: InterventionEntry, evidence: InterventionEvidence, w: Window): InterventionOutcome {
  const turn = firstTurnFrom(evidence.records, entry.targetAgentId, w.at);
  if (turn !== null) {
    const ended = timeOrNull(turn.endedAt);
    if (ended !== null) return ended <= w.end ? "met" : "missed";
  }
  if (!w.over) return "pending";
  return evidence.records === undefined || entry.targetAgentId === null ? "unknown" : "missed";
}

/** `advice`: the owner answered the advice decision within the window. */
function adviceOutcome(evidence: InterventionEvidence, w: Window): InterventionOutcome {
  const decision = evidence.decision;
  if (decision === undefined || decision === null) return w.over ? "unknown" : "pending";
  if (decision.status === "answered") {
    const answered = timeOrNull(decision.answer?.at ?? decision.settledAt);
    return answered !== null && answered <= w.end ? "met" : "missed";
  }
  if (UNSETTLED_STATUSES.includes(decision.status)) return w.over ? "missed" : "pending";
  // Superseded, withdrawn or expired without the owner's answer.
  return "missed";
}

/** One measured turn of an agent: when it ended, and its tokens read (`turnTokensOf`). */
interface MeasuredTurn {
  end: number;
  tokens: number;
}

/**
 * An agent's turns with usage, oldest first, and the ends of its turns with a
 * compaction. A turn with a compaction is not measured: its figures
 * understate (spike run note 2026-09-30 §2); nor is an OpenCode turn that only
 * repeated its previous counts.
 */
function agentTurnsOf(records: readonly TraceRecord[], agentId: string): { measured: MeasuredTurn[]; compactions: number[] } {
  const own = records
    .filter((record) => record.agentId === agentId)
    .map((record) => ({ record, end: timeOrNull(record.endedAt) ?? timeOrNull(record.at) }))
    .filter((turn): turn is { record: TraceRecord; end: number } => turn.end !== null)
    .sort((a, b) => a.end - b.end);
  const measured: MeasuredTurn[] = [];
  const compactions: number[] = [];
  let previous: TraceRecord | null = null;
  for (const { record, end } of own) {
    if (record.evidence.some((evidence) => evidence.kind === "compaction")) compactions.push(end);
    else if (record.usage !== null) {
      const tokens = turnTokensOf(record, previous);
      if (tokens.tokensRead !== null && !tokens.repeated) measured.push({ end, tokens: tokens.tokensRead });
    }
    if (record.usage !== null) previous = record;
  }
  return { measured, compactions };
}

const meanOf = (turns: readonly MeasuredTurn[]): number => turns.reduce((sum, turn) => sum + turn.tokens, 0) / turns.length;

/**
 * `compact` (design §G.3, §G.5): the target's tokens read per turn over its
 * next three measured turns after the compaction are at most 60 % of those
 * over the three before its `/compact` (`COMPACT_OUTCOME`). The window runs
 * from the `/compact` (from the entry while it has not gone out): three turns,
 * at most `windowMs`; once it is over, the turns it holds are judged, and
 * none is unknown. A compaction that never went out — dropped, or waiting past
 * its bound — is unknown: the intervention did not happen. Without a turn
 * before it there is nothing to compare with.
 */
function compactOutcome(entry: InterventionEntry, evidence: InterventionEvidence, at: number, now: number): InterventionOutcome {
  const compaction = evidence.compaction ?? null;
  if (compaction !== null && compaction.sentAt === null) {
    return compaction.state !== "waiting" || staleEndingOf(compaction, now) !== null ? "unknown" : "pending";
  }
  const from = timeOrNull(compaction?.sentAt) ?? at;
  const end = from + entry.windowMs;
  const over = now >= end + INTERVENTION_SETTLE_MS;
  if (entry.targetAgentId === null || evidence.records === undefined) return over ? "unknown" : "pending";
  const { measured, compactions } = agentTurnsOf(evidence.records, entry.targetAgentId);
  // The compaction's own turn, from the send on (a little clock slack); the turns after it are judged.
  const compactedAt = compactions.find((ended) => ended >= from - 5_000) ?? from;
  const before = measured.filter((turn) => turn.end <= from).slice(-COMPACT_OUTCOME.turns);
  const after = measured.filter((turn) => turn.end > compactedAt && turn.end <= end).slice(0, COMPACT_OUTCOME.turns);
  if (before.length > 0 && (after.length >= COMPACT_OUTCOME.turns || (over && after.length > 0))) {
    return meanOf(after) <= COMPACT_OUTCOME.share * meanOf(before) ? "met" : "missed";
  }
  return over ? "unknown" : "pending";
}

/**
 * `handoff` (design §G.3, §G.6): the successor's tokens read per turn over
 * its first three measured turns are at most 50 % of the outgoing Worker's
 * over its last three before the successor appeared (`HANDOFF_OUTCOME`), and
 * the successor reports progress — a report of the request that is not
 * `blocked` — within the window, which runs from the successor's creation
 * (from the entry while there is none yet). Tokens above the share are
 * missed at once; within it, the report decides, missed when none came by
 * the window's end. A handoff that ended without a successor is unknown: the
 * intervention did not happen; so is one with no turn to compare.
 */
function handoffOutcome(entry: InterventionEntry, evidence: InterventionEvidence, at: number, now: number): InterventionOutcome {
  const handoff = evidence.handoff ?? null;
  if (handoff !== null && handoff.successorId === null) {
    return isPendingHandoffState(handoff.state) && staleHandoffEndingOf(handoff, now) === null ? "pending" : "unknown";
  }
  const from = timeOrNull(handoff?.successorAt) ?? at;
  const end = from + entry.windowMs;
  const over = now >= end + INTERVENTION_SETTLE_MS;
  if (handoff === null || handoff.successorId === null || evidence.records === undefined) return over ? "unknown" : "pending";
  const records = evidence.records;
  const before = agentTurnsOf(records, handoff.workerId).measured.filter((turn) => turn.end <= from).slice(-HANDOFF_OUTCOME.turns);
  const after = agentTurnsOf(records, handoff.successorId)
    .measured.filter((turn) => turn.end > from && turn.end <= end)
    .slice(0, HANDOFF_OUTCOME.turns);
  const progressed = records.some((record) =>
    record.reports.some((report) => {
      const reported = timeOrNull(report.at);
      return (report.requestId ?? record.requestId) === handoff.requestId && report.phase !== null && report.phase !== "blocked" && reported !== null && reported > from && reported <= end;
    }),
  );
  if (before.length > 0 && (after.length >= HANDOFF_OUTCOME.turns || (over && after.length > 0))) {
    if (meanOf(after) > HANDOFF_OUTCOME.share * meanOf(before)) return "missed";
    if (progressed) return "met";
    return over ? "missed" : "pending";
  }
  return over ? "unknown" : "pending";
}

/**
 * The outcome of one entry at `now`, from what the stores hold (design
 * §G.3). A settled entry keeps its outcome. Pure.
 */
export function outcomeOf(entry: InterventionEntry, evidence: InterventionEvidence, now: Date | number): InterventionOutcome {
  if (entry.outcome !== "pending") return entry.outcome;
  const at = timeOrNull(entry.at);
  if (at === null) return "unknown";
  const end = at + entry.windowMs;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const w: Window = { at, end, over: nowMs >= end + INTERVENTION_SETTLE_MS };
  switch (entry.kind) {
    case "answer":
      return answerOutcome(entry, evidence, w);
    case "unblock":
      return unblockOutcome(evidence, w);
    case "correct":
      return correctOutcome(entry, evidence, w);
    case "stop":
      return stopOutcome(entry, evidence, w);
    case "advice":
      return adviceOutcome(evidence, w);
    case "compact":
      return compactOutcome(entry, evidence, at, nowMs);
    case "handoff":
      return handoffOutcome(entry, evidence, at, nowMs);
  }
}

export interface CheckInterventionsDeps {
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * One check: every pending entry judged from the stores (`outcomeOf`), the
 * settled ones written at once. A store that cannot be read is evidence not
 * read (`undefined`), never an error. Returns the entries it settled.
 */
export function checkInterventions(home: string, deps: CheckInterventionsDeps = {}): InterventionEntry[] {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.warn(message));
  const store = createInterventionStore(home, { now });
  const pending = store.list().filter((entry) => entry.outcome === "pending");
  if (pending.length === 0) return [];
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };
  const decisions = createDecisionStore(home, { log });
  const alerts = createAlertStore(home);
  const recordsByWorkspace = new Map<string, readonly TraceRecord[] | undefined>();
  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  const recordsOf = (workspaceId: string): readonly TraceRecord[] | undefined => {
    if (!recordsByWorkspace.has(workspaceId)) recordsByWorkspace.set(workspaceId, attempt(() => readRecords(location, workspaceId).records));
    return recordsByWorkspace.get(workspaceId);
  };
  // Read once, and only when a `compact` is pending.
  let compactions: readonly CompactionEntry[] | undefined | null = null;
  const compactionOf = (id: string): CompactionEntry | null | undefined => {
    if (compactions === null) compactions = attempt(() => createCompactionStore(home).list());
    return compactions === undefined ? undefined : (compactions.find((compaction) => compaction.interventionId === id) ?? null);
  };
  // Read once, and only when a `handoff` is pending.
  let handoffs: readonly HandoffEntry[] | undefined | null = null;
  const handoffOf = (id: string): HandoffEntry | null | undefined => {
    if (handoffs === null) handoffs = attempt(() => createHandoffStore(home).list());
    return handoffs === undefined ? undefined : (handoffs.find((handoff) => handoff.interventionId === id) ?? null);
  };
  const at = now();
  const outcomes: Array<{ id: string; outcome: Exclude<InterventionOutcome, "pending"> }> = [];
  for (const entry of pending) {
    const { decisionId, alertKey } = entry;
    const evidence: InterventionEvidence = {
      ...(decisionId === undefined ? {} : { decision: attempt(() => decisions.get(decisionId, entry.workspaceId)) }),
      ...(alertKey === undefined ? {} : { alert: attempt(() => alerts.get(alertKey)) }),
      ...(READS_RECORDS.has(entry.kind) ? { records: recordsOf(entry.workspaceId) } : {}),
      ...(entry.kind === "compact" ? { compaction: compactionOf(entry.id) } : {}),
      ...(entry.kind === "handoff" ? { handoff: handoffOf(entry.id) } : {}),
    };
    const outcome = outcomeOf(entry, evidence, at);
    if (outcome !== "pending") outcomes.push({ id: entry.id, outcome });
  }
  return store.settle(outcomes);
}

/** Least time between two passes, as the outdated-agents pass. */
export const INTERVENTION_CHECK_INTERVAL_MS = 60_000;

export interface InterventionCheckDeps extends DataHomeDeps {
  /** Least time between two passes. Defaults to `INTERVENTION_CHECK_INTERVAL_MS`. */
  intervalMs?: number;
  now?: () => number;
  /** Where a failed pass is reported. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

export interface InterventionCheck {
  /** Runs a check unless one ran within the interval; returns what it settled. Never throws. */
  run(): InterventionEntry[];
}

/** One throttled check per plugin run, on the data folder's stores. */
export function createInterventionCheck(deps: InterventionCheckDeps = {}): InterventionCheck {
  const intervalMs = deps.intervalMs ?? INTERVENTION_CHECK_INTERVAL_MS;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((message: string) => console.warn(message));
  let lastStart = Number.NEGATIVE_INFINITY;
  return {
    run() {
      const at = now();
      if (at - lastStart < intervalMs) return [];
      lastStart = at;
      try {
        const home = resolveDataHome(deps).home;
        return home === null ? [] : checkInterventions(home, { now: () => new Date(at), log });
      } catch (error) {
        log(`[paseo-bm] could not check the outcomes of the Orchestrator's interventions: ${errorText(error)}`);
        return [];
      }
    },
  };
}
