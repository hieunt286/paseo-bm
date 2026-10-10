/**
 * The agents' tools that build `BM-*` blocks (design delta 20260924b-agent-tools,
 * ADR-010): `bm_report` for a Worker, `bm_review` for a Reviewer and
 * `bm_answers` for a Manager. The Orchestrator's workflow assessment tool is
 * retired (autonomy design §B.9).
 *
 * The Orchestrator's tools (design §5.2–§5.3, §6A, §6B.4; missions design
 * §9.1: `bm_projects`, `bm_missions`, `bm_request`, `bm_agent_messages`,
 * `bm_govern`, `bm_arbitrate`, `bm_create_main`, `bm_decisions`, `bm_ask_owner`, `bm_decide`,
 * `bm_direct_worker`, `bm_repo`, `bm_note`, `bm_findings`, `bm_why`) read
 * plugin data and repositories, record and answer decisions, record
 * commands and notes, and send commands, so they cannot be
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
import { REPORT_PHASES, WAITING_FOR_PREFIX, WAITING_ON_OWNER_PREFIX, WAITING_ON_PROJECT_PREFIX, checkBlocks, issueText, type BlockKind } from "./bm-format";
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
import { DECLARED_COMMAND_INTENTS, GOVERNOR_STEPS, MAX_COMMAND_BODY_CHARS, MAX_COMMAND_DECISION_ID_CHARS, MAX_COMMAND_RE_CHARS, MAX_COMMAND_WHY_CHARS } from "./orchestrator-command";

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
export function withoutNulls(value: unknown): unknown {
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
  /** A bound Worker's blocked report: the live peer links its request asked and waits on (design §7.17.3). */
  waitingOnPeers?: string[];
  /** What the project whose link the request answers needs to know; it goes in the `peer-reply`, never in the block. */
  forPeer?: string;
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
 * for: <the other request or Worker>`, then `waiting on project: <title>
 * (<linkId>), …` (`titleOf` names a link's project); null when it names none.
 */
function waitingText(input: Pick<ReportInput, "waitingOn" | "waitingFor" | "waitingOnPeers">, titleOf: (linkId: string) => string): string | null {
  const numbers = [...new Set((input.waitingOn ?? []).map(questionNumberOf))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const parts = [
    numbers.length === 0 ? null : `${WAITING_ON_OWNER_PREFIX} ${numbers.join(", ")}`,
    input.waitingFor === undefined || line(input.waitingFor) === "" ? null : `${WAITING_FOR_PREFIX} ${line(input.waitingFor)}`,
    (input.waitingOnPeers ?? []).length === 0 ? null : `${WAITING_ON_PROJECT_PREFIX} ${input.waitingOnPeers!.map((id) => `${line(titleOf(id))} (${id})`).join(", ")}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(". ");
}

