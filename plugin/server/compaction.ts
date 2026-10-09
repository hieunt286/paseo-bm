/**
 * Compaction run by the plugin itself (missions design §9.5; autonomy design
 * §G.5; PRD REQ-134, REQ-195; ADR-021; bead `7gxw.10`): the sequence a
 * compaction takes once it starts, kept in `compaction-store.ts` so a reload
 * continues it. No model asks for it and the Orchestrator is not woken.
 *
 * 0. **The start** (`turnRecorded`): a Manager's or a Worker's recorded turn
 *    whose context crosses the owner's threshold (`contextCrossingOf`, §G.7)
 *    starts one, while compaction is on for the provider the turn shows,
 *    the agent is below `compact.maxPerAgent` and none of it is pending. It
 *    is logged as a `compact` intervention with trigger `threshold.crossed`.
 * 1. **The idle moment after a safe point.** A Worker's, right after a turn
 *    that sent a report (`reportedIn`; a bound Worker's report is its newest
 *    `report` outbox record, which the collector puts in its turn record,
 *    design §16.7); a Manager's, whenever it is idle with
 *    no notice queued for it. It is looked for at each recorded turn end of
 *    the target (`turnRecorded`, the collector's `onRecorded`), the start's
 *    own included; never inside a running
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
import { compactCrossingOf, compactionOnFor, type CoordinationRole, type CoordinationSettings, type ThresholdCrossing } from "../shared/coordination";
import type { ParsedReport, TraceMessage, TraceRecord } from "../shared/contracts";
import { BRIEF_CHARACTERS, turnTokensOf } from "../shared/eval-metrics/tokens";
import { STATE_NOTICE_MARKER } from "../shared/notices";
import { shorten } from "../shared/text";
import { timeOrNull } from "../shared/time";
import type { Decision } from "../shared/decisions";
import { redactText, sliceLastTurn } from "./collector";
import {
  MAX_COMPACTION_REASON_CHARS,
  createCompactionStore,
  endedEntry,
  pendingCompactionOf,
  sentCompactionsOf,
  type CompactionEntry,
  type CompactionStore,
} from "./compaction-store";
import { recordIntervention } from "./intervention-store";
import { readCoordinationSettings } from "./coordination-rpc";
import { TRACES_DIR_NAME, resolveDataHome, type DataHomeDeps } from "./data-home";
import { createDecisionStore } from "./decision-store";
import { noticeQueue, type BatchItem, type NoticeBatch, type NoticePaseo, type NoticeQueue } from "./notice-queue";
import { readRecords } from "./trace-store";
import { reconstructTraces, type ReconstructedTrace } from "./traces";
import { errorText } from "./rpc-kit";
import { newestReportRecordOf, reportPhaseOf } from "./outbox";
import { createMissionStore } from "./mission-store";
import { createMissionRoster } from "./mission-roster";

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
// The start: the owner's threshold (§G.7).
// ---------------------------------------------------------------------------

/** The base provider a recorded turn shows (`turnTokensOf`): claude, codex or opencode; null when it is not known. */
export function turnProviderOf(record: TraceRecord): string | null {
  const provider = turnTokensOf(record).provider;
  return provider === "unknown" ? null : provider;
}

/**
 * Whether a Manager's or a Worker's recorded turn crosses its context
 * threshold (`compactCrossingOf`: its tokens read against its role's
 * `compact.*TokensPerTurn` where the provider counts the whole turn, else its
 * context share), and on which figure. Null for another role, below, or a
 * turn holding a compaction, whose figure understates (the next turn is
 * judged). Pure.
 */
export function contextCrossingOf(record: TraceRecord, settings: Pick<CoordinationSettings, "compact">): ThresholdCrossing | null {
  if (record.role !== "manager" && record.role !== "worker") return null;
  if (record.evidence.some((evidence) => evidence.kind === "compaction")) return null;
  const turn = turnTokensOf(record);
  return compactCrossingOf(record.role, { coverage: turn.coverage, tokensRead: turn.tokensRead, contextShare: turn.contextShare }, settings);
}

