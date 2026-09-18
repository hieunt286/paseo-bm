import { describe, expect, it } from "vitest";
import { REVIEWER_STOP_NOTICE } from "../plugin/server/stop-propagation";
import { BUDGET_NOTICE_MARKER } from "../plugin/server/notices";
import { requestIdFromText } from "../plugin/server/bm-report";
import {
  blocksCompletion,
  reconstructTraces,
  requestIdOfAgent,
  reviewCallsOf,
  stateOf,
  traceIdFor,
  type AgentFacts,
} from "../plugin/server/traces";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-206.1.1: reconstruction, association, counts, confidence and state.
 *
 * Eight grouping cases from the design, and the rule they all serve: an agent
 * that cannot be linked goes to the unknown group rather than to the nearest
 * trace.
 */

const WS = "wks_1";
const MANAGER = "agent-manager";

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: WS,
    agentId: MANAGER,
    role: "manager",
    turnId: "turn-1",
    requestId: null,
    parentAgentId: null,
    agentCreatedAt: null,
    startedAt: null,
    endedAt: "2026-09-16T10:00:00.000Z",
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

function message(text: string, at = "2026-09-16T10:00:00.000Z") {
  return { agentId: MANAGER, at, text, truncated: false };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-worker",
    at: "2026-09-16T10:05:00.000Z",
    requestId: "req-A",
    phase: "beads-done" as const,
    tier: "Medium" as const,
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
  };
}

function agent(overrides: Partial<AgentFacts> & { id: string }): AgentFacts {
  return {
    role: "worker",
    status: "idle",
    parentAgentId: MANAGER,
    createdAt: "2026-09-16T10:01:00.000Z",
    requestIdLabel: null,
    batchIdLabel: null,
    archived: false,
    ...overrides,
  };
}

const managerTurn = (requestId: string | null, at: string, text = "thêm màn hình báo cáo") =>
  record({ requestId, at, turnId: `turn-${at}`, sent: [message(text, at)] });

describe("request id extraction", () => {
  it("reads a request id out of a Worker initial prompt, plain or in markdown", () => {
    expect(requestIdFromText("Your task\nrequestId: req-20260916T100000Z\nrepo: /x")).toBe(
      "req-20260916T100000Z",
    );
    // The shape real agents write (WP-214 acceptance finding).
    expect(requestIdFromText("- `requestId`: `req-20260916T064147Z`")).toBe("req-20260916T064147Z");
    expect(requestIdFromText("**requestId**: req-20260916T064147Z")).toBe("req-20260916T064147Z");
    expect(requestIdFromText("no id here")).toBeNull();
  });

  it("prefers the label, then a report, then the prompt", () => {
    const records = [
      record({
        agentId: "agent-worker",
        role: "worker",
        requestId: null,
        reports: [report({ requestId: "req-from-report" })],
        sent: [message("requestId: req-from-prompt")],
      }),
    ];
    expect(requestIdOfAgent(agent({ id: "agent-worker", requestIdLabel: "req-from-label" }), records)).toEqual({
      requestId: "req-from-label",
      confidence: "exact",
    });
    expect(requestIdOfAgent(agent({ id: "agent-worker" }), records).requestId).toBe("req-from-report");
    const promptOnly = [record({ agentId: "agent-worker", role: "worker", sent: [message("requestId: req-from-prompt")] })];
    expect(requestIdOfAgent(agent({ id: "agent-worker" }), promptOnly).requestId).toBe("req-from-prompt");
    expect(requestIdOfAgent(agent({ id: "agent-worker" }), []).confidence).toBe("unknown");
  });
});

describe("one trace per user request", () => {
  it("opens a trace for a user message and not for a BM-REPORT", () => {
    const traces = reconstructTraces({
      records: [
        managerTurn("req-A", "2026-09-16T10:00:00.000Z"),
        record({
          at: "2026-09-16T10:05:00.000Z",
          turnId: "turn-report",
          sent: [message("BM-REPORT\nrequestId: req-A\nphase: beads-done", "2026-09-16T10:05:00.000Z")],
          reports: [report()],
        }),
      ],
      agents: [],
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]?.requestText).toBe("thêm màn hình báo cáo");
    expect(traces[0]?.reports).toHaveLength(1);
  });

  it("uses a stable trace id and sorts newest first", () => {
    const first = managerTurn("req-A", "2026-09-16T10:00:00.000Z");
    const second = managerTurn("req-B", "2026-09-16T11:00:00.000Z");
    expect(traceIdFor(first)).toBe("req:req-A");
    expect(traceIdFor(record({ requestId: null, agentId: "m", turnId: "t" }))).toBe("m:t");
    const traces = reconstructTraces({ records: [first, second], agents: [] });
    expect(traces.map((trace) => trace.requestId)).toEqual(["req-B", "req-A"]);
  });
});

describe("a Manager turn that mints the request id (found in the WP-214 acceptance run)", () => {
  it("reads the id out of the Manager's own reply, backticks and all", () => {
    const traces = reconstructTraces({
      records: [
        record({
          requestId: null,
          at: "2026-09-16T06:42:00.000Z",
          sent: [message("thêm docstring", "2026-09-16T06:41:34.000Z")],
          received: [
            message(
              // Verbatim shape from the real run, backticks included.
              "Đã giao việc xong.\n- `requestId`: `req-20260916T064147Z`\n- Worker: `dc2f85d3`",
              "2026-09-16T06:42:00.000Z",
            ),
          ],
        }),
      ],
      agents: [],
    });
    expect(traces[0]?.requestId).toBe("req-20260916T064147Z");
    expect(traces[0]?.traceId).toBe("req:req-20260916T064147Z");
    expect(traces[0]?.linking).toBe("exact");
  });

  it("adopts a labelled Worker's request id when exactly one window contains it", () => {
    const traces = reconstructTraces({
      records: [
        record({
          requestId: null,
          at: "2026-09-16T06:42:30.000Z",
          sent: [message("thêm docstring", "2026-09-16T06:41:34.000Z")],
        }),
      ],
      agents: [
        agent({ id: "w1", requestIdLabel: "req-20260916T064147Z", createdAt: "2026-09-16T06:42:00.000Z" }),
      ],
    });
    // The label names the request; the single containing window says which
    // Manager turn opened it, so this is a fact, not a guess.
    expect(traces[0]).toMatchObject({
      requestId: "req-20260916T064147Z",
      workerIds: ["w1"],
      linking: "exact",
    });
  });

  it("still refuses when two windows could contain the labelled Worker", () => {
    const traces = reconstructTraces({
      records: [
        record({ requestId: null, turnId: "t1", at: "2026-09-16T06:50:00.000Z", sent: [message("first", "2026-09-16T06:40:00.000Z")] }),
        record({ requestId: null, turnId: "t2", at: "2026-09-16T06:55:00.000Z", sent: [message("second", "2026-09-16T06:45:00.000Z")] }),
      ],
      agents: [agent({ id: "w1", requestIdLabel: "req-x", createdAt: "2026-09-16T06:46:00.000Z" })],
    });
    const adopted = traces.filter((trace) => trace.requestId === "req-x");
    expect(adopted).toHaveLength(0);
  });
});

