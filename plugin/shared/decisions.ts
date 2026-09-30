/**
 * The decision model (autonomy design §A.3, ADR-017): a question to the owner
 * is one stored record — identity, request, asker, options with one
 * recommendation and their declared effects, lifecycle, answer, one-use grant
 * — rendered the same way on every surface.
 *
 * This module holds the schema and the **pure** transitions. The store
 * (`server/decision-store.ts`) persists what these functions return; the RPCs
 * (`server/decision-rpc.ts`) and the later materialiser, delivery and
 * Orchestrator tools call them. Nothing here reads a clock, a file or an agent:
 * every time comes in as an argument.
 *
 * `shared/`: Zod and plain values only, no Node or React Native imports.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabulary.
// ---------------------------------------------------------------------------

/**
 * The side effects an asker declares per option (§A.3). `none` declares that
 * the option has no effect; it is never granted.
 */
export const EFFECTS = [
  "none",
  "commit",
  "push",
  "publish",
  "deploy",
  "real-data",
  "migration",
  "dependency-install",
  "network",
  "outside-workspace",
  "security",
  "cost",
] as const;
export const effectSchema = z.enum(EFFECTS);
export type Effect = z.infer<typeof effectSchema>;

/**
 * Effects whose answer needs the owner's explicit confirmation on the tap
 * (experience concept X-4, owner 2026-09-29: "confirmation only for RELEASE /
 * DATA / SECURITY / COST"). `release` is `publish` and `deploy`; `data` is
 * `real-data` and `migration`.
 */
/** Effects of the classes release, data, security and cost (experience concept X-4): an answer granting one needs `confirmed`. A push is a release. */
export const CONFIRM_EFFECTS: readonly Effect[] = ["push", "publish", "deploy", "real-data", "migration", "security", "cost"];

export const DECISION_STATUSES = ["open", "needs-confirmation", "answered", "superseded", "withdrawn", "expired"] as const;
export const decisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

/** A decision in one of these can still be answered; every other status is final. */
export const UNSETTLED_STATUSES: readonly DecisionStatus[] = ["open", "needs-confirmation"];
export const SETTLED_STATUSES: readonly DecisionStatus[] = ["answered", "superseded", "withdrawn", "expired"];

/**
 * Who answered (§A.3): the owner, or the Orchestrator (`bm_decide`, a Worker's
 * question on the project's Autopilot, change-004). Additive: every answer
 * stored before it is the owner's.
 */
export const ANSWER_BY = ["owner", "orchestrator"] as const;
export const answerBySchema = z.enum(ANSWER_BY);
export type AnswerBy = z.infer<typeof answerBySchema>;

/**
 * Where the answer came from (§A.3): the owner's surface or chat, or
 * `autopilot` — the Orchestrator's answer under the project's Autopilot.
 */
export const ANSWER_VIA = ["inbox", "chat-card", "chat-manager", "chat-worker", "chat-orchestrator", "autopilot"] as const;
export const answerViaSchema = z.enum(ANSWER_VIA);
export type AnswerVia = z.infer<typeof answerViaSchema>;

/** The chats in which an owner message can make a decision `needs-confirmation` (§A.5 c). */
export const CHAT_VIA = ["chat-manager", "chat-worker", "chat-orchestrator"] as const;
export const chatViaSchema = z.enum(CHAT_VIA);
export type ChatVia = z.infer<typeof chatViaSchema>;

export const ASKER_ROLES = ["worker", "orchestrator", "plugin"] as const;

/** A granted answer allows its effects for one use within this long of the answer (REQ-112 b). */
export const GRANT_TTL_MS = 60 * 60 * 1000;

/** Longest question (§A.3). */
export const MAX_DECISION_TEXT_CHARS = 1000;
/** Longest option label; the same cap `bm-questions.ts` puts on an option's text. */
export const MAX_DECISION_LABEL_CHARS = 1000;
/** Most options on one decision; the same cap as `bm-questions.ts` `MAX_OPTIONS`. */
export const MAX_DECISION_OPTIONS_COUNT = 8;
/** Longest answer in the owner's own words. */
export const MAX_ANSWER_WORDS_CHARS = 4000;
/** Longest reason an answer carries (the Orchestrator's, `bm_decide`). */
export const MAX_ANSWER_REASON_CHARS = 300;
/** Longest body of a prepared command; the same cap as a proposal's command. */
export const MAX_PREPARED_BODY_CHARS = 4000;
/** A subject slug (§A.5: ≤ 60 characters of `[a-z0-9-]`). */
export const SUBJECT_PATTERN = /^[a-z0-9-]{1,60}$/;
/** An option key: a Worker's letter (`a`), or a word for a prepared action (`switch`). */
export const OPTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The deterministic id (§A.3): `q:<requestId>:<Qn>` for a Worker question,
 * `o:<uuid>` for an Orchestrator decision, `f:<incidentId>` for a fallback
 * incident. None holds whitespace.
 */
