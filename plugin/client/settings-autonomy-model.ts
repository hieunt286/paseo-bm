/**
 * What Settings → Autonomy says (autonomy design §B.2, §A.12; experience
 * concept §4.4; PRD REQ-121): the owner's policy as a matrix per project — a
 * row per decision class with who decides it — and **Return all to owner**.
 *
 * The matrix sets `owner` and `shadow` at once, and `delegate` (§B.4,
 * ADR-023) at any time after a confirmation in place under the row: who
 * decides (the recommended option or the Orchestrator), then what changes,
 * Cancel first. No agreement threshold gates it. A delegated cell shows its
 * predictor and can be set back. The four classes that are always the
 * owner's (release, data, security, cost) are fixed rows that say why.
 *
 * Each project's matrix also has **Orchestrator predictions**, the challenger
 * switch (autonomy design §B.3, §B.9): off by default (DQ-4), one press each
 * way with no confirmation (`autonomy.set-challenger`), and untouched by
 * Return all to owner.
 *
 * Each project's matrix also has **Action boundary** (autonomy design §D.2,
 * change-010 C2–C4): off by default; each direction opens an in-place
 * confirmation (Cancel first) that says what changes, then
 * `autonomy.set-boundary` with `confirmed: true`. Return all to owner leaves
 * it alone. Only the owner sets it: no agent tool and no advice does.
 *
 * Projects are named as Insights names them (`insightsProjects`); a project
 * the policy still holds cells or predictions for but the surface no longer
 * knows by name is listed as an unnamed project, never by its id.
 *
 * Below the matrix, the owner's **precedents** (autonomy design §B.6; PRD
 * REQ-124): the active ones with their project, subject, answer and expiry,
 * **End** on each (a confirmation, Cancel first) and **Add precedent…**.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { boundaryOf, boundaryProjects, canDelegate, cellOf, challengerOf, modeOf, type AutonomyMode, type AutonomyPolicy, type AutonomyPredictor } from "../shared/autonomy";
import { DECISION_CLASSES, PREDICTORS, SUBJECT_PATTERN, type DecisionClass } from "../shared/decisions";
import { plural } from "../shared/text";
import { MAX_PRECEDENT_TEXT_CHARS, PRECEDENT_SCOPE_ALL, type Precedent } from "../shared/precedents";
import type { InsightsProject } from "./insights-model";
import { GROUP_LOADING, type GroupState } from "./settings-model";
import type { ConfirmDialog } from "./ui-types";

/** The owner's whole autonomy policy (`autonomy.policy {}`): Settings and Insights read this one query, and a screen that changes the policy writes it. */
export const AUTONOMY_POLICY_KEY = ["paseo-bm", "autonomy", "policy"] as const;

/** The rows, the classes that can be delegated first, least risky on top; the four that stay yours last. */
export const AUTONOMY_ROW_ORDER: readonly DecisionClass[] = [...DECISION_CLASSES].reverse();

/** Each class in the owner's words. */
export const CLASS_LABELS: Readonly<Record<DecisionClass, string>> = {
  "reversible-technical": "Reversible technical",
  preference: "Preference",
  scope: "Scope",
  environment: "Environment",
  dependency: "Dependency",
  cost: "Cost",
  release: "Release",
  data: "Data",
  security: "Security",
};

export const MODE_LABELS: Readonly<Record<AutonomyMode, string>> = { owner: "Owner", shadow: "Shadow", delegate: "Delegated" };

export const PREDICTOR_WORDS: Readonly<Record<AutonomyPredictor, string>> = {
  recommended: "the recommended option",
  orchestrator: "the Orchestrator",
};

/** Why each class that is always the owner's is (REQ-121 c), in one line. */
export const OWNER_ONLY_REASONS: Readonly<Partial<Record<DecisionClass, string>>> = {
  cost: "Always yours: anything that costs money goes ahead only on your confirmed answer.",
  release: "Always yours: a push, a publish or a deploy goes ahead only on your confirmed answer.",
  data: "Always yours: real data and migrations go ahead only on your confirmed answer.",
  security: "Always yours: a security change goes ahead only on your confirmed answer.",
};

