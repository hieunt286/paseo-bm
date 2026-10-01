import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HANDOFFS_DIR_NAME,
  HANDOFF_FILE_VERSION,
  HANDOFF_SAFE_POINT_WAIT_MS,
  MANAGER_WAIT_MS,
  NOTE_WAIT_MS,
  SUCCESSOR_WAIT_MS,
  createHandoffStore,
  endedHandoff,
  handoffsDoneOf,
  lastHandoffAtOf,
  pendingHandoffOf,
  staleEndingOf,
  type HandoffEntry,
} from "../plugin/server/handoff-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { INTERVENTION_WINDOW_MS } from "../plugin/shared/interventions";
import { requestFinishedOf, requestTokensReadOf } from "../plugin/shared/handoff";
import type { TraceRecord, Usage } from "../plugin/shared/contracts";
import { report, turn } from "./fixtures/orchestrator-traces";

/**
 * The handoff store (autonomy design §G.6 step 2; bead `7gxw.11`):
 * `<data folder>/handoffs/<id>.json`, one file per handoff with its brief,
 * under every store's file rules; the pending, done and stale readings the
 * tool, the runner and the event bus share; and the request's readings the
 * threshold is judged on. A temporary data folder only.
 */

const REQUEST = "req-20260930T100000Z";
const T0 = Date.parse("2026-09-30T11:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let root: string;
let home: string;
let clock: Date;
let ids: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-handoff-store-"));
  home = join(root, "data");
  clock = new Date(T0);
  ids = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const store = () => createHandoffStore(home, { now: () => clock, newId: () => `h${++ids}` });
const dir = () => join(home, HANDOFFS_DIR_NAME);
const modeOf = (path: string) => statSync(path).mode & 0o777;
const input = { workspaceId: "wks_invoice", requestId: REQUEST, workerId: "agent-worker", managerId: "agent-manager", interventionId: "i1", reason: "Heavy." };

describe("the store", () => {
  it("lists nothing and creates nothing until the first write; then a 0700 folder and one 0600 file per handoff; cleanup deletes the folder", () => {
    expect(store().list()).toEqual([]);
    expect(existsSync(home)).toBe(false);
    const entry = store().add(input);
    expect(entry).toEqual({
      id: "h1",
      ...input,
      state: "waiting",
      requestedAt: iso(T0),
      noteAskedAt: null,
      note: null,
      briefAt: null,
      brief: null,
      commandId: null,
      commandSentAt: null,
      successorId: null,
      successorAt: null,
      endedAt: null,
      ending: null,
    });
    expect(modeOf(dir())).toBe(0o700);
    expect(readdirSync(dir())).toEqual(["h1.json"]);
    expect(modeOf(join(dir(), "h1.json"))).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir(), "h1.json"), "utf8"))).toEqual({ version: HANDOFF_FILE_VERSION, handoff: entry });
    expect(store().get("h1")).toEqual(entry);
    expect(CLEANUP_DELETES).toContain(HANDOFFS_DIR_NAME);
  });

  it("updates one entry in one write, and writes nothing for no change or an id that is not a plain name", () => {
    store().add(input);
    const updated = store().update("h1", (entry) => ({ ...entry, state: "noting", noteAskedAt: iso(T0 + MIN) }));
    expect(updated).toMatchObject({ state: "noting", noteAskedAt: iso(T0 + MIN) });
    const bytes = readFileSync(join(dir(), "h1.json"), "utf8");
    expect(store().update("h1", (entry) => entry)).toEqual(updated);
    expect(readFileSync(join(dir(), "h1.json"), "utf8")).toBe(bytes);
    expect(store().update("../evil", (entry) => entry)).toBeNull();
    expect(store().get("../evil")).toBeNull();
    expect(store().update("h9", (entry) => entry)).toBeNull();
  });

  it("skips a corrupt, invalid or newer file on its own, and never writes over a newer one", () => {
    store().add(input);
    clock = new Date(T0 + MIN);
    store().add(input);
    writeFileSync(join(dir(), "h3.json"), "{ not json");
    writeFileSync(join(dir(), "h4.json"), JSON.stringify({ version: 1, handoff: { id: "h4", state: "sideways" } }));
    writeFileSync(join(dir(), "h5.json"), JSON.stringify({ version: 2, handoff: { ...store().get("h1"), id: "h5" } }));
    writeFileSync(join(dir(), "notes.txt"), "not a handoff");
    expect(store().list().map((entry) => entry.id)).toEqual(["h1", "h2"]);
    const newer = readFileSync(join(dir(), "h5.json"), "utf8");
    expect(() => store().update("h5", (entry) => ({ ...entry, state: "done" }))).toThrow(/written by a newer paseo-bm/);
    expect(readFileSync(join(dir(), "h5.json"), "utf8")).toBe(newer);
  });

  it("refuses a symlinked handoffs folder and writes nothing through it", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, dir());
    expect(() => store().list()).toThrow();
    expect(() => store().add(input)).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("pending, done and stale (design §G.6, §G.7)", () => {
  const entryOf = (over: Partial<HandoffEntry> = {}): HandoffEntry => ({ ...store().add(input), ...over });

  it("its bounds: an hour for a safe point, the note's 10 minutes go on without it, 30 minutes for the Manager and for the successor", () => {
    expect(HANDOFF_SAFE_POINT_WAIT_MS).toBe(INTERVENTION_WINDOW_MS.handoff);
    expect(NOTE_WAIT_MS).toBe(10 * MIN);
    const waiting = entryOf();
    expect(staleEndingOf(waiting, T0 + HANDOFF_SAFE_POINT_WAIT_MS)).toBeNull();
    expect(staleEndingOf(waiting, T0 + HANDOFF_SAFE_POINT_WAIT_MS + 1)).toBe("no-safe-point");
    expect(staleEndingOf(entryOf({ state: "noting", noteAskedAt: iso(T0) }), T0 + 5 * 60 * MIN)).toBeNull();
    expect(staleEndingOf(entryOf({ state: "briefed", briefAt: iso(T0) }), T0 + MANAGER_WAIT_MS + 1)).toBe("manager-busy");
    expect(staleEndingOf(entryOf({ state: "commanded", commandSentAt: iso(T0) }), T0 + SUCCESSOR_WAIT_MS + 1)).toBe("no-successor");
    expect(staleEndingOf(entryOf({ state: "done" }), T0 + 10 * 60 * MIN)).toBeNull();
    expect(endedHandoff(waiting, "off", iso(T0))).toMatchObject({ state: "dropped", ending: "off", endedAt: iso(T0) });
    expect(endedHandoff({ ...waiting, commandSentAt: iso(T0) }, "no-successor", iso(T0))).toMatchObject({ state: "failed" });
  });

  it("the request's pending handoff, its handoffs so far and the newest one's time", () => {
    const waiting = entryOf();
    const done = [entryOf({ state: "done", successorId: "s2", successorAt: iso(T0 + 20 * MIN) }), entryOf({ state: "done", successorId: "s1", successorAt: iso(T0 + 10 * MIN) })];
    const failed = entryOf({ state: "failed", ending: "no-successor", commandSentAt: iso(T0) });
    const entries = [waiting, ...done, failed];
    expect(pendingHandoffOf(entries, REQUEST, T0)).toEqual(waiting);
    expect(pendingHandoffOf(entries, REQUEST, T0 + HANDOFF_SAFE_POINT_WAIT_MS + 1)).toBeNull();
    expect(pendingHandoffOf(entries, "req-20260930T120000Z", T0)).toBeNull();
    expect(handoffsDoneOf(entries, REQUEST).map((entry) => entry.successorId)).toEqual(["s1", "s2"]);
    expect(lastHandoffAtOf(entries, REQUEST)).toBe(T0 + 20 * MIN);
    expect(lastHandoffAtOf([waiting], REQUEST)).toBeNull();
  });
});

