import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * RPC contracts for the paseo-bm plugin.
 *
 * Source of truth: docs/design/paseo-bm.md §5 ("Hợp đồng RPC của plugin").
 * This module is `shared/`, so it must stay free of Node and React Native
 * runtime imports: Zod schemas and plain values only.
 *
 * WP-108 delivers the contracts. Handler behaviour lives in `server/` (WP-112)
 * and the surfaces that call them live in `client/` (WP-113).
 */

/** Value of the `bm.role` agent label that paseo-bm sets when it creates an agent. */
export const bmRoleSchema = z.enum(["manager", "worker", "reviewer"]);

/** Identifier of a Paseo workspace, as returned by the Paseo SDK. */
export const workspaceIdSchema = z.string().min(1);

/** Identifier of a Paseo agent, as returned by the Paseo SDK. */
export const agentIdSchema = z.string().min(1);

/**
 * `manager.ensure` — find the live Manager of a workspace by its `bm.role=manager`
 * label, or create one from the `bm-manager` profile with the instructions in
 * `roles/manager.md`. `created` reports which of the two happened.
 *
 * `otherManagerIds` lists the other live Managers of the same workspace (newest
 * first) when more than one exists; `agentId` is then the newest. They are
 * reported, never deleted or archived (design §9.3). NOTE: this field is not in
 * the design §5 table yet — see the WP-112 report; it is the only channel for
 * the "báo trong panel" requirement.
 *
 * Failures are thrown as errors whose message starts with a registry code
 * (`E_PROVIDER_UNAVAILABLE`).
 */
export const managerEnsureRpc = defineRpc({
  name: "manager.ensure",
  input: z.object({
    workspaceId: workspaceIdSchema,
  }),
  output: z.object({
    agentId: agentIdSchema,
    created: z.boolean(),
    otherManagerIds: z.array(agentIdSchema),
    /**
     * Why an existing Manager was not switched to its no-prompt mode, or `null`
     * (delta 20260918 §4.1). Added field: a client that does not know it drops it.
     */
    modeNotice: z.string().nullable(),
  }),
});

/**
 * Role shown for a listed agent: one of the three roles, or `unknown` when the
 * `bm.role` label is missing or holds another value (design §5, "không rõ vai trò").
 */
export const agentRoleSchema = z.enum(["manager", "worker", "reviewer", "unknown"]);

/**
 * One node of the agent tree the workspace panel draws.
 *
 * `role` is `unknown` when the agent carries no readable `bm.role` label; the
 * panel renders that instead of dropping the agent (design §5).
 * `title` mirrors the SDK snapshot, which may be `null` (untitled agent).
 * `parentId` is the `paseo.parent-agent-id` label when that parent is itself in
 * the list, otherwise `null` — so an orphaned Worker (its Manager deleted or
 * archived) is a root of the tree (design §8).
 */
export const agentNodeSchema = z.object({
  id: agentIdSchema,
  role: agentRoleSchema,
  title: z.string().nullable(),
  status: z.string(),
  parentId: agentIdSchema.nullable(),
  updatedAt: z.string(),
  /**
   * False when the agent has no valid `bm.role` label: its role came from its
   * provider, or it is an unlabelled descendant (delta 20260918g §4.4).
   * Defaults to true for older servers.
   */
  labelled: z.boolean().default(true),
});

/**
 * `agents.list` — the agents of one workspace, flat. The caller builds the tree
 * from `role` and `parentId`.
 */
export const agentsListRpc = defineRpc({
  name: "agents.list",
  input: z.object({
    workspaceId: workspaceIdSchema,
  }),
  output: z.object({
    agents: z.array(agentNodeSchema),
  }),
});

/**
 * One row of the effective role configuration the panel shows (REQ-032d).
 *
 * Read from the Paseo configuration in effect (errata bm-dnc): `provider` is the
 * base provider the role's derived provider extends, `model` comes from the
 * role's agent profile, `paseoTools` is whether the derived provider currently
 * has the Paseo agent tools enabled, and `instructionsPath` is the name of the
 * role's instructions inside the payload (e.g. `roles/manager.md`), not an
 * on-disk path.
 */
