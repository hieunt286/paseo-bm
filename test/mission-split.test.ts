import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCaller } from "../plugin/server/agent-bindings";
import { PENDING_CALLER_MESSAGE, clearBindingCache } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache } from "../plugin/server/decision-store";
import type { MissionSplitEvent } from "../plugin/server/event-bus";
import { splitRefusalsOf } from "../plugin/server/governor-tools";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { SPLIT_SUGGESTED_SAID, createMissionSplitTools } from "../plugin/server/mission-split";
import { JOURNAL_KINDS, createMissionStore, openSplitSuggestionsOf } from "../plugin/server/mission-store";
import { MISSION_NOT_BOUND_MESSAGE, NOT_A_MAIN_MESSAGE } from "../plugin/server/mission-tools";
import { createOrchestratorTools } from "../plugin/server/orchestrator-tools";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { clearTraceStoreCache } from "../plugin/server/trace-store";
import { MISSION_SPLIT_FACE } from "../plugin/shared/bm-tools";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

/**
 * A Main's bm_split_mission (missions design §9.6, §9.7): the owner said the
 * work is another mission; the Main suggests it to the governor, which reads
 * it in bm_missions. On a temporary data folder with a fake Paseo; no daemon
 * is contacted.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const A = "mis-00000000a1";
const B = "mis-00000000b2";
const RA = "req-20261009T100000Z";
const RA2 = "req-20261009T100002Z";
const RB = "req-20261009T100001Z";

let root: string;
let home: string;
let published: MissionSplitEvent[][];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-split-"));
  home = join(root, "data");
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  published = [];
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

const main = (id: string, missionId: string, status: string): FakeAgent => ({
  id,
  provider: "bm-manager",
  status,
  workspaceId: "wks-own",
  labels: { "bm.role": "manager", "bm.missionId": missionId },
  createdAt: "2026-10-09T08:00:00.000Z",
});

/** Main main-a of mission A runs its turn: it is the caller. */
function daemon() {
  return fakePaseo({
    agents: [main("main-a", A, "running"), main("main-b", B, "idle")],
    workspaces: [
      { id: "repo-a", directory: "/repo/api" },
      { id: "repo-b", directory: "/repo/web" },
    ],
  });
}

/** Mission A (PAY, Main main-a, requests RA and RA2 in repo-a) and mission B (WEB, Main main-b, request RB in repo-b). */
function twoMissions(): void {
  const ids = [A, B];
  const store = createMissionStore(home, { now: () => NOW, newId: () => ids.shift()!, env: {} });
  expect(store.create({ code: "PAY", name: "Payments", goal: "Card payments and refunds.", repos: ["repo-a", "repo-b"], createdBy: "owner", mainId: "main-a" }).ok).toBe(true);
  expect(store.create({ code: "WEB", name: "Website", goal: "The new website.", repos: ["repo-b"], createdBy: "owner", mainId: "main-b" }).ok).toBe(true);
  const roster = createMissionRoster(home, { now: () => NOW, env: {} });
  const registry = createRequestRegistry(home, { backfill: () => [] });
  for (const [missionId, requestId, workspaceId, managerId] of [
    [A, RA, "repo-a", "main-a"],
    [A, RA2, "repo-a", "main-a"],
    [B, RB, "repo-b", "main-b"],
  ] as const) {
    roster.add(missionId, { requestId, workspaceId, topic: requestId, workerId: `w-${requestId}` });
    registry.register(workspaceId, requestId, { source: "tool", managerId, workerId: `w-${requestId}` });
  }
}

const caller = (agentId: string | null, missionId: string | null): ToolCaller => ({ agentId, role: "manager", workspaceId: "wks-own", requestId: null, parentId: null, batchId: null, missionId });
const MAIN_A = caller("main-a", A);
const MAIN_B = caller("main-b", B);

function tools(paseo: unknown) {
  return createMissionSplitTools({ paseo: () => paseo, home: () => home, log: () => {}, now: () => NOW, publish: (events) => void published.push([...events]) });
}

const SPLIT = { name: "Refunds", code: "REF", goal: "Refunds end to end.", repos: ["/repo/api"], requestIds: [RA2], reason: "The owner says refunds are their own goal." };
const journalOf = (missionId: string) => createMissionStore(home).journal(missionId, 5_000);

