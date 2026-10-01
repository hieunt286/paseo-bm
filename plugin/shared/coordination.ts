import { z } from "zod";
import type { Tier } from "./contracts";
import type { TokenCoverage } from "./eval-metrics/tokens";

/**
 * Settings → Coordination (autonomy design §G.7, ADR-021): how the
 * Orchestrator coordinates a project's agents. Phase 2 has one setting, how
 * often it advises (`advice.everyFinished`); Phase 3 adds the compaction and
 * handoff fields to the same file (bead `7gxw.9`, change-008 C2), and the
 * review budget per tier (bead `7gxw.12`, change-008 C6), each with its own
 * member in `coordinationChangeSchema`.
 *
 * Kept in `<data folder>/coordination/settings.json`
 * (`server/coordination-store.ts`) and read and set by the owner's RPCs
 * `coordination.settings` and `coordination.set` (`server/coordination-rpc.ts`).
 * No agent tool writes them:
 * the Orchestrator can only propose a change, as a decision whose option
 * carries the change (§G.4; PRD REQ-128, REQ-136 c). The one write that is not
 * the owner's is the A-12 guard's (`server/coordination-guard.ts`, §G.3): it
 * can only switch compaction or handoff **off**, never on and never a figure.
 *
 * Also here, pure: the crossing rule the threshold event reads
 * (`compactCrossingOf`, `handoffCrossingOf`; change-008 C1, C2).
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** The file format this build reads and writes. */
export const COORDINATION_FILE_VERSION = 1;

/** A numeric setting's bounds and default. `whole`: a whole number, else any number in the bounds. */
export interface CoordinationBounds {
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly whole: boolean;
}

/**
 * `advice.everyFinished`: after this many of a project's requests have
 * finished since its last advice, the Orchestrator reviews that project's
 * figures and advises (§G.4). 0 turns advice off. The maximum is a bound, not
 * a recommendation: far above the finished requests a project sees in a
 * window, a higher value would never advise.
 */
export const ADVICE_EVERY_FINISHED = { min: 0, max: 50, default: 5 } as const;

// ── Phase 3: compaction and handoff (§G.5–§G.7) ────────────────────────────
// The defaults were derived at the Phase 3 start (bead `7gxw.1`, baseline
// report §6): each role's p75 of tokens read per turn and the request p80,
// rounded to two significant figures. The bounds are bounds, not advice: the
// lowest is about two model calls of a Claude turn, the highest far above
// anything the field has seen.

/** `compact.managerTokensPerTurn`: a Manager's Claude turn that reads this many tokens is a compaction candidate. */
export const COMPACT_MANAGER_TOKENS_PER_TURN: CoordinationBounds = { min: 50_000, max: 100_000_000, default: 390_000, whole: true };
/** `compact.workerTokensPerTurn`: the same for a Worker's Claude turn. */
export const COMPACT_WORKER_TOKENS_PER_TURN: CoordinationBounds = { min: 50_000, max: 100_000_000, default: 5_700_000, whole: true };
/** `compact.contextShare`: a turn whose context fills this share of its window is a candidate, where the provider reports it. */
export const COMPACT_CONTEXT_SHARE: CoordinationBounds = { min: 0.1, max: 0.9, default: 0.5, whole: false };
/** `compact.maxPerAgent`: compactions of one agent, at most. */
export const COMPACT_MAX_PER_AGENT: CoordinationBounds = { min: 1, max: 5, default: 2, whole: true };
/** `handoff.requestTokens`: a request whose tokens read, since it started or its last handoff, reach this is a handoff candidate. */
export const HANDOFF_REQUEST_TOKENS: CoordinationBounds = { min: 10_000_000, max: 1_000_000_000, default: 150_000_000, whole: true };
/** `handoff.maxPerRequest`: handoffs of one request, at most. */
export const HANDOFF_MAX_PER_REQUEST: CoordinationBounds = { min: 1, max: 5, default: 2, whole: true };

