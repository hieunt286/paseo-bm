import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { clearBindingCache, createBindingStore, liveBindingOf, type BindingStore, type ToolCaller } from "../../plugin/server/agent-bindings";
import { binderOf, joinServerTools } from "../../plugin/server/agent-tools";
import { clearBeadsCache } from "../../plugin/server/beads-store";
import { clearStartMarks, registerCollector } from "../../plugin/server/collector";
import { createCompactionRunner } from "../../plugin/server/compaction";
import { createCompactionStore } from "../../plugin/server/compaction-store";
import { createCoordinationStore } from "../../plugin/server/coordination-store";
import { clearJsonFileCache } from "../../plugin/server/data-files";
import { createQuestionDecisionDelivery } from "../../plugin/server/decision-delivery";
import { clearDecisionStoreCache, createDecisionStore } from "../../plugin/server/decision-store";
import { batchesAwaitingVerdict, createDeliveringTools } from "../../plugin/server/deliver-tools";
import { createHandoffRunner } from "../../plugin/server/handoff";
import { createHandoffStore, lastHandoffAtOf } from "../../plugin/server/handoff-store";
import { clearRequestIndexCache } from "../../plugin/server/mission-roster";
import { checkNoVerdict } from "../../plugin/server/no-verdict";
import { noticeQueue } from "../../plugin/server/notice-queue";
import { createOutbox } from "../../plugin/server/outbox";
import { createPeerLinkStore } from "../../plugin/server/peer-links";
import { createPeerTools } from "../../plugin/server/peer-tools";
import { clearRequestRegistryCache, createRequestRegistry, type RegisteredRequest } from "../../plugin/server/request-registry";
import { createReviewTools } from "../../plugin/server/review-tools";
import { applyAgentTools, type AgentCreateRequest } from "../../plugin/server/role-hook";
import { forgetModes } from "../../plugin/server/role-mode";
import { rolloverFiguresOf, rolloverTurnRecorded } from "../../plugin/server/rollover";
import { createStallWatcher } from "../../plugin/server/stall-watcher";
import { clearTraceStoreCache, readRecords } from "../../plugin/server/trace-store";
import { chainHeadOf } from "../../plugin/server/waits";
import { releaseSettledWaits } from "../../plugin/server/wake-gate";
import type { TraceRecord } from "../../plugin/shared/contracts";
import { turnTokensOf } from "../../plugin/shared/eval-metrics/tokens";
import { answerDecision } from "../../plugin/shared/decisions";
import { MAINTENANCE_WAIT_MS } from "../../plugin/shared/interventions";
import { unsettledItemsOf, waitMet } from "../../plugin/shared/waits";
import { bindAgent } from "../helpers/bindings";
import { dataFolder, removeDataFolders } from "../helpers/data-folder";
import { fakePaseo, type FakeAgent, type FakeCreateRequest } from "../helpers/fake-paseo";

/**
 * A seeded scripted mission (delivery line design §13, WP-7.9): Managers,
 * Workers and Reviewers of a few projects take turns over the one fake Paseo
 * and a temporary data folder, and every step goes through the plugin's real
 * code — `bm_report`, `bm_questions`, `bm_tell_worker`, `bm_create_reviewer`,
 * `bm_review`, `bm_rereview`, `bm_ask_project`, `bm_peer_reply`, the owner's
 * answers through the question delivery, a Reviewer's turn end without a
 * verdict (`checkNoVerdict`), the stall pass, and the collector's
 * `agent.turn_ended` hook with the recorded-turn chain the plugin hangs on it
 * (compaction, handoff, size rollover). The shared notice queue rides on the
 * turn end before the collector, as it does in the plugin.
 *
 * What the agents do is drawn from a seeded generator (no fast-check: it is
 * not a dependency), and an agent acts only as Paseo would let it: a send
 * starts its turn; a Worker whose turn ended without waiting is nudged on by
 * the owner's chat. The runner watches the four invariants of §13 as it goes
 * and returns what broke each, with the seed and the step, plus counts of
 * what the run exercised.
 */

// ---------------------------------------------------------------------------
// The scripted figures.
// ---------------------------------------------------------------------------

/**
 * The owner's settings for the run, within their bounds: rollover figures low
 * enough that requests reach them, the hard ones included, in a few hundred
 * turns; a handoff threshold below the rollover's tokens; a compaction figure
 * a heavy turn crosses.
 */
export const SCENARIO_SETTINGS = {
  "rollover.beads": 8,
  "rollover.turns": 15,
  "rollover.tokens": 25_000_000,
  "rollover.ceilingFactor": 2,
  "handoff.requestTokens": 20_000_000,
  "handoff.maxPerRequest": 1,
  "compact.workerTokensPerTurn": 3_000_000,
  "compact.maxPerAgent": 2,
  "maintenance.ceilingFactor": 2,
} as const;

const HARD = {
  beads: SCENARIO_SETTINGS["rollover.beads"] * SCENARIO_SETTINGS["rollover.ceilingFactor"],
  turns: SCENARIO_SETTINGS["rollover.turns"] * SCENARIO_SETTINGS["rollover.ceilingFactor"],
  tokens: SCENARIO_SETTINGS["rollover.tokens"] * SCENARIO_SETTINGS["rollover.ceilingFactor"],
};

/**
 * Turns after the one that reached a hard figure (a turn end of the request's
 * newest Worker, where the plugin judges it) that may still do the request's
 * work: the finishing turn, and one turn of slack (§13).
 */
export const HARD_SLACK_TURNS = 2;

const T0 = Date.parse("2026-10-05T07:10:00.000Z");
const ROLE_URL = (role: string) => `http://127.0.0.1:4567/mcp/${role}`;
const LANE_NAMES = ["a", "b", "c", "d"] as const;

/** The first lines of what goes to a waiting Worker at once (design §6.4, §6.6): maintenance, rollover now, commands, stops. */
const AT_ONCE_PREFIXES = ["/compact", "BM-STATE", "BM-HANDOFF", "BM-ROLLOVER now", "BM-REPLACED", "BM-COMMAND", "BM-STOP", "BM-SETTINGS"];
/** The sends that wake a Worker for maintenance only: such a turn does no work of the request. */
const MAINTENANCE_PREFIXES = ["/compact", "BM-STATE", "BM-HANDOFF", "BM-REPLACED"];

const firstLine = (text: string): string => text.split("\n", 1)[0] ?? "";
const isAtOnce = (text: string): boolean => AT_ONCE_PREFIXES.some((prefix) => firstLine(text).startsWith(prefix));
const isMaintenance = (text: string): boolean => MAINTENANCE_PREFIXES.some((prefix) => firstLine(text).startsWith(prefix));

/** mulberry32: a small seeded generator, enough for a reproducible script. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// What a run returns.
// ---------------------------------------------------------------------------

export interface ScenarioViolations {
  /** (1) A request did work past the hard rollover figures beyond one turn of slack. */
  bounded: string[];
  /** (2) The chains' closed beads differ from the beads closed. */
  beads: string[];
  /** (3) A Worker with an unsettled wait got a send, or was not woken exactly once when it settled. */
  waits: string[];
  /**
   * (3), the sends of one kind only: a notice the queue held for the Worker
   * while it was busy, before its blocked report set the wait, sent at that
   * turn's end into the wait (bug B1: the gate once looked at a delivery only
   * when it was queued).
   */
  queuedBeforeWait: string[];
  /**
   * (1) and (3), one cause only (bug B2): a batch opened by a Worker that a
   * handoff replaced gets its verdict addressed to that replaced Worker (its
   * Reviewer's parent). Released to it, the verdict clears the successor's
   * wait and wakes nobody; held for it, it never arrives, `finished` stays
   * refused for that batch, and the stall pass wakes the successor on the
   * dead batch again after each new wait.
   */
  verdictToReplaced: string[];
  /** (4) A compaction or handoff still waited a turn end after the one at its ceiling. */
  maintenance: string[];
  /**
   * (4), the waits of one kind only (bug B3): at its ceiling's turn end
   * another notice went to the agent first, so the maintenance item was
   * queued behind it, and at the next turn end it was still not sent.
   */
  staleAtCeiling: string[];
}

