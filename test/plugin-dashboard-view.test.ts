import { describe, expect, it, vi } from "vitest";
import {
  BEADS_TAB_PANEL_ID,
  BEADS_TAB_VIEWS,
  DEFAULT_BEADS_TAB_VIEW,
  OVERVIEW_POLL_MS,
  SURFACE_HOME_VIEW,
  backLabelOf,
  backOf,
  dashboardRequests,
  overviewPolling,
  screenTitleOf,
  WORKSPACE_ACTIONS,
  workspaceStats,
  selectDashboardFromCommandCenter,
} from "../plugin/client/dashboard-view";
import { STATUS_TONE } from "../plugin/client/beads-model";
import { createSlot } from "../plugin/client/slot";

/**
 * WP-211.2.1: the Command Center hand-off for the Dashboard.
 *
 * A workspace Command Center context can open a surface but cannot pass it
 * anything, so the workspace is queued here and the surface takes it — the same
 * shape `launchRequests` uses for the Manager.
 */

describe("dashboard requests", () => {
  it("queues a workspace, hands it over once, and notifies subscribers", () => {
    const requests = createSlot<string>();
    const seen: string[] = [];
    const unsubscribe = requests.subscribe(() => seen.push(requests.peek() ?? "none"));

    expect(requests.take()).toBeNull();
    requests.put("ws-1");
    expect(requests.peek()).toBe("ws-1");
    expect(requests.take()).toBe("ws-1");
    expect(requests.take()).toBeNull();
    // Told on the put, and again when the take cleared it (delta 20260918f §4.1).
    expect(seen).toEqual(["ws-1", "none"]);
    unsubscribe();
  });

  it("keeps only the latest request", () => {
    const requests = createSlot<string>();
    requests.put("ws-1");
    requests.put("ws-2");
    expect(requests.take()).toBe("ws-2");
  });

  it("stops notifying after unsubscribe", () => {
    const requests = createSlot<string>();
    const listener = vi.fn();
    requests.subscribe(listener)();
    requests.put("ws-1");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("slash-command notices", () => {
  // Tapping a notice calls `take()`; the surface reads the notice through
  // `useSyncExternalStore`, so it only hides when `take()` tells its readers
  // (delta 20260918f F1).
  it("tells its readers when a take clears a notice, exactly once", () => {
    const notices = createSlot<string>();
    const listener = vi.fn();
    notices.subscribe(listener);
    notices.put("Asked 1 Worker to stop");
    listener.mockClear();

    expect(notices.take()).toBe("Asked 1 Worker to stop");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(notices.peek()).toBeNull();
  });

  it("stays silent when there is nothing to take", () => {
    const notices = createSlot<string>();
    const listener = vi.fn();
    notices.subscribe(listener);
    expect(notices.take()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not loop when a reader takes again while being told", () => {
    const notices = createSlot<string>();
    let calls = 0;
    notices.subscribe(() => {
      calls += 1;
      notices.take();
    });
    notices.put("hello");
    // `put` told the reader, which took the notice and was told once more.
    expect(calls).toBe(2);
    expect(notices.peek()).toBeNull();
  });
});

describe("the Command Center item", () => {
  it("queues the workspace and opens the launcher surface", () => {
    const requests = createSlot<string>();
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
      runningAgents: { manager: 0, worker: 1, reviewer: 0 },
    });
    expect(stats.map((stat) => [stat.key, stat.icon, stat.value, stat.tone])).toEqual([
      ["total", "Layers", "141", "muted"],
      ["inProgress", "CircleDot", "2", "warning"],
      ["blocked", "Ban", "0", "muted"],
      ["running", "Hammer", "1", "success"],
    ]);
    expect(stats.map((stat) => stat.label).join(", ")).toBe("141 beads in total, 2 in progress, 0 blocked, 1 Worker(s) running");
  });

  it("colours in progress and blocked like the bead statuses (delta 20260918e, REQ-060 n)", () => {
    const tones = Object.fromEntries(
      workspaceStats({
        workspaceId: "wks_1",
        beads: { total: 9, inProgress: 1, blocked: 3, ready: 2 },
        runningWorkers: 0,
        runningAgents: { manager: 0, worker: 0, reviewer: 0 },
      }).map((stat) => [stat.key, stat.tone]),
    );
    expect(tones).toEqual({ total: "muted", inProgress: "warning", blocked: "danger", running: "muted" });
    expect([tones.inProgress, tones.blocked]).toEqual([STATUS_TONE.in_progress, STATUS_TONE.blocked]);
  });

  it("says once that a workspace has no beads, and shows nothing before the figures load", () => {
    expect(workspaceStats({ workspaceId: "wks_1", beads: null, runningWorkers: 0, runningAgents: { manager: 0, worker: 0, reviewer: 0 } }).map((stat) => stat.label)).toEqual([
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

describe("the Beads tab of a workspace (delta 20260918e)", () => {
  it("has the Beads and Metric sub-tabs, in that order, and opens on Beads", () => {
    expect(BEADS_TAB_PANEL_ID).toBe("bm-beads");
    expect(BEADS_TAB_VIEWS.map((view) => [view.key, view.label])).toEqual([
      ["beads", "Beads"],
      ["metric", "Metric"],
    ]);
    expect(DEFAULT_BEADS_TAB_VIEW).toBe("beads");
  });
});

describe("the Beads Manager surface opens on Setup (delta 20260918e)", () => {
  it("opens on Setup and leads back to it from the workspace list", () => {
    expect(SURFACE_HOME_VIEW).toBe("setup");
    expect(backOf("setup")).toBeNull();
    expect(backOf("workspaces")).toBe("setup");
    expect(backOf("dashboard")).toBe("workspaces");
    expect(backOf("beads")).toBe("workspaces");
  });

  it("labels each ← with where it leads (delta 20260918f F4, owner decision Q6 a)", () => {
    expect(backLabelOf("setup")).toBeNull();
    expect(backLabelOf("workspaces")).toBe("Back to Beads Manager setup");
    expect(backLabelOf("dashboard")).toBe("Back to workspaces");
    expect(backLabelOf("beads")).toBe("Back to workspaces");
  });

  it("polls the workspace figures only while the workspace list shows (delta 20260918f F5)", () => {
    expect(OVERVIEW_POLL_MS).toBe(10_000);
    expect(overviewPolling("workspaces")).toEqual({ enabled: true, refetchInterval: OVERVIEW_POLL_MS });
    for (const view of ["setup", "dashboard", "beads"] as const) {
      expect(overviewPolling(view), view).toEqual({ enabled: false, refetchInterval: false });
    }
  });
});
