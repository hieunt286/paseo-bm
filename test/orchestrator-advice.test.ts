import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { readCoordinationSettings } from "../plugin/server/coordination-rpc";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, settledByKind } from "../plugin/server/decision-rpc";
import type { BmEvent } from "../plugin/server/event-bus";
import { checkInterventions } from "../plugin/server/intervention-store";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { FINDINGS_NOTE, findingsText, type FindingsReport } from "../plugin/server/orchestrator-findings";
import { createOrchestratorTools, type OrchestratorToolsDeps } from "../plugin/server/orchestrator-tools";
import type { ServerToolResult } from "../plugin/server/orchestrator-tool-context";
import { resolveAtOpen, resolveByPolicy } from "../plugin/server/policy-resolve";
import { resolveByPrecedent, supersedePrecedentsBy } from "../plugin/server/precedent-resolve";
import { applyPreparedChange } from "../plugin/server/prepared-changes";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { AUTONOMY_MODES, decideRefusalOf, modeOf, predictionRefusalOf, recommendedDelegationOf } from "../plugin/shared/autonomy";
import { FINDINGS_MAX_CHARS, ORCHESTRATOR_SERVER_TOOLS } from "../plugin/shared/bm-tools";
import { alertKeyOf } from "../plugin/shared/alerts";
import { ADVICE_EVERY_FINISHED, DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { answerDecision, carriesPreparedChange, type Decision } from "../plugin/shared/decisions";
import { whyNotPrecedent } from "../plugin/shared/precedents";
import { PREPARED_CHANGE_FIELDS, preparedChangeCheckOf, preparedChangeTextOf } from "../plugin/shared/prepared-changes";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo } from "./helpers/fake-paseo";
import { MANAGER, WORKER, WORKSPACE_DIRECTORY, WORKSPACE_ID, at, msg, report, turn } from "./fixtures/orchestrator-traces";

/**
 * Proactive advice (autonomy design §G.4; PRD REQ-128; ADR-021 decision 5;
 * bead t9lm.25): `bm_findings`, prepared changes of the owner's settings on
 * the options of `bm_ask_owner` — applied by the plugin on the owner's own
 * answer and never on anyone else's — and the `advice` intervention. The
 * `advice.due` event is in event-bus.test.ts. A temporary data folder named by
 * `PASEO_BM_HOME` and the shared fake Paseo: never the real HOME or a daemon.
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ORCHESTRATOR = "agent-orchestrator";
const orchestratorAgent = {
  id: ORCHESTRATOR,
  provider: "bm-orchestrator/claude-opus-5-5",
  status: "running",
  workspaceId: "wks_home",
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main" },
  createdAt: "2026-09-26T08:00:00.000Z",
};

type Entry = { item: Record<string, unknown>; timestamp: string };
const ownerSays = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `c-${when}` }, timestamp: when });
const pluginSays = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `n-${when}` }, timestamp: when });

let root: string;
let home: string;
let ids: number;
let deps: OrchestratorToolsDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-advice-"));
  home = join(root, "data");
  ids = 0;
  deps = {
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    now: () => NOW,
    redactEnv: {},
    newId: () => `advice-${++ids}`,
    store: { now: () => NOW, newId: () => `proposal-${++ids}` },
    log: () => {},
  };
  clearTraceStoreCache();
  clearDecisionStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  clearDecisionStoreCache();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function toolsWith(timeline: Entry[] = []) {
  const fake = fakePaseo({
    agents: [
      { id: MANAGER, provider: "bm-manager", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" } },
      { id: WORKER, provider: "bm-worker", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER } },
      orchestratorAgent,
    ],
    workspaces: [{ id: WORKSPACE_ID, directory: WORKSPACE_DIRECTORY }],
    timelines: { [ORCHESTRATOR]: { pages: [timeline] } },
  });
  const tools = createOrchestratorTools(deps);
  tools.usePaseo(fake.paseo);
  return { ...fake, tools };
}

/** The owner's answer through `decisions.answer`, delivered as the plugin delivers it (`settledByKind`). */
function answering() {
  const enqueue = vi.fn<(target: string, kind: string, text: string, paseo?: unknown) => Promise<"sent" | "queued" | "dropped">>(async () => "sent");
  const logs: string[] = [];
  const onSettled = settledByKind({
    orchestrator: createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, queue: { enqueue }, log: (line) => logs.push(line) }),
  });
  const answer = (input: Parameters<typeof handleDecisionsAnswer>[0], paseo: unknown) => handleDecisionsAnswer(input, paseo, { home, now: () => NOW, onSettled, log: () => {} });
  const notices = () => enqueue.mock.calls.map(([, , text]) => text);
  return { enqueue, logs, answer, onSettled, notices };
}

function jsonOf(result: ServerToolResult): Record<string, unknown> {
  return JSON.parse(result.text.slice(result.text.indexOf("\n{") + 1)) as Record<string, unknown>;
}

const decisions = () => createDecisionStore(home).list({ workspaceId: WORKSPACE_ID });
const stored = (id: string) => createDecisionStore(home).get(id, WORKSPACE_ID)!;
const cadenceNow = () => readCoordinationSettings({ home, log: () => {} }).advice.everyFinished;
const policyNow = () => createAutonomyStore(home).read();

const QUESTION = "The last advice went unanswered for a week: advise less often?";
const RECOMMENDATION = "Every 10 finished requests: five was too often for this project.";
const cadence = (value: number, recommended = true) => ({ label: `Advise after every ${value}`, effects: ["none"], recommended, change: { kind: "coordination.set", key: "advice.everyFinished", value } });
const KEEP = { label: "Keep it as it is", effects: ["none"] };

async function ask(tools: ReturnType<typeof toolsWith>["tools"], options: unknown[], over: Record<string, unknown> = {}): Promise<ServerToolResult> {
  return tools.call("bm_ask_owner", { workspaceId: WORKSPACE_ID, question: QUESTION, recommendation: RECOMMENDATION, options, ...over });
}

async function asked(tools: ReturnType<typeof toolsWith>["tools"], options: unknown[], over: Record<string, unknown> = {}): Promise<string> {
  const result = await ask(tools, options, over);
  expect(result.ok, result.text).toBe(true);
  return (jsonOf(result) as { decisionId: string }).decisionId;
}

