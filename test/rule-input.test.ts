import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import { reconstructTraces, type AgentFacts, type ReconstructedTrace } from "../plugin/server/traces";
import {
  requestTraceOf,
  ruleInputOf,
  traceOfAgent,
  traceOfManagerTurn,
  workspaceTracesOf,
} from "../plugin/server/request-trace";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import { TRACE_STORE_SCHEMA_VERSION, type ParsedReport, type TraceRecord } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Orchestrator design §4.1, §4.2: `ruleInputOf` gives the one rule left,
 * `review.over-budget`, every datum it reads, from a reconstructed trace, and
 * the helper `review-budget.ts` shares rebuilds that trace once per finished
 * turn.
 */

const WS = "wks_rules";
const REQ = "req-20260928T010000Z";
const OTHER_REQ = "req-20260928T020000Z";
const MANAGER = "agent-manager";
const WORKER = "agent-worker";
const REVIEWER = "agent-rev-1";
/** A Reviewer that went into `error` before any turn of it was recorded. */
const DEAD_REVIEWER = "agent-rev-2";

const at = (minute: number, second = 0) =>
  `2026-09-28T01:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

function turn(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: at(0),
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: null,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: at(0),
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

function report(overrides: Partial<ParsedReport>): ParsedReport {
  return {
    agentId: WORKER,
    at: at(1),
    requestId: REQ,
    phase: "received",
    tier: "Small",
    filesChanged: [],
    beadsCreated: [],
    beadsUpdated: [],
    beadsClosed: [],
    beadsReady: [],
    reviewFindingsOpen: null,
    buildAndTests: null,
    skillsUsed: [],
    blockers: null,
    guardrail: null,
    unparsedFields: [],
    incompleteFields: [],
    ...overrides,
  };
}

const msg = (agentId: string, when: string, text: string, origin?: "user" | "agent") => ({
  agentId,
  at: when,
  text,
  truncated: false,
  ...(origin === undefined ? {} : { origin }),
});

const shell = (command: string, when: string) => ({ kind: "shell" as const, detail: command, agentId: WORKER, at: when });
const file = (path: string, when: string) => ({ kind: "file" as const, detail: path, agentId: WORKER, at: when });

/**
 * One Small request: the user asks the Manager, the Worker's first turn fails,
 * its second creates a bead and edits a design document, one Reviewer is called
 * twice and a second one dies before any turn. Records are stored out of order
 * on purpose: everything in `RuleInput` is oldest first.
 */
function fixtureRecords(): TraceRecord[] {
  return [
    turn({
      at: at(10),
      turnId: "turn-2",
      requestId: REQ,
      sent: [msg(MANAGER, at(9, 30), `BM-REPORT\nrequestId: ${REQ}\nphase: finished`, "agent")],
      received: [msg(MANAGER, at(10), "Done: the design was updated.")],
      reports: [
        report({
          at: at(9, 30),
          phase: "finished",
          filesChanged: ["src/date.ts", "docs/design/date.md"],
          beadsCreated: ["bm-a1"],
          incompleteFields: ["beadsCreated"],
        }),
      ],
    }),
    turn({
      at: at(1),
      requestId: REQ,
      startedAt: at(0),
      sent: [msg(MANAGER, at(0), "Fix the date format on the invoice screen.", "user")],
      received: [msg(MANAGER, at(0, 30), "Handing this to a Worker.")],
      reports: [report({ at: at(1), filesChanged: ["docs/design/date.md"], unparsedFields: ["tier"] })],
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(3),
      turnId: "w-1",
      requestId: REQ,
      parentAgentId: MANAGER,
      startedAt: at(2, 30),
      endedAt: at(3),
      outcome: "failed",
      sent: [msg(WORKER, at(2, 30), `Request ${REQ}: fix the date format.`, "agent")],
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(8),
      turnId: "w-2",
      requestId: REQ,
      parentAgentId: MANAGER,
      startedAt: at(4),
      endedAt: at(8),
      sent: [msg(WORKER, at(4), "Please continue.", "user")],
      evidence: [
        shell("br create --help", at(5)),
        shell(`br create "Fix the date format" -l feature:date`, at(5, 10)),
        file("docs/design/date.md", at(5, 20)),
        shell("br update bm-a1 --status in_progress && npm test", at(5, 30)),
        file("src/date.ts", at(5, 25)),
      ],
    }),
    turn({
      agentId: REVIEWER,
      role: "reviewer",
      at: at(7),
      turnId: "r-1",
      requestId: REQ,
      parentAgentId: WORKER,
      startedAt: at(5, 50),
      endedAt: at(7),
      // One review call with `origin`, one written before the field existed.
      sent: [msg(REVIEWER, at(6), `Review batch b1 of ${REQ}.`, "agent"), msg(REVIEWER, at(6, 30), "Re-review b1.")],
      received: [msg(REVIEWER, at(7), "BM-REVIEW\nverdict: approved")],
    }),
  ];
}

function facts(overrides: Partial<AgentFacts> & Pick<AgentFacts, "id" | "role">): AgentFacts {
  return {
    status: "idle",
    parentAgentId: null,
    createdAt: null,
    requestIdLabel: null,
    batchIdLabel: null,
    archived: false,
    ...overrides,
  };
}

function fixtureAgents(): AgentFacts[] {
  return [
    facts({ id: MANAGER, role: "manager" }),
    facts({ id: WORKER, role: "worker", parentAgentId: MANAGER, createdAt: at(2), requestIdLabel: REQ }),
    facts({ id: REVIEWER, role: "reviewer", parentAgentId: WORKER, requestIdLabel: REQ }),
    facts({ id: DEAD_REVIEWER, role: "reviewer", status: "error", parentAgentId: WORKER, createdAt: at(6, 40), requestIdLabel: REQ }),
  ];
}

function rebuild(records: TraceRecord[], agents: AgentFacts[]): { trace: ReconstructedTrace } {
  const trace = reconstructTraces({ records, agents }).find((candidate) => candidate.requestId === REQ);
  if (trace === undefined) throw new Error("fixture request was not reconstructed");
  return { trace };
}

describe("ruleInputOf on a reconstructed fixture", () => {
  const { trace } = rebuild(fixtureRecords(), fixtureAgents());
  const input = ruleInputOf(trace);

  it("carries the request's identity and tier, and nothing the retired rules read (autonomy design §B.9)", () => {
    expect(input).toMatchObject({ traceId: `req:${REQ}`, requestId: REQ, tier: "Small" });
    expect(Object.keys(input).sort()).toEqual(["inbound", "requestId", "reviewCalls", "tier", "traceId"]);
  });

  it("counts review calls as the review budget does, and keeps null for unknown (review.over-budget)", () => {
    expect(input.reviewCalls).toBe(2);
    const noReviewerTurns = rebuild(
      fixtureRecords().filter((record) => record.role !== "reviewer"),
      fixtureAgents(),
    );
    expect(ruleInputOf(noReviewerTurns.trace).reviewCalls).toBeNull();
  });

  it("gives inbound messages their receiving agent, origin and time (review.over-budget's evidence)", () => {
    expect(input.inbound.map((entry) => [entry.agentId, entry.role, entry.at, entry.origin])).toEqual([
      [MANAGER, "manager", at(0), "user"],
      [WORKER, "worker", at(2, 30), "agent"],
      [WORKER, "worker", at(4), "user"],
      [REVIEWER, "reviewer", at(6), "agent"],
      // Recorded before `origin` existed: null, never read as the user's.
      [REVIEWER, "reviewer", at(6, 30), null],
      [MANAGER, "manager", at(9, 30), "agent"],
    ]);
    expect(input.inbound[0]?.text).toBe("Fix the date format on the invoice screen.");
  });

  it("is pure: the same trace gives the same input, and the trace is left untouched", () => {
    const again = rebuild(fixtureRecords(), fixtureAgents());
    const before = JSON.stringify(again.trace);
    expect(ruleInputOf(again.trace)).toEqual(input);
    expect(JSON.stringify(again.trace)).toBe(before);
  });
});

// ── The shared rebuild, over a real trace store ───────────────────────────

let home: string;
let location: { tracesDir: string };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-rule-input-"));
  location = { tracesDir: join(home, "traces") };
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The shared fake SDK with the Manager, the request's Worker and Reviewer, and a second Worker still running. */
function daemon(): DashboardPaseo {
  const agent = (id: string, labels: Record<string, string>, status = "idle") => ({ id, workspaceId: WS, status, provider: `bm-${labels["bm.role"]}`, labels });
  return fakePaseo<DashboardPaseo>({
    agents: [
      agent(MANAGER, { "bm.role": "manager" }),
      agent(WORKER, { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER }),
      agent(REVIEWER, { "bm.role": "reviewer", "bm.requestId": REQ, "paseo.parent-agent-id": WORKER }),
      agent("agent-worker-2", { "bm.role": "worker", "bm.requestId": OTHER_REQ, "paseo.parent-agent-id": MANAGER }, "running"),
    ],
  }).paseo;
}

async function seedStore(): Promise<void> {
  for (const record of fixtureRecords().filter((candidate) => candidate.agentId !== DEAD_REVIEWER)) {
    await appendRecord(location, record);
  }
  // A later request of the same Manager.
  await appendRecord(
    location,
    turn({
      at: "2026-09-28T02:01:00.000Z",
      turnId: "turn-3",
      requestId: OTHER_REQ,
      sent: [msg(MANAGER, "2026-09-28T02:00:00.000Z", "Add a logout button.", "user")],
    }),
  );
}

describe("the shared request-trace rebuild", () => {
  it("rebuilds the workspace's traces from the store and the live agent list", async () => {
    await seedStore();
    const { records, agents, traces } = await workspaceTracesOf({ location, paseo: daemon(), home }, WS);
    expect(records).toHaveLength(6);
    expect([...agents.keys()].sort()).toEqual([MANAGER, WORKER, "agent-worker-2", REVIEWER].sort());
    expect(traces.map((trace) => trace.requestId)).toEqual([OTHER_REQ, REQ]);
  });

  it("finds the request of a Worker or Reviewer, and none for an agent it does not know", async () => {
    await seedStore();
    const deps = { location, paseo: daemon(), home };
    const byReviewer = await requestTraceOf(deps, WS, REVIEWER);
    expect(byReviewer?.trace.requestId).toBe(REQ);
    expect(byReviewer?.trace.reviewCalls).toBe(2);
    expect(byReviewer?.agents.get(REVIEWER)?.role).toBe("reviewer");
    expect(byReviewer?.trace.reviewerIds).toEqual([REVIEWER]);
    expect(ruleInputOf(byReviewer!.trace).reviewCalls).toBe(2);
    expect((await requestTraceOf(deps, WS, "agent-worker-2"))?.trace.requestId).toBe(OTHER_REQ);
    expect(await requestTraceOf(deps, WS, "agent-stranger")).toBeNull();
    // A Manager serves many requests: it is never matched as a Worker or Reviewer.
    expect(await requestTraceOf(deps, WS, MANAGER)).toBeNull();
  });

  it("takes a Manager's request from its newest recorded turn", async () => {
    await seedStore();
    const { traces } = await workspaceTracesOf({ location, paseo: daemon(), home }, WS);
    expect(traceOfManagerTurn(traces, MANAGER)?.requestId).toBe(OTHER_REQ);
    expect(traceOfManagerTurn(traces, "agent-other-manager")).toBeUndefined();
    expect(traceOfAgent(traces, WORKER)?.requestId).toBe(REQ);
  });
});
