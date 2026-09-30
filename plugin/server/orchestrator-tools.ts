/**
 * The Orchestrator's tools (Orchestrator design §5, ADR-014 decision 3),
 * served by `agent-tools.ts` at `/mcp/orchestrator/<secret>`.
 *
 * - `bm_projects`, `bm_request`, `bm_agent_messages` (§5.2) only read: the
 *   trace store, `agents.list`, `workspaces.list` and — for
 *   `bm_agent_messages` — that one agent's timeline. `bm_request` builds its
 *   request through `traces.get` (`handleTracesGet`), which also reads the
 *   request's own Workers' and Reviewers' timelines for skills and typed
 *   messages, as Work's request timeline does. Every text handed out is redacted.
 *   Each returns a bounded summary by default and today's content with
 *   `detail: "full"` (autonomy design §A.9), with a one-line note first
 *   whenever the summary left something out.
 * - `bm_send_command` (§6A, §6B.1, ADR-015) sends a command to a paseo-bm
 *   Manager itself, on an authority (`authorityOf`, autonomy design §A.7,
 *   ADR-017): the grant of an Orchestrator decision the owner answered
 *   (`decisionId`), the project's Autopilot, or the owner's own latest
 *   inbound message in the Orchestrator's chat (`isOwnerWord`). It declares
 *   its `intent` and `effects`; each declared effect must be covered — by the
 *   grant for any effect, by Autopilot or the owner's word in the chat only
 *   outside `CONFIRM_EFFECTS` (push, publish, deploy, real data, migration,
 *   security, cost). It is a `BM-COMMAND` v2 block (`from: orchestrator`,
 *   `via: autopilot | chat`, `authority`, `approved`, the limits that remain),
 *   delivered through the notice queue (`command:<id>`), and recorded in
 *   `orchestrator/proposals.json` with source `autopilot` or `chat`. A grant
 *   is spent (`useGrant`) once the command is delivered. Without any of the
 *   three it is refused: the Orchestrator asks the owner with `bm_ask_owner`,
 *   whose option may carry the command prepared (autonomy design §A.7).
 * - `bm_direct_worker` (§6B.4, ADR-016) sends a `BM-COMMAND to: worker` to a
 *   paseo-bm Worker under the same authority: through the queue (at its turn
 *   end), or at once with `interrupt: true` only while that Worker's danger
 *   allowance is open; its Manager always gets the same block with `copy:
 *   yes` through the queue. Never a Reviewer.
 * - Both pass the backstop (`undeclaredCategoriesOf` over `re:` and the body:
 *   a category of the big-decision gate that the declared effects do not
 *   cover refuses with "declare the effect or ask the owner" — less the
 *   categories the owner allowed for the project and, for a stop sent to a
 *   Worker whose danger allowance is open, `release` and `data`, until Phase
 *   2), then a loop guard that refuses a 13th command the Orchestrator sends
 *   for one request (or one project, without a request) within 24 hours. A
 *   refusal sends, records and spends nothing.
 * - `bm_repo` (§6B.4) runs a fixed read-only `git` command (`execFile`, no
 *   shell) in the project's folder or a folder inside it, or reads one file
 *   there; `bm_note` (§6B.4) keeps the Orchestrator's notes about a project,
 *   which `bm_projects` returns.
 * - `bm_ask_owner` (§6A, §6B.4; autonomy design §A.3, §A.6) stores an open
 *   `o:` decision in the decision store (`decision-store.ts`), each option
 *   with its declared effects and, optionally, a prepared command the plugin
 *   delivers itself once the owner picks it (`orchestrator-decisions.ts`). It
 *   replaces the Orchestrator's open decision of the same request unless
 *   `separate`, and says which one it replaced; it sends nothing.
 *   `bm_decisions` (autonomy design §A.9) lists stored decisions, read-only
 *   (`decision-tools.ts`). `bm_set_autopilot` (§6A) turns a project's Autopilot on or off
 *   under the same chat check; it sends nothing (autonomy design §A.8: the
 *   Orchestrator runs already, and the project's events follow).
 * - `bm_assessment` (§5.5) checks the assessment with the pure tool of
 *   `shared/bm-tools.ts` and records it as a `done` workflow line of
 *   `assessments/<workspaceId>.jsonl`.
 *
 * Only `bm_send_command` and `bm_direct_worker` reach a working agent — a
 * Manager, or a Worker and its Manager. Nothing here sends
 * to a Reviewer, creates, stops or archives, or writes to a repository.
 *
 * The endpoint is plain HTTP, so there is no hook or RPC context to take a
 * Paseo handle from. The creation hook hands one over (`usePaseo`) every time
 * a paseo-bm agent is created — and the Orchestrator only learns the
 * endpoint's secret from that hook, so a call that reaches these tools always
 * comes after a handle was given in this run of the plugin.
 *
 * Nothing here throws to the endpoint: a failure is a tool error the agent
 * reads.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { roleOfProvider, listAllAgents } from "./agent-role";
import { buildAssessmentContent, cutText, ORCHESTRATOR_PROVIDER_ID } from "./assessment";
import { joinStreamedText, redactText } from "./collector";
import { bmAgentsOf, handleTracesGet, listedWorkspaces, type DashboardPaseo } from "./dashboard-rpc";
import { resolveDataHome, type DataHomeDeps } from "./data-home";
import { readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { noticeQueue, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { isPluginNotice } from "./notices";
import { commandKindOf, commandRequestIdOf, commandSubjectOf } from "./orchestrator-actions";
import { findOrchestratorAgent, isOwnerWord, type OrchestratorAgentPaseo } from "./orchestrator-agent";
import { createAlertStore } from "./alert-store";
import { createDecisionStore } from "./decision-store";
import { decisionsText, type DecisionsQuery } from "./decision-tools";
import { createOrchestratorStore, type OrchestratorStore } from "./orchestrator-store";
import { ruleInputOf, workspaceTracesOf } from "./request-trace";
import { REVIEW_BUDGET } from "./review-budget";
import { readRecords, readWorkspaceMeta, storedWorkspaceIds, type TraceStoreLocation } from "./trace-store";
import type { ReconstructedTrace } from "./traces";
import {
  AGENT_MESSAGES_LIMIT,
  AGENT_MESSAGES_SUMMARY,
  PROJECTS_SINCE_HOURS,
  REQUEST_SUMMARY_MAX_CHARS,
  ORCHESTRATOR_SERVER_TOOLS,
  schemaIssues,
  toolNamed,
  type ReadDetail,
  type RepoAction,
  type ToolFace,
} from "../shared/bm-tools";
import { DashboardError } from "../shared/contracts";
import { DANGER_STOP_CATEGORIES, isStopCommand, undeclaredCategoriesOf, undeclaredRefusalOf, type GateCategory } from "../shared/decision-gate";
import {
  CONFIRM_EFFECTS,
  MAX_DECISION_TEXT_CHARS,
  UNSETTLED_STATUSES,
  decisionKindOf,
  grantRefusal,
  realEffects,
  useGrant,
  type Decision,
  type DecisionOption,
  type Effect,
} from "../shared/decisions";
import { WORKFLOW_ASSESSMENT_TRACE_ID, isSentCommand, type AssessmentLine, type Proposal } from "../shared/orchestrator";
import {
  commandBlockOf,
  commandInputProblems,
  commandOf,
  decisionAuthorityOf,
  type CommandTo,
  type CommandAuthority,
  type CommandInput,
  type CommandIntent,
} from "../shared/orchestrator-command";
import { assessmentResultSchema } from "../shared/bm-assessment";
import { flagsOf } from "../shared/orchestrator-rules";

/** The most recent requests `bm_projects` lists per project (design §5.2). */
export const PROJECT_REQUEST_LIMIT = 10;
/** The longest message `bm_agent_messages` hands out (design §6A: long enough for a question with all its options). */
export const AGENT_MESSAGE_MAX_CHARS = 12_000;
/** The longest first line of a request in `bm_projects`. */
export const REQUEST_LINE_MAX_CHARS = 200;
/** The note `bm_projects` puts first when its summary left requests or notes out (autonomy design §A.9). */
export const PROJECTS_BOUNDED_NOTE =
  'Summary: counts and open decisions only. For each recent request with its signals and stalls, and your notes, call bm_projects with detail: "full".';
/** The note `bm_request` puts first when its summary cut messages (autonomy design §A.9). */
export const REQUEST_BOUNDED_NOTE =
  'Bounded to 4,000 characters: the longest messages are cut, each marked ...[truncated]. For up to 60,000 characters, call bm_request with detail: "full".';
