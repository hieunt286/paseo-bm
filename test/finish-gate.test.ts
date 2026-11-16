import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { finishGateLineOf, finishGateOf, readFinishGate, type FinishGateBatch, type FinishGateInput, type FinishGateReport, type FinishGateRequest } from "../plugin/server/finish-gate";
import { clearJsonFileCache } from "../plugin/server/data-files";
import type { Placement } from "../plugin/server/mission-store";
import { createRequestRegistry, clearRequestRegistryCache } from "../plugin/server/request-registry";
import type { GitRunner } from "../plugin/server/repo-tool";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { Evidence, ParsedReport } from "../plugin/shared/contracts";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { fakePaseo } from "./helpers/fake-paseo";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { turn } from "./fixtures/orchestrator-traces";

/**
 * The finish gate (ADR-045 decision 2, mission line plan §5.2): one named
 * reason per failing condition, read over the continuation chain, failing
 * closed. `readFinishGate` over real stores and a fake git.
 */

afterEach(() => {
  clearRequestRegistryCache();
  clearJsonFileCache();
  clearTraceStoreCache();
  removeDataFolders();
});

const WS = "wks_1";
const REQ1 = "req-20261110T100000Z";
const REQ2 = "req-20261110T110000Z";
const WORKER = "agent-worker";
const SHA = "abc1234";
const AT = "2026-11-10T12:00:00.000Z";
const CHECKS = "`npm test` passed";

const report = (over: Partial<FinishGateReport> = {}): FinishGateReport => ({ at: AT, phase: "finished", tier: "Medium", filesChanged: [], beadsClosed: [], reviewFindingsOpen: null, buildAndTests: null, ...over });
const batch = (verdict: string | null, over: Partial<FinishGateBatch> = {}): FinishGateBatch => ({ batchId: "b1", milestone: "finished", results: verdict === null ? [] : [{ at: AT, recordId: "r1", verdict, blocking: 0 }], ...over });
const request = (requestId: string, over: Partial<FinishGateRequest> = {}): FinishGateRequest => ({ requestId, tier: "Medium", batches: [], traceReviews: [], reports: [], ...over });
const shell = (command: string, at: string, agentId = WORKER): Evidence => ({ kind: "shell", detail: command, agentId, at, status: "completed", exitCode: 0 });
const edit = (path: string, at: string, agentId = WORKER): Evidence => ({ kind: "file", detail: path, agentId, at });
const reviewed = (over: Partial<FinishGateReport> = {}): FinishGateRequest => request(REQ1, { batches: [batch("pass")], reports: [report({ filesChanged: ["a.ts"], buildAndTests: CHECKS, integration: { commit: SHA }, ...over })] });
const checked = [{ agentId: WORKER, endedAt: AT, evidence: [edit("a.ts", "2026-11-10T11:00:00.000Z"), shell("npm test", "2026-11-10T11:30:00.000Z")] }];

function input(over: Partial<FinishGateInput>): FinishGateInput {
  return { chain: [], records: [], workspaceDirectory: "/repo", inPlacement: true, committed: { committed: true }, ci: "off", unreadable: [], ...over };
}

describe("finishGateOf: what passes", () => {
  it("a request with no predecessor and no changed file passes", () => {
    expect(finishGateOf(input({ chain: [request(REQ1, { reports: [report()] })], committed: null, inPlacement: false }))).toEqual({ passed: true, reasons: [] });
  });

  it("a reviewed, checked, committed request passes", () => {
    expect(finishGateOf(input({ chain: [reviewed()], records: checked }))).toEqual({ passed: true, reasons: [] });
  });

  it("a Small chain with changed files needs no review", () => {
    const chain = [request(REQ1, { tier: "Small", reports: [report({ tier: "Small", filesChanged: ["a.ts"], buildAndTests: CHECKS, integration: { commit: SHA } })] })];
    expect(finishGateOf(input({ chain, records: checked }))).toEqual({ passed: true, reasons: [] });
  });

  it("a no-file continuation of a reviewed, committed, checked predecessor passes on its chain", () => {
    const chain = [reviewed(), request(REQ2, { tier: "Small", reports: [report({ tier: "Small" })] })];
    expect(finishGateOf(input({ chain, records: checked }))).toEqual({ passed: true, reasons: [] });
  });

  it("the head's report goes first for the commit and for the checks", () => {
    const chain = [reviewed({ integration: { commit: "old" }, buildAndTests: "`old check` passed" }), request(REQ2, { batches: [batch("pass", { batchId: "b2" })], reports: [report({ filesChanged: ["b.ts"], buildAndTests: CHECKS, integration: { commit: SHA } })] })];
    expect(finishGateOf(input({ chain, records: checked }))).toEqual({ passed: true, reasons: [] });
  });
});

