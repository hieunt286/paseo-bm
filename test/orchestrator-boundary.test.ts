import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { answerOrchestrator } from "../plugin/server/agent-tools";
import type { DashboardPaseo } from "../plugin/server/paseo-directory";
import { noticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { ORCHESTRATOR_INSTRUCTIONS_HASH, ORCHESTRATOR_PROVIDER_ID } from "../plugin/server/orchestrator-agent";
import { registerOrchestratorRpcs, type OrchestratorRpcDeps } from "../plugin/server/orchestrator-rpc";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createOrchestratorTools, type OrchestratorTools } from "../plugin/server/orchestrator-tools";
import { GIT_READ_ONLY_PREFIX, runGit } from "../plugin/server/repo-tool";
import type * as PaseoCli from "../plugin/server/paseo-cli";
import { setAgentLabels, setAgentMode } from "../plugin/server/paseo-cli";
import { forgetModes } from "../plugin/server/role-mode";
import { createStallWatcher, type StallWatcher } from "../plugin/server/stall-watcher";
import { createEventBus, type EventBus } from "../plugin/server/event-bus";
import { createAlertStore } from "../plugin/server/alert-store";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import type { AgentFacts } from "../plugin/server/traces";
import { effectsWithheldBy, commandBlockOf, limitsOf, parseCommandBlock, type CommandInput } from "../plugin/shared/orchestrator-command";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { createDecisionThreadStore } from "../plugin/server/decision-thread-store";
import { handleDecisionsAnswer, settledByKind } from "../plugin/server/decision-rpc";
import { createQuestionDecisionDelivery } from "../plugin/server/decision-delivery";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import type { Decision } from "../plugin/shared/decisions";
import { parseAnswers } from "../plugin/shared/bm-questions";
import { DELIVERY_NOTICE_MARKER, HANDOFF_NOTICE_MARKER, STATE_NOTICE_MARKER } from "../plugin/shared/notices";
import { createMissionStore } from "../plugin/server/mission-store";
import { createMissionDecisionStore } from "../plugin/server/mission-decisions";
import { createCompactionRunner } from "../plugin/server/compaction";
import { createHandoffRunner } from "../plugin/server/handoff";
import { createInterventionStore } from "../plugin/server/intervention-store";
import { makeDecision } from "./helpers/decisions";
import type { TraceRecord, Usage } from "../plugin/shared/contracts";
import { MANAGER, REVIEWER, WORKER, WORKSPACE_ID, agent, at, msg, report, shell, turn } from "./fixtures/orchestrator-traces";

/**
 * The Orchestrator's action boundary, as one negative suite (ADR-014, ADR-015,
 * ADR-016; Orchestrator design §6A, §6B, §10, §12 "Negative"; PRD REQ-079 a-c,
 * e, REQ-082 c, REQ-083 → REQ-086 and O-2 → O-4).
 *
 * Every registered `orchestrator.*` RPC, every tool of the Orchestrator's
 * endpoint (through the endpoint's own JSON-RPC answer), the stall watcher and
 * the notice queue's turn end run here against a spying fake SDK that records
 * — and throws on — every forbidden call: archiving, cancelling, stopping or
 * deleting an agent, any configuration write, any creation but the
 * Orchestrator's on `orchestrator.open { confirmed: true }`, any workspace
 * opened but the Orchestrator's own home, any `send` the path is not allowed
 * (a Manager only for a mission's `bm_govern` command to its current Main
 * (missions design §9.4), for a prepared command the owner picked, and for
 * the copy of a `bm_direct_worker` stop; a Worker only for `bm_direct_worker`'s
 * stop at once, on the owner's policy, word or answered decision, while its
 * danger or its mission's governor stop step is open (missions design §9.1);
 * `bm_compact` and `bm_handoff` are retired from the model (§9.5); the Orchestrator only for
 * the event bus's `BM-EVENTS` (a project in the policy's scope; a Worker question by its own filter) and the owner's
 * `BM-ANSWER` (autonomy design §A.6, §A.8); never a Reviewer), any immediate send to a running Worker without an open danger
 * allowance, any timeline read of an agent that is not `bm-*`, and any use of
 * the Paseo CLI. No path writes role instructions: the additional instructions
 * are retired (autonomy design §B.8), and paseo-bm's data folder outside its
 * own stores — where their `role-extras.json` was — stays as it was. The
 * recorded violations fail the test even when the production code swallows
 * the throw.
 *
 * | Item | Where it is proved |
 * |---|---|
 * | REQ-079 a, O-2: a Manager gets only the prepared command of an option the owner picked, a `bm_govern` command as its mission's current Main, or the copy of a stop; a Worker, Reviewer or other agent nothing, whatever the mode; an earlier build's Autopilot authorises nothing (autonomy design §B.8) | `PATHS` (`sendsTo`), the `bm_govern` and decision paths |
 * | REQ-082 c, design §6B.1: every command the plugin delivers, sent now or queued, is a `BM-COMMAND` block from the Orchestrator and carries the limits field | `PATHS` (`limits`, checked on every path by `expectBoundary`) |
 * | REQ-084 a, ADR-016 decision 2: a direct Worker command only on the project's policy or right after the owner's own word (never after a plugin notice, nor on another project's policy), to a Worker only (never a Reviewer, Manager or other agent); every block a Worker gets is `to: worker`, and its Manager has the same block as a copy | the `bm_direct_worker` paths; `expectBoundary` checks the copy on every path |
 * | REQ-084 b: a running Worker's turn is replaced only while its danger allowance is open — not another Worker's, not an expired one | the spy's `send` (every path), the `bm_direct_worker` refusal and interrupt paths |
 * | REQ-085, design §6B.5: a gated command (body or subject) sends and records nothing, on `bm_govern` and `bm_direct_worker`; a negated mention passes, and no category is allowed any more (Allow… retired, autonomy design §B.8) | the `bm_govern` path, the `bm_direct_worker` refusal path |
 * | Autonomy design §B.8 (the F2 exemption retired): a stop naming the push un-negated is gated like any command, even to the Worker whose danger allowance is open; one whose stop word negates the push passes | the `bm_direct_worker` "stopping a Worker's open danger" path |
 * | REQ-086 a: `bm_repo` stays in the project's folder and never writes | the `bm_repo` path, "bm_repo never writes" |
 * | REQ-083 a (Phase 2, change-007 C1): the Worker watch refreshes and reads only running `bm-*` Workers, of every project for the Inbox alerts; its events and the danger allowance only for a project with a class above `owner` in the policy | "the live watch of running Workers" |
 * | REQ-079 b, REQ-115 b: the Orchestrator gets only `BM-EVENTS` (a decision opened that the policy asks it to decide or predict; for a project in the policy's scope a request finished or stalled, a Worker signal — batched) and `BM-ANSWER`; stalls and Worker signals are Inbox alerts, never messages | `PATHS` (`sendsTo`), "the event bus", "the stall pass" |
 * | Loop guard (design §6A): a 13th command for one request in 24 hours is refused and sends nothing | the `bm_direct_worker` loop-guard path |
 * | Autonomy design §B.9: a command answering no decision goes out on the owner's policy only when every class of its effects is delegated for its project (`policy:<class>`), never with a hard-owner effect, and the backstop holds whatever the policy | the policy paths of `bm_direct_worker` |
 * | Autonomy design §B.5, ADR-025: the owner's policy never answers an Orchestrator question as it opens; an owner's answer to one grants nothing (missions design §9.1): its prepared command approves no effect | the `bm_ask_owner` paths |
 * | change-004 (ADR-017, the field case of 2026-09-30): a Worker's question has one answer and only the plugin's `BM-DELIVERY` reaches the Worker, each `Qn` once; a command carrying the answer to a stored `Qn` is refused and sends nothing; `bm_decide` answers only a question whose class the owner's policy delegates to the Orchestrator, never a hard-owner one, and its answer reaches the Worker only as that `BM-DELIVERY` (autonomy design §B.5, §B.9, bead t9lm.11) | the `bm_decide` paths; `expectBoundary` (`deliveries`) |
 * | REQ-079 c: no stop, archive, delete, config write; no instruction write (autonomy design §B.8) | the spy + `expectBoundary` after every path |
 * | O-3: an all-`owner` project → no finished, stalled or Worker-signal event and no message to the Orchestrator; a stall is only an Inbox alert | "the stall pass", "the event bus" |
 * | O-4: no Orchestrator agent and no send before the owner starts it | "O-4 — before the user opens the Orchestrator" |
 * | Autonomy design §E.2: `bm_why` only reads — the chain behind a decision, a bead or a file — and writes, sends and reads no timeline | the `bm_why` path, O-4 |
 * | Missions design §9.5, REQ-195 a: the plugin's own compaction and handoff at a crossing Worker's or Main's turn send only the `/compact`, the `BM-STATE` brief and the `BM-HANDOFF` note request, through the queue, create nothing and wake no one | the two code-run paths |
 * | Coverage: every registered RPC and every Orchestrator tool | the two "covers every…" tests |
 *
 * Mutants this suite was run against (2026-09-29, bead muzh.5), each made by
 * hand in `plugin/server/orchestrator-tools.ts`, seen failing, then reverted:
 * `bmSendCommand` taking `source` as `"chat"` without the owner's-word check
 * fails the three refusal paths and O-4 (a send the policy did not allow) and
 * the chat path (it no longer reads the Orchestrator's chat) — 4 tests. (Two
 * more mutants of that run tested the §6A limit sentence, which the block's
 * `limits:` field replaced, design §6B.1.) Run again on 2026-09-29 (bead
 * ouuu.3), in the same file: `bm_direct_worker` interrupting with no open
 * danger allowance, and the gate never refusing, each fail the
 * `bm_direct_worker` refusal path; no copy to the Manager fails the two
 * `bm_direct_worker` delivery paths.
 *
 * Run again on 2026-09-29 (bead ouuu.7), each mutant made by hand, seen
 * failing, then reverted — in `worker-watch.ts`: the pass watching Workers of
 * any project (the Autopilot filter removed) fails "Autopilot on for another
 * project only" (1 test); in `orchestrator-tools.ts`: `bm_direct_worker`
 * without the authority check fails its three authority paths and O-4 (4);
 * the gate never refusing fails the `bm_send_command` gate path and the
 * `bm_direct_worker` refusal path (2); the gate applied to Worker commands
 * only fails the `bm_send_command` gate path (1); no copy to the Manager
 * fails the three `bm_direct_worker` delivery paths (3); a direct command
 * always sent at once fails the two queued delivery paths through the spy
 * (2); the interrupt without the allowance check fails the refusal path (1);
 * a Reviewer accepted as a Worker fails the refusal path (1); `bm_repo`
 * running `git add -A` before `status` fails "bm_repo never writes" (1).
 *
 * Run again on 2026-09-29 (the F2 fix): in `orchestrator-tools.ts`, the stop
 * exemption applied without the Worker's open danger, and never applied, each
 * fail the "stopping a Worker's open danger" path (1 each here, 1 each in
 * `test/orchestrator-tools.test.ts`).
 *
 * A temporary data folder, workspace folder and HOME; never the real ones or
 * a daemon.
 */

type TurnEndedEvent = PluginLifecycleEvents["agent.turn_ended"];
type Entry = { item: Record<string, unknown>; timestamp: string };

/** What the spies record; hoisted so the module mocks below can reach it. */
const boundary = vi.hoisted(() => ({
  violations: [] as string[],
}));

// The Paseo CLI changes an existing agent's mode or labels: never an Orchestrator action.
vi.mock("../plugin/server/paseo-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof PaseoCli>();
  const forbidden =
    (command: string) =>
    async (...args: unknown[]): Promise<{ ok: false; reason: string }> => {
      boundary.violations.push(`paseo ${command} ${String(args[0])}`);
      return { ok: false, reason: "forbidden by the boundary test" };
    };
  return {
    ...actual,
    setAgentMode: forbidden("agent mode"),
    setAgentLabel: forbidden("agent update --label"),
    setAgentLabels: forbidden("agent update --label"),
  };
});

// ── Fixture: one live request that strays from the process ──────────────────

const REQUEST_ID = "req-20260926T100040Z";
const STRANGER = "agent-stranger";
const NOW = new Date("2026-09-27T00:00:00.000Z");
const VI_REQUEST = "Sửa định dạng ngày trên màn hình Hoá đơn thành dd/mm/yyyy.";
const VI_HANDOFF = "Mình đã giao việc này cho Beads Worker, có kết quả mình sẽ báo lại ngay.";
const EN_RELAY = "The Worker has sized this as a Small request and started on it.";

/**
 * A running Small request: the user writes Vietnamese, the Manager hands it
 * over in Vietnamese and relays the Worker's `received` report in English
 * (`manager.language-mismatch`); the Worker, still running, has run a
 * `br create` (`process.small-heavy`). An idle Reviewer the Worker created is
 * there only so that a send to a Reviewer has a target to be caught on.
 */
