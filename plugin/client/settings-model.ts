/**
 * What the Settings section of the management surface says (experience
 * concept §4.4, autonomy design §A.12, §G.7; change-014 outcome 5): Autonomy
 * and Coordination open on the screen, then **More** — Agents, Precedents and
 * Data — each folded to one line with its state.
 *
 * The groups reuse the Setup screen's pieces and wording
 * (`settings-roles-model.ts`, `settings-machine-model.ts`); this file only decides the one-line state of each folded group, the Data group's
 * storage rows, the Coordination group's advice cadence, and which groups are
 * open; the Autonomy level is `settings-autonomy-model.ts`,
 * the Coordination group's compaction and handoff cards
 * `settings-coordination-model.ts`. Tools & skills is a section of its own
 * (`tools-screen-model.ts`).
 * The rest of the old Setup screen is retired (autonomy design §A.14): the
 * Orchestrator is opened from the Inbox, and no screen edits a role's
 * additional instructions.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { SetupStatus, StoreSize, WorkspaceState } from "../shared/contracts";
import { ADVICE_EVERY_FINISHED, type CoordinationSettings } from "../shared/coordination";
import type { Precedent } from "../shared/precedents";
import { formatBytes } from "./format";
import { storageView } from "./history-model";
import { mechanismsText, switchedOffMechanisms, switchedOffText } from "./settings-coordination-model";
import type { Badge, Tone } from "./tone";
import { SETUP_ROLES, providerLabel } from "./settings-roles-model";

/** The folded groups under More. */
export type SettingsGroupKey = "agents" | "precedents" | "data";

/**
 * The groups under More, in the mockup's order (change-014 outcome 5). A
 * group with `opens: false` would be one line that does not open; every group
 * opens today.
 */
export const SETTINGS_GROUPS: ReadonlyArray<{ key: SettingsGroupKey; title: string; hint: string; opens: boolean }> = [
  { key: "agents", title: "Agents", hint: "Manager, Worker, Reviewer, Orchestrator — provider, model, mode", opens: true },
  { key: "precedents", title: "Precedents", hint: "your standing answers", opens: true },
  { key: "data", title: "Data", hint: "data folder, trace storage, remove settings", opens: true },
];

/** Where More opens: every group folded, so the states read at a glance. */
export const DEFAULT_OPEN_GROUPS: ReadonlySet<SettingsGroupKey> = new Set();

/** The set of open groups after a press on `key`; a group that does not open stays closed. */
export function toggleGroup(open: ReadonlySet<SettingsGroupKey>, key: SettingsGroupKey): Set<SettingsGroupKey> {
  const next = new Set(open);
  if (next.has(key)) next.delete(key);
  else if (SETTINGS_GROUPS.find((group) => group.key === key)?.opens === true) next.add(key);
  return next;
}

/** One group's folded line: its state in words and the tone it is drawn in. */
export interface GroupState {
  text: string;
  tone: Tone;
}

const TONE_RANK: Readonly<Record<Tone, number>> = { danger: 3, warning: 2, info: 1, success: 0, muted: 0, plain: 0 };

/** The problems of a group, worst first, as one line; `ok` when there are none. */
function stateOf(problems: readonly Badge[], ok: GroupState): GroupState {
  if (problems.length === 0) return ok;
  const sorted = [...problems].sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
  return { text: sorted.map((problem) => problem.text).join(" · "), tone: sorted[0]!.tone };
}

const roleName = (role: string): string => SETUP_ROLES.find((entry) => entry.role === role)?.label ?? role;

/** What the header of a group says while `setup.status` has not answered. */
export const GROUP_LOADING: GroupState = { text: "Checking…", tone: "muted" };

/**
 * The Agents group's line: roles not created, the settings removed, Paseo's
 * agent tools off, a provider signed out, a role's last agent without Paseo
 * tools. Nothing wrong: how many roles are ready.
 */
export function agentsGroupState(
  status: SetupStatus | undefined,
  roles: { error: string | null; cleanedUp: boolean } = { error: null, cleanedUp: false },
): GroupState {
  if (status === undefined) return GROUP_LOADING;
  const setup = status.setup;
  const problems: Badge[] = [];
  if (roles.cleanedUp) problems.push({ text: "paseo-bm's settings were removed", tone: "warning" });
  else if (roles.error !== null) problems.push({ text: "The roles could not be set up", tone: "danger" });
  if (setup !== undefined && !roles.cleanedUp && setup.roles.missing.length > 0) {
    problems.push({ text: `Not created: ${setup.roles.missing.map(roleName).join(", ")}`, tone: "danger" });
  }
  if (setup?.agentTools.injectIntoAgents === false) problems.push({ text: "Agent tools off", tone: "warning" });
  if (setup?.agentTools.injectIntoAgents === null) problems.push({ text: "Agent tools unknown", tone: "warning" });
  for (const login of setup?.logins ?? []) {
    if (login.state === "logged-out") problems.push({ text: `${providerLabel(login.provider)} not signed in`, tone: "warning" });
  }
  for (const role of ["manager", "worker"] as const) {
    if (status.paseoTools?.[role]?.state === "missing") {
      problems.push({ text: `Last ${roleName(role)} had no Paseo tools`, tone: "warning" });
    }
  }
  if (setup === undefined) return stateOf(problems, { text: "Roles, models and fallbacks", tone: "muted" });
  const present = setup.roles.present.length;
  const signedIn = setup.logins.length > 0 && setup.logins.every((login) => login.state === "logged-in");
  return stateOf(problems, {
    text: [`${present} role${present === 1 ? "" : "s"} ready`, "agent tools on", ...(signedIn ? ["signed in"] : [])].join(" · "),
    tone: "success",
  });
}

