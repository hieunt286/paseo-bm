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
 * - **Now**: `rollover.ceilingFactor` × one figure queues `BM-ROLLOVER now`,
 *   once, at once (`rollover-now` is on the wake gate's always-at-once list),
 *   ahead of what is queued for the Worker (`first`, the maintenance
 *   ceiling's order, §6.6).
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
import { ROLLOVER_NOTICE_MARKER } from "../shared/notices";
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME } from "./data-home";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { createRequestRegistry, isBoundRequest } from "./request-registry";
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
    if (!isBoundRequest(request) || request.finishedAt !== null || request.workerIds.at(-1) !== agentId || request.rolloverAsked?.level === "now") return null;
    const records = readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, workspaceId).records;
    const crossing = rolloverCrossingOf(rolloverFiguresOf(records, requestId, record), readCoordinationSettings({ home, log }));
    if (crossing === null || crossing.level === request.rolloverAsked?.level) return null;
    const hint = { workspaceId, requestId };
    if (crossing.level === "soft" ? gatedWaitOf(home, agentId, hint) !== null : wakeGate(home, agentId, "rollover-now", [], hint).action === "hold") return null;
    const text = rolloverNoticeOf(crossing.level, requestId, crossing.figure);
    const asked = { level: crossing.level, figure: crossing.figure, at: (deps.now?.() ?? new Date()).toISOString() };
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
