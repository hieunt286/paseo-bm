import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../plugin/shared/contracts";
import {
  AUTONOMY_COMING,
  DEFAULT_OPEN_GROUPS,
  GROUP_LOADING,
  SETTINGS_GROUPS,
  THRESHOLD_NOTE,
  agentsGroupState,
  dataGroupState,
  groupHeaderView,
  storageSummary,
  toggleGroup,
  toolsGroupState,
  type StoredWorkspaceBytes,
} from "../plugin/client/settings-model";
import { ensureRolesLine, MIGRATION_BANNER_TEXT } from "../plugin/client/setup-model";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";

/**
 * Settings (experience concept §4.4, autonomy design §A.12): four groups,
 * each folded to one line with its state. The states are pure and tested
 * here; the hook-free pieces of `settings-section.tsx` are expanded with the
 * element-tree helper, `react-native` and the SDK being named stand-ins.
 */

vi.mock("react-native", () => {
  const make = (name: string) => Object.assign(() => null, { displayName: name, primitive: true });
  return {
    ActivityIndicator: make("ActivityIndicator"),
    Pressable: make("Pressable"),
    ScrollView: make("ScrollView"),
    Text: make("Text"),
    TextInput: make("TextInput"),
    View: make("View"),
  };
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: Object.assign(() => null, { displayName: "Icon", primitive: true }),
  copyText: async () => undefined,
}));

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const sectionPath = "../plugin/client/settings-section.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { SettingsGroupHeader, RolesLineView, StorageRowView } = (await import(sectionPath)) as {
  SettingsGroupHeader: Component;
  RolesLineView: Component;
  StorageRowView: Component;
};

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;
const MB = 1024 * 1024;

const skillRow = (name: string, ok: boolean) => ({
  name,
  required: true,
  claude: ok ? ("ok" as const) : ("missing" as const),
  codex: ok ? ("ok" as const) : ("missing" as const),
  pi: "missing" as const,
  opencode: "missing" as const,
  problem: null,
});

/** A machine where everything is done; each case varies it. */
function readyStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    tools: [
      { id: "br", name: "br", purpose: "", required: true, path: "/usr/bin/br", version: "0.6.0", latestKnown: "0.6.0", installCommand: null, updateCommand: null, homepage: "" },
      { id: "bv", name: "bv", purpose: "", required: true, path: "/usr/bin/bv", version: "v0.25.0", latestKnown: "v0.25.0", installCommand: null, updateCommand: null, homepage: "" },
    ],
    latestCheckedOn: "2026-09-16",
    skills: {
      checkedAt: "2026-09-25T00:00:00.000Z",
      dirs: { shared: "/h/.agents/skills", claude: "/h/.claude/skills", codex: "/h/.codex/skills" },
      skills: ["feature-workflow", "reviewing-plan", "converting-plan-to-beads", "polishing-beads", "implementing-beads"].map((name) => skillRow(name, true)),
      missingRequired: { claude: 0, codex: 0, pi: 5, opencode: 5 },
      installCommand: "npx -y skills add cuongntr/agent-skills …",
    },
    extras: { manager: 0, worker: 0, reviewer: 0 },
    setup: {
      roles: { present: ["manager", "worker", "reviewer", "orchestrator"], missing: [], created: null, cleanedUpAt: null },
      agentTools: { injectIntoAgents: true, setBy: null },
      logins: [{ provider: "claude", roles: ["manager", "worker", "reviewer"], state: "logged-in", loginCommand: "claude auth login", guidance: null }],
      skillsRun: null,
      dataHome: { path: "/h/.paseo-bm", source: "default", reason: null },
      install: { kind: "other", pluginPath: null },
    },
    ...overrides,
  } as SetupStatus;
}

const withSetup = (setup: Partial<NonNullable<SetupStatus["setup"]>>, rest: Partial<SetupStatus> = {}): SetupStatus => {
  const base = readyStatus(rest);
  return { ...base, setup: { ...base.setup!, ...setup } } as SetupStatus;
};

const stored = (overrides: Partial<StoredWorkspaceBytes> & { workspaceId: string; bytes: number }): StoredWorkspaceBytes => ({
  state: "live",
  lastKnownName: null,
  lastKnownDirectory: null,
  lastSeenAt: null,
  ...overrides,
});

