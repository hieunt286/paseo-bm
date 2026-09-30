import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDecisionsAnswer, settledByKind, type DecisionRpcDeps } from "../plugin/server/decision-rpc";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createAlertStore } from "../plugin/server/alert-store";
import {
  createFallbackDecisionDelivery,
  createFallbackDecisionStartup,
  fallbackDecisionId,
  fallbackDecisionOf,
  incidentIdOf,
  syncFallbackDecisions,
} from "../plugin/server/fallback-decisions";
import { decidePending, handleFallbackAct, type FallbackAction, type FallbackActions } from "../plugin/server/fallback-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { MAX_DECISION_TEXT_CHARS, decisionSchema, type Decision } from "../plugin/shared/decisions";
import type { FallbackIncident } from "../plugin/shared/contracts";

/**
 * Autonomy design §A.5 d (REQ-110, REQ-111): each pending fallback incident is
 * one open decision `f:<incidentId>` with the card's options as prepared
 * actions; answering runs `fallback.act`'s own handler once; an incident
 * resolved another way withdraws the decision. Temporary data folder only.
 */

const NOW = new Date("2026-09-29T08:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const CANDIDATE = { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: null, modeId: null };
const ID = "fb-000000000d01";

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: ID,
  role: "worker",
  workspaceId: "wks_1",
  requestId: "req-20260929T073348Z",
  agentId: "wrk-1",
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: "mgr-1",
  managerId: "mgr-1",
  class: "L1",
  signal: "failed",
  message: "You've hit your usage limit.\nIt resets at 3:40pm.",
  perModelWindow: false,
  resetsAt: at(120),
  candidate: CANDIDATE,
  status: "pending",
  detectedAt: "2026-09-29T07:55:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

let root: string;
let home: string;
let logs: string[];
const log = (message: string) => void logs.push(message);
const now = () => NOW;

const writeIncidents = (incidents: FallbackIncident[]) =>
  writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }));
const readIncidentsFile = (): FallbackIncident[] => JSON.parse(readFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "utf8")).incidents;
const store = () => createDecisionStore(home);
const decisions = () => store().list();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-fallback-decisions-"));
  home = join(root, "data");
  mkdirSync(home);
  logs = [];
  clearDecisionStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the decision of an incident", () => {
  it("is a valid open plugin decision with the card's options, each a prepared fallback action declaring no effect", () => {
    const decision = fallbackDecisionOf(incident(), NOW);
    expect(decisionSchema.parse(decision)).toEqual(decision);
    expect(decision).toMatchObject({
      id: `f:${ID}`,
      workspaceId: "wks_1",
      requestId: "req-20260929T073348Z",
      askedBy: { role: "plugin", agentId: null },
      askedAt: "2026-09-29T07:55:00.000Z",
      subject: "fallback-worker",
      status: "open",
      grant: null,
      delivery: null,
    });
    expect(decision.question).toBe(
      `The Worker wrk-1 stopped: L1 usage limit on bm-worker · claude-opus-5. The provider said: "You've hit your usage limit. It resets at 3:40pm." What should happen?`,
    );
    expect(decision.options).toEqual([
      {
        key: "switch",
        label: "Switch to bm-worker-fallback-1 · codex · gpt-5.6-sol",
        recommended: true,
        effects: ["none"],
        action: { kind: "fallback", action: "switch", target: ID },
      },
      {
        key: "wait",
        label: `Wait until the limit resets (${at(120)}), then resume`,
        recommended: false,
        effects: ["none"],
        action: { kind: "fallback", action: "wait", target: ID },
      },
      { key: "dismiss", label: "I'll handle it", recommended: false, effects: ["none"], action: { kind: "fallback", action: "dismiss", target: ID } },
    ]);
  });

  it("recommends what the Auto policy would do, offers Wait only for a reset within 7 days, and Switch only with a candidate", () => {
    const keys = (overrides: Partial<FallbackIncident>) =>
      fallbackDecisionOf(incident(overrides), NOW).options.map((option) => `${option.key}${option.recommended ? "*" : ""}`);
    expect(keys({ resetsAt: at(20) })).toEqual(["switch", "wait*", "dismiss"]);
    expect(keys({ resetsAt: at(-5) })).toEqual(["switch", "wait*", "dismiss"]);
    expect(fallbackDecisionOf(incident({ resetsAt: at(-5) }), NOW).options[1]!.label).toBe(`Resume now (the limit reset at ${at(-5)})`);
    expect(keys({ resetsAt: at(8 * 24 * 60) })).toEqual(["switch*", "dismiss"]);
    expect(keys({ resetsAt: null, candidate: null })).toEqual(["dismiss"]);
    expect(fallbackDecisionOf(incident({ candidate: null }), NOW).question).toContain("No fallback model is left in its chain.");
  });

  it("has no request for a Manager, and keeps a long message within the question limit", () => {
    const decision = fallbackDecisionOf(incident({ role: "manager", requestId: null, parentId: null, managerId: "wrk-1", message: "x".repeat(900) }), NOW);
    expect(decisionSchema.parse(decision).requestId).toBeNull();
    expect(decision.subject).toBe("fallback-manager");
    expect(decision.question.length).toBeLessThanOrEqual(MAX_DECISION_TEXT_CHARS);
    expect(decision.question).toContain(`"${"x".repeat(300)}"`);
    expect(decision.question).not.toContain("x".repeat(301));
  });

  it("maps ids both ways", () => {
    expect(fallbackDecisionId(ID)).toBe(`f:${ID}`);
    expect(incidentIdOf(`f:${ID}`)).toBe(ID);
    expect(incidentIdOf("q:req-1:Q1")).toBeNull();
    expect(incidentIdOf("f:")).toBeNull();
  });
});

