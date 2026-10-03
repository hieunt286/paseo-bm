/**
 * The Orchestrator's coordination tools (autonomy design §G.5, §G.6; PRD
 * REQ-134, REQ-135; ADR-021 decision 2; beads `7gxw.10`, `7gxw.11`),
 * registered in `orchestrator-tools.ts`: `bm_compact { agentId, reason }` — a
 * project's Manager or Worker compacts its context — and
 * `bm_handoff { workerId, reason }` — a Worker's request goes to a successor
 * Worker its Manager creates — each on the Orchestrator's own initiative
 * within the owner's Settings → Coordination.
 *
 * `bm_compact`:
 * It is refused, writing nothing, when (in this order):
 * - compaction is off (`compact.enabled`);
 * - the target is the Orchestrator itself, not a paseo-bm Manager or Worker
 *   (a Reviewer is short-lived), archived, or of no project;
 * - a compaction of it is pending (`compaction-store.ts`);
 * - it reached `compact.maxPerAgent` — for a Worker the refusal names a
 *   handoff as the next step;
 * - its provider cannot compact on request (`compactionOnFor`: Claude, Codex
 *   and OpenCode passed the spike; none falls back);
 * - its last measured turn — the newest with usage after its last compaction,
 *   never the compaction's own, whose figure understates — is below its
 *   threshold (`compactCrossingOf`), or no turn of it was measured since.
 *
 * Accepted, it logs a `compact` intervention (trigger `threshold.crossed` when
 * the wake carried that agent's, else `owner` on the owner's word in the
 * Orchestrator's chat, else `orchestrator`), records the compaction and hands
 * it to the runner (`compaction.ts`): the `/compact` goes now when the target
 * is at an idle moment after a safe point, else at the next one.
 *
 * `bm_handoff` (§G.6) is refused, writing nothing, when (in this order):
 * - handoff is off (`handoff.enabled`);
 * - the target is not the Worker of an unfinished request: not a paseo-bm
 *   Worker, archived, of no project, without its request (`bm.requestId`),
 *   already replaced (`bm.replacedBy`), or its request finished;
 * - it has no live Manager of its project (the agent that created it), who
 *   creates the successor;
 * - a handoff of the request is pending (`handoff-store.ts`);
 * - the request reached `handoff.maxPerRequest`;
 * - the request's tokens read since it started, or since its last handoff,
 *   are below `handoff.requestTokens` (`handoffCrossingOf`);
 * - the request's commands reached the loop guard (the command would be
 *   refused there).
 *
 * Accepted, it logs a `handoff` intervention (trigger `threshold.crossed` when
 * the wake carried that request's handoff event, else `owner`, else
 * `orchestrator`), records the handoff and hands it to the runner
 * (`handoff.ts`): the note request goes now when the Worker is at its idle
 * moment after a safe point, else at the next one.
 *
 * Nothing here throws to the endpoint but a `Refusal`.
 */
import { join } from "node:path";
import { COMPACT_OUTCOME, HANDOFF_OUTCOME, INTERVENTION_WINDOW_MS } from "../shared/interventions";
import { compactCrossingOf, compactionOnFor, handoffCrossingOf, type CoordinationRole, type CoordinationSettings, type ThresholdCrossing } from "../shared/coordination";
import { requestFinishedOf, requestTokensReadOf } from "../shared/handoff";
import { tokenProviderOf, turnTokensOf } from "../shared/eval-metrics/tokens";
import type { TraceRecord } from "../shared/contracts";
import { shorten } from "../shared/text";
import { timeOrNull } from "../shared/time";
import { aliasBases } from "./alias-bases";
import { redactText } from "./collector";
import { ownerJustSpoke } from "./command-authority";
import { loopGuardFull } from "./command-send";
import { createHandoffRunner, handoffSafeNow, REPLACED_BY_LABEL, type HandoffRunner } from "./handoff";
import {
  MAX_HANDOFF_REASON_CHARS,
  NOTE_WAIT_MS,
  createHandoffStore,
  handoffsDoneOf,
  lastHandoffAtOf,
  pendingHandoffOf,
} from "./handoff-store";
import { compactCommandOf, createCompactionRunner, safeIdleMoment, type CompactionRunner } from "./compaction";
import {
  MAX_COMPACTION_REASON_CHARS,
  SAFE_POINT_WAIT_MS,
  createCompactionStore,
  pendingCompactionOf,
  sentCompactionsOf,
  type CompactionEntry,
} from "./compaction-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME } from "./data-home";
import { recordIntervention } from "./intervention-store";
import { orchestratorIdOf, refuse, wakeEventsNow, workingAgentsOf, type ServerToolResult, type ToolContext, type ToolDeps } from "./orchestrator-tool-context";
import { providerId } from "./provider-id";
import { readRecords } from "./trace-store";

