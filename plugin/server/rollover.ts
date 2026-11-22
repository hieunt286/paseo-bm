/**
 * Size rollover (delivery line design §2.6; ADR-035 decision 1): a bound
 * request that grew past the owner's figures ends, and its work goes on as a
 * continuation.
 *
 * At each recorded turn of a request's newest Worker (the hook the handoff
 * uses), the request's figures — beads closed in its reports, its Worker
 * turns, its tokens read, and that turn's own context (ADR-036, §17.3) — are
 * compared with `rollover.*`:
 *
 * - **Soft**: one figure reached queues `BM-ROLLOVER soft` once per request.
 *   A Worker that waits by structure (§6.4) gets it at a turn end after its
 *   wake; one that reported `blocked` while it was queued has it held at the
 *   send (`holdsAtSend`), forgotten, and asked again at a later turn end.
 * - **Now**: `rollover.ceilingFactor` × one figure, or a soft notice that has
 *   waited `MAINTENANCE_WAIT_MS.rollover` (30 minutes) without the request
 *   rolling over (the time ceiling, ADR-051 decision 2), queues `BM-ROLLOVER now`,
 *   once, at once (`rollover-now` is on the wake gate's always-at-once list),
 *   ahead of what is queued for the Worker (`first`, the maintenance
 *   ceiling's order, §6.6). It never waits for a review: `finished` with
 *   `remaining` is then accepted, and the batch goes onto the continuation
 *   (ADR-046). It is the current Worker's: a Worker whose handoff is under
 *   way is not asked, and a later Worker of the request is asked again,
 *   whatever its own figures (a stored `now` from an older build, which names
 *   no Worker, is not).
 *
 * The request's registry entry keeps the newest notice (`rolloverAsked`).
 * `bm_report` reads it: a `finished` with `remaining` then opens the size
 * continuation (`deliver-tools.ts`, `continuation.ts`).
 *
 * Nothing here throws: a failure is one log line.
 */
import { join } from "node:path";
import type { TraceRecord } from "../shared/contracts";
import type { CoordinationSettings } from "../shared/coordination";
import { requestTokensReadOf } from "../shared/handoff";
import { MAINTENANCE_WAIT_MS } from "../shared/interventions";
import { ROLLOVER_NOTICE_MARKER } from "../shared/notices";
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME } from "./data-home";
import { createHandoffStore, isPendingHandoffState } from "./handoff-store";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { createRequestRegistry, isBoundRequest, type RegisteredRequest } from "./request-registry";
import { errorText } from "./rpc-kit";
import { readRecords } from "./trace-store";
import { gatedWaitOf, holdsAtSend, wakeGate } from "./wake-gate";

export type RolloverLevel = "soft" | "now";

/**
 * A request's size (§2.6): beads closed in its reports, its Worker turns, its
 * tokens read, and (§17.3) the context of the Worker's turn being judged —
 * null when that turn's provider reported none.
 */
export interface RolloverFigures {
  beads: number;
  turns: number;
  tokens: number;
  context: number | null;
}

/**
 * The figures of `requestId` in its workspace's turn records. `turn` is the
 * recorded turn being judged: its `contextUsed` (the field the Main's
 * compaction reads, mission runtime design §3.1) is the context figure — that
 * turn's own, never a sum over turns. Pure.
 */
export function rolloverFiguresOf(records: readonly TraceRecord[], requestId: string, turn: Pick<TraceRecord, "usage"> | null = null): RolloverFigures {
  const own = records.filter((record) => record.requestId === requestId);
  const beads = new Set(own.flatMap((record) => record.reports.filter((report) => (report.requestId ?? requestId) === requestId).flatMap((report) => report.beadsClosed)));
  return {
    beads: beads.size,
    turns: own.filter((record) => record.role === "worker").length,
    tokens: requestTokensReadOf(records, requestId, null) ?? 0,
    context: turn?.usage?.contextUsed ?? null,
  };
}

/**
 * The notice a request's figures call for (§2.6): `now` at `ceilingFactor` ×
 * any figure, else `soft` at any figure, with the figure's words; null below
 * them all or while rollover is off. Pure.
 */
export function rolloverCrossingOf(figures: RolloverFigures, settings: Pick<CoordinationSettings, "rollover">): { level: RolloverLevel; figure: string } | null {
  const { rollover } = settings;
  if (!rollover.enabled) return null;
  const parts = [
    { value: figures.beads, at: rollover.beads, words: `${figures.beads} beads closed` },
    { value: figures.turns, at: rollover.turns, words: `${figures.turns} turns` },
    { value: figures.tokens, at: rollover.tokens, words: `${Math.round(figures.tokens / 1_000_000)}M tokens read` },
    { value: figures.context ?? 0, at: rollover.contextTokens, words: `context ${Math.round((figures.context ?? 0) / 1_000)}k` },
  ];
  const hard = parts.find((part) => part.value >= part.at * rollover.ceilingFactor);
  if (hard !== undefined) return { level: "now", figure: hard.words };
  const soft = parts.find((part) => part.value >= part.at);
  return soft === undefined ? null : { level: "soft", figure: soft.words };
}

/** What a `now` of the time ceiling adds to the soft notice's figure (§6.6). */
const WAITED_WORDS = `, then ${MAINTENANCE_WAIT_MS.rollover / 60_000} minutes without rolling over`;

/**
 * The time ceiling (§6.6, ADR-051 decision 2): a `soft` asked at least
 * `MAINTENANCE_WAIT_MS.rollover` before `now` of a request that has not rolled
 * over (not finished, no continuation) calls for `now`, its figure the soft
 * one's and the wait. Null otherwise, a `now` already asked included: asking
 * a stored `now` again of a later Worker is `rolloverTurnRecorded`'s (ADR-046).
 * Pure.
 */
