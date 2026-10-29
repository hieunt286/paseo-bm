import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TraceRecord, Usage } from "../plugin/shared/contracts";
import { computeEvalMetrics, type EvalInput, type EvalMetrics } from "../plugin/shared/eval-metrics";
import type { Decision } from "../plugin/shared/decisions";
import { runReplay, type ReplayReport } from "../scripts/eval/replay";
import { readStore } from "../plugin/server/eval-store";
import { finishedLineFactsOf, finishedLineOf, type LineState } from "../plugin/server/line-state";
import { updatesNoticeOf } from "../plugin/shared/notices";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, at, file, msg, report, shell, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";

/**
 * M-36, M-40 and M-42 (missions PRD; delivery line design §13): the tokens a
 * request reads, Worker turns started while a wait by id is unsettled and the
 * tokens of turns that end blocked, and maintenance dropped after its ceiling —
 * from the trace records, the request registry, the stored decisions and the
 * compaction and handoff stores; then through the replay, read-only. M-37
 * and M-38: files two missions wrote in one workspace, and committed and
 * verified finishes, from the reports with the rosters and placements. M-44:
 * the wait of a tell to a Worker, from the outbox (delivery line design §19.10).
 */

const OPEN = { since: null, until: null };
const metrics = (records: TraceRecord[], extra: Partial<EvalInput> = {}): EvalMetrics => computeEvalMetrics({ records, window: OPEN, ...extra });
const usage = (tokens: number): Usage => ({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, costUsd: null, costBasis: "unavailable", model: null, pricesUpdatedAt: null });
const M = 1_000_000;

describe("M-36 the tokens a request reads (delivery line design §2.6, §13)", () => {
  const R1 = "req-20260926T100000Z";
  const R2 = "req-20260926T101000Z";
  const R3 = "req-20260926T102000Z";
  const R4 = "req-20260926T103000Z";
  const work = (requestId: string, minute: number, tokens: number | null, role: "worker" | "manager" = "worker") =>
    turn({ requestId, agentId: role === "worker" ? `${WORKER}-${requestId}` : MANAGER, role, turnId: `${requestId}-${minute}`, at: at(minute), endedAt: at(minute), usage: tokens === null ? null : usage(tokens) });
  const records = [
    // R1: 60 M + 50 M by its Worker and 1 M by the Main = 111 M; R2 continues it (30 M); R3 alone (10 M); R4 has no usage.
    work(R1, 1, 60 * M),
    work(R1, 2, 50 * M),
    work(R1, 3, 1 * M, "manager"),
    work(R2, 4, 30 * M),
    work(R3, 5, 10 * M),
    work(R4, 6, null),
  ];
  const requests = [
    { requestId: R1, workspaceId: WORKSPACE_ID, source: "tool", continuedBy: R2 },
    { requestId: R2, workspaceId: WORKSPACE_ID, continuationOf: R1, chainRootId: R1 },
    { requestId: R3, workspaceId: WORKSPACE_ID },
    { workspaceId: WORKSPACE_ID },
  ];

  it("gives the largest request, p50 and p95, the requests over the default ceiling, and the largest chain", () => {
    const m = metrics(records, { requests });
    expect(m.m36).toEqual({
      registryIncluded: true,
      settingsIncluded: false,
      ceilingTokens: 100 * M,
      requests: 3,
      largest: { requestId: R1, workspaceId: WORKSPACE_ID, tokensRead: 111 * M },
      p50: 30 * M,
      p95: 111 * M,
      overCeiling: 1,
      chains: 1,
      largestChain: { rootId: R1, requests: 2, tokensRead: 141 * M },
    });
    expect(m.unknowns.invalidRequestEntries).toBe(1);
  });

  it("judges against the owner's rollover figures, strictly above the ceiling", () => {
    const m = metrics(records, { requests, coordinationSettings: { version: 1, rollover: { tokens: 20 * M, ceilingFactor: 1.5 } } });
    // 1.5 × 20 M = 30 M: R2's 30 M is at the ceiling, not over it.
    expect(m.m36).toMatchObject({ settingsIncluded: true, ceilingTokens: 30 * M, overCeiling: 1 });
  });

  it("walks continuationOf back when the chain root is not stored, and without the registry each request is its own chain", () => {
    const walked = metrics(records, { requests: [{ requestId: R2, workspaceId: WORKSPACE_ID, continuationOf: R1 }] });
    expect(walked.m36.largestChain).toEqual({ rootId: R1, requests: 2, tokensRead: 141 * M });
    const alone = metrics(records);
    expect(alone.m36).toMatchObject({ registryIncluded: false, chains: 0, largestChain: { rootId: R1, requests: 1, tokensRead: 111 * M } });
    expect(metrics([]).m36).toMatchObject({ requests: 0, largest: null, p50: null, p95: null, overCeiling: 0, largestChain: null });
  });
});