export const DECISION_ID_PATTERN = /^(?:q:\S+:Q\d{1,3}|o:[A-Za-z0-9-]{1,64}|f:\S{1,128})$/;

// ---------------------------------------------------------------------------
// Schema.
// ---------------------------------------------------------------------------

const isoTimeSchema = z.string().min(1);

/** What choosing an option runs (§A.3). */
export const preparedActionSchema = z.discriminatedUnion("kind", [
  /** Deliver the answer to the Worker that asked (implicit for Worker questions). */
  z.object({ kind: z.literal("answer-worker") }),
  /** A `BM-COMMAND` v2 to a Manager or a Worker (Orchestrator decisions, §A.7). */
  z.object({
    kind: z.literal("command"),
    to: z.enum(["manager", "worker"]),
    agentId: z.string().min(1),
    intent: z.enum(["answer", "continue", "redirect", "stop", "release", "other"]),
    body: z.string().min(1).max(MAX_PREPARED_BODY_CHARS),
    effects: z.array(effectSchema).max(EFFECTS.length),
  }),
  /** `fallback.act` on an incident (§A.5 d). */
  z.object({
    kind: z.literal("fallback"),
    action: z.enum(["switch", "wait", "resend", "dismiss"]),
    target: z.string().min(1),
  }),
]);
export type PreparedAction = z.infer<typeof preparedActionSchema>;

export const decisionOptionSchema = z.object({
  key: z.string().regex(OPTION_KEY_PATTERN),
  label: z.string().min(1).max(MAX_DECISION_LABEL_CHARS),
  recommended: z.boolean(),
  effects: z.array(effectSchema).max(EFFECTS.length),
  action: preparedActionSchema.optional(),
});
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const decisionAnswerSchema = z
  .object({
    by: answerBySchema,
    via: answerViaSchema,
    /** The option chosen, or null. */
    optionKey: z.string().regex(OPTION_KEY_PATTERN).nullable(),
    /** The owner's own words, or null. */
    words: z.string().min(1).max(MAX_ANSWER_WORDS_CHARS).nullable(),
    at: isoTimeSchema,
    /** Why this answer, in one line: the Orchestrator's (`bm_decide`); absent on the owner's answers. */
    reason: z.string().min(1).max(MAX_ANSWER_REASON_CHARS).optional(),
  })
  // Both null: the owner confirmed an answer typed in a chat (`decisions.confirm`),
  // whose text the plugin did not parse.
  .refine((answer) => answer.optionKey === null || answer.words === null, { message: "an answer is an option or words, not both" })
  // Only options, never own words, for the Orchestrator (change-004).
  .refine((answer) => answer.by === "owner" || (answer.optionKey !== null && answer.words === null), { message: "the Orchestrator answers with an option" })
  .refine((answer) => answer.via !== "autopilot" || answer.by === "orchestrator", { message: "only the Orchestrator answers on Autopilot" });
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;

export const decisionGrantSchema = z.object({
  effects: z.array(effectSchema).min(1),
  expiresAt: isoTimeSchema,
  usedAt: isoTimeSchema.nullable(),
});
export type DecisionGrant = z.infer<typeof decisionGrantSchema>;

export const decisionDeliverySchema = z.object({
  /** The agent the answer or action went to. */
  to: z.string().min(1),
  /** The notice-queue kind it went under (e.g. `answers:<requestId>`). */
  kind: z.string().min(1),
  at: isoTimeSchema,
  outcome: z.enum(["sent", "queued", "failed"]),
});
export type DecisionDelivery = z.infer<typeof decisionDeliverySchema>;