/** Twenty owner answers agreeing with the recommended option over 15 days: `preference`'s agreement figure (§B.3). */
function answerPreference(): void {
  const store = createDecisionStore(home);
  for (let n = 1; n <= 20; n += 1) {
    const requestId = `req-202609${String(10 + Math.floor(n / 2)).padStart(2, "0")}T0000${String(n).padStart(2, "0")}Z`;
    const decision = makeDecision({
      id: `q:${requestId}:Q1`,
      workspaceId: WORKSPACE_ID,
      requestId,
      askedAt: new Date(NOW.getTime() - (16 - n * 0.75) * DAY_MS).toISOString(),
      subject: null,
      class: "preference",
      options: [
        { key: "a", label: "Keep the house style", recommended: true, effects: ["none"] },
        { key: "b", label: "Change it", recommended: false, effects: ["none"] },
      ],
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
    });
    store.open(decision);
    store.transition(decision.id, (current) => answerDecision(current, { via: "inbox", optionKey: "a", at: decision.askedAt }), WORKSPACE_ID);
  }
}

function filesUnder(dir: string): Record<string, number> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path, statSync(path).mtimeMs];
      }),
  );
}

// ---------------------------------------------------------------------------

describe("bm_ask_owner: an option may carry a prepared change of the owner's settings (design §G.4)", () => {
  it("stores the change on its option, writes what a tap applies on the question, records no prediction, and changes nothing yet", async () => {
    const { tools, sends } = toolsWith();
    const result = await ask(tools, [cadence(10), KEEP]);

    expect(result.ok).toBe(true);
    expect(result.text.split("\n")[0]).toContain(
      "When the owner picks an option with a change, the plugin applies it to the owner's settings itself and tells you in the BM-ANSWER; only the owner's own answer applies it, so no precedent, policy or tool of yours ever does.",
    );
    expect(jsonOf(result)).toEqual({ decisionId: "o:advice-1", replaced: null, class: "reversible-technical", changes: 1 });
    const decision = stored("o:advice-1");
    expect(decision.question).toBe(`${QUESTION}\n\nRecommendation: ${RECOMMENDATION}\n\nChoosing a sets Advice to after every 10 finished requests (advice.everyFinished 10).`);
    expect(decision.options).toEqual([
      { key: "a", label: "Advise after every 10", recommended: true, effects: ["none"], action: { kind: "coordination.set", change: { key: "advice.everyFinished", value: 10 } } },
      { key: "b", label: "Keep it as it is", recommended: false, effects: ["none"] },
    ]);
    // About the owner's settings, not a decision of its class: the agreement ledger leaves it out.
    expect(decision).not.toHaveProperty("prediction");
    expect(carriesPreparedChange(decision)).toBe(true);
    expect(decision.status).toBe("open");
    expect(cadenceNow()).toBe(ADVICE_EVERY_FINISHED.default);
    expect(existsSync(join(home, "coordination"))).toBe(false);
    expect(sends).toEqual([]);
    // bm_decisions says what the option applies, and when.
    const listed = JSON.parse((await tools.call("bm_decisions", { workspaceId: WORKSPACE_ID })).text) as { decisions: Array<{ options: Array<{ action?: string }> }> };
    expect(listed.decisions[0]!.options[0]!.action).toBe(
      "coordination.set: the plugin sets Advice to after every 10 finished requests (advice.everyFinished 10), only when the owner chooses it",
    );
  });

  it("each kind in the owner's words, and the fields each takes", () => {
    expect(PREPARED_CHANGE_FIELDS).toEqual({
      "precedent.save": { required: ["scope", "subject", "text"], optional: ["expiresInDays"] },
      "autonomy.set": { required: ["class", "mode"], optional: ["predictor"] },
      "coordination.set": { required: ["key", "value"], optional: [] },
    });
    expect(preparedChangeTextOf({ kind: "precedent.save", scope: "all", subject: "date-format", text: "dd/mm/yyyy" })).toBe(
      'saves your precedent on "date-format" for all projects, for 30 days: "dd/mm/yyyy"',
    );
    expect(preparedChangeTextOf({ kind: "autonomy.set", class: "reversible-technical", mode: "delegate", predictor: "orchestrator" })).toBe(
      "sets Reversible technical decisions in this project to Delegated to the Orchestrator",
    );
    expect(preparedChangeTextOf({ kind: "coordination.set", change: { key: "advice.everyFinished", value: 0 } })).toBe("turns Advice off (advice.everyFinished 0)");
    // The modes a change names are the policy's (decisions.ts cannot import autonomy.ts, which imports it).
    expect(AUTONOMY_MODES).toEqual(["owner", "shadow", "delegate"]);
    const schema = ORCHESTRATOR_SERVER_TOOLS.find((face) => face.name === "bm_ask_owner")!.inputSchema.properties!["options"]!.items!.properties!["change"]!;
    expect(schema.properties!["mode"]!.enum).toEqual(AUTONOMY_MODES);
  });

  it("refuses what the owner could not set in Settings, what would change nothing, and a malformed change; stores and writes nothing", async () => {
    const { tools } = toolsWith();
    const refused = async (change: Record<string, unknown>, option: Record<string, unknown> = {}) => {
      const result = await ask(tools, [{ label: "Do it", effects: ["none"], change, ...option }, KEEP]);
      expect(result.ok, JSON.stringify(change)).toBe(false);
      return result.text;
    };
    // autonomy.set never on a hard-owner class, in any mode.
    expect(await refused({ kind: "autonomy.set", class: "release", mode: "shadow" })).toContain(
      "- input.options[0].change: release decisions are always the owner's; their cell is fixed in Settings and never changed",
    );
    expect(await refused({ kind: "autonomy.set", class: "security", mode: "delegate", predictor: "recommended" })).toContain("security decisions are always the owner's");
    for (const hardOwner of ["data", "cost"]) expect(await refused({ kind: "autonomy.set", class: hardOwner, mode: "owner" })).toContain(`${hardOwner} decisions are always the owner's`);
    // Nothing to change.
    expect(await refused({ kind: "coordination.set", key: "advice.everyFinished", value: 5 })).toContain("- input.options[0].change: it would change nothing: advice.everyFinished is 5 already");
    expect(await refused({ kind: "autonomy.set", class: "scope", mode: "owner" })).toContain("it would change nothing: scope is owner in this project already");
    // Malformed.
    expect(await refused({ kind: "coordination.set", key: "advice.everyFinished", value: 10 }, { effects: ["commit"] })).toContain(
      '- input.options[0].effects: an option with a change allows no effect; give ["none"]',
    );
    expect(await refused({ kind: "coordination.set", key: "advice.everyFinished", value: 10 }, { command: { to: "manager", agentId: MANAGER, intent: "other", body: "Carry on." } })).toContain(
      "- input.options[0]: an option carries a command or a change, not both",
    );
    expect(await refused({ kind: "precedent.save", scope: "project", subject: "date-format" })).toContain("- input.options[0].change.text: is required for precedent.save");
    expect(await refused({ kind: "coordination.set", key: "advice.everyFinished", value: 10, class: "scope" })).toContain("- input.options[0].change.class: is not a field of coordination.set");
    expect(await refused({ kind: "coordination.set", key: "advice.everyFinished", value: 51 })).toContain(
      "- input.options[0].change.value: advice.everyFinished must be a whole number from 0 (off) to 50",
    );
    expect(await refused({ kind: "review.budget" })).toContain("- input.options[0].change.kind: must be one of precedent.save, autonomy.set, coordination.set");
    // The lines saying what each change applies count toward the question's length.
    const long = await ask(tools, [cadence(10), KEEP], { question: "x".repeat(800), recommendation: "y".repeat(120) });
    expect(long.text).toMatch(/- input\.question: with the recommendation and the lines saying what each change applies \(\d+ characters\) it must be at most \d+ characters in all/);

    expect(decisions()).toEqual([]);
    expect(existsSync(join(home, "coordination"))).toBe(false);
    expect(existsSync(join(home, "autonomy"))).toBe(false);
  });
});

