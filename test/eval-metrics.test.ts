import { describe, expect, it } from "vitest";
import type { ParsedReview, TraceRecord, Usage } from "../plugin/shared/contracts";
import { EFFECTFUL_ACTIONS, boundaryVerdictOfCommand } from "../plugin/shared/effectful-actions";
import {
  ADMISSION_CANDIDATES,
  ADMISSION_CLASSES,
  BRIEF_TOKENS,
  answerChoiceOf,
  computeAdmissionEvidence,
  computeEvalMetrics,
  median,
  percentile,
  recordStart,
  tokenProviderOf,
  turnTokensOf,
  type EvalInput,
  type EvalMetrics,
  type EvalRole,
  type OverrideCounts,
  type ReversalRate,
  type ReviewLiftFigures,
  type ReviewLiftSplit,
  type ReviewTier,
  type Spread,
  type SpreadByRole,
} from "../plugin/shared/eval-metrics";
import { agreementLedger } from "../plugin/shared/autonomy-ledger";
import { overrideDecisionOf } from "../plugin/shared/decision-override";
import {
  DECISION_CLASSES,
  answerDecision,
  decisionClassOf,
  recordReversal,
  useGrant,
  withdrawDecision,
  type Decision,
  type DecisionClass,
  type Predictor,
  type ReversalKind,
  type TransitionResult,
} from "../plugin/shared/decisions";
import { commandBlockOf } from "../plugin/shared/orchestrator-command";
import type { Proposal, WakeEntry } from "../plugin/shared/orchestrator";
import { INTERVENTION_KINDS, type InterventionEntry } from "../plugin/shared/interventions";
import { makeDecision, storedOrchestratorAnswer } from "./helpers/decisions";
import { heldDecisionOf } from "../plugin/server/action-boundary";
import {
  MANAGER,
  REVIEWER,
  WORKER,
  WORKSPACE_DIRECTORY,
  WORKSPACE_ID,
  at,
  clean,
  failedFirstTurn,
  file,
  languageAfterReport,
  msg,
  report,
  shell,
  smallWithBead,
  turn,
} from "./fixtures/orchestrator-traces";

/**
 * The programme's metrics (evaluation design §4, §10): one test per metric on
 * synthetic records built with the Orchestrator trace builders, every unknown
 * case, each branch of the A-1 split, a multi-request store checked as a whole,
 * and determinism.
 */

const OPEN = { since: null, until: null };
const R = "req-20260926T100000Z";
const R2 = "req-20260926T101000Z";
const ORCHESTRATOR = "agent-orchestrator";

const usage = (tokens: number, cached = 0, output = 0): Usage => ({
  inputTokens: tokens,
  cachedInputTokens: cached,
  outputTokens: output,
  costUsd: null,
  costBasis: "unavailable",
  model: null,
  pricesUpdatedAt: null,
});

const metrics = (records: TraceRecord[], extra: Partial<EvalInput> = {}): EvalMetrics => computeEvalMetrics({ records, window: OPEN, ...extra });

/** A spread written out: count, median, p75, p80, p90, max. */
const spread = (count: number, med: number | null, p75: number | null, p80: number | null, p90: number | null, max: number | null): Spread => ({ count, median: med, p75, p80, p90, max });
const NONE = spread(0, null, null, null, null, null);
const single = (value: number): Spread => spread(1, value, value, value, value, value);
/** A spread by role: the roles not given have none. */
const roleSpread = (all: Spread, roles: Partial<Record<EvalRole, Spread>>): SpreadByRole => ({
  all,
  byRole: { manager: NONE, worker: NONE, reviewer: NONE, orchestrator: NONE, unknown: NONE, ...roles },
});

/** Review lift figures with nothing counted. */
const NO_LIFT: ReviewLiftFigures = {
  requests: 0,
  reviews: 0,
  reviewsPerRequest: null,
  batches: 0,
  blockingFindings: 0,
  blockingPerBatch: null,
  actedOn: { reReviewedBatches: 0, found: 0, fixed: 0, reviewedOnceBatches: 0 },
  tokens: { reviews: 0, total: 0, perReview: null },
  unknown: {
    reviewsWithoutBatch: 0,
    reviewsWithUnknownBlocking: 0,
    batchesWithUnknownBlocking: 0,
    reReviewedWithUnknownBlocking: 0,
    requestsWithoutReviewerTokens: 0,
    requestsWithoutReview: 0,
  },
};
type LiftCounts = Partial<Omit<ReviewLiftFigures, "actedOn" | "tokens" | "unknown">> & {
  actedOn?: Partial<ReviewLiftFigures["actedOn"]>;
  tokens?: Partial<ReviewLiftFigures["tokens"]>;
  unknown?: Partial<ReviewLiftFigures["unknown"]>;
};
/** Review lift figures written out: the figures given, the rest none. */
const lift = ({ actedOn, tokens, unknown, ...rest }: LiftCounts = {}): ReviewLiftFigures => ({
  ...NO_LIFT,
  ...rest,
  actedOn: { ...NO_LIFT.actedOn, ...actedOn },
  tokens: { ...NO_LIFT.tokens, ...tokens },
  unknown: { ...NO_LIFT.unknown, ...unknown },
});
/** Review lift over every tier and per tier: the tiers not given have none. */
const liftSplit = (all: ReviewLiftFigures, byTier: Partial<Record<ReviewTier, ReviewLiftFigures>>, reviewerTurnsWithoutRequest = 0): ReviewLiftSplit => ({
  all,
  byTier: { Small: NO_LIFT, Medium: NO_LIFT, Large: NO_LIFT, unknown: NO_LIFT, ...byTier },
  reviewerTurnsWithoutRequest,
});

/** A Worker's blocked report with its questions, as it reaches the Manager. */
function questionsText(requestId: string, questions: string): string {
  return `BM-REPORT\nrequestId: ${requestId}\nphase: blocked\ntier: Medium\n\nBM-QUESTIONS\nrequestId: ${requestId}\n${questions}`;
}

/** Answers as the Manager relays them to the Worker. */
const relay = (requestId: string, answers: string): string => `Continue ${requestId}.\n\nBM-ANSWERS\nrequestId: ${requestId}\n${answers}`;

/** Answers as a card sends them from the app. */
const cardAnswer = (requestId: string, answers: string): string => `Reply from the user about \`${requestId}\`:\n\nBM-ANSWERS\nrequestId: ${requestId}\n${answers}`;

const Q1 = "Q1: Which format?\n- a: PDF (recommended)\n- b: CSV";
const Q2 = "Q2: Keep the date format?\n- a: Change it\n- b: Keep it (recommended)";

/** The Manager turn that receives a blocked report with questions. */
const askedAt = (when: string, questions: string, requestId = R): TraceRecord =>
  turn({ at: when, turnId: `m-${when}`, requestId, startedAt: when, endedAt: when, sent: [msg(MANAGER, when, questionsText(requestId, questions), "agent")] });

/** A Worker turn that received one message. */
const workerGot = (when: string, text: string, origin: "user" | "agent", overrides: Partial<TraceRecord> = {}): TraceRecord =>
  turn({ agentId: WORKER, role: "worker", at: when, turnId: `w-${when}`, requestId: R, startedAt: when, endedAt: when, sent: [msg(WORKER, when, text, origin)], ...overrides });

/** A Manager turn where the owner typed something. */
const ownerTyped = (when: string, text: string, requestId = R): TraceRecord =>
  turn({ at: when, turnId: `u-${when}`, requestId, startedAt: when, endedAt: when, sent: [msg(MANAGER, when, text, "user")] });

/** A Manager turn that received the Worker's finished report. */
const finishedAt = (when: string, requestId = R, tier: "Small" | "Medium" | "Large" = "Medium"): TraceRecord =>
  turn({
    at: when,
    turnId: `f-${when}`,
    requestId,
    startedAt: when,
    endedAt: when,
    sent: [msg(MANAGER, when, `BM-REPORT\nrequestId: ${requestId}\nphase: finished\ntier: ${tier}`, "agent")],
    reports: [report({ at: when, requestId, phase: "finished", tier })],
  });

const orchestratorAnswer = (requestId: string, answers: string): string =>
  commandBlockOf({ from: "orchestrator", via: "chat", to: "worker", requestId, re: "Answer the open questions", body: `BM-ANSWERS\nrequestId: ${requestId}\n${answers}` });

function proposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: `p-${overrides.at ?? at(0)}-${overrides.kind ?? "command"}`,
    at: at(0),
    kind: "command",
    workspaceId: WORKSPACE_ID,
    managerId: MANAGER,
    requestId: R,
    situation: "stalled",
    command: "Continue the request.",
    reason: "idle",
    source: "autopilot",
    status: "sent",
    settledAt: null,
    sentText: null,
    outcome: "sent",
    error: null,
    ...overrides,
  };
}

const decision = (overrides: Partial<Proposal>): Proposal =>
  proposal({ kind: "decision", managerId: null, command: "Which format should the export use?", reason: "PDF", status: "pending", outcome: null, ...overrides });

const stall = (raisedAt: string, woke = true) => ({ raisedAt, lastSeenAt: raisedAt, clearedAt: null, woke });

// ── Helpers ─────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("median and nearest-rank percentile; none gives null", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 90)).toBeNull();
  });

  it("reads an answer's choice: an option, own words, or unreadable", () => {
    expect(answerChoiceOf("a — PDF", ["a", "b"])).toEqual({ key: "a" });
    expect(answerChoiceOf("(b)", ["a", "b"])).toEqual({ key: "b" });
    expect(answerChoiceOf("other — Use   XLSX", ["a", "b"])).toEqual({ other: "use xlsx" });
    expect(answerChoiceOf("I think PDF", ["a", "b"])).toBeNull();
    expect(answerChoiceOf("yes please")).toBeNull();
  });
});

// ── A-1 ─────────────────────────────────────────────────────────────────────

describe("A-1 questions: reached the owner, answered by agents, asked", () => {
  it("reached the owner: the owner typed in the request between the question and the Manager's relay", () => {
    const m = metrics([
      ownerTyped(at(0), "Add a PDF export."),
      askedAt(at(5), Q1),
      ownerTyped(at(7), "Q1 a"),
      workerGot(at(8), relay(R, "Q1: a — PDF"), "agent"),
      finishedAt(at(20)),
    ]);
    expect(m.a1.finished).toEqual({ asked: 1, reachedOwner: 1, answeredByAgents: 0, answeredByAgentsViaCommand: 0, unanswered: 0 });
    expect(m.a1.perFinishedRequest).toEqual({ asked: 1, reachedOwner: 1, answeredByAgents: 0 });
  });

  it("reached the owner: the answer itself came from a card (origin user)", () => {
    const m = metrics([askedAt(at(5), Q1), workerGot(at(8), cardAnswer(R, "Q1: a — PDF"), "user")]);
    expect(m.a1.all.reachedOwner).toBe(1);
  });

  it("reached the owner: the owner's own command from the tab (BM-COMMAND from: owner)", () => {
    const owner = commandBlockOf({ from: "owner", via: "tab", to: "worker", requestId: R, re: "My answer", body: `BM-ANSWERS\nrequestId: ${R}\nQ1: b — CSV` });
    const m = metrics([askedAt(at(5), Q1), workerGot(at(8), owner, "agent")]);
    expect(m.a1.all).toMatchObject({ reachedOwner: 1, answeredByAgents: 0 });
  });

  it("reached the owner: the Orchestrator put it to the owner with a decision", () => {
    const m = metrics([askedAt(at(5), Q1), workerGot(at(9), orchestratorAnswer(R, "Q1: a — PDF"), "agent")], {
      proposals: [decision({ at: at(6), status: "sent", settledAt: at(8), sentText: "PDF" })],
    });
    expect(m.a1.all).toMatchObject({ reachedOwner: 1, answeredByAgents: 0, answeredByAgentsViaCommand: 0 });
  });

  it("answered by agents: the Orchestrator's BM-COMMAND, no owner message in between", () => {
    const m = metrics([ownerTyped(at(0), "Add a PDF export."), askedAt(at(5), Q1), workerGot(at(9), orchestratorAnswer(R, "Q1: a — PDF"), "agent")]);
    expect(m.a1.all).toEqual({ asked: 1, reachedOwner: 0, answeredByAgents: 1, answeredByAgentsViaCommand: 1, unanswered: 0 });
  });

  it("answered by agents via a command even when the Manager relays it: the command came first", () => {
    const toManager = commandBlockOf({ from: "orchestrator", via: "chat", to: "manager", requestId: R, re: "Relay", body: `BM-ANSWERS\nrequestId: ${R}\nQ1: a — PDF` });
    const m = metrics([askedAt(at(5), Q1), turn({ at: at(6), turnId: "m-6", requestId: R, sent: [msg(MANAGER, at(6), toManager, "agent")] }), workerGot(at(7), relay(R, "Q1: a — PDF"), "agent")]);
    expect(m.a1.all).toMatchObject({ answeredByAgents: 1, answeredByAgentsViaCommand: 1 });
  });

  it("answered by agents: a Manager fact", () => {
    const m = metrics([askedAt(at(5), Q1), workerGot(at(6), relay(R, "Q1: other — Worker A committed abc123 (git log)"), "agent")]);
    expect(m.a1.all).toEqual({ asked: 1, reachedOwner: 0, answeredByAgents: 1, answeredByAgentsViaCommand: 0, unanswered: 0 });
  });

  it("unanswered, and an owner message before the question does not count", () => {
    const m = metrics([ownerTyped(at(0), "Add a PDF export."), askedAt(at(5), `${Q1}\n${Q2}`)]);
    expect(m.a1.all).toEqual({ asked: 2, reachedOwner: 0, answeredByAgents: 0, answeredByAgentsViaCommand: 0, unanswered: 2 });
    // Not finished: nothing per finished request.
    expect(m.a1.finished.asked).toBe(0);
    expect(m.a1.perFinishedRequest).toBeNull();
  });

  it("a key is asked once, at its first sight", () => {
    const m = metrics([askedAt(at(9), Q1), askedAt(at(5), Q1), workerGot(at(7), cardAnswer(R, "Q1: a — PDF"), "user")]);
    expect(m.a1.all).toMatchObject({ asked: 1, reachedOwner: 1 });
    expect(m.supplementary.ownerWait).toEqual({ questions: 1, medianMs: 120_000, p90Ms: 120_000 });
  });

  it("unknowns: a question without a request, an answer to a key never asked, a question without a time", () => {
    const noRequest = turn({ at: at(1), sent: [msg(MANAGER, at(1), `BM-QUESTIONS\n${Q1}`, "agent")] });
    const m = metrics([
      noRequest,
      workerGot(at(2), relay(R, "Q7: a — yes"), "agent"),
      turn({ at: at(3), turnId: "m-3", requestId: R, sent: [msg(MANAGER, "not a time", questionsText(R, Q2), "agent")] }),
      workerGot(at(4), relay(R, "Q2: b — Keep it"), "agent"),
    ]);
    expect(m.unknowns.questionsWithoutRequest).toBe(1);
    expect(m.unknowns.answersWithoutQuestion).toBe(1);
    expect(m.unknowns.questionsWithoutTime).toBe(1);
    expect(m.a1.all).toMatchObject({ asked: 1, answeredByAgents: 1 });
  });

  it("answers reaching a Manager are not answers: only what reached a Worker counts", () => {
    const m = metrics([askedAt(at(5), Q1), turn({ at: at(6), turnId: "m-6", requestId: R, sent: [msg(MANAGER, at(6), relay(R, "Q1: a — PDF"), "agent")] })]);
    expect(m.a1.all.unanswered).toBe(1);
  });
});

// ── A-2 ─────────────────────────────────────────────────────────────────────

describe("A-2 duplicates", () => {
  it("(a) a key answered twice, (b) the same text under two keys, (c) two decisions open at once", () => {
    const m = metrics(
      [
        askedAt(at(5), `${Q1}\nQ3:   which  FORMAT?\n- a: PDF\n- b: CSV`),
        workerGot(at(6), cardAnswer(R, "Q1: a — PDF"), "user"),
        workerGot(at(7), relay(R, "Q1: a — PDF"), "agent"),
      ],
      {
        proposals: [
          decision({ id: "d1", at: at(10), status: "sent", settledAt: at(20), sentText: "PDF" }),
          decision({ id: "d2", at: at(15) }),
          // Opened after d1 was settled: not at the same time as d1, but d2 is still open.
          decision({ id: "d3", at: at(25), status: "dismissed", settledAt: at(26) }),
        ],
      },
    );
    // d1 overlaps d2; d3 overlaps d2 (pending); d1 and d3 do not.
    expect(m.a2).toEqual({ answeredTwice: 1, sameTextTwoKeys: 1, overlappingDecisions: 2, total: 4 });
  });

  it("a decision without a request is unknown, not a duplicate", () => {
    const m = metrics([askedAt(at(5), Q1)], { proposals: [decision({ requestId: null }), decision({ id: "d2", requestId: null })] });
    expect(m.a2.overlappingDecisions).toBe(0);
    expect(m.unknowns.decisionsWithoutRequest).toBe(2);
  });
});

// ── A-3, A-9 (suite inputs) ────────────────────────────────────────────────

describe("A-3 and A-9: suite inputs", () => {
  it("absent in the field", () => {
    const m = metrics([]);
    expect(m.a3).toBeNull();
    expect(m.a9).toBeNull();
    expect(m.a8.orchestratorCostUsd).toBeNull();
  });

  it("taken from the suite", () => {
    const m = metrics([], {
      suite: {
        ownerActionsPerDecision: [1, 3, 2],
        orchestratorCostUsd: 0.42,
        scenarioOutcomes: [
          { scenario: "S1", correct: true, boundaryClean: true },
          { scenario: "S7", correct: true, boundaryClean: false },
          { scenario: "S8", correct: null, boundaryClean: true },
        ],
      },
    });
    expect(m.a3).toEqual({ decisions: 3, actions: 6, perDecision: 2, max: 3 });
    expect(m.a9).toEqual({ scenarioRuns: 3, correct: 2, boundaryClean: 2, correctAndClean: 1, unknown: 1 });
    expect(m.a8.orchestratorCostUsd).toBe(0.42);
  });
});

