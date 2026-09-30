import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSESSMENT_CRITERIA, ASSESSMENT_INPUT_SCHEMA, MAX_FINDINGS, MAX_SUGGESTION_CHARS, MAX_SUGGESTIONS, assessmentResultSchema } from "../plugin/shared/bm-assessment";
import { ASSESSMENT_TOOL_INPUT_SCHEMA, toolNamed, toolsFor } from "../plugin/shared/bm-tools";

/**
 * The Orchestrator's `bm_assessment` tool and the schema the assessment reader
 * and the client parse with (Orchestrator design §5.5, REQ-075 c). The tool
 * takes the project's `workspaceId` beside the assessment; the result it
 * returns, and the store keeps, is the assessment alone.
 */

const tool = toolNamed("bm_assessment")!;

function rubric(overrides: Record<number, Record<string, unknown>> = {}) {
  return ASSESSMENT_CRITERIA.map((criterion, index) => ({ criterion, score: index === 5 ? null : 5 - (index % 5), note: `Why ${criterion} got its score.`, ...overrides[index] }));
}
const finding = { severity: "warning", text: "The Worker created beads for a Small request.", evidence: "br create after tier: Small" };
const suggestion = { role: "worker", text: "A request you sized Small gets no bead.", why: "The beads finding." };
const WORKSPACE = "wks_invoice";
const assessment = { rubric: rubric(), findings: [finding], suggestions: [suggestion] };
const valid = { workspaceId: WORKSPACE, ...assessment };
/** `input` as the tool takes it: with the project, when it is an object at all. */
const withWorkspace = (input: unknown): unknown =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? { workspaceId: WORKSPACE, ...input } : input;

describe("bm_assessment", () => {
  it("belongs to the Orchestrator alone, and shows the model its schema", () => {
    expect(tool.role).toBe("orchestrator");
    expect(toolsFor("orchestrator")).toEqual([tool]);
    expect(tool.inputSchema).toBe(ASSESSMENT_TOOL_INPUT_SCHEMA);
    expect(ASSESSMENT_TOOL_INPUT_SCHEMA.required).toEqual(["workspaceId", "rubric"]);
    expect(ASSESSMENT_TOOL_INPUT_SCHEMA.properties).toEqual({ workspaceId: expect.objectContaining({ type: "string" }), ...ASSESSMENT_INPUT_SCHEMA.properties });
    expect(tool.description).toMatch(/workspaceId from bm_projects/);
    expect(tool.description).toMatch(/stores it with the project/);
  });

  it("returns a valid assessment as the BM-ASSESSMENT answer, nulls kept and left-out lists as []", () => {
    const result = tool.run(valid);
    expect(result).toEqual({ ok: true, text: `BM-ASSESSMENT\n${JSON.stringify(assessment)}` });
    const bare = tool.run({ workspaceId: WORKSPACE, rubric: rubric() });
    expect(bare.ok && JSON.parse(bare.text.slice("BM-ASSESSMENT\n".length))).toEqual({ rubric: rubric(), findings: [], suggestions: [] });
    expect(bare.ok && bare.text).toContain('"score":null');
  });

  it("refuses each broken field by its path", () => {
    const issues = (input: unknown) => {
      const result = tool.run(input);
      return result.ok ? [] : result.issues;
    };
    expect(issues({ ...valid, rubric: rubric({ 0: { score: 0 } }) })).toEqual(["input.rubric[0].score: must be one of 1, 2, 3, 4, 5, null"]);
    expect(issues({ ...valid, rubric: rubric({ 1: { score: 2.5 } }) })).toEqual(["input.rubric[1].score: must be an integer or null"]);
    expect(issues({ ...valid, rubric: rubric({ 2: { score: "3" } }) })).toEqual(["input.rubric[2].score: must be an integer or null"]);
    expect(issues({ ...valid, rubric: rubric({ 3: { note: " " } }) })).toEqual(["input.rubric[3].note: must not be empty"]);
    expect(issues({ ...valid, rubric: rubric({ 4: { criterion: "speed" } }) })).toEqual(["input.rubric[4].criterion: must be one of " + ASSESSMENT_CRITERIA.join(", ")]);
    expect(issues({ ...valid, rubric: rubric().slice(0, 5) })).toEqual(["input.rubric: needs at least 6 item(s)"]);
    expect(issues({ ...valid, rubric: rubric({ 5: { criterion: "sizing" } }) })).toEqual([
      "input.rubric: has no entry for review-quality",
      "input.rubric: scores sizing more than once; one entry per criterion",
    ]);
    expect(issues({ ...valid, findings: Array.from({ length: MAX_FINDINGS + 1 }, () => finding) })).toEqual([`input.findings: takes at most ${MAX_FINDINGS} items`]);
    expect(issues({ ...valid, findings: [{ ...finding, severity: "blocking" }] })).toEqual(["input.findings[0].severity: must be one of info, warning, problem"]);
    expect(issues({ ...valid, suggestions: Array.from({ length: MAX_SUGGESTIONS + 1 }, () => suggestion) })).toEqual([`input.suggestions: takes at most ${MAX_SUGGESTIONS} items`]);
    expect(issues({ ...valid, suggestions: [{ ...suggestion, role: "orchestrator" }] })).toEqual(["input.suggestions[0].role: must be one of manager, worker, reviewer"]);
    expect(issues({ ...valid, suggestions: [{ ...suggestion, text: "x".repeat(MAX_SUGGESTION_CHARS + 1) }] })).toEqual([`input.suggestions[0].text: must be at most ${MAX_SUGGESTION_CHARS} characters`]);
    expect(issues({ ...valid, findings: null })).toEqual(["input.findings: must be an array"]);
    expect(issues({ ...valid, verdict: "pass" })).toEqual(["input.verdict: is not a field of this tool"]);
    expect(issues({})).toEqual(["input.workspaceId: is required", "input.rubric: is required"]);
    expect(issues({ ...valid, workspaceId: "../other" })).toEqual(["input.workspaceId: must match ^[A-Za-z0-9._-]{1,128}$"]);
    expect(issues("BM-ASSESSMENT")).toEqual(["input: must be an object"]);
  });
});

