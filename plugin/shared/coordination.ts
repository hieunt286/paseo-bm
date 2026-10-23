import { z } from "zod";
import type { TokenCoverage } from "./eval-metrics/tokens";

/**
 * Settings → Coordination (autonomy design §G.7, ADR-021): how the
 * Orchestrator coordinates a project's agents. Phase 2 has one setting, how
 * often it advises (`advice.everyFinished`); Phase 3 adds the compaction and
 * handoff fields to the same file (bead `7gxw.9`, change-008 C2), and the
 * review settings (delivery line design §5.6: `review.maxRereviews` and
 * `review.callsPerBatch`, which replaced the review budget per tier), each
 * with its own member in `coordinationChangeSchema`; Missions Phase 2 adds
 * the governor's thresholds, `governor.*` (missions design §9.2, §9.3).
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
 * `advice.everyFinished`: after this many of a project's requests had
 * finished since its last advice, the Orchestrator reviewed that project's
 * figures and advised (§G.4). 0 turned advice off. Retired (ADR-029 decision
 * 9; the governor's `mission.review` is the periodic review): still stored,
 * read and accepted by `coordination.set` with these bounds, so no file or
 * caller breaks, but nothing reads it and Settings no longer shows it.
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
/**
 * A Main's context (mission runtime design §3.2): compacted in place when its
 * real context — the turn's `contextUsed` — fills `main.contextShare` of its
 * window, or, with no window reported, reaches `main.contextTokens`; a new Main
 * only when it stays at `main.hardShare` after a compaction (§3.5).
 */
export const MAIN_CONTEXT_SHARE: CoordinationBounds = { min: 0.3, max: 0.9, default: 0.6, whole: false };
export const MAIN_CONTEXT_TOKENS: CoordinationBounds = { min: 50_000, max: 2_000_000, default: 150_000, whole: true };
export const MAIN_HARD_SHARE: CoordinationBounds = { min: 0.35, max: 0.95, default: 0.85, whole: false };

// ── The review settings (delivery line design §5.2, §5.3, §5.6) ────────────
// Two figures replace the review budget per tier: how many re-reviews a batch
// may have while it converges, and what each milestone batch adds to the
// request's cap (`reviewCapOf`, `shared/orchestrator-rules.ts`). The old
// `review.smallBudget`, `review.mediumBudget` and `review.largeBudget` are
// ignored on read, dropped by the next write and refused by
// `coordination.set` (`RETIRED_COORDINATION_KEYS`); `version` stays 1.

/**
 * `review.maxRereviews`: the re-reviews one batch may have while its blocking
 * findings fall (delivery line design §5.2). At the field rates K = 3 leaves
 * 2.6 % of batches unconverged by chance.
 */
export const REVIEW_MAX_REREVIEWS: CoordinationBounds = { min: 1, max: 6, default: 3, whole: true };
/**
 * `review.callsPerBatch`: the review calls one milestone batch is paid for in
 * the request's cap (delivery line design §5.3: `reviewCapOf`). The default is
 * the p92 calls of one batch at the field rates.
 */
export const REVIEW_CALLS_PER_BATCH: CoordinationBounds = { min: 2, max: 6, default: 3, whole: true };

// ── Size rollover (delivery line design §2.6) ───────────────────────────────
// A request rolls over to a continuation at these figures; the defaults come
// from the field's first `finished` (2026-10-15 → 20). `rollover.enabled` is
// the owner's switch; at `ceilingFactor` × a figure the notice is `now`.

/** `rollover.beads`: beads closed in the request. */
export const ROLLOVER_BEADS: CoordinationBounds = { min: 3, max: 100, default: 15, whole: true };
/** `rollover.turns`: the request's recorded Worker turns. */
export const ROLLOVER_TURNS: CoordinationBounds = { min: 10, max: 500, default: 40, whole: true };
/** `rollover.tokens`: the request's tokens read. */
export const ROLLOVER_TOKENS: CoordinationBounds = { min: 10_000_000, max: 1_000_000_000, default: 50_000_000, whole: true };
/**
 * `rollover.contextTokens` (ADR-036, delivery line design §17.3): the Worker's
 * real context at a recorded turn's end — that turn's own `contextUsed`, never
 * a sum over turns.
 */
