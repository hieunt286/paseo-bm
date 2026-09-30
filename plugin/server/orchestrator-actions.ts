/**
 * The Orchestrator's read and switch RPCs (Orchestrator design §6A, §8;
 * ADR-015): `orchestrator.state` and `orchestrator.set-autopilot`. Registered
 * from `registerOrchestratorRpcs` (`orchestrator-rpc.ts`).
 *
 * Nothing here sends to an agent. The owner talks to the Orchestrator in its
 * chat and decides in the Inbox (autonomy design §A.12): a command reaches a
 * Manager or a Worker only from the Orchestrator's own tools
 * (`orchestrator-tools.ts`) or as a decision's prepared action
 * (`orchestrator-decisions.ts`). `set-autopilot` writes a project's switch; it
 * sends nothing — the project's events reach the Orchestrator in `BM-EVENTS`
 * (`event-bus.ts`). Nothing here creates, stops or archives an agent, or
 * writes anything but the Orchestrator's own store.
 *
 * `state` reads without writing: one `agents.list` walk, one
 * `workspaces.list`, each workspace's trace store once (the store's own mtime
 * cache) and the Orchestrator's store.
 */
import { basename } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { assessmentResultSchema } from "../shared/bm-assessment";
import {
  DashboardError,
  orchestratorSetAutopilotRpc,
  orchestratorStateRpc,
  type OrchestratorProjectRow,
  type OrchestratorSetAutopilotInput,
  type OrchestratorSetAutopilotOutput,
  type OrchestratorStateOutput,
  type ProjectHealth,
  type ProjectStage,
  type ReportPhase,
} from "../shared/contracts";
import { WORKFLOW_ASSESSMENT_TRACE_ID, allowOf, type WorkerSignal } from "../shared/orchestrator";
import type { Alert, AlertKind } from "../shared/alerts";
import { MAX_COMMAND_RE_CHARS, commandInputProblems, parseCommandBlock, type CommandInput } from "../shared/orchestrator-command";
import { listAllAgents } from "./agent-role";
import { createAlertStore } from "./alert-store";
import { bmAgentsOf, listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./dashboard-rpc";
import { resolveDataHome, unusableDataHomeMessage, type DataHomeDeps } from "./data-home";
import type { NoticeAgentSnapshot } from "./notice-queue";
import {
  ORCHESTRATOR_MAIN_LABEL,
  ORCHESTRATOR_MAIN_VALUE,
  ORCHESTRATOR_ROLE_LABEL,
  ORCHESTRATOR_ROLE_VALUE,
  findOrchestratorAgent,
  isOutdatedOrchestrator,
  type OrchestratorAgentPaseo,
  type OrchestratorAgentSnapshot,
} from "./orchestrator-agent";
import { createOrchestratorStore, type OrchestratorStore } from "./orchestrator-store";
import { firstLine, lastActivityOf, requestKeyOf, waitingSinceOf } from "./orchestrator-tools";
import { workspaceTracesOf, type WorkspaceTraces } from "./request-trace";
import { readWorkspaceMeta, storedWorkspaceIds, type TraceStoreLocation } from "./trace-store";
import type { AgentFacts, ReconstructedTrace } from "./traces";

/** `projects` covers workspaces with activity in this many days (design §8). */
export const PROJECTS_SINCE_DAYS = 7;
/** At most this many projects (design §8). */
export const PROJECT_LIMIT = 30;
/** At most this many Workers, and as many Reviewers, per project in `agents` (design §6B.7). */
export const PROJECT_AGENTS_LIMIT = 10;

/** The notice-queue kind of a command: one per recorded command, so two commands never replace each other. */
export function commandKindOf(proposalId: string): string {
  return `command:${proposalId}`;
}

/**
 * The `re:` line of a command that brings none (design §6B.1): the first
 * non-empty line of `text`, whitespace collapsed, cut to 120 characters with
 * an ellipsis. Empty when `text` has no word.
 */
export function commandSubjectOf(text: string): string {
  const line = text.split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find((part) => part !== "") ?? "";
  if (line.length <= MAX_COMMAND_RE_CHARS) return line;
  let cut = "";
  // By code point, so a surrogate pair is never split; the ellipsis is one unit.
  for (const char of line) {
    if (cut.length + char.length > MAX_COMMAND_RE_CHARS - 1) break;
    cut += char;
  }
  return `${cut.trimEnd()}…`;
}

/** A request id the `requestId:` line can carry, or null (`none`) for one it cannot — a stored id is never refused over it. */
export function commandRequestIdOf(requestId: string | null | undefined): string | null {
  if (requestId === null || requestId === undefined) return null;
  const probe: CommandInput = { from: "owner", via: "tab", to: "manager", requestId, re: "x", body: "x" };
  return commandInputProblems(probe).length === 0 ? requestId : null;
}

/**
 * The SDK slice these handlers use; `PaseoApi` from a handler context is
 * structurally assignable.
 */
export interface OrchestratorActionsPaseo {
  agents: {
    list: DashboardPaseo["agents"]["list"];
    ref(agentId: string): {
      refresh(): Promise<{ agent?: NoticeAgentSnapshot | null } | null>;
      send(text: string): Promise<void>;
    };
  };
  workspaces: {
    list(options?: unknown): Promise<{ entries: Array<Record<string, unknown>> }>;
  };
}

export interface OrchestratorActionsDeps extends DataHomeDeps {
  now?: () => Date;
  /**
   * Whether the Orchestrator agent has lost its tools because the endpoint's
   * secret changed after it was created (design §5.1). The plugin passes
   * `toolsStaleSince(endpoint.secretSince)` (`agent-tools.ts`); false by
   * default. `orchestrator.open` reads it too, for `recreate`.
   */
  isToolsStale?: (agent: { id: string; createdAt: string | null }) => boolean;
  /** The environment whose secret values are redacted from a request's title in `state`; `process.env` by default. */
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timeOf(at: string | null | undefined): number {
  const time = at === null || at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(time) ? 0 : time;
}

// ---------------------------------------------------------------------------
// The data folder and the Orchestrator's store.
// ---------------------------------------------------------------------------

interface Opened {
  home: string;
  location: TraceStoreLocation;
  store: OrchestratorStore;
}

function openStore(deps: OrchestratorActionsDeps, what: string): Opened {
  const resolution = resolutionOf(deps);
  if (resolution?.home == null || resolution.tracesDir === null) {
    throw new DashboardError("E_DATA_HOME_UNAVAILABLE", `cannot ${what}: ${unusableDataHomeMessage(deps)}`);
  }
  return {
    home: resolution.home,
    location: { tracesDir: resolution.tracesDir },
    store: createOrchestratorStore(resolution.home, deps.now === undefined ? {} : { now: deps.now }),
  };
}

function resolutionOf(deps: DataHomeDeps): ReturnType<typeof resolveDataHome> | null {
  try {
    return resolveDataHome(deps);
  } catch {
    return null;
  }
}

/** Runs one store operation; a failure that is not already coded becomes `E_ORCHESTRATOR_WRITE_FAILED`. */
function inStore<T>(what: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof DashboardError) throw error;
    throw new DashboardError("E_ORCHESTRATOR_WRITE_FAILED", `cannot ${what}: ${describeError(error)}`, { cause: error });
  }
}

