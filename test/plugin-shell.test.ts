import { describe, expect, it } from "vitest";
import { andChainOf, brActions, commandSegments, normalisedCommand, shellFailureOf, shellSucceeded } from "../plugin/shared/shell";

/**
 * The one reader of `br` commands, shared by the bead counts (traces.ts) and
 * the workflow table (workflow-steps.ts). Every case is a line seen in the
 * WP-214 acceptance run.
 */
describe("command segments", () => {
  it("does not split inside quotes", () => {
    expect(commandSegments("grep -iE 'makefile|pytest' Makefile && npm test")).toEqual([
      "grep -iE  ARG  Makefile",
      "npm test",
    ]);
  });

  it("drops a leading subshell parenthesis", () => {
    expect(commandSegments("(cd repo; br ready)")).toEqual(["cd repo", "br ready)"]);
  });
});

describe("br actions", () => {
  it("reads ids from positional arguments only", () => {
    expect(brActions('br close repo-37g -r "adds a single-line docstring"')).toEqual([
      { verb: "close", ids: ["repo-37g"], startsWork: false },
    ]);
    expect(brActions('br create "Title" -l "feature:format-date,component:invoice"')).toEqual([
      { verb: "create", ids: [], startsWork: false },
    ]);
  });

  it("ignores a help page or a dry run", () => {
    expect(brActions("br create --help")).toEqual([]);
    expect(brActions("br close bm-a1 --dry-run")).toEqual([]);
  });

  it("finds every br command of a chained line, and nothing inside quotes", () => {
    expect(brActions("br update bm-a1 bm-b2 --status in_progress && br close bm-a1")).toEqual([
      { verb: "update", ids: ["bm-a1", "bm-b2"], startsWork: true },
      { verb: "close", ids: ["bm-a1"], startsWork: false },
    ]);
    expect(brActions('echo "br close bm-a1"')).toEqual([]);
  });
});

describe("starting work on a bead", () => {
  it.each([
    "br update bm-a1 --status in_progress",
    "br update bm-a1 --status=in_progress >/dev/null 2>&1",
    "br update bm-a1 -s in_progress",
    "br update bm-a1 --claim",
  ])("reads %o as starting work", (line) => {
    expect(brActions(line)).toEqual([{ verb: "update", ids: ["bm-a1"], startsWork: true }]);
  });

  it("does not read other updates as starting work", () => {
    expect(brActions("br update bm-a1 --status closed")[0]?.startsWork).toBe(false);
    expect(brActions('br update bm-a1 --description "status in_progress"')[0]?.startsWork).toBe(false);
  });
});

describe("comparing and judging a command (autonomy design §C.6)", () => {
  it("normalises a command: trimmed, runs of white space made one space", () => {
    expect(normalisedCommand("  npm   test\n -- -t x ")).toBe("npm test -- -t x");
  });

  it("keeps the Worker watch's failure reading (moved from worker-watch.ts)", () => {
    expect(shellFailureOf("completed", 3)).toBe(3);
    expect(shellFailureOf("failed", undefined)).toBe("failed");
    expect(shellFailureOf("error", null)).toBe("failed");
    expect(shellFailureOf("failed", 0)).toBe("failed");
    expect(shellFailureOf("completed", 0)).toBeNull();
    expect(shellFailureOf(null, undefined)).toBeNull();
  });

  it("lets an exit code decide success, and the status only without one", () => {
    expect(shellSucceeded("completed", undefined)).toBe(true); // Claude
    expect(shellSucceeded("failed", undefined)).toBe(false); // Claude
    expect(shellSucceeded("completed", 0)).toBe(true); // Codex
    expect(shellSucceeded("failed", 1)).toBe(false); // Codex
    expect(shellSucceeded("completed", 3)).toBe(false); // OpenCode
    expect(shellSucceeded("failed", 0)).toBe(true);
    expect(shellSucceeded("running", null)).toBe(false);
    expect(shellSucceeded(undefined, undefined)).toBe(false);
  });
});

describe("a line joined only by &&", () => {
  it("gives its segments as written", () => {
    expect(andChainOf("npm test")).toEqual(["npm test"]);
    expect(andChainOf("cd /repo && npm run build&&npm test")).toEqual(["cd /repo", "npm run build", "npm test"]);
    expect(andChainOf("npm run build && \\\n  npm test")).toEqual(["npm run build", "npm test"]);
    expect(andChainOf('npm test -- -t "a && b; c | d"')).toEqual(['npm test -- -t "a && b; c | d"']);
    expect(andChainOf("npm test > out.txt 2>&1 && cat out.txt")).toEqual(["npm test > out.txt 2>&1", "cat out.txt"]);
    expect(andChainOf("npm test &>/dev/null")).toEqual(["npm test &>/dev/null"]);
  });

  it.each(["npm test | tail -5", "npm test; echo done", "npm test || true", "npm test & wait", "npm run build\nnpm test", "npm test |& tail", "npm test &&", "&& npm test"])(
    "is null for %o, whose status is not every part's",
    (line) => {
      expect(andChainOf(line)).toBeNull();
    },
  );
});
