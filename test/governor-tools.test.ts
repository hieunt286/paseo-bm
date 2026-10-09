import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBindingCache } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { handleDecisionsAnswer } from "../plugin/server/decision-rpc";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import { createArbitrationStore } from "../plugin/server/governor-conflicts";
import { MAX_SPLITS_PER_DAY, type GovernorMissionDeps } from "../plugin/server/governor-tools";
import type { ManagerAgentProfile } from "../plugin/server/manager";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { clearRequestIndexCache, createMissionRoster, requestIndexOf } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createOrchestratorTools, type OrchestratorToolsDeps } from "../plugin/server/orchestrator-tools";
import type { PaseoCliDeps } from "../plugin/server/paseo-cli";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { rolePaseoToolsPolicy } from "../plugin/server/setup-roles";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { parseCommandBlock } from "../plugin/shared/orchestrator-command";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

/**
 * The governor's bm_arbitrate and bm_create_main (missions design §9.6, §4.1;
 * WP-204), and the owner's tap on their m: cards, on a temporary data folder
 * with a fake Paseo and a fake `paseo` CLI. No daemon is contacted.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const A = "mis-00000000a1";
const B = "mis-00000000b2";
const RA = "req-20261009T100000Z";
const RA2 = "req-20261009T100002Z";
const RB = "req-20261009T100001Z";

let root: string;
let home: string;
let enqueue: ReturnType<typeof vi.fn<(target: string, kind: string, text: string, paseo?: unknown) => Promise<"sent" | "queued" | "dropped">>>;
let cliCalls: string[][];
let missions: GovernorMissionDeps;
let deps: OrchestratorToolsDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-governor-tools-"));
  home = join(root, "data");
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  enqueue = vi.fn(async () => "sent" as const);
  cliCalls = [];
  const cli: PaseoCliDeps = { find: () => "/bin/paseo", run: async (_file, args) => (cliCalls.push(args), { code: 0, output: "", timedOut: false }) };
  missions = { cli, readInstructions: async (_paseo, workspaceId, missionId) => `instructions ${workspaceId} ${missionId ?? "none"}` };
  let ids = 0;
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {}, store: { now: () => NOW, newId: () => `command-${++ids}` }, queue: { enqueue }, log: () => {}, missions };
  clearRequestIndexCache();
  clearTraceStoreCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearRequestIndexCache();
  clearTraceStoreCache();
  clearDecisionStoreCache();
  clearJsonFileCache();
  clearBindingCache();
  rmSync(root, { recursive: true, force: true });
});

const roleAliases = (): Record<string, unknown> => ({
  "bm-manager": { extends: "codex", label: "Beads Manager", paseoTools: rolePaseoToolsPolicy("manager") },
  "bm-worker": { extends: "codex", label: "Beads Worker", paseoTools: rolePaseoToolsPolicy("worker") },
  "bm-reviewer": { extends: "codex", label: "Beads Reviewer", paseoTools: rolePaseoToolsPolicy("reviewer") },
  "bm-orchestrator": { extends: "codex", label: "Beads Orchestrator", paseoTools: rolePaseoToolsPolicy("orchestrator") },
});
const profiles = (): ManagerAgentProfile[] => [
  { id: "bm-manager", provider: "bm-manager", model: "gpt-5.6-sol" },
  { id: "bm-worker", provider: "bm-worker", model: "gpt-5.6-sol" },
  { id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol" },
  { id: "bm-orchestrator", provider: "bm-orchestrator", model: "gpt-5.6-sol" },
];

const main = (id: string, missionId: string, status = "idle"): FakeAgent => ({
  id,
  provider: "bm-manager",
  status,
  workspaceId: "wks-own",
  labels: { "bm.role": "manager", "bm.missionId": missionId },
  createdAt: "2026-10-09T08:00:00.000Z",
});
const worker = (id: string, requestId: string): FakeAgent => ({
  id,
  provider: "bm-worker",
  status: "idle",
  workspaceId: "repo-a",
  labels: { "bm.role": "worker", "paseo.parent-agent-id": "main-a", "bm.requestId": requestId },
  createdAt: "2026-10-09T09:00:00.000Z",
});
const orchestrator: FakeAgent = {
  id: "agent-orchestrator",
  provider: "bm-orchestrator",
  status: "running",
  workspaceId: "wks-home",
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main" },
  createdAt: "2026-10-09T07:00:00.000Z",
};

function daemon(mainStatus = "idle") {
  return fakePaseo({
    agents: [main("main-a", A, mainStatus), main("main-b", B), worker("w-a", RA), worker("w-a2", RA2), orchestrator],
    workspaces: [
      { id: "repo-a", directory: "/repo/api" },
      { id: "repo-b", directory: "/repo/web" },
    ],
    config: { providers: roleAliases(), agentProfiles: profiles() },
    omit: ["providers"],
  });
}

/** Mission A (PAY, Main main-a, requests RA and RA2 in repo-a) and mission B (WEB, Main main-b, request RB in repo-b). */
function twoMissions(): void {
  const ids = [A, B];
  const store = createMissionStore(home, { now: () => NOW, newId: () => ids.shift()!, env: {} });
  expect(store.create({ code: "PAY", name: "Payments", goal: "Card payments and refunds.", repos: ["repo-a", "repo-b"], createdBy: "owner", mainId: "main-a" }).ok).toBe(true);
  expect(store.create({ code: "WEB", name: "Website", goal: "The new website and its pay page.", repos: ["repo-b"], createdBy: "owner", mainId: "main-b" }).ok).toBe(true);
  const roster = createMissionRoster(home, { now: () => NOW, env: {} });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  for (const [missionId, requestId, workspaceId, workerId, managerId] of [
    [A, RA, "repo-a", "w-a", "main-a"],
    [A, RA2, "repo-a", "w-a2", "main-a"],
    [B, RB, "repo-b", "w-b", "main-b"],
  ] as const) {
    roster.add(missionId, { requestId, workspaceId, topic: requestId, workerId });
    registry.register(workspaceId, requestId, { source: "tool", managerId, workerId });
  }
}