describe("the four groups (experience concept §4.4)", () => {
  it("are Agents, Autonomy, Tools & skills and Data, in that order, all folded at first", () => {
    expect(SETTINGS_GROUPS.map((group) => group.title)).toEqual(["Agents", "Autonomy", "Tools & skills", "Data"]);
    expect(DEFAULT_OPEN_GROUPS.size).toBe(0);
    expect(SETTINGS_GROUPS.every((group) => group.hint.length > 0)).toBe(true);
  });

  it("open and close on a press; Autonomy says in one line that it comes in Phase 2, and never opens", () => {
    const agents = toggleGroup(DEFAULT_OPEN_GROUPS, "agents");
    expect([...agents]).toEqual(["agents"]);
    expect([...toggleGroup(agents, "data")].sort()).toEqual(["agents", "data"]);
    expect([...toggleGroup(agents, "agents")]).toEqual([]);
    expect([...toggleGroup(DEFAULT_OPEN_GROUPS, "autonomy")]).toEqual([]);
    expect(AUTONOMY_COMING).toMatch(/^Coming in the next phase: /);
    expect(AUTONOMY_COMING.split("\n")).toHaveLength(1);
  });

  it("carry neither the Orchestrator tab nor the additional-instructions editor", () => {
    const source = readFileSync(fileURLToPath(new URL("../plugin/client/settings-section.tsx", import.meta.url)), "utf8");
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/OrchestratorTab|orchestrator-tab|RoleCard|rolesSaveExtra|rolesInstructions|Additional instructions|SETUP_TABS|StatusTabs/);
    // What each group is built from: the Setup screen's pieces.
    for (const piece of ["<RolesSection", "<AgentToolsBlockView", "<ToolCard", "<SkillsInstallBlock", "<CleanupBlock", "<TraceActions", "signInRows(data)"]) {
      expect(code).toContain(piece);
    }
  });

  it("is what the surface's Settings tab shows, with the status strip", () => {
    const launcher = readFileSync(fileURLToPath(new URL("../plugin/client/launcher.tsx", import.meta.url)), "utf8");
    expect(launcher).toMatch(/<SettingsScreen \{\.\.\.props\} status=\{status\} \/>/);
    expect(launcher).not.toMatch(/<SetupScreen\b/);
  });
});

describe("the Agents line", () => {
  it("reads 'Checking…' until the status answers, then how many roles are ready", () => {
    expect(agentsGroupState(undefined)).toEqual(GROUP_LOADING);
    expect(agentsGroupState(readyStatus())).toEqual({ text: "4 roles ready · agent tools on · signed in", tone: "success" });
  });

  it("names every problem, the worst first, in the worst tone", () => {
    const status = withSetup(
      {
        roles: { present: ["manager"], missing: ["worker", "reviewer"], created: null, cleanedUpAt: null },
        agentTools: { injectIntoAgents: false, setBy: null },
        logins: [{ provider: "codex", roles: ["worker"], state: "logged-out", loginCommand: "codex login", guidance: null }],
      },
      { paseoTools: { manager: null, worker: { state: "missing", agentId: "a1", provider: "pi", at: "2026-09-29T00:00:00Z" } } as SetupStatus["paseoTools"] },
    );
    expect(agentsGroupState(status)).toEqual({
      text: "Not created: Worker, Reviewer · Agent tools off · Codex not signed in · Last Worker had no Paseo tools",
      tone: "danger",
    });
  });

  it("says the settings were removed after a cleanup, and a failed role setup", () => {
    expect(agentsGroupState(readyStatus(), { error: null, cleanedUp: true })).toEqual({
      text: "paseo-bm's settings were removed",
      tone: "warning",
    });
    expect(agentsGroupState(readyStatus(), { error: "E_X: boom", cleanedUp: false }).tone).toBe("danger");
    expect(agentsGroupState(withSetup({ agentTools: { injectIntoAgents: null, setBy: null } })).text).toBe("Agent tools unknown");
  });

  it("falls back to a plain line on a server without the setup block", () => {
    expect(agentsGroupState(readyStatus({ setup: undefined }))).toEqual({ text: "Roles, models and fallbacks", tone: "muted" });
  });
});

describe("the Tools & skills line", () => {
  it("says br and bv are ready and counts the Worker's skills on its own agent", () => {
    expect(toolsGroupState(readyStatus())).toEqual({ text: "br and bv ready · Worker skills (Claude) 5/5", tone: "success" });
  });

  it("puts a missing tool first, in danger, then an update and missing Worker skills", () => {
    const base = readyStatus();
    const status = readyStatus({
      tools: [
        { ...base.tools[0]!, path: null },
        { ...base.tools[1]!, version: "v0.24.0" },
      ],
      skills: { ...base.skills, missingRequired: { claude: 2, codex: 0 } },
    });
    expect(toolsGroupState(status)).toEqual({ text: "Missing br · bv update available · Worker skills (Claude) 3/5", tone: "danger" });
  });

  it("counts every reported agent when no Worker provider is known", () => {
    expect(toolsGroupState(withSetup({ logins: [] })).text).toBe("br and bv ready · skills: Claude 5/5, Codex 5/5, Pi 0/5, OpenCode 0/5");
  });
});

