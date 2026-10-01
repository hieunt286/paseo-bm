import { z } from "zod";
import { workerSignalSchema } from "./orchestrator";

/**
 * The coordination intervention log (autonomy design §G.3, REQ-127, ADR-021):
 * the shape of `<data folder>/orchestrator/interventions.json`, shared so the
 * store (`server/intervention-store.ts`), the metric module (A-12,
 * `eval-metrics.ts`) and Insights read one definition.
 *
 * An entry is one intervention of the Orchestrator — an answer, an unblock, a
 * correction, a stop; later a compaction, a handoff, advice — with what
 * triggered it, whom it targeted, the outcome expected of it and the window
 * that outcome is checked over, then the outcome the check settled. Ids,
 * times and enums only: never a command, a reason or any other text.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */

const MINUTE_MS = 60_000;

/** The kinds, in the order of design §G.3's table. */
export const INTERVENTION_KINDS = ["answer", "unblock", "correct", "stop", "compact", "handoff", "advice"] as const;
export const interventionKindSchema = z.enum(INTERVENTION_KINDS);
export type InterventionKind = z.infer<typeof interventionKindSchema>;

/** `pending` until the check settles it; `unknown` when the stores cannot tell. */
export const INTERVENTION_OUTCOMES = ["pending", "met", "missed", "unknown"] as const;
export const interventionOutcomeSchema = z.enum(INTERVENTION_OUTCOMES);
export type InterventionOutcome = z.infer<typeof interventionOutcomeSchema>;

/**
 * What the intervention answered: an event of the Orchestrator's wake
 * (`decision.opened`, `request.stalled`, `worker.signal`, `advice.due` from
 * the advice bead, and `threshold.crossed` from Phase 3, design §G.7), the
 * owner's word in the Orchestrator's chat (`owner`), or the Orchestrator's
 * own initiative with no event of its wake behind it (`orchestrator`).
 * Additive: the store stays `version: 1`.
 */
export const INTERVENTION_TRIGGERS = ["decision.opened", "request.stalled", "worker.signal", "advice.due", "threshold.crossed", "owner", "orchestrator"] as const;
export const interventionTriggerSchema = z.enum(INTERVENTION_TRIGGERS);
export type InterventionTrigger = z.infer<typeof interventionTriggerSchema>;

/** The outcome each kind is expected to reach (design §G.3's "Met when"). */
export const EXPECTED_OUTCOMES = [
  "worker-resumes",
  "stall-clears",
  "signal-clears-or-checks-pass",
  "turn-ends",
  "tokens-per-turn-down",
  "successor-progresses",
  "owner-answers",
] as const;
export const expectedOutcomeSchema = z.enum(EXPECTED_OUTCOMES);
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;

export const EXPECTED_OUTCOME_OF: Readonly<Record<InterventionKind, ExpectedOutcome>> = {
  answer: "worker-resumes",
  unblock: "stall-clears",
  correct: "signal-clears-or-checks-pass",
  stop: "turn-ends",
  compact: "tokens-per-turn-down",
  handoff: "successor-progresses",
  advice: "owner-answers",
};

/**
 * The check window of each kind (design §G.3). `correct` waits for the next
 * report, at most an hour; `compact` for three turns, at most an hour from
 * its `/compact` (or from the entry, while that has not gone out).
 */
export const INTERVENTION_WINDOW_MS: Readonly<Record<InterventionKind, number>> = {
  answer: 10 * MINUTE_MS,
  unblock: 15 * MINUTE_MS,
  correct: 60 * MINUTE_MS,
  stop: 2 * MINUTE_MS,
  compact: 60 * MINUTE_MS,
  handoff: 60 * MINUTE_MS,
  advice: 7 * 24 * 60 * MINUTE_MS,
};

/**
 * How long after its window an entry is judged on what the stores do NOT
 * show: a turn record is written a moment after the turn ends, so a turn that
 * ended at the window's edge has landed by then.
 */
export const INTERVENTION_SETTLE_MS = MINUTE_MS;

/** A-12's target per kind (PRD A-12): at least 80 % met of the checked entries. */
export const A12_TARGET = 0.8;

/**
 * A `compact`'s expected outcome (design §G.3): the target's tokens read per
 * turn over its next `turns` measured turns after the compaction are at most
 * `share` of those over the `turns` before it.
 */
