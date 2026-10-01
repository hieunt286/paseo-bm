import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInsightsSummary, insightsSummaryOf, insightsWindowOf, registerInsightsRpcs, type InsightsRpcDeps } from "../plugin/server/insights-rpc";
import { insightsSummaryRpc, type TraceRecord } from "../plugin/shared/contracts";
import { computeEvalMetrics } from "../plugin/shared/eval-metrics";
import { MANAGER, REVIEWER, WORKER, msg, report, turn } from "./fixtures/orchestrator-traces";

/**
 * `insights.summary` (autonomy design §A.12) against a temporary data folder
 * named by `PASEO_BM_HOME`, never the real HOME: its numbers are the metric
 * module's over the same records, it narrows to one workspace, it carries no
 * text, and it leaves every file as it found it.
 */

const NOW = new Date("2026-09-27T00:00:00.000Z");
const WS_A = "wks_alpha";
const WS_B = "wks_beta";
const R1 = "req-20260926T100000Z";
const R2 = "req-20260910T090000Z";
const SECRET_QUESTION = "Which export format should the invoice use?";
const SECRET_LABEL = "alpha private project";
const SECRET_DIRECTORY = "/work/private-alpha";

const usage = (tokens: number) => ({
  inputTokens: tokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  costBasis: "unavailable" as const,
  model: null,
  pricesUpdatedAt: null,
});

