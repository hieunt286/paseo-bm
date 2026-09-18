import { describe, expect, it } from "vitest";
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  answersText,
  parseQuestions,
  type Question,
} from "../plugin/shared/bm-questions";

/**
 * The `BM-QUESTIONS` reader and `BM-ANSWERS` writer (delta
 * 20260918c-question-cards §4.3). The block is written by a language model,
 * so most cases are shapes a real run can produce.
 */

const BLOCK = [
  "BM-QUESTIONS",
  "requestId: req-20260917T010956Z",
  'Q1: Storage — the request says "save the user list" but not where.',
  "- a: the existing Postgres `users` table: no migration, ready today. (recommended)",
  "- b: a new table: needs a migration, which makes this request Large.",
  "- c: a file on disk: simplest, but two writers can lose data.",
  "Q2: Existing sessions — renaming the session cookie signs everyone out.",
  "- a: keep the old name: nobody is signed out. (recommended)",
  "- b: rename it: everyone signs in again, once.",
].join("\n");

const REPORT = [
  "BM-REPORT",
  "requestId: req-20260917T010956Z",
  "phase: blocked",
  "tier: Large (changed: no)",
  "filesChanged: docs/a.md",
  "beadsCreated: none",
  "beadsUpdated: none",
  "beadsClosed: none",
  "beadsReady: none",
  "reviewFindingsOpen: none",
  "buildAndTests: not run",
  "skillsUsed: feature-workflow",
  "blockers: 2 questions: Q1, Q2 — see BM-QUESTIONS",
].join("\n");

/** The shape of the example, for the tolerated variants. */
function expectExample(text: string): void {
  const set = parseQuestions(text);
  expect(set).not.toBeNull();
  expect(set!.questions.map((question) => question.id)).toEqual(["Q1", "Q2"]);
  expect(set!.questions.map((question) => question.options.map((option) => option.key))).toEqual([
    ["a", "b", "c"],
    ["a", "b"],
  ]);
  expect(set!.questions.map((question) => question.options.find((option) => option.recommended)?.key)).toEqual(["a", "a"]);
}

describe("reading the block as roles/worker.md teaches it", () => {
  it("reads two questions, their options, the recommendation and the request", () => {
    const set = parseQuestions(`${REPORT}\n\n${BLOCK}`)!;
    expect(set.requestId).toBe("req-20260917T010956Z");
    expect(set.questions).toEqual([
      {
        id: "Q1",
        text: 'Storage — the request says "save the user list" but not where.',
        options: [
          { key: "a", text: "the existing Postgres `users` table: no migration, ready today.", recommended: true },
          { key: "b", text: "a new table: needs a migration, which makes this request Large.", recommended: false },
          { key: "c", text: "a file on disk: simplest, but two writers can lose data.", recommended: false },
        ],
      },
      {
        id: "Q2",
        text: "Existing sessions — renaming the session cookie signs everyone out.",
        options: [
          { key: "a", text: "keep the old name: nobody is signed out.", recommended: true },
          { key: "b", text: "rename it: everyone signs in again, once.", recommended: false },
        ],
      },
    ]);
    expect(JSON.stringify(set)).not.toMatch(/recommended\)/i);
  });

  it("keeps ids as the Worker counted them across rounds", () => {
    const set = parseQuestions(BLOCK.replace("Q1:", "Q6:").replace("Q2:", "Q7:"))!;
    expect(set.questions.map((question) => question.id)).toEqual(["Q6", "Q7"]);
  });

  it("strips backticks around the request id, and reads a missing one as null", () => {
    expect(parseQuestions(BLOCK.replace("requestId: req-20260917T010956Z", "requestId: `req-20260917T010956Z`"))!.requestId).toBe(
      "req-20260917T010956Z",
    );
    expect(parseQuestions(BLOCK.replace("requestId: req-20260917T010956Z\n", ""))!.requestId).toBeNull();
  });
});

