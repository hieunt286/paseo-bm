import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TraceRecord } from "../plugin/shared/contracts";
import { overrideDecisionOf } from "../plugin/shared/decision-override";
import { answerDecision, recordReversal, type Decision, type DecisionClass, type TransitionResult } from "../plugin/shared/decisions";
import { REPLAY_SCHEMA_VERSION, parseReplayArgs, runReplay, type ReplayReport } from "../scripts/eval/replay";
import { MANAGER, WORKER, at, msg, report, turn } from "./fixtures/orchestrator-traces";
import { makeDecision } from "./helpers/decisions";

/**
 * The replay (evaluation design §5, §10): run on a temporary data folder, it
 * prints the report schema, applies each filter, skips and counts a bad line,
 * prints numbers and labels only, and leaves every file as it found it.
 */

const R1 = "req-20260926T100000Z";
const R2 = "req-20260920T090000Z";
const WS_A = "wks_alpha";
const WS_B = "wks_beta";
const SECRET_QUESTION = "Which export format should the invoice use?";
const SECRET_ANSWER_WORDS = "keep the legacy layout";
const SECRET_NOTE = "private note about the alpha project";
const SECRET_COMMAND = "private command text";
const ALPHA_DIRECTORY = "/work/private-alpha";

const blockedWithQuestions = (requestId: string): string =>
  `BM-REPORT\nrequestId: ${requestId}\nphase: blocked\ntier: Medium\n\nBM-QUESTIONS\nrequestId: ${requestId}\nQ1: ${SECRET_QUESTION}\n- a: PDF (recommended)\n- b: CSV\nQ2: Keep the date format?\n- a: Change it (recommended)\n- b: Keep it`;
const answers = (requestId: string): string => `BM-ANSWERS\nrequestId: ${requestId}\nQ1: a — PDF\nQ2: other — ${SECRET_ANSWER_WORDS}`;
const finishedText = (requestId: string): string => `BM-REPORT\nrequestId: ${requestId}\nphase: finished\ntier: Medium`;