// ---------------------------------------------------------------------------
// The agents, listed once.
// ---------------------------------------------------------------------------

export interface AgentsSnapshot {
  /** Every paseo-bm Manager, Worker and Reviewer, archived ones included; never the Orchestrator. */
  bm: Array<{ workspaceId: string | null; facts: AgentFacts }>;
  /** The one Orchestrator agent, with what `agents.list` said about it. */
  orchestrator: (OrchestratorAgentSnapshot & { status: string; workspaceId: string | null; provider: string | null }) | null;
  /**
   * How many other non-archived agents carry the Orchestrator's labels: older
   * ones it replaced (design §3.3), left to the owner. 0 when there is no
   * Orchestrator.
   */
  previousOrchestrators?: number;
}

/**
 * One walk over every page of `agents.list`, read by both `bmAgentsOf` and
 * `findOrchestratorAgent` (which checks the Orchestrator's labels itself, so a
 * list that ignores its label filter is fine).
 */
export async function agentsOf(paseo: Pick<OrchestratorActionsPaseo, "agents">): Promise<AgentsSnapshot> {
  const raw = await listAllAgents(
    async (options) => {
      const result = await paseo.agents.list(options);
      // Entries are `{ agent }` on the SDK; older fakes hand the agent itself.
      return {
        entries: result.entries.map((entry) => ({ agent: (entry["agent"] ?? entry) as Record<string, unknown> })),
        ...(result.pageInfo === undefined ? {} : { pageInfo: result.pageInfo }),
      };
    },
    { includeArchived: true },
  );
  const listOnce = async () => ({ entries: raw.map((agent) => ({ agent })) });
  const snapshot = { agents: { list: listOnce } };
  const [bm, found] = await Promise.all([
    bmAgentsOf(snapshot as unknown as DashboardPaseo),
    findOrchestratorAgent(snapshot as unknown as OrchestratorAgentPaseo),
  ]);
  if (found === null) return { bm, orchestrator: null, previousOrchestrators: 0 };
  const listed = raw.find((agent) => agent["id"] === found.id) ?? {};
  const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  // `found` is the newest labelled agent, so every other one is older.
  const previousOrchestrators = raw.filter((agent) => {
    const labels = (agent["labels"] ?? {}) as Record<string, unknown>;
    return (
      agent["id"] !== found.id &&
      !agent["archivedAt"] &&
      labels[ORCHESTRATOR_ROLE_LABEL] === ORCHESTRATOR_ROLE_VALUE &&
      labels[ORCHESTRATOR_MAIN_LABEL] === ORCHESTRATOR_MAIN_VALUE
    );
  }).length;
  return {
    bm,
    previousOrchestrators,
    orchestrator: {
      ...found,
      status: text(listed["status"]) ?? "closed",
      workspaceId: text(listed["workspaceId"]),
      provider: text(listed["provider"]),
    },
  };
}