describe("the Data group", () => {
  const workspaces = [
    stored({ workspaceId: "w1", bytes: 2 * MB, lastKnownName: "shop", lastSeenAt: "2026-09-20T10:00:00Z" }),
    stored({ workspaceId: "w2", bytes: 30 * MB, state: "orphaned", lastKnownDirectory: "/work/old" }),
    stored({ workspaceId: "w3", bytes: 1024, state: "archived" }),
  ];

  it("lists the workspaces largest first, by name and never by id", () => {
    const summary = storageSummary(workspaces, 200 * MB);
    expect(summary.rows.map((row) => [row.workspaceId, row.label, row.state])).toEqual([
      ["w2", "/work/old", "orphaned"],
      ["w1", "shop", "live"],
      ["w3", "Unnamed workspace", "archived"],
    ]);
    expect(summary.rows[1]!.detail).toBe("2.0 MB · open in Paseo · last active 2026-09-20");
    expect(summary.rows.every((row) => !row.label.startsWith("w"))).toBe(true);
    expect(summary.summary).toMatch(/^32 MB of traces in 3 workspaces\. Warns above 200 MB\.$/);
    expect(summary.warning).toBeNull();
    expect(THRESHOLD_NOTE).toMatch(/Beads Dashboard/);
  });

  it("warns past the machine-wide threshold, with the storage wording of the shared model", () => {
    const summary = storageSummary(workspaces, 10 * MB);
    expect(summary.warning?.tone).toBe("warning");
    expect(summary.warning?.text).toMatch(/^The trace store is over 10 MB\. Delete traces you no longer need\./);
    expect(dataGroupState(readyStatus(), summary)).toEqual({ text: "Traces 32 MB, over the warning size", tone: "warning" });
  });

  it("reads the traces' size when all is well, and says when there are none", () => {
    expect(dataGroupState(readyStatus(), storageSummary(workspaces, 200 * MB))).toEqual({ text: "32 MB of traces", tone: "muted" });
    expect(storageSummary([], 200 * MB).summary).toBe("No traces recorded yet.");
    expect(dataGroupState(readyStatus(), storageSummary([], 200 * MB)).text).toBe("No traces yet");
    expect(dataGroupState(readyStatus(), null).text).toBe("Data folder, traces and cleanup");
    expect(dataGroupState(undefined, null)).toEqual(GROUP_LOADING);
  });

  it("names an unusable data folder, a cleanup, and an install from the old installer", () => {
    const status = withSetup({
      dataHome: { path: null, source: null, reason: "EACCES" },
      install: { kind: "installer-directory", pluginPath: "/x" },
    });
    expect(dataGroupState(status, null, true)).toEqual({
      text: "The data folder cannot be used · Settings removed · Installed by the old npx installer",
      tone: "danger",
    });
    expect(MIGRATION_BANNER_TEXT).toMatch(/npx installer/);
  });
});

