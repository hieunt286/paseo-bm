/**
 * The decision model (autonomy design §A.3, ADR-017): a question to the owner
 * is one stored record — identity, request, asker, class (§B.1, ADR-018),
 * options with one recommendation and their declared effects, lifecycle,
 * answer, one-use grant, and what the agreement ledger reads (§B.3: the
 * predictions made at open, the reversals of the answer) — rendered the same
 * way on every surface.
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
import { coordinationChangeSchema } from "./coordination";

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
 * DATA / SECURITY / COST"): the effects of those classes. `release` is `push`,
 * `publish` and `deploy`; `data` is `real-data` and `migration`. Since
 * ADR-025 no class is the owner's by rule: the policy may grant these too
 * (at Turbo and Full auto), and the confirmation stays for the owner's own tap.
 */
export const CONFIRM_EFFECTS: readonly Effect[] = ["push", "publish", "deploy", "real-data", "migration", "security", "cost"];

/**
 * What a decision is about (autonomy design §B.1, ADR-018), riskiest first:
 * on a conflict the class earlier in this list wins. The asker proposes one;
 * the plugin keeps the riskier of the proposal and its declared effects'
 * classes (`checkedClass`).
 */
export const DECISION_CLASSES = [
  "security",
  "data",
  "release",
  "cost",
  "dependency",
  "environment",
  "scope",
  "preference",
  "reversible-technical",
] as const;
export const decisionClassSchema = z.enum(DECISION_CLASSES);
export type DecisionClass = z.infer<typeof decisionClassSchema>;

/** The class each effect implies (§B.1); `none` and `commit` imply none. */
export const CLASS_OF_EFFECT: Readonly<Record<Effect, DecisionClass | null>> = {
  none: null,
  commit: null,
  push: "release",
  publish: "release",
  deploy: "release",
  "real-data": "data",
  migration: "data",
  "dependency-install": "dependency",
  network: "environment",
  "outside-workspace": "environment",
  security: "security",
  cost: "cost",
};

/** Every fallback incident (`f:`) is about the environment (§B.1). */
export const FALLBACK_DECISION_CLASS: DecisionClass = "environment";

/** The class of a decision with no proposal and no effect that implies one (§B.9). */
export const DEFAULT_DECISION_CLASS: DecisionClass = "reversible-technical";

export const DECISION_STATUSES = ["open", "needs-confirmation", "answered", "superseded", "withdrawn", "expired"] as const;
export const decisionStatusSchema = z.enum(DECISION_STATUSES);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

/** A decision in one of these can still be answered; every other status is final. */
export const UNSETTLED_STATUSES: readonly DecisionStatus[] = ["open", "needs-confirmation"];
export const SETTLED_STATUSES: readonly DecisionStatus[] = ["answered", "superseded", "withdrawn", "expired"];

/**
 * Who answered (§A.3, §B.9): the owner; the Orchestrator (`bm_decide`, a
 * Worker's question on the project's Autopilot, change-004 — kept readable
 * for those Phase 1 answers); the policy of a `delegate` cell (§B.5); or an
 * owner precedent (§B.6). Additive: every answer stored before it is the
 * owner's. `precedent` is written when a decision opens on an active
 * precedent's subject (`server/precedent-resolve.ts`); `policy` when the
 * Orchestrator decides one in a `delegate` cell (`bm_decide`), or when the
 * action boundary allows a held request whose classes are delegated
 * (`server/action-boundary.ts`). Since ADR-025 a policy answer may grant any
 * effect its option declares.
 */
export const ANSWER_BY = ["owner", "orchestrator", "policy", "precedent"] as const;
export const answerBySchema = z.enum(ANSWER_BY);
export type AnswerBy = z.infer<typeof answerBySchema>;

/**
 * The predictions the agreement ledger measures (§B.3): the option the asker
 * marked recommended, and the Orchestrator's (`bm_predict`). Measured, not
 * chosen: since ADR-025 the Orchestrator is the only one that decides a
 * delegated class, and no cell names a predictor.
 */
export const PREDICTORS = ["recommended", "orchestrator"] as const;
export const predictorSchema = z.enum(PREDICTORS);
export type Predictor = z.infer<typeof predictorSchema>;

