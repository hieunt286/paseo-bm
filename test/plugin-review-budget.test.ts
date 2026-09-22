import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksLikeReport, parseReports, requestIdFromText } from "../plugin/server/bm-report";
import {
  BUDGET_NOTICE_MARKER,
  REVIEW_BUDGET,
  budgetNotice,
  checkReviewBudget,
  overrunOf,
  type BudgetOverrun,
  type BudgetPaseo,
} from "../plugin/server/review-budget";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { buildRecord } from "../plugin/server/collector";
import { reconstructTraces, type ReconstructedTrace } from "../plugin/server/traces";
import { guardrailMismatch, reviewerLine } from "../plugin/client/dashboard-model";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord, type TraceSummary } from "../plugin/shared/contracts";

/**
 * delta 20260917c §4.7 (REQ-037 errata): the plugin counts review calls and
 * tells the Manager once per request. It reports; it never stops an agent.
 */

const WS = "wks_budget";
const REQ = "req-20260917T010000Z";
/** A second request of the same Manager, over budget and finished yesterday. */
const OLD_REQ = "req-20260916T090000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";

let home: string;
let location: { tracesDir: string };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-budget-"));
  location = { tracesDir: join(home, "traces") };
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function trace(overrides: Partial<ReconstructedTrace> = {}): ReconstructedTrace {
  return {
    traceId: `req:${REQ}`,
    requestId: REQ,
    requestedAt: "2026-09-17T01:00:00.000Z",
    requestText: "Add a login screen.",
    managerAgentId: MANAGER,
    workerIds: [WORKER],
    reviewerIds: [],
    records: [],
    reports: [],
    reviews: [],
    reviewCalls: 1,
    guardrailReported: null,
    tier: "Small",
    state: "running",
    linking: "exact",
    agentsMissing: [],
    notices: [],
    segments: [],
    ...overrides,
  };
}

describe("overrunOf", () => {
  it("uses the budgets of REQ-037, unchanged", () => {
    expect(REVIEW_BUDGET).toEqual({ Small: 1, Medium: 4, Large: 6 });
  });

  it("is null inside the budget and at it", () => {
    expect(overrunOf(trace({ tier: "Small", reviewCalls: 1 }))).toBeNull();
    expect(overrunOf(trace({ tier: "Large", reviewCalls: 6 }))).toBeNull();
  });

  it("names the request, the count and the budget once it is passed", () => {
    expect(overrunOf(trace({ tier: "Medium", reviewCalls: 5 }))).toEqual({
      requestId: REQ,
      tier: "Medium",
      calls: 5,
      budget: 4,
      managerAgentId: MANAGER,
    });
  });

  it("never turns an unknown number into a notice", () => {
    expect(overrunOf(trace({ reviewCalls: null }))).toBeNull();
    expect(overrunOf(trace({ tier: null, reviewCalls: 9 }))).toBeNull();
    expect(overrunOf(trace({ requestId: null, reviewCalls: 9 }))).toBeNull();
    expect(overrunOf(trace({ managerAgentId: null, reviewCalls: 9 }))).toBeNull();
  });
});

describe("budgetNotice", () => {
  const text = budgetNotice({ requestId: REQ, tier: "Small", calls: 2, budget: 1, managerAgentId: MANAGER });

  it("carries the request id in the form that attributes the Manager's turn to that request", () => {
    expect(text.startsWith(BUDGET_NOTICE_MARKER)).toBe(true);
    expect(requestIdFromText(text)).toBe(REQ);
  });

  it("is not mistaken for a Worker report", () => {
    expect(looksLikeReport(text)).toBe(false);
  });

  it("is exactly the text design delta §4.7 decided (owner decision Q21: ask, never cancel on the notice alone)", () => {
    expect(text).toBe(
      `BM-BUDGET requestId: ${REQ}\n` +
        "The Worker has used 2 review calls; the Small budget is 1. " +
        "Ask the user whether to continue or to cancel the Worker's run, and wait for the answer. " +
        "Do not cancel on your own: the user may already have allowed the extra calls in the Worker's chat.",
    );
  });
});

