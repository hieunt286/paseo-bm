import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  agentIdSchema,
  agentRoleSchema,
  evidenceSchema,
  guardrailReportSchema,
  parsedReportSchema,
  parsedReviewSchema,
  tierSchema,
  traceMessageSchema,
  usageSchema,
  workspaceIdSchema,
} from "./persisted";

/**
 * The Dashboard: the views of the trace store (a request's row and detail,
 * tokens and context per agent), the bead and workspace figures, and the
 * `traces.*` RPCs that read, delete and move traces. The record they are
 * built from is in `persisted.ts`.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Dashboard (Phase 2a) — WP-201.
//
// Source of truth: docs/design/paseo-bm-dashboard.md §§3.2–3.3 (persisted
// record), §4 (data model) and §5 (RPC + error codes). Field names are part of
// a *persisted* format: renaming one later costs a schema migration, so they
// follow the design literally.
//
// Everything below is read-only from the caller's point of view except
// `traces.delete` and `traces.reassign`, which only ever touch paseo-bm's own
// trace store (REQ-047).
// ---------------------------------------------------------------------------

/**
 * How sure the server is about a derived conclusion. Rendered to the user, never
 * hidden: `inferred` and `unknown` are the honest answers the Dashboard is
 * required to show instead of a plausible guess (REQ-041d, REQ-044c, REQ-045).
 */
export const confidenceSchema = z.enum(["exact", "inferred", "unknown"]);

/** Lifecycle of one request, derived in the fixed order of design §7.3. */
export const traceStateSchema = z.enum([
  "running",
  "waiting_user",
  "completed",
  "stopped",
  "failed",
  "unknown",
]);

/**
 * Whether the workspace a trace belongs to still exists in Paseo (design §3.7).
 * `unknown` is used when `workspaces.list()` failed — one failed call must never
 * be turned into the conclusion "this workspace is gone" (REQ-057a).
 */
export const workspaceStateSchema = z.enum(["live", "archived", "orphaned", "unknown"]);

/** A bead count plus how sure it is (REQ-044b, REQ-044c). */
export const beadCountSchema = z.object({
  count: z.number().int().nonnegative(),
  confidence: confidenceSchema,
});

/**
 * How many times a request went wrong, whatever the reason (REQ-069 g,
 * delta 20260925 §3.4).
 *
 * The three numbers are **disjoint**, so adding them up is a count of failures
 * and not three views of the same death: one usage-limit failure writes a failed
 * turn, leaves its agent in `error` and files a fallback incident, and it must
 * read as one error.
 */
export const traceErrorsSchema = z.object({
  /** Turns of **this row** that ended `failed`. */
  failedTurns: z.number().int().nonnegative(),
  /**
   * Agents of the request left in Paseo's `error` status that have **no** failed
   * turn record in this trace — killed before the collector wrote one. Set on the
   * row that opens the request only, because it belongs to the request.
   */
  agentErrors: z.number().int().nonnegative(),
  /**
   * Provider-plan incidents of this request whose turn still ended `completed`
   * (`signal: "completed"`: the turn ran and did nothing). An incident with
   * `signal: "failed"` came from a turn already counted in `failedTurns`. Set on
   * the row that opens the request only.
   */
  fallbacks: z.number().int().nonnegative(),
});

export type TraceErrors = z.infer<typeof traceErrorsSchema>;

/** How one claim of a report stands (autonomy design §C.2; `CLAIM_LABELS`, `shared/evidence.ts`). */
export const claimLabelSchema = z.enum(["detected", "self-reported"]);

/** How a request's checks stand as a whole (autonomy design §C.2; `CHECKS_VERDICTS`, `shared/evidence.ts`). */
export const checksVerdictSchema = z.enum(["detected", "self-reported", "unverified", "not-checked"]);

/**
 * A request's finish against its records (autonomy design §C.2, §C.3, §C.6;
 * `requestFinishOf`, `shared/evidence.ts`): the claims of its latest report,
 * which is `finished`, each labelled, and whether the request is
 * finished-unverified. The enums are written out here because a contract
 * module imports no other `shared/` module; the server's build of it checks
 * them against `shared/evidence.ts`.
 */
