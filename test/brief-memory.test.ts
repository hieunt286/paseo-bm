import { describe, expect, it } from "vitest";
import { BRIEF_MEMORY_CHARS, BRIEF_MEMORY_ENTRY_CHARS, BRIEF_MEMORY_OWN_SHARE, briefMemoryMoreLine, briefMemoryOf, missionBriefLines } from "../plugin/server/create-worker";
import type { MemoryEntry } from "../plugin/server/memory-store";

/** Delivery line design §18.2 (ADR-037): a Worker's brief carries memory within a budget. Pure functions only. */

const MISSION = "mis-aix0000001";
const OTHER = "mis-pen0000001";
let serial = 0;
function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  serial += 1;
  return {
    id: `mem-${serial.toString(16).padStart(10, "0")}`,
    kind: "contract",
    text: `Entry ${serial}.`,
    source: `out-${serial}`,
    by: { role: "main", agentId: "main-1", missionId: OTHER },
    at: new Date(Date.UTC(2026, 9, 10) + serial * 60_000).toISOString(),
    supersedes: null,
    state: "active",
    scope: "repo",
    ...overrides,
  };
}

describe("briefMemoryOf (§18.2)", () => {
  it("keeps a field-shaped memory within the budget and names the rest", () => {
    // The 2026-10-24 brief: 66 entries of 400–1,000 characters, 34,535 characters in all.
    const live = Array.from({ length: 66 }, (_, n) => entry({ text: `Contract ${n}: ${"menu oauth merge checkout ".repeat(30 + (n % 10))}` }));
    const { lines, more } = briefMemoryOf({ live, request: "Build a dynamic form in the AI chat.", missionId: MISSION });
    const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
    expect(total).toBeLessThanOrEqual(BRIEF_MEMORY_CHARS);
    expect(lines.every((line) => line.length <= BRIEF_MEMORY_ENTRY_CHARS)).toBe(true);
    expect(lines.every((line) => line.endsWith(")") && line.includes("… (source: out-"))).toBe(true);
    expect(more).toBe(66 - lines.length);
    expect(more).toBeGreaterThan(0);
  });

  it("puts this mission's entries first, then the words shared with the request and plan step, then the newest", () => {
    const old = entry({ text: "Menus come from the shell." });
    const relevant = entry({ text: "Forms render through the card catalog renderer." });
    const own = entry({ kind: "fact", scope: "mission", text: "The mission chose React Hook Form.", by: { role: "main", agentId: "main-1", missionId: MISSION } });
    const newest = entry({ text: "Widgets use a centred column." });
    const { lines, more } = briefMemoryOf({ live: [old, relevant, own, newest], request: "Build dynamic forms", planStep: "renderer for cards", missionId: MISSION });
    expect(lines).toEqual([
      "- fact: The mission chose React Hook Form. (source: out-" + own.source.slice(4) + ")",
      `- contract: Forms render through the card catalog renderer. (source: ${relevant.source})`,
      `- contract: Widgets use a centred column. (source: ${newest.source})`,
      `- contract: Menus come from the shell. (source: ${old.source})`,
    ]);
    expect(more).toBe(0);
  });

  it("lets this mission take at most its share first, so the repo's conventions still reach the Worker", () => {
    const ownBy = { role: "main" as const, agentId: "main-1", missionId: MISSION };
    const own = Array.from({ length: 30 }, (_, n) => entry({ kind: "fact", scope: "mission", by: ownBy, text: `Pushed commit ${n} ${"z".repeat(300)}` }));
    const charsOf = (lines: string[], word: string) => lines.filter((line) => line.includes(word)).reduce((sum, line) => sum + line.length + 1, 0);
    // Many repo entries: the mission keeps to its share.
    const many = Array.from({ length: 30 }, (_, n) => entry({ kind: "convention", text: `Repo rule ${n}: ${"use yarn workspaces ".repeat(15)}` }));
    const crowded = briefMemoryOf({ live: [...many, ...own], request: "Build a form", missionId: MISSION }).lines;
    expect(charsOf(crowded, "Pushed commit")).toBeLessThanOrEqual(BRIEF_MEMORY_CHARS * BRIEF_MEMORY_OWN_SHARE);
    expect(charsOf(crowded, "Repo rule")).toBeGreaterThan(BRIEF_MEMORY_CHARS * 0.4);
    // Few repo entries: all of them, and the mission takes what they leave.
    const few = Array.from({ length: 5 }, (_, n) => entry({ kind: "convention", text: `Repo rule ${n}: use yarn workspaces.` }));
    const { lines } = briefMemoryOf({ live: [...few, ...own], request: "Build a form", missionId: MISSION });
    expect(lines.filter((line) => line.startsWith("- convention: Repo rule"))).toHaveLength(5);
    expect(charsOf(lines, "Pushed commit")).toBeGreaterThan(BRIEF_MEMORY_CHARS * BRIEF_MEMORY_OWN_SHARE);
  });

  it("weighs shared words by rarity and counts neighbouring-word pairs, so a Vietnamese compound outranks a common word", () => {
    const common = Array.from({ length: 8 }, () => entry({ kind: "decision", text: "Người dùng chọn phương án a." }));
    const compound = entry({ kind: "fact", text: "Form nhập liệu dùng FieldSpec v2." });
    const { lines } = briefMemoryOf({ live: [...common, compound], request: "Người dùng cần nhập liệu bằng form", missionId: MISSION });
    expect(lines[0]).toContain("Form nhập liệu dùng FieldSpec v2.");
  });

  it("puts the owner's own entries first, whatever their words", () => {
    const repo = Array.from({ length: 30 }, (_, n) => entry({ kind: "convention", text: `Build forms with rule ${n} ${"form ".repeat(60)}` }));
    const note = entry({ kind: "decision", by: { role: "owner", agentId: null, missionId: null }, text: "Never deploy on Fridays." });
    const { lines } = briefMemoryOf({ live: [...repo, note], request: "Build forms", missionId: MISSION });
    expect(lines[0]).toContain("Never deploy on Fridays.");
  });

  it("matches a request typed in decomposed Unicode against composed memory", () => {
    const composed = entry({ kind: "fact", text: "Nhập liệu qua biểu mẫu động." });
    const other = entry({ kind: "fact", text: "Unrelated note." });
    const { lines } = briefMemoryOf({ live: [other, composed], request: "nhập liệu".normalize("NFD"), missionId: MISSION });
    expect(lines[0]).toContain("Nhập liệu qua biểu mẫu động.");
  });

  it("is empty with no memory", () => {
    expect(briefMemoryOf({ live: [], request: "x", missionId: null })).toEqual({ lines: [], more: 0 });
  });
});

