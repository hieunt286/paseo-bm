/**
 * What the Tools & skills section says (change-014 outcome 5; experience
 * concept §4.4): the agent skills with their install state per agent and how
 * often recorded reports named them (`skills.usage`), the agent tools by
 * role, and the command-line tools `br` and `bv`.
 *
 * The skills' install state and the tools come from `setup.status`, as
 * Settings read them before Tools & skills became a section of its own; the
 * agent tools by role come from `shared/bm-tools.ts` (paseo-bm's own tools)
 * and `setup.status` (whether the last Manager and Worker got Paseo's).
 *
 * Pure: no React, no React Native, no `server/` import.
 */
import { toolFacesFor, type ToolRole } from "../shared/bm-tools";
import type { SetupStatus, SkillUsage } from "../shared/contracts";
import { GROUP_LOADING, type GroupState } from "./settings-model";
import { SKILL_COLUMNS, skillAgentOfProvider, skillChips, toolBadge } from "./settings-machine-model";
import type { Badge, Tone } from "./tone";

/** How far back the Used column counts, in days, over every project. */
export const SKILLS_USAGE_DAYS = 30;

/** `skills.usage` over the last 30 days, all projects. */
export const SKILLS_USAGE_QUERY_KEY = ["paseo-bm", "tools", "skills-usage", SKILLS_USAGE_DAYS] as const;

/** What the Used column counts, in one line under the Skills title. */
export const SKILLS_USED_MEANING = `Used: how many Worker reports named the skill in the last ${SKILLS_USAGE_DAYS} days, in every project.`;

/** Where each agent's skills are installed, then what Used counts: the line beside the Skills title (the approved mockup). */
export function skillsHeaderText(dirs: SetupStatus["skills"]["dirs"]): string {
  // The agents only, as the mockup's one short line; each skill's row says where it is missing.
  const agents = ["Claude", "Codex", ...(dirs.pi === undefined ? [] : ["Pi"]), ...(dirs.opencode === undefined ? [] : ["OpenCode"])];
  return `installed for ${agents.join(", ")} · used = reports that name it, last ${SKILLS_USAGE_DAYS} days`;
}

/** The tools that are the Beads tools of this section. */
export const BEADS_TOOL_IDS: ReadonlySet<string> = new Set(["br", "bv"]);

/**
 * The section's one line: `br` / `bv` missing or out of date, and the
 * required skills of the agent the Worker runs on (the one that uses them).
 */
export function toolsGroupState(status: SetupStatus | undefined): GroupState {
  if (status === undefined) return GROUP_LOADING;
  const problems: Badge[] = [];
  const beadsTools = status.tools.filter((tool) => BEADS_TOOL_IDS.has(tool.id));
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
  if (problems.length === 0) return { text: [toolsText, skillsText].filter((part) => part !== null).join(" · "), tone: "success" };
  const rank = { danger: 3, warning: 2, info: 1, success: 0, muted: 0, plain: 0 } as const;
  const sorted = [...problems].sort((a, b) => rank[b.tone] - rank[a.tone]);
  return { text: sorted.map((problem) => problem.text).join(" · "), tone: sorted[0]!.tone };
}

/** One skill row: its name, its install state per agent, how often it was used, and its problem. */
export interface SkillRowView {
  name: string;
  /** The muted line under the name: the install state per agent ("Claude ✓ · Codex ✓"), "optional" first for a skill paseo-bm does not require. */
  summary: string;
  /** The tone of the worst install state, so a missing or broken skill shows in its colour. */
  summaryTone: Tone;
  /** Who uses it: the Worker, whose reports Used counts and whose skills paseo-bm checks. */
  usedBy: string;
  /** "(optional)" for a skill paseo-bm does not require; "not checked by paseo-bm" for one only the reports name. */
  note: string | null;
  chips: Badge[];
  /** The report count, "—" for none, "…" while `skills.usage` has not answered. */
  used: string;
  problem: string | null;
  accessibilityLabel: string;
}

const TONE_RANK: Readonly<Record<Tone, number>> = { danger: 3, warning: 2, info: 1, success: 0, muted: 0, plain: 0 };

/** The worst tone of the chips: danger or warning when a state is wrong, else muted. */
function worstTone(chips: readonly Badge[]): Tone {
  const worst = [...chips].sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone])[0];
  return worst !== undefined && TONE_RANK[worst.tone] >= 2 ? worst.tone : "muted";
}

/** One command-line tool's row: name, what it is with its version, and its state on the right. */
export interface ToolRowView {
  name: string;
  description: string;
  /** "installed" (accent), an update (warning) or missing (danger). */
  state: { text: string; kind: "installed" | "update" | "missing" };
}

