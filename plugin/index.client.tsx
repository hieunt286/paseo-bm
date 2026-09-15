import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  LAUNCHER_ICON,
  LAUNCHER_SURFACE_ID,
  selectFromCommandCenter,
} from "./client/launch-manager";
import { ManagerLauncherSurface } from "./client/launcher";
import { AGENT_TREE_ICON, AGENT_TREE_PANEL_ID } from "./client/agent-tree";
import { AgentTreePanel } from "./client/tree";

/**
 * Client entry of the paseo-bm plugin (design §2.4).
 *
 * WP-113 registers the "Beads Manager" surface, its sidebar item and the
 * workspace Command Center item; both open the Manager through
 * `manager.ensure`. It also registers the read-only "Beads agents" workspace
 * panel (agent tree + role configuration).
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
