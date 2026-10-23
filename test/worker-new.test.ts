import { describe, expect, it } from "vitest";
import { followLineOf, workerNewNoticeOf } from "../plugin/client/worker-new";

/**
 * What `/bm-worker-new` tells the owner where they typed (field report
 * 2026-10-21): the Main that got the request, an action to open it, where the
 * new Worker appears, and that the Main's chat says the rest.
 */

const mission = { missionId: "mis-1", code: "INO", name: "Inbox overhaul" };
const FOLLOW = "If the Main gives it to a Worker already working, or cannot create the Worker, it says so in its chat. Open Main to follow it.";

describe("workerNewNoticeOf", () => {
  it("a Main whose Worker goes to the mission's worktree names that workspace", () => {
    expect(workerNewNoticeOf({ agentId: "main-1", mission: { ...mission, workerIn: "worktree", worktreeTitle: "INO · xspace-ai-assistant" } }, "wks-root")).toEqual({
      workspaceId: "wks-root",
      agentId: "main-1",
      openLabel: "Open Main",
      lines: ["Sent to Main INO · Inbox overhaul.", "The new Worker will appear in the workspace INO · xspace-ai-assistant, the mission's worktree.", FOLLOW],
    });
    expect(workerNewNoticeOf({ agentId: "main-1", mission: { ...mission, workerIn: "worktree", worktreeTitle: null } }, "wks-root").lines[1]).toBe("The new Worker will appear in the mission's worktree workspace.");
  });

  it("a mission waiting for its checkpoint works in this workspace, the shared checkout", () => {
    expect(workerNewNoticeOf({ agentId: "main-1", mission: { ...mission, workerIn: "shared-checkout", worktreeTitle: null } }, "wks-root").lines).toEqual([
      "Sent to Main INO · Inbox overhaul.",
      "The new Worker will appear in this workspace: the mission works in the shared checkout until its checkpoint is made.",
      FOLLOW,
    ]);
    expect(workerNewNoticeOf({ agentId: "main-1", mission: { ...mission, workerIn: "here", worktreeTitle: null } }, "wks-root").lines[1]).toBe("The new Worker will appear in this workspace.");
  });

  it("a Manager of no mission (or an older server's answer) is the Beads Manager, opened with Open Manager", () => {
    expect(workerNewNoticeOf({ agentId: "mgr-1" }, "wks-home")).toEqual({
      workspaceId: "wks-home",
      agentId: "mgr-1",
      openLabel: "Open Manager",
      lines: ["Sent to Beads Manager.", "The new Worker will appear in this workspace.", followLineOf("Manager")],
    });
    expect(followLineOf("Manager")).toBe("If the Manager gives it to a Worker already working, or cannot create the Worker, it says so in its chat. Open Manager to follow it.");
  });
});