describe("the owner's answer applies the prepared change of the option chosen, and nothing else does (design §G.4)", () => {
  it("coordination.set: applied through coordination.set on the owner's option, the BM-ANSWER says so; another option or own words change nothing", async () => {
    const { tools, paseo } = toolsWith();
    const { answer, notices } = answering();
    const first = await asked(tools, [cadence(10), KEEP]);

    await answer({ id: first, optionKey: "a" }, paseo);

    expect(cadenceNow()).toBe(10);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain(
      "\nchange: applied by the plugin — it sets Advice to after every 10 finished requests (advice.everyFinished 10); send nothing for it\n",
    );
    expect(stored(first)).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "a" }, grant: null, delivery: { to: ORCHESTRATOR, outcome: "sent" } });

    // Another option: nothing is set.
    const second = await asked(tools, [cadence(20), KEEP]);
    await answer({ id: second, optionKey: "b" }, paseo);
    expect(cadenceNow()).toBe(10);
    expect(notices()[1]).not.toContain("change:");
    // The owner's own words: nothing is set either.
    const third = await asked(tools, [cadence(20), KEEP]);
    await answer({ id: third, words: "Leave it at ten." }, paseo);
    expect(cadenceNow()).toBe(10);
    expect(notices()[2]).not.toContain("change:");
  });

  it("autonomy.set: owner, shadow or delegate as the matrix sets them, delegate with no agreement threshold (ADR-023), the owner's tap its confirmation", async () => {
    const { tools, paseo } = toolsWith();
    const { answer, notices } = answering();
    const shadow = await asked(tools, [{ label: "Shadow scope", effects: ["none"], recommended: true, change: { kind: "autonomy.set", class: "scope", mode: "shadow" } }, KEEP]);
    expect(stored(shadow).question).toContain("\n\nChoosing a sets Scope decisions in this project to Shadow.");
    await answer({ id: shadow, optionKey: "a" }, paseo);
    expect(modeOf(policyNow(), WORKSPACE_ID, "scope")).toBe("shadow");

    // No answer of the owner's in preference yet: delegating it is still the owner's to choose.
    const delegate = await asked(tools, [{ label: "Delegate preference", effects: ["none"], change: { kind: "autonomy.set", class: "preference", mode: "delegate", predictor: "recommended" } }, KEEP]);
    await answer({ id: delegate, optionKey: "a" }, paseo);
    expect(policyNow().projects[WORKSPACE_ID]?.preference).toEqual({ mode: "delegate", predictor: "recommended", at: NOW.toISOString() });
    expect(notices()[1]).toContain("change: applied by the plugin — it sets Preference decisions in this project to Delegated to the recommended option");
  });

  it("precedent.save: the owner's precedent of this project, as Settings writes one; the decision itself never becomes one", async () => {
    const { tools, paseo } = toolsWith();
    const { answer } = answering();
    const id = await asked(tools, [
      { label: "Save it as a precedent", effects: ["none"], recommended: true, change: { kind: "precedent.save", scope: "project", subject: "date-format", text: "dd/mm/yyyy everywhere", expiresInDays: 60 } },
      KEEP,
    ]);
    expect(stored(id).question).toContain('Choosing a saves your precedent on "date-format" for this project, for 60 days: "dd/mm/yyyy everywhere".');
    await answer({ id, optionKey: "a" }, paseo);
    expect(createPrecedentStore(home).active(NOW, WORKSPACE_ID)).toEqual([
      expect.objectContaining({
        scope: WORKSPACE_ID,
        subject: "date-format",
        text: "dd/mm/yyyy everywhere",
        sourceDecisionId: null,
        expiresAt: new Date(NOW.getTime() + 60 * DAY_MS).toISOString(),
      }),
    ]);
    // The same precedent again would change nothing: refused when asked.
    expect((await ask(tools, [{ label: "Again", effects: ["none"], change: { kind: "precedent.save", scope: "project", subject: "date-format", text: "dd/mm/yyyy everywhere" } }])).text).toContain(
      `it would change nothing: the owner's precedent on "date-format" already says this`,
    );
    // Save as precedent is not offered on a decision about the owner's settings.
    expect(whyNotPrecedent({ ...stored(id), subject: "advice-dates" })).toMatch(/is about your settings/);
  });

  it("checked again when applied: autonomy.set of a hard-owner class is refused, writing nothing; what is so already writes nothing", async () => {
    const { tools, paseo } = toolsWith();
    const { answer, notices } = answering();
    // A decision no tool would store (bm_ask_owner refuses it), as a newer or broken build might have left it.
    createDecisionStore(home).open({
      ...makeDecision({ id: "o:stored-1", workspaceId: WORKSPACE_ID, requestId: null, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null, subject: null }),
      options: [
        { key: "a", label: "Shadow releases", recommended: true, effects: ["none"], action: { kind: "autonomy.set", class: "release", mode: "shadow" } },
        { key: "b", label: "Keep", recommended: false, effects: ["none"] },
      ],
    });
    await answer({ id: "o:stored-1", optionKey: "a" }, paseo);
    expect(policyNow()).toEqual({ projects: {}, challenger: {} });
    expect(existsSync(join(home, "autonomy"))).toBe(false);
    expect(notices()[0]).toContain(
      "\nchange: not applied (release decisions are always the owner's; their cell is fixed in Settings and never changed); nothing was changed — tell the owner, and set nothing yourself\n",
    );

    // Asked while scope is owner; the owner shadows it in Settings before answering: applied, nothing written.
    const id = await asked(tools, [{ label: "Shadow scope", effects: ["none"], change: { kind: "autonomy.set", class: "scope", mode: "shadow" } }, KEEP]);
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "scope", mode: "shadow" }, "2026-09-30T11:00:00.000Z");
    await answer({ id, optionKey: "a" }, paseo);
    expect(policyNow().projects[WORKSPACE_ID]?.scope).toEqual({ mode: "shadow", at: "2026-09-30T11:00:00.000Z" });
    expect(notices()[1]).toContain("change: applied by the plugin — it sets Scope decisions in this project to Shadow (it was so already); send nothing for it");
  });
});

