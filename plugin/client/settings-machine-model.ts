/**
 * What Settings says about the machine's set-up — tools, skills, agent tools,
 * sign-in, data folder, cleanup (from the Setup screen, delta
 * 20260916-setup-screen) — and the confirmations in front of each step that
 * grants something, without a renderer. The roles and their fallback chains
 * are in `settings-roles-model.ts`.
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import type { SetupStatus } from "../shared/contracts";
import { rolesCreatedSentence, rolesDefaultsText, type ReviewerApart } from "../shared/roles-created";
import type { Badge } from "./tone";
import { errorMessageOf } from "./errors";
import { SETUP_ROLES } from "./settings-roles-model";
import type { ConfirmDialog } from "./ui-types";
import { localTimeText } from "./format";

type Tool = SetupStatus["tools"][number];
type SkillRow = SetupStatus["skills"]["skills"][number];
type SkillState = SkillRow["claude"];
export type SkillAgent = "Claude" | "Codex" | "Pi" | "OpenCode";

/**
 * The skill columns, in order. Pi and OpenCode (delta 20260921 §4.2.6) are
 * optional in the payload: a column the server did not report is not shown.
 */
export const SKILL_COLUMNS: ReadonlyArray<{ key: "claude" | "codex" | "pi" | "opencode"; agent: SkillAgent }> = [
  { key: "claude", agent: "Claude" },
  { key: "codex", agent: "Codex" },
  { key: "pi", agent: "Pi" },
  { key: "opencode", agent: "OpenCode" },
];

/** Numeric comparison of `0.2.10` / `v0.25.0`; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (value: string) => /(\d+)\.(\d+)(?:\.(\d+))?/.exec(value)?.slice(1).map((part) => Number(part ?? 0));
  const left = parse(a);
  const right = parse(b);
  if (left === undefined || right === undefined) return null;
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function toolBadge(tool: Tool): Badge {
  if (tool.path === null) return tool.required ? { text: "Missing", tone: "danger" } : { text: "Not installed", tone: "muted" };
  if (tool.version !== null && tool.latestKnown !== null && (compareVersions(tool.version, tool.latestKnown) ?? 0) < 0) {
    return { text: `${tool.version} · ${tool.latestKnown} available`, tone: "warning" };
  }
  return { text: tool.version ?? "Installed", tone: "success" };
}

export function skillBadge(agent: SkillAgent, state: SkillState): Badge {
  switch (state) {
    case "ok":
      return { text: `${agent} ✓`, tone: "success" };
    case "broken":
      return { text: `${agent} broken`, tone: "danger" };
    default:
      return { text: `${agent} missing`, tone: "warning" };
  }
}

/** One chip per skill column the row has, in column order. */
export function skillChips(skill: SkillRow): Badge[] {
  return SKILL_COLUMNS.flatMap(({ key, agent }) => {
    const state = skill[key];
    return state === undefined ? [] : [skillBadge(agent, state)];
  });
}

/** Where each agent's skills were looked for, one entry per reported column. */
export function skillDirsText(dirs: SetupStatus["skills"]["dirs"]): string {
  return [
    `Claude: ${dirs.claude}`,
    `Codex: ${dirs.shared} or ${dirs.codex}`,
    ...(dirs.pi === undefined ? [] : [`Pi: ${dirs.pi}`]),
    ...(dirs.opencode === undefined ? [] : [`OpenCode: ${dirs.opencode}`]),
  ].join(" · ");
}

/**
 * One warning per role whose last new agent had no Paseo tools (delta 20260921
 * §4.2.4, REQ-063 d); nothing for `ok`, `unknown` or an older server.
 */
export function paseoToolsWarnings(status: SetupStatus): string[] {
  const seen = status.paseoTools;
  if (seen === undefined) return [];
  return (["manager", "worker"] as const).flatMap((role) => {
    const entry = seen[role];
    if (entry === null || entry.state !== "missing") return [];
    const name = role === "manager" ? "Manager" : "Worker";
    return [
      `The last ${name} (${entry.agentId}) runs on ${entry.provider} without Paseo tools, so it cannot create or message other agents. On Pi, install the pi-mcp-adapter extension.`,
    ];
  });
}

