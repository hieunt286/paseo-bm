import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeQueue, type NoticeQueue } from "../plugin/server/notice-queue";
import { isPluginNotice } from "../plugin/server/notices";
import { ORCHESTRATOR_INSTRUCTIONS_HASH } from "../plugin/server/orchestrator-agent";
import { createOrchestratorStore } from "../plugin/server/orchestrator-store";
import { createAlertStore } from "../plugin/server/alert-store";
import { createEventBus } from "../plugin/server/event-bus";
import { STALL_PASS_MS, createStallWatcher, type StallWatcher, type StallWatcherDeps } from "../plugin/server/stall-watcher";
import { appendRecord, clearTraceStoreCache, writeWorkspaceMeta } from "../plugin/server/trace-store";
import {
  MAX_WATCHED_WORKERS,
  PERMISSION_WAIT_MS,
  STUCK_MS,
  WORKER_PASS_MS,
  WORKER_TAIL_ENTRIES,
  SIGNAL_ALERT_KINDS,
  dangerOfCommand,
  workerSignalsOf,
  type WatchedEntry,
  type WorkerSignalInput,
} from "../plugin/server/worker-watch";
import type { TraceRecord } from "../plugin/shared/contracts";
import { DANGER_ALLOWANCE_MS, type WorkerSignal } from "../plugin/shared/orchestrator";
import { MAX_ALERT_DETAIL_CHARS, alertKeyOf } from "../plugin/shared/alerts";
import { MANAGER, WORKER, WORKSPACE_DIRECTORY, WORKSPACE_ID, at, msg, report, turn } from "./fixtures/orchestrator-traces";

/**
 * The live watch of running Workers (Orchestrator design §6B.3, ADR-016
 * decision 1; autonomy design §A.8): the six signals on fake live timelines,
 * none on a healthy Worker; each a `worker.signal` event once per Worker turn,
 * batched into one `BM-EVENTS` message to the Orchestrator; `stuck`,
 * `permission` and `danger` also Inbox alerts, raised once and cleared when
 * they end; the interrupt allowance a `danger` opens and its expiry; the
 * bounds (five Workers, 300 entries, the turn start); the 2-minute pass on
 * the stall pass's timer; projects without Autopilot never read. A fake Paseo
 * SDK, a private notice queue and a temporary data folder named by
 * `PASEO_BM_HOME` — never the real HOME or a daemon.
 */

const REQUEST_ID = "req-20260926T100020Z";
const ORCHESTRATOR = "agent-orchestrator";
const OTHER_WORKSPACE = "wks_other";
const USER_TEXT = "Fix the invoice date format.\nKeep the rest.";
/** The Worker's current turn starts at 10:20; the clock reads 10:25 unless a test moves it. */
const TURN_START = at(20);
const when = (minute: number, second = 0) => new Date(at(minute, second));

// ── Live timeline entries, as `timeline.refetch` returns them ───────────────

let callSeq = 0;
const userMessage = (text: string, time: string): WatchedEntry => ({ item: { type: "user_message", text }, timestamp: time });
const assistant = (text: string, time: string): WatchedEntry => ({ item: { type: "assistant_message", text }, timestamp: time });
function shellCall(command: string, time: string, extra: { exitCode?: number | null; output?: string; cwd?: string; callId?: string; status?: string } = {}): WatchedEntry {
  callSeq += 1;
  return {
    item: {
      type: "tool_call",
      callId: extra.callId ?? `call-${callSeq}`,
      name: "Bash",
      status: extra.status ?? "completed",
      error: null,
      detail: {
        type: "shell",
        command,
        ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
        ...(extra.exitCode === undefined ? {} : { exitCode: extra.exitCode }),
        ...(extra.output === undefined ? {} : { output: extra.output }),
      },
    },
    timestamp: time,
  };
}
function fileCall(kind: "edit" | "write", filePath: string, time: string): WatchedEntry {
  callSeq += 1;
  return { item: { type: "tool_call", callId: `call-${callSeq}`, name: kind === "edit" ? "Edit" : "Write", status: "completed", error: null, detail: { type: kind, filePath } }, timestamp: time };
}

/** A healthy turn: started at 10:20, reading, testing (green) and editing inside the workspace, the newest entry a minute old. */
function healthyTurn(): WatchedEntry[] {
  return [
    userMessage(`Request ${REQUEST_ID}: ${USER_TEXT}`, at(20)),
    assistant("I will look at the date formatter.", at(20, 10)),
    shellCall("npm test", at(21), { exitCode: 1, output: "1 failed" }),
    fileCall("edit", `${WORKSPACE_DIRECTORY}/src/date.ts`, at(22)),
    fileCall("write", "src/date.test.ts", at(22, 30)),
    shellCall("npm test", at(23), { exitCode: 0, output: "7 passed" }),
    shellCall("git status --short", at(23, 10), { exitCode: 0 }),
    shellCall("rm -rf dist node_modules/.cache", at(23, 20), { exitCode: 0 }),
    assistant("The date is fixed; reporting.", at(24)),
  ];
}

// ── The signals (pure) ──────────────────────────────────────────────────────

function input(entries: WatchedEntry[], extra: Partial<WorkerSignalInput> = {}): WorkerSignalInput {
  return {
    now: when(25),
    turnStart: TURN_START,
    status: "running",
    entries,
    permission: null,
    workspaceDirectory: WORKSPACE_DIRECTORY,
    tier: "Small",
    ...extra,
  };
}