describe("only the owner answers a decision that carries a prepared change: not the policy, a precedent, bm_decide or bm_predict (design §G.4)", () => {
  it("the policy at open: a delegate cell of its class leaves it open for the owner, and the policy's answer is refused", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true }, NOW.toISOString());
    const { tools } = toolsWith();
    // Without a change, the same question is answered at once by the recommended option: the guard is what holds it.
    const plain = await ask(tools, [{ label: "Advise after every 10", effects: ["none"], recommended: true }, KEEP], { separate: true });
    expect(plain.text).toMatch(/^Answered at once by the owner's policy/);

    const result = await ask(tools, [cadence(10), KEEP], { separate: true });
    expect(result.text).toMatch(/^Asked\./);
    const id = (jsonOf(result) as { decisionId: string }).decisionId;
    const decision = stored(id);
    expect(decision.status).toBe("open");
    expect(cadenceNow()).toBe(ADVICE_EVERY_FINISHED.default);
    // Each line of the guard, on the stored decision.
    expect(recommendedDelegationOf(policyNow(), decision)).toBeNull();
    expect(resolveByPolicy(decision, { home, now: NOW, log: () => {} })).toEqual({ decision, resolved: false });
    expect(resolveAtOpen(decision, { home, now: NOW, log: () => {} })).toEqual({ decision, answered: null, by: null, precedent: null });
    expect(answerDecision(decision, { by: "policy", predictor: "recommended", via: "inbox", optionKey: "a", at: NOW.toISOString() })).toEqual({
      ok: false,
      refusal: "invalid-answer",
      message: `decision ${id} carries a prepared change of the owner's settings; only the owner answers it`,
    });
  });

  it("a precedent at open: one on its subject answers nothing and suggests nothing, and the owner's answer supersedes none", async () => {
    const saved = createPrecedentStore(home).save({ scope: WORKSPACE_ID, subject: "advice-cadence", text: "Advise after every 10", sourceDecisionId: null, expiresInDays: 30 }, NOW);
    const { tools, paseo } = toolsWith();
    const plain = await ask(tools, [{ label: "Advise after every 10", effects: ["none"] }, KEEP], { subject: "advice-cadence", separate: true });
    expect(plain.text).toMatch(/^Answered at once by the owner's precedent/);

    const result = await ask(tools, [cadence(10), KEEP], { subject: "advice-cadence", separate: true });
    expect(result.text).toMatch(/^Asked\./);
    expect(result.text).not.toContain("is shown to them as a suggestion");
    const id = (jsonOf(result) as { decisionId: string }).decisionId;
    const decision = stored(id);
    expect(decision.status).toBe("open");
    expect(resolveByPrecedent(decision, { home, now: NOW, log: () => {} })).toEqual({ decision, resolved: false, precedent: null });
    expect(answerDecision(decision, { by: "precedent", precedentId: saved.precedent.id, via: "inbox", optionKey: "a", at: NOW.toISOString() })).toMatchObject({
      ok: false,
      message: `decision ${id} carries a prepared change of the owner's settings; only the owner answers it`,
    });
    // The owner keeps things as they are: a decision about the settings answers no subject, so the precedent stands.
    const { answer } = answering();
    const answered = await answer({ id, optionKey: "b" }, paseo);
    expect(supersedePrecedentsBy(answered.decision, { home, now: NOW })).toEqual([]);
    expect(createPrecedentStore(home).active(NOW, WORKSPACE_ID).map((precedent) => precedent.id)).toContain(saved.precedent.id);
  });

  it("bm_decide: refused even where the owner delegated its class to the Orchestrator; nothing is written or applied", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true, predictor: "orchestrator" }, NOW.toISOString());
    const { tools } = toolsWith();
    const id = await asked(tools, [cadence(10), KEEP]);
    const decided = await tools.call("bm_decide", { decisionId: id, optionKey: "a", reason: "Five was too often." });
    expect(decided).toEqual({ ok: false, text: `Refused: decision ${id} carries a prepared change of the owner's settings; only the owner answers it; leave it to the owner.` });
    expect(stored(id).status).toBe("open");
    expect(cadenceNow()).toBe(ADVICE_EVERY_FINISHED.default);
    // The guard is its own line, not only the rule that an o: decision is the owner's: a question carrying a change is refused too.
    const question = { ...makeDecision({ subject: null, options: [{ key: "a", label: "Advise less", recommended: true, effects: ["none"], action: { kind: "coordination.set", change: { key: "advice.everyFinished", value: 10 } } }] }), class: "reversible-technical" as const };
    expect(decideRefusalOf(policyNow(), question)).toBe(`decision ${question.id} carries a prepared change of the owner's settings; only the owner answers it; leave it to the owner`);
  });

  it("bm_predict: refused with the challenger on; nothing is recorded", async () => {
    createAutonomyStore(home).setChallenger({ workspaceId: WORKSPACE_ID, enabled: true });
    const { tools } = toolsWith();
    const id = await asked(tools, [cadence(10), KEEP]);
    const predicted = await tools.call("bm_predict", { decisionId: id, optionKey: "a", reason: "The owner never answered the last one." });
    expect(predicted).toEqual({ ok: false, text: `Refused: decision ${id} carries a prepared change of the owner's settings; only the owner answers it; it is not predicted.` });
    expect(stored(id)).not.toHaveProperty("prediction");
    const question = makeDecision({ subject: null, prediction: { recommended: null, orchestrator: null }, options: [{ key: "a", label: "Advise less", recommended: false, effects: ["none"], action: { kind: "coordination.set", change: { key: "advice.everyFinished", value: 10 } } }] });
    expect(predictionRefusalOf(policyNow(), question)).toMatch(/carries a prepared change of the owner's settings; only the owner answers it; it is not predicted$/);
  });

  it("an answer that is not the owner's applies nothing, whatever wrote it", async () => {
    const { tools, paseo } = toolsWith();
    const id = await asked(tools, [cadence(10), KEEP]);
    // Stored as if the policy had answered it (answerDecision refuses to write this).
    const owner = answerDecision(stored(id), { via: "inbox", optionKey: "a", at: NOW.toISOString() });
    if (!owner.ok) throw new Error(owner.message);
    const byPolicy: Decision = { ...owner.decision, answer: { ...owner.decision.answer!, by: "policy", predictor: "recommended" } };
    expect(applyPreparedChange(byPolicy, { home, now: NOW })).toEqual({
      applied: false,
      text: "sets Advice to after every 10 finished requests (advice.everyFinished 10)",
      reason: "only the owner's own answer applies a change of the owner's settings",
    });
    const { onSettled, notices } = answering();
    createDecisionStore(home).transition(id, () => ({ ok: true, decision: byPolicy }), WORKSPACE_ID);
    await onSettled([byPolicy], { paseo });
    expect(cadenceNow()).toBe(ADVICE_EVERY_FINISHED.default);
    expect(notices()[0]).toContain("change: not applied (only the owner's own answer applies a change of the owner's settings)");
  });
});

