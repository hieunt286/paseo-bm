import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthorityFacts } from "../plugin/shared/authority";
import { MISSION_STATE_MAX_CHARS, renderMissionState, requestStateOf } from "../plugin/shared/mission-state";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createGovernorStore } from "../plugin/server/governor-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { clearRequestIndexCache, createMissionRoster, noteFollowUp, noteRosterReport } from "../plugin/server/mission-roster";
import { missionStateOf, waitingOnOf } from "../plugin/server/mission-state";
import { createMissionStore } from "../plugin/server/mission-store";
import { createOutbox } from "../plugin/server/outbox";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import { clearTraceStoreCache, appendRecord } from "../plugin/server/trace-store";
import { makeDecision } from "./helpers/decisions";
import { turn } from "./fixtures/orchestrator-traces";

/**
 * The mission state (mission runtime design §2, ADR-033 decision 1,
 * REQ-202): what it reads, each request state, the rendering's bound, and
 * M-31 — after every event of a scripted mission, a successor's brief holds
 * every in-flight item. A temporary data folder — never the real HOME.
 */

const MISSION = "mis-0123456789";
const FRONT = "wks_front";
const BACK = "wks_back";
const HOME_WS = "wks_home";
const MAIN = "main-1";
const REQ_A = "req-20261010T033258Z";
const REQ_B = "req-20261010T033304Z";
const REQ_C = "req-20261010T034200Z";
const NOW = new Date("2026-10-10T05:00:00.000Z");
let root: string;
let home: string;

/** Every class delegated in the front repo, none in the back; the mission level delegates nothing; review caps of 2. */
const FACTS: AuthorityFacts = {
  modeOf: (workspaceId) => (workspaceId === FRONT ? "delegate" : "owner"),
  missionOf: (requestId) => (requestId === null ? null : MISSION),
  missionDelegates: () => false,
  reviewCaps: () => ({ codeLeft: 2, mainLeft: 2 }),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-state-"));
  home = join(root, "data");
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  const made = createMissionStore(home, { newId: () => MISSION, env: {}, now: () => NOW }).create({
    code: "XAI",
    name: "Xây dựng AI Assistant",
    goal: "Tích hợp với xOne",
    repos: [BACK, FRONT],
    createdBy: "owner",
    mainId: MAIN,
  });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "missions-home.json"), JSON.stringify({ schemaVersion: 1, workspaceId: HOME_WS, directory: join(home, "missions", "home") }));
});

