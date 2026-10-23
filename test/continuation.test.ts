import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearBindingCache, createBindingStore, type BindingStore, type ToolCaller } from "../plugin/server/agent-bindings";
import { binderOf } from "../plugin/server/agent-tools";
import { clearBeadsCache } from "../plugin/server/beads-store";
import { endedPhaseOf } from "../plugin/server/continuation";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createDeliveringTools } from "../plugin/server/deliver-tools";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOutbox } from "../plugin/server/outbox";
import { REQUEST_ID_PATTERN, clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { applyAgentTools, type AgentCreateRequest } from "../plugin/server/role-hook";
import { forgetModes } from "../plugin/server/role-mode";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { chainHeadOf } from "../plugin/server/waits";
import { report, turn } from "./fixtures/orchestrator-traces";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { MANAGER_CALLER } from "./helpers/bindings";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakeAgent, type FakeCreateRequest } from "./helpers/fake-paseo";

/**
 * Continuations (delivery line design §2.4, §2.5, §2.7): `bm_tell_worker` on a
 * finished or stopped bound request opens a new request linked both ways,
 * with a new Worker briefed from the stores; the staffing rule holds; a
 * refused creation keeps the new id with no Worker; the hand path and an
 * unfinished request are told as before. Temporary data folders and the one
 * fake daemon only.
 */

const WS = "wks_1";
const REQ = "req-20261003T100000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const T0 = new Date("2026-10-03T12:00:00.000Z");

afterEach(() => {
  clearBindingCache();
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearBeadsCache();
  clearJsonFileCache();
  forgetModes();
  removeDataFolders();
});

const worker = (id: string, requestId: string, workspaceId = WS, cwd?: string): FakeAgent => ({
  id,
  provider: "bm-worker/claude-opus-5",
  status: "idle",
  workspaceId,
  labels: { "bm.role": "worker", "bm.requestId": requestId, "paseo.parent-agent-id": MANAGER },
  ...(cwd === undefined ? {} : { cwd }),
});

