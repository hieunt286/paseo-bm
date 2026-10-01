/**
 * The big-decision gate (Orchestrator design §6B.5, ADR-016 decision 3), now
 * a **backstop** (autonomy design §A.7, ADR-017 decision 5): the authority of
 * a command is its declared effects and the grant, the owner's policy
 * (§B.9) or the owner's word that covers them
 * (`server/command-authority.ts`); this file only checks that the text
 * does not show an effect the command did not declare, whatever the
 * authority — it takes none as input.
 *
 * Before a command of the Orchestrator leaves (`bm_send_command`,
 * `bm_direct_worker`), the plugin matches its `re:` line and body — never the
 * header — against fixed categories. A category found whose effects
 * (`GATE_CATEGORY_EFFECTS`) the command does not declare refuses it with
 * "declare the effect or ask the owner" (`undeclaredCategoriesOf`,
 * `undeclaredRefusalOf`) — never a silent send. Nothing silences it: the
 * categories the owner once allowed for a project (Allow…) and the exemption a
 * stop of a dangerous Worker had are retired (autonomy design §B.8). It is a
 * rule, not the Orchestrator's judgement: a false positive (a harmless mention
 * of "security") is refused too.
 *
 * Matching:
 * - case-insensitive, English and Vietnamese; the text is compared in Unicode
 *   NFC, so a Vietnamese word typed with combining marks still matches;
 * - on word boundaries: a term starts after a character that is not a letter,
 *   digit or `_`, and ends before one — so `prod` does not match "product" and
 *   `paid` does not match "prepaid". Each term lists its own inflections
 *   ("pushed", "deployment", "credentials"); the three stems of the design
 *   (`authoriz`, `authenticat`, `impersonat`) match any ending;
 * - a match preceded, within the 4 words before it in the same sentence, by a
 *   negation (not, no, never, don't, do not, without, không, đừng, chưa, cấm)
 *   does not count. A sentence ends at `.`, `!`, `?`, `;` or a line break, so
 *   "Do not deploy. Push the fix." still counts the push. A stop word is a
 *   negation too, so "Stop the push" does not count it.
 *
 * Pure and environment-neutral: it imports only the effect vocabulary
 * (`decisions.ts`).
 */
import { CLASS_OF_EFFECT, EFFECTS, type Effect } from "./decisions";

/** The categories, in the order of design §6B.5; `gateOf` returns them in this order. */
export const GATE_CATEGORIES = ["security", "release", "data", "cost", "dependency"] as const;
export type GateCategory = (typeof GATE_CATEGORIES)[number];

/** The words that negate a match within the 4 words before it (design §6B.5). */
export const GATE_NEGATIONS: readonly string[] = ["not", "no", "never", "don't", "without", "stop", "avoid", "không", "đừng", "chưa", "cấm", "dừng", "tránh"];

/** How many words before a match a negation may stand. */
export const GATE_NEGATION_WINDOW = 4;

/** A space between two words of a term: any run of whitespace. */
const _ = String.raw`\s+`;

/**
 * Each category's terms as regular-expression sources (lower case, NFC). The
 * boundaries are added by the matcher; a stem ends in `\p{L}*`.
 */
const TERMS: Readonly<Record<GateCategory, readonly string[]>> = {
  security: [
    "security",
    "permissions?",
    String.raw`authoriz\p{L}*`,
    String.raw`authenticat\p{L}*`,
    "login-as",
    String.raw`impersonat\p{L}*`,
    "tokens?",
    "secrets?",
    "passwords?",
    "credentials?",
    `bảo${_}mật`,
    `phân${_}quyền`,
    `đăng${_}nhập${_}hộ`,
    `mật${_}khẩu`,
  ],
  release: [
    "push(?:es|ed|ing)?",
    "deploy(?:s|ed|ing|ments?)?",
    "publish(?:es|ed|ing)?",
    "releas(?:e|es|ed|ing)",
    "productions?",
    "prod",
    `merg(?:e|es|ed|ing)${_}into${_}main`,
    `triển${_}khai`,
    `phát${_}hành`,
  ],
  data: [
    `drop${_}table`,
    "truncat(?:e|es|ed|ing)",
    `delete${_}from`,
    "migrat(?:e|es|ed|ing|ions?)",
    `real${_}data`,
    `production${_}data`,
    `x(?:oá|óa)${_}dữ${_}liệu`,
    `dữ${_}liệu${_}thật`,
    `cơ${_}sở${_}dữ${_}liệu${_}thật`,
  ],
  cost: ["billing", "costs?", "prices?", "pricing", "paid", "subscriptions?", `chi${_}phí`],
  dependency: [
    `npm${_}install`,
    `pnpm${_}add`,
    `yarn${_}add`,
    `add${_}a${_}dependency`,
    `new${_}dependenc(?:y|ies)`,
    "licen[cs]es?",
    `thêm${_}thư${_}viện`,
  ],
};

