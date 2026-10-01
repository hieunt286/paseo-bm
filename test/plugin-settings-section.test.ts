import { describe, expect, it, vi } from "vitest";
import type { RoleSetting, RolesOptions, SetupStatus } from "../plugin/shared/contracts";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { dashboardStyles } from "../plugin/client/styles";
import {
  ADVICE_MEANING,
  DEFAULT_OPEN_GROUPS,
  GROUP_LOADING,
  SETTINGS_GROUPS,
  THRESHOLD_NOTE,
  adviceCadenceText,
  adviceCadenceView,
  agentsGroupState,
  coordinationGroupState,
  dataGroupState,
  groupHeaderView,
  stepAdviceCadence,
  storageSummary,
  toggleGroup,
  toolsGroupState,
  type StoredWorkspaceBytes,
} from "../plugin/client/settings-model";
import {
  AGENT_TOOLS_DIALOG,
  cleanupDataQuestion,
  cleanupWarning,
  cleanupWarningDialog,
  ensureRolesLine,
  installDialog,
  skillsDialog,
} from "../plugin/client/settings-machine-model";
import { SAME_FAMILY_NOTICE, roleDraftOf, roleFormView } from "../plugin/client/settings-roles-model";
import type { ConfirmDialog } from "../plugin/client/ui-types";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";

