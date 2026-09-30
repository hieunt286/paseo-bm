import { describe, expect, it } from "vitest";
import { parseAnswers, parseQuestions, type Question } from "../plugin/shared/bm-questions";
import { decisionsAnswerRpc, decisionsListRpc } from "../plugin/shared/contracts";
import { decisionSchema, type Decision } from "../plugin/shared/decisions";
import type { Proposal } from "../plugin/shared/orchestrator";
import {
  answerableDecisions,
  chooseDecisionAnswer,
  chooseStoredDecisionAnswer,
  DECISIONS_ANSWER_RPC,
  DECISIONS_LIST_RPC,
  chooseWorkerAnswer,
  FOLLOW_RECOMMENDATION_WORDS,
  isOrchestratorMiss,
  NO_RECOMMENDATION_WORDS,
  ORCHESTRATOR_MISS_MS,
  SimulatedOwner,
  workerAnswersBlock,
  workerReplyText,
  type OrchestratorView,
  type OwnerTransport,
} from "../scripts/eval/owner";
import { OwnerSchema, type Owner } from "../scripts/eval/scenario";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const MINUTE = 60_000;

function owner(overrides: Owner["overrides"] = []): Owner {
  return OwnerSchema.parse({ policy: "recommended", overrides });
}

/** Records every send and call, and a clock the test moves. */
class FakeTransport implements OwnerTransport {
  clock = T0;
  sent: Array<{ agentId: string; text: string }> = [];
  calls: Array<{ method: string; input: unknown }> = [];
  state: OrchestratorView = { approvals: [], decisions: [] };
  /** What `decisions.list` returns: every stored decision, settled ones included (the fake does not filter). */
  stored: Decision[] = [];
  failRpc: string | null = null;

  async sendToAgent(agentId: string, text: string): Promise<void> {
    this.sent.push({ agentId, text });
  }

  async rpc(method: string, input: unknown): Promise<unknown> {
    this.calls.push({ method, input });
    if (this.failRpc !== null && method === this.failRpc) throw new Error("E_PROPOSAL_SETTLED");
    if (method === "orchestrator.state") return fullState(this.state);
    if (method === "decisions.list") return { decisions: this.stored, truncated: false };
    return {};
  }

  now(): number {
    return this.clock;
  }
}

function fullState(view: OrchestratorView): unknown {
  return {
    agent: null,
    toolsStale: false,
    outdated: false,
    watch: { enabled: false },
    approvals: view.approvals,
    stalls: [],
    projects: [],
    interventions: [],
    decisions: view.decisions,
  };
}

const QUESTIONS_TEXT = [
  "BM-QUESTIONS",
  "requestId: req-7",
  "Q6: Storage — where should results go?",
  "- a: A JSON file (recommended)",
  "- b: SQLite",
  "Q7: Push the branch to origin when done?",
  "- a: Yes",
  "- b: No, I will push myself (recommended)",
].join("\n");

function questions(): Question[] {
  return parseQuestions(QUESTIONS_TEXT)!.questions;
}

function proposal(fields: Partial<Proposal> & Pick<Proposal, "id" | "command">): Proposal {
  return {
    at: "2026-09-29T10:00:00.000Z",
    kind: "command",
    workspaceId: "ws-1",
    managerId: "mgr-1",
    requestId: "req-7",
    situation: "",
    reason: "",
    source: "orchestrator",
    status: "pending",
    settledAt: null,
    sentText: null,
    outcome: null,
    error: null,
    ...fields,
  };
}