describe("M-40 Worker turns while a wait by id is unsettled, and the tokens of turns that end blocked (delivery line design §6.2–§6.4, §13)", () => {
  const W = "req-20260926T100000Z";
  const OTHER = "req-20260926T090000Z";
  const HEAD = "req-20260926T095000Z";
  const PEER = "peer-0123456789ab";
  const blockedOn = (minute: number, blockers: string, extra: Record<string, unknown> = {}) =>
    report({ agentId: WORKER, requestId: W, at: at(minute), phase: "blocked", blockers, ...extra });
  const workerTurn = (
    name: string,
    start: [number, number],
    end: [number, number],
    tokens: number,
    first: { text: string; origin?: "user" | "agent" } | null,
    extra: Partial<TraceRecord> = {},
  ): TraceRecord =>
    turn({
      requestId: W,
      agentId: WORKER,
      role: "worker",
      turnId: name,
      startedAt: at(...start),
      at: at(...end),
      endedAt: at(...end),
      sent: first === null ? [] : [msg(WORKER, at(...start), first.text, first.origin)],
      usage: usage(tokens),
      ...extra,
    });

  const records: TraceRecord[] = [
    // t1: the brief; blocked on Q1, Q2 (the owner) and OTHER, all of them.
    workerTurn("t1", [1, 0], [2, 0], 1000, { text: `BM-BRIEF worker requestId: ${W}\nDo it.` }, {
      reports: [blockedOn(2, `waiting on the owner: Q1, Q2. waiting on requests: ${OTHER}`, { waitingOnRequests: [OTHER] })],
    }),
    // t2: a message delivery while Q1 is open: woken while waiting.
    workerTurn("t2", [3, 0], [3, 30], 500, { text: "BM-DELIVERY message out-0123456789ab\nContinue." }),
    // t3: the owner typed: not a plugin delivery.
    workerTurn("t3", [4, 0], [4, 30], 200, { text: "How is it going?", origin: "user" }),
    // t4: the answers once Q1 (10), Q2 (11, withdrawn) and OTHER (11) settled: the wait was met. It blocks on b1, the first settled item enough.
    workerTurn("t4", [12, 0], [13, 0], 300, { text: `BM-DELIVERY answers\nContinue ${W}.` }, {
      reports: [blockedOn(13, "waiting on review: b1. wake on: any", { waitingOnBatches: ["b1"], wakeOn: "any" })],
    }),
    // t5: a batched delivery before b1's verdict (15): woken while waiting; the collector's trigger says plugin.
    workerTurn("t5", [14, 0], [14, 30], 400, { text: "BM-UPDATES 1\nFrom the paseo-bm plugin, not the owner.\nBM-ITEM 1\nBM-SIGNAL danger" }, { trigger: "plugin" }),
    // t6: the review delivery after the verdict: met. It blocks on a project link.
    workerTurn("t6", [16, 0], [17, 0], 600, { text: "BM-DELIVERY review out-0123456789ac\nBM-REVIEW" }, {
      trigger: "report",
      reports: [blockedOn(17, `waiting on project: web (${PEER})`)],
    }),
    // t7: a delivery while the link waits: these stores do not hold a link's reply, so it is not judged.
    workerTurn("t7", [18, 0], [18, 30], 700, { text: "BM-DELIVERY peer-reply out-0123456789ad\nfrom: web" }),
    // t8: the owner; it finishes.
    workerTurn("t8", [19, 0], [20, 0], 1000, { text: "Go on.", origin: "user" }, { reports: [report({ agentId: WORKER, requestId: W, at: at(20), phase: "finished" })] }),
    // The batch's verdict, by its Reviewer.
    turn({ requestId: W, agentId: REVIEWER, role: "reviewer", turnId: "rv", at: at(15), endedAt: at(15), reviews: [{ agentId: REVIEWER, at: at(15), batchId: "b1", verdict: "approved", blockingCount: 0 }] }),
    // OTHER finishes at 11 (its Worker's turn has no usage); HEAD, which continues it, at 20.
    turn({ requestId: OTHER, agentId: "agent-other", role: "worker", turnId: "o1", at: at(11), endedAt: at(11), reports: [report({ agentId: "agent-other", requestId: OTHER, at: at(11), phase: "finished" })] }),
    turn({ requestId: HEAD, agentId: "agent-head", role: "worker", turnId: "h1", at: at(20), endedAt: at(20), reports: [report({ agentId: "agent-head", requestId: HEAD, at: at(20), phase: "finished" })] }),
  ];
  const decisions: Decision[] = [
    makeDecision({ id: `q:${W}:Q1`, requestId: W, workspaceId: WORKSPACE_ID, askedAt: at(2), status: "answered", settledAt: at(10), answer: { by: "owner", via: "inbox", optionKey: "c", words: null, at: at(10) } }),
    makeDecision({ id: `q:${W}:Q2`, requestId: W, workspaceId: WORKSPACE_ID, askedAt: at(2), status: "withdrawn", settledAt: at(11) }),
  ];

  it("counts the plugin's deliveries while the wait was unsettled, the upper bound, the unjudged, and the tokens of turns that end blocked", () => {
    const m = metrics(records, { decisions, requests: [] });
    expect(m.m40).toEqual({
      registryIncluded: true,
      decisionsIncluded: true,
      // t1–t8, OTHER's and HEAD's Workers.
      workerTurns: 10,
      // t2, t4, t5, t6, t7.
      afterBlocked: 5,
      startedWhileWaiting: 2,
      notJudged: 1,
      tokensReadWhileWaiting: 900,
      byMarker: { "BM-DELIVERY message": 1, "BM-UPDATES": 1 },
      workerTokensRead: 4700,
      // t1, t4 and t6 end with their own blocked report; t2, t3, t5 and t7 send none, t8 finishes.
      blockedEndTurns: 3,
      blockedEndTokensRead: 1900,
      blockedEndShare: 1900 / 4700,
    });
  });

  it("a size finish of an awaited request settles nothing: its chain's head does", () => {
    const m = metrics(records, { decisions, requests: [{ requestId: OTHER, workspaceId: WORKSPACE_ID, continuedBy: HEAD }] });
    // t4 now starts while OTHER's chain is still open (HEAD finishes at 20).
    expect(m.m40).toMatchObject({ startedWhileWaiting: 3, byMarker: { "BM-DELIVERY answers": 1, "BM-DELIVERY message": 1, "BM-UPDATES": 1 } });
  });

  it("without the decisions a question cannot be settled: a wait an open item decides is still counted, the rest is not judged", () => {
    const m = metrics(records, { requests: [] });
    // t2: OTHER is open at 3, so the wait on all three is unmet; t4: OTHER settled but the questions unknown.
    expect(m.m40).toMatchObject({ decisionsIncluded: false, afterBlocked: 5, startedWhileWaiting: 2, notJudged: 2 });
  });
});

