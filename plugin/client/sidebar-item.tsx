/** Live Beads Manager item for Paseo's custom sidebar-footer API (REQ-173). */
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { decisionsListRpc, inboxAlertsRpc } from "../shared/contracts";
import { LAUNCHER_ICON, LAUNCHER_SURFACE_ID } from "./launch-manager";
import { inboxAttentionCount, INBOX_POLL_MS } from "./inbox-model";
import { inboxQueryKeys } from "./inbox";
import { useUpdateStatus } from "./update-status";

type CustomSidebarClient = PluginClientContext & {
  /**
   * Added after the legacy static `addSidebarItem` API. Paseo 0.11 throws
   * without a non-blank `title`, and the throw fails the plugin's whole client.
   */
  addSidebarFooterItem?: (contribution: { id: string; title: string; Component: ComponentType<PluginHostProps> }) => () => void;
};

export function BeadsManagerSidebarItem({ theme, onOpen }: PluginHostProps & { onOpen: () => void }) {
  const listDecisions = useRpc(decisionsListRpc);
  const listAlerts = useRpc(inboxAlertsRpc);
  const decisions = useQuery({
    queryKey: inboxQueryKeys.decisions,
    queryFn: () => listDecisions({ scope: "inbox" }),
    refetchInterval: INBOX_POLL_MS,
  });
  const alerts = useQuery({
    queryKey: inboxQueryKeys.alerts,
    queryFn: () => listAlerts({}),
    refetchInterval: INBOX_POLL_MS,
  });
  const count = inboxAttentionCount(decisions.data?.decisions ?? [], alerts.data?.alerts ?? []);
  const updates = useUpdateStatus();
  const updateAvailable = updates.data?.updateAvailable === true;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Beads Manager${count > 0 ? `, ${count} items need you` : ""}${updateAvailable ? ", update available" : ""}`}
      onPress={onOpen}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9 }}
    >
      <Icon name={LAUNCHER_ICON} size={18} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: 14, flex: 1 }}>Beads Manager</Text>
      {updateAvailable ? <Icon name="Download" size={16} color={theme.colors.statusWarning} /> : null}
      {count > 0 ? (
        <View style={{ minWidth: 20, paddingHorizontal: 5, paddingVertical: 1, backgroundColor: theme.colors.statusWarning, alignItems: "center" }}>
          <Text style={{ color: theme.colors.surface0, fontSize: 12 }}>{String(count)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Register the live custom item where supported, with the legacy item as a compatibility fallback. */
export function registerBeadsManagerSidebarItem(client: PluginClientContext): () => void {
  const custom = (client as CustomSidebarClient).addSidebarFooterItem;
  if (typeof custom === "function") {
    const SidebarItem = (props: PluginHostProps) => <BeadsManagerSidebarItem {...props} onOpen={() => client.openSurface(LAUNCHER_SURFACE_ID)} />;
    return custom.call(client, { id: LAUNCHER_SURFACE_ID, title: "Beads Manager", Component: SidebarItem });
  }
  return client.addSidebarItem({
    id: LAUNCHER_SURFACE_ID,
    title: "Beads Manager",
    icon: LAUNCHER_ICON,
    surface: LAUNCHER_SURFACE_ID,
  });
}