/** The note `bm_agent_messages` puts first when its summary left messages or text out (autonomy design §A.9). */
export function agentMessagesBoundedNote(returned: number, read: number): string {
  return `Bounded: the ${returned} most recent of ${read} messages read, each at most 1,500 characters (truncated: true where cut). For up to 50 messages of 12,000 characters, call bm_agent_messages with detail: "full".`;
}
/** How far back a workflow assessment recorded without a pending line looks for its scope (design §8 `assess-workflow`). */
export const WORKFLOW_SCOPE_DAYS = 7;
/** How many requests that scope names at most (design §8 `assess-workflow`). */
export const WORKFLOW_SCOPE_LIMIT = 10;
/** Timeline pages `bm_agent_messages` reads back at most; a provider streams a reply in many chunks. */
const MESSAGE_PAGES = 5;
const MESSAGE_PAGE_LIMIT = 200;

/** Why `bm_send_command` refused (design §6A; autonomy design §A.7). */
export const SEND_REFUSED_MESSAGE =
  "Autopilot is off for this project and the owner has not just told you to send; ask the owner with bm_ask_owner, with this command prepared on an option";

/** The loop guard (design §6A): at most this many commands the Orchestrator sends for one request … */
export const COMMAND_LIMIT_PER_REQUEST = 12;
/** … within this many hours. */
export const COMMAND_LIMIT_WINDOW_HOURS = 24;
/** Why `bm_send_command` refused at the loop guard (design §6A). */
export const COMMAND_LIMIT_MESSAGE = "Autopilot limit reached for this request; ask the owner with bm_ask_owner";

/**
 * How many commands the Orchestrator sent itself (`bm_send_command`: source
 * `autopilot` or `chat`) for this request — or, with no request id, for this
 * project without a request — in the 24 hours before `now` (design §6A).
 */
export function commandsSentFor(
  commands: readonly Proposal[],
  workspaceId: string,
  requestId: string | null,
  now: Date,
): number {
  const since = now.getTime() - COMMAND_LIMIT_WINDOW_HOURS * 3_600_000;
  return commands.filter(
    (entry) =>
      isSentCommand(entry) &&
      entry.workspaceId === workspaceId &&
      entry.requestId === requestId &&
      timeOf(entry.settledAt ?? entry.at) > since,
  ).length;
}

/** Why `bm_set_autopilot` refused (design §6A). */
export const SET_AUTOPILOT_REFUSED_MESSAGE =
  "the owner has not just told you to change Autopilot; only the owner's own latest message in this chat can";

/** Why `bm_direct_worker` refused for want of authority (design §6B.4: the same rule as `bm_send_command`). */
export const DIRECT_REFUSED_MESSAGE =
  "Autopilot is off for this project and the owner has not just told you to send; ask the owner with bm_ask_owner, with this command prepared on an option";

/** Why `bm_direct_worker` refused an interrupt (design §6B.4, ADR-016 decision 2). */
export const INTERRUPT_REFUSED_MESSAGE =
  "interrupt is allowed only while a danger signal of this Worker is open; send it without interrupt, and the Worker gets it when its turn ends";

/** `bm_repo` (design §6B.4): the longest output handed out … */
export const REPO_OUTPUT_MAX_CHARS = 20_000;
/** … the largest file it reads (or git output it takes in) … */
export const REPO_FILE_MAX_BYTES = 200 * 1024;
/** … and how long one git command may run. */
export const REPO_TIMEOUT_MS = 10_000;

/**
 * What every git command of `bm_repo` starts with: no pager, no colour, and
 * no filesystem monitor (`core.fsmonitor` names a program git would run).
 * With `GIT_OPTIONAL_LOCKS=0` in its environment, `status` does not refresh
 * the index either, so nothing in the repository is written.
 */
export const GIT_READ_ONLY_PREFIX: readonly string[] = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "core.quotePath=false"];

/**
 * A file `bm_repo` never reads, by its name: environment files, keys,
 * certificates and credential stores. Credentials are untouchable (AGENTS.md).
 */
const SECRET_FILE_NAME = /^(?:\.env(?:\..*)?|\.envrc|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;

/** Runs one git command; `execFile` of `git` without a shell by default (`runGit`). Rejects on a non-zero exit. */
export type GitRunner = (args: readonly string[], options: { cwd: string; maxBytes: number }) => Promise<{ stdout: string }>;

/** The SDK slice the tools use. `PaseoApi` is structurally assignable. */
export type OrchestratorToolsPaseo = DashboardPaseo & LiveTimelinePaseo;

/** A tool's answer: text for the agent, or the reason it was refused. */
export type ServerToolResult = { ok: true; text: string } | { ok: false; text: string };

export interface OrchestratorToolsDeps extends DataHomeDeps {
  now?: () => Date;
  /** Secrets to mask; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  /** A new assessment id, and the part after `o:` of a new decision id; `randomUUID` by default. Proposal ids come from the store. */
  newId?: () => string;
  /** The store's own deps (fixed proposal ids in tests). A command `bm_send_command` records takes its id from `store.newId` too. */
  store?: Parameters<typeof createOrchestratorStore>[1];
  /** The notice queue `bm_send_command` delivers through; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue">;
  /** How `bm_repo` runs git; `runGit` by default. */
  git?: GitRunner;
  log?: (message: string) => void;
}

export interface OrchestratorTools {
  /** The tools the Orchestrator's endpoint lists, in order. */
  readonly faces: readonly ToolFace[];
  /** True when `name` is one of these tools. */
  has(name: string): boolean;
  /** Keeps the handle a hook or RPC context brought; anything that is not one is ignored. */
  usePaseo(paseo: unknown): void;
  /** Runs one tool. Never throws. */
  call(name: string, input: unknown): Promise<ServerToolResult>;
}

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function isPaseo(value: unknown): value is OrchestratorToolsPaseo {
  const candidate = value as { agents?: { list?: unknown }; workspaces?: { list?: unknown } } | null | undefined;
  return typeof candidate?.agents?.list === "function" && typeof candidate?.workspaces?.list === "function";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeOf(at: string | null | undefined): number {
  const time = at === null || at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(time) ? 0 : time;
}

/** The first non-empty line of `text`, redacted and cut; `bm_projects` and `orchestrator.state` use it. */
export function firstLine(text: string | null, env: NodeJS.ProcessEnv): string | null {
  if (text === null) return null;
  const line = redactText(text, env)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return null;
  // One line, always: `cutText` would put its truncation marker on lines of its own.
  const chars = [...line];
  return chars.length <= REQUEST_LINE_MAX_CHARS ? line : `${chars.slice(0, REQUEST_LINE_MAX_CHARS - 1).join("")}…`;
}

/**
 * The key a request's stall situations are stored under (design §5.4):
 * its request id, or its trace id when it has none.
 */
export function requestKeyOf(trace: Pick<ReconstructedTrace, "requestId" | "traceId">): string {
  return trace.requestId ?? trace.traceId;
}

/** The newest time anything of the request was recorded. */
export function lastActivityOf(trace: ReconstructedTrace): string {
  let latest = trace.requestedAt;
  for (const record of trace.records) if (timeOf(record.endedAt) > timeOf(latest)) latest = record.endedAt;
  return latest;
}

/**
 * When the request started waiting on the user: the time of its last report,
 * when that one is `blocked`. A stored message time can be the write time
 * (AGENTS.md), which is never before the end of the turn that carried the
 * report, so that end time is used when it is earlier (design §6).
 */
export function waitingSinceOf(trace: ReconstructedTrace): string | null {
  const last = trace.reports.at(-1);
  if (last?.phase !== "blocked") return null;
  const carrier = trace.records.find((record) =>
    record.reports.some((entry) => entry === last || (entry.agentId === last.agentId && entry.at === last.at && entry.phase === "blocked")),
  );
  const endedAt = carrier === undefined ? 0 : timeOf(carrier.endedAt);
  return endedAt > 0 && endedAt < timeOf(last.at) ? carrier!.endedAt : last.at;
}

// ---------------------------------------------------------------------------
// The tools.
// ---------------------------------------------------------------------------

interface Context {
  paseo: OrchestratorToolsPaseo;
  home: string;
  location: TraceStoreLocation;
  store: OrchestratorStore;
  now: Date;
  env: NodeJS.ProcessEnv;
}

/** A project's notes as `bm_projects` hands them out, redacted; none when they cannot be read. */
function notesOf(workspaceId: string, context: Context): Array<{ at: string; text: string }> {
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
function openDecisionsOf(workspaceId: string, context: Context): { total: number; entries: Array<Record<string, unknown>> } {
  let open: Decision[];
  try {
    open = createDecisionStore(context.home).list({ workspaceId, statuses: UNSETTLED_STATUSES });
  } catch {
    return { total: 0, entries: [] };
  }
  const entries = open
    .map((decision, index) => ({ decision, index }))
    .sort((a, b) => timeOf(a.decision.askedAt) - timeOf(b.decision.askedAt) || a.index - b.index)
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

async function bmProjects(input: { sinceHours?: number; detail?: ReadDetail }, context: Context): Promise<string> {
  const full = input.detail === "full";
  const sinceHours = input.sinceHours ?? PROJECTS_SINCE_HOURS.default;
  const since = context.now.getTime() - sinceHours * 3_600_000;
  const [allAgents, listed] = await Promise.all([bmAgentsOf(context.paseo), listedWorkspaces(context.paseo)]);
  // Stalled requests are Inbox alerts (autonomy design §A.8); `situation` is why they stalled.
  const openStalls = createAlertStore(context.home).list({ open: true, kinds: ["request-stalled"] });
  const corrections = context.store.readCorrections();

  // A workspace is active when the store saw a turn in the period, or one of its agents runs now.
  const running = new Set(allAgents.filter((entry) => entry.facts.status === "running" && entry.workspaceId !== null).map((entry) => entry.workspaceId!));
  const candidates = storedWorkspaceIds(context.location).filter((workspaceId) => {
    const meta = readWorkspaceMeta(context.location, workspaceId);
    return running.has(workspaceId) || meta === null || timeOf(meta.lastSeenAt) >= since;
  });

  const projects: Array<{ lastActivityAt: string | null } & Record<string, unknown>> = [];
  let leftOut = false;
  for (const workspaceId of candidates) {
    const { agents, traces } = await workspaceTracesOf(
      { location: context.location, paseo: context.paseo, home: context.home, allAgents },
      workspaceId,
    );
    const recent = traces
      .map((trace) => ({ trace, lastActivityAt: lastActivityOf(trace) }))
      .filter((entry) => timeOf(entry.lastActivityAt) >= since)
      .sort((a, b) => timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt));
    if (recent.length === 0 && !running.has(workspaceId)) continue;
    const directory = listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
    const meta = readWorkspaceMeta(context.location, workspaceId);
    const facts = { reviewBudget: REVIEW_BUDGET, corrections, workspaceDirectory: directory ?? meta?.lastKnownDirectory ?? null };
    const managers = [...agents.values()]
      .filter((agent) => agent.role === "manager" && !agent.archived)
      .map((agent) => ({ id: agent.id, title: agent.title ?? null, status: agent.status }));
    if (!full) {
      // Counts and open decisions only (autonomy design §A.9).
      const notes = notesOf(workspaceId, context).length;
      const byState: Record<string, number> = {};
      let waitingOnOwner = 0;
      let withSignals = 0;
      for (const { trace } of recent) {
        byState[trace.state] = (byState[trace.state] ?? 0) + 1;
        if (waitingSinceOf(trace) !== null) waitingOnOwner += 1;
        if (flagsOf(ruleInputOf(trace, agents), facts).some((flag) => flag.state === "raised")) withSignals += 1;
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
          withSignals,
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
          signals: flagsOf(ruleInputOf(trace, agents), facts)
            .filter((flag) => flag.state === "raised")
            .map((flag) => flag.rule),
          stalls: openStalls
            .filter((stall) => stall.workspaceId === workspaceId && stall.subject === key)
            .map((stall) => ({ situation: stall.detail ?? "stalled", since: stall.since })),
        };
      }),
    });
  }
  projects.sort((a, b) => timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt));
  const answer = json({ sinceHours, now: context.now.toISOString(), projects });
  return leftOut ? `${PROJECTS_BOUNDED_NOTE}\n${answer}` : answer;
}

