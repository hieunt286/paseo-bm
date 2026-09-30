import { describe, expect, it } from "vitest";
import {
  CORRECTION_WINDOW_MS,
  EXCERPT_MAX_CHARS,
  excerptOf,
  flagsOf,
  isProcessDocumentPath,
  workerOrReviewerOfAlias,
  type Flag,
  type RuleFacts,
} from "../plugin/shared/orchestrator-rules";
import { RULE_IDS, type ModelCorrection, type RuleId } from "../plugin/shared/orchestrator";
import type { RuleAgent, RuleInput, RuleMessage } from "../plugin/shared/rule-input";
import {
  MANAGER,
  MODEL_CORRECTIONS,
  REVIEWER,
  WORKER,
  WORKSPACE_DIRECTORY,
  agent,
  at,
  clean,
  correctedModel,
  factsWith,
  failedFirstTurn,
  file,
  inputOf,
  languageAfterReport,
  msg,
  shell,
  smallWithBead,
  turn,
  type RuleFixture,
} from "./fixtures/orchestrator-traces";

/**
 * Orchestrator design §4.1–§4.3, REQ-072, O-1: the seven first-release rules.
 * Each rule has a raised, a not-raised and an `unknown` case; the four slips of
 * the 2026-09-26 run record each raise their flag, and a clean request none.
 */

const states = (flags: Flag[]): Partial<Record<RuleId, Flag["state"]>> =>
  Object.fromEntries(flags.map((flag) => [flag.rule, flag.state]));

const only = (input: RuleInput, facts: RuleFacts, rule: RuleId): Flag | undefined =>
  flagsOf(input, facts).find((flag) => flag.rule === rule);

/** The clean request with some fields of its input replaced. */
function cleanWith(patch: Partial<RuleInput>): { input: RuleInput; facts: RuleFacts } {
  const fixture = clean();
  return { input: { ...fixture.input, ...patch }, facts: fixture.facts };
}

const message = (overrides: Partial<RuleMessage> & Pick<RuleMessage, "at" | "text">): RuleMessage => ({
  agentId: MANAGER,
  role: "manager",
  truncated: false,
  origin: null,
  ...overrides,
});

const VI = "Sửa giúp mình lỗi định dạng ngày trên màn hình hoá đơn nhé.";
const EN = "I handed this to the Worker and will tell you when it is done.";
const VI_REPLY = "Mình đã giao việc này cho Worker, xong sẽ báo lại ngay.";

describe("the 2026-09-26 fixtures (O-1)", () => {
  const cases: Array<[string, () => RuleFixture, RuleId]> = [
    ["a Small request with a bead", smallWithBead, "process.small-heavy"],
    ["the Manager switching to English after a BM-REPORT", languageAfterReport, "manager.language-mismatch"],
    ["a corrected model", correctedModel, "agent.model-corrected"],
    ["a Worker failing its first turn", failedFirstTurn, "agent.failed-first-turn"],
  ];

  it.each(cases)("%s raises exactly its flag", (_name, build, rule) => {
    const { input, facts } = build();
    expect(states(flagsOf(input, facts))).toEqual({ [rule]: "raised" });
  });

  it("a clean request raises no flag", () => {
    const { input, facts } = clean();
    expect(input.state).toBe("completed");
    expect(flagsOf(input, facts)).toEqual([]);
  });

  it("each fixture flag names the slip in its evidence", () => {
    const small = smallWithBead();
    expect(only(small.input, small.facts, "process.small-heavy")?.evidence.map((entry) => [entry.kind, entry.excerpt])).toEqual([
      ["evidence", `br create "Fix the invoice date format" -l feature:hoa-don --json`],
      ["report", "BM-REPORT phase: finished; beadsCreated: bm-d1"],
    ]);

    const language = languageAfterReport();
    const mismatch = only(language.input, language.facts, "manager.language-mismatch");
    expect(mismatch?.observed).toBe("The user wrote to the Manager in Vietnamese, but the Manager replied in English.");
    expect(mismatch?.evidence.map((entry) => [entry.kind, entry.at])).toEqual([
      ["sent", at(0, 20)],
      ["received", at(1, 15)],
    ]);

    const model = correctedModel();
    const corrected = only(model.input, model.facts, "agent.model-corrected");
    expect(corrected?.severity).toBe("info");
    expect(corrected?.evidence.map((entry) => [entry.agentId, entry.kind])).toEqual([
      [WORKER, "correction"],
      [REVIEWER, "correction"],
    ]);
    // Matched by alias, folder and time only: labelled inferred.
    expect(corrected?.evidence.every((entry) => entry.excerpt.startsWith("inferred:"))).toBe(true);
    expect(corrected?.observed).toContain("inferred");

    const failed = failedFirstTurn();
    expect(only(failed.input, failed.facts, "agent.failed-first-turn")?.evidence).toEqual([
      { agentId: WORKER, at: at(0, 50), kind: "evidence", excerpt: "Worker turn w-1 ended failed; it was its first recorded turn" },
    ]);
  });
});

