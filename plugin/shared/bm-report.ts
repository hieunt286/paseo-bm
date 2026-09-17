/**
 * Reader for the `BM-REPORT` and `BM-REVIEW` blocks the roles emit
 * (WP-204, Dashboard Design §6 "Bộ đọc BM-REPORT").
 *
 * The format is defined in `plugin/roles/worker.md` (Reporting) and
 * `plugin/roles/reviewer.md`. It is produced by a language model, so this
 * parser is deliberately forgiving: a missing field, an unknown field, a
 * different key case, several blocks in one message, or a block quoted back
 * inside a later message must never break a trace (REQ-050a). A field it
 * cannot read becomes `null`, which the Dashboard renders as "unknown" rather
 * than inventing a value.
 *
 * It is also a *consumed contract*: when the role instructions change the block
 * shape, this parser must change in the same commit and must keep reading the
 * previous shape (REQ-050b). The fixtures in
 * `test/plugin-bm-report.test.ts` are the enforcement.
 */
import type { GuardrailReport, ParsedReport, ParsedReview, ReportPhase, Tier } from "./contracts";

/** Values that mean "nothing here" in a block (roles/worker.md says to write `none`). */
const ABSENT_VALUES = new Set(["", "none", "n/a", "na", "-", "null", "nil"]);

