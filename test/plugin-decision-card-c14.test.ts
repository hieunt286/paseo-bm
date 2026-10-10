import { describe, expect, it, vi } from "vitest";
import { pressables, renderTree, texts, type RNode } from "./helpers/element-tree";
import { makeDecision } from "./helpers/decisions";
import { decisionCardOf } from "../plugin/client/chat-card-parse";
import {
  ASK_NOT_DELIVERED,
  ASK_UI_IDLE,
  DECISION_POLL_MS,
  DECISION_UI_IDLE,
  RECOMMENDED_MARK,
  SUGGESTS_MARKS,
  decisionCardView,
  runDecisionAsk,
  threadPollMs,
  type AskUi,
  type DecisionUi,
} from "../plugin/client/chat-card-decision";
import { decidedByWords, seedOf } from "../plugin/client/inbox-model";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import type { DecisionThread } from "../plugin/shared/decision-threads";

/**
 * Change-014 on the decision card (outcomes 2 and 3, ADR-025): the
 * proposal as the primary option at Co-pilot and up — the request's Main's
 * (missions design §8), else an older record's Orchestrator's; Ask back
 * with its conversation on a Worker's question or an Orchestrator's decision;
 * and "decided for you by the Orchestrator" for an answer made on the policy.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const cardPath = "../plugin/client/chat-card.tsx";
const { DecisionCardBody, decisionThreadQueryKey, decisionQueryKey } = (await import(cardPath)) as {
  DecisionCardBody: (props: Record<string, unknown>) => unknown;
  decisionThreadQueryKey: (id: string) => readonly unknown[];
  decisionQueryKey: (id: string) => readonly unknown[];
};

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;
const AT = new Date("2026-09-29T07:40:00.000Z");
const NOW = new Date("2026-09-29T07:45:00.000Z");
const O_ID = "o:3f1c2b9a-0d4e-4c55-9f00-1234567890ab";

/** An open Worker question the Orchestrator predicted `c` for on an older record (`bm_predict`, retired; Hold; the recommended option is `a`). */
function predicted(optionKey = "c", overrides: Partial<Decision> = {}): Decision {
  return makeDecision({
    prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey, reason: "Hold until the contract tests pass.", at: "2026-09-29T07:41:00.000Z" } },
    ...overrides,
  });
}

function view(decision: Decision, extra: { ui?: DecisionUi; thread?: DecisionThread | null; ask?: AskUi } = {}) {
  return decisionCardView({
    card: decisionCardOf(seedOf(decision), decision.requestId),
    lookup: { state: "found", decision },
    agents: [],
    ui: extra.ui ?? DECISION_UI_IDLE,
    cardAt: AT,
    now: NOW,
    thread: extra.thread ?? null,
    ...(extra.ask === undefined ? {} : { ask: extra.ask }),
  });
}

function draw(shown: ReturnType<typeof view>, handlers: Record<string, unknown> = {}): Array<RNode | string> {
  return renderTree(
    DecisionCardBody({
      view: shown,
      ui: DECISION_UI_IDLE,
      detailsOpen: false,
      onToggleDetails: noop,
      onChoose: noop,
      onOpenWords: noop,
      onWords: noop,
      onSendWords: noop,
      onCancel: noop,
      onConfirm: noop,
      onCloseInChat: noop,
      text: "",
      styles,
      theme,
      compact: false,
      ...handlers,
    }),
  );
}
const labels = (nodes: Array<RNode | string>) => pressables(nodes).map((node) => node.props["accessibilityLabel"]);
const askHandlers = () => ({ open: vi.fn(), text: vi.fn(), cancel: vi.fn(), send: vi.fn() });

function thread(id: string, ...entries: Array<["owner" | "asker", string]>): DecisionThread {
  return { decisionId: id, entries: entries.map(([by, text], index) => ({ by, text, at: `2026-09-29T07:4${index + 1}:00.000Z` })) };
}

