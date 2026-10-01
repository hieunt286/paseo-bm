import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INBOX_DIR_NAME, createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { createQuestionDecisionDelivery } from "../plugin/server/decision-delivery";
import { handleDecisionsOverride, type DecisionOverrideDeps } from "../plugin/server/decision-override";
import { handleDecisionsAnswer, registerDecisionRpcs, settledByKind, type OnDecisionsSettled } from "../plugin/server/decision-rpc";
import { materialiseTurn } from "../plugin/server/decision-materialiser";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createFallbackDecisionDelivery, type FallbackAct } from "../plugin/server/fallback-decisions";
import {
  INBOX_SEEN_FILE,
  INBOX_SEEN_WRITE_EVERY_MS,
  INBOX_VISIT_GAP_MS,
  createInboxSeenStore,
  nextInboxSeen,
} from "../plugin/server/inbox-seen-store";
import { handleInboxDigest, handleInboxSeen, type InboxRpcDeps } from "../plugin/server/inbox-rpc";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { answerNoticeOf, createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { createOverrideDelivery, overrideAnswersMessageOf, overrideKindOf } from "../plugin/server/override-delivery";
import { resolveAtOpen } from "../plugin/server/policy-resolve";
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { decideRefusalOf, levelOf, modeOf, predictionRefusalOf } from "../plugin/shared/autonomy";
import { agreementLedger } from "../plugin/shared/autonomy-ledger";
import { DashboardError, INBOX_DIGEST_MAX, decisionsOverrideRpc, inboxDigestRpc, inboxSeenRpc } from "../plugin/shared/contracts";
import { isDecidedForOwner, overrideDecisionOf, overrideIdOf, overrideRefusalOf } from "../plugin/shared/decision-override";
import {
  DECISION_ID_PATTERN,
  answerDecision,
  decisionKindOf,
  deliveryKindOf,
  openingPrediction,
  supersedeDecision,
  type AnswerInput,
  type Decision,
  type DecisionOption,
} from "../plugin/shared/decisions";
import { precedentResolutionOf } from "../plugin/shared/precedents";
import { MANAGER, WORKER, WORKSPACE_ID, msg, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The Inbox's Decided for you and its Override (autonomy design §B.7, §B.9;
 * PRD REQ-125, REQ-123 b; bead `bm-autonomy-phase2-t9lm.15`):
 *
 * - `inbox.seen` / `inbox.digest`: what the owner's policy and precedents
 *   answered since the owner last looked, the last look kept on disk.
 * - `decisions.override`: a new owner decision `r:<uuid>` that supersedes the
 *   delegated one, counts as an override (reversal `overridden`, recorded
 *   only: no cell or level changes, ADR-025), is never answered by a precedent, the policy or the
 *   Orchestrator, and whose answer reaches the agent concerned.
 *
 * A temporary data folder, the one fake Paseo and a private notice queue.
 * Never the real HOME or a daemon.
 */

const NOW = new Date("2026-09-30T10:00:00.000Z");
const REQUEST = "req-20260930T093000Z";
const ORCHESTRATOR = "agent-orchestrator-main";
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

let root: string;
let home: string;
let logs: string[];
let ids: number;

const log = (message: string) => void logs.push(message);
const decisions = () => createDecisionStore(home);
const stored = (id: string) => decisions().get(id, WORKSPACE_ID)!;
const deps = (overrides: Partial<DecisionOverrideDeps> = {}): DecisionOverrideDeps => ({
  home,
  now: () => NOW,
  log,
  newId: () => `override-${++ids}`,
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-override-"));
  home = join(root, "data");
  logs = [];
  ids = 0;
  clearDecisionStoreCache();
});

afterEach(() => {
  clearDecisionStoreCache();
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const SCOPE_OPTIONS: DecisionOption[] = [
  { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"], action: { kind: "answer-worker" } },
  { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] },
];

/** An open Worker question of the scope class, the one recommended option without effect. */
function scopeQuestion(n = 1, overrides: Partial<Decision> = {}): Decision {
  return {
    id: `q:${REQUEST}:Q${n}`,
    workspaceId: WORKSPACE_ID,
    requestId: REQUEST,
    askedBy: { role: "worker", agentId: WORKER },
    askedAt: minutesBefore(30),
    round: 1,
    question: "Which date format on the invoices?",
    subject: "date-format",
    class: "scope",
    options: SCOPE_OPTIONS,
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    prediction: openingPrediction(SCOPE_OPTIONS),
    ...overrides,
  };
}

/** A delegated answer, as `bm_decide` stores it. */
const BY_POLICY: Omit<AnswerInput, "at"> = {
  by: "policy",
  via: "inbox",
  optionKey: "a",
  class: "scope",
  reason: "The owner writes dates day first.",
};

/** Opens `decision` and answers it in the store; the delegated answer is marked delivered, as the Worker got it. */
function storeAnswered(decision: Decision, answer: Omit<AnswerInput, "at">, minutesAgo = 20): Decision {
  const store = decisions();
  store.open(decision);
  const at = minutesBefore(minutesAgo);
  const moved = store.transition(decision.id, (current) => answerDecision(current, { ...answer, at }), decision.workspaceId);
  if (moved.status !== "updated") throw new Error(`fixture: ${JSON.stringify(moved)}`);
  store.transition(decision.id, (current) => ({ ok: true, decision: { ...current, delivery: { to: WORKER, kind: `answers:${REQUEST}`, at, outcome: "sent" } } }), decision.workspaceId);
  return stored(decision.id);
}

function delegate(decisionClass: "scope" | "environment" | "reversible-technical"): void {
  createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: decisionClass, mode: "delegate", confirmed: true }, minutesBefore(60));
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not coded: ${String(error)}`;
  }
  return null;
}

// ---------------------------------------------------------------------------

describe("the override record (shared/decision-override.ts)", () => {
  it("is an r: id the decision schema, the kinds and the delivery read", () => {
    expect(DECISION_ID_PATTERN.test("r:3f2c1d7e-0b7a-4c1e-9f8e-2a4b6c8d0e1f")).toBe(true);
    expect(DECISION_ID_PATTERN.test("r:")).toBe(false);
    expect(DECISION_ID_PATTERN.test("r:has space")).toBe(false);
    expect(decisionKindOf("r:override-1")).toBe("override");
    expect(deliveryKindOf({ id: "r:override-1", supersedes: `q:${REQUEST}:Q1` })).toBe("question");
    expect(deliveryKindOf({ id: "r:override-1", supersedes: "o:abc" })).toBe("orchestrator");
    expect(deliveryKindOf({ id: "r:override-1", supersedes: "f:fb-1" })).toBe("fallback");
    expect(deliveryKindOf({ id: "r:override-1", supersedes: "r:override-0" })).toBeNull();
    expect(deliveryKindOf({ id: "r:override-1", supersedes: null })).toBeNull();
    expect(deliveryKindOf({ id: "o:abc", supersedes: null })).toBe("orchestrator");
  });

  it("copies the question, options, subject, request and the answer's class, open, superseding the delegated one", () => {
    const answered = answerDecision(scopeQuestion(), { ...BY_POLICY, at: minutesBefore(20) });
    if (!answered.ok) throw new Error("fixture");
    const override = overrideDecisionOf(answered.decision, { id: "r:override-1", at: NOW.toISOString() });
    expect(override).toMatchObject({
      id: "r:override-1",
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: NOW.toISOString(),
      question: "Which date format on the invoices?",
      subject: "date-format",
      class: "scope",
      options: SCOPE_OPTIONS,
      status: "open",
      answer: null,
      grant: null,
      delivery: null,
      supersedes: `q:${REQUEST}:Q1`,
      supersededBy: null,
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
    });
  });

  it("is refused for a decision the owner answered, one still open, and one with no answer left (negative)", () => {
    const owner = answerDecision(scopeQuestion(), { via: "inbox", optionKey: "b", at: minutesBefore(5) });
    if (!owner.ok) throw new Error("fixture");
    expect(isDecidedForOwner(owner.decision)).toBe(false);
    expect(overrideRefusalOf(owner.decision)).toEqual({
      refusal: "not-delegated",
      message: `decision q:${REQUEST}:Q1 was answered by the owner; only an answer the policy or a precedent gave for the owner can be overridden`,
    });
    expect(overrideRefusalOf(scopeQuestion())?.refusal).toBe("not-delegated");
    const superseded = supersedeDecision(scopeQuestion(), { by: `q:${REQUEST}:Q2`, at: minutesBefore(1) });
    if (!superseded.ok) throw new Error("fixture");
    expect(overrideRefusalOf(superseded.decision)?.refusal).toBe("settled");
    const policy = answerDecision(scopeQuestion(), { ...BY_POLICY, at: minutesBefore(5) });
    if (!policy.ok) throw new Error("fixture");
    expect(overrideRefusalOf(policy.decision)).toBeNull();
  });
});

describe("decisions.override (autonomy design §B.7, §B.9)", () => {
  it("opens a new owner decision that supersedes the delegated one and is open for the owner; the delegated answer stands", () => {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);

    const out = handleDecisionsOverride({ id: delegated.id }, deps());
    expect(decisionsOverrideRpc.output.parse(out)).toEqual(out);
    expect(out.created).toBe(true);
    expect(out.decision).toMatchObject({ id: "r:override-1", status: "open", supersedes: delegated.id, question: delegated.question, options: delegated.options, answer: null });
    expect(stored("r:override-1")).toEqual(out.decision);
    // Not recalled: the delegated decision stays answered and delivered, with the override as its reversal.
    expect(out.overridden).toEqual(stored(delegated.id));
    expect(stored(delegated.id)).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "a" }, delivery: { outcome: "sent" }, supersededBy: null });
    expect(stored(delegated.id).reversals).toEqual([{ kind: "overridden", at: NOW.toISOString(), ref: "r:override-1" }]);
    // It is in the Inbox's Needs you: an unsettled decision of the owner.
    expect(decisions().list({ statuses: ["open"] }).map((decision) => decision.id)).toEqual(["r:override-1"]);
  });

  it("counts as an override and is only recorded (ADR-025): the cells, the level and the alerts are untouched", () => {
    createAutonomyStore(home).setLevel({ workspaceId: WORKSPACE_ID, level: 2 }, minutesBefore(60));
    const policyBefore = readFileSync(join(home, "autonomy", "policy.json"), "utf8");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    handleDecisionsOverride({ id: delegated.id }, deps());

    expect(readFileSync(join(home, "autonomy", "policy.json"), "utf8")).toBe(policyBefore);
    const policy = createAutonomyStore(home).read();
    expect(modeOf(policy, WORKSPACE_ID, "scope")).toBe("delegate");
    expect(levelOf(policy, WORKSPACE_ID)).toBe(2);
    expect(createAlertStore(home).list()).toEqual([]);
    // A-4's figure: the ledger counts it as a delegated decision overridden from the digest, the Orchestrator's.
    const [cell] = agreementLedger(decisions().list()).delegated;
    expect(cell).toMatchObject({ class: "scope", by: "policy", predictor: "orchestrator", count: 1, overridden: 1, reversals: 1 });
  });

  it("pressed again, returns the same override", () => {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    const first = handleDecisionsOverride({ id: delegated.id }, deps());
    const again = handleDecisionsOverride({ id: delegated.id }, deps());
    expect(again.created).toBe(false);
    expect(again.decision.id).toBe(first.decision.id);
    expect(decisions().list().filter((decision) => decisionKindOf(decision.id) === "override")).toHaveLength(1);
    expect(stored(delegated.id).reversals).toHaveLength(1);
  });

  it("opens the same override when a write failed after the reversal was recorded", () => {
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    decisions().transition(delegated.id, (current) => ({ ok: true, decision: { ...current, reversals: [{ kind: "overridden", at: minutesBefore(1), ref: "r:override-lost" }] } }), WORKSPACE_ID);
    const out = handleDecisionsOverride({ id: delegated.id }, deps());
    expect(out).toMatchObject({ created: true, decision: { id: "r:override-lost", supersedes: delegated.id } });
    expect(stored(delegated.id).reversals).toHaveLength(1);
  });

  it("overrides a precedent's answer too; a class that was not delegated stays as it is", () => {
    const delegated = storeAnswered(scopeQuestion(), { by: "precedent", via: "inbox", optionKey: "a", class: "scope", precedentId: "p:1", reason: 'The owner\'s precedent on "date-format", saved 2026-09-20' });
    const out = handleDecisionsOverride({ id: delegated.id }, deps());
    expect(out.decision).toMatchObject({ status: "open", supersedes: delegated.id });
    expect(modeOf(createAutonomyStore(home).read(), WORKSPACE_ID, "scope")).toBe("owner");
  });

  it("the owner's answer to the override of a precedent's answer supersedes that precedent (REQ-124 c)", async () => {
    const precedent = createPrecedentStore(home).save({ scope: WORKSPACE_ID, subject: "date-format", text: "dd/mm/yyyy", sourceDecisionId: null, expiresInDays: 30 }, new Date(minutesBefore(60))).precedent;
    const delegated = storeAnswered(scopeQuestion(), { by: "precedent", via: "inbox", optionKey: "a", class: "scope", precedentId: precedent.id, reason: "The owner's precedent" });
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    await handleDecisionsAnswer({ id: override.id, optionKey: "b" }, undefined, { home, now: () => NOW, log });
    expect(createPrecedentStore(home).get(precedent.id)?.supersededBy).toBe(override.id);
    expect(createPrecedentStore(home).active(NOW, WORKSPACE_ID)).toEqual([]);
  });

  it("is refused, writing nothing, for a decision the owner answered (negative)", () => {
    delegate("scope");
    const owners = storeAnswered(scopeQuestion(), { via: "inbox", optionKey: "b" });
    const before = readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8");
    expect(codeOf(() => handleDecisionsOverride({ id: owners.id }, deps()))).toBe("E_DECISION_NOT_DELEGATED");
    expect(readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8")).toBe(before);
    expect(modeOf(createAutonomyStore(home).read(), WORKSPACE_ID, "scope")).toBe("delegate");
    expect(createAlertStore(home).list()).toEqual([]);
  });

  it("is refused for an open, an unknown and a superseded decision, and without a usable data folder", () => {
    decisions().open(scopeQuestion(1));
    expect(codeOf(() => handleDecisionsOverride({ id: `q:${REQUEST}:Q1` }, deps()))).toBe("E_DECISION_NOT_DELEGATED");
    expect(codeOf(() => handleDecisionsOverride({ id: `q:${REQUEST}:Q9` }, deps()))).toBe("E_DECISION_NOT_FOUND");
    decisions().open(scopeQuestion(2, { supersedes: `q:${REQUEST}:Q1` }));
    expect(codeOf(() => handleDecisionsOverride({ id: `q:${REQUEST}:Q1` }, deps()))).toBe("E_DECISION_SETTLED");
    expect(codeOf(() => handleDecisionsOverride({ id: `q:${REQUEST}:Q2` }, { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root }))).toBe(
      "E_DATA_HOME_UNAVAILABLE",
    );
  });

  it("is registered with the decisions RPCs", () => {
    const handled: string[] = [];
    registerDecisionRpcs({ handle: (contract: { name: string }) => void handled.push(contract.name) } as unknown as Parameters<typeof registerDecisionRpcs>[0]);
    expect(handled).toContain("decisions.override");
  });
});

describe("the override is the owner's own: never answered for them", () => {
  it("resolveAtOpen skips it, even with a delegated cell and an active precedent on its subject", () => {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    // The owner delegates the class again and saves a precedent on the subject before answering.
    delegate("scope");
    createPrecedentStore(home).save({ scope: WORKSPACE_ID, subject: "date-format", text: "dd/mm/yyyy", sourceDecisionId: null, expiresInDays: 30 }, NOW);
    const precedents = createPrecedentStore(home).active(NOW, WORKSPACE_ID);
    expect(precedentResolutionOf({ ...override, id: "q:x:Q1" }, precedents, NOW)?.kind).toBe("resolve");

    const atOpen = resolveAtOpen(override, { home, now: NOW, log });
    expect(atOpen).toEqual({ decision: override, answered: null, by: null, precedent: null });
    expect(stored(override.id)).toMatchObject({ status: "open", answer: null });
    expect(precedentResolutionOf(override, precedents, NOW)).toBeNull();
  });

  it("the Orchestrator neither decides nor predicts it", () => {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), { ...BY_POLICY, reason: "The owner writes dates day first." });
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    delegate("scope");
    const policy = { ...createAutonomyStore(home).read(), challenger: { [WORKSPACE_ID]: true } };
    expect(decideRefusalOf(policy, override)).toContain("is the owner's override of an answer made for them");
    expect(predictionRefusalOf(policy, override)).toContain("only the owner answers it");
  });
});

// ---------------------------------------------------------------------------
// Delivery of the owner's answer to an override.
// ---------------------------------------------------------------------------

const AGENTS = [
  { id: MANAGER, provider: "bm-manager", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" } },
  { id: WORKER, provider: "bm-worker", status: "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER } },
  { id: ORCHESTRATOR, provider: "bm-orchestrator", status: "idle", workspaceId: "wks_home", labels: { "bm.role": "orchestrator", "bm.orchestrator": "main" } },
];

const FALLBACK_REFUSES: FallbackAct = async () => {
  throw new DashboardError("E_FALLBACK_NOT_PENDING", "incident fb-1 is switched, not pending");
};

/** The settlement hook `index.server.ts` wires, over a private queue: one delivery per kind, the override's among them. */
function world(act: FallbackAct = FALLBACK_REFUSES, agents: ReadonlyArray<(typeof AGENTS)[number]> = AGENTS) {
  const fake = fakePaseo({ agents, workspaces: [{ id: WORKSPACE_ID, directory: "/work/invoice-app" }] });
  const queue = createNoticeQueue({ log });
  const orchestrator = createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW, log, queue });
  const fallback = createFallbackDecisionDelivery(act, { home: () => home, now: () => NOW, log });
  const overrideDelivery = createOverrideDelivery({ home: () => home, now: () => NOW, log, queue, orchestrator, fallback });
  const onSettled: OnDecisionsSettled = settledByKind(
    {
      question: createQuestionDecisionDelivery({ home: () => home, now: () => NOW, log, queue }).onSettled,
      orchestrator,
      fallback,
      override: overrideDelivery.onSettled,
    },
    log,
  );
  const answer = (input: Parameters<typeof handleDecisionsAnswer>[0]) => handleDecisionsAnswer(input, fake.paseo, { home, now: () => NOW, log, onSettled });
  return { fake, answer, queue, overrideDelivery };
}

describe("the owner's answer to an override reaches the agent concerned", () => {
  it("a Worker's question: the Worker gets the corrected answer as a BM-ANSWERS block, and the override records it", async () => {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    const { fake, answer } = world();

    const out = await answer({ id: override.id, optionKey: "b" });
    expect(out.decision).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "b" }, grant: { effects: ["commit"] } });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.id).toBe(WORKER);
    expect(fake.sends[0]!.text).toBe(
      [
        "BM-DELIVERY answers",
        `Continue ${REQUEST}.`,
        "The owner changed the answer to Q1; this answer replaces the earlier one (Q1: a — dd/mm/yyyy). If you already acted on the earlier answer, say what that changes in your next report.",
        "",
        "BM-ANSWERS",
        `requestId: ${REQUEST}`,
        "Q1: b — yyyy-mm-dd",
      ].join("\n"),
    );
    expect(stored(override.id).delivery).toEqual({ to: WORKER, kind: overrideKindOf(override.id), at: NOW.toISOString(), outcome: "sent" });
    // The delegated answer is not delivered again.
    expect(stored(delegated.id).delivery?.kind).toBe(`answers:${REQUEST}`);
  });

  it("in the owner's own words, and records failed when the request has no single live Worker", async () => {
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    expect(overrideAnswersMessageOf({ ...override, status: "answered", settledAt: NOW.toISOString(), answer: { by: "owner", via: "inbox", optionKey: null, words: "ISO dates, always", at: NOW.toISOString() } }, null)).toContain(
      "Q1: other — ISO dates, always",
    );

    const { fake, answer } = world();
    fake.setAgents(AGENTS.filter((agent) => agent.id !== WORKER));
    await answer({ id: override.id, words: "ISO dates, always" });
    expect(fake.sends).toEqual([]);
    expect(stored(override.id).delivery).toMatchObject({ kind: overrideKindOf(override.id), outcome: "failed" });
    expect(logs.join("\n")).toContain("has no single live Worker");
  });

  it("an Orchestrator decision: the new choice's prepared command goes on the override's authority", async () => {
    const hold: DecisionOption = {
      key: "b",
      label: "Keep the fix on its branch",
      recommended: false,
      effects: ["none"],
      action: { kind: "command", to: "manager", agentId: MANAGER, intent: "redirect", body: "Keep the invoice fix on its branch for now; do not merge it yet.", effects: ["none"] },
    };
    const merge: DecisionOption = {
      key: "a",
      label: "Merge the invoice fix",
      recommended: true,
      effects: ["commit"],
      action: { kind: "command", to: "manager", agentId: MANAGER, intent: "continue", body: "Merge the invoice fix into main.", effects: ["commit"] },
    };
    const asked = scopeQuestion(1, {
      id: "o:4b1f0c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
      askedBy: { role: "orchestrator", agentId: ORCHESTRATOR },
      round: null,
      question: "Merge the invoice fix now?\n\nRecommendation: merge it; the review passed.",
      subject: "merge-invoice-fix",
      class: "reversible-technical",
      options: [merge, hold],
      prediction: openingPrediction([merge, hold]),
    });
    const delegated = storeAnswered(asked, { ...BY_POLICY, class: "reversible-technical", reason: "The review passed." });
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    expect(override.id).toBe("r:override-1");
    const { fake, answer } = world();

    await answer({ id: override.id, optionKey: "b" });
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.id).toBe(MANAGER);
    const block = fake.sends[0]!.text;
    expect(block).toContain("BM-COMMAND");
    expect(block).toContain("authority: decision:r:override-1");
    expect(block).toContain("Keep the invoice fix on its branch for now; do not merge it yet.");
    expect(stored(override.id).delivery).toMatchObject({ to: MANAGER, outcome: "sent" });

    // Without a command, the Orchestrator's BM-ANSWER names what the override replaces.
    const notice = answerNoticeOf({ ...stored(override.id), options: [{ ...hold, action: undefined }] });
    expect(notice).toContain(`decisionId: ${override.id}`);
    expect(notice).toContain(`overrides: ${delegated.id}, answered earlier for the owner; this answer replaces that one`);
  });

  it("a fallback incident: the chosen action goes to fallback.act for the same incident, recorded failed once the incident moved on", async () => {
    const incidentOptions: DecisionOption[] = [
      { key: "switch", label: "Switch to codex", recommended: true, effects: [], action: { kind: "fallback", action: "switch", target: "fb-1" } },
      { key: "wait", label: "Wait for the reset", recommended: false, effects: [], action: { kind: "fallback", action: "wait", target: "fb-1" } },
    ];
    const incident = scopeQuestion(1, {
      id: "f:fb-1",
      askedBy: { role: "plugin", agentId: null },
      round: null,
      question: "The Worker stopped on its provider plan. What now?",
      subject: "fallback-worker",
      class: "environment",
      options: incidentOptions,
      prediction: openingPrediction(incidentOptions),
    });
    const delegated = storeAnswered(incident, { ...BY_POLICY, optionKey: "switch", class: "environment", reason: "The limit resets soon." });
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    const acted: Array<{ incidentId: string; action: string }> = [];
    const { answer } = world(async (input) => {
      acted.push({ incidentId: input.incidentId, action: input.action });
      throw new DashboardError("E_FALLBACK_NOT_PENDING", "incident fb-1 is switched, not pending");
    });

    await answer({ id: override.id, optionKey: "wait" });
    expect(acted).toEqual([{ incidentId: "fb-1", action: "wait" }]);
    expect(stored(override.id).delivery).toMatchObject({ kind: "fallback:wait", outcome: "failed" });
  });
});

describe("a corrected answer to a Worker has a Worker answer's guarantees (§A.6)", () => {
  const BUSY = AGENTS.map((agent) => (agent.id === WORKER ? { ...agent, status: "running" } : agent));
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
  const workerTurn = (when: string, text: string) => turn({ agentId: WORKER, role: "worker", workspaceId: WORKSPACE_ID, requestId: REQUEST, sent: [msg(WORKER, when, text)] });
  const managerTurn = () => turn({ agentId: MANAGER, role: "manager", workspaceId: WORKSPACE_ID });

  /** The owner overrides the policy's answer to Q1 and answers the override with b, in this world. */
  async function overrideAnswered(w: ReturnType<typeof world>): Promise<string> {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    await w.answer({ id: override.id, optionKey: "b" });
    return override.id;
  }

  it("is queued while the Worker runs, and recorded sent when the Worker's turn record carries it", async () => {
    const w = world(undefined, BUSY);
    const id = await overrideAnswered(w);
    expect(w.fake.sends).toEqual([]);
    expect(stored(id).delivery).toEqual({ to: WORKER, kind: overrideKindOf(id), at: NOW.toISOString(), outcome: "queued" });
    // Still waiting in the queue: it stays queued, and nothing is sent twice.
    await w.overrideDelivery.afterTurn(managerTurn(), { paseo: w.fake.paseo });
    expect(stored(id).delivery?.outcome).toBe("queued");
    expect(w.fake.sends).toEqual([]);

    w.fake.setAgents(AGENTS);
    await w.queue.turnEnded({ agent: { id: WORKER } }, w.fake.paseo);
    expect(w.fake.sends.map((send) => send.id)).toEqual([WORKER]);
    await w.overrideDelivery.afterTurn(workerTurn(later(2), w.fake.sends[0]!.text), { paseo: w.fake.paseo });
    expect(stored(id).delivery).toEqual({ to: WORKER, kind: overrideKindOf(id), at: later(2), outcome: "sent" });
  });

  it("is recorded sent once this run's queue no longer holds it", async () => {
    const w = world(undefined, BUSY);
    const id = await overrideAnswered(w);
    w.fake.setAgents(AGENTS);
    await w.queue.turnEnded({ agent: { id: WORKER } }, w.fake.paseo);
    await w.overrideDelivery.afterTurn(managerTurn(), { paseo: w.fake.paseo });
    expect(stored(id).delivery).toEqual({ to: WORKER, kind: overrideKindOf(id), at: NOW.toISOString(), outcome: "sent" });
    expect(w.fake.sends).toHaveLength(1);
  });

  it("is delivered again once per plugin run, through the materialiser's afterTurn, while undelivered or queued", async () => {
    // Left by an earlier run: one queued when the plugin reloaded, one answered with no Paseo handle to deliver it.
    delegate("scope");
    const queuedId = handleDecisionsOverride({ id: storeAnswered(scopeQuestion(1), BY_POLICY).id }, deps()).decision.id;
    const lostId = handleDecisionsOverride({ id: storeAnswered(scopeQuestion(2), BY_POLICY).id }, deps()).decision.id;
    for (const id of [queuedId, lostId]) decisions().transition(id, (decision) => answerDecision(decision, { via: "inbox", optionKey: "b", at: NOW.toISOString() }), WORKSPACE_ID);
    const earlier = { to: WORKER, kind: overrideKindOf(queuedId), at: minutesBefore(1), outcome: "queued" as const };
    decisions().transition(queuedId, (decision) => ({ ok: true, decision: { ...decision, delivery: earlier } }), WORKSPACE_ID);

    const w = world();
    const run = () => materialiseTurn(managerTurn(), { home, paseo: w.fake.paseo, now: () => NOW, log, afterTurn: w.overrideDelivery.afterTurn });
    await run();
    // The first went at once and started the Worker's turn; the second waits for its end.
    expect(w.fake.sends.map((send) => send.text.split("\n").at(-1))).toEqual(["Q1: b — yyyy-mm-dd"]);
    expect([stored(queuedId).delivery?.outcome, stored(lostId).delivery?.outcome]).toEqual(["sent", "queued"]);
    await run();
    expect(w.fake.sends).toHaveLength(1);

    w.fake.setAgents(AGENTS);
    await w.queue.turnEnded({ agent: { id: WORKER } }, w.fake.paseo);
    await run();
    expect(w.fake.sends.map((send) => send.text.split("\n").at(-1))).toEqual(["Q1: b — yyyy-mm-dd", "Q2: b — yyyy-mm-dd"]);
    expect(stored(lostId).delivery?.outcome).toBe("sent");
  });
});

describe("an override of a Worker's question expires with its request (§A.3; bead 81y2.26)", () => {
  const OTHER_REQUEST = "req-20260930T094500Z";
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
  const finished = (requestId: string) => ["BM-REPORT", `requestId: ${requestId}`, "phase: finished", "tier: Medium", "buildAndTests: npm test: pass", "blockers: none"].join("\n");

  it("at the request's finished report, as its open questions; not one asked after it, another request's, nor an Orchestrator decision's", async () => {
    delegate("scope");
    const override = (decision: Decision, at = NOW) => handleDecisionsOverride({ id: storeAnswered(decision, BY_POLICY).id }, deps({ now: () => at })).decision.id;
    const expiring = override(scopeQuestion(1));
    const askedAfter = override(scopeQuestion(2), new Date(later(10)));
    const otherRequest = override(scopeQuestion(1, { id: `q:${OTHER_REQUEST}:Q1`, requestId: OTHER_REQUEST }));
    const ofOrchestrator = override(scopeQuestion(1, { id: "o:merge-1", askedBy: { role: "orchestrator", agentId: ORCHESTRATOR }, round: null }));

    const record = turn({ agentId: MANAGER, role: "manager", workspaceId: WORKSPACE_ID, endedAt: later(5), sent: [msg(MANAGER, later(5), finished(REQUEST), "agent")] });
    const outcome = await materialiseTurn(record, { home, now: () => new Date(later(6)), log });

    expect(outcome.expired.map((decision) => decision.id)).toEqual([expiring]);
    expect(stored(expiring)).toMatchObject({ status: "expired", settledAt: later(5), answer: null, delivery: null });
    for (const id of [askedAfter, otherRequest, ofOrchestrator]) expect(stored(id).status).toBe("open");
    await expect(handleDecisionsAnswer({ id: expiring, optionKey: "b" }, undefined, { home, now: () => new Date(later(7)), log })).rejects.toMatchObject({
      code: "E_DECISION_SETTLED",
    });
  });
});

// ---------------------------------------------------------------------------
// inbox.seen and inbox.digest.
// ---------------------------------------------------------------------------

describe("inbox.seen: when the owner last looked, kept on disk (§B.9)", () => {
  const seenFile = () => join(home, INBOX_DIR_NAME, INBOX_SEEN_FILE);
  const rpcDeps = (at: Date): InboxRpcDeps => ({ home, now: () => at, log });
  const later = (ms: number) => new Date(NOW.getTime() + ms);

  it("starts from never, keeps its start through a visit (its polls, a reload) and moves it after a gap", () => {
    const first = handleInboxSeen(rpcDeps(NOW));
    expect(inboxSeenRpc.output.parse(first)).toEqual({ since: null, seenAt: NOW.toISOString() });
    // Polls and a reload within the visit: the start stays.
    expect(handleInboxSeen(rpcDeps(later(5_000))).since).toBeNull();
    expect(handleInboxSeen(rpcDeps(later(INBOX_SEEN_WRITE_EVERY_MS + 1_000))).since).toBeNull();
    const lastSeen = later(INBOX_SEEN_WRITE_EVERY_MS + 1_000).toISOString();
    // Back after longer than the gap: the digest starts where the owner last looked.
    const next = handleInboxSeen(rpcDeps(later(INBOX_SEEN_WRITE_EVERY_MS + 1_000 + INBOX_VISIT_GAP_MS + 1)));
    expect(next.since).toBe(lastSeen);
    expect(JSON.parse(readFileSync(seenFile(), "utf8"))).toEqual({ version: 1, seenAt: next.seenAt, since: lastSeen });
    expect(statSync(seenFile()).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, INBOX_DIR_NAME)).mode & 0o777).toBe(0o700);
  });

  it("writes within a visit at most every INBOX_SEEN_WRITE_EVERY_MS, and again after a clock set back (pure)", () => {
    const seen = { seenAt: NOW.toISOString(), since: minutesBefore(90) };
    expect(nextInboxSeen(seen, later(5_000))).toEqual({ seen: { seenAt: later(5_000).toISOString(), since: minutesBefore(90) }, write: false });
    expect(nextInboxSeen(seen, later(INBOX_SEEN_WRITE_EVERY_MS)).write).toBe(true);
    expect(nextInboxSeen(seen, later(-60_000))).toEqual({ seen: { seenAt: later(-60_000).toISOString(), since: minutesBefore(90) }, write: true });
    expect(nextInboxSeen({ seenAt: "not a time", since: null }, NOW)).toEqual({ seen: { seenAt: NOW.toISOString(), since: null }, write: true });
  });

  it("reads a corrupt file as never seen and replaces it; refuses a newer file and a symlink; needs a data folder", () => {
    mkdirSync(join(home, INBOX_DIR_NAME), { recursive: true });
    writeFileSync(seenFile(), "{ not json");
    expect(handleInboxSeen(rpcDeps(NOW)).since).toBeNull();
    expect(JSON.parse(readFileSync(seenFile(), "utf8")).version).toBe(1);

    writeFileSync(seenFile(), JSON.stringify({ version: 2, seenAt: minutesBefore(10), since: null }));
    expect(codeOf(() => handleInboxSeen(rpcDeps(NOW)))).toBe("E_INBOX_WRITE_FAILED");
    expect(JSON.parse(readFileSync(seenFile(), "utf8")).version).toBe(2);
    expect(createInboxSeenStore(home).inspect().state).toBe("too-new");

    rmSync(seenFile());
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, seenAt: minutesBefore(10), since: null }));
    symlinkSync(elsewhere, seenFile());
    expect(lstatSync(seenFile()).isSymbolicLink()).toBe(true);
    expect(codeOf(() => handleInboxSeen(rpcDeps(NOW)))).toBe("E_DATA_HOME_UNAVAILABLE");

    expect(codeOf(() => handleInboxSeen({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root }))).toBe("E_DATA_HOME_UNAVAILABLE");
  });

  it("answers E_INBOX_WRITE_FAILED when the folder cannot be written", () => {
    mkdirSync(join(home, INBOX_DIR_NAME), { recursive: true });
    chmodSync(join(home, INBOX_DIR_NAME), 0o500);
    try {
      expect(codeOf(() => handleInboxSeen(rpcDeps(NOW)))).toBe("E_INBOX_WRITE_FAILED");
    } finally {
      chmodSync(join(home, INBOX_DIR_NAME), 0o700);
    }
  });
});

describe("inbox.digest: what was decided for the owner since they last looked (§B.7; REQ-125 a)", () => {
  const rpcDeps: () => InboxRpcDeps = () => ({ home, log });

  it("lists the policy's and the precedents' answers after `since`, the latest first; never an owner's answer", () => {
    storeAnswered(scopeQuestion(1), BY_POLICY, 30);
    storeAnswered(scopeQuestion(2), { by: "precedent", via: "inbox", optionKey: "a", class: "scope", precedentId: "p:1", reason: "The owner's precedent" }, 10);
    storeAnswered(scopeQuestion(3), { ...BY_POLICY, reason: "Day first, as the owner writes." }, 5);
    storeAnswered(scopeQuestion(4), { via: "inbox", optionKey: "b" }, 2);
    decisions().open(scopeQuestion(5));

    const all = handleInboxDigest({}, rpcDeps());
    expect(inboxDigestRpc.output.parse(all)).toEqual(all);
    expect(all.decisions.map((decision) => decision.id)).toEqual([3, 2, 1].map((n) => `q:${REQUEST}:Q${n}`));
    expect(all.truncated).toBe(false);
    expect(all.decisions[0]!.answer).toMatchObject({ by: "policy", reason: "Day first, as the owner writes." });

    expect(handleInboxDigest({ since: minutesBefore(15) }, rpcDeps()).decisions.map((decision) => decision.id)).toEqual([`q:${REQUEST}:Q3`, `q:${REQUEST}:Q2`]);
    expect(handleInboxDigest({ since: minutesBefore(1) }, rpcDeps()).decisions).toEqual([]);
    expect(handleInboxDigest({ workspaceId: "wks_other" }, rpcDeps()).decisions).toEqual([]);
  });

  it("keeps an overridden decision, naming its override; the override itself is the owner's", () => {
    delegate("scope");
    const delegated = storeAnswered(scopeQuestion(), BY_POLICY);
    const { decision: override } = handleDecisionsOverride({ id: delegated.id }, deps());
    const out = handleInboxDigest({}, rpcDeps());
    expect(out.decisions.map((decision) => decision.id)).toEqual([delegated.id]);
    expect(overrideIdOf(out.decisions[0]!)).toBe(override.id);
  });

  it("stops at INBOX_DIGEST_MAX and reads as none without a usable data folder", () => {
    // Written in one file, as the store writes it: one write per decision would only make the test slow.
    const entries = Array.from({ length: INBOX_DIGEST_MAX + 1 }, (_, index) => {
      const answered = answerDecision(scopeQuestion(index + 1), { ...BY_POLICY, at: minutesBefore(index % 50) });
      if (!answered.ok) throw new Error("fixture");
      return answered.decision;
    });
    mkdirSync(join(home, "decisions"), { recursive: true });
    writeFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), JSON.stringify({ version: 1, entries }));
    const out = handleInboxDigest({}, rpcDeps());
    expect(out.decisions).toHaveLength(INBOX_DIGEST_MAX);
    expect(out.truncated).toBe(true);
    expect(handleInboxDigest({}, { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual({ decisions: [], truncated: false, interventions: [], interventionsTruncated: false });
  });

  it("refuses a `since` that is not a time", () => {
    expect(inboxDigestRpc.input.safeParse({ since: "yesterday-ish" }).success).toBe(false);
    expect(inboxDigestRpc.input.safeParse({ since: NOW.toISOString() }).success).toBe(true);
  });
});

