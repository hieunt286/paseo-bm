/**
 * Which view the Beads Manager surface shows, and the hand-offs that open it
 * on a section or a project (autonomy design §A.12; REQ-040a, REQ-040b).
 *
 * A surface takes no parameter, and a Command Center context can open a
 * surface but cannot pass it anything, so the surface keeps its view as state
 * and every hand-off is a one-shot slot (`slot.ts`) — the same shape
 * `launch-manager.ts` uses for its own Command Center item.
 *
 * Pure: no React, no React Native, no JSX.
 */

import type { ProjectTab } from "./work-model";
import { createSlot, type Slot } from "./slot";

/**
 * The views of the Beads Manager surface (autonomy design §A.12, change-014
 * outcome 5): the Inbox is the home; `projects` is the list of projects, and
 * `project-overview`, `project-requests` and `project-beads` a project's page
 * opened on that tab (`work.tsx`); `settings` and `tools` are those sections.
 * Insights is no section any more: its figures are a project's Metrics tab.
 */
export type SurfaceView = "inbox" | "projects" | "project-overview" | "project-requests" | "project-beads" | "settings" | "tools";

/** Where the surface opens: the Inbox (experience concept §3). */
export const SURFACE_HOME_VIEW: SurfaceView = "inbox";

/** The four sections, always in this order, with the view each one opens on. */
export const SURFACE_SECTIONS = [
  { key: "inbox", label: "Inbox", home: "inbox" },
  { key: "projects", label: "Projects", home: "projects" },
  { key: "settings", label: "Settings", home: "settings" },
  { key: "tools", label: "Tools & skills", home: "tools" },
] as const satisfies ReadonlyArray<{ key: string; label: string; home: SurfaceView }>;

export type SurfaceSection = (typeof SURFACE_SECTIONS)[number]["key"];

/** The section a view belongs to: the one its tab shows as selected. */
export function sectionOf(view: SurfaceView): SurfaceSection {
  switch (view) {
    case "inbox":
      return "inbox";
    case "projects":
    case "project-overview":
    case "project-requests":
    case "project-beads":
      return "projects";
    case "settings":
      return "settings";
    case "tools":
      return "tools";
  }
}

/** The view a section's tab opens. */
export function sectionHomeOf(section: SurfaceSection): SurfaceView {
  return SURFACE_SECTIONS.find((entry) => entry.key === section)!.home;
}

/** The project page's tab a view opens on; null for a view that is not a project's page. */
export function projectTabOf(view: SurfaceView): ProjectTab | null {
  switch (view) {
    case "project-overview":
      return "overview";
    case "project-requests":
      return "requests";
    case "project-beads":
      return "beads";
    default:
      return null;
  }
}

/** Where ← leads from a view; `null` on a section's own screen, which the tabs reach. */
export function backOf(view: SurfaceView): SurfaceView | null {
  return projectTabOf(view) === null ? null : "projects";
}

/**
 * What each ← says to a screen reader: where it leads (delta 20260918f F4,
 * owner decision Q6 a). `null` where there is no ←.
 */
export function backLabelOf(view: SurfaceView): string | null {
  return backOf(view) === "projects" ? "Back to Projects" : null;
}

/** The section a Command Center item asked for; one per loaded client bundle, like `projectRequests`. */
export const sectionRequests: Slot<SurfaceSection> = createSlot<SurfaceSection>();

/** Body of a Command Center item that opens the surface on one section (the Inbox). */
export function selectSectionFromCommandCenter(
  context: { openSurface(id: string): void },
  surfaceId: string,
  section: SurfaceSection,
  requests: Slot<SurfaceSection> = sectionRequests,
): void {
  requests.put(section);
  context.openSurface(surfaceId);
}

/** How often the per-workspace figures are refreshed while the Projects list shows. */
export const OVERVIEW_POLL_MS = 10_000;

/**
 * Whether the surface reads the per-workspace figures (`workspaces.overview`,
 * which touches every workspace's bead store) and how often. Only the Projects
 * list shows them (delta 20260918f F5).
 */
export function overviewPolling(view: SurfaceView): { enabled: boolean; refetchInterval: number | false } {
  return view === "projects" ? { enabled: true, refetchInterval: OVERVIEW_POLL_MS } : { enabled: false, refetchInterval: false };
}

