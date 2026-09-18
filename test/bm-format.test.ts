import { describe, expect, it } from "vitest";
import { checkBlocks, issueText, MAX_CHECKED_CHARS, REPORT_FIELDS, type FormatIssue } from "../plugin/shared/bm-format";
import { answersText, parseQuestions } from "../plugin/shared/bm-questions";

/**
 * The strict BM-* template check (delta 20260918g §4.6, REQ-061 e). Every rule
 * has one failing case; real blocks sent on 2026-09-18 must stay clean, since a
 * false positive costs an agent a turn.
 */

const REQ = "req-20260918T071130Z";

/** A report in exactly the worker.md shape; `over` replaces or drops fields. */
function report(over: Partial<Record<(typeof REPORT_FIELDS)[number], string | null>> = {}): string {
  const values: Record<string, string | null> = {
    requestId: REQ,
    phase: "finished",
    tier: "Small (changed: from Medium, investigation only)",
    filesChanged: "none",
    beadsCreated: "bm-llmg",
    beadsUpdated: "none",
    beadsClosed: "bm-llmg",
    beadsReady: "none",
    reviewFindingsOpen: "none",
    buildAndTests: "live Paseo snapshots read; scratch vitest probe 1/1 pass",
    skillsUsed: "none",
    blockers: "none. Suggestion (not done): label the Manager.",
    ...over,
  };
  return ["BM-REPORT", ...REPORT_FIELDS.filter((key) => values[key] !== null).map((key) => `${key}: ${values[key]}`)].join("\n");
}

const QUESTIONS = [
  "BM-QUESTIONS",
  `requestId: ${REQ}`,
  "Q11: Sao lưu trước khi cài — trình cài ghi đè payload cùng phiên bản.",
  "- a: Chép payload đang chạy sang ~/.paseo-bm/backups/<stamp>-pre-20260918g trước khi cài. (recommended)",
  "- b: Không sao lưu: việc cài không hoàn tác được.",
  "Q12: Errata của Q6 — server plugin không có handle Paseo lúc nạp.",
  "- a: Quét một lần mỗi lần nạp. (recommended)",
  "- b: Như a, và quét thêm ở lần đầu mở một màn hình.",
].join("\n");

const BLOCKED = `${report({
  phase: "blocked",
  tier: "Large (changed: from Small, the user's follow-up asks to enforce the coordination rules between agents)",
  beadsCreated: "none",
  beadsClosed: "none",
  beadsReady: "bm-wp-277-agent-conventions-pbst.1, bm-wp-277-agent-conventions-pbst.8",
  skillsUsed: "feature-workflow, reviewing-plan, converting-plan-to-beads, polishing-beads",
  blockers: "2 questions: Q11, Q12 — see BM-QUESTIONS",
})}\n\n${QUESTIONS}`;

/** The shape of Worker 9467dc77's blocked report (Refactor Dependency, 2026-09-18). */
const REFACTOR_BLOCKED = [
  "BM-REPORT",
  "requestId: req-20260918T070348Z",
  "phase: blocked",
  "tier: Large (changed: no)",
  "filesChanged: none",
  "beadsCreated: none",
  "beadsUpdated: none",
  "beadsClosed: none",
  "beadsReady: none",
  "reviewFindingsOpen: none",
  "buildAndTests: not run (node_modules absent; needs yarn install from Nexus — see Q2)",
  "skillsUsed: feature-workflow",
  "blockers: 3 questions: Q1, Q2, Q3 — see BM-QUESTIONS",
  "",
  "BM-QUESTIONS",
  "requestId: req-20260918T070348Z",
  "Q1: Cách thay thế 7 gói @cmc-dx đang được import (ui-components, ui-admin).",
  "- a: Mirror mặt cắt đang dùng vào libs/<gói>, giữ nguyên specifier qua tsconfig paths. (recommended)",
  "- b: Port vào kit nội bộ với alias mới ngoài scope @cmc-dx.",
  "Q2: Cài đặt/mạng — cần yarn install từ Nexus.",
  "- a: Cài 2 lần: trước khi sửa và sau khi gỡ. (recommended)",
  "- b: Chỉ cài sau khi gỡ.",
  "- c: Không mạng — yarn.lock không sinh lại.",
  "Q3: Bằng chứng zero regression (repo hiện chưa có test nào).",
  "- a: typecheck + lint + build production so mức nền. (recommended)",
  "- b: Chỉ typecheck + lint + build.",
  "- c: (a) + smoke test trình duyệt qua shell host.",
].join("\n");

const REVIEW_PASS = [
  "---",
  "",
  "BM-REVIEW",
  `requestId: ${REQ}`,
  "batchId: b3",
  "reviewKind: re-review",
  "verdict: pass",
  "checked: bm-wp-277-agent-conventions-pbst.15; design delta §4.11; br lint -s all; br dep cycles",
  "findings: none",
  "notChecked: No daemon commands were run.",
].join("\n");

