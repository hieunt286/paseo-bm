/**
 * The Orchestrator's project tools (Orchestrator design §5.2, §6B.4; autonomy
 * design §A.9; code review 2026-09-30 §4): the three that read, and the notes
 * it keeps of a project.
 *
 * - `bm_projects`, `bm_request`, `bm_agent_messages` (§5.2) only read: the
 *   trace store, `agents.list`, `workspaces.list` and — for
 *   `bm_agent_messages` — that one agent's timeline. `bm_request` builds its
 *   request as `traces.get` does (`readTraceContext`, `traceDetailOf`), which
 *   also reads the request's own Workers' and Reviewers' timelines for skills
 *   and typed messages, as Work's request timeline does (`request-render.ts`
 *   writes it out). Every text handed out is redacted. No rule flag is handed out: the
 *   flags that only served the workflow assessment are retired, and their
 *   figures are the replay's (autonomy design §B.9).
 *   Each returns a bounded summary by default and today's content with
 *   `detail: "full"` (autonomy design §A.9), with a one-line note first
 *   whenever the summary left something out.
 * - `bm_note` (§6B.4) keeps the Orchestrator's notes about a project, which
 *   `bm_projects` returns.
 *
 * Nothing here sends to an agent.
 */
import { basename } from "node:path";
import { joinStreamedText, redactText } from "./collector";
import { readTraceContext, traceDetailOf } from "./dashboard-rpc";
import { bmAgentsOf, listedWorkspaces } from "./paseo-directory";
import type { DataHomeDeps } from "./data-home";
import { readTimelinePages } from "./live-timeline";
import { isPluginOrigin, originOf } from "../shared/message-origin";
import { createAlertStore } from "./alert-store";
import { createDecisionStore } from "./decision-store";
import {
  MESSAGE_PAGES,
  MESSAGE_PAGE_LIMIT,
  json,
  refuse,
  requireProject,
  workingAgentsOf,
  type ServerToolResult,
  type ToolContext,
} from "./orchestrator-tool-context";
import { buildRequestContent, cutText } from "./request-render";
import { firstLine, recentTracesOf, recentWorkspacesOf, requestKeyOf, waitingSinceOf, workspaceTracesOf } from "./request-trace";
import { readWorkspaceMeta } from "./trace-store";
import { AGENT_MESSAGES_LIMIT, AGENT_MESSAGES_SUMMARY, PROJECTS_SINCE_HOURS, REQUEST_SUMMARY_MAX_CHARS, type ReadDetail } from "../shared/bm-tools";
import { UNSETTLED_STATUSES, type Decision } from "../shared/decisions";
import { timeOrZero } from "../shared/time";

/** The most recent requests `bm_projects` lists per project (design §5.2). */
export const PROJECT_REQUEST_LIMIT = 10;
/** The longest message `bm_agent_messages` hands out (design §6A: long enough for a question with all its options). */
export const AGENT_MESSAGE_MAX_CHARS = 12_000;
/** The note `bm_projects` puts first when its summary left requests or notes out (autonomy design §A.9). */
export const PROJECTS_BOUNDED_NOTE =
  'Summary: counts and open decisions only. For each recent request with its stalls, and your notes, call bm_projects with detail: "full".';
/** The note `bm_request` puts first when its summary cut messages (autonomy design §A.9). */
export const REQUEST_BOUNDED_NOTE =
  'Bounded to 4,000 characters: the longest messages are cut, each marked ...[truncated]. For up to 60,000 characters, call bm_request with detail: "full".';
/** The note `bm_agent_messages` puts first when its summary left messages or text out (autonomy design §A.9). */
export function agentMessagesBoundedNote(returned: number, read: number): string {
  return `Bounded: the ${returned} most recent of ${read} messages read, each at most 1,500 characters (truncated: true where cut). For up to 50 messages of 12,000 characters, call bm_agent_messages with detail: "full".`;
}

/** A project's notes as `bm_projects` hands them out, redacted; none when they cannot be read. */
function notesOf(workspaceId: string, context: ToolContext): Array<{ at: string; text: string }> {
  try {
    return context.store.readNotes(workspaceId).map((note) => ({ at: note.at, text: redactText(note.text, context.env) }));
  } catch {
    return [];
  }
}

/** The most open decisions `bm_projects` lists per project; `counts.openDecisions` has them all. */
export const PROJECT_OPEN_DECISIONS_LIMIT = 10;

/**
 * The owner's unsettled decisions of a project, from the decision store
 * (autonomy design §A.9): the Workers' questions, the Orchestrator's own and
 * the fallback incidents, oldest asked first, at most
 * `PROJECT_OPEN_DECISIONS_LIMIT`, the question on one redacted line. None
 * when the store cannot be read.
 */
