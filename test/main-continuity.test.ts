import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { createMissionStore } from "../plugin/server/mission-store";
import { handOverMain, handleMissionEnsure, type MissionsPaseo } from "../plugin/server/missions-home";
import { MAIN_WRITE_TOOLS, replaceMain, replacedMainRefusalOf } from "../plugin/server/mission-replace";
import { DEFAULT_COORDINATION_SETTINGS, mainContextCrossingOf, mainContextHardOf } from "../plugin/shared/coordination";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { fakeCli } from "./helpers/fake-cli";
import { roleAliases, roleProfiles } from "./helpers/roles";

/**
 * A long-lived Main (mission runtime design §3, ADR-033 decision 2,
 * REQ-203): the Main's figure is its real context, never the per-turn sum;
 * one replacement path — single flight, idempotent, compare-and-set; a
 * `mission.ensure` during a handoff joins it (the XAI race); a replaced Main
 * writes nothing. A fake Paseo and a temporary data folder; no daemon.
 */

const MISSION = "mis-0123456789";
const MAIN = "main-1";
const T0 = Date.parse("2026-10-10T04:34:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-main-continuity-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  const created = createMissionStore(home, { newId: () => MISSION }).create({ code: "XAI", name: "Xây dựng AI Assistant", goal: "g", repos: ["wks-a"], createdBy: "owner", mainId: MAIN });
  if (!created.ok) throw new Error(created.reasons.join("; "));
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearJsonFileCache();
  clearBindingCache();
  rmSync(root, { recursive: true, force: true });
});

function daemon(created?: NonNullable<Parameters<typeof fakePaseo>[0]>["created"]) {
  const agents: FakeAgent[] = [{ id: MAIN, workspaceId: "wks-own", provider: "bm-manager", status: "idle", createdAt: iso(T0), labels: { "bm.role": "manager", "bm.missionId": MISSION }, archivedAt: null }];
  return fakePaseo<MissionsPaseo>({
    agents,
    workspaces: [{ id: "wks-a", directory: "/repo/api" }],
    config: { providers: roleAliases("claude", ["manager"]), agentProfiles: roleProfiles("claude-opus-5", ["manager"]) },
    omit: ["providers"],
    ...(created === undefined ? {} : { created }),
  });
}
const mainLines = () => createMissionStore(home).journal(MISSION, 20).filter((line) => line.kind === "main").map((line) => line.text);

describe("the Main's figure (design §3.1, §3.2)", () => {
  const settings = DEFAULT_COORDINATION_SETTINGS;
  it("crosses on its real context: the share of a reported window, else the context tokens; never the token sum", () => {
    expect(mainContextCrossingOf({ context: { tokens: 110_000 }, contextShare: null }, settings)).toBeNull();
    expect(mainContextCrossingOf({ context: { tokens: 150_000 }, contextShare: null }, settings)).toEqual({ figure: "contextTokens", value: 150_000, threshold: 150_000 });
    expect(mainContextCrossingOf({ context: { tokens: 590_000 }, contextShare: 0.59 }, settings)).toBeNull();
    expect(mainContextCrossingOf({ context: { tokens: 600_000 }, contextShare: 0.6 }, settings)).toEqual({ figure: "contextShare", value: 0.6, threshold: 0.6 });
    expect(mainContextCrossingOf({ context: null, contextShare: null }, settings)).toBeNull();
  });

  it("the hard figure: hardShare of the window, else contextTokens ÷ contextShare × hardShare", () => {
    expect(mainContextHardOf({ context: { tokens: 0 }, contextShare: 0.84 }, settings)).toBe(false);
    expect(mainContextHardOf({ context: { tokens: 0 }, contextShare: 0.85 }, settings)).toBe(true);
    expect(mainContextHardOf({ context: { tokens: 212_499 }, contextShare: null }, settings)).toBe(false);
    expect(mainContextHardOf({ context: { tokens: 212_500 }, contextShare: null }, settings)).toBe(true);
  });
});

describe("one replacement path (design §3.4)", () => {
  it("is idempotent, refuses a stale compare-and-set, and runs one at a time per mission", async () => {
    const deps = { home, log: () => {} };
    const [a, b] = await Promise.all([replaceMain(MISSION, "new-1", "owner", { ...deps, expectedOld: MAIN }), replaceMain(MISSION, "new-2", "owner", { ...deps, expectedOld: MAIN })]);
    expect(a.ok).toBe(true);
    // The second read the mission after the first: its Main changed meanwhile.
    expect(b).toEqual({ ok: false, reasons: ["the mission's Main changed meanwhile (it is new-1, not main-1)"] });
    expect(await replaceMain(MISSION, "new-1", "owner", deps)).toMatchObject({ ok: true, replaced: null, workers: [] });
    expect(mainLines()).toEqual([`Main new-1 replaces ${MAIN} (owner).`]);
  });

  it("the XAI race: a mission.ensure during a handoff joins it — one successor, one journal line", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = daemon(async () => {
      await gate;
      return {};
    });
    const { cli } = fakeCli();
    const deps = { home, cli, log: () => {}, readInstructions: async () => "instructions" };
    const handoff = handOverMain(createMissionStore(home).get(MISSION)!, fake.paseo, "notice", deps as never);
    // Let the handoff reach its creation, then the owner opens the Main from the Missions screen.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const opened = handleMissionEnsure({ missionId: MISSION }, fake.paseo, deps as never);
    release();
    const [successor, ensure] = await Promise.all([handoff, opened]);
    expect(fake.creates).toHaveLength(1);
    expect(ensure).toMatchObject({ agentId: successor, created: false });
    expect(createMissionStore(home).get(MISSION)!.mainHistory.map((entry) => entry.reason)).toEqual(["created", "handoff"]);
    expect(mainLines()).toEqual([`Main ${successor} replaces ${MAIN} (handoff).`]);
  });
});

describe("a replaced Main (design §3.6)", () => {
  it("is refused every write or send tool, naming the current Main; reads still answer", async () => {
    await replaceMain(MISSION, "new-1", "owner", { home, log: () => {} });
    const old = { agentId: MAIN, missionId: MISSION };
    for (const tool of MAIN_WRITE_TOOLS) expect(replacedMainRefusalOf(home, old, tool), tool).toContain("You were replaced by Main new-1 of mission XAI");
    for (const tool of ["bm_mission", "bm_decisions", "bm_repo", "bm_memory", "bm_peers"]) expect(replacedMainRefusalOf(home, old, tool), tool).toBeNull();
    expect(replacedMainRefusalOf(home, { agentId: "new-1", missionId: MISSION }, "bm_tell_worker")).toBeNull();
    expect(replacedMainRefusalOf(home, { agentId: MAIN, missionId: null }, "bm_tell_worker")).toBeNull();
  });
});