function blockersText(input: ReportInput, titleOf: (linkId: string) => string): string {
  const ids = (input.questions ?? []).map((question) => question.id);
  const waiting = input.phase === "blocked" ? waitingText(input, titleOf) : null;
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

function buildReport(input: ReportInput, titleOf: (linkId: string) => string = (linkId) => linkId): string {
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
    `blockers: ${blockersText(input, titleOf)}`,
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
/** The Main's `bm_repo` (missions design §4): the same, plus `read`, a window of one file's lines. */
export const MAIN_REPO_ACTIONS = [...REPO_ACTIONS, "read"] as const;
export type MainRepoAction = (typeof MAIN_REPO_ACTIONS)[number];
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

/** A mission's id (`server/mission-store.ts` `MISSION_ID_PATTERN`, which this module cannot import). */
export const MISSION_ID_SOURCE = "^mis-[0-9a-f]{10}$";
const MISSION_ID: JsonSchema = { type: "string", pattern: MISSION_ID_SOURCE, description: "The mission's id (mis-…), as bm_missions gave it." };
/** The most figures `bm_govern` cites. */
export const GOVERN_MAX_FIGURES = 20;
/** `bm_arbitrate` and `bm_create_main` (missions design §9.6): their bounds. */
export const GOVERNOR_TOOL_LIMITS = { area: 300, reason: 500, goal: 4_000, name: 80, repos: 20, repo: 4_096, requestIds: 50 } as const;
/** `MISSION_CODE_SOURCE`, which this module defines further down, after the Orchestrator's faces read it. */
const GOVERNOR_CODE_SOURCE = "^[A-Z][A-Z0-9]{1,7}$";

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
    name: "bm_missions",
    role: "orchestrator",
    description:
      "The missions you govern: each open mission (closed ones too with closed: true), or the one missionId names, newest first — its code, name, current Main, charter (goal, repos, non-goals, done criteria, budget), roster (each request's repo, topic, state and Workers), its figures now against the owner's thresholds (crossed first), its ladder (each family's step 0-4, since when, the last action), its open m: cards for the owner and its open split suggestions (work its Main, on the owner's yes, says is a new mission: the fields bm_create_main takes). Read-only. Returns JSON.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        missionId: MISSION_ID,
        closed: { type: "boolean", description: "true lists the closed missions too." },
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
    name: "bm_govern",
    role: "orchestrator",
    description:
      "Tell a mission's current Main to fix its process: step nudge (re-plan or explain in one line), replan (its figures still hold after the window: re-plan now), or arbitrate (a call between missions). The plugin sends it as a BM-COMMAND from you on governor:<step>, with no effect: it approves nothing, and the Main decides how. Name the figures it is about (as bm_missions lists them): their values and thresholds are added to your text. Delivered to whichever Main holds the mission now, at its turn end; at most 12 per mission in 24 hours. Recorded in the mission's journal and on its ladder. Never to a Worker: its Main directs it. Returns text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["missionId", "step", "text"],
      properties: {
        missionId: MISSION_ID,
        step: { type: "string", enum: GOVERNOR_STEPS, description: "nudge | replan | arbitrate." },
        text: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: `What the Main should look at and do, in the language of its conversation with the owner; at most ${MAX_COMMAND_BODY_CHARS} characters with the figures' lines.` },
        figures: {
          type: "array",
          maxItems: GOVERN_MAX_FIGURES,
          items: { type: "string", minLength: 1, maxLength: 60 },
          description: "The figures it is about, by id (for example writersOnOneFile).",
        },
      },
    },
  },
  {
    name: "bm_arbitrate",
    role: "orchestrator",
    description:
      "Give one area of a repo to one of two open missions that both want it (a mission.conflict): the plugin records the call, adds it to both missions' journals and sends both Mains a BM-COMMAND from you on governor:arbitrate, with no effect — the owner keeps the area, the other leaves it and asks the owner mission with bm_ask_mission. When the call changes the losing mission's goal, give that goal: the owner is asked on an m: card of that mission and the plugin sets it when they apply it; nothing else changes a goal. A conflict you arbitrated is not raised again. Returns text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["missions", "workspaceId", "area", "owner", "reason"],
      properties: {
        missions: { type: "array", minItems: 2, maxItems: 2, items: MISSION_ID, description: "The two missions, as the mission.conflict event names them." },
        workspaceId: { ...WORKSPACE_ID, description: "The repo of the area, as the event names it." },
        area: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.area, description: "The area: a folder or a file of that repo (\".\" for the whole repo), as the event names it." },
        owner: { ...MISSION_ID, description: "The mission the area belongs to from now: one of the two." },
        reason: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.reason, description: "Why, in one or two sentences both Mains read." },
        goal: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.goal, description: "Only when the call changes it: the losing mission's goal as the call leaves it, for the owner to apply." },
      },
    },
  },
  {
    name: "bm_create_main",
    role: "orchestrator",
    description:
      "Split a mission: a new mission with its own Main in the Missions home, its name, code, goal and repos, and the requests you move to it from the source mission (their Workers report to the new Main). With the source mission's split cell delegated the plugin does it now; otherwise the owner is asked on an m: card of the source mission and the plugin does it when they apply it. Refused while the source's Main runs a turn, when a request to move is not on its roster, when the moved requests wrote an area another open mission works in, after 2 splits of one mission in 24 hours, or for a code an open mission holds. Both Mains are told. Returns text.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fromMissionId", "name", "code", "goal", "repos", "reason"],
      properties: {
        fromMissionId: { ...MISSION_ID, description: "The mission to split, as bm_missions gave it." },
        name: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.name, description: "The new mission's name." },
        code: { type: "string", pattern: GOVERNOR_CODE_SOURCE, description: "The new mission's short code: 2 to 8 capital letters or digits, a letter first." },
        goal: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.goal, description: "The new mission's goal." },
        repos: {
          type: "array",
          minItems: 1,
          maxItems: GOVERNOR_TOOL_LIMITS.repos,
          items: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.repo },
          description: "The repos the new mission works in: workspace ids or absolute folders.",
        },
        requestIds: { type: "array", maxItems: GOVERNOR_TOOL_LIMITS.requestIds, items: REQUEST_ID, description: "The source mission's requests to move to it, as bm_missions lists its roster." },
        reason: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.reason, description: "Why the mission splits, in one or two sentences both Mains and the owner read." },
      },
    },
  },
  {
    name: "bm_decisions",
    role: "orchestrator",
    description:
      "The owner's decisions as the plugin stores them: your own questions (o:…), the Workers' questions (q:…, their Mains' or the owner's to answer) and the fallback incidents (f:…), newest asked first, redacted. Each with its status (open, needs-confirmation, answered, superseded, withdrawn, expired), its class, its options and their effects, the answer (the owner's, a Main's, or yours with bm_decide and your reason), the grant it gave (effects, until when, used or not) and what the plugin delivered. Filter by project, request or status (unsettled: open or needs-confirmation). Read-only. Returns JSON.",
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
      "Put a decision to the owner (security, cost, a release, a large change of scope, anything irreversible or on real data): it is stored as a decision the owner answers in paseo-bm, with your recommendation. Give each option the effects it involves (information for the owner: no answer grants them) and, when choosing it should act at once, the command to a Main (never a Worker: the Main directs its Workers): the plugin then delivers that command itself with the owner's authority as soon as the owner picks it. For advice, an option may carry instead a change of the owner's settings (a precedent, an autonomy cell of this project, a coordination setting): the question then says what it applies, and the plugin applies it only when the owner picks it — never on a precedent's, the policy's or your answer. An answer in the owner's own words comes back to you as a BM-ANSWER notice. One open question per request: a new one replaces your open question of the same request (the answer names the replaced id) unless separate: true. Sends nothing to any agent now.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "question", "recommendation"],
      properties: {
        workspaceId: WORKSPACE_ID,
        requestId: { ...ID, description: "The request it is about; leave it out only for a decision about the whole project." },
        managerId: { ...ID, description: "The Main (or Manager) it is about, when it is about one." },
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
                description: "The command the plugin delivers to a Main, as a BM-COMMAND with the owner's authority, the moment the owner picks this option. Its text must not show an effect the option does not declare.",
                properties: {
                  to: { type: "string", enum: ["manager"], description: "manager: a Main (or a project's Manager). Never a Worker or a Reviewer." },
                  agentId: { ...ID, description: "The Main's agent id (bm_missions), or the project's Manager's (bm_projects)." },
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
      "Decide a fallback incident (f:…) for the owner, where the owner's policy delegates its class to you in that project. Choose the option the owner would, and give your reason in one line; the owner sees both. The plugin then runs the incident's action exactly as it runs the owner's choice. Refused, changing nothing, unless the incident is still open and its class is delegated in that project; a Worker's question (q:…) is its Main's or the owner's, and your own decisions (o:…) are always the owner's. An incident you leave stays open for the owner.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "optionKey", "reason"],
      properties: {
        decisionId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "The incident, f:<incidentId>, as bm_decisions gave it.",
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
    name: "bm_direct_worker",
    role: "orchestrator",
    description:
      "Stop a running Worker at once, on real risk: your command replaces its running turn. Only intent stop with interrupt: true, and only while a danger signal of that Worker is open or a family of its mission stands at step 4 on the governor's ladder (after your re-plan); anything else goes to its Main with bm_govern. The stop allows no effect. Authority: the owner's policy delegating reversible-technical in that project, the owner's own latest message in your chat, or decisionId (your decision the owner answered). Its Main gets a copy. Never a Reviewer, never a stored question's answer.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "workerId", "re", "intent", "command", "interrupt"],
      properties: {
        workspaceId: WORKSPACE_ID,
        workerId: { ...ID, description: "The Worker's agent id, as bm_missions, bm_projects or bm_agent_messages gave it." },
        requestId: { ...ID, description: "The request it is about, when it is about one." },
        re: { type: "string", minLength: 1, maxLength: MAX_COMMAND_RE_CHARS, description: "The subject, one line (for example: stop the push)." },
        intent: { type: "string", enum: ["stop"], description: "stop: the only intent this tool sends." },
        decisionId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_COMMAND_DECISION_ID_CHARS,
          description: "The id (o:…) of your decision the owner answered, when this stop carries out that answer.",
        },
        command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_BODY_CHARS, description: "What the Worker must stop, and what to do instead (wait for its Main): the body of the BM-COMMAND block." },
        why: { type: "string", minLength: 1, maxLength: MAX_COMMAND_WHY_CHARS, description: "Why, in one line." },
        interrupt: { type: "boolean", description: "true: the stop replaces the Worker's running turn. Required, and only true." },
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
      "Keep a short note about a project, or a mission, for later: what the owner decided, what to watch. Give workspaceId or missionId, not both. The 20 newest are kept per project or mission, and bm_projects (bm_missions for a mission) returns them, also to a new Orchestrator. replace: true clears those notes first. Sends nothing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        workspaceId: WORKSPACE_ID,
        missionId: MISSION_ID,
        text: { type: "string", minLength: 1, maxLength: MAX_NOTE_CHARS, description: `The note, at most ${MAX_NOTE_CHARS} characters.` },
        replace: { type: "boolean", description: "true empties the project's (or the mission's) notes before adding this one." },
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
export const DELIVERING_LIMITS = { waitingFor: 500, waitingOn: 10, waitingOnPeers: 10, forPeer: 4_000, questions: 5, tellText: 8_000, tellSource: 300, grantCalls: 10 } as const;
/** A peer link id: `peer-` + 12 hex digits. */
export const PEER_LINK_ID_SOURCE = "^peer-[0-9a-f]{12}$";
/** An open peer link a Manager gives the request (design §7.17.3). */
const PEER_LINK: JsonSchema = {
  type: "string",
  pattern: PEER_LINK_ID_SOURCE,
  description: "An open peer link (BM-DELIVERY peer) this request takes: its Worker answers it with forPeer. Only for a Worker with paseo-bm's tools.",
};
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
    waitingOnPeers: {
      type: "array",
      minItems: 1,
      maxItems: DELIVERING_LIMITS.waitingOnPeers,
      items: { type: "string", pattern: PEER_LINK_ID_SOURCE },
      description: "Only when blocked, and only when nothing else can go on: the live links your request asked with bm_ask_project that you wait on.",
    },
    forPeer: {
      type: "string",
      minLength: 1,
      maxLength: DELIVERING_LIMITS.forPeer,
      description: "Required on finished when your first prompt has a peer: line: what that project needs to know. paseo-bm delivers it to the project.",
    },
  },
};

function boundReportRules(input: ReportInput): string[] {
  const out = tierRules(input);
  const waits = (input.waitingOn?.length ?? 0) > 0 || input.waitingFor !== undefined || (input.waitingOnPeers?.length ?? 0) > 0;
  if (input.phase === "blocked" && !waits) {
    out.push("input.waitingOn: a blocked report names what it waits on: waitingOn (open questions from bm_questions), waitingFor (another request or Worker) or waitingOnPeers (links you asked)");
  }
  for (const field of ["waitingOn", "waitingFor", "waitingOnPeers"] as const) {
    if (input.phase !== "blocked" && input[field] !== undefined) out.push(`input.${field}: only a blocked report waits; leave it out`);
  }
  (input.waitingOn ?? []).forEach((id, index) => {
    if (!id.startsWith(`q:${input.requestId}:`)) out.push(`input.waitingOn[${index}]: ${id} is not a question of ${input.requestId}`);
  });
  return out;
}

/**
 * `bm_report` for a bound Worker: built and checked as the builder's, then
 * stored and delivered by the plugin. `titleOf` names the project of each
 * `waitingOnPeers` link in the `blockers` line (the link id alone by default).
 */
export function boundReportTool(titleOf?: (linkId: string) => string): AgentTool {
  return tool<ReportInput>({
    name: "bm_report",
    role: "worker",
    description:
      "Report to your Manager: paseo-bm builds your BM-REPORT, stores it and delivers it to the Manager that created you, at its next idle moment. phase: received first, beads-done, blocked (with waitingOn, waitingFor or waitingOnPeers), finished when the request is done, stopped when your run was stopped. Ask the owner with bm_questions, never here. Returns JSON { recordId, delivery } — delivery sent, queued (the Manager is busy; it arrives at its next idle moment) or dropped.",
    inputSchema: BOUND_REPORT_SCHEMA,
    rules: boundReportRules,
    build: (input) => buildReport(input, titleOf),
    kinds: () => ["BM-REPORT"],
    suffix: DELIVERED,
  });
}
export const BOUND_REPORT_TOOL: AgentTool = boundReportTool();

/** The builder `bm_review` (an unbound Reviewer's): it returns the block to send. */
const REVIEW_BUILDER: AgentTool = tool<ReviewInput>({
  name: "bm_review",
  role: "reviewer",
  description: "Build your BM-REVIEW.",
  inputSchema: REVIEW_SCHEMA,
  rules: (input) =>
    (["checked", "notChecked"] as const).filter((key) => prose(input[key]) === "").map((key) => `input.${key}: has no text once code fences and quote marks are removed`),
  build: buildReview,
  kinds: () => ["BM-REVIEW"],
});

/** The builder `bm_answers` (an unbound Manager's): it returns the block to put in its reply. */
const ANSWERS_BUILDER: AgentTool = tool<AnswersInput>({
  name: "bm_answers",
  role: "manager",
  description: "Build the BM-ANSWERS block for the owner's answers given in your chat: put it in your reply to the owner, and the plugin delivers it to the Worker (never send it yourself).",
  inputSchema: ANSWERS_SCHEMA,
  rules: answersRules,
  build: buildAnswers,
  kinds: () => ["BM-ANSWERS"],
});

/** `bm_review` for a bound Reviewer: the builder's checks, then delivered to its Worker. */
export const BOUND_REVIEW_TOOL: AgentTool = {
  ...REVIEW_BUILDER,
  description: `Send your verdict: paseo-bm builds your BM-REVIEW of your batch, stores it and delivers it to the Worker that created you. Then end your turn with one line; do not repeat the review. Returns JSON { recordId, delivery }. ${DELIVERED}`,
};

/** `bm_answers` for a bound Manager: the owner's answers in its chat, proposed for this turn. */
export const BOUND_ANSWERS_TOOL: AgentTool = {
  ...ANSWERS_BUILDER,
  description: `Record the answers the owner gave to a Worker's open questions in your chat, in this turn. paseo-bm settles them when your turn ends, and only if this turn holds the owner's own message; the plugin then delivers them to the Worker. Never relay an answer as text. Only open questions (Qn) of a request of yours. Returns JSON { proposed: [Qn…] }. ${DELIVERED}`,
};

/** What `bm_questions` takes (design §16.6). */
export interface QuestionsInput {
  questions: Array<{
    text: string;
    subject: string;
    class: DecisionClass;
    supersedes?: string;
    /** A fact only the owner knows (missions design §5). */
    ownerOnly?: boolean;
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
  description: `Ask the owner: paseo-bm opens each question as a decision the owner answers in paseo-bm, numbers it after your request's last Qn, and delivers the answer to you when it comes. A question an owner precedent answers at once comes back answered: carry on with that answer. Then report blocked with waitingOn naming the open ones, unless you can carry on with what does not depend on them. Exactly one recommended option per question. A question of subject "${REVIEW_BUDGET_SUBJECT}" gives at least one option a grant ({ calls: n } or { untilClean: batchId }); leave it out on the option that grants nothing. Returns JSON [{ qn, decisionId, state, answer? }]. ${DELIVERED}`,
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
              description: `A short slug naming what is decided, such as push-backends: lowercase letters, digits and -, at most 60 characters. Keep it when you ask the same thing again; "${REVIEW_BUDGET_SUBJECT}" for more review calls.`,
            },
            class: CLASS_FIELD,
            supersedes: { ...QUESTION_ID, description: "The earlier question of this request that this one asks again, such as Q2; leave it out for a new question." },
            ownerOnly: {
              type: "boolean",
              description: "True when only the owner knows the answer: a login, an account or user id, a port of the owner's machine, a personal choice. Then only the owner answers it.",
            },
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
                    description: `Only on a "${REVIEW_BUDGET_SUBJECT}" question: what choosing this option grants — { calls: n } (1-${DELIVERING_LIMITS.grantCalls} more review calls) or { untilClean: "<batchId>" }. Leave it out on the option that grants nothing.`,
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
    // Design §16.8: the owner's yes to more review calls is the chosen option's grant; without one, answering grants nothing.
    if (question.subject === REVIEW_BUDGET_SUBJECT && !question.options.some((option) => option.grant !== undefined)) {
      out.push(`${path}.options: a "${REVIEW_BUDGET_SUBJECT}" question gives at least one option a grant ({ calls: n } or { untilClean: "<batchId>" }); without one, the owner's yes grants nothing`);
    }
    question.options.forEach((option, o) => {
      const at = `${path}.options[${o}]`;
      const expected = String.fromCharCode(97 + o);
      if (option.key !== expected) out.push(`${at}.key: must be ${expected} (keys run a, b, c … in order)`);
      if (RECOMMENDED_MARK.test(option.text)) out.push(`${at}.text: leave out "(recommended)"; set recommended: true instead`);
      if (option.effects.includes("none") && new Set(option.effects).size > 1) out.push(`${at}.effects: "none" stands alone; leave it out when the option has effects`);
      if (option.grant === undefined) return;
      if (question.subject !== REVIEW_BUDGET_SUBJECT) out.push(`${at}.grant: only a question of subject "${REVIEW_BUDGET_SUBJECT}" grants`);
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
      peerLink: PEER_LINK,
    },
  },
};

/** The bounds of `bm_create_reviewer` and `bm_rereview` (design §16.6). */
export const REVIEW_TOOL_LIMITS = { scope: 4_000, checks: 8_000, fixed: 4_000, stages: 3 } as const;
/** The stages a Reviewer can be asked to review (design §16.6). */
export const REVIEW_STAGES = ["implementation", "plan", "beads", "documents"] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** What `bm_create_reviewer` takes (design §16.6). */
export interface CreateReviewerInput {
  batchId: string;
  stages: ReviewStage[];
  scope: string;
  checks?: string;
}

/** `bm_create_reviewer`'s face (design §16.6): a bound Worker creates the Reviewer of one batch, within its request's review budget. */
export const CREATE_REVIEWER_FACE: ToolFace = {
  name: "bm_create_reviewer",
  role: "worker",
  description:
    "Create the Reviewer of one new batch of your request: paseo-bm checks your request's review budget, creates the Reviewer in your folder with its labels, mode and tools, and gives it its first prompt — the stages, the scope and the checks you ran. Its verdict reaches you as a delivery; you do not wait on it. Send your received report first. Refused, creating nothing, when the batch already has a Reviewer (use bm_rereview) or the budget is reached (ask the owner with bm_questions, subject review-budget). Returns JSON { reviewerId, batchId, reviewCalls }. " +
    DELIVERED,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["batchId", "stages", "scope"],
    properties: {
      batchId: { ...BATCH_ID, description: "The new batch: b1, b2, … in order." },
      stages: {
        type: "array",
        minItems: 1,
        maxItems: REVIEW_TOOL_LIMITS.stages,
        items: { type: "string", enum: REVIEW_STAGES },
        description: "What the Reviewer reviews in this batch: implementation, plan, beads, documents (one to three).",
      },
      scope: { type: "string", minLength: 1, maxLength: REVIEW_TOOL_LIMITS.scope, description: "What to review: the files, beads or documents, and the commit or diff." },
      checks: {
        type: "string",
        minLength: 1,
        maxLength: REVIEW_TOOL_LIMITS.checks,
        description: "Required with implementation: the checks you ran and their result.",
      },
    },
  },
};