describe("the group header (hook-free)", () => {
  const header = (view: ReturnType<typeof groupHeaderView>, onToggle = noop) =>
    renderTree(SettingsGroupHeader({ view, onToggle, styles, theme }));

  it("is one button with its state, the expanded state and a label that says what it holds", () => {
    const onToggle = vi.fn();
    const folded = header(groupHeaderView("agents", { text: "Agent tools off", tone: "warning" }, false), onToggle);
    const [button] = pressables(folded);
    expect(button!.props.accessibilityRole).toBe("button");
    expect(button!.props.accessibilityState).toEqual({ expanded: false });
    expect(button!.props.accessibilityLabel).toBe("Agents, roles, models, fallbacks, sign-in and agent tools: Agent tools off. Expand.");
    expect(texts(folded)).toEqual(["▸ Agents", "Agent tools off"]);
    // The state line is drawn in its tone's colour, through the theme.
    const state = allNodes(folded).find((node) => node.type === "Text" && texts([node])[0] === "Agent tools off")!;
    expect(JSON.stringify(state.props.style)).toContain("#statusWarning");
    (button!.props.onPress as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();

    const open = header(groupHeaderView("data", { text: "32 MB of traces", tone: "muted" }, true));
    expect(texts(open)[0]).toBe("▾ Data");
    expect(pressables(open)[0]!.props.accessibilityState).toEqual({ expanded: true });
    expect(pressables(open)[0]!.props.accessibilityLabel).toMatch(/Collapse\.$/);
  });

  it("is plain text for Autonomy: nothing to press, one line", () => {
    const nodes = header(groupHeaderView("autonomy", { text: AUTONOMY_COMING, tone: "muted" }, false));
    expect(pressables(nodes)).toHaveLength(0);
    expect(texts(nodes)).toEqual(["Autonomy", AUTONOMY_COMING]);
    expect((nodes[0] as RNode).props.accessibilityLabel).toBe(`Autonomy: ${AUTONOMY_COMING}`);
  });
});

describe("the roles line (hook-free)", () => {
  it("offers Set up again after a cleanup, labelled, and disabled while it runs", () => {
    const line = ensureRolesLine({ created: [], baseProvider: null, model: null, skipped: "cleaned-up" })!;
    const onAct = vi.fn();
    const idle = renderTree(RolesLineView({ line, busy: false, onAct, onDismiss: noop, styles, theme }));
    const [act] = pressables(idle);
    expect(texts([act!])).toEqual(["Set up again"]);
    expect(act!.props.accessibilityLabel).toBe("Set up paseo-bm's roles again");
    (act!.props.onPress as () => void)();
    expect(onAct).toHaveBeenCalledOnce();
    const busy = renderTree(RolesLineView({ line, busy: true, onAct, onDismiss: noop, styles, theme }));
    expect(pressables(busy)[0]!.props.disabled).toBe(true);
  });

  it("can be dismissed when it only reports roles created", () => {
    const line = ensureRolesLine({ created: ["manager", "worker"], baseProvider: "claude", model: "opus", skipped: null })!;
    const onDismiss = vi.fn();
    const nodes = renderTree(RolesLineView({ line, busy: false, onAct: noop, onDismiss, styles, theme }));
    const buttons = pressables(nodes);
    expect(buttons.map((button) => texts([button])[0])).toEqual(["Dismiss"]);
    expect(buttons[0]!.props.accessibilityLabel).toBe("Dismiss this line");
    (buttons[0]!.props.onPress as () => void)();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("a storage row (hook-free)", () => {
  const row = { workspaceId: "w2", label: "/work/old", detail: "30.0 MB · no longer in Paseo", state: "orphaned" as const };

  it("shows its cleanup only when opened, behind a labelled toggle", () => {
    const closed = renderTree(StorageRowView({ row, open: false, onToggle: noop, styles, children: "CLEANUP" }));
    expect(texts(closed)).toEqual(["/work/old", "30.0 MB · no longer in Paseo", "Clean up…"]);
    expect(closed.flatMap((node) => (typeof node === "string" ? [node] : []))).not.toContain("CLEANUP");
    const [toggle] = pressables(closed);
    expect(toggle!.props.accessibilityLabel).toBe("Delete or move the traces of /work/old");
    expect(toggle!.props.accessibilityState).toEqual({ expanded: false });
    expect(JSON.stringify(closed)).not.toContain("w2");

    const open = renderTree(StorageRowView({ row, open: true, onToggle: noop, styles, children: "CLEANUP" }));
    expect(JSON.stringify(open)).toContain("CLEANUP");
    expect(pressables(open)[0]!.props.accessibilityState).toEqual({ expanded: true });
  });
});

describe("every confirmation Settings shows defaults to Cancel", () => {
  const setup = readFileSync(fileURLToPath(new URL("../plugin/client/settings-blocks.tsx", import.meta.url)), "utf8");
  const ui = readFileSync(fileURLToPath(new URL("../plugin/client/ui.tsx", import.meta.url)), "utf8");
  const actions = readFileSync(fileURLToPath(new URL("../plugin/client/dashboard-actions.tsx", import.meta.url)), "utf8");
  const before = (source: string, first: string, second: string) => {
    const a = source.indexOf(first);
    const b = source.indexOf(second, a);
    return a >= 0 && b > a;
  };

  it("puts Cancel before the confirm button: tool install, agent tools and skills (ConfirmBlock), cleanup, traces", () => {
    const tool = setup.slice(setup.indexOf("export function ToolCard("), setup.indexOf("function SetupChecklistCard("));
    expect(before(tool, "Cancel: do not install", "Install ${tool.id} on this machine")).toBe(true);
    const confirm = ui.slice(ui.indexOf("export function ConfirmBlock("));
    expect(before(confirm, "dialog.cancelLabel", "dialog.confirmLabel")).toBe(true);
    const cleanup = setup.slice(setup.indexOf("export function CleanupBlock("));
    expect(before(cleanup, "CLEANUP_WARNING_DIALOG.cancelLabel", "CLEANUP_WARNING_DIALOG.confirmLabel")).toBe(true);
    expect(before(cleanup, "CLEANUP_DATA_DIALOG.keepLabel", "CLEANUP_DATA_DIALOG.deleteLabel")).toBe(true);
    expect(before(actions, "No, keep them", "described.confirmLabel}</Text>")).toBe(true);
  });
});
