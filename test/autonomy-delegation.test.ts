import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { createPrecedentStore } from "../plugin/server/precedent-store";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import {
  actsOnFinish,
  commandActsOnFinish,
  decideRefusalOf,
  unverifiedFinishRefusalOf,
  type AutonomyPolicy,
} from "../plugin/shared/autonomy";
import { UNVERIFIED_FINISH_INSTEAD } from "../plugin/server/command-authority";
import { agreementLedger } from "../plugin/shared/autonomy-ledger";
import type { FallbackIncident, TraceRecord } from "../plugin/shared/contracts";
import { openingPrediction, type Decision, type DecisionClass } from "../plugin/shared/decisions";
import { commandBlockOf, parseCommandBlock } from "../plugin/shared/orchestrator-command";
import { MANAGER, WORKER, WORKSPACE_ID, at, msg, report as reportOf, turn } from "./fixtures/orchestrator-traces";

/**
 * Delegation to the Orchestrator (autonomy design §B.5, §B.9; bead
 * `bm-autonomy-phase2-t9lm.11`; ADR-025): a decision that opens in a
 * `delegate` cell stays open — nothing answers it by code at open, the
 * recommended predictor is gone —, raises a `decision.opened` asking
 * `bm_decide`, and the Orchestrator's answer (`by: policy`) is delivered
 * through the same hook, exactly as the owner's. Any class may be delegated:
 * at Turbo and Full auto a release, data, security or cost decision too, with
 * the grant its option declares, and a command whose effects' classes are
 * delegated goes on `policy:<class>`.
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

/** The owner delegates one class of the project to the Orchestrator. */
function delegate(decisionClass: DecisionClass, workspaceId = WORKSPACE_ID): void {
  autonomy().set({ workspaceId, class: decisionClass, mode: "delegate", confirmed: true }, NOW.toISOString());
}

/** A policy file written by hand. */
function writePolicyFile(projects: Record<string, unknown>): void {
  mkdirSync(join(home, AUTONOMY_DIR_NAME), { recursive: true });
  writeFileSync(join(home, AUTONOMY_DIR_NAME, AUTONOMY_POLICY_FILE), JSON.stringify({ version: 1, projects: { [WORKSPACE_ID]: projects }, challenger: {} }));
}

const delegateCell = () => ({ mode: "delegate", at: NOW.toISOString() });

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

