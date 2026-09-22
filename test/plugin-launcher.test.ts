import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagerAgentHandle, ManagerAgentSnapshot, ManagerPaseo } from "../plugin/server/manager";
import serverContribute from "../plugin/index.server";
import { managerEnsureRpc } from "../plugin/shared/contracts";
import { createSlot } from "../plugin/client/slot";
import {
  LAUNCHER_ICON,
  LAUNCHER_SURFACE_ID,
  createManagerLauncher,
  OLD_HOST_WARNING,
  describeLauncherState,
  errorCodeOf,
  launcherStatusLines,
  launchRequests,
  launcherStyles,
  runPendingRequest,
  selectFromCommandCenter,
  type EnsureManagerOutput,
} from "../plugin/client/launch-manager";
import { toneColor } from "../plugin/client/dashboard-model";

// manager.ensure resolves the install home from $HOME when Paseo's config names
// no plugin path (the instructions, and the fallback incidents of delta
// 20260921 §4.5.2); point it at an empty directory so this machine's real
// ~/.paseo-bm never leaks into the test.
const realHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "bm-isolated-home-"));
beforeAll(() => {
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

/**
 * WP-113 launcher: sidebar item + Command Center item -> `manager.ensure` -> open agent.
 *
 * The repo has no React Native renderer, so the surface component is never
 * rendered and `react-native` is replaced by inert stand-ins when the client
 * entry is loaded. What IS exercised for real: the client entry's registrations,
 * the Command Center hand-off, the launch controller (pending guard, errors,
 * other-Managers notice), the real handler registered by `index.server.ts`
 * running `ensureManager` against a fake Paseo SDK, and the pure style and
 * notice functions the surface renders from. Wide/compact layout and theme
 * switching on a real Paseo client stay a manual check (WP-117 / WP-120).
 */

vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Pressable: () => null,
  ScrollView: () => null,
  Text: () => null,
  View: () => null,
}));

// The root tsconfig has no `jsx` setting, so the .tsx entries are loaded through
// a non-literal specifier that `tsc --noEmit` does not resolve.
type ClientEntry = (client: unknown) => () => void;
const clientEntryPath = "../plugin/index.client.tsx";
const surfacePath = "../plugin/client/launcher.tsx";
const beadsTabPath = "../plugin/client/beads-tab.tsx";
const { default: clientContribute } = (await import(clientEntryPath)) as { default: ClientEntry };
const { ManagerLauncherSurface } = (await import(surfacePath)) as { ManagerLauncherSurface: unknown };
const { BeadsTabPanel } = (await import(beadsTabPath)) as { BeadsTabPanel: unknown };

const WS = "ws-1";

// --- fake Paseo SDK behind the real server handler --------------------------

function fakePaseo(initial: ManagerAgentSnapshot[] = []) {
  const store = [...initial];
  let creates = 0;
  const paseo: ManagerPaseo = {
    agents: {
      async list({ filter }) {
        const entries = store
          .filter(
            (a) =>
              Object.entries(filter.labels ?? {}).every(([k, v]) => a.labels[k] === v) &&
              (filter.includeArchived || !a.archivedAt),
          )
          .map((agent) => ({ agent: { ...agent } }));
        return { entries, pageInfo: { hasMore: false, nextCursor: null } };
      },
    },
    workspaces: {
      ref(workspaceId) {
        return {
          agents: {
            async create(options) {
              creates += 1;
              const snapshot: ManagerAgentSnapshot = {
                id: `created-${creates}`,
                workspaceId,
                createdAt: new Date(Date.UTC(2026, 8, 15, 12, creates)).toISOString(),
                status: "idle",
                labels: { ...(options.labels ?? {}) },
                archivedAt: null,
              };
              store.push(snapshot);
              const handle: ManagerAgentHandle = {
                id: snapshot.id,
                current: () => ({ ...snapshot }),
                archive: async () => ({}),
              };
              return handle;
            },
          },
        };
      },
    },
    config: {
      async get() {
        return {
          config: { agentProfiles: [{ id: "bm-manager", provider: "bm-manager", model: "m" }] },
        };
      },
    },
  };
  return { paseo, store, creates: () => creates };
}

type EnsureHandler = (input: unknown, ctx: { paseo: ManagerPaseo }) => Promise<unknown>;