function liveSlip(): { records: TraceRecord[]; agents: AgentFacts[] } {
  const records = [
    turn({
      at: at(0, 40),
      turnId: "m-1",
      requestId: REQUEST_ID,
      startedAt: at(0, 20),
      endedAt: at(0, 40),
      sent: [msg(MANAGER, at(0, 20), VI_REQUEST, "user")],
      received: [msg(MANAGER, at(0, 35), VI_HANDOFF)],
    }),
    turn({
      at: at(1, 20),
      turnId: "m-2",
      requestId: REQUEST_ID,
      startedAt: at(1, 10),
      endedAt: at(1, 20),
      sent: [msg(MANAGER, at(1, 10), `BM-REPORT\nrequestId: ${REQUEST_ID}\nphase: received\ntier: Small`, "agent")],
      received: [msg(MANAGER, at(1, 15), EN_RELAY)],
      reports: [report({ agentId: WORKER, at: at(1, 10), requestId: REQUEST_ID, phase: "received", tier: "Small" })],
    }),
    turn({
      agentId: WORKER,
      role: "worker",
      at: at(3),
      turnId: "w-1",
      requestId: REQUEST_ID,
      parentAgentId: MANAGER,
      startedAt: at(0, 45),
      endedAt: at(3),
      sent: [msg(WORKER, at(0, 45), `Request ${REQUEST_ID}: ${VI_REQUEST}`, "agent")],
      evidence: [shell(`br create "Fix the invoice date" --json`, at(1, 30))],
    }),
  ];
  const agents = [
    agent({ id: MANAGER, role: "manager" }),
    agent({ id: WORKER, role: "worker", status: "running", parentAgentId: MANAGER, createdAt: at(0, 30), requestIdLabel: REQUEST_ID }),
    agent({ id: REVIEWER, role: "reviewer", parentAgentId: WORKER, createdAt: at(2), requestIdLabel: REQUEST_ID }),
  ];
  return { records, agents };
}

// Live timeline entries, as `timeline.refetch` returns them.
const T = (minute: number, second = 0) => at(10 + minute, second);
const userMessage = (text: string, when: string): Entry => ({ item: { type: "user_message", text }, timestamp: when });
const assistantMessage = (text: string, when: string): Entry => ({ item: { type: "assistant_message", text }, timestamp: when });
const shellCall = (command: string, when: string): Entry => ({
  item: { type: "tool_call", name: "Bash", detail: { type: "shell", command } },
  timestamp: when,
});

// ── The spying fake SDK ─────────────────────────────────────────────────────

interface FakeAgent {
  id: string;
  provider: string;
  status: string;
  archivedAt: string | null;
  labels: Record<string, string>;
  createdAt: string | null;
  timeline: Entry[];
  /** Its current turn's start, as a running agent's snapshot gives it (`activeTurn.startedAt`); the Worker watch keys on it (design §6B.3). */
  turnStartedAt?: string;
}

interface CreateOptions {
  config: { provider: string; modeId?: string; featureValues?: Record<string, unknown> };
  title: string;
  labels: Record<string, string>;
  prompt: string;
}

/** What each test lets the fake do; everything else is a violation. */
interface Policy {
  /** `workspaces.ref(id).agents.create` of `bm-orchestrator` (only `orchestrator.open` with `confirmed: true` does it). */
  create: boolean;
  /**
   * The agents a `send` may reach: a Manager only for an allowed
   * `bm_send_command`, a prepared command the owner picked and the copy of a
   * `bm_direct_worker` command, a Worker only for `bm_direct_worker`, the
   * Orchestrator only for the plugin's `BM-EVENTS` and `BM-ANSWER` (design §10,
   * autonomy design §A.6, §A.8). Empty everywhere else.
   */
  sendTo: Set<string>;
}

/**
 * Method names that act on an agent, a workspace or the configuration. Any of
 * them the fake does not define on purpose is answered by a function that
 * records a violation, so a call the suite did not foresee still fails it. A
 * name must be the verb alone or the verb followed by a capital (`setMode`,
 * `archive`), so a read such as `settings` is never caught.
 */
const ACTING_METHOD =
  /^(archive|unarchive|cancel|stop|interrupt|abort|kill|delete|remove|destroy|close|patch|set|update|replace|write|save|create|send|prompt|restart|reload|install|uninstall|enable|disable|rename|move|approve|deny|answer|respond|reply)([A-Z_]|$)/;

function forbid(what: string): never {
  boundary.violations.push(what);
  throw new Error(`REQ-079 boundary: ${what}`);
}

/** `target`, where reading any acting method it does not define gives a function that records a violation. */
function guarded<T extends object>(path: string, target: T): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === "string" && !Reflect.has(object, key) && ACTING_METHOD.test(key)) {
        return () => forbid(`${path}.${key}()`);
      }
      return Reflect.get(object, key, receiver) as unknown;
    },
  });
}

const firstLine = (text: string) => text.split("\n")[0] ?? "";

function snapshotOf(entry: FakeAgent): Record<string, unknown> {
  return {
    id: entry.id,
    provider: entry.provider,
    status: entry.status,
    workspaceId: WORKSPACE_ID,
    labels: entry.labels,
    archivedAt: entry.archivedAt,
    ...(entry.createdAt === null ? {} : { createdAt: entry.createdAt }),
  };
}

function fakeAgentOf(facts: AgentFacts, timeline: Entry[] = []): FakeAgent {
  const labels: Record<string, string> = { "bm.role": facts.role };
  if (facts.parentAgentId !== null) labels["paseo.parent-agent-id"] = facts.parentAgentId;
  if (facts.requestIdLabel !== null) labels["bm.requestId"] = facts.requestIdLabel;
  return {
    id: facts.id,
    provider: `bm-${facts.role}`,
    status: facts.status,
    archivedAt: null,
    labels,
    createdAt: facts.createdAt,
    timeline,
  };
}

/**
 * The fake SDK. Reads (`agents.list`, `refresh`, `workspaces.list`,
 * `config.get`, `providers.*`) answer; `timeline.refetch` answers for a
 * `bm-*` agent only; `create` answers only as `policy` allows and only for a
 * `bm-orchestrator` agent; every `send` is a violation. Every other acting
 * method — `archive`, `cancel`, `stop`, `config.patch`,
 * `config.set`, `agents.create`, … — is a violation.
 */
function spyingPaseo(initial: readonly FakeAgent[], directory: string) {
  const table = new Map(initial.map((entry) => [entry.id, entry]));
  const policy: Policy = { create: false, sendTo: new Set() };
  const creates: CreateOptions[] = [];
  const sends: Array<{ id: string; text: string }> = [];
  const opens: string[] = [];
  const reads: string[] = [];
  const refreshes: string[] = [];
  const isBm = (id: string) => table.get(id)?.provider.startsWith("bm-") === true;

  const refOf = (id: string) =>
    guarded(`agents.ref(${id})`, {
      timeline: guarded(`agents.ref(${id}).timeline`, {
        refetch: async () => {
          reads.push(id);
          const self = table.get(id);
          if (self === undefined || !isBm(id)) forbid(`timeline read of ${id} (provider ${self?.provider ?? "unknown"})`);
          return { entries: self.timeline, hasOlder: false, agent: snapshotOf(self) };
        },
      }),
      refresh: async () => {
        refreshes.push(id);
        const self = table.get(id);
        if (self === undefined) return { agent: null };
        const turn = self.turnStartedAt === undefined ? {} : { activeTurn: { turnId: "turn-live", startedAt: self.turnStartedAt } };
        return { agent: { id, status: self.status, archivedAt: self.archivedAt, ...turn } };
      },
      send: async (text: string) => {
        if (!policy.sendTo.has(id)) forbid(`send to ${id}: ${firstLine(text)}`);
        // ADR-016 decision 2: a running Worker's turn is replaced only while its danger allowance is open.
        const self = table.get(id);
        if (self?.provider === "bm-worker" && self.status === "running" && !createOrchestratorStore(home).isDangerOpen(WORKSPACE_ID, id)) {
          forbid(`send to the running Worker ${id} with no open danger allowance: ${firstLine(text)}`);
        }
        sends.push({ id, text });
      },
    });

  const create = async (workspaceId: string, options: CreateOptions) => {
    const provider = options.config.provider;
    if (!policy.create) forbid(`agents.create of ${provider} in ${workspaceId}`);
    if (provider.split("/")[0] !== ORCHESTRATOR_PROVIDER_ID) forbid(`agents.create of ${provider}, which is not ${ORCHESTRATOR_PROVIDER_ID}`);
    creates.push(options);
    const id = `agent-orchestrator-${creates.length}`;
    table.set(id, {
      id,
      provider,
      status: "idle",
      archivedAt: null,
      labels: options.labels,
      createdAt: NOW.toISOString(),
      timeline: [userMessage(options.prompt, T(30)), assistantMessage("Ready.", T(31))],
    });
    return guarded(`the Orchestrator agent ${id}`, { id, current: () => ({ status: "idle" }) });
  };

  const paseo = guarded("paseo", {
    agents: guarded("paseo.agents", {
      list: async () => ({ entries: [...table.values()].map((entry) => ({ agent: snapshotOf(entry) })) }),
      ref: refOf,
    }),
    workspaces: guarded("paseo.workspaces", {
      list: async () => ({ entries: [{ id: WORKSPACE_ID, name: "invoice-app", directory }] }),
      // Opening a workspace is allowed only for the Orchestrator's own home (design §3.3, §10).
      open: async (input: { cwd: string }) => {
        if (!input.cwd.endsWith(join("orchestrator", "home"))) forbid(`workspaces.open of ${input.cwd}`);
        opens.push(input.cwd);
        return { id: "wks-orchestrator", directory: input.cwd };
      },
      ref: (workspaceId: string) =>
        guarded(`workspaces.ref(${workspaceId})`, {
          agents: guarded(`workspaces.ref(${workspaceId}).agents`, {
            create: (options: CreateOptions) => create(workspaceId, options),
          }),
        }),
    }),
    config: guarded("paseo.config", {
      get: async () => ({
        config: {
          providers: { [ORCHESTRATOR_PROVIDER_ID]: { extends: "codex", label: "Beads Orchestrator" } },
          agentProfiles: [{ id: ORCHESTRATOR_PROVIDER_ID, name: "Beads Orchestrator", provider: ORCHESTRATOR_PROVIDER_ID, model: "gpt-5.6-sol" }],
          plugins: {},
        },
      }),
    }),
    providers: guarded("paseo.providers", {
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }, { provider: "claude", available: true }] }),
      listModes: async () => ({
        modes: [
          { id: "auto", colorTier: "moderate" },
          { id: "auto-review", colorTier: "safe" },
          { id: "full-access", colorTier: "dangerous" },
        ],
      }),
      listFeatures: async () => ({ features: [] }),
    }),
  });
  return { paseo: paseo as unknown as DashboardPaseo, table, policy, creates, opens, reads, refreshes, sends, isBm };
}

type Fake = ReturnType<typeof spyingPaseo>;

/** The fake's acting surface, loosely typed, for the spy's own tests. */
type Loose = Record<string, (...args: unknown[]) => unknown>;
function loose(fake: Fake) {
  const paseo = fake.paseo as unknown as {
    agents: Loose & { ref(id: string): Loose & { timeline: Loose } };
    workspaces: Loose & { ref(id: string): { agents: Loose } };
    config: Loose;
  };
  return paseo;
}

// ── Per-test state ──────────────────────────────────────────────────────────

let root: string;
let home: string;
let workspaceDir: string;
let deps: OrchestratorRpcDeps;
let stallWatcher: StallWatcher;
let eventBus: EventBus;
let fake: Fake;
let tools: OrchestratorTools;
let enqueueSpy: MockInstance<NoticeQueue["enqueue"]>;
let batchSpy: MockInstance<NoticeQueue["enqueueBatch"]>;
let host: ReturnType<typeof hostOf>;
let before: { workspace: Record<string, string>; data: Record<string, string> };

const location = () => ({ tracesDir: join(home, "traces") });
/** Where the retired additional instructions were kept (autonomy design §B.8): no path may write it. */
const retiredExtrasPath = () => join(home, "role-extras.json");

/** Every file under `dir` by relative path, skipping the top-level entries named in `skip`. */
function snapshotDir(dir: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, relative: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (relative === "" && skip.includes(name)) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, path);
      else out[path] = readFileSync(full, "utf8");
    }
  };
  walk(dir, "");
  return out;
}

/** paseo-bm's data folder outside its own stores: where the retired role instructions were, and anything else kept there. */
const dataOutsideStores = () => snapshotDir(home, ["orchestrator", "traces", "decisions", "inbox", "handoffs", "memory", "missions"]);

/**
 * The owner puts a project in the events' scope (autonomy design §A.8): one
 * class above `owner` in the policy. What the path itself writes is checked
 * from here on.
 */
function ownerScopes(workspaceId = WORKSPACE_ID, mode: "shadow" | "delegate" = "shadow"): void {
  createAutonomyStore(home).set({ workspaceId, class: "scope", mode, confirmed: true }, NOW.toISOString());
  before = { ...before, data: dataOutsideStores() };
}

/**
 * The owner delegates one class of the project to the Orchestrator (autonomy
 * design §B.5): its Worker questions ask the Orchestrator to decide them.
 * `openQuestion()` is `reversible-technical`. What the path itself writes is
 * checked from here on.
 */
function ownerDelegatesToOrchestrator(decisionClass: "reversible-technical" | "scope" = "reversible-technical"): void {
  createAutonomyStore(home).set({ workspaceId: WORKSPACE_ID, class: decisionClass, mode: "delegate", confirmed: true }, NOW.toISOString());
  before = { ...before, data: dataOutsideStores() };
}

