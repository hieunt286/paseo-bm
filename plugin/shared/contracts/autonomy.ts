import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { autonomyPolicySchema, autonomySetBoundaryInputSchema, autonomySetChallengerInputSchema, autonomySetInputSchema } from "../autonomy";
import { agreementLedgerSchema } from "../autonomy-ledger";
import { precedentSaveInputSchema, precedentSchema } from "../precedents";
import { workspaceIdSchema } from "./persisted";

/**
 * Calibrated autonomy (autonomy design Part B, ADR-018): the agreement
 * ledger, the owner's policy per project and decision class, and the
 * precedents. The owner's surfaces and the evaluation suite call these; no
 * agent tool does.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// The agreement ledger (autonomy design §B.3, ADR-018).
// ---------------------------------------------------------------------------

/**
 * `autonomy.ledger` — reads only (autonomy design §B.3, ADR-018). The
 * agreement ledger over the stored decisions, of every project or of
 * `workspaceId`: per project × class × predictor, the owner's answers counted,
 * agreed and unread, their first and last time and the decisions reversed;
 * and the decisions the policy or a precedent answered, overridden and
 * reversed. A class the policy demoted counts only the owner's answers given
 * since its last demotion (§B.4); the delegated figures are whole. Numbers
 * and times only: never a prediction, so never one of an unsettled decision.
 * No usable data folder reads as none.
 */
export const autonomyLedgerRpc = defineRpc({
  name: "autonomy.ledger",
  input: z.object({ workspaceId: workspaceIdSchema.optional() }),
  output: agreementLedgerSchema,
});

export type AutonomyLedgerInput = z.infer<typeof autonomyLedgerRpc.input>;
export type AutonomyLedgerOutput = z.infer<typeof autonomyLedgerRpc.output>;

// ---------------------------------------------------------------------------
// Settings → Autonomy (autonomy design §B.2, §B.9, ADR-018; PRD REQ-121): the
// owner's policy per project and decision class (`shared/autonomy.ts`). The
// owner's surfaces and the evaluation suite call these; no agent tool does.
// ---------------------------------------------------------------------------

/**
 * `autonomy.policy` — reads only. The whole policy, or one project's with
 * `workspaceId`. An absent cell is `owner`; no usable data folder, or a store
 * that cannot be read, reads as the empty policy (every cell `owner`).
 */
export const autonomyPolicyRpc = defineRpc({
  name: "autonomy.policy",
  input: z.object({ workspaceId: workspaceIdSchema.optional() }),
  output: z.object({ policy: autonomyPolicySchema }),
});

/**
 * `autonomy.set` — one cell `{ workspaceId, class, mode }`, returning the whole
 * policy. `delegate` for release, data, security or cost →
 * `E_AUTONOMY_OWNER_ONLY`, confirmed or not; `delegate` without
 * `confirmed: true` → `E_AUTONOMY_NOT_CONFIRMED`; it records `predictor`
 * (default `recommended`). An unknown project, class or mode →
 * `E_AUTONOMY_INVALID`; no usable data folder → `E_DATA_HOME_UNAVAILABLE`; a
 * store written by a newer paseo-bm, or one that cannot be written →
 * `E_AUTONOMY_WRITE_FAILED`. Nothing is written on any refusal. Eligibility is
 * not checked here (§B.9). The owner's change of a cell ends its
 * `autonomy-demoted` alert (§B.4). Sends nothing to any agent.
 */
export const autonomySetRpc = defineRpc({
  name: "autonomy.set",
  input: autonomySetInputSchema,
  output: z.object({ policy: autonomyPolicySchema }),
});

/**
 * `autonomy.reset` — every class of one project back to `owner` in one write
 * (REQ-121 d), with no confirmation; other projects, the challenger and the
 * classes' last demotions are untouched, and the project's `autonomy-demoted`
 * alerts end. Returns the whole policy. Same refusals as `autonomy.set`'s
 * store ones.
 */
export const autonomyResetRpc = defineRpc({
  name: "autonomy.reset",
  input: z.object({ workspaceId: workspaceIdSchema }),
  output: z.object({ policy: autonomyPolicySchema }),
});