export function installWarning(tool: Tool): string {
  return tool.installCommand?.startsWith("brew ")
    ? `This runs Homebrew on this machine: ${tool.installCommand}`
    : `This downloads and runs the project's install script from GitHub on this machine: ${tool.installCommand ?? ""}`;
}

/** The confirmation in front of a tool's Install: no title, the warning names what runs. */
export function installDialog(tool: Tool): ConfirmDialog {
  return {
    title: null,
    body: installWarning(tool),
    bodyTone: "warning",
    confirmLabel: `Install ${tool.id}`,
    confirmAccessibilityLabel: `Install ${tool.id} on this machine`,
    cancelLabel: "Cancel",
    cancelAccessibilityLabel: `Cancel: do not install ${tool.id}`,
    defaultAction: "cancel",
  };
}

// ---------------------------------------------------------------------------
// Which agent's skills a role's provider needs (the Tools & skills section).
// ---------------------------------------------------------------------------

/** The label Setup uses for the agent whose skills a provider needs. */
export function skillAgentOfProvider(provider: string): { key: "claude" | "codex" | "pi" | "opencode"; agent: SkillAgent } | null {
  const byProvider: Record<string, "claude" | "codex" | "pi" | "opencode"> = {
    claude: "claude",
    codex: "codex",
    pi: "pi",
    opencode: "opencode",
  };
  const key = byProvider[provider];
  return key === undefined ? null : (SKILL_COLUMNS.find((column) => column.key === key) ?? null);
}

/** What Setup says after `setup.ensure-roles` answered. */
export type EnsureRolesLine =
  | { tone: "success"; text: string; dismissable: true; button: null }
  | { tone: "warning"; text: string; dismissable: false; button: "Set up again" }
  | { tone: "danger"; text: string; dismissable: false; button: "Try again" };

export function ensureRolesLine(
  result: {
    created: readonly string[];
    baseProvider: string | null;
    model: string | null;
    reviewer?: ReviewerApart;
    skipped: "cleaned-up" | null;
  } | null,
  error?: unknown,
): EnsureRolesLine | null {
  if (error !== undefined && error !== null) {
    return { tone: "danger", text: errorMessageOf(error), dismissable: false, button: "Try again" };
  }
  if (result === null) return null;
  if (result.skipped === "cleaned-up") {
    return {
      tone: "warning",
      text: "paseo-bm's settings were removed. Remove the plugin with `paseo plugin remove paseo-bm`, or set it up again.",
      dismissable: false,
      button: "Set up again",
    };
  }
  // Names only the roles created: a machine updated from 0.4.x gets just the Orchestrator.
  const text = rolesCreatedSentence(result, "Agents");
  if (text === null) return null;
  return { tone: "success", text, dismissable: true, button: null };
}

export const AGENT_TOOLS_DIALOG: ConfirmDialog = {
  title: "Allow Paseo's agent tools for every agent?",
  body:
    "The Manager and the Worker need Paseo's agent tools to create and message other agents. " +
    "Paseo has one switch for this (daemon.mcp.injectIntoAgents), and it applies to every agent on this machine, " +
    "not only paseo-bm's: any agent can then create, message and stop other agents. " +
    'paseo-bm records the current value so "Remove paseo-bm\'s settings" can turn it back off.',
  confirmLabel: "Allow for every agent",
  cancelLabel: "Cancel",
  defaultAction: "cancel",
};

