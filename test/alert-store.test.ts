import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALERTS_FILE,
  ALERT_CLEARED_LIMIT,
  INBOX_DIR_NAME,
  createAlertStore,
  raiseInboxAlert,
} from "../plugin/server/alert-store";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { ALERT_KINDS, MAX_ALERT_DETAIL_CHARS, alertKeyOf } from "../plugin/shared/alerts";

/**
 * The Inbox alerts store (autonomy design §A.8): `<data>/inbox/alerts.json`,
 * raised once per key, cleared when the condition ends, raised afresh after;
 * the decision store's file rules. A temporary data folder only.
 */

const WS = "wks_1";
const T0 = Date.parse("2026-09-29T08:00:00.000Z");

let root: string;
let home: string;
let clock: number;

const store = () => createAlertStore(home, { now: () => new Date(clock) });
const file = () => join(home, INBOX_DIR_NAME, ALERTS_FILE);
const modeOf = (path: string) => statSync(path).mode & 0o777;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-alert-store-"));
  home = join(root, "data");
  clock = T0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the alerts file", () => {
  it("names the seven kinds of the design", () => {
    expect(ALERT_KINDS).toEqual(["request-stalled", "permission-waiting", "danger", "stuck", "pairing-mismatch", "outdated-agent", "fallback-failed"]);
    expect(alertKeyOf("stuck", WS, "agent-w")).toBe(`stuck:${WS}:agent-w`);
    expect(alertKeyOf("pairing-mismatch", null, "agent-w")).toBe("pairing-mismatch:-:agent-w");
  });

  it("creates nothing on a read, then a 0700 folder and a 0600 file on the first write, and cleanup deletes it", () => {
    const s = store();
    expect(s.list()).toEqual([]);
    expect(s.isOpen(alertKeyOf("stuck", WS, "w"))).toBe(false);
    expect(s.clear(alertKeyOf("stuck", WS, "w"))).toBe(false);
    expect(existsSync(home)).toBe(false);
    s.raise({ workspaceId: WS, kind: "stuck", subject: "w" });
    expect(modeOf(join(home, INBOX_DIR_NAME))).toBe(0o700);
    expect(modeOf(file())).toBe(0o600);
    expect(readdirSync(join(home, INBOX_DIR_NAME))).toEqual([ALERTS_FILE]);
    expect(CLEANUP_DELETES).toContain(INBOX_DIR_NAME);
  });

  it("raises an alert once per key, clears it when the condition ends, and raises it afresh after", () => {
    const s = store();
    const key = alertKeyOf("request-stalled", WS, "req-1");
    expect(s.raise({ workspaceId: WS, kind: "request-stalled", subject: "req-1", detail: "idle-unfinished" })).toEqual({
      raised: true,
      alert: { key, workspaceId: WS, kind: "request-stalled", subject: "req-1", since: iso(T0), clearedAt: null, detail: "idle-unfinished" },
    });
    clock = T0 + 60_000;
    // Raised again while open: nothing new, only the detail may move on.
    expect(s.raise({ workspaceId: WS, kind: "request-stalled", subject: "req-1", detail: "idle-unfinished" }).raised).toBe(false);
    expect(s.raise({ workspaceId: WS, kind: "request-stalled", subject: "req-1", detail: "idle-unfinished, review-over-budget" })).toMatchObject({
      raised: false,
      alert: { since: iso(T0), detail: "idle-unfinished, review-over-budget" },
    });
    clock = T0 + 120_000;
    expect(s.clear(key)).toBe(true);
    expect(s.clear(key)).toBe(false);
    expect(s.get(key)).toMatchObject({ clearedAt: iso(T0 + 120_000) });
    clock = T0 + 180_000;
    expect(s.raise({ workspaceId: WS, kind: "request-stalled", subject: "req-1" })).toMatchObject({ raised: true, alert: { since: iso(T0 + 180_000), clearedAt: null } });
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      entries: { [key]: { workspaceId: WS, kind: "request-stalled", subject: "req-1", since: iso(T0 + 180_000), clearedAt: null } },
    });
  });

  it("lists by state, project, kind and subject, oldest first, and clears what matches", () => {
    const s = store();
    s.raise({ workspaceId: WS, kind: "danger", subject: "w1" });
    clock = T0 + 1_000;
    s.raise({ workspaceId: "wks_2", kind: "stuck", subject: "w2" });
    s.raise({ workspaceId: WS, kind: "permission-waiting", subject: "w1" });
    expect(s.list({ workspaceId: WS }).map((alert) => alert.kind)).toEqual(["danger", "permission-waiting"]);
    expect(s.list({ kinds: ["stuck"] }).map((alert) => alert.subject)).toEqual(["w2"]);
    expect(s.clearWhere((alert) => alert.subject === "w1").sort()).toEqual([alertKeyOf("danger", WS, "w1"), alertKeyOf("permission-waiting", WS, "w1")].sort());
    expect(s.list({ open: true }).map((alert) => alert.subject)).toEqual(["w2"]);
    expect(s.list({ open: false })).toHaveLength(2);
  });

  it("keeps the detail on one line, cut to its limit", () => {
    const s = store();
    const alert = s.raise({ workspaceId: WS, kind: "danger", subject: "w", detail: `git push\n  origin ${"x".repeat(1_000)}` }).alert;
    expect(alert.detail!.startsWith("git push origin x")).toBe(true);
    expect([...alert.detail!]).toHaveLength(MAX_ALERT_DETAIL_CHARS);
    expect(s.raise({ workspaceId: WS, kind: "stuck", subject: "w", detail: "   " }).alert).not.toHaveProperty("detail");
  });

  it("never evicts an open alert; keeps the newest cleared ones", () => {
    const entries: Record<string, unknown> = {};
    const open = alertKeyOf("stuck", WS, "open");
    entries[open] = { workspaceId: WS, kind: "stuck", subject: "open", since: iso(T0 - 1), clearedAt: null };
    for (let i = 0; i < ALERT_CLEARED_LIMIT; i += 1) {
      entries[alertKeyOf("stuck", WS, `w${i}`)] = { workspaceId: WS, kind: "stuck", subject: `w${i}`, since: iso(T0), clearedAt: iso(T0 + i) };
    }
    mkdirSync(join(home, INBOX_DIR_NAME), { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: 1, entries }));
    const s = store();
    s.raise({ workspaceId: WS, kind: "danger", subject: "new" });
    s.clear(alertKeyOf("danger", WS, "new"));
    const kept = Object.keys((JSON.parse(readFileSync(file(), "utf8")) as { entries: Record<string, unknown> }).entries);
    expect(kept).toContain(open);
    expect(kept).not.toContain(alertKeyOf("stuck", WS, "w0"));
    expect(kept.filter((key) => key !== open)).toHaveLength(ALERT_CLEARED_LIMIT);
  });

  it("skips an entry that does not validate or sits under another key, and reads a corrupt file as empty", () => {
    mkdirSync(join(home, INBOX_DIR_NAME), { recursive: true });
    const good = { workspaceId: WS, kind: "stuck", subject: "w", since: iso(T0), clearedAt: null };
    writeFileSync(
      file(),
      JSON.stringify({ version: 1, entries: { [alertKeyOf("stuck", WS, "w")]: good, "danger:wks_1:w": good, "stuck:wks_1:x": { ...good, kind: "boom" }, __proto__: good } }),
    );
    expect(store().list().map((alert) => alert.key)).toEqual([alertKeyOf("stuck", WS, "w")]);
    writeFileSync(file(), "{not json");
    expect(store().list()).toEqual([]);
  });

  it("reads a file from a newer paseo-bm as empty and never writes it", () => {
    mkdirSync(join(home, INBOX_DIR_NAME), { recursive: true });
    const newer = JSON.stringify({ version: 2, entries: {} });
    writeFileSync(file(), newer);
    expect(store().list()).toEqual([]);
    expect(() => store().raise({ workspaceId: WS, kind: "stuck", subject: "w" })).toThrow(/newer paseo-bm/);
    expect(readFileSync(file(), "utf8")).toBe(newer);
  });

  it("refuses a symlinked inbox folder", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(home);
    symlinkSync(elsewhere, join(home, INBOX_DIR_NAME));
    expect(() => store().list()).toThrow();
    expect(() => store().raise({ workspaceId: WS, kind: "stuck", subject: "w" })).toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("raiseInboxAlert raises in the data folder, and throws without a usable one", () => {
    const deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => new Date(clock) };
    expect(raiseInboxAlert({ workspaceId: null, kind: "pairing-mismatch", subject: "agent-w" }, deps).raised).toBe(true);
    expect(store().list().map((alert) => alert.key)).toEqual(["pairing-mismatch:-:agent-w"]);
    expect(() =>
      raiseInboxAlert(
        { workspaceId: null, kind: "pairing-mismatch", subject: "agent-w" },
        {
          env: {},
          homedir: () => {
            throw new Error("no home folder");
          },
        },
      ),
    ).toThrow();
  });
});