/**
 * `autonomy.set-challenger` — one project's Orchestrator challenger on or off
 * (autonomy design §B.3, §B.9; off by default, DQ-4), returning the whole
 * policy. No confirmation: it only asks the Orchestrator to predict the
 * owner's answers, which the owner never sees before answering. An unknown
 * project or a value that is not a boolean → `E_AUTONOMY_INVALID`; no usable
 * data folder → `E_DATA_HOME_UNAVAILABLE`; a store written by a newer
 * paseo-bm, or one that cannot be written → `E_AUTONOMY_WRITE_FAILED`.
 * Nothing is written on any refusal. Sends nothing to any agent.
 */
export const autonomySetChallengerRpc = defineRpc({
  name: "autonomy.set-challenger",
  input: autonomySetChallengerInputSchema,
  output: z.object({ policy: autonomyPolicySchema }),
});

/**
 * `autonomy.set-boundary` — one project's action boundary on or off (autonomy
 * design §D.2, change-010 C2–C4; off by default), returning the whole policy.
 * Both directions need `confirmed: true` (`E_AUTONOMY_NOT_CONFIRMED`): on,
 * Workers and Reviewers created afterwards in the project start in the least
 * permissive mode and the plugin holds what leaves the workspace; off, they
 * start in today's modes, and agents created while it was on are still
 * answered. Off removes the entry and clears the project's `boundary-off`
 * alerts. An unknown project or a value that is not a boolean →
 * `E_AUTONOMY_INVALID`; no usable data folder → `E_DATA_HOME_UNAVAILABLE`; a
 * store written by a newer paseo-bm, or one that cannot be written →
 * `E_AUTONOMY_WRITE_FAILED`. Nothing is written on any refusal. The owner's
 * only: no agent tool and no prepared change calls it (change-010 C3).
 */
export const autonomySetBoundaryRpc = defineRpc({
  name: "autonomy.set-boundary",
  input: autonomySetBoundaryInputSchema,
  output: z.object({ policy: autonomyPolicySchema }),
});

export type AutonomyPolicyOutput = z.infer<typeof autonomyPolicyRpc.output>;
export type AutonomySetOutput = z.infer<typeof autonomySetRpc.output>;

// ---------------------------------------------------------------------------
// Precedents (autonomy design §B.6, §B.9; PRD REQ-124): the owner's standing
// answers per subject, in one project or in all (`shared/precedents.ts`). The
// owner's surfaces call these — Save as precedent on a decision card, and
// Settings → Autonomy; no agent tool does.
// ---------------------------------------------------------------------------

/**
 * `precedents.list` — reads only. The ACTIVE precedents (not expired, ended or
 * superseded), newest first: every one, or with `workspaceId` that project's
 * and the global ones. No usable data folder, or a store that cannot be read,
 * reads as none.
 */
export const precedentsListRpc = defineRpc({
  name: "precedents.list",
  input: z.object({ workspaceId: workspaceIdSchema.optional() }),
  output: z.object({ precedents: z.array(precedentSchema) }),
});

/**
 * `precedents.save` — a new precedent, lasting `expiresInDays` (default 30).
 * With `decisionId`: the owner's answered decision with a subject gives the
 * subject and, unless `text` is given, the text (the option's label or the
 * owner's words); `scope` is `all` or that decision's workspace. Without it:
 * `scope` (`all` or a workspace id), `subject` and `text`. An active precedent
 * of the same scope and subject is superseded (`superseded` names it).
 * Refusals: an input that is not a precedent, or a decision not answered by
 * the owner or without a subject → `E_PRECEDENT_INVALID`; an unknown decision
 * → `E_DECISION_NOT_FOUND`; no usable data folder → `E_DATA_HOME_UNAVAILABLE`;
 * a store written by a newer paseo-bm, or one that cannot be written →
 * `E_PRECEDENT_WRITE_FAILED`. Nothing is written on any refusal.
 */
export const precedentsSaveRpc = defineRpc({
  name: "precedents.save",
  input: precedentSaveInputSchema,
  output: z.object({ precedent: precedentSchema, superseded: z.array(z.string()) }),
});

/**
 * `precedents.end` — the precedent expires now. One already inactive is
 * returned as it is; an unknown id → `E_PRECEDENT_NOT_FOUND`. Same store
 * refusals as `precedents.save`.
 */
export const precedentsEndRpc = defineRpc({
  name: "precedents.end",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ precedent: precedentSchema }),
});

export type PrecedentsListOutput = z.infer<typeof precedentsListRpc.output>;
export type PrecedentsSaveOutput = z.infer<typeof precedentsSaveRpc.output>;
export type PrecedentsEndOutput = z.infer<typeof precedentsEndRpc.output>;
