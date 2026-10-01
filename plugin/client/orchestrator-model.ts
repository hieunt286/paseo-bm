/**
 * What the client says about the Orchestrator and a project's progress:
 *
 * - the Orchestrator line at the top of the Inbox (autonomy design §A.12):
 *   the agent's state, the way to its chat — started through a dialog the
 *   first time, restarted when it lost its tools or its instructions are
 *   outdated (Orchestrator design §3.3, §5.1) — and the note that a new one
 *   replaced the old;
 * - the stage bar and the M W R letters that Work's project rows use
 *   (design §6B.7); their times are written by `format.ts`.
 *
 * The owner talks to the Orchestrator in its chat and decides in the Inbox;
 * nothing here sends it anything.
 *
 * Short and general, by the owner's rule: titles instead of ids, relative
 * times. Pure: no React, no React Native, no `server/` import.
 */
import type { OrchestratorOpenPreviewOutput, OrchestratorProjectRow, OrchestratorStateOutput, ProjectStage } from "../shared/contracts";
import type { Tone } from "./tone";
import type { ConfirmDialog } from "./ui-types";
import { ago, spanSince } from "./format";

// ---------------------------------------------------------------------------
// Fixed wording (design §9).
// ---------------------------------------------------------------------------

/** `state.toolsStale`: the agent was created before the plugin's endpoint secret changed (design §5.1). */
export const TOOLS_STALE_TEXT = "The Orchestrator was started before paseo-bm restarted and has lost its tools.";
/** `state.outdated`: it was created with other role instructions than this plugin's (design §3.3). */
export const OUTDATED_TEXT = "The Orchestrator runs on older instructions than this paseo-bm.";
export const RECREATE_LABEL = "Start a new Orchestrator";

/** The line's button once the Orchestrator exists: its chat. */
export const OPEN_CHAT_LABEL = "Orchestrator chat";
/** The line's button before it exists, and the Open dialog's confirm. */
export const START_LABEL = "Start the Orchestrator";
export const OPEN_LABEL = "Open Orchestrator";

/** The cost sentence of the Open dialog, verbatim from design §9. */
export const OPEN_COST_TEXT = "Reads the work of every paseo-bm project on this machine; uses tokens.";

/** Said when the host cannot open an agent from a plugin (no `navigation.openAgent`). */
export const OPEN_IN_APP_TEXT = "The Orchestrator is ready. Open Beads Orchestrator from your agent list.";

// ---------------------------------------------------------------------------
// The Orchestrator line.
// ---------------------------------------------------------------------------

export type OrchestratorAgentState = "running" | "idle" | "not open";

export function agentStateOf(agent: OrchestratorStateOutput["agent"]): OrchestratorAgentState {
  if (agent === null) return "not open";
  return agent.status === "running" ? "running" : "idle";
}

export function headerTitle(agent: OrchestratorStateOutput["agent"]): string {
  return `Beads Orchestrator — ${agentStateOf(agent)}`;
}

/** How long a new Orchestrator is announced as new (design §9). */
export const REPLACED_NOTICE_MS = 24 * 3_600_000;

/**
 * `New Orchestrator since 2 h ago — the old chat is no longer used.`, shown
 * while the Orchestrator is younger than 24 hours and an older one is still in
 * the owner's agent list (it replaced one, design §3.3); else null. The chat
 * button always opens the newest.
 */
export function replacedLine(state: Pick<OrchestratorStateOutput, "agent" | "previousCount">, now: Date): string | null {
  const createdAt = state.agent?.createdAt ?? null;
  if (createdAt === null || (state.previousCount ?? 0) === 0) return null;
  const time = Date.parse(createdAt);
  if (Number.isNaN(time) || now.getTime() - time >= REPLACED_NOTICE_MS) return null;
  return `New Orchestrator since ${ago(createdAt, now)} — the old chat is no longer used.`;
}

/** `<provider> · <model>`, the model named "provider default" when the profile sets none. */
export function previewModelLine(preview: Pick<OrchestratorOpenPreviewOutput, "provider" | "model">): string {
  return `${preview.provider} · ${preview.model ?? "provider default"}`;
}