describe("syncFallbackDecisions", () => {
  it("opens exactly one decision per pending incident, and none again on the next pass", () => {
    writeIncidents([incident(), incident({ id: "fb-000000000d02", status: "switched" }), incident({ id: "fb-000000000d03", workspaceId: "wks_2" })]);
    expect(syncFallbackDecisions(home, { now, log })).toEqual({ opened: [`f:${ID}`, "f:fb-000000000d03"], withdrawn: [], alerted: [] });
    expect(syncFallbackDecisions(home, { now, log })).toEqual({ opened: [], withdrawn: [], alerted: [] });
    expect(decisions().map((decision) => decision.id).sort()).toEqual([`f:${ID}`, "f:fb-000000000d03"]);
  });

  it("withdraws the open decision of an incident resolved another way, or gone from the file", () => {
    writeIncidents([incident(), incident({ id: "fb-000000000d02" })]);
    syncFallbackDecisions(home, { now, log });
    writeIncidents([incident({ status: "dismissed", decidedAt: NOW.toISOString() })]);
    expect(syncFallbackDecisions(home, { now: () => new Date(at(1)), log })).toEqual({ opened: [], withdrawn: [`f:${ID}`, "f:fb-000000000d02"], alerted: [] });
    expect(store().get(`f:${ID}`)).toMatchObject({ status: "withdrawn", settledAt: at(1) });
  });

  it("never reopens a settled decision of a still-pending incident, nor touches other decisions", () => {
    writeIncidents([incident()]);
    const other = { ...fallbackDecisionOf(incident(), NOW), id: "q:req-20260929T073348Z:Q1", subject: null, options: [] } as Decision;
    store().open(other);
    syncFallbackDecisions(home, { now, log });
    store().transition(`f:${ID}`, (decision) => ({ ok: true, decision: { ...decision, status: "expired", settledAt: NOW.toISOString() } }));
    expect(syncFallbackDecisions(home, { now, log })).toEqual({ opened: [], withdrawn: [], alerted: [] });
    expect(store().get(other.id)?.status).toBe("open");
  });

  it("changes nothing while the incidents file cannot be read", () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), "{ not json");
    expect(syncFallbackDecisions(home, { now, log })).toEqual({ opened: [], withdrawn: [], alerted: [] });
    expect(store().get(`f:${ID}`)?.status).toBe("open");
  });

  it("runs once per plugin run from the startup hook, once a data folder is known", () => {
    writeIncidents([incident()]);
    let known: string | null = null;
    const startup = createFallbackDecisionStartup({ home: () => known, now, log });
    startup();
    expect(decisions()).toEqual([]);
    known = home;
    startup();
    expect(decisions().map((decision) => decision.id)).toEqual([`f:${ID}`]);
    store().transition(`f:${ID}`, (decision) => ({ ok: true, decision: { ...decision, status: "withdrawn", settledAt: NOW.toISOString() } }));
    writeIncidents([incident({ id: "fb-000000000d02" })]);
    startup();
    expect(decisions().map((decision) => decision.id)).toEqual([`f:${ID}`]);
  });
});

