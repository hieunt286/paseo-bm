import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { COMPACTIONS_FILE, createCompactionStore } from "../plugin/server/compaction-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import {
  handleInboxAlerts,
  handleInboxDigest,
  interventionReasonOf,
  interventionTargetRoleOf,
  registerInboxRpcs,
  type InboxRpcDeps,
} from "../plugin/server/inbox-rpc";
import { INTERVENTIONS_FILE, createInterventionStore, type InterventionInput } from "../plugin/server/intervention-store";
import { ORCHESTRATOR_DIR_NAME, createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { DIGEST_INTERVENTION_REASON_MAX, INBOX_ALERTS_MAX, INBOX_DIGEST_MAX, inboxAlertsRpc, inboxDigestRpc } from "../plugin/shared/contracts";
import { answerDecision, openingPrediction, type DecisionOption } from "../plugin/shared/decisions";
import type { InterventionEntry } from "../plugin/shared/interventions";
import { makeDecision } from "./helpers/decisions";

/**
 * `inbox.alerts` (autonomy design §A.8, §A.12) against a temporary data
 * folder named by `PASEO_BM_HOME`. Never the real HOME.
 */

const T0 = Date.parse("2026-09-29T08:00:00.000Z");
let root: string;
let home: string;
let clock: number;
let deps: InboxRpcDeps;

const store = () => createAlertStore(home, { now: () => new Date(clock) });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-inbox-rpc-"));
  home = join(root, "data");
  clock = T0;
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, log: () => undefined };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("inbox.alerts", () => {
  it("reads nothing, and writes nothing, when no alert was ever raised", () => {
    expect(handleInboxAlerts({}, deps)).toEqual({ alerts: [], truncated: false });
  });

  it("returns the open alerts only, in ALERT_KINDS order and oldest first within a kind", () => {
    const s = store();
    s.raise({ workspaceId: "wks_1", kind: "fallback-failed", subject: "f:fb-000000000d01" });
    clock += 60_000;
    s.raise({ workspaceId: "wks_1", kind: "stuck", subject: "wrk-2", detail: "no tool call" });
    clock += 60_000;
    s.raise({ workspaceId: "wks_2", kind: "stuck", subject: "wrk-1" });
    s.raise({ workspaceId: "wks_2", kind: "request-stalled", subject: "req-A" });
    const cleared = s.raise({ workspaceId: "wks_1", kind: "danger", subject: "wrk-3" });
    s.clear(cleared.alert.key);

    const out = handleInboxAlerts({}, deps);
    expect(inboxAlertsRpc.output.parse(out)).toEqual(out);
    expect(out.alerts.map((alert) => `${alert.kind}:${alert.subject}`)).toEqual([
      "request-stalled:req-A",
      "stuck:wrk-2",
      "stuck:wrk-1",
      "fallback-failed:f:fb-000000000d01",
    ]);
    expect(out.alerts[1]).toMatchObject({ key: "stuck:wks_1:wrk-2", detail: "no tool call", clearedAt: null });
    expect(handleInboxAlerts({ workspaceId: "wks_2" }, deps).alerts.map((alert) => alert.subject)).toEqual(["req-A", "wrk-1"]);
  });

  it("stops at INBOX_ALERTS_MAX and says more were open", () => {
    const s = store();
    for (let n = 0; n <= INBOX_ALERTS_MAX; n += 1) s.raise({ workspaceId: "wks_1", kind: "stuck", subject: `wrk-${n}` });
    const out = handleInboxAlerts({}, deps);
    expect(out.alerts).toHaveLength(INBOX_ALERTS_MAX);
    expect(out.truncated).toBe(true);
  });

  it("reads as no alerts without a usable data folder", () => {
    expect(handleInboxAlerts({}, { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual({ alerts: [], truncated: false });
  });

  it("registers its RPCs: the alerts, and Decided for you's showing and digest (autonomy design §B.7)", () => {
    const handle = vi.fn();
    registerInboxRpcs({ handle } as unknown as Parameters<typeof registerInboxRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["inbox.alerts", "inbox.seen", "inbox.digest"]);
    store().raise({ workspaceId: "wks_1", kind: "stuck", subject: "wrk-1" });
    const handler = handle.mock.calls[0]![1] as (input: unknown) => { alerts: unknown[] };
    expect(handler({}).alerts).toHaveLength(1);
  });

  it("starts onRead (the outdated-agents pass) with the RPC's Paseo handle, never waiting for it or failing on it", () => {
    const handle = vi.fn();
    const onRead = vi.fn(() => new Promise<never>(() => {}));
    registerInboxRpcs({ handle } as unknown as Parameters<typeof registerInboxRpcs>[0], { ...deps, onRead });
    const handler = handle.mock.calls[0]![1] as (input: unknown, context?: unknown) => { alerts: unknown[] };
    const paseo = { agents: {} };
    expect(handler({}, { paseo })).toEqual({ alerts: [], truncated: false });
    expect(onRead).toHaveBeenCalledWith(paseo);

    const throwing = vi.fn();
    registerInboxRpcs({ handle: throwing } as unknown as Parameters<typeof registerInboxRpcs>[0], {
      ...deps,
      onRead: () => {
        throw new Error("boom");
      },
    });
    const broken = throwing.mock.calls[0]![1] as (input: unknown, context?: unknown) => { alerts: unknown[] };
    expect(broken({}, { paseo }).alerts).toEqual([]);
  });
});

describe("inbox.digest: the Orchestrator's interventions since the owner last looked (autonomy design §G.3; bead t9lm.23)", () => {
  const minutesBefore = (minutes: number) => new Date(T0 - minutes * 60_000).toISOString();
  let ids: number;
  let logs: string[];
  const quietDeps = (): InboxRpcDeps => ({ ...deps, log: (message) => void logs.push(message) });

  /** Logs one intervention `minutes` before T0, with the next id `iv-<n>`. */
  function logged(minutes: number, input: Partial<InterventionInput> & Pick<InterventionInput, "kind">): InterventionEntry {
    const store = createInterventionStore(home, { now: () => new Date(T0 - minutes * 60_000), newId: () => `iv-${++ids}` });
    return store.record({ workspaceId: "wks_1", requestId: "req-A", targetAgentId: "wrk-1", trigger: "orchestrator", ...input });
  }

  function command(id: string, fields: { reason: string; to?: "worker"; workerId?: string }): void {
    createOrchestratorStore(home, { now: () => new Date(T0 - 11 * 60_000) }).appendCommand({
      id,
      workspaceId: "wks_1",
      managerId: "mgr-1",
      requestId: "req-A",
      situation: "the request",
      command: "Carry on.",
      sentText: "BM-COMMAND v2",
      outcome: "sent",
      ...fields,
    });
  }

  const SCOPE: DecisionOption[] = [
    { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] },
    { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] },
  ];

  beforeEach(() => {
    ids = 0;
    logs = [];
    clearDecisionStoreCache();
  });

  afterEach(() => {
    clearDecisionStoreCache();
  });

  it("lists them after `since`, the latest first, of the workspace asked, with the outcome settled so far, whom each was for and the Orchestrator's words", () => {
    command("cmd-w", { reason: "The stall is a flaky test.", to: "worker", workerId: "wrk-1" });
    command("cmd-m", { reason: "" });
    const decisions = createDecisionStore(home);
    const asked = makeDecision({ id: "q:req-A:Q1", requestId: "req-A", class: "scope", options: SCOPE, prediction: openingPrediction(SCOPE) });
    const answered = answerDecision(asked, { by: "policy", via: "inbox", optionKey: "a", class: "scope", predictor: "orchestrator", reason: "Day first, as the owner writes.", at: minutesBefore(6) });
    if (!answered.ok) throw new Error(answered.message);
    decisions.open(answered.decision);
    decisions.open(
      makeDecision({
        id: "o:4b1f0c2e",
        requestId: null,
        round: null,
        askedBy: { role: "orchestrator", agentId: "orch-1" },
        question: "Delegate scope questions in this project?\n\nRecommendation: yes, the last twenty matched.",
        options: SCOPE,
      }),
    );

    logged(40, { kind: "unblock", trigger: "request.stalled", commandId: "cmd-w" });
    const unblock = logged(10, { kind: "unblock", trigger: "request.stalled", alertKey: "request-stalled:wks_1:req-A", commandId: "cmd-w" });
    logged(8, { kind: "correct", trigger: "owner", targetAgentId: "mgr-1", commandId: "cmd-m" });
    logged(6, { kind: "answer", trigger: "decision.opened", decisionId: "q:req-A:Q1" });
    logged(4, { kind: "advice", trigger: "advice.due", requestId: null, targetAgentId: null, decisionId: "o:4b1f0c2e" });
    logged(3, { kind: "correct", workspaceId: "wks_2", commandId: "cmd-elsewhere" });
    logged(2, { kind: "stop", trigger: "worker.signal", signal: "danger", commandId: "cmd-gone" });
    createInterventionStore(home, { now: () => new Date(T0) }).settle([{ id: unblock.id, outcome: "met" }]);

    const out = handleInboxDigest({ since: minutesBefore(30) }, quietDeps());
    expect(inboxDigestRpc.output.parse(out)).toEqual(out);
    expect(out.decisions.map((decision) => decision.id)).toEqual(["q:req-A:Q1"]);
    expect(out.interventionsTruncated).toBe(false);
    expect(out.interventions.map(({ id, kind, targetRole, reason, outcome }) => ({ id, kind, targetRole, reason, outcome }))).toEqual([
      { id: "iv-7", kind: "stop", targetRole: "worker", reason: null, outcome: "pending" },
      { id: "iv-6", kind: "correct", targetRole: null, reason: null, outcome: "pending" },
      { id: "iv-5", kind: "advice", targetRole: "owner", reason: "Delegate scope questions in this project?", outcome: "pending" },
      { id: "iv-4", kind: "answer", targetRole: "worker", reason: "Day first, as the owner writes.", outcome: "pending" },
      { id: "iv-3", kind: "correct", targetRole: "manager", reason: null, outcome: "pending" },
      { id: "iv-2", kind: "unblock", targetRole: "worker", reason: "The stall is a flaky test.", outcome: "met" },
    ]);
    // The entry comes back as logged: ids, trigger, expected outcome and window, the check's time.
    expect(out.interventions.at(-1)).toMatchObject({
      workspaceId: "wks_1",
      requestId: "req-A",
      targetAgentId: "wrk-1",
      trigger: "request.stalled",
      expected: "stall-clears",
      windowMs: 15 * 60_000,
      at: minutesBefore(10),
      checkedAt: new Date(T0).toISOString(),
      alertKey: "request-stalled:wks_1:req-A",
      commandId: "cmd-w",
    });

    expect(handleInboxDigest({ since: minutesBefore(30), workspaceId: "wks_1" }, quietDeps()).interventions.map((entry) => entry.id)).toEqual(["iv-7", "iv-5", "iv-4", "iv-3", "iv-2"]);
    expect(handleInboxDigest({ workspaceId: "wks_1" }, quietDeps()).interventions.map((entry) => entry.id)).toEqual(["iv-7", "iv-5", "iv-4", "iv-3", "iv-2", "iv-1"]);
    expect(handleInboxDigest({ since: minutesBefore(1) }, quietDeps()).interventions).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("masks secrets in the Orchestrator's words and keeps them to one line of at most DIGEST_INTERVENTION_REASON_MAX characters", () => {
    command("cmd-s", { reason: "Retry with --token abc123 and the daemon password hunter-two-secret.", to: "worker", workerId: "wrk-1" });
    logged(5, { kind: "correct", trigger: "owner", commandId: "cmd-s" });
    const out = handleInboxDigest({}, { ...quietDeps(), redactEnv: { PASEO_PASSWORD: "hunter-two-secret" } });
    expect(out.interventions[0]!.reason).toBe("Retry with --token [redacted] and the daemon password [redacted].");

    const entry = logged(4, { kind: "advice", trigger: "owner", requestId: null, targetAgentId: null, decisionId: "o:1" });
    const long = interventionReasonOf(entry, { decision: { question: `${"word ".repeat(100)}\nsecond line`, answer: null }, command: undefined }, {});
    expect(long!.length).toBe(DIGEST_INTERVENTION_REASON_MAX);
    expect(long!.endsWith("…")).toBe(true);
    expect(long).not.toContain("second line");
    expect(interventionReasonOf(entry, { decision: null, command: undefined }, {})).toBeNull();
  });

  it("names whom each was for from the stores: advice the owner, an answer the asking Worker, a compaction its target, a command its recorded target, else a Worker signal's Worker", () => {
    const entry = (input: Partial<InterventionInput> & Pick<InterventionInput, "kind">) => logged(1, input);
    expect(interventionTargetRoleOf(entry({ kind: "advice", targetAgentId: null }), undefined)).toBe("owner");
    expect(interventionTargetRoleOf(entry({ kind: "answer", decisionId: "q:req-A:Q2" }), undefined)).toBe("worker");
    expect(interventionTargetRoleOf(entry({ kind: "answer", decisionId: "f:fb-000000000d01", targetAgentId: null }), undefined)).toBeNull();
    expect(interventionTargetRoleOf(entry({ kind: "unblock", commandId: "c" }), { to: "worker" })).toBe("worker");
    expect(interventionTargetRoleOf(entry({ kind: "unblock", commandId: "c" }), {})).toBe("manager");
    expect(interventionTargetRoleOf(entry({ kind: "stop", signal: "danger" }), undefined)).toBe("worker");
    expect(interventionTargetRoleOf(entry({ kind: "correct", trigger: "owner" }), undefined)).toBeNull();
    expect(interventionTargetRoleOf(entry({ kind: "compact" }), undefined)).toBeNull();
    expect(interventionTargetRoleOf(entry({ kind: "compact" }), undefined, { role: "worker" })).toBe("worker");
    expect(interventionTargetRoleOf(entry({ kind: "compact", requestId: null, targetAgentId: "mgr-1" }), undefined, { role: "manager" })).toBe("manager");
  });

  it("shows a compaction (bm_compact) with its target's role and its reason, from the compactions store, masked and cut like the others (autonomy design §G.5)", () => {
    const worker = logged(9, { kind: "compact", trigger: "threshold.crossed" });
    const manager = logged(7, { kind: "compact", trigger: "orchestrator", requestId: null, targetAgentId: "mgr-1" });
    const lost = logged(5, { kind: "compact", trigger: "owner" });
    const compactions = createCompactionStore(home, { now: () => new Date(T0 - 9 * 60_000) });
    compactions.add({
      workspaceId: "wks_1",
      requestId: "req-A",
      agentId: "wrk-1",
      role: "worker",
      provider: "claude",
      interventionId: worker.id,
      reason: "Context at 182,000 of 200,000 tokens,\nfourth turn over the threshold; token hunter-two-secret seen.",
    });
    compactions.add({ workspaceId: "wks_1", requestId: null, agentId: "mgr-1", role: "manager", provider: "codex", interventionId: manager.id, reason: "The Manager reads 150,000 tokens a turn." });
    // A compaction whose intervention could not be logged names none.
    compactions.add({ workspaceId: "wks_1", requestId: "req-A", agentId: "wrk-1", role: "worker", provider: "claude", interventionId: null, reason: "Unlinked." });

    const out = handleInboxDigest({}, { ...quietDeps(), redactEnv: { PASEO_PASSWORD: "hunter-two-secret" } });
    expect(inboxDigestRpc.output.parse(out)).toEqual(out);
    expect(out.interventions.map(({ id, kind, targetRole, reason }) => ({ id, kind, targetRole, reason }))).toEqual([
      { id: lost.id, kind: "compact", targetRole: null, reason: null },
      { id: manager.id, kind: "compact", targetRole: "manager", reason: "The Manager reads 150,000 tokens a turn." },
      { id: worker.id, kind: "compact", targetRole: "worker", reason: "Context at 182,000 of 200,000 tokens, fourth turn over the threshold; token [redacted] seen." },
    ]);
    expect(logs).toEqual([]);

    const long = interventionReasonOf(worker, { decision: null, command: undefined, compaction: { reason: "word ".repeat(100) } }, {});
    expect(long!.length).toBe(DIGEST_INTERVENTION_REASON_MAX);
    expect(long!.endsWith("…")).toBe(true);
    expect(interventionReasonOf(worker, { decision: null, command: undefined, compaction: null }, {})).toBeNull();

    // A compactions store that cannot be read safely (a symlinked file) reads as none, in one log line; the interventions still come.
    const file = join(home, ORCHESTRATOR_DIR_NAME, COMPACTIONS_FILE);
    const elsewhere = join(root, "compactions-elsewhere.json");
    writeFileSync(elsewhere, "{}");
    rmSync(file);
    symlinkSync(elsewhere, file);
    const unreadable = handleInboxDigest({}, quietDeps());
    expect(unreadable.interventions.map(({ targetRole, reason }) => ({ targetRole, reason }))).toEqual([
      { targetRole: null, reason: null },
      { targetRole: null, reason: null },
      { targetRole: null, reason: null },
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[paseo-bm\] could not read the Orchestrator's compactions: /);
  });

  it("stops at INBOX_DIGEST_MAX with a truncation of its own, reads only, and never costs the Inbox its decisions", () => {
    expect(handleInboxDigest({}, quietDeps())).toEqual({ decisions: [], truncated: false, interventions: [], interventionsTruncated: false });
    expect(existsSync(join(home, ORCHESTRATOR_DIR_NAME))).toBe(false);

    const entries = Array.from({ length: INBOX_DIGEST_MAX + 1 }, (_, index) => ({
      id: `iv-${index}`,
      kind: "stop",
      workspaceId: "wks_1",
      requestId: null,
      targetAgentId: "wrk-1",
      trigger: "orchestrator",
      expected: "turn-ends",
      windowMs: 120_000,
      at: minutesBefore(index),
      outcome: "pending",
      checkedAt: null,
    }));
    mkdirSync(join(home, ORCHESTRATOR_DIR_NAME), { recursive: true });
    writeFileSync(join(home, ORCHESTRATOR_DIR_NAME, INTERVENTIONS_FILE), JSON.stringify({ version: 1, entries }));
    const full = handleInboxDigest({}, quietDeps());
    expect(full.interventions).toHaveLength(INBOX_DIGEST_MAX);
    expect(full.interventions[0]!.id).toBe("iv-0");
    expect(full).toMatchObject({ truncated: false, interventionsTruncated: true });

    // A corrupt log reads as none.
    writeFileSync(join(home, ORCHESTRATOR_DIR_NAME, INTERVENTIONS_FILE), "{ not json");
    expect(handleInboxDigest({}, quietDeps()).interventions).toEqual([]);

    // A log that cannot be read safely (a symlinked folder) reads as none, in one log line; the decisions still come.
    rmSync(join(home, ORCHESTRATOR_DIR_NAME), { recursive: true });
    const asked = makeDecision({ id: "q:req-A:Q1", requestId: "req-A", class: "scope", options: SCOPE, prediction: openingPrediction(SCOPE) });
    const answered = answerDecision(asked, { by: "policy", via: "inbox", optionKey: "a", class: "scope", predictor: "recommended", reason: "The recommended option", at: minutesBefore(1) });
    if (!answered.ok) throw new Error(answered.message);
    createDecisionStore(home).open(answered.decision);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, ORCHESTRATOR_DIR_NAME));
    const out = handleInboxDigest({}, quietDeps());
    expect(out.decisions.map((decision) => decision.id)).toEqual(["q:req-A:Q1"]);
    expect(out.interventions).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[paseo-bm\] could not read the Orchestrator's interventions: /);

    expect(handleInboxDigest({}, { env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root })).toEqual({ decisions: [], truncated: false, interventions: [], interventionsTruncated: false });
  });
});
