import { describe, expect, it } from "vitest";
import { orchestratorOpenPreviewRpc, orchestratorStateRpc, type OrchestratorStateOutput, type ProjectStage } from "../plugin/shared/contracts";
import {
  OPEN_COST_TEXT,
  OUTDATED_TEXT,
  STAGE_STEPS,
  TOOLS_STALE_TEXT,
  agentDots,
  agentStateOf,
  HEADER_START_LABEL,
  headerTitle,
  orchestratorHeaderView,
  watchedProjectCount,
  openDialog,
  orchestratorLineView,
  recreateDialog,
  replacedLine,
  stageView,
} from "../plugin/client/orchestrator-model";

/**
 * What the client says about the Orchestrator (the Inbox's Orchestrator line,
 * autonomy design §A.12) and a project's progress (Work's rows, Orchestrator
 * design §6B.7). Fixtures go through the RPC output schemas, so a wording test
 * never runs on a shape the server cannot send. Pure: no React Native.
 */

const NOW = new Date("2026-09-28T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const EMPTY: OrchestratorStateOutput = orchestratorStateRpc.output.parse({
  agent: null,
  toolsStale: false,
  outdated: false,
  projects: [],
});

function stateOf(overrides: Partial<OrchestratorStateOutput>): OrchestratorStateOutput {
  return orchestratorStateRpc.output.parse({ ...EMPTY, ...overrides });
}

const PROJECT = {
  workspaceId: "wks_a",
  workspaceLabel: "shop",
  managerId: "mgr-a-1234567890",
  managerTitle: "Checkout Manager",
  managerStatus: "idle",
  state: "waiting-user" as const,
  lastActivityAt: minutesAgo(20),
  requests: 3,
  lastAction: null,
};

describe("the Orchestrator line", () => {
  it("says the agent's state: running, idle or not open", () => {
    expect(headerTitle(null)).toBe("Beads Orchestrator — not open");
    expect(agentStateOf({ id: "o", status: "running", workspaceId: null })).toBe("running");
    expect(headerTitle({ id: "o", status: "idle", workspaceId: "w" })).toBe("Beads Orchestrator — idle");
    expect(agentStateOf({ id: "o", status: "error", workspaceId: null })).toBe("idle");
  });

  it("starts an Orchestrator when there is none, behind the Open dialog", () => {
    expect(orchestratorLineView(EMPTY, NOW)).toEqual({
      title: "Beads Orchestrator — not open",
      action: "start",
      label: "Start the Orchestrator…",
      agentId: null,
      warning: null,
      replaced: null,
    });
  });

  it("opens the chat of a current Orchestrator", () => {
    const agent = { id: "o1", status: "running", workspaceId: "w" };
    expect(orchestratorLineView(stateOf({ agent }), NOW)).toEqual({
      title: "Beads Orchestrator — running",
      action: "open",
      label: "Orchestrator chat ▸",
      agentId: "o1",
      warning: null,
      replaced: null,
    });
  });

  it("offers a new Orchestrator, and says why, when the one there lost its tools or is outdated", () => {
    const agent = { id: "o1", status: "idle", workspaceId: "w" };
    expect(orchestratorLineView(stateOf({ agent, toolsStale: true }), NOW)).toMatchObject({
      action: "restart",
      label: "Start a new Orchestrator…",
      agentId: "o1",
      warning: TOOLS_STALE_TEXT,
    });
    expect(orchestratorLineView(stateOf({ agent, outdated: true }), NOW)).toMatchObject({ action: "restart", warning: OUTDATED_TEXT });
    // Lost tools is said first when both hold.
    expect(orchestratorLineView(stateOf({ agent, toolsStale: true, outdated: true }), NOW).warning).toBe(TOOLS_STALE_TEXT);
    // Without an agent, nothing is stale: it is started.
    expect(orchestratorLineView(stateOf({ agent: null, toolsStale: true }), NOW).action).toBe("start");
  });

  it("opens through a dialog naming provider and model, with the cost sentence, Cancel the default", () => {
    const preview = orchestratorOpenPreviewRpc.output.parse({ exists: false, provider: "claude", model: "claude-opus-5-5", workspace: "own" });
    const dialog = openDialog(preview);
    expect(dialog.title).toBe("Start the Beads Orchestrator?");
    expect(dialog.body).toBe(`claude · claude-opus-5-5\n\n${OPEN_COST_TEXT}`);
    expect(OPEN_COST_TEXT).toBe("Reads the work of every paseo-bm project on this machine; uses tokens.");
    expect(dialog.confirmLabel).toBe("Open Orchestrator");
    expect(dialog.defaultAction).toBe("cancel");
    expect(openDialog({ ...preview, model: null }).body).toMatch(/^claude · provider default\n/);
    const again = recreateDialog(preview);
    expect(again.confirmLabel).toBe("Start a new Orchestrator");
    expect(again.body).toContain(OPEN_COST_TEXT);
    expect(again.body).toContain("The old one stays in your agent list");
    expect(again.defaultAction).toBe("cancel");
  });

  it("says a new Orchestrator replaced the old one while it is younger than 24 hours and an older one is still listed", () => {
    const agent = { id: "o2", status: "idle", workspaceId: "w", createdAt: minutesAgo(125) };
    expect(replacedLine({ agent, previousCount: 1 }, NOW)).toBe("New Orchestrator since 2 h 5 min ago — the old chat is no longer used.");
    expect(orchestratorLineView(stateOf({ agent, previousCount: 2 }), NOW).replaced).toBe(
      "New Orchestrator since 2 h 5 min ago — the old chat is no longer used.",
    );
    // No older one left, older than 24 h, no creation time, no agent, or a server without the fields: nothing.
    expect(replacedLine({ agent, previousCount: 0 }, NOW)).toBeNull();
    expect(replacedLine({ agent: { ...agent, createdAt: minutesAgo(24 * 60) }, previousCount: 1 }, NOW)).toBeNull();
    expect(replacedLine({ agent: { ...agent, createdAt: null }, previousCount: 1 }, NOW)).toBeNull();
    expect(replacedLine({ agent: null, previousCount: 1 }, NOW)).toBeNull();
    expect(replacedLine({ agent: { id: "o", status: "idle", workspaceId: null } }, NOW)).toBeNull();
    // The chat button opens the newest Orchestrator: the state's agent.
    expect(orchestratorLineView(stateOf({ agent, previousCount: 1 }), NOW).agentId).toBe("o2");
  });
});

