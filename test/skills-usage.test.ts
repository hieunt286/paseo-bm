import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSkillsUsage, registerSkillsUsageRpcs, type SkillsUsageDeps } from "../plugin/server/skills-usage";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { DashboardError, skillsUsageRpc, type TraceRecord } from "../plugin/shared/contracts";
import { WORKER, report, turn } from "./fixtures/orchestrator-traces";

/**
 * `skills.usage` (change-014 outcome 4) over a temporary data folder named by
 * `PASEO_BM_HOME`, never the real HOME.
 */

const NOW = new Date("2026-10-01T00:00:00.000Z");
const WS_A = "wks_alpha";
const WS_B = "wks_beta";

/** A Worker turn carrying one report. */
function reported(workspaceId: string, turnId: string, at: string, requestId: string | null, skillsUsed: string[]): TraceRecord {
  return turn({
    workspaceId,
    agentId: WORKER,
    role: "worker",
    turnId,
    at,
    endedAt: at,
    requestId,
    reports: [report({ at, requestId, phase: "finished", skillsUsed })],
  });
}

const ALPHA = [
  reported(WS_A, "t1", "2026-09-28T10:00:00.000Z", "req-1", ["feature-workflow", " implementing-beads "]),
  reported(WS_A, "t2", "2026-09-29T10:00:00.000Z", "req-1", ["feature-workflow", "", "feature-workflow"]),
  reported(WS_A, "t3", "2026-09-30T10:00:00.000Z", "req-2", ["feature-workflow", "Feature-Workflow"]),
  // 40 days back: outside the default 30-day window.
  reported(WS_A, "t4", "2026-08-22T10:00:00.000Z", "req-0", ["reviewing-plan"]),
];
const BETA = [reported(WS_B, "t1", "2026-09-30T12:00:00.000Z", null, ["implementing-beads"])];

let root: string;
let home: string;
let deps: SkillsUsageDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-skills-usage-"));
  home = join(root, "data");
  const lines = (records: TraceRecord[]) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  for (const [workspaceId, records] of [
    [WS_A, ALPHA],
    [WS_B, BETA],
  ] as const) {
    mkdirSync(join(home, "traces", workspaceId), { recursive: true });
    writeFileSync(join(home, "traces", workspaceId, "events-202609.jsonl"), lines(records));
  }
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW };
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("skills.usage", () => {
  it("counts reports and distinct requests per skill across every workspace, sorted", () => {
    const out = handleSkillsUsage({}, deps);
    expect(skillsUsageRpc.output.parse(out)).toEqual(out);
    expect(out.window).toEqual({ since: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" });
    expect(out.skills).toEqual([
      { name: "feature-workflow", reports: 3, requests: 2, lastUsedAt: "2026-09-30T10:00:00.000Z" },
      // A report without a requestId counts as a report, not as a request.
      { name: "implementing-beads", reports: 2, requests: 1, lastUsedAt: "2026-09-30T12:00:00.000Z" },
      // Case is kept: only exact duplicates merge.
      { name: "Feature-Workflow", reports: 1, requests: 1, lastUsedAt: "2026-09-30T10:00:00.000Z" },
    ]);
  });

  it("narrows to one workspace", () => {
    expect(handleSkillsUsage({ workspaceId: WS_B }, deps).skills).toEqual([
      { name: "implementing-beads", reports: 1, requests: 0, lastUsedAt: "2026-09-30T12:00:00.000Z" },
    ]);
  });

  it("follows the window", () => {
    expect(handleSkillsUsage({ workspaceId: WS_A, sinceDays: 1 }, deps).skills).toEqual([
      { name: "Feature-Workflow", reports: 1, requests: 1, lastUsedAt: "2026-09-30T10:00:00.000Z" },
      { name: "feature-workflow", reports: 1, requests: 1, lastUsedAt: "2026-09-30T10:00:00.000Z" },
    ]);
    const wide = handleSkillsUsage({ workspaceId: WS_A, sinceDays: 365 }, deps);
    expect(wide.skills.find((skill) => skill.name === "reviewing-plan")).toEqual({
      name: "reviewing-plan",
      reports: 1,
      requests: 1,
      lastUsedAt: "2026-08-22T10:00:00.000Z",
    });
  });

  it("answers an empty list for an empty store, an unknown workspace or an id the store cannot hold", () => {
    expect(handleSkillsUsage({ workspaceId: "wks_none" }, deps).skills).toEqual([]);
    expect(handleSkillsUsage({ workspaceId: ".." }, deps).skills).toEqual([]);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(handleSkillsUsage({}, { ...deps, env: { PASEO_BM_HOME: empty } }).skills).toEqual([]);
  });

  it("refuses a symlinked workspace folder with the read failure code", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(home, "traces", "wks_link"));
    let thrown: unknown;
    try {
      handleSkillsUsage({ workspaceId: "wks_link" }, deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DashboardError);
    expect((thrown as DashboardError).code).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("bounds sinceDays to 1..365 and defaults it to 30", () => {
    expect(skillsUsageRpc.input.parse({})).toEqual({ sinceDays: 30 });
    expect(() => skillsUsageRpc.input.parse({ sinceDays: 0 })).toThrow();
    expect(() => skillsUsageRpc.input.parse({ sinceDays: 366 })).toThrow();
  });

  it("registers skills.usage", () => {
    const handle = vi.fn();
    registerSkillsUsageRpcs({ handle } as never, deps);
    expect(handle).toHaveBeenCalledWith(skillsUsageRpc, expect.any(Function));
  });
});