// ── End to end over a real trace store ────────────────────────────────────

function turn(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-17T01:00:00.000Z",
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: null,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-17T01:00:00.000Z",
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

const msg = (agentId: string, at: string, text: string) => ({ agentId, at, text, truncated: false });

/** A Worker report as it reaches the Manager's timeline; the tier comes from here. */
function report(requestId: string, at: string) {
  return {
    agentId: WORKER,
    at,
    requestId,
    phase: "received" as const,
    tier: "Small" as const,
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
  };
}

/** A Small request: the Manager's turn carries the Worker's report, so the trace knows its tier. */
async function seedRequest(): Promise<void> {
  await appendRecord(
    location,
    turn({
      requestId: REQ,
      sent: [msg(MANAGER, "2026-09-17T01:00:00.000Z", "Fix the date format on the invoice screen.")],
      reports: [report(REQ, "2026-09-17T01:01:00.000Z")],
    }),
  );
  await appendRecord(
    location,
    turn({ agentId: WORKER, role: "worker", requestId: REQ, parentAgentId: MANAGER, at: "2026-09-17T01:02:00.000Z" }),
  );
}

/** One recorded Reviewer turn per review request it received. */
async function reviewCall(reviewerId: string, minute: number): Promise<void> {
  const at = `2026-09-17T01:${String(minute).padStart(2, "0")}:00.000Z`;
  await appendRecord(
    location,
    turn({
      agentId: reviewerId,
      role: "reviewer",
      turnId: `turn-${minute}`,
      requestId: REQ,
      parentAgentId: WORKER,
      at,
      sent: [msg(reviewerId, at, `Review batch b1 of ${REQ}.`)],
    }),
  );
}

function fakePaseo(options: { managerStatus?: () => string; managerArchivedAt?: string; send?: (text: string) => Promise<void>; reachable?: boolean } = {}) {
  const sent: string[] = [];
  const send = vi.fn(options.send ?? (async (text: string) => {
    sent.push(text);
  }));
  const entries: Record<string, Array<Record<string, unknown>>> = {
    manager: [{ agent: { id: MANAGER, workspaceId: WS, status: "idle", labels: { "bm.role": "manager" } } }],
    worker: [
      { agent: { id: "agent-worker-old", workspaceId: WS, status: "closed", labels: { "bm.role": "worker", "bm.requestId": OLD_REQ, "paseo.parent-agent-id": MANAGER } } },
      {
        agent: {
          id: WORKER,
          workspaceId: WS,
          status: "running",
          labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER },
        },
      },
    ],
    reviewer: [
      ...["agent-rev-1", "agent-rev-2"].map((id) => ({
        agent: { id, workspaceId: WS, status: "idle", labels: { "bm.role": "reviewer", "bm.requestId": REQ, "paseo.parent-agent-id": WORKER } },
      })),
      { agent: { id: "agent-rev-old", workspaceId: WS, status: "idle", labels: { "bm.role": "reviewer", "bm.requestId": OLD_REQ, "paseo.parent-agent-id": "agent-worker-old" } } },
    ],
  };
  const paseo = {
    agents: {
      list: async (input: { filter: { labels?: Record<string, string> } }) => ({
        entries: input.filter.labels === undefined ? Object.values(entries).flat() : (entries[input.filter.labels["bm.role"]!] ?? []),
      }),
      ...(options.reachable === false
        ? {}
        : {
            ref: (agentId: string) => ({
              timeline: { refetch: async () => ({}) },
              refresh: async () => ({
                agent: {
                  id: agentId,
                  status: options.managerStatus?.() ?? "idle",
                  ...(options.managerArchivedAt === undefined ? {} : { archivedAt: options.managerArchivedAt }),
                },
              }),
              send,
            }),
          }),
    },
    workspaces: { list: async () => ({ entries: [] }) },
    config: {},
  } as unknown as BudgetPaseo;
  return { paseo, send, sent };
}

