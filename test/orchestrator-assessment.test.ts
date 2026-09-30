import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSESSMENT_MAX_CHARS,
  TRUNCATED_MARKER,
  approxTokensOf,
  assessmentPartsOf,
  assessmentTargetOf,
  buildAssessmentContent,
  capParts,
  cutText,
  renderParts,
} from "../plugin/server/assessment";
import { REDACTED } from "../plugin/server/collector";
import { handleTracesGet, type DashboardPaseo } from "../plugin/server/dashboard-rpc";
import type { OrchestratorRpcDeps } from "../plugin/server/orchestrator-rpc";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { AgentFacts } from "../plugin/server/traces";
import type { Flag } from "../plugin/shared/orchestrator-rules";
import {
  DASHBOARD_ERROR_CODES,
  DashboardError,
  type TraceDetail,
  type TraceMessage,
  type TraceRecord,
} from "../plugin/shared/contracts";
import { WORKSPACE_DIRECTORY, WORKSPACE_ID, clean, smallWithBead } from "./fixtures/orchestrator-traces";

/**
 * The assessment content (Orchestrator design §5.2), kept from the first
 * design, and where the assessment agent runs (`assessmentTargetOf`, §3.3).
 * The content tests build a `TraceDetail` by hand or read one through a
 * temporary trace store named by `PASEO_BM_HOME` and a fake Paseo SDK — never
 * the real HOME or a daemon.
 */

const usage = {
  inputTokens: 1000,
  cachedInputTokens: 200,
  outputTokens: 300,
  costUsd: 0.01,
  costBasis: "estimated" as const,
  model: "claude-opus-5",
  pricesUpdatedAt: "2026-06-24",
};

const message = (text: string, agentId: string | null = "agent-manager"): TraceMessage => ({
  agentId,
  at: "2026-09-26T10:00:20.000Z",
  text,
  truncated: false,
});

function detailWith(overrides: Partial<TraceDetail> = {}): TraceDetail {
  return {
    traceId: "req:req-1",
    requestId: "req-1",
    requestedAt: "2026-09-26T10:00:20.000Z",
    excerpt: "Add an export button",
    turn: null,
    state: "completed",
    workerIds: ["agent-worker"],
    reviewerIds: [],
    reviewCalls: 0,
    guardrailReported: null,
    durationMs: 360_000,
    usage,
    messageCount: 4,
    userMessageCount: 0,
    workerUsage: [],
    beadCounts: {
      created: { count: 0, confidence: "exact" },
      updated: { count: 0, confidence: "exact" },
      closed: { count: 0, confidence: "exact" },
      ready: { count: 0, confidence: "exact" },
    },
    tier: "Small",
    linking: "exact",
    agentsMissing: [],
    workspaceState: "live",
    reassignedFrom: null,
    notices: [],
    sent: { userRequest: message("Add an export button", null), workerInitialPrompts: [], reviewRequests: [] },
    received: { reports: [], reviews: [], managerReplies: [] },
    timing: { totalMs: 360_000, managerTurns: [], workers: [], reviewers: [], basis: "wall clock" },
    usageByAgent: [],
    beads: [],
    workflowSteps: [],
    subAgentTraces: [],
    userMessages: [],
    skills: [],
    ...overrides,
  };
}

const FLAG: Flag = {
  rule: "process.small-heavy",
  severity: "warning",
  state: "raised",
  observed: "A Small request created a bead.",
  why: "A Small request needs no bead.",
  evidence: [{ agentId: "agent-worker", at: "2026-09-26T10:01:30.000Z", kind: "evidence", excerpt: "br create x" }],
};