const signalsOf = (entries: WatchedEntry[], extra: Partial<WorkerSignalInput> = {}): WorkerSignal[] =>
  workerSignalsOf(input(entries, extra)).map((held) => held.signal);

describe("workerSignalsOf (design §6B.3)", () => {
  it("a healthy Worker raises none", () => {
    expect(workerSignalsOf(input(healthyTurn()))).toEqual([]);
  });

  it("stuck: the newest timeline entry is 10 minutes old while the Worker runs", () => {
    const entries = healthyTurn();
    // The newest entry is at 10:24.
    expect(signalsOf(entries, { now: new Date(when(24).getTime() + STUCK_MS - 1000) })).toEqual([]);
    const held = workerSignalsOf(input(entries, { now: new Date(when(24).getTime() + STUCK_MS) }));
    expect(held).toEqual([{ signal: "stuck", since: at(24), evidence: expect.stringContaining("The date is fixed; reporting.") as unknown as string }]);
    // Not running: not stuck.
    expect(signalsOf(entries, { now: when(59), status: "idle" })).toEqual([]);
    // Nothing read: nothing to judge.
    expect(signalsOf([], { now: when(59) })).toEqual([]);
  });

  it("stuck counts from the turn start when every entry read is older", () => {
    const entries = [assistant("An older turn.", at(5))];
    expect(signalsOf(entries, { now: new Date(when(20).getTime() + STUCK_MS - 1000) })).toEqual([]);
    expect(workerSignalsOf(input(entries, { now: new Date(when(20).getTime() + STUCK_MS) }))[0]).toMatchObject({ signal: "stuck", since: TURN_START });
  });

  it("permission: a permission has waited 3 minutes", () => {
    const permission = { since: at(23), text: "Waiting for the owner to allow: Bash — git push" };
    expect(signalsOf(healthyTurn(), { permission, now: new Date(when(23).getTime() + PERMISSION_WAIT_MS - 1000) })).toEqual([]);
    expect(workerSignalsOf(input(healthyTurn(), { permission, now: new Date(when(23).getTime() + PERMISSION_WAIT_MS) }))).toEqual([
      { signal: "permission", since: at(23), evidence: permission.text },
    ]);
  });

  it("danger: a push, publish, deploy, destructive SQL or rm -rf outside the workspace", () => {
    const held = workerSignalsOf(input([...healthyTurn(), shellCall("git push origin main", at(24, 10), { status: "running" })]));
    expect(held).toEqual([{ signal: "danger", since: at(24, 10), evidence: "git push: git push origin main" }]);
  });

  it("danger: each rule of the catalogue, and harmless look-alikes", () => {
    const dangerous = [
      "git push",
      "git -C ../repo push --force",
      "npm publish --access public",
      "pnpm publish",
      "yarn publish",
      "kubectl -n prod apply -f deploy.yaml",
      "kubectl delete pod web-1",
      "terraform apply -auto-approve",
      "terraform destroy",
      "helm upgrade web ./chart",
      "helm install web ./chart",
      "helm uninstall web",
      "vercel deploy --prod",
      "docker push registry/app:1",
      `psql -c "DROP TABLE invoices"`,
      `psql -c "drop database app"`,
      `psql -c "TRUNCATE invoices"`,
      `sqlite3 app.db "DELETE FROM invoices;"`,
      "rm -rf /",
      "rm -rf ~",
      "rm -rf ~/projects",
      "sudo rm -fr $HOME/cache",
      "rm -rf /work/other-app",
      "rm -r -f ../other-app",
      "cd src && rm -rf ../../etc",
    ];
    for (const command of dangerous) expect([command, dangerOfCommand(command, null, WORKSPACE_DIRECTORY)]).toEqual([command, expect.any(String)]);
    const harmless = [
      "git status",
      "git log --oneline -20",
      "npm test",
      "npm run build",
      "kubectl get pods",
      "terraform plan",
      "helm list",
      "vercel deploy",
      "docker build .",
      `sqlite3 app.db "DELETE FROM invoices WHERE id = 3"`,
      "truncate -s 0 app.log",
      "rm -rf dist",
      `rm -rf ${WORKSPACE_DIRECTORY}/build`,
      "rm -f /tmp/scratch.txt",
      "rm -r /tmp/scratch",
      "rm -rf $TMPDIR/scratch",
    ];
    for (const command of harmless) expect([command, dangerOfCommand(command, null, WORKSPACE_DIRECTORY)]).toEqual([command, null]);
    // Where it ran counts for a relative target.
    expect(dangerOfCommand("rm -rf build", "/work/elsewhere", WORKSPACE_DIRECTORY)).toBe("rm -rf build");
    // Without the workspace directory only `/` and `~` are judged.
    expect(dangerOfCommand("rm -rf /work/other-app", null, null)).toBeNull();
    expect(dangerOfCommand("rm -rf /", null, null)).toBe("rm -rf /");
  });

  it("failing: the same command (normalised) ended non-zero 3 times in the turn", () => {
    const twice = [...healthyTurn(), shellCall("npm  run  lint", at(24, 10), { exitCode: 2 }), shellCall("npm run lint ", at(24, 20), { exitCode: 2 })];
    expect(signalsOf(twice)).toEqual([]);
    const thrice = [...twice, shellCall(" npm run lint", at(24, 30), { exitCode: 1, output: "src/date.ts: 3 problems" })];
    expect(workerSignalsOf(input(thrice))).toEqual([
      {
        signal: "failing",
        since: at(24, 10),
        evidence: "npm run lint\nFailed 3 times in this turn (last exit 1).\nLast output (end): src/date.ts: 3 problems",
      },
    ]);
  });

  const opening = () => healthyTurn().slice(0, 2);

  it("failing: Claude's timeline shape — status failed, no exitCode, no output — counts (coordination run 2026-09-29, F1)", () => {
    // The exact entries the run recorded for a Claude Worker: no `exitCode`, no `output`.
    // The turn opens without the healthy turn's own failed `npm test`, so only these count.
    const claudeFailure = (time: string): WatchedEntry => {
      callSeq += 1;
      return { item: { type: "tool_call", callId: `call-${callSeq}`, name: "Bash", status: "failed", detail: { type: "shell", command: "npm test" } }, timestamp: time };
    };
    const twice = [...opening(), claudeFailure(at(24, 10)), claudeFailure(at(24, 20))];
    expect(signalsOf(twice)).toEqual([]);
    expect(workerSignalsOf(input([...twice, claudeFailure(at(24, 30))]))).toEqual([
      { signal: "failing", since: at(24, 10), evidence: "npm test\nFailed 3 times in this turn (the last one marked failed)." },
    ]);
    // "error" is a failure too; a failed status and a non-zero exit code add up for one (normalised) command.
    const mixed = [
      ...opening(),
      shellCall("npm  test", at(24, 10), { status: "error" }),
      shellCall("npm test", at(24, 20), { exitCode: 1 }),
      shellCall(" npm test", at(24, 30), { status: "failed" }),
    ];
    expect(signalsOf(mixed)).toEqual(["failing"]);
    // A completed call with no exit code, or exit 0, is not a failure; neither is one still running.
    const passing = [
      ...opening(),
      shellCall("npm test", at(24, 10), { status: "completed" }),
      shellCall("npm test", at(24, 20), { status: "completed", exitCode: 0 }),
      shellCall("npm test", at(24, 30), { status: "running" }),
    ];
    expect(signalsOf(passing)).toEqual([]);
  });

  it("failing: a call seen running then ending failed (status only) counts once", () => {
    const running = shellCall("npm test", at(24, 10), { callId: "same", status: "running" });
    const ended = shellCall("npm test", at(24, 40), { callId: "same", status: "failed" });
    const other = [shellCall("npm test", at(24, 45), { status: "failed" })];
    expect(signalsOf([...opening(), running, ended, ...other])).toEqual([]);
    expect(signalsOf([...opening(), running, ended, ...other, shellCall("npm test", at(24, 50), { status: "failed" })])).toEqual(["failing"]);
  });

  it("failing: a call seen running then ended counts once; failures before the turn start do not count", () => {
    const running = shellCall("npm test", at(24, 10), { callId: "same", status: "running", exitCode: null });
    const ended = shellCall("npm test", at(24, 40), { callId: "same", exitCode: 1 });
    const before = [shellCall("npm test", at(10), { exitCode: 1 }), shellCall("npm test", at(11), { exitCode: 1 })];
    expect(signalsOf([...before, ...healthyTurn(), running, ended])).toEqual([]);
    const third = shellCall("npm test", at(24, 50), { exitCode: 1 });
    expect(signalsOf([...before, ...healthyTurn(), running, ended, third])).toEqual(["failing"]);
  });

  it("heavy: a Small request runs br create or writes under docs/plans or docs/adr", () => {
    expect(workerSignalsOf(input([...healthyTurn(), shellCall(`br create "Fix the date" --json`, at(24, 10))]))).toEqual([
      { signal: "heavy", since: at(24, 10), evidence: `The request is Small, and the Worker ran: br create "Fix the date" --json` },
    ]);
    expect(signalsOf([...healthyTurn(), fileCall("write", "docs/plans/date-plan.md", at(24, 10))])).toEqual(["heavy"]);
    expect(signalsOf([...healthyTurn(), fileCall("edit", `${WORKSPACE_DIRECTORY}/docs/adr/ADR-001.md`, at(24, 10))])).toEqual(["heavy"]);
    // A Medium request, or one of no known tier, may.
    expect(signalsOf([...healthyTurn(), shellCall("br create x", at(24, 10))], { tier: "Medium" })).toEqual([]);
    expect(signalsOf([...healthyTurn(), shellCall("br create x", at(24, 10))], { tier: null })).toEqual([]);
    // Before the turn start: another turn's.
    expect(signalsOf([shellCall("br create x", at(10)), ...healthyTurn()])).toEqual([]);
  });

  it("outside: an edit or write on an absolute path outside the workspace directory", () => {
    expect(workerSignalsOf(input([...healthyTurn(), fileCall("write", "/Users/owner/.zshrc", at(24, 10))]))).toEqual([
      { signal: "outside", since: at(24, 10), evidence: `write /Users/owner/.zshrc (workspace directory: ${WORKSPACE_DIRECTORY})` },
    ]);
    expect(signalsOf([...healthyTurn(), fileCall("edit", "/work/invoice-app-2/src/a.ts", at(24, 10))])).toEqual(["outside"]);
    // Unknown workspace directory: not judged.
    expect(signalsOf([...healthyTurn(), fileCall("write", "/Users/owner/.zshrc", at(24, 10))], { workspaceDirectory: null })).toEqual([]);
  });

  it("several signals come in the catalogue's order, each once", () => {
    const entries = [
      ...healthyTurn(),
      fileCall("write", "/etc/hosts", at(24, 1)),
      shellCall("br create a", at(24, 2)),
      shellCall("npm publish", at(24, 3)),
      shellCall("npm publish", at(24, 4)),
    ];
    expect(signalsOf(entries)).toEqual(["danger", "heavy", "outside"]);
  });
});

