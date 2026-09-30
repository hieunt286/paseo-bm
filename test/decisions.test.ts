import { describe, expect, it } from "vitest";
import {
  CONFIRM_EFFECTS,
  DECISION_STATUSES,
  EFFECTS,
  GRANT_TTL_MS,
  MAX_ANSWER_REASON_CHARS,
  MAX_ANSWER_WORDS_CHARS,
  answerDecision,
  confirmDecision,
  decisionKindOf,
  decisionSchema,
  declaredEffects,
  effectsOfAnswer,
  expireDecision,
  grantCovers,
  grantRefusal,
  isAnswerable,
  markNeedsConfirmation,
  needsOwnerConfirmation,
  preparedActionSchema,
  questionDecisionId,
  realEffects,
  supersedeDecision,
  useGrant,
  withdrawDecision,
  type Decision,
  type TransitionResult,
} from "../plugin/shared/decisions";
import { DECISION_REQUEST, makeDecision } from "./helpers/decisions";

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
  });

  it("drops none, repeats and order from a list of effects", () => {
    expect(realEffects(["none", "push", "commit", "push"])).toEqual(["commit", "push"]);
    expect(declaredEffects(makeDecision())).toEqual(["push", "publish"]);
    expect(effectsOfAnswer(makeDecision(), { optionKey: "c" })).toEqual([]);
    expect(effectsOfAnswer(makeDecision(), { optionKey: "zzz" })).toEqual([]);
    expect(effectsOfAnswer(makeDecision(), { optionKey: null })).toEqual(["push", "publish"]);
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

describe("the Orchestrator's answer (bm_decide, change-004)", () => {
  const decided = () =>
    ok(answerDecision(makeDecision(), { by: "orchestrator", via: "autopilot", optionKey: "c", reason: "  Hold: the review is not in yet.  ", at: AT }));

  it("round-trips by: orchestrator with its reason, and grants what the owner's choice of that option would", () => {
    const decision = decided();
    expect(decision.answer).toEqual({ by: "orchestrator", via: "autopilot", optionKey: "c", words: null, at: AT, reason: "Hold: the review is not in yet." });
    expect(decisionSchema.parse(JSON.parse(JSON.stringify(decision)))).toEqual(decision);
    expect(ok(answerDecision(makeDecision(), { by: "orchestrator", via: "autopilot", optionKey: "a", reason: "Only the contract.", at: AT })).grant).toEqual({
      effects: ["push"],
      expiresAt: plus(GRANT_TTL_MS),
      usedAt: null,
    });
  });

  it("still reads an answer stored before it: the owner's, without by-orchestrator or a reason", () => {
    const older = makeDecision({ status: "answered", settledAt: AT, answer: { by: "owner", via: "inbox", optionKey: "a", words: null, at: AT } });
    const parsed = decisionSchema.parse(JSON.parse(JSON.stringify(older)));
    expect(parsed.answer).toEqual({ by: "owner", via: "inbox", optionKey: "a", words: null, at: AT });
    expect(parsed.answer).not.toHaveProperty("reason");
  });

  it("answers only with an option and a reason of 1-300 characters", () => {
    const open = makeDecision();
    expect(refusalOf(answerDecision(open, { by: "orchestrator", via: "autopilot", words: "Hold it.", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { by: "orchestrator", via: "autopilot", optionKey: "c", reason: "   ", at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { by: "orchestrator", via: "autopilot", optionKey: "c", reason: "x".repeat(MAX_ANSWER_REASON_CHARS + 1), at: AT }))).toBe("invalid-answer");
    expect(refusalOf(answerDecision(open, { by: "orchestrator", via: "autopilot", optionKey: "z", reason: "Why not.", at: AT }))).toBe("unknown-option");
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
    const byOwner = answerDecision(inStatus("answered"), { by: "orchestrator", via: "autopilot", optionKey: "c", at: plus(60_000) });
    expect(byOwner.ok ? "" : byOwner.message).toContain("is answered by the owner");
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
    expect(grantCovers(decision, ["push"], AT)).toBe(true);
    expect(grantCovers(decision, ["push", "publish", "none"], plus(GRANT_TTL_MS - 1))).toBe(true);
    expect(grantRefusal(decision, ["push"], plus(GRANT_TTL_MS))?.refusal).toBe("grant-expired");
    expect(grantRefusal(decision, ["deploy"], AT)?.refusal).toBe("effect-not-granted");
    expect(grantRefusal(decision, ["push", "deploy"], AT)?.message).toContain("deploy");
  });

  it("is spent by one use", () => {
    const used = ok(useGrant(answered(), { effects: ["push"], at: plus(60_000) }));
    expect(used.grant?.usedAt).toBe(plus(60_000));
    expect(refusalOf(useGrant(used, { effects: ["push"], at: plus(120_000) }))).toBe("grant-used");
    expect(grantCovers(used, ["push"], plus(120_000))).toBe(false);
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
