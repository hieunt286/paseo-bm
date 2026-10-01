import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { interventionKindSchema } from "../interventions";
import { workspaceIdSchema } from "./persisted";

/**
 * Insights' one RPC, `insights.summary`, and the windows it offers.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Insights (autonomy design §A.12, experience concept §4.3): the flow and cost
// figures of `shared/eval-metrics.ts` over the plugin's own data folder.
// ---------------------------------------------------------------------------

/** The windows Insights offers: the last 7, 30 or 90 days, or everything recorded. */
export const INSIGHTS_WINDOWS = ["7d", "30d", "90d", "all"] as const;
export type InsightsWindow = (typeof INSIGHTS_WINDOWS)[number];

const insightsRoleCountsSchema = z.object({
  manager: z.number(),
  worker: z.number(),
  reviewer: z.number(),
  orchestrator: z.number(),
  unknown: z.number(),
});

/** How a set of figures spreads (`Spread` of `shared/eval-metrics.ts`): null for none. */
const insightsSpreadSchema = z.object({
  count: z.number().int(),
  median: z.number().nullable(),
  p75: z.number().nullable(),
  p80: z.number().nullable(),
  p90: z.number().nullable(),
  max: z.number().nullable(),
});

const insightsSpreadByRoleSchema = z.object({
  all: insightsSpreadSchema,
  byRole: z.object({
    manager: insightsSpreadSchema,
    worker: insightsSpreadSchema,
    reviewer: insightsSpreadSchema,
    orchestrator: insightsSpreadSchema,
    unknown: insightsSpreadSchema,
  }),
});

/** Review lift over a set of requests (`ReviewLiftFigures` of `shared/eval-metrics.ts`): a `null` figure is unknown, never zero. */
const insightsReviewLiftFiguresSchema = z.object({
  requests: z.number().int(),
  reviews: z.number().int(),
  reviewsPerRequest: z.number().nullable(),
  batches: z.number().int(),
  blockingFindings: z.number().int(),
  blockingPerBatch: z.number().nullable(),
  actedOn: z.object({
    reReviewedBatches: z.number().int(),
    found: z.number().int(),
    fixed: z.number().int(),
    reviewedOnceBatches: z.number().int(),
  }),
  tokens: z.object({ reviews: z.number().int(), total: z.number(), perReview: z.number().nullable() }),
  unknown: z.object({
    reviewsWithoutBatch: z.number().int(),
    reviewsWithUnknownBlocking: z.number().int(),
    batchesWithUnknownBlocking: z.number().int(),
    reReviewedWithUnknownBlocking: z.number().int(),
    requestsWithoutReviewerTokens: z.number().int(),
    requestsWithoutReview: z.number().int(),
  }),
});

/**
 * `insights.summary` — reads only. `computeEvalMetrics` over the data folder,
 * read with the replay's reader (`server/eval-store.ts`: no lock, no write),
 * for every workspace or `workspaceId`, over `window` ending now. **Numbers
 * only**: no message text, no path, no label — the client names the projects.
 * `available: false` when the data folder cannot be used (every figure then
 * reads as none). A `null` figure is unknown, never zero.
 */