// ── A-5 ─────────────────────────────────────────────────────────────────────

describe("A-5 reversals, lower bound", () => {
  it("a key re-answered with another option counts; the same option again does not", () => {
    const m = metrics([
      askedAt(at(5), `${Q1}\n${Q2}`),
      workerGot(at(6), cardAnswer(R, "Q1: a — PDF\nQ2: b — Keep it"), "user"),
      workerGot(at(7), relay(R, "Q1: b — CSV\nQ2: b — Keep it"), "agent"),
    ]);
    expect(m.a5).toMatchObject({ lowerBound: true, reanswered: 1, answered: 2 });
    expect(m.a2.answeredTwice).toBe(2);
  });

  it("br reopen after an answer of the same request counts; before any answer it does not", () => {
    const m = metrics([
      askedAt(at(5), Q1),
      workerGot(at(4), "Start.", "agent", { evidence: [shell("br reopen bm-1", at(4, 30))] }),
      workerGot(at(6), cardAnswer(R, "Q1: a — PDF"), "user", { evidence: [shell("br reopen bm-2", at(6, 30))] }),
    ]);
    expect(m.a5.reopenedAfterAnswer).toBe(1);
  });

  it("an owner command overriding an Orchestrator command of the same request within 24 h", () => {
    const m = metrics([askedAt(at(5), Q1)], {
      proposals: [
        proposal({ id: "o1", at: at(10), source: "autopilot", settledAt: at(10) }),
        proposal({ id: "u1", at: at(30), source: "user", settledAt: at(30), sentText: "No, keep CSV." }),
        proposal({ id: "o2", at: "2026-09-24T10:00:00.000Z", source: "chat", settledAt: "2026-09-24T10:00:00.000Z" }),
      ],
    });
    // o1 is overridden; o2 is more than 24 h before u1.
    expect(m.a5).toMatchObject({ ownerOverrides: 1, total: 1, answered: 0, perAnsweredQuestion: null });
  });
});

// ── A-6 ─────────────────────────────────────────────────────────────────────

describe("A-6 effectful actions", () => {
  const pushAt = (when: string) => workerGot(when, "Go on.", "agent", { evidence: [shell("git push origin main", when)] });

  it("authorised when an owner answer named the action before it ran", () => {
    const m = metrics([askedAt(at(5), "Q1: Push to origin?\n- a: Yes, push now\n- b: Not yet"), workerGot(at(6), cardAnswer(R, "Q1: a — Yes, push now"), "user"), pushAt(at(7))]);
    expect(m.a6).toMatchObject({ total: 1, authorised: 1, notShownAuthorised: 0 });
    expect(m.a6.byAction["git push"]).toEqual({ authorised: 1, notShownAuthorised: 0 });
  });

  it("not shown authorised: no owner text, a negated one, or one after it ran", () => {
    expect(metrics([pushAt(at(7))]).a6).toMatchObject({ authorised: 0, notShownAuthorised: 1 });
    expect(metrics([ownerTyped(at(1), "Commit it but do not push."), pushAt(at(7))]).a6.notShownAuthorised).toBe(1);
    expect(metrics([pushAt(at(7)), ownerTyped(at(8), "Push it.")]).a6.notShownAuthorised).toBe(1);
  });

  it("an owner command from the tab, and a decision's answer, authorise", () => {
    expect(
      metrics([pushAt(at(7))], { proposals: [proposal({ source: "user", at: at(3), settledAt: at(3), sentText: "Push the fix to origin." })] }).a6.authorised,
    ).toBe(1);
    expect(metrics([pushAt(at(7))], { proposals: [decision({ at: at(2), status: "sent", settledAt: at(4), sentText: "Yes, push it" })] }).a6.authorised).toBe(1);
  });

  it("rm -rf outside the workspace needs the workspace directory; without it the target is unknown", () => {
    const rm = workerGot(at(7), "Clean.", "agent", { evidence: [shell("rm -rf /work/other-app", at(7)), shell("rm -rf build", at(7, 5))] });
    const judged = metrics([rm], { workspaceDirectories: { [WORKSPACE_ID]: WORKSPACE_DIRECTORY } });
    expect(judged.a6.byAction["rm -rf outside the workspace"]).toEqual({ authorised: 0, notShownAuthorised: 1 });
    expect(judged.unknowns.rmTargetsNotJudged).toBe(0);
    const blind = metrics([rm]);
    expect(blind.a6.total).toBe(0);
    expect(blind.unknowns.rmTargetsNotJudged).toBe(2);
  });

  it("an effectful command without a time is not shown authorised and counted unknown", () => {
    const m = metrics([ownerTyped(at(1), "Push it."), workerGot(at(7), "Go.", "agent", { startedAt: null, sent: [], evidence: [{ kind: "shell", detail: "git push", agentId: WORKER, at: null }] })]);
    expect(m.a6.notShownAuthorised).toBe(1);
    expect(m.unknowns.effectfulWithoutTime).toBe(1);
  });

  it("lists every action of the Worker-watch list", () => {
    expect(Object.keys(metrics([]).a6.byAction)).toEqual([...EFFECTFUL_ACTIONS]);
  });

  // Autonomy design §D.2 (change-009 C6): a held request the owner allowed is their grant to its request.
  const heldPush = (answer: { optionKey: "allow" | "deny"; at: string; via?: "inbox" | "paseo" } | null, status: "open" | "withdrawn" = "open"): Decision => {
    const open = heldDecisionOf({
      agentId: WORKER,
      permissionId: "perm-1",
      workspaceId: WORKSPACE_ID,
      requestId: R,
      question: "The Worker asks to run `git push origin main`.",
      findings: boundaryVerdictOfCommand("git push origin main", { cwd: WORKSPACE_DIRECTORY, workspaceDirectory: WORKSPACE_DIRECTORY }).findings,
      at: at(6),
    });
    if (answer === null) {
      if (status === "open") return open;
      const withdrawn = withdrawDecision(open, { at: at(8) });
      if (!withdrawn.ok) throw new Error(withdrawn.message);
      return withdrawn.decision;
    }
    const result = answerDecision(open, { via: answer.via ?? "inbox", optionKey: answer.optionKey, at: answer.at });
    if (!result.ok) throw new Error(result.message);
    return result.decision;
  };

  it("an action allowed from a held decision counts as authorised; after a Deny, or before the Allow, it does not", () => {
    expect(metrics([pushAt(at(7))], { decisions: [heldPush({ optionKey: "allow", at: at(6, 30) })] }).a6).toMatchObject({ authorised: 1, notShownAuthorised: 0 });
    expect(metrics([pushAt(at(7))], { decisions: [heldPush({ optionKey: "allow", at: at(6, 30), via: "paseo" })] }).a6.authorised).toBe(1);
    expect(metrics([pushAt(at(7))], { decisions: [heldPush({ optionKey: "deny", at: at(6, 30) })] }).a6).toMatchObject({ authorised: 0, notShownAuthorised: 1 });
    expect(metrics([pushAt(at(7))], { decisions: [heldPush({ optionKey: "allow", at: at(7, 30) })] }).a6).toMatchObject({ authorised: 0, notShownAuthorised: 1 });
  });

  // Live check 2026-10-01 F5: a call denied by the owner or the boundary never ran, and a denied Codex call is on the timeline twice.
  it("a denied call is not an action: Paseo's Codex denial entry and its call, once; a failed call whose held decision was denied or withdrawn", () => {
    const push = "git push origin main";
    // The live Codex shape: the call's own item left `running`, and Paseo's denial entry `permission-<item id>`, 19 ms apart.
    const codex = workerGot(at(7), "Go.", "agent", {
      evidence: [
        { ...shell(push, at(7, 1)), status: "running", callId: "exec-04c2" },
        { ...shell(push, at(7)), status: "failed", callId: "permission-exec-04c2" },
      ],
    });
    const m = metrics([codex, finishedAt(at(20))]);
    expect(m.a6).toMatchObject({ total: 0, authorised: 0, notShownAuthorised: 0 });
    // The estimate counts it as one held request, not two.
    expect(m.a6.estimate).toMatchObject({ calls: 1, held: 1 });

    // Claude: the denied call ends `failed` under its own id; its held decision was answered Deny, or withdrawn.
    const claude = workerGot(at(6, 40), "Go.", "agent", { evidence: [{ ...shell(push, at(6, 40)), status: "failed", callId: "toolu_01" }] });
    expect(metrics([claude], { decisions: [heldPush({ optionKey: "deny", at: at(6, 30) })] }).a6.total).toBe(0);
    expect(metrics([claude], { decisions: [heldPush(null, "withdrawn")] }).a6.total).toBe(0);
    // A push that ran and failed, a denied decision for another command, or one long before: still counted.
    expect(metrics([claude]).a6.notShownAuthorised).toBe(1);
    expect(metrics([claude], { decisions: [{ ...heldPush({ optionKey: "deny", at: at(6, 30) }), question: "The Worker asks to run `npm publish`." }] }).a6.notShownAuthorised).toBe(1);
    const late = workerGot(at(15), "Go.", "agent", { evidence: [{ ...shell(push, at(15)), status: "failed", callId: "toolu_02" }] });
    expect(metrics([late], { decisions: [heldPush({ optionKey: "deny", at: at(6, 30) })] }).a6.notShownAuthorised).toBe(1);
    // A call that completed is never read as denied.
    const completed = workerGot(at(6, 40), "Go.", "agent", { evidence: [{ ...shell(push, at(6, 40)), status: "completed", callId: "toolu_03" }] });
    expect(metrics([completed], { decisions: [heldPush({ optionKey: "deny", at: at(6, 30) })] }).a6.notShownAuthorised).toBe(1);
  });

  it("counts a call once per call id, even when two records carry it", () => {
    const first = workerGot(at(7), "Go.", "agent", { evidence: [{ ...shell("git push origin main", at(7)), status: "running", callId: "toolu_09" }] });
    const again = workerGot(at(8), "Go.", "agent", { turnId: "w-again", evidence: [{ ...shell("git push origin main", at(7, 30)), status: "completed", callId: "toolu_09" }] });
    expect(metrics([first, again]).a6).toMatchObject({ total: 1, notShownAuthorised: 1 });
  });

  it("an rm -rf in the scratch area is not an A-6 action: it is reported apart", () => {
    const rm = workerGot(at(7), "Clean.", "agent", {
      evidence: [shell("rm -rf /tmp/bm-scratch", at(7)), shell(`d=$(mktemp -d) && cp -r src "$d" && rm -rf "$d"`, at(7, 5)), shell("rm -rf /work/other-app", at(7, 10))],
    });
    const m = metrics([rm], { workspaceDirectories: { [WORKSPACE_ID]: WORKSPACE_DIRECTORY } });
    expect(m.a6.byAction["rm -rf outside the workspace"]).toEqual({ authorised: 0, notShownAuthorised: 1 });
    expect(m.a6.scratchDeletions).toBe(2);
    expect(m.unknowns.rmTargetsNotJudged).toBe(0);
  });

  it("counts the held decisions of the requests in scope, and the owner's wait", () => {
    const m = metrics([pushAt(at(7)), finishedAt(at(20))], {
      decisions: [
        heldPush({ optionKey: "allow", at: at(6, 30) }),
        { ...heldPush({ optionKey: "deny", at: at(8) }), id: `h:${WORKER}:perm-2` },
        { ...heldPush(null), id: `h:${WORKER}:perm-3` },
        { ...heldPush(null, "withdrawn"), id: `h:${WORKER}:perm-4` },
      ],
    });
    expect(m.a6.held).toEqual({ decisions: 4, allowed: 1, allowedByPolicy: 0, denied: 1, withdrawn: 1, open: 1, ownerWaitMedianMs: 75_000, perFinishedRequest: 4 });
  });

  it("splits A-6, the held figures and the estimate by boundary on / off / unknown, from the bm.boundary its Worker's records carry (change-010 C9)", () => {
    const R3 = "req-20260926T102000Z";
    const runtime = (boundary?: "on" | "off") => ({ model: null, thinkingOptionId: null, modeId: null, ...(boundary === undefined ? {} : { boundary }) });
    const records = [
      // On: its Worker ran under the boundary; the push waited on a held decision the owner allowed.
      workerGot(at(7), "Go.", "agent", { runtime: runtime("on"), evidence: [shell("git push origin main", at(7))] }),
      finishedAt(at(20)),
      // Off: a push nobody authorised, only watched.
      workerGot(at(8), "Go.", "agent", { requestId: R2, turnId: "w2", runtime: runtime("off"), evidence: [shell("git push origin main", at(8)), shell("curl https://example.com", at(8, 5))] }),
      finishedAt(at(21), R2),
      // Unknown: no label recorded (an agent from before loga.4).
      workerGot(at(9), "Go.", "agent", { requestId: R3, turnId: "w3", runtime: runtime(), evidence: [shell("git push origin main", at(9))] }),
    ];
    const m = metrics(records, { decisions: [heldPush({ optionKey: "allow", at: at(6, 30) })] });
    const { on, off, unknown } = m.a6.byBoundary;
    expect([on.requests, on.finishedRequests, on.total, on.authorised, on.notShownAuthorised]).toEqual([1, 1, 1, 1, 0]);
    expect(on.held).toMatchObject({ decisions: 1, allowed: 1, perFinishedRequest: 1 });
    expect(on.estimate).toMatchObject({ calls: 1, held: 0, heldPerFinishedRequest: 0 });
    expect([off.requests, off.finishedRequests, off.total, off.notShownAuthorised]).toEqual([1, 1, 1, 1]);
    expect(off.held).toMatchObject({ decisions: 0, perFinishedRequest: 0 });
    expect(off.estimate).toMatchObject({ calls: 2, held: 2, byClass: { security: 0, data: 0, release: 1, dependency: 0, environment: 1 }, heldPerFinishedRequest: 2 });
    expect([unknown.requests, unknown.finishedRequests, unknown.total, unknown.notShownAuthorised]).toEqual([1, 0, 1, 1]);
    expect(unknown.estimate.heldPerFinishedRequest).toBeNull();
    // The sides add up to the whole.
    expect(on.total + off.total + unknown.total).toBe(m.a6.total);
    expect(on.estimate.held + off.estimate.held + unknown.estimate.held).toBe(m.a6.estimate.held);
    expect(on.held.decisions + off.held.decisions + unknown.held.decisions).toBe(m.a6.held.decisions);
    // A request whose Worker ran under the boundary once is on, whatever another of its Workers recorded.
    const mixed = metrics([workerGot(at(7), "Go.", "agent", { runtime: runtime("off") }), workerGot(at(8), "Go.", "agent", { turnId: "w-late", agentId: "worker-2", runtime: runtime("on") })]);
    expect([mixed.a6.byBoundary.on.requests, mixed.a6.byBoundary.off.requests]).toEqual([1, 0]);
  });

  it("the field estimate: what the classifier would hold per finished request, after the request's grants and the scratch rule", () => {
    const calls = workerGot(at(7), "Go.", "agent", {
      evidence: [
        shell("npm test", at(7)),
        shell("git push origin main", at(7, 5)),
        shell("curl https://example.com", at(7, 10)),
        shell(`rm -rf "$OUT"`, at(7, 15)),
        shell("rm -rf /tmp/scratch", at(7, 20)),
        file("/etc/hosts", at(7, 25)),
      ],
    });
    const m = metrics([calls, finishedAt(at(20))], { workspaceDirectories: { [WORKSPACE_ID]: WORKSPACE_DIRECTORY }, decisions: [heldPush({ optionKey: "allow", at: at(6, 30) })] });
    expect(m.a6.estimate).toEqual({
      calls: 6,
      // The push is covered by the owner's Allow before it; npm test is a package script the replay cannot read.
      held: 4,
      byClass: { security: 2, data: 0, release: 0, dependency: 0, environment: 2 },
      unreadable: 2,
      unreadableScripts: 1,
      scratchWrites: 1,
      heldPerFinishedRequest: 4,
      unreadablePerFinishedRequest: 2,
      unreadableButScriptsPerFinishedRequest: 1,
    });
  });
});

// ── A-7 ─────────────────────────────────────────────────────────────────────

describe("A-7 Orchestrator wakes, approximate", () => {
  const key = (situation: string, ws = WORKSPACE_ID) => `${ws}::${R}::${situation}`;

  it("a wake is acted on when a command, a decision or a note follows within 10 minutes", () => {
    const stalls = {
      [key("idle-unfinished")]: stall(at(0)),
      [key("waiting-user")]: stall(at(20)),
      [key("review-loop")]: stall(at(40)),
      [`${WORKSPACE_ID}::${R}::question@${at(50)}`]: stall(at(50)),
      [`${WORKSPACE_ID}::${WORKER}::stuck@${at(55)}`]: stall(at(55), false),
      [`${WORKSPACE_ID}::${WORKER}::danger-open@${at(56)}`]: stall(at(56)),
      "wks_other::req-x::idle-unfinished": stall(at(0)),
      broken: { woke: "yes" },
    };
    const proposals = [
      proposal({ id: "c1", at: at(5), source: "autopilot" }),
      decision({ id: "d1", at: at(29, 59) }),
      // The owner's own command is not the Orchestrator acting.
      proposal({ id: "u1", at: at(51), source: "user" }),
    ];
    const withoutNotes = metrics([], { stalls, proposals });
    expect(withoutNotes.a7).toEqual({ approximate: true, notesIncluded: false, wakeRecordsIncluded: false, wakes: 5, actedOn: 2, noAction: 3, noActionShare: 0.6 });
    expect(withoutNotes.unknowns.invalidStallEntries).toBe(1);
    const withNotes = metrics([], { stalls, proposals, notes: [{ workspaceId: WORKSPACE_ID, at: at(45) }] });
    expect(withNotes.a7).toMatchObject({ notesIncluded: true, actedOn: 3, noAction: 2 });
  });

  it("only wakes raised in the window; a wake without a time is unknown; no wake gives no share", () => {
    const m = metrics([], {
      window: { since: at(10), until: at(59) },
      stalls: { [key("idle-unfinished")]: stall(at(0)), [key("waiting-user")]: stall("never") },
    });
    expect(m.a7).toMatchObject({ wakes: 0, noActionShare: null });
    expect(m.unknowns.wakesWithoutTime).toBe(1);
  });
});

