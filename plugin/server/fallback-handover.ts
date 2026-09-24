/**
 * The handovers a replacement agent starts from (delta 20260921 §4.4.8,
 * §4.5.2, REQ-065 d, REQ-066 c), built in code from stored data — never
 * summarised by a model.
 *
 * Worker (`workerHandover`):
 *
 * | Field | Source |
 * |---|---|
 * | `requestId` | the replaced Worker's `bm.requestId` label, recorded on the incident |
 * | report fields | the LATEST `BM-REPORT` of that request in the workspace trace store |
 * | `reviewCalls` | the request's reconstructed trace, against its tier's budget; a replacement Reviewer's first message is not counted (§4.5.1) |
 * | `questions` | the question–answer ledger: every question of the request with its latest answer or `open` (design delta 20260924-qa-ledger §8) |
 * | original request | the first `user_message` of the replaced Worker's timeline |
 *
 * Manager (`managerHandover`):
 *
 * | Field | Source |
 * |---|---|
 * | `workers` | live, non-replaced Workers of the workspace (`bmAgentsOf`, `liveWorkersOf`); provider and model from each one's snapshot; last report as for the Worker |
 * | `openQuestions` | `waitingOf` (the pill's rule, with the question–answer ledger) on the old Manager's timeline |
 * | `openIncidents` | the workspace's other `pending` or `waiting` incidents |
 * | user's messages | the three newest `user_message` items WITH `clientMessageId` (the user's own words) in the old Manager's timeline |
 *
 * Each source is raced against the budget (5 s by default): a missing part
 * reads `unknown` (`unavailable` for the Worker's request text) and never
 * blocks the switch. Every quoted user text is masked like every trace record
 * (REQ-048b).
 */
