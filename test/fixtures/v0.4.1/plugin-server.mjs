/* eslint-disable */
// GENERATED FIXTURE — do not edit by hand.
//
// The server code of paseo-bm-plugin 0.4.1 (git tag v0.4.1, commit
// 5a97d1d94daf51a83edcedb0c4e66a851335882b), bundled so the compatibility
// tests in test/plugin-orchestrator-compat.test.ts run the code a downgraded
// user runs, not a copy of today's (orchestrator design §10, §11). A CI
// checkout has no tags, so the tests cannot read it from git themselves.
//
// Regenerate (from the repository root; zod and @getpaseo/* stay external):
//   mkdir -p /tmp/v041 && git archive v0.4.1 plugin | tar -x -C /tmp/v041
//   ln -s "$PWD/node_modules" /tmp/v041/node_modules
//   # /tmp/v041/entry.ts holds the export lines listed below
//   node_modules/.bin/esbuild /tmp/v041/entry.ts --bundle --platform=node --format=esm \
//     --external:zod '--external:@getpaseo/*' --banner:js="<this header>" \
//     --outfile=test/fixtures/v0.4.1/plugin-server.mjs
//
// entry.ts:
//   export { handleRolesSaveSettings, handleRolesSettings, roleSettingsRevision } from "./plugin/server/role-settings-rpc";
//   export { readSetupState, updateSetupState } from "./plugin/server/setup-state";
//   export { readIncidents, updateIncidents } from "./plugin/server/fallback-state";
//   export { readRoleExtras, saveRoleExtra } from "./plugin/server/role-extras";
//   export { removeAllBmEntries } from "./plugin/server/config-writer";
//   export { forgetModes } from "./plugin/server/role-mode";
//   export { forgetModelCosts } from "./plugin/server/model-costs";
//   export { bmRoleSchema, fallbackIncidentSchema } from "./plugin/shared/contracts";

// plugin/server/config-writer.ts
import { createHash } from "node:crypto";

// plugin/shared/contracts.ts
import { defineRpc } from "@getpaseo/plugin";
import { z as z2 } from "zod";

// plugin/shared/prices.ts
import { z } from "zod";
var modelPriceSchema = z.object({
  inputUsdPerMTok: z.number().nonnegative(),
  cacheReadUsdPerMTok: z.number().nonnegative(),
  outputUsdPerMTok: z.number().nonnegative()
});
var MODEL_PRICES = {
  "claude-opus-5": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-opus-4-8": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-opus-4-7": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-opus-4-6": { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
  "claude-sonnet-5": { inputUsdPerMTok: 2, cacheReadUsdPerMTok: 0.2, outputUsdPerMTok: 10 },
  "claude-sonnet-4-6": { inputUsdPerMTok: 3, cacheReadUsdPerMTok: 0.3, outputUsdPerMTok: 15 },
  "claude-haiku-4-5": { inputUsdPerMTok: 1, cacheReadUsdPerMTok: 0.1, outputUsdPerMTok: 5 }
};
var PRICED_MODEL_IDS = Object.keys(MODEL_PRICES);

