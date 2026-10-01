/**
 * The agreement ledger (autonomy design §B.3, ADR-018; PRD REQ-122 a): how
 * often each predictor foresaw the owner's answer, per project × class ×
 * predictor, and what became of the decisions the policy or a precedent
 * answered. Derived on demand from the decision records (§B.9): the
 * predictions made at open and the reversals of an answer are fields of the
 * record, never a separate ledger file.
 *
 * - **Agreement** counts only answers `by: owner`. An answer with an option
 *   agrees when it is the predicted option; an answer in the owner's own words
 *   is counted and never agrees. A chat answer the owner confirmed records no
 *   option and no words: what was chosen is unknown, so it is `unread`, in
 *   neither `count` nor `agreed`. A decision without that predictor's
 *   prediction is not in its cell: one with no recommended option has no
 *   recommended prediction, and one opened before predictions were recorded
 *   has none at all (change-007 §3.3).
 * - **Delegated** figures count answers `by: policy | precedent`, with the
 *   decisions overridden from the digest and those reversed in any way.
 * - A `by: orchestrator` answer (Phase 1's `bm_decide`, change-004) is neither
 *   the owner's nor delegated: it is in no figure (change-007 C4).
 * - **Reversals** count decisions, not events: a decision reversed twice, or
 *   the same way twice, is one reversal, and once per kind in `byKind`.
 *
 * Only numbers and times leave this module: never a prediction, so an
 * unsettled decision's prediction is never exposed through the ledger.
 *
 * `shared/`: Zod and plain values only, no Node or React Native imports; no
 * clock — every time comes from the records.
 */
import { z } from "zod";
import {
  DECISION_CLASSES,
  PREDICTORS,
  decisionClassOf,
  decisionClassSchema,
  predictorSchema,
  type Decision,
  type DecisionClass,
  type Predictor,
  type ReversalKind,
} from "./decisions";

const countSchema = z.number().int().nonnegative();

/** Decisions reversed at least once in each way (a decision counts once per kind). */
export const reversalCountsSchema = z.object({ "re-asked": countSchema, overridden: countSchema, reopened: countSchema });
export type ReversalCounts = z.infer<typeof reversalCountsSchema>;

/** One project × class × predictor: the owner's answers against that predictor's predictions. */
export const agreementCellSchema = z.object({
  workspaceId: z.string().min(1),
  class: decisionClassSchema,
  predictor: predictorSchema,
  /** Owner answers whose content is known (an option or the owner's words) with this predictor's prediction. */
  count: countSchema,
  /** Of `count`, the answers that chose the predicted option. */
  agreed: countSchema,
  /** Owner answers confirmed from a chat, never read: in neither `count` nor `agreed`. */
  unread: countSchema,
  /** The earliest and latest answer time of `count`'s answers; null when `count` is 0. */
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
  /** The cell's decisions (counted or unread) reversed at least once. */
  reversals: countSchema,
  reversalsByKind: reversalCountsSchema,
});
export type AgreementCell = z.infer<typeof agreementCellSchema>;

/** Who answers a delegated decision (§B.5, §B.6). */
export const DELEGATED_BY = ["policy", "precedent"] as const;