async function bmRequest(
  input: { workspaceId: string; requestId: string; detail?: ReadDetail },
  context: Context,
  deps: DataHomeDeps,
): Promise<string> {
  const { agents, traces } = await workspaceTracesOf({ location: context.location, paseo: context.paseo, home: context.home }, input.workspaceId);
  const trace =
    traces.find((candidate) => candidate.requestId === input.requestId) ?? traces.find((candidate) => candidate.traceId === input.requestId);
  if (trace === undefined) refuse(`no request ${input.requestId} in project ${input.workspaceId}; use the requestId (or traceId) bm_projects gave`);
  const [listed, detail] = await Promise.all([
    listedWorkspaces(context.paseo),
    handleTracesGet({ workspaceId: input.workspaceId, traceId: trace.traceId }, context.paseo, deps),
  ]);
  const directory =
    listed?.find((entry) => entry.id === input.workspaceId)?.directory ?? readWorkspaceMeta(context.location, input.workspaceId)?.lastKnownDirectory ?? null;
  const flags = flagsOf(ruleInputOf(trace, agents), {
    reviewBudget: REVIEW_BUDGET,
    corrections: context.store.readCorrections(),
    workspaceDirectory: directory,
  });
  // Today's 60,000 with `full`; else a bounded summary, its note first when a message was cut (autonomy design §A.9).
  if (input.detail === "full") return buildAssessmentContent(detail.trace, flags, { env: context.env }).text;
  return buildAssessmentContent(detail.trace, flags, { env: context.env, maxChars: REQUEST_SUMMARY_MAX_CHARS, noteWhenCut: REQUEST_BOUNDED_NOTE }).text;
}

/** Every paseo-bm Manager, Worker and Reviewer by its provider, as `agents.list` shows it (design §5.2). */
export async function workingAgents(paseo: Pick<OrchestratorToolsPaseo, "agents">) {
  const listed = await listAllAgents(
    async (options) => {
      const result = await paseo.agents.list(options);
      return {
        entries: result.entries.map((entry) => ({ agent: (entry["agent"] ?? entry) as Record<string, unknown> })),
        ...(result.pageInfo === undefined ? {} : { pageInfo: result.pageInfo }),
      };
    },
    { includeArchived: true },
  );
  return listed.flatMap((agent) => {
    const role = roleOfProvider(agent["provider"]);
    const id = typeof agent["id"] === "string" ? agent["id"] : "";
    if (id === "" || (role !== "manager" && role !== "worker" && role !== "reviewer")) return [];
    return [
      {
        id,
        role,
        workspaceId: typeof agent["workspaceId"] === "string" ? agent["workspaceId"] : null,
        title: typeof agent["title"] === "string" ? agent["title"] : null,
        status: typeof agent["status"] === "string" ? agent["status"] : "closed",
        archived: typeof agent["archivedAt"] === "string" && agent["archivedAt"] !== "",
        // The agent that created it: a Worker's Manager (`paseo.parent-agent-id`, AGENTS.md).
        parentAgentId: parentOf(agent),
      },
    ];
  });
}

function parentOf(agent: Record<string, unknown>): string | null {
  const labels = (agent["labels"] ?? {}) as Record<string, unknown>;
  const parent = labels["paseo.parent-agent-id"] ?? agent["parentAgentId"];
  return typeof parent === "string" && parent !== "" ? parent : null;
}

interface TimelineMessage {
  at: string | null;
  from: "user" | "agent" | "plugin" | "self";
  text: string;
  truncated: boolean;
}

async function bmAgentMessages(input: { agentId: string; limit?: number; detail?: ReadDetail }, context: Context): Promise<string> {
  // Today's limits with `full`; else at most 5 messages of 1,500 characters (autonomy design §A.9).
  const full = input.detail === "full";
  const wanted = input.limit ?? AGENT_MESSAGES_LIMIT.default;
  const limit = full ? wanted : Math.min(input.limit ?? AGENT_MESSAGES_SUMMARY.count, AGENT_MESSAGES_SUMMARY.count);
  const maxChars = full ? AGENT_MESSAGE_MAX_CHARS : AGENT_MESSAGES_SUMMARY.maxChars;
  const agent = (await workingAgents(context.paseo)).find((candidate) => candidate.id === input.agentId);
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
    const from: TimelineMessage["from"] =
      item.type === "assistant_message"
        ? "self"
        : isPluginNotice(safe)
          ? "plugin"
          : typeof item.clientMessageId === "string"
            ? "user"
            : "agent";
    return [{ at: item.at, from, text, truncated: text !== safe }];
  });
  const returned = messages.slice(-limit);
  const answer = json({
    agent: { id: agent.id, role: agent.role, title: agent.title, status: agent.status, workspaceId: agent.workspaceId },
    // `self`: the agent's own reply; `user`: typed by the user in Paseo; `agent`: sent by another agent; `plugin`: a paseo-bm notice.
    messages: returned,
  });
  // Cut by the summary: a message's text, or messages `full` would have returned for the same limit.
  const bounded = !full && (returned.some((message) => message.truncated) || Math.min(wanted, messages.length) > returned.length);
  return bounded ? `${agentMessagesBoundedNote(returned.length, messages.length)}\n${answer}` : answer;
}