export const decisionSchema = z
  .object({
    id: z.string().regex(DECISION_ID_PATTERN),
    workspaceId: z.string().min(1),
    /** Null only for a fallback incident outside a request, or an Orchestrator decision about a whole project. */
    requestId: z.string().min(1).nullable(),
    askedBy: z.object({ role: z.enum(ASKER_ROLES), agentId: z.string().min(1).nullable() }),
    askedAt: isoTimeSchema,
    /** The Worker's report round, for grouping on one card; null for other askers. */
    round: z.number().int().nonnegative().nullable(),
    question: z.string().min(1).max(MAX_DECISION_TEXT_CHARS),
    subject: z.string().regex(SUBJECT_PATTERN).nullable(),
    options: z.array(decisionOptionSchema).max(MAX_DECISION_OPTIONS_COUNT),
    status: decisionStatusSchema,
    /** When the decision left `open`/`needs-confirmation` for good; null while unsettled. */
    settledAt: isoTimeSchema.nullable(),
    /** Set while `needs-confirmation`: the chat the owner's unparsed message was in, and when. */
    needsConfirmation: z.object({ via: chatViaSchema, at: isoTimeSchema }).nullable(),
    answer: decisionAnswerSchema.nullable(),
    grant: decisionGrantSchema.nullable(),
    delivery: decisionDeliverySchema.nullable(),
    supersedes: z.string().regex(DECISION_ID_PATTERN).nullable(),
    supersededBy: z.string().regex(DECISION_ID_PATTERN).nullable(),
  })
  .superRefine((decision, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (decision.options.filter((option) => option.recommended).length > 1) issue("at most one option is recommended");
    if (new Set(decision.options.map((option) => option.key)).size !== decision.options.length) issue("option keys are unique");
    if (decision.requestId === null && decision.id.startsWith("q:")) issue("a Worker question always has its request");
    if (decision.id.startsWith("q:") && decision.requestId !== null && !decision.id.startsWith(`q:${decision.requestId}:`)) {
      issue("a question id names its request");
    }
    const settled = isSettledStatus(decision.status);
    if (settled !== (decision.settledAt !== null)) issue("settledAt is set exactly when the decision is settled");
    if ((decision.status === "answered") !== (decision.answer !== null)) issue("an answer is stored exactly when the decision is answered");
    if (decision.grant !== null && decision.status !== "answered") issue("only an answered decision carries a grant");
    if ((decision.status === "superseded") !== (decision.supersededBy !== null)) issue("supersededBy is set exactly when the decision is superseded");
    if ((decision.status === "needs-confirmation") !== (decision.needsConfirmation !== null)) {
      issue("needsConfirmation is set exactly when the decision needs confirmation");
    }
    if (decision.answer?.optionKey != null && !decision.options.some((option) => option.key === decision.answer?.optionKey)) {
      issue("the answer names one of the options");
    }
  });
export type Decision = z.infer<typeof decisionSchema>;

// ---------------------------------------------------------------------------
// Reading a decision.
// ---------------------------------------------------------------------------