describe("the tool and the reader's schema agree", () => {
  const cases: Array<[string, unknown]> = [
    ["valid", assessment],
    ["lists left out", { rubric: rubric() }],
    ["empty lists", { rubric: rubric(), findings: [], suggestions: [] }],
    ["every score null", { rubric: rubric(Object.fromEntries(ASSESSMENT_CRITERIA.map((_, index) => [index, { score: null }]))) }],
    ["suggestion at the cap", { rubric: rubric(), suggestions: [{ ...suggestion, text: "x".repeat(MAX_SUGGESTION_CHARS) }] }],
    ["score out of range", { rubric: rubric({ 0: { score: 6 } }) }],
    ["score as a fraction", { rubric: rubric({ 0: { score: 4.5 } }) }],
    ["score left out", { rubric: rubric().map((entry, index) => (index === 0 ? { criterion: entry.criterion, note: entry.note } : entry)) }],
    ["empty note", { rubric: rubric({ 0: { note: "" } }) }],
    ["a criterion twice", { rubric: rubric({ 5: { criterion: "sizing" } }) }],
    ["seven entries", { rubric: [...rubric(), rubric()[0]] }],
    ["unknown criterion", { rubric: rubric({ 2: { criterion: "speed" } }) }],
    ["extra field in an entry", { rubric: rubric({ 0: { weight: 1 } }) }],
    ["extra top-level field", { ...assessment, summary: "fine" }],
    ["null findings", { rubric: rubric(), findings: null }],
    ["too many findings", { rubric: rubric(), findings: Array.from({ length: MAX_FINDINGS + 1 }, () => finding) }],
    ["bad severity", { rubric: rubric(), findings: [{ ...finding, severity: "blocking" }] }],
    ["finding without evidence", { rubric: rubric(), findings: [{ severity: "info", text: "x" }] }],
    ["too many suggestions", { rubric: rubric(), suggestions: Array.from({ length: MAX_SUGGESTIONS + 1 }, () => suggestion) }],
    ["suggestion over the cap", { rubric: rubric(), suggestions: [{ ...suggestion, text: "x".repeat(MAX_SUGGESTION_CHARS + 1) }] }],
    ["suggestion for the orchestrator", { rubric: rubric(), suggestions: [{ ...suggestion, role: "orchestrator" }] }],
    ["no rubric", { findings: [] }],
    ["not an object", ["rubric"]],
  ];

  it.each(cases)("%s", (_name, input) => {
    const parsed = assessmentResultSchema.safeParse(input);
    expect(tool.run(withWorkspace(input)).ok).toBe(parsed.success);
  });

  it("a parsed result has both lists, and the tool's text parses to it", () => {
    const result = tool.run({ workspaceId: WORKSPACE, rubric: rubric() });
    expect(result.ok).toBe(true);
    const text = result.ok ? result.text : "";
    expect(assessmentResultSchema.parse(JSON.parse(text.slice("BM-ASSESSMENT\n".length)))).toEqual(assessmentResultSchema.parse({ rubric: rubric() }));
    expect(assessmentResultSchema.parse({ rubric: rubric() })).toEqual({ rubric: rubric(), findings: [], suggestions: [] });
  });
});

describe("roles/orchestrator.md's rubric", () => {
  // Since ADR-014 the role file carries no hand-written BM-ASSESSMENT example:
  // nothing reads one any more (Orchestrator design §5.5, §11).
  it("names the tool's criteria in the tool's order, and has no BM-ASSESSMENT fallback block", () => {
    const role = readFileSync(join(import.meta.dirname, "../plugin/roles/orchestrator.md"), "utf8");
    const criteria = [...role.matchAll(/^\| `([a-z-]+)` \|/gm)].map((match) => match[1]);
    expect(criteria).toEqual([...ASSESSMENT_CRITERIA]);
    expect(role).not.toContain("```\nBM-ASSESSMENT");
  });
});