describe("the eight grouping cases", () => {
  const managerA = managerTurn("req-A", "2026-09-16T10:00:00.000Z");

  it("1. links a Worker by its bm.requestId label", () => {
    const traces = reconstructTraces({
      records: [managerA],
      agents: [agent({ id: "w1", requestIdLabel: "req-A", createdAt: null })],
    });
    expect(traces[0]?.workerIds).toEqual(["w1"]);
    expect(traces[0]?.linking).toBe("exact");
  });

  it("2. links a Worker by the request id in its own report", () => {
    const traces = reconstructTraces({
      records: [
        managerA,
        record({ agentId: "w1", role: "worker", at: "2026-09-16T10:02:00.000Z", reports: [report({ requestId: "req-A" })] }),
      ],
      agents: [agent({ id: "w1", createdAt: null })],
    });
    expect(traces[0]?.workerIds).toEqual(["w1"]);
    expect(traces[0]?.linking).toBe("exact");
  });

  it("3. links a Worker by the request id in its initial prompt", () => {
    const traces = reconstructTraces({
      records: [
        managerA,
        record({
          agentId: "w1",
          role: "worker",
          at: "2026-09-16T10:02:00.000Z",
          sent: [message("Your task\nrequestId: req-A")],
        }),
      ],
      agents: [agent({ id: "w1", createdAt: null })],
    });
    expect(traces[0]?.workerIds).toEqual(["w1"]);
  });

  it("4. links an unlabelled Worker by time, and says it was inferred", () => {
    const traces = reconstructTraces({
      records: [managerTurn(null, "2026-09-16T10:00:00.000Z")],
      agents: [agent({ id: "w1", createdAt: "2026-09-16T10:00:30.000Z" })],
    });
    expect(traces[0]?.workerIds).toEqual(["w1"]);
    expect(traces[0]?.linking).toBe("inferred");
    expect(traces[0]?.notices.join(" ")).toContain("linked by time");
  });

  it("5. puts an unlinkable Worker in the unknown group instead of the nearest trace", () => {
    const traces = reconstructTraces({
      records: [managerA],
      agents: [agent({ id: "w-mystery", createdAt: null, parentAgentId: null })],
    });
    const unknown = traces.find((trace) => trace.traceId === "unknown");
    expect(unknown?.workerIds).toEqual(["w-mystery"]);
    expect(unknown?.linking).toBe("unknown");
    expect(traces.find((trace) => trace.requestId === "req-A")?.workerIds).toEqual([]);
  });

  it("6. keeps an orphan Worker whose Manager is gone", () => {
    const traces = reconstructTraces({
      records: [
        record({
          agentId: "w1",
          role: "worker",
          at: "2026-09-16T10:02:00.000Z",
          reports: [report({ requestId: "req-A", phase: "finished" })],
        }),
      ],
      agents: [agent({ id: "w1", parentAgentId: null, createdAt: null })],
    });
    // No Manager turn at all, so the only place it can live is the unknown group.
    const unknown = traces.find((trace) => trace.traceId === "unknown");
    expect(unknown?.workerIds).toEqual(["w1"]);
  });

  it("7. counts a reused Reviewer once as an agent and twice as calls", () => {
    const traces = reconstructTraces({
      records: [
        managerA,
        record({
          agentId: "rev-1",
          role: "reviewer",
          at: "2026-09-16T10:30:00.000Z",
          sent: [message("review batch-1", "2026-09-16T10:20:00.000Z"), message("review batch-2", "2026-09-16T10:30:00.000Z")],
        }),
      ],
      agents: [
        agent({ id: "w1", requestIdLabel: "req-A" }),
        agent({ id: "rev-1", role: "reviewer", parentAgentId: "w1" }),
      ],
    });
    expect(traces[0]?.reviewerIds).toEqual(["rev-1"]);
    expect(traces[0]?.reviewCalls).toBe(2);
  });

  it("8. attributes an unlabelled Worker to the request that preceded it, and refuses when none did", () => {
    // Two unlabelled requests 30 s apart: a Worker created between them
    // belongs to the first, and that is not a guess — the second request did
    // not exist yet. (Request windows cannot overlap: a Manager handles one
    // turn at a time.)
    const between = reconstructTraces({
      records: [
        managerTurn(null, "2026-09-16T10:00:00.000Z", "first request"),
        managerTurn(null, "2026-09-16T10:00:30.000Z", "second request"),
      ],
      agents: [agent({ id: "w1", createdAt: "2026-09-16T10:00:20.000Z" })],
    });
    const first = between.find((trace) => trace.requestText === "first request");
    expect(first?.workerIds).toEqual(["w1"]);
    expect(first?.linking).toBe("inferred");

    // A Worker that predates every request cannot be attributed at all.
    const before = reconstructTraces({
      records: [managerTurn(null, "2026-09-16T10:00:00.000Z", "only request")],
      agents: [agent({ id: "w-early", createdAt: "2026-09-16T09:00:00.000Z" })],
    });
    expect(before.find((trace) => trace.traceId === "unknown")?.workerIds).toEqual(["w-early"]);
    expect(before.find((trace) => trace.requestText === "only request")?.workerIds).toEqual([]);
  });
});

