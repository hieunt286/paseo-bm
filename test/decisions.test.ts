import { describe, expect, it } from "vitest";
import {
  ANSWER_BY,
  ANSWER_VIA,
  CLASS_OF_EFFECT,
  CONFIRM_EFFECTS,
  DECISION_CLASSES,
  DECISION_STATUSES,
  EFFECTS,
  HARD_OWNER_CLASSES,
  GRANT_TTL_MS,
  MAX_ANSWER_REASON_CHARS,
  MAX_ANSWER_WORDS_CHARS,
  MAX_DECISION_REVERSALS,
  PREDICTORS,
  REVERSAL_KINDS,
  answerDecision,
  answeredByText,
  checkedClass,
  classOfEffects,
  confirmDecision,
  decisionClassOf,
  decisionKindOf,
  decisionSchema,
  declaredEffects,
  deliveryKindOf,
  effectsOfAnswer,
  expireDecision,
  grantRefusal,
  heldDecisionId,
  isAnswerable,
  isHardOwnerClass,
  markNeedsConfirmation,
  needsOwnerConfirmation,
  openingPrediction,
  ownerViewOfDecision,
  preparedActionSchema,
  questionDecisionId,
  realEffects,
  recordReversal,
  riskierClass,
  supersedeDecision,
  useGrant,
  withdrawDecision,
  type Decision,
  type TransitionResult,
} from "../plugin/shared/decisions";
import { DECISION_ASKED_AT, DECISION_REQUEST, makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";

/**
 * The decision model and its pure transitions (autonomy design §A.3,
 * ADR-017). No clock, no store: every time is an argument.
 */

const AT = "2026-09-29T08:00:00.000Z";
const plus = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();

function ok(result: TransitionResult): Decision {
  if (!result.ok) throw new Error(`refused: ${result.refusal} — ${result.message}`);
  // Whatever a transition returns is a valid stored decision.
  return decisionSchema.parse(result.decision);
}

function refusalOf(result: TransitionResult): string | null {
  return result.ok ? null : result.refusal;
}

/** A decision already in each status, built through the transitions. */
function inStatus(status: Decision["status"]): Decision {
  const open = makeDecision();
  switch (status) {
    case "open":
      return open;
    case "needs-confirmation":
      return ok(markNeedsConfirmation(open, { via: "chat-worker", at: AT }));
    case "answered":
      return ok(answerDecision(open, { via: "inbox", optionKey: "a", at: AT }));
    case "superseded":
      return ok(supersedeDecision(open, { by: `q:${DECISION_REQUEST}:Q2`, at: AT }));
    case "withdrawn":
      return ok(withdrawDecision(open, { at: AT }));
    case "expired":
      return ok(expireDecision(open, { at: AT }));
  }
}

describe("vocabulary", () => {
  it("lists the twelve effects of §A.3 and the six statuses", () => {
    expect(EFFECTS).toEqual([
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
    ]);
    expect(DECISION_STATUSES).toEqual(["open", "needs-confirmation", "answered", "superseded", "withdrawn", "expired"]);
  });

  it("asks for a confirmation only for release, data, security and cost effects (X-4)", () => {
    expect(CONFIRM_EFFECTS).toEqual(["push", "publish", "deploy", "real-data", "migration", "security", "cost"]);
    expect(needsOwnerConfirmation(["commit", "network"])).toBe(false);
    expect(needsOwnerConfirmation(["push"])).toBe(true);
    expect(needsOwnerConfirmation(["push", "deploy"])).toBe(true);
    expect(needsOwnerConfirmation([])).toBe(false);
  });

  it("reads the kind of a decision from its id", () => {
    expect(questionDecisionId(DECISION_REQUEST, "Q4")).toBe(`q:${DECISION_REQUEST}:Q4`);
    expect(decisionKindOf(`q:${DECISION_REQUEST}:Q4`)).toBe("question");
    expect(decisionKindOf("o:3f2c1d7e-0b7a-4c1e-9f8e-2a4b6c8d0e1f")).toBe("orchestrator");
    expect(decisionKindOf("f:fb-0123456789ab")).toBe("fallback");
    expect(decisionKindOf("x:1")).toBeNull();
    expect(decisionKindOf(`q:${DECISION_REQUEST}:4`)).toBeNull();
    expect(decisionKindOf("q:has space:Q1")).toBeNull();
    // Autonomy design §D.2, §D.4: a held permission request, a kind of its own (change-009 C6).
    expect(heldDecisionId("agent-1", "toolu_01ABC")).toBe("h:agent-1:toolu_01ABC");
    expect(decisionKindOf("h:agent-1:toolu_01ABC")).toBe("held");
    expect(deliveryKindOf({ id: "h:agent-1:toolu_01ABC", supersedes: null })).toBe("held");
    expect(decisionKindOf("h:agent 1:x")).toBeNull();
    expect(decisionKindOf("h:agent-1")).toBeNull();
  });

  it("a held request is answered Allow or Deny: never in words, never by a precedent", () => {
    const heldOpen = makeDecision({
      id: "h:agent-1:perm-1",
      askedBy: { role: "plugin", agentId: "agent-1" },
      round: null,
      options: [
        { key: "allow", label: "Allow once", recommended: false, effects: ["push"], action: { kind: "permission", agentId: "agent-1", requestId: "perm-1", allow: true } },
        { key: "deny", label: "Deny", recommended: false, effects: ["none"], action: { kind: "permission", agentId: "agent-1", requestId: "perm-1", allow: false } },
      ],
    });
    expect(decisionSchema.safeParse(heldOpen).success).toBe(true);
    expect(answerDecision(heldOpen, { via: "inbox", words: "yes", at: DECISION_ASKED_AT })).toMatchObject({ ok: false, refusal: "invalid-answer" });
    expect(answerDecision(heldOpen, { via: "inbox", optionKey: "allow", by: "precedent", precedentId: "p-1", at: DECISION_ASKED_AT })).toMatchObject({ ok: false });
    const allowed = answerDecision(heldOpen, { via: "paseo", optionKey: "allow", at: DECISION_ASKED_AT });
    expect(allowed).toMatchObject({ ok: true, decision: { answer: { by: "owner", via: "paseo" }, grant: { effects: ["push"] } } });
    expect(ANSWER_VIA).toContain("paseo");
  });

  it("drops none, repeats and order from a list of effects", () => {
    expect(realEffects(["none", "push", "commit", "push"])).toEqual(["commit", "push"]);
    expect(declaredEffects(makeDecision())).toEqual(["push", "publish"]);
    expect(effectsOfAnswer(makeDecision(), { optionKey: "c" })).toEqual([]);
    expect(effectsOfAnswer(makeDecision(), { optionKey: "zzz" })).toEqual([]);
    expect(effectsOfAnswer(makeDecision(), { optionKey: null })).toEqual(["push", "publish"]);
  });
});

describe("classes (autonomy design §B.1, ADR-018)", () => {
  it("lists the nine classes riskiest first, the conflict order", () => {
    expect(DECISION_CLASSES).toEqual(["security", "data", "release", "cost", "dependency", "environment", "scope", "preference", "reversible-technical"]);
  });

  it.each([
    ["none", null],
    ["commit", null],
    ["push", "release"],
    ["publish", "release"],
    ["deploy", "release"],
    ["real-data", "data"],
    ["migration", "data"],
    ["dependency-install", "dependency"],
    ["network", "environment"],
    ["outside-workspace", "environment"],
    ["security", "security"],
    ["cost", "cost"],
  ] as const)("maps the effect %s to %s", (effect, decisionClass) => {
    expect(CLASS_OF_EFFECT[effect]).toBe(decisionClass);
    expect(classOfEffects([effect])).toBe(decisionClass);
  });

  it("maps every effect, and no class of the order is missing from it but the three no effect implies", () => {
    expect(Object.keys(CLASS_OF_EFFECT).sort()).toEqual([...EFFECTS].sort());
    const implied = new Set(Object.values(CLASS_OF_EFFECT).filter((entry) => entry !== null));
    expect(DECISION_CLASSES.filter((entry) => !implied.has(entry))).toEqual(["scope", "preference", "reversible-technical"]);
  });

  it("keeps the riskier class in both argument orders, for every pair", () => {
    for (const [i, a] of DECISION_CLASSES.entries()) {
      for (const [j, b] of DECISION_CLASSES.entries()) {
        const riskier = i <= j ? a : b;
        expect(riskierClass(a, b), `${a} vs ${b}`).toBe(riskier);
        expect(riskierClass(b, a), `${b} vs ${a}`).toBe(riskier);
      }
    }
    expect(riskierClass("reversible-technical", "release")).toBe("release");
    expect(riskierClass("cost", "security")).toBe("security");
  });

  it("reads the riskiest class of several effects, or none", () => {
    expect(classOfEffects([])).toBeNull();
    expect(classOfEffects(["none", "commit"])).toBeNull();
    expect(classOfEffects(["network", "push"])).toBe("release");
    expect(classOfEffects(["cost", "migration", "push"])).toBe("data");
    expect(classOfEffects(["outside-workspace", "dependency-install"])).toBe("dependency");
  });

  it("keeps a proposal riskier than the effects, and raises one less risky to the effects' class", () => {
    expect(checkedClass("security", ["push"])).toBe("security");
    expect(checkedClass("cost", ["network"])).toBe("cost");
    expect(checkedClass("preference", ["migration"])).toBe("data");
    expect(checkedClass("scope", ["none"])).toBe("scope");
    expect(checkedClass("preference", [])).toBe("preference");
  });

  it("never lets an asker propose reversible-technical past an option that pushes (negative)", () => {
    expect(checkedClass("reversible-technical", ["push"])).toBe("release");
    expect(checkedClass("reversible-technical", declaredEffects(makeDecision()))).toBe("release");
  });

  it("without a proposal: the effects' class, else reversible-technical (§B.9)", () => {
    expect(checkedClass(undefined, ["network"])).toBe("environment");
    expect(checkedClass(null, ["commit", "none"])).toBe("reversible-technical");
    expect(checkedClass(null, [])).toBe("reversible-technical");
  });

  it("names release, data, security and cost as the owner's alone: exactly the classes of the confirmation effects", () => {
    // Derived from CONFIRM_EFFECTS (code review 2026-09-30 §3.5): the literal it replaces, in its order.
    expect(HARD_OWNER_CLASSES).toEqual(["release", "data", "security", "cost"]);
    expect(new Set(CONFIRM_EFFECTS.map((effect) => CLASS_OF_EFFECT[effect]))).toEqual(new Set(HARD_OWNER_CLASSES));
    expect(DECISION_CLASSES.filter(isHardOwnerClass)).toEqual(["security", "data", "release", "cost"]);
  });

  it("stores the class as an additive field, and refuses one that is not a class", () => {
    const classed = makeDecision({ class: "release" });
    expect(decisionSchema.parse(JSON.parse(JSON.stringify(classed)))).toEqual(classed);
    expect(decisionSchema.safeParse(makeDecision({ class: "urgent" as never })).success).toBe(false);
    // A transition keeps it.
    expect(ok(answerDecision(classed, { via: "inbox", optionKey: "a", at: AT })).class).toBe("release");
  });

  it("reads a decision stored before classes by its effects, a fallback incident as environment, else reversible-technical (§B.9)", () => {
    const older = decisionSchema.parse(JSON.parse(JSON.stringify(makeDecision())));
    expect(older).not.toHaveProperty("class");
    expect(decisionClassOf(older)).toBe("release");
    expect(decisionClassOf(makeDecision({ options: [{ key: "a", label: "Go", recommended: true, effects: ["commit"] }] }))).toBe("reversible-technical");
    expect(decisionClassOf(makeDecision({ options: [] }))).toBe("reversible-technical");
    const incident = makeDecision({ id: "f:fb-0123456789ab", requestId: null, options: [{ key: "dismiss", label: "I'll handle it", recommended: false, effects: ["none"] }] });
    expect(decisionClassOf(incident)).toBe("environment");
    // A stored class is read as stored, and still never below its effects.
    expect(decisionClassOf(makeDecision({ class: "security" }))).toBe("security");
    expect(decisionClassOf(makeDecision({ class: "preference" }))).toBe("release");
  });
});

describe("schema", () => {
  it("accepts the fixture and a decision in every status", () => {
    for (const status of DECISION_STATUSES) expect(decisionSchema.safeParse(inStatus(status)).success).toBe(true);
  });

  it("accepts the three prepared actions", () => {
    expect(preparedActionSchema.parse({ kind: "answer-worker" })).toEqual({ kind: "answer-worker" });
    expect(
      preparedActionSchema.safeParse({ kind: "command", to: "worker", agentId: "w1", intent: "continue", body: "Push the contract.", effects: ["push"] })
        .success,
    ).toBe(true);
    expect(preparedActionSchema.safeParse({ kind: "fallback", action: "switch", target: "fb-0123456789ab" }).success).toBe(true);
    expect(preparedActionSchema.safeParse({ kind: "fallback", action: "retry", target: "x" }).success).toBe(false);
    expect(preparedActionSchema.safeParse({ kind: "command", to: "reviewer", agentId: "r", intent: "stop", body: "x", effects: [] }).success).toBe(false);
  });

  const invalid: Array<[string, Partial<Decision>]> = [
    ["two recommended options", { options: [
      { key: "a", label: "A", recommended: true, effects: [] },
      { key: "b", label: "B", recommended: true, effects: [] },
    ] }],
    ["repeated option keys", { options: [
      { key: "a", label: "A", recommended: false, effects: [] },
      { key: "a", label: "B", recommended: false, effects: [] },
    ] }],
    ["a question over 1,000 characters", { question: "x".repeat(1001) }],
    ["a subject with capitals", { subject: "Push-Backends" }],
    ["an unknown effect", { options: [{ key: "a", label: "A", recommended: false, effects: ["launch" as never] }] }],
    ["no request outside a fallback", { requestId: null, id: `q:${DECISION_REQUEST}:Q1` }],
    ["a question id naming another request", { id: "q:req-other:Q1" }],
    ["an answered decision without an answer", { status: "answered", settledAt: AT }],
    ["an open decision with settledAt", { settledAt: AT }],
    ["a superseded decision without supersededBy", { status: "superseded", settledAt: AT }],
    ["a needs-confirmation decision without its chat", { status: "needs-confirmation" }],
    ["a grant on an open decision", { grant: { effects: ["push"], expiresAt: AT, usedAt: null } }],
    ["an answer naming a missing option", { status: "answered", settledAt: AT, answer: { by: "owner", via: "inbox", optionKey: "z", words: null, at: AT } }],
    ["an answer with an option and words", { status: "answered", settledAt: AT, answer: { by: "owner", via: "inbox", optionKey: "a", words: "yes", at: AT } }],
    ["more than eight options", { options: Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: "x", recommended: false, effects: [] })) }],
  ];
  it.each(invalid)("refuses %s", (_name, overrides) => {
    expect(decisionSchema.safeParse(makeDecision(overrides)).success).toBe(false);
  });

  it("lets a fallback decision, or an Orchestrator decision about a whole project, have no request", () => {
    expect(decisionSchema.safeParse(makeDecision({ id: "f:fb-0123456789ab", requestId: null, askedBy: { role: "plugin", agentId: null } })).success).toBe(true);
    expect(decisionSchema.safeParse(makeDecision({ id: "o:project-wide", requestId: null, askedBy: { role: "orchestrator", agentId: null }, round: null })).success).toBe(true);
  });
});

