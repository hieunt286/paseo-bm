import { z } from "zod";
import {
  carriesPreparedChange,
  decisionClassOf,
  decisionClassSchema,
  decisionKindOf,
  isHardOwnerClass,
  notOpenRefusalOf,
  predictorSchema,
  preparedChangeRefusalText,
  type Decision,
  type DecisionClass,
  type DecisionOption,
  type Effect,
  type Predictor,
} from "./decisions";

/**
 * The owner's autonomy policy (autonomy design §B.2, ADR-018; PRD REQ-121):
 * for each project and decision class (§B.1), who decides.
 *
 * - `owner` — the owner decides. An absent cell reads as `owner`, which is
 *   every cell of a new install (REQ-121 b, Q-102).
 * - `shadow` — the owner decides too; it behaves as `owner` when a decision
 *   opens (the predictions are recorded in both, §B.9). It is what a demotion
 *   sets (§B.4).
 * - `delegate` — decided for the owner by the cell's predictor: the
 *   recommended option, or the Orchestrator (§B.5). Never for release, data,
 *   security or cost (REQ-121 c): those pass only through the owner's grant.
 *
 * Kept in `<data folder>/autonomy/policy.json` (`server/autonomy-store.ts`) =
 * `{ version: 1, projects: { <workspaceId>: { <class>: cell } }, challenger: { <workspaceId>: boolean }, demotions?: { <workspaceId>: { <class>: time } }, boundary?: { <workspaceId>: { enabled: true, at } } }`,
 * and served by `autonomy.policy`, `autonomy.set`, `autonomy.reset`,
 * `autonomy.set-challenger` and `autonomy.set-boundary` (`server/autonomy-rpc.ts`).
 * `boundary` is the action boundary's switch per project (§D.2, change-010:
 * off by default, set only by the owner with a confirmation, untouched by a
 * reset). The challenger switch
 * (§B.3, off by default per project, DQ-4) says whether the Orchestrator is
 * asked to predict the owner's answers in that project
 * (`predictionRefusalOf`). `demotions` holds each class's last demotion
 * (§B.4): the agreement ledger counts only the answers given since.
 *
 * Delegating (§B.4; PRD REQ-123 a; ADR-023): the owner sets any class but
 * release, data, security and cost to `delegate` at any time, with one
 * confirmation; no agreement threshold gates it.
 *
 * Delegation (§B.5; PRD REQ-121, REQ-123): `recommendedDelegationOf` says
 * what a `delegate` cell whose predictor is `recommended` answers for a
 * decision that has just opened (`server/policy-resolve.ts` writes it);
 * `decideRefusalOf` says whether the Orchestrator may decide one for a cell
 * whose predictor is `orchestrator` (`bm_decide`, and the event that asks it).
 * While a request stands finished-unverified (Phase 3, design §C.3, §C.6
 * change-008 C4), neither predictor chooses an option that acts on it as done
 * (`actsOnFinish`, `unverifiedFinishRefusalOf`).
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** The file format this build reads and writes. */
export const AUTONOMY_FILE_VERSION = 1;

export const AUTONOMY_MODES = ["owner", "shadow", "delegate"] as const;
export const autonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

/**
 * Who decides a delegated cell: the option marked recommended, or the
 * Orchestrator (§B.5) — the predictors of the agreement ledger
 * (`decisions.ts` `PREDICTORS`, the one list; code review 2026-09-30 §3.5).
 */
export type AutonomyPredictor = Predictor;

/**
 * A delegation's predictor when `autonomy.set` names none (§B.9). Settings
 * and Insights always name the predictor the owner chose; this default serves
 * a caller that names none.
 */
export const DEFAULT_AUTONOMY_PREDICTOR: AutonomyPredictor = "recommended";

const isoTimeSchema = z.string().min(1);

/**
 * One cell: its mode and when it was set (`at`, ISO). A `delegate` cell also
 * records the predictor the owner chose for it.
 */
export const autonomyCellSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("owner"), at: isoTimeSchema }),
  z.object({ mode: z.literal("shadow"), at: isoTimeSchema }),
  z.object({ mode: z.literal("delegate"), predictor: predictorSchema, at: isoTimeSchema }),
]);
export type AutonomyCell = z.infer<typeof autonomyCellSchema>;

