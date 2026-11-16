import { describe, expect, it } from "vitest";
import type { Evidence } from "../plugin/shared/contracts";
import { checksVerified, isFinishedUnverified, namedChecksOf, requestFinishOf, verificationOf, type VerificationInput, type VerificationRecord } from "../plugin/shared/evidence";
import { checkLabelText, checksText, verificationDetailLines } from "../plugin/client/verification-view";
import { verifiedOf } from "../plugin/server/line-state";

/**
 * Detected, self-reported and unverified report claims (autonomy design §C.2,
 * §C.6; REQ-130; bead bm-autonomy-phase3-7gxw.3). The shell shapes are the
 * ones captured per provider at §C.1: Claude `status` only, Codex `status`
 * and `exitCode`, OpenCode `completed` with the exit code alone telling a
 * failure.
 */
const WORKER = "agent-worker";
const WORKSPACE = "/home/owner/repo";

const at = (minute: number) => `2026-09-30T10:${String(minute).padStart(2, "0")}:00.000Z`;

type ShellFacts = Pick<Evidence, "status" | "exitCode" | "callId">;
const shell = (command: string, minute: number, facts: ShellFacts = { status: "completed" }): Evidence => ({ kind: "shell", detail: command, agentId: WORKER, at: at(minute), ...facts });
const edit = (path: string, minute: number): Evidence => ({ kind: "file", detail: path, agentId: WORKER, at: at(minute) });
const record = (...evidence: Evidence[]): VerificationRecord => ({ agentId: WORKER, endedAt: at(59), evidence });

function verify(buildAndTests: string | null, evidence: Evidence[], report: Partial<VerificationInput["report"]> = {}, workspaceDirectory: string | null = WORKSPACE) {
  return verificationOf({ report: { buildAndTests, filesChanged: [], beadsClosed: [], ...report }, records: [record(...evidence)], workspaceDirectory });
}

const labelOf = (buildAndTests: string, evidence: Evidence[]) => verify(buildAndTests, evidence).named[0]?.label;

describe("named checks", () => {
  it("are the backtick spans of buildAndTests, normalised, once each", () => {
    expect(namedChecksOf("`npm test` pass; `npm  run lint` pass; `npm test` pass again")).toEqual(["npm test", "npm run lint"]);
    expect(namedChecksOf("``npm test`` pass")).toEqual(["npm test"]);
    expect(namedChecksOf("npm test pass")).toEqual([]);
    expect(namedChecksOf(null)).toEqual([]);
  });
});