export const roleDescriptorSchema = z.object({
  role: bmRoleSchema,
  provider: z.string(),
  model: z.string(),
  paseoTools: z.boolean(),
  instructionsPath: z.string(),
});

/**
 * `roles.describe` — the role configuration in effect right now. Takes no input.
 */
export const rolesDescribeRpc = defineRpc({
  name: "roles.describe",
  input: z.object({}),
  output: z.object({
    roles: z.array(roleDescriptorSchema),
  }),
});

export type BmRole = z.infer<typeof bmRoleSchema>;
/** Input shape: `labelled` may be absent (meaning labelled), as from a server older than delta 20260918g. */
export type AgentNode = z.input<typeof agentNodeSchema>;
export type RoleDescriptor = z.infer<typeof roleDescriptorSchema>;

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

/** One traceable piece of evidence behind a derived conclusion (design §4.1). */
export const evidenceSchema = z.object({
  /** `skill`: the agent loaded an agent skill; `detail` is the skill name. */
  kind: z.enum(["report", "shell", "file", "agent", "timeline", "skill"]),
  detail: z.string(),
  agentId: agentIdSchema.nullable(),
  at: z.string().nullable(),
});

/**
 * Token and cost roll-up (REQ-052). `costBasis` is what keeps the number
 * honest: `provider` is the figure the tool itself reported, `estimated` comes
 * from the dated price table bundled with the release, and `unavailable` means
 * the model is not in that table — then `costUsd` is null and only tokens show.
 */
export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  costBasis: z.enum(["provider", "estimated", "unavailable"]),
  model: z.string().nullable(),
  pricesUpdatedAt: z.string().nullable(),
});

/** Lifecycle of one request, derived in the fixed order of design §7.3. */
export const traceStateSchema = z.enum([
  "running",
  "waiting_user",
  "completed",
  "stopped",
  "failed",
  "unknown",
]);

/** Request size the Worker classified itself into (REQ-036, REQ-045e). */
export const tierSchema = z.enum(["Small", "Medium", "Large"]);

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

/** Self-reported guardrail counters, verbatim from a `BM-REPORT` (REQ-042c). */
export const guardrailReportSchema = z.object({
  batchId: z.string().nullable(),
  batchReviews: z.number().int().nonnegative().nullable(),
  batchMax: z.number().int().nonnegative().nullable(),
  polish: z.number().int().nonnegative().nullable(),
  polishMax: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  budget: z.number().int().nonnegative().nullable(),
  userAllowedExtra: z.number().int().nonnegative().nullable(),
  raw: z.string(),
});

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
   * those rows look exactly as they always did — no `lượt 1` noise.
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
});

/** Milestone of a `BM-REPORT` block (roles/worker.md, Reporting). */
export const reportPhaseSchema = z.enum([
  "received",
  "documents-done",
  "beads-done",
  "bead-implemented",
  "blocked",
  "finished",
]);

/**
 * One parsed `BM-REPORT`. Every field is nullable on purpose: the parser is
 * required to be tolerant, and a field it could not read becomes "không rõ"
 * rather than breaking the trace (REQ-050a).
 */
export const parsedReportSchema = z.object({
  agentId: agentIdSchema,
  at: z.string(),
  requestId: z.string().nullable(),
  phase: reportPhaseSchema.nullable(),
  tier: tierSchema.nullable(),
  filesChanged: z.array(z.string()),
  beadsCreated: z.array(z.string()),
  beadsUpdated: z.array(z.string()),
  beadsClosed: z.array(z.string()),
  beadsReady: z.array(z.string()),
  reviewFindingsOpen: z.string().nullable(),
  buildAndTests: z.string().nullable(),
  /** Skills the Worker loaded for the request (delta 20260917 §4.9); defaulted for older records. */
  skillsUsed: z.array(z.string()).default([]),
  blockers: z.string().nullable(),
  guardrail: guardrailReportSchema.nullable(),
  unparsedFields: z.array(z.string()),
  /**
   * Bead-id list fields the parser could not fully read (delta 20260917 §5.1):
   * their ids are a lower bound. Defaulted so records written before the field
   * existed still pass `traceRecordSchema` (the store drops undeclared keys).
   */
  incompleteFields: z.array(z.string()).default([]),
});

