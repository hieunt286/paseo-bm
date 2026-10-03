/**
 * The live watch of running Workers (Orchestrator design §6B.3, ADR-016
 * decision 1; autonomy design §A.8): every 2 minutes, for every project, the
 * plugin reads the tail of each running Beads Worker's timeline and raises
 * deterministic **Worker signals**. `stuck`, `permission` and `danger` are
 * Inbox alerts for the owner (`alert-store.ts`: `stuck`, `permission-waiting`,
 * `danger`); for a project in the policy's scope each signal is also one
 * `worker.signal` event for the Orchestrator per Worker turn (`event-bus.ts`,
 * batched into `BM-EVENTS`).
 *
 * - **Alerts for every project, events in the policy's scope** (design §A.8,
 *   §B.2; change-007 C1). The alerts cost no model call, so a running Worker
 *   of any project is watched for them. `worker.signal` events, and the
 *   `danger` interrupt allowance, are only for a project with a class above
 *   `owner` (`eventScopeOf`); an alert raised while its project was outside
 *   the scope is not told when the project enters it. With no running Worker
 *   nothing is refreshed or read.
 * - **Bounded.** At most `MAX_WATCHED_WORKERS` running Workers per pass (the
 *   newest by creation; the oldest are dropped), each: one `refresh()` for its
 *   snapshot, then at most `WORKER_TAIL_ENTRIES` timeline entries, newest
 *   first, stopping at the page that reaches back to its turn start. No model
 *   call.
 * - **The turn.** A Worker's turn start is its snapshot's
 *   `activeTurn.startedAt`, else its `lastUserMessageAt` (the message that
 *   started the turn); a Worker whose snapshot gives neither is not looked at,
 *   since nothing would key "once per turn".
 * - **The six signals** (`workerSignalsOf`, pure), on the entries since the
 *   turn start: `stuck`, `permission`, `danger`, `failing`, `heavy`,
 *   `outside` — the rules of §6B.3.
 * - **Alerts, once while they hold.** `stuck`, `permission` and `danger` raise
 *   the Worker's alert once (the alerts store keys it by kind, project and
 *   Worker); the pass that raises it publishes the event. `stuck` and
 *   `permission` are cleared by the first pass that no longer sees them (new
 *   activity, the permission answered); all three at the Worker's recorded
 *   turn end (`clearWorkerTurnSignals`, the collector's `onRecorded`) or when a
 *   pass finds it no longer running. A project leaving the scope keeps its
 *   alerts; its pending events are dropped at delivery (the event bus).
 * - **The other signals** (`failing`, `heavy`, `outside`) are events only,
 *   once per Worker turn (the event bus's key holds the turn start), settled at
 *   the Worker's turn end.
 * - **Only what ran.** A call that was denied (Paseo's own denial entry of a
 *   Codex call and the call it stands for; a Claude call whose held decision
 *   was denied or withdrawn: `shared/denied-calls.ts`) or still waits on its
 *   permission never raises `danger` (live check 2026-10-01 F3).
 * - **Danger.** A newly raised `danger` alert also opens the Worker's interrupt
 *   allowance for 10 minutes (`openDangerAllowance`): the only time the
 *   Orchestrator may interrupt it (design §6B.4). The plugin itself never
 *   interrupts anyone.
 * - **`off-tool-review`** is the seventh signal, not the pass's: a bound
 *   Worker created a Reviewer outside its tools (design §16.8,
 *   `off-tool-reviewer.ts` raises it with its `off-tool-reviewer` alert at the
 *   Reviewer's creation). No pass raises or clears it.
 * - **Events only to the Orchestrator**, through the event bus: batched, never
 *   into a running turn, dropped when settled before delivery. Nothing is ever
 *   sent to the owner, a Manager, a Worker or a Reviewer here.
 *
 * Nothing here throws into the plugin: a failure is one log line and the next
 * pass tries again.
 */
