import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managerHandover, workerHandover } from "../plugin/server/fallback-handover";
import { appendRecord, clearTraceStoreCache, type TraceStoreLocation } from "../plugin/server/trace-store";
import { TRACE_STORE_SCHEMA_VERSION, type FallbackIncident, type ParsedReport, type TraceRecord } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.4.8 (REQ-065 d) and §4.5.2 (REQ-066 c): the handovers a
 * replacement Worker and a replacement Manager start from, built in code from
 * the trace store, the review count, the incidents and the replaced agent's
 * timeline. Real trace store in a temporary directory, fake agents.
 */

const WS = "wks_handover";
const REQ = "req-20260922T020000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";

const incident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident => ({
  id: "fb-00000000000a",
  role: "worker",
  workspaceId: WS,
  requestId: REQ,
  agentId: WORKER,
  agentProvider: "bm-worker/claude-opus-5",
  agentModel: "claude-opus-5",
  parentId: MANAGER,
  managerId: MANAGER,
  class: "L1",
  signal: "failed",
  message: "You've hit your usage limit.\nResets at 3pm.",
  perModelWindow: false,
  resetsAt: null,
  candidate: null,
  status: "pending",
  detectedAt: "2026-09-22T03:00:00.000Z",
  decidedAt: null,
  waitUntil: null,
  replacementId: null,
  error: null,
  ...overrides,
});

function turn(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-22T02:00:00.000Z",
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: null,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-22T02:00:00.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

const report = (at: string, overrides: Partial<ParsedReport> = {}): ParsedReport => ({
  agentId: MANAGER,
  at,
  requestId: REQ,
  phase: "received",
  tier: "Medium",
  filesChanged: [],
  beadsCreated: [],
  beadsUpdated: [],
  beadsClosed: [],
  beadsReady: [],
  reviewFindingsOpen: null,
  buildAndTests: null,
  blockers: null,
  guardrail: null,
  unparsedFields: [],
  incompleteFields: [],
  skillsUsed: [],
  ...overrides,
});

const msg = (agentId: string, at: string, text: string) => ({ agentId, at, text, truncated: false });

function fakePaseo(timeline: Array<{ type: string; text?: string }> = [], reviewers: string[] = ["agent-rev-1"]) {
  const labels = (role: string, parent?: string) => ({ "bm.role": role, "bm.requestId": REQ, ...(parent === undefined ? {} : { "paseo.parent-agent-id": parent }) });
  const agents = [
    { id: MANAGER, workspaceId: WS, status: "idle", labels: { "bm.role": "manager" } },
    { id: WORKER, workspaceId: WS, status: "idle", labels: labels("worker", MANAGER) },
    ...reviewers.map((id) => ({ id, workspaceId: WS, status: "idle", labels: labels("reviewer", WORKER) })),
  ];
  // Two pages of the Worker's timeline: the tail first, then the older one with the first message.
  const older = timeline.slice(0, 1);
  const tail = timeline.slice(1);
  const refetch = vi.fn(async (options: { direction?: string }) =>
    options.direction === "tail"
      ? { entries: tail.map((item) => ({ item })), hasOlder: older.length > 0, startCursor: "c1" }
      : { entries: older.map((item) => ({ item })), hasOlder: false, startCursor: null },
  );
  return {
    refetch,
    paseo: {
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
        ref: () => ({ timeline: { refetch } }),
      },
      workspaces: { list: async () => ({ entries: [] }) },
      config: {},
    },
  };
}