/**
 * How a settled decision was reversed (§B.3): re-asked with the same
 * `subject` in the same request after it was answered; overridden from the
 * digest (Inbox → Decided for you → Override); or a bead closed under it
 * reopened with a reason citing it.
 */
export const REVERSAL_KINDS = ["re-asked", "overridden", "reopened"] as const;
export const reversalKindSchema = z.enum(REVERSAL_KINDS);
export type ReversalKind = z.infer<typeof reversalKindSchema>;

/**
 * Where the answer came from (§A.3): the owner's surface or chat, or
 * `autopilot` — the Orchestrator's answer under the project's Autopilot —, or
 * `paseo`: a held request (`h:`, §D.2) the owner allowed in Paseo's own
 * permission prompt or with `paseo permit` (no paseo-bm role can answer one).
 */
export const ANSWER_VIA = ["inbox", "chat-card", "chat-manager", "chat-worker", "chat-orchestrator", "autopilot", "paseo"] as const;
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
/**
 * The Orchestrator's own decisions are tighter (`bm_ask_owner`, Orchestrator
 * design §6B.4): at most this many options, one button each, each label at
 * most this long, and a recommendation at most this long. With the caps above,
 * the one set of decision caps (code review 2026-09-30 §3.5): the tool's
 * schema and keys, and the decisions of older builds in `proposals.json`, read
 * them.
 */
export const MAX_ASK_OWNER_OPTIONS = 5;
export const MAX_ASK_OWNER_LABEL_CHARS = 80;
export const MAX_ASK_OWNER_RECOMMENDATION_CHARS = 500;
/** Longest answer in the owner's own words. */
export const MAX_ANSWER_WORDS_CHARS = 4000;
/** Longest reason an answer carries (the Orchestrator's, `bm_decide`). */
export const MAX_ANSWER_REASON_CHARS = 300;
/** Longest body of a prepared command; the same cap as a proposal's command. */
export const MAX_PREPARED_BODY_CHARS = 4000;
/** Longest reference a reversal keeps: the re-asking decision id, the override id or the reopened bead id. */
export const MAX_REVERSAL_REF_CHARS = 200;
/** Most reversals one decision keeps; one more of any kind changes nothing (it is reversed already). */
export const MAX_DECISION_REVERSALS = 20;
/** Longest precedent id an answer names. */
export const MAX_PRECEDENT_ID_CHARS = 128;
/** A subject slug (§A.5: ≤ 60 characters of `[a-z0-9-]`). */
export const SUBJECT_PATTERN = /^[a-z0-9-]{1,60}$/;
/** An option key: a Worker's letter (`a`), or a word for a prepared action (`switch`). */
export const OPTION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The deterministic id (§A.3): `q:<requestId>:<Qn>` for a Worker question,
 * `o:<uuid>` for an Orchestrator decision, `f:<incidentId>` for a fallback
 * incident, `r:<uuid>` for the owner's override of a decision answered for
 * them (§B.7, §B.9), `h:<agentId>:<permission request id>` for a held
 * permission request (§D.2, §D.4). None holds whitespace. A build before
 * `h:` skips such an entry when it reads the store.
 */
export const DECISION_ID_PATTERN = /^(?:q:\S+:Q\d{1,3}|o:[A-Za-z0-9-]{1,64}|f:\S{1,128}|r:[A-Za-z0-9-]{1,64}|h:[^\s:]{1,128}:\S{1,200})$/;

/** Every override id starts with this (§B.7, §B.9): `r:<uuid>`. */
export const OVERRIDE_ID_PREFIX = "r:";

/** Every held request's id starts with this (§D.2, §D.4): `h:<agentId>:<requestId>`. */
export const HELD_ID_PREFIX = "h:";

