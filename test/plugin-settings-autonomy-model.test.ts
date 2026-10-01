import { describe, expect, it, vi } from "vitest";
import {
  AUTONOMY_CLASS_ORDER,
  AUTONOMY_MEANING,
  BOUNDARY_LABEL,
  BOUNDARY_MEANING,
  CUSTOM_SUMMARY,
  DECIDER_LEGEND,
  DECIDER_LEGEND_ENTRIES,
  LEVEL_CLASS_LABELS,
  LEVEL_SUMMARIES,
  autonomyLevelView,
  autonomyProjects,
  autonomyTabs,
  boundaryView,
  deciderAtLevel,
  levelConfirmDialog,
  levelPressOf,
  setLevelInputOf,
  shownProjectOf,
} from "../plugin/client/settings-autonomy-model";
// The precedents, under Settings → More (autonomy design §B.6).
import {
  ADD_PRECEDENT_LABEL,
  PRECEDENTS_MEANING,
  PRECEDENTS_NONE,
  PRECEDENTS_UI_IDLE,
  openPrecedentForm,
  precedentExpiresText,
  precedentSaveInputOf,
  precedentScopeText,
  precedentsView,
  type PrecedentsUi,
} from "../plugin/client/settings-autonomy-model";
import type { Precedent } from "../plugin/shared/precedents";
import {
  AUTONOMY_LEVELS,
  EMPTY_AUTONOMY_POLICY,
  LEVELS,
  autonomyPolicyOf,
  withBoundary,
  withCell,
  withChallenger,
  withLevel,
  type AutonomyLevel,
  type AutonomyPolicy,
} from "../plugin/shared/autonomy";
import { DECISION_CLASSES } from "../plugin/shared/decisions";
import { allNodes, pressables, renderTree, texts } from "./helpers/element-tree";