export interface CompactInput {
  agentId: string;
  reason: string;
}

export interface HandoffInput {
  workerId: string;
  reason: string;
}

export interface CoordinationToolDeps extends ToolDeps {
  /** The runner the plugin shares with its turn ends (`index.server.ts`); one on the call's data folder by default. */
  compaction?: CompactionRunner;
  /** The handoff runner the plugin shares with its turn ends and `agent.created` (`index.server.ts`); one on the call's data folder by default. */
  handoff?: HandoffRunner;
}

/**
 * The turn a threshold is judged on (design §G.5 Verified): the agent's
 * newest turn with usage recorded after its last turn with a compaction —
 * the figure right after a compaction understates, so the next turn's is read
 * — with the turn before it (an OpenCode turn repeating its counts reads 0).
 * Null when none was measured since. Pure.
 */
export function judgedTurnOf(records: readonly TraceRecord[], agentId: string): { record: TraceRecord; previous: TraceRecord | null } | null {
  const own = records
    .filter((record) => record.agentId === agentId)
    .map((record) => ({ record, end: timeOrNull(record.endedAt) ?? timeOrNull(record.at) ?? 0 }))
    .sort((a, b) => a.end - b.end)
    .map(({ record }) => record);
  const lastCompaction = own.findLastIndex((record) => record.evidence.some((evidence) => evidence.kind === "compaction"));
  const measured = own.slice(lastCompaction + 1).filter((record) => record.usage !== null);
  const record = measured.at(-1);
  if (record === undefined) return null;
  return { record, previous: own.slice(0, own.indexOf(record)).filter((candidate) => candidate.usage !== null).at(-1) ?? null };
}

/** Whether a judged turn crosses `role`'s compaction threshold (`compactCrossingOf`), and on which figure. Pure. */
export function judgedCrossingOf(
  role: CoordinationRole,
  judged: { record: TraceRecord; previous: TraceRecord | null },
  settings: Pick<CoordinationSettings, "compact">,
): ThresholdCrossing | null {
  const turn = turnTokensOf(judged.record, judged.previous);
  return compactCrossingOf(role, { coverage: turn.coverage, tokensRead: turn.tokensRead, contextShare: turn.contextShare }, settings);
}

/** What a judged turn showed, below its thresholds: its tokens read and its context share, as far as known. */
function belowWords(role: CoordinationRole, judged: { record: TraceRecord; previous: TraceRecord | null }, settings: Pick<CoordinationSettings, "compact">): string {
  const turn = turnTokensOf(judged.record, judged.previous);
  const threshold = role === "manager" ? settings.compact.managerTokensPerTurn : settings.compact.workerTokensPerTurn;
  const tokens =
    turn.coverage === "turn" && turn.tokensRead !== null
      ? `it read ${turn.tokensRead.toLocaleString("en-US")} tokens (threshold ${threshold.toLocaleString("en-US")})`
      : "its tokens are its last call's only, so its context share decides";
  const share = turn.contextShare === null ? "its context share is not known" : `its context filled ${Math.round(turn.contextShare * 100)} % of its window (threshold ${Math.round(settings.compact.contextShare * 100)} %)`;
  return `in its last measured turn (ended ${judged.record.endedAt ?? judged.record.at}) ${tokens}, and ${share}`;
}