/**
 * Settings (experience concept §4.4, autonomy design §A.12, §G.7): five groups,
 * each folded to one line with its state. The states are pure and tested
 * here; the hook-free pieces of `settings-section.tsx` are expanded with the
 * element-tree helper, `react-native` and the SDK being named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const sectionPath = "../plugin/client/settings-section.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { AdviceCadenceRow, SettingsGroupHeader, RolesLineView, StorageRowView } = (await import(sectionPath)) as {
  AdviceCadenceRow: Component;
  SettingsGroupHeader: Component;
  RolesLineView: Component;
  StorageRowView: Component;
};
const blocksPath = "../plugin/client/settings-blocks.tsx";
const { CleanupDataView, ReviewerFamilyNoteView, RoleFields, RunResultView } = (await import(blocksPath)) as {
  CleanupDataView: Component;
  ReviewerFamilyNoteView: Component;
  RoleFields: Component;
  RunResultView: Component;
};
const uiPath = "../plugin/client/ui.tsx";
const { ConfirmBlock } = (await import(uiPath)) as { ConfirmBlock: Component };

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

describe("the five groups (experience concept §4.4, autonomy design §G.7)", () => {
  it("are Agents, Autonomy, Coordination, Tools & skills and Data, in that order, all folded at first", () => {
    expect(SETTINGS_GROUPS.map((group) => group.title)).toEqual(["Agents", "Autonomy", "Coordination", "Tools & skills", "Data"]);
    expect(DEFAULT_OPEN_GROUPS.size).toBe(0);
    expect(SETTINGS_GROUPS.every((group) => group.hint.length > 0)).toBe(true);
  });

  it("open and close on a press, Autonomy (autonomy design §B.2) as the others", () => {
    const agents = toggleGroup(DEFAULT_OPEN_GROUPS, "agents");
    expect([...agents]).toEqual(["agents"]);
    expect([...toggleGroup(agents, "data")].sort()).toEqual(["agents", "data"]);
    expect([...toggleGroup(agents, "agents")]).toEqual([]);
    expect([...toggleGroup(DEFAULT_OPEN_GROUPS, "coordination")]).toEqual(["coordination"]);
    expect([...toggleGroup(DEFAULT_OPEN_GROUPS, "autonomy")]).toEqual(["autonomy"]);
    expect(SETTINGS_GROUPS.every((group) => group.opens)).toBe(true);
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

  it("names an unusable data folder and a cleanup", () => {
    const status = withSetup({ dataHome: { path: null, source: null, reason: "EACCES" } });
    expect(dataGroupState(status, null, true)).toEqual({
      text: "The data folder cannot be used · Settings removed",
      tone: "danger",
    });
  });
});

describe("the Coordination group (autonomy design §G.7)", () => {
  const settings = (everyFinished: number) => ({ ...DEFAULT_COORDINATION_SETTINGS, advice: { everyFinished } });

  it("reads 'Checking…' until the settings answer, then the advice cadence in words (0 is off) and the two switches", () => {
    expect(coordinationGroupState(undefined)).toEqual(GROUP_LOADING);
    expect(coordinationGroupState(settings(5))).toEqual({ text: "Advice after every 5 finished requests · compaction and handoff on", tone: "muted" });
    expect(coordinationGroupState(settings(1)).text).toBe("Advice after every finished request · compaction and handoff on");
    expect(coordinationGroupState(settings(0)).text).toBe("Advice off · compaction and handoff on");
    expect(coordinationGroupState(undefined, true)).toEqual({ text: "The coordination settings could not be read", tone: "danger" });
    expect(adviceCadenceText(12)).toBe("Advice after every 12 finished requests");
  });

  it("says what the cadence means in one line", () => {
    expect(ADVICE_MEANING.split("\n")).toHaveLength(1);
    expect(ADVICE_MEANING).toMatch(/finished requests/);
    expect(ADVICE_MEANING).toMatch(/0 turns advice off\.$/);
  });

  it("steps within 0 and 50", () => {
    expect(stepAdviceCadence(5, 1)).toBe(6);
    expect(stepAdviceCadence(5, -1)).toBe(4);
    expect(stepAdviceCadence(0, -1)).toBe(0);
    expect(stepAdviceCadence(50, 1)).toBe(50);
  });

  it("offers Save only for a changed value, the default only away from it, and nothing while saving", () => {
    const unchanged = adviceCadenceView({ stored: 5, draft: 5, defaultValue: 5, saving: false });
    expect(unchanged.save).toMatchObject({ enabled: false, label: "Save" });
    expect(unchanged.reset).toBeNull();
    expect(unchanged.valueText).toBe("Advice after every 5 finished requests");
    expect(unchanged.decrease).toEqual({ enabled: true, label: "−", accessibilityLabel: "Advice cadence: lower to 4" });
    expect(unchanged.increase).toEqual({ enabled: true, label: "+", accessibilityLabel: "Advice cadence: raise to 6" });

    const off = adviceCadenceView({ stored: 5, draft: 0, defaultValue: 5, saving: false });
    expect(off.valueText).toBe("Advice off");
    expect(off.decrease.enabled).toBe(false);
    expect(off.save).toEqual({ enabled: true, label: "Save", accessibilityLabel: "Save the advice cadence: Advice off" });
    expect(off.reset).toEqual({
      enabled: true,
      label: "Use the default (5)",
      accessibilityLabel: "Set the advice cadence back to its default: Advice after every 5 finished requests",
    });
    expect(adviceCadenceView({ stored: 5, draft: 1, defaultValue: 5, saving: false }).decrease.accessibilityLabel).toBe(
      "Advice cadence: lower to 0, off",
    );
    expect(adviceCadenceView({ stored: 5, draft: 50, defaultValue: 5, saving: false }).increase.enabled).toBe(false);

    const saving = adviceCadenceView({ stored: 5, draft: 7, defaultValue: 5, saving: true });
    expect(saving.save).toMatchObject({ enabled: false, label: "Saving…" });
    expect([saving.decrease.enabled, saving.increase.enabled, saving.reset?.enabled]).toEqual([false, false, false]);
  });

  it("is a card with the meaning, − value +, Save and the default, each pressable labelled (hook-free)", () => {
    const onStep = vi.fn();
    const onSave = vi.fn();
    const onReset = vi.fn();
    const view = adviceCadenceView({ stored: 5, draft: 3, defaultValue: 5, saving: false });
    const nodes = renderTree(AdviceCadenceRow({ view, error: null, onStep, onSave, onReset, styles, theme }));
    expect(texts(nodes)).toEqual(["Advice", ADVICE_MEANING, "−", "Advice after every 3 finished requests", "+", "Save", "Use the default (5)"]);
    const buttons = pressables(nodes);
    expect(buttons.map((button) => button.props.accessibilityRole)).toEqual(["button", "button", "button", "button"]);
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      "Advice cadence: lower to 2",
      "Advice cadence: raise to 4",
      "Save the advice cadence: Advice after every 3 finished requests",
      "Set the advice cadence back to its default: Advice after every 5 finished requests",
    ]);
    for (const button of buttons) expect(button.props.accessibilityState).toEqual({ disabled: false });
    (buttons[0]!.props.onPress as () => void)();
    (buttons[1]!.props.onPress as () => void)();
    (buttons[2]!.props.onPress as () => void)();
    (buttons[3]!.props.onPress as () => void)();
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
    expect(onSave).toHaveBeenCalledOnce();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("disables Save for an unchanged value and shows a failed save in the danger colour", () => {
    const view = adviceCadenceView({ stored: 5, draft: 5, defaultValue: 5, saving: false });
    const nodes = renderTree(
      AdviceCadenceRow({ view, error: "E_COORDINATION_INVALID: nothing was saved", onStep: noop, onSave: noop, onReset: noop, styles, theme }),
    );
    const save = pressables(nodes).find((button) => texts([button])[0] === "Save")!;
    expect(save.props.disabled).toBe(true);
    expect(save.props.accessibilityState).toEqual({ disabled: true });
    expect(pressables(nodes)).toHaveLength(3);
    const error = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_COORDINATION_INVALID"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
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

  it("opens Autonomy like the others: one button with the policy's line (autonomy design §B.2)", () => {
    const nodes = header(groupHeaderView("autonomy", { text: "Every decision is yours, in every project", tone: "muted" }, false));
    expect(pressables(nodes)).toHaveLength(1);
    expect(texts(nodes)).toEqual(["▸ Autonomy", "Every decision is yours, in every project"]);
    expect((nodes[0] as RNode).props.accessibilityLabel).toBe(
      "Autonomy, which decisions the agents may take for you: Every decision is yours, in every project. Expand.",
    );
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

describe("every confirmation Settings shows defaults to Cancel (rendered at phone and desktop widths)", () => {
  const status = readyStatus();
  const brMissing = { ...status.tools[0]!, path: null, installCommand: "brew install dicklesworthstone/tap/br" };
  /** The confirmation of each Settings block that grants something, as the block builds it. */
  const dialogs = [
    { name: "a tool's Install", dialog: installDialog(brMissing), busyLabel: "Installing… (up to 5 minutes)" },
    { name: "Paseo's agent tools", dialog: AGENT_TOOLS_DIALOG, busyLabel: "Allowing…" },
    { name: "the skills CLI", dialog: skillsDialog(status.skills.installCommand), busyLabel: "Running… (up to 5 minutes)" },
    { name: "the cleanup warning", dialog: cleanupWarningDialog(status), busyLabel: "Remove settings" },
  ];
  const widths = [
    { name: "phone", styles: dashboardStyles(theme as never, true) },
    { name: "desktop", styles: dashboardStyles(theme as never, false) },
  ];
  const draw = (dialog: ConfirmDialog, busy: boolean, width: (typeof widths)[number], on = { confirm: noop, cancel: noop }) =>
    renderTree(ConfirmBlock({ dialog, busy, busyLabel: "Working…", onConfirm: on.confirm, onCancel: on.cancel, styles: width.styles, theme }));

  for (const width of widths) {
    for (const { name, dialog } of dialogs) {
      it(`${name}: Cancel comes first and is the only other button, on a ${width.name}`, () => {
        const confirm = vi.fn();
        const cancel = vi.fn();
        const nodes = draw(dialog, false, width, { confirm, cancel });
        const buttons = pressables(nodes);
        expect(buttons.map((button) => texts([button])[0])).toEqual([dialog.cancelLabel, dialog.confirmLabel]);
        expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
          dialog.cancelAccessibilityLabel ?? dialog.cancelLabel,
          dialog.confirmAccessibilityLabel ?? dialog.confirmLabel,
        ]);
        expect(buttons[0]!.props.style).toBe(width.styles.secondaryButton);
        expect(buttons[1]!.props.style).toBe(width.styles.button);
        // The two buttons share one row that wraps, so a phone never pushes Install off the screen.
        const row = allNodes(nodes).find(
          (node) => node.type === "View" && node.children.filter((child) => typeof child !== "string" && child.type === "Pressable").length === 2,
        )!;
        expect(row.props.style).toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
        (buttons[0]!.props.onPress as () => void)();
        expect(cancel).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
        (buttons[1]!.props.onPress as () => void)();
        expect(confirm).toHaveBeenCalledOnce();
      });
    }
  }

  it("a tool's Install and the cleanup warning read as before: no title, the warning in its colour, then the buttons", () => {
    const [install, , , warning] = dialogs;
    for (const width of widths) {
      const tool = draw(install!.dialog, false, width);
      expect(texts(tool)).toEqual(["This runs Homebrew on this machine: brew install dicklesworthstone/tap/br", "Cancel", "Install br"]);
      expect(JSON.stringify(allNodes(tool)[1]!.props.style)).toContain("#statusWarning");
      const cleanup = draw(warning!.dialog, false, width);
      expect(texts(cleanup)).toEqual([cleanupWarning(status), "Cancel", "Remove settings"]);
      expect(JSON.stringify(allNodes(cleanup)[1]!.props.style)).toContain("#statusDanger");
    }
    // A dialog with a title keeps it, in the warning colour, above a plain body.
    const titled = draw(AGENT_TOOLS_DIALOG, false, widths[1]!);
    expect(texts(titled).slice(0, 2)).toEqual([AGENT_TOOLS_DIALOG.title, AGENT_TOOLS_DIALOG.body]);
    expect(JSON.stringify(allNodes(titled)[1]!.props.style)).toContain("#statusWarning");
    expect(allNodes(titled)[2]!.props.style).toBe(widths[1]!.styles.body);
  });

  it("while it runs, Cancel is gone and the confirm button says what is happening, disabled", () => {
    const nodes = renderTree(
      ConfirmBlock({ dialog: dialogs[0]!.dialog, busy: true, busyLabel: dialogs[0]!.busyLabel, onConfirm: noop, onCancel: noop, styles, theme }),
    );
    const buttons = pressables(nodes);
    expect(buttons.map((button) => texts([button])[0])).toEqual(["Installing… (up to 5 minutes)"]);
    expect(buttons[0]!.props.disabled).toBe(true);
    expect(buttons[0]!.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(buttons[0]!.props.accessibilityLabel).toBe("Install br on this machine");
  });

  it("the cleanup's data question puts Keep my data first, and hides Delete while it runs", () => {
    const question = cleanupDataQuestion(status);
    for (const width of widths) {
      const onKeep = vi.fn();
      const onDelete = vi.fn();
      const idle = renderTree(CleanupDataView({ question, busy: false, onKeep, onDelete, styles: width.styles, theme }));
      expect(texts(idle)).toEqual([question, "Keep my data", "Delete data"]);
      const [keep, remove] = pressables(idle);
      expect(keep!.props.accessibilityLabel).toBe("Remove the settings and keep my data");
      expect(keep!.props.style).toBe(width.styles.button);
      expect(remove!.props.accessibilityLabel).toBe("Remove the settings and delete paseo-bm's data");
      expect(JSON.stringify(remove!.props.style)).not.toContain("#statusDanger");
      expect(JSON.stringify(allNodes([remove!]).find((node) => node.type === "Text")!.props.style)).toContain("#statusDanger");
      (keep!.props.onPress as () => void)();
      (remove!.props.onPress as () => void)();
      expect(onKeep).toHaveBeenCalledOnce();
      expect(onDelete).toHaveBeenCalledOnce();

      const busy = renderTree(CleanupDataView({ question, busy: true, onKeep: noop, onDelete: noop, styles: width.styles, theme }));
      expect(pressables(busy).map((button) => texts([button])[0])).toEqual(["Removing…"]);
      expect(pressables(busy)[0]!.props.accessibilityState).toEqual({ disabled: true, busy: true });
    }
  });
});

