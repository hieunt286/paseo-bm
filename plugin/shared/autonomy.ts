import { z } from "zod";
import {
  carriesPreparedChange,
  decisionClassOf,
  decisionClassSchema,
  decisionKindOf,
  DECISION_CLASSES,
  MAX_POLICY_REVIEW_GRANT_CALLS,
  notOpenRefusalOf,
  policyMayGrant,
  preparedChangeRefusalText,
  REVIEW_BUDGET_SUBJECT,
  type Decision,
  type DecisionClass,
  type DecisionOption,
  type Effect,
} from "./decisions";

/**
 * The owner's autonomy policy (autonomy design §B.2, ADR-018, ADR-025; PRD
 * REQ-121): for each project and decision class (§B.1), who decides.
 *
 * - `owner` — the owner decides. An absent cell reads as `owner`, which is
 *   every cell of a new install (REQ-121 b, Q-102).
 * - `shadow` — the owner decides too, with the Orchestrator's prediction
 *   shown as its proposal while the project's prediction switch is on.
 * - `delegate` — the Orchestrator decides for the owner (`bm_decide`, §B.5),
 *   any class (ADR-025: no class is the owner's by rule).
 *
 * The owner sets them as one **level** per project (ADR-025, `LEVELS`):
 * `autonomy.set-level` writes the nine cells and the prediction switch in one
 * write (`withLevel`), and `levelOf` reads the level back — `custom` when the
 * cells match no level.
 *
 * Kept in `<data folder>/autonomy/policy.json` (`server/autonomy-store.ts`) =
 * `{ version: 1, projects: { <workspaceId>: { <class>: cell } }, challenger: { <workspaceId>: boolean }, boundary?: { <workspaceId>: { enabled: true, at } } }`,
 * and served by `autonomy.policy`, `autonomy.set-level`, `autonomy.set`,
 * `autonomy.reset`, `autonomy.set-challenger` and `autonomy.set-boundary`
 * (`server/autonomy-rpc.ts`). `boundary` is the action boundary's switch per
 * project (§D.2, change-010: off by default, set only by the owner with a
 * confirmation, untouched by a reset and by a level). The challenger switch
 * (§B.3, the prediction switch) says whether the Orchestrator is asked to
 * predict the owner's answers in that project (`predictionRefusalOf`). A file
 * of an older build may hold `demotions` and cells naming a predictor: both
 * are read past (a `recommended` cell reads as the Orchestrator's) and
 * dropped by the next write. An override is only recorded (ADR-025 decision 4).
 *
 * Delegation (§B.5; PRD REQ-121, REQ-123): `decideRefusalOf` says whether the
 * Orchestrator may decide a decision for the owner (`bm_decide`, and the
 * event that asks it). While a request stands finished-unverified (Phase 3,
 * design §C.3, §C.6 change-008 C4), it chooses no option that acts on it as
 * done (`actsOnFinish`, `unverifiedFinishRefusalOf`).
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** The file format this build reads and writes. */
export const AUTONOMY_FILE_VERSION = 1;

export const AUTONOMY_MODES = ["owner", "shadow", "delegate"] as const;
export const autonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomyMode = z.infer<typeof autonomyModeSchema>;

const isoTimeSchema = z.string().min(1);

/**
 * One cell: its mode and when it was set (`at`, ISO). A `delegate` cell is
 * the Orchestrator's (ADR-025 decision 5); the `predictor` an older build
 * stored on it is not read, so a `recommended` one reads as the Orchestrator's.
 */
export const autonomyCellSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("owner"), at: isoTimeSchema }),
  z.object({ mode: z.literal("shadow"), at: isoTimeSchema }),
  z.object({ mode: z.literal("delegate"), at: isoTimeSchema }),
]);
export type AutonomyCell = z.infer<typeof autonomyCellSchema>;

export type AutonomyCells = Partial<Record<DecisionClass, AutonomyCell>>;

// ---------------------------------------------------------------------------
// Levels (ADR-025 decision 1, 2).
// ---------------------------------------------------------------------------

/** The five levels, 0–4. */
export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const autonomyLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

/** A project's level as read back from its cells: one of the five, or `custom` when they match none. */
export type AutonomyLevelReading = AutonomyLevel | "custom";
export const autonomyLevelReadingSchema = z.union([autonomyLevelSchema, z.literal("custom")]);

