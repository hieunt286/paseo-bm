import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DECISIONS_DIR_NAME,
  DECISIONS_FILE_VERSION,
  DECISION_SETTLED_LIMIT,
  capDecisions,
  clearDecisionStoreCache,
  createDecisionStore,
} from "../plugin/server/decision-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { DashboardError } from "../plugin/shared/contracts";
import { answerDecision, withdrawDecision, type Decision } from "../plugin/shared/decisions";
import { DECISION_REQUEST, DECISION_WS, makeDecision } from "./helpers/decisions";

/**
 * The decision store (autonomy design §A.4) against a temporary data folder.
 * Never the real HOME.
 */

const AT = "2026-09-29T08:00:00.000Z";
let root: string;
let home: string;
let logs: string[];

const store = () => createDecisionStore(home, { log: (message) => logs.push(message) });
const fileOf = (workspaceId: string) => join(home, DECISIONS_DIR_NAME, `${workspaceId}.json`);
const modeOf = (path: string) => statSync(path).mode & 0o777;
const question = (n: number, overrides: Partial<Decision> = {}) =>
  makeDecision({ id: `q:${DECISION_REQUEST}:Q${n}`, ...overrides });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-decision-store-"));
  home = join(root, "data");
  logs = [];
  clearDecisionStoreCache();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("files and permissions", () => {
  it("creates nothing on a read, and reads a missing store as empty", () => {
    expect(store().list()).toEqual([]);
    expect(store().get(question(1).id)).toBeNull();
    expect(store().read(DECISION_WS)).toEqual({ entries: [], skipped: 0 });
    expect(existsSync(home)).toBe(false);
  });

  it("writes { version: 1, entries } as a 0600 file in a 0700 folder", () => {
    const { created } = store().open(question(1));
    expect(created).toBe(true);
    expect(modeOf(join(home, DECISIONS_DIR_NAME))).toBe(0o700);
    expect(modeOf(fileOf(DECISION_WS))).toBe(0o600);
    const file = JSON.parse(readFileSync(fileOf(DECISION_WS), "utf8")) as { version: number; entries: Decision[] };
    expect(file.version).toBe(DECISIONS_FILE_VERSION);
    expect(file.entries).toEqual([question(1)]);
  });

  it("replaces the file atomically, leaving no temporary file", () => {
    const s = store();
    s.open(question(1));
    s.open(question(2));
    s.transition(question(1).id, (d) => answerDecision(d, { via: "inbox", optionKey: "a", at: AT }));
    expect(readdirSync(join(home, DECISIONS_DIR_NAME))).toEqual([`${DECISION_WS}.json`]);
    expect(s.read(DECISION_WS).entries.map((entry) => entry.status)).toEqual(["answered", "open"]);
  });

  it("refuses a symlinked decisions folder and a symlinked workspace file", () => {
    mkdirSync(home, { recursive: true });
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, DECISIONS_DIR_NAME));
    expect(() => store().open(question(1))).toThrow(/symlink/);
    expect(() => store().list()).toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);

    rmSync(join(home, DECISIONS_DIR_NAME));
    store().open(question(1));
    const target = join(elsewhere, "target.json");
    writeFileSync(target, JSON.stringify({ version: 1, entries: [makeDecision({ workspaceId: "wks_2" })] }));
    symlinkSync(target, fileOf("wks_2"));
    expect(() => store().read("wks_2")).toThrow(/symlink/);
    expect(() => store().open(makeDecision({ workspaceId: "wks_2" }))).toThrow(/symlink/);
    // A list across workspaces skips that one file and says so.
    expect(store().list().map((entry) => entry.workspaceId)).toEqual([DECISION_WS]);
    expect(logs.join("\n")).toMatch(/wks_2 \(a symlink\)/);
  });

  it("refuses a workspace id that is not a file name", () => {
    expect(() => store().open(makeDecision({ workspaceId: "../escape" }))).toThrow(/E_TRACE_STORE_UNWRITABLE/);
    expect(existsSync(join(root, "escape.json"))).toBe(false);
  });

  it("leaves a file written by a newer paseo-bm alone", () => {
    mkdirSync(join(home, DECISIONS_DIR_NAME), { recursive: true });
    const body = JSON.stringify({ version: 2, entries: [{ anything: true }] });
    writeFileSync(fileOf(DECISION_WS), body);
    expect(store().list()).toEqual([]);
    expect(() => store().open(question(1))).toThrow(/E_DECISION_WRITE_FAILED/);
    expect(readFileSync(fileOf(DECISION_WS), "utf8")).toBe(body);
  });

  it("refuses a newer file with a coded error, whatever else it holds (code review 2026-09-30 §3.1)", () => {
    mkdirSync(join(home, DECISIONS_DIR_NAME), { recursive: true });
    // No entries array at all: the version alone decides.
    const body = JSON.stringify({ version: 2 });
    writeFileSync(fileOf(DECISION_WS), body);
    let thrown: unknown = null;
    try {
      store().open(question(1));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DashboardError);
    expect((thrown as DashboardError).code).toBe("E_DECISION_WRITE_FAILED");
    expect(store().deleteSettled(DECISION_WS, [DECISION_REQUEST])).toBe(0);
    expect(readFileSync(fileOf(DECISION_WS), "utf8")).toBe(body);
  });
});