/** The base provider of an agent: its alias's `extends`, else what its turn's model shows (`tokenProviderOf`); null when neither says. */
async function baseProviderOf(provider: unknown, judged: TraceRecord | null, paseo: unknown): Promise<string | null> {
  const alias = providerId(provider);
  const base = alias === null ? undefined : (await aliasBases(paseo))[alias];
  if (base !== undefined) return base;
  const fromTurn = judged === null ? "unknown" : tokenProviderOf(judged);
  return fromTurn === "unknown" ? null : fromTurn;
}

/** `bm_compact` (design §G.5). A refusal writes nothing. */
export async function bmCompact(input: CompactInput, context: ToolContext, deps: CoordinationToolDeps = {}): Promise<ServerToolResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const settings = readCoordinationSettings({ home: context.home, log });
  if (!settings.compact.enabled) refuse("compaction is off in the owner's Settings → Coordination; only the owner turns it on");

  const id = input.agentId;
  if ((await orchestratorIdOf(context)) === id) refuse("you never compact yourself: you are replaced instead, by the plugin");
  const target = (await workingAgentsOf(context)).find((agent) => agent.id === id);
  if (target === undefined) refuse(`${id} is not a paseo-bm Manager or Worker; use an agentId bm_projects gave`);
  if (target.role === "reviewer") refuse(`${id} is a Reviewer: a Reviewer is short-lived and never compacted`);
  const role: CoordinationRole = target.role;
  const who = `${role === "manager" ? "Manager" : "Worker"} ${id}`;
  if (target.archived) refuse(`${who} is archived; nothing is sent to it`);
  if (target.workspaceId === null) refuse(`${who} belongs to no project`);
  const workspaceId = target.workspaceId;

  const store = createCompactionStore(context.home, { now: () => context.now });
  const entries = store.list();
  const pending = pendingCompactionOf(entries, id, context.now);
  if (pending !== null) refuse(`a compaction of ${who} is already pending, requested at ${pending.requestedAt}`);
  const done = sentCompactionsOf(entries, id);
  if (done >= settings.compact.maxPerAgent) {
    refuse(
      role === "worker"
        ? `${who} was compacted ${done} times, the owner's limit per agent (compact.maxPerAgent); its next step is a handoff to a new Worker (bm_handoff)`
        : `${who} was compacted ${done} times, the owner's limit per agent (compact.maxPerAgent); a Manager is not compacted again`,
    );
  }

  let records: TraceRecord[] = [];
  try {
    records = readRecords({ tracesDir: join(context.home, TRACES_DIR_NAME) }, workspaceId).records;
  } catch {
    // No record read: no measured turn, refused below.
  }
  const judged = judgedTurnOf(records, id);
  const listed = (await context.listed()).find((agent) => agent["id"] === id);
  const provider = await baseProviderOf(listed?.["provider"], judged?.record ?? records.filter((record) => record.agentId === id).at(-1) ?? null, context.paseo);
  if (!compactionOnFor(settings, provider) || provider === null) {
    refuse(`${who}'s provider (${provider ?? "not known"}) cannot compact on request; only Claude, Codex and OpenCode can`);
  }
  if (judged === null) refuse(`no turn of ${who} was measured since its last compaction; ask again after its next turn ends`);
  const crossing = judgedCrossingOf(role, judged, settings);
  if (crossing === null) refuse(`${who} is below its threshold: ${belowWords(role, judged, settings)}`);

  // Accepted: the intervention, then the compaction, then its start.
  const wake = await wakeEventsNow(context, deps);
  const crossed = wake.some((event) => event.type === "threshold.crossed" && event.kind === "compact" && event.agentId === id);
  const trigger = crossed ? "threshold.crossed" : (await ownerJustSpoke(context)) ? "owner" : "orchestrator";
  const requestId = role === "worker" ? target.requestIdLabel : null;
  const intervention = recordIntervention(context.home, { kind: "compact", workspaceId, requestId, targetAgentId: id, trigger }, { now: () => context.now, log });
  const entry: CompactionEntry = store.add({
    workspaceId,
    requestId,
    agentId: id,
    role,
    provider: provider as CompactionEntry["provider"],
    interventionId: intervention?.id ?? null,
    reason: shorten(redactText(input.reason, context.env), MAX_COMPACTION_REASON_CHARS),
  });
  const runner = deps.compaction ?? createCompactionRunner({ home: () => context.home, now: () => context.now, log, redactEnv: context.env });
  // Design §16.7: a bound Worker's report is read from the outbox of this data folder.
  const safe = await safeIdleMoment({ id, role, status: target.status, workspaceId }, context.paseo, runner.queue, { home: context.home });
  const started = await runner.begin(entry, context.paseo, safe);

  const minutes = Math.round(SAFE_POINT_WAIT_MS / 60_000);
  const now =
    started === "sent"
      ? `The /compact went out now: ${who} was idle${role === "worker" ? " after a report" : " with nothing queued"}.`
      : started === "queued"
        ? `The /compact is queued: ${who} turned busy a moment ago; it goes at its next idle moment.`
        : `It waits for ${who}'s next idle moment after a safe point (${role === "worker" ? "right after a report" : "with nothing queued for it"}), never inside a running turn, for at most ${minutes} minutes.`;
  const form = compactCommandOf(entry.provider) === "/compact" ? `a bare /compact (${entry.provider}: Paseo drops a focus)` : "/compact with the fixed focus on what must survive";
  return {
    ok: true,
    text: [
      `Compaction ${entry.id} of ${who} accepted: ${crossingText(crossing)}.`,
      now,
      `The plugin sends ${form}, waits for the compaction to complete, then sends the BM-STATE brief built from its records.`,
      `Logged as a compact intervention${intervention === null ? " (the log could not be written)" : ` ${intervention.id}`} with trigger ${trigger}: expected tokens per turn over its next ${COMPACT_OUTCOME.turns} turns at most ${Math.round(COMPACT_OUTCOME.share * 100)} % of the ${COMPACT_OUTCOME.turns} before, within ${Math.round(INTERVENTION_WINDOW_MS.compact / 60_000)} minutes.`,
    ].join("\n"),
  };
}