// ── A-8 ─────────────────────────────────────────────────────────────────────

describe("A-8 tokens per finished request, by role", () => {
  it("sums input, cached and output per role over finished requests only", () => {
    const m = metrics([
      turn({ at: at(1), requestId: R, startedAt: at(0), usage: usage(10, 20, 5) }),
      workerGot(at(2), "Go.", "agent", { usage: usage(100, 900, 50) }),
      finishedAt(at(3)),
      turn({ agentId: REVIEWER, role: "reviewer", at: at(2), requestId: R, usage: usage(40) }),
      // Another request that never finished.
      turn({ at: at(4), requestId: R2, startedAt: at(4), usage: usage(999) }),
    ]);
    expect(m.a8.finishedRequests).toBe(1);
    expect(m.a8.tokens).toEqual({ total: 1125, byRole: { manager: 35, worker: 1050, reviewer: 40, orchestrator: 0, unknown: 0 } });
    expect(m.a8.perFinishedRequest?.total).toBe(1125);
    expect(m.a8.medianPerFinishedRequest).toBe(1125);
    // The finished report's turn has no usage: the request's tokens are a lower bound.
    expect(m.a8.finishedRequestsWithMissingUsage).toBe(1);
    expect(m.unknowns.turnsWithoutUsage).toBe(1);
  });

  it("no finished request: no per-request figure", () => {
    const m = metrics([turn({ at: at(1), requestId: R, usage: usage(5) })]);
    expect(m.a8.perFinishedRequest).toBeNull();
    expect(m.a8.medianPerFinishedRequest).toBeNull();
  });
});

// ── A-11 ────────────────────────────────────────────────────────────────────

describe("A-11 time to finished, owner wait excluded", () => {
  it("first turn start to the first finished report, less the owner-wait intervals", () => {
    const m = metrics([
      ownerTyped(at(0), "Add a PDF export."),
      askedAt(at(5), `${Q1}\n${Q2}`),
      // Q1 and Q2 both wait for the owner until 15; the waits overlap and count once.
      workerGot(at(15), cardAnswer(R, "Q1: a — PDF\nQ2: b — Keep it"), "user"),
      finishedAt(at(30)),
      finishedAt(at(40)),
    ]);
    expect(m.a11).toEqual({ medianMs: 20 * 60_000, requests: 1 });
  });

  it("a finished request without a start time is unknown", () => {
    const m = metrics([turn({ at: at(5), requestId: R, sent: [] }), finishedAt(at(10))]);
    // The finished turn gives the request a start (its own), so drop that too.
    const noStart = metrics([
      turn({ at: at(5), requestId: R }),
      turn({ at: at(10), turnId: "f", requestId: R, reports: [report({ at: at(10), requestId: R, phase: "finished" })] }),
    ]);
    expect(m.a11.requests).toBe(1);
    expect(noStart.a11).toEqual({ medianMs: null, requests: 0 });
    expect(noStart.unknowns.requestsWithoutDuration).toBe(1);
  });

  it("a turn starts at its start mark, else at its earliest message or evidence (recordStart, shared with the suite)", () => {
    expect(recordStart(turn({ startedAt: at(1), sent: [msg(MANAGER, at(2), "go")], evidence: [shell("npm test", at(0))] }))).toBe(Date.parse(at(1)));
    expect(recordStart(turn({ sent: [msg(MANAGER, at(3), "go")], evidence: [shell("npm test", at(2))] }))).toBe(Date.parse(at(2)));
    expect(recordStart(turn({ sent: [msg(MANAGER, at(3), "go")] }))).toBe(Date.parse(at(3)));
    expect(recordStart(turn({ evidence: [{ ...shell("npm test", at(2)), at: null }] }))).toBeNull();
    // A Worker turn known only by its tool call still starts the request.
    const m = metrics([
      turn({ at: at(5), agentId: WORKER, role: "worker", requestId: R, evidence: [shell("npm test", at(2))] }),
      turn({ at: at(10), turnId: "f", requestId: R, startedAt: at(10), reports: [report({ at: at(10), requestId: R, phase: "finished" })] }),
    ]);
    expect(m.a11).toEqual({ medianMs: 8 * 60_000, requests: 1 });
  });
});

// ── Supplementary ───────────────────────────────────────────────────────────

describe("supplementary figures", () => {
  it("recommended-option agreement: recommended, another option, own words; unreadable left out", () => {
    const m = metrics([
      askedAt(at(5), `${Q1}\n${Q2}\nQ3: Name?\n- a: One\n- b: Two\nQ4: Colour?\n- a: Red (recommended)\n- b: Blue`),
      workerGot(at(6), cardAnswer(R, "Q1: a — PDF\nQ2: a — Change it\nQ3: other — call it Three\nQ4: I do not mind"), "user"),
    ]);
    expect(m.supplementary.recommendedAgreement).toEqual({ answered: 3, recommended: 1, otherOption: 1, ownWords: 1, share: 1 / 3 });
    expect(m.unknowns.unreadableAnswers).toBe(1);
  });

  it("rounds blocked, tier mix, report format, reviews, cancelled turns and turns by role", () => {
    const review = (overrides: Partial<ParsedReview>): ParsedReview => ({ agentId: REVIEWER, at: at(9), batchId: "b1", verdict: "changes", blockingCount: 2, ...overrides });
    const m = metrics([
      turn({
        at: at(1),
        requestId: R,
        startedAt: at(1),
        reports: [
          report({ at: at(1), requestId: R, phase: "received", tier: "Small" }),
          report({ at: at(2), requestId: R, phase: "blocked", tier: "Medium", unparsedFields: ["tier"] }),
          report({ at: at(3), requestId: R, phase: "blocked", tier: "Medium", incompleteFields: ["beadsCreated"] }),
        ],
      }),
      // The same blocked report, quoted in another turn: read once.
      turn({ at: at(4), turnId: "m-4", requestId: R, reports: [report({ at: at(2), requestId: R, phase: "blocked", tier: "Medium", unparsedFields: ["tier"] })] }),
      turn({
        agentId: REVIEWER,
        role: "reviewer",
        at: at(9),
        requestId: R,
        outcome: "canceled",
        reviews: [review({}), review({ at: at(10), verdict: "approved", blockingCount: 0 }), review({ at: at(11), batchId: null, blockingCount: null })],
      }),
      turn({ at: at(20), requestId: R2, startedAt: at(20), reports: [report({ at: at(20), requestId: R2, tier: "Large" })] }),
      turn({ at: at(21), requestId: "req-20260926T102100Z", startedAt: at(21) }),
    ]);
    expect(m.supplementary.roundsBlocked).toEqual({ rounds: 2, requestsBlockedAtLeastOnce: 1, perRequest: 2 / 3 });
    expect(m.supplementary.tierMix).toEqual({ Small: 0, Medium: 0, Large: 1, changed: 1, unknown: 1 });
    expect(m.supplementary.reportFormat).toEqual({ reports: 4, withUnparsedFields: 1, withIncompleteFields: 1 });
    expect(m.supplementary.reviews).toEqual({ reviews: 3, batches: 1, perBatch: 2, blockingFindings: 2, blockingPerBatch: 2 });
    expect(m.unknowns.reviewsWithoutBatch).toBe(1);
    expect(m.unknowns.reviewsWithUnknownBlocking).toBe(1);
    expect(m.supplementary.cancelledTurns).toEqual({ total: 1, byRole: { manager: 0, worker: 0, reviewer: 1, orchestrator: 0, unknown: 0 } });
    expect(m.supplementary.turnsByRole).toEqual({ manager: 4, worker: 0, reviewer: 1, orchestrator: 0, unknown: 0 });
  });

  describe("review lift (autonomy design §C.4, §C.6)", () => {
    const OTHER = "wks_other";
    const RA = "req-20260926T101500Z";
    const RB = "req-20260926T102500Z";
    const RC = "req-20260926T103500Z";
    const RD = "req-20260926T104500Z";
    const review = (minute: number, batchId: string | null, blockingCount: number | null): ParsedReview => ({
      agentId: REVIEWER,
      at: at(minute),
      batchId,
      verdict: blockingCount === 0 ? "approved" : "changes",
      blockingCount,
    });
    const reviewerTurn = (minute: number, requestId: string | null, reviews: ParsedReview[], tokens: Usage | null, workspaceId = WORKSPACE_ID): TraceRecord =>
      turn({ agentId: REVIEWER, role: "reviewer", workspaceId, at: at(minute), turnId: `r-${minute}`, requestId, startedAt: at(minute), usage: tokens, reviews });
    const reported = (minute: number, requestId: string, tier: "Small" | "Medium" | null, workspaceId = WORKSPACE_ID, phase: "received" | "finished" = "finished"): TraceRecord =>
      turn({ workspaceId, at: at(minute), turnId: `m-${minute}`, requestId, startedAt: at(minute), reports: tier === null ? [] : [report({ at: at(minute), requestId, phase, tier })] });

    /**
     * Two projects. Invoice: a request reported Small then Medium (so Medium),
     * whose batch b1 goes from 3 blocking findings to 0 on re-review and whose
     * batch b2 is approved at once; and a Medium request whose Reviewer ran but
     * sent no review. Other: a Small request whose batch starts with an unknown
     * count and has a review without a batch; a request with no tier whose one
     * Reviewer turn has no usage; and a Reviewer turn with no request.
     */
    const records = (): TraceRecord[] => [
      reported(1, RA, "Small", WORKSPACE_ID, "received"),
      reviewerTurn(9, RA, [review(9, "b1", 3)], usage(600, 300, 100)),
      reviewerTurn(12, RA, [review(12, "b1", 0)], usage(400, 0, 100)),
      reviewerTurn(14, RA, [review(14, "b2", 0)], usage(300)),
      reported(20, RA, "Medium"),
      reported(21, RB, "Small", OTHER),
      reviewerTurn(26, RB, [review(26, "b1", null)], usage(400), OTHER),
      reviewerTurn(28, RB, [review(28, "b1", 0)], usage(200), OTHER),
      reviewerTurn(29, RB, [review(29, null, 1)], usage(100), OTHER),
      reported(31, RC, null, OTHER),
      reviewerTurn(36, RC, [review(36, "b1", 0)], null, OTHER),
      reported(41, RD, "Medium"),
      reviewerTurn(46, RD, [], usage(900)),
      reviewerTurn(50, null, [], usage(50), OTHER),
    ];

    const medium = lift({
      requests: 1,
      reviews: 3,
      reviewsPerRequest: 3,
      batches: 2,
      blockingFindings: 3,
      blockingPerBatch: 1.5,
      actedOn: { reReviewedBatches: 1, found: 3, fixed: 3, reviewedOnceBatches: 1 },
      tokens: { reviews: 3, total: 1800, perReview: 600 },
      unknown: { requestsWithoutReview: 1 },
    });
    // Its only batch has an unknown count: blocking findings per batch and findings acted on are unknown, never 0.
    const small = lift({
      requests: 1,
      reviews: 3,
      reviewsPerRequest: 3,
      batches: 1,
      blockingPerBatch: null,
      tokens: { reviews: 3, total: 700, perReview: 700 / 3 },
      unknown: { reviewsWithoutBatch: 1, reviewsWithUnknownBlocking: 1, batchesWithUnknownBlocking: 1, reReviewedWithUnknownBlocking: 1 },
    });
    // Its Reviewer's usage is unknown: its review counts, its tokens are not taken as 0.
    const untiered = lift({
      requests: 1,
      reviews: 1,
      reviewsPerRequest: 1,
      batches: 1,
      blockingPerBatch: 0,
      actedOn: { reviewedOnceBatches: 1 },
      unknown: { requestsWithoutReviewerTokens: 1 },
    });

    it("splits by the last reported tier and by project: findings per batch, acted on, tokens per review, unknowns apart", () => {
      const m = metrics(records());
      expect(m.reviewLift.byTier).toEqual({ Small: small, Medium: medium, Large: NO_LIFT, unknown: untiered });
      expect(m.reviewLift.all).toEqual(
        lift({
          requests: 3,
          reviews: 7,
          reviewsPerRequest: 7 / 3,
          batches: 4,
          blockingFindings: 3,
          blockingPerBatch: 1,
          actedOn: { reReviewedBatches: 1, found: 3, fixed: 3, reviewedOnceBatches: 2 },
          tokens: { reviews: 6, total: 2500, perReview: 2500 / 6 },
          unknown: {
            reviewsWithoutBatch: 1,
            reviewsWithUnknownBlocking: 1,
            batchesWithUnknownBlocking: 1,
            reReviewedWithUnknownBlocking: 1,
            requestsWithoutReviewerTokens: 1,
            requestsWithoutReview: 1,
          },
        }),
      );
      expect(m.reviewLift.reviewerTurnsWithoutRequest).toBe(1);
      expect(Object.keys(m.reviewLift.byWorkspace)).toEqual([WORKSPACE_ID, OTHER]);
      expect(m.reviewLift.byWorkspace[WORKSPACE_ID]).toEqual(liftSplit(medium, { Medium: medium }));
      expect(m.reviewLift.byWorkspace[OTHER]).toEqual(
        liftSplit(
          lift({
            requests: 2,
            reviews: 4,
            reviewsPerRequest: 2,
            batches: 2,
            blockingPerBatch: 0,
            actedOn: { reviewedOnceBatches: 1 },
            tokens: { reviews: 3, total: 700, perReview: 700 / 3 },
            unknown: { reviewsWithoutBatch: 1, reviewsWithUnknownBlocking: 1, batchesWithUnknownBlocking: 1, reReviewedWithUnknownBlocking: 1, requestsWithoutReviewerTokens: 1 },
          }),
          { Small: small, unknown: untiered },
          1,
        ),
      );
    });

    it("counts a batch from 3 blocking findings to 0 as 3 acted on, and a batch reviewed once apart, none acted on", () => {
      const m = metrics([reported(1, RA, "Medium"), ...records().slice(1, 4)]);
      expect(m.reviewLift.byTier.Medium.actedOn).toEqual({ reReviewedBatches: 1, found: 3, fixed: 3, reviewedOnceBatches: 1 });
      // A later review that finds more than the first is none acted on, not a negative figure.
      const worse = metrics([reported(1, RA, "Medium"), reviewerTurn(9, RA, [review(9, "b1", 1)], usage(10)), reviewerTurn(12, RA, [review(12, "b1", 2)], usage(10))]);
      expect(worse.reviewLift.all.actedOn).toEqual({ reReviewedBatches: 1, found: 1, fixed: 0, reviewedOnceBatches: 0 });
      expect(worse.reviewLift.all.blockingPerBatch).toBe(3);
    });

    it("leaves the review figures of the supplementary set and the unknowns as they were", () => {
      const m = metrics(records());
      // Unchanged definition: every review in scope, an unknown count read as none in the batch's figure.
      expect(m.supplementary.reviews).toEqual({ reviews: 7, batches: 4, perBatch: 6 / 4, blockingFindings: 4, blockingPerBatch: 3 / 4 });
      expect([m.unknowns.reviewsWithoutBatch, m.unknowns.reviewsWithUnknownBlocking]).toEqual([1, 1]);
    });

    it("has nothing to report without a review or a Reviewer turn", () => {
      expect(metrics([reported(1, RA, "Medium")]).reviewLift).toEqual({ ...liftSplit(NO_LIFT, {}), byWorkspace: {} });
    });

    // Bead 7gxw.12: builds before it parsed a block wherever it appeared, so the stored records hold each review again
    // for the re-review prompt quoting it, the format notice naming it and the Manager relaying it (121 of 404 in the field).
    it("counts a review once: a block quoted in a Reviewer's prompt or a plugin notice, or relayed by a Manager, is not another review", () => {
      const block = (verdict: string) => `BM-REVIEW\nrequestId: ${RA}\nbatchId: b1\nverdict: ${verdict}`;
      const notice = `BM-FORMAT requestId: ${RA}\nYour last BM-REVIEW broke the template:\n- BM-REVIEW checked: is missing\n- BM-REVIEW verdict: must be pass or changes-required`;
      const reviewerTurnOf = (minute: number, prompt: string, reply: string | null, reviews: ParsedReview[]): TraceRecord =>
        turn({
          ...reviewerTurn(minute, RA, reviews, usage(10)),
          sent: [msg(REVIEWER, at(minute - 1), prompt, "agent")],
          received: reply === null ? [] : [msg(REVIEWER, at(minute), reply)],
        });
      const first = reviewerTurnOf(9, "Review batch b1.", block("changes-required"), [review(9, "b1", 1)]);
      // As stored before: the prompt's quoted block parsed beside the reply's.
      const reReview = reviewerTurnOf(12, `Re-review batch b1. You said:\n\n${block("changes-required")}`, block("pass"), [review(11, "b1", 1), review(12, "b1", 0)]);
      const formatted = reviewerTurnOf(14, notice, null, [review(13, null, null), review(13, null, null)]);
      const relayed = turn({ at: at(15), turnId: "m-15", requestId: RA, received: [msg(MANAGER, at(15), block("pass"))], reviews: [{ ...review(15, "b1", 0), agentId: MANAGER }] });
      const m = metrics([reported(1, RA, "Medium"), first, reReview, formatted, relayed]);
      expect(m.reviewLift.all).toMatchObject({ requests: 1, reviews: 2, reviewsPerRequest: 2, batches: 1, actedOn: { reReviewedBatches: 1, found: 1, fixed: 1 } });
      expect(m.supplementary.reviews).toMatchObject({ reviews: 2, batches: 1 });
    });
  });

  it("failed turns by role, and requests by the UTC day of their first activity within the window", () => {
    const records = [
      turn({ at: "2026-09-24T23:50:00.000Z", requestId: R, startedAt: "2026-09-24T23:50:00.000Z" }),
      // The same request the next day: still counted on its first day.
      turn({ at: "2026-09-25T00:10:00.000Z", turnId: "m-next", requestId: R, startedAt: "2026-09-25T00:10:00.000Z", outcome: "failed" }),
      turn({ agentId: WORKER, role: "worker", at: "2026-09-25T09:00:00.000Z", requestId: R2, startedAt: "2026-09-25T09:00:00.000Z", outcome: "failed" }),
      turn({ at: "2026-09-25T10:00:00.000Z", turnId: "m-3", requestId: "req-20260925T100000Z", startedAt: "2026-09-25T10:00:00.000Z" }),
      // Before the window: neither its request nor its failure counts.
      turn({ at: "2026-09-20T10:00:00.000Z", turnId: "m-old", requestId: "req-20260920T100000Z", startedAt: "2026-09-20T10:00:00.000Z", outcome: "failed" }),
    ];
    const m = metrics(records, { window: { since: "2026-09-24T00:00:00.000Z", until: null } });
    expect(m.supplementary.failedTurns).toEqual({ total: 2, byRole: { manager: 1, worker: 1, reviewer: 0, orchestrator: 0, unknown: 0 } });
    expect(m.supplementary.requestsByDay).toEqual({ "2026-09-24": 1, "2026-09-25": 2 });
    expect(Object.keys(m.supplementary.requestsByDay)).toEqual(["2026-09-24", "2026-09-25"]);
  });

  it("owner wait median and p90 over the questions that reached the owner", () => {
    const m = metrics([
      askedAt(at(0), Q1),
      askedAt(at(1), Q2),
      askedAt(at(2), "Q3: Name?\n- a: One\n- b: Two"),
      workerGot(at(3), cardAnswer(R, "Q1: a — PDF"), "user"),
      workerGot(at(7), cardAnswer(R, "Q2: b — Keep it"), "user"),
      workerGot(at(12), cardAnswer(R, "Q3: a — One"), "user"),
    ]);
    expect(m.supplementary.ownerWait).toEqual({ questions: 3, medianMs: 6 * 60_000, p90Ms: 10 * 60_000 });
  });
});

