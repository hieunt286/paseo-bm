import { describe, expect, it } from "vitest";
import type { SetupStatus, SkillUsage } from "../plugin/shared/contracts";
import { toolFacesFor } from "../plugin/shared/bm-tools";
import { GROUP_LOADING } from "../plugin/client/settings-model";
import {
  SKILLS_USAGE_QUERY_KEY,
  SKILLS_USED_MEANING,
  agentToolsRows,
  orchestratorToolsText,
  skillRowsView,
  toolsGroupState,
} from "../plugin/client/tools-screen-model";
import { allNodes, pressables, renderTree, texts } from "./helpers/element-tree";

/**
 * Tools & skills (change-014 outcome 5): the skills with their install state
 * and use counts, the agent tools by role, and the section's one line. The
 * model is pure and tested here; the hook-free tables of `tools-screen.tsx`
 * are expanded with the element-tree helper, `react-native` and the SDK being
 * named stand-ins.
 */

// The root tsconfig has no `jsx`, so the .tsx module loads through a non-literal specifier.
const screenPath = "../plugin/client/tools-screen.tsx";
type Component = (props: Record<string, unknown>) => unknown;
const { SkillsTable, AgentToolsTable, ToolsScreen } = (await import(screenPath)) as {
  SkillsTable: Component;
  AgentToolsTable: Component;
  ToolsScreen: Component;
};

const styles = new Proxy({}, { get: (_target, key) => ({ name: String(key) }) });
const theme = { colors: new Proxy({}, { get: (_target, key) => `#${String(key)}` }) };

const skillRow = (name: string, ok: boolean, required = true) => ({
  name,
  required,
  claude: ok ? ("ok" as const) : ("missing" as const),
  codex: ok ? ("ok" as const) : ("missing" as const),
  problem: null as string | null,
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
      missingRequired: { claude: 0, codex: 0 },
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

const usage = (name: string, reports: number): SkillUsage => ({ name, reports, requests: reports, lastUsedAt: "2026-09-30T10:00:00.000Z" });

describe("the section's one line", () => {
  it("says br and bv are ready and counts the Worker's skills on its own agent", () => {
    expect(toolsGroupState(undefined)).toEqual(GROUP_LOADING);
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
    expect(toolsGroupState(withSetup({ logins: [] })).text).toBe("br and bv ready · skills: Claude 5/5, Codex 5/5");
  });
});

describe("the skills with their use counts (skills.usage, 30 days, every project)", () => {
  it("reads 30 days of every project, under its own key, and says what Used counts", () => {
    expect(SKILLS_USAGE_QUERY_KEY).toEqual(["paseo-bm", "tools", "skills-usage", 30]);
    expect(SKILLS_USED_MEANING).toBe("Used: how many Worker reports named the skill in the last 30 days, in every project.");
  });

  it("gives each checked skill its install state per agent and its report count, — for none and … while loading", () => {
    const base = readyStatus();
    const status = readyStatus({
      skills: { ...base.skills, skills: [skillRow("feature-workflow", true), { ...skillRow("reviewing-plan", false, false), problem: "SKILL.md unreadable" }] },
    });
    const rows = skillRowsView(status, [usage("feature-workflow", 247)]);
    expect(rows.map((row) => [row.name, row.note, row.chips.map((chip) => chip.text), row.used, row.problem])).toEqual([
      ["feature-workflow", null, ["Claude ✓", "Codex ✓"], "247", null],
      ["reviewing-plan", "(optional)", ["Claude missing", "Codex missing"], "—", "SKILL.md unreadable"],
    ]);
    expect(rows[0]!.accessibilityLabel).toBe("feature-workflow: Claude ✓, Codex ✓; used in 247 reports in the last 30 days");
    expect(rows[1]!.accessibilityLabel).toBe("reviewing-plan: Claude missing, Codex missing; not used in the last 30 days");
    expect(skillRowsView(status, null).map((row) => row.used)).toEqual(["…", "…"]);
  });

  it("adds the skills the reports named that paseo-bm does not check, after the checked ones", () => {
    const rows = skillRowsView(readyStatus(), [usage("simplify", 8), usage("feature-workflow", 3), usage("unused", 0)]);
    expect(rows.map((row) => row.name)).toEqual(["feature-workflow", "reviewing-plan", "converting-plan-to-beads", "polishing-beads", "implementing-beads", "simplify"]);
    expect(rows.at(-1)).toMatchObject({ note: "not checked by paseo-bm", chips: [], used: "8" });
  });

  it("is a table: Skill and Used headings, each row's name, count, chips and problem (hook-free)", () => {
    const base = readyStatus();
    const status = readyStatus({ skills: { ...base.skills, skills: [{ ...skillRow("feature-workflow", true), problem: "broken link" }] } });
    const nodes = renderTree(SkillsTable({ rows: skillRowsView(status, [usage("feature-workflow", 2)]), styles, theme }));
    expect(texts(nodes)).toEqual(["Skill", "Used", "feature-workflow", "2", "Claude ✓", "Codex ✓", "broken link"]);
    const problem = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0] === "broken link")!;
    expect(JSON.stringify(problem.props.style)).toContain("#statusDanger");
    expect(pressables(nodes)).toHaveLength(0);
  });
});

