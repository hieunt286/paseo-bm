import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCaller } from "../plugin/server/agent-bindings";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { fallbackDecisionOf, createFallbackDecisionDelivery, syncFallbackDecisions } from "../plugin/server/fallback-decisions";
import { classifyTurn } from "../plugin/server/fallback-detect";
import { handleFallbackAct, registerFallbackRpcs } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_FILE } from "../plugin/server/fallback-settings";
import { readIncidents, recordIncident } from "../plugin/server/fallback-state";
import { createWorkerSwitch } from "../plugin/server/fallback-switch";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createMainFallbackRecovery, createMissionTools, tellMainOfQuestions } from "../plugin/server/mission-tools";
import { handleMissionGet } from "../plugin/server/missions-rpc";
import { bmDecide } from "../plugin/server/orchestrator-decide-tools";
import { createOutbox, mainTargetOf } from "../plugin/server/outbox";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { forgetModes } from "../plugin/server/role-mode";
import type { FallbackIncident } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

const MAIN = "main-1";
const OLD = "worker-1";
const NEW = "worker-2";
const WS = "wks_repo";
const HOME_WS = "wks_main";
const MISSION = "mis-0123456789";
const REQ = "req-20261026T144212Z";
const NOW = new Date("2026-10-26T14:42:20.000Z");
const LIMIT = "You've hit your weekly limit · resets Oct 28 at 10am (Asia/Saigon)";
const BRIEF = `BM-BRIEF worker requestId: ${REQ}\nThe owner's request: finish the remaining beads.`;
let root: string;
let home: string;
const log = vi.fn();
const now = () => NOW;
const caller = (over: Partial<ToolCaller> = {}): ToolCaller => ({ agentId: MAIN, role: "manager", workspaceId: HOME_WS, requestId: null, parentId: null, batchId: null, missionId: MISSION, ...over });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-main-fallback-"));
  home = join(root, "data");
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "missions-home.json"), JSON.stringify({ schemaVersion: 1, workspaceId: HOME_WS, directory: join(home, "missions", "home") }));
  writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy: "ask", entries: [{ baseProvider: "codex", model: "gpt-6.1-sol", thinkingOptionId: "medium", modeId: null }] } } }));
  const made = createMissionStore(home, { newId: () => MISSION, now, env: {} }).create({ code: "AIX", name: "AIX", goal: "Finish the beads", repos: [WS], mainId: MAIN, createdBy: "owner" });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  createMissionRoster(home).add(MISSION, { requestId: REQ, workspaceId: WS, topic: "Finish beads", workerId: OLD });
  createRequestRegistry(home, { backfill: () => [] }).register(WS, REQ, { source: "tool", managerId: MAIN, workerId: OLD });
  createAutonomyStore(home).set({ workspaceId: WS, class: "environment", mode: "delegate", confirmed: true }, NOW.toISOString());
  log.mockReset();
});

afterEach(() => {
  forgetModes();
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearJsonFileCache();
  rmSync(root, { recursive: true, force: true });
});

function daemon() {
  const fake = fakePaseo({
    agents: [
      { id: MAIN, provider: "bm-manager", status: "idle", workspaceId: HOME_WS },
      { id: OLD, provider: "bm-worker", model: "claude-opus-5-5", status: "idle", cwd: join(root, "repo"), workspaceId: WS, lastUsage: { outputTokens: 0 }, labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MAIN } },
    ],
    workspaces: [{ id: WS, directory: join(root, "repo") }, { id: HOME_WS, directory: join(home, "missions", "home") }],
    config: { providers: { "bm-worker": { extends: "claude" }, "bm-worker-fallback-1": { extends: "codex" } } },
    providers: { available: ["claude", "codex"], modes: { "bm-worker-fallback-1": [{ id: "full-access", label: "Full access", colorTier: "dangerous" }] } },
    created: () => ({ id: NEW }),
  });
  fake.setTimeline(OLD, [
    { id: "input", timestamp: NOW.toISOString(), item: { type: "tool_call", name: "agent_message", callId: "paseo-agent-message:original", agentMessage: { event: "message", text: BRIEF } } },
    { id: "answer", timestamp: NOW.toISOString(), item: { type: "assistant_message", text: LIMIT } },
  ]);
  return fake;
}

