/**
 * Finished sub-agents are archived (ADR-049, delivery line design §20): a
 * plugin pass, costing no agent turn, that archives the paseo-bm Workers and
 * Reviewers whose work is finished for good and that nobody touched for the
 * owner's window (`cleanup.idleDays`), while the owner's switch
 * (`cleanup.archive`) is on.
 *
 * - **When.** `createAgentCleanup().pass`, from the stall watcher's
 *   `beforePass`, at most once an hour per plugin process (an in-memory
 *   stamp); the first pass of a run may archive at once. With the switch off,
 *   or the settings unreadable, nothing runs and no stamp is set.
 * - **Eligible** (`finishedAgentsOf`): an unarchived agent whose provider runs
 *   `worker` or `reviewer` and that carries that same `bm.role` label; not
 *   `running` or `initializing`, with no pending permission; its request
 *   (`knownRequestIdOf`) located and finished, and the head of its chain
 *   finished too; its last touch — the newest of `updatedAt` and
 *   `lastUserMessageAt`, else `createdAt` — older than the window.
 * - **Kept by work still waiting:** an open outbox record to the agent or of a
 *   request of its chain; an open decision of a request of the chain; a live
 *   (`open` or `taken`) peer link with the agent or a request of the chain at
 *   either end.
 * - **Never:** Mains, Orchestrators, unlabelled agents, archived agents, an
 *   agent whose request cannot be located. Anything that cannot be read keeps
 *   the agent.
 * - **Archive, never delete:** at most `MAX_ARCHIVES_PER_PASS` a pass, oldest
 *   last touch first, each with `paseo.agents.ref(id).archive()`. A failure is
 *   one log line; the next pass tries again.
 * - **Told:** for each mission and pass, `note` journal entries by `plugin`
 *   naming each archived agent — one when they fit the journal's line limit,
 *   else as few as fit; an agent of a request of no mission gets a log line.
 *   The binding sweep revokes each archived agent's tool binding, as for any
 *   archived agent.
 *
 * Nothing here throws.
 */
import { BINDINGS_FILE, BINDINGS_VERSION } from "./agent-bindings";
import { listAllAgents, parentOf, roleOfAgent } from "./agent-role";
import { agentCleanupOf } from "./coordination-store";
import { createJsonFileStore } from "./data-files";
import { UI_DIR_NAME } from "./data-home";
import { DECISIONS_DIR_NAME, DECISIONS_FILE_VERSION, createDecisionStore } from "./decision-store";
import { MAX_JOURNAL_TEXT, createMissionStore, journalQuietly } from "./mission-store";
import { requestIndexOf } from "./mission-roster";
import { OUTBOX_DIR_NAME, OUTBOX_VERSION, createOutbox, isOpenRecord } from "./outbox";
import { PEERS_DIR_NAME, PEER_LINKS_FILE_NAME, PEER_LINKS_VERSION, createPeerLinkStore, isLiveLink } from "./peer-links";
import { createRequestRegistry, knownRequestIdOf, type RequestRegistry } from "./request-registry";
import { errorText } from "./rpc-kit";
import { chainHeadOf, chainOf, locateRequest } from "./waits";
import { UNSETTLED_STATUSES } from "../shared/decisions";

/** At most one pass an hour per plugin process. */
export const AGENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** At most this many archives a pass. */
export const MAX_ARCHIVES_PER_PASS = 25;

const DAY_MS = 24 * 60 * 60 * 1000;
const defaultLog = (message: string): void => console.warn(message);

/** The roles the pass archives. */
export type CleanupRole = "worker" | "reviewer";

/** A Worker or Reviewer finished for good and left alone for the window. */
export interface FinishedAgent {
  agentId: string;
  role: CleanupRole;
  requestId: string;
  /** The mission of its request, or null for a request of no mission. */
  missionId: string | null;
  /** Its last touch, as an ISO time. */
  lastTouchAt: string;
}

/**
 * What one call of `pass` did: `unreadable`, the settings could not be read;
 * `off`, the owner's switch is off; `throttled`, a pass ran less than an hour
 * ago; `failed`, the agents could not be listed or archived at all; `done`,
 * the pass ran, with what it archived and what failed.
 */
export interface AgentCleanupResult {
  status: "unreadable" | "off" | "throttled" | "failed" | "done";
  archived: FinishedAgent[];
  failed: FinishedAgent[];
}

export interface AgentCleanupDeps {
  now?: () => Date;
  log?: (message: string) => void;
}

export interface AgentCleanup {
  /** One pass over `paseo`'s agents with the stores of the data folder `home`, at most once an hour. Never throws. */
  pass(home: string, paseo: unknown): Promise<AgentCleanupResult>;
}