describe("process.small-heavy", () => {
  it("raised: a Small request that created beads, even when br create named no id", () => {
    const { input, facts } = cleanWith({
      tier: "Small",
      beadCounts: { ...clean().input.beadCounts, created: { count: 0, confidence: "unknown" } },
      reports: [],
      filesChanged: [],
      fileEdits: [],
    });
    expect(input.brCreates).toHaveLength(1);
    const flag = only(input, facts, "process.small-heavy");
    expect(flag).toMatchObject({ state: "raised", severity: "warning" });
    expect(flag?.observed).toBe("The Worker sized this request Small but created beads.");
  });

  it("raised: a Small request that wrote or edited a plan or an ADR, from a report or from edit evidence", () => {
    const adr = "docs/adr/ADR-020-dates.md";
    const noBeads = {
      tier: "Small" as const,
      beadCounts: { ...clean().input.beadCounts, created: { count: 0, confidence: "unknown" as const } },
      brCreates: [],
      reports: clean().input.reports.map((entry) => ({
        ...entry,
        beadsCreated: [],
        filesChanged: entry.phase === "finished" ? ["src/invoice/date.ts", adr] : [],
      })),
    };
    const fromReport = cleanWith({ ...noBeads, fileEdits: [], filesChanged: ["src/invoice/date.ts", adr] });
    const reported = only(fromReport.input, fromReport.facts, "process.small-heavy");
    expect(reported?.observed).toBe(
      "The Worker sized this request Small but wrote or edited a plan or an ADR under docs/plans or docs/adr.",
    );
    expect(reported?.evidence.map((entry) => [entry.kind, entry.excerpt])).toEqual([
      ["report", `BM-REPORT phase: finished; filesChanged: ${adr}`],
    ]);

    const fromEdit = cleanWith({
      ...noBeads,
      filesChanged: [],
      fileEdits: [file("/work/invoice-app/docs/plans/dates-plan.md", at(2))],
    });
    expect(only(fromEdit.input, fromEdit.facts, "process.small-heavy")?.evidence).toEqual([
      { agentId: WORKER, at: at(2), kind: "evidence", excerpt: "edit/write /work/invoice-app/docs/plans/dates-plan.md" },
    ]);
  });

  it("not raised: a Small request that corrects product or design documents, touches code only, or an archived plan", () => {
    const codeOnly = cleanWith({
      tier: "Small",
      beadCounts: { ...clean().input.beadCounts, created: { count: 0, confidence: "unknown" } },
      brCreates: [],
      filesChanged: ["src/invoice/date.ts", "docs/design/x.md", "docs/product/invoice-prd.md", "docs/README.md"],
      fileEdits: [
        file("src/invoice/date.ts", at(2)),
        file("/work/invoice-app/docs/design/x.md", at(2, 5)),
        file("docs/archive/plans/old-plan.md", at(2, 10)),
      ],
    });
    expect(only(codeOnly.input, codeOnly.facts, "process.small-heavy")).toBeUndefined();

    const medium = clean();
    expect(medium.input.tier).toBe("Medium");
    expect(medium.input.beadCounts.created.count).toBe(1);
    expect(only(medium.input, medium.facts, "process.small-heavy")).toBeUndefined();
  });

  it("isProcessDocumentPath: docs/plans and docs/adr only, relative or absolute, either separator", () => {
    expect(isProcessDocumentPath("docs/plans/x.md")).toBe(true);
    expect(isProcessDocumentPath("/work/app/docs/adr/ADR-001.md")).toBe(true);
    expect(isProcessDocumentPath("C:\\work\\app\\docs\\plans\\x.md")).toBe(true);
    expect(isProcessDocumentPath("docs/design/x.md")).toBe(false);
    expect(isProcessDocumentPath("docs/product/x.md")).toBe(false);
    expect(isProcessDocumentPath("docs/archive/plans/x.md")).toBe(false);
    expect(isProcessDocumentPath("mydocs/plans/x.md")).toBe(false);
    expect(isProcessDocumentPath("docs/plans")).toBe(false);
  });

  it("unknown: beads were created but no report gave the tier", () => {
    const { input, facts } = cleanWith({ tier: null });
    const flag = only(input, facts, "process.small-heavy");
    expect(flag).toMatchObject({ state: "unknown" });
    expect(flag?.observed).toContain("no report gave the request's tier");
  });
});

