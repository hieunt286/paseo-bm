/**
 * Compaction on the Orchestrator's request (autonomy design §G.5; PRD
 * REQ-134; ADR-021; bead `7gxw.10`): the sequence the plugin runs once
 * `bm_compact` accepted a compaction (`orchestrator-coordination-tools.ts`),
 * kept in `compaction-store.ts` so a reload continues it.
 *
 * 1. **The idle moment after a safe point.** A Worker's, right after a turn
 *    that sent a report (`reportedIn`; a bound Worker's report is its newest
 *    `report` outbox record, `pending` or `delivered`, design §16.7); a Manager's, whenever it is idle with
 *    no notice queued for it. It is looked for when `bm_compact` is called
 *    (`safeIdleMoment`) and at each recorded turn end of the target
 *    (`turnRecorded`, the collector's `onRecorded`); never inside a running
 *    turn — the command goes through the notice queue, which sends only to an
 *    idle agent. It waits at most `SAFE_POINT_WAIT_MS`.
 * 2. **The command** (`compactCommandOf`), recorded in the send log just
 *    before it goes (`logSend`): Claude gets `/compact` with a fixed focus,
 *    `COMPACT_FOCUS`, which it honours; Codex and OpenCode a bare `/compact`,
 *    since Paseo 0.9.2 drops the focus before either sees it (§G.5
 *    Verified). It goes as a one-item batch of the notice queue: its
 *    `onSent` marks the entry `compacting` at the moment it went out, and its
 *    `isCurrent` drops it when compaction was turned off meanwhile or it was
 *    held past its moment (`SAFE_SEND_MS`: the target turned busy between the
 *    look and the send) — the next safe point sends it again. No provider
 *    falls back to a handoff.
 * 3. **The compaction.** The target's next recorded turn with a completed
 *    `compaction` item (the collector's `compaction` evidence) at or after the
 *    send; at most `COMPACTION_WAIT_MS`, else the entry fails.
 * 4. **The state brief** (`stateBriefOf`, `BM-STATE`), built from the stores
 *    — the request and the owner's words, the decisions with their answers,
 *    the latest report's plan, beads, open findings, files and checks; for a
 *    Manager its recent requests and the owner's newest words — masked with
 *    `redactText`, at most `STATE_BRIEF_MAX_CHARS`. Recorded in the send log
 *    too, then handed to the notice queue; the entry is `done`.
 *
 * The threshold check reads the context at the target's NEXT turn end after a
 * compaction: the figure right after it understates the real one (spike run
 * note 2026-09-30 §2), so a turn with a compaction is never judged.
 *
 * Nothing here throws into the plugin: a failure is one log line.
 */
import { join } from "node:path";
import { compactionOnFor, type CoordinationRole } from "../shared/coordination";
import type { ParsedReport, TraceMessage, TraceRecord } from "../shared/contracts";
import { BRIEF_CHARACTERS } from "../shared/eval-metrics/tokens";
import { STATE_NOTICE_MARKER } from "../shared/notices";
import { shorten } from "../shared/text";
import { timeOrNull } from "../shared/time";
import type { Decision } from "../shared/decisions";
import { redactText, sliceLastTurn } from "./collector";
import {
  createCompactionStore,
  endedEntry,
  pendingCompactionOf,
  type CompactionEntry,
  type CompactionStore,
} from "./compaction-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import { createDecisionStore } from "./decision-store";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { readRecords } from "./trace-store";
import { reconstructTraces, type ReconstructedTrace } from "./traces";
import { dataHome, errorText } from "./rpc-kit";
import { newestReportRecordOf } from "./outbox";

/**
 * What Claude is told to keep (design §G.5 step 2): the request and the
 * owner's words, the decisions taken, the plan and bead state, open review
 * findings and files changed; tool output dropped. One line.
 */
export const COMPACT_FOCUS =
  "Keep: the owner's request and every word the owner wrote, verbatim; the decisions taken and the owner's answers; the plan and the bead state (done, ready, blocked); open review findings; the files changed and the checks run with their results. Drop: tool output, file contents and logs.";