describe("shapes a model writes instead", () => {
  it("reads a fenced block", () => {
    expectExample(`${REPORT}\n\n\`\`\`\n${BLOCK}\n\`\`\`\n\nI am waiting for your answers.`);
    expectExample(`\`\`\`\n${REPORT}\n${BLOCK}\n\`\`\``);
  });

  it("reads a quoted block", () => {
    expectExample(BLOCK.split("\n").map((line) => `> ${line}`).join("\n"));
  });

  it("reads bold ids", () => {
    expectExample(BLOCK.replace("Q1:", "**Q1:**").replace("Q2:", "**Q2**:"));
  });

  it("reads options written as (a) or a)", () => {
    expectExample(BLOCK.replace("- a: the existing", "- (a) the existing").replace("- b: a new", "- (b) a new").replace("- c: a file", "- (c) a file"));
    expectExample(BLOCK.replace("- a: keep", "a) keep").replace("- b: rename", "b) rename"));
  });

  it("joins a wrapped line to the option or question above it", () => {
    const set = parseQuestions(
      BLOCK.replace("- b: rename it: everyone signs in again, once.", "- b: rename it:\n  everyone signs in again, once.").replace(
        "Q2: Existing sessions — renaming",
        "Q2: Existing sessions —\n  renaming",
      ),
    )!;
    expect(set.questions[1]!.text).toBe("Existing sessions — renaming the session cookie signs everyone out.");
    expect(set.questions[1]!.options[1]!.text).toBe("rename it: everyone signs in again, once.");
  });

  it("skips an introduction line between the marker and the first question", () => {
    expectExample(BLOCK.replace("requestId: req-20260917T010956Z", "requestId: req-20260917T010956Z\nTwo points need you:"));
  });
});

describe("what it refuses to guess", () => {
  it("drops a recommendation that is not unique", () => {
    const set = parseQuestions(BLOCK.replace("- b: a new table: needs a migration, which makes this request Large.", "- b: a new table. (Recommended)"))!;
    expect(set.questions[0]!.options.map((option) => option.recommended)).toEqual([false, false, false]);
    expect(set.questions[0]!.options[1]!.text).toBe("a new table.");
    expect(set.questions[1]!.options[0]!.recommended).toBe(true);
  });

  it("keeps the first of two questions with the same id, and drops the second one's options", () => {
    const set = parseQuestions(`${BLOCK}\nQ1: Again?\n- a: yes\n- b: no`)!;
    expect(set.questions.map((question) => question.id)).toEqual(["Q1", "Q2"]);
    expect(set.questions[0]!.text).toMatch(/^Storage/);
    expect(set.questions[1]!.options.map((option) => option.key)).toEqual(["a", "b"]);
  });

  it("keeps the first of two options with the same key", () => {
    const set = parseQuestions(BLOCK.replace("- b: rename it", "- a: another\n- b: rename it"))!;
    expect(set.questions[1]!.options.map((option) => option.text)).toEqual([
      "keep the old name: nobody is signed out.",
      "rename it: everyone signs in again, once.",
    ]);
  });

  it("does not take prose starting with 'a:' for an option", () => {
    const set = parseQuestions(`${BLOCK}\na: this line is prose, not an option`)!;
    expect(set.questions[1]!.options.map((option) => option.key)).toEqual(["a", "b"]);
  });

  it("ends the block at prose after the questions", () => {
    const set = parseQuestions(`${BLOCK}\nI am waiting for your answers.\n- c: not an option of Q2`)!;
    expect(set.questions[1]!.options.map((option) => option.key)).toEqual(["a", "b"]);
  });

  it("ends the block at the next paseo-bm block", () => {
    const set = parseQuestions(`${BLOCK}\nBM-REPORT\nrequestId: req-1\nQ3: not a question`)!;
    expect(set.questions.map((question) => question.id)).toEqual(["Q1", "Q2"]);
  });

  it("returns null when there is no block", () => {
    expect(parseQuestions(REPORT)).toBeNull();
    expect(parseQuestions("Q1: a question in prose\n- a: yes")).toBeNull();
    expect(parseQuestions("")).toBeNull();
  });

  it("reads the last of two blocks", () => {
    const earlier = BLOCK.replace("req-20260917T010956Z", "req-OLD");
    const later = "BM-QUESTIONS\nrequestId: req-NEW\nQ3: Colour?\n- a: blue (recommended)\n- b: red";
    const set = parseQuestions(`${earlier}\n\n${later}`)!;
    expect(set.requestId).toBe("req-NEW");
    expect(set.questions.map((question) => question.id)).toEqual(["Q3"]);
  });

  it("returns a question with fewer than two options as it is", () => {
    const set = parseQuestions("BM-QUESTIONS\nQ1: Anything else?\n")!;
    expect(set.questions).toEqual([{ id: "Q1", text: "Anything else?", options: [] }]);
  });
});