/** One request of one workspace: asked two questions, the owner answered, it finished. */
function request(workspaceId: string, requestId: string, day: string, pluginVersion?: string): TraceRecord[] {
  const when = (minute: number) => `${day}T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const version = pluginVersion === undefined ? {} : { pluginVersion };
  const base = { workspaceId, requestId, ...version };
  return [
    turn({ ...base, at: when(1), turnId: `m-1-${requestId}`, startedAt: when(0), endedAt: when(1), sent: [msg(MANAGER, when(0), "Please export invoices", "user")] }),
    turn({ ...base, at: when(5), turnId: `m-2-${requestId}`, startedAt: when(5), endedAt: when(5), sent: [msg(MANAGER, when(5), blockedWithQuestions(requestId), "agent")] }),
    turn({
      ...base,
      agentId: WORKER,
      role: "worker",
      at: when(12),
      turnId: `w-1-${requestId}`,
      startedAt: when(10),
      endedAt: when(12),
      sent: [msg(WORKER, when(10), answers(requestId), "user")],
    }),
    turn({
      ...base,
      at: when(20),
      turnId: `m-3-${requestId}`,
      startedAt: when(20),
      endedAt: when(20),
      sent: [msg(MANAGER, when(20), finishedText(requestId), "agent")],
      reports: [report({ at: when(20), requestId, phase: "finished", tier: "Medium" })],
    }),
  ];
}

let home: string;
const run = (argv: string[]): { code: number; stdout: string; stderr: string } => {
  let stdout = "";
  let stderr = "";
  const code = runReplay(argv, { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { env: {}, homedir: () => "/nonexistent-home" });
  return { code, stdout, stderr };
};
const json = (argv: string[] = []): ReplayReport => {
  const result = run(["--home", home, "--json", ...argv]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as ReplayReport;
};

/** Every path under a folder with its mtime, directories included. */
function mtimes(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string) => {
    out[dir] = statSync(dir).mtimeMs;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[path] = statSync(path).mtimeMs;
    }
  };
  walk(root);
  return out;
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "bm-replay-"));
  const alpha = join(home, "traces", WS_A);
  const beta = join(home, "traces", WS_B);
  mkdirSync(alpha, { recursive: true });
  mkdirSync(beta, { recursive: true });
  mkdirSync(join(home, "orchestrator", "notes"), { recursive: true });
  const lines = (records: TraceRecord[]) => records.map((record) => JSON.stringify(record)).join("\n");

  writeFileSync(join(alpha, "meta.json"), JSON.stringify({ lastKnownName: "alpha|app", lastKnownDirectory: ALPHA_DIRECTORY, lastSeenAt: at(30) }));
  // Two bad lines (not JSON; JSON that is not a record) and a blank one in the middle; the final newline is not a line.
  writeFileSync(join(alpha, "events-202609.jsonl"), `${lines(request(WS_A, R1, "2026-09-26", "0.5.0"))}\n{not json\n{"v":1}\n\n`);
  writeFileSync(join(beta, "meta.json"), JSON.stringify({ lastKnownName: "beta", lastKnownDirectory: "/work/beta", lastSeenAt: at(30) }));
  writeFileSync(join(beta, "events-202609.jsonl"), `${lines(request(WS_B, R2, "2026-09-20"))}\n`);
  // Not an events file: never read.
  writeFileSync(join(beta, "notes.txt"), "not a record");

  writeFileSync(
    join(home, "orchestrator", "proposals.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: "p-1",
          at: "2026-09-26T10:03:00.000Z",
          kind: "command",
          workspaceId: WS_A,
          managerId: MANAGER,
          requestId: R1,
          situation: "stalled",
          command: SECRET_COMMAND,
          reason: "idle",
          source: "orchestrator",
          status: "sent",
          settledAt: "2026-09-26T10:03:00.000Z",
          sentText: SECRET_COMMAND,
          outcome: "sent",
          error: null,
        },
        { not: "a proposal" },
      ],
    }),
  );
  writeFileSync(
    join(home, "orchestrator", "stalls.json"),
    JSON.stringify({
      version: 1,
      entries: {
        [`${WS_A}::autopilot::autopilot-on@2026-09-26T10:02:00.000Z`]: { raisedAt: "2026-09-26T10:02:00.000Z", lastSeenAt: "2026-09-26T10:02:00.000Z", clearedAt: null, woke: true },
        [`${WS_B}::${R2}::waiting-user`]: { raisedAt: "2026-09-20T10:06:00.000Z", lastSeenAt: "2026-09-20T10:06:00.000Z", clearedAt: null, woke: true },
      },
    }),
  );
  writeFileSync(join(home, "orchestrator", "notes", `${WS_B}.json`), JSON.stringify({ version: 1, entries: [{ at: "2026-09-20T10:07:00.000Z", text: SECRET_NOTE }] }));

  // Old times everywhere, so any write during a run would show.
  const old = new Date("2020-01-01T00:00:00.000Z");
  for (const path of Object.keys(mtimes(home)).reverse()) utimesSync(path, old, old);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("replay output", () => {
  it("prints the schema: schemaVersion 1, window, filters, metrics, byWorkspace, unknowns, admission", () => {
    const out = json();
    expect(Object.keys(out)).toEqual(["schemaVersion", "window", "filters", "metrics", "byWorkspace", "unknowns", "admission"]);
    expect(out.schemaVersion).toBe(REPLAY_SCHEMA_VERSION);
    expect(out.schemaVersion).toBe(1);
    expect(out.window).toEqual({ since: null, until: null });
    expect(out.filters).toEqual({ workspaces: [], version: null });
    expect(out.metrics).not.toHaveProperty("window");
    expect(out.metrics).not.toHaveProperty("unknowns");
    expect(out.metrics.requests).toEqual({ inWindow: 2, finished: 2 });
    expect(out.metrics.a1.all.asked).toBe(4);
    expect(out.metrics.a1.all.reachedOwner).toBe(4);
    expect(out.metrics.supplementary.recommendedAgreement).toMatchObject({ answered: 4, recommended: 2, ownWords: 2 });
    expect(out.metrics.a7).toMatchObject({ notesIncluded: true, wakes: 2, actedOn: 2 });
    expect(out.byWorkspace.map((row) => [row.workspaceId, row.label, row.metrics.requests.inWindow])).toEqual([
      [WS_A, "alpha|app", 1],
      [WS_B, "beta", 1],
    ]);
    expect(Object.keys(out.unknowns)).toEqual(["store", "metrics"]);
    expect(out.unknowns.metrics.invalidProposals).toBe(1);
  });

  it("skips and counts every line that is not a record", () => {
    const out = json();
    expect(out.unknowns.store.malformedLines).toBe(3);
    expect(out.unknowns.store.unreadableFiles).toBe(0);
    expect(out.unknowns.store.duplicateRecords).toBe(0);
  });

  it("prints numbers and labels only: no message text, no path", () => {
    for (const argv of [["--json"], []]) {
      const { stdout, code } = run(["--home", home, ...argv]);
      expect(code).toBe(0);
      for (const secret of [SECRET_QUESTION, SECRET_ANSWER_WORDS, SECRET_NOTE, SECRET_COMMAND, ALPHA_DIRECTORY, "/work/beta", home, "Please export"]) {
        expect(stdout).not.toContain(secret);
      }
    }
  });

  it("prints Markdown tables by default, labels escaped", () => {
    const { stdout, code } = run(["--home", home]);
    expect(code).toBe(0);
    expect(stdout).toContain("# paseo-bm replay");
    expect(stdout).toContain("| Requests in window / finished | 2 / 2 |");
    expect(stdout).toContain("| Recommended option taken / answered | 2 / 4 (50 %) |");
    expect(stdout).toContain("| requests.inWindow | 2 |");
    expect(stdout).toContain(`| ${WS_A} | alpha\\|app | 1 | 1 | 2 | 2 | 1 / 2 |`);
    expect(stdout).toContain("| store.malformedLines | 3 |");
    // The action boundary's figures (autonomy design §D.2, change-009 C9): numbers only, one headline row and every field.
    expect(stdout).toMatch(/\| A-6 action boundary, per finished request: held \(estimate\) · unreadable \(estimate; not counting package scripts\) · held decisions \| [^|]+ \|/);
    for (const path of ["a6.scratchDeletions", "a6.held.decisions", "a6.held.ownerWaitMedianMs", "a6.estimate.heldPerFinishedRequest", "a6.estimate.unreadablePerFinishedRequest", "a6.estimate.byClass.release"]) {
      expect(stdout).toContain(`| ${path} |`);
    }
    // Split by boundary on / off / unknown per request (change-010 C9): one headline row and every field.
    expect(stdout).toMatch(/\| A-6 by action boundary: finished requests · not shown authorised \/ effectful · held decisions · held \(estimate; unreadable\) per finished request \| on: [^|]+; off: [^|]+; unknown: [^|]+ \|/);
    for (const path of ["a6.byBoundary.on.finishedRequests", "a6.byBoundary.off.held.perFinishedRequest", "a6.byBoundary.unknown.estimate.unreadablePerFinishedRequest"]) {
      expect(stdout).toContain(`| ${path} |`);
    }
  });
});

describe("replay filters", () => {
  it("--since and --until bound the window by a request's earliest activity", () => {
    const late = json(["--since", "2026-09-25"]);
    expect(late.window).toEqual({ since: "2026-09-25T00:00:00.000Z", until: null });
    expect(late.metrics.requests.inWindow).toBe(1);
    expect(late.metrics.a7.wakes).toBe(1);
    expect(late.byWorkspace.map((row) => row.workspaceId)).toEqual([WS_A]);

    const early = json(["--until", "2026-09-21T00:00:00Z"]);
    expect(early.metrics.requests.inWindow).toBe(1);
    expect(early.byWorkspace.map((row) => row.workspaceId)).toEqual([WS_B]);

    expect(json(["--since", "2026-09-27"]).metrics.requests.inWindow).toBe(0);
  });

  it("--workspace keeps the named workspaces, records and Orchestrator entries alike", () => {
    const beta = json(["--workspace", WS_B]);
    expect(beta.filters.workspaces).toEqual([WS_B]);
    expect(beta.metrics.requests.inWindow).toBe(1);
    expect(beta.metrics.a7.wakes).toBe(1);
    expect(beta.unknowns.metrics.invalidProposals).toBe(0);
    expect(beta.byWorkspace.map((row) => row.workspaceId)).toEqual([WS_B]);

    const both = json(["--workspace", WS_B, "--workspace", WS_A]);
    expect(both.metrics.requests.inWindow).toBe(2);
    expect(json(["--workspace", "wks_missing"]).metrics.requests.inWindow).toBe(0);
  });

  it("--version x.y.z keeps the records of that version and counts those without one", () => {
    const current = json(["--version", "0.5.0"]);
    expect(current.filters.version).toEqual({ kind: "release", version: "0.5.0" });
    expect(current.metrics.requests.inWindow).toBe(1);
    expect(current.byWorkspace.map((row) => row.workspaceId)).toEqual([WS_A]);
    expect(current.unknowns.store.recordsWithoutVersion).toBe(4);
    // The wake of the other workspace, days before this version wrote anything, is left out.
    expect(current.metrics.a7.wakes).toBe(1);
    expect(current.unknowns.store.orchestratorEntriesNotAttributed).toBe(3);

    expect(json(["--version", "0.4.1"]).metrics.requests.inWindow).toBe(0);
  });

  it("--version ISO..ISO is a time window, intersected with --since/--until", () => {
    const window = json(["--version", "2026-09-19..2026-09-21"]);
    expect(window.filters.version).toEqual({ kind: "window", since: "2026-09-19T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z" });
    expect(window.window).toEqual({ since: "2026-09-19T00:00:00.000Z", until: "2026-09-21T00:00:00.000Z" });
    expect(window.metrics.requests.inWindow).toBe(1);

    const openEnded = json(["--version", "2026-09-19..", "--since", "2026-09-25"]);
    expect(openEnded.window).toEqual({ since: "2026-09-25T00:00:00.000Z", until: null });
    expect(openEnded.metrics.requests.inWindow).toBe(1);
  });
});

describe("replay command line", () => {
  it("refuses a wrong argument with the usage and exit code 2", () => {
    for (const argv of [["--bogus"], ["--since", "yesterday"], ["--version", "latest"], ["--version", ".."], ["--home"], ["--version", "0.5.0", "--version", "0.4.1"]]) {
      const result = run(argv);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.stderr).toContain("usage: npm run eval:replay");
      expect(result.stdout).toBe("");
    }
  });

  it("prints the usage for --help", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--workspace <id>");
  });

  it("exits 1 when the data folder does not exist", () => {
    const result = run(["--home", join(home, "missing")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });

  it("defaults to PASEO_BM_HOME, else ~/.paseo-bm", () => {
    expect(parseReplayArgs([], { env: { PASEO_BM_HOME: home }, homedir: () => "/Users/someone" })?.home).toBe(home);
    expect(parseReplayArgs([], { env: {}, homedir: () => "/Users/someone", }))
      .toMatchObject({ home: "/Users/someone/.paseo-bm", since: null, until: null, workspaces: [], version: null, json: false });
    expect(parseReplayArgs(["--home", "data"], { env: {}, homedir: () => "/Users/someone", cwd: () => "/tmp/x" })?.home).toBe("/tmp/x/data");
  });
});

describe("replay is read-only", () => {
  it("leaves every file and folder of the data folder with its mtime", () => {
    const before = mtimes(home);
    json();
    run(["--home", home]);
    json(["--version", "0.5.0", "--workspace", WS_A, "--since", "2026-09-01", "--until", "2026-10-01"]);
    expect(mtimes(home)).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(8);
  });
});

describe("replay of a Phase 1 data folder: the decision store and the wake records", () => {
  let phase1: string;
  const SECRET_WORDS = "yes, push the private branch";
  const day = "2026-09-29";
  const when = (minute: number) => `${day}T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const R3 = "req-20260929T100000Z";

  beforeAll(() => {
    phase1 = mkdtempSync(join(tmpdir(), "bm-replay-phase1-"));
    const alpha = join(phase1, "traces", WS_A);
    mkdirSync(alpha, { recursive: true });
    mkdirSync(join(phase1, "decisions"), { recursive: true });
    mkdirSync(join(phase1, "orchestrator"), { recursive: true });
    const base = { workspaceId: WS_A, requestId: R3 };
    const records: TraceRecord[] = [
      turn({ ...base, at: when(1), turnId: "m-1", startedAt: when(0), endedAt: when(1), sent: [msg(MANAGER, when(0), "Please export invoices", "user")] }),
      turn({ ...base, at: when(5), turnId: "m-2", startedAt: when(5), endedAt: when(5), sent: [msg(MANAGER, when(5), blockedWithQuestions(R3), "agent")] }),
      turn({
        ...base,
        agentId: WORKER,
        role: "worker",
        at: when(12),
        turnId: "w-1",
        startedAt: when(10),
        endedAt: when(12),
        sent: [msg(WORKER, when(10), `BM-DELIVERY answers\nContinue ${R3}.`, "agent")],
        evidence: [{ kind: "shell", detail: "git push origin main", agentId: WORKER, at: when(11) }],
      }),
      turn({ ...base, at: when(20), turnId: "m-3", startedAt: when(20), endedAt: when(20), sent: [msg(MANAGER, when(20), finishedText(R3), "agent")], reports: [report({ at: when(20), requestId: R3, phase: "finished", tier: "Medium" })] }),
    ];
    writeFileSync(join(alpha, "meta.json"), JSON.stringify({ lastKnownName: "alpha", lastKnownDirectory: ALPHA_DIRECTORY, lastSeenAt: when(30) }));
    writeFileSync(join(alpha, "events-202609.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const question = (n: number, answer: Record<string, unknown> | null, grant: Record<string, unknown> | null) => ({
      id: `q:${R3}:Q${n}`,
      workspaceId: WS_A,
      requestId: R3,
      askedBy: { role: "worker", agentId: WORKER },
      askedAt: when(5),
      round: 1,
      question: n === 1 ? SECRET_QUESTION : "Keep the date format?",
      subject: null,
      options: [
        { key: "a", label: "PDF", recommended: true, effects: ["none"] },
        { key: "b", label: "Push", recommended: false, effects: ["push"] },
      ],
      status: answer === null ? "open" : "answered",
      settledAt: answer === null ? null : when(8),
      needsConfirmation: null,
      answer,
      grant,
      delivery: null,
      supersedes: null,
      supersededBy: null,
    });
    writeFileSync(
      join(phase1, "decisions", `${WS_A}.json`),
      JSON.stringify({
        version: 1,
        entries: [
          question(1, { by: "owner", via: "inbox", optionKey: null, words: SECRET_WORDS, at: when(8) }, { effects: ["push"], expiresAt: when(59), usedAt: null }),
          question(2, null, null),
          { id: "not a decision" },
        ],
      }),
    );
    writeFileSync(
      join(phase1, "orchestrator", "wakes.json"),
      JSON.stringify({
        version: 1,
        entries: [
          { orchestratorId: "agent-orchestrator", at: when(6), endedAt: when(7), workspaceIds: [WS_A], events: 2 },
          { orchestratorId: "agent-orchestrator", at: when(21), endedAt: when(22), workspaceIds: [WS_B], events: 1 },
        ],
      }),
    );
    mkdirSync(join(phase1, "orchestrator", "notes"), { recursive: true });
    writeFileSync(join(phase1, "orchestrator", "notes", `${WS_A}.json`), JSON.stringify({ version: 1, entries: [{ at: when(6), text: SECRET_NOTE }] }));
    const old = new Date("2020-01-01T00:00:00.000Z");
    for (const path of Object.keys(mtimes(phase1)).reverse()) utimesSync(path, old, old);
  });

  afterAll(() => {
    rmSync(phase1, { recursive: true, force: true });
  });

  const phase1Json = (argv: string[] = []): ReplayReport => {
    let stdout = "";
    let stderr = "";
    const code = runReplay(["--home", phase1, "--json", ...argv], { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) }, { env: {}, homedir: () => "/nonexistent-home" });
    expect([code, stderr]).toEqual([0, ""]);
    expect(stdout).not.toContain(SECRET_WORDS);
    expect(stdout).not.toContain(SECRET_QUESTION);
    expect(stdout).not.toContain(SECRET_NOTE);
    return JSON.parse(stdout) as ReplayReport;
  };

  it("reads the owner's Inbox answer as reaching the owner, its grant as authorising the push, and each wake over its own turn", () => {
    const before = mtimes(phase1);
    const out = phase1Json();
    expect(out.metrics.a1.finished).toMatchObject({ asked: 2, reachedOwner: 1, unanswered: 1 });
    expect(out.metrics.a6).toMatchObject({ total: 1, authorised: 1, notShownAuthorised: 0 });
    // The alpha wake saw a note within its turn; the beta wake saw nothing.
    expect(out.metrics.a7).toEqual({ approximate: false, notesIncluded: true, wakeRecordsIncluded: true, wakes: 2, actedOn: 1, noAction: 1, noActionShare: 0.5 });
    expect(out.unknowns.metrics.invalidDecisions).toBe(1);
    expect(out.byWorkspace.map((row) => [row.workspaceId, row.metrics.a7.wakes])).toEqual([
      [WS_A, 1],
      [WS_B, 1],
    ]);
    expect(mtimes(phase1)).toEqual(before);
  });

  it("--workspace keeps the decisions and wakes of that workspace only", () => {
    const beta = phase1Json(["--workspace", WS_B]);
    expect(beta.metrics.a1.all.asked).toBe(0);
    expect(beta.unknowns.metrics.invalidDecisions).toBe(0);
    expect(beta.metrics.a7).toMatchObject({ wakes: 1, actedOn: 0 });
  });
});

