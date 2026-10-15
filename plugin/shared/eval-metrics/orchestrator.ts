/**
 * The Orchestrator's figures (evaluation design §4): A-7 (its wakes, and
 * whether it acted on them), the Orchestrator's own tokens of A-8 (from its
 * wake records), and A-12 (its coordination interventions, autonomy design
 * §G.3).
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { decisionKindOf, policyPredictorOf } from "../decisions";
import { INTERVENTION_KINDS, a12ShareOf, interventionEntrySchema, type InterventionKind } from "../interventions";
import { dangerEntrySchema, stallEntrySchema, type WakeEntry } from "../orchestrator";
import { compareText, median, ratio, within, workspaceOfStallKey, type Bounds } from "./helpers";
import { isOrchestratorCommand, type EvalStores } from "./scope";
import type { EvalInput, EvalMetrics, EvalNote, EvalUnknowns, InterventionCounts } from "./types";
import { timeOrNull } from "../time";

const WAKE_ACTION_WINDOW_MS = 10 * 60_000;
/** An allowance key (`<ws>::<worker>::danger-open@<time>`) is not a wake. */
const DANGER_OPEN_KEY = /::danger-open@/;

/**
 * The intervention kinds only the Orchestrator's own coordination tools record (`bm_compact`, `bm_handoff`,
 * autonomy design §G.5, §G.6): an action of its wake at the entry's time. A handoff's command waits for the
 * outgoing Worker's note, so it goes out after the wake ended (Phase 3 live check, F3).
 */
const COORDINATION_ACTION_KINDS: ReadonlySet<InterventionKind> = new Set(["compact", "handoff"]);

/**
 * What the Orchestrator did, and when: a command, a decision, an answer (`bm_decide`), a prediction (stored by the retired `bm_predict`),
 * a note, or a compaction or handoff it asked for (the intervention log).
 */
function orchestratorActionsOf(stores: EvalStores, notes: readonly EvalNote[] | undefined, interventions: readonly unknown[] | undefined): Array<{ workspaceId: string; at: number }> {
  const actions: Array<{ workspaceId: string; at: number }> = [];
  for (const proposal of stores.proposals) {
    const at = timeOrNull(proposal.at);
    if (at !== null && (proposal.kind === "decision" || isOrchestratorCommand(proposal))) actions.push({ workspaceId: proposal.workspaceId, at });
  }
  for (const decision of stores.decisions) {
    const at = timeOrNull(decision.askedAt);
    if (at !== null && decisionKindOf(decision.id) === "orchestrator") actions.push({ workspaceId: decision.workspaceId, at });
    // A decision the Orchestrator answered: its action at the answer's time — Phase 1's Worker question
    // (`by: orchestrator`, change-004), or one it decided on the owner's policy (`bm_decide`: `by: policy`,
    // `policyPredictorOf` the Orchestrator, a `q:` or an `f:`, autonomy design §B.5, §B.9).
    const answer = decision.answer;
    const byOrchestrator =
      answer !== null &&
      ((decisionKindOf(decision.id) === "question" && answer.by === "orchestrator") ||
        (decisionKindOf(decision.id) !== "orchestrator" && policyPredictorOf(decision) === "orchestrator"));
    const answeredAt = byOrchestrator ? timeOrNull(answer.at) : null;
    if (answeredAt !== null) actions.push({ workspaceId: decision.workspaceId, at: answeredAt });
    // The challenger's prediction (autonomy design §B.3, §B.9): its wake's action at the prediction's time.
    const predictedAt = timeOrNull(decision.prediction?.orchestrator?.at ?? null);
    if (predictedAt !== null) actions.push({ workspaceId: decision.workspaceId, at: predictedAt });
  }
  for (const note of notes ?? []) {
    const at = timeOrNull(note.at);
    if (at !== null) actions.push({ workspaceId: note.workspaceId, at });
  }
  // An invalid entry is A-12's unknown (`a12Of`), not counted twice here.
  for (const raw of interventions ?? []) {
    const parsed = interventionEntrySchema.safeParse(raw);
    if (!parsed.success || !COORDINATION_ACTION_KINDS.has(parsed.data.kind)) continue;
    const at = timeOrNull(parsed.data.at);
    if (at !== null) actions.push({ workspaceId: parsed.data.workspaceId, at });
  }
  return actions;
}

/**
 * A-7: wakes, and whether an Orchestrator command, decision, answer (`bm_decide`), prediction (the retired `bm_predict`'s),
 * note, compaction (`bm_compact`) or handoff (`bm_handoff`) followed: within the wake's own turn for a recorded
 * wake, within 10 minutes for a stall key (or a recorded wake without its end).
 */