/** The workspace whose project page a Command Center item asked for; one per loaded client bundle, like `launchRequests`. */
export const projectRequests: Slot<string> = createSlot<string>();

/**
 * How a slash command says something back to the user.
 *
 * Paseo 0.8 gives a plugin slash command NO report channel: its context carries
 * only `paseo`, `rpc`, `openSurface`, `openSettings` and `openPanel`, and the
 * composer shows nothing unless `onSubmit` REJECTS — in which case the message
 * lands in an error toast. Reporting a success by throwing would paint
 * "Asked 2 Workers to stop" in the colour of a failure, which is a lie about
 * what happened.
 *
 * So a command puts its line here and opens the Beads Manager surface, which
 * draws it as an ordinary notice; tapping it takes it, which hides it.
 */
export const launcherNotices: Slot<string> = createSlot<string>();

/** Body of the workspace Command Center item "Open Beads project": the surface opens on this workspace's project page. */
export function selectProjectFromCommandCenter(
  context: { workspace: { id: string }; openSurface(id: string): void },
  surfaceId: string,
  requests: Slot<string> = projectRequests,
): void {
  requests.put(context.workspace.id);
  context.openSurface(surfaceId);
}

/**
 * Title of a project's page. A workspace is usually named after its first
 * chat ("Build bva terminal UI…"), which does not say which repository the
 * beads come from, so the project is named too.
 */
export function screenTitleOf(label: string, project: string): string {
  return project === "" || project === label ? label : `${label} · ${project}`;
}

export interface StoredWorkspace {
  workspaceId: string;
  state: "live" | "archived" | "orphaned" | "unknown";
  lastKnownName: string | null;
  lastKnownDirectory: string | null;
  lastSeenAt: string | null;
  bytes: number;
}

/** A workspace Paseo no longer lists that still has request history. */
export interface ClosedWorkspace {
  workspaceId: string;
  label: string;
  detail: string;
  /** `orphaned`: removed from Paseo, so its history can be moved onto a workspace that exists. */
  state: StoredWorkspace["state"];
}

/**
 * Workspaces with trace history that Projects does not list any more — archived
 * or removed from Paseo — newest activity first. Their history stays on disk,
 * so this is how it is reached again; the project page of a closed workspace
 * offers to delete it, or, once the project is reopened (a new workspace id),
 * to move it onto the new workspace.
 */
export function closedWorkspaces(stored: readonly StoredWorkspace[], listedIds: readonly string[]): ClosedWorkspace[] {
  const listed = new Set(listedIds);
  return stored
    .filter((entry) => !listed.has(entry.workspaceId) && entry.state !== "unknown")
    .sort((a, b) => ((a.lastSeenAt ?? "") < (b.lastSeenAt ?? "") ? 1 : -1))
    .map((entry) => ({
      workspaceId: entry.workspaceId,
      label: entry.lastKnownName ?? entry.workspaceId,
      detail: [
        entry.state === "archived" ? "archived" : "no longer in Paseo",
        entry.lastKnownDirectory,
        entry.lastSeenAt === null ? null : `last active ${entry.lastSeenAt.slice(0, 10)}`,
        `${Math.max(1, Math.round(entry.bytes / 1024))} KB of history`,
      ]
        .filter((part) => part !== null)
        .join(" · "),
      state: entry.state,
    }));
}

/**
 * The workspace a project page shows, and whether Paseo still lists it: a
 * closed one (archived or removed) has history only, which its Requests tab
 * offers to delete or move (autonomy design §A.12, as built).
 */
export interface SurfaceWorkspace {
  id: string;
  label: string;
  /** Set for a workspace Paseo no longer lists. */
  closed?: StoredWorkspace["state"];
}

// ---------------------------------------------------------------------------
// The "Beads" tab of a workspace (delta 20260918e §4.1): one entry in the "+"
// menu of the tab bar. It shows the workspace's project page (Projects), opened on
// its Beads, since a workspace panel cannot open the surface.
// ---------------------------------------------------------------------------

/** Workspace panel id; Paseo lists every workspace panel in the "+" menu. */
export const BEADS_TAB_PANEL_ID = "bm-beads";

/** The project page's tab a new "Beads" tab opens on (owner decision Q2). */
export const BEADS_TAB_INITIAL: ProjectTab = "beads";
