import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE, createAutonomyStore } from "../plugin/server/autonomy-store";
import { answersMessageOf, createQuestionDecisionDelivery } from "../plugin/server/decision-delivery";
import { clearMaterialiserMemory, materialiseTurn } from "../plugin/server/decision-materialiser";
import { handleDecisionsAnswer, settledByKind, type OnDecisionsSettled } from "../plugin/server/decision-rpc";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { decisionOpenedEventsOf } from "../plugin/server/event-bus";
import { createFallbackDecisionDelivery, syncFallbackDecisions, type FallbackAct } from "../plugin/server/fallback-decisions";
import { registerFallbackRpcs } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_FILE } from "../plugin/server/fallback-settings";
import { ROLE_FALLBACK_STATE_FILE, recordIncident } from "../plugin/server/fallback-state";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { createOrchestratorTools } from "../plugin/server/orchestrator-tools";
import { resolveByPolicy } from "../plugin/server/policy-resolve";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  EMPTY_AUTONOMY_POLICY,
  actsOnFinish,
  commandActsOnFinish,
  decideRefusalOf,
  policyReasonOf,
  recommendedDelegationOf,
  unverifiedFinishRefusalOf,
  type AutonomyPolicy,
} from "../plugin/shared/autonomy";
import { UNVERIFIED_FINISH_INSTEAD } from "../plugin/server/command-authority";
import { agreementLedger } from "../plugin/shared/autonomy-ledger";
import type { FallbackIncident, TraceRecord } from "../plugin/shared/contracts";
import { answerDecision, openingPrediction, type Decision, type DecisionClass } from "../plugin/shared/decisions";
import { commandBlockOf, limitsOf, parseCommandBlock } from "../plugin/shared/orchestrator-command";
import { MANAGER, WORKER, WORKSPACE_ID, at, msg, report as reportOf, turn } from "./fixtures/orchestrator-traces";

/**
 * Delegation by the recommended predictor (autonomy design §B.5, §B.9; PRD
 * REQ-121, REQ-123; bead `bm-autonomy-phase2-t9lm.10`): a decision that opens
 * in a `delegate` cell whose predictor is `recommended` is answered by code at
 * open (`by: policy`) with its recommended option, and delivered exactly as an
 * owner answer — to the Worker (`q:`), as a `BM-COMMAND` v2 on
 * `authority: policy:<class>` (`o:` with a prepared command), or through
 * `fallback.act` (`f:`). Never an `owner` or `shadow` cell, never a cell of the
 * Orchestrator's predictor, never release, data, security or cost, never a
 * decision without one recommended option; a precedent comes first.
 *
 * Delegation to the Orchestrator (bead `bm-autonomy-phase2-t9lm.11`): a
 * decision that opens in a `delegate` cell whose predictor is `orchestrator`
 * stays open, raises a `decision.opened` asking `bm_decide`, and the
 * Orchestrator's answer (`by: policy`, predictor `orchestrator`) is delivered
 * through the same hook, exactly as the owner's; never a release, data,
 * security or cost decision, and never a command approving one.
 *
 * Every delivery runs for real (`settledByKind` over the question,
 * Orchestrator and fallback deliveries) against a fake SDK and a spying
 * notice queue: what reaches an agent is exactly what `enqueue` saw. A
 * temporary data folder only; never the real HOME or a daemon.
 */

/** Five minutes after the fixture's first times (`at`), on the same day. */
const NOW = new Date("2026-09-26T10:05:00.000Z");
const REQUEST = "req-20260930T095000Z";
const ORCHESTRATOR = "agent-orchestrator-main";

let root: string;
let home: string;
let logs: string[];
let ids: number;
/** Every notice the plugin queued for an agent: the only way anything reaches one here. */
let enqueued: Array<{ target: string; kind: string; text: string }>;
/** Every direct `send` on the fake SDK (the queue is a spy, so there must be none). */
let sends: Array<{ id: string; text: string }>;
let acted: Array<{ incidentId: string; action: string }>;

const log = (message: string) => void logs.push(message);
const decisions = () => createDecisionStore(home);
const autonomy = () => createAutonomyStore(home);
const stored = (id: string) => decisions().get(id, WORKSPACE_ID)!;
const qid = (n: number, requestId = REQUEST) => `q:${requestId}:Q${n}`;

/** The owner delegates one class of the project, to the recommended option unless told otherwise. */
function delegate(decisionClass: DecisionClass, predictor: "recommended" | "orchestrator" = "recommended", workspaceId = WORKSPACE_ID): void {
  autonomy().set({ workspaceId, class: decisionClass, mode: "delegate", confirmed: true, predictor }, NOW.toISOString());
}

/** A policy file written by hand: what no RPC would write (a hard-owner class delegated) is dropped when read. */
function writePolicyFile(projects: Record<string, unknown>): void {
  mkdirSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
  writeFileSync(join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE), JSON.stringify({ version: 1, projects: { [WORKSPACE_ID]: projects }, challenger: {} }));
}

const delegateCell = (predictor = "recommended") => ({ mode: "delegate", predictor, at: NOW.toISOString() });

const AGENTS = [
  { id: MANAGER, provider: "bm-manager", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" } },
  { id: WORKER, provider: "bm-worker", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER } },
  { id: ORCHESTRATOR, provider: "bm-orchestrator/claude-opus-5-5", status: "idle", workspaceId: "wks_home", labels: { "bm.role": "orchestrator", "bm.orchestrator": "main" } },
];

/** A fake SDK: the three agents, idle; a direct send is recorded (and must never happen: the queue is the only path). */
const paseo = {
  agents: {
    list: async () => ({ entries: AGENTS.map((agent) => ({ agent })) }),
    ref: (id: string) => ({
      refresh: async () => ({ agent: AGENTS.find((agent) => agent.id === id) ?? null }),
      send: async (text: string) => void sends.push({ id, text }),
    }),
  },
  workspaces: { list: async () => ({ entries: [{ id: WORKSPACE_ID, directory: "/work/invoice-app" }] }) },
};

/** The plugin's notice queue as a spy: every notice is delivered at once. */
const queue = {
  enqueue: vi.fn(async (target: string, kind: string, text: string) => {
    enqueued.push({ target, kind, text });
    return "sent" as const;
  }),
  pending: () => [],
};

/** `fallback.act` as the plugin runs it, reduced to what it was asked. */
const act: FallbackAct = async (input) => {
  acted.push({ incidentId: input.incidentId, action: input.action });
  return { incident: { ...INCIDENT, status: input.action === "wait" ? "waiting" : "dismissed" } as FallbackIncident };
};

/** The settlement hook `index.server.ts` wires: one delivery per asker kind (autonomy design §A.6). */
function onSettledHook(): OnDecisionsSettled {
  return settledByKind(
    {
      question: createQuestionDecisionDelivery({ home: () => home, now: () => NOW, log, queue, workerOf: async () => WORKER }).onSettled,
      orchestrator: createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, log, queue }),
      fallback: createFallbackDecisionDelivery(act, { home: () => home, now: () => NOW, log }),
    },
    log,
  );
}