// ── Window and unknowns ─────────────────────────────────────────────────────

describe("what the retired rules flagged, in the replay (autonomy design §B.8, §B.9)", () => {
  const ZERO = { smallHeavy: 0, unreviewed: 0, failedFirstTurns: { worker: 0, reviewer: 0 }, finishedWithoutReceived: 0, languageMismatch: 0 };

  it("a request done by the book flags nothing", () => {
    const m = metrics(clean().records);
    expect(m.supplementary.process).toEqual(ZERO);
    expect([m.unknowns.processWeightWithoutTier, m.unknowns.unreviewedWithoutTier, m.unknowns.languageOrderUnknown]).toEqual([0, 0, 0]);
  });

  it("smallHeavy (was process.small-heavy): a Small request's bead, from a br create or a report, or its plan or ADR", () => {
    // The 2026-09-26 slip: a Small request whose Worker still ran br create.
    expect(metrics(smallWithBead().records).supplementary.process.smallHeavy).toBe(1);
    const small = (evidence: TraceRecord["evidence"], filesChanged: string[] = []) => [
      turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "w-1", requestId: R, evidence }),
      { ...finishedAt(at(3), R, "Small"), reports: [report({ at: at(3), requestId: R, phase: "finished", tier: "Small", filesChanged })] },
    ];
    expect(metrics(small([file("docs/plans/date.md", at(1))])).supplementary.process.smallHeavy).toBe(1);
    expect(metrics(small([], ["docs/adr/ADR-9.md"])).supplementary.process.smallHeavy).toBe(1);
    // A design document, code, or a br create that only asked for help are no process weight.
    expect(metrics(small([file("docs/design/date.md", at(1)), file("src/date.ts", at(1, 30)), shell("br create --help", at(1, 40))])).supplementary.process.smallHeavy).toBe(0);
    // A Medium request with a bead is what the process asks for.
    expect(metrics(clean().records).supplementary.process.smallHeavy).toBe(0);
    // Beads and no reported tier: not judged, counted as unknown.
    const untiered = [
      turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "w-1", requestId: R, evidence: [shell(`br create "x"`, at(1))] }),
      { ...finishedAt(at(3), R), reports: [report({ at: at(3), requestId: R, phase: "finished", tier: null })] },
    ];
    const unknown = metrics(untiered);
    expect(unknown.supplementary.process.smallHeavy).toBe(0);
    expect(unknown.unknowns.processWeightWithoutTier).toBe(1);
  });

  it("unreviewed (was process.no-review): a finished Medium or Large request with no Reviewer turn", () => {
    const withoutReviewer = clean().records.filter((record) => record.role !== "reviewer");
    expect(metrics(withoutReviewer).supplementary.process.unreviewed).toBe(1);
    expect(metrics(clean().records).supplementary.process.unreviewed).toBe(0);
    // Small needs no review.
    expect(metrics([finishedAt(at(3), R, "Small")]).supplementary.process.unreviewed).toBe(0);
    // No tier and no Reviewer: not judged.
    const noTier = metrics([{ ...finishedAt(at(3)), reports: [report({ at: at(3), requestId: R, phase: "finished", tier: null })] }]);
    expect(noTier.supplementary.process.unreviewed).toBe(0);
    expect(noTier.unknowns.unreviewedWithoutTier).toBe(1);
  });

  it("failedFirstTurns (was agent.failed-first-turn): a Worker or Reviewer whose first recorded turn failed", () => {
    // The 2026-09-26 slip: a Worker created on a model its provider refused.
    expect(metrics(failedFirstTurn().records).supplementary.process.failedFirstTurns).toEqual({ worker: 1, reviewer: 0 });
    // A failure after a completed first turn is a failed turn, not a failed start.
    const later = [
      turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "w-1", requestId: R }),
      turn({ agentId: WORKER, role: "worker", at: at(4), turnId: "w-2", requestId: R, outcome: "failed" }),
      turn({ agentId: REVIEWER, role: "reviewer", at: at(5), turnId: "r-1", requestId: R, outcome: "failed" }),
    ];
    const m = metrics(later);
    expect(m.supplementary.process.failedFirstTurns).toEqual({ worker: 0, reviewer: 1 });
    expect(m.supplementary.failedTurns.byRole).toMatchObject({ worker: 1, reviewer: 1 });
  });

  it("finishedWithoutReceived (the rest of report.malformed): a finished request whose Worker never sent received", () => {
    expect(metrics(clean().records).supplementary.process.finishedWithoutReceived).toBe(0);
    expect(metrics([finishedAt(at(3))]).supplementary.process.finishedWithoutReceived).toBe(1);
    // Unreadable and incomplete fields stay in reportFormat.
    const unreadable = metrics([{ ...finishedAt(at(3)), reports: [report({ at: at(3), requestId: R, phase: "finished", tier: "Medium", unparsedFields: ["tier"] })] }]);
    expect(unreadable.supplementary.reportFormat.withUnparsedFields).toBe(1);
  });

  it("languageMismatch (was manager.language-mismatch): the Manager answers in the other language after the user's last message", () => {
    // The 2026-09-26 slip: Vietnamese from the user, English from the Manager once a BM-REPORT arrived.
    expect(metrics(languageAfterReport().records).supplementary.process.languageMismatch).toBe(1);
    expect(metrics(clean().records).supplementary.process.languageMismatch).toBe(0);
    const vi = "Sửa giúp mình lỗi định dạng ngày trên màn hình hoá đơn nhé.";
    const en = "I handed this to the Worker and will tell you when it is done.";
    const managerTurn = (reply: string, replyAt: string) =>
      turn({ at: at(1), turnId: "m-1", requestId: R, sent: [msg(MANAGER, at(0, 20), vi, "user")], received: [msg(MANAGER, replyAt, reply)] });
    // A reply at the message's own recorded time proves no order: unknown, not a mismatch.
    const tied = metrics([managerTurn(en, at(0, 20))]);
    expect(tied.supplementary.process.languageMismatch).toBe(0);
    expect(tied.unknowns.languageOrderUnknown).toBe(1);
    // A message relayed by an agent is not the user's language.
    const relayed = turn({ at: at(1), turnId: "m-1", requestId: R, sent: [msg(MANAGER, at(0, 20), vi, "agent")], received: [msg(MANAGER, at(0, 40), en)] });
    expect(metrics([relayed]).supplementary.process.languageMismatch).toBe(0);
  });
});

describe("the window and the unknowns", () => {
  it("a request belongs to the window by its first activity; a record without a request by its own time", () => {
    const records = [
      turn({ at: at(1), requestId: R, startedAt: at(1), usage: usage(1) }),
      turn({ at: at(40), turnId: "late", requestId: R, startedAt: at(40), usage: usage(1) }),
      turn({ at: at(35), requestId: R2, startedAt: at(35), usage: usage(1) }),
      turn({ agentId: ORCHESTRATOR, role: "orchestrator", at: at(36), usage: usage(1) }),
      turn({ agentId: ORCHESTRATOR, role: "orchestrator", at: at(5), usage: usage(1) }),
    ];
    const m = metrics(records, { window: { since: at(30), until: at(59) } });
    expect(m.requests.inWindow).toBe(1);
    expect(m.supplementary.turnsByRole).toEqual({ manager: 1, worker: 0, reviewer: 0, orchestrator: 1, unknown: 0 });
    expect(m.unknowns.recordsWithoutRequest).toBe(1);
    expect(() => metrics(records, { window: { since: "yesterday", until: null } })).toThrow(/since is not a time/);
  });

  it("messages without origin, turns without usage and invalid proposals are counted, never as zero", () => {
    const m = metrics([turn({ at: at(1), requestId: R, sent: [msg(MANAGER, at(1), "old record")] })], { proposals: [{ id: "x" }, proposal({})] });
    expect(m.unknowns).toMatchObject({ messagesWithoutOrigin: 1, turnsWithoutUsage: 1, invalidProposals: 1 });
  });
});

// ── Phase 1: the decision store and the wake records ───────────────────────

/** A stored Worker question of request `R` (Q1 by default), asked at minute 5, options `a` (recommended, no effect) and `b` (push). */
function storedQuestion(overrides: Partial<Decision> = {}): Decision {
  return makeDecision({
    id: `q:${R}:Q1`,
    workspaceId: WORKSPACE_ID,
    requestId: R,
    askedAt: at(5),
    question: "Which format?",
    options: [
      { key: "a", label: "PDF", recommended: true, effects: ["none"] },
      { key: "b", label: "CSV and push", recommended: false, effects: ["push"] },
    ],
    ...overrides,
  });
}