// ── The watcher (fake SDK) ──────────────────────────────────────────────────

interface FakeAgent {
  id: string;
  provider: string;
  status: string;
  workspaceId: string;
  labels: Record<string, string>;
  title?: string;
  createdAt?: string;
  archivedAt?: string | null;
  /** What `refresh()` adds to the snapshot: the turn and the permissions. */
  snapshot?: Record<string, unknown>;
  timeline?: WatchedEntry[];
}

const orchestratorAgent = (): FakeAgent => ({
  id: ORCHESTRATOR,
  provider: "bm-orchestrator/claude-opus-5-5",
  status: "idle",
  workspaceId: "wks-own",
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
  createdAt: at(0),
});

const managerAgent = (workspaceId = WORKSPACE_ID, id = MANAGER): FakeAgent => ({
  id,
  provider: "bm-manager",
  status: "idle",
  workspaceId,
  labels: { "bm.role": "manager" },
  title: "Invoice Manager",
  createdAt: at(0),
});

function workerAgent(extra: Partial<FakeAgent> & { turnStart?: string | null } = {}): FakeAgent {
  const { turnStart = TURN_START, ...rest } = extra;
  return {
    id: WORKER,
    provider: "bm-worker",
    status: "running",
    workspaceId: WORKSPACE_ID,
    labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER, "bm.requestId": REQUEST_ID },
    title: "Date Worker",
    createdAt: at(0, 30),
    snapshot: turnStart === null ? {} : { activeTurn: { turnId: "t-1", startedAt: turnStart }, lastUserMessageAt: turnStart },
    timeline: healthyTurn(),
    ...rest,
  };
}