/** The non-archived paseo-bm Manager `managerId` of `workspaceId`, or a refusal saying which of these it is not. */
async function requireManager(input: { workspaceId: string; managerId: string }, context: Context) {
  const manager = (await workingAgents(context.paseo)).find((candidate) => candidate.id === input.managerId);
  if (manager === undefined || manager.role !== "manager") refuse(`${input.managerId} is not a paseo-bm Manager; use a managerId bm_projects gave`);
  if (manager.workspaceId !== input.workspaceId) refuse(`Manager ${input.managerId} does not belong to project ${input.workspaceId}`);
  if (manager.archived) refuse(`Manager ${input.managerId} is archived; nothing can be sent to it`);
  return manager;
}

/** Refuses a workspace that is not a paseo-bm project: none of its turns is stored and none of its agents is paseo-bm's. */
async function requireProject(workspaceId: string, context: Context): Promise<void> {
  if (storedWorkspaceIds(context.location).includes(workspaceId)) return;
  if ((await workingAgents(context.paseo)).some((agent) => agent.workspaceId === workspaceId)) return;
  refuse(`no paseo-bm project ${workspaceId}; use the workspaceId bm_projects gave`);
}

/**
 * Whether the owner has just spoken in the Orchestrator's own chat (design
 * §6A (b), ADR-015 decision 3): the latest inbound message of its timeline is
 * the owner's own words (`isOwnerWord`: a `user_message` carrying
 * `clientMessageId` that is neither a plugin notice nor one of the plugin's
 * prompts). The calling agent is the one Orchestrator
 * (`findOrchestratorAgent`): the endpoint's path secret is given to it alone.
 * No Orchestrator, or a timeline that cannot be read → false.
 */
async function ownerJustSpoke(paseo: OrchestratorToolsPaseo): Promise<boolean> {
  const orchestrator = await findOrchestratorAgent(paseo as unknown as OrchestratorAgentPaseo);
  if (orchestrator === null) return false;
  // Pages come newest first, each oldest first inside.
  const pages: Array<Array<{ item?: unknown }>> = [];
  await readTimelinePages(paseo, orchestrator.id, { pages: MESSAGE_PAGES, limit: MESSAGE_PAGE_LIMIT }, (entries) => pages.unshift(entries));
  const latest = pages
    .flat()
    .map((entry) => entry.item as { type?: unknown } | null | undefined)
    .filter((item) => item?.type === "user_message")
    .at(-1);
  return isOwnerWord(latest);
}

/**
 * The effects only the grant of a decision the owner answered can cover
 * (autonomy design §A.7): never Autopilot, never the owner's word in the chat
 * — release, data, security and cost (`CONFIRM_EFFECTS`, experience concept X-4).
 */
export const DECISION_ONLY_EFFECTS: readonly Effect[] = CONFIRM_EFFECTS;

/** Why a command was refused for declaring an effect only a decision covers. */
export function needsDecisionMessageOf(effects: readonly Effect[]): string {
  return `${effects.join(", ")} needs the owner's decision: ask with bm_ask_owner, and once the owner has answered, send with its decisionId`;
}

/** What `authorityOf` found: how the command leaves, on whose authority, what that covers, and the grant it spends. */
interface CommandAuthorityOf {
  via: "autopilot" | "chat";
  authority: CommandAuthority;
  /** The declared effects, every one covered. */
  approved: Effect[];
  /** The decision whose grant the command spends once delivered; null when it spends none. */
  grantOf: string | null;
}

/** Decisions whose grant a command in flight is spending, so two calls never spend one (the store takes no lock). */
const grantsInFlight = new Set<string>();

/**
 * The decision `decisionId` names, when it can authorise this command: one
 * the Orchestrator asked (`o:…`) in this project, answered by the owner, about
 * the command's request when it names one — and, for a command that declares
 * effects, whose grant covers them now (unused, within its hour, every effect
 * granted: `grantRefusal`) and is not being spent by another call.
 */
function answeredDecisionOf(decisionId: string, workspaceId: string, requestId: string | null, declared: readonly Effect[], context: Context): Decision {
  if (decisionKindOf(decisionId) !== "orchestrator") {
    refuse(`${decisionId} is not a decision you asked; decisionId takes the id (o:…) of your own decision the owner answered`);
  }
  let decision: Decision | null;
  try {
    decision = createDecisionStore(context.home).get(decisionId, workspaceId);
  } catch (error) {
    refuse(`the decisions of project ${workspaceId} cannot be read: ${describeError(error)}`);
  }
  if (decision === null) refuse(`no decision ${decisionId} in project ${workspaceId}`);
  if (decision.status !== "answered") refuse(`decision ${decisionId} is ${decision.status}; only a decision the owner answered authorises a command`);
  if (decision.requestId !== null && decision.requestId !== requestId) {
    refuse(`decision ${decisionId} is about request ${decision.requestId}; a command on its authority names that request`);
  }
  if (declared.length > 0) {
    const refusal = grantRefusal(decision, declared, context.now.toISOString());
    if (refusal !== null) refuse(`${refusal.message}; ask the owner again with bm_ask_owner`);
    if (grantsInFlight.has(decisionId)) refuse(`the grant of decision ${decisionId} is being used by another command`);
  }
  return decision;
}

/**
 * Who lets the Orchestrator send, and which of the declared effects that
 * covers (autonomy design §A.7, replacing the gate as the authority):
 *
 * - `decisionId`: an Orchestrator decision the owner answered
 *   (`answeredDecisionOf`) — authority `decision:<id>`, covering any effect
 *   its grant covers; the grant is spent on delivery. It needs neither
 *   Autopilot nor the owner's word in the chat; `via` says which of the two
 *   paths it left by (`autopilot` when the project has Autopilot on, else
 *   `chat`, where the answer reached the Orchestrator).
 * - else the project's Autopilot (`autopilot`), else the owner's own latest
 *   word in the Orchestrator's chat (`owner`, `via: chat`), else a refusal with
 *   `refusal`. Either covers every effect except `DECISION_ONLY_EFFECTS`.
 */
async function authorityOf(
  input: { workspaceId: string; requestId: string | null; decisionId?: string; effects: readonly Effect[] },
  context: Context,
  refusal: string,
): Promise<CommandAuthorityOf> {
  const declared = realEffects(input.effects);
  const autopilot = context.store.isAutopilot(input.workspaceId);
  if (input.decisionId !== undefined) {
    answeredDecisionOf(input.decisionId, input.workspaceId, input.requestId, declared, context);
    return {
      via: autopilot ? "autopilot" : "chat",
      authority: decisionAuthorityOf(input.decisionId),
      approved: declared,
      grantOf: declared.length > 0 ? input.decisionId : null,
    };
  }
  const via = autopilot ? "autopilot" : (await ownerJustSpoke(context.paseo)) ? "chat" : refuse(refusal);
  const needsDecision = declared.filter((effect) => DECISION_ONLY_EFFECTS.includes(effect));
  if (needsDecision.length > 0) refuse(needsDecisionMessageOf(needsDecision));
  return { via, authority: via === "autopilot" ? "autopilot" : "owner", approved: declared, grantOf: null };
}

/**
 * Marks the grant `decisionId` as being spent, refusing when another call
 * already is; returns what gives it back when the command is not delivered.
 * Synchronous, so no other call can come between the check and the mark.
 */
export function claimGrant(decisionId: string | null): () => void {
  if (decisionId === null) return () => {};
  if (grantsInFlight.has(decisionId)) refuse(`the grant of decision ${decisionId} is being used by another command`);
  grantsInFlight.add(decisionId);
  return () => grantsInFlight.delete(decisionId);
}

/**
 * Spends the grant of `decisionId` on a delivered command (`useGrant`,
 * one use); null when done, else what went wrong. A grant that could not be
 * marked used stays claimed in this run of the plugin, so it is not spent twice.
 */
export function spendGrant(
  decisionId: string | null,
  workspaceId: string,
  effects: readonly Effect[],
  context: Pick<Context, "home" | "now">,
): string | null {
  if (decisionId === null) return null;
  let problem: string;
  try {
    const result = createDecisionStore(context.home).transition(
      decisionId,
      (decision) => useGrant(decision, { effects, at: context.now.toISOString() }),
      workspaceId,
    );
    if (result.status === "updated") {
      grantsInFlight.delete(decisionId);
      return null;
    }
    problem = result.status === "refused" ? result.message : `decision ${decisionId} is gone`;
  } catch (error) {
    problem = describeError(error);
  }
  return `The plugin could not mark the grant of decision ${decisionId} as used (${problem}); do not use it again.`;
}