describe("finishGateOf: one named reason per condition", () => {
  const fails = (over: Partial<FinishGateInput>, reason: string) => {
    const verdict = finishGateOf(input(over));
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons).toEqual([reason]);
  };

  it("the head's finished with remaining", () => {
    fails({ chain: [request(REQ1, { reports: [report({ remaining: ["the rest"] })] })] }, "it left work for a continuation");
  });

  it("changed files of a Medium or Large chain with no review batch", () => {
    fails({ chain: [{ ...reviewed(), batches: [] }], records: checked }, "the changed files have no wave or finished review");
  });

  it("a plan batch never counts as review, nor a batch with no milestone", () => {
    fails({ chain: [{ ...reviewed(), batches: [batch("pass", { milestone: "plan" })] }], records: checked }, "the changed files have no wave or finished review");
    fails({ chain: [{ ...reviewed(), batches: [{ batchId: "b1", results: [{ at: AT, recordId: "r", verdict: "pass", blocking: 0 }] }] }], records: checked }, "the changed files have no wave or finished review");
  });

  it("a newest batch whose latest result is no pass", () => {
    fails({ chain: [{ ...reviewed(), batches: [batch("pass"), batch("changes-required", { batchId: "b2" })] }], records: checked }, "review batch b2 has not passed");
    fails({ chain: [{ ...reviewed(), batches: [batch(null)] }], records: checked }, "review batch b1 has not passed");
  });

  it("a batch that passed after a failing result counts by its latest", () => {
    const results = [{ at: AT, recordId: "r1", verdict: "changes-required", blocking: 1 }, { at: AT, recordId: "r2", verdict: "pass", blocking: 0 }];
    expect(finishGateOf(input({ chain: [{ ...reviewed(), batches: [batch(null, { results })] }], records: checked })).passed).toBe(true);
  });

  it("an adopted batch that has not passed, even on a Small no-file continuation", () => {
    const chain = [reviewed(), request(REQ2, { tier: "Small", batches: [batch("changes-required", { adoptedFrom: REQ1 })], reports: [report({ tier: "Small" })] })];
    fails({ chain, records: checked }, "adopted review batch b1 has not passed");
  });

  it("a copy adopted again is the later request's to clear", () => {
    const REQ3 = "req-20261110T120000Z";
    const chain = [
      reviewed(),
      request(REQ2, { batches: [batch("changes-required", { adoptedFrom: REQ1 })], reports: [report({ filesChanged: [] })] }),
      request(REQ3, { batches: [batch("pass", { adoptedFrom: REQ2 })], reports: [report()] }),
    ];
    expect(finishGateOf(input({ chain, records: checked }))).toEqual({ passed: true, reasons: [] });
  });

  it("review findings still open", () => {
    fails({ chain: [reviewed({ reviewFindingsOpen: "b1: fix it" })], records: checked }, "review findings are still open");
  });

  it("changed files with checks self-reported, or named by no report", () => {
    fails({ chain: [reviewed()], records: [] }, "its checks are self-reported, neither detected nor reused");
    fails({ chain: [reviewed({ buildAndTests: "not run" })], records: checked }, "no report of the chain names its checks");
  });

  it("changed files with no commit, not committed, or outside a placement", () => {
    fails({ chain: [reviewed({ integration: {} })], records: checked, committed: null }, "the changed files have no reported commit");
    fails({ chain: [reviewed()], records: checked, committed: null }, "the reported commit could not be read");
    fails({ chain: [reviewed()], records: checked, committed: { committed: false, why: "the worktree has changes not committed" } }, "the changed files are not committed: the worktree has changes not committed");
    fails({ chain: [reviewed()], records: checked, inPlacement: false, committed: null }, "files changed outside a placement");
  });

  it("with CI on a red pipeline fails, and only with CI on", () => {
    const red = [reviewed({ integration: { commit: SHA, ci: "failure" } })];
    fails({ chain: red, records: checked, ci: "on" }, "CI failed on the reported commit");
    expect(finishGateOf(input({ chain: red, records: checked, ci: "off" })).passed).toBe(true);
  });

  it("a green or pending pipeline does not replace a missing local check", () => {
    for (const ci of ["success", "pending"] as const) {
      fails({ chain: [reviewed({ integration: { commit: SHA, ci } })], records: [], ci: "on" }, "its checks are self-reported, neither detected nor reused");
    }
  });

  it("what cannot be read fails, with its reason", () => {
    fails({ chain: [request(REQ1, { reports: [report()] })], unreadable: ["request x of its chain could not be read"] }, "request x of its chain could not be read");
    expect(finishGateOf(input({ chain: [request(REQ1)] }))).toEqual({ passed: false, reasons: ["the finished report could not be read"] });
    fails({ chain: [request(REQ1, { reports: [report({ phase: "received" })] })] }, "the newest report is not finished");
  });
});

