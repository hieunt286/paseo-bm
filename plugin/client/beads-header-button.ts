/**
 * The "Beads" button on every open workspace's header (delta 20260918e §4.6,
 * REQ-060 o; owner decision Q14 a).
 *
 * Paseo 0.8's mobile app has no "+" new-tab button, and its "…" Workspace
 * actions sheet has a fixed list that plugins cannot extend, so the Beads tab
 * (`bm-beads`) had no way in on a phone. The workspace header does draw plugin
 * header buttons on mobile (the first one inline), and a button can open a
 * panel. On desktop the same button is a shortcut next to "+".
 *
 * A header button belongs to ONE workspace, so one is added per open workspace
 * and removed when the workspace goes, following the list the way
 * `waiting-pills` follows its Workers: read now, every `BEADS_HEADER_POLL_MS`,
 * and whenever Paseo reports a workspace update. A failed read keeps the
 * buttons as they are.
 *
 * No JSX and no React Native: the button is data, and the test drives it with a
 * fake client.
 */
import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { BEADS_TAB_PANEL_ID } from "./dashboard-view";

/** One id for every workspace's button: Paseo keys a header button by id AND workspace. */
export const BEADS_HEADER_BUTTON_ID = "bm-beads-open";

/** How often the list of open workspaces is read again. */
export const BEADS_HEADER_POLL_MS = 15_000;

/** The button itself: an icon only, so it fits a phone's header. */
export function beadsHeaderButton(openTab: () => void): PluginButton {
  return {
    title: "Open the Beads tab: beads and metrics of this workspace",
    icon: "ListChecks",
    behavior: { kind: "action", onPress: openTab },
  };
}

/**
 * Which buttons to add and remove: one per open workspace. A workspace being
 * archived counts as gone, as it does in the Workspaces list.
 */
export function planHeaderButtons(
  shown: ReadonlySet<string>,
  listed: ReadonlyArray<{ id: string; archivingAt?: string | null }>,
): { add: string[]; remove: string[] } {
  const open = new Set(listed.filter((workspace) => !workspace.archivingAt).map((workspace) => workspace.id));
  return {
    add: [...open].filter((id) => !shown.has(id)),
    remove: [...shown].filter((id) => !open.has(id)),
  };
}

/** Starts the buttons; returns the cleanup that stops following and removes them all. */
export function registerBeadsHeaderButtons(client: PluginClientContext): () => void {
  const shown = new Map<string, PluginButtonRegistration>();
  let pending = false;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;

  // The workspace is a parameter, not a loop variable: the phone runs this
  // bundle on Hermes, where every closure made in a loop sees the loop's last
  // value, so each button would open the last workspace listed.
  const addButton = (workspaceId: string) =>
    client.addHeaderButton({
      id: BEADS_HEADER_BUTTON_ID,
      workspaceId,
      button: beadsHeaderButton(() => client.openPanel(BEADS_TAB_PANEL_ID, { workspaceId })),
    });

  const refresh = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const { entries } = await client.paseo.workspaces.list({});
      if (stopped) return;
      const plan = planHeaderButtons(new Set(shown.keys()), entries);
      for (const workspaceId of plan.remove) {
        shown.get(workspaceId)?.remove();
        shown.delete(workspaceId);
      }
      for (const workspaceId of plan.add) shown.set(workspaceId, addButton(workspaceId));
    } catch {
      // A failed read keeps the buttons as they are: better a button one
      // period late than buttons that flicker whenever the daemon is slow.
    } finally {
      pending = false;
    }
  };

  void refresh();
  try {
    // A newly opened workspace should not wait a whole period for its button.
    unsubscribe = client.paseo.workspaces.subscribe(() => void refresh());
  } catch {
    // No live updates on this host: the timer still follows the list.
  }
  const timer = setInterval(() => void refresh(), BEADS_HEADER_POLL_MS);
  // Node (tests) would otherwise stay alive for the timer; hosts without unref ignore this.
  (timer as { unref?: () => void }).unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe?.();
    for (const registration of shown.values()) registration.remove();
    shown.clear();
  };
}
