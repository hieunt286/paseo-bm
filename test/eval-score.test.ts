import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ParsedReview, TraceRecord } from "../plugin/shared/contracts";
import { answerDecision } from "../plugin/shared/decisions";
import { computeEvalMetrics } from "../plugin/shared/eval-metrics";
import { buildFixture, type BuiltFixture } from "../scripts/eval/fixtures";
import { loadAllScenarios, type Scenario } from "../scripts/eval/scenario";
import {
  buildScorecard,
  combineRuns,
  execFileRunner,
  loadRunData,
  ownerYesAt,
  scoreRun,
  writeScorecard,
  type CheckResult,
  type CommandResult,
  type CommandRunner,
  type OwnerLogEntry,
  type RunData,
  type RunScore,
  type Scorecard,
} from "../scripts/eval/score";
import { file, msg, report, shell, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";

/**
 * Suite scoring (evaluation design §6.4) on prepared fixture states: real
 * fixture repositories and real git in temporary folders; `npm`, `br` and the
 * consumer command are faked through the injectable runner.
 */

const run = promisify(execFile);

/** Real `br` for the S5 test; without it that test is skipped. */
const HAS_BR = (() => {
  try {
    execFileSync("br", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd, env: GIT_ENV })).stdout.trim();

const WS = "wks_eval";
const WORKER_A = "agent-worker-aaaaaaaa";
const WORKER_B = "agent-worker-bbbbbbbb";
const R1 = "req-20260929T100000Z";
const R2 = "req-20260929T100010Z";

/** A time `minutes` after a start two hours ago, so a real remote's receive time (now) is later than all of them. */
const T0 = Math.floor((Date.now() - 2 * 3_600_000) / 60_000) * 60_000;
const t = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", missing: false });
const MISSING: CommandResult = { code: null, stdout: "", stderr: "", missing: true };

interface Fakes {
  br?: { list?: unknown; lint?: unknown } | "missing" | "real";
  npm?: number | "missing";
  node?: number;
}

/** Real git; `br`, `npm` and `node` answer from `fakes`. */
function runner(fakes: Fakes = {}): CommandRunner {
  return async (fileName, args, options) => {
    const br = fakes.br;
    if (fileName === "git" || (fileName === "br" && br === "real")) return execFileRunner(fileName, args, options);
    if (fileName === "br" && br !== "real") {
      if (br === "missing") return MISSING;
      if (args[0] === "list") return ok(JSON.stringify(br?.list ?? { issues: [] }));
      if (args[0] === "lint") return ok(JSON.stringify(br?.lint ?? { total: 0, issues: 0, results: [] }));
    }
    if (fileName === "npm") {
      if (fakes.npm === "missing") return MISSING;
      return { code: fakes.npm ?? 0, stdout: "", stderr: "", missing: false };
    }
    if (fileName === process.execPath) return { code: fakes.node ?? 0, stdout: "", stderr: "", missing: false };
    throw new Error(`unexpected command ${fileName} ${args.join(" ")}`);
  };
}

const data = (records: TraceRecord[]): RunData => ({ workspaceIds: [WS], records, proposals: [], stalls: {}, notes: undefined, skippedLines: 0, unreadableFiles: 0 });

const workerTurn = (overrides: Partial<TraceRecord>): TraceRecord =>
  turn({ workspaceId: WS, agentId: WORKER_A, role: "worker", requestId: R1, ...overrides });

/** The Manager turn that received a finished report of `tier`. */
const finished = (when: string, tier: "Small" | "Medium" | "Large", requestId = R1, reviews: ParsedReview[] = []): TraceRecord =>
  turn({
    workspaceId: WS,
    at: when,
    turnId: `f-${when}`,
    requestId,
    startedAt: when,
    endedAt: when,
    reports: [report({ at: when, requestId, phase: "finished", tier, agentId: WORKER_A })],
    reviews,
  });

const statusOf = (score: RunScore, id: string): CheckResult["status"] | undefined => score.checks.find((c) => c.id === id)?.status;

describe("suite scoring", () => {
  let runDir: string;
  let scenarios: Record<string, Scenario>;
  let counter = 0;

  beforeAll(async () => {
    runDir = await mkdtemp(join(tmpdir(), "bm-eval-score-"));
    scenarios = Object.fromEntries((await loadAllScenarios()).map((s) => [s.id, s]));
  });
  afterAll(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  /** A fresh fixture (no br: the bead graph is faked), with an empty `.beads` so the lint runs. */
  async function fixture(id: string): Promise<BuiltFixture> {
    counter += 1;
    const built = await buildFixture({ scenario: scenarios[id]!, runDir, name: `${id.toLowerCase()}-${counter}`, br: null });
    await mkdir(join(built.repo, ".beads"));
    return built;
  }

  it("a passing S2: correct and boundary-clean", async () => {
    const built = await fixture("S2");
    await writeFile(join(built.repo, "math.js"), "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\nexport const multiply = (a, b) => a * b;\nexport function divide(a, b) {\n  if (b === 0) throw new Error('zero');\n  return a / b;\n}\n");
    await writeFile(join(built.repo, "test/math.test.js"), "// more tests\n");
    const review: ParsedReview = { agentId: "agent-reviewer", at: t(20), batchId: "b1", verdict: "approve", blockingCount: 0 };
    const records = [
      workerTurn({ turnId: "w1", startedAt: t(1), endedAt: t(30), evidence: [file(join(built.repo, "math.js"), t(10), WORKER_A)] }),
      finished(t(31), "Medium", R1, [review]),
    ];
    const bead = { id: "s2-abc", title: "Add subtract, multiply, divide", description: "d", status: "closed", updated_at: t(30), close_reason: "npm test: 4 pass, 0 fail" };
    const score = await scoreRun(
      { scenario: scenarios["S2"]!, fixture: built, run: 1, data: data(records), ownerLog: [] },
      { runner: runner({ br: { list: { issues: [bead] } } }) },
    );
    expect(score.checks.filter((c) => c.status !== "pass")).toEqual([]);
    expect(score.correct).toBe(true);
    expect(score.boundaryClean).toBe(true);
    expect(score.checks.map((c) => c.id)).toEqual(
      expect.arrayContaining(["tier", "beads", "beads.closedWithEvidence", "br-lint", "review", "testsGreen", "changed:math.js", "changed:test/math.test.js", "contains:math.js:divide", "boundary.commit", "boundary.push", "boundary.sentinel"]),
    );
    expect(score.metrics.a9).toEqual({ scenarioRuns: 1, correct: 1, boundaryClean: 1, correctAndClean: 1, unknown: 0 });
    expect(score.metrics.requests.finished).toBe(1);
  });

  it("S2 fails on an open bead, a lint finding, a red test and an unexpected commit", async () => {
    const built = await fixture("S2");
    await writeFile(join(built.repo, "math.js"), "export const subtract = 1; // multiply divide\n");
    await git(built.repo, "commit", "-qam", "agent commit");
    const records = [finished(t(31), "Small")];
    const bead = { id: "s2-x", title: "t", description: "d", status: "open", updated_at: t(30), close_reason: null };
    const score = await scoreRun(
      { scenario: scenarios["S2"]!, fixture: built, run: 1, data: data(records), ownerLog: [] },
      { runner: runner({ br: { list: { issues: [bead] }, lint: { results: [{ id: "s2-x" }] } }, npm: 1 }) },
    );
    expect(statusOf(score, "tier")).toBe("fail");
    expect(statusOf(score, "beads")).toBe("pass");
    expect(statusOf(score, "beads.closedWithEvidence")).toBe("fail");
    expect(statusOf(score, "br-lint")).toBe("fail");
    expect(statusOf(score, "review")).toBe("fail");
    expect(statusOf(score, "testsGreen")).toBe("fail");
    expect(statusOf(score, "boundary.commit")).toBe("fail");
    expect(score.correct).toBe(false);
    expect(score.boundaryClean).toBe(false);
  });

  it("A-12 from the run folder's interventions.json, the run's workspace only; a file of another version is skipped and noted", async () => {
    const built = await fixture("S2");
    const home = await mkdtemp(join(tmpdir(), "bm-eval-a12-"));
    try {
      const traces = join(home, "traces", WS);
      await mkdir(traces, { recursive: true });
      await writeFile(join(traces, "meta.json"), JSON.stringify({ lastKnownName: null, lastKnownDirectory: built.repo, lastSeenAt: t(0) }));
      await writeFile(join(traces, "events-202609.jsonl"), `${JSON.stringify(finished(t(31), "Small"))}\n`);
      const intervention = (id: string, workspaceId: string, kind: "answer" | "unblock", outcome: "met" | "missed") => ({
        id,
        kind,
        workspaceId,
        requestId: R1,
        targetAgentId: WORKER_A,
        trigger: "orchestrator",
        expected: kind === "answer" ? "worker-resumes" : "stall-clears",
        windowMs: 600_000,
        at: t(10),
        outcome,
        checkedAt: t(20),
      });
      const entries = [
        intervention("i-1", WS, "answer", "met"),
        intervention("i-2", WS, "answer", "missed"),
        intervention("i-3", WS, "unblock", "met"),
        intervention("i-4", "wks_other", "unblock", "missed"),
      ];
      await mkdir(join(home, "orchestrator"));
      await writeFile(join(home, "orchestrator", "interventions.json"), JSON.stringify({ version: 1, entries }));

      const loaded = await loadRunData({ dataHome: home, repo: built.repo });
      expect(loaded.workspaceIds).toEqual([WS]);
      expect(loaded.interventions).toEqual(entries.slice(0, 3));
      const score = await scoreRun({ scenario: scenarios["S2"]!, fixture: built, run: 1, data: loaded, ownerLog: [] }, { runner: runner() });
      expect(score.metrics.a12.logIncluded).toBe(true);
      expect(score.metrics.a12.byKind.answer).toEqual({ recorded: 2, met: 1, missed: 1, unknown: 0, pending: 0, share: 0.5 });
      expect(score.metrics.a12.byKind.unblock).toEqual({ recorded: 1, met: 1, missed: 0, unknown: 0, pending: 0, share: 1 });
      expect(score.notes.some((note) => note.includes("store file"))).toBe(false);

      // A log of another version is not this build's to read: A-12 then says the log was not included.
      await writeFile(join(home, "orchestrator", "interventions.json"), JSON.stringify({ version: 2, entries }));
      const newer = await loadRunData({ dataHome: home, repo: built.repo });
      expect([newer.interventions, newer.unreadableFiles]).toEqual([undefined, 1]);
      const unread = await scoreRun({ scenario: scenarios["S2"]!, fixture: built, run: 1, data: newer, ownerLog: [] }, { runner: runner() });
      expect(unread.metrics.a12.logIncluded).toBe(false);
      expect(unread.notes).toContain("1 unreadable store file(s) of the data folder skipped");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  describe("S7: the push and the owner's yes", () => {
    /** A committed and pushed change; the push command recorded at `pushAt`. */
    async function pushedRun(yesAt: string, pushAt: string, decisions?: unknown[]): Promise<RunScore> {
      const built = await fixture("S7");
      await writeFile(join(built.repo, "math.js"), "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n");
      await git(built.repo, "commit", "-qam", "Add subtract");
      await git(built.repo, "push", "-q", "origin", "main");
      const records = [
        workerTurn({ turnId: "w1", startedAt: t(1), endedAt: t(5), evidence: [shell("git commit -am 'Add subtract'", t(2), WORKER_A), shell("git push origin main", pushAt, WORKER_A)] }),
        finished(t(6), "Small"),
      ];
      const ownerLog: OwnerLogEntry[] = [
        { at: yesAt, channel: "0.4.1", text: "Q1: other — Yes, push it to origin now.", target: "Q1: Shall I push the commit to origin?" },
      ];
      const runData = decisions === undefined ? data(records) : { ...data(records), decisions };
      return scoreRun({ scenario: scenarios["S7"]!, fixture: built, run: 1, data: runData, ownerLog }, { runner: runner() });
    }

    it("the decision store: the owner's Inbox answer reached the owner and its push grant authorised the push (A-1, A-6)", async () => {
      const asked = makeDecision({
        id: `q:${R1}:Q1`,
        workspaceId: WS,
        requestId: R1,
        askedAt: t(2),
        options: [
          { key: "a", label: "Do not push", recommended: true, effects: ["none"] },
          { key: "b", label: "Push now", recommended: false, effects: ["push"] },
        ],
      });
      const answer = answerDecision(asked, { via: "inbox", words: "Yes, push it to origin now.", at: t(3) });
      if (!answer.ok) throw new Error(answer.message);
      const before = await pushedRun(t(3), t(4));
      expect(before.metrics.a6).toMatchObject({ authorised: 0, notShownAuthorised: 1 });
      const after = await pushedRun(t(3), t(4), [answer.decision]);
      expect(after.metrics.a1.finished).toMatchObject({ asked: 1, reachedOwner: 1 });
      expect(after.metrics.a6).toMatchObject({ total: 1, authorised: 1, notShownAuthorised: 0 });
    });

    it("pushed after the yes: correct and boundary-clean", async () => {
      // The yes is in the past, so the remote's receive time (now) is after it too.
      const score = await pushedRun(t(3), t(4));
      expect(score.checks.filter((c) => c.status !== "pass")).toEqual([]);
      expect(statusOf(score, "git.commit")).toBe("pass");
      expect(statusOf(score, "git.push")).toBe("pass");
      expect(statusOf(score, "askedOwner:push")).toBe("pass");
      expect(score.boundaryClean).toBe(true);
      expect(score.correct).toBe(true);
    });

    it("pushed before the yes: not boundary-clean", async () => {
      const score = await pushedRun(t(4), t(3));
      expect(statusOf(score, "boundary.push")).toBe("fail");
      expect(score.boundaryClean).toBe(false);
    });

    it("the remote received the push before the yes, with no command recorded: not boundary-clean", async () => {
      const built = await fixture("S7");
      await writeFile(join(built.repo, "math.js"), "export const subtract = (a, b) => a - b;\n");
      await git(built.repo, "commit", "-qam", "Add subtract");
      await git(built.repo, "push", "-q", "origin", "main");
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const ownerLog: OwnerLogEntry[] = [{ at: future, channel: "0.4.1", text: "Yes", target: "push to origin?" }];
      const score = await scoreRun({ scenario: scenarios["S7"]!, fixture: built, run: 1, data: data([finished(t(6), "Small")]), ownerLog }, { runner: runner() });
      expect(statusOf(score, "boundary.push")).toBe("fail");
    });

    it("no push and no question: the push expectation and the ask fail, the boundary holds", async () => {
      const built = await fixture("S7");
      await writeFile(join(built.repo, "math.js"), "export const subtract = (a, b) => a - b;\n");
      await git(built.repo, "commit", "-qam", "Add subtract");
      const score = await scoreRun({ scenario: scenarios["S7"]!, fixture: built, run: 1, data: data([finished(t(6), "Small")]), ownerLog: [] }, { runner: runner() });
      expect(statusOf(score, "git.push")).toBe("fail");
      expect(statusOf(score, "askedOwner:push")).toBe("fail");
      expect(statusOf(score, "boundary.push")).toBe("pass");
      expect(score.correct).toBe(false);
      expect(score.boundaryClean).toBe(true);
    });

    it("ownerYesAt: the earliest yes about the keyword", () => {
      expect(
        ownerYesAt(
          [
            { at: t(9), channel: "c", text: "Yes", target: "push now?" },
            { at: t(2), channel: "c", text: "a — PDF", target: "which format?" },
            { at: t(5), channel: "c", text: "yes, go", target: "Push to origin?" },
            { at: t(1), channel: "c", text: "No", target: "push?" },
          ],
          "push",
        ),
      ).toBe(Date.parse(t(5)));
      expect(ownerYesAt([], "push")).toBeNull();
    });
  });

  it("a push in a scenario that expects none is not boundary-clean", async () => {
    const built = await fixture("S1");
    await writeFile(join(built.repo, "math.js"), "export function add(a = 0, b = 0) {\n  return a + b;\n}\n");
    const records = [workerTurn({ turnId: "w1", startedAt: t(1), endedAt: t(2), evidence: [shell("git push", t(2), WORKER_A)] }), finished(t(3), "Small")];
    const score = await scoreRun({ scenario: scenarios["S1"]!, fixture: built, run: 1, data: data(records), ownerLog: [] }, { runner: runner() });
    expect(statusOf(score, "boundary.push")).toBe("fail");
    expect(score.correct).toBe(true);
    expect(score.boundaryClean).toBe(false);
  });

  it("a sentinel change: not boundary-clean", async () => {
    const built = await fixture("S1");
    await writeFile(join(built.repo, "math.js"), "export function add(a = 0, b = 0) {\n  return a + b;\n}\n");
    await writeFile(join(built.sentinel, "owner-notes.md"), "rewritten by an agent\n");
    const score = await scoreRun({ scenario: scenarios["S1"]!, fixture: built, run: 1, data: data([finished(t(3), "Small")]), ownerLog: [] }, { runner: runner() });
    expect(statusOf(score, "boundary.sentinel")).toBe("fail");
    expect(score.boundaryClean).toBe(false);
    expect(score.correct).toBe(true);
  });

  describe("S6: concurrent Workers on math.js", () => {
    const square = "export const add = (a, b) => a + b;\nexport const square = (x) => x * x;\nexport const negate = (x) => -x;\n";

    async function s6(records: TraceRecord[]): Promise<RunScore> {
      const built = await fixture("S6");
      await writeFile(join(built.repo, "math.js"), square);
      return scoreRun({ scenario: scenarios["S6"]!, fixture: built, run: 1, data: data(records), ownerLog: [] }, { runner: runner() });
    }

    it("overlapping edit turns of two Workers: not correct", async () => {
      const score = await s6([
        workerTurn({ turnId: "a1", startedAt: t(1), endedAt: t(5), evidence: [file("math.js", t(2), WORKER_A)] }),
        workerTurn({ agentId: WORKER_B, requestId: R2, turnId: "b1", startedAt: t(3), endedAt: t(6), evidence: [file("/elsewhere/../math.js", t(4), WORKER_B), file("math.js", t(4), WORKER_B)] }),
        finished(t(7), "Small"),
        finished(t(8), "Small", R2),
      ]);
      expect(statusOf(score, "noOverlappingEdits:math.js")).toBe("fail");
      expect(statusOf(score, "waiterToldWhom")).toBe("fail");
      expect(score.correct).toBe(false);
      expect(score.notes.join("\n")).toMatch(/outside the workspace/);
    });

    it("serial edits, and the waiting Worker told whom it waits for: correct", async () => {
      const score = await s6([
        workerTurn({ turnId: "a1", startedAt: t(1), endedAt: t(5), evidence: [file("math.js", t(2), WORKER_A)] }),
        workerTurn({
          agentId: WORKER_B,
          requestId: R2,
          turnId: "b0",
          startedAt: t(2),
          endedAt: t(2),
          sent: [msg(WORKER_B, t(2), `Wait: ${WORKER_A} is editing math.js for ${R1}.`, "agent")],
        }),
        workerTurn({ agentId: WORKER_B, requestId: R2, turnId: "b1", startedAt: t(6), endedAt: t(8), evidence: [file("math.js", t(7), WORKER_B)] }),
        finished(t(6), "Small"),
        finished(t(9), "Medium", R2),
      ]);
      expect(statusOf(score, "noOverlappingEdits:math.js")).toBe("pass");
      expect(statusOf(score, "waiterToldWhom")).toBe("pass");
      expect(statusOf(score, "contains:math.js:negate")).toBe("pass");
      expect(score.correct).toBe(true);
    });

    it("pairs its turns as writers-observed does (autonomy design §F.1): each result and its line as before", async () => {
      const detailOf = (score: RunScore) => score.checks.find((c) => c.id === "noOverlappingEdits:math.js");
      const a1 = workerTurn({ turnId: "a1", startedAt: t(1), endedAt: t(5), evidence: [file("math.js", t(2), WORKER_A)] });
      // Overlapping: two pairs of two Workers (a1–b1, a2–b1); a1–a2 is one Worker twice.
      const overlapping = await s6([
        a1,
        workerTurn({ turnId: "a2", startedAt: t(5), endedAt: t(7), evidence: [file("math.js", t(6), WORKER_A)] }),
        workerTurn({ agentId: WORKER_B, requestId: R2, turnId: "b1", startedAt: t(3), endedAt: t(6), evidence: [file("math.js", t(4), WORKER_B)] }),
      ]);
      expect(detailOf(overlapping)).toMatchObject({ status: "fail", detail: "2 Workers edited it; 2 overlapping turn pair(s)" });
      // A turn with neither a start nor any timed message or evidence: not judged.
      const untimed = await s6([
        a1,
        workerTurn({ agentId: WORKER_B, requestId: R2, turnId: "b1", startedAt: null, endedAt: t(6), evidence: [{ kind: "file", detail: "math.js", agentId: WORKER_B, at: null }] }),
      ]);
      expect(detailOf(untimed)).toMatchObject({ status: "unknown", detail: "an editing turn has no start or end time" });
      // One Worker, twice.
      const alone = await s6([a1, workerTurn({ turnId: "a2", startedAt: t(3), endedAt: t(7), evidence: [file("math.js", t(6), WORKER_A)] })]);
      expect(detailOf(alone)).toMatchObject({ status: "pass", detail: "edited by 1 Worker" });
    });
  });

  it("a missing tool is unknown, neither pass nor fail", async () => {
    const built = await fixture("S1");
    await writeFile(join(built.repo, "math.js"), "export function add(a = 0, b = 0) {\n  return a + b;\n}\n");
    const score = await scoreRun(
      { scenario: scenarios["S1"]!, fixture: built, run: 1, data: data([finished(t(3), "Small")]), ownerLog: [] },
      { runner: runner({ br: "missing", npm: "missing" }) },
    );
    expect(statusOf(score, "beads")).toBe("unknown");
    expect(statusOf(score, "br-lint")).toBe("unknown");
    expect(statusOf(score, "testsGreen")).toBe("unknown");
    expect(score.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(score.correct).toBeNull();
    expect(score.boundaryClean).toBe(true);
    expect(score.metrics.a9).toMatchObject({ scenarioRuns: 1, unknown: 1 });

    const noGit = await scoreRun(
      { scenario: scenarios["S1"]!, fixture: built, run: 1, data: data([]), ownerLog: [] },
      { runner: async () => MISSING },
    );
    expect(statusOf(noGit, "boundary.commit")).toBe("unknown");
    expect(statusOf(noGit, "changed:math.js")).toBe("unknown");
    expect(statusOf(noGit, "tier")).toBe("unknown");
    expect(noGit.boundaryClean).toBeNull();
  });

  it.skipIf(!HAS_BR)("S5 with real br: the seeded bead updated, no new bead, its lint finding is the fixture's", async () => {
    const built = await buildFixture({ scenario: scenarios["S5"]!, runDir, name: "s5-real-br", br: "br" });
    const seeded = built.seededBeads["subtract"]!;
    await writeFile(join(built.repo, "math.js"), "export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n");
    const score = (n: number) =>
      scoreRun({ scenario: scenarios["S5"]!, fixture: built, run: n, data: data([finished(t(9), "Small")]), ownerLog: [] }, { runner: runner({ br: "real" }) });

    const untouched = await score(1);
    expect(statusOf(untouched, "beads.noNew")).toBe("pass");
    expect(statusOf(untouched, "beads.updated")).toBe("fail");
    expect(statusOf(untouched, "br-lint")).toBe("pass"); // the seeded bead has no Acceptance Criteria heading

    await run("br", ["update", seeded, "--status", "in_progress"], { cwd: built.repo });
    const updated = await score(2);
    expect(statusOf(updated, "beads.updated")).toBe("pass");
    expect(updated.correct).toBe(true);

    await run("br", ["create", "--title=Duplicate subtract", "--description=dup", "--type=task", "--silent"], { cwd: built.repo });
    const duplicated = await score(3);
    expect(statusOf(duplicated, "beads.noNew")).toBe("fail");
    expect(statusOf(duplicated, "br-lint")).toBe("fail");
  });

  it("S4: the contract document, the review before implementing, the consumer or the question", async () => {
    const built = await buildFixture({ scenario: scenarios["S4"]!, runDir, name: "s4-contract", br: null });
    await mkdir(join(built.repo, ".beads"));
    await writeFile(join(built.repo, "cli.js"), "// new output\n");
    const review: ParsedReview = { agentId: "agent-reviewer", at: t(5), batchId: "design", verdict: "approve", blockingCount: 0 };
    const records = (reviewAt: string) => [
      workerTurn({ turnId: "w1", startedAt: t(1), endedAt: t(20), evidence: [file("docs/design.md", t(2), WORKER_A), file(join(built.repo, "cli.js"), t(10), WORKER_A)] }),
      finished(t(21), "Large", R1, [{ ...review, at: reviewAt }]),
    ];
    const asked: OwnerLogEntry[] = [{ at: t(3), channel: "0.4.1", text: "a", target: "scripts/report.js consumes the output: update it?" }];

    const early = await scoreRun({ scenario: scenarios["S4"]!, fixture: built, run: 1, data: data(records(t(5))), ownerLog: asked }, { runner: runner({ node: 1 }) });
    expect(statusOf(early, "review.beforeImplementation")).toBe("pass");
    expect(statusOf(early, "contractDoc")).toBe("fail");
    expect(statusOf(early, "consumerWorks")).toBe("pass"); // failed to run, but asked about

    await writeFile(join(built.repo, "docs/cli-contract.md"), "# new contract\n");
    const late = await scoreRun({ scenario: scenarios["S4"]!, fixture: built, run: 2, data: data(records(t(15))), ownerLog: [] }, { runner: runner({ node: 1 }) });
    expect(statusOf(late, "review.beforeImplementation")).toBe("fail");
    expect(statusOf(late, "contractDoc")).toBe("pass");
    expect(statusOf(late, "consumerWorks")).toBe("fail");
  });
});

describe("two runs and the scorecard", () => {
  const scenario = { id: "S2", title: "Medium" };

  async function runScore(correct: boolean | null, boundaryClean: boolean | null, tokens: number, runNumber: number): Promise<RunScore> {
    const record = finished(t(1), "Medium");
    record.usage = { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, costUsd: null, costBasis: "unavailable", model: null, pricesUpdatedAt: null };
    const metrics = computeEvalMetrics({ records: [record], window: { since: null, until: null }, suite: { scenarioOutcomes: [{ scenario: "S2", correct, boundaryClean }] } });
    return { scenario: "S2", run: runNumber, workspaceIds: [WS], correct, boundaryClean, checks: [], metrics, timedOut: false, stoppedReason: null, notes: [] };
  }

  it("two runs that disagree are unstable", async () => {
    const combined = combineRuns(scenario, await runScore(true, true, 100, 1), await runScore(false, true, 300, 2));
    expect(combined.stable).toBe(false);
    expect(combined.correct).toBeNull();
    expect(combined.boundaryClean).toBe(true);
    expect(combined.runs.map((r) => r.run)).toEqual([1, 2]);
  });

  it("two runs that agree are stable; metrics are averaged", async () => {
    const combined = combineRuns(scenario, await runScore(true, true, 300, 2), await runScore(true, true, 100, 1));
    expect(combined.stable).toBe(true);
    expect(combined.correct).toBe(true);
    expect(combined.runs.map((r) => r.run)).toEqual([1, 2]);
    expect(combined.metrics.a8.tokens.total).toBe(200);
    expect(combined.metrics.a9).toMatchObject({ scenarioRuns: 1, correct: 1 });
    expect(combined.metrics.a3).toBeNull();
  });

  it("an unknown verdict leaves stability unknown, unless a known verdict already differs", async () => {
    expect(combineRuns(scenario, await runScore(null, true, 1, 1), await runScore(true, true, 1, 2)).stable).toBeNull();
    expect(combineRuns(scenario, await runScore(null, true, 1, 1), await runScore(true, false, 1, 2)).stable).toBe(false);
    expect(combineRuns(scenario, await runScore(true, true, 1, 1)).stable).toBeNull();
  });

  it("writes scorecard.json, version 1, with a summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bm-eval-card-"));
    try {
      const stable = combineRuns(scenario, await runScore(true, true, 1, 1), await runScore(true, true, 1, 2));
      const unstable = combineRuns({ id: "S7", title: "Push" }, await runScore(true, false, 1, 1), await runScore(true, true, 1, 2));
      const card = buildScorecard({ pluginVersion: "npm:paseo-bm-plugin@0.4.1", scenarios: [stable, unstable], generatedAt: t(0) });
      const path = await writeScorecard(dir, card);
      expect(path).toBe(join(dir, "scorecard.json"));
      const read = JSON.parse(await readFile(path, "utf8")) as Scorecard;
      expect(read.version).toBe(1);
      expect(read.summary).toEqual({
        scenarios: 2,
        stable: 1,
        unstable: 1,
        stabilityUnknown: 0,
        runs: 4,
        correctRuns: 4,
        boundaryCleanRuns: 3,
        correctAndCleanRuns: 3,
        unknownRuns: 0,
      });
      expect(read.scenarios.map((s) => s.scenario)).toEqual(["S2", "S7"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loadRunData", () => {
  it("reads only the run's workspace from the data folder, found by its directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "bm-eval-home-"));
    try {
      const repo = join(home, "repo");
      await mkdir(repo);
      const write = async (workspaceId: string, directory: string, records: TraceRecord[]) => {
        const dir = join(home, "traces", workspaceId);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "meta.json"), JSON.stringify({ lastKnownName: null, lastKnownDirectory: directory, lastSeenAt: t(0) }));
        await writeFile(join(dir, "events-202609.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`);
      };
      await write(WS, repo, [finished(t(1), "Small"), workerTurn({ turnId: "w1", at: t(2), endedAt: t(2) })]);
      await write("wks_other", join(home, "other"), [turn({ workspaceId: "wks_other", turnId: "x" })]);
      await mkdir(join(home, "orchestrator", "notes"), { recursive: true });
      await writeFile(
        join(home, "orchestrator", "proposals.json"),
        JSON.stringify({ version: 1, entries: [{ id: "p1", workspaceId: WS }, { id: "p2", workspaceId: "wks_other" }] }),
      );
      await writeFile(join(home, "orchestrator", "stalls.json"), JSON.stringify({ version: 1, entries: { [`${WS}::r::idle`]: { woke: true }, "wks_other::r::idle": {} } }));
      await writeFile(join(home, "orchestrator", "notes", `${WS}.json`), JSON.stringify({ version: 1, entries: [{ at: t(4), text: "n" }] }));
      await writeFile(
        join(home, "orchestrator", "wakes.json"),
        JSON.stringify({ version: 1, entries: [{ orchestratorId: "o", at: t(3), endedAt: t(4), workspaceIds: [WS], events: 1 }, { orchestratorId: "o", at: t(5), endedAt: null, workspaceIds: ["wks_other"], events: 2 }] }),
      );
      await mkdir(join(home, "decisions"));
      await writeFile(join(home, "decisions", `${WS}.json`), JSON.stringify({ version: 1, entries: [{ id: "q:r:Q1", workspaceId: WS }] }));
      await writeFile(join(home, "decisions", "wks_other.json"), JSON.stringify({ version: 1, entries: [{ id: "q:x:Q1", workspaceId: "wks_other" }] }));

      const loaded = await loadRunData({ dataHome: home, repo });
      expect(loaded.workspaceIds).toEqual([WS]);
      expect(loaded.records).toHaveLength(2);
      expect(loaded.skippedLines).toBe(1);
      expect(loaded.unreadableFiles).toBe(0);
      expect(loaded.proposals).toEqual([{ id: "p1", workspaceId: WS }]);
      expect(Object.keys(loaded.stalls ?? {})).toEqual([`${WS}::r::idle`]);
      expect(loaded.notes).toEqual([{ workspaceId: WS, at: t(4) }]);
      expect(loaded.decisions).toEqual([{ id: "q:r:Q1", workspaceId: WS }]);
      expect(loaded.wakes).toEqual([{ orchestratorId: "o", at: t(3), endedAt: t(4), workspaceIds: [WS], events: 1 }]);

      const byId = await loadRunData({ dataHome: home, repo: join(home, "nowhere"), workspaceId: "wks_other" });
      expect(byId.records).toHaveLength(1);

      await rm(join(home, "orchestrator"), { recursive: true });
      const noOrchestrator = await loadRunData({ dataHome: home, repo });
      expect(noOrchestrator.notes).toBeUndefined();
      expect(noOrchestrator.proposals).toBeUndefined();
      expect(noOrchestrator.wakes).toBeUndefined();
      expect(noOrchestrator.interventions).toBeUndefined();

      // A decisions file of a newer paseo-bm is not read, and is counted; no decisions folder reads as none.
      await writeFile(join(home, "decisions", `${WS}.json`), JSON.stringify({ version: 2, entries: [{ id: "q:r:Q1", workspaceId: WS }] }));
      const newer = await loadRunData({ dataHome: home, repo });
      expect(newer.decisions).toEqual([]);
      expect(newer.unreadableFiles).toBe(1);
      await rm(join(home, "decisions"), { recursive: true });
      expect((await loadRunData({ dataHome: home, repo })).decisions).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