/**
 * The block a command of the Orchestrator is sent as, after the checks every
 * one of them passes before anything leaves (design §6B.1, §6A; autonomy
 * design §A.7): the block can be written, the backstop finds no category in
 * `re:` and the body (never the header) that the declared effects do not
 * cover — less the categories the owner allowed for the project and `exempt`
 * (a stop of a Worker's open danger, `bm_direct_worker`), both only until
 * Phase 2 — and the loop guard has room. Refuses otherwise; sends nothing.
 */
function checkedCommand(input: CommandInput, workspaceId: string, context: Context, exempt: readonly GateCategory[] = []): string {
  const problems = commandInputProblems(input);
  if (problems.length > 0) refuse(`the command cannot be sent as a BM-COMMAND block: ${problems.join("; ")}`);
  const undeclared = undeclaredCategoriesOf(`${input.re}\n${input.body}`, input.effects ?? [], [...context.store.allowedCategories(workspaceId), ...exempt]);
  if (undeclared.length > 0) refuse(undeclaredRefusalOf(undeclared));
  // The loop guard: an Orchestrator and a Manager answering each other stop here, before anything is sent.
  const sent = commandsSentFor(context.store.listCommands(), workspaceId, input.requestId ?? null, context.now);
  if (sent >= COMMAND_LIMIT_PER_REQUEST) refuse(COMMAND_LIMIT_MESSAGE);
  return commandBlockOf(input);
}

/** What a command of the Orchestrator declares (autonomy design §A.7). */
interface Declared {
  intent: CommandIntent;
  effects: Effect[];
  /** An Orchestrator decision the owner answered, whose grant covers this command. */
  decisionId?: string;
}

interface SendInput extends Declared {
  workspaceId: string;
  managerId: string;
  requestId?: string;
  re?: string;
  command: string;
  reason: string;
}

/** What the tool's JSON says about the authority a command went on. */
function authorityFields(granted: CommandAuthorityOf) {
  return { authority: granted.authority, approved: granted.approved };
}

/**
 * `bm_send_command` (design §6A, §6B.1; autonomy design §A.7): checks the
 * Manager, then the authority and what it covers (`authorityOf`), then the
 * block, the backstop and the loop guard (`checkedCommand`), and only then
 * delivers the `BM-COMMAND` block through the notice queue, spending the
 * decision's grant once it is delivered. Its `re:` is the one given, else the
 * command's first line. The command is recorded after delivery (`situation`
 * the `re:`, `command` the body, `reason` the `why:`); a Manager that cannot
 * be reached records and spends nothing.
 */
async function bmSendCommand(input: SendInput, context: Context, deps: OrchestratorToolsDeps): Promise<ServerToolResult> {
  const manager = await requireManager(input, context);
  const requestId = input.requestId ?? null;
  const granted = await authorityOf({ ...input, requestId }, context, SEND_REFUSED_MESSAGE);
  const source = granted.via;
  const command: CommandInput = {
    from: "orchestrator",
    via: source,
    to: "manager",
    requestId,
    re: commandSubjectOf(input.re ?? "") || commandSubjectOf(input.command),
    body: input.command,
    why: input.reason,
    intent: input.intent,
    effects: input.effects,
    authority: granted.authority,
    approved: granted.approved,
  };
  const text = checkedCommand(command, input.workspaceId, context);
  const id = (deps.store?.newId ?? randomUUID)();
  const release = claimGrant(granted.grantOf);
  let outcome: Awaited<ReturnType<NoticeQueue["enqueue"]>>;
  try {
    outcome = await (deps.queue ?? noticeQueue).enqueue(manager.id, commandKindOf(id), text, context.paseo as unknown as NoticePaseo);
  } catch (error) {
    release();
    throw error;
  }
  if (outcome !== "sent" && outcome !== "queued") {
    release();
    refuse(`Manager ${manager.id} could not be reached; nothing was sent`);
  }
  const spent = spendGrant(granted.grantOf, input.workspaceId, granted.approved, context);

  const said = [
    outcome === "sent"
      ? "Sent. The Manager reads it as a BM-COMMAND block: the owner's word through you, with its authority and the limits that remain."
      : "Queued. The Manager is busy and gets it, as a BM-COMMAND block with its authority and the limits that remain, when its current turn ends.",
    ...(spent === null ? [] : [spent]),
  ].join(" ");
  try {
    createOrchestratorStore(context.home, { ...deps.store, newId: () => id }).appendCommand({
      workspaceId: input.workspaceId,
      managerId: manager.id,
      requestId,
      situation: command.re,
      command: input.command.trim(),
      reason: input.reason.trim(),
      source,
      sentText: text,
      outcome,
    });
  } catch (error) {
    // Delivered already: say so, so the Orchestrator does not send it again.
    return { ok: true, text: `${said} The plugin could not record it (${describeError(error)}); do not send it again, and tell the owner in one line.` };
  }
  return { ok: true, text: `${said} Tell the owner in one line what you sent and why.\n${json({ commandId: id, outcome, source, ...authorityFields(granted) })}` };
}

interface DirectInput extends Declared {
  workspaceId: string;
  workerId: string;
  requestId?: string;
  re: string;
  command: string;
  why?: string;
  interrupt?: boolean;
}

/**
 * `bm_direct_worker` (design §6B.4, ADR-016 decision 2): a command to a
 * non-archived paseo-bm Worker of the project — never a Reviewer — under the
 * authority of `bm_send_command` (`authorityOf`: declared effects, a grant
 * spent once delivered), through the same block, backstop and loop guard.
 * Delivered as `BM-COMMAND to: worker` through the notice queue (at the
 * Worker's turn end), or with `interrupt: true` — allowed only while that
 * Worker's interrupt allowance is open (`isDangerOpen`) — sent at once, which
 * replaces its running turn. Once the Worker has it, its Manager (the agent
 * that created it, when that is a non-archived paseo-bm Manager of the
 * project) gets the same block with `copy: yes` through the queue. Recorded
 * `sent` with `to: "worker"`, `workerId`, and the Manager that got the copy as
 * `managerId` (null when the Worker has none). Every refusal comes before
 * anything is sent. While that Worker's danger allowance is open, a command
 * with a stop word (`isStopCommand`) is not checked for `release` or `data`
 * (`DANGER_STOP_CATEGORIES`, design §6B.5): the stop of a push has to name
 * the push (coordination run 2026-09-29, F2). Any other command, and any
 * command to another Worker, is checked as before.
 */