/** The Precedents group's line: how many are active, or none yet. */
export function precedentsGroupState(precedents: readonly Precedent[] | undefined, failed = false): GroupState {
  if (failed) return { text: "The precedents could not be read", tone: "danger" };
  if (precedents === undefined) return GROUP_LOADING;
  return { text: precedents.length === 0 ? "None yet" : `${precedents.length} active`, tone: "muted" };
}

/** One workspace with trace history, as `traces.workspaces` reports it. */
export interface StoredWorkspaceBytes {
  workspaceId: string;
  state: WorkspaceState;
  lastKnownName: string | null;
  lastKnownDirectory: string | null;
  lastSeenAt: string | null;
  bytes: number;
}

export interface StorageRow {
  workspaceId: string;
  /** The workspace's last known name; never its id. */
  label: string;
  detail: string;
  state: WorkspaceState;
}

export interface StorageSummary {
  totalBytes: number;
  summary: string;
  /** The trace store is over the machine-wide threshold (`storageView`). */
  warning: Badge | null;
  /** Largest first: the rows worth cleaning up are on top. */
  rows: StorageRow[];
}

const STATE_WORDS: Readonly<Record<WorkspaceState, string | null>> = {
  live: "open in Paseo",
  archived: "archived",
  orphaned: "no longer in Paseo",
  unknown: null,
};

/** The Data group's storage: the total against the threshold, then one row per workspace. */
export function storageSummary(workspaces: readonly StoredWorkspaceBytes[], warnAboveBytes: number): StorageSummary {
  const totalBytes = workspaces.reduce((sum, entry) => sum + entry.bytes, 0);
  const store: StoreSize = { bytes: totalBytes, workspaceBytes: totalBytes };
  const count = workspaces.length;
  const rows = [...workspaces]
    .sort((a, b) => b.bytes - a.bytes || (a.lastSeenAt ?? "").localeCompare(b.lastSeenAt ?? ""))
    .map((entry) => ({
      workspaceId: entry.workspaceId,
      label: entry.lastKnownName ?? entry.lastKnownDirectory ?? "Unnamed workspace",
      detail: [
        formatBytes(entry.bytes),
        STATE_WORDS[entry.state],
        entry.lastSeenAt === null ? null : `last active ${entry.lastSeenAt.slice(0, 10)}`,
      ]
        .filter((part) => part !== null)
        .join(" · "),
      state: entry.state,
    }));
  return {
    totalBytes,
    summary:
      count === 0
        ? "No traces recorded yet."
        : `${formatBytes(totalBytes)} of traces in ${count} workspace${count === 1 ? "" : "s"}. Warns above ${formatBytes(warnAboveBytes)}.`,
    warning: storageView(store, warnAboveBytes).warning,
    rows,
  };
}

/** Where the threshold is changed: Paseo's own settings screen for the plugin. */
export const THRESHOLD_NOTE = "Change the warning size in Paseo's settings, under Beads Dashboard.";

/**
 * The Data group's line: the data folder unusable, the settings removed, the
 * trace store over its threshold. Nothing wrong: how much the traces take.
 */
export function dataGroupState(
  status: SetupStatus | undefined,
  storage: StorageSummary | null,
  cleanedUp = false,
): GroupState {
  if (status === undefined) return GROUP_LOADING;
  const problems: Badge[] = [];
  if (status.setup?.dataHome.path === null) problems.push({ text: "The data folder cannot be used", tone: "danger" });
  if (cleanedUp) problems.push({ text: "Settings removed", tone: "warning" });
  if (storage !== null && storage.warning !== null) {
    problems.push({ text: `Traces ${formatBytes(storage.totalBytes)}, over the warning size`, tone: "warning" });
  }
  const ok =
    storage === null
      ? { text: "Data folder, traces and cleanup", tone: "muted" as const }
      : { text: storage.rows.length === 0 ? "No traces yet" : `${formatBytes(storage.totalBytes)} of traces`, tone: "muted" as const };
  return stateOf(problems, ok);
}

