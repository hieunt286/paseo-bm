/**
 * Reader for the `BM-QUESTIONS` block a Worker puts right after its `blocked`
 * `BM-REPORT`, and writer of the `BM-ANSWERS` block that answers it
 * (delta 20260918c-question-cards §4.1–§4.3).
 *
 * Like the report reader next door, it reads what a language model wrote, so
 * it is forgiving: quoting, fences, bold ids, `(a)` instead of `a:`, wrapped
 * lines. What it cannot read it leaves out rather than guesses — a card
 * without buttons falls back to a free-text reply, while a guessed split could
 * put an option under the wrong question.
 *
 * Kept apart from `bm-report.ts` so the consumed `BM-REPORT` contract and its
 * fixtures do not change: a `BM-QUESTIONS` line has no `key:` shape, so it
 * already ends a report block there.
 *
 * Pure and environment-neutral: the chat card runs it on every message.
 */

export interface QuestionOption {
  /** Lowercase letter: `a`, `b`, … */
  key: string;
  text: string;
  recommended: boolean;
}

export interface Question {
  /** `Q<n>`; unique within one request, because Workers count on across rounds. */
  id: string;
  text: string;
  options: QuestionOption[];
}

export interface QuestionSet {
  requestId: string | null;
  questions: Question[];
}

/** One answer: an option's key, or the user's own words. */
export type Pick = { key: string } | { other: string };

/** Characters read from the marker on. The marker itself is found in the whole message. */
export const MAX_BLOCK_CHARS = 20_000;
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 8;
export const MAX_TEXT_CHARS = 1000;

const QUESTIONS_MARKER = /^\s*(?:>\s*)*(?:[-*]\s+)?(?:\*\*)?bm-questions(?:\*\*)?\s*$/i;
/** Any paseo-bm block start: the end of this block. */
const ANY_MARKER = /^\s*(?:>\s*)*(?:[-*]\s+)?(?:\*\*)?bm-(?:report|review|questions|answers)\b/i;
const FENCE = /^\s*(?:>\s*)*(?:```|~~~)/;
const QUOTE = /^\s*(?:>\s?)+/;
const REQUEST_ID = /^\s*(?:[-*]\s+)?requestId\s*:\s*(.*)$/i;
const QUESTION = /^\s*(?:[-*]\s+)?(?:\*\*)?Q(\d{1,3})(?:\*\*)?\s*[:.)]\s*(?:\*\*)?\s*(.*)$/;
/** `- a: …`, `- a) …`, `- a. …`, `- (a) …` */
const BULLET_OPTION = /^\s*[-*]\s+(?:\(([a-z])\)|([a-z])\s*[:.)])\s*(.*)$/i;
/** `(a) …`, `a) …` — without a bullet the parenthesis is required, so prose `a: …` is not an option. */
const PAREN_OPTION = /^\s*(?:\(([a-z])\)|([a-z])\))\s+(.*)$/i;
const RECOMMENDED = /\s*[([]\s*recommended\s*[)\]]/i;
const RECOMMENDED_ALL = new RegExp(RECOMMENDED.source, "gi");
const INDENTED = /^\s{2,}\S/;
const ABSENT = new Set(["", "none", "n/a", "na", "-", "null", "nil"]);

function cut(text: string): string {
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS - 1)}…`;
}

/** Appends a wrapped line, stopping once the text is already at its cap. */
function appended(text: string, more: string): string {
  if (text.length >= MAX_TEXT_CHARS) return text;
  return text === "" ? more : `${text} ${more}`;
}

function cleanRequestId(raw: string): string | null {
  const value = raw.trim().replace(/^[`*]+|[`*]+$/g, "").trim();
  return ABSENT.has(value.toLowerCase()) ? null : value;
}

interface Draft {
  id: string;
  text: string;
  options: Array<{ key: string; text: string }>;
}