/** `h:<agentId>:<requestId>`: the decision of a held permission request. */
export function heldDecisionId(agentId: string, requestId: string): string {
  return `${HELD_ID_PREFIX}${agentId}:${requestId}`;
}

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
  /**
   * A change of the owner's settings (autonomy design §G.4), applied by the
   * plugin only on the owner's own answer (`carriesPreparedChange`). Each is
   * about the decision's own project; the owner's checks run again when it is
   * applied (`server/prepared-changes.ts`).
   */
  /** An owner precedent (§B.6): `project` holds in the decision's project, `all` in every project. */
  z.object({
    kind: z.literal("precedent.save"),
    scope: z.enum(["project", "all"]),
    subject: z.string().regex(SUBJECT_PATTERN),
    text: z.string().min(1).max(MAX_DECISION_LABEL_CHARS),
    expiresInDays: z.number().int().positive().optional(),
  }),
  /** One autonomy cell of the decision's project (§B.2); the modes are `shared/autonomy.ts` `AUTONOMY_MODES`, which imports this module. */
  z.object({
    kind: z.literal("autonomy.set"),
    class: decisionClassSchema,
    mode: z.enum(["owner", "shadow", "delegate"]),
  }),
  /** One Settings → Coordination setting (§G.7), as `coordination.set` takes it. */
  z.object({
    kind: z.literal("coordination.set"),
    change: coordinationChangeSchema,
  }),
  /**
   * Answers a held permission request (§D.2): a plain allow-once, or a deny.
   * `requestId` is Paseo's permission request id, not a paseo-bm request.
   */
  z.object({
    kind: z.literal("permission"),
    agentId: z.string().min(1),
    requestId: z.string().min(1),
    allow: z.boolean(),
  }),
]);
export type PreparedAction = z.infer<typeof preparedActionSchema>;

/**
 * The prepared changes of the owner's settings (autonomy design §G.4): a
 * precedent, an autonomy cell, a coordination setting. Unlike a command, the
 * plugin applies one only on the owner's own answer — never the policy's, a
 * precedent's or the Orchestrator's (`bm_decide`, `bm_predict`) — so nothing
 * but the owner ever changes the owner's settings.
 */
export const PREPARED_CHANGE_KINDS = ["precedent.save", "autonomy.set", "coordination.set"] as const;
export type PreparedChangeKind = (typeof PREPARED_CHANGE_KINDS)[number];
export type PreparedChange = Extract<PreparedAction, { kind: PreparedChangeKind }>;

/** True for a prepared change of the owner's settings (`PREPARED_CHANGE_KINDS`). */
export function isPreparedChange(action: PreparedAction | undefined): action is PreparedChange {
  return action !== undefined && (PREPARED_CHANGE_KINDS as readonly string[]).includes(action.kind);
}

/**
 * True when an option of the decision carries a prepared change: then only
 * the owner answers it (`answerDecision`, `decideRefusalOf`,
 * `predictionRefusalOf`, `recommendedDelegationOf`, `precedentResolutionOf`,
 * `resolveAtOpen`).
 */
export function carriesPreparedChange(decision: Pick<Decision, "options">): boolean {
  return decision.options.some((option) => isPreparedChange(option.action));
}

/** Why a decision that carries a prepared change is only the owner's, for every refusal of another answerer. */
export function preparedChangeRefusalText(decisionId: string): string {
  return `decision ${decisionId} carries a prepared change of the owner's settings; only the owner answers it`;
}

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
    /** Why this answer, in one line: the Orchestrator's (`bm_decide`), the policy's or the precedent's (`precedentReasonOf`); absent on the owner's answers. */
    reason: z.string().min(1).max(MAX_ANSWER_REASON_CHARS).optional(),
    /** A delegated answer's class (§B.5, §B.7): the cell that answered, for the digest. */
    class: decisionClassSchema.optional(),
    /**
     * A `policy` answer's predictor, as builds before ADR-025 stored it: read
     * only, never written (`policyPredictorOf` reads an answer without it).
     */
    predictor: predictorSchema.optional(),
    /** A `precedent` answer's precedent (§B.6), cited on the digest. */
    precedentId: z.string().min(1).max(MAX_PRECEDENT_ID_CHARS).optional(),
  })
  // Both null: the owner confirmed an answer typed in a chat (`decisions.confirm`),
  // whose text the plugin did not parse.
  .refine((answer) => answer.optionKey === null || answer.words === null, { message: "an answer is an option or words, not both" })
  // Only options, never own words, for the Orchestrator (change-004) and the policy (§B.5).
  // A precedent may answer in the owner's own standing words (§B.9).
  .refine((answer) => answer.by === "owner" || answer.by === "precedent" || (answer.optionKey !== null && answer.words === null), {
    message: "the Orchestrator and the policy answer with an option",
  })
  .refine((answer) => answer.via !== "autopilot" || answer.by === "orchestrator" || answer.by === "policy", { message: "only an agent answers on Autopilot" })
  .refine((answer) => answer.by !== "precedent" || answer.precedentId !== undefined, { message: "a precedent answer names its precedent" });

