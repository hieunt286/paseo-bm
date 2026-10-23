import { beforeEach, describe, expect, it } from "vitest";

/**
 * The client entry pulls in the whole surface tree, which imports `react-native`
 * — Flow source that neither Vite nor Node can parse. Nothing here renders, so
 * the components only have to exist; the stub vitest.config.ts aliases it to
 * (test/stubs/react-native.ts) is enough to let the entry load and register its
 * contributions.
 */

import type { PluginClientContext } from "@getpaseo/plugin/client";
import { LAUNCHER_SURFACE_ID, launchRequests } from "../plugin/client/launch-manager";
import { BEADS_TAB_PANEL_ID, launcherNotices } from "../plugin/client/surface-view";
import { workerNewNotices } from "../plugin/client/worker-new";
import { NEW_REQUEST_MARKER, stripNewRequestMarker } from "../plugin/shared/new-request";
import { agentsStopAllRpc, managerEnsureRpc } from "../plugin/shared/contracts";

type Contribute = (client: PluginClientContext) => () => void;

/**
 * The entry is `.tsx`, and the repository's root `tsconfig.json` — the one that
 * typechecks `test/` — deliberately has no `jsx` setting (only
 * `plugin/tsconfig.json` does). A static import would fail `npm run typecheck`
 * with TS6142, so the specifier is assembled at run time: Vitest resolves it,
 * TypeScript does not have to.
 */
async function loadEntry(): Promise<Contribute> {
  const entry: { default: Contribute } = await import(["..", "plugin", "index.client"].join("/"));
  return entry.default;
}

/**
 * `/bm-worker-new` and `/bm-worker-stop-all` (delta 20260917e §4.4, bead
 * bm-wp-240-ls42.3), driven through the real `contribute()` registration with a
 * fake client — the same shape `plugin-bundle-cjs.test.ts` uses for the server.
 *
 * What these lock down, and why each one matters:
 * - the Manager reads the request VERBATIM: it is what the user is quoted back
 *   and what lands in the trace store;
 * - `manager.ensure` runs ONCE per command, because a second concurrent ensure
 *   is how a workspace ends up with two Managers;
 * - empty args send NOTHING: an empty message forces the Manager to invent a
 *   request, which its own rules forbid;
 * - the stop report says the agents were ASKED (verified fact P4). Paseo gives
 *   a plugin no agent cancel, so "stopped" would be a lie.
 */

interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  context: string;
  onSubmit(input: unknown): void | Promise<void>;
}

/** Records what the entry contributes; only the slash commands are read back. */
function fakeClient() {
  const slashCommands: SlashCommand[] = [];
  const ignore = () => () => {};
  const client = {
    addSurface: ignore,
    addSidebarItem: ignore,
    addCommandCenterItem: ignore,
    addSettingsScreen: ignore,
    addWorkspacePanel: ignore,
    addTimelineTransformer: ignore,
    addTimelineRenderer: ignore,
    addSlashCommand(contribution: SlashCommand) {
      slashCommands.push(contribution);
      return () => {};
    },
  };
  return { client: client as unknown as PluginClientContext, slashCommands };
}

async function commands(): Promise<Map<string, SlashCommand>> {
  const { client, slashCommands } = fakeClient();
  (await loadEntry())(client);
  return new Map(slashCommands.map((command) => [command.name, command]));
}

interface ContextOptions {
  ensure?: { agentId: string; created: boolean; otherManagerIds: string[]; mission?: { missionId: string; code: string; name: string; workerIn: string; worktreeTitle: string | null } };
  stopAll?: { workers: number; reviewers: number; skipped: number };
}

/**
 * A workspace slash-command context with exactly the capabilities Paseo 0.8
 * gives one (`createPluginWorkspaceActionContext`): `paseo`, `rpc`,
 * `openSurface`, `openSettings`, `openPanel`, `workspace` — and no way to open
 * an agent, which is why opening the Manager goes through the surface.
 */
