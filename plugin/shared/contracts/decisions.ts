import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { alertSchema } from "../alerts";
import { decisionSchema, decisionStatusSchema } from "../decisions";
import { MAX_THREAD_TEXT_CHARS, decisionThreadSchema } from "../decision-threads";
import { interventionEntrySchema } from "../interventions";
import { workspaceIdSchema } from "./persisted";

/**
 * The Inbox's RPCs: the owner's decisions (`decisions.*`) and the alerts
 * that need the owner's eyes without being one (`inbox.alerts`). The records
 * themselves are `shared/decisions.ts` and `shared/alerts.ts`.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Decisions (autonomy design §A.3, §A.4, §A.6; ADR-017): one stored record per
// question to the owner, read and answered the same way on every surface.
// ---------------------------------------------------------------------------

/** Most decisions `decisions.list` returns, and its default. */
export const DECISION_LIST_MAX = 500;
export const DECISION_LIST_DEFAULT = 200;

/**
 * `decisions.list` — reads only.
 *
 * - `inbox`: the unsettled decisions (`open`, `needs-confirmation`) of every
 *   workspace, or of `workspaceId`, oldest asked first.
 * - `workspace`: every stored decision of `workspaceId`, newest asked first.
 * - `request`: every stored decision of `requestId` (in `workspaceId` when
 *   given, else in any workspace), newest asked first.
 *
 * `status` keeps only that status. At most `limit` come back; `truncated`
 * says more matched. No usable data folder reads as none.
 */
export const decisionsListRpc = defineRpc({
  name: "decisions.list",
  input: z
    .object({
      scope: z.enum(["inbox", "workspace", "request"]),
      workspaceId: workspaceIdSchema.optional(),
      requestId: z.string().min(1).optional(),
      status: decisionStatusSchema.optional(),
      limit: z.number().int().min(1).max(DECISION_LIST_MAX).optional(),
    })
    .refine((input) => input.scope !== "workspace" || input.workspaceId !== undefined, {
      message: "scope workspace needs a workspaceId",
    })
    .refine((input) => input.scope !== "request" || input.requestId !== undefined, {
      message: "scope request needs a requestId",
    }),
  output: z.object({ decisions: z.array(decisionSchema), truncated: z.boolean() }),
});

/** `decisions.get` — one decision; unknown → `E_DECISION_NOT_FOUND`. */
export const decisionsGetRpc = defineRpc({
  name: "decisions.get",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ decision: decisionSchema }),
});

/**
 * `decisions.answer` — the owner answers an unsettled decision with exactly
 * one of `optionKey` or `words` (else `E_DECISION_ANSWER_INVALID`). The answer
 * and its one-use grant are recorded, then the plugin delivers it.
 *
 * - Unknown id → `E_DECISION_NOT_FOUND`; answered, superseded, withdrawn or
 *   expired → `E_DECISION_SETTLED` (the message names the replacing id).
 * - An answer that would grant `publish`, `deploy`, `real-data`, `migration`,
 *   `security` or `cost` needs `confirmed: true` (experience concept X-4),
 *   else `E_DECISION_NOT_CONFIRMED`. Nothing is written on any refusal.
 * - `via` is the surface the owner used: `inbox` (default) or `chat-card`.
 */
export const decisionsAnswerRpc = defineRpc({
  name: "decisions.answer",
  input: z.object({
    id: z.string().min(1),
    optionKey: z.string().min(1).optional(),
    words: z.string().optional(),
    confirmed: z.literal(true).optional(),
    via: z.enum(["inbox", "chat-card"]).optional(),
  }),
  output: z.object({ decision: decisionSchema }),
});

/**
 * `decisions.confirm` — the owner's tap on a decision that needs confirmation
 * (§A.5 c: "Answered in the Worker's chat? · Close · Keep open"): `answered:
 * true` closes it as answered in that chat, `false` returns it to `open`. A
 * decision not waiting for one → `E_DECISION_NOT_NEEDS_CONFIRMATION`; settled
 * → `E_DECISION_SETTLED`; unknown → `E_DECISION_NOT_FOUND`.
 */
export const decisionsConfirmRpc = defineRpc({
  name: "decisions.confirm",
  input: z.object({ id: z.string().min(1), answered: z.boolean() }),
  output: z.object({ decision: decisionSchema }),
});

