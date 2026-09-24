/**
 * Strict template check of the `BM-*` blocks agents send each other
 * (delta 20260918g §4.6, REQ-061 e, owner decisions Q2 a and Q7 a).
 *
 * The readers in `bm-report.ts` and `bm-questions.ts` are tolerant on purpose:
 * they recover what they can from a sloppy block, because a card that shows
 * something beats one that shows nothing. This module is the other half: it
 * says exactly where a block departs from the templates in `plugin/roles/*.md`
 * (BM-REPORT and BM-QUESTIONS in worker.md, BM-ANSWERS in manager.md,
 * BM-REVIEW in reviewer.md), so the sender can be told and the user can see it.
 * Every rule below comes from those templates and nothing else.
 *
 * Issue messages are English: they are sent back to agents.
 *
 * Pure and environment-neutral: no Node API, no React; the client (card chip)
 * and the server (BM-FORMAT notice) import it alike.
 */
import { BEAD_ID } from "./bm-report";

export type BlockKind = "BM-REPORT" | "BM-QUESTIONS" | "BM-ANSWERS" | "BM-REVIEW";

export interface FormatIssue {
  kind: BlockKind;
  /** The field or question the issue is about; null for the block as a whole. */
  field: string | null;
  message: string;
}

export interface CheckedBlock {
  kind: BlockKind;
  requestId: string | null;
  /** The block's own lines, as sent. */
  text: string;
  issues: FormatIssue[];
}

/** Longest message checked; the rest is reported as not checked. */
export const MAX_CHECKED_CHARS = 20_000;

const MARKER = /^(?:[-*]\s+)?(?:\*\*)?(BM-REPORT|BM-QUESTIONS|BM-ANSWERS|BM-REVIEW)(?:\*\*)?(\s+STOPPED)?\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const QUOTE = /^\s*>\s?/;
const FIELD = /^([A-Za-z][A-Za-z0-9]*):(?:\s(.*))?$/;
const REQUEST_ID = /^req-\d{8}T\d{6}Z$/;
const PLACEHOLDER = /^<[^>]*>$/;
const DASH = "(?:—|–|-)";

export const REPORT_FIELDS = [
  "requestId",
  "phase",
  "tier",
  "filesChanged",
  "beadsCreated",
  "beadsUpdated",
  "beadsClosed",
  "beadsReady",
  "reviewFindingsOpen",
  "buildAndTests",
  "skillsUsed",
  "decided",
  "blockers",
] as const;
/** Fields a report may leave out: `decided` came later, and older Workers never write it. */
const OPTIONAL_REPORT_FIELDS: ReadonlySet<string> = new Set(["decided"]);
const PHASES = ["received", "beads-done", "blocked", "finished"];
const TIER_SHELL = /^(?:Small|Medium|Large) \(changed: ([\s\S]+)\)$/;
/**
 * The same shell with a note AFTER the closing parenthesis, which is what
 * worker.md literally says ("a short note after their structured part").
 * The inside may hold one level of parentheses, as `from Large (preliminary
 * guess), reason` does.
 */