describe("M-42 maintenance dropped no-safe-point after its ceiling (delivery line design §6.6, §13)", () => {
  const entry = (requestedAt: string, ending: string | null, endedAt: string | null, workspaceId = WORKSPACE_ID) => ({ workspaceId, requestedAt, endedAt, ending, reason: "private reason" });
  const hour = (h: number, m = 0) => `2026-09-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

  it("counts the drops by when they were asked, and those that waited past the 30-minute ceiling", () => {
    const m = metrics([], {
      compactions: [entry(hour(10), "no-safe-point", hour(11, 1)), entry(hour(10), "no-safe-point", hour(10, 20)), entry(hour(10), null, null), entry(hour(10), "no-compaction", hour(11)), { bad: true }],
      handoffs: [entry(hour(12), "no-safe-point", hour(13, 1)), entry(hour(12), "finished", hour(12, 5))],
    });
    expect(m.m42).toEqual({
      compactionsIncluded: true,
      handoffsIncluded: true,
      ceilingMs: { compact: 30 * 60_000, handoff: 30 * 60_000 },
      compactions: { entries: 4, dropped: 2, afterCeiling: 1 },
      handoffs: { entries: 2, dropped: 1, afterCeiling: 1 },
    });
    expect(m.unknowns.invalidMaintenanceEntries).toBe(1);
    const windowed = computeEvalMetrics({ records: [], window: { since: hour(11), until: null }, compactions: [entry(hour(10), "no-safe-point", hour(11, 1))], handoffs: [entry(hour(12), "no-safe-point", hour(13, 1))] });
    expect(windowed.m42).toMatchObject({ compactions: { entries: 0, dropped: 0 }, handoffs: { entries: 1, dropped: 1, afterCeiling: 1 } });
    expect(metrics([]).m42).toMatchObject({ compactionsIncluded: false, handoffsIncluded: false, compactions: { entries: 0 } });
  });
});

/** An outbox record as `server/outbox.ts` stores it; `bm_tell_worker`'s `message` from the Main to a Worker by default. */
const outboxRecord = (createdAt: string, over: Record<string, unknown> = {}) => ({
  id: "out-0123456789ab",
  kind: "message",
  requestId: "req-20261016T090000Z",
  batchId: null,
  from: MANAGER,
  to: WORKER,
  text: "private owner words",
  createdAt,
  state: "pending",
  outcomeAt: null,
  reason: null,
  ...over,
});

describe("M-44 the wait of a tell to a Worker (delivery line design §19.5, §19.10)", () => {
  const hour = (h: number, m = 0) => `2026-10-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
  const delivered = (createdAt: string, outcomeAt: string, over: Record<string, unknown> = {}) => outboxRecord(createdAt, { state: "delivered", outcomeAt, ...over });

  it("counts the tells created in the window, their waits until delivered or steered, the steered, the replaced and the still queued", () => {
    const m = computeEvalMetrics({
      records: [],
      window: { since: hour(10), until: hour(12) },
      outbox: [
        outboxRecord(hour(10)),
        delivered(hour(10, 5), hour(10, 59)),
        delivered(hour(10, 10), hour(10, 11), { atOnce: true, steeredAt: hour(10, 11) }),
        delivered(hour(10, 20), hour(10, 23), { atOnce: true, steeredAt: hour(10, 23), replaced: true }),
        // Delivered after the window's end: queued at its end.
        delivered(hour(11, 50), hour(12, 30)),
        // Outside the window.
        delivered(hour(9), hour(9, 2)),
        // The plugin's own message to a Main, and another kind: no tells.
        delivered(hour(10, 30), hour(10, 31), { from: "plugin" }),
        delivered(hour(10, 30), hour(10, 31), { from: "owner" }),
        delivered(hour(10, 30), hour(10, 31), { kind: "report", from: WORKER, to: MANAGER }),
        { bad: true },
      ],
    });
    // Waits 54, 1, 3 and 40 minutes: p50 3, p90 54 by nearest rank.
    expect(m.m44).toEqual({ outboxIncluded: true, tells: 5, delivered: 4, waitMinutes: { p50: 3, p90: 54 }, steered: 1, replaced: 1, queuedAtEnd: 2 });
    expect(m.unknowns.invalidOutboxRecords).toBe(1);
    expect(metrics([]).m44).toEqual({ outboxIncluded: false, tells: 0, delivered: 0, waitMinutes: { p50: null, p90: null }, steered: 0, replaced: 0, queuedAtEnd: 0 });
    expect(metrics([], { outbox: [] }).m44).toMatchObject({ outboxIncluded: true, tells: 0, waitMinutes: { p50: null, p90: null } });
  });
});

