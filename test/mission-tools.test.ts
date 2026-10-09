import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBindingCache, createBindingStore, type ToolCaller } from "../plugin/server/agent-bindings";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { materialiseTurn } from "../plugin/server/decision-materialiser";
import { handleDecisionsAnswer, handleDecisionsGet, handleDecisionsList } from "../plugin/server/decision-rpc";
import { createDecisionStore } from "../plugin/server/decision-store";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { MISSION_DECISION_ID_PATTERN, createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { MISSION_NOT_BOUND_MESSAGE, NOT_A_MAIN_MESSAGE, createMissionTools } from "../plugin/server/mission-tools";
import { ensureMissionsHome, missionsHomeDirOf, type MissionsPaseo } from "../plugin/server/missions-home";
import type { PaseoCliDeps } from "../plugin/server/paseo-cli";
import { clearProposedMissionStarts, proposedMissionStartOf } from "../plugin/server/proposed-mission-starts";
import { decisionsListRpc } from "../plugin/shared/contracts";
import { DECISION_ID_PATTERN, answerDecision } from "../plugin/shared/decisions";
import { at, msg, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

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

function fakeCli() {
  const calls: string[][] = [];
  const cli: PaseoCliDeps = { find: () => "/bin/paseo", run: async (_file, args) => (calls.push(args), { code: 0, output: "", timedOut: false }) };
  return { cli, calls };
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
  });
});

describe("bm_mission_update (§4, §4.1)", () => {
  it("writes the free changes and journals them at once", async () => {
    const { json } = await setup();
    const { mission, who } = missionOf();
    const answer = await json(
      "bm_mission_update",
      {
        plan: "1. API\n2. Web",
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
    expect(stored.charter.doneCriteria[0]).toMatchObject({ status: "met", evidence: "req-20261009T100000Z" });
    expect(stored.contracts[0]).toMatchObject({ text: "GET /invoices?page", version: 2 });
    expect(createMissionStore(home).journal(mission.missionId).map((line) => line.kind)).toEqual(["plan", "criterion", "contract", "criterion", "contract"]);
    expect(createMissionDecisionStore(home).list(mission.missionId)).toEqual([]);
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
    expect((await call("bm_mission_update", { plan: "x" }, caller({ agentId: "other" }))).text).toBe(NOT_A_MAIN_MESSAGE);
  });

  it("opens one m: card for the sensitive parts, which only the owner's tap applies", async () => {
    const { json, fake } = await setup();
    const { mission, who } = missionOf();
    await json("bm_mission_update", { doneCriteria: [{ text: "Invoices list" }] }, who);
    const answer = await json("bm_mission_update", { name: "Website v2", goal: "Ship v2 and v3", plan: "new plan", doneCriteria: [{ id: "D1", status: "dropped" }], confirmCharter: true }, who);
    const id = answer["decisionId"] as string;
    expect(id).toBe(`m:${mission.missionId}:1`);
    // The free part is written; the rest waits for the owner.
    let stored = createMissionStore(home).get(mission.missionId)!;
    expect(stored.plan.text).toBe("new plan");
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

  it("refuses close while a Worker of the mission runs, at the call and at the owner's tap", async () => {
    const worker: FakeAgent = { id: "wkr-1", provider: "bm-worker", workspaceId: "wks-a", labels: { "bm.role": "worker" } };
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
    // Its request finished: the tap closes the mission.
    createMissionRoster(home).setState(mission.missionId, "req-20261009T100000Z", "finished");
    await handleDecisionsAnswer({ id, optionKey: "apply" }, fake.paseo, { home, now: () => NOW, cli: fakeCli().cli });
    expect(createMissionStore(home).get(mission.missionId)).toMatchObject({ state: "closed", closedAt: NOW.toISOString() });
  });
});