const ended = (id: string, provider: string) =>
  ({ agent: { id, workspaceId: WS, parentAgentId: null, provider, cwd: "/repo", title: null }, turnId: "t", outcome: { kind: "completed" }, timeline: [] }) as never;

describe("checkReviewBudget", () => {
  it("stays quiet while the request is inside its budget", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    const { paseo, send } = fakePaseo();
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    expect(await checkReviewBudget(ended("agent-rev-1", "bm-reviewer/gpt"), { location, paseo, told, pending })).toBe("within");
    expect(send).not.toHaveBeenCalled();
    // "within" is also what an unattributed agent would get; one more call on
    // the same data proves the request really was found and counted.
    await reviewCall("agent-rev-1", 6);
    expect(await checkReviewBudget(ended("agent-rev-1", "bm-reviewer/gpt"), { location, paseo, told, pending })).toBe("sent");
  });

  it("tells the Manager once when a Small request makes a second review call", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    const { paseo, send, sent } = fakePaseo();
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    expect(await checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo, told, pending })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent[0]).toBe(budgetNotice({ requestId: REQ, tier: "Small", calls: 2, budget: 1, managerAgentId: MANAGER }));

    // A later turn of the Worker or of a new Reviewer does not repeat it.
    await reviewCall("agent-rev-2", 9);
    expect(await checkReviewBudget(ended(WORKER, "bm-worker/claude"), { location, paseo, told, pending })).toBe("already-told");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never interrupts a Manager that is running, and sends at a later turn end instead", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    let status = "running";
    const { paseo, send } = fakePaseo({ managerStatus: () => status });
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    expect(await checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo, told, pending })).toBe("deferred");
    expect(send).not.toHaveBeenCalled();
    status = "idle";
    expect(await checkReviewBudget(ended(WORKER, "bm-worker"), { location, paseo, told, pending })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores agents that are not paseo-bm's, and agents with no workspace", async () => {
    const { paseo, send } = fakePaseo();
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    expect(await checkReviewBudget(ended("x", "claude"), { location, paseo, told, pending })).toBe("ignored");
    expect(await checkReviewBudget(ended("y", "bm-workers"), { location, paseo, told, pending })).toBe("ignored");
    expect(await checkReviewBudget(ended("z", "bm-worker-fallback-4"), { location, paseo, told, pending })).toBe("ignored");
    expect(
      await checkReviewBudget(
        { agent: { id: WORKER, workspaceId: null, provider: "bm-worker" } } as never,
        { location, paseo, told, pending },
      ),
    ).toBe("ignored");
    expect(send).not.toHaveBeenCalled();
  });

  it("sends at the Manager's own turn end when the Worker's last report woke it (review b1, B2)", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    // The Worker's `finished` report woke the Manager, then the Worker's turn ended.
    let status = "running";
    const { paseo, send } = fakePaseo({ managerStatus: () => status });
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    expect(await checkReviewBudget(ended(WORKER, "bm-worker"), { location, paseo, told, pending })).toBe("deferred");
    // No Worker or Reviewer turn follows; only the Manager finishes answering.
    status = "idle";
    expect(await checkReviewBudget(ended(MANAGER, "bm-manager/claude"), { location, paseo, told, pending })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never announces an old request on its own: a Manager turn end only flushes what was found in this process (review b2)", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    // A second request of the same Manager, also over budget and long finished.
    await appendRecord(
      location,
      turn({
        requestId: OLD_REQ,
        at: "2026-09-16T09:00:00.000Z",
        sent: [msg(MANAGER, "2026-09-16T09:00:00.000Z", "Yesterday's request.")],
        reports: [report(OLD_REQ, "2026-09-16T09:01:00.000Z")],
      }),
    );
    await appendRecord(location, turn({ agentId: "agent-worker-old", role: "worker", requestId: OLD_REQ, parentAgentId: MANAGER, at: "2026-09-16T09:02:00.000Z" }));
    for (const minute of [10, 12]) {
      const at = `2026-09-16T09:${String(minute).padStart(2, "0")}:00.000Z`;
      await appendRecord(location, turn({ agentId: "agent-rev-old", role: "reviewer", turnId: `old-${minute}`, requestId: OLD_REQ, parentAgentId: "agent-worker-old", at, sent: [msg("agent-rev-old", at, `Review batch b1 of ${OLD_REQ}.`)] }));
    }

    const { paseo, send } = fakePaseo();
    // A fresh process: nothing was found here yet, so a Manager turn end is silent.
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    expect(await checkReviewBudget(ended(MANAGER, "bm-manager"), { location, paseo, told, pending })).toBe("within");
    expect(send).not.toHaveBeenCalled();

    // Only after a Reviewer turn end finds today's overrun can the Manager flush it.
    let status = "running";
    const busy = fakePaseo({ managerStatus: () => status });
    expect(await checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo: busy.paseo, told, pending })).toBe("deferred");
    status = "idle";
    expect(await checkReviewBudget(ended(MANAGER, "bm-manager"), { location, paseo: busy.paseo, told, pending })).toBe("sent");
    expect(busy.send).toHaveBeenCalledTimes(1);
    expect(busy.sent[0]).toContain(REQ);
    expect(busy.sent[0]).not.toContain(OLD_REQ);
    // And never twice.
    expect(await checkReviewBudget(ended(MANAGER, "bm-manager"), { location, paseo: busy.paseo, told, pending })).toBe("within");
    expect(busy.send).toHaveBeenCalledTimes(1);
  });

  it("sends once when two turn ends of the same request are handled at the same time (review b2)", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    const { paseo, send } = fakePaseo();
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    const results = await Promise.all([
      checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo, told, pending }),
      checkReviewBudget(ended("agent-rev-2", "bm-reviewer"), { location, paseo, told, pending }),
    ]);
    expect(results.filter((outcome) => outcome === "sent")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves an archived Manager alone (ADR-005): send() would un-archive and start a turn", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    const log = vi.fn();
    const { paseo, send } = fakePaseo({ managerArchivedAt: "2026-09-17T02:00:00.000Z" });
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    // Recognised at the Reviewer's own turn end: nothing is deferred, so no
    // later turn end tries to wake an agent the user archived.
    expect(await checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo, told, pending, log })).toBe("ignored");
    expect(pending.size).toBe(0);
    expect(await checkReviewBudget(ended(MANAGER, "bm-manager"), { location, paseo, told, pending, log })).toBe("within");
    expect(send).not.toHaveBeenCalled();
    expect(String(log.mock.calls[0]?.[0])).toContain("archived");
  });

  it("logs and retries later when the notice cannot be sent, without throwing", async () => {
    await seedRequest();
    await reviewCall("agent-rev-1", 5);
    await reviewCall("agent-rev-1", 7);
    const log = vi.fn();
    const failing = fakePaseo({ send: async () => { throw new Error("socket closed"); } });
    const told = new Set<string>();
    const pending = new Map<string, BudgetOverrun>();
    await expect(checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo: failing.paseo, told, pending, log })).resolves.toBe("deferred");
    expect(String(log.mock.calls[0]?.[0])).toContain("socket closed");
    expect(told.size).toBe(0);

    const unreachable = fakePaseo({ reachable: false });
    await expect(checkReviewBudget(ended("agent-rev-1", "bm-reviewer"), { location, paseo: unreachable.paseo, told, pending, log })).resolves.toBe("deferred");
    expect(String(log.mock.calls[1]?.[0])).toContain("cannot reach the Manager");
  });

  it("survives a malformed event", async () => {
    const { paseo } = fakePaseo();
    await expect(checkReviewBudget(undefined as never, { location, paseo, told: new Set(), pending: new Map() })).resolves.toBe("ignored");
  });
});

