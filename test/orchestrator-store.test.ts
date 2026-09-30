import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSESSMENTS_DIR_NAME,
  MAX_ASSESSMENT_RAW_CHARS,
  MODEL_CORRECTIONS_FILE,
  MODEL_CORRECTION_LIMIT,
  NOTES_DIR_NAME,
  ORCHESTRATOR_DIR_NAME,
  ORCHESTRATOR_SETTINGS_FILE,
  COMMAND_LOG_LIMIT,
  PROPOSALS_FILE,
  STALLS_FILE,
  STALL_ENTRY_LIMIT,
  WAKES_FILE,
  WAKE_LOG_LIMIT,
  createOrchestratorStore,
  dangerOpenKey,
  parseDangerOpenKey,
  resetCorrectionWarning,
  type SentCommandInput,
} from "../plugin/server/orchestrator-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import {
  DANGER_ALLOWANCE_MS,
  DEFAULT_ORCHESTRATOR_SETTINGS,
  MAX_NOTES,
  MAX_NOTE_CHARS,
  MAX_PROPOSAL_COMMAND_CHARS,
  MAX_PROPOSAL_REASON_CHARS,
  RULE_IDS,
  WORKER_SIGNALS,
  WORKFLOW_ASSESSMENT_TRACE_ID,
  commandTargetOf,
  isSentCommand,
  type AssessmentLine,
  type ModelCorrection,
  type Proposal,
} from "../plugin/shared/orchestrator";
import { TRUNCATION_MARKER } from "../plugin/server/trace-store";

/**
 * The Orchestrator's store (Orchestrator design §4.3, §5.4). Runs against a
 * temporary data folder; time and command ids are injected.
 */

const WS = "wks_1";
const T0 = Date.parse("2026-09-28T10:00:00.000Z");

let root: string;
let home: string;
let clock: number;
let nextId: number;

const store = (log: (message: string) => void = () => {}) =>
  createOrchestratorStore(home, { now: () => new Date(clock), log, newId: () => `prop-${++nextId}` });
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const orchestratorDir = () => join(home, ORCHESTRATOR_DIR_NAME);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-store-"));
  home = join(root, "data");
  clock = T0;
  nextId = 0;
  resetCorrectionWarning();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const correction = (i: number): ModelCorrection => ({
  at: new Date(T0 + i * 1000).toISOString(),
  alias: "bm-worker",
  requested: `model-${i}`,
  profileModel: "claude-opus-5",
  cwd: "/repo",
});

const assessment = (over: Partial<AssessmentLine> = {}): AssessmentLine => ({
  v: 1,
  assessmentId: "asm-1",
  requestId: "req-20260928T100000Z",
  traceId: "req:req-20260928T100000Z",
  agentId: null,
  at: new Date(clock).toISOString(),
  status: "pending",
  provider: "bm-orchestrator",
  model: "claude-opus-5",
  ...over,
});

describe("shared shapes", () => {
  it("names the seven first-release rules", () => {
    expect(RULE_IDS).toEqual([
      "process.small-heavy",
      "process.no-review",
      "review.over-budget",
      "agent.failed-first-turn",
      "agent.model-corrected",
      "report.malformed",
      "manager.language-mismatch",
    ]);
  });
});

const commandInput = (over: Partial<SentCommandInput> = {}): SentCommandInput => ({
  workspaceId: WS,
  managerId: "mgr-1",
  requestId: "req-20260928T100000Z",
  situation: "answer to Q2",
  command: "Tell the Worker to go on with option B.",
  reason: "The owner answered in the Worker's chat.",
  source: "autopilot",
  sentText: "BM-COMMAND\nfrom: orchestrator\nre: answer to Q2\n\nTell the Worker to go on with option B.",
  outcome: "sent",
  ...over,
});

