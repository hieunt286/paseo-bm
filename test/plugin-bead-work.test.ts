import { describe, expect, it } from "vitest";
import { beadWorkOf, namesBead } from "../plugin/server/bead-work";
import type { AgentFacts } from "../plugin/server/traces";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * Who is working on an in-progress bead, read from Worker commands and
 * reports. The cases are the shapes seen on the owner's workspace.
 */

function record(overrides: Partial<TraceRecord>): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: "wks_1",
    agentId: "w1",
    role: "worker",
    turnId: "t1",
    requestId: "req-A",
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

const shell = (detail: string, at: string, agentId = "w1") => ({ kind: "shell" as const, detail, agentId, at });

const agents = new Map<string, AgentFacts>([
  ["w1", { id: "w1", role: "worker", status: "running", parentAgentId: null, createdAt: null, requestIdLabel: null, batchIdLabel: null, archived: false, title: "Contact dialog spacing" }],
]);

describe("naming a bead", () => {
  it("matches a whole id only", () => {
    expect(namesBead("br update cus-u9zv.1 --status=in_progress", "cus-u9zv.1")).toBe(true);
    expect(namesBead("br show cus-u9zv.12 --json", "cus-u9zv.1")).toBe(false);
    expect(namesBead("br show cus-u9zv.1.2", "cus-u9zv.1")).toBe(false);
    expect(namesBead("closed cus-u9zv.1.", "cus-u9zv.1")).toBe(true);
  });
});

describe("who works on a bead", () => {
  it("takes the start from the command that set in_progress, and the last activity from any later mention", () => {
    const work = beadWorkOf(
      ["cus-a"],
      [
        record({ evidence: [shell("br update cus-a --status=in_progress >/dev/null 2>&1; python3 - <<'PY'", "2026-09-16T09:25:40.000Z")] }),
        record({ turnId: "t2", evidence: [shell("br show cus-a --json > /tmp/r.json", "2026-09-16T10:14:11.000Z")] }),
      ],
      agents,
    ).get("cus-a");
    expect(work).toEqual({
      started: { agentId: "w1", at: "2026-09-16T09:25:40.000Z", title: "Contact dialog spacing", status: "running" },
      last: { agentId: "w1", at: "2026-09-16T10:14:11.000Z", title: "Contact dialog spacing", status: "running" },
    });
  });

  it("says nothing about the start when no command set the status", () => {
    const work = beadWorkOf(["cus-b"], [record({ evidence: [shell("br show cus-b --json", "2026-09-16T10:11:20.000Z")] })], agents);
    expect(work.get("cus-b")?.started).toBeNull();
    expect(work.get("cus-b")?.last?.agentId).toBe("w1");
  });

  it("counts a report that names the bead, and marks an agent Paseo no longer lists", () => {
    const work = beadWorkOf(
      ["cus-c"],
      [
        record({
          agentId: "w-gone",
          reports: [
            {
              agentId: "w-gone", at: "2026-09-16T11:00:00.000Z", requestId: "req-A", phase: "bead-implemented", tier: null,
              filesChanged: [], beadsCreated: [], beadsUpdated: ["cus-c"], beadsClosed: [], beadsReady: [],
              reviewFindingsOpen: null, buildAndTests: null, blockers: null, guardrail: null, unparsedFields: [], incompleteFields: [], skillsUsed: [],
            },
          ],
        }),
      ],
      agents,
    );
    expect(work.get("cus-c")?.last).toEqual({ agentId: "w-gone", at: "2026-09-16T11:00:00.000Z", title: null, status: null });
  });

  it("ignores Reviewers and Managers, help pages, and beads nobody touched", () => {
    const work = beadWorkOf(
      ["cus-d", "cus-e"],
      [
        record({ role: "reviewer", agentId: "r1", evidence: [shell("br show cus-d", "2026-09-16T10:00:00.000Z", "r1")] }),
        record({ role: "manager", agentId: "m1", evidence: [shell("br update cus-d --status in_progress", "2026-09-16T10:00:00.000Z", "m1")] }),
        record({ evidence: [shell("br update --help", "2026-09-16T10:00:00.000Z")] }),
      ],
      agents,
    );
    expect(work.size).toBe(0);
  });
});