describe("the agent tools by role", () => {
  it("names what Paseo's tools let each role do and paseo-bm's own tools, the Orchestrator's counted", () => {
    const rows = agentToolsRows(readyStatus());
    expect(rows.map((row) => [row.role, row.paseo.text, row.paseo.tone])).toEqual([
      ["Manager", "create, message, cancel agents", "muted"],
      ["Worker", "create Reviewers, message, cancel", "muted"],
      ["Reviewer", "none", "muted"],
      ["Orchestrator", "none", "muted"],
    ]);
    expect(rows.map((row) => row.bm)).toEqual([
      toolFacesFor("manager").map((face) => face.name).join(" · "),
      toolFacesFor("worker").map((face) => face.name).join(" · "),
      toolFacesFor("reviewer").map((face) => face.name).join(" · "),
      orchestratorToolsText(),
    ]);
    expect(rows[0]!.bm).toContain("bm_answers");
    expect(rows[1]!.bm).toContain("bm_report");
    expect(rows[2]!.bm).toBe("bm_review");
    expect(orchestratorToolsText()).toBe(`${toolFacesFor("orchestrator").length} tools · read, command, decide, compact, handoff`);
  });

  it("warns when Paseo's tools are off for every agent, unknown, or the last Manager or Worker had none", () => {
    const off = agentToolsRows(withSetup({ agentTools: { injectIntoAgents: false, setBy: null } }));
    expect(off.slice(0, 2).map((row) => row.paseo)).toEqual([
      { text: "create, message, cancel agents · off for every agent", tone: "warning" },
      { text: "create Reviewers, message, cancel · off for every agent", tone: "warning" },
    ]);
    expect(agentToolsRows(withSetup({ agentTools: { injectIntoAgents: null, setBy: null } }))[0]!.paseo.text).toBe("create, message, cancel agents · unknown");
    const missing = agentToolsRows(
      readyStatus({ paseoTools: { manager: null, worker: { state: "missing", agentId: "a1", provider: "pi", at: "2026-09-29T00:00:00Z" } } }),
    );
    expect(missing[1]!.paseo).toEqual({ text: "create Reviewers, message, cancel · the last Worker (pi) had none", tone: "warning" });
    expect(missing[0]!.paseo.tone).toBe("muted");
  });

  it("is one block per role with both columns, the Paseo tools in their tone (hook-free)", () => {
    const rows = agentToolsRows(withSetup({ agentTools: { injectIntoAgents: false, setBy: null } }));
    const nodes = renderTree(AgentToolsTable({ rows, styles, theme }));
    expect(texts(nodes).slice(0, 5)).toEqual(["Manager", "Paseo tools", "create, message, cancel agents · off for every agent", "paseo-bm tools", rows[0]!.bm]);
    const warned = allNodes(nodes).find((node) => node.type === "Text" && texts([node])[0] === rows[0]!.paseo.text)!;
    expect(JSON.stringify(warned.props.style)).toContain("#statusWarning");
    const blocks = allNodes(nodes).filter((node) => node.type === "View" && typeof node.props.accessibilityLabel === "string");
    expect(blocks.map((block) => String(block.props.accessibilityLabel).split(":")[0])).toEqual(["Manager", "Worker", "Reviewer", "Orchestrator"]);
  });
});

describe("ToolsScreen", () => {
  it("is exported to be wired into the surface", () => {
    expect(typeof ToolsScreen).toBe("function");
  });
});