/** What one level is: its key, its name for display, and the classes the Orchestrator decides at it. */
export interface LevelDefinition {
  level: AutonomyLevel;
  key: "hands-on" | "co-pilot" | "cruise" | "turbo" | "full-auto";
  name: string;
  /** The classes `delegate` at this level; every other class is `shadow` (levels 1–4) or `owner` (level 0). */
  delegated: readonly DecisionClass[];
}

const CRUISE_CLASSES: readonly DecisionClass[] = ["reversible-technical", "preference", "scope", "environment", "dependency"];
const TURBO_CLASSES: readonly DecisionClass[] = [...CRUISE_CLASSES, "cost", "release", "data"];

/**
 * The levels (ADR-025 decision 1): Hands-on — the owner decides everything,
 * no prediction; Co-pilot — the Orchestrator proposes, the owner decides;
 * Cruise — it decides the five technical classes; Turbo — also cost, release
 * and data; Full auto — every class, security included.
 */
export const LEVELS: readonly LevelDefinition[] = [
  { level: 0, key: "hands-on", name: "Hands-on", delegated: [] },
  { level: 1, key: "co-pilot", name: "Co-pilot", delegated: [] },
  { level: 2, key: "cruise", name: "Cruise", delegated: CRUISE_CLASSES },
  { level: 3, key: "turbo", name: "Turbo", delegated: TURBO_CLASSES },
  { level: 4, key: "full-auto", name: "Full auto", delegated: DECISION_CLASSES },
];

/** The levels that need the owner's confirmation (ADR-025 decision 3): Turbo and Full auto. */
export function levelNeedsConfirmation(level: AutonomyLevel): boolean {
  return level >= 3;
}

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
  /** The projects whose action boundary the owner turned on (§D.2, change-010); absent when none is. */
  boundary: z.record(z.string().min(1), boundaryEntrySchema).optional(),
});
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

/** What a missing, corrupt or newer file reads as: every class of every project `owner`, no challenger. */
export const EMPTY_AUTONOMY_POLICY: AutonomyPolicy = { projects: {}, challenger: {} };

/**
 * `autonomy.set`'s input: one cell of one project. `confirmed: true` is needed
 * only for `delegate`. Strict: a field it does not take — the `predictor` of
 * builds before ADR-025 — is refused, not dropped.
 */
export const autonomySetInputSchema = z
  .object({
    workspaceId: z.string().min(1),
    class: decisionClassSchema,
    mode: autonomyModeSchema,
    confirmed: z.boolean().optional(),
  })
  .strict();
export type AutonomySetInput = z.infer<typeof autonomySetInputSchema>;

/**
 * `autonomy.set-level`'s input (ADR-025): one project's level. Turbo and Full
 * auto (3, 4) need `confirmed: true`.
 */
export const autonomySetLevelInputSchema = z.object({
  workspaceId: z.string().min(1),
  level: autonomyLevelSchema,
  confirmed: z.boolean().optional(),
});
export type AutonomySetLevelInput = z.infer<typeof autonomySetLevelInputSchema>;

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

/** True for every class (ADR-025 decision 3): no class is the owner's by rule. */
export function canDelegate(decisionClass: DecisionClass): boolean {
  return DECISION_CLASSES.includes(decisionClass);
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

/** A project's stored cell of one class, or null when there is none (it reads as `owner`). */
export function cellOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): AutonomyCell | null {
  const cells = cellsOf(policy, workspaceId);
  return (hasOwn(cells, decisionClass) ? cells[decisionClass] : undefined) ?? null;
}