export const ROLLOVER_CONTEXT_TOKENS: CoordinationBounds = { min: 100_000, max: 900_000, default: 250_000, whole: true };
/** `rollover.ceilingFactor`: where the soft rollover becomes `now`. */
export const ROLLOVER_CEILING_FACTOR: CoordinationBounds = { min: 1.5, max: 5, default: 2, whole: false };

// ── The maintenance ceiling (delivery line design §6.6) ─────────────────────

/**
 * `maintenance.ceilingFactor`: a pending compaction or handoff whose figure
 * reaches this × its threshold runs at the next turn end without the
 * safe-point and quiet-queue checks (`atMaintenanceCeiling`).
 */
export const MAINTENANCE_CEILING_FACTOR: CoordinationBounds = { min: 1.5, max: 5, default: 2, whole: false };

// ── CI (ADR-036, delivery line design §17.1) ────────────────────────────────

/**
 * `integration.ci`: `off` (the default) — a pipeline is never evidence nor
 * shown, the report's `ci` is ignored, the governor has no `ciRed`, and
 * verified is a check paseo-bm detected; `on` — ADR-035 decision 3's reading
 * of CI (delivery line design §4.5, §4.6).
 */
export const INTEGRATION_CI_MODES = ["off", "on"] as const;
export type IntegrationCi = (typeof INTEGRATION_CI_MODES)[number];

/** Whether the owner's settings read CI (`integration.ci` on); off for settings without it. */
export function ciUsed(settings: { integration?: { ci: IntegrationCi } } | null | undefined): boolean {
  return settings?.integration?.ci === "on";
}

// ── Missions Phase 2: the governor's thresholds (missions design §9.2, §9.3) ──
// The defaults are the design's table. Each figure crosses at its threshold
// as `governorFiguresOf` (`server/governor-figures.ts`) compares it: "2
// Workers on one file" and "1 dropped delivery" are reached (≥), "> 3" and
// "> 15" are passed (>). The bounds are bounds, not advice.

/**
 * The governor's settings, `governor.<name>`: each figure's threshold, the
 * age of a card that counts as stuck, the budget share that crosses, and the
 * window after a nudge before a re-plan is due (30 minutes and 5 more Main
 * turns).
 */
