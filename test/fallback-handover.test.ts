import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workerHandover } from "../plugin/server/fallback-handover";
import { appendRecord, clearTraceStoreCache, type TraceStoreLocation } from "../plugin/server/trace-store";
import { TRACE_STORE_SCHEMA_VERSION, type FallbackIncident, type ParsedReport, type TraceRecord } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.4.8 (REQ-065 d): the handover a replacement Worker starts
 * from, built in code from the trace store, the review count and the replaced
 * Worker's timeline. Real trace store in a temporary directory, fake agents.
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

function fakePaseo(timeline: Array<{ type: string; text?: string }> = []) {
  const labels = (role: string, parent?: string) => ({ "bm.role": role, "bm.requestId": REQ, ...(parent === undefined ? {} : { "paseo.parent-agent-id": parent }) });
  const agents = [
    { id: MANAGER, workspaceId: WS, status: "idle", labels: { "bm.role": "manager" } },
    { id: WORKER, workspaceId: WS, status: "idle", labels: labels("worker", MANAGER) },
    { id: "agent-rev-1", workspaceId: WS, status: "idle", labels: labels("reviewer", WORKER) },
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
});