/** The SDK slice the pass uses; `PaseoApi` is structurally assignable. */
interface CleanupPaseo {
  agents: {
    list(options: {
      filter: { includeArchived: boolean };
      page: { limit: number; cursor?: string };
    }): Promise<{ entries: Array<Record<string, unknown>>; pageInfo?: { nextCursor: string | null; hasMore: boolean } }>;
    ref(agentId: string): { archive(): Promise<unknown> };
  };
}

function cleanupPaseoOf(paseo: unknown): CleanupPaseo | null {
  const agents = (paseo as { agents?: { list?: unknown; ref?: unknown } } | null | undefined)?.agents;
  return typeof agents?.list === "function" && typeof agents.ref === "function" ? (paseo as CleanupPaseo) : null;
}

/** The agents and requests some work still waits on: open outbox records, open decisions, live peer links. */
interface WaitingWork {
  agents: Set<string>;
  requests: Set<string>;
}

/** A store's file: its folder in the data folder, its name, its version and the key that holds it. */
interface StoreFile {
  dir: string;
  file: string;
  version: number;
  versionKey?: string;
}

/**
 * True when each file reads as its store reads it — missing or usable — and
 * none is unusable, newer than this build or behind a symlink: their stores
 * read such a file as empty, which would hide what it holds. Never throws.
 */
function filesReadable(home: string, files: readonly StoreFile[]): boolean {
  return files.every((spec) => {
    try {
      const { state } = createJsonFileStore<object>({ home, ...spec, parse: (body) => body, empty: () => ({}), codes: { unwritable: "E_TRACE_STORE_UNWRITABLE" } }).inspect();
      return state === "missing" || state === "ok";
    } catch {
      return false;
    }
  });
}

/** The files of work still waiting: every workspace's outbox and decisions, and the peer links. */
function waitingFilesOf(outboxWorkspaces: readonly string[], decisionWorkspaces: readonly string[]): StoreFile[] {
  return [
    ...outboxWorkspaces.map((workspaceId) => ({ dir: OUTBOX_DIR_NAME, file: `${workspaceId}.json`, version: OUTBOX_VERSION, versionKey: "schemaVersion" })),
    ...decisionWorkspaces.map((workspaceId) => ({ dir: DECISIONS_DIR_NAME, file: `${workspaceId}.json`, version: DECISIONS_FILE_VERSION })),
    { dir: PEERS_DIR_NAME, file: PEER_LINKS_FILE_NAME, version: PEER_LINKS_VERSION, versionKey: "schemaVersion" },
  ];
}

/**
 * The agent bindings (design §16.4): `knownRequestIdOf` trusts every
 * `bm.requestId` label when they cannot be read, so the pass archives nothing then.
 */
const BINDINGS_STORE_FILE: StoreFile = { dir: UI_DIR_NAME, file: BINDINGS_FILE, version: BINDINGS_VERSION, versionKey: "schemaVersion" };

/** The work still waiting in the stores of `home`. Throws when one of their files cannot be read. */
function waitingWorkOf(home: string, log: (message: string) => void): WaitingWork {
  const agents = new Set<string>();
  const requests = new Set<string>();
  const outbox = createOutbox(home);
  const decisions = createDecisionStore(home, { log });
  if (!filesReadable(home, waitingFilesOf(outbox.workspaces(), decisions.workspaceIds()))) throw new Error("a file of the outbox, the decisions or the peer links cannot be read");
  for (const workspaceId of outbox.workspaces()) {
    for (const record of outbox.list(workspaceId)) {
      if (!isOpenRecord(record)) continue;
      agents.add(record.to);
      requests.add(record.requestId);
    }
  }
  for (const decision of decisions.list({ statuses: UNSETTLED_STATUSES })) {
    if (decision.requestId !== null) requests.add(decision.requestId);
  }
  for (const link of createPeerLinkStore(home).list()) {
    if (!isLiveLink(link)) continue;
    agents.add(link.from.agentId);
    if (link.to.workerId !== null) agents.add(link.to.workerId);
    if (link.from.requestId !== null) requests.add(link.from.requestId);
    if (link.to.requestId !== null) requests.add(link.to.requestId);
  }
  return { agents, requests };
}

/** A time field as milliseconds, or null when it is not a time. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The newest of `updatedAt` and `lastUserMessageAt`; with neither, `createdAt`; null when none is a time. */
function lastTouchOf(agent: Record<string, unknown>): number | null {
  const touches = [timeOf(agent["updatedAt"]), timeOf(agent["lastUserMessageAt"])].filter((ms): ms is number => ms !== null);
  return touches.length > 0 ? Math.max(...touches) : timeOf(agent["createdAt"]);
}

