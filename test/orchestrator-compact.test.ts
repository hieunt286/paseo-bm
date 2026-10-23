import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRecord } from "../plugin/server/collector";
import {
  COMPACT_BATCH_NAME,
  COMPACT_FOCUS,
  SAFE_SEND_MS,
  STATE_BRIEF_MAX_CHARS,
  WORKER_LINKS_BLOCK_MAX_CHARS,
  compactCommandOf,
  contextCrossingOf,
  createCompactionRunner,
  crossingWordsOf,
  reportedIn,
  stateBriefOf,
  workerLinkLines,
  type CompactionRunner,
} from "../plugin/server/compaction";
import { createMissionRoster } from "../plugin/server/mission-roster";
import { createMissionStore } from "../plugin/server/mission-store";
import { createPeerLinkStore } from "../plugin/server/peer-links";
import {
  COMPACTIONS_FILE,
  COMPACTION_WAIT_MS,
  SAFE_POINT_WAIT_MS,
  SEND_LOG_MATCH,
  createCompactionStore,
  isPluginSent,
  pluginSentMatcher,
  sentTextHashOf,
} from "../plugin/server/compaction-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createInterventionStore } from "../plugin/server/intervention-store";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { clearRequestRegistryCache, createRequestRegistry } from "../plugin/server/request-registry";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { ORCHESTRATOR_DIR_NAME } from "../plugin/server/orchestrator-store";
import { appendRecord, clearTraceStoreCache } from "../plugin/server/trace-store";
import type { Evidence, TraceRecord, Usage } from "../plugin/shared/contracts";
import { answerDecision } from "../plugin/shared/decisions";
import { DEFAULT_COORDINATION_SETTINGS } from "../plugin/shared/coordination";
import { MAINTENANCE_WAIT_MS } from "../plugin/shared/interventions";
import { STATE_NOTICE_MARKER, isPluginNotice } from "../plugin/shared/notices";
import { makeDecision } from "./helpers/decisions";
import { fakePaseo, type FakePaseo } from "./helpers/fake-paseo";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, msg, report, turn } from "./fixtures/orchestrator-traces";

/**
 * Compaction run by the plugin itself (missions design §9.5; autonomy design
 * §G.5; PRD REQ-134, REQ-195; bead `7gxw.10`): a recorded turn crossing the
 * owner's threshold starts it, and every rule that starts nothing writes
 * nothing; the command per provider; the sequence — held until the
 * target's idle moment after a safe point, the `/compact` sent once, the
 * `BM-STATE` brief after the completed compaction, never into a running turn —
 * with the one fake of `test/helpers/fake-paseo.ts`; the brief built from the
 * stores, masked and bounded; and the send log that makes the collector read
 * the plugin's `/compact` as the plugin's, never the owner's. A temporary data
 * folder and a private notice queue — never the real HOME or a daemon.
 */

const REQUEST = "req-20260930T100000Z";
const ORCHESTRATOR = "agent-orchestrator";
const SECRET = "tok-compact-secret-42";
const T0 = Date.parse("2026-09-30T11:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let root: string;
let home: string;
let clock: Date;
let queue: NoticeQueue;
let logs: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-compact-"));
  home = join(root, "data");
  clock = new Date(T0 + 30 * MIN);
  queue = createNoticeQueue({ log: () => {} });
  logs = [];
  clearTraceStoreCache();
  clearDecisionStoreCache();
});

afterEach(() => {
  clearTraceStoreCache();
  clearDecisionStoreCache();
  clearRequestRegistryCache();
  rmSync(root, { recursive: true, force: true });
});

const location = () => ({ tracesDir: join(home, "traces") });
const compactionsFile = () => join(home, ORCHESTRATOR_DIR_NAME, COMPACTIONS_FILE);
const compactions = () => createCompactionStore(home, { now: () => clock });
const interventions = () => createInterventionStore(home).list();

type Provider = "claude" | "codex" | "opencode";
const MODEL: Record<Provider, string> = { claude: "claude-opus-5", codex: "gpt-5.6-luna", opencode: "opencode/big-pickle" };

/** A turn's usage: Claude counts the whole turn (6.1M read crosses the Worker's 5.7M); Codex and OpenCode the last call, with the context. */
const usageOf = (provider: Provider, over: Partial<Usage> = {}): Usage => ({
  inputTokens: provider === "claude" ? 100_000 : 150_000,
  cachedInputTokens: provider === "claude" ? 6_000_000 : 20_000,
  outputTokens: 2_000,
  costUsd: null,
  costBasis: "unavailable",
  model: MODEL[provider],
  pricesUpdatedAt: null,
  ...(provider === "claude" ? {} : { contextUsed: 150_000, contextMax: 258_400 }),
  ...over,
});

/** One recorded turn of `agentId`, ending `minute` minutes after T0. */
function agentTurn(agentId: string, minute: number, provider: Provider = "claude", over: Partial<TraceRecord> = {}): TraceRecord {
  const worker = agentId !== MANAGER;
  return turn({
    workspaceId: WORKSPACE_ID,
    agentId,
    role: worker ? "worker" : "manager",
    requestId: worker ? REQUEST : null,
    turnId: `${agentId}-${minute}`,
    at: iso(T0 + minute * MIN),
    startedAt: iso(T0 + (minute - 1) * MIN),
    endedAt: iso(T0 + minute * MIN),
    usage: usageOf(provider),
    runtime: { model: MODEL[provider], thinkingOptionId: null, modeId: null, provider: worker ? "bm-worker" : "bm-manager" },
    ...over,
  });
}

const compactionEvidence = (agentId: string, at: string): Evidence => ({ kind: "compaction", detail: "manual", agentId, at, trigger: "manual", preTokens: null });

async function store(...records: TraceRecord[]): Promise<void> {
  for (const record of records) await appendRecord(location(), record);
}

/** A tool call sending a report, as a Worker's report turn ends (worker.md, Reporting). */
const reportCall = {
  type: "tool_call",
  name: "mcp__paseo__send_agent_prompt",
  status: "completed",
  detail: { type: "unknown", input: { agentId: MANAGER, prompt: `BM-REPORT\nrequestId: ${REQUEST}\nphase: finished\ntier: Small` } },
};
const entry = (item: Record<string, unknown>, minute: number) => ({ item, timestamp: iso(T0 + minute * MIN) });
/** A Worker timeline whose last turn sent a report: its safe point. */
const reportedTimeline = [entry({ type: "user_message", text: `Request ${REQUEST}: fix the date.` }, 1), entry({ type: "assistant_message", text: "Fixed." }, 2), entry(reportCall, 3)];
/** A Worker timeline whose last turn sent none. */
const busyTimeline = [entry({ type: "user_message", text: `Request ${REQUEST}: fix the date.` }, 1), entry({ type: "assistant_message", text: "Working on it." }, 2)];