describe("folder and file modes", () => {
  it("creates nothing on a read", () => {
    const s = store();
    expect(s.readSettings()).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
    expect(s.isAutopilot(WS)).toBe(false);
    expect(s.setAutopilot(WS, false)).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
    expect(s.listCommands()).toEqual([]);
    expect(s.listDangerAllowances()).toEqual([]);
    expect(s.isDangerOpen(WS, "wrk-1")).toBe(false);
    expect(s.readCorrections()).toEqual([]);
    expect(s.readAssessments(WS)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  it("creates the folder 0700 and every file 0600 on first write", () => {
    const s = store();
    s.setAutopilot(WS, true);
    s.appendCommand(commandInput());
    s.openDangerAllowance(WS, "wrk-1");
    s.appendCorrection(correction(0));
    s.appendAssessment(WS, assessment());

    expect(modeOf(orchestratorDir())).toBe(0o700);
    expect(modeOf(join(orchestratorDir(), ASSESSMENTS_DIR_NAME))).toBe(0o700);
    for (const file of [
      ORCHESTRATOR_SETTINGS_FILE,
      PROPOSALS_FILE,
      STALLS_FILE,
      MODEL_CORRECTIONS_FILE,
      join(ASSESSMENTS_DIR_NAME, `${WS}.jsonl`),
    ]) {
      expect(modeOf(join(orchestratorDir(), file)), file).toBe(0o600);
    }
    // No temp file of an atomic write is left behind.
    expect(readdirSync(orchestratorDir()).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps every file inside the folder that cleanup deletes whole", () => {
    expect(CLEANUP_DELETES).toContain(ORCHESTRATOR_DIR_NAME);
  });
});

describe("settings.json (version 3)", () => {
  const settingsFile = () => join(orchestratorDir(), ORCHESTRATOR_SETTINGS_FILE);
  const writeRaw = (value: unknown): void => {
    mkdirSync(orchestratorDir(), { recursive: true });
    writeFileSync(settingsFile(), typeof value === "string" ? value : JSON.stringify(value));
  };

  it("defaults to no Autopilot when missing, corrupt or unrecognised", () => {
    const s = store();
    expect(s.readSettings()).toEqual({ version: 3, autopilot: {} });
    writeRaw("{not json");
    expect(s.readSettings()).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
    writeRaw({ version: 3, autopilot: "none" });
    expect(s.readSettings()).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
    writeRaw({ version: 4, autopilot: {} });
    expect(s.readSettings()).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
  });

  it("reads a first-design version-1 file and a version-2 (Watch only) file as no Autopilot", () => {
    const s = store();
    writeRaw({ version: 1, nudge: { enabled: true, rules: ["process.small-heavy", "manager.language-mismatch"] } });
    expect(s.readSettings()).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
    writeRaw({ version: 2, watch: { enabled: true } });
    expect(s.readSettings()).toEqual(DEFAULT_ORCHESTRATOR_SETTINGS);
    // The next write replaces it.
    s.setAutopilot(WS, true);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual({
      version: 3,
      autopilot: { [WS]: { enabled: true, since: new Date(T0).toISOString() } },
    });
  });

  it("ignores the Watch switch an older version-3 file carries, and drops it at the next write (autonomy design §A.8)", () => {
    const s = store();
    const since = new Date(T0).toISOString();
    writeRaw({ version: 3, watch: { enabled: true }, autopilot: { [WS]: { enabled: true, since } } });
    expect(s.readSettings()).toEqual({ version: 3, autopilot: { [WS]: { enabled: true, since } } });
    s.setAutopilot("wks_2", true);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).not.toHaveProperty("watch");
  });

  it("keeps the previous content when a write fails before its rename", () => {
    const s = store();
    s.setAutopilot(WS, true);
    const before = readFileSync(settingsFile(), "utf8");
    vi.spyOn(Date, "now").mockReturnValue(424243);
    writeFileSync(join(orchestratorDir(), `${ORCHESTRATOR_SETTINGS_FILE}.tmp-${process.pid}-424243`), "partial");
    expect(() => s.setAutopilot(WS, false)).toThrow();
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
    expect(s.isAutopilot(WS)).toBe(true);
  });

  it("turns Autopilot on and off per project, recording since and by", () => {
    const s = store();
    const on = s.setAutopilot(WS, true, "tab");
    expect(on).toEqual({ version: 3, autopilot: { [WS]: { enabled: true, since: new Date(T0).toISOString(), by: "tab" } } });
    expect(s.isAutopilot(WS)).toBe(true);
    expect(s.isAutopilot("wks_2")).toBe(false);

    // On again: the entry keeps its first time, and nothing is written.
    clock = T0 + 5_000;
    const before = readFileSync(settingsFile(), "utf8");
    expect(s.setAutopilot(WS, true, "chat")).toEqual(on);
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);

    s.setAutopilot("wks_2", true);
    expect(Object.keys(s.readSettings().autopilot)).toEqual([WS, "wks_2"]);
    expect(s.readSettings().autopilot["wks_2"]).toEqual({ enabled: true, since: new Date(T0 + 5_000).toISOString() });

    // Off removes the entry.
    expect(s.setAutopilot(WS, false)).toEqual({
      version: 3,
      autopilot: { wks_2: { enabled: true, since: new Date(T0 + 5_000).toISOString() } },
    });
    expect(s.isAutopilot(WS)).toBe(false);
  });

  it("skips an Autopilot entry that does not validate, or whose key is not a workspace id, on its own", () => {
    const s = store();
    const since = new Date(T0).toISOString();
    writeRaw({
      version: 3,
      autopilot: { [WS]: { enabled: true, since }, wks_off: { enabled: false, since }, "../x": { enabled: true, since }, wks_bad: "yes" },
    });
    expect(s.readSettings().autopilot).toEqual({ [WS]: { enabled: true, since } });
    expect(s.isAutopilot("wks_off")).toBe(false);
    expect(s.isAutopilot("../x")).toBe(false);
  });

  it("never lets a workspace id reach a prototype", () => {
    const s = store();
    const since = new Date(T0).toISOString();
    writeRaw(`{"version":3,"autopilot":{"__proto__":{"enabled":true,"since":"${since}"}}}`);
    const read = s.readSettings();
    expect(Object.getPrototypeOf(read.autopilot)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["enabled"]).toBeUndefined();
    expect(s.isAutopilot("toString")).toBe(false);
    s.setAutopilot("constructor", true);
    expect(Object.keys(s.readSettings().autopilot)).toEqual(["constructor"]);
    expect(s.isAutopilot("constructor")).toBe(true);
    expect(s.isAutopilot("hasOwnProperty")).toBe(false);
  });

  it("refuses an Autopilot switch for a workspace id the store would refuse, writing nothing", () => {
    const s = store();
    expect(() => s.setAutopilot("../x", true)).toThrow();
    expect(existsSync(home)).toBe(false);
  });
});

describe("proposals.json: the commands the Orchestrator sent (autonomy design §A.14)", () => {
  const file = () => join(orchestratorDir(), PROPOSALS_FILE);
  const stored = () => (JSON.parse(readFileSync(file(), "utf8")) as { version: number; entries: Proposal[] });
  const writeRaw = (entries: unknown[]): void => {
    mkdirSync(orchestratorDir(), { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: 1, entries }));
  };

  it("records a command as sent, stamped now", () => {
    const s = store();
    const command = s.appendCommand(commandInput());
    const expected: Proposal = {
      id: "prop-1",
      at: new Date(T0).toISOString(),
      kind: "command",
      workspaceId: WS,
      managerId: "mgr-1",
      requestId: "req-20260928T100000Z",
      situation: "answer to Q2",
      command: "Tell the Worker to go on with option B.",
      reason: "The owner answered in the Worker's chat.",
      source: "autopilot",
      status: "sent",
      settledAt: new Date(T0).toISOString(),
      sentText: commandInput().sentText,
      outcome: "sent",
      error: null,
    };
    expect(command).toEqual(expected);
    expect(stored()).toEqual({ version: 1, entries: [expected] });
    expect(s.listCommands()).toEqual([expected]);
    expect(isSentCommand(command)).toBe(true);
  });

  it("stores a Worker command with its Worker and Manager; a Manager command has no target field and reads as manager", () => {
    const s = store();
    const toManager = s.appendCommand(commandInput());
    const toWorker = s.appendCommand(commandInput({ source: "chat", to: "worker", workerId: "wkr-1", managerId: null }));
    expect(toManager.to).toBeUndefined();
    expect(commandTargetOf(toManager)).toBe("manager");
    expect(toWorker).toMatchObject({ to: "worker", workerId: "wkr-1", managerId: null, source: "chat" });
    expect(commandTargetOf(toWorker)).toBe("worker");
  });

  it("refuses a command the file cannot hold, writing nothing", () => {
    const s = store();
    expect(() => s.appendCommand(commandInput({ command: "x".repeat(MAX_PROPOSAL_COMMAND_CHARS + 1) }))).toThrow();
    expect(() => s.appendCommand(commandInput({ reason: "x".repeat(MAX_PROPOSAL_REASON_CHARS + 1) }))).toThrow();
    expect(() => s.appendCommand(commandInput({ to: "worker" }))).toThrow();
    expect(() => s.appendCommand(commandInput({ managerId: null }))).toThrow();
    expect(existsSync(file())).toBe(false);
  });

  it("lists newest first, with a limit", () => {
    const s = store();
    for (const minute of [0, 2, 1]) {
      clock = T0 + minute * 60_000;
      s.appendCommand(commandInput({ situation: `at ${minute}` }));
    }
    expect(s.listCommands().map((entry) => entry.situation)).toEqual(["at 2", "at 1", "at 0"]);
    expect(s.listCommands(2).map((entry) => entry.situation)).toEqual(["at 2", "at 1"]);
    expect(s.listCommands(0)).toEqual([]);
  });

  it(`keeps the ${COMMAND_LOG_LIMIT} newest commands`, () => {
    const s = store();
    for (let i = 0; i < COMMAND_LOG_LIMIT + 3; i += 1) {
      clock = T0 + i * 1000;
      s.appendCommand(commandInput({ situation: `c${i}` }));
    }
    const kept = stored().entries.map((entry) => entry.situation);
    expect(kept).toHaveLength(COMMAND_LOG_LIMIT);
    expect(kept[0]).toBe("c3");
    expect(kept.at(-1)).toBe(`c${COMMAND_LOG_LIMIT + 2}`);
  });

  it("ignores the proposal era's entries, and drops them at the next write", () => {
    const sent = { ...commandInput(), id: "kept", at: new Date(T0).toISOString(), kind: "command", status: "sent", settledAt: new Date(T0).toISOString(), error: null };
    const proposalEra = [
      // A proposal waiting for the tab's Send, one dismissed, one that failed.
      { ...sent, id: "pending", source: "orchestrator", status: "pending", settledAt: null, sentText: null, outcome: null },
      { ...sent, id: "dismissed", source: "orchestrator", status: "dismissed", sentText: null, outcome: null, error: "replaced" },
      { ...sent, id: "failed", source: "orchestrator", status: "failed", sentText: null, outcome: null, error: "The Manager was archived or is gone." },
      // Sent from the tab: an approved proposal, and a command the owner typed there.
      { ...sent, id: "approved", source: "orchestrator" },
      { ...sent, id: "typed", source: "user" },
      // A decision asked before the decision store (with no kind, an entry reads as a command).
      { ...sent, id: "decision", kind: "decision", managerId: null, command: "Drop the legacy table?", status: "pending", settledAt: null, sentText: null, outcome: null },
      // An entry that does not validate.
      { id: "broken" },
    ];
    writeRaw([...proposalEra, sent]);
    const s = store();
    expect(s.listCommands().map((entry) => entry.id)).toEqual(["kept"]);
    // Reading repairs nothing.
    expect(stored().entries).toHaveLength(proposalEra.length + 1);
    s.appendCommand(commandInput());
    expect(stored().entries.map((entry) => entry.id)).toEqual(["kept", "prop-1"]);
  });

  it("reads a corrupt or unrecognised file as no command", () => {
    mkdirSync(orchestratorDir(), { recursive: true });
    writeFileSync(file(), "{ nope");
    expect(store().listCommands()).toEqual([]);
    writeFileSync(file(), JSON.stringify({ version: 9, entries: [] }));
    expect(store().listCommands()).toEqual([]);
  });

  it("keeps a whole BM-COMMAND block as the text sent", () => {
    const block = `BM-COMMAND\nfrom: orchestrator\n${"line\n".repeat(600)}`;
    expect(store().appendCommand(commandInput({ sentText: block })).sentText).toBe(block);
  });
});

describe("wakes.json: each wake of the Orchestrator (evaluation design §4, A-7)", () => {
  const ORCH = "agent-orchestrator";
  const wakesFile = () => join(orchestratorDir(), WAKES_FILE);

  it("records a wake with ids, times and a count only, 0600, and reads nothing into being", () => {
    const s = store();
    expect(s.readWakes()).toEqual([]);
    expect(s.endWake(ORCH)).toBeNull();
    expect(existsSync(home)).toBe(false);

    const wake = s.appendWake({ orchestratorId: ORCH, workspaceIds: ["wks_2", WS, "wks_2"], events: 3 });
    expect(wake).toEqual({ orchestratorId: ORCH, at: new Date(T0).toISOString(), endedAt: null, workspaceIds: [WS, "wks_2"], events: 3 });
    expect(modeOf(wakesFile())).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(wakesFile(), "utf8")).entries[0]).sort()).toEqual(["at", "endedAt", "events", "orchestratorId", "workspaceIds"]);
    expect(readdirSync(orchestratorDir()).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("a turn end closes that Orchestrator's oldest open wake, never a newer one or another Orchestrator's", () => {
    const s = store();
    s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 1 });
    clock += 1_000;
    s.appendWake({ orchestratorId: "agent-other", workspaceIds: [WS], events: 1 });
    clock += 1_000;
    // Delivered at the same turn end that closes the first.
    s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 2 });
    clock += 1_000;
    expect(s.endWake(ORCH)).toMatchObject({ at: new Date(T0).toISOString(), endedAt: new Date(T0 + 3_000).toISOString() });
    expect(s.readWakes().map((wake) => wake.endedAt)).toEqual([new Date(T0 + 3_000).toISOString(), null, null]);
    clock += 1_000;
    expect(s.endWake(ORCH)).toMatchObject({ events: 2, endedAt: new Date(T0 + 4_000).toISOString() });
    expect(s.endWake(ORCH)).toBeNull();
  });

  it("keeps the 500 newest; an entry that does not validate is skipped and dropped by the next write", () => {
    mkdirSync(orchestratorDir(), { recursive: true });
    const seeded = Array.from({ length: WAKE_LOG_LIMIT }, (_, i) => ({
      orchestratorId: ORCH,
      at: new Date(T0 - (WAKE_LOG_LIMIT - i) * 1000).toISOString(),
      endedAt: null,
      workspaceIds: [WS],
      events: 1,
    }));
    writeFileSync(wakesFile(), JSON.stringify({ version: 1, entries: [{ orchestratorId: ORCH, text: "not a wake" }, ...seeded] }));
    const s = store();
    expect(s.readWakes()).toHaveLength(WAKE_LOG_LIMIT);
    s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 1 });
    const kept = s.readWakes();
    expect(kept).toHaveLength(WAKE_LOG_LIMIT);
    expect(kept[0]!.at).toBe(seeded[1]!.at);
    expect(kept.at(-1)!.at).toBe(new Date(T0).toISOString());
    expect(readFileSync(wakesFile(), "utf8")).not.toContain("not a wake");
  });

  it("refuses a symlinked wakes file", () => {
    mkdirSync(orchestratorDir(), { recursive: true });
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, entries: [] }));
    symlinkSync(elsewhere, wakesFile());
    expect(() => store().readWakes()).toThrow(/symlink/);
    expect(() => store().appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 1 })).toThrow(/symlink/);
  });
});