describe("finishGateOf: a reported commit is a change, with no file named or edited (ADR-045 decisions 2 and 4)", () => {
  const ran = [{ agentId: WORKER, endedAt: AT, evidence: [shell("npm test", AT)] }];
  const shellOnly = (over: Partial<FinishGateReport> = {}, tier: "Small" | "Medium" = "Medium") => [request(REQ1, { tier, batches: tier === "Small" ? [] : [batch("pass")], reports: [report({ tier, buildAndTests: CHECKS, integration: { commit: SHA }, ...over })] })];
  const gate = (over: Partial<FinishGateInput>) => finishGateOf(input({ chain: shellOnly(), records: ran, ...over }));

  it("reviewed, checked and committed, it passes", () => {
    expect(gate({})).toEqual({ passed: true, reasons: [] });
  });

  it("a commit not committed fails, the case that reached the local merge", () => {
    expect(gate({ committed: { committed: false, why: `${SHA} is not in the history of m/ABC/fe` } })).toEqual({ passed: false, reasons: [`the changed files are not committed: ${SHA} is not in the history of m/ABC/fe`] });
  });

  it("a commit no review passed fails, on a Medium or Large chain", () => {
    expect(gate({ chain: [{ ...shellOnly()[0]!, batches: [] }] })).toEqual({ passed: false, reasons: ["the changed files have no wave or finished review"] });
    expect(gate({ chain: [{ ...shellOnly()[0]!, batches: [batch("changes-required")] }] })).toEqual({ passed: false, reasons: ["review batch b1 has not passed"] });
  });

  it("a commit whose checks did not run fails, even a Small one", () => {
    expect(gate({ chain: shellOnly({}, "Small"), records: [] })).toEqual({ passed: false, reasons: ["its checks are self-reported, neither detected nor reused"] });
    expect(gate({ chain: shellOnly({ buildAndTests: "not run" }, "Small") })).toEqual({ passed: false, reasons: ["no report of the chain names its checks"] });
  });

  it("a commit whose reading failed, or made outside a placement, fails", () => {
    expect(gate({ committed: null })).toEqual({ passed: false, reasons: ["the reported commit could not be read"] });
    expect(gate({ inPlacement: false, committed: null })).toEqual({ passed: false, reasons: ["files changed outside a placement"] });
  });

  it("a no-file continuation of a shell-only commit is judged on that commit", () => {
    const chain = [...shellOnly(), request(REQ2, { tier: "Small", reports: [report({ tier: "Small" })] })];
    expect(gate({ chain, committed: { committed: false, why: "the worktree has changes not committed" } }).reasons).toEqual(["the changed files are not committed: the worktree has changes not committed"]);
  });
});

