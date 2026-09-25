/**
 * The agents' tools that build `BM-*` blocks (design delta 20260924b-agent-tools,
 * ADR-010): `bm_report` for a Worker, `bm_review` for a Reviewer, `bm_answers`
 * for a Manager.
 *
 * A tool has no side effect. It checks its input, builds the block the role
 * files show, and returns it for the agent to send verbatim; or it returns one
 * line per problem, so the agent can fix and call again in the same turn.
 *
 * The field rules live here and nowhere else in the agents' instructions:
 * - the tool's JSON Schema — what the model sees — checks the input's shape;
 * - a few rules the schema cannot say (`rules`);
 * - the built text goes through `checkBlocks`, the check every hand-written
 *   block gets, and must come back as exactly the blocks built — so a tool can
 *   never return a block the plugin, a card or the Metric screen would misread.
 * Values are made safe for the block before that: one line per field, no `;`
 * inside a `;`-separated item, no stray recommendation marker in an option.
 *
 * Pure and environment-neutral: no Node API, no React, no Zod (the daemon's
 * copy of Zod is the host's, not ours).
 */
import { checkBlocks, issueText, type BlockKind } from "./bm-format";
import { MAX_OPTIONS } from "./bm-questions";

export type ToolRole = "worker" | "reviewer" | "manager";

export interface JsonSchema {
  type?: "object" | "string" | "array" | "boolean";
  description?: string;
  enum?: readonly string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export type ToolResult = { ok: true; text: string } | { ok: false; issues: string[] };

export interface AgentTool {
  name: string;
  role: ToolRole;
  description: string;
  inputSchema: JsonSchema;
  run(input: unknown): ToolResult;
}

const REQUEST_ID: JsonSchema = { type: "string", pattern: "^req-\\d{8}T\\d{6}Z$", description: "The request id, req-YYYYMMDDTHHMMSSZ." };
const BATCH_ID: JsonSchema = { type: "string", pattern: "^b\\d+$", description: "b1, b2, …" };
const TEXT: JsonSchema = { type: "string", minLength: 1 };
const PROSE: JsonSchema = { type: "string", minLength: 1, maxLength: 4000 };
const TIERS = ["Small", "Medium", "Large"] as const;
const QUESTION_ID: JsonSchema = { type: "string", pattern: "^Q[1-9]\\d{0,2}$", description: "Q1, Q2, … counted across the whole request." };
/** What the question reader takes for a recommendation, anywhere in an option. */
const RECOMMENDED_MARK = /[([]\s*recommended\s*[)\]]/i;

// ---------------------------------------------------------------------------
// The one JSON Schema check the tools need: the subset they use, nothing more.
// ---------------------------------------------------------------------------

function typeOf(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

/** Problems of `value` against `schema`, one line each, named by path. */
export function schemaIssues(schema: JsonSchema, value: unknown, path = "input"): string[] {
  if (schema.type !== undefined && typeOf(value) !== schema.type) {
    return [`${path}: must be ${schema.type === "array" || schema.type === "object" ? "an" : "a"} ${schema.type}`];
  }
  const out: string[] = [];
  if (typeof value === "string") {
    if (schema.enum !== undefined && !schema.enum.includes(value)) out.push(`${path}: must be one of ${schema.enum.join(", ")}`);
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) out.push(`${path}: must not be empty`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: must be at most ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`${path}: must match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: takes at most ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, index) => out.push(...schemaIssues(schema.items!, item, `${path}[${index}]`)));
  }
  if (schema.type === "object" && typeOf(value) === "object") {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (record[key] === undefined) out.push(`${path}.${key}: is required`);
    for (const [key, item] of Object.entries(record)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) out.push(`${path}.${key}: is not a field of this tool`);
        continue;
      }
      out.push(...schemaIssues(properties[key]!, item, `${path}.${key}`));
    }
  }
  return out;
}

/** The input path of a block field the format check names: `Q3` is a question, `finding 2` a finding. */
function inputPath(field: string): string {
  if (/^Q\d+$/.test(field)) return `questions (${field})`;
  const finding = /^finding (\d+)$/.exec(field);
  return finding === null ? field : `findings[${Number(finding[1]) - 1}]`;
}

/** Paths of the string values that read as the template's own placeholders: `<…>`, or `a | b`. */
function placeholderPaths(value: unknown, path = "input"): string[] {
  if (typeof value === "string") return /^\s*<[^>]*>\s*$/.test(value) || /\S\s*\|\s*\S/.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => placeholderPaths(entry, `${path}[${index}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => placeholderPaths(entry, `${path}.${key}`));
  return [];
}

/**
 * `value` without its `null` (or `undefined`) fields: a model often sends
 * `null` for a field it leaves out, and a caller in code writes `undefined`.
 */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null).map(([key, item]) => [key, withoutNulls(item)]));
}