describe("bm_split_mission (§9.6)", () => {
  it("is a bound Manager's tool with bm_create_main's fields, bar the source mission", () => {
    expect(MISSION_SPLIT_FACE).toMatchObject({ name: "bm_split_mission", role: "manager" });
    expect(MISSION_SPLIT_FACE.inputSchema.required).toEqual(["name", "code", "goal", "repos", "reason"]);
    expect(Object.keys(MISSION_SPLIT_FACE.inputSchema.properties!)).toEqual(["name", "code", "goal", "repos", "requestIds", "reason"]);
    expect(MISSION_SPLIT_FACE.description).toContain("Ask the owner first; call it only on their yes, never create the mission yourself.");
    expect(JOURNAL_KINDS).toContain("split-suggested");
  });

  it("on the owner's yes, during the Main's own turn: a split-suggested journal line with the fields, and mission.split to the governor", async () => {
    twoMissions();
    const fake = daemon();
    const result = await tools(fake.paseo).call("bm_split_mission", SPLIT, MAIN_A);

    expect(result.ok, result.text).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ suggested: { code: "REF", name: "Refunds", repos: ["repo-a"], requestIds: [RA2] }, governor: SPLIT_SUGGESTED_SAID });
    expect(SPLIT_SUGGESTED_SAID).toContain("Tell the owner in one line that the new mission is with the governor");
    const fields = { code: "REF", name: "Refunds", goal: "Refunds end to end.", repos: ["repo-a"], requestIds: [RA2], reason: "The owner says refunds are their own goal." };
    expect(journalOf(A).at(-1)).toEqual({
      at: NOW.toISOString(),
      kind: "split-suggested",
      by: "main",
      text: `On the owner's yes the Main suggested a new mission REF "Refunds" (repos repo-a; requests ${RA2}) to the governor: The owner says refunds are their own goal.`,
      ref: "main-a",
      split: fields,
    });
    expect(published).toEqual([[{ type: "mission.split", missionId: A, ...fields, at: NOW.toISOString() }]]);
    expect(openSplitSuggestionsOf(home, A)).toEqual([{ ...fields, at: NOW.toISOString(), by: "main-a" }]);
    // Nothing else moved: the request stays on the source's roster; no mission REF yet.
    expect(createMissionRoster(home).list(A).map((entry) => entry.requestId)).toEqual([RA, RA2]);
    expect(createMissionStore(home).list().map((entry) => entry.code)).toEqual(["PAY", "WEB"]);
  });

  it("refuses a second open suggestion of the same code, from the same Main or another, writing nothing", async () => {
    twoMissions();
    const run = tools(daemon().paseo);
    expect((await run.call("bm_split_mission", SPLIT, MAIN_A)).ok).toBe(true);
    const lines = journalOf(A).length;
    const again = await run.call("bm_split_mission", { ...SPLIT, name: "Refunds again" }, MAIN_A);
    expect(again).toEqual({ ok: false, text: `code REF: you suggested that mission already (${NOW.toISOString()}); the governor decides it\nNothing was recorded or sent.` });
    const other = await run.call("bm_split_mission", { ...SPLIT, repos: ["repo-b"], requestIds: [RB] }, MAIN_B);
    expect(other.text).toBe(`code REF: mission PAY's Main suggested a mission with it already (${NOW.toISOString()}); ask the owner for another code\nNothing was recorded or sent.`);
    expect(journalOf(A)).toHaveLength(lines);
    expect(journalOf(B).some((line) => line.kind === "split-suggested")).toBe(false);
    expect(published).toHaveLength(1);
  });

  it("refuses, one line per reason and writing nothing: a taken code, an unknown repo, a request off the roster, too many splits, a closed mission, a caller that is no Main", async () => {
    twoMissions();
    const fake = daemon();
    const run = tools(fake.paseo);
    const before = journalOf(A).length;
    const refused = async (input: Record<string, unknown>, who: ToolCaller | null = MAIN_A) => {
      const result = await run.call("bm_split_mission", { ...SPLIT, ...input }, who);
      expect(result.ok, result.text).toBe(false);
      return result.text;
    };

    expect(await refused({ code: "WEB", repos: ["repo-x"], requestIds: [RB] })).toBe(
      [
        "code WEB is taken by the open mission Website",
        "repos: repo-x is not a workspace Paseo lists",
        `request ${RB} is not on the roster of mission PAY`,
        "Nothing was recorded or sent.",
      ].join("\n"),
    );
    expect(await refused({ code: "ref" })).toContain("The call was refused. Fix these and call bm_split_mission again:");
    expect(await refused({}, caller("stranger", null))).toBe(NOT_A_MAIN_MESSAGE);
    expect(await refused({}, null)).toBe(MISSION_NOT_BOUND_MESSAGE);
    expect(await refused({}, caller(null, A))).toBe(PENDING_CALLER_MESSAGE);
    expect((await tools(null).call("bm_split_mission", SPLIT, MAIN_A)).text).toContain("paseo-bm has no connection to Paseo yet");

    // Two splits of PAY today: a third is refused.
    const store = createMissionStore(home, { now: () => NOW, env: {} });
    for (const code of ["ONE", "TWO"]) store.create({ code, name: code, goal: "Split.", repos: ["repo-a"], createdBy: "orchestrator", parentMissionId: A, splitReason: "Split." });
    expect(await refused({})).toBe("mission PAY was split 2 times in the last 24 hours; at most 2\nNothing was recorded or sent.");

    store.update(A, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    expect(await refused({})).toBe("mission PAY is closed\nNothing was recorded or sent.");

    expect(journalOf(A)).toHaveLength(before);
    expect(published).toEqual([]);
  });

  it("skips only the running-Main check, which bm_create_main keeps", async () => {
    twoMissions();
    const source = createMissionStore(home).get(A);
    const split = { name: "Refunds", code: "REF", goal: "Refunds.", repos: ["repo-a"], requestIds: [], reason: "Because." };
    const running = "the Main of mission PAY is running a turn; split it once that turn ends";
    expect(await splitRefusalsOf(home, source, split, daemon().paseo, NOW)).toEqual([running]);
    expect(await splitRefusalsOf(home, source, split, daemon().paseo, NOW, { mainMayRun: true })).toEqual([]);
  });

  it("stays open until a mission takes its code or the source mission closes", async () => {
    twoMissions();
    expect((await tools(daemon().paseo).call("bm_split_mission", SPLIT, MAIN_A)).ok).toBe(true);
    const store = createMissionStore(home, { now: () => NOW, env: {} });
    const made = store.create({ code: "REF", name: "Refunds", goal: "Refunds.", repos: ["repo-a"], createdBy: "orchestrator", parentMissionId: A, splitReason: "Split." });
    expect(made.ok).toBe(true);
    expect(openSplitSuggestionsOf(home, A)).toEqual([]);
    // Closed later, the code stays taken for that suggestion: the mission was made after it.
    if (made.ok) store.update(made.mission.missionId, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    expect(openSplitSuggestionsOf(home, A)).toEqual([]);

    expect((await tools(daemon().paseo).call("bm_split_mission", { ...SPLIT, code: "CARD" }, MAIN_A)).ok).toBe(true);
    expect(openSplitSuggestionsOf(home, A).map((suggestion) => suggestion.code)).toEqual(["CARD"]);
    store.update(A, (mission) => ({ ...mission, state: "closed", closedAt: NOW.toISOString() }));
    expect(openSplitSuggestionsOf(home, A)).toEqual([]);
  });
});