async function detect(fake: ReturnType<typeof daemon>): Promise<FallbackIncident> {
  const event = { agent: { id: OLD, provider: "bm-worker", workspaceId: WS }, outcome: { kind: "completed" }, timeline: [] };
  const signal = await classifyTurn(event as never, { paseo: fake.paseo as never, log });
  expect(signal).toMatchObject({ class: "L1", signal: "completed" });
  const incident = await recordIncident(event, signal!, { paseo: fake.paseo, home, log, now, randomHex: () => "0123456789ab" });
  expect(incident?.candidate).toMatchObject({ baseProvider: "codex", model: "gpt-6.1-sol" });
  return incident!;
}

const answer = (incident: FallbackIncident) => ({ decisionId: `f:${incident.id}`, option: "switch", why: "Continue the owner's request using its configured available fallback." });

describe("Main provider recovery (ADR-040)", () => {
  it("takes a completed quota reply through durable Main notice, Main answer and exactly one workspace replacement", async () => {
    const fake = daemon();
    const switching = createWorkerSwitch({ log, now, setLabels: async () => ({ ok: true }), stopReviewers: async () => [], location: async () => null });
    const remove = registerFallbackRpcs({ handle: vi.fn() } as never, { switch: switching }, {
      onDecisionsOpened: (opened, paseo) => tellMainOfQuestions(opened, { home, now: NOW, log, paseo }),
    });
    try {
      const incident = await detect(fake);
      const notices = createOutbox(home).list(HOME_WS);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ requestId: REQ, from: "plugin", to: MAIN });
      expect(notices[0]!.text).toContain(`f:${incident.id}`);
      expect(notices[0]!.text).toContain("bm_answer_fallback");
      expect(notices[0]!.text).toContain("do not ask the owner to confirm again");
      const page = await handleMissionGet({ missionId: MISSION }, fake.paseo as never, { home, now, log });
      expect(page.rows.find((row) => row.requestId === REQ)).toMatchObject({ phase: "blocked", ownerQuestions: [] });
      const settle = createFallbackDecisionDelivery((input, paseo) => handleFallbackAct(input, paseo, { home, actions: { switch: switching } }), { home: () => home });
      const tools = createMissionTools({ home: () => home, paseo: () => fake.paseo, now, log, onSettled: settle });
      const result = await tools.call("bm_answer_fallback", answer(incident), caller());
      expect(result.ok, result.text).toBe(true);
      expect(createDecisionStore(home).get(`f:${incident.id}`)).toMatchObject({ status: "answered", answer: { by: "main", via: "main", optionKey: "switch" }, grant: null, delivery: { outcome: "sent" } });
      expect(readIncidents(home).incidents[0]).toMatchObject({ status: "switched", replacementId: NEW });
      expect(fake.creates).toHaveLength(1);
      expect(fake.creates[0]).toMatchObject({ workspaceId: WS, options: { parent: MAIN, config: { provider: "bm-worker-fallback-1/gpt-6.1-sol" }, prompt: expect.stringContaining(BRIEF) } });
      expect(createMissionRoster(home).get(MISSION, REQ)?.workerIds).toEqual([OLD, NEW]);
      expect((await tools.call("bm_answer_fallback", answer(incident), caller())).ok).toBe(false);
      expect(fake.creates).toHaveLength(1);
    } finally {
      remove();
    }
  });

  it("recovers a pending decision after reload without duplicating its outbox notice, and retargets it to the new Main", async () => {
    const fake = daemon();
    const incident = await detect(fake);
    syncFallbackDecisions(home, { now, log });
    const deps = { home, now: NOW, log, paseo: fake.paseo };
    const recover = createMainFallbackRecovery();
    expect(await recover(deps)).toBe(1);
    expect(await recover(deps)).toBe(0);
    expect(await createMainFallbackRecovery()(deps)).toBe(0);
    expect(createOutbox(home).list(HOME_WS)).toHaveLength(1);
    createMissionStore(home).setMain(MISSION, "new-main", "handoff");
    expect(mainTargetOf(home, HOME_WS, createOutbox(home).list(HOME_WS)[0]!)).toMatchObject({ to: "new-main" });
    expect(createDecisionStore(home).get(`f:${incident.id}`)?.status).toBe("open");
  });

  it("reports a failed recovery as failed, rather than treating the stored Main answer as a replacement", async () => {
    const fake = daemon();
    const incident = await detect(fake);
    syncFallbackDecisions(home, { now, log });
    fake.api.workspaces.ref(WS).agents.create.mockRejectedValue(new Error("provider unavailable during creation"));
    const switching = createWorkerSwitch({ log, now, setLabels: async () => ({ ok: true }), stopReviewers: async () => [], location: async () => null });
    const settle = createFallbackDecisionDelivery((input, paseo) => handleFallbackAct(input, paseo, { home, actions: { switch: switching } }), { home: () => home });
    const tools = createMissionTools({ home: () => home, paseo: () => fake.paseo, now, log, onSettled: settle });
    const result = await tools.call("bm_answer_fallback", answer(incident), caller());
    expect(result.ok, result.text).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ delivery: { outcome: "failed" }, said: "The plugin could not run the option's action; the owner sees that in the Inbox." });
    expect(readIncidents(home).incidents[0]).toMatchObject({ status: "failed", replacementId: null });
    expect(createMissionRoster(home).get(MISSION, REQ)?.workerIds).toEqual([OLD]);
  });

  it("binds a pending incident's replacement and handover brief to the current Main after a handoff", async () => {
    const fake = daemon();
    const incident = await detect(fake);
    syncFallbackDecisions(home, { now, log });
    createMissionStore(home).setMain(MISSION, "new-main", "handoff");
    createRequestRegistry(home).reassignManager(WS, REQ, "new-main", MISSION);
    const switching = createWorkerSwitch({ log, now, setLabels: async () => ({ ok: true }), stopReviewers: async () => [], location: async () => null });
    const settle = createFallbackDecisionDelivery((input, paseo) => handleFallbackAct(input, paseo, { home, actions: { switch: switching } }), { home: () => home });
    const tools = createMissionTools({ home: () => home, paseo: () => fake.paseo, now, log, onSettled: settle });
    const result = await tools.call("bm_answer_fallback", answer(incident), caller({ agentId: "new-main" }));
    expect(result.ok, result.text).toBe(true);
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]).toMatchObject({ workspaceId: WS, options: { parent: "new-main", prompt: expect.stringContaining("managerAgentId: new-main") } });
    expect(createRequestRegistry(home).get(WS, REQ)?.managerId).toBe("new-main");
  });

  it("refuses an Orchestrator answer to an incident assigned to the Main before any delivery", async () => {
    const fake = daemon();
    const incident = await detect(fake);
    syncFallbackDecisions(home, { now, log });
    const decisionId = `f:${incident.id}`;
    // This refusal precedes reads of the remaining Orchestrator context or any provider call.
    await expect(bmDecide({ decisionId, optionKey: "switch", reason: "Use the configured fallback." }, { home, now: NOW, env: {} } as never, {})).rejects.toThrow("belongs to main");
    expect(createDecisionStore(home).get(decisionId)).toMatchObject({ status: "open", answer: null });
    expect(fake.creates).toHaveLength(0);
  });

  it.each(["other-mission", "outdated-main", "undelegated", "owner-only", "invalid-option", "no-incident"])("refuses %s before recording an answer or running settlement", async (scenario) => {
    const fake = daemon();
    const incident = await detect(fake);
    const decision = fallbackDecisionOf(incident, NOW);
    const store = createDecisionStore(home);
    store.open(scenario === "owner-only" ? { ...decision, ownerOnly: true } : decision);
    let who = caller();
    if (scenario === "other-mission") {
      const other = createMissionStore(home, { newId: () => "mis-9876543210", now }).create({ code: "OTHER", name: "Other", goal: "Other", repos: [WS], mainId: "other-main", createdBy: "owner" });
      if (!other.ok) throw new Error(other.reasons.join("; "));
      who = caller({ agentId: "other-main", missionId: other.mission.missionId });
    }
    if (scenario === "outdated-main") createMissionStore(home).setMain(MISSION, "new-main", "handoff");
    if (scenario === "undelegated") createAutonomyStore(home).set({ workspaceId: WS, class: "environment", mode: "owner" }, NOW.toISOString());
    if (scenario === "no-incident") writeFileSync(join(home, "role-fallback-state.json"), JSON.stringify({ version: 1, incidents: [] }));
    const settle = vi.fn();
    const tools = createMissionTools({ home: () => home, paseo: () => fake.paseo, now, log, onSettled: settle });
    const input = { ...answer(incident), ...(scenario === "invalid-option" ? { option: "wait" } : {}) };
    const result = await tools.call("bm_answer_fallback", input, who);
    expect(result.ok, result.text).toBe(false);
    expect(store.get(decision.id)).toMatchObject({ status: "open", answer: null, delivery: null });
    expect(settle).not.toHaveBeenCalled();
    expect(fake.creates).toHaveLength(0);
  });
});