function setup(options: { agents?: (repo: string) => FakeAgent[]; workspaces?: (repo: string) => Array<Record<string, unknown>>; refuse?: string } = {}) {
  const home = dataFolder();
  const repo = join(dirname(home), "repo");
  mkdirSync(join(repo, ".beads"), { recursive: true });
  const store: BindingStore = createBindingStore(home);
  const fake = fakePaseo({
    agents: [{ id: MANAGER, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: WS, cwd: repo, labels: { "bm.role": "manager" } }, ...(options.agents?.(repo) ?? [worker(WORKER, REQ, WS, repo)])],
    workspaces: options.workspaces?.(repo) ?? [{ id: WS, directory: repo }],
    config: {
      agentProfiles: [{ id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" }],
      providers: { "bm-worker": { extends: "claude" }, "bm-manager": { extends: "claude" } },
      mcp: { injectIntoAgents: true },
    },
    created: (request: FakeCreateRequest) => {
      if (options.refuse !== undefined) throw new Error(options.refuse);
      // The agent.create hook's part: it keeps the token URL, as the real hook does.
      applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, "claude");
      return {};
    },
  });
  const logs: string[] = [];
  let n = 0;
  const tools = createDeliveringTools({
    paseo: () => fake.paseo,
    home: () => home,
    log: (line) => logs.push(line),
    now: () => T0,
    queue: createNoticeQueue({ log: () => {} }),
    outbox: { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` },
    binder: () => binderOf(ROLE_URL, store, (line) => logs.push(line)),
  });
  const tell = (input: Record<string, unknown>, caller: ToolCaller = MANAGER_CALLER) => tools.manager.call("bm_tell_worker", input, caller);
  return { home, repo, fake, store, logs, tell };
}

/** The request as bm_create_worker registers it, then finished (or not) as bm_report notes it. */
function registerRequest(home: string, options: { workspaceId?: string; managerId?: string; finished?: boolean; source?: "tool" | "agent-typed" } = {}): void {
  const registry = createRequestRegistry(home, { backfill: () => [] });
  const workspaceId = options.workspaceId ?? WS;
  registry.register(workspaceId, REQ, { source: options.source ?? "tool", managerId: options.managerId ?? MANAGER, workerId: WORKER });
  if (options.finished !== false) registry.noteReport(workspaceId, REQ, { tier: "Medium", phase: "finished", at: "2026-10-03T11:00:00.000Z" });
}

const parsed = (answer: { ok: boolean; text: string }) => {
  expect(answer.ok, answer.text).toBe(true);
  return JSON.parse(answer.text) as Record<string, unknown>;
};

describe("bm_tell_worker on a finished bound request opens its continuation (delivery line design §2.4)", () => {
  it("a new request linked both ways, a new bound Worker in the same folder, and its brief block from the stores", async () => {
    const { home, repo, fake, store, tell } = setup();
    registerRequest(home);
    writeFileSync(
      join(repo, ".beads", "issues.jsonl"),
      [{ id: "bd-1", status: "closed", labels: ["feature:dates", "area:pdf"] }, { id: "bd-2", status: "open", labels: ["feature:dates"] }].map((row) => JSON.stringify(row)).join("\n"),
    );
    const last = report({
      requestId: REQ,
      phase: "finished",
      at: "2026-10-03T11:00:00.000Z",
      beadsClosed: ["bd-1"],
      beadsReady: ["bd-2"],
      buildAndTests: "npm test passed",
      decided: ["kept the old API — the owner uses it"],
      blockers: "none. Suggestion (not done): add a locale test; Suggestion (not done): drop the shim",
    });
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: REQ, at: "2026-10-03T11:00:00.000Z", endedAt: "2026-10-03T11:00:00.000Z", reports: [last] }));
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ}:Q2`, workspaceId: WS, requestId: REQ, question: "Which locale?" }));

    const answer = parsed(await tell({ requestId: REQ, text: "Also the CSV export.", source: "owner message, 12:00" }));
    const next = answer["requestId"] as string;
    expect(next).toMatch(REQUEST_ID_PATTERN);
    expect(answer).toEqual({ requestId: next, continuationOf: REQ, workerId: "created-1", delivery: "sent", opened: "follow-up" });

    // Linked both ways; the old request stays finished.
    const registry = createRequestRegistry(home);
    expect(registry.get(WS, REQ)).toMatchObject({ continuedBy: next, rollover: { reason: "follow-up", figure: "a follow-up after finished", at: T0.toISOString() } });
    expect(registry.get(WS, REQ)!.finishedAt).not.toBeNull();
    expect(registry.get(WS, next)).toMatchObject({ source: "tool", managerId: MANAGER, continuationOf: REQ, chainRootId: REQ, workerIds: ["created-1"], finishedAt: null });

    // Always a new Worker, bound to the new request, in the predecessor's folder; nothing sent to the old one.
    expect(fake.creates).toHaveLength(1);
    const { options } = fake.creates[0]!;
    expect(options).toMatchObject({ cwd: repo, parent: MANAGER, labels: { "bm.role": "worker", "bm.requestId": next } });
    expect(store.bindingOfAgent("created-1")).toMatchObject({ role: "worker", requestId: next });
    expect(fake.sends).toEqual([]);
    expect(createOutbox(home).list(WS)).toEqual([]);

    // The brief: the Main's words as the request, then the continuation block after the Manager's line.
    const lines = options.prompt!.split("\n");
    expect(lines.slice(0, 3)).toEqual([`BM-BRIEF worker requestId: ${next}`, "The owner's request, verbatim:", "> Also the CSV export."]);
    const from = lines.indexOf(`managerAgentId: ${MANAGER}`);
    expect(lines.slice(from + 1, lines.indexOf("Context:"))).toEqual([
      `continues: ${REQ} (follow-up: a follow-up after finished)`,
      `chain: root ${REQ}, request 2`,
      `${REQ} last reported: finished at 2026-10-03T11:00:00.000Z`,
      "tier: Medium",
      "beadsClosed: bd-1",
      "beadsReady: bd-2",
      "reviewFindingsOpen: none",
      "decided: kept the old API — the owner uses it",
      "suggestions: add a locale test, drop the shim",
      "buildAndTests: npm test passed",
      "features: feature:dates",
      "open questions of the chain (their answers come to you):",
      `- q:${REQ}:Q2: Which locale?`,
      "live links of the chain: none",
    ]);
    expect(lines.slice(lines.indexOf("Context:"))).toEqual(["Context:", "- the words above (source: owner message, 12:00)"]);

    // The chain's head is the new request; a second tell goes to its Worker, as today.
    expect(chainHeadOf(home, REQ)?.request.requestId).toBe(next);
    const again = parsed(await tell({ requestId: REQ, text: "And the totals." }));
    expect(again).toEqual({ requestId: next, workerId: "created-1", delivery: "sent" });
    expect(fake.creates).toHaveLength(1);
    expect(fake.sends.map((send) => send.id)).toEqual(["created-1"]);
    expect(fake.sends[0]!.text.split("\n").slice(1)).toEqual([`Continue ${next}.`, "And the totals."]);
  });

  it("an unfinished request, and a hand-path one that finished, are told as before", async () => {
    const { home, fake, tell } = setup();
    registerRequest(home, { finished: false });
    expect(parsed(await tell({ requestId: REQ, text: "Go on." }))).toEqual({ workerId: WORKER, delivery: "sent" });
    clearRequestRegistryCache();

    const hand = setup();
    registerRequest(hand.home, { source: "agent-typed" });
    expect(endedPhaseOf(hand.home, createRequestRegistry(hand.home).get(WS, REQ)!)).toBeNull();
    expect(parsed(await hand.tell({ requestId: REQ, text: "Go on." }))).toEqual({ workerId: WORKER, delivery: "sent" });
    expect([...fake.creates, ...hand.fake.creates]).toEqual([]);
  });

  it("a refused creation keeps the new id registered with no Worker; the old request is not marked continued", async () => {
    const { home, fake, tell } = setup({ refuse: "provider bm-worker is unavailable" });
    registerRequest(home);
    expect(await tell({ requestId: REQ, text: "More." })).toEqual({ ok: false, text: "Paseo refused to create the Worker: provider bm-worker is unavailable" });
    const requests = createRequestRegistry(home).list(WS);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ continuationOf: REQ, chainRootId: REQ, workerIds: [] });
    expect(requests[0]!.continuedBy).toBeUndefined();
    expect(fake.sends).toEqual([]);
  });
});