/**
 * The fake SDK: `agents.list`, `refresh()` (the table's agent and its
 * snapshot fields), `timeline.refetch` (paged from the newest, with
 * `startCursor` and `hasOlder`, as Paseo 0.8 answers), `send` (recorded;
 * starts a turn) and `workspaces.list`.
 */
function fakePaseo(initial: FakeAgent[]) {
  const agents = [...initial];
  const sends: Array<{ id: string; text: string }> = [];
  const refreshes: string[] = [];
  const reads: Array<{ id: string; options: Record<string, unknown>; entries: number }> = [];
  const byId = (id: string) => agents.find((entry) => entry.id === id);
  const paseo = {
    agents: {
      list: vi.fn(async () => ({ entries: agents.map((entry) => ({ agent: { ...entry, snapshot: undefined, timeline: undefined } })) })),
      ref: vi.fn((id: string) => ({
        refresh: async () => {
          refreshes.push(id);
          const found = byId(id);
          return { agent: found === undefined ? null : { id, status: found.status, archivedAt: found.archivedAt ?? null, cwd: WORKSPACE_DIRECTORY, ...found.snapshot } };
        },
        send: async (text: string) => {
          sends.push({ id, text });
          const found = byId(id);
          if (found !== undefined) found.status = "running";
        },
        timeline: {
          refetch: async (options: { direction?: string; cursor?: number; limit?: number }) => {
            const all = byId(id)?.timeline ?? [];
            const limit = options.limit ?? 200;
            const end = options.direction === "before" ? (options.cursor ?? all.length) : all.length;
            const start = Math.max(0, end - limit);
            const entries = all.slice(start, end);
            reads.push({ id, options, entries: entries.length });
            return { entries, hasOlder: start > 0, startCursor: start };
          },
        },
      })),
    },
    workspaces: {
      list: vi.fn(async () => ({
        entries: [
          { id: WORKSPACE_ID, name: "invoice-app", directory: WORKSPACE_DIRECTORY },
          { id: OTHER_WORKSPACE, name: "other-app", directory: "/work/other-app" },
        ],
      })),
    },
  };
  return { paseo, agents, sends, refreshes, reads, byId };
}

/** The request, sized Small, handed to the Worker. */
function smallRequest(): TraceRecord[] {
  return [
    turn({
      at: at(0, 40),
      turnId: "m-1",
      requestId: REQUEST_ID,
      startedAt: at(0, 20),
      endedAt: at(0, 40),
      sent: [msg(MANAGER, at(0, 20), USER_TEXT, "user")],
      received: [msg(MANAGER, at(0, 35), "I handed this to the Beads Worker.")],
    }),
    turn({
      at: at(1, 20),
      turnId: "m-2",
      requestId: REQUEST_ID,
      startedAt: at(1, 10),
      endedAt: at(1, 20),
      sent: [msg(MANAGER, at(1, 10), `BM-REPORT\nrequestId: ${REQUEST_ID}\nphase: received\ntier: Small`, "agent")],
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
      sent: [msg(WORKER, at(0, 45), `Request ${REQUEST_ID}: ${USER_TEXT}`, "agent")],
    }),
  ];
}

let root: string;
let home: string;
let queue: NoticeQueue;
let clock: Date;
let deps: StallWatcherDeps;
let watchers: StallWatcher[];

