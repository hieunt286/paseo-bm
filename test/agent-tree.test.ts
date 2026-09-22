import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allNodes, pressables, renderTree, textOf, texts, type RNode } from "./helpers/element-tree";
import serverContribute from "../plugin/index.server";
import { agentsListRpc, type AgentNode, type RoleDescriptor } from "../plugin/shared/contracts";
import type { AgentDirectoryPaseo, ListedAgentSnapshot } from "../plugin/server/manager";
import {
  AGENT_TREE_ICON,
  AGENT_TREE_PANEL_ID,
  EMPTY_AGENTS_TEXT,
  NO_ROLES_TEXT,
  agentSections,
  buildAgentTree,
  indentFor,
  roleConfigRows,
  rowRoleLabel,
  treeStyles,
} from "../plugin/client/agent-tree";

/**
 * WP-113 agent-tree workspace panel.
 *
 * The repo has no React Native renderer. `react-native` primitives are replaced
 * by named stand-ins, and the hook-free `AgentTreeView` is expanded into a plain
 * element tree by `renderTree` below (our own sub-components are called, the
 * primitives are kept as nodes). That exercises the real JSX, branching, texts,
 * styles and press handlers. Pixel layout and theme appearance on a real Paseo
 * client (desktop + mobile, light + dark) stay a manual check (WP-117 / WP-120).
 */

const PRIMITIVES = ["ActivityIndicator", "Pressable", "ScrollView", "Text", "View"] as const;

vi.mock("react-native", () => {
  const make = (name: string) => Object.assign(() => null, { displayName: name, primitive: true });
  return {
    ActivityIndicator: make("ActivityIndicator"),
    Pressable: make("Pressable"),
    ScrollView: make("ScrollView"),
    Text: make("Text"),
    View: make("View"),
  };
});

// The root tsconfig has no `jsx` setting, so the .tsx modules are loaded through
// a non-literal specifier that `tsc --noEmit` does not resolve.
type ClientEntry = (client: unknown) => () => void;
const clientEntryPath = "../plugin/index.client.tsx";
const treePath = "../plugin/client/tree.tsx";
const { default: clientContribute } = (await import(clientEntryPath)) as { default: ClientEntry };
const { AgentTreePanel, AgentTreeView } = (await import(treePath)) as {
  AgentTreePanel: unknown;
  AgentTreeView: (props: Record<string, unknown>) => unknown;
};
const chatBeadsPath = "../plugin/client/bead-chips.tsx";
const { ChatBeadsPanel } = (await import(chatBeadsPath)) as { ChatBeadsPanel: unknown };
const beadsTabPath = "../plugin/client/beads-tab.tsx";
const { BeadsTabPanel } = (await import(beadsTabPath)) as { BeadsTabPanel: unknown };

// --- fixtures ----------------------------------------------------------------

const light = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f4f4f5",
    surface2: "#e4e4e7",
    border: "#d4d4d8",
    foreground: "#18181b",
    foregroundMuted: "#71717a",
    accent: "#2563eb",
    accentForeground: "#fafafa",
    statusSuccess: "#16a34a",
    statusWarning: "#ca8a04",
    statusDanger: "#dc2626",
  },
};
const dark = {
  colors: {
    surface0: "#09090b",
    surface1: "#18181b",
    surface2: "#27272a",
    border: "#3f3f46",
    foreground: "#fafafa",
    foregroundMuted: "#a1a1aa",
    accent: "#60a5fa",
    accentForeground: "#0a0a0a",
    statusSuccess: "#4ade80",
    statusWarning: "#facc15",
    statusDanger: "#f87171",
  },
};

function node(partial: Partial<AgentNode> & Pick<AgentNode, "id">): AgentNode {
  return {
    role: "worker",
    title: `Agent ${partial.id}`,
    status: "idle",
    parentId: null,
    updatedAt: "2026-09-15T10:00:00.000Z",
    ...partial,
  };
}

