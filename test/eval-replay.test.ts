import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TraceRecord } from "../plugin/shared/contracts";
import { REPLAY_SCHEMA_VERSION, parseReplayArgs, runReplay, type ReplayReport } from "../scripts/eval/replay";
import { MANAGER, WORKER, at, msg, report, turn } from "./fixtures/orchestrator-traces";

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
  it("prints the schema: schemaVersion 1, window, filters, metrics, byWorkspace, unknowns", () => {
    const out = json();
    expect(Object.keys(out)).toEqual(["schemaVersion", "window", "filters", "metrics", "byWorkspace", "unknowns"]);
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