describe("advice is logged as an `advice` intervention, met when the owner answers within 7 days (design §G.3)", () => {
  const logged = () => {
    try {
      return (JSON.parse(readFileSafe(join(home, "orchestrator", "interventions.json"))) as { entries: Array<Record<string, unknown>> }).entries;
    } catch {
      return [];
    }
  };
  const ADVICE_DUE: BmEvent = { type: "advice.due", workspaceId: WORKSPACE_ID, finished: 5, at: at(0) };

  it("in the wake of the project's advice.due: a decision with a change, or about the whole project, is advice; a request's plain question is not", async () => {
    deps.wakeEventsOf = (orchestratorId) => (orchestratorId === ORCHESTRATOR ? [ADVICE_DUE] : []);
    const { tools } = toolsWith();
    const withChange = await asked(tools, [cadence(10), KEEP], { separate: true });
    const project = await asked(tools, [{ label: "Review the stalls", effects: ["none"] }, KEEP], { separate: true });
    await asked(tools, [{ label: "Split it", effects: ["none"] }, KEEP], { requestId: "req-20260926T100020Z" });
    expect(logged()).toEqual([
      {
        id: expect.any(String),
        kind: "advice",
        workspaceId: WORKSPACE_ID,
        requestId: null,
        targetAgentId: null,
        trigger: "advice.due",
        expected: "owner-answers",
        windowMs: 7 * DAY_MS,
        at: NOW.toISOString(),
        outcome: "pending",
        checkedAt: null,
        decisionId: withChange,
      },
      expect.objectContaining({ kind: "advice", trigger: "advice.due", decisionId: project }),
    ]);
  });

  it("outside an advice wake: a change asked on the owner's word is the owner's advice, else the Orchestrator's; a plain question is none", async () => {
    const onOwnersWord = await asked(toolsWith([ownerSays("What would you change in this project?", at(1))]).tools, [cadence(10), KEEP], { separate: true });
    const onItsOwn = await asked(toolsWith([pluginSays("BM-ANSWER\ndecisionId: o:x", at(1))]).tools, [cadence(20), KEEP], { separate: true });
    await asked(toolsWith().tools, [{ label: "Review the stalls", effects: ["none"] }, KEEP], { separate: true });
    expect(logged().map((entry) => [entry["decisionId"], entry["trigger"]])).toEqual([
      [onOwnersWord, "owner"],
      [onItsOwn, "orchestrator"],
    ]);
  });

  it("met once the owner answers within the window", async () => {
    const { tools, paseo } = toolsWith();
    const id = await asked(tools, [cadence(10), KEEP]);
    await answering().answer({ id, optionKey: "b" }, paseo);
    const settled = checkInterventions(home, { now: () => new Date(NOW.getTime() + DAY_MS), log: () => {} });
    expect(settled).toEqual([expect.objectContaining({ kind: "advice", decisionId: id, outcome: "met" })]);
  });
});