/**
 * The owner delegates every class that may be delegated for the project
 * (autonomy design §B.9): the authority that replaced Autopilot (§B.8). A
 * command declaring none goes out as `policy:reversible-technical`. What the
 * path itself writes is checked from here on.
 */
function ownerDelegatesAll(workspaceId = WORKSPACE_ID): void {
  for (const decisionClass of ["dependency", "environment", "scope", "preference", "reversible-technical"] as const) {
    createAutonomyStore(home).set({ workspaceId, class: decisionClass, mode: "delegate", confirmed: true }, NOW.toISOString());
  }
  before = { ...before, data: dataOutsideStores() };
}

/** `orchestrator/settings.json` as an earlier build left it: Autopilot on for the project, Allow… `allow`. Nothing reads it any more (autonomy design §B.8). */
function earlierAutopilotSettings(allow: readonly string[] = ["security", "release", "data", "cost", "dependency"], workspaceId = WORKSPACE_ID): void {
  mkdirSync(join(home, "orchestrator"), { recursive: true });
  writeFileSync(join(home, "orchestrator", "settings.json"), JSON.stringify({ version: 3, autopilot: { [workspaceId]: { enabled: true, since: at(0), by: "tab", allow } } }));
}

/** The refusal of a command no authority covers: the class not delegated, then the owner's missing word (autonomy design §B.9). */
const NOT_DELEGATED = "reversible-technical is not delegated in this project and the owner has not just told you to stop it";
/** The refusal of a stop while no danger signal of the Worker and no governor stop step of its mission is open (missions design §9.1). */
const STOP_NOT_OPEN = "a Worker is stopped only while a danger signal of it is open";

/** A host that validates input with each contract before calling the handler, as Paseo's RPC host does. */
function hostOf(paseo: unknown) {
  const handlers = new Map<string, { input: { parse(value: unknown): unknown }; handler: (input: unknown, context: unknown) => unknown }>();
  registerOrchestratorRpcs(
    {
      handle: (rpc: { name: string; input: { parse(value: unknown): unknown } }, handler: (input: unknown, context: unknown) => unknown) =>
        handlers.set(rpc.name, { input: rpc.input, handler }),
    } as never,
    deps,
  );
  return {
    names: [...handlers.keys()],
    call: async (name: string, input: unknown): Promise<unknown> => {
      const entry = handlers.get(name);
      if (entry === undefined) throw new Error(`${name} is not registered`);
      return entry.handler(entry.input.parse(input), { paseo });
    },
  };
}

function ended(agentId: string, provider: string): TurnEndedEvent {
  return { agent: { id: agentId, provider, workspaceId: WORKSPACE_ID }, turnId: null, timeline: [] } as unknown as TurnEndedEvent;
}

/** What the plugin runs for the Orchestrator at an `agent.turn_ended`: the shared notice queue's delivery. */
async function turnEnded(event: TurnEndedEvent): Promise<void> {
  await noticeQueue.turnEnded(event, fake.paseo);
}

const managerEnded = () => ended(MANAGER, "bm-manager");
const workerEnded = () => ended(WORKER, "bm-worker");

beforeEach(async () => {
  boundary.violations.length = 0;
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-boundary-"));
  home = join(root, "data");
  workspaceDir = join(root, "workspace");
  mkdirSync(join(workspaceDir, ".beads"), { recursive: true });
  mkdirSync(join(workspaceDir, "docs", "plans"), { recursive: true });
  writeFileSync(join(workspaceDir, ".beads", "issues.jsonl"), `${JSON.stringify({ id: "bm-d1", title: "Fix the invoice date", status: "open" })}\n`);
  writeFileSync(join(workspaceDir, "docs", "plans", "invoice-plan.md"), "# Invoice plan\n");
  // Wired as index.server.ts wires it: one event bus on the shared queue, the stall pass publishing through it,
  // every orchestrator.* call handing both the handle. Neither is started here: index.server.ts starts the pass.
  eventBus = createEventBus({ env: { PASEO_BM_HOME: home }, homedir: () => root, log: () => {} });
  stallWatcher = createStallWatcher({ env: { PASEO_BM_HOME: home }, homedir: () => root, log: () => {}, bus: eventBus });
  deps = {
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    onPaseo: (paseo) => {
      stallWatcher.usePaseo(paseo);
      eventBus.usePaseo(paseo);
    },
  };
  vi.stubEnv("PASEO_BM_HOME", home);
  clearTraceStoreCache();
  forgetModes();

  const { records, agents } = liveSlip();
  for (const record of records) await appendRecord(location(), record);
  writeWorkspaceMeta(location(), WORKSPACE_ID, { lastKnownName: "invoice-app", lastKnownDirectory: workspaceDir, lastSeenAt: at(6) });

  const [manager, worker, reviewer] = agents;
  fake = spyingPaseo(
    [
      fakeAgentOf(manager!),
      fakeAgentOf(reviewer!, [userMessage("Review the invoice date change.", T(2))]),
      fakeAgentOf(worker!, [userMessage(`Request ${REQUEST_ID}: ${VI_REQUEST}`, T(0)), shellCall(`br create "Fix the invoice date" --json`, T(1))]),
      // Not paseo-bm's: another provider, no bm.role, even though our Worker created it.
      {
        id: STRANGER,
        provider: "claude",
        status: "running",
        archivedAt: null,
        labels: { "paseo.parent-agent-id": WORKER },
        createdAt: at(2),
        timeline: [userMessage("Look at the date parser.", T(0)), shellCall(`br create "Parser" --json`, T(1))],
      },
    ],
    workspaceDir,
  );
  host = hostOf(fake.paseo);
  // The endpoint's tools, wired as agent-tools.ts and index.server.ts wire them: the handle comes from a hook or
  // RPC context; a question bm_decide answered takes the owner answers' delivery, through the shared queue.
  tools = createOrchestratorTools({
    env: { PASEO_BM_HOME: home },
    homedir: () => root,
    now: () => NOW,
    onSettled: settledByKind({ question: questionDelivery().onSettled, orchestrator: orchestratorDelivery() }),
  });
  tools.usePaseo(fake.paseo);
  enqueueSpy = vi.spyOn(noticeQueue, "enqueue");
  batchSpy = vi.spyOn(noticeQueue, "enqueueBatch");
  before = { workspace: snapshotDir(workspaceDir), data: dataOutsideStores() };
});

afterEach(() => {
  stallWatcher.stop();
  const violations = [...boundary.violations];
  boundary.violations.length = 0;
  noticeQueue.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearTraceStoreCache();
  forgetModes();
  rmSync(root, { recursive: true, force: true });
  // A forbidden call the production code swallowed still fails the test.
  expect(violations).toEqual([]);
});

/** The plugin's delivery of stored answers to a Worker (autonomy design §A.6), not a command. */
const isAnswersDelivery = (text: string): boolean => text.startsWith(`${DELIVERY_NOTICE_MARKER} answers\n`);
/** What `bm_compact` sends (autonomy design §G.5): the provider's `/compact`, bare or with its focus, and the `BM-STATE` brief. */
const isCompactionMessage = (text: string): boolean => text === "/compact" || text.startsWith("/compact ") || text.startsWith(`${STATE_NOTICE_MARKER}\n`);
/** What `bm_handoff` sends the Worker it names (autonomy design §G.6): the `BM-HANDOFF` note request, no command. */
const isHandoffNoteRequest = (text: string): boolean => text.startsWith(`${HANDOFF_NOTICE_MARKER}\n`);

/**
 * What must hold after any path: no forbidden call; no agent created; nothing
 * sent or queued, except — with `sendsTo` — one delivery or more, all to
 * those agents; every timeline read of a `bm-*` agent; the workspace (beads,
 * documents) untouched; no role instructions written, and nothing else in the
 * data folder outside its stores.
 * The Worker gets the plugin's `BM-DELIVERY answers` only with `deliveries`,
 * and then every `Qn` in them is a stored decision that is answered, and none
 * reaches it twice (change-004).
 */
function expectBoundary(
  options: { creates?: number; sendsTo?: readonly string[]; limits?: boolean; deliveries?: boolean; compaction?: boolean; handoff?: boolean } = {},
): void {
  expect(boundary.violations).toEqual([]);
  // Autonomy design §G.5: what `bm_compact` sends the Manager or Worker it names — the provider's /compact and the
  // BM-STATE brief — is no command; any other path sending one fails the BM-COMMAND check below.
  const isCommand = (text: string): boolean =>
    !isAnswersDelivery(text) && !(options.compaction === true && isCompactionMessage(text)) && !(options.handoff === true && isHandoffNoteRequest(text));
  const deliveries = [...fake.sends.filter((sent) => sent.id === WORKER).map((sent) => sent.text), ...noticeQueue.pending(WORKER).map((queued) => queued.text)].filter(
    isAnswersDelivery,
  );
  if (options.deliveries !== true) expect(deliveries).toEqual([]);
  const deliveredKeys = deliveries.flatMap((text) => {
    const set = parseAnswers(text)!;
    return set.answers.map((answer) => `q:${set.requestId}:${answer.id}`);
  });
  expect(new Set(deliveredKeys).size, "a Qn delivered twice").toBe(deliveredKeys.length);
  for (const id of deliveredKeys) expect(createDecisionStore(home).get(id, WORKSPACE_ID), id).toMatchObject({ status: "answered" });
  // REQ-082 c, design §6B.1, autonomy design §A.7: what reaches the Manager or the Worker, sent or still
  // queued, is a BM-COMMAND v2 block with its authority; it carries the limits its approval leaves when the
  // Orchestrator decided it — never one that withholds an approved effect — and none when the owner typed it.
  const toWorking = [MANAGER, WORKER]
    .flatMap((id) => [...fake.sends.filter((sent) => sent.id === id).map((sent) => sent.text), ...noticeQueue.pending(id).map((queued) => queued.text)])
    .filter(isCommand);
  for (const text of toWorking) {
    const block = parseCommandBlock(text);
    expect(block, text).not.toBeNull();
    expect(block!.version).toBe(2);
    expect(block!.authority).not.toBeNull();
    expect(block!.limits).toEqual(options.limits === true ? limitsOf(block!.approved) : []);
    expect(block!.limits.flatMap(effectsWithheldBy).filter((effect) => block!.approved.includes(effect))).toEqual([]);
    expect(block!.from).toBe(options.limits === true ? "orchestrator" : "owner");
  }
  if (options.limits === true) expect(toWorking).not.toHaveLength(0);
  // ADR-016 decision 2, design §6B.4: what reaches the Worker is a `to: worker` block from the Orchestrator,
  // and its Manager has the same block as a copy; a Manager gets `to: manager` blocks, or copies of what its Worker got.
  const blocksTo = (id: string) =>
    [...fake.sends.filter((sent) => sent.id === id).map((sent) => sent.text), ...noticeQueue.pending(id).map((queued) => queued.text)]
      .filter(isCommand)
      .map((text) => parseCommandBlock(text)!);
  const toWorker = blocksTo(WORKER);
  const toManager = blocksTo(MANAGER);
  for (const block of toWorker) {
    expect(block).toMatchObject({ from: "orchestrator", to: "worker", copy: false });
    expect(toManager).toContainEqual({ ...block, copy: true });
  }
  for (const block of toManager.filter((candidate) => candidate.to === "worker")) {
    expect(block.copy).toBe(true);
    expect(toWorker).toContainEqual({ ...block, copy: false });
  }
  expect(toManager.filter((block) => block.to === "manager" && block.copy)).toEqual([]);
  expect(fake.creates).toHaveLength(options.creates ?? 0);
  expect(fake.opens).toHaveLength(options.creates ?? 0);
  const queuedTo = [...enqueueSpy.mock.calls.map(([target]) => target), ...batchSpy.mock.calls.map(([target]) => target)];
  if (options.sendsTo === undefined) {
    expect(queuedTo).toEqual([]);
    expect(fake.sends).toEqual([]);
  } else {
    const allowed = new Set(options.sendsTo);
    expect(queuedTo).not.toHaveLength(0);
    expect(queuedTo.filter((target) => !allowed.has(target))).toEqual([]);
    expect(fake.sends.map((sent) => sent.id).filter((id) => !allowed.has(id))).toEqual([]);
    expect([...fake.sends.map((sent) => sent.id), ...options.sendsTo.flatMap((id) => noticeQueue.pending(id).map(() => id))]).not.toHaveLength(0);
  }
  expect(fake.reads.filter((id) => !fake.isBm(id))).toEqual([]);
  expect(fake.reads).not.toContain(STRANGER);
  expect(snapshotDir(workspaceDir)).toEqual(before.workspace);
  expect(existsSync(retiredExtrasPath())).toBe(false);
  expect(dataOutsideStores()).toEqual(before.data);
}

// ── The spy itself ──────────────────────────────────────────────────────────

