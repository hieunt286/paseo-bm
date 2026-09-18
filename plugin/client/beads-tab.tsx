/**
 * The "Beads" tab of a workspace (delta 20260918e §4.1, REQ-060 a–c): the
 * workspace panel Paseo lists in the "+" menu of the tab bar — the dropdown on
 * desktop and the "New tab" screen on mobile — with the workspace's Beads and
 * Metric screens as two sub-tabs.
 *
 * The two screens are the ones the Beads Manager surface shows, rendered
 * without a back button or a title: the tab already lives in its workspace.
 * Their data stays in the React Query cache under their usual keys, so
 * switching sub-tabs does not wait for a reload.
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { BeadsScreen } from "./beads-screen";
import { DashboardPanel } from "./dashboard";
import { dashboardStyles } from "./dashboard-model";
import { BEADS_TAB_VIEWS, DEFAULT_BEADS_TAB_VIEW, type BeadsTabView } from "./dashboard-view";

export function BeadsTabPanel(props: PluginWorkspacePanelProps) {
  const { theme, layout } = props;
  const styles = useMemo(() => dashboardStyles(theme, layout.compact), [theme, layout.compact]);
  // Lives as long as this tab: a reload opens on Beads again (PRD delta §6).
  const [view, setView] = useState<BeadsTabView>(DEFAULT_BEADS_TAB_VIEW);
  // The same outer padding as the screens below, so the row lines up with them.
  const padding = styles.content.padding;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 8, paddingHorizontal: padding, paddingTop: padding }}>
        {BEADS_TAB_VIEWS.map((tab) => {
          const selected = tab.key === view;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => setView(tab.key)}
              style={selected ? styles.button : styles.secondaryButton}
            >
              <Text style={selected ? styles.buttonText : styles.secondaryButtonText}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flex: 1 }}>
        {view === "beads" ? (
          <BeadsScreen {...props} />
        ) : (
          <DashboardPanel {...props} />
        )}
      </View>
    </View>
  );
}