async function bmDirectWorker(input: DirectInput, context: Context, deps: OrchestratorToolsDeps): Promise<ServerToolResult> {
  const agents = await workingAgents(context.paseo);
  const worker = agents.find((candidate) => candidate.id === input.workerId);
  if (worker === undefined || worker.role !== "worker") {
    refuse(`${input.workerId} is not a paseo-bm Worker; use a Worker's id from bm_request (a Reviewer is never commanded directly)`);
  }
  if (worker.workspaceId !== input.workspaceId) refuse(`Worker ${input.workerId} does not belong to project ${input.workspaceId}`);
  if (worker.archived) refuse(`Worker ${input.workerId} is archived; nothing can be sent to it`);
  const requestId = input.requestId ?? null;
  const granted = await authorityOf({ ...input, requestId }, context, DIRECT_REFUSED_MESSAGE);
  const source = granted.via;
  const manager =
    agents.find(
      (candidate) =>
        candidate.id === worker.parentAgentId && candidate.role === "manager" && !candidate.archived && candidate.workspaceId === input.workspaceId,
    ) ?? null;
  const command: CommandInput = {
    from: "orchestrator",
    via: source,
    to: "worker",
    requestId,
    re: input.re,
    body: input.command,
    why: input.why ?? null,
    intent: input.intent,
    effects: input.effects,
    authority: granted.authority,
    approved: granted.approved,
  };
  const dangerOpen = context.store.isDangerOpen(input.workspaceId, worker.id);
  const exempt = dangerOpen && isStopCommand(`${command.re}\n${command.body}`) ? DANGER_STOP_CATEGORIES : [];
  const text = checkedCommand(command, input.workspaceId, context, exempt);
  const interrupt = input.interrupt === true;
  if (interrupt && !dangerOpen) refuse(INTERRUPT_REFUSED_MESSAGE);

  const id = (deps.store?.newId ?? randomUUID)();
  const queue = deps.queue ?? noticeQueue;
  const paseo = context.paseo as unknown as NoticePaseo;
  let outcome: "sent" | "queued";
  const release = claimGrant(granted.grantOf);
  try {
    if (interrupt) {
      // The one send that replaces a running turn: the danger allowance is open (ADR-016 decision 2).
      try {
        await paseo.agents.ref(worker.id).send(text);
      } catch (error) {
        refuse(`Worker ${worker.id} could not be reached (${describeError(error)}); nothing was sent`);
      }
      outcome = "sent";
    } else {
      const queued = await queue.enqueue(worker.id, commandKindOf(id), text, paseo);
      if (queued !== "sent" && queued !== "queued") refuse(`Worker ${worker.id} could not be reached; nothing was sent`);
      outcome = queued;
    }
  } catch (error) {
    release();
    throw error;
  }
  const spent = spendGrant(granted.grantOf, input.workspaceId, granted.approved, context);
  // The copy keeps one line of command the Manager can see (ADR-016 decision 2).
  const copy = manager === null ? null : await queue.enqueue(manager.id, commandKindOf(id), commandBlockOf({ ...command, copy: true }), paseo);
  const copied = copy === "sent" || copy === "queued";

  const said = [
    interrupt
      ? "Sent at once: the Worker's running turn was replaced by your command."
      : outcome === "sent"
        ? "Sent. The Worker reads it as a BM-COMMAND block: the owner's word through you, with its authority and the limits that remain."
        : "Queued. The Worker is busy and gets it, as a BM-COMMAND block with its authority and the limits that remain, when its current turn ends.",
    manager === null
      ? "The Worker has no paseo-bm Manager, so no copy was sent."
      : copied
        ? `Its Manager ${manager.id} gets a copy${copy === "queued" ? " when its current turn ends" : ""}.`
        : `The copy to its Manager ${manager.id} could not be delivered; tell the owner.`,
    ...(spent === null ? [] : [spent]),
  ].join(" ");
  try {
    const stored = commandOf(command);
    createOrchestratorStore(context.home, { ...deps.store, newId: () => id }).appendCommand({
      workspaceId: input.workspaceId,
      managerId: manager?.id ?? null,
      requestId,
      situation: stored.re,
      command: stored.body,
      reason: stored.why ?? "",
      source,
      to: "worker",
      workerId: worker.id,
      sentText: text,
      outcome,
    });
  } catch (error) {
    return { ok: true, text: `${said} The plugin could not record it (${describeError(error)}); do not send it again, and tell the owner in one line.` };
  }
  return {
    ok: true,
    text: `${said} Tell the owner in one line what you told the Worker and why.\n${json({
      commandId: id,
      outcome,
      interrupted: interrupt,
      managerId: manager?.id ?? null,
      copy: manager === null ? null : copied ? copy : "failed",
      source,
      ...authorityFields(granted),
    })}`,
  };
}

interface AskOwnerOption {
  label: string;
  effects: Effect[];
  recommended?: boolean;
  command?: { to: CommandTo; agentId: string; intent: CommandIntent; body: string };
}

interface AskOwnerInput {
  workspaceId: string;
  managerId?: string;
  requestId?: string;
  question: string;
  recommendation: string;
  options?: AskOwnerOption[];
  subject?: string;
  separate?: boolean;
}

/** The keys of `bm_ask_owner`'s options, by position. */
export const ASK_OWNER_OPTION_KEYS: readonly string[] = ["a", "b", "c", "d", "e"];

/** The question a decision of the Orchestrator stores: the question, then its recommendation. */
export function askedQuestionOf(question: string, recommendation: string): string {
  return `${question.trim()}\n\nRecommendation: ${recommendation.trim()}`;
}

/**
 * The `why:` line of a prepared command, which the plugin writes when the
 * owner picks its option (`orchestrator-decisions.ts`).
 */
export function preparedWhyOf(label: string, decisionId: string): string {
  return `The owner chose "${label.replace(/\s+/g, " ").trim()}" on decision ${decisionId}.`;
}

/**
 * The `BM-COMMAND` a prepared command becomes when its option is picked
 * (autonomy design §A.6): from the Orchestrator, which prepared it, via the
 * owner's tap on the option (`via: tab`), on the authority of the decision, with `approved` the
 * option's effects the answer granted — so no limit contradicts them.
 */
export function preparedCommandOf(
  decision: Pick<Decision, "id" | "requestId">,
  option: Pick<DecisionOption, "label">,
  action: { to: CommandTo; intent: CommandIntent; body: string; effects: readonly Effect[] },
  approved: readonly Effect[],
): CommandInput {
  return {
    from: "orchestrator",
    via: "tab",
    to: action.to,
    requestId: commandRequestIdOf(decision.requestId),
    re: commandSubjectOf(option.label) || commandSubjectOf(action.body),
    body: action.body,
    why: preparedWhyOf(option.label, decision.id),
    intent: action.intent,
    effects: realEffects(action.effects),
    authority: decisionAuthorityOf(decision.id),
    approved: realEffects(approved),
  };
}

/**
 * The open decision of the Orchestrator's that a new one about `requestId`
 * replaces (autonomy design §A.3): an unsettled `o:` decision of the project
 * about the same request (or both about the whole project) — the newest of
 * the same `subject` when there is one, else the newest.
 */
function replacedByAsk(workspaceId: string, requestId: string | null, subject: string | null, home: string): Decision | null {
  const open = createDecisionStore(home)
    .list({ workspaceId, statuses: UNSETTLED_STATUSES })
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => decisionKindOf(decision.id) === "orchestrator" && decision.requestId === requestId)
    .sort((a, b) => timeOf(b.decision.askedAt) - timeOf(a.decision.askedAt) || b.index - a.index)
    .map(({ decision }) => decision);
  return (subject === null ? undefined : open.find((decision) => decision.subject === subject)) ?? open[0] ?? null;
}

