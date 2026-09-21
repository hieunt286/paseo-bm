import type { PluginClientContext, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import {
  LAUNCHER_ICON,
  LAUNCHER_SURFACE_ID,
  selectFromCommandCenter,
} from "./client/launch-manager";
import { agentsStopAllRpc, managerEnsureRpc } from "./shared/contracts";
import { NEW_REQUEST_MARKER } from "./shared/new-request";
import { ManagerLauncherSurface } from "./client/launcher";
import { AGENT_TREE_ICON, AGENT_TREE_PANEL_ID } from "./client/agent-tree";
import { AgentTreePanel } from "./client/tree";
import { DASHBOARD_ICON } from "./client/dashboard-model";
import { BEADS_TAB_PANEL_ID, launcherNotices, selectDashboardFromCommandCenter } from "./client/dashboard-view";
import { DashboardSettingsScreen, SETTINGS_ICON, SETTINGS_SCREEN_ID } from "./client/settings";
import { CHAT_CARD_KIND, CHAT_CARD_VERSION, chatCardSchema, toChatCard } from "./client/chat-cards";
import { ChatCardView } from "./client/chat-card";
import { ChatBeadsPanel } from "./client/bead-chips";
import { BeadsTabPanel } from "./client/beads-tab";
import { registerBeadsHeaderButtons } from "./client/beads-header-button";
import { registerWaitingPills } from "./client/waiting-pills";

/** A chat item as a paseo-bm card, or nothing (the item stays Paseo's). */
function chatCardItems(item: { type: string }, phase: "streaming" | "complete") {
  const card = toChatCard(item, phase);
  return card === undefined
    ? undefined
    : { items: [{ type: "plugin" as const, kind: CHAT_CARD_KIND, version: CHAT_CARD_VERSION, data: card }] };
}

// ---------------------------------------------------------------------------
// Slash commands (delta 20260917e §4.4).
// ---------------------------------------------------------------------------

/** What Paseo hands a slash command: the workspace context plus the typed text. */
type WorkspaceCommand = PluginWorkspaceCommandContext & { args: string };

/**
 * `/bm-worker-new <request>`.
 *
 * A typing shortcut, not a second way to create a Worker (owner decision Q24):
 * the request goes to the Manager, and the Manager keeps doing what it always
 * does — mint the `requestId`, size the work, create the Worker, report back.
 * Creating a Worker here would leave those steps to nobody.
 *
 * `paseo.agents.ref().send()` is the path the app's own composer uses, so the
 * request is recorded as a real user message (verified fact P2) and none of the
 * three role prompts has to learn about this command.
 */
async function runWorkerNew(context: WorkspaceCommand): Promise<void> {
  const request = context.args.trim();
  // `manager.ensure` is the same call the launcher button makes: it finds this
  // workspace's live Manager or starts one, and de-duplicates server-side.
  const { agentId } = await context.rpc(managerEnsureRpc, { workspaceId: context.workspace.id });
  // Verbatim: anything we prefixed would be quoted back at the user as their
  // own words, and would land in the trace store as part of the request. No
  // args sends nothing at all, because an empty message would force the Manager
  // to invent a request, which its own rules forbid.
  // The flag line tells the Manager this is NEW work, not a follow-up. Without
  // it the Manager applies its own rule -- a message while a request is live is
  // a follow-up -- and hands the words to the Worker already busy, which is the
  // opposite of what this command is for (delta 20260917f §2 lỗi A).
  if (request !== "") {
    await context.paseo.agents.ref(agentId).send(`${NEW_REQUEST_MARKER}\n${request}`);
  }
  // Either way the chat opens, so the user can keep typing into it. That goes
  // through the Command Center hand-off, because a command context has no
  // `navigation.openAgent` — only a surface does. The surface calls
  // `manager.ensure` a second time on the way; that call is idempotent and
  // returns the Manager this one just ensured.
  selectFromCommandCenter(context);
}

/** English plural for a count: `1 Worker`, `0 Workers`, `2 Workers`. */
function counted(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/**
 * What the user is told after `/bm-worker-stop-all`.
 *
 * Every word is weighed against verified fact P4: Paseo gives a plugin no way
 * to cancel an agent, so the command delivers a notice and nothing more.
 * "Asked … to stop" is what happened; "stopped" would be a promise the product
 * cannot keep, and a user who believes it will not go back and check.
 */
function stopAllSummary(result: { workers: number; reviewers: number; skipped: number }): string {
  return (
    `Asked ${counted(result.workers, "Worker")} and ${counted(result.reviewers, "Reviewer")} ` +
    `in this workspace to stop; skipped ${counted(result.skipped, "agent")} (archived, or not running). ` +
    `Paseo cannot cancel an agent from a plugin, so each one stops itself once it reads the notice.`
  );
}

/**
 * `/bm-worker-stop-all`. The server picks the targets and sends the notices;
 * this only reports the counts it answers with.
 */
async function runWorkerStopAll(context: WorkspaceCommand): Promise<void> {
  const result = await context.rpc(agentsStopAllRpc, { workspaceId: context.workspace.id });
  // Paseo 0.8 gives a slash command no report channel: the only thing the
  // composer ever shows is a REJECTION, turned into an error toast. Reporting a
  // success that way would paint "Asked 2 Workers to stop" in the colour of a
  // failure. So the summary is posted to the Beads Manager surface, which draws
  // it as an ordinary notice. Staying silent is not an option either: the user
  // must learn the agents were ASKED, not killed (P4).
  launcherNotices.put(stopAllSummary(result));
  context.openSurface(LAUNCHER_SURFACE_ID);
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
 * cards (delta 20260916-chat-cards), registers the two slash commands of
 * delta 20260917e §4.4, and adds the "Beads" tab that Paseo lists in the "+"
 * menu of every workspace (delta 20260918e §4.1).
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
    client.addSlashCommand({
      name: "bm-worker-new",
      description: "Give Beads Manager a new request; it creates the Worker",
      argumentHint: "<what you want done>",
      context: "workspace",
      onSubmit: (context) => runWorkerNew(context),
    }),
    client.addSlashCommand({
      name: "bm-worker-stop-all",
      description: "Ask every running Beads Worker and Reviewer in this workspace to stop",
      argumentHint: "",
      context: "workspace",
      onSubmit: (context) => runWorkerStopAll(context),
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
    // Before "Beads agents", so it leads paseo-bm's entries in the "+" menu.
    // No `locations`: Paseo's default, ["workspace"], is the tab bar.
    client.addWorkspacePanel({
      id: BEADS_TAB_PANEL_ID,
      title: "Beads",
      icon: "ListChecks",
      context: "workspace",
      Component: BeadsTabPanel,
    }),
    // The same tab from a button on every workspace header: Paseo 0.8's mobile
    // app has no "+" menu (delta 20260918e §4.6).
    registerBeadsHeaderButtons(client),
    client.addWorkspacePanel({
      id: AGENT_TREE_PANEL_ID,
      title: "Beads agents",
      icon: AGENT_TREE_ICON,
      context: "workspace",
      Component: AgentTreePanel,
    }),
    // A pill per Worker waiting for the user's answer (delta 20260918d §4.8).
    registerWaitingPills(client),
  ];
  return () => {
    for (const remove of removers) void remove();
  };
}
