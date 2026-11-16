import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIEF_MEMORY_CHARS, missionBriefLines, workerBriefOf } from "../plugin/server/create-worker";
import type { MemoryEntry } from "../plugin/server/memory-store";
import { runtimeFactsText } from "../plugin/server/role-instructions";
import { WORKER_DISABLED_PASEO_TOOLS, rolePaseoToolsPolicy } from "../plugin/server/setup-roles";
import { boundToolFacesFor } from "../plugin/shared/bm-tools";

/**
 * What the plugin adds to a Worker's session start (ADR-045 decision 11,
 * mission line plan §5.7), computed from source: no provider token count, no
 * agent record, no live session. The field baseline is 57k; the parts outside
 * the plugin's reach are named in docs/operations/paseo-bm-eval-baseline.md §7.
 */

/** 3.6 characters a token, the plan's figure for this mix of prose and JSON. */
const tokensOf = (characters: number) => Math.ceil(characters / 3.6);

const WORKER_MD = readFileSync(fileURLToPath(new URL("../plugin/roles/worker.md", import.meta.url)), "utf8");

/** A typical mission Worker: bound, in a placement, under the action boundary, with no precedent. */
const RUNTIME_FACTS = runtimeFactsText("worker", {
  bound: true,
  reviewCap: { maxRereviews: 3, callsPerBatch: 3 },
  integration: { branch: "m/SHOP/back", target: "develop", push: false },
  actionBoundary: { on: true, modeId: "default" },
});

const REQUEST = "Add an export button to the invoices page that downloads the listed invoices as a CSV file. Keep the existing filters applied to what is exported, and show an empty state when nothing is listed.";

/** An entry of the repo's project memory; forty of them more than fill the brief's budget. */
function memoryOf(index: number): MemoryEntry {
  const text = `Convention ${index} of this repository for invoices and exports: a statement of about two hundred characters that later Workers here need before they touch this area, kept whole in the brief as the store holds it.`;
  return { id: `mem-${String(index).padStart(10, "0")}`, kind: "convention", text, source: `req-20261101T0${String(index % 10)}0000Z`, by: { role: "main", agentId: "main-1", missionId: "mis-1" }, at: "2026-11-01T00:00:00.000Z", supersedes: null, state: "active" };
}

const BRIEF = workerBriefOf({
  requestId: "req-20261110T080000Z",
  request: REQUEST,
  cwd: "/work/shop/.paseo-bm/worktrees/back",
  managerId: "agent-main",
  mission: missionBriefLines({ mission: { missionId: "mis-1", code: "SHOP", name: "Shop", contracts: [] }, workspaceId: "wks_back", planStep: "Step 2 of 3: Export invoices", memory: Array.from({ length: 40 }, (_, index) => memoryOf(index)), request: REQUEST, titleOf: () => "back" }),
  context: [{ fact: "The invoices page lives in src/invoices and its list comes from the invoices service.", source: "the owner's message" }],
});

const TOOL_FACES = JSON.stringify(boundToolFacesFor("worker"));

const parts = { "plugin/roles/worker.md": WORKER_MD, "Runtime facts": RUNTIME_FACTS, "brief at the full memory budget": BRIEF, "the bm_ tool faces": TOOL_FACES } as const;

/** The ratchet (ADR-045 decision 11): each part and the total, in characters, at the figures after the trim; a higher figure is a decision, not a drift. */
const CEILINGS: Readonly<Record<keyof typeof parts, number>> = {
  "plugin/roles/worker.md": 16_800,
  "Runtime facts": 230,
  "brief at the full memory budget": 6_650,
  "the bm_ tool faces": 20_300,
};
/** The total the trim reached, in tokens at 3.6 characters a token. */
const TOTAL_TOKENS_CEILING = 12_200;

describe("a Worker's fixed context from the plugin (ADR-045 decision 11, mission line plan §5.7)", () => {
  it("prints and pins the four parts, in characters and in tokens at 3.6 characters a token", () => {
    const rows = (Object.keys(parts) as Array<keyof typeof parts>).map((name) => ({ name, characters: parts[name].length, tokens: tokensOf(parts[name].length) }));
    const total = rows.reduce((sum, row) => sum + row.characters, 0);
    console.info(`${rows.map((row) => `${row.name}: ${row.characters} characters, ${row.tokens} tokens`).join("\n")}\ntotal: ${total} characters, ${tokensOf(total)} tokens`);
    for (const row of rows) expect(row.characters, row.name).toBeLessThanOrEqual(CEILINGS[row.name]);
    expect(tokensOf(total)).toBeLessThanOrEqual(TOTAL_TOKENS_CEILING);
  });

  it("samples a brief at the full memory budget and a bound mission Worker's facts", () => {
    expect(BRIEF.length).toBeGreaterThan(BRIEF_MEMORY_CHARS);
    expect(RUNTIME_FACTS).toContain("Integration: m/SHOP/back");
    expect(RUNTIME_FACTS).not.toContain("Without paseo-bm's tools");
  });

  it("lists the Paseo tools a Worker is given, which the plugin chooses by what it switches off (ADR-020)", () => {
    expect(rolePaseoToolsPolicy("worker")).toEqual({ enabled: true, disabledTools: [...WORKER_DISABLED_PASEO_TOOLS] });
    console.info(`Paseo tools a Worker is given: every tool of Paseo's server except ${WORKER_DISABLED_PASEO_TOOLS.join(", ")}`);
    expect(WORKER_DISABLED_PASEO_TOOLS).toEqual(expect.arrayContaining(["create_workspace", "rename_workspace", "kill_agent", "archive_agent"]));
    expect(WORKER_DISABLED_PASEO_TOOLS).not.toContain("create_agent");
  });
});