// plugin/shared/contracts.ts
var bmRoleSchema = z2.enum(["manager", "worker", "reviewer"]);
var workspaceIdSchema = z2.string().min(1);
var agentIdSchema = z2.string().min(1);
var managerEnsureRpc = defineRpc({
  name: "manager.ensure",
  input: z2.object({
    workspaceId: workspaceIdSchema
  }),
  output: z2.object({
    agentId: agentIdSchema,
    created: z2.boolean(),
    otherManagerIds: z2.array(agentIdSchema),
    /**
     * Why an existing Manager was not switched to its no-prompt mode, or `null`
     * (delta 20260918 §4.1). Added field: a client that does not know it drops it.
     */
    modeNotice: z2.string().nullable(),
    /**
     * Set when the Manager just created has no Paseo tools (delta 20260921
     * §4.2.4). Optional so an older server's answer still parses; the server
     * always sends it.
     */
    toolsNotice: z2.string().nullable().optional(),
    /**
     * What the user should know about this machine's setup: roles this call
     * created with defaults, and Paseo's agent-tools switch being off (design
     * §7.3, ADR-012 decision 4). Optional so an older server's answer still
     * parses; the server always sends it.
     */
    setupNotice: z2.string().nullable().optional()
  })
});
var agentRoleSchema = z2.enum(["manager", "worker", "reviewer", "unknown"]);
var agentNodeSchema = z2.object({
  id: agentIdSchema,
  role: agentRoleSchema,
  title: z2.string().nullable(),
  status: z2.string(),
  parentId: agentIdSchema.nullable(),
  updatedAt: z2.string(),
  /**
   * False when the agent has no valid `bm.role` label: its role came from its
   * provider, or it is an unlabelled descendant (delta 20260918g §4.4).
   * Defaults to true for older servers.
   */
  labelled: z2.boolean().default(true),
  /**
   * The agent that replaced this one after a fallback switch: its `bm.replacedBy`
   * label, else the replacement of a `switched` incident (delta 20260921
   * §4.4.8). Defaults to null for older servers.
   */
  replacedBy: z2.string().nullable().default(null)
});
var agentsListRpc = defineRpc({
  name: "agents.list",
  input: z2.object({
    workspaceId: workspaceIdSchema
  }),
  output: z2.object({
    agents: z2.array(agentNodeSchema)
  })
});
var roleDescriptorSchema = z2.object({
  role: bmRoleSchema,
  provider: z2.string(),
  model: z2.string(),
  paseoTools: z2.boolean(),
  instructionsPath: z2.string()
});
var rolesDescribeRpc = defineRpc({
  name: "roles.describe",
  input: z2.object({}),
  output: z2.object({
    roles: z2.array(roleDescriptorSchema)
  })
});
var confidenceSchema = z2.enum(["exact", "inferred", "unknown"]);
var evidenceSchema = z2.object({
  /** `skill`: the agent loaded an agent skill; `detail` is the skill name. */
  kind: z2.enum(["report", "shell", "file", "agent", "timeline", "skill"]),
  detail: z2.string(),
  agentId: agentIdSchema.nullable(),
  at: z2.string().nullable()
});
var usageSchema = z2.object({
  inputTokens: z2.number().int().nonnegative(),
  cachedInputTokens: z2.number().int().nonnegative(),
  outputTokens: z2.number().int().nonnegative(),
  costUsd: z2.number().nonnegative().nullable(),
  costBasis: z2.enum(["provider", "estimated", "unavailable"]),
  model: z2.string().nullable(),
  pricesUpdatedAt: z2.string().nullable()
});
var traceStateSchema = z2.enum([
  "running",
  "waiting_user",
  "completed",
  "stopped",
  "failed",
  "unknown"
]);
var tierSchema = z2.enum(["Small", "Medium", "Large"]);
var workspaceStateSchema = z2.enum(["live", "archived", "orphaned", "unknown"]);
var beadCountSchema = z2.object({
  count: z2.number().int().nonnegative(),
  confidence: confidenceSchema
});
var guardrailReportSchema = z2.object({
  batchId: z2.string().nullable(),
  batchReviews: z2.number().int().nonnegative().nullable(),
  batchMax: z2.number().int().nonnegative().nullable(),
  polish: z2.number().int().nonnegative().nullable(),
  polishMax: z2.number().int().nonnegative().nullable(),
  total: z2.number().int().nonnegative().nullable(),
  budget: z2.number().int().nonnegative().nullable(),
  userAllowedExtra: z2.number().int().nonnegative().nullable(),
  raw: z2.string()
});
var traceErrorsSchema = z2.object({
  /** Turns of **this row** that ended `failed`. */
  failedTurns: z2.number().int().nonnegative(),
  /**
   * Agents of the request left in Paseo's `error` status that have **no** failed
   * turn record in this trace — killed before the collector wrote one. Set on the
   * row that opens the request only, because it belongs to the request.
   */
  agentErrors: z2.number().int().nonnegative(),
  /**
   * Provider-plan incidents of this request whose turn still ended `completed`
   * (`signal: "completed"`: the turn ran and did nothing). An incident with
   * `signal: "failed"` came from a turn already counted in `failedTurns`. Set on
   * the row that opens the request only.
   */
  fallbacks: z2.number().int().nonnegative()
});
var traceSummarySchema = z2.object({
  traceId: z2.string().min(1),
  requestId: z2.string().nullable(),
  requestedAt: z2.string(),
  /** Null when no user turn was captured, so the screen says so rather than showing "". */
  excerpt: z2.string().nullable(),
  /**
   * Which turn of the request this row is, when the user asked more than once
   * (delta 20260917e §4.3). `null` for a request that was never followed up, so
   * those rows look exactly as they always did — no `lượt 1` noise.
   *
   * Rows of one request share a `traceId` on purpose: opening any of them leads
   * to the same request. The list key is the pair.
   */
  turn: z2.object({ index: z2.number().int().positive(), total: z2.number().int().positive() }).nullable(),
  state: traceStateSchema,
  workerIds: z2.array(agentIdSchema),
  reviewerIds: z2.array(agentIdSchema),
  reviewCalls: z2.number().int().nonnegative().nullable(),
  guardrailReported: guardrailReportSchema.nullable(),
  durationMs: z2.number().int().nonnegative().nullable(),
  usage: usageSchema,
  /** Messages sent and received by the request's agents, for the overview. */
  messageCount: z2.number().int().nonnegative(),
  /** Messages the user typed directly to one of the request's agents. */
  userMessageCount: z2.number().int().nonnegative(),
  /** Tokens and cost per Worker of this request, for the "heaviest Workers" chart. */
  workerUsage: z2.array(z2.object({ agentId: agentIdSchema, title: z2.string().nullable(), usage: usageSchema })),
  /**
   * Tokens and cost per (role, model the agents ran), for the overview's
   * "model × role" chart (delta 20260918 §4.3, REQ-058e). Always sent by this
   * server; optional so an older payload still parses.
   */
  usageByModelRole: z2.array(z2.object({ role: agentRoleSchema, model: z2.string().nullable(), usage: usageSchema })).optional(),
  /**
   * Errors of this row (delta 20260925 §3.4). Optional so a payload written
   * before it still parses; a reader without it counts no errors.
   */
  errors: traceErrorsSchema.optional(),
  beadCounts: z2.object({
    created: beadCountSchema,
    updated: beadCountSchema,
    closed: beadCountSchema,
    ready: beadCountSchema
  }),
  tier: tierSchema.nullable(),
  linking: confidenceSchema,
  agentsMissing: z2.array(agentIdSchema),
  workspaceState: workspaceStateSchema,
  reassignedFrom: workspaceIdSchema.nullable(),
  notices: z2.array(z2.string())
});
var reportPhaseSchema = z2.enum([
  "received",
  "documents-done",
  "beads-done",
  "bead-implemented",
  "blocked",
  "finished"
]);
var parsedReportSchema = z2.object({
  agentId: agentIdSchema,
  at: z2.string(),
  requestId: z2.string().nullable(),
  phase: reportPhaseSchema.nullable(),
  tier: tierSchema.nullable(),
  filesChanged: z2.array(z2.string()),
  beadsCreated: z2.array(z2.string()),
  beadsUpdated: z2.array(z2.string()),
  beadsClosed: z2.array(z2.string()),
  beadsReady: z2.array(z2.string()),
  reviewFindingsOpen: z2.string().nullable(),
  buildAndTests: z2.string().nullable(),
  /** Skills the Worker loaded for the request (delta 20260917 §4.9); defaulted for older records. */
  skillsUsed: z2.array(z2.string()).default([]),
  /**
   * Choices the Worker made on its own, for the user to overturn (design delta
   * 20260924-instruction-quality, owner decision P2-2). Absent in reports
   * written before the field existed.
   */
  decided: z2.array(z2.string()).optional(),
  blockers: z2.string().nullable(),
  guardrail: guardrailReportSchema.nullable(),
  unparsedFields: z2.array(z2.string()),
  /**
   * Bead-id list fields the parser could not fully read (delta 20260917 §5.1):
   * their ids are a lower bound. Defaulted so records written before the field
   * existed still pass `traceRecordSchema` (the store drops undeclared keys).
   */
  incompleteFields: z2.array(z2.string()).default([])
});
var parsedReviewSchema = z2.object({
  agentId: agentIdSchema,
  at: z2.string(),
  batchId: z2.string().nullable(),
  verdict: z2.string().nullable(),
  blockingCount: z2.number().int().nonnegative().nullable()
});
var traceMessageSchema = z2.object({
  agentId: agentIdSchema.nullable(),
  at: z2.string(),
  text: z2.string(),
  truncated: z2.boolean(),
  /**
   * Who wrote an inbound message: `user` when Paseo's app sent it (the
   * timeline item carries `clientMessageId`), `agent` when another agent sent
   * it with `send_agent_prompt`. Absent on records written before this field
   * existed — never read that as "user".
   */
  origin: z2.enum(["user", "agent"]).optional()
});
var agentTimingSchema = z2.object({
  agentId: agentIdSchema,
  role: agentRoleSchema,
  startedAt: z2.string().nullable(),
  lastActivityAt: z2.string().nullable(),
  ms: z2.number().int().nonnegative().nullable(),
  state: traceStateSchema
});
var turnTimingSchema = z2.object({
  turnId: z2.string().nullable(),
  startedAt: z2.string().nullable(),
  endedAt: z2.string().nullable(),
  ms: z2.number().int().nonnegative().nullable()
});
var workflowStepSchema = z2.enum([
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
  "close_with_evidence"
]);
var workflowStepResultSchema = z2.object({
  step: workflowStepSchema,
  status: z2.enum(["done", "skipped", "unknown"]),
  confidence: confidenceSchema,
  evidence: z2.array(evidenceSchema),
  note: z2.string().nullable()
});
var traceBeadSchema = z2.object({
  id: z2.string().min(1),
  title: z2.string().nullable(),
  statusNow: z2.string().nullable(),
  action: z2.enum(["created", "updated", "closed", "ready"]),
  confidence: confidenceSchema,
  evidence: z2.array(evidenceSchema)
});
var subAgentTraceSchema = z2.object({
  agentId: agentIdSchema,
  subAgentType: z2.string().nullable(),
  description: z2.string().nullable(),
  count: z2.number().int().nonnegative()
});
var runtimeRowSchema = z2.object({
  model: z2.string().nullable(),
  thinkingOptionId: z2.string().nullable(),
  modeId: z2.string().nullable(),
  recorded: z2.boolean(),
  turns: z2.number().int().positive()
});
var traceDetailSchema = traceSummarySchema.extend({
  sent: z2.object({
    userRequest: traceMessageSchema.nullable(),
    workerInitialPrompts: z2.array(traceMessageSchema),
    reviewRequests: z2.array(traceMessageSchema.extend({ batchId: z2.string().nullable() }))
  }),
  received: z2.object({
    reports: z2.array(parsedReportSchema),
    reviews: z2.array(parsedReviewSchema),
    managerReplies: z2.array(traceMessageSchema)
  }),
  timing: z2.object({
    totalMs: z2.number().int().nonnegative().nullable(),
    managerTurns: z2.array(turnTimingSchema),
    workers: z2.array(agentTimingSchema),
    reviewers: z2.array(agentTimingSchema),
    basis: z2.string()
  }),
  usageByAgent: z2.array(
    z2.object({
      agentId: agentIdSchema,
      role: agentRoleSchema,
      usage: usageSchema,
      /** What this agent ran on, one row per distinct combination (delta 20260918 §4.3). */
      runtime: z2.array(runtimeRowSchema).optional()
    })
  ),
  /** Tokens and cost per model the agents actually ran (delta 20260918 §4.3, REQ-058d). */
  usageByModel: z2.array(z2.object({ model: z2.string().nullable(), usage: usageSchema })).optional(),
  beads: z2.array(traceBeadSchema),
  workflowSteps: z2.array(workflowStepResultSchema),
  subAgentTraces: z2.array(subAgentTraceSchema),
  /** Messages the user typed directly to an agent of this request, oldest first. */
  userMessages: z2.array(traceMessageSchema),
  /** Skills each agent loaded, oldest first. */
  skills: z2.array(z2.object({ agentId: agentIdSchema, skill: z2.string(), at: z2.string().nullable() }))
});
var beadStatsSchema = z2.object({
  total: z2.number().int().nonnegative(),
  open: z2.number().int().nonnegative(),
  inProgress: z2.number().int().nonnegative(),
  blocked: z2.number().int().nonnegative(),
  closed: z2.number().int().nonnegative(),
  ready: z2.number().int().nonnegative(),
  readAt: z2.string(),
  source: z2.string(),
  skippedLines: z2.number().int().nonnegative(),
  present: z2.boolean()
});
var storeSizeSchema = z2.object({
  bytes: z2.number().int().nonnegative(),
  workspaceBytes: z2.number().int().nonnegative()
});
var traceStoreMetaSchema = z2.object({
  schemaVersion: z2.number().int().positive(),
  createdAt: z2.string(),
  updatedAt: z2.string()
});
var traceWorkspaceMetaSchema = z2.object({
  lastKnownName: z2.string().nullable(),
  lastKnownDirectory: z2.string().nullable(),
  lastSeenAt: z2.string()
});
var traceRuntimeSchema = z2.object({
  model: z2.string().nullable(),
  thinkingOptionId: z2.string().nullable(),
  modeId: z2.string().nullable(),
  provider: z2.string().nullable().optional()
});
var traceRecordSchema = z2.object({
  v: z2.number().int().positive(),
  kind: z2.literal("turn"),
  at: z2.string(),
  workspaceId: workspaceIdSchema,
  agentId: agentIdSchema,
  role: agentRoleSchema,
  turnId: z2.string().nullable(),
  requestId: z2.string().nullable(),
  parentAgentId: agentIdSchema.nullable(),
  agentCreatedAt: z2.string().nullable(),
  startedAt: z2.string().nullable(),
  endedAt: z2.string(),
  outcome: z2.enum(["completed", "failed", "canceled"]),
  sent: z2.array(traceMessageSchema),
  received: z2.array(traceMessageSchema),
  reports: z2.array(parsedReportSchema),
  reviews: z2.array(parsedReviewSchema),
  evidence: z2.array(evidenceSchema),
  usage: usageSchema.nullable(),
  /**
   * Added by delta 20260918 — optional, so records written before it (and
   * readers built before it) keep working: `v` stays 1, nothing migrates. `null`
   * when the snapshot could not be read for this turn.
   */
  runtime: traceRuntimeSchema.nullable().optional()
});
var DashboardError = class extends Error {
  constructor(code, detail2, options) {
    super(`${code}: ${detail2}`, options);
    this.name = "DashboardError";
    this.code = code;
  }
};
var TRACE_LIST_LIMIT = 50;
var tracesListRpc = defineRpc({
  name: "traces.list",
  input: z2.object({
    workspaceId: workspaceIdSchema,
    limit: z2.number().int().positive().max(TRACE_LIST_LIMIT).optional(),
    cursor: z2.string().min(1).optional()
  }),
  output: z2.object({
    traces: z2.array(traceSummarySchema),
    nextCursor: z2.string().nullable(),
    truncated: z2.boolean(),
    store: storeSizeSchema,
    notices: z2.array(z2.string())
  })
});
var tracesGetRpc = defineRpc({
  name: "traces.get",
  input: z2.object({
    workspaceId: workspaceIdSchema,
    traceId: z2.string().min(1)
  }),
  output: z2.object({
    trace: traceDetailSchema
  })
});
var traceDeleteScopeSchema = z2.union([
  z2.object({ traceId: z2.string().min(1) }),
  z2.object({ before: z2.string().min(1) }),
  z2.object({ allOfWorkspace: z2.literal(true) })
]);
var tracesDeleteRpc = defineRpc({
  name: "traces.delete",
  input: z2.object({
    workspaceId: workspaceIdSchema,
    scope: traceDeleteScopeSchema,
    dryRun: z2.boolean().optional()
  }),
  output: z2.object({
    deleted: z2.object({
      traces: z2.number().int().nonnegative(),
      bytes: z2.number().int().nonnegative(),
      /** Requests in scope that still have a running agent (REQ-054e). */
      running: z2.number().int().nonnegative()
    }),
    store: storeSizeSchema
  })
});
var tracesReassignRpc = defineRpc({
  name: "traces.reassign",
  input: z2.object({
    fromWorkspaceId: workspaceIdSchema,
    toWorkspaceId: workspaceIdSchema,
    dryRun: z2.boolean().optional()
  }),
  output: z2.object({
    moved: z2.object({
      traces: z2.number().int().nonnegative(),
      bytes: z2.number().int().nonnegative()
    }),
    store: storeSizeSchema
  })
});
var beadsStatsRpc = defineRpc({
  name: "beads.stats",
  input: z2.object({
    workspaceId: workspaceIdSchema
  }),
  output: z2.object({
    stats: beadStatsSchema
  })
});
var workspacesOverviewRpc = defineRpc({
  name: "workspaces.overview",
  input: z2.object({}),
  output: z2.object({
    workspaces: z2.array(
      z2.object({
        workspaceId: workspaceIdSchema,
        beads: z2.object({
          total: z2.number().int().nonnegative(),
          inProgress: z2.number().int().nonnegative(),
          blocked: z2.number().int().nonnegative(),
          ready: z2.number().int().nonnegative()
        }).nullable(),
        /** Kept for readers that predate `runningAgents`; equals `runningAgents.worker`. */
        runningWorkers: z2.number().int().nonnegative(),
        /** Running agents of this workspace, per role (delta 20260917e §4.2). */
        runningAgents: z2.object({
          manager: z2.number().int().nonnegative(),
          worker: z2.number().int().nonnegative(),
          reviewer: z2.number().int().nonnegative()
        })
      })
    )
  })
});
var agentsStopAllRpc = defineRpc({
  name: "agents.stop-all",
  input: z2.object({ workspaceId: workspaceIdSchema }),
  output: z2.object({
    workers: z2.number().int().nonnegative(),
    reviewers: z2.number().int().nonnegative(),
    skipped: z2.number().int().nonnegative()
  })
});
var answerMarksOutput = z2.object({
  /** Card keys (`answeredKey`) the user marked as answered, oldest first. */
  keys: z2.array(z2.string()),
  notices: z2.array(z2.string())
});
var answersMarksRpc = defineRpc({
  name: "answers.marks",
  input: z2.object({}),
  output: answerMarksOutput
});
var answersMarkRpc = defineRpc({
  name: "answers.mark",
  input: z2.object({ key: z2.string().min(1).max(400), marked: z2.boolean() }),
  output: answerMarksOutput
});
var setupRoleSchema = z2.enum(["manager", "worker", "reviewer"]);
var skillStateSchema = z2.enum(["ok", "missing", "broken"]);
var toolsSeenSchema = z2.object({
  state: z2.enum(["ok", "missing", "unknown"]),
  agentId: z2.string(),
  provider: z2.string(),
  at: z2.string()
});
var missingRequiredSchema = z2.object({
  claude: z2.number().int(),
  codex: z2.number().int(),
  pi: z2.number().int().optional(),
  opencode: z2.number().int().optional()
});
var setupStatusSchema = z2.object({
  tools: z2.array(
    z2.object({
      id: z2.enum(["br", "bv", "bd"]),
      name: z2.string(),
      purpose: z2.string(),
      required: z2.boolean(),
      path: z2.string().nullable(),
      version: z2.string().nullable(),
      latestKnown: z2.string().nullable(),
      installCommand: z2.string().nullable(),
      updateCommand: z2.string().nullable(),
      homepage: z2.string()
    })
  ),
  latestCheckedOn: z2.string(),
  /**
   * `pi` and `opencode` (delta 20260921 §4.2.6) are optional so a payload
   * from before them still parses; a client shows those columns only when
   * they are present.
   */
  skills: z2.object({
    checkedAt: z2.string(),
    dirs: z2.object({
      shared: z2.string(),
      claude: z2.string(),
      codex: z2.string(),
      pi: z2.string().optional(),
      opencode: z2.string().optional()
    }),
    skills: z2.array(
      z2.object({
        name: z2.string(),
        required: z2.boolean(),
        claude: skillStateSchema,
        codex: skillStateSchema,
        pi: skillStateSchema.optional(),
        opencode: skillStateSchema.optional(),
        problem: z2.string().nullable()
      })
    ),
    missingRequired: missingRequiredSchema,
    installCommand: z2.string()
  }),
  /**
   * Everything else about this machine's setup (0.4.0, design §7.13.5).
   *
   * Optional so an older server's answer still parses; the server always sends
   * it. Read-only: building it writes nothing and runs no third-party tool.
   */
  setup: z2.object({
    roles: z2.object({
      present: z2.array(setupRoleSchema),
      missing: z2.array(setupRoleSchema),
      created: z2.object({ at: z2.string(), roles: z2.array(setupRoleSchema), baseProvider: z2.string(), model: z2.string() }).nullable(),
      cleanedUpAt: z2.string().nullable()
    }),
    agentTools: z2.object({
      /** `null` when the configuration could not be read at all. */
      injectIntoAgents: z2.boolean().nullable(),
      setBy: z2.enum(["plugin", "installer"]).nullable()
    }),
    /**
     * One entry per distinct provider the three roles run on. Only the
     * sign-in boolean is ever taken from Paseo's diagnostic; paseo-bm never
     * runs a login command and never sees a credential (design §9).
     */
    logins: z2.array(
      z2.object({
        provider: z2.string(),
        roles: z2.array(setupRoleSchema),
        state: z2.enum(["logged-in", "logged-out", "unknown"]),
        loginCommand: z2.string().nullable(),
        guidance: z2.string().nullable()
      })
    ),
    skillsRun: z2.object({ at: z2.string(), command: z2.string(), code: z2.number().int(), outcome: z2.enum(["ok", "failed", "timeout"]) }).nullable(),
    dataHome: z2.object({
      path: z2.string().nullable(),
      source: z2.enum(["env", "pointer", "default"]).nullable(),
      reason: z2.string().nullable()
    }),
    install: z2.object({ kind: z2.enum(["installer-directory", "other"]), pluginPath: z2.string().nullable() })
  }).optional(),
  /** Characters of additional instructions per role; 0 when none. */
  extras: z2.object({ manager: z2.number().int(), worker: z2.number().int(), reviewer: z2.number().int() }),
  /**
   * The last Paseo-tools check of a new Manager and of a new Worker in this
   * plugin run, `null` when none ran (delta 20260921 §4.2.4). Optional: an
   * older server does not send it.
   */
  paseoTools: z2.object({ manager: toolsSeenSchema.nullable(), worker: toolsSeenSchema.nullable() }).optional()
});
var setupStatusRpc = defineRpc({ name: "setup.status", input: z2.object({}), output: setupStatusSchema });
var setupEnsureRolesRpc = defineRpc({
  name: "setup.ensure-roles",
  input: z2.object({ resume: z2.boolean().optional() }),
  output: z2.object({
    created: z2.array(setupRoleSchema),
    baseProvider: z2.string().nullable(),
    model: z2.string().nullable(),
    skipped: z2.literal("cleaned-up").nullable()
  })
});
var setupGrantAgentToolsRpc = defineRpc({
  name: "setup.grant-agent-tools",
  input: z2.object({ confirmed: z2.literal(true) }),
  output: z2.object({ injectIntoAgents: z2.literal(true), changed: z2.boolean() })
});
var setupInstallSkillsRpc = defineRpc({
  name: "setup.install-skills",
  input: z2.object({ confirmed: z2.literal(true) }),
  output: z2.object({
    command: z2.string(),
    code: z2.number().int(),
    tail: z2.array(z2.string()),
    missingBefore: missingRequiredSchema,
    missingAfter: missingRequiredSchema
  })
});
var setupCleanupRpc = defineRpc({
  name: "setup.cleanup",
  input: z2.object({ confirmed: z2.literal(true), deleteData: z2.boolean() }),
  output: z2.object({
    removedProviders: z2.array(z2.string()),
    removedProfiles: z2.array(z2.string()),
    agentTools: z2.enum(["restored", "left-on", "off"]),
    data: z2.object({ deleted: z2.array(z2.string()), kept: z2.array(z2.string()) }).nullable(),
    nextCommand: z2.literal("paseo plugin remove paseo-bm")
  })
});
var setupInstallToolRpc = defineRpc({
  name: "setup.install-tool",
  /** `confirmed` must be `true`: the Setup screen sends it only after the user confirmed the exact command. */
  input: z2.object({ tool: z2.enum(["br", "bv"]), confirmed: z2.literal(true) }),
  output: z2.object({ command: z2.string(), code: z2.number().int(), tail: z2.array(z2.string()) })
});
var rolesInstructionsRpc = defineRpc({
  name: "roles.instructions",
  input: z2.object({ role: setupRoleSchema }),
  output: z2.object({ base: z2.string(), extra: z2.string(), full: z2.string(), path: z2.string().nullable(), maxChars: z2.number().int() })
});
var rolesSaveExtraRpc = defineRpc({
  name: "roles.save-extra",
  input: z2.object({ role: setupRoleSchema, text: z2.string() }),
  output: z2.object({ extra: z2.string(), full: z2.string() })
});
var providerCapabilitySchema = z2.enum(["tiered", "untiered", "none", "unknown"]);
var roleSettingSchema = z2.object({
  role: bmRoleSchema,
  providerId: z2.enum(["bm-manager", "bm-worker", "bm-reviewer"]),
  baseProvider: z2.string().nullable(),
  label: z2.string().nullable(),
  model: z2.string().nullable(),
  thinkingOptionId: z2.string().nullable(),
  modeId: z2.string().nullable(),
  featureValues: z2.record(z2.string(), z2.unknown()),
  capability: providerCapabilitySchema
});
var fallbackEntryInputSchema = z2.object({
  baseProvider: z2.string().min(1).max(200),
  model: z2.string().min(1).max(200),
  thinkingOptionId: z2.string().min(1).max(200).nullable(),
  modeId: z2.string().min(1).max(200).nullable()
});
var fallbackSettingsSchema = z2.object({
  role: bmRoleSchema,
  policy: z2.enum(["ask", "off", "auto"]),
  entries: z2.array(
    fallbackEntryInputSchema.extend({
      position: z2.number().int().min(1).max(3),
      alias: z2.string(),
      capability: providerCapabilitySchema,
      cost: modelPriceSchema.nullable()
    })
  ),
  patternsFromFile: z2.boolean()
});
var rolesSettingsRpc = defineRpc({
  name: "roles.settings",
  input: z2.object({}),
  output: z2.object({
    revision: z2.string(),
    roles: z2.array(roleSettingSchema),
    fallback: z2.object({
      manager: fallbackSettingsSchema.optional(),
      worker: fallbackSettingsSchema.optional(),
      reviewer: fallbackSettingsSchema.optional()
    }).nullable(),
    warnings: z2.array(z2.string()),
    /** The base providers Paseo reports as available (never a `bm-*` alias), for the Edit form's Provider picker. */
    providers: z2.array(z2.string())
  })
});
var roleModelOptionSchema = z2.object({
  id: z2.string(),
  label: z2.string(),
  thinkingOptions: z2.array(z2.object({ id: z2.string(), label: z2.string() })),
  defaultThinkingOptionId: z2.string().nullable(),
  cost: modelPriceSchema.nullable()
});
var roleModeOptionSchema = z2.object({
  id: z2.string(),
  label: z2.string(),
  colorTier: z2.string().nullable()
});
var rolesOptionsRpc = defineRpc({
  name: "roles.options",
  input: z2.object({ provider: z2.string().min(1) }),
  output: z2.object({
    provider: z2.string(),
    capability: providerCapabilitySchema,
    models: z2.array(roleModelOptionSchema),
    modes: z2.array(roleModeOptionSchema),
    autoAccept: z2.boolean()
  })
});
var rolesSaveSettingsRpc = defineRpc({
  name: "roles.save-settings",
  input: z2.object({
    revision: z2.string().min(1),
    role: bmRoleSchema,
    baseProvider: z2.string().min(1).max(200),
    model: z2.string().min(1).max(200),
    thinkingOptionId: z2.string().min(1).max(200).nullable(),
    modeId: z2.string().min(1).max(200).nullable()
  }),
  output: z2.object({
    revision: z2.string(),
    role: roleSettingSchema,
    warnings: z2.array(z2.string()),
    notified: z2.number().int()
  })
});
var rolesSaveFallbackRpc = defineRpc({
  name: "roles.save-fallback",
  input: z2.object({
    revision: z2.string().min(1),
    role: bmRoleSchema,
    /** `auto` (REQ-067, phase 2a-18): the plugin decides at once, by the same rules as the card's buttons. */
    policy: z2.enum(["ask", "off", "auto"]),
    entries: z2.array(fallbackEntryInputSchema).max(3)
  }),
  output: z2.object({
    revision: z2.string(),
    fallback: fallbackSettingsSchema,
    warnings: z2.array(z2.string())
  })
});
var fallbackIncidentSchema = z2.object({
  id: z2.string().regex(/^fb-[0-9a-f]{12}$/),
  role: bmRoleSchema,
  workspaceId: z2.string(),
  /** `null` for a Manager, which serves a workspace, not a request. */
  requestId: z2.string().nullable(),
  agentId: z2.string(),
  agentProvider: z2.string(),
  agentModel: z2.string().nullable(),
  /** The Worker of a Reviewer; the Manager of a Worker; `null` for a Manager. */
  parentId: z2.string().nullable(),
  /** The chat whose card shows the incident. */
  managerId: z2.string().nullable(),
  class: z2.enum(["L1", "L2", "L4", "L5"]),
  /** N1 (`failed`) or N2 (`completed`). */
  signal: z2.enum(["failed", "completed"]),
  message: z2.string().max(500),
  perModelWindow: z2.boolean(),
  resetsAt: z2.string().nullable(),
  candidate: fallbackEntryInputSchema.extend({ position: z2.number().int().min(1).max(3), alias: z2.string() }).nullable(),
  status: z2.enum(["pending", "switched", "waiting", "resumed", "dismissed", "exhausted", "expired", "failed"]),
  detectedAt: z2.string(),
  decidedAt: z2.string().nullable(),
  waitUntil: z2.string().nullable(),
  replacementId: z2.string().nullable(),
  error: z2.string().nullable()
});
var fallbackIncidentsRpc = defineRpc({
  name: "fallback.incidents",
  input: z2.object({ workspaceId: z2.string().min(1).optional(), ids: z2.array(z2.string().min(1)).max(200).optional() }),
  output: z2.object({ incidents: z2.array(fallbackIncidentSchema) })
});
var fallbackActRpc = defineRpc({
  name: "fallback.act",
  input: z2.object({ incidentId: z2.string().min(1), action: z2.enum(["switch", "wait", "dismiss", "resend"]) }),
  output: z2.object({ incident: fallbackIncidentSchema })
});
var FALLBACK_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1e3;
var chatPeerSchema = z2.object({
  id: agentIdSchema,
  role: agentRoleSchema,
  title: z2.string().nullable(),
  status: z2.string(),
  parentId: z2.string().nullable(),
  /** `bm.requestId` / `bm.batchId` labels. */
  requestId: z2.string().nullable(),
  batchId: z2.string().nullable(),
  /**
   * False when the agent has no `bm.role` label and was recognised by its
   * provider only (delta 20260918g §4.4). Defaults to true for older servers.
   */
  labelled: z2.boolean().default(true),
  /** Archived in Paseo: never a recipient, since a message would bring it back (delta 20260918f F12). */
  archived: z2.boolean(),
  /**
   * A fallback agent took over from this one (`bm.replacedBy`, or the agent of
   * a `switched` incident, delta 20260921 §4.4.8): never the request's Worker
   * again. Defaults to false for older servers.
   */
  replaced: z2.boolean().default(false)
});
var waitingWorkerSchema = z2.object({
  managerId: agentIdSchema,
  workspaceId: workspaceIdSchema,
  workerId: agentIdSchema,
  workerTitle: z2.string().nullable(),
  requestId: z2.string(),
  /** The report message as the Manager received it: the client builds the same card from it. */
  text: z2.string(),
  at: z2.string().nullable(),
  /**
   * The report's questions the question–answer ledger holds an answer to
   * (design delta 20260924-qa-ledger §4.1); the card shows them answered and
   * the pill does not count them. Defaults to none for an older server.
   */
  answered: z2.array(z2.string()).default([])
});
var waitingFallbackSchema = z2.object({
  managerId: agentIdSchema,
  workspaceId: workspaceIdSchema,
  incident: fallbackIncidentSchema
});
var chatWaitingRpc = defineRpc({
  name: "chat.waiting",
  input: z2.object({}),
  output: z2.object({ waiting: z2.array(waitingWorkerSchema), fallback: z2.array(waitingFallbackSchema).default([]) })
});
var chatPeersRpc = defineRpc({
  name: "chat.peers",
  input: z2.object({ agentId: agentIdSchema }),
  output: z2.object({
    owner: chatPeerSchema.nullable(),
    peers: z2.array(chatPeerSchema),
    /** The owner's workspace; null for an agent that is not paseo-bm's. */
    workspaceId: z2.string().nullable()
  })
});
var beadWorkMarkSchema = z2.object({
  agentId: z2.string().min(1),
  at: z2.string(),
  /** The agent's title in Paseo; null when Paseo no longer lists the agent. */
  title: z2.string().nullable(),
  /** The agent's status now (`running`, `idle`, …); null when it is gone. */
  status: z2.string().nullable()
});
var beadWorkSchema = z2.object({
  started: beadWorkMarkSchema.nullable(),
  last: beadWorkMarkSchema.nullable()
});
var beadRowSchema = z2.object({
  id: z2.string().min(1),
  title: z2.string().nullable(),
  status: z2.string(),
  issueType: z2.string(),
  /** 0 (highest) to 4; null when the store has none. */
  priority: z2.number().int().nullable(),
  labels: z2.array(z2.string()),
  createdAt: z2.string().nullable(),
  updatedAt: z2.string().nullable(),
  closedAt: z2.string().nullable(),
  /** Derived like `br ready`: open, every blocker closed, not an epic. */
  ready: z2.boolean(),
  parentId: z2.string().nullable(),
  /** Only for `in_progress` beads; null when nothing was recorded. */
  work: beadWorkSchema.nullable()
});
var beadDetailSchema = beadRowSchema.extend({
  description: z2.string().nullable(),
  closeReason: z2.string().nullable(),
  blockedBy: z2.array(z2.string()),
  children: z2.array(z2.string())
});
var beadsListRpc = defineRpc({
  name: "beads.list",
  input: z2.object({ workspaceId: workspaceIdSchema }),
  output: z2.object({ beads: z2.array(beadRowSchema), stats: beadStatsSchema })
});
var beadsGetRpc = defineRpc({
  name: "beads.get",
  input: z2.object({ workspaceId: workspaceIdSchema, id: z2.string().min(1) }),
  output: z2.object({ bead: beadDetailSchema })
});
var beadActionSchema = z2.enum(["implement", "delete", "close"]);
var beadsActionRpc = defineRpc({
  name: "beads.action",
  input: z2.object({ workspaceId: workspaceIdSchema, id: z2.string().min(1), action: beadActionSchema }),
  output: z2.object({ managerId: z2.string(), created: z2.boolean() })
});
var tracesWorkspacesRpc = defineRpc({
  name: "traces.workspaces",
  input: z2.object({}),
  output: z2.object({
    workspaces: z2.array(
      z2.object({
        workspaceId: workspaceIdSchema,
        state: workspaceStateSchema,
        lastKnownName: z2.string().nullable(),
        lastKnownDirectory: z2.string().nullable(),
        lastSeenAt: z2.string().nullable(),
        bytes: z2.number().int().nonnegative()
      })
    )
  })
});
var beadsLookupRpc = defineRpc({
  name: "beads.lookup",
  input: z2.object({ workspaceId: workspaceIdSchema, ids: z2.array(z2.string().min(1)).max(100) }),
  output: z2.object({ beads: z2.array(beadRowSchema) })
});
var chatBeadsRpc = defineRpc({
  name: "chat.beads",
  input: z2.object({ workspaceId: workspaceIdSchema, agentId: agentIdSchema }),
  output: z2.object({
    beads: z2.array(z2.object({ bead: beadRowSchema, mentions: z2.number().int(), lastMentionedAt: z2.string().nullable() })),
    scannedItems: z2.number().int()
  })
});