const REVIEW_BLOCKING = [
  "BM-REVIEW",
  `requestId: ${REQ}`,
  "batchId: b2",
  "reviewKind: first",
  "verdict: changes-required",
  "checked: three delta documents; K1–K17 sources",
  "findings:",
  "- severity: blocking",
  "  location: docs/design/paseo-bm-delta-20260918g-agent-conventions.md:208",
  "  reason: A deferred BM-REVIEW notice can stay pending forever.",
  "  suggestedFix: Define a flush trigger after the Reviewer becomes idle.",
  "- severity: non-blocking",
  "  location: bm-wp-277-agent-conventions-pbst.15",
  "  reason: Wording.",
  "  suggestedFix: Shorten it.",
  "notChecked: Live daemon observations.",
].join("\n");

/** Issues of the only (or the given) block, as `field: message` strings. */
function issuesOf(message: string, index = 0): string[] {
  const block = checkBlocks(message)[index];
  if (block === undefined) throw new Error("no block found");
  return block.issues.map((issue) => `${issue.field ?? "-"}: ${issue.message}`);
}

describe("blocks that follow the templates carry no issue", () => {
  it.each([
    ["a finished report of this request", report()],
    ["a received report", report({ phase: "received", beadsCreated: "none", beadsClosed: "none", buildAndTests: "not run" })],
    ["a blocked report with its questions", BLOCKED],
    ["Worker 9467dc77's blocked report shape", REFACTOR_BLOCKED],
    ["a review with no findings, after a --- line", REVIEW_PASS],
    ["a review with a blocking finding", REVIEW_BLOCKING],
    ["a stopped review", "BM-REVIEW STOPPED"],
    ["a report quoted with >", report().split("\n").map((line) => `> ${line}`).join("\n")],
    ["a report inside a code fence", `Here it is:\n\n\`\`\`\n${report()}\n\`\`\`\n\nThanks.`],
  ])("%s", (_name, message) => {
    const blocks = checkBlocks(message);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.flatMap((block) => block.issues)).toEqual([]);
  });

  it("a BM-ANSWERS block as the question card writes it", () => {
    const asked = parseQuestions(BLOCKED)!;
    const text = answersText(REQ, asked.questions, { Q11: { key: "a" }, Q12: { other: "quét khi mở màn hình" } });
    const [block] = checkBlocks(`Continue ${REQ}.\n${text}`);
    expect(block).toMatchObject({ kind: "BM-ANSWERS", requestId: REQ, issues: [] });
  });

  it("skips the format itself (placeholders, a | b choices)", () => {
    const template = [
      "BM-REPORT",
      "requestId: <requestId>",
      "phase: received | beads-done | blocked | finished",
      "tier: Small | Medium | Large (changed: no | from <old tier>, reason)",
    ].join("\n");
    const reviewTemplate = ["BM-REVIEW", "requestId: <requestId>", "verdict: pass | changes-required"].join("\n");
    expect(checkBlocks(`${template}\n\n${reviewTemplate}`)).toEqual([]);
  });

  it("does not take a value with ' | ' in a free-text field for the format", () => {
    expect(checkBlocks(report({ buildAndTests: "npm test pass | lint pass" }))[0]!.issues).toEqual([]);
  });
});