describe("answer policy", () => {
  it("picks the recommended option", () => {
    const [q6, q7] = questions();
    expect(chooseWorkerAnswer(owner(), q6!)).toEqual({ pick: { key: "a" }, rule: "recommended", keyword: null, note: null });
    expect(chooseWorkerAnswer(owner(), q7!)).toEqual({ pick: { key: "b" }, rule: "recommended", keyword: null, note: null });
  });

  it("maps a keyword override to an option letter, case-insensitively", () => {
    const [, q7] = questions();
    const choice = chooseWorkerAnswer(owner([{ keyword: "PUSH", answer: { option: "A" } }]), q7!);
    expect(choice).toEqual({ pick: { key: "a" }, rule: "override", keyword: "PUSH", note: null });
  });

  it("maps a keyword override to the owner's own words", () => {
    const [q6, q7] = questions();
    const policy = owner([{ keyword: "push", answer: { words: "Yes, push it to origin now." } }]);
    expect(chooseWorkerAnswer(policy, q7!).pick).toEqual({ other: "Yes, push it to origin now." });
    // A question without the keyword keeps the recommended option.
    expect(chooseWorkerAnswer(policy, q6!).rule).toBe("recommended");
  });

  it("takes the first matching override", () => {
    const [, q7] = questions();
    const policy = owner([
      { keyword: "origin", answer: { option: "B" } },
      { keyword: "push", answer: { option: "A" } },
    ]);
    expect(chooseWorkerAnswer(policy, q7!)).toMatchObject({ pick: { key: "b" }, keyword: "origin" });
  });

  it("falls back to the recommended option, with a note, when an override letter names no option", () => {
    const [q6] = questions();
    const choice = chooseWorkerAnswer(owner([{ keyword: "storage", answer: { option: "D" } }]), q6!);
    expect(choice.pick).toEqual({ key: "a" });
    expect(choice.rule).toBe("recommended");
    expect(choice.note).toMatch(/option D/);
  });

  it("answers in fixed words when no single option is recommended", () => {
    const question: Question = { id: "Q1", text: "Name of the flag?", options: [] };
    expect(chooseWorkerAnswer(owner(), question)).toMatchObject({ pick: { other: NO_RECOMMENDATION_WORDS }, rule: "no-recommendation" });
  });

  it("answers a decision with the option its recommendation names, or by the override", () => {
    const decision = { command: "Release 1.2 now or wait?", reason: "Wait for the review: it is cheap.", options: ["Release now", "Wait for the review"] };
    expect(chooseDecisionAnswer(owner(), decision)).toMatchObject({ text: "Wait for the review", rule: "recommended" });
    expect(chooseDecisionAnswer(owner([{ keyword: "release", answer: { option: "A" } }]), decision)).toMatchObject({ text: "Release now", rule: "override" });
    expect(chooseDecisionAnswer(owner([{ keyword: "release", answer: { words: "Release it." } }]), decision).text).toBe("Release it.");
    expect(chooseDecisionAnswer(owner(), { command: "Push?", reason: "I would not.", options: undefined }).text).toBe(FOLLOW_RECOMMENDATION_WORDS);
    // Whole words only: "No" is not in "I know".
    expect(chooseDecisionAnswer(owner(), { command: "Push?", reason: "I know it is safe.", options: ["Yes", "No"] }).text).toBe(FOLLOW_RECOMMENDATION_WORDS);
    expect(chooseDecisionAnswer(owner(), { command: "Push?", reason: "No: wait for CI.", options: ["Yes", "No"] }).text).toBe("No");
  });
});

describe("BM-ANSWERS text", () => {
  it("is exactly the block of manager.md, headed as the card's Reply box sends it", () => {
    const qs = questions();
    const policy = owner([{ keyword: "push", answer: { words: "Yes, push it to origin now." } }]);
    const choices = new Map(qs.map((q) => [q.id, chooseWorkerAnswer(policy, q)] as const));
    const block = workerAnswersBlock("req-7", qs, choices);
    expect(block).toBe(["BM-ANSWERS", "requestId: req-7", "Q6: a — A JSON file", "Q7: other — Yes, push it to origin now."].join("\n"));

    const message = workerReplyText("req-7", block);
    expect(message).toBe(`Reply from the user about \`req-7\`:\n\n${block}`);
    expect(parseAnswers(message)).toEqual({
      requestId: "req-7",
      answers: [
        { id: "Q6", text: "a — A JSON file" },
        { id: "Q7", text: "other — Yes, push it to origin now." },
      ],
    });
  });
});

