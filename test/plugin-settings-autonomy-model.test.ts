import { describe, expect, it, vi } from "vitest";
import {
  AUTONOMY_MEANING,
  AUTONOMY_ROW_ORDER,
  BOUNDARY_LABEL,
  BOUNDARY_MEANING,
  boundaryView,
  CHALLENGER_LABEL,
  CHALLENGER_MEANING,
  CLASS_LABELS,
  DECIDED_BY_LABEL,
  OWNER_ONLY_REASONS,
  RETURN_ALL_LABEL,
  autonomyGroupState,
  autonomyMatrixView,
  autonomyProjects,
  autonomyTabs,
  shownProjectOf,
} from "../plugin/client/settings-autonomy-model";
// The precedents below the matrix (autonomy design §B.6).
import {
  ADD_PRECEDENT_LABEL,
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
import { GROUP_LOADING } from "../plugin/client/settings-model";
import { EMPTY_AUTONOMY_POLICY, autonomyPolicyOf, type AutonomyPolicy } from "../plugin/shared/autonomy";
import { DECISION_CLASSES, HARD_OWNER_CLASSES } from "../plugin/shared/decisions";
import { allNodes, pressables, renderTree, texts, type RNode } from "./helpers/element-tree";

/**
 * Settings → Autonomy (autonomy design §B.2; PRD REQ-121): the matrix per
 * project. The view model is pure and tested here; the hook-free matrix of
 * `settings-autonomy.tsx` is expanded with the element-tree helper,
 * `react-native` being named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const modulePath = "../plugin/client/settings-autonomy.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { AutonomyMatrix } = (await import(modulePath)) as { AutonomyMatrix: Component };
const precedentsPath = "../plugin/client/settings-precedents.tsx";
const { PrecedentsList } = (await import(precedentsPath)) as { PrecedentsList: Component };

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };
const noop = () => undefined;
const AT = "2026-09-21T08:00:00.000Z";
const PROJECT = { id: "ws-1", label: "paseo-bm" };

const policyOf = (projects: Record<string, Record<string, unknown>>, challenger: Record<string, boolean> = {}): AutonomyPolicy =>
  autonomyPolicyOf({ version: 1, projects, challenger });

const mixed = policyOf({
  "ws-1": {
    "reversible-technical": { mode: "delegate", predictor: "recommended", at: AT },
    preference: { mode: "delegate", predictor: "orchestrator", at: AT },
    scope: { mode: "shadow", at: AT },
  },
});

const matrix = (policy: AutonomyPolicy, busy = false) => autonomyMatrixView({ policy, project: PROJECT, busy });
const row = (policy: AutonomyPolicy, label: string) => matrix(policy).rows.find((entry) => entry.label === label)!;

function draw(
  view: ReturnType<typeof autonomyMatrixView>,
  handlers: {
    onChoose?: unknown;
    delegate?: unknown;
    onChallenger?: unknown;
    onReset?: unknown;
    onBoundaryAsk?: unknown;
    onBoundaryConfirm?: unknown;
    onBoundaryCancel?: unknown;
    error?: string | null;
  } = {},
) {
  return renderTree(
    AutonomyMatrix({
      view,
      error: handlers.error ?? null,
      onChoose: handlers.onChoose ?? noop,
      ...(handlers.delegate === undefined ? {} : { delegate: handlers.delegate }),
      onChallenger: handlers.onChallenger ?? noop,
      onBoundaryAsk: handlers.onBoundaryAsk ?? noop,
      onBoundaryConfirm: handlers.onBoundaryConfirm ?? noop,
      onBoundaryCancel: handlers.onBoundaryCancel ?? noop,
      onReset: handlers.onReset ?? noop,
      styles,
      theme,
    }),
  );
}

describe("the matrix of one project", () => {
  it("has a row per class, the delegable ones first and release, data, security and cost last", () => {
    const view = matrix(EMPTY_AUTONOMY_POLICY);
    expect(view.title).toBe("paseo-bm");
    expect(view.rows.map((entry) => entry.decisionClass)).toEqual(AUTONOMY_ROW_ORDER);
    expect([...AUTONOMY_ROW_ORDER].sort()).toEqual([...DECISION_CLASSES].sort());
    expect(view.rows.slice(-4).map((entry) => entry.decisionClass).sort()).toEqual([...HARD_OWNER_CLASSES].sort());
    expect(view.summary).toBe("Every decision in this project is yours");
    // A new install: every class owner.
    expect(view.rows.every((entry) => entry.mode === "owner")).toBe(true);
  });

  it("offers Delegated on every delegable row at any time, whatever the figures (ADR-023); pressing it only asks", () => {
    for (const policy of [EMPTY_AUTONOMY_POLICY, mixed]) {
      for (const entry of matrix(policy).rows.filter((candidate) => !candidate.fixed)) {
        expect(entry.choices.map((choice) => choice.label)).toEqual(["Owner", "Shadow", "Delegated"]);
        expect(entry.delegate).toBeNull();
      }
    }
    expect(AUTONOMY_MEANING).toBe(
      "Owner and Shadow: you decide, and what the agents would have chosen is recorded beside your answer. " +
        "Delegated: decided for you by the recommended option or the Orchestrator, after one confirmation; a reversal or an override sends it back to Shadow.",
    );
    expect(row(EMPTY_AUTONOMY_POLICY, "Dependency").choices[2]).toEqual({
      mode: "delegate",
      label: "Delegated",
      selected: false,
      enabled: true,
      accessibilityLabel: "Delegate Dependency in paseo-bm…",
    });
    const onChoose = vi.fn();
    const nodes = draw(matrix(EMPTY_AUTONOMY_POLICY), { onChoose });
    (pressables(nodes).find((button) => button.props.accessibilityLabel === "Delegate Dependency in paseo-bm…")!.props.onPress as () => void)();
    expect(onChoose).toHaveBeenCalledWith("dependency", "delegate");
    // Nothing is confirmed yet: no confirmation is drawn.
    expect(texts(nodes)).not.toContain("Cancel");
  });

  it("asks who decides and says what changes, in place under the row, Cancel first; confirming sends autonomy.set with confirmed: true", () => {
    const asked = (predictor: "recommended" | "orchestrator", policy: AutonomyPolicy = EMPTY_AUTONOMY_POLICY) =>
      autonomyMatrixView({ policy, project: PROJECT, busy: false, confirmingDelegate: { decisionClass: "dependency", predictor } });
    const view = asked("recommended");
    const dependency = view.rows.find((entry) => entry.decisionClass === "dependency")!;
    expect(view.rows.filter((entry) => entry.delegate !== null).map((entry) => entry.decisionClass)).toEqual(["dependency"]);
    expect(dependency.choices[2]!.enabled).toBe(false);
    expect(dependency.delegate).toEqual({
      label: DECIDED_BY_LABEL,
      predictors: [
        { predictor: "recommended", label: "Recommended option", selected: true, accessibilityLabel: "Dependency decided by the recommended option" },
        { predictor: "orchestrator", label: "Orchestrator", selected: false, accessibilityLabel: "Dependency decided by the Orchestrator" },
      ],
      dialog: {
        title: "Delegate Dependency decisions in paseo-bm?",
        body: [
          "• The recommended option answers them for you, without asking you.",
          "• A reversal or an override sends the class back to Shadow at once; Return all to owner undoes it.",
        ].join("\n"),
        confirmLabel: "Delegate",
        cancelLabel: "Cancel",
        defaultAction: "cancel",
      },
      input: { workspaceId: "ws-1", class: "dependency", mode: "delegate", confirmed: true, predictor: "recommended" },
    });
    // The Orchestrator: its cost is said, and confirming names it.
    const orchestrator = asked("orchestrator").rows.find((entry) => entry.decisionClass === "dependency")!.delegate!;
    expect(orchestrator.dialog.body).toContain("• Each decision wakes the Orchestrator, which costs tokens.");
    expect(orchestrator.input.predictor).toBe("orchestrator");
    // A class delegated meanwhile shows no confirmation.
    const delegated = policyOf({ "ws-1": { dependency: { mode: "delegate", predictor: "recommended", at: AT } } });
    expect(asked("recommended", delegated).rows.every((entry) => entry.delegate === null)).toBe(true);

    // Drawn under the row: who decides, then Cancel before Delegate; each press calls back, and nothing else is sent.
    const handlers = { onPredictor: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() };
    const nodes = draw(view, { delegate: handlers });
    const labels = pressables(nodes).map((button) => String(button.props.accessibilityLabel));
    const at = labels.indexOf("Delegate Dependency in paseo-bm…");
    expect(labels.slice(at, at + 5)).toEqual([
      "Delegate Dependency in paseo-bm…",
      "Dependency decided by the recommended option",
      "Dependency decided by the Orchestrator",
      "Cancel",
      "Delegate",
    ]);
    expect(texts(nodes)).toEqual(expect.arrayContaining([DECIDED_BY_LABEL, "Delegate Dependency decisions in paseo-bm?"]));
    const byLabel = (label: string) => pressables(nodes).find((button) => button.props.accessibilityLabel === label)!;
    (byLabel("Dependency decided by the Orchestrator").props.onPress as () => void)();
    expect(handlers.onPredictor).toHaveBeenCalledWith("dependency", "orchestrator");
    (byLabel("Cancel").props.onPress as () => void)();
    expect(handlers.onCancel).toHaveBeenCalledOnce();
    expect(handlers.onConfirm).not.toHaveBeenCalled();
    (byLabel("Delegate").props.onPress as () => void)();
    expect(handlers.onConfirm).toHaveBeenCalledWith(dependency.delegate);
  });

  it("shows the four hard-owner rows as owner with no choice, each with its one-line reason", () => {
    for (const decisionClass of HARD_OWNER_CLASSES) {
      const entry = matrix(EMPTY_AUTONOMY_POLICY).rows.find((candidate) => candidate.decisionClass === decisionClass)!;
      expect(entry.fixed).toBe(true);
      expect(entry.choices).toEqual([]);
      expect(entry.modeText).toBe("Owner (fixed)");
      expect(entry.caption).toBe(OWNER_ONLY_REASONS[decisionClass]);
      expect(entry.caption).toMatch(/^Always yours: .*confirmed answer\.$/);
      expect(entry.caption!.split("\n")).toHaveLength(1);
      expect(entry.accessibilityLabel).toContain(entry.caption!);
    }
    // A file that says otherwise is not believed.
    const forged = policyOf({ "ws-1": { release: { mode: "delegate", predictor: "recommended", at: AT } } });
    expect(row(forged, "Release").mode).toBe("owner");
  });

  it("shows a delegated cell's predictor and lets it be set back to owner or shadow", () => {
    const recommended = row(mixed, "Reversible technical");
    expect(recommended.modeText).toBe("Delegated");
    expect(recommended.caption).toBe("Decided for you by the recommended option since 2026-09-21");
    expect(row(mixed, "Preference").caption).toBe("Decided for you by the Orchestrator since 2026-09-21");
    expect(recommended.choices.map((choice) => [choice.label, choice.selected, choice.enabled])).toEqual([
      ["Owner", false, true],
      ["Shadow", false, true],
      ["Delegated", true, false],
    ]);

    const onChoose = vi.fn();
    const nodes = draw(matrix(mixed), { onChoose });
    expect(texts(nodes)).toContain("Decided for you by the recommended option since 2026-09-21");
    const back = pressables(nodes).find((button) => button.props.accessibilityLabel === "Set Reversible technical in paseo-bm to Owner")!;
    expect(back.props.disabled).toBe(false);
    (back.props.onPress as () => void)();
    expect(onChoose).toHaveBeenCalledWith("reversible-technical", "owner");
  });

  it("marks the current mode and sets the other one", () => {
    const scope = row(mixed, "Scope");
    expect(scope.modeText).toBe("Shadow");
    expect(scope.choices.map((choice) => [choice.label, choice.selected, choice.enabled])).toEqual([
      ["Owner", false, true],
      ["Shadow", true, false],
      ["Delegated", false, true],
    ]);
    expect(scope.choices[1]!.accessibilityLabel).toBe("Scope in paseo-bm is Shadow");

    const onChoose = vi.fn();
    const nodes = draw(matrix(EMPTY_AUTONOMY_POLICY), { onChoose });
    const shadow = pressables(nodes).find((button) => button.props.accessibilityLabel === "Set Dependency in paseo-bm to Shadow")!;
    (shadow.props.onPress as () => void)();
    expect(onChoose).toHaveBeenCalledWith("dependency", "shadow");
    const current = pressables(nodes).find((button) => button.props.accessibilityLabel === "Dependency in paseo-bm is Owner")!;
    expect(current.props.disabled).toBe(true);
    expect(current.props.accessibilityState).toEqual({ selected: true, disabled: true });
  });

  it("offers Return all to owner while a class is above owner, and a press calls reset", () => {
    expect(matrix(EMPTY_AUTONOMY_POLICY).reset.enabled).toBe(false);
    const view = matrix(mixed);
    expect(view.summary).toBe("2 classes delegated · 1 in shadow");
    expect(view.reset).toEqual({ enabled: true, label: RETURN_ALL_LABEL, accessibilityLabel: "Return every class of paseo-bm to owner" });

    const onReset = vi.fn();
    const nodes = draw(view, { onReset });
    const reset = pressables(nodes).find((button) => texts([button])[0] === "Return all to owner")!;
    expect(reset.props.accessibilityRole).toBe("button");
    expect(reset.props.disabled).toBe(false);
    (reset.props.onPress as () => void)();
    expect(onReset).toHaveBeenCalledOnce();
    // What the press calls, autonomy.reset in one press, is read from the source in view-source.test.ts.
  });

  it("disables every choice and the reset while a change runs, and shows a failed change in the danger colour", () => {
    const busy = matrix(mixed, true);
    expect(busy.rows.flatMap((entry) => entry.choices).every((choice) => !choice.enabled)).toBe(true);
    expect(busy.reset.enabled).toBe(false);
    const nodes = draw(busy, { error: "E_AUTONOMY_WRITE_FAILED: cannot save the autonomy policy" });
    const error = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0]?.startsWith("E_AUTONOMY_WRITE_FAILED"))!;
    expect(JSON.stringify(error.props.style)).toContain("#statusDanger");
  });

  it("has the Orchestrator predictions switch, off by default: one press each way, no confirmation, untouched by Return all to owner", () => {
    const off = matrix(EMPTY_AUTONOMY_POLICY).challenger;
    expect(off).toMatchObject({ label: CHALLENGER_LABEL, on: false, stateText: "Off", caption: CHALLENGER_MEANING });
    expect(off.choices.map((choice) => [choice.label, choice.enabled, choice.selected, choice.pressable])).toEqual([
      ["Off", false, true, false],
      ["On", true, false, true],
    ]);
    expect(CHALLENGER_MEANING).toMatch(/you see it only after you answer/);
    expect(CHALLENGER_MEANING.split("\n")).toHaveLength(1);

    const onChallenger = vi.fn();
    const nodes = draw(matrix(EMPTY_AUTONOMY_POLICY), { onChallenger });
    expect(texts(nodes)).toEqual(expect.arrayContaining([CHALLENGER_LABEL, CHALLENGER_MEANING, "Off", "On"]));
    const turnOn = pressables(nodes).find((button) => button.props.accessibilityLabel === "Turn Orchestrator predictions in paseo-bm on")!;
    expect(turnOn.props.accessibilityRole).toBe("button");
    (turnOn.props.onPress as () => void)();
    expect(onChallenger).toHaveBeenCalledWith(true);
    const current = pressables(nodes).find((button) => button.props.accessibilityLabel === "Orchestrator predictions in paseo-bm are Off")!;
    expect(current.props.disabled).toBe(true);

    // On while every class is still owner: the owner decides everything, and Return all to owner has nothing to return.
    const on = matrix(policyOf({}, { "ws-1": true }));
    expect(on.challenger).toMatchObject({ on: true, stateText: "On" });
    expect(on.summary).toBe("Every decision in this project is yours");
    expect(on.reset.enabled).toBe(false);
    const turnOff = pressables(draw(on, { onChallenger })).find((button) => button.props.accessibilityLabel === "Turn Orchestrator predictions in paseo-bm off")!;
    (turnOff.props.onPress as () => void)();
    expect(onChallenger).toHaveBeenLastCalledWith(false);
    // While a change runs, neither side can be pressed.
    expect(matrix(EMPTY_AUTONOMY_POLICY, true).challenger.choices.every((choice) => !choice.pressable)).toBe(true);
  });

  it("labels every pressable and every row, and shows no id", () => {
    const nodes = draw(matrix(mixed));
    for (const button of pressables(nodes)) {
      expect(button.props.accessibilityRole).toBe("button");
      expect(String(button.props.accessibilityLabel ?? "")).not.toBe("");
    }
    const rows = allNodes(nodes).filter((node) => node.type === "View" && typeof node.props.accessibilityLabel === "string");
    // A row per class, the action boundary and the Orchestrator predictions switch.
    expect(rows.map((node) => (node as RNode).props.accessibilityLabel)).toHaveLength(DECISION_CLASSES.length + 2);
    expect(texts(nodes)).toEqual(expect.arrayContaining(Object.values(CLASS_LABELS)));
    expect(JSON.stringify(nodes)).not.toContain("ws-1");
  });
});

/**
 * The action boundary's row (autonomy design §D.2, change-010 C2–C4): off by
 * default; each side asks for a confirmation in place, Cancel first, that says
 * what changes; the folded line counts the projects with it on.
 */
describe("the action boundary row (change-010 C2–C4)", () => {
  const ON_AT = "2026-10-01T08:00:00.000Z";
  const withBoundary = (ids: string[]) => autonomyPolicyOf({ version: 1, projects: {}, challenger: {}, boundary: Object.fromEntries(ids.map((id) => [id, { enabled: true, at: ON_AT }])) });

  it("is Off by default, one side pressable; On shows since when", () => {
    const off = boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, false);
    expect(off).toMatchObject({ label: BOUNDARY_LABEL, on: false, stateText: "Off", since: null, confirm: null, caption: BOUNDARY_MEANING });
    expect(off.choices.map((choice) => [choice.label, choice.selected, choice.pressable])).toEqual([["Off", true, false], ["On", false, true]]);
    const on = boundaryView(withBoundary(["ws-1"]), PROJECT, false);
    expect(on).toMatchObject({ on: true, stateText: "On", since: "On since 2026-10-01" });
    expect(on.choices.map((choice) => choice.pressable)).toEqual([true, false]);
    expect(boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, true).choices.every((choice) => !choice.pressable)).toBe(true);
    expect(BOUNDARY_MEANING.split("\n")).toHaveLength(1);
  });

  it("turning on asks, and its confirmation says what changes: the least permissive mode, what waits for the owner, existing agents keep their mode", () => {
    const asking = boundaryView(EMPTY_AUTONOMY_POLICY, PROJECT, false, true);
    expect(asking.choices.every((choice) => !choice.pressable)).toBe(true);
    const dialog = asking.confirm!;
    expect(dialog).toMatchObject({ title: "Turn the action boundary on in paseo-bm?", confirmLabel: "Turn on", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(dialog.body).toMatch(/created from now on in this project run in the least permissive mode \(Claude: default; Codex: auto with its creation options\)/);
    expect(dialog.body).toMatch(/a release, real data, a dependency install, the network, a write outside the workspace, or a request it cannot read — waits for you/);
    expect(dialog.body).toMatch(/unless your answer to the Worker's question \(a grant: one use, 60 minutes\) or a class you delegated covers it/);
    expect(dialog.body).toMatch(/Agents that already exist keep their mode\./);
    expect(dialog.body).not.toMatch(/precedent/i);
    // Pressing the side already chosen asks nothing.
    expect(boundaryView(withBoundary(["ws-1"]), PROJECT, false, true).confirm).toBeNull();
  });

  it("turning off asks too: today's modes under detection; agents created while it was on keep their mode and are still answered", () => {
    const dialog = boundaryView(withBoundary(["ws-1"]), PROJECT, false, false).confirm!;
    expect(dialog).toMatchObject({ title: "Turn the action boundary off in paseo-bm?", confirmLabel: "Turn off", cancelLabel: "Cancel", defaultAction: "cancel" });
    expect(dialog.body).toMatch(/created from now on run in today's modes: their actions are only watched \(detection\), not held/);
    expect(dialog.body).toMatch(/Agents created while it was on keep their mode, and the plugin still answers their requests\./);
  });

  it("draws the row above the predictions: a press asks, the confirmation's Cancel comes first and sends nothing", () => {
    const onAsk = vi.fn();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const closed = draw(autonomyMatrixView({ policy: EMPTY_AUTONOMY_POLICY, project: PROJECT, busy: false }), { onBoundaryAsk: onAsk });
    const turnOn = pressables(closed).find((button) => button.props.accessibilityLabel === "Turn the action boundary in paseo-bm on")!;
    (turnOn.props.onPress as () => void)();
    expect(onAsk).toHaveBeenLastCalledWith(true);
    const all = texts(closed);
    expect(all.indexOf(BOUNDARY_LABEL)).toBeLessThan(all.indexOf(CHALLENGER_LABEL));
    const open = draw(autonomyMatrixView({ policy: EMPTY_AUTONOMY_POLICY, project: PROJECT, busy: false, confirmingBoundary: true }), {
      onBoundaryConfirm: onConfirm,
      onBoundaryCancel: onCancel,
    });
    const labels = pressables(open).map((button) => texts([button])[0]);
    expect(labels.indexOf("Cancel")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Cancel")).toBeLessThan(labels.indexOf("Turn on"));
    (pressables(open).find((button) => texts([button])[0] === "Cancel")!.props.onPress as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    (pressables(open).find((button) => texts([button])[0] === "Turn on")!.props.onPress as () => void)();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(open)).not.toContain("ws-1");
  });

  it("the folded line counts the projects with it on; an unnamed project with it on is still listed", () => {
    expect(autonomyGroupState(withBoundary(["ws-1"]))).toEqual({ text: "Every decision is yours · action boundary on in 1 project", tone: "info" });
    const both = autonomyPolicyOf({ version: 1, projects: { "ws-1": { scope: { mode: "shadow", at: AT } } }, challenger: {}, boundary: { "ws-1": { enabled: true, at: ON_AT }, "ws-9": { enabled: true, at: ON_AT } } });
    expect(autonomyGroupState(both)).toEqual({ text: "1 in shadow, in 1 project · action boundary on in 2 projects", tone: "info" });
    expect(autonomyProjects([{ id: "ws-1", label: "paseo-bm" }], both)).toEqual([{ id: "ws-1", label: "paseo-bm" }, { id: "ws-9", label: "Unnamed project" }]);
  });
});

describe("the projects and the group's line", () => {
  const named = [
    { id: "ws-1", label: "paseo-bm" },
    { id: "ws-2", label: "shop (closed)" },
  ];

  it("lists a project with the predictions still on too, unnamed, so they can be turned off; one turned off is not", () => {
    const policy = policyOf({ "ws-8": { scope: { mode: "owner", at: AT } } }, { "ws-7": true, "ws-6": false, "ws-1": true });
    expect(autonomyProjects(named, policy)).toEqual([...named, { id: "ws-7", label: "Unnamed project" }]);
  });

  it("names projects as Insights does, then any project the policy holds cells for, unnamed and never by id", () => {
    const policy = policyOf({
      "ws-9": { scope: { mode: "shadow", at: AT } },
      "ws-8": { scope: { mode: "owner", at: AT } },
      "ws-1": { scope: { mode: "shadow", at: AT } },
    });
    expect(autonomyProjects(named, policy)).toEqual([...named, { id: "ws-9", label: "Unnamed project" }]);
    expect(autonomyProjects(named, undefined)).toEqual(named);
    const two = policyOf({ a: { scope: { mode: "shadow", at: AT } }, b: { scope: { mode: "shadow", at: AT } } });
    expect(autonomyProjects([], two).map((project) => project.label)).toEqual(["Unnamed project 1", "Unnamed project 2"]);
  });

  it("shows the chosen project while it is listed, else the first", () => {
    expect(shownProjectOf(named, "ws-2")?.label).toBe("shop (closed)");
    expect(shownProjectOf(named, "gone")?.label).toBe("paseo-bm");
    expect(shownProjectOf([], null)).toBeNull();
  });

  it("gives each tab the count of its classes above owner", () => {
    expect(autonomyTabs(named, mixed)).toEqual([
      { key: "ws-1", label: "paseo-bm", count: 3, hint: "2 classes delegated · 1 in shadow" },
      { key: "ws-2", label: "shop (closed)", hint: "every decision is yours" },
    ]);
  });

  it("folds to one line: loading, failed, all yours, or what is not yours alone", () => {
    expect(autonomyGroupState(undefined)).toEqual(GROUP_LOADING);
    expect(autonomyGroupState(undefined, true)).toEqual({ text: "The autonomy policy could not be read", tone: "danger" });
    expect(autonomyGroupState(EMPTY_AUTONOMY_POLICY)).toEqual({ text: "Every decision is yours, in every project", tone: "muted" });
    expect(autonomyGroupState(policyOf({ "ws-1": { scope: { mode: "owner", at: AT } } }))).toEqual({
      text: "Every decision is yours, in every project",
      tone: "muted",
    });
    expect(autonomyGroupState(policyOf({ "ws-1": { scope: { mode: "shadow", at: AT } } }))).toEqual({ text: "1 in shadow, in 1 project", tone: "muted" });
    const two = policyOf({ ...{ "ws-2": { preference: { mode: "delegate", predictor: "recommended", at: AT } } }, "ws-1": mixed.projects["ws-1"]! });
    expect(autonomyGroupState(two)).toEqual({ text: "3 classes delegated · 1 in shadow, in 2 projects", tone: "info" });
  });
});

describe("the precedents below the matrix (autonomy design §B.6, §B.9)", () => {
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

  it("says so when there is none", () => {
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