describe("model-corrections.json", () => {
  it("keeps the 500 newest entries", () => {
    const s = store();
    mkdirSync(orchestratorDir(), { recursive: true });
    const seeded = Array.from({ length: MODEL_CORRECTION_LIMIT - 1 }, (_, i) => correction(i));
    writeFileSync(join(orchestratorDir(), MODEL_CORRECTIONS_FILE), JSON.stringify({ version: 1, entries: seeded }));
    for (let i = MODEL_CORRECTION_LIMIT - 1; i < MODEL_CORRECTION_LIMIT + 2; i++) s.appendCorrection(correction(i));
    const entries = s.readCorrections();
    expect(entries).toHaveLength(MODEL_CORRECTION_LIMIT);
    expect(entries[0]).toEqual(correction(2));
    expect(entries.at(-1)).toEqual(correction(MODEL_CORRECTION_LIMIT + 1));
  });

  it("never throws when the folder cannot be written (ENOTDIR), and warns once", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(orchestratorDir(), "a regular file where the folder should be");
    const log = vi.fn();
    const s = store(log);
    expect(() => s.appendCorrection(correction(0))).not.toThrow();
    expect(() => s.appendCorrection(correction(1))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("[paseo-bm] could not record a model correction");
  });
});

describe("assessments/<workspaceId>.jsonl", () => {
  const file = () => join(orchestratorDir(), ASSESSMENTS_DIR_NAME, `${WS}.jsonl`);

  it("appends one line per write and reads the newest line of each assessment, newest first", () => {
    const s = store();
    s.appendAssessment(WS, assessment());
    s.appendAssessment(WS, assessment({ assessmentId: "asm-2", traceId: "agent-9:turn-1", requestId: null }));
    clock = T0 + 60_000;
    s.appendAssessment(WS, assessment({ agentId: "agent-o", status: "done", result: { rubric: [] }, usage: { outputTokens: 12 } }));

    expect(readFileSync(file(), "utf8").trim().split("\n")).toHaveLength(3);
    const read = s.readAssessments(WS);
    expect(read.map((line) => [line.assessmentId, line.status])).toEqual([
      ["asm-1", "done"],
      ["asm-2", "pending"],
    ]);
    expect(read[0]).toMatchObject({ agentId: "agent-o", result: { rubric: [] }, usage: { outputTokens: 12 } });
  });

  it("skips a half-written trailing line", () => {
    const s = store();
    s.appendAssessment(WS, assessment());
    writeFileSync(file(), `${readFileSync(file(), "utf8")}{"v":1,"assessmentId":"asm-1","sta`);
    expect(s.readAssessments(WS)).toHaveLength(1);
    expect(s.readAssessments(WS)[0]!.status).toBe("pending");
  });

  it("cuts a raw reply over 8 KB", () => {
    const s = store();
    const stored = s.appendAssessment(WS, assessment({ status: "failed", raw: "x".repeat(MAX_ASSESSMENT_RAW_CHARS + 500) }));
    expect(stored.raw).toBe(`${"x".repeat(MAX_ASSESSMENT_RAW_CHARS)}${TRUNCATION_MARKER}`);
    expect(s.readAssessments(WS)[0]!.raw).toBe(stored.raw);
    const small = s.appendAssessment(WS, assessment({ assessmentId: "asm-2", status: "failed", raw: "short" }));
    expect(small.raw).toBe("short");
  });

  it("deletes only the named traces' lines", () => {
    const s = store();
    s.appendAssessment(WS, assessment());
    s.appendAssessment(WS, assessment({ assessmentId: "asm-2", traceId: "agent-9:turn-1", requestId: null }));
    s.appendAssessment(WS, assessment({ assessmentId: "asm-3", traceId: "req:req-other", requestId: "req-other" }));
    s.appendAssessment(WS, assessment({ status: "done" }));

    expect(s.deleteAssessmentsFor(WS, { traceIds: ["agent-9:turn-1"] })).toBe(1);
    expect(s.readAssessments(WS).map((line) => line.assessmentId)).toEqual(["asm-1", "asm-3"]);
    expect(s.deleteAssessmentsFor(WS, { requestIds: ["req-20260928T100000Z"] })).toBe(2);
    expect(s.readAssessments(WS).map((line) => line.assessmentId)).toEqual(["asm-3"]);
    expect(modeOf(file())).toBe(0o600);
    expect(s.deleteAssessmentsFor(WS, { traceIds: ["nothing"] })).toBe(0);

    expect(s.deleteAssessmentsFor(WS, { traceIds: ["req:req-other"] })).toBe(1);
    expect(existsSync(file())).toBe(false);
    expect(readdirSync(join(orchestratorDir(), ASSESSMENTS_DIR_NAME))).toEqual([]);
  });

  const workflow = (over: Partial<AssessmentLine> = {}): AssessmentLine =>
    assessment({
      assessmentId: "wf-1",
      requestId: null,
      traceId: WORKFLOW_ASSESSMENT_TRACE_ID,
      scope: { requestIds: ["req-20260928T100000Z", "req-other"] },
      ...over,
    });

  it("stores a workflow assessment: requestId null, traceId workspace, a scope", () => {
    const s = store();
    s.appendAssessment(WS, workflow());
    clock = T0 + 60_000;
    s.appendAssessment(WS, workflow({ status: "done", agentId: "agent-o", result: { average: 4.2 } }));
    expect(s.readAssessments(WS)).toEqual([
      workflow({ status: "done", agentId: "agent-o", result: { average: 4.2 }, at: new Date(T0 + 60_000).toISOString() }),
    ]);
    expect(s.readAssessments(WS)[0]!.scope).toEqual({ requestIds: ["req-20260928T100000Z", "req-other"] });
  });

  it("refuses a workspace-wide line without a scope or with a request id", () => {
    const s = store();
    expect(() => s.appendAssessment(WS, assessment({ requestId: null, traceId: WORKFLOW_ASSESSMENT_TRACE_ID }))).toThrow();
    expect(() => s.appendAssessment(WS, workflow({ requestId: "req-x" }))).toThrow();
    expect(existsSync(file())).toBe(false);
  });

  it("deletes a workflow line with the first request of its scope that is deleted, and only then", () => {
    const s = store();
    s.appendAssessment(WS, workflow());
    s.appendAssessment(WS, workflow({ assessmentId: "wf-2", scope: { requestIds: ["req-third"] } }));
    s.appendAssessment(WS, assessment());

    // A trace without a request, or a request outside every scope, leaves the workflow lines.
    expect(s.deleteAssessmentsFor(WS, { traceIds: ["agent-9:turn-1", WORKFLOW_ASSESSMENT_TRACE_ID] })).toBe(0);
    expect(s.deleteAssessmentsFor(WS, { traceIds: ["req:req-other"], requestIds: ["req-other"] })).toBe(1);
    expect(s.readAssessments(WS).map((line) => line.assessmentId)).toEqual(["asm-1", "wf-2"]);
    expect(s.deleteAssessmentsFor(WS, { requestIds: ["req-20260928T100000Z"] })).toBe(1);
    expect(s.readAssessments(WS).map((line) => line.assessmentId)).toEqual(["wf-2"]);
  });

  it("refuses a workspace id that is not a safe file name", () => {
    const s = store();
    expect(() => s.appendAssessment("../escape", assessment())).toThrow();
    expect(() => s.readAssessments("..")).toThrow();
  });
});

