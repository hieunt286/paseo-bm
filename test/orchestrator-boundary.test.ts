import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { answerOrchestrator } from "../plugin/server/agent-tools";
import { ORCHESTRATOR_PROVIDER_ID } from "../plugin/server/assessment";
import type { DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { noticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { registerOrchestratorRpcs, type OrchestratorRpcDeps } from "../plugin/server/orchestrator-rpc";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { GIT_READ_ONLY_PREFIX, createOrchestratorTools, runGit, type OrchestratorTools } from "../plugin/server/orchestrator-tools";
import type * as PaseoCli from "../plugin/server/paseo-cli";
import { setAgentLabels, setAgentMode } from "../plugin/server/paseo-cli";
import { extraHashOf } from "../plugin/server/role-extra-hash";
import type * as RoleExtras from "../plugin/server/role-extras";
import { ROLE_EXTRAS_FILE, readRoleExtras, saveRoleExtra } from "../plugin/server/role-extras";
import { forgetModes } from "../plugin/server/role-mode";
import { createStallWatcher, type StallWatcher } from "../plugin/server/stall-watcher";
import { createEventBus, type EventBus } from "../plugin/server/event-bus";
import { createAlertStore } from "../plugin/server/alert-store";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import type { AgentFacts } from "../plugin/server/traces";
import { ASSESSMENT_CRITERIA } from "../plugin/shared/bm-assessment";
import { effectsWithheldBy, commandBlockOf, limitsOf, parseCommandBlock, type CommandInput } from "../plugin/shared/orchestrator-command";
import { clearDecisionStoreCache, createDecisionStore } from "../plugin/server/decision-store";
import { handleDecisionsAnswer, settledByKind } from "../plugin/server/decision-rpc";
import { createOrchestratorDecisionDelivery } from "../plugin/server/orchestrator-decisions";
import { answerDecision, type Decision } from "../plugin/shared/decisions";
import type { TraceRecord } from "../plugin/shared/contracts";
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
 * (a Manager only for `bm_send_command` on Autopilot, right after the owner's
 * own message or on an answered decision's grant, for a prepared command the
 * owner picked, and for the copy of a `bm_direct_worker` command; a Worker only
 * for `bm_direct_worker` under the same authority; the Orchestrator only for
 * the event bus's `BM-EVENTS` of an Autopilot project and the owner's
 * `BM-ANSWER` (autonomy design §A.6, §A.8); never a Reviewer), any immediate send to a running Worker without an open danger
 * allowance, any timeline read of an agent that is not `bm-*`, and any use of
 * the Paseo CLI. A write of the role instructions is forbidden everywhere but
 * `orchestrator.apply-suggestion`. The recorded violations fail the test even
 * when the production code swallows the throw.
 *
 * | Item | Where it is proved |
 * |---|---|
 * | REQ-079 a, O-2: a Manager gets only the prepared command of an option the owner picked, or `bm_send_command`'s on Autopilot, right after the owner's own word in chat (ADR-015) or on a grant; a Worker, Reviewer or other agent nothing, whatever the mode | `PATHS` (`sendsTo`), the `bm_send_command` and decision paths |
 * | REQ-082 c, design §6B.1: every command the plugin delivers, sent now or queued, is a `BM-COMMAND` block from the Orchestrator and carries the limits field | `PATHS` (`limits`, checked on every path by `expectBoundary`) |
 * | REQ-084 a, ADR-016 decision 2: a direct Worker command only on the project's Autopilot or right after the owner's own word (never after a plugin notice, nor on another project's Autopilot), to a Worker only (never a Reviewer, Manager or other agent); every block a Worker gets is `to: worker`, and its Manager has the same block as a copy | the `bm_direct_worker` paths; `expectBoundary` checks the copy on every path |
 * | REQ-084 b: a running Worker's turn is replaced only while its danger allowance is open — not another Worker's, not an expired one | the spy's `send` (every path), the `bm_direct_worker` refusal and interrupt paths |
 * | REQ-085, design §6B.5: a gated command (body or subject) sends and records nothing, on `bm_send_command` and `bm_direct_worker`; an allowed category or a negated mention passes | the gate paths of `bm_send_command`, the `bm_direct_worker` refusal path |
 * | Design §6B.5 (coordination run F2): a stop naming the push passes the gate only to the Worker whose danger allowance is open, and only with a stop word | the `bm_direct_worker` "stopping a Worker's open danger" path |
 * | REQ-086 a: `bm_repo` stays in the project's folder and never writes | the `bm_repo` path, "bm_repo never writes" |
 * | REQ-083 a: the Worker watch refreshes and reads only running `bm-*` Workers of Autopilot projects — none with no Autopilot, none of a project whose Autopilot is off | "the live watch of running Workers" |
 * | REQ-079 b, REQ-115 b: the Orchestrator gets only `BM-EVENTS` (Autopilot project: a decision opened, a request finished or stalled, a Worker signal — batched) and `BM-ANSWER`; stalls and Worker signals are Inbox alerts, never messages | `PATHS` (`sendsTo`), "the event bus", "the stall pass" |
 * | Loop guard (design §6A): a 13th command for one request in 24 hours is refused and sends nothing | the `bm_send_command` loop-guard path |
 * | REQ-079 c: no stop, archive, delete, config write; instructions only through apply-suggestion | the spy + `expectBoundary` after every path |
 * | O-3: no Autopilot → no event and no message to the Orchestrator; a stall is only an Inbox alert | "the stall pass", "the event bus" |
 * | O-4: no Orchestrator agent and no send before the owner starts it | "O-4 — before the user opens the Orchestrator" |
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
  /** Set only around `orchestrator.apply-suggestion` (and the test's own seeding). */
  allowInstructionWrite: false,
  /** The role of every `saveRoleExtra` call, allowed or not. */
  instructionWrites: [] as string[],
}));