describe("counts stay distinct", () => {
  it("keeps agent count, call count and the Worker's self-reported guardrail apart", () => {
    const guardrail = {
      batchId: "batch-1",
      batchReviews: 2,
      batchMax: 2,
      polish: 0,
      polishMax: 1,
      total: 9,
      budget: 10,
      userAllowedExtra: 0,
      raw: "batch batch-1 reviews 2/2; polish 0/1; total 9/10; userAllowedExtra 0",
    };
    const traces = reconstructTraces({
      records: [
        managerTurn("req-A", "2026-09-16T10:00:00.000Z"),
        record({
          agentId: "w1",
          role: "worker",
          at: "2026-09-16T10:40:00.000Z",
          reports: [report({ guardrail, agentId: "w1" })],
        }),
        record({
          agentId: "rev-1",
          role: "reviewer",
          at: "2026-09-16T10:30:00.000Z",
          sent: [message("review batch-1")],
        }),
      ],
      agents: [
        agent({ id: "w1", requestIdLabel: "req-A" }),
        agent({ id: "rev-1", role: "reviewer", parentAgentId: "w1" }),
      ],
    });
    const trace = traces[0]!;
    expect(trace.reviewerIds).toHaveLength(1);
    expect(trace.reviewCalls).toBe(1);
    // The claimed total (9) is preserved verbatim and NOT used as the count.
    expect(trace.guardrailReported?.total).toBe(9);
    expect(trace.tier).toBe("Medium");
  });

  it("returns null review calls when there is no Reviewer at all", () => {
    const traces = reconstructTraces({ records: [managerTurn("req-A", "2026-09-16T10:00:00.000Z")], agents: [] });
    expect(traces[0]?.reviewCalls).toBeNull();
  });

  it("does not count a BM-REVIEW answer as a review call", () => {
    const records = [
      record({
        agentId: "rev-1",
        role: "reviewer",
        sent: [message("review batch-1"), message("BM-REVIEW\nverdict: approved")],
      }),
    ];
    expect(reviewCallsOf(["rev-1"], records)).toBe(1);
    // Nor the stop notice the plugin sends when the user stops the Worker.
    const stopped = [record({ agentId: "rev-1", role: "reviewer", sent: [message("review batch-1"), message(REVIEWER_STOP_NOTICE)] })];
    expect(reviewCallsOf(["rev-1"], stopped)).toBe(1);
    // Reviewers with no recorded turn: unknown, not zero.
    expect(reviewCallsOf(["rev-unrecorded"], records)).toBeNull();
  });
});

describe("state precedence (design §7.3)", () => {
  const agents = new Map<string, AgentFacts>([
    ["w1", agent({ id: "w1" })],
    ["w-run", agent({ id: "w-run", status: "running" })],
    ["w-err", agent({ id: "w-err", status: "error" })],
  ]);

  it("running beats a blocked report", () => {
    expect(
      stateOf({ workerIds: ["w-run"], reviewerIds: [], reports: [report({ phase: "blocked" })] }, agents, []),
    ).toBe("running");
  });

  it("blocked report means waiting for the user", () => {
    expect(stateOf({ workerIds: ["w1"], reviewerIds: [], reports: [report({ phase: "blocked" })] }, agents, [])).toBe(
      "waiting_user",
    );
  });

  it("an error status or a failed turn is failed", () => {
    expect(stateOf({ workerIds: ["w-err"], reviewerIds: [], reports: [] }, agents, [])).toBe("failed");
    expect(
      stateOf({ workerIds: ["w1"], reviewerIds: [], reports: [] }, agents, [record({ outcome: "failed" })]),
    ).toBe("failed");
  });

  it("a finished report with nothing outstanding is completed", () => {
    expect(
      stateOf(
        { workerIds: ["w1"], reviewerIds: [], reports: [report({ phase: "finished", blockers: null })] },
        agents,
        [],
      ),
    ).toBe("completed");
  });

  it("a finished report that names what it did not deliver is stopped, not completed", () => {
    // worker.md sends `finished` when it is stopped too, so the phase alone is
    // not success. This mislabelled a stopped request as "Completed" in the
    // WP-214 acceptance run.
    expect(
      stateOf(
        {
          workerIds: ["w1"],
          reviewerIds: [],
          reports: [report({ phase: "finished", blockers: "stopped by the user before the bead was created" })],
        },
        agents,
        [],
      ),
    ).toBe("stopped");
  });

  it("an earlier interruption does not make a delivered request stopped", () => {
    // WP-214 acceptance, defect 8. F-1 was interrupted four times and then
    // finished properly: its last report is `finished` with no blockers, while
    // seven earlier turns are `canceled`. Reading "any canceled turn" as a stop
    // reported the delivered request as "Stopped" — the mirror image of the
    // defect the test above covers. Only the last report decides.
    expect(
      stateOf(
        {
          workerIds: ["w1"],
          reviewerIds: [],
          reports: [
            report({ phase: "finished", blockers: "STOPPED mid-work by the user before the review call." }),
            report({ phase: "bead-implemented", blockers: null }),
            report({ phase: "finished", blockers: null }),
          ],
        },
        agents,
        [record({ outcome: "canceled" }), record({ outcome: "completed" })],
      ),
    ).toBe("completed");
  });

  it("blockers that are present but empty are not a stop", () => {
    expect(
      stateOf(
        { workerIds: ["w1"], reviewerIds: [], reports: [report({ phase: "finished", blockers: "   " })] },
        agents,
        [],
      ),
    ).toBe("completed");
  });

  it("a Worker with neither a finish nor a run is stopped", () => {
    expect(stateOf({ workerIds: ["w1"], reviewerIds: [], reports: [] }, agents, [])).toBe("stopped");
  });

  it("no Worker at all is unknown", () => {
    expect(stateOf({ workerIds: [], reviewerIds: [], reports: [] }, agents, [])).toBe("unknown");
  });
});

