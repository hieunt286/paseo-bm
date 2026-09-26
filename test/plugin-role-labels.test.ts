import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGER_INSTRUCTIONS } from "../plugin/server/manager-instructions";
import { WORKER_INSTRUCTIONS } from "../plugin/server/worker-instructions";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { reconstructTraces, type AgentFacts } from "../plugin/server/traces";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-212: the `bm.requestId` / `bm.batchId` labels in the role instructions.
 *
 * The labels are a fast path, not a requirement: an agent created by an older
 * payload has none, and the Dashboard must still group it — just at `inferred`
 * confidence. Both fixtures are asserted here so a future change cannot quietly
 * make the labels mandatory.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const managerMd = readFileSync(join(repoRoot, "plugin", "roles", "manager.md"), "utf8");
const workerMd = readFileSync(join(repoRoot, "plugin", "roles", "worker.md"), "utf8");

describe("manager.md", () => {
  it("tells the Manager to label the Worker with bm.requestId in the approved format", () => {
    expect(managerMd).toContain("`bm.requestId`");
    expect(managerMd).toContain("`req-` + current UTC time");
    expect(managerMd).toContain("`bm.requestId` = the `requestId`");
  });

  it("still asks for bm.role and bm.version", () => {
    expect(managerMd).toContain("`bm.role` = `worker`");
    expect(managerMd).toContain("`bm.version`");
  });
});

describe("worker.md", () => {
  it("tells the Worker to label the Reviewer with bm.requestId and bm.batchId", () => {
    expect(workerMd).toContain("`bm.requestId`");
    expect(workerMd).toContain("`bm.batchId`");
    expect(workerMd).toContain("`bm.batchId` = the batch id");
  });

  it("still asks for bm.role and bm.version", () => {
    expect(workerMd).toContain("`bm.role` = `reviewer`");
    expect(workerMd).toContain("`bm.version`");
  });
});

describe("English only (REQ-032a)", () => {
  it.each([
    ["manager.md", managerMd],
    ["worker.md", workerMd],
  ])("%s prose is English; Vietnamese only appears inside code spans", (_name, source) => {
    // Same rule the existing role-content tests use: the sample user requests
    // are Vietnamese on purpose and are quoted as code, so code spans are
    // stripped before checking the prose.
    const prose = source.replace(/`[^`\n]*`/g, "");
    expect(prose).not.toMatch(
      /[ăâêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i,
    );
  });
});

describe("embedded copies", () => {
  it.each([
    ["manager", managerMd, MANAGER_INSTRUCTIONS],
    ["worker", workerMd, WORKER_INSTRUCTIONS],
  ])("%s instructions embedded in the bundle match the source file byte for byte", (_name, source, embedded) => {
    expect(embedded).toBe(source);
  });

  it("carries the bumped payload version", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
    expect(PLUGIN_VERSION).toBe(manifest.version);
    // The minor moves with each feature wave: phase 2a was 0.2.x, delta
    // 20260921 moved it to 0.3.x, and ADR-012 — the plugin becoming the whole
    // product, with the npx installer retired — moved it to 0.4.x.
    expect(PLUGIN_VERSION.startsWith("0.4.")).toBe(true);
  });
});

describe("labels are a fast path, not a requirement", () => {
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
      sent: [{ agentId: MANAGER, at: "2026-09-16T10:00:00.000Z", text: "a request", truncated: false }],
      received: [],
      reports: [],
      reviews: [],
      evidence: [],
      usage: null,
      ...overrides,
    };
  }

  function agent(overrides: Partial<AgentFacts> & { id: string }): AgentFacts {
    return {
      role: "worker",
      status: "idle",
      parentAgentId: MANAGER,
      createdAt: "2026-09-16T10:00:30.000Z",
      requestIdLabel: null,
      batchIdLabel: null,
      archived: false,
      ...overrides,
    };
  }

  it("a labelled agent gives linking: exact", () => {
    const traces = reconstructTraces({
      records: [record({ requestId: "req-A" })],
      agents: [agent({ id: "w1", requestIdLabel: "req-A" })],
    });
    expect(traces[0]).toMatchObject({ workerIds: ["w1"], linking: "exact" });
  });

  it("an agent from the older payload, with no labels, still groups at inferred", () => {
    const traces = reconstructTraces({
      records: [record()],
      agents: [agent({ id: "w-old" })],
    });
    expect(traces[0]).toMatchObject({ workerIds: ["w-old"], linking: "inferred" });
    expect(traces[0]?.notices.join(" ")).toContain("linked by time");
  });
});
