import { z } from "zod";
import { GATE_CATEGORIES, isGateCategory, type GateCategory } from "./decision-gate";
import { MAX_COMMAND_BLOCK_CHARS } from "./orchestrator-command";

/**
 * Shapes the Orchestrator keeps in `<data folder>/orchestrator/` (Orchestrator
 * design §4.2, §4.3, §5.4).
 *
 * The rule ids live here, not beside the rules, because several places name
 * them — the scorer, the stall pass and the tools — and the store must not
 * import the scorer to validate a file.
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** The seven first-release rules, in the order of design §4.2. */
export const RULE_IDS = [
  "process.small-heavy",
  "process.no-review",
  "review.over-budget",
  "agent.failed-first-turn",
  "agent.model-corrected",
  "report.malformed",
  "manager.language-mismatch",
] as const;

export const ruleIdSchema = z.enum(RULE_IDS);
export type RuleId = z.infer<typeof ruleIdSchema>;

// ── settings.json (design §5.4, §6A) ────────────────────────────────────────

/**
 * One project with Autopilot on (design §6A, ADR-015). Only projects that have
 * it on are stored; turning it off removes the entry. `by` says where it was
 * turned on: `tab` through `orchestrator.set-autopilot` (the owner's switch —
 * no screen has it in Phase 1, Part B replaces Autopilot), or `chat`, the
 * Orchestrator on the owner's word in its chat.
 */
export const autopilotEntrySchema = z.object({
  enabled: z.literal(true),
  since: z.string(),
  by: z.enum(["tab", "chat"]).optional(),
  /**
   * The gate categories the owner allowed for this project (design §6B.5);
   * absent reads as none (`allowOf`). A name this plugin does not know is
   * dropped rather than failing the entry, so a newer file never turns
   * Autopilot off.
   */
  allow: z.array(z.unknown()).transform(knownCategories).optional(),
});
export type AutopilotEntry = z.infer<typeof autopilotEntrySchema>;

/** A big-decision category of the gate (design §6B.5). */
export const gateCategorySchema = z.enum(GATE_CATEGORIES);

/** The known categories of `values`, each once, in `GATE_CATEGORIES` order. */
export function knownCategories(values: readonly unknown[]): GateCategory[] {
  return GATE_CATEGORIES.filter((category) => values.some((value) => isGateCategory(value) && value === category));
}

/** The categories an Autopilot entry allows; none when the entry is absent or has no `allow`. */
export function allowOf(entry: AutopilotEntry | undefined): GateCategory[] {
  return entry?.allow ?? [];
}

/**
 * The Orchestrator's switches: Autopilot per project, keyed by workspace id.
 * The Watch for stalled work switch of `version` 2 and 3 files is gone
 * (autonomy design §A.8): stalled work is always watched and becomes an Inbox
 * alert. A `watch` field left in a file is ignored and dropped by the next write.
 */
export const orchestratorSettingsSchema = z.object({
  version: z.literal(3),
  autopilot: z.record(z.string(), autopilotEntrySchema),
});
export type OrchestratorSettings = z.infer<typeof orchestratorSettingsSchema>;

/** No project on Autopilot. A first-design (`version: 1`) or `version: 2` file reads as this. */
export const DEFAULT_ORCHESTRATOR_SETTINGS: OrchestratorSettings = { version: 3, autopilot: {} };

// ── model-corrections.json (design §4.3) ────────────────────────────────────

export const modelCorrectionSchema = z.object({
  at: z.string(),
  /** The paseo-bm provider alias the agent was created with, e.g. `bm-worker`. */
  alias: z.string(),
  /** The model the creator asked for, which the hook replaced. */
  requested: z.string(),
  /** The model of the role's profile, which the agent got instead. */
  profileModel: z.string(),
  cwd: z.string(),
});
export type ModelCorrection = z.infer<typeof modelCorrectionSchema>;

export const modelCorrectionLogSchema = z.object({
  version: z.literal(1),
  entries: z.array(modelCorrectionSchema),
});

// ── proposals.json (design §5.3, §5.4, §6A, §7) ─────────────────────────────

/** Longest fields of a proposal (design §5.3). */
export const MAX_PROPOSAL_SITUATION_CHARS = 200;
export const MAX_PROPOSAL_COMMAND_CHARS = 4_000;
export const MAX_PROPOSAL_REASON_CHARS = 300;
/** Longest question, and recommendation, of a decision the Orchestrator puts to the owner (design §6A `bm_ask_owner`). */
export const MAX_DECISION_QUESTION_CHARS = 1_000;
export const MAX_DECISION_RECOMMENDATION_CHARS = 500;