// ---------------------------------------------------------------------------
// Making values safe for a block.
// ---------------------------------------------------------------------------

/**
 * Every field is one line: a newline inside a value would end it. The
 * suggestion marker is the Manager's count of suggestions, so outside the
 * suggestions it is written plainly.
 */
function line(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").replace(SUGGESTION_MARK, "suggestion:").trim();
}

/**
 * One item of a `;`-separated list: no `;` of its own, and parentheses only in
 * pairs — the reader splits on `;` outside parentheses, so either would cut the
 * item in two or swallow the next one.
 */
function item(text: string): string {
  const flat = line(text).replace(/;/g, ",");
  let depth = 0;
  for (const character of flat) {
    depth += character === "(" ? 1 : character === ")" ? -1 : 0;
    if (depth < 0) break;
  }
  return depth === 0 ? flat : flat.replace(/[()]/g, "");
}

/**
 * A list field: one line per entry, `none` when empty. A value that merely
 * starts with the word "none" would read as empty, so that word is quoted.
 */
function list(items: readonly string[] | undefined, separator = ", "): string {
  // Duplicates go, as the readers drop them: a bead closed twice is closed once.
  const kept = [...new Set((items ?? []).map(line))];
  return kept.length === 0 ? "none" : kept.join(separator).replace(/^none\b/i, (word) => `"${word}"`);
}

/** What a model writes for "nothing waits". */
const NOTHING = /^(?:none|nothing|n\/a|-+)\.?$/i;
const SUGGESTION_MARK = /suggestion \(not done\):/gi;

/**
 * A prose value that may run over several lines: every line after the first is
 * indented. Code fences and quote marks go, because the block reader takes
 * them for its own structure.
 */
function prose(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((part) => !/^\s*(?:```|~~~)/.test(part))
    .map((part) => part.replace(/^\s*(?:>\s*)+/, "").trim())
    .filter((part) => part !== "")
    // A line that is a block marker would start a block of its own.
    .map((part) => (/^(?:[-*]\s+)?\**BM-[A-Z]+\b/.test(part) ? `\`${part}\`` : part));
  return lines.map((part, index) => (index === 0 ? part : `  ${part}`)).join("\n");
}

// ---------------------------------------------------------------------------
// One way to run every tool.
// ---------------------------------------------------------------------------

interface ToolSpec<T> {
  name: string;
  role: ToolRole;
  description: string;
  inputSchema: JsonSchema;
  /** Rules the schema cannot say; one line per problem. */
  rules?: (input: T) => string[];
  build: (input: T) => string;
  /** The blocks `build` writes for this input, in order. */
  kinds: (input: T) => BlockKind[];
}

const SEND = "Arguments are JSON: leave out a field you have nothing for. Returns the block; send it verbatim, as the whole block, in the message you were going to send. On error, fix the listed fields and call again.";

function tool<T>(spec: ToolSpec<T>): AgentTool {
  return {
    name: spec.name,
    role: spec.role,
    description: `${spec.description} ${SEND}`,
    inputSchema: spec.inputSchema,
    run(raw) {
      const input = withoutNulls(raw);
      const shape = schemaIssues(spec.inputSchema, input);
      if (shape.length > 0) return { ok: false, issues: shape };
      const broken = spec.rules?.(input as T) ?? [];
      if (broken.length > 0) return { ok: false, issues: broken };
      const text = spec.build(input as T);
      const checked = checkBlocks(text);
      // Named by the input field, as every other refusal is: "BM-REPORT tier: …" → "input.tier: …".
      const issues = checked.flatMap((block) => block.issues.map((issue) => (issue.field === null ? issueText(issue) : `input.${inputPath(issue.field)}: ${issue.message}`)));
      if (issues.length > 0) return { ok: false, issues };
      // A block the checker skipped (a value that looks like a format example) is not a block the plugin reads.
      const expected = spec.kinds(input as T);
      if (checked.map((block) => block.kind).join(",") !== expected.join(",")) {
        const paths = placeholderPaths(input);
        return { ok: false, issues: (paths.length > 0 ? paths : ["input"]).map((path) => `${path}: reads as a template placeholder ("<…>" or "a | b"); write it plainly`) };
      }
      return { ok: true, text };
    },
  };
}

// ---------------------------------------------------------------------------
// bm_report — BM-REPORT, and BM-QUESTIONS when blocked (worker.md).
// ---------------------------------------------------------------------------