// ── BM-REPORT without the self-reported guardrail (absorbed from bm-wp-228-nszk) ──

const REPORT_BODY = [
  "BM-REPORT",
  `requestId: ${REQ}`,
  "phase: finished",
  "tier: Small (changed: no)",
  "filesChanged: src/invoice.ts",
  "beadsCreated: bm-1",
  "beadsUpdated: none",
  "beadsClosed: bm-1",
  "beadsReady: none",
  "reviewFindingsOpen: none",
  "buildAndTests: npm test pass",
  "skillsUsed: none",
  "blockers: none",
];

describe("BM-REPORT without a guardrail line", () => {
  const context = { agentId: WORKER, at: "2026-09-17T01:10:00.000Z" };

  it("parses cleanly: no guardrail, nothing incomplete, nothing unparsed", () => {
    const [report] = parseReports(REPORT_BODY.join("\n"), context);
    expect(report).toBeDefined();
    expect(report!.guardrail).toBeNull();
    expect(report!.incompleteFields).toEqual([]);
    expect(report!.unparsedFields).toEqual([]);
    expect(report!.beadsClosed).toEqual(["bm-1"]);
  });

  it("still reads a stored report that carries one", () => {
    const text = [...REPORT_BODY, "guardrail: batch b1 reviews 2/2; total 3/4; userAllowedExtra 0"].join("\n");
    const [report] = parseReports(text, context);
    expect(report!.guardrail).toMatchObject({ batchId: "b1", batchReviews: 2, batchMax: 2, total: 3, budget: 4 });
  });

  it("shows the derived count with no mismatch note when nothing was self-reported", () => {
    const summary = { reviewerIds: ["agent-rev-1"], reviewCalls: 2, guardrailReported: null } as unknown as TraceSummary;
    expect(guardrailMismatch(summary)).toBe(false);
    expect(reviewerLine(summary)).toContain("2 review calls");
    expect(reviewerLine(summary)).not.toMatch(/reported/i);
  });
});