/** The daemon: an Orchestrator, a Manager, its Worker and the Worker's Reviewer, each alias extending `provider`. */
function daemon(options: { provider?: Provider; worker?: string; manager?: string; timeline?: unknown[]; aliases?: boolean } = {}): FakePaseo<unknown> {
  const provider = options.provider ?? "claude";
  return fakePaseo({
    agents: [
      {
        id: ORCHESTRATOR,
        provider: "bm-orchestrator/claude-opus-5-5",
        status: "idle",
        workspaceId: "wks-own",
        labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
        createdAt: iso(T0),
      },
      { id: MANAGER, provider: "bm-manager", status: options.manager ?? "idle", workspaceId: WORKSPACE_ID, labels: { "bm.role": "manager" }, createdAt: iso(T0) },
      {
        id: WORKER,
        provider: "bm-worker",
        status: options.worker ?? "idle",
        workspaceId: WORKSPACE_ID,
        labels: { "bm.role": "worker", "bm.requestId": REQUEST, "paseo.parent-agent-id": MANAGER },
        createdAt: iso(T0),
      },
      {
        id: REVIEWER,
        provider: "bm-reviewer",
        status: "idle",
        workspaceId: WORKSPACE_ID,
        labels: { "bm.role": "reviewer", "bm.requestId": REQUEST, "paseo.parent-agent-id": WORKER },
        createdAt: iso(T0),
      },
    ],
    workspaces: [{ id: WORKSPACE_ID, directory: "/work/invoice-app" }],
    timelines: { [WORKER]: options.timeline ?? reportedTimeline },
    config:
      options.aliases === false
        ? {}
        : { providers: { "bm-worker": { extends: provider, label: "Beads Worker" }, "bm-manager": { extends: provider, label: "Beads Manager" } } },
  });
}

function runnerOf(): CompactionRunner {
  return createCompactionRunner({ home: () => home, now: () => clock, queue, log: (line) => logs.push(line), redactEnv: { PASEO_PASSWORD: SECRET } });
}

/** A turn-ended event of the Worker, with the timeline items the hook hands over. */
const workerEnded = (items: readonly unknown[]) => ({ agent: { id: WORKER }, turnId: "t", timeline: items });
const itemsOf = (timeline: ReadonlyArray<{ item: unknown }>) => timeline.map((line) => line.item);

/** A turn of `record`'s agent recorded and handed to the runner (the collector's `onRecorded`), with its turn's timeline items. */
async function recorded(fake: FakePaseo<unknown>, record: TraceRecord, items: readonly unknown[] = [], runner: CompactionRunner = runnerOf()): Promise<CompactionRunner> {
  await store(record);
  await runner.turnRecorded({ agent: { id: record.agentId }, turnId: "t", timeline: items }, record, fake.paseo);
  return runner;
}

describe("the start: a recorded turn crossing the owner's threshold, else nothing written (missions design §9.5, autonomy design §G.7)", () => {
  const nothingWritten = () => {
    expect(existsSync(compactionsFile())).toBe(false);
    expect(interventions()).toEqual([]);
  };

  it("judges a Manager's or a Worker's turn by its role's figure, never a turn holding a compaction", () => {
    const settings = DEFAULT_COORDINATION_SETTINGS;
    expect(contextCrossingOf(agentTurn(WORKER, 10), settings)).toEqual({ figure: "tokensPerTurn", value: 6_100_000, threshold: 5_700_000 });
    expect(contextCrossingOf(agentTurn(MANAGER, 10, "claude", { usage: usageOf("claude", { cachedInputTokens: 400_000 }) }), settings)).toMatchObject({ figure: "tokensPerTurn", threshold: 390_000 });
    expect(contextCrossingOf(agentTurn(WORKER, 10, "codex"), settings)).toMatchObject({ figure: "contextShare", threshold: 0.5 });
    expect(contextCrossingOf(agentTurn(WORKER, 10, "claude", { usage: usageOf("claude", { cachedInputTokens: 1_000_000 }) }), settings)).toBeNull();
    expect(contextCrossingOf(agentTurn(REVIEWER, 10, "claude", { role: "reviewer" }), settings)).toBeNull();
    expect(contextCrossingOf(agentTurn(WORKER, 10, "claude", { evidence: [compactionEvidence(WORKER, iso(T0 + 10 * MIN))] }), settings)).toBeNull();
    expect(crossingWordsOf({ figure: "tokensPerTurn", value: 6_100_000, threshold: 5_700_000 })).toBe("it read 6,100,000 tokens in one turn (threshold 5,700,000)");
    expect(crossingWordsOf({ figure: "contextShare", value: 0.58, threshold: 0.5 })).toBe("its context filled 58 % of its window (threshold 50 %)");
  });

  it("starts nothing when compaction is off", async () => {
    createCoordinationStore(home).set({ key: "compact.enabled", value: false });
    const fake = daemon();
    await recorded(fake, agentTurn(WORKER, 10), itemsOf(reportedTimeline));
    nothingWritten();
    expect(fake.sends).toEqual([]);
  });

  it("starts nothing for a Reviewer's or an Orchestrator's turn, below the threshold, or for a turn holding a compaction", async () => {
    const fake = daemon();
    const runner = runnerOf();
    await recorded(fake, agentTurn(REVIEWER, 10, "claude", { role: "reviewer" }), [], runner);
    await recorded(fake, agentTurn(ORCHESTRATOR, 10, "claude", { role: "orchestrator" }), [], runner);
    await recorded(fake, agentTurn(WORKER, 11, "claude", { usage: usageOf("claude", { cachedInputTokens: 1_000_000 }) }), itemsOf(reportedTimeline), runner);
    await recorded(fake, agentTurn(WORKER, 13, "claude", { evidence: [compactionEvidence(WORKER, iso(T0 + 13 * MIN))] }), itemsOf(reportedTimeline), runner);
    nothingWritten();
    expect(fake.sends).toEqual([]);
  });

  it("starts nothing when its provider cannot compact on request", async () => {
    const fake = daemon({ aliases: false });
    await recorded(fake, agentTurn(WORKER, 10, "claude", { usage: usageOf("claude", { model: "mystery-1" }), runtime: { model: "mystery-1", thinkingOptionId: null, modeId: null, provider: "bm-worker" } }), itemsOf(reportedTimeline));
    nothingWritten();
  });

  it("starts one per agent while one is pending, and none at compact.maxPerAgent — a Manager's as a Worker's", async () => {
    createCoordinationStore(home).set({ key: "compact.maxPerAgent", value: 1 });
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    const runner = runnerOf();
    await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline), runner);
    const written = { compactions: compactions().list(), interventions: interventions() };
    expect(written.compactions).toMatchObject([{ agentId: WORKER, state: "waiting" }]);
    // A second crossing turn while it waits: the same compaction, nothing more written.
    await recorded(fake, agentTurn(WORKER, 12), itemsOf(busyTimeline), runner);
    expect(compactions().list()).toEqual(written.compactions);
    // Its /compact went out: one compaction so far, the owner's limit of 1.
    compactions().update(written.compactions[0]!.id, (current) => ({ ...current, state: "done", sentAt: clock.toISOString(), endedAt: clock.toISOString() }));
    const done = compactions().list();
    await recorded(fake, agentTurn(WORKER, 14), itemsOf(reportedTimeline), runner);
    expect(compactions().list()).toEqual(done);
    // A Manager at its limit is not compacted again.
    compactions().add({ workspaceId: WORKSPACE_ID, requestId: null, agentId: MANAGER, role: "manager", provider: "claude", interventionId: null, reason: "" });
    compactions().update(compactions().list().at(-1)!.id, (current) => ({ ...current, state: "done", sentAt: clock.toISOString(), endedAt: clock.toISOString() }));
    const before = compactions().list();
    await recorded(fake, agentTurn(MANAGER, 15, "claude", { usage: usageOf("claude", { cachedInputTokens: 500_000 }) }), [], runner);
    expect(compactions().list()).toEqual(before);
    expect(interventions()).toEqual(written.interventions);
    expect(fake.sends).toEqual([]);
  });
});

