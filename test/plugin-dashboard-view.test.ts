import { describe, expect, it, vi } from "vitest";
import {
  createDashboardRequests,
  dashboardRequests,
  screenTitleOf,
  WORKSPACE_ACTIONS,
  workspaceStats,
  selectDashboardFromCommandCenter,
} from "../plugin/client/dashboard-view";

/**
 * WP-211.2.1: the Command Center hand-off for the Dashboard.
 *
 * A workspace Command Center context can open a surface but cannot pass it
 * anything, so the workspace is queued here and the surface takes it — the same
 * shape `launchRequests` uses for the Manager.
 */

describe("dashboard requests", () => {
  it("queues a workspace, hands it over once, and notifies subscribers", () => {
    const requests = createDashboardRequests();
    const seen: string[] = [];
    const unsubscribe = requests.subscribe(() => seen.push(requests.peek() ?? "none"));

    expect(requests.take()).toBeNull();
    requests.request("ws-1");
    expect(requests.peek()).toBe("ws-1");
    expect(requests.take()).toBe("ws-1");
    expect(requests.take()).toBeNull();
    expect(seen).toEqual(["ws-1"]);
    unsubscribe();
  });

  it("keeps only the latest request", () => {
    const requests = createDashboardRequests();
    requests.request("ws-1");
    requests.request("ws-2");
    expect(requests.take()).toBe("ws-2");
  });

  it("stops notifying after unsubscribe", () => {
    const requests = createDashboardRequests();
    const listener = vi.fn();
    requests.subscribe(listener)();
    requests.request("ws-1");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the Command Center item", () => {
  it("queues the workspace and opens the launcher surface", () => {
    const requests = createDashboardRequests();
    const openSurface = vi.fn();
    selectDashboardFromCommandCenter({ workspace: { id: "ws-cc" }, openSurface }, "beads-manager", requests);
    expect(requests.take()).toBe("ws-cc");
    expect(openSurface).toHaveBeenCalledWith("beads-manager");
  });

  it("uses the shared queue by default, so the surface sees it", () => {
    const openSurface = vi.fn();
    selectDashboardFromCommandCenter({ workspace: { id: "ws-shared" }, openSurface }, "beads-manager");
    expect(dashboardRequests.take()).toBe("ws-shared");
  });
});

describe("screen title", () => {
  it("names the project next to a workspace named after its first chat", () => {
    expect(screenTitleOf("Build bva terminal UI", "bead_view_advance")).toBe("Build bva terminal UI · bead_view_advance");
    expect(screenTitleOf("bm-demo-dashboard", "bm-demo-dashboard")).toBe("bm-demo-dashboard");
    expect(screenTitleOf("repo", "")).toBe("repo");
  });
});

describe("workspace row figures", () => {
  it("shows total, in progress, blocked and running Workers, greying the zeros", () => {
    const stats = workspaceStats({
      workspaceId: "wks_1",
      beads: { total: 141, inProgress: 2, blocked: 0, ready: 5 },
      runningWorkers: 1,
    });
    expect(stats.map((stat) => [stat.key, stat.icon, stat.value, stat.tone])).toEqual([
      ["total", "Layers", "141", "muted"],
      ["inProgress", "CircleDot", "2", "info"],
      ["blocked", "Ban", "0", "muted"],
      ["running", "Hammer", "1", "success"],
    ]);
    expect(stats.map((stat) => stat.label).join(", ")).toBe("141 beads in total, 2 in progress, 0 blocked, 1 Worker(s) running");
  });

  it("says once that a workspace has no beads, and shows nothing before the figures load", () => {
    expect(workspaceStats({ workspaceId: "wks_1", beads: null, runningWorkers: 0 }).map((stat) => stat.label)).toEqual([
      "no beads in this workspace",
      "0 Worker(s) running",
    ]);
    expect(workspaceStats(undefined)).toEqual([]);
  });

  it("keeps the three actions in order, each with an icon", () => {
    expect(WORKSPACE_ACTIONS.map((action) => [action.label, action.icon])).toEqual([
      ["Go to", "Bot"],
      ["Metric", "ChartColumn"],
      ["Beads", "ListChecks"],
    ]);
  });
});