describe("buildAssessmentContent", () => {
  it("carries every part of design §5.2, the flags included", () => {
    const content = buildAssessmentContent(
      detailWith({
        sent: {
          userRequest: message("Add an export button", null),
          workerInitialPrompts: [message("Request req-1: Add an export button", "agent-worker")],
          reviewRequests: [{ ...message("Review batch b1", "agent-reviewer"), batchId: "b1" }],
        },
        received: {
          reports: [
            {
              agentId: "agent-worker",
              at: "2026-09-26T10:06:00.000Z",
              requestId: "req-1",
              phase: "finished",
              tier: "Small",
              filesChanged: ["src/export.ts"],
              beadsCreated: [],
              beadsUpdated: [],
              beadsClosed: [],
              beadsReady: [],
              reviewFindingsOpen: null,
              buildAndTests: "npm test: 7 passed",
              skillsUsed: [],
              blockers: null,
              guardrail: null,
              unparsedFields: [],
              incompleteFields: [],
            },
          ],
          reviews: [{ agentId: "agent-reviewer", at: "2026-09-26T10:05:00.000Z", batchId: "b1", verdict: "approved", blockingCount: 0 }],
          managerReplies: [message("Done: the export button is there.")],
        },
        userMessages: [message("Please keep the date format", "agent-worker")],
        workflowSteps: [{ step: "classify_tier", status: "done", confidence: "exact", evidence: [], note: null }],
      }),
      [FLAG],
      { env: {} },
    );

    for (const expected of [
      "Add an export button",
      "## Size\nSmall",
      "Request req-1: Add an export button",
      "### finished · agent-worker",
      "build and tests: npm test: 7 passed",
      "Review batch b1",
      "verdict: approved",
      "Done: the export button is there.",
      "Please keep the date format",
      "- classify_tier: done (exact)",
      "review calls: 0",
      "### process.small-heavy · warning · raised",
      "observed: A Small request created a bead.",
    ]) {
      expect(content.text).toContain(expected);
    }
    expect(content.truncated).toBe(false);
  });

  it("masks a secret in a message: a password flag's value and a secret environment value", () => {
    const secret = "hunter2-very-secret";
    const detail = detailWith({
      sent: {
        userRequest: message(`Log in with paseo --password ${secret} and check`, null),
        workerInitialPrompts: [],
        reviewRequests: [],
      },
      received: { reports: [], reviews: [], managerReplies: [message("The daemon password is s3cr3t-daemon-value")] },
    });

    const content = buildAssessmentContent(detail, [], { env: { PASEO_DAEMON_PASSWORD: "s3cr3t-daemon-value" } });

    expect(content.text).not.toContain(secret);
    expect(content.text).not.toContain("s3cr3t-daemon-value");
    expect(content.text).toContain(`--password ${REDACTED}`);
    expect(content.text).toContain(`The daemon password is ${REDACTED}`);
  });

  it("stays whole under the cap, and estimates tokens as ceil(chars / 4)", () => {
    const content = buildAssessmentContent(detailWith(), [], { env: {} });
    expect(content.truncated).toBe(false);
    expect(content.text).not.toContain(TRUNCATED_MARKER);
    expect(content.chars).toBe(Array.from(content.text).length);
    expect(content.approxTokens).toBe(Math.ceil(content.chars / 4));
    expect(approxTokensOf(0)).toBe(0);
    expect(approxTokensOf(1)).toBe(1);
    expect(approxTokensOf(4)).toBe(1);
    expect(approxTokensOf(60_001)).toBe(15_001);
  });

  it("puts a note above the content only when something was cut, and holds the cap for both (autonomy design §A.9)", () => {
    const note = "Bounded: call again with detail full.";
    const whole = buildAssessmentContent(detailWith(), [], { env: {}, maxChars: 4_000, noteWhenCut: note });
    expect(whole.truncated).toBe(false);
    expect(whole.text).not.toContain(note);

    const detail = detailWith({
      received: { reports: [], reviews: [], managerReplies: [message(`START ${"b".repeat(9_000)} END`)] },
    });
    const cut = buildAssessmentContent(detail, [], { env: {}, maxChars: 4_000, noteWhenCut: note });
    expect(cut.truncated).toBe(true);
    expect(cut.text.split("\n")[0]).toBe(note);
    expect(cut.chars).toBeLessThanOrEqual(4_000);
    expect(cut.text).toContain(TRUNCATED_MARKER);
    expect(cut.text).toContain("START");
    expect(cut.text).toContain("END");
  });

  it("cuts above 60,000 characters from the longest messages first, keeping each one's start and end", () => {
    const long = `START-OF-LONG ${"a".repeat(80_000)} END-OF-LONG`;
    const medium = `START-OF-MEDIUM ${"b".repeat(9_000)} END-OF-MEDIUM`;
    const short = "A short reply that must survive whole.";
    const detail = detailWith({
      sent: { userRequest: message(long, null), workerInitialPrompts: [message(medium, "agent-worker")], reviewRequests: [] },
      received: { reports: [], reviews: [], managerReplies: [message(short)] },
    });

    const content = buildAssessmentContent(detail, [FLAG], { env: {} });

    expect(content.truncated).toBe(true);
    expect(content.chars).toBeLessThanOrEqual(ASSESSMENT_MAX_CHARS);
    // Only the longest message had to give way: the others are whole.
    expect(content.text.split(TRUNCATED_MARKER)).toHaveLength(2);
    expect(content.text).toContain(medium);
    expect(content.text).toContain(short);
    expect(content.text).toContain("observed: A Small request created a bead.");
    // The long one keeps its start and its end around the marker.
    expect(content.text).toMatch(/START-OF-LONG a+\n\.\.\.\[truncated\]\na+ END-OF-LONG/);
    // Cut exactly to the cap: nothing more was thrown away than needed.
    expect(content.chars).toBe(ASSESSMENT_MAX_CHARS);
    expect(content.approxTokens).toBe(ASSESSMENT_MAX_CHARS / 4);
  });

  it("cuts two long messages to the same length once the longest alone is not enough", () => {
    const parts = [
      { title: "# a", text: "x".repeat(900) },
      { title: "# b", text: "y".repeat(700) },
      { title: "# c", text: "z".repeat(100) },
    ];
    const capped = capParts(parts, 1_000);
    const text = renderParts(capped.parts);

    expect(capped.truncated).toBe(true);
    expect(Array.from(text).length).toBe(1_000);
    const [a, b, c] = capped.parts.map((part) => part.text.length);
    expect(a).toBe(b);
    expect(c).toBe(100);
    expect(capped.parts[2]!.text).toBe(parts[2]!.text);
  });

  it("still holds the cap when even the headings alone are too long", () => {
    const parts = Array.from({ length: 50 }, (_, index) => ({ title: `# heading number ${index}`, text: "w".repeat(100) }));
    const content = capParts(parts, 200);
    expect(content.truncated).toBe(true);
    expect(content.single).not.toBeNull();
    expect(Array.from(content.single!).length).toBeLessThanOrEqual(200);
    expect(content.single).toContain(TRUNCATED_MARKER);
  });

  it("never splits a character outside the basic plane", () => {
    const cut = cutText("😀".repeat(100), 40);
    expect(Array.from(cut).length).toBe(40);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cutText("short", 40)).toBe("short");
  });

  it("orders the parts as design §5.2 lists them", () => {
    const titles = assessmentPartsOf(detailWith(), [FLAG]).map((part) => part.title);
    const order = [
      "# The request to assess",
      "## The request, verbatim",
      "## Size",
      "## The Worker's initial prompt",
      "## BM-REPORTs by milestone",
      "## Review requests",
      "## BM-REVIEWs",
      "## The Manager's replies to the user",
      "## The user's messages",
      "## Feature-workflow steps",
      "## Time, tokens and review calls",
      "## Flags the plugin's rules already raised",
    ].map((title) => titles.indexOf(title));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});

// ---------------------------------------------------------------------------
// A stored request's content, and the target
// ---------------------------------------------------------------------------

let root: string;
let home: string;
let deps: OrchestratorRpcDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-assess-"));
  home = join(root, "data");
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root };
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