/** True when the agent has a pending permission, or a `pendingPermissions` that cannot be read. */
function hasPendingPermission(agent: Record<string, unknown>): boolean {
  const pending = agent["pendingPermissions"];
  if (pending === undefined || pending === null) return false;
  return !Array.isArray(pending) || pending.length > 0;
}

interface Judge {
  home: string;
  registry: RequestRegistry;
  waiting: WaitingWork;
  /** The newest last touch an agent may have and still be archived, in milliseconds. */
  touchedBefore: number;
  log: (message: string) => void;
}

/** `agent` as a finished agent with its last touch in milliseconds, or null when anything keeps it. Throws only on a store that cannot be read. */
function finishedAgentOf(raw: unknown, judge: Judge): { agent: FinishedAgent; lastTouch: number } | null {
  if (raw === null || typeof raw !== "object") return null;
  const agent = raw as Record<string, unknown>;
  const agentId = agent["id"];
  if (typeof agentId !== "string" || agentId === "") return null;
  if (agent["archivedAt"] !== undefined && agent["archivedAt"] !== null && agent["archivedAt"] !== "") return null;
  const fact = roleOfAgent(agent);
  if (fact === null || !fact.labelled || (fact.role !== "worker" && fact.role !== "reviewer")) return null;
  const status = agent["status"];
  if (typeof status !== "string" || status === "running" || status === "initializing") return null;
  if (hasPendingPermission(agent)) return null;
  const lastTouch = lastTouchOf(agent);
  if (lastTouch === null || lastTouch >= judge.touchedBefore) return null;
  if (judge.waiting.agents.has(agentId)) return null;

  const { home, registry } = judge;
  const workspaceId = typeof agent["workspaceId"] === "string" && agent["workspaceId"] !== "" ? agent["workspaceId"] : null;
  const labels = agent["labels"] !== null && typeof agent["labels"] === "object" ? (agent["labels"] as Record<string, unknown>) : {};
  const requestId = knownRequestIdOf({ id: agentId, workspaceId, labels, parentAgentId: parentOf(agent) }, { home, log: judge.log });
  if (requestId === null) return null;
  const located = locateRequest(home, requestId, workspaceId, registry);
  if (located === null || located.request.finishedAt === null) return null;
  const head = chainHeadOf(home, requestId, located.workspaceId, registry);
  // A head that still names a continuation is one whose continuation could not be read.
  if (head === null || head.request.finishedAt === null || head.request.continuedBy !== undefined) return null;
  const chain = new Set([requestId, ...chainOf(home, head.request.requestId, head.workspaceId, registry)]);
  for (const id of chain) if (judge.waiting.requests.has(id)) return null;

  const missionId = located.request.missionId ?? requestIndexOf(home, requestId)?.missionId ?? null;
  return { agent: { agentId, role: fact.role, requestId, missionId, lastTouchAt: new Date(lastTouch).toISOString() }, lastTouch };
}

/**
 * The agents of `agents` (raw `agents.list` snapshots) that are finished for
 * good and were left alone for `idleDays` before `now`, oldest last touch
 * first, uncapped. Reads the stores of the data folder `home`; when a file of
 * the outbox, the decisions, the peer links or the agent bindings cannot be
 * read, none is. Never throws.
 */
