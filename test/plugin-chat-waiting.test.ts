import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleChatWaiting, pendingFallbackOf, waitingOf, type WaitingCandidate, type WaitingEntry } from "../plugin/server/chat-waiting";
import type { DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { ROLE_FALLBACK_STATE_FILE } from "../plugin/server/fallback-state";
import { recordEntries } from "../plugin/server/qa-ledger";
import { chatWaitingRpc, type FallbackIncident } from "../plugin/shared/contracts";

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
      { managerId: "m1", workspaceId: "wks_a", workerId: "w1", workerTitle: "Card replies", requestId: REQ, text: ASKING, at: "2026-09-18T05:00:00.000Z", answered: [] },
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
    expect(result.fallback).toEqual([]);
    // One for the trace store, one for the fallback incidents file (delta
    // 20260921 §4.4.6): a second trace-store read would make it three.
    expect(configGet).toHaveBeenCalledTimes(2);
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

describe("pending fallback incidents in chat.waiting (delta 20260921 §4.4.6)", () => {
  const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
    id: "fb-3f9a2c1d7e4b",
    role: "worker",
    workspaceId: "wks_a",
    requestId: REQ,
    agentId: "w1",
    agentProvider: "bm-worker/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: "m1",
    managerId: "m1",
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: "2026-09-21T15:40:00Z",
    candidate: { position: 1, alias: "bm-worker-fallback-1", baseProvider: "codex", model: "gpt-5.6-sol", thinkingOptionId: "high", modeId: null },
    status: "pending",
    detectedAt: "2026-09-21T14:00:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
    ...overrides,
  });
  const managers = [
    { id: "m1", workspaceId: "wks_a" },
    { id: "m2", workspaceId: "wks_b" },
  ];

  it("counts only pending incidents, each for the live Manager it names, in that Manager's workspace", () => {
    const mine = incident();
    const other = incident({ id: "fb-000000000002", managerId: "m2", workspaceId: "wks_other" });
    const incidents = [
      mine,
      other,
      incident({ id: "fb-000000000003", status: "dismissed" }),
      incident({ id: "fb-000000000004", status: "switched" }),
      incident({ id: "fb-000000000005", status: "waiting" }),
      incident({ id: "fb-000000000006", managerId: null }),
      incident({ id: "fb-000000000007", managerId: "m9" }),
    ];
    expect(pendingFallbackOf(managers, incidents)).toEqual([
      { managerId: "m1", workspaceId: "wks_a", incident: mine },
      { managerId: "m2", workspaceId: "wks_b", incident: other },
    ]);
    expect(pendingFallbackOf([], incidents)).toEqual([]);
  });

  const entry = (id: string, role: string, workspaceId: string, extra: Record<string, unknown> = {}) => ({
    agent: { id, workspaceId, status: "idle", title: `${role} ${id}`, labels: { "bm.role": role, ...(role === "worker" ? { "bm.requestId": REQ } : {}) }, ...extra },
  });

  function paseo(list: Array<ReturnType<typeof entry>>): DashboardPaseo {
    return {
      agents: {
        list: vi.fn(async ({ filter }: { filter: { labels?: Record<string, string> } }) => ({
          entries: list.filter((e) => filter.labels === undefined || e.agent.labels["bm.role"] === filter.labels["bm.role"]),
        })),
        // The Manager's own turn failed: its timeline cannot be read. The incidents still count.
        ref: () => ({ timeline: { refetch: vi.fn(async () => Promise.reject(new Error("turn failed"))) } }),
      },
      workspaces: { list: vi.fn(async () => ({ entries: [] })) },
      config: { get: vi.fn(async () => ({ config: {} })) },
    };
  }

  function withIncidents<T>(incidents: FallbackIncident[], run: (home: string) => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), "bm-chat-waiting-"));
    writeFileSync(join(home, ROLE_FALLBACK_STATE_FILE), JSON.stringify({ version: 1, incidents }), { mode: 0o600 });
    return run(home).finally(() => rmSync(home, { recursive: true, force: true }));
  }

  it("reads the incidents file, not the timeline, and leaves out a Manager that is archived", async () => {
    const agents = [entry("m1", "manager", "wks_a"), entry("m3", "manager", "wks_c", { archivedAt: "2026-09-21T00:00:00.000Z" }), entry("w1", "worker", "wks_a")];
    const pending = incident();
    const result = await withIncidents([pending, incident({ id: "fb-000000000008", managerId: "m3" }), incident({ id: "fb-000000000009", status: "failed" })], (home) =>
      handleChatWaiting(paseo(agents), { homedir: () => "/nonexistent-bm-home", home }),
    );
    expect(result).toEqual({ waiting: [], fallback: [{ managerId: "m1", workspaceId: "wks_a", incident: pending }] });
  });

  it("is empty with no live Manager, no install home, or an unreadable file", async () => {
    const log = vi.fn();
    expect(await withIncidents([incident()], (home) => handleChatWaiting(paseo([entry("w1", "worker", "wks_a")]), { home }))).toEqual({ waiting: [], fallback: [] });
    expect((await handleChatWaiting(paseo([entry("m1", "manager", "wks_a")]), { homedir: () => "/nonexistent-bm-home" })).fallback).toEqual([]);
    expect((await handleChatWaiting(paseo([entry("m1", "manager", "wks_a")]), { home: null })).fallback).toEqual([]);
    const broken = mkdtempSync(join(tmpdir(), "bm-chat-waiting-"));
    try {
      writeFileSync(join(broken, ROLE_FALLBACK_STATE_FILE), "{ not json", { mode: 0o600 });
      expect((await handleChatWaiting(paseo([entry("m1", "manager", "wks_a")]), { home: broken, log })).fallback).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] /);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("keeps the contract additive: an answer without `fallback` still reads, as empty", () => {
    expect(chatWaitingRpc.output.parse({ waiting: [] })).toEqual({ waiting: [], fallback: [] });
  });
});

