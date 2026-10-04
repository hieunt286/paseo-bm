/**
 * Handoff on the Orchestrator's request (autonomy design §G.6; PRD REQ-135;
 * ADR-021; change-008 C3; bead `7gxw.11`): the sequence the plugin runs once
 * `bm_handoff` accepted a handoff (`orchestrator-coordination-tools.ts`), kept
 * in `handoff-store.ts` so a reload continues it. The Manager creates the
 * successor: the plugin never creates a Worker (the role pairing, §A.10).
 *
 * 1. **The safe point.** The outgoing Worker's turn that just ended (the
 *    collector's `onRecorded`, or its newest one when `bm_handoff` is called)
 *    closed a bead with evidence (a successful `br close`, or a report naming
 *    closed beads), reported `beads-done` or `bead-implemented`, or came
 *    after a review verdict of its own Reviewer (`handoffSafePointIn`). At its
 *    idle moment — nothing else queued for it — the plugin asks for its note.
 *    At most `HANDOFF_SAFE_POINT_WAIT_MS`.
 * 2. **The note** (`BM-HANDOFF`, `noteRequestOf`): `bm_report` with
 *    `handoffNote`. A bound Worker calls it and the
 *    tool stores and delivers the report (its outbox record, which the
 *    collector puts in the Worker's turn record); an unbound Worker posts the
 *    block it returns in its own chat. Either way the collector records it as
 *    the report's `handoffNote`. The Worker's turn the request
 *    started carries it or not; with none, or after `NOTE_WAIT_MS` at any
 *    recorded turn, the plugin goes on without it.
 * 3. **The brief** (`handoffBriefOf`): built on the fallback Worker handover's
 *    facts (`workerHandoverFacts`, change-008 C3) — the latest report, the
 *    review calls, the request's questions with their answers, the original
 *    request — plus the owner's later words, the plan and document paths, the
 *    bead state, the branch and diff stat (read-only `git`) and the note;
 *    masked with `redactText`, at most `HANDOFF_BRIEF_MAX_CHARS` so it travels
 *    inside the command, and kept with the entry.
 * 4. **The command** (`handoffCommandOf`): a `BM-COMMAND` to the Worker's
 *    Manager, `intent: handoff`, `authority: coordination:handoff`, no effect,
 *    the brief in its body, through the one send pipeline (`command-send.ts`:
 *    counted and refused by the loop guard, refused while handoff is off) — at
 *    the Manager's idle moment with nothing queued for it, so a command never
 *    waits in the queue past the owner's switch. At most `MANAGER_WAIT_MS`.
 * 5. **The successor** (`agentCreated`, on `agent.created` through
 *    `agent-labels.ts`'s hook): a Worker whose
 *    labels carry `bm.handoffFrom` = the outgoing Worker, created by that
 *    Manager in the request's workspace, completes the handoff; the outgoing
 *    Worker is labelled `bm.replacedBy` through the Paseo CLI, as the fallback
 *    switch does, is told so by a `BM-REPLACED` notice (`replacedNoticeOf`,
 *    through the notice queue: stop, no report, end the turn) and is never
 *    archived. At most `SUCCESSOR_WAIT_MS` (a later one still completes it).
 *
 * **A bound Manager** (design §16.9; ADR-027 decision 2): when the request's
 * Manager has a live binding, steps 4–5 are
 * the plugin's. Once the brief is built, the plugin creates the successor
 * itself (`create-worker.ts`): `parent` = the Manager, the labels
 * `bm_create_worker` sets plus `bm.handoffFrom`, a bound token, and the
 * `BM-BRIEF worker` line before the brief; the registry appends it to the
 * request's `workerIds` and keeps its `managerId`. The Manager then gets the
 * `BM-COMMAND intent: handoff` through the same pipeline — checked first, so
 * a refusal creates nothing, and counted by the loop guard — but only as
 * information: which Worker replaced which, nothing asked
 * (`handoffInfoCommandOf`). The outgoing Worker is labelled and told as in
 * step 5. An unbound Manager keeps steps 4–5 as above: it would otherwise act
 * on the brief and create a second successor.
 *
 * **Exactly one successor.** Before it creates, the plugin moves the entry
 * from `briefed` to `creating` in one compare-and-set (`claimCreation`): a
 * second turn end that reaches the same entry finds it claimed and creates
 * nothing, and no turn end advances a `creating` entry. A creation that
 * Paseo refused before the hook kept the token ends the handoff `refused`;
 * one that threw after (`creationMayExist`) stays `creating`. A `creating`
 * entry this run is not creating — a reload cut its creation, or Paseo threw
 * after creating — is settled from Paseo: a live Worker labelled
 * `bm.handoffFrom` = the outgoing Worker whose parent is the Manager
 * completes it (at its `agent.created`, or at the next recorded turn from
 * the agent list), with the registry entry and the Manager's information;
 * with none within `CREATING_WAIT_MS` it ends `dropped`, `no-successor`.
 *
 * The owner's Settings switch stops it at once: every step reads
 * `handoff.enabled` first and drops the handoff when it is off.
 *
 * Nothing here throws into the plugin: a failure is one log line.
 */
import { join } from "node:path";
import { parseReports } from "../shared/bm-report";
import type { ParsedReport, TraceRecord } from "../shared/contracts";
import { HANDOFF_BRIEF_MARKER, holdsHandoffBrief, requestFinishedOf } from "../shared/handoff";
import {
  COORDINATION_HANDOFF_AUTHORITY,
  HANDOFF_INTENT,
  MAX_COMMAND_BODY_CHARS,
  MAX_COMMAND_RE_CHARS,
  type CommandInput,
} from "../shared/orchestrator-command";
import { andChainOf, brActions, shellSucceeded } from "../shared/shell";
import { shorten } from "../shared/text";
import { timeOrNull } from "../shared/time";
import { createBindingStore, creationMayExist, liveBindingOf, type AgentBinder } from "./agent-bindings";
import { listAllAgents, parentOf, roleOfProvider } from "./agent-role";
import { redactText, sliceLastTurn } from "./collector";
import { COMMAND_LIMIT_MESSAGE, HANDOFF_OFF_MESSAGE, commandRefusalOf, sendCommand } from "./command-send";
import { createPluginWorker, workerProfileOf, workerTitleOf, type WorkerCreationPaseo } from "./create-worker";
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import { workerHandoverFacts } from "./fallback-handover";
import {
  NOTE_WAIT_MS,
  createHandoffStore,
  endedHandoff,
  isPendingHandoffState,
  type HandoffEnding,
  type HandoffEntry,
  type HandoffStore,
} from "./handoff-store";
import { HANDOFF_NOTICE_MARKER, REPLACED_NOTICE_MARKER, briefLineOf } from "./notices";
import { AGENT_TOOLS_OFF_SWITCH_MESSAGE, agentToolsOff } from "./manager";
import { createRequestRegistry } from "./request-registry";
import { listedWorkspaces, type DashboardPaseo } from "./paseo-directory";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import type { OrchestratorStoreDeps } from "./orchestrator-store";
import { setAgentLabels, type CliResult } from "./paseo-cli";
import { GIT_READ_ONLY_PREFIX, runGit, type GitRunner } from "./repo-tool";
import { asRecord, nonEmpty } from "./role-choices";
import { errorText } from "./rpc-kit";
import { readRecords, readWorkspaceMeta, type TraceStoreLocation } from "./trace-store";