describe("bm_findings { workspaceId } (design §G.4)", () => {
  const R1 = "req-20260926T100000Z";
  const R2 = "req-20260926T110000Z";
  const R3 = "req-20260926T120000Z";
  const SECRET_TEXT = "QUESTION-TEXT-MUST-NOT-LEAK";
  const ANSWER_TEXT = "ANSWER-TEXT-MUST-NOT-LEAK";
  const USER_TEXT = "USER-TEXT-MUST-NOT-LEAK";
  const usage = (inputTokens: number) => ({ inputTokens, cachedInputTokens: 0, outputTokens: 100, costUsd: null, costBasis: "unavailable" as const, model: "claude-opus-5-5", pricesUpdatedAt: null });

  async function seed(): Promise<void> {
    const location = { tracesDir: join(home, "traces") };
    const records = [
      // R1: Medium, blocked twice on the owner, reviewed once with 2 blocking findings, finished; the heaviest.
      turn({ turnId: "m-1", requestId: R1, at: at(1), startedAt: at(0), endedAt: at(1), sent: [msg(MANAGER, at(0), USER_TEXT, "user")], usage: usage(1_000), reports: [report({ at: at(1), requestId: R1, phase: "received", tier: "Medium" })] }),
      turn({ turnId: "w-1", agentId: WORKER, role: "worker", requestId: R1, at: at(10), startedAt: at(1), endedAt: at(10), usage: usage(90_000) }),
      // A review is its Reviewer's own answer (bead 7gxw.12).
      turn({ turnId: "r-1", agentId: "agent-reviewer", role: "reviewer", requestId: R1, at: at(9), startedAt: at(8), endedAt: at(9), usage: null, reviews: [{ agentId: "agent-reviewer", at: at(9), batchId: "b1", verdict: "changes", blockingCount: 2 }] }),
      turn({ turnId: "m-2", requestId: R1, at: at(12), startedAt: at(11), endedAt: at(12), usage: usage(2_000), reports: [report({ at: at(11), requestId: R1, phase: "blocked", tier: "Medium" }), report({ at: at(12), requestId: R1, phase: "blocked", tier: "Medium" })] }),
      turn({ turnId: "m-3", requestId: R1, at: at(20), startedAt: at(19), endedAt: at(20), usage: usage(3_000), reports: [report({ at: at(20), requestId: R1, phase: "finished", tier: "Medium" })] }),
      // R2: Small, finished.
      turn({ turnId: "m-4", requestId: R2, at: at(30), startedAt: at(29), endedAt: at(30), usage: usage(500), reports: [report({ at: at(30), requestId: R2, phase: "finished", tier: "Small" })] }),
    ];
    for (const record of records) await appendRecord(location, record);
    // Decisions: date-format asked three times and answered alike by the owner; push-backends twice but with a precedent; one-off once.
    const store = createDecisionStore(home);
    const open = (id: string, requestId: string, subject: string, answer: string | null) => {
      const decision = makeDecision({
        id,
        workspaceId: WORKSPACE_ID,
        requestId,
        askedAt: at(2),
        question: SECRET_TEXT,
        subject,
        options: [
          { key: "a", label: ANSWER_TEXT, recommended: true, effects: ["none"] },
          { key: "b", label: "Other", recommended: false, effects: ["none"] },
        ],
      });
      store.open(decision);
      if (answer !== null) store.transition(id, (current) => answerDecision(current, { via: "inbox", optionKey: answer, at: at(3) }), WORKSPACE_ID);
    };
    open(`q:${R1}:Q1`, R1, "date-format", "a");
    open(`q:${R2}:Q1`, R2, "date-format", "a");
    open(`q:${R3}:Q1`, R3, "date-format", "a");
    open(`q:${R1}:Q2`, R1, "push-backends", "a");
    open(`q:${R2}:Q2`, R2, "push-backends", null);
    open(`q:${R3}:Q2`, R3, "one-off", "a");
    createPrecedentStore(home).save({ scope: WORKSPACE_ID, subject: "push-backends", text: "Contract only", sourceDecisionId: null, expiresInDays: 30 }, NOW);
    answerPreference();
    // Advice went unanswered three times of four: below A-12's target.
    mkdirSync(join(home, "orchestrator"), { recursive: true });
    const intervention = (n: number, outcome: string) => ({
      id: `i-${n}`,
      kind: "advice",
      workspaceId: WORKSPACE_ID,
      requestId: null,
      targetAgentId: null,
      trigger: "advice.due",
      expected: "owner-answers",
      windowMs: 7 * DAY_MS,
      at: new Date(NOW.getTime() - (10 - n) * DAY_MS).toISOString(),
      outcome,
      checkedAt: NOW.toISOString(),
      decisionId: `o:advice-old-${n}`,
    });
    writeFileSync(join(home, "orchestrator", "interventions.json"), JSON.stringify({ version: 1, entries: [intervention(1, "met"), intervention(2, "missed"), intervention(3, "missed"), intervention(4, "missed")] }));
    // Stalls: a request idle and over its review budget; a stuck Worker; a pairing alert is not a stall.
    const alerts = createAlertStore(home, { now: () => new Date(NOW.getTime() - DAY_MS) });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "request-stalled", subject: R1, detail: "idle-unfinished, review-over-budget" });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "stuck", subject: WORKER, detail: `${SECRET_TEXT} evidence` });
    alerts.raise({ workspaceId: WORKSPACE_ID, kind: "pairing-mismatch", subject: WORKER });
  }

  it("returns the project's findings with their figures and the change that acts on each, figures and short labels only, within 4,000 characters, read-only", async () => {
    await seed();
    const { tools, sends } = toolsWith();
    const before = filesUnder(home);

    const result = await tools.call("bm_findings", { workspaceId: WORKSPACE_ID });

    expect(result.ok).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(FINDINGS_MAX_CHARS);
    const [note, body] = [result.text.slice(0, result.text.indexOf("\n")), result.text.slice(result.text.indexOf("\n") + 1)];
    expect(note).toBe(FINDINGS_NOTE);
    const report = JSON.parse(body) as FindingsReport;
    expect(report).toMatchObject({
      workspaceId: WORKSPACE_ID,
      window: { days: 30, since: new Date(NOW.getTime() - 30 * DAY_MS).toISOString() },
      requests: { inWindow: 2, finished: 2 },
      settings: { "advice.everyFinished": 5, autonomy: {}, challenger: false, activePrecedents: 1 },
      omitted: 0,
    });
    const byKind = (kind: string) => report.findings.filter((finding) => finding.finding === kind);
    expect(byKind("repeated-subject")).toEqual([{ finding: "repeated-subject", subject: "date-format", asked: 3, ownerAnswers: 3, sameAnswer: 3, lastDecisionId: expect.stringMatching(/^q:req-/), act: "precedent.save" }]);
    expect(byKind("agreement")).toEqual([{ finding: "agreement", class: "preference", predictor: "recommended", agreement: 1, answers: 20, reversals: 0, mode: "owner", act: "autonomy.set" }]);
    expect(byKind("intervention-below-target")).toEqual([{ finding: "intervention-below-target", kind: "advice", met: 1, missed: 3, share: 0.25, target: 0.8, act: "coordination.set" }]);
    expect(byKind("blocked-rounds")).toEqual([expect.objectContaining({ finding: "blocked-rounds", rounds: 2, requestsBlocked: 1, perRequest: 1 })]);
    // With the tier's review budget and the setting that changes it (bead 7gxw.12, §G.4's review.budget).
    expect(byKind("reviews")).toEqual([
      { finding: "reviews", tier: "Medium", requests: 1, batches: 1, reviewsPerBatch: 1, blockingFindings: 2, blockingPerBatch: 2, budget: 2, key: "review.mediumBudget", act: "coordination.set" },
    ]);
    expect(byKind("stalls")).toEqual([{ finding: "stalls", "idle-unfinished": 1, "review-over-budget": 1, stuck: 1 }]);
    expect(byKind("heavy-request")[0]).toMatchObject({ finding: "heavy-request", requestId: R1, turns: 4, finished: true });
    expect((byKind("heavy-request")[0]!["workerShare"] as number) > 0.9).toBe(true);
    // Nothing a person wrote leaves: no question, answer, user message or alert evidence.
    for (const text of [SECRET_TEXT, ANSWER_TEXT, USER_TEXT, "Contract only"]) expect(result.text).not.toContain(text);
    // Read-only: nothing written, nothing sent.
    expect(filesUnder(home)).toEqual(before);
    expect(sends).toEqual([]);
  });

  it("keeps within 4,000 characters however many findings: the last go first, counted in omitted; a secret never leaves", () => {
    const report: FindingsReport = {
      workspaceId: WORKSPACE_ID,
      window: { days: 30, since: "2026-08-31T12:00:00.000Z" },
      requests: { inWindow: 90, finished: 80 },
      settings: { "advice.everyFinished": 5 },
      findings: Array.from({ length: 200 }, (_, n) => ({ finding: "repeated-subject", subject: `subject-${n}`, asked: 3, act: "precedent.save" as const })),
      omitted: 0,
    };
    const text = findingsText(report);
    expect(text.length).toBeLessThanOrEqual(FINDINGS_MAX_CHARS);
    const body = JSON.parse(text.slice(text.indexOf("\n") + 1)) as FindingsReport;
    expect(body.findings.length + body.omitted).toBe(200);
    expect(body.omitted).toBeGreaterThan(0);
    expect(body.findings[0]).toMatchObject({ subject: "subject-0" });
    const secret = findingsText({ ...report, findings: [{ finding: "repeated-subject", subject: "tok-very-secret-123", asked: 2 }] }, { PASEO_PASSWORD: "tok-very-secret-123" });
    expect(secret).not.toContain("tok-very-secret-123");
  });

  it("an unknown project is refused; a project with nothing measured has no findings; the owner asks through the same tool at any time", async () => {
    const { tools } = toolsWith();
    expect(await tools.call("bm_findings", { workspaceId: "wks_nowhere" })).toEqual({ ok: false, text: "Refused: no paseo-bm project wks_nowhere; use the workspaceId bm_projects gave." });
    const empty = await tools.call("bm_findings", { workspaceId: WORKSPACE_ID });
    expect(empty.ok).toBe(true);
    expect(JSON.parse(empty.text.slice(empty.text.indexOf("\n") + 1))).toMatchObject({ requests: { inWindow: 0, finished: 0 }, findings: [], omitted: 0 });
    expect(await tools.call("bm_findings", {})).toMatchObject({ ok: false, text: expect.stringContaining("- input.workspaceId: is required") });
  });
});

