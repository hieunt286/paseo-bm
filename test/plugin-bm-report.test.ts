import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  looksLikeReport,
  parseBeadIds,
  parseGuardrail,
  parseReports,
  parseReviews,
  valueOrNull,
} from "../plugin/server/bm-report";
import * as serverParser from "../plugin/server/bm-report";
import * as sharedParser from "../plugin/shared/bm-report";

/**
 * WP-204: the tolerant reader for `BM-REPORT` / `BM-REVIEW`.
 *
 * The blocks are written by a language model, so every test here is a shape a
 * real run can produce: fenced or not, keys in another case or order, fields
 * missing, extra fields nobody has taught the parser yet, several blocks in one
 * message, and a report quoted back inside a later message.
 *
 * `PRIOR_FORMAT` is the compatibility guard required by REQ-050b: when the role
 * instructions change, that fixture must stay green.
 */

const ctx = { agentId: "agent-worker", at: "2026-09-16T10:00:00.000Z" };

const CURRENT_FORMAT = [
  "Here is where things stand.",
  "",
  "```",
  "BM-REPORT",
  "requestId: req-20260916T100000Z",
  "phase: beads-done",
  "tier: Medium (changed: no)",
  "filesChanged: docs/design/foo.md, docs/plans/bar.md",
  "beadsCreated: bm-a1b, bm-c2d",
  "beadsUpdated: none",
  "beadsClosed: none",
  "beadsReady: bm-a1b",
  "reviewFindingsOpen: batch-1: naming nit",
  "buildAndTests: npm test - pass",
  "blockers: none",
  "guardrail: batch batch-1 reviews 2/2; polish 1/1; total 3/6; userAllowedExtra 0",
  "```",
].join("\n");

/** The shape the instructions used before: no fence, snake_case keys, no tier line. */
const PRIOR_FORMAT = [
  "BM-REPORT",
  "request_id: req-20260101T000000Z",
  "phase: finished",
  "files_changed: src/a.ts",
  "beads_created: bm-old",
  "beads_updated: none",
  "beads_closed: bm-old",
  "beads_ready: none",
  "review_findings_open: none",
  "build_and_tests: not run",
  "blockers: none",
  "guardrail: total 1/1",
].join("\n");

describe("value normalisation", () => {
  it.each(["none", "None", "NONE", "", "   ", "-", "n/a", "null"])("treats %o as absent", (raw) => {
    expect(valueOrNull(raw)).toBeNull();
  });

  it("keeps a real value and strips backticks", () => {
    expect(valueOrNull(" `npm test` ")).toBe("npm test");
  });
});

describe("bead id lists", () => {
  it("splits on commas and whitespace and de-duplicates", () => {
    expect(parseBeadIds("bm-a1b, bm-c2d bm-a1b")).toEqual(["bm-a1b", "bm-c2d"]);
  });

  it("accepts child suffixes and strips punctuation", () => {
    expect(parseBeadIds("`bm-wp-201-cp6.1`, (bm-wp-202-4xi.1).")).toEqual([
      "bm-wp-201-cp6.1",
      "bm-wp-202-4xi.1",
    ]);
  });

  it("drops things that are not bead ids", () => {
    expect(parseBeadIds("none")).toEqual([]);
    expect(parseBeadIds("see the plan")).toEqual([]);
  });
});

/**
 * Delta 20260917-workflow-skills §5.1: the lists a live Worker actually wrote
 * on 2026-09-16. `x-gcj (epic), x-gcj.1, .2, .3` counted 2 beads instead of 4,
 * and `(b2 fix: no-logging AC)` counted `no-logging` as a bead. Both parser
 * copies (server, and the shared one the chat cards use) must agree.
 */