describe("missing and archived agents", () => {
  it("reports an agent that is no longer on the machine", () => {
    const traces = reconstructTraces({
      records: [
        managerTurn("req-A", "2026-09-16T10:00:00.000Z"),
        record({ agentId: "w-gone", role: "worker", at: "2026-09-16T10:02:00.000Z", requestId: "req-A" }),
      ],
      agents: [],
    });
    // The Worker exists only in the store, so it cannot be linked from the
    // agent list; the trace still exists and says what it knows.
    expect(traces[0]?.workerIds).toEqual([]);
    expect(traces[0]?.records.length).toBeGreaterThan(0);
  });

  it("notes an archived Worker", () => {
    const traces = reconstructTraces({
      records: [managerTurn("req-A", "2026-09-16T10:00:00.000Z")],
      agents: [agent({ id: "w1", requestIdLabel: "req-A", archived: true })],
    });
    expect(traces[0]?.notices.join(" ")).toContain("archived");
  });
});

/**
 * WP-214 acceptance, defect 6: on the operator's own workspace the store
 * counted 4 traces while reconstruction returned 0 rows.
 *
 * Cause: collection begins when the plugin loads, so a Manager already in
 * conversation records turns whose only `sent` message is its own BM-REPORT.
 * `firstUserText` filters reports out, and the old code skipped any Manager
 * turn without user text — dropping two requests that carried an *exact*
 * request id, while the storage line still counted them.
 *
 * The records below are the observed shape from
 * `~/.paseo-bm/traces/wks_a217b1fc9568ab78/events-202609.jsonl`.
 */
describe("a request whose opening turn was never collected (found in the WP-214 acceptance run)", () => {
  const reportOnly = (at: string, requestId: string, phase: "blocked" | "finished") =>
    record({
      at,
      requestId,
      endedAt: at,
      sent: [message(`BM-REPORT\nrequestId: ${requestId}\nphase: ${phase}\ntier: Medium`, at)],
      received: [message("...", at)],
      reports: [report({ requestId, phase, agentId: MANAGER, at })],
    });

  it("still opens the request, and says the request text is missing instead of showing nothing", () => {
    const traces = reconstructTraces({
      records: [
        reportOnly("2026-09-16T06:22:44.000Z", "req-20260916T062244Z", "blocked"),
        reportOnly("2026-09-16T02:39:34.000Z", "req-20260916T023934Z", "finished"),
      ],
      agents: [],
    });

    const rows = traces.filter((trace) => trace.traceId !== "unknown");
    expect(rows.map((trace) => trace.requestId).sort()).toEqual([
      "req-20260916T023934Z",
      "req-20260916T062244Z",
    ]);
    // The id was read, not guessed, so the row is still exact...
    expect(rows.every((trace) => trace.linking === "exact")).toBe(true);
    // ...but the request text is absent, and the row has to admit it.
    expect(rows.every((trace) => trace.requestText === null)).toBe(true);
    expect(rows[0]!.notices).toContain(
      "The request text was not recorded: collection started after this request began.",
    );
  });

  it("keeps many report turns of one request as one row", () => {
    const traces = reconstructTraces({
      records: [
        reportOnly("2026-09-16T06:22:44.000Z", "req-X", "blocked"),
        reportOnly("2026-09-16T06:30:00.000Z", "req-X", "blocked"),
        reportOnly("2026-09-16T06:40:00.000Z", "req-X", "finished"),
      ],
      agents: [],
    });

    const rows = traces.filter((trace) => trace.traceId !== "unknown");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.records).toHaveLength(3);
    expect(rows[0]!.reports).toHaveLength(3);
  });

  it("adopts the user text when a later turn of the same request carries it", () => {
    const at = "2026-09-16T06:45:00.000Z";
    const traces = reconstructTraces({
      records: [
        reportOnly("2026-09-16T06:22:44.000Z", "req-X", "blocked"),
        record({
          at,
          requestId: "req-X",
          endedAt: at,
          sent: [message("thêm màn hình báo cáo", at)],
        }),
      ],
      agents: [],
    });

    const row = traces.find((trace) => trace.requestId === "req-X");
    expect(row?.requestText).toBe("thêm màn hình báo cáo");
    expect(row?.notices ?? []).not.toContain(
      "The request text was not recorded: collection started after this request began.",
    );
  });

  it("does not open a row for an anonymous report turn: that is evidence, not a request", () => {
    const traces = reconstructTraces({
      records: [
        record({
          at: "2026-09-16T06:22:44.000Z",
          requestId: null,
          sent: [message("BM-REPORT\nphase: finished\ntier: Small")],
        }),
      ],
      agents: [],
    });
    expect(traces.filter((trace) => trace.traceId !== "unknown")).toHaveLength(0);
  });
});

/**
 * WP-214 acceptance, defect 9: a Worker sends status updates to its Manager
 * with `send_agent_prompt`, and they arrive as `user_message` items exactly
 * like a user request — so one of them opened its own row, showing a request
 * with no worker, no beads and eleven unknown steps.
 *
 * The Manager turn sequence below is the real one from
 * `~/.paseo-bm/traces/wks_1a215b77cbcfd5e7/events-202609.jsonl`:
 * turn 1 is F-1's request (no id yet), turn 2 reports `received` for
 * req-…064147Z, turn 7 is the Worker's status update, turn 11 is F-2's request
 * and turn 12 a follow-up override, and turn 13 reports `received` for
 * req-…070544Z.
 */