function openDecisionsOf(workspaceId: string, context: ToolContext): { total: number; entries: Array<Record<string, unknown>> } {
  let open: Decision[];
  try {
    open = createDecisionStore(context.home).list({ workspaceId, statuses: UNSETTLED_STATUSES });
  } catch {
    return { total: 0, entries: [] };
  }
  const entries = open
    .map((decision, index) => ({ decision, index }))
    .sort((a, b) => timeOrZero(a.decision.askedAt) - timeOrZero(b.decision.askedAt) || a.index - b.index)
    .slice(0, PROJECT_OPEN_DECISIONS_LIMIT)
    .map(({ decision }) => ({
      decisionId: decision.id,
      requestId: decision.requestId,
      askedBy: decision.askedBy.role,
      status: decision.status,
      question: firstLine(decision.question, context.env),
      options: decision.options.map((option) => redactText(option.label, context.env)),
      at: decision.askedAt,
    }));
  return { total: open.length, entries };
}

export async function bmProjects(input: { sinceHours?: number; detail?: ReadDetail }, context: ToolContext): Promise<string> {
  const full = input.detail === "full";
  const sinceHours = input.sinceHours ?? PROJECTS_SINCE_HOURS.default;
  const since = context.now.getTime() - sinceHours * 3_600_000;
  const [allAgents, listed] = await Promise.all([bmAgentsOf(context.paseo), listedWorkspaces(context.paseo)]);
  // Stalled requests are Inbox alerts (autonomy design §A.8); `situation` is why they stalled.
  const openStalls = createAlertStore(context.home).list({ open: true, kinds: ["request-stalled"] });

  // A workspace is active when the store saw a turn in the period, or one of its agents runs now.
  const running = new Set(allAgents.filter((entry) => entry.facts.status === "running" && entry.workspaceId !== null).map((entry) => entry.workspaceId!));
  const candidates = recentWorkspacesOf(context.location, since, running);

  const projects: Array<{ lastActivityAt: string | null } & Record<string, unknown>> = [];
  let leftOut = false;
  for (const { workspaceId } of candidates) {
    const { agents, traces } = await workspaceTracesOf(
      { location: context.location, paseo: context.paseo, home: context.home, allAgents },
      workspaceId,
    );
    const recent = recentTracesOf(traces, since);
    if (recent.length === 0 && !running.has(workspaceId)) continue;
    const directory = listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
    const meta = readWorkspaceMeta(context.location, workspaceId);
    const managers = [...agents.values()]
      .filter((agent) => agent.role === "manager" && !agent.archived)
      .map((agent) => ({ id: agent.id, title: agent.title ?? null, status: agent.status }));
    if (!full) {
      // Counts and open decisions only (autonomy design §A.9).
      const notes = notesOf(workspaceId, context).length;
      const byState: Record<string, number> = {};
      let waitingOnOwner = 0;
      for (const { trace } of recent) {
        byState[trace.state] = (byState[trace.state] ?? 0) + 1;
        if (waitingSinceOf(trace) !== null) waitingOnOwner += 1;
      }
      if (recent.length > 0 || notes > 0) leftOut = true;
      const openDecisions = openDecisionsOf(workspaceId, context);
      projects.push({
        workspaceId,
        label: meta?.lastKnownName ?? (directory === null ? workspaceId : basename(directory)),
        lastActivityAt: recent[0]?.lastActivityAt ?? null,
        managers,
        counts: {
          requests: recent.length,
          byState,
          waitingOnOwner,
          openStalls: openStalls.filter((stall) => stall.workspaceId === workspaceId).length,
          notes,
          openDecisions: openDecisions.total,
        },
        openDecisions: openDecisions.entries,
      });
      continue;
    }
    projects.push({
      workspaceId,
      label: meta?.lastKnownName ?? (directory === null ? workspaceId : basename(directory)),
      directory: directory ?? meta?.lastKnownDirectory ?? null,
      lastActivityAt: recent[0]?.lastActivityAt ?? null,
      managers,
      // The Orchestrator's own memory of the project (design §6B.4, §6B.6), oldest first.
      notes: notesOf(workspaceId, context),
      requests: recent.slice(0, PROJECT_REQUEST_LIMIT).map(({ trace, lastActivityAt }) => {
        const key = requestKeyOf(trace);
        return {
          requestId: trace.requestId,
          traceId: trace.traceId,
          request: firstLine(trace.requestText, context.env),
          managerId: trace.managerAgentId,
          tier: trace.tier,
          state: trace.state,
          lastActivityAt,
          waitingSince: waitingSinceOf(trace),
          stalls: openStalls
            .filter((stall) => stall.workspaceId === workspaceId && stall.subject === key)
            .map((stall) => ({ situation: stall.detail ?? "stalled", since: stall.since })),
        };
      }),
    });
  }
  projects.sort((a, b) => timeOrZero(b.lastActivityAt) - timeOrZero(a.lastActivityAt));
  const answer = json({ sinceHours, now: context.now.toISOString(), projects });
  return leftOut ? `${PROJECTS_BOUNDED_NOTE}\n${answer}` : answer;
}