export const traceVerificationSchema = z.object({
  /** When the labelled `finished` report was sent. */
  reportAt: z.string(),
  checks: checksVerdictSchema,
  /** Each check the report names, normalised, once, in its order. */
  named: z.array(z.object({ check: z.string(), label: claimLabelSchema })),
  files: z.array(z.object({ path: z.string(), label: claimLabelSchema })),
  beads: z.array(z.object({ id: z.string(), label: claimLabelSchema })),
  /** The report names a file changed, or a record of the request edited one. */
  changedFiles: z.boolean(),
  /** Finished-unverified (§C.3): code changed and the named checks are not all detected; never for `not-checked`. */
  unverified: z.boolean(),
});

export type TraceVerification = z.infer<typeof traceVerificationSchema>;

/** One row of the trace list (design §4.2). */
export const traceSummarySchema = z.object({
  traceId: z.string().min(1),
  requestId: z.string().nullable(),
  requestedAt: z.string(),
  /** Null when no user turn was captured, so the screen says so rather than showing "". */
  excerpt: z.string().nullable(),
  /**
   * Which turn of the request this row is, when the user asked more than once
   * (delta 20260917e §4.3). `null` for a request that was never followed up, so
   * those rows look exactly as they always did — no `turn 1` noise.
   *
   * Rows of one request share a `traceId` on purpose: opening any of them leads
   * to the same request. The list key is the pair.
   */
  turn: z.object({ index: z.number().int().positive(), total: z.number().int().positive() }).nullable(),
  state: traceStateSchema,
  workerIds: z.array(agentIdSchema),
  reviewerIds: z.array(agentIdSchema),
  reviewCalls: z.number().int().nonnegative().nullable(),
  guardrailReported: guardrailReportSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  usage: usageSchema,
  /** Messages sent and received by the request's agents, for the overview. */
  messageCount: z.number().int().nonnegative(),
  /** Messages the user typed directly to one of the request's agents. */
  userMessageCount: z.number().int().nonnegative(),
  /** Tokens and cost per Worker of this request, for the "heaviest Workers" chart. */
  workerUsage: z.array(z.object({ agentId: agentIdSchema, title: z.string().nullable(), usage: usageSchema })),
  /**
   * Tokens and cost per (role, model the agents ran), for the overview's
   * "model × role" chart (delta 20260918 §4.3, REQ-058e). Always sent by this
   * server; optional so an older payload still parses.
   */
  usageByModelRole: z
    .array(z.object({ role: agentRoleSchema, model: z.string().nullable(), usage: usageSchema }))
    .optional(),
  /**
   * Errors of this row (delta 20260925 §3.4). Optional so a payload written
   * before it still parses; a reader without it counts no errors.
   */
  errors: traceErrorsSchema.optional(),
  beadCounts: z.object({
    created: beadCountSchema,
    updated: beadCountSchema,
    closed: beadCountSchema,
    ready: beadCountSchema,
  }),
  tier: tierSchema.nullable(),
  linking: confidenceSchema,
  agentsMissing: z.array(agentIdSchema),
  workspaceState: workspaceStateSchema,
  reassignedFrom: workspaceIdSchema.nullable(),
  notices: z.array(z.string()),
  /**
   * The request's finish, labelled (autonomy design §C.3, §C.6): present while
   * its latest report is `finished`; the same on every row of the request.
   * Optional and additive: an older reader ignores it, and `state` keeps its
   * values.
   */
  verification: traceVerificationSchema.optional(),
});

/** Timing of one agent inside a trace (design §7.1). */
export const agentTimingSchema = z.object({
  agentId: agentIdSchema,
  role: agentRoleSchema,
  startedAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  ms: z.number().int().nonnegative().nullable(),
  state: traceStateSchema,
});

/** Timing of one Manager turn (design §7.1). */
export const turnTimingSchema = z.object({
  turnId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  ms: z.number().int().nonnegative().nullable(),
});

/**
 * The twelve fixed feature-workflow steps the Dashboard reports on (REQ-045a;
 * `review_plan` added by delta 20260917-workflow-skills §5.5).
 */
export const workflowStepSchema = z.enum([
  "classify_tier",
  "prd",
  "design",
  "adr",
  "plan",
  "review_plan",
  "convert_to_beads",
  "polish_beads",
  "implement",
  "review_batches",
  "build_and_tests",
  "close_with_evidence",
]);