/** One parsed `BM-REVIEW` from a Reviewer (roles/reviewer.md). */
export const parsedReviewSchema = z.object({
  agentId: agentIdSchema,
  at: z.string(),
  batchId: z.string().nullable(),
  verdict: z.string().nullable(),
  blockingCount: z.number().int().nonnegative().nullable(),
});

/** A message the Dashboard shows as "sent" or "received" (REQ-043a, REQ-043b). */
export const traceMessageSchema = z.object({
  agentId: agentIdSchema.nullable(),
  at: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  /**
   * Who wrote an inbound message: `user` when Paseo's app sent it (the
   * timeline item carries `clientMessageId`), `agent` when another agent sent
   * it with `send_agent_prompt`. Absent on records written before this field
   * existed — never read that as "user".
   */
  origin: z.enum(["user", "agent"]).optional(),
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

/** Full detail of one trace (design §4.3). */
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
// Persisted format, schema version 1 (design §3.2, §3.3).
//
// These shapes live on disk under `<install home>/traces/`. A reader that meets
// a higher `schemaVersion` reads what it understands and refuses to write
// (`E_TRACE_STORE_SCHEMA_TOO_NEW`), so a new record must only ever *add*
// optional fields.
// ---------------------------------------------------------------------------

/** Current version of the persisted trace record and store metadata. */
export const TRACE_STORE_SCHEMA_VERSION = 1;

/** `<install home>/traces/meta.json`. */
export const traceStoreMetaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `<install home>/traces/<workspaceId>/meta.json` — lets an orphaned workspace still be recognisable (REQ-057a). */
export const traceWorkspaceMetaSchema = z.object({
  lastKnownName: z.string().nullable(),
  lastKnownDirectory: z.string().nullable(),
  lastSeenAt: z.string(),
});

/**
 * What the agent actually ran on during one turn (delta 20260918 §4.2): the
 * running values the provider reports (`runtimeInfo`) first, the snapshot's
 * configuration only as a fallback. `thinkingOptionId: null` means the
 * provider's default.
 */
export const traceRuntimeSchema = z.object({
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  modeId: z.string().nullable(),
});

/** One line of `events-<YYYYMM>.jsonl`: everything one agent turn produced. */
export const traceRecordSchema = z.object({
  v: z.number().int().positive(),
  kind: z.literal("turn"),
  at: z.string(),
  workspaceId: workspaceIdSchema,
  agentId: agentIdSchema,
  role: agentRoleSchema,
  turnId: z.string().nullable(),
  requestId: z.string().nullable(),
  parentAgentId: agentIdSchema.nullable(),
  agentCreatedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string(),
  outcome: z.enum(["completed", "failed", "canceled"]),
  sent: z.array(traceMessageSchema),
  received: z.array(traceMessageSchema),
  reports: z.array(parsedReportSchema),
  reviews: z.array(parsedReviewSchema),
  evidence: z.array(evidenceSchema),
  usage: usageSchema.nullable(),
  /**
   * Added by delta 20260918 — optional, so records written before it (and
   * readers built before it) keep working: `v` stays 1, nothing migrates. `null`
   * when the snapshot could not be read for this turn.
   */
  runtime: traceRuntimeSchema.nullable().optional(),
});

// ---------------------------------------------------------------------------
// Error codes.
//
// Registered in the single product-wide registry (design gốc §4.4, delta
// `design-delta-20260916-trace-store`). They travel over the plugin RPC channel
// so they have no CLI exit code.
// ---------------------------------------------------------------------------

export const DASHBOARD_ERROR_CODES = [
  "E_TIMELINE_UNAVAILABLE",
  "E_BEADS_STORE_UNREADABLE",
  "E_TRACE_NOT_FOUND",
  "E_TRACE_STORE_UNWRITABLE",
  "E_TRACE_STORE_SCHEMA_TOO_NEW",
  "E_TRACE_REASSIGN_INVALID",
  "E_BEAD_NOT_FOUND",
  "E_ROLE_EXTRA_INVALID",
  "E_TOOL_PRESENT",
  "E_TOOL_INSTALL_FAILED",
] as const;

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[number];

/**
 * Coded failure of a Dashboard RPC. The message starts with the code so it
 * survives transports that only forward `message`, exactly like
 * `ManagerEnsureError` does for `manager.ensure`.
 */
export class DashboardError extends Error {
  readonly code: DashboardErrorCode;

  constructor(code: DashboardErrorCode, detail: string, options?: { cause?: unknown }) {
    super(`${code}: ${detail}`, options);
    this.name = "DashboardError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// RPC contracts (design §5). All five are new; the three Phase 1 contracts
// above are unchanged.
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

/** One bead in the Beads screen list (delta 20260916-beads-screen). */
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
        }),
      }),
    ),
  }),
});