describe("replay of the intervention log (A-12, autonomy design §G.3)", () => {
  let log: string;
  const entry = (id: string, workspaceId: string, kind: string, outcome: string) => ({
    id,
    kind,
    workspaceId,
    requestId: R1,
    targetAgentId: WORKER,
    trigger: "orchestrator",
    expected: kind === "answer" ? "worker-resumes" : "stall-clears",
    windowMs: 600_000,
    at: "2026-09-26T10:03:00.000Z",
    outcome,
    checkedAt: "2026-09-26T10:20:00.000Z",
  });

  beforeAll(() => {
    log = mkdtempSync(join(tmpdir(), "bm-replay-interventions-"));
    mkdirSync(join(log, "traces", WS_A), { recursive: true });
    writeFileSync(join(log, "traces", WS_A, "events-202609.jsonl"), `${request(WS_A, R1, "2026-09-26").map((record) => JSON.stringify(record)).join("\n")}\n`);
    mkdirSync(join(log, "orchestrator"), { recursive: true });
    writeFileSync(
      join(log, "orchestrator", "interventions.json"),
      JSON.stringify({
        version: 1,
        entries: [entry("i-1", WS_A, "answer", "met"), entry("i-2", WS_A, "answer", "missed"), entry("i-3", WS_B, "unblock", "met"), { id: "broken" }],
      }),
    );
  });

  afterAll(() => {
    rmSync(log, { recursive: true, force: true });
  });

  it("reports A-12 per kind in JSON and in the Markdown headline; --workspace narrows it", () => {
    const out = run(["--home", log, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const report = JSON.parse(out.stdout) as ReplayReport;
    expect(report.metrics.a12.logIncluded).toBe(true);
    expect(report.metrics.a12.byKind.answer).toEqual({ recorded: 2, met: 1, missed: 1, unknown: 0, pending: 0, share: 0.5 });
    expect(report.metrics.a12.byKind.unblock).toMatchObject({ recorded: 1, met: 1, share: 1 });
    expect(report.unknowns.metrics.invalidInterventions).toBe(1);
    const narrowed = JSON.parse(run(["--home", log, "--json", "--workspace", WS_A]).stdout) as ReplayReport;
    expect(narrowed.metrics.a12.byKind.unblock.recorded).toBe(0);
    const markdown = run(["--home", log]).stdout;
    expect(markdown).toContain("| A-12 interventions met / checked, by kind | answer 1 / 2 · unblock 1 / 1 |");
    expect(markdown).toContain("| a12.byKind.answer.share | 0.50 |");
  });
});

describe("replay of the context and token figures (autonomy design §G.2)", () => {
  let heavyHome: string;
  const WS_H = "wks_heavy";
  const SECRET_REQUEST = "rewrite the private billing module";
  const requestIdOf = (index: number) => `req-20260927T1${index}0000Z`;
  const HEAVY = requestIdOf(9);
  /** Claude-shaped usage: `read` tokens read (input + cached), and output. */
  const claude = (read: number, input: number, output: number, context?: number) => ({
    inputTokens: input,
    cachedInputTokens: read - input,
    outputTokens: output,
    costUsd: null,
    costBasis: "unavailable" as const,
    model: "claude-opus-5",
    pricesUpdatedAt: null,
    ...(context === undefined ? {} : { contextUsed: context, contextMax: 200_000 }),
  });

  /**
   * Ten finished requests of one project, one Manager for all: nine light ones
   * (a Worker turn of 10,000 … 26,000 tokens read) and a heavy one whose Worker
   * reads 200,000 tokens in each of six turns of four tool calls.
   */
  function heavyStore(): TraceRecord[] {
    const records: TraceRecord[] = [];
    for (let index = 0; index <= 9; index += 1) {
      const requestId = requestIdOf(index);
      const when = (minute: number) => `2026-09-27T1${index}:${String(minute).padStart(2, "0")}:00.000Z`;
      const base = { workspaceId: WS_H, requestId, runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: null, provider: "bm-manager" } };
      const workerId = `agent-worker-${index}`;
      records.push(
        turn({ ...base, at: when(0), turnId: `m-${index}`, startedAt: when(0), toolCalls: 0, usage: claude(10_000, 10_000, 0), sent: [msg(MANAGER, when(0), SECRET_REQUEST, "user")] }),
      );
      const workerTurns = index === 9 ? [1, 2, 3, 4, 5, 6].map((minute) => ({ minute, usage: claude(200_000, 1_000, 2_000, 45_000), toolCalls: 4 })) : [{ minute: 1, usage: claude(10_000 + 2_000 * index, 500, 500), toolCalls: 1 }];
      for (const { minute, usage, toolCalls } of workerTurns) {
        records.push(turn({ ...base, agentId: workerId, role: "worker", at: when(minute), turnId: `w-${index}-${minute}`, startedAt: when(minute), toolCalls, usage }));
      }
      records.push(
        turn({ ...base, at: when(10), turnId: `f-${index}`, startedAt: when(10), sent: [msg(MANAGER, when(10), finishedText(requestId), "agent")], reports: [report({ at: when(10), requestId, phase: "finished", tier: "Medium" })] }),
      );
    }
    return records;
  }

  beforeAll(() => {
    heavyHome = mkdtempSync(join(tmpdir(), "bm-replay-context-"));
    mkdirSync(join(heavyHome, "traces", WS_H), { recursive: true });
    writeFileSync(join(heavyHome, "traces", WS_H, "events-202609.jsonl"), `${heavyStore().map((record) => JSON.stringify(record)).join("\n")}\n`);
    mkdirSync(join(heavyHome, "orchestrator"), { recursive: true });
    const wakeEntry = (hour: number, usage: unknown) => ({
      orchestratorId: "agent-orchestrator",
      at: `2026-09-27T${hour}:30:00.000Z`,
      endedAt: `2026-09-27T${hour}:31:00.000Z`,
      workspaceIds: [WS_H],
      events: 1,
      usage,
    });
    writeFileSync(
      join(heavyHome, "orchestrator", "wakes.json"),
      JSON.stringify({
        version: 1,
        entries: [
          wakeEntry(12, { inputTokens: 2_000, cachedInputTokens: 30_000, outputTokens: 500 }),
          wakeEntry(15, { inputTokens: 1_000, cachedInputTokens: 10_000, outputTokens: 300 }),
          wakeEntry(17, null),
        ],
      }),
    );
  });

  afterAll(() => {
    rmSync(heavyHome, { recursive: true, force: true });
  });

  it("finds the heavy request's compaction and handoff candidates with their estimated saving, in JSON", () => {
    const out = run(["--home", heavyHome, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const { candidates, tokensRead, contextEstimate } = (JSON.parse(out.stdout) as ReplayReport).metrics.context;
    expect(candidates.estimate).toBe(true);
    // Worker turns: nine of 10,000 … 26,000 and six of 200,000 (p75 200,000); Manager turns all 10,000;
    // requests: 20,000 … 36,000 and 1,210,000 (p80 34,000).
    expect(candidates.thresholds).toEqual({ compactTokensPerTurn: { manager: 10_000, worker: 200_000 }, handoffRequestTokens: 34_000, briefTokens: 1_500 });
    // The heavy request crosses at its first Worker turn: five more read 1,000,000 over 25 model calls,
    // which a 1,500-token brief would have cut to 37,500.
    const heavyAfter = { turns: 5, tokensRead: 1_000_000, calls: 25, callsExact: true };
    expect(candidates.handoff.rows[0]).toEqual({ workspaceId: WS_H, requestId: HEAVY, agentId: null, role: "worker", turn: 2, turns: 8, crossedAt: 210_000, after: heavyAfter, savingTokens: 962_500 });
    // The two largest light requests reach 34,000 only at their last turn: candidates with nothing to save.
    expect(candidates.handoff.rows.slice(1).map((row) => [row.requestId, row.savingTokens])).toEqual([
      [requestIdOf(7), 0],
      [requestIdOf(8), 0],
    ]);
    expect(candidates.handoff).toMatchObject({ candidates: 3, savingTokens: 962_500 });
    expect(candidates.compaction.rows[0]).toEqual({ workspaceId: WS_H, requestId: HEAVY, agentId: "agent-worker-9", role: "worker", turn: 1, turns: 6, crossedAt: 200_000, after: heavyAfter, savingTokens: 962_500 });
    // The one Manager crosses at its first turn: nine more turns of 10,000 over 9 calls.
    expect(candidates.compaction.rows[1]).toMatchObject({ agentId: MANAGER, role: "manager", turn: 1, crossedAt: 10_000, after: { turns: 9, tokensRead: 90_000, calls: 9, callsExact: true }, savingTokens: 76_500 });
    expect(candidates.compaction).toMatchObject({ candidates: 2, savingTokens: 962_500 + 76_500 });
    expect(tokensRead.heaviestRequests[0]).toMatchObject({ requestId: HEAVY, workspaceId: WS_H, tokensRead: 1_210_000, turns: 7, finished: true });
    expect(contextEstimate).toMatchObject({ reported: 6, estimated: 19, unknown: 10 });
  });

  it("keeps A-8 as recorded (input + cached + output) and adds the Orchestrator's tokens from the wake records (change-007 C6)", () => {
    const { metrics } = JSON.parse(run(["--home", heavyHome, "--json"]).stdout) as ReplayReport;
    // Managers 100,000; light Workers 162,000 read + 9 × 500 output; the heavy Worker 6 × 202,000.
    expect(metrics.a8.tokens.total).toBe(100_000 + 166_500 + 1_212_000);
    expect(metrics.context.tokensRead.total).toBe(100_000 + 162_000 + 1_200_000);
    expect(metrics.a8.orchestrator).toEqual({ wakeRecordsIncluded: true, wakes: 3, wakesWithUsage: 2, tokens: 43_800, perFinishedRequest: 4_380 });
    // A window after the wakes: none in it, so none of their tokens.
    const later = JSON.parse(run(["--home", heavyHome, "--json", "--since", "2026-09-27T18:00:00Z"]).stdout) as ReplayReport;
    expect(later.metrics.a8.orchestrator).toMatchObject({ wakes: 0, tokens: 0 });
  });

  it("prints the figures and the candidates as Markdown, numbers and ids only", () => {
    const { stdout, code } = run(["--home", heavyHome]);
    expect(code).toBe(0);
    expect(stdout).toContain("| A-8 Orchestrator tokens from its wakes (window / per finished request) | 43800 / 4380 (2 of 3 wakes read) |");
    expect(stdout).toContain("| Compaction / handoff candidates, estimated saving in tokens (an estimate) | 2, 1039000 / 3, 962500 |");
    expect(stdout).toContain("## Context and tokens");
    expect(stdout).toContain("Turns with usage: 25 — Claude 25");
    expect(stdout).toContain("| Tokens read per request, all | 10 | 29000 | 34000 | 34000 | 36000 | 1210000 |");
    expect(stdout).toContain("### Compaction and handoff candidates (an estimate)");
    expect(stdout).toContain(`| handoff | ${WS_H} | ${HEAVY} | worker | 2 / 8 | 210000 | 5 | 1000000 | 25 | 962500 |`);
    expect(stdout).toContain(`| ${WS_H} | ${HEAVY} | 1210000 | 10000 | 1200000 | 0 | 7 | yes |`);
    // The context has its own section, not one row per leaf in "Every metric".
    expect(stdout).not.toContain("| context.");
    for (const secret of [SECRET_REQUEST, heavyHome, "agent-worker-9"]) expect(stdout).not.toContain(secret);
    expect(run(["--home", heavyHome, "--json"]).stdout).not.toContain(SECRET_REQUEST);
  });
});

describe("replay of delegated decisions (A-4, A-5; autonomy design §B.9)", () => {
  let delegatedHome: string;
  const R4 = "req-20260930T100000Z";
  const when = (minute: number) => `2026-09-30T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const SECRET_REASON = "your policy for the private billing scope";
  const SECRET_PRECEDENT = "always keep the private legacy invoices";
  const OVERRIDE_ID = "r:0a1b2c";
  const REOPENED_BEAD = "bm-reopened-7";
  const OPTIONS: Decision["options"] = [
    { key: "a", label: "Keep the private layout", recommended: true, effects: ["none"] },
    { key: "b", label: "Change it", recommended: false, effects: ["none"] },
  ];
  const ok = (result: TransitionResult): Decision => {
    if (!result.ok) throw new Error(result.message);
    return result.decision;
  };
  /** Worker question Qn of `R4` in `decisionClass`, opened with its predictions recorded (Phase 2). */
  const question = (n: number, decisionClass: DecisionClass): Decision =>
    makeDecision({
      id: `q:${R4}:Q${n}`,
      workspaceId: WS_A,
      requestId: R4,
      askedAt: when(5),
      question: SECRET_QUESTION,
      subject: null,
      class: decisionClass,
      options: OPTIONS,
      prediction: { recommended: { optionKey: "a" }, orchestrator: null },
    });
  const policy = (decision: Decision): Decision =>
    ok(answerDecision(decision, { by: "policy", via: "inbox", optionKey: "a", reason: SECRET_REASON, class: decision.class, predictor: "recommended", at: when(6) }));
  const precedent = (decision: Decision): Decision => ok(answerDecision(decision, { by: "precedent", via: "inbox", words: SECRET_PRECEDENT, precedentId: "p-1", at: when(6) }));
  const owner = (decision: Decision, optionKey: string): Decision => ok(answerDecision(decision, { via: "inbox", optionKey, at: when(7) }));

  beforeAll(() => {
    delegatedHome = mkdtempSync(join(tmpdir(), "bm-replay-delegated-"));
    const alpha = join(delegatedHome, "traces", WS_A);
    mkdirSync(alpha, { recursive: true });
    mkdirSync(join(delegatedHome, "decisions"), { recursive: true });
    writeFileSync(join(alpha, "events-202609.jsonl"), `${request(WS_A, R4, "2026-09-30").map((record) => JSON.stringify(record)).join("\n")}\n`);
    // `scope`: a policy answer the owner overrode, a standing one, a precedent answer reopened citing it;
    // `preference`: a standing precedent answer; the owner: two `scope` answers, one re-asked.
    const overridden = policy(question(1, "scope"));
    const entries = [
      ok(recordReversal(overridden, { kind: "overridden", at: when(8), ref: OVERRIDE_ID })),
      overrideDecisionOf(overridden, { id: OVERRIDE_ID, at: when(8) }),
      policy(question(2, "scope")),
      ok(recordReversal(precedent(question(3, "scope")), { kind: "reopened", at: when(9), ref: REOPENED_BEAD })),
      precedent(question(4, "preference")),
      ok(recordReversal(owner(question(5, "scope"), "b"), { kind: "re-asked", at: when(9), ref: `q:${R4}:Q9` })),
      owner(question(6, "scope"), "a"),
    ];
    writeFileSync(join(delegatedHome, "decisions", `${WS_A}.json`), JSON.stringify({ version: 1, entries }));
  });

  afterAll(() => {
    rmSync(delegatedHome, { recursive: true, force: true });
  });

  it("reports A-4 and A-5 per class in JSON, the owner's own reversals beside them, numbers only", () => {
    const out = run(["--home", delegatedHome, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const report = JSON.parse(out.stdout) as ReplayReport;
    expect(report.metrics.a4).toMatchObject({ delegated: 4, byPolicy: 2, byPrecedent: 2, overridden: 1, rate: 0.25 });
    expect(report.metrics.a4.byClass.scope).toEqual({ delegated: 3, byPolicy: 2, byPrecedent: 1, overridden: 1, rate: 1 / 3 });
    expect(report.metrics.a4.byClass.preference).toEqual({ delegated: 1, byPolicy: 0, byPrecedent: 1, overridden: 0, rate: 0 });
    expect(report.metrics.a4.byClass.security.rate).toBeNull();
    expect(report.metrics.a5.delegated).toMatchObject({ decisions: 4, reversed: 2, byKind: { "re-asked": 0, overridden: 1, reopened: 1 }, rate: 0.5 });
    expect(report.metrics.a5.owner).toMatchObject({ decisions: 2, reversed: 1, byKind: { "re-asked": 1, overridden: 0, reopened: 0 }, rate: 0.5 });
    expect(report.byWorkspace.map((row) => [row.workspaceId, row.metrics.a4.delegated, row.metrics.a5.owner.decisions])).toEqual([[WS_A, 4, 2]]);
    for (const secret of [SECRET_QUESTION, SECRET_REASON, SECRET_PRECEDENT, "Keep the private layout", delegatedHome]) expect(out.stdout).not.toContain(secret);
    // --workspace keeps the decisions by their project: none delegated in beta, every rate unknown.
    const beta = JSON.parse(run(["--home", delegatedHome, "--json", "--workspace", WS_B]).stdout) as ReplayReport;
    expect([beta.metrics.a4.delegated, beta.metrics.a4.rate, beta.metrics.a5.delegated.rate, beta.metrics.a5.owner.rate]).toEqual([0, null, null, null]);
  });

  it("prints them as Markdown: two headline rows and a table per class, numbers only, none in Every metric", () => {
    const { stdout, code } = run(["--home", delegatedHome]);
    expect(code).toBe(0);
    expect(stdout).toContain("| A-4 delegated decisions overridden / delegated | 1 / 4 (25.0 %) |");
    expect(stdout).toContain("| A-5 delegated decisions reversed / delegated · the owner's own reversed / answered | 2 / 4 (50.0 %) · 1 / 2 (50.0 %) |");
    expect(stdout).toContain("## Delegated decisions (A-4, A-5)");
    expect(stdout).toContain("| All classes | 4 (2 / 2) | 1 | 25.0 % | 2 (0 / 1 / 1) | 50.0 % | 2 | 1 | 50.0 % |");
    expect(stdout).toContain("| scope | 3 (2 / 1) | 1 | 33.3 % | 2 (0 / 1 / 1) | 66.7 % | 2 | 1 | 50.0 % |");
    expect(stdout).toContain("| preference | 1 (0 / 1) | 0 | 0.0 % | 0 (0 / 0 / 0) | 0.0 % | 0 | 0 | unknown |");
    expect(stdout).toContain("| security | 0 (0 / 0) | 0 | unknown | 0 (0 / 0 / 0) | unknown | 0 | 0 | unknown |");
    // The per-class figures are that table, not one row per leaf; A-5's lower bound keeps its rows.
    expect(stdout).not.toContain("| a4.");
    expect(stdout).not.toMatch(/\| a5\.(?:delegated|owner)\./);
    expect(stdout).toContain("| a5.reanswered |");
    for (const secret of [SECRET_QUESTION, SECRET_REASON, SECRET_PRECEDENT, "Keep the private layout", OVERRIDE_ID, REOPENED_BEAD, delegatedHome]) {
      expect(stdout).not.toContain(secret);
    }
  });

  it("reads a store without delegated decisions as before: A-4 and A-5's new figures unknown, never 0", () => {
    const out = json();
    expect(out.metrics.a4).toMatchObject({ delegated: 0, overridden: 0, rate: null });
    expect(out.metrics.a5).toMatchObject({ reanswered: 0, delegated: { decisions: 0, rate: null }, owner: { decisions: 0, rate: null } });
    expect(out.unknowns.metrics.ownerAnswersBeforeReversals).toBe(0);
    const markdown = run(["--home", home]).stdout;
    expect(markdown).toContain("| A-4 delegated decisions overridden / delegated | 0 / 0 (unknown) |");
    expect(markdown).toContain("| A-5 delegated decisions reversed / delegated · the owner's own reversed / answered | 0 / 0 (unknown) · 0 / 0 (unknown) |");
  });
});

describe("replay of review lift (autonomy design §C.4)", () => {
  let liftHome: string;
  const REVIEWER_ID = "agent-reviewer-private";
  const SECRET_FINDING = "the private billing module has a race";
  const RS = "req-20260928T100000Z";
  const RM = "req-20260928T110000Z";
  const when = (hour: number, minute: number) => `2026-09-28T${hour}:${String(minute).padStart(2, "0")}:00.000Z`;
  const usage = (tokens: number) => ({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, costUsd: null, costBasis: "unavailable" as const, model: null, pricesUpdatedAt: null });
  const finished = (workspaceId: string, requestId: string, hour: number, tier: "Small" | "Medium"): TraceRecord =>
    turn({ workspaceId, requestId, at: when(hour, 50), turnId: `f-${requestId}`, startedAt: when(hour, 0), reports: [report({ at: when(hour, 50), requestId, phase: "finished", tier })] });
  /** A Reviewer turn with one review, its text quoting a finding. */
  const reviewer = (workspaceId: string, requestId: string, hour: number, minute: number, batchId: string, blockingCount: number | null, tokens: number): TraceRecord =>
    turn({
      workspaceId,
      requestId,
      agentId: REVIEWER_ID,
      role: "reviewer",
      at: when(hour, minute),
      turnId: `r-${hour}-${minute}`,
      startedAt: when(hour, minute),
      usage: usage(tokens),
      received: [msg(REVIEWER_ID, when(hour, minute), `BM-REVIEW\nbatch: ${batchId}\nblocking: ${blockingCount ?? "?"}\n- ${SECRET_FINDING}`)],
      reviews: [{ agentId: REVIEWER_ID, at: when(hour, minute), batchId, verdict: blockingCount === 0 ? "approved" : "changes", blockingCount }],
    });

  beforeAll(() => {
    liftHome = mkdtempSync(join(tmpdir(), "bm-replay-lift-"));
    const write = (workspaceId: string, label: string, records: TraceRecord[]) => {
      mkdirSync(join(liftHome, "traces", workspaceId), { recursive: true });
      writeFileSync(join(liftHome, "traces", workspaceId, "meta.json"), JSON.stringify({ lastKnownName: label, lastKnownDirectory: `/work/${label}`, lastSeenAt: when(12, 0) }));
      writeFileSync(join(liftHome, "traces", workspaceId, "events-202609.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    };
    // Alpha, Small: one batch, 3 blocking findings fixed by its re-review. Beta, Medium: a batch whose count is unknown, and one reviewed once.
    write(WS_A, "alpha", [reviewer(WS_A, RS, 10, 10, "b1", 3, 4000), reviewer(WS_A, RS, 10, 20, "b1", 0, 2000), finished(WS_A, RS, 10, "Small")]);
    write(WS_B, "beta", [reviewer(WS_B, RM, 11, 10, "b1", null, 1000), reviewer(WS_B, RM, 11, 20, "b2", 1, 500), finished(WS_B, RM, 11, "Medium")]);
  });

  afterAll(() => {
    rmSync(liftHome, { recursive: true, force: true });
  });

  it("reports review lift per tier and per workspace in JSON, unknown apart, numbers only", () => {
    const out = run(["--home", liftHome, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const { reviewLift } = (JSON.parse(out.stdout) as ReplayReport).metrics;
    expect(reviewLift.byTier.Small).toMatchObject({
      requests: 1,
      reviews: 2,
      batches: 1,
      blockingFindings: 3,
      blockingPerBatch: 3,
      actedOn: { reReviewedBatches: 1, found: 3, fixed: 3, reviewedOnceBatches: 0 },
      tokens: { reviews: 2, total: 6000, perReview: 3000 },
    });
    expect(reviewLift.byTier.Medium).toMatchObject({
      batches: 2,
      blockingFindings: 1,
      blockingPerBatch: 1,
      actedOn: { reReviewedBatches: 0, reviewedOnceBatches: 2 },
      tokens: { perReview: 750 },
      unknown: { reviewsWithUnknownBlocking: 1, batchesWithUnknownBlocking: 1 },
    });
    expect(reviewLift.byTier.Large).toMatchObject({ requests: 0, reviewsPerRequest: null, blockingPerBatch: null, tokens: { perReview: null } });
    expect(reviewLift.all).toMatchObject({ requests: 2, reviews: 4, batches: 3, blockingFindings: 4, blockingPerBatch: 2, tokens: { reviews: 4, total: 7500, perReview: 1875 } });
    expect(Object.keys(reviewLift.byWorkspace)).toEqual([WS_A, WS_B]);
    expect(reviewLift.byWorkspace[WS_B]!.all).toEqual(reviewLift.byTier.Medium);
    for (const secret of [SECRET_FINDING, REVIEWER_ID, liftHome, "/work/alpha"]) expect(out.stdout).not.toContain(secret);
    // --workspace keeps that project's requests only.
    const beta = JSON.parse(run(["--home", liftHome, "--json", "--workspace", WS_B]).stdout) as ReplayReport;
    expect(beta.metrics.reviewLift.all).toEqual(reviewLift.byTier.Medium);
    expect(Object.keys(beta.metrics.reviewLift.byWorkspace)).toEqual([WS_B]);
  });

  it("prints it as Markdown: a headline row, a table per tier, the unknowns and a table per workspace, none in Every metric", () => {
    const { stdout, code } = run(["--home", liftHome]);
    expect(code).toBe(0);
    expect(stdout).toContain("| Review lift: blocking findings per batch · acted on / found on re-review · tokens per review | 2 · 3 / 3 · 1875 |");
    expect(stdout).toContain("## Review lift");
    expect(stdout).toContain("| All tiers | 2 | 4 (2) | 3 | 4 (2) | 3 / 3 (1) | 2 | 1875 (4) |");
    expect(stdout).toContain("| Small | 1 | 2 (2) | 1 | 3 (3) | 3 / 3 (1) | 0 | 3000 (2) |");
    expect(stdout).toContain("| Medium | 1 | 2 (2) | 2 | 1 (1) | 0 / 0 (0) | 2 | 750 (2) |");
    expect(stdout).toContain("| Large | 0 | 0 (unknown) | 0 | 0 (unknown) | 0 / 0 (0) | 0 | unknown (0) |");
    expect(stdout).toContain("| Medium | 0 | 1 | 1 | 0 | 0 | 0 |");
    expect(stdout).toContain("Reviewer turns without a request (in no figure): 0.");
    expect(stdout).toContain("### Review lift by workspace");
    expect(stdout).toContain(`| ${WS_A} | alpha | All tiers | 1 | 2 (2) | 1 | 3 (3) | 3 / 3 (1) | 0 | 3000 (2) |`);
    expect(stdout).toContain(`| ${WS_B} | beta | Medium | 1 | 2 (2) | 2 | 1 (1) | 0 / 0 (0) | 2 | 750 (2) |`);
    // A tier with nothing to say has no row per workspace.
    expect(stdout).not.toContain(`| ${WS_A} | alpha | Medium |`);
    expect(stdout).not.toContain("| reviewLift.");
    for (const secret of [SECRET_FINDING, REVIEWER_ID, liftHome, "/work/alpha"]) expect(stdout).not.toContain(secret);
    // Request ids are printed only for the heaviest requests and the candidates (evaluation design §5), never in this section.
    const section = stdout.slice(stdout.indexOf("## Review lift"), stdout.indexOf("## By workspace"));
    for (const id of [RS, RM]) expect(section).not.toContain(id);
  });
});

describe("writers-observed in the replay (autonomy design §F.1; evaluation design §4 Also reported; bead i8fc.1)", () => {
  let writersHome: string;
  const W1 = "agent-worker-1";
  const W2 = "agent-worker-2";
  const SECRET_PATH = "src/private-billing.js";
  const minute = (m: number) => `2026-09-26T11:${String(m).padStart(2, "0")}:00.000Z`;
  const wrote = (workspaceId: string, agentId: string, requestId: string, from: number | null, to: number, paths: string[]): TraceRecord =>
    turn({
      workspaceId,
      agentId,
      role: "worker",
      requestId,
      turnId: `${agentId}-${String(from)}`,
      startedAt: from === null ? null : minute(from),
      endedAt: minute(to),
      at: minute(to),
      evidence: paths.map((path) => ({ kind: "file" as const, detail: path, agentId, at: minute(to) })),
    });

  beforeAll(() => {
    writersHome = mkdtempSync(join(tmpdir(), "bm-replay-writers-"));
    const write = (workspaceId: string, label: string, records: TraceRecord[]) => {
      mkdirSync(join(writersHome, "traces", workspaceId), { recursive: true });
      writeFileSync(join(writersHome, "traces", workspaceId, "meta.json"), JSON.stringify({ lastKnownName: label, lastKnownDirectory: `/work/${label}`, lastSeenAt: minute(30) }));
      writeFileSync(join(writersHome, "traces", workspaceId, "events-202609.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    };
    // Alpha: two Workers on one file in overlapping turns (Claude's absolute path, Codex's relative one), and a third turn with no start.
    write(WS_A, "alpha", [
      wrote(WS_A, W1, "req-20260926T110000Z", 0, 10, [`/work/alpha/${SECRET_PATH}`]),
      wrote(WS_A, W2, "req-20260926T110100Z", 5, 15, [SECRET_PATH]),
      wrote(WS_A, "agent-worker-3", "req-20260926T110200Z", null, 12, [SECRET_PATH]),
    ]);
    // Beta: two Workers one after the other: none. (An agent lives in one project: the store de-duplicates by agent and turn.)
    write(WS_B, "beta", [wrote(WS_B, "agent-worker-b1", "req-20260926T110300Z", 0, 10, ["src/a.js"]), wrote(WS_B, "agent-worker-b2", "req-20260926T110400Z", 10, 20, ["src/a.js"])]);
  });

  afterAll(() => {
    rmSync(writersHome, { recursive: true, force: true });
  });

  it("reports the pairs, files and pairs not judged in JSON, over all and per workspace, numbers only", () => {
    const out = run(["--home", writersHome, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const report = JSON.parse(out.stdout) as ReplayReport;
    expect(report.metrics.supplementary.writersObserved).toEqual({ pairs: 1, files: 1, unknownPairs: 2, byWorkspace: { [WS_A]: { pairs: 1, files: 1, unknownPairs: 2 } } });
    expect(report.byWorkspace.map((row) => [row.workspaceId, row.metrics.supplementary.writersObserved.pairs])).toEqual([
      [WS_A, 1],
      [WS_B, 0],
    ]);
    for (const secret of [SECRET_PATH, "/work/alpha"]) expect(out.stdout).not.toContain(secret);
  });

  it("prints it as Markdown: a headline row, the totals in Every metric and a column of By workspace, no path", () => {
    const { stdout, code } = run(["--home", writersHome]);
    expect(code).toBe(0);
    expect(stdout).toContain("| Writers observed: overlapping turn pairs / files / pairs not judged | 1 / 1 / 2 |");
    expect(stdout).toContain("| supplementary.writersObserved.pairs | 1 |");
    expect(stdout).toContain("| supplementary.writersObserved.unknownPairs | 2 |");
    expect(stdout).not.toContain("| supplementary.writersObserved.byWorkspace.");
    expect(stdout).toContain("| Workspace | Label | Requests | Finished | Asked | Reached owner | Recommended / answered | Tokens (finished) | Writers observed (pairs / files / not judged) |");
    expect(stdout).toMatch(new RegExp(`\\| ${WS_A} \\| alpha \\|[^\\n]*\\| 1 / 1 / 2 \\|`));
    expect(stdout).toMatch(new RegExp(`\\| ${WS_B} \\| beta \\|[^\\n]*\\| 0 / 0 / 0 \\|`));
    for (const secret of [SECRET_PATH, "/work/alpha"]) expect(stdout).not.toContain(secret);
  });
});

describe("admission evidence in the replay (autonomy design §F.2; bead i8fc.3)", () => {
  let admissionHome: string;
  const SECRET_PATH = "src/private-ledger.js";
  const SECRET_CHECK = "npm run private-suite";
  const minute = (m: number) => `2026-09-26T12:${String(m).padStart(2, "0")}:00.000Z`;
  const RQ = "req-20260926T120000Z";
  const RU = "req-20260926T121000Z";
  const worker = (requestId: string, from: number, to: number, tokens: number | null, evidence: TraceRecord["evidence"] = []): TraceRecord =>
    turn({
      workspaceId: WS_A,
      agentId: `agent-worker-${requestId}`,
      role: "worker",
      requestId,
      turnId: `w-${requestId}-${to}`,
      startedAt: minute(from),
      endedAt: minute(to),
      at: minute(to),
      usage: tokens === null ? null : { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, costUsd: null, costBasis: "unavailable", model: null, pricesUpdatedAt: null },
      evidence,
    });
  const finished = (requestId: string, at: number, buildAndTests: string | null): TraceRecord =>
    turn({
      workspaceId: WS_A,
      requestId,
      turnId: `f-${requestId}`,
      startedAt: minute(at),
      endedAt: minute(at),
      at: minute(at),
      reports: [report({ at: minute(at), requestId, phase: "finished", tier: "Medium", buildAndTests, filesChanged: [SECRET_PATH] })],
    });

  beforeAll(() => {
    admissionHome = mkdtempSync(join(tmpdir(), "bm-replay-admission-"));
    mkdirSync(join(admissionHome, "traces", WS_A), { recursive: true });
    writeFileSync(join(admissionHome, "traces", WS_A, "meta.json"), JSON.stringify({ lastKnownName: "alpha", lastKnownDirectory: ALPHA_DIRECTORY, lastSeenAt: minute(30) }));
    const records = [
      // Proved: reads 4,000 tokens, then writes and runs its named check after the edit.
      worker(RQ, 0, 2, 4000),
      worker(RQ, 2, 4, 1000, [
        { kind: "file", detail: `${ALPHA_DIRECTORY}/${SECRET_PATH}`, agentId: `agent-worker-${RQ}`, at: minute(3) },
        { kind: "shell", detail: SECRET_CHECK, agentId: `agent-worker-${RQ}`, at: minute(4), status: "completed", exitCode: 0 },
      ]),
      finished(RQ, 5, `\`${SECRET_CHECK}\` passed`),
      // Unverified: writes at once, names a check it never ran.
      worker(RU, 10, 12, 2000, [{ kind: "file", detail: SECRET_PATH, agentId: `agent-worker-${RU}`, at: minute(11) }]),
      finished(RU, 13, `\`${SECRET_CHECK}\` passed`),
    ];
    writeFileSync(join(admissionHome, "traces", WS_A, "events-202609.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  });

  afterAll(() => {
    rmSync(admissionHome, { recursive: true, force: true });
  });

  it("reports each class's figures in JSON, the two new figures in full, numbers only", () => {
    const out = run(["--home", admissionHome, "--json"]);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    const { admission } = JSON.parse(out.stdout) as ReplayReport;
    expect(admission.finishedRequests).toBe(2);
    expect(admission.verification).toMatchObject({ finished: 2, labelled: 2, changedCode: 2, finishedUnverified: 1, share: 0.5, byChecks: { detected: 1, "self-reported": 1 } });
    expect(admission.workerReading).toMatchObject({ requests: 2, withWrite: 2, workerTokensRead: 7000, beforeFirstWrite: 4000, withoutWrite: 0 });
    const byId = new Map(admission.classes.map((entry) => [entry.id, entry]));
    expect(byId.get("unverified-finish")!.figures).toMatchObject({ changedCode: 2, finishedUnverified: 1, share: 0.5 });
    expect(byId.get("worker-exploration")!.figures).toMatchObject({ requests: 2, beforeFirstWrite: 4000, share: 4000 / 7000, medianBeforeFirstWrite: 2000 });
    expect(byId.get("concurrent-writes")!.figures).toEqual({ pairs: 0, files: 0, unknownPairs: 0 });
    expect(byId.get("security-flaw-after-review")).toMatchObject({ measured: false, figures: {} });
    for (const entry of admission.classes) for (const value of Object.values(entry.figures)) expect(value === null || typeof value === "number").toBe(true);
    for (const secret of [SECRET_PATH, SECRET_CHECK, ALPHA_DIRECTORY]) expect(out.stdout).not.toContain(secret);
  });

  it("prints it as Markdown: a row per figure, a class no figure measures on its own row, the two figures in a line each", () => {
    const { stdout, code } = run(["--home", admissionHome]);
    expect(code).toBe(0);
    expect(stdout).toContain("## Admission evidence (autonomy design §F.2)");
    expect(stdout).toContain("docs/operations/paseo-bm-specialist-admission-template.md");
    expect(stdout).toContain("| unverified-finish | independent tester | finishedUnverified | 1 |");
    expect(stdout).toContain("| unverified-finish | independent tester | share | 0.50 |");
    expect(stdout).toContain("| worker-exploration | read-only scout | beforeFirstWrite | 4000 |");
    expect(stdout).toContain("| security-flaw-after-review | security reviewer | not measured | — |");
    expect(stdout).toContain("| role-cost | a cheaper model for a role | orchestratorPerFinishedRequest | unknown |");
    expect(stdout).toContain("code changed 2, finished-unverified 1 (50.0 %)");
    expect(stdout).toContain("4000 of 7000 Worker tokens read before the first write, 57.1 %");
    for (const secret of [SECRET_PATH, SECRET_CHECK, ALPHA_DIRECTORY]) expect(stdout).not.toContain(secret);
  });
});