// ── Phase 3: the review budget per tier (§C.4, §G.7; change-008 C6) ────────
// The review calls one request may make before the Worker asks the owner for
// another: one implementation batch — a review and its re-review — at every
// tier, plus the batch a Large request reviews before it implements. Never
// below one review and its re-review (§G.8: no review traded for tokens).

/** `review.smallBudget`: the review calls of a Small request. */
export const REVIEW_SMALL_BUDGET: CoordinationBounds = { min: 2, max: 8, default: 2, whole: true };
/** `review.mediumBudget`: the review calls of a Medium request. */
export const REVIEW_MEDIUM_BUDGET: CoordinationBounds = { min: 2, max: 8, default: 2, whole: true };
/** `review.largeBudget`: the review calls of a Large request. */
export const REVIEW_LARGE_BUDGET: CoordinationBounds = { min: 2, max: 8, default: 4, whole: true };

/**
 * The providers the compaction spike passed (§G.5 Verified, bead `7gxw.8`):
 * Claude with a focus, Codex and OpenCode with a bare `/compact`. None needs
 * the fallback. `compact.enabled` switches compaction for these; any other
 * provider never compacts.
 */
export const COMPACTION_PROVIDERS = ["claude", "codex", "opencode"] as const;

/** The two mechanisms the Orchestrator may start on its own initiative, each switched on its own (ADR-021). */
export const COORDINATION_MECHANISMS = ["compact", "handoff"] as const;
export type CoordinationMechanism = (typeof COORDINATION_MECHANISMS)[number];

function boundedSchema(bounds: CoordinationBounds) {
  const number = z.number().min(bounds.min).max(bounds.max);
  return bounds.whole ? number.int() : number;
}

export const adviceEveryFinishedSchema = z
  .number()
  .int()
  .min(ADVICE_EVERY_FINISHED.min)
  .max(ADVICE_EVERY_FINISHED.max);

const compactSchema = z.object({
  enabled: z.boolean(),
  managerTokensPerTurn: boundedSchema(COMPACT_MANAGER_TOKENS_PER_TURN),
  workerTokensPerTurn: boundedSchema(COMPACT_WORKER_TOKENS_PER_TURN),
  contextShare: boundedSchema(COMPACT_CONTEXT_SHARE),
  maxPerAgent: boundedSchema(COMPACT_MAX_PER_AGENT),
});

const handoffSchema = z.object({
  enabled: z.boolean(),
  requestTokens: boundedSchema(HANDOFF_REQUEST_TOKENS),
  maxPerRequest: boundedSchema(HANDOFF_MAX_PER_REQUEST),
});

const reviewSchema = z.object({
  smallBudget: boundedSchema(REVIEW_SMALL_BUDGET),
  mediumBudget: boundedSchema(REVIEW_MEDIUM_BUDGET),
  largeBudget: boundedSchema(REVIEW_LARGE_BUDGET),
});

/**
 * What the plugin keeps beside a mechanism's switch for the A-12 guard
 * (§G.3): `countsFrom` — A-12 counts only the entries recorded from this time,
 * when the owner last turned the mechanism on (null: every entry); and
 * `switchedOff` — when the guard switched it off and on what figures (met of
 * the last `checked` entries), null while the owner's own switch holds. The
 * owner never sets these: turning the mechanism on or off sets them.
 */
export const switchGuardSchema = z.object({
  countsFrom: z.string().nullable(),
  switchedOff: z
    .object({ at: z.string(), met: z.number().int().nonnegative(), checked: z.number().int().positive() })
    .nullable(),
});
export type SwitchGuard = z.infer<typeof switchGuardSchema>;

/** Every setting, each in its bounds. */
export const coordinationSettingsSchema = z.object({
  advice: z.object({ everyFinished: adviceEveryFinishedSchema }),
  compact: compactSchema,
  handoff: handoffSchema,
  review: reviewSchema,
  guard: z.object({ compact: switchGuardSchema, handoff: switchGuardSchema }),
});
export type CoordinationSettings = z.infer<typeof coordinationSettingsSchema>;