/** The label the Manager gives the successor: the outgoing Worker's id (change-008 C3). */
export const HANDOFF_FROM_LABEL = "bm.handoffFrom";
/** The label the outgoing Worker gets: its successor's id (as the fallback switch sets it). */
export const REPLACED_BY_LABEL = "bm.replacedBy";

/** The notice-queue batch the note request goes in: one item, the request itself. */
export const NOTE_BATCH_NAME = HANDOFF_NOTICE_MARKER;
/** A note request still queued this long after its safe moment is dropped; the next safe point sends it again. */
export const NOTE_SEND_MS = 60_000;
/** How much earlier than the note request's send a turn may be marked as started and still be its answer. */
export const NOTE_START_SLACK_MS = 5_000;

/**
 * The most characters of a brief: what fits in the command's body beside the
 * Manager's instructions (`MAX_COMMAND_BODY_CHARS`), so the Manager passes it
 * on in one piece. The entry keeps the note whole beside it.
 */
export const HANDOFF_BRIEF_MAX_CHARS = MAX_COMMAND_BODY_CHARS - 800;

/** How long each store or `git` read of the brief may take. */
export const BRIEF_BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// The safe point.
// ---------------------------------------------------------------------------

/** A tool's own name, without its MCP server prefix. */
function toolBaseName(name: unknown): string {
  return typeof name === "string" ? (name.split(/__|\./).pop() ?? "") : "";
}

/** The reports a turn sent with `send_agent_prompt` (worker.md, Reporting): the Worker's own record does not hold them. */
function sentReportsIn(items: readonly unknown[], agentId: string, at: string): ParsedReport[] {
  return sliceLastTurn(items).flatMap((raw) => {
    const item = asRecord(raw);
    if (item === null || item["type"] !== "tool_call" || toolBaseName(item["name"]) !== "send_agent_prompt") return [];
    const detail = asRecord(item["detail"]);
    const input = asRecord(detail?.["input"] ?? item["input"]);
    const prompt = input?.["prompt"];
    return typeof prompt === "string" ? parseReports(prompt, { agentId, at }) : [];
  });
}

/** The phases that close a step of the plan (design §G.6: `beads-done`, a bead implemented). */
const SAFE_PHASES: ReadonlySet<string> = new Set(["beads-done", "bead-implemented"]);

const endOf = (record: Pick<TraceRecord, "endedAt" | "at">): number => timeOrNull(record.endedAt) ?? timeOrNull(record.at) ?? 0;

/**
 * Whether a Worker's recorded turn ended at a safe point for a handoff
 * (design §G.6): it closed a bead with evidence — a successful `br close`, or
 * a report naming closed beads — or reported `beads-done` or
 * `bead-implemented` (in its chat, or sent with `send_agent_prompt`, from
 * `items`, the turn's timeline), or a review verdict of its own Reviewer was
 * recorded after its turn before this one and by this one's end (`records`,
 * the workspace's). Pure.
 */
export function handoffSafePointIn(record: TraceRecord, items: readonly unknown[] = [], records: readonly TraceRecord[] = []): boolean {
  const at = record.endedAt ?? record.at;
  const reports = [...record.reports, ...sentReportsIn(items, record.agentId, at)];
  if (reports.some((report) => (report.phase !== null && SAFE_PHASES.has(report.phase)) || report.beadsClosed.length > 0)) return true;
  const closed = record.evidence.some(
    (evidence) =>
      evidence.kind === "shell" &&
      shellSucceeded(evidence.status ?? null, evidence.exitCode ?? null) &&
      andChainOf(evidence.detail) !== null &&
      brActions(evidence.detail).some((action) => action.verb === "close" && action.ids.length > 0),
  );
  if (closed) return true;
  const end = endOf(record);
  const before = records
    .filter((other) => other.agentId === record.agentId && endOf(other) < end)
    .reduce((latest, other) => Math.max(latest, endOf(other)), Number.NEGATIVE_INFINITY);
  return records.some(
    (other) =>
      other.role === "reviewer" &&
      other.parentAgentId === record.agentId &&
      other.reviews.some((review) => review.verdict !== null) &&
      endOf(other) > before &&
      endOf(other) <= end,
  );
}

/** The newest timeline items of an agent, oldest first: one page from the tail; none when it cannot be read. */
async function tailItemsOf(paseo: unknown, agentId: string): Promise<unknown[]> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { timeline?: { refetch?: (options: Record<string, unknown>) => Promise<unknown> } } } } | null)
      ?.agents?.ref?.(agentId);
    const payload = (await ref?.timeline?.refetch?.({ direction: "tail", limit: 200 })) as { entries?: Array<{ item?: unknown }> } | undefined;
    return (payload?.entries ?? []).map((entry) => entry.item).filter((item) => item !== undefined && item !== null);
  } catch {
    return [];
  }
}

/** Whether another notice is queued for `agentId`: its own note request, held from an earlier moment, does not count. */
function othersQueued(queue: Pick<NoticeQueue, "pending">, agentId: string): boolean {
  return queue.pending(agentId).some((notice) => !notice.kind.startsWith(`${NOTE_BATCH_NAME}:`));
}

/**
 * Whether the outgoing Worker is at its idle moment after a safe point now:
 * not running, nothing queued for it, and its newest recorded turn ended at a
 * safe point (`handoffSafePointIn`, with one page of its timeline). Never throws.
 */