/** One project × class × delegated answerer (and the policy's predictor): what became of those answers. */
export const delegatedCellSchema = z.object({
  workspaceId: z.string().min(1),
  class: decisionClassSchema,
  by: z.enum(DELEGATED_BY),
  /** The predictor that earned the `delegate` cell (`policy`); null for a precedent. */
  predictor: predictorSchema.nullable(),
  count: countSchema,
  /** Decisions the owner overrode from the digest (§B.7; A-4). */
  overridden: countSchema,
  /** Decisions reversed in any way, overrides included (A-5). */
  reversals: countSchema,
  reversalsByKind: reversalCountsSchema,
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type DelegatedCell = z.infer<typeof delegatedCellSchema>;

export const agreementLedgerSchema = z.object({
  cells: z.array(agreementCellSchema),
  delegated: z.array(delegatedCellSchema),
});
export type AgreementLedger = z.infer<typeof agreementLedgerSchema>;

export interface AgreementLedgerOptions {
  /** Only this project's decisions. */
  workspaceId?: string;
  /** Only answers given at or after this time (ISO); an answer whose time does not read is then left out. */
  since?: string;
  /**
   * Each class's last demotion per project (the policy's `demotions`, §B.4):
   * an agreement cell of a demoted class counts only the owner's answers
   * given at or after it, so eligibility is earned anew. The delegated
   * figures are not narrowed by it.
   */
  demotions?: Readonly<Record<string, Readonly<Partial<Record<DecisionClass, string>>>>>;
}

/** The last demotion of a class of a project, or null (own keys only: a workspace id is data). */
function demotionOf(demotions: AgreementLedgerOptions["demotions"], workspaceId: string, decisionClass: DecisionClass): string | null {
  if (demotions === undefined || !Object.prototype.hasOwnProperty.call(demotions, workspaceId)) return null;
  const project = demotions[workspaceId] ?? {};
  return Object.prototype.hasOwnProperty.call(project, decisionClass) ? (project[decisionClass] ?? null) : null;
}

/** The share of a cell's answers that agreed, or null when it has none (unknown, never zero). */
export function agreementRateOf(cell: Pick<AgreementCell, "agreed" | "count">): number | null {
  return cell.count === 0 ? null : cell.agreed / cell.count;
}

function noReversals(): ReversalCounts {
  return { "re-asked": 0, overridden: 0, reopened: 0 };
}

/** The kinds a decision was reversed in, each once. */
function reversalKindsOf(decision: Decision): Set<ReversalKind> {
  return new Set((decision.reversals ?? []).map((reversal) => reversal.kind));
}

function addReversals(cell: { reversals: number; reversalsByKind: ReversalCounts }, kinds: ReadonlySet<ReversalKind>): void {
  if (kinds.size === 0) return;
  cell.reversals += 1;
  for (const kind of kinds) cell.reversalsByKind[kind] += 1;
}

/** Widens `[firstAt, lastAt]` to take in `at` (a time that does not read changes nothing). */
function addTime(cell: { firstAt: string | null; lastAt: string | null }, at: string): void {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return;
  if (cell.firstAt === null || time < Date.parse(cell.firstAt)) cell.firstAt = at;
  if (cell.lastAt === null || time > Date.parse(cell.lastAt)) cell.lastAt = at;
}

const classRank = (value: DecisionClass): number => DECISION_CLASSES.indexOf(value);
const predictorRank = (value: Predictor | null): number => (value === null ? PREDICTORS.length : PREDICTORS.indexOf(value));

/**
 * The ledger of `decisions` (any order, any workspaces): the agreement cells,
 * sorted by project, class (riskiest first) and predictor, and the delegated
 * cells, sorted the same way with the policy before precedents. Only answered
 * decisions are read; a cell exists only when a decision is in it.
 */
export function agreementLedger(decisions: readonly Decision[], options: AgreementLedgerOptions = {}): AgreementLedger {
  const since = options.since === undefined ? null : Date.parse(options.since);
  const cells = new Map<string, AgreementCell>();
  const delegated = new Map<string, DelegatedCell>();

  for (const decision of decisions) {
    const answer = decision.answer;
    if (decision.status !== "answered" || answer === null) continue;
    if (options.workspaceId !== undefined && decision.workspaceId !== options.workspaceId) continue;
    if (since !== null && !(Date.parse(answer.at) >= since)) continue;
    const decisionClass = decisionClassOf(decision);
    const kinds = reversalKindsOf(decision);

    if (answer.by === "owner") {
      // After a demotion only the answers given since count (§B.4, §B.9).
      const demotedAt = demotionOf(options.demotions, decision.workspaceId, decisionClass);
      if (demotedAt !== null && !(Date.parse(answer.at) >= Date.parse(demotedAt))) continue;
      for (const predictor of PREDICTORS) {
        const predicted = decision.prediction?.[predictor] ?? null;
        if (predicted === null) continue;
        const key = `${decision.workspaceId}\u0000${decisionClass}\u0000${predictor}`;
        let cell = cells.get(key);
        if (cell === undefined) {
          cell = {
            workspaceId: decision.workspaceId,
            class: decisionClass,
            predictor,
            count: 0,
            agreed: 0,
            unread: 0,
            firstAt: null,
            lastAt: null,
            reversals: 0,
            reversalsByKind: noReversals(),
          };
          cells.set(key, cell);
        }
        if (answer.optionKey === null && answer.words === null) {
          cell.unread += 1;
        } else {
          cell.count += 1;
          // Own words never agree: only the predicted option does.
          if (answer.optionKey !== null && answer.optionKey === predicted.optionKey) cell.agreed += 1;
          addTime(cell, answer.at);
        }
        addReversals(cell, kinds);
      }
      continue;
    }

    if (answer.by === "policy" || answer.by === "precedent") {
      const predictor = answer.by === "policy" ? (answer.predictor ?? null) : null;
      const key = `${decision.workspaceId}\u0000${decisionClass}\u0000${answer.by}\u0000${predictor ?? ""}`;
      let cell = delegated.get(key);
      if (cell === undefined) {
        cell = {
          workspaceId: decision.workspaceId,
          class: decisionClass,
          by: answer.by,
          predictor,
          count: 0,
          overridden: 0,
          reversals: 0,
          reversalsByKind: noReversals(),
          firstAt: null,
          lastAt: null,
        };
        delegated.set(key, cell);
      }
      cell.count += 1;
      if (kinds.has("overridden")) cell.overridden += 1;
      addReversals(cell, kinds);
      addTime(cell, answer.at);
    }
    // `by: orchestrator` (change-004): neither the owner's answer nor a delegated one (change-007 C4).
  }

  const byPlace = (a: { workspaceId: string; class: DecisionClass }, b: { workspaceId: string; class: DecisionClass }) =>
    (a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0) || classRank(a.class) - classRank(b.class);
  return {
    cells: [...cells.values()].sort((a, b) => byPlace(a, b) || predictorRank(a.predictor) - predictorRank(b.predictor)),
    delegated: [...delegated.values()].sort(
      (a, b) => byPlace(a, b) || DELEGATED_BY.indexOf(a.by) - DELEGATED_BY.indexOf(b.by) || predictorRank(a.predictor) - predictorRank(b.predictor),
    ),
  };
}