/** The notice-queue batch the `/compact` goes in: one item, the command itself. */
export const COMPACT_BATCH_NAME = "BM-COMPACT";

/** A `/compact` still queued this long after its safe moment is dropped; the next safe point sends it again. */
export const SAFE_SEND_MS = 60_000;

/** The most characters of a `BM-STATE` brief: a handoff brief's size (§G.6, `BRIEF_CHARACTERS`). */
export const STATE_BRIEF_MAX_CHARS = BRIEF_CHARACTERS;

/** The provider's compaction command (design §G.5 Verified): Claude honours a focus; Paseo drops it for Codex and OpenCode. */
export function compactCommandOf(provider: CompactionEntry["provider"]): string {
  return provider === "claude" ? `/compact ${COMPACT_FOCUS}` : "/compact";
}

// ---------------------------------------------------------------------------
// The safe point.
// ---------------------------------------------------------------------------

/** A tool's own name, without its MCP server prefix (`mcp__paseo__send_agent_prompt`, `paseo.send_agent_prompt`). */
function toolBaseName(name: unknown): string {
  return typeof name === "string" ? (name.split(/__|\./).pop() ?? "") : "";
}

const REPORT_BLOCK = /^\s*(?:```\s*)?BM-REPORT\b/m;

/** The prompt of a `send_agent_prompt` call, or null. */
function promptOf(item: Record<string, unknown>): string | null {
  const detail = (item["detail"] ?? {}) as { input?: unknown };
  const input = (detail.input ?? item["input"] ?? {}) as { prompt?: unknown };
  return typeof input.prompt === "string" ? input.prompt : null;
}

/**
 * Whether the turn that ended last in these timeline items (from its last
 * `user_message` on, `sliceLastTurn`) sent a report: a `send_agent_prompt`
 * call whose prompt holds a `BM-REPORT` block (worker.md, Reporting), or its
 * own message holding one (a Worker without a Manager posts it in its chat).
 * A Worker's safe point (design §G.5 step 1). Pure.
 */
export function reportedIn(items: readonly unknown[]): boolean {
  return sliceLastTurn(items).some((raw) => {
    if (raw === null || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    if (item["type"] === "tool_call" && toolBaseName(item["name"]) === "send_agent_prompt") {
      const prompt = promptOf(item);
      return prompt !== null && REPORT_BLOCK.test(prompt);
    }
    return item["type"] === "assistant_message" && typeof item["text"] === "string" && REPORT_BLOCK.test(item["text"]);
  });
}

/** The newest timeline entries of an agent, oldest first: one page from the tail; none when it cannot be read. */
async function tailEntriesOf(paseo: unknown, agentId: string): Promise<Array<{ item: unknown; timestamp: string | null }>> {
  try {
    const ref = (paseo as { agents?: { ref?: (id: string) => { timeline?: { refetch?: (options: Record<string, unknown>) => Promise<unknown> } } } } | null)
      ?.agents?.ref?.(agentId);
    const payload = (await ref?.timeline?.refetch?.({ direction: "tail", limit: 200 })) as { entries?: Array<{ item?: unknown; timestamp?: unknown }> } | undefined;
    return (payload?.entries ?? [])
      .filter((entry) => entry.item !== undefined && entry.item !== null)
      .map((entry) => ({ item: entry.item, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null }));
  } catch {
    return [];
  }
}

/**
 * When the last turn in these entries started: the timestamp of its
 * `user_message` (`sliceLastTurn`), or null when it has none.
 */
function lastTurnStartOf(entries: ReadonlyArray<{ item: unknown; timestamp: string | null }>): string | null {
  const first = sliceLastTurn(entries, (entry) => entry.item)[0];
  const type = (first?.item as { type?: unknown } | null | undefined)?.type;
  return type === "user_message" ? (first?.timestamp ?? null) : null;
}

/**
 * Whether a bound agent sent a report in its last turn (design §16.7): its
 * newest `report` outbox record, `pending` or `delivered`, created at or after
 * that turn's start. Never throws.
 */
export function reportRecordedSince(home: string | null, workspaceId: string | null, agentId: string, since: string | null): boolean {
  if (home === null || workspaceId === null || since === null) return false;
  try {
    return newestReportRecordOf(home, workspaceId, agentId, since) !== null;
  } catch {
    return false;
  }
}

/** Whether another notice is queued for `agentId`: its own `/compact`, held from an earlier moment, does not count. */
function othersQueued(queue: Pick<NoticeQueue, "pending">, agentId: string): boolean {
  return queue.pending(agentId).some((notice) => !notice.kind.startsWith(`${COMPACT_BATCH_NAME}:`));
}

/**
 * Whether `target` is at an idle moment after a safe point now: not running,
 * no notice queued for it, and — a Worker — its last turn sent a report: a
 * `BM-REPORT` block in its timeline (the hand path), or a `report` outbox
 * record of a bound Worker (design §16.7). Reads one page of a Worker's
 * timeline. Never throws.
 */
export async function safeIdleMoment(
  target: { id: string; role: CoordinationRole; status: string; workspaceId?: string | null },
  paseo: unknown,
  queue: Pick<NoticeQueue, "pending"> = noticeQueue,
  deps: { home?: string | null } = {},
): Promise<boolean> {
  if (target.status === "running" || target.status === "initializing") return false;
  if (othersQueued(queue, target.id)) return false;
  if (target.role === "manager") return true;
  const entries = await tailEntriesOf(paseo, target.id);
  if (reportedIn(entries.map((entry) => entry.item))) return true;
  return reportRecordedSince(dataHome(deps.home === undefined ? {} : { home: deps.home }), target.workspaceId ?? null, target.id, lastTurnStartOf(entries));
}

/** Whether a recorded turn shows a completed compaction at or after `sentAt` (a few seconds of clock slack). */
function compactedIn(record: TraceRecord, sentAt: string | null): string | null {
  const from = (timeOrNull(sentAt) ?? Number.NEGATIVE_INFINITY) - 5_000;
  const found = record.evidence.find((evidence) => evidence.kind === "compaction" && (timeOrNull(evidence.at) ?? Number.POSITIVE_INFINITY) >= from);
  return found === undefined ? null : (found.at ?? record.endedAt ?? record.at);
}

// ---------------------------------------------------------------------------
// The state brief.
// ---------------------------------------------------------------------------

const list = (values: readonly string[] | undefined, max = 600): string =>
  values === undefined || values.length === 0 ? "none" : shorten([...new Set(values)].join(", "), max);

/** The owner's own messages of a trace's turns (`origin: "user"`), oldest first. */
function ownerMessagesOf(trace: ReconstructedTrace): TraceMessage[] {
  return trace.records
    .flatMap((record) => record.sent.filter((message) => message.origin === "user"))
    .sort((a, b) => (timeOrNull(a.at) ?? 0) - (timeOrNull(b.at) ?? 0));
}

function answerText(decision: Decision, env: NodeJS.ProcessEnv): string {
  if (decision.answer === null) return decision.status;
  const { optionKey, words } = decision.answer;
  if (optionKey !== null) {
    const label = decision.options.find((option) => option.key === optionKey)?.label;
    return `answered ${optionKey}${label === undefined ? "" : ` — ${shorten(redactText(label, env), 120)}`}`;
  }
  return words === null ? "answered" : `answered in the owner's words — ${shorten(redactText(words, env), 240)}`;
}