describe("process.no-review", () => {
  it("raised: a completed Medium or Large request with no Reviewer at all", () => {
    for (const tier of ["Medium", "Large"] as const) {
      const { input, facts } = cleanWith({ tier, reviewerIds: [], reviewCalls: null });
      const flag = only(input, facts, "process.no-review");
      expect(flag).toMatchObject({ state: "raised", severity: "warning" });
      expect(flag?.observed).toBe(`The ${tier} request finished without any Reviewer.`);
      expect(flag?.evidence.map((entry) => [entry.kind, entry.excerpt])).toEqual([
        ["report", `BM-REPORT phase: finished; tier: Medium`],
      ]);
    }
  });

  it("not raised: reviewed, still running, or Small", () => {
    expect(only(clean().input, clean().facts, "process.no-review")).toBeUndefined();
    const running = cleanWith({ reviewerIds: [], reviewCalls: null, state: "running" });
    expect(only(running.input, running.facts, "process.no-review")).toBeUndefined();
    const small = cleanWith({ tier: "Small", reviewerIds: [], reviewCalls: null });
    expect(only(small.input, small.facts, "process.no-review")).toBeUndefined();
  });

  it("unknown: a Reviewer exists but none of its turns was recorded; or the tier is not known", () => {
    const unrecorded = cleanWith({ reviewCalls: null });
    expect(only(unrecorded.input, unrecorded.facts, "process.no-review")?.state).toBe("unknown");
    const noTier = cleanWith({ tier: null, reviewerIds: [], reviewCalls: null });
    expect(only(noTier.input, noTier.facts, "process.no-review")?.state).toBe("unknown");
  });
});

describe("review.over-budget", () => {
  it("raised: more review calls than REVIEW_BUDGET[tier], with the review calls as evidence", () => {
    const medium = cleanWith({ reviewCalls: 3 });
    const flag = only(medium.input, medium.facts, "review.over-budget");
    expect(flag).toMatchObject({ state: "raised", severity: "warning" });
    expect(flag?.observed).toBe("The Medium request made 3 review calls, over its budget of 2.");
    expect(flag?.evidence.map((entry) => [entry.agentId, entry.kind])).toEqual([[REVIEWER, "sent"]]);
    const large = cleanWith({ tier: "Large", reviewCalls: 5 });
    expect(only(large.input, large.facts, "review.over-budget")?.state).toBe("raised");
  });

  it("not raised: at the budget, or no review call count", () => {
    expect(only(clean().input, clean().facts, "review.over-budget")).toBeUndefined();
    const atBudget = cleanWith({ tier: "Large", reviewCalls: 4 });
    expect(only(atBudget.input, atBudget.facts, "review.over-budget")).toBeUndefined();
    const small = cleanWith({ tier: "Small", reviewCalls: 2 });
    expect(only(small.input, small.facts, "review.over-budget")).toBeUndefined();
  });

  it("reads the budget from facts, not from server code", () => {
    const { input, facts } = cleanWith({ reviewCalls: 2 });
    expect(only(input, { ...facts, reviewBudget: { Small: 1, Medium: 1, Large: 1 } }, "review.over-budget")?.state).toBe(
      "raised",
    );
  });

  it("unknown: more calls than the smallest budget, but no tier", () => {
    const { input, facts } = cleanWith({ tier: null, reviewCalls: 3 });
    expect(only(input, facts, "review.over-budget")?.state).toBe("unknown");
    const withinEvery = cleanWith({ tier: null, reviewCalls: 2 });
    expect(only(withinEvery.input, withinEvery.facts, "review.over-budget")).toBeUndefined();
  });
});

