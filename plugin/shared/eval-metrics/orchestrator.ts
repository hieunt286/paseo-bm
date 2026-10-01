/**
 * The Orchestrator's figures (evaluation design §4): A-7 (its wakes, and
 * whether it acted on them), the Orchestrator's own tokens of A-8 (from its
 * wake records), and A-12 (its coordination interventions, autonomy design
 * §G.3).
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import { decisionKindOf } from "../decisions";
import { INTERVENTION_KINDS, a12ShareOf, interventionEntrySchema, type InterventionKind } from "../interventions";
import { stallEntrySchema, type WakeEntry } from "../orchestrator";
import { compareText, ratio, within, workspaceOfStallKey, type Bounds } from "./helpers";
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
 * What the Orchestrator did, and when: a command, a decision, an answer (`bm_decide`), a prediction (`bm_predict`),
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
    // predictor `orchestrator`, a `q:` or an `f:`, autonomy design §B.5, §B.9).
    const answer = decision.answer;
    const byOrchestrator =
      answer !== null &&
      ((decisionKindOf(decision.id) === "question" && answer.by === "orchestrator") ||
        (decisionKindOf(decision.id) !== "orchestrator" && answer.by === "policy" && answer.predictor === "orchestrator"));
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
 * A-7: wakes, and whether an Orchestrator command, decision, answer (`bm_decide`), prediction (`bm_predict`),
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