/** The Orchestrator agent's id, or null when it cannot be found. */
async function orchestratorIdOf(paseo: OrchestratorToolsPaseo): Promise<string | null> {
  try {
    return (await findOrchestratorAgent(paseo as unknown as OrchestratorAgentPaseo))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * `bm_ask_owner` (design §6A, §6B.4; autonomy design §A.3, §A.6): stores an
 * open `o:` decision for the owner and sends nothing. Each option carries its
 * declared effects and, optionally, a prepared command to a Manager or a
 * Worker of the project, checked now as it will be sent: a live paseo-bm
 * agent of that role in the project, a block that can be written, and no
 * category of the backstop in its text that the option's effects do not
 * declare. It replaces the Orchestrator's open decision of the same request
 * unless `separate: true`, and the answer names the id it replaced — only
 * when the store did replace one.
 */
async function bmAskOwner(input: AskOwnerInput, context: Context, deps: OrchestratorToolsDeps): Promise<ServerToolResult> {
  if (input.managerId !== undefined) await requireManager({ workspaceId: input.workspaceId, managerId: input.managerId }, context);
  else await requireProject(input.workspaceId, context);
  const requestId = input.requestId ?? null;
  const id = `o:${(deps.newId ?? randomUUID)()}`;
  const given = input.options ?? [];
  const question = askedQuestionOf(input.question, input.recommendation);

  const problems: string[] = [];
  if (question.length > MAX_DECISION_TEXT_CHARS) {
    problems.push(`input.question: with the recommendation it must be at most ${MAX_DECISION_TEXT_CHARS - askedQuestionOf("", "").length} characters in all`);
  }
  if (given.filter((option) => option.recommended === true).length > 1) problems.push("input.options: at most one option is recommended");
  const agents = given.some((option) => option.command !== undefined) ? await workingAgents(context.paseo) : [];
  const allowed = context.store.allowedCategories(input.workspaceId);
  const options: DecisionOption[] = given.map((option, index) => {
    const key = ASK_OWNER_OPTION_KEYS[index]!;
    const label = option.label.replace(/\s+/g, " ").trim();
    const effects = realEffects(option.effects).length === 0 ? (["none"] as Effect[]) : realEffects(option.effects);
    const entry: DecisionOption = { key, label, recommended: option.recommended === true, effects };
    const command = option.command;
    if (command === undefined) return entry;
    const at = `input.options[${index}].command`;
    const role = command.to === "manager" ? "Manager" : "Worker";
    const target = agents.find((agent) => agent.id === command.agentId);
    if (target === undefined || target.role !== command.to) problems.push(`${at}.agentId: ${command.agentId} is not a paseo-bm ${role}; use an id bm_projects or bm_request gave`);
    else if (target.workspaceId !== input.workspaceId) problems.push(`${at}.agentId: ${role} ${command.agentId} does not belong to project ${input.workspaceId}`);
    else if (target.archived) problems.push(`${at}.agentId: ${role} ${command.agentId} is archived; nothing can be sent to it`);
    const action = { to: command.to, intent: command.intent, body: command.body, effects };
    const block = preparedCommandOf({ id, requestId }, { label }, action, effects);
    problems.push(...commandInputProblems(block).map((problem) => `${at}: ${problem}`));
    const undeclared = undeclaredCategoriesOf(`${block.re}\n${block.body}`, effects, allowed);
    if (undeclared.length > 0) {
      problems.push(`${at}: the text shows ${undeclared.join(", ")} that the option's effects do not declare; declare the effect on the option`);
    }
    return { ...entry, action: { kind: "command", agentId: command.agentId, ...action, body: command.body.trim() } };
  });
  if (problems.length > 0) return { ok: false, text: fixThese("bm_ask_owner", problems) };

  const replaced = input.separate === true ? null : replacedByAsk(input.workspaceId, requestId, input.subject ?? null, context.home);
  const decision: Decision = {
    id,
    workspaceId: input.workspaceId,
    requestId,
    askedBy: { role: "orchestrator", agentId: await orchestratorIdOf(context.paseo) },
    askedAt: context.now.toISOString(),
    round: null,
    question,
    subject: input.subject ?? null,
    options,
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: replaced?.id ?? null,
    supersededBy: null,
  };
  const stored = createDecisionStore(context.home).open(decision);
  const replacedId = stored.superseded?.id ?? null;
  const prepared = options.filter((option) => option.action !== undefined).length;
  const said = [
    `Asked. The owner answers it in paseo-bm${options.length === 0 ? "" : ", with one button per option"}; nothing was sent to any agent.`,
    replacedId === null ? null : `It replaced your open question ${replacedId} of this ${requestId === null ? "project" : "request"}, which can no longer be answered.`,
    prepared === 0 ? null : "When the owner picks an option with a command, the plugin delivers that command itself, with the owner's authority.",
    "An answer in the owner's own words comes back to you as a BM-ANSWER notice. Tell the owner in one line here too.",
  ]
    .filter((line): line is string => line !== null)
    .join(" ");
  return { ok: true, text: `${said}\n${json({ decisionId: stored.decision.id, replaced: replacedId })}` };
}

/** `bm_decisions` (autonomy design §A.9): the stored decisions, newest asked first, with their grants; read-only. */
function bmDecisions(input: DecisionsQuery, context: Context): ServerToolResult {
  return { ok: true, text: decisionsText(context.home, input, context.env, { grant: true }) };
}

// ---------------------------------------------------------------------------
// bm_repo (design §6B.4): read-only git, inside the project's folder.
// ---------------------------------------------------------------------------

interface RepoInput {
  workspaceId: string;
  action: RepoAction;
  path?: string;
  file?: string;
}

/** The environment git runs in: no prompt, no optional lock, no lazy fetch, and no repository named by the plugin's own environment. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) {
    delete env[name];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", PAGER: "cat" };
}

/** The default `GitRunner`: `execFile("git", args)`, no shell, 10-second timeout, output capped at `maxBytes`. */
export const runGit: GitRunner = (args, { cwd, maxBytes }) =>
  new Promise((done, fail) => {
    execFile(
      "git",
      [...args],
      { cwd, env: gitEnv(), timeout: REPO_TIMEOUT_MS, maxBuffer: maxBytes, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) done({ stdout });
        else fail(Object.assign(error, { stderr }));
      },
    );
  });

/** True when `candidate` is `root` or lies below it. */
function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real path of `path`, or a refusal saying what `what` is. */
function realOf(path: string, what: string): string {
  try {
    return realpathSync(path);
  } catch {
    return refuse(`${what} does not exist`);
  }
}

/** Why a git command failed, in one line, redacted. */
function gitFailure(error: unknown, command: string, env: NodeJS.ProcessEnv): string {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string };
  if (failure.code === "ENOENT") return "git is not installed on this machine";
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `the output of git ${command} is larger than ${REPO_FILE_MAX_BYTES / 1024} KB`;
  if (failure.killed === true || typeof failure.signal === "string") return `git ${command} took longer than ${REPO_TIMEOUT_MS / 1000} seconds`;
  const said = firstLine(typeof failure.stderr === "string" ? failure.stderr : "", env) ?? firstLine(describeError(error), env) ?? "no reason given";
  return `git ${command} failed: ${said}`;
}

/**
 * `bm_repo` (design §6B.4): one fixed read-only git command in the project's
 * folder — or a folder inside it, `path` — or one file read. The folder is the
 * one Paseo lists for the workspace (else the one the trace store last saw);
 * `path` and `file` are resolved through symlinks and refused when they leave
 * it or reach into `.git`. A file whose name marks it as a secret (`.env`, a
 * key, a credential store) is never read, nor a working-tree file git
 * ignores. Output is redacted and capped at 20,000 characters; a file or
 * output above 200 KB is refused. Nothing is written: `status` runs with
 * `GIT_OPTIONAL_LOCKS=0`, and no command fetches, pushes or runs a hook.
 */
async function bmRepo(input: RepoInput, context: Context, deps: OrchestratorToolsDeps): Promise<ServerToolResult> {
  await requireProject(input.workspaceId, context);
  const listed = await listedWorkspaces(context.paseo);
  const directory =
    listed?.find((entry) => entry.id === input.workspaceId)?.directory ?? readWorkspaceMeta(context.location, input.workspaceId)?.lastKnownDirectory ?? null;
  if (directory === null) refuse(`the folder of project ${input.workspaceId} is not known`);
  const root = realOf(directory, `the project's folder ${directory}`);
  const cwd = input.path === undefined ? root : realOf(resolve(root, input.path), `${input.path} (in the project's folder)`);
  if (!within(root, cwd)) refuse(`${input.path} is outside the project's folder`);
  if (!statSync(cwd).isDirectory()) refuse(`${input.path} is not a folder`);
  if (relative(root, cwd).split(sep).includes(".git")) refuse("the .git folder is not readable with bm_repo");
  const git = deps.git ?? runGit;
  const where = relative(root, cwd) || ".";

  const run = async (args: readonly string[], maxBytes = REPO_FILE_MAX_BYTES): Promise<string> => {
    try {
      return (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd, maxBytes })).stdout;
    } catch (error) {
      return refuse(gitFailure(error, args[0] ?? "", context.env));
    }
  };

  let title: string;
  let output: string;
  switch (input.action) {
    case "status":
      title = "git status --short --branch";
      output = await run(["status", "--short", "--branch"]);
      break;
    case "diff-stat": {
      title = "git diff --stat, then git diff --cached --stat";
      const unstaged = await run(["diff", "--stat", "--no-ext-diff", "--no-textconv"]);
      const staged = await run(["diff", "--cached", "--stat", "--no-ext-diff", "--no-textconv"]);
      output = `Not staged:\n${unstaged.trimEnd() || "(nothing)"}\n\nStaged:\n${staged.trimEnd() || "(nothing)"}`;
      break;
    }
    case "log":
      title = "git log --oneline -20";
      output = await run(["log", "--oneline", "-20", "--no-decorate"]);
      break;
    default: {
      if (input.file === undefined) refuse("show needs file: a path relative to the folder, or HEAD:<path> for its committed version");
      const committed = input.file.startsWith("HEAD:");
      const name = committed ? input.file.slice("HEAD:".length) : input.file;
      if (name === "" || isAbsolute(name)) refuse("file must be a path relative to the folder");
      const target = resolve(cwd, name);
      if (!within(root, target)) refuse(`${input.file} is outside the project's folder`);
      const refuseSecret = (path: string): void => {
        if (relative(root, path).split(sep).includes(".git")) refuse("the .git folder is not readable with bm_repo");
        if (SECRET_FILE_NAME.test(basename(path))) refuse(`${input.file} may hold secrets; bm_repo does not read it`);
      };
      refuseSecret(target);
      const relativeName = relative(cwd, target).split(sep).join("/");
      if (committed) {
        title = `git show HEAD:./${relativeName}`;
        output = await run(["show", "--no-textconv", `HEAD:./${relativeName}`]);
        break;
      }
      const real = realOf(target, input.file);
      if (!within(root, real)) refuse(`${input.file} leads outside the project's folder`);
      refuseSecret(real);
      const stat = statSync(real);
      if (!stat.isFile()) refuse(`${input.file} is not a file`);
      if (stat.size > REPO_FILE_MAX_BYTES) refuse(`${input.file} is larger than ${REPO_FILE_MAX_BYTES / 1024} KB`);
      // A file git ignores is often local configuration or data: not read (exit 0 = ignored, 1 = not).
      const ignored = await git([...GIT_READ_ONLY_PREFIX, "check-ignore", "-q", "--", relative(cwd, real)], { cwd, maxBytes: 64 * 1024 }).then(
        () => true,
        (error: unknown) => ((error as { code?: unknown }).code === 1 ? false : refuse(gitFailure(error, "check-ignore", context.env))),
      );
      if (ignored) refuse(`${input.file} is ignored by git; bm_repo reads only files git tracks or would track`);
      const content = readFileSync(real, "utf8");
      if (content.includes("\u0000")) refuse(`${input.file} is not a text file`);
      title = `${relativeName} (as it is now)`;
      output = content;
      break;
    }
  }
  const safe = redactText(output, context.env);
  const text = cutText(safe.trimEnd() === "" ? "(no output)" : safe.trimEnd(), REPO_OUTPUT_MAX_CHARS);
  return { ok: true, text: `${title} — in ${where} of project ${input.workspaceId}\n\n${text}` };
}