/** What the modes mean, in one line. */
export const AUTONOMY_MEANING =
  "Owner and Shadow: you decide, and what the agents would have chosen is recorded beside your answer. Delegated: decided for you by the recommended option or the Orchestrator, after one confirmation; a reversal or an override sends it back to Shadow.";

/** The group's body when there is no project to show. */
export const AUTONOMY_NO_PROJECTS = "No project yet. Each workspace you open in Paseo gets its own row of classes here.";

export const RETURN_ALL_LABEL = "Return all to owner";

/** The challenger switch's name (autonomy design §B.3). */
export const CHALLENGER_LABEL = "Orchestrator predictions";

/** What the challenger does, in one line: what it records, that the owner never sees it first, and its cost. */
export const CHALLENGER_MEANING =
  "When on, the Orchestrator records the option it expects you to choose on the classes that can be delegated; you see it only after you answer. Predicting wakes the Orchestrator, which costs tokens.";

/** The action boundary switch's name (autonomy design §D.2). */
export const BOUNDARY_LABEL = "Action boundary";

/** What the switch does, in one line (off by default). */
export const BOUNDARY_MEANING =
  "When on, an action that leaves the workspace waits for you before it runs, for Workers and Reviewers created afterwards in this project. Off by default: their actions are only watched.";

/** The confirmation of turning the boundary on (change-010 C4). */
export function boundaryOnDialog(projectLabel: string): ConfirmDialog {
  return {
    title: `Turn the action boundary on in ${projectLabel}?`,
    body: [
      "• Workers and Reviewers created from now on in this project run in the least permissive mode (Claude: default; Codex: auto with its creation options).",
      "• Each action the boundary holds — a release, real data, a dependency install, the network, a write outside the workspace, or a request it cannot read — waits for you, unless your answer to the Worker's question (a grant: one use, 60 minutes) or a class you delegated covers it.",
      "• Agents that already exist keep their mode.",
    ].join("\n"),
    confirmLabel: "Turn on",
    cancelLabel: "Cancel",
    confirmAccessibilityLabel: `Turn the action boundary on in ${projectLabel}`,
    defaultAction: "cancel",
  };
}

/** The confirmation of turning the boundary off (change-010 C4). */
export function boundaryOffDialog(projectLabel: string): ConfirmDialog {
  return {
    title: `Turn the action boundary off in ${projectLabel}?`,
    body: [
      "• Workers and Reviewers created from now on run in today's modes: their actions are only watched (detection), not held.",
      "• Agents created while it was on keep their mode, and the plugin still answers their requests.",
    ].join("\n"),
    confirmLabel: "Turn off",
    cancelLabel: "Cancel",
    confirmAccessibilityLabel: `Turn the action boundary off in ${projectLabel}`,
    defaultAction: "cancel",
  };
}

/** Each predictor as a choice: who decides a delegated class. */
export const PREDICTOR_LABELS: Readonly<Record<AutonomyPredictor, string>> = {
  recommended: "Recommended option",
  orchestrator: "Orchestrator",
};

/** The label of the predictor choice in a delegation's confirmation. */
export const DECIDED_BY_LABEL = "Decided by";

/**
 * The confirmation of delegating a class (§B.4, ADR-023), in Settings and from
 * Insights' Delegate?: who answers for the owner, what it costs when that is
 * the Orchestrator, the agreement so far when the caller has it (information,
 * never a condition), and how it is taken back. Cancel is the default.
 */
