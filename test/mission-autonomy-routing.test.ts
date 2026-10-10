import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBindingCache, type ToolCaller } from "../plugin/server/agent-bindings";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import {
  handleAutonomyPolicy,
  handleAutonomySetMissionCell,
  handleAutonomySetMissionLevel,
} from "../plugin/server/autonomy-rpc";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { answersMessageOf } from "../plugin/server/decision-delivery";
import { clearMaterialiserMemory, materialiseTurn } from "../plugin/server/decision-materialiser";
import { handleDecisionsAnswer } from "../plugin/server/decision-rpc";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createMissionAutonomyStore } from "../plugin/server/mission-autonomy-store";
import { clearRequestIndexCache, createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createMissionTools } from "../plugin/server/mission-tools";
import { createOutbox } from "../plugin/server/outbox";
import { ensureMissionsHome, missionsHomeDirOf, type MissionsPaseo } from "../plugin/server/missions-home";
import { questionIsTheMainsText } from "../plugin/server/orchestrator-decide-tools";
import { createOrchestratorTools } from "../plugin/server/orchestrator-tools";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  checkMissionSetCell,
  checkMissionSetLevel,
  decideRefusalOf,
  mainAnswerRuleOf,
  missionAnswerCellOf,
  missionQuestionRefusalOf,
  type AutonomyPolicy,
} from "../plugin/shared/autonomy";
import { agreementLedger } from "../plugin/shared/autonomy-ledger";
import { MAIN_ANSWER_MINUTES } from "../plugin/shared/bm-tools";
import { autonomyPolicyRpc, autonomySetMissionLevelRpc } from "../plugin/shared/contracts";
import {
  ANSWER_VIA,
  OWNER_FACT_PHRASES,
  answerDecision,
  decisionSchema,
  openingPrediction,
  ownerFactOf,
  ownerOnlyRefusalText,
  type Decision,
  type DecisionClass,
  type DecisionOption,
} from "../plugin/shared/decisions";
import { msg, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * WP-113 (missions design §2.4, §4, §5, §8; REQ-189): the two autonomy
 * layers — the mission level beside the repo level — and the ownerOnly
 * guarantee. A Worker's question of a mission request is its Main's
 * (`bm_answer_worker`) where §8 allows, never the Orchestrator's; an
 * ownerOnly question only the owner answers, on every path. Temporary data
 * folders and fake Paseo handles only.
 */

const NOW = new Date("2026-10-09T10:00:00.000Z");
const ASKED = "2026-10-09T09:55:00.000Z";
const WS = "wks-a";
const REQ = "req-20261009T095000Z";
const MAIN = "main-1";
const WORKER = "wkr-1";

let root: string;
let home: string;
let logs: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mission-routing-"));
  home = join(root, ".paseo-bm");
  vi.stubEnv("HOME", root);
  vi.stubEnv("PASEO_BM_HOME", home);
  logs = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearJsonFileCache();
  clearBindingCache();
  clearDecisionStoreCache();
  clearMaterialiserMemory();
  clearRequestIndexCache();
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const log = (line: string) => void logs.push(line);

function question(overrides: Partial<Decision> & { n?: number } = {}): Decision {
  const { n = 1, ...rest } = overrides;
  const options: DecisionOption[] = [
    { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] },
    { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] },
  ];
  return {
    id: `q:${REQ}:Q${n}`,
    workspaceId: WS,
    requestId: REQ,
    askedBy: { role: "worker", agentId: WORKER },
    askedAt: ASKED,
    round: 1,
    question: "Which date format?",
    subject: "date-format",
    class: "scope",
    options,
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    prediction: openingPrediction(options),
    ...rest,
  };
}

const policyWith = (cells: Partial<Record<DecisionClass, "owner" | "shadow" | "delegate">>, challenger = true): AutonomyPolicy => ({
  projects: { [WS]: Object.fromEntries(Object.entries(cells).map(([name, mode]) => [name, { mode, at: ASKED }])) },
  challenger: { [WS]: challenger },
});

const delegateRepo = (decisionClass: DecisionClass, mode: "shadow" | "delegate" = "delegate") =>
  createAutonomyStore(home).set({ workspaceId: WS, class: decisionClass, mode, confirmed: true }, ASKED);

/** A mission of MAIN with REQ of WS in its roster. */
function mission() {
  const created = createMissionStore(home, { now: () => NOW }).create({ code: "WEB", name: "Website", goal: "Ship v2", repos: [WS], createdBy: "owner", mainId: MAIN });
  if (!created.ok) throw new Error(created.reasons.join("; "));
  createMissionRoster(home).add(created.mission.missionId, { requestId: REQ, workspaceId: WS, topic: "dates", workerId: WORKER });
  return created.mission;
}

