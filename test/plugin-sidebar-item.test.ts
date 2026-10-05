import { describe, expect, it, vi } from "vitest";
import { allNodes, pressables, renderTree, texts } from "./helpers/element-tree";
import { INBOX_POLL_MS } from "../plugin/client/inbox-model";

const state = vi.hoisted(() => ({
  decisions: [] as unknown[],
  alerts: [] as unknown[],
  updateAvailable: false,
  queryOptions: [] as Array<Record<string, unknown>>,
  listDecisions: vi.fn(async () => ({ decisions: [], truncated: false })),
  listAlerts: vi.fn(async () => ({ alerts: [], truncated: false })),
}));

vi.mock("@getpaseo/plugin/client", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  let rpc = 0;
  return {
    ...original,
    useRpc: vi.fn(() => (rpc++ % 2 === 0 ? state.listDecisions : state.listAlerts)),
  };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    useQuery: vi.fn((options: Record<string, unknown>) => {
      state.queryOptions.push(options);
      return { data: state.queryOptions.length % 2 === 1 ? { decisions: state.decisions } : { alerts: state.alerts } };
    }),
  };
});

vi.mock("../plugin/client/update-status", () => ({
  useUpdateStatus: () => ({ data: { updateAvailable: state.updateAvailable } }),
}));

const sidebarPath = "../plugin/client/sidebar-item.tsx";
const { BeadsManagerSidebarItem } = (await import(sidebarPath)) as {
  BeadsManagerSidebarItem: (props: Record<string, unknown>) => unknown;
};

const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };

function draw(onOpen = vi.fn()) {
  state.queryOptions.length = 0;
  return { tree: renderTree(BeadsManagerSidebarItem({ theme, onOpen })), onOpen };
}

describe("Beads Manager sidebar item", () => {
  it("shows live attention and update indicators, accessibility text, and navigation", async () => {
    state.decisions = [{ id: "decision-1" }];
    state.alerts = [{ key: "alert-1" }];
    state.updateAvailable = true;
    const { tree, onOpen } = draw();

    expect(texts(tree)).toEqual(expect.arrayContaining(["Beads Manager", "2"]));
    expect(allNodes(tree).filter((node) => node.type === "Icon").map((node) => node.props.name)).toContain("Download");
    const button = pressables(tree)[0]!;
    expect(button.props.accessibilityLabel).toBe("Beads Manager, 2 items need you, update available");
    (button.props.onPress as () => void)();
    expect(onOpen).toHaveBeenCalledOnce();

    expect(state.queryOptions).toHaveLength(2);
    expect(state.queryOptions.map((options) => options.refetchInterval)).toEqual([INBOX_POLL_MS, INBOX_POLL_MS]);
    await (state.queryOptions[0]!.queryFn as () => Promise<unknown>)();
    await (state.queryOptions[1]!.queryFn as () => Promise<unknown>)();
    expect(state.listDecisions).toHaveBeenLastCalledWith({ scope: "inbox" });
    expect(state.listAlerts).toHaveBeenLastCalledWith({});
  });

  it("removes the badge and update icon after refreshed RPC data is clear", () => {
    state.decisions = [];
    state.alerts = [];
    state.updateAvailable = false;
    const { tree } = draw();

    expect(texts(tree)).toEqual(["Beads Manager"]);
    expect(allNodes(tree).filter((node) => node.type === "Icon").map((node) => node.props.name)).not.toContain("Download");
    expect(pressables(tree)[0]!.props.accessibilityLabel).toBe("Beads Manager");
  });
});
