import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ManagerAgentHandle, ManagerAgentSnapshot, ManagerPaseo } from "../plugin/server/manager";
import serverContribute from "../plugin/index.server";
import { managerEnsureRpc } from "../plugin/shared/contracts";
import {
  LAUNCHER_ICON,
  LAUNCHER_SURFACE_ID,
  createLaunchRequests,
  createManagerLauncher,
  describeLauncherState,
  errorCodeOf,
  launchRequests,
  launcherStyles,
  runPendingRequest,
  selectFromCommandCenter,
  toneColor,
  type EnsureManagerOutput,
} from "../plugin/client/launch-manager";

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
const { default: clientContribute } = (await import(clientEntryPath)) as { default: ClientEntry };
const { ManagerLauncherSurface } = (await import(surfacePath)) as { ManagerLauncherSurface: unknown };

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
              Object.entries(filter.labels).every(([k, v]) => a.labels[k] === v) &&
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
  serverContribute({ handle } as unknown as Parameters<typeof serverContribute>[0]);
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
    addWorkspacePanel: (item: { id: string }) => () => removed.push(`panel:${item.id}`),
  };
  return { client, surfaces, sidebarItems, commandItems, removed };
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
  it("registers the surface, a sidebar item pointing at it, and a workspace Command Center item", () => {
    const fake = fakeClient();
    const cleanup = clientContribute(fake.client);

    expect(fake.surfaces.get(LAUNCHER_SURFACE_ID)).toBe(ManagerLauncherSurface);
    expect(fake.sidebarItems).toEqual([
      { id: LAUNCHER_SURFACE_ID, title: "Beads Manager", icon: "Bot", surface: LAUNCHER_SURFACE_ID },
    ]);
    expect(fake.commandItems).toHaveLength(1);
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
        "panel:beads-agents",
      ].sort(),
    );
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
    const requests = createLaunchRequests();
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
    const requests = createLaunchRequests();
    const ensure = vi.fn();
    requests.request(WS);
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

    resolve({ agentId: "mgr-1", created: false, otherManagerIds: [] });
    expect(await first).toBe("opened");
    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["pending", "opened"]);
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