/** Who decides this class in this project; an absent cell is `owner` (REQ-121 b). */
export function modeOf(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): AutonomyMode {
  return cellOf(policy, workspaceId, decisionClass)?.mode ?? "owner";
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

/**
 * The level a project's cells and prediction switch read as (ADR-025 decision
 * 2): 0 when no class is `delegate` and the switch is off; n of 1–4 when the
 * switch is on and exactly level n's classes are `delegate` (every other class
 * `owner` or `shadow`); `custom` otherwise. Pure.
 */
export function levelOf(policy: AutonomyPolicy, workspaceId: string): AutonomyLevelReading {
  const delegated = DECISION_CLASSES.filter((decisionClass) => modeOf(policy, workspaceId, decisionClass) === "delegate");
  const challenger = challengerOf(policy, workspaceId);
  if (!challenger) return delegated.length === 0 ? 0 : "custom";
  const match = LEVELS.find(
    (definition) => definition.level >= 1 && definition.delegated.length === delegated.length && delegated.every((decisionClass) => definition.delegated.includes(decisionClass)),
  );
  return match?.level ?? "custom";
}

/** Every project the policy names (its cells, its prediction switch or its boundary), each with its level. */
export function levelsOf(policy: AutonomyPolicy): Record<string, AutonomyLevelReading> {
  const projects = new Set([...Object.keys(policy.projects), ...Object.keys(policy.challenger), ...Object.keys(policy.boundary ?? {})]);
  return Object.fromEntries([...projects].filter(isPolicyWorkspaceId).map((workspaceId) => [workspaceId, levelOf(policy, workspaceId)]));
}

/**
 * Why the Orchestrator challenger may not predict `decision` now (§B.3, §B.9;
 * change-007 C1), or null when it may: a decision it did not ask — a Worker's
 * question (`q:`) or a fallback incident (`f:`) —, still `open`, of any class
 * in an `owner` or `shadow` cell of a project whose challenger is on (a level
 * of 1 or more), opened with its predictions recorded, and not predicted by
 * the Orchestrator yet. The owner sees the prediction as its proposal. The rest of the project's policy does not matter: a
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

/**
 * Whether choosing `option` acts on its request as done (design §C.6,
 * change-008 C4): it declares `commit`, or it carries a prepared command that
 * approves `commit` or has the intent `release`. Pure.
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
 * (`actsOnFinish`) is left to the owner: the Orchestrator's `bm_decide`
 * (`decideRefusalOf`). A precedent's answer and the owner's own are not
 * asked. Pure.
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
 * is `delegate` in its project — any class (ADR-025). An `owner` or `shadow`
 * cell stays the owner's. Pure: the event bus asks by it (`decision.opened`,
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
  if (modeOf(policy, decision.workspaceId, decisionClass) !== "delegate") {
    return `${decisionClass} is not delegated to you in project ${decision.workspaceId}; the owner decides it, so leave it to the owner`;
  }
  if (choice === undefined) return null;
  return reviewGrantRefusalOf(decision, choice.optionKey) ?? unverifiedFinishRefusalOf(decision, choice.optionKey, choice.finishedUnverified);
}

/**
 * Why the owner's policy may not choose `optionKey` of a `review-budget`
 * question (design §16.8), or null when it may: an option granting more than
 * `{ calls: MAX_POLICY_REVIEW_GRANT_CALLS }`, or `{ untilClean }`, is the
 * owner's — the question then waits for them. Pure.
 */
export function reviewGrantRefusalOf(decision: Pick<Decision, "id" | "subject" | "options">, optionKey: string): string | null {
  if (decision.subject !== REVIEW_BUDGET_SUBJECT) return null;
  const option = decision.options.find((entry) => entry.key === optionKey);
  if (option === undefined || policyMayGrant(option.grant)) return null;
  return `option ${optionKey} of ${decision.id} grants more review calls than the owner's policy may (at most { calls: ${MAX_POLICY_REVIEW_GRANT_CALLS} }, never untilClean); choose a smaller grant or none, or leave decision ${decision.id} to the owner`;
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
 * an unknown class or an unknown mode is skipped alone (it reads as `owner`)
 * and costs no other; a `delegate` cell's stored `predictor` (older builds) is
 * not read, so either reads as the Orchestrator's. A challenger entry that is
 * not a boolean is skipped the same way. Unknown keys — `demotions` of an
 * older build among them — are ignored, and dropped by the next write. The
 * `version` is the caller's to check.
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
      cells.push([decisionClass.data, cell.data]);
    }
    if (cells.length > 0) projects.push([workspaceId, Object.fromEntries(cells) as AutonomyCells]);
  }
  const challenger = Object.entries(objectOf(file?.["challenger"]) ?? {}).filter(
    (entry): entry is [string, boolean] => isPolicyWorkspaceId(entry[0]) && typeof entry[1] === "boolean",
  );
  // The action boundary (§D.2, change-010 C2): each entry on its own; one that is not `{ enabled: true, at }` reads as off.
  const boundary = Object.entries(objectOf(file?.["boundary"]) ?? {}).flatMap(([workspaceId, raw]): Array<[string, BoundaryEntry]> => {
    const entry = boundaryEntrySchema.safeParse(raw);
    return isPolicyWorkspaceId(workspaceId) && entry.success && !Number.isNaN(Date.parse(entry.data.at)) ? [[workspaceId, { enabled: true, at: entry.data.at }]] : [];
  });
  return {
    projects: Object.fromEntries(projects),
    challenger: Object.fromEntries(challenger),
    ...(boundary.length === 0 ? {} : { boundary: Object.fromEntries(boundary) }),
  };
}

