/**
 * Text patterns of a provider-plan failure, and the classifier that applies
 * them (delta 20260921 §4.4.4, REQ-065 b).
 *
 * No Paseo provider classifies a usage limit (proposal S5), so the plugin reads
 * the words of the failure: a failed turn's error message, or the short last
 * reply of a turn that did nothing else (`server/fallback-detect.ts`).
 *
 * | Class | Meaning                       | Fallback |
 * |-------|-------------------------------|----------|
 * | L1    | plan usage limit              | yes      |
 * | L2    | billing                       | yes      |
 * | L4    | not logged in                 | yes      |
 * | L5    | provider unavailable          | yes      |
 * | L3    | temporary rate limit          | no       |
 * | L6    | no pattern matched            | no       |
 *
 * The defaults are a starting point never checked on a real incident
 * (proposal §1.5): the phase 2a-16 acceptance and the entry to phase 2a-18
 * check them again. So they are one table of data, and the optional `patterns`
 * of `role-fallback.json` (edited by hand only) replaces the defaults of any
 * class it lists.
 *
 * The text is cut to `MAX_MATCH_CHARS` before matching. That bounds a pattern
 * whose cost grows with the square of the text; it does not bound one that
 * backtracks exponentially, such as `(a+)+$`, which already takes seconds on
 * 25 characters and would hang the plugin inside the daemon. So a user
 * pattern with a nested quantifier — a repeated group that itself holds a
 * quantifier — is dropped like a broken one (owner decision Q16 a). Rarer
 * shapes such as `(a|aa)*$` still get through: an accepted risk of a file
 * edited by hand only. The defaults have no nested quantifier.
 *
 * Shared by server and client: no Node, no React.
 */

/** A class a pattern can name. L6 is the absence of a match, so no pattern names it. */
export type PatternClass = "L1" | "L2" | "L3" | "L4" | "L5";

/** What a text classifies as. */
export type TextClass = PatternClass | "L6";

/** The classes that lead to a fallback; L3 and L6 do not. */
export type FallbackClass = "L1" | "L2" | "L4" | "L5";

/** The optional `patterns` of `role-fallback.json`: regular expression sources per class. */
export type UserPatterns = Partial<Record<PatternClass, readonly string[]>>;

/** One class and its patterns, compiled case-insensitive, in match order. */
export type PatternTable = ReadonlyArray<{ readonly class: PatternClass; readonly patterns: readonly RegExp[] }>;

/** Characters of a text that are matched; the rest is ignored. */
export const MAX_MATCH_CHARS = 2000;

/**
 * The default patterns as regular expression sources, in match order: the
 * first class with a matching pattern wins. L1 comes before L3 because a
 * plan-limit message may also say "rate limit".
 */
export const DEFAULT_PATTERNS: ReadonlyArray<{ readonly class: PatternClass; readonly patterns: readonly string[] }> = [
  { class: "L1", patterns: ["usage limit", "limit reached", "hit your (usage )?limit", "limit (will )?reset", "resets? (at|in) "] },
  {
    class: "L2",
    patterns: ["credit balance", "billing", "subscription (has )?(expired|ended|inactive)", "payment (required|failed)", "quota exceeded"],
  },
  {
    class: "L4",
    patterns: ["not logged in", "please (run )?/?login", "invalid api key", "authentication (failed|error)", "\\b401\\b", "oauth token (has )?expired"],
  },
  { class: "L5", patterns: ["provider (is )?unavailable", "process exited with code", "command not found", "ENOENT"] },
  { class: "L3", patterns: ["rate[ _]limit", "overloaded", "\\b429\\b", "\\b529\\b", "too many requests"] },
];

const FALLBACK_CLASSES: ReadonlySet<string> = new Set(["L1", "L2", "L4", "L5"]);

