/**
 * The agents' tools that build `BM-*` blocks (design delta 20260924b-agent-tools,
 * ADR-010): `bm_report` for a Worker, `bm_review` for a Reviewer, `bm_answers`
 * for a Manager, and `bm_assessment` for the Orchestrator (Orchestrator design
 * §5.5), whose schema lives in `shared/bm-assessment.ts`.
 *
 * The Orchestrator's other tools (design §5.2–§5.3, §6A, §6B.4: `bm_projects`,
 * `bm_request`, `bm_agent_messages`, `bm_send_command`, `bm_decisions`,
 * `bm_ask_owner`, `bm_set_autopilot`, `bm_direct_worker`, `bm_repo`,
 * `bm_note`) read plugin data and repositories, record decisions, commands
 * and notes, and send commands, so they cannot be pure: only their
 * faces — name, description, input schema — live here
 * (`ORCHESTRATOR_SERVER_TOOLS`), and `server/orchestrator-tools.ts` runs them.
 * The Manager's `bm_decisions` (autonomy design §A.9) reads the decision store,
 * so it is a server-run face too (`MANAGER_SERVER_TOOLS`, run by
 * `server/decision-tools.ts`); it only reads. `toolFacesFor` is what an
 * endpoint lists and the creation hook pre-approves.
 *
 * A block tool has no side effect. It checks its input, builds the block the role
 * files show, and returns it for the agent to send verbatim; or it returns one
 * line per problem, so the agent can fix and call again in the same turn.
 *
 * The field rules live here and nowhere else in the agents' instructions:
 * - the tool's JSON Schema — what the model sees — checks the input's shape;
 * - a few rules the schema cannot say (`rules`);
 * - the built text goes through `checkBlocks`, the check every hand-written
 *   block gets, and must come back as exactly the blocks built — so a tool can
 *   never return a block the plugin, a card or Work's timeline would misread.
 * Values are made safe for the block before that: one line per field, no `;`
 * inside a `;`-separated item, no stray recommendation marker in an option.
 *
 * Pure and environment-neutral: no Node API, no React, and no tool schema or
 * check built with Zod (the daemon's copy of Zod is the host's, not ours).
 */
import { checkBlocks, issueText, type BlockKind } from "./bm-format";
import { ASSESSMENT_BLOCK, ASSESSMENT_INPUT_SCHEMA, rubricIssues } from "./bm-assessment";
import { MAX_OPTIONS, MAX_SUBJECT_CHARS } from "./bm-questions";
import { DECISION_STATUSES, EFFECTS, SUBJECT_PATTERN } from "./decisions";
import {
  MAX_DECISION_OPTIONS,
  MAX_DECISION_OPTION_CHARS,
  MAX_DECISION_QUESTION_CHARS,
  MAX_DECISION_RECOMMENDATION_CHARS,
  MAX_NOTE_CHARS,
} from "./orchestrator";
import { COMMAND_INTENTS, MAX_COMMAND_BODY_CHARS, MAX_COMMAND_DECISION_ID_CHARS, MAX_COMMAND_RE_CHARS, MAX_COMMAND_WHY_CHARS } from "./orchestrator-command";

export type ToolRole = "worker" | "reviewer" | "manager" | "orchestrator";

type JsonType = "object" | "string" | "array" | "boolean" | "integer" | "null";