// ---------------------------------------------------------------------------
// ownerOnly (§5).
// ---------------------------------------------------------------------------

describe("ownerOnly: the guard and the answer (missions design §5)", () => {
  it("the guard marks options that assert something about the owner, in English and Vietnamese", () => {
    const owner = [
      "I have logged in to npm",
      "I've set the token",
      "I’ve run npm login",
      "the owner has a staging account",
      "I am logged in",
      "Tôi đã đăng nhập npm",
      "Tôi đã chạy npm login".normalize("NFD"),
      "tôi có tài khoản staging",
      "Tôi đang dùng cổng 5433",
      "Đã điền mật khẩu",
      "Đã đăng nhập rồi",
      "Dùng tài khoản của tôi",
    ];
    for (const label of owner) expect(ownerFactOf([{ label: "Hold" }, { label }]), label).toBe(label);
    for (const label of ["Use the users table", "Hold until the review", "Chi have a look", "Tôi không biết"]) expect(ownerFactOf([{ label }]), label).toBeNull();
    expect(OWNER_FACT_PHRASES).toContain("của tôi");
  });

  it("only the owner answers an ownerOnly question, never through a Manager's chat; the field is stored", () => {
    const asked = question({ ownerOnly: true });
    expect(decisionSchema.parse(asked).ownerOnly).toBe(true);
    const refusal = { ok: false, refusal: "invalid-answer", message: ownerOnlyRefusalText(asked.id) };
    const at = NOW.toISOString();
    expect(answerDecision(asked, { by: "policy", via: "inbox", optionKey: "a", at })).toEqual(refusal);
    expect(answerDecision(asked, { by: "precedent", precedentId: "p-1", via: "inbox", optionKey: "a", at })).toEqual(refusal);
    expect(answerDecision(asked, { by: "main", via: "main", optionKey: "a", at })).toEqual(refusal);
    expect(answerDecision(asked, { via: "chat-manager", optionKey: "a", at })).toEqual(refusal);
    for (const via of ["inbox", "chat-card", "chat-worker"] as const) {
      expect(answerDecision(asked, { via, optionKey: "a", at }), via).toMatchObject({ ok: true, decision: { answer: { by: "owner", via } } });
    }
  });

  it("the policy and the Orchestrator's decision refuse it", () => {
    const asked = question({ ownerOnly: true });
    expect(decideRefusalOf(policyWith({ scope: "delegate" }), asked)).toBe(`${ownerOnlyRefusalText(asked.id)}; leave it to the owner`);
    // Without it, it stands as before.
    expect(decideRefusalOf(policyWith({ scope: "delegate" }), question())).toBeNull();
  });

  it("a question opened through a BM-QUESTIONS block with an owner fact is ownerOnly, logged, and its precedent does not answer it", async () => {
    createPrecedentStore(home, { newId: () => "prec-npm" }).save({ scope: WS, subject: "npm-login", text: "Tôi đã đăng nhập npm", sourceDecisionId: null, expiresInDays: 30 }, NOW);
    const block = ["BM-QUESTIONS", `requestId: ${REQ}`, "Q1: Is npm logged in? [subject: npm-login] [class: environment]", "- a: Tôi đã đăng nhập npm (recommended)", "- b: Not yet"].join("\n");
    const record = turn({ agentId: MAIN, role: "manager", workspaceId: WS, sent: [msg(MAIN, ASKED, block, "agent")] });
    const outcome = await materialiseTurn(record, { home, now: () => NOW, log, workerOf: async () => WORKER });
    expect(outcome.answered).toEqual([]);
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)).toMatchObject({ status: "open", ownerOnly: true });
    expect(logs.some((line) => line.includes(`q:${REQ}:Q1 is the owner's to answer`))).toBe(true);
  });

  it("a Main-written BM-ANSWERS does not answer it, even in a turn with the owner's message; the owner's words in the Worker's chat do", async () => {
    createDecisionStore(home).open(question({ ownerOnly: true }));
    const answers = ["BM-ANSWERS", `requestId: ${REQ}`, "Q1: a — dd/mm/yyyy"].join("\n");
    const main = turn({ agentId: MAIN, role: "manager", workspaceId: WS, sent: [msg(MAIN, "2026-10-09T09:58:00.000Z", "a", "user")], received: [msg(MAIN, "2026-10-09T09:59:00.000Z", answers)] });
    expect((await materialiseTurn(main, { home, now: () => NOW, log })).answered).toEqual([]);
    expect(createDecisionStore(home).get(`q:${REQ}:Q1`, WS)?.status).toBe("open");
    expect(logs.some((line) => line.includes(`the chat-manager answer to q:${REQ}:Q1 was not recorded`) && line.includes("ownerOnly"))).toBe(true);
    const worker = turn({ agentId: WORKER, role: "worker", workspaceId: WS, requestId: REQ, sent: [msg(WORKER, "2026-10-09T09:59:30.000Z", answers, "user")] });
    expect((await materialiseTurn(worker, { home, now: () => NOW, log })).answered).toEqual([expect.objectContaining({ answer: expect.objectContaining({ by: "owner", via: "chat-worker" }) })]);
  });
});

