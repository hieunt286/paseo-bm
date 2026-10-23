import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCaller } from "../plugin/server/agent-bindings";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { applyMissionDecision, tellMainOfQuestions } from "../plugin/server/mission-tools";
import { createOutbox } from "../plugin/server/outbox";
import { createOwnerQuestionTools, settleOwnerQuestionAnswers } from "../plugin/server/owner-question";
import { createRequestRegistry } from "../plugin/server/request-registry";
import { answerDecision } from "../plugin/shared/decisions";
import { makeDecision } from "./helpers/decisions";

/**
 * Mission runtime design §4.4 and §4.6 (ADR-033 decision 3, REQ-204 d,
 * REQ-205): the Main is told at once of a question it decides; the Main asks
 * the owner with a stored decision, answered on the card or in its chat.
 * A temporary data folder — never the real HOME.
 */

const MISSION = "mis-0123456789";
const MAIN = "main-1";
const HOME_WS = "wks_home";
const REPO = "wks_repo";
const REQ = "req-20261010T033304Z";
const NOW = new Date("2026-10-10T05:00:00.000Z");
const TURN = "2026-10-10T05:00:00.000Z";
let root: string;
let home: string;
const logs: string[] = [];
const CALLER: ToolCaller = { agentId: MAIN, role: "manager", workspaceId: HOME_WS, requestId: null, parentId: null, batchId: null, missionId: MISSION };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-owner-question-"));
  home = join(root, "data");
  logs.length = 0;
  clearRequestIndexCache();
  clearDecisionStoreCache();
  const made = createMissionStore(home, { newId: () => MISSION, env: {}, now: () => NOW }).create({ code: "XAI", name: "XAI", goal: "g", repos: [REPO], createdBy: "owner", mainId: MAIN });
  if (!made.ok) throw new Error(made.reasons.join("; "));
  mkdirSync(join(home, "ui"), { recursive: true });
  writeFileSync(join(home, "ui", "missions-home.json"), JSON.stringify({ schemaVersion: 1, workspaceId: HOME_WS, directory: join(home, "missions", "home") }));
  createMissionRoster(home).add(MISSION, { requestId: REQ, workspaceId: REPO, topic: "G14", workerId: "w-1" });
  createRequestRegistry(home, { backfill: () => [] }).register(REPO, REQ, { source: "tool", managerId: MAIN, workerId: "w-1" });
});