describe("the spying SDK catches every forbidden action (REQ-079 a-c)", () => {
  const cases: Array<[string, (fake: Fake) => unknown]> = [
    ["archiving an agent", (f) => loose(f).agents.ref(WORKER).archive!()],
    ["cancelling an agent's turn", (f) => loose(f).agents.ref(WORKER).cancel!()],
    ["stopping an agent", (f) => loose(f).agents.ref(WORKER).stop!()],
    ["deleting an agent", (f) => loose(f).agents.delete!(WORKER)],
    ["creating an agent through agents.create", (f) => loose(f).agents.create!({ provider: "bm-worker" })],
    [
      "creating a bm-orchestrator agent",
      (f) => loose(f).workspaces.ref(WORKSPACE_ID).agents.create!({ config: { provider: ORCHESTRATOR_PROVIDER_ID }, labels: {}, prompt: "", title: "" }),
    ],
    [
      "creating any other agent, even while a creation is allowed",
      (f) => {
        f.policy.create = true;
        return loose(f).workspaces.ref(WORKSPACE_ID).agents.create!({ config: { provider: "bm-worker" }, labels: {}, prompt: "", title: "" });
      },
    ],
    ["patching the Paseo configuration", (f) => loose(f).config.patch!({ mcp: { injectIntoAgents: true } })],
    ["setting the Paseo configuration", (f) => loose(f).config.set!({})],
    ["sending to a Manager", (f) => loose(f).agents.ref(MANAGER).send!("Please continue.")],
    ["answering a Worker's question", (f) => loose(f).agents.ref(WORKER).send!("Q1: use dd/mm/yyyy.")],
    ["sending to a Reviewer", (f) => loose(f).agents.ref(REVIEWER).send!("Approve it.")],
    [
      "interrupting the running Worker with no open danger allowance, even where a send is allowed",
      (f) => {
        f.policy.sendTo.add(WORKER);
        return loose(f).agents.ref(WORKER).send!("Stop.");
      },
    ],
    ["sending to an agent that is not paseo-bm's", (f) => loose(f).agents.ref(STRANGER).send!("Look again.")],
    ["deleting an agent through its handle", (f) => loose(f).agents.ref(WORKER).delete!()],
    ["opening a workspace that is not the Orchestrator's home", (f) => loose(f).workspaces.open!({ cwd: workspaceDir })],
    ["creating a workspace", (f) => loose(f).workspaces.create!({ cwd: workspaceDir })],
    ["reading the timeline of an agent that is not bm-*", (f) => loose(f).agents.ref(STRANGER).timeline.refetch!({})],
    ["changing an agent's mode through the Paseo CLI", () => setAgentMode(WORKER, "full-access")],
    ["labelling an agent through the Paseo CLI", () => setAgentLabels(WORKER, { "bm.role": "worker" })],
  ];

  for (const [label, act] of cases) {
    it(`records ${label} as a violation`, async () => {
      await Promise.resolve()
        .then(() => act(fake))
        .catch(() => undefined);
      expect(boundary.violations).toHaveLength(1);
      boundary.violations.length = 0;
    });
  }
});

// ── Nothing runs on its own ─────────────────────────────────────────────────

describe("turn ends and time passing: nothing is sent, created or scheduled", () => {
  it("Manager and Worker turn ends and three minutes: 0 send, 0 enqueue, 0 agents.create, no timer", async () => {
    vi.useFakeTimers({ now: NOW });

    await turnEnded(managerEnded());
    await turnEnded(workerEnded());
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await turnEnded(managerEnded());

    expect(noticeQueue.pending(MANAGER)).toEqual([]);
    expect(noticeQueue.pending(WORKER)).toEqual([]);
    expect(fake.reads).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expectBoundary();
  });
});

describe("the stall pass: a stalled request is an Inbox alert, never a message outside the policy's scope (autonomy design §A.8)", () => {
  it("a stalled request, an open Orchestrator, an all-owner project and thirty minutes of passes: one alert, 0 enqueue, 0 send", async () => {
    vi.useFakeTimers({ now: NOW });
    seedOrchestrator();
    // Idle since 10:03 the day before: a stall.
    fake.table.get(WORKER)!.status = "idle";

    stallWatcher.usePaseo(fake.paseo);
    stallWatcher.start();
    await turnEnded(workerEnded());
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    stallWatcher.stop();

    expect(vi.getTimerCount()).toBe(0);
    expect(createAlertStore(home).list({ open: true })).toMatchObject([{ kind: "request-stalled", workspaceId: WORKSPACE_ID, subject: REQUEST_ID }]);
    expectBoundary();
  });
});

// ── Events to the Orchestrator (autonomy design §A.8) ───────────────────────

/** The Manager turn `m-4` that received the Worker's `finished` report, as the collector records it. */
function finishedManagerRecord(): TraceRecord {
  const reportAt = at(8);
  return turn({
    at: reportAt,
    turnId: "m-4",
    requestId: REQUEST_ID,
    startedAt: reportAt,
    endedAt: reportAt,
    // Work left (a ready bead): only such a finish wakes the Orchestrator (autonomy design §A.8).
    sent: [msg(MANAGER, reportAt, `BM-REPORT\nrequestId: ${REQUEST_ID}\nphase: finished\ntier: Small\nbeadsReady: bd-7\nbuildAndTests: npm test green`, "agent")],
    reports: [report({ agentId: MANAGER, at: reportAt, requestId: REQUEST_ID, phase: "finished", tier: "Small", beadsReady: ["bd-7"], buildAndTests: "npm test green" })],
  });
}

/** The Manager turn `m-5`: no report, it only asks the owner whether to go on. */
function askingManagerRecord(): TraceRecord {
  const endedAt = at(9);
  return turn({
    at: endedAt,
    turnId: "m-5",
    requestId: REQUEST_ID,
    startedAt: endedAt,
    endedAt,
    sent: [msg(MANAGER, endedAt, "The Worker says the date fix is done.", "agent")],
    received: [msg(MANAGER, endedAt, "The date fix is done. Should I tell the Worker to go on?")],
  });
}

/** The Worker's question Q1 of the request, as the materialiser opens it. */
function openQuestion(): Decision {
  const decision: Decision = {
    id: `q:${REQUEST_ID}:Q1`,
    workspaceId: WORKSPACE_ID,
    requestId: REQUEST_ID,
    askedBy: { role: "worker", agentId: WORKER },
    askedAt: at(5),
    round: 1,
    question: "Which date format?",
    subject: null,
    options: [
      { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] },
      { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["none"] },
    ],
    status: "open",
    settledAt: null,
    needsConfirmation: null,
    answer: null,
    grant: null,
    delivery: null,
    supersedes: null,
    supersededBy: null,
  };
  createDecisionStore(home).open(decision);
  return decision;
}

describe("the event bus: only BM-EVENTS, only to the Orchestrator, a finished step only for a project in the policy's scope (autonomy design §A.8)", () => {
  // A Worker question follows the policy per cell, not its scope (design §B.9, change-007 C1): test/event-bus.test.ts.
  it("an all-owner project: a finished step sends nothing and starts no timer", async () => {
    vi.useFakeTimers({ now: NOW });
    seedOrchestrator();
    await expect(eventBus.turnRecorded(finishedManagerRecord(), [], fake.paseo)).resolves.toMatchObject({ status: "none", published: [] });
    await turnEnded(managerEnded());
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(vi.getTimerCount()).toBe(0);
    expectBoundary();
  });

  it("a class above owner: a delegated question and a finished step wake nobody, retired as wakes (missions design §9.1); setting the policy itself sends nothing", async () => {
    vi.useFakeTimers({ now: NOW });
    seedOrchestrator();
    ownerDelegatesToOrchestrator();
    expect(fake.sends).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    await expect(eventBus.turnRecorded(finishedManagerRecord(), [openQuestion()], fake.paseo)).resolves.toMatchObject({ status: "none", published: [] });
    await turnEnded(managerEnded());
    await turnEnded(workerEnded());
    expect(fake.sends).toEqual([]);
    expectBoundary();
  });

  it("a Reviewer's turn is never a request.finished event (a Worker's own finish is, design §7.17.8 i), and a Manager turn without a report is no event at all (a Manager's turn wakes nobody)", async () => {
    seedOrchestrator();
    ownerScopes();
    fake.table.get(WORKER)!.status = "idle";
    fake.table.get(REVIEWER)!.status = "idle";
    await expect(eventBus.turnRecorded({ ...finishedManagerRecord(), agentId: REVIEWER, role: "reviewer" }, [], fake.paseo)).resolves.toMatchObject({ status: "none" });
    await expect(eventBus.turnRecorded(askingManagerRecord(), [], fake.paseo)).resolves.toMatchObject({ status: "none" });
    expectBoundary();
  });

  it("a class above owner in another project only: this project's finished step sends nothing", async () => {
    seedOrchestrator();
    ownerScopes("wks-other", "delegate");
    await expect(eventBus.turnRecorded(finishedManagerRecord(), [], fake.paseo)).resolves.toMatchObject({ status: "none" });
    await turnEnded(managerEnded());
    expectBoundary();
  });

  it("a class above owner but no Orchestrator: nothing is queued, sent or created (O-4)", async () => {
    ownerScopes();
    await expect(eventBus.turnRecorded(finishedManagerRecord(), [openQuestion()], fake.paseo)).resolves.toMatchObject({ status: "none", published: [] });
    expect(fake.creates).toEqual([]);
    expectBoundary();
  });
});

// ── The live watch of running Workers (design §6B.3, ADR-016) ──────────────

describe("the live watch of running Workers (design §6B.3)", () => {
  it("an all-owner project: thirty minutes of passes raise the Worker's alerts, send nothing, open no allowance, and read only that bm-* Worker", async () => {
    vi.useFakeTimers({ now: NOW });
    fake.table.get(WORKER)!.turnStartedAt = T(0);
    fake.table.get(WORKER)!.timeline.push(shellCall("git push origin main", T(2)));
    // The stranger the Worker created is running too, and pushes: not paseo-bm's, never read.
    fake.table.get(STRANGER)!.turnStartedAt = T(0);
    fake.table.get(STRANGER)!.timeline.push(shellCall("git push origin main", T(2)));

    stallWatcher.usePaseo(fake.paseo);
    stallWatcher.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await expect(stallWatcher.workerPass()).resolves.toMatchObject({ status: "done", watched: [WORKER], raised: [], events: [], allowances: [] });
    stallWatcher.stop();

    expect(new Set(fake.reads)).toEqual(new Set([WORKER]));
    expect(new Set(fake.refreshes)).toEqual(new Set([WORKER]));
    expect(createAlertStore(home).list({ open: true, kinds: ["stuck", "danger", "permission-waiting"] }).map((alert) => alert.kind)).toEqual(["stuck", "danger"]);
    expect(createOrchestratorStore(home).listDangerAllowances()).toEqual([]);
    expectBoundary();
  });

  it("a class above owner in another project only: this project's running Worker raises its alerts, and nothing is told", async () => {
    seedOrchestrator();
    fake.table.get(WORKER)!.turnStartedAt = T(0);
    fake.table.get(WORKER)!.timeline.push(shellCall("git push origin main", T(2)));
    ownerScopes("wks-other", "delegate");
    stallWatcher.usePaseo(fake.paseo);

    await expect(stallWatcher.workerPass()).resolves.toMatchObject({ status: "done", watched: [WORKER], events: [], allowances: [] });

    expect(new Set(fake.reads.filter((id) => id !== ORCHESTRATOR_ID))).toEqual(new Set([WORKER]));
    expect(createAlertStore(home).list({ open: true }).map((alert) => alert.kind)).toEqual(["stuck", "danger"]);
    expect(createOrchestratorStore(home).listDangerAllowances()).toEqual([]);
    expectBoundary();
  });

  it("a class above owner: a running Worker's signals reach the Orchestrator only, as one BM-EVENTS message, once per turn; only that bm-* Worker's timeline is read", async () => {
    seedOrchestrator();
    fake.policy.sendTo.add(ORCHESTRATOR_ID);
    // The Worker, running since T(0), pushes; the request is Small and it ran `br create` (liveSlip).
    fake.table.get(WORKER)!.turnStartedAt = T(0);
    fake.table.get(WORKER)!.timeline.push(shellCall("git push origin main", T(2)));
    // The stranger the Worker created is running too, and pushes: not paseo-bm's, never read.
    fake.table.get(STRANGER)!.turnStartedAt = T(0);
    fake.table.get(STRANGER)!.timeline.push(shellCall("git push origin main", T(2)));
    ownerScopes();
    stallWatcher.usePaseo(fake.paseo);

    const first = await stallWatcher.workerPass();
    expect(first).toMatchObject({ status: "done", watched: [WORKER], allowances: [WORKER] });
    // NOW is the next day: the newest entry is hours old, so `stuck` holds too. `heavy` is an event, not an alert.
    expect(first.events.map((event) => (event.type === "worker.signal" ? event.signal : event.type))).toEqual(["stuck", "danger", "heavy"]);
    expect(first.raised.map((key) => key.split(":")[0])).toEqual(["stuck", "danger"]);
    await expect(stallWatcher.workerPass()).resolves.toMatchObject({ raised: [], allowances: [] });

    expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text)])).toEqual([[ORCHESTRATOR_ID, "BM-EVENTS"]]);
    // Only danger wakes it: stuck and heavy are retired as wakes (missions design §9.7, §9.1).
    expect(fake.sends[0]!.text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(" — ")[0])).toEqual(["- worker.signal danger"]);
    // Besides the Orchestrator's own chat (read before it is woken, design §6B.6), only the watched Worker's timeline.
    expect(new Set(fake.reads.filter((id) => id !== ORCHESTRATOR_ID))).toEqual(new Set([WORKER]));
    expect(new Set(fake.refreshes.filter((id) => id !== ORCHESTRATOR_ID))).toEqual(new Set([WORKER]));
    expect(createOrchestratorStore(home).isDangerOpen(WORKSPACE_ID, WORKER)).toBe(true);
    // The Worker's turn end clears its alerts; nothing is sent to anyone.
    expect(stallWatcher.workerTurnEnded({ id: WORKER, provider: "bm-worker" })).toHaveLength(2);
    expect(fake.sends).toHaveLength(1);
    expectBoundary({ sendsTo: [ORCHESTRATOR_ID] });
  });
});

