import { afterEach, describe, expect, it, vi } from "vitest";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { currentInstructionsHash } from "../plugin/server/instructions-label";
import { clearHandedOverMains, isIdleOutdatedMain, replaceOutdatedMains, upgradeHandoffLineOf } from "../plugin/server/main-upgrade";
import { createMissionStore } from "../plugin/server/mission-store";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";

/** Outdated Mains handed over while idle (delivery line design §19.12; owner, 2026-10-25). */

const NOW = new Date("2026-10-25T07:00:00.000Z");
const OLD = { "bm.instructions": "000000000000" };

afterEach(() => {
  clearHandedOverMains();
  clearJsonFileCache();
  removeDataFolders();
});

describe("an outdated Main", () => {
  it("is idle, live, unreplaced and on another hash than this build's", () => {
    const current = { "bm.instructions": currentInstructionsHash("manager") };
    expect(isIdleOutdatedMain({ status: "idle", labels: OLD }, NOW)).toBe(true);
    expect(isIdleOutdatedMain({ status: "running", labels: OLD }, NOW)).toBe(false);
    expect(isIdleOutdatedMain({ status: "initializing", labels: OLD }, NOW)).toBe(false);
    expect(isIdleOutdatedMain({ status: "idle", labels: current }, NOW)).toBe(false);
    expect(isIdleOutdatedMain({ status: "idle", labels: { ...OLD, "bm.replacedBy": "m2" } }, NOW)).toBe(false);
    expect(isIdleOutdatedMain({ status: "idle", archivedAt: NOW.toISOString(), labels: OLD }, NOW)).toBe(false);
    expect(isIdleOutdatedMain({ status: "closed", labels: OLD }, NOW)).toBe(false);
    // No label yet: outdated only past the stamp grace.
    expect(isIdleOutdatedMain({ status: "idle", labels: {}, createdAt: new Date(NOW.getTime() - 60_000).toISOString() }, NOW)).toBe(false);
    expect(isIdleOutdatedMain({ status: "idle", labels: {}, createdAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }, NOW)).toBe(true);
    expect(isIdleOutdatedMain(null, NOW)).toBe(false);
  });

  it("is handed over once while idle, never while running, with the notice for the successor", async () => {
    const home = dataFolder();
    const made = createMissionStore(home, { now: () => NOW }).create({ code: "AIX", name: "Forms", goal: "g", repos: [], createdBy: "owner", mainId: "main-old" });
    if (!made.ok) throw new Error(made.reasons.join("\n"));
    let status = "running";
    const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { status, labels: OLD } }) }) } };
    const handOver = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "main-new");
    const log = vi.fn();
    await replaceOutdatedMains(home, paseo, { home, handOver, log, now: () => NOW });
    expect(handOver).not.toHaveBeenCalled();
    status = "idle";
    await replaceOutdatedMains(home, paseo, { home, handOver, log, now: () => NOW });
    expect(handOver).toHaveBeenCalledTimes(1);
    expect(handOver.mock.calls[0]![2]).toBe(upgradeHandoffLineOf("main-old"));
    expect(upgradeHandoffLineOf("main-old")).toContain("it ran the instructions of an older paseo-bm");
    expect(log).toHaveBeenCalledWith("[paseo-bm] Main main-old of mission AIX ran older instructions; it was handed over to main-new while idle.");
    await replaceOutdatedMains(home, paseo, { home, handOver, log, now: () => NOW });
    expect(handOver).toHaveBeenCalledTimes(1);
  });
});