describe("agent.failed-first-turn", () => {
  const liveAgent = (overrides: Partial<RuleAgent>): RuleAgent => ({
    agentId: "agent-rev-2",
    role: "reviewer",
    status: "idle",
    state: "completed",
    startedAt: at(4, 30),
    lastActivityAt: null,
    ...overrides,
  });

  it("raised: a live agent in error with no turn yet", () => {
    const { input, facts } = cleanWith({
      agents: [...clean().input.agents, liveAgent({ status: "error", state: "failed" })],
    });
    const flag = only(input, facts, "agent.failed-first-turn");
    expect(flag).toMatchObject({ state: "raised", severity: "warning" });
    expect(flag?.evidence).toEqual([
      { agentId: "agent-rev-2", at: at(4, 30), kind: "evidence", excerpt: "Reviewer is in Paseo status error with no recorded turn" },
    ]);
  });

  it("not raised: a later turn failed after a completed first one, or a new agent is still running", () => {
    const fixture = clean();
    const records = [
      turn({
        agentId: WORKER,
        role: "worker",
        at: at(7),
        turnId: "w-2",
        requestId: fixture.requestId,
        parentAgentId: MANAGER,
        startedAt: at(6, 50),
        endedAt: at(7),
        outcome: "failed",
      }),
    ];
    const later = { ...fixture.input, turns: [...fixture.input.turns, ...records.map((record) => ({ ...record }))] };
    expect(only(later, fixture.facts, "agent.failed-first-turn")).toBeUndefined();

    const running = cleanWith({ agents: [...clean().input.agents, liveAgent({ status: "running", state: "running" })] });
    expect(only(running.input, running.facts, "agent.failed-first-turn")).toBeUndefined();
  });

  it("unknown: an agent that is not running has no recorded turn", () => {
    const { input, facts } = cleanWith({ agents: [...clean().input.agents, liveAgent({ status: null })] });
    const flag = only(input, facts, "agent.failed-first-turn");
    expect(flag?.state).toBe("unknown");
    expect(flag?.evidence[0]?.excerpt).toBe("Reviewer has no recorded turn; Paseo status not listed");
  });
});

describe("agent.model-corrected", () => {
  const correction = (overrides: Partial<ModelCorrection>): ModelCorrection => ({
    at: at(0, 20),
    alias: "bm-worker/claude-opus-5-5",
    requested: "claude-opus-5-5",
    profileModel: "gpt-5.6-sol",
    cwd: WORKSPACE_DIRECTORY,
    ...overrides,
  });
  // The clean Worker was created at 10:00:30.
  const withCorrections = (corrections: ModelCorrection[], overrides: Partial<RuleFacts> = {}) =>
    only(clean().input, factsWith({ corrections, ...overrides }), "agent.model-corrected");

  it("raised: same role alias, same folder (trailing slash ignored), start within 120 s after the entry", () => {
    const flag = withCorrections([correction({ cwd: `${WORKSPACE_DIRECTORY}/` })]);
    expect(flag).toMatchObject({ state: "raised", severity: "info" });
    expect(flag?.evidence).toEqual([
      {
        agentId: WORKER,
        at: at(0, 20),
        kind: "correction",
        excerpt: `inferred: bm-worker/claude-opus-5-5 asked for model "claude-opus-5-5", started on the profile's "gpt-5.6-sol"`,
      },
    ]);
    // A fallback alias runs the same role; exactly 120 s is inside the window.
    expect(CORRECTION_WINDOW_MS).toBe(120_000);
    expect(withCorrections([correction({ alias: "bm-worker-fallback-2", at: "2026-09-26T09:58:30.000Z" })])?.state).toBe(
      "raised",
    );
  });

  it("not raised: another folder, outside the window, before the entry, or another role", () => {
    expect(withCorrections([correction({ cwd: "/work/other-app" })])).toBeUndefined();
    expect(withCorrections([correction({ at: "2026-09-26T09:58:29.000Z" })])).toBeUndefined();
    expect(withCorrections([correction({ at: at(0, 31) })])).toBeUndefined();
    expect(withCorrections([correction({ alias: "bm-manager/claude-opus-5-5" })])).toBeUndefined();
    expect(withCorrections([correction({ alias: "claude" })])).toBeUndefined();
    expect(withCorrections([])).toBeUndefined();
  });

  it("unknown: the workspace folder is not known, or the agent's start time is not", () => {
    expect(withCorrections([correction({})], { workspaceDirectory: null })?.state).toBe("unknown");

    const fixture = clean();
    const noStart = {
      ...fixture.input,
      agents: fixture.input.agents.map((entry) => (entry.agentId === WORKER ? { ...entry, startedAt: null } : entry)),
    };
    const flag = only(noStart, factsWith({ corrections: [correction({})] }), "agent.model-corrected");
    expect(flag?.state).toBe("unknown");
    expect(flag?.evidence.map((entry) => entry.agentId)).toEqual([WORKER]);
    // A correction from before the request began is someone else's.
    expect(
      only(noStart, factsWith({ corrections: [correction({ at: "2026-09-26T09:00:00.000Z" })] }), "agent.model-corrected"),
    ).toBeUndefined();
  });

  it("maps a provider alias to the Worker or Reviewer role, in shared code", () => {
    expect(workerOrReviewerOfAlias("bm-worker")).toBe("worker");
    expect(workerOrReviewerOfAlias("bm-worker/gpt-5.6-sol")).toBe("worker");
    expect(workerOrReviewerOfAlias("bm-reviewer/default")).toBe("reviewer");
    expect(workerOrReviewerOfAlias("bm-reviewer-fallback-3/x")).toBe("reviewer");
    expect(workerOrReviewerOfAlias("bm-manager")).toBeNull();
    expect(workerOrReviewerOfAlias("bm-orchestrator")).toBeNull();
    expect(workerOrReviewerOfAlias("bm-worker-fallback-4")).toBeNull();
  });

  it("the fixture's entries each match their own agent", () => {
    expect(MODEL_CORRECTIONS.map((entry) => workerOrReviewerOfAlias(entry.alias))).toEqual(["worker", "reviewer"]);
  });
});