/**
 * The line the plugin appended, once, to every command the Orchestrator sent
 * itself with `bm_send_command` (design §6A, ADR-015 decision 4) before every
 * command became a `BM-COMMAND` block whose `limits:` field carries the limits
 * (design §6B.1). Nothing appends it any more; it is kept to read the commands
 * stored before (their `sentText`).
 */
export const ORCHESTRATOR_LIMIT_LINE =
  "— Sent by the Beads Orchestrator for the owner. Do not commit, push or deploy, and do not touch real data (production databases, live services), unless the owner has said so. This line is for you: do not repeat it to the owner.";
/** What separates a command from the limit line. */
export const ORCHESTRATOR_LIMIT_SEPARATOR = "\n\n";
/**
 * The longest text sent: a command of at most 4,000 characters plus the limit
 * line, or a whole `BM-COMMAND` block (design §6B.1), whichever is longer.
 */
export const MAX_SENT_TEXT_CHARS = Math.max(
  MAX_PROPOSAL_COMMAND_CHARS + ORCHESTRATOR_LIMIT_SEPARATOR.length + ORCHESTRATOR_LIMIT_LINE.length,
  MAX_COMMAND_BLOCK_CHARS,
);

/** At most this many options on a decision, each 1–80 characters (design §6B.4 `bm_ask_owner`). */
export const MAX_DECISION_OPTIONS = 5;
export const MAX_DECISION_OPTION_CHARS = 80;

/**
 * Who a command came from: the Orchestrator sending it itself — on Autopilot,
 * or on the owner's word in its chat (design §6A). `orchestrator` (a proposal
 * the owner approved) and `user` (the owner's own typed command) are read in
 * files written before Phase 1 (autonomy design §A.14); `isSentCommand` leaves
 * them out.
 */
export const proposalSourceSchema = z.enum(["orchestrator", "user", "autopilot", "chat"]);
export type ProposalSource = z.infer<typeof proposalSourceSchema>;