const location = () => ({ tracesDir: join(home, "traces") });
const store = () => createOrchestratorStore(home, { now: () => clock });
const alerts = () => createAlertStore(home, { now: () => clock });
const autopilotOn = (workspaceId = WORKSPACE_ID) => store().setAutopilot(workspaceId, true, "tab");
const alertOf = (signal: WorkerSignal, workerId = WORKER) => alertKeyOf(SIGNAL_ALERT_KINDS[signal]!, WORKSPACE_ID, workerId);
/** The event lines of every BM-EVENTS message sent. */
const eventLines = (sends: Array<{ text: string }>) => sends.flatMap((sent) => sent.text.split("\n").filter((line) => line.startsWith("- ")));

async function seed(records: TraceRecord[] = smallRequest()): Promise<void> {
  for (const record of records) await appendRecord(location(), record);
  writeWorkspaceMeta(location(), WORKSPACE_ID, { lastKnownName: "invoice-app", lastKnownDirectory: WORKSPACE_DIRECTORY, lastSeenAt: records.at(-1)!.endedAt });
  clearTraceStoreCache();
}

/** A watcher whose bus delivers through the test's private queue. */
function watcher(extra: StallWatcherDeps = {}): StallWatcher {
  const merged = { ...deps, ...extra };
  const created = createStallWatcher({ ...merged, bus: createEventBus({ ...merged, queue }) });
  watchers.push(created);
  return created;
}

function watching(agents: FakeAgent[]) {
  const fake = fakePaseo(agents);
  const watch = watcher();
  watch.usePaseo(fake.paseo);
  return { fake, watch };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-worker-watch-"));
  home = join(root, "data");
  queue = createNoticeQueue({ log: () => {} });
  clock = when(25);
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, now: () => clock, log: () => {}, redactEnv: {} };
  watchers = [];
  callSeq = 0;
  clearTraceStoreCache();
});

afterEach(() => {
  for (const entry of watchers) entry.stop();
  queue.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearTraceStoreCache();
  rmSync(root, { recursive: true, force: true });
});

