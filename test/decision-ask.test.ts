import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  askKindOf,
  askNoticeOf,
  createReplyFallback,
  createWorkerTools,
  handleDecisionsAsk,
  handleDecisionsThread,
  replyToDecision,
  type DecisionAskDeps,
} from "../plugin/server/decision-ask";
import { answerWithServerTools } from "../plugin/server/agent-tools";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { THREADS_DIR_NAME, createDecisionThreadStore } from "../plugin/server/decision-thread-store";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { createOrchestratorTools } from "../plugin/server/orchestrator-tools";
import { DashboardError, decisionsAskRpc, decisionsThreadRpc } from "../plugin/shared/contracts";
import { MAX_THREAD_ENTRIES, MAX_THREAD_TEXT_CHARS, askableKindOf, hasOpenAsk, replyLineOf } from "../plugin/shared/decision-threads";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import { ASK_NOTICE_MARKER, isPluginNotice, noticeMarkerOf } from "../plugin/shared/notices";
import { msg, turn } from "./fixtures/orchestrator-traces";

/**
 * Ask back (change-014 outcome 3): the owner asks the asker of an open `q:` or
 * `o:` decision; the question is kept in a thread beside the decision and
 * delivered as `BM-ASK` through the notice queue; the asker replies with
 * `bm_reply` (or `BM-REPLY` in its chat). The decision stays open throughout.
 * Temporary data folder, a private queue and a fake Paseo only.
 */

const WORKSPACE = "wks_1";
const OTHER_WORKSPACE = "wks_2";
const REQUEST = "req-20261001T073348Z";
const WORKER = "wrk-1";
const ORCHESTRATOR = "orch-1";
const NOW = new Date("2026-10-01T08:00:00.000Z");
const Q1 = `q:${REQUEST}:Q1`;
const O1 = "o:7f1c2d3e-aaaa-bbbb-cccc-000000000001";

let root: string;
let home: string;
let logs: string[];

function decision(id: string, overrides: Partial<Decision> = {}): Decision {
  return {
    id,
    workspaceId: WORKSPACE,
    requestId: id.startsWith("q:") ? REQUEST : null,
    askedBy: { role: id.startsWith("o:") ? "orchestrator" : id.startsWith("q:") ? "worker" : "plugin", agentId: id.startsWith("o:") ? ORCHESTRATOR : WORKER },
    askedAt: "2026-10-01T07:40:00.000Z",
    round: 1,
    question: "Which date format should the invoice use?",
    subject: null,
    options: [
      { key: "a", label: "ISO 8601", recommended: true, effects: [] },
      { key: "b", label: "The locale's format", recommended: false, effects: [] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
    ...overrides,
  };
}

const store = () => createDecisionStore(home);
const open = (...decisions: Decision[]) => {
  for (const entry of decisions) store().open(entry);
};
const threadOf = (id: string, workspaceId = WORKSPACE) => createDecisionThreadStore(home).read(workspaceId, id);

/** A fake Paseo whose agents are idle until a `send()` starts a turn. */
function world(initial: Record<string, string> = { [WORKER]: "idle", [ORCHESTRATOR]: "idle" }) {
  const status = new Map(Object.entries(initial));
  const sends: Array<{ id: string; text: string }> = [];
  const paseo = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        refresh: async () => (status.has(id) ? { agent: { status: status.get(id)! } } : null),
        send: async (text: string) => {
          sends.push({ id, text });
          status.set(id, "running");
        },
      }),
    },
  };
  const queue = createNoticeQueue({ log: (message) => logs.push(message) });
  const turnEnds = async (id: string) => {
    status.set(id, "idle");
    await queue.turnEnded({ agent: { id } }, paseo);
  };
  return { paseo, sends, status, queue, turnEnds };
}