describe("the shell header's Orchestrator status", () => {
  const AGENT = { id: "orc-1", status: "idle", workspaceId: null };

  it("counts the projects above Hands-on as watched, custom included; null before the policy answers", () => {
    expect(watchedProjectCount(undefined)).toBeNull();
    expect(watchedProjectCount({})).toBe(0);
    expect(watchedProjectCount({ a: 0, b: 2, c: "custom", d: 4 })).toBe(3);
  });

  it("says not open with the Start… text button and a muted square", () => {
    expect(orchestratorHeaderView(EMPTY, { a: 2 }, NOW)).toEqual({
      dot: "muted",
      text: "Orchestrator not open",
      action: "start",
      button: HEADER_START_LABEL,
      agentId: null,
      warning: null,
      replaced: null,
    });
    expect(HEADER_START_LABEL).toBe("Start…");
  });

  it("says idle or running with the watched count, the status itself opening the chat", () => {
    const view = orchestratorHeaderView(stateOf({ agent: AGENT }), { a: 2, b: 0, c: 1 }, NOW);
    expect(view).toMatchObject({ dot: "accent", text: "Orchestrator idle · 2 projects watched", action: "open", button: null, agentId: "orc-1" });
    expect(orchestratorHeaderView(stateOf({ agent: { ...AGENT, status: "running" } }), { a: 1 }, NOW).text).toBe(
      "Orchestrator running · 1 project watched",
    );
    expect(orchestratorHeaderView(stateOf({ agent: AGENT }), undefined, NOW).text).toBe("Orchestrator idle");
  });

  it("offers the restart as a text button when the Orchestrator lost its tools", () => {
    const view = orchestratorHeaderView(stateOf({ agent: AGENT, toolsStale: true }), {}, NOW);
    expect(view).toMatchObject({ action: "restart", button: "Start a new Orchestrator…", warning: TOOLS_STALE_TEXT, text: "Orchestrator idle · 0 projects watched" });
  });
});

describe("a project's progress", () => {
  it("maps every stage: the steps up to Done, Waiting for you with how long, or no request", () => {
    const current = (stage: ProjectStage) => stageView(stage, null, NOW).steps.find((step) => step.state === "current")?.label ?? null;
    expect(current("received")).toBe("Received");
    expect(current("implementing")).toBe("Implementing");
    expect(current("reviewing")).toBe("Reviewing");
    expect(current("finished")).toBe("Done");
    expect(stageView("finished", null, NOW).steps.map((step) => step.state)).toEqual(["done", "done", "done", "current"]);
    expect(stageView("implementing", null, NOW)).toMatchObject({ text: null, tone: "info" });
    expect(stageView("waiting-user", minutesAgo(17), NOW)).toMatchObject({ text: "Waiting for you · 17 min", tone: "warning" });
    expect(stageView("waiting-user", null, NOW).text).toBe("Waiting for you");
    expect(stageView("idle", null, NOW)).toMatchObject({ text: "No request in progress", tone: "muted" });
    expect(stageView(undefined, null, NOW).text).toBe("No request in progress");
    expect(STAGE_STEPS).toEqual(["Received", "Implementing", "Reviewing", "Done"]);
  });

  it("draws the M W R letters: bright while one of them runs", () => {
    const project = stateOf({
      projects: [
        {
          ...PROJECT,
          agents: {
            manager: { id: "mgr-a-1234567890", title: "Checkout Manager", status: "idle" },
            workers: [
              { id: "wrk-cart-000001", title: "Cart Worker", status: "running" },
              { id: "wrk-old-000002", title: "Old Worker", status: "idle" },
            ],
            reviewers: [],
          },
        },
      ],
    }).projects[0]!;
    expect(agentDots(project)).toEqual([
      { letter: "M", filled: false, present: true, label: "Manager idle" },
      { letter: "W", filled: true, present: true, label: "2 Workers, 1 running" },
      { letter: "R", filled: false, present: false, label: "no Reviewer" },
    ]);
    // An older server without `agents`: the Manager from the row, nobody else.
    expect(agentDots({ ...project, agents: undefined, managerStatus: "running" }).map((dot) => [dot.letter, dot.filled, dot.present])).toEqual([
      ["M", true, true],
      ["W", false, false],
      ["R", false, false],
    ]);
  });
});