/** What a project is called: the name the trace store last saw, else its folder, else its id. */
export function workspaceLabelOf(workspaceId: string, listed: readonly ListedWorkspace[] | null, location: TraceStoreLocation | null): string {
  let name: string | null = null;
  try {
    name = location === null ? null : (readWorkspaceMeta(location, workspaceId)?.lastKnownName ?? null);
  } catch {
    name = null;
  }
  if (name !== null && name !== "") return name;
  const directory = listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
  return directory === null ? workspaceId : basename(directory);
}

// ---------------------------------------------------------------------------
// orchestrator.state
// ---------------------------------------------------------------------------

/** The newest workflow assessment of a workspace. */
function assessmentRowOf(store: OrchestratorStore, workspaceId: string): OrchestratorProjectRow["assessment"] {
  const line = store.readAssessments(workspaceId).find((candidate) => candidate.traceId === WORKFLOW_ASSESSMENT_TRACE_ID);
  if (line === undefined) return null;
  const parsed = line.status === "done" ? assessmentResultSchema.safeParse(line.result) : null;
  const result = parsed?.success === true ? parsed.data : null;
  const scores = result?.rubric.map((entry) => entry.score).filter((score): score is 1 | 2 | 3 | 4 | 5 => score !== null) ?? [];
  const average = scores.length === 0 ? null : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
  return {
    assessmentId: line.assessmentId,
    at: line.at,
    status: line.status,
    average,
    scores: result?.rubric ?? [],
    recommendations: result?.suggestions ?? [],
  };
}

/** The project's Manager: the one of its newest request when still there, else the newest non-archived one. */
function projectManagerOf(agents: ReadonlyMap<string, AgentFacts>, newestManagerId: string | null): AgentFacts | null {
  const managers = [...agents.values()].filter((agent) => agent.role === "manager" && !agent.archived);
  return (
    managers.find((agent) => agent.id === newestManagerId) ??
    managers.sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? 1 : -1))[0] ??
    null
  );
}

type ProjectAgents = NonNullable<OrchestratorProjectRow["agents"]>;
type ProjectAgent = ProjectAgents["workers"][number];

function projectAgentOf(agent: AgentFacts): ProjectAgent {
  return { id: agent.id, title: agent.title ?? null, status: agent.status };
}

function isRunning(agent: Pick<ProjectAgent, "status"> | null): boolean {
  return agent?.status === "running";
}

/**
 * A project's agents for the M W R dots (design §6B.7): its Manager, and of
 * each other role the non-archived agents that belong to the newest request,
 * run now, or carry an open Worker signal — at most `PROJECT_AGENTS_LIMIT`,
 * running ones first. Never every Worker the project ever had.
 */
export function projectAgentsOf(
  agents: ReadonlyMap<string, AgentFacts>,
  manager: AgentFacts | null,
  trace: Pick<ReconstructedTrace, "workerIds" | "reviewerIds"> | null,
  signals: ReadonlyArray<{ workerId: string }>,
): ProjectAgents {
  const pick = (role: "worker" | "reviewer", ids: readonly string[]): ProjectAgent[] =>
    [...agents.values()]
      .filter((agent) => agent.role === role && !agent.archived)
      .filter((agent) => agent.status === "running" || ids.includes(agent.id) || signals.some((signal) => signal.workerId === agent.id))
      .sort((a, b) => Number(isRunning(b)) - Number(isRunning(a)) || timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : 1))
      .slice(0, PROJECT_AGENTS_LIMIT)
      .map(projectAgentOf);
  return {
    manager: manager === null ? null : projectAgentOf(manager),
    workers: pick("worker", trace?.workerIds ?? []),
    reviewers: pick("reviewer", trace?.reviewerIds ?? []),
  };
}

