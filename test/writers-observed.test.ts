import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAlertStore } from "../plugin/server/alert-store";
import { eventKeyOf, eventLineOf } from "../plugin/server/event-bus";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta, type TraceStoreLocation } from "../plugin/server/trace-store";
import { createWritersWatch } from "../plugin/server/writers-watch";
import { alertKeyOf, MAX_ALERT_DETAIL_CHARS } from "../plugin/shared/alerts";
import type { TraceRecord } from "../plugin/shared/contracts";
import {
  collisionsOfTurn,
  isCollisionSettled,
  isRequestFinished,
  requestOfTurn,
  spansOverlap,
  turnPairsOf,
  workspaceFileOf,
  writersObservedOf,
  writtenFilesOf,
} from "../plugin/shared/writers-observed";
import { MANAGER, WORKER, WORKSPACE_DIRECTORY, WORKSPACE_ID, at, file, report, turn } from "./fixtures/orchestrator-traces";

/**
 * `writers-observed` (autonomy design §F.1, §F.3; REQ-161): two agents of one
 * workspace with edit or write evidence on the same file in overlapping
 * turns. The pure detection, then the server's watch on a recorded turn — its
 * alert raised once per file and cleared when the later of the two requests
 * finished, and its events. A temporary data folder only; never the real HOME.
 */

const OTHER = "agent-worker-2";
const REVIEWER = "agent-reviewer";
const R1 = "req-20260926T100000Z";
const R2 = "req-20260926T100010Z";
const DIR = WORKSPACE_DIRECTORY;
const noDirectory = () => null;
const inWorkspace = () => DIR;

/** One turn of `agentId` from minute `from` to minute `to` that wrote `paths`. */
function wrote(agentId: string, from: number | null, to: number, paths: string[], over: Partial<TraceRecord> = {}): TraceRecord {
  return turn({
    agentId,
    role: "worker",
    turnId: `${agentId}-${from}`,
    startedAt: from === null ? null : at(from),
    endedAt: at(to),
    at: at(to),
    evidence: paths.map((path) => file(path, at(to), agentId)),
    ...over,
  });
}

