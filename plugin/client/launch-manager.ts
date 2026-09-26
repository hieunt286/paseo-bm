/**
 * Launch logic behind the "Open Beads Manager" entry points (WP-113, Technical
 * Design §2, §7.3). Pure and injectable: no React, no React Native, no JSX, so
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
 * surface shows Setup, and its Workspaces list opens a workspace's Manager.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import type { z } from "zod";
import type { managerEnsureRpc } from "../shared/contracts";
import type { Tone } from "./dashboard-model";
import { createSlot, type Slot } from "./slot";

/** Surface id shared by the sidebar item and the Command Center item. */
export const LAUNCHER_SURFACE_ID = "beads-manager";

/** Lucide icon name (lucide.dev/icons/bot). */
export const LAUNCHER_ICON = "Bot";

// ---------------------------------------------------------------------------
// Launch controller.
// ---------------------------------------------------------------------------

/** What `manager.ensure` answers, as its contract says (delta 20260918f S6). */
export type EnsureManagerOutput = z.infer<typeof managerEnsureRpc.output>;

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
      /** Added by delta 20260921 §4.2.4; absent in a state built before it. */
      toolsNotice?: string | null;
      /** What this machine still needs (0.4.0, design §7.3); absent in an older state. */
      setupNotice?: string | null;
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

/** The daemon's wrapping of a failed plugin RPC, around the server's own message. */
const RPC_FAILED_PREFIX = /^\s*Request failed:\s*/;
const RPC_ERROR_SUFFIX = /\s+requestType=\S+(?:\s+code=\S+)?\s*$/;

/**
 * The server's own message of a failed RPC. In the app a plugin RPC error
 * reaches the client as `@getpaseo/client`'s `DaemonRpcError`, whose message is
 * `Request failed: <message> requestType=<type> code=<code>`; the wrapping is
 * the daemon's, not ours, and says nothing to the user.
 */
function serverMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(RPC_FAILED_PREFIX, "").replace(RPC_ERROR_SUFFIX, "").trim();
}

/**
 * Registry code at the start of the server's message (`E_PROVIDER_UNAVAILABLE: ...`),
 * or null when the server sent none.
 */
export function errorCodeOf(error: unknown): string | null {
  return ERROR_CODE_PATTERN.exec(serverMessageOf(error))?.[1] ?? null;
}

/** The server's message, code included; `withoutCode` drops the code where it is shown apart. */
export function errorMessageOf(error: unknown): string {
  return serverMessageOf(error) || "Unknown error";
}

/**
 * `message` without its leading registry code, for a line that already names
 * the code; `""` when the message is the code alone.
 */
export function withoutCode(message: string): string {
  return message.replace(/^\s*E_[A-Z0-9_]+\s*:?\s*/, "").trim();
}

/** `(<code>). <rest>`, or `(<code>).` when the server sent the code alone. */
export function codedTail(code: string, message: string): string {
  const rest = withoutCode(message);
  return rest === "" ? `(${code}).` : `(${code}). ${rest}`;
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
          toolsNotice: result.toolsNotice ?? null,
          setupNotice: result.setupNotice ?? null,
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

/** One launcher and one request queue per loaded client bundle. */
export const managerLauncher = createManagerLauncher();
/** The workspace a Command Center selection asked for; the surface takes it. */
export const launchRequests: Slot<string> = createSlot<string>();

/** Body of the workspace Command Center item. */
export function selectFromCommandCenter(
  context: { workspace: { id: string }; openSurface(id: string): void },
  requests: Slot<string> = launchRequests,
): void {
  requests.put(context.workspace.id);
  context.openSurface(LAUNCHER_SURFACE_ID);
}

/**
 * Runs the pending Command Center request, if any. Without `openAgent` (older
 * Paseo hosts) the request stays queued and nothing is called. While another
 * launch is pending it stays queued too: taking it now would only get "busy"
 * back and lose it. The surface runs this again when the launcher's state
 * changes.
 */
export async function runPendingRequest(
  requests: Slot<string>,
  launcher: ManagerLauncher,
  deps: Pick<LaunchDeps, "ensure"> & { openAgent?: LaunchDeps["openAgent"] },
): Promise<LaunchOutcome | null> {
  if (!deps.openAgent) return null;
  if (launcher.getState().status === "pending") return null;
  const workspaceId = requests.take();
  if (workspaceId === null) return null;
  return launcher.launch(workspaceId, { ensure: deps.ensure, openAgent: deps.openAgent });
}

// ---------------------------------------------------------------------------
// Presentation: user-facing text (English) and styles from theme.colors.
// ---------------------------------------------------------------------------

/** The tones a launcher notice uses; colours come from `toneColor` in `dashboard-model.ts`. */
export type NoticeTone = Extract<Tone, "muted" | "warning" | "danger">;

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
      // Delta 20260921 §4.2.4: without Paseo tools this Manager cannot run a request.
      const toolsNotice = state.toolsNotice ?? null;
      if (toolsNotice !== null) notices.push({ tone: "warning", text: toolsNotice });
      // 0.4.0: what the machine still needs — roles just created with defaults,
      // and Paseo's agent-tools switch being off. Last, because the two above
      // are about this Manager and this one is about the machine.
      const setupNotice = state.setupNotice ?? null;
      if (setupNotice !== null) notices.push({ tone: "warning", text: setupNotice });
      return notices;
    }
    case "error":
      return [
        {
          tone: "danger",
          text: state.code
            ? `Could not open Beads Manager ${codedTail(state.code, state.message)}`
            : `Could not open Beads Manager. ${state.message}`,
        },
      ];
  }
}

/** Said when the host cannot open an agent from a plugin (no `navigation.openAgent`). */
export const OLD_HOST_WARNING = "This Paseo version cannot open agents from plugins. Update Paseo to use this launcher.";

/** One line of the status strip at the top of the Beads Manager surface. */
export interface StatusLine {
  key: string;
  text: string;
  tone: NoticeTone;
  /** Only a slash command's notice can be dismissed; the others follow the state. */
  dismissable: boolean;
}

/**
 * Everything the Beads Manager surface has to say before its content, in order:
 * what a slash command reported, a host too old to open agents, then the state
 * of the last Manager launch. The surface draws these on BOTH its main screen
 * (Setup) and the workspace list (delta 20260918e §4.2): `/bm-worker-stop-all`
 * opens the surface on the main screen, and a Command Center launch can fail
 * while any view is showing.
 */
export function launcherStatusLines(input: {
  commandNotice: string | null;
  canOpenAgents: boolean;
  state: LauncherState;
}): StatusLine[] {
  const lines: StatusLine[] = [];
  if (input.commandNotice !== null) {
    lines.push({ key: "command-notice", text: input.commandNotice, tone: "muted", dismissable: true });
  }
  if (!input.canOpenAgents) {
    lines.push({ key: "old-host", text: OLD_HOST_WARNING, tone: "warning", dismissable: false });
  }
  describeLauncherState(input.state).forEach((notice, index) => {
    lines.push({ key: `launch-${index}`, text: notice.text, tone: notice.tone, dismissable: false });
  });
  return lines;
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