export function toolRowView(tool: SetupStatus["tools"][number]): ToolRowView {
  const badge = toolBadge(tool);
  const description = [tool.purpose || null, tool.version].filter((part) => part !== null && part !== "").join(" · ");
  if (tool.path === null) return { name: tool.name, description, state: { text: tool.required ? "missing" : "not installed", kind: "missing" } };
  if (badge.tone === "warning") return { name: tool.name, description, state: { text: `${tool.latestKnown} available`, kind: "update" } };
  return { name: tool.name, description, state: { text: "installed", kind: "installed" } };
}

function usedText(reports: number | undefined, usage: readonly SkillUsage[] | null): string {
  if (usage === null) return "…";
  return reports === undefined || reports === 0 ? "—" : String(reports);
}

function usedSpoken(used: string): string {
  if (used === "…") return "use count loading";
  if (used === "—") return `not used in the last ${SKILLS_USAGE_DAYS} days`;
  return `used in ${used} report${used === "1" ? "" : "s"} in the last ${SKILLS_USAGE_DAYS} days`;
}

/**
 * The skill rows: every skill `setup.status` checks, in its order, then each
 * skill the reports named that it does not check, most used first.
 * `usage` is null while `skills.usage` has not answered (or failed).
 */
export function skillRowsView(status: SetupStatus, usage: readonly SkillUsage[] | null): SkillRowView[] {
  const reportsOf = new Map((usage ?? []).map((entry) => [entry.name, entry.reports]));
  const checked = status.skills.skills.map((skill): SkillRowView => {
    const chips = skillChips(skill);
    const used = usedText(reportsOf.get(skill.name), usage);
    return {
      name: skill.name,
      summary: [...(skill.required ? [] : ["optional"]), ...chips.map((chip) => chip.text)].join(" · "),
      summaryTone: worstTone(chips),
      usedBy: "Worker",
      note: skill.required ? null : "(optional)",
      chips,
      used,
      problem: skill.problem,
      accessibilityLabel: `${skill.name}: ${chips.map((chip) => chip.text).join(", ")}; ${usedSpoken(used)}`,
    };
  });
  const known = new Set(status.skills.skills.map((skill) => skill.name));
  const reported = (usage ?? [])
    .filter((entry) => !known.has(entry.name) && entry.reports > 0)
    .map((entry): SkillRowView => {
      const used = String(entry.reports);
      return {
        name: entry.name,
        summary: "not checked by paseo-bm",
        summaryTone: "muted",
        usedBy: "Worker",
        note: "not checked by paseo-bm",
        chips: [],
        used,
        problem: null,
        accessibilityLabel: `${entry.name}: not checked by paseo-bm; ${usedSpoken(used)}`,
      };
    });
  return [...checked, ...reported];
}

/** One role of the agent tools: what Paseo's tools let it do (and whether it has them), and paseo-bm's tools it gets. */
export interface AgentToolsRowView {
  role: string;
  paseo: Badge;
  bm: string;
}

const ROLE_ROWS: ReadonlyArray<{ role: ToolRole; label: string; paseo: string | null }> = [
  { role: "manager", label: "Manager", paseo: "create, message, cancel agents" },
  { role: "worker", label: "Worker", paseo: "create Reviewers, message, cancel" },
  { role: "reviewer", label: "Reviewer", paseo: null },
  { role: "orchestrator", label: "Orchestrator", paseo: null },
];

/** The Orchestrator's tools in short: how many, and what they are for. */
export function orchestratorToolsText(): string {
  return `${toolFacesFor("orchestrator").length} tools · read, command, decide, compact, handoff`;
}

/**
 * The agent tools by role: Manager and Worker get Paseo's agent tools (off
 * for every agent while Paseo's switch is off; a warning when the last one
 * had none), the Reviewer and the Orchestrator none; then paseo-bm's own
 * tools per role, the Orchestrator's counted.
 */
export function agentToolsRows(status: SetupStatus): AgentToolsRowView[] {
  const inject = status.setup?.agentTools.injectIntoAgents;
  return ROLE_ROWS.map(({ role, label, paseo }) => {
    const bm = role === "orchestrator" ? orchestratorToolsText() : toolFacesFor(role).map((face) => face.name).join(" · ") || "none";
    if (paseo === null) return { role: label, paseo: { text: "none", tone: "muted" }, bm };
    const seen = role === "manager" || role === "worker" ? status.paseoTools?.[role] : undefined;
    if (inject === false) return { role: label, paseo: { text: `${paseo} · off for every agent`, tone: "warning" }, bm };
    if (seen?.state === "missing") return { role: label, paseo: { text: `${paseo} · the last ${label} (${seen.provider}) had none`, tone: "warning" }, bm };
    if (inject === null) return { role: label, paseo: { text: `${paseo} · unknown`, tone: "warning" }, bm };
    return { role: label, paseo: { text: paseo, tone: "muted" }, bm };
  });
}