function deps(queue: DecisionAskDeps["queue"], overrides: Partial<DecisionAskDeps> = {}): DecisionAskDeps {
  return {
    home,
    now: () => NOW,
    log: (message) => logs.push(message),
    redactEnv: { PASEO_PASSWORD: "hunter2-secret" },
    queue,
    workerOf: async () => WORKER,
    orchestratorOf: async () => ORCHESTRATOR,
    ...overrides,
  };
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not coded: ${String(error)}`;
  }
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof DashboardError ? error.code : `not coded: ${String(error)}`;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-decision-ask-"));
  home = join(root, ".paseo-bm");
  logs = [];
  clearDecisionStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the thread store (beside the decision store)", () => {
  it("appends in order, per workspace, in decisions/threads/<workspaceId>.json, which the decision store never reads as a workspace", () => {
    open(decision(Q1));
    const threads = createDecisionThreadStore(home, { redactEnv: {} });
    expect(threads.read(WORKSPACE, Q1)).toEqual({ decisionId: Q1, entries: [] });
    threads.append(WORKSPACE, Q1, { by: "owner", text: "  Why not the locale?  ", at: "2026-10-01T08:00:00.000Z", agentId: WORKER });
    threads.append(WORKSPACE, Q1, { by: "asker", text: "The API wants ISO.", at: "2026-10-01T08:01:00.000Z" });
    threads.append(OTHER_WORKSPACE, Q1, { by: "owner", text: "Elsewhere.", at: "2026-10-01T08:02:00.000Z" });
    expect(threads.read(WORKSPACE, Q1).entries).toEqual([
      { by: "owner", text: "Why not the locale?", at: "2026-10-01T08:00:00.000Z", agentId: WORKER },
      { by: "asker", text: "The API wants ISO.", at: "2026-10-01T08:01:00.000Z" },
    ]);
    expect(threads.read(OTHER_WORKSPACE, Q1).entries.map((entry) => entry.text)).toEqual(["Elsewhere."]);
    const file = join(home, "decisions", THREADS_DIR_NAME, `${WORKSPACE}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1, threads: [{ decisionId: Q1 }] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store().workspaceIds()).toEqual([WORKSPACE]);
    expect(() => threads.read("../x", Q1)).toThrow();
  });

  it("masks before the disk, cuts a text to its limit and keeps the newest entries", () => {
    const threads = createDecisionThreadStore(home, { redactEnv: { PASEO_PASSWORD: "hunter2-secret" } });
    threads.append(WORKSPACE, Q1, { by: "owner", text: "Use hunter2-secret or run it with --password abc123?", at: "2026-10-01T08:00:00.000Z" });
    const stored = readFileSync(join(home, "decisions", THREADS_DIR_NAME, `${WORKSPACE}.json`), "utf8");
    expect(stored).not.toContain("hunter2-secret");
    expect(stored).not.toContain("abc123");
    expect(threads.read(WORKSPACE, Q1).entries[0]!.text).toBe("Use [redacted] or run it with --password [redacted]");
    threads.append(WORKSPACE, Q1, { by: "asker", text: "x".repeat(MAX_THREAD_TEXT_CHARS + 50), at: "2026-10-01T08:01:00.000Z" });
    expect(threads.read(WORKSPACE, Q1).entries[1]!.text).toHaveLength(MAX_THREAD_TEXT_CHARS);
    for (let index = 0; index < MAX_THREAD_ENTRIES + 3; index += 1) {
      threads.append(WORKSPACE, Q1, { by: index % 2 === 0 ? "owner" : "asker", text: `entry ${index}`, at: `2026-10-01T09:${String(index).padStart(2, "0")}:00.000Z` });
    }
    const entries = threads.read(WORKSPACE, Q1).entries;
    expect(entries).toHaveLength(MAX_THREAD_ENTRIES);
    expect(entries.at(-1)!.text).toBe(`entry ${MAX_THREAD_ENTRIES + 2}`);
    expect(entries[0]!.text).toBe("entry 3");
  });

  it("writes nothing when the guard refuses, or the text is blank", () => {
    const threads = createDecisionThreadStore(home, { redactEnv: {} });
    expect(threads.append(WORKSPACE, Q1, { by: "asker", text: "early", at: "2026-10-01T08:00:00.000Z" }, hasOpenAsk)).toBeNull();
    expect(threads.append(WORKSPACE, Q1, { by: "owner", text: "   ", at: "2026-10-01T08:00:00.000Z" })).toBeNull();
    expect(existsSync(join(home, "decisions"))).toBe(false);
  });
});