export const GOVERNOR_BOUNDS = {
  /** mess: live Workers of one mission writing one file in 24 hours, reached. */
  writersPerFile: { min: 2, max: 10, default: 2, whole: true },
  /** mess: live Workers of one mission in one repo, passed (or above `charter.budget.workers`). */
  workersPerRepo: { min: 1, max: 20, default: 3, whole: true },
  /** mess: re-asks of one question subject in a request, reached. */
  reAsks: { min: 1, max: 10, default: 2, whole: true },
  /** mess: dropped deliveries of the mission in 24 hours, reached. */
  dropped: { min: 1, max: 50, default: 1, whole: true },
  /** overengineering: process documents written per done criterion, passed. */
  processDocsPerCriterion: { min: 1, max: 50, default: 3, whole: true },
  /** overengineering: beads created per finished request, passed. */
  beadsPerRequest: { min: 1, max: 200, default: 15, whole: true },
  /** overengineering: requests whose tier was raised after `received`, reached. */
  tierRaised: { min: 1, max: 50, default: 2, whole: true },
  /** overengineering: requests with their review budget exhausted, reached. */
  reviewExhausted: { min: 1, max: 50, default: 2, whole: true },
  /** overengineering: open owner approvals of the mission, passed. */
  openApprovals: { min: 1, max: 100, default: 8, whole: true },
  /** drift: the Main's turns since a done criterion last changed state, passed. */
  mainTurnsSinceCriterion: { min: 5, max: 1_000, default: 40, whole: true },
  /** drift: finished requests since a done criterion last changed state, passed. */
  finishedSinceCriterion: { min: 1, max: 100, default: 6, whole: true },
  /** drift: requests or links in repos outside the charter, reached. */
  outsideCharter: { min: 1, max: 50, default: 1, whole: true },
  /** stuck: an open card older than this many hours counts. */
  cardAgeHours: { min: 1, max: 168, default: 24, whole: true },
  // The line's figures (delivery line design §4.9).
  /** mess: hours a mission's worktree stayed dirty with no live Worker after its last finished request, reached. */
  uncommittedHours: { min: 1, max: 168, default: 4, whole: true },
  /** stuck: hours a mission branch stayed ahead of its integration branch with no merge request, reached. */
  unpushedHours: { min: 1, max: 720, default: 24, whole: true },
  /** stuck: minutes a merge request's CI stayed red, reached. */
  ciRedMinutes: { min: 5, max: 1_440, default: 30, whole: true },
  /** drift: commits a mission branch is behind its integration branch, reached. */
  behindCommits: { min: 5, max: 1_000, default: 50, whole: true },
  /** budget: the share of a `charter.budget` field used, in percent, reached. */
  budgetPercent: { min: 50, max: 200, default: 100, whole: true },
  /** The ladder (§9.3): minutes after a nudge before a re-plan is due … */
  windowMinutes: { min: 5, max: 1_440, default: 30, whole: true },
  /** … and the Main's turns after it, both. */
  windowTurns: { min: 1, max: 100, default: 5, whole: true },
  // The command pools, per mission in 24 hours (delivery line design §8.1): no kind spends another's.
  /** Code nudges (the ladder's step 2). */
  quotaCodeNudge: { min: 1, max: 50, default: 6, whole: true },
  /** Re-plans (`bm_govern` step `replan`). */
  quotaReplan: { min: 1, max: 20, default: 3, whole: true },
  /** Arbitrations, charged to each mission told. */
  quotaArbitrate: { min: 1, max: 20, default: 4, whole: true },
  /** Every other governor command (model nudges, and entries stored before the pools). */
  quotaOther: { min: 1, max: 20, default: 4, whole: true },
} as const satisfies Record<string, CoordinationBounds>;
export type GovernorSetting = keyof typeof GOVERNOR_BOUNDS;
/** Every governor setting, in the order of the design's table. */
export const GOVERNOR_SETTINGS = Object.keys(GOVERNOR_BOUNDS) as GovernorSetting[];
export type GovernorKey = `governor.${GovernorSetting}`;
export type GovernorSettings = Readonly<Record<GovernorSetting, number>>;

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

const mainSchema = z.object({
  compact: z.boolean(),
  contextShare: boundedSchema(MAIN_CONTEXT_SHARE),
  contextTokens: boundedSchema(MAIN_CONTEXT_TOKENS),
  hardShare: boundedSchema(MAIN_HARD_SHARE),
});

const reviewSchema = z.object({
  maxRereviews: boundedSchema(REVIEW_MAX_REREVIEWS),
  callsPerBatch: boundedSchema(REVIEW_CALLS_PER_BATCH),
});

const rolloverSchema = z.object({
  enabled: z.boolean(),
  beads: boundedSchema(ROLLOVER_BEADS),
  turns: boundedSchema(ROLLOVER_TURNS),
  tokens: boundedSchema(ROLLOVER_TOKENS),
  contextTokens: boundedSchema(ROLLOVER_CONTEXT_TOKENS),
  ceilingFactor: boundedSchema(ROLLOVER_CEILING_FACTOR),
});

const maintenanceSchema = z.object({
  ceilingFactor: boundedSchema(MAINTENANCE_CEILING_FACTOR),
});

const integrationSchema = z.object({ ci: z.enum(INTEGRATION_CI_MODES) });

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

const governorSchema = z.object(
  Object.fromEntries(GOVERNOR_SETTINGS.map((name) => [name, boundedSchema(GOVERNOR_BOUNDS[name])])) as Record<GovernorSetting, z.ZodNumber>,
);

