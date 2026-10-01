/**
 * The inputs and the output of the programme's metrics (evaluation design §4):
 * what `computeEvalMetrics` reads and the metric set it returns. Re-exported
 * by `shared/eval-metrics.ts`, the module every caller imports.
 *
 * This module is `shared/`: no Node and no React Native imports.
 */
import type { TraceRecord } from "../contracts";
import type { DecisionClass, ReversalKind } from "../decisions";
import type { EffectfulAction } from "../effectful-actions";

/** The classes a held request can be of (autonomy design §B.1, §D.2). */
export type BoundaryClass = "security" | "data" | "release" | "dependency" | "environment";

/** A side of A-6's split by the action boundary (autonomy design §D.2, change-010 C9). */
export type BoundarySplit = "on" | "off" | "unknown";

/** A-6's figures on one side of the split, with that side's requests and finished requests. */
export interface A6Part {
  requests: number;
  finishedRequests: number;
  total: number;
  authorised: number;
  notShownAuthorised: number;
  held: EvalMetrics["a6"]["held"];
  estimate: EvalMetrics["a6"]["estimate"];
}
import type { InterventionKind } from "../interventions";

// ── Inputs ──────────────────────────────────────────────────────────────────

/** Inclusive bounds as ISO times; `null` leaves that side open. */
export interface EvalWindow {
  since: string | null;
  until: string | null;
}

/** One Orchestrator note (`notes/<workspaceId>.json`); only its time and project are read. */
export interface EvalNote {
  workspaceId: string;
  at: string;
}

/** One scenario run of the suite, as scoring judged it (A-9); `null` = could not be judged. */
export interface EvalScenarioOutcome {
  scenario: string;
  correct: boolean | null;
  boundaryClean: boolean | null;
}

/** What only the suite knows (design §4 "suite only" rows). Every field optional. */
export interface EvalSuiteInputs {
  /** A-3: for each decision the simulated owner settled, the messages and taps it took. */
  ownerActionsPerDecision?: readonly number[];
  /** A-8: the Orchestrator's cost over the run in USD (difference of its running total), `null` when unknown. */
  orchestratorCostUsd?: number | null;
  /** A-9: one entry per scenario run. */
  scenarioOutcomes?: readonly EvalScenarioOutcome[];
}

export interface EvalInput {
  records: readonly TraceRecord[];
  /** `orchestrator/proposals.json` → `entries`, unvalidated: each entry is checked here and a bad one counted. */
  proposals?: readonly unknown[];
  /** `orchestrator/stalls.json` → `entries`, unvalidated. */
  stalls?: Readonly<Record<string, unknown>>;
  /** The Orchestrator's notes; absent means they were not read (A-7 says so). */
  notes?: readonly EvalNote[];
  /**
   * `decisions/<workspaceId>.json` → `entries` of the workspaces read,
   * unvalidated: each is checked here and a bad one counted. The source of
   * A-1, A-2 (c) and A-6 from Phase 1 on; absent for a build before it.
   */
  decisions?: readonly unknown[];
  /** `orchestrator/wakes.json` → `entries`, unvalidated (A-7); absent means they were not read. */
  wakes?: readonly unknown[];
  /** `orchestrator/interventions.json` → `entries`, unvalidated (A-12); absent means they were not read. */
  interventions?: readonly unknown[];
  window: EvalWindow;
  /** Workspace directory by workspace id, for the `rm -rf` outside-the-workspace rule of A-6. */
  workspaceDirectories?: Readonly<Record<string, string>>;
  suite?: EvalSuiteInputs;
}

// ── Output ──────────────────────────────────────────────────────────────────

/** The roles a trace record can carry, in a fixed order. */
export const EVAL_ROLES = ["manager", "worker", "reviewer", "orchestrator", "unknown"] as const;
export type EvalRole = TraceRecord["role"];
export type RoleCounts = Record<EvalRole, number>;