// ── ADR-016 additions (design §6B.3, §6B.4, §6B.5, §6B.7) ──────────────────

describe("Autopilot allow: gate categories per project (design §6B.5)", () => {
  const settingsFile = () => join(orchestratorDir(), ORCHESTRATOR_SETTINGS_FILE);

  it("allows none by default, and refuses — writing nothing — for a project with Autopilot off", () => {
    const s = store();
    expect(s.allowedCategories(WS)).toEqual([]);
    expect(s.setAutopilotAllow(WS, ["release"])).toBeNull();
    expect(existsSync(home)).toBe(false);
    s.setAutopilot(WS, true, "tab");
    expect(s.allowedCategories(WS)).toEqual([]);
    expect(s.readSettings().autopilot[WS]).toEqual({ enabled: true, since: new Date(T0).toISOString(), by: "tab" });
  });

  it("stores the categories once each in the gate's order, keeps since and by, and an empty list removes allow", () => {
    const s = store();
    s.setAutopilot(WS, true, "chat");
    s.setAutopilot("wks_2", true);
    clock = T0 + 5_000;
    const set = s.setAutopilotAllow(WS, ["dependency", "release", "dependency"]);
    expect(set?.autopilot[WS]).toEqual({ enabled: true, since: new Date(T0).toISOString(), by: "chat", allow: ["release", "dependency"] });
    expect(s.allowedCategories(WS)).toEqual(["release", "dependency"]);
    expect(s.allowedCategories("wks_2")).toEqual([]);
    expect(Object.keys(s.readSettings().autopilot)).toEqual([WS, "wks_2"]);

    // Turning Autopilot on again keeps the entry, allowance included.
    s.setAutopilot(WS, true, "tab");
    expect(s.allowedCategories(WS)).toEqual(["release", "dependency"]);

    s.setAutopilotAllow(WS, []);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8")).autopilot[WS]).toEqual({ enabled: true, since: new Date(T0).toISOString(), by: "chat" });
  });

  it("forgets the allowance when Autopilot goes off: on again starts with none", () => {
    const s = store();
    s.setAutopilot(WS, true);
    s.setAutopilotAllow(WS, ["cost"]);
    s.setAutopilot(WS, false);
    expect(s.allowedCategories(WS)).toEqual([]);
    s.setAutopilot(WS, true);
    expect(s.allowedCategories(WS)).toEqual([]);
  });

  it("drops a category it does not know when reading, keeping the entry and Autopilot on", () => {
    const s = store();
    const since = new Date(T0).toISOString();
    mkdirSync(orchestratorDir(), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ version: 3, watch: { enabled: false }, autopilot: { [WS]: { enabled: true, since, allow: ["release", "telepathy", 7] } } }));
    expect(s.isAutopilot(WS)).toBe(true);
    expect(s.allowedCategories(WS)).toEqual(["release"]);
  });

  it("refuses a workspace id the store would refuse", () => {
    expect(() => store().setAutopilotAllow("../x", ["release"])).toThrow();
  });
});