export function isSettledStatus(status: DecisionStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

/** True while the decision can still be answered (`open` or `needs-confirmation`). */
export function isAnswerable(decision: Pick<Decision, "status">): boolean {
  return !isSettledStatus(decision.status);
}

/** The effects of a list that can be granted: `none` dropped, each once, in `EFFECTS` order. */
export function realEffects(effects: readonly Effect[]): Effect[] {
  const named = new Set(effects);
  return EFFECTS.filter((effect) => effect !== "none" && named.has(effect));
}

/** Every effect the decision declares across its options (what an answer in own words grants). */
export function declaredEffects(decision: Pick<Decision, "options">): Effect[] {
  return realEffects(decision.options.flatMap((option) => option.effects));
}

/** The effects an answer grants: the chosen option's, or the decision's for own words. */
export function effectsOfAnswer(decision: Pick<Decision, "options">, answer: { optionKey?: string | null }): Effect[] {
  if (answer.optionKey == null) return declaredEffects(decision);
  const option = decision.options.find((entry) => entry.key === answer.optionKey);
  return option === undefined ? [] : realEffects(option.effects);
}

/** True when granting these effects needs the owner's explicit confirmation (X-4). */
export function needsOwnerConfirmation(effects: readonly Effect[]): boolean {
  return effects.some((effect) => CONFIRM_EFFECTS.includes(effect));
}

/** What kind of asker the id names, or null for an id that is not a decision id. */
export function decisionKindOf(id: string): "question" | "orchestrator" | "fallback" | null {
  if (!DECISION_ID_PATTERN.test(id)) return null;
  return id.startsWith("q:") ? "question" : id.startsWith("o:") ? "orchestrator" : "fallback";
}

/** `q:<requestId>:<Qn>`. */
export function questionDecisionId(requestId: string, questionId: string): string {
  return `q:${requestId}:${questionId}`;
}

/** Epoch milliseconds of an ISO time; NaN when it does not parse. */
function timeOf(iso: string): number {
  return Date.parse(iso);
}

// ---------------------------------------------------------------------------
// Transitions. Each returns the next decision, or why it cannot move; none
// mutates its input.
// ---------------------------------------------------------------------------

export type TransitionRefusal =
  /** The decision is answered, superseded, withdrawn or expired. */
  | "settled"
  /** An answer names neither an option nor words, or both. */
  | "invalid-answer"
  /** An answer names an option the decision does not have. */
  | "unknown-option"
  /** `confirm` on a decision that is not `needs-confirmation`. */
  | "not-needs-confirmation"
  /** The decision has no grant. */
  | "no-grant"
  /** The grant was used already. */
  | "grant-used"
  /** The grant's hour is over. */
  | "grant-expired"
  /** An effect asked for is not in the grant. */
  | "effect-not-granted";

export type TransitionResult =
  | { ok: true; decision: Decision }
  | { ok: false; refusal: TransitionRefusal; message: string };

function refuse(refusal: TransitionRefusal, message: string): TransitionResult {
  return { ok: false, refusal, message };
}

/** Who answered, for a refusal: "the owner" or "the Orchestrator". */
export function answeredByText(by: AnswerBy): string {
  return by === "orchestrator" ? "the Orchestrator" : "the owner";
}

function refuseSettled(decision: Decision): TransitionResult {
  const by =
    decision.status === "superseded" && decision.supersededBy !== null
      ? ` by ${decision.supersededBy}`
      : decision.status === "answered" && decision.answer !== null
        ? ` by ${answeredByText(decision.answer.by)}`
        : "";
  return refuse("settled", `decision ${decision.id} is ${decision.status}${by}; it can no longer be answered`);
}

export interface AnswerInput {
  via: AnswerVia;
  optionKey?: string | null;
  words?: string | null;
  /** The time of the answer, ISO. */
  at: string;
  /** Who answers; the owner by default. The Orchestrator answers only with an option. */
  by?: AnswerBy;
  /** Why, in one line (trimmed, at most `MAX_ANSWER_REASON_CHARS`); none by default. */
  reason?: string | null;
}

/**
 * Answers an unsettled decision with one option or the owner's own words
 * (trimmed). The answer grants the chosen option's declared effects — or, for
 * own words, every effect the decision declares — for one use until
 * `at + GRANT_TTL_MS`; an answer that grants nothing carries no grant. The
 * Orchestrator's answer (`by: orchestrator`) is always an option, grants what
 * the owner's choice of it would, and keeps its reason.
 */
export function answerDecision(decision: Decision, input: AnswerInput): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  const by = input.by ?? "owner";
  const optionKey = input.optionKey ?? null;
  const words = input.words == null ? null : input.words.trim();
  const reason = input.reason == null ? null : input.reason.trim();
  if ((optionKey === null) === (words === null)) {
    return refuse("invalid-answer", "an answer names exactly one option or gives the owner's own words");
  }
  if (by === "orchestrator" && optionKey === null) return refuse("invalid-answer", "the Orchestrator answers with one of the options, never in its own words");
  if (words !== null && (words.length === 0 || words.length > MAX_ANSWER_WORDS_CHARS)) {
    return refuse("invalid-answer", `the owner's words must be 1–${MAX_ANSWER_WORDS_CHARS} characters`);
  }
  if (reason !== null && (reason.length === 0 || reason.length > MAX_ANSWER_REASON_CHARS)) {
    return refuse("invalid-answer", `a reason must be 1–${MAX_ANSWER_REASON_CHARS} characters`);
  }
  if (optionKey !== null && !decision.options.some((option) => option.key === optionKey)) {
    return refuse("unknown-option", `decision ${decision.id} has no option ${JSON.stringify(optionKey)}`);
  }
  const effects = effectsOfAnswer(decision, { optionKey });
  const expiresAt = new Date(timeOf(input.at) + GRANT_TTL_MS).toISOString();
  return {
    ok: true,
    decision: {
      ...decision,
      status: "answered",
      settledAt: input.at,
      needsConfirmation: null,
      answer: { by, via: input.via, optionKey, words, at: input.at, ...(reason === null ? {} : { reason }) },
      grant: effects.length === 0 ? null : { effects, expiresAt, usedAt: null },
    },
  };
}