describe("report.malformed", () => {
  const reportsOf = (patch: Partial<RuleInput["reports"][number]>) =>
    clean().input.reports.map((entry) => (entry.phase === "received" ? { ...entry, ...patch } : entry));

  it("raised: a report with unparsed or incomplete fields", () => {
    const { input, facts } = cleanWith({ reports: reportsOf({ unparsedFields: ["tier"], incompleteFields: ["beadsCreated"] }) });
    const flag = only(input, facts, "report.malformed");
    expect(flag).toMatchObject({ state: "raised", severity: "warning" });
    expect(flag?.observed).toBe("A report of this request has unreadable or incomplete fields.");
    expect(flag?.evidence.map((entry) => entry.excerpt)).toEqual([
      "BM-REPORT phase: received; unreadable: tier; incomplete: beadsCreated",
    ]);
  });

  it("raised: a completed request with no received report", () => {
    const { input, facts } = cleanWith({ reports: clean().input.reports.filter((entry) => entry.phase !== "received") });
    const flag = only(input, facts, "report.malformed");
    expect(flag?.state).toBe("raised");
    expect(flag?.observed).toBe("The request finished without the Worker ever sending a received report.");
  });

  it("not raised: well-formed reports, or a running request that has not reported yet", () => {
    expect(only(clean().input, clean().facts, "report.malformed")).toBeUndefined();
    const running = cleanWith({ state: "running", reports: [] });
    expect(only(running.input, running.facts, "report.malformed")).toBeUndefined();
  });

  it("unknown: a completed request with no received report and no recorded Manager turn to carry one", () => {
    const { input, facts } = cleanWith({
      managerAgentId: null,
      reports: clean().input.reports.filter((entry) => entry.phase !== "received"),
    });
    expect(only(input, facts, "report.malformed")?.state).toBe("unknown");
  });
});