/** `bm_note` (design §6B.4): one note about a project, kept for later Orchestrators too; sends nothing. */
async function bmNote(input: { workspaceId: string; text: string; replace?: boolean }, context: Context): Promise<ServerToolResult> {
  await requireProject(input.workspaceId, context);
  const notes = context.store.appendNote(input.workspaceId, input.text, { replace: input.replace === true });
  return {
    ok: true,
    text: `Noted. bm_projects returns this project's notes, also to a new Orchestrator.\n${json({ workspaceId: input.workspaceId, notes: notes.length, replaced: input.replace === true })}`,
  };
}

/** `bm_set_autopilot` (design §6A): the owner's own latest message in the chat, or a refusal; sends nothing. */
async function bmSetAutopilot(input: { workspaceId: string; enabled: boolean }, context: Context): Promise<ServerToolResult> {
  await requireProject(input.workspaceId, context);
  if (!(await ownerJustSpoke(context.paseo))) refuse(SET_AUTOPILOT_REFUSED_MESSAGE);
  context.store.setAutopilot(input.workspaceId, input.enabled, "chat");
  const said = input.enabled
    ? "Autopilot is on for this project: you answer its questions and tell its Manager what to do next, and ask the owner on big decisions. Look at its open requests now with bm_projects; from now on its events reach you in BM-EVENTS."
    : "Autopilot is off for this project: ask the owner with bm_ask_owner before you send, unless the owner tells you to send.";
  return { ok: true, text: `${said} Tell the owner in one line.\n${json({ workspaceId: input.workspaceId, autopilot: input.enabled })}` };
}

/** The requests a workflow assessment recorded without a pending line covers: the newest of the last 7 days. */
function recentRequestIds(location: TraceStoreLocation, workspaceId: string, now: Date): string[] {
  const since = now.getTime() - WORKFLOW_SCOPE_DAYS * 86_400_000;
  const newest = new Map<string, number>();
  for (const record of readRecords(location, workspaceId).records) {
    const time = timeOf(record.endedAt);
    if (record.requestId === null || time < since) continue;
    newest.set(record.requestId, Math.max(time, newest.get(record.requestId) ?? 0));
  }
  return [...newest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, WORKFLOW_SCOPE_LIMIT)
    .map(([requestId]) => requestId);
}

/** Records an assessment the pure `bm_assessment` tool already accepted. */
function bmAssessment(input: unknown, context: Context, newId: () => string): ServerToolResult {
  const { workspaceId, ...assessment } = input as { workspaceId: string } & Record<string, unknown>;
  const result = assessmentResultSchema.parse(assessment);
  const pending = context.store
    .readAssessments(workspaceId)
    .find((line) => line.traceId === WORKFLOW_ASSESSMENT_TRACE_ID && line.status === "pending");
  if (pending === undefined && !storedWorkspaceIds(context.location).includes(workspaceId)) {
    refuse(`no paseo-bm project ${workspaceId}; use the workspaceId bm_projects gave`);
  }
  const at = context.now.toISOString();
  const line: AssessmentLine =
    pending !== undefined
      ? { ...pending, at, status: "done", result }
      : {
          v: 1,
          assessmentId: newId(),
          requestId: null,
          traceId: WORKFLOW_ASSESSMENT_TRACE_ID,
          agentId: null,
          at,
          status: "done",
          provider: ORCHESTRATOR_PROVIDER_ID,
          model: null,
          result,
          scope: { requestIds: recentRequestIds(context.location, workspaceId, context.now) },
        };
  const stored = context.store.appendAssessment(workspaceId, line);
  return {
    ok: true,
    text: `Recorded. Tell the owner the result in one line.\n${json({ assessmentId: stored.assessmentId, attached: pending !== undefined })}`,
  };
}

function fixThese(name: string, issues: readonly string[]): string {
  return `The call was refused. Fix these and call ${name} again:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}

// ---------------------------------------------------------------------------

/** Creates the Orchestrator's tools. The handle comes later, through `usePaseo`. */
export function createOrchestratorTools(deps: OrchestratorToolsDeps = {}): OrchestratorTools {
  const faces: readonly ToolFace[] = [...ORCHESTRATOR_SERVER_TOOLS, toolNamed("bm_assessment")!];
  const names = new Set(faces.map((face) => face.name));
  let paseo: OrchestratorToolsPaseo | null = null;

  const contextOf = (): Context => {
    if (paseo === null) refuse("paseo-bm has no connection to Paseo yet; try again in a moment");
    let resolution: ReturnType<typeof resolveDataHome>;
    try {
      resolution = resolveDataHome(deps);
    } catch (error) {
      refuse(`the paseo-bm data folder cannot be used: ${describeError(error)}`);
    }
    if (resolution.home === null) refuse(`the paseo-bm data folder cannot be used: ${resolution.reason}`);
    return {
      paseo,
      home: resolution.home,
      location: { tracesDir: resolution.tracesDir },
      store: createOrchestratorStore(resolution.home, deps.store),
      now: (deps.now ?? (() => new Date()))(),
      env: deps.redactEnv ?? process.env,
    };
  };

  const run = async (name: string, input: unknown): Promise<ServerToolResult> => {
    const face = faces.find((candidate) => candidate.name === name)!;
    // `bm_assessment` checks its own input, with the rubric rule the schema cannot say.
    const checked = name === "bm_assessment" ? toolNamed(name)!.run(input) : null;
    const issues = checked === null ? schemaIssues(face.inputSchema, input) : checked.ok ? [] : checked.issues;
    if (issues.length > 0) return { ok: false, text: fixThese(name, issues) };
    const context = contextOf();
    switch (name) {
      case "bm_projects":
        return { ok: true, text: await bmProjects(input as { sinceHours?: number; detail?: ReadDetail }, context) };
      case "bm_request":
        return { ok: true, text: await bmRequest(input as { workspaceId: string; requestId: string; detail?: ReadDetail }, context, deps) };
      case "bm_agent_messages":
        return { ok: true, text: await bmAgentMessages(input as { agentId: string; limit?: number; detail?: ReadDetail }, context) };
      case "bm_send_command":
        return bmSendCommand(input as SendInput, context, deps);
      case "bm_decisions":
        return bmDecisions(input as DecisionsQuery, context);
      case "bm_ask_owner":
        return bmAskOwner(input as AskOwnerInput, context, deps);
      case "bm_set_autopilot":
        return bmSetAutopilot(input as { workspaceId: string; enabled: boolean }, context);
      case "bm_direct_worker":
        return bmDirectWorker(input as DirectInput, context, deps);
      case "bm_repo":
        return bmRepo(input as RepoInput, context, deps);
      case "bm_note":
        return bmNote(input as { workspaceId: string; text: string; replace?: boolean }, context);
      default:
        return bmAssessment(input, context, deps.newId ?? randomUUID);
    }
  };

  return {
    faces,
    has: (name) => names.has(name),
    usePaseo(value) {
      if (isPaseo(value)) paseo = value;
    },
    async call(name, input) {
      if (!names.has(name)) return { ok: false, text: `Unknown tool: ${name}` };
      try {
        return await run(name, input);
      } catch (error) {
        if (error instanceof Refusal) return { ok: false, text: `Refused: ${error.message}.` };
        if (error instanceof DashboardError) return { ok: false, text: `Refused: ${error.message}.` };
        return { ok: false, text: `The tool failed: ${describeError(error)}. Try again later, or tell the user.` };
      }
    },
  };
}
