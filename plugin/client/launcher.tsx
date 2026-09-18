/**
 * "Beads Manager" surface (WP-113): the screen behind the sidebar item and the
 * Command Center item. It only renders; the launch logic, texts and styles live
 * in `launch-manager.ts`, which is tested without a renderer.
 *
 * Client rules: React Native primitives only, every color from theme.colors,
 * no Node builtin imports.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { BeadsScreen } from "./beads-screen";
import { SetupScreen } from "./setup-screen";
import { DashboardPanel } from "./dashboard";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  SURFACE_HOME_VIEW,
  WORKSPACE_ACTIONS,
  backLabelOf,
  backOf,
  overviewPolling,
  closedWorkspaces,
  dashboardRequests,
  launcherNotices,
  screenTitleOf,
  workspaceStats,
  type DashboardViewName,
} from "./dashboard-view";
import { toneColor, type Tone } from "./dashboard-model";
import { managerEnsureRpc, tracesWorkspacesRpc, workspacesOverviewRpc } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import {
  errorMessageOf,
  launcherStatusLines,
  launcherStyles,
  launchRequests,
  managerLauncher,
  runPendingRequest,
  type StatusLine,
} from "./launch-manager";

interface WorkspaceRow {
  id: string;
  label: string;
  detail: string;
  /** Title of the Metric and Beads screens: the workspace and its project. */
  screenTitle: string;
}

/** One breath of the pulse: slow enough to read as "alive", not as an alarm. */
const PULSE_MS = 900;
/** The floor of the pulse, and the resting opacity of a dot with nothing to say. */
const DIM_OPACITY = 0.3;
/** Roles in the order they appear in the label, with the word the user reads. */
const DOT_ROLES = [
  ["manager", "Manager"],
  ["worker", "Worker"],
  ["reviewer", "Reviewer"],
] as const;

/** Running bm agents of one workspace, per role (`workspaces.overview`). */
export interface RunningAgentCounts {
  manager: number;
  worker: number;
  reviewer: number;
}

/** Everything the dot beside a project name shows; see `runningDotState`. */
export interface RunningDotState {
  total: number;
  /** True only when the dot pulses: an idle row and reduced motion both say false. */
  animate: boolean;
  /** Resting opacity, and the value the pulse returns to. */
  opacity: number;
  /** "1 Worker, 1 Reviewer" — read aloud even when the text is not drawn. */
  label: string;
  tone: Tone;
}

/**
 * The dot that says a bm agent is working in this workspace right now
 * (delta 20260917e §4.2): it pulses while any of the three roles runs, and
 * stands still and dim when none does.
 */
export function runningDotState(
  counts: RunningAgentCounts | undefined,
  reduceMotion: boolean,
): RunningDotState | null {
  // The overview has not answered for this row yet. Unknown is not idle, and a
  // dim dot would claim "nothing is running" before anything was counted.
  if (counts === undefined) return null;
  const total = counts.manager + counts.worker + counts.reviewer;
  if (total === 0) {
    return { total, animate: false, opacity: DIM_OPACITY, label: "No Beads agent running", tone: "muted" };
  }
  return {
    total,
    // Reduced motion keeps the signal and drops the motion: the dot goes solid
    // and no loop is started at all.
    animate: !reduceMotion,
    opacity: 1,
    label: DOT_ROLES.filter(([key]) => counts[key] > 0)
      .map(([key, name]) => `${counts[key]} ${name}${counts[key] === 1 ? "" : "s"}`)
      .join(", "),
    tone: "success",
  };
}

/**
 * Puts a state on an `Animated.Value`: the resting opacity always, the pulse
 * only when the state asks for one. Returns the stop function, or `undefined`
 * when there is nothing running to stop — that is the whole reduced-motion
 * promise, so it is a function the test can call rather than a rendered effect.
 */
export function applyDotPulse(value: Animated.Value, state: RunningDotState): (() => void) | undefined {
  // Set on every change so a dot that stops pulsing lands on its resting
  // opacity instead of wherever the interrupted loop left it.
  value.setValue(state.opacity);
  if (!state.animate) return undefined;
  const loop = Animated.loop(
    Animated.sequence([
      // `useNativeDriver` must be false on react-native-web, which is what
      // Paseo's renderer is (delta 20260917e P3).
      Animated.timing(value, { toValue: DIM_OPACITY, duration: PULSE_MS, useNativeDriver: false }),
      Animated.timing(value, { toValue: 1, duration: PULSE_MS, useNativeDriver: false }),
    ]),
  );
  loop.start();
  return () => loop.stop();
}