describe("reading what is there", () => {
  it("skips a malformed entry alone, and the next write drops it", () => {
    mkdirSync(join(home, DECISIONS_DIR_NAME), { recursive: true });
    writeFileSync(
      fileOf(DECISION_WS),
      JSON.stringify({
        version: 1,
        entries: [question(1), { id: "broken" }, question(2, { workspaceId: "wks_other" }), question(3)],
      }),
    );
    expect(store().read(DECISION_WS)).toEqual({ entries: [question(1), question(3)], skipped: 2 });
    store().open(question(4));
    expect(store().read(DECISION_WS)).toEqual({ entries: [question(1), question(3), question(4)], skipped: 0 });
  });

  it("reads a corrupt file as empty", () => {
    mkdirSync(join(home, DECISIONS_DIR_NAME), { recursive: true });
    writeFileSync(fileOf(DECISION_WS), "{ not json");
    expect(store().read(DECISION_WS)).toEqual({ entries: [], skipped: 0 });
  });

  it("lists across workspaces and filters by workspace, request and status", () => {
    const s = store();
    s.open(question(1));
    s.open(question(2));
    s.open(makeDecision({ workspaceId: "wks_2", id: "q:req-B:Q1", requestId: "req-B" }));
    s.transition(question(2).id, (d) => withdrawDecision(d, { at: AT }));
    // Not a workspace file: ignored.
    writeFileSync(join(home, DECISIONS_DIR_NAME, "notes.txt"), "x");

    expect(s.workspaceIds()).toEqual([DECISION_WS, "wks_2"]);
    expect(s.list().map((entry) => entry.id)).toEqual([question(1).id, question(2).id, "q:req-B:Q1"]);
    expect(s.list({ workspaceId: "wks_2" }).map((entry) => entry.id)).toEqual(["q:req-B:Q1"]);
    expect(s.list({ requestId: "req-B" }).map((entry) => entry.id)).toEqual(["q:req-B:Q1"]);
    expect(s.list({ statuses: ["withdrawn"] }).map((entry) => entry.id)).toEqual([question(2).id]);
    expect(s.get("q:req-B:Q1")?.workspaceId).toBe("wks_2");
    expect(s.get("q:req-B:Q1", DECISION_WS)).toBeNull();
  });

  it("sees a file changed by someone else through the mtime cache", () => {
    const s = store();
    s.open(question(1));
    expect(s.list()).toHaveLength(1);
    const file = JSON.parse(readFileSync(fileOf(DECISION_WS), "utf8")) as { version: number; entries: Decision[] };
    file.entries.push(question(2));
    writeFileSync(fileOf(DECISION_WS), JSON.stringify(file));
    expect(s.list().map((entry) => entry.id)).toEqual([question(1).id, question(2).id]);
  });
});