afterEach(() => {
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const roster = () => createMissionRoster(home, { now: () => NOW });
const report = (workspaceId: string, requestId: string, worker: string, phase: string, extra: string[] = [], at = NOW) =>
  createOutbox(home, { now: () => at }).add(workspaceId, {
    kind: "report",
    requestId,
    from: worker,
    to: MAIN,
    text: ["BM-REPORT", `requestId: ${requestId}`, `phase: ${phase}`, `tier: Small (changed: no) — ${phase} work`, ...extra].join("\n"),
  });
const state = () => missionStateOf(home, MISSION, { now: () => NOW, env: {}, facts: FACTS })!;

describe("requestStateOf (design §2.1)", () => {
  const at = (minute: number) => new Date(NOW.getTime() + minute * 60_000).toISOString();
  it("reads the first rule that holds", () => {
    expect(requestStateOf({ rosterState: "finished", lastReport: { phase: "finished", at: at(0) }, followUpAt: null, openDeciders: [], waitingOn: null })).toBe("finished");
    // The XAI miss: a follow-up after the finished report reopens it.
    expect(requestStateOf({ rosterState: "finished", lastReport: { phase: "finished", at: at(0) }, followUpAt: at(1), openDeciders: [], waitingOn: null })).toBe("working");
    expect(requestStateOf({ rosterState: "active", lastReport: { phase: "blocked", at: at(0) }, followUpAt: null, openDeciders: ["main", "owner"], waitingOn: null })).toBe("waiting-owner");
    expect(requestStateOf({ rosterState: "active", lastReport: { phase: "blocked", at: at(0) }, followUpAt: null, openDeciders: ["main"], waitingOn: null })).toBe("waiting-main");
    expect(requestStateOf({ rosterState: "active", lastReport: { phase: "blocked", at: at(0) }, followUpAt: null, openDeciders: [], waitingOn: "req-x" })).toBe("waiting-other");
    expect(requestStateOf({ rosterState: "active", lastReport: { phase: "received", at: at(0) }, followUpAt: null, openDeciders: [], waitingOn: null })).toBe("working");
    expect(requestStateOf({ rosterState: "stopped", lastReport: null, followUpAt: null, openDeciders: [], waitingOn: null })).toBe("stopped");
  });

  it("waitingOnOf reads a blocked report's wait, never the owner", () => {
    expect(waitingOnOf("blockers: waiting for: Main's signal that the frontend Worker (req-1) finished G14; then I open the MR")).toBe("Main's signal that the frontend Worker (req-1) finished G14");
    expect(waitingOnOf("blockers: waiting on the owner: Q2, Q3.")).toBeNull();
    expect(waitingOnOf("blockers: none")).toBeNull();
  });
});

describe("missionStateOf (design §2.1)", () => {
  it("composes the requests with their real state, questions with their decider, asks, links, the owner's exchange, the governor and the journal", async () => {
    roster().add(MISSION, { requestId: REQ_A, workspaceId: BACK, topic: "Push and add routes", workerId: "w-back" });
    roster().add(MISSION, { requestId: REQ_B, workspaceId: FRONT, topic: "G14 tools", workerId: "w-front" });
    roster().add(MISSION, { requestId: REQ_C, workspaceId: BACK, topic: "Coverage review", workerId: "w-cov" });
    report(BACK, REQ_A, "w-back", "blocked", ["blockers: waiting for: Main's signal that the frontend Worker (req-20261010T033304Z) finished G14"]);
    report(FRONT, REQ_B, "w-front", "blocked", ["blockers: waiting on the owner: Q1."]);
    report(BACK, REQ_C, "w-cov", "finished", [], new Date(NOW.getTime() - 2 * 24 * 3_600_000));
    noteRosterReport(home, REQ_C, "finished");
    createDecisionStore(home).open(makeDecision({ id: `q:${REQ_B}:Q1`, workspaceId: FRONT, requestId: REQ_B, class: "scope", question: "Which tool list?\nmore", subject: "tools" }));
    const cards = createMissionDecisionStore(home);
    // The Main's own question (bm_owner_question): asked by the plugin on the Main's behalf.
    cards.open({ ...makeDecision({ requestId: null }), askedBy: { role: "plugin", agentId: MAIN }, id: `m:${MISSION}:1`, workspaceId: MISSION, question: "Commit .env.serve.local?", subject: null, options: [{ key: "a", label: "Commit", recommended: true, effects: ["commit"] }, { key: "b", label: "Leave it", recommended: false, effects: ["none"] }] });
    createPeerLinkStore(home, { newId: () => "peer-000000000001", now: () => NOW }).createLink({ kind: "question", from: { workspaceId: FRONT, requestId: REQ_B, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_shell", managerId: null }, text: "Register the remote?" });
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: HOME_WS, agentId: MAIN, at: NOW.toISOString(), sent: [{ agentId: MAIN, at: "2026-10-10T04:30:00.000Z", text: "làm theo để xuất đi", truncated: false, origin: "user" }], received: [{ agentId: MAIN, at: "2026-10-10T04:30:20.000Z", text: "Mình đã chuyển lời bạn.\n\nChi tiết…", truncated: false, origin: "agent" }] }) as never);
    clearTraceStoreCache();
    createGovernorStore(home).put(MISSION, { stuck: { step: 2, since: "2026-10-10T04:20:00.000Z", figures: [{ family: "stuck", id: "stalled", value: 1, threshold: 1, op: ">=", crossed: true, detail: REQ_A }], lastAction: null, mainTurnsAt: null } });

    const found = state();
    expect(found.requests.map((request) => [request.requestId, request.state])).toEqual([
      [REQ_A, "waiting-other"],
      [REQ_B, "waiting-main"],
    ]);
    expect(found.requests[0]!.waitingOn).toContain("frontend Worker");
    expect(found.questions).toEqual([expect.objectContaining({ id: `q:${REQ_B}:Q1`, decider: "main", question: "Which tool list?", recommended: "a — Push contract only" })]);
    expect(found.asks).toEqual([expect.objectContaining({ id: `m:${MISSION}:1`, question: "Commit .env.serve.local?", options: ["Commit", "Leave it"], recommended: "a — Commit", byMain: true })]);
    expect(found.links).toEqual([expect.objectContaining({ linkId: "peer-000000000001", direction: "out", partner: "wks_shell", state: "open" })]);
    expect(found.owner).toEqual([
      { at: "2026-10-10T04:30:00.000Z", from: "owner", text: "làm theo để xuất đi" },
      { at: "2026-10-10T04:30:20.000Z", from: "main", text: "Mình đã chuyển lời bạn." },
    ]);
    expect(found.governor).toEqual([expect.objectContaining({ family: "stuck", step: 2 })]);
    expect(found.unknown).toEqual([]);

    const text = renderMissionState(found);
    expect(text).toContain(`- ${REQ_A} in ${BACK}: waiting on other work`);
    // The class is the decision's own reading of its options' effects (`decisionClassOf`): a push is `release`.
    expect(text).toContain(`Yours to decide:\n- q:${REQ_B}:Q1 (release, tools): Which tool list?; the Worker recommends a — Push contract only`);
    expect(text).toContain(`Waiting on the owner:\n- m:${MISSION}:1 (your question): Commit .env.serve.local?`);
    expect(text).toContain("The owner said lately:");
    expect(text.endsWith("Read the whole mission with bm_mission.")).toBe(true);
  });

  it("keeps the rendering within its bound by dropping the oldest lines of the last sections first", () => {
    for (let index = 0; index < 120; index += 1) createMissionStore(home).appendJournal(MISSION, { kind: "note", by: "owner", text: `note ${index} ${"x".repeat(150)}` });
    roster().add(MISSION, { requestId: REQ_A, workspaceId: BACK, topic: "Push", workerId: "w-back" });
    const text = renderMissionState(state(), { maxChars: 1_500 });
    expect(text.length).toBeLessThanOrEqual(1_500);
    expect(text).toContain(`- ${REQ_A} in ${BACK}: working`);
    expect(MISSION_STATE_MAX_CHARS).toBe(6_000);
  });

  it("returns null for an unknown mission", () => {
    expect(missionStateOf(home, "mis-ffffffffff", { facts: FACTS })).toBeNull();
  });
});

describe("M-31: every in-flight item is in a successor's brief after every event (design §10)", () => {
  it("a scripted mission, the brief read after each event", () => {
    const expected = new Set<string>();
    const steps: Array<[string, () => void]> = [
      ["a Worker is created", () => {
        roster().add(MISSION, { requestId: REQ_A, workspaceId: BACK, topic: "Push", workerId: "w-back" });
        expected.add(REQ_A);
      }],
      ["it reports received", () => void report(BACK, REQ_A, "w-back", "received")],
      ["it asks a question", () => {
        createDecisionStore(home).open(makeDecision({ id: `q:${REQ_A}:Q1`, workspaceId: BACK, requestId: REQ_A, class: "scope" }));
        expected.add(`q:${REQ_A}:Q1`);
      }],
      ["it finishes", () => {
        report(BACK, REQ_A, "w-back", "finished");
        noteRosterReport(home, REQ_A, "finished", () => {}, "phase: finished");
      }],
      ["the Main tells it more work (the XAI handover)", () => noteFollowUp(home, REQ_A, "Take over XSPA's remaining work", new Date(NOW.getTime() + 60_000).toISOString())],
      ["a second Worker asks another repo", () => {
        roster().add(MISSION, { requestId: REQ_B, workspaceId: FRONT, topic: "G14", workerId: "w-front" });
        createPeerLinkStore(home, { newId: () => "peer-000000000002", now: () => NOW }).createLink({ kind: "work", from: { workspaceId: FRONT, requestId: REQ_B, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_shell", managerId: null }, text: "Register the remote" });
        expected.add(REQ_B).add("peer-000000000002");
      }],
      ["the Main asks the owner", () => {
        createMissionDecisionStore(home).open({ ...makeDecision({ requestId: null }), id: `m:${MISSION}:1`, workspaceId: MISSION, question: "Open the MR?", subject: null });
        expected.add(`m:${MISSION}:1`);
      }],
    ];
    for (const [name, step] of steps) {
      step();
      clearRequestIndexCache();
      const brief = renderMissionState(state());
      for (const id of expected) expect(brief, `${name}: ${id}`).toContain(id);
    }
    // The follow-up reopened the finished request: it is in flight, not finished.
    expect(state().requests.find((request) => request.requestId === REQ_A)?.state).not.toBe("finished");
    expect(createMissionStore(home).journal(MISSION, 50).map((line) => line.text)).toEqual(
      expect.arrayContaining([`${REQ_A} finished`, `Follow-up to ${REQ_A}: Take over XSPA's remaining work`, "Link peer-000000000002 asked wks_shell (work): Register the remote"]),
    );
  });
});