export interface JsonSchema {
  /** One type, or several (`["integer", "null"]`). */
  type?: JsonType | readonly JsonType[];
  description?: string;
  enum?: readonly (string | number | null)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export type ToolResult = { ok: true; text: string } | { ok: false; issues: string[] };

/** What `tools/list` shows of a tool, and what the creation hook pre-approves. */
export interface ToolFace {
  name: string;
  role: ToolRole;
  description: string;
  inputSchema: JsonSchema;
}

export interface AgentTool extends ToolFace {
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

function isType(type: JsonType, value: unknown): boolean {
  return type === "integer" ? Number.isInteger(value) : typeOf(value) === type;
}

function typeName(type: JsonType): string {
  return type === "null" ? "null" : `${type === "array" || type === "object" || type === "integer" ? "an" : "a"} ${type}`;
}

/** Problems of `value` against `schema`, one line each, named by path. */
export function schemaIssues(schema: JsonSchema, value: unknown, path = "input"): string[] {
  if (schema.type !== undefined) {
    const types: readonly JsonType[] = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!types.some((type) => isType(type, value))) return [`${path}: must be ${types.map(typeName).join(" or ")}`];
  }
  const out: string[] = [];
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | null)) out.push(`${path}: must be one of ${schema.enum.map(String).join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
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

interface BlockToolSpec<T> {
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

function tool<T>(spec: BlockToolSpec<T>): AgentTool {
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
  questions?: Array<{
    id: string;
    text: string;
    subject?: string;
    supersedes?: string;
    options: Array<{ text: string; recommended?: boolean; effects?: Array<(typeof EFFECTS)[number]> }>;
  }>;
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
          subject: {
            type: "string",
            pattern: "^[a-z0-9-]+$",
            maxLength: MAX_SUBJECT_CHARS,
            description: `A short slug naming what is decided, such as push-backends: lowercase letters, digits and -, at most ${MAX_SUBJECT_CHARS} characters. Keep it when you ask the same thing again.`,
          },
          supersedes: { ...QUESTION_ID, description: "The earlier question of this request that this one asks again, such as Q2; leave it out for a new question." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: {
                text: { ...TEXT, description: "The option and what it costs." },
                recommended: { type: "boolean", description: "True on exactly one option." },
                effects: {
                  type: "array",
                  maxItems: EFFECTS.length,
                  items: { type: "string", enum: EFFECTS },
                  description: "What choosing this option lets you do beyond the workspace or the undoable, such as push or migration; [\"none\"] when it does nothing of the kind. Leave it out when unsure.",
                },
              },
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
  // "none" first when nothing waits: that is how the card and Work's request tell "done" from "waiting".
  const head = [asked, own].filter((part) => part !== null).join(". ") || "none";
  return suggested.length === 0 ? head : `${head}. ${suggested.join("; ")}`;
}

/**
 * A question or option on one line, with any `[name: value]` of its own
 * written in parentheses: the questions reader takes a bracketed tag at the
 * end of the line for the block's own `subject`, `supersedes` or `effects`.
 */
function tagFree(text: string): string {
  return line(text).replace(/\[(\s*[a-z][a-z-]*\s*:[^\][]*)\]/gi, "($1)");
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
  // Tags in the documented order (autonomy design §A.5): subject, supersedes; "(recommended)" before effects.
  for (const question of input.questions ?? []) {
    const subject = question.subject === undefined ? "" : ` [subject: ${question.subject}]`;
    const supersedes = question.supersedes === undefined ? "" : ` [supersedes: ${question.supersedes}]`;
    asked.push(`${question.id}: ${tagFree(question.text)}${subject}${supersedes}`);
    question.options.forEach((option, index) => {
      const effects = [...new Set(option.effects ?? [])];
      const tag = effects.length === 0 ? "" : ` [effects: ${effects.join(", ")}]`;
      asked.push(`- ${String.fromCharCode(97 + index)}: ${tagFree(option.text)}${option.recommended === true ? " (recommended)" : ""}${tag}`);
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
  (input.questions ?? []).forEach((question, q) => {
    const number = (id: string) => Number.parseInt(id.slice(1), 10);
    if (question.supersedes !== undefined && number(question.supersedes) >= number(question.id)) {
      out.push(`input.questions[${q}].supersedes: must be an earlier question of this request than ${question.id}`);
    }
    question.options.forEach((option, o) => {
      if (RECOMMENDED_MARK.test(option.text)) out.push(`input.questions[${q}].options[${o}].text: leave out "(recommended)"; set recommended: true instead`);
      if ((option.effects ?? []).includes("none") && new Set(option.effects).size > 1) {
        out.push(`input.questions[${q}].options[${o}].effects: "none" stands alone; leave it out when the option has effects`);
      }
    });
  });
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

// bm_assessment — the Orchestrator's workflow assessment (orchestrator.md, design §5.5).
// ---------------------------------------------------------------------------

/**
 * The same rules as `WORKSPACE_ID_PATTERN` of `server/trace-store.ts`, which
 * this module cannot import: a workspace id the stores would refuse is refused
 * here first, by its path.
 */
export const WORKSPACE_ID_SOURCE = "^[A-Za-z0-9._-]{1,128}$";
const WORKSPACE_ID: JsonSchema = { type: "string", pattern: WORKSPACE_ID_SOURCE, description: "The workspace id bm_projects gave for the project." };

/** The assessment's own shape (`ASSESSMENT_INPUT_SCHEMA`) plus the project it is about. */
export const ASSESSMENT_TOOL_INPUT_SCHEMA: JsonSchema = {
  ...ASSESSMENT_INPUT_SCHEMA,
  required: ["workspaceId", ...(ASSESSMENT_INPUT_SCHEMA.required ?? [])],
  properties: { workspaceId: WORKSPACE_ID, ...ASSESSMENT_INPUT_SCHEMA.properties },
};

/**
 * Not built through `tool()`: it writes no block the other readers know, and a
 * `null` score means "not enough data", so nulls are kept, not dropped. The
 * pure part checks the input and returns the result — without `workspaceId` —
 * as the `BM-ASSESSMENT` text; the Orchestrator's endpoint
 * (`server/orchestrator-tools.ts`) runs it and then records that result in
 * the workspace's assessment store.
 */
const assessmentTool: AgentTool = {
  name: "bm_assessment",
  role: "orchestrator",
  description:
    "Record your assessment of one project's workflow (workspaceId from bm_projects): every criterion scored once, your findings and your recommendations. Arguments are JSON. The plugin stores it with the project; call it once per assessment. On error, fix the listed fields and call again.",
  inputSchema: ASSESSMENT_TOOL_INPUT_SCHEMA,
  run(input) {
    const shape = schemaIssues(ASSESSMENT_TOOL_INPUT_SCHEMA, input);
    if (shape.length > 0) return { ok: false, issues: shape };
    const broken = rubricIssues(input);
    if (broken.length > 0) return { ok: false, issues: broken };
    const { rubric, findings = [], suggestions = [] } = input as { rubric: unknown[]; findings?: unknown[]; suggestions?: unknown[] };
    return { ok: true, text: `${ASSESSMENT_BLOCK}\n${JSON.stringify({ rubric, findings, suggestions })}` };
  },
};

// ---------------------------------------------------------------------------
// The Orchestrator's server-run tools (design §5.2, §5.3, §6A): faces only.
// ---------------------------------------------------------------------------

/** `bm_projects`' window, in hours (design §5.2). */
export const PROJECTS_SINCE_HOURS = { min: 1, max: 168, default: 24 } as const;
/** `bm_agent_messages`' count (design §5.2); with `detail: "full"`, `default` when no `limit` is given. */
export const AGENT_MESSAGES_LIMIT = { min: 1, max: 50, default: 20 } as const;
/**
 * How much `bm_projects`, `bm_request` and `bm_agent_messages` return
 * (autonomy design §A.9): a bounded summary by default, today's limits with
 * `full`.
 */
export const READ_DETAILS = ["summary", "full"] as const;
export type ReadDetail = (typeof READ_DETAILS)[number];
/** The most characters `bm_request` returns by default, its bounded note included (autonomy design §A.9). */
export const REQUEST_SUMMARY_MAX_CHARS = 4_000;
/** `bm_agent_messages` by default (autonomy design §A.9): at most this many messages, each at most this long. */
export const AGENT_MESSAGES_SUMMARY = { count: 5, maxChars: 1_500 } as const;
/** What `bm_repo` can run (design §6B.4); each is a fixed read-only git command. */
export const REPO_ACTIONS = ["status", "diff-stat", "log", "show"] as const;
export type RepoAction = (typeof REPO_ACTIONS)[number];
/** How many decisions `bm_decisions` returns (autonomy design §A.9): newest asked first. */
export const DECISIONS_TOOL_LIMIT = { min: 1, max: 50, default: 20 } as const;
/** `bm_decisions`' status filter: one status, or `unsettled` for `open` and `needs-confirmation` together. */
export const DECISIONS_TOOL_STATUSES = [...DECISION_STATUSES, "unsettled"] as const;
export type DecisionsToolStatus = (typeof DECISIONS_TOOL_STATUSES)[number];
/** The most options `bm_ask_owner` takes (design §6B.4). */
export const ASK_OWNER_OPTIONS = MAX_DECISION_OPTIONS;

const ID: JsonSchema = { type: "string", minLength: 1, maxLength: 200 };

function detailOf(summary: string, full: string): JsonSchema {
  return { type: "string", enum: READ_DETAILS, description: `"summary" (default): ${summary}. "full": ${full}.` };
}

export const ORCHESTRATOR_SERVER_TOOLS: readonly ToolFace[] = [
  {
    name: "bm_projects",
    role: "orchestrator",
    description:
      "Where paseo-bm work stands on this machine: each project (workspace) with activity in the period and its Manager(s). By default only counts (requests by state, waiting on the owner, with signals, open stall situations, your notes) and the owner's open decisions; with detail: \"full\", up to 10 recent requests with their size, state, what they wait on, the plugin's signals and open stall situations, and your notes about the project (bm_note). Read-only. Returns JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sinceHours: {
          type: "integer",
          minimum: PROJECTS_SINCE_HOURS.min,
          maximum: PROJECTS_SINCE_HOURS.max,
          description: `How far back to look, in hours: ${PROJECTS_SINCE_HOURS.min}-${PROJECTS_SINCE_HOURS.max}, default ${PROJECTS_SINCE_HOURS.default}.`,
        },
        detail: detailOf("counts and open decisions per project", "each recent request, its signals and stalls, and your notes"),
      },
    },
  },
  {
    name: "bm_request",
    role: "orchestrator",
    description:
      "One request, redacted: what the user asked, the Worker's reports, the reviews, the Manager's replies, the user's messages, and the plugin's signals. At most 4,000 characters by default, the longest messages cut first; detail: \"full\" for up to 60,000. Read-only. Returns text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "requestId"],
      properties: {
        workspaceId: WORKSPACE_ID,
        requestId: { ...ID, description: "The requestId bm_projects gave (its traceId when the request has no requestId)." },
        detail: detailOf("at most 4,000 characters, its longest messages cut first", "up to 60,000 characters"),
      },
    },
  },
  {
    name: "bm_agent_messages",
    role: "orchestrator",
    description:
      "The most recent messages of one paseo-bm agent (a Manager, Worker or Reviewer), oldest first, redacted. By default at most 5 messages of at most 1,500 characters each; detail: \"full\" for up to 50 of 12,000 characters each: the full text of a pending question and its options, for example. Read-only. Returns JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentId"],
      properties: {
        agentId: { ...ID, description: "The agent's id, as bm_projects gave it." },
        limit: {
          type: "integer",
          minimum: AGENT_MESSAGES_LIMIT.min,
          maximum: AGENT_MESSAGES_LIMIT.max,
          description: `How many messages: ${AGENT_MESSAGES_LIMIT.min}-${AGENT_MESSAGES_SUMMARY.count} by default (default ${AGENT_MESSAGES_SUMMARY.count}); with detail "full", ${AGENT_MESSAGES_LIMIT.min}-${AGENT_MESSAGES_LIMIT.max} (default ${AGENT_MESSAGES_LIMIT.default}).`,
        },
        detail: detailOf("at most 5 messages of 1,500 characters each", "up to 50 messages of 12,000 characters each"),
      },
    },
  },
  {
    name: "bm_send_command",
    role: "orchestrator",
    description:
      "Send a command to a project's Manager now, in the language of that Manager's conversation with the owner. Allowed with Autopilot on for the project, right after the owner's own message in your chat telling you to send, or with decisionId: a decision of yours the owner answered; otherwise refused: ask the owner with bm_ask_owner, and prepare the command on an option. Declare its intent and every effect it allows: Autopilot and the owner's word in your chat cover any effect but push, publish, deploy, real-data, migration, security and cost, which only the grant of an answered decision covers (one command, within an hour of the answer). A text that shows an effect you did not declare (a release, security, data, cost or dependency) is refused: declare it or ask the owner with bm_ask_owner. The plugin delivers a BM-COMMAND block with the authority, the approved effects and the limits that remain.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "managerId", "intent", "effects", "command", "reason"],
      properties: {
        workspaceId: WORKSPACE_ID,
        managerId: { ...ID, description: "The Manager's agent id, as bm_projects gave it." },
        requestId: { ...ID, description: "The request it is about, when it is about one." },
        re: { type: "string", minLength: 1, maxLength: MAX_COMMAND_RE_CHARS, description: "The subject, one line (for example: answer to Q2). Defaults to the command's first line." },
        intent: { type: "string", enum: COMMAND_INTENTS, description: "What the command is for: answer, continue, redirect, stop, release (push, publish or deploy) or other." },
        effects: {
          type: "array",
          minItems: 1,
          maxItems: EFFECTS.length,
          items: { type: "string", enum: EFFECTS },
          description: 'Every effect the command lets the Manager and its Worker have; ["none"] when it allows none of them.',
        },
        decisionId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "The id (o:…) of your decision the owner answered, when this command carries out that answer: its grant covers the effects the owner approved, once.",
        },
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "The instructions the Manager receives: the body of the BM-COMMAND block. Answers to questions go in a BM-ANSWERS block." },
        reason: { type: "string", minLength: 1, maxLength: MAX_COMMAND_WHY_CHARS, description: "Why this command, in one line, for the Manager and the owner (the block's why)." },
      },
    },
  },
  {
    name: "bm_decisions",
    role: "orchestrator",
    description:
      "The owner's decisions as the plugin stores them: your own questions (o:…), the Workers' questions (q:…) and the fallback incidents (f:…), newest asked first, redacted. Each with its status (open, needs-confirmation, answered, superseded, withdrawn, expired), its options and their effects, the owner's answer, the grant it gave (effects, until when, used or not) and what the plugin delivered. Filter by project, request or status (unsettled: open or needs-confirmation). Read-only. Returns JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspaceId: WORKSPACE_ID,
        requestId: { ...ID, description: "Only the decisions of this request." },
        status: { type: "string", enum: DECISIONS_TOOL_STATUSES, description: "Only decisions in this status; unsettled is open or needs-confirmation." },
        limit: {
          type: "integer",
          minimum: DECISIONS_TOOL_LIMIT.min,
          maximum: DECISIONS_TOOL_LIMIT.max,
          description: `How many, newest asked first: ${DECISIONS_TOOL_LIMIT.min}-${DECISIONS_TOOL_LIMIT.max}, default ${DECISIONS_TOOL_LIMIT.default}.`,
        },
      },
    },
  },
  {
    name: "bm_ask_owner",
    role: "orchestrator",
    description:
      "Put a decision to the owner (security, cost, a release, a large change of scope, anything irreversible or on real data): it is stored as a decision the owner answers in paseo-bm, with your recommendation. Give each option the effects it allows and, when choosing it should act at once, the command to run: the plugin then delivers that command itself with the owner's authority as soon as the owner picks it. An answer in the owner's own words comes back to you as a BM-ANSWER notice with a one-use grant. One open question per request: a new one replaces your open question of the same request (the answer names the replaced id) unless separate: true. Sends nothing to any agent now.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "question", "recommendation"],
      properties: {
        workspaceId: WORKSPACE_ID,
        requestId: { ...ID, description: "The request it is about; leave it out only for a decision about the whole project." },
        managerId: { ...ID, description: "The Manager it is about, when it is about one." },
        question: {
          type: "string",
          minLength: 1,
          maxLength: MAX_DECISION_QUESTION_CHARS,
          description: `The question for the owner. With the recommendation, at most ${MAX_DECISION_QUESTION_CHARS} characters.`,
        },
        recommendation: { type: "string", minLength: 1, maxLength: MAX_DECISION_RECOMMENDATION_CHARS, description: "What you recommend, and why, in a few sentences." },
        options: {
          type: "array",
          maxItems: ASK_OWNER_OPTIONS,
          description: `The answers the owner can pick, one button each: at most ${ASK_OWNER_OPTIONS}. The owner can always answer in their own words instead.`,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "effects"],
            properties: {
              label: { type: "string", minLength: 1, maxLength: MAX_DECISION_OPTION_CHARS, description: `The button's text, 1-${MAX_DECISION_OPTION_CHARS} characters.` },
              effects: {
                type: "array",
                minItems: 1,
                maxItems: EFFECTS.length,
                items: { type: "string", enum: EFFECTS },
                description: 'Every effect choosing this option allows; ["none"] when it allows none.',
              },
              recommended: { type: "boolean", description: "true on the one option you recommend (at most one)." },
              command: {
                type: "object",
                additionalProperties: false,
                required: ["to", "agentId", "intent", "body"],
                description: "The command the plugin delivers, as a BM-COMMAND with the owner's authority, the moment the owner picks this option. Its text must not show an effect the option does not declare.",
                properties: {
                  to: { type: "string", enum: ["manager", "worker"], description: "A Manager, or a Worker (its Manager gets a copy). Never a Reviewer." },
                  agentId: { ...ID, description: "The Manager's or the Worker's agent id, of this project." },
                  intent: { type: "string", enum: COMMAND_INTENTS, description: "What the command is for: answer, continue, redirect, stop, release (push, publish or deploy) or other." },
                  body: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "The instructions the agent receives: the body of the BM-COMMAND block." },
                },
              },
            },
          },
        },
        subject: {
          type: "string",
          pattern: SUBJECT_PATTERN.source,
          description: "A short slug for what is decided (for example push-backends): lower-case letters, digits and -, at most 60.",
        },
        separate: { type: "boolean", description: "true keeps your open question of the same request open beside this one instead of replacing it." },
      },
    },
  },
  {
    name: "bm_set_autopilot",
    role: "orchestrator",
    description:
      "Turn Autopilot on or off for one project. Allowed only when the latest message in your chat is the owner's own and asks for it; otherwise refused.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "enabled"],
      properties: {
        workspaceId: WORKSPACE_ID,
        enabled: { type: "boolean", description: "true turns Autopilot on for the project, false turns it off." },
      },
    },
  },
  {
    name: "bm_direct_worker",
    role: "orchestrator",
    description:
      "Command a running project's Worker directly: a correction, or the answer to its question. Same authority as bm_send_command (Autopilot on, the owner's own latest message in your chat, or decisionId), the same declared intent and effects, and the same check of the text against them. Delivered as a BM-COMMAND block when the Worker's turn ends, and its Manager always gets a copy. interrupt: true delivers at once, replacing the Worker's turn, and is allowed only while a danger signal of that Worker is open. Never a Reviewer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "workerId", "re", "intent", "effects", "command"],
      properties: {
        workspaceId: WORKSPACE_ID,
        workerId: { ...ID, description: "The Worker's agent id, as bm_projects or bm_agent_messages gave it." },
        requestId: { ...ID, description: "The request it is about, when it is about one." },
        re: { type: "string", minLength: 1, maxLength: MAX_COMMAND_RE_CHARS, description: "The subject, one line (for example: stop the push)." },
        intent: { type: "string", enum: COMMAND_INTENTS, description: "What the command is for: answer, continue, redirect, stop, release (push, publish or deploy) or other." },
        effects: {
          type: "array",
          minItems: 1,
          maxItems: EFFECTS.length,
          items: { type: "string", enum: EFFECTS },
          description: 'Every effect the command lets the Worker have; ["none"] when it allows none of them (a stop allows none).',
        },
        decisionId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "The id (o:…) of your decision the owner answered, when this command carries out that answer: its grant covers the effects the owner approved, once.",
        },
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "The instructions the Worker receives: the body of the BM-COMMAND block. Answers to its questions go in a BM-ANSWERS block." },
        why: { type: "string", minLength: 1, maxLength: MAX_COMMAND_WHY_CHARS, description: "Why, in one line." },
        interrupt: { type: "boolean", description: "true stops the Worker's running turn with this command; only while its danger signal is open." },
      },
    },
  },
  {
    name: "bm_repo",
    role: "orchestrator",
    description:
      "Check a project's repository for yourself, read-only: git status, the diff stat (staged and unstaged), the last 20 commits, or one file (as committed with HEAD:<path>, or as it is now). Inside the project's folder only; nothing is written, fetched or pushed. Returns text, redacted and capped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "action"],
      properties: {
        workspaceId: WORKSPACE_ID,
        action: { type: "string", enum: REPO_ACTIONS, description: "status | diff-stat | log | show (show needs file)." },
        path: { type: "string", minLength: 1, maxLength: 500, description: "A sub-folder of the project to run in, relative to its folder." },
        file: { type: "string", minLength: 1, maxLength: 500, description: "For show: a file relative to the folder, or HEAD:<file> for its committed version." },
      },
    },
  },
  {
    name: "bm_note",
    role: "orchestrator",
    description:
      "Keep a short note about a project for later: what the owner decided, what to watch. The 20 newest are kept per project, and bm_projects returns them, also to a new Orchestrator. replace: true clears the project's notes first. Sends nothing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "text"],
      properties: {
        workspaceId: WORKSPACE_ID,
        text: { type: "string", minLength: 1, maxLength: MAX_NOTE_CHARS, description: `The note, at most ${MAX_NOTE_CHARS} characters.` },
        replace: { type: "boolean", description: "true empties the project's notes before adding this one." },
      },
    },
  },
];