interface ReportInput {
  requestId: string;
  phase: "received" | "beads-done" | "blocked" | "finished";
  tier: { level: (typeof TIERS)[number]; changedFrom?: (typeof TIERS)[number]; reason?: string; note?: string };
  filesChanged?: string[];
  beadsCreated?: string[];
  beadsUpdated?: string[];
  beadsClosed?: string[];
  beadsReady?: string[];
  reviewFindingsOpen?: Array<{ batchId: string; finding: string }>;
  buildAndTests: string;
  skillsUsed?: string[];
  decided?: Array<{ choice: string; why: string }>;
  blockers?: string;
  suggestions?: string[];
  questions?: Array<{ id: string; text: string; options: Array<{ text: string; recommended?: boolean }> }>;
}

/** Empty is `[]` or left out; a model used to the text template writes `none`, which is not JSON (live run, 2026-09-24). */
const EMPTY = "Leave it out or [] when there are none; never the word none.";
const BEAD_IDS: JsonSchema = {
  type: "array",
  items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9.-]*$", description: "A full bead id, as br prints it." },
  description: `Full bead ids. ${EMPTY}`,
};

const REPORT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "phase", "tier", "buildAndTests"],
  properties: {
    requestId: REQUEST_ID,
    phase: { type: "string", enum: ["received", "beads-done", "blocked", "finished"] },
    tier: {
      type: "object",
      additionalProperties: false,
      required: ["level"],
      description: "The size of the change you design. changedFrom and reason only when the tier changed since your last report.",
      properties: {
        level: { type: "string", enum: TIERS },
        changedFrom: { type: "string", enum: TIERS },
        reason: { ...TEXT, description: "Why the tier changed; required with changedFrom." },
        note: { ...TEXT, description: "A short note after the tier." },
      },
    },
    filesChanged: { type: "array", items: TEXT, description: `Paths changed so far. ${EMPTY}` },
    beadsCreated: BEAD_IDS,
    beadsUpdated: BEAD_IDS,
    beadsClosed: BEAD_IDS,
    beadsReady: BEAD_IDS,
    reviewFindingsOpen: {
      type: "array",
      description: `Review findings still open. ${EMPTY}`,
      items: { type: "object", additionalProperties: false, required: ["batchId", "finding"], properties: { batchId: BATCH_ID, finding: TEXT } },
    },
    buildAndTests: { ...TEXT, description: "Commands run and pass/fail, or \"not run\"." },
    skillsUsed: {
      type: "array",
      items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "A skill name, such as feature-workflow; no notes." },
      description: `Skills you loaded for this request so far, not the ones you plan to. ${EMPTY}`,
    },
    decided: {
      type: "array",
      description: `Choices you made on your own that the user may want to overturn. ${EMPTY}`,
      items: { type: "object", additionalProperties: false, required: ["choice", "why"], properties: { choice: TEXT, why: TEXT } },
    },
    blockers: { ...TEXT, description: "Only what waits for the user; omit when nothing does. When blocked, the tool writes the questions line itself." },
    suggestions: { type: "array", items: TEXT, description: `What you noticed but did not do: extra tests, refactors, docs, cleanups, related bugs, other beads. ${EMPTY}` },
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      description: "Required when phase is blocked, and only then. The tool letters the options a, b, c and marks the recommended one.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "options"],
        properties: {
          id: QUESTION_ID,
          text: { ...TEXT, description: "The topic, then the question." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: { text: { ...TEXT, description: "The option and what it costs." }, recommended: { type: "boolean", description: "True on exactly one option." } },
            },
          },
        },
      },
    },
  },
};

/** Words inside or after the tier's parentheses: paired parentheses, starting with a word. */
function tierWords(text: string): string {
  return item(text).replace(/^[\s,;:.—–-]+/, "").replace(/[()]/g, (mark) => (mark === "(" ? "[" : "]"));
}

function tierText(tier: ReportInput["tier"]): string {
  const changed = tier.changedFrom === undefined ? "no" : `from ${tier.changedFrom}, ${tierWords(tier.reason ?? "")}`;
  const note = tier.note === undefined ? "" : tierWords(tier.note);
  return `${tier.level} (changed: ${changed})${note === "" ? "" : ` — ${note}`}`;
}

/**
 * What `blockers` holds and what it only suggests. A Worker used to the text
 * template writes its suggestions into `blockers` ("none. Suggestion (not
 * done): …"): they are moved to the suggestions, so they are counted once.
 */
