import { z } from "zod";

/**
 * The shapes paseo-bm keeps on disk and reads back across versions: the
 * identifiers and role names every record carries, the pieces of a trace
 * record, and the trace store's record and metadata (Dashboard design §3.2,
 * §3.3, §4.1).
 *
 * The bottom of the contracts: it imports no other contract module.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Identifiers and roles.
// ---------------------------------------------------------------------------

/**
 * The three roles with a fallback chain: the value of the `bm.role` label of a
 * Manager, a Worker or a Reviewer.
 *
 * Kept at three when `bm-orchestrator` came (orchestrator design §3.2): this
 * enum is also the schema of the fallback chain (`fallbackSettingsSchema`,
 * `roles.save-fallback`) and of `fallbackIncidentSchema`, which 0.4.1 reads
 * back from `role-fallback-state.json`. A place that lists every role uses
 * `setupRoleWithOrchestratorSchema`.
 */
export const bmRoleSchema = z.enum(["manager", "worker", "reviewer"]);

/**
 * Every role the plugin registers: the three of `bmRoleSchema` and the
 * assessment role `orchestrator` (`bm-orchestrator`, orchestrator design §3.1).
 */
export const setupRoleWithOrchestratorSchema = z.enum(["manager", "worker", "reviewer", "orchestrator"]);

/** Identifier of a Paseo workspace, as returned by the Paseo SDK. */
export const workspaceIdSchema = z.string().min(1);

/** Identifier of a Paseo agent, as returned by the Paseo SDK. */
export const agentIdSchema = z.string().min(1);

/**
 * Role shown for a listed agent: one of the four roles, or `unknown` when the
 * `bm.role` label is missing or holds another value (Technical Design §7.3).
 */
export const agentRoleSchema = z.enum(["manager", "worker", "reviewer", "orchestrator", "unknown"]);

export type BmRole = z.infer<typeof bmRoleSchema>;
/** Any registered role, the Orchestrator included. */
export type SetupRoleWithOrchestrator = z.infer<typeof setupRoleWithOrchestratorSchema>;

// ---------------------------------------------------------------------------
// The pieces a trace record is made of (Dashboard design §4.1).
// ---------------------------------------------------------------------------

/** One traceable piece of evidence behind a derived conclusion (design §4.1). */
export const evidenceSchema = z.object({
  /**
   * `skill`: the agent loaded an agent skill; `detail` is the skill name.
   * `compaction`: the provider compacted the agent's context (autonomy design
   * §G.2); `detail` is the trigger, or `unknown`.
   */
  kind: z.enum(["report", "shell", "file", "agent", "timeline", "skill", "compaction"]),
  detail: z.string(),
  agentId: agentIdSchema.nullable(),
  at: z.string().nullable(),
  /**
   * A `compaction` only, added in Phase 2 (autonomy design §G.2) and optional
   * like every later field of a record: how it was started, and the context
   * size before it. `null` when the provider did not say.
   */
  trigger: z.enum(["auto", "manual"]).nullable().optional(),
  preTokens: z.number().int().nonnegative().nullable().optional(),
  /**
   * A `shell` entry only, added in Phase 3 (autonomy design §C.1), optional so a
   * record written before it still parses: the call's timeline `status`
   * (`running | completed | failed | canceled` today, kept as a string so a new
   * one never costs the record), its exit code when the provider gave one
   * (`null` when it said there was none), the folder it ran in (masked like the
   * command) and the timeline's `callId`. A call's running and finished entries
   * share one `callId`; the latest state wins.
   */
  status: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  cwd: z.string().optional(),
  callId: z.string().optional(),
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
  /**
   * One turn's record only (autonomy design §G.2): the context in use at the
   * turn's end and the window, when the provider reports them
   * (`contextWindowUsedTokens` / `contextWindowMaxTokens`). Absent means not
   * reported — never zero. A sum over turns never carries them.
   */
  contextUsed: z.number().int().nonnegative().optional(),
  contextMax: z.number().int().positive().optional(),
});

/** Request size the Worker classified itself into (REQ-036, REQ-045e). */
export const tierSchema = z.enum(["Small", "Medium", "Large"]);

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

/**
 * Milestone of a `BM-REPORT` block (roles/worker.md, Reporting). `stopped`
 * (design §16.11) is a bound Worker's report on a stop: not finished and not
 * blocked, so every reader treats it as neither. A build older than it fails
 * to read a record holding one and skips that record (the downgrade exception
 * of §16.11).
 */