export type AutonomyCells = Partial<Record<DecisionClass, AutonomyCell>>;

/**
 * When each class of each project was last demoted (§B.4, §B.9), ISO. Written
 * only by a demotion, which replaces an older time; kept when the owner sets
 * the cell again or resets the project, so the agreement ledger counts the
 * class from the answers given after it. Absent from a policy with no demotion.
 */
export const autonomyDemotionsSchema = z.record(z.string().min(1), z.partialRecord(decisionClassSchema, isoTimeSchema));

/**
 * One project's action boundary switch (autonomy design §D.2, change-010 C2):
 * on since `at`, ISO. Only an entry that is on is stored; turning it off
 * removes the entry, so an absent one reads as off (the default).
 */
export const boundaryEntrySchema = z.object({ enabled: z.literal(true), at: isoTimeSchema });
export type BoundaryEntry = z.infer<typeof boundaryEntrySchema>;

/** The whole policy, as the RPCs return it. */
export const autonomyPolicySchema = z.object({
  projects: z.record(z.string().min(1), z.partialRecord(decisionClassSchema, autonomyCellSchema)),
  challenger: z.record(z.string().min(1), z.boolean()),
  demotions: autonomyDemotionsSchema.optional(),
  /** The projects whose action boundary the owner turned on (§D.2, change-010); absent when none is. */
  boundary: z.record(z.string().min(1), boundaryEntrySchema).optional(),
});
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

/** What a missing, corrupt or newer file reads as: every class of every project `owner`, no challenger. */
export const EMPTY_AUTONOMY_POLICY: AutonomyPolicy = { projects: {}, challenger: {} };

/**
 * `autonomy.set`'s input: one cell of one project. `confirmed: true` is needed
 * only for `delegate`; `predictor` is read only for `delegate`.
 */
export const autonomySetInputSchema = z.object({
  workspaceId: z.string().min(1),
  class: decisionClassSchema,
  mode: autonomyModeSchema,
  confirmed: z.boolean().optional(),
  predictor: predictorSchema.optional(),
});
export type AutonomySetInput = z.infer<typeof autonomySetInputSchema>;

/**
 * `autonomy.set-challenger`'s input (§B.9): one project's challenger on or
 * off. No confirmation: it only records predictions.
 */
export const autonomySetChallengerInputSchema = z.object({
  workspaceId: z.string().min(1),
  enabled: z.boolean(),
});
export type AutonomySetChallengerInput = z.infer<typeof autonomySetChallengerInputSchema>;

/**
 * `autonomy.set-boundary`'s input (§D.2, change-010 C2): one project's action
 * boundary on or off. Both directions need `confirmed: true`: each changes the
 * mode of the Workers and Reviewers created afterwards.
 */
export const autonomySetBoundaryInputSchema = z.object({
  workspaceId: z.string().min(1),
  enabled: z.boolean(),
  confirmed: z.boolean().optional(),
});
export type AutonomySetBoundaryInput = z.infer<typeof autonomySetBoundaryInputSchema>;

/** False for release, data, security and cost (`isHardOwnerClass`): they are never `delegate`. */
export function canDelegate(decisionClass: DecisionClass): boolean {
  return !isHardOwnerClass(decisionClass);
}

/**
 * A workspace id the policy keys a project by. `__proto__` is refused: as an
 * object key it would read as the prototype, not as a project.
 */
export function isPolicyWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "__proto__";
}

/** `Object.hasOwn`, spelled so that every renderer the client runs on has it. */
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A project's cells, or none. */
export function cellsOf(policy: AutonomyPolicy, workspaceId: string): AutonomyCells {
  return hasOwn(policy.projects, workspaceId) ? (policy.projects[workspaceId] ?? {}) : {};
}

/**
 * A project's stored cell of one class, or null when there is none (it reads
 * as `owner`). A `delegate` cell of a hard-owner class never reads: whatever a
 * file says, those classes are the owner's.
 */
export function cellOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): AutonomyCell | null {
  const cells = cellsOf(policy, workspaceId);
  const cell = hasOwn(cells, decisionClass) ? cells[decisionClass] : undefined;
  if (cell === undefined) return null;
  if (cell.mode === "delegate" && !canDelegate(decisionClass)) return null;
  return cell;
}