describe("bounds", () => {
  it("still finds the block after a report longer than the block budget", () => {
    const files = Array.from({ length: 1200 }, (_, index) => `docs/some/long/path/file-${index}.md`).join(", ");
    const longReport = REPORT.replace("filesChanged: docs/a.md", `filesChanged: ${files}`);
    expect(longReport.length).toBeGreaterThan(20_000);
    expectExample(`${longReport}\n${BLOCK}`);
  });

  it("reads at most 10 questions of 8 options from 200 KB of them, quickly", () => {
    const options = Array.from({ length: 20 }, (_, index) => `- ${String.fromCharCode(97 + index)}: option ${index}`).join("\n");
    const body = Array.from({ length: 2000 }, (_, index) => `Q${index + 1}: question ${index}\n${options}`).join("\n");
    const text = `BM-QUESTIONS\n${body}`;
    expect(text.length).toBeGreaterThan(200_000);
    const started = performance.now();
    const set = parseQuestions(text)!;
    expect(performance.now() - started).toBeLessThan(100);
    expect(set.questions).toHaveLength(MAX_QUESTIONS);
    expect(set.questions.every((question) => question.options.length === MAX_OPTIONS)).toBe(true);
  });

  it("finds a block after 200 KB of prose, quickly", () => {
    const prose = "Some words about the work that was done today, nothing more. ".repeat(3500);
    expect(prose.length).toBeGreaterThan(200_000);
    const started = performance.now();
    const set = parseQuestions(`${prose}\n${BLOCK}`);
    expect(performance.now() - started).toBeLessThan(100);
    expect(set!.questions).toHaveLength(2);
  });

  it("cuts a very long question at 1000 characters", () => {
    const set = parseQuestions(`BM-QUESTIONS\nQ1: ${"x".repeat(5000)}\n- a: yes\n- b: no`)!;
    expect(set.questions[0]!.text).toHaveLength(1000);
    expect(set.questions[0]!.text.endsWith("…")).toBe(true);
  });
});

describe("writing the answers", () => {
  const questions: Question[] = parseQuestions(BLOCK)!.questions;

  it("writes one line per question, in question order, with the option text", () => {
    expect(answersText("req-20260917T010956Z", questions, { Q2: { other: "giữ tên cũ\ntới bản phát hành sau" }, Q1: { key: "a" } })).toBe(
      [
        "BM-ANSWERS",
        "requestId: req-20260917T010956Z",
        "Q1: a — the existing Postgres `users` table: no migration, ready today.",
        "Q2: other — giữ tên cũ tới bản phát hành sau",
      ].join("\n"),
    );
  });

  it("ignores picks for questions it was not given", () => {
    expect(answersText("req-1", questions, { Q1: { key: "b" }, Q2: { key: "b" }, Q9: { key: "a" } })).not.toContain("Q9");
  });

  it("refuses to write a partial answer", () => {
    expect(() => answersText("req-1", questions, { Q1: { key: "a" } })).toThrow(/Q2/);
    expect(() => answersText("req-1", questions, { Q1: { key: "a" }, Q2: { other: "  \n " } })).toThrow(/Q2/);
    expect(() => answersText("req-1", questions, { Q1: { key: "z" }, Q2: { key: "a" } })).toThrow(/Q1/);
  });
});