describe("a Manager turn that names no request belongs to the request it names next", () => {
  const F1 = "req-20260916T064147Z";
  const F2 = "req-20260916T070544Z";

  const inbound = (at: string, text: string, requestId: string | null = null, phase?: "received" | "finished") =>
    record({
      at,
      requestId,
      endedAt: at,
      turnId: `foreground-turn-${at.slice(17, 19)}`,
      sent: [message(text, at)],
      reports: phase === undefined ? [] : [report({ requestId: requestId!, phase, agentId: MANAGER, at })],
    });

  const managerTurns = () => [
    inbound("2026-09-16T06:42:37.000Z", "Trong file src/invoice.py, hàm format_date đang thiếu docstring."),
    inbound("2026-09-16T06:43:45.000Z", `BM-REPORT\nrequestId: ${F1}\nphase: received\ntier: Small`, F1, "received"),
    inbound(
      "2026-09-16T06:58:30.000Z",
      "Status update (not a milestone report): the user resumed me with an explicit instruction to run the single review call.",
    ),
    inbound("2026-09-16T06:59:25.000Z", `BM-REPORT\nrequestId: ${F1}\nphase: finished\ntier: Small`, F1, "finished"),
    inbound("2026-09-16T07:06:35.000Z", "Yêu cầu mới (fixture F-2). Thêm một endpoint GET /invoices/{id}/total."),
    inbound("2026-09-16T07:07:21.000Z", "Override rõ ràng: xử lý yêu cầu này ở tier Medium."),
    inbound("2026-09-16T07:08:18.000Z", `BM-REPORT\nrequestId: ${F2}\nphase: received\ntier: Medium`, F2, "received"),
  ];

  it("shows two rows for two requests, not five", () => {
    const rows = reconstructTraces({ records: managerTurns(), agents: [] }).filter(
      (trace) => trace.traceId !== "unknown",
    );
    // Newest request first, the order the list shows.
    expect(rows.map((trace) => trace.requestId)).toEqual([F2, F1]);
  });

  it("takes the request text from the turn that asked, not from the Worker's status update", () => {
    const rows = reconstructTraces({ records: managerTurns(), agents: [] });
    const f1 = rows.find((trace) => trace.requestId === F1);
    const f2 = rows.find((trace) => trace.requestId === F2);
    expect(f1?.requestText).toContain("format_date đang thiếu docstring");
    expect(f2?.requestText).toContain("GET /invoices/{id}/total");
    // The status update is still recorded — it is a message sent to the
    // Manager — it just is not a request of its own.
    expect(f1?.records.some((r) => r.sent[0]?.text.startsWith("Status update"))).toBe(true);
  });

  it("keeps a follow-up instruction on the request it is about", () => {
    const f2 = reconstructTraces({ records: managerTurns(), agents: [] }).find(
      (trace) => trace.requestId === F2,
    );
    expect(f2?.records.some((r) => r.sent[0]?.text.startsWith("Override rõ ràng"))).toBe(true);
    expect(f2?.requestedAt).toBe("2026-09-16T07:06:35.000Z");
  });

  it("still gives a provisional row to a request whose first report has not arrived", () => {
    const records = [
      inbound("2026-09-16T08:00:00.000Z", "Yêu cầu mới chưa có báo cáo nào"),
    ];
    const rows = reconstructTraces({ records, agents: [] }).filter((trace) => trace.traceId !== "unknown");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBeNull();
    expect(rows[0]!.linking).toBe("unknown");
    expect(rows[0]!.requestText).toBe("Yêu cầu mới chưa có báo cáo nào");
  });
});

/**
 * Delta 20260917d defect A, from the owner's workspace `wks_a217b1fc9568ab78`:
 * a Manager archived at 04:18 had a last turn carrying the user's commit/push
 * instruction and no request id. The Manager created a minute later opened
 * `req-20260917T041929Z` with a question about MR. Folding across the whole
 * workspace attached the OLD Manager's turn to the NEW Manager's request, and
 * `fold` then took the earlier message as the request text: the row showed
 * yesterday's commit instruction, timed 18 hours early, and the day's request
 * bar read 0.
 */
describe("a turn is never folded into a request another Manager named", () => {
  const OLD = "agent-manager-old";
  const NEW = "agent-manager-new";
  const REQ = "req-20260917T041929Z";
  const COMMIT = "Hãy thực hiện commit, push toàn bộ những thay đổi";
  const MR = "check mr giúp tôi";

  const turn = (agentId: string, at: string, text: string, requestId: string | null = null) =>
    record({
      agentId,
      at,
      endedAt: at,
      requestId,
      turnId: "foreground-turn-1",
      sent: [{ agentId, at, text, truncated: false }],
      reports:
        requestId === null
          ? []
          : [report({ requestId, phase: "received", tier: "Small", agentId, at })],
    });

  const records = () => [
    turn(OLD, "2026-09-16T10:28:40.000Z", COMMIT),
    turn(NEW, "2026-09-17T04:19:29.000Z", MR, REQ),
  ];

  it("gives each Manager its own row", () => {
    const rows = reconstructTraces({ records: records(), agents: [] }).filter(
      (trace) => trace.traceId !== "unknown",
    );
    expect(rows).toHaveLength(2);
    // Newest first, the order the list shows.
    expect(rows.map((trace) => trace.managerAgentId)).toEqual([NEW, OLD]);
  });

  it("keeps the request text and time of the Manager that opened the request", () => {
    const rows = reconstructTraces({ records: records(), agents: [] });
    const request = rows.find((trace) => trace.requestId === REQ);
    expect(request?.requestText).toBe(MR);
    expect(request?.requestedAt).toBe("2026-09-17T04:19:29.000Z");
    // The old Manager's turn is not among its records either: its tokens and
    // its duration must not be counted against today's request.
    expect(request?.records.map((r) => r.agentId)).toEqual([NEW]);
  });

  it("still shows the older Manager's unanswered instruction, as its own provisional row", () => {
    const rows = reconstructTraces({ records: records(), agents: [] });
    const provisional = rows.find((trace) => trace.managerAgentId === OLD);
    expect(provisional?.requestId).toBeNull();
    expect(provisional?.requestText).toBe(COMMIT);
    expect(provisional?.requestedAt).toBe("2026-09-16T10:28:40.000Z");
  });

  it("still folds a turn into a request the same Manager names later", () => {
    const sameManager = [
      turn(NEW, "2026-09-17T04:19:29.000Z", MR),
      turn(NEW, "2026-09-17T04:19:31.000Z", `BM-REPORT\nrequestId: ${REQ}\nphase: received`, REQ),
    ];
    const rows = reconstructTraces({ records: sameManager, agents: [] }).filter(
      (trace) => trace.traceId !== "unknown",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.requestId).toBe(REQ);
    expect(rows[0]!.requestText).toBe(MR);
  });
});

