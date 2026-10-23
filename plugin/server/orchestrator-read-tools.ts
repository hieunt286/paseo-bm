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
 * - `bm_projects` also counts each project's live peer links
 *   (`counts.openLinks`) and lists them in full (`links`, as `bm_peers` does;
 *   design §7.17.5), and lists a repo's Mains (`repoMainsOf`, missions
 *   design §6) among its `managers` beside the Managers living there.
 * - `bm_note` (§6B.4) keeps the Orchestrator's notes about a project, which
 *   `bm_projects` returns, or — given `missionId` (missions design §9.1) —
 *   about a mission, which `bm_missions` returns.
 * - `bm_missions` (missions design §9.1) reads the missions the governor
 *   watches: each with its charter, roster, figures (`governor-figures.ts`,
 *   computed now against the owner's `governor.*` thresholds), ladder state
 *   (`governor-store.ts`), open `m:` cards and the Orchestrator's notes.
 *
 * Nothing here sends to an agent.
 */
import { basename } from "node:path";
import { joinStreamedText, redactText } from "./collector";
import { readTraceContext, traceDetailOf } from "./dashboard-rpc";
import { bmAgentsOf, directoryIn, listedWorkspaces } from "./paseo-directory";
import type { DataHomeDeps } from "./data-home";
import { readTimelinePages } from "./live-timeline";
import { isPluginOrigin, originOf } from "../shared/message-origin";
import { createAlertStore } from "./alert-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { createDecisionStore } from "./decision-store";
import { figureText, governorFiguresOf, readGovernorSnapshot } from "./governor-figures";
import { createGovernorStore } from "./governor-store";
import { createMissionDecisionStore } from "./mission-decisions";
import { createMissionRoster } from "./mission-roster";
import { createMissionStore, openSplitSuggestionsOf } from "./mission-store";
import { createMemoryStore } from "./memory-store";
import type { NotesOwner } from "./orchestrator-store";
import { createPeerLinkStore, isLiveLink, linkViewsOf } from "./peer-links";
import {
  MESSAGE_PAGES,
  MESSAGE_PAGE_LIMIT,
  json,
  refuse,
  repoMainsOf,
  requireProject,
  workingAgentsOf,
  type ServerToolResult,
  type ToolContext,
} from "./orchestrator-tool-context";
import { repoKeysIn } from "./placements";
import { isPluginHomeIn } from "./plugin-homes";
import { buildRequestContent, cutText } from "./request-render";
import { firstLine, recentTracesOf, recentWorkspacesOf, requestKeyOf, waitingSinceOf, workspaceTracesOf, type WorkspaceTraces } from "./request-trace";
import { readWorkspaceMeta } from "./trace-store";
import { AGENT_MESSAGES_LIMIT, AGENT_MESSAGES_SUMMARY, PROJECTS_SINCE_HOURS, REQUEST_SUMMARY_MAX_CHARS, type ReadDetail } from "../shared/bm-tools";
import { UNSETTLED_STATUSES, type Decision } from "../shared/decisions";
import { timeOrZero } from "../shared/time";

/** The most recent requests `bm_projects` lists per project (design §5.2). */
export const PROJECT_REQUEST_LIMIT = 10;
/** The most peer links `bm_projects` lists per project in full, newest first (design §7.17.5; `bm_peers` shows as many). */
export const PROJECT_LINK_LIMIT = 30;
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

/** A project's (or a mission's) notes as `bm_projects` (`bm_missions`) hands them out, redacted; none when they cannot be read. */
function notesOf(owner: NotesOwner, context: ToolContext): Array<{ at: string; text: string }> {
  try {
    return context.store.readNotes(owner).map((note) => ({ at: note.at, text: redactText(note.text, context.env) }));
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
function openDecisionsOf(workspaceIds: readonly string[], context: ToolContext): { total: number; entries: Array<Record<string, unknown>> } {
  let open: Decision[];
  try {
    const store = createDecisionStore(context.home);
    open = workspaceIds.flatMap((workspaceId) => store.list({ workspaceId, statuses: UNSETTLED_STATUSES }));
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
  // Design §7.17.5: the peer links, read once.
  const peerLinks = createPeerLinkStore(context.home).list();

  // A workspace is active when the store saw a turn in the period, or one of its agents runs now.
  const running = new Set(allAgents.filter((entry) => entry.facts.status === "running" && entry.workspaceId !== null).map((entry) => entry.workspaceId!));
  // The plugin's own homes are not projects (missions design §3.1).
  const candidates = recentWorkspacesOf(context.location, since, running).filter(({ workspaceId }) => !isPluginHomeIn(workspaceId, listed, context.home));

  // Delivery line design §3.1: a mission placement is no project of its own; its requests show under its repo.
  const keyOf = repoKeysIn(context.home);
  const members = new Map<string, string[]>();
  for (const { workspaceId } of candidates) members.set(keyOf(workspaceId), [...(members.get(keyOf(workspaceId)) ?? []), workspaceId]);

  const projects: Array<{ lastActivityAt: string | null } & Record<string, unknown>> = [];
  let leftOut = false;
  for (const [workspaceId, places] of members) {
    const agents: WorkspaceTraces["agents"] = new Map();
    const traces: WorkspaceTraces["traces"] = [];
    /** The workspace each trace was read from: the repo's, or one of its placements. */
    const placeOf = new Map<WorkspaceTraces["traces"][number], string>();
    for (const place of places) {
      const read = await workspaceTracesOf({ location: context.location, paseo: context.paseo, home: context.home, allAgents }, place);
      for (const [id, facts] of read.agents) agents.set(id, facts);
      for (const trace of read.traces) placeOf.set(trace, place);
      traces.push(...read.traces);
    }
    const recent = recentTracesOf(traces, since);
    if (recent.length === 0 && !places.some((place) => running.has(place))) continue;
    const directory = directoryIn(listed, workspaceId);
    const meta = readWorkspaceMeta(context.location, workspaceId);
    // The repo's Mains live in the Missions home (missions design §6).
    const mains = repoMainsOf(context.home, workspaceId);
    const homeMains = allAgents.flatMap((entry) => (mains.has(entry.facts.id) && !agents.has(entry.facts.id) ? [entry.facts] : []));
    const managers = [...agents.values(), ...homeMains]
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
      const openDecisions = openDecisionsOf(places, context);
      projects.push({
        workspaceId,
        label: meta?.lastKnownName ?? (directory === null ? workspaceId : basename(directory)),
        lastActivityAt: recent[0]?.lastActivityAt ?? null,
        managers,
        counts: {
          requests: recent.length,
          byState,
          waitingOnOwner,
          openStalls: openStalls.filter((stall) => stall.workspaceId !== null && places.includes(stall.workspaceId)).length,
          notes,
          openDecisions: openDecisions.total,
          openLinks: peerLinks.filter((link) => isLiveLink(link) && (keyOf(link.from.workspaceId) === workspaceId || keyOf(link.to.workspaceId) === workspaceId)).length,
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
      links: linkViewsOf(peerLinks, workspaceId, keyOf).slice(0, PROJECT_LINK_LIMIT),
      requests: recent.slice(0, PROJECT_REQUEST_LIMIT).map(({ trace, lastActivityAt }) => {
        const key = requestKeyOf(trace);
        const place = placeOf.get(trace) ?? workspaceId;
        return {
          requestId: trace.requestId,
          // The placement it runs in, for bm_request (absent: the repo's own).
          ...(place === workspaceId ? {} : { workspaceId: place }),
          traceId: trace.traceId,
          request: firstLine(trace.requestText, context.env),
          managerId: trace.managerAgentId,
          tier: trace.tier,
          state: trace.state,
          lastActivityAt,
          waitingSince: waitingSinceOf(trace),
          stalls: openStalls
            .filter((stall) => stall.workspaceId === place && stall.subject === key)
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

export interface NoteInput {
  workspaceId?: string;
  missionId?: string;
  text: string;
  replace?: boolean;
}

/** How an Orchestrator's note in project memory names its source (missions design §20); also how `replace` finds its own entries. */
export const ORCHESTRATOR_MEMORY_SOURCE = "The owner, in the Orchestrator's chat";

/**
 * `bm_note` (design §6B.4; missions design §9.1, §20, ADR-032 decision 5):
 * one note about the mission `missionId` names, kept for later Orchestrators
 * too; or the owner's word about a project, written to that repo's project
 * memory as a `decision` entry by the owner (source
 * `ORCHESTRATOR_MEMORY_SOURCE` and the date), which `replace` makes supersede
 * the newest active entry of that source. Older project notes stay readable
 * (`bm_projects`) and are no longer written. Sends nothing.
 */
export async function bmNote(input: NoteInput, context: ToolContext): Promise<ServerToolResult> {
  const replaced = input.replace === true;
  if (input.missionId !== undefined) {
    if (input.workspaceId !== undefined) refuse("give workspaceId or missionId, not both");
    if (createMissionStore(context.home).get(input.missionId) === null) refuse(`no mission ${input.missionId}; call bm_missions for their ids`);
    const notes = context.store.appendNote({ missionId: input.missionId }, input.text, { replace: replaced });
    return { ok: true, text: `Noted. bm_missions returns this mission's notes, also to a new Orchestrator.\n${json({ missionId: input.missionId, notes: notes.length, replaced })}` };
  }
  if (input.workspaceId === undefined) refuse("give workspaceId (a project's note) or missionId (a mission's)");
  await requireProject(input.workspaceId, context);
  const memory = createMemoryStore(context.home, { env: context.env, now: () => context.now });
  const supersedes = replaced
    ? ([...memory.active(input.workspaceId)].reverse().find((entry) => entry.by.role === "owner" && entry.source.startsWith(ORCHESTRATOR_MEMORY_SOURCE))?.id ?? null)
    : null;
  const added = memory.add(input.workspaceId, {
    kind: "decision",
    text: input.text,
    source: `${ORCHESTRATOR_MEMORY_SOURCE}, ${context.now.toISOString().slice(0, 10)}`,
    by: { role: "owner", agentId: null, missionId: null },
    supersedes,
  });
  if (!added.ok) refuse(`the project memory refused the note: ${added.reasons.join("; ")}`);
  return {
    ok: true,
    text: `Noted in the project memory: its Mains and Workers carry it in their briefs.\n${json({ workspaceId: input.workspaceId, memoryId: added.entry.id, supersedes })}`,
  };
}

/**
 * `bm_missions` (missions design §9.1, §9.2, §9.3): the open missions (and
 * the closed ones with `closed: true`), or the one `missionId` names, newest
 * first — each with its charter, its roster (each request's repo, topic,
 * state and Workers), its figures now (crossed first, each with its
 * threshold), its ladder (each family's step, since when and its last
 * action), its open `m:` cards and its open split suggestions (a Main's
 * `bm_split_mission`, `openSplitSuggestionsOf`). Text is redacted. Read-only.
 */
export async function bmMissions(input: { missionId?: string; closed?: boolean }, context: ToolContext): Promise<string> {
  const store = createMissionStore(context.home);
  const entries = store
    .list()
    .filter((entry) => (input.missionId === undefined ? input.closed === true || entry.state === "open" : entry.missionId === input.missionId));
  if (input.missionId !== undefined && entries.length === 0) refuse(`no mission ${input.missionId}; call bm_missions without missionId for their ids`);
  const settings = readCoordinationSettings({ home: context.home });
  const agents = entries.length === 0 ? [] : await bmAgentsOf(context.paseo);
  const ladders = createGovernorStore(context.home).list();
  const cards = createMissionDecisionStore(context.home);
  const roster = createMissionRoster(context.home);
  const text = (value: string) => redactText(value, context.env);
  const missions = entries.flatMap((entry) => {
    const mission = store.get(entry.missionId);
    if (mission === null) return [];
    const figures = governorFiguresOf(readGovernorSnapshot(context.home, mission, { now: context.now, agents, settings }), settings.governor);
    return [
      {
        missionId: mission.missionId,
        code: mission.code,
        name: text(mission.name),
        state: mission.state,
        createdAt: mission.createdAt,
        mainId: mission.mainId,
        parentMissionId: mission.parentMissionId,
        charter: {
          goal: text(mission.charter.goal),
          repos: mission.charter.repos,
          nonGoals: mission.charter.nonGoals.map(text),
          doneCriteria: mission.charter.doneCriteria.map((criterion) => ({ id: criterion.id, text: text(criterion.text), status: criterion.status, at: criterion.at })),
          budget: mission.charter.budget,
          confirmedAt: mission.charter.confirmedAt,
        },
        roster: roster.list(mission.missionId).map((request) => ({
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          topic: text(request.topic),
          state: request.state,
          workerIds: request.workerIds,
        })),
        figures: { crossed: figures.filter((figure) => figure.crossed).map(figureText), under: figures.filter((figure) => !figure.crossed).map(figureText) },
        ladder: Object.fromEntries(
          Object.entries(ladders[mission.missionId] ?? {}).map(([family, state]) => [family, { step: state.step, since: state.since, lastAction: state.lastAction }]),
        ),
        openCards: cards.list(mission.missionId, UNSETTLED_STATUSES).map((decision) => ({
          decisionId: decision.id,
          question: firstLine(decision.question, context.env),
          options: decision.options.map((option) => text(option.label)),
          at: decision.askedAt,
        })),
        // §9.6: what its Main suggested, on the owner's yes, as a new mission — bm_create_main's fields.
        splitSuggestions: openSplitSuggestionsOf(context.home, mission.missionId).map((suggestion) => ({
          at: suggestion.at,
          by: suggestion.by,
          code: suggestion.code,
          name: text(suggestion.name),
          goal: text(suggestion.goal),
          repos: suggestion.repos,
          requestIds: suggestion.requestIds,
          reason: text(suggestion.reason),
        })),
        notes: notesOf({ missionId: mission.missionId }, context),
      },
    ];
  });
  missions.sort((a, b) => timeOrZero(b.createdAt) - timeOrZero(a.createdAt));
  return json({ now: context.now.toISOString(), missions });
}