describe("the proposal on the card (change-014 outcome 2)", () => {
  it("shows a Main's prediction as \"Main suggests\", before an older Orchestrator one; an old Orchestrator one alone still reads \"Orchestrator suggests\"", () => {
    expect(SUGGESTS_MARKS).toEqual({ main: "Main suggests", orchestrator: "Orchestrator suggests" });
    const mainPrediction = { optionKey: "c", reason: "Hold: the mission's contract lands first.", at: "2026-09-29T07:42:00.000Z" };
    const byMain = view(makeDecision({ prediction: { recommended: { optionKey: "a" }, orchestrator: null, main: mainPrediction } }));
    expect(byMain.options.map(({ key, mark, primary }) => ({ key, mark, primary }))).toEqual([
      { key: "a", mark: RECOMMENDED_MARK, primary: false },
      { key: "b", mark: null, primary: false },
      { key: "c", mark: "Main suggests", primary: true },
    ]);
    expect(byMain.options[2]!.accessibilityLabel).toBe("Answer: Hold (the Main suggests it)");
    expect(byMain.proposal).toBe("Main: Hold: the mission's contract lands first.");
    expect(byMain.details).toContain("Main suggests: c at 2026-09-29T07:42:00.000Z");
    expect(byMain.details.some((line) => line.startsWith("Orchestrator suggests"))).toBe(false);
    expect(texts(draw(byMain))).toEqual(expect.arrayContaining(["Main suggests", "Main: Hold: the mission's contract lands first."]));

    // Both stored: the Main's is the proposal; the Orchestrator's older one is not shown beside it.
    const both = view(predicted("a", { prediction: { recommended: { optionKey: "a" }, orchestrator: { optionKey: "a", reason: "Push it.", at: "2026-09-29T07:41:00.000Z" }, main: mainPrediction } }));
    expect(both.options.find((option) => option.primary)).toMatchObject({ key: "c", mark: "Main suggests" });
    expect(both.options[0]!.mark).toBe(RECOMMENDED_MARK);
    expect(both.proposal).toBe("Main: Hold: the mission's contract lands first.");

    // An old record with the Orchestrator's prediction only.
    const old = view(predicted());
    expect(old.options[2]).toMatchObject({ mark: "Orchestrator suggests", primary: true, accessibilityLabel: "Answer: Hold (the Orchestrator suggests it)" });
    expect(old.proposal).toBe("Orchestrator: Hold until the contract tests pass.");
    expect(old.details).toContain("Orchestrator suggests: c at 2026-09-29T07:41:00.000Z");
  });


  it("makes the suggested option the primary one, marked, with its reason under the options; the recommended keeps its mark as secondary", () => {
    const shown = view(predicted());
    expect(shown.options.map(({ key, label, mark, primary }) => ({ key, label, mark, primary }))).toEqual([
      { key: "a", label: "Push contract only", mark: RECOMMENDED_MARK, primary: false },
      { key: "b", label: "Push both and publish", mark: null, primary: false },
      { key: "c", label: "Hold", mark: SUGGESTS_MARKS.orchestrator, primary: true },
    ]);
    expect(shown.options[2]!.accessibilityLabel).toBe("Answer: Hold (the Orchestrator suggests it)");
    expect(shown.options[0]!.accessibilityLabel).toBe("Answer: Push contract only (recommended); allows push");
    expect(shown.proposal).toBe("Orchestrator: Hold until the contract tests pass.");
    expect(shown.details).toContain("Orchestrator suggests: c at 2026-09-29T07:41:00.000Z");
    const nodes = draw(shown);
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Hold", "Orchestrator suggests", "Push contract only", "Recommended", "Orchestrator: Hold until the contract tests pass."]));
  });

  it("marks both on one button when the Orchestrator suggests the recommended option", () => {
    const shown = view(predicted("a"));
    expect(shown.options[0]).toMatchObject({ label: "Push contract only", mark: `${SUGGESTS_MARKS.orchestrator} · ${RECOMMENDED_MARK}`, primary: true, accessibilityLabel: "Answer: Push contract only (the Orchestrator suggests it; recommended); allows push" });
    expect(shown.options.filter((option) => option.primary)).toHaveLength(1);
  });

  it("keeps the X-4 confirmation for a suggested option with a confirm effect, and hides the reason with the options", () => {
    const shown = view(predicted("b"));
    expect(shown.options[1]).toMatchObject({ primary: true, confirm: true });
    const confirming = view(predicted("b"), { ui: { ...DECISION_UI_IDLE, confirming: "b" } });
    expect(confirming.confirm).toMatchObject({ title: "Answer: Push both and publish?", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(confirming).toMatchObject({ options: [], proposal: null });
  });

  it("shows no proposal without a prediction, for an option that is not on the card, or once settled — the recommended option is primary again", () => {
    expect(view(makeDecision()).proposal).toBeNull();
    expect(view(makeDecision()).options[0]!.primary).toBe(true);
    const stray = predicted("z" as string);
    expect(view(stray).proposal).toBeNull();
    expect(view(stray).options[0]!.primary).toBe(true);
    const answered = answerDecision(predicted(), { via: "inbox", optionKey: "c", at: "2026-09-29T07:44:00.000Z" });
    if (!answered.ok) throw new Error(answered.message);
    expect(view(answered.decision)).toMatchObject({ options: [], proposal: null });
  });
});

describe("Ask back on the card (change-014 outcome 3)", () => {
  it("offers Ask back beside Own words… on an open Worker question and an Orchestrator's decision, never on held, fallback or override ones", () => {
    const q = view(makeDecision());
    expect(q.askBack).toMatchObject({ offered: true, box: null, conversation: [], status: null, accessibilityLabel: "Ask the Worker a question before you decide" });
    const nodes = draw(q, { onAsk: askHandlers() });
    expect(labels(nodes)).toEqual([
      "Answer: Push contract only (recommended); allows push",
      "Answer: Push both and publish; allows push, publish",
      "Answer: Hold",
      "Ask the Worker a question before you decide",
      "Answer in your own words",
      "Show details",
    ]);
    expect(view(makeDecision({ id: O_ID, askedBy: { role: "orchestrator", agentId: "orch-1" }, requestId: null, round: null })).askBack?.accessibilityLabel).toBe(
      "Ask the Orchestrator a question before you decide",
    );
    for (const id of ["h:agent-worker:perm-1", "f:fb-000000000d02", "r:5b1e"]) expect(view(makeDecision({ id })).askBack).toBeNull();
  });

  it("a held action carries the danger bar and its kind label; a Worker's open question the warning ones; a settled one neither colour", () => {
    expect(view(makeDecision({ id: "h:agent-worker:perm-1" })).frame).toMatchObject({ bar: "danger", label: { tone: "danger" }, icon: "Lock" });
    expect(view(makeDecision({ id: "h:agent-worker:perm-1" })).frame.label?.text).toMatch(/^HELD ACTION · [A-Z]+$/);
    expect(view(makeDecision()).frame).toMatchObject({ bar: "warning", chip: null, recipient: null });
    expect(view(makeDecision()).frame.label?.text).toMatch(/^DECISION · [A-Z]+$/);
    const answered = answerDecision(makeDecision(), { via: "inbox", optionKey: "c", at: "2026-09-29T07:44:00.000Z" });
    if (!answered.ok) throw new Error(answered.message);
    expect(view(answered.decision).frame.bar).toBeUndefined();
    expect(view(answered.decision).frame.label?.tone).toBe("muted");
  });

  it("draws no Ask back without its handlers (a card drawn read-only)", () => {
    expect(texts(draw(view(makeDecision())))).not.toContain("Ask back");
  });

  it("opens a one-line box with Send then Cancel (the mockup's order); Send is enabled only with text; the options stay usable", () => {
    const on = askHandlers();
    const onChoose = vi.fn();
    const empty = view(makeDecision(), { ask: { ...ASK_UI_IDLE, text: "" } });
    expect(empty.askBack).toMatchObject({ offered: false, box: { label: "Ask the Worker", placeholder: "Ask the Worker before you decide…", busy: false, sendEnabled: false } });
    expect(empty.options).toHaveLength(3);
    const written = view(makeDecision(), { ask: { ...ASK_UI_IDLE, text: "Which tests?" } });
    const nodes = draw(written, { onAsk: on, askText: "Which tests?", onChoose });
    const all = labels(nodes);
    expect(all.indexOf("Send your question to the Worker")).toBeLessThan(all.indexOf("Cancel the question"));
    expect(all).not.toContain("Ask the Worker a question before you decide");
    const send = pressables(nodes).find((node) => node.props["accessibilityLabel"] === "Send your question to the Worker")!;
    expect(send.props["disabled"]).toBe(false);
    (send.props["onPress"] as () => void)();
    expect(on.send).toHaveBeenCalledOnce();
    const hold = pressables(nodes).find((node) => node.props["accessibilityLabel"] === "Answer: Hold")!;
    (hold.props["onPress"] as () => void)();
    expect(onChoose).toHaveBeenCalledWith("c");
  });

  it("shows the conversation oldest first, then waits for the asker after the owner's last entry", () => {
    const decision = makeDecision();
    const asked = thread(decision.id, ["owner", "How long does the push take?"], ["asker", "About a minute."], ["owner", "And the publish?"]);
    const shown = view(decision, { thread: asked });
    expect(shown.askBack?.conversation.map(({ who, text }) => [who, text])).toEqual([
      ["You", "How long does the push take?"],
      ["Worker", "About a minute."],
      ["You", "And the publish?"],
    ]);
    expect(shown.askBack?.status).toEqual({ text: "Waiting for the Worker…", tone: "muted" });
    const nodes = draw(shown, { onAsk: askHandlers() });
    const shownTexts = texts(nodes);
    expect(shownTexts.indexOf("Conversation")).toBeGreaterThan(-1);
    expect(shownTexts.indexOf("How long does the push take?")).toBeLessThan(shownTexts.indexOf("About a minute."));
    expect(shownTexts).toContain("Waiting for the Worker…");
    // Answered: no wait line.
    const replied = view(decision, { thread: thread(decision.id, ["owner", "Why?"], ["asker", "Because."]) });
    expect(replied.askBack?.status).toBeNull();
  });

  it("says when the question was not delivered, sending, or why Send failed", () => {
    const decision = makeDecision();
    const waiting = thread(decision.id, ["owner", "Why?"]);
    expect(view(decision, { thread: waiting, ask: { ...ASK_UI_IDLE, delivery: "failed" } }).askBack?.status).toEqual({ text: ASK_NOT_DELIVERED, tone: "warning" });
    expect(ASK_NOT_DELIVERED).toBe("Not delivered: the asker could not be reached; your question is kept.");
    expect(view(decision, { thread: waiting, ask: { ...ASK_UI_IDLE, delivery: "queued" } }).askBack?.status?.text).toBe("Waiting for the Worker…");
    expect(view(decision, { ask: { ...ASK_UI_IDLE, text: "x", busy: true } }).askBack).toMatchObject({ box: { busy: true, sendEnabled: false }, status: { text: "Sending your question…" } });
    expect(view(decision, { ask: { ...ASK_UI_IDLE, text: "x", error: "Could not ask (E_DECISION_SETTLED)" } }).askBack?.status).toEqual({
      text: "Could not ask (E_DECISION_SETTLED)",
      tone: "danger",
    });
  });

  it("hides Ask back while the X-4 confirmation or the own-words box is open", () => {
    expect(view(makeDecision(), { ui: { ...DECISION_UI_IDLE, confirming: "a" } }).askBack).toMatchObject({ offered: false, box: null });
    expect(view(makeDecision(), { ui: { ...DECISION_UI_IDLE, words: "" } }).askBack?.offered).toBe(false);
  });

  it("keeps a settled decision's conversation read-only, and shows nothing when nobody asked", () => {
    const answered = answerDecision(makeDecision(), { via: "inbox", optionKey: "c", at: "2026-09-29T07:44:00.000Z" });
    if (!answered.ok) throw new Error(answered.message);
    expect(view(answered.decision).askBack).toBeNull();
    const kept = view(answered.decision, { thread: thread(answered.decision.id, ["owner", "Why?"]) });
    expect(kept.askBack).toMatchObject({ offered: false, box: null, status: null });
    expect(kept.askBack?.conversation).toHaveLength(1);
  });

  it("reads the thread again only while the owner's question waits on a decision that can be answered", () => {
    const decision = makeDecision();
    expect(threadPollMs(decision, thread(decision.id, ["owner", "Why?"]))).toBe(DECISION_POLL_MS);
    expect(threadPollMs(decision, thread(decision.id, ["owner", "Why?"], ["asker", "Because."]))).toBe(false);
    expect(threadPollMs(decision, thread(decision.id))).toBe(false);
    expect(threadPollMs(null, undefined)).toBe(false);
    expect(threadPollMs({ ...decision, status: "withdrawn" }, thread(decision.id, ["owner", "Why?"]))).toBe(false);
    // One thread query per decision, under the decision's own key.
    expect(decisionThreadQueryKey(decision.id).slice(0, 3)).toEqual(decisionQueryKey(decision.id));
  });

  it("sends ONE decisions.ask with the trimmed text, refuses a blank one, and reports a refusal with its code", async () => {
    const decision = makeDecision();
    const reply = { thread: thread(decision.id, ["owner", "Why?"]), delivery: "queued" as const };
    const ask = vi.fn(async () => reply);
    expect(await runDecisionAsk({ id: decision.id, text: "  Why?  ", ask })).toEqual({ ok: true, ...reply });
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({ id: decision.id, text: "Why?" });
    expect(await runDecisionAsk({ id: decision.id, text: "   ", ask })).toEqual({ ok: false, reason: "Write your question first." });
    expect(ask).toHaveBeenCalledOnce();
    const refused = await runDecisionAsk({ id: decision.id, text: "Why?", ask: async () => Promise.reject(Object.assign(new Error("E_DECISION_SETTLED: already answered"), { code: "E_DECISION_SETTLED" })) });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason.startsWith("Could not ask")).toBe(true);
    expect(!refused.ok && refused.reason).toContain("E_DECISION_SETTLED");
  });
});

describe("decided for you by the Orchestrator (change-014, ADR-025)", () => {
  function policyAnswer(decision: Decision): Decision {
    const result = answerDecision(decision, { by: "policy", via: "autopilot", optionKey: "c", class: "scope", reason: "Hold is the safe choice.", at: "2026-09-29T07:42:00.000Z" });
    if (!result.ok) throw new Error(result.message);
    return result.decision;
  }

  it("names the Orchestrator on the card and in Details, and the Inbox line the same", () => {
    const decided = policyAnswer(makeDecision({ class: "scope" }));
    const shown = view(decided);
    expect(shown.frame.authority?.startsWith("decided for you by the Orchestrator · ")).toBe(true);
    expect(shown.details).toContain("Answered by: the Orchestrator (scope)");
    expect(JSON.stringify(shown)).not.toContain("the policy ·");
    expect(decidedByWords(decided)).toBe("the Orchestrator");
  });

  it("says 'your earlier policy' for an answer an older build stored with the recommended option as predictor", () => {
    const decided = policyAnswer(makeDecision({ class: "scope" }));
    const old = { ...decided, answer: { ...decided.answer!, predictor: "recommended" as const } };
    const shown = view(old);
    expect(shown.frame.authority?.startsWith("decided for you by your earlier policy · ")).toBe(true);
    expect(shown.details).toContain("Answered by: your earlier policy (recommended option, scope)");
    expect(decidedByWords(old)).toBe("your earlier policy");
  });

  it("names the Main for an answer the request's Main gave (missions design §8), never the owner or the policy", () => {
    const result = answerDecision(makeDecision({ class: "scope" }), { by: "main", via: "main", optionKey: "c", class: "scope", reason: "Hold until the contract tests pass.", at: "2026-09-29T07:42:00.000Z" });
    if (!result.ok) throw new Error(result.message);
    const shown = view(result.decision);
    expect(shown.frame.authority?.startsWith("decided for you by the Main · ")).toBe(true);
    expect(shown.details).toContain("Answered by: the Main (scope)");
    expect(JSON.stringify(shown)).not.toMatch(/answered by you|your policy/);
    expect(decidedByWords(result.decision)).toBe("the Main");
  });
});

describe("a mission's card (missions design §4.1)", () => {
  it("names the Main as its asker, not the plugin that stored it; another plugin card stays the plugin's", () => {
    const card = makeDecision({ id: "m:mis-0123456789:1", workspaceId: "mis-0123456789", requestId: null, askedBy: { role: "plugin", agentId: "main-aix-0001" } });
    expect(view(card).frame.actor).toEqual({ mark: "request", name: "Main" });
    const held = makeDecision({ askedBy: { role: "plugin", agentId: null } });
    expect(view(held).frame.actor).toEqual({ mark: null, name: "paseo-bm plugin" });
  });
});