/**
 * One row of the workflow table. `skipped` is only legal when the Worker stated
 * a tier that REQ-036 allows to skip that step; everything else is `unknown`
 * (REQ-045d) — the rule that keeps the table from accusing a good run.
 */
export const workflowStepResultSchema = z.object({
  step: workflowStepSchema,
  status: z.enum(["done", "skipped", "unknown"]),
  confidence: confidenceSchema,
  evidence: z.array(evidenceSchema),
  note: z.string().nullable(),
});

/** A bead the trace touched, with its current state read from the store (REQ-044). */
export const traceBeadSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  statusNow: z.string().nullable(),
  action: z.enum(["created", "updated", "closed", "ready"]),
  confidence: confidenceSchema,
  evidence: z.array(evidenceSchema),
});

/**
 * A provider-internal sub-agent seen only as a tool-call trace. Paseo 0.8 gives
 * plugins no way to list them (`listProviderSubagents` is `DaemonClient`-only),
 * so these are counted as traces, and labelled as such (REQ-042e).
 */
export const subAgentTraceSchema = z.object({
  agentId: agentIdSchema,
  subAgentType: z.string().nullable(),
  description: z.string().nullable(),
  count: z.number().int().nonnegative(),
});

/**
 * One combination of model, thinking option and mode an agent ran on, and in
 * how many turns (delta 20260918 §4.3, REQ-058 a–c). `recorded: false` means the
 * turn predates the collector recording it (or its snapshot could not be read):
 * the model then comes from `usage` and thinking/mode are unknown — which is not
 * the same as `recorded: true` with `thinkingOptionId: null`, the provider's default.
 */
export const runtimeRowSchema = z.object({
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  modeId: z.string().nullable(),
  recorded: z.boolean(),
  turns: z.number().int().positive(),
});

/** Full detail of one trace (design §4.3). */
export const traceDetailSchema = traceSummarySchema.extend({
  sent: z.object({
    userRequest: traceMessageSchema.nullable(),
    workerInitialPrompts: z.array(traceMessageSchema),
    reviewRequests: z.array(traceMessageSchema.extend({ batchId: z.string().nullable() })),
  }),
  received: z.object({
    reports: z.array(parsedReportSchema),
    reviews: z.array(parsedReviewSchema),
    managerReplies: z.array(traceMessageSchema),
  }),
  timing: z.object({
    totalMs: z.number().int().nonnegative().nullable(),
    managerTurns: z.array(turnTimingSchema),
    workers: z.array(agentTimingSchema),
    reviewers: z.array(agentTimingSchema),
    basis: z.string(),
  }),
  usageByAgent: z.array(
    z.object({
      agentId: agentIdSchema,
      role: agentRoleSchema,
      usage: usageSchema,
      /** What this agent ran on, one row per distinct combination (delta 20260918 §4.3). */
      runtime: z.array(runtimeRowSchema).optional(),
    }),
  ),
  /** Tokens and cost per model the agents actually ran (delta 20260918 §4.3, REQ-058d). */
  usageByModel: z.array(z.object({ model: z.string().nullable(), usage: usageSchema })).optional(),
  beads: z.array(traceBeadSchema),
  workflowSteps: z.array(workflowStepResultSchema),
  subAgentTraces: z.array(subAgentTraceSchema),
  /** Messages the user typed directly to an agent of this request, oldest first. */
  userMessages: z.array(traceMessageSchema),
  /** Skills each agent loaded, oldest first. */
  skills: z.array(z.object({ agentId: agentIdSchema, skill: z.string(), at: z.string().nullable() })),
  /**
   * The Workers that took the request over by a handoff, each with the Worker
   * it replaced (their `bm.handoffFrom` label; autonomy design §G.6). Absent
   * when there was none, and from a server before it.
   */
  handoffs: z.array(z.object({ agentId: agentIdSchema, from: agentIdSchema })).optional(),
});

/**
 * Bead statistics of one workspace (REQ-046). `present: false` means the
 * workspace has no `.beads/issues.jsonl` — an empty state, not an error.
 */
export const beadStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  readAt: z.string(),
  source: z.string(),
  skippedLines: z.number().int().nonnegative(),
  present: z.boolean(),
});