export function finishedAgentsOf(home: string, agents: readonly unknown[], window: { idleDays: number; now: Date }, log: (message: string) => void = defaultLog): FinishedAgent[] {
  if (!filesReadable(home, [BINDINGS_STORE_FILE])) {
    log("[paseo-bm] finished agents were not archived: the agent bindings could not be read, so no request label can be trusted.");
    return [];
  }
  let waiting: WaitingWork;
  try {
    waiting = waitingWorkOf(home, log);
  } catch (error) {
    log(`[paseo-bm] finished agents were not archived: the work still waiting could not be read: ${errorText(error)}`);
    return [];
  }
  const judge: Judge = { home, registry: createRequestRegistry(home, { log: () => {} }), waiting, touchedBefore: window.now.getTime() - window.idleDays * DAY_MS, log };
  const found: Array<{ agent: FinishedAgent; lastTouch: number }> = [];
  for (const agent of agents) {
    try {
      const finished = finishedAgentOf(agent, judge);
      if (finished !== null) found.push(finished);
    } catch {
      // Anything that cannot be read keeps the agent.
    }
  }
  return found.sort((a, b) => a.lastTouch - b.lastTouch).map((entry) => entry.agent);
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The journal notes naming `names`, in order: as few as fit each within the
 * mission store's line limit (`MAX_JOURNAL_TEXT`), so no name is cut; one when
 * all fit. Each says how many it names. Pure.
 */
export function archivedNotesOf(names: readonly string[], idleDays: number): string[] {
  const textOf = (part: readonly string[]): string => `Archived ${plural(part.length, "finished agent")} left alone for ${plural(idleDays, "day")}: ${part.join(", ")}.`;
  const notes: string[] = [];
  let part: string[] = [];
  for (const name of names) {
    if (part.length > 0 && textOf([...part, name]).length > MAX_JOURNAL_TEXT) {
      notes.push(textOf(part));
      part = [];
    }
    part.push(name);
  }
  if (part.length > 0) notes.push(textOf(part));
  return notes;
}

/** The journal notes of each mission naming every archived agent (`archivedNotesOf`); a log line for each agent of a request of no mission. */
function tellArchived(home: string, archived: readonly FinishedAgent[], idleDays: number, now: () => Date, log: (message: string) => void): void {
  const byMission = new Map<string, FinishedAgent[]>();
  for (const agent of archived) {
    if (agent.missionId === null) {
      log(`[paseo-bm] archived finished ${agent.role} ${agent.agentId} of request ${agent.requestId} (no mission), left alone for ${plural(idleDays, "day")}.`);
      continue;
    }
    byMission.set(agent.missionId, [...(byMission.get(agent.missionId) ?? []), agent]);
  }
  if (byMission.size === 0) return;
  const store = createMissionStore(home, { now });
  for (const [missionId, agents] of byMission) {
    const names = agents.map((agent) => `${agent.role} ${agent.agentId.slice(0, 8)} (${agent.requestId})`);
    for (const text of archivedNotesOf(names, idleDays)) journalQuietly(store, missionId, { kind: "note", by: "plugin", text }, log);
  }
}

async function runPass(home: string, paseo: unknown, idleDays: number, now: () => Date, log: (message: string) => void): Promise<AgentCleanupResult> {
  const failedPass: AgentCleanupResult = { status: "failed", archived: [], failed: [] };
  const api = cleanupPaseoOf(paseo);
  if (api === null) {
    log("[paseo-bm] finished agents were not archived: this Paseo cannot list or archive agents.");
    return failedPass;
  }
  let agents: Array<Record<string, unknown>>;
  try {
    agents = await listAllAgents(
      async (options) => {
        const result = await api.agents.list(options);
        // Entries are `{ agent }` on the SDK; older fakes hand the agent itself.
        return {
          entries: result.entries.map((entry) => ({ agent: (entry["agent"] ?? entry) as Record<string, unknown> })),
          ...(result.pageInfo === undefined ? {} : { pageInfo: result.pageInfo }),
        };
      },
      { includeArchived: false },
    );
  } catch (error) {
    log(`[paseo-bm] finished agents were not archived: the agents could not be listed: ${errorText(error)}`);
    return failedPass;
  }
  const chosen = finishedAgentsOf(home, agents, { idleDays, now: now() }, log).slice(0, MAX_ARCHIVES_PER_PASS);
  const archived: FinishedAgent[] = [];
  const failed: FinishedAgent[] = [];
  for (const agent of chosen) {
    try {
      await api.agents.ref(agent.agentId).archive();
      archived.push(agent);
    } catch (error) {
      failed.push(agent);
      log(`[paseo-bm] could not archive finished ${agent.role} ${agent.agentId} of request ${agent.requestId}; the next pass tries again: ${errorText(error)}`);
    }
  }
  tellArchived(home, archived, idleDays, now, log);
  return { status: "done", archived, failed };
}

/** The archiving pass of one plugin process, with its own hourly stamp. */
export function createAgentCleanup(deps: AgentCleanupDeps = {}): AgentCleanup {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  let ranAt: number | null = null;
  return {
    async pass(home, paseo) {
      const idle: Omit<AgentCleanupResult, "status"> = { archived: [], failed: [] };
      try {
        const settings = agentCleanupOf(home);
        if (settings === null) return { status: "unreadable", ...idle };
        if (!settings.archive) return { status: "off", ...idle };
        const at = now().getTime();
        if (ranAt !== null && at - ranAt < AGENT_CLEANUP_INTERVAL_MS) return { status: "throttled", ...idle };
        // Stamped before the first await, so a pass that overlaps this one is throttled too.
        ranAt = at;
        return await runPass(home, paseo, settings.idleDays, now, log);
      } catch (error) {
        log(`[paseo-bm] finished agents were not archived: ${errorText(error)}`);
        return { status: "failed", ...idle };
      }
    },
  };
}