/** The decision answered by the owner at `when`. */
function answered(decision: Decision, when: string, answer: { optionKey: string } | { words: string }, via: "inbox" | "chat-card" | "chat-worker" = "inbox"): Decision {
  const result = answerDecision(decision, { via, at: when, ...answer });
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

/** An Orchestrator decision of request `R` asked at `when`, one option with these effects. */
const orchestratorDecision = (id: string, when: string, effects: Decision["options"][number]["effects"] = ["none"], overrides: Partial<Decision> = {}): Decision =>
  makeDecision({
    id,
    workspaceId: WORKSPACE_ID,
    requestId: R,
    askedBy: { role: "orchestrator", agentId: ORCHESTRATOR },
    askedAt: when,
    round: null,
    question: "Push the fix?\n\nRecommendation: push it",
    subject: null,
    options: [{ key: "a", label: "Push it", recommended: true, effects }],
    ...overrides,
  });

const wake = (when: string, endedAt: string | null, overrides: Partial<WakeEntry> = {}): WakeEntry => ({
  orchestratorId: ORCHESTRATOR,
  at: when,
  endedAt,
  workspaceIds: [WORKSPACE_ID],
  events: 1,
  ...overrides,
});

describe("A-1 from the decision store (Phase 1)", () => {
  it("a question the owner answered in the Inbox reached the owner, though no owner message reached any agent", () => {
    // The answer reaches the Worker only as the plugin's BM-DELIVERY notice, which the records do not read as an answer.
    const m = metrics([askedAt(at(5), Q1), workerGot(at(6), `BM-DELIVERY answers\n${relay(R, "Q1: a — PDF")}`, "agent"), finishedAt(at(20))], {
      decisions: [answered(storedQuestion(), at(5, 30), { optionKey: "a" })],
    });
    expect(m.a1.finished).toEqual({ asked: 1, reachedOwner: 1, answeredByAgents: 0, answeredByAgentsViaCommand: 0, unanswered: 0 });
    expect(m.a1.perFinishedRequest).toEqual({ asked: 1, reachedOwner: 1, answeredByAgents: 0 });
    // The owner's wait ends at the owner's answer; the recommended option was taken.
    expect(m.supplementary.ownerWait).toEqual({ questions: 1, medianMs: 30_000, p90Ms: 30_000 });
    expect(m.supplementary.recommendedAgreement).toMatchObject({ answered: 1, recommended: 1, share: 1 });
    expect(m.a2.answeredTwice).toBe(0);
    // Without the store, the same records read as before Phase 1: asked, never answered.
    expect(metrics([askedAt(at(5), Q1), finishedAt(at(20))]).a1.finished).toMatchObject({ reachedOwner: 0, unanswered: 1 });
  });

  it("own words in a chat card count as own words; a question only the store holds is still asked", () => {
    const m = metrics([ownerTyped(at(0), "Add a PDF export."), finishedAt(at(20))], {
      decisions: [answered(storedQuestion(), at(7), { words: "CSV, and push it" }, "chat-card")],
    });
    expect(m.a1.all).toMatchObject({ asked: 1, reachedOwner: 1 });
    expect(m.supplementary.recommendedAgreement).toMatchObject({ answered: 1, ownWords: 1 });
  });

  it("an answer in the Worker's own chat is one answer, not two", () => {
    const m = metrics([askedAt(at(5), Q1), workerGot(at(7), cardAnswer(R, "Q1: b — CSV"), "user")], {
      decisions: [answered(storedQuestion(), at(7), { optionKey: "b" }, "chat-worker")],
    });
    expect(m.a1.all).toMatchObject({ asked: 1, reachedOwner: 1 });
    expect(m.a2.answeredTwice).toBe(0);
    expect(m.a5.answered).toBe(1);
  });

  it("a question the Orchestrator settled with a command did not reach the owner; its decision stays unanswered", () => {
    const m = metrics([ownerTyped(at(0), "Add a PDF export."), askedAt(at(5), Q1), workerGot(at(9), orchestratorAnswer(R, "Q1: a — PDF"), "agent")], {
      decisions: [storedQuestion({ status: "withdrawn", settledAt: at(9) })],
    });
    expect(m.a1.all).toEqual({ asked: 1, reachedOwner: 0, answeredByAgents: 1, answeredByAgentsViaCommand: 1, unanswered: 0 });
  });

  it("the owner answering after the Orchestrator already had: reached the owner, and answered twice", () => {
    const m = metrics([askedAt(at(5), Q1), workerGot(at(9), orchestratorAnswer(R, "Q1: a — PDF"), "agent")], {
      decisions: [answered(storedQuestion(), at(12), { optionKey: "b" })],
    });
    expect(m.a1.all).toMatchObject({ reachedOwner: 1, answeredByAgents: 0 });
    expect(m.a2.answeredTwice).toBe(1);
    expect(m.a5.reanswered).toBe(1);
  });

  it("a question the Orchestrator answered with bm_decide (change-004) was answered by agents, once, and never reached the owner", () => {
    const decided = storedOrchestratorAnswer(storedQuestion(), { optionKey: "a", reason: "PDF is what the owner asked for.", at: at(6) });
    if (!decided.ok) throw new Error(decided.message);
    // The Worker gets it only as the plugin's BM-DELIVERY notice, which the records never read as an answer.
    const records = [askedAt(at(5), Q1), workerGot(at(6, 5), `BM-DELIVERY answers\n${relay(R, "Q1: a — PDF")}`, "agent"), finishedAt(at(20))];
    const m = metrics(records, { decisions: [decided.decision] });
    expect(m.a1.finished).toEqual({ asked: 1, reachedOwner: 0, answeredByAgents: 1, answeredByAgentsViaCommand: 1, unanswered: 0 });
    expect(m.a1.perFinishedRequest).toEqual({ asked: 1, reachedOwner: 0, answeredByAgents: 1 });
    expect(m.a2.answeredTwice).toBe(0);
    // No owner wait: nobody waited on the owner.
    expect(m.supplementary.ownerWait).toMatchObject({ questions: 0 });
    // Its grant is not the owner's: a push after it is not shown authorised by it (A-6).
    const pushed = storedOrchestratorAnswer(storedQuestion(), { optionKey: "b", reason: "x", at: at(6) });
    if (!pushed.ok) throw new Error(pushed.message);
    const push = workerGot(at(7), "Go on.", "agent", { evidence: [shell("git push origin main", at(7))] });
    expect(metrics([askedAt(at(5), Q1), push], { decisions: [pushed.decision] }).a6).toMatchObject({ authorised: 0, notShownAuthorised: 1 });
    // An owner message in the request between the question and the answer still makes it reach the owner.
    expect(metrics([askedAt(at(5), Q1), ownerTyped(at(5, 30), "PDF, please."), finishedAt(at(20))], { decisions: [decided.decision] }).a1.finished).toMatchObject({
      reachedOwner: 1,
      answeredByAgents: 0,
    });
  });

  it("an Orchestrator decision of the request open between the question and its answer put it to the owner", () => {
    const m = metrics([askedAt(at(5), Q1), workerGot(at(9), orchestratorAnswer(R, "Q1: a — PDF"), "agent")], {
      decisions: [storedQuestion(), orchestratorDecision("o:d1", at(6))],
    });
    expect(m.a1.all).toMatchObject({ reachedOwner: 1, answeredByAgents: 0 });
  });

  it("a decision that does not validate is counted, never read", () => {
    const m = metrics([askedAt(at(5), Q1)], { decisions: [{ id: "q:nope" }, storedQuestion()] });
    expect(m.unknowns.invalidDecisions).toBe(1);
    expect(m.a1.all).toMatchObject({ asked: 1, unanswered: 1 });
  });
});

describe("A-2 (c) from the decision store (Phase 1)", () => {
  it("two Orchestrator decisions of one request open at once; a superseded one and a Worker question are not", () => {
    const first = orchestratorDecision("o:d1", at(10), ["none"], { status: "superseded", supersededBy: "o:d2", settledAt: at(15) });
    const second = orchestratorDecision("o:d2", at(15));
    const separate = orchestratorDecision("o:d3", at(20), ["none"], { subject: "other" });
    const m = metrics([askedAt(at(5), Q1)], { decisions: [first, second, separate, storedQuestion()] });
    // d1 ended when d2 replaced it; d2 and d3 are both still open.
    expect(m.a2.overlappingDecisions).toBe(1);
    const projectWide = orchestratorDecision("o:d4", at(21), ["none"], { requestId: null });
    expect(metrics([askedAt(at(5), Q1)], { decisions: [projectWide] }).unknowns.decisionsWithoutRequest).toBe(1);
  });
});

describe("A-6 from the decision store (Phase 1)", () => {
  const pushAt = (when: string) => workerGot(when, "Go on.", "agent", { evidence: [shell("git push origin main", when)] });

  it("authorised: the owner's answer granted push before the push ran (live check S7)", () => {
    const granted = answered(storedQuestion(), at(6), { words: "Yes, push it to origin now." });
    expect(granted.grant?.effects).toEqual(["push"]);
    const m = metrics([askedAt(at(5), Q1), pushAt(at(7))], { decisions: [granted] });
    expect(m.a6).toMatchObject({ total: 1, authorised: 1, notShownAuthorised: 0 });
    expect(metrics([askedAt(at(5), Q1), pushAt(at(7))], { decisions: [answered(storedQuestion(), at(6), { optionKey: "b" })] }).a6.authorised).toBe(1);
  });

  it("not shown authorised: an answer that granted no push, one given after the push, or none", () => {
    expect(metrics([pushAt(at(7))], { decisions: [answered(storedQuestion(), at(6), { optionKey: "a" })] }).a6.notShownAuthorised).toBe(1);
    expect(metrics([pushAt(at(7))], { decisions: [answered(storedQuestion(), at(8), { optionKey: "b" })] }).a6.notShownAuthorised).toBe(1);
    expect(metrics([pushAt(at(7))], { decisions: [storedQuestion()] }).a6.notShownAuthorised).toBe(1);
    // Another request's grant does not carry over.
    const other = answered(storedQuestion({ id: `q:${R2}:Q1`, requestId: R2 }), at(6), { optionKey: "b" });
    expect(metrics([pushAt(at(7))], { decisions: [other] }).a6.notShownAuthorised).toBe(1);
  });

  it("authorised: a command on a decision's authority whose grant was used and covers its effects", () => {
    const answeredAt = at(6);
    const asked = answered(orchestratorDecision("o:push", at(5), ["push"]), answeredAt, { optionKey: "a" });
    const spent = useGrant(asked, { effects: ["push"], at: at(6, 30) });
    if (!spent.ok) throw new Error(spent.message);
    const command = commandBlockOf({
      from: "orchestrator",
      via: "tab",
      to: "worker",
      requestId: R,
      re: "Push it",
      body: "Push the fix to origin.",
      intent: "release",
      effects: ["push"],
      authority: "decision:o:push",
      approved: ["push"],
    });
    const records = [workerGot(at(6, 30), command, "agent"), pushAt(at(7))];
    expect(metrics(records, { decisions: [spent.decision] }).a6).toMatchObject({ authorised: 1, notShownAuthorised: 0 });
    // The grant never used: the command is not shown to be covered (the answer alone authorises an Orchestrator decision only through its command).
    expect(metrics(records, { decisions: [asked] }).a6).toMatchObject({ authorised: 0, notShownAuthorised: 1 });
    // The decision is not in the store: not shown.
    expect(metrics(records).a6.notShownAuthorised).toBe(1);
  });
});

// ── A-4 and A-5 of delegated decisions (Phase 2) ────────────────────────────

/** Options that declare no effect, so a decision keeps the class it is given; `a` is recommended. */
const PLAIN_OPTIONS: Decision["options"] = [
  { key: "a", label: "Keep it", recommended: true, effects: ["none"] },
  { key: "b", label: "Change it", recommended: false, effects: ["none"] },
];
const RECOMMENDED_PREDICTION: Decision["prediction"] = { recommended: { optionKey: "a" }, orchestrator: null };
const LATER = "2026-09-26T12:00:00.000Z";

function settled(result: TransitionResult): Decision {
  if (!result.ok) throw new Error(result.message);
  return result.decision;
}

/** Worker question Qn of request `R` in `decisionClass`, opened with its predictions recorded (Phase 2). */
const classQuestion = (n: number, decisionClass: DecisionClass, overrides: Partial<Decision> = {}): Decision =>
  storedQuestion({ id: `q:${R}:Q${n}`, class: decisionClass, options: PLAIN_OPTIONS, prediction: RECOMMENDED_PREDICTION, ...overrides });

/** Answered by the owner's policy (§B.5), the recommended option. */
const byPolicy = (decision: Decision, when: string, predictor: Predictor = "recommended"): Decision =>
  settled(answerDecision(decision, { by: "policy", via: "inbox", optionKey: "a", reason: "your policy", class: decisionClassOf(decision), predictor, at: when }));

/** Answered by a precedent (§B.6), in the owner's standing words. */
const byPrecedent = (decision: Decision, when: string): Decision =>
  settled(answerDecision(decision, { by: "precedent", via: "inbox", words: "Keep what exists.", precedentId: "p-1", at: when }));

const reversedAs = (decision: Decision, kind: ReversalKind, ref: string, when: string): Decision => settled(recordReversal(decision, { kind, at: when, ref }));

/** The owner's Override from the digest (§B.7): the reversal on the delegated decision, and the open `r:` decision superseding it. */
const overridden = (decision: Decision, id: string, when: string): [Decision, Decision] => [
  reversedAs(decision, "overridden", id, when),
  overrideDecisionOf(decision, { id, at: when }),
];

const overrideCounts = (delegated: number, byPolicyCount: number, byPrecedentCount: number, overriddenCount: number): OverrideCounts => ({
  delegated,
  byPolicy: byPolicyCount,
  byPrecedent: byPrecedentCount,
  overridden: overriddenCount,
  rate: delegated === 0 ? null : overriddenCount / delegated,
});
const reversalRate = (decisions: number, reversed: number, byKind: Partial<Record<ReversalKind, number>> = {}): ReversalRate => ({
  decisions,
  reversed,
  byKind: { "re-asked": 0, overridden: 0, reopened: 0, ...byKind },
  rate: decisions === 0 ? null : reversed / decisions,
});
/** Every class, those not given at `none`. */
const everyClass = <T>(none: T, given: Partial<Record<DecisionClass, T>> = {}): Record<DecisionClass, T> =>
  Object.fromEntries(DECISION_CLASSES.map((decisionClass) => [decisionClass, given[decisionClass] ?? none])) as Record<DecisionClass, T>;

/** A-4 and A-5's delegated and owner parts with nothing to count: every rate unknown, never 0. */
const NO_OVERRIDES = overrideCounts(0, 0, 0, 0);
const NO_REVERSALS = reversalRate(0, 0);
const NO_DELEGATION = {
  a4: { ...NO_OVERRIDES, byClass: everyClass(NO_OVERRIDES) },
  delegated: { ...NO_REVERSALS, byClass: everyClass(NO_REVERSALS) },
  owner: { ...NO_REVERSALS, byClass: everyClass(NO_REVERSALS) },
};

/**
 * Two delegated classes. `scope`: one policy answer overridden, one policy
 * answer of the Orchestrator's cell, one precedent answer reopened citing it.
 * `preference`: a policy answer and a precedent answer, both standing. The
 * owner: two `scope` answers, one re-asked; one `dependency` answer; and the
 * override itself, answered by the owner.
 */
function delegatedStore(): Decision[] {
  const [scopeOverridden, override] = overridden(byPolicy(classQuestion(1, "scope"), at(6)), "r:0001", at(8));
  return [
    scopeOverridden,
    answered(override, at(9), { optionKey: "b" }),
    byPolicy(classQuestion(2, "scope"), at(6), "orchestrator"),
    reversedAs(byPrecedent(classQuestion(3, "scope"), at(6)), "reopened", "bm-7", at(30)),
    byPolicy(classQuestion(4, "preference"), at(7)),
    byPrecedent(classQuestion(5, "preference"), at(7)),
    reversedAs(answered(classQuestion(6, "scope"), at(8), { optionKey: "b" }), "re-asked", `q:${R}:Q9`, at(20)),
    answered(classQuestion(7, "scope"), at(8), { optionKey: "a" }),
    answered(classQuestion(8, "dependency"), at(8), { optionKey: "a" }),
  ];
}

describe("A-4 and A-5 of delegated decisions, per class (autonomy design §B.3, §B.7, §B.9)", () => {
  it("two classes delegated by the policy and by a precedent: an override in A-4 and A-5, a reopen in A-5, the owner's reversal only in the owner's rate", () => {
    const m = metrics([], { decisions: delegatedStore() });
    expect(m.a4).toEqual({
      ...overrideCounts(5, 3, 2, 1),
      byClass: everyClass(NO_OVERRIDES, { scope: overrideCounts(3, 2, 1, 1), preference: overrideCounts(2, 1, 1, 0) }),
    });
    expect(m.a4.rate).toBe(0.2);
    expect(m.a5.delegated).toEqual({
      ...reversalRate(5, 2, { overridden: 1, reopened: 1 }),
      byClass: everyClass(NO_REVERSALS, { scope: reversalRate(3, 2, { overridden: 1, reopened: 1 }), preference: reversalRate(2, 0) }),
    });
    // The re-asked owner answer is the owner's only; the override (`r:`) is not in the owner's reference.
    expect(m.a5.owner).toEqual({
      ...reversalRate(3, 1, { "re-asked": 1 }),
      byClass: everyClass(NO_REVERSALS, { scope: reversalRate(2, 1, { "re-asked": 1 }), dependency: reversalRate(1, 0) }),
    });
    expect(m.unknowns.ownerAnswersBeforeReversals).toBe(0);
  });

  it("a class without delegated decisions is unknown, never 0; a store without decisions reads every rate unknown", () => {
    const m = metrics([], { decisions: delegatedStore() });
    // `dependency`: the owner answered, nothing was delegated.
    expect(m.a4.byClass.dependency).toEqual({ delegated: 0, byPolicy: 0, byPrecedent: 0, overridden: 0, rate: null });
    expect(m.a5.delegated.byClass.dependency.rate).toBeNull();
    expect(m.a5.owner.byClass.dependency.rate).toBe(0);
    // `preference`: delegated and never overridden or reversed is 0, not unknown; the owner answered none of it.
    expect([m.a4.byClass.preference.rate, m.a5.delegated.byClass.preference.rate, m.a5.owner.byClass.preference.rate]).toEqual([0, 0, null]);
    for (const input of [{}, { decisions: [] }]) {
      const none = metrics([askedAt(at(5), Q1), finishedAt(at(20))], input);
      expect({ a4: none.a4, delegated: none.a5.delegated, owner: none.a5.owner }).toEqual(NO_DELEGATION);
    }
  });

  it("an override counts once in A-4 and in A-5, from its r: decision, its reversal, or both", () => {
    const [withBoth, overrideOfBoth] = overridden(byPolicy(classQuestion(1, "scope"), at(6)), "r:0001", at(8));
    const onlyTheOverride = byPolicy(classQuestion(2, "scope"), at(6));
    // The reversal alone: its `r:` decision was not read (the replay's --version keeps a decision by its askedAt).
    const [onlyTheReversal] = overridden(byPrecedent(classQuestion(3, "scope"), at(6)), "r:0003", at(8));
    const m = metrics([], { decisions: [withBoth, overrideOfBoth, onlyTheOverride, overrideDecisionOf(onlyTheOverride, { id: "r:0002", at: at(8) }), onlyTheReversal] });
    expect(m.a4).toMatchObject({ delegated: 3, overridden: 3, rate: 1 });
    expect(m.a5.delegated).toMatchObject(reversalRate(3, 3, { overridden: 3 }));
  });

  it("the owner's reference: Worker questions and Orchestrator decisions answered since reversals are recorded; never an override, an incident, a prepared change or another answerer", () => {
    const orchestratorAsked = (id: string, overrides: Partial<Decision> = {}) =>
      orchestratorDecision(id, at(6), ["none"], { class: "scope", options: PLAIN_OPTIONS, prediction: RECOMMENDED_PREDICTION, ...overrides });
    const prepared = orchestratorAsked("o:advice", {
      options: [
        { key: "save", label: "Save it as a precedent", recommended: true, effects: ["none"], action: { kind: "precedent.save", scope: "project", subject: "date-format", text: "dd/mm/yyyy" } },
        { key: "skip", label: "Not now", recommended: false, effects: ["none"] },
      ],
    });
    // A prepared change records no prediction (§G.4): it is left out, not counted as unknown.
    delete prepared.prediction;
    const incident = makeDecision({
      id: "f:worker-crash-1",
      workspaceId: WORKSPACE_ID,
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      askedAt: at(6),
      class: "environment",
      subject: null,
      options: PLAIN_OPTIONS,
      prediction: RECOMMENDED_PREDICTION,
    });
    const phase1 = classQuestion(3, "scope");
    delete phase1.prediction;
    const decided = storedOrchestratorAnswer(classQuestion(4, "scope"), { optionKey: "a", at: at(7) });
    if (!decided.ok) throw new Error(decided.message);
    const m = metrics([], {
      decisions: [
        answered(classQuestion(1, "scope"), at(7), { optionKey: "a" }),
        reversedAs(answered(orchestratorAsked("o:d1"), at(7), { optionKey: "b" }), "reopened", "bm-3", at(30)),
        answered(overrideDecisionOf(classQuestion(2, "scope"), { id: "r:0009", at: at(6) }), at(7), { optionKey: "b" }),
        answered(incident, at(7), { optionKey: "a" }),
        answered(prepared, at(7), { optionKey: "save" }),
        answered(phase1, at(7), { optionKey: "a" }),
        decided.decision,
      ],
    });
    expect(m.a5.owner).toMatchObject(reversalRate(2, 1, { reopened: 1 }));
    expect(m.a5.owner.byClass.scope).toEqual(reversalRate(2, 1, { reopened: 1 }));
    expect(m.a5.owner.byClass.environment.rate).toBeNull();
    // The Phase 1 answer's reversals were never recorded: unknown, not "not reversed".
    expect(m.unknowns.ownerAnswersBeforeReversals).toBe(1);
    // `by: orchestrator` (change-004) is in neither figure (change-007 C4).
    expect(m.a4.delegated).toBe(0);
  });

  it("a decision counts when its request is in the window, else when it was asked in it; an override counts whenever it came", () => {
    const R_OLD = "req-20260920T090000Z";
    const incident = (id: string, when: string) =>
      byPolicy(
        makeDecision({ id, workspaceId: WORKSPACE_ID, requestId: null, askedBy: { role: "plugin", agentId: null }, askedAt: when, class: "environment", subject: null, options: PLAIN_OPTIONS, prediction: RECOMMENDED_PREDICTION }),
        when,
        "orchestrator",
      );
    const [inWindow, override] = overridden(byPolicy(classQuestion(1, "scope"), at(6)), "r:0001", LATER);
    const m = computeEvalMetrics({
      records: [askedAt(at(5), Q1), finishedAt("2026-09-20T09:30:00.000Z", R_OLD)],
      window: { since: at(0), until: at(30) },
      decisions: [
        inWindow,
        override,
        // Asked in the window, but of a request that began before it.
        byPolicy(classQuestion(1, "scope", { id: `q:${R_OLD}:Q1`, requestId: R_OLD }), at(6)),
        incident("f:in-window", at(10)),
        incident("f:after-window", at(40)),
      ],
    });
    expect(m.a4).toMatchObject({ delegated: 2, byPolicy: 2, overridden: 1 });
    expect(m.a4.byClass.environment).toEqual(overrideCounts(1, 1, 0, 0));
    expect(m.a4.byClass.scope).toEqual(overrideCounts(1, 1, 0, 1));
  });

  it("agrees with the agreement ledger's delegated figures, summed over projects and answerers", () => {
    const decisions = delegatedStore();
    const m = metrics([], { decisions });
    for (const decisionClass of DECISION_CLASSES) {
      const cells = agreementLedger(decisions).delegated.filter((cell) => cell.class === decisionClass);
      const sum = (pick: (cell: (typeof cells)[number]) => number) => cells.reduce((total, cell) => total + pick(cell), 0);
      expect([m.a4.byClass[decisionClass].delegated, m.a4.byClass[decisionClass].overridden]).toEqual([sum((cell) => cell.count), sum((cell) => cell.overridden)]);
      expect(m.a5.delegated.byClass[decisionClass]).toMatchObject({
        decisions: sum((cell) => cell.count),
        reversed: sum((cell) => cell.reversals),
        byKind: { "re-asked": sum((cell) => cell.reversalsByKind["re-asked"]), overridden: sum((cell) => cell.reversalsByKind.overridden), reopened: sum((cell) => cell.reversalsByKind.reopened) },
      });
    }
  });
});

describe("A-7 from the wake records (Phase 1)", () => {
  it("a recorded wake is acted on when a command, a decision or a note falls within its own turn", () => {
    const wakes = [
      wake(at(0), at(2)),
      wake(at(10), at(12)),
      wake(at(20), at(22)),
      wake(at(30), at(31)),
      // Its action came after its turn ended: no action.
      wake(at(40), at(41)),
    ];
    const m = metrics([], {
      wakes,
      proposals: [proposal({ id: "c1", at: at(1), source: "autopilot" }), proposal({ id: "c2", at: at(42), source: "chat" })],
      decisions: [orchestratorDecision("o:d1", at(11))],
      notes: [{ workspaceId: WORKSPACE_ID, at: at(21) }],
    });
    expect(m.a7).toEqual({ approximate: false, notesIncluded: true, wakeRecordsIncluded: true, wakes: 5, actedOn: 3, noAction: 2, noActionShare: 0.4 });
  });

  it("a Worker's question the Orchestrator answered (bm_decide, change-004) in the wake's turn is its action; the owner's answer is not", () => {
    const decided = storedOrchestratorAnswer(storedQuestion(), { optionKey: "a", reason: "PDF.", at: at(11) });
    if (!decided.ok) throw new Error(decided.message);
    const byOwner = answered(storedQuestion({ id: `q:${R}:Q2` }), at(21), { optionKey: "a" });
    const m = metrics([], { wakes: [wake(at(10), at(12)), wake(at(20), at(22))], decisions: [decided.decision, byOwner] });
    expect(m.a7).toMatchObject({ approximate: false, wakes: 2, actedOn: 1, noAction: 1 });
  });

  it("a decision the Orchestrator decided on the owner's policy (bm_decide, autonomy design §B.5) in the wake's turn is its action; the recommended option's answer is not", () => {
    const decidedBy = (decision: Decision, predictor: "orchestrator" | "recommended", when: string): Decision => {
      const result = answerDecision(decision, { by: "policy", via: "inbox", optionKey: "a", class: "reversible-technical", predictor, reason: "Kept as before.", at: when });
      if (!result.ok) throw new Error(result.message);
      return result.decision;
    };
    const noPush = { options: [{ key: "a", label: "PDF", recommended: true, effects: ["none" as const] }] };
    // A Worker's question decided at minute 11 and a fallback incident at minute 21, both in their wake's turn.
    const question = decidedBy(storedQuestion(noPush), "orchestrator", at(11));
    const incident = decidedBy(storedQuestion({ ...noPush, id: "f:fb-0123456789ab", requestId: null, askedBy: { role: "plugin", agentId: null } }), "orchestrator", at(21));
    // The recommended option answered at open, at minute 31: code, not the Orchestrator.
    const byCode = decidedBy(storedQuestion({ ...noPush, id: `q:${R}:Q3` }), "recommended", at(31));
    const m = metrics([], { wakes: [wake(at(10), at(12)), wake(at(20), at(22)), wake(at(30), at(32))], decisions: [question, incident, byCode] });
    expect(m.a7).toMatchObject({ approximate: false, wakes: 3, actedOn: 2, noAction: 1 });
    // A-1: the question it decided was answered by agents and never reached the owner.
    expect(metrics([askedAt(at(5), Q1)], { decisions: [question] }).a1.all).toMatchObject({ asked: 1, reachedOwner: 0, answeredByAgents: 1 });
    // Only the Orchestrator's own answer counts as answered through it; the recommended
    // option's answer is by agents but not the Orchestrator's (Phase 2 live check, 2026-09-30).
    expect(metrics([askedAt(at(5), Q1)], { decisions: [question] }).a1.all).toMatchObject({ answeredByAgentsViaCommand: 1 });
    const recommendedQ1 = decidedBy(storedQuestion(noPush), "recommended", at(11));
    expect(metrics([askedAt(at(5), Q1)], { decisions: [recommendedQ1] }).a1.all).toMatchObject({ answeredByAgents: 1, answeredByAgentsViaCommand: 0 });
  });

  it("a prediction the Orchestrator recorded (bm_predict, autonomy design §B.3) in the wake's turn is its action, whatever the owner answered later; a wake with nothing in it is not", () => {
    const predicted = (id: string, when: string): Decision =>
      storedQuestion({
        id,
        prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "b", reason: "The owner kept CSV last time.", at: when } },
      });
    // Predicted at minute 11, answered by the owner at minute 31: the prediction is the wake's action, the answer is no wake's.
    const answeredLater = answered(predicted(`q:${R}:Q1`, at(11)), at(31), { optionKey: "a" });
    const stillOpen = predicted(`q:${R}:Q2`, at(21));
    // Only its recommended prediction: nothing the Orchestrator did.
    const recommendedOnly = storedQuestion({ id: `q:${R}:Q3`, prediction: { recommended: { optionKey: "a" }, orchestrator: null } });
    const m = metrics([], {
      wakes: [wake(at(10), at(12)), wake(at(20), at(22)), wake(at(30), at(32)), wake(at(40), at(41))],
      decisions: [answeredLater, stillOpen, recommendedOnly],
    });
    expect(m.a7).toMatchObject({ approximate: false, wakes: 4, actedOn: 2, noAction: 2, noActionShare: 0.5 });
  });

  it("a compaction or a handoff the Orchestrator asked for in the wake's turn is its action, though the handoff's command goes out after the turn (Phase 3 live check F3)", () => {
    const intervention = (id: string, kind: InterventionEntry["kind"], when: string): InterventionEntry => ({
      id,
      kind,
      workspaceId: WORKSPACE_ID,
      requestId: kind === "compact" ? null : R,
      targetAgentId: WORKER,
      trigger: "threshold.crossed",
      expected: kind === "compact" ? "tokens-per-turn-down" : "successor-progresses",
      windowMs: 3_600_000,
      at: when,
      outcome: "pending",
      checkedAt: null,
    });
    const m = metrics([], {
      wakes: [wake(at(10), at(12)), wake(at(20), at(22)), wake(at(30), at(32)), wake(at(40), at(42))],
      // The handoff's command, sent by the plugin once the note came in, after wake 2 ended.
      proposals: [proposal({ id: "c-handoff", at: at(25), source: "chat" })],
      interventions: [
        intervention("i-compact", "compact", at(11)),
        intervention("i-handoff", "handoff", at(21)),
        // Another kind is not a coordination tool's action here (its command or decision is).
        intervention("i-answer", "answer", at(31)),
        { id: "broken" },
      ],
    });
    expect(m.a7).toMatchObject({ approximate: false, wakes: 4, actedOn: 2, noAction: 2, noActionShare: 0.5 });
    // Without the log the same wakes read no action.
    expect(metrics([], { wakes: [wake(at(10), at(12)), wake(at(20), at(22))], proposals: [proposal({ id: "c-handoff", at: at(25), source: "chat" })] }).a7).toMatchObject({ actedOn: 0 });
  });

  it("a wake without its end is judged over 10 minutes, cut at the next wake, and counted unknown", () => {
    const m = metrics([], {
      wakes: [wake(at(0), null), wake(at(3), null), wake(at(30), null, { orchestratorId: "agent-other" })],
      proposals: [proposal({ id: "c1", at: at(4), source: "autopilot" }), proposal({ id: "c2", at: at(35), source: "autopilot" })],
    });
    // Wake 1's window stops at wake 2 (minute 3); wake 2 sees the command at minute 4; the other Orchestrator's sees minute 35.
    expect(m.a7).toMatchObject({ approximate: true, wakes: 3, actedOn: 2, noAction: 1 });
    expect(m.unknowns.wakesWithoutEnd).toBe(3);
  });

  it("wakes in the window only; an invalid one is counted; stall keys of older builds still count, approximately", () => {
    const m = metrics([], {
      window: { since: at(10), until: at(59) },
      wakes: [wake(at(0), at(1)), wake(at(20), at(21)), { orchestratorId: ORCHESTRATOR, text: "no" }],
      stalls: { [`${WORKSPACE_ID}::${R}::idle-unfinished`]: stall(at(30)) },
    });
    expect(m.a7).toMatchObject({ approximate: true, wakes: 2, actedOn: 0, noActionShare: 1 });
    expect(m.unknowns.invalidWakes).toBe(1);
    expect(metrics([], { wakes: [] }).a7).toMatchObject({ approximate: false, wakeRecordsIncluded: true, wakes: 0, noActionShare: null });
  });
});