/** What the schema cannot say about `bm_create_reviewer` (design §16.6); one line per problem. Pure. */
export function createReviewerRules(input: CreateReviewerInput): string[] {
  const out: string[] = [];
  if (new Set(input.stages).size !== input.stages.length) out.push("input.stages: name each stage once");
  if (input.stages.includes("implementation") && (input.checks === undefined || input.checks.trim() === "")) {
    out.push("input.checks: an implementation review needs the checks you ran and their result");
  }
  return out;
}

/** `bm_rereview`'s face (design §16.6): the batch's one re-review, within the review budget. */
export const REREVIEW_FACE: ToolFace = {
  name: "bm_rereview",
  role: "worker",
  description:
    "Ask a batch's Reviewer to check your fixes: paseo-bm delivers the re-review to that batch's Reviewer at its next idle moment, within your request's review budget. One re-review per batch unless the owner granted more. Returns JSON { reviewerId, delivery, reviewCalls }. " +
    DELIVERED,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["batchId", "fixed"],
    properties: {
      batchId: { ...BATCH_ID, description: "The batch bm_create_reviewer opened." },
      fixed: { type: "string", minLength: 1, maxLength: REVIEW_TOOL_LIMITS.fixed, description: "How each blocking finding was fixed." },
    },
  },
};

