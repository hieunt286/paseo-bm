/**
 * The agents' tools that build `BM-*` blocks (design delta 20260924b-agent-tools,
 * ADR-010): `bm_report` for a Worker, `bm_review` for a Reviewer and
 * `bm_answers` for a Manager. The Orchestrator's workflow assessment tool is
 * retired (autonomy design §B.9).
 *
 * The Orchestrator's tools (design §5.2–§5.3, §6A, §6B.4: `bm_projects`,
 * `bm_request`, `bm_agent_messages`, `bm_send_command`, `bm_decisions`,
 * `bm_ask_owner`, `bm_decide`, `bm_predict`, `bm_direct_worker`, `bm_repo`,
 * `bm_note`, `bm_findings`, `bm_compact`, `bm_handoff`, `bm_why`) read plugin data and repositories,
 * record, answer and predict decisions, record commands and notes, and send
 * commands, so they cannot be
 * pure: only their
 * faces — name, description, input schema — live here
 * (`ORCHESTRATOR_SERVER_TOOLS`), and `server/orchestrator-tools.ts` runs them.
 * The Manager's `bm_decisions` (autonomy design §A.9) reads the decision store,
 * so it is a server-run face too (`MANAGER_SERVER_TOOLS`, run by
 * `server/decision-tools.ts`); it only reads. `bm_reply` (change-014, Ask
 * back) appends the asker's reply to a decision's thread, so the Worker's and
 * the Orchestrator's faces are server-run too (`WORKER_SERVER_TOOLS`, and the
 * last of `ORCHESTRATOR_SERVER_TOOLS`), run by `server/decision-ask.ts`.
 * `toolFacesFor` is what an
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
import { AUTONOMY_MODES } from "./autonomy";
import { WAITING_FOR_PREFIX, WAITING_ON_OWNER_PREFIX, checkBlocks, issueText, type BlockKind } from "./bm-format";
import { MAX_OPTIONS, MAX_SUBJECT_CHARS } from "./bm-questions";
import { COORDINATION_KEYS, coordinationRuleOf } from "./coordination";
import {
  DECISION_CLASSES,
  DECISION_STATUSES,
  EFFECTS,
  MAX_ANSWER_REASON_CHARS,
  MAX_ASK_OWNER_LABEL_CHARS,
  MAX_ASK_OWNER_OPTIONS,
  MAX_ASK_OWNER_RECOMMENDATION_CHARS,
  MAX_DECISION_LABEL_CHARS,
  MAX_DECISION_TEXT_CHARS,
  OPTION_KEY_PATTERN,
  PREPARED_CHANGE_KINDS,
  REVIEW_BUDGET_SUBJECT,
  SUBJECT_PATTERN,
  type DecisionClass,
} from "./decisions";
import { DEFAULT_PRECEDENT_DAYS, MAX_PRECEDENT_DAYS, MAX_PRECEDENT_TEXT_CHARS } from "./precedents";
import { MAX_NOTE_CHARS } from "./orchestrator";
import { MAX_THREAD_TEXT_CHARS } from "./decision-threads";
import { MAX_HANDOFF_NOTE_CHARS } from "./handoff";
import { DECLARED_COMMAND_INTENTS, MAX_COMMAND_BODY_CHARS, MAX_COMMAND_DECISION_ID_CHARS, MAX_COMMAND_RE_CHARS, MAX_COMMAND_WHY_CHARS } from "./orchestrator-command";

export type ToolRole = "worker" | "reviewer" | "manager" | "orchestrator";

type JsonType = "object" | "string" | "array" | "boolean" | "integer" | "number" | "null";

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
/** A report's phases; `stopped` is a stopped run's (design §16.6, §16.11). */
const REPORT_PHASES = ["received", "beads-done", "blocked", "finished", "stopped"] as const;
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
  /** What the description ends with; how to send the block (`SEND`) by default. A bound tool delivers it itself. */
  suffix?: string;
}

const SEND = "Arguments are JSON: leave out a field you have nothing for. Returns the block; send it verbatim, as the whole block, in the message you were going to send. On error, fix the listed fields and call again.";

function tool<T>(spec: BlockToolSpec<T>): AgentTool {
  return {
    name: spec.name,
    role: spec.role,
    description: `${spec.description} ${spec.suffix ?? SEND}`,
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
  phase: "received" | "beads-done" | "blocked" | "finished" | "stopped";
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
  /** Only when the plugin asks for it (`BM-HANDOFF`, autonomy design §G.6 step 1): what was tried and what is next. */
  handoffNote?: string;
  questions?: Array<{
    id: string;
    text: string;
    subject?: string;
    supersedes?: string;
    class?: DecisionClass;
    options: Array<{ text: string; recommended?: boolean; effects?: Array<(typeof EFFECTS)[number]> }>;
  }>;
  /** A bound Worker's blocked report (design §16.6): the open questions (`q:` ids) it waits on. */
  waitingOn?: string[];
  /** A bound Worker's blocked report: the other request or Worker it waits for. */
  waitingFor?: string;
}

/** Empty is `[]` or left out; a model used to the text template writes `none`, which is not JSON (live run, 2026-09-24). */
const EMPTY = "Leave it out or [] when there are none; never the word none.";
const BEAD_IDS: JsonSchema = {
  type: "array",
  items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9][A-Za-z0-9.-]*$", description: "A full bead id, as br prints it." },
  description: `Full bead ids. ${EMPTY}`,
};

/** A decision's class as its asker proposes it (autonomy design §B.1): `bm_report`'s questions and `bm_ask_owner`. */
const CLASS_FIELD: JsonSchema = {
  type: "string",
  enum: DECISION_CLASSES,
  description: `What is decided, riskiest first: ${DECISION_CLASSES.join(", ")}. The riskier one when unsure. The plugin keeps the riskier of yours and what the options' effects imply (push, publish or deploy is release; real-data or migration, data; dependency-install, dependency; network or outside-workspace, environment).`,
};