describe("stalls.json: interrupt allowances (design §6B.3; autonomy design §A.8)", () => {
  const file = () => join(orchestratorDir(), STALLS_FILE);
  const at = (ms: number) => new Date(ms).toISOString();
  const TURN = "2026-09-28T09:58:00.000Z";

  it("builds and parses allowance keys, and refuses the keys it cannot read back", () => {
    expect(WORKER_SIGNALS).toEqual(["stuck", "permission", "danger", "failing", "heavy", "outside"]);
    const allowance = dangerOpenKey(WS, "wkr-1", TURN);
    expect(allowance).toBe(`${WS}::wkr-1::danger-open@${TURN}`);
    expect(parseDangerOpenKey(allowance)).toEqual({ workspaceId: WS, workerId: "wkr-1", openedAt: TURN });
    expect(parseDangerOpenKey(`${WS}::wkr-1::danger@${TURN}`)).toBeNull();
    expect(parseDangerOpenKey(`${WS}::req:a::idle-unfinished`)).toBeNull();
    expect(() => dangerOpenKey("../x", "wkr-1", TURN)).toThrow();
    expect(() => dangerOpenKey(WS, "", TURN)).toThrow();
    expect(() => dangerOpenKey(WS, "a::b", TURN)).toThrow();
    expect(() => dangerOpenKey(WS, "wkr-1", "a::b")).toThrow();
  });

  it("opens an interrupt allowance for 10 minutes, per Worker, and drops expired ones at the next opening", () => {
    const s = store();
    expect(DANGER_ALLOWANCE_MS).toBe(10 * 60_000);
    expect(s.isDangerOpen(WS, "wkr-1")).toBe(false);
    const opened = s.openDangerAllowance(WS, "wkr-1");
    expect(opened).toEqual({ key: dangerOpenKey(WS, "wkr-1", at(T0)), workspaceId: WS, workerId: "wkr-1", openedAt: at(T0), until: at(T0 + DANGER_ALLOWANCE_MS), open: true });
    expect(s.isDangerOpen(WS, "wkr-1")).toBe(true);
    expect(s.isDangerOpen(WS, "wkr-2")).toBe(false);
    expect(s.isDangerOpen("wks_2", "wkr-1")).toBe(false);

    clock = T0 + DANGER_ALLOWANCE_MS - 1;
    expect(s.isDangerOpen(WS, "wkr-1")).toBe(true);
    clock = T0 + DANGER_ALLOWANCE_MS;
    expect(s.isDangerOpen(WS, "wkr-1")).toBe(false);
    expect(s.listDangerAllowances({ open: false }).map((view) => view.key)).toEqual([opened.key]);
    expect(s.listDangerAllowances({ open: true })).toEqual([]);

    // A new danger opens a new one; the expired one is dropped in the same write.
    s.openDangerAllowance(WS, "wkr-2");
    expect(s.listDangerAllowances().map((view) => view.workerId)).toEqual(["wkr-2"]);
    expect(s.isDangerOpen(WS, "wkr-2")).toBe(true);
  });

  it("ignores the stall, event and Worker-signal keys of an older build, and drops them at the next write", () => {
    const entry = (ms: number) => ({ raisedAt: at(ms), lastSeenAt: at(ms), clearedAt: null, woke: true });
    const allowance = dangerOpenKey(WS, "wkr-1", at(T0));
    mkdirSync(orchestratorDir(), { recursive: true });
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        entries: {
          [`${WS}::req:a::idle-unfinished`]: entry(T0),
          [`${WS}::req:a::question@${TURN}`]: entry(T0),
          [`${WS}::wkr-1::stuck@${TURN}`]: entry(T0),
          [allowance]: entry(T0),
          junk: { woke: "no" },
        },
      }),
    );
    const s = store();
    expect(s.listDangerAllowances().map((view) => view.key)).toEqual([allowance]);
    s.openDangerAllowance(WS, "wkr-2");
    const entries = (JSON.parse(readFileSync(file(), "utf8")) as { entries: Record<string, unknown> }).entries;
    expect(Object.keys(entries)).toEqual([allowance, dangerOpenKey(WS, "wkr-2", at(T0))]);
    writeFileSync(file(), "{not json");
    expect(s.listDangerAllowances()).toEqual([]);
  });

  it(`keeps at most ${STALL_ENTRY_LIMIT} allowances, the oldest opened going first`, () => {
    const keyOf = (i: number) => dangerOpenKey(WS, `wkr-${i}`, at(T0 + i * 1_000));
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < STALL_ENTRY_LIMIT; i++) seeded[keyOf(i)] = { raisedAt: at(T0 + i * 1_000), lastSeenAt: at(T0 + i * 1_000), clearedAt: null, woke: false };
    mkdirSync(orchestratorDir(), { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: 1, entries: seeded }));
    // Still open: nothing expired is dropped first.
    clock = T0 + 1_000;
    store().openDangerAllowance(WS, "wkr-x");
    const entries = (JSON.parse(readFileSync(file(), "utf8")) as { entries: Record<string, unknown> }).entries;
    expect(Object.keys(entries)).toHaveLength(STALL_ENTRY_LIMIT);
    expect(entries[keyOf(0)]).toBeUndefined();
    expect(entries[keyOf(1)]).toBeDefined();
  });
});