/** How the questions of a set of requests were settled (A-1). */
export interface QuestionSplit {
  /** Every key `(requestId, Qn)`. */
  asked: number;
  /**
   * The owner answered its stored decision (Phase 1: in the Inbox, on a card or
   * in a chat), an owner message arrived between the question and its answer,
   * or the Orchestrator asked the owner (a decision).
   */
  reachedOwner: number;
  /** Answered with no owner message in between; a decision the Orchestrator answered (`bm_decide`) is one. */
  answeredByAgents: number;
  /**
   * Of `answeredByAgents`: the Orchestrator answered — its stored answer
   * (`bm_decide`, change-004), or an answer that came in, or after, its
   * `BM-COMMAND`. The rest are the Manager's facts.
   */
  answeredByAgentsViaCommand: number;
  /** Never answered and never put to the owner. */
  unanswered: number;
}

/** One kind of coordination intervention (A-12): the entries recorded, by outcome. */
export interface InterventionCounts {
  recorded: number;
  met: number;
  missed: number;
  unknown: number;
  pending: number;
  /** met / (met + missed); null when none is checked either way. */
  share: number | null;
}

/** A-4 for one decision class, or for all of them: the decisions answered for the owner, and those the owner overrode. */
export interface OverrideCounts {
  /** Decisions answered by the owner's policy or a precedent (`answer.by: policy | precedent`). */
  delegated: number;
  /** Of `delegated`: answered by the policy, whichever predictor its cell names. */
  byPolicy: number;
  /** Of `delegated`: answered by a precedent. */
  byPrecedent: number;
  /** Of `delegated`: overridden by the owner — an `r:` decision supersedes it, or it records the reversal `overridden`. */
  overridden: number;
  /** overridden / delegated; null with no delegated decision (unknown, never 0). */
  rate: number | null;
}

/** A-5 for one decision class, or for all of them: the answered decisions, and those reversed. */
export interface ReversalRate {
  /** The answered decisions the rate is over. */
  decisions: number;
  /** Of `decisions`: reversed at least once, in any way. */
  reversed: number;
  /** Decisions reversed each way (autonomy design §B.3), a decision once per kind. */
  byKind: Record<ReversalKind, number>;
  /** reversed / decisions; null with no decision (unknown, never 0). */
  rate: number | null;
}

/** How a set of figures spreads: how many, the median, nearest-rank percentiles and the largest; null for none. */
export interface Spread {
  count: number;
  median: number | null;
  p75: number | null;
  p80: number | null;
  p90: number | null;
  max: number | null;
}

export interface SpreadByRole {
  all: Spread;
  byRole: Record<EvalRole, Spread>;
}

/** One of the heaviest requests: ids and numbers only. */
export interface HeavyRequest {
  requestId: string;
  workspaceId: string;
  tokensRead: number;
  byRole: RoleCounts;
  /** The request's turns with usage. */
  turns: number;
  finished: boolean;
}

/**
 * Where the §G.7 default threshold would have been crossed, and what acting
 * there might have saved. **An estimate**: the saving assumes each later model
 * call would have re-read a brief-sized context instead, ignoring that the
 * context grows again.
 */
export interface CandidateRow {
  workspaceId: string;
  requestId: string | null;
  /** The agent to compact; null for a handoff (the request's Worker turns). */
  agentId: string | null;
  role: EvalRole;
  /** The crossing turn's 1-based place among the agent's (compaction) or the request's (handoff) turns, and how many there were. */
  turn: number;
  turns: number;
  /** What crossed: the turn's tokens read (compaction), the request's tokens read so far (handoff). */
  crossedAt: number;
  /** After the crossing turn: the agent's turns (compaction), the request's Worker turns (handoff), those with usage. */
  after: { turns: number; tokensRead: number; calls: number; callsExact: boolean };
  /** `after.tokensRead` − `after.calls` × the brief's tokens, at least 0. */
  savingTokens: number;
}

