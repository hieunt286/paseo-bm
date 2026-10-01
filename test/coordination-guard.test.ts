import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertRowOf } from "../plugin/client/inbox-model";
import { createAlertStore } from "../plugin/server/alert-store";
import { handleCoordinationSet } from "../plugin/server/coordination-rpc";
import { COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE, createCoordinationStore } from "../plugin/server/coordination-store";
import { GUARD_ENTRIES, belowTargetOf, createCoordinationGuard, guardCoordination, switchedOffDetail } from "../plugin/server/coordination-guard";
import { INTERVENTIONS_FILE } from "../plugin/server/intervention-store";
import { ORCHESTRATOR_DIR_NAME } from "../plugin/server/orchestrator-store";
import { alertKeyOf } from "../plugin/shared/alerts";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import {
  A12_TARGET,
  EXPECTED_OUTCOME_OF,
  INTERVENTION_WINDOW_MS,
  interventionEntrySchema,
  type InterventionEntry,
  type InterventionKind,
  type InterventionOutcome,
} from "../plugin/shared/interventions";

/**
 * The A-12 guard of compaction and handoff (autonomy design §G.3, §G.7; bead
 * 7gxw.9): below target over the last 10 checked entries → the mechanism off
 * and one Inbox alert; only the owner turns it on again, which ends the alert
 * and makes A-12 count afresh. A temporary data folder only; never the real
 * HOME.
 */

const WS = "wks_invoice";
const T0 = Date.parse("2026-09-30T08:00:00.000Z");
const minute = (n: number) => new Date(T0 + n * 60_000).toISOString();
const NOW = new Date(T0 + 24 * 60 * 60_000);
const COMPACT_OFF_KEY = alertKeyOf("coordination-off", null, "compact");

let root: string;
let home: string;
let logs: string[];
let serial: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-coordination-guard-"));
  home = join(root, "data");
  logs = [];
  serial = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One settled (or pending) entry of the intervention log, recorded at minute `at`. */
function entry(kind: InterventionKind, outcome: InterventionOutcome, at: number): InterventionEntry {
  serial += 1;
  return interventionEntrySchema.parse({
    id: `i-${serial}`,
    kind,
    workspaceId: WS,
    requestId: null,
    targetAgentId: "agent-worker",
    trigger: "orchestrator",
    expected: EXPECTED_OUTCOME_OF[kind],
    windowMs: INTERVENTION_WINDOW_MS[kind],
    at: minute(at),
    outcome,
    checkedAt: outcome === "pending" ? null : minute(at + 30),
  });
}

/** `met` met and `missed` missed entries of `kind`, from minute `from` on, the misses first. */
function run(kind: InterventionKind, met: number, missed: number, from = 0): InterventionEntry[] {
  return [
    ...Array.from({ length: missed }, (_, index) => entry(kind, "missed", from + index)),
    ...Array.from({ length: met }, (_, index) => entry(kind, "met", from + missed + index)),
  ];
}

function writeLog(entries: readonly InterventionEntry[]): void {
  mkdirSync(join(home, ORCHESTRATOR_DIR_NAME), { recursive: true });
  writeFileSync(join(home, ORCHESTRATOR_DIR_NAME, INTERVENTIONS_FILE), JSON.stringify({ version: 1, entries }));
}

const settings = () => createCoordinationStore(home).read();
const openAlerts = () => createAlertStore(home).list({ open: true });
const guard = (at: Date = NOW) => guardCoordination(home, { now: () => at, log: (line) => logs.push(line) });
const ownerTurnsOn = (key: "compact.enabled" | "handoff.enabled", at: Date) => handleCoordinationSet({ key, value: true }, { home, now: () => at, log: (line) => logs.push(line) });

