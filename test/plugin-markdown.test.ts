import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../plugin/client/markdown";
import { closedWorkspaces } from "../plugin/client/dashboard-view";

/** Bead descriptions rendered as Markdown (owner, 2026-09-16). */
describe("Markdown for bead descriptions", () => {
  it("reads the shape real bead descriptions use", () => {
    const blocks = parseMarkdown(
      [
        "## Objective",
        "Add `greet_all(names)` to **src/greet.py**.",
        "",
        "## Acceptance Criteria",
        "- first",
        "  - nested",
        "- [x] done box",
        "1. step one",
        "> quoted request",
        "```bash",
        "br ready",
        "```",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading", "paragraph", "heading", "bullet", "bullet", "bullet", "numbered", "quote", "code", "table", "rule",
    ]);
    expect(blocks[4]).toMatchObject({ kind: "bullet", depth: 1 });
    expect(blocks[5]).toMatchObject({ kind: "bullet", checked: true });
    expect(blocks[8]).toEqual({ kind: "code", language: "bash", text: "br ready" });
    expect(blocks[9]).toEqual({ kind: "table", header: ["A", "B"], rows: [["1", "2"]] });
  });

  it("joins wrapped paragraph lines and keeps unknown syntax as text", () => {
    expect(parseMarkdown("one\ntwo\n\n<b>raw</b>")).toEqual([
      { kind: "paragraph", spans: [{ text: "one two" }] },
      { kind: "paragraph", spans: [{ text: "<b>raw</b>" }] },
    ]);
  });

  it("splits inline code, bold and italic", () => {
    expect(parseInline("run `br ready`, **then** *close*")).toEqual([
      { text: "run " },
      { text: "br ready", code: true },
      { text: ", " },
      { text: "then", bold: true },
      { text: " " },
      { text: "close", italic: true },
    ]);
  });

  it("keeps an unterminated code fence instead of dropping the rest", () => {
    expect(parseMarkdown("```\nstill here")).toEqual([{ kind: "code", language: null, text: "still here" }]);
  });
});

/** "If I close the project, can I see it again?" (owner, 2026-09-16). */
describe("closed workspaces stay reachable", () => {
  const stored = [
    { workspaceId: "wks_live", state: "live" as const, lastKnownName: "live", lastKnownDirectory: "/a", lastSeenAt: "2026-09-16T10:00:00Z", bytes: 2048 },
    { workspaceId: "wks_gone", state: "orphaned" as const, lastKnownName: "xspace-customer", lastKnownDirectory: "/x", lastSeenAt: "2026-09-15T10:00:00Z", bytes: 4096 },
    { workspaceId: "wks_arch", state: "archived" as const, lastKnownName: null, lastKnownDirectory: null, lastSeenAt: "2026-09-16T09:00:00Z", bytes: 10 },
    { workspaceId: "wks_unknown", state: "unknown" as const, lastKnownName: "?", lastKnownDirectory: null, lastSeenAt: null, bytes: 1 },
  ];

  it("lists archived and removed workspaces with history, newest first, but not live or unknown ones", () => {
    const closed = closedWorkspaces(stored, ["wks_live"]);
    expect(closed.map((entry) => entry.workspaceId)).toEqual(["wks_arch", "wks_gone"]);
    expect(closed[1]).toEqual({
      workspaceId: "wks_gone",
      label: "xspace-customer",
      detail: "no longer in Paseo · /x · last active 2026-09-15 · 4 KB of history",
    });
    expect(closed[0]?.label).toBe("wks_arch");
  });
});