describe.each([
  ["server", serverParser],
  ["shared", sharedParser],
])("bead id lists written by a live Worker (%s parser)", (_name, parser) => {
  const report = (lines: string) =>
    parser.parseReports(`BM-REPORT\nrequestId: req-20260917T000000Z\nphase: finished\n${lines}`, {
      agentId: "w",
      at: "2026-09-17T00:00:00.000Z",
    })[0];

  it("expands .N shorthand against the nearest full id and drops a comment group", () => {
    const parsed = report("beadsCreated: x-gcj (epic), x-gcj.1, .2, .3");
    expect(parsed?.beadsCreated).toEqual(["x-gcj", "x-gcj.1", "x-gcj.2", "x-gcj.3"]);
    expect(parsed?.incompleteFields).toEqual([]);
  });

  it("expands a nested shorthand against the root, not the last child", () => {
    expect(parser.parseBeadIdList("x-gcj.2.1, .2.2, .3")).toEqual({
      ids: ["x-gcj.2.1", "x-gcj.2.2", "x-gcj.3"],
      complete: true,
    });
  });

  it("does not read a word inside a comment as a bead id", () => {
    const parsed = report("beadsUpdated: x-gcj.5 (b2 fix: no-logging AC)");
    expect(parsed?.beadsUpdated).toEqual(["x-gcj.5"]);
    expect(parsed?.incompleteFields).toEqual([]);
  });

  it("still unwraps a group that holds only bead ids", () => {
    expect(parser.parseBeadIdList("`bm-wp-201-cp6.1`, (bm-wp-202-4xi.1).")).toEqual({
      ids: ["bm-wp-201-cp6.1", "bm-wp-202-4xi.1"],
      complete: true,
    });
  });

  it("marks a list incomplete when a shorthand has no full id before it", () => {
    const parsed = report("beadsClosed: .2, x-a");
    expect(parsed?.beadsClosed).toEqual(["x-a"]);
    expect(parsed?.incompleteFields).toEqual(["beadsClosed"]);
  });

  it("marks a list incomplete when it holds prose", () => {
    const parsed = report("beadsReady: x-a, and x-b");
    expect(parsed?.beadsReady).toEqual(["x-a", "x-b"]);
    expect(parsed?.incompleteFields).toEqual(["beadsReady"]);
    expect(parser.parseBeadIdList("see the plan")).toEqual({ ids: [], complete: false });
  });

  it("reads skillsUsed, and never lists it as an unparsed field", () => {
    const parsed = report("buildAndTests: npm test pass\nskillsUsed: feature-workflow, reviewing-plan");
    expect(parsed?.skillsUsed).toEqual(["feature-workflow", "reviewing-plan"]);
    expect(parsed?.unparsedFields).toEqual([]);
    expect(parsed?.incompleteFields).toEqual([]);
  });

  it("reads skillsUsed none, a comment, prose and a missing line", () => {
    expect(report("skillsUsed: none")?.skillsUsed).toEqual([]);
    expect(report("skillsUsed: feature-workflow (partly)")?.skillsUsed).toEqual(["feature-workflow"]);
    // Bead bm-wp-215-60a.2 acceptance case (restored after review bm-wp-220-nvk.1, B2):
    // prose is one comma-separated item, not several skill names.
    const prose = report("skillsUsed: feature-workflow, some notes here");
    expect(prose?.skillsUsed).toEqual(["feature-workflow"]);
    expect(prose?.incompleteFields).toEqual(["skillsUsed"]);
    const spaced = report("skillsUsed: feature-workflow, reviewing plan");
    expect(spaced?.skillsUsed).toEqual(["feature-workflow"]);
    expect(spaced?.incompleteFields).toEqual(["skillsUsed"]);
    expect(report("skillsUsed: `feature-workflow`; polishing-beads.")?.skillsUsed).toEqual(["feature-workflow", "polishing-beads"]);
    const odd = report("skillsUsed: feature-workflow, polishing_beads?");
    expect(odd?.skillsUsed).toEqual(["feature-workflow"]);
    expect(odd?.incompleteFields).toEqual(["skillsUsed"]);
    expect(report("buildAndTests: not run")?.skillsUsed).toEqual([]);
  });

  it("cuts an oversized list, marks it incomplete, and stays fast on crafted input (review bm-wp-220-nvk.1)", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `x-${i.toString(36)}`).join(", ");
    expect(many.length).toBeGreaterThan(parser.MAX_LIST_CHARS);
    const parsed = parser.parseBeadIdList(many);
    expect(parsed.complete).toBe(false);
    expect(parsed.ids.length).toBeGreaterThan(0);
    expect(parser.parseSkillList(`feature-workflow, ${"a".repeat(parser.MAX_LIST_CHARS)}`).complete).toBe(false);
    const nested = `${"(".repeat(20_000)}x${")".repeat(20_000)}`;
    const started = performance.now();
    parser.parseBeadIdList(nested);
    parser.parseSkillList(nested);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("never keeps the id the cap cut through (re-review of bm-wp-220-nvk.1)", () => {
    // The cap falls four characters into the id: without the fix `bm-w` would be read as a bead.
    const value = `${"x".repeat(parser.MAX_LIST_CHARS - 6)}, bm-wp-215-60a.435, x-b`;
    const parsed = parser.parseBeadIdList(value);
    expect(parsed).toEqual({ ids: [], complete: false });
    // A cut that lands just after a separator keeps every full id before it.
    const whole = `${"x-a, ".repeat(Math.floor((parser.MAX_LIST_CHARS - 20) / 5))}bm-wp-215-60a.435, x-b`;
    const kept = parser.parseBeadIdList(`${whole}${", x-c".repeat(10)}`.padEnd(parser.MAX_LIST_CHARS + 50, " "));
    for (const id of kept.ids) expect(whole.split(/[\s,;]+/).concat("x-c")).toContain(id);
  });

  it("treats an absent value as a complete empty list", () => {
    const parsed = report("beadsCreated: none\nbeadsUpdated: -\nbeadsClosed: n/a");
    expect(parsed?.beadsCreated).toEqual([]);
    expect(parsed?.incompleteFields).toEqual([]);
  });
});