describe("opening and changing decisions", () => {
  it("opens idempotently by id (a re-read turn changes nothing)", () => {
    const s = store();
    expect(s.open(question(1)).created).toBe(true);
    const again = s.open(question(1, { question: "Different text from a re-read turn?" }));
    expect(again).toEqual({ decision: question(1), created: false, superseded: null });
    expect(s.list()).toHaveLength(1);
  });

  it("supersedes the unsettled decision named by supersedes in the same write", () => {
    const s = store();
    s.open(question(2));
    const at = "2026-09-29T09:00:00.000Z";
    const result = s.open(question(4, { supersedes: question(2).id, askedAt: at }));
    expect(result.superseded?.status).toBe("superseded");
    expect(result.superseded?.supersededBy).toBe(question(4).id);
    expect(result.superseded?.settledAt).toBe(at);
    expect(s.get(question(2).id)?.status).toBe("superseded");
    expect(s.get(question(4).id)?.supersedes).toBe(question(2).id);
  });

  it("leaves a settled or missing decision named by supersedes as it is", () => {
    const s = store();
    s.open(question(2));
    s.transition(question(2).id, (d) => answerDecision(d, { via: "inbox", optionKey: "a", at: AT }));
    expect(s.open(question(4, { supersedes: question(2).id })).superseded).toBeNull();
    expect(s.get(question(2).id)?.status).toBe("answered");
    expect(s.open(question(5, { supersedes: question(9).id })).superseded).toBeNull();
  });

  it("refuses to store a decision that does not validate", () => {
    expect(() => store().open(question(1, { question: "" }))).toThrow();
    expect(existsSync(fileOf(DECISION_WS))).toBe(false);
  });

  it("writes a transition, and nothing on a refusal or an unknown id", () => {
    const s = store();
    s.open(question(1));
    const updated = s.transition(question(1).id, (d) => answerDecision(d, { via: "inbox", optionKey: "a", at: AT }));
    expect(updated.status).toBe("updated");
    const before = readFileSync(fileOf(DECISION_WS), "utf8");
    const refused = s.transition(question(1).id, (d) => answerDecision(d, { via: "inbox", optionKey: "b", at: AT }));
    expect(refused).toMatchObject({ status: "refused", refusal: "settled" });
    expect(readFileSync(fileOf(DECISION_WS), "utf8")).toBe(before);
    expect(s.transition("q:req-none:Q1", (d) => ({ ok: true, decision: d }))).toEqual({ status: "not-found" });
  });

  it("refuses a transition that moves the decision to another id or workspace", () => {
    const s = store();
    s.open(question(1));
    expect(() => s.transition(question(1).id, (d) => ({ ok: true, decision: { ...d, workspaceId: "wks_2" } }))).toThrow(/E_DECISION_WRITE_FAILED/);
  });
});

describe("caps and deletion", () => {
  const settledAt = (i: number) => new Date(Date.parse(AT) + i * 1000).toISOString();
  const answeredAt = (i: number): Decision => {
    const result = answerDecision(question(i), { via: "inbox", optionKey: "c", at: settledAt(i) });
    if (!result.ok) throw new Error(result.message);
    return result.decision;
  };

  it("keeps every open decision and the newest 500 settled", () => {
    const entries: Decision[] = [question(900), ...Array.from({ length: DECISION_SETTLED_LIMIT + 3 }, (_, i) => answeredAt(i + 1)), question(901)];
    const kept = capDecisions(entries);
    expect(kept).toHaveLength(DECISION_SETTLED_LIMIT + 2);
    expect(kept[0]!.id).toBe(question(900).id);
    expect(kept.at(-1)!.id).toBe(question(901).id);
    // The three oldest settled went.
    expect(kept.some((entry) => entry.id === question(1).id || entry.id === question(3).id)).toBe(false);
    expect(kept.some((entry) => entry.id === question(4).id)).toBe(true);
  });

  it("never evicts an open decision, however many there are", () => {
    const open = Array.from({ length: DECISION_SETTLED_LIMIT + 10 }, (_, i) => question(i + 1));
    expect(capDecisions(open)).toHaveLength(DECISION_SETTLED_LIMIT + 10);
  });

  it("applies the cap on write", () => {
    mkdirSync(join(home, DECISIONS_DIR_NAME), { recursive: true });
    const entries = Array.from({ length: DECISION_SETTLED_LIMIT + 1 }, (_, i) => answeredAt(i + 1));
    writeFileSync(fileOf(DECISION_WS), JSON.stringify({ version: 1, entries }));
    store().open(question(999));
    const stored = store().read(DECISION_WS).entries;
    expect(stored).toHaveLength(DECISION_SETTLED_LIMIT + 1);
    expect(stored.some((entry) => entry.id === question(1).id)).toBe(false);
  });

  it("deletes only the settled decisions of the named requests in that workspace", () => {
    const s = store();
    s.open(question(1));
    s.open(question(2));
    s.open(makeDecision({ id: "q:req-B:Q1", requestId: "req-B" }));
    s.open(makeDecision({ workspaceId: "wks_2" }));
    s.transition(question(1).id, (d) => answerDecision(d, { via: "inbox", optionKey: "a", at: AT }), DECISION_WS);
    s.transition("q:req-B:Q1", (d) => withdrawDecision(d, { at: AT }));
    s.transition(question(1).id, (d) => answerDecision(d, { via: "inbox", optionKey: "a", at: AT }), "wks_2");

    expect(s.deleteSettled(DECISION_WS, [])).toBe(0);
    expect(s.deleteSettled(DECISION_WS, [DECISION_REQUEST])).toBe(1);
    expect(s.list({ workspaceId: DECISION_WS }).map((entry) => entry.id)).toEqual([question(2).id, "q:req-B:Q1"]);
    // The same request id in another workspace is another request.
    expect(s.list({ workspaceId: "wks_2" })).toHaveLength(1);
  });

  it("is deleted whole by cleanup", () => {
    expect(CLEANUP_DELETES).toContain(DECISIONS_DIR_NAME);
  });
});