/** Who decides this class in this project; an absent cell is `owner` (REQ-121 b). */
export function modeOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): AutonomyMode {
  return cellOf(policy, workspaceId, decisionClass)?.mode ?? "owner";
}

/** The predictor of a delegated cell, or null when the cell is not `delegate`. */
export function predictorOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): AutonomyPredictor | null {
  const cell = cellOf(policy, workspaceId, decisionClass);
  return cell?.mode === "delegate" ? cell.predictor : null;
}

/** Whether the project's challenger is on (§B.3); off unless the owner turned it on (DQ-4). */
export function challengerOf(policy: AutonomyPolicy, workspaceId: string): boolean {
  return hasOwn(policy.challenger, workspaceId) && policy.challenger[workspaceId] === true;
}

/** The project's action boundary entry (§D.2, change-010) when the owner turned it on; null (off) otherwise, the default. */
export function boundaryOf(policy: AutonomyPolicy, workspaceId: string): BoundaryEntry | null {
  const boundary = policy.boundary;
  if (boundary === undefined || !hasOwn(boundary, workspaceId)) return null;
  return boundary[workspaceId] ?? null;
}

/** The projects whose action boundary is on. */
export function boundaryProjects(policy: AutonomyPolicy): string[] {
  return Object.keys(policy.boundary ?? {}).filter((workspaceId) => isPolicyWorkspaceId(workspaceId) && boundaryOf(policy, workspaceId) !== null);
}

/** When a class of a project was last demoted (§B.4), or null when it never was. */
export function demotedAtOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): string | null {
  const demotions = policy.demotions;
  if (demotions === undefined || !hasOwn(demotions, workspaceId)) return null;
  const project = demotions[workspaceId] ?? {};
  return hasOwn(project, decisionClass) ? (project[decisionClass] ?? null) : null;
}

/**
 * Why the Orchestrator challenger may not predict `decision` now (§B.3, §B.9;
 * change-007 C1), or null when it may: a decision it did not ask — a Worker's
 * question (`q:`) or a fallback incident (`f:`) —, still `open`, of a class
 * that can be delegated, in an `owner` or `shadow` cell of a project whose
 * challenger is on, opened with its predictions recorded, and not predicted by
 * the Orchestrator yet. The rest of the project's policy does not matter: a
 * project whose cells are all `owner` is asked too. Pure: the event bus asks
 * by it (`decision.opened`), and `bm_predict` records by it.
 */
export function predictionRefusalOf(policy: AutonomyPolicy, decision: Decision): string | null {
  // Autonomy design §B.7: an override is the owner's correction of an answer made for them.
  if (decisionKindOf(decision.id) === "override") return overrideIsTheOwners(decision.id);
  // Autonomy design §D.2 (change-009 C6): a held request is not predicted.
  if (decisionKindOf(decision.id) === "held") return heldIsTheOwners(decision.id);
  // Autonomy design §G.4: a change of the owner's settings is theirs alone, whoever asked it.
  if (carriesPreparedChange(decision)) return `${preparedChangeRefusalText(decision.id)}; it is not predicted`;
  if (decisionKindOf(decision.id) === "orchestrator") {
    return `${decision.id} is your own decision; a prediction is for a Worker's question (q:…) or a fallback incident (f:…)`;
  }
  const settled = `decision ${decision.id} is ${decision.status}; only an open decision is predicted`;
  const notOpen = notOpenRefusalOf(decision, {
    needsConfirmation: `decision ${decision.id} waits for the owner to confirm an answer typed in a chat; it is not predicted`,
    answered: () => settled,
    superseded: () => settled,
    closed: () => settled,
  });
  if (notOpen !== null) return notOpen;
  const decisionClass = decisionClassOf(decision);
  if (!canDelegate(decisionClass)) return `decision ${decision.id} is of the class ${decisionClass}, which is always the owner's; it is never predicted`;
  if (modeOf(policy, decision.workspaceId, decisionClass) === "delegate") {
    return `${decisionClass} is delegated in project ${decision.workspaceId}; a delegated decision is not predicted`;
  }
  if (!challengerOf(policy, decision.workspaceId)) return `the owner has not turned your predictions on for project ${decision.workspaceId}`;
  if (decision.prediction === undefined) return `decision ${decision.id} was opened before predictions were recorded; it is not predicted`;
  const predicted = decision.prediction.orchestrator;
  if (predicted !== null) return `you predicted decision ${decision.id} already, at ${predicted.at}; one prediction per decision`;
  return null;
}