/** One fact passed on, with where it comes from (`bm_create_worker`, `bm_ask_project`). */
const CONTEXT_ITEM: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fact", "source"],
  properties: {
    fact: { type: "string", minLength: 1, maxLength: CREATE_WORKER_LIMITS.fact },
    source: { type: "string", minLength: 1, maxLength: CREATE_WORKER_LIMITS.source, description: "Where the fact comes from: a message, a document, a decision id, a Worker id." },
  },
};

/** The bounds of the peer tools (design §7.17.3). */
export const PEER_TOOL_LIMITS = { project: 4_096, request: 20_000, text: 8_000 } as const;

const PROJECT: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PEER_TOOL_LIMITS.project,
  description: "Another project: its workspace id, or an absolute folder of it (bm_peers lists them).",
};

/**
 * A Worker's ask of another project (design §7.17.3, ADR-028; missions design
 * §5), for its own request. A Main lists none (owner, 2026-10-10): it gives
 * the work a Worker in a repo of its mission, adds the repo, or asks another
 * mission (`bm_ask_mission`).
 */
const ASK_PROJECT_FACE: ToolFace = {
  name: "bm_ask_project",
  role: "worker",
  description: `Ask another project for work or an answer: paseo-bm stores the ask as a peer link and delivers it to that project's Manager (opening one when it has none) — or, for a Worker of a mission, to its own Main, who links it with the Worker on that work or gives it one there. Never message another project's agents yourself. Its reply reaches you as a BM-DELIVERY peer-reply; talk on the link with bm_peer_reply. Returns JSON { linkId, project, managerId, delivery, openedManager }. ${DELIVERED}`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["project", "request"],
    properties: {
      project: PROJECT,
      request: { type: "string", minLength: 1, maxLength: PEER_TOOL_LIMITS.request, description: "The ask in full: what is needed, why, and the contract you expect back." },
      kind: { type: "string", enum: ["work", "question"], description: "work (the default): the project does something; question: what reading answers." },
      context: { type: "array", maxItems: CREATE_WORKER_LIMITS.contextItems, items: CONTEXT_ITEM, description: "Facts the other project needs, each with its source." },
    },
  },
};

