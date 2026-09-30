import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleDecisionsAnswer,
  handleDecisionsConfirm,
  handleDecisionsGet,
  handleDecisionsList,
  registerDecisionRpcs,
  type DecisionRpcDeps,
} from "../plugin/server/decision-rpc";
import { DECISIONS_DIR_NAME, clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import {
  DashboardError,
  decisionsAnswerRpc,
  decisionsConfirmRpc,
  decisionsGetRpc,
  decisionsListRpc,
} from "../plugin/shared/contracts";
import { GRANT_TTL_MS, markNeedsConfirmation, supersedeDecision, withdrawDecision, type Decision } from "../plugin/shared/decisions";
import { DECISION_REQUEST, DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * The `decisions.*` RPCs (autonomy design §A.6) against a temporary data
 * folder named by `PASEO_BM_HOME`. Never the real HOME.
 */

const NOW = "2026-09-29T08:00:00.000Z";
const PASEO = { tag: "paseo-handle" };
let root: string;
let home: string;
let settled: Array<{ decisions: Decision[]; paseo: unknown }>;
let logs: string[];
let deps: DecisionRpcDeps;

const q = (n: number, overrides: Partial<Decision> = {}) => makeDecision({ id: `q:${DECISION_REQUEST}:Q${n}`, ...overrides });
const store = () => createDecisionStore(home);
const fileBytes = () => {
  const path = join(home, DECISIONS_DIR_NAME, `${DECISION_WS}.json`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

async function codeOf(run: () => unknown): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not a DashboardError: ${String(error)}`;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-decision-rpc-"));
  home = join(root, "data");
  settled = [];
  logs = [];
  deps = {
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    now: () => new Date(NOW),
    log: (message) => logs.push(message),
    onSettled: (decisions, { paseo }) => {
      settled.push({ decisions, paseo });
    },
  };
  clearDecisionStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("decisions.answer", () => {
  it("records the answer and its one-hour grant, then hands the decision to onSettled", async () => {
    store().open(q(1));
    const { decision } = await handleDecisionsAnswer({ id: q(1).id, optionKey: "a", confirmed: true }, PASEO, deps);
    expect(decisionsAnswerRpc.output.parse({ decision })).toEqual({ decision });
    expect(decision.status).toBe("answered");
    expect(decision.answer).toEqual({ by: "owner", via: "inbox", optionKey: "a", words: null, at: NOW });
    expect(decision.grant).toEqual({ effects: ["push"], expiresAt: new Date(Date.parse(NOW) + GRANT_TTL_MS).toISOString(), usedAt: null });
    expect(store().get(q(1).id)).toEqual(decision);
    expect(settled).toEqual([{ decisions: [decision], paseo: PASEO }]);
  });

  it("takes the owner's words and the chat-card surface", async () => {
    store().open(q(1));
    const { decision } = await handleDecisionsAnswer({ id: q(1).id, words: " Hold for now. ", via: "chat-card", confirmed: true }, PASEO, deps);
    expect(decision.answer).toMatchObject({ via: "chat-card", words: "Hold for now.", optionKey: null });
  });

  it("refuses both optionKey and words, and neither, before reading anything", async () => {
    store().open(q(1));
    const before = fileBytes();
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id, optionKey: "a", words: "yes" }, PASEO, deps))).toBe("E_DECISION_ANSWER_INVALID");
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id }, PASEO, deps))).toBe("E_DECISION_ANSWER_INVALID");
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id, words: "  " }, PASEO, deps))).toBe("E_DECISION_ANSWER_INVALID");
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id, optionKey: "z" }, PASEO, deps))).toBe("E_DECISION_ANSWER_INVALID");
    expect(fileBytes()).toBe(before);
    expect(settled).toEqual([]);
  });

  it("refuses an unknown decision", async () => {
    expect(await codeOf(() => handleDecisionsAnswer({ id: "q:req-none:Q1", optionKey: "a" }, PASEO, deps))).toBe("E_DECISION_NOT_FOUND");
    store().open(q(1));
    expect(await codeOf(() => handleDecisionsAnswer({ id: "o:not-here", optionKey: "a" }, PASEO, deps))).toBe("E_DECISION_NOT_FOUND");
  });

  it("refuses a settled decision: answered, superseded, withdrawn or expired", async () => {
    const s = store();
    s.open(q(1));
    await handleDecisionsAnswer({ id: q(1).id, optionKey: "a", confirmed: true }, PASEO, deps);
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id, optionKey: "c", confirmed: true }, PASEO, deps))).toBe("E_DECISION_SETTLED");

    s.open(q(2));
    s.open(q(3, { supersedes: q(2).id }));
    const superseded = handleDecisionsAnswer({ id: q(2).id, optionKey: "a", confirmed: true }, PASEO, deps);
    await expect(superseded).rejects.toThrow(/E_DECISION_SETTLED: .*superseded by q:req-20260929T073348Z:Q3/);

    s.open(q(4));
    s.transition(q(4).id, (d) => withdrawDecision(d, { at: NOW }));
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(4).id, words: "go", confirmed: true }, PASEO, deps))).toBe("E_DECISION_SETTLED");

    // Only the first answer reached the delivery hook.
    expect(settled).toHaveLength(1);
  });

  it("needs the owner's confirmation for a release, data, security or cost effect (X-4)", async () => {
    store().open(q(1));
    const before = fileBytes();
    // Option b pushes and publishes.
    const refused = handleDecisionsAnswer({ id: q(1).id, optionKey: "b" }, PASEO, deps);
    await expect(refused).rejects.toThrow(/E_DECISION_NOT_CONFIRMED: .*publish/);
    // Own words grant every declared effect, publish included.
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id, words: "Do it." }, PASEO, deps))).toBe("E_DECISION_NOT_CONFIRMED");
    expect(fileBytes()).toBe(before);

    const { decision } = await handleDecisionsAnswer({ id: q(1).id, optionKey: "b", confirmed: true }, PASEO, deps);
    expect(decision.grant?.effects).toEqual(["push", "publish"]);
  });

  it("keeps the answer when onSettled fails, and says so in the log", async () => {
    store().open(q(1));
    deps.onSettled = () => Promise.reject(new Error("queue is gone"));
    const { decision } = await handleDecisionsAnswer({ id: q(1).id, optionKey: "a", confirmed: true }, PASEO, deps);
    expect(decision.status).toBe("answered");
    expect(store().get(q(1).id)?.status).toBe("answered");
    expect(logs.join("\n")).toMatch(/delivery failed: queue is gone/);
  });

  it("returns what the delivery hook recorded on the decision", async () => {
    store().open(q(1));
    deps.onSettled = ([decision]) => {
      store().transition(decision!.id, (d) => ({
        ok: true,
        decision: { ...d, delivery: { to: "agent-worker", kind: `answers:${DECISION_REQUEST}`, at: NOW, outcome: "queued" } },
      }));
    };
    const { decision } = await handleDecisionsAnswer({ id: q(1).id, optionKey: "a", confirmed: true }, PASEO, deps);
    expect(decision.delivery?.outcome).toBe("queued");
  });

  it("works without a delivery hook (the default no-op)", async () => {
    store().open(q(1));
    const plain: DecisionRpcDeps = { ...deps, onSettled: undefined };
    const { decision } = await handleDecisionsAnswer({ id: q(1).id, optionKey: "a", confirmed: true }, PASEO, plain);
    expect(decision.status).toBe("answered");
  });

  it("fails E_DATA_HOME_UNAVAILABLE without a usable data folder", async () => {
    const bad = { ...deps, env: { PASEO_BM_HOME: "relative/path" } };
    expect(await codeOf(() => handleDecisionsAnswer({ id: q(1).id, optionKey: "a", confirmed: true }, PASEO, bad))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(await codeOf(() => handleDecisionsGet({ id: q(1).id }, bad))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(handleDecisionsList({ scope: "inbox" }, bad)).toEqual({ decisions: [], truncated: false });
  });
});

describe("decisions.confirm", () => {
  const marked = () => {
    store().open(q(1));
    store().transition(q(1).id, (d) => markNeedsConfirmation(d, { via: "chat-worker", at: NOW }));
  };

  it("closes a decision answered in the chat and hands it to onSettled", async () => {
    marked();
    const { decision } = await handleDecisionsConfirm({ id: q(1).id, answered: true }, PASEO, deps);
    expect(decisionsConfirmRpc.output.parse({ decision })).toEqual({ decision });
    expect(decision.status).toBe("answered");
    expect(decision.answer).toEqual({ by: "owner", via: "chat-worker", optionKey: null, words: null, at: NOW });
    expect(decision.grant).toBeNull();
    expect(settled.map((entry) => entry.decisions[0]!.id)).toEqual([q(1).id]);
  });

  it("returns a decision to open on Keep open, without delivering anything", async () => {
    marked();
    const { decision } = await handleDecisionsConfirm({ id: q(1).id, answered: false }, PASEO, deps);
    expect(decision.status).toBe("open");
    expect(decision.needsConfirmation).toBeNull();
    expect(settled).toEqual([]);
  });

  it("refuses a decision that is not waiting, settled or unknown", async () => {
    store().open(q(1));
    expect(await codeOf(() => handleDecisionsConfirm({ id: q(1).id, answered: true }, PASEO, deps))).toBe("E_DECISION_NOT_NEEDS_CONFIRMATION");
    store().open(q(2));
    store().transition(q(2).id, (d) => supersedeDecision(d, { by: q(3).id, at: NOW }));
    expect(await codeOf(() => handleDecisionsConfirm({ id: q(2).id, answered: false }, PASEO, deps))).toBe("E_DECISION_SETTLED");
    expect(await codeOf(() => handleDecisionsConfirm({ id: "q:req-none:Q1", answered: true }, PASEO, deps))).toBe("E_DECISION_NOT_FOUND");
  });
});

describe("decisions.get and decisions.list", () => {
  const at = (minute: number) => `2026-09-29T07:${String(minute).padStart(2, "0")}:00.000Z`;

  beforeEach(() => {
    const s = store();
    s.open(q(1, { askedAt: at(10) }));
    s.open(q(2, { askedAt: at(5) }));
    s.open(makeDecision({ id: "q:req-B:Q1", requestId: "req-B", askedAt: at(20) }));
    s.open(makeDecision({ workspaceId: "wks_2", id: "q:req-C:Q1", requestId: "req-C", askedAt: at(1) }));
    s.transition("q:req-B:Q1", (d) => withdrawDecision(d, { at: NOW }));
    s.transition(q(2).id, (d) => markNeedsConfirmation(d, { via: "chat-worker", at: NOW }));
  });

  it("gets one decision, or E_DECISION_NOT_FOUND", async () => {
    const { decision } = handleDecisionsGet({ id: "q:req-C:Q1" }, deps);
    expect(decisionsGetRpc.output.parse({ decision }).decision.workspaceId).toBe("wks_2");
    expect(await codeOf(() => handleDecisionsGet({ id: "q:req-none:Q1" }, deps))).toBe("E_DECISION_NOT_FOUND");
  });

  it("inbox: the unsettled decisions of every workspace, oldest asked first", () => {
    const out = handleDecisionsList({ scope: "inbox" }, deps);
    expect(decisionsListRpc.output.parse(out)).toEqual(out);
    expect(out.decisions.map((d) => d.id)).toEqual(["q:req-C:Q1", q(2).id, q(1).id]);
    expect(handleDecisionsList({ scope: "inbox", workspaceId: DECISION_WS }, deps).decisions.map((d) => d.id)).toEqual([q(2).id, q(1).id]);
    expect(handleDecisionsList({ scope: "inbox", status: "needs-confirmation" }, deps).decisions.map((d) => d.id)).toEqual([q(2).id]);
  });

  it("workspace: every decision of it, newest asked first", () => {
    expect(handleDecisionsList({ scope: "workspace", workspaceId: DECISION_WS }, deps).decisions.map((d) => d.id)).toEqual([
      "q:req-B:Q1",
      q(1).id,
      q(2).id,
    ]);
    expect(handleDecisionsList({ scope: "workspace", workspaceId: DECISION_WS, status: "withdrawn" }, deps).decisions.map((d) => d.id)).toEqual([
      "q:req-B:Q1",
    ]);
  });

  it("request: the decisions of one request, in any workspace unless one is named", () => {
    expect(handleDecisionsList({ scope: "request", requestId: DECISION_REQUEST }, deps).decisions.map((d) => d.id)).toEqual([q(1).id, q(2).id]);
    expect(handleDecisionsList({ scope: "request", requestId: "req-C" }, deps).decisions.map((d) => d.id)).toEqual(["q:req-C:Q1"]);
    expect(handleDecisionsList({ scope: "request", requestId: "req-C", workspaceId: DECISION_WS }, deps).decisions).toEqual([]);
  });

  it("stops at limit and says more matched", () => {
    const out = handleDecisionsList({ scope: "workspace", workspaceId: DECISION_WS, limit: 2 }, deps);
    expect(out.decisions).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("the contract asks for the workspace or the request its scope needs", () => {
    expect(decisionsListRpc.input.safeParse({ scope: "workspace" }).success).toBe(false);
    expect(decisionsListRpc.input.safeParse({ scope: "request" }).success).toBe(false);
    expect(decisionsListRpc.input.safeParse({ scope: "inbox" }).success).toBe(true);
    expect(decisionsListRpc.input.safeParse({ scope: "inbox", limit: 501 }).success).toBe(false);
  });
});

describe("registration", () => {
  it("registers the four RPCs and passes the Paseo handle to the answer's hook", async () => {
    const handle = vi.fn();
    registerDecisionRpcs({ handle } as unknown as Parameters<typeof registerDecisionRpcs>[0], deps);
    const contracts = handle.mock.calls.map(([contract]) => contract as { name: string });
    expect(contracts.map((contract) => contract.name)).toEqual(["decisions.list", "decisions.get", "decisions.answer", "decisions.confirm"]);

    store().open(q(1));
    const answer = handle.mock.calls.find(([contract]) => contract === decisionsAnswerRpc)![1] as (
      input: unknown,
      context: { paseo: unknown },
    ) => Promise<{ decision: Decision }>;
    const { decision } = await answer({ id: q(1).id, optionKey: "a", confirmed: true }, { paseo: PASEO });
    expect(decision.status).toBe("answered");
    expect(settled[0]!.paseo).toBe(PASEO);
  });
});
