/**
 * What Settings → Autonomy says (ADR-025; autonomy design §B.2, §A.12;
 * experience concept §4.4; change-014 outcome 5): one **level** per project on
 * a control of five stops — Hands-on, Co-pilot, Cruise, Turbo, Full auto —
 * with one sentence on what the selected level means and, for each of the
 * nine classes, who decides it there: the Orchestrator, the Orchestrator's
 * proposal for the owner's approval, or the owner.
 *
 * A level is set at once (`autonomy.set-level`), except Turbo and Full auto:
 * they open an in-place confirmation that says what the Orchestrator will
 * decide without the owner, Cancel first and the default, then
 * `autonomy.set-level` with `confirmed: true` (ADR-025 decision 3). Cells that
 * match no level read as **Custom**: the classes then show their current
 * cells, read-only, and no stop is selected until a level is chosen.
 *
 * Under the control, **Hold risky actions for approval** is the project's
 * action boundary (autonomy design §D.2, change-010): off by default; each
 * direction opens an in-place confirmation (Cancel first), then
 * `autonomy.set-boundary` with `confirmed: true`. A level leaves it alone.
 *
 * Projects are named as Insights names them (`insightsProjects`); a project
 * the policy still holds something for but the surface no longer knows by name
 * is listed as an unnamed project, never by its id.
 *
 * The owner's **precedents** (autonomy design §B.6; PRD REQ-124) are under
 * Settings → More: the active ones with their project, subject, answer and
 * expiry, **End** on each (a confirmation, Cancel first) and **Add precedent…**.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import {
  LEVELS,
  boundaryOf,
  boundaryProjects,
  challengerOf,
  levelNeedsConfirmation,
  levelOf,
  modeOf,
  type AutonomyLevel,
  type AutonomyLevelReading,
  type AutonomyMode,
  type AutonomyPolicy,
} from "../shared/autonomy";
import { DECISION_CLASSES, SUBJECT_PATTERN, type DecisionClass } from "../shared/decisions";
import { MAX_PRECEDENT_TEXT_CHARS, PRECEDENT_SCOPE_ALL, type Precedent } from "../shared/precedents";
import type { InsightsProject } from "./insights-model";
import type { ConfirmDialog } from "./ui-types";

/** The owner's whole autonomy policy (`autonomy.policy {}`): Settings and Insights read this one query, and a screen that changes the policy writes it. */
export const AUTONOMY_POLICY_KEY = ["paseo-bm", "autonomy", "policy"] as const;

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

/** A cell's mode in the owner's words (Insights' agreement table). */
export const MODE_LABELS: Readonly<Record<AutonomyMode, string>> = { owner: "Owner", shadow: "Shadow", delegate: "Delegated" };

/** What the levels are for, in one line, above the project tabs. */
export const AUTONOMY_MEANING =
  "How much the Orchestrator may decide for you, per project. You can change it at any time. Your overrides are recorded; they never change the level.";

/** The group's body when there is no project to show. */
export const AUTONOMY_NO_PROJECTS = "No project yet. Each workspace you open in Paseo gets its own level here.";

/** What each level means, in one sentence (ADR-025 decision 1). */
export const LEVEL_SUMMARIES: Readonly<Record<AutonomyLevel, string>> = {
  0: "Hands-on. The Orchestrator never decides. Every question is yours, as asked.",
  1: "Co-pilot. The Orchestrator prepares an answer to every question; nothing runs until you approve it in the Inbox.",
  2: "Cruise. The Orchestrator decides technical, preference, scope, environment and dependency questions on its own; it proposes the rest for your approval.",
  3: "Turbo. As Cruise, plus cost, release and data. Security still waits for your approval.",
  4: "Full auto. The Orchestrator decides every question, security included. You see each one under Decided for you and can override it.",
};

/** The project's cells match no level. */
export const CUSTOM_LABEL = "Custom";

export const CUSTOM_SUMMARY =
  "Custom. These classes were set one by one and match no level. Choose a level to replace them; until then they stay as shown.";

/** Who decides a class: the Orchestrator, the Orchestrator's proposal for your approval, or you. */
export type ClassDecider = "orchestrator" | "approve" | "owner";

export const DECIDER_WORDS: Readonly<Record<ClassDecider, string>> = {
  orchestrator: "Orchestrator",
  approve: "You approve",
  owner: "You",
};

/** What the three words of the class list mean, one entry each, in the legend under it (the approved mockup). */
export const DECIDER_LEGEND_ENTRIES: ReadonlyArray<{ decider: ClassDecider; text: string }> = [
  { decider: "orchestrator", text: "Orchestrator decides, you can override" },
  { decider: "approve", text: "Orchestrator proposes, you approve" },
  { decider: "owner", text: "You decide" },
];