import { isAbsolute, join, resolve, sep } from "node:path";
import { TRACES_DIR_NAME, type DataHomeDeps } from "./data-home";
import { redactText } from "./collector";
import { listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./paseo-directory";
import { readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { createAlertStore, type AlertStore } from "./alert-store";
import { eventScopeOf, type BmEvent, type EventBus } from "./event-bus";
import { agentsOf, type OrchestratorStatePaseo } from "./orchestrator-state";
import { createOrchestratorStore } from "./orchestrator-store";
import { requestKeyOf, traceOfAgent, workspaceTracesOf, type WorkspaceTraces } from "./request-trace";
import { readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";
import { WORKER_SIGNALS, type WorkerSignal } from "../shared/orchestrator";
import { isProcessDocumentPath } from "../shared/orchestrator-rules";
import { ACTION_EFFECTS, effectfulCommandOf } from "../shared/effectful-actions";
import { decisionKindOf, type Effect } from "../shared/decisions";
import { deniedHeldCallsOf, deniedTwinOf, isDeniedHeldCall } from "../shared/denied-calls";
import { createDecisionStore, type DecisionStore } from "./decision-store";
import { isHeldOpen } from "./action-boundary";
import { normalisedCommand, shellFailureOf } from "../shared/shell";
import type { AlertKind } from "../shared/alerts";
import type { Tier } from "../shared/contracts";
import { timeOrZero } from "../shared/time";
import { errorText } from "./rpc-kit";

/** How often the Worker pass runs (design §6B.3). */
export const WORKER_PASS_MS = 2 * 60_000;
/** At most this many running Workers are looked at per pass; the oldest are dropped (design §6B.3). */
export const MAX_WATCHED_WORKERS = 5;
/** At most this many timeline entries are read per Worker (design §6B.3). */
export const WORKER_TAIL_ENTRIES = 300;
/** Entries per timeline page; two pages make `WORKER_TAIL_ENTRIES`. */
export const WORKER_TAIL_PAGE = 150;
/** `stuck`: the newest timeline entry is this old while the Worker runs (design §6B.3). */
export const STUCK_MS = 10 * 60_000;
/** `permission`: a permission has waited this long (design §6B.3). */
export const PERMISSION_WAIT_MS = 3 * 60_000;
/** `failing`: the same command failed (non-zero exit, or a failed status) this many times in the turn (design §6B.3). */
export const FAILING_COUNT = 3;
/**
 * The signals that are also Inbox alerts for the owner (autonomy design §A.8),
 * and their alert kind; the others are events for the Orchestrator only.
 */
export const SIGNAL_ALERT_KINDS: Readonly<Partial<Record<WorkerSignal, AlertKind>>> = {
  stuck: "stuck",
  permission: "permission-waiting",
  danger: "danger",
  // Design §16.8: raised with its alert at the off-tool Reviewer's creation (`off-tool-reviewer.ts`), never
  // by a pass; the alert is about the Reviewer and outlives the Worker's turn (not in WORKER_ALERT_KINDS).
  "off-tool-review": "off-tool-reviewer",
};

/** The alert kinds a Worker's signals raise. */
export const WORKER_ALERT_KINDS: readonly AlertKind[] = ["stuck", "permission-waiting", "danger"];

// ---------------------------------------------------------------------------
// The signals (pure).
// ---------------------------------------------------------------------------

/** One timeline entry as `timeline.refetch` returns it. */
export interface WatchedEntry {
  item?: unknown;
  timestamp?: unknown;
}

/** A tool call of the turn, once per call id: its first time, its latest state. */
interface ToolCall {
  at: string;
  name: string;
  /** The entry's `status` ("running", "completed", "failed", …); null when absent. */
  status: string | null;
  /** Its call id; null when absent. */
  id: string | null;
  /** True when Paseo's own denial entry says it never ran (a Codex call, `metadata.denied`). */
  denied: boolean;
  detail: {
    type?: unknown;
    command?: unknown;
    filePath?: unknown;
    cwd?: unknown;
    exitCode?: unknown;
    output?: unknown;
  };
}

/** Everything the six rules look at for one Worker, at `now`. */
export interface WorkerSignalInput {
  now: Date;
  /** The start of the Worker's current turn (ISO). */
  turnStart: string;
  /** The Worker's status in its snapshot; every signal but the tool-call ones needs `running`. */
  status: string;
  /** The tail of its timeline, oldest first, as read (entries before the turn start are ignored except for `stuck`). */
  entries: readonly WatchedEntry[];
  /** The permission it waits on, and since when; null when none. */
  permission: { since: string; text: string } | null;
  /** The workspace directory; null when unknown (then `outside` and the outside-`rm -rf` rule are not judged). */
  workspaceDirectory: string | null;
  /** The request's tier (the latest report's), for `heavy`. */
  tier: Tier | null;
  /**
   * The grants of the Worker's request, and when each was given (autonomy
   * design §D.2, change-009 C7): an effectful action one of them covers,
   * given before it ran, raises no `danger` — an allowed held request
   * included. None by default.
   */
  grants?: ReadonlyArray<{ at: string; effects: readonly Effect[] }>;
  /**
   * The ids of the calls still waiting on a permission request (Claude's
   * `metadata.toolUseId`, Codex's item id): not run yet, so never `danger`.
   */
  pendingCallIds?: ReadonlySet<string>;
  /**
   * True for a `failed` shell call that was a held request denied or
   * withdrawn (`isDeniedHeldCall`): it never ran, so it is never `danger`.
   */
  deniedHeld?: (command: string, at: string) => boolean;
}

/** A signal that holds, since when, and its evidence (not yet redacted or capped). */
export interface HeldSignal {
  signal: WorkerSignal;
  since: string;
  evidence: string;
}

/**
 * The tool calls of the entries since `turnStart`, once per call id, oldest
 * first. Paseo's denial entry of a Codex call (`metadata.denied`, call id
 * `permission-<item id>`) marks itself and the call it stands for as denied.
 */
function toolCallsOf(entries: readonly WatchedEntry[], turnStart: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const deniedIds = new Set<string>();
  for (const entry of entries) {
    const item = entry.item as { type?: unknown; callId?: unknown; name?: unknown; status?: unknown; detail?: unknown; metadata?: unknown } | null | undefined;
    if (item?.type !== "tool_call" || typeof entry.timestamp !== "string") continue;
    const time = Date.parse(entry.timestamp);
    if (Number.isNaN(time) || time < turnStart) continue;
    const detail = (item.detail ?? {}) as ToolCall["detail"];
    const name = typeof item.name === "string" ? item.name : "tool";
    const status = typeof item.status === "string" ? item.status : null;
    const id = typeof item.callId === "string" && item.callId !== "" ? item.callId : null;
    const metadata = (item.metadata ?? {}) as { denied?: unknown; permissionRequestId?: unknown };
    if (metadata.denied === true) {
      for (const denied of [id, deniedTwinOf(id), deniedTwinOf(text(metadata.permissionRequestId))]) if (denied !== null) deniedIds.add(denied);
    }
    const known = id === null ? undefined : byId.get(id);
    if (known !== undefined) {
      // A call seen running and then ended: keep when it began, and how it ended.
      known.detail = detail;
      known.name = name;
      known.status = status;
      continue;
    }
    const call: ToolCall = { at: entry.timestamp, name, status, id, denied: false, detail };
    calls.push(call);
    if (id !== null) byId.set(id, call);
  }
  for (const call of calls) if (call.id !== null && deniedIds.has(call.id)) call.denied = true;
  return calls;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

/** The command of a shell call, or null. */
function commandOf(call: ToolCall): string | null {
  return call.detail.type === "shell" ? text(call.detail.command) : null;
}

/** The path of an edit or write call, or null. */
function writtenPathOf(call: ToolCall): { kind: "edit" | "write"; path: string } | null {
  if (call.detail.type !== "edit" && call.detail.type !== "write") return null;
  const path = text(call.detail.filePath);
  return path === null ? null : { kind: call.detail.type, path };
}

/** True when `path` is `directory` or lies below it. */
function isInside(path: string, directory: string): boolean {
  const root = resolve(directory);
  const target = resolve(path);
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The name of the §6B.3 `danger` rule a shell command matches, or null: an
 * effectful action of the one list A-6 counts too (`shared/effectful-actions.ts`,
 * code review 2026-09-30 §3.5), named as the evidence gives it. `cwd` is where
 * it ran (the workspace directory when unknown). Pure.
 */
export function dangerOfCommand(command: string, cwd: string | null, workspaceDirectory: string | null): string | null {
  const found = effectfulCommandOf(command, cwd, workspaceDirectory);
  return found.action === null ? null : found.name;
}

/** True for a shell command that runs `br create`. */
function isBrCreate(command: string): boolean {
  return /(?:^|[\s;&|(])br\s+create\b/.test(command);
}

/** One line about the newest entry, for `stuck`. */
function entrySummary(entry: WatchedEntry | undefined): string {
  const item = entry?.item as { type?: unknown; text?: unknown; name?: unknown; status?: unknown; detail?: ToolCall["detail"] } | undefined;
  if (item === undefined || item === null) return "(nothing)";
  if (item.type === "tool_call") {
    const target = text(item.detail?.command) ?? text(item.detail?.filePath) ?? "";
    return `tool call ${typeof item.name === "string" ? item.name : "tool"} (${String(item.status ?? "unknown")})${target === "" ? "" : `: ${target}`}`;
  }
  if (typeof item.text === "string") return `${String(item.type)}: ${item.text.replace(/\s+/g, " ").trim()}`;
  return String(item.type ?? "entry");
}

/**
 * The Worker signals that hold for one running Worker (design §6B.3), in the
 * catalogue's order, each at most once. Pure.
 */
export function workerSignalsOf(input: WorkerSignalInput): HeldSignal[] {
  const now = input.now.getTime();
  const turnStart = timeOrZero(input.turnStart);
  const running = input.status === "running";
  const calls = toolCallsOf(input.entries, turnStart);
  const held: HeldSignal[] = [];

  // stuck — the newest entry (never older than the turn start) is 10 minutes old.
  if (running && input.entries.length > 0) {
    let newest: WatchedEntry | undefined;
    for (const entry of input.entries) {
      if (typeof entry.timestamp === "string" && (newest === undefined || timeOrZero(entry.timestamp) >= timeOrZero(newest.timestamp as string))) newest = entry;
    }
    const newestAt = Math.max(turnStart, newest === undefined ? 0 : timeOrZero(newest.timestamp as string));
    if (newestAt > 0 && now - newestAt >= STUCK_MS) {
      const since = new Date(newestAt).toISOString();
      held.push({ signal: "stuck", since, evidence: `No new timeline entry since ${since}. The newest: ${entrySummary(newest)}` });
    }
  }

  // permission — waiting 3 minutes.
  if (running && input.permission !== null && now - timeOrZero(input.permission.since) >= PERMISSION_WAIT_MS) {
    held.push({ signal: "permission", since: input.permission.since, evidence: input.permission.text });
  }

  // danger — the first dangerous shell command of the turn that no grant of its request covered before it ran.
  for (const call of calls) {
    const command = commandOf(call);
    if (command === null) continue;
    // Denied, or still waiting on its permission: it did not run (live check 2026-10-01 F3).
    if (call.denied || (call.id !== null && input.pendingCallIds?.has(call.id) === true)) continue;
    if (call.status === "failed" && input.deniedHeld?.(command, call.at) === true) continue;
    const found = effectfulCommandOf(command, text(call.detail.cwd), input.workspaceDirectory);
    if (found.action === null) continue;
    const effects = ACTION_EFFECTS[found.action];
    const ran = timeOrZero(call.at);
    if ((input.grants ?? []).some((grant) => timeOrZero(grant.at) <= ran && effects.some((effect) => grant.effects.includes(effect)))) continue;
    held.push({ signal: "danger", since: call.at, evidence: `${found.name}: ${command}` });
    break;
  }

  // failing — one command failed 3 times (a non-zero exit, or a failed status).
  const failures = new Map<string, { first: string; count: number; exit: number | "failed"; output: string | null }>();
  for (const call of calls) {
    const command = commandOf(call);
    const exit = shellFailureOf(call.status, call.detail.exitCode);
    if (command === null || exit === null) continue;
    const key = normalisedCommand(command);
    const known = failures.get(key);
    failures.set(key, { first: known?.first ?? call.at, count: (known?.count ?? 0) + 1, exit, output: text(call.detail.output) });
  }
  const failing = [...failures.entries()].filter(([, entry]) => entry.count >= FAILING_COUNT).sort((a, b) => timeOrZero(a[1].first) - timeOrZero(b[1].first))[0];
  if (failing !== undefined) {
    const [command, entry] = failing;
    const output = entry.output === null ? "" : `\nLast output (end): ${[...entry.output].slice(-400).join("")}`;
    const last = entry.exit === "failed" ? "the last one marked failed" : `last exit ${entry.exit}`;
    held.push({ signal: "failing", since: entry.first, evidence: `${command}\nFailed ${entry.count} times in this turn (${last}).${output}` });
  }

  // heavy — a Small request creating beads or process documents.
  if (input.tier === "Small") {
    for (const call of calls) {
      const command = commandOf(call);
      const written = writtenPathOf(call);
      if (command !== null && isBrCreate(command)) {
        held.push({ signal: "heavy", since: call.at, evidence: `The request is Small, and the Worker ran: ${command}` });
        break;
      }
      if (written !== null && isProcessDocumentPath(written.path)) {
        held.push({ signal: "heavy", since: call.at, evidence: `The request is Small, and the Worker used ${written.kind} on ${written.path}` });
        break;
      }
    }
  }

  // outside — an absolute path outside the workspace directory.
  if (input.workspaceDirectory !== null) {
    for (const call of calls) {
      const written = writtenPathOf(call);
      if (written === null || !isAbsolute(written.path) || isInside(written.path, input.workspaceDirectory)) continue;
      held.push({ signal: "outside", since: call.at, evidence: `${written.kind} ${written.path} (workspace directory: ${input.workspaceDirectory})` });
      break;
    }
  }

  return WORKER_SIGNALS.flatMap((signal) => held.filter((entry) => entry.signal === signal));
}

// ---------------------------------------------------------------------------
// The pass.
// ---------------------------------------------------------------------------

/** The SDK slice a Worker pass uses: the stall pass's; each agent's `timeline.refetch` is read through `LiveTimelinePaseo`. */
export type WorkerWatchPaseo = OrchestratorStatePaseo;

export interface WorkerWatchDeps extends DataHomeDeps {
  now?: () => Date;
  /** Where the events go (`event-bus.ts`); none are published without one. */
  bus?: Pick<EventBus, "publish">;
  /** Secrets to mask in an alert's detail; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}

/** What one Worker pass did, for the tests and the log. */
export interface WorkerPassResult {
  status: "done" | "busy" | "no-paseo" | "no-data-folder" | "off" | "failed";
  /** The Workers whose timeline was read. */
  watched: string[];
  /** Alert keys raised by this pass. */
  raised: string[];
  /** Alert keys cleared by this pass. */
  cleared: string[];
  /** The events this pass handed to the event bus. */
  events: BmEvent[];
  /** Workers whose interrupt allowance this pass opened. */
  allowances: string[];
}

export const workerPassResult = (status: WorkerPassResult["status"]): WorkerPassResult => ({
  status,
  watched: [],
  raised: [],
  cleared: [],
  events: [],
  allowances: [],
});

/**
 * When the watcher first saw each pending permission (`<workerId>|<permission
 * id>`), for a snapshot that does not say when the permission was asked. Kept
 * by the watcher across passes.
 */
export type PermissionFirstSeen = Map<string, string>;

/** The snapshot fields a pass reads; `PaseoAgent` is structurally assignable. */
interface WorkerSnapshot {
  status?: unknown;
  cwd?: unknown;
  lastUserMessageAt?: unknown;
  activeTurn?: { startedAt?: unknown } | null;
  pendingPermissions?: unknown;
  attentionReason?: unknown;
  attentionTimestamp?: unknown;
  archivedAt?: unknown;
}

/** The start of the Worker's current turn, from its snapshot; null when it gives none. */
export function turnStartOf(snapshot: WorkerSnapshot): string | null {
  const started = text(snapshot.activeTurn?.startedAt ?? null);
  if (started !== null && !Number.isNaN(Date.parse(started))) return started;
  const lastMessage = text(snapshot.lastUserMessageAt);
  return lastMessage !== null && !Number.isNaN(Date.parse(lastMessage)) ? lastMessage : null;
}

/** One line about a pending permission. */
function permissionText(request: Record<string, unknown>): string {
  const detail = (request["detail"] ?? {}) as ToolCall["detail"];
  const parts = [
    text(request["title"]) ?? text(request["name"]) ?? "a permission",
    text(request["description"]),
    text(detail.command) ?? text(detail.filePath),
  ].filter((part): part is string => part !== null);
  return `Waiting for the owner to allow: ${parts.join(" — ")}`;
}

/**
 * The timeline slice `readTimelinePages` reads: the Worker's own, except that a
 * page reaching back before the turn start says it has nothing older, so no
 * page older than the turn is read.
 */
function turnBoundedTimeline(handle: WorkerWatchPaseo, workerId: string, turnStart: number): LiveTimelinePaseo {
  const ref = (handle as unknown as LiveTimelinePaseo).agents.ref?.(workerId);
  return {
    agents: {
      ...(ref === undefined
        ? {}
        : {
            ref: () => ({
              timeline: {
                refetch: async (options: Record<string, unknown>) => {
                  const page = (await ref.timeline.refetch(options)) as { entries?: WatchedEntry[]; hasOlder?: unknown } | null;
                  const entries = Array.isArray(page?.entries) ? page.entries : [];
                  const reachesStart = entries.some((entry) => typeof entry.timestamp === "string" && timeOrZero(entry.timestamp) < turnStart);
                  return reachesStart ? { ...page, hasOlder: false } : page;
                },
              },
            }),
          }),
    },
  };
}

/** Clears the open Worker alerts that match; returns their keys. */
function clearWorkerAlerts(alerts: AlertStore, match: (workspaceId: string | null, workerId: string, kind: AlertKind) => boolean): string[] {
  return alerts.clearWhere((alert) => WORKER_ALERT_KINDS.includes(alert.kind) && match(alert.workspaceId, alert.subject, alert.kind));
}

/**
 * One Worker pass (design §6B.3, autonomy design §A.8), for the stall
 * watcher's timer. `live` turns false when the watcher stops: nothing more is
 * written or published. Throws only on an unexpected failure (the watcher
 * logs it).
 */
export async function runWorkerPass(
  handle: WorkerWatchPaseo,
  home: string,
  live: () => boolean,
  deps: WorkerWatchDeps,
  permissionsSeen: PermissionFirstSeen,
): Promise<WorkerPassResult> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => new Date());
  const env = deps.redactEnv ?? process.env;
  const store = createOrchestratorStore(home, { now });
  const alerts = createAlertStore(home, { now });
  const decisions = createDecisionStore(home, { log });
  const scope = eventScopeOf(home, log);
  const snapshot = await agentsOf(handle);
  if (!live()) return workerPassResult("off");
  const done = workerPassResult("done");
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };

  const running = snapshot.bm
    .filter(
      (entry) =>
        entry.workspaceId !== null &&
        entry.facts.role === "worker" &&
        !entry.facts.archived &&
        entry.facts.status === "running",
    )
    .sort((a, b) => timeOrZero(b.facts.createdAt) - timeOrZero(a.facts.createdAt));
  const runningIds = new Set(running.map((entry) => entry.facts.id));

  let listed: ReadonlyArray<ListedWorkspace> | null | undefined;
  const listedOnce = async (): Promise<ReadonlyArray<ListedWorkspace> | null> =>
    listed === undefined ? (listed = await listedWorkspaces(handle as unknown as DashboardPaseo)) : listed;
  const traces = new Map<string, Promise<WorkspaceTraces | null>>();
  const tracesOf = (workspaceId: string): Promise<WorkspaceTraces | null> => {
    let found = traces.get(workspaceId);
    if (found === undefined) {
      found = workspaceTracesOf({ location, paseo: handle as unknown as DashboardPaseo, home, allAgents: snapshot.bm }, workspaceId).catch((error: unknown) => {
        log(`[paseo-bm] the Worker watch could not read the traces of workspace ${workspaceId}: ${errorText(error)}`);
        return null;
      });
      traces.set(workspaceId, found);
    }
    return found;
  };

  for (const { workspaceId, facts } of running.slice(0, MAX_WATCHED_WORKERS)) {
    if (!live()) return done;
    const workerId = facts.id;
    try {
      const agent = ((await handle.agents.ref(workerId).refresh())?.agent ?? null) as WorkerSnapshot | null;
      if (!live()) return done;
      if (agent === null || text(agent.archivedAt) !== null) {
        runningIds.delete(workerId);
        continue;
      }
      const status = text(agent.status) ?? facts.status;
      if (status !== "running") {
        runningIds.delete(workerId);
        continue;
      }
      const turnStart = turnStartOf(agent);
      if (turnStart === null) continue;

      // The permission it waits on: since the snapshot says, else since first seen here. A request the
      // action boundary holds is the owner's decision already, one Inbox item (autonomy design §D.2).
      const pending = (Array.isArray(agent.pendingPermissions) ? (agent.pendingPermissions as Array<Record<string, unknown>>) : []).filter(
        (request) => !heldOpen(decisions, workerId, request["id"]),
      );
      for (const key of [...permissionsSeen.keys()]) {
        if (key.startsWith(`${workerId}|`) && !pending.some((request) => key === `${workerId}|${String(request["id"])}`)) permissionsSeen.delete(key);
      }
      let permission: WorkerSignalInput["permission"] = null;
      const first = pending[0];
      if (first !== undefined) {
        const seenKey = `${workerId}|${String(first["id"])}`;
        if (!permissionsSeen.has(seenKey)) permissionsSeen.set(seenKey, now().toISOString());
        const stated = agent.attentionReason === "permission" ? text(agent.attentionTimestamp) : null;
        permission = { since: stated ?? permissionsSeen.get(seenKey)!, text: permissionText(first) };
      }

      const entries: WatchedEntry[] = [];
      const turnStartMs = timeOrZero(turnStart);
      await readTimelinePages(
        turnBoundedTimeline(handle, workerId, turnStartMs),
        workerId,
        { pages: WORKER_TAIL_ENTRIES / WORKER_TAIL_PAGE, limit: WORKER_TAIL_PAGE },
        (page) => entries.unshift(...page),
      );
      if (!live()) return done;
      done.watched.push(workerId);

      const workspaceTraces = await tracesOf(workspaceId!);
      const trace = workspaceTraces === null ? undefined : traceOfAgent(workspaceTraces.traces, workerId);
      let meta: ReturnType<typeof readWorkspaceMeta> = null;
      try {
        meta = readWorkspaceMeta(location, workspaceId!);
      } catch {
        meta = null;
      }
      const workspaceDirectory =
        (await listedOnce())?.find((entry) => entry.id === workspaceId)?.directory ?? meta?.lastKnownDirectory ?? text(agent.cwd);
      const grants = grantsOfWorker(decisions, workspaceId!, trace?.requestId ?? null, workerId, log);
      const denied = deniedHeldOfWorker(decisions, workspaceId!, workerId);
      const held = workerSignalsOf({
        now: now(),
        turnStart,
        status,
        entries,
        permission,
        workspaceDirectory,
        tier: trace?.tier ?? null,
        grants,
        pendingCallIds: pendingCallIdsOf(agent.pendingPermissions),
        // The question quotes the command masked: compare it masked the same way.
        deniedHeld: (command, at) => isDeniedHeldCall(denied, workerId, redactText(command, env), at),
      });
      if (!live()) return done;

      // `stuck` and `permission` hold only while seen: new activity, or an answered permission, clears them.
      done.cleared.push(
        ...clearWorkerAlerts(
          alerts,
          (alertWorkspace, alertWorker, kind) =>
            alertWorkspace === workspaceId &&
            alertWorker === workerId &&
            kind !== "danger" &&
            !held.some((signal) => SIGNAL_ALERT_KINDS[signal.signal] === kind),
        ),
      );
      const requestKey = trace === undefined ? null : requestKeyOf(trace);
      // Events, and the danger allowance, only in the policy's scope; the alerts for every project.
      const inScope = scope.has(workspaceId!);
      for (const signal of held) {
        const kind = SIGNAL_ALERT_KINDS[signal.signal];
        if (kind === undefined) {
          if (inScope) done.events.push({ type: "worker.signal", workspaceId: workspaceId!, workerId, requestKey, signal: signal.signal, turnStart, alertKey: null, since: signal.since });
          continue;
        }
        const raised = alerts.raise({ workspaceId: workspaceId!, kind, subject: workerId, detail: redactText(signal.evidence, env) });
        if (!raised.raised) continue;
        done.raised.push(raised.alert.key);
        if (!inScope) continue;
        const allowance = signal.signal === "danger" ? store.openDangerAllowance(workspaceId!, workerId) : null;
        if (allowance !== null) done.allowances.push(workerId);
        done.events.push({
          type: "worker.signal",
          workspaceId: workspaceId!,
          workerId,
          requestKey,
          signal: signal.signal,
          turnStart,
          alertKey: raised.alert.key,
          since: raised.alert.since,
          interruptUntil: allowance?.until ?? null,
        });
      }
    } catch (error) {
      log(`[paseo-bm] the Worker watch could not look at Worker ${workerId}: ${errorText(error)}`);
    }
  }

  // A Worker that stopped running has no signal any more.
  if (!live()) return done;
  done.cleared.push(...clearWorkerAlerts(alerts, (_workspaceId, workerId) => !runningIds.has(workerId)));
  if (done.events.length > 0 && deps.bus !== undefined) await deps.bus.publish(done.events, handle, snapshot.orchestrator);
  return done;
}

/** True when the Worker's permission request is an open held decision; an unreadable store holds nothing. */
function heldOpen(decisions: DecisionStore, workerId: string, requestId: unknown): boolean {
  if (typeof requestId !== "string") return false;
  try {
    return isHeldOpen(decisions, workerId, requestId);
  } catch {
    return false;
  }
}

/**
 * The grants a Worker's actions ran under (autonomy design §D.2, change-009
 * C7): every answered decision of its request, and every held request of its
 * own, that granted effects, with when it was answered. An unreadable store
 * gives none.
 */
function grantsOfWorker(
  decisions: DecisionStore,
  workspaceId: string,
  requestId: string | null,
  workerId: string,
  log: (message: string) => void,
): Array<{ at: string; effects: readonly Effect[] }> {
  try {
    const answered = decisions.list({ workspaceId, statuses: ["answered"] });
    return answered
      .filter(
        (decision) =>
          decision.grant !== null &&
          decision.answer !== null &&
          ((requestId !== null && decision.requestId === requestId) || (decisionKindOf(decision.id) === "held" && decision.askedBy.agentId === workerId)),
      )
      .map((decision) => ({ at: decision.answer!.at, effects: decision.grant!.effects }));
  } catch (error) {
    log(`[paseo-bm] the Worker watch could not read the grants of ${workerId}: ${errorText(error)}`);
    return [];
  }
}

/** The call ids of a Worker's pending permission requests: Claude's `metadata.toolUseId`, Codex's item id. */
export function pendingCallIdsOf(pending: unknown): Set<string> {
  const ids = new Set<string>();
  for (const request of Array.isArray(pending) ? (pending as Array<Record<string, unknown> | null>) : []) {
    const metadata = (request?.["metadata"] ?? {}) as { toolUseId?: unknown; itemId?: unknown };
    for (const id of [text(metadata.toolUseId), text(metadata.itemId), deniedTwinOf(text(request?.["id"]))]) if (id !== null) ids.add(id);
  }
  return ids;
}

/** The held requests of this Worker that were denied or withdrawn; an unreadable store gives none. */
function deniedHeldOfWorker(decisions: DecisionStore, workspaceId: string, workerId: string) {
  try {
    return deniedHeldCallsOf(decisions.list({ workspaceId, statuses: ["answered", "withdrawn", "expired"] })).filter((entry) => entry.agentId === workerId);
  } catch {
    return [];
  }
}

/**
 * Clears the open alerts of a Worker whose turn just ended (design §6B.3,
 * autonomy design §A.8): the collector's `onRecorded` of that Worker. Returns
 * the cleared keys.
 */
export function clearWorkerTurnSignals(home: string, workerId: string, deps: Pick<WorkerWatchDeps, "now"> = {}): string[] {
  return clearWorkerAlerts(createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }), (_workspaceId, worker) => worker === workerId);
}