export type WorkspaceOverview = z.infer<typeof workspacesOverviewRpc.output>["workspaces"][number];

/**
 * `launcher.order.get` / `launcher.order.set` — the order the owner pinned on
 * the Beads Manager screen (delta 20260917e §4.1). `notices` carries what could
 * not be read, so a broken preference file explains itself instead of failing
 * the screen.
 */
const launcherOrderOutput = z.object({
  pinned: z.array(workspaceIdSchema),
  notices: z.array(z.string()),
});

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

export const launcherOrderGetRpc = defineRpc({
  name: "launcher.order.get",
  input: z.object({}),
  output: launcherOrderOutput,
});

export const launcherOrderSetRpc = defineRpc({
  name: "launcher.order.set",
  input: z.object({ pinned: z.array(workspaceIdSchema) }),
  output: launcherOrderOutput,
});

const answerMarksOutput = z.object({
  /** Card keys (`answeredKey`) the user marked as answered, oldest first. */
  keys: z.array(z.string()),
  notices: z.array(z.string()),
});

/** `answers.marks` — the cards the user marked as answered (delta 20260918d §4.9). */
export const answersMarksRpc = defineRpc({
  name: "answers.marks",
  input: z.object({}),
  output: answerMarksOutput,
});

/** `answers.mark` — marks one card as answered, or removes the mark (delta 20260918d §4.9). */
export const answersMarkRpc = defineRpc({
  name: "answers.mark",
  input: z.object({ key: z.string().min(1).max(400), marked: z.boolean() }),
  output: answerMarksOutput,
});

// ---------------------------------------------------------------------------
// Setup screen (delta 20260916-setup-screen).
// ---------------------------------------------------------------------------

export const setupRoleSchema = z.enum(["manager", "worker", "reviewer"]);
const skillStateSchema = z.enum(["ok", "missing", "broken"]);