// ── REQ-079 (a-c): every path ───────────────────────────────────────────────

interface BoundaryPath {
  name: string;
  /** The RPC this path calls, for the coverage check; null for a hook, watcher or tool path. */
  rpc: string | null;
  /** The Orchestrator tool this path calls through the endpoint, for the coverage check. */
  tool?: string;
  /** The bm-orchestrator agents the path creates (orchestrator.open with confirmed: true). */
  creates?: number;
  /** The only agents the path may send to: a Manager (bm_govern, a prepared command, a stop's copy), a Worker (bm_direct_worker) or the Orchestrator (BM-EVENTS, BM-ANSWER). */
  sendsTo?: readonly string[];
  /** What the path sends the Manager or the Worker is the Orchestrator's (its tools, or a command it prepared): each block carries the limits. Otherwise none does. */
  limits?: boolean;
  /** The plugin delivers stored answers to the Worker (`BM-DELIVERY answers`): the path settles Worker questions. */
  deliveries?: boolean;
  /** The path sends the Manager or the Worker `bm_compact`'s /compact and BM-STATE brief (autonomy design §G.5), which are no commands. */
  compaction?: boolean;
  /** The path sends the Worker `bm_handoff`'s BM-HANDOFF note request (autonomy design §G.6), which is no command. */
  handoff?: boolean;
  run(): Promise<void>;
}

const ORCHESTRATOR_ID = "agent-orchestrator-main";

/** A Claude turn's usage: `read` tokens read in the turn (input + cached). */
const claudeUsage = (read: number): Usage => ({
  inputTokens: 1_000,
  cachedInputTokens: read - 1_000,
  outputTokens: 2_000,
  costUsd: null,
  costBasis: "unavailable",
  model: "claude-opus-5",
  pricesUpdatedAt: null,
});

/**
 * A recorded turn handed to the plugin's own compaction and handoff runners,
 * in the order the collector's `onRecorded` runs them (`index.server.ts`),
 * through the shared notice queue (missions design §9.5).
 */
async function codeRunTurn(record: TraceRecord, items: readonly unknown[] = []): Promise<void> {
  const event = { agent: { id: record.agentId }, turnId: record.turnId, timeline: items };
  await createCompactionRunner({ home: () => home, now: () => NOW, log: () => {} }).turnRecorded(event, record, fake.paseo);
  await createHandoffRunner({ home: () => home, now: () => NOW, log: () => {} }).turnRecorded(event, record, fake.paseo);
}

/** Every command the Orchestrator's store records. */
const allCommands = () => createOrchestratorStore(home).listCommands();

/** One `tools/call` through the endpoint's JSON-RPC answer, as the Orchestrator's MCP client sends it. */
async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const reply = await answerOrchestrator({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tools);
  const result = (reply as { result?: { content: Array<{ text: string }>; isError?: boolean } } | null)?.result;
  if (result === undefined) throw new Error(`${name}: no tool result (${JSON.stringify(reply)})`);
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError === true };
}

/** The delivery of an Orchestrator decision the owner answered (autonomy design §A.6), through the plugin's shared notice queue. */
const orchestratorDelivery = () => createOrchestratorDecisionDelivery({ home: () => home, now: () => NOW });
/** The delivery of a Worker's answered questions (autonomy design §A.6), through the plugin's shared notice queue. */
const questionDelivery = () => createQuestionDecisionDelivery({ home: () => home, now: () => NOW });

/** `decisions.answer` as the Inbox calls it, with the plugin's delivery of Orchestrator decisions. */
function answerDecisionRpc(input: Parameters<typeof handleDecisionsAnswer>[0]) {
  return handleDecisionsAnswer(input, fake.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled: settledByKind({ orchestrator: orchestratorDelivery() }) });
}

/** The labels of an Orchestrator created with this plugin's instructions (design §3.3). */
const CURRENT_ORCHESTRATOR_LABELS = { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH };

/** The Orchestrator agent, already open (created by an earlier `orchestrator.open`), with its own chat. */
function seedOrchestrator(timeline: Entry[] = [], labels: Record<string, string> = CURRENT_ORCHESTRATOR_LABELS): void {
  fake.table.set(ORCHESTRATOR_ID, {
    id: ORCHESTRATOR_ID,
    provider: `${ORCHESTRATOR_PROVIDER_ID}/gpt-5.6-sol`,
    status: "idle",
    archivedAt: null,
    labels,
    createdAt: at(0),
    timeline,
  });
}

/** A message the owner typed in the Orchestrator's chat (the app gives it a `clientMessageId`). */
const ownerMessage = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `c-${when}` }, timestamp: when });
/** The event bus's message in the Orchestrator's chat (autonomy design §A.8): a plugin notice, never the owner's word. */
const EVENTS_NOTICE = `BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event, oldest first. Look before you act; when nothing needs doing, do nothing.\n- request.stalled idle-unfinished — project ${WORKSPACE_ID}, request ${REQUEST_ID}, since ${at(3)}. Look with bm_request.`;
/** A plugin notice in the Orchestrator's chat: the notice queue sends through the app's path, so it carries one too. */
const pluginNotice = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `n-${when}` }, timestamp: when });
/** What `bm_direct_worker` stops the running Worker with, in the boundary paths (missions design §9.1: only a stop at once). */
const STOP = {
  workspaceId: WORKSPACE_ID,
  workerId: WORKER,
  requestId: REQUEST_ID,
  re: "stop at once",
  intent: "stop",
  interrupt: true,
  command: "Stop now and wait for your Main; change nothing more.",
  why: "Its danger signal is open.",
};
const stopBlock = (overrides: Partial<CommandInput> = {}) =>
  commandBlockOf({ from: "orchestrator", via: "chat", to: "worker", requestId: REQUEST_ID, re: STOP.re, body: STOP.command, why: STOP.why, intent: "stop", ...overrides });
/** The refusal of a text that shows a release the command does not declare (autonomy design §A.7). */
const RELEASE_UNDECLARED = "the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner";