describe("the command per provider (design §G.5 Verified)", () => {
  it("Claude gets /compact with the fixed focus; Codex and OpenCode a bare /compact", () => {
    expect(compactCommandOf("claude")).toBe(`/compact ${COMPACT_FOCUS}`);
    expect(compactCommandOf("codex")).toBe("/compact");
    expect(compactCommandOf("opencode")).toBe("/compact");
    // The focus keeps what the design names and drops tool output, on one line.
    for (const part of ["owner's request", "every word the owner wrote", "decisions taken", "bead state", "open review findings", "files changed", "Drop: tool output"]) {
      expect(COMPACT_FOCUS).toContain(part);
    }
    expect(COMPACT_FOCUS).not.toContain("\n");
  });

  it.each([
    ["claude", `/compact ${COMPACT_FOCUS}`],
    ["codex", "/compact"],
    ["opencode", "/compact"],
  ] as const)("an idle %s Worker whose crossing turn sent a report gets its command at once, through the notice queue", async (provider, command) => {
    const fake = daemon({ provider });
    await recorded(fake, agentTurn(WORKER, 10, provider), itemsOf(reportedTimeline));
    expect(fake.sends).toEqual([{ id: WORKER, text: command }]);
    expect(compactions().list()).toMatchObject([{ agentId: WORKER, role: "worker", provider, state: "compacting", sentAt: clock.toISOString(), requestId: REQUEST }]);
    // The send log keeps the agent, the time and the text's hash, never the text.
    expect(compactions().sent()).toEqual([{ agentId: WORKER, at: clock.toISOString(), hash: sentTextHashOf(command), compactionId: compactions().list()[0]!.id }]);
  });

  it("the provider comes from the turn's model", async () => {
    const fake = daemon({ aliases: false });
    await recorded(fake, agentTurn(WORKER, 10, "codex"), itemsOf(reportedTimeline));
    expect(fake.sends).toEqual([{ id: WORKER, text: "/compact" }]);
    expect(compactions().list()[0]).toMatchObject({ provider: "codex" });
  });
});