describe("a reused check (ADR-045 decision 13)", () => {
  const reusedClause = "`npm test` pass, reused from the run before the rebase";

  it("is reused when its clause says so and an earlier passing run exists, before the last edit", () => {
    const result = verify(reusedClause, [shell("npm test", 1), edit("src/a.ts", 2)]);
    expect(result.named).toEqual([{ check: "npm test", label: "reused" }]);
    expect(result.checks).toBe("reused");
  });

  it("is reused when the run came after the last edit but before a handoff", () => {
    const records: VerificationRecord[] = [
      { agentId: "agent-old", role: "worker", endedAt: at(10), evidence: [edit("src/a.ts", 1), { ...shell("npm test", 2), agentId: "agent-old" }] },
      { agentId: WORKER, role: "worker", startedAt: at(20), endedAt: at(30), evidence: [] },
    ];
    const result = verificationOf({ report: { buildAndTests: reusedClause, filesChanged: [], beadsClosed: [] }, records, workspaceDirectory: WORKSPACE, handoffSuccessors: new Set([WORKER]) });
    expect(result.named[0]?.label).toBe("reused");
  });

  it("counts an earlier passing run by a handed-off Worker of the request", () => {
    const records: VerificationRecord[] = [
      { agentId: "agent-old", role: "worker", endedAt: at(10), evidence: [{ ...shell("npm test", 2), agentId: "agent-old" }] },
      { agentId: WORKER, role: "worker", startedAt: at(20), endedAt: at(30), evidence: [edit("src/a.ts", 21)] },
    ];
    expect(verificationOf({ report: { buildAndTests: reusedClause, filesChanged: [], beadsClosed: [] }, records, workspaceDirectory: WORKSPACE, handoffSuccessors: new Set([WORKER]) }).checks).toBe("reused");
  });

  it("is self-reported when no such run exists, and when the earlier run failed or its status does not vouch for it", () => {
    expect(labelOf(reusedClause, [edit("src/a.ts", 2)])).toBe("self-reported");
    expect(labelOf(reusedClause, [shell("npm test", 1, { status: "failed" }), edit("src/a.ts", 2)])).toBe("self-reported");
    expect(labelOf(reusedClause, [shell("npm test | tail -5", 1), edit("src/a.ts", 2)])).toBe("self-reported");
  });

  it("counts a run under the && rule, as a detected check does", () => {
    expect(labelOf(reusedClause, [shell("npm run lint && npm test", 1), edit("src/a.ts", 2)])).toBe("reused");
  });

  it("stays detected when it ran after the last edit, even when its clause says reused", () => {
    expect(labelOf(reusedClause, [edit("src/a.ts", 1), shell("npm test", 2)])).toBe("detected");
  });

  it("reads only the check's own clause, split at a semicolon or a newline, the word on its own, case aside", () => {
    const earlier = [shell("npm test", 1), shell("npm run lint", 1), edit("src/a.ts", 2)];
    expect(verify("`npm test` pass; `npm run lint` REUSED from b1", earlier).named.map((claim) => claim.label)).toEqual(["self-reported", "reused"]);
    expect(verify("`npm test` reused from b1\n`npm run lint` pass", earlier).named.map((claim) => claim.label)).toEqual(["reused", "self-reported"]);
    expect(labelOf("`npm test` pass, not reusedfoo", earlier)).toBe("self-reported");
  });

  it("gives the verdict: detected when all are, reused when all are detected or reused with one reused, else as before", () => {
    const evidence = [shell("npm run lint", 1), edit("src/a.ts", 2), shell("npm test", 3)];
    expect(verify("`npm test` pass; `npm run lint` reused from b1", evidence).checks).toBe("reused");
    expect(verify("`npm test` pass; `npm run build` reused from b1", evidence).checks).toBe("self-reported");
    expect(verify("`npm test` pass", evidence).checks).toBe("detected");
    expect(verify("not run", evidence).checks).toBe("unverified");
  });

  it("is not finished-unverified and reads verified with CI off", () => {
    expect(isFinishedUnverified({ checks: "reused", changedFiles: true })).toBe(false);
    expect(checksVerified("reused")).toBe(true);
    expect(checksVerified("detected")).toBe(true);
    expect(checksVerified("self-reported")).toBe(false);
    expect(checksVerified(null)).toBe(false);
    expect(verifiedOf({ ci: "off", committed: true, aheadOfOrigin: null, checks: "reused" })).toBe("verified");
    expect(verifiedOf({ ci: "off", committed: false, aheadOfOrigin: null, checks: "reused" })).toBe("unverified");
  });

  it("shows on the card's and Work's lines", () => {
    const verification = { checks: "reused" as const, named: [{ check: "npm test", label: "reused" as const }], files: [], beads: [], changedFiles: true, unverified: false, reportAt: at(5) };
    expect(checkLabelText(verification, { label: "reused" })).toBe("reused");
    expect(checksText(verification)).toBe("npm test — reused");
    expect(verificationDetailLines(verification)).toEqual(["Checks: reused", "Check: npm test — reused"]);
  });
});