// ---------------------------------------------------------------------------
// §8: the rule, pure.
// ---------------------------------------------------------------------------

describe("the two layers (missions design §8), pure", () => {
  const never = () => false;
  const only = (name: string) => (candidate: string) => candidate === name;

  it("a repo-delegated class is the Main's; an owner or shadow cell only through the mission cell of its group", () => {
    expect(missionAnswerCellOf("scope")).toBe("answer-technical");
    expect(missionAnswerCellOf("reversible-technical")).toBe("answer-technical");
    expect(missionAnswerCellOf("release")).toBe("answer-effects");
    expect(mainAnswerRuleOf(policyWith({ scope: "delegate" }), question(), never)).toEqual({ rule: "answer" });
    expect(mainAnswerRuleOf(policyWith({}), question(), only("answer-technical"))).toEqual({ rule: "answer" });
    expect(mainAnswerRuleOf(policyWith({}), question({ class: "release" }), only("answer-technical"))).toMatchObject({ refusal: expect.stringContaining("the owner decides it") });
    expect(mainAnswerRuleOf(policyWith({ scope: "shadow" }), question(), never)).toEqual({ rule: "predict" });
    expect(mainAnswerRuleOf(policyWith({ scope: "delegate" }), question({ ownerOnly: true }), () => true)).toEqual({ refusal: ownerOnlyRefusalText(`q:${REQ}:Q1`) });
  });

  it("the Orchestrator refuses a Worker question of a mission request, not an o: or f: decision, nor a request of no mission", () => {
    expect(missionQuestionRefusalOf(question(), "mis-0123456789")).toContain("its Main decides it (bm_answer_worker)");
    expect(missionQuestionRefusalOf(question(), null)).toBeNull();
    expect(missionQuestionRefusalOf({ id: "o:abc", requestId: REQ }, "mis-0123456789")).toBeNull();
  });

  it("the mission level inputs: levels 3–4 and a delegate cell need the owner's confirmation", () => {
    const missionId = "mis-0123456789";
    expect(checkMissionSetLevel({ missionId, level: 2 })).toEqual({ change: { missionId, level: 2 } });
    expect(checkMissionSetLevel({ missionId, level: 3 })).toMatchObject({ refusal: { code: "E_AUTONOMY_NOT_CONFIRMED" } });
    expect(checkMissionSetLevel({ missionId, level: 3, confirmed: true })).toMatchObject({ change: { level: 3 } });
    expect(checkMissionSetLevel({ missionId: "w1", level: 2 })).toEqual({ refusal: { code: "E_AUTONOMY_INVALID", detail: 'missionId "w1" is not a mission id; nothing was saved' } });
    expect(checkMissionSetLevel({ missionId, level: 7 })).toMatchObject({ refusal: { code: "E_AUTONOMY_INVALID", detail: "level 7 is not a level from 0 to 4; nothing was saved" } });
    expect(checkMissionSetCell({ missionId, class: "split", mode: "owner" })).toMatchObject({ change: { class: "split", mode: "owner" } });
    expect(checkMissionSetCell({ missionId, class: "split", mode: "delegate" })).toMatchObject({ refusal: { code: "E_AUTONOMY_NOT_CONFIRMED" } });
    expect(checkMissionSetCell({ missionId, class: "scope", mode: "owner" })).toMatchObject({ refusal: { code: "E_AUTONOMY_INVALID" } });
    expect(checkMissionSetCell({ missionId, class: "split", mode: "shadow" })).toMatchObject({ refusal: { code: "E_AUTONOMY_INVALID" } });
  });

  it("a Main's answer is an option via main, grants nothing, answers only a Worker's question, and counts as the policy's for calibration", () => {
    const answered = answerDecision(question(), { by: "main", via: "main", optionKey: "b", reason: "ISO sorts", at: NOW.toISOString() });
    expect(answered).toMatchObject({ ok: true, decision: { status: "answered", grant: null, answer: { by: "main", via: "main", optionKey: "b", reason: "ISO sorts" } } });
    expect(ANSWER_VIA).toContain("main");
    expect(answerDecision(question(), { by: "main", via: "inbox", optionKey: "a", at: NOW.toISOString() })).toMatchObject({ ok: false });
    expect(answerDecision(question(), { via: "main", optionKey: "a", at: NOW.toISOString() })).toMatchObject({ ok: false });
    expect(answerDecision(question({ id: "o:abc", requestId: REQ }), { by: "main", via: "main", optionKey: "a", at: NOW.toISOString() })).toMatchObject({ ok: false });
    expect(answerDecision(question(), { by: "main", via: "main", words: "whatever", at: NOW.toISOString() })).toMatchObject({ ok: false });
    if (!answered.ok) throw new Error(answered.message);
    expect(decisionSchema.parse(answered.decision).answer?.by).toBe("main");
    expect(agreementLedger([answered.decision]).delegated).toMatchObject([{ class: "scope", by: "policy", predictor: "main", count: 1 }]);
    // Delivered to the Worker as the Main's answer, never the owner's.
    expect(answersMessageOf(REQ, [answered.decision])).toContain("Q1 was answered by your mission's Main, not the owner (ISO sorts)");
  });
});