/**
 * The Manager's server-run tool (autonomy design §A.9): `bm_decisions` of one
 * request, read-only — the Manager's tools stay side-effect free (ADR-010).
 */
export const MANAGER_SERVER_TOOLS: readonly ToolFace[] = [
  {
    name: "bm_decisions",
    role: "manager",
    description:
      "The owner's decisions of one request, as the plugin stores them: the Worker's questions and the Orchestrator's, newest asked first, redacted, each with its status (open, needs-confirmation, answered, superseded, withdrawn, expired), its options, the owner's answer and what the plugin delivered. Read-only: answering is the owner's, in paseo-bm. Returns JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId"],
      properties: {
        requestId: { ...ID, description: "The request id (req-…) of the Worker's report." },
        status: { type: "string", enum: DECISIONS_TOOL_STATUSES, description: "Only decisions in this status; unsettled is open or needs-confirmation." },
      },
    },
  },
];

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
    description: "Build the BM-ANSWERS block for the owner's answers given in your chat: put it in your reply to the owner, and the plugin delivers it to the Worker (never send it yourself).",
    inputSchema: ANSWERS_SCHEMA,
    rules: answersRules,
    build: buildAnswers,
    kinds: () => ["BM-ANSWERS"],
  }),
  assessmentTool,
];

/** The tools that run here, in this module: the block tools and `bm_assessment`'s check. */
export function toolsFor(role: ToolRole): AgentTool[] {
  return AGENT_TOOLS.filter((candidate) => candidate.role === role);
}

/** The faces the plugin server runs for `role` (they read or write plugin data), in the order an endpoint lists them. */
export function serverToolsFor(role: ToolRole): ToolFace[] {
  return [...ORCHESTRATOR_SERVER_TOOLS, ...MANAGER_SERVER_TOOLS].filter((candidate) => candidate.role === role);
}

/**
 * Every tool an endpoint lists for `role`, and the creation hook pre-approves:
 * the Orchestrator's server-run tools first, then the role's own tools, then
 * the Manager's server-run `bm_decisions`.
 */
export function toolFacesFor(role: ToolRole): ToolFace[] {
  return [
    ...ORCHESTRATOR_SERVER_TOOLS.filter((candidate) => candidate.role === role),
    ...toolsFor(role),
    ...MANAGER_SERVER_TOOLS.filter((candidate) => candidate.role === role),
  ];
}

export function toolNamed(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((candidate) => candidate.name === name);
}