/**
 * What was predicted for a decision (§B.3), stored on the record: the option
 * marked recommended, set when it opens (null with none recommended), and the
 * Orchestrator challenger's prediction (`bm_predict`), null until it gives
 * one. The owner sees `orchestrator` before answering only as the
 * Orchestrator's proposal, at a level of 1 or more (`ownerViewOfDecision`).
 */
export const decisionPredictionSchema = z.object({
  recommended: z.object({ optionKey: z.string().regex(OPTION_KEY_PATTERN) }).nullable(),
  orchestrator: z
    .object({ optionKey: z.string().regex(OPTION_KEY_PATTERN), reason: z.string().min(1).max(MAX_ANSWER_REASON_CHARS), at: isoTimeSchema })
    .nullable(),
});
export type DecisionPrediction = z.infer<typeof decisionPredictionSchema>;

/** One reversal of an answered decision (§B.3): its kind, when, and what reversed it. */
export const decisionReversalSchema = z.object({
  kind: reversalKindSchema,
  at: isoTimeSchema,
  /** `re-asked`: the new decision's id; `overridden`: the override's id; `reopened`: the bead reopened. */
  ref: z.string().min(1).max(MAX_REVERSAL_REF_CHARS),
});
export type DecisionReversal = z.infer<typeof decisionReversalSchema>;

export const decisionGrantSchema = z.object({
  effects: z.array(effectSchema).min(1),
  expiresAt: isoTimeSchema,
  usedAt: isoTimeSchema.nullable(),
});

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
    /**
     * What it is about (§B.1): the asker's proposal, raised to its effects'
     * class. Absent on a decision stored before classes, which stays
     * `version: 1`: read it with `decisionClassOf`.
     */
    class: decisionClassSchema.optional(),
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
    /**
     * The predictions of the agreement ledger (§B.3). Additive: absent on a
     * decision opened before it, which the ledger leaves out (change-007 §3.3:
     * no prediction is read back from the options afterwards).
     */
    prediction: decisionPredictionSchema.optional(),
    /** How the answer was reversed (§B.3); additive, absent or empty while it stands. */
    reversals: z.array(decisionReversalSchema).max(MAX_DECISION_REVERSALS).optional(),
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
    const predicted = [decision.prediction?.recommended?.optionKey, decision.prediction?.orchestrator?.optionKey];
    if (predicted.some((key) => key != null && !decision.options.some((option) => option.key === key))) issue("a prediction names one of the options");
    if ((decision.reversals?.length ?? 0) > 0 && decision.status !== "answered") issue("only an answered decision is reversed");
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

/** The riskier of two classes: the one earlier in `DECISION_CLASSES`. */
export function riskierClass(a: DecisionClass, b: DecisionClass): DecisionClass {
  return DECISION_CLASSES.indexOf(a) <= DECISION_CLASSES.indexOf(b) ? a : b;
}

/** The riskiest class these effects imply, or null when none implies one (`none`, `commit`, nothing). */
export function classOfEffects(effects: readonly Effect[]): DecisionClass | null {
  let riskiest: DecisionClass | null = null;
  for (const effect of effects) {
    const implied = CLASS_OF_EFFECT[effect];
    if (implied !== null) riskiest = riskiest === null ? implied : riskierClass(riskiest, implied);
  }
  return riskiest;
}

/**
 * The class the plugin keeps (§B.1): the riskier of the asker's proposal and
 * the class of every declared effect — so an option that pushes makes the
 * decision `release` whatever was proposed. With neither, `reversible-technical`.
 */
export function checkedClass(proposed: DecisionClass | null | undefined, effects: readonly Effect[]): DecisionClass {
  const implied = classOfEffects(effects);
  if (proposed == null) return implied ?? DEFAULT_DECISION_CLASS;
  return implied === null ? proposed : riskierClass(proposed, implied);
}