// ---------------------------------------------------------------------------
// Coordination (autonomy design §G.7): the advice cadence. The compaction and
// handoff cards of Phase 3 are `settings-coordination-model.ts`.
// ---------------------------------------------------------------------------

/** What the advice cadence means, in one line. */
export const ADVICE_MEANING = "0 turns advice off. Advice comes to the Inbox as a proposal you accept or not.";

/** The advice field's words, around its value (the approved mockup). */
export const ADVICE_FIELD = { before: "Review the workflow every", after: "finished requests" } as const;

/** The cadence in words. */
export function adviceCadenceText(everyFinished: number): string {
  if (everyFinished <= 0) return "Advice off";
  return everyFinished === 1 ? "Advice after every finished request" : `Advice after every ${everyFinished} finished requests`;
}

/**
 * The Coordination group's line: the cadence and the two switches in words; a
 * mechanism paseo-bm switched off below A-12's target first, as a warning; or
 * that the settings could not be read.
 */
export function coordinationGroupState(settings: CoordinationSettings | undefined, failed = false): GroupState {
  if (failed) return { text: "The coordination settings could not be read", tone: "danger" };
  if (settings === undefined) return GROUP_LOADING;
  const advice = adviceCadenceText(settings.advice.everyFinished);
  const switchedOff = switchedOffMechanisms(settings);
  if (switchedOff.length > 0) return { text: `${switchedOffText(switchedOff)} · ${advice}`, tone: "warning" };
  return { text: `${advice} · ${mechanismsText(settings)}`, tone: "muted" };
}

/** The cadence one step down or up, kept within its bounds. */
export function stepAdviceCadence(value: number, step: -1 | 1): number {
  return Math.min(ADVICE_EVERY_FINISHED.max, Math.max(ADVICE_EVERY_FINISHED.min, value + step));
}

/** A button of the cadence row: whether it can be pressed and what a screen reader says. */
export interface CadenceButton {
  enabled: boolean;
  label: string;
  accessibilityLabel: string;
}

/** The advice cadence row: its meaning, the value being edited with − and +, Save, and the default. */
export interface AdviceCadenceView {
  title: string;
  meaning: string;
  /** The value being edited, in words. */
  valueText: string;
  /** The value as its field shows it. */
  inputText: string;
  /** What a screen reader says for the field. */
  accessibilityLabel: string;
  decrease: CadenceButton;
  increase: CadenceButton;
  /** Enabled while the edited value differs from the stored one. */
  save: CadenceButton;
  /** Offered while the edited value is not the default. */
  reset: CadenceButton | null;
}

export function adviceCadenceView(input: { stored: number; draft: number; defaultValue: number; saving: boolean }): AdviceCadenceView {
  const { stored, draft, defaultValue, saving } = input;
  const lower = stepAdviceCadence(draft, -1);
  const higher = stepAdviceCadence(draft, 1);
  const spoken = (value: number) => (value === 0 ? "0, off" : String(value));
  return {
    title: "Orchestrator advice",
    meaning: ADVICE_MEANING,
    valueText: adviceCadenceText(draft),
    inputText: String(draft),
    accessibilityLabel: `Advice cadence: ${adviceCadenceText(draft)}`,
    decrease: { enabled: !saving && lower !== draft, label: "−", accessibilityLabel: `Advice cadence: lower to ${spoken(lower)}` },
    increase: { enabled: !saving && higher !== draft, label: "+", accessibilityLabel: `Advice cadence: raise to ${spoken(higher)}` },
    save: {
      enabled: !saving && draft !== stored,
      label: saving ? "Saving…" : "Save",
      accessibilityLabel: `Save the advice cadence: ${adviceCadenceText(draft)}`,
    },
    reset:
      draft === defaultValue
        ? null
        : {
            enabled: !saving,
            label: `Use the default (${defaultValue})`,
            accessibilityLabel: `Set the advice cadence back to its default: ${adviceCadenceText(defaultValue)}`,
          },
  };
}

/** The header of a group: what it shows and what a screen reader says. */
export interface GroupHeaderView {
  title: string;
  /** What the group holds, after its title in muted text. */
  hint: string;
  marker: "▸" | "▾" | null;
  state: GroupState;
  accessibilityLabel: string;
}

export function groupHeaderView(key: SettingsGroupKey, state: GroupState, expanded: boolean): GroupHeaderView {
  const group = SETTINGS_GROUPS.find((entry) => entry.key === key)!;
  if (!group.opens) {
    return { title: group.title, hint: group.hint, marker: null, state, accessibilityLabel: `${group.title}: ${state.text}` };
  }
  return {
    title: group.title,
    hint: group.hint,
    marker: expanded ? "▾" : "▸",
    state,
    accessibilityLabel: `${group.title}, ${group.hint}: ${state.text}. ${expanded ? "Collapse" : "Expand"}.`,
  };
}