describe("missionBriefLines (§18.2)", () => {
  const titleOf = (id: string) => (id === "wks_back" ? "back" : "front");
  it("keeps a mission contract in full and adds the more line past the budget", () => {
    const live = Array.from({ length: 40 }, (_, n) => entry({ text: `Rule ${n} ${"x".repeat(380)}` }));
    const lines = missionBriefLines({
      mission: { missionId: MISSION, code: "AIX", name: "Dynamic Form", contracts: [{ id: "C1", title: "Forms API", providerRepo: "wks_back", consumerRepos: ["wks_front"], text: "y".repeat(2_000), version: 1, updatedAt: "2026-10-24T00:00:00.000Z", source: "plan" }] },
      workspaceId: "wks_front",
      memory: live,
      request: "Build a form",
      titleOf,
    });
    const contract = lines.find((line) => line.startsWith("- C1 v1"))!;
    // The mission's own agreement is what the Worker builds to: never cut (review of ADR-037).
    expect(contract.endsWith("y".repeat(2_000))).toBe(true);
    const start = lines.indexOf("Project memory (front):");
    const memory = lines.slice(start + 1);
    const shown = memory.length - 1;
    expect(memory.at(-1)).toBe(briefMemoryMoreLine(40 - shown));
    expect(memory.slice(0, -1).reduce((sum, line) => sum + line.length + 1, 0)).toBeLessThanOrEqual(BRIEF_MEMORY_CHARS);
  });
});