describe("a named check (design §C.2)", () => {
  it("is detected when the same command ran after the last edit and succeeded", () => {
    const result = verify("`npm test` pass", [edit("src/a.ts", 1), shell("npm test", 2)]);
    expect(result.named).toEqual([{ check: "npm test", label: "detected" }]);
    expect(result.checks).toBe("detected");
  });

  it("is detected whatever the spacing", () => {
    expect(labelOf("`npm  test   --  -t x` pass", [edit("src/a.ts", 1), shell("  npm test -- -t   x ", 2)])).toBe("detected");
  });

  it("is self-reported when it ran only before the last edit", () => {
    const result = verify("`npm test` pass", [shell("npm test", 1), edit("src/a.ts", 2)]);
    expect(result.named[0]?.label).toBe("self-reported");
    expect(result.checks).toBe("self-reported");
  });

  it("is detected with no edit at all, when it succeeded", () => {
    expect(labelOf("`npm test` pass", [shell("npm test", 1)])).toBe("detected");
  });

  it("keeps the timeline order when every time fell back to the record's write time", () => {
    const tied = (evidence: Evidence): Evidence => ({ ...evidence, at: null });
    expect(labelOf("`npm test` pass", [tied(edit("src/a.ts", 0)), tied(shell("npm test", 0))])).toBe("detected");
    expect(labelOf("`npm test` pass", [tied(shell("npm test", 0)), tied(edit("src/a.ts", 0))])).toBe("self-reported");
  });

  it.each([
    ["Claude: failed, no exit code", { status: "failed" }],
    ["Codex: exit code 1", { status: "failed", exitCode: 1 }],
    ["OpenCode: completed with exit code 3", { status: "completed", exitCode: 3 }],
    ["still running", { status: "running" }],
  ] satisfies Array<[string, ShellFacts]>)("is self-reported when the run failed — %s", (_shape, facts) => {
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), shell("npm test", 2, facts)])).toBe("self-reported");
  });

  it.each([
    ["Claude: completed", { status: "completed" }],
    ["Codex: exit code 0", { status: "completed", exitCode: 0 }],
    ["an exit code of 0 decides whatever the status", { status: "failed", exitCode: 0 }],
  ] satisfies Array<[string, ShellFacts]>)("is detected when the run succeeded — %s", (_shape, facts) => {
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), shell("npm test", 2, facts)])).toBe("detected");
  });

  it("is never detected piped, whether named or run", () => {
    expect(labelOf("`npm test | tail -5` pass", [edit("src/a.ts", 1), shell("npm test | tail -5", 2)])).toBe("self-reported");
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), shell("npm test | tail -5", 2)])).toBe("self-reported");
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), shell("npm test 2>&1 | tail -5", 2)])).toBe("self-reported");
  });

  it("counts a segment of a line joined only by && (change-008 C5)", () => {
    const run = [edit("src/a.ts", 1), shell("npm run build && npm test", 2)];
    const result = verify("`npm test` pass; `npm run build` pass; `npm run build && npm test` pass", run);
    expect(result.named.map((claim) => claim.label)).toEqual(["detected", "detected", "detected"]);
    expect(result.checks).toBe("detected");
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), shell("cd /home/owner/repo && npm test", 2)])).toBe("detected");
  });

  it("does not count a segment of a line joined by ;, || or &", () => {
    for (const line of ["npm test; echo done", "npm test || true", "npm run build; npm test", "npm test & wait"]) {
      expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), shell(line, 2)]), line).toBe("self-reported");
    }
    expect(labelOf("`npm test; echo done` pass", [edit("src/a.ts", 1), shell("npm test; echo done", 2)])).toBe("self-reported");
  });

  it("keeps quoted arguments as written: a different filter is a different check", () => {
    expect(labelOf('`npm test -- -t "a; b"` pass', [edit("src/a.ts", 1), shell('npm test -- -t "a; b"', 2)])).toBe("detected");
    expect(labelOf('`npm test -- -t "evidence"` pass', [edit("src/a.ts", 1), shell('npm test -- -t "other"', 2)])).toBe("self-reported");
  });

  it("reads a running then a completed entry of one callId as one completed call, placed where it began", () => {
    const running = shell("npm test", 2, { status: "running", callId: "toolu_1" });
    const completed = shell("npm test", 3, { status: "completed", callId: "toolu_1" });
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), running, completed])).toBe("detected");
    // The same call, begun before an edit that ended while it ran, did not see the edit.
    expect(labelOf("`npm test` pass", [shell("npm test", 1, { status: "running", callId: "toolu_2" }), edit("src/a.ts", 2), shell("npm test", 3, { status: "completed", callId: "toolu_2" })])).toBe("self-reported");
    // Its latest state wins: completed, then failed.
    expect(labelOf("`npm test` pass", [edit("src/a.ts", 1), running, shell("npm test", 3, { status: "failed", callId: "toolu_1" })])).toBe("self-reported");
  });

  it("counts a run in any record of the request, the Reviewer's included", () => {
    const worker = record(edit("src/a.ts", 1));
    const reviewer: VerificationRecord = { agentId: "agent-reviewer", endedAt: at(30), evidence: [{ ...shell("npm test", 20), agentId: "agent-reviewer" }] };
    const result = verificationOf({ report: { buildAndTests: "`npm test` pass", filesChanged: [], beadsClosed: [] }, records: [worker, reviewer], workspaceDirectory: WORKSPACE });
    expect(result.checks).toBe("detected");
  });
});