/** The facts of a request's reports: the latest one's, and what every one of them changed or closed. */
function reportLines(reports: readonly ParsedReport[], env: NodeJS.ProcessEnv): string[] {
  const latest = reports.at(-1);
  if (latest === undefined) return ["lastReport: none"];
  const all = <K extends "filesChanged" | "beadsCreated" | "beadsClosed">(key: K) => reports.flatMap((report) => report[key]);
  const text = (value: string | null | undefined, max = 400) => (value === null || value === undefined || value.trim() === "" ? "none" : shorten(redactText(value, env), max));
  return [
    `lastReport: ${latest.phase ?? "unknown"} at ${latest.at}`,
    `tier: ${latest.tier ?? "unknown"}`,
    `filesChanged: ${redactText(list(all("filesChanged")), env)}`,
    `beadsCreated: ${list(all("beadsCreated"))}`,
    `beadsClosed: ${list(all("beadsClosed"))}`,
    `beadsReady: ${list(latest.beadsReady)}`,
    `reviewFindingsOpen: ${text(latest.reviewFindingsOpen)}`,
    `checks: ${text(latest.buildAndTests)}`,
    `decided: ${redactText(list(latest.decided), env)}`,
    `blockers: ${text(latest.blockers)}`,
  ];
}

const BRIEF_INTRO =
  "From the paseo-bm plugin, not the owner: your context was just compacted at the Orchestrator's request. Below is what the plugin's stores hold, so what matters comes from the records rather than from the summary alone; keep it as your working memory. Nothing is asked of you: reply `noted` in one line and end this turn.";