/** Every setting, each in its bounds. */
export const coordinationSettingsSchema = z.object({
  advice: z.object({ everyFinished: adviceEveryFinishedSchema }),
  compact: compactSchema,
  handoff: handoffSchema,
  main: mainSchema,
  review: reviewSchema,
  rollover: rolloverSchema,
  maintenance: maintenanceSchema,
  integration: integrationSchema,
  governor: governorSchema,
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
  main: { compact: true, contextShare: MAIN_CONTEXT_SHARE.default, contextTokens: MAIN_CONTEXT_TOKENS.default, hardShare: MAIN_HARD_SHARE.default },
  review: {
    maxRereviews: REVIEW_MAX_REREVIEWS.default,
    callsPerBatch: REVIEW_CALLS_PER_BATCH.default,
  },
  rollover: { enabled: true, beads: ROLLOVER_BEADS.default, turns: ROLLOVER_TURNS.default, tokens: ROLLOVER_TOKENS.default, contextTokens: ROLLOVER_CONTEXT_TOKENS.default, ceilingFactor: ROLLOVER_CEILING_FACTOR.default },
  maintenance: { ceilingFactor: MAINTENANCE_CEILING_FACTOR.default },
  integration: { ci: "off" },
  governor: Object.fromEntries(GOVERNOR_SETTINGS.map((name) => [name, GOVERNOR_BOUNDS[name].default])) as Record<GovernorSetting, number>,
  guard: { compact: NO_GUARD, handoff: NO_GUARD },
};

/**
 * The settings this build no longer has (delivery line design §5.6): a stored
 * file's values for them are ignored and dropped by the next write,
 * `coordination.set` refuses them, and a stored prepared change on one applies
 * nothing ("this setting no longer exists").
 */
export const RETIRED_COORDINATION_KEYS = ["review.smallBudget", "review.mediumBudget", "review.largeBudget"] as const;
export type RetiredCoordinationKey = (typeof RETIRED_COORDINATION_KEYS)[number];

/** True when `key` names a setting this build no longer has. */
export function isRetiredCoordinationKey(key: unknown): key is RetiredCoordinationKey {
  return typeof key === "string" && (RETIRED_COORDINATION_KEYS as readonly string[]).includes(key);
}

const liveChangeMembers = [
  z.object({ key: z.literal("advice.everyFinished"), value: adviceEveryFinishedSchema }),
  z.object({ key: z.literal("compact.enabled"), value: z.boolean() }),
  z.object({ key: z.literal("compact.managerTokensPerTurn"), value: compactSchema.shape.managerTokensPerTurn }),
  z.object({ key: z.literal("compact.workerTokensPerTurn"), value: compactSchema.shape.workerTokensPerTurn }),
  z.object({ key: z.literal("compact.contextShare"), value: compactSchema.shape.contextShare }),
  z.object({ key: z.literal("compact.maxPerAgent"), value: compactSchema.shape.maxPerAgent }),
  z.object({ key: z.literal("handoff.enabled"), value: z.boolean() }),
  z.object({ key: z.literal("handoff.requestTokens"), value: handoffSchema.shape.requestTokens }),
  z.object({ key: z.literal("handoff.maxPerRequest"), value: handoffSchema.shape.maxPerRequest }),
  z.object({ key: z.literal("main.compact"), value: z.boolean() }),
  z.object({ key: z.literal("main.contextShare"), value: mainSchema.shape.contextShare }),
  z.object({ key: z.literal("main.contextTokens"), value: mainSchema.shape.contextTokens }),
  z.object({ key: z.literal("main.hardShare"), value: mainSchema.shape.hardShare }),
  z.object({ key: z.literal("review.maxRereviews"), value: reviewSchema.shape.maxRereviews }),
  z.object({ key: z.literal("review.callsPerBatch"), value: reviewSchema.shape.callsPerBatch }),
  z.object({ key: z.literal("rollover.enabled"), value: z.boolean() }),
  z.object({ key: z.literal("rollover.beads"), value: rolloverSchema.shape.beads }),
  z.object({ key: z.literal("rollover.turns"), value: rolloverSchema.shape.turns }),
  z.object({ key: z.literal("rollover.tokens"), value: rolloverSchema.shape.tokens }),
  z.object({ key: z.literal("rollover.contextTokens"), value: rolloverSchema.shape.contextTokens }),
  z.object({ key: z.literal("rollover.ceilingFactor"), value: rolloverSchema.shape.ceilingFactor }),
  z.object({ key: z.literal("maintenance.ceilingFactor"), value: maintenanceSchema.shape.ceilingFactor }),
  z.object({ key: z.literal("integration.ci"), value: integrationSchema.shape.ci }),
  ...GOVERNOR_SETTINGS.map((name) => z.object({ key: z.literal(`governor.${name}` as GovernorKey), value: boundedSchema(GOVERNOR_BOUNDS[name]) as z.ZodNumber })),
] as const;

/**
 * One change of a setting this build has: its key and its new value, in
 * bounds. This is what `coordination.set` takes, what `applyCoordinationChange`
 * applies and what `bm_ask_owner` may prepare.
 */
export const liveCoordinationChangeSchema = z.discriminatedUnion("key", [...liveChangeMembers]);
export type CoordinationChange = z.infer<typeof liveCoordinationChangeSchema>;
export type CoordinationKey = CoordinationChange["key"];

/**
 * A change as a decision's prepared change is stored (`shared/decisions.ts`)
 * and as the `coordination.set` RPC is called: a live change, or one on a
 * retired key with any number, so that a decision stored before the key was
 * retired still parses (delivery line design §5.6). Only the live ones are
 * ever applied: `coordination.set` refuses a retired key with
 * `E_COORDINATION_INVALID`, and its prepared change applies nothing.
 */
export const coordinationChangeSchema = z.discriminatedUnion("key", [
  ...liveChangeMembers,
  ...RETIRED_COORDINATION_KEYS.map((key) => z.object({ key: z.literal(key), value: z.number() })),
]);
export type StoredCoordinationChange = z.infer<typeof coordinationChangeSchema>;

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
  "main.compact",
  "main.contextShare",
  "main.contextTokens",
  "main.hardShare",
  "review.maxRereviews",
  "review.callsPerBatch",
  // Delivery line design §2.6: size rollover.
  "rollover.enabled",
  "rollover.beads",
  "rollover.turns",
  "rollover.tokens",
  "rollover.contextTokens",
  "rollover.ceilingFactor",
  // Delivery line design §6.6: the maintenance ceiling.
  "maintenance.ceilingFactor",
  // ADR-036, delivery line design §17.1: CI, off by default.
  "integration.ci",
  // Missions Phase 2: the governor's thresholds come last (missions design §9.2).
  ...GOVERNOR_SETTINGS.map((name): GovernorKey => `governor.${name}`),
];