export function a7Of(input: Pick<EvalInput, "notes" | "stalls" | "wakes" | "interventions">, stores: EvalStores, bounds: Bounds, unknowns: EvalUnknowns): EvalMetrics["a7"] {
  const actions = orchestratorActionsOf(stores, input.notes, input.interventions);
  let wakes = 0;
  let actedOn = 0;
  let approximateWakes = 0;
  for (const [index, wake] of stores.wakes.entries()) {
    const at = timeOrNull(wake.at);
    if (at === null) {
      unknowns.wakesWithoutTime += 1;
      continue;
    }
    if (!within(at, bounds)) continue;
    wakes += 1;
    let end = timeOrNull(wake.endedAt);
    if (end === null) {
      // Not recorded (a reload): the 10-minute window, cut at the same Orchestrator's next wake.
      unknowns.wakesWithoutEnd += 1;
      approximateWakes += 1;
      const next = stores.wakes.slice(index + 1).find((other) => other.orchestratorId === wake.orchestratorId && (timeOrNull(other.at) ?? at) > at);
      const nextAt = next === undefined ? null : timeOrNull(next.at);
      end = Math.min(at + WAKE_ACTION_WINDOW_MS, nextAt === null ? Number.POSITIVE_INFINITY : nextAt);
    }
    const stop = end;
    if (actions.some((action) => action.at >= at && action.at <= stop)) actedOn += 1;
  }
  for (const key of Object.keys(input.stalls ?? {}).sort(compareText)) {
    if (DANGER_OPEN_KEY.test(key)) continue;
    const parsed = stallEntrySchema.safeParse(input.stalls?.[key]);
    const workspaceId = workspaceOfStallKey(key);
    if (!parsed.success || workspaceId === null) {
      unknowns.invalidStallEntries += 1;
      continue;
    }
    if (!parsed.data.woke) continue;
    const at = timeOrNull(parsed.data.raisedAt);
    if (at === null) {
      unknowns.wakesWithoutTime += 1;
      continue;
    }
    if (!within(at, bounds)) continue;
    wakes += 1;
    approximateWakes += 1;
    if (actions.some((action) => action.workspaceId === workspaceId && action.at >= at && action.at <= at + WAKE_ACTION_WINDOW_MS)) actedOn += 1;
  }
  return {
    approximate: input.wakes === undefined || approximateWakes > 0,
    notesIncluded: input.notes !== undefined,
    wakeRecordsIncluded: input.wakes !== undefined,
    wakes,
    actedOn,
    noAction: wakes - actedOn,
    noActionShare: ratio(wakes - actedOn, wakes),
  };
}

/**
 * A-8 (change-007 C6): the Orchestrator's tokens, from the wakes in the window whose closing turn's usage was
 * recorded. `wakeRecordsIncluded` is false when no wake records were supplied.
 */
export function orchestratorTokensOf(
  wakes: readonly WakeEntry[],
  wakeRecordsIncluded: boolean,
  bounds: Bounds,
  finishedCount: number,
): EvalMetrics["a8"]["orchestrator"] {
  let orchestratorWakes = 0;
  let orchestratorWakesWithUsage = 0;
  let orchestratorTokens = 0;
  for (const wake of wakes) {
    const at = timeOrNull(wake.at);
    if (at === null || !within(at, bounds)) continue;
    orchestratorWakes += 1;
    if (wake.usage === undefined || wake.usage === null) continue;
    orchestratorWakesWithUsage += 1;
    orchestratorTokens += wake.usage.inputTokens + wake.usage.cachedInputTokens + wake.usage.outputTokens;
  }
  const orchestratorKnown = wakeRecordsIncluded && (orchestratorWakes === 0 || orchestratorWakesWithUsage > 0);
  return {
    wakeRecordsIncluded,
    wakes: orchestratorWakes,
    wakesWithUsage: orchestratorWakesWithUsage,
    tokens: orchestratorKnown ? orchestratorTokens : null,
    perFinishedRequest: orchestratorKnown && finishedCount > 0 ? orchestratorTokens / finishedCount : null,
  };
}

/** A-12: the intervention log's entries recorded in the window, by kind and outcome. */
export function a12Of(interventions: readonly unknown[] | undefined, bounds: Bounds, unknowns: EvalUnknowns): EvalMetrics["a12"] {
  const byKind = Object.fromEntries(
    INTERVENTION_KINDS.map((kind): [InterventionKind, InterventionCounts] => [kind, { recorded: 0, met: 0, missed: 0, unknown: 0, pending: 0, share: null }]),
  ) as Record<InterventionKind, InterventionCounts>;
  for (const raw of interventions ?? []) {
    const parsed = interventionEntrySchema.safeParse(raw);
    if (!parsed.success || timeOrNull(parsed.data.at) === null) {
      unknowns.invalidInterventions += 1;
      continue;
    }
    if (!within(timeOrNull(parsed.data.at), bounds)) continue;
    const counts = byKind[parsed.data.kind];
    counts.recorded += 1;
    counts[parsed.data.outcome] += 1;
  }
  for (const counts of Object.values(byKind)) counts.share = a12ShareOf(counts.met, counts.missed);
  return { logIncluded: interventions !== undefined, byKind };
}