const DATASETS: Record<string, AgentNode[]> = {
  full: [
    node({ id: "m1", role: "manager", title: "Beads Manager", status: "idle" }),
    node({ id: "w1", role: "worker", title: "Beads Worker", status: "running", parentId: "m1" }),
    node({ id: "r1", role: "reviewer", title: "Review batch 1", status: "closed", parentId: "w1" }),
    node({ id: "r2", role: "reviewer", title: "Review batch 2", status: "error", parentId: "w1" }),
  ],
  missingLabels: [
    node({ id: "m1", role: "manager", title: null }),
    node({ id: "w1", role: "unknown", title: null, parentId: "m1", status: "initializing" }),
    node({ id: "x1", role: "unknown", title: "   ", parentId: "w1", status: "something-new" }),
  ],
  orphanWorker: [
    node({ id: "m2", role: "manager", title: "Beads Manager" }),
    node({ id: "w-orphan", role: "worker", title: "Orphaned Worker", status: "running", parentId: null }),
    node({ id: "r-orphan", role: "reviewer", title: "Its Reviewer", parentId: "w-orphan" }),
  ],
  empty: [],
};

const ROLES: RoleDescriptor[] = [
  { role: "reviewer", provider: "codex", model: "gpt-5", paseoTools: false, instructionsPath: "roles/reviewer.md" },
  { role: "manager", provider: "claude", model: "opus", paseoTools: true, instructionsPath: "roles/manager.md" },
  { role: "worker", provider: "claude", model: "", paseoTools: true, instructionsPath: "roles/worker.md" },
];

function view(overrides: Record<string, unknown> = {}) {
  return renderTree(
    AgentTreeView({
      theme: light,
      compact: false,
      agents: { status: "success", data: DATASETS.full },
      roles: { status: "success", data: ROLES },
      openAgent: vi.fn(),
      ...overrides,
    }),
  );
}

// -----------------------------------------------------------------------------

describe("client entry registration", () => {
  it("adds the workspace panel next to the launcher, and cleanup removes it too", () => {
    const removed: string[] = [];
    const panels: Array<Record<string, unknown>> = [];
    const client = {
      addSurface: (id: string) => () => removed.push(`surface:${id}`),
      addSidebarItem: (item: { id: string }) => () => removed.push(`sidebar:${item.id}`),
      addCommandCenterItem: (item: { id: string }) => () => removed.push(`command:${item.id}`),
      addSlashCommand: (item: { name: string }) => () => removed.push(`slash:${item.name}`),
      addWorkspacePanel: (item: Record<string, unknown>) => {
        panels.push(item);
        return () => removed.push(`panel:${String(item.id)}`);
      },
      // WP-211 registers the Dashboard settings screen from the same entry.
      addSettingsScreen: (item: { id: string }) => () => removed.push(`settings:${item.id}`),
      // The chat cards (delta 20260916-chat-cards).
      addTimelineTransformer: (item: { id: string }) => () => removed.push(`transformer:${item.id}`),
      addTimelineRenderer: (item: { kind: string }) => () => removed.push(`renderer:${item.kind}`),
    };

    const cleanup = clientContribute(client);
    expect(panels).toEqual([
      { id: "bm-chat-beads", title: "Beads in this chat", icon: "ListChecks", context: "agent", Component: ChatBeadsPanel },
      // The "Beads" tab of the "+" menu (delta 20260918e), ahead of "Beads agents".
      { id: "bm-beads", title: "Beads", icon: "ListChecks", context: "workspace", Component: BeadsTabPanel },
      { id: AGENT_TREE_PANEL_ID, title: "Beads agents", icon: "ListTree", context: "workspace", Component: AgentTreePanel },
    ]);
    expect(AGENT_TREE_ICON).toBe("ListTree");

    cleanup();
    expect(removed.sort()).toEqual(
      [
        "surface:beads-manager",
        "sidebar:beads-manager",
        "slash:bm-worker-new",
        "slash:bm-worker-stop-all",
        "command:open-beads-manager",
        "command:open-beads-dashboard",
        "settings:paseo-bm-settings",
        `panel:${AGENT_TREE_PANEL_ID}`,
        "panel:bm-chat-beads",
        "panel:bm-beads",
        "transformer:bm-chat-received",
        "transformer:bm-chat-sent",
        "renderer:bm-message",
      ].sort(),
    );
  });
});