describe("miss rule", () => {
  it("is ten minutes from when the question was first seen", () => {
    expect(ORCHESTRATOR_MISS_MS).toBe(10 * MINUTE);
    expect(isOrchestratorMiss(T0, T0 + 10 * MINUTE - 1)).toBe(false);
    expect(isOrchestratorMiss(T0, T0 + 10 * MINUTE)).toBe(true);
  });
});

describe("channel 0.4.1", () => {
  it("sends one BM-ANSWERS message to the waiting Worker, once, and counts it", async () => {
    const transport = new FakeTransport();
    const sim = new SimulatedOwner({ owner: owner(), channel: "0.4.1", transport });
    const open = { workerId: "wrk-1", requestId: "req-7", questions: questions(), firstSeenAt: T0 };

    const first = await sim.step({ workerQuestions: [open] });
    expect(first.status).toBe("acted");
    expect(transport.sent).toEqual([
      { agentId: "wrk-1", text: "Reply from the user about `req-7`:\n\nBM-ANSWERS\nrequestId: req-7\nQ6: a — A JSON file\nQ7: b — No, I will push myself" },
    ]);
    expect(transport.calls).toEqual([]);

    // The driver still sees the same questions until the Worker reports: nothing more is sent.
    expect((await sim.step({ workerQuestions: [open] })).status).toBe("idle");
    expect(transport.sent).toHaveLength(1);

    expect(sim.counts).toEqual({ messages: 1, rpcCalls: 0, confirmations: 0, actions: 1, misses: 0 });
    expect(sim.log[0]).toMatchObject({
      channel: "0.4.1",
      source: "worker-questions",
      target: { agentId: "wrk-1" },
      requestId: "req-7",
      actions: 1,
      error: null,
      at: "2026-09-29T10:00:00.000Z",
    });
    expect(sim.log[0]!.items.map((item) => [item.id, item.answer, item.rule])).toEqual([
      ["Q6", "a — A JSON file", "recommended"],
      ["Q7", "b — No, I will push myself", "recommended"],
    ]);
    expect(sim.ownerActionsPerDecision()).toEqual([1]);
  });

  it("answers only the new question of a set that grew", async () => {
    const transport = new FakeTransport();
    const sim = new SimulatedOwner({ owner: owner(), channel: "0.4.1", transport });
    const [q6, q7] = questions();
    await sim.step({ workerQuestions: [{ workerId: "wrk-1", requestId: "req-7", questions: [q6!], firstSeenAt: T0 }] });
    await sim.step({ workerQuestions: [{ workerId: "wrk-1", requestId: "req-7", questions: [q6!, q7!], firstSeenAt: T0 }] });
    expect(transport.sent.map((m) => parseAnswers(m.text)!.answers.map((a) => a.id))).toEqual([["Q6"], ["Q7"]]);
    expect(sim.counts.actions).toBe(2);
  });

  it("logs, without sending, questions that carry no requestId", async () => {
    const transport = new FakeTransport();
    const sim = new SimulatedOwner({ owner: owner(), channel: "0.4.1", transport });
    const open = { workerId: "wrk-1", requestId: null, questions: questions(), firstSeenAt: T0 };
    await sim.step({ workerQuestions: [open] });
    await sim.step({ workerQuestions: [open] });
    expect(transport.sent).toEqual([]);
    expect(sim.log).toHaveLength(1);
    expect(sim.log[0]).toMatchObject({ actions: 0, error: expect.stringMatching(/requestId/) });
    expect(sim.counts.actions).toBe(0);
    expect(sim.ownerActionsPerDecision()).toEqual([]);
  });
});