/**
 * The operating system's "reduce motion" preference, false when the host cannot
 * answer. A host that fails the query has not asked for less motion; reading
 * that absence as a preference would quietly kill the pulse everywhere.
 */
export async function readReduceMotion(): Promise<boolean> {
  try {
    return await AccessibilityInfo.isReduceMotionEnabled();
  } catch {
    return false;
  }
}

function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let live = true;
    void readReduceMotion().then((value) => {
      if (live) setReduceMotion(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return reduceMotion;
}

function RunningDot(props: {
  counts: RunningAgentCounts | undefined;
  theme: PluginTheme;
  styles: ReturnType<typeof launcherStyles>;
}) {
  const { counts, theme, styles } = props;
  const reduceMotion = useReduceMotion();
  const state = runningDotState(counts, reduceMotion);
  const opacity = useRef(new Animated.Value(DIM_OPACITY)).current;
  // Restarting on `animate` and `opacity` alone keeps the loop through a poll
  // that only changed the counts, so the dot does not blink back to full.
  useEffect(() => (state === null ? undefined : applyDotPulse(opacity, state)), [
    opacity,
    state?.animate,
    state?.opacity,
  ]);
  if (state === null) return null;
  return (
    <View style={styles.stat} accessibilityLabel={state.label}>
      <Animated.View
        style={{ width: 8, height: 8, borderRadius: 4, opacity, backgroundColor: toneColor(theme, state.tone) }}
      />
      {/* An idle row says it with the dim dot alone; spelling out "nothing is
          running" on every quiet project is noise. The accessibility label
          above carries the words in both states. */}
      {state.total === 0 ? null : (
        <Text style={[styles.statText, { color: toneColor(theme, state.tone) }]} numberOfLines={1}>
          {state.label}
        </Text>
      )}
    </View>
  );
}

/**
 * The surface's status strip: a slash command's notice (tap to dismiss), a host
 * too old to open agents, and the state of the last Manager launch. Built once
 * by the surface and drawn on both the main screen (Setup) and the workspace
 * list (delta 20260918e §4.2); the lines come from `launcherStatusLines`.
 */
function LauncherStatus({
  lines,
  onDismiss,
  theme,
  styles,
}: {
  lines: readonly StatusLine[];
  onDismiss: () => void;
  theme: PluginTheme;
  styles: ReturnType<typeof launcherStyles>;
}) {
  return (
    <>
      {lines.map((line) =>
        line.dismissable ? (
          <Pressable
            key={line.key}
            accessibilityRole="button"
            accessibilityLabel={`${line.text}. Dismiss.`}
            onPress={onDismiss}
            style={styles.row}
          >
            <Text style={styles.rowSubtitle}>{line.text}</Text>
          </Pressable>
        ) : (
          <Text
            key={line.key}
            accessibilityLiveRegion="polite"
            style={[styles.notice, { color: toneColor(theme, line.tone) }]}
          >
            {line.text}
          </Text>
        ),
      )}
    </>
  );
}

export function ManagerLauncherSurface(props: PluginSurfaceProps) {
  const { theme, layout, navigation } = props;
  const paseo = usePaseo();
  // The Dashboard shares this surface (Q-036), so the view is state here and the
  // Command Center hand-off is a queue, exactly like the launch request below.
  // It opens on Setup, the main screen (delta 20260918e §4.2).
  const [view, setView] = useState<DashboardViewName>(SURFACE_HOME_VIEW);
  const [dashboardWorkspace, setDashboardWorkspace] = useState<{ id: string; label: string } | null>(null);
  const ensure = useRpc(managerEnsureRpc);
  const listStored = useRpc(tracesWorkspacesRpc);
  const stored = useQuery({
    queryKey: ["paseo-bm", "launcher", "stored-workspaces"],
    queryFn: () => listStored({}),
  });
  const listOverview = useRpc(workspacesOverviewRpc);
  // Bead counts and running Workers; read and refreshed only while the
  // workspace list shows them (delta 20260918f F5).
  const overview = useQuery({
    queryKey: ["paseo-bm", "launcher", "overview"],
    queryFn: () => listOverview({}),
    ...overviewPolling(view),
  });
  const overviewById = useMemo(
    () => new Map((overview.data?.workspaces ?? []).map((entry) => [entry.workspaceId, entry])),
    [overview.data],
  );
  const openAgent = navigation?.openAgent;
  const state = useSyncExternalStore(
    managerLauncher.subscribe,
    managerLauncher.getState,
    managerLauncher.getState,
  );
  // What a slash command had to say. It has no channel of its own except an
  // error toast, which would paint a success red (dashboard-view.ts).
  const commandNotice = useSyncExternalStore(
    launcherNotices.subscribe,
    launcherNotices.peek,
    launcherNotices.peek,
  );
  const styles = useMemo(() => launcherStyles(theme, layout.compact), [theme, layout.compact]);

  const workspaces = useQuery({
    queryKey: ["paseo-bm", "launcher", "workspaces"],
    queryFn: async (): Promise<WorkspaceRow[]> => {
      const result = await paseo.workspaces.list({
        sort: [{ key: "activity_at", direction: "desc" }],
      });
      return result.entries
        .filter((workspace) => !workspace.archivingAt)
        .map((workspace) => ({
          id: workspace.id,
          label: workspace.title || workspace.name,
          detail: workspace.projectDisplayName,
          screenTitle: screenTitleOf(workspace.title || workspace.name, workspace.projectDisplayName),
        }));
    },
  });

  // Open the Dashboard when the Command Center queued one.
  useEffect(() => {
    const run = () => {
      const workspaceId = dashboardRequests.take();
      if (workspaceId === null) return;
      const known = workspaces.data?.find((workspace) => workspace.id === workspaceId);
      setDashboardWorkspace({ id: workspaceId, label: known?.screenTitle ?? workspaceId });
      setView("dashboard");
    };
    run();
    return dashboardRequests.subscribe(run);
  }, [workspaces.data]);

  // Run a launch queued by the Command Center item, now, whenever one arrives,
  // and when a pending launch ends (a request that came meanwhile waited).
  useEffect(() => {
    const run = () => {
      void runPendingRequest(launchRequests, managerLauncher, { ensure, openAgent });
    };
    run();
    const stopRequests = launchRequests.subscribe(run);
    const stopLauncher = managerLauncher.subscribe(run);
    return () => {
      stopRequests();
      stopLauncher();
    };
  }, [ensure, openAgent]);

  const pending = state.status === "pending";
  // Every ← goes where `backOf` says: Metric and Beads to the workspace list,
  // the list to Setup. Setup is the main screen and has no ←.
  const goBack = () => setView(backOf(view) ?? SURFACE_HOME_VIEW);

  // Built ONCE and placed on every view of the surface (Setup, the workspace
  // list, Metric, Beads), so a slash command's notice and a launch error are
  // seen wherever the surface is.
  const status = (
    <LauncherStatus
      lines={launcherStatusLines({ commandNotice, canOpenAgents: openAgent !== undefined, state })}
      onDismiss={() => launcherNotices.take()}
      theme={theme}
      styles={styles}
    />
  );

  if (view === "setup") {
    return <SetupScreen {...props} onOpenWorkspaces={() => setView("workspaces")} status={status} />;
  }

  if (view === "beads" && dashboardWorkspace !== null) {
    return (
      <BeadsScreen
        {...props}
        workspaceId={dashboardWorkspace.id}
        workspaceLabel={dashboardWorkspace.label}
        onBack={goBack}
        backLabel={backLabelOf(view) ?? undefined}
        status={status}
      />
    );
  }

  if (view === "dashboard" && dashboardWorkspace !== null) {
    return (
      <DashboardPanel
        {...props}
        workspaceId={dashboardWorkspace.id}
        workspaceLabel={dashboardWorkspace.label}
        onBack={goBack}
        backLabel={backLabelOf(view) ?? undefined}
        status={status}
      />
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={backLabelOf(view) ?? undefined}
          onPress={goBack}
          style={styles.iconButton}
        >
          <Text style={styles.rowTitle}>←</Text>
        </Pressable>
        <Text style={[styles.title, { flex: 1 }]}>Workspaces</Text>
      </View>
      <Text style={styles.body}>Chat with a workspace's Beads Manager, or open its metrics or beads.</Text>

      {status}

      {workspaces.isPending ? <ActivityIndicator color={styles.spinner.color} /> : null}
      {workspaces.isError ? (
        <Text style={[styles.notice, { color: toneColor(theme, "danger") }]}>
          {`Could not load workspaces. ${errorMessageOf(workspaces.error)}`}
        </Text>
      ) : null}
      {workspaces.data?.length === 0 ? (
        <Text style={styles.body}>No workspaces on this host yet.</Text>
      ) : null}

      {/* The rows render even without `navigation.openAgent`: only the Manager
          button needs it, while the Dashboard is read-only and must stay
          reachable on an older host (REQ-040d). They keep the order
          `workspaces.list` returns: most recent activity first, no pinning
          (delta 20260918f §4.5). */}
      {(workspaces.data ?? []).map((workspace) => {
        const busyHere = pending && state.workspaceId === workspace.id;
        const open = (view: "dashboard" | "beads") => {
          setDashboardWorkspace({ id: workspace.id, label: workspace.screenTitle });
          setView(view);
        };
        const stats = workspaceStats(overviewById.get(workspace.id));
        return (
          <View key={workspace.id} style={styles.row}>
            <View style={{ gap: 4, flexShrink: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.rowTitle, { flexShrink: 1 }]} numberOfLines={1}>
                  {workspace.label}
                </Text>
                <RunningDot counts={overviewById.get(workspace.id)?.runningAgents} theme={theme} styles={styles} />
              </View>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {workspace.detail}
              </Text>
              {stats.length === 0 ? null : (
                <View style={styles.stats} accessibilityLabel={stats.map((stat) => stat.label).join(", ")}>
                  {stats.map((stat) => (
                    <View key={stat.key} style={styles.stat}>
                      <Icon name={stat.icon} size={13} color={toneColor(theme, stat.tone)} />
                      <Text style={[styles.statText, { color: toneColor(theme, stat.tone) }]}>{stat.value}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
            {/* The rows render even without `navigation.openAgent`: only the
                Manager action needs it, while Metric and Beads are read-only
                and must stay reachable on an older host (REQ-040d). */}
            <View style={styles.actions}>
              {WORKSPACE_ACTIONS.map((action) => {
                if (action.key === "manager" && !openAgent) return null;
                const primary = action.key === "manager";
                const disabled = primary && pending;
                const textStyle = primary ? styles.actionPrimaryText : styles.actionText;
                return (
                  <Pressable
                    key={action.key}
                    accessibilityRole="button"
                    accessibilityLabel={
                      action.key === "manager"
                        ? `Go to the Beads Manager of ${workspace.label}`
                        : action.key === "metric"
                          ? `Open the Beads metrics for ${workspace.label}`
                          : `Open the beads of ${workspace.label}`
                    }
                    accessibilityState={primary ? { disabled, busy: busyHere } : undefined}
                    disabled={disabled}
                    onPress={() => {
                      if (action.key === "manager") void managerLauncher.launch(workspace.id, { ensure, openAgent: openAgent! });
                      else open(action.key === "metric" ? "dashboard" : "beads");
                    }}
                    style={[styles.action, primary ? styles.actionPrimary : null, disabled ? styles.buttonDisabled : null]}
                  >
                    {primary && busyHere ? (
                      <ActivityIndicator color={textStyle.color} />
                    ) : (
                      <>
                        <Icon name={action.icon} size={14} color={textStyle.color} />
                        <Text style={textStyle}>{action.label}</Text>
                      </>
                    )}
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}

      {/* History of workspaces Paseo no longer lists: still readable, and
          movable onto the reopened workspace from its Metric screen. */}
      {closedWorkspaces(stored.data?.workspaces ?? [], workspaces.data?.map((workspace) => workspace.id) ?? []).map(
        (closed, index) => (
          <View key={closed.workspaceId} style={{ gap: 6 }}>
            {index === 0 ? <Text style={styles.title}>Closed workspaces with history</Text> : null}
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{closed.label}</Text>
                <Text style={styles.rowSubtitle}>{closed.detail}</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open the Beads metrics of the closed workspace ${closed.label}`}
                onPress={() => {
                  setDashboardWorkspace({ id: closed.workspaceId, label: closed.label });
                  setView("dashboard");
                }}
                style={styles.button}
              >
                <Text style={styles.buttonText}>Metric</Text>
              </Pressable>
            </View>
          </View>
        ),
      )}

      <Text style={styles.footer}>{`paseo-bm ${PLUGIN_VERSION}`}</Text>
    </ScrollView>
  );
}