// The one place role instructions are written: allowed only while the test says so.
vi.mock("../plugin/server/role-extras", async (importOriginal) => {
  const actual = await importOriginal<typeof RoleExtras>();
  return {
    ...actual,
    saveRoleExtra: (...args: Parameters<typeof actual.saveRoleExtra>) => {
      boundary.instructionWrites.push(args[1]);
      if (!boundary.allowInstructionWrite) boundary.violations.push(`saveRoleExtra(${args[1]}) outside orchestrator.apply-suggestion`);
      return actual.saveRoleExtra(...args);
    },
  };
});

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
      timeline: [userMessage(options.prompt, T(30)), assistantMessage("I could not finish this assessment.", T(31))],
    });
    return guarded(`the assessment agent ${id}`, { id, current: () => ({ status: "idle" }) });
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
let before: { extras: string | null; workspace: Record<string, string>; data: Record<string, string> };

const location = () => ({ tracesDir: join(home, "traces") });
const extrasPath = () => join(home, ROLE_EXTRAS_FILE);
const extrasBytes = () => (existsSync(extrasPath()) ? readFileSync(extrasPath(), "utf8") : null);

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

/** paseo-bm's data folder outside its own stores: the role instructions and anything else kept there. */
const dataOutsideStores = () => snapshotDir(home, ["orchestrator", "traces", "decisions", "inbox"]);

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
  boundary.instructionWrites.length = 0;
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

  // Role instructions the user already wrote on Setup.
  boundary.allowInstructionWrite = true;
  saveRoleExtra(home, "manager", "Answer the user briefly.");
  saveRoleExtra(home, "worker", "Use pnpm.");
  boundary.allowInstructionWrite = false;
  boundary.instructionWrites.length = 0;

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
  // The endpoint's tools, wired as agent-tools.ts wires them: the handle comes from a hook or RPC context.
  tools = createOrchestratorTools({ env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW });
  tools.usePaseo(fake.paseo);
  enqueueSpy = vi.spyOn(noticeQueue, "enqueue");
  batchSpy = vi.spyOn(noticeQueue, "enqueueBatch");
  before = { extras: extrasBytes(), workspace: snapshotDir(workspaceDir), data: dataOutsideStores() };
});