// plugin/server/config-writer.ts
var ROLE_PROFILE_IDS = ["bm-manager", "bm-worker", "bm-reviewer"];
var isBmId = (id) => id.startsWith("bm-");
function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}
function roleConfigRevision(config) {
  const providers = {};
  const all = config.providers;
  if (all !== null && typeof all === "object" && !Array.isArray(all)) {
    for (const [id, entry] of Object.entries(all)) if (isBmId(id)) providers[id] = entry;
  }
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  return createHash("sha256").update(canonicalJson({ providers, profiles })).digest("hex");
}
async function readRoleConfig(paseo) {
  const { config } = await paseo.config.get();
  return { revision: roleConfigRevision(config ?? {}), config: config ?? {} };
}
var queue = Promise.resolve();
function serialised(work) {
  const run2 = queue.then(work, work);
  queue = run2.catch(() => void 0);
  return run2;
}
function invalid(detail2) {
  return new DashboardError("E_ROLE_SETTINGS_INVALID", detail2);
}
function checkScope(write, config) {
  const providers = config.providers ?? {};
  for (const id of [...Object.keys(write.providers ?? {}), ...write.removeProviders ?? []]) {
    if (!isBmId(id)) throw invalid(`the plugin only writes bm-* providers, not "${id}"`);
  }
  for (const id of Object.keys(write.providers ?? {})) {
    if (ROLE_PROFILE_IDS.includes(id) && !Object.prototype.hasOwnProperty.call(providers, id)) {
      throw invalid(`provider "${id}" is not registered; open Beads Manager \u2192 Setup, which creates it`);
    }
  }
  for (const id of write.removeProviders ?? []) {
    if (ROLE_PROFILE_IDS.includes(id)) throw invalid(`provider "${id}" is a main role; only "Remove paseo-bm's settings" on Setup removes it`);
  }
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  for (const id of Object.keys(write.profiles ?? {})) {
    if (!ROLE_PROFILE_IDS.includes(id)) throw invalid(`the plugin only edits the bm-manager, bm-worker and bm-reviewer profiles, not "${id}"`);
    if (!profiles.some((entry) => entry?.id === id)) throw invalid(`profile "${id}" is not registered; open Beads Manager \u2192 Setup, which creates it`);
  }
}
function patchedProfiles(read, edits) {
  return read.map((entry) => {
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (id === null || !Object.prototype.hasOwnProperty.call(edits, id)) return entry;
    const next = { ...entry };
    for (const [key, value] of Object.entries(edits[id])) {
      if (value === null || value === void 0) delete next[key];
      else next[key] = value;
    }
    return next;
  });
}
function contains(actual, wanted) {
  if (wanted !== null && typeof wanted === "object" && !Array.isArray(wanted)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(wanted).every(([key, value]) => contains(actual[key], value));
  }
  return canonicalJson(actual) === canonicalJson(wanted);
}
function missingFromReadBack(write, after) {
  const missing = [];
  const providers = after.providers ?? {};
  for (const [id, entry] of Object.entries(write.providers ?? {})) {
    if (!contains(providers[id], entry)) missing.push(`provider ${id}`);
  }
  for (const id of write.removeProviders ?? []) {
    if (Object.prototype.hasOwnProperty.call(providers, id)) missing.push(`removal of provider ${id}`);
  }
  const profiles = Array.isArray(after.agentProfiles) ? after.agentProfiles : [];
  for (const [id, edits] of Object.entries(write.profiles ?? {})) {
    const profile = profiles.find((entry) => entry?.id === id);
    const ok = profile !== void 0 && Object.entries(edits).every(
      ([key, value]) => value === null || value === void 0 ? !Object.prototype.hasOwnProperty.call(profile, key) : contains(profile[key], value)
    );
    if (!ok) missing.push(`profile ${id}`);
  }
  return missing;
}
function writeRoleConfig(paseo, write) {
  return serialised(async () => {
    const { revision, config } = await readRoleConfig(paseo);
    if (revision !== write.expectedRevision) {
      throw new DashboardError("E_ROLE_SETTINGS_CONFLICT", "the configuration changed elsewhere; reopen Roles & models");
    }
    checkScope(write, config);
    const read = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
    const patch = {};
    if (write.providers !== void 0 && Object.keys(write.providers).length > 0) patch.providers = write.providers;
    if (write.removeProviders !== void 0 && write.removeProviders.length > 0) patch.removeProviders = [...write.removeProviders];
    if (write.profiles !== void 0 && Object.keys(write.profiles).length > 0) patch.agentProfiles = patchedProfiles(read, write.profiles);
    if (Object.keys(patch).length === 0) return { revision, config };
    try {
      await paseo.config.patch(patch);
    } catch (error) {
      throw new DashboardError("E_ROLE_SETTINGS_WRITE_FAILED", error instanceof Error ? error.message : String(error), { cause: error });
    }
    const after = await readRoleConfig(paseo);
    const missing = missingFromReadBack(write, after.config);
    if (missing.length > 0) {
      throw new DashboardError("E_ROLE_SETTINGS_WRITE_FAILED", `Paseo did not keep the saved values (${missing.join(", ")})`);
    }
    return { revision: after.revision, config: after.config };
  });
}
function agentToolsIn(config) {
  return config.mcp?.injectIntoAgents === true;
}
function removeAllBmEntries(paseo, restoreAgentTools) {
  return serialised(async () => {
    const failed = (detail2, cause) => new DashboardError("E_SETUP_WRITE_FAILED", detail2, cause === void 0 ? void 0 : { cause });
    const { revision, config } = await readRoleConfig(paseo);
    const providers = config.providers ?? {};
    const read = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
    const removedProviders = Object.keys(providers).filter(isBmId);
    const removedProfiles = read.map((entry) => typeof entry?.id === "string" ? entry.id : "").filter(isBmId);
    const patch = {};
    if (removedProviders.length > 0) patch.removeProviders = removedProviders;
    if (removedProfiles.length > 0) patch.agentProfiles = read.filter((entry) => !isBmId(String(entry?.id ?? "")));
    if (restoreAgentTools !== null) patch.mcp = { injectIntoAgents: restoreAgentTools };
    if (Object.keys(patch).length === 0) return { revision, config, removedProviders, removedProfiles };
    try {
      await paseo.config.patch(patch);
    } catch (error) {
      throw failed(error instanceof Error ? error.message : String(error), error);
    }
    const after = await readRoleConfig(paseo);
    const left = Object.keys(after.config.providers ?? {}).filter(isBmId);
    const leftProfiles = (Array.isArray(after.config.agentProfiles) ? after.config.agentProfiles : []).map((entry) => String(entry?.id ?? "")).filter(isBmId);
    const problems = [...left.map((id) => `provider ${id}`), ...leftProfiles.map((id) => `profile ${id}`)];
    if (restoreAgentTools !== null && agentToolsIn(after.config) !== restoreAgentTools) {
      problems.push(`the agent tools switch (asked for ${restoreAgentTools})`);
    }
    if (problems.length > 0) throw failed(`Paseo kept ${problems.join(", ")}`);
    return { revision: after.revision, config: after.config, removedProviders, removedProfiles };
  });
}

