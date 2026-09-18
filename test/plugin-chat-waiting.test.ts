import { describe, expect, it, vi } from "vitest";
import { handleChatWaiting, waitingOf, type WaitingCandidate, type WaitingEntry } from "../plugin/server/chat-waiting";
import type { DashboardPaseo } from "../plugin/server/dashboard-rpc";

/**
 * `chat.waiting` (delta 20260918d-card-replies §4.8, REQ-059 j): the Workers
 * that wait for the user's answer, per Manager, read from the Manager's live
 * timeline.
 */

const REQ = "req-20260918T041426Z";
const OTHER = "req-20260918T043115Z";

function report(requestId: string, phase: string, questions = ""): string {
  return [
    "BM-REPORT",
    `requestId: ${requestId}`,
    `phase: ${phase}`,
    "tier: Large (changed: no)",
    "filesChanged: none",
    "beadsCreated: none",
    "beadsUpdated: none",
    "beadsClosed: none",
    "beadsReady: none",
    "reviewFindingsOpen: none",
    "buildAndTests: not run",
    "skillsUsed: none",
    `blockers: ${questions === "" ? "none" : "1 question: Q1 — see BM-QUESTIONS"}`,
  ].join("\n") + (questions === "" ? "" : `\n\n${questions}`);
}

const QUESTIONS = ["BM-QUESTIONS", `requestId: ${REQ}`, "Q1: Storage — where?", "- a: the table. (recommended)", "- b: a file."].join("\n");
const ASKING = report(REQ, "blocked", QUESTIONS);

/** Timeline entries, newest first, as `waitingOf` wants them. */
const agentMessage = (text: string, timestamp = "2026-09-18T05:00:00.000Z"): WaitingEntry => ({ item: { type: "user_message", text }, timestamp });

const manager = { id: "m1", workspaceId: "wks_a" };
const worker = (overrides: Partial<WaitingCandidate> = {}): WaitingCandidate => ({
  id: "w1",
  workspaceId: "wks_a",
  role: "worker",
  title: "Card replies",
  status: "idle",
  requestId: REQ,
  archived: false,
  ...overrides,
});

describe("waitingOf", () => {
  it("lists an idle Worker whose newest report asks questions", () => {
    expect(waitingOf(manager, [agentMessage(ASKING)], [worker()])).toEqual([
      { managerId: "m1", workspaceId: "wks_a", workerId: "w1", workerTitle: "Card replies", requestId: REQ, text: ASKING, at: "2026-09-18T05:00:00.000Z" },
    ]);
    expect(waitingOf(manager, [agentMessage(ASKING)], [worker({ status: "error" })])).toHaveLength(1);
  });

  it("leaves out a Worker that is working, starting or gone", () => {
    for (const status of ["running", "initializing", "closed"]) {
      expect(waitingOf(manager, [agentMessage(ASKING)], [worker({ status })]), status).toEqual([]);
    }
  });

  it("lets a newer report of the same request hide the question", () => {
    const newer = agentMessage(report(REQ, "received"), "2026-09-18T05:10:00.000Z");
    expect(waitingOf(manager, [newer, agentMessage(ASKING)], [worker()])).toEqual([]);
    const finished = agentMessage(report(REQ, "finished"), "2026-09-18T05:10:00.000Z");
    expect(waitingOf(manager, [finished, agentMessage(ASKING)], [worker()])).toEqual([]);
    // An older report of the same request does not.
    expect(waitingOf(manager, [agentMessage(ASKING), agentMessage(report(REQ, "received"))], [worker()])).toHaveLength(1);
  });

  it("needs a question block for the report's own request", () => {
    expect(waitingOf(manager, [agentMessage(report(REQ, "blocked"))], [worker()])).toEqual([]);
    const foreign = report(REQ, "blocked", QUESTIONS.replace(`requestId: ${REQ}`, `requestId: ${OTHER}`));
    expect(waitingOf(manager, [agentMessage(foreign)], [worker()])).toEqual([]);
  });

  it("ignores what the user typed, and needs exactly one Worker of the request in the Manager's workspace", () => {
    const typed: WaitingEntry = { item: { type: "user_message", text: ASKING, clientMessageId: "c1" }, timestamp: null };
    expect(waitingOf(manager, [typed], [worker()])).toEqual([]);
    expect(waitingOf(manager, [agentMessage(ASKING)], [worker(), worker({ id: "w2" })])).toEqual([]);
    expect(waitingOf(manager, [agentMessage(ASKING)], [worker({ workspaceId: "wks_b" })])).toEqual([]);
    expect(waitingOf(manager, [agentMessage(ASKING)], [])).toEqual([]);
  });
});