describe("guardrail line", () => {
  it("reads every counter and keeps the raw text", () => {
    const guardrail = parseGuardrail(
      "batch batch-7 reviews 1/2; polish 0/1; total 4/10; userAllowedExtra 2",
    );
    expect(guardrail).toMatchObject({
      batchId: "batch-7",
      batchReviews: 1,
      batchMax: 2,
      polish: 0,
      polishMax: 1,
      total: 4,
      budget: 10,
      userAllowedExtra: 2,
    });
    expect(guardrail?.raw).toContain("batch batch-7");
  });

  it("leaves missing counters null instead of guessing zero", () => {
    expect(parseGuardrail("total 2/6")).toMatchObject({
      batchReviews: null,
      polish: null,
      total: 2,
      budget: 6,
      userAllowedExtra: null,
    });
  });

  it("is null when the field says none", () => {
    expect(parseGuardrail("none")).toBeNull();
  });
});

describe("report parsing", () => {
  it("reads the current fenced format in full", () => {
    const [report] = parseReports(CURRENT_FORMAT, ctx);
    expect(report).toMatchObject({
      agentId: "agent-worker",
      at: ctx.at,
      requestId: "req-20260916T100000Z",
      phase: "beads-done",
      tier: "Medium",
      filesChanged: ["docs/design/foo.md", "docs/plans/bar.md"],
      beadsCreated: ["bm-a1b", "bm-c2d"],
      beadsUpdated: [],
      beadsClosed: [],
      beadsReady: ["bm-a1b"],
      buildAndTests: "npm test - pass",
      blockers: null,
    });
    expect(report?.reviewFindingsOpen).toContain("naming nit");
    expect(report?.guardrail?.total).toBe(3);
    expect(report?.unparsedFields).toEqual([]);
  });

  it("reads every field of the block worker.md tells the Worker to send (delta 20260917-workflow-skills; no guardrail since delta 20260917c)", () => {
    const worker = readFileSync(fileURLToPath(new URL("../plugin/roles/worker.md", import.meta.url)), "utf8");
    const start = worker.indexOf("BM-REPORT\nrequestId");
    const template = worker.slice(start, worker.indexOf("```", start)).trimEnd().split("\n");
    const sample: Record<string, string> = {
      requestId: "req-20260917T000000Z",
      phase: "finished",
      tier: "Large (changed: no)",
      filesChanged: "src/a.ts",
      beadsCreated: "x-gcj, x-gcj.1",
      beadsUpdated: "none",
      beadsClosed: "x-gcj.1",
      beadsReady: "none",
      reviewFindingsOpen: "none",
      buildAndTests: "npm test - pass",
      skillsUsed: "feature-workflow, polishing-beads",
      decided: "used zod — already a dependency; Decided: one bead — a single outcome",
      blockers: "none",
      guardrail: "batch b3 reviews 1/2; total 5/6; userAllowedExtra 0",
    };
    const filled = template.map((line) => {
      const key = line.split(":")[0] ?? "";
      if (line === "BM-REPORT") return line;
      expect(sample, `worker.md field ${key} needs a sample here`).toHaveProperty(key);
      return `${key}: ${sample[key]}`;
    });
    const [report] = parseReports(filled.join("\n"), ctx);
    expect(report?.unparsedFields).toEqual([]);
    expect(report?.incompleteFields).toEqual([]);
    expect(report?.skillsUsed).toEqual(["feature-workflow", "polishing-beads"]);
    expect(report?.beadsCreated).toEqual(["x-gcj", "x-gcj.1"]);
    // Owner decision P2-2: the `decided` field, `; `-separated, a repeated label dropped.
    expect(report?.decided).toEqual(["used zod — already a dependency", "one bead — a single outcome"]);
    // Owner decision Q17: the plugin counts review calls; the Worker's block no
    // longer carries a self-reported guardrail line.
    expect(template.some((line) => line.startsWith("guardrail"))).toBe(false);
    expect(report?.guardrail).toBeNull();
  });

  it("still reads the prior instruction format (REQ-050b)", () => {
    const [report] = parseReports(PRIOR_FORMAT, ctx);
    expect(report).toMatchObject({
      requestId: "req-20260101T000000Z",
      phase: "finished",
      tier: null,
      filesChanged: ["src/a.ts"],
      beadsCreated: ["bm-old"],
      beadsClosed: ["bm-old"],
      buildAndTests: "not run",
    });
  });

  it("survives a missing field by reporting null, not by failing", () => {
    const [report] = parseReports(["BM-REPORT", "phase: blocked"].join("\n"), ctx);
    expect(report?.phase).toBe("blocked");
    expect(report?.requestId).toBeNull();
    expect(report?.guardrail).toBeNull();
    expect(report?.filesChanged).toEqual([]);
  });

  it("keeps an unknown field instead of rejecting the block", () => {
    const [report] = parseReports(
      ["BM-REPORT", "phase: received", "someFutureField: 42", "anotherOne: x"].join("\n"),
      ctx,
    );
    expect(report?.phase).toBe("received");
    expect(report?.unparsedFields).toEqual(["someFutureField", "anotherOne"]);
  });

  it("does not care about key case or order", () => {
    const [report] = parseReports(
      ["BM-REPORT", "PHASE: Finished", "RequestID: req-x", "Tier: large"].join("\n"),
      ctx,
    );
    expect(report).toMatchObject({ phase: "finished", requestId: "req-x", tier: "Large" });
  });

  it("reads several blocks in one message", () => {
    const text = [CURRENT_FORMAT, "", "BM-REPORT", "requestId: req-2", "phase: finished"].join("\n");
    const reports = parseReports(text, ctx);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.requestId)).toEqual(["req-20260916T100000Z", "req-2"]);
  });

  it("counts a quoted repeat of the same report only once", () => {
    const quoted = CURRENT_FORMAT.split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const reports = parseReports(`${CURRENT_FORMAT}\n\nEarlier I sent:\n${quoted}`, ctx);
    expect(reports).toHaveLength(1);
  });

  it("stops a block at prose instead of swallowing the rest of the message", () => {
    const [report] = parseReports(
      ["BM-REPORT", "phase: received", "This paragraph is prose.", "beadsCreated: bm-zzz"].join("\n"),
      ctx,
    );
    expect(report?.beadsCreated).toEqual([]);
  });

  it("returns nothing for a message with no block", () => {
    expect(parseReports("just a chat message", ctx)).toEqual([]);
    expect(parseReports("", ctx)).toEqual([]);
  });
});

