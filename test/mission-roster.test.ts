import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ROSTER_TOPIC, clearRequestIndexCache, createMissionRoster, noteRosterReport, requestIndex, requestIndexOf } from "../plugin/server/mission-roster";
import { MISSIONS_DIR_NAME } from "../plugin/server/mission-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/**
 * The mission roster and the request index (missions design §2.3).
 * Temporary data folders only.
 */

const M1 = "mis-0000000001";
const M2 = "mis-0000000002";
const REQ_1 = "req-20261009T100000Z";
const REQ_2 = "req-20261009T100001Z";
const T0 = new Date("2026-10-09T10:00:00.000Z");

afterEach(() => {
  clearJsonFileCache();
  clearRequestIndexCache();
  removeDataFolders();
});

function roster(home: string) {
  return createMissionRoster(home, { now: () => T0, env: { PASEO_PASSWORD: "hunter2-secret" } });
}

describe("the roster (§2.3)", () => {
  it("adds a request with its repo, then appends Workers newest last", () => {
    const home = dataFolder();
    const r = roster(home);
    expect(r.list(M1)).toEqual([]);
    const added = r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "Export\nendpoint hunter2-secret", workerId: "wrk-1" });
    expect(added).toEqual({ requestId: REQ_1, workspaceId: "wks_a", createdAt: T0.toISOString(), workerIds: ["wrk-1"], topic: "Export endpoint [redacted]", state: "active" });
    expect(r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "ignored", workerId: "wrk-2" })?.workerIds).toEqual(["wrk-1", "wrk-2"]);
    expect(r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "ignored", workerId: "wrk-2" })?.workerIds).toEqual(["wrk-1", "wrk-2"]);
    const path = join(home, MISSIONS_DIR_NAME, `${M1}.roster.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe(1);
  });

  it("bounds the topic and refuses another shape of id, another repo and another mission's request", () => {
    const home = dataFolder();
    const r = roster(home);
    expect(r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "t".repeat(500) })?.topic).toHaveLength(MAX_ROSTER_TOPIC);
    expect(r.add(M1, { requestId: "req-1", workspaceId: "wks_a", topic: "x" })).toBeNull();
    expect(r.add(M1, { requestId: REQ_1, workspaceId: "wks_b", topic: "x", workerId: "wrk-9" })).toBeNull();
    expect(r.add(M2, { requestId: REQ_1, workspaceId: "wks_a", topic: "x" })).toBeNull();
    expect(r.list(M2)).toEqual([]);
  });

  it("sets a request's state", () => {
    const home = dataFolder();
    const r = roster(home);
    r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "x" });
    expect(r.setState(M1, REQ_1, "finished")).toBe(true);
    expect(r.get(M1, REQ_1)?.state).toBe("finished");
    expect(r.setState(M1, REQ_2, "stopped")).toBe(false);
  });

  it("noteRosterReport: finished and stopped as reported, any other phase active again; a request of no mission untouched", () => {
    const home = dataFolder();
    roster(home).add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "Export" });
    const state = () => roster(home).get(M1, REQ_1)?.state;
    noteRosterReport(home, REQ_1, "finished");
    expect(state()).toBe("finished");
    noteRosterReport(home, REQ_1, "received");
    expect(state()).toBe("active");
    noteRosterReport(home, REQ_1, "stopped");
    expect(state()).toBe("stopped");
    noteRosterReport(home, REQ_1, "beads-done");
    expect(state()).toBe("active");
    const logs: string[] = [];
    noteRosterReport(home, REQ_2, "finished", (line) => logs.push(line));
    expect(roster(home).list(M1).map((entry) => entry.requestId)).toEqual([REQ_1]);
    expect(logs).toEqual([]);
  });

  it("never overwrites a roster that cannot be used", () => {
    const home = dataFolder();
    const r = roster(home);
    r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "x" });
    const path = join(home, MISSIONS_DIR_NAME, `${M1}.roster.json`);
    writeFileSync(path, "{ broken");
    expect(r.list(M1)).toEqual([]);
    expect(() => r.add(M1, { requestId: REQ_2, workspaceId: "wks_a", topic: "y" })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{ broken");
  });
});

describe("the request index (§2.3)", () => {
  it("finds every request's mission and repo across rosters", () => {
    const home = dataFolder();
    expect(requestIndexOf(home, REQ_1)).toBeNull();
    const r = roster(home);
    r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "x" });
    r.add(M2, { requestId: REQ_2, workspaceId: "wks_b", topic: "y" });
    expect(requestIndexOf(home, REQ_1)).toEqual({ missionId: M1, workspaceId: "wks_a" });
    expect(requestIndexOf(home, REQ_2)).toEqual({ missionId: M2, workspaceId: "wks_b" });
    expect([...requestIndex(home).keys()].sort()).toEqual([REQ_1, REQ_2]);
  });

  it("is kept while no roster changes and rebuilt when one does", () => {
    const home = dataFolder();
    const r = roster(home);
    r.add(M1, { requestId: REQ_1, workspaceId: "wks_a", topic: "x" });
    const first = requestIndex(home);
    expect(requestIndex(home)).toBe(first);

    // Changed behind the store's back: a new mtime, so a fresh build.
    const path = join(home, MISSIONS_DIR_NAME, `${M1}.roster.json`);
    const body = JSON.parse(readFileSync(path, "utf8")) as { requests: Array<Record<string, unknown>> };
    writeFileSync(path, JSON.stringify({ ...body, requests: [{ ...body.requests[0], workspaceId: "wks_moved" }] }));
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    expect(requestIndex(home)).not.toBe(first);
    expect(requestIndexOf(home, REQ_1)?.workspaceId).toBe("wks_moved");
  });
});