/**
 * `decisions.ask` — Ask back (change-014 outcome 3): the owner asks the asker
 * of an open Worker question (`q:`) or Orchestrator decision (`o:`) about it.
 * The text is masked and stored in the decision's thread; the decision stays
 * open. The plugin delivers it to the asker as a `BM-ASK` notice through the
 * notice queue: `delivery` is `sent` (the asker was idle), `queued` (it gets
 * it at its next turn end) or `failed` (no asker found, or it is gone; the
 * question stays in the thread).
 *
 * - Unknown id → `E_DECISION_NOT_FOUND`; a held request (`h:`), a fallback
 *   incident (`f:`) or an override (`r:`) → `E_DECISION_NOT_ASKABLE`;
 *   answered, superseded, withdrawn or expired → `E_DECISION_SETTLED`; a text
 *   that is blank → `E_DECISION_ASK_INVALID`; the thread cannot be written →
 *   `E_DECISION_WRITE_FAILED`. Nothing is written or sent on any refusal.
 */
export const decisionsAskRpc = defineRpc({
  name: "decisions.ask",
  input: z.object({ id: z.string().min(1), text: z.string().min(1).max(MAX_THREAD_TEXT_CHARS) }),
  output: z.object({ thread: decisionThreadSchema, delivery: z.enum(["sent", "queued", "failed"]) }),
});

/**
 * `decisions.thread` — reads only: the Ask back thread of one decision, oldest
 * entry first; no entries when nobody asked. Unknown id →
 * `E_DECISION_NOT_FOUND`.
 */
export const decisionsThreadRpc = defineRpc({
  name: "decisions.thread",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ thread: decisionThreadSchema }),
});

export type DecisionsAskInput = z.infer<typeof decisionsAskRpc.input>;
export type DecisionsAskOutput = z.infer<typeof decisionsAskRpc.output>;
export type DecisionsThreadInput = z.infer<typeof decisionsThreadRpc.input>;
export type DecisionsThreadOutput = z.infer<typeof decisionsThreadRpc.output>;

export type DecisionsListInput = z.infer<typeof decisionsListRpc.input>;
export type DecisionsListOutput = z.infer<typeof decisionsListRpc.output>;
export type DecisionsGetInput = z.infer<typeof decisionsGetRpc.input>;
export type DecisionsAnswerInput = z.infer<typeof decisionsAnswerRpc.input>;
export type DecisionsConfirmInput = z.infer<typeof decisionsConfirmRpc.input>;
export type DecisionOutput = z.infer<typeof decisionsGetRpc.output>;

/**
 * `decisions.override` — the digest's Override (autonomy design §B.7, §B.9;
 * PRD REQ-125 b): opens a decision answered for the owner (by the policy or
 * an owner precedent) as a new owner decision `r:<uuid>` with the same
 * question and options, which `supersedes` it and stays open until the owner
 * answers it; the owner's answer then reaches the agent concerned. The
 * delegated decision records the reversal `overridden` (§B.3), which takes a
 * delegated class back to Shadow with an Inbox alert (§B.4). Answers nothing
 * and sends nothing itself.
 *
 * - `decision` is the override, `overridden` the delegated decision as it is
 *   now; `created` is false when it was overridden already (the same override
 *   comes back, whatever its status).
 * - Unknown id → `E_DECISION_NOT_FOUND`; still open, or answered by the owner
 *   (or, in Phase 1, the Orchestrator) → `E_DECISION_NOT_DELEGATED`;
 *   superseded, withdrawn or expired → `E_DECISION_SETTLED`; no usable data
 *   folder → `E_DATA_HOME_UNAVAILABLE`; the store cannot be written →
 *   `E_DECISION_WRITE_FAILED`. Nothing is written on any refusal.
 */
export const decisionsOverrideRpc = defineRpc({
  name: "decisions.override",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ decision: decisionSchema, overridden: decisionSchema, created: z.boolean() }),
});

export type DecisionsOverrideInput = z.infer<typeof decisionsOverrideRpc.input>;
export type DecisionsOverrideOutput = z.infer<typeof decisionsOverrideRpc.output>;

// ---------------------------------------------------------------------------
// The Inbox (autonomy design §A.8, §A.12): what needs the owner's eyes
// without being a decision.
// ---------------------------------------------------------------------------

/** Most alerts `inbox.alerts` returns. */
export const INBOX_ALERTS_MAX = 200;

/**
 * `inbox.alerts` — reads only. The OPEN alerts of the alerts store, of every
 * workspace or of `workspaceId`, in `ALERT_KINDS` order and oldest first
 * within a kind. At most `INBOX_ALERTS_MAX` come back; `truncated` says more
 * were open. No usable data folder reads as none.
 */