function commandContext(args: string, options: ContextOptions = {}) {
  const rpcCalls: Array<{ name: string; input: unknown }> = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const openedSurfaces: string[] = [];
  const openedPanels: string[] = [];
  const context = {
    context: "workspace" as const,
    args,
    workspace: { id: "ws-1" },
    rpc: async (contract: { name: string }, input: unknown) => {
      rpcCalls.push({ name: contract.name, input });
      if (contract.name === managerEnsureRpc.name) {
        return options.ensure ?? { agentId: "agent-manager-1", created: false, otherManagerIds: [] };
      }
      if (contract.name === agentsStopAllRpc.name) {
        return options.stopAll ?? { workers: 0, reviewers: 0, skipped: 0 };
      }
      throw new Error(`unexpected RPC: ${contract.name}`);
    },
    paseo: {
      agents: {
        ref: (agentId: string) => ({
          send: async (text: string) => {
            sent.push({ agentId, text });
          },
        }),
      },
    },
    openSurface: (id: string) => {
      openedSurfaces.push(id);
    },
    openSettings: () => {},
    openPanel: (id: string) => {
      openedPanels.push(id);
    },
  };
  return { context, rpcCalls, sent, openedSurfaces, openedPanels };
}

/**
 * The message `/bm-worker-stop-all` reports; fails if the command stays silent.
 *
 * A slash command has no report channel of its own — the composer only ever
 * shows a REJECTION, as an error toast. Painting a success in the colour of a
 * failure would be a lie about what happened, so the command posts to
 * `launcherNotices` and opens the Beads Manager surface, which draws the line
 * as an ordinary notice. A throw here would now be a real failure.
 */
async function reportOf(command: SlashCommand, context: unknown): Promise<string> {
  launcherNotices.take();
  await command.onSubmit(context);
  const posted = launcherNotices.take();
  if (posted === null) throw new Error("the command reported nothing back to the user");
  return posted;
}

beforeEach(() => {
  // `launchRequests` is one queue per loaded bundle, so a leftover from an
  // earlier test would make the next one pass for the wrong reason.
  launchRequests.take();
  workerNewNotices.take();
});

describe("slash command registration", () => {
  it("contributes both commands, in the workspace context, with help text", async () => {
    const registered = await commands();
    expect([...registered.keys()].sort()).toEqual(["bm-worker-new", "bm-worker-stop-all"]);
    for (const command of registered.values()) {
      // Paseo refuses a command with an empty description or another context.
      expect(command.context).toBe("workspace");
      expect(command.description.trim()).not.toBe("");
      expect(typeof command.onSubmit).toBe("function");
    }
    // The command that takes a request says so; the one that takes none says none.
    expect(registered.get("bm-worker-new")!.argumentHint.trim()).not.toBe("");
    expect(registered.get("bm-worker-stop-all")!.argumentHint).toBe("");
  });
});