/** The Worker's brief: its request, the owner's words, the decisions and its reports. */
function workerBrief(entry: CompactionEntry, trace: ReconstructedTrace | undefined, decisions: readonly Decision[], env: NodeJS.ProcessEnv): string[] {
  const owner = trace === undefined ? [] : ownerMessagesOf(trace);
  const first = owner[0]?.text ?? trace?.requestText ?? null;
  const later = owner.slice(1).slice(-3);
  return [
    "role: worker",
    `requestId: ${entry.requestId ?? "unknown"}`,
    `request: ${first === null ? "unknown" : shorten(redactText(first, env), 1_200)}`,
    ...(later.length === 0 ? ["ownerSaid: nothing more"] : ["ownerSaid:", ...later.map((message) => `- ${message.at}: ${shorten(redactText(message.text, env), 400)}`)]),
    ...(decisions.length === 0
      ? ["decisions: none"]
      : ["decisions:", ...decisions.slice(-8).map((decision) => `- ${decision.id} (${answerText(decision, env)}): ${shorten(redactText(decision.question.split("\n")[0] ?? "", env), 200)}`)]),
    ...reportLines(trace?.reports ?? [], env),
  ];
}

/** The Manager's brief: its newest requests with where they stand, and the owner's newest words to it. */
function managerBrief(entry: CompactionEntry, traces: readonly ReconstructedTrace[], decisions: readonly Decision[], records: readonly TraceRecord[], env: NodeJS.ProcessEnv): string[] {
  const own = traces
    .filter((trace) => trace.requestId !== null && trace.managerAgentId === entry.agentId)
    .sort((a, b) => (timeOrNull(b.requestedAt) ?? 0) - (timeOrNull(a.requestedAt) ?? 0))
    .slice(0, 5);
  const owner = records
    .filter((record) => record.agentId === entry.agentId)
    .flatMap((record) => record.sent.filter((message) => message.origin === "user"))
    .sort((a, b) => (timeOrNull(a.at) ?? 0) - (timeOrNull(b.at) ?? 0))
    .slice(-3);
  // Written as `- req-…`, never `requestId: req-…`, so the turn is not taken for one request's (`requestIdFromText`).
  const requestLine = (trace: ReconstructedTrace): string => {
    const phase = trace.reports.at(-1)?.phase ?? "no report yet";
    const open = decisions.filter((decision) => decision.requestId === trace.requestId && (decision.status === "open" || decision.status === "needs-confirmation")).length;
    const asked = trace.requestText === null ? "" : `; asked: ${shorten(redactText(trace.requestText, env), 240)}`;
    const worker = trace.workerIds.at(-1) ?? trace.records.filter((record) => record.role === "worker").at(-1)?.agentId ?? "unknown";
    return `- ${trace.requestId}: ${phase}, Worker ${worker}, open decisions ${open}${asked}`;
  };
  return [
    "role: manager",
    ...(own.length === 0 ? ["requests: none recorded"] : ["requests (newest first):", ...own.map(requestLine)]),
    ...(owner.length === 0 ? ["ownerSaid: nothing recorded"] : ["ownerSaid (newest last):", ...owner.map((message) => `- ${message.at}: ${shorten(redactText(message.text, env), 400)}`)]),
  ];
}

