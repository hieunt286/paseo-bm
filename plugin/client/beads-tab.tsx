/**
 * The "Beads" tab of a workspace (delta 20260918e §4.1, REQ-060 a–c): the
 * workspace panel Paseo lists in the "+" menu of the tab bar — the dropdown on
 * desktop and the "New tab" screen on mobile.
 *
 * It is the workspace's project page of Projects (autonomy design §A.12,
 * experience concept §3, change-014 outcome 5): Overview · Requests · Beads ·
 * Metrics · Agents, opened on Beads. A workspace panel cannot open the Beads
 * Manager surface, so the page is drawn here, without a back button or a
 * title (and its Overview names the autonomy level without a way to
 * Settings): the tab already lives in its workspace. Its data stays in the
 * React Query cache under the same keys, so the surface and the tab share one
 * read.
 *
 * `/bm-worker-new` opens this tab where it was typed: its notice
 * (`worker-new.ts`) shows above the page, with an "Open Main" action, until
 * dismissed.
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { dashboardStyles } from "./styles";
import { BEADS_TAB_INITIAL } from "./surface-view";
import { Button } from "./ui";
import { ProjectPage } from "./work";
import { workerNewNotices } from "./worker-new";

export function BeadsTabPanel(props: PluginWorkspacePanelProps) {
  const notice = useSyncExternalStore(workerNewNotices.subscribe, workerNewNotices.peek, workerNewNotices.peek);
  const styles = useMemo(() => dashboardStyles(props.theme, props.layout.compact), [props.theme, props.layout.compact]);
  const openAgent = props.navigation?.openAgent;
  const status =
    notice === null || notice.workspaceId !== props.workspaceId ? undefined : (
      <View accessibilityLiveRegion="polite" style={[styles.card, { gap: 6 }]}>
        {notice.lines.map((line, index) => (
          <Text key={index} style={index === 0 ? styles.sectionTitle : styles.body}>
            {line}
          </Text>
        ))}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {openAgent === undefined ? null : <Button label={notice.openLabel} kind="primary" size="small" styles={styles} onPress={() => openAgent({ agentId: notice.agentId })} />}
          <Button label="Dismiss" kind="text" styles={styles} onPress={() => workerNewNotices.take()} />
        </View>
      </View>
    );
  return <ProjectPage {...props} label={null} initialTab={BEADS_TAB_INITIAL} status={status} />;
}
