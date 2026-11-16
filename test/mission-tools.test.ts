import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore, type ToolCaller } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { materialiseTurn } from "../plugin/server/decision-materialiser";
import { handleDecisionsAnswer, handleDecisionsGet, handleDecisionsList } from "../plugin/server/decision-rpc";
import { createDecisionStore } from "../plugin/server/decision-store";
import { heldRequestsOf } from "../plugin/server/held-requests";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { MISSION_DECISION_ID_PATTERN, createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { contractStatusOf, createMissionStore } from "../plugin/server/mission-store";
import { MISSION_JOURNAL_SHOWN, MISSION_NOT_BOUND_MESSAGE, MISSION_SETTLED_SHOWN, NOT_A_MAIN_MESSAGE, applyFreeUpdate, applyMissionChange, applyMissionDecision, createMissionTools, type FreeMissionUpdate } from "../plugin/server/mission-tools";
import { ensureMissionsHome, missionsHomeDirOf, type MissionsPaseo } from "../plugin/server/missions-home";
import { createOutbox } from "../plugin/server/outbox";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { clearProposedMissionStarts, proposedMissionStartOf } from "../plugin/server/proposed-mission-starts";
import { decisionsListRpc } from "../plugin/shared/contracts";
import { DECISION_ID_PATTERN, answerDecision } from "../plugin/shared/decisions";
import { at, msg, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";
import { fakeCli } from "./helpers/fake-cli";

/**
 * WP-105 (missions design §4, §4.1): bm_mission, bm_mission_start settled at
 * the turn's end only with the owner's message, and bm_mission_update's free
 * changes and m: cards applied on the owner's tap. A fake Paseo and a fake
 * `paseo` CLI; no daemon is contacted.
 */

const MAIN = "main-1";
const TURN = at(1);
const NOW = new Date("2026-10-09T10:00:00.000Z");

let root: string;
let home: string;
let logs: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-tools-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  logs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearJsonFileCache();
  clearBindingCache();
  clearProposedMissionStarts();
  rmSync(root, { recursive: true, force: true });
});

function daemon(agents: FakeAgent[] = []) {
  return fakePaseo<MissionsPaseo>({
    agents,
    workspaces: [
      { id: "wks-a", directory: "/repo/api" },
      { id: "wks-b", directory: "/repo/web" },
      { id: "wks-gone", directory: "/repo/gone", archivedAt: "2026-10-01T00:00:00.000Z" },
      { id: "wks-own", directory: missionsHomeDirOf(home) },
    ],
  });
}

const caller = (overrides: Partial<ToolCaller> = {}): ToolCaller => ({
  agentId: MAIN,
  role: "manager",
  workspaceId: "wks-own",
  requestId: null,
  parentId: null,
  batchId: null,
  ...overrides,
});

async function setup(agents: FakeAgent[] = []) {
  const fake = daemon(agents);
  await ensureMissionsHome(fake.paseo, { home });
  const tools = createMissionTools({ paseo: () => fake.paseo, home: () => home, log: (line) => logs.push(line), now: () => NOW, turnStartOf: () => TURN });
  const call = async (name: string, input: unknown, who: ToolCaller | null = caller()) => tools.call(name, input, who);
  const json = async (name: string, input: unknown, who?: ToolCaller | null) => {
    const result = await call(name, input, who);
    expect(result.ok, result.text).toBe(true);
    return JSON.parse(result.text) as Record<string, unknown>;
  };
  return { fake, call, json };
}

/** A mission whose Main is MAIN, and the caller bound to it. */
function missionOf(overrides: { repos?: string[] } = {}) {
  const created = createMissionStore(home, { now: () => NOW }).create({ code: "WEB", name: "Website", goal: "Ship v2", repos: overrides.repos ?? ["wks-a"], createdBy: "owner", mainId: MAIN });
  if (!created.ok) throw new Error(created.reasons.join("; "));
  return { mission: created.mission, who: caller({ missionId: created.mission.missionId }) };
}

const START = { name: "Billing", code: "BILL", goal: "Invoices in the app", repos: ["wks-a", "/repo/web"] };