export const reportPhaseSchema = z.enum([
  "received",
  "documents-done",
  "beads-done",
  "bead-implemented",
  "blocked",
  "finished",
  "stopped",
]);

/**
 * One parsed `BM-REPORT`. Every field is nullable on purpose: the parser is
 * required to be tolerant, and a field it could not read becomes "unknown"
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
  /**
   * Choices the Worker made on its own, for the user to overturn (design delta
   * 20260924-instruction-quality, owner decision P2-2). Absent in reports
   * written before the field existed.
   */
  decided: z.array(z.string()).optional(),
  blockers: z.string().nullable(),
  guardrail: guardrailReportSchema.nullable(),
  /**
   * The outgoing Worker's handoff note (autonomy design §G.6 step 1), only on
   * the report the plugin asked it for; absent otherwise.
   */
  handoffNote: z.string().optional(),
  unparsedFields: z.array(z.string()),
  /**
   * Bead-id list fields the parser could not fully read (delta 20260917 §5.1):
   * their ids are a lower bound. Defaulted so records written before the field
   * existed still pass `traceRecordSchema` (the store drops undeclared keys).
   */
  incompleteFields: z.array(z.string()).default([]),
  /**
   * The outbox record a tool-built report came from (design §16.7, §16.11):
   * the same report is read once per record id. Absent on a report parsed
   * from a message's text.
   */
  recordId: z.string().optional(),
});

/** One parsed `BM-REVIEW` from a Reviewer (roles/reviewer.md). */
export const parsedReviewSchema = z.object({
  agentId: agentIdSchema,
  at: z.string(),
  batchId: z.string().nullable(),
  verdict: z.string().nullable(),
  blockingCount: z.number().int().nonnegative().nullable(),
  /** The outbox record a tool-built review came from (design §16.7, §16.11); absent otherwise. */
  recordId: z.string().optional(),
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

/** `<data folder>/traces/meta.json`. */
export const traceStoreMetaSchema = z.object({
  schemaVersion: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `<data folder>/traces/<workspaceId>/meta.json` — lets an orphaned workspace still be recognisable (REQ-057a). */
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
 *
 * `provider` was added by delta 20260921 §4.2.7 (F7) so a model missing from
 * the bundled price table can be priced from its provider's model list. It is
 * optional for the same reason `runtime` is: records written before it, and
 * readers built before it, keep working — `v` stays 1, nothing migrates. `null`
 * when the snapshot names no provider.
 *
 * `boundary` (autonomy design §D.2, change-010 C9) is the agent's
 * `bm.boundary` label at that turn: whether it ran under the action boundary.
 * Optional and additive like `provider`; absent when the agent carries no
 * such label, which the replay reads as unknown.
 */
export const traceRuntimeSchema = z.object({
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  modeId: z.string().nullable(),
  provider: z.string().nullable().optional(),
  boundary: z.enum(["on", "off"]).optional(),
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
  /**
   * The paseo-bm version that wrote the record (evaluation design §3). Optional
   * for the same reason as `runtime`: records written before it have none and
   * are attributed by time window; `v` stays 1.
   */
  pluginVersion: z.string().nullable().optional(),
  /**
   * How many tool calls the turn made (autonomy design §G.2), so a context
   * size per model call can be estimated. Optional like `runtime`: a record
   * written before it has none, and that reads as unknown, never zero.
   */
  toolCalls: z.number().int().nonnegative().optional(),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type Tier = z.infer<typeof tierSchema>;
export type GuardrailReport = z.infer<typeof guardrailReportSchema>;
export type TraceMessage = z.infer<typeof traceMessageSchema>;
export type ParsedReport = z.infer<typeof parsedReportSchema>;
export type ParsedReview = z.infer<typeof parsedReviewSchema>;
export type ReportPhase = z.infer<typeof reportPhaseSchema>;
export type TraceRecord = z.infer<typeof traceRecordSchema>;
export type TraceRuntime = z.infer<typeof traceRuntimeSchema>;
export type TraceStoreMeta = z.infer<typeof traceStoreMetaSchema>;
export type TraceWorkspaceMeta = z.infer<typeof traceWorkspaceMetaSchema>;
