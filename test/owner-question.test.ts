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

  it("an answer on the card is journaled and told to the Main", async () => {
    await tools().call("bm_owner_question", { question: "Open the MR?", options: [{ label: "Open it", recommended: true }, { label: "Wait" }], class: "release" }, CALLER);
    const id = `m:${MISSION}:1`;
    const mutation = createMissionDecisionStore(home).transition(id, (decision) => answerDecision(decision, { via: "inbox", optionKey: "b", at: NOW.toISOString() }));
    if (mutation.status !== "updated") throw new Error("not answered");
    await applyMissionDecision(mutation.decision, deps());
    expect(toMain().map((record) => record.text.split("\n")[0])).toEqual([`The owner answered your question ${id}: b — Wait.`]);
  });
});