// ---------------------------------------------------------------------------
// bm_answer_worker (§4).
// ---------------------------------------------------------------------------

describe("bm_answer_worker (missions design §4, §8)", () => {
  async function setup() {
    const fake = fakePaseo<MissionsPaseo>({ workspaces: [{ id: WS, directory: "/repo/api" }, { id: "wks-own", directory: missionsHomeDirOf(home) }] });
    await ensureMissionsHome(fake.paseo, { home });
    const settled: Decision[][] = [];
    const tools = createMissionTools({ paseo: () => fake.paseo, home: () => home, log, now: () => NOW, onSettled: (decisions) => void settled.push(decisions) });
    const created = mission();
    const who: ToolCaller = { agentId: MAIN, role: "manager", workspaceId: "wks-own", requestId: null, parentId: null, batchId: null, missionId: created.missionId };
    const call = (answers: unknown, requestId = REQ) => tools.call("bm_answer_worker", { requestId, answers }, who);
    return { call, settled, mission: created };
  }
  const stored = (n = 1) => createDecisionStore(home).get(`q:${REQ}:Q${n}`, WS)!;

  it("answers a repo-delegated question as the Main, grants nothing, delivers it and journals it", async () => {
    const { call, settled, mission: created } = await setup();
    delegateRepo("scope");
    createDecisionStore(home).open(question());
    const result = await call([{ qn: "Q1", option: "b", why: "The plan says ISO dates." }]);
    expect(result.ok, result.text).toBe(true);
    expect(JSON.parse(result.text)).toEqual([expect.objectContaining({ qn: "Q1", decisionId: `q:${REQ}:Q1`, state: "answered" })]);
    expect(stored()).toMatchObject({ status: "answered", grant: null, answer: { by: "main", via: "main", optionKey: "b", class: "scope", reason: "The plan says ISO dates." } });
    expect(settled.flat().map((decision) => decision.id)).toEqual([`q:${REQ}:Q1`]);
    expect(createMissionStore(home).journal(created.missionId).at(-1)).toMatchObject({ kind: "decision", by: "main", text: `The Main answered Q1 of request ${REQ}.` });
  });

  it("in an owner cell, answers only what the mission level delegates", async () => {
    const { call, mission: created } = await setup();
    createDecisionStore(home).open(question());
    createDecisionStore(home).open(question({ n: 2, class: "release", subject: "push" }));
    // Level 2 (the default): neither.
    const refused = await call([{ qn: "Q1", option: "a", why: "x" }]);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("neither its repo nor your mission level (answer-technical) delegates");
    createMissionAutonomyStore(home).setLevel(created.missionId, 3);
    expect((await call([{ qn: "Q2", option: "a", why: "x" }])).text).toContain("(answer-effects) delegates");
    expect((await call([{ qn: "Q1", option: "a", why: "Fits the plan." }])).ok).toBe(true);
    expect(stored(1).answer).toMatchObject({ by: "main" });
    expect(stored(2).status).toBe("open");
  });

  it("in a shadow cell it may not decide, records the Main's recommendation as a prediction, once; the owner decides", async () => {
    const { call, settled } = await setup();
    delegateRepo("scope", "shadow");
    createDecisionStore(home).open(question());
    const result = await call([{ qn: "Q1", option: "b", why: "ISO sorts." }]);
    expect(JSON.parse(result.text)).toEqual([expect.objectContaining({ state: "recommended" })]);
    expect(stored()).toMatchObject({ status: "open", answer: null, prediction: { recommended: { optionKey: "a" }, main: { optionKey: "b", reason: "ISO sorts.", at: NOW.toISOString() } } });
    expect(settled).toEqual([]);
    expect((await call([{ qn: "Q1", option: "a", why: "again" }])).text).toContain("you recommended an option for Q1 already");
  });

  it("refuses an ownerOnly question, a late one, a settled one, an option with a grant, and a request outside the mission; a refusal writes nothing", async () => {
    const { call } = await setup();
    delegateRepo("scope");
    delegateRepo("cost");
    const store = createDecisionStore(home);
    store.open(question({ ownerOnly: true }));
    store.open(question({ n: 2, subject: "late", askedAt: new Date(NOW.getTime() - (MAIN_ANSWER_MINUTES + 1) * 60_000).toISOString() }));
    store.open(question({ n: 3, subject: "done" }));
    store.transition(`q:${REQ}:Q3`, (current) => answerDecision(current, { via: "inbox", optionKey: "a", at: ASKED }), WS);
    const granting = question({ n: 4, subject: "review-budget", class: "cost" });
    store.open({ ...granting, options: [{ ...granting.options[0]!, grant: { calls: 2 } }, granting.options[1]!] });
    store.open(question({ n: 5, subject: "fine" }));

    const result = await call([
      { qn: "Q1", option: "a", why: "x" },
      { qn: "Q2", option: "a", why: "x" },
      { qn: "Q3", option: "b", why: "x" },
      { qn: "Q4", option: "a", why: "x" },
      { qn: "Q5", option: "a", why: "x" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.text).toContain(`input.answers[0]: ${ownerOnlyRefusalText(`q:${REQ}:Q1`)}`);
    expect(result.text).toContain(`input.answers[1]: Q2 was asked more than ${MAIN_ANSWER_MINUTES} minutes ago`);
    expect(result.text).toContain("input.answers[2]: Q3 was already answered by the owner");
    expect(result.text).toContain("input.answers[3]: option a of Q4 carries a grant or a change");
    expect(stored(5).status).toBe("open");
    expect((await call([{ qn: "Q1", option: "a", why: "x" }], "req-20261009T090000Z")).text).toContain("is not one of mission WEB");
  });
});

// ---------------------------------------------------------------------------
// bm_decide on a mission request (§8).
// ---------------------------------------------------------------------------

describe("the Orchestrator on a mission request's question (missions design §8)", () => {
  async function orchestrator() {
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: WS }));
    const paseo = { agents: { list: async () => ({ entries: [] }), ref: () => ({ refresh: async () => null, send: async () => {} }) }, workspaces: { list: async () => ({ entries: [] }) } };
    const created = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {}, log });
    created.usePaseo(paseo);
    return created;
  }

  it("bm_decide refuses every Worker's question — ownerOnly, of a mission request, or of a request of no mission (missions design §9.1); bm_predict is retired", async () => {
    delegateRepo("scope");
    createAutonomyStore(home).setChallenger({ workspaceId: WS, enabled: true });
    const store = createDecisionStore(home);
    store.open(question({ ownerOnly: true }));
    store.open(question({ n: 2, subject: "other" }));
    const tools = await orchestrator();
    const refusal = (n: number) => ({ ok: false, text: `Refused: ${questionIsTheMainsText(`q:${REQ}:Q${n}`)}.` });
    expect(await tools.call("bm_decide", { decisionId: `q:${REQ}:Q1`, optionKey: "a", reason: "The owner said so." })).toEqual(refusal(1));
    // A request of no mission.
    expect(await tools.call("bm_decide", { decisionId: `q:${REQ}:Q2`, optionKey: "a", reason: "Fits." })).toEqual(refusal(2));
    mission();
    expect(await tools.call("bm_decide", { decisionId: `q:${REQ}:Q2`, optionKey: "a", reason: "Fits." })).toEqual(refusal(2));
    delegateRepo("scope", "shadow");
    expect(await tools.call("bm_predict", { decisionId: `q:${REQ}:Q2`, optionKey: "a", reason: "Fits." })).toEqual({ ok: false, text: "Unknown tool: bm_predict" });
    expect(store.get(`q:${REQ}:Q2`, WS)).toMatchObject({ status: "open", prediction: { orchestrator: null } });
  });
});