describe("manager.language-mismatch", () => {
  const conversation = (inbound: RuleMessage[], managerReplies: RuleMessage[]) => cleanWith({ inbound, managerReplies });

  it("raised: English user, Vietnamese reply — both directions", () => {
    const { input, facts } = conversation(
      [message({ at: at(0, 20), text: "Please fix the date format on the invoice screen for me.", origin: "user" })],
      [message({ at: at(0, 35), text: VI_REPLY })],
    );
    const flag = only(input, facts, "manager.language-mismatch");
    expect(flag).toMatchObject({ state: "raised", severity: "warning" });
    expect(flag?.observed).toBe("The user wrote to the Manager in English, but the Manager replied in Vietnamese.");
  });

  it("reads the MOST RECENT message the user typed to the Manager, and the replies after it", () => {
    const { input, facts } = conversation(
      [
        message({ at: at(0, 20), text: VI, origin: "user" }),
        message({ at: at(1), text: "Please also export the date in ISO format everywhere.", origin: "user" }),
      ],
      [message({ at: at(0, 35), text: EN }), message({ at: at(1, 10), text: EN })],
    );
    expect(only(input, facts, "manager.language-mismatch")).toBeUndefined();
  });

  it("not raised: agent or unmarked messages, messages typed to the Worker, an unclear language, no reply yet", () => {
    // An English message from an agent, or with no origin, is not the user's:
    // the Vietnamese replies after it match the Vietnamese user.
    const relayed = conversation(
      [
        message({ at: at(0, 20), text: VI, origin: "user" }),
        message({ at: at(1), text: EN, origin: "agent" }),
        message({ at: at(2), text: EN, origin: null }),
      ],
      [message({ at: at(0, 35), text: VI_REPLY }), message({ at: at(2, 10), text: VI_REPLY })],
    );
    expect(only(relayed.input, relayed.facts, "manager.language-mismatch")).toBeUndefined();

    // English typed to the Worker is not a message to the Manager.
    const toWorker = conversation(
      [
        message({ at: at(0, 20), text: VI, origin: "user" }),
        message({ agentId: WORKER, role: "worker", at: at(1), text: "Please continue with the English copy.", origin: "user" }),
      ],
      [message({ at: at(0, 35), text: VI_REPLY }), message({ at: at(1, 10), text: VI_REPLY })],
    );
    expect(only(toWorker.input, toWorker.facts, "manager.language-mismatch")).toBeUndefined();

    const unclear = conversation(
      [message({ at: at(0, 20), text: "ok", origin: "user" })],
      [message({ at: at(0, 35), text: EN })],
    );
    expect(only(unclear.input, unclear.facts, "manager.language-mismatch")).toBeUndefined();

    const noReply = conversation([message({ at: at(0, 20), text: VI, origin: "user" })], [message({ at: at(0, 10), text: EN })]);
    expect(only(noReply.input, noReply.facts, "manager.language-mismatch")).toBeUndefined();
  });

  it("unknown: a reply in the other language with the same recorded time as the message", () => {
    const { input, facts } = conversation(
      [message({ at: at(0, 20), text: VI, origin: "user" })],
      [message({ at: at(0, 20), text: EN })],
    );
    const flag = only(input, facts, "manager.language-mismatch");
    expect(flag).toMatchObject({ state: "unknown" });
    // Same time, same language: nothing to say.
    const same = conversation([message({ at: at(0, 20), text: VI, origin: "user" })], [message({ at: at(0, 20), text: VI_REPLY })]);
    expect(only(same.input, same.facts, "manager.language-mismatch")).toBeUndefined();
  });

  it("raised: a Vietnamese handoff, then an English reply after the BM-REPORT — evidence is the first mismatching reply", () => {
    const { input, facts } = conversation(
      [message({ at: at(0, 20), text: VI, origin: "user" }), message({ at: at(1, 10), text: "BM-REPORT\nphase: received", origin: "agent" })],
      [
        message({ at: at(0, 35), text: VI_REPLY }),
        message({ at: at(1, 15), text: EN }),
        message({ at: at(6, 25), text: "Done: the export button is there and all tests pass." }),
      ],
    );
    const flag = only(input, facts, "manager.language-mismatch");
    expect(flag?.state).toBe("raised");
    expect(flag?.evidence.map((entry) => [entry.kind, entry.at])).toEqual([
      ["sent", at(0, 20)],
      ["received", at(1, 15)],
    ]);
  });

  it("a later mismatching reply wins over a tied one; a tied one alone stays unknown", () => {
    const later = conversation(
      [message({ at: at(0, 20), text: VI, origin: "user" })],
      [message({ at: at(0, 20), text: EN }), message({ at: at(0, 35), text: VI_REPLY }), message({ at: at(1), text: EN })],
    );
    const raised = only(later.input, later.facts, "manager.language-mismatch");
    expect(raised?.state).toBe("raised");
    expect(raised?.evidence.map((entry) => entry.at)).toEqual([at(0, 20), at(1)]);

    const tiedOnly = conversation(
      [message({ at: at(0, 20), text: VI, origin: "user" })],
      [message({ at: at(0, 20), text: EN }), message({ at: at(0, 35), text: VI_REPLY })],
    );
    expect(only(tiedOnly.input, tiedOnly.facts, "manager.language-mismatch")?.state).toBe("unknown");
  });
});