let home: string;
let location: TraceStoreLocation;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-handover-"));
  location = { tracesDir: join(home, "traces") };
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("workerHandover", () => {
  it("fills every field from the latest report, the review count and the first message the Worker received", async () => {
    await appendRecord(location, turn({ requestId: REQ, reports: [report("2026-09-22T02:01:00.000Z")] }));
    await appendRecord(
      location,
      turn({
        at: "2026-09-22T02:30:00.000Z",
        requestId: REQ,
        reports: [
          report("2026-09-22T02:30:00.000Z", {
            phase: "beads-done",
            filesChanged: ["docs/plan.md", "src/login.ts"],
            beadsCreated: ["bm-a.1", "bm-a.2"],
            beadsClosed: [],
            beadsReady: ["bm-a.1"],
            reviewFindingsOpen: "b1: none",
            skillsUsed: ["feature-workflow", "polishing-beads"],
          }),
        ],
      }),
    );
    await appendRecord(location, turn({ agentId: WORKER, role: "worker", requestId: REQ, parentAgentId: MANAGER, at: "2026-09-22T02:02:00.000Z" }));
    for (const minute of [10, 20]) {
      const at = `2026-09-22T02:${minute}:00.000Z`;
      await appendRecord(
        location,
        turn({ agentId: "agent-rev-1", role: "reviewer", turnId: `t-${minute}`, requestId: REQ, parentAgentId: WORKER, at, sent: [msg("agent-rev-1", at, `Review batch b1 of ${REQ}.`)] }),
      );
    }
    const { paseo } = fakePaseo([
      { type: "user_message", text: "Build a login screen for Team Portal. --token abc123" },
      { type: "assistant_message", text: "On it." },
      { type: "user_message", text: "Continue." },
    ]);

    expect(await workerHandover(incident(), { paseo, location })).toBe(
      [
        "BM-HANDOVER",
        "role: worker",
        `requestId: ${REQ}`,
        `managerAgentId: ${MANAGER}`,
        `replaces: ${WORKER}`,
        'reason: L1 usage limit — "You\'ve hit your usage limit. Resets at 3pm."',
        "lastReport: beads-done at 2026-09-22T02:30:00.000Z",
        "tier: Medium",
        "filesChanged: docs/plan.md, src/login.ts",
        "beadsCreated: bm-a.1, bm-a.2",
        "beadsUpdated: none",
        "beadsClosed: none",
        "beadsReady: bm-a.1",
        "reviewFindingsOpen: b1: none",
        "reviewCalls: 2 of 4",
        "skillsUsed: feature-workflow, polishing-beads",
        "",
        "Original request (verbatim, the first message the replaced Worker received):",
        // Masked like every trace record (REQ-048b).
        "Build a login screen for Team Portal. --token [redacted]",
      ].join("\n"),
    );
  });

  it("reads unknown / none / unavailable for what it cannot find, and never throws", async () => {
    const { paseo } = fakePaseo([]);
    const text = await workerHandover(incident({ managerId: null }), { paseo, location: null });
    expect(text).toContain("\nmanagerAgentId: none\n");
    expect(text).toContain("\nlastReport: none\ntier: unknown\nfilesChanged: unknown\n");
    expect(text).toContain("\nreviewCalls: unknown\n");
    expect(text.endsWith("\nunavailable")).toBe(true);
  });

  it("keeps to its budget: a timeline that never answers costs only the request text", async () => {
    await appendRecord(location, turn({ requestId: REQ, reports: [report("2026-09-22T02:01:00.000Z", { tier: "Small" })] }));
    const hanging = fakePaseo();
    hanging.refetch.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const text = await workerHandover(incident(), { paseo: hanging.paseo, location, budgetMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(text).toContain("\nlastReport: received at 2026-09-22T02:01:00.000Z\ntier: Small\n");
    expect(text.endsWith("\nunavailable")).toBe(true);
  });

  it("does not count the message resent to a replacement Reviewer (delta 20260921 §4.5.1)", async () => {
    await appendRecord(location, turn({ requestId: REQ, reports: [report("2026-09-22T02:01:00.000Z")] }));
    await appendRecord(location, turn({ agentId: WORKER, role: "worker", requestId: REQ, parentAgentId: MANAGER, at: "2026-09-22T02:02:00.000Z" }));
    // agent-rev-1 stopped on its plan after one call; agent-rev-2 replaced it and got the same message.
    for (const [agentId, minute] of [["agent-rev-1", 10], ["agent-rev-2", 20]] as const) {
      const at = `2026-09-22T02:${minute}:00.000Z`;
      await appendRecord(
        location,
        turn({ agentId, role: "reviewer", turnId: `t-${minute}`, requestId: REQ, parentAgentId: WORKER, at, sent: [msg(agentId, at, `Review batch b1 of ${REQ}.`)] }),
      );
    }
    const { paseo } = fakePaseo([], ["agent-rev-1", "agent-rev-2"]);
    const switched = incident({ id: "fb-00000000000b", role: "reviewer", agentId: "agent-rev-1", parentId: WORKER, status: "switched", replacementId: "agent-rev-2" });

    expect(await workerHandover(incident(), { paseo, location, incidents: [switched] })).toContain("\nreviewCalls: 1 of 4\n");
    // Without them — none given and no install home the fake can name, or `null` — counted as before.
    expect(await workerHandover(incident(), { paseo, location })).toContain("\nreviewCalls: 2 of 4\n");
    expect(await workerHandover(incident(), { paseo, location, incidents: null })).toContain("\nreviewCalls: 2 of 4\n");
  });
});

describe("managerHandover", () => {
  const REQ_A = "req-20260922T010000Z";
  const REQ_B = "req-20260922T011500Z";
  const WORKER_A = "agent-worker-a";
  const WORKER_B = "agent-worker-b";
  /** A value the collector masks (SECRET_ENV_VARS), handed in as the environment. */
  const SECRET = "hunter2-fake-pass";
  const ENV = { PASEO_PASSWORD: SECRET };

  const managerIncident = (overrides: Partial<FallbackIncident> = {}): FallbackIncident =>
    incident({
      id: "fb-0000000000aa",
      role: "manager",
      requestId: null,
      agentId: MANAGER,
      agentProvider: "bm-manager/claude-opus-5",
      parentId: null,
      managerId: MANAGER,
      ...overrides,
    });

  type Entry = { item: Record<string, unknown> };
  const typed = (text: string, clientMessageId: string): Entry => ({ item: { type: "user_message", text, clientMessageId } });
  const relayed = (text: string): Entry => ({ item: { type: "user_message", text } });
  const said = (text: string): Entry => ({ item: { type: "assistant_message", text } });

  /** A Worker's `blocked` report with its question block, as it reaches the Manager (no `clientMessageId`). */
  const asking = (requestId: string, ids: string[]) =>
    [
      "BM-REPORT",
      `requestId: ${requestId}`,
      "phase: blocked",
      "tier: Medium",
      `blockers: ${ids.join(", ")} — see BM-QUESTIONS`,
      "",
      "BM-QUESTIONS",
      `requestId: ${requestId}`,
      ...ids.flatMap((id) => [`${id}: Storage — where?`, "- a: the table. (recommended)", "- b: a file."]),
    ].join("\n");

  const worker = (id: string, requestId: string, extra: Record<string, unknown> = {}, labels: Record<string, string> = {}) => ({
    id,
    workspaceId: WS,
    status: "idle",
    labels: { "bm.role": "worker", "bm.requestId": requestId, "paseo.parent-agent-id": MANAGER, ...labels },
    ...extra,
  });
  const AGENTS = [
    { id: MANAGER, workspaceId: WS, status: "error", labels: { "bm.role": "manager" } },
    worker(WORKER_A, REQ_A),
    worker(WORKER_B, REQ_B, { status: "running" }),
    // Replaced by its label; by a switched incident only; archived; closed; in another workspace.
    worker("agent-worker-labelled", REQ_B, {}, { "bm.replacedBy": WORKER_B }),
    worker("agent-worker-switched", REQ_A, { status: "error" }),
    worker("agent-worker-archived", REQ_A, { archivedAt: "2026-09-22T00:30:00.000Z" }),
    // (A closed Worker keeps its request in the pill's one-Worker rule, so it carries a request of its own.)
    worker("agent-worker-closed", "req-20260922T003000Z", { status: "closed" }),
    worker("agent-worker-elsewhere", REQ_A, { workspaceId: "wks_other" }),
    { id: "agent-rev-a", workspaceId: WS, status: "idle", labels: { "bm.role": "reviewer", "bm.requestId": REQ_A, "paseo.parent-agent-id": WORKER_A } },
  ];
  const SNAPSHOTS: Record<string, Record<string, unknown>> = {
    [WORKER_A]: { provider: "bm-worker/claude-opus-5", model: "claude-opus-5", runtimeInfo: { provider: "claude", model: "claude-opus-5-20260901" } },
    [WORKER_B]: { provider: "bm-worker-fallback-1", model: "gpt-5.5" },
  };
  const INCIDENTS: FallbackIncident[] = [
    incident({ id: "fb-00000000000b", status: "pending" }),
    incident({ id: "fb-00000000000c", status: "waiting", agentId: WORKER_B, requestId: REQ_B }),
    incident({ id: "fb-00000000000d", status: "switched", agentId: "agent-worker-switched", requestId: REQ_A, replacementId: WORKER_A }),
    incident({ id: "fb-00000000000e", status: "pending", workspaceId: "wks_other" }),
    incident({ id: "fb-00000000000f", status: "dismissed" }),
    managerIncident(),
  ];

  /** The old Manager's timeline in two pages: the newest `tail` entries first, then the older ones. */
  function managerPaseo(timeline: Entry[], tail: number) {
    const older = timeline.slice(0, timeline.length - tail);
    const newest = timeline.slice(timeline.length - tail);
    const refetch = vi.fn(async (agentId: string, options: { direction?: string }) => {
      if (agentId !== MANAGER) return { entries: [], hasOlder: false, startCursor: null };
      return options.direction === "tail"
        ? { entries: newest, hasOlder: older.length > 0, startCursor: "c1" }
        : { entries: older, hasOlder: false, startCursor: null };
    });
    return {
      refetch,
      paseo: {
        agents: {
          list: async () => ({ entries: AGENTS.map((agent) => ({ agent })) }),
          ref: (agentId: string) => ({
            timeline: { refetch: (options: { direction?: string }) => refetch(agentId, options) },
            refresh: async () => ({ agent: SNAPSHOTS[agentId] }),
          }),
        },
      },
    };
  }

  const TIMELINE: Entry[] = [
    typed("Build the login screen for Team Portal.", "c1"),
    said("On it."),
    typed("Also add a logout button. --token abc123secret", "c2"),
    // Newest page: the pill's window.
    relayed(asking(REQ_A, ["Q1", "Q2"])),
    typed(`${"x".repeat(980)}${SECRET}${"y".repeat(100)}`, "c3"),
    // A running Worker already has its answer: not an open question.
    relayed(asking(REQ_B, ["Q3"])),
    typed("BM-FALLBACK\nincident: fb-0000000000aa\nstatus: pending", "c-notice"),
    typed("Ship it when the review passes.", "c4"),
  ];
  const BLOCKERS = `Q1 and Q2 wait for the user:\n${"storage ".repeat(60)}`;

  async function storeReports(): Promise<void> {
    for (const [minute, extra] of [
      ["05", {}],
      ["40", { phase: "blocked" as const, blockers: BLOCKERS }],
    ] as const) {
      const at = `2026-09-22T01:${minute}:00.000Z`;
      await appendRecord(location, turn({ at, endedAt: at, turnId: `turn-${minute}`, requestId: REQ_A, reports: [report(at, { requestId: REQ_A, ...extra })] }));
    }
  }

  it("fills the Workers, open questions, open incidents and the user's last three messages from fakes", async () => {
    await storeReports();
    const { paseo, refetch } = managerPaseo(TIMELINE, 5);
    const log = vi.fn();

    expect(await managerHandover(managerIncident(), { paseo, location, incidents: INCIDENTS, env: ENV, log })).toBe(
      [
        "BM-HANDOVER",
        "role: manager",
        `workspaceId: ${WS}`,
        `replaces: ${MANAGER}`,
        'reason: L1 usage limit — "You\'ve hit your usage limit. Resets at 3pm."',
        "workers:",
        `- ${WORKER_A} · requestId ${REQ_A} · bm-worker/claude-opus-5-20260901 · idle · last report: blocked at 2026-09-22T01:40:00.000Z · blockers: ${`Q1 and Q2 wait for the user: ${"storage ".repeat(60)}`.slice(0, 300)}`,
        `- ${WORKER_B} · requestId ${REQ_B} · bm-worker-fallback-1/gpt-5.5 · running · last report: none · blockers: none`,
        `openQuestions: ${WORKER_A}: Q1, Q2`,
        "openIncidents: fb-00000000000b, fb-00000000000c",
        "",
        "The user's last messages to the Manager you replace (oldest first, verbatim):",
        "1. Also add a logout button. --token [redacted]",
        // Masked before the cut, so no piece of the secret survives it.
        `2. ${"x".repeat(980)}[redac...[truncated]`,
        "3. Ship it when the review passes.",
        "",
        "You are the Beads Manager of this workspace from now on. Every Worker listed was told your id. Tell the user in one line that you took over, then carry on.",
      ].join("\n"),
    );
    // The third message sat on the older page; nothing was late.
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not list a replaced, archived, closed or other workspace's Worker", async () => {
    const { paseo } = managerPaseo(TIMELINE, 5);
    const text = await managerHandover(managerIncident(), { paseo, location, incidents: INCIDENTS, env: ENV, log: vi.fn() });
    for (const id of ["agent-worker-labelled", "agent-worker-switched", "agent-worker-archived", "agent-worker-closed", "agent-worker-elsewhere", "agent-rev-a", `- ${MANAGER}`]) {
      expect(text, id).not.toContain(id);
    }
    // Without the switched incident its Worker counts again: two live Workers of REQ_A, so no one is waiting.
    const unswitched = await managerHandover(managerIncident(), { paseo, location, incidents: [], env: ENV, log: vi.fn() });
    expect(unswitched).toContain("\n- agent-worker-switched · requestId ");
    expect(unswitched).toContain("\nopenQuestions: none\nopenIncidents: none\n");
  });

  it("quotes only what the user typed: messages without clientMessageId, notices and handovers are left out", async () => {
    const { paseo } = managerPaseo(
      [
        typed("Fix the build.", "c1"),
        typed("BM-HANDOVER\nrole: manager", "c2"),
        relayed("Worker agent-worker-a: progress update, tests pass."),
        relayed(asking(REQ_A, ["Q1"])),
        typed("BM-SETTINGS\nManager agent id: `agent-x`", "c3"),
      ],
      5,
    );
    const text = await managerHandover(managerIncident(), { paseo, location, incidents: [], env: ENV, log: vi.fn() });
    expect(text).toContain("(oldest first, verbatim):\n1. Fix the build.\n\nYou are the Beads Manager");
    expect(text).not.toContain("progress update");

    const { paseo: silent } = managerPaseo([relayed("Worker agent-worker-a: progress update.")], 1);
    expect(await managerHandover(managerIncident(), { paseo: silent, location, incidents: [], env: ENV, log: vi.fn() })).toContain(
      "(oldest first, verbatim):\nnone\n",
    );
  });

  it("never lets a masked secret into the handover, even across the 1 000-character cut", async () => {
    const { paseo } = managerPaseo(
      [
        typed(`Deploy with --password=${SECRET}-flag and --secret "quoted value" please.`, "c1"),
        typed(`My daemon password is ${SECRET}.`, "c2"),
        typed(`${"z".repeat(990)} --token tok-9f8e7d6c5b4a`, "c3"),
      ],
      3,
    );
    const text = await managerHandover(managerIncident(), { paseo, location, incidents: [], env: ENV, log: vi.fn() });
    expect(text).not.toContain("hunter");
    expect(text).not.toContain("quoted value");
    expect(text).not.toContain("tok-9f8e");
    expect(text).toContain("1. Deploy with --password=[redacted] and --secret [redacted] please.");
    expect(text).toContain("2. My daemon password is [redacted].");
  });

  it("reads unknown / none for what it cannot find, and never throws", async () => {
    const bare = { agents: { list: async () => ({ entries: [] }) } };
    const log = vi.fn();
    const text = await managerHandover(managerIncident(), { paseo: bare, location: null, incidents: null, log });
    expect(text).toContain("\nworkers: unknown\nopenQuestions: unknown\nopenIncidents: unknown\n");
    expect(text).toContain("(oldest first, verbatim):\nunknown\n");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] the handover of incident fb-0000000000aa could not read the agent list, the timeline/);

    // Tracing off: the Workers are listed, their reports read unknown; no Worker at all reads none.
    const { paseo } = managerPaseo(TIMELINE, 5);
    const untraced = await managerHandover(managerIncident(), { paseo, location: null, incidents: INCIDENTS, env: ENV, log: vi.fn() });
    expect(untraced).toContain(`- ${WORKER_A} · requestId ${REQ_A} · bm-worker/claude-opus-5-20260901 · idle · last report: unknown · blockers: unknown\n`);
    const alone = { agents: { list: async () => ({ entries: [{ agent: AGENTS[0] }] }) } };
    expect(await managerHandover(managerIncident(), { paseo: alone, location, incidents: [], log: vi.fn() })).toContain("\nworkers: none\n");
  });

  it("keeps to its budget: a timeline that never answers costs only the questions and the messages", async () => {
    await storeReports();
    const hanging = managerPaseo(TIMELINE, 5);
    hanging.refetch.mockImplementation(() => new Promise(() => undefined));
    // Snapshots that take real time still arrive: the hanging timeline does not use up their share.
    const ref = hanging.paseo.agents.ref;
    hanging.paseo.agents.ref = (agentId: string) => ({
      ...ref(agentId),
      refresh: () => new Promise((resolve) => setTimeout(() => resolve({ agent: SNAPSHOTS[agentId] }), 20)),
    });
    const log = vi.fn();
    const started = Date.now();
    const text = await managerHandover(managerIncident(), { paseo: hanging.paseo, location, incidents: INCIDENTS, env: ENV, budgetMs: 300, log });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(text).toContain(`\n- ${WORKER_A} · requestId ${REQ_A} · bm-worker/claude-opus-5-20260901 · idle · last report: blocked at 2026-09-22T01:40:00.000Z · blockers: Q1 and Q2`);
    expect(text).toContain("\nopenQuestions: unknown\nopenIncidents: fb-00000000000b, fb-00000000000c\n");
    expect(text).toContain("(oldest first, verbatim):\nunknown\n");
    expect(log).toHaveBeenCalledWith(`[paseo-bm] the handover of incident fb-0000000000aa could not read the timeline of Manager ${MANAGER} within 300 ms; those parts read unknown.`);
  });
});