describe("answering a fallback decision", () => {
  /** Actions that record their decision as the real ones do at their last step, counting each run. */
  function actions() {
    const runs: string[] = [];
    const deciding = (status: "switched" | "waiting"): FallbackAction =>
      vi.fn(async (current: FallbackIncident, _paseo: unknown, deps: { home?: string | null }) => {
        runs.push(status);
        return decidePending(deps.home!, current.id, (entry) => ({ ...entry, status, decidedAt: NOW.toISOString() }));
      });
    const resend: FallbackAction = vi.fn(async (current: FallbackIncident) => {
      runs.push("resend");
      return current;
    });
    return { runs, switch: deciding("switched"), wait: deciding("waiting"), resend } satisfies FallbackActions & { runs: string[] };
  }

  function answering(acts: FallbackActions) {
    const paseos: unknown[] = [];
    const deps: DecisionRpcDeps = {
      env: { PASEO_BM_HOME: home },
      homedir: () => root,
      now,
      log,
      onSettled: settledByKind(
        {
          fallback: createFallbackDecisionDelivery(
            (input, paseo) => {
              paseos.push(paseo);
              return handleFallbackAct(input, paseo, { home, now, log, actions: acts });
            },
            { home: () => home, now, log },
          ),
        },
        log,
      ),
    };
    return { deps, paseos };
  }

  const PASEO = { tag: "paseo" };

  it.each([
    ["switch", "switched"],
    ["wait", "waiting"],
    ["dismiss", "dismissed"],
  ] as const)("%s runs its action once through fallback.act and records the delivery", async (key, status) => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const acts = actions();
    const { deps, paseos } = answering(acts);
    const { decision } = await handleDecisionsAnswer({ id: `f:${ID}`, optionKey: key }, PASEO, deps);
    expect(decision).toMatchObject({
      status: "answered",
      answer: { via: "inbox", optionKey: key },
      grant: null,
      delivery: { to: "wrk-1", kind: `fallback:${key}`, at: NOW.toISOString(), outcome: "sent" },
    });
    expect(readIncidentsFile()[0]!.status).toBe(status);
    expect(acts.runs).toEqual(key === "dismiss" ? [] : [status]);
    expect(paseos).toEqual([PASEO]);
    // A second answer is refused and runs nothing again.
    await expect(handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "dismiss" }, PASEO, deps)).rejects.toMatchObject({ code: "E_DECISION_SETTLED" });
    expect(paseos).toHaveLength(1);
    expect(store().get(`f:${ID}`)?.status).toBe("answered");
  });

  it("an incident decided on the card withdraws its decision: answering it is refused and runs nothing", async () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const acts = actions();
    await handleFallbackAct({ incidentId: ID, action: "dismiss" }, PASEO, { home, now, log, actions: acts });
    expect(store().get(`f:${ID}`)?.status).toBe("withdrawn");
    const { deps, paseos } = answering(acts);
    await expect(handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "switch" }, PASEO, deps)).rejects.toMatchObject({ code: "E_DECISION_SETTLED" });
    expect(paseos).toEqual([]);
    expect(acts.runs).toEqual([]);
  });

  it("records a failed delivery when the action refuses; the answer stands and the incident is as the action left it", async () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const refusing: FallbackAction = async () => {
      throw new Error("E_FALLBACK_CREATE_FAILED: agent tools are off");
    };
    const { deps } = answering({ switch: refusing });
    const { decision } = await handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "switch" }, PASEO, deps);
    expect(decision).toMatchObject({ status: "answered", delivery: { to: "wrk-1", kind: "fallback:switch", outcome: "failed" } });
    expect(readIncidentsFile()[0]!.status).toBe("pending");
    expect(logs.some((line) => line.includes(`decision f:${ID}: switch on fallback incident ${ID} failed`))).toBe(true);
  });

  it("a failed action while the incident is still pending opens a fallback-failed Inbox alert, cleared once the incident is resolved (design §A.8)", async () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const refusing: FallbackAction = async () => {
      throw new Error("E_FALLBACK_CREATE_FAILED: agent tools are off");
    };
    const { deps } = answering({ switch: refusing });
    await handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "switch" }, PASEO, deps);
    const alerts = () => createAlertStore(home, { now });
    expect(alerts().list({ open: true })).toEqual([
      expect.objectContaining({ workspaceId: "wks_1", kind: "fallback-failed", subject: `f:${ID}`, detail: expect.stringContaining(`(switch) for incident ${ID} failed`) }),
    ]);
    // Aligning again changes nothing: raised once.
    expect(syncFallbackDecisions(home, { now, log }).alerted).toEqual([]);
    expect(alerts().list()).toHaveLength(1);

    // The owner acts again on the card: the incident is no longer pending, the alert is cleared.
    await handleFallbackAct({ incidentId: ID, action: "dismiss" }, PASEO, { home, now, log, actions: {} });
    syncFallbackDecisions(home, { now, log });
    expect(alerts().list({ open: true })).toEqual([]);
    expect(alerts().list({ open: false }).map((alert) => alert.kind)).toEqual(["fallback-failed"]);
  });

  it("a successful action raises no alert", async () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const { deps } = answering(actions());
    await handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "switch" }, PASEO, deps);
    expect(createAlertStore(home).list()).toEqual([]);
  });

  it("runs a prepared resend for a switched Reviewer through the same handler", async () => {
    writeIncidents([incident({ role: "reviewer", status: "switched", parentId: "wrk-1", agentId: "rev-1" })]);
    const decision: Decision = {
      ...fallbackDecisionOf(incident({ role: "reviewer" }), NOW),
      options: [{ key: "resend", label: "Resend to Worker", recommended: true, effects: ["none"], action: { kind: "fallback", action: "resend", target: ID } }],
    };
    store().open(decision);
    const acts = actions();
    const { deps } = answering(acts);
    const answered = await handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "resend" }, PASEO, deps);
    expect(acts.runs).toEqual(["resend"]);
    expect(answered.decision.delivery).toMatchObject({ to: "rev-1", kind: "fallback:resend", outcome: "sent" });
  });

  it("an answer in words runs nothing", async () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const acts = actions();
    const { deps, paseos } = answering(acts);
    const { decision } = await handleDecisionsAnswer({ id: `f:${ID}`, words: "Leave it, I will look tonight" }, PASEO, deps);
    expect(decision).toMatchObject({ status: "answered", delivery: null });
    expect(paseos).toEqual([]);
    expect(readIncidentsFile()[0]!.status).toBe("pending");
  });

  it("the delivery runs a decision's action once even when handed it twice", async () => {
    writeIncidents([incident()]);
    syncFallbackDecisions(home, { now, log });
    const acts = actions();
    const { deps } = answering(acts);
    const { decision } = await handleDecisionsAnswer({ id: `f:${ID}`, optionKey: "switch" }, PASEO, deps);
    const deliver = createFallbackDecisionDelivery((input, paseo) => handleFallbackAct(input, paseo, { home, now, log, actions: acts }), { home: () => home, now, log });
    await Promise.all([deliver([decision], { paseo: PASEO }), deliver([decision], { paseo: PASEO })]);
    expect(acts.runs).toEqual(["switched"]);
  });
});

describe("settledByKind", () => {
  it("hands each kind its own decisions, skips kinds without a handler, and isolates a failing handler", async () => {
    const seen: string[] = [];
    const logged: string[] = [];
    const hook = settledByKind(
      {
        question: async (group) => {
          seen.push(...group.map((decision) => `question:${decision.id}`));
          throw new Error("boom");
        },
        fallback: async (group) => void seen.push(...group.map((decision) => `fallback:${decision.id}`)),
      },
      (message) => void logged.push(message),
    );
    const base = fallbackDecisionOf(incident(), NOW);
    await hook(
      [
        { ...base, id: "q:req-20260929T073348Z:Q1" },
        { ...base, id: "o:abc" },
        base,
        { ...base, id: "q:req-20260929T073348Z:Q2" },
      ],
      { paseo: null },
    );
    expect(seen).toEqual(["question:q:req-20260929T073348Z:Q1", "question:q:req-20260929T073348Z:Q2", `fallback:f:${ID}`]);
    expect(logged).toEqual([expect.stringMatching(/delivering q:req-20260929T073348Z:Q1, q:req-20260929T073348Z:Q2 failed: boom/)]);
  });
});