describe("BM-REPORT rules", () => {
  it("each field present once, no unknown field, template order", () => {
    expect(issuesOf(report({ tier: null }))).toEqual(["tier: is missing"]);
    expect(issuesOf(`${report()}\nnotes: hi`)).toEqual(["notes: is not a field of the template"]);
    expect(issuesOf(`${report()}\nphase: finished`)).toEqual(["phase: appears twice"]);
    const swapped = report().replace("phase: finished\ntier: Small (changed: from Medium, investigation only)", "tier: Small (changed: from Medium, investigation only)\nphase: finished");
    expect(issuesOf(swapped)).toEqual([
      `-: fields must follow the template order (${REPORT_FIELDS.join(", ")}); "tier" is out of place`,
    ]);
    expect(issuesOf(`${report()}\n- a stray bullet`)).toEqual(['-: line "- a stray bullet" is not a field of the template']);
  });

  it("requestId, phase and tier values", () => {
    expect(issuesOf(report({ requestId: "req-2026-09-18" }))).toEqual(['requestId: must look like req-YYYYMMDDTHHMMSSZ (got "req-2026-09-18")']);
    expect(issuesOf(report({ phase: "done" }))).toEqual(['phase: must be one of received, beads-done, blocked, finished (got "done")']);
    expect(issuesOf(report({ tier: "Large" }))).toEqual([
      'tier: must be "Small|Medium|Large (changed: no)" or "… (changed: from <tier>, <reason>)"',
    ]);
    expect(issuesOf(report({ tier: "Large (changed: from Small)" }))).toHaveLength(1);
  });

  it("bead fields hold full ids only", () => {
    expect(issuesOf(report({ beadsCreated: "llmg" }))).toEqual(['beadsCreated: must be none or full bead ids separated by commas ("llmg" is not one)']);
    expect(issuesOf(report({ beadsClosed: "bm-llmg (the investigation)" }))).toEqual([
      'beadsClosed: must be none or full bead ids separated by commas ("bm-llmg (the investigation)" is not one)',
    ]);
    expect(issuesOf(report({ beadsReady: "bm-wp-277-agent-conventions-pbst.1, .2" }))).toEqual([
      'beadsReady: must be none or full bead ids separated by commas (".2" is not one)',
    ]);
    expect(issuesOf(report({ beadsUpdated: "" }))).toEqual(["beadsUpdated: must be none or full bead ids separated by commas"]);
  });

  it("skillsUsed, reviewFindingsOpen and the free-text fields", () => {
    expect(issuesOf(report({ skillsUsed: "feature workflow" }))).toEqual(["skillsUsed: must be none or skill names separated by commas"]);
    expect(issuesOf(report({ reviewFindingsOpen: "b2: flush trigger; the other one" }))).toEqual([
      'reviewFindingsOpen: must be none or "b<n>: <finding>" items separated by ";"',
    ]);
    expect(issuesOf(report({ reviewFindingsOpen: "b2: flush trigger; b3: rollback" }))).toEqual([]);
    expect(issuesOf(report({ blockers: "" }))).toEqual(["blockers: is empty; write none"]);
  });

  it("a blocked report needs its BM-QUESTIONS block, and blockers must name exactly its questions", () => {
    expect(issuesOf(report({ phase: "blocked", blockers: "waiting for the user" }))).toEqual([
      "-: a blocked report must be followed by a BM-QUESTIONS block in the same message",
    ]);
    const wrongList = BLOCKED.replace("blockers: 2 questions: Q11, Q12 — see BM-QUESTIONS", "blockers: 2 questions: Q11, Q13 — see BM-QUESTIONS");
    expect(issuesOf(wrongList)).toEqual(['blockers: must start "2 questions: Q11, Q12 — see BM-QUESTIONS"']);
    const prose = BLOCKED.replace("blockers: 2 questions: Q11, Q12 — see BM-QUESTIONS", "blockers: see the questions below");
    expect(issuesOf(prose)).toEqual(['blockers: must start "2 questions: Q11, Q12 — see BM-QUESTIONS"']);
  });

  it("the marker is a bare line, and the block has no blank line inside", () => {
    expect(issuesOf(report().replace("BM-REPORT", "**BM-REPORT**"))).toEqual(["-: the block must start with the bare line BM-REPORT"]);
    const gap = report().replace("\nfilesChanged:", "\n\nfilesChanged:");
    expect(issuesOf(gap)).toEqual(["-: has a blank line inside; the template has none"]);
  });
});

describe("BM-QUESTIONS rules", () => {
  const questions = (lines: string[]) => ["BM-QUESTIONS", `requestId: ${REQ}`, ...lines].join("\n");
  const good = ["Q1: Storage — where?", "- a: the table. (recommended)", "- b: a file."];

  it("requestId first, and equal to the report's", () => {
    expect(issuesOf(["BM-QUESTIONS", ...good].join("\n"))).toEqual(["requestId: must be the first line of the block"]);
    const other = BLOCKED.replace(`BM-QUESTIONS\nrequestId: ${REQ}`, "BM-QUESTIONS\nrequestId: req-20260918T070348Z");
    expect(issuesOf(other, 1)).toEqual([`requestId: must equal the report's ${REQ}`]);
  });

  it("1 to 5 questions, unique, numbers going up", () => {
    const six = Array.from({ length: 6 }, (_, n) => [`Q${n + 1}: q${n + 1}?`, "- a: yes. (recommended)", "- b: no."]).flat();
    expect(issuesOf(questions(six))).toEqual(["-: needs 1 to 5 questions (found 6)"]);
    expect(issuesOf(questions([...good, ...good]))).toEqual(["Q1: appears twice"]);
    expect(issuesOf(questions(["Q2: b?", "- a: x. (recommended)", "- b: y.", ...good]))).toEqual(["Q1: must come after Q2: numbers go up"]);
  });

  it("two or more options, letters a, b, c…, exactly one (recommended)", () => {
    expect(issuesOf(questions(["Q1: only one?", "- a: yes. (recommended)"]))).toEqual(["Q1: needs at least 2 options (found 1)"]);
    expect(issuesOf(questions(["Q1: gap?", "- a: x. (recommended)", "- c: y."]))).toEqual(["Q1: option letters must run a, b, c… (found a, c)"]);
    expect(issuesOf(questions(["Q1: none?", "- a: x.", "- b: y."]))).toEqual(["Q1: needs exactly one option ending in (recommended) (found 0)"]);
    expect(issuesOf(questions(["Q1: two?", "- a: x. (recommended)", "- b: y. (recommended)"]))).toEqual([
      "Q1: needs exactly one option ending in (recommended) (found 2)",
    ]);
  });

  it("every line is a question or an option", () => {
    expect(issuesOf(questions([...good, "(a) the old style"]))).toEqual(['-: line "(a) the old style" is neither "Q<n>: <question>" nor "- <letter>: <option>"']);
  });
});

