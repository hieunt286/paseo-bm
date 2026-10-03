import { describe, expect, it } from "vitest";
import { checkBlocks } from "../plugin/shared/bm-format";
import { parseAnswers, parseQuestions } from "../plugin/shared/bm-questions";
import { toChatCards } from "../plugin/client/chat-card-parse";
import { cardFrameOf } from "../plugin/client/chat-card-frame";
import {
  AGENT_TOOLS,
  BOUND_REPORT_TOOL,
  QUESTIONS_FACE,
  TELL_WORKER_FACE,
  questionsRules,
  MANAGER_SERVER_TOOLS,
  ORCHESTRATOR_SERVER_TOOLS,
  WORKER_SERVER_TOOLS,
  WORKSPACE_ID_SOURCE,
  schemaIssues,
  serverToolsFor,
  toolFacesFor,
  toolNamed,
  toolsFor,
  type ToolResult,
} from "../plugin/shared/bm-tools";
import { WORKSPACE_ID_PATTERN } from "../plugin/server/trace-store";
import { parseReports, parseReviews } from "../plugin/shared/bm-report";
import { DECISION_CLASSES, EFFECTS } from "../plugin/shared/decisions";

/**
 * The agents' block-building tools (design delta 20260924b-agent-tools, AT-1).
 * The bar is the plugin's own check: every block a tool returns passes
 * `checkBlocks` untouched, and every bad input is refused with a line per field.
 */

const REQ = "req-20260924T065116Z";
const run = (name: string, input: unknown): ToolResult => toolNamed(name)!.run(input);
const text = (result: ToolResult): string => {
  if (!result.ok) throw new Error(result.issues.join("\n"));
  return result.text;
};
const clean = (block: string) => expect(checkBlocks(block).flatMap((checked) => checked.issues)).toEqual([]);