/** The legend in one line, as a screen reader says it. */
export const DECIDER_LEGEND = DECIDER_LEGEND_ENTRIES.map((entry) => entry.text).join(" · ");

/** The class list's own names (the approved mockup): "Technical" for the reversible technical class, the others as everywhere. */
export const LEVEL_CLASS_LABELS: Readonly<Record<DecisionClass, string>> = { ...CLASS_LABELS, "reversible-technical": "Technical" };

/** The class list's order: the five Cruise classes, then cost, release, data and security — the order the levels add them in. */
export const AUTONOMY_CLASS_ORDER: readonly DecisionClass[] = [
  ...LEVELS[3]!.delegated,
  ...DECISION_CLASSES.filter((decisionClass) => !LEVELS[3]!.delegated.includes(decisionClass)),
];

/** Who decides `decisionClass` at `level`: Hands-on the owner; else the Orchestrator where the level delegates it, its proposal elsewhere. */
export function deciderAtLevel(level: AutonomyLevel, decisionClass: DecisionClass): ClassDecider {
  if (level === 0) return "owner";
  return LEVELS[level]!.delegated.includes(decisionClass) ? "orchestrator" : "approve";
}

/** Who decides `decisionClass` by the project's own cell (a Custom project): delegated, a shadow cell with predictions on, or the owner. */
export function deciderOfCell(policy: AutonomyPolicy, workspaceId: string, decisionClass: DecisionClass): ClassDecider {
  const mode = modeOf(policy, workspaceId, decisionClass);
  if (mode === "delegate") return "orchestrator";
  return mode === "shadow" && challengerOf(policy, workspaceId) ? "approve" : "owner";
}

/** A level reading in words: the level's name, or Custom. */
export function levelText(reading: AutonomyLevelReading): string {
  return reading === "custom" ? CUSTOM_LABEL : LEVELS[reading]!.name;
}

/** The confirmation of Turbo or Full auto (ADR-025 decision 3): what the Orchestrator will decide without the owner, Cancel first and the default. */
export function levelConfirmDialog(level: AutonomyLevel, projectLabel: string): ConfirmDialog {
  const name = LEVELS[level]!.name;
  return {
    title: level === 4 ? "Let the Orchestrator decide security questions too?" : "Let the Orchestrator decide cost, release and data?",
    body:
      level === 4
        ? "Security trade-offs, permissions and credentials questions will be answered without you. Each one still shows under Decided for you, where you can override it."
        : "Releases, pushes, deploys, migrations on real data and spending will be decided without you. Each one shows under Decided for you, where you can override it.",
    confirmLabel: `Switch to ${name}`,
    cancelLabel: "Cancel",
    confirmAccessibilityLabel: `Switch ${projectLabel} to ${name}`,
    defaultAction: "cancel",
  };
}

/** What a press on a stop does: nothing on the level already set, its confirmation for Turbo and Full auto, else the level at once. */
export function levelPressOf(reading: AutonomyLevelReading, level: AutonomyLevel): "none" | "confirm" | "set" {
  if (level === reading) return "none";
  return levelNeedsConfirmation(level) ? "confirm" : "set";
}

/** `autonomy.set-level`'s input for a level of a project; `confirmed` only where the level needs it and the owner confirmed. */
export function setLevelInputOf(workspaceId: string, level: AutonomyLevel): { workspaceId: string; level: AutonomyLevel; confirmed?: true } {
  return levelNeedsConfirmation(level) ? { workspaceId, level, confirmed: true } : { workspaceId, level };
}

/** The action boundary switch's name (autonomy design §D.2, change-014). */
export const BOUNDARY_LABEL = "Hold risky actions for approval";

/** What the switch does, in one line (off by default). */
export const BOUNDARY_MEANING =
  "Pushes, deploys, installs and writes outside the project wait in the Inbox, for this project's Workers and Reviewers.";

/** The confirmation of turning the boundary on (change-010 C4). */
export function boundaryOnDialog(projectLabel: string): ConfirmDialog {
  return {
    title: `Hold risky actions for approval in ${projectLabel}?`,
    body: [
      "• Workers and Reviewers created from now on in this project run in the least permissive mode (Claude: default; Codex: auto with its creation options).",
      "• Each action the boundary holds — a release, real data, a dependency install, the network, a write outside the workspace, or a request it cannot read — waits for you, unless your answer to the Worker's question (a grant: one use, 60 minutes) or the project's level lets the Orchestrator decide it.",
      "• Agents that already exist keep their mode.",
    ].join("\n"),
    confirmLabel: "Turn on",
    cancelLabel: "Cancel",
    confirmAccessibilityLabel: `Hold risky actions for approval in ${projectLabel}`,
    defaultAction: "cancel",
  };
}