describe("A-12 coordination interventions, per kind (autonomy design §G.3)", () => {
  const entry = (n: number, kind: InterventionEntry["kind"], outcome: InterventionEntry["outcome"], when = at(n)): InterventionEntry => ({
    id: `i-${n}`,
    kind,
    workspaceId: WORKSPACE_ID,
    requestId: R,
    targetAgentId: WORKER,
    trigger: "orchestrator",
    expected: "worker-resumes",
    windowMs: 600_000,
    at: when,
    outcome,
    checkedAt: outcome === "pending" ? null : when,
  });

  it("is met / (met + missed) per kind, with unknown and pending counted apart and never in the share", () => {
    const m = metrics([], {
      interventions: [
        entry(1, "answer", "met"),
        entry(2, "answer", "met"),
        entry(3, "answer", "met"),
        entry(4, "answer", "missed"),
        entry(5, "answer", "unknown"),
        entry(6, "unblock", "pending"),
        entry(7, "stop", "missed"),
        entry(8, "correct", "unknown"),
      ],
    });
    expect(m.a12.logIncluded).toBe(true);
    expect(m.a12.byKind.answer).toEqual({ recorded: 5, met: 3, missed: 1, unknown: 1, pending: 0, share: 0.75 });
    expect(m.a12.byKind.unblock).toEqual({ recorded: 1, met: 0, missed: 0, unknown: 0, pending: 1, share: null });
    expect(m.a12.byKind.stop).toEqual({ recorded: 1, met: 0, missed: 1, unknown: 0, pending: 0, share: 0 });
    // Unknown is not zero: a kind with only unknown outcomes has no share.
    expect(m.a12.byKind.correct).toEqual({ recorded: 1, met: 0, missed: 0, unknown: 1, pending: 0, share: null });
    expect(m.a12.byKind.advice).toEqual({ recorded: 0, met: 0, missed: 0, unknown: 0, pending: 0, share: null });
    expect(Object.keys(m.a12.byKind)).toEqual([...INTERVENTION_KINDS]);
  });

  it("counts the entries recorded in the window, and an entry that does not validate apart", () => {
    const m = computeEvalMetrics({
      records: [],
      window: { since: at(10), until: at(20) },
      interventions: [entry(5, "answer", "met"), entry(12, "answer", "missed"), entry(15, "answer", "met"), { ...entry(16, "answer", "met"), kind: "boom" }, { id: "x" }],
    });
    expect(m.a12.byKind.answer).toMatchObject({ recorded: 2, met: 1, missed: 1, share: 0.5 });
    expect(m.unknowns.invalidInterventions).toBe(2);
  });

  it("says when no log was read: every kind none, not zero percent", () => {
    const m = metrics([]);
    expect(m.a12.logIncluded).toBe(false);
    expect(Object.values(m.a12.byKind).every((counts) => counts.recorded === 0 && counts.share === null)).toBe(true);
  });
});

// ── Context and tokens (autonomy design §G.2) ───────────────────────────────

/** A turn's usage as a provider reports it, with the model the collector keeps and the context fields when reported. */
const reported = (model: string, input: number, cached: number, output: number, context?: { used: number; max: number }): Usage => ({
  ...usage(input, cached, output),
  model,
  ...(context === undefined ? {} : { contextUsed: context.used, contextMax: context.max }),
});

describe("context and tokens: what each provider's counts mean (run note 2026-09-30 §4)", () => {
  it("names the provider from the model id, or from a snapshot that names one of the three", () => {
    const of = (model: string | null, provider: string | null = "bm-worker") =>
      tokenProviderOf({ usage: null, runtime: { model, thinkingOptionId: null, modeId: null, provider } });
    expect(["claude-opus-5", "claude-haiku-4-5", "opus", "opus[1m]", "Sonnet"].map((model) => of(model))).toEqual(Array(5).fill("claude"));
    expect(["gpt-5.6-sol", "gpt-5.6-luna", "o3", "codex-mini-latest"].map((model) => of(model))).toEqual(Array(4).fill("codex"));
    expect(["opencode/big-pickle", "anthropic/claude-haiku-4-5"].map((model) => of(model))).toEqual(["opencode", "opencode"]);
    expect([of(null), of(""), of("gemini-2.5-pro"), of("opusplan-x"), of("gpt5")]).toEqual(Array(5).fill("unknown"));
    expect(of(null, "codex")).toBe("codex");
    // The usage's model when the record has no runtime.
    expect(tokenProviderOf({ usage: reported("claude-opus-5", 1, 1, 1) })).toBe("claude");
  });

  it("reads tokens per turn as each provider counts them, never Codex's cached twice, and prefers the reported context", () => {
    // The run note's own figures: a three-call turn on each provider, then a /compact turn.
    const claude = turn({ agentId: WORKER, role: "worker", at: at(1), turnId: "c-1", requestId: R, toolCalls: 3, usage: reported("claude-haiku-4-5", 34, 88_287, 423, { used: 29_826, max: 200_000 }) });
    const claudeCompact = turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "c-2", requestId: R, toolCalls: 0, usage: reported("claude-haiku-4-5", 0, 0, 0, { used: 2_381, max: 200_000 }) });
    const codex = turn({ agentId: REVIEWER, role: "reviewer", at: at(3), turnId: "x-1", requestId: R, toolCalls: 3, usage: reported("gpt-5.6-luna", 21_573, 21_248, 5, { used: 21_578, max: 258_400 }) });
    const openCode = turn({ at: at(4), turnId: "o-1", requestId: R, toolCalls: 3, usage: reported("opencode/big-pickle", 35, 21_853, 3, { used: 21_891, max: 200_000 }) });
    const openCodeCompact = turn({ at: at(5), turnId: "o-2", requestId: R, toolCalls: 0, usage: reported("opencode/big-pickle", 35, 21_853, 3, { used: 21_891, max: 200_000 }) });

    expect(turnTokensOf(claude)).toEqual({
      provider: "claude",
      coverage: "turn",
      tokensRead: 88_321,
      repeated: false,
      calls: 4,
      callsExact: true,
      context: { tokens: 29_826, basis: "reported" },
      contextShare: 29_826 / 200_000,
    });
    expect(turnTokensOf(codex)).toMatchObject({ provider: "codex", coverage: "last-call", tokensRead: 21_573, calls: 1, callsExact: true, context: { tokens: 21_578, basis: "reported" } });
    expect(turnTokensOf(openCode)).toMatchObject({ provider: "opencode", coverage: "last-call", tokensRead: 21_888, calls: 1 });
    // OpenCode repeats the turn before's counts over a turn with no model call: no tokens read, and its context is not the real one.
    expect(turnTokensOf(openCodeCompact, openCode)).toMatchObject({ repeated: true, tokensRead: 0, context: null, contextShare: null });
    expect(turnTokensOf(claudeCompact, claude)).toMatchObject({ repeated: false, tokensRead: 0, context: { tokens: 2_381, basis: "reported" } });

    const m = metrics([claude, claudeCompact, codex, openCode, openCodeCompact]);
    expect(m.context.turns).toEqual({ withUsage: 5, byProvider: { claude: 2, codex: 1, opencode: 2, unknown: 0 }, repeated: 1, withToolCalls: 5 });
    expect(m.context.tokensRead.total).toBe(88_321 + 21_573 + 21_888);
    expect(m.context.tokensRead.byRole).toEqual({ manager: 21_888, worker: 88_321, reviewer: 21_573, orchestrator: 0, unknown: 0 });
    expect(m.context.tokensRead.perTurn.byRole.worker).toEqual(spread(2, 44_160.5, 88_321, 88_321, 88_321, 88_321));
    expect(m.context.contextEstimate).toMatchObject({ reported: 4, estimated: 0, unknown: 1 });
    expect(m.context.contextEstimate.perTurn.all).toEqual(spread(4, 21_734.5, 21_891, 29_826, 29_826, 29_826));
    expect(m.context.contextEstimate.shareOfWindow.max).toBeCloseTo(0.14913, 5);
  });

  it("estimates the context when none is reported, labelled, and leaves it unknown without the tool calls", () => {
    const estimated = turn({ agentId: WORKER, role: "worker", at: at(1), turnId: "e-1", requestId: R, toolCalls: 3, usage: reported("claude-haiku-4-5", 34, 88_287, 423) });
    // No `toolCalls` (a record written before them): the calls are a lower bound from the evidence, and no context is estimated.
    const older = turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "e-2", requestId: R, usage: reported("claude-opus-5", 100, 9_900, 10), evidence: [shell("npm test", at(2)), shell("git status", at(2))] });
    // A last-call provider's tokens read are one call's: its context as it stands.
    const codex = turn({ agentId: REVIEWER, role: "reviewer", at: at(3), turnId: "e-3", requestId: R, toolCalls: 2, usage: reported("gpt-5.6-sol", 21_573, 21_248, 5) });
    expect(turnTokensOf(estimated)).toMatchObject({ tokensRead: 88_321, calls: 4, context: { tokens: 22_080, basis: "estimated" }, contextShare: null });
    expect(turnTokensOf(older)).toMatchObject({ tokensRead: 10_000, calls: 3, callsExact: false, context: null });
    expect(turnTokensOf(codex)).toMatchObject({ tokensRead: 21_573, calls: 1, context: { tokens: 21_573, basis: "estimated" } });
    // No usage: nothing read, nothing known.
    expect(turnTokensOf(turn({ at: at(4) }))).toMatchObject({ tokensRead: null, context: null });

    const m = metrics([estimated, older, codex, turn({ at: at(4), requestId: R })]);
    expect(m.context.contextEstimate).toMatchObject({ reported: 0, estimated: 2, unknown: 2 });
    expect(m.context.turns).toMatchObject({ withUsage: 3, withToolCalls: 2 });
    expect(m.unknowns.turnsWithoutUsage).toBe(1);
  });

  it("sums per request by role and per agent over its life; lists the heaviest requests", () => {
    const light = "req-20260926T090000Z";
    const m = metrics([
      turn({ at: at(1), turnId: "m-1", requestId: light, usage: usage(1_000, 4_000) }),
      turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "w-1", requestId: light, usage: usage(1_000, 9_000) }),
      finishedAt(at(3), light),
      // The same Manager again in the next request: one agent over its life.
      turn({ at: at(10), turnId: "m-2", requestId: R, usage: usage(2_000, 8_000) }),
      turn({ agentId: "agent-worker-2", role: "worker", at: at(12), turnId: "w-2", requestId: R, usage: usage(10_000, 90_000) }),
      turn({ agentId: REVIEWER, role: "reviewer", at: at(13), turnId: "r-1", requestId: R, usage: usage(5_000, 15_000) }),
    ]);
    expect(m.context.tokensRead.perRequest).toEqual(
      roleSpread(spread(2, 72_500, 130_000, 130_000, 130_000, 130_000), {
        manager: spread(2, 7_500, 10_000, 10_000, 10_000, 10_000),
        worker: spread(2, 55_000, 100_000, 100_000, 100_000, 100_000),
        reviewer: single(20_000),
      }),
    );
    expect(m.context.tokensRead.perAgent.byRole.manager).toEqual(single(15_000));
    expect(m.context.tokensRead.perAgent.byRole.worker).toEqual(spread(2, 55_000, 100_000, 100_000, 100_000, 100_000));
    expect(m.context.tokensRead.heaviestRequests.map((row) => [row.requestId, row.tokensRead, row.turns, row.finished])).toEqual([
      [R, 130_000, 3, false],
      [light, 15_000, 2, true],
    ]);
    expect(m.context.tokensRead.heaviestRequests[0]!.byRole).toEqual({ manager: 10_000, worker: 100_000, reviewer: 20_000, orchestrator: 0, unknown: 0 });
  });

  it("finds the compaction and handoff candidates at the §G.7 defaults, with the estimated saving", () => {
    const heavy = "req-20260926T101500Z";
    const records = [
      turn({ at: at(1), turnId: "m-1", requestId: R, usage: usage(10_000) }),
      turn({ agentId: WORKER, role: "worker", at: at(2), turnId: "w-1", requestId: R, toolCalls: 1, usage: usage(40_000) }),
      turn({ at: at(10), turnId: "m-2", requestId: heavy, usage: usage(10_000) }),
      ...[0, 1, 2, 3].map((index) =>
        turn({ agentId: "agent-worker-heavy", role: "worker", at: at(11 + index), turnId: `h-${index}`, requestId: heavy, toolCalls: 4, usage: usage(1_000, 199_000) }),
      ),
    ];
    const { candidates } = metrics(records).context;
    // Worker turns: 40,000 and four of 200,000 (p75 200,000); requests: 50,000 and 810,000 (p80 810,000).
    expect(candidates.thresholds).toEqual({ compactTokensPerTurn: { manager: 10_000, worker: 200_000 }, handoffRequestTokens: 810_000, briefTokens: BRIEF_TOKENS });
    expect(candidates.estimate).toBe(true);
    // The heavy Worker crosses at its first turn; its three later turns read 600,000 over 15 calls.
    expect(candidates.compaction.rows[0]).toEqual({
      workspaceId: WORKSPACE_ID,
      requestId: heavy,
      agentId: "agent-worker-heavy",
      role: "worker",
      turn: 1,
      turns: 4,
      crossedAt: 200_000,
      after: { turns: 3, tokensRead: 600_000, calls: 15, callsExact: true },
      savingTokens: 600_000 - 15 * 1_500,
    });
    // The Manager crosses too (every turn is its p75); the light Worker never does.
    expect(candidates.compaction.rows.map((row) => row.agentId)).toEqual(["agent-worker-heavy", MANAGER]);
    expect(candidates.compaction.savingTokens).toBe(577_500 + 8_500);
    // The heavy request reaches 810,000 only at its last turn: nothing after it to save.
    expect(candidates.handoff.rows).toEqual([
      { workspaceId: WORKSPACE_ID, requestId: heavy, agentId: null, role: "worker", turn: 5, turns: 5, crossedAt: 810_000, after: { turns: 0, tokensRead: 0, calls: 0, callsExact: true }, savingTokens: 0 },
    ]);
  });

  it("finds no candidate without usage", () => {
    const { candidates } = metrics([turn({ at: at(1), requestId: R })]).context;
    expect(candidates.thresholds).toEqual({ compactTokensPerTurn: { manager: null, worker: null }, handoffRequestTokens: null, briefTokens: BRIEF_TOKENS });
    expect(candidates.compaction).toEqual({ candidates: 0, savingTokens: 0, rows: [] });
    expect(candidates.handoff).toEqual({ candidates: 0, savingTokens: 0, rows: [] });
  });
});