/** A letter, digit or `_`: what may not stand right before a term (the pattern itself refuses one after it). */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** One word of the negation window; an apostrophe (straight or curly) stays inside it, so "don't" is one word. */
const WORD = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;
/** Where a sentence ends: the negation window never reaches across one. */
const SENTENCE_END = /[.!?;\n]/g;

const PATTERNS: ReadonlyArray<{ category: GateCategory; pattern: RegExp }> = GATE_CATEGORIES.flatMap((category) =>
  // The end boundary is part of the pattern, so "released" is tried as a whole
  // after "release" fails there; the start is checked by hand (no lookbehind).
  TERMS[category].map((source) => ({ category, pattern: new RegExp(`(?:${source})(?![\\p{L}\\p{N}_])`, "giu") })),
);

const NEGATIONS = new Set(GATE_NEGATIONS);

/** One term found in the text. */
export interface GateMatch {
  category: GateCategory;
  /** The words matched, as written (lower case, NFC). */
  term: string;
  /** Where the match starts, in the lower-cased NFC text. */
  index: number;
  /** True when a negation stands within the 4 words before it; a negated match does not count. */
  negated: boolean;
}

function comparable(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

function isNegated(text: string, index: number): boolean {
  let start = 0;
  for (const end of text.slice(0, index).matchAll(SENTENCE_END)) start = (end.index ?? 0) + 1;
  const words = [...text.slice(start, index).matchAll(WORD)].map((word) => word[0].replace(/’/g, "'"));
  return words.slice(-GATE_NEGATION_WINDOW).some((word) => NEGATIONS.has(word));
}

/**
 * Every term of every category found in `text`, negated ones included, in
 * order of position. What `gateOf` decides from; the evidence a refusal can quote.
 */
export function gateMatchesOf(text: string): GateMatch[] {
  if (typeof text !== "string" || text === "") return [];
  const subject = comparable(text);
  const matches: GateMatch[] = [];
  for (const { category, pattern } of PATTERNS) {
    for (const match of subject.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > 0 && WORD_CHAR.test(subject[index - 1]!)) continue;
      matches.push({ category, term: match[0], index, negated: isNegated(subject, index) });
    }
  }
  return matches.sort((a, b) => a.index - b.index || GATE_CATEGORIES.indexOf(a.category) - GATE_CATEGORIES.indexOf(b.category));
}

/**
 * The categories a command's text falls in (design §6B.5): those with at
 * least one match that is not negated, in `GATE_CATEGORIES` order. Empty: the
 * command may go.
 */
export function gateOf(text: string): GateCategory[] {
  const found = new Set(gateMatchesOf(text).flatMap((match) => (match.negated ? [] : [match.category])));
  return GATE_CATEGORIES.filter((category) => found.has(category));
}

/**
 * The effects that declare each category (autonomy design §A.3 effects): a
 * text in a category is declared when the command declares any one of them.
 * Each category is a decision class, and its effects are the effects of that
 * class (`CLASS_OF_EFFECT`, the one map; code review 2026-09-30 §3.5), in
 * `EFFECTS` order.
 */
export const GATE_CATEGORY_EFFECTS: Readonly<Record<GateCategory, readonly Effect[]>> = Object.fromEntries(
  GATE_CATEGORIES.map((category): [GateCategory, readonly Effect[]] => [category, EFFECTS.filter((effect) => CLASS_OF_EFFECT[effect] === category)]),
) as Record<GateCategory, readonly Effect[]>;

/**
 * The categories `text` falls in (`gateOf`) that the declared `effects` do
 * not cover, in `GATE_CATEGORIES` order. Empty: the text shows nothing the
 * command did not declare.
 */
export function undeclaredCategoriesOf(text: string, effects: readonly Effect[]): GateCategory[] {
  return gateOf(text).filter((category) => !GATE_CATEGORY_EFFECTS[category].some((effect) => effects.includes(effect)));
}

/** The refusal a command whose text shows an undeclared effect gets (autonomy design §A.7); the command is not sent. */
export function undeclaredRefusalOf(categories: readonly GateCategory[]): string {
  const orList = (effects: readonly string[]) => (effects.length < 2 ? effects.join("") : `${effects.slice(0, -1).join(", ")} or ${effects.at(-1)!}`);
  const shown = categories.map((category) => `${category} (${orList(GATE_CATEGORY_EFFECTS[category])})`).join(", ");
  return `the text shows ${shown} that effects does not declare: declare the effect or ask the owner with bm_ask_owner`;
}
