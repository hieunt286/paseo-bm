import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  LAUNCHER_ICON,
  LAUNCHER_SURFACE_ID,
  selectFromCommandCenter,
} from "./client/launch-manager";
import { ManagerLauncherSurface } from "./client/launcher";
import { AGENT_TREE_ICON, AGENT_TREE_PANEL_ID } from "./client/agent-tree";
import { AgentTreePanel } from "./client/tree";
import { DASHBOARD_ICON } from "./client/dashboard-model";
import { selectDashboardFromCommandCenter } from "./client/dashboard-view";
import { DashboardSettingsScreen, SETTINGS_ICON, SETTINGS_SCREEN_ID } from "./client/settings";
import { CHAT_CARD_KIND, CHAT_CARD_VERSION, chatCardSchema, toChatCard } from "./client/chat-cards";
import { ChatCardView } from "./client/chat-card";
import { ChatBeadsPanel } from "./client/bead-chips";

/** A chat item as a paseo-bm card, or nothing (the item stays Paseo's). */
function chatCardItems(item: { type: string }, phase: "streaming" | "complete") {
  const card = toChatCard(item, phase);
  return card === undefined
    ? undefined
    : { items: [{ type: "plugin" as const, kind: CHAT_CARD_KIND, version: CHAT_CARD_VERSION, data: card }] };
}

/**
 * Client entry of the paseo-bm plugin (design §2.4).
 *
 * WP-211 adds the Dashboard to that same surface (Q-036): a "Dashboard" button
 * per workspace, a workspace Command Center item that queues a workspace and
 * opens the surface, and a plugin settings screen for the trace-store warning
 * threshold.
 *
 * WP-113 registers the "Beads Manager" surface, its sidebar item and the
 * workspace Command Center item; both open the Manager through
 * `manager.ensure`. It also registers the read-only "Beads agents" workspace
 * panel (agent tree + role configuration).
 *
 * It also turns messages between the Manager, Workers and Reviewers into chat
 * cards (delta 20260916-chat-cards).
 *
 * This entry must never import from `server/`: that is a compile error.
 *
 * Declared as a hoisted `export default function`, not `const` + `export
 * default`: Paseo 0.8 rewrites esbuild's export getters into eager copies
 * (makeHermesInteropEager), so a late-bound default export is copied while
 * still undefined and the daemon refuses the plugin ("must default export a
 * function"). Guarded by test/plugin-bundle-cjs.test.ts.
 */
export default function contribute(client: PluginClientContext): () => void {
  // Register the surface before the sidebar item that points at it.
  const removers = [
    client.addSurface(LAUNCHER_SURFACE_ID, ManagerLauncherSurface),
    client.addSidebarItem({
      id: LAUNCHER_SURFACE_ID,
      title: "Beads Manager",
      icon: LAUNCHER_ICON,
      surface: LAUNCHER_SURFACE_ID,
    }),
    client.addCommandCenterItem({
      id: "open-beads-manager",
      title: "Open Beads Manager",
      icon: LAUNCHER_ICON,
      keywords: ["beads", "manager", "paseo-bm"],
      context: "workspace",
      onSelect: (context) => selectFromCommandCenter(context),
    }),
    client.addCommandCenterItem({
      id: "open-beads-dashboard",
      title: "Open Beads Metric",
      icon: DASHBOARD_ICON,
      keywords: ["beads", "metric", "dashboard", "traces", "paseo-bm"],
      context: "workspace",
      onSelect: (context) => selectDashboardFromCommandCenter(context, LAUNCHER_SURFACE_ID),
    }),
    client.addSettingsScreen({
      id: SETTINGS_SCREEN_ID,
      title: "Beads Dashboard",
      icon: SETTINGS_ICON,
      Component: DashboardSettingsScreen,
    }),
    // Messages between the Manager, Workers and Reviewers as cards
    // (delta 20260916-chat-cards). Only paseo-bm's own messages are changed.
    client.addTimelineTransformer({
      id: "bm-chat-received",
      query: { itemType: "user_message" },
      transform: ({ item, phase }) => chatCardItems(item, phase),
    }),
    client.addTimelineTransformer({
      id: "bm-chat-sent",
      query: { itemType: "assistant_message" },
      transform: ({ item, phase }) => chatCardItems(item, phase),
    }),
    client.addTimelineRenderer({
      kind: CHAT_CARD_KIND,
      version: CHAT_CARD_VERSION,
      schema: chatCardSchema,
      Component: ChatCardView,
    }),
    client.addWorkspacePanel({
      id: "bm-chat-beads",
      title: "Beads in this chat",
      icon: "ListChecks",
      context: "agent",
      Component: ChatBeadsPanel,
    }),
    client.addWorkspacePanel({
      id: AGENT_TREE_PANEL_ID,
      title: "Beads agents",
      icon: AGENT_TREE_ICON,
      context: "workspace",
      Component: AgentTreePanel,
    }),
  ];
  return () => {
    for (const remove of removers) void remove();
  };
}