describe("bm_report", () => {
  const base = { requestId: REQ, tier: { level: "Medium" }, buildAndTests: "npm test: pass" };

  it("builds a clean report at every phase, with or without the optional fields", () => {
    for (const phase of ["received", "beads-done", "finished"]) clean(text(run("bm_report", { ...base, phase })));
    const full = text(
      run("bm_report", {
        ...base,
        phase: "finished",
        tier: { level: "Large", changedFrom: "Medium", reason: "it touches auth", note: "user-visible" },
        filesChanged: ["src/a.ts", "docs/b.md"],
        beadsCreated: ["bm-uepx.1"],
        beadsClosed: ["bm-uepx.1", "bm-uepx.2"],
        reviewFindingsOpen: [{ batchId: "b2", finding: "a flaky test (tracked; see Q3)" }],
        skillsUsed: ["feature-workflow", "implementing-beads"],
        decided: [{ choice: "kept the old label", why: "no one reads the new one yet" }],
        suggestions: ["rename the helper"],
      }),
    );
    clean(full);
    expect(full).toContain("tier: Large (changed: from Medium, it touches auth) — user-visible");
    expect(full).toContain("reviewFindingsOpen: b2: a flaky test (tracked, see Q3)");
    expect(full).toContain("decided: kept the old label — no one reads the new one yet");
    expect(full).toContain("blockers: none. Suggestion (not done): rename the helper");
    const [report] = parseReports(full, { agentId: "w", at: "" });
    expect(report).toMatchObject({ requestId: REQ, phase: "finished", beadsClosed: ["bm-uepx.1", "bm-uepx.2"] });
  });

  it("adds the handoff note, when asked, as its last field: one line, masked by the collector, read back by the parser (autonomy design §G.6)", () => {
    const built = text(run("bm_report", { ...base, phase: "beads-done", handoffNote: "Tried the ISO parser;\nnext: bm-d2 formats the PDF." }));
    clean(built);
    expect(built.split("\n").at(-1)).toBe("handoffNote: Tried the ISO parser; next: bm-d2 formats the PDF.");
    expect(parseReports(built, { agentId: "w", at: "" })[0]).toMatchObject({ phase: "beads-done", handoffNote: "Tried the ISO parser; next: bm-d2 formats the PDF.", unparsedFields: [] });
    // Without it, no line and no field: every other report keeps its shape.
    const plain = text(run("bm_report", { ...base, phase: "beads-done" }));
    expect(plain).not.toContain("handoffNote");
    expect(parseReports(plain, { agentId: "w", at: "" })[0]).not.toHaveProperty("handoffNote");
    const long = run("bm_report", { ...base, phase: "beads-done", handoffNote: "n".repeat(1_501) });
    expect(long.ok).toBe(false);
    expect(!long.ok && long.issues).toEqual(["input.handoffNote: must be at most 1500 characters"]);
  });

  it("writes none for what is empty, and keeps every field on one line", () => {
    const built = text(run("bm_report", { ...base, phase: "received", buildAndTests: "not\nrun", filesChanged: [] }));
    expect(built).toContain("filesChanged: none");
    expect(built).toContain("buildAndTests: not run");
    expect(built).toContain("decided: none");
    expect(built).toContain("blockers: none");
    expect(built.split("\n")).toHaveLength(14);
  });

  it("asks when blocked: the questions line, the BM-QUESTIONS block, letters and one recommendation", () => {
    const built = text(
      run("bm_report", {
        ...base,
        phase: "blocked",
        suggestions: ["cache it"],
        questions: [
          { id: "Q6", text: "Storage — where?", options: [{ text: "Postgres: ready today.", recommended: true }, { text: "a file: simplest." }] },
          { id: "Q7", text: "Cookie — rename?", options: [{ text: "keep it", recommended: true }, { text: "rename it" }, { text: "ask later" }] },
        ],
      }),
    );
    clean(built);
    expect(built).toContain("blockers: 2 questions: Q6, Q7 — see BM-QUESTIONS. Suggestion (not done): cache it");
    expect(built).toContain("- a: Postgres: ready today. (recommended)\n- b: a file: simplest.");
    expect(parseQuestions(built)?.questions.map((question) => question.id)).toEqual(["Q6", "Q7"]);
  });

  it("refuses what the plugin would reject, one line per field, instead of building it", () => {
    const bad = run("bm_report", { ...base, phase: "done", tier: { level: "Huge" }, beadsCreated: ["not a bead"], extra: 1 });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues).toEqual(
      expect.arrayContaining([
        "input.phase: must be one of received, beads-done, blocked, finished, stopped",
        "input.tier.level: must be one of Small, Medium, Large",
        "input.extra: is not a field of this tool",
      ]),
    );
    // The schema names the input field of a bad bead id.
    const beads = run("bm_report", { ...base, phase: "received", beadsCreated: ["not a bead"] });
    expect(!beads.ok && beads.issues.join("\n")).toMatch(/input\.beadsCreated\[0\]: must match/);
    expect(run("bm_report", { ...base, phase: "blocked" })).toEqual({ ok: false, issues: ["input.questions: a blocked report needs its questions"] });
    const twoRecommended = run("bm_report", {
      ...base,
      phase: "blocked",
      questions: [{ id: "Q1", text: "x", options: [{ text: "a", recommended: true }, { text: "b", recommended: true }] }],
    });
    expect(!twoRecommended.ok && twoRecommended.issues.join("\n")).toMatch(/exactly one option ending in \(recommended\)/);
    expect(run("bm_report", { ...base, phase: "received", tier: { level: "Small", changedFrom: "Large" } })).toEqual({
      ok: false,
      issues: ["input.tier.reason: is required with changedFrom"],
    });
    expect(run("bm_report", null)).toEqual({ ok: false, issues: ["input: must be an object"] });
  });

  describe("subject, supersedes and effects (autonomy design §A.5)", () => {
    const blocked = (question: Record<string, unknown>) => run("bm_report", { ...base, phase: "blocked", questions: [question] });
    const ask = (over: Record<string, unknown> = {}, options: Array<Record<string, unknown>> = [{ text: "yes", recommended: true }, { text: "no" }]) =>
      blocked({ id: "Q4", text: "Push?", options, ...over });

    it("writes the tags in the documented order, and the reader takes them back", () => {
      const built = text(
        ask({ text: "Push both backends to origin/dev?", subject: "push-backends", supersedes: "Q2" }, [
          { text: "Push contract only", recommended: true, effects: ["push"] },
          { text: "Push both, manifest by hand", effects: ["push", "commit", "push"] },
          { text: "Hold" },
        ]),
      );
      clean(built);
      expect(built).toContain(
        [
          "Q4: Push both backends to origin/dev? [subject: push-backends] [supersedes: Q2]",
          "- a: Push contract only (recommended) [effects: push]",
          "- b: Push both, manifest by hand [effects: push, commit]",
          "- c: Hold",
        ].join("\n"),
      );
      const [question] = parseQuestions(built)!.questions;
      expect(question).toEqual({
        id: "Q4",
        text: "Push both backends to origin/dev?",
        subject: "push-backends",
        supersedes: "Q2",
        options: [
          { key: "a", text: "Push contract only", recommended: true, effects: ["push"] },
          { key: "b", text: "Push both, manifest by hand", recommended: false, effects: ["push", "commit"] },
          { key: "c", text: "Hold", recommended: false },
        ],
      });
      // The card in the Manager's chat: the question's decision card (cards v2).
      expect(toChatCards({ type: "user_message", text: built }, "complete")).toMatchObject([
        { type: "decision", decision: { id: `q:${REQ}:Q4`, question: "Push both backends to origin/dev?" }, formatIssues: [] },
      ]);
    });

    it("writes no tag for a field left out, null or an empty effects list", () => {
      const built = text(ask({ subject: null, supersedes: null }, [{ text: "yes", recommended: true, effects: [] }, { text: "no", effects: null }]));
      expect(built).toContain("Q4: Push?\n- a: yes (recommended)\n- b: no");
      expect(built).not.toContain("[");
    });

    it("refuses a bad subject, supersedes or effect with the field it is about", () => {
      const issues = (result: ToolResult) => (result.ok ? [] : result.issues).join("\n");
      expect(issues(ask({ subject: "Push Backends" }))).toMatch(/^input\.questions\[0\]\.subject: must match/);
      expect(issues(ask({ subject: "x".repeat(61) }))).toBe("input.questions[0].subject: must be at most 60 characters");
      expect(issues(ask({ subject: "" }))).toMatch(/^input\.questions\[0\]\.subject: must match/);
      expect(issues(ask({ supersedes: "2" }))).toMatch(/^input\.questions\[0\]\.supersedes: must match/);
      expect(issues(ask({ supersedes: "Q4" }))).toBe("input.questions[0].supersedes: must be an earlier question of this request than Q4");
      expect(issues(ask({ supersedes: "Q9" }))).toBe("input.questions[0].supersedes: must be an earlier question of this request than Q4");
      expect(issues(ask({}, [{ text: "yes", recommended: true, effects: ["teleport"] }, { text: "no" }]))).toMatch(
        /^input\.questions\[0\]\.options\[0\]\.effects\[0\]: must be one of none, commit, push/,
      );
      expect(issues(ask({}, [{ text: "yes", recommended: true }, { text: "no", effects: "push" }]))).toBe("input.questions[0].options[1].effects: must be an array");
      expect(issues(ask({}, [{ text: "yes", recommended: true, effects: ["none", "push"] }, { text: "no" }]))).toBe(
        'input.questions[0].options[0].effects: "none" stands alone; leave it out when the option has effects',
      );
      expect(ask({}, [{ text: "yes", recommended: true, effects: ["none"] }, { text: "no" }]).ok).toBe(true);
    });

    it("accepts each of the nine classes, writes it after the other tags, and the reader takes it back (autonomy design §B.9)", () => {
      for (const proposed of DECISION_CLASSES) {
        const built = text(ask({ subject: "push-backends", supersedes: "Q2", class: proposed }));
        clean(built);
        expect(built).toContain(`Q4: Push? [subject: push-backends] [supersedes: Q2] [class: ${proposed}]\n- a: yes (recommended)`);
        expect(parseQuestions(built)!.questions[0]).toMatchObject({ subject: "push-backends", supersedes: "Q2", class: proposed });
      }
      const alone = text(ask({ class: "scope" }));
      expect(alone).toContain("Q4: Push? [class: scope]\n");
      expect(parseQuestions(alone)!.questions[0]!.class).toBe("scope");
      // Left out: no tag, and the question reads without a class.
      expect(parseQuestions(text(ask()))!.questions[0]).not.toHaveProperty("class");
    });

    it("refuses a class that is not one of the nine", () => {
      const refused = ask({ class: "urgent" });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.issues).toEqual([`input.questions[0].class: must be one of ${DECISION_CLASSES.join(", ")}`]);
      expect(ask({ class: "Release" }).ok).toBe(false);
      // A class written into the text is text, never the tag.
      const built = text(ask({ text: "Push? [class: security]" }));
      expect(built).toContain("Q4: Push? (class: security)\n");
      expect(parseQuestions(built)!.questions[0]).not.toHaveProperty("class");
    });

    it("writes a bracketed name: value of the text in parentheses, so it never reads as a tag", () => {
      const built = text(ask({ text: "Push? [subject: fake]" }, [{ text: "yes [effects: deploy]", recommended: true }, { text: "no [see docs]" }]));
      clean(built);
      expect(built).toContain("Q4: Push? (subject: fake)\n- a: yes (effects: deploy) (recommended)\n- b: no [see docs]");
      const [question] = parseQuestions(built)!.questions;
      expect(question).not.toHaveProperty("subject");
      expect(question!.options[0]).not.toHaveProperty("effects");
    });
  });
});