describe("the sequence (design §G.5): idle after a safe point, the /compact once, the brief after the compaction, never into a running turn", () => {
  it("a running Worker waits; a turn end without a report does not send; the turn end after its report sends the /compact once; the brief follows the completed compaction", async () => {
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    // Its crossing turn sent no report: the compaction starts and waits for a safe point.
    const runner = await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline));
    expect(fake.sends).toEqual([]);
    expect(queue.pending(WORKER)).toEqual([]);
    const [waiting] = compactions().list();
    expect(waiting).toMatchObject({ state: "waiting", sentAt: null, reason: "it read 6,100,000 tokens in one turn (threshold 5,700,000)" });
    expect(interventions()).toMatchObject([{ id: waiting!.interventionId, kind: "compact", targetAgentId: WORKER, requestId: REQUEST, trigger: "threshold.crossed", expected: "tokens-per-turn-down" }]);

    // Its turn ends without a report: no safe point, nothing sent.
    fake.byId(WORKER)!.status = "idle";
    clock = new Date(T0 + 32 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(busyTimeline)), agentTurn(WORKER, 32), fake.paseo);
    expect(fake.sends).toEqual([]);

    // Its next turn ends right after a report, but it is running again: the queue holds it, never into the turn.
    fake.byId(WORKER)!.status = "running";
    clock = new Date(T0 + 34 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 34), fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(queue.pending(WORKER)).toEqual([{ kind: `${COMPACT_BATCH_NAME}:${waiting!.id}`, text: compactCommandOf("claude") }]);
    // Held past its safe moment, it is dropped at that turn's end and waits for the next safe point.
    fake.byId(WORKER)!.status = "idle";
    clock = new Date(T0 + 34 * MIN + SAFE_SEND_MS + 1);
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(compactions().list()[0]).toMatchObject({ state: "waiting" });

    // The turn end right after its next report, idle: the /compact goes, once.
    clock = new Date(T0 + 40 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 40), fake.paseo);
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
    expect(compactions().list()[0]).toMatchObject({ state: "compacting", sentAt: clock.toISOString() });
    // One send-log entry for it, at the moment it went out (its held attempt moved, not doubled).
    expect(compactions().sent()).toMatchObject([{ agentId: WORKER, at: clock.toISOString(), hash: sentTextHashOf(compactCommandOf("claude")) }]);

    // The compaction's turn ends with the item still loading: no brief yet. Another safe point sends nothing more.
    fake.byId(WORKER)!.status = "idle";
    clock = new Date(T0 + 41 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 41, "claude", { usage: usageOf("claude", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }) }), fake.paseo);
    expect(fake.sends).toHaveLength(1);

    // The completed compaction item: the BM-STATE brief goes, after it, and the compaction is done.
    clock = new Date(T0 + 42 * MIN);
    const compacted = agentTurn(WORKER, 42, "claude", { usage: usageOf("claude", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), evidence: [compactionEvidence(WORKER, iso(T0 + 42 * MIN))] });
    await runner.turnRecorded(workerEnded([]), compacted, fake.paseo);
    expect(fake.sends.map((sent) => [sent.id, sent.text.split("\n")[0]])).toEqual([
      [WORKER, compactCommandOf("claude")],
      [WORKER, STATE_NOTICE_MARKER],
    ]);
    expect(compactions().list()[0]).toMatchObject({ state: "done", compactedAt: iso(T0 + 42 * MIN), briefAt: clock.toISOString() });
    // The brief is logged too; nothing went to the Manager, the Reviewer or the Orchestrator.
    expect(compactions().sent().map((sent) => sent.hash)).toEqual([sentTextHashOf(compactCommandOf("claude")), sentTextHashOf(fake.sends[1]!.text)]);
    // A later turn of the Worker below its threshold sends nothing more.
    fake.byId(WORKER)!.status = "idle";
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 45, "claude", { usage: usageOf("claude", { cachedInputTokens: 1_000_000 }) }), fake.paseo);
    expect(fake.sends).toHaveLength(2);
    // One crossing again starts the next compaction (its second, the owner's limit), at that safe point.
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 46), fake.paseo);
    expect(fake.sends.map((sent) => sent.text.split("\n")[0])).toEqual([compactCommandOf("claude"), STATE_NOTICE_MARKER, compactCommandOf("claude")]);
    expect(compactions().list().map((entry) => entry.state)).toEqual(["done", "compacting"]);
  });

  it("a /compact held while the Worker turned busy is replaced, not doubled, at its next safe point", async () => {
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    const runner = await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline));
    expect(compactions().list()).toMatchObject([{ state: "waiting" }]);
    // A safe point, but it runs again at once: held in the queue.
    clock = new Date(T0 + 34 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 34), fake.paseo);
    expect(queue.pending(WORKER)).toHaveLength(1);
    // Its next safe point, idle: the runner looks first; the held one is replaced and the /compact goes once.
    fake.byId(WORKER)!.status = "idle";
    clock = new Date(T0 + 50 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 50), fake.paseo);
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
    expect(queue.pending(WORKER)).toEqual([]);
    expect(compactions().list()[0]).toMatchObject({ state: "compacting", sentAt: clock.toISOString() });
  });

  it("a Codex Worker compacts in a turn of its own: the brief follows that turn's completed item", async () => {
    const fake = daemon({ provider: "codex" });
    const runner = await recorded(fake, agentTurn(WORKER, 10, "codex"), itemsOf(reportedTimeline));
    expect(fake.sends).toEqual([{ id: WORKER, text: "/compact" }]);
    fake.byId(WORKER)!.status = "idle";
    clock = new Date(T0 + 31 * MIN);
    const autonomous = agentTurn(WORKER, 31, "codex", { turnId: "autonomous-b94b2632", evidence: [compactionEvidence(WORKER, iso(T0 + 31 * MIN))] });
    await runner.turnRecorded(workerEnded([]), autonomous, fake.paseo);
    expect(fake.sends.map((sent) => sent.text.split("\n")[0])).toEqual(["/compact", STATE_NOTICE_MARKER]);
  });

  it("an idle Manager with nothing queued is compacted at once; with a notice queued for it, at a later turn end with none", async () => {
    const fake = daemon();
    const runner = runnerOf();
    await queue.enqueue(MANAGER, "BM-TEST", "BM-TOOLS a notice first", fake.paseo as never);
    expect(fake.sends).toEqual([{ id: MANAGER, text: "BM-TOOLS a notice first" }]);
    fake.byId(MANAGER)!.status = "idle";
    // Something is still queued for it: the notice queue holds a second one while it runs.
    fake.byId(MANAGER)!.status = "running";
    await queue.enqueue(MANAGER, "BM-OTHER", "BM-SETTINGS second", fake.paseo as never);
    fake.byId(MANAGER)!.status = "idle";
    await recorded(fake, agentTurn(MANAGER, 10, "claude", { usage: usageOf("claude", { cachedInputTokens: 400_000 }) }), [], runner);
    expect(compactions().list()).toMatchObject([{ agentId: MANAGER, state: "waiting" }]);
    expect(fake.sends).toHaveLength(1);
    // The queued notice goes at its turn end; the next one, with nothing queued, sends the /compact.
    await queue.turnEnded({ agent: { id: MANAGER } }, fake.paseo);
    expect(fake.sends.map((sent) => sent.text)).toEqual(["BM-TOOLS a notice first", "BM-SETTINGS second"]);
    fake.byId(MANAGER)!.status = "idle";
    clock = new Date(T0 + 35 * MIN);
    await runner.turnRecorded({ agent: { id: MANAGER }, timeline: [] }, agentTurn(MANAGER, 35), fake.paseo);
    expect(fake.sends.map((sent) => sent.text)).toEqual(["BM-TOOLS a notice first", "BM-SETTINGS second", compactCommandOf("claude")]);
    expect(compactions().list()).toMatchObject([{ agentId: MANAGER, role: "manager", requestId: null, state: "compacting" }]);
  });

  it("an idle Manager with nothing queued gets its /compact at the end of its crossing turn, logged as threshold.crossed with the crossing as its reason", async () => {
    const fake = daemon();
    await recorded(fake, agentTurn(MANAGER, 10, "claude", { usage: usageOf("claude", { cachedInputTokens: 400_000 }) }));
    expect(fake.sends).toEqual([{ id: MANAGER, text: compactCommandOf("claude") }]);
    expect(interventions()).toMatchObject([{ kind: "compact", targetAgentId: MANAGER, requestId: null, trigger: "threshold.crossed" }]);
    expect(compactions().list()).toMatchObject([{ agentId: MANAGER, role: "manager", requestId: null, state: "compacting", reason: "it read 500,000 tokens in one turn (threshold 390,000)" }]);
    // Nothing reached the Orchestrator: no model asked for it.
    expect(fake.sends.filter((sent) => sent.id === ORCHESTRATOR)).toEqual([]);
  });

  it("turned off while it waits: dropped at the next safe point, nothing sent; waiting past its bound, or compacting past its bound, ends it", async () => {
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    const runner = await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline));
    expect(compactions().list()).toMatchObject([{ state: "waiting" }]);
    createCoordinationStore(home).set({ key: "compact.enabled", value: false });
    fake.byId(WORKER)!.status = "idle";
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 32), fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(compactions().list()[0]).toMatchObject({ state: "dropped", ending: "off" });

    // Back on: the next crossing turn starts a new one; with no safe point within its bound it is dropped, and the next starts again.
    createCoordinationStore(home).set({ key: "compact.enabled", value: true });
    fake.byId(WORKER)!.status = "running";
    await recorded(fake, agentTurn(WORKER, 33), itemsOf(busyTimeline), runner);
    expect(compactions().list()).toHaveLength(2);
    clock = new Date(clock.getTime() + SAFE_POINT_WAIT_MS + 1);
    expect(compactions().expire()).toMatchObject([{ state: "dropped", ending: "no-safe-point" }]);
    await recorded(fake, agentTurn(WORKER, 100), itemsOf(busyTimeline), runner);
    expect(compactions().list()).toHaveLength(3);
    // Sent, and no compaction seen within its bound: failed, and it counts as sent.
    const sent = compactions().list().at(-1)!;
    compactions().update(sent.id, (current) => ({ ...current, state: "compacting", sentAt: clock.toISOString() }));
    clock = new Date(clock.getTime() + COMPACTION_WAIT_MS + 1);
    await runner.turnRecorded(workerEnded([]), agentTurn(WORKER, 200), fake.paseo);
    expect(compactions().get(sent.id)).toMatchObject({ state: "failed", ending: "no-compaction" });
    expect(fake.sends).toEqual([]);
  });

  it("a Worker's safe point is a turn that sent a report, through send_agent_prompt or in its own chat", () => {
    expect(reportedIn(itemsOf(reportedTimeline))).toBe(true);
    expect(reportedIn(itemsOf(busyTimeline))).toBe(false);
    // Codex names an MCP tool server.tool; the report is the prompt's block.
    expect(reportedIn([{ type: "user_message", text: "go" }, { ...reportCall, name: "paseo.send_agent_prompt" }])).toBe(true);
    expect(reportedIn([{ type: "user_message", text: "go" }, { type: "assistant_message", text: `BM-REPORT\nrequestId: ${REQUEST}\nphase: blocked` }])).toBe(true);
    // A report of an earlier turn does not count: the last turn starts at its user message.
    expect(reportedIn([reportCall, { type: "user_message", text: "BM-STATE …" }, { type: "assistant_message", text: "noted" }])).toBe(false);
    expect(reportedIn([{ type: "user_message", text: "go" }, { ...reportCall, detail: { input: { prompt: "Please look at Q1." } } }])).toBe(false);
  });
});