export function delegateDialog(input: {
  classLabel: string;
  projectLabel: string;
  predictor: AutonomyPredictor;
  /** The predictor's agreement so far in this class; omitted where the screen does not read it. */
  agreement?: { agreed: number; count: number } | null;
}): ConfirmDialog {
  const { classLabel, projectLabel, predictor, agreement } = input;
  const who = PREDICTOR_WORDS[predictor];
  const lines = [
    `• ${who.charAt(0).toUpperCase()}${who.slice(1)} answers them for you, without asking you.`,
    agreement === undefined || agreement === null || agreement.count === 0
      ? null
      : `• So far it matched ${agreement.agreed} of your ${plural(agreement.count, "answer")} (${Math.round((agreement.agreed / agreement.count) * 100)} %).`,
    predictor === "orchestrator" ? "• Each decision wakes the Orchestrator, which costs tokens." : null,
    `• A reversal or an override sends the class back to Shadow at once; ${RETURN_ALL_LABEL} undoes it.`,
  ].filter((line): line is string => line !== null);
  return {
    title: `Delegate ${classLabel} decisions in ${projectLabel}?`,
    body: lines.join("\n"),
    confirmLabel: "Delegate",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** The delegation being confirmed in the matrix: its class and the predictor chosen so far. */
export interface DelegateConfirming {
  decisionClass: DecisionClass;
  predictor: AutonomyPredictor;
}

/** A project of the matrix: its id (never shown) and its name. */
export interface AutonomyProject {
  id: string;
  label: string;
}

/** How many of a project's classes are delegated and in shadow. */
export function cellsAboveOwner(policy: AutonomyPolicy, workspaceId: string): { delegated: number; shadow: number } {
  let delegated = 0;
  let shadow = 0;
  for (const decisionClass of DECISION_CLASSES) {
    const mode = modeOf(policy, workspaceId, decisionClass);
    if (mode === "delegate") delegated += 1;
    else if (mode === "shadow") shadow += 1;
  }
  return { delegated, shadow };
}

/**
 * The projects the matrix offers: every project Insights names, in its order,
 * then each project the policy still holds a cell above `owner` or the
 * predictions on for that no longer has a name — so a delegation, or
 * predictions that cost Orchestrator turns, can always be seen and taken back.
 */
export function autonomyProjects(named: readonly InsightsProject[], policy: AutonomyPolicy | undefined): AutonomyProject[] {
  const seen = new Set(named.map((project) => project.id));
  const unnamed =
    policy === undefined
      ? []
      : [...new Set([...Object.keys(policy.projects), ...Object.keys(policy.challenger), ...boundaryProjects(policy)])].filter((id) => {
          if (seen.has(id)) return false;
          const counts = cellsAboveOwner(policy, id);
          return counts.delegated + counts.shadow > 0 || challengerOf(policy, id) || boundaryOf(policy, id) !== null;
        });
  return [
    ...named.map((project) => ({ id: project.id, label: project.label })),
    ...unnamed.map((id, index) => ({ id, label: unnamed.length === 1 ? "Unnamed project" : `Unnamed project ${index + 1}` })),
  ];
}

/** The project shown: the one chosen while it is still listed, else the first. */
export function shownProjectOf(projects: readonly AutonomyProject[], chosen: string | null): AutonomyProject | null {
  return projects.find((project) => project.id === chosen) ?? projects[0] ?? null;
}

function countsText(counts: { delegated: number; shadow: number }): string | null {
  const parts = [
    counts.delegated === 0 ? null : `${counts.delegated} ${counts.delegated === 1 ? "class" : "classes"} delegated`,
    counts.shadow === 0 ? null : `${counts.shadow} in shadow`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The project tabs: a project with classes above `owner` carries their count. */
export function autonomyTabs(
  projects: readonly AutonomyProject[],
  policy: AutonomyPolicy,
): Array<{ key: string; label: string; count?: number; hint: string }> {
  return projects.map((project) => {
    const counts = cellsAboveOwner(policy, project.id);
    const above = counts.delegated + counts.shadow;
    const hint = countsText(counts) ?? "every decision is yours";
    return above === 0 ? { key: project.id, label: project.label, hint } : { key: project.id, label: project.label, count: above, hint };
  });
}

/** The Autonomy group's folded line: what is not the owner's alone, across projects. */
export function autonomyGroupState(policy: AutonomyPolicy | undefined, failed = false): GroupState {
  if (failed) return { text: "The autonomy policy could not be read", tone: "danger" };
  if (policy === undefined) return GROUP_LOADING;
  const total = { delegated: 0, shadow: 0 };
  let projects = 0;
  for (const id of Object.keys(policy.projects)) {
    const counts = cellsAboveOwner(policy, id);
    if (counts.delegated + counts.shadow > 0) projects += 1;
    total.delegated += counts.delegated;
    total.shadow += counts.shadow;
  }
  const text = countsText(total);
  // The action boundary (§D.2, change-010 C2): how many projects have it on.
  const bounded = boundaryProjects(policy).length;
  const boundaryText = bounded === 0 ? null : `action boundary on in ${bounded} project${bounded === 1 ? "" : "s"}`;
  if (text === null) {
    return boundaryText === null
      ? { text: "Every decision is yours, in every project", tone: "muted" }
      : { text: `Every decision is yours · ${boundaryText}`, tone: "info" };
  }
  const line = `${text}, in ${projects} project${projects === 1 ? "" : "s"}`;
  return { text: boundaryText === null ? line : `${line} · ${boundaryText}`, tone: total.delegated > 0 || boundaryText !== null ? "info" : "muted" };
}

/** One choice of a row: `owner` and `shadow` set at once; `delegate` opens its confirmation. */
export interface AutonomyChoiceView {
  mode: AutonomyMode;
  label: string;
  selected: boolean;
  enabled: boolean;
  accessibilityLabel: string;
}

export interface AutonomyRowView {
  decisionClass: DecisionClass;
  label: string;
  mode: AutonomyMode;
  modeText: string;
  /** Release, data, security and cost: no choice, and `caption` says why. */
  fixed: boolean;
  /** Why a fixed row is fixed, or who decides a delegated cell; else null. */
  caption: string | null;
  choices: AutonomyChoiceView[];
  /** The delegation's confirmation, in place under the row, while it is asked; else null. */
  delegate: AutonomyDelegateView | null;
  accessibilityLabel: string;
}

/** One predictor of a delegation's "Decided by" choice. */
export interface AutonomyPredictorChoiceView {
  predictor: AutonomyPredictor;
  label: string;
  selected: boolean;
  accessibilityLabel: string;
}

/** A delegation being confirmed: who decides, then the confirmation (Cancel first). */
export interface AutonomyDelegateView {
  label: string;
  predictors: AutonomyPredictorChoiceView[];
  dialog: ConfirmDialog;
  /** What confirming sends: `autonomy.set` with `confirmed: true` and the predictor chosen. */
  input: { workspaceId: string; class: DecisionClass; mode: "delegate"; confirmed: true; predictor: AutonomyPredictor };
}

/** One side of the challenger switch: `true` turns the predictions on. */
export interface AutonomyChallengerChoiceView {
  enabled: boolean;
  label: string;
  selected: boolean;
  /** False while a change runs, and for the side already chosen. */
  pressable: boolean;
  accessibilityLabel: string;
}

/** The project's challenger switch (§B.3): Off / On, with what it does. */
export interface AutonomyChallengerView {
  label: string;
  on: boolean;
  stateText: string;
  caption: string;
  choices: AutonomyChallengerChoiceView[];
  accessibilityLabel: string;
}

/** The project's action boundary switch (§D.2): Off / On, what it does, and the confirmation while one is asked. */
export interface AutonomyBoundaryView {
  label: string;
  on: boolean;
  stateText: string;
  caption: string;
  /** Since when it is on, in the owner's words; null while off. */
  since: string | null;
  choices: AutonomyChallengerChoiceView[];
  /** The confirmation of the side pressed, in place, Cancel first; null when none is asked. */
  confirm: ConfirmDialog | null;
  accessibilityLabel: string;
}

export interface AutonomyMatrixView {
  title: string;
  summary: string;
  boundary: AutonomyBoundaryView;
  challenger: AutonomyChallengerView;
  rows: AutonomyRowView[];
  reset: { enabled: boolean; label: string; accessibilityLabel: string };
}

const SETTABLE_MODES = ["owner", "shadow", "delegate"] as const;

/** The project's Orchestrator predictions, Off or On (off by default, DQ-4); one press each way, no confirmation. */
function challengerView(policy: AutonomyPolicy, project: AutonomyProject, busy: boolean): AutonomyChallengerView {
  const on = challengerOf(policy, project.id);
  const stateText = on ? "On" : "Off";
  return {
    label: CHALLENGER_LABEL,
    on,
    stateText,
    caption: CHALLENGER_MEANING,
    choices: [false, true].map((enabled) => {
      const selected = enabled === on;
      const label = enabled ? "On" : "Off";
      return {
        enabled,
        label,
        selected,
        pressable: !busy && !selected,
        accessibilityLabel: selected
          ? `${CHALLENGER_LABEL} in ${project.label} are ${label}`
          : `Turn ${CHALLENGER_LABEL} in ${project.label} ${enabled ? "on" : "off"}`,
      };
    }),
    accessibilityLabel: `${CHALLENGER_LABEL}: ${stateText}. ${CHALLENGER_MEANING}`,
  };
}

/**
 * The project's action boundary, Off or On (off by default, change-010 C1):
 * pressing the other side asks for its confirmation (`confirming`: the side
 * pressed), which says what changes.
 */
export function boundaryView(policy: AutonomyPolicy, project: AutonomyProject, busy: boolean, confirming: boolean | null = null): AutonomyBoundaryView {
  const entry = boundaryOf(policy, project.id);
  const on = entry !== null;
  const stateText = on ? "On" : "Off";
  const since = entry === null ? null : `On since ${entry.at.slice(0, 10)}`;
  const asking = confirming !== null && confirming !== on;
  return {
    label: BOUNDARY_LABEL,
    on,
    stateText,
    caption: BOUNDARY_MEANING,
    since,
    choices: [false, true].map((enabled) => {
      const selected = enabled === on;
      const label = enabled ? "On" : "Off";
      return {
        enabled,
        label,
        selected,
        pressable: !busy && !selected && !asking,
        accessibilityLabel: selected ? `${BOUNDARY_LABEL} in ${project.label} is ${label}` : `Turn the ${BOUNDARY_LABEL.toLowerCase()} in ${project.label} ${enabled ? "on" : "off"}`,
      };
    }),
    confirm: asking ? (confirming ? boundaryOnDialog(project.label) : boundaryOffDialog(project.label)) : null,
    accessibilityLabel: `${BOUNDARY_LABEL}: ${stateText}. ${BOUNDARY_MEANING}`,
  };
}

function rowView(
  policy: AutonomyPolicy,
  project: AutonomyProject,
  decisionClass: DecisionClass,
  busy: boolean,
  confirming: DelegateConfirming | null,
): AutonomyRowView {
  const label = CLASS_LABELS[decisionClass];
  const mode = modeOf(policy, project.id, decisionClass);
  if (!canDelegate(decisionClass)) {
    const modeText = `${MODE_LABELS[mode]} (fixed)`;
    const caption = OWNER_ONLY_REASONS[decisionClass] ?? null;
    return {
      decisionClass,
      label,
      mode,
      modeText,
      fixed: true,
      caption,
      choices: [],
      delegate: null,
      accessibilityLabel: `${label}: ${modeText}. ${caption ?? ""}`.trim(),
    };
  }
  const cell = cellOf(policy, project.id, decisionClass);
  const caption = cell?.mode === "delegate" ? `Decided for you by ${PREDICTOR_WORDS[cell.predictor]} since ${cell.at.slice(0, 10)}` : null;
  const modeText = MODE_LABELS[mode];
  const asked = confirming !== null && confirming.decisionClass === decisionClass && mode !== "delegate" ? confirming : null;
  return {
    decisionClass,
    label,
    mode,
    modeText,
    fixed: false,
    caption,
    choices: SETTABLE_MODES.map((choice) => {
      const selected = mode === choice;
      return {
        mode: choice,
        label: MODE_LABELS[choice],
        selected,
        enabled: !busy && !selected && !(choice === "delegate" && asked !== null),
        accessibilityLabel: selected
          ? `${label} in ${project.label} is ${MODE_LABELS[choice]}`
          : choice === "delegate"
            ? `Delegate ${label} in ${project.label}…`
            : `Set ${label} in ${project.label} to ${MODE_LABELS[choice]}`,
      };
    }),
    delegate:
      asked === null
        ? null
        : {
            label: DECIDED_BY_LABEL,
            predictors: PREDICTORS.map((predictor) => ({
              predictor,
              label: PREDICTOR_LABELS[predictor],
              selected: predictor === asked.predictor,
              accessibilityLabel: `${label} decided by ${PREDICTOR_WORDS[predictor]}`,
            })),
            dialog: delegateDialog({ classLabel: label, projectLabel: project.label, predictor: asked.predictor }),
            input: { workspaceId: project.id, class: decisionClass, mode: "delegate", confirmed: true, predictor: asked.predictor },
          },
    accessibilityLabel: caption === null ? `${label}: ${modeText}` : `${label}: ${modeText}. ${caption}`,
  };
}

/**
 * One project's matrix: its summary, the Orchestrator predictions switch, a
 * row per class (the one whose delegation is asked carries its confirmation),
 * and Return all to owner (offered while a class is above
 * `owner`; it leaves the predictions as they are).
 */
export function autonomyMatrixView(input: {
  policy: AutonomyPolicy;
  project: AutonomyProject;
  busy: boolean;
  confirmingBoundary?: boolean | null;
  /** The delegation whose confirmation is open (§B.4), or none. */
  confirmingDelegate?: DelegateConfirming | null;
}): AutonomyMatrixView {
  const { policy, project, busy } = input;
  const counts = cellsAboveOwner(policy, project.id);
  const above = counts.delegated + counts.shadow > 0;
  return {
    title: project.label,
    summary: countsText(counts) ?? "Every decision in this project is yours",
    boundary: boundaryView(policy, project, busy, input.confirmingBoundary ?? null),
    challenger: challengerView(policy, project, busy),
    rows: AUTONOMY_ROW_ORDER.map((decisionClass) => rowView(policy, project, decisionClass, busy, input.confirmingDelegate ?? null)),
    reset: {
      enabled: !busy && above,
      label: RETURN_ALL_LABEL,
      accessibilityLabel: `Return every class of ${project.label} to owner`,
    },
  };
}

// ---------------------------------------------------------------------------
// Precedents (autonomy design §B.6, §B.9; PRD REQ-124): the owner's standing
// answers, below the matrix.
// ---------------------------------------------------------------------------

/** The active precedents (`precedents.list`); a decision card that saves one refreshes this same query. */
export const PRECEDENTS_QUERY_KEY = ["paseo-bm", "autonomy", "precedents"] as const;

export const PRECEDENTS_TITLE = "Precedents";

/** What a precedent does, in one line. */
export const PRECEDENTS_MEANING =
  "Your standing answers: a later question on the same subject gets it without asking you until it expires — release, data, security and cost questions still come to you.";

export const PRECEDENTS_NONE = "No precedent yet. Save one from an answered decision (Save as precedent…) or add one here.";

export const ADD_PRECEDENT_LABEL = "Add precedent…";

export const ALL_PROJECTS_LABEL = "All projects";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Add precedent form as the owner is filling it: `scope` is a project id or `all`. */
export interface PrecedentFormState {
  scope: string;
  subject: string;
  text: string;
}

/** What the owner is doing with the precedents right now. */
export interface PrecedentsUi {
  /** The Add precedent form, open when not null. */
  form: PrecedentFormState | null;
  /** The precedent whose End is being confirmed, by id. */
  ending: string | null;
  busy: boolean;
  /** What the last save or end could not do. */
  error: string | null;
}

export const PRECEDENTS_UI_IDLE: PrecedentsUi = { form: null, ending: null, busy: false, error: null };

export interface PrecedentRowView {
  /** The key the row is drawn and ended by; never shown. */
  id: string;
  scopeText: string;
  subject: string;
  text: string;
  expiresText: string;
  sourceText: string;
  end: { label: string; enabled: boolean; accessibilityLabel: string };
  /** The End confirmation, Cancel first, while it is asked for this row. */
  confirm: ConfirmDialog | null;
  accessibilityLabel: string;
}

export interface PrecedentScopeChoiceView {
  key: string;
  label: string;
  selected: boolean;
  accessibilityLabel: string;
}

export interface PrecedentFormView {
  title: string;
  scopes: PrecedentScopeChoiceView[];
  subject: string;
  subjectLabel: string;
  subjectHint: string;
  /** Why the subject cannot be saved as it is; null while it can (or is still empty). */
  subjectError: string | null;
  text: string;
  textLabel: string;
  /** Why the text cannot be saved as it is; null while it can (or is still empty). */
  textError: string | null;
  cancelLabel: string;
  saveLabel: string;
  saveEnabled: boolean;
  busy: boolean;
}

export interface PrecedentsView {
  title: string;
  meaning: string;
  /** The line shown when there is none; null otherwise. */
  empty: string | null;
  rows: PrecedentRowView[];
  /** "Add precedent…", while the form is closed. */
  add: { label: string; enabled: boolean; accessibilityLabel: string } | null;
  form: PrecedentFormView | null;
  /** A save or an end is running. */
  busy: boolean;
  error: string | null;
}

/** A precedent's scope in the owner's words: a project's name, "All projects", or an unnamed project — never an id. */
export function precedentScopeText(scope: string, projects: readonly AutonomyProject[]): string {
  if (scope === PRECEDENT_SCOPE_ALL) return ALL_PROJECTS_LABEL;
  return projects.find((project) => project.id === scope)?.label ?? "Unnamed project";
}

function plainDate(iso: string): string {
  return iso.slice(0, 10);
}

/** "Until 2026-10-30 · 29 days left", or "Expires today" on its last day. */
export function precedentExpiresText(expiresAt: string, now: Date): string {
  const left = Math.ceil((Date.parse(expiresAt) - now.getTime()) / DAY_MS);
  if (!(left > 1)) return `Until ${plainDate(expiresAt)} · expires within a day`;
  return `Until ${plainDate(expiresAt)} · ${left} days left`;
}

/** Where a precedent came from: an answered decision (its id stays out of the text) or Settings. */
function sourceText(precedent: Precedent): string {
  return precedent.sourceDecisionId === null
    ? `Added in Settings on ${plainDate(precedent.createdAt)}`
    : `From your answer on ${plainDate(precedent.createdAt)}`;
}

function endDialog(subject: string, scopeText: string): ConfirmDialog {
  return {
    title: `End the precedent on "${subject}"?`,
    body: `Later questions on "${subject}" in ${scopeText === ALL_PROJECTS_LABEL ? "every project" : scopeText} come to you again. To change it, end it and add a new one.`,
    confirmLabel: "End precedent",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** The Add precedent form, opened on the project shown in the matrix (else all projects), empty. */
export function openPrecedentForm(defaultScope: string | null): PrecedentFormState {
  return { scope: defaultScope ?? PRECEDENT_SCOPE_ALL, subject: "", text: "" };
}

/** Why the form's subject and text cannot be saved as they are; null each while it can or is still empty. */
export function precedentFormErrors(form: PrecedentFormState): { subject: string | null; text: string | null } {
  const subject = form.subject.trim();
  const length = [...form.text.trim()].length;
  return {
    subject: subject === "" || SUBJECT_PATTERN.test(subject) ? null : "Lowercase letters, digits and dashes only, at most 60.",
    text: length > MAX_PRECEDENT_TEXT_CHARS ? `At most ${MAX_PRECEDENT_TEXT_CHARS} characters (now ${length}).` : null,
  };
}

function formView(form: PrecedentFormState, projects: readonly AutonomyProject[], busy: boolean): PrecedentFormView {
  const errors = precedentFormErrors(form);
  const choices = [...projects.map((project) => ({ key: project.id, label: project.label })), { key: PRECEDENT_SCOPE_ALL, label: ALL_PROJECTS_LABEL }];
  return {
    title: "Add a precedent",
    scopes: choices.map((choice) => ({
      key: choice.key,
      label: choice.label,
      selected: choice.key === form.scope,
      accessibilityLabel: choice.key === PRECEDENT_SCOPE_ALL ? "Keep it for every project" : `Keep it for ${choice.label} only`,
    })),
    subject: form.subject,
    subjectLabel: "The subject it answers",
    subjectHint: "The subject a question carries — shown in a decision's Details, e.g. test-layout.",
    subjectError: errors.subject,
    text: form.text,
    textLabel: "The answer to keep",
    textError: errors.text,
    cancelLabel: "Cancel",
    saveLabel: busy ? "Saving…" : "Save precedent",
    saveEnabled:
      !busy &&
      errors.subject === null &&
      errors.text === null &&
      form.subject.trim() !== "" &&
      form.text.trim() !== "" &&
      choices.some((choice) => choice.key === form.scope),
    busy,
  };
}

/**
 * The precedents block: the active precedents newest first, each with its
 * project, subject, answer, expiry and where it came from, and **End** (its
 * confirmation in place, Cancel first); **Add precedent…** or the form.
 */
export function precedentsView(input: {
  precedents: readonly Precedent[];
  projects: readonly AutonomyProject[];
  ui: PrecedentsUi;
  now: Date;
}): PrecedentsView {
  const { precedents, projects, ui, now } = input;
  const rows = precedents.map((precedent): PrecedentRowView => {
    const scopeText = precedentScopeText(precedent.scope, projects);
    const expiresText = precedentExpiresText(precedent.expiresAt, now);
    const confirming = ui.ending === precedent.id;
    return {
      id: precedent.id,
      scopeText,
      subject: precedent.subject,
      text: precedent.text,
      expiresText,
      sourceText: sourceText(precedent),
      end: {
        label: "End",
        enabled: !ui.busy && ui.ending === null,
        accessibilityLabel: `End the precedent on ${precedent.subject} in ${scopeText}`,
      },
      confirm: confirming ? endDialog(precedent.subject, scopeText) : null,
      accessibilityLabel: `Precedent on ${precedent.subject}, ${scopeText}: ${precedent.text}. ${expiresText}`,
    };
  });
  return {
    title: PRECEDENTS_TITLE,
    meaning: PRECEDENTS_MEANING,
    empty: rows.length === 0 && ui.form === null ? PRECEDENTS_NONE : null,
    rows,
    add:
      ui.form === null
        ? { label: ADD_PRECEDENT_LABEL, enabled: !ui.busy && ui.ending === null, accessibilityLabel: "Add a precedent: a standing answer for a subject" }
        : null,
    form: ui.form === null ? null : formView(ui.form, projects, ui.busy),
    busy: ui.busy,
    error: ui.error,
  };
}

/** `precedents.save`'s input for the form: the scope as chosen, the subject and text trimmed. */
export function precedentSaveInputOf(form: PrecedentFormState): { scope: string; subject: string; text: string } {
  return { scope: form.scope, subject: form.subject.trim(), text: form.text.trim() };
}