const NO_GUARD: SwitchGuard = { countsFrom: null, switchedOff: null };

/** What a missing file, a missing setting or one out of its bounds reads as. */
export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  advice: { everyFinished: ADVICE_EVERY_FINISHED.default },
  compact: {
    enabled: true,
    managerTokensPerTurn: COMPACT_MANAGER_TOKENS_PER_TURN.default,
    workerTokensPerTurn: COMPACT_WORKER_TOKENS_PER_TURN.default,
    contextShare: COMPACT_CONTEXT_SHARE.default,
    maxPerAgent: COMPACT_MAX_PER_AGENT.default,
  },
  handoff: {
    enabled: true,
    requestTokens: HANDOFF_REQUEST_TOKENS.default,
    maxPerRequest: HANDOFF_MAX_PER_REQUEST.default,
  },
  review: {
    smallBudget: REVIEW_SMALL_BUDGET.default,
    mediumBudget: REVIEW_MEDIUM_BUDGET.default,
    largeBudget: REVIEW_LARGE_BUDGET.default,
  },
  guard: { compact: NO_GUARD, handoff: NO_GUARD },
};

/**
 * One change: a setting by its key and its new value, in bounds. This is what
 * `coordination.set` takes and what a decision's prepared change carries.
 */
export const coordinationChangeSchema = z.discriminatedUnion("key", [
  z.object({ key: z.literal("advice.everyFinished"), value: adviceEveryFinishedSchema }),
  z.object({ key: z.literal("compact.enabled"), value: z.boolean() }),
  z.object({ key: z.literal("compact.managerTokensPerTurn"), value: compactSchema.shape.managerTokensPerTurn }),
  z.object({ key: z.literal("compact.workerTokensPerTurn"), value: compactSchema.shape.workerTokensPerTurn }),
  z.object({ key: z.literal("compact.contextShare"), value: compactSchema.shape.contextShare }),
  z.object({ key: z.literal("compact.maxPerAgent"), value: compactSchema.shape.maxPerAgent }),
  z.object({ key: z.literal("handoff.enabled"), value: z.boolean() }),
  z.object({ key: z.literal("handoff.requestTokens"), value: handoffSchema.shape.requestTokens }),
  z.object({ key: z.literal("handoff.maxPerRequest"), value: handoffSchema.shape.maxPerRequest }),
  z.object({ key: z.literal("review.smallBudget"), value: reviewSchema.shape.smallBudget }),
  z.object({ key: z.literal("review.mediumBudget"), value: reviewSchema.shape.mediumBudget }),
  z.object({ key: z.literal("review.largeBudget"), value: reviewSchema.shape.largeBudget }),
]);
export type CoordinationChange = z.infer<typeof coordinationChangeSchema>;
export type CoordinationKey = CoordinationChange["key"];

/** Every setting's key, in the order Settings shows them. */
export const COORDINATION_KEYS: readonly CoordinationKey[] = [
  "advice.everyFinished",
  "compact.enabled",
  "compact.managerTokensPerTurn",
  "compact.workerTokensPerTurn",
  "compact.contextShare",
  "compact.maxPerAgent",
  "handoff.enabled",
  "handoff.requestTokens",
  "handoff.maxPerRequest",
  "review.smallBudget",
  "review.mediumBudget",
  "review.largeBudget",
];

/** The keys whose value is a number, with their bounds. */
export const COORDINATION_BOUNDS: Readonly<Record<Exclude<CoordinationKey, "compact.enabled" | "handoff.enabled">, CoordinationBounds>> = {
  "advice.everyFinished": { ...ADVICE_EVERY_FINISHED, whole: true },
  "compact.managerTokensPerTurn": COMPACT_MANAGER_TOKENS_PER_TURN,
  "compact.workerTokensPerTurn": COMPACT_WORKER_TOKENS_PER_TURN,
  "compact.contextShare": COMPACT_CONTEXT_SHARE,
  "compact.maxPerAgent": COMPACT_MAX_PER_AGENT,
  "handoff.requestTokens": HANDOFF_REQUEST_TOKENS,
  "handoff.maxPerRequest": HANDOFF_MAX_PER_REQUEST,
  "review.smallBudget": REVIEW_SMALL_BUDGET,
  "review.mediumBudget": REVIEW_MEDIUM_BUDGET,
  "review.largeBudget": REVIEW_LARGE_BUDGET,
};