describe("bm_mission_start (§4)", () => {
  it("refuses a caller that is not bound, a Main outside the home, one already in a mission, a taken code and repos that are not projects", async () => {
    const { call } = await setup();
    expect(await call("bm_mission_start", START, null)).toEqual({ ok: false, text: MISSION_NOT_BOUND_MESSAGE });
    expect((await call("bm_mission_start", START, caller({ workspaceId: "wks-a" }))).text).toContain("Missions home");
    const { mission, who } = missionOf();
    expect((await call("bm_mission_start", START, who)).text).toContain(`mission ${mission.code} already`);
    const other = caller({ agentId: "main-2" });
    const refused = await call("bm_mission_start", { ...START, code: "WEB", repos: ["wks-gone", "wks-nope", "wks-own"] }, other);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("input.code: WEB is taken by the open mission Website");
    expect(refused.text).toContain("input.repos: wks-gone is archived");
    expect(refused.text).toContain("input.repos: wks-nope is not a workspace Paseo lists");
    expect(refused.text).toContain("input.repos: wks-own is a paseo-bm home, not a repository");
    expect(proposedMissionStartOf("main-2", TURN)).toBeNull();
  });

  it("only proposes; the turn's end records it only when the turn holds the owner's own message", async () => {
    const { json } = await setup();
    const bindings = createBindingStore(home);
    const issued = bindings.issue({ role: "manager", workspaceId: "wks-own" });
    bindings.attach(issued.token, "manager");
    bindings.settle(issued.tokenSha256, MAIN);
    expect(await json("bm_mission_start", START)).toMatchObject({ proposed: { code: "BILL", repos: ["wks-a", "wks-b"] } });
    expect(createMissionStore(home).list()).toEqual([]);
    const { cli, calls } = fakeCli();
    const record = (origin: "user" | "agent") => turn({ agentId: MAIN, role: "manager", workspaceId: "wks-own", startedAt: TURN, sent: [msg(MAIN, at(1, 5), "Billing, BILL, api and web", origin)] });

    // A turn without the owner's message drops it.
    await materialiseTurn(record("agent"), { home, log: (line) => logs.push(line), cli });
    expect(createMissionStore(home).list()).toEqual([]);
    expect(logs.some((line) => line.includes("was not recorded: its turn holds no message of the owner's"))).toBe(true);
    expect(calls).toEqual([]);

    // Proposed again, in a turn with the owner's message: recorded, bound, labelled and titled.
    await json("bm_mission_start", START);
    await materialiseTurn(record("user"), { home, log: (line) => logs.push(line), cli });
    const [entry] = createMissionStore(home).list();
    expect(entry).toMatchObject({ code: "BILL", name: "Billing", mainId: MAIN, repos: ["wks-a", "wks-b"], state: "open" });
    const mission = createMissionStore(home).get(entry!.missionId)!;
    expect(mission.createdBy).toBe("owner");
    expect(mission.charter.goal).toBe("Invoices in the app");
    expect(createBindingStore(home).bindingOfAgent(MAIN)?.missionId).toBe(mission.missionId);
    expect(calls).toEqual([
      ["agent", "update", MAIN, "--label", `bm.missionId=${mission.missionId}`, "--label", "bm.missionCode=BILL", "--json"],
      ["agent", "update", MAIN, "--name", "🟣 M · BILL Billing", "--json"],
    ]);
    expect(createMissionStore(home).journal(mission.missionId).map((line) => line.kind)).toEqual(["charter"]);
  });
});

describe("bm_mission (§4)", () => {
  it("reads the caller's mission with its roster, open questions, owner cards, level and journal; refuses a non-Main", async () => {
    const { json, call } = await setup();
    expect(await call("bm_mission", {})).toEqual({ ok: false, text: NOT_A_MAIN_MESSAGE });
    const { mission, who } = missionOf();
    createMissionRoster(home).add(mission.missionId, { requestId: "req-20261009T100000Z", workspaceId: "wks-a", topic: "invoice API", workerId: "wkr-1" });
    createMissionStore(home).appendJournal(mission.missionId, { kind: "note", by: "plugin", text: "hello" });
    const read = await json("bm_mission", {}, who);
    expect(read["mission"]).toMatchObject({ missionId: mission.missionId, code: "WEB", state: "open" });
    expect(read["charter"]).toMatchObject({ goal: "Ship v2", repos: [{ workspaceId: "wks-a", folder: "/repo/api" }] });
    expect(read["requests"]).toEqual([
      expect.objectContaining({ requestId: "req-20261009T100000Z", repo: { workspaceId: "wks-a", folder: "/repo/api" }, workerId: "wkr-1", phase: null, openQuestions: [] }),
    ]);
    expect(read["level"]).toEqual({ level: 2, delegated: ["proceed", "staffing"], owner: ["scope-repo", "answer-technical", "answer-effects", "split"] });
    expect(read["journal"]).toEqual([expect.objectContaining({ kind: "note", text: "hello" })]);
    expect(read["ownerCards"]).toEqual([]);
    expect(read).not.toHaveProperty("settledMore");
    expect(read).not.toHaveProperty("request");
  });

  /** A roster of `settled` settled requests, then one active one; returns the settled ids oldest first. */
  function rosterOf(missionId: string, settled: number): string[] {
    const roster = createMissionRoster(home);
    const ids: string[] = [];
    for (let n = 0; n < settled; n += 1) {
      const requestId = `req-20261009T10${String(n).padStart(2, "0")}00Z`;
      roster.add(missionId, { requestId, workspaceId: "wks-a", topic: `topic ${n}`, workerId: `wkr-${n}` });
      roster.setState(missionId, requestId, n % 2 === 0 ? "finished" : "stopped");
      ids.push(requestId);
    }
    roster.add(missionId, { requestId: "req-20261009T110000Z", workspaceId: "wks-a", topic: "live one", workerId: "wkr-live" });
    return ids;
  }

  it("shows each active request in full and each settled one as a line, the newest MISSION_SETTLED_SHOWN with settledMore (delivery line design §18.3)", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const ids = rosterOf(mission.missionId, MISSION_SETTLED_SHOWN + 5);
    const read = await json("bm_mission", {}, who);
    const requests = read["requests"] as Array<Record<string, unknown>>;
    const lines = requests.filter((request) => request["state"] !== "active");
    expect(lines.map((line) => line["requestId"])).toEqual(ids.slice(-MISSION_SETTLED_SHOWN));
    expect(lines[0]).toEqual({ requestId: ids[5], repo: { workspaceId: "wks-a", folder: "/repo/api" }, topic: "topic 5", state: "stopped", workerId: "wkr-5" });
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(["repo", "requestId", "state", "topic", "workerId"]);
    expect(read["settledMore"]).toBe(5);
    expect(requests.filter((request) => request["state"] === "active")).toEqual([
      { requestId: "req-20261009T110000Z", repo: { workspaceId: "wks-a", folder: "/repo/api" }, topic: "live one", state: "active", workerId: "wkr-live", phase: null, report: null, openQuestions: [] },
    ]);
  });

  it("always shows a settled request with a question still open, with that question (review of ADR-037)", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const ids = rosterOf(mission.missionId, MISSION_SETTLED_SHOWN + 5);
    // The oldest settled request is past the newest 20, but its question is still open.
    createDecisionStore(home).open(makeDecision({ workspaceId: "wks-a", requestId: ids[1]! }));
    const read = await json("bm_mission", {}, who);
    const lines = (read["requests"] as Array<Record<string, unknown>>).filter((request) => request["state"] !== "active");
    const kept = lines.find((line) => line["requestId"] === ids[1])!;
    expect(kept["openQuestions"]).toEqual([expect.objectContaining({ id: `q:${ids[1]}:Q1` })]);
    expect(lines).toHaveLength(MISSION_SETTLED_SHOWN + 1);
    expect(read["settledMore"]).toBe(4);
  });

  it("has no settledMore when every settled request is shown", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    rosterOf(mission.missionId, MISSION_SETTLED_SHOWN);
    const read = await json("bm_mission", {}, who);
    expect((read["requests"] as unknown[]).length).toBe(MISSION_SETTLED_SHOWN + 1);
    expect(read).not.toHaveProperty("settledMore");
  });

  it("requestId adds that request in full, settled or not; an unknown one is refused", async () => {
    const { json, call } = await setup();
    const { mission, who } = missionOf();
    const ids = rosterOf(mission.missionId, MISSION_SETTLED_SHOWN + 5);
    const oldest = await json("bm_mission", { requestId: ids[0] }, who);
    expect(oldest["request"]).toEqual({ requestId: ids[0], repo: { workspaceId: "wks-a", folder: "/repo/api" }, topic: "topic 0", state: "finished", workerId: "wkr-0", phase: null, report: null, openQuestions: [] });
    expect(oldest["settledMore"]).toBe(5);
    expect((await json("bm_mission", { requestId: "req-20261009T110000Z" }, who))["request"]).toMatchObject({ state: "active", topic: "live one", openQuestions: [] });
    expect(await call("bm_mission", { requestId: "req-20991231T000000Z" }, who)).toEqual({
      ok: false,
      text: `Request req-20991231T000000Z is not one of mission WEB (bm_mission lists them). Nothing was read or changed.`,
    });
  });

  it("shows the newest MISSION_JOURNAL_SHOWN journal lines, and up to 50 when journal asks", async () => {
    const { json, call } = await setup();
    const { mission, who } = missionOf();
    const store = createMissionStore(home);
    for (let n = 0; n < 60; n += 1) store.appendJournal(mission.missionId, { kind: "note", by: "plugin", text: `line ${n}` });
    expect(MISSION_JOURNAL_SHOWN).toBe(20);
    const texts = async (input: Record<string, unknown>) => ((await json("bm_mission", input, who))["journal"] as Array<{ text: string }>).map((line) => line.text);
    expect(await texts({})).toEqual(Array.from({ length: 20 }, (_, n) => `line ${n + 40}`));
    expect(await texts({ journal: 50 })).toEqual(Array.from({ length: 50 }, (_, n) => `line ${n + 10}`));
    expect(await texts({ journal: 1 })).toEqual(["line 59"]);
    for (const journal of [0, 51, 2.5]) expect((await call("bm_mission", { journal }, who)).ok, String(journal)).toBe(false);
  });
});