/** The setting a `governor.<name>` key names. */
export function governorSettingOf(key: GovernorKey): GovernorSetting {
  return key.slice("governor.".length) as GovernorSetting;
}

/** The keys whose value is true (on) or false (off). */
type SwitchKey = "compact.enabled" | "handoff.enabled" | "main.compact" | "rollover.enabled";
const isSwitchKey = (key: CoordinationKey): key is SwitchKey => key === "compact.enabled" || key === "handoff.enabled" || key === "main.compact" || key === "rollover.enabled";

/** The keys whose value is one of a few words. */
type ChoiceKey = "integration.ci";

/** The keys whose value is a number, with their bounds. */
export const COORDINATION_BOUNDS: Readonly<Record<Exclude<CoordinationKey, SwitchKey | ChoiceKey>, CoordinationBounds>> = {
  "advice.everyFinished": { ...ADVICE_EVERY_FINISHED, whole: true },
  "compact.managerTokensPerTurn": COMPACT_MANAGER_TOKENS_PER_TURN,
  "compact.workerTokensPerTurn": COMPACT_WORKER_TOKENS_PER_TURN,
  "compact.contextShare": COMPACT_CONTEXT_SHARE,
  "compact.maxPerAgent": COMPACT_MAX_PER_AGENT,
  "handoff.requestTokens": HANDOFF_REQUEST_TOKENS,
  "handoff.maxPerRequest": HANDOFF_MAX_PER_REQUEST,
  "main.contextShare": MAIN_CONTEXT_SHARE,
  "main.contextTokens": MAIN_CONTEXT_TOKENS,
  "main.hardShare": MAIN_HARD_SHARE,
  "review.maxRereviews": REVIEW_MAX_REREVIEWS,
  "review.callsPerBatch": REVIEW_CALLS_PER_BATCH,
  "rollover.beads": ROLLOVER_BEADS,
  "rollover.turns": ROLLOVER_TURNS,
  "rollover.tokens": ROLLOVER_TOKENS,
  "rollover.contextTokens": ROLLOVER_CONTEXT_TOKENS,
  "rollover.ceilingFactor": ROLLOVER_CEILING_FACTOR,
  "maintenance.ceilingFactor": MAINTENANCE_CEILING_FACTOR,
  ...(Object.fromEntries(GOVERNOR_SETTINGS.map((name) => [`governor.${name}`, GOVERNOR_BOUNDS[name]])) as Record<GovernorKey, CoordinationBounds>),
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
  if (isSwitchKey(key)) return `${key} must be true (on) or false (off)`;
  if (key === "integration.ci") return `${key} must be "off" or "on"`;
  const bounds = COORDINATION_BOUNDS[key];
  const kind = bounds.whole ? "a whole number" : "a number";
  return `${key} must be ${kind} from ${bounds.min}${key === "advice.everyFinished" ? " (off)" : ""} to ${bounds.max}`;
}