describe("the replay of M-36, M-40 and M-42 (evaluation design §5; delivery line design §13)", () => {
  let home: string;
  const R = "req-20261016T090000Z";
  const R2 = "req-20261016T100000Z";
  const WS = "wks_alpha";
  const SECRET = "private handoff note about the ledger";
  const minute = (m: number) => `2026-10-16T09:${String(m).padStart(2, "0")}:00.000Z`;
  const run = (argv: string[]): { code: number; stdout: string; stderr: string } => {
    let stdout = "";
    let stderr = "";
    const code = runReplay(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { env: {}, homedir: () => "/nonexistent-home" });
    return { code, stdout, stderr };
  };
  const mtimes = (root: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        out[path] = statSync(path).mtimeMs;
        if (statSync(path).isDirectory()) walk(path);
      }
    };
    walk(root);
    return out;
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "bm-replay-delivery-line-"));
    const write = (path: string, value: unknown) => {
      mkdirSync(join(home, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(home, ...path.split("/")), typeof value === "string" ? value : JSON.stringify(value));
    };
    const worker = (requestId: string, m: number, tokens: number, extra: Partial<TraceRecord> = {}) =>
      turn({ workspaceId: WS, requestId, agentId: WORKER, role: "worker", turnId: `${requestId}-${m}`, startedAt: minute(m), at: minute(m), endedAt: minute(m), usage: usage(tokens), ...extra });
    const records = [
      worker(R, 1, 150 * M, { reports: [report({ agentId: WORKER, requestId: R, at: minute(1), phase: "blocked", blockers: "waiting on review: b1", waitingOnBatches: ["b1"] })] }),
      worker(R, 2, 50 * M, { sent: [msg(WORKER, minute(2), "BM-DELIVERY message out-0123456789ab\nContinue.")] }),
      worker(R2, 3, 20 * M),
    ];
    write(`traces/${WS}/events-202610.jsonl`, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    write(`requests/${WS}.json`, {
      schemaVersion: 1,
      requests: [
        { requestId: R, workspaceId: WS, createdAt: minute(0), source: "tool", managerId: null, workerIds: [WORKER], tier: null, finishedAt: null, reviews: { batches: [], grants: [] }, continuedBy: R2 },
        { requestId: R2, workspaceId: WS, createdAt: minute(3), source: "tool", managerId: null, workerIds: [WORKER], tier: null, finishedAt: null, reviews: { batches: [], grants: [] }, continuationOf: R, chainRootId: R },
      ],
    });
    write("coordination/settings.json", { version: 1, rollover: { tokens: 60 * M, ceilingFactor: 2 } });
    write("orchestrator/compactions.json", {
      version: 1,
      entries: [{ id: "c1", workspaceId: WS, requestId: R, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: SECRET, state: "dropped", requestedAt: minute(1), sentAt: null, compactedAt: null, briefAt: null, endedAt: "2026-10-16T10:02:00.000Z", ending: "no-safe-point" }],
      sent: [],
    });
    write("handoffs/h1.json", {
      version: 1,
      handoff: { id: "h1", workspaceId: WS, requestId: R, workerId: WORKER, managerId: MANAGER, missionId: null, interventionId: null, reason: SECRET, state: "dropped", requestedAt: minute(2), noteAskedAt: null, note: SECRET, briefAt: null, brief: SECRET, commandId: null, commandSentAt: null, creatingAt: null, successorId: null, successorAt: null, endedAt: "2026-10-16T10:03:00.000Z", ending: "no-safe-point" },
    });
    // M-44: queued; delivered after 54 minutes; steered after 1; replaced after 2; one a day before (10 minutes).
    write(`outbox/${WS}.json`, {
      schemaVersion: 1,
      records: [
        outboxRecord(minute(4), { id: "out-000000000001", text: SECRET }),
        outboxRecord(minute(5), { id: "out-000000000002", text: SECRET, state: "delivered", outcomeAt: "2026-10-16T09:59:00.000Z" }),
        outboxRecord(minute(6), { id: "out-000000000003", text: SECRET, state: "delivered", outcomeAt: minute(7), atOnce: true, steeredAt: minute(7) }),
        outboxRecord(minute(7), { id: "out-000000000004", text: SECRET, state: "delivered", outcomeAt: minute(9), atOnce: true, steeredAt: minute(9), replaced: true }),
        outboxRecord("2026-10-15T09:00:00.000Z", { id: "out-000000000005", text: SECRET, state: "delivered", outcomeAt: "2026-10-15T09:10:00.000Z" }),
      ],
    });
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads the registry, the settings, the compactions, the handoffs and the outbox, prints their headline rows, and writes nothing", () => {
    const before = mtimes(home);
    const out = run(["--home", home, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const replay = JSON.parse(out.stdout) as ReplayReport;
    expect(replay.metrics.m36).toMatchObject({
      registryIncluded: true,
      settingsIncluded: true,
      ceilingTokens: 120 * M,
      requests: 2,
      largest: { requestId: R, workspaceId: WS, tokensRead: 200 * M },
      overCeiling: 1,
      chains: 1,
      largestChain: { rootId: R, requests: 2, tokensRead: 220 * M },
    });
    expect(replay.metrics.m40).toMatchObject({ afterBlocked: 1, startedWhileWaiting: 1, tokensReadWhileWaiting: 50 * M, blockedEndTokensRead: 150 * M, workerTokensRead: 220 * M });
    expect(replay.metrics.m42).toMatchObject({ compactions: { entries: 1, dropped: 1, afterCeiling: 1 }, handoffs: { entries: 1, dropped: 1, afterCeiling: 1 } });
    // Waits 54, 1, 2 and 10 minutes: p50 2, p90 54.
    expect(replay.metrics.m44).toEqual({ outboxIncluded: true, tells: 5, delivered: 4, waitMinutes: { p50: 2, p90: 54 }, steered: 1, replaced: 1, queuedAtEnd: 1 });

    const markdown = run(["--home", home]).stdout;
    expect(markdown).toContain(
      `| M-36 tokens read per request, all its turns: largest (request) · largest chain (its requests) · p50 / p95 · over the ceiling of 120000000 (rollover.ceilingFactor × rollover.tokens) / requests | 200000000 (${R}) · 220000000 (2) · 20000000 / 200000000 · 1 / 2 |`,
    );
    expect(markdown).toContain("| M-40 Worker turns a plugin delivery started while a wait by id was unsettled (settle times rebuilt from the stores; a link's reply or a dead item is not stored) · not judged · upper bound (after a blocked report naming ids) · tokens read in them · Worker tokens read in turns that end with a blocked report: share (tokens / Worker tokens) | 1 · 0 · 1 · 50000000 · 68.2 % (150000000 / 220000000) (decisions not read) |");
    expect(markdown).toContain(
      "| M-42 maintenance dropped no-safe-point: compactions dropped / asked, after the 30-min ceiling · handoffs dropped / asked, after the 30-min ceiling (the time ceiling; the token figure is not stored) | 1 / 1, 1 · 1 / 1, 1 |",
    );
    expect(markdown).toContain("| M-44 tells to Workers: waited until delivered p50 / p90 minutes · delivered / tells · steered into a running turn · turns Paseo replaced · still queued | 2 / 54 · 4 / 5 · 1 · 1 · 1 |");
    for (const stdout of [out.stdout, markdown]) expect(stdout).not.toContain(SECRET);
    expect(mtimes(home)).toEqual(before);
  });

  it("--workspace keeps a compaction or handoff by its workspace", () => {
    const other = JSON.parse(run(["--home", home, "--json", "--workspace", "wks_beta"]).stdout) as ReplayReport;
    expect(other.metrics.m42).toMatchObject({ compactions: { entries: 0 }, handoffs: { entries: 0 } });
    expect(other.metrics.m44).toMatchObject({ outboxIncluded: true, tells: 0 });
  });

  it("keeps a tell in the window by when it was created, and says when the outbox was not read", () => {
    const since = JSON.parse(run(["--home", home, "--json", "--since", "2026-10-16T00:00:00.000Z"]).stdout) as ReplayReport;
    expect(since.metrics.m44).toEqual({ outboxIncluded: true, tells: 4, delivered: 3, waitMinutes: { p50: 2, p90: 54 }, steered: 1, replaced: 1, queuedAtEnd: 1 });
    const bare = mkdtempSync(join(tmpdir(), "bm-replay-no-outbox-"));
    try {
      expect(run(["--home", bare]).stdout).toContain("| M-44 tells to Workers: waited until delivered p50 / p90 minutes · delivered / tells · steered into a running turn · turns Paseo replaced · still queued | outbox not read |");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ── M-37 and M-38 ───────────────────────────────────────────────────────────

const MIS_A = "mis-aaaaaaaaaa";
const MIS_B = "mis-bbbbbbbbbb";
const MIS_C = "mis-cccccccccc";
const MIS_D = "mis-dddddddddd";
const SHARED = "wks_shared";
const PLACE_A = "wks_place_a";
const PLACE_B = "wks_place_b";
const PLACE_D = "wks_place_d";
const PLACEMENTS = { [PLACE_A]: { missionId: MIS_A, repo: SHARED }, [PLACE_B]: { missionId: MIS_B, repo: SHARED }, [PLACE_D]: { missionId: MIS_D, repo: SHARED } };

/** A Worker turn of `requestId` in `workspaceId`, carrying its own report. */
const workerReport = (requestId: string, workspaceId: string, minute: number, over: Partial<Parameters<typeof report>[0]> = {}, extra: Partial<TraceRecord> = {}): TraceRecord =>
  turn({
    workspaceId,
    requestId,
    agentId: `${WORKER}-${requestId}`,
    role: "worker",
    turnId: `${requestId}-${minute}`,
    startedAt: at(minute),
    at: at(minute),
    endedAt: at(minute),
    reports: [report({ agentId: `${WORKER}-${requestId}`, at: at(minute), requestId, phase: "bead-implemented", ...over })],
    ...extra,
  });

describe("M-37 files written by Workers of two missions in one workspace (delivery line design §3, §13)", () => {
  const RA1 = "req-20261015T100000Z";
  const RB1 = "req-20261015T101000Z";
  const RC1 = "req-20261015T102000Z";
  const RA2 = "req-20261015T103000Z";
  const RB2 = "req-20261015T104000Z";
  const RC2 = "req-20261015T105000Z";
  const RD = "req-20261015T106000Z";
  const RN = "req-20261015T107000Z";
  const records = [
    // The shared checkout before placements: A and B both write x.ts and y.ts (y.ts once as an absolute path).
    workerReport(RA1, SHARED, 1, { filesChanged: ["src/x.ts", "./src/y.ts"] }),
    workerReport(RB1, SHARED, 2, { filesChanged: ["src/x.ts", "/work/shared/src/y.ts", "/elsewhere/notes.md"] }),
    // C writes its own file; the Main's relay naming x.ts is no Worker's report.
    workerReport(RC1, SHARED, 3, { filesChanged: ["src/z.ts"] }),
    turn({ workspaceId: SHARED, requestId: RC1, turnId: `${RC1}-main`, at: at(4), reports: [report({ agentId: MANAGER, at: at(4), requestId: RC1, filesChanged: ["src/x.ts"] })] }),
    // Placements: A and B each in their own, so x.ts there is no collision; C's request ran in A's placement and wrote p.ts beside A.
    workerReport(RA2, PLACE_A, 5, { filesChanged: ["src/x.ts", "src/p.ts"] }),
    workerReport(RB2, PLACE_B, 6, { filesChanged: ["src/x.ts"] }),
    workerReport(RC2, PLACE_A, 7, { filesChanged: ["src/p.ts"] }),
    // No roster holds D's request: its placement names the mission.
    workerReport(RD, PLACE_D, 8, { filesChanged: ["src/q.ts"] }),
    // A request of no mission writes x.ts in the shared checkout: in no figure but its own.
    workerReport(RN, SHARED, 9, { filesChanged: ["src/x.ts"] }),
  ];
  const missionRequests = { [MIS_A]: [RA1, RA2], [MIS_B]: [RB1, RB2], [MIS_C]: [RC1, RC2] };
  const workspaceDirectories = { [SHARED]: "/work/shared" };

  it("counts the files two missions wrote in one workspace, in placements apart, and each pair of missions", () => {
    const m = metrics(records, { missionRequests, placements: PLACEMENTS, workspaceDirectories });
    expect(m.m37).toEqual({
      missionsIncluded: true,
      placementsIncluded: true,
      requests: 7,
      requestsWithoutMission: 1,
      files: 3,
      inPlacements: 1,
      pairs: [
        { workspaceId: SHARED, placement: false, missions: [MIS_A, MIS_B], files: 2 },
        { workspaceId: PLACE_A, placement: true, missions: [MIS_A, MIS_C], files: 1 },
      ],
    });
  });

  it("without the rosters, a request's mission comes from its placement alone", () => {
    const m = metrics(records, { placements: PLACEMENTS, workspaceDirectories });
    // RC2 ran in A's placement, so it reads as A's: no collision is left.
    expect(m.m37).toEqual({ missionsIncluded: false, placementsIncluded: true, requests: 4, requestsWithoutMission: 4, files: 0, inPlacements: 0, pairs: [] });
    expect(metrics([]).m37).toEqual({ missionsIncluded: false, placementsIncluded: false, requests: 0, requestsWithoutMission: 0, files: 0, inPlacements: 0, pairs: [] });
  });

  it("counts the requests in the window only", () => {
    const m = metrics(records, { missionRequests, placements: PLACEMENTS, workspaceDirectories, window: { since: at(2), until: null } });
    expect(m.m37).toMatchObject({ requests: 6, files: 1, pairs: [{ workspaceId: PLACE_A, missions: [MIS_A, MIS_C], files: 1 }] });
  });
});

describe("M-38 committed and verified finishes of mission requests (delivery line design §4.4, §4.6, §13)", () => {
  const F1 = "req-20261015T110000Z";
  const F2 = "req-20261015T111000Z";
  const F3 = "req-20261015T112000Z";
  const F4 = "req-20261015T113000Z";
  const F5 = "req-20261015T114000Z";
  const F6 = "req-20261015T115000Z";
  const F7 = "req-20261015T116000Z";
  const out = (n: number) => `out-${String(n).padStart(12, "0")}`;
  const line = (state: LineState | null, verified: Parameters<typeof finishedLineOf>[2], why?: string): string =>
    state === null ? finishedLineOf({ committed: false, why: why ?? "", line: null }, "m/PAY/shared", verified) : finishedLineOf({ committed: true, line: state }, "m/PAY/shared", verified);
  const clean: LineState = { dirty: false, ahead: 1, behind: 0, lastCommitAt: at(1), head: "abc1234", branchOk: true, aheadOfOrigin: 0 };
  const delivery = (recordId: string, text: string) => `BM-DELIVERY report ${recordId}\nBM-REPORT\nphase: finished\n\n${text}`;
  const finished = (requestId: string, minute: number, over: Partial<Parameters<typeof report>[0]>, extra: Partial<TraceRecord> = {}) =>
    workerReport(requestId, PLACE_A, minute, { phase: "finished", filesChanged: ["src/a.ts"], ...over }, extra);
  const records = [
    // F1: the Main's line says committed and verified (the merge request's CI, as Paseo read it).
    finished(F1, 1, { recordId: out(1), integration: { branch: "m/PAY/shared", commit: "abc1234" } }),
    // F2: the report names a commit, but the Main's line says the plugin found none: the line wins.
    finished(F2, 2, { recordId: out(2), integration: { branch: "m/PAY/shared", commit: "def5678" } }),
    // F3: before placements — no git fields and no line: uncommitted; its named check ran after the edit: detected.
    finished(F3, 3, { buildAndTests: "`npm test` passed" }, {
      evidence: [file("src/a.ts", at(3), `${WORKER}-${F3}`), { ...shell("npm test", at(3, 30), `${WORKER}-${F3}`), status: "completed", exitCode: 0 }],
    }),
    // F4: a commit reported with red CI, no line.
    finished(F4, 4, { integration: { commit: "0a1b2c3", ci: "failure" } }),
    // F5: no file changed: neither its commit nor its CI is judged.
    finished(F5, 5, { filesChanged: [], integration: { ci: "success" } }),
    // F6: no mission's request, in the shared checkout.
    workerReport(F6, SHARED, 6, { phase: "finished", filesChanged: ["src/a.ts"] }),
    // F7: delivered in a BM-UPDATES message: committed, CI red.
    finished(F7, 7, { recordId: out(7), integration: { commit: "1234abc" } }),
    turn({
      turnId: "main-1",
      at: at(8),
      sent: [
        msg(WORKER, at(8), delivery(out(1), line(clean, "verified"))),
        msg(WORKER, at(8), delivery(out(2), line(null, "unverified", "the worktree has changes not committed"))),
        msg(WORKER, at(8), updatesNoticeOf(["BM-DELIVERY message out-0000000000aa\nContinue.", delivery(out(7), line(clean, "ci-red"))])),
      ],
    }),
  ];
  const missionRequests = { [MIS_A]: [F1, F2, F3, F4, F5, F7] };

  it("counts changed-file finishes with no commit, by the Main's line or the report, and the share of them verified by CI or a detected check", () => {
    const m = metrics(records, { missionRequests, placements: PLACEMENTS });
    expect(m.m38).toEqual({
      missionsIncluded: true,
      finished: 6,
      changedFiles: 5,
      uncommitted: 2,
      committedBy: { line: 3, report: 2 },
      verified: 2,
      verifiedBy: { ci: 1, check: 1 },
      ciRed: 2,
      verifiedShare: 0.4,
    });
  });

  it("reads every line the plugin writes as finishedLineFactsOf does", () => {
    for (const [text, committed] of [
      [line(clean, "verified"), true],
      [line(clean, "pending"), true],
      [line(clean, "ci-red"), true],
      [line(clean, "unverified"), true],
      [line(null, "unverified", "not on m/PAY/shared"), false],
    ] as const) {
      const one = metrics([finished(F1, 1, { recordId: out(1) }), turn({ turnId: "main", at: at(2), sent: [msg(WORKER, at(2), delivery(out(1), text))] })], { missionRequests });
      expect([text, one.m38.uncommitted, one.m38.committedBy]).toEqual([text, committed ? 0 : 1, { line: 1, report: 0 }]);
      const facts = finishedLineFactsOf(text);
      expect([facts?.committed, facts?.verified === "verified" ? 1 : 0, facts?.verified === "ci-red" ? 1 : 0]).toEqual([committed, one.m38.verified, one.m38.ciRed]);
    }
  });

  it("without rosters or placements no request is a mission's", () => {
    expect(metrics(records).m38).toEqual({ missionsIncluded: false, finished: 0, changedFiles: 0, uncommitted: 0, committedBy: { line: 0, report: 0 }, verified: 0, verifiedBy: { ci: 0, check: 0 }, ciRed: 0, verifiedShare: null });
    // The placements alone name the mission of every request in A's placement; F6 ran in none.
    expect(metrics(records, { placements: PLACEMENTS }).m38).toMatchObject({ missionsIncluded: false, finished: 6, changedFiles: 5, uncommitted: 2 });
  });
});

describe("the replay of M-37 and M-38 (evaluation design §5; delivery line design §13)", () => {
  let home: string;
  const R1 = "req-20261016T090000Z";
  const R2 = "req-20261016T091000Z";
  const minute = (m: number) => `2026-10-16T09:${String(m).padStart(2, "0")}:00.000Z`;
  const run = (argv: string[]): { code: number; stdout: string; stderr: string } => {
    let stdout = "";
    let stderr = "";
    const code = runReplay(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { env: {}, homedir: () => "/nonexistent-home" });
    return { code, stdout, stderr };
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "bm-replay-mission-lines-"));
    const write = (path: string, value: unknown) => {
      mkdirSync(join(home, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(home, ...path.split("/")), typeof value === "string" ? value : JSON.stringify(value));
    };
    const worker = (requestId: string, m: number, filesChanged: string[]) =>
      turn({ workspaceId: SHARED, requestId, agentId: `${WORKER}-${requestId}`, role: "worker", turnId: `${requestId}-${m}`, startedAt: minute(m), at: minute(m), endedAt: minute(m), reports: [report({ agentId: `${WORKER}-${requestId}`, at: minute(m), requestId, phase: "finished", filesChanged })] });
    write(`traces/${SHARED}/events-202610.jsonl`, `${[worker(R1, 1, ["src/x.ts"]), worker(R2, 2, ["src/x.ts"])].map((record) => JSON.stringify(record)).join("\n")}\n`);
    write("missions/index.json", { version: 1, missions: [], placements: { [PLACE_A]: { missionId: MIS_A, repo: SHARED } } });
    write(`missions/${MIS_B}.json`, { missionId: MIS_B, placements: [{ repo: SHARED, workspaceId: PLACE_B, branch: "m/WEB/shared" }] });
    write(`missions/${MIS_A}.roster.json`, { version: 1, requests: [{ requestId: R1, workspaceId: SHARED }] });
    write(`missions/${MIS_B}.roster.json`, { version: 1, requests: [{ requestId: R2, workspaceId: SHARED }] });
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads the rosters and the placements, and prints two headline rows", () => {
    const out = run(["--home", home, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const replay = JSON.parse(out.stdout) as ReplayReport;
    expect(replay.metrics.m37).toEqual({
      missionsIncluded: true,
      placementsIncluded: true,
      requests: 2,
      requestsWithoutMission: 0,
      files: 1,
      inPlacements: 0,
      pairs: [{ workspaceId: SHARED, placement: false, missions: [MIS_A, MIS_B], files: 1 }],
    });
    expect(replay.metrics.m38).toMatchObject({ missionsIncluded: true, finished: 2, changedFiles: 2, uncommitted: 2, committedBy: { line: 0, report: 2 }, verified: 0, verifiedShare: 0 });

    const markdown = run(["--home", home]).stdout;
    expect(markdown).toContain(
      `| M-37 files written by Workers of two missions in one workspace (a placement, or the shared checkout before placements): files (in placements) · mission pairs (the 10 with most files) · mission requests with Worker files, requests with files in no mission | 1 (0) · 1 (${MIS_A} + ${MIS_B} in ${SHARED}: 1) · 2, 0 |`,
    );
    expect(markdown).toContain(
      "| M-38 finished mission requests: changed files and no commit on the mission branch / changed files (judged by the Main's finished line / by the report's commit) · of those verified by CI or a detected check: share (verified / changed files; CI / check) · CI red · finished | 2 / 2 (0 / 2) · 0.0 % (0 / 2; 0 / 0) · 0 · 2 |",
    );
    expect(markdown).not.toContain("m37.pairs");
  });

  it("takes the index's placements, and a mission file's that the index does not hold", () => {
    expect(readStore(home).placements).toEqual({ [PLACE_A]: { missionId: MIS_A, repo: SHARED }, [PLACE_B]: { missionId: MIS_B, repo: SHARED } });
    expect(readStore(join(home, "traces")).placements).toBeUndefined();
  });
});