// ---------------------------------------------------------------------------
// Delegation (§B.5; PRD REQ-121, REQ-123).
// ---------------------------------------------------------------------------

/** What a policy answer by the recommended option carries as its reason (§B.5): shown under Details and on the digest. */
export function policyReasonOf(decisionClass: DecisionClass): string {
  return `The recommended option: ${decisionClass} is delegated to it in this project`;
}

/** The answer the policy gives a decision for the owner (§B.5): the option, the cell's class and predictor, and why. */
export interface PolicyAnswer {
  optionKey: string;
  class: DecisionClass;
  predictor: "recommended";
  reason: string;
}

/**
 * What the owner's policy answers for `decision` as it opens (§B.5; PRD
 * REQ-121, REQ-123), or null when the owner decides it: the decision is
 * `open`; its class (`decisionClassOf`) can be delegated and is `delegate` in
 * its project with the predictor `recommended`; and exactly one of its
 * options is recommended. The answer is that option. Since the class is
 * checked against every option's effects, a release, data, security or cost
 * effect anywhere keeps the decision the owner's; `answerDecision` refuses a
 * policy answer granting one as a second line. A `delegate` cell whose
 * predictor is the Orchestrator is not answered here: the Orchestrator
 * decides it (`bm_decide`, `decideRefusalOf`). Pure.
 */
export function recommendedDelegationOf(policy: AutonomyPolicy, decision: Decision): PolicyAnswer | null {
  // Autonomy design §B.7: the owner's override is never answered for them.
  // §D.2: a held request is covered by the policy only as the boundary holds it (`server/action-boundary.ts`).
  if (decisionKindOf(decision.id) === "override" || decisionKindOf(decision.id) === "held") return null;
  // Autonomy design §G.4: a prepared change of the owner's settings is never the policy's to choose.
  if (decision.status !== "open" || carriesPreparedChange(decision)) return null;
  const decisionClass = decisionClassOf(decision);
  // A hard-owner class never reads `delegate` (`cellOf`), so it has no predictor.
  if (predictorOf(policy, decision.workspaceId, decisionClass) !== "recommended") return null;
  const recommended = decision.options.filter((option) => option.recommended);
  if (recommended.length !== 1) return null;
  return { optionKey: recommended[0]!.key, class: decisionClass, predictor: "recommended", reason: policyReasonOf(decisionClass) };
}

/**
 * Whether choosing `option` acts on its request as done (design §C.6,
 * change-008 C4): it declares `commit`, or it carries a prepared command that
 * approves `commit` or has the intent `release`. A policy answer never grants
 * push, publish or deploy (§B.5), so these are what a delegate could do with
 * a finish. Pure.
 */
export function actsOnFinish(option: Pick<DecisionOption, "effects" | "action">): boolean {
  if (option.effects.includes("commit")) return true;
  const action = option.action;
  return action?.kind === "command" && commandActsOnFinish({ approved: action.effects, intent: action.intent });
}

/**
 * Whether a command acts on its request as done (design §C.6, change-008 C4):
 * it approves `commit`, or its intent is `release`. Pure.
 */
export function commandActsOnFinish(command: { approved: readonly Effect[]; intent: string | null }): boolean {
  return command.approved.includes("commit") || command.intent === "release";
}

/**
 * The one reason every delegation refusal on an unverified finish gives (design
 * §C.6, change-008 C4), with what the delegate does instead.
 */
export function unverifiedFinishText(requestId: string | null, instead: string): string {
  const request = requestId === null ? "its request" : `request ${requestId}`;
  return `${request} finished unverified: its code changed and not every check its report names was seen to pass after the last edit, so a commit or release on it is the owner's to decide; ${instead}`;
}