/** The current value of one setting. */
export function coordinationValueOf(settings: CoordinationSettings, key: CoordinationKey): number | boolean | IntegrationCi {
  const [group, field] = key.split(".") as [keyof Omit<CoordinationSettings, "guard">, string];
  return (settings[group] as Record<string, number | boolean | IntegrationCi>)[field]!;
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
  const main = objectOf(root?.["main"]);
  const review = objectOf(root?.["review"]);
  const rollover = objectOf(root?.["rollover"]);
  const maintenance = objectOf(root?.["maintenance"]);
  const integration = objectOf(root?.["integration"]);
  const governor = objectOf(root?.["governor"]);
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
    main: {
      compact: valueOr(mainSchema.shape.compact, main?.["compact"], defaults.main.compact),
      contextShare: valueOr(mainSchema.shape.contextShare, main?.["contextShare"], defaults.main.contextShare),
      contextTokens: valueOr(mainSchema.shape.contextTokens, main?.["contextTokens"], defaults.main.contextTokens),
      hardShare: valueOr(mainSchema.shape.hardShare, main?.["hardShare"], defaults.main.hardShare),
    },
    // The retired `smallBudget`, `mediumBudget` and `largeBudget` are not read (delivery line design §5.6).
    review: {
      maxRereviews: valueOr(shape.review.maxRereviews, review?.["maxRereviews"], defaults.review.maxRereviews),
      callsPerBatch: valueOr(shape.review.callsPerBatch, review?.["callsPerBatch"], defaults.review.callsPerBatch),
    },
    // Delivery line design §2.6: absent from a file an older build wrote, so at its defaults.
    rollover: Object.fromEntries(
      (Object.keys(rolloverSchema.shape) as Array<keyof CoordinationSettings["rollover"]>).map((name) => [name, valueOr(rolloverSchema.shape[name] as z.ZodType<unknown>, rollover?.[name], defaults.rollover[name])]),
    ) as CoordinationSettings["rollover"],
    // Delivery line design §6.6: absent from a file an older build wrote, so at its default.
    maintenance: { ceilingFactor: valueOr(maintenanceSchema.shape.ceilingFactor, maintenance?.["ceilingFactor"], defaults.maintenance.ceilingFactor) },
    // ADR-036: absent from a file an older build wrote, so off.
    integration: { ci: valueOr(integrationSchema.shape.ci, integration?.["ci"], defaults.integration.ci) },
    governor: Object.fromEntries(
      GOVERNOR_SETTINGS.map((name) => [name, valueOr(governorSchema.shape[name], governor?.[name], defaults.governor[name])]),
    ) as Record<GovernorSetting, number>,
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
    case "review.maxRereviews":
      return { ...settings, review: { ...settings.review, maxRereviews: change.value } };
    case "review.callsPerBatch":
      return { ...settings, review: { ...settings.review, callsPerBatch: change.value } };
    case "main.compact":
      return { ...settings, main: { ...settings.main, compact: change.value } };
    case "rollover.enabled":
    case "rollover.beads":
    case "rollover.turns":
    case "rollover.tokens":
    case "rollover.contextTokens":
    case "rollover.ceilingFactor":
      return { ...settings, rollover: { ...settings.rollover, [change.key.slice("rollover.".length)]: change.value } };
    case "maintenance.ceilingFactor":
      return { ...settings, maintenance: { ceilingFactor: change.value } };
    case "integration.ci":
      return { ...settings, integration: { ci: change.value } };
    case "main.contextShare":
      return { ...settings, main: { ...settings.main, contextShare: change.value } };
    case "main.contextTokens":
      return { ...settings, main: { ...settings.main, contextTokens: change.value } };
    case "main.hardShare":
      return { ...settings, main: { ...settings.main, hardShare: change.value } };
    default:
      return { ...settings, governor: { ...settings.governor, [governorSettingOf(change.key)]: change.value } };
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

/** Whether the owner's settings let an agent on `provider` (a base provider id: claude, codex, opencode) be compacted. */
export function compactionOnFor(settings: Pick<CoordinationSettings, "compact">, provider: string | null): boolean {
  return settings.compact.enabled && provider !== null && (COMPACTION_PROVIDERS as readonly string[]).includes(provider);
}

// ── The crossing rule (change-008 C1, C2) ───────────────────────────────────

/** The roles a threshold is judged for: a Reviewer is short-lived, the Orchestrator replaces itself. */
export type CoordinationRole = "manager" | "worker";

/** Which figure crossed (the `figure` of a `threshold.crossed` event). */
export const THRESHOLD_FIGURES = ["tokensPerTurn", "contextShare", "requestTokens", "contextTokens"] as const;
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

/** A turn's context, as `turnTokensOf` reads it (mission runtime design §3.1): the tokens of its context and their share of the window. */
export interface MainTurnContext {
  context: { tokens: number } | null;
  contextShare: number | null;
}

/**
 * Whether a Main's turn crosses its context threshold (mission runtime design
 * §3.1, §3.2): its real context's share of the window at `main.contextShare`,
 * or, with no window reported, its context tokens at `main.contextTokens`.
 * The per-turn token sum is never a Main's figure. Pure.
 */
export function mainContextCrossingOf(turn: MainTurnContext, settings: Pick<CoordinationSettings, "main">): ThresholdCrossing | null {
  const { contextShare, contextTokens } = settings.main;
  if (turn.contextShare !== null && Number.isFinite(turn.contextShare)) {
    return turn.contextShare >= contextShare ? { figure: "contextShare", value: turn.contextShare, threshold: contextShare } : null;
  }
  if (turn.context !== null && turn.context.tokens >= contextTokens) return { figure: "contextTokens", value: turn.context.tokens, threshold: contextTokens };
  return null;
}

/**
 * Whether a Main's turn reaches the hard figure (mission runtime design §3.5):
 * `main.hardShare` of its window (never below `main.contextShare` + 0.05), or,
 * with no window, the context tokens `contextTokens / contextShare × hardShare`.
 * Pure.
 */
export function mainContextHardOf(turn: MainTurnContext, settings: Pick<CoordinationSettings, "main">): boolean {
  const hard = Math.max(settings.main.hardShare, settings.main.contextShare + 0.05);
  if (turn.contextShare !== null && Number.isFinite(turn.contextShare)) return turn.contextShare >= hard;
  return turn.context !== null && turn.context.tokens >= (settings.main.contextTokens / settings.main.contextShare) * hard;
}

/** Whether a Main on this provider is compacted in place (mission runtime design §3.3): `main.compact` and a provider that compacts. Pure. */
export function mainCompactionOnFor(settings: Pick<CoordinationSettings, "main">, provider: string | null): boolean {
  return settings.main.compact && provider !== null && (COMPACTION_PROVIDERS as readonly string[]).includes(provider);
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

/**
 * Whether a pending compaction's or handoff's figure is at the maintenance
 * ceiling (delivery line design §6.6): at least `maintenance.ceilingFactor` ×
 * its threshold. False with no crossing. Pure.
 */
export function atMaintenanceCeiling(crossing: ThresholdCrossing | null, settings: Pick<CoordinationSettings, "maintenance">): boolean {
  return crossing !== null && crossing.value >= settings.maintenance.ceilingFactor * crossing.threshold;
}