describe("decisions.ask (change-014 outcome 3)", () => {
  it("stores the owner's question beside an open Worker question, delivers BM-ASK to the Worker that asked, and leaves the decision open", async () => {
    open(decision(Q1));
    const { paseo, sends, queue } = world();
    const output = await handleDecisionsAsk({ id: Q1, text: "Why not the locale's format? hunter2-secret" }, paseo, deps(queue));
    expect(decisionsAskRpc.output.parse(output)).toEqual(output);
    expect(output.delivery).toBe("sent");
    expect(output.thread).toEqual({
      decisionId: Q1,
      entries: [{ by: "owner", text: "Why not the locale's format? [redacted]", at: NOW.toISOString(), agentId: WORKER }],
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.id).toBe(WORKER);
    const text = sends[0]!.text;
    expect(text.split("\n").slice(0, 2)).toEqual([ASK_NOTICE_MARKER, `decisionId: ${Q1}`]);
    expect(text).toContain("> Why not the locale's format? [redacted]");
    expect(text).not.toContain("hunter2-secret");
    expect(text).toContain("Answer with bm_reply { decisionId, text } in a few lines; do not answer the decision yourself, do not ask it again, and carry on with what does not depend on it. The decision stays open until the owner chooses.");
    expect(text).toContain(`If you have no bm_reply tool, reply in your chat starting with \`BM-REPLY ${Q1}\` on the first line`);
    expect(isPluginNotice(text)).toBe(true);
    expect(store().get(Q1)!.status).toBe("open");
    expect(handleDecisionsThread({ id: Q1 }, { home })).toEqual({ thread: output.thread });
  });

  it("waits for a running asker's turn end, and a newer ask replaces one still queued (kind ask:<id>)", async () => {
    open(decision(Q1));
    const { paseo, sends, queue, turnEnds } = world({ [WORKER]: "running" });
    expect((await handleDecisionsAsk({ id: Q1, text: "First?" }, paseo, deps(queue))).delivery).toBe("queued");
    expect((await handleDecisionsAsk({ id: Q1, text: "Second?" }, paseo, deps(queue))).delivery).toBe("queued");
    expect(sends).toEqual([]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual([askKindOf(Q1)]);
    await turnEnds(WORKER);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.text).toContain("> Second?");
    // Both questions are in the thread: the replaced notice only ever carried the older one.
    expect(threadOf(Q1).entries.map((entry) => entry.text)).toEqual(["First?", "Second?"]);
  });

  it("finds the request's live Worker when the asker is not recorded, and the open Orchestrator for its own decision", async () => {
    open(decision(Q1, { askedBy: { role: "worker", agentId: null } }), decision(O1));
    const { paseo, sends, queue } = world({ "wrk-2": "idle", "orch-9": "idle" });
    const asked: string[] = [];
    const custom = deps(queue, {
      workerOf: async (input) => (asked.push(input.requestId), "wrk-2"),
      orchestratorOf: async () => "orch-9",
    });
    expect((await handleDecisionsAsk({ id: Q1, text: "Q?" }, paseo, custom)).thread.entries[0]!.agentId).toBe("wrk-2");
    expect(asked).toEqual([REQUEST]);
    expect((await handleDecisionsAsk({ id: O1, text: "O?" }, paseo, custom)).delivery).toBe("sent");
    expect(sends.map((send) => send.id)).toEqual(["wrk-2", "orch-9"]);
    expect(sends[1]!.text.split("\n")[1]).toBe(`decisionId: ${O1}`);
  });

  it("keeps the question when no asker can be found or the asker is gone, and says the delivery failed", async () => {
    open(decision(Q1, { askedBy: { role: "worker", agentId: null } }), decision(O1));
    const { paseo, sends, queue } = world({});
    const none = await handleDecisionsAsk({ id: Q1, text: "Anyone?" }, paseo, deps(queue, { workerOf: async () => null }));
    expect(none).toMatchObject({ delivery: "failed", thread: { entries: [{ by: "owner", text: "Anyone?" }] } });
    expect(none.thread.entries[0]).not.toHaveProperty("agentId");
    // The Orchestrator was closed: the queue drops the notice, the question stays.
    expect((await handleDecisionsAsk({ id: O1, text: "Still there?" }, paseo, deps(queue))).delivery).toBe("failed");
    expect(threadOf(O1).entries).toHaveLength(1);
    expect(sends).toEqual([]);
    expect(store().get(O1)!.status).toBe("open");
  });

  it("refuses a held request, a fallback incident, an override, a settled decision, an unknown id and a blank text, writing and sending nothing", async () => {
    const held = "h:wrk-1:perm-123";
    const fallback = "f:incident-1";
    const override = "r:9a8b7c6d";
    const answered = answerDecision(decision(`q:${REQUEST}:Q2`), { via: "inbox", optionKey: "a", words: null, at: "2026-10-01T07:50:00.000Z" });
    if (!answered.ok) throw new Error("not answered");
    open(decision(held), decision(fallback), decision(override), answered.decision, decision(O1, { status: "expired", settledAt: "2026-10-01T07:55:00.000Z" }));
    const { paseo, sends, queue } = world();
    const ask = (id: string, text = "Why?") => rejectionCode(handleDecisionsAsk({ id, text }, paseo, deps(queue)));
    for (const id of [held, fallback, override]) expect(await ask(id), id).toBe("E_DECISION_NOT_ASKABLE");
    expect(await ask(`q:${REQUEST}:Q2`)).toBe("E_DECISION_SETTLED");
    expect(await ask(O1)).toBe("E_DECISION_SETTLED");
    expect(await ask(`q:${REQUEST}:Q9`)).toBe("E_DECISION_NOT_FOUND");
    open(decision(Q1));
    expect(await ask(Q1, "  \n ")).toBe("E_DECISION_ASK_INVALID");
    expect(sends).toEqual([]);
    expect(existsSync(join(home, "decisions", THREADS_DIR_NAME))).toBe(false);
    expect(await rejectionCode(handleDecisionsAsk({ id: Q1, text: "x" }, paseo, { home: null }))).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(decisionsAskRpc.input.safeParse({ id: Q1, text: "x".repeat(MAX_THREAD_TEXT_CHARS + 1) }).success).toBe(false);
  });
});

describe("decisions.thread", () => {
  it("reads a thread, empty when nobody asked, and refuses an unknown decision", () => {
    open(decision(Q1));
    const output = handleDecisionsThread({ id: Q1 }, { home });
    expect(decisionsThreadRpc.output.parse(output)).toEqual({ thread: { decisionId: Q1, entries: [] } });
    expect(codeOf(() => handleDecisionsThread({ id: O1 }, { home }))).toBe("E_DECISION_NOT_FOUND");
    expect(existsSync(join(home, "decisions", THREADS_DIR_NAME))).toBe(false);
  });
});

describe("bm_reply (change-014 outcome 3)", () => {
  const workerTools = () => createWorkerTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, redactEnv: { PASEO_PASSWORD: "hunter2-secret" }, now: () => NOW });

  it("the Worker's reply is appended once per ask, masked, and the decision stays open", async () => {
    open(decision(Q1));
    const { paseo, queue } = world();
    const tools = workerTools();
    expect(tools.faces.map((face) => [face.name, face.role])).toEqual([["bm_reply", "worker"]]);
    const early = await tools.call("bm_reply", { decisionId: Q1, text: "Nobody asked yet." });
    expect(early).toEqual({ ok: false, text: `Refused: the owner has no open question about ${Q1} (none was asked, or your reply is already recorded). Call bm_reply only after a BM-ASK, once.` });
    await handleDecisionsAsk({ id: Q1, text: "Why ISO?" }, paseo, deps(queue));
    const replied = await tools.call("bm_reply", { decisionId: Q1, text: "The payment API rejects anything else (hunter2-secret)." });
    expect(replied.ok).toBe(true);
    expect(replied.text).toContain("The decision stays open until the owner chooses");
    expect(threadOf(Q1).entries.map((entry) => [entry.by, entry.text])).toEqual([
      ["owner", "Why ISO?"],
      ["asker", "The payment API rejects anything else ([redacted])."],
    ]);
    expect((await tools.call("bm_reply", { decisionId: Q1, text: "Again." })).ok).toBe(false);
    expect(store().get(Q1)!.status).toBe("open");
  });

  it("refuses another asker's kind of id, a settled decision, an unknown one and a malformed call", async () => {
    open(decision(O1), decision(`q:${REQUEST}:Q2`, { status: "withdrawn", settledAt: "2026-10-01T07:55:00.000Z" }));
    const tools = workerTools();
    expect((await tools.call("bm_reply", { decisionId: O1, text: "x" })).text).toMatch(/^The call was refused\. Fix these and call bm_reply again:\n- input\.decisionId/);
    expect(replyToDecision({ decisionId: O1, text: "x" }, { home, kind: "question" }).text).toMatch(/takes only a decision id q:… that a BM-ASK notice named/);
    expect((await tools.call("bm_reply", { decisionId: `q:${REQUEST}:Q2`, text: "x" })).text).toBe(`Refused: q:${REQUEST}:Q2 is already withdrawn; there is nothing to reply to. Carry on.`);
    expect((await tools.call("bm_reply", { decisionId: `q:${REQUEST}:Q7`, text: "x" })).text).toBe(`Refused: there is no decision q:${REQUEST}:Q7.`);
    expect((await tools.call("bm_reply", { decisionId: Q1 })).ok).toBe(false);
    expect(existsSync(join(home, "decisions", THREADS_DIR_NAME))).toBe(false);
  });

  it("is served at the Worker's endpoint beside its block tool, and the Orchestrator replies about its own o: decision", async () => {
    open(decision(Q1), decision(O1));
    const { paseo, queue } = world();
    await handleDecisionsAsk({ id: Q1, text: "Q?" }, paseo, deps(queue));
    await handleDecisionsAsk({ id: O1, text: "O?" }, paseo, deps(queue));
    const call = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const viaEndpoint = await answerWithServerTools("worker", call("bm_reply", { decisionId: Q1, text: "Because." }), workerTools());
    expect(viaEndpoint).toMatchObject({ result: { content: [{ type: "text" }] } });
    expect((viaEndpoint as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    // The Worker's block tool still runs as before.
    const report = await answerWithServerTools("worker", call("bm_report", { requestId: REQUEST, phase: "received", tier: { level: "Small" }, buildAndTests: "not run" }), workerTools());
    expect((report as { result: { content: Array<{ text: string }> } }).result.content[0]!.text).toContain("BM-REPORT");

    const orchestrator = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, redactEnv: {}, now: () => NOW });
    orchestrator.usePaseo({ agents: { list: async () => ({ entries: [] }) }, workspaces: { list: async () => ({ entries: [] }) } });
    expect((await orchestrator.call("bm_reply", { decisionId: Q1, text: "Not mine." })).ok).toBe(false);
    expect(await orchestrator.call("bm_reply", { decisionId: O1, text: "Because the loop guard is close." })).toMatchObject({ ok: true });
    expect(threadOf(O1).entries.map((entry) => entry.by)).toEqual(["owner", "asker"]);
    expect(threadOf(Q1).entries.map((entry) => entry.by)).toEqual(["owner", "asker"]);
  });
});