/**
 * Why the owner's policy may not answer `decision` with `optionKey` now
 * (design §C.6, change-008 C4), or null when it may: while the decision's
 * request stands finished-unverified — `finishedUnverified`, read by the
 * caller from the trace store (`server/request-trace.ts`
 * `isFinishedUnverifiedNow`) — an option that acts on the finish
 * (`actsOnFinish`) is left to the owner. Either predictor: the recommended
 * option at open (`server/policy-resolve.ts`) and the Orchestrator's
 * `bm_decide` (`decideRefusalOf`). A precedent's answer and the owner's own are
 * not asked. Pure.
 */
export function unverifiedFinishRefusalOf(decision: Pick<Decision, "id" | "requestId" | "options">, optionKey: string, finishedUnverified: boolean): string | null {
  if (!finishedUnverified) return null;
  const option = decision.options.find((entry) => entry.key === optionKey);
  if (option === undefined || !actsOnFinish(option)) return null;
  return unverifiedFinishText(decision.requestId, `leave decision ${decision.id} to the owner`);
}

/**
 * Why the Orchestrator may not decide `decision` for the owner now (§B.5,
 * §B.9; bead `t9lm.11`), or null when it may: a decision it did not ask — a
 * Worker's question (`q:`) or a fallback incident (`f:`); an `o:` decision is
 * the owner's whatever its cell —, still `open` (not waiting for a
 * confirmation, answered, superseded, withdrawn or expired), of a class that
 * can be delegated, and `delegate` in its project with the predictor
 * `orchestrator`. An `owner` or `shadow` cell, a cell of the recommended
 * predictor and release, data, security or cost stay the owner's (or the
 * plugin's). Pure: the event bus asks by it (`decision.opened`,
 * `asks: "decision"`), and `bm_decide` answers by it — with `choice`, the
 * option it chose and whether the decision's request stands finished-unverified
 * (design §C.6, change-008 C4: `unverifiedFinishRefusalOf`).
 */
export function decideRefusalOf(
  policy: AutonomyPolicy,
  decision: Decision,
  choice?: { optionKey: string; finishedUnverified: boolean },
): string | null {
  // Autonomy design §B.7: an override is the owner's correction of an answer made for them.
  if (decisionKindOf(decision.id) === "override") return overrideIsTheOwners(decision.id);
  // Autonomy design §D.2 (change-009 C6): a held request is the owner's; bm_decide never answers it.
  if (decisionKindOf(decision.id) === "held") return heldIsTheOwners(decision.id);
  // Autonomy design §G.4: a change of the owner's settings is theirs alone, whoever asked it and whatever its cell.
  if (carriesPreparedChange(decision)) return `${preparedChangeRefusalText(decision.id)}; leave it to the owner`;
  if (decisionKindOf(decision.id) === "orchestrator") {
    return `${decision.id} is your own decision, and only the owner answers it; bm_decide decides a Worker's question (q:…) or a fallback incident (f:…)`;
  }
  const notOpen = notOpenRefusalOf(decision, {
    needsConfirmation: `decision ${decision.id} waits for the owner to confirm an answer typed in a chat; it is the owner's`,
    answered: (by, at) => `decision ${decision.id} was already answered by ${by} at ${at}; the first answer stands`,
    superseded: (by) => `decision ${decision.id} is superseded by ${by}; answer that one if it is still open`,
    closed: (status) => `decision ${decision.id} is ${status}; it can no longer be answered`,
  });
  if (notOpen !== null) return notOpen;
  const decisionClass = decisionClassOf(decision);
  if (!canDelegate(decisionClass)) return `decision ${decision.id} is of the class ${decisionClass}, which is always the owner's; leave it to the owner`;
  const predictor = predictorOf(policy, decision.workspaceId, decisionClass);
  if (predictor === null) return `${decisionClass} is not delegated to you in project ${decision.workspaceId}; the owner decides it, so leave it to the owner`;
  if (predictor !== "orchestrator") return `${decisionClass} is delegated to the recommended option in project ${decision.workspaceId}, not to you; leave it to the owner`;
  return choice === undefined ? null : unverifiedFinishRefusalOf(decision, choice.optionKey, choice.finishedUnverified);
}

/**
 * The projects with at least one class above `owner` (a `shadow` or
 * `delegate` cell): the scope of the Orchestrator's `request.finished`,
 * `request.stalled` and `worker.signal` events (design §A.8 Scope, change-007
 * C1). A project whose cells are all `owner`, stored or absent, is not in it.
 */
