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

export type DashboardViewName = "launcher" | "dashboard" | "beads" | "settings";

export interface DashboardRequests {
  /** Records that the user asked for the Dashboard of this workspace. */
  request(workspaceId: string): void;
  /** Returns and clears the pending request. */
  take(): string | null;
  /** Reads the pending request without clearing it. */
  peek(): string | null;
  subscribe(listener: () => void): () => void;
}

export function createDashboardRequests(): DashboardRequests {
  let pending: string | null = null;
  const listeners = new Set<() => void>();
  return {
    request(workspaceId) {
      pending = workspaceId;
      for (const listener of listeners) listener();
    },
    take() {
      const value = pending;
      pending = null;
      return value;
    },
    peek: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One queue per loaded client bundle, like `launchRequests`. */
export const dashboardRequests = createDashboardRequests();

export interface NoticeQueue {
  post(text: string): void;
  take(): string | null;
  peek(): string | null;
  subscribe(listener: () => void): () => void;
}

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
 * So a command posts here and opens the Beads Manager surface, which draws the
 * line as an ordinary notice.
 */
export function createNoticeQueue(): NoticeQueue {
  let pending: string | null = null;
  const listeners = new Set<() => void>();
  return {
    post(text) {
      pending = text;
      for (const listener of listeners) listener();
    },
    take() {
      const value = pending;
      pending = null;
      return value;
    },
    peek: () => pending,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One per loaded client bundle, like the queues above. */
export const launcherNotices = createNoticeQueue();

/** Body of the workspace Command Center item "Open Beads Dashboard". */
export function selectDashboardFromCommandCenter(
  context: { workspace: { id: string }; openSurface(id: string): void },
  surfaceId: string,
  requests: DashboardRequests = dashboardRequests,
): void {
  requests.request(context.workspace.id);
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
 */
export function workspaceStats(overview: WorkspaceOverview | undefined): WorkspaceStat[] {
  if (overview === undefined) return [];
  const running: WorkspaceStat = {
    key: "running",
    icon: "Hammer",
    value: String(overview.runningWorkers),
    label: `${overview.runningWorkers} Worker(s) running`,
    tone: overview.runningWorkers > 0 ? "success" : "muted",
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
      tone: beads.inProgress > 0 ? "info" : "muted",
    },
    {
      key: "blocked",
      icon: "Ban",
      value: String(beads.blocked),
      label: `${beads.blocked} blocked`,
      tone: beads.blocked > 0 ? "warning" : "muted",
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