/** The last report's phases that mean the Worker is at work between received and finished. */
const WORKING_PHASES: ReadonlySet<string> = new Set(["documents-done", "beads-done", "bead-implemented"]);

/**
 * Where the project's newest request stands (design §6B.7): `reviewing` while
 * a Reviewer runs, `implementing` while a Worker runs, else from its last
 * report — `blocked` → `waiting-user`, `finished`, a phase between them →
 * `implementing`, `received` or none → `received`. No request → `idle`.
 */
export function stageOf(
  trace: Pick<ReconstructedTrace, "reports"> | null,
  agents: Pick<ProjectAgents, "workers" | "reviewers">,
): ProjectStage {
  if (trace === null) return "idle";
  if (agents.reviewers.some(isRunning)) return "reviewing";
  if (agents.workers.some(isRunning)) return "implementing";
  const phase = trace.reports.at(-1)?.phase ?? null;
  if (phase === "blocked") return "waiting-user";
  if (phase === "finished") return "finished";
  if (phase !== null && WORKING_PHASES.has(phase)) return "implementing";
  return "received";
}

/** The phase of the last report that names a stage (`blocked` names none), or null. */
export function workPhaseOf(trace: Pick<ReconstructedTrace, "reports"> | null): ReportPhase | null {
  if (trace === null) return null;
  for (let index = trace.reports.length - 1; index >= 0; index -= 1) {
    const phase = trace.reports[index]!.phase;
    if (phase !== null && phase !== "blocked") return phase;
  }
  return null;
}

/**
 * A project's health (design §6B.7, one colour each on the tab): `risk` with
 * an open stall or Worker signal, else `waiting` when its request waits on
 * the owner or something of it is under Needs you, else `ok` while an agent
 * runs or the request is in progress, else `idle`.
 */
export function healthOf(facts: { risk: boolean; waiting: boolean; running: boolean; stage: ProjectStage }): ProjectHealth {
  if (facts.risk) return "risk";
  if (facts.waiting) return "waiting";
  if (facts.running || facts.stage === "received" || facts.stage === "implementing" || facts.stage === "reviewing") return "ok";
  return "idle";
}

/** The newest time the request moved: a turn end or a report, whichever is later. */
export function lastProgressOf(trace: ReconstructedTrace): string {
  const activity = lastActivityOf(trace);
  const report = trace.reports.at(-1)?.at ?? null;
  return report !== null && timeOf(report) > timeOf(activity) ? report : activity;
}

/** A stalled request: its open `request-stalled` alert. */
interface OpenStall {
  workspaceId: string;
  requestKey: string;
  since: string;
}

/** A Worker signal: its alert, read as the signal. */
interface OpenSignal {
  workspaceId: string;
  workerId: string;
  signal: WorkerSignal;
  since: string;
}

const SIGNAL_OF_ALERT: Readonly<Partial<Record<AlertKind, WorkerSignal>>> = {
  stuck: "stuck",
  "permission-waiting": "permission",
  danger: "danger",
};

/**
 * The open Inbox alerts a project row reads (autonomy design §A.8): each
 * `request-stalled` alert as a stall and each Worker alert as its signal. An
 * unreadable alerts file reads as none.
 */
export function openAlertsOf(home: string): { openStalls: OpenStall[]; openSignals: OpenSignal[] } {
  let alerts: Alert[];
  try {
    alerts = createAlertStore(home).list({ open: true });
  } catch {
    alerts = [];
  }
  const openStalls: OpenStall[] = [];
  const openSignals: OpenSignal[] = [];
  for (const alert of alerts) {
    if (alert.workspaceId === null) continue;
    if (alert.kind === "request-stalled") {
      openStalls.push({ workspaceId: alert.workspaceId, requestKey: alert.subject, since: alert.since });
      continue;
    }
    const signal = SIGNAL_OF_ALERT[alert.kind];
    if (signal !== undefined) openSignals.push({ workspaceId: alert.workspaceId, workerId: alert.subject, signal, since: alert.since });
  }
  return { openStalls, openSignals };
}