/**
 * The peer tools of a bound Manager or Worker (design §7.17.3, ADR-028): one
 * project asks another through paseo-bm, never with a raw agent message. Only
 * a Worker lists `bm_ask_project`.
 */
function peerFaces(role: "manager" | "worker"): ToolFace[] {
  return [
    {
      name: "bm_peers",
      role,
      description:
        "Read the other projects you can ask (Paseo workspaces, each with its live Manager) and this project's peer links both ways, newest first: who asked whom, the requests, the state and the newest message; a Main also reads the other open missions and its mission's links of every kind. project narrows the links to one project. Read-only. Returns JSON { projects, links } (a Main: and missions).",
      inputSchema: { type: "object", additionalProperties: false, properties: { project: PROJECT } },
    },
    ...(role === "worker" ? [ASK_PROJECT_FACE] : []),
    {
      name: "bm_peer_reply",
      role,
      description: `Write on a peer link you are a party to: paseo-bm delivers the text to the agent on the link's other side at its next idle moment. close: true closes the link after this message (decline an ask, or withdraw yours). Returns JSON { recordId, to, delivery, state }. ${DELIVERED}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["linkId", "text"],
        properties: {
          linkId: { ...PEER_LINK, description: "The link, peer-…, as bm_ask_project or the delivery gave it." },
          text: { type: "string", minLength: 1, maxLength: PEER_TOOL_LIMITS.text, description: "The message." },
          close: { type: "boolean", description: "True to close the link after this message." },
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The Main's mission tools (missions design §4; ADR-029), run by
// `server/mission-tools.ts`.
// ---------------------------------------------------------------------------

/** The bounds of the mission tools (missions design §2.1, §4). */
export const MISSION_TOOL_LIMITS = {
  name: 80,
  goal: 4_000,
  nonGoal: 300,
  nonGoals: 20,
  criterion: 500,
  evidence: 500,
  criteria: 20,
  plan: 20_000,
  contractTitle: 200,
  contractText: 4_000,
  contractSource: 300,
  contracts: 10,
  repos: 20,
  repo: 4_096,
} as const;
/** A mission's short code: 2 to 8 capital letters or digits, a letter first. */
export const MISSION_CODE_SOURCE = "^[A-Z][A-Z0-9]{1,7}$";

const MISSION_REPO: JsonSchema = { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.repo, description: "A repository: its workspace id, or its absolute folder." };
const MISSION_REPOS: JsonSchema = { type: "array", minItems: 1, maxItems: MISSION_TOOL_LIMITS.repos, items: MISSION_REPO };
const BUDGET_VALUE: JsonSchema = { type: "integer", minimum: 0 };

/** How long after a Worker's question its Main may still answer it (missions design §8 rule 2); then it is the owner's. */
export const MAIN_ANSWER_MINUTES = 10;

/** `bm_mission`, `bm_mission_start`, `bm_mission_update` and `bm_answer_worker`: a bound Manager lists them; only a Main can use them. */
export const MISSION_TOOL_FACES: readonly ToolFace[] = [
  {
    name: "bm_mission",
    role: "manager",
    description:
      "Read your mission: its charter (goal, repos, non-goals, done criteria, budget, whether the owner confirmed it), plan and contracts; each request of its roster with its repo, Worker, phase and newest report; your Workers' open questions and the mission's open owner cards (m:); the mission level; the newest 50 journal lines. Read-only. Returns JSON.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "bm_mission_start",
    role: "manager",
    description: `Record the mission the owner named — an unassigned Main's first act: its name, short code, goal and repositories, in the owner's words. Call it in the turn of the owner's answer: paseo-bm records the mission when that turn ends, only if the turn holds the owner's own message, and makes you its Main. Returns JSON { proposed }. ${DELIVERED}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "code", "goal", "repos"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.name, description: "The mission's name, as the owner gave it." },
        code: { type: "string", pattern: MISSION_CODE_SOURCE, description: "The owner's short code: 2 to 8 capital letters or digits, a letter first." },
        goal: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.goal, description: "The mission's goal, in the owner's words." },
        repos: { ...MISSION_REPOS, description: "The repositories the mission works in." },
      },
    },
  },
  {
    name: "bm_mission_update",
    role: "manager",
    description: `Change your mission. Written at once: plan (the whole text), contracts (add one, or a new version of one by id), a new done criterion, a criterion's status open or met (met with its evidence), and adding a repo when the mission level delegates scope-repo. Everything else — name, code, goal, nonGoals, budget, confirmCharter, close, removing a repo, rewording or dropping a criterion, adding a repo otherwise — opens one owner card (m:) with "apply" and "keep as is", which paseo-bm applies when the owner taps apply. Returns JSON { applied, decisionId }. ${DELIVERED}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.name },
        code: { type: "string", pattern: MISSION_CODE_SOURCE },
        goal: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.goal },
        nonGoals: {
          type: "array",
          maxItems: MISSION_TOOL_LIMITS.nonGoals,
          items: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.nonGoal },
          description: "The whole list of non-goals as it should be.",
        },
        doneCriteria: {
          type: "array",
          minItems: 1,
          maxItems: MISSION_TOOL_LIMITS.criteria,
          description: "Without id: a new criterion (text). With id: its new text, or its status — met needs evidence; dropped goes to the owner.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", pattern: "^D\\d{1,4}$" },
              text: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.criterion },
              status: { type: "string", enum: ["open", "met", "dropped"] },
              evidence: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.evidence, description: "What shows the criterion is met: a request, a report, a commit." },
            },
          },
        },
        budget: {
          type: "object",
          additionalProperties: false,
          description: "The whole budget as it should be; a field left out has no limit, an empty object removes the budget.",
          properties: { requests: BUDGET_VALUE, workers: BUDGET_VALUE, reviewCalls: BUDGET_VALUE, days: BUDGET_VALUE },
        },
        plan: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.plan, description: "The whole plan as it should be." },
        contracts: {
          type: "array",
          minItems: 1,
          maxItems: MISSION_TOOL_LIMITS.contracts,
          description: "Without id: a new contract (title, providerRepo, text, source). With id: its new version (text, source).",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "source"],
            properties: {
              id: { type: "string", pattern: "^C\\d{1,4}$" },
              title: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.contractTitle },
              providerRepo: MISSION_REPO,
              consumerRepos: { type: "array", maxItems: MISSION_TOOL_LIMITS.repos, items: MISSION_REPO },
              text: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.contractText },
              source: { type: "string", minLength: 1, maxLength: MISSION_TOOL_LIMITS.contractSource, description: "Where the contract comes from: a document, a decision, a request." },
            },
          },
        },
        repos: {
          type: "object",
          additionalProperties: false,
          properties: { add: MISSION_REPOS, remove: MISSION_REPOS },
        },
        confirmCharter: { type: "boolean", description: "True: ask the owner to confirm the charter as it stands." },
        close: { type: "boolean", description: "True: ask the owner to close the mission (refused while a Worker of it runs)." },
      },
    },
  },
  {
    name: "bm_answer_worker",
    role: "manager",
    description: `Answer your Workers' open questions (Qn) yourself, as the mission's Main, where paseo-bm lets you: a class the repo delegates, or one your mission level delegates (answer-technical: scope, preference, reversible-technical; answer-effects: the rest). In a shadow cell you may not decide, your choice is recorded as your recommendation and the owner decides. paseo-bm delivers your answer to the Worker as yours, never the owner's, and it grants nothing: an effect it allows still passes the repo's action boundary. Refused for an ownerOnly question, a question asked more than ${MAIN_ANSWER_MINUTES} minutes ago (it is the owner's then), a settled one, an option with a grant or a change, or a request outside your mission. Returns JSON [{ qn, decisionId, state }]. ${DELIVERED}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestId", "answers"],
      properties: {
        requestId: { ...REQUEST_ID, description: "The request of your mission whose questions you answer (bm_mission lists them)." },
        answers: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["qn", "option", "why"],
            properties: {
              qn: QUESTION_ID,
              option: { type: "string", pattern: "^[a-h]$", description: "The option you choose." },
              why: { type: "string", minLength: 1, maxLength: 300, description: "Why, in one line, from the mission's goal and plan." },
            },
          },
        },
      },
    },
  },
];