describe("the Worker pass: each signal is one worker.signal event per Worker turn (design §6B.3, §A.8)", () => {
  it("a healthy Worker is read and raises nothing; nothing is sent", async () => {
    await seed();
    autopilotOn();
    const { fake, watch } = watching([managerAgent(), workerAgent(), orchestratorAgent()]);

    expect(await watch.workerPass()).toMatchObject({ status: "done", watched: [WORKER], raised: [], events: [] });
    expect(fake.reads.map((read) => read.id)).toEqual([WORKER]);
    expect(fake.sends).toEqual([]);
    expect(alerts().list()).toEqual([]);
  });

  const cases: Array<{ signal: WorkerSignal; worker: () => FakeAgent; clockAt?: Date; detail?: string }> = [
    { signal: "stuck", worker: () => workerAgent(), clockAt: new Date(when(24).getTime() + STUCK_MS), detail: "No new timeline entry since" },
    {
      signal: "permission",
      worker: () =>
        workerAgent({
          snapshot: {
            activeTurn: { turnId: "t-1", startedAt: TURN_START },
            pendingPermissions: [{ id: "perm-1", name: "Bash", title: "Run a command", detail: { type: "shell", command: "curl https://example.com" } }],
            attentionReason: "permission",
            attentionTimestamp: at(21),
          },
        }),
      detail: "Waiting for the owner to allow: Run a command — curl https://example.com",
    },
    { signal: "danger", worker: () => workerAgent({ timeline: [...healthyTurn(), shellCall("npm publish", at(24, 10))] }), detail: "npm publish: npm publish" },
    {
      signal: "failing",
      worker: () =>
        workerAgent({
          timeline: [...healthyTurn(), ...[1, 2, 3].map((n) => shellCall("npm run lint", at(24, n * 10), { exitCode: 1 }))],
        }),
    },
    { signal: "heavy", worker: () => workerAgent({ timeline: [...healthyTurn(), shellCall("br create x", at(24, 10))] }) },
    { signal: "outside", worker: () => workerAgent({ timeline: [...healthyTurn(), fileCall("write", "/etc/hosts", at(24, 10))] }) },
  ];

  for (const { signal, worker, clockAt, detail } of cases) {
    const alertKind = SIGNAL_ALERT_KINDS[signal];
    it(`${signal}: one event to the Orchestrator in a BM-EVENTS message${alertKind === undefined ? "" : `, and a ${alertKind} alert`}`, async () => {
      await seed();
      autopilotOn();
      if (clockAt !== undefined) clock = clockAt;
      const { fake, watch } = watching([managerAgent(), worker(), orchestratorAgent()]);

      const first = await watch.workerPass();
      expect(first.events).toEqual([expect.objectContaining({ type: "worker.signal", workspaceId: WORKSPACE_ID, workerId: WORKER, requestKey: REQUEST_ID, signal, turnStart: TURN_START })]);
      expect(fake.sends).toHaveLength(1);
      const sent = fake.sends[0]!;
      expect(sent.id).toBe(ORCHESTRATOR);
      expect(isPluginNotice(sent.text)).toBe(true);
      expect(sent.text.split("\n")[0]).toBe("BM-EVENTS");
      expect(eventLines(fake.sends)).toEqual([expect.stringMatching(new RegExp(`^- worker\\.signal ${signal} — project ${WORKSPACE_ID}, Worker ${WORKER}, request ${REQUEST_ID}, since \\S+\\. Look with bm_agent_messages\\.`))]);
      if (alertKind === undefined) {
        expect(first.raised).toEqual([]);
        expect(alerts().list()).toEqual([]);
      } else {
        expect(first.raised).toEqual([alertOf(signal)]);
        expect(alerts().list({ open: true })).toEqual([expect.objectContaining({ kind: alertKind, workspaceId: WORKSPACE_ID, subject: WORKER, detail: expect.stringContaining(detail!) })]);
      }

      // Once per turn: the next passes of the same turn tell nobody again.
      fake.byId(ORCHESTRATOR)!.status = "idle";
      expect(await watch.workerPass()).toMatchObject({ raised: [] });
      clock = new Date(clock.getTime() + WORKER_PASS_MS);
      await watch.workerPass();
      expect(fake.sends).toHaveLength(1);
    });
  }

  it("the alert's detail is redacted and capped", async () => {
    await seed();
    autopilotOn();
    const long = `npm publish --token sk-flag-secret --otp=${"9".repeat(6)} # daemon password pw-env-secret ${"x".repeat(2_000)}`;
    const fake = fakePaseo([managerAgent(), workerAgent({ timeline: [...healthyTurn(), shellCall(long, at(24, 10))] }), orchestratorAgent()]);
    const watch = watcher({ redactEnv: { PASEO_PASSWORD: "pw-env-secret" } });
    watch.usePaseo(fake.paseo);
    await watch.workerPass();
    const detail = alerts().get(alertOf("danger"))!.detail!;
    expect(detail.startsWith("npm publish: npm publish --token [redacted]")).toBe(true);
    expect([...detail]).toHaveLength(MAX_ALERT_DETAIL_CHARS);
    expect(detail).not.toContain("sk-flag-secret");
    expect(detail).not.toContain("pw-env-secret");
    // The event line carries ids only, never the evidence.
    expect(fake.sends[0]!.text).not.toContain("npm publish --token");
  });

  it("a new turn tells the Orchestrator again; the Worker's recorded turn end clears its alerts", async () => {
    await seed();
    autopilotOn();
    const worker = workerAgent({ timeline: [...healthyTurn(), shellCall("br create x", at(24, 10)), shellCall("git push", at(24, 20))] });
    const { fake, watch } = watching([managerAgent(), worker, orchestratorAgent()]);

    expect(await watch.workerPass()).toMatchObject({ raised: [alertOf("danger")] });
    expect(eventLines(fake.sends).map((line) => line.split(" — ")[0])).toEqual(["- worker.signal danger", "- worker.signal heavy"]);
    // Not a Worker, or no id: nothing cleared.
    expect(watch.workerTurnEnded({ id: MANAGER, provider: "bm-manager" })).toEqual([]);
    expect(watch.workerTurnEnded(undefined)).toEqual([]);
    expect(watch.workerTurnEnded({ id: WORKER, provider: "bm-worker/claude-opus-5-5" })).toEqual([alertOf("danger")]);
    expect(alerts().list({ open: true })).toEqual([]);

    // The next turn starts at 10:30 and runs br create again.
    const next = at(30);
    worker.snapshot = { activeTurn: { turnId: "t-2", startedAt: next } };
    worker.timeline = [...healthyTurn(), userMessage("Go on.", next), shellCall("br create y", at(31))];
    clock = when(32);
    fake.byId(ORCHESTRATOR)!.status = "idle";
    expect(await watch.workerPass()).toMatchObject({ raised: [], events: [expect.objectContaining({ signal: "heavy", turnStart: next })] });
    expect(fake.sends).toHaveLength(2);
    expect(eventLines([fake.sends[1]!])).toEqual([expect.stringMatching(/^- worker\.signal heavy/)]);
  });

  it("an event whose Worker turn ended before the Orchestrator was idle is dropped", async () => {
    await seed();
    autopilotOn();
    const orchestrator = { ...orchestratorAgent(), status: "running" };
    const { fake, watch } = watching([managerAgent(), workerAgent({ timeline: [...healthyTurn(), shellCall("br create x", at(24, 10))] }), orchestrator]);
    await watch.workerPass();
    expect(queue.pending(ORCHESTRATOR)).toHaveLength(1);
    watch.workerTurnEnded({ id: WORKER, provider: "bm-worker" });
    fake.byId(ORCHESTRATOR)!.status = "idle";
    await queue.turnEnded({ agent: { id: ORCHESTRATOR } }, fake.paseo);
    expect(fake.sends).toEqual([]);
  });

  it("stuck clears when the Worker moves again, permission when it is answered, all when the Worker stops", async () => {
    await seed();
    autopilotOn();
    const worker = workerAgent({
      snapshot: {
        activeTurn: { turnId: "t-1", startedAt: TURN_START },
        pendingPermissions: [{ id: "perm-1", name: "Bash", title: "Run a command" }],
        attentionReason: "permission",
        attentionTimestamp: at(21),
      },
      timeline: [userMessage("Go.", TURN_START), shellCall("git push", at(21, 10))],
    });
    clock = new Date(when(21, 10).getTime() + STUCK_MS);
    const { watch } = watching([managerAgent(), worker, orchestratorAgent()]);
    expect((await watch.workerPass()).raised.sort()).toEqual([alertOf("danger"), alertOf("permission"), alertOf("stuck")].sort());

    // Answered, and the Worker moves again: those two are cleared; danger holds until the turn ends.
    worker.snapshot = { activeTurn: { turnId: "t-1", startedAt: TURN_START } };
    worker.timeline = [...worker.timeline!, assistant("Pushed.", new Date(clock.getTime() - 1_000).toISOString())];
    expect((await watch.workerPass()).cleared.sort()).toEqual([alertOf("permission"), alertOf("stuck")].sort());
    expect(alerts().list({ open: true }).map((alert) => alert.kind)).toEqual(["danger"]);

    worker.status = "idle";
    expect(await watch.workerPass()).toMatchObject({ watched: [], cleared: [alertOf("danger")] });
  });

  it("without an Orchestrator the alert is kept, and nothing is sent", async () => {
    await seed();
    autopilotOn();
    const { fake, watch } = watching([managerAgent(), workerAgent({ timeline: [...healthyTurn(), shellCall("git push", at(24, 10))] })]);
    expect(await watch.workerPass()).toMatchObject({ raised: [alertOf("danger")] });
    expect(fake.sends).toEqual([]);
  });

  it("a permission the snapshot gives no time for counts from when the watch first saw it", async () => {
    await seed();
    autopilotOn();
    const worker = workerAgent({
      snapshot: { activeTurn: { turnId: "t-1", startedAt: TURN_START }, pendingPermissions: [{ id: "perm-1", name: "Bash" }] },
      timeline: [userMessage("Go.", TURN_START), shellCall("curl https://example.com", at(24, 50), { status: "running" })],
    });
    const { watch } = watching([managerAgent(), worker, orchestratorAgent()]);
    expect(await watch.workerPass()).toMatchObject({ raised: [] });
    clock = new Date(when(25).getTime() + PERMISSION_WAIT_MS - 1000);
    expect(await watch.workerPass()).toMatchObject({ raised: [] });
    clock = new Date(when(25).getTime() + PERMISSION_WAIT_MS);
    expect(await watch.workerPass()).toMatchObject({ raised: [alertOf("permission")] });
  });
});