describe("answering", () => {
  it("answers with an option, granting that option's effects for one hour", () => {
    const decision = ok(answerDecision(makeDecision(), { via: "chat-card", optionKey: "a", at: AT }));
    expect(decision.status).toBe("answered");
    expect(decision.settledAt).toBe(AT);
    expect(decision.answer).toEqual({ by: "owner", via: "chat-card", optionKey: "a", words: null, at: AT });
    expect(decision.grant).toEqual({ effects: ["push"], expiresAt: plus(GRANT_TTL_MS), usedAt: null });
  });

  it("answers in own words (trimmed), granting every effect the decision declares", () => {
    const decision = ok(answerDecision(makeDecision(), { via: "inbox", words: "  Push only the contract.  ", at: AT }));
    expect(decision.answer?.words).toBe("Push only the contract.");
    expect(decision.answer?.optionKey).toBeNull();
    expect(decision.grant?.effects).toEqual(["push", "publish"]);
  });

  it("grants nothing for an option without effects", () => {
    expect(ok(answerDecision(makeDecision(), { via: "inbox", optionKey: "c", at: AT })).grant).toBeNull();
    const plain = makeDecision({ options: [] });
    expect(ok(answerDecision(plain, { via: "inbox", words: "Go on.", at: AT })).grant).toBeNull();
  });

  it("answers a decision that needs confirmation and clears the mark", () => {
    const decision = ok(answerDecision(inStatus("needs-confirmation"), { via: "inbox", optionKey: "a", at: AT }));
    expect(decision.status).toBe("answered");
    expect(decision.needsConfirmation).toBeNull();
  });

  it("refuses neither or both of option and words, blank or long words, and an unknown option", () => {
    const open = makeDecision();
    expect(refusalOf(answerDecision(open, { via: "inbox", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { via: "inbox", optionKey: "a", words: "yes", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { via: "inbox", words: "   ", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { via: "inbox", words: "x".repeat(MAX_ANSWER_WORDS_CHARS + 1), at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { via: "inbox", optionKey: "z", at: AT }))).toBe("unknown-option");
  });

  it.each(["answered", "superseded", "withdrawn", "expired"] as const)("never answers a %s decision", (status) => {
    const settled = inStatus(status);
    expect(isAnswerable(settled)).toBe(false);
    const result = answerDecision(settled, { via: "inbox", optionKey: "a", at: plus(1000) });
    expect(refusalOf(result)).toBe("settled");
    if (status === "superseded") expect(result.ok ? "" : result.message).toContain(`q:${DECISION_REQUEST}:Q2`);
  });
});

describe("the Orchestrator's Phase 1 answer (change-004): read, never written", () => {
  const decided = () => ok(storedOrchestratorAnswer(makeDecision(), { optionKey: "c", reason: "Hold: the review is not in yet.", at: AT }));

  it("round-trips a stored by: orchestrator answer with its reason", () => {
    const decision = decided();
    expect(decision.answer).toEqual({ by: "orchestrator", via: "autopilot", optionKey: "c", words: null, at: AT, reason: "Hold: the review is not in yet." });
    expect(decisionSchema.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
  });

  it("still reads an answer stored before it: the owner's, without by-orchestrator or a reason", () => {
    const older = makeDecision({ status: "answered", settledAt: AT, answer: { by: "owner", via: "inbox", optionKey: "a", words: null, at: AT } });
    const parsed = decisionSchema.parse(JSON.parse(JSON.stringify(older)));
    expect(parsed.answer).toEqual({ by: "owner", via: "inbox", optionKey: "a", words: null, at: AT });
    expect(parsed.answer).not.toHaveProperty("reason");
  });

  it("refuses a new by: orchestrator answer: the Orchestrator decides through the policy, whose reason is 1-300 characters", () => {
    const open = makeDecision();
    const refused = answerDecision(open, { by: "orchestrator" as never, via: "autopilot", optionKey: "c", reason: "Hold.", at: AT });
    expect(refusalOf(refused)).toBe("invalid-answer");
    expect(refused.ok ? "" : refused.message).toContain("decides through the policy (bm_decide)");
    const decide = { by: "policy", predictor: "orchestrator", via: "inbox", optionKey: "c", at: AT } as const;
    expect(refusalOf(answerDecision(open, { ...decide, reason: "   " }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { ...decide, reason: "x".repeat(MAX_ANSWER_REASON_CHARS + 1) }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { ...decide, optionKey: "z", reason: "Why not." }))).toBe("unknown-option");
  });

  it("the schema holds it: never own words or no option for the Orchestrator, Autopilot only for the Orchestrator, a reason ≤ 300", () => {
    const answered = (answer: Record<string, unknown>) => makeDecision({ status: "answered", settledAt: AT, answer: { by: "orchestrator", via: "autopilot", optionKey: "c", words: null, at: AT, ...answer } as never });
    expect(decisionSchema.safeParse(answered({})).success).toBe(true);
    expect(decisionSchema.safeParse(answered({ optionKey: null, words: "Hold it." })).success).toBe(false);
    expect(decisionSchema.safeParse(answered({ optionKey: null })).success).toBe(false);
    expect(decisionSchema.safeParse(answered({ by: "owner" })).success).toBe(false);
    expect(decisionSchema.safeParse(answered({ by: "policy" })).success).toBe(false);
    expect(decisionSchema.safeParse(answered({ reason: "x".repeat(MAX_ANSWER_REASON_CHARS + 1) })).success).toBe(false);
  });

  it("the first answer wins: the owner's later answer is refused, naming who answered", () => {
    const result = answerDecision(decided(), { via: "inbox", optionKey: "a", at: plus(60_000) });
    expect(refusalOf(result)).toBe("settled");
    expect(result.ok ? "" : result.message).toBe(`decision q:${DECISION_REQUEST}:Q1 is answered by the Orchestrator; it can no longer be answered`);
    const byOwner = answerDecision(inStatus("answered"), { via: "inbox", optionKey: "c", at: plus(60_000) });
    expect(byOwner.ok ? "" : byOwner.message).toContain("is answered by the owner");
  });
});

describe("delegated answers, predictions and reversals (autonomy design §B.3, §B.9)", () => {
  const predicted = { recommended: { optionKey: "a" }, orchestrator: { optionKey: "c", reason: "Hold until the review is in.", at: AT } };

  it("answer.by is owner, orchestrator, policy or precedent (change-007 C4); two predictors; three reversal kinds", () => {
    expect(ANSWER_BY).toEqual(["owner", "orchestrator", "policy", "precedent"]);
    expect(PREDICTORS).toEqual(["recommended", "orchestrator"]);
    expect(REVERSAL_KINDS).toEqual(["re-asked", "overridden", "reopened"]);
    expect(ANSWER_BY.map(answeredByText)).toEqual(["the owner", "the Orchestrator", "the policy", "an owner precedent"]);
  });

  it("a policy answer is an option naming its predictor; a precedent answer names its precedent, in words or an option", () => {
    const open = makeDecision({ options: makeDecision().options.map((option) => ({ ...option, effects: ["none"] })) });
    const policy = ok(answerDecision(open, { by: "policy", via: "autopilot", optionKey: "a", reason: "recommended option, class delegated", class: "scope", predictor: "recommended", at: AT }));
    expect(policy.answer).toEqual({ by: "policy", via: "autopilot", optionKey: "a", words: null, at: AT, reason: "recommended option, class delegated", class: "scope", predictor: "recommended" });
    const precedent = ok(answerDecision(open, { by: "precedent", via: "inbox", words: "Always SQLite for tests.", precedentId: " p-1 ", at: AT }));
    expect(precedent.answer).toMatchObject({ by: "precedent", optionKey: null, words: "Always SQLite for tests.", precedentId: "p-1" });

    expect(refusalOf(answerDecision(open, { by: "policy", via: "autopilot", words: "Hold.", predictor: "recommended", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { by: "policy", via: "autopilot", optionKey: "a", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { by: "precedent", via: "inbox", optionKey: "a", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { by: "precedent", via: "inbox", optionKey: "a", precedentId: "  ", at: AT }))).toBe("invalid-answer");

    const answered = (answer: Record<string, unknown>) =>
      decisionSchema.safeParse(makeDecision({ status: "answered", settledAt: AT, answer: { via: "inbox", optionKey: "c", words: null, at: AT, ...answer } as never })).success;
    expect(answered({ by: "policy", predictor: "orchestrator" })).toBe(true);
    expect(answered({ by: "policy" })).toBe(false);
    expect(answered({ by: "policy", predictor: "orchestrator", optionKey: null, words: "Hold." })).toBe(false);
    expect(answered({ by: "precedent", precedentId: "p-1", optionKey: null, words: "Hold." })).toBe(true);
    expect(answered({ by: "precedent" })).toBe(false);
    expect(answered({ by: "owner", via: "autopilot" })).toBe(false);
    expect(answered({ by: "precedent", precedentId: "p-1", via: "autopilot" })).toBe(false);
  });

  it("opens with the recommended option as its prediction, or none when no option is recommended", () => {
    expect(openingPrediction(makeDecision().options)).toEqual({ recommended: { optionKey: "a" }, orchestrator: null });
    expect(openingPrediction(makeDecision().options.map((option) => ({ ...option, recommended: false })))).toEqual({ recommended: null, orchestrator: null });
    expect(openingPrediction([])).toEqual({ recommended: null, orchestrator: null });
  });

  it("keeps predictions and reversals additive and consistent", () => {
    // A decision stored before them reads as it is.
    expect(decisionSchema.parse(makeDecision())).not.toHaveProperty("prediction");
    expect(decisionSchema.safeParse(makeDecision({ prediction: predicted })).success).toBe(true);
    expect(decisionSchema.safeParse(makeDecision({ prediction: { recommended: { optionKey: "z" }, orchestrator: null } })).success).toBe(false);
    expect(decisionSchema.safeParse(makeDecision({ prediction: { ...predicted, orchestrator: { ...predicted.orchestrator, optionKey: "z" } } })).success).toBe(false);
    // Only an answer is reversed.
    expect(decisionSchema.safeParse(makeDecision({ reversals: [{ kind: "reopened", at: AT, ref: "bm-1" }] })).success).toBe(false);
    expect(decisionSchema.safeParse({ ...inStatus("answered"), reversals: [{ kind: "reopened", at: AT, ref: "bm-1" }] }).success).toBe(true);
    expect(decisionSchema.safeParse({ ...inStatus("answered"), reversals: [{ kind: "undone", at: AT, ref: "bm-1" }] }).success).toBe(false);
  });

  it("records a reversal of an answered decision once per kind and reference, and refuses one of a decision never answered", () => {
    const answered = inStatus("answered");
    const once = ok(recordReversal(answered, { kind: "re-asked", at: plus(1), ref: `q:${DECISION_REQUEST}:Q4` }));
    expect(once.reversals).toEqual([{ kind: "re-asked", at: plus(1), ref: `q:${DECISION_REQUEST}:Q4` }]);
    expect(answered).not.toHaveProperty("reversals");
    // The same again changes nothing; another reference or kind is kept beside it.
    const again = recordReversal(once, { kind: "re-asked", at: plus(2), ref: `q:${DECISION_REQUEST}:Q4` });
    expect(again.ok && again.decision).toBe(once);
    const twice = ok(recordReversal(once, { kind: "reopened", at: plus(3), ref: " bm-7 " }));
    expect(twice.reversals?.map((reversal) => `${reversal.kind}:${reversal.ref}`)).toEqual([`re-asked:q:${DECISION_REQUEST}:Q4`, "reopened:bm-7"]);

    for (const status of ["open", "needs-confirmation", "superseded", "withdrawn", "expired"] as const) {
      expect(refusalOf(recordReversal(inStatus(status), { kind: "overridden", at: AT, ref: "r:1" }))).toBe("not-answered");
    }
    expect(refusalOf(recordReversal(answered, { kind: "overridden", at: AT, ref: "  " }))).toBe("invalid-answer");
    // Past the cap it is reversed already: nothing more is kept.
    let full = answered;
    for (let n = 0; n < MAX_DECISION_REVERSALS + 3; n += 1) full = ok(recordReversal(full, { kind: "reopened", at: AT, ref: `bm-${n}` }));
    expect(full.reversals).toHaveLength(MAX_DECISION_REVERSALS);
  });

  it("hides the challenger's prediction from the owner until the decision is settled", () => {
    const open = makeDecision({ prediction: predicted });
    expect(ownerViewOfDecision(open).prediction).toEqual({ recommended: { optionKey: "a" }, orchestrator: null });
    expect(open.prediction).toEqual(predicted);
    expect(ownerViewOfDecision(ok(markNeedsConfirmation(open, { via: "chat-worker", at: AT }))).prediction?.orchestrator).toBeNull();
    const answered = ok(answerDecision(open, { via: "inbox", optionKey: "c", at: AT }));
    expect(ownerViewOfDecision(answered)).toBe(answered);
    const plain = makeDecision();
    expect(ownerViewOfDecision(plain)).toBe(plain);
  });
});

describe("the other transitions", () => {
  it("moves open ↔ needs-confirmation, keeping the first mark", () => {
    const marked = inStatus("needs-confirmation");
    expect(marked.status).toBe("needs-confirmation");
    expect(marked.needsConfirmation).toEqual({ via: "chat-worker", at: AT });
    expect(ok(markNeedsConfirmation(marked, { via: "chat-manager", at: plus(1) })).needsConfirmation).toEqual({ via: "chat-worker", at: AT });

    const kept = ok(confirmDecision(marked, { answered: false, at: plus(2) }));
    expect(kept.status).toBe("open");
    expect(kept.needsConfirmation).toBeNull();
    expect(kept.settledAt).toBeNull();
  });

  it("closes a confirmed chat answer with no option, no words and no grant", () => {
    const closed = ok(confirmDecision(inStatus("needs-confirmation"), { answered: true, at: plus(5) }));
    expect(closed.status).toBe("answered");
    expect(closed.answer).toEqual({ by: "owner", via: "chat-worker", optionKey: null, words: null, at: plus(5) });
    expect(closed.grant).toBeNull();
    expect(closed.settledAt).toBe(plus(5));
  });

  it("confirms only a decision that needs it", () => {
    expect(refusalOf(confirmDecision(makeDecision(), { answered: true, at: AT }))).toBe("not-needs-confirmation");
    expect(refusalOf(confirmDecision(inStatus("answered"), { answered: false, at: AT }))).toBe("settled");
  });

  it("supersedes, withdraws and expires only an unsettled decision", () => {
    const superseded = inStatus("superseded");
    expect(superseded.supersededBy).toBe(`q:${DECISION_REQUEST}:Q2`);
    expect(superseded.settledAt).toBe(AT);
    const fromMarked = ok(supersedeDecision(inStatus("needs-confirmation"), { by: `q:${DECISION_REQUEST}:Q3`, at: AT }));
    expect(fromMarked.needsConfirmation).toBeNull();
    expect(inStatus("withdrawn").status).toBe("withdrawn");
    expect(inStatus("expired").status).toBe("expired");
    for (const status of ["answered", "superseded", "withdrawn", "expired"] as const) {
      const settled = inStatus(status);
      expect(refusalOf(supersedeDecision(settled, { by: `q:${DECISION_REQUEST}:Q9`, at: AT }))).toBe("settled");
      expect(refusalOf(withdrawDecision(settled, { at: AT }))).toBe("settled");
      expect(refusalOf(expireDecision(settled, { at: AT }))).toBe("settled");
      expect(refusalOf(markNeedsConfirmation(settled, { via: "chat-worker", at: AT }))).toBe("settled");
    }
  });

  it("never mutates its input", () => {
    const open = makeDecision();
    const copy = structuredClone(open);
    answerDecision(open, { via: "inbox", optionKey: "a", at: AT });
    markNeedsConfirmation(open, { via: "chat-worker", at: AT });
    supersedeDecision(open, { by: `q:${DECISION_REQUEST}:Q2`, at: AT });
    expect(open).toEqual(copy);
  });
});

describe("grant arithmetic (REQ-112 b)", () => {
  const answered = () => ok(answerDecision(makeDecision(), { via: "inbox", optionKey: "b", at: AT }));

  it("covers the granted effects until the hour is over, and only them", () => {
    const decision = answered();
    expect(decision.grant?.effects).toEqual(["push", "publish"]);
    expect(grantRefusal(decision, ["push"], AT)).toBeNull();
    expect(grantRefusal(decision, ["push", "publish", "none"], plus(GRANT_TTL_MS - 1))).toBeNull();
    expect(grantRefusal(decision, ["push"], plus(GRANT_TTL_MS))?.refusal).toBe("grant-expired");
    expect(grantRefusal(decision, ["deploy"], AT)?.refusal).toBe("effect-not-granted");
    expect(grantRefusal(decision, ["push", "deploy"], AT)?.message).toContain("deploy");
  });

  it("is spent by one use", () => {
    const used = ok(useGrant(answered(), { effects: ["push"], at: plus(60_000) }));
    expect(used.grant?.usedAt).toBe(plus(60_000));
    expect(refusalOf(useGrant(used, { effects: ["push"], at: plus(120_000) }))).toBe("grant-used");
    expect(grantRefusal(used, ["push"], plus(120_000))?.refusal).toBe("grant-used");
  });

  it("refuses a use after expiry, for an undeclared effect, or without a grant", () => {
    expect(refusalOf(useGrant(answered(), { effects: ["push"], at: plus(GRANT_TTL_MS + 1) }))).toBe("grant-expired");
    expect(refusalOf(useGrant(answered(), { effects: ["cost"], at: AT }))).toBe("effect-not-granted");
    expect(refusalOf(useGrant(makeDecision(), { effects: ["push"], at: AT }))).toBe("no-grant");
    const nothing = ok(answerDecision(makeDecision(), { via: "inbox", optionKey: "c", at: AT }));
    expect(refusalOf(useGrant(nothing, { effects: [], at: AT }))).toBe("no-grant");
  });

  it("treats an unparsable time as expired", () => {
    expect(grantRefusal(answered(), ["push"], "not a time")?.refusal).toBe("grant-expired");
  });
});