export const proposalStatusSchema = z.enum(["pending", "sent", "dismissed", "failed"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

/** What the notice queue did with a sent command: delivered now, or at the Manager's turn end. */
export const proposalOutcomeSchema = z.enum(["sent", "queued"]);
export type ProposalOutcome = z.infer<typeof proposalOutcomeSchema>;

/**
 * `command`: a command for a Manager or a Worker. `decision`: a question the
 * Orchestrator put to the owner before decisions became stored objects
 * (autonomy design §A.3) — `command` held the question, `reason` the
 * recommendation, `sentText` the owner's answer. Read so that an older file
 * still parses; `isSentCommand` leaves it out. An entry written before
 * decisions existed reads as a command.
 */
export const proposalKindSchema = z.enum(["command", "decision"]);
export type ProposalKind = z.infer<typeof proposalKindSchema>;

/**
 * Whose command it is (design §6B.4, §6B.7): a Manager's, or a Worker's sent
 * directly by `bm_direct_worker`. Absent on a stored entry reads as
 * `manager` (`commandTargetOf`).
 */
export const commandTargetSchema = z.enum(["manager", "worker"]);
export type CommandTarget = z.infer<typeof commandTargetSchema>;

/**
 * One entry of `proposals.json`, in every shape the file has held, so an older
 * file still parses and the evaluation's reader can count it. This build
 * writes only commands the Orchestrator sent itself (`isSentCommand`); the
 * proposal era's entries — `pending`, `dismissed` or `failed` proposals, the
 * commands the owner approved or typed on its former screen and the decisions
 * asked before the decision store — are ignored on read and dropped by the
 * next write (autonomy design §A.14).
 *
 * A command names its Manager (or, sent to a Worker, its Worker) and keeps its
 * reason within 300 characters; a decision may name no Manager, its question
 * is at most 1,000 characters and its recommendation 500.
 */
export const proposalSchema = z
  .object({
    id: z.string().min(1),
    at: z.string(),
    kind: proposalKindSchema.default("command"),
    workspaceId: z.string().min(1),
    managerId: z.string().min(1).nullable(),
    requestId: z.string().min(1).nullable(),
    situation: z.string().max(MAX_PROPOSAL_SITUATION_CHARS),
    command: z.string().min(1).max(MAX_PROPOSAL_COMMAND_CHARS),
    reason: z.string().max(MAX_DECISION_RECOMMENDATION_CHARS),
    source: proposalSourceSchema,
    status: proposalStatusSchema,
    settledAt: z.string().nullable(),
    /**
     * The text actually sent: the command as the user approved it, possibly
     * edited, or as `bm_send_command` sent it, limit line included; for a
     * decision, the owner's answer.
     */
    sentText: z.string().min(1).max(MAX_SENT_TEXT_CHARS).nullable(),
    outcome: proposalOutcomeSchema.nullable(),
    error: z.string().nullable(),
    /**
     * A decision's answers to choose from, shown as one button each (design
     * §6B.4 `bm_ask_owner`): at most 5, each 1–80 characters. Never on a command.
     */
    options: z.array(z.string().min(1).max(MAX_DECISION_OPTION_CHARS)).max(MAX_DECISION_OPTIONS).optional(),
    /** A command's target; absent is `manager`. Never on a decision. */
    to: commandTargetSchema.optional(),
    /** The Worker a `to: "worker"` command went to; `managerId` is then that Worker's Manager (who got the copy), or null. */
    workerId: z.string().min(1).optional(),
  })
  .superRefine((entry, context) => {
    if (entry.kind === "command") {
      if (entry.options !== undefined) context.addIssue({ code: "custom", path: ["options"], message: "only a decision has options" });
      if (entry.to === "worker") {
        if (entry.workerId === undefined) context.addIssue({ code: "custom", path: ["workerId"], message: "a Worker command names its Worker" });
      } else if (entry.workerId !== undefined) {
        context.addIssue({ code: "custom", path: ["workerId"], message: "only a Worker command names a Worker" });
      }
      if (entry.managerId === null && entry.to !== "worker") context.addIssue({ code: "custom", path: ["managerId"], message: "a command names its Manager" });
      if (entry.reason.length > MAX_PROPOSAL_REASON_CHARS) {
        context.addIssue({ code: "custom", path: ["reason"], message: `a command's reason is at most ${MAX_PROPOSAL_REASON_CHARS} characters` });
      }
    } else {
      if (entry.command.length > MAX_DECISION_QUESTION_CHARS) {
        context.addIssue({ code: "custom", path: ["command"], message: `a decision's question is at most ${MAX_DECISION_QUESTION_CHARS} characters` });
      }
      if (entry.to !== undefined || entry.workerId !== undefined) context.addIssue({ code: "custom", path: ["to"], message: "a decision has no target" });
    }
  });
export type Proposal = z.infer<typeof proposalSchema>;

/** Whose command an entry is: `manager` unless it was sent to a Worker. */
export function commandTargetOf(proposal: Pick<Proposal, "to">): CommandTarget {
  return proposal.to ?? "manager";
}

/**
 * True for the one kind of entry this build keeps in `proposals.json`: a
 * command the Orchestrator sent itself (`status: sent`, source `autopilot` or
 * `chat`). The loop guard and a project's last action read these.
 */
export function isSentCommand(entry: Pick<Proposal, "kind" | "status" | "source">): boolean {
  return entry.kind === "command" && entry.status === "sent" && (entry.source === "autopilot" || entry.source === "chat");
}

/** The file's frame; each entry is validated on its own, so one bad entry costs only itself. */
export const proposalLogSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.unknown()),
});

// ── stalls.json (design §5.4, §6B.3) ───────────────────────────────────────

/**
 * One entry of `stalls.json`: since autonomy design §A.8 only an interrupt
 * allowance (design §6B.3), open for `DANGER_ALLOWANCE_MS` from `raisedAt`.
 * The other fields are kept so older entries still validate.
 */
export const stallEntrySchema = z.object({
  raisedAt: z.string(),
  lastSeenAt: z.string(),
  clearedAt: z.string().nullable(),
  woke: z.boolean(),
});
export type StallEntry = z.infer<typeof stallEntrySchema>;

/**
 * The signals the live watch raises on a running Worker of an Autopilot
 * project, in the order of design §6B.3. `stuck`, `permission` and `danger`
 * are Inbox alerts too; each signal is one `worker.signal` event per Worker
 * turn (autonomy design §A.8).
 */
export const WORKER_SIGNALS = ["stuck", "permission", "danger", "failing", "heavy", "outside"] as const;
export const workerSignalSchema = z.enum(WORKER_SIGNALS);
export type WorkerSignal = z.infer<typeof workerSignalSchema>;