// ---------------------------------------------------------------------------
// The mission level RPCs (§2.4) and the Main told of the owner's card (§4.1).
// ---------------------------------------------------------------------------

describe("the mission level RPCs (missions design §2.4)", () => {
  it("sets a mission's level and cells with the owner's confirmation, refuses an unknown mission, and lists open missions in autonomy.policy", () => {
    const deps = { home, now: () => NOW };
    expect(handleAutonomyPolicy({}, deps)).not.toHaveProperty("missions");
    const created = mission();
    expect(() => handleAutonomySetMissionLevel({ missionId: created.missionId, level: 4 }, deps)).toThrow(expect.objectContaining({ code: "E_AUTONOMY_NOT_CONFIRMED" }));
    expect(() => handleAutonomySetMissionLevel({ missionId: "mis-ffffffffff", level: 1 }, deps)).toThrow(expect.objectContaining({ code: "E_AUTONOMY_INVALID" }));
    const set = handleAutonomySetMissionLevel({ missionId: created.missionId, level: 3, confirmed: true }, deps);
    expect(autonomySetMissionLevelRpc.output.parse(set)).toMatchObject({ missionId: created.missionId, autonomy: { level: 3, cells: { "answer-technical": { mode: "delegate" } } } });
    expect(() => handleAutonomySetMissionCell({ missionId: created.missionId, class: "answer-effects", mode: "delegate" }, deps)).toThrow(expect.objectContaining({ code: "E_AUTONOMY_NOT_CONFIRMED" }));
    expect(handleAutonomySetMissionCell({ missionId: created.missionId, class: "staffing", mode: "owner" }, deps).autonomy.level).toBe(1);
    const policy = handleAutonomyPolicy({}, deps);
    expect(autonomyPolicyRpc.output.parse(policy).missions?.[created.missionId]).toMatchObject({ level: 1, cells: { staffing: { mode: "owner" } } });
  });
});