// ── The plugin's own notices are not the user's words (review b2) ──────────

describe("plugin notices in the timeline", () => {
  it("records a BM-BUDGET notice as an agent message, not as the user's", async () => {
    // One turn starts at the last user message, so each case is its own turn.
    const build = async (text: string) =>
      (
        await buildRecord(
          {
            agent: { id: MANAGER, workspaceId: WS, parentAgentId: null, provider: "bm-manager/claude", cwd: "/repo", title: null },
            turnId: "t1",
            outcome: { kind: "completed" },
            timeline: [{ type: "user_message", text, clientMessageId: "id-the-sdk-always-adds" }],
          } as never,
          { location, paseo: undefined, log: () => {} } as never,
        )
      )?.record.sent[0]?.origin;
    const notice = budgetNotice({ requestId: REQ, tier: "Small", calls: 2, budget: 1, managerAgentId: MANAGER });
    expect(await build(notice)).toBe("agent");
    expect(await build("Please add a login screen.")).toBe("user");
  });

  it("never takes a notice for the request text of a row", () => {
    const notice = budgetNotice({ requestId: REQ, tier: "Small", calls: 2, budget: 1, managerAgentId: MANAGER });
    const [trace] = reconstructTraces({
      records: [
        turn({ requestId: REQ, sent: [{ agentId: MANAGER, at: "2026-09-17T01:00:00.000Z", text: notice, truncated: false }] }),
        turn({
          requestId: REQ,
          turnId: "turn-2",
          at: "2026-09-17T01:05:00.000Z",
          sent: [{ agentId: MANAGER, at: "2026-09-17T01:05:00.000Z", text: "Add a login screen.", truncated: false }],
        }),
      ],
      agents: [],
    });
    expect(trace?.requestText).toBe("Add a login screen.");
  });
});