/** A Worker's blocked report with its questions, as its Manager receives it. */
function report(questions: string, requestId = REQUEST): string {
  return ["BM-REPORT", `requestId: ${requestId}`, "phase: blocked", "tier: Medium", "blockers: see BM-QUESTIONS", "", "BM-QUESTIONS", `requestId: ${requestId}`, questions].join(
    "\n",
  );
}

/** The Manager's turn that received the Worker's questions, materialised with the plugin's real deliveries. */
async function ask(questions: string, requestId = REQUEST, when = at(2)) {
  const record: TraceRecord = turn({ agentId: MANAGER, role: "manager", workspaceId: WORKSPACE_ID, endedAt: at(5), sent: [msg(MANAGER, when, report(questions, requestId), "agent")] });
  return materialiseTurn(record, { home, paseo, now: () => NOW, log, onSettled: onSettledHook(), workerOf: async () => WORKER });
}

/** A scope question: the recommended option has no effect, the other commits. */
const SCOPE_Q1 = ["Q1: Which date format on the invoices? [subject: date-format] [class: scope]", "- a: dd/mm/yyyy (recommended)", "- b: yyyy-mm-dd [effects: commit]"].join("\n");

/** Nothing reached any agent, and the Orchestrator was given no reason to wake. */
function expectNobodyWoken(opened: readonly Decision[], policy: AutonomyPolicy = autonomy().read()): void {
  expect(enqueued).toEqual([]);
  expect(sends).toEqual([]);
  expect(acted).toEqual([]);
  expect(decisionOpenedEventsOf(opened, policy)).toEqual([]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-autonomy-delegation-"));
  home = join(root, "data");
  logs = [];
  ids = 0;
  enqueued = [];
  sends = [];
  acted = [];
  queue.enqueue.mockClear();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearMaterialiserMemory();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The rule (shared/autonomy.ts), pure.
// ---------------------------------------------------------------------------

describe("which decisions the policy answers (recommendedDelegationOf)", () => {
  const scope = (overrides: Partial<Decision> = {}): Decision => {
    const options = [
      { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none" as const] },
      { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit" as const] },
    ];
    return {
      id: qid(1),
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: at(2),
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
      ...overrides,
    };
  };
  const policyWith = (cells: Record<string, unknown>, workspaceId = WORKSPACE_ID): AutonomyPolicy => ({ projects: { [workspaceId]: cells } as AutonomyPolicy["projects"], challenger: {} });

  it("answers an open decision of a delegate cell of the recommended predictor with its one recommended option", () => {
    expect(recommendedDelegationOf(policyWith({ scope: delegateCell() }), scope())).toEqual({
      optionKey: "a",
      class: "scope",
      predictor: "recommended",
      reason: "The recommended option: scope is delegated to it in this project",
    });
    expect(policyReasonOf("reversible-technical")).toBe("The recommended option: reversible-technical is delegated to it in this project");
  });

  it("answers nothing for an owner or shadow cell, the Orchestrator's predictor, another project's delegation, or a hard-owner class", () => {
    expect(recommendedDelegationOf(EMPTY_AUTONOMY_POLICY, scope())).toBeNull();
    expect(recommendedDelegationOf(policyWith({ scope: { mode: "owner", at: "T" } }), scope())).toBeNull();
    expect(recommendedDelegationOf(policyWith({ scope: { mode: "shadow", at: "T" } }), scope())).toBeNull();
    expect(recommendedDelegationOf(policyWith({ scope: delegateCell("orchestrator") }), scope())).toBeNull();
    expect(recommendedDelegationOf(policyWith({ scope: delegateCell() }, "wks_other"), scope())).toBeNull();
    // A delegate cell of a hard-owner class never reads, whatever the policy object says (REQ-121 c)…
    for (const hard of ["release", "data", "security", "cost"] as const) {
      expect(recommendedDelegationOf(policyWith({ [hard]: delegateCell() }), scope({ class: hard })), hard).toBeNull();
    }
    // …and an option's release effect makes a delegated scope question a release one.
    const pushing = scope({ options: [{ key: "a", label: "Push it", recommended: true, effects: ["push"] }, { key: "b", label: "Hold", recommended: false, effects: [] }] });
    expect(recommendedDelegationOf(policyWith({ scope: delegateCell(), release: delegateCell() }), pushing)).toBeNull();
  });

  it("answers nothing without exactly one recommended option, or once the decision is not open", () => {
    const delegated = policyWith({ scope: delegateCell() });
    expect(recommendedDelegationOf(delegated, scope({ options: scope().options.map((option) => ({ ...option, recommended: false })) }))).toBeNull();
    expect(recommendedDelegationOf(delegated, scope({ options: [] }))).toBeNull();
    expect(recommendedDelegationOf(delegated, scope({ status: "needs-confirmation", needsConfirmation: { via: "chat-worker", at: at(3) } }))).toBeNull();
    expect(recommendedDelegationOf(delegated, scope({ status: "withdrawn", settledAt: at(3) }))).toBeNull();
  });

  it("the policy never stores an answer granting a release, data, security or cost effect (the second line under the class)", () => {
    const pushing = scope({ class: "scope", options: [{ key: "a", label: "Push it", recommended: true, effects: ["push", "commit"] }] });
    const refused = answerDecision(pushing, { by: "policy", via: "inbox", optionKey: "a", predictor: "recommended", at: NOW.toISOString() });
    expect(refused).toEqual({ ok: false, refusal: "invalid-answer", message: "the policy never answers with an option that allows push; only the owner does" });
    // The owner may: the X-4 confirmation is the RPC's.
    expect(answerDecision(pushing, { via: "inbox", optionKey: "a", at: NOW.toISOString() }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A Worker's question (q:), through the materialiser.
// ---------------------------------------------------------------------------

describe("a Worker's question opening in a delegated class", () => {
  it("is answered at open by the policy and delivered to the Worker in the same BM-ANSWERS form as an owner answer", async () => {
    delegate("scope");
    const questions = [SCOPE_Q1, "Q2: Keep the old export? [class: preference]", "- a: Keep it (recommended)", "- b: Drop it"].join("\n");
    const outcome = await ask(questions);

    const answered = stored(qid(1));
    expect(answered).toMatchObject({
      status: "answered",
      settledAt: NOW.toISOString(),
      answer: {
        by: "policy",
        via: "inbox",
        optionKey: "a",
        words: null,
        at: NOW.toISOString(),
        class: "scope",
        predictor: "recommended",
        reason: "The recommended option: scope is delegated to it in this project",
      },
      grant: null,
      delivery: { to: WORKER, kind: `answers:${REQUEST}`, at: NOW.toISOString(), outcome: "sent" },
    });
    // Q2's class is not delegated: it stays the owner's.
    expect(stored(qid(2))).toMatchObject({ status: "open", answer: null });
    expect(outcome.answered.map((decision) => decision.id)).toEqual([qid(1)]);

    // Exactly what an owner answer of the same option would have sent: one block, Q1 only, nothing about the policy.
    const asOwner = { ...answered, answer: { by: "owner" as const, via: "inbox" as const, optionKey: "a", words: null, at: NOW.toISOString() } };
    expect(enqueued).toEqual([{ target: WORKER, kind: `answers:${REQUEST}`, text: answersMessageOf(REQUEST, [asOwner]) }]);
    expect(enqueued[0]!.text).toBe(`BM-DELIVERY answers\nContinue ${REQUEST}.\n\nBM-ANSWERS\nrequestId: ${REQUEST}\nQ1: a — dd/mm/yyyy`);
    expect(sends).toEqual([]);
    // Answered as it opened: no decision.opened wakes the Orchestrator for it; Q2 is the owner's (no challenger): nor for it.
    expect(decisionOpenedEventsOf(outcome.opened, autonomy().read())).toEqual([]);
  });

  it("grants the recommended option's effects as the owner's choice of it would", async () => {
    delegate("dependency");
    await ask(["Q1: Install Postgres for the tests? [class: dependency]", "- a: Use the container image (recommended) [effects: dependency-install]", "- b: Stay on SQLite"].join("\n"));
    expect(stored(qid(1))).toMatchObject({
      answer: { by: "policy", optionKey: "a", class: "dependency" },
      grant: { effects: ["dependency-install"], expiresAt: "2026-09-26T11:05:00.000Z", usedAt: null },
    });
    expect(enqueued).toHaveLength(1);
  });

  it("is never answered by code in an owner or shadow cell, or a cell of the Orchestrator's predictor, and nothing is delivered", async () => {
    const setups: Array<[string, () => void]> = [
      ["owner (no cell)", () => {}],
      ["owner (set)", () => autonomy().set({ workspaceId: WORKSPACE_ID, class: "scope", mode: "owner" }, NOW.toISOString())],
      ["shadow", () => autonomy().set({ workspaceId: WORKSPACE_ID, class: "scope", mode: "shadow" }, NOW.toISOString())],
      ["delegate to the Orchestrator", () => delegate("scope", "orchestrator")],
      ["delegated in another project only", () => delegate("scope", "recommended", "wks_other")],
    ];
    for (const [index, [name, setUp]] of setups.entries()) {
      autonomy().reset(WORKSPACE_ID);
      setUp();
      const requestId = `req-20260930T09500${index}Z`;
      const outcome = await ask(SCOPE_Q1, requestId);
      expect(stored(qid(1, requestId)), name).toMatchObject({ status: "open", answer: null, delivery: null });
      expect(outcome.answered, name).toEqual([]);
    }
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("is never answered for release, data, security or cost, even with a hand-written file delegating them, and it wakes nobody", async () => {
    writePolicyFile({
      release: delegateCell(),
      data: delegateCell(),
      security: delegateCell(),
      cost: delegateCell(),
      "reversible-technical": delegateCell(),
      scope: delegateCell(),
    });
    const questions = [
      // Proposed as reversible-technical, but its recommended option pushes: a release question.
      "Q1: Push the date fix to origin/dev? [class: reversible-technical]",
      "- a: Push it (recommended) [effects: push]",
      "- b: Hold",
      // Proposed as security with no effect declared.
      "Q2: Rotate the API key the tests use? [class: security]",
      "- a: Rotate it (recommended)",
      "- b: Keep it",
      // A scope question whose other option migrates: the whole decision is data.
      "Q3: Where does the list live? [class: scope]",
      "- a: The existing table (recommended)",
      "- b: A new table [effects: migration]",
    ].join("\n");
    const outcome = await ask(questions);
    for (const n of [1, 2, 3]) expect(stored(qid(n)), `Q${n}`).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(outcome.answered).toEqual([]);
    expectNobodyWoken(outcome.opened);
  });

  it("is left open without a recommended option", async () => {
    delegate("scope");
    const outcome = await ask(["Q1: Which date format? [class: scope]", "- a: dd/mm/yyyy", "- b: yyyy-mm-dd"].join("\n"));
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null });
    expect(outcome.answered).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("an owner precedent on its subject comes first: it answers, and the policy does not", async () => {
    delegate("scope");
    const precedent = createPrecedentStore(home, { newId: () => "prec-1" }).save(
      { scope: WORKSPACE_ID, subject: "date-format", text: "yyyy-mm-dd", sourceDecisionId: null, expiresInDays: 30 },
      NOW,
    ).precedent;
    await ask(SCOPE_Q1);
    expect(stored(qid(1)).answer).toMatchObject({ by: "precedent", optionKey: "b", precedentId: precedent.id });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.text).toContain(`Q1 was answered by the owner's precedent ${precedent.id}`);
  });

  it("a subject it already answered in the request, asked again, is the owner's: the answer did not do, and the class goes back to shadow", async () => {
    delegate("scope");
    await ask(SCOPE_Q1);
    expect(stored(qid(1)).answer).toMatchObject({ by: "policy" });
    enqueued = [];

    await ask(["Q2: Which date format, now the export is CSV too? [subject: date-format] [class: scope]", "- a: dd/mm/yyyy (recommended)", "- b: ISO 8601"].join("\n"), REQUEST, at(8));
    expect(stored(qid(2))).toMatchObject({ status: "open", answer: null });
    expect(enqueued).toEqual([]);
    // The re-ask reverses the policy's answer and demotes the class (§B.4), with its Inbox alert.
    expect(stored(qid(1)).reversals).toEqual([{ kind: "re-asked", at: at(8), ref: qid(2) }]);
    expect(autonomy().read().projects[WORKSPACE_ID]?.scope).toMatchObject({ mode: "shadow" });
    expect(createAlertStore(home).list({ open: true, kinds: ["autonomy-demoted"] }).map((alert) => alert.key)).toEqual([`autonomy-demoted:${WORKSPACE_ID}:scope`]);
    // The next scope question of another request is the owner's too.
    const next = "req-20260930T096000Z";
    await ask(SCOPE_Q1, next, at(9));
    expect(stored(qid(1, next))).toMatchObject({ status: "open" });
  });

  it("autonomy.reset stops all delegation of the project at once", async () => {
    delegate("scope");
    autonomy().reset(WORKSPACE_ID);
    await ask(SCOPE_Q1);
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null });
    expect(enqueued).toEqual([]);
  });

  it("the ledger counts the policy's answer as delegated, never as an owner agreement", async () => {
    delegate("scope");
    await ask(SCOPE_Q1);
    const ledger = agreementLedger(decisions().list({ workspaceId: WORKSPACE_ID, statuses: ["answered"] }), { workspaceId: WORKSPACE_ID });
    expect(ledger.cells).toEqual([]);
    expect(ledger.delegated).toMatchObject([{ workspaceId: WORKSPACE_ID, class: "scope", by: "policy", predictor: "recommended", count: 1, overridden: 0, reversals: 0 }]);
  });

  it("answers nothing and logs one line when the policy cannot be read", () => {
    delegate("scope");
    const opened = decisions().open(scopeQuestion()).decision;
    // A symlink where the policy was is refused by the store's read: every class reads owner.
    const path = join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE);
    rmSync(path);
    writeFileSync(join(root, "elsewhere.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), path);
    expect(resolveByPolicy(opened, { home, now: NOW, log })).toEqual({ decision: opened, resolved: false });
    expect(stored(opened.id)).toMatchObject({ status: "open", answer: null });
    expect(logs.join("\n")).toContain("could not read the autonomy policy");
  });

  it("answers nothing once the decision is settled meanwhile: checked again in the write that answers it", () => {
    delegate("scope");
    const opened = decisions().open(scopeQuestion()).decision;
    decisions().transition(opened.id, (current) => answerDecision(current, { via: "inbox", optionKey: "b", at: NOW.toISOString() }), WORKSPACE_ID);
    // The caller still holds the open copy it read before the owner answered.
    expect(resolveByPolicy(opened, { home, now: NOW, log })).toMatchObject({ resolved: false, decision: { answer: { by: "owner", optionKey: "b" } } });
  });
});

/** An open scope question as the materialiser stores it, on another request (for the direct resolver tests). */
function scopeQuestion(): Decision {
  const options = [
    { key: "a", label: "dd/mm/yyyy", recommended: true, effects: [] },
    { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit" as const] },
  ];
  return {
    id: qid(1, "req-20260930T097000Z"),
    workspaceId: WORKSPACE_ID,
    requestId: "req-20260930T097000Z",
    askedBy: { role: "worker", agentId: WORKER },
    askedAt: at(2),
    round: 1,
    question: "Which date format?",
    subject: null,
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
  };
}

// ---------------------------------------------------------------------------
// An Orchestrator decision (o:), through bm_ask_owner.
// ---------------------------------------------------------------------------

describe("an Orchestrator decision opening in a delegated class", () => {
  async function tools() {
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: WORKSPACE_ID }));
    const created = createOrchestratorTools({
      env: { PASEO_BM_HOME: home },
      homedir: () => root,
      now: () => NOW,
      redactEnv: {},
      newId: () => `0b6f-${++ids}`,
      log,
      queue,
      onSettled: onSettledHook(),
    });
    created.usePaseo(paseo);
    return created;
  }
  const factsOf = (text: string) => JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
  const COMMIT_BODY = "Commit the date fix on the feature branch.";
  const commitAsk = {
    workspaceId: WORKSPACE_ID,
    requestId: REQUEST,
    question: "Commit the date fix now?",
    recommendation: "Yes: the review passed.",
    options: [
      { label: "Commit the date fix", effects: ["commit"], recommended: true, command: { to: "manager", agentId: MANAGER, intent: "continue", body: COMMIT_BODY } },
      { label: "Hold", effects: ["none"] },
    ],
  };

  it("with a prepared command: answered at once and delivered as a BM-COMMAND v2 with authority policy:<class>, approved = the option's effects, the grant spent", async () => {
    delegate("reversible-technical");
    const result = await (await tools()).call("bm_ask_owner", commitAsk);
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain(
      "Answered at once by the owner's policy: reversible-technical is delegated to the recommended option in this project (option a: Commit the date fix); the owner is not asked.",
    );
    expect(result.text).toContain("The plugin delivers the option's command itself, on the policy's authority (policy:reversible-technical).");
    const facts = factsOf(result.text);
    expect(facts).toEqual({ decisionId: "o:0b6f-1", replaced: null, class: "reversible-technical", answeredBy: "policy", predictor: "recommended" });

    const decision = stored("o:0b6f-1");
    expect(decision).toMatchObject({
      status: "answered",
      answer: { by: "policy", via: "inbox", optionKey: "a", class: "reversible-technical", predictor: "recommended" },
      grant: { effects: ["commit"], usedAt: NOW.toISOString() },
      delivery: { to: MANAGER, kind: "command:o:0b6f-1", outcome: "sent" },
    });
    // One command, to that Manager only; nothing to the Orchestrator, nothing sent around the queue.
    expect(enqueued.map(({ target, kind }) => [target, kind])).toEqual([[MANAGER, "command:o:0b6f-1"]]);
    expect(parseCommandBlock(enqueued[0]!.text)).toEqual({
      version: 2,
      from: "orchestrator",
      via: "chat",
      to: "manager",
      copy: false,
      requestId: REQUEST,
      re: "Commit the date fix",
      intent: "continue",
      effects: ["commit"],
      authority: "policy:reversible-technical",
      approved: ["commit"],
      limits: limitsOf(["commit"]),
      body: COMMIT_BODY,
      why: 'Policy chose "Commit the date fix" on decision o:0b6f-1.',
    });
    expect(sends).toEqual([]);
  });

  it("without a command: the Orchestrator gets the BM-ANSWER naming the policy, with the grant", async () => {
    delegate("scope");
    const result = await (await tools()).call("bm_ask_owner", {
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      question: "Which date format on the invoices?",
      recommendation: "dd/mm/yyyy: the customers are in Vietnam.",
      class: "scope",
      options: [{ label: "dd/mm/yyyy", effects: ["none"], recommended: true }, { label: "yyyy-mm-dd", effects: ["commit"] }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("It comes back to you as a BM-ANSWER notice that names the policy; act on it as the owner's answer.");
    expect(enqueued.map(({ target, kind }) => [target, kind])).toEqual([[ORCHESTRATOR, "answer:o:0b6f-1"]]);
    expect(enqueued[0]!.text).toMatch(/^BM-ANSWER\ndecisionId: o:0b6f-1\n/);
    expect(enqueued[0]!.text).toContain("answer: option a: dd/mm/yyyy");
    expect(enqueued[0]!.text).toContain("policy: scope is delegated to the recommended option in this project; the owner was not asked");
  });

  it("is never answered by code in an owner cell, nor for a release (a hand-written file delegating it aside): asked, and nothing sent", async () => {
    const asked = await (await tools()).call("bm_ask_owner", commitAsk);
    expect(asked.text).toMatch(/^Asked\. /);
    expect(stored("o:0b6f-1")).toMatchObject({ status: "open", answer: null });

    writePolicyFile({ release: delegateCell(), "reversible-technical": delegateCell() });
    const push = await (await tools()).call("bm_ask_owner", {
      ...commitAsk,
      separate: true,
      question: "Push the date fix to origin/dev?",
      options: [
        { label: "Push the date fix", effects: ["push"], recommended: true, command: { to: "manager", agentId: MANAGER, intent: "release", body: "Push the date fix to origin/dev." } },
        { label: "Hold", effects: ["none"] },
      ],
    });
    expect(push.text).toMatch(/^Asked\. /);
    expect(factsOf(push.text)).toMatchObject({ class: "release" });
    expect(stored("o:0b6f-2")).toMatchObject({ status: "open", answer: null, grant: null });
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("the guard: a policy answer whose grant would hold a release effect sends no command and spends nothing", async () => {
    // Forged in the store: answerDecision would refuse it, and the class would make it the owner's. The command
    // builder refuses a policy authority approving it (code review 2026-09-30 §6); the delivery keeps no copy of that rule.
    const forged: Decision = {
      id: "o:forged-policy-push",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "orchestrator", agentId: ORCHESTRATOR },
      askedAt: at(2),
      round: null,
      question: "Push the date fix?",
      subject: null,
      options: [
        {
          key: "a",
          label: "Push it",
          recommended: true,
          effects: ["push"],
          action: { kind: "command", to: "manager", agentId: MANAGER, intent: "release", body: "Push the date fix to origin/dev.", effects: ["push"] },
        },
      ],
      status: "answered",
      settledAt: NOW.toISOString(),
      needsConfirmation: null,
      answer: { by: "policy", via: "inbox", optionKey: "a", words: null, at: NOW.toISOString(), class: "reversible-technical", predictor: "recommended" },
      grant: { effects: ["push"], expiresAt: "2026-09-26T11:05:00.000Z", usedAt: null },
      delivery: null,
      supersedes: null,
      supersededBy: null,
    };
    decisions().open(forged);
    await onSettledHook()([forged], { paseo });
    // Nothing to the Manager; the Orchestrator is told why, and the grant is unused.
    expect(enqueued.map(({ target }) => target)).toEqual([ORCHESTRATOR]);
    expect(enqueued[0]!.text).toContain("delivery: the prepared command was not delivered (the command cannot be sent as a BM-COMMAND block: the owner's policy never approves push");
    expect(stored(forged.id)).toMatchObject({ grant: { usedAt: null }, delivery: { to: MANAGER, outcome: "failed" } });
  });
});

// ---------------------------------------------------------------------------
// A fallback incident (f:), through the fallback decisions' pass.
// ---------------------------------------------------------------------------

const INCIDENT: FallbackIncident = {
  id: "fb-000000000d01",
  role: "worker",
  workspaceId: WORKSPACE_ID,
  requestId: REQUEST,
  agentId: WORKER,
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: MANAGER,
  managerId: MANAGER,
  class: "L1",
  signal: "failed",
  message: "You've hit your usage limit.",
  perModelWindow: false,
  // Ten minutes away: the `auto` policy would wait, so Wait is the recommended option.
  resetsAt: "2026-09-26T10:15:00.000Z",
  candidate: null,
  status: "pending",
  detectedAt: "2026-09-26T10:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
};

describe("a fallback incident opening in a delegated environment class", () => {
  const FID = `f:${INCIDENT.id}`;
  const writeIncident = () => writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents: [INCIDENT] }));
  beforeEach(() => mkdirSync(home, { recursive: true }));

  it("is answered with its recommended option and runs it through fallback.act, when the pass can deliver it", async () => {
    delegate("environment");
    writeIncident();
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled: onSettledHook(), paseo } });
    expect(stored(FID)).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "wait", class: "environment", predictor: "recommended" } });
    await vi.waitFor(() => expect(acted).toEqual([{ incidentId: INCIDENT.id, action: "wait" }]));
    await vi.waitFor(() => expect(stored(FID).delivery).toMatchObject({ kind: "fallback:wait", outcome: "sent" }));
  });

  it("stays open in the start-up pass (no delivery), in an owner cell, and when a precedent names none of its options", () => {
    delegate("environment");
    writeIncident();
    syncFallbackDecisions(home, { now: () => NOW, log });
    expect(stored(FID)).toMatchObject({ status: "open" });

    rmSync(join(home, "decisions"), { recursive: true });
    clearDecisionStoreCache();
    autonomy().reset(WORKSPACE_ID);
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled: onSettledHook(), paseo } });
    expect(stored(FID)).toMatchObject({ status: "open" });

    // The owner's standing words bear on it: they, not the recommended option, are shown; the owner decides.
    rmSync(join(home, "decisions"), { recursive: true });
    clearDecisionStoreCache();
    delegate("environment");
    createPrecedentStore(home, { newId: () => "prec-2" }).save(
      { scope: WORKSPACE_ID, subject: "fallback-worker", text: "Always switch to Codex", sourceDecisionId: null, expiresInDays: 30 },
      NOW,
    );
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled: onSettledHook(), paseo } });
    expect(stored(FID)).toMatchObject({ status: "open" });
    expect(acted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Delegation to the Orchestrator: bm_decide (bead t9lm.11).
// ---------------------------------------------------------------------------

describe("a decision opening in a class delegated to the Orchestrator (bm_decide)", () => {
  const FID = `f:${INCIDENT.id}`;
  async function decideTools() {
    await appendRecord({ tracesDir: join(home, "traces") }, turn({ workspaceId: WORKSPACE_ID }));
    const created = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, redactEnv: {}, log, queue, onSettled: onSettledHook() });
    created.usePaseo(paseo);
    return created;
  }
  const decide = async (decisionId: string, optionKey: string, reason = "The owner chose this the last three times.") =>
    (await decideTools()).call("bm_decide", { decisionId, optionKey, reason });

  it("a Worker's question is not answered at open; it asks the Orchestrator, whose bm_decide reaches the Worker exactly as an owner answer", async () => {
    delegate("scope", "orchestrator");
    const outcome = await ask(SCOPE_Q1);
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null });
    expect(outcome.answered).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(decisionOpenedEventsOf(outcome.opened, autonomy().read())).toEqual([expect.objectContaining({ decisionId: qid(1), asks: "decision" })]);

    const result = await decide(qid(1), "b", "ISO dates sort in the export the accountant reads.");
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("The Worker has it now, as the plugin's BM-DELIVERY.");
    const answered = stored(qid(1));
    expect(answered).toMatchObject({
      status: "answered",
      answer: { by: "policy", via: "inbox", optionKey: "b", class: "scope", predictor: "orchestrator", reason: "ISO dates sort in the export the accountant reads." },
      grant: { effects: ["commit"], usedAt: null },
      delivery: { to: WORKER, kind: `answers:${REQUEST}`, at: NOW.toISOString(), outcome: "sent" },
    });
    // Exactly what an owner answer of the same option would have sent: nothing about the policy or the Orchestrator.
    const asOwner = { ...answered, answer: { by: "owner" as const, via: "inbox" as const, optionKey: "b", words: null, at: NOW.toISOString() } };
    expect(enqueued).toEqual([{ target: WORKER, kind: `answers:${REQUEST}`, text: answersMessageOf(REQUEST, [asOwner]) }]);
    expect(sends).toEqual([]);
    // The ledger counts it as delegated to the Orchestrator's predictor, never as an owner agreement.
    const ledger = agreementLedger(decisions().list({ workspaceId: WORKSPACE_ID, statuses: ["answered"] }), { workspaceId: WORKSPACE_ID });
    expect(ledger.cells).toEqual([]);
    expect(ledger.delegated).toMatchObject([{ class: "scope", by: "policy", predictor: "orchestrator", count: 1 }]);
  });

  it("a fallback incident stays open at the pass, asks the Orchestrator, and bm_decide runs its option through fallback.act", async () => {
    mkdirSync(home, { recursive: true });
    delegate("environment", "orchestrator");
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents: [INCIDENT] }));
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled: onSettledHook(), paseo } });
    expect(stored(FID)).toMatchObject({ status: "open", answer: null });
    expect(decisionOpenedEventsOf([stored(FID)], autonomy().read())).toEqual([expect.objectContaining({ decisionId: FID, requestId: REQUEST, askedBy: null, asks: "decision" })]);

    const result = await decide(FID, "wait", "The limit resets in ten minutes.");
    expect(result.ok, result.text).toBe(true);
    expect(acted).toEqual([{ incidentId: INCIDENT.id, action: "wait" }]);
    expect(stored(FID)).toMatchObject({
      status: "answered",
      answer: { by: "policy", optionKey: "wait", class: "environment", predictor: "orchestrator" },
      delivery: { kind: "fallback:wait", outcome: "sent" },
    });
    expect(result.text).toContain("The plugin ran the option's action on the incident.");
  });

  it("a new incident's listener hands its open decision to the event bus (onDecisionsOpened), as stored", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy: "ask", entries: [] } } }));
    delegate("environment", "orchestrator");
    const opened: Array<{ ids: string[]; paseo: unknown }> = [];
    const daemon = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({ agent: { id, labels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER } } }),
          send: async (text: string) => void sends.push({ id, text }),
        }),
      },
      providers: { listAvailable: async () => ({ providers: [] }) },
      config: { get: async () => ({ config: { providers: { "bm-worker": { extends: "claude" } } } }) },
    };
    const remove = registerFallbackRpcs({ handle: vi.fn() } as never, {}, {
      onDecisionsOpened: (decisions, handle) => void opened.push({ ids: decisions.map((decision) => decision.id), paseo: handle }),
    });
    try {
      await recordIncident(
        { agent: { id: WORKER, provider: "bm-worker/claude-opus-5", workspaceId: WORKSPACE_ID } },
        { class: "L2", signal: "failed", message: "credit balance too low" },
        { paseo: daemon, home, log, now: () => NOW, randomHex: () => "000000000d02" },
      );
    } finally {
      remove();
    }
    expect(opened).toEqual([{ ids: ["f:fb-000000000d02"], paseo: daemon }]);
    const decision = stored("f:fb-000000000d02");
    expect(decision).toMatchObject({ status: "open", answer: null });
    expect(decisionOpenedEventsOf([decision], autonomy().read())).toEqual([expect.objectContaining({ asks: "decision" })]);
    expect(sends).toEqual([]);
  });

  it("never a release, data, security or cost decision, and never a command approving one without the owner's grant", async () => {
    // Every class delegated to the Orchestrator, release to boot through a hand-written file (it never reads).
    writePolicyFile(
      Object.fromEntries(["release", "data", "security", "cost", "reversible-technical", "scope", "preference", "environment", "dependency"].map((c) => [c, delegateCell("orchestrator")])),
    );
    const outcome = await ask(
      [
        "Q1: Push the date fix to origin/dev? [class: reversible-technical]",
        "- a: Push it (recommended) [effects: push]",
        "- b: Hold",
        "Q2: Rotate the API key the tests use? [class: security]",
        "- a: Rotate it (recommended)",
        "- b: Keep it",
        "Q3: Which date format? [class: scope]",
        "- a: dd/mm/yyyy (recommended)",
        "- b: yyyy-mm-dd [effects: commit]",
      ].join("\n"),
    );
    // The release and security questions wake nobody and cannot be decided; the scope one can.
    expect(decisionOpenedEventsOf(outcome.opened, autonomy().read()).map((event) => [event.decisionId, event.asks])).toEqual([[qid(3), "decision"]]);
    for (const [n, decisionClass] of [[1, "release"], [2, "security"]] as const) {
      for (const optionKey of ["a", "b"]) {
        const refused = await decide(qid(n), optionKey);
        expect(refused, `Q${n} ${optionKey}`).toEqual({ ok: false, text: `Refused: decision ${qid(n)} is of the class ${decisionClass}, which is always the owner's; leave it to the owner.` });
      }
      expect(stored(qid(n))).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    }
    expect((await decide(qid(3), "b")).ok).toBe(true);
    enqueued = [];

    const tools = await decideTools();
    const pushCommand = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, intent: "release", command: "Push the date fix to origin/dev.", reason: "Delegated." };
    // With every delegable class delegated, a command declaring a hard-owner effect still needs the owner's decision…
    for (const effect of ["push", "publish", "deploy", "real-data", "migration", "security", "cost"]) {
      const sent = await tools.call("bm_send_command", { ...pushCommand, effects: [effect] });
      expect(sent.ok, effect).toBe(false);
      expect(sent.text, effect).toContain(`${effect} needs the owner's decision`);
    }
    // …and the grant of a question it decided never authorises a command: only the owner's answer to its own decision does.
    const onGrant = await tools.call("bm_send_command", { ...pushCommand, effects: ["commit"], intent: "continue", command: "Commit the date fix.", decisionId: qid(3) });
    expect(onGrant.ok).toBe(false);
    expect(onGrant.text).toContain(`${qid(3)} is not a decision you asked`);
    expect(enqueued).toEqual([]);
    // What would carry it — a policy authority approving a release effect — cannot be written.
    expect(() =>
      commandBlockOf({ from: "orchestrator", via: "chat", to: "manager", requestId: REQUEST, re: "Push", body: "Push it.", why: "Policy.", intent: "release", effects: ["push"], authority: "policy:scope", approved: ["push"] }),
    ).toThrow(/the owner's policy never approves push/);
  });
});