/**
 * `orchestrator.state` (design §8): the Orchestrator agent and the projects.
 * Reads only. No usable data folder → `E_DATA_HOME_UNAVAILABLE`.
 */
export async function handleOrchestratorState(
  paseo: OrchestratorActionsPaseo,
  deps: OrchestratorActionsDeps = {},
): Promise<OrchestratorStateOutput> {
  const { home, location, store } = openStore(deps, "read the Orchestrator's state");
  const now = (deps.now ?? (() => new Date()))();
  const [agents, listed] = await Promise.all([
    agentsOf(paseo).catch((): AgentsSnapshot => ({ bm: [], orchestrator: null, previousOrchestrators: 0 })),
    listedWorkspaces(paseo as unknown as DashboardPaseo),
  ]);
  const { settings, sentCommands, openStalls, openSignals } = inStore("read the Orchestrator's store", () => ({
    settings: store.readSettings(),
    sentCommands: store.listCommands(),
    // Stalled requests and the live watch's Worker signals are Inbox alerts (autonomy design §A.8).
    ...openAlertsOf(home),
  }));
  // The newest sent command of each project; `sentCommands` is newest first.
  const lastActions = new Map<string, NonNullable<OrchestratorProjectRow["lastAction"]>>();
  for (const command of sentCommands) {
    if (lastActions.has(command.workspaceId)) continue;
    const sent = command.sentText ?? command.command;
    lastActions.set(command.workspaceId, {
      at: command.settledAt ?? command.at,
      // A `BM-COMMAND` block (design §6B.1) says what it is about on its `re:` line.
      text: parseCommandBlock(sent)?.re ?? firstLine(sent, {}) ?? "",
      source: command.source,
    });
  }

  // Each workspace's store is read and rebuilt once per call.
  const rebuilt = new Map<string, WorkspaceTraces>();
  const tracesOf = async (workspaceId: string): Promise<WorkspaceTraces> => {
    const cached = rebuilt.get(workspaceId);
    if (cached !== undefined) return cached;
    const traces = await workspaceTracesOf(
      { location, paseo: paseo as unknown as DashboardPaseo, home, allAgents: agents.bm },
      workspaceId,
    );
    rebuilt.set(workspaceId, traces);
    return traces;
  };
  const labelOf = (workspaceId: string) => workspaceLabelOf(workspaceId, listed, location);

  const since = now.getTime() - PROJECTS_SINCE_DAYS * 86_400_000;
  const running = new Set(
    agents.bm
      .filter((entry) => entry.workspaceId !== null && !entry.facts.archived && entry.facts.status === "running")
      .map((entry) => entry.workspaceId!),
  );
  const stalled = new Set(openStalls.map((stall) => stall.workspaceId));
  // Newest first by what the store last saw, so the cap keeps the most recent projects.
  const candidates = storedWorkspaceIds(location)
    .map((workspaceId) => ({ workspaceId, meta: readWorkspaceMeta(location, workspaceId) }))
    .filter(({ workspaceId, meta }) => running.has(workspaceId) || meta === null || timeOf(meta.lastSeenAt) >= since)
    .sort((a, b) => timeOf(b.meta?.lastSeenAt) - timeOf(a.meta?.lastSeenAt));

  const projects: OrchestratorProjectRow[] = [];
  for (const { workspaceId } of candidates) {
    if (projects.length >= PROJECT_LIMIT) break;
    const { agents: facts, traces } = await tracesOf(workspaceId);
    const recent = traces
      .map((trace) => ({ trace, lastActivityAt: lastActivityOf(trace) }))
      .filter((entry) => timeOf(entry.lastActivityAt) >= since)
      .sort((a, b) => timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt));
    if (recent.length === 0 && !running.has(workspaceId)) continue;
    const newest = recent[0];
    const manager = projectManagerOf(facts, newest?.trace.managerAgentId ?? null);
    const state: OrchestratorProjectRow["state"] = running.has(workspaceId)
      ? "running"
      : stalled.has(workspaceId)
        ? "stalled"
        : newest !== undefined && waitingSinceOf(newest.trace) !== null
          ? "waiting-user"
          : "idle";
    const signals = openSignals.filter((signal) => signal.workspaceId === workspaceId);
    const agentsRow = projectAgentsOf(facts, manager, newest?.trace ?? null, signals);
    const stage = stageOf(newest?.trace ?? null, agentsRow);
    const autopilotEntry = Object.hasOwn(settings.autopilot, workspaceId) ? settings.autopilot[workspaceId] : undefined;
    projects.push({
      workspaceId,
      workspaceLabel: labelOf(workspaceId),
      managerId: manager?.id ?? null,
      managerTitle: manager?.title ?? null,
      managerStatus: manager?.status ?? null,
      state,
      lastActivityAt: newest?.lastActivityAt ?? null,
      requests: recent.length,
      autopilot: autopilotEntry !== undefined,
      allow: allowOf(autopilotEntry),
      health: healthOf({
        risk: stalled.has(workspaceId) || signals.length > 0,
        waiting: stage === "waiting-user",
        running: running.has(workspaceId),
        stage,
      }),
      stage,
      workPhase: workPhaseOf(newest?.trace ?? null),
      agents: agentsRow,
      lastProgressAt: newest === undefined ? null : lastProgressOf(newest.trace),
      currentRequest:
        newest === undefined
          ? null
          : { requestId: requestKeyOf(newest.trace), title: firstLine(newest.trace.requestText, deps.redactEnv ?? process.env) },
      openSignals: signals.map((signal) => ({ signal: signal.signal, workerId: signal.workerId, since: signal.since })),
      notes: inStore("read the Orchestrator's notes", () => store.readNotes(workspaceId)),
      lastAction: lastActions.get(workspaceId) ?? null,
      assessment: inStore("read the workflow assessments", () => assessmentRowOf(store, workspaceId)),
    });
  }
  projects.sort((a, b) => timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt));

  const orchestrator = agents.orchestrator;
  return {
    agent:
      orchestrator === null
        ? null
        : { id: orchestrator.id, status: orchestrator.status, workspaceId: orchestrator.workspaceId, createdAt: orchestrator.createdAt ?? null },
    previousCount: orchestrator === null ? 0 : (agents.previousOrchestrators ?? 0),
    toolsStale:
      orchestrator !== null && (deps.isToolsStale?.({ id: orchestrator.id, createdAt: orchestrator.createdAt ?? null }) ?? false),
    outdated: orchestrator !== null && isOutdatedOrchestrator(orchestrator),
    projects,
  };
}

