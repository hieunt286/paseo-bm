import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PATTERNS,
  MAX_MATCH_CHARS,
  classifyText,
  compilePatterns,
  hasNestedQuantifier,
  isFallbackClass,
  matchClass,
  type PatternClass,
} from "../plugin/shared/fallback-patterns";

/**
 * Delta 20260921 §4.4.4 (REQ-065 b): the text of a provider-plan failure is
 * classified against case-insensitive patterns, in the order L1, L2, L4, L5,
 * L3; the first match wins and no match is L6. `role-fallback.json` may replace
 * the defaults of a class.
 */

/** The defaults exactly as the bead and the design list them. */
const LISTED: Record<PatternClass, string[]> = {
  L1: ["usage limit", "limit reached", "hit your (usage )?limit", "limit (will )?reset", "resets? (at|in) "],
  L2: ["credit balance", "billing", "subscription (has )?(expired|ended|inactive)", "payment (required|failed)", "quota exceeded"],
  L4: ["not logged in", "please (run )?/?login", "invalid api key", "authentication (failed|error)", "\\b401\\b", "oauth token (has )?expired"],
  L5: ["provider (is )?unavailable", "process exited with code", "command not found", "ENOENT"],
  L3: ["rate[ _]limit", "overloaded", "\\b429\\b", "\\b529\\b", "too many requests"],
};

/** One text per default pattern that only that pattern's class matches. Mixed case on purpose. */
const SAMPLES: Record<string, string> = {
  "usage limit": "Claude USAGE LIMIT for this plan",
  "limit reached": "5-hour Limit Reached",
  "hit your (usage )?limit": "You've hit your limit for now",
  "limit (will )?reset": "Your limit will reset tomorrow",
  "resets? (at|in) ": "Try again later, it Resets at 5pm (Europe/Paris)",
  "credit balance": "Your credit balance is too low to access the API",
  billing: "Please check your Billing details",
  "subscription (has )?(expired|ended|inactive)": "Your subscription has expired",
  "payment (required|failed)": "Payment required",
  "quota exceeded": "Quota exceeded for this project",
  "not logged in": "Not logged in",
  "please (run )?/?login": "Invalid session. Please run /login",
  "invalid api key": "Invalid API key - Fix external API key",
  "authentication (failed|error)": "Authentication failed for the provider",
  "\\b401\\b": "HTTP 401 Unauthorized",
  "oauth token (has )?expired": "OAuth token has expired",
  "provider (is )?unavailable": "The provider is unavailable",
  "process exited with code": "claude process exited with code 1",
  "command not found": "zsh: command not found: codex",
  ENOENT: "spawn opencode ENOENT",
  "rate[ _]limit": "rate_limit_error: try again shortly",
  overloaded: "API Error: Overloaded",
  "\\b429\\b": "Request failed with status 429",
  "\\b529\\b": "Upstream answered 529",
  "too many requests": "Too Many Requests",
};

const EVERY_DEFAULT = DEFAULT_PATTERNS.flatMap((row) => row.patterns.map((source) => [row.class, source] as const));

describe("default patterns", () => {
  it("are one table, in match order L1, L2, L4, L5, L3, holding exactly the listed patterns", () => {
    expect(DEFAULT_PATTERNS.map((row) => row.class)).toEqual(["L1", "L2", "L4", "L5", "L3"]);
    expect(Object.fromEntries(DEFAULT_PATTERNS.map((row) => [row.class, [...row.patterns]]))).toEqual(LISTED);
  });

  it.each(EVERY_DEFAULT)("%s: /%s/i classifies its sample text", (cls, source) => {
    const sample = SAMPLES[source];
    expect(sample, `no sample for ${source}`).toBeDefined();
    expect(new RegExp(source, "i").test(sample!)).toBe(true);
    expect(classifyText(sample)).toBe(cls);
  });

  it("does not match across a word boundary for the status codes", () => {
    expect(classifyText("request id 14019")).toBe("L6");
    expect(classifyText("took 4290 ms")).toBe("L6");
  });
});

describe("match order", () => {
  it("L1 wins over L3: a plan-limit message that also says rate limit", () => {
    expect(classifyText("rate_limit_error: You've hit your usage limit - resets 3pm")).toBe("L1");
    expect(classifyText("rate limit exceeded, retrying")).toBe("L3");
  });

  it("the first class in order wins over every later one", () => {
    expect(classifyText("billing problem: 401")).toBe("L2");
    expect(classifyText("not logged in: command not found")).toBe("L4");
    expect(classifyText("ENOENT after 429")).toBe("L5");
  });

  it("anything else is L6, and so is an empty or non-string text", () => {
    expect(classifyText("I finished the refactor and all tests pass.")).toBe("L6");
    expect(classifyText("")).toBe("L6");
    expect(classifyText(undefined)).toBe("L6");
    expect(classifyText(42)).toBe("L6");
  });

  it("only L1, L2, L4 and L5 lead to a fallback", () => {
    expect(["L1", "L2", "L3", "L4", "L5", "L6"].filter(isFallbackClass)).toEqual(["L1", "L2", "L4", "L5"]);
  });
});