describe("notes/<workspaceId>.json (design §6B.4 bm_note)", () => {
  const notesFile = (ws = WS) => join(orchestratorDir(), NOTES_DIR_NAME, `${ws}.json`);

  it("reads none without a file, creating nothing", () => {
    expect(store().readNotes(WS)).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  it("appends notes per project, trimmed, oldest first, in a 0600 file in a 0700 folder", () => {
    const s = store();
    expect(s.appendNote(WS, "  The owner wants CSV exports.  ")).toEqual([{ at: new Date(T0).toISOString(), text: "The owner wants CSV exports." }]);
    clock = T0 + 1_000;
    s.appendNote(WS, "Release is Friday.");
    s.appendNote("wks_2", "Another project.");
    expect(s.readNotes(WS).map((note) => note.text)).toEqual(["The owner wants CSV exports.", "Release is Friday."]);
    expect(s.readNotes("wks_2").map((note) => note.text)).toEqual(["Another project."]);
    expect(modeOf(join(orchestratorDir(), NOTES_DIR_NAME))).toBe(0o700);
    expect(modeOf(notesFile())).toBe(0o600);
    expect(JSON.parse(readFileSync(notesFile(), "utf8"))).toEqual({ version: 1, entries: s.readNotes(WS) });
  });

  it(`keeps the ${MAX_NOTES} newest, and replace empties first`, () => {
    const s = store();
    for (let i = 1; i <= MAX_NOTES + 3; i++) s.appendNote(WS, `note ${i}`);
    const texts = s.readNotes(WS).map((note) => note.text);
    expect(texts).toHaveLength(MAX_NOTES);
    expect(texts[0]).toBe("note 4");
    expect(texts.at(-1)).toBe(`note ${MAX_NOTES + 3}`);
    expect(s.appendNote(WS, "fresh start", { replace: true }).map((note) => note.text)).toEqual(["fresh start"]);
    expect(s.readNotes(WS).map((note) => note.text)).toEqual(["fresh start"]);
  });

  it(`refuses an empty note or one over ${MAX_NOTE_CHARS} characters, and a workspace id the store would refuse, writing nothing`, () => {
    const s = store();
    expect(() => s.appendNote(WS, "   ")).toThrow();
    expect(() => s.appendNote(WS, "n".repeat(MAX_NOTE_CHARS + 1))).toThrow();
    s.appendNote(WS, "x");
    expect(() => s.appendNote(WS, "", { replace: true })).toThrow();
    // A refused note with replace empties nothing.
    expect(s.readNotes(WS).map((note) => note.text)).toEqual(["x"]);
    expect(s.appendNote(WS, "n".repeat(MAX_NOTE_CHARS)).at(-1)?.text).toHaveLength(MAX_NOTE_CHARS);
    expect(() => s.appendNote("../x", "escape")).toThrow();
    expect(() => s.readNotes("../x")).toThrow();
  });

  it("skips a note that does not validate and reads a corrupt file as none", () => {
    const s = store();
    const [good] = s.appendNote(WS, "kept");
    writeFileSync(notesFile(), JSON.stringify({ version: 1, entries: [{ text: 5 }, good] }));
    expect(s.readNotes(WS)).toEqual([good]);
    writeFileSync(notesFile(), "{not json");
    expect(s.readNotes(WS)).toEqual([]);
  });

  it("lives inside the folder cleanup deletes whole", () => {
    store().appendNote(WS, "kept");
    expect(notesFile().startsWith(`${orchestratorDir()}/`)).toBe(true);
    expect(CLEANUP_DELETES).toContain(ORCHESTRATOR_DIR_NAME);
  });
});