/**
 * Settings → Autonomy (ADR-025; change-014 outcome 5): one level per project
 * on five stops, the classes it delegates, the confirmation of Turbo and Full
 * auto, Custom, and the action boundary under it. The view model is pure and
 * tested here; the hook-free `LevelControl` and `BoundarySwitch` of
 * `settings-autonomy.tsx` are expanded with the element-tree helper,
 * `react-native` being named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const modulePath = "../plugin/client/settings-autonomy.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { LevelControl, BoundarySwitch } = (await import(modulePath)) as { LevelControl: Component; BoundarySwitch: Component };
const precedentsPath = "../plugin/client/settings-precedents.tsx";
const { PrecedentsList } = (await import(precedentsPath)) as { PrecedentsList: Component };

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;
const AT = "2026-10-01T08:00:00.000Z";
const PROJECT = { id: "ws-1", label: "paseo-bm" };

const atLevel = (level: AutonomyLevel, policy: AutonomyPolicy = EMPTY_AUTONOMY_POLICY) => withLevel(policy, "ws-1", level, AT);
const view = (policy: AutonomyPolicy, extra: { busy?: boolean; confirmingLevel?: AutonomyLevel | null; confirmingBoundary?: boolean | null } = {}) =>
  autonomyLevelView({ policy, project: PROJECT, busy: extra.busy ?? false, confirmingLevel: extra.confirmingLevel ?? null, confirmingBoundary: extra.confirmingBoundary ?? null });
const draw = (shown: ReturnType<typeof autonomyLevelView>, on: { onPick?: unknown; onConfirm?: unknown; onCancel?: unknown; error?: string | null; busy?: boolean } = {}) =>
  renderTree(
    LevelControl({
      view: shown,
      error: on.error ?? null,
      busy: on.busy ?? false,
      onPick: on.onPick ?? noop,
      onConfirm: on.onConfirm ?? noop,
      onCancel: on.onCancel ?? noop,
      styles,
      theme,
    }),
  );
const whoOf = (shown: ReturnType<typeof autonomyLevelView>) => shown.classes.map((entry) => entry.who);

describe("the level control of one project (ADR-025, change-014 outcome 5)", () => {
  it("has five stops, Hands-on to Full auto, each a labelled radio in one radio group; a new project reads Hands-on", () => {
    const shown = view(EMPTY_AUTONOMY_POLICY);
    expect(shown.reading).toBe(0);
    expect(shown.levelLine).toBe("Level: Hands-on");
    expect(shown.stops.map((stop) => [stop.label, stop.accessibilityLabel, stop.selected, stop.enabled])).toEqual([
      ["0 Hands-on", "Level 0: Hands-on", true, false],
      ["1 Co-pilot", "Level 1: Co-pilot", false, true],
      ["2 Cruise", "Level 2: Cruise", false, true],
      ["3 Turbo", "Level 3: Turbo", false, true],
      ["4 Full auto", "Level 4: Full auto", false, true],
    ]);
    const nodes = draw(shown);
    const group = allNodes(nodes).find((node) => node.props.accessibilityRole === "radiogroup")!;
    expect(group.props.accessibilityLabel).toBe("Autonomy level of paseo-bm");
    const radios = pressables([group]);
    expect(radios.map((radio) => radio.props.accessibilityRole)).toEqual(["radio", "radio", "radio", "radio", "radio"]);
    expect(radios.map((radio) => radio.props.accessibilityLabel)).toEqual(LEVELS.map((level) => `Level ${level.level}: ${level.name}`));
    // Each stop is a numbered square knob over its name (the approved mockup); the selected knob is filled with the accent.
    expect(radios.map((radio) => texts([radio]))).toEqual(LEVELS.map((level) => [String(level.level), level.name]));
    const knobFill = (radio: (typeof radios)[number]) => (allNodes([radio]).find((node) => node.type === "View")!.props.style as { backgroundColor: string }).backgroundColor;
    expect(radios.map(knobFill)).toEqual(["#accent", "#surface1", "#surface1", "#surface1", "#surface1"]);
    expect(shown.stops.map((stop) => stop.place)).toEqual(["selected", "above", "above", "above", "above"]);
    expect(shown.fill).toBe(0);
    expect(radios[0]!.props.accessibilityState).toEqual({ selected: true, checked: true, disabled: true });
    expect(AUTONOMY_MEANING).toMatch(/Your overrides are recorded; they never change the level\.$/);
  });

  it("says what each level means and who decides each class at it, in the order the levels add them", () => {
    expect(AUTONOMY_CLASS_ORDER.slice(0, 5)).toEqual(LEVELS[2]!.delegated);
    expect(AUTONOMY_CLASS_ORDER.slice(5)).toEqual(["cost", "release", "data", "security"]);
    expect([...AUTONOMY_CLASS_ORDER].sort()).toEqual([...DECISION_CLASSES].sort());
    const you = Array(9).fill("You");
    const approve = Array(9).fill("You approve");
    expect(whoOf(view(atLevel(0)))).toEqual(you);
    expect(whoOf(view(atLevel(1)))).toEqual(approve);
    expect(whoOf(view(atLevel(2)))).toEqual([...Array(5).fill("Orchestrator"), ...Array(4).fill("You approve")]);
    expect(whoOf(view(atLevel(3)))).toEqual([...Array(8).fill("Orchestrator"), "You approve"]);
    expect(whoOf(view(atLevel(4)))).toEqual(Array(9).fill("Orchestrator"));
    for (const level of AUTONOMY_LEVELS) {
      const shown = view(atLevel(level));
      expect(shown.reading).toBe(level);
      expect(shown.summary).toBe(LEVEL_SUMMARIES[level]);
      expect(shown.stops.filter((stop) => stop.selected).map((stop) => stop.level)).toEqual([level]);
      for (const decisionClass of DECISION_CLASSES) {
        expect(deciderAtLevel(level, decisionClass) === "orchestrator").toBe(LEVELS[level]!.delegated.includes(decisionClass));
      }
    }
    expect(LEVEL_SUMMARIES[3]).toBe("Turbo. As Cruise, plus cost, release and data. Security still waits for your approval.");

    const nodes = draw(view(atLevel(2)));
    expect(texts(nodes)).toEqual(expect.arrayContaining([LEVEL_SUMMARIES[2], ...DECIDER_LEGEND_ENTRIES.map((entry) => entry.text), ...Object.values(LEVEL_CLASS_LABELS)]));
    expect(DECIDER_LEGEND).toBe("Orchestrator decides, you can override · Orchestrator proposes, you approve · You decide");
    // Below the level shown the knobs are outlined in the accent; the track is filled half way at Cruise.
    const cruise = view(atLevel(2));
    expect(cruise.stops.map((stop) => stop.place)).toEqual(["below", "below", "selected", "above", "above"]);
    expect(cruise.fill).toBe(0.5);
    // Who decides is coloured: the Orchestrator in the accent, your approval in full contrast, you muted.
    const who = (text: string) => allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0] === text)!;
    expect(JSON.stringify(who("Orchestrator").props.style)).toContain("#accent");
    expect(JSON.stringify(who("You approve").props.style)).toContain("#foreground");
    // Three columns: each class a third of the row.
    const cells = allNodes(nodes).filter((node) => node.type === "View" && typeof node.props.accessibilityLabel === "string" && String(node.props.accessibilityLabel).includes(": "));
    expect(cells.map((cell) => cell.props.accessibilityLabel).slice(0, 2)).toEqual(["Technical: Orchestrator", "Preference: Orchestrator"]);
    expect(cells.every((cell) => (cell.props.style as { width: string }).width === "33.33%")).toBe(true);
  });

  it("sets Hands-on, Co-pilot and Cruise at once; Turbo and Full auto ask first; the level already set does nothing", () => {
    expect(levelPressOf(2, 2)).toBe("none");
    expect(levelPressOf(0, 1)).toBe("set");
    expect(levelPressOf(4, 2)).toBe("set");
    expect(levelPressOf("custom", 0)).toBe("set");
    expect(levelPressOf(2, 3)).toBe("confirm");
    expect(levelPressOf(3, 4)).toBe("confirm");
    expect(levelPressOf(4, 3)).toBe("confirm");
    expect(setLevelInputOf("ws-1", 2)).toEqual({ workspaceId: "ws-1", level: 2 });
    expect(setLevelInputOf("ws-1", 3)).toEqual({ workspaceId: "ws-1", level: 3, confirmed: true });
    expect(setLevelInputOf("ws-1", 4)).toEqual({ workspaceId: "ws-1", level: 4, confirmed: true });

    const onPick = vi.fn();
    const nodes = draw(view(atLevel(1)), { onPick });
    (pressables(nodes).find((button) => button.props.accessibilityLabel === "Level 2: Cruise")!.props.onPress as () => void)();
    (pressables(nodes).find((button) => button.props.accessibilityLabel === "Level 4: Full auto")!.props.onPress as () => void)();
    expect(onPick.mock.calls).toEqual([[2], [4]]);
    // Nothing is confirmed yet: no confirmation is drawn.
    expect(texts(nodes)).not.toContain("Cancel");
  });

  it("confirms Turbo and Full auto in place with what the Orchestrator will decide, Cancel first and the default", () => {
    expect(levelConfirmDialog(3, "paseo-bm")).toEqual({
      title: "Let the Orchestrator decide cost, release and data?",
      body: "Releases, pushes, deploys, migrations on real data and spending will be decided without you. Each one shows under Decided for you, where you can override it.",
      confirmLabel: "Switch to Turbo",
      cancelLabel: "Cancel",
      confirmAccessibilityLabel: "Switch paseo-bm to Turbo",
      defaultAction: "cancel",
    });
    expect(levelConfirmDialog(4, "paseo-bm")).toMatchObject({
      title: "Let the Orchestrator decide security questions too?",
      body: "Security trade-offs, permissions and credentials questions will be answered without you. Each one still shows under Decided for you, where you can override it.",
      confirmLabel: "Switch to Full auto",
    });

    // While it is asked, the stop asked and its meaning are shown; the level set is still pressable (it cancels).
    const asked = view(atLevel(2), { confirmingLevel: 4 });
    expect(asked.reading).toBe(2);
    expect(asked.levelLine).toBe("Level: Cruise");
    expect(asked.stops.map((stop) => stop.selected)).toEqual([false, false, false, false, true]);
    expect(asked.stops[2]!.enabled).toBe(true);
    expect(asked.summary).toBe(LEVEL_SUMMARIES[4]);
    expect(whoOf(asked)).toEqual(Array(9).fill("Orchestrator"));
    expect(asked.confirm).toEqual({ level: 4, dialog: levelConfirmDialog(4, "paseo-bm") });

    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const nodes = draw(asked, { onConfirm, onCancel });
    const labels = pressables(nodes).map((button) => texts([button])[0]);
    expect(labels.slice(5)).toEqual(["Cancel", "Switch to Full auto"]);
    const byText = (text: string) => pressables(nodes).find((button) => texts([button])[0] === text)!;
    (byText("Cancel").props.onPress as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    (byText("Switch to Full auto").props.onPress as () => void)();
    expect(onConfirm).toHaveBeenCalledOnce();
    // While it saves, Cancel is gone and the confirm button says so.
    expect(pressables(draw(asked, { busy: true })).map((button) => texts([button])[0]).slice(5)).toEqual(["Saving…"]);
  });

  it("reads Custom when the cells match no level: no stop selected, each class by its own cell, read-only", () => {
    const custom = withCell(withChallenger(EMPTY_AUTONOMY_POLICY, "ws-1", true), "ws-1", "release", { mode: "delegate", at: AT });
    const withShadow = withCell(custom, "ws-1", "scope", { mode: "shadow", at: AT });
    const shown = view(withShadow);
    expect(shown.reading).toBe("custom");
    expect(shown.levelLine).toBe("Level: Custom");
    expect(shown.summary).toBe(CUSTOM_SUMMARY);
    expect(shown.stops.every((stop) => !stop.selected && stop.enabled)).toBe(true);
    expect(Object.fromEntries(shown.classes.map((entry) => [entry.decisionClass, entry.who]))).toMatchObject({
      release: "Orchestrator",
      scope: "You approve",
      preference: "You",
    });
    // Predictions off: a shadow cell is still the owner's alone.
    const quiet = withCell(withChallenger(withShadow, "ws-1", false), "ws-1", "release", { mode: "delegate", at: AT });
    expect(view(quiet).classes.find((entry) => entry.decisionClass === "scope")!.who).toBe("You");
    // Nothing in the list can be pressed: only the five stops are.
    expect(pressables(draw(shown))).toHaveLength(5);
  });

  it("disables every stop while a change runs, and shows a failed change in the danger colour", () => {
    const busy = view(atLevel(1), { busy: true });
    expect(busy.stops.every((stop) => !stop.enabled)).toBe(true);
    const nodes = draw(busy, { error: "E_AUTONOMY_NOT_CONFIRMED: nothing was saved" });
    const error = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_AUTONOMY_NOT_CONFIRMED"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
    expect(JSON.stringify(nodes)).not.toContain("ws-1");
  });
});

/**
 * Hold risky actions for approval — the action boundary (autonomy design
 * §D.2, change-010 C2–C4): off by default; each side asks for a confirmation
 * in place, Cancel first, that says what changes; a level leaves it alone.
 */
