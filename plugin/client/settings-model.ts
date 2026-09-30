/**
 * What the Settings section of the management surface says (experience
 * concept §4.4, autonomy design §A.12): four groups on one scrolling screen,
 * each collapsed to one line with its state.
 *
 * The groups reuse the Setup screen's pieces and wording (`setup-model.ts`);
 * this file only decides the one-line state of each group, the Data group's
 * storage rows, and which groups are open. The rest of the old Setup screen
 * is retired (autonomy design §A.14): the Orchestrator is opened from the
 * Inbox, and no screen edits a role's additional instructions.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { SetupStatus, StoreSize, WorkspaceState } from "../shared/contracts";
import { formatBytes, storageView, type Badge, type Tone } from "./dashboard-model";
import { SETUP_ROLES, migrationBanner, providerLabel, skillAgentOfProvider, toolBadge, SKILL_COLUMNS } from "./setup-model";

export type SettingsGroupKey = "agents" | "autonomy" | "tools" | "data";

/**
 * The groups, in the order of experience concept §4.4. Autonomy is listed
 * where it will live, but it has no content before Phase 2: it is one line
 * and does not open.
 */
export const SETTINGS_GROUPS: ReadonlyArray<{ key: SettingsGroupKey; title: string; hint: string; opens: boolean }> = [
  { key: "agents", title: "Agents", hint: "roles, models, fallbacks, sign-in and agent tools", opens: true },
  { key: "autonomy", title: "Autonomy", hint: "which decisions the agents may take for you", opens: false },
  { key: "tools", title: "Tools & skills", hint: "br, bv and the agent skills", opens: true },
  { key: "data", title: "Data", hint: "data folder, trace storage and cleanup", opens: true },
];

/** The Autonomy group's one line until Phase 2 brings the policy matrix. */
export const AUTONOMY_COMING =
  "Coming in the next phase: per project, which kinds of decision the agents may take for you and which stay yours.";

/** Where the Settings section opens: every group folded, so the four states read at a glance. */
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

/**
 * The Tools & skills group's line: `br` / `bv` missing or out of date, and the
 * required skills of the agent the Worker runs on (the one that uses them).
 */
export function toolsGroupState(status: SetupStatus | undefined): GroupState {
  if (status === undefined) return GROUP_LOADING;
  const problems: Badge[] = [];
  const beadsTools = status.tools.filter((tool) => tool.id === "br" || tool.id === "bv");
  const missing = beadsTools.filter((tool) => tool.path === null).map((tool) => tool.id);
  if (missing.length > 0) problems.push({ text: `Missing ${missing.join(" and ")}`, tone: "danger" });
  for (const tool of beadsTools) {
    if (tool.path !== null && toolBadge(tool).tone === "warning") problems.push({ text: `${tool.id} update available`, tone: "warning" });
  }
  const required = status.skills.skills.filter((skill) => skill.required).length;
  const workerProvider = status.setup?.logins.find((entry) => entry.roles.includes("worker"))?.provider ?? null;
  const column = workerProvider === null ? null : skillAgentOfProvider(workerProvider);
  const workerMissing = column === null ? undefined : status.skills.missingRequired[column.key];
  let skillsText: string;
  if (column !== null && workerMissing !== undefined) {
    skillsText = `Worker skills (${column.agent}) ${required - workerMissing}/${required}`;
    if (workerMissing > 0) problems.push({ text: skillsText, tone: "warning" });
  } else {
    // No Worker provider known: every reported agent's count, as the Setup headline does.
    const counts = SKILL_COLUMNS.flatMap(({ key, agent }) => {
      const count = status.skills.missingRequired[key];
      return count === undefined ? [] : [`${agent} ${required - count}/${required}`];
    });
    skillsText = `skills: ${counts.join(", ")}`;
  }
  const toolsText = missing.length === 0 ? "br and bv ready" : null;
  return stateOf(problems, { text: [toolsText, skillsText].filter((part) => part !== null).join(" · "), tone: "success" });
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
 * The Data group's line: the data folder unusable, the settings removed, an
 * install from the retired npx installer, the trace store over its threshold.
 * Nothing wrong: how much the traces take.
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
  if (migrationBanner(status) !== null) problems.push({ text: "Installed by the old npx installer", tone: "warning" });
  if (storage !== null && storage.warning !== null) {
    problems.push({ text: `Traces ${formatBytes(storage.totalBytes)}, over the warning size`, tone: "warning" });
  }
  const ok =
    storage === null
      ? { text: "Data folder, traces and cleanup", tone: "muted" as const }
      : { text: storage.rows.length === 0 ? "No traces yet" : `${formatBytes(storage.totalBytes)} of traces`, tone: "muted" as const };
  return stateOf(problems, ok);
}

/** The header of a group: what it shows and what a screen reader says. */
export interface GroupHeaderView {
  title: string;
  marker: "▸" | "▾" | null;
  state: GroupState;
  accessibilityLabel: string;
}

export function groupHeaderView(key: SettingsGroupKey, state: GroupState, expanded: boolean): GroupHeaderView {
  const group = SETTINGS_GROUPS.find((entry) => entry.key === key)!;
  if (!group.opens) {
    return { title: group.title, marker: null, state, accessibilityLabel: `${group.title}: ${state.text}` };
  }
  return {
    title: group.title,
    marker: expanded ? "▾" : "▸",
    state,
    accessibilityLabel: `${group.title}, ${group.hint}: ${state.text}. ${expanded ? "Collapse" : "Expand"}.`,
  };
}