describe("the role fields both Edit forms share (hook-free)", () => {
  const claude: RolesOptions = {
    provider: "claude",
    capability: "tiered",
    models: [
      {
        id: "claude-opus-5",
        label: "Opus 5",
        thinkingOptions: [{ id: "high", label: "High" }],
        defaultThinkingOptionId: null,
        cost: { inputUsdPerMTok: 5, cacheReadUsdPerMTok: 0.5, outputUsdPerMTok: 25 },
      },
    ],
    modes: [{ id: "default", label: "Default", colorTier: "safe" }],
    autoAccept: false,
  };
  const setting: RoleSetting = {
    role: "worker",
    providerId: "bm-worker",
    baseProvider: "claude",
    label: null,
    model: "claude-opus-5",
    thinkingOptionId: "high",
    modeId: null,
    featureValues: {},
    capability: "tiered",
  };
  const view = (options: RolesOptions | undefined) =>
    roleFormView({ role: "worker", setting, available: ["claude", "codex"], draft: roleDraftOf(setting), options });

  for (const compact of [true, false]) {
    it(`draw provider, model with its price, thinking and mode, on a ${compact ? "phone" : "desktop"}`, () => {
      const width = dashboardStyles(theme as never, compact);
      const onChange = vi.fn();
      const nodes = renderTree(RoleFields({ view: view(claude), loading: false, error: null, onChange, styles: width, theme }));
      expect(texts(nodes)).toEqual([
        "Provider",
        "● Claude",
        "Codex",
        "Model",
        "● Opus 5",
        "~$5 / $25 per 1M tokens",
        "Thinking",
        "Provider default",
        "● High",
        "Mode",
        "● Not set",
        "Default",
      ]);
      // Every row of chips wraps, so a phone stacks them instead of overflowing.
      const rows = allNodes(nodes).filter((node) => node.type === "View" && node.props.style === width.chipRow);
      expect(rows).toHaveLength(4);
      expect(width.chipRow).toMatchObject({ flexDirection: "row", flexWrap: "wrap" });
      // A chip edits the draft through one function, the same for both forms.
      const codex = pressables(nodes).find((button) => texts([button])[0] === "Codex")!;
      (codex.props.onPress as () => void)();
      const next = onChange.mock.calls[0]![0] as (draft: ReturnType<typeof roleDraftOf>) => ReturnType<typeof roleDraftOf>;
      expect(next(roleDraftOf(setting))).toEqual({ ...roleDraftOf(setting), baseProvider: "codex" });
    });
  }

  it("show the spinner while the options load, and the failure instead of the blocker", () => {
    const loading = renderTree(RoleFields({ view: view(undefined), loading: true, error: null, onChange: noop, styles, theme }));
    expect(allNodes(loading).some((node) => node.type === "ActivityIndicator")).toBe(true);
    expect(texts(loading)).toContain("Loading the models of Claude…");
    const failed = renderTree(RoleFields({ view: view(undefined), loading: false, error: "E_ROLE_OPTIONS: boom", onChange: noop, styles, theme }));
    expect(texts(failed)).toContain("E_ROLE_OPTIONS: boom");
    expect(texts(failed)).not.toContain("Loading the models of Claude…");
    const error = allNodes(failed).find((node) => node.type === "Text" && texts([node])[0] === "E_ROLE_OPTIONS: boom")!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });
});

