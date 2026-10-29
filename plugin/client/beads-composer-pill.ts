/**
 * The "Beads" pill above the composer of every paseo-bm agent's chat (owner
 * decision 2026-10-25): the way into the Beads tab on a phone.
 *
 * Paseo 0.12's mobile workspace header (`CompactWorkspaceHeader`) draws no
 * plugin header buttons, so the header "Beads" button
 * (`beads-header-button.ts`) shows only on desktop. A composer pill is drawn
 * on both, above the composer of the agent it belongs to, and opens the Beads
 * tab of that agent's workspace.
 *
 * A pill belongs to ONE agent, so one is added per live bm-* agent (a
 * provider `bm-…`, not archived) and removed when the agent goes or moves,
 * following the list: read now, every `BEADS_PILL_POLL_MS`, and whenever
 * Paseo reports an agent update. A failed read keeps the pills as they are. A
 * host without composer pills gets none.
 *
 * No JSX and no React Native: the pill is data, and the test drives it with a
 * fake client.
 */
import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { BEADS_TAB_PANEL_ID } from "./surface-view";

/** One id for every agent's pill: Paseo keys a composer pill by id, workspace AND agent. */
export const BEADS_COMPOSER_PILL_ID = "bm-beads-pill";

/** How often the list of agents is read again. */
export const BEADS_PILL_POLL_MS = 15_000;

/** The pill itself: the Beads tab's icon and its name. */
export function beadsComposerPill(openTab: () => void): PluginButton {
  return {
    title: "Open the Beads tab: this workspace's requests, beads and agents",
    label: "Beads",
    icon: "ListChecks",
    behavior: { kind: "action", onPress: openTab },
  };
}

/** An agent as Paseo's agent list gives it. */
export interface ListedAgent {
  agent?: { id?: string; provider?: string; workspaceId?: string | null; archivedAt?: string | null } | null;
}

/** A pill's key: the agent in its workspace, so an agent that moves gets a new pill. */
const keyOf = (agentId: string, workspaceId: string): string => `${agentId}@${workspaceId}`;

/**
 * Which pills to add and remove: one per live bm-* agent in a workspace. An
 * archived agent, another plugin's or the owner's own agent, or one with no
 * workspace has none.
 */
export function planComposerPills(
  shown: ReadonlySet<string>,
  listed: readonly ListedAgent[],
): { add: Array<{ key: string; agentId: string; workspaceId: string }>; remove: string[] } {
  const wanted = new Map<string, { key: string; agentId: string; workspaceId: string }>();
  for (const entry of listed) {
    const agent = entry.agent;
    if (!agent?.id || !agent.workspaceId || agent.archivedAt || !agent.provider?.startsWith("bm-")) continue;
    const key = keyOf(agent.id, agent.workspaceId);
    wanted.set(key, { key, agentId: agent.id, workspaceId: agent.workspaceId });
  }
  return {
    add: [...wanted.values()].filter((pill) => !shown.has(pill.key)),
    remove: [...shown].filter((key) => !wanted.has(key)),
  };
}

/** The slice of the client the pills use; `addComposerPill` is absent before Paseo had pills. */
type PillClient = Pick<PluginClientContext, "openPanel"> & {
  addComposerPill?: PluginClientContext["addComposerPill"];
  paseo: {
    agents: {
      list(input: Record<string, never>): Promise<{ entries: readonly ListedAgent[] }>;
      subscribe?: (listener: () => void) => () => void;
    };
  };
};

/** Starts the pills; returns the cleanup that stops following and removes them all. */
export function registerBeadsComposerPills(client: PluginClientContext): () => void {
  const host = client as unknown as PillClient;
  if (typeof host.addComposerPill !== "function") return () => {};
  const shown = new Map<string, PluginButtonRegistration>();
  let pending = false;
  let stopped = false;
  let unsubscribe: (() => void) | undefined;

  // The agent and workspace are parameters, not loop variables: the phone runs
  // this bundle on Hermes, where every closure made in a loop sees the loop's
  // last value, so each pill would open the last workspace listed.
  const addPill = (agentId: string, workspaceId: string) =>
    host.addComposerPill!({
      id: BEADS_COMPOSER_PILL_ID,
      workspaceId,
      agentId,
      button: beadsComposerPill(() => host.openPanel(BEADS_TAB_PANEL_ID, { workspaceId })),
    });

  const refresh = async () => {
    if (pending || stopped) return;
    pending = true;
    try {
      const { entries } = await host.paseo.agents.list({});
      if (stopped) return;
      const plan = planComposerPills(new Set(shown.keys()), entries);
      for (const key of plan.remove) {
        shown.get(key)?.remove();
        shown.delete(key);
      }
      for (const pill of plan.add) shown.set(pill.key, addPill(pill.agentId, pill.workspaceId));
    } catch {
      // A failed read keeps the pills as they are: better a pill one period
      // late than pills that flicker whenever the daemon is slow.
    } finally {
      pending = false;
    }
  };

  void refresh();
  try {
    // A newly created Worker should not wait a whole period for its pill.
    unsubscribe = host.paseo.agents.subscribe?.(() => void refresh());
  } catch {
    // No live updates on this host: the timer still follows the list.
  }
  const timer = setInterval(() => void refresh(), BEADS_PILL_POLL_MS);
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