export function skillsDialog(installCommand: string): ConfirmDialog {
  return {
    title: "Run the third-party skills CLI?",
    body:
      `${installCommand}\n\n` +
      "This downloads the skills from github.com/cuongntr/agent-skills (another author) with the `skills` CLI, " +
      "a third-party tool with its own data collection. paseo-bm never writes to your skills folders itself. " +
      "It can take up to 5 minutes.",
    confirmLabel: "Run it",
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

// ---------------------------------------------------------------------------
// The state of each setup item, shown where the user manages it (0.4.0).
// ---------------------------------------------------------------------------

/** One line about the roles the plugin created, or `null` when it created none. */
export function rolesCreatedLine(status: SetupStatus): string | null {
  const created = status.setup?.roles.created;
  if (created === undefined || created === null) return null;
  const date = new Date(created.at);
  const when = Number.isNaN(date.getTime()) ? created.at : date.toLocaleDateString();
  return `Created by paseo-bm on ${when} with defaults (${rolesDefaultsText(created.baseProvider, created.model, created.reviewer)}). Change them here.`;
}

export interface AgentToolsBlock {
  text: string;
  tone: "muted" | "warning";
  /** The button label, or `null` when there is nothing to press. */
  button: "Allow agent tools…" | null;
}

/** What the Agents tab says about Paseo's machine-wide switch. */
export function agentToolsBlock(status: SetupStatus): AgentToolsBlock | null {
  const agentTools = status.setup?.agentTools;
  if (agentTools === undefined) return null;
  if (agentTools.injectIntoAgents === null) {
    return { text: "Unknown — Paseo's configuration could not be read.", tone: "warning", button: null };
  }
  if (agentTools.injectIntoAgents) {
    return {
      text: agentTools.setBy === null ? "On for every agent" : "On for every agent, turned on by paseo-bm",
      tone: "muted",
      button: null,
    };
  }
  return { text: "Off — no new Beads Manager starts until you allow them", tone: "warning", button: "Allow agent tools…" };
}

export interface SignInRow {
  provider: string;
  /** "used by Manager, Worker". */
  usedBy: string;
  text: string;
  tone: "muted" | "warning";
  /** Shown with a Copy button; `null` when there is no command to run. */
  command: string | null;
}

/** `"manager"` → `"Manager"`, from the one list that names the roles. */
const roleLabel = (role: string): string => SETUP_ROLES.find((entry) => entry.role === role)?.label ?? role;

/**
 * One row per provider the roles run on.
 *
 * paseo-bm never runs a login command: the row shows what the provider's own
 * tool documents and the user runs it themselves (design §9).
 */
export function signInRows(status: SetupStatus): SignInRow[] {
  return (status.setup?.logins ?? []).map((login) => {
    const usedBy = `used by ${login.roles.map(roleLabel).join(", ")}`;
    if (login.state === "logged-in") {
      return { provider: login.provider, usedBy, text: "Signed in", tone: "muted", command: null };
    }
    if (login.state === "unknown") {
      return { provider: login.provider, usedBy, text: "Unknown", tone: "muted", command: null };
    }
    return {
      provider: login.provider,
      usedBy,
      text: login.loginCommand === null ? (login.guidance ?? "Not signed in") : `Not signed in — sign in with \`${login.loginCommand}\``,
      tone: "warning",
      command: login.loginCommand,
    };
  });
}

/** When the skills CLI last ran, or `null` when it never has here. */
export function skillsRunLine(status: SetupStatus, now: Date): string | null {
  const run = status.setup?.skillsRun;
  if (run === undefined || run === null) return null;
  const at = new Date(run.at);
  return `Last run: ${Number.isNaN(at.getTime()) ? run.at : localTimeText(at, now)} · exit ${run.code}`;
}

/** The label above the skills command, now that Setup can run it. */
export const SKILLS_COMMAND_LABEL = "Install the required skills for Claude Code and Codex: press Install skills, or run it yourself";

/** True when some agent is still missing a required skill, whichever it is. */
export function anySkillMissing(status: SetupStatus): boolean {
  return SKILL_COLUMNS.some((column) => (status.skills.missingRequired[column.key] ?? 0) > 0);
}

export interface DataHomeLines {
  text: string;
  tone: "muted" | "danger";
}

/** The two lines of the "This install" block that talk about the data folder. */
export const PLUGIN_DIAGNOSTICS_LINE =
  "If paseo-bm does not load at all, check `paseo plugin ls` and `paseo plugin logs paseo-bm`.";

export function dataHomeLine(status: SetupStatus): DataHomeLines | null {
  const dataHome = status.setup?.dataHome;
  if (dataHome === undefined) return null;
  if (dataHome.path === null) {
    return { text: `paseo-bm cannot use its data folder: ${dataHome.reason ?? "no reason given"}`, tone: "danger" };
  }
  const source =
    dataHome.source === "env"
      ? "set by PASEO_BM_HOME"
      : dataHome.source === "pointer"
        ? "from ~/.paseo-bm/home.json"
        : "default";
  return { text: `Data folder: \`${dataHome.path}\` (${source})`, tone: "muted" };
}

// ---------------------------------------------------------------------------
// "Remove paseo-bm's settings" (0.4.0, design §7.13.7; ADR-012 decision 6).
// ---------------------------------------------------------------------------

export const CLEANUP_BUTTON_LABEL = "Remove paseo-bm's settings…";
export const CLEANUP_BUTTON_ACCESSIBILITY_LABEL = "Remove paseo-bm's roles and settings from Paseo";
export const CLEANUP_NEXT_COMMAND = "paseo plugin remove paseo-bm";

/**
 * The first of two confirmations: what the button takes away.
 *
 * It names the agents that will break, because that is the consequence a user
 * cannot see from the screen and cannot undo afterwards — the configuration
 * itself is one press away from being recreated.
 */
export function cleanupWarning(status: SetupStatus): string {
  const agentTools = status.setup?.agentTools;
  const alsoSwitch =
    agentTools !== undefined && agentTools.injectIntoAgents === true && agentTools.setBy !== null
      ? ", and turns Paseo's agent tools back off (paseo-bm turned them on)"
      : "";
  return (
    `This removes every bm-* provider and agent profile from Paseo (the four roles and their fallbacks)${alsoSwitch}. ` +
    "Agents already running on these roles will fail on their next turn: archive them first. Skills, br and bv stay."
  );
}

/** The second confirmation: the data, which is kept unless the user says otherwise. */
export function cleanupDataQuestion(status: SetupStatus): string {
  const path = status.setup?.dataHome.path ?? "the paseo-bm data folder";
  return (
    `Also delete paseo-bm's data in \`${path}\`: history (traces), extra instructions, fallback settings and incidents? ` +
    "One small file stays so the roles are not re-created before you remove the plugin, and files left by the old installer stay."
  );
}

/** The first confirmation as `ConfirmBlock` draws it: the warning in the danger colour, Cancel first. */
export function cleanupWarningDialog(status: SetupStatus): ConfirmDialog {
  return {
    title: null,
    body: cleanupWarning(status),
    bodyTone: "danger",
    confirmLabel: "Remove settings",
    confirmAccessibilityLabel: "Remove settings, then choose what happens to the data",
    cancelLabel: "Cancel",
    cancelAccessibilityLabel: "Cancel: keep paseo-bm's settings",
    defaultAction: "cancel",
  };
}

export const CLEANUP_DATA_DIALOG = { keepLabel: "Keep my data", deleteLabel: "Delete data", defaultAction: "keep" } as const;

/** What `setup.cleanup` is sent, once both questions have an answer. */
export function cleanupInput(deleteData: boolean): { confirmed: true; deleteData: boolean } {
  return { confirmed: true, deleteData };
}

export interface CleanupReport {
  lines: string[];
  nextCommand: string;
}

/** What the screen shows once the cleanup has run. */
export function cleanupReport(result: {
  removedProviders: readonly string[];
  removedProfiles: readonly string[];
  agentTools: "restored" | "left-on" | "off";
  data: { deleted: readonly string[]; kept: readonly string[] } | null;
}): CleanupReport {
  const lines: string[] = [
    `Removed ${result.removedProviders.length} provider${result.removedProviders.length === 1 ? "" : "s"} and ${result.removedProfiles.length} agent profile${result.removedProfiles.length === 1 ? "" : "s"}.`,
  ];
  if (result.agentTools === "restored") lines.push("Paseo's agent tools are back to what they were before paseo-bm.");
  if (result.agentTools === "left-on") lines.push("Paseo's agent tools are left on — they were not turned on by paseo-bm.");
  if (result.agentTools === "off") lines.push("Paseo's agent tools were already off.");
  if (result.data !== null) {
    lines.push(result.data.deleted.length === 0 ? "No data files were deleted." : `Deleted: ${result.data.deleted.join(", ")}`);
    if (result.data.kept.length > 0) lines.push(`Kept: ${result.data.kept.join(", ")}`);
  } else {
    lines.push("Your data was kept.");
  }
  return { lines, nextCommand: CLEANUP_NEXT_COMMAND };
}
