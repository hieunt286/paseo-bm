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
 * | `reviewCalls` | the request's reconstructed trace, against its tier's budget in Settings → Coordination (autonomy design §G.7); a replacement Reviewer's first message is not counted (§4.5.1) |
 * | `questions` | the decision store: every question the request asked the owner (`q:<requestId>:<Qn>`) with its answer, `open`, or how it ended (autonomy design §A.4) |
 * | original request | the first `user_message` of the replaced Worker's timeline |
 *
 * Manager (`managerHandover`):
 *
 * | Field | Source |
 * |---|---|
 * | `workers` | live, non-replaced Workers of the workspace (`bmAgentsOf`, `liveWorkersOf`); provider and model from each one's snapshot; last report as for the Worker |
 * | `openQuestions` | the decision store: each listed Worker's unsettled questions, by its request |
 * | `openIncidents` | the workspace's other `pending` or `waiting` incidents |
 * | user's messages | the three newest `user_message` items WITH `clientMessageId` (the user's own words) in the old Manager's timeline, neither a plugin notice nor what the plugin's send log says it sent (a `/compact`, autonomy design §G.5) |
 *
 * The facts of the Worker handover (`workerHandoverFacts`) are also what the
 * successor's brief of a handoff is built on (`handoff.ts`, autonomy design
 * §G.6, change-008 C3): one builder, not two.
 *
 * Each source is raced against the budget (5 s by default): a missing part
 * reads `unknown` (`unavailable` for the Worker's request text) and never
 * blocks the switch. Every quoted user text is masked like every trace record
 * (REQ-048b).
 */
import { dirname } from "node:path";
import { peersOfWorkspace } from "./chat-peers";
import { pluginSentBeside, redactText } from "./collector";
import { createDecisionStore } from "./decision-store";
import { replacementsOf, reviewerReplacementIds, reviewerReplacementsFor } from "./fallback-state";
import { LIVE_MAX_PAGES, LIVE_PAGE_LIMIT, readTimelinePages, type LiveTimelinePaseo } from "./live-timeline";
import { isPluginNotice } from "./notices";
import { agentFactsOf, bmAgentsOf, type DashboardPaseo } from "./paseo-directory";
import { providerId } from "./provider-id";
import { REVIEW_BUDGET } from "./review-budget";
import { readReviewBudget } from "./coordination-rpc";
import { asRecord, nonEmpty } from "./role-choices";
import { TRUNCATION_MARKER, readRecords, type TraceStoreLocation } from "./trace-store";
import { reconstructTraces } from "./traces";
import { FALLBACK_CLASS_LABELS } from "../shared/bm-fallback";
import type { ChatPeer, FallbackIncident, ParsedReport, Tier, TraceRecord } from "../shared/contracts";
import { decisionKindOf, isAnswerable, type Decision } from "../shared/decisions";

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

/** Longest question or answer text in one `questions` line. */
export const HANDOVER_TEXT_CHARS = 300;

/** Timeline items per page when the old Manager's timeline is read for the owner's messages. */
const MANAGER_TIMELINE_LIMIT = 200;

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

/**
 * The workspace's Worker questions in the decision store (autonomy design
 * §A.4), which lives beside the trace store in the data folder; null (so
 * "unknown") without a trace store or when the store cannot be read.
 */
function questionDecisionsOf(location: TraceStoreLocation | null, workspaceId: string): Decision[] | null {
  if (location === null) return null;
  return createDecisionStore(dirname(location.tracesDir), { log: () => undefined })
    .list({ workspaceId })
    .filter((decision) => decisionKindOf(decision.id) === "question");
}

/** `Q3` of `q:<requestId>:Q3`. */
const questionIdOf = (decision: Pick<Decision, "id">): string => decision.id.slice(decision.id.lastIndexOf(":") + 1);
const questionNumber = (decision: Pick<Decision, "id">): number => Number.parseInt(questionIdOf(decision).slice(1), 10);

const handoverText = (text: string): string => oneLine(text, HANDOVER_TEXT_CHARS);

/** What became of a question: its answer, `open`, or how it ended without one. */
function outcomeOf(decision: Decision): string {
  if (isAnswerable(decision)) return "open";
  if (decision.status === "superseded") return decision.supersededBy === null ? "superseded" : `superseded by ${questionIdOf({ id: decision.supersededBy })}`;
  if (decision.status !== "answered" || decision.answer === null) return decision.status;
  const { optionKey, words } = decision.answer;
  if (optionKey !== null) {
    const label = decision.options.find((option) => option.key === optionKey)?.label;
    return handoverText(label === undefined ? optionKey : `${optionKey} — ${label}`);
  }
  return words === null ? "answered in chat" : handoverText(`other — ${words}`);
}

/** The `questions` block of a Worker handover: `unknown`, `none`, or one line per question in number order. */
function questionsBlock(decisions: readonly Decision[] | null, requestId: string | null): string[] {
  if (decisions === null || requestId === null) return ["questions: unknown"];
  const asked = decisions.filter((decision) => decision.requestId === requestId).sort((a, b) => questionNumber(a) - questionNumber(b));
  if (asked.length === 0) return ["questions: none"];
  return ["questions:", ...asked.map((decision) => `- ${questionIdOf(decision)}: ${handoverText(decision.question)} → ${outcomeOf(decision)}`)];
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

/** What a Worker handover says of the request, from the stores (the table above). */
export interface WorkerHandoverFacts {
  /** The request's latest `BM-REPORT`; null when there is none, or it could not be read. */
  report: ParsedReport | null;
  tier: Tier | null;
  /** `n of m`, `n of an unknown budget`, or `unknown`. */
  reviewCalls: string;
  /** The `questions` block: `questions: unknown`, `questions: none`, or its header and one line per question. */
  questions: string[];
  /** The first `user_message` of the Worker's timeline, masked; null when it could not be read. */
  original: string | null;
}

/**
 * The facts a Worker handover gives about `subject` — the request of the
 * Worker `agentId` in `workspaceId` — each raced against the budget. Never
 * throws: a part it cannot get in time reads `unknown` (or null).
 */
export async function workerHandoverFacts(subject: { workspaceId: string; requestId: string | null; agentId: string }, deps: HandoverDeps): Promise<WorkerHandoverFacts> {
  const budget = deps.budgetMs ?? HANDOVER_BUDGET_MS;
  const { requestId, workspaceId } = subject;
  const records =
    deps.location === null ? null : await within(budget, () => readRecords(deps.location!, workspaceId).records);
  const [report, review, original, questions] = await Promise.all([
    within(budget, () => (records === null || requestId === null ? null : latestReport(records, requestId))),
    within(budget, async () => {
      if (records === null || requestId === null) return null;
      // The same count as the BM-BUDGET check (delta 20260921 §4.5.1).
      const [facts, replacementIds] = await Promise.all([
        agentFactsOf(deps.paseo as DashboardPaseo, workspaceId),
        deps.incidents === undefined ? reviewerReplacementsFor() : reviewerReplacementIds(deps.incidents ?? []),
      ]);
      return reconstructTraces({ records, agents: [...facts.values()], replacementIds }).find((trace) => trace.requestId === requestId) ?? null;
    }),
    within(budget, () => firstUserMessage(deps.paseo, subject.agentId)),
    within(budget, () => questionDecisionsOf(deps.location, workspaceId)),
  ]);

  const tier = report?.tier ?? review?.tier ?? null;
  const calls = review?.reviewCalls ?? null;
  // The owner's budget, from the data folder the traces are in (§G.7); without a store, the defaults.
  const reviewBudget = deps.location === null ? REVIEW_BUDGET : readReviewBudget({ home: dirname(deps.location.tracesDir), ...(deps.log === undefined ? {} : { log: deps.log }) });
  const reviewCalls = calls === null ? "unknown" : tier === null ? `${calls} of an unknown budget` : `${calls} of ${reviewBudget[tier]}`;
  return { report, tier, reviewCalls, questions: questionsBlock(questions, requestId), original };
}

/**
 * The `BM-HANDOVER` block that starts the replacement of `incident`'s Worker.
 * Never throws: every part it cannot get in time reads `unknown`.
 */
export async function workerHandover(incident: FallbackIncident, deps: HandoverDeps): Promise<string> {
  const requestId = incident.requestId;
  const { report, tier, reviewCalls, questions, original } = await workerHandoverFacts({ workspaceId: incident.workspaceId, requestId, agentId: incident.agentId }, deps);

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
    ...questions,
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
  /** What the plugin sent the old Manager (the send log); by default the collector's reading beside the trace store. */
  pluginSent?: PluginSent;
}

/** The SDK slice that reads one agent's snapshot; `PaseoApi` is structurally assignable. */
interface SnapshotPaseo {
  agents: { ref?(agentId: string): { refresh?(): Promise<{ agent?: unknown } | null> } };
}

/** What a Manager handover reads from the old Manager's timeline, filled page by page. */
interface ManagerTimeline {
  /** Pages read so far. */
  pages: number;
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

/** Whether the plugin sent this message to the agent around `at`: the collector's reading of the send log (`pluginSentBeside`). */
export type PluginSent = (agentId: string, text: string, at: string | null) => boolean;

/**
 * The text of a message the user typed in the app: a `user_message` with
 * `clientMessageId` (AGENTS.md), and neither a plugin notice, a handover, nor
 * what the plugin's send log says it sent that agent — the `/compact` of a
 * compaction carries a `clientMessageId` and no marker (autonomy design §G.5),
 * so it reads as the plugin's, as the collector reads it, never the owner's.
 */
function typedText(entry: { item?: unknown; timestamp?: unknown }, agentId: string, pluginSent: PluginSent): string | null {
  const message = entry.item as { type?: unknown; text?: unknown; clientMessageId?: unknown } | null | undefined;
  if (message?.type !== "user_message" || typeof message.clientMessageId !== "string") return null;
  const text = nonEmpty(message.text);
  if (text === null || isPluginNotice(text) || text.startsWith(HANDOVER_MARKER)) return null;
  return pluginSent(agentId, text, typeof entry.timestamp === "string" ? entry.timestamp : null) ? null : text;
}

/** A quoted user message: masked first, so a secret across the cut is masked whole, then cut. */
function quoted(text: string, env: NodeJS.ProcessEnv): string {
  const masked = redactText(text, env);
  if (masked.length <= QUOTED_MESSAGE_CHARS) return masked;
  return `${masked.slice(0, QUOTED_MESSAGE_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/**
 * Reads the old Manager's timeline back to its start (bounded) into `into`:
 * the user's newest messages. Filled as pages arrive, so what was read before
 * the budget ran out still counts.
 */
async function readManagerTimeline(paseo: unknown, managerId: string, into: ManagerTimeline, env: NodeJS.ProcessEnv, pluginSent: PluginSent): Promise<true> {
  await readTimelinePages(paseo as LiveTimelinePaseo, managerId, { pages: LIVE_MAX_PAGES, limit: MANAGER_TIMELINE_LIMIT }, (entries) => {
    // Pages come newest first, each oldest first.
    const newestFirst = [...entries].reverse();
    into.pages += 1;
    for (const entry of newestFirst) {
      if (into.typed.length >= QUOTED_MESSAGES) break;
      const text = typedText(entry, managerId, pluginSent);
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

/** `workerId: Q1, Q2; …` — each listed Worker's unsettled questions, by its request — or `none`. */
function openQuestionsOf(workers: readonly ChatPeer[], decisions: readonly Decision[]): string {
  const parts = workers.flatMap((worker) => {
    const open = decisions
      .filter((decision) => worker.requestId !== null && decision.requestId === worker.requestId && isAnswerable(decision))
      .sort((a, b) => questionNumber(a) - questionNumber(b))
      .map(questionIdOf);
    return open.length === 0 ? [] : [`${worker.id}: ${open.join(", ")}`];
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
  const timeline: ManagerTimeline = { pages: 0, typed: [] };

  const pluginSent = deps.pluginSent ?? pluginSentBeside(deps.location);
  const walking = within(budget, () => readManagerTimeline(deps.paseo, managerId, timeline, deps.env ?? process.env, pluginSent));
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
  // What is still open is what the decision store holds unsettled (autonomy design §A.4).
  const questions = await within(left(), () => questionDecisionsOf(deps.location, workspaceId));
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
    `openQuestions: ${workers === null || questions === null ? "unknown" : openQuestionsOf(workers, questions)}`,
    `openIncidents: ${openIncidentsOf(incident, deps.incidents)}`,
    "",
    "The user's last messages to the Manager you replace (oldest first, verbatim):",
    ...messages,
    "",
    MANAGER_CLOSING,
  ].join("\n");
}