describe("belowTargetOf: A-12 over the last 10 checked entries of a kind (pure)", () => {
  it("judges only with 10 checked entries, and below 80 % only", () => {
    expect(GUARD_ENTRIES).toBe(10);
    expect(A12_TARGET).toBe(0.8);
    expect(belowTargetOf(run("compact", 2, 7), "compact", null)).toBeNull();
    expect(belowTargetOf(run("compact", 8, 2), "compact", null)).toBeNull();
    expect(belowTargetOf(run("compact", 7, 3), "compact", null)).toEqual({ met: 7, missed: 3, checked: 10, share: 0.7 });
    expect(belowTargetOf(run("handoff", 0, 10), "handoff", null)).toEqual({ met: 0, missed: 10, checked: 10, share: 0 });
  });

  it("counts met and missed only, of its own kind, the newest ten", () => {
    const pendingAndUnknown = [entry("compact", "pending", 20), entry("compact", "unknown", 21), entry("compact", "unknown", 22)];
    const otherKinds = run("handoff", 0, 5, 30).concat(run("answer", 0, 5, 40));
    expect(belowTargetOf([...run("compact", 7, 2), ...pendingAndUnknown, ...otherKinds], "compact", null)).toBeNull();
    // Old misses fall out of the window once ten newer entries are checked.
    expect(belowTargetOf([...run("compact", 0, 5), ...run("compact", 9, 1, 100)], "compact", null)).toBeNull();
    expect(belowTargetOf([...run("compact", 9, 0), ...run("compact", 0, 3, 100)], "compact", null)).toMatchObject({ met: 7, missed: 3 });
  });

  it("counts only the entries recorded from countsFrom", () => {
    const entries = [...run("compact", 0, 10), ...run("compact", 7, 0, 100)];
    expect(belowTargetOf(entries, "compact", null)).toMatchObject({ met: 7, missed: 3 });
    // From minute 50 on only the seven met ones count: too few to judge, then three fresh misses make ten.
    expect(belowTargetOf(entries, "compact", minute(50))).toBeNull();
    const fresh = [...entries, entry("compact", "missed", 200), entry("compact", "missed", 201), entry("compact", "missed", 202)];
    expect(belowTargetOf(fresh, "compact", minute(50))).toMatchObject({ met: 7, missed: 3, checked: 10 });
  });
});