describe("channel tree-autopilot", () => {
  const decision = proposal({
    id: "dec-1",
    kind: "decision",
    managerId: null,
    command: "Push the branch to origin?",
    reason: "Yes, push: the owner asked for it.",
    source: "autopilot",
    options: ["Yes, push", "No"],
  });
  const command = proposal({ id: "prop-1", command: "Continue req-7 with option a.", at: "2026-09-29T10:01:00.000Z" });
  const settled = proposal({ id: "prop-0", command: "Old.", status: "sent" });

  it("answers a pending decision and approves a pending proposal, and leaves a fresh Worker question alone", async () => {
    const transport = new FakeTransport();
    transport.state = { approvals: [command, decision, settled], decisions: [decision] };
    const sim = new SimulatedOwner({ owner: owner(), channel: "tree-autopilot", transport });
    const open = { workerId: "wrk-1", requestId: "req-7", questions: questions(), firstSeenAt: T0 };

    transport.clock = T0 + 5 * MINUTE;
    const result = await sim.step({ workerQuestions: [open] });
    expect(result.status).toBe("acted");
    expect(transport.calls).toEqual([
      { method: "orchestrator.state", input: {} },
      { method: "orchestrator.ask", input: { decisionId: "dec-1", text: "Yes, push" } },
      { method: "orchestrator.approve", input: { proposalId: "prop-1", text: "Continue req-7 with option a.", confirmed: true } },
    ]);
    expect(transport.sent).toEqual([]);
    expect(sim.log.map((entry) => entry.source)).toEqual(["orchestrator-decision", "orchestrator-proposal"]);
    expect(sim.counts).toEqual({ messages: 0, rpcCalls: 2, confirmations: 0, actions: 2, misses: 0 });

    // Seen again (the state not yet refreshed): not answered twice.
    await sim.step({ workerQuestions: [open] });
    expect(transport.calls.filter((call) => call.method !== "orchestrator.state")).toHaveLength(2);
  });

  it("uses the state the driver passes, without reading it again", async () => {
    const transport = new FakeTransport();
    const sim = new SimulatedOwner({ owner: owner(), channel: "tree-autopilot", transport });
    await sim.step({ orchestratorState: { approvals: [decision], decisions: [decision] } });
    expect(transport.calls.map((call) => call.method)).toEqual(["orchestrator.ask"]);
  });

  it("answers a Worker question after ten simulated minutes, as 0.4.1 does, and logs an Orchestrator miss", async () => {
    const transport = new FakeTransport();
    const sim = new SimulatedOwner({ owner: owner(), channel: "tree-autopilot", transport });
    const open = { workerId: "wrk-1", requestId: "req-7", questions: questions(), firstSeenAt: T0 };

    transport.clock = T0 + 10 * MINUTE - 1;
    expect((await sim.step({ workerQuestions: [open] })).status).toBe("idle");
    expect(transport.sent).toEqual([]);

    transport.clock = T0 + 10 * MINUTE;
    const result = await sim.step({ workerQuestions: [open] });
    expect(result.status).toBe("acted");
    expect(transport.sent).toEqual([
      { agentId: "wrk-1", text: "Reply from the user about `req-7`:\n\nBM-ANSWERS\nrequestId: req-7\nQ6: a — A JSON file\nQ7: b — No, I will push myself" },
    ]);
    expect(sim.log[0]).toMatchObject({ source: "orchestrator-miss", channel: "tree-autopilot", at: "2026-09-29T10:10:00.000Z" });
    expect(sim.counts).toEqual({ messages: 1, rpcCalls: 0, confirmations: 0, actions: 1, misses: 1 });

    transport.clock = T0 + 20 * MINUTE;
    await sim.step({ workerQuestions: [open] });
    expect(transport.sent).toHaveLength(1);
  });

  it("logs a failed answer once and does not try it again", async () => {
    const transport = new FakeTransport();
    transport.failRpc = "orchestrator.ask";
    const sim = new SimulatedOwner({ owner: owner(), channel: "tree-autopilot", transport });
    await sim.step({ orchestratorState: { approvals: [decision] } });
    await sim.step({ orchestratorState: { approvals: [decision] } });
    expect(transport.calls.filter((call) => call.method === "orchestrator.ask")).toHaveLength(1);
    expect(sim.log[0]!.error).toBe("E_PROPOSAL_SETTLED");
    expect(sim.counts.actions).toBe(1);
    expect(sim.ownerActionsPerDecision()).toEqual([]);
  });
});