/** One request: asked a question, the owner answered, a Reviewer looked, it finished. */
function request(workspaceId: string, requestId: string, day: string): TraceRecord[] {
  const when = (minute: number) => `${day}T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const base = { workspaceId, requestId };
  return [
    turn({ ...base, at: when(1), turnId: `m-1-${requestId}`, startedAt: when(0), endedAt: when(1), usage: usage(1000), sent: [msg(MANAGER, when(0), "Please export invoices", "user")] }),
    turn({
      ...base,
      at: when(5),
      turnId: `m-2-${requestId}`,
      startedAt: when(5),
      endedAt: when(5),
      usage: usage(500),
      sent: [msg(MANAGER, when(5), `BM-REPORT\nrequestId: ${requestId}\nphase: blocked\ntier: Medium\n\nBM-QUESTIONS\nrequestId: ${requestId}\nQ1: ${SECRET_QUESTION}\n- a: PDF (recommended)\n- b: CSV`, "agent")],
    }),
    turn({
      ...base,
      agentId: WORKER,
      role: "worker",
      at: when(12),
      turnId: `w-1-${requestId}`,
      startedAt: when(10),
      endedAt: when(12),
      usage: usage(8000),
      sent: [msg(WORKER, when(10), `BM-ANSWERS\nrequestId: ${requestId}\nQ1: a — PDF`, "user")],
    }),
    turn({ ...base, agentId: REVIEWER, role: "reviewer", at: when(14), turnId: `r-1-${requestId}`, startedAt: when(13), endedAt: when(14), usage: usage(2000), outcome: "failed" }),
    turn({
      ...base,
      at: when(20),
      turnId: `m-3-${requestId}`,
      startedAt: when(20),
      endedAt: when(20),
      usage: usage(500),
      sent: [msg(MANAGER, when(20), `BM-REPORT\nrequestId: ${requestId}\nphase: finished\ntier: Medium`, "agent")],
      reports: [report({ at: when(20), requestId, phase: "finished", tier: "Medium" })],
    }),
  ];
}

const ALPHA = request(WS_A, R1, "2026-09-26");
const BETA = request(WS_B, R2, "2026-09-10");

let root: string;
let home: string;
let deps: InsightsRpcDeps;

/** Every path under a folder with its mtime and bytes, directories included. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    out[at] = `dir ${statSync(at).mtimeMs}`;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = `${statSync(path).mtimeMs} ${readFileSync(path, "utf8")}`;
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-insights-rpc-"));
  home = join(root, "data");
  const alpha = join(home, "traces", WS_A);
  const beta = join(home, "traces", WS_B);
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  const lines = (records: TraceRecord[]) => records.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(join(alpha, "meta.json"), JSON.stringify({ lastKnownName: SECRET_LABEL, lastKnownDirectory: SECRET_DIRECTORY, lastSeenAt: "2026-09-26T10:30:00.000Z" }));
  // One line that is not JSON: skipped and counted.
  writeFileSync(join(alpha, "events-202609.jsonl"), `${lines(ALPHA)}\n{not json\n`);
  writeFileSync(join(beta, "events-202609.jsonl"), `${lines(BETA)}\n`);
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: () => undefined };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("insights.summary", () => {
  it("returns the metric module's numbers over the data folder, for every workspace", () => {
    const out = handleInsightsSummary({ window: "all" }, deps);
    expect(insightsSummaryRpc.output.parse(out)).toEqual(out);
    const expected = computeEvalMetrics({ records: [...ALPHA, ...BETA], window: { since: null, until: null } });
    expect(out).toEqual(insightsSummaryOf("all", expected, { malformedLines: 1, unreadableFiles: 0 }));
    // Spot checks, so the comparison above cannot pass on two empty sets.
    expect(out.available).toBe(true);
    expect(out.requests).toEqual({ inWindow: 2, finished: 2 });
    expect(out.questions).toMatchObject({ asked: 2, reachedOwner: 2, perFinishedRequest: { asked: 1, reachedOwner: 1, answeredByAgents: 0 } });
    expect(out.tokens.perFinishedRequest).toEqual({ total: 12_000, byRole: { manager: 2000, worker: 8000, reviewer: 2000, orchestrator: 0, unknown: 0 } });
    expect(out.errors.failedTurns.total).toBe(2);
    expect(out.requestsByDay).toEqual([
      { day: "2026-09-10", requests: 1 },
      { day: "2026-09-26", requests: 1 },
    ]);
    expect(out.timeToFinished.requests).toBe(2);
    expect(out.ownerWait.questions).toBe(2);
    expect(out.unknowns.malformedLines).toBe(1);
  });

  it("takes the window back from now, open at the end", () => {
    expect(insightsWindowOf("7d", NOW)).toEqual({ since: "2026-09-20T00:00:00.000Z", until: null });
    expect(insightsWindowOf("all", NOW)).toEqual({ since: null, until: null });
    const out = handleInsightsSummary({ window: "7d" }, deps);
    expect(out.window).toEqual({ key: "7d", since: "2026-09-20T00:00:00.000Z", until: null });
    expect(out.requests.inWindow).toBe(1);
    expect(out).toEqual(
      insightsSummaryOf("7d", computeEvalMetrics({ records: [...ALPHA, ...BETA], window: insightsWindowOf("7d", NOW) }), { malformedLines: 1, unreadableFiles: 0 }),
    );
  });

  it("narrows to one workspace", () => {
    const out = handleInsightsSummary({ window: "all", workspaceId: WS_B }, deps);
    expect(out).toEqual(insightsSummaryOf("all", computeEvalMetrics({ records: BETA, window: { since: null, until: null } }), { malformedLines: 1, unreadableFiles: 0 }));
    expect(out.requestsByDay).toEqual([{ day: "2026-09-10", requests: 1 }]);
  });

  it("carries numbers only: no message text, no label, no path; a heaviest request's workspace is the one id", () => {
    const out = handleInsightsSummary({ window: "all" }, deps);
    const text = JSON.stringify(out);
    for (const secret of [SECRET_QUESTION, SECRET_LABEL, SECRET_DIRECTORY, "Please export", home, R1, R2, WORKER, MANAGER]) expect(text).not.toContain(secret);
    const heaviest = out.context?.tokensRead.heaviestRequests ?? [];
    expect(heaviest.map((row) => Object.keys(row))).toEqual([
      ["workspaceId", "tokensRead", "byRole", "turns", "finished"],
      ["workspaceId", "tokensRead", "byRole", "turns", "finished"],
    ]);
    const withoutHeaviest = JSON.stringify({ ...out, context: { ...out.context, tokensRead: { ...out.context?.tokensRead, heaviestRequests: [] } } });
    for (const id of [WS_A, WS_B]) expect(withoutHeaviest).not.toContain(id);
  });

  it("carries the context and token figures (autonomy design §G.2), and the Orchestrator's tokens from its wakes", () => {
    mkdirSync(join(home, "orchestrator"), { recursive: true });
    writeFileSync(
      join(home, "orchestrator", "wakes.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { orchestratorId: "agent-orchestrator", at: "2026-09-26T10:30:00.000Z", endedAt: "2026-09-26T10:31:00.000Z", workspaceIds: [WS_A], events: 1, usage: { inputTokens: 100, cachedInputTokens: 900, outputTokens: 20 } },
        ],
      }),
    );
    const out = handleInsightsSummary({ window: "all" }, deps);
    expect(insightsSummaryRpc.output.parse(out)).toEqual(out);
    // Each request: Manager 2,000, Worker 8,000, Reviewer 2,000 tokens read (no cached, no model id).
    expect(out.context?.tokensRead.total).toBe(24_000);
    expect(out.context?.tokensRead.perRequest.all).toEqual({ count: 2, median: 12_000, p75: 12_000, p80: 12_000, p90: 12_000, max: 12_000 });
    expect(out.context?.tokensRead.perAgent.byRole.worker).toMatchObject({ count: 1, max: 16_000 });
    expect(out.context?.tokensRead.heaviestRequests.map((row) => [row.workspaceId, row.tokensRead, row.turns, row.finished])).toEqual([
      [WS_A, 12_000, 5, true],
      [WS_B, 12_000, 5, true],
    ]);
    expect(out.context?.turns).toEqual({ withUsage: 10, byProvider: { claude: 0, codex: 0, opencode: 0, unknown: 10 }, repeated: 0, withToolCalls: 0 });
    expect(out.context?.contextEstimate).toMatchObject({ reported: 0, estimated: 0, unknown: 10 });
    expect(out.context?.orchestrator).toEqual({ wakes: 1, wakesWithUsage: 1, tokens: 1_020, perFinishedRequest: 510 });
    // One project: its own requests, and the wakes that named it.
    const beta = handleInsightsSummary({ window: "all", workspaceId: WS_B }, deps);
    expect(beta.context?.tokensRead.heaviestRequests.map((row) => row.workspaceId)).toEqual([WS_B]);
    expect(beta.context?.orchestrator).toMatchObject({ wakes: 0, tokens: 0 });
  });

  it("leaves every file of the data folder as it found it", () => {
    const before = snapshot(home);
    handleInsightsSummary({ window: "all" }, deps);
    handleInsightsSummary({ window: "30d", workspaceId: WS_A }, deps);
    expect(snapshot(home)).toEqual(before);
  });

  it("reads as unavailable, with every figure empty, without a usable data folder", () => {
    const unusable = handleInsightsSummary({ window: "30d" }, { ...deps, env: { PASEO_BM_HOME: "relative/path" } });
    expect(unusable.available).toBe(false);
    expect(unusable.requests).toEqual({ inWindow: 0, finished: 0 });
    const missing = handleInsightsSummary({ window: "30d" }, { ...deps, env: { PASEO_BM_HOME: join(root, "never-made") } });
    expect(missing.available).toBe(false);
    expect(readdirSync(root)).toEqual(["data"]);
  });

  it("registers the one RPC", () => {
    const handle = vi.fn();
    registerInsightsRpcs({ handle } as unknown as Parameters<typeof registerInsightsRpcs>[0], deps);
    expect(handle.mock.calls.map(([contract]) => (contract as { name: string }).name)).toEqual(["insights.summary"]);
    const handler = handle.mock.calls[0]![1] as (input: unknown) => { requests: { inWindow: number } };
    expect(handler({ window: "all" }).requests.inWindow).toBe(2);
  });
});

describe("insights.summary: A-12 from the intervention log (autonomy design §G.3)", () => {
  const entry = (id: string, workspaceId: string, outcome: "met" | "missed" | "unknown", at = "2026-09-26T10:00:00.000Z") => ({
    id,
    kind: "answer",
    workspaceId,
    requestId: R1,
    targetAgentId: WORKER,
    trigger: "decision.opened",
    expected: "worker-resumes",
    windowMs: 600_000,
    at,
    outcome,
    checkedAt: at,
  });

  it("reads orchestrator/interventions.json, per kind, narrowed to a workspace and to the window, numbers only", () => {
    mkdirSync(join(home, "orchestrator"), { recursive: true });
    writeFileSync(
      join(home, "orchestrator", "interventions.json"),
      JSON.stringify({ version: 1, entries: [entry("i-1", WS_A, "met"), entry("i-2", WS_A, "missed"), entry("i-3", WS_B, "unknown"), entry("i-4", WS_A, "met", "2026-09-01T10:00:00.000Z")] }),
    );
    const all = handleInsightsSummary({ window: "all" }, deps);
    expect(insightsSummaryRpc.output.parse(all)).toEqual(all);
    expect(all.interventions.map((row) => row.kind)).toEqual(["answer", "unblock", "correct", "stop", "compact", "handoff", "advice"]);
    expect(all.interventions[0]).toEqual({ kind: "answer", recorded: 4, met: 2, missed: 1, unknown: 1, pending: 0, share: 2 / 3 });
    expect(handleInsightsSummary({ window: "all", workspaceId: WS_B }, deps).interventions[0]).toMatchObject({ recorded: 1, unknown: 1, share: null });
    expect(handleInsightsSummary({ window: "7d" }, deps).interventions[0]).toMatchObject({ recorded: 3, met: 1, missed: 1, share: 0.5 });
    expect(JSON.stringify(all)).not.toContain(WORKER);
  });

  it("reads no log as none recorded, never as zero percent", () => {
    expect(handleInsightsSummary({ window: "all" }, deps).interventions.every((row) => row.recorded === 0 && row.share === null)).toBe(true);
  });
});

describe("insights.summary: review lift (autonomy design §C.4)", () => {
  /** A Reviewer turn of alpha's request with one review of batch b1. */
  const reviewed = (minute: number, blockingCount: number, tokens: number): TraceRecord => {
    const when = `2026-09-26T10:${minute}:00.000Z`;
    return turn({
      workspaceId: WS_A,
      requestId: R1,
      agentId: REVIEWER,
      role: "reviewer",
      at: when,
      turnId: `r-${minute}-${R1}`,
      startedAt: when,
      endedAt: when,
      usage: usage(tokens),
      reviews: [{ agentId: REVIEWER, at: when, batchId: "b1", verdict: blockingCount === 0 ? "approved" : "changes", blockingCount }],
    });
  };
  const REVIEWS = [reviewed(15, 2, 3000), reviewed(17, 0, 1000)];

  it("carries it per tier as the metric module counts it, narrowed to a workspace, with no id", () => {
    appendFileSync(join(home, "traces", WS_A, "events-202609.jsonl"), `${REVIEWS.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const out = handleInsightsSummary({ window: "all" }, deps);
    expect(insightsSummaryRpc.output.parse(out)).toEqual(out);
    const { reviewLift } = computeEvalMetrics({ records: [...ALPHA, ...BETA, ...REVIEWS], window: { since: null, until: null } });
    expect(out.reviewLift).toEqual({ all: reviewLift.all, byTier: reviewLift.byTier, reviewerTurnsWithoutRequest: 0 });
    // Alpha's Medium request: one batch whose 2 blocking findings were fixed by its re-review; its Reviewer's
    // three turns (the failed one too) read 6,000 tokens over its two reviews. Beta's Reviewer sent no review.
    expect(out.reviewLift?.byTier.Medium).toMatchObject({
      requests: 1,
      reviews: 2,
      batches: 1,
      blockingPerBatch: 2,
      actedOn: { reReviewedBatches: 1, found: 2, fixed: 2, reviewedOnceBatches: 0 },
      tokens: { reviews: 2, total: 6000, perReview: 3000 },
      unknown: { requestsWithoutReview: 1 },
    });
    const beta = handleInsightsSummary({ window: "all", workspaceId: WS_B }, deps);
    expect(beta.reviewLift?.all).toMatchObject({ requests: 0, reviews: 0, blockingPerBatch: null, tokens: { perReview: null }, unknown: { requestsWithoutReview: 1 } });
    expect(JSON.stringify(out.reviewLift)).not.toMatch(/wks_|req-|agent-/);
  });
});
