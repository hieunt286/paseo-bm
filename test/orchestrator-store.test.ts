import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTES_DIR_NAME,
  ORCHESTRATOR_DIR_NAME,
  COMMAND_LOG_LIMIT,
  PROPOSALS_FILE,
  RETIRED_ASSESSMENTS_DIR_NAME,
  STALLS_FILE,
  STALL_ENTRY_LIMIT,
  WAKES_FILE,
  WAKE_LOG_LIMIT,
  createOrchestratorStore,
  dangerOpenKey,
  parseDangerOpenKey,
  type SentCommandInput,
} from "../plugin/server/orchestrator-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import {
  DANGER_ALLOWANCE_MS,
  MAX_NOTES,
  MAX_NOTE_CHARS,
  MAX_PROPOSAL_COMMAND_CHARS,
  MAX_PROPOSAL_REASON_CHARS,
  RULE_IDS,
  WORKER_SIGNALS,
  isSentCommand,
  type Proposal,
} from "../plugin/shared/orchestrator";

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

const store = () => createOrchestratorStore(home, { now: () => new Date(clock), newId: () => `prop-${++nextId}` });
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const orchestratorDir = () => join(home, ORCHESTRATOR_DIR_NAME);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-store-"));
  home = join(root, "data");
  clock = T0;
  nextId = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("shared shapes", () => {
  it("names only the rule the stall pass reads; the assessment-only rules are retired (autonomy design §B.9)", () => {
    expect(RULE_IDS).toEqual(["review.over-budget"]);
  });
});

const commandInput = (over: Partial<SentCommandInput> = {}): SentCommandInput => ({
  workspaceId: WS,
  managerId: "mgr-1",
  requestId: "req-20260928T100000Z",
  situation: "answer to Q2",
  command: "Tell the Worker to go on with option B.",
  reason: "The owner answered in the Worker's chat.",
  sentText: "BM-COMMAND\nfrom: orchestrator\nre: answer to Q2\n\nTell the Worker to go on with option B.",
  outcome: "sent",
  ...over,
});