// plugin/server/fallback-settings.ts
import { readFileSync as readFileSync5 } from "node:fs";
import { join as join6 } from "node:path";
import { z as z5 } from "zod";

// plugin/server/data-home.ts
import { lstatSync, mkdirSync, readFileSync as nodeReadFileSync } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
var TRACES_DIR_NAME = "traces";
var UI_DIR_NAME = "ui";
var DATA_HOME_ENV_VAR = "PASEO_BM_HOME";
var DEFAULT_DATA_DIR_NAME = ".paseo-bm";
var POINTER_FILE_NAME = "home.json";
var SUPPORTED_POINTER_SCHEMA_VERSION = 1;
var DATA_HOME_MODE = 448;
var DataHomeError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DataHomeError";
  }
};
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function isWithin(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedRoot === resolvedCandidate) return true;
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
function contains2(ancestor, descendant) {
  return resolve(ancestor) !== resolve(descendant) && isWithin(ancestor, descendant);
}
function pickEnv(env, name) {
  const value = env[name];
  if (value === void 0) return void 0;
  return value.trim().length === 0 ? void 0 : value;
}
var PROTECTED_DIRS = [
  ["Paseo home", "PASEO_HOME", ".paseo"],
  ["Claude Code home", "CLAUDE_CONFIG_DIR", ".claude"],
  ["Codex home", "CODEX_HOME", ".codex"],
  ["shared agent home", null, ".agents"]
];
function unsafeDataHomeReason(target, homeDir, env) {
  const resolvedTarget = resolve(target);
  const resolvedHome = resolve(homeDir);
  if (resolvedTarget === resolvedHome || contains2(resolvedTarget, resolvedHome)) {
    return `refusing to use ${resolvedTarget} as the data folder: it is the home directory or contains it`;
  }
  for (const [label, envVar, dirName] of PROTECTED_DIRS) {
    const candidates = [resolve(resolvedHome, dirName)];
    const override = envVar === null ? void 0 : pickEnv(env, envVar);
    if (override !== void 0 && isAbsolute(override)) candidates.push(resolve(override));
    for (const dir of candidates) {
      if (resolvedTarget === dir || contains2(resolvedTarget, dir) || contains2(dir, resolvedTarget)) {
        return `refusing to use ${resolvedTarget} as the data folder: it overlaps the ${label} at ${dir}`;
      }
    }
  }
  return null;
}
function readPointer(pointerPath, readFile2) {
  let raw;
  try {
    raw = readFile2(pointerPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "error", reason: `cannot read the data folder pointer ${pointerPath}: ${message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "error", reason: `the data folder pointer ${pointerPath} is not valid JSON` };
  }
  const record = asRecord(parsed);
  const schemaVersion = record?.["schemaVersion"];
  if (schemaVersion !== SUPPORTED_POINTER_SCHEMA_VERSION) {
    return {
      kind: "error",
      reason: `the data folder pointer ${pointerPath} has schemaVersion ${JSON.stringify(schemaVersion)}, not ${SUPPORTED_POINTER_SCHEMA_VERSION}`
    };
  }
  const home = record?.["home"];
  if (typeof home !== "string" || home.trim().length === 0 || !isAbsolute(home)) {
    return {
      kind: "error",
      reason: `the data folder pointer ${pointerPath} has no absolute "home": ${JSON.stringify(home)}`
    };
  }
  return { kind: "home", home };
}
function resolveDataHome(deps = {}) {
  const env = deps.env ?? process.env;
  const readFile2 = deps.readFileSync ?? nodeReadFileSync;
  const homeDir = resolve((deps.homedir ?? nodeHomedir)());
  const defaultHome = resolve(homeDir, DEFAULT_DATA_DIR_NAME);
  const unavailable2 = (reason) => ({ home: null, tracesDir: null, reason });
  const found = (home, source) => ({
    home,
    tracesDir: join(home, TRACES_DIR_NAME),
    source
  });
  const fromEnv = pickEnv(env, DATA_HOME_ENV_VAR);
  if (fromEnv !== void 0) {
    if (!isAbsolute(fromEnv)) {
      return unavailable2(`${DATA_HOME_ENV_VAR} must be an absolute path, got ${JSON.stringify(fromEnv)}`);
    }
    const target = resolve(fromEnv);
    const unsafe = unsafeDataHomeReason(target, homeDir, env);
    return unsafe === null ? found(target, "env") : unavailable2(unsafe);
  }
  const pointer = readPointer(join(defaultHome, POINTER_FILE_NAME), readFile2);
  if (pointer.kind === "error") return unavailable2(pointer.reason);
  if (pointer.kind === "home") {
    const target = resolve(pointer.home);
    if (target !== defaultHome) {
      const unsafe = unsafeDataHomeReason(target, homeDir, env);
      return unsafe === null ? found(target, "pointer") : unavailable2(unsafe);
    }
  }
  return found(defaultHome, "default");
}
function assertNoSymlinkOnPath(root, target) {
  const rootAbsolute = resolve(root);
  const targetAbsolute = resolve(target);
  const inspect = (path) => {
    try {
      return lstatSync(path).isSymbolicLink() ? "symlink" : "plain";
    } catch (error) {
      const code = error.code;
      if (code === "ENOENT" || code === "ENOTDIR") return "missing";
      throw new DataHomeError(`cannot inspect ${path}`, { cause: error });
    }
  };
  if (inspect(rootAbsolute) === "missing") return;
  if (targetAbsolute === rootAbsolute) return;
  let current = rootAbsolute;
  for (const part of relative(rootAbsolute, targetAbsolute).split(sep)) {
    if (part === "" || part === ".") continue;
    current = join(current, part);
    const found = inspect(current);
    if (found === "missing") return;
    if (found === "symlink") {
      throw new DataHomeError(`refusing to use a symlinked path for the data folder: ${current}`);
    }
  }
}
function ensureDataHome(home, deps = {}) {
  if (!isAbsolute(home)) {
    throw new DataHomeError(`the data folder must be an absolute path, got ${JSON.stringify(home)}`);
  }
  const target = resolve(home);
  const homeDir = resolve((deps.homedir ?? nodeHomedir)());
  const root = isWithin(homeDir, target) ? homeDir : dirname(target);
  assertNoSymlinkOnPath(root, target);
  try {
    mkdirSync(target, { recursive: true, mode: DATA_HOME_MODE });
  } catch (error) {
    throw new DataHomeError(`cannot create the data folder ${target}`, { cause: error });
  }
  assertNoSymlinkOnPath(root, target);
  return target;
}

// plugin/server/provider-id.ts
function providerId(provider) {
  if (typeof provider !== "string") return null;
  const slash = provider.indexOf("/");
  return slash === -1 ? provider : provider.slice(0, slash);
}

// plugin/server/role-mode.ts
var ROLE_GETS_MODE = { manager: false, worker: true, reviewer: true };
var LOOKUP_TIMEOUT_MS = 5e3;
var TIMED_OUT = /* @__PURE__ */ Symbol("paseo-bm lookup timed out");
async function withTimeout(work, ms = LOOKUP_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((resolve4) => {
        timer = setTimeout(() => resolve4(TIMED_OUT), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
var tierOf = (mode) => typeof mode.colorTier === "string" ? mode.colorTier.toLowerCase() : "";
var firstWithTier = (modes, tier) => modes.find((mode) => tierOf(mode) === tier)?.id;
function chooseModeId(role, modes, current, profileModeId) {
  if (!ROLE_GETS_MODE[role]) return void 0;
  const usable = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "");
  if (usable.length === 0) return void 0;
  const fromProfile = usable.find((mode) => mode.id === profileModeId);
  const profileSafe = fromProfile !== void 0 && tierOf(fromProfile) !== "dangerous" && tierOf(fromProfile) !== "planning";
  if (role === "worker") {
    if (current !== void 0) return void 0;
    if (fromProfile !== void 0) return fromProfile.id;
    return firstWithTier(usable, "dangerous") ?? firstWithTier(usable, "moderate") ?? firstWithTier(usable, "safe");
  }
  const reviewerMode = profileSafe ? fromProfile.id : usable.find((mode) => mode.id === "auto")?.id ?? usable.find((mode) => tierOf(mode) === "moderate" && !/full|network/i.test(`${mode.id} ${mode.label ?? ""} ${mode.description ?? ""}`))?.id ?? firstWithTier(usable, "safe");
  if (current === void 0) return reviewerMode;
  const chosen = usable.find((mode) => mode.id === current);
  if (chosen === void 0) return void 0;
  return tierOf(chosen) === "dangerous" || tierOf(chosen) === "planning" ? reviewerMode : void 0;
}
var nonEmpty = (value) => typeof value === "string" && value.trim() !== "" ? value : null;
async function profileOf(paseo, profileId, log = (message) => console.warn(message)) {
  const get = paseo?.config?.get;
  if (typeof get !== "function") return null;
  try {
    const result = await withTimeout(
      get.call(paseo.config)
    );
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the ${profileId} profile took longer than ${LOOKUP_TIMEOUT_MS} ms; its own settings are ignored.`);
      return null;
    }
    const profile = result?.config?.agentProfiles?.find((entry) => entry?.id === profileId);
    if (profile === null || profile === void 0 || typeof profile !== "object") return null;
    const features = profile.featureValues;
    return {
      model: nonEmpty(profile.model),
      modeId: nonEmpty(profile.modeId),
      thinkingOptionId: nonEmpty(profile.thinkingOptionId),
      featureValues: features !== null && typeof features === "object" && !Array.isArray(features) && Object.keys(features).length > 0 ? { ...features } : null
    };
  } catch {
    return null;
  }
}
async function profileModeOf(paseo, profileId, log = (message) => console.warn(message)) {
  return (await profileOf(paseo, profileId, log))?.modeId ?? null;
}
var lastModes = /* @__PURE__ */ new Map();
function lastModesOf(provider) {
  return lastModes.get(provider) ?? null;
}
function forgetModes() {
  lastModes.clear();
}
async function modesFor(paseo, provider, log = (message) => console.warn(message), cwd) {
  const providers = paseo?.providers;
  const listModes = providers?.listModes;
  if (typeof listModes !== "function") {
    log(`[paseo-bm] this Paseo host cannot list provider modes; the mode of ${provider} is left to its creator.`);
    return null;
  }
  try {
    const call = cwd === void 0 ? listModes.call(providers, provider) : listModes.call(providers, provider, { cwd });
    const result = await withTimeout(call);
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the modes of ${provider} took longer than ${LOOKUP_TIMEOUT_MS} ms; its mode is left to its creator.`);
      return null;
    }
    const modes = Array.isArray(result?.modes) ? result.modes : [];
    const failure = typeof result?.error === "string" && result.error !== "" ? result.error : null;
    if (failure !== null || !Array.isArray(result?.modes)) {
      log(`[paseo-bm] could not read the modes of ${provider} (${failure ?? "no modes listed"}); its mode is left to its creator.`);
      return null;
    }
    if (modes.length === 0) return [];
    lastModes.set(provider, { modes, at: (/* @__PURE__ */ new Date()).toISOString() });
    return modes;
  } catch (error) {
    log(`[paseo-bm] could not read the modes of ${provider} (${error instanceof Error ? error.message : String(error)}); its mode is left to its creator.`);
    return null;
  }
}
function capabilityOf(modes) {
  if (modes === null) return "unknown";
  const usable = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "");
  if (usable.length === 0) return "none";
  return usable.some((mode) => tierOf(mode) !== "") ? "tiered" : "untiered";
}
var AUTO_APPROVE_FEATURE = "auto_accept";
function offersAutoApprove(features) {
  return Array.isArray(features) && features.some((feature) => feature?.type === "toggle" && feature.id === AUTO_APPROVE_FEATURE);
}
function runPostureOf(role, capability, modes, features, profileModeId, current = {}) {
  if (capability === "none") {
    const posture2 = {};
    if (current.modeId !== void 0) posture2.modeId = null;
    if (current.featureValues !== void 0) posture2.featureValues = null;
    return posture2;
  }
  if (capability !== "untiered") return void 0;
  const listed = modes.filter((mode) => typeof mode?.id === "string" && mode.id !== "").map((mode) => mode.id);
  const posture = {};
  const keep = current.modeId !== void 0 && listed.includes(current.modeId);
  if (!keep) {
    const modeId = profileModeId !== null && listed.includes(profileModeId) ? profileModeId : listed[0];
    if (modeId !== void 0) posture.modeId = modeId;
  }
  if (offersAutoApprove(features) || role === "reviewer") {
    const values = { ...current.featureValues ?? {} };
    const set = Object.prototype.hasOwnProperty.call(values, AUTO_APPROVE_FEATURE);
    if (role === "reviewer") {
      if (values[AUTO_APPROVE_FEATURE] !== false) {
        values[AUTO_APPROVE_FEATURE] = false;
        posture.featureValues = values;
      }
    } else if (!set) {
      values[AUTO_APPROVE_FEATURE] = true;
      posture.featureValues = values;
    }
  }
  return posture;
}

// plugin/shared/notices.ts
var REVIEWER_STOP_NOTICE_PREFIX = "STOP: The Beads Worker that created you was stopped";
var WORKER_STOP_NOTICE_MARKER = "BM-STOP";
var WORKER_STOP_NOTICE = `${WORKER_STOP_NOTICE_MARKER} The user asked every Beads Worker and Reviewer in this workspace to stop. This is a stop: follow your Stop rule.`;
var SETTINGS_NOTICE_MARKER = "BM-SETTINGS";

// plugin/server/model-costs.ts
var lists = /* @__PURE__ */ new Map();
function forgetModelCosts() {
  lists.clear();
}
var isRate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
function priceOfCost(cost) {
  if (cost === null || typeof cost !== "object") return null;
  const { input, output, cache } = cost;
  if (!isRate(input) || !isRate(output)) return null;
  const read = cache !== null && typeof cache === "object" ? cache.read : void 0;
  const parsed = modelPriceSchema.safeParse({
    inputUsdPerMTok: input,
    cacheReadUsdPerMTok: isRate(read) ? read : input,
    outputUsdPerMTok: output
  });
  return parsed.success ? parsed.data : null;
}
function parseModelList(answer) {
  const result = answer;
  if (typeof result?.error === "string" && result.error !== "") return { failure: result.error };
  if (!Array.isArray(result?.models)) return { failure: "no models listed" };
  const prices = /* @__PURE__ */ new Map();
  const aliases = [];
  for (const model of result.models) {
    if (model === null || typeof model !== "object") continue;
    const { id, aliases: names, metadata } = model;
    if (typeof id !== "string" || id === "") continue;
    const price = priceOfCost(metadata !== null && typeof metadata === "object" ? metadata.cost : void 0);
    if (price === null) continue;
    if (!prices.has(id)) prices.set(id, price);
    if (Array.isArray(names)) {
      for (const name of names) if (typeof name === "string" && name !== "") aliases.push([name, price]);
    }
  }
  for (const [name, price] of aliases) if (!prices.has(name)) prices.set(name, price);
  const fetchedAt = typeof result?.fetchedAt === "string" && result.fetchedAt !== "" ? result.fetchedAt : null;
  return { prices, readAt: fetchedAt ?? (/* @__PURE__ */ new Date()).toISOString() };
}
async function readModelList(paseo, provider, cwd) {
  const providers = paseo?.providers;
  const listModels = providers?.listModels;
  if (typeof listModels !== "function") return { failure: "this Paseo host cannot list models" };
  try {
    return parseModelList(
      await (cwd === void 0 ? listModels.call(providers, provider) : listModels.call(providers, provider, { cwd }))
    );
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}
function warnOnce(entry, log, message) {
  if (entry.warned) return;
  entry.warned = true;
  log(message);
}
async function listedCostOf(paseo, provider, model, log, cwd) {
  try {
    const id = providerId(provider);
    if (id === null || id === "" || model === "") return null;
    let entry = lists.get(id);
    if (entry === void 0) {
      entry = { answer: readModelList(paseo, id, cwd), warned: false };
      lists.set(id, entry);
    }
    const list = await withTimeout(entry.answer);
    if (list === TIMED_OUT) {
      warnOnce(
        entry,
        log,
        `[paseo-bm] reading the models of ${id} took longer than ${LOOKUP_TIMEOUT_MS} ms; models missing from the bundled price table show tokens only.`
      );
      return null;
    }
    if ("failure" in list) {
      warnOnce(
        entry,
        log,
        `[paseo-bm] could not read the models of ${id} (${list.failure}); models missing from the bundled price table show tokens only.`
      );
      return null;
    }
    const price = list.prices.get(model) ?? (model.startsWith(`${id}/`) ? list.prices.get(model.slice(id.length + 1)) : void 0);
    return price === void 0 ? null : { price, readAt: list.readAt };
  } catch {
    return null;
  }
}
async function costOf(paseo, provider, model, log = (message) => console.warn(message), cwd) {
  return (await listedCostOf(paseo, provider, model, log, cwd))?.price ?? null;
}

// plugin/server/role-choices.ts
var reasonOf = (error) => error instanceof Error ? error.message : String(error);
var nonEmpty2 = (value) => typeof value === "string" && value.trim() !== "" ? value : null;
function asRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function isRoleAlias(provider) {
  return /^bm-/i.test(provider.trim());
}
async function availableProviders(paseo) {
  const providers = paseo?.providers;
  const listAvailable = providers?.listAvailable;
  if (typeof listAvailable !== "function") return null;
  try {
    const result = await withTimeout(listAvailable.call(providers));
    if (result === TIMED_OUT || !Array.isArray(result?.providers)) return null;
    const ids = /* @__PURE__ */ new Set();
    for (const entry of result.providers) {
      if (entry?.available === true && typeof entry.provider === "string") ids.add(entry.provider);
    }
    return ids;
  } catch {
    return null;
  }
}
async function pickableProviders(paseo) {
  const available = await availableProviders(paseo);
  return available === null ? [] : [...available].filter((id) => !isRoleAlias(id)).sort();
}
async function listedModelsOf(paseo, provider, log) {
  const providers = paseo?.providers;
  const listModels = providers?.listModels;
  if (typeof listModels !== "function") {
    log(`[paseo-bm] this Paseo host cannot list models; Roles & models offers no model of ${provider}.`);
    return [];
  }
  try {
    const result = await withTimeout(listModels.call(providers, provider));
    if (result === TIMED_OUT) {
      log(`[paseo-bm] reading the models of ${provider} took longer than ${LOOKUP_TIMEOUT_MS} ms; Roles & models offers none.`);
      return [];
    }
    const failure = nonEmpty2(result?.error);
    if (failure !== null || !Array.isArray(result?.models)) {
      log(`[paseo-bm] could not read the models of ${provider} (${failure ?? "no models listed"}); Roles & models offers none.`);
      return [];
    }
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const raw of result.models) {
      const model = asRecord2(raw);
      const id = nonEmpty2(model?.["id"]);
      if (model === null || id === null || seen.has(id)) continue;
      seen.add(id);
      const thinkingOptions = [];
      let flaggedDefault = null;
      const optionIds = /* @__PURE__ */ new Set();
      for (const rawOption of Array.isArray(model["thinkingOptions"]) ? model["thinkingOptions"] : []) {
        const option = asRecord2(rawOption);
        const optionId = nonEmpty2(option?.["id"]);
        if (option === null || optionId === null || optionIds.has(optionId)) continue;
        optionIds.add(optionId);
        thinkingOptions.push({ id: optionId, label: nonEmpty2(option["label"]) ?? optionId });
        if (flaggedDefault === null && option["isDefault"] === true) flaggedDefault = optionId;
      }
      out.push({
        id,
        label: nonEmpty2(model["label"]) ?? id,
        thinkingOptions,
        defaultThinkingOptionId: nonEmpty2(model["defaultThinkingOptionId"]) ?? flaggedDefault
      });
    }
    return out;
  } catch (error) {
    log(`[paseo-bm] could not read the models of ${provider} (${reasonOf(error)}); Roles & models offers none.`);
    return [];
  }
}
async function modelOptionsOf(paseo, provider, log) {
  const models = await listedModelsOf(paseo, provider, log);
  return Promise.all(
    models.map(async (model) => ({
      ...model,
      cost: await costOf(paseo, provider, model.id, log).catch(() => null)
    }))
  );
}
async function checkRoleChoice(role, choice, paseo, log, available) {
  const invalid2 = (detail2) => new DashboardError("E_ROLE_SETTINGS_INVALID", detail2);
  if (isRoleAlias(choice.baseProvider)) throw invalid2(`"${choice.baseProvider}" is a paseo-bm role alias, not a base provider`);
  const listed = available === void 0 ? await availableProviders(paseo) : available;
  if (listed === null) throw invalid2("Paseo cannot say which providers are available right now; try again");
  if (!listed.has(choice.baseProvider)) throw invalid2(`provider "${choice.baseProvider}" is not available in Paseo`);
  const [models, modes] = await Promise.all([modelOptionsOf(paseo, choice.baseProvider, log), modesFor(paseo, choice.baseProvider, log)]);
  const model = models.find((entry) => entry.id === choice.model);
  if (model === void 0) throw invalid2(`model "${choice.model}" is not listed for ${choice.baseProvider}`);
  if (choice.thinkingOptionId !== null && !model.thinkingOptions.some((option) => option.id === choice.thinkingOptionId)) {
    throw invalid2(`thinking "${choice.thinkingOptionId}" is not offered by ${choice.model}`);
  }
  if (choice.modeId !== null) {
    const mode = (modes ?? []).find((entry) => entry?.id === choice.modeId);
    if (mode === void 0) throw invalid2(`mode "${choice.modeId}" is not listed for ${choice.baseProvider}`);
    const tier = typeof mode.colorTier === "string" ? mode.colorTier.toLowerCase() : "";
    if (role === "reviewer" && (tier === "dangerous" || tier === "planning")) {
      throw invalid2(`the Reviewer never runs in a ${tier} mode ("${choice.modeId}")`);
    }
  }
  return { model, capability: capabilityOf(modes), modes };
}

// plugin/server/role-extras.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";
import { z as z4 } from "zod";

// plugin/server/trace-store.ts
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname as dirname2, isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
var STORE_DIR_MODE = 448;
var STORE_FILE_MODE = 384;
function unwritable(detail2, cause) {
  return new DashboardError("E_TRACE_STORE_UNWRITABLE", detail2, cause ? { cause } : void 0);
}
function assertNoSymlinkOnPath2(root, target) {
  const rootAbsolute = resolve2(root);
  const targetAbsolute = resolve2(target);
  const check = (path) => {
    try {
      if (lstatSync2(path).isSymbolicLink()) {
        throw unwritable(`refusing to use a symlinked path inside the trace store: ${path}`);
      }
      return true;
    } catch (error) {
      if (error instanceof DashboardError) throw error;
      if (error.code === "ENOENT") return false;
      throw unwritable(`cannot inspect ${path}`, error);
    }
  };
  if (!check(rootAbsolute)) return;
  if (targetAbsolute === rootAbsolute) return;
  let current = rootAbsolute;
  for (const part of relative2(rootAbsolute, targetAbsolute).split(sep2)) {
    if (part === "" || part === ".") continue;
    current = join2(current, part);
    if (!check(current)) return;
  }
}
function ensureStoreDir(tracesDir, directory) {
  const root = resolve2(tracesDir);
  assertNoSymlinkOnPath2(dirname2(root), directory);
  try {
    mkdirSync2(directory, { recursive: true, mode: STORE_DIR_MODE });
  } catch (error) {
    throw unwritable(`cannot create ${directory}`, error);
  }
  assertNoSymlinkOnPath2(dirname2(root), directory);
}
function createStoreTempFile(path) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
  try {
    return openSync(path, flags, STORE_FILE_MODE);
  } catch (error) {
    throw unwritable(`cannot create the temporary file ${path}`, error);
  }
}
function closeQuietly(fd) {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch {
  }
}
var MAX_MESSAGE_CHARS = 8 * 1024;
var MAX_RECORD_CHARS = 32 * 1024;
function writeStoreFileAtomically(location, path, body) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  assertNoSymlinkOnPath2(dirname2(resolve2(location.tracesDir)), tempPath);
  let fd = null;
  try {
    fd = createStoreTempFile(tempPath);
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeQuietly(fd);
  }
  try {
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
    }
    throw unwritable(`cannot replace ${path}`, error);
  }
}

// plugin/server/setup-skills.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { homedir } from "node:os";
import { join as join4 } from "node:path";

// plugin/shared/fallback.ts
var FALLBACK_ROLES = ["worker", "reviewer", "manager"];
var MAX_FALLBACK_ENTRIES = 3;
var FALLBACK_ALIAS_PATTERN = /^bm-(manager|worker|reviewer)-fallback-([1-3])$/;
function fallbackAlias(role, n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_FALLBACK_ENTRIES) {
    throw new RangeError(`fallback position must be 1\u2026${MAX_FALLBACK_ENTRIES}, got ${n}`);
  }
  return `bm-${role}-fallback-${n}`;
}
function fallbackAliasOf(alias) {
  if (typeof alias !== "string") return null;
  const match = FALLBACK_ALIAS_PATTERN.exec(alias);
  return match === null ? null : { role: match[1], position: Number(match[2]) };
}

// plugin/server/agent-role.ts
var ROLE_LABEL = "bm.role";
var ROLE_BY_PROVIDER = {
  "bm-manager": "manager",
  "bm-worker": "worker",
  "bm-reviewer": "reviewer"
};
var ROLES = /* @__PURE__ */ new Set(["manager", "worker", "reviewer"]);
function roleOfProvider(provider) {
  const id = providerId(provider);
  if (id === null) return null;
  if (Object.prototype.hasOwnProperty.call(ROLE_BY_PROVIDER, id)) return ROLE_BY_PROVIDER[id];
  return fallbackAliasOf(id)?.role ?? null;
}
function roleOfAgent(agent) {
  try {
    if (agent === null || typeof agent !== "object") return null;
    const { labels, provider } = agent;
    const label = labels !== null && typeof labels === "object" ? labels[ROLE_LABEL] : void 0;
    if (typeof label === "string" && ROLES.has(label)) return { role: label, labelled: true };
    const role = roleOfProvider(provider);
    return role === null ? null : { role, labelled: false };
  } catch {
    return null;
  }
}
var LIST_PAGE_LIMIT = 200;
async function listAllAgents(list, filter) {
  const found = [];
  let cursor;
  for (; ; ) {
    const page = await list({
      filter,
      page: cursor === void 0 ? { limit: LIST_PAGE_LIMIT } : { limit: LIST_PAGE_LIMIT, cursor }
    });
    for (const { agent } of page.entries) found.push(agent);
    if (!page.pageInfo?.hasMore || !page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return found;
}

// plugin/server/setup-state.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname3, join as join3 } from "node:path";
import { z as z3 } from "zod";
var SETUP_STATE_SCHEMA_VERSION = 1;
var SETUP_STATE_FILE_NAME = "setup-state.json";
var SETUP_ROLE_NAMES = ["manager", "worker", "reviewer"];
var agentToolsMarkSchema = z3.object({
  /** Who turned the switch on: this plugin, or the 0.4.0 CLI on behalf of a 0.3.x install. */
  setBy: z3.enum(["plugin", "installer"]),
  /** What `daemon.mcp.injectIntoAgents` was before. */
  previous: z3.boolean(),
  at: z3.string().min(1)
});
var rolesCreatedMarkSchema = z3.object({
  at: z3.string().min(1),
  roles: z3.array(z3.enum(SETUP_ROLE_NAMES)),
  baseProvider: z3.string().min(1),
  model: z3.string().min(1)
});
var skillsRunMarkSchema = z3.object({
  at: z3.string().min(1),
  command: z3.string().min(1),
  code: z3.number().int(),
  outcome: z3.enum(["ok", "failed", "timeout"])
});
var setupStateFileSchema = z3.object({
  schemaVersion: z3.number().int().positive(),
  agentTools: agentToolsMarkSchema.nullish(),
  rolesCreated: rolesCreatedMarkSchema.nullish(),
  skillsRun: skillsRunMarkSchema.nullish(),
  cleanedUpAt: z3.string().min(1).nullish()
});
function emptySetupState() {
  return { agentTools: null, rolesCreated: null, skillsRun: null, cleanedUpAt: null };
}
function unavailable(detail2, cause) {
  return new DashboardError("E_DATA_HOME_UNAVAILABLE", detail2, cause ? { cause } : void 0);
}
function requireDataHome(deps) {
  const resolution = deps.resolution ?? resolveDataHome(deps);
  if (resolution.home === null) {
    throw unavailable(`the paseo-bm data folder is not usable: ${resolution.reason}`);
  }
  return { home: resolution.home, tracesDir: resolution.tracesDir };
}
function setupStatePath(home) {
  return join3(home, UI_DIR_NAME, SETUP_STATE_FILE_NAME);
}
function readFile(home) {
  const path = setupStatePath(home);
  try {
    assertNoSymlinkOnPath2(home, path);
  } catch (error) {
    throw unavailable(`cannot use ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  let raw;
  try {
    raw = readFileSync2(path, "utf8");
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: emptySetupState(), tooNew: false };
    throw unavailable(`cannot read ${path}`, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptySetupState(), tooNew: false };
  }
  const result = setupStateFileSchema.safeParse(parsed);
  if (!result.success) return { state: emptySetupState(), tooNew: false };
  if (result.data.schemaVersion > SETUP_STATE_SCHEMA_VERSION) {
    return { state: emptySetupState(), tooNew: true };
  }
  return {
    state: {
      agentTools: result.data.agentTools ?? null,
      rolesCreated: result.data.rolesCreated ?? null,
      skillsRun: result.data.skillsRun ?? null,
      cleanedUpAt: result.data.cleanedUpAt ?? null
    },
    tooNew: false
  };
}
function readSetupState(deps = {}) {
  return readFile(requireDataHome(deps).home).state;
}
function writeSetupState(state, deps = {}) {
  const { home, tracesDir } = requireDataHome(deps);
  const path = setupStatePath(home);
  if (readFile(home).tooNew) {
    throw unavailable(
      `${path} was written by a newer paseo-bm than this one (schemaVersion above ${SETUP_STATE_SCHEMA_VERSION}); refusing to overwrite it`
    );
  }
  try {
    ensureDataHome(home, deps);
    ensureStoreDir(tracesDir, dirname3(path));
    const body = JSON.stringify({ schemaVersion: SETUP_STATE_SCHEMA_VERSION, ...state }, null, 2);
    writeStoreFileAtomically({ tracesDir }, path, `${body}
`);
  } catch (error) {
    if (error instanceof DashboardError && error.code === "E_DATA_HOME_UNAVAILABLE") throw error;
    throw unavailable(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  return state;
}
function updateSetupState(patch, deps = {}) {
  const resolution = deps.resolution ?? resolveDataHome(deps);
  const withResolution = { ...deps, resolution };
  const current = readSetupState(withResolution);
  return writeSetupState({ ...current, ...patch }, withResolution);
}

// plugin/server/setup-skills.ts
var REQUIRED_SKILLS = [
  "feature-workflow",
  "reviewing-plan",
  "converting-plan-to-beads",
  "polishing-beads",
  "implementing-beads"
];
var OPTIONAL_SKILLS = ["architecture-premise-audit", "authoring-workspace-protocol"];
function skillDirs(deps = {}) {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? homedir)();
  return {
    shared: join4(home, ".agents", "skills"),
    claude: join4(env.CLAUDE_CONFIG_DIR ?? join4(home, ".claude"), "skills"),
    codex: join4(env.CODEX_HOME ?? join4(home, ".codex"), "skills"),
    pi: join4(home, ".pi", "agent", "skills"),
    opencode: join4(home, ".config", "opencode", "skill")
  };
}
function checkSkillAt(dir, name, read) {
  let text;
  try {
    text = read(join4(dir, name, "SKILL.md"));
  } catch (error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", problem: null };
    return { state: "broken", problem: `${join4(dir, name, "SKILL.md")} cannot be read (${code ?? "error"})` };
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const declared = frontmatter === void 0 ? null : /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(frontmatter)?.[1] ?? null;
  if (declared === null) return { state: "broken", problem: `${name}/SKILL.md has no \`name:\` in its frontmatter` };
  if (declared !== name) return { state: "broken", problem: `${name}/SKILL.md declares name \`${declared}\`` };
  return { state: "ok", problem: null };
}
function best(...states) {
  return states.find((entry) => entry.state === "ok") ?? states.find((entry) => entry.state === "broken") ?? states[0];
}
function skillsStatus(deps = {}) {
  const read = deps.readFile ?? ((path) => readFileSync3(path, "utf8"));
  const dirs = skillDirs(deps);
  const rows = [...REQUIRED_SKILLS, ...OPTIONAL_SKILLS].map((name) => {
    const claude = checkSkillAt(dirs.claude, name, read);
    const codex = best(checkSkillAt(dirs.shared, name, read), checkSkillAt(dirs.codex, name, read));
    const pi = checkSkillAt(dirs.pi, name, read);
    const opencode = checkSkillAt(dirs.opencode, name, read);
    return {
      name,
      required: REQUIRED_SKILLS.includes(name),
      claude: claude.state,
      codex: codex.state,
      pi: pi.state,
      opencode: opencode.state,
      problem: claude.problem ?? codex.problem ?? pi.problem ?? opencode.problem
    };
  });
  return {
    checkedAt: (deps.now ?? (() => /* @__PURE__ */ new Date()))().toISOString(),
    dirs,
    skills: rows,
    missingRequired: {
      claude: rows.filter((row) => row.required && row.claude !== "ok").length,
      codex: rows.filter((row) => row.required && row.codex !== "ok").length,
      pi: rows.filter((row) => row.required && row.pi !== "ok").length,
      opencode: rows.filter((row) => row.required && row.opencode !== "ok").length
    },
    installCommand: `npx -y skills add cuongntr/agent-skills -g -a claude-code codex -s ${REQUIRED_SKILLS.join(" ")} -y`
  };
}

// plugin/server/role-extras.ts
var ROLE_EXTRAS_FILE = "role-extras.json";
var MAX_EXTRA_CHARS = 8e3;
var EXTRA_HEADING = [
  "## Additional instructions from the user",
  "",
  "These add to the rules above and never override a RULES item."
].join("\n");
var extrasSchema = z4.object({
  version: z4.literal(1),
  roles: z4.object({
    manager: z4.string().max(MAX_EXTRA_CHARS).default(""),
    worker: z4.string().max(MAX_EXTRA_CHARS).default(""),
    reviewer: z4.string().max(MAX_EXTRA_CHARS).default("")
  })
});
var EMPTY = { manager: "", worker: "", reviewer: "" };
function workerSkillsLine(missing) {
  return missing.length === 0 ? "Worker skills: all present." : `Worker skills: missing ${missing.map((name) => `\`${name}\``).join(", ")} \u2014 tell the user once, when you confirm the Worker, that it works with lower quality, and point to Beads Manager \u2192 Setup \u2192 Agent skills.`;
}
var REVIEWER_FALLBACK_MODE = "auto";
var REVIEWER_FALLBACK_PROVIDERS = ["claude", "codex"];
var RUNTIME_FACTS_HEADING = "## Runtime facts";
function runtimeFactsText(role, facts = {}) {
  const trimmed = (value) => typeof value === "string" ? value.trim() : "";
  const child = role === "manager" ? "Worker" : role === "worker" ? "Reviewer" : null;
  if (child === null) return "";
  const lines = [];
  const none = role === "manager" ? facts.workerModeNone === true : facts.reviewerModeNone === true;
  const mode = role === "manager" ? trimmed(facts.workerModeId) : trimmed(facts.reviewerModeId);
  if (none) lines.push(`${child} mode: none \u2014 do not pass \`settings.modeId\` when you create a ${child}; Paseo sets it.`);
  else if (mode !== "") lines.push(`${child} mode: \`${mode}\` \u2014 pass it as \`settings.modeId\` when you create a ${child}.`);
  if (role === "manager" && facts.workerSkillsMissing !== void 0) lines.push(workerSkillsLine(facts.workerSkillsMissing));
  return lines.length === 0 ? "" : `${RUNTIME_FACTS_HEADING}

${lines.join("\n")}`;
}
async function runtimeFactsOf(role, paseo, cwd, log = (message) => console.warn(message), skills = () => skillsStatus()) {
  const [modes, skillFacts] = await Promise.all([
    modeFactsOf(role, paseo, cwd, log),
    role === "manager" ? workerSkillFacts(paseo, skills, log) : Promise.resolve({})
  ]);
  return { ...modes, ...skillFacts };
}
async function workerSkillFacts(paseo, skills, log) {
  try {
    const base = await baseProviderOf(paseo, "bm-worker");
    if (base !== "claude" && base !== "codex" && base !== "pi" && base !== "opencode") return {};
    const missing = skills().skills.filter((row) => row.required && row[base] !== "ok").map((row) => row.name);
    return { workerSkillsMissing: missing };
  } catch (error) {
    log(`[paseo-bm] checking the Worker's skills failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}
async function modeFactsOf(role, paseo, cwd, log) {
  if (role === "reviewer") return {};
  try {
    if (role === "worker") {
      const profileModeId2 = await profileModeOf(paseo, "bm-reviewer");
      const modes2 = await modesFor(paseo, "bm-reviewer", void 0, cwd);
      const byCapability2 = childModeByCapability("reviewer", modes2, profileModeId2);
      if (byCapability2 !== void 0) {
        return byCapability2 === null ? { reviewerModeNone: true } : { reviewerModeId: byCapability2 };
      }
      if (modes2 === null) {
        const base = await baseProviderOf(paseo, "bm-reviewer");
        if (base !== null && !REVIEWER_FALLBACK_PROVIDERS.includes(base)) {
          const last2 = lastModesOf("bm-reviewer");
          const fromLast2 = last2 === null ? void 0 : childModeByCapability("reviewer", last2.modes, profileModeId2);
          if (typeof fromLast2 === "string") {
            log(`[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the Reviewer mode "${fromLast2}" (last list read at ${last2.at}).`);
            return { reviewerModeId: fromLast2 };
          }
          log(`[paseo-bm] could not read the modes of bm-reviewer (base provider ${base}); the Worker is told no Reviewer mode.`);
          return {};
        }
        const last = lastModesOf("bm-reviewer");
        const fromLast = last === null ? void 0 : chooseModeId("reviewer", last.modes, void 0, profileModeId2);
        const reviewerModeId2 = fromLast ?? REVIEWER_FALLBACK_MODE;
        const source = fromLast === void 0 ? "static fallback" : `last list read at ${last.at}`;
        log(`[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "${reviewerModeId2}" (${source}).`);
        return { reviewerModeId: reviewerModeId2 };
      }
      const reviewerModeId = chooseModeId("reviewer", modes2, void 0, profileModeId2);
      return reviewerModeId === void 0 ? {} : { reviewerModeId };
    }
    const profileModeId = await profileModeOf(paseo, "bm-worker");
    const modes = await modesFor(paseo, "bm-worker", void 0, cwd);
    const byCapability = childModeByCapability("worker", modes, profileModeId);
    if (byCapability !== void 0) {
      return byCapability === null ? { workerModeNone: true } : { workerModeId: byCapability };
    }
    if (modes === null) {
      return profileModeId === null ? {} : { workerModeId: profileModeId };
    }
    const workerModeId = chooseModeId("worker", modes, void 0, profileModeId);
    return workerModeId === void 0 ? {} : { workerModeId };
  } catch (error) {
    log(`[paseo-bm] reading the Runtime facts of ${role} failed: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}
function childModeByCapability(role, modes, profileModeId) {
  const capability = capabilityOf(modes);
  if (capability === "none") return null;
  if (capability !== "untiered") return void 0;
  return runPostureOf(role, "untiered", modes ?? [], null, profileModeId)?.modeId;
}
async function baseProviderOf(paseo, alias) {
  const get = paseo?.config?.get;
  if (typeof get !== "function") return null;
  try {
    const result = await withTimeout(
      get.call(paseo.config)
    );
    if (result === TIMED_OUT) return null;
    const base = result?.config?.providers?.[alias]?.extends;
    return typeof base === "string" && base.trim() !== "" ? base : null;
  } catch {
    return null;
  }
}
function readRoleExtras(home) {
  try {
    const parsed = extrasSchema.safeParse(JSON.parse(readFileSync4(join5(home, ROLE_EXTRAS_FILE), "utf8")));
    return parsed.success ? parsed.data.roles : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}
function saveRoleExtra(home, role, text) {
  if (text.length > MAX_EXTRA_CHARS) {
    throw new DashboardError("E_ROLE_EXTRA_INVALID", `at most ${MAX_EXTRA_CHARS} characters, got ${text.length}`);
  }
  const roles = { ...readRoleExtras(home), [role]: text };
  try {
    ensureDataHome(home);
  } catch (error) {
    throw new DashboardError(
      "E_TRACE_STORE_UNWRITABLE",
      error instanceof Error ? error.message : String(error),
      { cause: error }
    );
  }
  writeStoreFileAtomically(
    { tracesDir: join5(home, TRACES_DIR_NAME) },
    join5(home, ROLE_EXTRAS_FILE),
    `${JSON.stringify({ version: 1, roles }, null, 2)}
`
  );
  return roles;
}
function dataHomeOf(deps = {}) {
  try {
    return resolveDataHome({ homedir: deps.homedir ?? homedir2 }).home;
  } catch {
    return null;
  }
}

// plugin/server/fallback-settings.ts
var ROLE_FALLBACK_FILE = "role-fallback.json";
var chainSchema = z5.object({
  policy: z5.enum(["ask", "off", "auto"]),
  entries: z5.array(fallbackEntryInputSchema).max(MAX_FALLBACK_ENTRIES)
});
var roleFallbackFileSchema = z5.object({
  version: z5.literal(1),
  roles: z5.object({ manager: chainSchema.optional(), worker: chainSchema.optional(), reviewer: chainSchema.optional() }).default({}),
  patterns: z5.object({
    L1: z5.array(z5.string()).optional(),
    L2: z5.array(z5.string()).optional(),
    L3: z5.array(z5.string()).optional(),
    L4: z5.array(z5.string()).optional(),
    L5: z5.array(z5.string()).optional()
  }).optional()
});
var DEFAULT_CHAIN = { policy: "ask", entries: [] };
var defaultLog = (message) => console.warn(message);
var emptyFile = () => ({ version: 1, roles: {} });
function readRoleFallback(home, log = defaultLog) {
  const path = join6(home, ROLE_FALLBACK_FILE);
  const invalid2 = (reason) => {
    log(`[paseo-bm] ${path} is not usable (${reason}); fallback chains use the defaults until it is fixed or deleted.`);
    return { file: emptyFile(), raw: null, error: reason };
  };
  let text;
  try {
    text = readFileSync5(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { file: emptyFile(), raw: null, error: null };
    return invalid2(reasonOf(error));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid2(`not JSON: ${reasonOf(error)}`);
  }
  const result = roleFallbackFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return invalid2(issue === void 0 ? "unexpected content" : `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { file: result.data, raw: asRecord2(parsed), error: null };
}
function chainOf(file, role) {
  const chain = file.roles[role];
  return chain === void 0 ? { ...DEFAULT_CHAIN, entries: [] } : chain;
}
function patternsFromFile(file) {
  return Object.values(file.patterns ?? {}).some((list) => Array.isArray(list) && list.length > 0);
}
async function fallbackSettingsOf(role, chain, fromFile, paseo, log = defaultLog) {
  const capabilities = /* @__PURE__ */ new Map();
  const capabilityFor = (provider) => {
    let known = capabilities.get(provider);
    if (known === void 0) {
      known = modesFor(paseo, provider, log).then(capabilityOf, () => "unknown");
      capabilities.set(provider, known);
    }
    return known;
  };
  const entries = await Promise.all(
    chain.entries.map(async (entry, index) => ({
      position: index + 1,
      alias: fallbackAlias(role, index + 1),
      baseProvider: entry.baseProvider,
      model: entry.model,
      thinkingOptionId: entry.thinkingOptionId,
      modeId: entry.modeId,
      capability: await capabilityFor(entry.baseProvider),
      cost: await costOf(paseo, entry.baseProvider, entry.model, log).catch(() => null)
    }))
  );
  return { role, policy: chain.policy, entries, patternsFromFile: fromFile };
}
function homeOf(deps) {
  if (deps.home !== void 0) return deps.home;
  return dataHomeOf(deps.homedir === void 0 ? {} : { homedir: deps.homedir });
}
async function fallbackForSettings(paseo, deps = {}) {
  if (FALLBACK_ROLES.length === 0) return { fallback: null, warnings: [] };
  const log = deps.log ?? defaultLog;
  const home = homeOf(deps);
  const read = home === null ? { file: emptyFile(), raw: null, error: null } : readRoleFallback(home, log);
  const warnings = read.error === null ? [] : [`${ROLE_FALLBACK_FILE} is not valid (${read.error}); fallback uses the defaults until you fix or delete it.`];
  const fromFile = patternsFromFile(read.file);
  const fallback = {};
  for (const role of FALLBACK_ROLES) fallback[role] = await fallbackSettingsOf(role, chainOf(read.file, role), fromFile, paseo, log);
  return { fallback, warnings };
}
var queue2 = Promise.resolve();

// plugin/server/notice-queue.ts
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function nonEmpty3(value) {
  return typeof value === "string" && value.trim() !== "";
}
function isPaseo(value) {
  if (value === null || typeof value !== "object") return false;
  const agents = value.agents;
  return agents !== null && typeof agents === "object" && typeof agents.ref === "function";
}
function agentIdOf(event) {
  if (event === null || typeof event !== "object") return null;
  const agent = event.agent;
  if (agent === null || typeof agent !== "object") return null;
  const id = agent.id;
  return nonEmpty3(id) ? id : null;
}
function isBusy(status) {
  return status === "running" || status === "initializing";
}
function createNoticeQueue(deps = {}) {
  const log = deps.log ?? ((message) => console.warn(message));
  const queued = /* @__PURE__ */ new Map();
  const delivering = /* @__PURE__ */ new Map();
  let lastPaseo = null;
  function handleFor(paseo) {
    if (isPaseo(paseo)) lastPaseo = paseo;
    return lastPaseo;
  }
  function put(targetId, entry) {
    const kept = [];
    for (const old of queued.get(targetId) ?? []) {
      if (old.kind === entry.kind) old.state = "replaced";
      else kept.push(old);
    }
    kept.push(entry);
    queued.set(targetId, kept);
  }
  function take(targetId) {
    const list = queued.get(targetId);
    const first = list?.shift();
    if (list !== void 0 && list.length === 0) queued.delete(targetId);
    return first;
  }
  function dropAll(targetId) {
    const list = queued.get(targetId) ?? [];
    queued.delete(targetId);
    if (list.length === 0) return;
    for (const entry of list) entry.state = "dropped";
    log(
      `[paseo-bm] ${targetId} is archived, closed or gone; dropped its queued notices (${list.map((entry) => entry.kind).join(", ")}).`
    );
  }
  async function step(targetId, paseo) {
    const head = queued.get(targetId)?.[0];
    if (head === void 0) return "empty";
    let agent;
    try {
      agent = (await paseo.agents.ref(targetId).refresh())?.agent ?? null;
    } catch (error) {
      log(`[paseo-bm] could not read ${targetId} to deliver its ${head.kind} notice: ${describeError(error)}; it waits for that agent's next turn end.`);
      return "unknown";
    }
    if (agent === null || agent.archivedAt != null || agent.status === "closed") {
      dropAll(targetId);
      return "gone";
    }
    if (isBusy(agent.status)) return "busy";
    const entry = take(targetId);
    if (entry === void 0) return "empty";
    entry.state = "sending";
    try {
      await paseo.agents.ref(targetId).send(entry.text);
      entry.state = "sent";
      return "sent";
    } catch (error) {
      entry.state = "dropped";
      log(`[paseo-bm] could not send the ${entry.kind} notice to ${targetId}: ${describeError(error)}; dropped it.`);
      return "failed";
    }
  }
  async function deliver(targetId, paseo) {
    const current = delivering.get(targetId);
    if (current !== void 0) {
      current.again = true;
      return;
    }
    const flag = { again: false };
    delivering.set(targetId, flag);
    try {
      for (; ; ) {
        flag.again = false;
        const result = await step(targetId, paseo);
        if (result === "sent" || result === "empty" || result === "gone") return;
        if (result === "failed") continue;
        if (!flag.again) return;
      }
    } finally {
      delivering.delete(targetId);
    }
  }
  async function enqueue2(targetId, kind, text, paseo) {
    try {
      if (!nonEmpty3(targetId) || !nonEmpty3(kind) || !nonEmpty3(text)) {
        log("[paseo-bm] a plugin notice without a target, a kind or a text was not queued.");
        return "dropped";
      }
      const entry = { kind, text, state: "queued" };
      put(targetId, entry);
      const handle = handleFor(paseo);
      if (handle !== null) await deliver(targetId, handle);
      return entry.state === "sending" ? "queued" : entry.state;
    } catch (error) {
      log(`[paseo-bm] queueing the ${String(kind)} notice for ${String(targetId)} failed: ${describeError(error)}`);
      return "dropped";
    }
  }
  async function turnEnded(event, paseo) {
    try {
      const handle = handleFor(paseo);
      const targetId = agentIdOf(event);
      if (targetId === null || handle === null || !queued.has(targetId)) return;
      await deliver(targetId, handle);
    } catch (error) {
      log(`[paseo-bm] delivering queued notices failed: ${describeError(error)}`);
    }
  }
  return {
    enqueue: enqueue2,
    turnEnded,
    pending: (targetId) => (queued.get(targetId) ?? []).map(({ kind, text }) => ({ kind, text })),
    clear() {
      for (const list of queued.values()) for (const entry of list) entry.state = "dropped";
      queued.clear();
      lastPaseo = null;
    }
  };
}
var noticeQueue = createNoticeQueue();
function enqueue(targetId, kind, text, paseo) {
  return noticeQueue.enqueue(targetId, kind, text, paseo);
}

// plugin/server/settings-notices.ts
var CREATOR_OF = { worker: "manager", reviewer: "worker" };
async function childFactLine(savedRole, paseo, cwd) {
  const creator = CREATOR_OF[savedRole];
  if (creator === void 0) return null;
  try {
    const text = runtimeFactsText(creator, await runtimeFactsOf(creator, paseo, cwd, () => {
    }));
    const prefix = `${RUNTIME_FACTS_HEADING}

`;
    if (!text.startsWith(prefix)) return "";
    return text.slice(prefix.length).split("\n").find((line) => / mode: /.test(line)) ?? "";
  } catch {
    return "";
  }
}
function settingsNotice(line) {
  return [
    `${SETTINGS_NOTICE_MARKER} The user changed the paseo-bm role settings. This replaces the matching line under "${RUNTIME_FACTS_HEADING}":`,
    line,
    "Do not reply to this message; carry on with what you were doing."
  ].join("\n");
}
async function notifyChildFactChange(savedRole, before, after, paseo, deps = {}) {
  const creator = CREATOR_OF[savedRole];
  if (creator === void 0 || after === null || after === "" || after === before) return 0;
  const log = deps.log ?? ((message) => console.warn(message));
  try {
    const agents = await listAllAgents((options) => paseo.agents.list(options), { includeArchived: false });
    const targets = agents.filter((agent) => !agent.archivedAt && roleOfAgent(agent)?.role === creator);
    const send = deps.enqueue ?? enqueue;
    const outcomes = await Promise.all(targets.map((agent) => send(agent.id, SETTINGS_NOTICE_MARKER, settingsNotice(after), paseo)));
    return outcomes.filter((outcome) => outcome === "sent" || outcome === "queued").length;
  } catch (error) {
    log(`[paseo-bm] telling live agents about the new ${savedRole} mode failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

// plugin/server/role-settings-rpc.ts
function roleSettingsRevision(config) {
  return roleConfigRevision(config ?? {});
}
var defaultLog2 = (message) => console.warn(message);
var ROLES2 = ["manager", "worker", "reviewer"];
var PROVIDER_IDS = { manager: "bm-manager", worker: "bm-worker", reviewer: "bm-reviewer" };
async function readConfig(paseo) {
  const config = paseo?.config;
  const get = config?.get;
  if (typeof get !== "function") return { failure: "this Paseo host cannot read its configuration" };
  try {
    const result = await withTimeout(get.call(config));
    if (result === TIMED_OUT) return { failure: `no answer within ${LOOKUP_TIMEOUT_MS} ms` };
    const view = asRecord2(result?.config);
    if (view === null) return { failure: "the answer carried no configuration" };
    return { config: view };
  } catch (error) {
    return { failure: reasonOf(error) };
  }
}
function emptySetting(role) {
  return {
    role,
    providerId: PROVIDER_IDS[role],
    baseProvider: null,
    label: null,
    model: null,
    thinkingOptionId: null,
    modeId: null,
    featureValues: {},
    capability: "unknown"
  };
}
function sharedPlanWarning(provider) {
  return `Manager and Worker share the ${provider} plan: if the Worker hits its limit, the Manager stops too.`;
}
async function handleRolesSettings(paseo, deps = {}) {
  const log = deps.log ?? defaultLog2;
  const read = await readConfig(paseo);
  if ("failure" in read) {
    log(`[paseo-bm] could not read the Paseo configuration for Roles & models (${read.failure}).`);
    return {
      revision: roleSettingsRevision({}),
      roles: ROLES2.map(emptySetting),
      // No second config read for the install home: the chains show as the defaults.
      fallback: (await fallbackForSettings(paseo, { ...deps, home: null })).fallback,
      warnings: [`paseo-bm could not read the Paseo configuration (${read.failure}); reopen Roles & models to try again.`],
      providers: await pickableProviders(paseo)
    };
  }
  const { config } = read;
  const providers = asRecord2(config.providers) ?? {};
  const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
  const capabilities = /* @__PURE__ */ new Map();
  const capabilityFor = (provider) => {
    let known = capabilities.get(provider);
    if (known === void 0) {
      known = modesFor(paseo, provider, log).then(capabilityOf, () => "unknown");
      capabilities.set(provider, known);
    }
    return known;
  };
  const roles = await Promise.all(
    ROLES2.map(async (role) => {
      const id = PROVIDER_IDS[role];
      const entry = asRecord2(providers[id]);
      const profile = asRecord2(profiles.find((candidate) => asRecord2(candidate)?.["id"] === id));
      const baseProvider = nonEmpty2(entry?.["extends"]);
      const features = asRecord2(profile?.["featureValues"]);
      return {
        role,
        providerId: id,
        baseProvider,
        label: nonEmpty2(entry?.["label"]),
        model: nonEmpty2(profile?.["model"]),
        thinkingOptionId: nonEmpty2(profile?.["thinkingOptionId"]),
        modeId: nonEmpty2(profile?.["modeId"]),
        featureValues: features === null ? {} : { ...features },
        capability: baseProvider === null ? "unknown" : await capabilityFor(baseProvider)
      };
    })
  );
  const warnings = [];
  const manager = roles.find((setting) => setting.role === "manager")?.baseProvider ?? null;
  const worker = roles.find((setting) => setting.role === "worker")?.baseProvider ?? null;
  if (manager !== null && manager === worker) warnings.push(sharedPlanWarning(manager));
  const chains = await fallbackForSettings(paseo, deps);
  warnings.push(...chains.warnings);
  return { revision: roleSettingsRevision(config), roles, fallback: chains.fallback, warnings, providers: await pickableProviders(paseo) };
}
function saveWarnings(input, capability, cost) {
  const warnings = [];
  const pi = input.baseProvider === "pi";
  if (pi && (input.role === "manager" || input.role === "worker")) {
    warnings.push("Pi needs pi-mcp-adapter to give this role Paseo tools.");
  }
  if (input.role === "reviewer" && (pi || capability === "none")) {
    warnings.push("Pi does not ask before running tools; the Reviewer's read-only rule is only in its instructions.");
  }
  if (input.role === "reviewer" && capability === "untiered" && input.modeId === null) {
    warnings.push("The Reviewer runs with your OpenCode agent's permissions; paseo-bm never auto-approves for it.");
  }
  if (cost !== null) {
    warnings.push(`Priced at ~$${cost.inputUsdPerMTok} / $${cost.outputUsdPerMTok} per 1M tokens.`);
  }
  return warnings;
}
async function handleRolesSaveSettings(input, paseo, deps = {}) {
  const log = deps.log ?? defaultLog2;
  const { model, capability } = await checkRoleChoice(input.role, input, paseo, log);
  const id = PROVIDER_IDS[input.role];
  const lineBefore = await childFactLine(input.role, paseo);
  await writeRoleConfig(paseo, {
    expectedRevision: input.revision,
    providers: { [id]: { extends: input.baseProvider } },
    profiles: { [id]: { model: input.model, thinkingOptionId: input.thinkingOptionId, modeId: input.modeId } }
  });
  const settings = await handleRolesSettings(paseo, deps);
  const role = settings.roles.find((entry) => entry.role === input.role) ?? emptySetting(input.role);
  const shared = settings.warnings.filter((warning) => warning.startsWith("Manager and Worker share"));
  const lineAfter = await childFactLine(input.role, paseo);
  const notified = await notifyChildFactChange(input.role, lineBefore, lineAfter, paseo, { log });
  return { revision: settings.revision, role, warnings: [...shared, ...saveWarnings(input, capability, model.cost)], notified };
}

// plugin/server/fallback-state.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join8 } from "node:path";
import { z as z7 } from "zod";

// plugin/server/beads-store.ts
import { isAbsolute as isAbsolute3, join as join7, relative as relative3, resolve as resolve3, sep as sep3 } from "node:path";
var MAX_BEADS_FILE_BYTES = 32 * 1024 * 1024;
var BEADS_RELATIVE_PATH = join7(".beads", "issues.jsonl");

// plugin/server/workflow-steps.ts
var OPTIONAL_STEPS = ["prd", "design", "adr", "plan", "review_plan", "polish_beads"];
var SMALL_ONLY_STEPS = ["convert_to_beads", "review_batches", "close_with_evidence"];
var SKIPPABLE_BY_TIER = {
  Small: [...OPTIONAL_STEPS, ...SMALL_ONLY_STEPS],
  Medium: OPTIONAL_STEPS,
  Large: OPTIONAL_STEPS
};

// plugin/server/answer-marks.ts
import { z as z6 } from "zod";
var answerMarksFileSchema = z6.object({
  schemaVersion: z6.number().int().positive(),
  marks: z6.array(z6.object({ key: z6.string(), at: z6.string() }))
});

// plugin/server/stop-propagation.ts
var REVIEWER_STOP_NOTICE = `${REVIEWER_STOP_NOTICE_PREFIX} by the user. Stop this review now: do not read files, run commands or call any tool; reply with the single line "BM-REVIEW STOPPED" and end your turn.`;

// plugin/server/fallback-state.ts
var ROLE_FALLBACK_STATE_FILE = "role-fallback-state.json";
var MAX_INCIDENTS = 200;
var OPEN_STATUSES = /* @__PURE__ */ new Set(["pending", "waiting"]);
var stateFileSchema = z7.object({ version: z7.literal(1), incidents: z7.array(fallbackIncidentSchema) });
var defaultLog3 = (message) => console.warn(message);
function readIncidents(home, log = defaultLog3) {
  const path = join8(home, ROLE_FALLBACK_STATE_FILE);
  const invalid2 = (reason) => {
    log(`[paseo-bm] ${path} is not usable (${reason}); no fallback incident is recorded until it is fixed or deleted.`);
    return { incidents: [], error: reason };
  };
  let text;
  try {
    text = readFileSync6(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { incidents: [], error: null };
    return invalid2(reasonOf(error));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return invalid2(`not JSON: ${reasonOf(error)}`);
  }
  const result = stateFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return invalid2(issue === void 0 ? "unexpected content" : `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { incidents: result.data.incidents, error: null };
}
function capIncidents(incidents) {
  const kept = [...incidents];
  while (kept.length > MAX_INCIDENTS) {
    const finished = kept.findIndex((incident) => !OPEN_STATUSES.has(incident.status));
    kept.splice(finished === -1 ? 0 : finished, 1);
  }
  return kept;
}
var queue3 = Promise.resolve();
function serialised2(work) {
  const run2 = queue3.then(work, work);
  queue3 = run2.catch(() => void 0);
  return run2;
}
function updateIncidents(home, change, log = defaultLog3) {
  return serialised2(() => {
    const read = readIncidents(home, log);
    if (read.error !== null) return null;
    const next = change(read.incidents);
    if (next === null) return null;
    const incidents = capIncidents(next);
    writeStoreFileAtomically(
      { tracesDir: join8(home, TRACES_DIR_NAME) },
      join8(home, ROLE_FALLBACK_STATE_FILE),
      `${JSON.stringify({ version: 1, incidents }, null, 2)}
`
    );
    return incidents;
  });
}
export {
  bmRoleSchema,
  fallbackIncidentSchema,
  forgetModelCosts,
  forgetModes,
  handleRolesSaveSettings,
  handleRolesSettings,
  readIncidents,
  readRoleExtras,
  readSetupState,
  removeAllBmEntries,
  roleSettingsRevision,
  saveRoleExtra,
  updateIncidents,
  updateSetupState
};