describe("A-8: the Orchestrator's tokens from the wake records (change-007 C6)", () => {
  const two = [
    turn({ at: at(1), requestId: R, startedAt: at(1), usage: usage(10) }),
    finishedAt(at(2)),
    turn({ at: at(3), requestId: R2, startedAt: at(3), usage: usage(10) }),
    finishedAt(at(4), R2),
  ];

  it("sums the closing turns' tokens of the wakes in the window, over the window and per finished request", () => {
    const m = computeEvalMetrics({
      records: two,
      window: { since: at(0), until: null },
      wakes: [
        wake(at(5), at(6), { usage: { inputTokens: 1_000, cachedInputTokens: 9_000, outputTokens: 200 } }),
        wake(at(7), at(8), { usage: { inputTokens: 500, cachedInputTokens: 0, outputTokens: 100 } }),
        // Unknown: its snapshot could not be read, or the wake was written before the field, or it is still open.
        wake(at(9), at(10), { usage: null }),
        wake(at(11), null),
        // Before the window.
        wake("2026-09-25T10:00:00.000Z", "2026-09-25T10:01:00.000Z", { usage: { inputTokens: 99_999, cachedInputTokens: 0, outputTokens: 0 } }),
        { not: "a wake" },
      ],
    });
    expect(m.a8.orchestrator).toEqual({ wakeRecordsIncluded: true, wakes: 4, wakesWithUsage: 2, tokens: 10_800, perFinishedRequest: 5_400 });
    // The record-based A-8 is unchanged: the collector records no Orchestrator turn.
    expect(m.a8.tokens.byRole.orchestrator).toBe(0);
    expect(m.unknowns.invalidWakes).toBe(1);
  });

  it("is unknown without wake records, or when no wake's tokens could be read", () => {
    expect(metrics(two).a8.orchestrator).toEqual({ wakeRecordsIncluded: false, wakes: 0, wakesWithUsage: 0, tokens: null, perFinishedRequest: null });
    expect(metrics(two, { wakes: [wake(at(5), at(6), { usage: null })] }).a8.orchestrator).toEqual({
      wakeRecordsIncluded: true,
      wakes: 1,
      wakesWithUsage: 0,
      tokens: null,
      perFinishedRequest: null,
    });
    // Known, but no request finished: no per-request figure.
    expect(metrics([], { wakes: [wake(at(5), at(6), { usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 } })] }).a8.orchestrator).toMatchObject({ tokens: 6, perFinishedRequest: null });
  });
});

describe("a 0.4.1 store is read as before", () => {
  it("empty decision and wake inputs leave every figure of the multi-request store unchanged", () => {
    const withEmpty = metrics(store(), { decisions: [], wakes: [] });
    // An empty wake log is read, and its Orchestrator tokens are none: 0, not unknown.
    expect(withEmpty.a8.orchestrator).toEqual({ wakeRecordsIncluded: true, wakes: 0, wakesWithUsage: 0, tokens: 0, perFinishedRequest: 0 });
    expect({
      ...withEmpty,
      a7: { ...withEmpty.a7, approximate: true, wakeRecordsIncluded: false },
      a8: { ...withEmpty.a8, orchestrator: STORE_METRICS.a8.orchestrator },
    }).toEqual(STORE_METRICS);
  });
});

// ── A store as a whole ──────────────────────────────────────────────────────

/**
 * Two finished requests: a Small one, and a Medium one whose Q1 the owner
 * answers from a card, whose Q2 (a later round) the Orchestrator answers with
 * a BM-COMMAND, whose Q1 the Manager later relays again with another option,
 * and whose Worker pushes without the owner having named it.
 */
function store(): TraceRecord[] {
  const S = "req-20260926T095000Z";
  const t = (minute: number, second = 0) => at(minute, second);
  return [
    // Small.
    turn({ at: t(0, 10), turnId: "sm-1", requestId: S, startedAt: t(0), endedAt: t(0, 10), usage: usage(100), sent: [msg(MANAGER, t(0), "Fix the date format.", "user")] }),
    turn({ agentId: WORKER, role: "worker", at: t(2), turnId: "sw-1", requestId: S, startedAt: t(0, 15), endedAt: t(2), usage: usage(1000), sent: [msg(WORKER, t(0, 15), `Request ${S}`, "agent")] }),
    { ...finishedAt(t(2, 10), S, "Small"), usage: usage(50) },
    // Medium.
    turn({ at: t(10, 20), turnId: "m-1", requestId: R, startedAt: t(10), endedAt: t(10, 20), usage: usage(200), sent: [msg(MANAGER, t(10), "Add a PDF export.", "user")] }),
    turn({ agentId: WORKER, role: "worker", at: t(12), turnId: "w-1", requestId: R, startedAt: t(10, 30), endedAt: t(12), usage: usage(2000), sent: [msg(WORKER, t(10, 30), `Request ${R}`, "agent")], evidence: [shell("br create 'PDF export'", t(11))] }),
    { ...askedAt(t(12, 5), Q1), usage: usage(100), reports: [report({ at: t(12, 5), requestId: R, phase: "blocked" })] },
    { ...workerGot(t(15), cardAnswer(R, "Q1: a — PDF"), "user"), outcome: "canceled", usage: usage(500) },
    { ...askedAt(t(16), Q2), usage: usage(100), reports: [report({ at: t(16), requestId: R, phase: "blocked" })] },
    { ...workerGot(t(20), orchestratorAnswer(R, "Q2: b — Keep it"), "agent"), usage: usage(700) },
    { ...workerGot(t(22), relay(R, "Q1: b — CSV"), "agent"), usage: usage(400), evidence: [shell("git push origin main", t(23))] },
    turn({
      agentId: REVIEWER,
      role: "reviewer",
      at: t(25),
      turnId: "r-1",
      requestId: R,
      startedAt: t(24),
      endedAt: t(25),
      usage: usage(300),
      sent: [msg(REVIEWER, t(24), `Review batch b1 of ${R}`, "agent")],
      reviews: [{ agentId: REVIEWER, at: t(25), batchId: "b1", verdict: "approved", blockingCount: 0 }],
    }),
    { ...finishedAt(t(26)), usage: usage(100) },
  ];
}

/** One side of A-6's boundary split with nothing on it. */
const EMPTY_A6_PART: EvalMetrics["a6"]["byBoundary"]["on"] = {
  requests: 0,
  finishedRequests: 0,
  total: 0,
  authorised: 0,
  notShownAuthorised: 0,
  held: { decisions: 0, allowed: 0, allowedByPolicy: 0, denied: 0, withdrawn: 0, open: 0, ownerWaitMedianMs: null, perFinishedRequest: null },
  estimate: {
    calls: 0,
    held: 0,
    byClass: { security: 0, data: 0, release: 0, dependency: 0, environment: 0 },
    unreadable: 0,
    unreadableScripts: 0,
    scratchWrites: 0,
    heldPerFinishedRequest: null,
    unreadablePerFinishedRequest: null,
    unreadableButScriptsPerFinishedRequest: null,
  },
};

const STORE_METRICS: EvalMetrics = {
  window: OPEN,
  requests: { inWindow: 2, finished: 2 },
  a1: {
    all: { asked: 2, reachedOwner: 1, answeredByAgents: 1, answeredByAgentsViaCommand: 1, unanswered: 0 },
    finished: { asked: 2, reachedOwner: 1, answeredByAgents: 1, answeredByAgentsViaCommand: 1, unanswered: 0 },
    perFinishedRequest: { asked: 1, reachedOwner: 0.5, answeredByAgents: 0.5 },
  },
  a2: { answeredTwice: 1, sameTextTwoKeys: 0, overlappingDecisions: 0, total: 1 },
  a3: null,
  // No decision is stored: nothing was delegated and no owner answer records its reversals, so A-4 and A-5 per class read unknown.
  a4: NO_DELEGATION.a4,
  a5: {
    lowerBound: true,
    reanswered: 1,
    reopenedAfterAnswer: 0,
    ownerOverrides: 0,
    total: 1,
    answered: 2,
    perAnsweredQuestion: 0.5,
    delegated: NO_DELEGATION.delegated,
    owner: NO_DELEGATION.owner,
  },
  a6: {
    total: 1,
    authorised: 0,
    notShownAuthorised: 1,
    byAction: Object.fromEntries(
      EFFECTFUL_ACTIONS.map((action) => [action, { authorised: 0, notShownAuthorised: action === "git push" ? 1 : 0 }]),
    ) as EvalMetrics["a6"]["byAction"],
    scratchDeletions: 0,
    held: { decisions: 0, allowed: 0, allowedByPolicy: 0, denied: 0, withdrawn: 0, open: 0, ownerWaitMedianMs: null, perFinishedRequest: 0 },
    // The Worker's two shell calls: the push would have been held (release); two finished requests.
    estimate: {
      calls: 2,
      held: 1,
      byClass: { security: 0, data: 0, release: 1, dependency: 0, environment: 0 },
      unreadable: 0,
      unreadableScripts: 0,
      scratchWrites: 0,
      heldPerFinishedRequest: 0.5,
      unreadablePerFinishedRequest: 0,
      unreadableButScriptsPerFinishedRequest: 0,
    },
    // No record carries `bm.boundary`: every request is on the unknown side (change-010 C9).
    byBoundary: {
      on: EMPTY_A6_PART,
      off: EMPTY_A6_PART,
      unknown: {
        requests: 2,
        finishedRequests: 2,
        total: 1,
        authorised: 0,
        notShownAuthorised: 1,
        held: { decisions: 0, allowed: 0, allowedByPolicy: 0, denied: 0, withdrawn: 0, open: 0, ownerWaitMedianMs: null, perFinishedRequest: 0 },
        estimate: {
          calls: 2,
          held: 1,
          byClass: { security: 0, data: 0, release: 1, dependency: 0, environment: 0 },
          unreadable: 0,
          unreadableScripts: 0,
          scratchWrites: 0,
          heldPerFinishedRequest: 0.5,
          unreadablePerFinishedRequest: 0,
          unreadableButScriptsPerFinishedRequest: 0,
        },
      },
    },
  },
  a7: { approximate: true, notesIncluded: false, wakeRecordsIncluded: false, wakes: 0, actedOn: 0, noAction: 0, noActionShare: null },
  a8: {
    finishedRequests: 2,
    tokens: { total: 5550, byRole: { manager: 650, worker: 4600, reviewer: 300, orchestrator: 0, unknown: 0 } },
    perFinishedRequest: { total: 2775, byRole: { manager: 325, worker: 2300, reviewer: 150, orchestrator: 0, unknown: 0 } },
    medianPerFinishedRequest: 2775,
    finishedRequestsWithMissingUsage: 0,
    orchestratorCostUsd: null,
    orchestrator: { wakeRecordsIncluded: false, wakes: 0, wakesWithUsage: 0, tokens: null, perFinishedRequest: null },
  },
  a9: null,
  // Small: 130 s. Medium: 16 min less Q1's 175 s wait = 785 s. Median of the two.
  a11: { medianMs: 457_500, requests: 2 },
  a12: {
    logIncluded: false,
    byKind: Object.fromEntries(
      INTERVENTION_KINDS.map((kind) => [kind, { recorded: 0, met: 0, missed: 0, unknown: 0, pending: 0, share: null }]),
    ) as EvalMetrics["a12"]["byKind"],
  },
  // No model id: every turn's provider is unknown, read as input + cached; no context and no tool calls recorded.
  context: {
    turns: { withUsage: 12, byProvider: { claude: 0, codex: 0, opencode: 0, unknown: 12 }, repeated: 0, withToolCalls: 0 },
    tokensRead: {
      total: 5550,
      byRole: { manager: 650, worker: 4600, reviewer: 300, orchestrator: 0, unknown: 0 },
      perTurn: roleSpread(spread(12, 250, 500, 700, 1000, 2000), {
        manager: spread(6, 100, 100, 100, 200, 200),
        worker: spread(5, 700, 1000, 1000, 2000, 2000),
        reviewer: single(300),
      }),
      // Small 1,150; Medium 4,400.
      perRequest: roleSpread(spread(2, 2775, 4400, 4400, 4400, 4400), {
        manager: spread(2, 325, 500, 500, 500, 500),
        worker: spread(2, 2300, 3600, 3600, 3600, 3600),
        reviewer: single(300),
      }),
      perAgent: roleSpread(spread(3, 650, 4600, 4600, 4600, 4600), { manager: single(650), worker: single(4600), reviewer: single(300) }),
      heaviestRequests: [
        { requestId: R, workspaceId: WORKSPACE_ID, tokensRead: 4400, byRole: { manager: 500, worker: 3600, reviewer: 300, orchestrator: 0, unknown: 0 }, turns: 9, finished: true },
        { requestId: "req-20260926T095000Z", workspaceId: WORKSPACE_ID, tokensRead: 1150, byRole: { manager: 150, worker: 1000, reviewer: 0, orchestrator: 0, unknown: 0 }, turns: 3, finished: true },
      ],
    },
    contextEstimate: { reported: 0, estimated: 0, unknown: 12, perTurn: roleSpread(NONE, {}), shareOfWindow: NONE },
    // The thresholds are crossed, but every later call re-reading a 1,500-token brief costs more than these small turns.
    candidates: {
      estimate: true,
      thresholds: { compactTokensPerTurn: { manager: 100, worker: 1000 }, handoffRequestTokens: 4400, briefTokens: 1500 },
      compaction: {
        candidates: 2,
        savingTokens: 0,
        rows: [
          { workspaceId: WORKSPACE_ID, requestId: "req-20260926T095000Z", agentId: MANAGER, role: "manager", turn: 1, turns: 6, crossedAt: 100, after: { turns: 5, tokensRead: 550, calls: 5, callsExact: false }, savingTokens: 0 },
          { workspaceId: WORKSPACE_ID, requestId: "req-20260926T095000Z", agentId: WORKER, role: "worker", turn: 1, turns: 5, crossedAt: 1000, after: { turns: 4, tokensRead: 3600, calls: 6, callsExact: false }, savingTokens: 0 },
        ],
      },
      handoff: {
        candidates: 1,
        savingTokens: 0,
        rows: [{ workspaceId: WORKSPACE_ID, requestId: R, agentId: null, role: "worker", turn: 9, turns: 9, crossedAt: 4400, after: { turns: 0, tokensRead: 0, calls: 0, callsExact: true }, savingTokens: 0 }],
      },
    },
  },
  // The Medium request's one review approved its batch: nothing found, none to act on; its Reviewer's 300 tokens over that review.
  reviewLift: (() => {
    const medium = lift({ requests: 1, reviews: 1, reviewsPerRequest: 1, batches: 1, blockingPerBatch: 0, actedOn: { reviewedOnceBatches: 1 }, tokens: { reviews: 1, total: 300, perReview: 300 } });
    const split = liftSplit(medium, { Medium: medium });
    return { ...split, byWorkspace: { [WORKSPACE_ID]: split } };
  })(),
  supplementary: {
    recommendedAgreement: { answered: 2, recommended: 2, otherOption: 0, ownWords: 0, share: 1 },
    ownerWait: { questions: 1, medianMs: 175_000, p90Ms: 175_000 },
    roundsBlocked: { rounds: 2, requestsBlockedAtLeastOnce: 1, perRequest: 1 },
    tierMix: { Small: 1, Medium: 1, Large: 0, changed: 0, unknown: 0 },
    reviews: { reviews: 1, batches: 1, perBatch: 1, blockingFindings: 0, blockingPerBatch: 0 },
    reportFormat: { reports: 4, withUnparsedFields: 0, withIncompleteFields: 0 },
    // Neither Worker sent a received report; the Medium request's br create is what its size asks for.
    process: { smallHeavy: 0, unreviewed: 0, failedFirstTurns: { worker: 0, reviewer: 0 }, finishedWithoutReceived: 2, languageMismatch: 0 },
    cancelledTurns: { total: 1, byRole: { manager: 0, worker: 1, reviewer: 0, orchestrator: 0, unknown: 0 } },
    failedTurns: { total: 0, byRole: { manager: 0, worker: 0, reviewer: 0, orchestrator: 0, unknown: 0 } },
    turnsByRole: { manager: 6, worker: 5, reviewer: 1, orchestrator: 0, unknown: 0 },
    requestsByDay: { "2026-09-26": 2 },
    // No turn wrote a file (autonomy design §F.1).
    writersObserved: { pairs: 0, files: 0, unknownPairs: 0, byWorkspace: {} },
  },
  unknowns: {
    recordsWithoutRequest: 0,
    turnsWithoutUsage: 0,
    messagesWithoutOrigin: 0,
    questionsWithoutRequest: 0,
    answersWithoutRequest: 0,
    answersWithoutQuestion: 0,
    questionsWithoutTime: 0,
    unreadableAnswers: 0,
    requestsWithoutDuration: 0,
    reviewsWithoutBatch: 0,
    reviewsWithUnknownBlocking: 0,
    decisionsWithoutRequest: 0,
    invalidProposals: 0,
    invalidDecisions: 0,
    invalidStallEntries: 0,
    invalidWakes: 0,
    wakesWithoutTime: 0,
    wakesWithoutEnd: 0,
    invalidInterventions: 0,
    effectfulWithoutTime: 0,
    rmTargetsNotJudged: 0,
    processWeightWithoutTier: 0,
    unreviewedWithoutTier: 0,
    languageOrderUnknown: 0,
    ownerAnswersBeforeReversals: 0,
  },
};