/** Starting the Orchestrator, when there is none yet (REQ-075 a). Cancel is the default. */
export function openDialog(preview: OrchestratorOpenPreviewOutput): ConfirmDialog {
  return {
    title: preview.exists ? "Open the Beads Orchestrator?" : "Start the Beads Orchestrator?",
    body: `${previewModelLine(preview)}\n\n${OPEN_COST_TEXT}`,
    confirmLabel: OPEN_LABEL,
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** Starting a new Orchestrator when the old one lost its tools or is outdated (design §3.3, §5.1). Cancel is the default. */
export function recreateDialog(preview: OrchestratorOpenPreviewOutput): ConfirmDialog {
  return {
    title: "Start a new Beads Orchestrator?",
    body:
      `${previewModelLine(preview)}\n\n${OPEN_COST_TEXT} ` +
      "The old one stays in your agent list; archive it yourself when you no longer need it.",
    confirmLabel: RECREATE_LABEL,
    cancelLabel: "Cancel",
    defaultAction: "cancel",
  };
}

/** What the Orchestrator line at the top of the Inbox shows, and what its button does. */
export interface OrchestratorLineView {
  /** `Beads Orchestrator — idle`. */
  title: string;
  /**
   * `open`: opens the agent's chat. `start`: the Open dialog, then a new
   * Orchestrator. `restart`: the recreate dialog, then a new one in place of
   * the one that lost its tools or runs on older instructions.
   */
  action: "open" | "start" | "restart";
  label: string;
  /** The agent to open with `open`; null otherwise. */
  agentId: string | null;
  /** Why it should be restarted, or null. */
  warning: string | null;
  /** `replacedLine`, or null. */
  replaced: string | null;
}

export function orchestratorLineView(
  state: Pick<OrchestratorStateOutput, "agent" | "previousCount" | "toolsStale" | "outdated">,
  now: Date,
): OrchestratorLineView {
  const { agent } = state;
  const title = headerTitle(agent);
  if (agent === null) return { title, action: "start", label: `${START_LABEL}…`, agentId: null, warning: null, replaced: null };
  const warning = state.toolsStale ? TOOLS_STALE_TEXT : state.outdated ? OUTDATED_TEXT : null;
  return warning === null
    ? { title, action: "open", label: `${OPEN_CHAT_LABEL} ▸`, agentId: agent.id, warning: null, replaced: replacedLine(state, now) }
    : { title, action: "restart", label: `${RECREATE_LABEL}…`, agentId: agent.id, warning, replaced: replacedLine(state, now) };
}

// ---------------------------------------------------------------------------
// A project's progress (design §6B.7): Work's project rows.
// ---------------------------------------------------------------------------

/** The stage bar's steps, in order. */
export const STAGE_STEPS = ["Received", "Implementing", "Reviewing", "Done"] as const;
const STAGE_INDEX: Partial<Record<ProjectStage, number>> = { received: 0, implementing: 1, reviewing: 2, finished: 3 };

export const WAITING_STAGE_TEXT = "Waiting for you";
export const NO_REQUEST_TEXT = "No request in progress";

export interface StageView {
  /** One per `STAGE_STEPS`: done before the current one, the current one, the rest to come. */
  steps: Array<{ label: string; state: "done" | "current" | "next" }>;
  /** Replaces the steps: `Waiting for you · 17 min`, or `No request in progress`; null when the steps show. */
  text: string | null;
  tone: Tone;
}

/**
 * The stage bar: Received ▸ Implementing ▸ Reviewing ▸ Done with the current
 * stage highlighted; "Waiting for you" (with how long) replaces it when the
 * request is blocked on the owner, "No request in progress" when idle.
 */
export function stageView(
  stage: ProjectStage | undefined,
  waitingSince: string | null,
  now: Date,
): StageView {
  const steps = STAGE_STEPS.map((label) => ({ label, state: "next" as "done" | "current" | "next" }));
  if (stage === "waiting-user") {
    const span = spanSince(waitingSince, now);
    return { steps, text: span === null ? WAITING_STAGE_TEXT : `${WAITING_STAGE_TEXT} · ${span}`, tone: "warning" };
  }
  const index = stage === undefined ? undefined : STAGE_INDEX[stage];
  if (index === undefined) return { steps, text: NO_REQUEST_TEXT, tone: "muted" };
  return {
    steps: steps.map((step, at) => ({ ...step, state: at < index ? "done" : at === index ? "current" : "next" })),
    text: null,
    tone: "info",
  };
}

export interface AgentDot {
  /** `M`, `W` or `R`. */
  letter: "M" | "W" | "R";
  /** Filled: one of them runs. */
  filled: boolean;
  /** There is at least one such agent. */
  present: boolean;
  /** `Manager running`, `2 Workers, 1 running`, `no Reviewer`. */
  label: string;
}

function dotOf(letter: AgentDot["letter"], role: string, agents: ReadonlyArray<{ status: string }>): AgentDot {
  const running = agents.filter((agent) => agent.status === "running").length;
  let label: string;
  if (agents.length === 0) label = `no ${role}`;
  else if (agents.length === 1) label = `${role} ${agents[0]!.status}`;
  else label = `${agents.length} ${role}s, ${running} running`;
  return { letter, filled: running > 0, present: agents.length > 0, label };
}

/** The M W R letters: bright while one of them runs. */
export function agentDots(project: Pick<OrchestratorProjectRow, "agents" | "managerId" | "managerStatus">): AgentDot[] {
  const manager = project.agents?.manager ?? (project.managerId === null ? null : { status: project.managerStatus ?? "idle" });
  return [
    dotOf("M", "Manager", manager === null ? [] : [manager]),
    dotOf("W", "Worker", project.agents?.workers ?? []),
    dotOf("R", "Reviewer", project.agents?.reviewers ?? []),
  ];
}