function splitBlockers(blockers: string | undefined): { waits: string | null; suggested: string[] } {
  if (blockers === undefined) return { waits: null, suggested: [] };
  const [head = "", ...rest] = blockers.replace(/\s*\r?\n\s*/g, " ").split(SUGGESTION_MARK);
  const waits = head.replace(/[\s.;,]+$/, "").trim();
  return { waits: waits === "" || NOTHING.test(waits) ? null : line(waits), suggested: rest.map((part) => part.replace(/^[\s.;,]+|[\s.;,]+$/g, "")).filter((part) => part !== "") };
}

function blockersText(input: ReportInput): string {
  const ids = (input.questions ?? []).map((question) => question.id);
  const asked = input.phase === "blocked" ? `${ids.length} ${ids.length === 1 ? "question" : "questions"}: ${ids.join(", ")} — see BM-QUESTIONS` : null;
  const { waits: own, suggested: fromBlockers } = splitBlockers(input.blockers);
  const suggested = [...fromBlockers, ...(input.suggestions ?? [])]
    .map((entry) => item(entry.replace(/^\s*suggestion \(not done\):\s*/i, "")))
    .filter((entry) => entry !== "")
    .map((entry) => `Suggestion (not done): ${entry}`);
  // "none" first when nothing waits: that is how the card and the Metric screen tell "done" from "waiting".
  const head = [asked, own].filter((part) => part !== null).join(". ") || "none";
  return suggested.length === 0 ? head : `${head}. ${suggested.join("; ")}`;
}

function buildReport(input: ReportInput): string {
  const lines = [
    "BM-REPORT",
    `requestId: ${input.requestId}`,
    `phase: ${input.phase}`,
    `tier: ${tierText(input.tier)}`,
    `filesChanged: ${list(input.filesChanged)}`,
    `beadsCreated: ${list(input.beadsCreated)}`,
    `beadsUpdated: ${list(input.beadsUpdated)}`,
    `beadsClosed: ${list(input.beadsClosed)}`,
    `beadsReady: ${list(input.beadsReady)}`,
    `reviewFindingsOpen: ${list((input.reviewFindingsOpen ?? []).map((open) => `${open.batchId}: ${item(open.finding)}`), "; ")}`,
    `buildAndTests: ${line(input.buildAndTests)}`,
    `skillsUsed: ${list(input.skillsUsed)}`,
    `decided: ${list((input.decided ?? []).map((entry) => `${item(entry.choice)} — ${item(entry.why)}`), "; ")}`,
    `blockers: ${blockersText(input)}`,
  ];
  if (input.phase !== "blocked") return lines.join("\n");
  const asked = ["BM-QUESTIONS", `requestId: ${input.requestId}`];
  for (const question of input.questions ?? []) {
    asked.push(`${question.id}: ${line(question.text)}`);
    question.options.forEach((option, index) => {
      asked.push(`- ${String.fromCharCode(97 + index)}: ${line(option.text)}${option.recommended === true ? " (recommended)" : ""}`);
    });
  }
  return `${lines.join("\n")}\n\n${asked.join("\n")}`;
}

function reportRules(input: ReportInput): string[] {
  const out: string[] = [];
  const { tier } = input;
  if (tier.changedFrom !== undefined && tier.reason === undefined) out.push("input.tier.reason: is required with changedFrom");
  if (tier.changedFrom === undefined && tier.reason !== undefined) out.push("input.tier.reason: only with changedFrom; put other words in note");
  if (tier.changedFrom !== undefined && tier.changedFrom === tier.level) out.push("input.tier.changedFrom: equals level; leave it out when the tier did not change");
  if (input.phase === "blocked" && (input.questions ?? []).length === 0) out.push("input.questions: a blocked report needs its questions");
  if (input.phase !== "blocked" && input.questions !== undefined) out.push("input.questions: only a blocked report asks; put anything else in blockers");
  (input.questions ?? []).forEach((question, q) =>
    question.options.forEach((option, o) => {
      if (RECOMMENDED_MARK.test(option.text)) out.push(`input.questions[${q}].options[${o}].text: leave out "(recommended)"; set recommended: true instead`);
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// bm_review — BM-REVIEW (reviewer.md). The verdict follows from the findings.
// ---------------------------------------------------------------------------

interface ReviewInput {
  requestId: string;
  batchId: string;
  reviewKind: "first" | "re-review";
  checked: string;
  findings?: Array<{ severity: "blocking" | "non-blocking"; location: string; reason: string; suggestedFix: string }>;
  notChecked: string;
}

const REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "batchId", "reviewKind", "checked", "notChecked"],
  properties: {
    requestId: REQUEST_ID,
    batchId: BATCH_ID,
    reviewKind: { type: "string", enum: ["first", "re-review"] },
    checked: { ...PROSE, description: "What you read and ran: document paths, bead ids, diff paths, test results, abuse cases tried. May run over several lines." },
    findings: {
      type: "array",
      description: `The tool writes the verdict: changes-required when one is blocking, pass otherwise. ${EMPTY}`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "location", "reason", "suggestedFix"],
        properties: {
          severity: { type: "string", enum: ["blocking", "non-blocking"] },
          location: { ...TEXT, description: "file:line, a bead id, or a document heading." },
          reason: { ...TEXT, description: "Why this is a problem, in one sentence." },
          suggestedFix: { ...TEXT, description: "What the Worker should change, in one sentence." },
        },
      },
    },
    notChecked: { ...PROSE, description: "What in the scope you could not check, and why; \"none\" if nothing." },
  },
};

