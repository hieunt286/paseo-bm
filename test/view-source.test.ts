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
    expect(launcher).toMatch(/<InsightsScreen\b[^>]*\bstatus=\{status\}/);
    // Work's list and a project's page get it too (work.tsx draws it under their headers).
    expect(launcher).toMatch(/<WorkScreen\b[\s\S]*?\bstatus=\{status\}/);
    expect(launcher).toMatch(/<ProjectPage\b[\s\S]*?\bstatus=\{status\}/);
    // On a project's page inside the surface (F3).
    const start = launcher.indexOf("<ProjectPage");
    expect(start).toBeGreaterThan(0);
    expect(launcher.slice(start, launcher.indexOf("/>", start))).toMatch(/status=\{status\}/);
  });

  it("shows Settings with the named projects and the strip, and no Setup screen", () => {
    expect(launcher).toMatch(/<SettingsScreen \{\.\.\.props\} projects=\{insightsProjects\(.*\)\} status=\{status\} \/>/);
    expect(launcher).not.toMatch(/<SetupScreen\b/);
  });

  it("renders workspaces.data in the order it arrives (most recent activity first; delta 20260918f §4.5)", () => {
    expect(launcher).toMatch(/sort: \[\{ key: "activity_at", direction: "desc" \}\]/);
    // Work's rows are `workspaces.data` mapped one to one; `workRows` keeps that order (plugin-work-model.test.ts).
    expect(launcher).toMatch(/workspaces=\{workspaces\.data\?\.map\(\(workspace\) => \(\{/);
  });

  it("draws each workspace row's running dot from the overview's runningAgents, animated", () => {
    // Work draws each project row through `renderDot` (work.tsx, rendered in plugin-work-model.test.ts), with the dot alone.
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
    // The workspace list is Work's own screen, reached by its tab: no ← of its own.
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

  it("builds each group from the Setup screen's pieces", () => {
    const code = section.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const piece of ["<RolesSection", "<AgentToolsBlockView", "<ToolCard", "<SkillsInstallBlock", "<CleanupBlock", "<TraceActions", "signInRows(data)"]) {
      expect(code).toContain(piece);
    }
  });

  it("shows the Coordination group, saving one key through coordination.set", () => {
    expect(section).toContain("<AdviceCadenceRow");
    expect(section).toMatch(/useRpc\(coordinationSettingsRpc\)/);
    expect(section).toMatch(/save\(\{ key: "advice\.everyFinished", value \}\)/);
  });

  it("draws the Autonomy group from autonomy.policy, the matrix taking the surface's named projects", () => {
    expect(section).toMatch(/useRpc\(autonomyPolicyRpc\)/);
    expect(section).toMatch(/autonomyGroupState\(autonomy\.data\?\.policy, autonomy\.isError\)/);
    expect(section).toContain("<AutonomyGroup");
    expect(section).toMatch(/projects=\{projects\}/);
    // The Coordination group is left as it was.
    expect(section).toContain("<CoordinationGroup");
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

describe("settings-autonomy.tsx and settings-precedents.tsx: the Autonomy group", () => {
  const autonomy = source("settings-autonomy.tsx");

  it("returns every class to owner through autonomy.reset in one press, and sets one cell through autonomy.set", () => {
    expect(autonomy).toMatch(/useRpc\(autonomyResetRpc\)/);
    expect(autonomy).toMatch(/reset\(\{ workspaceId: project\.id \}\)/);
    expect(autonomy).toMatch(/set\(\{ workspaceId: project\.id, class: decisionClass, mode \}\)/);
    // One press: the reset is the safety path, with no confirmation (design §B.9); only the action boundary is confirmed.
    expect(autonomy).toMatch(/onReset=\{\(\) => run\(\(\) => reset\(\{ workspaceId: project\.id \}\)\)\}/);
    expect(autonomy.match(/confirmed/g)).toEqual(["confirmed"]);
  });

  it("turns the action boundary on or off through autonomy.set-boundary, after its confirmation in place (change-010 C2, C4)", () => {
    expect(autonomy).toMatch(/useRpc\(autonomySetBoundaryRpc\)/);
    expect(autonomy).toMatch(/setBoundary\(\{ workspaceId: project\.id, enabled, confirmed: true \}\)/);
    // Pressing a side only asks; the confirmation's own button sends.
    expect(autonomy).toMatch(/onBoundaryAsk=\{\(enabled\) => \{\s+setError\(null\);\s+setConfirmingBoundary\(enabled\);/);
    expect(autonomy).toMatch(/<ConfirmBlock dialog=\{view\.confirm\}/);
  });

  it("switches the Orchestrator's predictions through autonomy.set-challenger", () => {
    expect(autonomy).toMatch(/useRpc\(autonomySetChallengerRpc\)/);
    expect(autonomy).toMatch(/setChallenger\(\{ workspaceId: project\.id, enabled \}\)/);
  });

  it("reads and writes the precedents through their RPCs, under the named projects", () => {
    const precedents = source("settings-precedents.tsx");
    for (const call of ["useRpc(precedentsListRpc)", "useRpc(precedentsSaveRpc)", "useRpc(precedentsEndRpc)", "queryKey: PRECEDENTS_QUERY_KEY"]) expect(precedents).toContain(call);
    expect(autonomy).toMatch(/<PrecedentsBlock projects=\{list\}/);
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
    // The figures are Insights' (plugin-work-model.test.ts renders them there).
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
