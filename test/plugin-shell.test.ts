import { describe, expect, it } from "vitest";
import { brActions, commandSegments } from "../plugin/server/shell";

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
