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
import { fakeLineGit } from "./helpers/line-git";
import { clearLineCache, refreshLines } from "../plugin/server/line-watch";
import { finishedLineFactsOf, finishedLineOf } from "../plugin/server/line-state";
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

  it("a bound finished or stopped request is final: a later follow-up never reads it working (delivery line design §2.3)", () => {
    for (const rosterState of ["finished", "stopped"] as const) {
      expect(requestStateOf({ rosterState, lastReport: { phase: rosterState, at: at(0) }, followUpAt: at(1), openDeciders: ["owner"], waitingOn: null, bound: true })).toBe(rosterState);
      // The hand path keeps today's reopening.
      expect(requestStateOf({ rosterState, lastReport: { phase: rosterState, at: at(0) }, followUpAt: at(1), openDeciders: [], waitingOn: null, bound: false })).toBe("working");
    }
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

  it("a finished bound request with a continuation reads finished → its id; a follow-up does not reopen it (delivery line design §2.3, §2.7)", () => {
    roster().add(MISSION, { requestId: REQ_A, workspaceId: BACK, topic: "Push", workerId: "w-back" });
    roster().add(MISSION, { requestId: REQ_B, workspaceId: BACK, topic: "Push, more", workerId: "w-back-2", continuationOf: REQ_A });
    mkdirSync(join(home, "requests"), { recursive: true, mode: 0o700 });
    const entry = (requestId: string, over: Record<string, unknown>) => ({ requestId, workspaceId: BACK, createdAt: NOW.toISOString(), source: "tool", managerId: MAIN, workerIds: [], tier: "Small", finishedAt: null, reviews: { batches: [], grants: [] }, ...over });
    writeFileSync(
      join(home, "requests", `${BACK}.json`),
      JSON.stringify({ schemaVersion: 1, requests: [entry(REQ_A, { workerIds: ["w-back"], finishedAt: NOW.toISOString(), continuedBy: REQ_B }), entry(REQ_B, { workerIds: ["w-back-2"], continuationOf: REQ_A, chainRootId: REQ_A })] }),
      { mode: 0o600 },
    );
    report(BACK, REQ_A, "w-back", "finished", [], new Date(NOW.getTime() - 60_000));
    noteRosterReport(home, REQ_A, "finished");
    // A follow-up of the Main after the finished report does not reopen a bound request.
    noteFollowUp(home, REQ_A, "More work", NOW.toISOString());
    const found = state();
    expect(found.requests.map((request) => [request.requestId, request.state, request.continuationOf, request.continuedBy])).toEqual([
      [REQ_B, "working", REQ_A, null],
      [REQ_A, "finished", null, REQ_B],
    ]);
    expect(renderMissionState(found)).toContain(`- ${REQ_A} in ${BACK}: finished → ${REQ_B}; Worker w-back`);
    // Its place in the chain, walked back through the roster (delivery line design §2.7, the mission page's "nth of its chain").
    expect(found.requests.map((request) => request.chainPosition)).toEqual([2, null]);
  });

  it("holds one line per repo as the 60-second pass last read it, and a placement request's committed and verified (delivery line design §4.6, §4.9)", async () => {
    clearLineCache();
    const PLACE = "wks_back_m";
    const placement = { repo: BACK, workspaceId: PLACE, directory: "/w/back", branch: "m/XAI/back", target: "develop", base: "origin/develop", worktreeSlug: "m-xai-back", state: "ready" as const, requestKey: "bm-place-1", createdAt: NOW.toISOString(), deps: { cloned: [], at: null, note: null }, integration: { state: "granted" as const, decisionId: `m:${MISSION}:2`, grantedAt: "2026-10-10T04:00:00.000Z", revokedAt: null, scope: { remote: "origin" as const, branch: "m/XAI/back", target: "develop" }, mr: null } };
    const updated = createMissionStore(home, { env: {}, now: () => NOW }).update(MISSION, (mission) => ({ ...mission, placements: [{ ...placement, state: "failed" as const, workspaceId: null, directory: null }, placement] }));
    if (!updated.ok) throw new Error(updated.reasons.join("; "));
    roster().add(MISSION, { requestId: REQ_A, workspaceId: PLACE, topic: "Push and add routes", workerId: "w-back" });
    roster().add(MISSION, { requestId: REQ_B, workspaceId: FRONT, topic: "G14 tools", workerId: "w-front" });
    // The finished delivery carries what the plugin confirmed when the report arrived (WP-8.4).
    report(PLACE, REQ_A, "w-back", "finished", ["branch: m/XAI/back", "commit: abcdef1", "pushed: yes", "mr: https://gitlab.example/mr/7", "ci: pending", "", "finished, committed on m/XAI/back; CI pending."], new Date(NOW.getTime() - 60_000));
    noteRosterReport(home, REQ_A, "finished");
    report(FRONT, REQ_B, "w-front", "received");
    const { git, calls } = fakeLineGit({ "/w/back": { counts: "12\t3", status: "", lastCommitAt: "2026-10-10T03:00:00.000Z", head: "abcdef1234567", branch: "m/XAI/back", aheadOfOrigin: "0", aheadLog: "2026-10-10T03:00:00.000Z" } });
    // Before the first read of the run: the line is there, not read yet.
    expect(state().placements).toEqual([expect.objectContaining({ repo: BACK, readAt: null, dirty: null })]);
    await refreshLines(home, { now: () => NOW, git });
    const seen = calls.length;
    // integration.ci on: §4.5, §4.6 as built.
    const found = missionStateOf(home, MISSION, { now: () => NOW, env: {}, facts: FACTS, ci: "on" })!;
    expect(calls.length).toBe(seen);
    expect(found.placements).toEqual([
      {
        repo: BACK,
        name: null,
        workspaceId: PLACE,
        branch: "m/XAI/back",
        target: "develop",
        state: "ready",
        dirty: false,
        ahead: 3,
        behind: 12,
        lastCommitAt: "2026-10-10T03:00:00.000Z",
        pushed: true,
        mr: { url: "https://gitlab.example/mr/7", state: null, mergeable: null },
        ci: "pending",
        grant: { at: "2026-10-10T04:00:00.000Z" },
        readAt: NOW.toISOString(),
      },
    ]);
    expect(found.requests.find((request) => request.requestId === REQ_A)).toMatchObject({ committed: true, verified: "pending", commit: "abcdef1" });
    expect(found.requests.find((request) => request.requestId === REQ_B)?.committed).toBeUndefined();
    const text = renderMissionState(found);
    expect(text).toContain(`- ${REQ_A} in ${PLACE}: finished, committed, CI pending; Worker w-back`);
    expect(text).toContain(`Lines:\n- ${BACK}: m/XAI/back → develop, ready; ahead 3, behind 12; clean; last commit 2 h ago; pushed; MR https://gitlab.example/mr/7; CI pending; push & MR allowed`);
    expect(renderMissionState(found, { maxChars: 6_000 }).length).toBeLessThanOrEqual(MISSION_STATE_MAX_CHARS);
    // ADR-036 (§17.1): integration.ci off, the default: the merge request without CI, and an older delivery's CI word read as unverified.
    for (const off of [state(), missionStateOf(home, MISSION, { now: () => NOW, env: {}, facts: FACTS, ci: "off" })!]) {
      expect(off.placements).toEqual([expect.objectContaining({ repo: BACK, mr: { url: "https://gitlab.example/mr/7", state: null, mergeable: null }, ci: null })]);
      expect(off.requests.find((request) => request.requestId === REQ_A)).toMatchObject({ committed: true, verified: "unverified", commit: "abcdef1" });
      const offText = renderMissionState(off);
      expect(offText).toContain(`- ${REQ_A} in ${PLACE}: finished, committed; Worker w-back`);
      expect(offText).toContain(`Lines:\n- ${BACK}: m/XAI/back → develop, ready; ahead 3, behind 12; clean; last commit 2 h ago; pushed; MR https://gitlab.example/mr/7; push & MR allowed`);
      expect(offText).not.toMatch(/\bCI\b/);
    }
    // A delivery the plugin wrote with CI off says verified from a detected check: kept.
    report(PLACE, REQ_A, "w-back", "finished", ["branch: m/XAI/back", "commit: abcdef1", "pushed: yes", "mr: https://gitlab.example/mr/7", "ci: failure", "", "finished, committed on m/XAI/back; verified."], new Date(NOW.getTime() - 30_000));
    expect(state().requests.find((request) => request.requestId === REQ_A)).toMatchObject({ committed: true, verified: "verified" });
    expect(renderMissionState(state())).toContain(`- ${REQ_A} in ${PLACE}: finished, committed, verified; Worker w-back`);
    clearLineCache();
  });

  it("reads the finished line the plugin wrote back: committed or not, and its CI then", () => {
    const line = { dirty: false, ahead: 1, behind: 0, lastCommitAt: null, head: "abc", branchOk: true, aheadOfOrigin: 0 };
    for (const verified of ["verified", "ci-red", "pending", "unverified"] as const) {
      expect(finishedLineFactsOf(`text\n\n${finishedLineOf({ committed: true, line }, "m/A.b/c", verified)}`)).toEqual({ committed: true, verified });
    }
    expect(finishedLineFactsOf(finishedLineOf({ committed: false, why: "the worktree has changes not committed", line: null }, "m/A/c", "unverified"))).toEqual({ committed: false, verified: "unverified" });
    expect(finishedLineFactsOf("BM-REPORT\nphase: finished")).toBeNull();
    // A mission with no placement has no Lines section.
    expect(renderMissionState(state())).not.toContain("Lines:");
  });

  it("returns null for an unknown mission", () => {
    expect(missionStateOf(home, "mis-ffffffffff", { facts: FACTS })).toBeNull();
  });
});

