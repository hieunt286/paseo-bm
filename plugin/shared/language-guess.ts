/**
 * A deterministic guess of the language of a piece of text: Vietnamese,
 * English, or `unknown` (Orchestrator design §4.2, "Language guess").
 *
 * The replay compares the user's message with the Manager's reply
 * (`eval-metrics.ts` `supplementary.process.languageMismatch`, once a runtime
 * rule), and a false alarm must be rare, so anything unclear is `unknown`:
 * other languages, text that is too short, code only.
 *
 * Pure: no I/O, the same text always gives the same answer.
 */

export type GuessedLanguage = "vi" | "en" | "unknown";

/** `vi` needs at least this percentage of the letters to be Vietnamese-only. */
export const VI_MIN_PERCENT = 3;

/** `en` needs at least this many Latin letters, and no accented letter at all. */
export const EN_MIN_LATIN_LETTERS = 20;

/**
 * The letters only Vietnamese writes, lowercase: `ă đ ơ ư`; every tone mark on
 * `ă â ê ô ơ ư`; the hook above and the dot below on every vowel; the tilde on
 * `e i u y`; the grave on `y`.
 *
 * Letters Vietnamese shares with other Latin languages (`â ê ô`, and `à á è é
 * ì í ò ó ù ú ã õ ý`, common in French, Portuguese, Spanish or Italian) are
 * left out, so a French text with dense accents does not come out `vi`. They
 * still keep a text from being `en`: `en` needs a text with no accent at all.
 */
const VIETNAMESE_LOWER = [
  "ăđơư",
  "ằắẳẵặ",
  "ầấẩẫậ",
  "ềếểễệ",
  "ồốổỗộ",
  "ờớởỡợ",
  "ừứửữự",
  "ảạẻẹỉịỏọủụỷỵ",
  "ẽĩũỹỳ",
].join("");

/** Both cases. */
export const VIETNAMESE_SPECIFIC_LETTERS: ReadonlySet<string> = new Set([
  ...VIETNAMESE_LOWER,
  ...VIETNAMESE_LOWER.toUpperCase(),
]);

const LETTER = /\p{L}/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
const ASCII_LETTER = /[A-Za-z]/;

/** A fenced block, from its opening fence to its closing one or to the end of the text. */
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|$(?![\s\S]))/gm;
/** An inline code span on one line: `x`, ``x``. */
const BACKTICKED = /(`+)[^\n]*?\1/g;

/** The text without its fenced code blocks and backticked strings. */
export function stripCode(text: string): string {
  return text.replace(FENCED_BLOCK, " ").replace(BACKTICKED, " ");
}

export function guessLanguage(text: string): GuessedLanguage {
  // NFC first, so a vowel typed as a base letter plus combining marks counts
  // as the one Vietnamese letter it is.
  const prose = stripCode(text.normalize("NFC"));
  let letters = 0;
  let latin = 0;
  let vietnamese = 0;
  let accented = 0;
  for (const char of prose) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    if (LATIN_LETTER.test(char)) latin += 1;
    if (!ASCII_LETTER.test(char)) accented += 1;
    if (VIETNAMESE_SPECIFIC_LETTERS.has(char)) vietnamese += 1;
  }
  // Integer comparison: 3 of 100 letters is exactly the threshold, with no float rounding.
  if (letters > 0 && vietnamese * 100 >= VI_MIN_PERCENT * letters) return "vi";
  if (accented === 0 && latin >= EN_MIN_LATIN_LETTERS) return "en";
  return "unknown";
}