describe("the action boundary switch (change-010 C2–C4)", () => {
  const on = withBoundary(EMPTY_AUTONOMY_POLICY, "ws-1", AT);

  it("is off by default; on shows since when; a level does not touch it", () => {
    const off = boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, false);
    expect(off).toMatchObject({ label: BOUNDARY_LABEL, on: false, stateText: "Off", since: null, confirm: null, caption: BOUNDARY_MEANING });
    expect(off.toggle).toEqual({ label: "Off", pressable: true, accessibilityLabel: "Hold risky actions for approval in paseo-bm…" });
    expect(boundaryView(on, PROJECT, false)).toMatchObject({ on: true, stateText: "On", since: "On since 2026-10-01" });
    expect(boundaryView(on, PROJECT, false).toggle.accessibilityLabel).toBe("Stop holding risky actions in paseo-bm…");
    expect(boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, true).toggle.pressable).toBe(false);
    expect(view(atLevel(4, on)).boundary.on).toBe(true);
    expect(BOUNDARY_LABEL).toBe("Hold risky actions for approval");
    expect(BOUNDARY_MEANING.split("\n")).toHaveLength(1);
  });

  it("turning on asks: the least permissive mode, what waits for the owner, existing agents keep their mode", () => {
    const asking = boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, false, true);
    expect(asking.toggle.pressable).toBe(false);
    const dialog = asking.confirm!;
    expect(dialog).toMatchObject({ title: "Hold risky actions for approval in paseo-bm?", confirmLabel: "Turn on", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(dialog.body).toMatch(/created from now on in this project run in the least permissive mode \(Claude: default; Codex: auto with its creation options\)/);
    expect(dialog.body).toMatch(/a release, real data, a dependency install, the network, a write outside the workspace, or a request it cannot read — waits for you/);
    expect(dialog.body).toMatch(/unless your answer to the Worker's question \(a grant: one use, 60 minutes\) or the project's level lets the Orchestrator decide it/);
    expect(dialog.body).toMatch(/Agents that already exist keep their mode\./);
    // Pressing the side already chosen asks nothing.
    expect(boundaryView(on, PROJECT, false, true).confirm).toBeNull();
  });

  it("turning off asks too: today's modes under detection; agents created while it was on keep their mode", () => {
    const dialog = boundaryView(on, PROJECT, false, false).confirm!;
    expect(dialog).toMatchObject({ title: "Stop holding risky actions in paseo-bm?", confirmLabel: "Turn off", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(dialog.body).toMatch(/their actions are only watched \(detection\), not held/);
  });

  it("draws one switch: a press asks, the confirmation's Cancel comes first and sends nothing", () => {
    const onToggle = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const closed = renderTree(BoundarySwitch({ view: boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, false), busy: false, onToggle, onConfirm: noop, onCancel: noop, styles, theme }));
    expect(texts(closed)).toEqual([BOUNDARY_LABEL, BOUNDARY_MEANING]);
    const [toggle] = pressables(closed);
    expect(toggle!.props.accessibilityRole).toBe("switch");
    expect(toggle!.props.accessibilityState).toEqual({ checked: false, disabled: false });
    (toggle!.props.onPress as () => void)();
    expect(onToggle).toHaveBeenCalledOnce();
    const open = renderTree(BoundarySwitch({ view: boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, false, true), busy: false, onToggle, onConfirm, onCancel, styles, theme }));
    expect(pressables(open).map((button) => texts([button])[0])).toEqual([undefined, "Cancel", "Turn on"]);
    expect(pressables(open)[0]!.props.accessibilityRole).toBe("switch");
    expect(pressables(open)[0]!.props.disabled).toBe(true);
    (pressables(open)[1]!.props.onPress as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    (pressables(open)[2]!.props.onPress as () => void)();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(JSON.stringify(open)).not.toContain("ws-1");
    // On: the switch is checked, and its line says since when.
    const lit = renderTree(BoundarySwitch({ view: boundaryView(on, PROJECT, false), busy: false, onToggle, onConfirm, onCancel, styles, theme }));
    expect(texts(lit)[1]).toBe(`On since 2026-10-01. ${BOUNDARY_MEANING}`);
    expect(pressables(lit)[0]!.props.accessibilityState).toEqual({ checked: true, disabled: false });
  });
});

