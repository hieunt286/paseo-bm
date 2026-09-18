/**
 * Launch logic behind the "Open Beads Manager" entry points (WP-113, design
 * §2.2, §5, §9.3). Pure and injectable: no React, no React Native, no JSX, so
 * it is testable without a renderer. `launcher.tsx` renders from it.
 *
 * The client never finds or creates a Manager itself: it calls `manager.ensure`
 * for one workspace and opens the returned `agentId`. De-duplication (one
 * Manager per workspace, REQ-020b) is the server's job.
 *
 * Paseo 0.8 facts this is built on (checked against @getpaseo/plugin 0.8.0
 * `dist/client/contracts.d.ts`, not guessed):
 * - A sidebar item can only point at a surface, and a surface receives no
 *   workspace id. It does receive the optional `navigation.openAgent`.
 * - A workspace Command Center item receives the `workspace` snapshot, `rpc`
 *   and `openSurface(id)`, but no way to open an agent.
 * So the Command Center item queues its workspace with `selectFromCommandCenter`
 * and opens the surface, which runs the launch; opened from the sidebar the
 * surface lets the user pick the workspace.
 */
import type { PluginTheme } from "@getpaseo/plugin";

/** Surface id shared by the sidebar item and the Command Center item. */
export const LAUNCHER_SURFACE_ID = "beads-manager";

/** Lucide icon name (lucide.dev/icons/bot). */
export const LAUNCHER_ICON = "Bot";

// ---------------------------------------------------------------------------
// Launch controller.
// ---------------------------------------------------------------------------

export interface EnsureManagerOutput {
  agentId: string;
  created: boolean;
  otherManagerIds: string[];
  /** Why an existing Manager was not switched to its mode (delta 20260918 §4.1); absent from an older server. */
  modeNotice?: string | null;
}

export interface LaunchDeps {
  /** Calls the `manager.ensure` RPC. */
  ensure: (input: { workspaceId: string }) => Promise<EnsureManagerOutput>;
  /** Opens an agent in the Paseo client. */
  openAgent: (input: { agentId: string }) => void;
}

export type LauncherState =
  | { status: "idle" }
  | { status: "pending"; workspaceId: string }
  | {
      status: "opened";
      workspaceId: string;
      agentId: string;
      created: boolean;
      otherManagerIds: string[];
      modeNotice: string | null;
    }
  | { status: "error"; workspaceId: string; code: string | null; message: string };

export type LaunchOutcome = "opened" | "error" | "busy";

export interface ManagerLauncher {
  getState(): LauncherState;
  subscribe(listener: () => void): () => void;
  /**
   * Ensures and opens the Manager of `workspaceId`. While a launch is pending
   * every further call returns "busy" without calling the RPC again.
   */
  launch(workspaceId: string, deps: LaunchDeps): Promise<LaunchOutcome>;
}

const ERROR_CODE_PATTERN = /^\s*(E_[A-Z0-9_]+)\b/;

/**
 * Registry code at the start of an RPC error message (`E_PROVIDER_UNAVAILABLE: ...`),
 * or null when the server sent none.
 */
export function errorCodeOf(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return ERROR_CODE_PATTERN.exec(message)?.[1] ?? null;
}

export function errorMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || "Unknown error";
}