/** The confirmation of turning the boundary off (change-010 C4). */
export function boundaryOffDialog(projectLabel: string): ConfirmDialog {
  return {
    title: `Stop holding risky actions in ${projectLabel}?`,
    body: [
      "• Workers and Reviewers created from now on run in today's modes: their actions are only watched (detection), not held.",
      "• Agents created while it was on keep their mode, and the plugin still answers their requests.",
    ].join("\n"),
    confirmLabel: "Turn off",
    cancelLabel: "Cancel",
    confirmAccessibilityLabel: `Stop holding risky actions in ${projectLabel}`,
    defaultAction: "cancel",
  };
}

/** A project of the Autonomy group: its id (never shown) and its name. */
export interface AutonomyProject {
  id: string;
  label: string;
}

/** Whether the policy holds anything for a project beyond Hands-on with the boundary off: a cell above `owner`, the predictions or the boundary on. */
function holdsSomething(policy: AutonomyPolicy, workspaceId: string): boolean {
  return (
    DECISION_CLASSES.some((decisionClass) => modeOf(policy, workspaceId, decisionClass) !== "owner") ||
    challengerOf(policy, workspaceId) ||
    boundaryOf(policy, workspaceId) !== null
  );
}

/**
 * The projects the group offers: every project Insights names, in its order,
 * then each project the policy still holds something for that no longer has
 * a name — so a level above Hands-on or the boundary can always be seen and
 * taken back.
 */
export function autonomyProjects(named: readonly InsightsProject[], policy: AutonomyPolicy | undefined): AutonomyProject[] {
  const seen = new Set(named.map((project) => project.id));
  const unnamed =
    policy === undefined
      ? []
      : [...new Set([...Object.keys(policy.projects), ...Object.keys(policy.challenger), ...boundaryProjects(policy)])].filter(
          (id) => !seen.has(id) && holdsSomething(policy, id),
        );
  return [
    ...named.map((project) => ({ id: project.id, label: project.label })),
    ...unnamed.map((id, index) => ({ id, label: unnamed.length === 1 ? "Unnamed project" : `Unnamed project ${index + 1}` })),
  ];
}

/** The project shown: the one chosen while it is still listed, else the first. */
export function shownProjectOf(projects: readonly AutonomyProject[], chosen: string | null): AutonomyProject | null {
  return projects.find((project) => project.id === chosen) ?? projects[0] ?? null;
}

/** The project tabs: each project by name, its level after it (in muted mono). */
export function autonomyTabs(
  projects: readonly AutonomyProject[],
  policy: AutonomyPolicy,
): Array<{ key: string; label: string; suffix: string; accessibilityLabel: string }> {
  return projects.map((project) => {
    const level = levelText(levelOf(policy, project.id));
    return { key: project.id, label: project.label, suffix: level, accessibilityLabel: `${project.label}, level ${level}` };
  });
}

/** One stop of the level control: `selected` is the level shown (the one set, or the one being confirmed). */
export interface LevelStopView {
  level: AutonomyLevel;
  name: string;
  label: string;
  selected: boolean;
  /** Where the stop is against the level shown: below it (filled faintly), the one shown, or above it; every stop is above while the project reads Custom. */
  place: "below" | "selected" | "above";
  enabled: boolean;
  accessibilityLabel: string;
}

/** One class of the list under the control: its name and who decides it. */
export interface LevelClassView {
  decisionClass: DecisionClass;
  label: string;
  decider: ClassDecider;
  who: string;
}

/** The project's action boundary switch (§D.2): on or off, what it does, and the confirmation while one is asked. */
export interface AutonomyBoundaryView {
  label: string;
  on: boolean;
  stateText: string;
  caption: string;
  /** Since when it is on, in the owner's words; null while off. */
  since: string | null;
  /** The switch: pressing it asks for the other side's confirmation. */
  toggle: { label: string; pressable: boolean; accessibilityLabel: string };
  /** The confirmation of the side pressed, in place, Cancel first; null when none is asked. */
  confirm: ConfirmDialog | null;
  accessibilityLabel: string;
}