describe("the projects and their tabs", () => {
  const named = [
    { id: "ws-1", label: "paseo-bm" },
    { id: "ws-2", label: "shop (closed)" },
  ];

  it("names projects as Insights does, then any project the policy still holds something for, unnamed and never by id", () => {
    const policy = autonomyPolicyOf({
      version: 1,
      projects: { "ws-9": { scope: { mode: "shadow", at: AT } }, "ws-8": { scope: { mode: "owner", at: AT } }, "ws-1": { scope: { mode: "shadow", at: AT } } },
      challenger: { "ws-7": true, "ws-6": false },
      boundary: { "ws-5": { enabled: true, at: AT } },
    });
    expect(autonomyProjects(named, policy).map((project) => project.label)).toEqual([
      "paseo-bm",
      "shop (closed)",
      "Unnamed project 1",
      "Unnamed project 2",
      "Unnamed project 3",
    ]);
    expect(autonomyProjects(named, policy).slice(2).map((project) => project.id).sort()).toEqual(["ws-5", "ws-7", "ws-9"]);
    expect(autonomyProjects(named, undefined)).toEqual(named);
    expect(autonomyProjects([], withLevel(EMPTY_AUTONOMY_POLICY, "a", 2, AT))).toEqual([{ id: "a", label: "Unnamed project" }]);
  });

  it("shows the chosen project while it is listed, else the first", () => {
    expect(shownProjectOf(named, "ws-2")?.label).toBe("shop (closed)");
    expect(shownProjectOf(named, "gone")?.label).toBe("paseo-bm");
    expect(shownProjectOf([], null)).toBeNull();
  });

  it("gives each tab its project's level, Custom included", () => {
    const policy = withCell(withChallenger(atLevel(2), "ws-2", true), "ws-2", "security", { mode: "delegate", at: AT });
    expect(autonomyTabs(named, policy)).toEqual([
      { key: "ws-1", label: "paseo-bm", suffix: "Cruise", accessibilityLabel: "paseo-bm, level Cruise" },
      { key: "ws-2", label: "shop (closed)", suffix: "Custom", accessibilityLabel: "shop (closed), level Custom" },
    ]);
    expect(autonomyTabs(named, EMPTY_AUTONOMY_POLICY).map((tab) => tab.suffix)).toEqual(["Hands-on", "Hands-on"]);
  });
});