describe("the request's readings (design §G.7, change-008 C2)", () => {
  const usage = (read: number, model = "claude-opus-5"): Usage => ({ inputTokens: 1_000, cachedInputTokens: read - 1_000, outputTokens: 10, costUsd: null, costBasis: "unavailable", model, pricesUpdatedAt: null });
  const at = (minute: number) => iso(T0 + minute * MIN);
  const record = (agentId: string, minute: number, read: number | null, requestId: string | null = REQUEST): TraceRecord =>
    turn({ agentId, role: agentId.startsWith("m") ? "manager" : "worker", requestId, at: at(minute), endedAt: at(minute), usage: read === null ? null : usage(read) });

  it("tokens read: every turn of the request, whatever the role, since it started or since its last handoff", () => {
    const records = [record("w1", 5, 2_000_000), record("m1", 6, 500_000), record("w1", 8, 3_000_000), record("w2", 12, 1_000_000), record("w1", 9, 9_000_000, "req-other"), record("w1", 10, null)];
    expect(requestTokensReadOf(records, REQUEST, null)).toBe(6_500_000);
    expect(requestTokensReadOf(records, REQUEST, T0 + 7 * MIN)).toBe(4_000_000);
    expect(requestTokensReadOf(records, REQUEST, T0 + 60 * MIN)).toBeNull();
    expect(requestTokensReadOf([record("w1", 10, null)], REQUEST, null)).toBeNull();
  });

  it("finished: its latest report, by time, is finished", () => {
    const reported = (minute: number, phase: "finished" | "beads-done") => turn({ requestId: REQUEST, at: at(minute), endedAt: at(minute), reports: [report({ requestId: REQUEST, at: at(minute), phase })] });
    expect(requestFinishedOf([reported(5, "beads-done")], REQUEST)).toBe(false);
    expect(requestFinishedOf([reported(5, "beads-done"), reported(9, "finished")], REQUEST)).toBe(true);
    expect(requestFinishedOf([reported(9, "finished"), reported(12, "beads-done")], REQUEST)).toBe(false);
    expect(requestFinishedOf([], REQUEST)).toBe(false);
  });
});