export async function bmRequest(
  input: { workspaceId: string; requestId: string; detail?: ReadDetail },
  context: ToolContext,
  deps: DataHomeDeps,
): Promise<string> {
  // One rebuild of the project, one walk of `agents.list`: the one `traces.get` reads (code review 2026-09-30 §4).
  const project = await readTraceContext({ workspaceId: input.workspaceId }, context.paseo, deps);
  const { traces } = project;
  const trace =
    traces.find((candidate) => candidate.requestId === input.requestId) ?? traces.find((candidate) => candidate.traceId === input.requestId);
  if (trace === undefined) refuse(`no request ${input.requestId} in project ${input.workspaceId}; use the requestId (or traceId) bm_projects gave`);
  const detail = await traceDetailOf({ workspaceId: input.workspaceId, trace }, project, context.paseo);
  // Today's 60,000 with `full`; else a bounded summary, its note first when a message was cut (autonomy design §A.9).
  if (input.detail === "full") return buildRequestContent(detail, { env: context.env }).text;
  return buildRequestContent(detail, { env: context.env, maxChars: REQUEST_SUMMARY_MAX_CHARS, noteWhenCut: REQUEST_BOUNDED_NOTE }).text;
}

interface TimelineMessage {
  at: string | null;
  from: "user" | "agent" | "plugin" | "self";
  text: string;
  truncated: boolean;
}

export async function bmAgentMessages(input: { agentId: string; limit?: number; detail?: ReadDetail }, context: ToolContext): Promise<string> {
  // Today's limits with `full`; else at most 5 messages of 1,500 characters (autonomy design §A.9).
  const full = input.detail === "full";
  const wanted = input.limit ?? AGENT_MESSAGES_LIMIT.default;
  const limit = full ? wanted : Math.min(input.limit ?? AGENT_MESSAGES_SUMMARY.count, AGENT_MESSAGES_SUMMARY.count);
  const maxChars = full ? AGENT_MESSAGE_MAX_CHARS : AGENT_MESSAGES_SUMMARY.maxChars;
  const agent = (await workingAgentsOf(context)).find((candidate) => candidate.id === input.agentId);
  if (agent === undefined) refuse(`${input.agentId} is not a paseo-bm agent; only a Manager, Worker or Reviewer of paseo-bm can be read`);

  // Pages come newest first, each oldest first inside.
  const pages: Array<Array<{ item?: unknown; timestamp?: unknown }>> = [];
  await readTimelinePages(context.paseo, agent.id, { pages: MESSAGE_PAGES, limit: MESSAGE_PAGE_LIMIT }, (entries) => pages.unshift(entries));
  const items = joinStreamedText(
    pages.flat().flatMap((entry) => {
      const item = entry.item as { type?: unknown; text?: unknown; clientMessageId?: unknown } | null | undefined;
      if (item === null || item === undefined || typeof item.text !== "string") return [];
      if (item.type !== "user_message" && item.type !== "assistant_message") return [];
      return [{ ...item, at: typeof entry.timestamp === "string" ? entry.timestamp : null }];
    }),
  );
  const messages: TimelineMessage[] = items.flatMap((item) => {
    const safe = redactText(String(item.text), context.env);
    if (safe.trim() === "") return [];
    const text = cutText(safe, maxChars);
    // A `user_message`'s origin (design §16.2): either plugin origin, a notice or a first prompt, reads `plugin`.
    const origin = item.type === "assistant_message" ? null : originOf({ text: safe, clientMessageId: item.clientMessageId });
    const from: TimelineMessage["from"] =
      origin === null ? "self" : isPluginOrigin(origin) ? "plugin" : origin === "owner" ? "user" : "agent";
    return [{ at: item.at, from, text, truncated: text !== safe }];
  });
  const returned = messages.slice(-limit);
  const answer = json({
    agent: { id: agent.id, role: agent.role, title: agent.title, status: agent.status, workspaceId: agent.workspaceId },
    // `self`: the agent's own reply; `user`: typed by the user in Paseo; `agent`: sent by another agent; `plugin`: a paseo-bm notice or first prompt.
    messages: returned,
  });
  // Cut by the summary: a message's text, or messages `full` would have returned for the same limit.
  const bounded = !full && (returned.some((message) => message.truncated) || Math.min(wanted, messages.length) > returned.length);
  return bounded ? `${agentMessagesBoundedNote(returned.length, messages.length)}\n${answer}` : answer;
}

/** `bm_note` (design §6B.4): one note about a project, kept for later Orchestrators too; sends nothing. */
export async function bmNote(input: { workspaceId: string; text: string; replace?: boolean }, context: ToolContext): Promise<ServerToolResult> {
  await requireProject(input.workspaceId, context);
  const notes = context.store.appendNote(input.workspaceId, input.text, { replace: input.replace === true });
  return {
    ok: true,
    text: `Noted. bm_projects returns this project's notes, also to a new Orchestrator.\n${json({ workspaceId: input.workspaceId, notes: notes.length, replaced: input.replace === true })}`,
  };
}