/**
 * WP-214 acceptance: state, tier and guardrail must be read from the latest
 * report in TIME, not the one appended last. Reports reach a trace from three
 * passes, so arrival order is not chronological — F-1 read `stopped` and tier
 * `Medium` off an out-of-order report while its real last report was a clean
 * `finished` at tier `Small`.
 */
describe("the latest report is the latest in time", () => {
  it("sorts reports before deciding state and tier", () => {
    const early = record({
      at: "2026-09-16T06:44:09.000Z",
      requestId: "req-A",
      sent: [message("làm giúp tôi việc này")],
      reports: [
        report({
          requestId: "req-A",
          phase: "finished",
          tier: "Medium",
          blockers: "stopped by the user before the bead was created",
          at: "2026-09-16T06:44:09.000Z",
        }),
      ],
    });
    const late = record({
      at: "2026-09-16T07:01:05.000Z",
      requestId: "req-A",
      sent: [message("BM-REPORT\nrequestId: req-A\nphase: finished")],
      reports: [
        report({ requestId: "req-A", phase: "finished", tier: "Small", blockers: null, at: "2026-09-16T07:01:05.000Z" }),
      ],
    });

    // Fed newest-first, so array order and time order disagree.
    const trace = reconstructTraces({ records: [late, early], agents: [] }).find(
      (found) => found.requestId === "req-A",
    );
    expect(trace?.reports.map((r) => r.at)).toEqual([
      "2026-09-16T06:44:09.000Z",
      "2026-09-16T07:01:05.000Z",
    ]);
    expect(trace?.tier).toBe("Small");
    expect(trace?.state).toBe("completed");
  });
});

/**
 * WP-214, D-8's third leg: "the trace reads back intact after the Worker is
 * archived and then deleted".
 *
 * Archiving is safe — `agents.list({ includeArchived: true })` still returns
 * the agent. Deleting is not: the agent list has nothing to match on, so the
 * Worker's records attached to nothing and the row silently lost the work they
 * describe, while their bytes stayed in the store. A record names its own
 * request, which is enough to place it.
 */
describe("a deleted agent's records stay with their request", () => {
  const manager = record({
    at: "2026-09-16T10:00:00.000Z",
    requestId: "req-A",
    sent: [message("làm giúp tôi việc A")],
  });
  const workerTurn = record({
    agentId: "worker-gone",
    role: "worker",
    at: "2026-09-16T10:20:00.000Z",
    requestId: "req-A",
    turnId: "w-1",
    reports: [report({ requestId: "req-A", phase: "finished", tier: "Small", blockers: null, agentId: "worker-gone", at: "2026-09-16T10:19:00.000Z" })],
    evidence: [
      { kind: "shell", detail: "br close bm-a1 -r 'done'", agentId: "worker-gone", at: "2026-09-16T10:18:00.000Z" },
    ],
  });

  it("keeps the records, the report and the evidence when the agent is gone", () => {
    // No agents at all: the Worker was deleted after the work was recorded.
    const trace = reconstructTraces({ records: [manager, workerTurn], agents: [] }).find(
      (found) => found.requestId === "req-A",
    );
    expect(trace?.records).toHaveLength(2);
    expect(trace?.reports).toHaveLength(1);
    expect(trace?.state).toBe("completed");
    expect(trace?.tier).toBe("Small");
  });

  it("says the agent is no longer on this machine instead of pretending", () => {
    const trace = reconstructTraces({ records: [manager, workerTurn], agents: [] }).find(
      (found) => found.requestId === "req-A",
    );
    expect(trace?.agentsMissing).toContain("worker-gone");
    expect(trace?.notices.join(" ")).toContain("no longer on this machine");
  });

  it("does not double-count a record whose agent is still present", () => {
    const worker: AgentFacts = {
      id: "worker-gone",
      role: "worker",
      status: "idle",
      parentAgentId: MANAGER,
      createdAt: "2026-09-16T10:05:00.000Z",
      requestIdLabel: "req-A",
      batchIdLabel: null,
      archived: false,
    };
    const trace = reconstructTraces({ records: [manager, workerTurn], agents: [worker] }).find(
      (found) => found.requestId === "req-A",
    );
    expect(trace?.records).toHaveLength(2);
    expect(trace?.reports).toHaveLength(1);
    expect(trace?.agentsMissing).toEqual([]);
  });

  it("still keeps an archived agent's records, which is the easy half of D-8", () => {
    const archived: AgentFacts = {
      id: "worker-gone",
      role: "worker",
      status: "idle",
      parentAgentId: MANAGER,
      createdAt: "2026-09-16T10:05:00.000Z",
      requestIdLabel: "req-A",
      batchIdLabel: null,
      archived: true,
    };
    const trace = reconstructTraces({ records: [manager, workerTurn], agents: [archived] }).find(
      (found) => found.requestId === "req-A",
    );
    expect(trace?.records).toHaveLength(2);
    expect(trace?.notices.join(" ")).toContain("has been archived");
  });
});

/**
 * WP-214 acceptance: the new worker.md puts suggestions in the finished
 * report, after `none`. Two delivered requests read as "Stopped" until the
 * state rule learned that.
 */
describe("blockers that say nothing is open", () => {
  it.each([
    ["none", false],
    ["none — user chose (a): keep the current docstring, close with no change.", false],
    ["none. Suggestion (not done): move the helper. Suggestion (not done): add a BOM.", false],
    ["Suggestion (not done): add a test file.", false],
    ["STOPPED mid-work by the user before the review call.", true],
    ["Which bead should I use, repo-a or repo-b?", true],
  ])("%s → blocks: %s", (text, expected) => {
    expect(blocksCompletion(text)).toBe(expected);
  });
});