export const inboxAlertsRpc = defineRpc({
  name: "inbox.alerts",
  input: z.object({ workspaceId: workspaceIdSchema.optional() }),
  output: z.object({ alerts: z.array(alertSchema), truncated: z.boolean() }),
});

export type InboxAlertsInput = z.infer<typeof inboxAlertsRpc.input>;
export type InboxAlertsOutput = z.infer<typeof inboxAlertsRpc.output>;

// ---------------------------------------------------------------------------
// Decided for you (autonomy design §B.7, §B.9; PRD REQ-125 a): what the
// owner's policy and precedents answered since the owner last looked.
// ---------------------------------------------------------------------------

/** Most entries `inbox.digest` returns. */
export const INBOX_DIGEST_MAX = 100;

/** An ISO time a caller passes: one that `Date.parse` reads. */
const isoTimeInputSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "an ISO time" });

/**
 * `inbox.seen` — the Inbox is shown: records it in `<data folder>/inbox/seen.json`
 * and answers `since`, the time the owner last looked before this visit (null
 * when never), the start of Decided for you. A visit lasts while the Inbox is
 * shown again within `INBOX_VISIT_GAP_MS` of the last time (its polls, a
 * reload, a quick look elsewhere): within one visit `since` does not move, so
 * the digest survives a reload. `seenAt` is this showing's time.
 *
 * No usable data folder, or a file that cannot be read safely →
 * `E_DATA_HOME_UNAVAILABLE`; a file a newer paseo-bm wrote, or one that
 * cannot be written → `E_INBOX_WRITE_FAILED`.
 */
export const inboxSeenRpc = defineRpc({
  name: "inbox.seen",
  input: z.object({}),
  output: z.object({ since: z.string().nullable(), seenAt: z.string() }),
});

/** The most characters of an intervention's `reason` in the digest. */
export const DIGEST_INTERVENTION_REASON_MAX = 300;

/**
 * Whom an intervention in the digest was for: a Manager, a Worker, or the
 * owner (advice); null when the stores cannot tell.
 */
export const digestTargetRoleSchema = z.enum(["manager", "worker", "owner"]);
export type DigestTargetRole = z.infer<typeof digestTargetRoleSchema>;

/**
 * One intervention of the Orchestrator in Decided for you (autonomy design
 * §G.3 "Where it shows", bead `t9lm.23`): the log's entry as stored, plus
 * what the log itself does not keep — `targetRole`, and `reason`, the
 * Orchestrator's own words about it from the store that keeps them (a
 * command's `why:`, an answer's reason, the advice's question), redacted,
 * on one line, at most `DIGEST_INTERVENTION_REASON_MAX` characters; null
 * when none is kept.
 */
export const digestInterventionSchema = interventionEntrySchema.extend({
  targetRole: digestTargetRoleSchema.nullable(),
  reason: z.string().max(DIGEST_INTERVENTION_REASON_MAX).nullable(),
});
export type DigestIntervention = z.infer<typeof digestInterventionSchema>;

/**
 * `inbox.digest` — reads only. The decisions answered for the owner (`by:
 * policy` or `by: precedent`) after `since` (every one when absent), of every
 * workspace or of `workspaceId`, the latest answer first. Owner answers are
 * never in it. At most `INBOX_DIGEST_MAX` come back; `truncated` says more
 * matched. No usable data folder reads as none.
 *
 * `interventions` (§G.3, bead `t9lm.23`, additive): the Orchestrator's
 * interventions logged after `since`, of every workspace or of
 * `workspaceId`, the latest first, with the outcome the check has settled so
 * far; at most `INBOX_DIGEST_MAX`, `interventionsTruncated` saying more
 * matched. A log that cannot be read reads as none (one log line): it never
 * costs the Inbox its decisions.
 */
export const inboxDigestRpc = defineRpc({
  name: "inbox.digest",
  input: z.object({ since: isoTimeInputSchema.optional(), workspaceId: workspaceIdSchema.optional() }),
  output: z.object({
    decisions: z.array(decisionSchema),
    truncated: z.boolean(),
    interventions: z.array(digestInterventionSchema),
    interventionsTruncated: z.boolean(),
  }),
});

export type InboxSeenOutput = z.infer<typeof inboxSeenRpc.output>;
export type InboxDigestInput = z.infer<typeof inboxDigestRpc.input>;
export type InboxDigestOutput = z.infer<typeof inboxDigestRpc.output>;