/**
 * A stored decision's class (§B.1, §B.9): its own, checked again against its
 * options' effects. One stored before classes reads as a fallback incident's
 * `environment` when it is one, else as its effects' class, else
 * `reversible-technical`.
 */
export function decisionClassOf(decision: Pick<Decision, "id" | "options" | "class">): DecisionClass {
  const own = decision.class ?? (decisionKindOf(decision.id) === "fallback" ? FALLBACK_DECISION_CLASS : null);
  return checkedClass(own, declaredEffects(decision));
}

/**
 * Who chose a `policy` answer (ADR-025 decision 5), for the agreement ledger
 * and the metrics: the predictor an older build stored with it; else null for
 * a held request (`h:`), which the action boundary allowed by the policy with
 * no prediction; else the Orchestrator (`bm_decide`), the only predictor. Null
 * for an answer that is not the policy's. Pure.
 */
export function policyPredictorOf(decision: Pick<Decision, "id" | "answer">): Predictor | null {
  const answer = decision.answer;
  if (answer === null || answer.by !== "policy") return null;
  if (answer.predictor !== undefined) return answer.predictor;
  return decisionKindOf(decision.id) === "held" ? null : "orchestrator";
}

/**
 * What kind of asker the id names, or null for an id that is not a decision
 * id. `override` is the owner's correction of a decision answered for them
 * (§B.7): never answered by a precedent, the policy or the Orchestrator.
 * `held` is a permission request the action boundary held (§D.2): answered
 * by the owner only (the policy only at open, never a precedent or the
 * Orchestrator), delivered as a `permission` answer.
 */
export function decisionKindOf(id: string): "question" | "orchestrator" | "fallback" | "override" | "held" | null {
  if (!DECISION_ID_PATTERN.test(id)) return null;
  if (id.startsWith(HELD_ID_PREFIX)) return "held";
  return id.startsWith("q:") ? "question" : id.startsWith("o:") ? "orchestrator" : id.startsWith(OVERRIDE_ID_PREFIX) ? "override" : "fallback";
}

/**
 * The kind whose delivery a decision's answer takes (§A.6): its own; an
 * override's (§B.7) is the kind of the decision it overrides (`supersedes`),
 * so the corrected answer reaches the same agent. Null for an override that
 * names no such decision.
 */
export function deliveryKindOf(decision: Pick<Decision, "id" | "supersedes">): "question" | "orchestrator" | "fallback" | "held" | null {
  const kind = decisionKindOf(decision.id);
  if (kind !== "override") return kind;
  const overridden = decision.supersedes === null ? null : decisionKindOf(decision.supersedes);
  return overridden === "override" ? null : overridden;
}

/** `q:<requestId>:<Qn>`. */
export function questionDecisionId(requestId: string, questionId: string): string {
  return `q:${requestId}:${questionId}`;
}

/**
 * The prediction a decision opens with (§B.3): the option marked recommended
 * (null when none is), and no challenger prediction yet.
 */
export function openingPrediction(options: readonly Pick<DecisionOption, "key" | "recommended">[]): DecisionPrediction {
  const recommended = options.find((option) => option.recommended);
  return { recommended: recommended === undefined ? null : { optionKey: recommended.key }, orchestrator: null };
}

/**
 * A decision as the owner's screens may read it (§B.3; ADR-025): while it can
 * still be answered, the Orchestrator's prediction is shown only as its
 * proposal — `proposalShown`, true when the decision's project is at a level
 * of 1 or more (its prediction switch on) — and left out otherwise. A settled
 * decision is returned as it is.
 */