function finish(draft: Draft): Question {
  const options = draft.options.map((option) => {
    const recommended = RECOMMENDED.test(option.text);
    return { key: option.key, text: cut(option.text.replace(RECOMMENDED_ALL, "").trim()), recommended };
  });
  // More than one recommendation is no recommendation: the card never picks.
  const marked = options.filter((option) => option.recommended).length;
  return {
    id: draft.id,
    text: cut(draft.text.replace(/\*\*/g, "").trim()),
    options: marked > 1 ? options.map((option) => ({ ...option, recommended: false })) : options,
  };
}

/**
 * The last `BM-QUESTIONS` block of a message, or null when it has none.
 *
 * The block follows a report that can be long, so the marker is looked for
 * across the whole message (one anchored test per line, linear); only the
 * reading from the marker on is capped at `MAX_BLOCK_CHARS`.
 */
export function parseQuestions(text: string): QuestionSet | null {
  if (typeof text !== "string" || text === "") return null;
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (QUESTIONS_MARKER.test(lines[index]!)) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;

  let requestId: string | null = null;
  const drafts: Draft[] = [];
  const seenIds = new Set<string>();
  /** Null before the first question and after a duplicate id, whose options are dropped with it. */
  let current: Draft | null = null;
  let budget = MAX_BLOCK_CHARS - lines[start]!.length - 1;
  let started = false;

  for (let index = start + 1; index < lines.length; index += 1) {
    const raw = lines[index]!;
    budget -= raw.length + 1;
    if (budget < 0) break;
    const line = raw.replace(QUOTE, "");
    if (line.trim() === "") continue;
    if (FENCE.test(raw)) {
      // A fence right after the marker opens the block; a later one closes it.
      if (!started) continue;
      break;
    }
    if (ANY_MARKER.test(raw)) break;

    const request = REQUEST_ID.exec(line);
    if (request !== null) {
      started = true;
      if (requestId === null) requestId = cleanRequestId(request[1] ?? "");
      continue;
    }

    const question = QUESTION.exec(line);
    if (question !== null) {
      started = true;
      const id = `Q${Number.parseInt(question[1]!, 10)}`;
      if (seenIds.has(id)) {
        current = null;
        continue;
      }
      if (drafts.length >= MAX_QUESTIONS) break;
      seenIds.add(id);
      current = { id, text: cut(question[2] ?? ""), options: [] };
      drafts.push(current);
      continue;
    }

    const option = BULLET_OPTION.exec(line) ?? PAREN_OPTION.exec(line);
    if (option !== null) {
      if (current === null) continue;
      const key = (option[1] ?? option[2] ?? "").toLowerCase();
      const body = (option[3] ?? "").replace(/^[:.]\s*/, "");
      if (current.options.length < MAX_OPTIONS && !current.options.some((known) => known.key === key)) {
        current.options.push({ key, text: cut(body) });
      }
      continue;
    }

    if (INDENTED.test(line)) {
      const last = current?.options.at(-1);
      if (last !== undefined) last.text = appended(last.text, line.trim());
      else if (current !== null) current.text = appended(current.text, line.trim());
      continue;
    }

    // Prose before the first question is an introduction; after it, the end.
    if (drafts.length === 0) continue;
    break;
  }

  return { requestId, questions: drafts.map(finish) };
}

function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * The `BM-ANSWERS` block for `picks`, one line per question in question order.
 *
 * Every question must have an answer: a missing pick, an unknown key or a
 * blank `other` throws, so a programming error can never send a partial
 * answer the Worker would take for the user's whole reply.
 */
export function answersText(requestId: string, questions: readonly Question[], picks: Readonly<Record<string, Pick>>): string {
  const lines = ["BM-ANSWERS", `requestId: ${requestId}`];
  for (const question of questions) {
    const pick = picks[question.id];
    if (pick === undefined) throw new Error(`No answer for ${question.id}.`);
    if ("key" in pick) {
      const option = question.options.find((candidate) => candidate.key === pick.key);
      if (option === undefined) throw new Error(`${question.id} has no option "${pick.key}".`);
      lines.push(`${question.id}: ${option.key} — ${oneLine(option.text)}`);
    } else {
      const words = oneLine(pick.other);
      if (words === "") throw new Error(`The answer to ${question.id} is empty.`);
      lines.push(`${question.id}: other — ${words}`);
    }
  }
  return lines.join("\n");
}