describe("the bound tools (design §16.6)", () => {
  const base = { requestId: REQ, tier: { level: "Medium" }, buildAndTests: "npm test: pass" };
  const bound = (input: unknown) => BOUND_REPORT_TOOL.run(input);

  it("bm_report builds a stopped report, bound or not", () => {
    clean(text(run("bm_report", { ...base, phase: "stopped" })));
    clean(text(bound({ ...base, phase: "stopped" })));
    expect(text(bound({ ...base, phase: "stopped" }))).toContain("phase: stopped");
  });

  it("a bound blocked report names what it waits on in blockers, with no BM-QUESTIONS", () => {
    const block = text(bound({ ...base, phase: "blocked", waitingOn: [`q:${REQ}:Q3`, `q:${REQ}:Q1`, `q:${REQ}:Q3`] }));
    clean(block);
    expect(block).toContain("blockers: waiting on the owner: Q1, Q3");
    expect(block).not.toContain("BM-QUESTIONS");
    const both = text(bound({ ...base, phase: "blocked", waitingOn: [`q:${REQ}:Q1`], waitingFor: "request req-20260924T000000Z\n(its schema)", blockers: "the CI is red" }));
    clean(both);
    expect(both).toContain("blockers: waiting on the owner: Q1. waiting for: request req-20260924T000000Z (its schema). the CI is red");
  });

  it("a bound bm_report refuses questions, a blocked report that waits on nothing, waits outside blocked and another request's question", () => {
    const issues = (input: unknown) => {
      const result = bound(input);
      return result.ok ? [] : result.issues;
    };
    expect(issues({ ...base, phase: "blocked", questions: [] })).toEqual(["input.questions: is not a field of this tool"]);
    expect(issues({ ...base, phase: "blocked" })[0]).toMatch(/^input\.waitingOn: a blocked report names what it waits on/);
    expect(issues({ ...base, phase: "finished", waitingOn: [`q:${REQ}:Q1`] })).toEqual(["input.waitingOn: only a blocked report waits; leave it out"]);
    expect(issues({ ...base, phase: "blocked", waitingOn: ["q:req-20260924T000000Z:Q1"] })).toEqual([`input.waitingOn[0]: q:req-20260924T000000Z:Q1 is not a question of ${REQ}`]);
    expect(issues({ ...base, phase: "blocked", waitingOn: ["Q1"] })[0]).toMatch(/^input\.waitingOn\[0\]: must match/);
    expect(issues({ ...base, phase: "blocked", waitingFor: "x".repeat(501) })).toEqual(["input.waitingFor: must be at most 500 characters"]);
  });

  it("bm_questions' rules: one recommended, keys in order, a grant only on review-budget, at least one there, and exactly one kind of grant", () => {
    const options = (over: Array<Record<string, unknown>> = []) => [
      { key: "a", text: "Yes", effects: ["none"], recommended: true, ...over[0] },
      { key: "b", text: "No", effects: ["none"], ...over[1] },
    ];
    const question = (over: Record<string, unknown> = {}) => ({ text: "More reviews?", subject: "review-budget", class: "cost", options: options([{ grant: { calls: 2 } }]), ...over });
    expect(schemaIssues(QUESTIONS_FACE.inputSchema, { questions: [question()] })).toEqual([]);
    expect(questionsRules({ questions: [question()] } as never)).toEqual([]);
    // Acceptance finding F1: a review-budget question with no grant on any option lets the owner's yes grant nothing.
    expect(questionsRules({ questions: [question({ options: options() })] } as never)).toEqual([
      'input.questions[0].options: a "review-budget" question gives at least one option a grant ({ calls: n } or { untilClean: "<batchId>" }); without one, the owner\'s yes grants nothing',
    ]);
    expect(questionsRules({ questions: [question({ subject: "push", options: options() })] } as never)).toEqual([]);
    expect(questionsRules({ questions: [question({ options: options([{ grant: { calls: 2 } }, { grant: { untilClean: "b1" } }]) })] } as never)).toEqual([]);
    expect(questionsRules({ questions: [question({ subject: "push", options: options([{ grant: { calls: 2 } }]) })] } as never)).toEqual([
      'input.questions[0].options[0].grant: only a question of subject "review-budget" grants',
    ]);
    expect(questionsRules({ questions: [question({ options: options([{ grant: {} }]) })] } as never)).toEqual(["input.questions[0].options[0].grant: give exactly one of calls or untilClean"]);
    expect(questionsRules({ questions: [question({ options: options([{ recommended: false, grant: { calls: 2 } }]) })] } as never)).toEqual(["input.questions[0].options: exactly one option is recommended (found 0)"]);
    expect(questionsRules({ questions: [question({ options: options([{ grant: { calls: 2 } }, { key: "c" }]) })] } as never)).toEqual(["input.questions[0].options[1].key: must be b (keys run a, b, c … in order)"]);
    expect(schemaIssues(QUESTIONS_FACE.inputSchema, { questions: [question({ options: options([{ grant: { calls: 11 } }]) })] })).toEqual([
      "input.questions[0].options[0].grant.calls: must be at most 10",
    ]);
    expect(schemaIssues(QUESTIONS_FACE.inputSchema, { questions: Array.from({ length: 6 }, () => question()) })).toEqual(["input.questions: takes at most 5 items"]);
  });

  it("bm_tell_worker's limits: text at most 8,000 characters, source at most 300", () => {
    expect(schemaIssues(TELL_WORKER_FACE.inputSchema, { requestId: REQ, text: "x".repeat(8_000), source: "y".repeat(300) })).toEqual([]);
    expect(schemaIssues(TELL_WORKER_FACE.inputSchema, { requestId: REQ, text: "x".repeat(8_001), source: "y".repeat(301) })).toEqual([
      "input.text: must be at most 8000 characters",
      "input.source: must be at most 300 characters",
    ]);
  });
});