import { peersOfWorkspace } from "./chat-peers";
import { WAITING_TIMELINE_LIMIT, WAITING_TIMELINE_PAGES, waitingOf, type WaitingEntry } from "./chat-waiting";
import { redactText } from "./collector";
import { agentFactsOf, bmAgentsOf, reviewerReplacementIds, reviewerReplacementsFor, type DashboardPaseo } from "./dashboard-rpc";
import { replacementsOf } from "./fallback-state";
import { LIVE_MAX_PAGES, LIVE_PAGE_LIMIT, readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { isPluginNotice } from "./notices";
import { providerId } from "./provider-id";
import { answeredIds, handoverQuestionLines, readQaLedger, type QaLedger } from "./qa-ledger";
import { REVIEW_BUDGET } from "./review-budget";
import { asRecord, nonEmpty } from "./role-choices";
import { TRUNCATION_MARKER, readRecords, type TraceStoreLocation } from "./trace-store";
import { reconstructTraces } from "./traces";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import { parseQuestions } from "../shared/bm-questions";
import type { ChatPeer, FallbackIncident, ParsedReport, TraceRecord, WaitingWorker } from "../shared/contracts";

/** First line of the handover. */
export const HANDOVER_MARKER = "BM-HANDOVER";

/** Budget of the whole handover (§4.4.8). */
export const HANDOVER_BUDGET_MS = 5000;

/** Longest failure message quoted in the `reason` line. */
const REASON_MESSAGE_CHARS = 300;

/** Longest `blockers` text of a Manager handover's Worker line. */
const BLOCKERS_CHARS = 300;

/** The user's newest messages a Manager handover quotes, and the longest one. */
const QUOTED_MESSAGES = 3;
const QUOTED_MESSAGE_CHARS = 1000;

/** Incidents a new Manager inherits: still to be decided, or waiting for a reset. */
const OPEN_INCIDENT_STATUSES: ReadonlySet<FallbackIncident["status"]> = new Set(["pending", "waiting"]);

/** Last paragraph of the Manager handover (§4.5.2). */
const MANAGER_CLOSING =
  "You are the Beads Manager of this workspace from now on. Every Worker listed was told your id: take them as yours and create no Worker that already exists. Tell the user in one line that you took over, then carry on.";

/**
 * Last paragraph of the Worker handover: what the replacement does with it
 * (design delta 20260924-instruction-quality §2.1 — the notice says it, so
 * worker.md does not have to).
 */
export const WORKER_CLOSING =
  "You continue this request in place of the Worker that stopped. Read `git status` and `git diff` first: every change there belongs to the request, so never revert it. Reopen a closed bead only if a review blocks it. Continue the review budget from `reviewCalls` and open no new batch for one in review. The `questions` above are settled: never ask an answered one again; ask an `open` one at your next `blocked` under its own number, and number new ones after the highest listed (from Q100 when it reads `unknown`). Then send `received` to `managerAgentId`.";

export interface HandoverDeps {
  /** Agent listing and timelines; `PaseoApi` is structurally assignable. */
  paseo: unknown;
  /** The workspace trace store; `null` when tracing is off (the report fields read `unknown`). */
  location: TraceStoreLocation | null;
  log?: (message: string) => void;
  budgetMs?: number;
  /**
   * Every recorded incident (`readIncidents`). The Worker handover counts
   * `reviewCalls` without the first message of each Reviewer that replaced a
   * stopped one (§4.5.1); read from the install home when absent, none when `null`.
   */
  incidents?: readonly FallbackIncident[] | null;
}

/** `work()` within `budget` ms, or `null` on timeout or failure. Never throws. */
async function within<T>(budget: number, work: () => Promise<T> | T): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The ledger when it reads cleanly; null (so "unknown") when it is missing its home, unreadable, corrupt or too new. */
function ledgerOf(location: TraceStoreLocation | null): QaLedger | null {
  if (location === null) return null;
  const ledger = readQaLedger(location);
  return ledger.notices.length > 0 ? null : ledger;
}

/** The `questions` block of a Worker handover: `unknown`, `none`, or one line per question. */
function questionsBlock(ledger: QaLedger | null, requestId: string | null): string[] {
  if (ledger === null || requestId === null) return ["questions: unknown"];
  const lines = handoverQuestionLines(ledger, requestId);
  return lines.length === 0 ? ["questions: none"] : ["questions:", ...lines];
}

/** The request's latest `BM-REPORT` in the trace store, or null. */
function latestReport(records: readonly TraceRecord[], requestId: string): ParsedReport | null {
  let latest: ParsedReport | null = null;
  for (const record of records) {
    for (const report of record.reports) {
      if (report.requestId !== requestId) continue;
      if (latest === null || report.at >= latest.at) latest = report;
    }
  }
  return latest;
}

/** The first `user_message` of an agent's timeline (bounded walk back to its start), masked; null when none. */
async function firstUserMessage(paseo: unknown, agentId: string): Promise<string | null> {
  let first: string | null = null;
  await readTimelinePages(paseo as LiveTimelinePaseo, agentId, { pages: LIVE_MAX_PAGES, limit: LIVE_PAGE_LIMIT }, (entries) => {
    // Pages come newest first, each oldest first: every older page's first message replaces the last one found.
    const found = entries
      .map((entry) => entry.item as { type?: unknown; text?: unknown } | undefined)
      .find((item) => item?.type === "user_message" && typeof item.text === "string" && item.text.trim() !== "");
    if (found !== undefined) first = found.text as string;
  });
  return first === null ? null : redactText(first);
}

const list = (values: readonly string[] | undefined): string => (values === undefined ? "unknown" : values.length === 0 ? "none" : values.join(", "));

/** `text` on one line, at most `max` characters. */
const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The `reason` line: the failure class and the provider's own words. */
const reasonLine = (incident: FallbackIncident): string =>
  `reason: ${FALLBACK_CLASS_LABELS[incident.class]} — "${oneLine(incident.message, REASON_MESSAGE_CHARS)}"`;

/**
 * The `BM-HANDOVER` block that starts the replacement of `incident`'s Worker.
 * Never throws: every part it cannot get in time reads `unknown`.
 */
export async function workerHandover(incident: FallbackIncident, deps: HandoverDeps): Promise<string> {
  const budget = deps.budgetMs ?? HANDOVER_BUDGET_MS;
  const requestId = incident.requestId;
  const records =
    deps.location === null ? null : await within(budget, () => readRecords(deps.location!, incident.workspaceId).records);
  const [report, review, original, ledger] = await Promise.all([
    within(budget, () => (records === null || requestId === null ? null : latestReport(records, requestId))),
    within(budget, async () => {
      if (records === null || requestId === null) return null;
      // The same count as the BM-BUDGET check (delta 20260921 §4.5.1).
      const [facts, replacementIds] = await Promise.all([
        agentFactsOf(deps.paseo as DashboardPaseo, incident.workspaceId),
        deps.incidents === undefined ? reviewerReplacementsFor(deps.paseo) : reviewerReplacementIds(deps.incidents ?? []),
      ]);
      return reconstructTraces({ records, agents: [...facts.values()], replacementIds }).find((trace) => trace.requestId === requestId) ?? null;
    }),
    within(budget, () => firstUserMessage(deps.paseo, incident.agentId)),
    within(budget, () => ledgerOf(deps.location)),
  ]);

  const tier = report?.tier ?? review?.tier ?? null;
  const calls = review?.reviewCalls ?? null;
  const reviewCalls = calls === null ? "unknown" : tier === null ? `${calls} of an unknown budget` : `${calls} of ${REVIEW_BUDGET[tier]}`;

  return [
    HANDOVER_MARKER,
    "role: worker",
    `requestId: ${requestId ?? "unknown"}`,
    `managerAgentId: ${incident.managerId ?? "none"}`,
    `replaces: ${incident.agentId}`,
    reasonLine(incident),
    `lastReport: ${report === null ? "none" : `${report.phase ?? "unknown"} at ${report.at}`}`,
    `tier: ${tier ?? "unknown"}`,
    `filesChanged: ${list(report?.filesChanged)}`,
    `beadsCreated: ${list(report?.beadsCreated)}`,
    `beadsUpdated: ${list(report?.beadsUpdated)}`,
    `beadsClosed: ${list(report?.beadsClosed)}`,
    `beadsReady: ${list(report?.beadsReady)}`,
    `reviewFindingsOpen: ${report === null ? "unknown" : (report.reviewFindingsOpen ?? "none")}`,
    `reviewCalls: ${reviewCalls}`,
    `skillsUsed: ${list(report?.skillsUsed)}`,
    // What the stopped Worker chose on its own, so its final report can still list it.
    `decided: ${report === null ? "none" : list(report.decided ?? [])}`,
    ...questionsBlock(ledger, requestId),
    "",
    WORKER_CLOSING,
    "",
    "Original request (verbatim, the first message the replaced Worker received):",
    original ?? "unavailable",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Manager (§4.5.2, REQ-066 c).
// ---------------------------------------------------------------------------

export interface ManagerHandoverDeps extends HandoverDeps {
  /**
   * Every recorded incident (`readIncidents`): the workspace's open ones, and
   * the agents a `switched` one replaced. `null` when the file cannot be read
   * (`openIncidents: unknown`).
   */
  incidents: readonly FallbackIncident[] | null;
  /** Whose secret values are masked in the quoted messages; `process.env` by default. */
  env?: NodeJS.ProcessEnv;
}

/** The SDK slice that reads one agent's snapshot; `PaseoApi` is structurally assignable. */
interface SnapshotPaseo {
  agents: { ref?(agentId: string): { refresh?(): Promise<{ agent?: unknown } | null> } };
}

/** What a Manager handover reads from the old Manager's timeline, filled page by page. */
interface ManagerTimeline {
  /** Pages read so far. */
  pages: number;
  /** The pill's window (`WAITING_TIMELINE_PAGES`), newest first, as `waitingOf` wants it. */
  recent: WaitingEntry[];
  /** The user's own messages, newest first, masked and cut; at most `QUOTED_MESSAGES`. */
  typed: string[];
}

/**
 * The Workers a Manager handover lists — and so the ones the switch tells the
 * new Manager's id (§4.5.2 step 5): live (neither archived nor closed) and not
 * replaced by a fallback Worker.
 */
export function liveWorkersOf<P extends Pick<ChatPeer, "role" | "status" | "archived" | "replaced">>(peers: readonly P[]): P[] {
  return peers.filter((peer) => peer.role === "worker" && !peer.archived && peer.status !== "closed" && !peer.replaced);
}

/**
 * The text of a message the user typed in the app: a `user_message` with
 * `clientMessageId` (AGENTS.md), and neither a plugin notice nor a handover.
 */
function typedText(item: unknown): string | null {
  const message = item as { type?: unknown; text?: unknown; clientMessageId?: unknown } | null | undefined;
  if (message?.type !== "user_message" || typeof message.clientMessageId !== "string") return null;
  const text = nonEmpty(message.text);
  return text === null || isPluginNotice(text) || text.startsWith(HANDOVER_MARKER) ? null : text;
}

/** A quoted user message: masked first, so a secret across the cut is masked whole, then cut. */
function quoted(text: string, env: NodeJS.ProcessEnv): string {
  const masked = redactText(text, env);
  if (masked.length <= QUOTED_MESSAGE_CHARS) return masked;
  return `${masked.slice(0, QUOTED_MESSAGE_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Reads the old Manager's timeline back to its start (bounded) into `into`:
 * the pill's window and the user's newest messages. Filled as pages arrive,
 * so what was read before the budget ran out still counts.
 */
async function readManagerTimeline(paseo: unknown, managerId: string, into: ManagerTimeline, env: NodeJS.ProcessEnv): Promise<true> {
  await readTimelinePages(paseo as LiveTimelinePaseo, managerId, { pages: LIVE_MAX_PAGES, limit: WAITING_TIMELINE_LIMIT }, (entries) => {
    // Pages come newest first, each oldest first.
    const newestFirst = [...entries].reverse();
    if (into.pages < WAITING_TIMELINE_PAGES) into.recent.push(...newestFirst);
    into.pages += 1;
    for (const entry of newestFirst) {
      if (into.typed.length >= QUOTED_MESSAGES) break;
      const text = typedText(entry.item);
      if (text !== null) into.typed.push(quoted(text, env));
    }
  });
  return true;
}

/** An agent's current snapshot, or null. */
async function snapshotOf(paseo: unknown, agentId: string): Promise<Record<string, unknown> | null> {
  const ref = (paseo as SnapshotPaseo).agents.ref?.(agentId);
  return asRecord((await ref?.refresh?.())?.agent);
}

/** One `workers:` line; every part it cannot know reads `unknown`. */
function workerLine(worker: ChatPeer, records: readonly TraceRecord[] | null, snapshot: Record<string, unknown> | null): string {
  const provider = providerId(nonEmpty(snapshot?.["provider"]));
  // The model the agent runs: `runtimeInfo.model` first (AGENTS.md), else the configured one.
  const model = nonEmpty(asRecord(snapshot?.["runtimeInfo"])?.["model"]) ?? nonEmpty(snapshot?.["model"]);
  const runsOn = provider === null && model === null ? "unknown" : `${provider ?? "unknown"}/${model ?? "unknown"}`;
  const report = records === null || worker.requestId === null ? undefined : latestReport(records, worker.requestId);
  const last = report === undefined ? "unknown" : report === null ? "none" : `${report.phase ?? "unknown"} at ${report.at}`;
  const blockers = report === undefined ? "unknown" : report === null || report.blockers === null ? "none" : oneLine(report.blockers, BLOCKERS_CHARS);
  return `- ${worker.id} · requestId ${worker.requestId ?? "unknown"} · ${runsOn} · ${worker.status} · last report: ${last} · blockers: ${blockers}`;
}

/** `workerId: Q1, Q2; …` for the Workers waiting on the user, or `none`. */
function questionsOf(waiting: readonly WaitingWorker[]): string {
  const parts = waiting.map((entry) => {
    const answered = new Set(entry.answered ?? []);
    const open = (parseQuestions(entry.text)?.questions ?? []).map((question) => question.id).filter((id) => !answered.has(id));
    return `${entry.workerId}: ${open.join(", ")}`;
  });
  return parts.length === 0 ? "none" : parts.join("; ");
}

/** The workspace's other open incidents, oldest first, or `none`; `unknown` without the incidents file. */
function openIncidentsOf(incident: FallbackIncident, incidents: readonly FallbackIncident[] | null): string {
  if (incidents === null) return "unknown";
  const open = incidents.filter(
    (entry) => entry.id !== incident.id && entry.workspaceId === incident.workspaceId && OPEN_INCIDENT_STATUSES.has(entry.status),
  );
  return open.length === 0 ? "none" : open.map((entry) => entry.id).join(", ");
}

/**
 * The `BM-HANDOVER` block that starts the replacement of `incident`'s Manager.
 * One budget for the whole block: the old Manager's timeline is read beside
 * the agent list and the trace store, then the Workers' snapshots in what is
 * left — so a slow timeline never starves the Worker lines. Never throws:
 * every part it cannot get in time reads `unknown`, with one log line naming
 * what was late.
 */
export async function managerHandover(incident: FallbackIncident, deps: ManagerHandoverDeps): Promise<string> {
  const budget = deps.budgetMs ?? HANDOVER_BUDGET_MS;
  const deadline = Date.now() + budget;
  const left = (): number => Math.max(0, deadline - Date.now());
  const log = deps.log ?? ((message: string) => console.warn(message));
  const { workspaceId, agentId: managerId } = incident;
  const timeline: ManagerTimeline = { pages: 0, recent: [], typed: [] };

  const walking = within(budget, () => readManagerTimeline(deps.paseo, managerId, timeline, deps.env ?? process.env));
  const [records, all] = await Promise.all([
    deps.location === null ? null : within(left(), () => readRecords(deps.location!, workspaceId).records),
    within(left(), () => bmAgentsOf(deps.paseo as DashboardPaseo)),
  ]);
  // An empty list is a failed one: the old Manager itself is always on it.
  const agents = all === null || all.length === 0 ? null : all;
  const peers =
    agents === null ? null : await within(left(), () => peersOfWorkspace(agents, workspaceId, async () => records ?? [], replacementsOf(deps.incidents ?? [])));
  const workers = peers === null ? null : liveWorkersOf(peers);
  const snapshots = workers === null ? [] : await Promise.all(workers.map((worker) => within(left(), () => snapshotOf(deps.paseo, worker.id))));
  const walked = await walking;
  // Answered questions are not open, as the pill reads them (design delta 20260924-qa-ledger §8).
  const ledger = await within(left(), () => ledgerOf(deps.location));

  // The pill's rule, on the pill's window of the old Manager's timeline.
  const windowRead = timeline.pages > 0 && (walked !== null || timeline.pages >= WAITING_TIMELINE_PAGES);
  const waiting =
    peers === null || !windowRead
      ? null
      : await within(left(), () =>
          waitingOf(
            { id: managerId, workspaceId },
            timeline.recent,
            peers.filter((peer) => peer.role === "worker").map((peer) => ({ ...peer, workspaceId })),
            (requestId) => (ledger === null ? new Set<string>() : answeredIds(ledger, requestId)),
          ),
        );
  const typed = [...timeline.typed].reverse();
  const messages = typed.length > 0 ? typed.map((text, index) => `${index + 1}. ${text}`) : [timeline.pages > 0 && walked !== null ? "none" : "unknown"];

  const late = [
    ...(deps.location !== null && records === null ? ["the trace store"] : []),
    ...(agents === null || peers === null ? ["the agent list"] : []),
    ...(timeline.pages === 0 ? [`the timeline of Manager ${managerId}`] : []),
  ];
  if (late.length > 0) log(`[paseo-bm] the handover of incident ${incident.id} could not read ${late.join(", ")} within ${budget} ms; those parts read unknown.`);

  return [
    HANDOVER_MARKER,
    "role: manager",
    `workspaceId: ${workspaceId}`,
    `replaces: ${managerId}`,
    reasonLine(incident),
    ...(workers === null
      ? ["workers: unknown"]
      : workers.length === 0
        ? ["workers: none"]
        : ["workers:", ...workers.map((worker, index) => workerLine(worker, records, snapshots[index] ?? null))]),
    `openQuestions: ${waiting === null ? "unknown" : questionsOf(waiting)}`,
    `openIncidents: ${openIncidentsOf(incident, deps.incidents)}`,
    "",
    "The user's last messages to the Manager you replace (oldest first, verbatim):",
    ...messages,
    "",
    MANAGER_CLOSING,
  ].join("\n");
}