afterEach(() => {
  stallWatcher.stop();
  const violations = [...boundary.violations];
  boundary.violations.length = 0;
  boundary.allowInstructionWrite = false;
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

/**
 * What must hold after any path: no forbidden call; no agent created; nothing
 * sent or queued, except — with `sendsTo` — one delivery or more, all to
 * those agents; every timeline read of a `bm-*` agent; the workspace (beads,
 * documents) untouched; the role instructions untouched unless `instructions`.
 */
function expectBoundary(options: { instructions?: boolean; creates?: number; sendsTo?: readonly string[]; limits?: boolean } = {}): void {
  expect(boundary.violations).toEqual([]);
  // REQ-082 c, design §6B.1, autonomy design §A.7: what reaches the Manager or the Worker, sent or still
  // queued, is a BM-COMMAND v2 block with its authority; it carries the limits its approval leaves when the
  // Orchestrator decided it — never one that withholds an approved effect — and none when the owner typed it.
  const toWorking = [MANAGER, WORKER].flatMap((id) => [
    ...fake.sends.filter((sent) => sent.id === id).map((sent) => sent.text),
    ...noticeQueue.pending(id).map((queued) => queued.text),
  ]);
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
    [...fake.sends.filter((sent) => sent.id === id).map((sent) => sent.text), ...noticeQueue.pending(id).map((queued) => queued.text)].map(
      (text) => parseCommandBlock(text)!,
    );
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
  if (options.instructions === true) {
    expect(boundary.instructionWrites).toEqual(["worker"]);
  } else {
    expect(boundary.instructionWrites).toEqual([]);
    expect(extrasBytes()).toBe(before.extras);
    expect(dataOutsideStores()).toEqual(before.data);
  }
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
    ["writing role instructions outside apply-suggestion", () => saveRoleExtra(home, "worker", "Always create beads.")],
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

describe("the stall pass: a stalled request is an Inbox alert, never a message outside Autopilot (autonomy design §A.8)", () => {
  it("a stalled request, an open Orchestrator, no Autopilot and thirty minutes of passes: one alert, 0 enqueue, 0 send", async () => {
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

// ── Autopilot events (design §6A) ───────────────────────────────────────────

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

describe("the event bus: only BM-EVENTS, only to the Orchestrator, only for an Autopilot project (autonomy design §A.8)", () => {
  it("no Autopilot: a new question and a finished step send nothing and start no timer", async () => {
    vi.useFakeTimers({ now: NOW });
    seedOrchestrator();
    await expect(eventBus.turnRecorded(finishedManagerRecord(), [openQuestion()], fake.paseo)).resolves.toMatchObject({ status: "none", published: [] });
    await turnEnded(managerEnded());
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(vi.getTimerCount()).toBe(0);
    expectBoundary();
  });

  it("Autopilot on: a question and a finished step reach the Orchestrator as one BM-EVENTS message, once; set-autopilot itself sends nothing", async () => {
    vi.useFakeTimers({ now: NOW });
    seedOrchestrator();
    fake.policy.sendTo.add(ORCHESTRATOR_ID);
    await host.call("orchestrator.set-autopilot", { workspaceId: WORKSPACE_ID, enabled: true, confirmed: true });
    expect(fake.sends).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    const first = await eventBus.turnRecorded(finishedManagerRecord(), [openQuestion()], fake.paseo);
    expect(first.published).toEqual([`decision.opened:q:${REQUEST_ID}:Q1`, `request.finished:${WORKSPACE_ID}:${REQUEST_ID}@${at(8)}`]);
    // The same turn recorded again: nothing new.
    await expect(eventBus.turnRecorded(finishedManagerRecord(), [openQuestion()], fake.paseo)).resolves.toMatchObject({ published: [] });
    await turnEnded(managerEnded());
    await turnEnded(workerEnded());

    expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text)])).toEqual([[ORCHESTRATOR_ID, "BM-EVENTS"]]);
    expect(fake.sends[0]!.text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    expectBoundary({ sendsTo: [ORCHESTRATOR_ID] });
  });

  it("a Worker's turn is never a request.finished event, and a Manager turn without a report is no event at all (a Manager's turn wakes nobody)", async () => {
    seedOrchestrator();
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    fake.table.get(WORKER)!.status = "idle";
    fake.table.get(REVIEWER)!.status = "idle";
    await expect(eventBus.turnRecorded({ ...finishedManagerRecord(), agentId: WORKER, role: "worker" }, [], fake.paseo)).resolves.toMatchObject({ status: "none" });
    await expect(eventBus.turnRecorded(askingManagerRecord(), [], fake.paseo)).resolves.toMatchObject({ status: "none" });
    expectBoundary();
  });

  it("Autopilot on for another project only: this project's question sends nothing", async () => {
    seedOrchestrator();
    createOrchestratorStore(home).setAutopilot("wks-other", true, "tab");
    await expect(eventBus.turnRecorded(undefined, [openQuestion()], fake.paseo)).resolves.toMatchObject({ status: "none" });
    await turnEnded(managerEnded());
    expectBoundary();
  });

  it("Autopilot on but no Orchestrator: nothing is queued, sent or created (O-4)", async () => {
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    await expect(eventBus.turnRecorded(finishedManagerRecord(), [openQuestion()], fake.paseo)).resolves.toMatchObject({ status: "no-orchestrator" });
    expect(fake.creates).toEqual([]);
    expectBoundary();
  });
});

// ── The live watch of running Workers (design §6B.3, ADR-016) ──────────────

describe("the live watch of running Workers (design §6B.3)", () => {
  it("no Autopilot: the timer runs for stalls, and no agent's timeline is ever read", async () => {
    vi.useFakeTimers({ now: NOW });
    fake.table.get(WORKER)!.turnStartedAt = T(0);
    fake.table.get(WORKER)!.timeline.push(shellCall("git push origin main", T(2)));

    stallWatcher.usePaseo(fake.paseo);
    stallWatcher.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await expect(stallWatcher.workerPass()).resolves.toMatchObject({ status: "off", watched: [] });
    stallWatcher.stop();

    expect(fake.reads).toEqual([]);
    expect(fake.refreshes).toEqual([]);
    expect(createAlertStore(home).list({ kinds: ["stuck", "danger", "permission-waiting"] })).toEqual([]);
    expect(createOrchestratorStore(home).listDangerAllowances()).toEqual([]);
    expectBoundary();
  });

  it("Autopilot on for another project only: this project's running Worker is neither refreshed nor read, and nothing is raised", async () => {
    seedOrchestrator();
    fake.table.get(WORKER)!.turnStartedAt = T(0);
    fake.table.get(WORKER)!.timeline.push(shellCall("git push origin main", T(2)));
    createOrchestratorStore(home).setAutopilot("wks-other", true, "tab");
    stallWatcher.usePaseo(fake.paseo);

    await expect(stallWatcher.workerPass()).resolves.toMatchObject({ status: "done", watched: [], raised: [] });

    expect(fake.reads).toEqual([]);
    expect(fake.refreshes).toEqual([]);
    expect(createAlertStore(home).list()).toEqual([]);
    expect(createOrchestratorStore(home).listDangerAllowances()).toEqual([]);
    expectBoundary();
  });

  it("Autopilot on: a running Worker's signals reach the Orchestrator only, as one BM-EVENTS message, once per turn; only that bm-* Worker's timeline is read", async () => {
    seedOrchestrator();
    fake.policy.sendTo.add(ORCHESTRATOR_ID);
    // The Worker, running since T(0), pushes; the request is Small and it ran `br create` (liveSlip).
    fake.table.get(WORKER)!.turnStartedAt = T(0);
    fake.table.get(WORKER)!.timeline.push(shellCall("git push origin main", T(2)));
    // The stranger the Worker created is running too, and pushes: not paseo-bm's, never read.
    fake.table.get(STRANGER)!.turnStartedAt = T(0);
    fake.table.get(STRANGER)!.timeline.push(shellCall("git push origin main", T(2)));
    createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
    stallWatcher.usePaseo(fake.paseo);

    const first = await stallWatcher.workerPass();
    expect(first).toMatchObject({ status: "done", watched: [WORKER], allowances: [WORKER] });
    // NOW is the next day: the newest entry is hours old, so `stuck` holds too. `heavy` is an event, not an alert.
    expect(first.events.map((event) => (event.type === "worker.signal" ? event.signal : event.type))).toEqual(["stuck", "danger", "heavy"]);
    expect(first.raised.map((key) => key.split(":")[0])).toEqual(["stuck", "danger"]);
    await expect(stallWatcher.workerPass()).resolves.toMatchObject({ raised: [], allowances: [] });

    expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text)])).toEqual([[ORCHESTRATOR_ID, "BM-EVENTS"]]);
    expect(fake.sends[0]!.text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(" — ")[0])).toEqual([
      "- worker.signal stuck",
      "- worker.signal danger",
      "- worker.signal heavy",
    ]);
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
  /** The path writes the Worker's Additional instructions (apply-suggestion). */
  instructions?: boolean;
  /** The bm-orchestrator agents the path creates (orchestrator.open with confirmed: true). */
  creates?: number;
  /** The only agents the path may send to: a Manager (bm_send_command, a prepared command, a direct command's copy), a Worker (bm_direct_worker) or the Orchestrator (BM-EVENTS, BM-ANSWER). */
  sendsTo?: readonly string[];
  /** What the path sends the Manager or the Worker is the Orchestrator's (its tools, or a command it prepared): each block carries the limits. Otherwise none does. */
  limits?: boolean;
  run(): Promise<void>;
}

const ORCHESTRATOR_ID = "agent-orchestrator-main";

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

/** `decisions.answer` as the Inbox calls it, with the plugin's delivery of Orchestrator decisions. */
function answerDecisionRpc(input: Parameters<typeof handleDecisionsAnswer>[0]) {
  return handleDecisionsAnswer(input, fake.paseo, { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => NOW, onSettled: settledByKind({ orchestrator: orchestratorDelivery() }) });
}

/** A workflow assessment as the Orchestrator sends it to `bm_assessment`. */
const ASSESSMENT = {
  rubric: ASSESSMENT_CRITERIA.map((criterion) => ({ criterion, score: 4, note: `Note on ${criterion}.` })),
  findings: [{ severity: "warning", text: "Beads for a Small request.", evidence: "br create after tier: Small" }],
  suggestions: [{ role: "worker", text: "A Small request gets no bead.", why: "The beads finding." }],
};

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
const EVENTS_NOTICE = `BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event of projects with Autopilot on, oldest first.\n- request.stalled idle-unfinished — project ${WORKSPACE_ID}, request ${REQUEST_ID}, since ${at(3)}. Look with bm_request.`;
/** A plugin notice in the Orchestrator's chat: the notice queue sends through the app's path, so it carries one too. */
const pluginNotice = (text: string, when: string): Entry => ({ item: { type: "user_message", text, clientMessageId: `n-${when}` }, timestamp: when });
/** What `bm_send_command` asks the Manager for, in the boundary paths. */
const SEND = { workspaceId: WORKSPACE_ID, managerId: MANAGER, requestId: REQUEST_ID, intent: "continue", effects: ["none"], command: "Continue with Q2.", reason: "Nobody runs." };
/** The block `bm_send_command` delivers for `SEND` (design §6B.1, autonomy design §A.7): the Orchestrator's, with its limits. */
const sendBlock = (overrides: Partial<CommandInput> = {}) =>
  commandBlockOf({ from: "orchestrator", via: "autopilot", to: "manager", requestId: REQUEST_ID, re: SEND.command, body: SEND.command, why: SEND.reason, intent: "continue", ...overrides });
/** What `bm_direct_worker` asks the running Worker, in the boundary paths. */
const DIRECT = {
  workspaceId: WORKSPACE_ID,
  workerId: WORKER,
  requestId: REQUEST_ID,
  re: "answer to Q1",
  intent: "answer",
  effects: ["none"],
  command: "BM-ANSWERS\nQ1: use dd/mm/yyyy.",
  why: "The owner chose it.",
};
const directBlock = (overrides: Partial<CommandInput> = {}) =>
  commandBlockOf({ from: "orchestrator", via: "autopilot", to: "worker", requestId: REQUEST_ID, re: DIRECT.re, body: DIRECT.command, why: DIRECT.why, intent: "answer", ...overrides });
/** The refusal of a text that shows a release the command does not declare (autonomy design §A.7). */
const RELEASE_UNDECLARED = "the text shows release (push, publish or deploy) that effects does not declare: declare the effect or ask the owner with bm_ask_owner";

const PATHS: BoundaryPath[] = [
  {
    name: "orchestrator.apply-suggestion with confirmed: true",
    rpc: "orchestrator.apply-suggestion",
    instructions: true,
    run: async () => {
      const expectedHash = extraHashOf(readRoleExtras(home).worker);
      boundary.allowInstructionWrite = true;
      await host.call("orchestrator.apply-suggestion", {
        role: "worker",
        text: "Keep a Small request free of beads.",
        expectedHash,
        confirmed: true,
      });
      boundary.allowInstructionWrite = false;
      expect(readRoleExtras(home).worker).toBe("Use pnpm.\n\nKeep a Small request free of beads.");
      expect(readRoleExtras(home).manager).toBe("Answer the user briefly.");
    },
  },
  {
    name: "orchestrator.apply-suggestion without confirmed: true",
    rpc: "orchestrator.apply-suggestion",
    run: async () => {
      const expectedHash = extraHashOf(readRoleExtras(home).worker);
      await expect(
        host.call("orchestrator.apply-suggestion", { role: "worker", text: "Keep a Small request free of beads.", expectedHash }),
      ).rejects.toThrow();
    },
  },
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
    name: "orchestrator.set-autopilot: on without confirmed, then on and off; nobody is woken, no timer is started",
    rpc: "orchestrator.set-autopilot",
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      seedOrchestrator();
      fake.policy.sendTo.add(ORCHESTRATOR_ID);
      await expect(host.call("orchestrator.set-autopilot", { workspaceId: WORKSPACE_ID, enabled: true })).rejects.toThrow(/E_AUTOPILOT_NOT_CONFIRMED/);
      await expect(host.call("orchestrator.set-autopilot", { workspaceId: WORKSPACE_ID, enabled: true, confirmed: true })).resolves.toMatchObject({
        autopilot: true,
      });
      expect(createOrchestratorStore(home).isAutopilot(WORKSPACE_ID)).toBe(true);
      await expect(host.call("orchestrator.set-autopilot", { workspaceId: WORKSPACE_ID, enabled: false })).resolves.toMatchObject({ autopilot: false });
      // Turning Autopilot on wakes nobody (autonomy design §A.8): the project's events follow in BM-EVENTS.
      expect(fake.sends).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  },
  {
    name: "the stall pass without Autopilot: an Inbox alert, nobody woken",
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
    name: "the stall pass with Autopilot on tells the Orchestrator only, once, in BM-EVENTS",
    rpc: null,
    sendsTo: [ORCHESTRATOR_ID],
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      seedOrchestrator();
      fake.table.get(WORKER)!.status = "idle";
      fake.policy.sendTo.add(ORCHESTRATOR_ID);
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      stallWatcher.usePaseo(fake.paseo);
      stallWatcher.start();
      await vi.advanceTimersByTimeAsync(60 * 1000);
      fake.table.get(ORCHESTRATOR_ID)!.status = "idle";
      await vi.advanceTimersByTimeAsync(60 * 1000);
      stallWatcher.stop();
      expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text)])).toEqual([[ORCHESTRATOR_ID, "BM-EVENTS"]]);
      expect(fake.sends[0]!.text).toContain(`- request.stalled idle-unfinished — project ${WORKSPACE_ID}, request ${REQUEST_ID}`);
      expect(fake.reads.filter((id) => id !== ORCHESTRATOR_ID)).toEqual([]);
    },
  },
  {
    name: "the stall pass with Autopilot on replaces an outdated Orchestrator with exactly one bm-orchestrator agent, and tells only the new one",
    rpc: null,
    creates: 1,
    sendsTo: ["agent-orchestrator-1"],
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      // Opened before its instructions were labelled: Paseo keeps the old system prompt (design §3.3).
      seedOrchestrator([], { "bm.role": "orchestrator", "bm.orchestrator": "main" });
      fake.table.get(WORKER)!.status = "idle";
      fake.policy.create = true;
      fake.policy.sendTo.add("agent-orchestrator-1");
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      stallWatcher.usePaseo(fake.paseo);
      stallWatcher.start();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      stallWatcher.stop();
      expect(fake.creates).toHaveLength(1);
      expect(fake.creates[0]!.config.provider.split("/")[0]).toBe(ORCHESTRATOR_PROVIDER_ID);
      expect(fake.creates[0]!.labels).toMatchObject(CURRENT_ORCHESTRATOR_LABELS);
      expect(fake.sends.map((sent) => [sent.id, firstLine(sent.text)])).toEqual([["agent-orchestrator-1", "BM-EVENTS"]]);
      // The old one stays: not archived, not messaged.
      expect(fake.table.get(ORCHESTRATOR_ID)!.archivedAt).toBeNull();
    },
  },
  {
    name: "the stall pass with Autopilot on and no Orchestrator: the alert is kept, nothing is sent",
    rpc: null,
    run: async () => {
      vi.useFakeTimers({ now: NOW });
      fake.table.get(WORKER)!.status = "idle";
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
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
    name: "tool bm_send_command is refused without Autopilot and the owner's word, right after a plugin notice, and to a Worker or Reviewer even on Autopilot",
    rpc: null,
    tool: "bm_send_command",
    run: async () => {
      // No Orchestrator, then one whose latest inbound message is the plugin's BM-EVENTS after the owner's word.
      expect(await callTool("bm_send_command", SEND)).toMatchObject({ isError: true, text: expect.stringContaining("Autopilot is off for this project") });
      seedOrchestrator([ownerMessage("Send it.", T(0)), assistantMessage("Proposed.", T(1)), pluginNotice(EVENTS_NOTICE, T(2))]);
      expect(await callTool("bm_send_command", SEND)).toMatchObject({ isError: true, text: expect.stringContaining("Autopilot is off for this project") });
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      for (const target of [WORKER, REVIEWER, ORCHESTRATOR_ID, STRANGER]) {
        expect(await callTool("bm_send_command", { ...SEND, managerId: target })).toMatchObject({ isError: true, text: expect.stringContaining("is not a paseo-bm Manager") });
      }
      expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_send_command on Autopilot sends to that Manager only, a BM-COMMAND block with the limits",
    rpc: null,
    tool: "bm_send_command",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      fake.policy.sendTo.add(MANAGER);
      expect((await callTool("bm_send_command", SEND)).isError).toBe(false);
      expect(fake.sends).toEqual([{ id: MANAGER, text: sendBlock() }]);
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ managerId: MANAGER, source: "autopilot" }]);
    },
  },
  {
    name: "tool bm_send_command right after the owner's own message sends to that Manager only, recorded with source chat",
    rpc: null,
    tool: "bm_send_command",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      seedOrchestrator([pluginNotice(EVENTS_NOTICE, T(0)), assistantMessage("Q1 waits for you.", T(1)), ownerMessage("Chốt dd/mm/yyyy, gửi đi.", T(2))]);
      fake.policy.sendTo.add(MANAGER);
      expect((await callTool("bm_send_command", { ...SEND, re: "answer to Q1", command: "Q1: use dd/mm/yyyy." })).isError).toBe(false);
      expect(fake.sends).toEqual([{ id: MANAGER, text: sendBlock({ via: "chat", re: "answer to Q1", body: "Q1: use dd/mm/yyyy." }) }]);
      expect(allCommands()).toMatchObject([{ status: "sent", source: "chat" }]);
      // Only the Orchestrator's own chat was read for the check; no Worker, Reviewer or stranger.
      expect(fake.reads).toEqual([ORCHESTRATOR_ID]);
    },
  },
  {
    name: "tool bm_send_command on Autopilot to a running Manager: queued, delivered at that Manager's turn end only",
    rpc: null,
    tool: "bm_send_command",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      fake.table.get(MANAGER)!.status = "running";
      const answer = await callTool("bm_send_command", SEND);
      expect(answer).toMatchObject({ isError: false, text: expect.stringMatching(/^Queued\./) });
      expect(fake.sends).toEqual([]);
      await turnEnded(workerEnded());
      expect(fake.sends).toEqual([]);
      fake.table.get(MANAGER)!.status = "idle";
      fake.policy.sendTo.add(MANAGER);
      await turnEnded(managerEnded());
      expect(fake.sends).toEqual([{ id: MANAGER, text: sendBlock() }]);
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ source: "autopilot", outcome: "queued" }]);
    },
  },
  {
    name: "tool bm_send_command with Autopilot on for another project only, and a plugin notice after the owner's word: refused",
    rpc: null,
    tool: "bm_send_command",
    run: async () => {
      createOrchestratorStore(home).setAutopilot("wks-other", true, "tab");
      // The owner spoke, but the Orchestrator's latest inbound message is the plugin's: not the owner's word.
      seedOrchestrator([ownerMessage("Send it.", T(0)), pluginNotice(EVENTS_NOTICE, T(1)), assistantMessage("Proposed.", T(2))]);
      expect(await callTool("bm_send_command", SEND)).toMatchObject({ isError: true, text: expect.stringContaining("Autopilot is off for this project") });
      expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_direct_worker is refused without Autopilot and the owner's word, to a Reviewer, a Manager or another agent even on Autopilot, on a big decision, and for an interrupt with no open danger",
    rpc: null,
    tool: "bm_direct_worker",
    run: async () => {
      expect(await callTool("bm_direct_worker", DIRECT)).toMatchObject({ isError: true, text: expect.stringContaining("Autopilot is off for this project") });
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      for (const target of [REVIEWER, MANAGER, STRANGER]) {
        expect(await callTool("bm_direct_worker", { ...DIRECT, workerId: target })).toMatchObject({ isError: true, text: expect.stringContaining("is not a paseo-bm Worker") });
      }
      expect(await callTool("bm_direct_worker", { ...DIRECT, command: "Deploy it to production now." })).toMatchObject({
        isError: true,
        text: expect.stringContaining(RELEASE_UNDECLARED),
      });
      // Declared, the deploy still needs the owner's decision: Autopilot does not cover it.
      expect(await callTool("bm_direct_worker", { ...DIRECT, intent: "release", effects: ["deploy"], command: "Deploy it to production now." })).toMatchObject({
        isError: true,
        text: expect.stringContaining("deploy needs the owner's decision"),
      });
      expect(await callTool("bm_direct_worker", { ...DIRECT, interrupt: true })).toMatchObject({
        isError: true,
        text: expect.stringContaining("interrupt is allowed only while a danger signal of this Worker is open"),
      });
      // An allowance of another Worker, or one opened more than 10 minutes ago, allows no interrupt either.
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, "agent-worker-other");
      createOrchestratorStore(home, { now: () => new Date(Date.now() - 11 * 60 * 1000) }).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(createOrchestratorStore(home).isDangerOpen(WORKSPACE_ID, WORKER)).toBe(false);
      expect(await callTool("bm_direct_worker", { ...DIRECT, interrupt: true })).toMatchObject({
        isError: true,
        text: expect.stringContaining("interrupt is allowed only while a danger signal of this Worker is open"),
      });
      expect(createOrchestratorStore(home).listCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_direct_worker with Autopilot off: refused right after a plugin notice, and with Autopilot on for another project only",
    rpc: null,
    tool: "bm_direct_worker",
    run: async () => {
      createOrchestratorStore(home).setAutopilot("wks-other", true, "tab");
      // The owner spoke, but the latest inbound message is the plugin's Worker signal: not the owner's word.
      seedOrchestrator([ownerMessage("Handle it.", T(0)), pluginNotice(EVENTS_NOTICE, T(1))]);
      expect(await callTool("bm_direct_worker", DIRECT)).toMatchObject({ isError: true, text: expect.stringContaining("Autopilot is off for this project") });
      expect(allCommands()).toEqual([]);
      expect(fake.reads).toEqual([ORCHESTRATOR_ID]);
    },
  },
  {
    name: "tool bm_direct_worker right after the owner's own message, Autopilot off: queued for the Worker, the copy to its Manager, via chat",
    rpc: null,
    tool: "bm_direct_worker",
    sendsTo: [WORKER, MANAGER],
    limits: true,
    run: async () => {
      seedOrchestrator([pluginNotice(EVENTS_NOTICE, T(0)), ownerMessage("Tell the Worker to stop retrying the test.", T(1))]);
      fake.policy.sendTo.add(MANAGER);
      const stop = { ...DIRECT, re: "stop retrying", command: "Stop re-running the failing test; report what fails." };
      expect(await callTool("bm_direct_worker", stop)).toMatchObject({ isError: false, text: expect.stringMatching(/^Queued\./) });
      expect(fake.sends).toEqual([{ id: MANAGER, text: directBlock({ via: "chat", re: stop.re, body: stop.command, copy: true }) }]);
      expect(noticeQueue.pending(WORKER).map((queued) => queued.text)).toEqual([directBlock({ via: "chat", re: stop.re, body: stop.command })]);
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ to: "worker", workerId: WORKER, managerId: MANAGER, source: "chat" }]);
      // Only the Orchestrator's own chat was read for the check.
      expect(fake.reads).toEqual([ORCHESTRATOR_ID]);
    },
  },
  {
    name: "tool bm_send_command whose text shows an undeclared effect: refused by the backstop, nothing sent or recorded, no decision made for the Orchestrator",
    rpc: null,
    tool: "bm_send_command",
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      // Allowing one category leaves the others gated.
      createOrchestratorStore(home).setAutopilotAllow(WORKSPACE_ID, ["cost"]);
      for (const command of ["Push the fix to main.", "Run the migration on the real data.", "Rotate the API token.", "npm install left-pad"]) {
        expect(await callTool("bm_send_command", { ...SEND, command })).toMatchObject({ isError: true, text: expect.stringContaining("declare the effect or ask the owner") });
      }
      // The subject is checked too, not only the body.
      expect(await callTool("bm_send_command", { ...SEND, re: "deploy it" })).toMatchObject({ isError: true, text: expect.stringContaining(RELEASE_UNDECLARED) });
      expect(allCommands()).toEqual([]);
    },
  },
  {
    name: "tool bm_send_command with the category allowed, or the mention negated: sent to that Manager only, with the limits",
    rpc: null,
    tool: "bm_send_command",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      createOrchestratorStore(home).setAutopilotAllow(WORKSPACE_ID, ["release"]);
      fake.policy.sendTo.add(MANAGER);
      expect((await callTool("bm_send_command", { ...SEND, command: "Push the fix branch." })).isError).toBe(false);
      expect((await callTool("bm_send_command", { ...SEND, requestId: "req-20260926T110000Z", command: "Do not touch the real data; fix the parser." })).isError).toBe(
        false,
      );
      expect(fake.sends.map((sent) => parseCommandBlock(sent.text)!.body)).toEqual(["Push the fix branch.", "Do not touch the real data; fix the parser."]);
    },
  },
  {
    name: "tool bm_send_command on the grant of the owner's answered push decision (replay of 2026-09-29): one command to that Manager, approved: push, the grant spent, no second question",
    rpc: null,
    tool: "bm_send_command",
    sendsTo: [MANAGER],
    limits: true,
    run: async () => {
      clearDecisionStoreCache();
      const decisionId = "o:replay-20260929-push";
      createDecisionStore(home).open({
        id: decisionId,
        workspaceId: WORKSPACE_ID,
        requestId: REQUEST_ID,
        askedBy: { role: "orchestrator", agentId: ORCHESTRATOR_ID },
        askedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        round: null,
        question: "Push the date fix to origin/dev?",
        subject: "push-date-fix",
        options: [
          { key: "a", label: "Push it", recommended: true, effects: ["push"] },
          { key: "b", label: "Hold", recommended: false, effects: ["none"] },
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
      // The owner answers in words; the plugin hands the answer to the Orchestrator, so its latest inbound message is a notice, not the owner's word.
      const answered = createDecisionStore(home).transition(decisionId, (decision) =>
        answerDecision(decision, { via: "inbox", words: "Yes, push it to origin/dev.", at: new Date(NOW.getTime() - 5 * 60_000).toISOString() }),
      );
      expect(answered).toMatchObject({ status: "updated", decision: { grant: { effects: ["push"], usedAt: null } } });
      seedOrchestrator([pluginNotice(`BM-ANSWER\ndecisionId: ${decisionId}`, T(0))]);
      fake.policy.sendTo.add(MANAGER);
      const push = { ...SEND, decisionId, intent: "release", effects: ["push"], command: "Push the date fix to origin/dev.", reason: "The owner answered the push decision." };

      expect((await callTool("bm_send_command", push)).isError).toBe(false);
      expect(fake.sends).toHaveLength(1);
      expect(parseCommandBlock(fake.sends[0]!.text)).toMatchObject({
        from: "orchestrator",
        to: "manager",
        intent: "release",
        authority: `decision:${decisionId}`,
        approved: ["push"],
        limits: ["no-commit", "no-deploy", "no-real-data"],
      });
      expect(createDecisionStore(home).get(decisionId, WORKSPACE_ID)!.grant!.usedAt).toBe(NOW.toISOString());
      // One use: the same command again is refused; nothing asked the owner a second time.
      expect(await callTool("bm_send_command", push)).toMatchObject({ isError: true, text: expect.stringContaining("was used at") });
      expect(fake.sends).toHaveLength(1);
    },
  },
  {
    name: "tool bm_direct_worker on Autopilot: queued for the running Worker, a copy to its Manager, each delivered at its own idle moment",
    rpc: null,
    tool: "bm_direct_worker",
    sendsTo: [WORKER, MANAGER],
    limits: true,
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      fake.policy.sendTo.add(MANAGER);
      expect(await callTool("bm_direct_worker", DIRECT)).toMatchObject({ isError: false, text: expect.stringMatching(/^Queued\./) });
      // The Manager is idle: its copy goes now. The Worker runs: its command waits for its turn end.
      expect(fake.sends).toEqual([{ id: MANAGER, text: directBlock({ copy: true }) }]);
      await turnEnded(managerEnded());
      expect(fake.sends).toHaveLength(1);
      fake.table.get(WORKER)!.status = "idle";
      fake.policy.sendTo.add(WORKER);
      await turnEnded(workerEnded());
      expect(fake.sends).toEqual([
        { id: MANAGER, text: directBlock({ copy: true }) },
        { id: WORKER, text: directBlock() },
      ]);
      expect(createOrchestratorStore(home).listCommands()).toMatchObject([{ to: "worker", workerId: WORKER, managerId: MANAGER, source: "autopilot", outcome: "queued" }]);
    },
  },
  {
    name: "tool bm_direct_worker with interrupt while the Worker's danger allowance is open: sent at once to that Worker, the copy to its Manager",
    rpc: null,
    tool: "bm_direct_worker",
    sendsTo: [WORKER, MANAGER],
    limits: true,
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      fake.policy.sendTo.add(WORKER);
      fake.policy.sendTo.add(MANAGER);
      const stop = { ...DIRECT, re: "stop at once", command: "Stop. Do not push; wait for the owner.", interrupt: true };
      expect((await callTool("bm_direct_worker", stop)).isError).toBe(false);
      expect(fake.sends).toEqual([
        { id: WORKER, text: directBlock({ re: stop.re, body: stop.command }) },
        { id: MANAGER, text: directBlock({ re: stop.re, body: stop.command, copy: true }) },
      ]);
    },
  },
  {
    name: "tool bm_direct_worker stopping a Worker's open danger: the stop that names the push passes to that Worker only; without its allowance, to another Worker, or with no stop word it is refused",
    rpc: null,
    tool: "bm_direct_worker",
    sendsTo: [WORKER, MANAGER],
    limits: true,
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      const second = "agent-worker-second";
      fake.table.set(second, fakeAgentOf(agent({ id: second, role: "worker", status: "running", parentAgentId: MANAGER, createdAt: at(3) })));
      // The stop the gate held in the coordination run of 2026-09-29 (F2): it names the push it stops.
      const stop = {
        ...DIRECT,
        re: "stop and report",
        command: "Stop what you are doing now: run no more git push and no more waits. Send your report: how many git push runs you made.",
        intent: "stop",
        interrupt: true,
      };
      const gated = { isError: true, text: expect.stringContaining(RELEASE_UNDECLARED) };
      // No open danger: gated like any command.
      expect(await callTool("bm_direct_worker", { ...stop, interrupt: false })).toMatchObject(gated);
      // This Worker's open danger exempts no stop to another Worker.
      createOrchestratorStore(home).openDangerAllowance(WORKSPACE_ID, WORKER);
      expect(await callTool("bm_direct_worker", { ...stop, workerId: second, interrupt: false })).toMatchObject(gated);
      // A command without a stop word is gated even while the danger is open.
      expect(await callTool("bm_direct_worker", { ...stop, re: "push again", command: "Push the branch once more and report." })).toMatchObject(gated);
      expect(fake.sends).toEqual([]);
      expect(allCommands()).toEqual([]);

      fake.policy.sendTo.add(WORKER);
      fake.policy.sendTo.add(MANAGER);
      expect((await callTool("bm_direct_worker", stop)).isError).toBe(false);
      expect(fake.sends).toEqual([
        { id: WORKER, text: directBlock({ re: stop.re, body: stop.command, intent: "stop" }) },
        { id: MANAGER, text: directBlock({ re: stop.re, body: stop.command, intent: "stop", copy: true }) },
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
    name: "the owner picks an Orchestrator option with a prepared command: one command to that Manager, approved = the option's effects, the grant spent once",
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
      expect(answered.decision).toMatchObject({ grant: { effects: ["push"], usedAt: NOW.toISOString() }, delivery: { to: MANAGER } });
      const blocks = [...fake.sends.filter((sent) => sent.id === MANAGER).map((sent) => sent.text), ...noticeQueue.pending(MANAGER).map((queued) => queued.text)].map(
        (text) => parseCommandBlock(text)!,
      );
      expect(blocks).toMatchObject([{ to: "manager", authority: `decision:${decisionId}`, effects: ["push"], approved: ["push"], limits: ["no-commit", "no-deploy", "no-real-data"] }]);
      // Handed over again, it is not delivered twice.
      await orchestratorDelivery()([createDecisionStore(home).get(decisionId)!], { paseo: fake.paseo });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
    },
  },
  {
    name: "the owner answers an Orchestrator decision in words: only the Orchestrator gets BM-ANSWER, with the grant",
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
      expect(told[0]).toContain("grant: push, for one command");
      expect(createDecisionStore(home).get(decisionId)!.grant).toMatchObject({ effects: ["push"], usedAt: null });
    },
  },
  {
    name: "a stored prepared command naming a Reviewer is never delivered: nothing to the Reviewer, the grant unused, the Orchestrator told",
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
      expect(answered.decision).toMatchObject({ grant: { effects: ["commit"], usedAt: null }, delivery: { to: REVIEWER, outcome: "failed" } });
      expect(enqueueSpy.mock.calls.map(([target]) => target)).toEqual([ORCHESTRATOR_ID]);
    },
  },
  {
    name: "tool bm_set_autopilot is refused without the owner's word, and turns Autopilot on after it; nobody is woken",
    rpc: null,
    tool: "bm_set_autopilot",
    run: async () => {
      seedOrchestrator([ownerMessage("Take over invoice-app.", T(0)), pluginNotice(EVENTS_NOTICE, T(1))]);
      fake.policy.sendTo.add(ORCHESTRATOR_ID);
      expect((await callTool("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: true })).isError).toBe(true);
      expect(createOrchestratorStore(home).isAutopilot(WORKSPACE_ID)).toBe(false);
      fake.table.get(ORCHESTRATOR_ID)!.timeline.push(ownerMessage("Take over invoice-app.", T(2)));
      expect((await callTool("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: true })).isError).toBe(false);
      expect(createOrchestratorStore(home).readSettings().autopilot[WORKSPACE_ID]).toMatchObject({ by: "chat" });
      expect(fake.sends).toEqual([]);
    },
  },
  {
    name: "tool bm_send_command at the loop guard: refused, nothing sent or recorded",
    rpc: null,
    tool: "bm_send_command",
    run: async () => {
      createOrchestratorStore(home).setAutopilot(WORKSPACE_ID, true, "tab");
      const store = createOrchestratorStore(home, { now: () => new Date(NOW.getTime() - 3_600_000) });
      for (let index = 0; index < 12; index += 1) {
        store.appendCommand({ workspaceId: SEND.workspaceId, managerId: SEND.managerId, requestId: SEND.requestId, command: SEND.command, reason: SEND.reason, situation: "", source: "autopilot", sentText: "Continue.", outcome: "sent" });
      }
      const refused = await callTool("bm_send_command", SEND);
      expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("Autopilot limit reached for this request; ask the owner with bm_ask_owner") });
      expect(createOrchestratorStore(home).listCommands()).toHaveLength(12);
    },
  },
  {
    name: "tool bm_assessment records the workflow assessment and writes no instructions",
    rpc: null,
    tool: "bm_assessment",
    run: async () => {
      const answer = await callTool("bm_assessment", { workspaceId: WORKSPACE_ID, ...ASSESSMENT });
      expect(answer.isError).toBe(false);
      expect(createOrchestratorStore(home).readAssessments(WORKSPACE_ID)).toMatchObject([{ status: "done" }]);
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
    it(`${path.name}: no archive, cancel, stop, config write, creation, send or non-bm read${path.instructions === true ? "" : ", no instruction write"}`, async () => {
      await path.run();

      expectBoundary({
        instructions: path.instructions === true,
        creates: path.creates ?? 0,
        ...(path.sendsTo === undefined ? {} : { sendsTo: path.sendsTo }),
        limits: path.limits === true,
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
    await callTool("bm_assessment", { workspaceId: WORKSPACE_ID, ...ASSESSMENT });
    // No Orchestrator, so no owner's word: refused; a decision is only recorded.
    expect((await callTool("bm_send_command", { workspaceId: WORKSPACE_ID, managerId: MANAGER, command: "Continue.", reason: "Nobody runs." })).isError).toBe(true);
    expect((await callTool("bm_set_autopilot", { workspaceId: WORKSPACE_ID, enabled: true })).isError).toBe(true);
    await callTool("bm_ask_owner", { workspaceId: WORKSPACE_ID, question: "Delete the old invoices?", recommendation: "No." });
    expect((await callTool("bm_direct_worker", DIRECT)).isError).toBe(true);
    await callTool("bm_note", { workspaceId: WORKSPACE_ID, text: "Nothing is open yet." });
    await callTool("bm_repo", { workspaceId: WORKSPACE_ID, action: "status" });
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