export const insightsSummaryRpc = defineRpc({
  name: "insights.summary",
  input: z.object({ window: z.enum(INSIGHTS_WINDOWS), workspaceId: workspaceIdSchema.optional() }),
  output: z.object({
    available: z.boolean(),
    window: z.object({ key: z.enum(INSIGHTS_WINDOWS), since: z.string().nullable(), until: z.string().nullable() }),
    requests: z.object({ inWindow: z.number().int(), finished: z.number().int() }),
    /** Requests by the UTC day of their earliest activity, oldest first; days with none are left out. */
    requestsByDay: z.array(z.object({ day: z.string(), requests: z.number().int() })),
    /** A-1 over finished requests. */
    questions: z.object({
      asked: z.number().int(),
      reachedOwner: z.number().int(),
      answeredByAgents: z.number().int(),
      perFinishedRequest: z.object({ asked: z.number(), reachedOwner: z.number(), answeredByAgents: z.number() }).nullable(),
    }),
    ownerWait: z.object({ questions: z.number().int(), medianMs: z.number().nullable(), p90Ms: z.number().nullable() }),
    /** A-11: first turn to the finished report, the owner's wait taken out. */
    timeToFinished: z.object({ medianMs: z.number().nullable(), requests: z.number().int() }),
    /** A-8: tokens (input + cached + output) of finished requests. */
    tokens: z.object({
      total: z.number(),
      byRole: insightsRoleCountsSchema,
      perFinishedRequest: z.object({ total: z.number(), byRole: insightsRoleCountsSchema }).nullable(),
      medianPerFinishedRequest: z.number().nullable(),
      finishedRequestsWithMissingUsage: z.number().int(),
    }),
    errors: z.object({
      failedTurns: z.object({ total: z.number().int(), byRole: insightsRoleCountsSchema }),
      cancelledTurns: z.object({ total: z.number().int(), byRole: insightsRoleCountsSchema }),
    }),
    turnsByRole: insightsRoleCountsSchema,
    /**
     * A-12 (autonomy design §G.3): the Orchestrator's interventions recorded in
     * the window, one row per kind in `INTERVENTION_KINDS` order; `share` is
     * met / (met + missed), null when none is checked either way.
     */
    interventions: z.array(
      z.object({
        kind: interventionKindSchema,
        recorded: z.number().int(),
        met: z.number().int(),
        missed: z.number().int(),
        unknown: z.number().int(),
        pending: z.number().int(),
        share: z.number().nullable(),
      }),
    ),
    /** What could not be read or counted: store lines and files, turns without usage, finished requests without a duration. */
    unknowns: z.object({
      malformedLines: z.number().int(),
      unreadableFiles: z.number().int(),
      turnsWithoutUsage: z.number().int(),
      requestsWithoutDuration: z.number().int(),
    }),
    /**
     * Context and tokens (autonomy design §G.2), `EvalMetrics.context` less the
     * candidates: tokens read per turn, per request and per agent, the context
     * per turn (reported or an estimate, counted apart), the heaviest requests,
     * and A-8's Orchestrator tokens from its wakes. The one id it carries is a
     * heaviest request's `workspaceId`, so the client can name the project.
     * Optional: an older server sends none.
     */
    context: z
      .object({
        turns: z.object({
          withUsage: z.number().int(),
          byProvider: z.object({ claude: z.number().int(), codex: z.number().int(), opencode: z.number().int(), unknown: z.number().int() }),
          repeated: z.number().int(),
          withToolCalls: z.number().int(),
        }),
        tokensRead: z.object({
          total: z.number(),
          byRole: insightsRoleCountsSchema,
          perTurn: insightsSpreadByRoleSchema,
          perRequest: insightsSpreadByRoleSchema,
          perAgent: insightsSpreadByRoleSchema,
          heaviestRequests: z.array(
            z.object({
              workspaceId: workspaceIdSchema,
              tokensRead: z.number(),
              byRole: insightsRoleCountsSchema,
              turns: z.number().int(),
              finished: z.boolean(),
            }),
          ),
        }),
        contextEstimate: z.object({
          reported: z.number().int(),
          estimated: z.number().int(),
          unknown: z.number().int(),
          perTurn: insightsSpreadByRoleSchema,
          shareOfWindow: insightsSpreadSchema,
        }),
        orchestrator: z.object({
          wakes: z.number().int(),
          wakesWithUsage: z.number().int(),
          tokens: z.number().nullable(),
          perFinishedRequest: z.number().nullable(),
        }),
      })
      .optional(),
    /**
     * Review lift (autonomy design §C.4), `EvalMetrics.reviewLift` less its
     * split by workspace (the request names one or none): over every tier and
     * per tier — a request's last reported tier, `unknown` without one — and
     * the Reviewer turns with no request. Optional: an older server sends none.
     */
    reviewLift: z
      .object({
        all: insightsReviewLiftFiguresSchema,
        byTier: z.object({
          Small: insightsReviewLiftFiguresSchema,
          Medium: insightsReviewLiftFiguresSchema,
          Large: insightsReviewLiftFiguresSchema,
          unknown: insightsReviewLiftFiguresSchema,
        }),
        reviewerTurnsWithoutRequest: z.number().int(),
      })
      .optional(),
  }),
});

export type InsightsSummaryInput = z.infer<typeof insightsSummaryRpc.input>;
export type InsightsSummary = z.infer<typeof insightsSummaryRpc.output>;
