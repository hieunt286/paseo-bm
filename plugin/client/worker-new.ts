/**
 * What `/bm-worker-new` tells the owner, in the workspace where they typed
 * (owner field report 2026-10-21: the request went to a Main in another
 * workspace and nothing showed where they typed).
 *
 * A slash command has no report channel of its own (`surface-view.ts`
 * `launcherNotices`), so the command puts one notice here and opens the
 * workspace's Beads tab (`beads-tab.tsx`), which draws it above the project
 * page with an "Open Main" action (the panel's `navigation.openAgent`).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { z } from "zod";
import type { managerEnsureRpc } from "../shared/contracts";
import { createSlot, type Slot } from "./slot";

type EnsureOutput = z.infer<typeof managerEnsureRpc.output>;

/** One `/bm-worker-new` result, for the workspace it was typed in. */
export interface WorkerNewNotice {
  workspaceId: string;
  /** The Main (or Manager) the request went to. */
  agentId: string;
  lines: string[];
  /** The action's label: "Open Main", or "Open Manager" for a Manager of no mission. */
  openLabel: string;
}

/** The last line: what the Worker's creation may still say, in the agent's chat. Pure. */
export const followLineOf = (agent: "Main" | "Manager"): string =>
  `If the ${agent} gives it to a Worker already working, or cannot create the Worker, it says so in its chat. Open ${agent} to follow it.`;

/** The notice of a request sent to the agent `manager.ensure` answered for `workspaceId`. Pure. */
export function workerNewNoticeOf(ensured: Pick<EnsureOutput, "agentId" | "mission">, workspaceId: string): WorkerNewNotice {
  const mission = ensured.mission;
  if (mission === undefined) {
    return {
      workspaceId,
      agentId: ensured.agentId,
      lines: ["Sent to Beads Manager.", "The new Worker will appear in this workspace.", followLineOf("Manager")],
      openLabel: "Open Manager",
    };
  }
  const where =
    mission.workerIn === "shared-checkout"
      ? "The new Worker will appear in this workspace: the mission works in the shared checkout until its checkpoint is made."
      : mission.workerIn === "worktree"
        ? mission.worktreeTitle === null
          ? "The new Worker will appear in the mission's worktree workspace."
          : `The new Worker will appear in the workspace ${mission.worktreeTitle}, the mission's worktree.`
        : "The new Worker will appear in this workspace.";
  return { workspaceId, agentId: ensured.agentId, lines: [`Sent to Main ${mission.code} · ${mission.name}.`, where, followLineOf("Main")], openLabel: "Open Main" };
}

/** The newest `/bm-worker-new` notice; the Beads tab of its workspace draws it until dismissed. */
export const workerNewNotices: Slot<WorkerNewNotice> = createSlot<WorkerNewNotice>();