describe("a Main's continuation (delivery line design §2.4 item 4, missions design §4)", () => {
  const MAIN = "agent-main";
  const BACK = "wks_back";

  function missionSetup(extra: FakeAgent[] = []) {
    const env = setup({
      agents: (repo) => [{ id: MAIN, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: "wks_home", labels: { "bm.role": "manager" } }, worker(WORKER, REQ, BACK, repo), ...extra],
      workspaces: (repo) => [{ id: "wks_home", directory: "/work/home" }, { id: BACK, directory: repo }],
    });
    const created = createMissionStore(env.home).create({ code: "SHOP", name: "Shop revamp", goal: "Orders.", repos: [BACK], createdBy: "owner", mainId: MAIN });
    if (!created.ok) throw new Error(created.reasons.join("; "));
    const missionId = created.mission.missionId;
    createMissionAutonomyStore(env.home).setLevel(missionId, 1);
    registerRequest(env.home, { workspaceId: BACK, managerId: MAIN, finished: false });
    createMissionRoster(env.home).add(missionId, { requestId: REQ, workspaceId: BACK, topic: "Orders API", workerId: WORKER });
    const caller: ToolCaller = { agentId: MAIN, role: "manager", workspaceId: "wks_home", requestId: null, parentId: null, batchId: null, missionId };
    return { ...env, missionId, caller };
  }

  it("a stopped request opens one too: it stays stopped, the continuation joins the roster with the journal's line", async () => {
    const { home, fake, missionId, caller, tell } = missionSetup();
    createMissionRoster(home).setState(missionId, REQ, "stopped");
    const answer = parsed(await tell({ requestId: REQ, text: "Resume the orders API." }, caller));
    const next = answer["requestId"] as string;
    expect(answer).toMatchObject({ continuationOf: REQ, workerId: "created-1", opened: "follow-up" });
    expect(fake.creates[0]!.workspaceId).toBe(BACK);
    expect(createMissionRoster(home).get(missionId, REQ)?.state).toBe("stopped");
    expect(createMissionRoster(home).get(missionId, next)).toMatchObject({ continuationOf: REQ, state: "active", workerIds: ["created-1"] });
    expect(createRequestRegistry(home).get(BACK, REQ)).toMatchObject({ continuedBy: next, rollover: { figure: "a follow-up after stopped" } });
    expect(createMissionStore(home).journal(missionId).at(-1)).toMatchObject({ kind: "worker", by: MAIN, ref: next, text: `Worker created-1 for request ${next} in ${BACK} (continues ${REQ}): Resume the orders API.` });
    expect(fake.creates[0]!.options.prompt!.split("\n")).toContain("mission: SHOP Shop revamp");
  });

  it("the staffing rule holds: another live Worker in the repo refuses it, creating nothing", async () => {
    const OTHER = "req-20261003T110000Z";
    const { home, fake, missionId, caller, tell } = missionSetup([worker("agent-other", OTHER, BACK)]);
    createRequestRegistry(home, { backfill: () => [] }).register(BACK, OTHER, { source: "tool", managerId: MAIN, workerId: "agent-other" });
    createMissionRoster(home).add(missionId, { requestId: OTHER, workspaceId: BACK, topic: "Other", workerId: "agent-other" });
    createRequestRegistry(home).noteReport(BACK, REQ, { tier: "Small", phase: "finished", at: "2026-10-03T11:00:00.000Z" });
    createMissionRoster(home).setState(missionId, REQ, "finished");
    const answer = await tell({ requestId: REQ, text: "More." }, caller);
    expect(answer.ok).toBe(false);
    expect(answer.text).toBe(
      `mission SHOP already has a live Worker in repo (request ${OTHER}): give it the work with bm_tell_worker, or staffing is not delegated in this mission, so ask the owner first\nNothing was created.`,
    );
    expect(fake.creates).toEqual([]);
    expect(createRequestRegistry(home).list(BACK).map((request) => request.requestId)).toEqual([REQ, OTHER]);
  });
});
