/**
 * Which view the Beads Manager surface shows, and the hand-off from the
 * Command Center (WP-211.2.1; REQ-040a, REQ-040b).
 *
 * The Dashboard lives on the same surface as the launcher (Q-036), so the
 * surface needs one bit of state and one queue — the same shape
 * `launch-manager.ts` already uses for its own Command Center item, because a
 * workspace Command Center context can open a surface but cannot pass it
 * anything.
 *
 * Pure: no React, no React Native, no JSX.
 */

import type { WorkspaceOverview } from "../shared/contracts";
import type { Tone } from "./dashboard-model";
import { createSlot, type Slot } from "./slot";

/**
 * The views of the Beads Manager surface. Setup is the main screen and the
 * workspace list is one tap away (owner decision Q1, delta 20260918e §4.2).
 */
export type DashboardViewName = "setup" | "workspaces" | "dashboard" | "beads";

/** Where the surface opens. */
export const SURFACE_HOME_VIEW: DashboardViewName = "setup";

/** Where ← leads from a view; `null` on the main screen, which has no ←. */
export function backOf(view: DashboardViewName): DashboardViewName | null {
  switch (view) {
    case "dashboard":
    case "beads":
      return "workspaces";
    case "workspaces":
      return "setup";
    case "setup":
      return null;
  }
}

/**
 * What each ← says to a screen reader: where it leads (delta 20260918f F4,
 * owner decision Q6 a). `null` on the main screen, which has no ←.
 */
export function backLabelOf(view: DashboardViewName): string | null {
  switch (backOf(view)) {
    case "setup":
      return "Back to Beads Manager setup";
    case "workspaces":
      return "Back to workspaces";
    default:
      return null;
  }
}

/** How often the per-workspace figures are refreshed while the workspace list shows. */
export const OVERVIEW_POLL_MS = 10_000;

/**
 * Whether the surface reads the per-workspace figures (`workspaces.overview`,
 * which touches every workspace's bead store) and how often. Only the
 * workspace list shows them (delta 20260918f F5).
 */
export function overviewPolling(view: DashboardViewName): { enabled: boolean; refetchInterval: number | false } {
  return view === "workspaces" ? { enabled: true, refetchInterval: OVERVIEW_POLL_MS } : { enabled: false, refetchInterval: false };
}

/** The workspace whose Dashboard the Command Center asked for; one per loaded client bundle, like `launchRequests`. */
export const dashboardRequests: Slot<string> = createSlot<string>();

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

/** Body of the workspace Command Center item "Open Beads Metric". */
export function selectDashboardFromCommandCenter(
  context: { workspace: { id: string }; openSurface(id: string): void },
  surfaceId: string,
  requests: Slot<string> = dashboardRequests,
): void {
  requests.put(context.workspace.id);
  context.openSurface(surfaceId);
}

/**
 * Title of a workspace's Metric and Beads screens. A workspace is usually named
 * after its first chat ("Build bva terminal UI…"), which does not say which
 * repository the beads come from, so the project is named too.
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

/**
 * Workspaces with trace history that the launcher does not list any more —
 * archived or removed from Paseo — newest activity first. Their history stays
 * on disk, so this is how it is reached again; after the project is reopened
 * (a new workspace id), its Metric screen offers to move the history onto it.
 */
export function closedWorkspaces(
  stored: readonly StoredWorkspace[],
  listedIds: readonly string[],
): Array<{ workspaceId: string; label: string; detail: string }> {
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
    }));
}

/** One figure under a workspace name: a small icon, a number, and what it means. */
export interface WorkspaceStat {
  key: "total" | "inProgress" | "blocked" | "running";
  icon: string;
  value: string;
  label: string;
  tone: Tone;
}

/**
 * The four figures of a workspace row: beads in total, in progress, blocked,
 * and Workers running now. A figure that is zero stays grey so the ones that
 * need attention stand out; a workspace without a bead store says so once.
 * A figure above zero reads at full contrast and none of them carries a hue,
 * like everywhere else a bead shows (delta 20260925 §3.2; errata of REQ-060 n).
 */
export function workspaceStats(overview: WorkspaceOverview | undefined): WorkspaceStat[] {
  if (overview === undefined) return [];
  const running: WorkspaceStat = {
    key: "running",
    icon: "Hammer",
    value: String(overview.runningWorkers),
    label: `${overview.runningWorkers} Worker(s) running`,
    tone: overview.runningWorkers > 0 ? "plain" : "muted",
  };
  const beads = overview.beads;
  if (beads === null) {
    return [{ key: "total", icon: "Layers", value: "–", label: "no beads in this workspace", tone: "muted" }, running];
  }
  return [
    { key: "total", icon: "Layers", value: String(beads.total), label: `${beads.total} beads in total`, tone: "muted" },
    {
      key: "inProgress",
      icon: "CircleDot",
      value: String(beads.inProgress),
      label: `${beads.inProgress} in progress`,
      tone: beads.inProgress > 0 ? "plain" : "muted",
    },
    {
      key: "blocked",
      icon: "Ban",
      value: String(beads.blocked),
      label: `${beads.blocked} blocked`,
      tone: beads.blocked > 0 ? "plain" : "muted",
    },
    running,
  ];
}

/** The three actions of a workspace row, in order, with their icons. */
export const WORKSPACE_ACTIONS = [
  { key: "manager", label: "Go to", icon: "Bot" },
  { key: "metric", label: "Metric", icon: "ChartColumn" },
  { key: "beads", label: "Beads", icon: "ListChecks" },
] as const;

// ---------------------------------------------------------------------------
// The "Beads" tab of a workspace (delta 20260918e §4.1): one entry in the "+"
// menu of the tab bar, with the Beads and Metric screens as two sub-tabs.
// ---------------------------------------------------------------------------

/** Workspace panel id; Paseo lists every workspace panel in the "+" menu. */
export const BEADS_TAB_PANEL_ID = "bm-beads";

/** The two sub-tabs, in the order they are drawn. */
export const BEADS_TAB_VIEWS = [
  { key: "beads", label: "Beads" },
  { key: "metric", label: "Metric" },
] as const;

export type BeadsTabView = (typeof BEADS_TAB_VIEWS)[number]["key"];

/** The sub-tab a new "Beads" tab opens on (owner decision Q2). */
export const DEFAULT_BEADS_TAB_VIEW: BeadsTabView = "beads";