function buildReview(input: ReviewInput): string {
  const findings = input.findings ?? [];
  const lines = [
    "BM-REVIEW",
    `requestId: ${input.requestId}`,
    `batchId: ${input.batchId}`,
    `reviewKind: ${input.reviewKind}`,
    `verdict: ${findings.some((finding) => finding.severity === "blocking") ? "changes-required" : "pass"}`,
    `checked: ${prose(input.checked)}`,
    findings.length === 0 ? "findings: none" : "findings:",
  ];
  for (const finding of findings) {
    lines.push(`- severity: ${finding.severity}`, `  location: ${line(finding.location)}`, `  reason: ${line(finding.reason)}`, `  suggestedFix: ${line(finding.suggestedFix)}`);
  }
  lines.push(`notChecked: ${prose(input.notChecked)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// bm_answers — BM-ANSWERS (manager.md).
// ---------------------------------------------------------------------------

interface AnswersInput {
  requestId: string;
  answers: Array<{ id: string; option?: string; optionText?: string; other?: string }>;
}

const ANSWERS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "answers"],
  properties: {
    requestId: REQUEST_ID,
    answers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        description: "Either option with optionText (the option as the Worker wrote it), or other with the user's own words, or a fact you verified, named with its source.",
        properties: { id: QUESTION_ID, option: { type: "string", pattern: "^[a-z]$" }, optionText: TEXT, other: TEXT },
      },
    },
  },
};

function answersRules(input: AnswersInput): string[] {
  return input.answers.flatMap((answer, index) => {
    const path = `input.answers[${index}]`;
    if (answer.other !== undefined) return answer.option === undefined && answer.optionText === undefined ? [] : [`${path}: give option with optionText, or other, not both`];
    if (answer.option === undefined) return [`${path}: needs option with optionText, or other`];
    return answer.optionText === undefined ? [`${path}.optionText: is required with option`] : [];
  });
}

function buildAnswers(input: AnswersInput): string {
  const lines = ["BM-ANSWERS", `requestId: ${input.requestId}`];
  for (const answer of input.answers) {
    lines.push(answer.other !== undefined ? `${answer.id}: other — ${line(answer.other)}` : `${answer.id}: ${answer.option} — ${line(answer.optionText ?? "")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

export const AGENT_TOOLS: readonly AgentTool[] = [
  tool<ReportInput>({
    name: "bm_report",
    role: "worker",
    description: "Build your BM-REPORT (and its BM-QUESTIONS when blocked).",
    inputSchema: REPORT_SCHEMA,
    rules: reportRules,
    build: buildReport,
    kinds: (input) => (input.phase === "blocked" ? ["BM-REPORT", "BM-QUESTIONS"] : ["BM-REPORT"]),
  }),
  tool<ReviewInput>({
    name: "bm_review",
    role: "reviewer",
    description: "Build your BM-REVIEW.",
    inputSchema: REVIEW_SCHEMA,
    rules: (input) =>
      (["checked", "notChecked"] as const)
        .filter((key) => prose(input[key]) === "")
        .map((key) => `input.${key}: has no text once code fences and quote marks are removed`),
    build: buildReview,
    kinds: () => ["BM-REVIEW"],
  }),
  tool<AnswersInput>({
    name: "bm_answers",
    role: "manager",
    description: "Build the BM-ANSWERS block that answers a Worker: the user's answers, or a fact you verified yourself.",
    inputSchema: ANSWERS_SCHEMA,
    rules: answersRules,
    build: buildAnswers,
    kinds: () => ["BM-ANSWERS"],
  }),
];

export function toolsFor(role: ToolRole): AgentTool[] {
  return AGENT_TOOLS.filter((candidate) => candidate.role === role);
}

export function toolNamed(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((candidate) => candidate.name === name);
}