describe("a bound Worker's safe point: its report in its turn record (design §16.7)", () => {
  it("its bm_report, which the collector puts in its turn record from the outbox, is its safe point though its timeline holds no BM-REPORT", async () => {
    const fake = daemon({ timeline: busyTimeline });
    await recorded(fake, agentTurn(WORKER, 10, "claude", { reports: [report({ agentId: WORKER, at: iso(T0 + 10 * MIN), requestId: REQUEST, phase: "bead-implemented" })] }), itemsOf(busyTimeline));
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
  });
});

describe("the maintenance ceiling (delivery line design §6.6)", () => {
  /** 12.1M tokens read in one turn: over twice the Worker's 5.7M threshold. */
  const heavy = (minute: number) => agentTurn(WORKER, minute, "claude", { usage: usageOf("claude", { cachedInputTokens: 12_000_000 }) });
  const firstLines = (fake: FakePaseo<unknown>) => fake.sends.map((sent) => sent.text.split("\n")[0]);
  /** Two deliveries queued for the Worker while it runs; then it is idle. */
  async function queuedItems(fake: FakePaseo<unknown>): Promise<void> {
    await queue.enqueue(WORKER, "BM-DELIVERY:a", "BM-DELIVERY a", fake.paseo as never);
    await queue.enqueue(WORKER, "BM-DELIVERY:b", "BM-DELIVERY b", fake.paseo as never);
    fake.byId(WORKER)!.status = "idle";
  }

  it("at twice its threshold the /compact goes at that turn end with no report and items queued, ahead of them; BM-STATE goes first after the compaction, then the items", async () => {
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    await queuedItems(fake);
    const runner = await recorded(fake, heavy(10), itemsOf(busyTimeline));
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual(["BM-DELIVERY:a", "BM-DELIVERY:b"]);
    expect(compactions().list()).toMatchObject([{ state: "compacting" }]);
    // The compaction's turn: the brief goes before what waited.
    fake.byId(WORKER)!.status = "idle";
    clock = new Date(T0 + 32 * MIN);
    const compacted = agentTurn(WORKER, 32, "claude", { usage: usageOf("claude", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }), evidence: [compactionEvidence(WORKER, iso(T0 + 32 * MIN))] });
    await runner.turnRecorded(workerEnded([]), compacted, fake.paseo);
    expect(firstLines(fake)).toEqual([compactCommandOf("claude"), STATE_NOTICE_MARKER]);
    // Then the items, in order, one turn apart.
    for (let n = 0; n < 2; n += 1) {
      fake.byId(WORKER)!.status = "idle";
      await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    }
    expect(firstLines(fake)).toEqual([compactCommandOf("claude"), STATE_NOTICE_MARKER, "BM-DELIVERY a", "BM-DELIVERY b"]);
  });

  it("below it, a turn without a report, or with items queued, still waits", async () => {
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    await queuedItems(fake);
    // 6.1M: over the threshold, under twice it, and no report.
    const runner = await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline));
    expect(fake.sends).toEqual([]);
    // A report, but items are queued.
    await runner.turnRecorded(workerEnded(itemsOf(reportedTimeline)), agentTurn(WORKER, 12), fake.paseo);
    expect(fake.sends).toEqual([]);
    expect(compactions().list()).toMatchObject([{ state: "waiting" }]);
  });

  it("waiting 30 minutes, half its window, it goes at the next turn end without a safe point, ahead of what is queued", async () => {
    expect(MAINTENANCE_WAIT_MS.compact).toBe(30 * MIN);
    expect(MAINTENANCE_WAIT_MS.compact).toBe(SAFE_POINT_WAIT_MS / 2);
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    const runner = await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline));
    await queuedItems(fake);
    clock = new Date(T0 + 59 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(busyTimeline)), agentTurn(WORKER, 59), fake.paseo);
    expect(fake.sends).toEqual([]);
    clock = new Date(T0 + 60 * MIN);
    await runner.turnRecorded(workerEnded(itemsOf(busyTimeline)), agentTurn(WORKER, 60), fake.paseo);
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual(["BM-DELIVERY:a", "BM-DELIVERY:b"]);
  });

  it("queued at its ceiling behind a notice sent at that turn end, the /compact still goes at the next turn end, past SAFE_SEND_MS", async () => {
    // The queue ran first at this turn end and started another turn: the Worker reads running.
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    await recorded(fake, heavy(10), itemsOf(busyTimeline));
    const [entry] = compactions().list();
    expect(entry).toMatchObject({ state: "waiting", ceilingAt: clock.toISOString() });
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual([`${COMPACT_BATCH_NAME}:${entry!.id}`]);
    clock = new Date(clock.getTime() + SAFE_SEND_MS + 2 * MIN);
    fake.byId(WORKER)!.status = "idle";
    await queue.turnEnded({ agent: { id: WORKER } }, fake.paseo);
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
    expect(compactions().list()).toMatchObject([{ state: "compacting" }]);
  });

  it("reached once, its ceiling holds until it runs: a lighter next turn with no report and items queued still sends it first", async () => {
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    const runner = await recorded(fake, heavy(10), itemsOf(busyTimeline));
    // A reload forgets the queued /compact; deliveries queue meanwhile.
    queue.clear();
    await queuedItems(fake);
    clock = new Date(clock.getTime() + MIN);
    // 6.1M: under twice the threshold, and no report.
    await runner.turnRecorded(workerEnded(itemsOf(busyTimeline)), agentTurn(WORKER, 12), fake.paseo);
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
    expect(queue.pending(WORKER).map((notice) => notice.kind)).toEqual(["BM-DELIVERY:a", "BM-DELIVERY:b"]);
  });

  it("the owner's maintenance.ceilingFactor sets the ceiling", async () => {
    createCoordinationStore(home).set({ key: "maintenance.ceilingFactor", value: 3 });
    const fake = daemon({ worker: "running", timeline: busyTimeline });
    await queuedItems(fake);
    // 12.1M is under three times 5.7M.
    await recorded(fake, heavy(10), itemsOf(busyTimeline));
    expect(fake.sends).toEqual([]);
    expect(compactions().list()).toMatchObject([{ state: "waiting" }]);
  });

  it("a Worker waiting by structure is at a safe point: its /compact goes though the turn shows no report", async () => {
    const registry = createRequestRegistry(home, { backfill: () => [] });
    registry.register(WORKSPACE_ID, REQUEST, { source: "tool", managerId: MANAGER, workerId: WORKER });
    registry.setWaiting(WORKSPACE_ID, REQUEST, { since: clock.toISOString(), reportRecordId: "out-0000000000ff", wakeOn: "all", items: [{ kind: "question", id: "dec-1", settled: false }] });
    const fake = daemon({ timeline: busyTimeline });
    await recorded(fake, agentTurn(WORKER, 10), itemsOf(busyTimeline));
    expect(fake.sends).toEqual([{ id: WORKER, text: compactCommandOf("claude") }]);
  });
});