/**
 * `bm_split_mission` (missions design §9.6), run by `server/mission-split.ts`:
 * a bound Manager lists it; only a Main can use it. Its fields are
 * `bm_create_main`'s, bar the source mission, which is the caller's.
 */
export const MISSION_SPLIT_FACE: ToolFace = {
  name: "bm_split_mission",
  role: "manager",
  description: `Suggest to the governor (the Orchestrator) that work the owner gave belongs to a new mission: its name, short code, goal and repos, the requests of your mission that go with it, and why. Ask the owner first; call it only on their yes, never create the mission yourself. The governor decides: it creates the mission and its Main, or the owner is asked on a card. Refused for a code an open mission holds or one you suggested already, a repo Paseo does not list, a request not on your mission's roster, requests that wrote an area another open mission works in, or after 2 splits of your mission in 24 hours. Returns JSON { suggested, governor }. ${DELIVERED}`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "code", "goal", "repos", "reason"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.name, description: "The new mission's name, as the owner gave it." },
      code: { type: "string", pattern: MISSION_CODE_SOURCE, description: "The new mission's short code: 2 to 8 capital letters or digits, a letter first." },
      goal: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.goal, description: "The new mission's goal, in the owner's words." },
      repos: { ...MISSION_REPOS, maxItems: GOVERNOR_TOOL_LIMITS.repos, description: "The repositories the new mission works in." },
      requestIds: { type: "array", maxItems: GOVERNOR_TOOL_LIMITS.requestIds, items: REQUEST_ID, description: "The requests of your mission that belong to the new one, as bm_mission lists them." },
      reason: { type: "string", minLength: 1, maxLength: GOVERNOR_TOOL_LIMITS.reason, description: "Why it is another mission, in one or two sentences the governor and the owner read." },
    },
  },
};