export interface AutonomyLevelView {
  title: string;
  /** The level the project's cells read as. */
  reading: AutonomyLevelReading;
  /** "Level: Cruise", "Level: Custom". */
  levelLine: string;
  stops: LevelStopView[];
  /** How far the slider's track is filled: the shown level's share of the way from the first stop to the last; 0 while Custom. */
  fill: number;
  summary: string;
  classes: LevelClassView[];
  legend: ReadonlyArray<{ decider: ClassDecider; text: string }>;
  /** Turbo or Full auto being confirmed: the level and its confirmation, Cancel first; else null. */
  confirm: { level: AutonomyLevel; dialog: ConfirmDialog } | null;
  boundary: AutonomyBoundaryView;
}

/**
 * The project's action boundary, off or on (off by default, change-010 C1):
 * pressing the switch asks for the other side's confirmation (`confirming`:
 * the side pressed), which says what changes.
 */
export function boundaryView(policy: AutonomyPolicy, project: AutonomyProject, busy: boolean, confirming: boolean | null = null): AutonomyBoundaryView {
  const entry = boundaryOf(policy, project.id);
  const on = entry !== null;
  const stateText = on ? "On" : "Off";
  const asking = confirming !== null && confirming !== on;
  return {
    label: BOUNDARY_LABEL,
    on,
    stateText,
    caption: BOUNDARY_MEANING,
    since: entry === null ? null : `On since ${entry.at.slice(0, 10)}`,
    toggle: {
      label: stateText,
      pressable: !busy && !asking,
      accessibilityLabel: on ? `Stop holding risky actions in ${project.label}…` : `Hold risky actions for approval in ${project.label}…`,
    },
    confirm: asking ? (confirming ? boundaryOnDialog(project.label) : boundaryOffDialog(project.label)) : null,
    accessibilityLabel: `${BOUNDARY_LABEL}: ${stateText}. ${BOUNDARY_MEANING}`,
  };
}

/**
 * One project's level: the five stops (the level set selected, or the one
 * being confirmed; none while the project reads Custom), what the shown level
 * means, who decides each class at it (a Custom project: its own cells), the
 * confirmation of Turbo or Full auto while it is asked, and the boundary.
 */
export function autonomyLevelView(input: {
  policy: AutonomyPolicy;
  project: AutonomyProject;
  busy: boolean;
  /** Turbo or Full auto pressed and not yet confirmed. */
  confirmingLevel?: AutonomyLevel | null;
  confirmingBoundary?: boolean | null;
}): AutonomyLevelView {
  const { policy, project, busy } = input;
  const reading = levelOf(policy, project.id);
  const confirming = input.confirmingLevel ?? null;
  const shown: AutonomyLevelReading = confirming ?? reading;
  return {
    title: project.label,
    reading,
    levelLine: `Level: ${levelText(reading)}`,
    stops: LEVELS.map((definition) => {
      const selected = definition.level === shown;
      return {
        level: definition.level,
        name: definition.name,
        label: `${definition.level} ${definition.name}`,
        selected,
        place: selected ? "selected" : shown !== "custom" && definition.level < shown ? "below" : "above",
        enabled: !busy && !selected,
        accessibilityLabel: `Level ${definition.level}: ${definition.name}`,
      };
    }),
    fill: shown === "custom" ? 0 : shown / (LEVELS.length - 1),
    summary: shown === "custom" ? CUSTOM_SUMMARY : LEVEL_SUMMARIES[shown],
    classes: AUTONOMY_CLASS_ORDER.map((decisionClass) => {
      const decider = shown === "custom" ? deciderOfCell(policy, project.id, decisionClass) : deciderAtLevel(shown, decisionClass);
      return { decisionClass, label: LEVEL_CLASS_LABELS[decisionClass], decider, who: DECIDER_WORDS[decider] };
    }),
    legend: DECIDER_LEGEND_ENTRIES,
    confirm: confirming === null ? null : { level: confirming, dialog: levelConfirmDialog(confirming, project.label) },
    boundary: boundaryView(policy, project, busy, input.confirmingBoundary ?? null),
  };
}

// ---------------------------------------------------------------------------
// Precedents (autonomy design §B.6, §B.9; PRD REQ-124): the owner's standing
// answers, under Settings → More.
// ---------------------------------------------------------------------------

/** The active precedents (`precedents.list`); a decision card that saves one refreshes this same query. */
export const PRECEDENTS_QUERY_KEY = ["paseo-bm", "autonomy", "precedents"] as const;

export const PRECEDENTS_TITLE = "Precedents";

/** What a precedent does, in one line. */
export const PRECEDENTS_MEANING =
  "Your standing answers: a later question on the same subject gets it without asking you, until it expires.";

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

/** The Add precedent form, opened on the given project (else all projects), empty. */
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
