import { describe, expect, it, vi } from "vitest";
import {
  MAX_NOTICES,
  checkTurnFormat,
  createFormatState,
  formatNotice,
  registerFormatCheck,
  type FormatPaseo,
  type FormatTurnEvent,
} from "../plugin/server/format-check";
import { isPluginNotice } from "../plugin/server/notices";
import { reviewCallsOf } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";

/**
 * BM-FORMAT notices (delta 20260918g §4.7, REQ-061 f). A fake Paseo: a
 * directory for `bmAgentsOf`, scripted snapshots for `refresh()`, and a record
 * of every `send()`. No daemon, no trace store.
 */

const REQ = "req-20260918T070348Z";
const WS = "wks_ef81bbe0663d91ca";

type Agent = { id: string; provider: string; labels: Record<string, string>; status: string; lastUserMessageAt: string | null; archivedAt?: string | null };

function world(agents: Agent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, { ...agent }]));
  const sends: Array<{ id: string; text: string }> = [];
  const paseo: FormatPaseo = {
    agents: {
      list: vi.fn(async () => ({ entries: [...byId.values()].map((agent) => ({ agent: { ...agent, workspaceId: WS } })) })),
      ref: (id: string) => ({
        refresh: async () => {
          const agent = byId.get(id);
          return agent === undefined ? null : { agent: { ...agent } };
        },
        send: async (text: string) => {
          sends.push({ id, text });
        },
      }),
    },
    workspaces: { list: vi.fn(async () => ({ entries: [] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  };
  const set = (id: string, change: Partial<Agent>) => Object.assign(byId.get(id)!, change);
  const state = createFormatState();
  const logs: string[] = [];
  const deps = { paseo, state, log: (message: string) => logs.push(message), sleep: async () => {}, homedir: () => "/nonexistent-bm-home" };
  return { paseo, sends, set, state, logs, deps };
}

const manager = (over: Partial<Agent> = {}): Agent => ({
  id: "mgr",
  provider: "bm-manager/claude-opus-5",
  labels: { "bm.role": "manager" },
  status: "idle",
  lastUserMessageAt: "2026-09-18T07:06:00.000Z",
  ...over,
});
const worker = (over: Partial<Agent> = {}): Agent => ({
  id: "wrk",
  provider: "bm-worker/claude-opus-5",
  labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": "mgr" },
  status: "idle",
  lastUserMessageAt: "2026-09-18T07:04:00.000Z",
  ...over,
});
const reviewer = (over: Partial<Agent> = {}): Agent => ({
  id: "rev",
  provider: "bm-reviewer/gpt-5.6-sol",
  labels: { "bm.role": "reviewer", "bm.requestId": REQ, "bm.batchId": "b1", "paseo.parent-agent-id": "wrk" },
  status: "idle",
  lastUserMessageAt: "2026-09-18T07:10:00.000Z",
  ...over,
});

function report(phase: string, recommended: boolean, extraQuestion = ""): string {
  return [
    "BM-REPORT",
    `requestId: ${REQ}`,
    `phase: ${phase}`,
    "tier: Large (changed: no)",
    "filesChanged: none",
    "beadsCreated: none",
    "beadsUpdated: none",
    "beadsClosed: none",
    "beadsReady: none",
    "reviewFindingsOpen: none",
    "buildAndTests: not run",
    "skillsUsed: feature-workflow",
    phase === "blocked" ? "blockers: 1 question: Q1 — see BM-QUESTIONS" : "blockers: none",
    ...(phase === "blocked"
      ? ["", "BM-QUESTIONS", `requestId: ${REQ}`, `Q1: Storage — where?${extraQuestion}`, `- a: the table.${recommended ? " (recommended)" : ""}`, "- b: a file."]
      : []),
  ].join("\n");
}

const received = (text: string) => ({ type: "user_message", text });
const typed = (text: string) => ({ type: "user_message", text, clientMessageId: "c1" });
const said = (text: string) => ({ type: "assistant_message", text });

function turn(agent: Agent, items: unknown[]): FormatTurnEvent {
  const parent = agent.labels["paseo.parent-agent-id"] ?? null;
  return { agent: { id: agent.id, workspaceId: WS, parentAgentId: parent, provider: agent.provider }, turnId: "t", timeline: items };
}

describe("formatNotice", () => {
  it("is the design's text, with one line per issue", () => {
    expect(formatNotice("BM-REPORT", REQ, ["BM-QUESTIONS Q1: needs exactly one option ending in (recommended) (found 0)"])).toBe(
      [
        `BM-FORMAT requestId: ${REQ}`,
        "Your last BM-REPORT broke the template:",
        "- BM-QUESTIONS Q1: needs exactly one option ending in (recommended) (found 0)",
        "Send the whole corrected block again, to the same agent as before, in one message. Change nothing else and do not redo any work; then carry on exactly where you were.",
      ].join("\n"),
    );
    expect(formatNotice("BM-REVIEW", REQ, ["x"]).split("\n").at(-1)).toBe(
      "Answer with the whole corrected BM-REVIEW block as your final message; do not review again.",
    );
  });

  it("is a plugin notice: never the user's words, never a review call", () => {
    const notice = formatNotice("BM-REVIEW", REQ, ["BM-REVIEW verdict: must be pass or changes-required"]);
    expect(isPluginNotice(notice)).toBe(true);
    const record = { agentId: "rev", sent: [{ agentId: null, at: "", text: notice, truncated: false }] } as unknown as TraceRecord;
    expect(reviewCallsOf(["rev"], [record])).toBe(0);
  });
});

describe("a Worker's report that breaks the template (F3)", () => {
  it("tells the idle Worker once at the Manager's turn end; the corrected resend clears it", async () => {
    const { sends, set, deps } = world([manager(), worker()]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.id).toBe("wrk");
    expect(sends[0]!.text).toContain("- BM-QUESTIONS Q1: needs exactly one option ending in (recommended) (found 0)");

    set("mgr", { lastUserMessageAt: "2026-09-18T07:08:00.000Z" });
    await checkTurnFormat(turn(manager(), [received(report("blocked", true))]), deps);
    expect(sends).toHaveLength(1);
    expect(deps.state.pending.size).toBe(0);
  });

  it("never checks what the user typed, nor the plugin's own notices", async () => {
    const { sends, deps } = world([manager(), worker()]);
    await checkTurnFormat(turn(manager(), [typed(report("blocked", false))]), deps);
    await checkTurnFormat(turn(manager(), [received(`BM-BUDGET requestId: ${REQ}\n${report("blocked", false)}`)]), deps);
    expect(sends).toEqual([]);
  });

  it("stops after MAX_NOTICES for one sender, request and kind, and says so once", async () => {
    const { sends, deps, logs } = world([manager(), worker()]);
    for (const suffix of ["", " (again)", " (third time)"]) {
      await checkTurnFormat(turn(manager(), [received(report("blocked", false, suffix))]), deps);
    }
    expect(sends).toHaveLength(MAX_NOTICES);
    expect(logs).toContain(`[paseo-bm] BM-REPORT from wrk still breaks the template after ${MAX_NOTICES} notices; not asking again.`);
  });

  it("does not notify the same block twice", async () => {
    const { sends, deps } = world([manager(), worker()]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    expect(sends).toHaveLength(1);
  });

  it("sends nothing when no single Worker owns the request", async () => {
    const { sends, deps, logs } = world([manager(), worker(), worker({ id: "wrk-2" })]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    expect(sends).toEqual([]);
    expect(logs[0]).toMatch(/its sender is not known; no BM-FORMAT sent/);
  });
});

describe("never into a running turn, and always a later chance", () => {
  it("waits while the Worker runs, then sends at the Manager's next turn end", async () => {
    const { sends, set, deps } = world([manager(), worker({ status: "running" })]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    expect(sends).toEqual([]);

    // Paseo's own "Worker finished" message wakes the Manager: a new message, no new block.
    set("wrk", { status: "idle" });
    set("mgr", { lastUserMessageAt: "2026-09-18T07:09:00.000Z" });
    await checkTurnFormat(turn(manager(), [received("Agent wrk finished.")]), deps);
    expect(sends.map((send) => send.id)).toEqual(["wrk"]);
  });

  it("sends at the sender's own turn end when the Manager has received nothing since", async () => {
    const { sends, set, deps } = world([manager(), worker({ status: "running" })]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    set("wrk", { status: "idle" });
    await checkTurnFormat(turn(worker(), [said("done")]), deps);
    expect(sends.map((send) => send.id)).toEqual(["wrk"]);
  });

  it("re-reads a sender that still reads running at its own turn end", async () => {
    const { sends, set, deps, paseo } = world([manager(), worker({ status: "running" })]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    let reads = 0;
    const ref = paseo.agents.ref.bind(paseo.agents);
    paseo.agents.ref = (id: string) => {
      const handle = ref(id);
      if (id !== "wrk") return handle;
      return {
        ...handle,
        refresh: async () => {
          reads += 1;
          if (reads === 3) set("wrk", { status: "idle" });
          return handle.refresh();
        },
      };
    };
    await checkTurnFormat(turn(worker(), [said("done")]), deps);
    expect(sends.map((send) => send.id)).toEqual(["wrk"]);
  });

  it("a bad received followed by a good blocked: no notice about received", async () => {
    const { sends, set, deps } = world([manager(), worker({ status: "running" })]);
    await checkTurnFormat(turn(manager(), [received(report("received", false).replace("tier: Large (changed: no)", "tier: Large"))]), deps);
    expect(sends).toEqual([]);

    // The Worker sends a good blocked report and ends its turn before the Manager reads it.
    set("mgr", { lastUserMessageAt: "2026-09-18T07:20:00.000Z" });
    set("wrk", { status: "idle" });
    await checkTurnFormat(turn(worker(), [said("sent the report")]), deps);
    expect(sends).toEqual([]);

    await checkTurnFormat(turn(manager(), [received(report("blocked", true))]), deps);
    expect(sends).toEqual([]);
    expect(deps.state.pending.size).toBe(0);
  });

  it("never sends to an archived sender", async () => {
    const { sends, deps, logs } = world([manager(), worker({ archivedAt: "2026-09-18T07:30:00.000Z" })]);
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    expect(sends).toEqual([]);
    expect(logs.at(-1)).toMatch(/archived, closed or gone/);
  });
});

describe("reviews and answers", () => {
  const badReview = ["BM-REVIEW", `requestId: ${REQ}`, "batchId: b1", "reviewKind: first", "verdict: approved", "checked: the diff", "findings: none", "notChecked: none"].join("\n");

  it("tells the Reviewer about its own review at its turn end", async () => {
    const { sends, deps } = world([worker(), reviewer()]);
    await checkTurnFormat(turn(reviewer(), [received("please review"), said(`---\n\n${badReview}`)]), deps);
    expect(sends.map((send) => send.id)).toEqual(["rev"]);
    expect(sends[0]!.text).toContain("Answer with the whole corrected BM-REVIEW block as your final message");
  });

  it("a Reviewer still running at its own turn end is told at its parent Worker's next turn end", async () => {
    const { sends, set, deps } = world([worker(), reviewer({ status: "running" })]);
    await checkTurnFormat(turn(reviewer(), [received("please review"), said(badReview)]), deps);
    expect(sends).toEqual([]);
    set("rev", { status: "idle" });
    await checkTurnFormat(turn(worker(), [received("Agent rev finished."), said("reading the verdict")]), deps);
    expect(sends.map((send) => send.id)).toEqual(["rev"]);
  });

  it("does not check a Worker's own assistant messages, nor a review that arrives in its chat", async () => {
    const { sends, deps } = world([manager(), worker(), reviewer()]);
    await checkTurnFormat(turn(worker(), [received(`Agent rev finished.\n${badReview}`), said(report("blocked", false))]), deps);
    expect(sends).toEqual([]);
  });

  it("tells the Manager when a relayed BM-ANSWERS breaks the template", async () => {
    const { sends, deps } = world([manager(), worker()]);
    await checkTurnFormat(turn(worker(), [received(`Continue ${REQ}.\nBM-ANSWERS\nrequestId: ${REQ}\nQ1 a`)]), deps);
    expect(sends.map((send) => send.id)).toEqual(["mgr"]);
    expect(sends[0]!.text).toContain("Your last BM-ANSWERS broke the template:");
  });
});

describe("robustness", () => {
  it("ignores other providers and never throws on malformed events", async () => {
    const { sends, deps } = world([manager(), worker()]);
    expect(await checkTurnFormat({ agent: { id: "x", workspaceId: WS, parentAgentId: null, provider: "claude" }, timeline: [] }, deps)).toBe("ignored");
    for (const bad of [null, {}, { agent: null }, { agent: { id: "mgr", provider: "bm-manager" }, timeline: "nope" }]) {
      await expect(checkTurnFormat(bad as never, deps)).resolves.toBeDefined();
    }
    expect(sends).toEqual([]);
  });

  it("logs and keeps the notice when send fails, then sends later", async () => {
    const { sends, deps, paseo, logs } = world([manager(), worker()]);
    const ref = paseo.agents.ref.bind(paseo.agents);
    let fail = true;
    paseo.agents.ref = (id: string) => {
      const handle = ref(id);
      return {
        ...handle,
        send: async (text: string) => {
          if (fail) throw new Error("socket closed");
          return handle.send(text);
        },
      };
    };
    await checkTurnFormat(turn(manager(), [received(report("blocked", false))]), deps);
    expect(logs.at(-1)).toMatch(/could not send BM-FORMAT to wrk: socket closed/);
    fail = false;
    await checkTurnFormat(turn(manager(), [received("Agent wrk finished.")]), deps);
    expect(sends.map((send) => send.id)).toEqual(["wrk"]);
  });

  it("registers on agent.turn_ended and cleans up; a no-op without on()", () => {
    const remove = vi.fn();
    const host = { on: vi.fn(() => remove) };
    const cleanup = registerFormatCheck(host as never);
    expect(host.on).toHaveBeenCalledWith("agent.turn_ended", expect.any(Function));
    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(() => registerFormatCheck({})()).not.toThrow();
  });
});