// ---------------------------------------------------------------------------
// Project memory and the Main's bm_repo (missions design §2.5, §4, §5;
// ADR-029), run by `server/memory-tools.ts`.
// ---------------------------------------------------------------------------

/** The bounds of `bm_memory` and the Main's `bm_repo` (missions design §2.5, §4); `text` and `source` are the memory store's. */
export const MEMORY_TOOL_LIMITS = { text: 1_000, source: 300, query: 200, why: 300, from: 1_000_000, lines: 2_000 } as const;
/** What a Main adds to a repo's memory; a Worker adds the last three (§5). A `precedent` is the owner's, read through. */
export const MEMORY_ADD_KINDS = ["decision", "fact", "convention", "contract"] as const;
export const WORKER_MEMORY_KINDS = ["fact", "convention", "contract"] as const;

function memoryFace(role: "manager" | "worker"): ToolFace {
  const main = role === "manager";
  return {
    name: "bm_memory",
    role,
    description: main
      ? `Read or curate the project memory of a repo of your mission: what it decided, learnt and agreed, for the Workers and Mains after you. op read (query narrows it) lists its active entries and the owner's precedents; add stores one (kind, text, source); remove (id, why) retires one, its why in the mission's journal. At most 300 active entries a repo: past that, add is refused until you remove some. The owner's answers to your Workers' questions are added by paseo-bm. Returns JSON. ${DELIVERED}`
      : `Read or add to the project memory of your own repo: what it decided, learnt and agreed, for the Workers after you. op read (query narrows it) lists its active entries and the owner's precedents; add stores one fact, convention or contract (kind, text, source). Returns JSON. ${DELIVERED}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: main ? ["project", "op"] : ["op"],
      properties: {
        project: {
          type: "string",
          pattern: WORKSPACE_ID_SOURCE,
          description: main ? "The workspace id of a repo of your mission (bm_mission lists them)." : "Your own repo's workspace id; leave it out for your repo.",
        },
        op: { type: "string", enum: main ? ["read", "add", "remove"] : ["read", "add"] },
        query: { type: "string", minLength: 1, maxLength: MEMORY_TOOL_LIMITS.query, description: "read: only the entries whose text or source holds these words." },
        kind: { type: "string", enum: main ? MEMORY_ADD_KINDS : WORKER_MEMORY_KINDS, description: "add: what the entry is." },
        text: { type: "string", minLength: 1, maxLength: MEMORY_TOOL_LIMITS.text, description: "add: the entry, one self-contained statement." },
        source: { type: "string", minLength: 1, maxLength: MEMORY_TOOL_LIMITS.source, description: "add: where it comes from: a request, a decision id, a document, a commit." },
        ...(main
          ? {
              id: { type: "string", pattern: "^mem-[0-9a-f]{10}$", description: "remove: the entry, mem-…, as read gave it." },
              why: { type: "string", minLength: 1, maxLength: MEMORY_TOOL_LIMITS.why, description: "remove: why it no longer holds, in one line." },
            }
          : {}),
      },
    },
  };
}

/** `bm_memory` for a Main and a Worker, and the Main's `bm_repo`: a bound Manager lists them; only a Main can use its two. */
export const MEMORY_TOOL_FACES: readonly ToolFace[] = [
  memoryFace("manager"),
  {
    name: "bm_repo",
    role: "manager",
    description:
      "Check a repo of your mission for yourself, read-only: git status, the diff stat (staged and unstaged), the last 20 commits, one file (show: as committed with HEAD:<path>, or as it is now), or read: a window of a file's lines (path, from, lines). Only the repos of your mission's charter, inside their folders; no file whose name marks a secret, nothing git ignores. Nothing is written, fetched or pushed. Returns text, redacted and capped.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "action"],
      properties: {
        workspaceId: { ...WORKSPACE_ID, description: "The workspace id of a repo of your mission (bm_mission lists them)." },
        action: { type: "string", enum: MAIN_REPO_ACTIONS, description: "status | diff-stat | log | show (needs file) | read (needs path)." },
        path: { type: "string", minLength: 1, maxLength: 500, description: "read: the file, relative to the repo's folder. Otherwise a sub-folder to run in." },
        file: { type: "string", minLength: 1, maxLength: 500, description: "For show: a file relative to the folder, or HEAD:<file> for its committed version." },
        from: { type: "integer", minimum: 1, maximum: MEMORY_TOOL_LIMITS.from, description: "read: the first line, 1 by default." },
        lines: { type: "integer", minimum: 1, maximum: MEMORY_TOOL_LIMITS.lines, description: "read: how many lines, 400 by default." },
      },
    },
  },
  memoryFace("worker"),
];

// ---------------------------------------------------------------------------
// The Main's link tools (missions design §2.6, §4, §5), run by
// `server/peer-tools.ts`.
// ---------------------------------------------------------------------------

/** The bounds of the Main's link tools (missions design §4). */
export const MISSION_LINK_LIMITS = { topic: 2_000 } as const;

/** `bm_link_workers` and `bm_ask_mission`: a bound Manager lists them; only a Main can use them. */
export const MISSION_LINK_FACES: readonly ToolFace[] = [
  {
    name: "bm_link_workers",
    role: "manager",
    description: `Link two live Workers of your mission that must agree on something — in any repos, the same one included: paseo-bm opens a peer link between them (an open ask one of them made you becomes that link) and tells each who the other is and the topic; they talk on it with bm_peer_reply. Returns JSON { linkId, delivery }. ${DELIVERED}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["requestIds", "topic"],
      properties: {
        requestIds: { type: "array", minItems: 2, maxItems: 2, items: REQUEST_ID, description: "The two requests of your mission whose Workers talk, as bm_mission lists them." },
        topic: { type: "string", minLength: 1, maxLength: MISSION_LINK_LIMITS.topic, description: "What they must agree on." },
      },
    },
  },
  {
    name: "bm_ask_mission",
    role: "manager",
    description: `Ask another mission's Main for work or an answer: paseo-bm stores the ask as a peer link and delivers it to that Main, who answers with bm_peer_reply. Never message another mission's agents yourself. Returns JSON { linkId, mission, mainId, delivery }. ${DELIVERED}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mission", "text"],
      properties: {
        mission: { type: "string", pattern: MISSION_CODE_SOURCE, description: "The other mission's code (bm_peers lists the missions)." },
        text: { type: "string", minLength: 1, maxLength: PEER_TOOL_LIMITS.request, description: "The ask in full: what is needed, why, and the contract you expect back." },
        kind: { type: "string", enum: ["work", "question"], description: "work (the default): the mission does something; question: what reading answers." },
      },
    },
  },
];

/**
 * The tools only a bound agent has (design §16.6,
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
      "Create the Worker of one new request of the owner: paseo-bm generates its requestId, creates the Worker in your folder (a Main: in the repo `project` names) with its labels, mode and tools, and gives it its first prompt — the request verbatim (a size the owner stated stays in it), the requestId, the repository, your id and the context you pass. Every call is a new request, a BM-NEW-REQUEST included. Returns JSON { workerId, requestId }.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request", "context"],
      properties: {
        request: { type: "string", minLength: 1, maxLength: CREATE_WORKER_LIMITS.request, description: "The owner's request, verbatim: every sentence of it, a size or a review they asked for included." },
        context: {
          type: "array",
          maxItems: CREATE_WORKER_LIMITS.contextItems,
          description: "Facts that bear on the request — the owner's goals, earlier decisions, precedents, related requests — each with its source. Facts, never how to do the work. An empty list when there are none.",
          items: CONTEXT_ITEM,
        },
        peerLink: { ...PEER_LINK, description: `${PEER_LINK.description} request is then your own words of what you hand over.` },
        // Missions design §4: a Main creates its Workers in the repos of its mission.
        project: {
          type: "string",
          pattern: WORKSPACE_ID_SOURCE,
          description: "A Main only: the workspace id of the mission's repo the Worker works in (bm_mission lists them). Required when the mission has more than one repo.",
        },
        planStep: { type: "string", minLength: 1, maxLength: 300, description: "A Main only: where this request sits in the mission's plan, in one line." },
      },
    },
  },
  TELL_WORKER_FACE,
  BOUND_ANSWERS_TOOL,
  BOUND_REPORT_TOOL,
  QUESTIONS_FACE,
  CREATE_REVIEWER_FACE,
  REREVIEW_FACE,
  BOUND_REVIEW_TOOL,
  ...peerFaces("manager"),
  ...peerFaces("worker"),
  ...MISSION_TOOL_FACES,
  MISSION_SPLIT_FACE,
  ...MEMORY_TOOL_FACES,
  ...MISSION_LINK_FACES,
];

/** The faces only a creation-bound `role` lists (`BOUND_SERVER_TOOLS`), in the order its list shows them. */
export function boundToolFacesFor(role: ToolRole): ToolFace[] {
  return BOUND_SERVER_TOOLS.filter((candidate) => candidate.role === role);
}

// ---------------------------------------------------------------------------

export const AGENT_TOOLS: readonly AgentTool[] = [
  tool<ReportInput>({
    name: "bm_report",
    role: "worker",
    description: "Build your BM-REPORT (and its BM-QUESTIONS when blocked). It delivers nothing itself: write the block in your reply, as the last line of its answer says, and the plugin delivers it to the agent that created you (never send it yourself).",
    inputSchema: REPORT_SCHEMA,
    rules: reportRules,
    build: buildReport,
    kinds: (input) => (input.phase === "blocked" ? ["BM-REPORT", "BM-QUESTIONS"] : ["BM-REPORT"]),
    suffix: "Arguments are JSON: leave out a field you have nothing for. Returns the block. On error, fix the listed fields and call again.",
  }),
  REVIEW_BUILDER,
  ANSWERS_BUILDER,
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
 * for a bound agent (`bound`, design §16.6) its
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