export interface CandidateSet {
  candidates: number;
  savingTokens: number;
  /** Most saving first. */
  rows: CandidateRow[];
}

export interface ContextCandidates {
  estimate: true;
  /** The §G.7 defaults as this scope gives them; null when there is nothing to take them from. */
  thresholds: {
    /** `compact.tokensPerTurn`: the p75 of the role's tokens read per turn (a Manager or a Worker compacts; §G.5). */
    compactTokensPerTurn: { manager: number | null; worker: number | null };
    /** `handoff.requestTokens`: the p80 of the requests' tokens read. */
    handoffRequestTokens: number | null;
    /** A brief of about `BRIEF_CHARACTERS` characters (§G.6), at `CHARACTERS_PER_TOKEN`. */
    briefTokens: number;
  };
  compaction: CandidateSet;
  handoff: CandidateSet;
}

/** The provider whose token counting a turn follows (run note 2026-09-30 §4). */
export const TOKEN_PROVIDERS = ["claude", "codex", "opencode", "unknown"] as const;
export type TokenProvider = (typeof TOKEN_PROVIDERS)[number];

/** The tiers review lift is split by: a request's last reported tier, `unknown` when it reported none. */
export const REVIEW_TIERS = ["Small", "Medium", "Large", "unknown"] as const;
export type ReviewTier = (typeof REVIEW_TIERS)[number];

/**
 * Review lift over a set of requests (autonomy design §C.4, §C.6): what the
 * reviews of the requests in the window found, what was fixed before the next
 * review, and what a review cost — the figures the review budget per tier is
 * tuned from. A review is a parsed `BM-REVIEW`; a batch is a request's reviews
 * sharing a batch id, oldest first. Missing data is counted in `unknown` and
 * left out of the figure it would change, never read as zero.
 */
export interface ReviewLiftFigures {
  /** Requests with at least one review. */
  requests: number;
  /** Their reviews, with a batch or without. */
  reviews: number;
  /** reviews ÷ requests; null with none. */
  reviewsPerRequest: number | null;
  /** Their batches: distinct (request, batch id). */
  batches: number;
  /** Blocking findings over every review of the batches whose counts are all known. */
  blockingFindings: number;
  /** blockingFindings ÷ those batches (`batches` − `unknown.batchesWithUnknownBlocking`); null with none. */
  blockingPerBatch: number | null;
  /**
   * Findings acted on (§C.6): per batch reviewed more than once, its first
   * review's blocking findings minus its last review's, at least 0. A batch
   * reviewed once is counted apart: none acted on, not unknown.
   */
  actedOn: {
    /** Batches reviewed more than once whose first and last counts are known. */
    reReviewedBatches: number;
    /** Their first reviews' blocking findings. */
    found: number;
    /** Of `found`: gone by their last review. */
    fixed: number;
    /** Batches reviewed once. */
    reviewedOnceBatches: number;
  };
  /**
   * Reviewer tokens (input + cached + output, as A-8 counts them) of the
   * requests whose Reviewer turns all have usage, attributed by the record's
   * `requestId`, over those requests' reviews.
   */
  tokens: { reviews: number; total: number; perReview: number | null };
  unknown: {
    /** In `reviews`, in no batch. */
    reviewsWithoutBatch: number;
    reviewsWithUnknownBlocking: number;
    /** Batches with a review whose blocking count is unknown: left out of `blockingPerBatch`. */
    batchesWithUnknownBlocking: number;
    /** Batches reviewed more than once whose first or last count is unknown: left out of `actedOn`. */
    reReviewedWithUnknownBlocking: number;
    /** Requests with reviews but a Reviewer turn without usage, or no Reviewer turn recorded: left out of `tokens`. */
    requestsWithoutReviewerTokens: number;
    /** Requests with Reviewer turns but no review read: in no figure. */
    requestsWithoutReview: number;
  };
}