describe("finishGateOf: read over the chain", () => {
  it("a no-file continuation whose predecessor rolled over with unreviewed changes fails", () => {
    const chain = [request(REQ1, { reports: [report({ filesChanged: ["a.ts"], buildAndTests: CHECKS, integration: { commit: SHA }, remaining: ["more"] })] }), request(REQ2, { tier: "Small", reports: [report({ tier: "Small" })] })];
    expect(finishGateOf(input({ chain, records: checked }))).toEqual({ passed: false, reasons: ["the changed files have no wave or finished review"] });
  });

  it("a report that names no file while its records show an edit is treated as changed", () => {
    const chain = [request(REQ1, { reports: [report({ buildAndTests: CHECKS, tier: "Small" })] })];
    const records = [{ agentId: WORKER, endedAt: AT, evidence: [edit("a.ts", AT)] }];
    expect(finishGateOf(input({ chain, records, committed: null })).reasons).toEqual(["its checks are self-reported, neither detected nor reused", "the changed files have no reported commit"]);
  });

  it("a green check before the last edit is not detected, and passes only when reported as reused", () => {
    const records = [{ agentId: WORKER, endedAt: AT, evidence: [shell("npm test", "2026-11-10T11:00:00.000Z"), edit("a.ts", "2026-11-10T11:30:00.000Z")] }];
    expect(finishGateOf(input({ chain: [reviewed()], records })).reasons).toEqual(["its checks are self-reported, neither detected nor reused"]);
    expect(finishGateOf(input({ chain: [reviewed({ buildAndTests: "`npm test` reused" })], records })).passed).toBe(true);
  });

  it("the line a failed gate adds", () => {
    expect(finishGateLineOf(["a", "b"])).toBe("finish gate not passed: a; b");
  });
});