// ---------------------------------------------------------------------------
// orchestrator.set-autopilot
// ---------------------------------------------------------------------------

/**
 * `orchestrator.set-autopilot` (design §6A, §8; ADR-015 decision 1): Autopilot
 * on or off for one project, recorded as turned on by the owner (`by: tab`). On without
 * `confirmed: true` → `E_AUTOPILOT_NOT_CONFIRMED`, nothing written. It sends
 * nothing: from now on the project's events reach the Orchestrator in
 * `BM-EVENTS` (autonomy design §A.8).
 * With `enabled: true`, `allow` sets the gate categories the owner allows for
 * the project (design §6B.5); the answer says what is stored.
 */
export async function handleOrchestratorSetAutopilot(
  input: OrchestratorSetAutopilotInput,
  deps: OrchestratorActionsDeps = {},
): Promise<OrchestratorSetAutopilotOutput> {
  if (input.enabled && input.confirmed !== true) {
    throw new DashboardError(
      "E_AUTOPILOT_NOT_CONFIRMED",
      "turning on Autopilot needs the confirmation dialog: the Orchestrator then answers this project's questions and commands its Manager without asking, which uses tokens",
    );
  }
  const { store } = openStore(deps, "set Autopilot");
  const saved = inStore("set Autopilot", () => {
    const switched = store.setAutopilot(input.workspaceId, input.enabled, "tab");
    // Allow… (design §6B.5, §9): only with the switch on; turning off forgets the categories.
    return input.enabled && input.allow !== undefined ? (store.setAutopilotAllow(input.workspaceId, input.allow) ?? switched) : switched;
  });
  const entry = Object.hasOwn(saved.autopilot, input.workspaceId) ? saved.autopilot[input.workspaceId] : undefined;
  return { workspaceId: input.workspaceId, autopilot: entry !== undefined, since: entry?.since ?? null, allow: allowOf(entry) };
}

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

/** Registers `state` and `set-autopilot`; called from `registerOrchestratorRpcs`. */
export function registerOrchestratorActionRpcs(server: PluginServerContext, deps: OrchestratorActionsDeps = {}): void {
  server.handle(orchestratorStateRpc, (_input, { paseo }) => handleOrchestratorState(paseo, deps));
  server.handle(orchestratorSetAutopilotRpc, (input) => handleOrchestratorSetAutopilot(input, deps));
}