export function createManagerLauncher(): ManagerLauncher {
  let state: LauncherState = { status: "idle" };
  const listeners = new Set<() => void>();

  const set = (next: LauncherState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async launch(workspaceId, deps) {
      if (state.status === "pending") return "busy";
      set({ status: "pending", workspaceId });
      try {
        const result = await deps.ensure({ workspaceId });
        deps.openAgent({ agentId: result.agentId });
        set({
          status: "opened",
          workspaceId,
          agentId: result.agentId,
          created: result.created,
          otherManagerIds: [...result.otherManagerIds],
          modeNotice: result.modeNotice ?? null,
        });
        return "opened";
      } catch (error) {
        set({
          status: "error",
          workspaceId,
          code: errorCodeOf(error),
          message: errorMessageOf(error),
        });
        return "error";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Hand-off from the Command Center item to the surface.
// ---------------------------------------------------------------------------

export interface LaunchRequests {
  /** Records the workspace a Command Center selection asked for. */
  request(workspaceId: string): void;
  /** Returns and clears the pending request. */
  take(): string | null;
  subscribe(listener: () => void): () => void;
}

export function createLaunchRequests(): LaunchRequests {
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
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One launcher and one request queue per loaded client bundle. */
export const managerLauncher = createManagerLauncher();
export const launchRequests = createLaunchRequests();

/** Body of the workspace Command Center item. */
export function selectFromCommandCenter(
  context: { workspace: { id: string }; openSurface(id: string): void },
  requests: LaunchRequests = launchRequests,
): void {
  requests.request(context.workspace.id);
  context.openSurface(LAUNCHER_SURFACE_ID);
}

/**
 * Runs the pending Command Center request, if any. Without `openAgent` (older
 * Paseo hosts) the request stays queued and nothing is called.
 */
export async function runPendingRequest(
  requests: LaunchRequests,
  launcher: ManagerLauncher,
  deps: Pick<LaunchDeps, "ensure"> & { openAgent?: LaunchDeps["openAgent"] },
): Promise<LaunchOutcome | null> {
  if (!deps.openAgent) return null;
  const workspaceId = requests.take();
  if (workspaceId === null) return null;
  return launcher.launch(workspaceId, { ensure: deps.ensure, openAgent: deps.openAgent });
}

// ---------------------------------------------------------------------------
// Presentation: user-facing text (English) and styles from theme.colors.
// ---------------------------------------------------------------------------

export type NoticeTone = "muted" | "warning" | "danger";

export interface LauncherNotice {
  tone: NoticeTone;
  text: string;
}

export function describeLauncherState(state: LauncherState): LauncherNotice[] {
  switch (state.status) {
    case "idle":
      return [];
    case "pending":
      return [{ tone: "muted", text: "Opening Beads Manager…" }];
    case "opened": {
      const notices: LauncherNotice[] = [
        {
          tone: "muted",
          text: state.created
            ? "Started a new Beads Manager for this workspace."
            : "Reopened the existing Beads Manager for this workspace.",
        },
      ];
      const others = state.otherManagerIds.length;
      if (others > 0) {
        notices.push({
          tone: "warning",
          text: `This workspace has ${others} other live Beads Manager${others === 1 ? "" : "s"} (${state.otherManagerIds.join(", ")}). The newest one was opened; nothing was archived or deleted.`,
        });
      }
      // The chat is already open: this only explains why the Manager may still ask for permission.
      if (state.modeNotice !== null) notices.push({ tone: "warning", text: state.modeNotice });
      return notices;
    }
    case "error":
      return [
        {
          tone: "danger",
          text: state.code
            ? `Could not open Beads Manager (${state.code}). ${state.message}`
            : `Could not open Beads Manager. ${state.message}`,
        },
      ];
  }
}

export function toneColor(theme: PluginTheme, tone: NoticeTone): string {
  switch (tone) {
    case "muted":
      return theme.colors.foregroundMuted;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
  }
}

export function launcherStyles(theme: PluginTheme, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    content: { padding: compact ? 16 : 24, gap: compact ? 8 : 12 },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "600" as const },
    body: { color: theme.colors.foregroundMuted, fontSize: 14 },
    row: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      justifyContent: "space-between" as const,
      gap: compact ? 8 : 12,
      padding: compact ? 12 : 14,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    rowTitle: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
    rowSubtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
    stats: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 12, marginTop: 2 },
    stat: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
    statText: { fontSize: 12, fontWeight: "600" as const },
    /** The three actions stay on one line, on a phone too. */
    actions: { flexDirection: "row" as const, gap: 6 },
    action: {
      flexGrow: compact ? 1 : 0,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 6,
      paddingVertical: compact ? 7 : 6,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    iconButton: {
      padding: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    actionPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
    actionText: { color: theme.colors.foreground, fontSize: 13 },
    actionPrimaryText: { color: theme.colors.accentForeground, fontSize: 13 },
    button: {
      paddingVertical: 10,
      paddingHorizontal: 14,
      borderRadius: 8,
      alignItems: "center" as const,
      backgroundColor: theme.colors.accent,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.colors.accentForeground, fontSize: 14 },
    notice: { fontSize: 13 },
    footer: { color: theme.colors.foregroundMuted, fontSize: 12 },
    spinner: { color: theme.colors.foregroundMuted },
  };
}
