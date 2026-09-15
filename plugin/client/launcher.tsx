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
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { managerEnsureRpc } from "../shared/contracts";
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

interface WorkspaceRow {
  id: string;
  label: string;
  detail: string;
}

export function ManagerLauncherSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const ensure = useRpc(managerEnsureRpc);
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
        }));
    },
  });

  // Run a launch queued by the Command Center item, now and whenever one arrives.
  useEffect(() => {
    const run = () => {
      void runPendingRequest(launchRequests, managerLauncher, { ensure, openAgent });
    };
    run();
    return launchRequests.subscribe(run);
  }, [ensure, openAgent]);

  const pending = state.status === "pending";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Beads Manager</Text>
      <Text style={styles.body}>
        Open the Beads Manager of a workspace. An existing Manager is reopened; a new one is
        started only when the workspace has none.
      </Text>

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

      {openAgent
        ? workspaces.data?.map((workspace) => {
            const busyHere = pending && state.workspaceId === workspace.id;
            return (
              <View key={workspace.id} style={styles.row}>
                <View>
                  <Text style={styles.rowTitle}>{workspace.label}</Text>
                  <Text style={styles.rowSubtitle}>{workspace.detail}</Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open Beads Manager for ${workspace.label}`}
                  accessibilityState={{ disabled: pending, busy: busyHere }}
                  disabled={pending}
                  onPress={() => {
                    void managerLauncher.launch(workspace.id, { ensure, openAgent });
                  }}
                  style={[styles.button, pending ? styles.buttonDisabled : null]}
                >
                  {busyHere ? (
                    <ActivityIndicator color={styles.buttonText.color} />
                  ) : (
                    <Text style={styles.buttonText}>Open Beads Manager</Text>
                  )}
                </Pressable>
              </View>
            );
          })
        : null}

      <Text style={styles.footer}>{`paseo-bm ${PLUGIN_VERSION}`}</Text>
    </ScrollView>
  );
}