/** Size of the trace store, measured with `stat` and never by reading content. */
export const storeSizeSchema = z.object({
  bytes: z.number().int().nonnegative(),
  workspaceBytes: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// RPC contracts (design §5).
// ---------------------------------------------------------------------------

/** Largest page `traces.list` will return, and its default (REQ-049a, Q-034). */
export const TRACE_LIST_LIMIT = 50;

/** `traces.list` — one page of trace rows for a workspace, newest first. */
export const tracesListRpc = defineRpc({
  name: "traces.list",
  input: z.object({
    workspaceId: workspaceIdSchema,
    limit: z.number().int().positive().max(TRACE_LIST_LIMIT).optional(),
    cursor: z.string().min(1).optional(),
  }),
  output: z.object({
    traces: z.array(traceSummarySchema),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
    store: storeSizeSchema,
    notices: z.array(z.string()),
  }),
});

/** `traces.get` — full detail of one trace; unknown id fails `E_TRACE_NOT_FOUND`. */
export const tracesGetRpc = defineRpc({
  name: "traces.get",
  input: z.object({
    workspaceId: workspaceIdSchema,
    traceId: z.string().min(1),
  }),
  output: z.object({
    trace: traceDetailSchema,
  }),
});

/** The most context points `traces.agents` sends per agent: its newest turns that have one. */
export const CONTEXT_TREND_MAX = 24;

/**
 * One agent's tokens and context over a scope (autonomy design §G.2 Shown),
 * each turn read with `turnTokensOf` beside the agent's turn before it that
 * had usage. Numbers only: the id is the client's key, shown only under a
 * request's Details.
 */
export const agentTokenFiguresSchema = z.object({
  agentId: agentIdSchema,
  role: agentRoleSchema,
  /** The agent's turns in scope, and those with usage. */
  turns: z.number().int().nonnegative(),
  turnsWithUsage: z.number().int().nonnegative(),
  /** Tokens read over the turns with usage, each by its provider's counting. */
  tokensRead: z.number().nonnegative(),
  /** Turns with usage whose provider reports only the last model call (Codex, OpenCode): their tokens read are a lower bound. */
  lastCallTurns: z.number().int().nonnegative(),
  /** The context at the end of each turn that has one, oldest first: the newest `CONTEXT_TREND_MAX`. */
  contextTrend: z.array(z.number().nonnegative()).max(CONTEXT_TREND_MAX),
  /** Turns in scope with a context figure (`contextTrend` holds the newest), and how many of them are estimates. */
  contextTurns: z.number().int().nonnegative(),
  contextEstimated: z.number().int().nonnegative(),
  /** The largest context in scope; null with none. */
  contextPeak: z.number().nonnegative().nullable(),
  /** The newest window the provider reported in scope; null when none was. */
  contextMax: z.number().int().positive().nullable(),
  /** Compactions recorded in scope. */
  compactions: z.number().int().nonnegative(),
});

/**
 * `traces.agents` — reads only. Tokens and context per agent (autonomy design
 * §G.2): with `traceId`, of every agent over that request's turns; without,
 * of each agent Paseo lists in the workspace (not archived) over its life.
 * An unknown `traceId` fails `E_TRACE_NOT_FOUND`.
 */
export const tracesAgentsRpc = defineRpc({
  name: "traces.agents",
  input: z.object({
    workspaceId: workspaceIdSchema,
    traceId: z.string().min(1).optional(),
  }),
  output: z.object({
    agents: z.array(agentTokenFiguresSchema),
  }),
});

export type AgentTokenFigures = z.infer<typeof agentTokenFiguresSchema>;

/**
 * Scope of a deletion. Exactly one of the three shapes (REQ-054a); the union is
 * what stops a caller from half-specifying a destructive operation.
 */
export const traceDeleteScopeSchema = z.union([
  z.object({ traceId: z.string().min(1) }),
  z.object({ before: z.string().min(1) }),
  z.object({ allOfWorkspace: z.literal(true) }),
]);

/** `traces.delete` — `dryRun: true` only counts, so the UI can confirm first. */
export const tracesDeleteRpc = defineRpc({
  name: "traces.delete",
  input: z.object({
    workspaceId: workspaceIdSchema,
    scope: traceDeleteScopeSchema,
    dryRun: z.boolean().optional(),
  }),
  output: z.object({
    deleted: z.object({
      traces: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      /** Requests in scope that still have a running agent (REQ-054e). */
      running: z.number().int().nonnegative(),
    }),
    store: storeSizeSchema,
  }),
});

/**
 * `traces.reassign` — move the traces of a workspace that is gone onto one that
 * exists (REQ-057d). Never automatic: only a user action reaches this RPC.
 */
export const tracesReassignRpc = defineRpc({
  name: "traces.reassign",
  input: z.object({
    fromWorkspaceId: workspaceIdSchema,
    toWorkspaceId: workspaceIdSchema,
    dryRun: z.boolean().optional(),
  }),
  output: z.object({
    moved: z.object({
      traces: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    }),
    store: storeSizeSchema,
  }),
});

/**
 * `traces.workspaces` — every workspace that has trace history, with what
 * Paseo says about it now. This is how a closed workspace's history stays
 * reachable: the launcher only lists workspaces Paseo still has.
 */
export const tracesWorkspacesRpc = defineRpc({
  name: "traces.workspaces",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(
      z.object({
        workspaceId: workspaceIdSchema,
        state: workspaceStateSchema,
        lastKnownName: z.string().nullable(),
        lastKnownDirectory: z.string().nullable(),
        lastSeenAt: z.string().nullable(),
        bytes: z.number().int().nonnegative(),
      }),
    ),
  }),
});