describe("chat.waiting", () => {
  const entry = (id: string, role: string, workspaceId: string, labels: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
    agent: { id, workspaceId, status: "idle", title: `${role} ${id}`, labels: { "bm.role": role, ...labels }, ...extra },
  });
  const agents = [
    entry("m1", "manager", "wks_a"),
    entry("m2", "manager", "wks_b"),
    entry("m3", "manager", "wks_c", {}, { archivedAt: "2026-09-18T00:00:00.000Z" }),
    entry("w1", "worker", "wks_a", { "bm.requestId": REQ }),
    entry("w2", "worker", "wks_b", { "bm.requestId": OTHER }),
  ];
  const asking2 = report(OTHER, "blocked", QUESTIONS.replace(`requestId: ${REQ}`, `requestId: ${OTHER}`));

  function paseo(timelines: Record<string, unknown[] | Error>): DashboardPaseo {
    return {
      agents: {
        // The daemon applies a labels filter only when one is given (delta 20260918g lists with none).
        list: vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
          entries: agents.filter((e) => filter.labels === undefined || e.agent.labels["bm.role"] === filter.labels["bm.role"]),
        })),
        ref: (agentId: string) => ({
          timeline: {
            refetch: vi.fn(async () => {
              const value = timelines[agentId];
              if (value instanceof Error) throw value;
              // Pages come oldest first.
              return { entries: [...(value ?? [])].reverse(), hasOlder: false };
            }),
          },
        }),
      },
      workspaces: { list: vi.fn(async () => ({ entries: [] })) },
      config: { get: vi.fn(async () => ({ config: {} })) },
    };
  }

  it("lists the waiting Workers of every live Manager", async () => {
    const result = await handleChatWaiting(
      paseo({ m1: [agentMessage(ASKING)], m2: [agentMessage(asking2)], m3: [agentMessage(ASKING)] }),
      { homedir: () => "/nonexistent-bm-home" },
    );
    expect(result.waiting.map((w) => [w.managerId, w.workerId, w.requestId])).toEqual([
      ["m1", "w1", REQ],
      ["m2", "w2", OTHER],
    ]);
  });

  it("reads a trace store only for a workspace that has a live Manager, at most once (delta 20260918f F11)", async () => {
    // Opening the trace store resolves the install home through
    // `config.get`, so its calls count the trace-store reads.
    const configGet = vi.fn(async () => ({ config: {} }));
    const list = [
      entry("m1", "manager", "wks_a"),
      entry("w1", "worker", "wks_a"),
      entry("w2", "worker", "wks_a"),
      // No Manager here: nobody can show a pill for these, so nothing is read.
      entry("w8", "worker", "wks_x"),
      entry("w9", "worker", "wks_y"),
    ];
    const sdk = paseo({ m1: [] });
    const result = await handleChatWaiting(
      {
        ...sdk,
        agents: {
          ...sdk.agents,
          list: vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
            entries: list.filter((e) => filter.labels === undefined || e.agent.labels["bm.role"] === filter.labels["bm.role"]),
          })),
        },
        config: { get: configGet },
      } as DashboardPaseo,
      { homedir: () => "/nonexistent-bm-home" },
    );
    expect(result.waiting).toEqual([]);
    expect(configGet).toHaveBeenCalledTimes(1);
  });

  it("gives one pill, for the live Worker, when an archived Worker has the same request (delta 20260918f F12)", async () => {
    const sdk = paseo({ m1: [agentMessage(ASKING)] });
    const list = [
      entry("m1", "manager", "wks_a"),
      entry("w0", "worker", "wks_a", { "bm.requestId": REQ }, { archivedAt: "2026-09-18T00:00:00.000Z" }),
      entry("w1", "worker", "wks_a", { "bm.requestId": REQ }),
    ];
    const result = await handleChatWaiting(
      {
        ...sdk,
        agents: {
          ...sdk.agents,
          list: vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
            entries: list.filter((e) => filter.labels === undefined || e.agent.labels["bm.role"] === filter.labels["bm.role"]),
          })),
        },
      } as DashboardPaseo,
      { homedir: () => "/nonexistent-bm-home" },
    );
    expect(result.waiting.map((w) => w.workerId)).toEqual(["w1"]);
  });

  it("keeps the other Managers when one timeline cannot be read", async () => {
    const result = await handleChatWaiting(paseo({ m1: new Error("gone"), m2: [agentMessage(asking2)] }), { homedir: () => "/nonexistent-bm-home" });
    expect(result.waiting.map((w) => w.workerId)).toEqual(["w2"]);
  });
});