describe("readFinishGate over the stores", () => {
  const BRANCH = "m/ABC/fe";
  const git: GitRunner = async (args) => {
    const command = args.join(" ");
    if (command.includes("--abbrev-ref")) return { stdout: `${BRANCH}\n` };
    if (command.includes("rev-parse")) return { stdout: `${SHA}\n` };
    return { stdout: "" };
  };
  const place = { repo: "wks_repo", workspaceId: WS, directory: "/repo", branch: BRANCH, target: "main", base: "origin/main", worktreeSlug: "s", state: "ready", requestKey: "k", createdAt: AT, deps: { cloned: [], at: null, note: null }, integration: null } as Placement;
  const parsed = (over: Partial<ParsedReport>): ParsedReport => ({ agentId: WORKER, at: AT, requestId: REQ1, phase: "finished", tier: "Medium", filesChanged: ["a.ts"], beadsCreated: [], beadsUpdated: [], beadsClosed: [], beadsReady: [], reviewFindingsOpen: null, buildAndTests: "`npm test` reused", skillsUsed: [], blockers: null, guardrail: null, integration: { commit: SHA }, unparsedFields: [], incompleteFields: [], ...over }) as ParsedReport;

  function requestWithPassedBatch(home: string, init: Parameters<ReturnType<typeof createRequestRegistry>["generate"]>[1] = { managerId: "m" }): string {
    const registry = createRequestRegistry(home, { backfill: () => [] });
    const { requestId } = registry.generate(WS, init);
    registry.addReviewCall(WS, requestId, "b1", { callId: "c1", kind: "create", reviewerId: "r", at: AT }, "brief", "finished");
    registry.addReviewResult(WS, requestId, "b1", { at: AT, recordId: "r1", verdict: "pass", blocking: 0 });
    return requestId;
  }
  const live = { agentId: WORKER, endedAt: AT, evidence: [] as Evidence[] };
  const deps = { git, log: () => {} };
  const location = (home: string) => ({ tracesDir: join(home, "traces") });

  it("a reused check whose run lies outside the live tail passes, from the records", async () => {
    const home = dataFolder();
    const requestId = requestWithPassedBatch(home);
    await appendRecord(location(home), turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId, at: "2026-11-10T09:00:00.000Z", endedAt: "2026-11-10T09:00:00.000Z", evidence: [shell("npm test", "2026-11-10T09:00:00.000Z"), edit("/repo/a.ts", "2026-11-10T09:10:00.000Z")] }));
    const verdict = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId }), place, live, paseo: fakePaseo().paseo }, deps);
    expect(verdict).toEqual({ passed: true, reasons: [], commit: SHA });
  });

  it("so does one a handed-off Worker of the request ran", async () => {
    const home = dataFolder();
    const requestId = requestWithPassedBatch(home);
    const fake = fakePaseo({ agents: [{ id: "agent-next", provider: "bm-worker/x", status: "idle", workspaceId: WS, labels: { "bm.role": "worker", "bm.requestId": requestId, "bm.handoffFrom": WORKER } }] });
    createRequestRegistry(home, { backfill: () => [] }).addWorker(WS, requestId, WORKER);
    createRequestRegistry(home, { backfill: () => [] }).addWorker(WS, requestId, "agent-next");
    await appendRecord(location(home), turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId, at: "2026-11-10T09:00:00.000Z", endedAt: "2026-11-10T09:00:00.000Z", evidence: [edit("/repo/a.ts", "2026-11-10T08:50:00.000Z"), shell("npm test", "2026-11-10T09:00:00.000Z")] }));
    const verdict = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId, agentId: "agent-next" }), place, live: { ...live, agentId: "agent-next" }, paseo: fake.paseo }, deps);
    expect(verdict).toEqual({ passed: true, reasons: [], commit: SHA });
  });

  describe("only the chain's Workers count (ADR-045 decision 2)", () => {
    const REVIEWER = "agent-reviewer";
    const workerTurn = (requestId: string) => turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId, at: "2026-11-10T09:00:00.000Z", endedAt: "2026-11-10T09:00:00.000Z", evidence: [edit("/repo/a.ts", "2026-11-10T08:50:00.000Z"), shell("npm test", "2026-11-10T09:00:00.000Z")] });

    it("a Reviewer's scratch file after the Worker's check leaves the gate passing", async () => {
      const home = dataFolder();
      const requestId = requestWithPassedBatch(home);
      await appendRecord(location(home), workerTurn(requestId));
      await appendRecord(location(home), turn({ workspaceId: WS, agentId: REVIEWER, role: "reviewer", requestId, at: "2026-11-10T09:30:00.000Z", endedAt: "2026-11-10T09:30:00.000Z", evidence: [edit("/tmp/review/scratch.ts", "2026-11-10T09:30:00.000Z", REVIEWER)] }));
      const verdict = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId, buildAndTests: CHECKS }), place, live, paseo: fakePaseo().paseo }, deps);
      expect(verdict).toEqual({ passed: true, reasons: [], commit: SHA });
    });

    it("a Reviewer's own green run is no check of the step", async () => {
      const home = dataFolder();
      const requestId = requestWithPassedBatch(home);
      await appendRecord(location(home), turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId, at: "2026-11-10T09:00:00.000Z", endedAt: "2026-11-10T09:00:00.000Z", evidence: [edit("/repo/a.ts", "2026-11-10T09:00:00.000Z")] }));
      await appendRecord(location(home), turn({ workspaceId: WS, agentId: REVIEWER, role: "reviewer", requestId, at: "2026-11-10T09:30:00.000Z", endedAt: "2026-11-10T09:30:00.000Z", evidence: [shell("npm test", "2026-11-10T09:30:00.000Z", REVIEWER)] }));
      const verdict = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId, buildAndTests: CHECKS }), place, live, paseo: fakePaseo().paseo }, deps);
      expect(verdict).toEqual({ passed: false, reasons: ["its checks are self-reported, neither detected nor reused"], commit: SHA });
    });

    it("the reporting Worker's live tail still counts, though it names no role", async () => {
      const home = dataFolder();
      const requestId = requestWithPassedBatch(home);
      const liveCheck = { agentId: WORKER, endedAt: AT, evidence: [edit("/repo/a.ts", "2026-11-10T11:00:00.000Z"), shell("npm test", "2026-11-10T11:30:00.000Z")] };
      const verdict = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId, buildAndTests: CHECKS }), place, live: liveCheck, paseo: fakePaseo().paseo }, deps);
      expect(verdict).toEqual({ passed: true, reasons: [], commit: SHA });
    });
  });

  it("reads a predecessor's report and commit from the records for a no-file continuation", async () => {
    const home = dataFolder();
    const first = requestWithPassedBatch(home);
    const registry = createRequestRegistry(home, { backfill: () => [], now: () => new Date("2026-11-10T13:00:00.000Z") });
    const { requestId } = registry.generate(WS, { managerId: "m", continuationOf: first, chainRootId: first });
    await appendRecord(location(home), turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId: first, at: "2026-11-10T09:00:00.000Z", endedAt: "2026-11-10T09:00:00.000Z", reports: [parsed({ requestId: first, buildAndTests: CHECKS })], evidence: [edit("/repo/a.ts", "2026-11-10T08:50:00.000Z"), shell("npm test", "2026-11-10T09:00:00.000Z")] }));
    const verdict = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId, tier: "Small", filesChanged: [], buildAndTests: "not run", integration: undefined }), place, live, paseo: fakePaseo().paseo }, deps);
    expect(verdict).toEqual({ passed: true, reasons: [], commit: SHA });
  });

  it("an unknown request fails closed; a CI setting is read from the store", async () => {
    const home = dataFolder();
    expect(await readFinishGate(home, { workspaceId: WS, requestId: REQ1, report: parsed({}), place: null, live, paseo: null }, deps)).toEqual({ passed: false, reasons: [`request ${REQ1} of its chain could not be read`], commit: null });
    const requestId = requestWithPassedBatch(home);
    createCoordinationStore(home).set({ key: "integration.ci", value: "on" });
    await appendRecord(location(home), turn({ workspaceId: WS, agentId: WORKER, role: "worker", requestId, at: "2026-11-10T09:00:00.000Z", endedAt: "2026-11-10T09:00:00.000Z", evidence: [shell("npm test", "2026-11-10T09:00:00.000Z")] }));
    const red = await readFinishGate(home, { workspaceId: WS, requestId, report: parsed({ requestId, filesChanged: [], integration: { commit: SHA, ci: "failure" } }), place, live, paseo: null }, deps);
    expect(red.reasons).toEqual(["CI failed on the reported commit"]);
  });
});

describe("the registry's gate fields", () => {
  it("a request this build creates carries gated, a backfilled one does not; noteFinishGate stores the result", () => {
    const home = dataFolder();
    const registry = createRequestRegistry(home, { backfill: () => [] });
    const { requestId } = registry.generate(WS, { managerId: "m" });
    expect(registry.get(WS, requestId)?.gated).toBe(true);
    expect(registry.register(WS, REQ1, { source: "agent-typed" })?.gated).toBe(true);
    expect(registry.get(WS, requestId)?.finishGate).toBeUndefined();
    const result = { passed: false, reasons: ["x"], at: AT, commit: null };
    expect(registry.noteFinishGate(WS, requestId, result)).toBe(true);
    expect(registry.get(WS, requestId)?.finishGate).toEqual(result);
    expect(registry.noteFinishGate(WS, "req-20261110T130000Z", result)).toBe(false);
  });
});