/** The policy of one project only (`autonomy.policy { workspaceId }`). */
export function policyOfProject(policy: AutonomyPolicy, workspaceId: string): AutonomyPolicy {
  return {
    projects: hasOwn(policy.projects, workspaceId) ? { [workspaceId]: cellsOf(policy, workspaceId) } : {},
    challenger: hasOwn(policy.challenger, workspaceId) ? { [workspaceId]: policy.challenger[workspaceId]! } : {},
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
 * `policy` with one project at `level` (ADR-025 decision 2), set at `at`: the
 * level's classes `delegate`, every other class `shadow` (levels 1–4) or
 * `owner` (level 0), all nine written, and the prediction switch on for
 * levels 1–4, off for 0. Other projects and the action boundary stay as they are.
 */
export function withLevel(policy: AutonomyPolicy, workspaceId: string, level: AutonomyLevel, at: string): AutonomyPolicy {
  const definition = LEVELS[level]!;
  const other: AutonomyMode = level === 0 ? "owner" : "shadow";
  const cells = Object.fromEntries(
    DECISION_CLASSES.map((decisionClass): [DecisionClass, AutonomyCell] => [decisionClass, { mode: definition.delegated.includes(decisionClass) ? "delegate" : other, at }]),
  ) as AutonomyCells;
  return withChallenger({ ...policy, projects: { ...policy.projects, [workspaceId]: cells } }, workspaceId, level >= 1);
}

/**
 * `policy` with every class of one project back to `owner` (REQ-121 d): its
 * cells removed, since an absent cell reads as `owner`. The challenger is not
 * a class and stays as it is.
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
  code: "E_AUTONOMY_INVALID" | "E_AUTONOMY_NOT_CONFIRMED";
  detail: string;
};

/** What each field of `autonomy.set` must be, for the refusal's message. */
const SET_FIELDS: Readonly<Record<string, string>> = {
  workspaceId: "a project",
  class: "one of the nine decision classes",
  mode: "owner, shadow or delegate",
  confirmed: "true or false",
};

/**
 * `autonomy.set`'s checks, in order (§B.9), before anything is read or
 * written: an input that is not one project, one known class and one known
 * mode → `E_AUTONOMY_INVALID`; `delegate` without `confirmed: true` →
 * `E_AUTONOMY_NOT_CONFIRMED`. Any class may be delegated (ADR-025), and no
 * agreement threshold is checked (ADR-023).
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
  if (change.mode === "delegate" && change.confirmed !== true) {
    return {
      refusal: { code: "E_AUTONOMY_NOT_CONFIRMED", detail: `delegating ${change.class} needs the owner's confirmation; nothing was saved` },
    };
  }
  return { change };
}

/**
 * `autonomy.set-level`'s check (ADR-025), before anything is read or written:
 * one project and a level 0–4, else `E_AUTONOMY_INVALID`; Turbo or Full auto
 * (3, 4) without `confirmed: true` → `E_AUTONOMY_NOT_CONFIRMED`.
 */
export function checkAutonomySetLevel(input: unknown): { change: AutonomySetLevelInput } | { refusal: AutonomySetRefusal } {
  const parsed = autonomySetLevelInputSchema.safeParse(input);
  if (!parsed.success || !isPolicyWorkspaceId(parsed.data.workspaceId)) {
    const issue = parsed.success ? "workspaceId" : String(parsed.error.issues[0]?.path[0] ?? "workspaceId");
    const field = issue === "level" || issue === "confirmed" ? issue : "workspaceId";
    const got = JSON.stringify((objectOf(input) ?? {})[field] ?? null);
    const expected = field === "level" ? "a level from 0 to 4" : field === "confirmed" ? "true or false" : "a project";
    return { refusal: { code: "E_AUTONOMY_INVALID", detail: `${field} ${got} is not ${expected}; nothing was saved` } };
  }
  const { level } = parsed.data;
  if (levelNeedsConfirmation(level) && parsed.data.confirmed !== true) {
    return {
      refusal: {
        code: "E_AUTONOMY_NOT_CONFIRMED",
        detail: `${LEVELS[level]!.name} lets the Orchestrator decide ${level === 4 ? "every class, security included" : "cost, release and data"} for you and needs the owner's confirmation; nothing was saved`,
      },
    };
  }
  return { change: parsed.data };
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