describe("an agent whose request is gone", () => {
  it("goes to the unknown group instead of being time-linked to another request", () => {
    const records = [
      record({ at: "2026-09-16T07:00:00.000Z", requestId: "req-BIG", sent: [message("a large request")] }),
      record({ at: "2026-09-16T09:30:00.000Z", requestId: "req-BIG", sent: [message("BM-REPORT\nrequestId: req-BIG\nphase: finished")] }),
    ];
    const orphan: AgentFacts = {
      id: "worker-of-deleted-trace",
      role: "worker",
      status: "idle",
      parentAgentId: MANAGER,
      // Inside req-BIG's window, which is exactly what used to mislead it.
      createdAt: "2026-09-16T09:17:00.000Z",
      requestIdLabel: "req-DELETED",
      batchIdLabel: null,
      archived: false,
    };
    const built = reconstructTraces({ records, agents: [orphan] });
    expect(built.find((trace) => trace.requestId === "req-BIG")?.workerIds).toEqual([]);
    expect(built.find((trace) => trace.traceId === "unknown")?.workerIds).toEqual(["worker-of-deleted-trace"]);
  });
});

/**
 * WP-214 F-4, the real turn sequence: one user message closed request A and
 * opened request B. The Manager's next report was A's `finished`; B's
 * `received` came one turn later.
 */
describe("a message that closes one request and opens another", () => {
  const turn = (at: string, text: string, requestId: string | null = null) =>
    record({ at, requestId, endedAt: at, turnId: `t-${at}`, sent: [message(text, at)] });

  it("starts the request it opened, not the one it closed", () => {
    const records = [
      turn("2026-09-16T09:16:52.000Z", "add a docstring to total()"),
      turn("2026-09-16T09:17:11.000Z", "BM-REPORT\nrequestId: req-A\nphase: received", "req-A"),
      turn("2026-09-16T09:28:03.000Z", "(a) keep it. New request: export invoices to CSV."),
      turn("2026-09-16T09:28:25.000Z", "BM-REPORT\nrequestId: req-A\nphase: finished", "req-A"),
      turn("2026-09-16T09:29:12.000Z", "BM-REPORT\nrequestId: req-B\nphase: received", "req-B"),
      turn("2026-09-16T09:32:10.000Z", "1a 2a 3a 4a"),
      turn("2026-09-16T09:36:14.000Z", "BM-REPORT\nrequestId: req-B\nphase: finished", "req-B"),
    ];
    const built = reconstructTraces({ records, agents: [] });
    const b = built.find((trace) => trace.requestId === "req-B")!;
    expect(b.requestedAt).toBe("2026-09-16T09:28:03.000Z");
    expect(b.requestText).toContain("export invoices to CSV");
    const a = built.find((trace) => trace.requestId === "req-A")!;
    expect(a.requestText).toBe("add a docstring to total()");
  });
});

/**
 * Owner's workspace (paseo-bm 0.1.0 Manager, no labels on Workers): the
 * Worker's messages named its request only as a bare id, and its six
 * labelled Reviewers followed it into another request.
 */
describe("agents from a 0.1.0 Manager", () => {
  const managerTurn = (at: string, requestId: string, text: string) =>
    record({ at, requestId, endedAt: at, turnId: `m-${at}`, sent: [message(text, at)] });

  const records = [
    managerTurn("2026-09-16T06:22:44.000Z", "req-EARLY", "earlier request"),
    managerTurn("2026-09-16T08:17:49.000Z", "req-20260916T081749Z", "the PAKD bug"),
    record({
      agentId: "w-pakd",
      role: "worker",
      at: "2026-09-16T08:30:21.000Z",
      turnId: "w1",
      sent: [message("TIẾP TỤC LÀM VIỆC — `req-20260916T081749Z`", "2026-09-16T08:30:00.000Z")],
    }),
  ];
  const worker: AgentFacts = {
    id: "w-pakd",
    role: "worker",
    status: "idle",
    parentAgentId: MANAGER,
    // Inside req-EARLY's window as well, which is what misled the time rule.
    createdAt: "2026-09-16T08:19:20.000Z",
    requestIdLabel: null,
    batchIdLabel: null,
    archived: false,
  };
  const reviewer = (id: string, parent: string): AgentFacts => ({
    id,
    role: "reviewer",
    status: "idle",
    parentAgentId: parent,
    createdAt: "2026-09-16T08:36:00.000Z",
    requestIdLabel: "req-20260916T081749Z",
    batchIdLabel: "b1",
    archived: false,
  });

  it("links a Worker by the one request id its messages mention", () => {
    const built = reconstructTraces({ records, agents: [worker] });
    expect(built.find((trace) => trace.requestId === "req-20260916T081749Z")?.workerIds).toEqual(["w-pakd"]);
  });

  it("puts a labelled Reviewer on its labelled request even when its parent sits elsewhere", () => {
    const elsewhere: AgentFacts = { ...worker, id: "w-other", createdAt: "2026-09-16T06:30:00.000Z" };
    const built = reconstructTraces({ records, agents: [elsewhere, reviewer("r1", "w-other")] });
    expect(built.find((trace) => trace.requestId === "req-20260916T081749Z")?.reviewerIds).toEqual(["r1"]);
  });

  it("takes the request named more often than all others together", () => {
    const cited = [
      ...records.slice(0, 2),
      ...["a", "b", "c"].map((turn, index) =>
        record({
          agentId: "w-pakd",
          role: "worker",
          at: `2026-09-16T08:3${index}:21.000Z`,
          turnId: turn,
          sent: [message("TIẾP TỤC — `req-20260916T081749Z`", `2026-09-16T08:3${index}:00.000Z`)],
        }),
      ),
      record({
        agentId: "w-pakd",
        role: "worker",
        at: "2026-09-16T08:40:21.000Z",
        turnId: "d",
        sent: [message("compare with req-20260916T062244Z", "2026-09-16T08:40:00.000Z")],
      }),
    ];
    expect(requestIdOfAgent(worker, cited).requestId).toBe("req-20260916T081749Z");
  });

  it("does not guess when an agent's messages name two requests equally", () => {
    const mixed = [
      ...records.slice(0, 2),
      record({
        agentId: "w-pakd",
        role: "worker",
        at: "2026-09-16T08:30:21.000Z",
        turnId: "w1",
        sent: [message("see req-20260916T081749Z and req-20260916T062244Z", "2026-09-16T08:30:00.000Z")],
      }),
    ];
    expect(requestIdOfAgent(worker, mixed).requestId).toBeNull();
  });
});