export interface ScenarioResult {
  seed: number;
  workerTurns: number;
  steps: number;
  violations: ScenarioViolations;
  /** What the run exercised, for the reader and for the test's floor on coverage. */
  counts: Record<string, number>;
}

export interface ScenarioOptions {
  seed: number;
  /** Worker turns to run (design §13: 500–2,000). */
  workerTurns: number;
  /** Projects, each with its Manager and a chain of requests; 3 by default. */
  lanes?: number;
  /** Each send, turn and plugin log line, as it happens: for reading a failing seed. */
  trace?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// The simulated agents.
// ---------------------------------------------------------------------------

interface SimAgent {
  id: string;
  role: "manager" | "worker" | "reviewer";
  lane: number;
  workspaceId: string;
  requestId: string | null;
  batchId: string | null;
  parentId: string | null;
  /** What was sent to it since its last turn, oldest first. */
  inbox: string[];
  /** Its recorded turn ends so far. */
  turnEnds: number;
  /** A Worker whose request ended or that was replaced: it does nothing more. */
  retired: boolean;
  /** A Worker that has sent its received report. */
  received: boolean;
  /** A Worker whose turn ended without a wait, a finish or a note: the owner nudges it on. */
  continues: boolean;
  /** `BM-ROLLOVER now` reached it: it finishes at its next chance. */
  finishNow: boolean;
  /** Turns left before it finishes after `BM-ROLLOVER soft`. */
  softLeft: number | null;
  /** The owner told it in its chat to go on: this turn it acts whatever it waits on. */
  nudged: boolean;
  /** It wrote its handoff note: it starts nothing new until it is replaced (handoff.ts `noteRequestOf`). */
  handedOff: boolean;
  /** A Reviewer's blocking findings in its last review. */
  blocking: number | null;
}

/** One request's own figures, as the script knows them (design §2.6). */
interface SimRequest {
  key: string;
  workspaceId: string;
  requestId: string;
  lane: number;
  beads: Set<string>;
  turns: number;
  tokens: number;
  /** Its turn count when a figure first reached its hard value. */
  hardAt: number | null;
  /** Turns after `hardAt` that did the request's work (no maintenance wake, no verdict still to come). */
  workAfterHard: number;
  /** Of those, turns whose `finished` waited on a verdict its Reviewer had given, which never reached this Worker. */
  verdictElsewhere: number;
  ended: boolean;
}

/** A Worker's open structured wait (design §6.2), as the script watches it for invariant (3). */
interface WaitWatch {
  requestKey: string;
  /** The Worker whose blocked report set the wait: the one that must not be woken, then woken once. */
  workerId: string;
  workspaceId: string;
  requestId: string;
  since: number;
  /** Sends that arrived once the wait was met or cleared: exactly one is the release. */
  releases: number;
  /** What the notice queue held for the Worker when its blocked report set the wait. */
  queuedBefore: Set<string>;
  /** Another Worker of the request the release went to instead. */
  releasedTo: string | null;
}

/** A pending compaction's or handoff's first turn end at its ceiling (design §6.6), by entry id. */
interface CeilingWatch {
  agentId: string;
  firstAt: number | null;
  /** At that turn end the item went to the queue behind another notice instead of to the agent. */
  queuedAtCeiling: boolean;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Clears every module cache the plugin keeps between calls: each seed starts from nothing. */
export function clearScenarioCaches(): void {
  clearBindingCache();
  clearRequestRegistryCache();
  clearRequestIndexCache();
  clearDecisionStoreCache();
  clearTraceStoreCache();
  clearBeadsCache();
  clearJsonFileCache();
  clearStartMarks();
  forgetModes();
  noticeQueue.clear();
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/**
 * Runs one seeded mission of `workerTurns` Worker turns. Expects `Date` faked
 * by the caller (`vi.useFakeTimers({ toFake: ["Date"] })`) and `fsyncSync`
 * mocked away; sets the clock itself. Never throws for a broken invariant:
 * it returns the violations.
 */
export async function runScenario(options: ScenarioOptions): Promise<ScenarioResult> {
  const { seed, workerTurns } = options;
  const laneCount = Math.min(options.lanes ?? 3, LANE_NAMES.length);
  const random = generator(seed);
  const chance = (p: number): boolean => random() < p;
  const between = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  let clock = T0;
  vi.setSystemTime(clock);
  const now = (): Date => new Date();
  const tick = (ms: number): void => {
    clock += ms;
    vi.setSystemTime(clock);
  };

  clearScenarioCaches();
  const home = dataFolder("bm-scenario-");
  const root = dirname(home);
  vi.stubEnv("PASEO_BM_HOME", home);
  vi.stubEnv("HOME", root);
  const trace = options.trace ?? (() => {});
  const log = (line: string): void => trace(`  log: ${line}`);

  const violations: ScenarioViolations = { bounded: [], beads: [], waits: [], queuedBeforeWait: [], verdictToReplaced: [], maintenance: [], staleAtCeiling: [] };
  const counts: Record<string, number> = {};
  const count = (name: string, by = 1): void => {
    counts[name] = (counts[name] ?? 0) + by;
  };
  let step = 0;
  const where = (): string => `seed ${seed}, step ${step}`;

  // The owner's settings.
  const coordination = createCoordinationStore(home);
  for (const [key, value] of Object.entries(SCENARIO_SETTINGS)) coordination.set({ key, value });

  // The projects: a Manager each and the first request of its chain, with its Worker.
  const store: BindingStore = createBindingStore(home);
  const lanes = LANE_NAMES.slice(0, laneCount).map((name, lane) => {
    const workspaceId = `wks_${name}`;
    const repo = join(root, `repo-${name}`);
    mkdirSync(join(repo, ".beads"), { recursive: true });
    const requestId = `req-20261005T07000${lane}Z`;
    return { lane, name, workspaceId, repo, managerId: `mgr-${name}`, rootId: requestId, workerId: `wrk-${name}1` };
  });
  const agents = lanes.flatMap((lane): FakeAgent[] => [
    { id: lane.managerId, provider: "bm-manager/claude-opus-5", status: "idle", workspaceId: lane.workspaceId, cwd: lane.repo, model: "claude-opus-5", labels: { "bm.role": "manager" } },
    {
      id: lane.workerId,
      provider: "bm-worker/claude-opus-5",
      status: "running",
      workspaceId: lane.workspaceId,
      cwd: lane.repo,
      model: "claude-opus-5",
      labels: { "bm.role": "worker", "bm.requestId": lane.rootId, "paseo.parent-agent-id": lane.managerId },
    },
  ]);

  const sim = new Map<string, SimAgent>();
  const requests = new Map<string, SimRequest>();
  const waits = new Map<string, WaitWatch>();
  const ceilings = new Map<string, CeilingWatch>();
  const keyOf = (workspaceId: string, requestId: string): string => `${workspaceId}::${requestId}`;
  const laneOfWorkspace = (workspaceId: string): number => lanes.findIndex((lane) => lane.workspaceId === workspaceId);
  const requestOf = (workspaceId: string, requestId: string): SimRequest => {
    const key = keyOf(workspaceId, requestId);
    let found = requests.get(key);
    if (found === undefined) {
      found = { key, workspaceId, requestId, lane: laneOfWorkspace(workspaceId), beads: new Set(), turns: 0, tokens: 0, hardAt: null, workAfterHard: 0, verdictElsewhere: 0, ended: false };
      requests.set(key, found);
    }
    return found;
  };

  let fake: ReturnType<typeof fakePaseo> | null = null;
  /** Invariant (3): a send to a Worker whose request waits on unsettled items, or a second one after the release. */
  const observeSend = (id: string, text: string): void => {
    const agent = fake?.byId(id);
    const known = sim.get(id);
    trace(`step ${step}: send to ${id} (${agent?.status ?? "?"}): ${text.split("\n").slice(0, firstLine(text).startsWith("BM-UPDATES") ? 14 : 3).join(" | ")}`);
    if (known !== undefined) known.inbox.push(text);
    if (known?.role !== "worker" || known.requestId === null) return;
    if (agent?.status === "running" || agent?.status === "initializing") {
      violations.waits.push(`${where()}: ${firstLine(text)} was sent to Worker ${id} inside its running turn`);
    }
    const watch = waits.get(keyOf(known.workspaceId, known.requestId));
    if (watch === undefined) return;
    if (watch.workerId !== id) {
      const cleared = createRequestRegistry(home).get(known.workspaceId, known.requestId)?.waiting ?? null;
      if (!isAtOnce(text) && (cleared === null || waitMet(cleared))) watch.releasedTo = id;
      return;
    }
    if (isAtOnce(text)) {
      count("waits.atOnceSends");
      return;
    }
    const waiting = createRequestRegistry(home).get(known.workspaceId, known.requestId)?.waiting ?? null;
    if (waiting !== null && !waitMet(waiting)) {
      const open = unsettledItemsOf(waiting).map((item) => item.id);
      const line = `${where()}: Worker ${id} of ${known.requestId} waits on ${open.join(", ")} and was sent "${firstLine(text)}"`;
      if ([...watch.queuedBefore].some((queued) => text.includes(queued))) violations.queuedBeforeWait.push(`${line}, queued for it before its blocked report`);
      else violations.waits.push(line);
      return;
    }
    watch.releases += 1;
    count("waits.releases");
    if (watch.releases > 1) violations.waits.push(`${where()}: Worker ${id} of ${known.requestId} got a second send after its wait was met: "${firstLine(text)}"`);
  };

  fake = fakePaseo({
    agents,
    workspaces: lanes.map((lane) => ({ id: lane.workspaceId, directory: lane.repo })),
    config: {
      agentProfiles: [
        { id: "bm-worker", provider: "bm-worker", model: "claude-opus-5" },
        { id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6" },
      ],
      providers: { "bm-worker": { extends: "claude" }, "bm-manager": { extends: "claude" }, "bm-reviewer": { extends: "codex" } },
      mcp: { injectIntoAgents: true },
    },
    providers: { modes: { "bm-reviewer": [{ id: "auto", colorTier: "safe" }] } },
    created: (request: FakeCreateRequest) => {
      const reviewer = request.config.provider.startsWith("bm-reviewer");
      // The agent.create hook's part: it keeps the token URL, as the real hook does.
      applyAgentTools({ config: { ...request.config, cwd: request.cwd } } as unknown as AgentCreateRequest, { urlFor: ROLE_URL, bindings: store }, reviewer ? "codex" : "claude");
      // A new agent starts its first turn on its prompt.
      return { status: "running", model: reviewer ? "gpt-5.6" : "claude-opus-5", ...(request.prompt === undefined ? {} : { prompt: request.prompt }) };
    },
    onSend: ({ id, text }) => observeSend(id, text),
  });
  const daemon = fake;
  const paseo = daemon.paseo as unknown;

  // The plugin's parts, as index.server.ts wires them, over the one shared queue.
  const queue = noticeQueue;
  const binder = binderOf(ROLE_URL, store, log);
  let n = 0;
  const outbox = { newId: () => `out-${(n += 1).toString(16).padStart(12, "0")}` };
  const delivering = createDeliveringTools({ paseo: () => paseo, home: () => home, log, now, queue, outbox, binder: () => binder, stopReviewers: async () => {} });
  const reviews = createReviewTools({ binder: () => binder, paseo: () => paseo, home: () => home, log, now, queue, outbox });
  const peers = createPeerTools({ binder: () => binder, paseo: () => paseo, home: () => home, log, now, queue, outbox, openManager: async () => {
    throw new Error("every project of the scenario has its Manager");
  } });
  const worker = joinServerTools(joinServerTools(delivering.worker, reviews), peers.worker);
  const manager = joinServerTools(delivering.manager, peers.manager);
  const reviewer = delivering.reviewer;
  const questions = createQuestionDecisionDelivery({ home: () => home, now, log, queue });
  const compactions = createCompactionRunner({ queue, home: () => home, now, log, redactEnv: {} });
  const handoffs = createHandoffRunner({
    queue,
    home: () => home,
    now,
    log,
    redactEnv: {},
    git: async () => ({ stdout: "" }),
    budgetMs: 50,
    binder: () => binder,
    // The Paseo CLI's part: the outgoing Worker is labelled replaced.
    setLabels: async (agentId, labels) => {
      const agent = daemon.byId(agentId);
      if (agent !== undefined) agent.labels = { ...agent.labels, ...labels };
      return { ok: true };
    },
  });
  const stall = createStallWatcher({
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    now,
    log,
    redactEnv: {},
    bus: { publish: async () => ({}) as never },
    signalQueue: queue as never,
    onWaitsSettled: async (settled, handle) => {
      count("stall.settled", settled.length);
      trace(`step ${step}: the stall pass settled ${settled.map((wait) => `${wait.requestId} ${wait.met ? "met" : "not met"} ${JSON.stringify(wait.waiting.items.map((item) => [item.id, item.settled, item.fact ?? ""]))}`).join("; ")}`);
      await releaseSettledWaits(home, settled, { paseo: handle as never, queue, log, now });
    },
  });
  stall.usePaseo(paseo);

  // The collector's hooks, with the recorded-turn chain the plugin hangs on them.
  let recorded: TraceRecord | null = null;
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  const removeCollector = registerCollector(
    {
      on: ((name: string, handler: (event: unknown, context: unknown) => unknown) => {
        hooks.set(name, handler);
        return () => {};
      }) as never,
    },
    {
      now,
      env: {},
      log,
      onRecorded: async (event, { paseo: handle, record }) => {
        recorded = record;
        await questions.afterTurn(record, { paseo: handle });
        await compactions.turnRecorded(event, record, handle);
        await handoffs.turnRecorded(event, record, handle);
        await rolloverTurnRecorded(home, record, handle, { queue, now, log });
      },
    },
  );

  // The first requests: registered and bound as bm_create_worker leaves them.
  const registry = createRequestRegistry(home, { backfill: () => [] });
  for (const lane of lanes) {
    bindAgent(store, lane.managerId, { role: "manager", workspaceId: lane.workspaceId });
    registry.register(lane.workspaceId, lane.rootId, { source: "tool", managerId: lane.managerId, workerId: lane.workerId });
    bindAgent(store, lane.workerId, { role: "worker", workspaceId: lane.workspaceId, requestId: lane.rootId, parentId: lane.managerId });
    requestOf(lane.workspaceId, lane.rootId);
  }

  /** Every agent Paseo holds that the script does not know yet: a continuation's Worker, a successor, a Reviewer. */
  const adopt = (): void => {
    for (const agent of daemon.agents) {
      if (sim.has(agent.id)) continue;
      const labels = agent.labels ?? {};
      const role = labels["bm.role"] as SimAgent["role"] | undefined;
      if (role !== "manager" && role !== "worker" && role !== "reviewer") continue;
      const workspaceId = String(agent.workspaceId);
      const requestId = labels["bm.requestId"] ?? null;
      sim.set(agent.id, {
        id: agent.id,
        role,
        lane: laneOfWorkspace(workspaceId),
        workspaceId,
        requestId,
        batchId: labels["bm.batchId"] ?? null,
        parentId: labels["paseo.parent-agent-id"] ?? null,
        inbox: typeof agent["prompt"] === "string" ? [agent["prompt"]] : [],
        turnEnds: 0,
        retired: false,
        received: false,
        continues: false,
        finishNow: false,
        softLeft: null,
        nudged: false,
        handedOff: false,
        blocking: null,
      });
      if (role === "worker" && requestId !== null) {
        requestOf(workspaceId, requestId);
        count(labels["bm.handoffFrom"] === undefined ? "workers.created" : "handoff.successors");
      }
      if (role === "reviewer") count("reviewers.created");
    }
  };
  adopt();

  const callerOf = (agentId: string): ToolCaller | null => {
    const binding = liveBindingOf(store.list(), agentId);
    if (binding === null) return null;
    return { agentId, role: binding.role, workspaceId: binding.workspaceId, requestId: binding.requestId, parentId: binding.parentId, batchId: binding.batchId };
  };

  const registered = (workspaceId: string, requestId: string): RegisteredRequest | null => createRequestRegistry(home).get(workspaceId, requestId);
  const awaitingVerdict = (workspaceId: string, requestId: string): string[] =>
    batchesAwaitingVerdict(registered(workspaceId, requestId), createOutbox(home).list(workspaceId), now());
  const waitingUnmet = (workspaceId: string, requestId: string): boolean => {
    const waiting = registered(workspaceId, requestId)?.waiting ?? null;
    return waiting !== null && waiting.items.length > 0 && !waitMet(waiting);
  };
  /** The head of a lane's chain: the request its Worker works on now. */
  const headOf = (lane: (typeof lanes)[number]): RegisteredRequest | null => chainHeadOf(home, lane.rootId, lane.workspaceId)?.request ?? null;

  // -------------------------------------------------------------------------
  // A turn: started, acted, ended through the queue and the collector.
  // -------------------------------------------------------------------------

  let turns = 0;
  const timelines = new Map<string, unknown[]>();
  const startedAt = new Map<string, string>();

  async function endTurn(agent: SimAgent, turnId: string, texts: readonly string[], tokens: { read: number; compacted: boolean }): Promise<TraceRecord | null> {
    lasts();
    const at = now().toISOString();
    const begun = startedAt.get(agent.id) ?? at;
    const entries = [
      ...texts.map((text) => ({ item: { type: "user_message", text }, turnId, timestamp: begun })),
      ...(tokens.compacted ? [{ item: { type: "compaction", status: "completed", trigger: "manual" }, turnId, timestamp: at }] : []),
      { item: { type: "assistant_message", text: "Done for now." }, turnId, timestamp: at },
    ];
    const timeline = [...(timelines.get(agent.id) ?? []).slice(-12), ...entries];
    timelines.set(agent.id, timeline);
    daemon.setTimeline(agent.id, timeline);
    const live = daemon.byId(agent.id);
    if (live !== undefined) {
      live.status = "idle";
      live["lastUsage"] = { inputTokens: Math.round(tokens.read * 0.02), cachedInputTokens: Math.round(tokens.read * 0.98), outputTokens: 20_000 };
    }
    const event = {
      agent: { id: agent.id, workspaceId: agent.workspaceId, parentAgentId: agent.parentId, provider: live?.provider ?? "", cwd: live?.["cwd"] ?? null, title: null },
      turnId,
      outcome: { kind: "completed" },
      timeline: entries.map((entry) => entry.item),
    };
    // The plugin's order: the queue rides on the format check's turn end, registered before the collector.
    await queue.turnEnded(event, paseo);
    recorded = null;
    await hooks.get("agent.turn_ended")!(event, { paseo });
    const record = recorded as TraceRecord | null;
    // Rollover counts every recorded turn's tokens of the request, a Reviewer's and a relaying Manager's too (design §2.6).
    if (record !== null && record.requestId !== null && record.usage !== null) {
      // Tokens read as each provider counts them (Codex: its input holds its cached tokens).
      const read = turnTokensOf(record).tokensRead ?? 0;
      const request = requestOf(record.workspaceId, record.requestId);
      request.tokens += read;
      const logged = tokenLog.get(request.key) ?? [];
      logged.push({ at: now().getTime(), read });
      tokenLog.set(request.key, logged);
    }
    if (agent.role === "reviewer") await checkNoVerdict(event as never, { home, paseo, bindings: store, classified: false, now, log, queue, outbox });
    await flush();
    agent.turnEnds += 1;
    adopt();
    return record;
  }

  /** A turn takes time: the plugin compares its start with what it sent meanwhile (the handoff note, a compaction). */
  const lasts = (): void => tick(between(20, 90) * 1_000);

  const startTurn = async (agent: SimAgent): Promise<{ turnId: string; texts: string[] }> => {
    turns += 1;
    const turnId = `turn-${turns}`;
    trace(`step ${step}: turn of ${agent.id} (${agent.role} ${agent.requestId ?? ""}) with ${agent.inbox.length} sends`);
    const live = daemon.byId(agent.id);
    if (live !== undefined) live.status = "running";
    await hooks.get("agent.turn_started")!({ agent: { id: agent.id, provider: live?.provider ?? "" }, turnId }, { paseo });
    startedAt.set(agent.id, now().toISOString());
    return { turnId, texts: agent.inbox.splice(0) };
  };

  const report = async (agent: SimAgent, input: Record<string, unknown>): Promise<{ ok: boolean; text: string }> => {
    const answer = await worker.call("bm_report", { requestId: agent.requestId, tier: { level: "Medium" }, buildAndTests: "`npm test` pass", ...input }, callerOf(agent.id));
    count(answer.ok ? `report.${String(input["phase"])}` : "report.refused");
    trace(`step ${step}: ${agent.id} bm_report ${JSON.stringify(input)} -> ${answer.ok ? "ok" : answer.text}`);
    if (!answer.ok) log(`[scenario] ${agent.id} report ${String(input["phase"])} refused: ${answer.text}`);
    await flush();
    return answer;
  };

  /** The script's view of a blocked report: invariant (3) watches the request from now. */
  const watchWait = (agent: SimAgent): void => {
    const waiting = registered(agent.workspaceId, agent.requestId!)?.waiting ?? null;
    const key = keyOf(agent.workspaceId, agent.requestId!);
    // None, or none on items, or met already and released with the report (an awaited request that had ended).
    if (waiting === null || waiting.items.length === 0) return;
    const queuedBefore = new Set(queue.pending(agent.id).map((notice) => notice.text));
    waits.set(key, { requestKey: key, workerId: agent.id, workspaceId: agent.workspaceId, requestId: agent.requestId!, since: step, releases: 0, queuedBefore, releasedTo: null });
    count("waits.set");
  };

  let beadCounter = 0;
  const newBead = (agent: SimAgent): string => `bd-${lanes[agent.lane]!.name}${(beadCounter += 1)}`;

  /** A Worker's accepted report closed `beads`: the request's own figures (invariant 2). */
  const closed = (agent: SimAgent, beads: readonly string[]): void => {
    const request = requestOf(agent.workspaceId, agent.requestId!);
    for (const bead of beads) request.beads.add(bead);
  };

  async function finish(agent: SimAgent, size: boolean): Promise<boolean> {
    const links = createPeerLinkStore(home).list();
    const carried = links.filter((link) => link.to.workspaceId === agent.workspaceId && link.to.requestId === agent.requestId && (link.state === "taken" || link.state === "answered"));
    const beads = chance(0.5) ? [newBead(agent)] : [];
    const answer = await report(agent, {
      phase: "finished",
      beadsClosed: beads,
      ...(size ? { remaining: [`${newBead(agent)}: the rest of this part`] } : {}),
      ...(carried.length > 0 ? { forPeer: "The contract is in docs/api.md." } : {}),
    });
    if (answer.ok) {
      closed(agent, beads);
      requestOf(agent.workspaceId, agent.requestId!).ended = true;
      waits.delete(keyOf(agent.workspaceId, agent.requestId!));
      agent.retired = true;
      count(size ? "finish.size" : "finish.natural");
      return true;
    }
    // A review of the request has no verdict yet: wait for it (design §2.6: a batch never crosses requests).
    const owed = awaitingVerdict(agent.workspaceId, agent.requestId!);
    if (owed.length > 0) {
      const blocked = await report(agent, { phase: "blocked", waitingOnBatches: owed, blockers: "a review is still running" });
      if (blocked.ok) watchWait(agent);
    }
    return false;
  }

  async function workerTurn(agent: SimAgent): Promise<void> {
    const { turnId, texts } = await startTurn(agent);
    const requestId = agent.requestId!;
    const request = requestOf(agent.workspaceId, requestId);
    // Heavier turns now and then cross the compaction figure; a few cross its ceiling.
    const heavy = chance(0.07);
    const read = heavy ? between(3_100_000, 7_500_000) : between(400_000, 2_400_000);
    const compacting = texts.some((text) => firstLine(text).startsWith("/compact"));
    const maintenanceOnly = texts.length > 0 && texts.every(isMaintenance);
    // A verdict still to come holds `finished` back by design (§2.6); one its Reviewer gave already does not.
    const owedAtStart = awaitingVerdict(agent.workspaceId, requestId);
    const given = owedAtStart.filter((batchId) => {
      const batch = registered(agent.workspaceId, requestId)?.reviews.batches.find((entry) => entry.batchId === batchId);
      const newest = batch?.calls.at(-1)?.at;
      return newest !== undefined && (batch?.results ?? []).some((result) => result.at >= newest);
    });
    // A turn of a request at its hard figures that is not maintenance and finds no verdict in flight does the request's work.
    const counted = request.hardAt !== null && !request.ended && !agent.retired && !agent.handedOff && !maintenanceOnly && owedAtStart.length === given.length;

    if (texts.some((text) => text.includes("BM-ROLLOVER now"))) {
      agent.finishNow = true;
      count("rollover.now");
    }
    if (texts.some((text) => text.includes("BM-ROLLOVER soft"))) {
      // Some Workers go on regardless, until BM-ROLLOVER now.
      agent.softLeft = chance(0.6) ? null : between(0, 2);
      count("rollover.soft");
    }
    const nudged = agent.nudged;
    agent.nudged = false;
    if (nudged) agent.handedOff = false;
    // A maintenance wake leaves the Worker where it was: its work goes on after it.
    const wasGoingOn = agent.continues;
    agent.continues = false;
    // Any report ends the script's watch of the old wait: the Worker acts now.
    const act = async (): Promise<void> => {
      if (agent.retired) return;
      if (texts.some((text) => firstLine(text).startsWith("BM-REPLACED"))) {
        agent.retired = true;
        count("handoff.replaced");
        return;
      }
      const entry = registered(agent.workspaceId, requestId);
      if (entry === null || entry.finishedAt !== null) {
        agent.retired = true;
        return;
      }
      if (agent.handedOff) return;
      // A compaction and its brief ask for no work.
      if (compacting || (texts.length > 0 && texts.every((text) => /^(\/compact|BM-STATE)/.test(firstLine(text))))) {
        if (compacting) count("compaction.turns");
        agent.continues = wasGoingOn;
        return;
      }
      if (texts.some((text) => firstLine(text).startsWith("BM-HANDOFF"))) {
        const noted = await report(agent, { phase: "beads-done", handoffNote: "Tried the parser split; next is the CSV writer." });
        if (noted.ok) waits.delete(keyOf(agent.workspaceId, requestId));
        agent.handedOff = true;
        count("handoff.notes");
        return;
      }
      if (waitingUnmet(agent.workspaceId, requestId) && !agent.finishNow && !nudged) return;
      waits.delete(keyOf(agent.workspaceId, requestId));
      if (!agent.received) {
        agent.received = (await report(agent, { phase: "received" })).ok;
        agent.continues = true;
        return;
      }
      if (agent.finishNow) {
        await finish(agent, true);
        return;
      }
      if (agent.softLeft !== null) {
        if (agent.softLeft <= 0) {
          if (!(await finish(agent, true))) agent.continues = false;
          return;
        }
        agent.softLeft -= 1;
      }
      await normalWork(agent);
    };
    await act();
    const record = await endTurn(agent, turnId, texts, { read, compacted: compacting });
    if (record !== null && record.role === "worker") {
      // The request's own figures, as rollover counts them (design §2.6), judged as the plugin judges them:
      // at a turn end of the request's newest Worker (a replaced Worker's turns count, but are not checked).
      request.turns += 1;
      const newest = registered(agent.workspaceId, requestId)?.workerIds.at(-1) === agent.id;
      if (request.hardAt === null && newest && (request.beads.size >= HARD.beads || request.turns >= HARD.turns || request.tokens >= HARD.tokens)) request.hardAt = request.turns;
      else if (counted) {
        request.workAfterHard += 1;
        if (given.length > 0) request.verdictElsewhere += 1;
      }
    }
    checkCeilings(agent, read);
  }

  async function normalWork(agent: SimAgent): Promise<void> {
    const requestId = agent.requestId!;
    const roll = random();
    const owed = awaitingVerdict(agent.workspaceId, requestId);
    const batches = registered(agent.workspaceId, requestId)?.reviews.batches ?? [];
    const higher = lanes.filter((other) => other.lane > agent.lane);
    agent.continues = true;
    if (roll < 0.3) {
      const beads = Array.from({ length: between(1, 2) }, () => newBead(agent));
      if ((await report(agent, { phase: "beads-done", beadsClosed: beads })).ok) closed(agent, beads);
      return;
    }
    if (roll < 0.38 && owed.length === 0) {
      const batchId = `b${batches.length + 1}`;
      const created = await worker.call("bm_create_reviewer", { batchId, stages: ["implementation"], milestone: "wave", scope: "src/ since the last wave.", checks: "`npm test` pass" }, callerOf(agent.id));
      count(created.ok ? "review.created" : "review.refused");
      await flush();
      adopt();
      if (created.ok && chance(0.5)) {
        const blocked = await report(agent, { phase: "blocked", waitingOnBatches: [batchId], blockers: "the wave's review" });
        if (blocked.ok) {
          watchWait(agent);
          agent.continues = false;
        }
      }
      return;
    }
    if (roll < 0.44) {
      const changed = batches.filter((batch) => (batch.results ?? []).at(-1)?.verdict === "changes-required" && !owed.includes(batch.batchId));
      if (changed.length > 0) {
        const batch = pick(changed);
        const asked = await worker.call("bm_rereview", { batchId: batch.batchId, fixed: "Each blocking finding is fixed." }, callerOf(agent.id));
        count(asked.ok ? "review.rereview" : "review.rereviewRefused");
        await flush();
        if (asked.ok && chance(0.5)) {
          const blocked = await report(agent, { phase: "blocked", waitingOnBatches: [batch.batchId], blockers: "the re-review" });
          if (blocked.ok) {
            watchWait(agent);
            agent.continues = false;
          }
        }
        return;
      }
    }
    if (roll < 0.51) {
      const asked = between(1, 3);
      const answer = await worker.call(
        "bm_questions",
        {
          questions: Array.from({ length: asked }, (_, index) => ({
            text: `Which format for part ${index + 1}?`,
            subject: `format-part-${(beadCounter += 1)}`,
            class: "data",
            options: [
              { key: "a", text: "ISO 8601", effects: ["none"], recommended: true },
              { key: "b", text: "Unix seconds", effects: ["none"] },
            ],
          })),
        },
        callerOf(agent.id),
      );
      await flush();
      if (!answer.ok) {
        count("questions.refused");
        return;
      }
      const ids = (JSON.parse(answer.text) as Array<{ decisionId: string; state: string }>).filter((entry) => entry.state === "open").map((entry) => entry.decisionId);
      count("questions.asked", ids.length);
      if (ids.length === 0) return;
      const blocked = await report(agent, { phase: "blocked", waitingOn: ids, ...(chance(0.3) ? { wakeOn: "any" } : {}) });
      if (blocked.ok) {
        watchWait(agent);
        agent.continues = false;
      }
      return;
    }
    if (roll < 0.55 && higher.length > 0) {
      // Waits go to higher projects only, so no two requests ever wait on each other.
      const target = headOf(pick(higher));
      if (target !== null && target.finishedAt === null) {
        const blocked = await report(agent, { phase: "blocked", waitingOnRequests: [target.requestId], ...(chance(0.3) ? { waitingFor: "its API" } : {}) });
        if (blocked.ok) {
          watchWait(agent);
          agent.continues = false;
          count("waits.onRequest");
        }
        return;
      }
    }
    if (roll < 0.6 && higher.length > 0) {
      const target = pick(higher);
      const asked = await worker.call("bm_ask_project", { project: target.workspaceId, request: "Which date format does your export use?", kind: "question" }, callerOf(agent.id));
      count(asked.ok ? "peer.asked" : "peer.refused");
      await flush();
      if (asked.ok && chance(0.5)) {
        const linkId = (JSON.parse(asked.text) as { linkId: string }).linkId;
        const blocked = await report(agent, { phase: "blocked", waitingOnPeers: [linkId] });
        if (blocked.ok) {
          watchWait(agent);
          agent.continues = false;
        }
      }
      return;
    }
    if (roll < 0.66) {
      const taken = createPeerLinkStore(home)
        .list()
        .filter((link) => link.to.workspaceId === agent.workspaceId && link.to.requestId === requestId && link.state === "taken");
      if (taken.length > 0) {
        const replied = await worker.call("bm_peer_reply", { linkId: pick(taken).linkId, text: "ISO 8601, in UTC." }, callerOf(agent.id));
        count(replied.ok ? "peer.replied" : "peer.replyRefused");
        await flush();
        return;
      }
    }
    if (roll < 0.67 && requestOf(agent.workspaceId, requestId).beads.size >= 3 && owed.length === 0) {
      await finish(agent, false);
      return;
    }
    // Else a turn of work with nothing to report.
  }

  async function reviewerTurn(agent: SimAgent): Promise<void> {
    const { turnId, texts } = await startTurn(agent);
    if (texts.length > 0) {
      if (chance(0.05)) {
        // The turn ends without bm_review: the plugin's no-verdict settles the call (design §16.10).
        count("review.noVerdict");
        trace(`step ${step}: ${agent.id} ends its turn without bm_review`);
      } else {
        const results = registered(agent.workspaceId, agent.requestId!)?.reviews.batches.find((batch) => batch.batchId === agent.batchId)?.results ?? [];
        const first = results.length === 0;
        const blocking = first ? between(0, 2) : Math.max(0, (agent.blocking ?? 1) - between(1, 2));
        agent.blocking = blocking;
        const answer = await reviewer.call(
          "bm_review",
          {
            requestId: agent.requestId,
            batchId: agent.batchId,
            reviewKind: first ? "first" : "re-review",
            checked: "src/ and its tests; npm test pass",
            notChecked: "none",
            findings: Array.from({ length: blocking }, (_, index) => ({ severity: "blocking", location: `src/a.ts:${index + 3}`, reason: "Off by one.", suggestedFix: "Use <=." })),
          },
          callerOf(agent.id),
        );
        count(answer.ok ? "review.verdicts" : "review.verdictRefused");
        trace(`step ${step}: ${agent.id} bm_review ${agent.batchId} blocking ${blocking} -> ${answer.ok ? answer.text : `refused: ${answer.text}`}`);
        await flush();
      }
    }
    await endTurn(agent, turnId, texts, { read: 300_000, compacted: false });
  }

  async function managerTurn(agent: SimAgent): Promise<void> {
    const { turnId, texts } = await startTurn(agent);
    const lane = lanes[agent.lane]!;
    const caller: ToolCaller = { agentId: agent.id, role: "manager", workspaceId: agent.workspaceId, requestId: null, parentId: null, batchId: null };
    const head = headOf(lane);
    // A peer ask to this project: the request at work takes it.
    const ask = createPeerLinkStore(home)
      .list()
      .find((link) => link.to.workspaceId === agent.workspaceId && link.state === "open" && link.to.managerId === agent.id);
    if (ask !== undefined && head !== null && head.finishedAt === null) {
      const told = await manager.call("bm_tell_worker", { requestId: head.requestId, text: "Answer this project's ask.", peerLink: ask.linkId, about: "current" }, caller);
      count(told.ok ? "peer.taken" : "peer.takeRefused");
      await flush();
      adopt();
    } else if (head !== null && head.finishedAt !== null) {
      // The owner wants more of a finished request: its continuation (design §2.4).
      const told = await manager.call("bm_tell_worker", { requestId: head.requestId, text: "Also export the totals as CSV.", source: "owner message", about: "current" }, caller);
      count(told.ok ? "continuation.followUp" : "continuation.refused");
      if (!told.ok) log(`[scenario] follow-up of ${head.requestId} refused: ${told.text}`);
      await flush();
      adopt();
    } else if (head !== null && chance(0.15)) {
      const told = await manager.call("bm_tell_worker", { requestId: head.requestId, text: "The owner adds: keep the old column names.", about: "current" }, caller);
      if (told.ok) count((JSON.parse(told.text) as { delivery: string }).delivery === "held" ? "tell.held" : "tell.sent");
      await flush();
      adopt();
    }
    await endTurn(agent, turnId, texts, { read: 120_000, compacted: false });
  }

  // -------------------------------------------------------------------------
  // The owner, the stall pass, and the invariants watched each step.
  // -------------------------------------------------------------------------

  async function ownerAnswers(): Promise<boolean> {
    const decisions = createDecisionStore(home);
    const open = decisions.list({ statuses: ["open"] }).filter((decision) => decision.requestId !== null && decision.id.startsWith("q:") && /:Q\d+$/.test(decision.id) && decision.subject?.startsWith("format-part-"));
    if (open.length === 0) return false;
    const chosen = pick(open);
    const result = decisions.transition(chosen.id, (current) => answerDecision(current, { via: "inbox", optionKey: "a", words: null, at: now().toISOString() }), chosen.workspaceId);
    if (result.status !== "updated") return false;
    count("questions.answered");
    await questions.onSettled([decisions.get(chosen.id, chosen.workspaceId)!], { paseo });
    await flush();
    return true;
  }

  async function stallPass(): Promise<void> {
    await stall.pass();
    count("stall.passes");
    await flush();
  }

  /** Invariant (4): a pending compaction or handoff of `agent` that was at its ceiling at an earlier turn end still waits. */
  function checkCeilings(agent: SimAgent, read: number): void {
    const at = now().getTime();
    const compactCeiling = SCENARIO_SETTINGS["compact.workerTokensPerTurn"] * SCENARIO_SETTINGS["maintenance.ceilingFactor"];
    for (const entry of createCompactionStore(home).list()) {
      if (entry.agentId !== agent.id || entry.state !== "waiting") continue;
      const watch = ceilings.get(entry.id) ?? { agentId: agent.id, firstAt: null, queuedAtCeiling: false };
      ceilings.set(entry.id, watch);
      const atCeiling = read >= compactCeiling || at - Date.parse(entry.requestedAt) >= MAINTENANCE_WAIT_MS.compact;
      if (watch.firstAt === null) {
        if (atCeiling) {
          watch.firstAt = agent.turnEnds;
          watch.queuedAtCeiling = queue.pending(agent.id).some((notice) => notice.kind === `BM-COMPACT:${entry.id}`);
        }
      } else if (agent.turnEnds >= watch.firstAt + 1) {
        const line = `${where()}: compaction ${entry.id} of ${agent.id} reached its ceiling at turn end ${watch.firstAt} and still waits at turn end ${agent.turnEnds}`;
        if (watch.queuedAtCeiling) violations.staleAtCeiling.push(`${line}; at its ceiling it was queued behind another notice`);
        else violations.maintenance.push(line);
        watch.firstAt = Number.POSITIVE_INFINITY;
      }
    }
    if (agent.role !== "worker" || agent.requestId === null) return;
    const handoffStore = createHandoffStore(home);
    const entries = handoffStore.list();
    const handoffCeiling = SCENARIO_SETTINGS["handoff.requestTokens"] * SCENARIO_SETTINGS["maintenance.ceilingFactor"];
    for (const entry of entries) {
      if (entry.workerId !== agent.id || entry.state !== "waiting") continue;
      const watch = ceilings.get(entry.id) ?? { agentId: agent.id, firstAt: null, queuedAtCeiling: false };
      ceilings.set(entry.id, watch);
      const since = lastHandoffAtOf(entries, entry.requestId);
      const tokens = tokensSince(entry.workspaceId, entry.requestId, since);
      const atCeiling = tokens >= handoffCeiling || at - Date.parse(entry.requestedAt) >= MAINTENANCE_WAIT_MS.handoff;
      if (watch.firstAt === null) {
        if (atCeiling) {
          watch.firstAt = agent.turnEnds;
          watch.queuedAtCeiling = queue.pending(agent.id).some((notice) => notice.kind === `BM-HANDOFF:${entry.id}`);
        }
      } else if (agent.turnEnds >= watch.firstAt + 1) {
        const line = `${where()}: handoff ${entry.id} of ${entry.requestId} reached its ceiling at turn end ${watch.firstAt} of ${agent.id} and still waits at turn end ${agent.turnEnds}`;
        if (watch.queuedAtCeiling) violations.staleAtCeiling.push(`${line}; at its ceiling it was queued behind another notice`);
        else violations.maintenance.push(line);
        watch.firstAt = Number.POSITIVE_INFINITY;
      }
    }
  }

  /** A request's tokens read since a time, from the turns the script recorded. */
  const tokenLog = new Map<string, Array<{ at: number; read: number }>>();
  function tokensSince(workspaceId: string, requestId: string, since: number | null): number {
    return (tokenLog.get(keyOf(workspaceId, requestId)) ?? []).filter((entry) => since === null || entry.at > since).reduce((sum, entry) => sum + entry.read, 0);
  }

  /** Invariant (3), the other half: a met wait whose Worker sits idle with nothing queued was never woken. */
  function checkWoken(): void {
    for (const [key, watch] of waits) {
      if (watch.releases > 0) continue;
      const entry = registered(watch.workspaceId, watch.requestId);
      if (entry === null || entry.finishedAt !== null) continue;
      const waiting = entry.waiting ?? null;
      if (waiting !== null && !waitMet(waiting)) continue;
      const agent = daemon.byId(watch.workerId);
      if (agent === undefined || agent.status !== "idle" || queue.pending(agent.id).length > 0 || sim.get(agent.id)?.retired === true) continue;
      const line = `${where()}: the wait of ${watch.requestId} is ${waiting === null ? "cleared" : "met"} but Worker ${agent.id} was never woken`;
      if (watch.releasedTo !== null) violations.verdictToReplaced.push(`${line}: its release went to Worker ${watch.releasedTo}`);
      else violations.waits.push(line);
      waits.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // The loop.
  // -------------------------------------------------------------------------

  let workerTurnsDone = 0;
  let idleSteps = 0;
  const STEP_LIMIT = workerTurns * 6;
  while (workerTurnsDone < workerTurns && step < STEP_LIMIT) {
    step += 1;
    tick(between(2, 8) * 1_000);
    if (chance(0.3)) await ownerAnswers();
    if (step % 25 === 0) await stallPass();
    checkWoken();

    const runnable = [...sim.values()].filter((agent) => {
      const live = daemon.byId(agent.id);
      if (live === undefined || typeof live.archivedAt === "string") return false;
      // A send starts a turn, a retired agent's too: it ends it at once.
      if (live.status === "running") return true;
      if (agent.retired) return false;
      // The owner's nudge: a Worker whose turn ended mid-work goes on.
      return agent.role === "worker" && agent.continues && agent.inbox.length === 0;
    });
    if (runnable.length === 0) {
      idleSteps += 1;
      count("steps.idle");
      trace(
        `step ${step}: nothing runs; ${[...sim.values()]
          .filter((agent) => agent.role === "worker" && !agent.retired)
          .map((agent) => `${agent.id} ${daemon.byId(agent.id)?.status} ${agent.requestId} waits ${JSON.stringify(registered(agent.workspaceId, agent.requestId!)?.waiting?.items.map((item) => [item.id, item.settled]) ?? null)}`)
          .join("; ")}`,
      );
      if (!(await ownerAnswers())) {
        tick(10 * 60_000);
        await stallPass();
      }
      // Nothing moves for long: the owner writes in a Worker's chat to go on (Paseo delivers it; the plugin sees no send).
      if (idleSteps % 4 === 0) {
        const idle = [...sim.values()].filter((agent) => agent.role === "worker" && !agent.retired && daemon.byId(agent.id)?.status === "idle");
        if (idle.length > 0) {
          const nudged = pick(idle);
          nudged.nudged = true;
          daemon.byId(nudged.id)!.status = "running";
          count("owner.nudges");
        }
      }
      if (idleSteps > 200) {
        log(`[scenario] seed ${seed}: nothing could run for 200 steps; stopping at step ${step}`);
        count("stuck");
        break;
      }
      continue;
    }
    idleSteps = 0;
    const workers = runnable.filter((agent) => agent.role === "worker");
    const others = runnable.filter((agent) => agent.role !== "worker");
    const agent = others.length > 0 && (workers.length === 0 || chance(0.45)) ? pick(others) : pick(workers);
    if (agent.role === "worker") {
      await workerTurn(agent);
      workerTurnsDone += 1;
    } else if (agent.role === "reviewer") await reviewerTurn(agent);
    else await managerTurn(agent);
    count(`turns.${agent.role}`);
    checkWoken();
  }
  await flush();

  // -------------------------------------------------------------------------
  // After the run: invariants (1) and (2) over every request and chain.
  // -------------------------------------------------------------------------

  for (const request of requests.values()) {
    if (request.hardAt !== null && request.workAfterHard > HARD_SLACK_TURNS) {
      const line = `seed ${seed}: request ${request.requestId} reached a hard figure at its turn ${request.hardAt} (beads ${request.beads.size}, turns ${request.turns}, tokens ${Math.round(request.tokens / 1_000_000)}M at the end) and did the request's work in ${request.workAfterHard} more turns`;
      if (request.workAfterHard - request.verdictElsewhere <= HARD_SLACK_TURNS) violations.verdictToReplaced.push(`${line}, ${request.verdictElsewhere} of them refused finished for a verdict given to another Worker`);
      else violations.bounded.push(line);
    }
    if (request.hardAt !== null) count("rollover.hardReached");
  }

  const registryNow = createRequestRegistry(home);
  for (const lane of lanes) {
    const records = readRecords({ tracesDir: join(home, "traces") }, lane.workspaceId).records;
    const members = registryNow.list(lane.workspaceId).filter((entry) => entry.source === "tool");
    const roots = members.filter((entry) => entry.continuationOf === undefined);
    count("chains", roots.length);
    count("requests", members.length);
    const seen = new Set<string>();
    for (const rootEntry of roots) {
      const chain: string[] = [];
      for (let id: string | undefined = rootEntry.requestId; id !== undefined; id = registryNow.get(lane.workspaceId, id)?.continuedBy) {
        if (chain.includes(id)) break;
        chain.push(id);
        seen.add(id);
      }
      const truth = new Set(chain.flatMap((id) => [...(requests.get(keyOf(lane.workspaceId, id))?.beads ?? [])]));
      const recorded = new Set(
        records.flatMap((record) => (record.role === "worker" && record.requestId !== null && chain.includes(record.requestId) ? record.reports.filter((entry) => entry.requestId === null || chain.includes(entry.requestId)).flatMap((entry) => entry.beadsClosed) : [])),
      );
      const missing = [...truth].filter((bead) => !recorded.has(bead));
      const extra = [...recorded].filter((bead) => !truth.has(bead));
      if (missing.length > 0 || extra.length > 0) {
        violations.beads.push(`seed ${seed}: chain ${chain.join(" → ")} records ${recorded.size} closed beads, the Workers closed ${truth.size} (missing ${missing.slice(0, 5).join(", ") || "none"}; extra ${extra.slice(0, 5).join(", ") || "none"})`);
      }
      for (const id of chain) {
        const own = requests.get(keyOf(lane.workspaceId, id));
        const figures = rolloverFiguresOf(records, id);
        if (figures.beads !== (own?.beads.size ?? 0)) violations.beads.push(`seed ${seed}: request ${id} counts ${figures.beads} closed beads for its rollover, its Worker closed ${own?.beads.size ?? 0}`);
        // The script's figures are the rollover's own, or invariant (1) would measure something else.
        if (own !== undefined && (figures.turns !== own.turns || Math.abs(figures.tokens - own.tokens) > 1_000)) {
          violations.bounded.push(`seed ${seed}: request ${id} has ${figures.turns} turns and ${figures.tokens} tokens for its rollover; the script counted ${own.turns} and ${own.tokens}`);
        }
      }
      if (chain.length > 1) count("chains.continued");
      count("chains.members", chain.length);
    }
    for (const request of requests.values()) {
      if (request.workspaceId === lane.workspaceId && !seen.has(request.requestId)) violations.beads.push(`seed ${seed}: request ${request.requestId} belongs to no chain of the registry`);
    }
  }
  count("beads.closed", [...requests.values()].reduce((sum, request) => sum + request.beads.size, 0));
  count("compactions", createCompactionStore(home).list().length);
  count("compactions.sent", createCompactionStore(home).list().filter((entry) => entry.sentAt !== null).length);
  count("handoffs", createHandoffStore(home).list().length);
  count("handoffs.done", createHandoffStore(home).list().filter((entry) => entry.state === "done").length);
  count("workerTurns", workerTurnsDone);

  removeCollector();
  return { seed, workerTurns: workerTurnsDone, steps: step, violations, counts };
}

// ---------------------------------------------------------------------------
// The suite: the default project's short run and the bench project's long one.
// ---------------------------------------------------------------------------

/** What every run of a suite must have exercised, summed over its seeds. */
const EXERCISED = [
  "report.finished",
  "finish.size",
  "continuation.followUp",
  "rollover.soft",
  "rollover.now",
  "rollover.hardReached",
  "compactions.sent",
  "handoffs.done",
  "questions.answered",
  "waits.releases",
  "waits.onRequest",
  "tell.held",
  "review.verdicts",
  "review.rereview",
  "peer.replied",
  "stall.passes",
  "chains.continued",
] as const;

/**
 * The scenario's tests: each seed is run once, in `beforeAll`, then each
 * invariant is checked over every seed. The calling file mocks `fsyncSync`
 * away (`vi.mock` is the file's own).
 */
export function scenarioSuite(options: { seeds: readonly number[]; workerTurns: number; timeoutMs: number }): void {
  const results: ScenarioResult[] = [];
  const all = (key: keyof ScenarioViolations): string[] => results.flatMap((result) => result.violations[key]);

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const seed of options.seeds) {
        results.push(await runScenario({ seed, workerTurns: options.workerTurns }));
        vi.unstubAllEnvs();
        removeDataFolders();
      }
    } finally {
      vi.useRealTimers();
    }
  }, options.timeoutMs);

  afterAll(() => {
    vi.unstubAllEnvs();
    clearScenarioCaches();
    removeDataFolders();
  });

  it("runs every seed to its Worker turns and exercises every path", () => {
    expect(results.map((result) => [result.seed, result.workerTurns])).toEqual(options.seeds.map((seed) => [seed, options.workerTurns]));
    const total = (name: string): number => results.reduce((sum, result) => sum + (result.counts[name] ?? 0), 0);
    expect(EXERCISED.filter((name) => total(name) === 0)).toEqual([]);
  });

  it("(1) no request works past the hard rollover figures, allowing one turn of slack", () => {
    expect(all("bounded")).toEqual([]);
  });

  it("(2) the chains' closed beads equal the beads closed", () => {
    expect(all("beads")).toEqual([]);
  });

  it("(3) a Worker with an unsettled wait gets no send until an item settles, then exactly one", () => {
    expect(all("waits")).toEqual([]);
  });

  it("(4) no maintenance waits past its ceiling plus one turn end", () => {
    expect(all("maintenance")).toEqual([]);
  });

  // Plugin gaps this scenario found (WP-7.9), each kept apart from its invariant's other sends and waits,
  // and fixed (delivery line design §6.4, §6.6).

  // Bug B1 (invariant 3): the wake gate looked at a delivery when it was queued, never when the notice queue
  // sent it, so a delivery queued while the Worker ran a turn in which it then reported `blocked` went out at
  // that turn's end, into the new wait. Now the gate decides again at the send (`holdsAtSend`).
  it("(3) bug B1: nothing queued for a busy Worker before its blocked report is sent into its wait", () => {
    expect(all("queuedBeforeWait")).toEqual([]);
  });

  // Bug B2 (invariants 1 and 3): after a handoff, a verdict of a batch the replaced Worker opened went to
  // that replaced Worker (the Reviewer's parent), and the successor's wait gated the replaced Worker too. Now
  // a verdict goes to the request's current Worker (`verdictTargetOf`), and only the newest Worker is gated.
  it("(1)(3) bug B2: a verdict for a batch of a replaced Worker reaches its successor", () => {
    expect(all("verdictToReplaced")).toEqual([]);
  });

  // Bug B3 (invariant 4): at the turn end where a compaction or handoff reached its ceiling, the notice queue
  // had already sent another notice, so the `first` /compact or note request was queued, then dropped at the
  // next turn end as held past its moment (`SAFE_SEND_MS`, `NOTE_SEND_MS`), and a compaction's per-turn figure
  // was no longer at its ceiling. Now an item queued at its ceiling has no such moment, and a compaction's
  // ceiling, once reached, holds until it runs (`ceilingAt`).
  it("(4) bug B3: a maintenance item queued behind another notice at its ceiling goes at the next turn end", () => {
    expect(all("staleAtCeiling")).toEqual([]);
  });
}