describe("review parsing", () => {
  it("reads a verdict and blocking count", () => {
    const [review] = parseReviews(
      ["BM-REVIEW", "batchId: batch-1", "verdict: changes-required", "blocking: 2 findings"].join("\n"),
      { agentId: "agent-reviewer", at: ctx.at },
    );
    expect(review).toMatchObject({
      agentId: "agent-reviewer",
      batchId: "batch-1",
      verdict: "changes-required",
      blockingCount: 2,
    });
  });

  it("reads the stop answer whose verdict is on the marker line", () => {
    const [review] = parseReviews("BM-REVIEW STOPPED", { agentId: "agent-reviewer", at: ctx.at });
    expect(review).toMatchObject({ verdict: "STOPPED", batchId: null, blockingCount: null });
  });

  it("reads an approved review with no blocking findings as zero", () => {
    const [review] = parseReviews(
      ["```", "BM-REVIEW", "batchId: batch-2", "verdict: approved", "blocking: none", "```"].join("\n"),
      { agentId: "agent-reviewer", at: ctx.at },
    );
    expect(review).toMatchObject({ verdict: "approved", blockingCount: 0 });
  });

  it("counts blocking findings in the format reviewer.md prescribes", () => {
    // The findings list ends the key/value block, so the count comes from the
    // message. Before this, real reviews always had a null count.
    const [review] = parseReviews(
      [
        "BM-REVIEW",
        "requestId: req-1",
        "batchId: b2",
        "reviewKind: first",
        "verdict: changes-required",
        "checked: src/a.ts",
        "findings:",
        "- severity: blocking",
        "  location: src/a.ts:3",
        "- severity: non-blocking",
        "  location: src/a.ts:9",
        "- severity: blocking",
        "  location: src/a.ts:12",
        "notChecked: none",
      ].join("\n"),
      { agentId: "agent-reviewer", at: ctx.at },
    );
    expect(review).toMatchObject({ batchId: "b2", verdict: "changes-required", blockingCount: 2 });
  });
});