describe("the request's checks", () => {
  it("are detected only when every named check is", () => {
    const result = verify("`npm test` pass; `npm run lint` pass", [edit("src/a.ts", 1), shell("npm test", 2)]);
    expect(result.named).toEqual([
      { check: "npm test", label: "detected" },
      { check: "npm run lint", label: "self-reported" },
    ]);
    expect(result.checks).toBe("self-reported");
  });

  it.each([null, "not run", "`not run`", "none — docs only", "skipped", "n/a"])("are unverified when the report says nothing ran: %o", (value) => {
    expect(verify(value, [edit("docs/a.md", 1), shell("git status", 2)]).checks).toBe("unverified");
  });

  it("are self-reported when named only in words", () => {
    const result = verify("npm test pass", [edit("src/a.ts", 1), shell("npm test", 2)]);
    expect(result.named).toEqual([]);
    expect(result.checks).toBe("self-reported");
  });

  it("are not checked when the request's shell entries carry no status (recorded before §C.1)", () => {
    const old = (command: string, minute: number): Evidence => ({ kind: "shell", detail: command, agentId: WORKER, at: at(minute) });
    expect(verify("`npm test` pass", [edit("src/a.ts", 1), old("npm test", 2)]).checks).toBe("not-checked");
    expect(verify("not run", [edit("src/a.ts", 1), old("git status", 2)]).checks).toBe("not-checked");
    // One entry with a status is enough to judge.
    expect(verify("`npm test` pass", [edit("src/a.ts", 1), old("git status", 2), shell("npm test", 3)]).checks).toBe("detected");
  });

  it("are judged as usual when the request ran no command at all", () => {
    expect(verify("`npm test` pass", [edit("src/a.ts", 1)]).checks).toBe("self-reported");
    expect(verify("not run", [edit("src/a.ts", 1)]).checks).toBe("unverified");
  });
});

describe("files changed (REQ-130)", () => {
  it("is detected when an edit or write entry names it, else self-reported", () => {
    const result = verify("not run", [edit("src/a.ts", 1)], { filesChanged: ["src/a.ts", "src/b.ts"] });
    expect(result.files).toEqual([
      { path: "src/a.ts", label: "detected" },
      { path: "src/b.ts", label: "self-reported" },
    ]);
  });

  it("matches an absolute path recorded by Claude with the relative path of the report (change-008 C5)", () => {
    const result = verify("not run", [edit("/home/owner/repo/plugin/shared/evidence.ts", 1)], { filesChanged: ["plugin/shared/evidence.ts", "./plugin/shared/shell.ts"] });
    expect(result.files.map((file) => file.label)).toEqual(["detected", "self-reported"]);
    expect(verify("not run", [edit("plugin/./shared/evidence.ts", 1)], { filesChanged: ["/home/owner/repo/plugin/shared/evidence.ts"] }, "/home/owner/repo/").files[0]?.label).toBe("detected");
  });

  it("does not match a file of the same name in another folder", () => {
    expect(verify("not run", [edit("/home/owner/other/src/a.ts", 1)], { filesChanged: ["src/a.ts"] }).files[0]?.label).toBe("self-reported");
  });

  it("without the workspace folder, matches a relative path to an absolute one ending in it", () => {
    expect(verify("not run", [edit("/home/owner/repo/src/a.ts", 1)], { filesChanged: ["src/a.ts"] }, null).files[0]?.label).toBe("detected");
    expect(verify("not run", [edit("/home/owner/repo/xsrc/a.ts", 1)], { filesChanged: ["src/a.ts"] }, null).files[0]?.label).toBe("self-reported");
  });

  it("says the request changed files when the report names one or a record edited one", () => {
    expect(verify("not run", []).changedFiles).toBe(false);
    expect(verify("not run", [], { filesChanged: ["src/a.ts"] }).changedFiles).toBe(true);
    expect(verify("not run", [edit("src/a.ts", 1)]).changedFiles).toBe(true);
  });
});