/** The crossing that let it through, in words. */
function crossingText(crossing: ThresholdCrossing): string {
  return crossing.figure === "contextShare"
    ? `its context filled ${Math.round(crossing.value * 100)} % of its window (threshold ${Math.round(crossing.threshold * 100)} %)`
    : `it read ${Math.round(crossing.value).toLocaleString("en-US")} tokens in one turn (threshold ${Math.round(crossing.threshold).toLocaleString("en-US")})`;
}

/** `bm_handoff` (design §G.6). A refusal writes nothing. */
export async function bmHandoff(input: HandoffInput, context: ToolContext, deps: CoordinationToolDeps = {}): Promise<ServerToolResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const settings = readCoordinationSettings({ home: context.home, log });
  if (!settings.handoff.enabled) refuse("handoff is off in the owner's Settings → Coordination; only the owner turns it on");

  const id = input.workerId;
  const agents = await workingAgentsOf(context);
  const worker = agents.find((agent) => agent.id === id);
  if (worker === undefined || worker.role !== "worker") refuse(`${id} is not a paseo-bm Worker; use a Worker's id from bm_request or bm_projects`);
  const who = `Worker ${id}`;
  if (worker.archived) refuse(`${who} is archived; nothing is handed over from it`);
  if (worker.workspaceId === null) refuse(`${who} belongs to no project`);
  const requestId = worker.requestIdLabel;
  if (requestId === null) refuse(`${who} carries no request (bm.requestId); only the Worker of a request is handed over`);
  const listed = (await context.listed()).find((agent) => agent["id"] === id);
  const replacedBy = ((listed?.["labels"] ?? {}) as Record<string, unknown>)[REPLACED_BY_LABEL];
  if (typeof replacedBy === "string" && replacedBy !== "") refuse(`${who} was already replaced by ${replacedBy}; hand over its successor instead`);
  const workspaceId = worker.workspaceId;

  let records: TraceRecord[] = [];
  try {
    records = readRecords({ tracesDir: join(context.home, TRACES_DIR_NAME) }, workspaceId).records;
  } catch {
    // No record read: nothing measured, refused below.
  }
  if (requestFinishedOf(records, requestId)) refuse(`request ${requestId} is finished; only an unfinished request is handed over`);
  const manager = agents.find((agent) => agent.id === worker.parentAgentId && agent.role === "manager" && !agent.archived && agent.workspaceId === workspaceId);
  if (manager === undefined) refuse(`${who} has no live Manager in its project to create its successor`);

  const store = createHandoffStore(context.home, { now: () => context.now });
  const entries = store.list();
  const pending = pendingHandoffOf(entries, requestId, context.now);
  if (pending !== null) refuse(`a handoff of request ${requestId} is already pending, requested at ${pending.requestedAt}`);
  const done = handoffsDoneOf(entries, requestId).length;
  if (done >= settings.handoff.maxPerRequest) {
    refuse(`request ${requestId} was handed over ${done} times, the owner's limit per request (handoff.maxPerRequest)`);
  }
  const since = lastHandoffAtOf(entries, requestId);
  const tokens = requestTokensReadOf(records, requestId, since);
  const crossing = handoffCrossingOf(tokens, settings);
  if (crossing === null) {
    const read = tokens === null ? "no turn of it was measured" : `it read ${tokens.toLocaleString("en-US")} tokens`;
    refuse(
      `request ${requestId} is below its threshold: since ${since === null ? "it started" : `its last handoff (${new Date(since).toISOString()})`} ${read} (threshold ${settings.handoff.requestTokens.toLocaleString("en-US")})`,
    );
  }
  if (loopGuardFull(context.home, workspaceId, requestId, context.now, deps.store)) {
    refuse(`the commands for request ${requestId} reached the loop guard; ask the owner with bm_ask_owner`);
  }

  // Accepted: the intervention, then the handoff, then its start.
  const wake = await wakeEventsNow(context, deps);
  const crossed = wake.some((event) => event.type === "threshold.crossed" && event.kind === "handoff" && event.requestId === requestId);
  const trigger = crossed ? "threshold.crossed" : (await ownerJustSpoke(context)) ? "owner" : "orchestrator";
  const intervention = recordIntervention(context.home, { kind: "handoff", workspaceId, requestId, targetAgentId: id, trigger }, { now: () => context.now, log });
  const entry = store.add({
    workspaceId,
    requestId,
    workerId: id,
    managerId: manager.id,
    interventionId: intervention?.id ?? null,
    reason: shorten(redactText(input.reason, context.env), MAX_HANDOFF_REASON_CHARS),
  });
  const runner = deps.handoff ?? createHandoffRunner({ home: () => context.home, now: () => context.now, log, redactEnv: context.env });
  const safe = await handoffSafeNow({ id, status: worker.status }, context.paseo, records, runner.queue);
  const started = await runner.begin(entry, context.paseo, safe);

  const minutes = (ms: number) => Math.round(ms / 60_000);
  const now =
    started === "asked"
      ? `${who} was idle after a safe point: it was asked for its handoff note now.`
      : started === "queued"
        ? `${who} turned busy a moment ago: it is asked for its handoff note at its next idle moment.`
        : `It waits for ${who}'s next safe point (a bead closed, beads-done or a review verdict) and idle moment, never inside a running turn, for at most ${minutes(INTERVENTION_WINDOW_MS.handoff)} minutes.`;
  return {
    ok: true,
    text: [
      `Handoff ${entry.id} of request ${requestId} accepted: its request read ${Math.round(crossing.value).toLocaleString("en-US")} tokens since ${since === null ? "it started" : "its last handoff"} (threshold ${Math.round(crossing.threshold).toLocaleString("en-US")}).`,
      now,
      `The plugin waits at most ${minutes(NOTE_WAIT_MS)} minutes for the note, builds the brief from its records, and sends Manager ${manager.id} a BM-COMMAND (intent handoff) to create the successor with it; ${who} stays idle and is never archived.`,
      `Logged as a handoff intervention${intervention === null ? " (the log could not be written)" : ` ${intervention.id}`} with trigger ${trigger}: expected the successor's tokens per turn at most ${Math.round(HANDOFF_OUTCOME.share * 100)} % of ${who}'s last ${HANDOFF_OUTCOME.turns}, and a report from it, within ${minutes(INTERVENTION_WINDOW_MS.handoff)} minutes.`,
    ].join("\n"),
  };
}
