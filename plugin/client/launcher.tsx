/**
 * "Beads Manager" surface (WP-113): the screen behind the sidebar item and the
 * Command Center item. It only renders; the launch logic, texts and styles live
 * in `launch-manager.ts`, which is tested without a renderer.
 *
 * Client rules: React Native primitives only, every color from theme.colors,
 * no Node builtin imports.
 */
import { type PluginSurfaceProps, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { BeadsScreen } from "./beads-screen";
import { SetupScreen } from "./setup-screen";
import { DashboardPanel } from "./dashboard";
import { Icon } from "@getpaseo/plugin/client/react-native";
import {
  WORKSPACE_ACTIONS,
  closedWorkspaces,
  dashboardRequests,
  screenTitleOf,
  workspaceStats,
  type DashboardViewName,
} from "./dashboard-view";
import { toneColor as dashboardTone } from "./dashboard-model";
import { managerEnsureRpc, tracesWorkspacesRpc, workspacesOverviewRpc } from "../shared/contracts";
import { PLUGIN_VERSION } from "../shared/version";
import {
  describeLauncherState,
  errorMessageOf,
  launcherStyles,
  launchRequests,
  managerLauncher,
  runPendingRequest,
  toneColor,
} from "./launch-manager";

/** How often the per-workspace figures are refreshed while the launcher is open. */
const OVERVIEW_POLL_MS = 10_000;

interface WorkspaceRow {
  id: string;
  label: string;
  detail: string;
  /** Title of the Metric and Beads screens: the workspace and its project. */
  screenTitle: string;
}

export function ManagerLauncherSurface(props: PluginSurfaceProps) {
  const { theme, layout, navigation } = props;
  const paseo = usePaseo();
  // The Dashboard shares this surface (Q-036), so the view is state here and the
  // Command Center hand-off is a queue, exactly like the launch request below.
  const [view, setView] = useState<DashboardViewName>("launcher");
  const [dashboardWorkspace, setDashboardWorkspace] = useState<{ id: string; label: string } | null>(null);
  const ensure = useRpc(managerEnsureRpc);
  const listStored = useRpc(tracesWorkspacesRpc);
  const stored = useQuery({
    queryKey: ["paseo-bm", "launcher", "stored-workspaces"],
    queryFn: () => listStored({}),
  });
  const listOverview = useRpc(workspacesOverviewRpc);
  // Bead counts and running Workers; refreshed while the screen is open.
  const overview = useQuery({
    queryKey: ["paseo-bm", "launcher", "overview"],
    queryFn: () => listOverview({}),
    refetchInterval: OVERVIEW_POLL_MS,
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

  // Run a launch queued by the Command Center item, now and whenever one arrives.
  useEffect(() => {
    const run = () => {
      void runPendingRequest(launchRequests, managerLauncher, { ensure, openAgent });
    };
    run();
    return launchRequests.subscribe(run);
  }, [ensure, openAgent]);

  const pending = state.status === "pending";

  if (view === "settings") {
    return <SetupScreen {...props} onBack={() => setView("launcher")} />;
  }

  if (view === "beads" && dashboardWorkspace !== null) {
    return (
      <BeadsScreen
        {...props}
        workspaceId={dashboardWorkspace.id}
        workspaceLabel={dashboardWorkspace.label}
        onBack={() => setView("launcher")}
      />
    );
  }

  if (view === "dashboard" && dashboardWorkspace !== null) {
    return (
      <DashboardPanel
        {...props}
        workspaceId={dashboardWorkspace.id}
        workspaceLabel={dashboardWorkspace.label}
        onBack={() => setView("launcher")}
      />
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.title, { flex: 1 }]}>Beads Manager</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Setup: beads tools, agent skills and role instructions"
          onPress={() => setView("settings")}
          style={styles.iconButton}
        >
          <Icon name="Settings" size={18} color={styles.rowTitle.color} />
        </Pressable>
      </View>
      <Text style={styles.body}>Chat with a workspace's Beads Manager, or open its metrics or beads.</Text>

      {!openAgent ? (
        <Text style={[styles.notice, { color: toneColor(theme, "warning") }]}>
          This Paseo version cannot open agents from plugins. Update Paseo to use this launcher.
        </Text>
      ) : null}

      {describeLauncherState(state).map((notice) => (
        <Text
          key={notice.text}
          accessibilityLiveRegion="polite"
          style={[styles.notice, { color: toneColor(theme, notice.tone) }]}
        >
          {notice.text}
        </Text>
      ))}

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
          reachable on an older host (REQ-040d). */}
      {workspaces.data?.map((workspace) => {
        const busyHere = pending && state.workspaceId === workspace.id;
        const open = (view: "dashboard" | "beads") => {
          setDashboardWorkspace({ id: workspace.id, label: workspace.screenTitle });
          setView(view);
        };
        const stats = workspaceStats(overviewById.get(workspace.id));
        return (
          <View key={workspace.id} style={styles.row}>
            <View style={{ gap: 4, flexShrink: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {workspace.label}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {workspace.detail}
              </Text>
              {stats.length === 0 ? null : (
                <View style={styles.stats} accessibilityLabel={stats.map((stat) => stat.label).join(", ")}>
                  {stats.map((stat) => (
                    <View key={stat.key} style={styles.stat}>
                      <Icon name={stat.icon} size={13} color={dashboardTone(theme, stat.tone)} />
                      <Text style={[styles.statText, { color: dashboardTone(theme, stat.tone) }]}>{stat.value}</Text>
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