describe("tree building: four datasets", () => {
  it("full tree: Manager -> Worker -> Reviewers, with depth and status", () => {
    const sections = agentSections(buildAgentTree(DATASETS.full!));
    expect(sections.map((s) => s.key)).toEqual(["managers"]);
    expect(sections[0]!.rows.map((r) => [r.agentId, r.depth, r.roleLabel, r.status, r.statusTone])).toEqual([
      ["m1", 0, "Manager", "idle", "success"],
      ["w1", 1, "Worker", "running", "accent"],
      ["r1", 2, "Reviewer", "closed", "muted"],
      ["r2", 2, "Reviewer", "error", "danger"],
    ]);

    const out = view();
    const shown = texts(out);
    for (const text of ["Managers", "Beads Manager", "Beads Worker", "Review batch 1", "Review batch 2", "running", "error"]) {
      expect(shown).toContain(text);
    }
    expect(shown).not.toContain("Without a Manager");
  });

  it("missing labels: unknown role and null title render as placeholders instead of breaking", () => {
    const rows = agentSections(buildAgentTree(DATASETS.missingLabels!))[0]!.rows;
    expect(rows.map((r) => [r.agentId, r.depth, r.roleLabel, r.label, r.statusTone])).toEqual([
      ["m1", 0, "Manager", "Untitled agent (m1)", "success"],
      ["w1", 1, "Unknown role", "Untitled agent (w1)", "warning"],
      ["x1", 2, "Unknown role", "Untitled agent (x1)", "muted"],
    ]);

    const shown = texts(view({ agents: { status: "success", data: DATASETS.missingLabels } }));
    expect(shown).toContain("Unknown role");
    expect(shown).toContain("Untitled agent (w1)");
    expect(shown).toContain("something-new");
  });

  it("orphaned Worker: shown in its own 'Without a Manager' branch with its children", () => {
    const sections = agentSections(buildAgentTree(DATASETS.orphanWorker!));
    expect(sections.map((s) => [s.key, s.title, s.rows.map((r) => [r.agentId, r.depth])])).toEqual([
      ["managers", "Managers", [["m2", 0]]],
      ["without-manager", "Without a Manager", [["w-orphan", 0], ["r-orphan", 1]]],
    ]);
    const shown = texts(view({ agents: { status: "success", data: DATASETS.orphanWorker } }));
    expect(shown).toContain("Without a Manager");
    expect(shown).toContain("Orphaned Worker");
  });

  it("empty list: a clear empty state and no rows", () => {
    expect(agentSections(buildAgentTree(DATASETS.empty!))).toEqual([]);
    const out = view({ agents: { status: "success", data: [] } });
    expect(texts(out)).toContain(EMPTY_AGENTS_TEXT);
    expect(pressables(out).filter((p) => String(p.props.accessibilityLabel).startsWith("Open "))).toEqual([]);
  });

  it("stays defensive beyond the contract: unknown parent, cycle and duplicate ids become single roots", () => {
    const tree = buildAgentTree([
      node({ id: "a", parentId: "missing" }),
      node({ id: "b", parentId: "c" }),
      node({ id: "c", parentId: "b" }),
      node({ id: "a", role: "manager" }),
    ]);
    expect(tree.managers).toEqual([]);
    expect(tree.withoutManager.map((n) => n.agent.id)).toEqual(["a", "b", "c"]);
  });

  it("builds from the real agents.list handler over a fake Paseo SDK (orphan and unlabeled child)", async () => {
    const snap = (id: string, labels: Record<string, string>, extra: Partial<ListedAgentSnapshot> = {}): ListedAgentSnapshot => ({
      id,
      workspaceId: "ws-1",
      title: id === "w-unlabeled" ? null : id,
      status: "idle",
      createdAt: `2026-09-15T10:00:0${id.length % 10}.000Z`,
      updatedAt: "2026-09-15T10:00:00.000Z",
      labels,
      archivedAt: null,
      ...extra,
    });
    const store = [
      snap("mgr", { "bm.role": "manager" }),
      snap("w-unlabeled", { "paseo.parent-agent-id": "mgr" }),
      snap("w-orphan", { "bm.role": "worker", "paseo.parent-agent-id": "gone" }),
      snap("other-ws", { "bm.role": "manager" }, { workspaceId: "ws-2" }),
    ];
    const paseo: AgentDirectoryPaseo = {
      agents: {
        async list() {
          return { entries: store.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
        },
      },
    };
    const handle = vi.fn();
    serverContribute({ handle, registerSettings: vi.fn() } as unknown as Parameters<typeof serverContribute>[0]);
    const handler = handle.mock.calls.find(([contract]) => contract === agentsListRpc)![1] as (
      input: unknown,
      ctx: { paseo: AgentDirectoryPaseo },
    ) => Promise<unknown>;
    const { agents } = agentsListRpc.output.parse(await handler({ workspaceId: "ws-1" }, { paseo }));

    const sections = agentSections(buildAgentTree(agents));
    expect(sections.map((s) => [s.key, s.rows.map((r) => [r.agentId, r.depth, r.roleLabel])])).toEqual([
      ["managers", [["mgr", 0, "Manager"], ["w-unlabeled", 1, "Unknown role"]]],
      ["without-manager", [["w-orphan", 0, "Worker"]]],
    ]);
  });
});

describe("opening agents (read-only panel)", () => {
  it("pressing a row opens exactly that agent", () => {
    const openAgent = vi.fn();
    const rows = pressables(view({ openAgent })).filter((p) => String(p.props.accessibilityLabel).startsWith("Open "));
    expect(rows.map((p) => p.props.accessibilityLabel)).toEqual([
      "Open Manager Beads Manager, status idle",
      "Open Worker Beads Worker, status running",
      "Open Reviewer Review batch 1, status closed",
      "Open Reviewer Review batch 2, status error",
    ]);
    (rows[1]!.props.onPress as () => void)();
    expect(openAgent).toHaveBeenCalledTimes(1);
    expect(openAgent).toHaveBeenCalledWith({ agentId: "w1" });
  });

  it("offers no stop, archive or delete action anywhere", () => {
    for (const data of Object.values(DATASETS)) {
      const out = view({ agents: { status: "success", data } });
      const labels = [...texts(out), ...pressables(out).map((p) => String(p.props.accessibilityLabel))];
      for (const label of labels) expect(label).not.toMatch(/\b(stop|archive|delete|remove|kill)\b/i);
    }
    for (const file of ["../plugin/client/tree.tsx", "../plugin/client/agent-tree.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/\.(archive|delete|stop|kill|cancel)\s*\(/);
    }
  });

  it("without navigation.openAgent the rows are not pressable and a notice explains why", () => {
    const out = view({ openAgent: undefined });
    expect(pressables(out)).toEqual([]);
    expect(texts(out).some((t) => t.startsWith("This Paseo version cannot open agents"))).toBe(true);
  });
});

describe("loading and error states", () => {
  it("shows spinners while pending", () => {
    const out = view({ agents: { status: "pending" }, roles: { status: "pending" } });
    expect(allNodes(out).filter((n) => n.type === "ActivityIndicator")).toHaveLength(2);
  });

  it("shows the RPC error code when present, the plain message otherwise, and a retry", () => {
    const onRetryAgents = vi.fn();
    const onRetryRoles = vi.fn();
    const out = view({
      agents: { status: "error", error: new Error("connection lost") },
      roles: { status: "error", error: new Error("E_RECORD_SCHEMA_TOO_NEW: install.json uses schema 2") },
      onRetryAgents,
      onRetryRoles,
    });
    const shown = texts(out);
    expect(shown).toContain("Could not load agents. connection lost");
    expect(shown).toContain(
      "Could not load role configuration (E_RECORD_SCHEMA_TOO_NEW). E_RECORD_SCHEMA_TOO_NEW: install.json uses schema 2",
    );
    const retry = pressables(out);
    expect(retry.map((p) => p.props.accessibilityLabel)).toEqual(["Retry loading agents", "Retry loading role configuration"]);
    (retry[0]!.props.onPress as () => void)();
    (retry[1]!.props.onPress as () => void)();
    expect(onRetryAgents).toHaveBeenCalledTimes(1);
    expect(onRetryRoles).toHaveBeenCalledTimes(1);
  });
});

describe("role configuration (roles.describe)", () => {
  it("shows role, provider, model, Paseo tools and instructions path, in role order", () => {
    expect(roleConfigRows(ROLES)).toEqual([
      {
        role: "Manager",
        fields: [
          { label: "Provider", value: "claude" },
          { label: "Model", value: "opus" },
          { label: "Paseo tools", value: "Granted" },
          { label: "Instructions", value: "roles/manager.md" },
        ],
      },
      {
        role: "Worker",
        fields: [
          { label: "Provider", value: "claude" },
          { label: "Model", value: "(provider default)" },
          { label: "Paseo tools", value: "Granted" },
          { label: "Instructions", value: "roles/worker.md" },
        ],
      },
      {
        role: "Reviewer",
        fields: [
          { label: "Provider", value: "codex" },
          { label: "Model", value: "gpt-5" },
          { label: "Paseo tools", value: "Not granted" },
          { label: "Instructions", value: "roles/reviewer.md" },
        ],
      },
    ]);
    const shown = texts(view());
    for (const text of ["Role configuration", "codex", "gpt-5", "Not granted", "roles/worker.md"]) {
      expect(shown).toContain(text);
    }
  });

  it("roles: [] shows an explicit not-installed / roles-not-registered state", () => {
    const shown = texts(view({ roles: { status: "success", data: [] } }));
    expect(shown).toContain(NO_ROLES_TEXT);
    expect(NO_ROLES_TEXT).toMatch(/not installed/);
    expect(NO_ROLES_TEXT).toMatch(/not registered with Paseo/);
  });
});

describe("layout and theme (structural)", () => {
  it("wide and compact layouts differ in padding, indentation and row direction", () => {
    const wide = treeStyles(light, false);
    const compact = treeStyles(light, true);
    expect(wide.content.padding).toBeGreaterThan(compact.content.padding);
    expect(wide.row.flexDirection).toBe("row");
    expect(compact.row.flexDirection).toBe("column");
    expect(indentFor(2, false)).toBeGreaterThan(indentFor(2, true));
    expect(indentFor(0, false)).toBe(0);

    for (const compactFlag of [false, true]) {
      const rows = pressables(view({ compact: compactFlag })).filter((p) => String(p.props.accessibilityLabel).startsWith("Open "));
      const styleOf = (p: RNode) => (p.props.style as (s: { pressed: boolean }) => unknown[])({ pressed: false });
      const margins = rows.map((p) => (styleOf(p)[1] as { marginLeft: number }).marginLeft);
      expect(margins).toEqual([0, 1, 2, 2].map((d) => indentFor(d, compactFlag)));
    }
  });

  it("in both themes and both layouts every rendered color comes from theme.colors", () => {
    const collect = (value: unknown, out: string[] = []): string[] => {
      if (typeof value === "function") return collect((value as (s: { pressed: boolean }) => unknown)({ pressed: true }), out);
      if (typeof value === "string" && value.startsWith("#")) out.push(value);
      else if (value && typeof value === "object") for (const v of Object.values(value)) collect(v, out);
      return out;
    };
    for (const theme of [light, dark]) {
      const palette = new Set(Object.values(theme.colors));
      for (const compact of [false, true]) {
        const scenarios = [
          view({ theme, compact }),
          view({ theme, compact, agents: { status: "success", data: DATASETS.orphanWorker }, roles: { status: "success", data: [] } }),
          view({ theme, compact, agents: { status: "error", error: new Error("x") }, roles: { status: "pending" }, openAgent: undefined, onRetryAgents: vi.fn() }),
        ];
        for (const out of scenarios) {
          const nodes = allNodes(out);
          const colors = nodes.flatMap((n) => collect(n.props.style).concat(collect(n.props.color)));
          expect(colors.length).toBeGreaterThan(0);
          for (const color of colors) expect(palette.has(color)).toBe(true);
          // Unstyled Text is black in dark themes: every Text must carry a color.
          for (const text of nodes.filter((n) => n.type === "Text")) {
            expect(collect(text.props.style).length, textOf(text)).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("hard-codes no color literal in the panel sources", () => {
    for (const file of ["../plugin/client/tree.tsx", "../plugin/client/agent-tree.ts", "../plugin/index.client.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
      expect(source, file).not.toMatch(/color:\s*["'][a-z]+["']/);
    }
  });
});

describe("no HTML elements", () => {
  it("renders only React Native primitives in every state", () => {
    const allowed = new Set<string>(PRIMITIVES);
    const scenarios = [
      ...Object.values(DATASETS).map((data) => view({ agents: { status: "success", data } })),
      view({ agents: { status: "pending" }, roles: { status: "error", error: new Error("E_X: y") }, onRetryRoles: vi.fn() }),
    ];
    for (const out of scenarios) {
      for (const n of allNodes(out)) expect(allowed.has(n.type), n.type).toBe(true);
    }
  });

  it("the panel sources contain no HTML JSX tags or web-only props", () => {
    for (const file of ["../plugin/client/tree.tsx", "../plugin/index.client.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).not.toMatch(
        /<\/?(div|span|p|a|img|button|input|ul|ol|li|h[1-6]|section|header|footer|nav|form|label|table|svg)[\s/>]/,
      );
      expect(source, file).not.toMatch(/className=|onClick=|document\.|window\./);
    }
  });
});

describe("rowRoleLabel (delta 20260918g §4.4)", () => {
  it("marks a paseo-bm agent without a bm.role label, and nothing else", () => {
    expect(rowRoleLabel({ role: "manager", labelled: false })).toBe("Manager · no label");
    expect(rowRoleLabel({ role: "worker", labelled: false })).toBe("Worker · no label");
    expect(rowRoleLabel({ role: "manager", labelled: true })).toBe("Manager");
    expect(rowRoleLabel({ role: "reviewer" })).toBe("Reviewer");
    expect(rowRoleLabel({ role: "unknown", labelled: false })).toBe("Unknown role");
  });

  it("names the agent that replaced one, whatever its role (delta 20260921 §4.4.8)", () => {
    expect(rowRoleLabel({ role: "worker", labelled: true, replacedBy: "wrk-2" })).toBe("Worker · replaced by wrk-2");
    expect(rowRoleLabel({ role: "manager", labelled: false, replacedBy: "mgr-2" })).toBe("Manager · no label · replaced by mgr-2");
    expect(rowRoleLabel({ role: "reviewer", labelled: true, replacedBy: null })).toBe("Reviewer");
  });

  it("shows the mark in the rows built from the tree", () => {
    const node = (id: string, role: AgentNode["role"], labelled: boolean, parentId: string | null = null): AgentNode => ({
      id,
      role,
      title: id,
      status: "idle",
      parentId,
      updatedAt: "2026-09-18T07:00:00.000Z",
      labelled,
    });
    const sections = agentSections(buildAgentTree([node("user-mgr", "manager", false), node("wrk", "worker", true, "user-mgr")]));
    expect(sections[0]!.rows.map((row) => [row.agentId, row.roleLabel])).toEqual([
      ["user-mgr", "Manager · no label"],
      ["wrk", "Worker"],
    ]);
  });
});