function readFileSafe(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// Keep the checks of a change pure and reachable without the tool.
describe("preparedChangeCheckOf", () => {
  it("is the same check when asked and when applied: refusal, nothing to change, or ok", () => {
    const facts = { workspaceId: WORKSPACE_ID, policy: { projects: {}, challenger: {} }, settings: DEFAULT_COORDINATION_SETTINGS, precedents: [] };
    expect(preparedChangeCheckOf({ kind: "autonomy.set", class: "cost", mode: "shadow" }, facts)).toHaveProperty("refusal");
    expect(preparedChangeCheckOf({ kind: "autonomy.set", class: "preference", mode: "delegate" }, facts)).toEqual({ ok: true });
    expect(preparedChangeCheckOf({ kind: "coordination.set", change: { key: "advice.everyFinished", value: 5 } }, facts)).toHaveProperty("unchanged");
    expect(preparedChangeCheckOf({ kind: "precedent.save", scope: "all", subject: "date-format", text: "  " }, facts)).toHaveProperty("refusal");
  });
});

// Phase 3 (bead 7gxw.9): the compaction and handoff settings are the owner's too — the Orchestrator proposes, the owner's tap applies.
describe("coordination.set on the compaction and handoff keys (design §G.4, §G.7)", () => {
  const coordinationNow = () => readCoordinationSettings({ home, log: () => {} });
  const change = (key: string, value: number | boolean) => ({ kind: "coordination.set", key, value });
  const option = (label: string, key: string, value: number | boolean, recommended = true) => ({ label, effects: ["none"], recommended, change: change(key, value) });

  it("says in the owner's words what each key's change sets", () => {
    const text = (key: string, value: number | boolean) => preparedChangeTextOf({ kind: "coordination.set", change: { key, value } as never });
    expect(text("compact.enabled", false)).toBe("turns Compaction off (compact.enabled false)");
    expect(text("handoff.enabled", true)).toBe("turns Handoff on (handoff.enabled true)");
    expect(text("compact.managerTokensPerTurn", 500_000)).toBe("sets a Manager's compaction threshold to 500,000 tokens read per turn (compact.managerTokensPerTurn 500000)");
    expect(text("compact.workerTokensPerTurn", 8_000_000)).toBe("sets a Worker's compaction threshold to 8,000,000 tokens read per turn (compact.workerTokensPerTurn 8000000)");
    expect(text("compact.contextShare", 0.6)).toBe("sets compaction at 60% of the context window (compact.contextShare 0.6)");
    expect(text("compact.maxPerAgent", 1)).toBe("sets at most 1 compaction per agent (compact.maxPerAgent 1)");
    expect(text("handoff.requestTokens", 200_000_000)).toBe("sets the handoff threshold to 200,000,000 tokens read per request (handoff.requestTokens 200000000)");
    expect(text("handoff.maxPerRequest", 3)).toBe("sets at most 3 handoffs per request (handoff.maxPerRequest 3)");
  });

  it("asks with a new key, changing nothing yet; refuses a value out of its bounds and a change that changes nothing", async () => {
    const { tools } = toolsWith();
    const id = await asked(tools, [option("Hand off later", "handoff.requestTokens", 200_000_000), option("Compact less", "compact.contextShare", 0.6, false), KEEP]);
    expect(stored(id).question).toContain(
      "\n\nChoosing a sets the handoff threshold to 200,000,000 tokens read per request (handoff.requestTokens 200000000).\nChoosing b sets compaction at 60% of the context window (compact.contextShare 0.6).",
    );
    expect(coordinationNow()).toEqual(DEFAULT_COORDINATION_SETTINGS);
    expect(existsSync(join(home, "coordination"))).toBe(false);

    const refused = async (value: Record<string, unknown>) => {
      const result = await ask(tools, [{ label: "Do it", effects: ["none"], change: value }, KEEP]);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      return result.text;
    };
    expect(await refused(change("compact.contextShare", 0.95))).toContain("- input.options[0].change.value: compact.contextShare must be a number from 0.1 to 0.9");
    expect(await refused(change("handoff.maxPerRequest", 9))).toContain("- input.options[0].change.value: handoff.maxPerRequest must be a whole number from 1 to 5");
    expect(await refused(change("compact.enabled", 1))).toContain("- input.options[0].change.value: compact.enabled must be true (on) or false (off)");
    expect(await refused({ kind: "coordination.set", key: "compact.enabled", value: "off" })).toContain("- input.options[0].change.value: must be a number or a boolean");
    expect(await refused(change("compact.enabled", true))).toContain("- input.options[0].change: it would change nothing: compact.enabled is true already");
    expect(await refused({ kind: "coordination.set", key: "compact.tokensPerTurn", value: 390_000 })).toContain("- input.options[0].change.key: must be one of advice.everyFinished, compact.enabled");
    // The tool's face names every key and its rule.
    const schema = ORCHESTRATOR_SERVER_TOOLS.find((face) => face.name === "bm_ask_owner")!.inputSchema.properties!["options"]!.items!.properties!["change"]!;
    expect(schema.properties!["key"]!.enum).toContain("handoff.maxPerRequest");
    expect(schema.properties!["value"]!.description).toContain("compact.contextShare must be a number from 0.1 to 0.9");
  });

  it("applies the change only on the owner's own answer: compaction off, then back on, which ends the guard's alert and counts A-12 afresh", async () => {
    const { tools, paseo } = toolsWith();
    const { answer, notices } = answering();
    const off = await asked(tools, [option("Stop compacting", "compact.enabled", false), KEEP]);
    await answer({ id: off, optionKey: "a" }, paseo);
    expect(coordinationNow().compact.enabled).toBe(false);
    expect(notices()[0]).toContain("\nchange: applied by the plugin — it turns Compaction off (compact.enabled false); send nothing for it\n");

    // The guard had switched it off meanwhile, with its alert; the owner's answer turns it back on.
    createAlertStore(home).raise({ workspaceId: null, kind: "coordination-off", subject: "compact", detail: "Only 6 of its last 10 compactions met their goal (target 8)." });
    const on = await asked(tools, [option("Compact again", "compact.enabled", true), KEEP]);
    // A non-owner answer applies nothing, whatever wrote it.
    const owner = answerDecision(stored(on), { via: "inbox", optionKey: "a", at: NOW.toISOString() });
    if (!owner.ok) throw new Error(owner.message);
    const byPolicy: Decision = { ...owner.decision, answer: { ...owner.decision.answer!, by: "policy", predictor: "recommended" } };
    expect(applyPreparedChange(byPolicy, { home, now: NOW })).toMatchObject({ applied: false, reason: "only the owner's own answer applies a change of the owner's settings" });
    expect(coordinationNow().compact.enabled).toBe(false);
    expect(createAlertStore(home).isOpen(alertKeyOf("coordination-off", null, "compact"))).toBe(true);

    await answer({ id: on, optionKey: "a" }, paseo);
    expect(coordinationNow().compact.enabled).toBe(true);
    expect(coordinationNow().guard.compact.countsFrom).toBe(NOW.toISOString());
    expect(createAlertStore(home).isOpen(alertKeyOf("coordination-off", null, "compact"))).toBe(false);
  });

  it("bm_decide cannot answer it, so the Orchestrator never turns a mechanism on itself", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true, predictor: "orchestrator" }, NOW.toISOString());
    createCoordinationStore(home).set({ key: "handoff.enabled", value: false });
    const { tools } = toolsWith();
    const id = await asked(tools, [option("Hand off again", "handoff.enabled", true), KEEP]);
    const decided = await tools.call("bm_decide", { decisionId: id, optionKey: "a", reason: "Heavy requests again." });
    expect(decided.ok).toBe(false);
    expect(coordinationNow().handoff.enabled).toBe(false);
  });

  it("checks a threshold's change against the settings in effect", () => {
    const facts = { workspaceId: WORKSPACE_ID, policy: { projects: {}, challenger: {} }, settings: DEFAULT_COORDINATION_SETTINGS, precedents: [] };
    expect(preparedChangeCheckOf({ kind: "coordination.set", change: { key: "compact.workerTokensPerTurn", value: 5_700_000 } }, facts)).toEqual({
      unchanged: "compact.workerTokensPerTurn is 5700000 already",
    });
    expect(preparedChangeCheckOf({ kind: "coordination.set", change: { key: "compact.workerTokensPerTurn", value: 8_000_000 } }, facts)).toEqual({ ok: true });
    expect(preparedChangeCheckOf({ kind: "coordination.set", change: { key: "compact.maxPerAgent", value: 9 } as never }, facts)).toEqual({
      refusal: "compact.maxPerAgent must be a whole number from 1 to 5",
    });
  });
});