describe("the BM-STATE brief, from the stores (design §G.5 step 4)", () => {
  it("a Worker's holds the request and the owner's words, the decisions with their answers and the report's plan, beads, findings, files and checks — masked, bounded", async () => {
    await store(
      agentTurn(MANAGER, 1, "claude", { requestId: REQUEST, sent: [msg(MANAGER, iso(T0 + MIN), `Sửa định dạng ngày, mật khẩu ${SECRET}`, "user")] }),
      agentTurn(MANAGER, 20, "claude", {
        requestId: REQUEST,
        sent: [msg(MANAGER, iso(T0 + 19 * MIN), "BM-REPORT …", "agent"), msg(MANAGER, iso(T0 + 20 * MIN), "Dùng dd/mm/yyyy nhé.", "user")],
        reports: [
          report({ at: iso(T0 + 19 * MIN), requestId: REQUEST, phase: "beads-done", tier: "Large", filesChanged: ["docs/plans/date-plan.md"], beadsCreated: ["bd-1", "bd-2"] }),
        ],
      }),
      agentTurn(MANAGER, 25, "claude", {
        requestId: REQUEST,
        reports: [
          report({
            at: iso(T0 + 25 * MIN),
            requestId: REQUEST,
            phase: "blocked",
            tier: "Large",
            filesChanged: ["src/date.ts"],
            beadsClosed: ["bd-1"],
            beadsReady: ["bd-2"],
            reviewFindingsOpen: "b1: the parser drops the year",
            buildAndTests: "`npm test` pass",
            decided: ["dd/mm/yyyy — the owner's words"],
            blockers: "Q1",
          }),
        ],
      }),
    );
    const decisions = createDecisionStore(home, { log: () => {} });
    const asked = makeDecision({ id: `q:${REQUEST}:Q1`, workspaceId: WORKSPACE_ID, requestId: REQUEST, question: "Push the fix?" });
    decisions.open(asked);
    const answered = answerDecision(asked, { via: "inbox", optionKey: "c", at: iso(T0 + 26 * MIN) });
    if (answered.ok) decisions.transition(asked.id, () => answered, WORKSPACE_ID);
    decisions.open(makeDecision({ id: `q:${REQUEST}:Q2`, workspaceId: WORKSPACE_ID, requestId: REQUEST, question: "Rename the column?" }));

    const brief = stateBriefOf(
      { ...compactions().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: "" }) },
      home,
      { PASEO_PASSWORD: SECRET },
    );
    expect(isPluginNotice(brief)).toBe(true);
    const lines = brief.split("\n");
    expect(lines[0]).toBe(STATE_NOTICE_MARKER);
    expect(lines[1]).toMatch(/^From the paseo-bm plugin, not the owner: your context was just compacted/);
    expect(lines[1]).toContain("reply `noted` in one line and end this turn");
    // No word a Worker reads as a stop (worker.md, Stop).
    expect(lines[1]).not.toMatch(/\b(stop|halt|pause|cancel|wait)\b/i);
    expect(lines.slice(2)).toEqual([
      "role: worker",
      `requestId: ${REQUEST}`,
      "request: Sửa định dạng ngày, mật khẩu [redacted]",
      "ownerSaid:",
      `- ${iso(T0 + 20 * MIN)}: Dùng dd/mm/yyyy nhé.`,
      "decisions:",
      `- q:${REQUEST}:Q1 (answered c — Hold): Push the fix?`,
      `- q:${REQUEST}:Q2 (open): Rename the column?`,
      `lastReport: blocked at ${iso(T0 + 25 * MIN)}`,
      "tier: Large",
      "filesChanged: docs/plans/date-plan.md, src/date.ts",
      "beadsCreated: bd-1, bd-2",
      "beadsClosed: bd-1",
      "beadsReady: bd-2",
      "reviewFindingsOpen: b1: the parser drops the year",
      "checks: `npm test` pass",
      "decided: dd/mm/yyyy — the owner's words",
      "blockers: Q1",
    ]);
    expect(brief).not.toContain(SECRET);
  });

  it("a Worker's carries its request's links with each one's latest message and refs, and its mission's live contracts touching its repo (delivery line design §9.3)", async () => {
    await store(agentTurn(MANAGER, 1, "claude", { requestId: REQUEST, sent: [msg(MANAGER, iso(T0 + MIN), "Show the invoices.", "user")] }));
    const API = "wks_api";
    const made = createMissionStore(home, { newId: () => "mis-00000000aa", env: {}, now: () => clock }).create({ code: "INV", name: "Invoices", goal: "Bill", repos: [WORKSPACE_ID, API], createdBy: "owner", mainId: MANAGER });
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const contract = (id: string, over: Record<string, unknown>) => ({ id, title: `API ${id}`, providerRepo: API, consumerRepos: [WORKSPACE_ID], text: "GET /x", version: 1, updatedAt: iso(T0), source: "PRD", ...over });
    createMissionStore(home, { env: {}, now: () => clock }).update("mis-00000000aa", (mission) => ({
      ...mission,
      contracts: [contract("C1", {}), contract("C2", { status: "proposed", version: 2 }), contract("C3", { providerRepo: "wks_other", consumerRepos: [] }), contract("C4", { status: "withdrawn" })],
    }));
    createMissionRoster(home).add("mis-00000000aa", { requestId: REQUEST, workspaceId: WORKSPACE_ID, topic: "Invoices", workerId: WORKER });
    let n = 0;
    const links = createPeerLinkStore(home, { newId: () => `peer-00000000000${(n += 1)}`, now: () => new Date(T0 + 20 * MIN) });
    links.createLink({ kind: "question", from: { workspaceId: WORKSPACE_ID, requestId: REQUEST, agentId: WORKER, role: "worker" }, to: { workspaceId: API, managerId: null }, text: "Which page size?" });
    links.appendMessage("peer-000000000001", { recordId: "out-000000000001", workspaceId: WORKSPACE_ID, side: "asker", agentId: WORKER, kind: "peer", text: "Which page size?", act: "ask" });
    links.appendMessage("peer-000000000001", { recordId: "out-000000000002", workspaceId: API, side: "answerer", agentId: "agent-api", kind: "peer-message", text: `Fifty, as in C2 v2; key ${SECRET}.`, act: "agree", refs: { contracts: ["C2@v2"] } });
    // Another request's link is not this Worker's.
    links.createLink({ kind: "work", from: { workspaceId: WORKSPACE_ID, requestId: "req-20260930T120000Z", agentId: "agent-other", role: "worker" }, to: { workspaceId: API, managerId: null }, text: "Not mine" });

    const entry = compactions().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: "" });
    const expected = [
      "links:",
      `- peer-000000000001 to ${API} (question, open): last agree by ${API} 10 min ago: Fifty, as in C2 v2; key [redacted]. · refs C2@v2`,
      "contracts:",
      `- C2 v2 proposed: API C2 (provider ${API}; consumers ${WORKSPACE_ID})`,
      `- C1 v1 agreed: API C1 (provider ${API}; consumers ${WORKSPACE_ID})`,
    ];
    expect(workerLinkLines(home, entry, { PASEO_PASSWORD: SECRET }, clock)).toEqual(expected);
    const brief = stateBriefOf(entry, home, { PASEO_PASSWORD: SECRET });
    const lines = brief.split("\n");
    // After the decisions, before the reports.
    expect(lines.slice(lines.indexOf("links:"), lines.indexOf("links:") + 5).map((line) => line.replace(/ \d+ (min|h) ago/, " … ago"))).toEqual(expected.map((line) => line.replace(/ \d+ (min|h) ago/, " … ago")));
    expect(lines.indexOf("decisions: none")).toBeLessThan(lines.indexOf("links:"));
    expect(lines.indexOf("contracts:")).toBeLessThan(lines.indexOf("lastReport: none"));
    expect(brief).not.toContain(SECRET);
    expect(brief.length).toBeLessThanOrEqual(STATE_BRIEF_MAX_CHARS);

    // Past its room, the contracts drop first, then the oldest links.
    const many = createPeerLinkStore(home, { newId: () => `peer-0000000001${(n += 1).toString(16).padStart(2, "0")}`, now: () => new Date(T0 + 20 * MIN) });
    const records = Array.from({ length: 10 }, (_, r) => `out-0000000000${r.toString(16).padStart(2, "0")}`);
    for (let index = 0; index < 9; index += 1) {
      const made = many.createLink({ kind: "work", from: { workspaceId: WORKSPACE_ID, requestId: REQUEST, agentId: WORKER, role: "worker" }, to: { workspaceId: API, managerId: null }, text: "Open the port" });
      if (!made.ok) throw new Error(made.reasons.join("; "));
      many.appendMessage(made.link.linkId, { recordId: `out-00000000ff${index.toString(16).padStart(2, "0")}`, workspaceId: API, side: "answerer", agentId: "agent-api", kind: "peer-message", text: `${index} ${"y".repeat(400)}`, act: "answer", refs: { records } });
    }
    const bounded = workerLinkLines(home, entry, {}, clock);
    expect(bounded.join("\n").length).toBeLessThanOrEqual(WORKER_LINKS_BLOCK_MAX_CHARS);
    expect(bounded).not.toContain("contracts:");
    expect(bounded.filter((line) => line.startsWith("- peer-")).length).toBeLessThan(10);
    expect(bounded.at(-1)).toContain("8 yyyy");
  });

  it("a Manager's lists its newest requests and the owner's newest words, never as a request id the collector would take", async () => {
    await store(
      agentTurn(MANAGER, 1, "claude", { requestId: REQUEST, sent: [msg(MANAGER, iso(T0 + MIN), "Fix the date format.", "user")] }),
      agentTurn(MANAGER, 5, "claude", { requestId: REQUEST, reports: [report({ at: iso(T0 + 5 * MIN), requestId: REQUEST, phase: "received" })] }),
      agentTurn(WORKER, 6, "claude"),
    );
    const entry = compactions().add({ workspaceId: WORKSPACE_ID, requestId: null, agentId: MANAGER, role: "manager", provider: "codex", interventionId: null, reason: "" });
    const brief = stateBriefOf(entry, home, {});
    expect(brief.split("\n").slice(2)).toEqual([
      "role: manager",
      "requests (newest first):",
      `- ${REQUEST}: received, Worker ${WORKER}, open decisions 0; asked: Fix the date format.`,
      "ownerSaid (newest last):",
      `- ${iso(T0 + MIN)}: Fix the date format.`,
    ]);
    expect(brief).not.toMatch(/requestId\s*:/);
  });

  it("is at most 6,000 characters, whatever the stores hold", async () => {
    const long = "x".repeat(1_500);
    await store(
      ...Array.from({ length: 8 }, (_, n) => agentTurn(MANAGER, n + 1, "claude", { requestId: REQUEST, sent: [msg(MANAGER, iso(T0 + (n + 1) * MIN), `${n} ${long}`, "user")] })),
      agentTurn(MANAGER, 20, "claude", { requestId: REQUEST, reports: [report({ at: iso(T0 + 20 * MIN), requestId: REQUEST, phase: "finished", filesChanged: Array.from({ length: 200 }, (_, n) => `src/file-${n}.ts`) })] }),
    );
    for (let n = 1; n <= 8; n += 1) {
      createDecisionStore(home, { log: () => {} }).open(makeDecision({ id: `q:${REQUEST}:Q${n}`, workspaceId: WORKSPACE_ID, requestId: REQUEST, question: long.slice(0, 900) }));
    }
    const entry = compactions().add({ workspaceId: WORKSPACE_ID, requestId: REQUEST, agentId: WORKER, role: "worker", provider: "claude", interventionId: null, reason: "" });
    const brief = stateBriefOf(entry, home, {});
    expect(brief.length).toBeLessThanOrEqual(STATE_BRIEF_MAX_CHARS);
    expect(brief.startsWith(`${STATE_NOTICE_MARKER}\n`)).toBe(true);
  });
});