/**
 * Delta 20260917e §4.3: the owner asked for each of their follow-up messages to
 * show as its own flow instead of being folded into one row that is hard to
 * trace. A segment opens at a Manager turn the USER opened — `origin: "user"`,
 * which the collector sets only when the timeline item carried a
 * `clientMessageId`.
 */
describe("a request is split into the turns the user opened", () => {
  const REQ = "req-20260917T090000Z";
  const said = (text: string, at: string, origin?: "user" | "agent") => ({
    agentId: MANAGER,
    at,
    text,
    truncated: false,
    ...(origin === undefined ? {} : { origin }),
  });
  const turn = (at: string, message: ReturnType<typeof said>, requestId: string | null = null, phase?: "received" | "finished") =>
    record({
      at,
      endedAt: at,
      requestId,
      turnId: `foreground-turn-${at.slice(14, 16)}`,
      sent: [message],
      reports: phase === undefined ? [] : [report({ requestId: requestId ?? REQ, phase, agentId: MANAGER, at })],
    });

  const conversation = () => [
    turn("2026-09-17T09:00:00.000Z", said("Sửa giúp tôi cái CI đang đỏ", "2026-09-17T09:00:00.000Z", "user"), REQ, "received"),
    // A Worker's status update reaches the Manager as a `user_message` too and
    // is indistinguishable by wording — WP-214 defect 9. It must not open one.
    // Every Manager turn of one request carries its id: the collector reads it
    // from the agent's `bm.requestId` label, not from the message text.
    turn("2026-09-17T09:05:00.000Z", said("Status update: đang chạy test", "2026-09-17T09:05:00.000Z", "agent"), REQ),
    turn("2026-09-17T09:10:00.000Z", said("Tiện thể thêm cả test cho case rỗng", "2026-09-17T09:10:00.000Z", "user"), REQ),
    // A report that lands AFTER the second question: it must not be filed under
    // the first one.
    turn("2026-09-17T09:15:00.000Z", said("Status update: xong", "2026-09-17T09:15:00.000Z", "agent"), REQ, "finished"),
  ];

  const traceOf = (records: TraceRecord[]) =>
    reconstructTraces({ records, agents: [] }).find((t) => t.requestId === REQ);

  it("opens a segment per user message, and never on a Worker's status update", () => {
    const trace = traceOf(conversation());
    expect(trace?.segments.map((s) => s.index)).toEqual([1, 2]);
    expect(trace?.segments.map((s) => s.text)).toEqual([
      "Sửa giúp tôi cái CI đang đỏ",
      "Tiện thể thêm cả test cho case rỗng",
    ]);
    expect(trace?.segments[1]?.startedAt).toBe("2026-09-17T09:10:00.000Z");
  });

  it("keeps the Worker's status update inside the segment it arrived in", () => {
    const segments = traceOf(conversation())?.segments ?? [];
    const texts = segments[0]!.records.flatMap((r) => r.sent.map((m) => m.text));
    expect(texts).toContain("Status update: đang chạy test");
    expect(segments[1]!.records.flatMap((r) => r.sent.map((m) => m.text))).not.toContain(
      "Status update: đang chạy test",
    );
  });

  it("gives a report to the segment that was open when it arrived", () => {
    const segments = traceOf(conversation())?.segments ?? [];
    expect(segments[0]!.reports.map((r) => r.phase)).toEqual(["received"]);
    // The `finished` report arrived at 09:15, after the second question, so it
    // belongs to segment 2 — filing every report under segment 1 must go red.
    expect(segments[1]!.reports.map((r) => r.phase)).toEqual(["finished"]);
  });

  /**
   * Owner decision Q23: only the Dashboard splits. The review budget stays a
   * per-`requestId` count — reset it per segment and a user who asks three
   * follow-ups would silently get three times the reviews the tier allows.
   */
  it("still counts review calls for the whole request, not per segment", () => {
    const trace = traceOf(conversation());
    expect(trace?.requestId).toBe(REQ);
    expect(trace?.segments.length).toBeGreaterThan(1);
    // One request id, one trace, one place the budget is counted.
    expect(reconstructTraces({ records: conversation(), agents: [] }).filter((t) => t.requestId === REQ)).toHaveLength(1);
  });

  it("leaves a request written before `origin` existed as exactly one segment", () => {
    // No `origin` anywhere: the collector predates the field. Absence is not
    // "user" (AGENTS.md), so nothing opens a second segment.
    const old = [
      turn("2026-09-17T09:00:00.000Z", said("Sửa giúp tôi cái CI đang đỏ", "2026-09-17T09:00:00.000Z"), REQ, "received"),
      turn("2026-09-17T09:10:00.000Z", said("Tiện thể thêm cả test", "2026-09-17T09:10:00.000Z"), REQ),
    ];
    const trace = traceOf(old);
    expect(trace?.segments).toHaveLength(1);
    expect(trace?.segments[0]?.records).toHaveLength(2);
  });

  it("never lets a plugin notice open a segment", () => {
    const withNotice = [
      ...conversation(),
      turn("2026-09-17T09:20:00.000Z", said(`${BUDGET_NOTICE_MARKER} requestId: ${REQ}`, "2026-09-17T09:20:00.000Z", "user"), REQ),
    ];
    // Even marked `user`, a notice is the plugin talking, not a person.
    expect(traceOf(withNotice)?.segments).toHaveLength(2);
  });

  it("covers every record, so nothing is lost by splitting", () => {
    const trace = traceOf(conversation());
    const inSegments = (trace?.segments ?? []).reduce((n, s) => n + s.records.length, 0);
    expect(inSegments).toBe(trace?.records.length);
  });
});