/** Review lift over every tier, and per tier. */
export interface ReviewLiftSplit {
  all: ReviewLiftFigures;
  byTier: Record<ReviewTier, ReviewLiftFigures>;
  /** Reviewer turns in scope with no request: their reviews and tokens are in no figure. */
  reviewerTurnsWithoutRequest: number;
}

/**
 * Two agents writing one file in overlapping turns (`writers-observed`,
 * autonomy design §F.1), over the turns in scope.
 */
export interface WritersObservedFigures {
  /** Turn pairs of two agents that wrote one file in overlapping turns. */
  pairs: number;
  /** The files those pairs wrote, per workspace. */
  files: number;
  /** Pairs of two agents on one file with a turn missing its start or end: not judged, in neither figure. */
  unknownPairs: number;
}

export interface EvalMetrics {
  window: EvalWindow;
  requests: { inWindow: number; finished: number };
  a1: {
    all: QuestionSplit;
    finished: QuestionSplit;
    /** Over finished requests; `null` when none finished. */
    perFinishedRequest: { asked: number; reachedOwner: number; answeredByAgents: number } | null;
  };
  a2: { answeredTwice: number; sameTextTwoKeys: number; overlappingDecisions: number; total: number };
  /** Suite only; `null` when not supplied. */
  a3: { decisions: number; actions: number; perDecision: number | null; max: number | null } | null;
  /**
   * The owner's override rate of delegated decisions (autonomy design §B.7,
   * §B.9): over all classes, and per decision class (`decisionClassOf`), every
   * class listed. A decision counts as A-1's questions do: its request is in
   * the window, or, with no request or none recorded, it was asked in it; an
   * override counts whenever it came.
   */
  a4: OverrideCounts & { byClass: Record<DecisionClass, OverrideCounts> };
  a5: {
    /** Phase 0's lower bound over the question keys, from the records (kept as it was). */
    lowerBound: true;
    reanswered: number;
    reopenedAfterAnswer: number;
    ownerOverrides: number;
    total: number;
    /** Answered question keys: the decisions the rate is taken over. */
    answered: number;
    perAnsweredQuestion: number | null;
    /**
     * From Phase 2, the reversals each decision records (autonomy design §B.3):
     * the decisions the policy or a precedent answered, reversed in any way —
     * an override (as A-4 counts it), a re-ask or a reopen citing it. Scoped as A-4.
     */
    delegated: ReversalRate & { byClass: Record<DecisionClass, ReversalRate> };
    /**
     * A-5's reference: the owner's own answers to Worker questions (`q:`) and
     * the Orchestrator's decisions (`o:`) — the kinds whose owner answers can
     * record a reversal (re-asked, reopened). An override (`r:`) and a
     * fallback incident (`f:`) record none for an owner answer, and a decision
     * carrying a prepared change is never delegated: they are left out; so is
     * a decision stored before reversals were recorded (no `prediction`),
     * counted in `unknowns.ownerAnswersBeforeReversals`. Scoped as A-4.
     */
    owner: ReversalRate & { byClass: Record<DecisionClass, ReversalRate> };
  };
  a6: {
    total: number;
    authorised: number;
    notShownAuthorised: number;
    byAction: Record<EffectfulAction, { authorised: number; notShownAuthorised: number }>;
    /**
     * `rm -rf` in the scratch area (autonomy design §D.2: the system temp
     * roots, a `mktemp` variable of the same command): not an effectful
     * action, reported apart so the Phase 0 figure stays readable.
     */
    scratchDeletions: number;
    /**
     * The action boundary's held requests (`h:` decisions, §D.2) of the
     * requests in scope: allowed by the owner (the Inbox, or `via: paseo`),
     * allowed by the policy as they opened, denied, withdrawn, still open;
     * the owner's median wait (ms) from the hold to their answer; and the
     * held ones (all but the policy's) per finished request.
     */
    held: {
      decisions: number;
      allowed: number;
      allowedByPolicy: number;
      denied: number;
      withdrawn: number;
      open: number;
      ownerWaitMedianMs: number | null;
      perFinishedRequest: number | null;
    };
    /**
     * The field estimate before the modes switch (change-009 C9): the
     * boundary's classifier over the shell and file evidence of the Workers'
     * and Reviewers' turns in scope — the calls it would hold, after the
     * owner's grants of their request given before and the scratch rule — by
     * class, and those held only as unreadable. A package script counts as
     * unreadable here (`unreadableScripts`), since the replay reads no
     * `package.json`; the plugin reads it live.
     */
    estimate: {
      calls: number;
      held: number;
      byClass: Record<BoundaryClass, number>;
      unreadable: number;
      unreadableScripts: number;
      scratchWrites: number;
      heldPerFinishedRequest: number | null;
      unreadablePerFinishedRequest: number | null;
      unreadableButScriptsPerFinishedRequest: number | null;
    };
    /**
     * The same figures split by whether the request's Worker ran under the
     * action boundary (autonomy design §D.2, change-010 C9), from the
     * `bm.boundary` its records carry: `on`, `off`, or `unknown` when they
     * carry none (and for turns without a request). Each side counts its own
     * requests and finished requests; its ratios are per its own finished ones.
     */
    byBoundary: Record<BoundarySplit, A6Part>;
  };
  a7: {
    /**
     * False only when every wake counted is a recorded wake (`wakes.json`)
     * with its end: then "acted on" is read over the wake's own turn. A stall
     * key's wake, a wake without an end, or no wake records at all make it an
     * approximation (the 10-minute window).
     */
    approximate: boolean;
    /** False when no notes were supplied: a wake followed only by a note then reads as no action. */
    notesIncluded: boolean;
    /** False when no wake records were supplied (a build before them): only stall keys are counted. */
    wakeRecordsIncluded: boolean;
    wakes: number;
    actedOn: number;
    noAction: number;
    noActionShare: number | null;
  };
  a8: {
    finishedRequests: number;
    tokens: { total: number; byRole: RoleCounts };
    /** Means over finished requests; `null` when none finished. */
    perFinishedRequest: { total: number; byRole: RoleCounts } | null;
    medianPerFinishedRequest: number | null;
    /** Finished requests with at least one turn whose usage is unknown: their tokens are a lower bound. */
    finishedRequestsWithMissingUsage: number;
    orchestratorCostUsd: number | null;
    /**
     * The Orchestrator's own tokens (change-007 C6), from the wake records: the
     * collector records no Orchestrator turn, so they are in no figure above.
     * Each wake keeps the tokens (input + cached + output, as its provider
     * reports them) of the Orchestrator turn that closed it; a wake counts when
     * its `at` is in the window, as for A-7.
     */
    orchestrator: {
      /** False when no wake records were supplied (a build before them). */
      wakeRecordsIncluded: boolean;
      wakes: number;
      /** Of `wakes`, those whose closing turn's tokens were recorded; the rest are unknown and left out. */
      wakesWithUsage: number;
      /** Over the wakes with usage; null when none could be read (or no wake records), 0 with no wake in the window. */
      tokens: number | null;
      /** `tokens` ÷ finished requests; null when either is unknown or none finished. */
      perFinishedRequest: number | null;
    };
  };
  /** Suite only; `null` when not supplied. */
  a9: { scenarioRuns: number; correct: number; boundaryClean: number; correctAndClean: number; unknown: number } | null;
  a11: { medianMs: number | null; requests: number };
  /**
   * Coordination interventions recorded in the window, per kind (autonomy
   * design §G.3): `share` is met / (met + missed), null when none is checked
   * either way; `unknown` and `pending` are counted apart.
   */
  a12: {
    /** False when no intervention log was supplied (a build before it). */
    logIncluded: boolean;
    byKind: Record<InterventionKind, InterventionCounts>;
  };
  /**
   * Context and tokens (autonomy design §G.2 Derived): tokens read per turn,
   * per request by role and per agent, a context figure per turn, and the
   * compaction and handoff candidates the §G.7 defaults would have raised.
   * Turn figures are over the turns in scope, request figures over the
   * requests in the window (all their turns), agent figures over each agent's
   * turns in scope. A turn without usage is in none of them (`turnsWithoutUsage`).
   */
  context: {
    turns: {
      /** Turns in scope with usage. */
      withUsage: number;
      /**
       * Of those, by the provider whose counting they follow (`tokenProviderOf`,
       * from the model id). What the counts cover differs (run note 2026-09-30
       * §4): Claude's are the sum over the turn's model calls; Codex's and
       * OpenCode's are the last model call's only, and Codex's cached tokens
       * are part of its input.
       */
      byProvider: Record<TokenProvider, number>;
      /** Turns that repeated their agent's previous counts (OpenCode, a turn with no model call): read as 0 tokens and no context. */
      repeated: number;
      /** Turns in scope that recorded their tool calls; the others' model calls are a lower bound. */
      withToolCalls: number;
    };
    tokensRead: {
      total: number;
      byRole: RoleCounts;
      perTurn: SpreadByRole;
      /** Each request's tokens read, and per role each request's tokens of that role (requests where the role had a turn with usage). */
      perRequest: SpreadByRole;
      /** Each agent's tokens read over its turns in scope, by its role. */
      perAgent: SpreadByRole;
      /** The heaviest requests in the window, most tokens read first (at most `HEAVIEST_REQUESTS`). */
      heaviestRequests: HeavyRequest[];
    };
    /** The context at each turn's end (`turnTokensOf`): reported by the provider, else estimated — always labelled. */
    contextEstimate: {
      reported: number;
      estimated: number;
      /** Turns in scope with no figure: no usage, a repeated turn, or no context and no tool calls. */
      unknown: number;
      perTurn: SpreadByRole;
      /** Context ÷ the reported window, for the turns that have both (a fraction). */
      shareOfWindow: Spread;
    };
    candidates: ContextCandidates;
  };
  /**
   * Review lift (autonomy design §C.4): over the requests in the window, per
   * tier and per workspace (`byWorkspace`, keyed by workspace id in id order;
   * a workspace is listed once it has a review or a Reviewer turn in scope).
   */
  reviewLift: ReviewLiftSplit & { byWorkspace: Record<string, ReviewLiftSplit> };
  supplementary: {
    recommendedAgreement: {
      /** Answers read as an option or as own words (`other`). */
      answered: number;
      recommended: number;
      otherOption: number;
      ownWords: number;
      share: number | null;
    };
    ownerWait: { questions: number; medianMs: number | null; p90Ms: number | null };
    roundsBlocked: { rounds: number; requestsBlockedAtLeastOnce: number; perRequest: number | null };
    tierMix: { Small: number; Medium: number; Large: number; changed: number; unknown: number };
    reviews: {
      reviews: number;
      batches: number;
      perBatch: number | null;
      blockingFindings: number;
      blockingPerBatch: number | null;
    };
    reportFormat: { reports: number; withUnparsedFields: number; withIncompleteFields: number };
    /**
     * What the runtime rules retired with the workflow assessment flagged
     * (autonomy design §B.8, §B.9), over the requests in the window. A
     * request's tier is its last reported one, as the rules read it; where a
     * rule answered "unknown", the request is counted in `unknowns` instead.
     */
    process: {
      /**
       * Small requests that created beads (a report's `beadsCreated`, or a
       * `br create` that ran) or wrote a plan or an ADR (`docs/plans/`,
       * `docs/adr/`, in a report's `filesChanged` or an edit) — was
       * `process.small-heavy`.
       */
      smallHeavy: number;
      /** Finished Medium or Large requests with no Reviewer turn — was `process.no-review`. */
      unreviewed: number;
      /**
       * Workers and Reviewers whose first recorded turn ended `failed` — was
       * `agent.failed-first-turn` (an agent in error with no recorded turn
       * needs Paseo's live list, which the replay does not read).
       */
      failedFirstTurns: { worker: number; reviewer: number };
      /** Finished requests whose Worker never sent a `received` report — the rest of `report.malformed` (unreadable fields are `reportFormat`). */
      finishedWithoutReceived: number;
      /**
       * Requests whose Manager replied in another language than the user's
       * last message to it (Vietnamese or English, `guessLanguage`) — was
       * `manager.language-mismatch`.
       */
      languageMismatch: number;
    };
    cancelledTurns: { total: number; byRole: RoleCounts };
    /** Turns that ended `failed`, by role: the errors Insights shows. */
    failedTurns: { total: number; byRole: RoleCounts };
    turnsByRole: RoleCounts;
    /**
     * Requests in the window by the UTC day (`YYYY-MM-DD`) of their earliest
     * activity, oldest day first. A request with no readable time has no day,
     * so the days can add up to less than `requests.inWindow`.
     */
    requestsByDay: Record<string, number>;
    /**
     * `writers-observed` (autonomy design §F.1): collisions over the turns in
     * scope, and per workspace (keyed by id in id order; a workspace is
     * listed once it has a pair, judged or not). Paths are placed against
     * `workspaceDirectories`; without a workspace's folder they are compared
     * as written.
     */
    writersObserved: WritersObservedFigures & { byWorkspace: Record<string, WritersObservedFigures> };
  };
  unknowns: {
    recordsWithoutRequest: number;
    turnsWithoutUsage: number;
    messagesWithoutOrigin: number;
    questionsWithoutRequest: number;
    answersWithoutRequest: number;
    /** Answers to a key of a request in the window that was never seen asked. */
    answersWithoutQuestion: number;
    /** Keys whose question or first answer has no readable time: classified by the answer message alone. */
    questionsWithoutTime: number;
    /** Answers whose text is neither an option of the question nor `other` (left out of the agreement). */
    unreadableAnswers: number;
    /** Finished requests whose start or finish time is unknown (left out of A-11). */
    requestsWithoutDuration: number;
    reviewsWithoutBatch: number;
    reviewsWithUnknownBlocking: number;
    decisionsWithoutRequest: number;
    invalidProposals: number;
    /** Stored decisions that did not validate. */
    invalidDecisions: number;
    invalidStallEntries: number;
    /** Wake records that did not validate. */
    invalidWakes: number;
    wakesWithoutTime: number;
    /** Recorded wakes whose turn end was not recorded: judged over the 10-minute window instead. */
    wakesWithoutEnd: number;
    /** Intervention log entries that did not validate (A-12). */
    invalidInterventions: number;
    effectfulWithoutTime: number;
    /** `rm -rf` of a target that cannot be judged: a variable, or a path while the workspace directory is unknown. */
    rmTargetsNotJudged: number;
    /** Requests with beads or a plan or an ADR but no reported tier: not judged for `process.smallHeavy`. */
    processWeightWithoutTier: number;
    /** Finished requests with no reported tier and no Reviewer turn: not judged for `process.unreviewed`. */
    unreviewedWithoutTier: number;
    /** A Manager reply in the other language recorded at the very time of the user's message: its order, and so `process.languageMismatch`, not known. */
    languageOrderUnknown: number;
    /**
     * The owner's answers to a Worker question or an Orchestrator decision
     * stored before reversals were recorded (no `prediction`, change-007
     * §3.3): whether they were reversed is not known, so they are left out
     * of A-5's owner reference.
     */
    ownerAnswersBeforeReversals: number;
  };
}

/** The tally every metric adds what it could not read to (`EvalMetrics.unknowns`). */
export type EvalUnknowns = EvalMetrics["unknowns"];