export function projectsAboveOwner(policy: AutonomyPolicy): Set<string> {
  return new Set(
    Object.keys(policy.projects).filter(
      (workspaceId) =>
        isPolicyWorkspaceId(workspaceId) &&
        Object.keys(cellsOf(policy, workspaceId)).some((key) => {
          const decisionClass = decisionClassSchema.safeParse(key);
          return decisionClass.success && modeOf(policy, workspaceId, decisionClass.data) !== "owner";
        }),
    ),
  );
}

/**
 * The policy a parsed file body holds. Each cell is read on its own: one with
 * an unknown class, an unknown mode, a `delegate` without a predictor or a
 * `delegate` of a hard-owner class is skipped alone (it reads as `owner`) and
 * costs no other; a challenger entry that is not a boolean is skipped the
 * same way, and so is a demotion of a class that cannot be delegated or whose
 * time does not read. Unknown keys are ignored. The `version` is the caller's
 * to check.
 */
export function autonomyPolicyOf(body: unknown): AutonomyPolicy {
  const file = objectOf(body);
  const projects: Array<[string, AutonomyCells]> = [];
  for (const [workspaceId, rawCells] of Object.entries(objectOf(file?.["projects"]) ?? {})) {
    if (!isPolicyWorkspaceId(workspaceId)) continue;
    const cells: Array<[DecisionClass, AutonomyCell]> = [];
    for (const [key, rawCell] of Object.entries(objectOf(rawCells) ?? {})) {
      const decisionClass = decisionClassSchema.safeParse(key);
      const cell = autonomyCellSchema.safeParse(rawCell);
      if (!decisionClass.success || !cell.success) continue;
      if (cell.data.mode === "delegate" && !canDelegate(decisionClass.data)) continue;
      cells.push([decisionClass.data, cell.data]);
    }
    if (cells.length > 0) projects.push([workspaceId, Object.fromEntries(cells) as AutonomyCells]);
  }
  const challenger = Object.entries(objectOf(file?.["challenger"]) ?? {}).filter(
    (entry): entry is [string, boolean] => isPolicyWorkspaceId(entry[0]) && typeof entry[1] === "boolean",
  );
  const demotions: Array<[string, Partial<Record<DecisionClass, string>>]> = [];
  for (const [workspaceId, rawTimes] of Object.entries(objectOf(file?.["demotions"]) ?? {})) {
    if (!isPolicyWorkspaceId(workspaceId)) continue;
    const times = Object.entries(objectOf(rawTimes) ?? {}).filter((entry): entry is [DecisionClass, string] => {
      const decisionClass = decisionClassSchema.safeParse(entry[0]);
      return decisionClass.success && canDelegate(decisionClass.data) && typeof entry[1] === "string" && !Number.isNaN(Date.parse(entry[1]));
    });
    if (times.length > 0) demotions.push([workspaceId, Object.fromEntries(times)]);
  }
  // The action boundary (§D.2, change-010 C2): each entry on its own; one that is not `{ enabled: true, at }` reads as off.
  const boundary = Object.entries(objectOf(file?.["boundary"]) ?? {}).flatMap(([workspaceId, raw]): Array<[string, BoundaryEntry]> => {
    const entry = boundaryEntrySchema.safeParse(raw);
    return isPolicyWorkspaceId(workspaceId) && entry.success && !Number.isNaN(Date.parse(entry.data.at)) ? [[workspaceId, { enabled: true, at: entry.data.at }]] : [];
  });
  return {
    projects: Object.fromEntries(projects),
    challenger: Object.fromEntries(challenger),
    ...(demotions.length === 0 ? {} : { demotions: Object.fromEntries(demotions) }),
    ...(boundary.length === 0 ? {} : { boundary: Object.fromEntries(boundary) }),
  };
}

/** The policy of one project only (`autonomy.policy { workspaceId }`). */
export function policyOfProject(policy: AutonomyPolicy, workspaceId: string): AutonomyPolicy {
  const demotions = policy.demotions;
  return {
    projects: hasOwn(policy.projects, workspaceId) ? { [workspaceId]: cellsOf(policy, workspaceId) } : {},
    challenger: hasOwn(policy.challenger, workspaceId) ? { [workspaceId]: policy.challenger[workspaceId]! } : {},
    ...(demotions !== undefined && hasOwn(demotions, workspaceId) ? { demotions: { [workspaceId]: demotions[workspaceId] ?? {} } } : {}),
    ...(boundaryOf(policy, workspaceId) === null ? {} : { boundary: { [workspaceId]: boundaryOf(policy, workspaceId)! } }),
  };
}