/**
 * The `BM-STATE` brief for `entry`'s target, from the trace store and the
 * decision store of the data folder `home` (design §G.5 step 4): masked, at
 * most `STATE_BRIEF_MAX_CHARS`. A store that cannot be read gives what the
 * others hold. Never throws.
 */
export function stateBriefOf(entry: CompactionEntry, home: string, env: NodeJS.ProcessEnv = process.env): string {
  let records: TraceRecord[] = [];
  let decisions: Decision[] = [];
  try {
    records = readRecords({ tracesDir: join(home, TRACES_DIR_NAME) }, entry.workspaceId).records;
  } catch {
    // The brief holds what the other store gives.
  }
  try {
    decisions = createDecisionStore(home, { log: () => {} })
      .list({ workspaceId: entry.workspaceId, ...(entry.requestId === null ? {} : { requestId: entry.requestId }) })
      .sort((a, b) => (timeOrNull(a.askedAt) ?? 0) - (timeOrNull(b.askedAt) ?? 0));
  } catch {
    // Idem.
  }
  let traces: ReconstructedTrace[] = [];
  try {
    traces = reconstructTraces({ records, agents: [] });
  } catch {
    // Idem.
  }
  const body =
    entry.role === "worker"
      ? workerBrief(entry, traces.find((trace) => trace.requestId !== null && trace.requestId === entry.requestId), decisions, env)
      : managerBrief(entry, traces, decisions, records, env);
  const text = [STATE_NOTICE_MARKER, BRIEF_INTRO, ...body].join("\n");
  return text.length <= STATE_BRIEF_MAX_CHARS ? text : `${text.slice(0, STATE_BRIEF_MAX_CHARS - 2).trimEnd()}\n…`;
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

export interface CompactionRunnerDeps extends DataHomeDeps {
  /** The notice queue; the plugin's shared one by default. */
  queue?: Pick<NoticeQueue, "enqueue" | "enqueueBatch" | "pending">;
  /** The data folder; `resolveDataHome` by default. */
  home?: () => string | null;
  now?: () => Date;
  log?: (message: string) => void;
  /** Secrets to mask in the brief; the process's own by default. */
  redactEnv?: NodeJS.ProcessEnv;
}

export interface CompactionRunner {
  /**
   * Right after `bm_compact` recorded `entry`: sends its `/compact` now when
   * `safe` says the target is at an idle moment after a safe point, else
   * leaves it waiting for one. Never rejects.
   */
  begin(entry: CompactionEntry, paseo: unknown, safe: boolean): Promise<"sent" | "queued" | "waiting">;
  /**
   * One recorded turn (the collector's `onRecorded`): for its agent's pending
   * compaction, sends the `/compact` at a safe point, or the brief once the
   * compaction completed. Never rejects.
   */
  turnRecorded(event: unknown, record: TraceRecord | null | undefined, paseo: unknown): Promise<void>;
  /** The notice queue it sends through (`safeIdleMoment` reads what is queued). */
  readonly queue: Pick<NoticeQueue, "pending">;
}

export function createCompactionRunner(deps: CompactionRunnerDeps = {}): CompactionRunner {
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
  const storeOf = (home: string): CompactionStore => createCompactionStore(home, { now });

  /** Its `/compact` went out: `compacting` from now, and the send log takes the time it went. */
  const batch: NoticeBatch = {
    name: COMPACT_BATCH_NAME,
    // One item per batch; were two ever pending, only the newest goes.
    compose: (lines) => lines[lines.length - 1]!,
    onSent: (_targetId, keys) => {
      const home = homeOf();
      if (home === null) return;
      const store = storeOf(home);
      for (const id of keys) {
        store.update(id, (entry) => (entry.state === "waiting" ? { ...entry, state: "compacting", sentAt: now().toISOString() } : entry));
        store.markSendTime(id);
      }
    },
  };

  /** At the idle moment, synchronously: still waiting, compaction still on, and not held past its safe moment. */
  const currentAt =
    (id: string, enqueuedAt: number) =>
    (): boolean => {
      const home = homeOf();
      if (home === null) return false;
      const store = storeOf(home);
      const entry = store.get(id);
      if (entry === null || entry.state !== "waiting") return false;
      if (!compactionOnFor(readCoordinationSettings({ home, log }), entry.provider)) {
        store.update(id, (current) => endedEntry(current, "off", now().toISOString()));
        return false;
      }
      return now().getTime() - enqueuedAt <= SAFE_SEND_MS;
    };

  async function sendCompact(home: string, entry: CompactionEntry, paseo: unknown): Promise<"sent" | "queued" | "waiting"> {
    const text = compactCommandOf(entry.provider);
    // Before the send: the collector must find it when the compaction's turn is recorded.
    storeOf(home).logSend(entry.agentId, text, entry.id);
    const item: BatchItem = { key: entry.id, line: text, isCurrent: currentAt(entry.id, now().getTime()) };
    const [outcome] = await queue.enqueueBatch(entry.agentId, batch, [item], paseo as NoticePaseo | undefined);
    return outcome === "sent" || outcome === "queued" ? outcome : "waiting";
  }

  async function sendBrief(home: string, entry: CompactionEntry, compactedAt: string, paseo: unknown): Promise<void> {
    const brief = stateBriefOf(entry, home, deps.redactEnv ?? process.env);
    const store = storeOf(home);
    store.logSend(entry.agentId, brief, entry.id);
    const at = now().toISOString();
    store.update(entry.id, (current) => ({ ...current, state: "done", compactedAt, briefAt: at, endedAt: at }));
    const outcome = await queue.enqueue(entry.agentId, STATE_NOTICE_MARKER, brief, paseo as NoticePaseo | undefined);
    if (outcome === "dropped") log(`[paseo-bm] the BM-STATE brief of compaction ${entry.id} could not be delivered to ${entry.agentId}.`);
  }

  return {
    queue,

    async begin(entry, paseo, safe) {
      try {
        const home = homeOf();
        if (home === null || !safe) return "waiting";
        return await sendCompact(home, entry, paseo);
      } catch (error) {
        log(`[paseo-bm] could not start compaction ${entry.id}: ${errorText(error)}`);
        return "waiting";
      }
    },

    async turnRecorded(event, record, paseo) {
      try {
        if (record === null || record === undefined || (record.role !== "manager" && record.role !== "worker")) return;
        const home = homeOf();
        if (home === null) return;
        const store = storeOf(home);
        store.expire();
        const entry = pendingCompactionOf(store.list(), record.agentId, now());
        if (entry === null) return;
        if (entry.state === "compacting") {
          const compactedAt = compactedIn(record, entry.sentAt);
          if (compactedAt !== null) await sendBrief(home, entry, compactedAt, paseo);
          return;
        }
        if (!compactionOnFor(readCoordinationSettings({ home, log }), entry.provider)) {
          store.update(entry.id, (current) => endedEntry(current, "off", now().toISOString()));
          return;
        }
        const timeline = (event as { timeline?: unknown } | null | undefined)?.timeline;
        const safe = entry.role === "manager" || record.reports.length > 0 || reportedIn(Array.isArray(timeline) ? timeline : []);
        if (!safe || othersQueued(queue, entry.agentId)) return;
        await sendCompact(home, entry, paseo);
      } catch (error) {
        log(`[paseo-bm] could not advance a compaction after a turn of ${record?.agentId ?? "an agent"}: ${errorText(error)}`);
      }
    },
  };
}