describe("permission requests", () => {
  it.each(["0.4.1", "tree-autopilot", "decision-rpc"] as const)("are never answered, and stop the owner (%s)", async (channel) => {
    const transport = new FakeTransport();
    transport.state = { approvals: [proposal({ id: "prop-1", command: "Go on." })] };
    transport.stored = [stored({ id: "q:req-7:Q6" })];
    const sim = new SimulatedOwner({ owner: owner(), channel, transport });
    const open = { workerId: "wrk-1", requestId: "req-7", questions: questions(), firstSeenAt: T0 - 60 * MINUTE };

    const result = await sim.step({ workerQuestions: [open], permissions: [{ agentId: "wrk-1", title: "Bash: git push" }] });
    expect(result).toEqual({
      status: "needed-a-human",
      neededHuman: { at: "2026-09-29T10:00:00.000Z", permissions: [{ agentId: "wrk-1", title: "Bash: git push" }] },
      entries: [],
    });
    // Nothing at all was done, now or later, even once the request is gone.
    const later = await sim.step({ workerQuestions: [open] });
    expect(later.status).toBe("needed-a-human");
    expect(transport.sent).toEqual([]);
    expect(transport.calls).toEqual([]);
    expect(sim.counts).toEqual({ messages: 0, rpcCalls: 0, confirmations: 0, actions: 0, misses: 0 });
    expect(sim.neededHuman).not.toBeNull();
  });
});

describe("channels", () => {
  it("implements every channel name", () => {
    for (const channel of ["0.4.1", "tree-autopilot", "decision-rpc"] as const) {
      expect(new SimulatedOwner({ owner: owner(), channel, transport: new FakeTransport() }).channel).toBe(channel);
    }
  });
});