/** How long a `danger` signal lets the Orchestrator interrupt that Worker (design §6B.3, §6B.4). */
export const DANGER_ALLOWANCE_MS = 10 * 60_000;

/**
 * The file's frame; each entry is validated on its own. The one key kept is
 * `<ws>::<workerId>::danger-open@<time>` (an interrupt allowance); the stall,
 * event and Worker-signal keys of earlier builds are ignored and dropped by
 * the next write (autonomy design §A.8: the alerts file replaces them).
 */
export const stallRecordSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.unknown()),
});

// ── notes/<workspaceId>.json (design §6B.4 `bm_note`) ──────────────────────

/** A project keeps at most this many notes (the oldest go first), each 1–500 characters. */
export const MAX_NOTES = 20;
export const MAX_NOTE_CHARS = 500;

/** One note the Orchestrator keeps about a project; it outlives a replaced Orchestrator (ADR-016 decision 4). */
export const orchestratorNoteSchema = z.object({
  at: z.string(),
  text: z.string().min(1).max(MAX_NOTE_CHARS),
});
export type OrchestratorNote = z.infer<typeof orchestratorNoteSchema>;

/** The file's frame; each note is validated on its own. */
export const notesFileSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.unknown()),
});

// ── wakes.json (evaluation design §4, A-7) ─────────────────────────────────

/** At most this many workspaces are named on one wake. */
export const MAX_WAKE_WORKSPACES = 50;

/**
 * One wake of the Orchestrator by the plugin: a `BM-EVENTS` message the
 * notice queue delivered (`at`), and when that Orchestrator's turn ended
 * (`endedAt`, null until the plugin saw it end — or when a reload lost it).
 * Ids, times and a count only: never an event line or any other text. Whether
 * the wake ended with an action is read from the stores that record actions
 * (`shared/eval-metrics.ts`), not stored here.
 */
export const wakeEntrySchema = z.object({
  orchestratorId: z.string().min(1),
  at: z.string().min(1),
  endedAt: z.string().min(1).nullable(),
  /** The projects whose events the message carried, each once. */
  workspaceIds: z.array(z.string().min(1)).max(MAX_WAKE_WORKSPACES),
  /** How many events the message carried. */
  events: z.number().int().positive(),
});
export type WakeEntry = z.infer<typeof wakeEntrySchema>;

/** The file's frame; each wake is validated on its own. */
export const wakeLogSchema = z.object({
  version: z.literal(1),
  entries: z.array(z.unknown()),
});

// ── assessments/<workspaceId>.jsonl (design §5.4, §5.5) ─────────────────────

export const assessmentStatusSchema = z.enum(["pending", "done", "failed"]);
export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;

/** Token use of the assessment turn, when Paseo reported it. Every field optional. */
export const assessmentUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type AssessmentUsage = z.infer<typeof assessmentUsageSchema>;

/** The `traceId` of a workflow assessment: it covers the workspace, not one trace (design §5.4). */
export const WORKFLOW_ASSESSMENT_TRACE_ID = "workspace";

/** The requests a workflow assessment covered. */
export const assessmentScopeSchema = z.object({
  requestIds: z.array(z.string().min(1)),
});
export type AssessmentScope = z.infer<typeof assessmentScopeSchema>;

/**
 * One line of the assessment store. `result` is the `bm_assessment` payload,
 * validated before it is written, so the store keeps it as it came. `agentId`
 * is null on a `pending` line written before an agent took it up.
 *
 * A **workflow** assessment (design §5.4) is a line with `requestId: null`,
 * `traceId: "workspace"` and `scope: { requestIds }`; a line with that trace id
 * and no scope, or with a request id, is refused.
 */
export const assessmentLineSchema = z
  .object({
    v: z.literal(1),
    assessmentId: z.string().min(1),
    requestId: z.string().min(1).nullable(),
    traceId: z.string().min(1),
    agentId: z.string().min(1).nullable(),
    at: z.string(),
    status: assessmentStatusSchema,
    provider: z.string(),
    model: z.string().nullable(),
    result: z.unknown().optional(),
    raw: z.string().optional(),
    usage: assessmentUsageSchema.optional(),
    scope: assessmentScopeSchema.optional(),
  })
  .refine((line) => line.traceId !== WORKFLOW_ASSESSMENT_TRACE_ID || (line.requestId === null && line.scope !== undefined), {
    message: `a "${WORKFLOW_ASSESSMENT_TRACE_ID}" assessment has requestId null and a scope`,
  });
export type AssessmentLine = z.infer<typeof assessmentLineSchema>;