/**
 * An owner message in a chat may have answered an `open` decision (§A.5 c):
 * it waits for the owner's confirmation. Marking a decision that already needs
 * confirmation keeps its first mark.
 */
export function markNeedsConfirmation(decision: Decision, input: { via: ChatVia; at: string }): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  if (decision.status === "needs-confirmation") return { ok: true, decision };
  return { ok: true, decision: { ...decision, status: "needs-confirmation", needsConfirmation: { via: input.via, at: input.at } } };
}

/**
 * The owner's one tap on a decision that needs confirmation: `answered: true`
 * closes it as answered in that chat — no option, no words, and no grant,
 * because the plugin never read what the owner authorised; `false` returns it
 * to `open`.
 */
export function confirmDecision(decision: Decision, input: { answered: boolean; at: string }): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  if (decision.status !== "needs-confirmation" || decision.needsConfirmation === null) {
    return refuse("not-needs-confirmation", `decision ${decision.id} is ${decision.status}, not waiting for a confirmation`);
  }
  if (!input.answered) return { ok: true, decision: { ...decision, status: "open", needsConfirmation: null } };
  return {
    ok: true,
    decision: {
      ...decision,
      status: "answered",
      settledAt: input.at,
      answer: { by: "owner", via: decision.needsConfirmation.via, optionKey: null, words: null, at: input.at },
      needsConfirmation: null,
      grant: null,
    },
  };
}

/** A newer decision `by` replaces this one (§A.3 rules). */
export function supersedeDecision(decision: Decision, input: { by: string; at: string }): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  return {
    ok: true,
    decision: { ...decision, status: "superseded", supersededBy: input.by, settledAt: input.at, needsConfirmation: null },
  };
}

/** The asker no longer needs the answer (e.g. a fallback incident resolved another way). */
export function withdrawDecision(decision: Decision, input: { at: string }): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  return { ok: true, decision: { ...decision, status: "withdrawn", settledAt: input.at, needsConfirmation: null } };
}

/** Nobody answered in time. */
export function expireDecision(decision: Decision, input: { at: string }): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  return { ok: true, decision: { ...decision, status: "expired", settledAt: input.at, needsConfirmation: null } };
}

/**
 * Why the decision's grant does not cover `effects` at `at`, or null when it
 * does: the grant is unused, `at` is before `expiresAt`, and every real effect
 * asked for is granted.
 */
export function grantRefusal(
  decision: Pick<Decision, "id" | "grant">,
  effects: readonly Effect[],
  at: string,
): { refusal: TransitionRefusal; message: string } | null {
  const grant = decision.grant;
  if (grant === null) return { refusal: "no-grant", message: `decision ${decision.id} granted nothing` };
  if (grant.usedAt !== null) return { refusal: "grant-used", message: `the grant of decision ${decision.id} was used at ${grant.usedAt}` };
  const now = timeOf(at);
  const expires = timeOf(grant.expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expires) || now >= expires) {
    return { refusal: "grant-expired", message: `the grant of decision ${decision.id} expired at ${grant.expiresAt}` };
  }
  const missing = realEffects(effects).filter((effect) => !grant.effects.includes(effect));
  if (missing.length > 0) {
    return { refusal: "effect-not-granted", message: `decision ${decision.id} did not grant ${missing.join(", ")}` };
  }
  return null;
}

/** True when the grant covers `effects` at `at` (see `grantRefusal`). */
export function grantCovers(decision: Pick<Decision, "id" | "grant">, effects: readonly Effect[], at: string): boolean {
  return grantRefusal(decision, effects, at) === null;
}

/** Spends the grant on `effects` at `at`: one use, within its hour, only effects it names. */
export function useGrant(decision: Decision, input: { effects: readonly Effect[]; at: string }): TransitionResult {
  const refusal = grantRefusal(decision, input.effects, input.at);
  if (refusal !== null) return refuse(refusal.refusal, refusal.message);
  return { ok: true, decision: { ...decision, grant: { ...decision.grant!, usedAt: input.at } } };
}