function toolsWith(paseo: unknown) {
  const tools = createOrchestratorTools(deps);
  tools.usePaseo(paseo);
  return tools;
}

const answer = (id: string, optionKey: string, paseo: unknown) => handleDecisionsAnswer({ id, optionKey }, paseo, { home, now: () => NOW, log: () => {}, cli: missions.cli!, missions });

describe("bm_arbitrate (§9.6)", () => {
  it("records the call, journals both missions, sends both Mains governor:arbitrate, and opens the losing mission's card when it changes the goal", async () => {
    twoMissions();
    const fake = daemon();
    const result = await toolsWith(fake.paseo).call("bm_arbitrate", {
      missions: [A, B],
      workspaceId: "repo-b",
      area: "src/pay/**",
      owner: A,
      reason: "Payments owns the pay page.",
      goal: "The new website, without its pay page.",
    });

    expect(result.ok, result.text).toBe(true);
    const [entry] = createArbitrationStore(home).list();
    expect(entry).toMatchObject({ missions: [A, B], workspaceId: "repo-b", area: "src/pay", owner: A, reason: "Payments owns the pay page.", decisionId: `m:${B}:1` });
    expect(entry!.commandIds).toHaveLength(2);
    expect(enqueue.mock.calls.map(([target]) => target)).toEqual(["main-a", "main-b"]);
    const blocks = enqueue.mock.calls.map(([, , text]) => parseCommandBlock(text)!);
    expect(blocks.map((block) => block.authority)).toEqual(["governor:arbitrate", "governor:arbitrate"]);
    expect(blocks.every((block) => block.effects.length === 0)).toBe(true);
    expect(blocks[1]!.body).toContain(`Leave that area to mission PAY (Payments)`);
    expect(blocks[1]!.body).toContain(`The owner is asked on card m:${B}:1 to change your goal`);
    for (const missionId of [A, B]) {
      expect(createMissionStore(home).journal(missionId).find((line) => line.ref === entry!.id)).toMatchObject({ kind: "governor", by: "orchestrator", text: `Arbitration ${entry!.id}: src/pay in repo-b belongs to mission PAY. Payments owns the pay page.` });
    }
    const card = createMissionDecisionStore(home).get(`m:${B}:1`)!;
    expect(card.options.map((option) => [option.key, option.action?.kind ?? null])).toEqual([
      ["apply", "arbitration"],
      ["keep", null],
    ]);
    expect(createMissionStore(home).get(B)!.charter.goal).toBe("The new website and its pay page.");

    // Only the owner's tap sets the goal.
    await answer(card.id, "apply", fake.paseo);
    expect(createMissionStore(home).get(B)!.charter.goal).toBe("The new website, without its pay page.");
    expect(createMissionStore(home).journal(B).at(-1)).toMatchObject({ kind: "charter", by: "owner", ref: card.id });
  });

  it("refuses the same mission twice, an owner outside the two, an unknown or closed mission, and a goal that changes nothing, recording nothing", async () => {
    twoMissions();
    const tools = toolsWith(daemon().paseo);
    const call = (input: Record<string, unknown>) => tools.call("bm_arbitrate", { missions: [A, B], workspaceId: "repo-b", area: "src", owner: A, reason: "Because.", ...input });
    expect((await call({ missions: [A, A] })).text).toContain("missions: name two different missions");
    expect((await call({ owner: "mis-00000000c3" })).text).toContain("owner: must be one of the two missions");
    expect((await call({ missions: [A, "mis-00000000c3"] })).text).toContain("no mission mis-00000000c3");
    expect((await call({ goal: "The new website and its pay page." })).text).toContain("it is mission WEB's goal already");
    createMissionStore(home).update(B, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    expect((await call({})).text).toContain("mission WEB is closed");
    expect(createArbitrationStore(home).list()).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("bm_create_main (§9.6)", () => {
  const split = { fromMissionId: A, name: "Refunds", code: "REF", goal: "Refunds end to end.", repos: ["repo-a"], requestIds: [RA2], reason: "Refunds grew into their own work." };

  it("without the split cell it asks the owner on an m: card; the owner's tap creates the mission, its Main, and moves the request and its Worker", async () => {
    twoMissions();
    const fake = daemon();
    const asked = await toolsWith(fake.paseo).call("bm_create_main", split);
    expect(asked.ok, asked.text).toBe(true);
    expect(asked.text).toContain(`asked on card m:${A}:1`);
    expect(createMissionStore(home).list().map((entry) => entry.code)).toEqual(["PAY", "WEB"]);
    const card = createMissionDecisionStore(home).get(`m:${A}:1`)!;
    expect(card.options[0]!.action).toMatchObject({ kind: "mission-split", missionId: A, split: { code: "REF", requestIds: [RA2] } });
    expect((await toolsWith(fake.paseo).call("bm_create_main", split)).text).toContain(`the owner's card m:${A}:1 asks this split already`);

    await answer(card.id, "apply", fake.paseo);

    const made = createMissionStore(home).list().find((entry) => entry.code === "REF")!;
    const mission = createMissionStore(home).get(made.missionId)!;
    expect(mission).toMatchObject({ createdBy: "orchestrator", parentMissionId: A, splitReason: split.reason, mainId: "created-1", charter: { goal: split.goal, repos: ["repo-a"] } });
    expect(createMissionRoster(home).list(A).map((entry) => entry.requestId)).toEqual([RA]);
    expect(createMissionRoster(home).list(made.missionId).map((entry) => entry.requestId)).toEqual([RA2]);
    expect(requestIndexOf(home, RA2)).toEqual({ missionId: made.missionId, workspaceId: "repo-a" });
    expect(createRequestRegistry(home).get("repo-a", RA2)).toMatchObject({ managerId: "created-1", missionId: made.missionId });
    expect(createRequestRegistry(home).get("repo-a", RA)).toMatchObject({ managerId: "main-a" });
    expect(fake.creates[0]!.options.labels).toMatchObject({ "bm.missionId": made.missionId, "bm.missionCode": "REF" });
    expect(cliCalls).toContainEqual(["agent", "update", "w-a2", "--label", "paseo.parent-agent-id=created-1", "--json"]);
    expect(createMissionStore(home).journal(A).map((line) => line.text)).toContain(`Split: mission REF took requests ${RA2}: ${split.reason}`);
  });

  it("with the split cell delegated it splits at once", async () => {
    twoMissions();
    createMissionAutonomyStore(home).setCell(A, "split", "delegate");
    const fake = daemon();
    const result = await toolsWith(fake.paseo).call("bm_create_main", split);
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("Split on mission PAY's split cell");
    expect(createMissionDecisionStore(home).list(A)).toEqual([]);
    const made = createMissionStore(home).list().find((entry) => entry.code === "REF")!;
    expect(createMissionStore(home).get(made.missionId)).toMatchObject({ parentMissionId: A, mainId: "created-1" });
    expect(createMissionRoster(home).list(made.missionId).map((entry) => entry.requestId)).toEqual([RA2]);
  });

  it("refuses while the source's Main runs, a request off its roster, a taken code, and a third split in 24 hours, changing nothing", async () => {
    twoMissions();
    createMissionAutonomyStore(home).setCell(A, "split", "delegate");
    const running = await toolsWith(daemon("running").paseo).call("bm_create_main", split);
    expect(running.text).toContain("the Main of mission PAY is running a turn");
    const tools = toolsWith(daemon().paseo);
    expect((await tools.call("bm_create_main", { ...split, requestIds: [RB] })).text).toContain(`request ${RB} is not on the roster of mission PAY`);
    expect((await tools.call("bm_create_main", { ...split, code: "WEB" })).text).toContain("code WEB is taken by the open mission Website");
    const store = createMissionStore(home, { now: () => NOW });
    for (let n = 0; n < MAX_SPLITS_PER_DAY; n += 1) store.create({ code: `OLD${n}`, name: "Earlier split", goal: "x", repos: ["repo-a"], createdBy: "orchestrator", parentMissionId: A, splitReason: "earlier" });
    expect((await tools.call("bm_create_main", split)).text).toContain(`mission PAY was split ${MAX_SPLITS_PER_DAY} times in the last 24 hours`);
    expect(createMissionRoster(home).list(A).map((entry) => entry.requestId)).toEqual([RA, RA2]);
    expect(createMissionStore(home).list().some((entry) => entry.code === "REF")).toBe(false);
  });
});