/**
 * The question–answer ledger decides "answered" (design delta 20260924-qa-ledger
 * §4.1, A1). The case: a `blocked` report with four questions, three answered
 * in the card, then the Worker ends its turn to wait for its Reviewer — idle,
 * no new report. Before the ledger this listed all four questions as open, and
 * on 2026-09-22 the user answered Q16, Q17 and Q19 a second time 32 minutes
 * later.
 */
describe("waitingOf with the question–answer ledger", () => {
  const FOUR = [
    "BM-QUESTIONS",
    `requestId: ${REQ}`,
    "Q16: Phase order — which first?",
    "- a: foundations. (recommended)",
    "- b: customers.",
    "Q17: Routes — where?",
    "- a: old menu. (recommended)",
    "- b: new prefix.",
    "Q18: Uploads — keep?",
    "- a: keep. (recommended)",
    "- b: drop.",
    "Q19: Status after review?",
    "- a: Accepted. (recommended)",
    "- b: Draft.",
  ].join("\n");
  const ASKING_FOUR = report(REQ, "blocked", FOUR).replace("1 question: Q1", "4 questions: Q16, Q17, Q18, Q19");
  const answered = (ids: string[]) => (requestId: string) => new Set(requestId === REQ ? ids : []);

  it("A1: an idle Worker with three of four answered still waits, for one question", () => {
    const [entry] = waitingOf(manager, [agentMessage(ASKING_FOUR)], [worker()], answered(["Q16", "Q17", "Q19"]));
    expect(entry?.answered).toEqual(["Q16", "Q17", "Q19"]);
  });

  it("A1: an idle Worker whose every question is answered is not waiting — it is waiting for its Reviewer", () => {
    expect(waitingOf(manager, [agentMessage(ASKING_FOUR)], [worker()], answered(["Q16", "Q17", "Q18", "Q19"]))).toEqual([]);
    // Answers to another request never close this one.
    expect(waitingOf(manager, [agentMessage(ASKING_FOUR)], [worker()], () => new Set(["Q16", "Q17", "Q18", "Q19"].map((id) => `${id}x`)))).toHaveLength(1);
  });

  it("reads the ledger from the install home once per call, and falls back to the old rule without one", async () => {
    const home = mkdtempSync(join(tmpdir(), "bm-chat-waiting-ledger-"));
    try {
      const location = { tracesDir: join(home, "traces") };
      recordEntries(location, {
        workspaceId: "wks_a",
        workerId: "w1",
        questions: [],
        answers: ["Q16", "Q17", "Q18", "Q19"].map((id) => ({ requestId: REQ, id, text: "a", via: "user" as const })),
      });
      const agents = [
        { agent: { id: "m1", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", archivedAt: null, workspaceId: "wks_a", cwd: "/r", title: null }, project: { workspace: { id: "wks_a" } } },
        { agent: { id: "w1", provider: "bm-worker", labels: { "bm.role": "worker", "bm.requestId": REQ }, status: "idle", archivedAt: null, workspaceId: "wks_a", cwd: "/r", title: "Card replies" }, project: { workspace: { id: "wks_a" } } },
      ];
      const sdk: DashboardPaseo = {
        agents: {
          list: vi.fn(async () => ({ entries: agents })),
          ref: () => ({ timeline: { refetch: vi.fn(async () => ({ entries: [agentMessage(ASKING_FOUR)], hasOlder: false })) } }),
        },
        workspaces: { list: vi.fn(async () => ({ entries: [] })) },
        config: { get: vi.fn(async () => ({ config: {} })) },
      } as unknown as DashboardPaseo;
      expect((await handleChatWaiting(sdk, { home })).waiting).toEqual([]);
      // Without a readable home the ledger answers nothing: the pre-ledger rule.
      expect((await handleChatWaiting(sdk, { home: null })).waiting).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