/** Client-side `rpc` wired to the handler `index.server.ts` really registers. */
function wiredEnsure(paseo: ManagerPaseo) {
  const handle = vi.fn();
  serverContribute({ handle, registerSettings: vi.fn() } as unknown as Parameters<typeof serverContribute>[0]);
  const registration = handle.mock.calls.find(([contract]) => contract === managerEnsureRpc);
  if (!registration) throw new Error("manager.ensure is not registered");
  const handler = registration[1] as EnsureHandler;
  return vi.fn(async (input: { workspaceId: string }): Promise<EnsureManagerOutput> => {
    const output = await handler(managerEnsureRpc.input.parse(input), { paseo });
    return managerEnsureRpc.output.parse(output);
  });
}

// --- fake client context -----------------------------------------------------

interface CommandItem {
  id: string;
  title: string;
  icon: string;
  context: string;
  onSelect: (ctx: unknown) => void | Promise<void>;
}

function fakeClient() {
  const removed: string[] = [];
  const surfaces = new Map<string, unknown>();
  const sidebarItems: Array<{ id: string; title: string; icon: string; surface: string }> = [];
  const commandItems: CommandItem[] = [];
  const settingsScreens: Array<{ id: string }> = [];
  const panels: Array<{ id: string; title: string; icon: string; context: string; locations?: unknown; Component: unknown }> = [];
  const transformers: Array<{ id: string; query: { itemType: string }; transform: (input: { item: unknown; phase: string }) => unknown }> = [];
  const renderers: Array<{ kind: string; version: number }> = [];
  const client = {
    addSurface: (id: string, Component: unknown) => {
      surfaces.set(id, Component);
      return () => removed.push(`surface:${id}`);
    },
    addSidebarItem: (item: (typeof sidebarItems)[number]) => {
      sidebarItems.push(item);
      return () => removed.push(`sidebar:${item.id}`);
    },
    addCommandCenterItem: (item: CommandItem) => {
      commandItems.push(item);
      return () => removed.push(`command:${item.id}`);
    },
    // The agent-tree panel bead registers a workspace panel from the same entry.
    addWorkspacePanel: (item: (typeof panels)[number]) => {
      panels.push(item);
      return () => removed.push(`panel:${item.id}`);
    },
    // WP-240 adds /bm-worker-new and /bm-worker-stop-all from the same entry.
    addSlashCommand: (item: { name: string }) => () => removed.push(`slash:${item.name}`),
    // WP-211 adds the Dashboard settings screen from the same entry.
    addSettingsScreen: (item: { id: string }) => {
      settingsScreens.push(item);
      return () => removed.push(`settings:${item.id}`);
    },
    // The chat cards (delta 20260916-chat-cards).
    addTimelineTransformer: (item: (typeof transformers)[number]) => {
      transformers.push(item);
      return () => removed.push(`transformer:${item.id}`);
    },
    addTimelineRenderer: (item: (typeof renderers)[number]) => {
      renderers.push(item);
      return () => removed.push(`renderer:${item.kind}`);
    },
  };
  return { client, surfaces, sidebarItems, commandItems, settingsScreens, panels, transformers, renderers, removed };
}

const theme = {
  colors: {
    surface0: "#s0",
    surface1: "#s1",
    surface2: "#s2",
    border: "#border",
    foreground: "#fg",
    foregroundMuted: "#fgm",
    accent: "#accent",
    accentForeground: "#accentfg",
    statusSuccess: "#ok",
    statusWarning: "#warn",
    statusDanger: "#danger",
  },
};

// -----------------------------------------------------------------------------