export async function handoffSafeNow(
  worker: { id: string; status: string },
  paseo: unknown,
  records: readonly TraceRecord[],
  queue: Pick<NoticeQueue, "pending"> = noticeQueue,
): Promise<boolean> {
  if (worker.status === "running" || worker.status === "initializing") return false;
  if (othersQueued(queue, worker.id)) return false;
  const newest = records.filter((record) => record.agentId === worker.id).sort((a, b) => endOf(a) - endOf(b)).at(-1);
  if (newest === undefined) return false;
  return handoffSafePointIn(newest, await tailItemsOf(paseo, worker.id), records);
}

// ---------------------------------------------------------------------------
// The note.
// ---------------------------------------------------------------------------

/**
 * The plugin's request for the outgoing Worker's note (design §G.6 step 1).
 * A bound Worker (`bound`, design §16.5) calls
 * `bm_report`, which stores and delivers the report; an unbound one posts the
 * block its builder returns in its own chat.
 */
export function noteRequestOf(entry: Pick<HandoffEntry, "requestId">, options: { bound?: boolean } = {}): string {
  const what = `call bm_report for ${entry.requestId} with the phase and facts of your last report and handoffNote — what you tried and what is next, at most 1,500 characters`;
  return [
    HANDOFF_NOTICE_MARKER,
    `From the paseo-bm plugin, not the owner: the Orchestrator hands request ${entry.requestId} over to a new Worker, who starts from a brief the plugin builds from its records.`,
    options.bound === true
      ? `Write your handoff note now: ${what}. The tool stores the note and delivers the report; send nothing else.`
      : `Write your handoff note now: ${what} — and post the block it returns as your reply here; do not send it to your Manager.`,
    "Then end this turn and start nothing new: your Manager tells you when the new Worker takes over.",
  ].join("\n");
}

/**
 * The note in a Worker's turn: `handoffNote` of a report of the request — in
 * its chat or sent (unbound), or stored by its `bm_report` (bound: the
 * collector puts the outbox record's report in the turn record); null when it
 * wrote none.
 */
export function noteIn(record: TraceRecord, items: readonly unknown[], requestId: string): string | null {
  const reports = [...record.reports, ...sentReportsIn(items, record.agentId, record.endedAt ?? record.at)];
  const found = reports.filter((report) => report.handoffNote !== undefined && (report.requestId === null || report.requestId === requestId)).at(-1);
  return found?.handoffNote ?? null;
}

/**
 * The plugin's word to the outgoing Worker once its successor appeared (design
 * §G.6 step 3): stop, and end the turn. No report: the successor reports for
 * the request now, and a `finished` from the old Worker would end it.
 */
export function replacedNoticeOf(entry: Pick<HandoffEntry, "requestId">, successorId: string): string {
  return [
    REPLACED_NOTICE_MARKER,
    `From the paseo-bm plugin, not the owner: request ${entry.requestId} is handed over to Worker ${successorId}, who continues it from a brief of the records.`,
    "Stop working on it: change nothing more, send no report, and end this turn. Then stay idle.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The brief.
// ---------------------------------------------------------------------------

/** What `handoffBriefOf` reads. */
export interface BriefDeps {
  paseo: unknown;
  location: TraceStoreLocation | null;
  env?: NodeJS.ProcessEnv;
  git?: GitRunner;
  log?: (message: string) => void;
  budgetMs?: number;
}

/** `work()` within `budget` ms, or null on timeout or failure. Never throws. */
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

/** A plan, a design or another document among the files changed. */
const DOC_PATH = /(?:^|\/)(?:docs?|plans?|design|adr)\/|\.(?:md|mdx|rst|adoc)$/i;

const listed = (values: readonly string[], max: number): string => (values.length === 0 ? "none" : shorten([...new Set(values)].join(", "), max));
const text = (value: string | null | undefined, max: number): string => (value === null || value === undefined || value.trim() === "" ? "none" : shorten(value, max));

/** The `request:` line of an earlier brief: a successor's first message is its brief, whose request is the owner's. */
function requestOfBrief(brief: string): string | null {
  const line = brief.split("\n").find((candidate) => candidate.startsWith("request: "));
  return line === undefined ? null : line.slice("request: ".length);
}

/** The folder the Worker works in: its snapshot's `cwd`, else its workspace's as Paseo lists it, else the one the trace store last saw. */
async function folderOf(paseo: unknown, workerId: string, location: TraceStoreLocation | null, workspaceId: string): Promise<string | null> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<{ agent?: unknown } | null> } } } | null)?.agents?.ref?.(workerId);
    const cwd = nonEmpty(asRecord((await ref?.refresh?.())?.agent)?.["cwd"]);
    if (cwd !== null) return cwd;
    const listed = typeof (paseo as Partial<DashboardPaseo> | null)?.workspaces?.list === "function" ? await listedWorkspaces(paseo as DashboardPaseo) : null;
    const directory = listed?.find((entry) => entry.id === workspaceId)?.directory ?? null;
    if (directory !== null) return directory;
  } catch {
    // The trace store's folder, then.
  }
  return location === null ? null : (readWorkspaceMeta(location, workspaceId)?.lastKnownDirectory ?? null);
}

/** The branch and the diff stat against HEAD, one line each; `unknown` when git cannot tell. */
async function gitFacts(folder: string | null, git: GitRunner, budget: number): Promise<{ branch: string; diff: string }> {
  if (folder === null) return { branch: "unknown", diff: "unknown" };
  const run = (args: string[]) => within(budget, async () => (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd: folder, maxBytes: 64 * 1024 })).stdout.trim());
  const [branch, diff] = await Promise.all([run(["rev-parse", "--abbrev-ref", "HEAD"]), run(["diff", "--shortstat", "HEAD"])]);
  return { branch: branch === null || branch === "" ? "unknown" : shorten(branch, 120), diff: diff === null ? "unknown" : diff === "" ? "no change against HEAD" : shorten(diff, 200) };
}