describe("bm_review", () => {
  const base = { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "the diff\nand the tests", notChecked: "none" };

  it("builds a clean review and writes the verdict from the findings", () => {
    const pass = text(run("bm_review", base));
    clean(pass);
    expect(pass).toContain("verdict: pass");
    expect(pass).toContain("checked: the diff\n  and the tests");
    expect(pass).toContain("findings: none");
    const blocking = text(
      run("bm_review", {
        ...base,
        findings: [
          { severity: "non-blocking", location: "a.ts:3", reason: "naming", suggestedFix: "rename" },
          { severity: "blocking", location: "b.ts:9", reason: "wrong total", suggestedFix: "sum in cents" },
        ],
      }),
    );
    clean(blocking);
    expect(blocking).toContain("verdict: changes-required");
    expect(parseReviews(blocking, { agentId: "r", at: "" })[0]).toMatchObject({ verdict: "changes-required", batchId: "b1", blockingCount: 1 });
  });

  it("refuses a bad batch id or a finding without its fields", () => {
    const bad = run("bm_review", { ...base, batchId: "batch-1", findings: [{ severity: "blocking", location: "x" }] });
    expect(!bad.ok && bad.issues).toEqual(
      expect.arrayContaining(["input.batchId: must match ^b\\d+$", "input.findings[0].reason: is required", "input.findings[0].suggestedFix: is required"]),
    );
  });
});

describe("bm_answers", () => {
  it("builds a clean block the Worker's ledger reads", () => {
    const built = text(
      run("bm_answers", {
        requestId: REQ,
        answers: [
          { id: "Q6", option: "a", optionText: "Postgres: ready today." },
          { id: "Q7", other: "rename it,\nbut next week" },
        ],
      }),
    );
    clean(built);
    expect(built).toBe(`BM-ANSWERS\nrequestId: ${REQ}\nQ6: a — Postgres: ready today.\nQ7: other — rename it, but next week`);
    expect(parseAnswers(built)?.answers.map((answer) => answer.id)).toEqual(["Q6", "Q7"]);
  });

  it("refuses an answer that is neither an option nor the user's words", () => {
    const bad = run("bm_answers", { requestId: REQ, answers: [{ id: "Q1" }, { id: "Q2", option: "a" }, { id: "Q3", option: "b", optionText: "x", other: "y" }] });
    expect(bad).toEqual({
      ok: false,
      issues: ["input.answers[0]: needs option with optionText, or other", "input.answers[1].optionText: is required with option", "input.answers[2]: give option with optionText, or other, not both"],
    });
  });
});