/**
 * A prepared change of the owner's settings on an option of `bm_ask_owner`
 * (autonomy design §G.4): flat, `kind` naming which fields it takes
 * (`shared/prepared-changes.ts` `PREPARED_CHANGE_FIELDS`, which the server
 * checks).
 */
const CHANGE_FIELD: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  description:
    'A change of the owner\'s settings the plugin applies itself when the owner picks this option, and only then: precedent.save { scope, subject, text, expiresInDays? }; autonomy.set { class, mode } of this project (delegate means you decide that class); coordination.set { key, value }. The option then declares effects ["none"] and carries no command. Refused when the owner could not make it in Settings, or when it would change nothing.',
  properties: {
    kind: { type: "string", enum: PREPARED_CHANGE_KINDS, description: "Which setting it changes." },
    scope: { type: "string", enum: ["project", "all"], description: "precedent.save: this project, or all projects." },
    subject: { type: "string", pattern: SUBJECT_PATTERN.source, description: "precedent.save: the question subject the precedent answers (as bm_findings gave it)." },
    text: { type: "string", minLength: 1, maxLength: MAX_PRECEDENT_TEXT_CHARS, description: "precedent.save: the standing answer, as the owner answered it before." },
    expiresInDays: { type: "integer", minimum: 1, maximum: MAX_PRECEDENT_DAYS, description: `precedent.save: how long it holds, 1-${MAX_PRECEDENT_DAYS} days (default ${DEFAULT_PRECEDENT_DAYS}).` },
    class: { type: "string", enum: DECISION_CLASSES, description: "autonomy.set: the decision class whose cell it sets." },
    mode: { type: "string", enum: AUTONOMY_MODES, description: "autonomy.set: owner, shadow, or delegate." },
    key: { type: "string", enum: COORDINATION_KEYS, description: "coordination.set: the setting." },
    value: {
      type: ["number", "boolean"],
      description: `coordination.set: its new value, in the setting's bounds: ${COORDINATION_KEYS.map((key) => coordinationRuleOf(key)).join("; ")}.`,
    },
  },
};

