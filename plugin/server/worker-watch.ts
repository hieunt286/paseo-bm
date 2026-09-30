/**
 * The live watch of running Workers (Orchestrator design §6B.3, ADR-016
 * decision 1; autonomy design §A.8): every 2 minutes, for the projects with
 * Autopilot on, the plugin reads the tail of each running Beads Worker's
 * timeline and raises deterministic **Worker signals**. Each signal is one
 * `worker.signal` event for the Orchestrator per Worker turn (`event-bus.ts`,
 * batched into `BM-EVENTS`); `stuck`, `permission` and `danger` are also Inbox
 * alerts for the owner (`alert-store.ts`: `stuck`, `permission-waiting`,
 * `danger`).
 *
 * - **Autopilot projects only.** A Worker of any other project is never
 *   refreshed and its timeline never read. With no Autopilot project the pass
 *   reads the settings file and nothing else.
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
 *   pass finds it no longer running, or its project no longer on Autopilot.
 * - **The other signals** (`failing`, `heavy`, `outside`) are events only,
 *   once per Worker turn (the event bus's key holds the turn start), settled at
 *   the Worker's turn end.
 * - **Danger.** A newly raised `danger` alert also opens the Worker's interrupt
 *   allowance for 10 minutes (`openDangerAllowance`): the only time the
 *   Orchestrator may interrupt it (design §6B.4). The plugin itself never
 *   interrupts anyone.
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
import { listedWorkspaces, type DashboardPaseo, type ListedWorkspace } from "./dashboard-rpc";
import { readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { createAlertStore, type AlertStore } from "./alert-store";
import type { BmEvent, EventBus } from "./event-bus";
import { agentsOf, type OrchestratorActionsPaseo } from "./orchestrator-actions";
import { createOrchestratorStore } from "./orchestrator-store";
import { requestKeyOf } from "./orchestrator-tools";
import { traceOfAgent, workspaceTracesOf, type WorkspaceTraces } from "./request-trace";
import { readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";
import { WORKER_SIGNALS, type WorkerSignal } from "../shared/orchestrator";
import { isProcessDocumentPath } from "../shared/orchestrator-rules";
import type { AlertKind } from "../shared/alerts";
import type { Tier } from "../shared/contracts";

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
};

/** The alert kinds a Worker's signals raise. */
export const WORKER_ALERT_KINDS: readonly AlertKind[] = ["stuck", "permission-waiting", "danger"];

function timeOf(at: string | null | undefined): number {
  const time = at === null || at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(time) ? 0 : time;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
}

/** A signal that holds, since when, and its evidence (not yet redacted or capped). */
export interface HeldSignal {
  signal: WorkerSignal;
  since: string;
  evidence: string;
}

/** The tool calls of the entries since `turnStart`, once per call id, oldest first. */
function toolCallsOf(entries: readonly WatchedEntry[], turnStart: number): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const entry of entries) {
    const item = entry.item as { type?: unknown; callId?: unknown; name?: unknown; status?: unknown; detail?: unknown } | null | undefined;
    if (item?.type !== "tool_call" || typeof entry.timestamp !== "string") continue;
    const time = Date.parse(entry.timestamp);
    if (Number.isNaN(time) || time < turnStart) continue;
    const detail = (item.detail ?? {}) as ToolCall["detail"];
    const name = typeof item.name === "string" ? item.name : "tool";
    const status = typeof item.status === "string" ? item.status : null;
    const id = typeof item.callId === "string" && item.callId !== "" ? item.callId : null;
    const known = id === null ? undefined : byId.get(id);
    if (known !== undefined) {
      // A call seen running and then ended: keep when it began, and how it ended.
      known.detail = detail;
      known.name = name;
      known.status = status;
      continue;
    }
    const call: ToolCall = { at: entry.timestamp, name, status, detail };
    calls.push(call);
    if (id !== null) byId.set(id, call);
  }
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