describe("bm_missions shows each mission's open split suggestions (§9.6)", () => {
  it("lists them with bm_create_main's fields, and drops one once a mission takes its code", async () => {
    twoMissions();
    const fake = daemon();
    expect((await tools(fake.paseo).call("bm_split_mission", SPLIT, MAIN_A)).ok).toBe(true);
    const governor = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {}, log: () => {} });
    governor.usePaseo(fake.paseo);
    const read = async () => {
      const result = await governor.call("bm_missions", {});
      expect(result.ok, result.text).toBe(true);
      return (JSON.parse(result.text.slice(result.text.indexOf("{"))) as { missions: Array<{ code: string; splitSuggestions: unknown[] }> }).missions;
    };

    const missions = await read();
    expect(missions.find((mission) => mission.code === "PAY")!.splitSuggestions).toEqual([
      { at: NOW.toISOString(), by: "main-a", code: "REF", name: "Refunds", goal: "Refunds end to end.", repos: ["repo-a"], requestIds: [RA2], reason: "The owner says refunds are their own goal." },
    ]);
    expect(missions.find((mission) => mission.code === "WEB")!.splitSuggestions).toEqual([]);

    createMissionStore(home, { now: () => NOW, env: {} }).create({ code: "REF", name: "Refunds", goal: "Refunds.", repos: ["repo-a"], createdBy: "owner" });
    expect((await read()).find((mission) => mission.code === "PAY")!.splitSuggestions).toEqual([]);
  });
});