describe("beads closed (REQ-130)", () => {
  it("is detected with a successful br close naming it", () => {
    const result = verify("not run", [shell('br close bm-a1 bm-b2 --reason "npm test: 12 passed"', 1)], { beadsClosed: ["bm-a1", "bm-b2", "bm-c3"] });
    expect(result.beads).toEqual([
      { id: "bm-a1", label: "detected" },
      { id: "bm-b2", label: "detected" },
      { id: "bm-c3", label: "self-reported" },
    ]);
  });

  it("is self-reported when the close failed or is missing", () => {
    expect(verify("not run", [shell("br close bm-a1 --reason x", 1, { status: "failed" })], { beadsClosed: ["bm-a1"] }).beads[0]?.label).toBe("self-reported");
    expect(verify("not run", [shell("br close bm-a1 --reason x", 1, { status: "completed", exitCode: 2 })], { beadsClosed: ["bm-a1"] }).beads[0]?.label).toBe("self-reported");
    expect(verify("not run", [shell("br update bm-a1 --status in_progress", 1)], { beadsClosed: ["bm-a1"] }).beads[0]?.label).toBe("self-reported");
    expect(verify("not run", [shell("br close bm-a1 --dry-run", 1)], { beadsClosed: ["bm-a1"] }).beads[0]?.label).toBe("self-reported");
  });

  it("reads a close inside a line joined by && only", () => {
    expect(verify("not run", [shell("br close bm-a1 --reason x && br sync --flush-only", 1)], { beadsClosed: ["bm-a1"] }).beads[0]?.label).toBe("detected");
    expect(verify("not run", [shell("br close bm-a1 --reason x | tail -2", 1)], { beadsClosed: ["bm-a1"] }).beads[0]?.label).toBe("self-reported");
  });
});

describe("a request's finish (design §C.3; bead 7gxw.4)", () => {
  type Claims = Pick<VerificationInput["report"], "buildAndTests" | "filesChanged" | "beadsClosed">;
  const reportAt = (minute: number, phase: "finished" | "received" | "blocked" | null, claims: Partial<Claims> = {}) => ({
    at: at(minute),
    phase,
    buildAndTests: "`npm test` pass",
    filesChanged: ["src/a.ts"],
    beadsClosed: [],
    ...claims,
  });
  const finishOf = (reports: ReturnType<typeof reportAt>[], evidence: Evidence[]) =>
    requestFinishOf({ reports, records: [record(...evidence)], workspaceDirectory: WORKSPACE });

  it("labels the latest report when it is finished: unverified while code changed and a named check was not detected", () => {
    const finish = finishOf([reportAt(1, "received"), reportAt(5, "finished")], [edit("src/a.ts", 2)]);
    expect(finish).toMatchObject({ reportAt: at(5), checks: "self-reported", changedFiles: true, unverified: true });
    expect(finishOf([reportAt(5, "finished")], [edit("src/a.ts", 2), shell("npm test", 3)])).toMatchObject({ checks: "detected", unverified: false });
    // Said to have run nothing: unverified too.
    expect(finishOf([reportAt(5, "finished", { buildAndTests: "not run" })], [edit("src/a.ts", 2)])).toMatchObject({ checks: "unverified", unverified: true });
  });

  it("is never unverified without changed code, nor for a request that is not checked", () => {
    expect(finishOf([reportAt(5, "finished", { filesChanged: [] })], [])).toMatchObject({ checks: "self-reported", changedFiles: false, unverified: false });
    expect(finishOf([reportAt(5, "finished")], [edit("src/a.ts", 2), shell("npm test", 3, {})])).toMatchObject({ checks: "not-checked", unverified: false });
    expect(isFinishedUnverified({ checks: "not-checked", changedFiles: true })).toBe(false);
    expect(isFinishedUnverified({ checks: "self-reported", changedFiles: true })).toBe(true);
    expect(isFinishedUnverified({ checks: "detected", changedFiles: true })).toBe(false);
  });

  it("is none while the latest report with a milestone is not finished: a later report ends it", () => {
    expect(finishOf([reportAt(5, "finished"), reportAt(6, "received")], [edit("src/a.ts", 2)])).toBeNull();
    expect(finishOf([reportAt(5, "blocked")], [edit("src/a.ts", 2)])).toBeNull();
    expect(finishOf([], [edit("src/a.ts", 2)])).toBeNull();
    // A report whose milestone could not be read is not a later report; of two at one time, the later one counts.
    expect(finishOf([reportAt(5, "finished"), reportAt(6, null)], [edit("src/a.ts", 2)])).toMatchObject({ reportAt: at(5) });
    expect(finishOf([reportAt(5, "received"), reportAt(5, "finished")], [edit("src/a.ts", 2)])).toMatchObject({ reportAt: at(5) });
    expect(finishOf([reportAt(5, "finished"), reportAt(5, "received")], [edit("src/a.ts", 2)])).toBeNull();
  });
});