export function ownerViewOfDecision(decision: Decision, proposalShown = false): Decision {
  if (proposalShown || !isAnswerable(decision) || decision.prediction?.orchestrator == null) return decision;
  return { ...decision, prediction: { ...decision.prediction, orchestrator: null } };
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
  | "effect-not-granted"
  /** A reversal names a decision that was never answered. */
  | "not-answered";

export type TransitionResult =
  | { ok: true; decision: Decision }
  | { ok: false; refusal: TransitionRefusal; message: string };

function refuse(refusal: TransitionRefusal, message: string): TransitionResult {
  return { ok: false, refusal, message };
}

const ANSWERED_BY_TEXT: Readonly<Record<AnswerBy, string>> = {
  owner: "the owner",
  orchestrator: "the Orchestrator",
  policy: "the policy",
  precedent: "an owner precedent",
};

/** Who answered, for a refusal: "the owner", "the Orchestrator", "the policy" or "an owner precedent". */
export function answeredByText(by: AnswerBy): string {
  return ANSWERED_BY_TEXT[by];
}

/**
 * What a refusal says of a decision in each status but `open`, in its caller's
 * words: who answered it and when, what superseded it, or the status itself.
 */
export interface NotOpenWords {
  needsConfirmation: string;
  answered: (by: string, at: string | null) => string;
  superseded: (by: string | null) => string;
  /** Withdrawn or expired. */
  closed: (status: DecisionStatus) => string;
}

/**
 * Why a decision is not `open`, in the caller's words, or null while it is:
 * the one ladder over a decision's status that every refusal goes down (code
 * review 2026-09-30 §3.5) — the transitions (`refuseSettled`), `bm_decide`
 * and `bm_predict` (`shared/autonomy.ts`) and a command's `BM-ANSWERS` line
 * (`server/command-authority.ts`). Pure.
 */
export function notOpenRefusalOf(decision: Pick<Decision, "status" | "answer" | "settledAt" | "supersededBy">, words: NotOpenWords): string | null {
  switch (decision.status) {
    case "open":
      return null;
    case "needs-confirmation":
      return words.needsConfirmation;
    case "answered":
      return words.answered(answeredByText(decision.answer?.by ?? "owner"), decision.answer?.at ?? decision.settledAt);
    case "superseded":
      return words.superseded(decision.supersededBy);
    default:
      return words.closed(decision.status);
  }
}

function refuseSettled(decision: Decision): TransitionResult {
  const cannot = (by: string | null) => `decision ${decision.id} is ${decision.status}${by === null ? "" : ` by ${by}`}; it can no longer be answered`;
  const message = notOpenRefusalOf(decision, {
    needsConfirmation: cannot(null),
    answered: (by) => cannot(by),
    superseded: (by) => cannot(by),
    closed: () => cannot(null),
  });
  return refuse("settled", message ?? cannot(null));
}

export interface AnswerInput {
  via: AnswerVia;
  optionKey?: string | null;
  words?: string | null;
  /** The time of the answer, ISO. */
  at: string;
  /**
   * Who answers; the owner by default. The policy answers only with an
   * option. Never `orchestrator`: that is only read, in answers stored before
   * the Orchestrator decided through the policy (§B.9).
   */
  by?: Exclude<AnswerBy, "orchestrator">;
  /** Why, in one line (trimmed, at most `MAX_ANSWER_REASON_CHARS`); none by default. */
  reason?: string | null;
  /** A delegated answer's class (§B.5); none by default. */
  class?: DecisionClass;
  /** A `precedent` answer's precedent (required for it, §B.6). */
  precedentId?: string;
}

/**
 * Answers an unsettled decision with one option or the owner's own words
 * (trimmed). The answer grants the chosen option's declared effects — or, for
 * own words, every effect the decision declares — for one use until
 * `at + GRANT_TTL_MS`; an answer that grants nothing carries no grant. The
 * policy's answer (`by: policy`, §B.5) is always an option and keeps its
 * reason; it grants what its option declares, as the owner's would (ADR-025:
 * no class is the owner's by rule). A new `by: orchestrator` answer is refused: the
 * Orchestrator decides through the policy (`bm_decide`), and its Phase 1
 * answers are only read. A decision that
 * carries a prepared change of the owner's settings (§G.4) takes only the
 * owner's answer: the policy's and a precedent's are refused.
 */
export function answerDecision(decision: Decision, input: AnswerInput): TransitionResult {
  if (!isAnswerable(decision)) return refuseSettled(decision);
  // `AnswerInput` leaves it out; refused at run time too, for a caller the compiler did not check.
  if ((input.by as AnswerBy | undefined) === "orchestrator") {
    return refuse("invalid-answer", "the Orchestrator no longer answers a decision itself; it decides through the policy (bm_decide)");
  }
  const by = input.by ?? "owner";
  // Autonomy design §G.4: a prepared change of the owner's settings is the owner's alone, whoever else would answer.
  if (by !== "owner" && carriesPreparedChange(decision)) return refuse("invalid-answer", preparedChangeRefusalText(decision.id));
  // Autonomy design §D.2: a held request is allowed or denied, by the owner (the policy only as it opens); never in words, never by a precedent.
  if (decisionKindOf(decision.id) === "held") {
    if (input.words != null) return refuse("invalid-answer", `decision ${decision.id} is a held request; answer it Allow or Deny`);
    if (by === "precedent") return refuse("invalid-answer", `decision ${decision.id} is a held request; a precedent never answers it`);
  }
  const optionKey = input.optionKey ?? null;
  const words = input.words == null ? null : input.words.trim();
  const reason = input.reason == null ? null : input.reason.trim();
  if ((optionKey === null) === (words === null)) {
    return refuse("invalid-answer", "an answer names exactly one option or gives the owner's own words");
  }
  if (by === "policy" && optionKey === null) return refuse("invalid-answer", "the policy answers with one of the options");
  const precedentId = input.precedentId?.trim();
  if (precedentId !== undefined && (precedentId === "" || precedentId.length > MAX_PRECEDENT_ID_CHARS)) {
    return refuse("invalid-answer", `a precedent id must be 1–${MAX_PRECEDENT_ID_CHARS} characters`);
  }
  if (by === "precedent" && precedentId === undefined) return refuse("invalid-answer", "a precedent answer names its precedent");
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
  const expiresAt = new Date(Date.parse(input.at) + GRANT_TTL_MS).toISOString();
  return {
    ok: true,
    decision: {
      ...decision,
      status: "answered",
      settledAt: input.at,
      needsConfirmation: null,
      answer: {
        by,
        via: input.via,
        optionKey,
        words,
        at: input.at,
        ...(reason === null ? {} : { reason }),
        ...(input.class === undefined ? {} : { class: input.class }),
        ...(precedentId === undefined ? {} : { precedentId }),
      },
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
 * Records that an answered decision was reversed (§B.3) — the one function
 * every reversal goes through: the materialiser's re-ask (`re-asked`), the
 * digest's Override (`overridden`) and a cited `br reopen` (`reopened`).
 * Idempotent: the same kind and `ref` again, or one more past
 * `MAX_DECISION_REVERSALS`, returns the decision unchanged. A decision that was
 * never answered has nothing to reverse.
 */
export function recordReversal(decision: Decision, reversal: DecisionReversal): TransitionResult {
  if (decision.status !== "answered") {
    return refuse("not-answered", `decision ${decision.id} is ${decision.status}; only an answered decision can be reversed`);
  }
  const ref = reversal.ref.trim();
  if (ref === "" || ref.length > MAX_REVERSAL_REF_CHARS) return refuse("invalid-answer", `a reversal's reference must be 1–${MAX_REVERSAL_REF_CHARS} characters`);
  const kept = decision.reversals ?? [];
  if (kept.length >= MAX_DECISION_REVERSALS || kept.some((entry) => entry.kind === reversal.kind && entry.ref === ref)) return { ok: true, decision };
  return { ok: true, decision: { ...decision, reversals: [...kept, { kind: reversal.kind, at: reversal.at, ref }] } };
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
  const now = Date.parse(at);
  const expires = Date.parse(grant.expiresAt);
  if (Number.isNaN(now) || Number.isNaN(expires) || now >= expires) {
    return { refusal: "grant-expired", message: `the grant of decision ${decision.id} expired at ${grant.expiresAt}` };
  }
  const missing = realEffects(effects).filter((effect) => !grant.effects.includes(effect));
  if (missing.length > 0) {
    return { refusal: "effect-not-granted", message: `decision ${decision.id} did not grant ${missing.join(", ")}` };
  }
  return null;
}

/** Spends the grant on `effects` at `at`: one use, within its hour, only effects it names. */
export function useGrant(decision: Decision, input: { effects: readonly Effect[]; at: string }): TransitionResult {
  const refusal = grantRefusal(decision, input.effects, input.at);
  if (refusal !== null) return refuse(refusal.refusal, refusal.message);
  return { ok: true, decision: { ...decision, grant: { ...decision.grant!, usedAt: input.at } } };
}