describe("folder and file modes", () => {
  it("creates nothing on a read", () => {
    const s = store();
    expect(s.listCommands()).toEqual([]);
    expect(s.listDangerAllowances()).toEqual([]);
    expect(s.isDangerOpen(WS, "wrk-1")).toBe(false);
    expect(s.deleteRetiredAssessments(WS)).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  it("creates the folder 0700 and every file 0600 on first write", () => {
    const s = store();
    s.appendCommand(commandInput());
    s.openDangerAllowance(WS, "wrk-1");

    expect(modeOf(orchestratorDir())).toBe(0o700);
    for (const file of [PROPOSALS_FILE, STALLS_FILE]) {
      expect(modeOf(join(orchestratorDir(), file)), file).toBe(0o600);
    }
    // No temp file of an atomic write is left behind.
    expect(readdirSync(orchestratorDir()).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("keeps every file inside the folder that cleanup deletes whole", () => {
    expect(CLEANUP_DELETES).toContain(ORCHESTRATOR_DIR_NAME);
  });
});

describe("settings.json is retired with Autopilot and Allow… (autonomy design §B.8)", () => {
  const settingsFile = () => join(orchestratorDir(), "settings.json");

  it("never reads or writes the file an earlier build left, and no write creates one", () => {
    const s = store();
    s.appendCommand(commandInput());
    s.openDangerAllowance(WS, "wrk-1");
    s.appendNote(WS, "The owner prefers small commits.");
    expect(existsSync(settingsFile())).toBe(false);

    const earlier = JSON.stringify({ version: 3, watch: { enabled: true }, autopilot: { [WS]: { enabled: true, since: new Date(T0).toISOString(), by: "tab", allow: ["release"] } } });
    writeFileSync(settingsFile(), earlier);
    s.appendCommand(commandInput({ situation: "go on" }));
    s.openDangerAllowance(WS, "wrk-2");
    s.appendNote(WS, "Another note.");
    expect(readFileSync(settingsFile(), "utf8")).toBe(earlier);
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
      source: "chat",
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

  it("records a command under the id it was sent with (command-send.ts), and refuses an id already used", () => {
    const s = store();
    expect(s.appendCommand(commandInput({ id: "cmd-given" })).id).toBe("cmd-given");
    expect(s.appendCommand(commandInput()).id).toBe("prop-1");
    expect(() => s.appendCommand(commandInput({ id: "cmd-given" }))).toThrow("command id already used: cmd-given");
    expect(s.listCommands().map((entry) => entry.id).sort()).toEqual(["cmd-given", "prop-1"]);
  });

  it("stores a Worker command with its Worker and Manager; a Manager command has no target field", () => {
    const s = store();
    const toManager = s.appendCommand(commandInput());
    const toWorker = s.appendCommand(commandInput({ to: "worker", workerId: "wkr-1", managerId: null }));
    expect(toManager.to).toBeUndefined();
    expect(toWorker).toMatchObject({ to: "worker", workerId: "wkr-1", managerId: null, source: "chat" });
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
    // A command Phase 1 sent on a project's Autopilot: history, still a command the Orchestrator sent (autonomy design §B.8).
    const sent = { ...commandInput(), source: "autopilot", id: "kept", at: new Date(T0).toISOString(), kind: "command", status: "sent", settledAt: new Date(T0).toISOString(), error: null };
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

  it("the end carries the closing turn's tokens (change-007 C6); a wake written before them still reads", () => {
    mkdirSync(orchestratorDir(), { recursive: true });
    // An ended wake from a build before C6: no `usage` at all.
    const before = { orchestratorId: ORCH, at: new Date(T0 - 60_000).toISOString(), endedAt: new Date(T0 - 30_000).toISOString(), workspaceIds: [WS], events: 1 };
    writeFileSync(wakesFile(), JSON.stringify({ version: 1, entries: [before] }));
    const s = store();
    expect(s.readWakes()).toEqual([before]);

    s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 2 });
    clock += 1_000;
    const usage = { inputTokens: 12, cachedInputTokens: 30_500, outputTokens: 410 };
    expect(s.endWake(ORCH, usage)).toMatchObject({ endedAt: new Date(T0 + 1_000).toISOString(), usage });
    expect(s.readWakes().map((wake) => wake.usage)).toEqual([undefined, usage]);
    expect(JSON.parse(readFileSync(wakesFile(), "utf8")).entries[1].usage).toEqual(usage);

    // Unknown tokens, or tokens that do not validate, are null — and never cost the wake its end.
    s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 1 });
    clock += 1_000;
    expect(s.endWake(ORCH)).toMatchObject({ endedAt: new Date(T0 + 2_000).toISOString(), usage: null });
    s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 1 });
    expect(s.endWake(ORCH, { inputTokens: -1, cachedInputTokens: 0.5, outputTokens: 1 })).toMatchObject({ usage: null });
    expect(s.readWakes().every((wake) => wake.endedAt !== null)).toBe(true);
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

describe("model-corrections.json is retired with its rule (autonomy design §B.9)", () => {
  it("leaves the file an earlier build wrote as it is", () => {
    const s = store();
    mkdirSync(orchestratorDir(), { recursive: true });
    const file = join(orchestratorDir(), "model-corrections.json");
    const earlier = JSON.stringify({ version: 1, entries: [{ at: new Date(T0).toISOString(), alias: "bm-worker", requested: "a", profileModel: "b", cwd: "/repo" }] });
    writeFileSync(file, earlier);
    s.appendCommand(commandInput());
    s.appendNote(WS, "A note.");
    expect(readFileSync(file, "utf8")).toBe(earlier);
  });
});

describe("assessments/<workspaceId>.jsonl is retired with the workflow assessment (autonomy design §B.9)", () => {
  const dir = () => join(orchestratorDir(), RETIRED_ASSESSMENTS_DIR_NAME);
  const file = (workspaceId = WS) => join(dir(), `${workspaceId}.jsonl`);
  const earlierLine = JSON.stringify({ v: 1, assessmentId: "asm-1", requestId: "req-20260928T100000Z", traceId: "req:req-20260928T100000Z", status: "done", result: { findings: ["quotes the request"] } });
  const earlierBuild = (workspaceId = WS): void => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(file(workspaceId), `${earlierLine}\n`);
  };

  it("deletes an earlier build's file of the workspace, and only that one", () => {
    earlierBuild();
    earlierBuild("wks_other");
    const s = store();
    expect(s.deleteRetiredAssessments(WS)).toBe(true);
    expect(existsSync(file())).toBe(false);
    expect(readFileSync(file("wks_other"), "utf8")).toBe(`${earlierLine}\n`);
    // Already gone: nothing to delete, and no folder is created.
    expect(s.deleteRetiredAssessments(WS)).toBe(false);
  });

  it("answers false without a file, creating nothing", () => {
    expect(store().deleteRetiredAssessments(WS)).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  it("refuses a symlinked file, leaving what it points at", () => {
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, "keep me");
    mkdirSync(dir(), { recursive: true });
    symlinkSync(outside, file());
    expect(() => store().deleteRetiredAssessments(WS)).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED/);
    expect(readFileSync(outside, "utf8")).toBe("keep me");
  });

  it("refuses a workspace id that is not a safe file name", () => {
    earlierBuild();
    const s = store();
    expect(() => s.deleteRetiredAssessments("../escape")).toThrow();
    expect(() => s.deleteRetiredAssessments("..")).toThrow();
    expect(existsSync(file())).toBe(true);
  });

  it("lives inside the folder cleanup deletes whole", () => {
    expect(file().startsWith(`${orchestratorDir()}/`)).toBe(true);
    expect(CLEANUP_DELETES).toContain(ORCHESTRATOR_DIR_NAME);
  });
});

describe("stalls.json: interrupt allowances (design §6B.3; autonomy design §A.8)", () => {
  const file = () => join(orchestratorDir(), STALLS_FILE);
  const at = (ms: number) => new Date(ms).toISOString();
  const TURN = "2026-09-28T09:58:00.000Z";

  it("builds and parses allowance keys, and refuses the keys it cannot read back", () => {
    expect(WORKER_SIGNALS).toEqual(["stuck", "permission", "danger", "failing", "heavy", "outside", "off-tool-review"]);
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

describe("a file written by a newer paseo-bm (code review 2026-09-30 §2.3)", () => {
  const newer = (entries: unknown) => JSON.stringify({ version: 2, entries, addedLater: true });
  const ORCH = "orch-1";

  it("reads as its default and is never written: every write throws E_ORCHESTRATOR_WRITE_FAILED and leaves it byte for byte", () => {
    mkdirSync(join(orchestratorDir(), NOTES_DIR_NAME), { recursive: true });
    const files = {
      [join(orchestratorDir(), PROPOSALS_FILE)]: newer([{ id: "from-the-future" }]),
      [join(orchestratorDir(), STALLS_FILE)]: JSON.stringify({ version: 2, entries: { [dangerOpenKey(WS, "wrk-1", new Date(T0).toISOString())]: {} } }),
      [join(orchestratorDir(), WAKES_FILE)]: newer([{ orchestratorId: ORCH }]),
      [join(orchestratorDir(), NOTES_DIR_NAME, `${WS}.json`)]: newer([{ text: "a newer note" }]),
    };
    for (const [path, text] of Object.entries(files)) writeFileSync(path, text);

    const s = store();
    expect(s.listCommands()).toEqual([]);
    expect(s.listDangerAllowances()).toEqual([]);
    expect(s.readWakes()).toEqual([]);
    expect(s.readNotes(WS)).toEqual([]);

    const refused = /^E_ORCHESTRATOR_WRITE_FAILED: .* was written by a newer paseo-bm; it is left as it is$/;
    expect(() => s.appendCommand(commandInput())).toThrow(refused);
    expect(() => s.openDangerAllowance(WS, "wrk-1")).toThrow(refused);
    expect(() => s.appendWake({ orchestratorId: ORCH, workspaceIds: [WS], events: 1 })).toThrow(refused);
    expect(() => s.appendNote(WS, "mine")).toThrow(refused);
    expect(() => s.appendNote(WS, "mine", { replace: true })).toThrow(refused);
    // Nothing to end reads nothing into being, and throws nothing.
    expect(s.endWake(ORCH)).toBeNull();

    for (const [path, text] of Object.entries(files)) expect(readFileSync(path, "utf8"), path).toBe(text);
  });
});