describe("/bm-worker-new", () => {
  it("ensures the Manager exactly once and sends it exactly what was typed", async () => {
    const { context, rpcCalls, sent, openedSurfaces, openedPanels } = commandContext("x", {
      ensure: { agentId: "agent-manager-7", created: true, otherManagerIds: [] },
    });

    await (await commands()).get("bm-worker-new")!.onSubmit(context);

    // `forNewRequest`: the answer also names the Main's mission and where the Worker appears.
    expect(rpcCalls).toEqual([{ name: managerEnsureRpc.name, input: { workspaceId: "ws-1", forNewRequest: true } }]);
    // Exactly one message, to the Manager that `manager.ensure` named. Its
    // first line is the plugin's flag saying this is NEW work -- without it the
    // Manager folds the words into whatever Worker is already busy, which is
    // what the owner hit (delta 20260917f). Everything after the flag is the
    // user's text, untouched.
    expect(sent).toEqual([{ agentId: "agent-manager-7", text: `${NEW_REQUEST_MARKER}\nx` }]);
    expect(stripNewRequestMarker(sent[0]!.text)).toBe("x");
    // Field report 2026-10-21: the owner reads where it went in THIS workspace — its Beads tab opens
    // with the notice and an action to open the agent; nothing navigates away.
    expect(openedPanels).toEqual([BEADS_TAB_PANEL_ID]);
    expect(openedSurfaces).toEqual([]);
    expect(launchRequests.take()).toBeNull();
    expect(workerNewNotices.peek()).toMatchObject({ workspaceId: "ws-1", agentId: "agent-manager-7", openLabel: "Open Manager" });
  });

  it("names the Main that got it, with Open Main, and where the new Worker appears", async () => {
    const { context, openedPanels } = commandContext("Fix the header.", {
      ensure: {
        agentId: "agent-main-ino",
        created: false,
        otherManagerIds: [],
        mission: { missionId: "mis-1", code: "INO", name: "Inbox overhaul", workerIn: "worktree", worktreeTitle: "INO · xspace-ai-assistant" },
      },
    });

    await (await commands()).get("bm-worker-new")!.onSubmit(context);

    expect(openedPanels).toEqual([BEADS_TAB_PANEL_ID]);
    expect(workerNewNotices.peek()).toEqual({
      workspaceId: "ws-1",
      agentId: "agent-main-ino",
      openLabel: "Open Main",
      lines: [
        "Sent to Main INO · Inbox overhaul.",
        "The new Worker will appear in the workspace INO · xspace-ai-assistant, the mission's worktree.",
        "If the Main gives it to a Worker already working, or cannot create the Worker, it says so in its chat. Open Main to follow it.",
      ],
    });
  });

  it("sends the request verbatim after the BM-NEW-REQUEST line: not reworded or truncated", async () => {
    const request = "Fix the login bug: 5 wrong passwords should lock the account for 15m.";
    const { context, sent } = commandContext(request);

    await (await commands()).get("bm-worker-new")!.onSubmit(context);

    expect(sent).toHaveLength(1);
    // The flag is the plugin's line; the request itself must survive byte for byte.
    expect(sent[0]!.text).toBe(`${NEW_REQUEST_MARKER}\n${request}`);
    expect(stripNewRequestMarker(sent[0]!.text)).toBe(request);
  });

  it.each([
    ["no args", ""],
    ["whitespace only", "   "],
  ])("sends nothing for %s, and still opens the Manager's chat", async (_name, args) => {
    const { context, sent, openedSurfaces, openedPanels } = commandContext(args);

    await (await commands()).get("bm-worker-new")!.onSubmit(context);

    expect(sent).toEqual([]);
    expect(openedSurfaces).toEqual([LAUNCHER_SURFACE_ID]);
    expect(launchRequests.take()).toBe("ws-1");
    // Nothing was sent, so there is nothing to report.
    expect(openedPanels).toEqual([]);
    expect(workerNewNotices.peek()).toBeNull();
  });
});

describe("/bm-worker-stop-all", () => {
  it("asks this workspace's agents to stop and reports the three counts", async () => {
    const { context, rpcCalls, sent, openedSurfaces } = commandContext("", {
      stopAll: { workers: 2, reviewers: 1, skipped: 3 },
    });

    const report = await reportOf((await commands()).get("bm-worker-stop-all")!, context);

    expect(rpcCalls).toEqual([{ name: agentsStopAllRpc.name, input: { workspaceId: "ws-1" } }]);
    expect(report).toContain("2 Workers");
    expect(report).toContain("1 Reviewer ");
    expect(report).toContain("3 agents");
    // P4: the plugin asked, it did not stop anything. No wording may claim more.
    expect(report).toMatch(/^Asked /);
    expect(report).not.toMatch(/stopped/i);
    expect(report).toMatch(/cannot cancel an agent/i);
    // The Manager is the user's own thread and is never touched by this command:
    // nothing is sent to any agent, and no agent is queued to be opened.
    expect(sent).toEqual([]);
    expect(launchRequests.take()).toBeNull();
    // Opening the SCREEN is not touching an agent — it is where the report is
    // drawn, because a slash command's only other channel is an error toast.
    expect(openedSurfaces).toEqual([LAUNCHER_SURFACE_ID]);
  });

  it("counts singular and zero without inventing plurals", async () => {
    const { context } = commandContext("", { stopAll: { workers: 1, reviewers: 0, skipped: 0 } });

    const report = await reportOf((await commands()).get("bm-worker-stop-all")!, context);

    expect(report).toContain("1 Worker ");
    expect(report).toContain("0 Reviewers");
    expect(report).toContain("0 agents");
    expect(report).not.toMatch(/stopped/i);
  });
});