const REPORT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "phase", "tier", "buildAndTests"],
  properties: {
    requestId: REQUEST_ID,
    phase: {
      type: "string",
      enum: REPORT_PHASES,
      description: "stopped when your run was stopped before the work was done; never finished then.",
    },
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
    buildAndTests: {
      ...TEXT,
      description:
        "Each check exactly as you ran it, in backticks, with pass/fail — `npm test` pass; `npm run lint` pass — or \"not run\". Backticks only around commands. The plugin confirms a check only from a run after your last edit, without pipes or redirections.",
    },
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
    handoffNote: {
      type: "string",
      minLength: 1,
      maxLength: MAX_HANDOFF_NOTE_CHARS,
      description: `Only when a BM-HANDOFF message asks for it: for the Worker who takes the request over, what you tried and what is next, at most ${MAX_HANDOFF_NOTE_CHARS.toLocaleString("en-US")} characters.`,
    },
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
          class: CLASS_FIELD,
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

/** `Qn` of a `q:<requestId>:<Qn>` decision id. */
function questionNumberOf(decisionId: string): string {
  return decisionId.slice(decisionId.lastIndexOf(":") + 1);
}

/**
 * What a bound Worker's blocked report waits on (design §16.6, §16.11), as
 * its `blockers` line opens: `waiting on the owner: Q2, Q3`, then `waiting
 * for: <the other request or Worker>`; null when it names neither.
 */
function waitingText(input: Pick<ReportInput, "waitingOn" | "waitingFor">): string | null {
  const numbers = [...new Set((input.waitingOn ?? []).map(questionNumberOf))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const parts = [
    numbers.length === 0 ? null : `${WAITING_ON_OWNER_PREFIX} ${numbers.join(", ")}`,
    input.waitingFor === undefined || line(input.waitingFor) === "" ? null : `${WAITING_FOR_PREFIX} ${line(input.waitingFor)}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(". ");
}

function blockersText(input: ReportInput): string {
  const ids = (input.questions ?? []).map((question) => question.id);
  const waiting = input.phase === "blocked" ? waitingText(input) : null;
  const asked =
    waiting !== null ? waiting : input.phase === "blocked" ? `${ids.length} ${ids.length === 1 ? "question" : "questions"}: ${ids.join(", ")} — see BM-QUESTIONS` : null;
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
 * end of the line for the block's own `subject`, `supersedes`, `class` or
 * `effects`.
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
    ...(input.handoffNote === undefined || line(input.handoffNote) === "" ? [] : [`handoffNote: ${line(input.handoffNote)}`]),
  ];
  if (input.phase !== "blocked" || input.questions === undefined) return lines.join("\n");
  const asked = ["BM-QUESTIONS", `requestId: ${input.requestId}`];
  // Tags in the documented order (autonomy design §A.5, §B.9): subject, supersedes, class; "(recommended)" before effects.
  for (const question of input.questions ?? []) {
    const subject = question.subject === undefined ? "" : ` [subject: ${question.subject}]`;
    const supersedes = question.supersedes === undefined ? "" : ` [supersedes: ${question.supersedes}]`;
    const proposed = question.class === undefined ? "" : ` [class: ${question.class}]`;
    asked.push(`${question.id}: ${tagFree(question.text)}${subject}${supersedes}${proposed}`);
    question.options.forEach((option, index) => {
      const effects = [...new Set(option.effects ?? [])];
      const tag = effects.length === 0 ? "" : ` [effects: ${effects.join(", ")}]`;
      asked.push(`- ${String.fromCharCode(97 + index)}: ${tagFree(option.text)}${option.recommended === true ? " (recommended)" : ""}${tag}`);
    });
  }
  return `${lines.join("\n")}\n\n${asked.join("\n")}`;
}

function tierRules(input: Pick<ReportInput, "tier">): string[] {
  const out: string[] = [];
  const { tier } = input;
  if (tier.changedFrom !== undefined && tier.reason === undefined) out.push("input.tier.reason: is required with changedFrom");
  if (tier.changedFrom === undefined && tier.reason !== undefined) out.push("input.tier.reason: only with changedFrom; put other words in note");
  if (tier.changedFrom !== undefined && tier.changedFrom === tier.level) out.push("input.tier.changedFrom: equals level; leave it out when the tier did not change");
  return out;
}

function reportRules(input: ReportInput): string[] {
  const out = tierRules(input);
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

// ---------------------------------------------------------------------------
// The Orchestrator's server-run tools (design §5.2, §5.3, §6A): faces only.
// ---------------------------------------------------------------------------

/** `bm_projects`' window, in hours (design §5.2). */
export const PROJECTS_SINCE_HOURS = { min: 1, max: 168, default: 24 } as const;
/** `bm_agent_messages`' count (design §5.2); with `detail: "full"`, `default` when no `limit` is given. */
export const AGENT_MESSAGES_LIMIT = { min: 1, max: 50, default: 20 } as const;
/**
 * How much `bm_projects`, `bm_request`, `bm_agent_messages` and `bm_why` return
 * (autonomy design §A.9): a bounded summary by default, today's limits with
 * `full`.
 */
export const READ_DETAILS = ["summary", "full"] as const;
export type ReadDetail = (typeof READ_DETAILS)[number];
/** The most characters `bm_request` and `bm_why` return by default, the bounded note included (autonomy design §A.9, §E.2). */
export const REQUEST_SUMMARY_MAX_CHARS = 4_000;
/** The window `bm_findings` reads, in days (autonomy design §G.4): Insights' 30-day window. */
export const FINDINGS_WINDOW_DAYS = 30;
/** The most characters `bm_findings` returns (autonomy design §G.4); the description says "4,000". */
export const FINDINGS_MAX_CHARS = 4_000;
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

const ID: JsonSchema = { type: "string", minLength: 1, maxLength: 200 };

/**
 * The same rules as `WORKSPACE_ID_PATTERN` of `server/trace-store.ts`, which
 * this module cannot import: a workspace id the stores would refuse is refused
 * here first, by its path.
 */
export const WORKSPACE_ID_SOURCE = "^[A-Za-z0-9._-]{1,128}$";
const WORKSPACE_ID: JsonSchema = { type: "string", pattern: WORKSPACE_ID_SOURCE, description: "The workspace id bm_projects gave for the project." };

function detailOf(summary: string, full: string): JsonSchema {
  return { type: "string", enum: READ_DETAILS, description: `"summary" (default): ${summary}. "full": ${full}.` };
}

export const ORCHESTRATOR_SERVER_TOOLS: readonly ToolFace[] = [
  {
    name: "bm_projects",
    role: "orchestrator",
    description:
      "Where paseo-bm work stands on this machine: each project (workspace) with activity in the period and its Manager(s). By default only counts (requests by state, waiting on the owner, open stall situations, your notes) and the owner's open decisions; with detail: \"full\", up to 10 recent requests with their size, state, what they wait on and open stall situations, and your notes about the project (bm_note). Read-only. Returns JSON.",
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
        detail: detailOf("counts and open decisions per project", "each recent request, its stalls, and your notes"),
      },
    },
  },
  {
    name: "bm_request",
    role: "orchestrator",
    description:
      "One request, redacted: what the user asked, the Worker's reports, the reviews, the Manager's replies, the user's messages, and its time, tokens and review calls. At most 4,000 characters by default, the longest messages cut first; detail: \"full\" for up to 60,000. Read-only. Returns text.",
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
      "Send a command to a project's Manager now, in the language of that Manager's conversation with the owner. Without a decision it goes out on your own only where the owner delegated every class of its effects for the project (commit, or no effect, counts as reversible-technical; the authority is then policy:<class>), or right after the owner's own message in your chat telling you to send; with decisionId, on a decision of yours the owner answered. Otherwise it is refused, naming the class not delegated: ask the owner with bm_ask_owner, and prepare the command on an option. Declare its intent and every effect it allows: the owner's policy covers each effect whose class the project delegates (push, publish and deploy are release; real-data and migration are data; security; cost — delegated at Turbo and Full auto); the owner's word in your chat covers any effect but those seven, which otherwise only the grant of an answered decision covers (one command, within an hour of the answer). A text that shows an effect you did not declare (a release, security, data, cost or dependency) is refused: declare it or ask the owner with bm_ask_owner. The plugin delivers a BM-COMMAND block with the authority, the approved effects and the limits that remain.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "managerId", "intent", "effects", "command", "reason"],
      properties: {
        workspaceId: WORKSPACE_ID,
        managerId: { ...ID, description: "The Manager's agent id, as bm_projects gave it." },
        requestId: { ...ID, description: "The request it is about, when it is about one." },
        re: { type: "string", minLength: 1, maxLength: MAX_COMMAND_RE_CHARS, description: "The subject, one line (for example: answer to Q2). Defaults to the command's first line." },
        intent: { type: "string", enum: DECLARED_COMMAND_INTENTS, description: "What the command is for: answer, continue, redirect, stop, release (push, publish or deploy) or other." },
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
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "The instructions the Manager receives: the body of the BM-COMMAND block. A stored question (q:…) is answered with bm_decide, never in a BM-ANSWERS block here." },
        reason: { type: "string", minLength: 1, maxLength: MAX_COMMAND_WHY_CHARS, description: "Why this command, in one line, for the Manager and the owner (the block's why)." },
      },
    },
  },
  {
    name: "bm_decisions",
    role: "orchestrator",
    description:
      "The owner's decisions as the plugin stores them: your own questions (o:…), the Workers' questions (q:…) and the fallback incidents (f:…), newest asked first, redacted. Each with its status (open, needs-confirmation, answered, superseded, withdrawn, expired), its class, its options and their effects, the answer (the owner's, or yours with bm_decide and your reason), the grant it gave (effects, until when, used or not) and what the plugin delivered. Filter by project, request or status (unsettled: open or needs-confirmation). Read-only. Returns JSON.",
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
      "Put a decision to the owner (security, cost, a release, a large change of scope, anything irreversible or on real data): it is stored as a decision the owner answers in paseo-bm, with your recommendation. Give each option the effects it allows and, when choosing it should act at once, the command to run: the plugin then delivers that command itself with the owner's authority as soon as the owner picks it. For advice, an option may carry instead a change of the owner's settings (a precedent, an autonomy cell of this project, a coordination setting): the question then says what it applies, and the plugin applies it only when the owner picks it — never on a precedent's, the policy's or your answer. An answer in the owner's own words comes back to you as a BM-ANSWER notice with a one-use grant. One open question per request: a new one replaces your open question of the same request (the answer names the replaced id) unless separate: true. Sends nothing to any agent now.",
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
          maxLength: MAX_DECISION_TEXT_CHARS,
          description: `The question for the owner. With the recommendation (and a line per change an option carries), at most ${MAX_DECISION_TEXT_CHARS} characters.`,
        },
        recommendation: { type: "string", minLength: 1, maxLength: MAX_ASK_OWNER_RECOMMENDATION_CHARS, description: "What you recommend, and why, in a few sentences." },
        options: {
          type: "array",
          maxItems: MAX_ASK_OWNER_OPTIONS,
          description: `The answers the owner can pick, one button each: at most ${MAX_ASK_OWNER_OPTIONS}. The owner can always answer in their own words instead.`,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "effects"],
            properties: {
              label: { type: "string", minLength: 1, maxLength: MAX_ASK_OWNER_LABEL_CHARS, description: `The button's text, 1-${MAX_ASK_OWNER_LABEL_CHARS} characters.` },
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
                  intent: { type: "string", enum: DECLARED_COMMAND_INTENTS, description: "What the command is for: answer, continue, redirect, stop, release (push, publish or deploy) or other." },
                  body: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "The instructions the agent receives: the body of the BM-COMMAND block." },
                },
              },
              change: CHANGE_FIELD,
            },
          },
        },
        subject: {
          type: "string",
          pattern: SUBJECT_PATTERN.source,
          description: "A short slug for what is decided (for example push-backends): lower-case letters, digits and -, at most 60.",
        },
        class: CLASS_FIELD,
        separate: { type: "boolean", description: "true keeps your open question of the same request open beside this one instead of replacing it." },
      },
    },
  },
  {
    name: "bm_decide",
    role: "orchestrator",
    description:
      "Decide for the owner an open decision you did not ask — a Worker's question (q:…) or a fallback incident (f:…) — when a decision.opened line asks you to: the owner's policy delegates its class to you in that project. Choose the option the owner would, and give your reason in one line; the owner sees both. The plugin then delivers it exactly as it delivers the owner's answers (to the Worker, or the incident's action). Refused, changing nothing, unless the decision is still open and its class is delegated in that project (by the project's autonomy level; any class, a release, data, security or cost one included); your own decisions (o:…) are always the owner's. An option that pushes, publishes, deploys, migrates, touches real data or costs money is granted as the owner's choice of it would be. A decision you leave stays open for the owner. Never answer a stored question in a command's BM-ANSWERS block.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "optionKey", "reason"],
      properties: {
        decisionId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "The decision, q:<requestId>:<Qn> or f:<incidentId>, as a decision.opened line or bm_decisions gave it.",
        },
        optionKey: { type: "string", pattern: OPTION_KEY_PATTERN.source, description: "The key of the option you choose (a, b, …)." },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: MAX_ANSWER_REASON_CHARS,
          description: `Why this option, in one line, for the owner: it is shown with your answer. 1-${MAX_ANSWER_REASON_CHARS} characters.`,
        },
      },
    },
  },
  {
    name: "bm_predict",
    role: "orchestrator",
    description:
      "Predict the owner's answer to an open decision you did not ask (a Worker's question q:… or a fallback incident f:…), when a decision.opened line asks for a prediction: the option you expect the owner to choose, and why. It answers nothing and sends nothing: the owner still decides, and sees your option and reason on the decision as your proposal; how often you foresee their answers is measured per class. Refused unless the project's autonomy level is 1 or more (Co-pilot and up), the decision is still open, its class is not delegated already (any class), and you have not predicted it yet; a refusal changes nothing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "optionKey", "reason"],
      properties: {
        decisionId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "The decision, q:<requestId>:<Qn> or f:<incidentId>, as the decision.opened line gave it.",
        },
        optionKey: { type: "string", pattern: OPTION_KEY_PATTERN.source, description: "The key of the option you expect the owner to choose (a, b, …)." },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: MAX_ANSWER_REASON_CHARS,
          description: `Why you expect it, in one line; kept with the prediction. 1-${MAX_ANSWER_REASON_CHARS} characters.`,
        },
      },
    },
  },
  {
    name: "bm_direct_worker",
    role: "orchestrator",
    description:
      "Command a running project's Worker directly: a correction, or the answer to a question of its that has no stored decision (a stored one, q:…, is answered with bm_decide). Same authority as bm_send_command (without a decision: the owner's policy delegating every class of its effects, or the owner's own latest message in your chat; else decisionId), the same declared intent and effects, and the same check of the text against them. Delivered as a BM-COMMAND block when the Worker's turn ends, and its Manager always gets a copy. interrupt: true delivers at once, replacing the Worker's turn, and is allowed only while a danger signal of that Worker is open. Never a Reviewer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "workerId", "re", "intent", "effects", "command"],
      properties: {
        workspaceId: WORKSPACE_ID,
        workerId: { ...ID, description: "The Worker's agent id, as bm_projects or bm_agent_messages gave it." },
        requestId: { ...ID, description: "The request it is about, when it is about one." },
        re: { type: "string", minLength: 1, maxLength: MAX_COMMAND_RE_CHARS, description: "The subject, one line (for example: stop the push)." },
        intent: { type: "string", enum: DECLARED_COMMAND_INTENTS, description: "What the command is for: answer, continue, redirect, stop, release (push, publish or deploy) or other." },
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
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "The instructions the Worker receives: the body of the BM-COMMAND block. An answer to a question with no stored decision goes in a BM-ANSWERS block; a stored one (q:…) is refused here: answer it with bm_decide." },
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
  {
    name: "bm_findings",
    role: "orchestrator",
    description: `A project's measured findings over the last ${FINDINGS_WINDOW_DAYS} days, for advice (an advice.due line, or the owner asking): question subjects asked again and again without a precedent, each class's agreement with a predictor where it is not delegated, interventions below their target, rounds blocked on the owner and how long the owner took, reviews and blocking findings per tier, stall reasons, the heaviest requests and the compaction and handoff candidates (estimates), with the settings they bear on. Figures and short labels only, at most 4,000 characters; read a decision with bm_decisions and a request with bm_request. Each finding names the change that acts on it, when there is one: ask the owner with bm_ask_owner, the change on an option. Read-only. Returns JSON.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId"],
      properties: {
        workspaceId: WORKSPACE_ID,
      },
    },
  },
  {
    name: "bm_compact",
    role: "orchestrator",
    description:
      "Have a project's Manager or Worker compact its context, on your own initiative within the owner's Settings → Coordination (a threshold.crossed line names it, or you see its context grow). The plugin waits for that agent's next idle moment after a safe point (a Worker right after a report, a Manager with nothing queued for it), never inside a running turn, and at most an hour; it sends the provider's /compact (on Claude with a fixed focus: the request and the owner's words, decisions, plan and bead state, open findings, files changed; bare on Codex and OpenCode), then a BM-STATE brief built from the plugin's records. Refused, changing nothing, when compaction is off, the agent is not a Manager or a Worker of a project (never a Reviewer, never you), a compaction of it is pending, it reached the owner's limit of compactions per agent (a Worker's next step is a handoff), its provider cannot compact, or its last measured turn is below the owner's threshold. Logged as a compact intervention, judged on its next three turns. Returns text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agentId", "reason"],
      properties: {
        agentId: { ...ID, description: "The Manager's or the Worker's agent id, as bm_projects, bm_agent_messages or a threshold.crossed line gave it." },
        reason: { type: "string", minLength: 1, maxLength: MAX_COMMAND_WHY_CHARS, description: "Why, in one line, for the owner: kept with the compaction." },
      },
    },
  },
  {
    name: "bm_handoff",
    role: "orchestrator",
    description:
      "Have a Worker's request handed over to a new Worker, on your own initiative within the owner's Settings → Coordination (a threshold.crossed handoff line names it, or you see the request grow heavy). The plugin waits for that Worker's next safe point (a bead closed, beads-done, a review verdict) and its idle moment, at most an hour; asks it for a short handoff note (it goes on without one after 10 minutes); builds a masked brief from its records (the request and the owner's words, decisions, plan and bead state, the last report, open findings, branch and diff stat, the note); then sends the Worker's Manager a BM-COMMAND to create the successor with that brief and tell the old Worker it is replaced. The request keeps its id; the old Worker stays idle and is never archived; the successor proves its work again. Refused, changing nothing, when handoff is off, the agent is not the live Worker of an unfinished request with a Manager, a handoff of that request is pending, the request reached the owner's limit of handoffs, its tokens since it started (or its last handoff) are below the owner's threshold, or its commands reached the loop guard. Logged as a handoff intervention, judged on the successor's first hour. Returns text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workerId", "reason"],
      properties: {
        workerId: { ...ID, description: "The Worker's agent id, as bm_request, bm_projects or a threshold.crossed line gave it." },
        reason: { type: "string", minLength: 1, maxLength: MAX_COMMAND_WHY_CHARS, description: "Why, in one line, for the owner: kept with the handoff and told to the successor." },
      },
    },
  },
  {
    name: "bm_why",
    role: "orchestrator",
    description:
      "Why a bead, a changed file or a decision exists: the chain of each request behind it — the request, its decisions (and the precedents that answered them), beads, changes, commits, checks, review verdicts and turns per agent — each link found, absent or missing with its reason, and the supersession, split, handoff and replacement edges. Give exactly one of bead, file or decision. Ids, statuses and short masked labels; at most 4,000 characters by default, the longest lists cut first with a note; detail: \"full\" for up to 60,000 (each link's source, every turn, the commits' files). An unknown project or id answers found: false with the reason. Read-only. Returns JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId"],
      properties: {
        workspaceId: WORKSPACE_ID,
        bead: { ...ID, description: "A bead id (bm-…): the requests whose reports or br commands name it." },
        file: { type: "string", minLength: 1, maxLength: 500, description: "A changed file, relative to the project's folder (or absolute): the requests whose reports or recorded edits name it." },
        decision: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "A decision id (q:…, o:…, f:…, h:…, r:…), as bm_decisions gave it: the decision and its request's chain.",
        },
        detail: detailOf("at most 4,000 characters, the longest lists cut first", "up to 60,000 characters, with each link's source and every turn"),
      },
    },
  },
  replyFace("orchestrator", "^o:[A-Za-z0-9-]{1,64}$", "one of your open decisions (o:…)"),
];

/**
 * `bm_reply` (change-014 outcome 3, Ask back): the asker's answer to the
 * owner's question about its open decision, which a `BM-ASK` notice brought.
 * It appends to the decision's thread (`server/decision-ask.ts`), so it runs
 * on the plugin server; one face per asker role, each taking only its own
 * kind of decision id.
 */
function replyFace(role: ToolRole, idPattern: string, what: string): ToolFace {
  return {
    name: "bm_reply",
    role,
    description: `Reply to the owner's question about ${what}, after a BM-ASK notice asked it: your reply is added to the decision's thread, where the owner reads it on its card. A few lines; at most ${MAX_THREAD_TEXT_CHARS.toLocaleString("en-US")} characters, masked before it is stored. Only once per BM-ASK: refused when the owner has not asked, or you already replied. It answers nothing: the decision stays open until the owner chooses, so never answer it yourself and never ask it again. Returns text.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "text"],
      properties: {
        decisionId: { type: "string", pattern: idPattern, description: "The decisionId line of the BM-ASK notice." },
        text: { type: "string", minLength: 1, maxLength: MAX_THREAD_TEXT_CHARS, description: "Your reply to the owner's question, in a few lines." },
      },
    },
  };
}

