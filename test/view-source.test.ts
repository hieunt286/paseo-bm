import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What the client views are wired to and how they are laid out, read from
 * their source — every such check in one file (bead 81y2.16, code review
 * 2026-09-30 §7).
 *
 * The repo has no React renderer: test/helpers/element-tree.ts expands only
 * hook-free views, and these ones hold their state in hooks (`useRpc`,
 * `useQuery`, `useState`), so which RPC they call and which piece they draw
 * where is checked on the text. A view that becomes hook-free moves to a
 * render test beside its model; the hook-free pieces these screens draw are
 * rendered there already. Retired names are proven gone in
 * retired-names.test.ts; the structure rules (no color literal, no web-only
 * construct, no native driver) stay beside their files.
 */

const source = (file: string) => readFileSync(fileURLToPath(new URL(`../plugin/client/${file}`, import.meta.url)), "utf8");

describe("launcher.tsx: the Beads Manager surface", () => {
  const launcher = source("launcher.tsx");

  it("builds the status strip once and places it on the main screen, the workspace list and a project's page", () => {
    expect(launcher.match(/<LauncherStatus\b/g)).toHaveLength(1);
    expect(launcher).toMatch(/<SettingsScreen\b.*\bstatus=\{status\}/);
    expect(launcher).toMatch(/<ToolsScreen\b.*\bstatus=\{status\}/);
    // The Projects list and a project's page get it too (work.tsx draws it under their headers).
    expect(launcher).toMatch(/<WorkScreen\b[\s\S]*?\bstatus=\{status\}/);
    expect(launcher).toMatch(/<ProjectPage\b[\s\S]*?\bstatus=\{status\}/);
    // On a project's page inside the surface (F3).
    const start = launcher.indexOf("<ProjectPage");
    expect(start).toBeGreaterThan(0);
    expect(launcher.slice(start, launcher.indexOf("/>", start))).toMatch(/status=\{status\}/);
  });

  it("shows Settings and Tools & skills with the same props — the named projects and the strip —, and no Setup or Insights screen", () => {
    expect(launcher).toMatch(/<SettingsScreen \{\.\.\.props\} projects=\{insightsProjects\(.*\)\} status=\{status\} \/>/);
    expect(launcher).toMatch(/<ToolsScreen \{\.\.\.props\} projects=\{insightsProjects\(.*\)\} status=\{status\} \/>/);
    expect(launcher).not.toMatch(/<SetupScreen\b/);
    // Insights is no section (change-014 outcome 5): its figures are a project's Metrics tab.
    expect(launcher).not.toMatch(/<InsightsScreen\b|"insights"/);
  });

  it("opens a project's page on its Overview, a closed workspace's on Requests, and its Autonomy action on Settings", () => {
    expect(launcher).toMatch(/setView\(closed === undefined \? "project-overview" : "project-requests"\)/);
    const start = launcher.indexOf("<ProjectPage");
    expect(launcher.slice(start, launcher.indexOf("/>", start))).toMatch(/onOpenSettings=\{\(\) => setView\("settings"\)\}/);
  });

  it("renders workspaces.data in the order it arrives (most recent activity first; delta 20260918f §4.5)", () => {
    expect(launcher).toMatch(/sort: \[\{ key: "activity_at", direction: "desc" \}\]/);
    // The project rows are `workspaces.data` mapped one to one; `workRows` keeps that order (plugin-work-model.test.ts).
    expect(launcher).toMatch(/workspaces=\{workspaces\.data\?\.map\(\(workspace\) => \(\{/);
  });

  it("draws each workspace row's running dot from the overview's runningAgents, animated", () => {
    // The Projects list draws each project row through `renderDot` (work.tsx, rendered in plugin-work-model.test.ts), with the dot alone.
    expect(launcher).toMatch(/renderDot=\{\(workspaceId\) => \(\s*<RunningDot\b[^>]*counts=\{overviewById\.get\(workspaceId\)\?\.runningAgents\}[^>]*\bbare\b/);
    expect(launcher).toMatch(/<Animated\.View\b/);
  });

  it("labels the ← of a project's page from backLabelOf, and every ← goes back through one helper (F4, S5)", () => {
    const start = launcher.indexOf("<ProjectPage");
    const element = launcher.slice(start, launcher.indexOf("/>", start));
    expect(element).toMatch(/backLabel=\{backLabelOf\(view\)/);
    expect(element).toMatch(/onBack=\{goBack\}/);
    // The back navigation is written once, inside `goBack`.
    expect(launcher.match(/setView\(backOf\(view\) \?\? SURFACE_HOME_VIEW\)/g)).toHaveLength(1);
    expect(launcher).toMatch(/const goBack = \(\) => setView\(backOf\(view\) \?\? SURFACE_HOME_VIEW\);/);
    // The workspace list is the Projects section's own screen, reached by its tab: no ← of its own.
    expect(launcher.match(/onPress=\{goBack\}/g)).toBeNull();
  });

  it("reads the workspace figures through overviewPolling (F5)", () => {
    const start = launcher.indexOf('queryKey: ["paseo-bm", "launcher", "overview"]');
    expect(start).toBeGreaterThan(0);
    expect(launcher.slice(start, launcher.indexOf("});", start))).toMatch(/\.\.\.overviewPolling\(view\)/);
  });

  it("hands a project's page a closed workspace's state, and offers no chat for it", () => {
    expect(launcher).toMatch(/closed=\{project\.closed\}/);
    expect(launcher).toMatch(/project\.closed !== undefined \? undefined/);
  });
});

describe("settings-section.tsx: the Settings screen", () => {
  const section = source("settings-section.tsx");
  const code = section.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("builds More's groups from the Setup screen's pieces", () => {
    for (const piece of ["<RolesSection", "<AgentToolsBlockView", "<CleanupBlock", "<TraceActions", "signInRows(data)", "<PrecedentsBlock"]) {
      expect(code).toContain(piece);
    }
    // Tools & skills is its own section now (tools-screen.tsx).
    for (const gone of ["<ToolCard", "<SkillsInstallBlock", "SkillsBlock"]) expect(code).not.toContain(gone);
  });

  it("draws Autonomy, then Coordination, then More, in that order (change-014 outcome 5)", () => {
    const at = (needle: string) => code.indexOf(needle);
    expect(at('title="Autonomy"')).toBeGreaterThan(0);
    expect(at('title="Autonomy"')).toBeLessThan(at('title="Coordination"'));
    expect(at('title="Coordination"')).toBeLessThan(at('title="More"'));
    expect(at('title="More"')).toBeLessThan(at("SETTINGS_GROUPS.map("));
  });

  it("shows the Coordination group, saving one key through coordination.set, and resets every draft to the defaults", () => {
    expect(section).toContain("<AdviceCadenceRow");
    expect(section).toMatch(/useRpc\(coordinationSettingsRpc\)/);
    expect(section).toMatch(/save\(\{ key: "advice\.everyFinished", value \}\)/);
    expect(section).toContain("<CoordinationGroup");
    expect(code).toMatch(/const defaults = coordinationDefaultsDraft\(data\.defaults\);\s+setError\(null\);\s+setAdviceDraft\(defaults\.advice\);\s+setThresholds\(defaults\.thresholds\);\s+setReview\(defaults\.review\);/);
  });

  it("draws the Autonomy group from autonomy.policy with the surface's named projects, and counts the precedents from their own query", () => {
    expect(section).toMatch(/useRpc\(autonomyPolicyRpc\)/);
    expect(section).toContain("<AutonomyGroup");
    expect(section).toMatch(/projects=\{projects\}/);
    expect(section).toMatch(/queryKey: PRECEDENTS_QUERY_KEY, queryFn: \(\) => listPrecedents\(\{\}\)/);
    expect(section).toMatch(/precedentsGroupState\(precedents\.data\?\.precedents, precedents\.isError\)/);
  });
});

describe("tools-screen.tsx: the Tools & skills section", () => {
  const screen = source("tools-screen.tsx");

  it("takes exactly Settings' props and reads setup.status through Settings' one query", () => {
    expect(screen).toMatch(/export function ToolsScreen\(\{[^}]*\}: SettingsScreenProps\)/);
    expect(screen).toMatch(/const status = useSetupStatus\(\);/);
  });

  it("reads skills.usage over 30 days of every project, and draws br and bv with the Setup screen's pieces", () => {
    expect(screen).toMatch(/useRpc\(skillsUsageRpc\)/);
    expect(screen).toMatch(/readUsage\(\{ sinceDays: SKILLS_USAGE_DAYS \}\)/);
    expect(screen).not.toMatch(/readUsage\(\{[^}]*workspaceId/);
    for (const piece of ["<ToolCard", "<SkillsInstallBlock", "<SkillsTable", "<AgentToolsTable", "BEADS_TOOL_IDS.has(tool.id)"]) expect(screen).toContain(piece);
  });
});

describe("settings-blocks.tsx and dashboard-actions.tsx: the confirmations", () => {
  it("draws a ConfirmBlock for each grant, and the data question as its own view", () => {
    const blocks = source("settings-blocks.tsx");
    for (const piece of ["dialog={installDialog(tool)}", "dialog={AGENT_TOOLS_DIALOG}", "dialog={skillsDialog(command)}", "cleanupWarningDialog(status)", "<CleanupDataView"]) {
      expect(blocks).toContain(piece);
    }
  });

  it("writes the role fields once, for the role's form and a fallback entry's", () => {
    const blocks = source("settings-blocks.tsx");
    expect(blocks.match(/title="Provider"/g)).toHaveLength(1);
    expect(blocks.match(/<RoleFields \{\.\.\.form\}/g)).toHaveLength(2);
  });

  it("puts No, keep them first in the traces' own confirmation, drawn by TraceActions", () => {
    const actions = source("dashboard-actions.tsx");
    const keep = actions.indexOf("No, keep them");
    expect(keep).toBeGreaterThan(0);
    expect(actions.indexOf('label={busy ? "Working…" : described.confirmLabel}', keep)).toBeGreaterThan(keep);
  });
});

describe("settings-autonomy.tsx and settings-precedents.tsx: the Autonomy group and the precedents", () => {
  const autonomy = source("settings-autonomy.tsx");
  const code = autonomy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("sets a level only through autonomy.set-level: at once, or from its confirmation's own button (ADR-025)", () => {
    expect(autonomy).toMatch(/useRpc\(autonomySetLevelRpc\)/);
    // A press sets at once only when the model says so; Turbo and Full auto only ask.
    expect(code).toMatch(/const press = levelPressOf\(view\.reading, level\);\s+if \(press === "set"\) run\(\(\) => setLevel\(setLevelInputOf\(project\.id, level\)\)\);\s+setConfirmingLevel\(press === "confirm" \? level : null\);/);
    expect(code).toMatch(/onConfirm=\{\(\) => \{\s+const level = confirmingLevel;\s+if \(level === null\) return;\s+run\(async \(\) => \{\s+const saved = await setLevel\(setLevelInputOf\(project\.id, level\)\);/);
    // `confirmed: true` for a level comes from the model (pinned in its test); the only literal one here is the boundary's.
    expect(code.match(/confirmed/g)).toEqual(["confirmed"]);
    // The matrix, the predictor choice, the challenger and Return all to owner are gone.
    for (const gone of ["autonomySetRpc", "autonomyResetRpc", "autonomySetChallengerRpc", "AutonomyMatrix", "PrecedentsBlock"]) expect(code).not.toContain(gone);
  });

  it("holds risky actions through autonomy.set-boundary, after its confirmation in place (change-010 C2, C4)", () => {
    expect(autonomy).toMatch(/useRpc\(autonomySetBoundaryRpc\)/);
    expect(autonomy).toMatch(/setBoundary\(\{ workspaceId: project\.id, enabled, confirmed: true \}\)/);
    // Pressing the switch only asks; the confirmation's own button sends.
    expect(code).toMatch(/onToggle=\{\(\) => \{\s+setError\(null\);\s+setConfirmingLevel\(null\);\s+setConfirmingBoundary\(!view\.boundary\.on\);/);
    expect(autonomy).toMatch(/<ConfirmBlock dialog=\{view\.confirm\}/);
  });

  it("reads and writes the precedents through their RPCs", () => {
    const precedents = source("settings-precedents.tsx");
    for (const call of ["useRpc(precedentsListRpc)", "useRpc(precedentsSaveRpc)", "useRpc(precedentsEndRpc)", "queryKey: PRECEDENTS_QUERY_KEY"]) expect(precedents).toContain(call);
  });
});

describe("chat-card.tsx: the decision card in the chat", () => {
  const card = source("chat-card.tsx");

  it("answers only through decisions.answer and decisions.confirm, as the chat card", () => {
    expect(card).toContain("useRpc(decisionsAnswerRpc)");
    expect(card).toContain("useRpc(decisionsConfirmRpc)");
    expect(card).toContain('via="chat-card"');
    expect(card).not.toMatch(/agents\.ref\([^)]*\)\.send/);
  });

  it("saves a precedent with precedents.save, and reads the project's precedents on the card itself", () => {
    expect(card).toContain("useRpc(precedentsSaveRpc)");
    expect(card).toContain("useRpc(precedentsListRpc)");
  });
});

describe("beads-screen.tsx and chat-beads-panel.tsx: the Beads board and the chat's bead panel", () => {
  const screen = source("beads-screen.tsx");

  it("draws the shared header with the status strip (F3)", () => {
    const start = screen.indexOf("<WorkspaceScreenHeader");
    expect(start).toBeGreaterThan(0);
    expect(screen.slice(start, screen.indexOf("right=", start))).toMatch(/status=\{status\}/);
  });

  it("draws the shared bead row, as the chat's bead panel does", () => {
    expect(screen).toMatch(/<BeadRowCard/);
    expect(source("chat-beads-panel.tsx")).toMatch(/<BeadRowCard/);
  });

  it("is the board first, measuring its own width, with the status tabs and no overview figures", () => {
    expect(screen).toMatch(/<KanbanBoard/);
    expect(screen).toMatch(/<StatusTabs/);
    expect(screen).toMatch(/onLayout=\{\(event\) => setBoardWidth\(event\.nativeEvent\.layout\.width\)\}/);
    // The figures are the Metrics tab's (plugin-work-model.test.ts renders them there).
    expect(screen).not.toMatch(/<StatCards|<BarChart|<BeadsFigures/);
    const body = screen.slice(screen.indexOf("export function BeadsScreen("));
    expect(body.indexOf("<KanbanBoard")).toBeGreaterThan(0);
    expect(body.indexOf("beads`}</Text>")).toBeLessThan(body.indexOf("Filters and sort"));
  });
});

describe("work.tsx: a project's page", () => {
  const work = source("work.tsx");

  it("offers deleting a request's history in its Details, and a closed workspace's history above its requests (autonomy design §A.12)", () => {
    // Per request: the same confirmed flow as before, scoped to the trace.
    expect(work).toMatch(/detailsExtra=\{\s*<TraceActions [^>]*scope="trace" traceId=\{traceId\}/);
    // A closed workspace: delete, or move onto a workspace that exists, behind the same confirmation.
    expect(work).toMatch(/closed === undefined \? null : \(\s*<ClosedHistory workspaceId=\{workspaceId\} state=\{closed\}/);
    expect(work).toMatch(/<TraceActions [^>]*scope="workspace" workspaceState=\{state\}/);
  });

  it("reads each agent's figures with traces.agents in the Agents tab, and draws them in the tree", () => {
    expect(work).toMatch(/readAgents\(\{ workspaceId \}\)/);
    const inTree = work.slice(work.indexOf("<AgentTreeView "), work.indexOf("</AgentTreeView>"));
    expect(inTree).toContain("<TokenFigures state={tokens}");
  });

  it("draws Overview · Requests · Beads · Metrics · Agents, Metrics being the project's insights (change-014 outcome 5)", () => {
    const page = work.slice(work.indexOf("export function ProjectPage("));
    expect(page).toMatch(/tab === "overview" \? \(\s*<OverviewTab\b/);
    expect(page).toMatch(/tab === "metrics" \? \(\s*<ProjectMetrics workspaceId=\{workspaceId\} label=\{label\}/);
    expect(page).toMatch(/onRequests=\{\(\) => setTab\("requests"\)\}/);
  });

  it("reads the Overview from the Requests tab's queries, the Metrics tab's summary and the shared policy query", () => {
    const tab = work.slice(work.indexOf("function OverviewTab("), work.indexOf("function AgentsTab("));
    expect(tab).toMatch(/queryKey: workQueryKeys\.traces\(workspaceId\)/);
    expect(tab).toMatch(/queryKey: workQueryKeys\.decisions\(workspaceId\)/);
    expect(tab).toMatch(/queryKey: insightsQueryKey\(INSIGHTS_DEFAULT_WINDOW, workspaceId\)/);
    expect(tab).toMatch(/queryKey: AUTONOMY_POLICY_KEY/);
    expect(tab).toMatch(/level=\{levelNameOf\(policy\.data\?\.levels, workspaceId\)\}/);
  });

  it("names each project row's autonomy level from autonomy.policy's levels", () => {
    const screen = work.slice(work.indexOf("export function WorkScreen("));
    expect(screen).toMatch(/queryKey: AUTONOMY_POLICY_KEY/);
    expect(screen).toMatch(/levels: policy\.data\.levels/);
  });
});

describe("insights.tsx: a project's Metrics tab", () => {
  const insights = source("insights.tsx");

  it("reads insights.summary for its workspace with the window tabs, and offers no Delegate? (ADR-025)", () => {
    const tab = insights.slice(insights.indexOf("export function ProjectMetrics("));
    expect(tab).toMatch(/queryFn: \(\) => readSummary\(\{ window, workspaceId \}\)/);
    expect(insights).toMatch(/<StatusTabs tabs=\{WINDOW_TABS\}/);
    expect(insights).not.toMatch(/autonomySetRpc|Delegate|<InsightsScreen|export function InsightsScreen/);
  });
});

describe("why.tsx: Work → request → Why? (autonomy design §E.2; change-011 C7)", () => {
  const why = source("why.tsx");
  const work = source("work.tsx");

  it("reads links.why once when it opens and on Refresh, never on Work's poll", () => {
    const screen = why.slice(why.indexOf("export function WhyScreen("));
    expect(screen).toMatch(/useRpc\(linksWhyRpc\)/);
    expect(screen).toMatch(/queryFn: \(\) => readWhy\(\{ workspaceId, requestId \}\),\s*\.\.\.WHY_QUERY_OPTIONS,/);
    expect(screen).toMatch(/onRefresh=\{\(\) => void why\.refetch\(\)\}/);
    // One query, and nothing that polls: no interval, no Work poll constant.
    expect(screen.match(/useQuery\(/g)).toHaveLength(1);
    expect(why).not.toMatch(/refetchInterval|WORK_POLL_MS|setInterval/);
  });

  it("opens from a request card's Why? in place of the list, for a request with an id, and ← returns to it", () => {
    expect(work).toMatch(/const whyOf = \(requestId: string \| null\) => \(requestId === null \? undefined : \(\) => setWhy\(requestId\)\);/);
    expect(work).toMatch(/onWhy=\{whyOf\(summary\.requestId\)\}/);
    expect(work).toMatch(/if \(why !== null\) return <WhyScreen workspaceId=\{workspaceId\} requestId=\{why\} onBack=\{\(\) => setWhy\(null\)\}/);
    expect(work.match(/<WhyScreen\b/g)).toHaveLength(1);
  });
});