/** `policy` with one cell set; the cell is already allowed. */
export function withCell(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass, cell: AutonomyCell): AutonomyPolicy {
  return {
    ...policy,
    projects: { ...policy.projects, [workspaceId]: { ...cellsOf(policy, workspaceId), [decisionClass]: cell } },
  };
}

/**
 * `policy` with one class demoted at `at` (§B.4): its cell `shadow`, set at
 * `at`, and `at` as the class's last demotion. The caller has checked the cell
 * was `delegate`.
 */
export function withDemotion(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass, at: string): AutonomyPolicy {
  const demotions = policy.demotions ?? {};
  const project = hasOwn(demotions, workspaceId) ? (demotions[workspaceId] ?? {}) : {};
  return {
    ...withCell(policy, workspaceId, decisionClass, { mode: "shadow", at }),
    demotions: { ...demotions, [workspaceId]: { ...project, [decisionClass]: at } },
  };
}

/**
 * `policy` with every class of one project back to `owner` (REQ-121 d): its
 * cells removed, since an absent cell reads as `owner`. The challenger is not
 * a class and stays as it is; so do the demotions, which are history, not a
 * mode (§B.4).
 */
export function withProjectReset(policy: AutonomyPolicy, workspaceId: string): AutonomyPolicy {
  return {
    ...policy,
    projects: Object.fromEntries(Object.entries(policy.projects).filter(([id]) => id !== workspaceId)),
  };
}

/** `policy` with one project's challenger switched (§B.3); its cells stay as they are. */
export function withChallenger(policy: AutonomyPolicy, workspaceId: string, enabled: boolean): AutonomyPolicy {
  return { ...policy, challenger: { ...policy.challenger, [workspaceId]: enabled } };
}

/**
 * `policy` with one project's action boundary on since `at`, or off (its entry
 * removed; the key goes when no project has one). Its cells stay as they are.
 */
export function withBoundary(policy: AutonomyPolicy, workspaceId: string, at: string | null): AutonomyPolicy {
  const rest = Object.fromEntries(Object.entries(policy.boundary ?? {}).filter(([id]) => id !== workspaceId));
  const boundary = at === null ? rest : { ...rest, [workspaceId]: { enabled: true as const, at } };
  const next: AutonomyPolicy = { ...policy };
  delete next.boundary;
  return Object.keys(boundary).length === 0 ? next : { ...next, boundary };
}

/** Why `autonomy.set` refuses an input; each refusal writes nothing. */
export type AutonomySetRefusal = {
  code: "E_AUTONOMY_INVALID" | "E_AUTONOMY_OWNER_ONLY" | "E_AUTONOMY_NOT_CONFIRMED";
  detail: string;
};

/** What each field of `autonomy.set` must be, for the refusal's message. */
const SET_FIELDS: Readonly<Record<string, string>> = {
  workspaceId: "a project",
  class: "one of the nine decision classes",
  mode: "owner, shadow or delegate",
  predictor: "recommended or orchestrator",
  confirmed: "true or false",
};

/**
 * `autonomy.set`'s checks, in order (§B.9), before anything is read or
 * written: an input that is not one project, one known class and one known
 * mode → `E_AUTONOMY_INVALID`; `delegate` for release, data, security or cost,
 * confirmed or not → `E_AUTONOMY_OWNER_ONLY`; `delegate` without
 * `confirmed: true` → `E_AUTONOMY_NOT_CONFIRMED`. No agreement threshold is
 * checked (ADR-023): the owner delegates a class whenever they choose.
 */