/** The Worker's server-run tool: `bm_reply` for its own questions (`q:`). */
export const WORKER_SERVER_TOOLS: readonly ToolFace[] = [replyFace("worker", "^q:\\S+:Q\\d{1,3}$", "one of your open questions (q:…)")];

/**
 * The Manager's server-run tool (autonomy design §A.9): `bm_decisions` of one
 * request, read-only — the Manager's tools stay side-effect free (ADR-010).
 */
export const MANAGER_SERVER_TOOLS: readonly ToolFace[] = [
  {
    name: "bm_decisions",
    role: "manager",
    description:
      "The owner's decisions of one request, as the plugin stores them: the Worker's questions and the Orchestrator's, newest asked first, redacted, each with its status (open, needs-confirmation, answered, superseded, withdrawn, expired), its class, its options, the owner's answer and what the plugin delivered. Read-only: answering is the owner's, in paseo-bm. Returns JSON.",
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

/** `bm_create_worker`'s bounds (design §16.6). */
export const CREATE_WORKER_LIMITS = { request: 20_000, contextItems: 20, fact: 500, source: 200 } as const;

// ---------------------------------------------------------------------------
// The bound agents' delivering tools (design §16.6, ADR-027 decision 4).
// ---------------------------------------------------------------------------

/** The bounds of the bound delivering tools (design §16.6). */
export const DELIVERING_LIMITS = { waitingFor: 500, waitingOn: 10, questions: 5, tellText: 8_000, tellSource: 300, grantCalls: 10 } as const;
/** The subject a question for more review calls carries (design §16.8). */
const REVIEW_BUDGET = REVIEW_BUDGET_SUBJECT;
/** A `q:` decision id: `q:<requestId>:<Qn>`. */
export const QUESTION_DECISION_ID_SOURCE = "^q:req-\\d{8}T\\d{6}Z:Q[1-9]\\d{0,2}$";

/** What a bound tool's description ends with: it delivers, so there is nothing to send. */
const DELIVERED = "Arguments are JSON: leave out a field you have nothing for. On error, fix the listed fields and call again; nothing was stored or sent.";

/** `bm_report`'s fields without `questions`: a bound Worker asks with `bm_questions`. */
const BOUND_REPORT_PROPERTIES: Record<string, JsonSchema> = Object.fromEntries(Object.entries(REPORT_SCHEMA.properties!).filter(([key]) => key !== "questions"));

const BOUND_REPORT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requestId", "phase", "tier", "buildAndTests"],
  properties: {
    ...BOUND_REPORT_PROPERTIES,
    requestId: { ...REQUEST_ID, description: "Your request's id, as your first prompt gave it." },
    blockers: { ...TEXT, description: "Anything else that holds the work up; omit when nothing does. When blocked, the tool writes what you wait on itself." },
    waitingOn: {
      type: "array",
      minItems: 1,
      maxItems: DELIVERING_LIMITS.waitingOn,
      items: { type: "string", pattern: QUESTION_DECISION_ID_SOURCE, description: "A decisionId bm_questions gave you." },
      description: "Only when blocked: the open questions of your request you wait on, by the decisionId bm_questions returned. The only way to wait on the owner.",
    },
    waitingFor: {
      type: "string",
      minLength: 1,
      maxLength: DELIVERING_LIMITS.waitingFor,
      description: "Only when blocked: the other request or Worker you wait for, and why, in one line.",
    },
  },
};

function boundReportRules(input: ReportInput): string[] {
  const out = tierRules(input);
  const waits = (input.waitingOn?.length ?? 0) > 0 || input.waitingFor !== undefined;
  if (input.phase === "blocked" && !waits) out.push("input.waitingOn: a blocked report names what it waits on: waitingOn (open questions from bm_questions) or waitingFor (another request or Worker), or both");
  if (input.phase !== "blocked" && input.waitingOn !== undefined) out.push("input.waitingOn: only a blocked report waits; leave it out");
  if (input.phase !== "blocked" && input.waitingFor !== undefined) out.push("input.waitingFor: only a blocked report waits; leave it out");
  (input.waitingOn ?? []).forEach((id, index) => {
    if (!id.startsWith(`q:${input.requestId}:`)) out.push(`input.waitingOn[${index}]: ${id} is not a question of ${input.requestId}`);
  });
  return out;
}

/** `bm_report` for a bound Worker: built and checked as the builder's, then stored and delivered by the plugin. */
export const BOUND_REPORT_TOOL: AgentTool = tool<ReportInput>({
  name: "bm_report",
  role: "worker",
  description:
    "Report to your Manager: paseo-bm builds your BM-REPORT, stores it and delivers it to the Manager that created you, at its next idle moment. phase: received first, beads-done, blocked (with waitingOn or waitingFor), finished when the request is done, stopped when your run was stopped. Ask the owner with bm_questions, never here. Returns JSON { recordId, delivery } — delivery sent, queued (the Manager is busy; it arrives at its next idle moment) or dropped.",
  inputSchema: BOUND_REPORT_SCHEMA,
  rules: boundReportRules,
  build: buildReport,
  kinds: () => ["BM-REPORT"],
  suffix: DELIVERED,
});

/** `bm_review` for a bound Reviewer: built and checked as the builder's, then delivered to its Worker. */
export const BOUND_REVIEW_TOOL: AgentTool = tool<ReviewInput>({
  name: "bm_review",
  role: "reviewer",
  description:
    "Send your verdict: paseo-bm builds your BM-REVIEW of your batch, stores it and delivers it to the Worker that created you. Then end your turn with one line; do not repeat the review. Returns JSON { recordId, delivery }.",
  inputSchema: REVIEW_SCHEMA,
  rules: (input) =>
    (["checked", "notChecked"] as const).filter((key) => prose(input[key]) === "").map((key) => `input.${key}: has no text once code fences and quote marks are removed`),
  build: buildReview,
  kinds: () => ["BM-REVIEW"],
  suffix: DELIVERED,
});

/** `bm_answers` for a bound Manager: the owner's answers in its chat, proposed for this turn. */
export const BOUND_ANSWERS_TOOL: AgentTool = tool<AnswersInput>({
  name: "bm_answers",
  role: "manager",
  description:
    "Record the answers the owner gave to a Worker's open questions in your chat, in this turn. paseo-bm settles them when your turn ends, and only if this turn holds the owner's own message; the plugin then delivers them to the Worker. Never relay an answer as text. Only open questions (Qn) of a request of yours. Returns JSON { proposed: [Qn…] }.",
  inputSchema: ANSWERS_SCHEMA,
  rules: answersRules,
  build: buildAnswers,
  kinds: () => ["BM-ANSWERS"],
  suffix: DELIVERED,
});

/** What `bm_questions` takes (design §16.6). */
export interface QuestionsInput {
  questions: Array<{
    text: string;
    subject: string;
    class: DecisionClass;
    supersedes?: string;
    options: Array<{
      key: string;
      text: string;
      effects: Array<(typeof EFFECTS)[number]>;
      recommended?: boolean;
      grant?: { calls?: number; untilClean?: string };
    }>;
  }>;
}

export const QUESTIONS_FACE: ToolFace = {
  name: "bm_questions",
  role: "worker",
  description: `Ask the owner: paseo-bm opens each question as a decision the owner answers in paseo-bm, numbers it after your request's last Qn, and delivers the answer to you when it comes. A question an owner precedent answers at once comes back answered: carry on with that answer. Then report blocked with waitingOn naming the open ones, unless you can carry on with what does not depend on them. Exactly one recommended option per question. A question of subject "${REVIEW_BUDGET}" may give options a grant ({ calls: n } or { untilClean: batchId }). Returns JSON [{ qn, decisionId, state, answer? }]. ${DELIVERED}`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: DELIVERING_LIMITS.questions,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "subject", "class", "options"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: MAX_DECISION_TEXT_CHARS, description: "The topic, then the question, for the owner." },
            subject: {
              type: "string",
              pattern: SUBJECT_PATTERN.source,
              description: `A short slug naming what is decided, such as push-backends: lowercase letters, digits and -, at most 60 characters. Keep it when you ask the same thing again; "${REVIEW_BUDGET}" for more review calls.`,
            },
            class: CLASS_FIELD,
            supersedes: { ...QUESTION_ID, description: "The earlier question of this request that this one asks again, such as Q2; leave it out for a new question." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: MAX_OPTIONS,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "text", "effects"],
                properties: {
                  key: { type: "string", pattern: "^[a-h]$", description: "a, b, c … in order." },
                  text: { type: "string", minLength: 1, maxLength: MAX_DECISION_LABEL_CHARS, description: "The option and what it costs." },
                  effects: {
                    type: "array",
                    minItems: 1,
                    maxItems: EFFECTS.length,
                    items: { type: "string", enum: EFFECTS },
                    description: 'What choosing it lets you do beyond the workspace or the undoable, such as push or migration; ["none"] when nothing of the kind.',
                  },
                  recommended: { type: "boolean", description: "True on exactly one option." },
                  grant: {
                    type: "object",
                    additionalProperties: false,
                    description: `Only on a "${REVIEW_BUDGET}" question: what choosing this option grants — { calls: n } (1-${DELIVERING_LIMITS.grantCalls} more review calls) or { untilClean: "<batchId>" }. Leave it out on the option that grants nothing.`,
                    properties: {
                      calls: { type: "integer", minimum: 1, maximum: DELIVERING_LIMITS.grantCalls },
                      untilClean: BATCH_ID,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** What the schema cannot say about `bm_questions` (design §16.6); one line per problem. Pure. */
export function questionsRules(input: QuestionsInput): string[] {
  const out: string[] = [];
  input.questions.forEach((question, q) => {
    const path = `input.questions[${q}]`;
    const recommended = question.options.filter((option) => option.recommended === true).length;
    if (recommended !== 1) out.push(`${path}.options: exactly one option is recommended (found ${recommended})`);
    question.options.forEach((option, o) => {
      const at = `${path}.options[${o}]`;
      const expected = String.fromCharCode(97 + o);
      if (option.key !== expected) out.push(`${at}.key: must be ${expected} (keys run a, b, c … in order)`);
      if (RECOMMENDED_MARK.test(option.text)) out.push(`${at}.text: leave out "(recommended)"; set recommended: true instead`);
      if (option.effects.includes("none") && new Set(option.effects).size > 1) out.push(`${at}.effects: "none" stands alone; leave it out when the option has effects`);
      if (option.grant === undefined) return;
      if (question.subject !== REVIEW_BUDGET) out.push(`${at}.grant: only a question of subject "${REVIEW_BUDGET}" grants`);
      const kinds = (option.grant.calls === undefined ? 0 : 1) + (option.grant.untilClean === undefined ? 0 : 1);
      if (kinds !== 1) out.push(`${at}.grant: give exactly one of calls or untilClean`);
    });
  });
  return out;
}

/** `bm_tell_worker`'s face (design §16.6): the owner's words and facts to a request's Worker. */
export const TELL_WORKER_FACE: ToolFace = {
  name: "bm_tell_worker",
  role: "manager",
  description:
    "Give a request's Worker the owner's words or a fact it needs: paseo-bm delivers them to that request's one live Worker at its next idle moment, never into a running turn. Only a request of yours. Returns JSON { workerId, delivery }.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["requestId", "text"],
    properties: {
      requestId: { ...REQUEST_ID, description: "The request, as bm_create_worker gave it." },
      text: { type: "string", minLength: 1, maxLength: DELIVERING_LIMITS.tellText, description: "The owner's words, verbatim, or the fact." },
      source: { type: "string", minLength: 1, maxLength: DELIVERING_LIMITS.tellSource, description: "Where it comes from: the owner's message, a document, a decision id." },
    },
  },
};

/**
 * The tools only a bound agent issued the creation tools has (design §16.6,
 * ADR-027 ship point C), run on the plugin server: they create agents, or
 * store and deliver what the agent built. The bound versions of `bm_report`,
 * `bm_review` and `bm_answers` take the builders' place on a bound agent's
 * list. An unbound agent — and one bound before ship point C — never lists
 * them.
 */
export const BOUND_SERVER_TOOLS: readonly ToolFace[] = [
  {
    name: "bm_create_worker",
    role: "manager",
    description:
      "Create the Worker of one new request of the owner: paseo-bm generates its requestId, creates the Worker in your folder with its labels, mode and tools, and gives it its first prompt — the request verbatim, the requestId, the repository, the size when the owner stated one, your id and the context you pass. Every call is a new request, a BM-NEW-REQUEST included. Returns JSON { workerId, requestId }.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request", "context"],
      properties: {
        request: { type: "string", minLength: 1, maxLength: CREATE_WORKER_LIMITS.request, description: "The owner's request, verbatim." },
        size: { type: "string", enum: TIERS, description: "Only when the owner stated the size; leave it out otherwise." },
        context: {
          type: "array",
          maxItems: CREATE_WORKER_LIMITS.contextItems,
          description: "Facts that bear on the request — the owner's goals, earlier decisions, precedents, related requests — each with its source. Facts, never how to do the work. An empty list when there are none.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fact", "source"],
            properties: {
              fact: { type: "string", minLength: 1, maxLength: CREATE_WORKER_LIMITS.fact },
              source: { type: "string", minLength: 1, maxLength: CREATE_WORKER_LIMITS.source, description: "Where the fact comes from: a message, a document, a decision id, a Worker id." },
            },
          },
        },
      },
    },
  },
  TELL_WORKER_FACE,
  BOUND_ANSWERS_TOOL,
  BOUND_REPORT_TOOL,
  QUESTIONS_FACE,
  BOUND_REVIEW_TOOL,
];