describe("the Reviewer's same-family line (hook-free, autonomy design §C.5)", () => {
  const note = { text: SAME_FAMILY_NOTICE, tone: "warning" as const };

  for (const compact of [true, false]) {
    it(`is one line in the warning colour, and nothing without a note, on a ${compact ? "phone" : "desktop"}`, () => {
      const width = dashboardStyles(theme as never, compact);
      const nodes = renderTree(ReviewerFamilyNoteView({ note, styles: width, theme }));
      expect(texts(nodes)).toEqual([SAME_FAMILY_NOTICE]);
      expect(pressables(nodes)).toHaveLength(0);
      const line = allNodes(nodes).find((node) => node.type === "Text")!;
      expect(JSON.stringify(line.props.style)).toContain("#statusWarning");
      expect(renderTree(ReviewerFamilyNoteView({ note: null, styles: width, theme }))).toEqual([]);
    });
  }
});

describe("an install run's result (hook-free)", () => {
  it("shows its line in its tone and the output tail only when there is one", () => {
    const done = renderTree(RunResultView({ result: { text: "Installed with `brew install br`.", tone: "success", tail: ["==> Pouring br", "done"] }, styles, theme }));
    expect(texts(done)).toEqual(["Installed with `brew install br`.", "==> Pouring br\ndone"]);
    expect(JSON.stringify(allNodes(done)[1]!.props.style)).toContain("#statusSuccess");
    expect(allNodes(done)[2]!.props.selectable).toBe(true);
    const failed = renderTree(RunResultView({ result: { text: "E_SETUP_INSTALL_FAILED: exit 1", tone: "danger", tail: [] }, styles, theme }));
    expect(texts(failed)).toEqual(["E_SETUP_INSTALL_FAILED: exit 1"]);
    expect(JSON.stringify(allNodes(failed)[1]!.props.style)).toContain("#statusDanger");
  });
});