describe("the pairing: spans and agents", () => {
  it("overlaps half-open: a turn that starts the millisecond another ends does not overlap it", () => {
    expect(spansOverlap({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
    expect(spansOverlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(spansOverlap({ start: 2, end: 3 }, { start: 0, end: 10 })).toBe(true);
  });

  it("pairs two agents only; a turn without a time leaves its pairs unknown", () => {
    const a = { agentId: "a", start: 0, end: 10 };
    const a2 = { agentId: "a", start: 5, end: 15 };
    const b = { agentId: "b", start: 8, end: 20 };
    const c = { agentId: "c", start: null, end: 20 };
    expect(turnPairsOf([a, a2])).toEqual({ overlapping: [], unknown: [] });
    expect(turnPairsOf([a, a2, b, c])).toEqual({ overlapping: [[a, b], [a2, b]], unknown: [[a, c], [a2, c], [b, c]] });
  });
});

describe("one file, relative to the workspace folder", () => {
  it("matches the absolute and the relative form of one file, and resolves . and ..", () => {
    expect(workspaceFileOf(`${DIR}/src/math.js`, DIR)).toBe("src/math.js");
    expect(workspaceFileOf("src/math.js", DIR)).toBe("src/math.js");
    expect(workspaceFileOf("./src/../src//math.js", DIR)).toBe("src/math.js");
    expect(workspaceFileOf(`${DIR}/./src/math.js`, `${DIR}/`)).toBe("src/math.js");
  });

  it("ignores a write outside the workspace folder: an absolute path not below it, a relative one climbing above it", () => {
    expect(workspaceFileOf("/tmp/scratch.txt", DIR)).toBeNull();
    expect(workspaceFileOf(`${DIR}-other/src/math.js`, DIR)).toBeNull();
    expect(workspaceFileOf("../elsewhere/math.js", DIR)).toBeNull();
    expect(workspaceFileOf("src/../../math.js", DIR)).toBeNull();
    expect(workspaceFileOf("", DIR)).toBeNull();
  });

  it("without the folder, compares paths as written", () => {
    expect(workspaceFileOf(`${DIR}/src/math.js`, null)).toBe(`${DIR}/src/math.js`);
    expect(workspaceFileOf("src/math.js", null)).toBe("src/math.js");
  });

  it("reads only edit and write evidence, each file once", () => {
    const record = wrote(WORKER, 0, 5, ["src/a.js", `${DIR}/src/a.js`, "/tmp/x"], {
      evidence: [file("src/a.js", at(1)), file(`${DIR}/src/a.js`, at(2)), file("/tmp/x", at(3)), { kind: "shell", detail: "echo > src/b.js", agentId: WORKER, at: at(4) }],
    });
    expect(writtenFilesOf(record, DIR)).toEqual(["src/a.js"]);
  });
});

describe("writersObservedOf: the collisions of a workspace", () => {
  it("two agents, overlapping turns, one file → one collision, the earlier start first", () => {
    const first = wrote(WORKER, 0, 10, ["src/math.js"]);
    const second = wrote(OTHER, 5, 15, ["src/math.js"]);
    const found = writersObservedOf([second, first], inWorkspace);
    expect(found.unknown).toEqual([]);
    expect(found.collisions).toEqual([{ workspaceId: WORKSPACE_ID, file: "src/math.js", turns: [first, second] }]);
  });

  it("one agent twice → none", () => {
    expect(writersObservedOf([wrote(WORKER, 0, 10, ["src/math.js"]), wrote(WORKER, 5, 15, ["src/math.js"])], inWorkspace)).toEqual({ collisions: [], unknown: [] });
  });

  it("no overlap → none, turns that touch included", () => {
    const records = [wrote(WORKER, 0, 10, ["src/math.js"]), wrote(OTHER, 10, 15, ["src/math.js"]), wrote(REVIEWER, 20, 25, ["src/math.js"], { role: "reviewer" })];
    expect(writersObservedOf(records, inWorkspace)).toEqual({ collisions: [], unknown: [] });
  });

  it("two files of one pair are two collisions; a file only one of them wrote is none", () => {
    const found = writersObservedOf([wrote(WORKER, 0, 10, ["src/a.js", "src/b.js", "README.md"]), wrote(OTHER, 5, 15, ["src/b.js", "src/a.js"])], inWorkspace);
    expect(found.collisions.map((collision) => collision.file)).toEqual(["src/a.js", "src/b.js"]);
  });

  it("a missing start → unknown, never a collision nor none", () => {
    const found = writersObservedOf([wrote(WORKER, null, 10, ["src/math.js"]), wrote(OTHER, 5, 15, ["src/math.js"])], inWorkspace);
    expect(found.collisions).toEqual([]);
    expect(found.unknown).toHaveLength(1);
    expect(found.unknown[0]).toMatchObject({ file: "src/math.js" });
  });

  it("a write outside the workspace is ignored", () => {
    const records = [wrote(WORKER, 0, 10, ["/tmp/notes.txt"]), wrote(OTHER, 5, 15, ["/tmp/notes.txt"])];
    expect(writersObservedOf(records, inWorkspace)).toEqual({ collisions: [], unknown: [] });
  });

  it("the relative (Codex) and absolute (Claude) paths of one file match", () => {
    const found = writersObservedOf([wrote(WORKER, 0, 10, [`${DIR}/src/math.js`]), wrote(OTHER, 5, 15, ["src/math.js"])], inWorkspace);
    expect(found.collisions.map((collision) => collision.file)).toEqual(["src/math.js"]);
    // Without the folder they cannot be placed, and are compared as written.
    expect(writersObservedOf([wrote(WORKER, 0, 10, [`${DIR}/src/math.js`]), wrote(OTHER, 5, 15, ["src/math.js"])], noDirectory).collisions).toEqual([]);
  });

  it("a reused turn id is not confused: turns are told apart by their times", () => {
    // Paseo reuses turn ids inside one agent (AGENTS.md): two turns of WORKER, both "foreground-turn-1".
    const early = wrote(WORKER, 0, 5, ["src/math.js"], { turnId: "foreground-turn-1" });
    const late = wrote(WORKER, 20, 30, ["src/math.js"], { turnId: "foreground-turn-1" });
    const other = wrote(OTHER, 25, 35, ["src/math.js"], { turnId: "foreground-turn-1" });
    const found = writersObservedOf([early, late, other], inWorkspace);
    expect(found.collisions).toEqual([{ workspaceId: WORKSPACE_ID, file: "src/math.js", turns: [late, other] }]);
    expect(collisionsOfTurn(early, [early, late, other], DIR).collisions).toEqual([]);
    expect(collisionsOfTurn(other, [early, late, other], DIR).collisions).toHaveLength(1);
  });

  it("any two agents count: a Manager or a Reviewer writing is itself notable", () => {
    const found = writersObservedOf([wrote(MANAGER, 0, 10, ["src/math.js"], { role: "manager" }), wrote(REVIEWER, 5, 15, ["src/math.js"], { role: "reviewer" })], inWorkspace);
    expect(found.collisions).toHaveLength(1);
  });

  it("keeps workspaces apart: one path in two projects is two files", () => {
    const found = writersObservedOf([wrote(WORKER, 0, 10, ["src/math.js"]), wrote(OTHER, 5, 15, ["src/math.js"], { workspaceId: "wks_other" })], () => null);
    expect(found.collisions).toEqual([]);
  });
});

describe("collisionsOfTurn: one recorded turn against its workspace", () => {
  it("finds only the recorded turn's pairs, leaving out its own stored copy", () => {
    const mine = wrote(WORKER, 0, 10, ["src/math.js"]);
    const stored = { ...mine };
    const other = wrote(OTHER, 5, 15, ["src/math.js"]);
    const third = wrote(REVIEWER, 6, 16, ["src/math.js"], { role: "reviewer" });
    const found = collisionsOfTurn(mine, [stored, other, third], DIR);
    expect(found.collisions.map((collision) => collision.turns.map((record) => record.agentId))).toEqual([
      [WORKER, OTHER],
      [WORKER, REVIEWER],
    ]);
    expect(collisionsOfTurn(wrote(WORKER, 0, 10, ["docs/x.md"]), [other], DIR)).toEqual({ collisions: [], unknown: [] });
  });
});

describe("settled: the later of the two requests finished (design §F.3)", () => {
  const finished = (requestId: string, minute: number) =>
    turn({ agentId: MANAGER, role: "manager", requestId, at: at(minute), endedAt: at(minute), reports: [report({ at: at(minute), requestId, phase: "finished" })] });

  it("a turn's request: its own, else the one its Worker serves; a Manager's is not guessed", () => {
    const named = wrote(WORKER, 0, 5, [], { requestId: R1 });
    const unnamed = wrote(WORKER, 6, 9, []);
    expect(requestOfTurn(unnamed, [named, unnamed])).toBe(R1);
    expect(requestOfTurn(wrote(MANAGER, 0, 5, [], { role: "manager" }), [turn({ agentId: MANAGER, requestId: R1 })])).toBeNull();
  });

  it("a request is finished while its latest milestone report is finished", () => {
    expect(isRequestFinished(R1, [finished(R1, 20)])).toBe(true);
    const reopened = turn({ agentId: MANAGER, requestId: R1, reports: [report({ at: at(30), requestId: R1, phase: "received" })] });
    expect(isRequestFinished(R1, [finished(R1, 20), reopened])).toBe(false);
    expect(isRequestFinished(R2, [finished(R1, 20)])).toBe(false);
  });

  it("settled only once both requests finished; an unknown request holds nothing open", () => {
    const a = wrote(WORKER, 0, 10, ["src/math.js"], { requestId: R1 });
    const b = wrote(OTHER, 5, 15, ["src/math.js"], { requestId: R2 });
    const [collision] = writersObservedOf([a, b], inWorkspace).collisions;
    expect(isCollisionSettled(collision!, [a, b, finished(R1, 20)])).toBe(false);
    expect(isCollisionSettled(collision!, [a, b, finished(R1, 20), finished(R2, 25)])).toBe(true);
    const manager = wrote(MANAGER, 5, 15, ["src/math.js"], { role: "manager" });
    const [withManager] = writersObservedOf([a, manager], inWorkspace).collisions;
    expect(isCollisionSettled(withManager!, [a, manager, finished(R1, 20)])).toBe(true);
  });
});

// ── The server's watch on a recorded turn ───────────────────────────────────

let root: string;
let home: string;
let location: TraceStoreLocation;
let clock: Date;
let logs: string[];

const watch = () => createWritersWatch({ now: () => clock, log: (message) => logs.push(message) });
const alerts = () => createAlertStore(home, { now: () => clock });
const KEY = alertKeyOf("writers-observed", WORKSPACE_ID, "src/math.js");

/** Appends a record as the collector does, then hands it to the watch as `onRecorded` would. */
async function record(value: TraceRecord, cwd: string | null = DIR) {
  await appendRecord(location, value);
  return watch().turnRecorded(value, location, cwd);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-writers-observed-"));
  home = join(root, "data");
  location = { tracesDir: join(home, "traces") };
  clock = new Date("2026-09-26T10:40:00.000Z");
  logs = [];
  clearTraceStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("the watch on a recorded turn (design §F.1)", () => {
  it("a collision raises one alert (the file, the agents) and returns one event per pair, found when the later turn is recorded", async () => {
    expect(await record(wrote(WORKER, 0, 10, [`${DIR}/src/math.js`], { requestId: R1 }))).toEqual([]);
    const events = await record(wrote(OTHER, 5, 15, ["src/math.js"], { requestId: R2 }));
    expect(events).toEqual([
      {
        type: "writers.observed",
        workspaceId: WORKSPACE_ID,
        file: "src/math.js",
        writers: [
          { agentId: WORKER, role: "worker", requestId: R1, startedAt: at(0) },
          { agentId: OTHER, role: "worker", requestId: R2, startedAt: at(5) },
        ],
        alertKey: KEY,
        at: at(15),
      },
    ]);
    expect(alerts().list({ open: true })).toEqual([
      expect.objectContaining({
        key: KEY,
        kind: "writers-observed",
        workspaceId: WORKSPACE_ID,
        subject: "src/math.js",
        detail: `src/math.js: Worker ${WORKER} (request ${R1}) and Worker ${OTHER} (request ${R2}) wrote it in overlapping turns.`,
      }),
    ]);
    expect(eventKeyOf(events[0]!)).toBe(`writers.observed:${WORKSPACE_ID}:src/math.js:${WORKER}@${at(0)}+${OTHER}@${at(5)}`);
    expect(logs).toEqual([]);
  });

  it("the alert is raised once per key: a second pair on the file keeps it open, names every agent, and is its own event", async () => {
    await record(wrote(WORKER, 0, 10, ["src/math.js"], { requestId: R1 }));
    await record(wrote(OTHER, 5, 15, ["src/math.js"], { requestId: R2 }));
    const since = alerts().get(KEY)!.since;
    clock = new Date("2026-09-26T10:50:00.000Z");
    const third = await record(wrote(REVIEWER, 12, 18, ["src/math.js"], { role: "reviewer", requestId: R2 }));
    expect(third.map((event) => event.writers.map((writer) => writer.agentId))).toEqual([[OTHER, REVIEWER]]);
    const open = alerts().list({ open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ key: KEY, since });
    expect(open[0]!.detail).toBe(`src/math.js: Worker ${OTHER} (request ${R2}), Reviewer ${REVIEWER} (request ${R2}) and Worker ${WORKER} (request ${R1}) wrote it in overlapping turns.`);
  });

  it("nothing for one agent twice, no overlap, a missing start, or a write outside the workspace", async () => {
    await record(wrote(WORKER, 0, 10, ["src/math.js", "/tmp/notes.txt"]));
    expect(await record(wrote(WORKER, 5, 15, ["src/math.js"]))).toEqual([]);
    expect(await record(wrote(OTHER, 30, 40, ["src/math.js"]))).toEqual([]);
    expect(await record(wrote(REVIEWER, null, 12, ["src/math.js"], { role: "reviewer" }))).toEqual([]);
    expect(await record(wrote("agent-worker-3", 1, 9, ["/tmp/notes.txt"]))).toEqual([]);
    expect(alerts().list()).toEqual([]);
  });

  it("places paths against the store's workspace folder first, else the agent's cwd", async () => {
    writeWorkspaceMeta(location, WORKSPACE_ID, { lastKnownName: "invoice", lastKnownDirectory: DIR, lastSeenAt: at(0) });
    await record(wrote(WORKER, 0, 10, [`${DIR}/src/math.js`]), "/somewhere/else");
    expect(await record(wrote(OTHER, 5, 15, ["src/math.js"]), null)).toHaveLength(1);
  });

  it("clears the alert when the later of the two requests finishes, and only then", async () => {
    await record(wrote(WORKER, 0, 10, ["src/math.js"], { requestId: R1 }));
    await record(wrote(OTHER, 5, 15, ["src/math.js"], { requestId: R2 }));
    const finish = (requestId: string, minute: number) =>
      turn({ agentId: MANAGER, role: "manager", turnId: `m-${minute}`, requestId, startedAt: at(minute - 1), endedAt: at(minute), at: at(minute), reports: [report({ at: at(minute), requestId, phase: "finished" })] });
    expect(await record(finish(R1, 20))).toEqual([]);
    expect(alerts().isOpen(KEY)).toBe(true);
    // A report that is not a finish reads nothing.
    await record(turn({ agentId: MANAGER, requestId: R2, turnId: "m-21", endedAt: at(21), at: at(21), reports: [report({ at: at(21), requestId: R2, phase: "bead-implemented" })] }));
    expect(alerts().isOpen(KEY)).toBe(true);
    await record(finish(R2, 25));
    expect(alerts().isOpen(KEY)).toBe(false);
    // A later collision on the file opens it afresh.
    clock = new Date("2026-09-26T11:00:00.000Z");
    await record(wrote(WORKER, 30, 40, ["src/math.js"], { requestId: "req-20260926T103000Z" }));
    expect(await record(wrote(OTHER, 35, 45, ["src/math.js"], { requestId: "req-20260926T103500Z" }))).toHaveLength(1);
    expect(alerts().get(KEY)).toMatchObject({ clearedAt: null, since: clock.toISOString() });
  });

  it("keeps the detail within 300 characters, and never throws into the collector", async () => {
    const long = `src/${"deep/".repeat(80)}file.js`;
    await record(wrote(WORKER, 0, 10, [long]));
    await record(wrote(OTHER, 5, 15, [long]));
    const [alert] = alerts().list({ open: true });
    expect([...alert!.detail!].length).toBeLessThanOrEqual(MAX_ALERT_DETAIL_CHARS);
    expect(alert!.detail!.endsWith("…")).toBe(true);
    // No usable data folder: one log line, no event.
    const broken = createWritersWatch({ home: () => { throw new Error("no folder"); }, log: (message) => logs.push(message) });
    expect(broken.turnRecorded(wrote(OTHER, 5, 15, ["src/math.js"]), location, DIR)).toEqual([]);
    expect(logs).toEqual([expect.stringContaining("no folder")]);
    expect(watch().turnRecorded(undefined, location)).toEqual([]);
  });

  it("its event line names the file, both agents with their requests, and what to do", async () => {
    await record(wrote(WORKER, 0, 10, ["src/math.js"], { requestId: R1 }));
    const [event] = await record(wrote(OTHER, 5, 15, ["src/math.js"]));
    expect(eventLineOf(event!)).toBe(
      `- writers.observed — project ${WORKSPACE_ID}, file src/math.js: Worker ${WORKER} (request ${R1}) and Worker ${OTHER} (request not known) wrote it in overlapping turns, at ${at(15)}. Check the file with bm_repo; if one change may have undone the other, tell that request's Manager with bm_send_command. Otherwise keep a note with bm_note.`,
    );
  });
});