/** The faces only a creation-bound `role` lists (`BOUND_SERVER_TOOLS`), in the order its list shows them. */
export function boundToolFacesFor(role: ToolRole): ToolFace[] {
  return BOUND_SERVER_TOOLS.filter((candidate) => candidate.role === role);
}

/** The bound block tools that build before the plugin stores and delivers (`bm_report`, `bm_review`, `bm_answers`). */
export function boundBlockToolNamed(name: string): AgentTool | undefined {
  return [BOUND_REPORT_TOOL, BOUND_REVIEW_TOOL, BOUND_ANSWERS_TOOL].find((candidate) => candidate.name === name);
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
    description: "Build the BM-ANSWERS block for the owner's answers given in your chat: put it in your reply to the owner, and the plugin delivers it to the Worker (never send it yourself).",
    inputSchema: ANSWERS_SCHEMA,
    rules: answersRules,
    build: buildAnswers,
    kinds: () => ["BM-ANSWERS"],
  }),
];

/** The tools that run here, in this module: the block tools. */
export function toolsFor(role: ToolRole): AgentTool[] {
  return AGENT_TOOLS.filter((candidate) => candidate.role === role);
}

/** The faces the plugin server runs for `role` (they read or write plugin data), in the order an endpoint lists them. */
export function serverToolsFor(role: ToolRole): ToolFace[] {
  return [...ORCHESTRATOR_SERVER_TOOLS, ...WORKER_SERVER_TOOLS, ...MANAGER_SERVER_TOOLS].filter((candidate) => candidate.role === role);
}

/**
 * Every tool an endpoint lists for `role`, and the creation hook pre-approves:
 * for an agent bound with the creation tools (`bound`, design §16.6) its
 * creating tools first; then the Orchestrator's server-run tools, the role's
 * own tools, the Worker's server-run `bm_reply` and the Manager's server-run
 * `bm_decisions`.
 */
export function toolFacesFor(role: ToolRole, bound = false): ToolFace[] {
  const own = bound ? boundToolFacesFor(role) : [];
  // A bound tool of a builder's name (bm_report, bm_review, bm_answers) takes the builder's place.
  const taken = new Set(own.map((face) => face.name));
  return [
    ...own,
    ...[
      ...ORCHESTRATOR_SERVER_TOOLS.filter((candidate) => candidate.role === role),
      ...toolsFor(role),
      ...WORKER_SERVER_TOOLS.filter((candidate) => candidate.role === role),
      ...MANAGER_SERVER_TOOLS.filter((candidate) => candidate.role === role),
    ].filter((face) => !taken.has(face.name)),
  ];
}

export function toolNamed(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((candidate) => candidate.name === name);
}