/** Shell patterns of §6B.3 `danger`, with the name the evidence gives. */
const DANGER_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "git push", pattern: /\bgit(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+push\b/ },
  { name: "npm publish", pattern: /\bnpm(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+publish\b/ },
  { name: "pnpm publish", pattern: /\bpnpm(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+publish\b/ },
  { name: "yarn publish", pattern: /\byarn(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:npm\s+)?publish\b/ },
  { name: "kubectl apply/delete", pattern: /\bkubectl\b[^\n;&|]*?\s(?:apply|delete)\b/ },
  { name: "terraform apply/destroy", pattern: /\bterraform\b[^\n;&|]*?\s(?:apply|destroy)\b/ },
  { name: "helm install/upgrade/uninstall", pattern: /\bhelm\b[^\n;&|]*?\s(?:install|upgrade|uninstall)\b/ },
  { name: "vercel --prod", pattern: /\bvercel\b[^\n;&|]*?\s--prod\b/ },
  { name: "docker push", pattern: /\bdocker\s+(?:image\s+)?push\b/ },
  { name: "DROP TABLE/DATABASE", pattern: /\bdrop\s+(?:table|database)\b/i },
  { name: "TRUNCATE", pattern: /\btruncate\s+(?:table\s+)?[\w"`[]/i },
];

/** Strips one pair of matching quotes around a shell word. */
function unquoted(word: string): string {
  return /^(["']).*\1$/.test(word) && word.length >= 2 ? word.slice(1, -1) : word;
}

/** True for a target of `rm -rf` that is `/`, the home folder, or (when the workspace is known) outside it. */
function rmTargetIsDangerous(target: string, base: string | null, workspaceDirectory: string | null): boolean {
  const word = unquoted(target);
  if (/^\/+\*?$/.test(word)) return true;
  if (/^~(?:\/|$)/.test(word) || /^\$\{?HOME\}?(?:\/|$)/.test(word)) return true;
  // Another variable, a command substitution: nothing to judge from the text.
  if (word.startsWith("$") || word.startsWith("`")) return false;
  if (workspaceDirectory === null) return false;
  if (!isAbsolute(word) && base === null) return false;
  return !isInside(isAbsolute(word) ? word : resolve(base!, word), workspaceDirectory);
}

/** The `rm -rf` of a command that removes `/`, `~` or a path outside the workspace; null when none. */
function dangerousRm(command: string, cwd: string | null, workspaceDirectory: string | null): string | null {
  for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
    const words = segment.trim().split(/\s+/).filter((word) => word !== "");
    let index = words.findIndex((word) => word === "rm" || word.endsWith("/rm"));
    if (index < 0) continue;
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    let flagsEnded = false;
    for (index += 1; index < words.length; index += 1) {
      const word = words[index]!;
      if (!flagsEnded && word === "--") {
        flagsEnded = true;
      } else if (!flagsEnded && word.startsWith("--")) {
        if (word === "--recursive") recursive = true;
        if (word === "--force") force = true;
      } else if (!flagsEnded && word.startsWith("-") && word.length > 1) {
        if (/[rR]/.test(word)) recursive = true;
        if (/f/.test(word)) force = true;
      } else {
        targets.push(word);
      }
    }
    if (!recursive || !force) continue;
    const base = cwd ?? workspaceDirectory;
    const target = targets.find((candidate) => rmTargetIsDangerous(candidate, base, workspaceDirectory));
    if (target !== undefined) return `rm -rf ${unquoted(target)}`;
  }
  return null;
}

/** `DELETE FROM` with no `WHERE` in the same statement. */
function deleteWithoutWhere(command: string): boolean {
  for (const match of command.matchAll(/\bdelete\s+from\b([^;]*)/gi)) {
    if (!/\bwhere\b/i.test(match[1] ?? "")) return true;
  }
  return false;
}

/**
 * The name of the §6B.3 `danger` rule a shell command matches, or null. `cwd`
 * is where it ran (the workspace directory when unknown). Pure.
 */
export function dangerOfCommand(command: string, cwd: string | null, workspaceDirectory: string | null): string | null {
  for (const { name, pattern } of DANGER_PATTERNS) if (pattern.test(command)) return name;
  if (deleteWithoutWhere(command)) return "DELETE FROM without WHERE";
  return dangerousRm(command, cwd, workspaceDirectory);
}

/** A shell command as `failing` compares it: trimmed, runs of white space made one space. */
export function normalisedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * How a shell call failed, for `failing`: its non-zero exit code, "failed"
 * when the entry only says so, or null when it did not fail. Paseo's timeline
 * for a Claude Worker carries no `exitCode` — a failed call is `status:
 * "failed"` with no output (coordination run 2026-09-29, F1) — so the status
 * counts as well as a non-zero numeric exit code. Pure.
 */
export function shellFailureOf(status: string | null, exitCode: unknown): number | "failed" | null {
  if (typeof exitCode === "number" && exitCode !== 0) return exitCode;
  if (status === "failed" || status === "error") return "failed";
  return null;
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
  const turnStart = timeOf(input.turnStart);
  const running = input.status === "running";
  const calls = toolCallsOf(input.entries, turnStart);
  const held: HeldSignal[] = [];

  // stuck — the newest entry (never older than the turn start) is 10 minutes old.
  if (running && input.entries.length > 0) {
    let newest: WatchedEntry | undefined;
    for (const entry of input.entries) {
      if (typeof entry.timestamp === "string" && (newest === undefined || timeOf(entry.timestamp) >= timeOf(newest.timestamp as string))) newest = entry;
    }
    const newestAt = Math.max(turnStart, newest === undefined ? 0 : timeOf(newest.timestamp as string));
    if (newestAt > 0 && now - newestAt >= STUCK_MS) {
      const since = new Date(newestAt).toISOString();
      held.push({ signal: "stuck", since, evidence: `No new timeline entry since ${since}. The newest: ${entrySummary(newest)}` });
    }
  }

  // permission — waiting 3 minutes.
  if (running && input.permission !== null && now - timeOf(input.permission.since) >= PERMISSION_WAIT_MS) {
    held.push({ signal: "permission", since: input.permission.since, evidence: input.permission.text });
  }

  // danger — the first dangerous shell command of the turn.
  for (const call of calls) {
    const command = commandOf(call);
    if (command === null) continue;
    const rule = dangerOfCommand(command, text(call.detail.cwd), input.workspaceDirectory);
    if (rule === null) continue;
    held.push({ signal: "danger", since: call.at, evidence: `${rule}: ${command}` });
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
  const failing = [...failures.entries()].filter(([, entry]) => entry.count >= FAILING_COUNT).sort((a, b) => timeOf(a[1].first) - timeOf(b[1].first))[0];
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
export type WorkerWatchPaseo = OrchestratorActionsPaseo;

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
                  const reachesStart = entries.some((entry) => typeof entry.timestamp === "string" && timeOf(entry.timestamp) < turnStart);
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
  const autopilot = new Set(Object.keys(store.readSettings().autopilot));
  if (autopilot.size === 0) {
    // No project is watched: no Worker alert holds any more.
    const cleared = clearWorkerAlerts(alerts, () => true);
    return { ...workerPassResult("off"), cleared };
  }
  const snapshot = await agentsOf(handle);
  if (!live()) return workerPassResult("off");
  const done = workerPassResult("done");
  const location: TraceStoreLocation = { tracesDir: join(home, TRACES_DIR_NAME) };

  const running = snapshot.bm
    .filter(
      (entry) =>
        entry.workspaceId !== null &&
        autopilot.has(entry.workspaceId) &&
        entry.facts.role === "worker" &&
        !entry.facts.archived &&
        entry.facts.status === "running",
    )
    .sort((a, b) => timeOf(b.facts.createdAt) - timeOf(a.facts.createdAt));
  const runningIds = new Set(running.map((entry) => entry.facts.id));

  let listed: ReadonlyArray<ListedWorkspace> | null | undefined;
  const listedOnce = async (): Promise<ReadonlyArray<ListedWorkspace> | null> =>
    listed === undefined ? (listed = await listedWorkspaces(handle as unknown as DashboardPaseo)) : listed;
  const traces = new Map<string, Promise<WorkspaceTraces | null>>();
  const tracesOf = (workspaceId: string): Promise<WorkspaceTraces | null> => {
    let found = traces.get(workspaceId);
    if (found === undefined) {
      found = workspaceTracesOf({ location, paseo: handle as unknown as DashboardPaseo, home, allAgents: snapshot.bm }, workspaceId).catch((error: unknown) => {
        log(`[paseo-bm] the Worker watch could not read the traces of workspace ${workspaceId}: ${describeError(error)}`);
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

      // The permission it waits on: since the snapshot says, else since first seen here.
      const pending = Array.isArray(agent.pendingPermissions) ? (agent.pendingPermissions as Array<Record<string, unknown>>) : [];
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
      const turnStartMs = timeOf(turnStart);
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
      const held = workerSignalsOf({ now: now(), turnStart, status, entries, permission, workspaceDirectory, tier: trace?.tier ?? null });
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
      for (const signal of held) {
        const kind = SIGNAL_ALERT_KINDS[signal.signal];
        if (kind === undefined) {
          done.events.push({ type: "worker.signal", workspaceId: workspaceId!, workerId, requestKey, signal: signal.signal, turnStart, alertKey: null, since: signal.since });
          continue;
        }
        const raised = alerts.raise({ workspaceId: workspaceId!, kind, subject: workerId, detail: redactText(signal.evidence, env) });
        if (!raised.raised) continue;
        done.raised.push(raised.alert.key);
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
      log(`[paseo-bm] the Worker watch could not look at Worker ${workerId}: ${describeError(error)}`);
    }
  }

  // A Worker that stopped running, or whose project left Autopilot, has no signal any more.
  if (!live()) return done;
  done.cleared.push(...clearWorkerAlerts(alerts, (_workspaceId, workerId) => !runningIds.has(workerId)));
  if (done.events.length > 0 && deps.bus !== undefined) await deps.bus.publish(done.events, handle, snapshot.orchestrator);
  return done;
}

/**
 * Clears the open alerts of a Worker whose turn just ended (design §6B.3,
 * autonomy design §A.8): the collector's `onRecorded` of that Worker. Returns
 * the cleared keys.
 */
export function clearWorkerTurnSignals(home: string, workerId: string, deps: Pick<WorkerWatchDeps, "now"> = {}): string[] {
  return clearWorkerAlerts(createAlertStore(home, deps.now === undefined ? {} : { now: deps.now }), (_workspaceId, worker) => worker === workerId);
}