describe("BM-ANSWERS rules", () => {
  it("requestId first, one well-formed line per answered question", () => {
    expect(issuesOf(["BM-ANSWERS", "Q1: a — yes"].join("\n"))).toEqual(["requestId: must be the first line of the block"]);
    expect(issuesOf(["BM-ANSWERS", `requestId: ${REQ}`, "Q1 a"].join("\n"))).toEqual([
      '-: line "Q1 a" must be "Q<n>: <letter> — <option>" or "Q<n>: other — <words>"',
      "-: answers no question",
    ]);
    expect(issuesOf(["BM-ANSWERS", `requestId: ${REQ}`, "Q1: a — yes", "Q1: b — no"].join("\n"))).toEqual(["Q1: is answered twice"]);
    expect(issuesOf(["BM-ANSWERS", `requestId: ${REQ}`].join("\n"))).toEqual(["-: answers no question"]);
  });
});

describe("BM-REVIEW rules", () => {
  it("fields present once with valid values", () => {
    expect(issuesOf(REVIEW_PASS.replace("reviewKind: re-review\n", ""))).toEqual(["reviewKind: is missing"]);
    expect(issuesOf(REVIEW_PASS.replace("batchId: b3", "batchId: 3"))).toEqual(['batchId: must look like b<n> (got "3")']);
    expect(issuesOf(REVIEW_PASS.replace("reviewKind: re-review", "reviewKind: second"))).toEqual(["reviewKind: must be first or re-review"]);
    expect(issuesOf(REVIEW_PASS.replace("verdict: pass", "verdict: approved"))).toEqual(["verdict: must be pass or changes-required"]);
    expect(issuesOf(`${REVIEW_PASS}\nverdict: pass`)).toEqual(["verdict: appears twice"]);
  });

  it("findings are none or complete items, and the verdict follows the blocking ones", () => {
    expect(issuesOf(REVIEW_BLOCKING.replace("  suggestedFix: Define a flush trigger after the Reviewer becomes idle.\n", ""))).toEqual([
      'finding 1: is missing "suggestedFix"',
    ]);
    expect(issuesOf(REVIEW_BLOCKING.replace("- severity: blocking", "- severity: major"))).toEqual([
      "finding 1: severity must be blocking or non-blocking",
      "verdict: must be pass: no finding is blocking",
    ]);
    expect(issuesOf(REVIEW_BLOCKING.replace("verdict: changes-required", "verdict: pass"))).toEqual([
      "verdict: must be changes-required: a finding is blocking",
    ]);
    expect(issuesOf(REVIEW_PASS.replace("findings: none", "findings:"))).toEqual(['findings: lists no finding; write "findings: none"']);
    expect(issuesOf(REVIEW_PASS.replace("findings: none", "findings: one small thing"))).toEqual([
      'findings: must be "none" or be followed by "- severity: …" items',
    ]);
  });
});

describe("checkBlocks", () => {
  it("returns every block in order, with its requestId and own text", () => {
    const blocks = checkBlocks(BLOCKED);
    expect(blocks.map((block) => [block.kind, block.requestId])).toEqual([
      ["BM-REPORT", REQ],
      ["BM-QUESTIONS", REQ],
    ]);
    expect(blocks[1]!.text).toBe(QUESTIONS);
  });

  it("never throws, and ignores messages without a block", () => {
    for (const bad of [undefined, null, 42, "", "just words", "BM-REPORTING is a word"]) {
      expect(checkBlocks(bad as never)).toEqual([]);
    }
  });

  it("says when a message is too long to check in full", () => {
    const long = `${report()}\n\n${"x".repeat(MAX_CHECKED_CHARS)}`;
    const [block] = checkBlocks(long);
    expect(block!.issues.map((issue) => issue.message)).toEqual([`message too long to check in full (over ${MAX_CHECKED_CHARS} characters)`]);
  });

  it("issueText names the block and the field", () => {
    const issue: FormatIssue = { kind: "BM-REPORT", field: "phase", message: "must be one of …" };
    expect(issueText(issue)).toBe("BM-REPORT phase: must be one of …");
    expect(issueText({ ...issue, field: null })).toBe("BM-REPORT: must be one of …");
  });
});