/** A stored Worker question (`q:`), open, with the storage options of `QUESTIONS_TEXT`; fields override. */
function stored(fields: Partial<Decision> & Pick<Decision, "id">): Decision {
  return decisionSchema.parse({
    workspaceId: "ws-1",
    requestId: "req-7",
    askedBy: { role: "worker", agentId: "wrk-1" },
    askedAt: "2026-09-29T10:00:00.000Z",
    round: 1,
    question: "Storage — where should results go?",
    subject: null,
    options: [
      { key: "a", label: "A JSON file", recommended: true, effects: ["none"] },
      { key: "b", label: "SQLite", recommended: false, effects: ["dependency-install"] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    ...fields,
  });
}

const PUSH_OPTIONS: Decision["options"] = [
  { key: "a", label: "Yes, push to origin", recommended: false, effects: ["push"] },
  { key: "b", label: "No, keep it local", recommended: true, effects: ["none"] },
];

describe("stored decision policy", () => {
  it("picks the recommended option, with nothing to confirm", () => {
    expect(chooseStoredDecisionAnswer(owner(), stored({ id: "q:req-7:Q1" }))).toEqual({
      optionKey: "a",
      words: null,
      rule: "recommended",
      keyword: null,
      note: null,
      effects: [],
      confirmed: false,
    });
  });

  it("maps an override letter to the option of that key, and needs confirmation for a push", () => {
    const decision = stored({ id: "q:req-7:Q2", question: "Push the branch to origin?", options: PUSH_OPTIONS });
    const choice = chooseStoredDecisionAnswer(owner([{ keyword: "PUSH", answer: { option: "A" } }]), decision);
    expect(choice).toMatchObject({ optionKey: "a", words: null, rule: "override", keyword: "PUSH", effects: ["push"], confirmed: true });
  });

  it("answers an override in words, which grants every declared effect", () => {
    const decision = stored({ id: "q:req-7:Q2", question: "Push the branch to origin?", options: PUSH_OPTIONS });
    const choice = chooseStoredDecisionAnswer(owner([{ keyword: "push", answer: { words: "Yes, push it to origin now." } }]), decision);
    expect(choice).toMatchObject({ optionKey: null, words: "Yes, push it to origin now.", rule: "override", effects: ["push"], confirmed: true });
  });

  it("maps an override letter to the option at that position when no key matches, with a note when there is none", () => {
    const decision = stored({
      id: "f:inc-1",
      requestId: null,
      askedBy: { role: "plugin", agentId: null },
      round: null,
      question: "The Worker hit its usage limit.",
      options: [
        { key: "switch", label: "Switch to the fallback provider", recommended: false, effects: ["cost"] },
        { key: "wait", label: "Wait", recommended: true, effects: ["none"] },
      ],
    });
    expect(chooseStoredDecisionAnswer(owner([{ keyword: "usage", answer: { option: "A" } }]), decision)).toMatchObject({ optionKey: "switch", confirmed: true });
    expect(chooseStoredDecisionAnswer(owner(), decision)).toMatchObject({ optionKey: "wait", confirmed: false });
    const missing = chooseStoredDecisionAnswer(owner([{ keyword: "usage", answer: { option: "D" } }]), decision);
    expect(missing).toMatchObject({ optionKey: "wait", rule: "recommended" });
    expect(missing.note).toMatch(/option D/);
  });

  it("follows the Recommendation line of an Orchestrator decision, else answers in fixed words", () => {
    const base = { askedBy: { role: "orchestrator" as const, agentId: "orc-1" }, round: null };
    const options: Decision["options"] = [
      { key: "a", label: "Release now", recommended: false, effects: ["publish"] },
      { key: "b", label: "Wait for the review", recommended: false, effects: ["none"] },
    ];
    const named = stored({ ...base, id: "o:1", question: "Release 1.2 now or wait?\n\nRecommendation: Wait for the review: it is cheap.", options });
    expect(chooseStoredDecisionAnswer(owner(), named)).toMatchObject({ optionKey: "b", rule: "recommended", confirmed: false });
    const vague = stored({ ...base, id: "o:2", question: "Release 1.2 now or wait?\n\nRecommendation: I would hold.", options });
    // Own words grant every declared effect, here a publish: confirmed.
    expect(chooseStoredDecisionAnswer(owner(), vague)).toMatchObject({ optionKey: null, words: FOLLOW_RECOMMENDATION_WORDS, effects: ["publish"], confirmed: true });
    const none = stored({ id: "q:req-7:Q3", question: "Name of the flag?", options: [] });
    expect(chooseStoredDecisionAnswer(owner(), none)).toMatchObject({ optionKey: null, words: NO_RECOMMENDATION_WORDS, rule: "no-recommendation", confirmed: false });
  });

  it("keeps only answerable decisions, oldest asked first, each once, skipping what does not parse", () => {
    const newer = stored({ id: "q:req-7:Q2", askedAt: "2026-09-29T10:05:00.000Z" });
    const older = stored({
      id: "q:req-7:Q1",
      askedAt: "2026-09-29T10:01:00.000Z",
      status: "needs-confirmation",
      needsConfirmation: { via: "chat-worker", at: "2026-09-29T10:02:00.000Z" },
    });
    const answered = stored({
      id: "q:req-7:Q3",
      status: "answered",
      settledAt: "2026-09-29T10:03:00.000Z",
      answer: { by: "owner", via: "inbox", optionKey: "a", words: null, at: "2026-09-29T10:03:00.000Z" },
    });
    const superseded = stored({ id: "q:req-7:Q4", status: "superseded", settledAt: "2026-09-29T10:03:00.000Z", supersededBy: "q:req-7:Q2" });
    const listed = { decisions: [newer, answered, older, superseded, newer, { id: "junk" }], truncated: false };
    expect(answerableDecisions(listed).map((decision) => decision.id)).toEqual(["q:req-7:Q1", "q:req-7:Q2"]);
    expect(answerableDecisions(null)).toEqual([]);
  });
});

describe("channel decision-rpc", () => {
  const RETIRED = ["chat.waiting", "orchestrator.state", "orchestrator.ask", "orchestrator.approve", "orchestrator.dismiss", "orchestrator.command", "answers.mark", "answers.marks"];

  it("calls the plugin's decision RPCs by their contract names", () => {
    expect(DECISIONS_LIST_RPC).toBe(decisionsListRpc.name);
    expect(DECISIONS_ANSWER_RPC).toBe(decisionsAnswerRpc.name);
  });

  it("reads the Inbox, answers each open decision once by the policy, and sends no message", async () => {
    const transport = new FakeTransport();
    transport.stored = [
      stored({ id: "q:req-7:Q7", question: "Push the branch to origin when done?", options: PUSH_OPTIONS, askedAt: "2026-09-29T10:02:00.000Z" }),
      stored({ id: "q:req-7:Q6", askedAt: "2026-09-29T10:01:00.000Z" }),
    ];
    const sim = new SimulatedOwner({ owner: owner(), channel: "decision-rpc", transport });
    const open = { workerId: "wrk-1", requestId: "req-7", questions: questions(), firstSeenAt: T0 - 60 * MINUTE };

    const result = await sim.step({ workspaceId: "ws-1", workerQuestions: [open] });
    expect(result.status).toBe("acted");
    expect(transport.calls).toEqual([
      { method: "decisions.list", input: { scope: "inbox", workspaceId: "ws-1" } },
      { method: "decisions.answer", input: { id: "q:req-7:Q6", optionKey: "a", via: "inbox" } },
      { method: "decisions.answer", input: { id: "q:req-7:Q7", optionKey: "b", via: "inbox" } },
    ]);
    expect(decisionsListRpc.input.safeParse(transport.calls[0]!.input).success).toBe(true);
    for (const call of transport.calls.slice(1)) expect(decisionsAnswerRpc.input.parse(call.input)).toEqual(call.input);
    // Worker questions are the Inbox's now: never answered by a message.
    expect(transport.sent).toEqual([]);
    expect(sim.log.map((entry) => [entry.source, entry.target, entry.items[0]!.answer, entry.actions, entry.channel])).toEqual([
      ["decision", { rpc: "decisions.answer" }, "a — A JSON file", 1, "decision-rpc"],
      ["decision", { rpc: "decisions.answer" }, "b — No, keep it local", 1, "decision-rpc"],
    ]);
    expect(sim.counts).toEqual({ messages: 0, rpcCalls: 2, confirmations: 0, actions: 2, misses: 0 });
    expect(sim.ownerActionsPerDecision()).toEqual([1, 1]);

    // Still listed (the store not re-read yet): not answered twice.
    expect((await sim.step({ workspaceId: "ws-1" })).status).toBe("idle");
    expect(transport.calls.filter((call) => call.method === "decisions.answer")).toHaveLength(2);
  });

  it("confirms only an answer whose effects need it, and counts the confirmation tap as one more action", async () => {
    const transport = new FakeTransport();
    const push = stored({ id: "q:req-7:Q7", question: "Push the branch to origin when done?", options: PUSH_OPTIONS });
    const plain = stored({ id: "q:req-7:Q6", askedAt: "2026-09-29T09:59:00.000Z" });
    const policy = owner([{ keyword: "push", answer: { words: "Yes, push it to origin now." } }]);
    const sim = new SimulatedOwner({ owner: policy, channel: "decision-rpc", transport });

    await sim.step({ decisions: [push, plain] });
    expect(transport.calls).toEqual([
      { method: "decisions.answer", input: { id: "q:req-7:Q6", optionKey: "a", via: "inbox" } },
      { method: "decisions.answer", input: { id: "q:req-7:Q7", words: "Yes, push it to origin now.", via: "inbox", confirmed: true } },
    ]);
    for (const call of transport.calls) expect(decisionsAnswerRpc.input.parse(call.input)).toEqual(call.input);
    expect(sim.log[1]).toMatchObject({
      confirmed: true,
      actions: 1,
      text: "Yes, push it to origin now.",
      items: [{ question: "Push the branch to origin when done?", rule: "override", keyword: "push" }],
    });
    expect(sim.log[0]!.confirmed).toBeUndefined();
    expect(sim.counts).toEqual({ messages: 0, rpcCalls: 2, confirmations: 1, actions: 3, misses: 0 });
    expect(sim.ownerActionsPerDecision()).toEqual([1, 2]);
  });

  it("never answers a settled or superseded decision, nor one of another workspace", async () => {
    const transport = new FakeTransport();
    transport.stored = [
      stored({
        id: "q:req-7:Q1",
        status: "answered",
        settledAt: "2026-09-29T10:03:00.000Z",
        answer: { by: "owner", via: "chat-manager", optionKey: "b", words: null, at: "2026-09-29T10:03:00.000Z" },
      }),
      stored({ id: "q:req-7:Q2", status: "superseded", settledAt: "2026-09-29T10:03:00.000Z", supersededBy: "q:req-7:Q3" }),
      stored({ id: "q:req-7:Q4", status: "withdrawn", settledAt: "2026-09-29T10:03:00.000Z" }),
      stored({ id: "q:req-7:Q5", status: "expired", settledAt: "2026-09-29T10:03:00.000Z" }),
      stored({ id: "q:req-9:Q1", workspaceId: "ws-2", requestId: "req-9" }),
    ];
    const sim = new SimulatedOwner({ owner: owner(), channel: "decision-rpc", transport });
    expect((await sim.step({ workspaceId: "ws-1" })).status).toBe("idle");
    expect(transport.calls.map((call) => call.method)).toEqual(["decisions.list"]);
    expect(sim.counts.actions).toBe(0);
    expect(sim.log).toEqual([]);
  });

  it("answers a decision once even when it is listed as open again", async () => {
    const transport = new FakeTransport();
    const sim = new SimulatedOwner({ owner: owner(), channel: "decision-rpc", transport });
    const decision = stored({ id: "q:req-7:Q6" });
    await sim.step({ decisions: [decision] });
    await sim.step({ decisions: [{ ...decision }] });
    expect(transport.calls).toHaveLength(1);
  });

  it("logs a refused answer (settled meanwhile) once and does not try it again", async () => {
    const transport = new FakeTransport();
    transport.failRpc = "decisions.answer";
    const sim = new SimulatedOwner({ owner: owner(), channel: "decision-rpc", transport });
    const decision = stored({ id: "q:req-7:Q6" });
    await sim.step({ decisions: [decision] });
    await sim.step({ decisions: [decision] });
    expect(transport.calls).toHaveLength(1);
    expect(sim.log[0]!.error).toBe("E_PROPOSAL_SETTLED");
    expect(sim.ownerActionsPerDecision()).toEqual([]);
  });

  it("never calls a retired RPC or sends a message, whatever it is shown", async () => {
    const transport = new FakeTransport();
    transport.state = { approvals: [proposal({ id: "prop-1", command: "Go on." })], decisions: [] };
    transport.stored = [stored({ id: "q:req-7:Q6" })];
    const sim = new SimulatedOwner({ owner: owner(), channel: "decision-rpc", transport });
    const open = { workerId: "wrk-1", requestId: "req-7", questions: questions(), firstSeenAt: T0 - 60 * MINUTE };
    await sim.step({ workerQuestions: [open], orchestratorState: transport.state });
    transport.clock = T0 + 60 * MINUTE;
    await sim.step({ workerQuestions: [open] });
    expect(transport.calls.map((call) => call.method)).toEqual(["decisions.list", "decisions.answer", "decisions.list"]);
    expect(transport.calls.some((call) => RETIRED.includes(call.method))).toBe(false);
    expect(transport.sent).toEqual([]);
  });
});