/** A crossing in words, the reason a compaction or a handoff keeps. */
export function crossingWordsOf(crossing: ThresholdCrossing): string {
  const count = (value: number) => Math.round(value).toLocaleString("en-US");
  switch (crossing.figure) {
    case "contextShare":
      return `its context filled ${Math.round(crossing.value * 100)} % of its window (threshold ${Math.round(crossing.threshold * 100)} %)`;
    case "tokensPerTurn":
      return `it read ${count(crossing.value)} tokens in one turn (threshold ${count(crossing.threshold)})`;
    case "requestTokens":
      return `its request read ${count(crossing.value)} tokens (threshold ${count(crossing.threshold)})`;
  }
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

/** Whether another notice is queued for `agentId`: its own `/compact`, held from an earlier moment, does not count. */
function othersQueued(queue: Pick<NoticeQueue, "pending">, agentId: string): boolean {
  return queue.pending(agentId).some((notice) => !notice.kind.startsWith(`${COMPACT_BATCH_NAME}:`));
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
  "From the paseo-bm plugin, not the owner: your context was just compacted, as it crossed the owner's threshold. Below is what the plugin's stores hold, so what matters comes from the records rather than from the summary alone; keep it as your working memory. Nothing is asked of you: reply `noted` in one line and end this turn.";

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

/**
 * A Main's requests (missions design §3.5, §6): its open mission's active
 * roster requests, newest first, each in its repo with its newest Worker,
 * its newest report's phase and its open decisions. Null for an agent that is
 * no open mission's Main. Never throws: a store that cannot be read is null.
 */
function missionRequestLines(entry: CompactionEntry, home: string, env: NodeJS.ProcessEnv): string[] | null {
  try {
    const mission = createMissionStore(home).openByMain(entry.agentId);
    if (mission === null) return null;
    const decisions = createDecisionStore(home, { log: () => {} });
    const lines = createMissionRoster(home)
      .list(mission.missionId)
      .filter((request) => request.state === "active")
      .reverse()
      .slice(0, 5)
      .map((request) => {
        const worker = request.workerIds.at(-1) ?? null;
        const report = worker === null ? null : newestReportRecordOf(home, request.workspaceId, worker);
        const open = decisions
          .list({ workspaceId: request.workspaceId, requestId: request.requestId })
          .filter((decision) => decision.status === "open" || decision.status === "needs-confirmation").length;
        const asked = request.topic === "" ? "" : `; asked: ${shorten(redactText(request.topic, env), 240)}`;
        return `- ${request.requestId}: ${(report === null ? null : reportPhaseOf(report.text)) ?? "no report yet"}, in ${request.workspaceId}, Worker ${worker ?? "unknown"}, open decisions ${open}${asked}`;
      });
    return [`mission: ${mission.code} ${mission.name}`, ...(lines.length === 0 ? ["requests: none open"] : ["requests (newest first):", ...lines]), "Read the whole mission with bm_mission."];
  } catch {
    return null;
  }
}

/** The Manager's brief: its newest requests with where they stand, and the owner's newest words to it; a Main's requests from its mission. */
function managerBrief(
  entry: CompactionEntry,
  traces: readonly ReconstructedTrace[],
  decisions: readonly Decision[],
  records: readonly TraceRecord[],
  env: NodeJS.ProcessEnv,
  mission: string[] | null,
): string[] {
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
    ...(mission ?? (own.length === 0 ? ["requests: none recorded"] : ["requests (newest first):", ...own.map(requestLine)])),
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
      : managerBrief(entry, traces, decisions, records, env, missionRequestLines(entry, home, env));
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
   * One recorded turn (the collector's `onRecorded`): a turn crossing its
   * agent's threshold starts a compaction (missions design §9.5); for its
   * agent's pending compaction, sends the `/compact` at a safe point — this
   * turn's included — or the brief once the compaction completed. Never rejects.
   */
  turnRecorded(event: unknown, record: TraceRecord | null | undefined, paseo: unknown): Promise<void>;
  /** The notice queue it sends through. */
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

  /**
   * A turn of an agent with no pending compaction that crosses its threshold
   * (missions design §9.5): a `waiting` compaction, logged as a `compact`
   * intervention with trigger `threshold.crossed` — while compaction is on for
   * the provider the turn shows and the agent is below `compact.maxPerAgent`.
   * Null otherwise.
   */
  function start(home: string, store: CompactionStore, record: TraceRecord): CompactionEntry | null {
    const settings = readCoordinationSettings({ home, log });
    const provider = turnProviderOf(record);
    if (!compactionOnFor(settings, provider)) return null;
    const crossing = contextCrossingOf(record, settings);
    if (crossing === null || sentCompactionsOf(store.list(), record.agentId) >= settings.compact.maxPerAgent) return null;
    const role = record.role as CoordinationRole;
    const requestId = role === "worker" ? record.requestId : null;
    const intervention = recordIntervention(
      home,
      { kind: "compact", workspaceId: record.workspaceId, requestId, targetAgentId: record.agentId, trigger: "threshold.crossed" },
      { now, log },
    );
    return store.add({
      workspaceId: record.workspaceId,
      requestId,
      agentId: record.agentId,
      role,
      provider: provider as CompactionEntry["provider"],
      interventionId: intervention?.id ?? null,
      reason: shorten(crossingWordsOf(crossing), MAX_COMPACTION_REASON_CHARS),
    });
  }

  return {
    queue,

    async turnRecorded(event, record, paseo) {
      try {
        if (record === null || record === undefined || (record.role !== "manager" && record.role !== "worker")) return;
        const home = homeOf();
        if (home === null) return;
        const store = storeOf(home);
        store.expire();
        const entry = pendingCompactionOf(store.list(), record.agentId, now()) ?? start(home, store, record);
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