describe("danger opens the interrupt allowance for 10 minutes (design §6B.3)", () => {
  it("opens on danger, never on another signal, says so in the event, and expires", async () => {
    await seed();
    autopilotOn();
    const worker = workerAgent({ timeline: [...healthyTurn(), shellCall("br create x", at(24, 5))] });
    const { fake, watch } = watching([managerAgent(), worker, orchestratorAgent()]);

    expect(await watch.workerPass()).toMatchObject({ raised: [], allowances: [] });
    expect(store().isDangerOpen(WORKSPACE_ID, WORKER)).toBe(false);

    worker.timeline = [...worker.timeline!, shellCall("git push origin main", at(25, 10))];
    clock = when(26);
    fake.byId(ORCHESTRATOR)!.status = "idle";
    expect(await watch.workerPass()).toMatchObject({ raised: [alertOf("danger")], allowances: [WORKER] });
    expect(store().isDangerOpen(WORKSPACE_ID, WORKER)).toBe(true);
    const until = new Date(when(26).getTime() + DANGER_ALLOWANCE_MS).toISOString();
    expect(store().listDangerAllowances({ open: true })).toEqual([expect.objectContaining({ workerId: WORKER, until })]);
    expect(fake.sends.at(-1)!.text).toContain(`You may interrupt this Worker until ${until} (bm_direct_worker with interrupt: true).`);

    // Once while the alert is open: the next pass opens nothing more.
    expect(await watch.workerPass()).toMatchObject({ raised: [], allowances: [] });
    clock = new Date(when(26).getTime() + DANGER_ALLOWANCE_MS - 1000);
    expect(store().isDangerOpen(WORKSPACE_ID, WORKER)).toBe(true);
    clock = new Date(when(26).getTime() + DANGER_ALLOWANCE_MS);
    expect(store().isDangerOpen(WORKSPACE_ID, WORKER)).toBe(false);
  });
});