describe("the tool list", () => {
  it("gives each role exactly its own tool, each with an object schema", () => {
    expect(toolsFor("worker").map((tool) => tool.name)).toEqual(["bm_report"]);
    expect(toolsFor("reviewer").map((tool) => tool.name)).toEqual(["bm_review"]);
    expect(toolsFor("manager").map((tool) => tool.name)).toEqual(["bm_answers"]);
    // The workflow assessment is retired (autonomy design §B.9): the Orchestrator builds no block.
    expect(toolsFor("orchestrator")).toEqual([]);
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      // Each builder says what becomes of its block: sent verbatim, or written in the reply for the plugin to relay (bm_report).
      expect(tool.description).toMatch(/send it verbatim|write the block in your reply/);
    }
  });

  it("lists the Orchestrator's server-run tools only, the Worker's bm_reply after bm_report, the Manager's bm_decisions after bm_answers, and nothing new for the Reviewer (orchestrator design §5, autonomy design §A.9, change-014)", () => {
    expect(toolFacesFor("orchestrator").map((tool) => tool.name)).toEqual(["bm_projects", "bm_request", "bm_agent_messages", "bm_send_command", "bm_decisions", "bm_ask_owner", "bm_decide", "bm_predict", "bm_direct_worker", "bm_repo", "bm_note", "bm_findings", "bm_compact", "bm_handoff", "bm_why", "bm_reply"]);
    expect(toolFacesFor("reviewer")).toEqual(toolsFor("reviewer"));
    expect(toolFacesFor("worker").map((tool) => tool.name)).toEqual(["bm_report", "bm_reply"]);
    expect(toolFacesFor("manager").map((tool) => tool.name)).toEqual(["bm_answers", "bm_decisions"]);
    expect(serverToolsFor("manager")).toEqual(MANAGER_SERVER_TOOLS);
    expect(serverToolsFor("worker")).toEqual(WORKER_SERVER_TOOLS);
    expect(serverToolsFor("reviewer")).toEqual([]);
    // The Manager's face only reads, by request: its schema takes nothing that could name an action.
    expect(MANAGER_SERVER_TOOLS.map((tool) => [tool.name, tool.role, tool.inputSchema.required, Object.keys(tool.inputSchema.properties ?? {})])).toEqual([
      ["bm_decisions", "manager", ["requestId"], ["requestId", "status"]],
    ]);
    for (const tool of ORCHESTRATOR_SERVER_TOOLS) {
      expect(tool.role).toBe("orchestrator");
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.description).not.toMatch(/send it verbatim/);
    }
    expect(toolNamed("bm_projects")).toBeUndefined();
  });

  it("the bm_reply faces: one per asker, each taking only its own kind of decision id and a bounded text (change-014 outcome 3)", () => {
    const worker = WORKER_SERVER_TOOLS.find((tool) => tool.name === "bm_reply")!;
    const orchestrator = ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === "bm_reply")!;
    expect([worker.role, orchestrator.role]).toEqual(["worker", "orchestrator"]);
    for (const face of [worker, orchestrator]) {
      expect(face.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["decisionId", "text"] });
      for (const part of ["BM-ASK", "the decision stays open until the owner chooses", "never answer it yourself", "2,000 characters"]) expect(face.description, part).toContain(part);
      expect(face.description).not.toMatch(/send it verbatim/);
    }
    expect(schemaIssues(worker.inputSchema, { decisionId: `q:${REQ}:Q2`, text: "Because of the API limit." })).toEqual([]);
    expect(schemaIssues(worker.inputSchema, { decisionId: "o:abc", text: "x" })).toHaveLength(1);
    expect(schemaIssues(orchestrator.inputSchema, { decisionId: "o:abc-1", text: "x" })).toEqual([]);
    expect(schemaIssues(orchestrator.inputSchema, { decisionId: `q:${REQ}:Q2`, text: "x".repeat(2_001) })).toHaveLength(2);
  });

  it("the bm_why face: read-only, one project and one of bead, file or decision, bounded as the §A.9 read tools (autonomy design §E.2)", () => {
    const face = ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === "bm_why")!;
    expect(face.inputSchema.required).toEqual(["workspaceId"]);
    expect(Object.keys(face.inputSchema.properties ?? {})).toEqual(["workspaceId", "bead", "file", "decision", "detail"]);
    for (const part of ["Give exactly one of bead, file or decision", "at most 4,000 characters by default", 'detail: "full" for up to 60,000', "found, absent or missing with its reason", "Read-only. Returns JSON."]) {
      expect(face.description, part).toContain(part);
    }
    expect(schemaIssues(face.inputSchema, { workspaceId: "wks_1", bead: "bm-1", detail: "brief", push: true })).toEqual([
      "input.detail: must be one of summary, full",
      "input.push: is not a field of this tool",
    ]);
    expect(schemaIssues(face.inputSchema, { workspaceId: "../x", file: "x".repeat(501) })).toEqual([
      `input.workspaceId: must match ${WORKSPACE_ID_SOURCE}`,
      "input.file: must be at most 500 characters",
    ]);
  });

  it("the ADR-016 faces: bm_direct_worker needs re and command, bm_repo takes only its four actions, bm_note caps a note, bm_ask_owner caps its options (orchestrator design §6B.4)", () => {
    const face = (name: string) => ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === name)!;
    expect(face("bm_direct_worker").inputSchema.required).toEqual(["workspaceId", "workerId", "re", "intent", "effects", "command"]);
    expect(
      schemaIssues(face("bm_direct_worker").inputSchema, { workspaceId: "wks_1", workerId: "w", re: "x".repeat(121), intent: "stop", effects: ["none"], command: "Go.", interrupt: "yes" }),
    ).toEqual(["input.re: must be at most 120 characters", "input.interrupt: must be a boolean"]);
    // Both command tools declare intent and effects (autonomy design §A.7); decisionId is optional.
    for (const name of ["bm_send_command", "bm_direct_worker"]) {
      expect(face(name).inputSchema.required).toEqual(expect.arrayContaining(["intent", "effects"]));
      expect(face(name).inputSchema.required).not.toContain("decisionId");
    }
    expect(schemaIssues(face("bm_direct_worker").inputSchema, { workspaceId: "wks_1", workerId: "w", re: "r", intent: "ship", effects: [], command: "Go." })).toEqual([
      "input.intent: must be one of answer, continue, redirect, stop, release, other",
      "input.effects: needs at least 1 item(s)",
    ]);
    expect(schemaIssues(face("bm_send_command").inputSchema, { workspaceId: "wks_1", managerId: "m", intent: "release", effects: ["push", "rocket"], command: "c", reason: "r" })).toEqual([
      `input.effects[1]: must be one of ${EFFECTS.join(", ")}`,
    ]);
    expect(schemaIssues(face("bm_repo").inputSchema, { workspaceId: "wks_1", action: "push" })).toEqual(["input.action: must be one of status, diff-stat, log, show"]);
    expect(schemaIssues(face("bm_note").inputSchema, { workspaceId: "wks_1", text: "x".repeat(501) })).toEqual(["input.text: must be at most 500 characters"]);
    const option = { label: "Push", effects: ["push"] };
    expect(schemaIssues(face("bm_ask_owner").inputSchema, { workspaceId: "wks_1", question: "q", recommendation: "r", options: Array.from({ length: 6 }, () => option) })).toEqual([
      "input.options: takes at most 5 items",
    ]);
    // Each option declares its effects; a prepared command names its target, intent and body, and never a Reviewer.
    expect(
      schemaIssues(face("bm_ask_owner").inputSchema, {
        workspaceId: "wks_1",
        question: "q",
        recommendation: "r",
        options: [{ label: "Push" }, { label: "Go", effects: ["none"], command: { to: "reviewer", agentId: "a", intent: "stop" } }],
        subject: "Push It",
        separate: "yes",
      }),
    ).toEqual([
      "input.options[0].effects: is required",
      "input.options[1].command.body: is required",
      "input.options[1].command.to: must be one of manager, worker",
      "input.subject: must match ^[a-z0-9-]{1,60}$",
      "input.separate: must be a boolean",
    ]);
    // The class it proposes (autonomy design §B.1): one of the nine, optional.
    for (const proposed of DECISION_CLASSES) {
      expect(schemaIssues(face("bm_ask_owner").inputSchema, { workspaceId: "wks_1", question: "q", recommendation: "r", class: proposed })).toEqual([]);
    }
    expect(schemaIssues(face("bm_ask_owner").inputSchema, { workspaceId: "wks_1", question: "q", recommendation: "r", class: "urgent" })).toEqual([
      `input.class: must be one of ${DECISION_CLASSES.join(", ")}`,
    ]);
    expect(schemaIssues(face("bm_decisions").inputSchema, { status: "done", limit: 51 })).toEqual([
      "input.status: must be one of open, needs-confirmation, answered, superseded, withdrawn, expired, unsettled",
      "input.limit: must be at most 50",
    ]);
    expect(face("bm_send_command").description).not.toMatch(/limit line/);
    expect(face("bm_send_command").inputSchema.properties?.["re"]).toMatchObject({ maxLength: 120 });
  });

  it("bm_decide (change-004, bead t9lm.11): a decision, one option and a one-line reason, nothing else — never own words", () => {
    const face = ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === "bm_decide")!;
    expect(face.inputSchema.required).toEqual(["decisionId", "optionKey", "reason"]);
    expect(Object.keys(face.inputSchema.properties ?? {})).toEqual(["decisionId", "optionKey", "reason"]);
    expect(schemaIssues(face.inputSchema, { decisionId: "q:req-20260930T031055Z:Q1", optionKey: "a", reason: "Because." })).toEqual([]);
    expect(schemaIssues(face.inputSchema, { decisionId: "q:req-20260930T031055Z:Q1", optionKey: "Use PDF", reason: "x".repeat(301), words: "PDF" })).toEqual([
      "input.optionKey: must match ^[a-z0-9][a-z0-9-]{0,31}$",
      "input.reason: must be at most 300 characters",
      "input.words: is not a field of this tool",
    ]);
    expect(schemaIssues(face.inputSchema, { decisionId: "f:fb-0123456789ab", optionKey: "wait", reason: "The limit resets soon." })).toEqual([]);
    // Its authority is in its description, where the model reads it: the owner's policy delegating the class to the
    // Orchestrator (autonomy design §B.5, §B.9, bead t9lm.11), any class at the project's level (ADR-025).
    expect(face.description).toMatch(/when a decision\.opened line asks you to: the owner's policy delegates its class to you in that project/);
    expect(face.description).toMatch(/a Worker's question \(q:…\) or a fallback incident \(f:…\)/);
    expect(face.description).toMatch(/its class is delegated in that project \(by the project's autonomy level; any class, a release, data, security or cost one included\)/);
    expect(face.description).not.toMatch(/never release/);
    expect(face.description).toMatch(/your own decisions \(o:…\) are always the owner's/);
    expect(face.description).toMatch(/A decision you leave stays open for the owner/);
    // The command tools point at it for a stored question.
    for (const name of ["bm_send_command", "bm_direct_worker"]) {
      expect(ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === name)!.inputSchema.properties?.["command"]?.description).toContain("bm_decide");
    }
  });

  it("bm_predict (autonomy design §B.3, §B.9): a decision, the option expected and a one-line reason, nothing else", () => {
    const face = ORCHESTRATOR_SERVER_TOOLS.find((tool) => tool.name === "bm_predict")!;
    expect(face.role).toBe("orchestrator");
    expect(face.inputSchema.required).toEqual(["decisionId", "optionKey", "reason"]);
    expect(Object.keys(face.inputSchema.properties ?? {})).toEqual(["decisionId", "optionKey", "reason"]);
    expect(schemaIssues(face.inputSchema, { decisionId: "q:req-20260930T031055Z:Q1", optionKey: "a", reason: "The owner kept the layout last time." })).toEqual([]);
    expect(schemaIssues(face.inputSchema, { decisionId: "f:fb-1", optionKey: "b", reason: "Waiting is cheaper." })).toEqual([]);
    expect(schemaIssues(face.inputSchema, { decisionId: "q:req-20260930T031055Z:Q1", optionKey: "Use PDF", reason: "x".repeat(301), words: "PDF" })).toEqual([
      "input.optionKey: must match ^[a-z0-9][a-z0-9-]{0,31}$",
      "input.reason: must be at most 300 characters",
      "input.words: is not a field of this tool",
    ]);
    // What it is and what it is not, where the model reads it: it answers and sends nothing; the owner sees it as the proposal (ADR-025).
    expect(face.description).toMatch(/It answers nothing and sends nothing: the owner still decides, and sees your option and reason on the decision as your proposal/);
    expect(face.description).toMatch(/autonomy level is 1 or more \(Co-pilot and up\)/);
    expect(face.description).toMatch(/you have not predicted it yet/);
    expect(face.description).not.toMatch(/Do not tell the owner/);
  });

  it("the workspace id rule is the trace store's", () => {
    expect(WORKSPACE_ID_SOURCE).toBe(WORKSPACE_ID_PATTERN.source);
  });

  it("the schema check covers what the schemas use", () => {
    expect(schemaIssues({ type: "array", minItems: 1, maxItems: 1, items: { type: "string" } }, [1, 2])).toEqual([
      "input: takes at most 1 items",
      "input[0]: must be a string",
      "input[1]: must be a string",
    ]);
    expect(schemaIssues({ type: "string", minLength: 1 }, "  ")).toEqual(["input: must not be empty"]);
    expect(schemaIssues({ type: "integer", minimum: 1, maximum: 50 }, 0)).toEqual(["input: must be at least 1"]);
    expect(schemaIssues({ type: "integer", minimum: 1, maximum: 50 }, 51)).toEqual(["input: must be at most 50"]);
    expect(schemaIssues({ type: "integer", minimum: 1, maximum: 50 }, 50)).toEqual([]);
  });
});

describe("values the block could misread are made safe or refused (independent review, 2026-09-24)", () => {
  const base = { requestId: REQ, phase: "finished", tier: { level: "Medium" }, buildAndTests: "npm test: pass" };
  const refused = (name: string, input: unknown) => {
    const result = run(name, input);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.issues;
  };

  it("a finished report with suggestions only is not waiting on anything, in the card or the trace", () => {
    const built = text(run("bm_report", { ...base, suggestions: ["add a test", "rename x"] }));
    expect(built).toContain("blockers: none. Suggestion (not done): add a test; Suggestion (not done): rename x");
    const [card] = toChatCards({ type: "user_message", text: built }, "complete")!;
    const frame = cardFrameOf(card!, { owner: null, peers: [], at: new Date(), now: new Date() });
    expect(frame.body.join("\n")).not.toMatch(/Waiting on/);
    // The same report still in progress says nothing is waiting either.
    const [going] = toChatCards({ type: "user_message", text: text(run("bm_report", { ...base, phase: "beads-done", suggestions: ["add a test"] })) }, "complete")!;
    expect(cardFrameOf(going!, { owner: null, peers: [], at: new Date(), now: new Date() }).body.join("\n")).not.toMatch(/Waiting on/);
    const waiting = text(run("bm_report", { ...base, blockers: "the user's API key", suggestions: ["x"] }));
    expect(waiting).toContain("blockers: the user's API key. Suggestion (not done): x");
  });

  it("a none-like blockers text, or a suggestion already prefixed, does not read as waiting", () => {
    const built = text(run("bm_report", { ...base, blockers: "Nothing.", suggestions: ["Suggestion (not done): add a test"] }));
    expect(built).toContain("blockers: none. Suggestion (not done): add a test");
    expect(text(run("bm_report", { ...base, filesChanged: ["a.ts\n", "b.ts"] }))).toContain("filesChanged: a.ts, b.ts");
    // Parentheses out of order are dropped, so the next item stays its own.
    expect(text(run("bm_report", { ...base, reviewFindingsOpen: [{ batchId: "b1", finding: "step a) then (b" }, { batchId: "b2", finding: "x" }] }))).toContain(
      "reviewFindingsOpen: b1: step a then b; b2: x",
    );
    const onlyFences = run("bm_review", { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "```\n```", notChecked: "none" });
    expect(onlyFences).toEqual({ ok: false, issues: ["input.checked: has no text once code fences and quote marks are removed"] });
  });

  it("names the input field for a bad bead id or skill name, as the live run needed (2026-09-24)", () => {
    expect(refused("bm_report", { ...base, beadsCreated: ["not a bead"], skillsUsed: ["implementing-beads (planned)"] })).toEqual([
      "input.beadsCreated[0]: must match ^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9.-]*$",
      "input.skillsUsed[0]: must match ^[a-z0-9][a-z0-9-]*$",
    ]);
    expect(text(run("bm_report", { ...base, beadsCreated: ["p2-slugify-vietnamese-pcs.1"], skillsUsed: ["implementing-beads"] }))).toContain(
      "beadsCreated: p2-slugify-vietnamese-pcs.1",
    );
    expect(toolNamed("bm_report")!.description).toMatch(/leave out a field you have nothing for/);
  });

  it("the edge cases the generated reports found (bm-tools-property.test.ts)", () => {
    // Suggestions written into blockers out of habit are counted once, as suggestions.
    const habit = text(run("bm_report", { ...base, blockers: "none. Suggestion (not done): add a test", suggestions: ["rename x"] }));
    expect(habit).toContain("blockers: none. Suggestion (not done): add a test; Suggestion (not done): rename x");
    // The marker elsewhere is written plainly, so the Manager's count stays right.
    expect(text(run("bm_report", { ...base, decided: [{ choice: "Suggestion (not done): x", why: "y" }] }))).toContain("decided: suggestion: x — y");
    // A first entry that opens with the word none is not read as empty.
    const [report] = parseReports(text(run("bm_report", { ...base, decided: [{ choice: "none of the old flags kept", why: "unused" }] })), { agentId: "w", at: "" });
    expect(report!.decided).toEqual(['"none" of the old flags kept — unused']);
    // Duplicates go.
    expect(text(run("bm_report", { ...base, beadsClosed: ["bm-a", "bm-a"] }))).toContain("beadsClosed: bm-a\n");
    // Tier words keep the tier readable.
    expect(text(run("bm_report", { ...base, tier: { level: "Large", changedFrom: "Small", reason: "(auth) touched", note: "step a) then (b" } }))).toContain(
      "tier: Large (changed: from Small, [auth] touched) — step a then b",
    );
  });

  it("takes null for a field left out", () => {
    const built = text(run("bm_report", { ...base, blockers: null, tier: { level: "Small", note: null }, suggestions: null }));
    expect(built).toContain("tier: Small (changed: no)\n");
    expect(built).toContain("blockers: none");
  });

  it("refuses a value that reads as a template placeholder instead of returning a block the plugin skips", () => {
    expect(refused("bm_report", { ...base, tier: { level: "Small", note: "read | write" }, beadsCreated: ["NOT A BEAD"] }).join("\n")).toMatch(/placeholder|must match/);
    expect(refused("bm_review", { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "<none>", notChecked: "none" })).toEqual([
      'input.checked: reads as a template placeholder ("<…>" or "a | b"); write it plainly',
    ]);
    // A marker line inside prose stays prose.
    const marker = text(run("bm_review", { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "read the reply:\nBM-REPORT\nphase: finished", notChecked: "none" }));
    expect(marker).toContain("checked: read the reply:\n  `BM-REPORT`\n  phase: finished");
  });

  it("keeps questions the way the card reads them: ids, at most 8 options, the recommendation only by flag", () => {
    const ask = (questions: unknown) => run("bm_report", { ...base, phase: "blocked", questions });
    const two = [{ text: "a", recommended: true }, { text: "b" }];
    expect(refused("bm_report", { ...base, phase: "blocked", questions: [{ id: "Q007", text: "x", options: two }] })[0]).toMatch(/input\.questions\[0\]\.id: must match/);
    expect(refused("bm_report", { ...base, phase: "blocked", questions: [{ id: "Q0", text: "x", options: two }] })[0]).toMatch(/must match/);
    const nine = Array.from({ length: 9 }, (_, index) => ({ text: `o${index}`, recommended: index === 8 }));
    expect(ask([{ id: "Q1", text: "x", options: nine }])).toEqual({ ok: false, issues: ["input.questions[0].options: takes at most 8 items"] });
    expect(ask([{ id: "Q1", text: "x", options: [{ text: "use (recommended) defaults" }, { text: "b", recommended: true }] }])).toEqual({
      ok: false,
      issues: ['input.questions[0].options[0].text: leave out "(recommended)"; set recommended: true instead'],
    });
    const round = text(ask([{ id: "Q3", text: "Topic — which?", options: [{ text: "first (cheap)" }, { text: "second", recommended: true }, { text: "third" }] }]));
    expect(parseQuestions(round)?.questions).toEqual([
      {
        id: "Q3",
        text: "Topic — which?",
        options: [
          { key: "a", text: "first (cheap)", recommended: false },
          { key: "b", text: "second", recommended: true },
          { key: "c", text: "third", recommended: false },
        ],
      },
    ]);
  });

  it("keeps each item of a ;-list whole: no ; inside, parentheses only in pairs", () => {
    const built = text(
      run("bm_report", {
        ...base,
        decided: [{ choice: "a; b", why: "c" }],
        reviewFindingsOpen: [{ batchId: "b1", finding: "slow; flaky (see log" }, { batchId: "b2", finding: "naming" }],
      }),
    );
    clean(built);
    const [report] = parseReports(built, { agentId: "w", at: "" });
    expect(report!.decided).toEqual(["a, b — c"]);
    expect(built).toContain("reviewFindingsOpen: b1: slow, flaky see log; b2: naming");
  });

  it("keeps a pasted command in checked: no fence, no quote mark, still one field", () => {
    const built = text(
      run("bm_review", { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "ran:\n```\nnpm test\n```\n> 12 passed", notChecked: "none" }),
    );
    expect(built).toContain("checked: ran:\n  npm test\n  12 passed");
    expect(refused("bm_review", { requestId: REQ, batchId: "b1", reviewKind: "first", checked: "x".repeat(4001), notChecked: "none" })).toEqual([
      "input.checked: must be at most 4000 characters",
    ]);
  });

  it("refuses the combinations the schema cannot say", () => {
    expect(refused("bm_report", { ...base, tier: { level: "Large", changedFrom: "Large", reason: "r" } })).toEqual([
      "input.tier.changedFrom: equals level; leave it out when the tier did not change",
    ]);
    expect(refused("bm_answers", { requestId: REQ, answers: [{ id: "Q1", optionText: "x", other: "y" }] })).toEqual([
      "input.answers[0]: give option with optionText, or other, not both",
    ]);
    expect(refused("bm_report", { ...base, __proto__: 1, constructor: 1 } as unknown)).toContain("input.constructor: is not a field of this tool");
  });
});