describe("telling a report apart from a user request", () => {
  it("recognises a report block, fenced or quoted", () => {
    expect(looksLikeReport(CURRENT_FORMAT)).toBe(true);
    expect(looksLikeReport("> BM-REPORT\n> phase: finished")).toBe(true);
  });

  it("does not mistake a user request that mentions the word", () => {
    expect(looksLikeReport("please read the BM-REPORT format and follow it")).toBe(false);
    expect(looksLikeReport("thêm màn hình xuất báo cáo")).toBe(false);
  });
});

describe("a BM-QUESTIONS block after the report (delta 20260918c-question-cards)", () => {
  it("reads the report exactly as without the block, fenced or not", () => {
    const report = [
      "BM-REPORT",
      "requestId: req-20260917T010956Z",
      "phase: blocked",
      "tier: Large (changed: no)",
      "filesChanged: docs/a.md",
      "beadsCreated: bm-a, bm-a.1",
      "beadsUpdated: none",
      "beadsClosed: none",
      "beadsReady: bm-a.1",
      "reviewFindingsOpen: none",
      "buildAndTests: not run",
      "skillsUsed: feature-workflow",
      "blockers: 2 questions: Q1, Q2 — see BM-QUESTIONS",
    ].join("\n");
    const questions = [
      "BM-QUESTIONS",
      "requestId: req-20260917T010956Z",
      "Q1: Storage — where?",
      "- a: postgres: no migration. (recommended)",
      "- b: a file: simplest.",
      "Q2: Sessions — rename the cookie?",
      "- a: keep it. (recommended)",
      "- b: rename it.",
    ].join("\n");
    const alone = parseReports(report, ctx);
    expect(alone).toHaveLength(1);
    expect(alone[0]!.unparsedFields).toEqual([]);
    expect(parseReports(`${report}\n\n${questions}`, ctx)).toEqual(alone);
    expect(parseReports(`${report}\n${questions}`, ctx)).toEqual(alone);
    expect(parseReports(`\`\`\`\n${report}\n${questions}\n\`\`\``, ctx)).toEqual(alone);
  });
});

describe("the decided field (owner decision P2-2, 2026-09-24)", () => {
  it("reads none as empty and is empty in a report written before the field existed", () => {
    const withNone = parseReports(["BM-REPORT", "requestId: req-20260924T010000Z", "phase: finished", "decided: none", "blockers: none"].join("\n"), ctx)[0];
    expect(withNone?.decided).toEqual([]);
    expect(parseReports(PRIOR_FORMAT, ctx)[0]?.decided).toEqual([]);
    // "none." and "none — …" are none too, as in blockers (review of P2).
    for (const value of ["none.", "none — nothing to choose"]) {
      expect(parseReports(["BM-REPORT", "requestId: req-20260924T010000Z", `decided: ${value}`].join("\n"), ctx)[0]?.decided, value).toEqual([]);
    }
  });
});