export const setupStatusSchema = z.object({
  tools: z.array(
    z.object({
      id: z.enum(["br", "bv", "bd"]),
      name: z.string(),
      purpose: z.string(),
      required: z.boolean(),
      path: z.string().nullable(),
      version: z.string().nullable(),
      latestKnown: z.string().nullable(),
      installCommand: z.string().nullable(),
      updateCommand: z.string().nullable(),
      homepage: z.string(),
    }),
  ),
  latestCheckedOn: z.string(),
  skills: z.object({
    checkedAt: z.string(),
    dirs: z.object({ shared: z.string(), claude: z.string(), codex: z.string() }),
    skills: z.array(
      z.object({
        name: z.string(),
        required: z.boolean(),
        claude: skillStateSchema,
        codex: skillStateSchema,
        problem: z.string().nullable(),
      }),
    ),
    missingRequired: z.object({ claude: z.number().int(), codex: z.number().int() }),
    installCommand: z.string(),
  }),
  /** Characters of additional instructions per role; 0 when none. */
  extras: z.object({ manager: z.number().int(), worker: z.number().int(), reviewer: z.number().int() }),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** `setup.status` — tools, skills and extras at a glance. Read-only; runs `--version` only. */
export const setupStatusRpc = defineRpc({ name: "setup.status", input: z.object({}), output: setupStatusSchema });

/** `setup.install-tool` — runs the documented installer for a missing `br` or `bv`, after the user confirmed. */
export const setupInstallToolRpc = defineRpc({
  name: "setup.install-tool",
  /** `confirmed` must be `true`: the Setup screen sends it only after the user confirmed the exact command. */
  input: z.object({ tool: z.enum(["br", "bv"]), confirmed: z.literal(true) }),
  output: z.object({ command: z.string(), code: z.number().int(), tail: z.array(z.string()) }),
});

/** `roles.instructions` — a role's base instructions, the user's additions and the result. */
export const rolesInstructionsRpc = defineRpc({
  name: "roles.instructions",
  input: z.object({ role: setupRoleSchema }),
  output: z.object({ base: z.string(), extra: z.string(), full: z.string(), path: z.string().nullable(), maxChars: z.number().int() }),
});

/** `roles.save-extra` — replaces one role's additional instructions. Applies to agents created afterwards. */
export const rolesSaveExtraRpc = defineRpc({
  name: "roles.save-extra",
  input: z.object({ role: setupRoleSchema, text: z.string() }),
  output: z.object({ extra: z.string(), full: z.string() }),
});

/** One paseo-bm agent as a chat card needs it. */
export const chatPeerSchema = z.object({
  id: agentIdSchema,
  role: agentRoleSchema,
  title: z.string().nullable(),
  status: z.string(),
  parentId: z.string().nullable(),
  /** `bm.requestId` / `bm.batchId` labels. */
  requestId: z.string().nullable(),
  batchId: z.string().nullable(),
  /**
   * False when the agent has no `bm.role` label and was recognised by its
   * provider only (delta 20260918g §4.4). Defaults to true for older servers.
   */
  labelled: z.boolean().default(true),
});

/** One Worker waiting for the user's answer in a Manager's chat (delta 20260918d §4.8). */
export const waitingWorkerSchema = z.object({
  managerId: agentIdSchema,
  workspaceId: workspaceIdSchema,
  workerId: agentIdSchema,
  workerTitle: z.string().nullable(),
  requestId: z.string(),
  /** The report message as the Manager received it: the client builds the same card from it. */
  text: z.string(),
  at: z.string().nullable(),
});

export type WaitingWorker = z.infer<typeof waitingWorkerSchema>;

/**
 * `chat.waiting` — for every paseo-bm Manager, the idle Workers whose latest
 * report to it is `blocked` with a `BM-QUESTIONS` block (delta 20260918d §4.8,
 * REQ-059 j). Read-only.
 */
export const chatWaitingRpc = defineRpc({
  name: "chat.waiting",
  input: z.object({}),
  output: z.object({ waiting: z.array(waitingWorkerSchema) }),
});

/**
 * `chat.peers` — the paseo-bm agent that owns a chat and the other paseo-bm
 * agents of its workspace (delta 20260916-chat-cards §4.3). Read-only.
 */
export const chatPeersRpc = defineRpc({
  name: "chat.peers",
  input: z.object({ agentId: agentIdSchema }),
  output: z.object({
    owner: chatPeerSchema.nullable(),
    peers: z.array(chatPeerSchema),
    /** The owner's workspace; null for an agent that is not paseo-bm's. */
    workspaceId: z.string().nullable(),
  }),
});


/** A Worker and the moment it did something to a bead. */
export const beadWorkMarkSchema = z.object({
  agentId: z.string().min(1),
  at: z.string(),
  /** The agent's title in Paseo; null when Paseo no longer lists the agent. */
  title: z.string().nullable(),
  /** The agent's status now (`running`, `idle`, …); null when it is gone. */
  status: z.string().nullable(),
});

/**
 * Who is working on an `in_progress` bead, from the trace store. `started` is
 * the Worker command that moved the bead to `in_progress`; `last` is the latest
 * Worker command or report that named the bead. Either can be unknown.
 */
export const beadWorkSchema = z.object({
  started: beadWorkMarkSchema.nullable(),
  last: beadWorkMarkSchema.nullable(),
});

export const beadRowSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  status: z.string(),
  issueType: z.string(),
  /** 0 (highest) to 4; null when the store has none. */
  priority: z.number().int().nullable(),
  labels: z.array(z.string()),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  /** Derived like `br ready`: open, every blocker closed, not an epic. */
  ready: z.boolean(),
  parentId: z.string().nullable(),
  /** Only for `in_progress` beads; null when nothing was recorded. */
  work: beadWorkSchema.nullable(),
});

export const beadDetailSchema = beadRowSchema.extend({
  description: z.string().nullable(),
  closeReason: z.string().nullable(),
  blockedBy: z.array(z.string()),
  children: z.array(z.string()),
});