// Bead 7gxw.12 (design §C.4, §G.4, §G.7; change-008 C6): §G.4's review.budget is a coordination.set on a review-budget key —
// proposed by the Orchestrator, applied only by the owner's own answer.
describe("coordination.set on the review budget per tier (design §G.4's review.budget)", () => {
  const budgetNow = () => readCoordinationSettings({ home, log: () => {} }).review;
  const option = (label: string, key: string, value: number, recommended = true) => ({ label, effects: ["none"], recommended, change: { kind: "coordination.set", key, value } });

  it("says in the owner's words what each tier's change sets", () => {
    const text = (key: string, value: number) => preparedChangeTextOf({ kind: "coordination.set", change: { key, value } as never });
    expect(text("review.smallBudget", 3)).toBe("sets the review budget of a Small request to 3 review calls (review.smallBudget 3)");
    expect(text("review.mediumBudget", 4)).toBe("sets the review budget of a Medium request to 4 review calls (review.mediumBudget 4)");
    expect(text("review.largeBudget", 6)).toBe("sets the review budget of a Large request to 6 review calls (review.largeBudget 6)");
  });

  it("asks with a review budget, changing nothing yet; refuses 1 and 9 with the key's rule, and a change that changes nothing", async () => {
    const { tools } = toolsWith();
    const id = await asked(tools, [option("Large: 6 review calls", "review.largeBudget", 6), KEEP]);
    expect(stored(id).question).toContain("\n\nChoosing a sets the review budget of a Large request to 6 review calls (review.largeBudget 6).");
    expect(budgetNow()).toEqual({ smallBudget: 2, mediumBudget: 2, largeBudget: 4 });
    expect(existsSync(join(home, "coordination"))).toBe(false);
    const refused = async (key: string, value: number) => {
      const result = await ask(tools, [option("Do it", key, value), KEEP]);
      expect(result.ok, `${key} ${value}`).toBe(false);
      return result.text;
    };
    expect(await refused("review.largeBudget", 1)).toContain("- input.options[0].change.value: review.largeBudget must be a whole number from 2 to 8");
    expect(await refused("review.smallBudget", 9)).toContain("- input.options[0].change.value: review.smallBudget must be a whole number from 2 to 8");
    expect(await refused("review.largeBudget", 4)).toContain("- input.options[0].change: it would change nothing: review.largeBudget is 4 already");
    const schema = ORCHESTRATOR_SERVER_TOOLS.find((face) => face.name === "bm_ask_owner")!.inputSchema.properties!["options"]!.items!.properties!["change"]!;
    expect(schema.properties!["key"]!.enum).toEqual(expect.arrayContaining(["review.smallBudget", "review.mediumBudget", "review.largeBudget"]));
    expect(schema.properties!["value"]!.description).toContain("review.largeBudget must be a whole number from 2 to 8");
  });

  it("applies review.largeBudget only on the owner's own answer: not the policy's, not bm_decide's", async () => {
    createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: "reversible-technical", mode: "delegate", confirmed: true, predictor: "orchestrator" }, NOW.toISOString());
    const { tools, paseo } = toolsWith();
    const { answer, notices } = answering();
    const id = await asked(tools, [option("Large: 6 review calls", "review.largeBudget", 6), KEEP]);
    // The Orchestrator cannot answer it, even on a class the owner delegated to it.
    expect((await tools.call("bm_decide", { decisionId: id, optionKey: "a", reason: "Large requests re-review often." })).ok).toBe(false);
    // An answer that is not the owner's applies nothing.
    const owner = answerDecision(stored(id), { via: "inbox", optionKey: "a", at: NOW.toISOString() });
    if (!owner.ok) throw new Error(owner.message);
    const byPolicy: Decision = { ...owner.decision, answer: { ...owner.decision.answer!, by: "policy", predictor: "recommended" } };
    expect(applyPreparedChange(byPolicy, { home, now: NOW })).toMatchObject({ applied: false, reason: "only the owner's own answer applies a change of the owner's settings" });
    expect(budgetNow().largeBudget).toBe(4);

    await answer({ id, optionKey: "a" }, paseo);
    expect(budgetNow()).toEqual({ smallBudget: 2, mediumBudget: 2, largeBudget: 6 });
    expect(notices()[0]).toContain("\nchange: applied by the plugin — it sets the review budget of a Large request to 6 review calls (review.largeBudget 6); send nothing for it\n");
  });
});