describe("bounds: Autopilot projects only, five Workers, 300 entries since the turn start (design §6B.3)", () => {
  it("no Autopilot project: the pass is off, lists, refreshes and reads nothing, and clears the Worker alerts left", async () => {
    await seed();
    alerts().raise({ workspaceId: WORKSPACE_ID, kind: "danger", subject: WORKER });
    const { fake, watch } = watching([managerAgent(), workerAgent({ timeline: [...healthyTurn(), shellCall("git push", at(24))] }), orchestratorAgent()]);
    expect(await watch.workerPass()).toMatchObject({ status: "off", raised: [], cleared: [alertOf("danger")] });
    expect(fake.paseo.agents.list).not.toHaveBeenCalled();
    expect(fake.refreshes).toEqual([]);
    expect(fake.reads).toEqual([]);
  });

  it("a Worker of a project without Autopilot is never refreshed or read, and raises nothing", async () => {
    await seed();
    autopilotOn();
    const other = workerAgent({
      id: "agent-worker-other",
      workspaceId: OTHER_WORKSPACE,
      labels: { "bm.role": "worker", "paseo.parent-agent-id": "agent-manager-other" },
      timeline: [...healthyTurn(), shellCall("git push", at(24))],
    });
    const { fake, watch } = watching([managerAgent(), managerAgent(OTHER_WORKSPACE, "agent-manager-other"), other, workerAgent(), orchestratorAgent()]);
    expect(await watch.workerPass()).toMatchObject({ watched: [WORKER], raised: [] });
    expect(fake.refreshes).not.toContain(other.id);
    expect(fake.reads.map((read) => read.id)).not.toContain(other.id);
    expect(fake.sends).toEqual([]);
  });

  it("a Worker that is not running, or whose snapshot gives no turn start, is not read", async () => {
    await seed();
    autopilotOn();
    const idle = workerAgent({ id: "agent-worker-idle", status: "idle", timeline: [shellCall("git push", at(24))] });
    const unknownTurn = workerAgent({ id: "agent-worker-unknown", turnStart: null, timeline: [shellCall("git push", at(24))] });
    const { fake, watch } = watching([managerAgent(), idle, unknownTurn, orchestratorAgent()]);
    expect(await watch.workerPass()).toMatchObject({ watched: [], raised: [] });
    expect(fake.refreshes).not.toContain(idle.id);
    expect(fake.reads).toEqual([]);
  });

  it(`at most ${MAX_WATCHED_WORKERS} running Workers: the oldest are dropped`, async () => {
    await seed();
    autopilotOn();
    const workers = Array.from({ length: 7 }, (_, index) =>
      workerAgent({ id: `agent-worker-${index}`, createdAt: at(index), labels: { "bm.role": "worker", "paseo.parent-agent-id": MANAGER } }),
    );
    const { fake, watch } = watching([managerAgent(), ...workers, orchestratorAgent()]);
    const result = await watch.workerPass();
    expect(result.watched.sort()).toEqual(["agent-worker-2", "agent-worker-3", "agent-worker-4", "agent-worker-5", "agent-worker-6"]);
    expect(new Set(fake.reads.map((read) => read.id))).toEqual(new Set(result.watched));
  });

  it(`reads at most ${WORKER_TAIL_ENTRIES} entries, newest first, and no page older than the turn start`, async () => {
    await seed();
    autopilotOn();
    // A long turn: 1,000 entries since 10:20, one every half second.
    const longTurn = Array.from({ length: 1_000 }, (_, index) => assistant(`step ${index}`, new Date(when(20).getTime() + index * 500).toISOString()));
    const long = workerAgent({ id: "agent-worker-long", createdAt: at(1), timeline: longTurn });
    // A short turn after a long history: the first page reaches back before the turn start.
    const history = Array.from({ length: 400 }, (_, index) => assistant(`old ${index}`, new Date(when(5).getTime() + index * 1000).toISOString()));
    const short = workerAgent({ id: "agent-worker-short", createdAt: at(2), timeline: [...history, ...healthyTurn()] });
    const { fake, watch } = watching([managerAgent(), long, short, orchestratorAgent()]);
    clock = new Date(when(20).getTime() + 1_000 * 500 + 60_000);

    await watch.workerPass();
    const readOf = (id: string) => fake.reads.filter((read) => read.id === id);
    expect(readOf(long.id).reduce((sum, read) => sum + read.entries, 0)).toBe(WORKER_TAIL_ENTRIES);
    expect(readOf(long.id).map((read) => read.options.direction)).toEqual(["tail", "before"]);
    expect(readOf(short.id)).toHaveLength(1);
    for (const read of fake.reads) expect(read.options.limit).toBeLessThanOrEqual(WORKER_TAIL_ENTRIES);
  });
});

describe("the 2-minute Worker pass rides on the stall pass's timer", () => {
  it("one timer; the Worker pass every second tick, none after the timer stops", async () => {
    await seed();
    autopilotOn();
    const fake = fakePaseo([managerAgent(), workerAgent(), orchestratorAgent()]);
    vi.useFakeTimers({ now: when(25) });
    const watch = watcher({ now: undefined });
    watch.usePaseo(fake.paseo);

    watch.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(STALL_PASS_MS);
    expect(fake.reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(STALL_PASS_MS);
    expect(WORKER_PASS_MS).toBe(2 * STALL_PASS_MS);
    expect(fake.reads.map((read) => read.id)).toEqual([WORKER]);
    await vi.advanceTimersByTimeAsync(STALL_PASS_MS);
    expect(fake.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STALL_PASS_MS);
    expect(fake.reads).toHaveLength(2);

    watch.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * WORKER_PASS_MS);
    expect(fake.reads).toHaveLength(2);
  });

  it("without Autopilot the timer runs for stalls, and no Worker is ever refreshed or read", async () => {
    await seed();
    const fake = fakePaseo([managerAgent(), workerAgent({ timeline: [...healthyTurn(), shellCall("git push", at(24))] }), orchestratorAgent()]);
    vi.useFakeTimers({ now: when(25) });
    const watch = watcher({ now: undefined });
    watch.usePaseo(fake.paseo);
    watch.start();
    await vi.advanceTimersByTimeAsync(10 * WORKER_PASS_MS);
    expect(fake.refreshes.filter((id) => id === WORKER)).toEqual([]);
    expect(fake.reads).toEqual([]);
    expect(alerts().list({ kinds: ["danger", "stuck", "permission-waiting"] })).toEqual([]);
  });

  it("a pass under way when the timer stops writes and sends nothing more; two passes never overlap", async () => {
    await seed();
    autopilotOn();
    const fake = fakePaseo([managerAgent(), workerAgent({ timeline: [...healthyTurn(), shellCall("git push", at(24))] }), orchestratorAgent()]);
    const watch = watcher();
    watch.usePaseo(fake.paseo);
    watch.start();
    const list = fake.paseo.agents.list.getMockImplementation()!;
    let second: Promise<unknown> | undefined;
    fake.paseo.agents.list.mockImplementationOnce(async () => {
      second = watch.workerPass();
      watch.stop();
      return list();
    });
    expect(await watch.workerPass()).toMatchObject({ status: "off" });
    await expect(second).resolves.toMatchObject({ status: "busy" });
    expect(fake.sends).toEqual([]);
    expect(alerts().list()).toEqual([]);
    expect(store().listDangerAllowances()).toEqual([]);
  });
});