/** `beads.stats` — counts of the workspace's bead store; missing file is not an error. */
export const beadsStatsRpc = defineRpc({
  name: "beads.stats",
  input: z.object({
    workspaceId: workspaceIdSchema,
  }),
  output: z.object({
    stats: beadStatsSchema,
  }),
});

/**
 * `workspaces.overview` — per listed workspace: its bead counts (null when the
 * workspace has no readable bead store) and how many Workers are running now.
 * One call for the whole Beads Manager screen.
 */
export const workspacesOverviewRpc = defineRpc({
  name: "workspaces.overview",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(
      z.object({
        workspaceId: workspaceIdSchema,
        beads: z
          .object({
            total: z.number().int().nonnegative(),
            inProgress: z.number().int().nonnegative(),
            blocked: z.number().int().nonnegative(),
            ready: z.number().int().nonnegative(),
          })
          .nullable(),
        /** Kept for readers that predate `runningAgents`; equals `runningAgents.worker`. */
        runningWorkers: z.number().int().nonnegative(),
        /** Running agents of this workspace, per role (delta 20260917e §4.2). */
        runningAgents: z.object({
          manager: z.number().int().nonnegative(),
          worker: z.number().int().nonnegative(),
          reviewer: z.number().int().nonnegative(),
          /** Running Orchestrator assessments (orchestrator design §3.2); absent from a 0.4.x server. */
          orchestrator: z.number().int().nonnegative().optional(),
        }),
      }),
    ),
  }),
});

export type WorkspaceOverview = z.infer<typeof workspacesOverviewRpc.output>["workspaces"][number];

/**
 * `agents.stop-all` — asks every running Worker and Reviewer of one workspace to
 * stop (delta 20260917e §4.4). It ASKS: Paseo gives plugins no agent cancel, so
 * the counts below are notices delivered, not turns killed.
 */
export const agentsStopAllRpc = defineRpc({
  name: "agents.stop-all",
  input: z.object({ workspaceId: workspaceIdSchema }),
  output: z.object({
    workers: z.number().int().nonnegative(),
    reviewers: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});

export type Confidence = z.infer<typeof confidenceSchema>;
export type TraceState = z.infer<typeof traceStateSchema>;
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export type TraceDetail = z.infer<typeof traceDetailSchema>;
export type AgentTiming = z.infer<typeof agentTimingSchema>;
export type TurnTiming = z.infer<typeof turnTimingSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepResult = z.infer<typeof workflowStepResultSchema>;
export type TraceBead = z.infer<typeof traceBeadSchema>;
export type SubAgentTrace = z.infer<typeof subAgentTraceSchema>;
export type BeadStats = z.infer<typeof beadStatsSchema>;
export type StoreSize = z.infer<typeof storeSizeSchema>;
export type RuntimeRow = z.infer<typeof runtimeRowSchema>;
export type TraceDeleteScope = z.infer<typeof traceDeleteScopeSchema>;
