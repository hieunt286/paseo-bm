/**
 * One transfer function (mission runtime design §5.1, ADR-033 decision 4,
 * REQ-206): every move of requests from one mission to another — a split, a
 * legacy mission's merge, the owner's transfer card — goes through
 * `transferRequests`, so the roster, the registry and the Workers always
 * agree on who owns a request:
 *
 * 1. `roster.move` from the source to the target;
 * 2. each moved request's registry `managerId` becomes the target's Main and
 *    its `missionId` the target (`reassignRequests`);
 * 3. their Workers' bindings re-pointed and, when live, their parent label set
 *    (no Worker is told: every delivery resolves to the current Main). A
 *    target with no Main yet (a split, before its Main is created) gets the
 *    registry's `missionId` and the bindings' mission only: the Main's
 *    creation (`replaceMain`) then points the requests and Workers at it;
 * 4. a journal `charter` line on both missions (`journal: false` leaves it to
 *    the caller, the split, which words its own);
 * 5. both Mains told (`tellMain`, on their channel; `tell: false` likewise).
 *
 * Refused, with nothing written: an unknown or closed mission, the same
 * mission as source and target, no request named, a request not on the
 * source roster. Never throws.
 */
import type { Mission } from "./mission-store";
import { createBindingStore } from "./agent-bindings";
import { createMissionRoster } from "./mission-roster";
import { createMissionStore } from "./mission-store";
import { reassignRequests, type ReplaceMainDeps } from "./mission-replace";
import { tellMain, type MissionAnswerDeps } from "./mission-tools";
import type { NoticeQueue } from "./notice-queue";
import { createRequestRegistry } from "./request-registry";
import { errorText } from "./rpc-kit";

export interface TransferInput {
  from: string;
  to: string;
  requestIds: readonly string[];
  reason: string;
  /** Who authorised it, as the journal names them. */
  by: "owner" | "orchestrator" | "plugin";
  /** The card or mission it came from, for the journal and the Mains' messages. */
  ref: string;
  /** Writes the journal lines (default true). */
  journal?: boolean;
  /** Tells both Mains (default true). */
  tell?: boolean;
}

export interface TransferDeps {
  home: string;
  now: Date;
  paseo: unknown;
  log: (message: string) => void;
  bindings?: ReplaceMainDeps["bindings"];
  cli?: ReplaceMainDeps["cli"];
  queue?: Pick<NoticeQueue, "enqueue">;
}

export type TransferResult = { ok: true; moved: string[]; workers: string[] } | { ok: false; reasons: string[] };

/** Why a transfer is refused (see the module comment); none when it may run. Never throws. */
export function transferRefusalsOf(home: string, input: Pick<TransferInput, "from" | "to" | "requestIds">): string[] {
  try {
    const store = createMissionStore(home);
    const from = store.get(input.from);
    const to = store.get(input.to);
    const reasons: string[] = [];
    if (input.from === input.to) reasons.push("the source and the target are the same mission");
    const usable = (mission: Mission | null, id: string, side: string) => {
      if (mission === null) reasons.push(`the ${side} mission ${id} does not exist`);
      else if (mission.state !== "open") reasons.push(`the ${side} mission ${mission.code} is closed`);
    };
    usable(from, input.from, "source");
    usable(to, input.to, "target");
    if (input.requestIds.length === 0) reasons.push("no request is named");
    if (from !== null) {
      const onRoster = new Set(createMissionRoster(home).list(from.missionId).map((entry) => entry.requestId));
      const missing = input.requestIds.filter((requestId) => !onRoster.has(requestId));
      if (missing.length > 0) reasons.push(`not on mission ${from.code}'s roster: ${missing.join(", ")}`);
    }
    return reasons;
  } catch (error) {
    return [`the missions cannot be read: ${errorText(error)}`];
  }
}

/** Step 2 and 3 for a target with no Main yet: the registry's `missionId` and the Workers' bindings' mission; returns the Workers. */
function missionOnly(missionId: string, moved: ReadonlyArray<{ requestId: string; workspaceId: string; workerIds: readonly string[] }>, deps: TransferDeps): string[] {
  const registry = createRequestRegistry(deps.home, { log: deps.log });
  const bindings = deps.bindings ?? createBindingStore(deps.home);
  const workers = new Set<string>();
  for (const entry of moved) {
    try {
      const current = registry.get(entry.workspaceId, entry.requestId);
      if (current !== null) registry.reassignManager(entry.workspaceId, entry.requestId, current.managerId, missionId);
      for (const workerId of [...entry.workerIds, ...(current?.workerIds ?? [])]) workers.add(workerId);
    } catch (error) {
      deps.log(`[paseo-bm] request ${entry.requestId} could not be given mission ${missionId}: ${errorText(error)}`);
    }
  }
  for (const workerId of workers) bindings?.assignMission(workerId, missionId);
  return [...workers];
}

/** Moves requests from one mission to another (see the module comment). Never throws. */
export async function transferRequests(input: TransferInput, deps: TransferDeps): Promise<TransferResult> {
  const { home, log } = deps;
  const reasons = transferRefusalsOf(home, input);
  if (reasons.length > 0) return { ok: false, reasons };
  try {
    const store = createMissionStore(home, { now: () => deps.now });
    const from = store.get(input.from)!;
    const to = store.get(input.to)!;
    const moved = createMissionRoster(home, { now: () => deps.now }).move(from.missionId, to.missionId, input.requestIds);
    const movedIds = moved.map((entry) => entry.requestId);
    const workers =
      to.mainId === null
        ? missionOnly(to.missionId, moved, deps)
        : await reassignRequests(to.missionId, moved, to.mainId, {
            home,
            paseo: deps.paseo,
            log,
            now: () => deps.now,
            ...(deps.bindings === undefined ? {} : { bindings: deps.bindings }),
            ...(deps.queue === undefined ? {} : { queue: deps.queue }),
            ...(deps.cli === undefined ? {} : { cli: deps.cli }),
          });
    const listed = movedIds.length === 1 ? `request ${movedIds[0]}` : `requests ${movedIds.join(", ")}`;
    if (input.journal !== false) {
      for (const [missionId, text, ref] of [
        [from.missionId, `${listed} moved to mission ${to.code}: ${input.reason}`, to.missionId],
        [to.missionId, `${listed} moved here from mission ${from.code}: ${input.reason}`, from.missionId],
      ] as const) {
        try {
          store.appendJournal(missionId, { kind: "charter", by: input.by, text, ref });
        } catch (error) {
          log(`[paseo-bm] the transfer of ${listed} could not be journaled on ${missionId}: ${errorText(error)}`);
        }
      }
    }
    if (input.tell !== false) {
      const told: MissionAnswerDeps = { home, now: deps.now, log, paseo: deps.paseo, ...(deps.cli === undefined ? {} : { cli: deps.cli }) };
      await tellMain(from.missionId, input.ref, `${listed} and their Workers moved to mission ${to.code} (Main ${to.mainId}): ${input.reason}. Plan without them; ask that mission with bm_ask_mission.`, told, input.by);
      await tellMain(to.missionId, input.ref, `${listed} and their Workers moved here from mission ${from.code}: ${input.reason}. They report to you now.`, told, input.by);
    }
    return { ok: true, moved: movedIds, workers };
  } catch (error) {
    return { ok: false, reasons: [errorText(error)] };
  }
}