/** ADR-032 decision 6: the figures that reopen a per-mission governor. */
export const A13_REOPEN = {
  /** More off-mission acts than this. */
  offMissionActs: 1,
  /** A median danger-to-end time above this, on dangers that needed the backup. */
  dangerBackupMs: 5 * 60_000,
  /** M-26 above this share. */
  noActionShare: 0.2,
  /** Twice the 2026-10-09 acceptance's tokens read per wake (697,034 over 4 wakes, rounded). */
  tokensReadPerWake: 2 * 175_000,
} as const;

const spread = (values: readonly number[]): { median: number | null; max: number | null } => ({ median: median(values), max: values.length === 0 ? null : Math.max(...values) });

/**
 * A-13 (missions design §20, ADR-032 decision 6): the governor's scale, from
 * the wake records in the window and the danger log entries raised in it.
 * `noActionShare` is A-7's, for the M-26 reopen figure.
 */
export function a13Of(
  dangersRaw: readonly unknown[] | undefined,
  wakes: readonly WakeEntry[],
  wakeRecordsIncluded: boolean,
  noActionShare: number | null,
  bounds: Bounds,
  unknowns: EvalUnknowns,
): EvalMetrics["a13"] {
  const inWindow = wakes.filter((wake) => within(timeOrNull(wake.at), bounds));
  const perMission = new Map<string, number>();
  let wakesWithMissions = 0;
  let offMissionActs = 0;
  let wakesWithOffMissionKnown = 0;
  const tokens: number[] = [];
  for (const wake of inWindow) {
    const missions = wake.missionIds ?? [];
    if (missions.length > 0) wakesWithMissions += 1;
    for (const missionId of new Set(missions)) perMission.set(missionId, (perMission.get(missionId) ?? 0) + 1);
    if (wake.offMission !== undefined) {
      wakesWithOffMissionKnown += 1;
      offMissionActs += wake.offMission;
    }
    if (wake.usage !== undefined && wake.usage !== null) tokens.push(wake.usage.inputTokens + wake.usage.cachedInputTokens);
  }
  const dangers = { raised: 0, ended: 0, mainTold: 0, mainToldWithinMinute: 0, backupNeeded: 0 };
  const toEnd: number[] = [];
  const backupToEnd: number[] = [];
  for (const raw of dangersRaw ?? []) {
    const parsed = dangerEntrySchema.safeParse(raw);
    if (!parsed.success) {
      unknowns.invalidDangerEntries += 1;
      continue;
    }
    const raisedAt = timeOrNull(parsed.data.raisedAt);
    if (raisedAt === null || !within(raisedAt, bounds)) continue;
    dangers.raised += 1;
    const mainToldAt = timeOrNull(parsed.data.mainToldAt);
    if (mainToldAt !== null) {
      dangers.mainTold += 1;
      if (mainToldAt - raisedAt <= 60_000) dangers.mainToldWithinMinute += 1;
    }
    const backup = parsed.data.governorToldAt !== null;
    if (backup) dangers.backupNeeded += 1;
    const endedAt = timeOrNull(parsed.data.endedAt);
    if (endedAt === null) continue;
    dangers.ended += 1;
    toEnd.push(Math.max(0, endedAt - raisedAt));
    if (backup) backupToEnd.push(Math.max(0, endedAt - raisedAt));
  }
  const tokenSpread = spread(tokens);
  const backupSpread = spread(backupToEnd);
  return {
    wakeRecordsIncluded,
    dangerLogIncluded: dangersRaw !== undefined,
    wakes: inWindow.length,
    wakesWithMissions,
    missions: perMission.size,
    wakesPerMission: spread([...perMission.values()]),
    offMissionActs,
    wakesWithOffMissionKnown,
    tokensReadPerWake: { wakes: tokens.length, ...tokenSpread },
    dangers: { ...dangers, toEndMs: spread(toEnd), backupToEndMs: backupSpread },
    reopen: {
      offMission: wakesWithOffMissionKnown === 0 ? null : offMissionActs > A13_REOPEN.offMissionActs,
      dangerBackup: backupSpread.median === null ? null : backupSpread.median > A13_REOPEN.dangerBackupMs,
      noAction: noActionShare === null ? null : noActionShare > A13_REOPEN.noActionShare,
      tokens: tokenSpread.median === null ? null : tokenSpread.median > A13_REOPEN.tokensReadPerWake,
    },
  };
}