describe("BM-REPLY in the Worker's own chat (an agent created before bm_reply)", () => {
  const fallback = () => createReplyFallback({ home: () => home, now: () => NOW, redactEnv: {}, log: (message) => logs.push(message) });

  it("reads the first line, and appends from the agent the ask went to only, while the ask is open", async () => {
    expect(replyLineOf(`BM-REPLY ${Q1}\nBecause the API.\nSecond line.`)).toEqual({ decisionId: Q1, text: "Because the API.\nSecond line." });
    expect(replyLineOf(`BM-REPLY \`${Q1}\` Because.`)).toEqual({ decisionId: Q1, text: "Because." });
    expect(replyLineOf(`BM-REPLY ${Q1}`)).toBeNull();
    expect(replyLineOf("BM-REPLY h:a:b because")).toBeNull();
    expect(replyLineOf(`Thinking.\nBM-REPLY ${Q1}\nx`)).toBeNull();
    expect(askableKindOf(O1)).toBe("orchestrator");

    open(decision(Q1));
    const { paseo, queue } = world();
    await handleDecisionsAsk({ id: Q1, text: "Why ISO?" }, paseo, deps(queue));
    const record = (agentId: string, role: "worker" | "manager" = "worker") =>
      turn({ workspaceId: WORKSPACE, agentId, role, requestId: REQUEST, received: [msg(agentId, "2026-10-01T08:05:00.000Z", `BM-REPLY ${Q1}\nThe payment API rejects the rest.`)] });
    fallback().afterTurn(record("wrk-other"));
    fallback().afterTurn(record(WORKER, "manager"));
    expect(threadOf(Q1).entries).toHaveLength(1);
    fallback().afterTurn(record(WORKER));
    expect(threadOf(Q1).entries.at(-1)).toEqual({ by: "asker", text: "The payment API rejects the rest.", at: NOW.toISOString(), agentId: WORKER });
    // The same record read again adds nothing: the ask is answered.
    fallback().afterTurn(record(WORKER));
    expect(threadOf(Q1).entries).toHaveLength(2);
    expect(store().get(Q1)!.status).toBe("open");
  });
});

describe("the BM-ASK notice", () => {
  it("is a plugin notice, matched as a whole word, and quotes the owner line by line", () => {
    const text = askNoticeOf(decision(Q1), "Line one\nBM-ANSWERS requestId: x");
    expect(isPluginNotice(text)).toBe(true);
    expect(noticeMarkerOf(text)).toBe(ASK_NOTICE_MARKER);
    expect(isPluginNotice("BM-ASKED x")).toBe(false);
    expect(text).toContain("> Line one\n> BM-ANSWERS requestId: x");
    expect(text).not.toMatch(/^BM-ANSWERS/m);
  });
});