/** An open scope question as the materialiser stores it, on another request (for the direct rule tests). */
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

  it("is never answered at open by the policy, whatever its class's cell (ADR-025: no instant answer): asked, and nothing sent", async () => {
    for (const decisionClass of ["reversible-technical", "release"] as const) delegate(decisionClass);
    const asked = await (await tools()).call("bm_ask_owner", commitAsk);
    expect(asked.text).toMatch(/^Asked\. /);
    expect(factsOf(asked.text)).toEqual({ decisionId: "o:0b6f-1", replaced: null, class: "reversible-technical" });
    expect(stored("o:0b6f-1")).toMatchObject({ status: "open", answer: null, grant: null });
    // The Orchestrator's own decision is the owner's: nothing asks it to decide it.
    expect(decisionOpenedEventsOf([stored("o:0b6f-1")], autonomy().read())).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(sends).toEqual([]);
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

  it("is not answered at open, even with the pass able to deliver it: it waits for the Orchestrator (ADR-025)", () => {
    delegate("environment");
    writeIncident();
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled: onSettledHook(), paseo } });
    expect(stored(FID)).toMatchObject({ status: "open", answer: null });
    expect(decisionOpenedEventsOf([stored(FID)], autonomy().read())).toEqual([expect.objectContaining({ decisionId: FID, asks: "decision" })]);
    expect(acted).toEqual([]);
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
    delegate("scope");
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
      answer: { by: "policy", via: "inbox", optionKey: "b", class: "scope", reason: "ISO dates sort in the export the accountant reads." },
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
    delegate("environment");
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents: [INCIDENT] }));
    syncFallbackDecisions(home, { now: () => NOW, log, settle: { onSettled: onSettledHook(), paseo } });
    expect(stored(FID)).toMatchObject({ status: "open", answer: null });
    expect(decisionOpenedEventsOf([stored(FID)], autonomy().read())).toEqual([expect.objectContaining({ decisionId: FID, requestId: REQUEST, askedBy: null, asks: "decision" })]);

    const result = await decide(FID, "wait", "The limit resets in ten minutes.");
    expect(result.ok, result.text).toBe(true);
    expect(acted).toEqual([{ incidentId: INCIDENT.id, action: "wait" }]);
    expect(stored(FID)).toMatchObject({
      status: "answered",
      answer: { by: "policy", optionKey: "wait", class: "environment" },
      delivery: { kind: "fallback:wait", outcome: "sent" },
    });
    expect(result.text).toContain("The plugin ran the option's action on the incident.");
  });

  it("a new incident's listener hands its open decision to the event bus (onDecisionsOpened), as stored", async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ROLE_FALLBACK_FILE), JSON.stringify({ version: 1, roles: { worker: { policy: "ask", entries: [] } } }));
    delegate("environment");
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

  it("at Full auto decides a release or security decision too, granting the option's push, and a push command goes on policy:release (ADR-025)", async () => {
    writePolicyFile(Object.fromEntries(["release", "data", "security", "cost", "reversible-technical", "scope", "preference", "environment", "dependency"].map((c) => [c, delegateCell()])));
    const outcome = await ask(
      [
        "Q1: Push the date fix to origin/dev? [class: reversible-technical]",
        "- a: Push it (recommended) [effects: push]",
        "- b: Hold",
        "Q2: Rotate the API key the tests use? [class: security]",
        "- a: Rotate it (recommended)",
        "- b: Keep it",
      ].join("\n"),
    );
    // Both wake the Orchestrator to decide: no class is the owner's by rule.
    expect(decisionOpenedEventsOf(outcome.opened, autonomy().read()).map((event) => [event.decisionId, event.asks])).toEqual([
      [qid(1), "decision"],
      [qid(2), "decision"],
    ]);
    const pushed = await decide(qid(1), "a", "The review passed and the owner pushes fixes to dev.");
    expect(pushed.ok, pushed.text).toBe(true);
    expect(stored(qid(1))).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "a", class: "release" }, grant: { effects: ["push"], usedAt: null } });
    expect((await decide(qid(2), "b")).ok).toBe(true);
    enqueued = [];

    // A command declaring a push goes out on the policy: release is delegated.
    const tools = await decideTools();
    const pushCommand = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, intent: "release", command: "Push the date fix to origin/dev.", reason: "Delegated." };
    const sent = await tools.call("bm_send_command", { ...pushCommand, effects: ["push"] });
    expect(sent.ok, sent.text).toBe(true);
    expect(parseCommandBlock(enqueued[0]!.text)).toMatchObject({ authority: "policy:release", approved: ["push"] });
    // The command builder writes a policy authority approving a release effect.
    expect(
      commandBlockOf({ from: "orchestrator", via: "chat", to: "manager", requestId: REQUEST, re: "Push", body: "Push it.", why: "Policy.", intent: "release", effects: ["push"], authority: "policy:release", approved: ["push"] }),
    ).toContain("authority: policy:release");
  });

  it("at Cruise a release decision is the owner's: not asked of the Orchestrator, bm_decide refused, and a push command needs the owner's decision", async () => {
    for (const decisionClass of ["reversible-technical", "preference", "scope", "environment", "dependency"] as const) delegate(decisionClass);
    const outcome = await ask(["Q1: Push the date fix to origin/dev? [class: reversible-technical]", "- a: Push it (recommended) [effects: push]", "- b: Hold"].join("\n"));
    expect(decisionOpenedEventsOf(outcome.opened, autonomy().read())).toEqual([]);
    expect(await decide(qid(1), "a")).toEqual({ ok: false, text: `Refused: release is not delegated to you in project ${WORKSPACE_ID}; the owner decides it, so leave it to the owner.` });
    expect(stored(qid(1))).toMatchObject({ status: "open", answer: null, grant: null });
    const tools = await decideTools();
    for (const effect of ["push", "publish", "deploy", "real-data", "migration", "security", "cost"]) {
      const sent = await tools.call("bm_send_command", { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST, intent: "release", command: "Push the date fix.", reason: "Delegated.", effects: [effect] });
      expect(sent.ok, effect).toBe(false);
      expect(sent.text, effect).toContain(`${effect} needs the owner's decision`);
    }
    expect(enqueued).toEqual([]);
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
    const delegated: AutonomyPolicy = { projects: { [WORKSPACE_ID]: { "reversible-technical": delegateCell() } } as AutonomyPolicy["projects"], challenger: {} };
    const open: Decision = { ...scopeQuestion(), id: qid(1), requestId: REQUEST, class: "reversible-technical", options: decision.options, prediction: openingPrediction(decision.options) };
    expect(decideRefusalOf(delegated, open)).toBeNull();
    expect(decideRefusalOf(delegated, open, { optionKey: "a", finishedUnverified: true })).toBe(`${UNVERIFIED}; leave decision ${qid(1)} to the owner`);
    expect(decideRefusalOf(delegated, open, { optionKey: "b", finishedUnverified: true })).toBeNull();
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
    delegate("reversible-technical");
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
    expect(stored(qid(2)).answer).toMatchObject({ by: "policy", optionKey: "b" });
    // …and the owner's own answer to the refused one is accepted and delivered.
    enqueued = [];
    expect((await ownerAnswers(qid(1), "a")).decision).toMatchObject({ status: "answered", answer: { by: "owner", optionKey: "a" } });
    expect(enqueued.map(({ target, kind }) => [target, kind])).toEqual([[WORKER, `answers:${REQUEST}`]]);
  });

  it("(a) bm_decide: after a new finished report with every check detected, the delegate may commit again", async () => {
    delegate("reversible-technical");
    await finish(false, 3);
    await askAfterFinish(COMMIT_Q(1));
    const decide = async () => (await tools()).call("bm_decide", { decisionId: qid(1), optionKey: "a", reason: "The tests passed after the last edit." });
    expect((await decide()).ok).toBe(false);
    await finish(true, 4);
    const allowed = await decide();
    expect(allowed.ok, allowed.text).toBe(true);
    expect(stored(qid(1))).toMatchObject({ status: "answered", answer: { by: "policy", optionKey: "a" }, grant: { effects: ["commit"] } });
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