function isCoordinationKey(key: unknown): key is CoordinationKey {
  return typeof key === "string" && (COORDINATION_KEYS as readonly string[]).includes(key);
}

/**
 * What a key's value must be, as one sentence without a full stop:
 * `advice.everyFinished must be a whole number from 0 (off) to 50`. Null for
 * a key that is not a setting. The refusals of `coordination.set` and of a
 * prepared change say it.
 */
export function coordinationRuleOf(key: unknown): string | null {
  if (!isCoordinationKey(key)) return null;
  if (key === "compact.enabled" || key === "handoff.enabled") return `${key} must be true (on) or false (off)`;
  const bounds = COORDINATION_BOUNDS[key];
  const kind = bounds.whole ? "a whole number" : "a number";
  return `${key} must be ${kind} from ${bounds.min}${key === "advice.everyFinished" ? " (off)" : ""} to ${bounds.max}`;
}

/** The current value of one setting. */
export function coordinationValueOf(settings: CoordinationSettings, key: CoordinationKey): number | boolean {
  const [group, field] = key.split(".") as [keyof Omit<CoordinationSettings, "guard">, string];
  return (settings[group] as Record<string, number | boolean>)[field]!;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function valueOr<T>(schema: z.ZodType<T>, value: unknown, fallback: T): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** A guard as stored: a `countsFrom` that is not a time reads as null; a `switchedOff` holds only while the mechanism is off. */
function switchGuardOf(raw: unknown, enabled: boolean): SwitchGuard {
  const body = objectOf(raw);
  const countsFrom = body?.["countsFrom"];
  const switchedOff = switchGuardSchema.shape.switchedOff.safeParse(body?.["switchedOff"]);
  return {
    countsFrom: typeof countsFrom === "string" && Number.isFinite(Date.parse(countsFrom)) ? countsFrom : null,
    switchedOff: !enabled && switchedOff.success ? switchedOff.data : null,
  };
}

/**
 * The settings a parsed file body holds. Each setting is read on its own: one
 * that is missing or out of its bounds reads as its default and costs no
 * other; unknown keys are ignored. The `version` is the caller's to check.
 */
export function coordinationSettingsOf(body: unknown): CoordinationSettings {
  const root = objectOf(body);
  const defaults = DEFAULT_COORDINATION_SETTINGS;
  const advice = objectOf(root?.["advice"]);
  const compact = objectOf(root?.["compact"]);
  const handoff = objectOf(root?.["handoff"]);
  const review = objectOf(root?.["review"]);
  const guard = objectOf(root?.["guard"]);
  const shape = { compact: compactSchema.shape, handoff: handoffSchema.shape, review: reviewSchema.shape };
  const compactEnabled = valueOr(shape.compact.enabled, compact?.["enabled"], defaults.compact.enabled);
  const handoffEnabled = valueOr(shape.handoff.enabled, handoff?.["enabled"], defaults.handoff.enabled);
  return {
    advice: { everyFinished: valueOr(adviceEveryFinishedSchema, advice?.["everyFinished"], defaults.advice.everyFinished) },
    compact: {
      enabled: compactEnabled,
      managerTokensPerTurn: valueOr(shape.compact.managerTokensPerTurn, compact?.["managerTokensPerTurn"], defaults.compact.managerTokensPerTurn),
      workerTokensPerTurn: valueOr(shape.compact.workerTokensPerTurn, compact?.["workerTokensPerTurn"], defaults.compact.workerTokensPerTurn),
      contextShare: valueOr(shape.compact.contextShare, compact?.["contextShare"], defaults.compact.contextShare),
      maxPerAgent: valueOr(shape.compact.maxPerAgent, compact?.["maxPerAgent"], defaults.compact.maxPerAgent),
    },
    handoff: {
      enabled: handoffEnabled,
      requestTokens: valueOr(shape.handoff.requestTokens, handoff?.["requestTokens"], defaults.handoff.requestTokens),
      maxPerRequest: valueOr(shape.handoff.maxPerRequest, handoff?.["maxPerRequest"], defaults.handoff.maxPerRequest),
    },
    review: {
      smallBudget: valueOr(shape.review.smallBudget, review?.["smallBudget"], defaults.review.smallBudget),
      mediumBudget: valueOr(shape.review.mediumBudget, review?.["mediumBudget"], defaults.review.mediumBudget),
      largeBudget: valueOr(shape.review.largeBudget, review?.["largeBudget"], defaults.review.largeBudget),
    },
    guard: { compact: switchGuardOf(guard?.["compact"], compactEnabled), handoff: switchGuardOf(guard?.["handoff"], handoffEnabled) },
  };
}

/**
 * The owner's switch of a mechanism: it ends the guard's switch-off, and
 * turning it on from off makes A-12 count afresh from `at`.
 */
function ownerSwitch(settings: CoordinationSettings, mechanism: CoordinationMechanism, enabled: boolean, at: string): CoordinationSettings {
  const was = settings[mechanism].enabled;
  const guard = settings.guard[mechanism];
  return {
    ...settings,
    [mechanism]: { ...settings[mechanism], enabled },
    guard: { ...settings.guard, [mechanism]: { countsFrom: enabled && !was ? at : guard.countsFrom, switchedOff: enabled === was ? guard.switchedOff : null } },
  };
}

/** `settings` with one change of the owner's applied at `at` (an ISO time); the change is already valid. */
export function applyCoordinationChange(settings: CoordinationSettings, change: CoordinationChange, at: string): CoordinationSettings {
  switch (change.key) {
    case "advice.everyFinished":
      return { ...settings, advice: { ...settings.advice, everyFinished: change.value } };
    case "compact.enabled":
      return ownerSwitch(settings, "compact", change.value, at);
    case "handoff.enabled":
      return ownerSwitch(settings, "handoff", change.value, at);
    case "compact.managerTokensPerTurn":
      return { ...settings, compact: { ...settings.compact, managerTokensPerTurn: change.value } };
    case "compact.workerTokensPerTurn":
      return { ...settings, compact: { ...settings.compact, workerTokensPerTurn: change.value } };
    case "compact.contextShare":
      return { ...settings, compact: { ...settings.compact, contextShare: change.value } };
    case "compact.maxPerAgent":
      return { ...settings, compact: { ...settings.compact, maxPerAgent: change.value } };
    case "handoff.requestTokens":
      return { ...settings, handoff: { ...settings.handoff, requestTokens: change.value } };
    case "handoff.maxPerRequest":
      return { ...settings, handoff: { ...settings.handoff, maxPerRequest: change.value } };
    case "review.smallBudget":
      return { ...settings, review: { ...settings.review, smallBudget: change.value } };
    case "review.mediumBudget":
      return { ...settings, review: { ...settings.review, mediumBudget: change.value } };
    case "review.largeBudget":
      return { ...settings, review: { ...settings.review, largeBudget: change.value } };
  }
}

/**
 * The A-12 guard's switch-off (§G.3): the mechanism off, with when and on
 * what figures. It never turns anything on and changes no figure; an already
 * off mechanism is returned as it is.
 */
export function switchOffCoordination(
  settings: CoordinationSettings,
  mechanism: CoordinationMechanism,
  figures: { met: number; checked: number },
  at: string,
): CoordinationSettings {
  if (!settings[mechanism].enabled) return settings;
  return {
    ...settings,
    [mechanism]: { ...settings[mechanism], enabled: false },
    guard: { ...settings.guard, [mechanism]: { ...settings.guard[mechanism], switchedOff: { at, met: figures.met, checked: figures.checked } } },
  };
}

/** The review calls one request may make, per tier (§G.7). */
export type ReviewBudget = Readonly<Record<Tier, number>>;

/** Each tier's review-budget setting, in the order Settings shows them. */
export const REVIEW_BUDGET_KEYS: Readonly<Record<Tier, "review.smallBudget" | "review.mediumBudget" | "review.largeBudget">> = {
  Small: "review.smallBudget",
  Medium: "review.mediumBudget",
  Large: "review.largeBudget",
};

/** The review budget the owner's settings hold: what the budget notice, the stall pass and a new Worker read. */
export function reviewBudgetOf(settings: Pick<CoordinationSettings, "review">): ReviewBudget {
  return { Small: settings.review.smallBudget, Medium: settings.review.mediumBudget, Large: settings.review.largeBudget };
}

/** Whether the owner's settings let an agent on `provider` (a base provider id: claude, codex, opencode) be compacted. */
export function compactionOnFor(settings: Pick<CoordinationSettings, "compact">, provider: string | null): boolean {
  return settings.compact.enabled && provider !== null && (COMPACTION_PROVIDERS as readonly string[]).includes(provider);
}

// ── The crossing rule (change-008 C1, C2) ───────────────────────────────────

/** The roles a threshold is judged for: a Reviewer is short-lived, the Orchestrator replaces itself. */
export type CoordinationRole = "manager" | "worker";

/** Which figure crossed (the `figure` of a `threshold.crossed` event). */
export const THRESHOLD_FIGURES = ["tokensPerTurn", "contextShare", "requestTokens"] as const;
export type ThresholdFigure = (typeof THRESHOLD_FIGURES)[number];

export interface ThresholdCrossing {
  figure: ThresholdFigure;
  value: number;
  threshold: number;
}

/**
 * What a turn is judged by, as `turnTokensOf` (`eval-metrics/tokens.ts`)
 * reads it: what its counts cover, its tokens read, and its context's share
 * of the window (null where the provider does not report both).
 */
export interface TurnFigures {
  coverage: TokenCoverage;
  tokensRead: number | null;
  contextShare: number | null;
}

/**
 * Whether a Manager's or a Worker's turn crosses its compaction threshold
 * (§G.7, change-008 C2), and on which figure. Its tokens read are compared
 * with its role's `compact.*TokensPerTurn` only when its provider's counts
 * cover the whole turn (Claude, `TOKEN_COVERAGE` `turn`): a Codex or OpenCode
 * turn reports its last call only, which the p75 of turn sums would never
 * reach, so such a turn is judged by `compact.contextShare` alone. Either
 * figure crossing counts; reaching a threshold is crossing it. Tokens first
 * when both cross. Pure.
 */
export function compactCrossingOf(role: CoordinationRole, turn: TurnFigures, settings: Pick<CoordinationSettings, "compact">): ThresholdCrossing | null {
  if (turn.coverage === "turn" && turn.tokensRead !== null) {
    const threshold = role === "manager" ? settings.compact.managerTokensPerTurn : settings.compact.workerTokensPerTurn;
    if (turn.tokensRead >= threshold) return { figure: "tokensPerTurn", value: turn.tokensRead, threshold };
  }
  const share = settings.compact.contextShare;
  if (turn.contextShare !== null && Number.isFinite(turn.contextShare) && turn.contextShare >= share) {
    return { figure: "contextShare", value: turn.contextShare, threshold: share };
  }
  return null;
}

/**
 * Whether a request crosses its handoff threshold: its tokens read since it
 * started, or since its last handoff, reach `handoff.requestTokens` (§G.7).
 * Pure.
 */
export function handoffCrossingOf(requestTokensRead: number | null, settings: Pick<CoordinationSettings, "handoff">): ThresholdCrossing | null {
  const threshold = settings.handoff.requestTokens;
  return requestTokensRead !== null && requestTokensRead >= threshold ? { figure: "requestTokens", value: requestTokensRead, threshold } : null;
}
