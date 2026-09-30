import { describe, expect, it } from "vitest";
import { dangerOfCommand } from "../plugin/server/worker-watch";
import type { ParsedReview, TraceRecord, Usage } from "../plugin/shared/contracts";
import {
  EFFECTFUL_ACTIONS,
  answerChoiceOf,
  computeEvalMetrics,
  effectfulActionOf,
  median,
  percentile,
  type EvalInput,
  type EvalMetrics,
} from "../plugin/shared/eval-metrics";
import { answerDecision, useGrant, type Decision } from "../plugin/shared/decisions";
import { commandBlockOf } from "../plugin/shared/orchestrator-command";
import type { Proposal, WakeEntry } from "../plugin/shared/orchestrator";
import { makeDecision } from "./helpers/decisions";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_DIRECTORY, WORKSPACE_ID, at, msg, report, shell, turn } from "./fixtures/orchestrator-traces";

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
  commandBlockOf({ from: "orchestrator", via: "autopilot", to: "worker", requestId, re: "Answer the open questions", body: `BM-ANSWERS\nrequestId: ${requestId}\n${answers}` });

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

  it("the effectful-action patterns agree with the Worker watch on its own command list", () => {
    const commands = [
      "git push",
      "git -C repo push origin main",
      "npm publish --access public",
      "pnpm publish",
      "yarn publish",
      "kubectl -n prod apply -f deploy.yaml",
      "kubectl delete pod web-1",
      "terraform apply -auto-approve",
      "terraform destroy",
      "helm upgrade web ./chart",
      "helm uninstall web",
      "vercel deploy --prod",
      "docker push registry/app:1",
      `psql -c "DROP TABLE invoices"`,
      `psql -c "TRUNCATE invoices"`,
      `sqlite3 app.db "DELETE FROM invoices;"`,
      "rm -rf /",
      "rm -rf ~/projects",
      "sudo rm -fr $HOME/cache",
      "rm -rf /work/other-app",
      "rm -r -f ../other-app",
      "cd src && rm -rf ../../etc",
      "git status",
      "npm test",
      "kubectl get pods",
      "terraform plan",
      "vercel deploy",
      `sqlite3 app.db "DELETE FROM invoices WHERE id = 3"`,
      "truncate -s 0 app.log",
      "rm -rf dist",
      `rm -rf ${WORKSPACE_DIRECTORY}/build`,
      "rm -r /tmp/scratch",
      "rm -rf $TMPDIR/scratch",
    ];
    for (const command of commands) {
      const watch = dangerOfCommand(command, null, WORKSPACE_DIRECTORY) !== null;
      expect([command, effectfulActionOf(command, WORKSPACE_DIRECTORY) !== null]).toEqual([command, watch]);
    }
    for (const command of commands) {
      const watch = dangerOfCommand(command, null, null) !== null;
      expect([command, effectfulActionOf(command, null) !== null]).toEqual([command, watch]);
    }
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
    const toManager = commandBlockOf({ from: "orchestrator", via: "autopilot", to: "manager", requestId: R, re: "Relay", body: `BM-ANSWERS\nrequestId: ${R}\nQ1: a — PDF` });
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

describe("a 0.4.1 store is read as before", () => {
  it("empty decision and wake inputs leave every figure of the multi-request store unchanged", () => {
    const withEmpty = metrics(store(), { decisions: [], wakes: [] });
    expect({ ...withEmpty, a7: { ...withEmpty.a7, approximate: true, wakeRecordsIncluded: false } }).toEqual(STORE_METRICS);
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
  a5: { lowerBound: true, reanswered: 1, reopenedAfterAnswer: 0, ownerOverrides: 0, total: 1, answered: 2, perAnsweredQuestion: 0.5 },
  a6: {
    total: 1,
    authorised: 0,
    notShownAuthorised: 1,
    byAction: Object.fromEntries(
      EFFECTFUL_ACTIONS.map((action) => [action, { authorised: 0, notShownAuthorised: action === "git push" ? 1 : 0 }]),
    ) as EvalMetrics["a6"]["byAction"],
  },
  a7: { approximate: true, notesIncluded: false, wakeRecordsIncluded: false, wakes: 0, actedOn: 0, noAction: 0, noActionShare: null },
  a8: {
    finishedRequests: 2,
    tokens: { total: 5550, byRole: { manager: 650, worker: 4600, reviewer: 300, orchestrator: 0, unknown: 0 } },
    perFinishedRequest: { total: 2775, byRole: { manager: 325, worker: 2300, reviewer: 150, orchestrator: 0, unknown: 0 } },
    medianPerFinishedRequest: 2775,
    finishedRequestsWithMissingUsage: 0,
    orchestratorCostUsd: null,
  },
  a9: null,
  // Small: 130 s. Medium: 16 min less Q1's 175 s wait = 785 s. Median of the two.
  a11: { medianMs: 457_500, requests: 2 },
  supplementary: {
    recommendedAgreement: { answered: 2, recommended: 2, otherOption: 0, ownWords: 0, share: 1 },
    ownerWait: { questions: 1, medianMs: 175_000, p90Ms: 175_000 },
    roundsBlocked: { rounds: 2, requestsBlockedAtLeastOnce: 1, perRequest: 1 },
    tierMix: { Small: 1, Medium: 1, Large: 0, changed: 0, unknown: 0 },
    reviews: { reviews: 1, batches: 1, perBatch: 1, blockingFindings: 0, blockingPerBatch: 0 },
    reportFormat: { reports: 4, withUnparsedFields: 0, withIncompleteFields: 0 },
    cancelledTurns: { total: 1, byRole: { manager: 0, worker: 1, reviewer: 0, orchestrator: 0, unknown: 0 } },
    failedTurns: { total: 0, byRole: { manager: 0, worker: 0, reviewer: 0, orchestrator: 0, unknown: 0 } },
    turnsByRole: { manager: 6, worker: 5, reviewer: 1, orchestrator: 0, unknown: 0 },
    requestsByDay: { "2026-09-26": 2 },
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
    effectfulWithoutTime: 0,
    rmTargetsNotJudged: 0,
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