// ---------------------------------------------------------------------------
// A finished-unverified request: no delegate acts on it (design §C.3, §C.6 change-008 C4; bead 7gxw.4).
// ---------------------------------------------------------------------------

describe("a finished-unverified request: a delegate cannot act on it as done (design §C.6, change-008 C4)", () => {
  const traces = () => ({ tracesDir: join(home, "traces") });
  const UNVERIFIED = `request ${REQUEST} finished unverified: its code changed and not every check its report names was seen to pass after the last edit, so a commit or release on it is the owner's to decide`;

  /**
   * The request's Worker edited a file, then its Manager got a `finished`
   * report naming `npm test`, at `minute`. `checked`: the Worker ran `npm test`
   * after the edit and it passed (detected); else it never ran (self-reported).
   */
  async function finish(checked: boolean, minute: number): Promise<void> {
    await appendRecord(
      traces(),
      turn({
        agentId: WORKER,
        role: "worker",
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST,
        at: at(minute),
        endedAt: at(minute),
        evidence: [
          { kind: "file", detail: "src/invoice.ts", agentId: WORKER, at: at(minute - 1) },
          ...(checked ? [{ kind: "shell" as const, detail: "npm test", agentId: WORKER, at: at(minute - 1, 30), status: "completed" }] : []),
        ],
      }),
    );
    await appendRecord(
      traces(),
      turn({
        agentId: MANAGER,
        role: "manager",
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST,
        at: at(minute, 30),
        endedAt: at(minute, 30),
        reports: [reportOf({ agentId: MANAGER, at: at(minute, 10), requestId: REQUEST, phase: "finished", filesChanged: ["src/invoice.ts"], buildAndTests: "`npm test` pass" })],
      }),
    );
  }

  /** The Worker's questions alone (no report), reaching its Manager after the finish: the finish still stands. */
  async function askAfterFinish(questions: string, when = at(4, 40)) {
    const text = ["BM-QUESTIONS", `requestId: ${REQUEST}`, questions].join("\n");
    const record: TraceRecord = turn({ agentId: MANAGER, role: "manager", workspaceId: WORKSPACE_ID, endedAt: at(5), sent: [msg(MANAGER, when, text, "agent")] });
    return materialiseTurn(record, { home, paseo, now: () => NOW, log, onSettled: onSettledHook(), workerOf: async () => WORKER });
  }

  const COMMIT_Q = (n: number) =>
    [`Q${n}: Commit the invoice fix on the branch? [class: reversible-technical]`, "- a: Commit it (recommended) [effects: commit]", "- b: Hold"].join("\n");

  async function tools() {
    const created = createOrchestratorTools({
      env: { PASEO_BM_HOME: home },
      homedir: () => root,
      now: () => NOW,
      redactEnv: {},
      newId: () => `0c7a-${++ids}`,
      log,
      queue,
      onSettled: onSettledHook(),
    });
    created.usePaseo(paseo);
    return created;
  }
  const ownerAnswers = (id: string, optionKey: string) =>
    handleDecisionsAnswer({ id, optionKey }, paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled: onSettledHook() });
  const COMMIT_BODY = "Commit the invoice fix on the feature branch.";
  const commitAsk = (command: boolean) => ({
    workspaceId: WORKSPACE_ID,
    requestId: REQUEST,
    question: "Commit the invoice fix now?",
    recommendation: "Yes: the Worker says the tests pass.",
    separate: true,
    options: [
      { label: "Commit the invoice fix", effects: ["commit"], recommended: true, ...(command ? { command: { to: "manager", agentId: MANAGER, intent: "continue", body: COMMIT_BODY } } : {}) },
      { label: "Hold", effects: ["none"] },
    ],
  });

  it("the rule: an option acts on the finish when it declares commit, or its command approves commit or releases", () => {
    const option = (effects: Decision["options"][number]["effects"], action?: Decision["options"][number]["action"]) => ({ effects, ...(action === undefined ? {} : { action }) });
    const command = (intent: "continue" | "release", effects: Decision["options"][number]["effects"]) =>
      ({ kind: "command", to: "manager", agentId: MANAGER, intent, body: "Do it.", effects }) as const;
    expect(actsOnFinish(option(["commit"]))).toBe(true);
    expect(actsOnFinish(option(["none"], command("continue", ["commit"])))).toBe(true);
    expect(actsOnFinish(option(["none"], command("release", [])))).toBe(true);
    expect(actsOnFinish(option(["none"], command("continue", ["none"])))).toBe(false);
    expect(actsOnFinish(option(["dependency-install"]))).toBe(false);
    expect(commandActsOnFinish({ approved: ["commit"], intent: "continue" })).toBe(true);
    expect(commandActsOnFinish({ approved: [], intent: "release" })).toBe(true);
    expect(commandActsOnFinish({ approved: ["network"], intent: "continue" })).toBe(false);

    const decision = { id: qid(1), requestId: REQUEST, options: [{ key: "a", label: "Commit it", recommended: true, effects: ["commit" as const] }, { key: "b", label: "Hold", recommended: false, effects: [] }] };
    expect(unverifiedFinishRefusalOf(decision, "a", true)).toBe(`${UNVERIFIED}; leave decision ${qid(1)} to the owner`);
    expect(unverifiedFinishRefusalOf(decision, "b", true)).toBeNull();
    expect(unverifiedFinishRefusalOf(decision, "a", false)).toBeNull();
    // bm_decide's rule: the same refusal, after every other rule passed; without a choice (the event bus), none.
    const delegated: AutonomyPolicy = { projects: { [WORKSPACE_ID]: { "reversible-technical": delegateCell("orchestrator") } } as AutonomyPolicy["projects"], challenger: {} };
    const open: Decision = { ...scopeQuestion(), id: qid(1), requestId: REQUEST, class: "reversible-technical", options: decision.options, prediction: openingPrediction(decision.options) };
    expect(decideRefusalOf(delegated, open)).toBeNull();
    expect(decideRefusalOf(delegated, open, { optionKey: "a", finishedUnverified: true })).toBe(`${UNVERIFIED}; leave decision ${qid(1)} to the owner`);
    expect(decideRefusalOf(delegated, open, { optionKey: "b", finishedUnverified: true })).toBeNull();

    // The recommended predictor's resolver: told the request is finished-unverified, it leaves the commit open; else it answers.
    delegate("reversible-technical");
    const stored1 = decisions().open(open).decision;
    expect(resolveByPolicy(stored1, { home, now: NOW, log, finishedUnverified: true })).toEqual({ decision: stored1, resolved: false });
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null });
    expect(resolveByPolicy(stored1, { home, now: NOW, log }).resolved).toBe(true);
  });

  it("(a) at open: the recommended predictor does not commit on a finished-unverified request; the owner's own answer is accepted", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    const outcome = await askAfterFinish(COMMIT_Q(1));
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(outcome.answered).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(logs.join("\n")).toContain(`the policy left decision ${qid(1)} to the owner: ${UNVERIFIED}`);

    // bm_ask_owner, with the command prepared: not answered at once, and the tool says why.
    const asked = await (await tools()).call("bm_ask_owner", commitAsk(true));
    expect(asked.text).toMatch(/^Asked\. /);
    expect(asked.text).toContain("Its request finished unverified: while it stands so, the owner's policy chooses no option that commits or releases, so the owner decides those.");
    const oid = `o:0c7a-1`;
    expect(stored(oid)).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);

    // The owner's own answers stand, and are delivered as ever: the Worker's question, and the prepared command on the decision's authority.
    expect((await ownerAnswers(qid(1), "a")).decision).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "a" }, grant: { effects: ["commit"] } });
    expect(enqueued.map(({ target, kind }) => [target, kind])).toEqual([[WORKER, `answers:${REQUEST}`]]);
    expect((await ownerAnswers(oid, "a")).decision).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "a" } });
    expect(enqueued.map(({ target, kind }) => [target, kind])).toEqual([
      [WORKER, `answers:${REQUEST}`],
      [MANAGER, `command:${oid}`],
    ]);
    expect(parseCommandBlock(enqueued[1]!.text)).toMatchObject({ authority: `decision:${oid}`, approved: ["commit"], body: COMMIT_BODY });
  });

  it("(a) at open: an option that does not act on the finish is still answered, and so is a commit once a new finish is detected", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    await askAfterFinish(["Q1: Rename the helper? [class: reversible-technical]", "- a: Rename it (recommended)", "- b: Keep it"].join("\n"));
    expect(stored(qid(1)).answer).toMatchObject({ by: "policy", optionKey: "a" });

    // The Worker ran its check after the last edit and finished again: the finish is verified.
    await finish(true, 4);
    await askAfterFinish(COMMIT_Q(2), at(4, 50));
    expect(stored(qid(2))).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "a", predictor: "recommended" }, grant: { effects: ["commit"] } });
  });

  it("(a) at open: a precedent's answer is the owner's standing word and is not refused", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    const precedent = createPrecedentStore(home, { newId: () => "prec-commit" }).save(
      { scope: WORKSPACE_ID, subject: "commit-invoice-fix", text: "Commit it", sourceDecisionId: null, expiresInDays: 30 },
      NOW,
    ).precedent;
    await askAfterFinish([`Q1: Commit the invoice fix on the branch? [subject: commit-invoice-fix] [class: reversible-technical]`, "- a: Commit it (recommended) [effects: commit]", "- b: Hold"].join("\n"));
    expect(stored(qid(1)).answer).toMatchObject({ by: "precedent", optionKey: "a", precedentId: precedent.id });
  });

  it("(a) bm_decide: choosing a commit option is refused — nothing delivered, the decision stays open, the owner's answer is accepted", async () => {
    delegate("reversible-technical", "orchestrator");
    await finish(false, 3);
    await askAfterFinish([COMMIT_Q(1), COMMIT_Q(2).replace("Q2: Commit", "Q2: Also commit")].join("\n"));
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null });
    const decide = async (id: string, optionKey: string) => (await tools()).call("bm_decide", { decisionId: id, optionKey, reason: "The Worker says the tests pass." });

    const refused = await decide(qid(1), "a");
    expect(refused).toEqual({ ok: false, text: `Refused: ${UNVERIFIED}; leave decision ${qid(1)} to the owner.` });
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);

    // An option that does not act on the finish may still be chosen…
    expect((await decide(qid(2), "b")).ok).toBe(true);
    expect(stored(qid(2)).answer).toMatchObject({ by: "policy", optionKey: "b", predictor: "orchestrator" });
    // …and the owner's own answer to the refused one is accepted and delivered.
    enqueued = [];
    expect((await ownerAnswers(qid(1), "a")).decision).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "a" } });
    expect(enqueued.map(({ target, kind }) => [target, kind])).toEqual([[WORKER, `answers:${REQUEST}`]]);
  });

  it("(a) bm_decide: after a new finished report with every check detected, the delegate may commit again", async () => {
    delegate("reversible-technical", "orchestrator");
    await finish(false, 3);
    await askAfterFinish(COMMIT_Q(1));
    const decide = async () => (await tools()).call("bm_decide", { decisionId: qid(1), optionKey: "a", reason: "The tests passed after the last edit." });
    expect((await decide()).ok).toBe(false);
    await finish(true, 4);
    const allowed = await decide();
    expect(allowed.ok, allowed.text).toBe(true);
    expect(stored(qid(1))).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "a", predictor: "orchestrator" }, grant: { effects: ["commit"] } });
  });

  it("(b) bm_send_command on policy:<class> approving commit, or with intent release, is refused naming bm_ask_owner; nothing is sent", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    const tool = await tools();
    const send = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, reason: "The Worker finished." };
    const refusal = `Refused: ${UNVERIFIED}; ${UNVERIFIED_FINISH_INSTEAD}.`;
    expect(await tool.call("bm_send_command", { ...send, intent: "continue", effects: ["commit"], command: COMMIT_BODY })).toEqual({ ok: false, text: refusal });
    expect(await tool.call("bm_send_command", { ...send, intent: "release", effects: ["none"], command: "Tag the release." })).toEqual({ ok: false, text: refusal });
    expect(refusal).toContain("bm_ask_owner");
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);

    // A command that does not act on the finish still goes on the policy: asking the Worker to prove it, say.
    const prove = await tool.call("bm_send_command", { ...send, intent: "continue", effects: ["none"], command: "Ask the Worker to run npm test after its last edit and report again." });
    expect(prove.ok, prove.text).toBe(true);
    expect(parseCommandBlock(enqueued[0]!.text)).toMatchObject({ authority: "policy:reversible-technical", approved: [] });

    // Once a new finish is detected, the commit goes on the policy again.
    await finish(true, 4);
    const commit = await tool.call("bm_send_command", { ...send, intent: "continue", effects: ["commit"], command: COMMIT_BODY });
    expect(commit.ok, commit.text).toBe(true);
    expect(parseCommandBlock(enqueued[1]!.text)).toMatchObject({ authority: "policy:reversible-technical", approved: ["commit"] });
  });

  it("(b) bm_direct_worker on the policy is refused for the Worker's request when it names none", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    const direct = { workspaceId: WORKSPACE_ID, workerId: WORKER, re: "commit the fix", intent: "continue", effects: ["commit"], command: COMMIT_BODY };
    expect(await (await tools()).call("bm_direct_worker", direct)).toEqual({ ok: false, text: `Refused: ${UNVERIFIED}; ${UNVERIFIED_FINISH_INSTEAD}.` });
    expect(await (await tools()).call("bm_direct_worker", { ...direct, requestId: REQUEST, intent: "release", effects: ["none"] })).toEqual({
      ok: false,
      text: `Refused: ${UNVERIFIED}; ${UNVERIFIED_FINISH_INSTEAD}.`,
    });
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("(b) a grant — the owner's answer to the Orchestrator's own decision — is not refused", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    const tool = await tools();
    // Asked without a command: the policy leaves it to the owner, who answers it with commit.
    expect((await tool.call("bm_ask_owner", commitAsk(false))).text).toMatch(/^Asked\. /);
    const oid = "o:0c7a-1";
    await ownerAnswers(oid, "a");
    expect(stored(oid).grant).toMatchObject({ effects: ["commit"], usedAt: null });
    enqueued = [];
    const sent = await tool.call("bm_send_command", {
      workspaceId: WORKSPACE_ID,
      managerId: MANAGER,
      requestId: REQUEST,
      decisionId: oid,
      intent: "continue",
      effects: ["commit"],
      command: COMMIT_BODY,
      reason: "The owner chose to commit.",
    });
    expect(sent.ok, sent.text).toBe(true);
    expect(parseCommandBlock(enqueued[0]!.text)).toMatchObject({ authority: `decision:${oid}`, approved: ["commit"] });
  });
});