describe("client entry registrations", () => {
  it("registers the chat cards: two transformers and one renderer that agree on kind and version", () => {
    const fake = fakeClient();
    clientContribute(fake.client);
    expect(fake.transformers.map((entry) => [entry.id, entry.query.itemType])).toEqual([
      ["bm-chat-received", "user_message"],
      ["bm-chat-sent", "assistant_message"],
    ]);
    expect(fake.renderers).toMatchObject([{ kind: "bm-message", version: 1 }]);
    const report = { type: "user_message", text: "BM-REPORT\nrequestId: req-20260916T062244Z\nphase: finished" };
    expect(fake.transformers[0]!.transform({ item: report, phase: "complete" })).toMatchObject({
      items: [{ type: "plugin", kind: "bm-message", version: 1, data: { type: "report", phase: "finished" } }],
    });
    expect(fake.transformers[1]!.transform({ item: { type: "assistant_message", text: "hello" }, phase: "complete" })).toBeUndefined();
  });

  it("registers the surface, a sidebar item pointing at it, and a workspace Command Center item", () => {
    const fake = fakeClient();
    const cleanup = clientContribute(fake.client);

    expect(fake.surfaces.get(LAUNCHER_SURFACE_ID)).toBe(ManagerLauncherSurface);
    expect(fake.sidebarItems).toEqual([
      { id: LAUNCHER_SURFACE_ID, title: "Beads Manager", icon: "Bot", surface: LAUNCHER_SURFACE_ID },
    ]);
    // Two now: "Open Beads Manager" (WP-113) and "Open Beads Metric" (WP-211).
    expect(fake.commandItems).toHaveLength(2);
    expect(fake.commandItems.map((item) => item.id)).toEqual([
      "open-beads-manager",
      "open-beads-dashboard",
    ]);
    expect(fake.settingsScreens.map((screen) => screen.id)).toEqual(["paseo-bm-settings"]);
    expect(fake.commandItems[0]).toMatchObject({
      id: "open-beads-manager",
      title: "Open Beads Manager",
      icon: "Bot",
      context: "workspace",
    });
    expect(LAUNCHER_ICON).toBe("Bot");

    cleanup();
    expect(fake.removed.sort()).toEqual(
      [
        `surface:${LAUNCHER_SURFACE_ID}`,
        `sidebar:${LAUNCHER_SURFACE_ID}`,
        "command:open-beads-manager",
        "command:open-beads-dashboard",
        "slash:bm-worker-new",
        "slash:bm-worker-stop-all",
        "settings:paseo-bm-settings",
        "panel:bm-beads",
        "panel:beads-agents",
        "panel:bm-chat-beads",
        "transformer:bm-chat-received",
        "transformer:bm-chat-sent",
        "renderer:bm-message",
      ].sort(),
    );
  });

  it("adds one \"Beads\" tab to the workspace + menu, ahead of \"Beads agents\" (delta 20260918e)", () => {
    const fake = fakeClient();
    clientContribute(fake.client);

    const tabs = fake.panels.filter((panel) => panel.id === "bm-beads");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toEqual({ id: "bm-beads", title: "Beads", icon: "ListChecks", context: "workspace", Component: BeadsTabPanel });
    // No `locations`: Paseo's default, ["workspace"], puts it in the "+" menu.
    expect("locations" in tabs[0]!).toBe(false);
    const ids = fake.panels.map((panel) => panel.id);
    expect(ids.indexOf("bm-beads")).toBeLessThan(ids.indexOf("beads-agents"));
  });

  it("the registered Command Center item queues its workspace and opens the launcher surface", async () => {
    const fake = fakeClient();
    clientContribute(fake.client);
    const openSurface = vi.fn();

    await fake.commandItems[0]!.onSelect({ context: "workspace", workspace: { id: "ws-cc" }, openSurface });

    expect(openSurface).toHaveBeenCalledWith(LAUNCHER_SURFACE_ID);
    expect(launchRequests.take()).toBe("ws-cc");
  });
});