describe("patterns from role-fallback.json", () => {
  it("replace the defaults of the classes they list, and only those", () => {
    const user = { L1: ["plan exhausted"], L3: ["slow down"] };
    expect(classifyText("Plan exhausted until Monday", user)).toBe("L1");
    expect(classifyText("usage limit reached", user)).toBe("L6");
    expect(classifyText("Slow down please", user)).toBe("L3");
    expect(classifyText("too many requests", user)).toBe("L6");
    expect(classifyText("Your credit balance is too low", user)).toBe("L2");
    expect(classifyText("Not logged in", user)).toBe("L4");
  });

  it("are compiled case-insensitive and keep the match order", () => {
    expect(classifyText("PLAN EXHAUSTED, slow down", { L1: ["plan exhausted"], L3: ["slow down"] })).toBe("L1");
    expect(classifyText("slow down: plan exhausted", { L2: ["plan exhausted"], L3: ["slow down"] })).toBe("L2");
  });

  it("an empty list keeps the defaults of that class", () => {
    expect(classifyText("usage limit", { L1: [] })).toBe("L1");
  });

  it("a pattern that does not compile is dropped with one [paseo-bm] line; the rest of its class still counts", () => {
    const log = vi.fn();
    const table = compilePatterns({ L1: ["(unclosed", "plan exhausted"] }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] .*L1 pattern "\(unclosed"/);
    expect(table.find((row) => row.class === "L1")!.patterns.map((pattern) => pattern.source)).toEqual(["plan exhausted"]);
    expect(matchClass("plan exhausted", table)).toBe("L1");
    expect(matchClass("(unclosed", table)).toBe("L6");
  });

  it("an empty pattern, which would match every text, is dropped too", () => {
    const log = vi.fn();
    expect(classifyText("all good here", { L1: [""] }, log)).toBe("L6");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("with nothing from the file, no line is logged", () => {
    const log = vi.fn();
    compilePatterns(undefined, log);
    compilePatterns(null, log);
    compilePatterns({}, log);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("the 2 000-character cut", () => {
  it("only the first MAX_MATCH_CHARS characters are matched", () => {
    expect(MAX_MATCH_CHARS).toBe(2000);
    const pad = "x".repeat(MAX_MATCH_CHARS - "usage limit".length);
    expect(classifyText(`${pad}usage limit`)).toBe("L1");
    expect(classifyText(`${pad}Xusage limit`)).toBe("L6");
  });

  it("bounds a pathological pattern: a 200 000-character text is matched as 2 000 characters, in under a second", () => {
    // `a*x` backtracks at every start position, so its cost grows with the
    // square of the text: measured on Node 26, 6 ms for 2 000 characters, 611 ms
    // for 20 000, so about a minute for the uncut 200 000.
    const text = `${"a".repeat(200_000)}!`;
    const started = performance.now();
    expect(classifyText(text, { L1: ["a*x"] })).toBe("L6");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("user patterns with a nested quantifier (owner decision Q16 a)", () => {
  it.each(["(a+)+$", "(\\w*)*", "(?:x{2,}){3,}", "((a+)b)+", "(ab?)*", "(a+){2}", "(a*?)+"])("drops %s", (source) => {
    expect(hasNestedQuantifier(source)).toBe(true);
  });

  it.each(["(a+)?", "(foo)+", "\\(a+\\)+", "[(a+)+]", "usage limit", "hit your (usage )?limit", "(a+){1}", "(a+){0,1}", "[\\]+]+x"])(
    "keeps %s",
    (source) => {
      expect(hasNestedQuantifier(source)).toBe(false);
    },
  );

  it("never flags a default pattern", () => {
    for (const row of DEFAULT_PATTERNS) for (const source of row.patterns) expect(hasNestedQuantifier(source)).toBe(false);
  });

  it("drops (a+)+$ with one log line, keeps the class's other patterns, and a 2 000-character input finishes in under a second", () => {
    const log = vi.fn();
    const table = compilePatterns({ L1: ["(a+)+$", "my plan ran out"] }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] role-fallback\.json: L1 pattern "\(a\+\)\+\$" is ignored: a repeated group holds a quantifier/);
    expect(table.find((row) => row.class === "L1")?.patterns.map((pattern) => pattern.source)).toEqual(["my plan ran out"]);
    // Without the check, this input never finishes: (a+)+$ backtracks exponentially.
    const text = `${"a".repeat(MAX_MATCH_CHARS - 1)}!`;
    const started = performance.now();
    expect(matchClass(text, table)).toBe("L6");
    expect(matchClass("My plan ran out today", table)).toBe("L1");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
