import { describe, expect, it, vi } from "vitest";
import {
  BEADS_TAB_INITIAL,
  BEADS_TAB_PANEL_ID,
  OVERVIEW_POLL_MS,
  SURFACE_HOME_VIEW,
  SURFACE_SECTIONS,
  backLabelOf,
  backOf,
  overviewPolling,
  projectRequests,
  projectTabOf,
  sectionHomeOf,
  sectionOf,
  sectionRequests,
  selectProjectFromCommandCenter,
  selectSectionFromCommandCenter,
  type SurfaceSection,
  screenTitleOf,
} from "../plugin/client/surface-view";
import { createSlot } from "../plugin/client/slot";

/**
 * The views of the Beads Manager surface and its hand-offs (autonomy design
 * §A.12; WP-211.2.1).
 *
 * A workspace Command Center context can open a surface but cannot pass it
 * anything, so the workspace is queued here and the surface takes it — the same
 * shape `launchRequests` uses for the Manager.
 */

describe("project requests", () => {
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

describe("the Command Center item Open Beads project", () => {
  it("queues the workspace and opens the launcher surface", () => {
    const requests = createSlot<string>();
    const openSurface = vi.fn();
    selectProjectFromCommandCenter({ workspace: { id: "ws-cc" }, openSurface }, "beads-manager", requests);
    expect(requests.take()).toBe("ws-cc");
    expect(openSurface).toHaveBeenCalledWith("beads-manager");
  });

  it("uses the shared queue by default, so the surface sees it", () => {
    const openSurface = vi.fn();
    selectProjectFromCommandCenter({ workspace: { id: "ws-shared" }, openSurface }, "beads-manager");
    expect(projectRequests.take()).toBe("ws-shared");
  });
});

describe("screen title", () => {
  it("names the project next to a workspace named after its first chat", () => {
    expect(screenTitleOf("Build bva terminal UI", "bead_view_advance")).toBe("Build bva terminal UI · bead_view_advance");
    expect(screenTitleOf("bm-demo-dashboard", "bm-demo-dashboard")).toBe("bm-demo-dashboard");
    expect(screenTitleOf("repo", "")).toBe("repo");
  });
});

describe("the Beads tab of a workspace (delta 20260918e; autonomy design §A.12)", () => {
  it("is the workspace's project page, opened on Beads", () => {
    expect(BEADS_TAB_PANEL_ID).toBe("bm-beads");
    expect(BEADS_TAB_INITIAL).toBe("beads");
  });
});

describe("the Beads Manager surface opens on the Inbox (autonomy design §A.12; change-014 outcome 5)", () => {
  it("opens on the Inbox; a section's own screen has no ←, a project's page leads back to the Projects list", () => {
    expect(SURFACE_HOME_VIEW).toBe("inbox");
    for (const view of ["inbox", "projects", "settings", "tools"] as const) expect(backOf(view), view).toBeNull();
    for (const view of ["project-overview", "project-requests", "project-beads"] as const) expect(backOf(view), view).toBe("projects");
  });

  it("opens a project's page on the tab its view names", () => {
    expect(projectTabOf("project-overview")).toBe("overview");
    expect(projectTabOf("project-requests")).toBe("requests");
    expect(projectTabOf("project-beads")).toBe("beads");
    for (const view of ["inbox", "projects", "settings", "tools"] as const) expect(projectTabOf(view), view).toBeNull();
  });

  it("labels each ← with where it leads (delta 20260918f F4, owner decision Q6 a)", () => {
    expect(backLabelOf("inbox")).toBeNull();
    expect(backLabelOf("projects")).toBeNull();
    expect(backLabelOf("project-overview")).toBe("Back to Projects");
    expect(backLabelOf("project-requests")).toBe("Back to Projects");
    expect(backLabelOf("project-beads")).toBe("Back to Projects");
  });

  it("has four sections — Inbox, Projects, Settings, Tools & skills —, always in that order, each opening on its own view; Insights is none", () => {
    expect(SURFACE_SECTIONS.map((section) => [section.key, section.label, section.home])).toEqual([
      ["inbox", "Inbox", "inbox"],
      ["projects", "Projects", "projects"],
      ["settings", "Settings", "settings"],
      ["tools", "Tools & skills", "tools"],
    ]);
    for (const section of SURFACE_SECTIONS) {
      expect(sectionHomeOf(section.key)).toBe(section.home);
      expect(sectionOf(section.home)).toBe(section.key);
    }
    // A project's page belongs to Projects.
    for (const view of ["project-overview", "project-requests", "project-beads"] as const) expect(sectionOf(view), view).toBe("projects");
    expect(SURFACE_SECTIONS.map((section) => section.label)).not.toContain("Insights");
  });

  it("opens a section from the Command Center through a one-shot slot", () => {
    const requests = createSlot<SurfaceSection>();
    const openSurface = vi.fn();
    selectSectionFromCommandCenter({ openSurface }, "beads-manager", "inbox", requests);
    expect(openSurface).toHaveBeenCalledWith("beads-manager");
    expect(requests.take()).toBe("inbox");
    expect(requests.take()).toBeNull();
    selectSectionFromCommandCenter({ openSurface }, "beads-manager", "inbox");
    expect(sectionRequests.take()).toBe("inbox");
  });

  it("polls the workspace figures only while the Projects list shows (delta 20260918f F5)", () => {
    expect(OVERVIEW_POLL_MS).toBe(10_000);
    expect(overviewPolling("projects")).toEqual({ enabled: true, refetchInterval: OVERVIEW_POLL_MS });
    for (const view of ["inbox", "settings", "tools", "project-overview", "project-requests", "project-beads"] as const) {
      expect(overviewPolling(view), view).toEqual({ enabled: false, refetchInterval: false });
    }
  });
});