describe("full path: select -> manager.ensure (real handler) -> open agent", () => {
  it("Command Center: opens the created Manager; a second selection reopens it without creating another (REQ-020b)", async () => {
    const sdk = fakePaseo();
    const ensure = wiredEnsure(sdk.paseo);
    const opened: string[] = [];
    const openAgent = (input: { agentId: string }) => {
      opened.push(input.agentId);
    };
    const requests = createSlot<string>();
    const launcher = createManagerLauncher();
    const openSurface = vi.fn();
    const select = () => selectFromCommandCenter({ workspace: { id: WS }, openSurface }, requests);

    select();
    expect(openSurface).toHaveBeenCalledWith(LAUNCHER_SURFACE_ID);
    expect(await runPendingRequest(requests, launcher, { ensure, openAgent })).toBe("opened");
    expect(ensure).toHaveBeenLastCalledWith({ workspaceId: WS });
    expect(opened).toEqual(["created-1"]);
    expect(launcher.getState()).toMatchObject({ status: "opened", agentId: "created-1", created: true });

    select();
    expect(await runPendingRequest(requests, launcher, { ensure, openAgent })).toBe("opened");
    expect(opened).toEqual(["created-1", "created-1"]);
    expect(sdk.creates()).toBe(1);
    expect(launcher.getState()).toMatchObject({ status: "opened", agentId: "created-1", created: false });
  });

  it("sidebar surface button: first press creates, second press reopens the same Manager", async () => {
    const sdk = fakePaseo();
    const ensure = wiredEnsure(sdk.paseo);
    const opened: string[] = [];
    const launcher = createManagerLauncher();
    const deps = {
      ensure,
      openAgent: (input: { agentId: string }) => {
        opened.push(input.agentId);
      },
    };

    expect(await launcher.launch(WS, deps)).toBe("opened");
    expect(await launcher.launch(WS, deps)).toBe("opened");

    expect(opened).toEqual(["created-1", "created-1"]);
    expect(sdk.creates()).toBe(1);
    expect(sdk.store.filter((a) => a.labels["bm.role"] === "manager")).toHaveLength(1);
  });

  it("does not run a queued request on a host without navigation.openAgent", async () => {
    const requests = createSlot<string>();
    const ensure = vi.fn();
    requests.put(WS);
    expect(await runPendingRequest(requests, createManagerLauncher(), { ensure })).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("pending and error states", () => {
  it("blocks repeated presses while manager.ensure is in flight", async () => {
    let resolve!: (value: EnsureManagerOutput) => void;
    const ensure = vi.fn(() => new Promise<EnsureManagerOutput>((r) => (resolve = r)));
    const openAgent = vi.fn();
    const launcher = createManagerLauncher();
    const seen: string[] = [];
    launcher.subscribe(() => seen.push(launcher.getState().status));

    const first = launcher.launch(WS, { ensure, openAgent });
    expect(launcher.getState()).toEqual({ status: "pending", workspaceId: WS });
    expect(describeLauncherState(launcher.getState())).toEqual([
      { tone: "muted", text: "Opening Beads Manager…" },
    ]);
    expect(await launcher.launch(WS, { ensure, openAgent })).toBe("busy");
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(openAgent).not.toHaveBeenCalled();

    resolve({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice: null });
    expect(await first).toBe("opened");
    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["pending", "opened"]);
  });

  it("keeps a request that arrives while a launch is pending, and runs it once that launch ends (delta 20260918f F2)", async () => {
    let resolve!: (value: EnsureManagerOutput) => void;
    const ensure = vi.fn(
      (input: { workspaceId: string }) =>
        input.workspaceId === WS
          ? new Promise<EnsureManagerOutput>((r) => (resolve = r))
          : Promise.resolve({ agentId: "mgr-2", created: false, otherManagerIds: [], modeNotice: null }),
    );
    const openAgent = vi.fn();
    const launcher = createManagerLauncher();
    const requests = createSlot<string>();

    const first = launcher.launch(WS, { ensure, openAgent });
    requests.put("ws-2");
    // Pending: the request must stay queued, not be taken and answered "busy".
    expect(await runPendingRequest(requests, launcher, { ensure, openAgent })).toBeNull();
    expect(requests.peek()).toBe("ws-2");

    resolve({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice: null });
    expect(await first).toBe("opened");
    expect(await runPendingRequest(requests, launcher, { ensure, openAgent })).toBe("opened");
    expect(ensure).toHaveBeenLastCalledWith({ workspaceId: "ws-2" });
    expect(openAgent).toHaveBeenLastCalledWith({ agentId: "mgr-2" });
    expect(requests.peek()).toBeNull();
  });

  it("shows the server's error code and opens nothing when manager.ensure fails", async () => {
    const sdk = fakePaseo();
    sdk.paseo.config.get = async () => ({ config: { agentProfiles: [] } });
    const ensure = wiredEnsure(sdk.paseo);
    const openAgent = vi.fn();
    const launcher = createManagerLauncher();

    expect(await launcher.launch(WS, { ensure, openAgent })).toBe("error");

    expect(openAgent).not.toHaveBeenCalled();
    const state = launcher.getState();
    expect(state).toMatchObject({ status: "error", code: "E_PROVIDER_UNAVAILABLE" });
    const [notice] = describeLauncherState(state);
    expect(notice!.tone).toBe("danger");
    expect(notice!.text).toMatch(/^Could not open Beads Manager \(E_PROVIDER_UNAVAILABLE\)\. /);

    // Pressing again after an error is allowed.
    sdk.paseo.config.get = async () => ({
      config: { agentProfiles: [{ id: "bm-manager", provider: "bm-manager" }] },
    });
    expect(await launcher.launch(WS, { ensure, openAgent })).toBe("opened");
  });

  it("falls back to the plain message when the error carries no code", async () => {
    const launcher = createManagerLauncher();
    await launcher.launch(WS, {
      ensure: async () => {
        throw new Error("connection lost");
      },
      openAgent: vi.fn(),
    });
    expect(describeLauncherState(launcher.getState())).toEqual([
      { tone: "danger", text: "Could not open Beads Manager. connection lost" },
    ]);
    expect(errorCodeOf("E_X_Y: z")).toBe("E_X_Y");
    expect(errorCodeOf(new Error("W_PROVIDER_NOT_LOGGED_IN: z"))).toBeNull();
  });

  it("reports other live Managers as a warning and archives or deletes nothing", async () => {
    const managers: ManagerAgentSnapshot[] = ["old", "new"].map((id, i) => ({
      id: `mgr-${id}`,
      workspaceId: WS,
      createdAt: `2026-09-15T0${8 + i}:00:00.000Z`,
      status: "idle",
      labels: { "bm.role": "manager" },
      archivedAt: null,
    }));
    const sdk = fakePaseo(managers);
    const ensure = wiredEnsure(sdk.paseo);
    const opened: string[] = [];
    const launcher = createManagerLauncher();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await launcher.launch(WS, {
      ensure,
      openAgent: (input: { agentId: string }) => {
        opened.push(input.agentId);
      },
    });
    warn.mockRestore();

    expect(opened).toEqual(["mgr-new"]);
    expect(sdk.store.every((a) => !a.archivedAt)).toBe(true);
    expect(describeLauncherState(launcher.getState())).toEqual([
      { tone: "muted", text: "Reopened the existing Beads Manager for this workspace." },
      {
        tone: "warning",
        text: "This workspace has 1 other live Beads Manager (mgr-old). The newest one was opened; nothing was archived or deleted.",
      },
    ]);
  });

  it("shows why an existing Manager was not switched to its mode, and still opens it (delta 20260918 §4.1)", async () => {
    const launcher = createManagerLauncher();
    const openAgent = vi.fn();
    const modeNotice = "Beads Manager mgr-1 is busy, so it was not switched to \"bypassPermissions\" yet; paseo-bm will try again the next time you open it.";

    expect(
      await launcher.launch(WS, {
        ensure: async () => ({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice }),
        openAgent,
      }),
    ).toBe("opened");

    expect(openAgent).toHaveBeenCalledWith({ agentId: "mgr-1" });
    expect(describeLauncherState(launcher.getState())).toEqual([
      { tone: "muted", text: "Reopened the existing Beads Manager for this workspace." },
      { tone: "warning", text: modeNotice },
    ]);
  });

  it.each([
    ["null", { modeNotice: null }],
    ["absent (an older server)", {}],
  ])("no mode notice when the server's modeNotice is %s", async (_label, extra) => {
    const launcher = createManagerLauncher();

    await launcher.launch(WS, {
      // `as`: the contract makes modeNotice required, but the launcher still copes
      // with a server that leaves it out.
      ensure: async () => ({ agentId: "mgr-1", created: true, otherManagerIds: [], ...extra }) as EnsureManagerOutput,
      openAgent: () => {},
    });

    expect(describeLauncherState(launcher.getState())).toEqual([
      { tone: "muted", text: "Started a new Beads Manager for this workspace." },
    ]);
  });
});

describe("layout and theme (structural)", () => {
  it("adapts padding and row direction to the compact layout", () => {
    const wide = launcherStyles(theme, false);
    const compact = launcherStyles(theme, true);
    expect(wide.content.padding).toBeGreaterThan(compact.content.padding);
    expect(wide.row.flexDirection).toBe("row");
    expect(compact.row.flexDirection).toBe("column");
  });

  it("takes every color from theme.colors, so a theme switch recolors all text", () => {
    const palette = new Set(Object.values(theme.colors));
    const collect = (value: unknown, out: string[] = []): string[] => {
      if (typeof value === "string" && value.startsWith("#")) out.push(value);
      else if (value && typeof value === "object") for (const v of Object.values(value)) collect(v, out);
      return out;
    };
    for (const compact of [false, true]) {
      const styles = launcherStyles(theme, compact);
      const colors = collect(styles);
      expect(colors.length).toBeGreaterThan(0);
      for (const color of colors) expect(palette.has(color)).toBe(true);
      for (const key of ["title", "body", "rowTitle", "rowSubtitle", "buttonText", "footer"] as const) {
        expect(styles[key].color, key).toBeDefined();
      }
    }
    expect(toneColor(theme, "muted")).toBe("#fgm");
    expect(toneColor(theme, "warning")).toBe("#warn");
    expect(toneColor(theme, "danger")).toBe("#danger");
  });

  it("hard-codes no color literal in the client sources", () => {
    for (const file of [
      "../plugin/client/launch-manager.ts",
      "../plugin/client/launcher.tsx",
      "../plugin/index.client.tsx",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(source, file).not.toMatch(/color:\s*["'][a-z]+["']/);
    }
  });
});

describe("the status strip on the main screen and the workspace list (delta 20260918e)", () => {
  const opened = {
    status: "opened" as const,
    workspaceId: WS,
    agentId: "m-1",
    created: false,
    otherManagerIds: ["m-0"],
    modeNotice: null,
  };

  it("says nothing when there is nothing to say", () => {
    expect(launcherStatusLines({ commandNotice: null, canOpenAgents: true, state: { status: "idle" } })).toEqual([]);
  });

  it("puts a slash command's notice first, the old-host warning next, then the launch state", () => {
    const lines = launcherStatusLines({ commandNotice: "Asked 1 Worker to stop.", canOpenAgents: false, state: opened });
    expect(lines.map((line) => [line.text, line.tone, line.dismissable])).toEqual([
      ["Asked 1 Worker to stop.", "muted", true],
      [OLD_HOST_WARNING, "warning", false],
      ...describeLauncherState(opened).map((notice) => [notice.text, notice.tone, false]),
    ]);
    expect(OLD_HOST_WARNING).toBe("This Paseo version cannot open agents from plugins. Update Paseo to use this launcher.");
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
  });

  it.each([
    { status: "pending" as const, workspaceId: WS },
    { status: "error" as const, workspaceId: WS, code: "E_X", message: "boom" },
  ])("carries the $status launch state as it is described today", (state) => {
    const lines = launcherStatusLines({ commandNotice: null, canOpenAgents: true, state });
    expect(lines.map((line) => ({ text: line.text, tone: line.tone }))).toEqual(describeLauncherState(state));
    expect(lines.every((line) => !line.dismissable)).toBe(true);
  });

  it("is built once and placed on both the main screen and the workspace list", () => {
    // The repo renders no React component in tests, so where the strip goes is
    // checked on the source, like test/plugin-structure.test.ts reads files.
    const source = readFileSync(fileURLToPath(new URL("../plugin/client/launcher.tsx", import.meta.url)), "utf8");
    expect(source.match(/<LauncherStatus\b/g)).toHaveLength(1);
    expect(source).toMatch(/<SetupScreen\b.*\bstatus=\{status\}/);
    const listBranch = source.slice(source.indexOf("<ScrollView style={styles.screen}"));
    expect(listBranch).toMatch(/^\s*\{status\}\s*$/m);
  });
});

describe("the workspace list order (delta 20260918f §4.5: pinning removed)", () => {
  const launcher = readFileSync(fileURLToPath(new URL("../plugin/client/launcher.tsx", import.meta.url)), "utf8");

  it("renders workspaces.data in the order it arrives (most recent activity first), with no pinning", () => {
    expect(launcher).toMatch(/sort: \[\{ key: "activity_at", direction: "desc" \}\]/);
    expect(launcher).toMatch(/\{\(workspaces\.data \?\? \[\]\)\.map\(\(workspace\) =>/);
    expect(launcher).not.toMatch(/orderRows|pinnedOrder|savePinned|PinControls|DragHandle|PanResponder/);
  });

  it("never asks for the native driver", () => {
    // Paseo's renderer is react-native-web, which has none (P3). Moved here
    // from the removed pinning tests: the running dot animates too.
    expect(launcher).not.toMatch(/useNativeDriver: true/);
  });
});

describe("launcher: a Manager without Paseo tools (delta 20260921 §4.2.4)", () => {
  it("shows the toolsNotice next to the mode notice, and nothing for a state built before it", async () => {
    const { describeLauncherState } = await import("../plugin/client/launch-manager");
    const text = "This Manager runs on bm-manager/qwen without Paseo tools (on Pi this means pi-mcp-adapter is missing): it cannot create or message a Worker.";
    const notices = describeLauncherState({ status: "opened", workspaceId: "ws", agentId: "m", created: true, otherManagerIds: [], modeNotice: null, toolsNotice: text });
    expect(notices.map((notice) => notice.text)).toContain(text);
    const before = describeLauncherState({ status: "opened", workspaceId: "ws", agentId: "m", created: true, otherManagerIds: [], modeNotice: null });
    expect(before.map((notice) => notice.text)).not.toContain(text);
  });
});