/** `beads.list` — every bead of a workspace, read from `.beads/issues.jsonl`. */
export const beadsListRpc = defineRpc({
  name: "beads.list",
  input: z.object({ workspaceId: workspaceIdSchema }),
  output: z.object({ beads: z.array(beadRowSchema), stats: beadStatsSchema }),
});

/** `beads.get` — one bead in full; an unknown id fails `E_BEAD_NOT_FOUND`. */
export const beadsGetRpc = defineRpc({
  name: "beads.get",
  input: z.object({ workspaceId: workspaceIdSchema, id: z.string().min(1) }),
  output: z.object({ bead: beadDetailSchema }),
});

export const beadActionSchema = z.enum(["implement", "delete", "close"]);

/**
 * `beads.action` — hands a bead to the workspace's Manager, which delegates it
 * to a Worker. The plugin itself never writes the bead store.
 */
export const beadsActionRpc = defineRpc({
  name: "beads.action",
  input: z.object({ workspaceId: workspaceIdSchema, id: z.string().min(1), action: beadActionSchema }),
  output: z.object({ managerId: z.string(), created: z.boolean() }),
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

export type BeadRow = z.infer<typeof beadRowSchema>;
/** Input shape: `labelled` may be absent (meaning labelled), as from a server older than delta 20260918g. */
export type ChatPeer = z.input<typeof chatPeerSchema>;
export type BeadWork = z.infer<typeof beadWorkSchema>;
export type BeadDetail = z.infer<typeof beadDetailSchema>;
export type BeadAction = z.infer<typeof beadActionSchema>;

export type Confidence = z.infer<typeof confidenceSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type TraceState = z.infer<typeof traceStateSchema>;
export type Tier = z.infer<typeof tierSchema>;
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type GuardrailReport = z.infer<typeof guardrailReportSchema>;
export type TraceSummary = z.infer<typeof traceSummarySchema>;
export type TraceDetail = z.infer<typeof traceDetailSchema>;
export type TraceMessage = z.infer<typeof traceMessageSchema>;
export type AgentTiming = z.infer<typeof agentTimingSchema>;
export type TurnTiming = z.infer<typeof turnTimingSchema>;
export type ParsedReport = z.infer<typeof parsedReportSchema>;
export type ParsedReview = z.infer<typeof parsedReviewSchema>;
export type ReportPhase = z.infer<typeof reportPhaseSchema>;
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepResult = z.infer<typeof workflowStepResultSchema>;
export type TraceBead = z.infer<typeof traceBeadSchema>;
export type SubAgentTrace = z.infer<typeof subAgentTraceSchema>;
export type BeadStats = z.infer<typeof beadStatsSchema>;
export type StoreSize = z.infer<typeof storeSizeSchema>;
export type TraceRecord = z.infer<typeof traceRecordSchema>;
export type TraceRuntime = z.infer<typeof traceRuntimeSchema>;
export type RuntimeRow = z.infer<typeof runtimeRowSchema>;
export type TraceStoreMeta = z.infer<typeof traceStoreMetaSchema>;
export type TraceWorkspaceMeta = z.infer<typeof traceWorkspaceMetaSchema>;
export type TraceDeleteScope = z.infer<typeof traceDeleteScopeSchema>;

/** `beads.lookup` — the beads among `ids` that the workspace's bead store has. Read-only. */
export const beadsLookupRpc = defineRpc({
  name: "beads.lookup",
  input: z.object({ workspaceId: workspaceIdSchema, ids: z.array(z.string().min(1)).max(100) }),
  output: z.object({ beads: z.array(beadRowSchema) }),
});

/**
 * `chat.beads` — beads named in an agent's recent chat (messages and shell
 * commands), newest mention first. Read-only.
 */
export const chatBeadsRpc = defineRpc({
  name: "chat.beads",
  input: z.object({ workspaceId: workspaceIdSchema, agentId: agentIdSchema }),
  output: z.object({
    beads: z.array(z.object({ bead: beadRowSchema, mentions: z.number().int(), lastMentionedAt: z.string().nullable() })),
    scannedItems: z.number().int(),
  }),
});