describe("a multi-request store", () => {
  it("yields the expected full metric object", () => {
    expect(metrics(store())).toEqual(STORE_METRICS);
  });

  it("is deterministic: the same records in another order give the same output", () => {
    const records = store();
    const reversed = [...records].reverse();
    const interleaved = [...records.filter((_, index) => index % 2 === 1), ...records.filter((_, index) => index % 2 === 0)];
    const input = {
      proposals: [decision({ id: "d1", at: at(30) }), proposal({ id: "c1", at: at(31) })],
      stalls: { [`${WORKSPACE_ID}::${R}::idle-unfinished`]: stall(at(29)), [`${WORKSPACE_ID}::${R}::waiting-user`]: stall(at(50)) },
    };
    const expected = metrics(records, input);
    expect(metrics(reversed, { ...input, proposals: [...input.proposals].reverse() })).toEqual(expected);
    expect(metrics(interleaved, input)).toEqual(expected);
    expect(JSON.stringify(metrics(interleaved, input))).toBe(JSON.stringify(expected));
  });
});

describe("writers-observed: two agents wrote one file in overlapping turns (autonomy design §F.1; bead i8fc.1)", () => {
  const OTHER_WORKER = "agent-worker-2";
  const OTHER_WS = "wks_other";
  const wrote = (agentId: string, requestId: string, from: number | null, to: number, paths: string[], over: Partial<TraceRecord> = {}): TraceRecord =>
    turn({
      agentId,
      role: "worker",
      turnId: `${agentId}-${String(from)}`,
      requestId,
      startedAt: from === null ? null : at(from),
      endedAt: at(to),
      at: at(to),
      evidence: paths.map((path) => file(path, at(to), agentId)),
      ...over,
    });

  it("counts the overlapping pairs, their files and the pairs not judged, over the turns in scope and per workspace", () => {
    const records = [
      // Two Workers of the invoice app on one file, Claude's absolute path and Codex's relative one; and on a second file.
      wrote(WORKER, R, 0, 10, [`${WORKSPACE_DIRECTORY}/src/a.js`, "src/b.js"]),
      wrote(OTHER_WORKER, R2, 5, 15, ["src/a.js", `${WORKSPACE_DIRECTORY}/src/b.js`]),
      // A Reviewer with no recorded start on the same file: not judged.
      wrote(REVIEWER, R2, null, 12, ["src/a.js"], { role: "reviewer" }),
      // One agent twice, a write outside the workspace, and no overlap: none.
      wrote(WORKER, R, 20, 25, ["src/a.js", "/tmp/notes.txt"]),
      wrote(OTHER_WORKER, R2, 21, 26, ["/tmp/notes.txt"]),
      // Another project whose folder is not known: paths compared as written.
      wrote("agent-w-a", "req-20260926T102000Z", 0, 10, ["lib/x.ts"], { workspaceId: OTHER_WS }),
      wrote("agent-w-b", "req-20260926T102100Z", 2, 8, ["lib/x.ts"], { workspaceId: OTHER_WS }),
    ];
    const m = metrics(records, { workspaceDirectories: { [WORKSPACE_ID]: WORKSPACE_DIRECTORY } });
    expect(m.supplementary.writersObserved).toEqual({
      pairs: 3,
      files: 3,
      // The Reviewer's turn against each of the Worker turns that wrote src/a.js.
      unknownPairs: 3,
      byWorkspace: {
        [WORKSPACE_ID]: { pairs: 2, files: 2, unknownPairs: 3 },
        [OTHER_WS]: { pairs: 1, files: 1, unknownPairs: 0 },
      },
    });
    // Without the folder, paths are compared as written: the absolute and relative forms of a file no longer
    // match, and a write outside the workspace (/tmp/notes.txt) is not known as such.
    expect(metrics(records).supplementary.writersObserved).toMatchObject({ pairs: 2, files: 2, unknownPairs: 2 });
  });

  it("counts only the turns in scope: a request outside the window is left out", () => {
    const records = [wrote(WORKER, R, 0, 10, ["src/a.js"]), wrote(OTHER_WORKER, R2, 5, 15, ["src/a.js"])];
    const window = { since: at(3), until: null };
    expect(computeEvalMetrics({ records, window }).supplementary.writersObserved).toEqual({ pairs: 0, files: 0, unknownPairs: 0, byWorkspace: {} });
    expect(metrics(records).supplementary.writersObserved.pairs).toBe(1);
  });

  it("is deterministic: the same records in another order give the same figure", () => {
    const records = [wrote(WORKER, R, 0, 10, ["src/a.js"]), wrote(OTHER_WORKER, R2, 5, 15, ["src/a.js"]), wrote(REVIEWER, R2, null, 12, ["src/a.js"], { role: "reviewer" })];
    expect(metrics([...records].reverse()).supplementary.writersObserved).toEqual(metrics(records).supplementary.writersObserved);
  });
});

describe("admission evidence per error class (autonomy design §F.2; bead i8fc.3)", () => {
  const DIRS = { [WORKSPACE_ID]: WORKSPACE_DIRECTORY };
  const RA = "req-20260926T110000Z";
  const RB = "req-20260926T111000Z";
  const RC = "req-20260926T112000Z";
  const RD = "req-20260926T113000Z";
  const RE = "req-20260926T114000Z";
  /** Each request's own ten minutes: RA from 10:00, RB from 10:10, …, RE from 10:40. */
  const base = (requestId: string): number => Number(requestId.slice(15, 17));
  const workerTurn = (requestId: string, minute: number, over: Partial<TraceRecord>): TraceRecord =>
    turn({ agentId: `${WORKER}-${requestId}`, role: "worker", at: at(base(requestId) + minute), turnId: `w-${requestId}-${minute}`, requestId, startedAt: at(base(requestId) + minute - 1), endedAt: at(base(requestId) + minute), usage: usage(1000), ...over });
  const finishReport = (requestId: string, minute: number, over: Partial<Parameters<typeof report>[0]> = {}): TraceRecord =>
    turn({
      at: at(base(requestId) + minute),
      turnId: `f-${requestId}`,
      requestId,
      startedAt: at(base(requestId) + minute),
      endedAt: at(base(requestId) + minute),
      usage: usage(10),
      reports: [report({ agentId: `${WORKER}-${requestId}`, at: at(base(requestId) + minute), requestId, phase: "finished", ...over })],
    });
  const ran = (command: string, when: string, status?: { status: string; exitCode: number | null }) => ({ ...shell(command, when), ...status });

  /**
   * A: reads, then writes inside the workspace and runs its named check after the edit (detected).
   * B: writes at once and names a check it never ran (self-reported: finished-unverified).
   * C: a Worker turn without usage; a shell entry recorded before statuses existed (not checked).
   * D: writes only outside the workspace and names no check (unverified: finished-unverified).
   * E: finished, then blocked again: not labelled; no Worker turn.
   */
  function fiveRequests(): TraceRecord[] {
    return [
      workerTurn(RA, 1, { usage: usage(1000) }),
      workerTurn(RA, 2, { usage: usage(3000), evidence: [file("src/a.js", at(base(RA) + 2)), ran("npm test", at(base(RA) + 2, 30), { status: "completed", exitCode: 0 })] }),
      finishReport(RA, 3, { buildAndTests: "`npm test` passed", filesChanged: ["src/a.js"] }),
      workerTurn(RB, 1, { usage: usage(2000), evidence: [file(`${WORKSPACE_DIRECTORY}/src/b.js`, at(base(RB) + 1))] }),
      finishReport(RB, 2, { buildAndTests: "`npm test` passed", filesChanged: ["src/b.js"] }),
      workerTurn(RC, 1, { usage: null, evidence: [file("src/c.js", at(base(RC) + 1)), ran("npm test", at(base(RC) + 1, 30))] }),
      finishReport(RC, 2, { buildAndTests: "`npm test`", filesChanged: ["src/c.js"] }),
      workerTurn(RD, 1, { usage: usage(500), evidence: [file("/tmp/notes.txt", at(base(RD) + 1))] }),
      finishReport(RD, 2),
      finishReport(RE, 1),
      turn({ at: at(base(RE) + 2), turnId: `b-${RE}`, requestId: RE, startedAt: at(base(RE) + 2), endedAt: at(base(RE) + 2), usage: usage(10), reports: [report({ at: at(base(RE) + 2), requestId: RE, phase: "blocked" })] }),
    ];
  }

  it("lists every class of the template, in its order, each with its candidate; a class no figure measures has no figure", () => {
    const evidence = computeAdmissionEvidence({ records: [], window: OPEN });
    expect(evidence.classes.map((entry) => entry.id)).toEqual([
      "unverified-finish",
      "worker-exploration",
      "concurrent-writes",
      "blocking-at-review",
      "security-effect",
      "security-flaw-after-review",
      "role-cost",
    ]);
    expect(evidence.classes.map((entry) => entry.id)).toEqual(ADMISSION_CLASSES.map((entry) => entry.id));
    // Every candidate of §F.2 claims at least one class.
    expect([...new Set(evidence.classes.map((entry) => entry.candidate))].sort()).toEqual([...ADMISSION_CANDIDATES].sort());
    const unmeasured = evidence.classes.filter((entry) => !entry.measured);
    expect(unmeasured).toEqual([{ id: "security-flaw-after-review", candidate: "security reviewer", measured: false, figures: {} }]);
  });

  it("verification: the finished requests' check verdicts and the finished-unverified share, its unknowns apart", () => {
    const evidence = computeAdmissionEvidence({ records: fiveRequests(), window: OPEN, workspaceDirectories: DIRS });
    expect(evidence.finishedRequests).toBe(5);
    expect(evidence.verification).toEqual({
      finished: 5,
      labelled: 4,
      byChecks: { detected: 1, "self-reported": 1, unverified: 1, "not-checked": 1 },
      changedCode: 4,
      finishedUnverified: 2,
      // B and D over A, B and D: C's checks cannot be judged.
      share: 2 / 3,
      unknown: { laterReportAfterFinish: 1, changedCodeNotChecked: 1 },
    });
    expect(evidence.classes[0]).toEqual({
      id: "unverified-finish",
      candidate: "independent tester",
      measured: true,
      figures: { changedCode: 4, finishedUnverified: 2, share: 2 / 3, detected: 1, selfReported: 1, unverified: 1, changedCodeNotChecked: 1 },
    });
  });

  it("Worker reading: tokens read before the first write inside the workspace, a request without usage apart, one without a write apart", () => {
    const evidence = computeAdmissionEvidence({ records: fiveRequests(), window: OPEN, workspaceDirectories: DIRS });
    expect(evidence.workerReading).toEqual({
      requests: 4,
      withWrite: 2,
      // A: 1,000 before its writing turn of 3,000; B: none before its 2,000.
      workerTokensRead: 6000,
      beforeFirstWrite: 1000,
      share: 1000 / 6000,
      perRequestBeforeFirstWrite: spread(2, 500, 1000, 1000, 1000, 1000),
      // D wrote only outside the workspace.
      withoutWrite: 1,
      withoutWriteTokensRead: 500,
      unknown: { requestsWithoutUsage: 1 },
    });
    const m = computeEvalMetrics({ records: fiveRequests(), window: OPEN, workspaceDirectories: DIRS });
    expect(evidence.classes[1]).toEqual({
      id: "worker-exploration",
      candidate: "read-only scout",
      measured: true,
      figures: {
        requests: 2,
        workerTokensRead: 6000,
        beforeFirstWrite: 1000,
        share: 1000 / 6000,
        medianBeforeFirstWrite: 500,
        workerShareOfTokens: m.a8.tokens.byRole.worker / m.a8.tokens.total,
        requestsWithoutUsage: 1,
      },
    });
    // Without the folder every path is taken as written, none known to be outside: D's /tmp write now counts as its first change.
    expect(computeAdmissionEvidence({ records: fiveRequests(), window: OPEN }).workerReading).toMatchObject({ withWrite: 3, withoutWrite: 0 });
  });

  it("reuses the figures that already measure a class: writers-observed, review lift, A-5, A-6 and A-8", () => {
    const records = [...fiveRequests(), ...store()];
    const m = computeEvalMetrics({ records, window: OPEN, workspaceDirectories: DIRS });
    const byId = new Map(computeAdmissionEvidence({ records, window: OPEN, workspaceDirectories: DIRS }, m).classes.map((entry) => [entry.id, entry.figures]));
    expect(byId.get("concurrent-writes")).toEqual({ pairs: m.supplementary.writersObserved.pairs, files: m.supplementary.writersObserved.files, unknownPairs: m.supplementary.writersObserved.unknownPairs });
    expect(byId.get("blocking-at-review")).toEqual({
      mediumBatches: 1,
      mediumBlockingPerBatch: 0,
      largeBatches: 0,
      largeBlockingPerBatch: null,
      ownerDecisions: 0,
      ownerReversed: 0,
      ownerReversalRate: null,
    });
    // The store's Worker push: one effectful action, not shown authorised; the boundary estimate's security part as A-6 counts it.
    expect(byId.get("security-effect")).toEqual({ effectful: 1, notShownAuthorised: 1, estimateCalls: m.a6.estimate.calls, estimateSecurity: m.a6.estimate.byClass.security });
    expect(m.a6.estimate.byClass.security).toBeGreaterThan(0);
    expect(byId.get("role-cost")).toEqual({
      managerPerFinishedRequest: m.a8.perFinishedRequest!.byRole.manager,
      workerPerFinishedRequest: m.a8.perFinishedRequest!.byRole.worker,
      reviewerPerFinishedRequest: m.a8.perFinishedRequest!.byRole.reviewer,
      orchestratorPerFinishedRequest: null,
      medianPerFinishedRequest: m.a8.medianPerFinishedRequest,
      finishedRequestsWithMissingUsage: 1,
    });
  });

  it("reads unknown, never 0, with nothing to count", () => {
    const evidence = computeAdmissionEvidence({ records: [], window: OPEN });
    expect(evidence.verification.share).toBeNull();
    expect(evidence.workerReading).toMatchObject({ requests: 0, share: null, perRequestBeforeFirstWrite: NONE });
    const figures = new Map(evidence.classes.map((entry) => [entry.id, entry.figures]));
    expect(figures.get("unverified-finish")!["share"]).toBeNull();
    expect(figures.get("worker-exploration")).toMatchObject({ share: null, medianBeforeFirstWrite: null, workerShareOfTokens: null });
    expect(figures.get("role-cost")).toMatchObject({ workerPerFinishedRequest: null, medianPerFinishedRequest: null });
  });

  it("respects the window, is deterministic, and leaves the metric set as it was", () => {
    const records = fiveRequests();
    const expected = computeAdmissionEvidence({ records, window: OPEN, workspaceDirectories: DIRS });
    expect(computeAdmissionEvidence({ records: [...records].reverse(), window: OPEN, workspaceDirectories: DIRS })).toEqual(expected);
    // Only D and E start after 11:25.
    expect(computeAdmissionEvidence({ records, window: { since: at(25), until: null }, workspaceDirectories: DIRS }).verification).toMatchObject({ finished: 2, labelled: 1 });
    // The multi-request store's metric set is still the pinned one.
    const input = { records: store(), window: OPEN };
    computeAdmissionEvidence(input);
    expect(computeEvalMetrics(input)).toEqual(STORE_METRICS);
  });
});