/** The last paragraph of the brief: what the successor does with it (design §G.6 steps 4–5). */
export function briefClosingOf(workerId: string): string {
  return [
    `You take this request over from Worker ${workerId}: the Orchestrator handed it over so the work goes on in a fresh context.`,
    "Work from this brief and the repository, not from memory: read `git status` and `git diff` first — every change there belongs to the request, so never revert it — and go on from the note.",
    "The questions above are settled: never ask an answered one again.",
    "Nothing counts as done until you prove it again: run each check after your last edit before a report says it passes.",
    "Send `received` to `managerAgentId` now.",
  ].join(" ");
}

/**
 * The brief of `entry` (design §G.6 step 2): built on the fallback Worker
 * handover's facts, masked, at most `HANDOFF_BRIEF_MAX_CHARS` — the note is
 * cut first, then the facts; the closing paragraph always stays. Never
 * throws: a part it cannot get in time reads `unknown`.
 */
export async function handoffBriefOf(entry: HandoffEntry, deps: BriefDeps): Promise<string> {
  const budget = deps.budgetMs ?? BRIEF_BUDGET_MS;
  const env = deps.env ?? process.env;
  const facts = await workerHandoverFacts(
    { workspaceId: entry.workspaceId, requestId: entry.requestId, agentId: entry.workerId },
    { paseo: deps.paseo, location: deps.location, budgetMs: budget, ...(deps.log === undefined ? {} : { log: deps.log }) },
  );
  const records = deps.location === null ? [] : ((await within(budget, () => readRecords(deps.location!, entry.workspaceId).records)) ?? []);
  const own = records.filter((record) => record.requestId === entry.requestId).sort((a, b) => endOf(a) - endOf(b));
  const reports = own
    .flatMap((record) => record.reports)
    .filter((report) => report.requestId === null || report.requestId === entry.requestId)
    .sort((a, b) => (timeOrNull(a.at) ?? 0) - (timeOrNull(b.at) ?? 0));
  const owner = own.flatMap((record) => record.sent.filter((message) => message.origin === "user")).sort((a, b) => (timeOrNull(a.at) ?? 0) - (timeOrNull(b.at) ?? 0));
  const latest = facts.report ?? reports.at(-1) ?? null;
  // The owner's own first words, as recorded; else the Worker's first message — for a successor, the
  // request line of its own brief.
  const fromWorker = facts.original === null ? null : holdsHandoffBrief(facts.original) ? requestOfBrief(facts.original) : facts.original;
  const original = owner[0]?.text ?? fromWorker;
  const later = owner.slice(1).slice(-3);
  const all = <K extends "filesChanged" | "beadsCreated" | "beadsClosed">(key: K) => reports.flatMap((report) => report[key]);
  const { branch, diff } = await gitFacts(await folderOf(deps.paseo, entry.workerId, deps.location, entry.workspaceId), deps.git ?? runGit, budget);
  const questions = facts.questions.length <= 1 ? facts.questions : [facts.questions[0]!, ...facts.questions.slice(1).map((line) => shorten(line, 200))];

  const head = [
    `${HANDOFF_BRIEF_MARKER} ${entry.id}`,
    "role: worker",
    `requestId: ${entry.requestId}`,
    `managerAgentId: ${entry.managerId}`,
    `replaces: ${entry.workerId}`,
    `reason: ${text(entry.reason, 300)}`,
    `request: ${text(original, 700)}`,
    later.length === 0 ? "ownerSaid: nothing more" : `ownerSaid: ${later.map((message) => shorten(message.text, 200)).join(" | ")}`,
    ...questions.slice(0, 6),
    `decided: ${latest === null ? "none" : listed(latest.decided ?? [], 300)}`,
    `planAndDocs: ${listed(all("filesChanged").filter((path) => DOC_PATH.test(path)), 250)}`,
    `beadsClosed: ${listed(all("beadsClosed"), 250)}`,
    `beadsReady: ${listed(latest?.beadsReady ?? [], 200)}`,
    `beadsCreated: ${listed(all("beadsCreated"), 200)}`,
    `blockers: ${text(latest?.blockers, 200)}`,
    `lastReport: ${latest === null ? "none" : `${latest.phase ?? "unknown"} at ${latest.at}`}`,
    `tier: ${facts.tier ?? latest?.tier ?? "unknown"}`,
    `filesChanged: ${listed(all("filesChanged"), 300)}`,
    `checks: ${text(latest?.buildAndTests, 250)}`,
    `reviewFindingsOpen: ${text(latest?.reviewFindingsOpen, 300)}`,
    `reviewCalls: ${facts.reviewCalls}`,
    `branch: ${branch}`,
    `diffStat: ${diff}`,
  ];
  const closing = briefClosingOf(entry.workerId);
  const noteLine = (max: number) => `note: ${entry.note === null ? "none — the outgoing Worker wrote no note" : shorten(entry.note, Math.max(40, max))}`;
  const compose = (note: string) => redactText([...head, note, "", closing].join("\n"), env);
  let brief = compose(noteLine(1_500));
  if (brief.length > HANDOFF_BRIEF_MAX_CHARS) brief = compose(noteLine(1_500 - (brief.length - HANDOFF_BRIEF_MAX_CHARS)));
  if (brief.length <= HANDOFF_BRIEF_MAX_CHARS) return brief;
  // Still too long: the facts are cut, the closing paragraph kept.
  const tail = `\n…\n\n${closing}`;
  return `${brief.slice(0, HANDOFF_BRIEF_MAX_CHARS - tail.length).trimEnd()}${tail}`;
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

/** What the Manager is told before the brief (manager.md, the handoff rule). */
export function handoffHeaderOf(entry: Pick<HandoffEntry, "id" | "requestId" | "workerId">): string {
  return [
    `Handoff ${entry.id}: the Orchestrator hands request ${entry.requestId} over from Worker ${entry.workerId} to a new Worker, as your handoff rule says.`,
    `Create it with create_agent — labels bm.role = worker, bm.requestId = ${entry.requestId}, ${HANDOFF_FROM_LABEL} = ${entry.workerId} — and as its first message the brief below, verbatim, from its ${HANDOFF_BRIEF_MARKER} line to its end.`,
    `Then tell Worker ${entry.workerId} it is replaced by the new id and must stay idle, and tell the owner in one line.`,
  ].join(" ");
}

/**
 * The `BM-COMMAND` of a handoff (design §G.6 step 3, change-008 C3): from the
 * Orchestrator to the Worker's Manager, `intent: handoff` on
 * `coordination:handoff`, no effect declared or approved, the Manager's
 * instructions then the brief in its body (cut to fit), the Orchestrator's
 * reason as its `why:`.
 */
export function handoffCommandOf(entry: Pick<HandoffEntry, "id" | "requestId" | "workerId" | "reason">, brief: string): CommandInput {
  const header = handoffHeaderOf(entry);
  const room = MAX_COMMAND_BODY_CHARS - header.length - 2;
  const body = `${header}\n\n${brief.length <= room ? brief : `${brief.slice(0, room - 2).trimEnd()}\n…`}`;
  return {
    from: "orchestrator",
    via: "chat",
    to: "manager",
    requestId: entry.requestId,
    re: shorten(`Hand request ${entry.requestId} over to a new Worker`, MAX_COMMAND_RE_CHARS),
    body,
    why: entry.reason.trim() === "" ? null : entry.reason,
    intent: HANDOFF_INTENT,
    effects: [],
    authority: COORDINATION_HANDOFF_AUTHORITY,
    approved: [],
  };
}

/**
 * What a bound Manager is told once the plugin created the successor (design
 * §16.9): which Worker replaced which, and that nothing is asked of it.
 */
export function handoffInfoOf(entry: Pick<HandoffEntry, "id" | "requestId" | "workerId">, successorId: string): string {
  return [
    `Handoff ${entry.id}, for your information: the Orchestrator handed request ${entry.requestId} over from Worker ${entry.workerId} to Worker ${successorId}, which paseo-bm created under you from a brief of the records.`,
    `Worker ${entry.workerId} is replaced and was told to stay idle; Worker ${successorId} works on the request and reports to you from now on.`,
    "Nothing is asked of you: create no Worker and send neither Worker anything for this handoff.",
  ].join(" ");
}

/**
 * The `BM-COMMAND` a bound Manager gets after the plugin created the
 * successor (design §16.9): the handoff's intent and authority, so the loop
 * guard counts it, with only the information in its body.
 */
export function handoffInfoCommandOf(entry: Pick<HandoffEntry, "id" | "requestId" | "workerId" | "reason">, successorId: string): CommandInput {
  return {
    ...handoffCommandOf(entry, ""),
    re: shorten(`Request ${entry.requestId} was handed over to Worker ${successorId}`, MAX_COMMAND_RE_CHARS),
    body: handoffInfoOf(entry, successorId),
  };
}

/** The ending of a handoff whose command the send's checks refused. */
function refusedEnding(reason: string): HandoffEnding {
  return reason === COMMAND_LIMIT_MESSAGE ? "loop-guard" : reason === HANDOFF_OFF_MESSAGE ? "off" : "refused";
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

export interface HandoffRunnerDeps extends DataHomeDeps {
  /** The notice queue; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue" | "enqueueBatch" | "pending">;
  /** The data folder; `resolveDataHome` by default. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** Secrets to mask in the brief; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
  /** How the brief reads the branch and diff stat; `runGit` by default. */
  git?: GitRunner;
  /** Labels the outgoing Worker (`bm.replacedBy`); the Paseo CLI by default. */
  setLabels?: (agentId: string, labels: Record<string, string>) => Promise<CliResult>;
  /** The commands store's own deps (fixed ids and time in tests). */
  store?: OrchestratorStoreDeps;
  /** How long each read of the brief may take. */
  budgetMs?: number;
  /**
   * Binds a successor the plugin creates for a bound Manager (design §16.9);
   * the endpoint's binder, read when one is created. None: the successor is
   * created unbound.
   */
  binder?: () => AgentBinder;
}

/** The fields of the `agent.created` event's agent the successor check reads. */
export interface CreatedAgent {
  id: string;
  provider: unknown;
  parentAgentId?: string | null;
  workspaceId?: string | null;
}

export interface HandoffRunner {
  /**
   * Right after `bm_handoff` recorded `entry`: asks for the note now when
   * `safe` says the Worker is at its idle moment after a safe point, else
   * leaves it waiting for one. Never rejects.
   */
  begin(entry: HandoffEntry, paseo: unknown, safe: boolean): Promise<"asked" | "queued" | "waiting">;
  /**
   * One recorded turn (the collector's `onRecorded`): each pending handoff
   * takes its next step — the note request at the outgoing Worker's safe
   * point, the brief once its note came (or did not in time), the command at
   * the Manager's idle moment. Never rejects.
   */
  turnRecorded(event: unknown, record: TraceRecord | null | undefined, paseo: unknown): Promise<void>;
  /**
   * `agent.created`: a Worker labelled `bm.handoffFrom` that its handoff's
   * Manager created completes it; the outgoing Worker gets `bm.replacedBy`
   * and a `BM-REPLACED` notice.
   * Returns the completed entry, or null. Never rejects.
   */
  agentCreated(agent: CreatedAgent, paseo: unknown): Promise<HandoffEntry | null>;
  /** The notice queue it sends through (`handoffSafeNow` reads what is queued). */
  readonly queue: Pick<NoticeQueue, "pending">;
}

/** An agent's snapshot, or null when it cannot be read. */
async function snapshotOf(paseo: unknown, agentId: string): Promise<Record<string, unknown> | null> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { refresh?: () => Promise<{ agent?: unknown } | null> } } } | null)?.agents?.ref?.(agentId);
    return asRecord((await ref?.refresh?.())?.agent);
  } catch {
    return null;
  }
}