const PATHS: BoundaryPath[] = [
  {
    name: "orchestrator.open-preview",
    rpc: "orchestrator.open-preview",
    run: async () => {
      await expect(host.call("orchestrator.open-preview", {})).resolves.toMatchObject({ exists: false, workspace: "own" });
    },
  },
  {
    name: "orchestrator.open without confirmed: true",
    rpc: "orchestrator.open",
    run: async () => {
      await expect(host.call("orchestrator.open", {})).rejects.toThrow();
    },
  },
  {
    name: "orchestrator.open with confirmed: true, twice",
    rpc: "orchestrator.open",
    creates: 1,
    run: async () => {
      fake.policy.create = true;
      await expect(host.call("orchestrator.open", { confirmed: true })).resolves.toMatchObject({ created: true });
      await expect(host.call("orchestrator.open", { confirmed: true })).resolves.toMatchObject({ created: false });
      expect(fake.creates[0]!.config.provider.split("/")[0]).toBe(ORCHESTRATOR_PROVIDER_ID);
      expect(fake.creates[0]!.labels).toMatchObject({ "bm.role": "orchestrator", "bm.orchestrator": "main" });
    },
  },
  {
    name: "orchestrator.state",
    rpc: "orchestrator.state",
    run: async () => {
      seedOrchestrator();
      await expect(host.call("orchestrator.state", {})).resolves.toMatchObject({ agent: { id: ORCHESTRATOR_ID } });
    },
  },
  {
    name: "the stall pass for an all-owner project: an Inbox alert, nobody woken",
    rpc: null,
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      seedOrchestrator();
      fake.table.get(WORKER)!.status = "idle";
      stallWatcher.usePaseo(fake.paseo);
      stallWatcher.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      stallWatcher.stop();
      expect(createAlertStore(home).list({ open: true })).toMatchObject([{ kind: "request-stalled", subject: REQUEST_ID }]);
      expect(fake.sends).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  },
  {
    name: "the stall pass with a class above owner: an Inbox alert, nobody woken (request.stalled is retired as a wake, missions design §9.1)",
    rpc: null,
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      seedOrchestrator();
      fake.table.get(WORKER)!.status = "idle";
      ownerScopes();
      stallWatcher.usePaseo(fake.paseo);
      stallWatcher.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      stallWatcher.stop();
      expect(createAlertStore(home).list({ open: true })).toMatchObject([{ kind: "request-stalled", subject: REQUEST_ID }]);
      expect(fake.sends).toEqual([]);
      expect(fake.reads.filter((id) => id !== ORCHESTRATOR_ID)).toEqual([]);
    },
  },
  {
    name: "the stall pass with a class above owner and an outdated Orchestrator: nothing replaced or told, since a stall wakes nobody (missions design §9.1)",
    rpc: null,
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      // Opened before its instructions were labelled: Paseo keeps the old system prompt (design §3.3).
      seedOrchestrator([], { "bm.role": "orchestrator", "bm.orchestrator": "main" });
      fake.table.get(WORKER)!.status = "idle";
      ownerScopes();
      stallWatcher.usePaseo(fake.paseo);
      stallWatcher.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      stallWatcher.stop();
      expect(fake.creates).toEqual([]);
      expect(fake.sends).toEqual([]);
      // The old one stays: not archived, not messaged.
      expect(fake.table.get(ORCHESTRATOR_ID)!.archivedAt).toBeNull();
    },
  },
  {
    name: "the stall pass with a class above owner and no Orchestrator: the alert is kept, nothing is sent",
    rpc: null,
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      fake.table.get(WORKER)!.status = "idle";
      ownerScopes();
      stallWatcher.usePaseo(fake.paseo);
      stallWatcher.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      stallWatcher.stop();
      expect(createAlertStore(home).list({ open: true })).toMatchObject([{ kind: "request-stalled", detail: "idle-unfinished" }]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_projects",
    rpc: null,
    tool: "bm_projects",
    run: async () => {
      const answer = await callTool("bm_projects", { sinceHours: 168, detail: "full" });
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain(REQUEST_ID);
      expect(answer.text).not.toContain(STRANGER);
    },
  },
  {
    name: "tool bm_request",
    rpc: null,
    tool: "bm_request",
    run: async () => {
      const answer = await callTool("bm_request", { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID });
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain(VI_REQUEST);
      expect(answer.text).not.toContain("Look at the date parser.");
    },
  },
  {
    name: "tool bm_agent_messages: a Manager is read; an agent that is not paseo-bm's, and the Orchestrator itself, are refused unread",
    rpc: null,
    tool: "bm_agent_messages",
    run: async () => {
      seedOrchestrator();
      await expect(callTool("bm_agent_messages", { agentId: WORKER })).resolves.toMatchObject({ isError: false });
      for (const agentId of [STRANGER, ORCHESTRATOR_ID]) {
        const refused = await callTool("bm_agent_messages", { agentId });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("is not a paseo-bm agent");
      }
      expect(fake.reads).toEqual([WORKER]);
    },
  },
  {
    name: "tool bm_govern sends the mission's current Main one governor command, with no effect and the limits, and nothing to anyone else; an unknown mission is refused (missions design §9.4)",
    rpc: null,
    tool: "bm_govern",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      const made = createMissionStore(home, { now: () => NOW }).create({ code: "DATES", name: "Dates", goal: "Fix the date format.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MANAGER });
      if (!made.ok) throw new Error(made.reasons.join("; "));
      expect(await callTool("bm_govern", { missionId: "mis-0000000099", step: "nudge", text: "Re-plan." })).toMatchObject({ isError: true, text: expect.stringContaining("no mission mis-0000000099") });
      expect(await callTool("bm_govern", { missionId: made.mission.missionId, step: "nudge", text: "Push the fix now." })).toMatchObject({ isError: true, text: expect.stringContaining(RELEASE_UNDECLARED) });
      expect(fake.sends).toEqual([]);
      fake.policy.sendTo.add(MANAGER);
      expect((await callTool("bm_govern", { missionId: made.mission.missionId, step: "replan", text: "Your Workers re-ask the same question: settle it in one line." })).isError).toBe(false);
      expect(fake.sends.map((sent) => [sent.id, parseCommandBlock(sent.text)])).toEqual([
        [MANAGER, expect.objectContaining({ from: "orchestrator", to: "manager", authority: "governor:replan", effects: [], approved: [] })],
      ]);
      expect(allCommands()).toMatchObject([{ managerId: MANAGER, missionId: made.mission.missionId }]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_missions reads the missions with their figures and ladder, and writes, sends and reads no timeline (missions design §9.1)",
    rpc: null,
    tool: "bm_missions",
    run: async () => {
      expect(createMissionStore(home, { now: () => NOW }).create({ code: "DATES", name: "Dates", goal: "Fix the date format.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MANAGER }).ok).toBe(true);
      before = { ...before, data: dataOutsideStores() };
      const read = await callTool("bm_missions", {});
      expect(read.isError).toBe(false);
      expect(JSON.parse(read.text)).toMatchObject({ missions: [{ code: "DATES", mainId: MANAGER }] });
      expect(allCommands()).toEqual([]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_arbitrate records the area's owner and tells the Mains with governor commands, with no effect and the limits; a goal change is only the owner's card; a bad pair is refused and sends nothing (missions design §9.6)",
    rpc: null,
    tool: "bm_arbitrate",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      const missions = createMissionStore(home, { now: () => NOW });
      const owner = missions.create({ code: "DATES", name: "Dates", goal: "Fix the date format.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MANAGER });
      const loser = missions.create({ code: "BILL", name: "Billing", goal: "Rework the invoices.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: null });
      if (!owner.ok || !loser.ok) throw new Error("missions not created");
      const pair = [owner.mission.missionId, loser.mission.missionId];
      const input = { missions: pair, workspaceId: WORKSPACE_ID, area: "src/dates", owner: owner.mission.missionId, reason: "Dates owns the date helpers." };
      expect(await callTool("bm_arbitrate", { ...input, missions: [pair[0], "mis-0000000099"] })).toMatchObject({ isError: true, text: expect.stringContaining("no mission mis-0000000099") });
      expect(await callTool("bm_arbitrate", { ...input, owner: "mis-0000000099" })).toMatchObject({ isError: true, text: expect.stringContaining("owner: must be one of the two missions") });
      expect(fake.sends).toEqual([]);
      fake.policy.sendTo.add(MANAGER);
      const told = await callTool("bm_arbitrate", { ...input, goal: "Rework the invoices, leaving the date helpers to Dates." });
      expect(told.isError).toBe(false);
      // Billing has no Main yet: only the Dates Main is told; Billing's goal waits on the owner's card. The backstop
      // reads the Orchestrator's words only, so the owner's mission name "Billing" does not read as cost.
      expect(told.text).toContain("the Main of DATES is told");
      expect(fake.sends.map((sent) => [sent.id, parseCommandBlock(sent.text)])).toEqual([
        [MANAGER, expect.objectContaining({ from: "orchestrator", to: "manager", authority: "governor:arbitrate", effects: [], approved: [] })],
      ]);
      expect(createMissionDecisionStore(home).list(loser.mission.missionId)).toMatchObject([{ status: "open" }]);
      expect(missions.get(loser.mission.missionId)!.charter.goal).toBe("Rework the invoices.");
      expect(fake.creates).toEqual([]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_create_main without the mission's split cell only opens the owner's card: it creates no mission, no agent and sends nothing; a bad split is refused (missions design §9.6)",
    rpc: null,
    tool: "bm_create_main",
    run: async () => {
      const missions = createMissionStore(home, { now: () => NOW });
      const source = missions.create({ code: "DATES", name: "Dates", goal: "Fix the date format and rework the invoices.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MANAGER });
      if (!source.ok) throw new Error(source.reasons.join("; "));
      const split = { fromMissionId: source.mission.missionId, name: "Invoices", code: "INV", goal: "Rework the invoices.", repos: [WORKSPACE_ID], reason: "Two goals in one mission." };
      expect(await callTool("bm_create_main", { ...split, fromMissionId: "mis-0000000099" })).toMatchObject({ isError: true });
      expect(await callTool("bm_create_main", { ...split, code: "DATES" })).toMatchObject({ isError: true });
      const asked = await callTool("bm_create_main", split);
      expect(asked).toMatchObject({ isError: false, text: expect.stringContaining("the owner's") });
      expect(createMissionDecisionStore(home).list(source.mission.missionId)).toMatchObject([{ status: "open" }]);
      expect(missions.byCode("INV")).toBeNull();
      expect(missions.list()).toHaveLength(1);
      expect(fake.creates).toEqual([]);
      expect(fake.sends).toEqual([]);
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_direct_worker is refused for anything but a stop at once, without an open danger signal or stop step, without the owner's policy and word, and to a Reviewer, a Manager or another agent",
    rpc: null,
    tool: "bm_direct_worker",
    run: async () => {
      earlierAutopilotSettings();
      seedOrchestrator([ownerMessage("Stop it.", T(0)), pluginNotice(EVENTS_NOTICE, T(1))]);
      expect(await callTool("bm_direct_worker", { ...STOP, interrupt: false })).toMatchObject({ isError: true, text: expect.stringContaining("only stops a Worker at once") });
      expect(await callTool("bm_direct_worker", { ...STOP, intent: "redirect" })).toMatchObject({ isError: true, text: expect.stringContaining("input.intent: must be one of stop") });
      // No allowance; another Worker's, or one opened more than 10 minutes ago, allows no stop either.
      expect(await callTool("bm_direct_worker", STOP)).toMatchObject({ isError: true, text: expect.stringContaining(STOP_NOT_OPEN) });
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, "agent-worker-other");
      createOrchestratorStore(home, { now: () => new Date(Date.now() - 11 * 60 * 1000) }).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(await callTool("bm_direct_worker", STOP)).toMatchObject({ isError: true, text: expect.stringContaining(STOP_NOT_OPEN) });
      // With the danger open: the owner's word was followed by a plugin notice, and no class is delegated here (another project's aside).
      createAutonomyStore(home).set({ workspaceId: "wks-other", class: "reversible-technical", mode: "delegate", confirmed: true }, NOW.toISOString());
      before = { ...before, data: dataOutsideStores() };
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(await callTool("bm_direct_worker", STOP)).toMatchObject({ isError: true, text: expect.stringContaining(NOT_DELEGATED) });
      expect(fake.reads).toEqual([ORCHESTRATOR_ID]);
      ownerDelegatesAll();
      for (const target of [REVIEWER, MANAGER, STRANGER]) {
        expect(await callTool("bm_direct_worker", { ...STOP, workerId: target })).toMatchObject({ isError: true, text: expect.stringContaining("is not a paseo-bm Worker") });
      }
      expect(await callTool("bm_direct_worker", { ...STOP, command: "Stop, then deploy it to production." })).toMatchObject({ isError: true, text: expect.stringContaining(RELEASE_UNDECLARED) });
      expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_direct_worker right after the owner's own message, the Worker's danger open: the stop at once to that Worker, the copy to its Manager",
    rpc: null,
    tool: "bm_direct_worker",
    sendsTo: [WORKER, MANAGER],
    limits: true,
    run: async () => {
      seedOrchestrator([pluginNotice(EVENTS_NOTICE, T(0)), ownerMessage("Stop the Worker now.", T(1))]);
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      fake.policy.sendTo.add(WORKER);
      fake.policy.sendTo.add(MANAGER);
      expect(await callTool("bm_direct_worker", STOP)).toMatchObject({ isError: false, text: expect.stringMatching(/^Stopped:/) });
      expect(fake.sends).toEqual([
        { id: WORKER, text: stopBlock() },
        { id: MANAGER, text: stopBlock({ copy: true }) },
      ]);
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ to: "worker", workerId: WORKER, managerId: MANAGER, source: "chat" }]);
      // Only the Orchestrator's own chat was read for the check.
      expect(fake.reads).toEqual([ORCHESTRATOR_ID]);
    },
  },
  {
    name: "tool bm_direct_worker stopping a Worker's open danger: the stop that names the push un-negated is gated like any command, even to that Worker; one whose stop word negates the push passes to that Worker only",
    rpc: null,
    tool: "bm_direct_worker",
    sendsTo: [WORKER, MANAGER],
    limits: true,
    run: async () => {
      ownerDelegatesAll();
      // Allow… release, as an earlier build stored it: it exempts nothing any more (autonomy design §B.8).
      earlierAutopilotSettings(["release"]);
      // The stop the gate held in the coordination run of 2026-09-29 (F2): it names the push it stops.
      const f2 = { ...STOP, re: "stop and report", command: "Stop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made." };
      const gated = { isError: true, text: expect.stringContaining(RELEASE_UNDECLARED) };
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(await callTool("bm_direct_worker", f2)).toMatchObject(gated);
      expect(await callTool("bm_direct_worker", { ...f2, command: "Push the branch once more and report." })).toMatchObject(gated);
      expect(fake.sends).toEqual([]);
      expect(allCommands()).toEqual([]);

      // Its stop word before the push negates it: the stop passes, at once to that Worker only.
      fake.policy.sendTo.add(WORKER);
      fake.policy.sendTo.add(MANAGER);
      const negated = { ...f2, command: "Stop the git push runs and the waits now. Send your report: what git said each time." };
      expect((await callTool("bm_direct_worker", negated)).isError).toBe(false);
      const onPolicy = { re: f2.re, body: negated.command, authority: "policy:reversible-technical" } as const;
      expect(fake.sends).toEqual([
        { id: WORKER, text: stopBlock(onPolicy) },
        { id: MANAGER, text: stopBlock({ ...onPolicy, copy: true }) },
      ]);
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ to: "worker", workerId: WORKER, managerId: MANAGER }]);
    },
  },
  {
    name: "tool bm_repo reads inside the project's folder only and writes nothing there",
    rpc: null,
    tool: "bm_repo",
    run: async () => {
      await callTool("bm_repo", { workspaceId: WORKSPACE_ID, action: "status" });
      await callTool("bm_repo", { workspaceId: WORKSPACE_ID, action: "diff-stat" });
      expect(await callTool("bm_repo", { workspaceId: WORKSPACE_ID, action: "show", file: "../outside.txt" })).toMatchObject({
        isError: true,
        text: expect.stringContaining("outside the project's folder"),
      });
      expect((await callTool("bm_repo", { workspaceId: WORKSPACE_ID, action: "status", path: ".." })).isError).toBe(true);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_note records a note and sends nothing",
    rpc: null,
    tool: "bm_note",
    run: async () => {
      expect((await callTool("bm_note", { workspaceId: WORKSPACE_ID, text: "The owner wants dd/mm/yyyy everywhere." })).isError).toBe(false);
      expect(createOrchestratorStore(home).readNotes(WORKSPACE_ID)).toMatchObject([{ text: "The owner wants dd/mm/yyyy everywhere." }]);
      // Missions design §9.1: a note keyed by mission.
      const made = createMissionStore(home, { now: () => NOW }).create({ code: "DATES", name: "Dates", goal: "Fix the date format.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MANAGER });
      if (!made.ok) throw new Error(made.reasons.join("; "));
      before = { ...before, data: dataOutsideStores() };
      expect((await callTool("bm_note", { missionId: made.mission.missionId, text: "Watch the drift." })).isError).toBe(false);
      expect(createOrchestratorStore(home).readNotes({ missionId: made.mission.missionId })).toMatchObject([{ text: "Watch the drift." }]);
    },
  },
  {
    name: "tool bm_findings reads the project's findings, and writes and sends nothing (autonomy design §G.4)",
    rpc: null,
    tool: "bm_findings",
    run: async () => {
      const answer = await callTool("bm_findings", { workspaceId: WORKSPACE_ID });
      expect(answer.isError).toBe(false);
      expect(answer.text.length).toBeLessThanOrEqual(4_000);
      expect(allCommands()).toEqual([]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_why reads the chain behind a decision, a bead or a file, and writes and sends nothing (autonomy design §E.2)",
    rpc: null,
    tool: "bm_why",
    run: async () => {
      clearDecisionStoreCache();
      createDecisionStore(home).open(makeDecision({ id: `q:${REQUEST_ID}:Q1`, workspaceId: WORKSPACE_ID, requestId: REQUEST_ID }));
      before = { ...before, data: dataOutsideStores() };
      const byDecision = await callTool("bm_why", { workspaceId: WORKSPACE_ID, decision: `q:${REQUEST_ID}:Q1` });
      expect(byDecision.isError).toBe(false);
      expect(byDecision.text.length).toBeLessThanOrEqual(4_000);
      expect(JSON.parse(byDecision.text)).toMatchObject({ found: true, chains: [{ request: { requestId: REQUEST_ID } }] });
      for (const lookup of [{ bead: "bm-nowhere" }, { file: "src/invoice/date.ts" }, { decision: "q:nowhere:Q1" }]) {
        const answer = await callTool("bm_why", { workspaceId: WORKSPACE_ID, ...lookup, detail: "full" });
        expect(answer.isError).toBe(false);
        expect(JSON.parse(answer.text)).toMatchObject({ found: false });
      }
      expect((await callTool("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-1", file: "a.ts" })).isError).toBe(true);
      expect(createDecisionStore(home).get(`q:${REQUEST_ID}:Q1`, WORKSPACE_ID)).toMatchObject({ status: "open", answer: null });
      expect(allCommands()).toEqual([]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_reply appends the Orchestrator's reply to the owner's open question about its own o: decision, answers nothing and sends nothing (change-014 outcome 3)",
    rpc: null,
    tool: "bm_reply",
    run: async () => {
      clearDecisionStoreCache();
      const id = "o:boundary-reply-1";
      createDecisionStore(home).open(makeDecision({ id, workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, askedBy: { role: "orchestrator", agentId: ORCHESTRATOR_ID } }));
      before = { ...before, data: dataOutsideStores() };
      // Nobody asked: refused, nothing written.
      expect((await callTool("bm_reply", { decisionId: id, text: "Unasked." })).isError).toBe(true);
      expect(createDecisionThreadStore(home).read(WORKSPACE_ID, id).entries).toEqual([]);
      createDecisionThreadStore(home).append(WORKSPACE_ID, id, { by: "owner", text: "Why stop the Worker?", at: at(5) });
      const replied = await callTool("bm_reply", { decisionId: id, text: "It loops on the same failing test." });
      expect(replied.isError).toBe(false);
      expect(createDecisionThreadStore(home).read(WORKSPACE_ID, id).entries.map((entry) => entry.by)).toEqual(["owner", "asker"]);
      // A Worker's question is not the Orchestrator's to reply to.
      expect((await callTool("bm_reply", { decisionId: `q:${REQUEST_ID}:Q1`, text: "x" })).isError).toBe(true);
      expect(createDecisionStore(home).get(id, WORKSPACE_ID)).toMatchObject({ status: "open", answer: null });
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_ask_owner with prepared changes of the owner's settings (a review budget among them) stores the decision and writes no setting; the policy, bm_decide and bm_predict never answer it (autonomy design §G.4)",
    rpc: null,
    tool: "bm_ask_owner",
    run: async () => {
      clearDecisionStoreCache();
      // The owner delegates reversible-technical to the Orchestrator and turns its predictions on; from here on,
      // the owner's settings (autonomy/, coordination/) must stay as they are: no tool writes them.
      ownerDelegatesToOrchestrator();
      createAutonomyStore(home).setChallenger({ workspaceId: WORKSPACE_ID, enabled: true });
      before = { ...before, data: dataOutsideStores() };
      const asked = await callTool("bm_ask_owner", {
        workspaceId: WORKSPACE_ID,
        question: "Advise less often, shadow scope, or save the date format?",
        recommendation: "Advise after every 10 finished requests.",
        options: [
          { label: "Every 10", effects: ["none"], recommended: true, change: { kind: "coordination.set", key: "advice.everyFinished", value: 10 } },
          { label: "Shadow scope", effects: ["none"], change: { kind: "autonomy.set", class: "scope", mode: "shadow" } },
          { label: "Save the date format", effects: ["none"], change: { kind: "precedent.save", scope: "project", subject: "date-format", text: "dd/mm/yyyy" } },
          // §G.4's review.budget (bead 7gxw.12): a coordination.set on a review-budget key, the owner's only.
          { label: "Large: 6 review calls", effects: ["none"], change: { kind: "coordination.set", key: "review.largeBudget", value: 6 } },
          { label: "Keep", effects: ["none"] },
        ],
      });
      expect(asked.isError).toBe(false);
      const id = (JSON.parse(asked.text.slice(asked.text.indexOf("\n{") + 1)) as { decisionId: string }).decisionId;
      expect((await callTool("bm_decide", { decisionId: id, optionKey: "a", reason: "Less often." })).isError).toBe(true);
      expect((await callTool("bm_predict", { decisionId: id, optionKey: "a", reason: "Less often." })).isError).toBe(true);
      expect(createDecisionStore(home).get(id, WORKSPACE_ID)).toMatchObject({ status: "open", answer: null });
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_ask_owner stores a decision and sends nothing",
    rpc: null,
    tool: "bm_ask_owner",
    run: async () => {
      clearDecisionStoreCache();
      seedOrchestrator([ownerMessage("Decide it yourself.", T(0))]);
      const answer = await callTool("bm_ask_owner", {
        workspaceId: WORKSPACE_ID,
        managerId: MANAGER,
        requestId: REQUEST_ID,
        question: "Delete the old invoices?",
        recommendation: "No.",
        options: [{ label: "Keep them", effects: ["none"], recommended: true, command: { to: "manager", agentId: MANAGER, intent: "continue", body: "Keep the old invoices as they are." } }],
      });
      expect(answer.isError).toBe(false);
      expect(createDecisionStore(home).list({ workspaceId: WORKSPACE_ID })).toMatchObject([{ status: "open", question: "Delete the old invoices?\n\nRecommendation: No." }]);
      expect(allCommands()).toEqual([]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_decisions reads the stored decisions and sends nothing",
    rpc: null,
    tool: "bm_decisions",
    run: async () => {
      clearDecisionStoreCache();
      await callTool("bm_ask_owner", { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, question: "Delete the old invoices?", recommendation: "No." });
      const stored = readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8");
      const listed = await callTool("bm_decisions", { workspaceId: WORKSPACE_ID, status: "unsettled" });
      expect(listed.isError).toBe(false);
      expect(JSON.parse(listed.text)).toMatchObject({ decisions: [{ status: "open", askedBy: "orchestrator" }], total: 1, truncated: false });
      expect(readFileSync(join(home, "decisions", `${WORKSPACE_ID}.json`), "utf8")).toBe(stored);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_predict records the challenger's prediction on the decision and answers, sends and delivers nothing (autonomy design §B.3)",
    rpc: null,
    tool: "bm_predict",
    run: async () => {
      clearDecisionStoreCache();
      // The owner turns the project's challenger on; what the path itself writes is checked from here on.
      createAutonomyStore(home).setChallenger({ workspaceId: WORKSPACE_ID, enabled: true });
      before = { ...before, data: dataOutsideStores() };
      // A fallback incident: a Worker's question is its Main's or the owner's (missions design §9.1).
      const qid = "f:fb-0123456789ab";
      createDecisionStore(home).open(
        makeDecision({
          id: qid,
          workspaceId: WORKSPACE_ID,
          requestId: null,
          askedBy: { role: "plugin", agentId: null },
          round: null,
          subject: null,
          options: [
            { key: "a", label: "Wait for the reset", recommended: true, effects: ["none"] },
            { key: "b", label: "I'll handle it", recommended: false, effects: ["none"] },
          ],
          prediction: { recommended: { optionKey: "a" }, orchestrator: null },
        }),
      );
      expect(await callTool("bm_predict", { decisionId: `q:${REQUEST_ID}:Q1`, optionKey: "a", reason: "The owner asked for dd/mm/yyyy before." })).toMatchObject({ isError: true });
      expect(await callTool("bm_predict", { decisionId: qid, optionKey: "a", reason: "The reset is soon." })).toMatchObject({ isError: false });
      expect(createDecisionStore(home).get(qid, WORKSPACE_ID)).toMatchObject({ status: "open", answer: null, prediction: { orchestrator: { optionKey: "a" } } });
      expect(await callTool("bm_predict", { decisionId: qid, optionKey: "b", reason: "Again." })).toMatchObject({ isError: true });
      expect(allCommands()).toEqual([]);
      expect(fake.reads).toEqual([]);
    },
  },
  {
    name: "tool bm_decide never answers a Worker's question, delegated or not (missions design §9.1); the owner answers them, a stop re-sending an answer is refused, and the Worker gets each Qn once",
    rpc: null,
    tool: "bm_decide",
    sendsTo: [WORKER],
    deliveries: true,
    run: async () => {
      clearDecisionStoreCache();
      earlierAutopilotSettings();
      // scope is delegated to the Orchestrator; reversible-technical stays the owner's.
      ownerDelegatesToOrchestrator("scope");
      const qid = (n: number) => `q:${REQUEST_ID}:Q${n}`;
      const open = (n: number, overrides: Partial<Decision> = {}) =>
        createDecisionStore(home).open(
          makeDecision({
            id: qid(n),
            workspaceId: WORKSPACE_ID,
            requestId: REQUEST_ID,
            askedBy: { role: "worker", agentId: WORKER },
            askedAt: at(2),
            round: 1,
            question: `Date format question ${n}?`,
            subject: null,
            options: [
              { key: "a", label: "dd/mm/yyyy", recommended: true, effects: ["none"] },
              { key: "b", label: "yyyy-mm-dd", recommended: false, effects: ["commit"] },
            ],
            ...overrides,
          }),
        );
      open(1, { class: "scope" });
      open(2);
      open(3);
      open(4, { class: "scope", options: [{ key: "a", label: "Push the fix", recommended: true, effects: ["push"] }, { key: "b", label: "Hold", recommended: false, effects: ["none"] }] });
      for (const n of [1, 2, 4]) {
        expect(await callTool("bm_decide", { decisionId: qid(n), optionKey: "a", reason: "The owner asked for it." }), `Q${n}`).toMatchObject({ isError: true, text: expect.stringContaining("is a Worker's question: its Main answers it") });
        expect(createDecisionStore(home).get(qid(n), WORKSPACE_ID)).toMatchObject({ status: "open", answer: null });
      }
      expect(fake.sends).toEqual([]);

      // The owner answers Q1, Q2 and Q3 in the Inbox; one block for the request keeps waiting, since the Worker runs.
      const onSettled = settledByKind({ question: questionDelivery().onSettled });
      for (const n of [1, 2, 3]) {
        await handleDecisionsAnswer({ id: qid(n), optionKey: "a", via: "inbox" }, fake.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled });
      }
      // The Orchestrator re-sending an answer by hand, as it did in the field: refused, nothing sent or recorded.
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(await callTool("bm_direct_worker", { ...STOP, command: `BM-ANSWERS\nrequestId: ${REQUEST_ID}\nQ2: a — dd/mm/yyyy` })).toMatchObject({
        isError: true,
        text: expect.stringContaining(`Q2 of ${REQUEST_ID} is the stored decision ${qid(2)}, already answered by the owner`),
      });
      expect(allCommands()).toEqual([]);

      // The Worker's turn ends: ONE BM-DELIVERY with Q1, Q2 and Q3, each once; Q4 still waits for the owner.
      fake.table.get(WORKER)!.status = "idle";
      fake.policy.sendTo.add(WORKER);
      await turnEnded(workerEnded());
      expect(fake.sends.map((sent) => sent.id)).toEqual([WORKER]);
      expect(fake.sends[0]!.text).toBe(
        `BM-DELIVERY answers\nContinue ${REQUEST_ID}.\n\nBM-ANSWERS\nrequestId: ${REQUEST_ID}\nQ1: a — dd/mm/yyyy\nQ2: a — dd/mm/yyyy\nQ3: a — dd/mm/yyyy`,
      );
      expect(noticeQueue.pending(WORKER)).toEqual([]);
      expect(createDecisionStore(home).get(qid(4), WORKSPACE_ID)).toMatchObject({ status: "open", answer: null });
    },
  },
  {
    name: "tool bm_direct_worker with a BM-ANSWERS naming an open stored question: refused, naming its Main or the owner; the question stays open",
    rpc: null,
    tool: "bm_direct_worker",
    run: async () => {
      clearDecisionStoreCache();
      ownerDelegatesAll();
      const id = `q:${REQUEST_ID}:Q1`;
      createDecisionStore(home).open(makeDecision({ id, workspaceId: WORKSPACE_ID, requestId: REQUEST_ID, askedBy: { role: "worker", agentId: WORKER }, subject: null }));
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(await callTool("bm_direct_worker", { ...STOP, command: "BM-ANSWERS\nQ1: use dd/mm/yyyy." })).toEqual({
        isError: true,
        text: `Refused: Q1 of ${REQUEST_ID} is the stored decision ${id}: its Main or the owner answers it, never a BM-ANSWERS block of yours.`,
      });
      expect(createDecisionStore(home).get(id, WORKSPACE_ID)!.status).toBe("open");
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "the owner picks an Orchestrator option with a prepared command: one command to that Manager, approving no effect (missions design §9.1), every limit kept",
    rpc: null,
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      clearDecisionStoreCache();
      fake.policy.sendTo.add(MANAGER);
      const asked = await callTool("bm_ask_owner", {
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        question: "Push the date fix to origin/dev?",
        recommendation: "Yes: the review passed.",
        options: [
          { label: "Push the date fix", effects: ["push"], recommended: true, command: { to: "manager", agentId: MANAGER, intent: "release", body: "Push the date fix to origin/dev." } },
          { label: "Hold", effects: ["none"] },
        ],
      });
      const decisionId = (JSON.parse(asked.text.slice(asked.text.indexOf("{"))) as { decisionId: string }).decisionId;
      const answered = await answerDecisionRpc({ id: decisionId, optionKey: "a", confirmed: true });
      expect(answered.decision).toMatchObject({ grant: null, delivery: { to: MANAGER } });
      const blocks = [...fake.sends.filter((sent) => sent.id === MANAGER).map((sent) => sent.text), ...noticeQueue.pending(MANAGER).map((queued) => queued.text)].map(
        (text) => parseCommandBlock(text)!,
      );
      expect(blocks).toMatchObject([{ to: "manager", authority: `decision:${decisionId}`, effects: ["push"], approved: [], limits: ["no-commit-push-deploy", "no-real-data"] }]);
      // Handed over again, it is not delivered twice.
      await orchestratorDelivery()([createDecisionStore(home).get(decisionId)!], { paseo: fake.paseo });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    },
  },
  {
    name: "the owner's policy never answers an Orchestrator question as it opens (ADR-025: no instant answer): asked, open, nothing sent",
    rpc: null,
    tool: "bm_ask_owner",
    run: async () => {
      clearDecisionStoreCache();
      ownerDelegatesAll();
      const asked = await callTool("bm_ask_owner", {
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        question: "Commit the date fix now?",
        recommendation: "Yes: the review passed.",
        options: [
          { label: "Commit the date fix", effects: ["commit"], recommended: true, command: { to: "manager", agentId: MANAGER, intent: "continue", body: "Commit the date fix on the feature branch." } },
          { label: "Hold", effects: ["none"] },
        ],
      });
      expect(asked.isError).toBe(false);
      const decisionId = (JSON.parse(asked.text.slice(asked.text.indexOf("{"))) as { decisionId: string }).decisionId;
      expect(createDecisionStore(home).get(decisionId)).toMatchObject({ status: "open", answer: null, grant: null, delivery: null });
      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "the owner answers an Orchestrator decision in words: only the Orchestrator gets BM-ANSWER, which issues and announces no grant (missions design §9.1)",
    rpc: null,
    sendsTo: [ORCHESTRATOR_ID],
    run: async () => {
      clearDecisionStoreCache();
      seedOrchestrator([]);
      fake.policy.sendTo.add(ORCHESTRATOR_ID);
      const asked = await callTool("bm_ask_owner", {
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        question: "Push the date fix to origin/dev?",
        recommendation: "Yes: the review passed.",
        options: [{ label: "Push the date fix", effects: ["push"], command: { to: "manager", agentId: MANAGER, intent: "release", body: "Push the date fix to origin/dev." } }],
      });
      const decisionId = (JSON.parse(asked.text.slice(asked.text.indexOf("{"))) as { decisionId: string }).decisionId;
      await answerDecisionRpc({ id: decisionId, words: "Push it, and tell me when it is out.", confirmed: true });
      const told = [...fake.sends.filter((sent) => sent.id === ORCHESTRATOR_ID).map((sent) => sent.text), ...noticeQueue.pending(ORCHESTRATOR_ID).map((queued) => queued.text)];
      expect(told).toHaveLength(1);
      expect(told[0]).toMatch(new RegExp(`^BM-ANSWER\\ndecisionId: ${decisionId}\\n`));
      expect(told[0]).not.toContain("grant");
      expect(createDecisionStore(home).get(decisionId)!.grant).toBeNull();
    },
  },
  {
    name: "a stored prepared command naming a Reviewer is never delivered: nothing to the Reviewer, the Orchestrator told",
    rpc: null,
    sendsTo: [ORCHESTRATOR_ID],
    run: async () => {
      clearDecisionStoreCache();
      seedOrchestrator([]);
      fake.policy.sendTo.add(ORCHESTRATOR_ID);
      const decisionId = "o:forged-reviewer-command";
      createDecisionStore(home).open({
        id: decisionId,
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        askedBy: { role: "orchestrator", agentId: ORCHESTRATOR_ID },
        askedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        round: null,
        question: "Stop the review?",
        subject: null,
        options: [
          { key: "a", label: "Stop it", recommended: true, effects: ["commit"], action: { kind: "command", to: "worker", agentId: REVIEWER, intent: "stop", body: "Stop reviewing.", effects: ["commit"] } },
        ],
        status: "open",
        settledAt: null,
        needsConfirmation: null,
        answer: null,
        grant: null,
        delivery: null,
        supersedes: null,
        supersededBy: null,
      });
      const answered = await answerDecisionRpc({ id: decisionId, optionKey: "a" });
      expect(answered.decision).toMatchObject({ grant: null, delivery: { to: REVIEWER, outcome: "failed" } });
      expect(enqueueSpy.mock.calls.map(([target]) => target)).toEqual([ORCHESTRATOR_ID]);
    },
  },
  {
    name: "tool bm_direct_worker at the loop guard: refused, nothing sent or recorded",
    rpc: null,
    tool: "bm_direct_worker",
    run: async () => {
      ownerDelegatesAll();
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      const store = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
      for (let index = 0; index < 12; index += 1) {
        store.appendCommand({ workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST_ID, command: "Continue.", reason: "", situation: "", sentText: "Continue.", outcome: "sent" });
      }
      const refused = await callTool("bm_direct_worker", STOP);
      expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("you sent 12 commands for this request in 24 hours; ask the owner with bm_ask_owner") });
      expect(createOrchestratorStore(home).listCommands()).toHaveLength(12);
    },
  },
  {
    name: "a Worker's turn crossing its compaction and handoff thresholds: the plugin compacts it and asks its handoff note itself, through the queue, waking no one (missions design §9.5)",
    rpc: null,
    sendsTo: [WORKER],
    compaction: true,
    handoff: true,
    run: async () => {
      seedOrchestrator();
      fake.table.get(WORKER)!.status = "idle";
      fake.policy.sendTo.add(WORKER);
      // 160M tokens read in one turn that closed a bead and sent beads-done: both thresholds crossed, both safe points.
      const crossing = turn({
        agentId: WORKER,
        role: "worker",
        at: at(20),
        turnId: "w-heavy",
        requestId: REQUEST_ID,
        parentAgentId: MANAGER,
        startedAt: at(19),
        endedAt: at(20),
        usage: claudeUsage(160_000_000),
        runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: null, provider: "bm-worker" },
        evidence: [{ kind: "shell", detail: `br close bm-d1 --reason "date format proved"`, agentId: WORKER, at: at(19, 30), status: "completed", exitCode: 0 }],
        reports: [report({ agentId: MANAGER, at: at(20), requestId: REQUEST_ID, phase: "beads-done", tier: "Medium", beadsClosed: ["bm-d1"] })],
      });
      await appendRecord(location(), crossing);
      await codeRunTurn(crossing, [{ type: "tool_call", name: "mcp__paseo__send_agent_prompt", status: "completed", detail: { type: "unknown", input: { agentId: MANAGER, prompt: `BM-REPORT\nrequestId: ${REQUEST_ID}\nphase: beads-done\ntier: Medium` } } }]);
      expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text).split(" ")[0]])).toEqual([
        [WORKER, "/compact"],
        [WORKER, HANDOFF_NOTICE_MARKER],
      ]);
      expect(createInterventionStore(home).list().map((entry) => [entry.kind, entry.trigger, entry.targetAgentId])).toEqual([
        ["compact", "threshold.crossed", WORKER],
        ["handoff", "threshold.crossed", WORKER],
      ]);
      // No command: the Orchestrator is not woken and no Manager is told yet.
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "a Main's turn crossing its context threshold: the plugin compacts it itself, creates nothing and wakes no one (missions design §9.5)",
    rpc: null,
    sendsTo: [MANAGER],
    compaction: true,
    run: async () => {
      seedOrchestrator();
      const made = createMissionStore(home, { now: () => NOW }).create({ code: "DATES", name: "Dates", goal: "Fix the date format.", repos: [WORKSPACE_ID], createdBy: "owner", mainId: MANAGER });
      if (!made.ok) throw new Error(made.reasons.join("; "));
      before = { ...before, data: dataOutsideStores() };
      fake.policy.sendTo.add(MANAGER);
      const crossing = turn({
        agentId: MANAGER,
        role: "manager",
        at: at(20),
        turnId: "m-heavy",
        startedAt: at(19),
        endedAt: at(20),
        usage: claudeUsage(500_000),
        runtime: { model: "claude-opus-5", thinkingOptionId: null, modeId: null, provider: "bm-manager" },
      });
      await appendRecord(location(), crossing);
      await codeRunTurn(crossing);
      expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text).split(" ")[0]])).toEqual([[MANAGER, "/compact"]]);
      expect(createInterventionStore(home).list().map((entry) => [entry.kind, entry.trigger, entry.targetAgentId])).toEqual([["compact", "threshold.crossed", MANAGER]]);
      // Compactable, the Main is not handed over: the mission keeps it.
      expect(createMissionStore(home).get(made.mission.missionId)?.mainId).toBe(MANAGER);
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "a Manager's turn end",
    rpc: null,
    run: async () => turnEnded(managerEnded()),
  },
  {
    name: "a Worker's turn end",
    rpc: null,
    run: async () => turnEnded(workerEnded()),
  },
];

describe("REQ-079 (a-c), O-2 — across every Orchestrator path, no forbidden action happens", () => {
  for (const path of PATHS) {
    it(`${path.name}: no archive, cancel, stop, config write, creation, send, non-bm read or instruction write`, async () => {
      await path.run();

      expectBoundary({
        creates: path.creates ?? 0,
        ...(path.sendsTo === undefined ? {} : { sendsTo: path.sendsTo }),
        limits: path.limits === true,
        deliveries: path.deliveries === true,
        compaction: path.compaction === true,
        handoff: path.handoff === true,
      });
    });
  }

  it("covers every registered orchestrator.* RPC", () => {
    const covered = new Set(PATHS.map((path) => path.rpc).filter((rpc): rpc is string => rpc !== null));
    expect(host.names.filter((name) => !covered.has(name))).toEqual([]);
    expect(host.names.filter((name) => !name.startsWith("orchestrator."))).toEqual([]);
  });

  it("covers every tool of the Orchestrator's endpoint", () => {
    const covered = new Set(PATHS.map((path) => path.tool).filter((tool): tool is string => tool !== undefined));
    expect(tools.faces.map((face) => face.name).filter((name) => !covered.has(name))).toEqual([]);
  });
});

// ── O-4: nothing exists and nothing is spent before the user's click ────────

describe("O-4 — before the user opens the Orchestrator: no Orchestrator agent, no message, no token", () => {
  it("every other RPC, the stall pass over a stall, and every tool: 0 agents.create, 0 workspaces.open, 0 send, 0 enqueue", async () => {
    vi.useFakeTimers({ now: NOW });
    fake.table.get(WORKER)!.status = "idle";

    await expect(host.call("orchestrator.state", {})).resolves.toMatchObject({ agent: null });
    await expect(host.call("orchestrator.open-preview", {})).resolves.toMatchObject({ exists: false });
    await expect(host.call("orchestrator.open", {})).rejects.toThrow();
    stallWatcher.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await callTool("bm_projects", {});
    await callTool("bm_request", { workspaceId: WORKSPACE_ID, requestId: REQUEST_ID });
    await callTool("bm_agent_messages", { agentId: MANAGER });
    // No mission and no open danger: refused; a decision is only recorded.
    expect((await callTool("bm_govern", { missionId: "mis-0000000099", step: "nudge", text: "Re-plan." })).isError).toBe(true);
    await callTool("bm_ask_owner", { workspaceId: WORKSPACE_ID, question: "Delete the old invoices?", recommendation: "No." });
    expect((await callTool("bm_direct_worker", STOP)).isError).toBe(true);
    await callTool("bm_missions", {});
    expect((await callTool("bm_decide", { decisionId: `q:${REQUEST_ID}:Q1`, optionKey: "a", reason: "Nothing is asked yet." })).isError).toBe(true);
    await callTool("bm_note", { workspaceId: WORKSPACE_ID, text: "Nothing is open yet." });
    await callTool("bm_repo", { workspaceId: WORKSPACE_ID, action: "status" });
    await callTool("bm_why", { workspaceId: WORKSPACE_ID, bead: "bm-1" });
    await turnEnded(managerEnded());
    await turnEnded(workerEnded());
    stallWatcher.stop();

    expect([...fake.table.values()].filter((entry) => entry.provider.startsWith(ORCHESTRATOR_PROVIDER_ID))).toEqual([]);
    expect(createAlertStore(home).list({ open: true })).toMatchObject([{ kind: "request-stalled" }]);
    expect(vi.getTimerCount()).toBe(0);
    expectBoundary();
  });
});

// ── bm_repo never writes (design §6B.4, ADR-016 consequences) ───────────────

describe("bm_repo never writes: a real repository is byte for byte and time for time as it was", () => {
  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  /** Every file under `dir`, `.git` included, with its bytes and modification time. */
  function fingerprint(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      out[path] = `${statSync(path).mtimeMs}:${readFileSync(path).toString("base64")}`;
    }
    return out;
  }

  it.skipIf(!hasGit)("every action runs only status, diff, log, show or check-ignore, with the read-only prefix, and nothing in the repository changes", async () => {
    const gitIn = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: workspaceDir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "pipe",
      });
    gitIn("init", "-q", "-b", "main");
    gitIn("add", ".");
    gitIn("commit", "-q", "-m", "Plan the invoice date");
    writeFileSync(join(workspaceDir, "docs", "plans", "invoice-plan.md"), "# Invoice plan\n\nChanged.\n");
    gitIn("add", "docs/plans/invoice-plan.md");
    writeFileSync(join(workspaceDir, "notes.txt"), "not yet tracked\n");
    const calls: string[][] = [];
    const repoTools = createOrchestratorTools({
      env: { PASEO_BM_HOME: home },
      homedir: () => root,
      now: () => NOW,
      git: async (args, options) => {
        calls.push([...args]);
        return runGit(args, options);
      },
    });
    repoTools.usePaseo(fake.paseo);
    const beforeRepo = fingerprint(workspaceDir);

    const answers = [];
    for (const input of [
      { action: "status" },
      { action: "diff-stat" },
      { action: "log" },
      { action: "show", file: "HEAD:docs/plans/invoice-plan.md" },
      { action: "show", file: "notes.txt" },
      { action: "status", path: "docs" },
    ]) {
      answers.push(await repoTools.call("bm_repo", { workspaceId: WORKSPACE_ID, ...input }));
    }

    expect(answers.map((answer) => answer.ok)).toEqual([true, true, true, true, true, true]);
    expect(answers[1]!.text).toContain("Staged:\n docs/plans/invoice-plan.md");
    expect(answers[4]!.text).toContain("not yet tracked");
    expect(fingerprint(workspaceDir)).toEqual(beforeRepo);
    const readOnly = new Set(["status", "diff", "log", "show", "check-ignore"]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.slice(0, GIT_READ_ONLY_PREFIX.length)).toEqual(GIT_READ_ONLY_PREFIX);
      expect(readOnly.has(args[GIT_READ_ONLY_PREFIX.length]!)).toBe(true);
    }
    expect(fake.sends).toEqual([]);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