export function checkAutonomySet(input: unknown): { change: AutonomySetInput } | { refusal: AutonomySetRefusal } {
  const parsed = autonomySetInputSchema.safeParse(input);
  if (!parsed.success || !isPolicyWorkspaceId(parsed.data.workspaceId)) {
    const field = parsed.success ? "workspaceId" : String(parsed.error.issues[0]?.path[0] ?? "");
    const expected = SET_FIELDS[field];
    const got = JSON.stringify((objectOf(input) ?? {})[field] ?? null);
    return {
      refusal: {
        code: "E_AUTONOMY_INVALID",
        detail:
          expected === undefined
            ? "expected { workspaceId, class, mode }; nothing was saved"
            : `${field} ${got} is not ${expected}; nothing was saved`,
      },
    };
  }
  const change = parsed.data;
  if (change.mode === "delegate" && !canDelegate(change.class)) {
    return {
      refusal: {
        code: "E_AUTONOMY_OWNER_ONLY",
        detail: `${change.class} decisions are always the owner's and cannot be delegated; nothing was saved`,
      },
    };
  }
  if (change.mode === "delegate" && change.confirmed !== true) {
    return {
      refusal: { code: "E_AUTONOMY_NOT_CONFIRMED", detail: `delegating ${change.class} needs the owner's confirmation; nothing was saved` },
    };
  }
  return { change };
}

/**
 * `autonomy.set-challenger`'s check (§B.9), before anything is read or
 * written: one project and a boolean, else `E_AUTONOMY_INVALID`. Turning it on
 * needs no confirmation.
 */
export function checkAutonomySetChallenger(input: unknown): { change: AutonomySetChallengerInput } | { refusal: AutonomySetRefusal } {
  const parsed = autonomySetChallengerInputSchema.safeParse(input);
  if (parsed.success && isPolicyWorkspaceId(parsed.data.workspaceId)) return { change: parsed.data };
  const field = parsed.success || parsed.error.issues[0]?.path[0] !== "enabled" ? "workspaceId" : "enabled";
  const got = JSON.stringify((objectOf(input) ?? {})[field] ?? null);
  return {
    refusal: { code: "E_AUTONOMY_INVALID", detail: `${field} ${got} is not ${field === "enabled" ? "true or false" : "a project"}; nothing was saved` },
  };
}

/**
 * `autonomy.set-boundary`'s check (§D.2, change-010 C2), before anything is
 * read or written: one project and a boolean, else `E_AUTONOMY_INVALID`;
 * either direction without `confirmed: true` → `E_AUTONOMY_NOT_CONFIRMED`.
 */
export function checkAutonomySetBoundary(input: unknown): { change: AutonomySetBoundaryInput } | { refusal: AutonomySetRefusal } {
  const parsed = autonomySetBoundaryInputSchema.safeParse(input);
  if (!parsed.success || !isPolicyWorkspaceId(parsed.data.workspaceId)) {
    const issue = parsed.success ? "workspaceId" : String(parsed.error.issues[0]?.path[0] ?? "workspaceId");
    const field = issue === "enabled" || issue === "confirmed" ? issue : "workspaceId";
    const got = JSON.stringify((objectOf(input) ?? {})[field] ?? null);
    return {
      refusal: { code: "E_AUTONOMY_INVALID", detail: `${field} ${got} is not ${field === "workspaceId" ? "a project" : "true or false"}; nothing was saved` },
    };
  }
  if (parsed.data.confirmed !== true) {
    return {
      refusal: {
        code: "E_AUTONOMY_NOT_CONFIRMED",
        detail: `turning the action boundary ${parsed.data.enabled ? "on" : "off"} needs the owner's confirmation; nothing was saved`,
      },
    };
  }
  return { change: parsed.data };
}

/** The cell `autonomy.set` stores for a checked change, set at `at`. */
export function cellOfChange(change: AutonomySetInput, at: string): AutonomyCell {
  if (change.mode === "delegate") return { mode: "delegate", predictor: change.predictor ?? DEFAULT_AUTONOMY_PREDICTOR, at };
  return { mode: change.mode, at };
}

/** Why nobody but the owner predicts or decides an override (§B.7, §B.9): it is the owner's correction of an answer made for them. */
function overrideIsTheOwners(id: string): string {
  return `${id} is the owner's override of an answer made for them; only the owner answers it, so leave it to the owner`;
}

/** Why nobody but the owner predicts or decides a held request (§D.2, change-009 C6): the plugin held it for the owner. */
function heldIsTheOwners(id: string): string {
  return `${id} is a permission request the plugin held for the owner; only the owner allows or denies it, so leave it to the owner`;
}