describe("a done criterion's metAt (delivery line design §8.4)", () => {
  const T = (hour: number) => `2026-10-20T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const status = (state: "open" | "met", evidence: string | null = null): FreeMissionUpdate => ({ newCriteria: [], statuses: [{ id: "D1", status: state, evidence }], newContracts: [], versions: [], addRepos: [] });

  it("is set only when the criterion becomes met with evidence; back to open, a status sent again, or the owner's drop keeps it", () => {
    let { mission } = missionOf();
    mission = applyFreeUpdate(mission, { newCriteria: ["Invoices list"], statuses: [], newContracts: [], versions: [], addRepos: [] }, T(1));
    expect(mission.charter.doneCriteria[0]).not.toHaveProperty("metAt");
    mission = applyFreeUpdate(mission, status("met", "req-20261020T020000Z"), T(2));
    expect(mission.charter.doneCriteria[0]).toMatchObject({ status: "met", at: T(2), metAt: T(2) });
    // Sent again with new evidence: `at` moves, `metAt` stays.
    mission = applyFreeUpdate(mission, status("met", "req-20261020T030000Z"), T(3));
    expect(mission.charter.doneCriteria[0]).toMatchObject({ status: "met", at: T(3), evidence: "req-20261020T030000Z", metAt: T(2) });
    // Back to open: the reset point stays where it was.
    mission = applyFreeUpdate(mission, status("open"), T(4));
    expect(mission.charter.doneCriteria[0]).toMatchObject({ status: "open", at: T(4), metAt: T(2) });
    // Met again: a new reset point.
    mission = applyFreeUpdate(mission, status("met", "req-20261020T050000Z"), T(5));
    expect(mission.charter.doneCriteria[0]).toMatchObject({ metAt: T(5) });
    // The owner's drop keeps it too.
    const dropped = applyMissionChange(mission, { criteria: [{ id: "D1", status: "dropped" }] }, T(6));
    if ("reasons" in dropped) throw new Error(dropped.reasons.join("; "));
    expect(dropped.charter.doneCriteria[0]).toMatchObject({ status: "dropped", at: T(6), metAt: T(5) });
  });

  it("keeps an older met entry's reset point: its at becomes its metAt when the status is sent again", () => {
    const { mission } = missionOf();
    const older = { ...mission, charter: { ...mission.charter, doneCriteria: [{ id: "D1", text: "Invoices list", status: "met" as const, at: T(2), evidence: "req-20261020T020000Z" }] } };
    expect(applyFreeUpdate(older, status("met", "again"), T(7)).charter.doneCriteria[0]).toMatchObject({ at: T(7), metAt: T(2) });
    expect(applyFreeUpdate(older, status("open"), T(7)).charter.doneCriteria[0]).toMatchObject({ status: "open", at: T(7), metAt: T(2) });
  });
});

describe("bm_mission_update (§4, §4.1)", () => {
  it("writes the free changes and journals them at once", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const answer = await json(
      "bm_mission_update",
      {
        plan: ["API", "Web"],
        doneCriteria: [{ text: "Invoices list" }, { text: "Invoices PDF" }],
        contracts: [{ title: "Invoice API", providerRepo: "/repo/api", consumerRepos: ["wks-b"], text: "GET /invoices", source: "PRD §3" }],
      },
      who,
    );
    expect(answer["decisionId"]).toBeNull();
    let stored = createMissionStore(home).get(mission.missionId)!;
    expect(stored.plan.text).toBe("1. API\n2. Web");
    expect(stored.charter.doneCriteria.map((criterion) => [criterion.id, criterion.text, criterion.status])).toEqual([
      ["D1", "Invoices list", "open"],
      ["D2", "Invoices PDF", "open"],
    ]);
    expect(stored.contracts).toEqual([expect.objectContaining({ id: "C1", providerRepo: "wks-a", consumerRepos: ["wks-b"], version: 1 })]);

    await json("bm_mission_update", { doneCriteria: [{ id: "D1", status: "met", evidence: "req-20261009T100000Z" }], contracts: [{ id: "C1", text: "GET /invoices?page", source: "review" }] }, who);
    stored = createMissionStore(home).get(mission.missionId)!;
    expect(stored.charter.doneCriteria[0]).toMatchObject({ status: "met", evidence: "req-20261009T100000Z", metAt: NOW.toISOString() });
    expect(stored.contracts[0]).toMatchObject({ text: "GET /invoices?page", version: 2 });
    expect(createMissionStore(home).journal(mission.missionId).map((line) => line.kind)).toEqual(["plan", "criterion", "contract", "criterion", "contract"]);
    expect(createMissionDecisionStore(home).list(mission.missionId)).toEqual([]);
  });

  it("a plan is a list of one-line steps (ADR-045 decision 8): anything else is refused with how to fix it, and nothing is written", async () => {
    const { call } = await setup();
    const { mission, who } = missionOf();
    const fix = "input.plan: give a list of 1 to 30 steps, one line of at most 200 characters each; a fact goes to bm_memory or a contract";
    for (const [plan, line] of [
      ["1. API\n2. Web", "input.plan: must be an array"],
      [["x".repeat(201)], "input.plan[0]: must be at most 200 characters"],
      [["API", "Web\nand a fact"], "input.plan[1]: must match"],
      [Array.from({ length: 31 }, (_, index) => `step ${index}`), "input.plan: takes at most 30 items"],
      [[], "input.plan: needs at least 1 item(s)"],
    ] as const) {
      const answer = await call("bm_mission_update", { plan }, who);
      expect(answer.ok).toBe(false);
      expect(answer.text).toContain(line);
      expect(answer.text).toContain(fix);
    }
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("");
    expect(createMissionStore(home).journal(mission.missionId)).toEqual([]);
    expect((await call("bm_mission_update", { goal: "x".repeat(4_001) }, who)).text).not.toContain(fix);
  });

  it("the same steps again change nothing; 30 steps of 200 characters are accepted", async () => {
    const { call, json } = await setup();
    const { mission, who } = missionOf();
    await json("bm_mission_update", { plan: ["API", "Web"] }, who);
    expect((await call("bm_mission_update", { plan: ["API", "Web"] }, who)).text).toContain("Nothing to change");
    await json("bm_mission_update", { plan: Array.from({ length: 30 }, () => "x".repeat(200)) }, who);
    const lines = createMissionStore(home).get(mission.missionId)!.plan.text.split("\n");
    expect(lines).toHaveLength(30);
    expect(lines[29]).toBe(`30. ${"x".repeat(200)}`);
  });

  it("bm_mission flags a stored plan from before the rule, and only that one (ADR-045 decision 8)", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const storedPlan = (text: string) => createMissionStore(home).update(mission.missionId, (current) => ({ ...current, plan: { text, updatedAt: NOW.toISOString() } }));
    expect(await json("bm_mission", {}, who)).not.toHaveProperty("planNote");
    storedPlan("BM cannot create the BE Worker.\n1. API");
    expect(await json("bm_mission", {}, who)).toMatchObject({
      plan: { text: "BM cannot create the BE Worker.\n1. API" },
      planNote: "written before plans held only steps; it may be stale: check before relying on it",
    });
    storedPlan("1. API\n2. Web");
    expect(await json("bm_mission", {}, who)).not.toHaveProperty("planNote");
    await json("bm_mission_update", { plan: ["API", "Web", "Docs"] }, who);
    expect(await json("bm_mission", {}, who)).not.toHaveProperty("planNote");
  });

  it("contract status (delivery line design §9.2): a new contract and a new version are proposed unless stated agreed; a status alone keeps the version; an older contract reads agreed", async () => {
    const { json, call } = await setup();
    const { mission, who } = missionOf();
    const contract = { title: "Invoice API", providerRepo: "/repo/api", consumerRepos: ["wks-b"], text: "GET /invoices", source: "PRD §3" };
    await json("bm_mission_update", { contracts: [contract, { ...contract, title: "Export", status: "agreed" }] }, who);
    const read = () => createMissionStore(home).get(mission.missionId)!.contracts;
    expect(read().map((entry) => [entry.id, entry.version, entry.status])).toEqual([
      ["C1", 1, "proposed"],
      ["C2", 1, "agreed"],
    ]);
    await json("bm_mission_update", { contracts: [{ id: "C2", text: "GET /export?csv", source: "review" }] }, who);
    expect(read()[1]).toMatchObject({ version: 2, status: "proposed" });
    await json("bm_mission_update", { contracts: [{ id: "C1", status: "withdrawn" }] }, who);
    expect(read()[0]).toMatchObject({ version: 1, status: "withdrawn", text: "GET /invoices" });
    expect(createMissionStore(home).journal(mission.missionId, 50, "contract").map((line) => line.text)).toEqual([
      "The Main added the contracts C1, C2.",
      "The Main wrote a new version of C2 (source: review).",
      "The Main marked C1 withdrawn.",
    ]);
    expect((await call("bm_mission_update", { contracts: [{ id: "C1", text: "x" }] }, who)).text).toContain("input.contracts[0]: give a new version (text and source) or only its status");
    expect((await call("bm_mission_update", { contracts: [{ title: "x", providerRepo: "/repo/api" }] }, who)).text).toContain("input.contracts[0]: a new contract needs its title, providerRepo, text and source");
    // An older contract, written before the status, reads agreed; bm_mission shows it so.
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, contracts: current.contracts.map((entry, index) => (index === 0 ? { ...entry, status: undefined } : entry)) }));
    expect(read()[0]!.status).toBeUndefined();
    expect(contractStatusOf(read()[0]!)).toBe("agreed");
    const shown = (await json("bm_mission", {}, who))["contracts"] as Array<Record<string, unknown>>;
    expect(shown.map((entry) => entry["status"])).toEqual(["agreed", "proposed"]);
  });

  it("adds a repo at once only when scope-repo is delegated", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    expect((await json("bm_mission_update", { repos: { add: ["wks-b"] } }, who))["decisionId"]).toMatch(MISSION_DECISION_ID_PATTERN);
    expect(createMissionStore(home).get(mission.missionId)!.charter.repos).toEqual(["wks-a"]);
    createMissionAutonomyStore(home).setCell(mission.missionId, "scope-repo", "delegate");
    expect((await json("bm_mission_update", { repos: { add: ["/repo/web"] } }, who))["decisionId"]).toBeNull();
    expect(createMissionStore(home).get(mission.missionId)!.charter.repos).toEqual(["wks-a", "wks-b"]);
  });

  /** ADR-047: a charter that names a repo by a live id and by its key loses both when the repo is removed. */
  it("removes a repo under every id the charter names it by, whichever id is given", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf({ repos: ["wks-a", "wks-old", "wks-b"] });
    createMissionStore(home).update(mission.missionId, (current) => ({ ...current, repoAliases: { "wks-a": "wks-old" } }));
    for (const given of ["wks-a", "wks-old"]) {
      const answer = await json("bm_mission_update", { repos: { remove: [given] } }, who);
      const card = createMissionDecisionStore(home).get(answer["decisionId"] as string)!;
      expect(card.options.find((option) => option.key === "apply")!.action).toMatchObject({ kind: "mission-change", change: { removeRepos: ["wks-a", "wks-old"] } });
    }
  });

  it("refuses what cannot be: a taken code, an unknown repo or criterion, a met criterion without evidence, nothing to change", async () => {
    const { call } = await setup();
    createMissionStore(home).create({ code: "API", name: "Api", goal: "", repos: [], createdBy: "owner" });
    const { who } = missionOf();
    const refused = await call("bm_mission_update", { code: "API", repos: { add: ["wks-nope"], remove: ["wks-b"] }, doneCriteria: [{ id: "D9", status: "met" }] }, who);
    expect(refused.ok).toBe(false);
    for (const line of [
      "input.code: API is taken by the open mission Api",
      "input.repos.add: wks-nope is not a workspace Paseo lists",
      "input.repos.remove[0]: wks-b is not a repo of mission WEB",
      "input.doneCriteria[0].id: no criterion D9",
    ]) {
      expect(refused.text).toContain(line);
    }
    expect((await call("bm_mission_update", { name: "Website" }, who)).text).toContain("Nothing to change");
    expect((await call("bm_mission_update", { plan: ["x"] }, caller({ agentId: "other" }))).text).toBe(NOT_A_MAIN_MESSAGE);
  });

  it("opens one m: card for the sensitive parts, which only the owner's tap applies", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    await json("bm_mission_update", { doneCriteria: [{ text: "Invoices list" }] }, who);
    const answer = await json("bm_mission_update", { name: "Website v2", goal: "Ship v2 and v3", plan: ["new plan"], doneCriteria: [{ id: "D1", status: "dropped" }], confirmCharter: true }, who);
    const id = answer["decisionId"] as string;
    expect(id).toBe(`m:${mission.missionId}:1`);
    // The free part is written; the rest waits for the owner.
    let stored = createMissionStore(home).get(mission.missionId)!;
    expect(stored.plan.text).toBe("1. new plan");
    expect(stored.name).toBe("Website");
    expect(stored.charter.doneCriteria[0]!.status).toBe("open");

    const card = createMissionDecisionStore(home).get(id)!;
    expect(card).toMatchObject({ workspaceId: mission.missionId, requestId: null, askedBy: { role: "plugin", agentId: MAIN }, status: "open" });
    expect(card.options.map((option) => [option.key, option.action?.kind ?? null])).toEqual([
      ["apply", "mission-change"],
      ["keep", null],
    ]);
    expect(card.question).toContain('rename it "Website v2"');
    expect(card.question).toContain("drop D1");

    // No agent answers it: the per-workspace paths never see an m: id, and only the owner may answer one that carries a change.
    expect(DECISION_ID_PATTERN.test(id)).toBe(false);
    expect(createDecisionStore(home).get(id)).toBeNull();
    expect(answerDecision(card, { by: "policy", via: "inbox", optionKey: "apply", at: NOW.toISOString() }).ok).toBe(false);
    expect(answerDecision(card, { by: "precedent", precedentId: "p1", via: "inbox", optionKey: "apply", at: NOW.toISOString() }).ok).toBe(false);

    // The Inbox lists it, and the contract takes it.
    const listed = handleDecisionsList({ scope: "inbox" }, { home });
    expect(listed.decisions.map((decision) => decision.id)).toEqual([id]);
    expect(decisionsListRpc.output.parse(listed).decisions[0]!.id).toBe(id);
    expect(handleDecisionsGet({ id }, { home }).decision.id).toBe(id);

    // The owner taps apply.
    const { cli, calls } = fakeCli();
    const answered = await handleDecisionsAnswer({ id, optionKey: "apply" }, fake.paseo, { home, now: () => NOW, cli, log: (line) => logs.push(line) });
    expect(answered.decision).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "apply" } });
    stored = createMissionStore(home).get(mission.missionId)!;
    expect(stored.name).toBe("Website v2");
    expect(stored.charter.goal).toBe("Ship v2 and v3");
    expect(stored.charter.doneCriteria[0]!.status).toBe("dropped");
    expect(stored.charter.confirmedAt).toBe(NOW.toISOString());
    expect(calls).toEqual([["agent", "update", MAIN, "--name", "🟣 M · WEB Website v2", "--json"]]);
    expect(createMissionStore(home).journal(mission.missionId).at(-1)).toMatchObject({ kind: "charter", by: "owner", ref: id });
    expect(handleDecisionsList({ scope: "inbox" }, { home }).decisions).toEqual([]);
  });

  it("keeps the mission as it is on 'keep as is'", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    const id = (await json("bm_mission_update", { goal: "Something else" }, who))["decisionId"] as string;
    await handleDecisionsAnswer({ id, optionKey: "keep" }, fake.paseo, { home, now: () => NOW, cli: fakeCli().cli });
    expect(createMissionStore(home).get(mission.missionId)!.charter.goal).toBe("Ship v2");
    expect(createMissionStore(home).journal(mission.missionId).at(-1)).toMatchObject({ kind: "decision", by: "owner", text: `The owner kept the mission as it is (${id}).` });
  });

  it("a journal line that cannot be written fails nothing: the change stands, the card opens, the owner's answer reaches the Main", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    mkdirSync(join(home, "missions", `${mission.missionId}.journal.jsonl`));
    expect(await json("bm_mission_update", { plan: ["API"] }, who)).toMatchObject({ applied: ["The Main rewrote the plan."], decisionId: null });
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("1. API");
    const id = (await json("bm_mission_update", { goal: "Something else" }, who))["decisionId"] as string;
    expect(id).toMatch(MISSION_DECISION_ID_PATTERN);
    await handleDecisionsAnswer({ id, optionKey: "keep" }, fake.paseo, { home, now: () => NOW, cli: fakeCli().cli, log: (line) => logs.push(line) });
    expect(createOutbox(home).list("wks-own")).toEqual([expect.objectContaining({ kind: "message", requestId: id, to: MAIN })]);
    expect(logs.filter((line) => line.includes(`the journal of mission ${mission.missionId} could not record`))).toHaveLength(3);
  });

  it("transfer opens its own owner card to move requests to another open mission; an unknown code or a request off the roster is refused (mission runtime design §5.3)", async () => {
    const { call, json } = await setup();
    const { mission, who } = missionOf();
    const other = createMissionStore(home, { now: () => NOW }).create({ code: "BILL", name: "Billing", goal: "Invoices", repos: ["wks-a"], createdBy: "owner", mainId: "main-bill" });
    if (!other.ok) throw new Error(other.reasons.join("; "));
    createMissionRoster(home).add(mission.missionId, { requestId: "req-20261009T100000Z", workspaceId: "wks-a", topic: "invoice API", workerId: "wkr-1" });
    const unknown = await call("bm_mission_update", { transfer: { to: "NOPE", requestIds: ["req-20261009T100000Z"], reason: "r" } }, who);
    expect(unknown.text).toContain("input.transfer.to: no open mission has the code NOPE");
    const off = await call("bm_mission_update", { transfer: { to: "BILL", requestIds: ["req-20261009T110000Z"], reason: "r" } }, who);
    expect(off.text).toContain("input.transfer: not on mission WEB's roster: req-20261009T110000Z");
    const asked = await json("bm_mission_update", { transfer: { to: "BILL", requestIds: ["req-20261009T100000Z"], reason: "Billing owns invoices" } }, who);
    expect(asked).toMatchObject({ applied: [], decisionId: null, transferDecisionId: `m:${mission.missionId}:1` });
    expect(createMissionDecisionStore(home).get(`m:${mission.missionId}:1`)!.options[0]!.action).toEqual({
      kind: "mission-transfer",
      missionId: mission.missionId,
      to: other.mission.missionId,
      requestIds: ["req-20261009T100000Z"],
      reason: "Billing owns invoices",
    });
    // Nothing moved until the owner taps it.
    expect(createMissionRoster(home).list(mission.missionId).map((entry) => entry.requestId)).toEqual(["req-20261009T100000Z"]);
  });

  it("refuses close while a Worker of the mission runs a turn, at the call and at the owner's tap; an idle one does not hold it (mission runtime design §5.4)", async () => {
    const worker: FakeAgent = { id: "wkr-1", provider: "bm-worker", workspaceId: "wks-a", status: "running", labels: { "bm.role": "worker" } };
    const { call, json, fake } = await setup([worker]);
    const { mission, who } = missionOf();
    // No Worker runs yet: the card opens.
    const id = (await json("bm_mission_update", { close: true }, who))["decisionId"] as string;
    // A Worker starts before the owner taps apply.
    createMissionRoster(home).add(mission.missionId, { requestId: "req-20261009T100000Z", workspaceId: "wks-a", topic: "invoice API", workerId: "wkr-1" });
    expect((await call("bm_mission_update", { close: true }, who)).text).toContain("input.close: a Worker of mission WEB still runs (req-20261009T100000Z)");
    await expect(handleDecisionsAnswer({ id, optionKey: "apply" }, fake.paseo, { home, now: () => NOW, cli: fakeCli().cli })).rejects.toMatchObject({ code: "E_MISSION_INVALID" });
    expect(createMissionDecisionStore(home).get(id)!.status).toBe("open");
    expect(createMissionStore(home).get(mission.missionId)!.state).toBe("open");
    // Its Worker ended its turn, the request still active: the tap closes the mission, and the request is stopped.
    fake.byId("wkr-1")!.status = "idle";
    await handleDecisionsAnswer({ id, optionKey: "apply" }, fake.paseo, { home, now: () => NOW, cli: fakeCli().cli });
    expect(createMissionStore(home).get(mission.missionId)).toMatchObject({ state: "closed", closedAt: NOW.toISOString() });
    expect(createMissionRoster(home).get(mission.missionId, "req-20261009T100000Z")?.state).toBe("stopped");
  });
});

describe("bm_mission_update steps: a step list approved on one owner card (ADR-045 decision 1)", () => {
  const STEPS = [
    { title: "Build the API", request: "Add the orders endpoint.", acceptance: ["GET /orders answers 200", "It is documented"] },
    { title: "Wire the screens", request: "Show the orders.", acceptance: ["The page lists them"] },
  ];
  const proposal = async (json: Awaited<ReturnType<typeof setup>>["json"], who: ToolCaller) => (await json("bm_mission_update", { steps: STEPS }, who))["decisionId"] as string;
  const answerAs = (fake: ReturnType<typeof daemon>, id: string, optionKey: string) => handleDecisionsAnswer({ id, optionKey }, fake.paseo, { home, now: () => NOW, cli: fakeCli().cli, log: (line) => logs.push(line) });

  it("stores proposed entries, opens one card listing the titles within 1,000 characters, and starts nothing", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    const id = await proposal(json, who);
    expect(id).toMatch(MISSION_DECISION_ID_PATTERN);
    const entries = heldRequestsOf(home, mission.missionId);
    expect(entries.map((entry) => entry.state)).toEqual(["proposed", "proposed"]);
    expect(entries[0]!.after).toEqual([]);
    expect(entries[1]!.after).toEqual([entries[0]!.holdId]);
    const decisions = createMissionDecisionStore(home).list(mission.missionId, ["open"]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.question).toContain("1. Build the API");
    expect(decisions[0]!.question).toContain("2. Wire the screens");
    expect(decisions[0]!.options.map((option) => option.key)).toEqual(["apply", "keep"]);
    expect(fake.creates).toEqual([]);
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("");
  });

  it("the card's question holds every title of the longest list within 1,000 characters", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const steps = Array.from({ length: 12 }, (_, index) => ({ title: `${index + 1} ${"t".repeat(66)}`, request: "r", acceptance: ["a"] }));
    await json("bm_mission_update", { steps }, who);
    const { question } = createMissionDecisionStore(home).list(mission.missionId, ["open"])[0]!;
    expect(question.length).toBeLessThanOrEqual(1_000);
    for (let n = 1; n <= 12; n += 1) expect(question).toContain(`- ${n}. ${n} t`);
  });

  it("the owner's apply moves all entries to held in order, each after the previous one, and writes the plan from the titles", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    await answerAs(fake, await proposal(json, who), "apply");
    const entries = heldRequestsOf(home, mission.missionId);
    expect(entries.map((entry) => [entry.state, entry.step?.n])).toEqual([["held", 1], ["held", 2]]);
    expect(entries[0]!.after).toEqual([]);
    expect(entries[1]!.after).toEqual([entries[0]!.holdId]);
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("1. Build the API\n2. Wire the screens");
    expect(fake.creates).toEqual([]);
  });

  it("keep as is cancels them and leaves the plan", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    await answerAs(fake, await proposal(json, who), "keep");
    expect(heldRequestsOf(home, mission.missionId).map((entry) => entry.state)).toEqual(["cancelled", "cancelled"]);
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("");
  });

  it("an answer that is not the owner's applies nothing and cancels nothing", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const id = await proposal(json, who);
    const card = createMissionDecisionStore(home).get(id)!;
    for (const by of ["main", "orchestrator", "policy", "precedent"] as const) {
      await applyMissionDecision({ ...card, status: "answered", answer: { via: "chat-main", optionKey: "apply", words: null, at: NOW.toISOString(), by } } as never, { home, now: NOW, log: (line) => logs.push(line), cli: fakeCli().cli });
      await applyMissionDecision({ ...card, status: "answered", answer: { via: "chat-main", optionKey: "keep", words: null, at: NOW.toISOString(), by } } as never, { home, now: NOW, log: (line) => logs.push(line), cli: fakeCli().cli });
    }
    expect(heldRequestsOf(home, mission.missionId).map((entry) => entry.state)).toEqual(["proposed", "proposed"]);
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("");
    // The store itself refuses any answerer but the owner on an m: card.
    for (const by of ["policy", "precedent"] as const) {
      expect(JSON.stringify(answerDecision(card, { via: "inbox", optionKey: "apply", words: null, at: NOW.toISOString(), by } as never))).toContain("only the owner answers it");
    }
    expect(JSON.stringify(answerDecision(card, { via: "main", optionKey: "apply", words: null, at: NOW.toISOString(), by: "main" } as never))).toContain("the mission's Main answers only those");
  });

  it("a malformed step is refused per field and stores nothing", async () => {
    const { call } = await setup();
    const { mission, who } = missionOf({ repos: ["wks-a", "wks-b"] });
    const good = { title: "A", request: "r", acceptance: ["a"], project: "wks-a" };
    const cases: Array<[unknown, string]> = [
      [[good], "input.steps: needs at least 2 item(s)"],
      [Array.from({ length: 13 }, () => good), "input.steps: takes at most 12 items"],
      [[{ ...good, title: "x".repeat(71) }, good], "input.steps[0].title: must be at most 70 characters"],
      [[good, { ...good, acceptance: [] }], "input.steps[1].acceptance: needs at least 1 item(s)"],
      [[good, { ...good, acceptance: Array.from({ length: 7 }, () => "a") }], "input.steps[1].acceptance: takes at most 6 items"],
      [[good, { ...good, acceptance: ["x".repeat(201)] }], "input.steps[1].acceptance[0]: must be at most 200 characters"],
      [[{ title: "A", acceptance: ["a"], project: "wks-a" }, good], "input.steps[0].request: is required"],
      [[good, { ...good, context: Array.from({ length: 17 }, () => ({ fact: "f", source: "s" })) }], "input.steps[1].context: takes at most 16 items"],
      [[good, { ...good, project: undefined }], "input.steps[1].project: mission WEB works in 2 repos; name the one this step works in"],
      [[good, { ...good, project: "wks-gone" }], "input.steps[1].project: wks-gone is not a repo of mission WEB"],
    ];
    for (const [steps, line] of cases) {
      const answer = await call("bm_mission_update", { steps }, who);
      expect(answer.ok, line).toBe(false);
      expect(answer.text).toContain(line);
    }
    expect(heldRequestsOf(home, mission.missionId)).toEqual([]);
    expect(createMissionDecisionStore(home).list(mission.missionId, ["open"])).toEqual([]);
  });

  it("plan is refused while a line is live, and so is another list; bm_mission lists the steps", async () => {
    const { json, call, fake } = await setup();
    const { mission, who } = missionOf();
    await answerAs(fake, await proposal(json, who), "apply");
    const planned = await call("bm_mission_update", { plan: ["Other"] }, who);
    expect(planned.ok).toBe(false);
    expect(planned.text).toContain("input.plan:");
    expect(planned.text).toContain("is live");
    const again = await call("bm_mission_update", { steps: STEPS }, who);
    expect(again.ok).toBe(false);
    expect(again.text).toContain("input.steps:");
    expect(again.text).toContain("is still live");
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("1. Build the API\n2. Wire the screens");
    const read = await json("bm_mission", {}, who);
    expect(read["line"]).toEqual([
      { n: 1, of: 2, title: "Build the API", state: "held", holdId: expect.stringMatching(/^hold-/) },
      { n: 2, of: 2, title: "Wire the screens", state: "held", holdId: expect.stringMatching(/^hold-/) },
    ]);
  });

  it("steps and plan in one call are refused, storing nothing: the owner's apply writes the plan", async () => {
    const { call } = await setup();
    const { mission, who } = missionOf();
    const both = await call("bm_mission_update", { plan: ["x"], steps: STEPS }, who);
    expect(both.ok).toBe(false);
    expect(both.text).toContain("input.plan: give steps or a plan, not both");
    expect(heldRequestsOf(home, mission.missionId)).toEqual([]);
    expect(createMissionStore(home).get(mission.missionId)!.plan.text).toBe("");
  });
});

describe("a done criterion and a request that could not run (ADR-045 decision 6)", () => {
  const FLAGGED = "req-20261009T100000Z";
  const PROVED = "req-20261009T110000Z";
  const met = (evidence: string) => ({ doneCriteria: [{ id: "D1", status: "met", evidence }] });

  async function withCriterion(proofs: Array<[string, "ran" | "could-not-run"]>) {
    const { call, json } = await setup();
    const { mission, who } = missionOf();
    await json("bm_mission_update", { doneCriteria: [{ text: "Invoices list" }] }, who);
    const registry = createRequestRegistry(home);
    for (const [requestId, kind] of proofs) {
      createMissionRoster(home).add(mission.missionId, { requestId, workspaceId: "wks-a", topic: "Invoices", workerId: "w-1" });
      registry.register("wks-a", requestId, { source: "tool", managerId: MAIN });
      registry.noteProof("wks-a", requestId, { kind, what: "the page", at: NOW.toISOString() });
    }
    const status = () => createMissionStore(home).get(mission.missionId)!.charter.doneCriteria[0]!.status;
    return { call, json, who, status };
  }

  it("with a flagged request: met with no request id or naming it is refused, and naming a proved request is accepted", async () => {
    const { call, json, who, status } = await withCriterion([[FLAGGED, "could-not-run"], [PROVED, "ran"]]);
    const none = await call("bm_mission_update", met("It works on staging."), who);
    expect(none.ok).toBe(false);
    expect(none.text).toContain(`input.doneCriteria[0].evidence: this mission has a request that could not be run (${FLAGGED}): name the request id that proves this criterion`);
    const named = await call("bm_mission_update", met(`Shown by ${FLAGGED} and ${PROVED}.`), who);
    expect(named.ok).toBe(false);
    expect(named.text).toContain(`input.doneCriteria[0].evidence: ${FLAGGED} could not be run, so it meets no criterion: name a request that did run it`);
    expect(status()).toBe("open");
    await json("bm_mission_update", met(`Shown by ${PROVED}.`), who);
    expect(status()).toBe("met");
  });

  it("only met is held to it", async () => {
    const flagged = await withCriterion([[FLAGGED, "could-not-run"]]);
    await flagged.json("bm_mission_update", { doneCriteria: [{ id: "D1", text: "Invoices list v2" }] }, flagged.who);
    expect(flagged.status()).toBe("open");
  });

  it("a mission whose requests all ran still takes evidence without an id", async () => {
    const { json, who, status } = await withCriterion([[PROVED, "ran"]]);
    await json("bm_mission_update", met("It works on staging."), who);
    expect(status()).toBe("met");
  });
});