export function rolloverWaitedOf(request: Pick<RegisteredRequest, "finishedAt" | "continuedBy" | "rolloverAsked">, now: Date): { level: "now"; figure: string } | null {
  const asked = request.rolloverAsked;
  if (asked?.level !== "soft" || request.finishedAt !== null || request.continuedBy !== undefined) return null;
  const at = Date.parse(asked.at);
  return Number.isFinite(at) && now.getTime() - at >= MAINTENANCE_WAIT_MS.rollover ? { level: "now", figure: `${asked.figure}${WAITED_WORDS}` } : null;
}

/** The `BM-ROLLOVER` notice (§2.6). Pure. */
export function rolloverNoticeOf(level: RolloverLevel, requestId: string, figure: string): string {
  return [
    `${ROLLOVER_NOTICE_MARKER} ${level}`,
    `From the paseo-bm plugin, not the owner: request ${requestId} reached ${figure}.`,
    level === "soft"
      ? "Finish the bead in progress, review as your tier says, and report `finished` with `remaining`; paseo-bm opens the continuation."
      : "Report `finished` with `remaining` at the end of this turn; put the work in progress in `remaining`.",
  ].join("\n");
}

/** The Worker's handoff has asked for its note or gone further: its successor is the one to hear `now` (ADR-046). Never throws. */
function handoffUnderWay(home: string, requestId: string, workerId: string): boolean {
  try {
    return createHandoffStore(home).list().some((entry) => entry.workerId === workerId && entry.requestId === requestId && entry.state !== "waiting" && isPendingHandoffState(entry.state));
  } catch {
    return false;
  }
}

export interface RolloverDeps {
  queue?: Pick<NoticeQueue, "enqueue">;
  now?: () => Date;
  log?: (message: string) => void;
}

/**
 * One recorded turn (the collector's `onRecorded`): the notice the turn's
 * bound request now calls for, queued to its newest Worker and noted on the
 * request. Returns the level queued, or null. Never rejects.
 */
export async function rolloverTurnRecorded(home: string, record: TraceRecord | null | undefined, paseo: unknown, deps: RolloverDeps = {}): Promise<RolloverLevel | null> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  if (record?.role !== "worker" || record.requestId === null) return null;
  const { workspaceId, requestId, agentId } = record;
  try {
    const registry = createRequestRegistry(home, { log });
    const request = registry.get(workspaceId, requestId);
    if (!isBoundRequest(request) || request.finishedAt !== null || request.workerIds.at(-1) !== agentId || (request.rolloverAsked?.level === "now" && (request.rolloverAsked.workerId ?? agentId) === agentId)) return null;
    const records = readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, workspaceId).records;
    const settings = readCoordinationSettings({ home, log });
    const now = deps.now?.() ?? new Date();
    let crossing = rolloverCrossingOf(rolloverFiguresOf(records, requestId, record), settings);
    // A figure at its ceiling says `now` in its own words. Else ADR-046: a `now` that reached an earlier Worker (the guard
    // above excludes the one it reached) is asked again of this one, whatever its figures — that Worker was replaced before
    // it could finish; else §6.6: a soft notice that waited the time ceiling says `now`.
    const stored = request.rolloverAsked;
    if (settings.rollover.enabled && crossing?.level !== "now") crossing = (stored?.level === "now" ? { level: "now" as const, figure: stored.figure } : null) ?? rolloverWaitedOf(request, now) ?? crossing;
    if (crossing === null || (crossing.level === "soft" && request.rolloverAsked !== undefined) || (crossing.level === "now" && handoffUnderWay(home, requestId, agentId))) return null;
    const hint = { workspaceId, requestId };
    if (crossing.level === "soft" ? gatedWaitOf(home, agentId, hint) !== null : wakeGate(home, agentId, "rollover-now", [], hint).action === "hold") return null;
    const text = rolloverNoticeOf(crossing.level, requestId, crossing.figure);
    const asked = { level: crossing.level, figure: crossing.figure, at: now.toISOString(), ...(crossing.level === "now" ? { workerId: agentId } : {}) };
    let heldNow = false;
    // §6.4: a soft notice the gate holds at its send (the Worker reported `blocked` meanwhile) is forgotten, to be asked again.
    const onHeld = (): void => {
      heldNow = true;
      try {
        const current = createRequestRegistry(home, { log }).get(workspaceId, requestId)?.rolloverAsked;
        if (current?.level === "soft" && current.at === asked.at) createRequestRegistry(home, { log }).noteRolloverAsked(workspaceId, requestId, null);
      } catch (error) {
        log(`[paseo-bm] could not forget the held rollover notice of request ${requestId}: ${errorText(error)}`);
      }
    };
    // §6.6: the hard notice goes before what is queued, as maintenance at its ceiling does.
    const options = crossing.level === "now" ? { first: true } : { isHeld: holdsAtSend(home, agentId, "rollover-soft", [], hint, { log }) };
    const outcome = await (deps.queue ?? noticeQueue).enqueue(agentId, ROLLOVER_NOTICE_MARKER, text, paseo as NoticePaseo | undefined, crossing.level === "now" ? undefined : { onHeld }, options);
    if (outcome === "dropped" || heldNow) return null;
    registry.noteRolloverAsked(workspaceId, requestId, asked);
    return crossing.level;
  } catch (error) {
    log(`[paseo-bm] could not check the size of request ${requestId}: ${errorText(error)}`);
    return null;
  }
}