export function createHandoffRunner(deps: HandoffRunnerDeps = {}): HandoffRunner {
  const queue = deps.queue ?? noticeQueue;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.warn(message));
  const homeOf = (): string | null => {
    try {
      return deps.home === undefined ? resolveDataHome(deps).home : deps.home();
    } catch {
      return null;
    }
  };
  const storeOf = (home: string): HandoffStore => createHandoffStore(home, { now });
  const locationOf = (home: string): TraceStoreLocation => ({ tracesDir: join(home, TRACES_DIR_NAME) });
  const recordsOf = (home: string, workspaceId: string): TraceRecord[] => {
    try {
      return readRecords(locationOf(home), workspaceId).records;
    } catch {
      return [];
    }
  };
  const end = (store: HandoffStore, entry: HandoffEntry, ending: HandoffEnding): void => {
    store.update(entry.id, (current) => (isPendingHandoffState(current.state) ? endedHandoff(current, ending, now().toISOString()) : current));
    log(`[paseo-bm] handoff ${entry.id} of request ${entry.requestId} ended without a successor: ${ending}.`);
  };

  /** Its note request went out: `noting` from now. */
  const noteBatch: NoticeBatch = {
    name: NOTE_BATCH_NAME,
    // One item per batch; were two ever pending, only the newest goes.
    compose: (lines) => lines[lines.length - 1]!,
    onSent: (_targetId, keys) => {
      const home = homeOf();
      if (home === null) return;
      for (const id of keys) {
        storeOf(home).update(id, (entry) => (entry.state === "waiting" ? { ...entry, state: "noting", noteAskedAt: now().toISOString() } : entry));
      }
    },
  };

  /** At the idle moment, synchronously: still waiting, handoff still on, and not held past its safe moment. */
  const currentAt =
    (id: string, enqueuedAt: number) =>
    (): boolean => {
      const home = homeOf();
      if (home === null) return false;
      const entry = storeOf(home).get(id);
      if (entry === null || entry.state !== "waiting") return false;
      if (!readCoordinationSettings({ home, log }).handoff.enabled) return false;
      return now().getTime() - enqueuedAt <= NOTE_SEND_MS;
    };

  async function askNote(entry: HandoffEntry, paseo: unknown): Promise<"asked" | "queued" | "waiting"> {
    const home = homeOf();
    const bound = home !== null && isBound(home, entry.workerId);
    const item: BatchItem = { key: entry.id, line: noteRequestOf(entry, { bound }), isCurrent: currentAt(entry.id, now().getTime()) };
    const [outcome] = await queue.enqueueBatch(entry.workerId, noteBatch, [item], paseo as NoticePaseo | undefined);
    return outcome === "sent" ? "asked" : outcome === "queued" ? "queued" : "waiting";
  }

  /** The brief from the stores and the note (or none), kept with the entry: `briefed`. */
  async function brief(home: string, entry: HandoffEntry, note: string | null, paseo: unknown): Promise<HandoffEntry | null> {
    const env = deps.redactEnv ?? process.env;
    const masked = note === null ? null : shorten(redactText(note, env), 1_500);
    const withNote = { ...entry, note: masked };
    const text = await handoffBriefOf(withNote, {
      paseo,
      location: locationOf(home),
      env,
      log,
      ...(deps.git === undefined ? {} : { git: deps.git }),
      ...(deps.budgetMs === undefined ? {} : { budgetMs: deps.budgetMs }),
    });
    return storeOf(home).update(entry.id, (current) =>
      current.state === "noting" ? { ...current, state: "briefed", note: masked, brief: text, briefAt: now().toISOString() } : current,
    );
  }

  /** The command, at the Manager's idle moment with nothing queued for it; else it waits for a later turn end. */
  async function command(home: string, entry: HandoffEntry, paseo: unknown): Promise<void> {
    const store = storeOf(home);
    if (entry.brief === null) return;
    if (requestFinishedOf(recordsOf(home, entry.workspaceId), entry.requestId)) return end(store, entry, "finished");
    const manager = await snapshotOf(paseo, entry.managerId);
    if (manager === null || nonEmpty(manager["archivedAt"]) !== null) return end(store, entry, "no-manager");
    // Design §16.9: a bound Manager is only informed; the plugin creates the successor, busy Manager or not.
    if (isBound(home, entry.managerId)) return succeed(home, entry, paseo);
    const status = nonEmpty(manager["status"]);
    if (status === "running" || status === "initializing" || othersQueued(queue, entry.managerId)) return;
    const result = await sendCommand({
      home,
      now: now(),
      paseo: paseo as NoticePaseo,
      workspaceId: entry.workspaceId,
      command: handoffCommandOf(entry, entry.brief),
      targetId: entry.managerId,
      copyTo: null,
      grantOf: null,
      approved: [],
      // The body is the plugin's brief of the records, declaring and approving nothing: there is nothing to backstop.
      backstop: false,
      loopGuard: "refuse",
      // Logged once, as the handoff, by bm_handoff.
      intervention: null,
      queue,
      ...(deps.store === undefined ? {} : { store: deps.store }),
      ...(deps.redactEnv === undefined ? {} : { redactEnv: deps.redactEnv }),
      log,
    });
    if (!result.ok) {
      log(`[paseo-bm] the handoff command of ${entry.id} was not sent: ${result.reason}`);
      const ending: HandoffEnding =
        result.stage === "delivery" ? "unreachable" : result.reason === COMMAND_LIMIT_MESSAGE ? "loop-guard" : readCoordinationSettings({ home, log }).handoff.enabled ? "refused" : "off";
      return end(store, entry, ending);
    }
    if (result.unrecorded !== null) log(`[paseo-bm] the handoff command of ${entry.id} went out but was not recorded: ${result.unrecorded}`);
    store.update(entry.id, (current) => ({ ...current, state: "commanded", commandId: result.id, commandSentAt: now().toISOString() }));
  }

  /**
   * True when `agentId` has a live binding (`liveBindingOf`): a bound Manager's
   * successor is the plugin's to create (design §16.9), a bound Worker's
   * `bm_report` stores and delivers (§16.7). Never throws.
   */
  function isBound(home: string, agentId: string): boolean {
    try {
      return liveBindingOf(createBindingStore(home).list(), agentId) !== null;
    } catch {
      return false;
    }
  }

  /**
   * The successor appeared — created by the Manager or by the plugin: the
   * entry is done, the outgoing Worker is labelled `bm.replacedBy` (never
   * archived) and told by a `BM-REPLACED` notice.
   */
  async function complete(store: HandoffStore, entry: HandoffEntry, successorId: string, paseo: unknown, extra: Partial<HandoffEntry> = {}): Promise<HandoffEntry | null> {
    const at = now().toISOString();
    const done = store.update(entry.id, (current) => ({ ...current, ...extra, state: "done", successorId, successorAt: at, endedAt: at, ending: null }));
    // Never archived: the outgoing Worker stays, marked replaced, so delivery, the materialiser and the chat peers skip it.
    const labelled = await (deps.setLabels ?? ((id: string, next: Record<string, string>) => setAgentLabels(id, next)))(entry.workerId, { [REPLACED_BY_LABEL]: successorId });
    if (!labelled.ok) log(`[paseo-bm] could not label Worker ${entry.workerId} as replaced by ${successorId}: ${labelled.reason}`);
    // The plugin tells it, at its idle moment through the queue: the Manager's own word may not reach it (live check F4).
    const told = await queue.enqueue(entry.workerId, REPLACED_NOTICE_MARKER, replacedNoticeOf(entry, successorId), paseo as NoticePaseo | undefined);
    if (told === "dropped") log(`[paseo-bm] could not tell Worker ${entry.workerId} that Worker ${successorId} took its request over.`);
    return done;
  }

  /** Outgoing Workers whose successor the plugin is creating now, in this run: their `agent.created` completes nothing. */
  const creating = new Set<string>();
  /** `creating` entries this run already looked up in Paseo (`reconcileCreating`). */
  const reconciled = new Set<string>();

  /** The checks of the Manager's informational command: the send's own, as `sendCommand` runs them. */
  const checksOf = (home: string, entry: HandoffEntry) => ({
    home,
    now: now(),
    workspaceId: entry.workspaceId,
    backstop: false,
    loopGuard: "refuse" as const,
    log,
    ...(deps.store === undefined ? {} : { store: deps.store }),
  });

  /**
   * The successor the plugin created for a bound Manager exists: its registry
   * entry (design §16.4: the request keeps its id and its Manager), the
   * Manager's informational command through the one pipeline (counted by the
   * loop guard), and the outgoing Worker labelled and told (`complete`).
   */
  async function finishCreated(home: string, entry: HandoffEntry, successorId: string, paseo: unknown): Promise<HandoffEntry | null> {
    try {
      createRequestRegistry(home, { log }).register(entry.workspaceId, entry.requestId, { source: "agent-typed", managerId: entry.managerId, workerId: successorId });
    } catch (error) {
      log(`[paseo-bm] could not add Worker ${successorId} to request ${entry.requestId}: ${errorText(error)}`);
    }
    const result = await sendCommand({
      ...checksOf(home, entry),
      paseo: paseo as NoticePaseo,
      command: handoffInfoCommandOf(entry, successorId),
      targetId: entry.managerId,
      copyTo: null,
      grantOf: null,
      approved: [],
      loopGuard: "count",
      intervention: null,
      queue,
      ...(deps.redactEnv === undefined ? {} : { redactEnv: deps.redactEnv }),
    });
    if (!result.ok) log(`[paseo-bm] Manager ${entry.managerId} was not told that Worker ${successorId} took over request ${entry.requestId}: ${result.reason}`);
    else if (result.unrecorded !== null) log(`[paseo-bm] the handoff command of ${entry.id} went out but was not recorded: ${result.unrecorded}`);
    return complete(storeOf(home), entry, successorId, paseo, result.ok ? { commandId: result.id, commandSentAt: now().toISOString() } : {});
  }

  /**
   * A `creating` entry this run is not creating (a reload cut its creation,
   * or Paseo threw after creating): the live Worker labelled `bm.handoffFrom`
   * = its outgoing Worker, created by its Manager in its workspace, completes
   * it. Null when Paseo lists none (or cannot be read). Never throws.
   */
  async function reconcileCreating(home: string, entry: HandoffEntry, paseo: unknown): Promise<HandoffEntry | null> {
    try {
      const list = (paseo as { agents?: { list?: unknown } } | null)?.agents?.list;
      if (typeof list !== "function") return null;
      const agents = await listAllAgents(
        (options: { filter: { labels: Record<string, string>; includeArchived: boolean }; page: { limit: number; cursor?: string } }) =>
          (list as (options: unknown) => Promise<{ entries: Array<{ agent: unknown }>; pageInfo?: { nextCursor: string | null; hasMore: boolean } }>).call(
            (paseo as { agents: unknown }).agents,
            options,
          ),
        { labels: { [HANDOFF_FROM_LABEL]: entry.workerId }, includeArchived: false },
      );
      const taken = new Set(storeOf(home).list().map((candidate) => candidate.successorId));
      const found = agents
        .map((agent) => asRecord(agent))
        .find((agent) => {
          if (agent === null) return false;
          const labels = asRecord(agent["labels"]) ?? {};
          const id = nonEmpty(agent["id"]);
          return (
            id !== null &&
            !taken.has(id) &&
            roleOfProvider(agent["provider"]) === "worker" &&
            nonEmpty(agent["archivedAt"]) === null &&
            nonEmpty(labels[HANDOFF_FROM_LABEL]) === entry.workerId &&
            parentOf(agent) === entry.managerId &&
            (nonEmpty(agent["workspaceId"]) ?? entry.workspaceId) === entry.workspaceId
          );
        });
      const successorId = nonEmpty(found?.["id"]);
      if (successorId === null) return null;
      log(`[paseo-bm] handoff ${entry.id}: Worker ${successorId} is the successor the plugin was creating; it completes the handoff.`);
      return await finishCreated(home, entry, successorId, paseo);
    } catch (error) {
      log(`[paseo-bm] could not look for the successor of handoff ${entry.id}: ${errorText(error)}`);
      return null;
    }
  }

  /**
   * A bound Manager's handoff (design §16.9): claimed first (`briefed` →
   * `creating`, compare-and-set: only one caller creates), then the send's
   * checks, so a refusal creates nothing; then the successor, its registry
   * entry, the Manager's informational command and the outgoing Worker's notice.
   */
  async function succeed(home: string, briefed: HandoffEntry, paseo: unknown): Promise<void> {
    const store = storeOf(home);
    if (briefed.brief === null) return;
    // Exactly one successor: a second turn end, or one after a reload, finds the entry claimed.
    const entry = store.claimCreation(briefed.id);
    if (entry === null || entry.brief === null) return;
    const check = checksOf(home, entry);
    const refusal = commandRefusalOf({ ...check, command: handoffInfoCommandOf(entry, entry.workerId) });
    if (refusal !== null) {
      log(`[paseo-bm] the handoff ${entry.id} created no successor: ${refusal}`);
      return end(store, entry, refusedEnding(refusal));
    }
    const refuse = (why: string): void => {
      log(`[paseo-bm] the handoff ${entry.id} created no successor: ${why}`);
      end(store, entry, "refused");
    };
    if (await agentToolsOff(paseo)) return refuse(AGENT_TOOLS_OFF_SWITCH_MESSAGE);
    const profile = await workerProfileOf(paseo, log);
    if (profile === null) return refuse('there is no "bm-worker" profile');
    const cwd = await folderOf(paseo, entry.workerId, locationOf(home), entry.workspaceId);
    if (cwd === null) return refuse(`the folder of Worker ${entry.workerId} cannot be read`);

    creating.add(entry.workerId);
    try {
      let successorId: string;
      try {
        ({ workerId: successorId } = await createPluginWorker(
          paseo as WorkerCreationPaseo,
          {
            workspaceId: entry.workspaceId,
            requestId: entry.requestId,
            managerId: entry.managerId,
            cwd,
            prompt: `${briefLineOf("worker", entry.requestId)}\n${entry.brief}`,
            title: workerTitleOf(requestOfBrief(entry.brief) ?? ""),
            model: profile.model,
            labels: { [HANDOFF_FROM_LABEL]: entry.workerId },
          },
          { binder: deps.binder?.(), log },
        ));
      } catch (error) {
        // Paseo threw after the hook kept the token: it may have created the successor. The entry stays
        // `creating`; its agent.created, or the agent list at a later turn end, settles it.
        if (creationMayExist(error)) {
          log(`[paseo-bm] the handoff ${entry.id}: Paseo answered the successor's creation with an error after it may have created it (${errorText(error)}); waiting for it to appear.`);
          return;
        }
        return refuse(`Paseo refused to create it: ${errorText(error)}`);
      }
      // Checked above, so the Manager's information counts and is not refused now.
      await finishCreated(home, entry, successorId, paseo);
    } finally {
      creating.delete(entry.workerId);
    }
  }

  return {
    queue,

    async begin(entry, paseo, safe) {
      try {
        if (!safe) return "waiting";
        return await askNote(entry, paseo);
      } catch (error) {
        log(`[paseo-bm] could not start handoff ${entry.id}: ${errorText(error)}`);
        return "waiting";
      }
    },

    async turnRecorded(event, record, paseo) {
      try {
        const home = homeOf();
        if (home === null) return;
        const store = storeOf(home);
        // A `creating` entry this run is not creating is looked up in Paseo once per run, before any bound ends it;
        // a successor that appears later completes it at its own agent.created.
        for (const entry of store.list()) {
          if (entry.state !== "creating" || creating.has(entry.workerId) || reconciled.has(entry.id)) continue;
          reconciled.add(entry.id);
          await reconcileCreating(home, entry, paseo);
        }
        store.expire();
        // `commanded` waits for the Manager's successor, `creating` for the plugin's own: neither is advanced here.
        const pending = store.list().filter((entry) => isPendingHandoffState(entry.state) && entry.state !== "commanded" && entry.state !== "creating");
        if (pending.length === 0) return;
        const enabled = readCoordinationSettings({ home, log }).handoff.enabled;
        const timeline = (event as { timeline?: unknown } | null | undefined)?.timeline;
        const items = Array.isArray(timeline) ? timeline : [];
        const at = now().getTime();
        for (const entry of pending) {
          // The owner's switch stops every handoff at its next step.
          if (!enabled) {
            end(store, entry, "off");
            continue;
          }
          const own = record !== null && record !== undefined && record.agentId === entry.workerId ? record : null;
          if (entry.state === "waiting") {
            if (own === null) continue;
            const records = recordsOf(home, entry.workspaceId);
            if (requestFinishedOf(records, entry.requestId)) {
              end(store, entry, "finished");
              continue;
            }
            if (handoffSafePointIn(own, items, records) && !othersQueued(queue, entry.workerId)) await askNote(entry, paseo);
            continue;
          }
          let current: HandoffEntry | null = entry;
          if (entry.state === "noting") {
            const asked = timeOrNull(entry.noteAskedAt) ?? at;
            // The turn the request started carries the note, or none will come: it starts after the send (a few
            // seconds of slack, the start mark and the send log being stamped apart); a turn it ended does not count.
            const answered = own !== null && (timeOrNull(own.startedAt) ?? endOf(own)) >= asked - NOTE_START_SLACK_MS;
            if (!answered && at - asked <= NOTE_WAIT_MS) continue;
            current = await brief(home, entry, answered ? noteIn(own, items, entry.requestId) : null, paseo);
          }
          if (current !== null && current.state === "briefed") await command(home, current, paseo);
        }
      } catch (error) {
        log(`[paseo-bm] could not advance a handoff after a turn of ${record?.agentId ?? "an agent"}: ${errorText(error)}`);
      }
    },

    async agentCreated(agent, paseo) {
      try {
        if (roleOfProvider(agent.provider) !== "worker") return null;
        const snapshot = await snapshotOf(paseo, agent.id);
        const labels = asRecord(snapshot?.["labels"]) ?? {};
        const from = nonEmpty(labels[HANDOFF_FROM_LABEL]);
        if (from === null) return null;
        // A successor the plugin itself is creating, or created, for a bound Manager (design §16.9): its own path completes it.
        if (creating.has(from)) return null;
        const home = homeOf();
        if (home === null) return null;
        const store = storeOf(home);
        if (store.list().some((candidate) => candidate.successorId === agent.id)) return null;
        const parent = parentOf(agent) ?? parentOf(snapshot);
        const workspaceId = nonEmpty(agent.workspaceId) ?? nonEmpty(snapshot?.["workspaceId"]);
        const requestLabel = nonEmpty(labels["bm.requestId"]);
        // The label alone is not trusted: the handoff's own Manager, in its workspace, for its request.
        const entry = store
          .list()
          .filter(
            (candidate) =>
              candidate.workerId === from &&
              candidate.successorId === null &&
              // `creating`: the plugin's own creation, which a reload (or Paseo's late error) left unsettled.
              (candidate.state === "commanded" || candidate.state === "creating" || (candidate.state === "failed" && candidate.ending === "no-successor")) &&
              candidate.workspaceId === workspaceId &&
              candidate.managerId === parent &&
              (requestLabel === null || requestLabel === candidate.requestId),
          )
          .at(-1);
        if (entry === undefined) {
          log(`[paseo-bm] Worker ${agent.id} carries ${HANDOFF_FROM_LABEL}=${from}, but no handoff of that Worker by its Manager waits for it.`);
          return null;
        }
        if (entry.state === "creating") return await finishCreated(home, entry, agent.id, paseo);
        return await complete(store, entry, agent.id, paseo);
      } catch (error) {
        log(`[paseo-bm] linking the successor Worker ${agent.id} failed: ${errorText(error)}`);
        return null;
      }
    },
  };
}