describe("the precedents under More (autonomy design §B.6, §B.9)", () => {
  const NOW = new Date("2026-09-30T10:00:00.000Z");
  const projects = [
    { id: "ws-1", label: "paseo-bm" },
    { id: "ws-2", label: "shop" },
  ];
  const precedent = (overrides: Partial<Precedent>): Precedent => ({
    id: "p:1",
    scope: "ws-1",
    subject: "test-layout",
    text: "One test file per module.",
    sourceDecisionId: "q:req-20260929T073348Z:Q1",
    createdAt: "2026-09-29T08:00:00.000Z",
    expiresAt: "2026-10-29T08:00:00.000Z",
    supersededBy: null,
    ...overrides,
  });
  const list = [
    precedent({}),
    precedent({ id: "p:2", scope: "all", subject: "commit-style", text: "Conventional commits.", sourceDecisionId: null, createdAt: "2026-09-28T08:00:00.000Z" }),
    precedent({ id: "p:3", scope: "ws-gone", subject: "push-backends", text: "Push the contract only.", expiresAt: "2026-09-30T20:00:00.000Z" }),
  ];
  const shown = (ui: PrecedentsUi = PRECEDENTS_UI_IDLE, precedents: readonly Precedent[] = list) => precedentsView({ precedents, projects, ui, now: NOW });
  const handlers = () => ({ add: vi.fn(), form: vi.fn(), cancelForm: vi.fn(), save: vi.fn(), end: vi.fn(), cancelEnd: vi.fn(), confirmEnd: vi.fn() });
  const drawList = (view: ReturnType<typeof precedentsView>, on = handlers()) => renderTree(PrecedentsList({ view, on, styles, theme }));
  const labelsOf = (nodes: ReturnType<typeof renderTree>) => pressables(nodes).map((button) => button.props.accessibilityLabel);

  it("lists each active precedent with its project by name, subject, answer, expiry and source — never an id", () => {
    const view = shown();
    expect(view.rows.map((row) => [row.scopeText, row.subject, row.text, row.expiresText, row.sourceText])).toEqual([
      ["paseo-bm", "test-layout", "One test file per module.", "Until 2026-10-29 · 29 days left", "From your answer on 2026-09-29"],
      ["All projects", "commit-style", "Conventional commits.", "Until 2026-10-29 · 29 days left", "Added in Settings on 2026-09-28"],
      ["Unnamed project", "push-backends", "Push the contract only.", "Until 2026-09-30 · expires within a day", "From your answer on 2026-09-29"],
    ]);
    expect(precedentScopeText("all", projects)).toBe("All projects");
    expect(precedentExpiresText("2026-10-02T10:00:00.000Z", NOW)).toBe("Until 2026-10-02 · 2 days left");
    expect(view.empty).toBeNull();
    expect(view.add).toEqual({ label: ADD_PRECEDENT_LABEL, enabled: true, accessibilityLabel: "Add a precedent: a standing answer for a subject" });

    const nodes = drawList(view);
    expect(texts(nodes)).toEqual(expect.arrayContaining(["Precedents", "test-layout · paseo-bm", "One test file per module.", "Add precedent…"]));
    const serialised = JSON.stringify(nodes);
    for (const id of ["p:1", "p:2", "p:3", "ws-1", "ws-gone", "q:req-20260929T073348Z:Q1"]) expect(serialised).not.toContain(id);
    for (const button of pressables(nodes)) {
      expect(button.props.accessibilityRole).toBe("button");
      expect(String(button.props.accessibilityLabel ?? "")).not.toBe("");
    }
    expect(labelsOf(nodes)).toEqual([
      "End the precedent on test-layout in paseo-bm",
      "End the precedent on commit-style in All projects",
      "End the precedent on push-backends in Unnamed project",
      "Add a precedent: a standing answer for a subject",
    ]);
  });

  it("says so when there is none, and what a precedent does — for every class (ADR-025: none is the owner's by rule)", () => {
    expect(PRECEDENTS_MEANING).toBe("Your standing answers: a later question on the same subject gets it without asking you, until it expires.");
    const view = shown(PRECEDENTS_UI_IDLE, []);
    expect(view.empty).toBe(PRECEDENTS_NONE);
    expect(texts(drawList(view))).toContain(PRECEDENTS_NONE);
  });

  it("ends a precedent only after its confirmation, Cancel first and the default", () => {
    const on = handlers();
    (pressables(drawList(shown(), on))[0]!.props.onPress as () => void)();
    expect(on.end).toHaveBeenCalledWith("p:1");

    const confirming = shown({ ...PRECEDENTS_UI_IDLE, ending: "p:1" });
    expect(confirming.rows[0]!.confirm).toEqual({
      title: 'End the precedent on "test-layout"?',
      body: 'Later questions on "test-layout" in paseo-bm come to you again. To change it, end it and add a new one.',
      confirmLabel: "End precedent",
      cancelLabel: "Cancel",
      defaultAction: "cancel",
    });
    expect(confirming.rows[1]!.confirm).toBeNull();
    // While one is being confirmed, no other End and no Add.
    expect(confirming.rows.map((row) => row.end.enabled)).toEqual([false, false, false]);
    expect(confirming.add?.enabled).toBe(false);
    const nodes = drawList(confirming, on);
    expect(labelsOf(nodes).slice(0, 2)).toEqual(["Cancel", "End precedent"]);
    (pressables(nodes)[0]!.props.onPress as () => void)();
    expect(on.cancelEnd).toHaveBeenCalledOnce();
    (pressables(nodes)[1]!.props.onPress as () => void)();
    expect(on.confirmEnd).toHaveBeenCalledOnce();
  });

  it("adds one with a form: the project shown (or all), a subject slug and the answer, Cancel first", () => {
    expect(openPrecedentForm("ws-2")).toEqual({ scope: "ws-2", subject: "", text: "" });
    expect(openPrecedentForm(null)).toEqual({ scope: "all", subject: "", text: "" });
    const empty = shown({ ...PRECEDENTS_UI_IDLE, form: openPrecedentForm("ws-2") });
    expect(empty.add).toBeNull();
    expect(empty.form?.scopes.map((choice) => [choice.label, choice.selected])).toEqual([
      ["paseo-bm", false],
      ["shop", true],
      ["All projects", false],
    ]);
    expect(empty.form).toMatchObject({ saveEnabled: false, subjectError: null, textError: null, cancelLabel: "Cancel", saveLabel: "Save precedent" });

    const bad = shown({ ...PRECEDENTS_UI_IDLE, form: { scope: "all", subject: "Test Layout", text: "x".repeat(1001) } }).form!;
    expect(bad).toMatchObject({ saveEnabled: false, subjectError: "Lowercase letters, digits and dashes only, at most 60.", textError: "At most 1000 characters (now 1001)." });
    // A scope that is not offered cannot be saved.
    expect(shown({ ...PRECEDENTS_UI_IDLE, form: { scope: "ws-gone", subject: "x", text: "y" } }).form?.saveEnabled).toBe(false);

    const filled = { scope: "all", subject: " commit-style ", text: " Conventional commits. " };
    const ready = shown({ ...PRECEDENTS_UI_IDLE, form: filled });
    expect(ready.form?.saveEnabled).toBe(true);
    expect(precedentSaveInputOf(filled)).toEqual({ scope: "all", subject: "commit-style", text: "Conventional commits." });

    const on = handlers();
    const nodes = drawList(ready, on);
    const inputs = allNodes(nodes).filter((node) => node.type === "TextInput");
    expect(inputs.map((input) => input.props.accessibilityLabel)).toEqual(["The subject it answers", "The answer to keep"]);
    const formButtons = labelsOf(nodes).slice(3);
    expect(formButtons).toEqual(["Keep it for paseo-bm only", "Keep it for shop only", "Keep it for every project", "Cancel", "Save the precedent"]);
    const buttons = pressables(nodes).slice(3);
    (buttons[1]!.props.onPress as () => void)();
    expect(on.form).toHaveBeenCalledWith({ scope: "ws-2" });
    (buttons[4]!.props.onPress as () => void)();
    expect(on.save).toHaveBeenCalledOnce();
    (inputs[0]!.props.onChangeText as (text: string) => void)("release-notes");
    expect(on.form).toHaveBeenCalledWith({ subject: "release-notes" });

    const busy = drawList(shown({ ...PRECEDENTS_UI_IDLE, busy: true, form: filled }));
    expect(labelsOf(busy)).not.toContain("Cancel");
    expect(texts(busy)).toContain("Saving…");
  });

  it("shows a failed change in the danger colour", () => {
    const nodes = drawList(shown({ ...PRECEDENTS_UI_IDLE, error: "E_PRECEDENT_WRITE_FAILED: cannot save the precedents" }));
    const error = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_PRECEDENT_WRITE_FAILED"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });
});