describe("contracts and each link's latest message (delivery line design §9.3)", () => {
  const contract = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `API ${id}`, providerRepo: BACK, consumerRepos: [FRONT], text: "GET /x", version: 1, updatedAt: NOW.toISOString(), source: "PRD", ...over });

  it("lists the live contracts after In flight, proposed first; a link shows its latest message with its refs; a link closed today stays to show its close", () => {
    createMissionStore(home, { env: {}, now: () => NOW }).update(MISSION, (mission) => ({
      ...mission,
      contracts: [contract("C1"), contract("C2", { status: "proposed", version: 3 }), contract("C3", { status: "withdrawn" }), contract("C4", { status: "agreed", consumerRepos: [] })],
    }));
    roster().add(MISSION, { requestId: REQ_B, workspaceId: FRONT, topic: "G14 tools", workerId: "w-front" });
    const links = createPeerLinkStore(home, { newId: (() => { let n = 0; return () => `peer-00000000000${(n += 1)}`; })(), now: () => new Date(NOW.getTime() - 40 * 60_000) });
    links.createLink({ kind: "question", from: { workspaceId: FRONT, requestId: REQ_B, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_shell", managerId: null }, text: "Register the remote?" });
    links.appendMessage("peer-000000000001", { recordId: "out-000000000001", workspaceId: FRONT, side: "asker", agentId: "w-front", kind: "peer", text: "Register the remote?", act: "ask" });
    links.appendMessage("peer-000000000001", { recordId: "out-000000000002", workspaceId: "wks_shell", side: "answerer", agentId: "w-shell", kind: "peer-message", text: "Registered as origin-b.", act: "answer", refs: { contracts: ["C2@v3"] } });
    links.createLink({ kind: "work", from: { workspaceId: FRONT, requestId: REQ_B, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_ops", managerId: null }, text: "Open the port" });
    links.appendMessage("peer-000000000002", { recordId: "out-000000000003", workspaceId: "wks_ops", side: "answerer", agentId: "w-ops", kind: "peer-message", text: "Not needed any more.", act: "close" });
    links.closeLink("peer-000000000002", "answerer");
    links.createLink({ kind: "work", from: { workspaceId: FRONT, requestId: REQ_B, agentId: "w-front", role: "worker" }, to: { workspaceId: "wks_db", managerId: null }, text: "Add the index" });

    const found = state();
    expect(found.contracts!.map((entry) => [entry.id, entry.version, entry.status])).toEqual([
      ["C2", 3, "proposed"],
      ["C1", 1, "agreed"],
      ["C4", 1, "agreed"],
    ]);
    expect(found.links.map((link) => [link.linkId, link.state, link.last?.act ?? null])).toEqual([
      ["peer-000000000001", "open", "answer"],
      ["peer-000000000002", "closed", "close"],
      ["peer-000000000003", "open", null],
    ]);
    const text = renderMissionState(found);
    expect(text).toContain(`In flight:\n- ${REQ_B}`);
    expect(text).toContain(
      [`Contracts:`, `- C2 v3 proposed: API C2 (provider ${BACK}; consumers ${FRONT})`, `- C1 v1 agreed: API C1 (provider ${BACK}; consumers ${FRONT})`, `- C4 v1 agreed: API C4 (provider ${BACK}; consumers none)`, "Waiting on the owner:"].join("\n"),
    );
    expect(text).not.toContain("C3");
    expect(text).toContain("- peer-000000000001 to wks_shell (question, open): last answer by wks_shell 40 min ago: Registered as origin-b. · refs C2@v3");
    expect(text).toContain("- peer-000000000002 to wks_ops (work, closed): last close by wks_ops 40 min ago: Not needed any more.");
    // A link with no message but its ask shows the ask.
    expect(text).toContain("- peer-000000000003 to wks_db (work, open): Add the index");
    expect(text.length).toBeLessThanOrEqual(MISSION_STATE_MAX_CHARS);
  });

  it("drops Recently, Governor and the owner's words first, then Contracts (agreed before proposed), then Links", () => {
    const base = state();
    const filled = {
      ...base,
      contracts: [
        { id: "C1", version: 2, status: "proposed", title: "Orders", provider: "back", consumers: ["front"] },
        { id: "C2", version: 1, status: "agreed", title: "Invoices", provider: "back", consumers: [] },
      ],
      links: [{ linkId: "peer-000000000001", route: "project", kind: "work", direction: "out" as const, partner: "ops", state: "open", waitingSince: null, gist: "Open the port", last: null }],
      owner: [{ at: NOW.toISOString(), from: "owner" as const, text: "o".repeat(200) }],
      journal: [{ at: NOW.toISOString(), kind: "note", by: "owner", text: "j".repeat(190) }],
    };
    const full = renderMissionState(filled);
    const parts = ["Recently:\n-", "The owner said lately:\n-", "- C2 v1", "- C1 v2", "- peer-000000000001"];
    for (const part of parts) expect(full).toContain(part);
    // Shrinking the room one character at a time, the order in which each part leaves.
    const gone: string[] = [];
    for (let max = full.length; max > 0 && gone.length < parts.length; max -= 1) {
      const text = renderMissionState(filled, { maxChars: max });
      for (const part of parts) if (!gone.includes(part) && !text.includes(part)) gone.push(part);
    }
    expect(gone).toEqual(parts);
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