const TIER_SHELL_THEN_NOTE = /^(?:Small|Medium|Large) \(changed: ((?:[^()]|\([^()]*\))+)\)\s*[—–\-,;:.]\s*\S[\s\S]*$/;
/** `no`, optionally followed by a note. */
const TIER_NO = /^no(?:[\s—–\-,;(][\s\S]*)?$/;
/** `from <tier>`, an optional parenthetical, an optional `reason:` label, then a non-empty reason. */
const TIER_FROM = /^from (?:Small|Medium|Large)(?![A-Za-z])(?:\s*\([^()]*\))?\s*[,—–-]?\s*(?:reason:\s*)?[^\s,—–-][\s\S]*$/;
const BEAD_FIELDS = new Set(["beadsCreated", "beadsUpdated", "beadsClosed", "beadsReady"]);
const SKILL = /^[a-z0-9][a-z0-9-]*$/i;
/** `b<n>: <finding>`; up to two short label words may sit before the colon (`b1 re-review: …`). */
const FINDING_OPEN = /^b\d+(?: [A-Za-z][\w-]*){0,2}: \S[\s\S]*$/;
const BLOCKERS_QUESTIONS = new RegExp(`^(\\d+) questions?: (Q\\d+(?:, Q\\d+)*) ${DASH} see BM-QUESTIONS\\b`);

const REVIEW_FIELDS = ["requestId", "batchId", "reviewKind", "verdict", "checked", "findings", "notChecked"] as const;
/** The free-text fields of BM-REVIEW: their value may run over several indented lines. */
const PROSE_REVIEW_FIELDS = new Set(["checked", "notChecked"]);
const FINDING_FIELDS = ["severity", "location", "reason", "suggestedFix"] as const;

const QUESTION = /^Q(\d+): \S.*$/;
const OPTION = /^- ([a-z]): \S.*$/;
const RECOMMENDED = /\(recommended\)\s*$/;
const ANSWER = new RegExp(`^Q(\\d+): (?:[a-z]|other) ${DASH} \\S.*$`);

const isNone = (value: string) => value.trim().toLowerCase() === "none";
/** `none`, on its own or followed by a note — what `blockers:` already allows in worker.md. */
const isNoneWithNote = (value: string) => /^none(?:[\s—–\-,;(:][\s\S]*)?$/i.test(value.trim());

/**
 * `text` split on `separator`, ignoring separators inside `(...)`.
 *
 * A finding's own text carries parentheses that carry semicolons ("(security
 * trade-off, needs Q6); b1: …" was one real value), and a blind split turned
 * the tail of one item into two items that named no batch.
 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Does `tier` follow the template? `Small|Medium|Large (changed: …)`, where the
 * inside is `no` or `from <tier>` plus a reason, either of which may carry a
 * short note — worker.md allows exactly that on `blockers:` one line below, and
 * 3 of the 9 malformed reports of the 2026-09-23 diagnosis were notes agents
 * read the template as inviting.
 */
function tierIsWellFormed(tier: string): boolean {
  // A note inside the parentheses, or after them: both read as the template does.
  for (const shell of [TIER_SHELL.exec(tier), TIER_SHELL_THEN_NOTE.exec(tier)]) {
    if (shell === null) continue;
    const inside = shell[1]!;
    if (TIER_NO.test(inside) || TIER_FROM.test(inside)) return true;
  }
  return false;
}

/** The block marker of a line (quote stripped), or null. */
function markerOf(line: string): { kind: BlockKind; bare: boolean; stopped: boolean } | null {
  const match = MARKER.exec(line.trim());
  if (match === null) return null;
  const kind = match[1] as BlockKind;
  const stopped = match[2] !== undefined;
  const bare = line.trim() === (stopped ? "BM-REVIEW STOPPED" : kind);
  return { kind, bare, stopped };
}

/** Does `line` belong to a block of this kind (used to tell a stray blank line from the block's end)? */
function continues(kind: BlockKind, line: string): boolean {
  switch (kind) {
    case "BM-REPORT":
      return FIELD.test(line) && (REPORT_FIELDS as readonly string[]).includes(FIELD.exec(line)![1]!);
    case "BM-QUESTIONS":
      return /^Q\d+:/.test(line) || /^- [a-z]:/.test(line);
    case "BM-ANSWERS":
      return /^Q\d+:/.test(line);
    case "BM-REVIEW":
      return /^\s+\S/.test(line) || /^- severity:/.test(line) || (FIELD.test(line) && (REVIEW_FIELDS as readonly string[]).includes(FIELD.exec(line)![1]!));
  }
}

interface RawBlock {
  kind: BlockKind;
  stopped: boolean;
  bare: boolean;
  lines: string[];
  blankInside: boolean;
  template: boolean;
}

/** Fields whose template value lists the allowed choices (`received | beads-done | …`). */
const CHOICE_FIELDS = new Set(["phase", "tier", "reviewKind", "verdict", "severity"]);

/** A line that shows the format rather than fills it: a `<placeholder>`, or a choice field listing `a | b`. */
function isTemplateLine(line: string): boolean {
  const field = FIELD.exec(line.replace(/^\s*-?\s*/, ""));
  if (field === null) return false;
  const value = (field[2] ?? "").trim();
  return PLACEHOLDER.test(value) || (CHOICE_FIELDS.has(field[1]!) && /\S\s\|\s\S/.test(value));
}

/** Splits a message into its BM-* blocks. */
function blocksOf(message: string): RawBlock[] {
  const lines = message.split(/\r?\n/).map((line) => line.replace(QUOTE, ""));
  const blocks: RawBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const marker = markerOf(lines[index]!);
    if (marker === null) {
      index += 1;
      continue;
    }
    const block: RawBlock = { kind: marker.kind, stopped: marker.stopped, bare: marker.bare, lines: [], blankInside: false, template: false };
    index += 1;
    if (!marker.stopped) {
      while (index < lines.length) {
        const line = lines[index]!;
        if (FENCE.test(line) || markerOf(line) !== null) break;
        if (line.trim() === "") {
          let next = index + 1;
          while (next < lines.length && lines[next]!.trim() === "") next += 1;
          if (next < lines.length && !FENCE.test(lines[next]!) && markerOf(lines[next]!) === null && continues(block.kind, lines[next]!)) {
            if (block.kind !== "BM-REVIEW") block.blankInside = true;
            index = next;
            continue;
          }
          break;
        }
        if (isTemplateLine(line)) block.template = true;
        block.lines.push(line);
        index += 1;
      }
    }
    if (!block.template) blocks.push(block);
  }
  return blocks;
}

/** `key: value` lines of a block, in order; other lines as `null` keys. */
function fieldsOf(lines: readonly string[]): Array<{ key: string | null; value: string; line: string }> {
  return lines.map((line) => {
    const match = FIELD.exec(line);
    return match === null ? { key: null, value: "", line } : { key: match[1]!, value: (match[2] ?? "").trim(), line };
  });
}

function shorten(line: string): string {
  const flat = line.trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

function checkReport(block: RawBlock, questions: RawBlock | undefined, issue: (field: string | null, message: string) => void): string | null {
  const fields = fieldsOf(block.lines);
  const seen = new Map<string, string>();
  const order: string[] = [];
  for (const { key, value, line } of fields) {
    if (key === null) {
      issue(null, `line "${shorten(line)}" is not a field of the template`);
      continue;
    }
    if (!(REPORT_FIELDS as readonly string[]).includes(key)) {
      issue(key, "is not a field of the template");
      continue;
    }
    if (seen.has(key)) {
      issue(key, "appears twice");
      continue;
    }
    seen.set(key, value);
    order.push(key);
  }
  for (const key of REPORT_FIELDS) if (!seen.has(key) && !OPTIONAL_REPORT_FIELDS.has(key)) issue(key, "is missing");
  const expected = REPORT_FIELDS.filter((key) => seen.has(key));
  const outOfPlace = order.findIndex((key, position) => key !== expected[position]);
  if (outOfPlace !== -1) {
    issue(null, `fields must follow the template order (${REPORT_FIELDS.join(", ")}); "${order[outOfPlace]}" is out of place`);
  }

  const requestId = seen.get("requestId");
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) issue("requestId", `must look like req-YYYYMMDDTHHMMSSZ (got "${shorten(requestId)}")`);
  const phase = seen.get("phase");
  if (phase !== undefined && !PHASES.includes(phase)) issue("phase", `must be one of ${PHASES.join(", ")} (got "${shorten(phase)}")`);
  const tier = seen.get("tier");
  if (tier !== undefined && !tierIsWellFormed(tier)) {
    issue("tier", 'must be "Small|Medium|Large (changed: no)" or "… (changed: from <tier>, <reason>)"; a short note may follow either');
  }
  for (const key of BEAD_FIELDS) {
    const value = seen.get(key);
    if (value === undefined || isNone(value)) continue;
    if (value.trim() === "") {
      issue(key, "must be none or full bead ids separated by commas");
      continue;
    }
    const bad = value.split(",").map((part) => part.trim()).filter((part) => !BEAD_ID.test(part) || /^\.\d/.test(part));
    if (bad.length > 0) issue(key, `must be none or full bead ids separated by commas ("${shorten(bad[0]!)}" is not one)`);
  }
  const skills = seen.get("skillsUsed");
  if (skills !== undefined && !isNone(skills) && skills.split(",").some((part) => !SKILL.test(part.trim()))) {
    issue("skillsUsed", "must be none or skill names separated by commas");
  }
  const findings = seen.get("reviewFindingsOpen");
  if (findings !== undefined && !isNoneWithNote(findings) && splitTopLevel(findings, ";").some((part) => !FINDING_OPEN.test(part.trim()))) {
    issue("reviewFindingsOpen", 'must be none or "b<n>: <finding>" items separated by ";" — write none when no finding is open');
  }
  for (const key of ["filesChanged", "buildAndTests", "decided", "blockers"]) {
    if (seen.get(key) === "") issue(key, "is empty; write none");
  }

  if (phase === "blocked") {
    if (questions === undefined) {
      issue(null, "a blocked report must be followed by a BM-QUESTIONS block in the same message");
    } else {
      const ids = questionIds(questions);
      const match = BLOCKERS_QUESTIONS.exec(seen.get("blockers") ?? "");
      const listed = match === null ? null : match[2]!.split(", ");
      if (match === null || Number(match[1]) !== listed!.length || listed!.join(",") !== ids.join(",")) {
        issue("blockers", `must start "${ids.length} ${ids.length === 1 ? "question" : "questions"}: ${ids.join(", ")} — see BM-QUESTIONS"`);
      }
    }
  }
  return requestId ?? null;
}

function questionIds(block: RawBlock): string[] {
  return block.lines.map((line) => QUESTION.exec(line)).filter((match) => match !== null).map((match) => `Q${match![1]}`);
}

function checkQuestions(block: RawBlock, reportRequestId: string | null, issue: (field: string | null, message: string) => void): string | null {
  const [first, ...rest] = block.lines;
  const head = first === undefined ? null : FIELD.exec(first);
  let requestId: string | null = null;
  if (head === null || head[1] !== "requestId") {
    issue("requestId", "must be the first line of the block");
  } else {
    requestId = (head[2] ?? "").trim();
    if (!REQUEST_ID.test(requestId)) issue("requestId", `must look like req-YYYYMMDDTHHMMSSZ (got "${shorten(requestId)}")`);
    else if (reportRequestId !== null && requestId !== reportRequestId) issue("requestId", `must equal the report's ${reportRequestId}`);
  }
  const body = head !== null && head[1] === "requestId" ? rest : block.lines;

  const questions: Array<{ id: string; number: number; options: string[] }> = [];
  for (const line of body) {
    const question = QUESTION.exec(line);
    if (question !== null) {
      questions.push({ id: `Q${question[1]}`, number: Number(question[1]), options: [] });
      continue;
    }
    if (OPTION.test(line) && questions.length > 0) {
      questions.at(-1)!.options.push(line);
      continue;
    }
    issue(null, `line "${shorten(line)}" is neither "Q<n>: <question>" nor "- <letter>: <option>"`);
  }
  if (questions.length < 1 || questions.length > 5) issue(null, `needs 1 to 5 questions (found ${questions.length})`);
  const seen = new Set<string>();
  let previous = 0;
  for (const question of questions) {
    if (seen.has(question.id)) issue(question.id, "appears twice");
    else if (question.number <= previous) issue(question.id, `must come after Q${previous}: numbers go up`);
    seen.add(question.id);
    previous = Math.max(previous, question.number);
    if (question.options.length < 2) issue(question.id, `needs at least 2 options (found ${question.options.length})`);
    const letters = question.options.map((option) => OPTION.exec(option)![1]!);
    if (letters.some((letter, position) => letter !== String.fromCharCode(97 + position))) {
      issue(question.id, `option letters must run a, b, c… (found ${letters.join(", ")})`);
    }
    const recommended = question.options.filter((option) => RECOMMENDED.test(option)).length;
    if (recommended !== 1) issue(question.id, `needs exactly one option ending in (recommended) (found ${recommended})`);
  }
  return requestId;
}

function checkAnswers(block: RawBlock, issue: (field: string | null, message: string) => void): string | null {
  const [first, ...rest] = block.lines;
  const head = first === undefined ? null : FIELD.exec(first);
  let requestId: string | null = null;
  if (head === null || head[1] !== "requestId") issue("requestId", "must be the first line of the block");
  else {
    requestId = (head[2] ?? "").trim();
    if (!REQUEST_ID.test(requestId)) issue("requestId", `must look like req-YYYYMMDDTHHMMSSZ (got "${shorten(requestId)}")`);
  }
  const body = head !== null && head[1] === "requestId" ? rest : block.lines;
  const seen = new Set<string>();
  for (const line of body) {
    const answer = ANSWER.exec(line);
    if (answer === null) {
      issue(null, `line "${shorten(line)}" must be "Q<n>: <letter> — <option>" or "Q<n>: other — <words>"`);
      continue;
    }
    const id = `Q${answer[1]}`;
    if (seen.has(id)) issue(id, "is answered twice");
    seen.add(id);
  }
  if (seen.size === 0) issue(null, "answers no question");
  return requestId;
}

function checkReview(block: RawBlock, issue: (field: string | null, message: string) => void): string | null {
  if (block.stopped) return null;
  const seen = new Map<string, string>();
  const findings: Array<Map<string, string>> = [];
  let inFindings = false;
  let lastField: string | null = null;
  for (const line of block.lines) {
    const item = /^- ([A-Za-z]+):(?:\s(.*))?$/.exec(line);
    const nested = /^\s+([A-Za-z]+):(?:\s(.*))?$/.exec(line);
    if (inFindings && item !== null) {
      findings.push(new Map([[item[1]!, (item[2] ?? "").trim()]]));
      continue;
    }
    if (inFindings && nested !== null && findings.length > 0) {
      findings.at(-1)!.set(nested[1]!, (nested[2] ?? "").trim());
      continue;
    }
    // An indented line continues the prose field above it. reviewer.md shows
    // `checked:` and `notChecked:` as free text and never says they must fit one
    // line; on 2026-09-22 a review that listed its seven fixes one per indented
    // line was told each was "not a field", and the re-send lost the list.
    if (!inFindings && PROSE_REVIEW_FIELDS.has(lastField ?? "") && /^\s+\S/.test(line)) continue;
    const field = FIELD.exec(line);
    if (field === null) {
      issue(null, `line "${shorten(line)}" is not a field of the template`);
      continue;
    }
    const key = field[1]!;
    lastField = key;
    inFindings = key === "findings";
    if (!(REVIEW_FIELDS as readonly string[]).includes(key)) issue(key, "is not a field of the template");
    else if (seen.has(key)) issue(key, "appears twice");
    else seen.set(key, (field[2] ?? "").trim());
  }
  for (const key of REVIEW_FIELDS) if (!seen.has(key)) issue(key, "is missing");
  const requestId = seen.get("requestId");
  if (requestId !== undefined && !REQUEST_ID.test(requestId)) issue("requestId", `must look like req-YYYYMMDDTHHMMSSZ (got "${shorten(requestId)}")`);
  const batchId = seen.get("batchId");
  if (batchId !== undefined && !/^b\d+$/.test(batchId)) issue("batchId", `must look like b<n> (got "${shorten(batchId)}")`);
  const kind = seen.get("reviewKind");
  if (kind !== undefined && kind !== "first" && kind !== "re-review") issue("reviewKind", "must be first or re-review");
  const verdict = seen.get("verdict");
  if (verdict !== undefined && verdict !== "pass" && verdict !== "changes-required") issue("verdict", "must be pass or changes-required");

  const listed = seen.get("findings");
  if (listed !== undefined) {
    if (isNone(listed) && findings.length > 0) issue("findings", "says none but lists findings");
    if (!isNone(listed) && listed !== "") issue("findings", 'must be "none" or be followed by "- severity: …" items');
    if (listed === "" && findings.length === 0) issue("findings", 'lists no finding; write "findings: none"');
  }
  findings.forEach((finding, position) => {
    const name = `finding ${position + 1}`;
    for (const key of FINDING_FIELDS) if (!finding.has(key) || finding.get(key) === "") issue(name, `is missing "${key}"`);
    for (const key of finding.keys()) if (!(FINDING_FIELDS as readonly string[]).includes(key)) issue(name, `has an unknown field "${key}"`);
    const severity = finding.get("severity");
    if (severity !== undefined && severity !== "blocking" && severity !== "non-blocking") issue(name, "severity must be blocking or non-blocking");
  });
  const blocking = findings.some((finding) => finding.get("severity") === "blocking");
  if (verdict === "pass" && blocking) issue("verdict", "must be changes-required: a finding is blocking");
  if (verdict === "changes-required" && !blocking) issue("verdict", "must be pass: no finding is blocking");
  return requestId ?? null;
}

/**
 * Every BM-* block of a message, in order, each with its template issues.
 * Blocks that only show the format (a `<placeholder>` or `a | b` choices) are
 * left out. Never throws.
 */
export function checkBlocks(message: unknown): CheckedBlock[] {
  try {
    if (typeof message !== "string" || message === "") return [];
    const tooLong = message.length > MAX_CHECKED_CHARS;
    const raw = blocksOf(tooLong ? message.slice(0, MAX_CHECKED_CHARS) : message);
    let reportRequestId: string | null = null;
    const out = raw.map((block, position): CheckedBlock => {
      const issues: FormatIssue[] = [];
      const issue = (field: string | null, text: string) => issues.push({ kind: block.kind, field, message: text });
      if (!block.bare) issue(null, `the block must start with the bare line ${block.stopped ? "BM-REVIEW STOPPED" : block.kind}`);
      if (block.blankInside) issue(null, "has a blank line inside; the template has none");
      let requestId: string | null = null;
      switch (block.kind) {
        case "BM-REPORT": {
          const next = raw[position + 1];
          requestId = checkReport(block, next?.kind === "BM-QUESTIONS" ? next : undefined, issue);
          reportRequestId = requestId;
          break;
        }
        case "BM-QUESTIONS":
          requestId = checkQuestions(block, raw[position - 1]?.kind === "BM-REPORT" ? reportRequestId : null, issue);
          break;
        case "BM-ANSWERS":
          requestId = checkAnswers(block, issue);
          break;
        case "BM-REVIEW":
          requestId = checkReview(block, issue);
          break;
      }
      return { kind: block.kind, requestId, text: [block.stopped ? "BM-REVIEW STOPPED" : block.kind, ...block.lines].join("\n"), issues };
    });
    if (tooLong && out.length > 0) {
      const last = out.at(-1)!;
      last.issues.push({ kind: last.kind, field: null, message: `message too long to check in full (over ${MAX_CHECKED_CHARS} characters)` });
    }
    return out;
  } catch {
    return [];
  }
}

/** `BM-REPORT phase: must be …` — one line per issue, as the card lists them. */
export function issueText(issue: FormatIssue): string {
  return issue.field === null ? `${issue.kind}: ${issue.message}` : `${issue.kind} ${issue.field}: ${issue.message}`;
}