describe("every flag", () => {
  const everything = (): Array<{ input: RuleInput; facts: RuleFacts }> => {
    const long = "Sửa giúp mình lỗi định dạng ngày trên màn hình hoá đơn nhé. ".repeat(8);
    return [
      clean(),
      smallWithBead(),
      languageAfterReport(),
      correctedModel(),
      failedFirstTurn(),
      // Every rule at once, with long texts.
      {
        input: {
          ...smallWithBead().input,
          reviewerIds: ["agent-rev-9"],
          reviewCalls: 3,
          agents: [
            ...smallWithBead().input.agents,
            { agentId: "agent-rev-9", role: "reviewer", status: "error", state: "failed", startedAt: at(0, 31), lastActivityAt: null },
          ],
          reports: smallWithBead().input.reports.map((entry) => ({ ...entry, unparsedFields: ["blockers"] })),
          inbound: [
            message({ at: at(0, 20), text: long, origin: "user" }),
            message({ agentId: "agent-rev-9", role: "reviewer", at: at(1), text: `Review ${"x".repeat(400)}`, origin: "agent" }),
          ],
          managerReplies: [message({ at: at(0, 35), text: `${EN} `.repeat(6) })],
        },
        facts: factsWith({ corrections: [...MODEL_CORRECTIONS] }),
      },
    ];
  };

  it("the combined input raises every rule, in the catalogue's order", () => {
    const all = everything().at(-1)!;
    expect(flagsOf(all.input, all.facts).map((flag) => flag.rule)).toEqual(
      RULE_IDS.filter((rule) => rule !== "process.no-review"),
    );
    const noReviewer = { ...all.input, tier: "Medium" as const, reviewerIds: [], reviewCalls: null };
    expect(flagsOf(noReviewer, all.facts).map((flag) => flag.rule)).toContain("process.no-review");
  });

  it("carries excerpts of at most 160 characters", () => {
    expect(EXCERPT_MAX_CHARS).toBe(160);
    const flags = everything().flatMap(({ input, facts }) => flagsOf(input, facts));
    expect(flags.length).toBeGreaterThan(6);
    for (const flag of flags) {
      for (const entry of flag.evidence) expect(Array.from(entry.excerpt).length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    }
    const cut = excerptOf(`a\n\n${"b".repeat(300)}`);
    expect(Array.from(cut)).toHaveLength(160);
    expect(cut.startsWith("a b")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(excerptOf("  short   text \n")).toBe("short text");
  });

  it("is a signal only: no flag names an agent to nudge (design §4.2, §11)", () => {
    const flags = everything().flatMap(({ input, facts }) => flagsOf(input, facts));
    for (const flag of flags) {
      expect(Object.keys(flag).sort()).toEqual(["evidence", "observed", "rule", "severity", "state", "why"]);
    }
    expect(new Set(flags.map((flag) => flag.rule))).toEqual(new Set(RULE_IDS.filter((rule) => rule !== "process.no-review")));
  });

  it("says one English sentence for observed and why", () => {
    const flags = everything().flatMap(({ input, facts }) => flagsOf(input, facts));
    for (const flag of flags) {
      for (const sentence of [flag.observed, flag.why]) {
        expect(sentence).toMatch(/^[A-Z0-9][^\n]*\.$/);
        expect(sentence).toMatch(/^[\x20-\x7E]+$/);
      }
    }
  });

  it("is deterministic and leaves its arguments untouched", () => {
    for (const { input, facts } of everything()) {
      const before = JSON.stringify([input, facts]);
      const first = flagsOf(input, facts);
      expect(flagsOf(input, facts)).toEqual(first);
      expect(JSON.stringify([input, facts])).toBe(before);
    }
  });

  it("a fixture rebuilt from the same records gives the same flags", () => {
    const a = correctedModel();
    const b = correctedModel();
    expect(flagsOf(a.input, a.facts)).toEqual(flagsOf(b.input, b.facts));
    // The rebuild helper also serves a hand-made record set.
    const input = inputOf(
      "req-20260926T110000Z",
      [
        turn({
          at: at(0, 40),
          requestId: "req-20260926T110000Z",
          sent: [msg(MANAGER, at(0, 20), VI, "user")],
          evidence: [shell("npm test", at(0, 30), MANAGER)],
        }),
      ],
      [agent({ id: MANAGER, role: "manager" })],
    );
    expect(flagsOf(input, factsWith())).toEqual([]);
  });
});