export const COMPACT_OUTCOME = { turns: 3, share: 0.6 } as const;

/**
 * A `handoff`'s expected outcome (design §G.3, §G.6): the successor's tokens
 * read per turn over its first `turns` measured turns are at most `share` of
 * the predecessor's over its last `turns`, and the successor reports progress
 * — a report of the request that is not `blocked` — within the window.
 */
export const HANDOFF_OUTCOME = { turns: 3, share: 0.5 } as const;

/**
 * One intervention. `requestId` is null for an intervention outside a
 * request, `targetAgentId` when no agent is targeted. The optional fields are
 * what the check reads, when the kind has it: `decisionId` the decision
 * answered (`answer`) or asked (`advice`); `alertKey` the alert the
 * triggering event reported (the stall of an `unblock`, the `stuck`,
 * `permission-waiting` or `danger` signal of a `correct`); `signal` the
 * Worker signal a `correct` or `stop` answered; `commandId` the delivered
 * command it is (`unblock`, `correct`, `stop`), under the id the commands
 * store (`proposals.json`) records it with. `checkedAt` is when the check
 * settled it, null while `pending`.
 */
export const interventionEntrySchema = z.object({
  id: z.string().min(1),
  kind: interventionKindSchema,
  workspaceId: z.string().min(1),
  requestId: z.string().min(1).nullable(),
  targetAgentId: z.string().min(1).nullable(),
  trigger: interventionTriggerSchema,
  expected: expectedOutcomeSchema,
  windowMs: z.number().int().positive(),
  at: z.string().min(1),
  outcome: interventionOutcomeSchema,
  checkedAt: z.string().min(1).nullable(),
  decisionId: z.string().min(1).optional(),
  alertKey: z.string().min(1).optional(),
  signal: workerSignalSchema.optional(),
  commandId: z.string().min(1).optional(),
});
export type InterventionEntry = z.infer<typeof interventionEntrySchema>;

/** The file format this build reads and writes. */
export const INTERVENTIONS_FILE_VERSION = 1;

/** The file's frame; each entry is validated on its own, so one bad entry costs only itself. */
export const interventionsFileSchema = z.object({
  version: z.number(),
  entries: z.array(z.unknown()),
});

/** A-12 of one kind: met / (met + missed); null when none is checked either way. */
export function a12ShareOf(met: number, missed: number): number | null {
  return met + missed === 0 ? null : met / (met + missed);
}

/** Zero counts of failures ("0 fail", "failed: 0", "no errors"): not failures. */
const ZERO_FAILURES = /\b(?:0|no|zero)\s+(?:fail(?:s|ed|ing|ures?)?|errors?)\b|\b(?:fail(?:s|ed|ing|ures?)?|errors?)(?:\s*[:=]\s*|\s+)0(?![\d.])/gi;
/** Checks named as failing, once the zero counts are set aside. */
const FAILING_CHECKS = /\b(?:fail(?:s|ed|ing|ures?)?|red|errors?|broken)\b/i;
/** A value that says nothing was run; backticks before it too (`buildAndTests` keeps them, `bm-report.ts`). */
const NOTHING_RAN = /^[\s`]*(?:$|not\s+run|none|n\/?a|skipped|no\s+(?:tests?|checks?|commands?|build)\b|[-—])/i;

/**
 * True when a report's `buildAndTests` names a failing check, once the zero
 * counts are set aside ("0 failed" is none). The one reading of it: the check
 * of a `correct` (`reportChecksOf`) and the work left that wakes the
 * Orchestrator (`server/event-bus.ts` `workLeftOf`; code review 2026-09-30
 * §3.5). Pure.
 */
export function namesFailingChecks(buildAndTests: string): boolean {
  return FAILING_CHECKS.test(buildAndTests.replace(ZERO_FAILURES, ""));
}

/**
 * What a report's `buildAndTests` says of its checks: `fail` when it names a
 * failure (a zero count is none), `pass` when it names checks and no failure,
 * null when it names none or says nothing ran. Pure.
 */
export function reportChecksOf(buildAndTests: string | null): "pass" | "fail" | null {
  if (buildAndTests === null || NOTHING_RAN.test(buildAndTests)) return null;
  return namesFailingChecks(buildAndTests) ? "fail" : "pass";
}