describe("guardCoordination: below target → switched off with one Inbox alert; the owner turns it on", () => {
  it("switches compaction off, raises one alert for every project with the figures and the way back, and leaves handoff on", () => {
    writeLog([...run("compact", 6, 4), ...run("handoff", 8, 2, 50)]);

    expect(guard()).toEqual(["compact"]);

    expect(settings().compact).toEqual({ ...DEFAULT_COORDINATION_SETTINGS.compact, enabled: false });
    expect(settings().guard.compact).toEqual({ countsFrom: null, switchedOff: { at: NOW.toISOString(), met: 6, checked: 10 } });
    expect(settings().handoff).toEqual(DEFAULT_COORDINATION_SETTINGS.handoff);
    const alerts = openAlerts();
    expect(alerts).toEqual([
      {
        key: COMPACT_OFF_KEY,
        workspaceId: null,
        kind: "coordination-off",
        subject: "compact",
        since: NOW.toISOString(),
        clearedAt: null,
        detail: "Only 6 of its last 10 compactions met their goal (target 8). Compaction stays off until you turn it on in Settings → Coordination.",
      },
    ]);
    expect(logs).toEqual([]);

    // Again: it is off already, so nothing is written and no second alert opens.
    const bytes = readFileSync(join(home, COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE), "utf8");
    expect(guard(new Date(NOW.getTime() + 60_000))).toEqual([]);
    expect(readFileSync(join(home, COORDINATION_DIR_NAME, COORDINATION_SETTINGS_FILE), "utf8")).toBe(bytes);
    expect(createAlertStore(home).list({ kinds: ["coordination-off"] })).toHaveLength(1);
  });

  it("the owner turns it on: the alert ends, the old entries never switch it off again, fresh ones below target do", () => {
    const old = run("compact", 6, 4);
    writeLog(old);
    guard();
    const later = new Date(NOW.getTime() + 60 * 60_000);
    ownerTurnsOn("compact.enabled", later);

    expect(settings().compact.enabled).toBe(true);
    expect(settings().guard.compact).toEqual({ countsFrom: later.toISOString(), switchedOff: null });
    expect(openAlerts()).toEqual([]);
    expect(guard(new Date(later.getTime() + 60_000))).toEqual([]);
    expect(settings().compact.enabled).toBe(true);

    // Ten fresh entries recorded after the owner's switch, 7 met: below target again.
    const fresh = run("compact", 7, 3, (later.getTime() - T0) / 60_000 + 1);
    writeLog([...old, ...fresh]);
    const again = new Date(later.getTime() + 5 * 60 * 60_000);
    expect(guard(again)).toEqual(["compact"]);
    expect(settings().guard.compact).toEqual({ countsFrom: later.toISOString(), switchedOff: { at: again.toISOString(), met: 7, checked: 10 } });
    // Raised afresh: a new alert since then, the old one kept cleared.
    expect(createAlertStore(home).get(COMPACT_OFF_KEY)).toMatchObject({ since: again.toISOString(), clearedAt: null });
  });

  it("switches both off when both are below target, each with its own alert", () => {
    writeLog([...run("compact", 5, 5), ...run("handoff", 3, 7, 50)]);
    expect(guard()).toEqual(["compact", "handoff"]);
    expect([settings().compact.enabled, settings().handoff.enabled]).toEqual([false, false]);
    expect(openAlerts().map((alert) => alert.subject)).toEqual(["compact", "handoff"]);
    expect(openAlerts()[1]!.detail).toBe("Only 3 of its last 10 handoffs met their goal (target 8). Handoff stays off until you turn it on in Settings → Coordination.");
  });

  it("does nothing at the target, with fewer than 10 checked entries, or for a mechanism the owner switched off", () => {
    writeLog([...run("compact", 8, 2), ...run("handoff", 0, 9, 50)]);
    expect(guard()).toEqual([]);
    writeLog(run("compact", 0, 10));
    createCoordinationStore(home).set({ key: "compact.enabled", value: false });
    expect(guard()).toEqual([]);
    expect(settings().guard.compact.switchedOff).toBeNull();
    expect(openAlerts()).toEqual([]);
  });

  it("never throws: an unreadable log is one line and changes nothing", () => {
    mkdirSync(home, { recursive: true });
    symlinkSync(root, join(home, ORCHESTRATOR_DIR_NAME));
    expect(guard()).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not check compaction and handoff against A-12/);
    expect(settings().compact.enabled).toBe(true);
  });

  it("switchedOffDetail gives the figures against the target and the way back", () => {
    expect(switchedOffDetail("compact", { met: 0, checked: 10 })).toBe(
      "Only 0 of its last 10 compactions met their goal (target 8). Compaction stays off until you turn it on in Settings → Coordination.",
    );
  });
});

describe("createCoordinationGuard: after the intervention check, when it settled a compact or handoff entry", () => {
  it("runs on the data folder only when the check settled one of their entries", () => {
    writeLog(run("compact", 6, 4));
    const guarded = createCoordinationGuard({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, log: (line) => logs.push(line) });
    expect(guarded.afterCheck([])).toEqual([]);
    expect(guarded.afterCheck([entry("answer", "met", 5), entry("advice", "missed", 6)])).toEqual([]);
    expect(settings().compact.enabled).toBe(true);
    expect(guarded.afterCheck([entry("compact", "missed", 7)])).toEqual(["compact"]);
    expect(settings().compact.enabled).toBe(false);
    // No usable data folder: nothing, and no throw.
    expect(createCoordinationGuard({ env: { PASEO_BM_HOME: "relative/path" }, homedir: () => root }).afterCheck([entry("compact", "missed", 8)])).toEqual([]);
  });
});

describe("the coordination-off alert in the Inbox", () => {
  it("names the mechanism for all projects, in the warning tone, with its figures on a tap and no action", () => {
    writeLog(run("handoff", 6, 4));
    guard();
    const [alert] = createAlertStore(home).list({ open: true });
    const row = alertRowOf(alert!, { projectOf: () => null, can: { openAgent: true, openWorkspace: true }, now: NOW });
    expect(row).toMatchObject({ tone: "warning", text: "Handoff was switched off: below its target · all projects", action: null });
    expect(row.details[0]).toBe("Only 6 of its last 10 handoffs met their goal (target 8). Handoff stays off until you turn it on in Settings → Coordination.");
    expect(row.details).toContain(`Alert: ${alertKeyOf("coordination-off", null, "handoff")}`);
  });
});