const location = () => ({ tracesDir: join(home, "traces") });

function snapshotOf(facts: AgentFacts): Record<string, unknown> {
  const labels: Record<string, string> = { "bm.role": facts.role };
  if (facts.parentAgentId !== null) labels["paseo.parent-agent-id"] = facts.parentAgentId;
  if (facts.requestIdLabel !== null) labels["bm.requestId"] = facts.requestIdLabel;
  if (facts.batchIdLabel !== null) labels["bm.batchId"] = facts.batchIdLabel;
  return {
    id: facts.id,
    provider: `bm-${facts.role}`,
    status: facts.status,
    workspaceId: WORKSPACE_ID,
    labels,
    ...(facts.createdAt === null ? {} : { createdAt: facts.createdAt }),
  };
}

interface FakeOptions {
  /** The Paseo configuration `config.get()` returns. */
  config?: Record<string, unknown>;
  /** What `providers.listAvailable()` reports; `null` = the host cannot say. */
  available?: string[] | null;
}

const CONFIGURED = {
  providers: { "bm-orchestrator": { extends: "codex", label: "Beads Orchestrator" } },
  agentProfiles: [{ id: "bm-orchestrator", name: "Beads Orchestrator", provider: "bm-orchestrator", model: "gpt-5.6-sol" }],
};