afterEach(() => {
  clearRequestIndexCache();
  clearDecisionStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const deps = () => ({ home, now: NOW, log: (message: string) => logs.push(message) });
const toMain = () => createOutbox(home).list(HOME_WS).filter((record) => record.to === MAIN && record.kind === "message");

describe("the Main is told at once of a question it decides (design §4.4)", () => {
  it("a question whose repo delegates its class tells the Main once; one for the owner tells it nothing", async () => {
    createAutonomyStore(home).set({ workspaceId: REPO, class: "scope", mode: "delegate", confirmed: true }, NOW.toISOString());
    const store = createDecisionStore(home);
    const mine = makeDecision({ id: `q:${REQ}:Q1`, workspaceId: REPO, requestId: REQ, class: "scope", subject: "tools", question: "Which tool list?", options: [{ key: "a", label: "Backend catalogue", recommended: true, effects: ["none"] }, { key: "b", label: "Fixed list", recommended: false, effects: ["none"] }] });
    const owners = makeDecision({ id: `q:${REQ}:Q2`, workspaceId: REPO, requestId: REQ, class: "scope", subject: "login", ownerOnly: true, question: "Your login?" });
    store.open(mine);
    store.open(owners);
    expect(await tellMainOfQuestions([mine, owners], deps())).toBe(1);
    expect(toMain()).toHaveLength(1);
    expect(toMain()[0]).toMatchObject({ from: "plugin", requestId: REQ });
    expect(toMain()[0]!.text).toContain(`Q1 of ${REQ} (scope, tools) is yours to answer within the mission's delegation: Which tool list?; options a — Backend catalogue (recommended); b — Fixed list. Answer with bm_answer_worker`);
  });
});

describe("bm_owner_question (design §4.6)", () => {
  const tools = () => createOwnerQuestionTools({ home: () => home, log: (message) => logs.push(message), now: () => NOW, turnStartOf: () => TURN });

  it("asks the owner with a stored m: question, refusing a malformed one", async () => {
    const refused = await tools().call("bm_owner_question", { question: "Commit .env.serve.local?", options: [{ label: "Commit", recommended: true }, { label: "Leave it", recommended: true }], class: "release" }, CALLER);
    expect(refused).toMatchObject({ ok: false, text: expect.stringContaining("exactly one must be recommended") });
    const asked = await tools().call("bm_owner_question", { question: "Commit .env.serve.local?", options: [{ label: "Commit", recommended: true }, { label: "Leave it untracked" }], class: "release", subject: "env-serve-local" }, CALLER);
    expect(asked.ok).toBe(true);
    const { decisionId } = JSON.parse(asked.text.split("\n").find((line) => line.startsWith("{"))!) as { decisionId: string };
    expect(decisionId).toBe(`m:${MISSION}:1`);
    expect(createMissionDecisionStore(home).get(decisionId)).toMatchObject({
      status: "open",
      class: "release",
      askedBy: { role: "plugin", agentId: MAIN },
      options: [
        { key: "a", label: "Commit", recommended: true },
        { key: "b", label: "Leave it untracked", recommended: false },
      ],
    });
    expect(createMissionStore(home).journal(MISSION, 5).at(-1)).toMatchObject({ kind: "decision", by: "main", text: `The Main asked the owner (${decisionId}): Commit .env.serve.local?` });
    // A caller that is no Main of a mission is refused.
    expect((await tools().call("bm_owner_question", { question: "x", options: [{ label: "a", recommended: true }, { label: "b" }], class: "scope" }, { ...CALLER, agentId: "other", missionId: null })).ok).toBe(false);
  });

  it("an answer typed in the Main's chat is settled at the turn's end only with the owner's words in it, and not told back", async () => {
    await tools().call("bm_owner_question", { question: "Open the MR?", options: [{ label: "Open it", recommended: true }, { label: "Wait" }], class: "release" }, CALLER);
    const id = `m:${MISSION}:1`;
    expect((await tools().call("bm_owner_question", { answered: id, option: "a" }, CALLER)).ok).toBe(true);
    expect(await settleOwnerQuestionAnswers(MAIN, TURN, false, { home, log: (message) => logs.push(message), now: () => NOW })).toEqual([]);
    expect(createMissionDecisionStore(home).get(id)?.status).toBe("open");
    expect((await tools().call("bm_owner_question", { answered: id, words: "mở luôn" }, CALLER)).ok).toBe(true);
    const settled = await settleOwnerQuestionAnswers(MAIN, TURN, true, { home, log: (message) => logs.push(message), now: () => NOW });
    expect(settled.map((decision) => decision.answer)).toEqual([expect.objectContaining({ by: "owner", via: "chat-manager", words: "mở luôn" })]);
    expect(createMissionStore(home).journal(MISSION, 5).at(-1)?.text).toBe(`The owner answered the Main's question ${id}: in words: mở luôn`);
    expect(toMain()).toEqual([]);
    // Refused: both an option and words, or an unknown question.
    expect((await tools().call("bm_owner_question", { answered: id, option: "a", words: "x" }, CALLER)).ok).toBe(false);
    expect((await tools().call("bm_owner_question", { answered: `m:${MISSION}:9`, option: "a" }, CALLER)).ok).toBe(false);
  });

  describe("one card per question (delivery line design §7.2)", () => {
    const workerQuestion = (over: Partial<Parameters<typeof makeDecision>[0]> = {}) =>
      makeDecision({
        id: `q:${REQ}:Q3`,
        workspaceId: REPO,
        requestId: REQ,
        class: "release",
        subject: "env-serve-local",
        question: "Commit .env.serve.local?",
        options: [
          { key: "a", label: "Commit", recommended: true, effects: ["commit"] },
          { key: "b", label: "Leave it untracked", recommended: false, effects: ["none"] },
        ],
        ...over,
      });
    const nothingStored = () => expect(createMissionDecisionStore(home).get(`m:${MISSION}:1`)).toBeNull();

    it("a Main question of the same subject as an open Worker question is refused, the Main's recommendation attached to it", async () => {
      createDecisionStore(home).open(workerQuestion());
      const result = await tools().call("bm_owner_question", { question: "Should the env file be committed?", options: [{ label: "Commit" }, { label: "Leave it untracked", recommended: true }], class: "release", subject: "env-serve-local" }, CALLER);
      expect(result).toEqual({ ok: false, text: `Refused: the Worker's question q:${REQ}:Q3 already asks the owner this. Your recommendation (b — Leave it untracked) is attached to it. Nothing new was stored.` });
      expect(createDecisionStore(home).get(`q:${REQ}:Q3`, REPO)?.prediction?.main).toEqual({ optionKey: "b", reason: "Leave it untracked", at: NOW.toISOString() });
      nothingStored();
      // Asked again: the first recommendation stays.
      const again = await tools().call("bm_owner_question", { question: "Commit .env.serve.local?", options: [{ label: "Commit", recommended: true }, { label: "No" }], class: "release" }, CALLER);
      expect(again.text).toBe(`Refused: the Worker's question q:${REQ}:Q3 already asks the owner this. Your earlier recommendation (b — Leave it untracked) stays attached to it. Nothing new was stored.`);
      expect(createDecisionStore(home).get(`q:${REQ}:Q3`, REPO)?.prediction?.main?.optionKey).toBe("b");
      nothingStored();
    });

    it("the same text, or the question named by about.decisionId, is the same question; an option matches by label, else by key", async () => {
      createDecisionStore(home).open(workerQuestion({ subject: null }));
      const byText = await tools().call("bm_owner_question", { question: "commit  .ENV.serve.local", options: [{ label: "Yes, commit", recommended: true }, { label: "No" }], class: "release", subject: "other" }, CALLER);
      expect(byText.text).toContain("Your recommendation (a — Yes, commit) is attached to it.");
      createDecisionStore(home).open(workerQuestion({ id: `q:${REQ}:Q4`, subject: null, question: "Which branch?", options: [{ key: "a", label: "main", recommended: true, effects: ["none"] }, { key: "b", label: "dev", recommended: false, effects: ["none"] }] }));
      const named = await tools().call("bm_owner_question", { question: "Where should the work land?", options: [{ label: "On main" }, { label: "On a feature branch", recommended: true }, { label: "On dev" }], class: "scope", about: { decisionId: `q:${REQ}:Q4` } }, CALLER);
      expect(named.text).toBe(`Refused: the Worker's question q:${REQ}:Q4 already asks the owner this. Your recommendation (b — On a feature branch) is attached to it. Nothing new was stored.`);
      expect(createDecisionStore(home).get(`q:${REQ}:Q4`, REPO)?.prediction?.main).toMatchObject({ optionKey: "b", reason: "On a feature branch" });
      nothingStored();
    });

    it("a question no open Worker question asks is stored as before; an about naming nothing of the mission is refused", async () => {
      createDecisionStore(home).open(workerQuestion());
      const asked = await tools().call("bm_owner_question", { question: "Deploy now?", options: [{ label: "Deploy", recommended: true }, { label: "Wait" }], class: "release", subject: "deploy" }, CALLER);
      expect(asked.ok).toBe(true);
      expect(createMissionDecisionStore(home).get(`m:${MISSION}:1`)).toMatchObject({ status: "open", subject: "deploy" });
      expect(createDecisionStore(home).get(`q:${REQ}:Q3`, REPO)?.prediction?.main ?? null).toBeNull();
      const stranger = await tools().call("bm_owner_question", { question: "x?", options: [{ label: "a", recommended: true }, { label: "b" }], class: "scope", about: { requestId: "req-20260101T000000Z" } }, CALLER);
      expect(stranger).toMatchObject({ ok: false, text: expect.stringContaining("about.requestId: req-20260101T000000Z is not a request of mission XAI") });
    });
  });

  it("an answer on the card is journaled and told to the Main", async () => {
    await tools().call("bm_owner_question", { question: "Open the MR?", options: [{ label: "Open it", recommended: true }, { label: "Wait" }], class: "release" }, CALLER);
    const id = `m:${MISSION}:1`;
    const mutation = createMissionDecisionStore(home).transition(id, (decision) => answerDecision(decision, { via: "inbox", optionKey: "b", at: NOW.toISOString() }));
    if (mutation.status !== "updated") throw new Error("not answered");
    await applyMissionDecision(mutation.decision, deps());
    expect(toMain().map((record) => record.text.split("\n")[0])).toEqual([`The owner answered your question ${id}: b — Wait.`]);
  });
});