const REPORT_MARKER = /^\s*>?\s*(?:[-*]\s*)?bm-report\s*$/i;
const REVIEW_MARKER = /^\s*>?\s*(?:[-*]\s*)?bm-review\b(.*)$/i;
const FENCE = /^\s*>?\s*(?:```|~~~)/;
const KEY_VALUE = /^\s*>?\s*([A-Za-z][A-Za-z0-9 _-]*)\s*:\s*(.*)$/;

/** Bead ids as `br` mints them: `bm-wp-201-cp6.1`, `repo-37g`, … (AGENTS.md). */
export const BEAD_ID = /^[a-z][a-z0-9]*-[a-z0-9][a-z0-9.-]*$/i;

const PHASES: readonly ReportPhase[] = [
  "received",
  "documents-done",
  "beads-done",
  "bead-implemented",
  "blocked",
  "finished",
];

const TIERS: readonly Tier[] = ["Small", "Medium", "Large"];

/** Strips a leading quote marker so a report quoted back still parses. */
function unquote(line: string): string {
  return line.replace(/^\s*>+\s?/, "");
}

function normalizeKey(key: string): string {
  return key.replace(/[\s_-]/g, "").toLowerCase();
}

/** `none`, `-`, `n/a` and the empty string all mean "no value" (REQ-050a). */
export function valueOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^`+|`+$/g, "").trim();
  if (ABSENT_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed === "" ? null : trimmed;
}

/**
 * Longest list value read. Group resolution is quadratic on crafted input
 * (review bm-wp-220-nvk.1: 40 KB of nested parentheses took 1.6 s), and no real
 * report comes close; a longer value is cut and its field marked incomplete.
 */
export const MAX_LIST_CHARS = 8000;

function cappedValue(raw: string | undefined): { value: string; cut: boolean } | null {
  const value = valueOrNull(raw);
  if (value === null) return null;
  if (value.length <= MAX_LIST_CHARS) return { value, cut: false };
  // Drop the piece the cut went through: `bm-wp-215-60a.435` cut to
  // `bm-wp-215-60a.4` would name a different, possibly real, bead.
  let end = MAX_LIST_CHARS;
  while (end > 0 && !/[\s,;]/.test(value[end - 1]!)) end -= 1;
  return { value: value.slice(0, end), cut: true };
}

/** A child shorthand such as `.2` or `.2.1`, written after a full id (delta 20260917 §5.1). */
const SHORTHAND_ID = /^\.\d+(?:\.\d+)*$/;
const CHILD_SUFFIX = /(?:\.\d+)+$/;

/** One list field read from a report. */
export interface BeadIdList {
  ids: string[];
  /**
   * False when a piece was neither a bead id, an expandable shorthand, nor an
   * absent value: the ids are then a lower bound of what the Worker meant.
   */
  complete: boolean;
}

/** Splits on commas, semicolons and whitespace, and strips wrapping punctuation. */
function listPieces(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((piece) => piece.replace(/^[`([]+|[`)\].,;:]+$/g, "").trim())
    .filter((piece) => piece !== "");
}

/**
 * Resolves `( … )` groups before splitting. A group holding only bead ids is
 * unwrapped (`(bm-wp-202-4xi.1).` is an id); any other group is a comment and
 * is dropped whole (`(epic)`, `(b2 fix: no-logging AC)` — the second one used
 * to count `no-logging` as a bead). Innermost groups first.
 */
function resolveGroups(value: string): string {
  let current = value;
  for (;;) {
    const next = current.replace(/\(([^()]*)\)/g, (_group, inner: string) => {
      const pieces = listPieces(inner);
      return pieces.length > 0 && pieces.every((piece) => BEAD_ID.test(piece)) ? ` ${inner} ` : " ";
    });
    if (next === current) return next;
    current = next;
  }
}

/**
 * Reads a bead-id list field. `.N` shorthand is expanded against the root of
 * the nearest full id before it (`x-gcj, x-gcj.1, .2` → `x-gcj.2`); a
 * shorthand with no full id before it is dropped and makes the list incomplete.
 */
export function parseBeadIdList(raw: string | undefined): BeadIdList {
  const read = cappedValue(raw);
  if (read === null) return { ids: [], complete: true };
  const value = read.value;
  const seen = new Set<string>();
  const ids: string[] = [];
  let root: string | null = null;
  let complete = !read.cut;
  for (const piece of listPieces(resolveGroups(value))) {
    let id: string | null = null;
    if (SHORTHAND_ID.test(piece)) {
      id = root === null ? null : `${root}${piece}`;
    } else if (BEAD_ID.test(piece)) {
      id = piece;
      root = piece.replace(CHILD_SUFFIX, "");
    } else if (ABSENT_VALUES.has(piece.toLowerCase())) {
      continue;
    }
    if (id === null) {
      complete = false;
      continue;
    }
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return { ids, complete };
}

/** Splits a list field on commas or whitespace and keeps only plausible bead ids. */
export function parseBeadIds(raw: string | undefined): string[] {
  return parseBeadIdList(raw).ids;
}

/** A skill directory name such as `feature-workflow` (roles/worker.md, `skillsUsed`). */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Reads `skillsUsed` (delta 20260917 §4.9): the skills the Worker loaded for
 * the request so far, comma-separated. Comment groups are handled like
 * bead-id lists. Items are split on commas and semicolons only, so prose
 * (`reviewing plan`, `some notes here`) is one item that is not a skill name:
 * it is dropped and the field is marked incomplete, rather than read as
 * several skills.
 */
export function parseSkillList(raw: string | undefined): { names: string[]; complete: boolean } {
  const read = cappedValue(raw);
  if (read === null) return { names: [], complete: true };
  const value = read.value;
  const seen = new Set<string>();
  const names: string[] = [];
  let complete = !read.cut;
  for (const part of resolveGroups(value).split(/[,;]+/)) {
    const item = part.replace(/^[\s`]+|[\s`.]+$/g, "");
    if (item === "" || ABSENT_VALUES.has(item.toLowerCase())) continue;
    if (!SKILL_NAME.test(item)) {
      complete = false;
      continue;
    }
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(item);
  }
  return { names, complete };
}

/** Splits a plain list field (file paths) without the bead-id filter. */
function parseList(raw: string | undefined): string[] {
  const value = valueOrNull(raw);
  if (value === null) return [];
  return value
    .split(/[\s,;]+/)
    .map((piece) => piece.replace(/^[`([]+|[`)\].,;]+$/g, "").trim())
    .filter((piece) => piece !== "");
}

function firstNumber(source: string, pattern: RegExp): number | null {
  const match = pattern.exec(source);
  if (match?.[1] === undefined) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the `guardrail:` line, which is prose with numbers in it:
 * `batch <id> reviews <n>/<max>; polish <n>/<max>; total <n>/<budget>; userAllowedExtra <n>`.
 *
 * Every number is optional. `raw` keeps the original text so the Dashboard can
 * show exactly what the Worker claimed next to what was observed (REQ-042c).
 */
export function parseGuardrail(raw: string | undefined): GuardrailReport | null {
  const value = valueOrNull(raw);
  if (value === null) return null;
  const batchId = /batch\s+([A-Za-z0-9._:-]+)/i.exec(value)?.[1] ?? null;
  const reviews = /reviews\s+(\d+)\s*\/\s*(\d+)/i.exec(value);
  const polish = /polish\s+(\d+)\s*\/\s*(\d+)/i.exec(value);
  const total = /total\s+(\d+)\s*\/\s*(\d+)/i.exec(value);
  return {
    batchId,
    batchReviews: reviews?.[1] === undefined ? null : Number.parseInt(reviews[1], 10),
    batchMax: reviews?.[2] === undefined ? null : Number.parseInt(reviews[2], 10),
    polish: polish?.[1] === undefined ? null : Number.parseInt(polish[1], 10),
    polishMax: polish?.[2] === undefined ? null : Number.parseInt(polish[2], 10),
    total: total?.[1] === undefined ? null : Number.parseInt(total[1], 10),
    budget: total?.[2] === undefined ? null : Number.parseInt(total[2], 10),
    userAllowedExtra: firstNumber(value, /userAllowedExtra\s+(\d+)/i),
    raw: value,
  };
}

function parsePhase(raw: string | undefined): ReportPhase | null {
  const value = valueOrNull(raw);
  if (value === null) return null;
  const normalized = value.toLowerCase().replace(/\s+/g, "-");
  return PHASES.find((phase) => normalized.startsWith(phase)) ?? null;
}

function parseTier(raw: string | undefined): Tier | null {
  const value = valueOrNull(raw);
  if (value === null) return null;
  const head = value.toLowerCase();
  return TIERS.find((tier) => head.startsWith(tier.toLowerCase())) ?? null;
}

/** Known report keys, normalised. Anything else is kept in `unparsedFields`. */
const REPORT_KEYS = new Map<string, keyof ParsedReport | "phase" | "tier" | "guardrail">([
  ["requestid", "requestId"],
  ["phase", "phase"],
  ["tier", "tier"],
  ["fileschanged", "filesChanged"],
  ["beadscreated", "beadsCreated"],
  ["beadsupdated", "beadsUpdated"],
  ["beadsclosed", "beadsClosed"],
  ["beadsready", "beadsReady"],
  ["reviewfindingsopen", "reviewFindingsOpen"],
  ["buildandtests", "buildAndTests"],
  ["skillsused", "skillsUsed"],
  ["blockers", "blockers"],
  ["guardrail", "guardrail"],
]);

interface RawBlock {
  fields: Map<string, string>;
  unknown: string[];
  /** Text after `BM-REVIEW` on the marker line, e.g. `BM-REVIEW STOPPED`. */
  markerSuffix: string;
}

/**
 * Splits a message into blocks. A block starts at a marker line and ends at the
 * next marker, a closing fence, or a line that is clearly prose (no `key:`).
 */
function extractBlocks(text: string, marker: RegExp): RawBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;

  for (const rawLine of lines) {
    const line = unquote(rawLine);
    const markerMatch = marker.exec(rawLine);
    if (markerMatch !== null) {
      if (current !== null) blocks.push(current);
      current = { fields: new Map(), unknown: [], markerSuffix: (markerMatch[1] ?? "").trim() };
      continue;
    }
    if (current === null) continue;
    if (FENCE.test(rawLine)) {
      // A fence right after the marker opens the block; a later one closes it.
      if (current.fields.size === 0 && current.unknown.length === 0) continue;
      blocks.push(current);
      current = null;
      continue;
    }
    if (line.trim() === "") continue;
    const kv = KEY_VALUE.exec(rawLine);
    if (kv === null) {
      // Prose ends the block: reports are a contiguous run of key: value lines.
      blocks.push(current);
      current = null;
      continue;
    }
    const key = normalizeKey(kv[1] ?? "");
    const value = kv[2] ?? "";
    if (REPORT_KEYS.has(key) || key === "batchid" || key === "verdict" || key === "blocking") {
      if (!current.fields.has(key)) current.fields.set(key, value);
    } else {
      current.unknown.push((kv[1] ?? "").trim());
      if (!current.fields.has(key)) current.fields.set(key, value);
    }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

export interface ParseContext {
  agentId: string;
  /** Timestamp of the message the block came in, used as the block's `at`. */
  at: string;
}

/**
 * Reads every `BM-REPORT` block in one message.
 *
 * Duplicates are dropped on `(agentId, phase, requestId, at)`: a Worker that
 * quotes its own earlier report back must not be counted twice (design §6).
 */
export function parseReports(text: string, context: ParseContext): ParsedReport[] {
  if (typeof text !== "string" || text === "") return [];
  const seen = new Set<string>();
  const out: ParsedReport[] = [];

  for (const block of extractBlocks(text, REPORT_MARKER)) {
    if (block.fields.size === 0) continue;
    const field = (key: string): string | undefined => block.fields.get(key);
    const lists = {
      beadsCreated: parseBeadIdList(field("beadscreated")),
      beadsUpdated: parseBeadIdList(field("beadsupdated")),
      beadsClosed: parseBeadIdList(field("beadsclosed")),
      beadsReady: parseBeadIdList(field("beadsready")),
    };
    const skills = parseSkillList(field("skillsused"));
    const report: ParsedReport = {
      agentId: context.agentId,
      at: context.at,
      requestId: valueOrNull(field("requestid")),
      phase: parsePhase(field("phase")),
      tier: parseTier(field("tier")),
      filesChanged: parseList(field("fileschanged")),
      beadsCreated: lists.beadsCreated.ids,
      beadsUpdated: lists.beadsUpdated.ids,
      beadsClosed: lists.beadsClosed.ids,
      beadsReady: lists.beadsReady.ids,
      reviewFindingsOpen: valueOrNull(field("reviewfindingsopen")),
      buildAndTests: valueOrNull(field("buildandtests")),
      skillsUsed: skills.names,
      blockers: valueOrNull(field("blockers")),
      guardrail: parseGuardrail(field("guardrail")),
      unparsedFields: [...new Set(block.unknown)],
      incompleteFields: [
        ...Object.entries(lists)
          .filter(([, list]) => !list.complete)
          .map(([name]) => name),
        ...(skills.complete ? [] : ["skillsUsed"]),
      ],
    };
    const key = `${report.agentId}::${report.phase ?? ""}::${report.requestId ?? ""}::${report.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(report);
  }
  return out;
}

/**
 * Reads every `BM-REVIEW` block in one message.
 *
 * `BM-REVIEW STOPPED` (the stop answer from bm-wq6) carries its verdict on the
 * marker line rather than in a field, so the suffix is read too.
 */
export function parseReviews(text: string, context: ParseContext): ParsedReview[] {
  if (typeof text !== "string" || text === "") return [];
  const out: ParsedReview[] = [];
  for (const block of extractBlocks(text, REVIEW_MARKER)) {
    const suffix = valueOrNull(block.markerSuffix);
    const verdict = valueOrNull(block.fields.get("verdict")) ?? suffix;
    if (verdict === null && block.fields.size === 0) continue;
    // reviewer.md lists findings as "- severity: blocking | non-blocking" lines,
    // which end the key/value block, so they are counted in the message text.
    // A `blocking: <n>` field, if a Reviewer writes one, still wins. Before this
    // the count was always null for real reviews.
    const blockingRaw = valueOrNull(block.fields.get("blocking"));
    const blockingCount =
      blockingRaw !== null
        ? firstNumber(blockingRaw, /(\d+)/)
        : block.fields.has("verdict")
          ? (text.match(/severity\s*:\s*blocking\b/gi) ?? []).length
          : null;
    out.push({
      agentId: context.agentId,
      at: context.at,
      batchId: valueOrNull(block.fields.get("batchid")),
      verdict,
      blockingCount,
    });
  }
  return out;
}

/**
 * `requestId` as it appears in prose, tolerating the markdown the agents
 * actually write.
 *
 * Relaxed after the WP-214 acceptance run: the strict form only matched the
 * `BM-REPORT` block. Real Manager and Worker messages write it as
 * "- `requestId`: `req-20260916T064147Z`", and the backticks made the old
 * pattern miss it, which cost the trace its `exact` linking.
 */
export const REQUEST_ID_PATTERN = /requestId[`*\s]*:[`*\s]*(req-[A-Za-z0-9TZ:_-]+)/i;

/** First `requestId` in a piece of text, or null. */
export function requestIdFromText(text: string): string | null {
  if (typeof text !== "string") return null;
  const found = REQUEST_ID_PATTERN.exec(text)?.[1] ?? null;
  return found === null ? null : found.replace(/[`*]+$/, "");
}

/** True when a message is a role report rather than a user request (design §6 step 2). */
export function looksLikeReport(text: string): boolean {
  return typeof text === "string" && text.split(/\r?\n/).some((line) => REPORT_MARKER.test(line));
}