/** A fake SDK: the agents of the fixture, an empty live timeline, and the configuration asked for. */
function fakePaseo(agents: readonly AgentFacts[], options: FakeOptions = {}) {
  const create = vi.fn();
  const send = vi.fn();
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((facts) => ({ agent: snapshotOf(facts) })) })),
      ref: vi.fn(() => ({ timeline: { refetch: vi.fn(async () => ({ entries: [] })) }, send })),
      create,
    },
    workspaces: { list: vi.fn(async () => ({ entries: [{ id: WORKSPACE_ID, directory: WORKSPACE_DIRECTORY }] })) },
    config: { get: vi.fn(async () => ({ config: options.config ?? CONFIGURED })) },
    providers: {
      listAvailable: vi.fn(async () => {
        if (options.available === null) throw new Error("cannot say");
        return { providers: (options.available ?? ["claude", "codex"]).map((provider) => ({ provider, available: true })) };
      }),
    },
  };
  return { paseo: paseo as unknown as DashboardPaseo, create, send };
}

async function store(records: readonly TraceRecord[]): Promise<void> {
  for (const record of records) await appendRecord(location(), record);
}

function codeOf(error: unknown): string | null {
  return error instanceof DashboardError ? error.code : null;
}

/** The content of one stored request, built from its `traces.get` detail with no flags. */
async function storedContent(traceId: string, paseo: DashboardPaseo) {
  const { trace } = await handleTracesGet({ workspaceId: WORKSPACE_ID, traceId }, paseo, deps);
  return buildAssessmentContent(trace, []);
}

describe("the content of a stored request", () => {
  it("masks a secret the trace store holds before counting it", async () => {
    const fixture = clean();
    const secret = "tok-123-very-secret";
    const records = fixture.records.map((record) => ({
      ...record,
      sent: record.sent.map((sent) => (sent.origin === "user" ? { ...sent, text: `${sent.text} Use --token ${secret}` } : sent)),
    }));
    await store(records);
    const { paseo, create, send } = fakePaseo(fixture.agents);

    const content = await storedContent(fixture.input.traceId, paseo);

    expect(content.text).not.toContain(secret);
    expect(content.text).toContain(`--token ${REDACTED}`);
    expect(content.approxTokens).toBe(Math.ceil(content.chars / 4));
    expect(create).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("says truncated when the request is above the cap", async () => {
    const fixture = clean();
    // The store keeps a message under 8 KiB and a record under 32 KiB, so it
    // takes long replies in each of the Manager's three turns.
    const replies = (record: TraceRecord) =>
      Array.from({ length: 4 }, (_, index) => ({
        agentId: record.agentId,
        at: record.endedAt,
        text: `reply ${index} ${"long reply ".repeat(600)}`,
        truncated: false,
      }));
    const records = fixture.records.map((record) =>
      record.role === "manager" ? { ...record, received: [...record.received, ...replies(record)] } : record,
    );
    await store(records);
    const { paseo } = fakePaseo(fixture.agents);

    const content = await storedContent(fixture.input.traceId, paseo);

    expect(content.truncated).toBe(true);
    expect(content.chars).toBeLessThanOrEqual(ASSESSMENT_MAX_CHARS);
  });

  it("reads a request with flags the same way as without, the flags added last", async () => {
    const fixture = smallWithBead();
    await store(fixture.records);
    const { paseo } = fakePaseo(fixture.agents);
    const { trace } = await handleTracesGet({ workspaceId: WORKSPACE_ID, traceId: fixture.input.traceId }, paseo, deps);

    expect(buildAssessmentContent(trace, [FLAG]).text).toContain("process.small-heavy · warning · raised");
  });
});

describe("assessmentTargetOf", () => {
  it("returns the profile's provider and model, and creates nothing", async () => {
    const { paseo, create } = fakePaseo([]);

    await expect(assessmentTargetOf(paseo)).resolves.toMatchObject({ provider: "codex", model: "gpt-5.6-sol" });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["there is no bm-orchestrator profile", { config: { providers: CONFIGURED.providers, agentProfiles: [] } }],
    ["the alias names no provider it extends", { config: { providers: {}, agentProfiles: CONFIGURED.agentProfiles } }],
    ["the provider is not available", { available: ["claude"] }],
    ["Paseo cannot say which providers are available", { available: null }],
  ] as Array<[string, FakeOptions]>)("fails E_ORCHESTRATOR_UNAVAILABLE when %s, and creates nothing", async (_case, options) => {
    const { paseo, create } = fakePaseo([], options);

    const error = await assessmentTargetOf(paseo).catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe("E_ORCHESTRATOR_UNAVAILABLE");
    expect(String(error)).toMatch(/E_ORCHESTRATOR_UNAVAILABLE: /);
    expect(create).not.toHaveBeenCalled();
    expect(DASHBOARD_ERROR_CODES).toContain("E_ORCHESTRATOR_UNAVAILABLE");
  });
});