/** True for L1, L2, L4 and L5. */
export function isFallbackClass(value: unknown): value is FallbackClass {
  return typeof value === "string" && FALLBACK_CLASSES.has(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when `source` repeats a group that holds a quantifier: `(a+)+`,
 * `(\w*)*`, `(?:x{2,}){3,}`. A group counts as repeated after `*`, `+` or a
 * `{n,}` / `{n,m}` with m > 1; `?` and `{0,1}` do not repeat. Escapes and
 * character classes are skipped, so `\(a+\)+` and `[(a+)+]` are fine. Only a
 * syntax check: it runs on a source that already compiles.
 */
export function hasNestedQuantifier(source: string): boolean {
  /** Per open group: whether anything inside it is quantified. */
  const groups: boolean[] = [];
  /** Whether the group closed just before the current position held a quantifier. */
  let closedHeldQuantifier = false;
  const markQuantified = () => {
    for (let depth = 0; depth < groups.length; depth += 1) groups[depth] = true;
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      index += 2;
      closedHeldQuantifier = false;
      continue;
    }
    if (char === "[") {
      // Skip the class: `]` right after `[` or `[^` is a literal.
      index += 1;
      if (source[index] === "^") index += 1;
      if (source[index] === "]") index += 1;
      while (index < source.length && source[index] !== "]") index += source[index] === "\\" ? 2 : 1;
      index += 1;
      closedHeldQuantifier = false;
      continue;
    }
    if (char === "(") {
      groups.push(false);
      index += 1;
      closedHeldQuantifier = false;
      continue;
    }
    if (char === ")") {
      closedHeldQuantifier = groups.pop() ?? false;
      index += 1;
      continue;
    }
    let repeats = false;
    let quantifier = false;
    let length = 1;
    if (char === "*" || char === "+") {
      quantifier = true;
      repeats = true;
    } else if (char === "?") {
      quantifier = true;
    } else if (char === "{") {
      const range = /^\{(\d*)(,(\d*))?\}/.exec(source.slice(index));
      if (range !== null) {
        quantifier = true;
        length = range[0].length;
        const upper = range[2] === undefined ? Number(range[1]) : range[3] === "" ? Infinity : Number(range[3]);
        repeats = upper > 1;
      }
    }
    if (quantifier) {
      if (repeats && closedHeldQuantifier) return true;
      markQuantified();
      // A lazy suffix (`+?`, `*?`, `{2,}?`) belongs to this quantifier.
      if (source[index + length] === "?") length += 1;
    }
    closedHeldQuantifier = false;
    index += length;
  }
  return false;
}

/**
 * Compiles the table. A class the user lists with at least one entry uses the
 * user's patterns instead of the defaults; an empty or missing list keeps the
 * defaults. A user pattern that does not compile, is empty (it would match
 * every text) or has a nested quantifier (`hasNestedQuantifier`) is dropped
 * with one `[paseo-bm]` line; the rest of its class still counts. Never throws.
 */
export function compilePatterns(
  user?: UserPatterns | null,
  log: (message: string) => void = (message) => console.warn(message),
): PatternTable {
  return DEFAULT_PATTERNS.map((row) => {
    const own: unknown = user?.[row.class];
    if (!Array.isArray(own) || own.length === 0) {
      return { class: row.class, patterns: row.patterns.map((source) => new RegExp(source, "i")) };
    }
    const patterns: RegExp[] = [];
    for (const source of own as unknown[]) {
      try {
        if (typeof source !== "string" || source === "") throw new Error("a pattern must be a non-empty string");
        const compiled = new RegExp(source, "i");
        if (hasNestedQuantifier(source)) throw new Error("a repeated group holds a quantifier, which can hang the plugin (for example (a+)+)");
        patterns.push(compiled);
      } catch (error) {
        log(`[paseo-bm] role-fallback.json: ${row.class} pattern ${JSON.stringify(source)} is ignored: ${describeError(error)}`);
      }
    }
    return { class: row.class, patterns };
  });
}

/** Classifies a text against a compiled table; a non-string or empty text is L6. */
export function matchClass(text: unknown, table: PatternTable): TextClass {
  if (typeof text !== "string" || text === "") return "L6";
  const cut = text.slice(0, MAX_MATCH_CHARS);
  for (const row of table) {
    if (row.patterns.some((pattern) => pattern.test(cut))) return row.class;
  }
  return "L6";
}

/** Compiles and classifies in one call. Pure apart from the log line of a dropped user pattern. */
export function classifyText(text: unknown, user?: UserPatterns | null, log?: (message: string) => void): TextClass {
  return matchClass(text, compilePatterns(user, log));
}