describe("the Main is told of the owner's answer on its card (missions design §4.1)", () => {
  it("delivers a message to the mission's current Main when the owner applies or keeps an m: card", async () => {
    const fake = fakePaseo<MissionsPaseo>({
      agents: [{ id: MAIN, provider: "bm-manager", status: "idle", workspaceId: "wks-own", labels: { "bm.role": "manager" } }],
      workspaces: [{ id: WS, directory: "/repo/api" }, { id: "wks-own", directory: missionsHomeDirOf(home) }],
    });
    await ensureMissionsHome(fake.paseo, { home });
    const tools = createMissionTools({ paseo: () => fake.paseo, home: () => home, log, now: () => NOW });
    const created = mission();
    const who: ToolCaller = { agentId: MAIN, role: "manager", workspaceId: "wks-own", requestId: null, parentId: null, batchId: null, missionId: created.missionId };
    const cli = { find: () => "/bin/paseo", run: async () => ({ code: 0, output: "", timedOut: false }) };
    const open = async (goal: string) => JSON.parse((await tools.call("bm_mission_update", { goal }, who)).text).decisionId as string;

    const applied = await open("Ship v3");
    await handleDecisionsAnswer({ id: applied, optionKey: "apply" }, fake.paseo, { home, now: () => NOW, cli, log });
    const kept = await open("Ship v4");
    await handleDecisionsAnswer({ id: kept, optionKey: "keep" }, fake.paseo, { home, now: () => NOW, cli, log });
    // Both stored in the Main's workspace's outbox, from the owner; the first reached the idle Main at once (the second waits for its turn end).
    const records = createOutbox(home).list("wks-own");
    expect(records.map((record) => [record.kind, record.from, record.to, record.requestId])).toEqual([
      ["message", "owner", MAIN, applied],
      ["message", "owner", MAIN, kept],
    ]);
    expect(records[0]!.text).toContain(`The owner applied your card ${applied}: set its goal`);
    expect(records[1]!.text).toContain(`The owner kept the mission as it is on your card ${kept}.`);
    const told = fake.sends.filter((send) => send.id === MAIN).map((send) => send.text);
    expect(told[0]).toMatch(/^BM-DELIVERY message out-/);
    expect(told[0]).toContain(`The owner applied your card ${applied}`);
  });
});