describe("the send log: the plugin's /compact is never the owner's words (design §G.5 Verified)", () => {
  it("matches the agent, the text's hash and the time; a leading /compact alone decides nothing", () => {
    const at = iso(T0);
    const log = [{ agentId: WORKER, at, hash: sentTextHashOf("/compact"), compactionId: "c-1" }];
    expect(isPluginSent(log, WORKER, "/compact", iso(T0 + 1_000))).toBe(true);
    expect(isPluginSent(log, WORKER, " /compact \n", iso(T0 + 1_000))).toBe(true);
    // Another agent, another text, or long after it: the owner's.
    expect(isPluginSent(log, MANAGER, "/compact", iso(T0 + 1_000))).toBe(false);
    expect(isPluginSent(log, WORKER, "/compact keep the tests", iso(T0 + 1_000))).toBe(false);
    expect(isPluginSent(log, WORKER, "/compact", iso(T0 + SEND_LOG_MATCH.afterMs + 1))).toBe(false);
    expect(isPluginSent(log, WORKER, "/compact", iso(T0 - SEND_LOG_MATCH.beforeMs - 1))).toBe(false);
    expect(isPluginSent([], WORKER, "/compact", at)).toBe(false);
    // A missing log or data folder reads as empty.
    expect(pluginSentMatcher(null)(WORKER, "/compact", at)).toBe(false);
    expect(pluginSentMatcher(join(root, "nowhere"))(WORKER, "/compact", at)).toBe(false);
  });

  it.each(["claude", "codex"] as const)(
    "the collector records the plugin's %s /compact as the plugin's, and the same text typed by the owner — no log entry — as the owner's",
    async (provider) => {
      const fake = daemon({ provider });
      await recorded(fake, agentTurn(WORKER, 10, provider), itemsOf(reportedTimeline));
      const command = compactCommandOf(provider);
      expect(fake.sends).toEqual([{ id: WORKER, text: command }]);
      // As the Paseo app and the SDK store it: a user_message with a clientMessageId.
      const event = (agentId: string) =>
        ({
          agent: { id: agentId, workspaceId: WORKSPACE_ID, parentAgentId: MANAGER, provider: "bm-worker", cwd: "/work/invoice-app", title: null },
          turnId: null,
          outcome: { kind: "completed" },
          timeline: [{ type: "user_message", text: command, messageId: "m1", clientMessageId: "c1" }],
        }) as never;
      const plugin = await buildRecord(event(WORKER), { location: location(), now: () => new Date(clock.getTime() + 20_000) });
      expect(plugin?.record.sent).toMatchObject([{ text: command, origin: "agent" }]);
      // The owner types the same text: to another agent, or hours later — no log entry matches.
      const other = await buildRecord(event("agent-worker-2"), { location: location(), now: () => new Date(clock.getTime() + 20_000) });
      expect(other?.record.sent).toMatchObject([{ text: command, origin: "user" }]);
      const later = await buildRecord(event(WORKER), { location: location(), now: () => new Date(clock.getTime() + 3 * 3_600_000) });
      expect(later?.record.sent).toMatchObject([{ text: command, origin: "user" }]);
      // With no send log at all it is the owner's too.
      const elsewhere = await buildRecord(event(WORKER), { location: { tracesDir: join(root, "elsewhere", "traces") }, now: () => clock });
      expect(elsewhere?.record.sent).toMatchObject([{ text: command, origin: "user" }]);
    },
  );
});
