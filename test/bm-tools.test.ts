import { describe, expect, it } from "vitest";
import { checkBlocks } from "../plugin/shared/bm-format";
import { parseAnswers, parseQuestions } from "../plugin/shared/bm-questions";
import { summaryOf, toChatCard } from "../plugin/client/chat-cards";
import { AGENT_TOOLS, schemaIssues, toolNamed, toolsFor, type ToolResult } from "../plugin/shared/bm-tools";
import { parseReports, parseReviews } from "../plugin/shared/bm-report";

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
        "input.phase: must be one of received, beads-done, blocked, finished",
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
    for (const tool of AGENT_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description).toMatch(/send it verbatim/);
    }
  });

  it("the schema check covers what the schemas use", () => {
    expect(schemaIssues({ type: "array", minItems: 1, maxItems: 1, items: { type: "string" } }, [1, 2])).toEqual([
      "input: takes at most 1 items",
      "input[0]: must be a string",
      "input[1]: must be a string",
    ]);
    expect(schemaIssues({ type: "string", minLength: 1 }, "  ")).toEqual(["input: must not be empty"]);
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
    const card = toChatCard({ type: "user_message", text: built }, "complete")!;
    expect(summaryOf(card)).not.toMatch(/waiting on/);
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
